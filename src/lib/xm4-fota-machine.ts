/**
 * Offline port of the paired (TWS) stage queue in Sony's bundled Airoha SDK.
 * This models decisions only; it does not construct or send RACE packets.
 */

export const TWS_STAGES = [
  "eraseStatus",
  "compare",
  "startTransaction",
  "startTwsTransaction",
  "state0300",
  "pairedState0300",
  "erase",
  "state0301",
  "pairedState0301",
  "state0310",
  "program",
  "integrityRole0",
  "state0311Role0",
  "integrityRole1",
  "pairedState0311",
  "queryStates",
] as const;

/** Queued by s6.b.U() ahead of TWS_STAGES when the SDK is started in foreground mode. */
export const TWS_ACTIVE_FOTA_STAGES = ["activeFotaRole0", "activeFotaRole1"] as const;

/** Queue from s6.c.L0(), run on start and after every reconnect before E() decides. */
export const TWS_QUERY_STAGES = [
  "fotaStart",
  "queryTransmitInterval",
  "checkAgentChannel",
  "queryPartition",
  "versionRole0",
  "versionRole1",
  "queryStates",
] as const;

export type TwsStage =
  | (typeof TWS_STAGES)[number]
  | (typeof TWS_ACTIVE_FOTA_STAGES)[number]
  | (typeof TWS_QUERY_STAGES)[number]
  | "roleSwitch";
export type TwsSkip =
  | "none"
  | "compare"
  | "erase"
  | "program"
  | "compareErase"
  | "clientErase"
  | "partnerIntegrity"
  | "singleStateUpdate"
  | "all";

export type DualAction = "startFota" | "roleSwitch" | "twsCommit" | "complete";

const skipFollowingStages: Partial<Record<TwsStage, Partial<Record<TwsSkip, TwsStage[]>>>> = {
  eraseStatus: {
    compare: ["compare", "startTransaction", "state0300", "state0301"],
    compareErase: ["compare", "startTwsTransaction", "state0300", "pairedState0300", "erase", "state0301", "pairedState0301"],
  },
  compare: {
    erase: ["startTwsTransaction", "state0300", "pairedState0300", "erase", "state0301", "pairedState0301"],
    clientErase: ["startTwsTransaction", "pairedState0300", "pairedState0301"],
    all: ["startTwsTransaction", "state0300", "pairedState0300", "erase", "state0301", "pairedState0301", "state0310", "program"],
    singleStateUpdate: ["startTransaction", "state0300", "state0301"],
  },
  integrityRole0: { partnerIntegrity: ["integrityRole1", "pairedState0311"] },
  integrityRole1: { partnerIntegrity: ["pairedState0311"] },
};

/** Queue behavior copied from s6.b.W() and the skip links configured in s6.b.x0(). */
export function applyStageSkip(queue: readonly TwsStage[], completed: TwsStage, skip: TwsSkip): TwsStage[] {
  if (skip === "none") return [...queue];
  const remove = new Set(skipFollowingStages[completed]?.[skip] ?? []);
  // SDK's reGenStageQueue returns the original queue when a skip type has no
  // link configured for the completed stage.
  return queue.filter((stage) => !remove.has(stage));
}

export interface CompareSkipDecision {
  skip: TwsSkip;
  /** SDK sets its progress ear to PARTNER when the partner already matches. */
  progressRole: 0 | 1;
}

/** Mirrors x6.m.isCompleted(): progress switches to PARTNER only when the partner skips all. */
export function chooseCompareSkip(agent: TwsSkip, partner: TwsSkip): CompareSkipDecision {
  const progressRole = partner === "all" ? 1 : 0;
  if (agent === "all") return { skip: "all", progressRole };
  if (partner === "all" || partner === "erase") {
    return { skip: agent === "erase" ? "erase" : "clientErase", progressRole };
  }
  return { skip: "singleStateUpdate", progressRole };
}

export interface IntegritySkipDecision {
  skip: TwsSkip;
  /** Stage sets isErrorOccurred(); s6.b aborts the whole FOTA. */
  fatal: boolean;
}

