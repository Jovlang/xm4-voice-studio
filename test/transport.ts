import assert from "node:assert/strict";
import { Xm4MdrChannel, Xm4Transport, XM4_UUID, type SerialPortLike } from "../src/lib/xm4-transport";
import { Xm4DirectUpdater } from "../src/lib/xm4-fota";
for (const scenario of ["picker failure", "open failure", "wrong service", "success"]) {
  const lines: string[] = [];
  let opens = 0;
  const expected = new Error(`simulated ${scenario}`);
  const port: SerialPortLike = {
    getInfo: () => ({ bluetoothServiceClassId: scenario === "wrong service" ? XM4_UUID.spp : XM4_UUID.mdr }),
    readable: new ReadableStream({ start(controller) { controller.close(); } }), writable: new WritableStream(),
    open: async () => { opens++; if (scenario === "open failure") throw expected; }, close: async () => {},
  };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { serial: { requestPort: async () => {
    if (scenario === "picker failure") throw expected;
    return port;
  } } } });
  if (scenario === "success") {
    const channel = await Xm4MdrChannel.request(message => lines.push(message));
    assert.ok(lines.some(line => line.includes("receive loop started")));
    await channel.close();
  } else {
    await assert.rejects(Xm4MdrChannel.request(message => lines.push(message)), scenario === "wrong service" ? /wrong Bluetooth service/ : error => error === expected);
  }
  assert.equal(opens, scenario === "picker failure" || scenario === "wrong service" ? 0 : 1);
}
const transport = new Xm4Transport();
assert.throws(() => Xm4DirectUpdater.fromTransport(transport), /Connect both/);
// Stub both links; constructing the updater must not issue any device commands.
transport.mdr = {} as NonNullable<Xm4Transport["mdr"]>;
transport.race = {} as NonNullable<Xm4Transport["race"]>;
assert.throws(() => Xm4DirectUpdater.fromTransport(transport), /Confirm both channels/);
transport.sameHeadsetConfirmed = true;
assert.ok(Xm4DirectUpdater.fromTransport(transport));
await assert.rejects(transport.connectMdr(), /already connected/);
await assert.rejects(transport.connectRace(), /already connected/);
console.log("Channel service validation and connection safeguards passed");
