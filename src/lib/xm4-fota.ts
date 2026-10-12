/**
 * Direct WH-1000XM4 voice-pack install over Bluetooth Classic, ported from the
 * single-device Airoha flow in Sony's app 13.2.2 (s6.c.M0 query, s6.b.r0
 * transfer, s6.b.t0 commit). See NOTES.md §18 and reverse-engineering/.
 *
 * Deliberate differences from Sony, all in the safe direction:
 * - Refuses paired (TWS) update methods and any partition other than the XM4's.
 * - Skips the erase-status and compare optimizations (w6.h, w6.i): it always
 *   erases and programs the whole file, which is Sony's path when the flash
 *   holds anything else.
 * - Never commits an image it did not just transfer (Sony commits a leftover
 *   0x0211 state straight away).
 * - Aborts on any failed erase/program/integrity status instead of retrying,
 *   and requires at least MIN_BATTERY_PERCENT on top of the headset's own threshold.
 */
import { IMAGE_SIZE, isVoicePack, loadPack, serializeImage } from "./voicepack";
import {
  BluetoothClosedError,
  BluetoothTimeoutError,
  MDR_DATA_TABLE1,
  Xm4Transport,
  type MdrFrame,
  type RaceFrame,
} from "./xm4-transport";

export interface RaceLink {
  send(command: number, payload?: Uint8Array, type?: number): Promise<void>;
  receive(timeoutMs?: number): Promise<RaceFrame>;
}

export interface MdrLink {
  send(payload: Uint8Array, type?: number): Promise<void>;
  receive(timeoutMs?: number): Promise<MdrFrame>;
}

const MDR = {
  getVoiceStatus: Uint8Array.of(0x42, 0x01, 0x02),
  voiceStatus: Uint8Array.of(0x43, 0x01, 0x02),
  setUpdateMode: (enabled: boolean) => Uint8Array.of(0x44, 0x01, 0x02, enabled ? 0x00 : 0x01),
  updateModeNotify: Uint8Array.of(0x45, 0x01, 0x02),
  // ye0.b VOICE_GUIDANCE_GET_PARAM(VOICE_GUIDANCE_SETTING, UPDATE_METHOD) -> ye0.q RET_PARAM.
  getUpdateMethod: Uint8Array.of(0x46, 0x01, 0x05),
  updateMethod: Uint8Array.of(0x47, 0x01, 0x05),
  // qe0.f COMMON_GET_BATTERY_LEVEL(BATTERY) on table 1 -> qe0.t1 / NTFY 0x13: [cmd, 0, level, charging].
  getBattery: Uint8Array.of(0x10, 0x00),
} as const;

export const RACE_TYPE = { command: 0x5a, response: 0x5b, indication: 0x5d } as const;

export const RACE_ID = {
  queryPartition: 0x1c00, // w6.a InquiryFota
  integrity: 0x1c01, // w6.d CheckIntegrity
  commit: 0x1c02, // w6.e Commit
  cancel: 0x1c03, // v6.b Cancel, also device-initiated
  queryState: 0x1c04, // w6.b QueryState
  writeState: 0x1c06, // w6.j WriteState
  start: 0x1c08, // v6.a FotaStage_00_Start
  startTransaction: 0x1c0a, // w6.c
  activeFota: 0x1c19, // stage.b TwsActiveFota, foreground runs only
  queryInterval: 0x1c1c, // stage.c TwsQueryTransmitInterval
  program: 0x0402, // w6.g / q6.d
  erase: 0x0404, // w6.f
} as const;

/** FOTA states written by s6.b.r0() (w6.j). 0x0211 = image transferred and integrity-checked. */
export const FOTA_STATE = { erasing: 0x0200, erased: 0x0201, programming: 0x0210, transferred: 0x0211 } as const;

const EXPECTED_PARTITION = { id: 0, storage: 1, address: 0x00510000, length: 0x005ff000 } as const;
const CHUNK = 4096;
const PAGE = 256;
const RESPONSE_TIMEOUT_MS = 9000; // stage.a f21466r
const MAX_RETRIES = 3; // o6.a.j()
const FOREGROUND_WINDOW = 4; // u6.b prePollSize
const BACKGROUND_WINDOW = 3; // s6.c.T0() j0(3)
const COMMIT_WAIT_MS = 45000;
const BATTERY_CHECK_MS = 30000;
export const MIN_BATTERY_PERCENT = 50;

