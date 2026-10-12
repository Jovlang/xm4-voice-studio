import assert from "node:assert/strict";
import { CommitUnconfirmedError, RACE_ID, RACE_TYPE, Xm4DirectUpdater, type RaceLink } from "../src/lib/xm4-fota";
import { BluetoothClosedError, BluetoothTimeoutError, type RaceFrame } from "../src/lib/xm4-transport";

// Exercise the actual commit method without Bluetooth, flash writes, or waiting 45 seconds.
// Verify outcome classification and the commands sent after a known vs uncertain outcome.
async function run(frames: (RaceFrame | Error)[], sendFailure = false) {
  const logs: string[] = [];
  const sent: { command: number; payload: number[]; type?: number }[] = [];
  const race: RaceLink = {
    async send(command, payload = new Uint8Array(), type) { sent.push({ command, payload: [...payload], type }); if (sendFailure && command === RACE_ID.commit) throw new Error("partial write failure"); },
    async receive() {
      const next = frames.shift();
      if (next instanceof Error) throw next;
      if (next) return next;
      throw new BluetoothTimeoutError("simulated response timeout");
    },
  };
  const updater = new Xm4DirectUpdater({
    async send() { throw new Error("Commit diagnostics must not send MDR commands."); },
    async receive() { throw new Error("Commit diagnostics must not read MDR responses."); },
  }, race);
  const boundary = updater as unknown as { commit(progress: (line: string) => void): Promise<void>; sessionStarted: boolean; committed: boolean };
  boundary.sessionStarted = true;
  let error: unknown;
  try { await boundary.commit((line) => logs.push(line)); } catch (caught) { error = caught; }
  assert.deepEqual(sent[0], { command: RACE_ID.commit, payload: [0], type: undefined });
  if (!boundary.committed) {
    await updater.cleanup((line) => logs.push(line));
    assert.deepEqual(sent.at(-1), { command: RACE_ID.cancel, payload: [7, 1, 0], type: undefined });
  } else {
    assert.equal(sent.length, 1, "Uncertain commits must not send cancellation commands");
  }
  return { logs: logs.join("\n"), error, sent };
}

const frame = (command: number, type: number, ...payload: number[]): RaceFrame => ({ command, type, payload: Uint8Array.from(payload) });

const silence = await run([]);
assert.ok(silence.error instanceof CommitUnconfirmedError);
assert.match((silence.error as Error).message, /No incoming RACE frames.*acceptance is not confirmed/);
assert.doesNotMatch((silence.error as Error).message, /accepted the install/);
assert.match(silence.logs, /TX type=0x5a command=0x1c02 payload=00/);
assert.match(silence.logs, /no FOTA cancellation or update-mode command will be sent/);

const cancelled = await run([frame(RACE_ID.cancel, RACE_TYPE.command, 7, 1, 4)]);
assert.ok(cancelled.error instanceof Error && !(cancelled.error instanceof CommitUnconfirmedError));
assert.match(cancelled.logs, /RX type=0x5a command=0x1c03 payload=070104/);
assert.match((cancelled.error as Error).message, /Headphones stopped the update \(not allowed\)/);
assert.deepEqual(cancelled.sent.slice(1, 3), [
  { command: RACE_ID.cancel, payload: [0], type: RACE_TYPE.response },
  { command: RACE_ID.cancel, payload: [7, 1, 4], type: RACE_TYPE.indication },
]);

const accepted = await run([frame(RACE_ID.commit, RACE_TYPE.response, 0)]);
assert.ok(accepted.error instanceof CommitUnconfirmedError);
assert.match((accepted.error as Error).message, /positive commit response was received/);

const rejected = await run([frame(RACE_ID.commit, RACE_TYPE.response, 4)]);
assert.ok(rejected.error instanceof Error);
assert.match((rejected.error as Error).message, /refused the install.*0x4/);
assert.match(rejected.logs, /Commit rejection observed: status 0x04, type 0x5b/);

const malformed = await run([frame(RACE_ID.commit, RACE_TYPE.response)]);
assert.ok(malformed.error instanceof CommitUnconfirmedError);
assert.match(malformed.logs, /payload=\(empty\)/);
assert.match(malformed.logs, /no status byte/);

const unexpected = await run([frame(RACE_ID.commit, RACE_TYPE.command, 0), frame(RACE_ID.queryState, RACE_TYPE.response, 0, 17, 2)]);
assert.match(unexpected.logs, /unexpected type; acceptance is not confirmed/);
assert.match(unexpected.logs, /command=0x1c04 payload=001102/);
assert.doesNotMatch(unexpected.logs, /Positive commit response received/);

const disconnected = await run([new BluetoothClosedError("simulated link loss")]);
assert.ok(disconnected.error instanceof CommitUnconfirmedError);
assert.match(disconnected.logs, /cause unknown.*No positive commit response/);
assert.match(disconnected.logs, /not confirmed by link closure alone/);

const acceptedDisconnect = await run([frame(RACE_ID.commit, RACE_TYPE.response, 0), new BluetoothClosedError("simulated link loss")]);
assert.ok(acceptedDisconnect.error instanceof CommitUnconfirmedError);
assert.match(acceptedDisconnect.logs, /cause unknown.*A positive commit response/);

const truncatedCancel = await run([frame(RACE_ID.cancel, RACE_TYPE.command, 7)]);
assert.match(truncatedCancel.logs, /truncated cancellation payload/);

const wrongTypeFailure = await run([frame(RACE_ID.commit, RACE_TYPE.command, 4)]);
assert.ok(wrongTypeFailure.error instanceof CommitUnconfirmedError);
const receiveFailure = await run([new Error("read failure")]);
assert.ok(receiveFailure.error instanceof CommitUnconfirmedError);
const sendFailure = await run([], true);
assert.ok(sendFailure.error instanceof CommitUnconfirmedError);
assert.match((sendFailure.error as Error).message, /delivery and installation are unknown/);
console.log("Commit outcome simulations passed (12 scenarios)");
