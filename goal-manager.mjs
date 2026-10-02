// GoalManager — the persistent goal queue behind the agent session loop.
//
// AI-player roadmap milestone 1 ("Agent Core"): every activity of the bot is a
// *goal*, never a raw primitive. A goal carries where it came from (`source`),
// how important it is (`priority`) and its lifecycle (`status`). The controller
// asks the manager for the next goal to run, runs it to a terminal outcome, and
// reports back. The manager is deterministic and I/O-free: persistence is
// delegated to an injected repository (same interface as the world-memory
// repositories: get/upsert/find/remove/flush/close).
//
// Invariants:
//   - at most one goal is RUNNING at a time;
//   - a goal can be terminal (COMPLETED/FAILED/CANCELLED) only once;
//   - PENDING goals are pulled by priority (desc), then FIFO (createdAt asc).
//
// Statuses mirror the roadmap: PENDING → RUNNING → (SUSPENDED) → COMPLETED /
// FAILED, plus CANCELLED for an explicit human "stop" (an extension of the
// roadmap sketch, needed so a preempted goal can be dropped without lying
// "FAILED").

export const GOAL_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  SUSPENDED: 'suspended',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

export const GOAL_SOURCE = Object.freeze({
  EMERGENCY: 'emergency',         // world event that preempts everything (death, danger)
  CHAT: 'chat',                   // a trusted human ordered it in chat
  WORLD_EVENT: 'world_event',     // world-triggered activity
  PLAYER_BEHAVIOR: 'player_behavior', // reactivity to a player's behaviour
  CURRICULUM: 'curriculum',       // the progression engine (existing CURRICULUM mode)
  AUTONOMOUS: 'autonomous',       // needs-driven idle behaviour
});

// Higher number wins. EMERGENCY always preempts; CHAT beats autonomous work so a
// human order is not starved by a long progression goal.
export const SOURCE_PRIORITY = Object.freeze({
  [GOAL_SOURCE.EMERGENCY]: 100,
  [GOAL_SOURCE.CHAT]: 80,
  [GOAL_SOURCE.WORLD_EVENT]: 60,
  [GOAL_SOURCE.PLAYER_BEHAVIOR]: 50,
  [GOAL_SOURCE.CURRICULUM]: 40,
  [GOAL_SOURCE.AUTONOMOUS]: 20,
});

const TERMINAL = new Set([GOAL_STATUS.COMPLETED, GOAL_STATUS.FAILED, GOAL_STATUS.CANCELLED]);
const ACTIVE = new Set([GOAL_STATUS.PENDING, GOAL_STATUS.RUNNING, GOAL_STATUS.SUSPENDED]);

export const isTerminalStatus = (status) => TERMINAL.has(status);

function requireStatus (status) {
  if (!Object.values(GOAL_STATUS).includes(status)) throw new Error(`unknown goal status: ${status}`);
  return status;
}

function requireSource (source) {
  if (!Object.values(GOAL_SOURCE).includes(source)) throw new Error(`unknown goal source: ${source}`);
  return source;
}

export class GoalManager {
  constructor ({ store = null, clock = Date.now, idPrefix = 'g' } = {}) {
    this.store = store;
    this.clock = clock;
    this.idPrefix = idPrefix;
    this.seq = 0;
    this.goals = new Map(); // id -> goal (insertion order = creation order)
  }

  // ---- lifecycle ------------------------------------------------------------------
  enqueue ({ id = null, type = 'generic', source = GOAL_SOURCE.AUTONOMOUS, priority = null,
    objective, plan = null, parameters = null, parentGoal = null } = {}) {
    if (typeof objective !== 'string' || !objective.trim()) throw new Error('enqueue needs an objective');
    requireSource(source);
    this.seq += 1;
    const goalId = id ?? `${this.idPrefix}${this.seq}`;
    if (this.goals.has(goalId)) throw new Error(`goal id already exists: ${goalId}`);
    const goal = {
      id: goalId,
      type,
      source,
      priority: priority == null ? SOURCE_PRIORITY[source] : priority,
      status: GOAL_STATUS.PENDING,
      objective,
      plan,
      parameters,
      parentGoal,
      attempts: 0,
      createdAt: this.clock(),
      startedAt: null,
      finishedAt: null,
      reason: null,
      result: null,
    };
    this.goals.set(goalId, goal);
    this.persist();
    return goal;
  }

  get (id) { return this.goals.get(id) ?? null; }
  get current () { return [...this.goals.values()].find(g => g.status === GOAL_STATUS.RUNNING) ?? null; }
  pending () { return [...this.goals.values()].filter(g => g.status === GOAL_STATUS.PENDING); }
  list ({ status = null, source = null, includeTerminal = true } = {}) {
    let out = [...this.goals.values()];
    if (status) out = out.filter(g => g.status === status);
    if (source) out = out.filter(g => g.source === source);
    if (!includeTerminal) out = out.filter(g => !TERMINAL.has(g.status));
    return out;
  }