export type Progress = (message: string) => void;

/** The commit outcome could not be confirmed before the restart deadline. */
export class CommitUnconfirmedError extends Error {}

export interface VoicePackCheck {
  bytes: number;
  slots: number;
  imageBytes: number;
  sha256: string;
}

export interface UpdateMethod {
  code: number;
  mtk: boolean;
  tws: boolean;
  resumable: boolean;
  background: boolean;
  /** Minimum battery to start (ye0.q.f()). */
  startBattery: number;
  /** Battery level that interrupts a transfer (ye0.q.g()). */
  interruptBattery: number;
}

export interface Partition { id: number; storage: number; address: number; length: number }

export interface Xm4PreflightResult {
  pack: VoicePackCheck;
  method: UpdateMethod;
  battery: number;
  partition: Partition;
  fotaState: number;
  transmitIntervalMs?: number;
}

export interface InstallOptions {
  progress?: Progress;
  /** Overall transfer fraction 0..1 (erase + program). */
  onFraction?: (fraction: number) => void;
}

function hex(bytes: Uint8Array): string { return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(""); }
function u32le(n: number): Uint8Array { return Uint8Array.of(n, n >>> 8, n >>> 16, n >>> 24); }
function le32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}
const samePrefix = (payload: Uint8Array, prefix: Uint8Array) =>
  payload.length >= prefix.length && prefix.every((byte, i) => payload[i] === byte);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** e7.a: CRC-8 poly 0x31 (MSB-first, init 0), then the result byte is bit-reversed. */
export function crc8Airoha(page: Uint8Array): number {
  let crc = 0;
  for (const byte of page) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 0x80) ? ((crc << 1) ^ 0x31) & 0xff : (crc << 1) & 0xff;
  }
  let reversed = 0;
  for (let bit = 0; bit < 8; bit++) if (crc & (1 << bit)) reversed |= 0x80 >>> bit;
  return reversed;
}

export interface FotaWritePlan {
  /** 4 KiB chunk addresses, one RACE erase each (w6.f). */
  eraseAddresses: number[];
  /** 256-byte pages that are not all 0xff, one RACE program each (w6.g / q6.d). */
  pages: { address: number; payload: Uint8Array }[];
}

/**
 * The file is laid out from the partition start in 4 KiB chunks (w6.h.i()); the
 * last page is padded with 0xff and all-0xff pages are skipped (e7.b.a()).
 */
export function planFotaWrites(file: Uint8Array, partition: Partition): FotaWritePlan {
  assertExpectedPartition(partition);
  if (file.length === 0 || file.length > partition.length) throw new Error("Voice pack does not fit the XM4 FOTA partition.");
  const eraseAddresses: number[] = [];
  const pages: FotaWritePlan["pages"] = [];
  for (let offset = 0; offset < file.length; offset += CHUNK) eraseAddresses.push(partition.address + offset);
  for (let offset = 0; offset < file.length; offset += PAGE) {
    const page = new Uint8Array(PAGE).fill(0xff);
    page.set(file.subarray(offset, offset + PAGE));
    if (page.every((byte) => byte === 0xff)) continue;
    const address = partition.address + offset;
    // q6.d: storage, record count, then per record CRC8 + address + 256-byte page.
    const payload = new Uint8Array(3 + 4 + PAGE);
    payload.set([partition.storage, 1, crc8Airoha(page)]);
    payload.set(u32le(address), 3);
    payload.set(page, 7);
    pages.push({ address, payload });
  }
  return { eraseAddresses, pages };
}

function assertExpectedPartition(partition: Partition): void {
  if (partition.id !== EXPECTED_PARTITION.id || partition.storage !== EXPECTED_PARTITION.storage ||
      partition.address !== EXPECTED_PARTITION.address || partition.length !== EXPECTED_PARTITION.length) {
    throw new Error(`Unexpected FOTA partition ${JSON.stringify(partition)}; refusing to continue.`);
  }
}