/**
 * Mirrors w6.d.k() for integrityRole0/integrityRole1. `partnerCompareSkip` is the
 * partner's own compare result (x6.m stores it via s6.b.d0()), not the combined skip.
 */
export function chooseIntegritySkip(status: number, recipient: number, partnerCompareSkip: TwsSkip): IntegritySkipDecision {
  if (status === 0) {
    return { skip: partnerCompareSkip === "all" ? "none" : "partnerIntegrity", fatal: false };
  }
  return { skip: "partnerIntegrity", fatal: recipient !== 1 };
}

export interface TwsFotaQueueOptions {
  /** Sony passes !mIsBackground; foreground runs prepend the TwsActiveFota stages. */
  foreground?: boolean;
}

/** Minimal queue driver mirroring s6.b's completion/skip/requeue behavior. */
export class TwsFotaStageQueue {
  private pending: TwsStage[] = [];
  private active?: TwsStage;

  constructor(private readonly options: TwsFotaQueueOptions = {}) {}

  /** s6.c.L0(): query both ears; feed queryStates' result into decideTwsAction(). */
  query(): TwsStage | undefined { return this.load(TWS_QUERY_STAGES); }

  /** s6.b.x0(): the update queue run for a StartFota action. */
  start(): TwsStage | undefined {
    return this.load(this.options.foreground ? [...TWS_ACTIVE_FOTA_STAGES, ...TWS_STAGES] : TWS_STAGES);
  }

  /**
   * s6.b.t(): single-stage queue for a RoleSwitch action. The headset then drops the
   * link; on reconnect call query() and decideTwsAction(..., "roleSwitch").
   */
  roleSwitch(): TwsStage | undefined { return this.load(["roleSwitch"]); }

  current(): TwsStage | undefined { return this.active; }

  /** s6.b's response timeout only skips the transmit-interval query; anything else retries. */
  timeout(): TwsStage | undefined {
    if (this.active !== "queryTransmitInterval") throw new Error(`No timeout skip for ${this.active}.`);
    return this.next();
  }

  /** Complete current stage and apply its SKIP_TYPE links to later stages. */
  complete(skip: TwsSkip = "none"): TwsStage | undefined {
    if (!this.active) throw new Error("No active TWS FOTA stage.");
    const completed = this.active;
    this.pending = applyStageSkip(this.pending, completed, skip);
    this.active = undefined;
    if (completed === "queryStates") return undefined;
    return this.next();
  }

  private load(stages: readonly TwsStage[]): TwsStage | undefined {
    this.pending = [...stages];
    return this.next();
  }

  private next(): TwsStage | undefined {
    this.active = this.pending.shift();
    return this.active;
  }
}

export interface TwsStateDecision {
  action: DualAction;
  reason: string;
}

/**
 * State/action dispatch from s6.c.E(), without its one-second UI callbacks. Pass the
 * last action taken (e.g. "roleSwitch" after a role switch and requery).
 * "twsCommit" only means ready to commit: Sony sends the commit (x6.b) when the app
 * later calls startCommitProcess(). E() also dispatches StartFota twice for agent 257 /
 * partner 785 (missing return); this dispatches once.
 */
export function decideTwsAction(agent: number, partner: number, previousAction: DualAction | "unknown"): TwsStateDecision {
  if (agent === 0xffff && (partner === 0xffff || partner === 785)) {
    return { action: "startFota", reason: "fresh or partner already complete" };
  }
  if (agent === 257 && (partner === 257 || partner === 785)) {
    return { action: "startFota", reason: "both in resumable state or partner complete" };
  }
  if (agent === 785) {
    if (partner !== 785) return { action: "roleSwitch", reason: "agent complete; partner still needs update" };
    return previousAction === "startFota"
      ? { action: "twsCommit", reason: "both ears report integrity-complete state" }
      : { action: "startFota", reason: "both ears complete; manager resumes its commit path" };
  }
  if (partner === 785) return { action: "startFota", reason: "partner complete; agent still needs update" };
  if (agent === 513 && (partner === 513 || partner === 785)) {
    return { action: "startFota", reason: "both in resumable state or partner complete" };
  }
  // This is deliberately the SDK's catch-all StartFota branch, including 784/785.
  return { action: "startFota", reason: "SDK default recovery path" };
}
