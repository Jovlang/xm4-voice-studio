/**
 * Low-level WH-1000XM4 Bluetooth Classic transport.
 *
 * The XM4's MT2811 update path uses two RFCOMM services: Sony MDR for update
 * mode and Airoha SPP for RACE/FOTA. This module only opens the channels and
 * handles framing. It deliberately does not start a FOTA session or write flash.
 *
 * Requires a Chromium browser with Web Serial Bluetooth RFCOMM support, a
 * secure context (HTTPS or localhost), and the headphones paired in the OS.
 */

export const XM4_UUID = {
  mdr: "96cc203e-5068-46ad-b32d-e316f5e069ba",
  spp: "8901dfa8-5c7e-4d8f-9f0c-c2b70683f5f0",
} as const;

export interface SerialPortInfo {
  bluetoothServiceClassId?: string | number;
  usbVendorId?: number;
  usbProductId?: number;
}

export interface SerialPortLike {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number; dataBits?: number; stopBits?: number; parity?: string; flowControl?: string }): Promise<void>;
  close(): Promise<void>;
  getInfo(): SerialPortInfo;
}

interface SerialLike {
  requestPort(options: { filters: { bluetoothServiceClassId: string }[]; allowedBluetoothServiceClassIds: string[] }): Promise<SerialPortLike>;
}

declare global {
  interface Navigator { serial?: SerialLike }
}

export type RaceFrame = { type: number; command: number; payload: Uint8Array };
export type MdrFrame = { type: number; sequence: number; payload: Uint8Array };

/** Sony MDR table-2 data (voice guidance); table-1 (0x0c) carries common commands such as battery. */
export const MDR_DATA = 0x0e;
export const MDR_DATA_TABLE1 = 0x0c;
const MDR_ACK = 0x01;
const RACE_CHANNEL = 0x05;
const RACE_COMMAND = 0x5a;

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function u16le(n: number): Uint8Array { return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff); }
function u32be(n: number): Uint8Array { return Uint8Array.of(n >>> 24, n >>> 16, n >>> 8, n); }
function readU16le(b: Uint8Array, i: number): number { return b[i] | (b[i + 1] << 8); }
function readU32be(b: Uint8Array, i: number): number { return ((b[i] * 0x1000000) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]) >>> 0; }

/** Sony MDR frame: 3E, escaped(type/seq/lenBE/payload/checksum), 3C. */
export function encodeMdrFrame(type: number, sequence: number, payload: Uint8Array): Uint8Array {
  const body = concat(concat(Uint8Array.of(type, sequence), u32be(payload.length)), payload);
  let sum = 0;
  for (const b of body) sum = (sum + b) & 0xff;
  const checked = concat(body, Uint8Array.of(sum));
  const escaped: number[] = [0x3e];
  for (const b of checked) {
    if (b === 0x3c || b === 0x3d || b === 0x3e) escaped.push(0x3d, b & ~0x10);
    else escaped.push(b);
  }
  escaped.push(0x3c);
  return Uint8Array.from(escaped);
}

/** Airoha RACE frame: 15, type, lengthLE (= 2 + payload), commandLE, payload. */
export function encodeRaceFrame(command: number, payload: Uint8Array, type = RACE_COMMAND): Uint8Array {
  const len = payload.length + 2;
  return concat(Uint8Array.of(0x15, type, ...u16le(len), ...u16le(command)), payload);
}

type Parser<T> = (buffer: Uint8Array) => { value: T; used: number } | null;

/** No complete frame arrived in time; the link may still be up. */
export class BluetoothTimeoutError extends Error {}
/** The headphones (or we) closed the RFCOMM link. */
export class BluetoothClosedError extends Error {}

class FramedPort {
  private port: SerialPortLike;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
  private readTask?: Promise<void>;
  private closed = false;
  private ended = false;

  private constructor(port: SerialPortLike) { this.port = port; }