/** Verify Sony's outer digest and make sure the decrypted 54-slot image parses. */
export async function inspectVoicePack(raw: Uint8Array): Promise<VoicePackCheck> {
  if (!isVoicePack(raw)) throw new Error("File is not a recognized WH-1000XM4 Sony voice pack.");
  // The headset's integrity check compares SHA-256(file[0x100:]) with file[0:32].
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw.slice(0x100)));
  if (!digest.every((b, i) => b === raw[i])) throw new Error("Voice-pack SHA-256 signature does not match the file.");
  const image = loadPack(raw);
  if (image.slots.length !== 54) throw new Error(`Expected 54 voice slots; decoded ${image.slots.length}.`);
  const decodedSize = serializeImage(image, image.slots).length;
  if (decodedSize !== IMAGE_SIZE) throw new Error(`Expected a 1 MiB voice image; decoded ${decodedSize} bytes.`);
  return { bytes: raw.length, slots: image.slots.length, imageBytes: decodedSize, sha256: hex(digest) };
}

/** Parse ye0.q (MTK) RET_PARAM: 47 01 05 method startThreshold interruptThreshold idLen id… */
export function parseUpdateMethod(payload: Uint8Array): UpdateMethod {
  if (!samePrefix(payload, MDR.updateMethod) || payload.length < 6) throw new Error("Malformed update-method response.");
  const code = payload[3];
  return {
    code,
    mtk: (code & 0xf0) === 0x20,
    resumable: (code & 1) !== 0,
    tws: (code & 2) !== 0,
    background: (code & 4) !== 0,
    startBattery: payload[4],
    interruptBattery: payload[5],
  };
}

interface Command {
  command: number;
  payload: Uint8Array;
  /** Response type the stage waits for (stage.a f21459k). */
  respType: number;
  /** For multi-command stages: does this successful response acknowledge the command? */
  acks?: (frame: RaceFrame) => boolean;
}

interface StageOptions {
  /** stage.c: a response timeout skips the stage instead of retrying. */
  skipOnTimeout?: boolean;
  onAck?: (done: number, total: number) => Promise<void> | void;
}

/**
 * One stage of the Airoha queue: sliding window of `window` commands, 9 s
 * response timeout, up to 3 resends of unacknowledged commands (stage.a/s6.b).
 */
class RaceSession {
  constructor(
    private race: RaceLink,
    private progress: Progress,
    readonly window: number,
    public delayMs: number,
  ) {}

  async single(name: string, command: Command, options: StageOptions = {}): Promise<RaceFrame | undefined> {
    const frames = await this.stage(name, [command], options);
    return frames[0];
  }

  async stage(name: string, commands: Command[], options: StageOptions = {}): Promise<RaceFrame[]> {
    const acked: (RaceFrame | undefined)[] = new Array(commands.length);
    const attempts = new Array(commands.length).fill(0);
    const outstanding = new Set<number>();
    let next = 0;
    let done = 0;
    let deadline = 0;

    const send = async (index: number) => {
      if (this.delayMs > 0) await sleep(this.delayMs);
      const { command, payload } = commands[index];
      await this.race.send(command, payload);
      outstanding.add(index);
      deadline = Date.now() + RESPONSE_TIMEOUT_MS;
    };

    while (done < commands.length) {
      while (outstanding.size < this.window && next < commands.length) await send(next++);
      let frame: RaceFrame;
      try {
        frame = await this.race.receive(Math.max(1, deadline - Date.now()));
      } catch (error) {
        if (!(error instanceof BluetoothTimeoutError)) throw error;
        if (options.skipOnTimeout) {
          this.progress(`${name}: no response, skipping it as Sony does.`);
          return [];
        }
        for (const index of outstanding) {
          if (++attempts[index] > MAX_RETRIES) throw new Error(`${name}: no response after ${MAX_RETRIES} retries.`);
        }
        this.progress(`${name}: response timeout, resending ${outstanding.size} command(s).`);
        const retry = [...outstanding];
        outstanding.clear();
        for (const index of retry) await send(index);
        continue;
      }

      await this.handleDeviceCancel(frame);
      const index = [...outstanding].find((i) => commands[i].command === frame.command &&
        commands[i].respType === frame.type && (frame.payload[0] !== 0 || !commands[i].acks || commands[i].acks!(frame)));
      if (index === undefined) continue; // duplicate, the other response type, or unrelated traffic
      if (frame.payload[0] !== 0) {
        throw new Error(`${name} failed: headphones returned status 0x${frame.payload[0].toString(16)}.`);
      }
      outstanding.delete(index);
      acked[index] = frame;
      done++;
      deadline = Date.now() + RESPONSE_TIMEOUT_MS;
      await options.onAck?.(done, commands.length);
    }
    return acked as RaceFrame[];
  }