  counts () {
    const out = Object.fromEntries(Object.values(GOAL_STATUS).map(s => [s, 0]));
    for (const g of this.goals.values()) out[g.status] += 1;
    return out;
  }

  // ---- transitions -----------------------------------------------------------------
  // Pick the next goal to run: highest priority PENDING, then oldest. Does not
  // change state; call start() with the returned goal id.
  pull () {
    const candidates = this.pending();
    if (!candidates.length) return null;
    candidates.sort((a, b) => (b.priority - a.priority) || (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : 1));
    return candidates[0];
  }

  _require (id) {
    const goal = this.goals.get(id);
    if (!goal) throw new Error(`unknown goal: ${id}`);
    return goal;
  }

  start (id) {
    const goal = this._require(id);
    if (goal.status !== GOAL_STATUS.PENDING) throw new Error(`goal ${id} is ${goal.status}, not pending`);
    const running = this.current;
    if (running && running.id !== id) throw new Error(`goal ${running.id} is already running`);
    goal.status = GOAL_STATUS.RUNNING;
    goal.startedAt = this.clock();
    goal.attempts += 1;
    goal.reason = null;
    this.persist();
    return goal;
  }

  _finish (id, status, { reason = null, result = null } = {}) {
    const goal = this._require(id);
    if (TERMINAL.has(goal.status)) throw new Error(`goal ${id} already ${goal.status}`);
    goal.status = requireStatus(status);
    goal.finishedAt = this.clock();
    goal.reason = reason;
    goal.result = result;
    this.persist();
    return goal;
  }

  complete (id, result = null) { return this._finish(id, GOAL_STATUS.COMPLETED, { result }); }
  fail (id, reason = null, result = null) { return this._finish(id, GOAL_STATUS.FAILED, { reason, result }); }
  cancel (id, reason = null) { return this._finish(id, GOAL_STATUS.CANCELLED, { reason }); }

  suspend (id, reason = null) {
    const goal = this._require(id);
    if (goal.status !== GOAL_STATUS.RUNNING) throw new Error(`goal ${id} is ${goal.status}, not running`);
    goal.status = GOAL_STATUS.SUSPENDED;
    goal.reason = reason;
    this.persist();
    return goal;
  }

  resume (id) {
    const goal = this._require(id);
    if (goal.status !== GOAL_STATUS.SUSPENDED) throw new Error(`goal ${id} is ${goal.status}, not suspended`);
    goal.status = GOAL_STATUS.PENDING; // re-queued; pull() re-selects by priority
    goal.reason = null;
    this.persist();
    return goal;
  }

  // Suspend whatever is running (e.g. a CHAT/EMERGENCY goal arrived). Returns
  // the suspended goal or null. The caller decides whether to resume it later.
  preempt (reason = null) {
    const running = this.current;
    if (!running) return null;
    return this.suspend(running.id, reason);
  }

  // ---- persistence (delegated to the injected repository) --------------------------
  // Records use the same shape as the world-memory repositories: a stable `id`
  // plus a `kind` discriminator ('goal'). Status lives in `status`; the goal
  // payload is nested so it never collides with memory fields.
  toRecords () {
    return [...this.goals.values()].map(goal => ({ id: goal.id, kind: 'goal', status: goal.status, goal }));
  }

  fromRecords (records = []) {
    for (const record of records) {
      const goal = record?.goal ?? record;
      if (!goal?.id) continue;
      this.goals.set(goal.id, goal);
      const n = Number(String(goal.id).replace(/^\D+/, ''));
      if (Number.isFinite(n) && n > this.seq) this.seq = n;
    }
    return this;
  }

  persist () {
    if (!this.store) return;
    for (const record of this.toRecords()) this.store.upsert(record);
  }

  hydrate () {
    if (!this.store) return this;
    if (typeof this.store.load === 'function') this.store.load();
    const records = typeof this.store.find === 'function' ? this.store.find({ kind: 'goal' }) : [];
    this.fromRecords(records);
    return this;
  }

  flush () { if (this.store?.flush) this.store.flush(); }
  close () { if (this.store?.close) this.store.close(); }

  // Serializable session snapshot (no dependency on the store).
  snapshot () {
    return { seq: this.seq, savedAt: this.clock(), goals: [...this.goals.values()].map(g => ({ ...g })) };
  }

  static restore (snapshot, { ...options } = {}) {
    const manager = new GoalManager(options);
    if (snapshot && typeof snapshot === 'object') {
      manager.seq = snapshot.seq ?? 0;
      manager.fromRecords(snapshot.goals ?? []);
    }
    return manager;
  }
}

export function createGoalManager (options = {}) {
  return new GoalManager(options);
}

export { ACTIVE as ACTIVE_GOAL_STATUSES, TERMINAL as TERMINAL_GOAL_STATUSES };