  static async request(serviceUuid: string, log: (message: string) => void = () => {}): Promise<FramedPort> {
    const started = Date.now();
    const report = (message: string) => log(`Control +${((Date.now() - started) / 1000).toFixed(3)} s: ${message}`);
    const failed = (stage: string, error: unknown) => {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      report(`${stage} failed: ${detail}`);
    };
    report(`secureContext=${globalThis.isSecureContext}; Web Serial=${!!navigator.serial}; service=${serviceUuid}.`);
    if (!navigator.serial) throw new Error("Web Serial Bluetooth is unavailable. Use current desktop Chrome or Edge over HTTPS/localhost.");
    // requestPort must be called directly from a user gesture.
    // The filter limits the picker to this RFCOMM service, so the two XM4 entries can't be mixed up.
    report("Opening Bluetooth port picker; waiting for your selection.");
    let port: SerialPortLike;
    try {
      port = await navigator.serial.requestPort({
        filters: [{ bluetoothServiceClassId: serviceUuid }],
        allowedBluetoothServiceClassIds: [serviceUuid],
      });
    } catch (error) {
      failed("Port selection", error);
      throw error;
    }
    report("Port selected.");
    try {
      const info = port.getInfo();
      report(`Port info=${JSON.stringify(info)}.`);
      if (info.bluetoothServiceClassId && String(info.bluetoothServiceClassId).toLowerCase() !== serviceUuid.toLowerCase()) {
        throw new Error("Selected port exposes the wrong Bluetooth service. Select the correct channel again.");
      }
    }
    catch (error) { failed("Reading port info", error); throw error; }
    report("Calling SerialPort.open: baudRate=115200, dataBits=8, stopBits=1, parity=none, flowControl=none.");
    try {
      await port.open({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" });
    } catch (error) {
      failed("SerialPort.open", error);
      report("The browser could not open the RFCOMM service; this error does not identify whether the cause is a port lock, Windows Bluetooth, or the headset.");
      throw error;
    }
    report(`SerialPort.open resolved; readable=${!!port.readable}, writable=${!!port.writable}.`);
    if (!port.readable || !port.writable) {
      await port.close();
      throw new Error("The selected RFCOMM port did not expose readable and writable streams.");
    }
    const channel = new FramedPort(port);
    try { channel.reader = port.readable.getReader(); }
    catch (error) { failed("Acquiring stream reader", error); await port.close().catch(() => {}); throw error; }
    channel.readTask = channel.pump();
    report("Stream reader acquired; receive loop started. No Sony commands have been sent.");
    return channel;
  }

  private async pump(): Promise<void> {
    try {
      while (!this.closed && this.reader) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value?.length) this.buffer = concat(this.buffer, value);
      }
    } catch {
      // A remote disconnect rejects the read; read() reports it as BluetoothClosedError.
    } finally {
      this.ended = true;
    }
  }

  async write(data: Uint8Array): Promise<void> {
    if (this.closed || this.ended || !this.port.writable) throw new BluetoothClosedError("Bluetooth channel is closed.");
    const writer = this.port.writable.getWriter();
    try { await writer.write(data); }
    finally { writer.releaseLock(); }
  }

  async read<T>(parse: Parser<T>, timeoutMs = 9000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let parsed: ReturnType<Parser<T>>;
      try {
        parsed = parse(this.buffer);
      } catch {
        // Corrupt frame: drop its first byte so the parser resyncs on the next frame start.
        this.buffer = this.buffer.slice(1);
        continue;
      }
      if (parsed) {
        this.buffer = this.buffer.slice(parsed.used);
        return parsed.value;
      }
      if (this.closed || this.ended) throw new BluetoothClosedError("Bluetooth channel closed while waiting for a frame.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new BluetoothTimeoutError(`Timed out waiting for a Bluetooth frame (${timeoutMs} ms).`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.reader?.cancel(); } catch { /* already disconnected */ }
    this.reader?.releaseLock();
    this.reader = undefined;
    await this.readTask?.catch(() => undefined);
    await this.port.close();
  }

  info(): SerialPortInfo { return this.port.getInfo(); }
}

export function decodeMdrFrame(buffer: Uint8Array): { frame: MdrFrame; bytesUsed: number } | null {
  const start = buffer.indexOf(0x3e);
  if (start < 0) return null;
  const end = buffer.indexOf(0x3c, start + 1);
  if (end < 0) return null;
  const escaped = buffer.slice(start + 1, end);
  const body: number[] = [];
  for (let i = 0; i < escaped.length; i++) {
    if (escaped[i] === 0x3d) {
      if (++i >= escaped.length) return null;
      body.push(escaped[i] | 0x10);
    } else body.push(escaped[i]);
  }
  if (body.length < 7) throw new Error("Malformed MDR frame.");
  const n = readU32be(Uint8Array.from(body), 2);
  if (body.length !== n + 7) throw new Error("MDR frame length does not match its payload.");
  let sum = 0;
  for (let i = 0; i < body.length - 1; i++) sum = (sum + body[i]) & 0xff;
  if (sum !== body[body.length - 1]) throw new Error("MDR frame checksum failed.");
  return { frame: { type: body[0], sequence: body[1], payload: Uint8Array.from(body.slice(6, -1)) }, bytesUsed: end + 1 };
}

export function decodeRaceFrame(buffer: Uint8Array): { frame: RaceFrame; bytesUsed: number } | null {
  let start = 0;
  while (start + 1 < buffer.length && (buffer[start] !== 0x15 || (buffer[start] & 0x0f) !== RACE_CHANNEL)) start++;
  if (start + 4 > buffer.length) return null;
  const length = readU16le(buffer, start + 2);
  const total = 4 + length;
  if (length < 2) throw new Error("Malformed RACE packet length.");
  if (buffer.length < start + total) return null;
  return { frame: { type: buffer[start + 1], command: readU16le(buffer, start + 4), payload: buffer.slice(start + 6, start + total) }, bytesUsed: start + total };
}

export class Xm4MdrChannel {
  private sequence = 0;
  private constructor(private channel: FramedPort) {}

