import assert from "node:assert/strict";
import {
  applyStageSkip,
  chooseCompareSkip,
  chooseIntegritySkip,
  decideTwsAction,
  TWS_QUERY_STAGES,
  TWS_STAGES,
  TwsFotaStageQueue,
} from "../src/lib/xm4-fota-machine";

assert.equal(TWS_STAGES.length, 16);
assert.deepEqual(chooseCompareSkip("all", "none"), { skip: "all", progressRole: 0 });
assert.deepEqual(chooseCompareSkip("all", "all"), { skip: "all", progressRole: 1 });
assert.deepEqual(chooseCompareSkip("erase", "all"), { skip: "erase", progressRole: 1 });
assert.deepEqual(chooseCompareSkip("none", "all"), { skip: "clientErase", progressRole: 1 });
assert.deepEqual(chooseCompareSkip("none", "erase"), { skip: "clientErase", progressRole: 0 });
assert.deepEqual(chooseCompareSkip("none", "none"), { skip: "singleStateUpdate", progressRole: 0 });

const queue = new TwsFotaStageQueue();
assert.equal(queue.start(), "eraseStatus");
const afterCompareSkip = applyStageSkip(TWS_STAGES.slice(1), "eraseStatus", "compare");
assert.deepEqual(afterCompareSkip.slice(0, 5), ["startTwsTransaction", "pairedState0300", "erase", "pairedState0301", "state0310"]);
const afterCompareEraseSkip = applyStageSkip(TWS_STAGES.slice(1), "eraseStatus", "compareErase");
assert.deepEqual(afterCompareEraseSkip.slice(0, 3), ["startTransaction", "state0310", "program"]);
const afterAllSkip = applyStageSkip(TWS_STAGES.slice(2), "compare", "all");
assert.deepEqual(afterAllSkip, ["startTransaction", "integrityRole0", "state0311Role0", "integrityRole1", "pairedState0311", "queryStates"]);

assert.equal(decideTwsAction(0xffff, 0xffff, "unknown").action, "startFota");
assert.equal(decideTwsAction(785, 513, "startFota").action, "roleSwitch");
assert.equal(decideTwsAction(785, 785, "startFota").action, "twsCommit");
assert.equal(decideTwsAction(785, 785, "unknown").action, "startFota");
assert.equal(decideTwsAction(513, 785, "unknown").action, "startFota");

assert.equal(decideTwsAction(513, 785, "roleSwitch").action, "startFota");

assert.deepEqual(chooseIntegritySkip(0, 0, "none"), { skip: "partnerIntegrity", fatal: false });
assert.deepEqual(chooseIntegritySkip(0, 0, "all"), { skip: "none", fatal: false });
assert.deepEqual(chooseIntegritySkip(1, 1, "none"), { skip: "partnerIntegrity", fatal: false });
assert.deepEqual(chooseIntegritySkip(1, 0, "all"), { skip: "partnerIntegrity", fatal: true });

const foreground = new TwsFotaStageQueue({ foreground: true });
assert.equal(foreground.start(), "activeFotaRole0");
assert.equal(foreground.complete(), "activeFotaRole1");
assert.equal(foreground.complete(), "eraseStatus");

const query = new TwsFotaStageQueue();
assert.equal(query.query(), "fotaStart");
assert.equal(query.complete(), "queryTransmitInterval");
assert.equal(query.timeout(), "checkAgentChannel");
assert.throws(() => query.timeout());
let stage: string | undefined = "checkAgentChannel";
const seen = [stage];
while ((stage = query.complete())) seen.push(stage);
assert.deepEqual(seen, TWS_QUERY_STAGES.slice(2));

const roleSwitch = new TwsFotaStageQueue();
assert.equal(roleSwitch.roleSwitch(), "roleSwitch");
assert.equal(roleSwitch.complete(), undefined);

console.log("Sony paired FOTA state-machine simulations passed");