  /** s6.b.G(): acknowledge a headset-initiated cancel and stop. */
  async handleDeviceCancel(frame: RaceFrame): Promise<void> {
    if (frame.command !== RACE_ID.cancel || frame.type !== RACE_TYPE.command) return;
    const [b0 = 0, b1 = 0, reason = 0xff] = frame.payload;
    await this.race.send(RACE_ID.cancel, Uint8Array.of(0), RACE_TYPE.response).catch(() => undefined);
    await this.race.send(RACE_ID.cancel, Uint8Array.of(b0, b1, reason), RACE_TYPE.indication).catch(() => undefined);
    const reasons: Record<number, string> = { 0: "cancelled", 1: "failed", 2: "timed out", 3: "partner lost", 4: "not allowed" };
    throw new Error(`Headphones stopped the update (${reasons[reason] ?? `reason 0x${reason.toString(16)}`}).`);
  }
}

async function readMdrMatching(mdr: MdrLink, match: (frame: MdrFrame) => boolean, timeoutMs = RESPONSE_TIMEOUT_MS): Promise<MdrFrame> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let frame: MdrFrame;
    try { frame = await mdr.receive(Math.max(1, deadline - Date.now())); }
    catch (error) { if (error instanceof BluetoothTimeoutError) break; throw error; }
    if (match(frame)) return frame;
  }
  throw new Error("Timed out waiting for a Sony MDR response.");
}

/**
 * Single-device installer. Call preflight() for a read-only check, or install()
 * to transfer and commit. Both leave update mode and the FOTA session closed on
 * failure; a successful install ends with the headphones restarting.
 */
export class Xm4DirectUpdater {
  private enabled = false;
  private sessionStarted = false;
  private committed = false;

  constructor(private mdr: MdrLink, private race: RaceLink) {}

  static fromTransport(transport: Xm4Transport): Xm4DirectUpdater {
    if (!transport.mdr || !transport.race) throw new Error("Connect both the Sony control and update channels first.");
    if (!transport.sameHeadsetConfirmed) throw new Error("Confirm both channels belong to the same headset and other headsets are off before continuing.");
    return new Xm4DirectUpdater(transport.mdr, transport.race);
  }

  /** Read-only: validates pack, headset capability, battery, partition, and FOTA state, then cancels. */
  async preflight(rawPack: Uint8Array, progress: Progress = () => {}): Promise<Xm4PreflightResult> {
    try {
      const { result } = await this.prepare(rawPack, progress);
      return result;
    } finally {
      await this.cleanup(progress);
    }
  }

  async install(rawPack: Uint8Array, options: InstallOptions = {}): Promise<void> {
    const progress = options.progress ?? (() => {});
    try {
      const { result, session } = await this.prepare(rawPack, progress);
      const plan = planFotaWrites(rawPack, result.partition);
      const total = plan.eraseAddresses.length + plan.pages.length;
      let lastBatteryCheck = Date.now();
      const tick = (base: number) => async (done: number) => {
        options.onFraction?.((base + done) / total);
        if (Date.now() - lastBatteryCheck > BATTERY_CHECK_MS) {
          lastBatteryCheck = Date.now();
          await this.checkBattery(result.method, progress, "during transfer", true);
        }
      };
      const writeState = (state: number) => session.single(`Write state 0x${state.toString(16)}`, {
        command: RACE_ID.writeState, payload: Uint8Array.of(state & 0xff, state >>> 8), respType: RACE_TYPE.response,
      });

      if (result.fotaState === FOTA_STATE.transferred) progress("A previous transfer is staged; transferring this pack over it instead of committing it.");
      if (!result.method.background) {
        await session.single("Active FOTA", { command: RACE_ID.activeFota, payload: Uint8Array.of(0), respType: RACE_TYPE.indication });
      }
      await session.single("Start transaction", { command: RACE_ID.startTransaction, payload: new Uint8Array(), respType: RACE_TYPE.response });
      await writeState(FOTA_STATE.erasing);
      progress(`Erasing ${plan.eraseAddresses.length} × 4 KiB in the update partition…`);
      await session.stage("Erase", plan.eraseAddresses.map((address) => ({
        command: RACE_ID.erase,
        payload: new Uint8Array([result.partition.storage, ...u32le(CHUNK), ...u32le(address)]),
        respType: RACE_TYPE.indication,
        acks: (frame) => frame.payload.length >= 10 && le32(frame.payload, 6) === address,
      })), { onAck: tick(0) });
      await writeState(FOTA_STATE.erased);
      await writeState(FOTA_STATE.programming);
      progress(`Writing ${plan.pages.length} pages…`);
      await session.stage("Program", plan.pages.map(({ address, payload }) => ({
        command: RACE_ID.program,
        payload,
        respType: RACE_TYPE.response,
        acks: (frame) => {
          const count = frame.payload[2] ?? 0;
          for (let i = 0; i < count; i++) if (le32(frame.payload, 3 + 4 * i) === address) return true;
          return false;
        },
      })), { onAck: tick(plan.eraseAddresses.length) });

      progress("Asking the headphones to verify the written pack…");
      await session.single("Integrity check", {
        command: RACE_ID.integrity, payload: Uint8Array.of(1, 0, result.partition.storage), respType: RACE_TYPE.indication,
      });
      await writeState(FOTA_STATE.transferred);
      const state = await this.queryState(session);
      if (state !== FOTA_STATE.transferred) throw new Error(`Headphones report FOTA state 0x${state.toString(16)} after transfer; not committing.`);
      progress("Pack transferred and verified by the headphones.");

      await this.checkBattery(result.method, progress, "before install", true);
      await this.commit(progress);
    } finally {
      if (!this.committed) await this.cleanup(progress);
    }
  }