  static async request(log?: (message: string) => void): Promise<Xm4MdrChannel> { return new Xm4MdrChannel(await FramedPort.request(XM4_UUID.mdr, log)); }
  info(): SerialPortInfo { return this.channel.info(); }

  async send(payload: Uint8Array, type = MDR_DATA): Promise<void> {
    await this.channel.write(encodeMdrFrame(type, this.sequence, payload));
    this.sequence = 1 - this.sequence;
  }

  async receive(timeoutMs = 9000): Promise<MdrFrame> {
    while (true) {
      const decoded = await this.channel.read((buffer) => {
        const result = decodeMdrFrame(buffer);
        return result && { value: result.frame, used: result.bytesUsed };
      }, timeoutMs);
      const frame = decoded;
      if (frame.type === MDR_ACK) continue;
      // Device data frames are acknowledged with the opposite sequence bit.
      await this.channel.write(encodeMdrFrame(MDR_ACK, 1 - frame.sequence, new Uint8Array()));
      return frame;
    }
  }

  async close(): Promise<void> { await this.channel.close(); }
}

export class Xm4RaceChannel {
  private constructor(private channel: FramedPort) {}

  static async request(): Promise<Xm4RaceChannel> { return new Xm4RaceChannel(await FramedPort.request(XM4_UUID.spp)); }
  info(): SerialPortInfo { return this.channel.info(); }

  async send(command: number, payload = new Uint8Array(), type = RACE_COMMAND): Promise<void> {
    await this.channel.write(encodeRaceFrame(command, payload, type));
  }

  async receive(timeoutMs = 9000): Promise<RaceFrame> {
    return this.channel.read((buffer) => {
      const result = decodeRaceFrame(buffer);
      return result && { value: result.frame, used: result.bytesUsed };
    }, timeoutMs);
  }

  async request(command: number, payload = new Uint8Array(), timeoutMs = 9000): Promise<RaceFrame> {
    await this.send(command, payload);
    const response = await this.receive(timeoutMs);
    if (response.command !== command) throw new Error(`Unexpected RACE response 0x${response.command.toString(16)} for 0x${command.toString(16)}.`);
    return response;
  }

  async close(): Promise<void> { await this.channel.close(); }
}

/** Minimal paired-channel owner; connect each channel from its own button click. */
export class Xm4Transport {
  sameHeadsetConfirmed = false;
  mdr?: Xm4MdrChannel;
  race?: Xm4RaceChannel;

  async connectMdr(log?: (message: string) => void): Promise<Xm4MdrChannel> {
    if (this.mdr) throw new Error("Control channel is already connected; disconnect before selecting another headset.");
    this.sameHeadsetConfirmed = false;
    this.mdr = await Xm4MdrChannel.request(log); return this.mdr;
  }
  async connectRace(): Promise<Xm4RaceChannel> {
    if (this.race) throw new Error("Update channel is already connected; disconnect before selecting another headset.");
    this.sameHeadsetConfirmed = false;
    this.race = await Xm4RaceChannel.request(); return this.race;
  }

  async close(): Promise<void> {
    const channels = [this.mdr?.close(), this.race?.close()].filter((p): p is Promise<void> => !!p);
    this.mdr = undefined;
    this.race = undefined;
    this.sameHeadsetConfirmed = false;
    await Promise.allSettled(channels);
  }
}