  private async prepare(rawPack: Uint8Array, progress: Progress): Promise<{ result: Xm4PreflightResult; session: RaceSession }> {
    const pack = await inspectVoicePack(rawPack);
    progress(`Pack verified: ${pack.bytes} bytes, ${pack.slots} slots, SHA-256 ${pack.sha256.slice(0, 16)}…`);

    await this.drain();
    await this.readVoiceStatus(progress);
    const method = await this.readUpdateMethod();
    progress(`Headphones update method 0x${method.code.toString(16)} (${method.background ? "background" : "foreground"}, ` +
      `start ≥ ${method.startBattery}%, stop ≤ ${method.interruptBattery}%).`);
    if (!method.mtk) throw new Error("Headphones do not report the Airoha (MTK) update method; refusing.");
    if (method.tws) throw new Error("Headphones report a paired (TWS) update method, which this installer does not support.");
    const battery = await this.checkBattery(method, progress, "before starting");

    await this.setUpdateMode(true, progress);
    // s6.c.T0(): background devices use long-packet pacing (window 3, device interval); others prepoll 4.
    const session = new RaceSession(this.race, progress,
      method.background ? BACKGROUND_WINDOW : FOREGROUND_WINDOW, method.background ? 200 : 0);

    this.sessionStarted = true;
    await session.single("FOTA start", { command: RACE_ID.start, payload: Uint8Array.of(0x01), respType: RACE_TYPE.indication });
    progress("Airoha FOTA session started.");

    const interval = await session.single("Transmit interval", {
      command: RACE_ID.queryInterval, payload: Uint8Array.of(0x01, 0x00), respType: RACE_TYPE.indication,
    }, { skipOnTimeout: true });
    let transmitIntervalMs: number | undefined;
    if (interval && interval.payload.length >= 5) {
      transmitIntervalMs = interval.payload[3] | (interval.payload[4] << 8);
      if (method.background) session.delayMs = transmitIntervalMs; // s6.b.T()
    }

    const partitionFrame = (await session.single("Partition query", {
      command: RACE_ID.queryPartition, payload: Uint8Array.of(0x00), respType: RACE_TYPE.response,
    }))!;
    if (partitionFrame.payload.length < 11) throw new Error("Flash-partition response is truncated.");
    const partition = {
      id: partitionFrame.payload[1],
      storage: partitionFrame.payload[2],
      address: le32(partitionFrame.payload, 3),
      length: le32(partitionFrame.payload, 7),
    };
    assertExpectedPartition(partition);
    if (pack.bytes > partition.length) throw new Error("Voice pack is larger than the XM4 FOTA partition.");
    progress(`XM4 update partition confirmed: 0x${partition.address.toString(16)} / ${partition.length} bytes.`);

    const fotaState = await this.queryState(session);
    progress(`Current FOTA state: 0x${fotaState.toString(16)}.`);
    return { result: { pack, method, battery, partition, fotaState, transmitIntervalMs }, session };
  }

  /** Discard frames left over from an earlier run (e.g. a cancel confirmation) so they are not misread. */
  private async drain(): Promise<void> {
    for (const link of [this.race, this.mdr] as const) {
      for (let i = 0; i < 1000; i++) {
        try { await link.receive(50); }
        catch (error) { if (error instanceof BluetoothTimeoutError) break; throw error; }
      }
    }
  }

  private async queryState(session: RaceSession): Promise<number> {
    const frame = (await session.single("State query", {
      command: RACE_ID.queryState, payload: new Uint8Array(), respType: RACE_TYPE.response,
    }))!;
    if (frame.payload.length < 3) throw new Error("FOTA state response is truncated.");
    return frame.payload[1] | (frame.payload[2] << 8);
  }

  /** w6.e: after a successful commit the headset reboots and drops the link. */
  private async commit(progress: Progress): Promise<void> {
    progress("Installing: the headphones will restart. Do not turn them off.");
    const started = Date.now();
    const diagnostic = (message: string) => progress(`Commit +${((Date.now() - started) / 1000).toFixed(3)} s: ${message}`);
    let received = 0;
    let accepted = false;
    let deviceCancel: string | undefined;
    diagnostic("TX type=0x5a command=0x1c02 payload=00.");
    // A failed write can still have delivered the command. Treat that outcome as uncertain.
    this.committed = true;
    try { await this.race.send(RACE_ID.commit, Uint8Array.of(0x00)); }
    catch (error) { throw new CommitUnconfirmedError(`Commit send failed; delivery and installation are unknown: ${(error as Error).message}. Check the voice guidance before retrying.`); }
    diagnostic("Command sent; device acceptance is not yet confirmed.");
    const deadline = Date.now() + COMMIT_WAIT_MS;
    while (Date.now() < deadline) {
      let frame: RaceFrame;
      try {
        frame = await this.race.receive(Math.max(1, deadline - Date.now()));
      } catch (error) {
        if (error instanceof BluetoothClosedError) {
          diagnostic(`Update channel closed (${error.message}); cause unknown. ${accepted ? "A positive commit response was received." : "No positive commit response was received."} Installation is not confirmed by link closure alone.`);
          if (deviceCancel) diagnostic(`Device cancellation was also observed: ${deviceCancel}.`);
          throw new CommitUnconfirmedError(`Update channel closed. ${accepted ? "The commit was accepted, but" : "No commit acceptance was received;"} installation is not confirmed. Reconnect after restarting and check the voice guidance.`);
        }
        if (error instanceof BluetoothTimeoutError) break;
        throw new CommitUnconfirmedError(`Commit outcome is unknown after a receive error: ${(error as Error).message}. Check the voice guidance before retrying.`);
      }
      received++;
      diagnostic(`RX type=0x${frame.type.toString(16).padStart(2, "0")} command=0x${frame.command.toString(16).padStart(4, "0")} payload=${hex(frame.payload) || "(empty)"}.`);
      if (frame.command === RACE_ID.cancel && frame.type === RACE_TYPE.command) {
        const reason = frame.payload[2];
        const reasons: Record<number, string> = { 0: "cancelled", 1: "failed", 2: "timed out", 3: "partner lost", 4: "not allowed" };
        deviceCancel = reason === undefined ? "truncated cancellation payload" : `${reasons[reason] ?? "unknown reason"} (0x${reason.toString(16).padStart(2, "0")})`;
        diagnostic(`Device requested FOTA cancellation: ${deviceCancel}; acknowledging and stopping.`);
        this.committed = false;
        await new RaceSession(this.race, progress, 1, 0).handleDeviceCancel(frame);
      }
      if (frame.command !== RACE_ID.commit) continue;
      if (!frame.payload.length) {
        diagnostic("Commit frame has no status byte; it cannot confirm acceptance or rejection.");
        continue;
      }
      if (frame.type !== RACE_TYPE.response) {
        diagnostic("Commit frame has an unexpected type; acceptance is not confirmed.");
        continue;
      }
      if (frame.type === RACE_TYPE.response && frame.payload[0] === 0) {
        accepted = true;
        diagnostic("Positive commit response received (status 0x00); waiting for channel closure. Installation is not yet confirmed.");
      }
      if (frame.payload[0] !== 0) {
        diagnostic(`Commit rejection observed: status 0x${frame.payload[0].toString(16).padStart(2, "0")}, type 0x${frame.type.toString(16).padStart(2, "0")}.`);
        this.committed = false;
        throw new Error(`Headphones refused the install (status 0x${frame.payload[0].toString(16)}).`);
      }
    }
    // s6.b.g: commit without a disconnect is reported as COMMIT_FAIL.
    // A sent commit may still be processing. Do not cancel an uncertain commit.
    const evidence = deviceCancel
      ? `Device requested FOTA cancellation: ${deviceCancel}.`
      : accepted ? "A positive commit response was received."
      : received === 0 ? "No incoming RACE frames were received after sending commit; acceptance is not confirmed."
      : "Incoming RACE frames were received, but no positive commit response; acceptance is not confirmed.";
    diagnostic(`Restart wait timed out. ${evidence} Installation status is unresolved; no FOTA cancellation or update-mode command will be sent.`);
    throw new CommitUnconfirmedError(`Update channel did not close within ${COMMIT_WAIT_MS / 1000} s. ${evidence} Installation status is unresolved. Power-cycle them and check the voice guidance.`);
  }

  private async readVoiceStatus(progress: Progress): Promise<void> {
    // The first status inquiry after an RFCOMM connection may not be answered.
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.mdr.send(MDR.getVoiceStatus);
      try {
        const frame = await readMdrMatching(this.mdr, (f) => samePrefix(f.payload, MDR.voiceStatus), 2500);
        // Logged raw while we work out whether it carries the installed language.
        progress(`Voice-guidance status: ${[...frame.payload].map((b) => b.toString(16).padStart(2, "0")).join(" ")}.`);
        return;
      } catch { /* retry once, matching Sony's own connection behavior */ }
    }
    throw new Error("Could not read the headphones' voice-guidance status.");
  }

  private async readUpdateMethod(): Promise<UpdateMethod> {
    await this.mdr.send(MDR.getUpdateMethod);
    const frame = await readMdrMatching(this.mdr, (f) => samePrefix(f.payload, MDR.updateMethod));
    return parseUpdateMethod(frame.payload);
  }

  /**
   * Starting needs MIN_BATTERY_PERCENT and the headset's start threshold; once
   * started, only Sony's interrupt threshold applies (nu/o battery listener).
   */
  private async checkBattery(method: UpdateMethod, progress: Progress, when: string, started = false): Promise<number> {
    await this.mdr.send(MDR.getBattery, MDR_DATA_TABLE1);
    const frame = await readMdrMatching(this.mdr, (f) =>
      f.type === MDR_DATA_TABLE1 && (f.payload[0] === 0x11 || f.payload[0] === 0x13) && f.payload[1] === 0x00 && f.payload.length >= 3);
    const level = frame.payload[2];
    const minimum = started ? method.interruptBattery + 1 : Math.max(MIN_BATTERY_PERCENT, method.startBattery);
    if (level < minimum) throw new Error(`Battery is ${level}% ${when}; charge the headphones to at least ${minimum}%.`);
    progress(`Battery ${level}% ${when}.`);
    return level;
  }

  private async setUpdateMode(enabled: boolean, progress: Progress): Promise<void> {
    await this.mdr.send(MDR.setUpdateMode(enabled));
    if (enabled) this.enabled = true;
    const expected = enabled ? 0x00 : 0x01;
    await readMdrMatching(this.mdr, (frame) => samePrefix(frame.payload, MDR.updateModeNotify) && frame.payload[3] === expected);
    this.enabled = enabled;
    progress(enabled ? "Sony voice-guidance update mode enabled." : "Sony voice-guidance update mode disabled.");
  }

  /** v6.b cancel (single mode) and update mode off. The staged partition is left as is. */
  async cleanup(progress: Progress = () => {}): Promise<void> {
    if (this.sessionStarted) {
      this.sessionStarted = false;
      try {
        await this.race.send(RACE_ID.cancel, Uint8Array.of(0x07, 0x01, 0x00));
        const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
        while (Date.now() < deadline) {
          const frame = await this.race.receive(Math.max(1, deadline - Date.now()));
          if (frame.command === RACE_ID.cancel && frame.type !== RACE_TYPE.command) break;
        }
        progress("Airoha FOTA session cancelled.");
      } catch (error) { progress(`FOTA cancel: ${(error as Error).message}`); }
    }
    if (this.enabled) {
      try { await this.setUpdateMode(false, progress); }
      catch (error) { progress(`Could not confirm update mode was disabled: ${(error as Error).message}`); }
    }
  }
}
