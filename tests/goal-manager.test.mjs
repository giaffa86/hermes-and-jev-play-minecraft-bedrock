import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoalManager, createGoalManager, GOAL_STATUS, GOAL_SOURCE, SOURCE_PRIORITY } from '../goal-manager.mjs';
import { JsonMemoryRepository } from '../memory-store.mjs';

const fixedClock = (t0 = 1000, step = 1) => {
  let t = t0;
  return () => (t += step);
};

test('enqueue fills defaults: status, priority from source, timestamps', () => {
  const gm = createGoalManager({ clock: fixedClock() });
  const g = gm.enqueue({ objective: 'get wood', source: GOAL_SOURCE.AUTONOMOUS });
  assert.equal(g.id, 'g1');
  assert.equal(g.status, GOAL_STATUS.PENDING);
  assert.equal(g.priority, SOURCE_PRIORITY[GOAL_SOURCE.AUTONOMOUS]);
  assert.equal(g.createdAt, 1001);
  assert.equal(g.attempts, 0);
  assert.equal(gm.get('g1'), g);
});

test('enqueue requires a non-empty objective and a known source', () => {
  const gm = createGoalManager();
  assert.throws(() => gm.enqueue({ objective: '   ' }), /objective/);
  assert.throws(() => gm.enqueue({ objective: 'x', source: 'nope' }), /unknown goal source/);
});

test('pull picks highest priority, then FIFO, and does not mutate state', () => {
  const gm = createGoalManager({ clock: fixedClock() });
  const low = gm.enqueue({ objective: 'low', source: GOAL_SOURCE.AUTONOMOUS, priority: 10 });
  const highA = gm.enqueue({ objective: 'highA', source: GOAL_SOURCE.EMERGENCY });
  const highB = gm.enqueue({ objective: 'highB', source: GOAL_SOURCE.EMERGENCY });
  assert.equal(gm.pull().id, highA.id);
  assert.equal(gm.pull().id, highA.id, 'pull is read-only');
  gm.start(highA.id); gm.complete(highA.id);
  assert.equal(gm.pull().id, highB.id, 'FIFO among equal priority');
  gm.start(highB.id); gm.complete(highB.id);
  assert.equal(gm.pull().id, low.id);
});

test('source priorities order chat above autonomous and emergency above chat', () => {
  const gm = createGoalManager({ clock: fixedClock() });
  const auto = gm.enqueue({ objective: 'auto', source: GOAL_SOURCE.AUTONOMOUS });
  const chat = gm.enqueue({ objective: 'chat', source: GOAL_SOURCE.CHAT });
  const emergency = gm.enqueue({ objective: 'emg', source: GOAL_SOURCE.EMERGENCY });
  assert.equal(gm.pull().id, emergency.id);
  gm.start(emergency.id); gm.complete(emergency.id);
  assert.equal(gm.pull().id, chat.id);
  gm.start(chat.id); gm.complete(chat.id);
  assert.equal(gm.pull().id, auto.id);
});

test('only one goal runs at a time', () => {
  const gm = createGoalManager();
  const a = gm.enqueue({ objective: 'a' });
  const b = gm.enqueue({ objective: 'b' });
  gm.start(a.id);
  assert.equal(gm.current.id, a.id);
  assert.throws(() => gm.start(b.id), /already running/);
});

test('terminal transitions happen once and record reason/result', () => {
  const gm = createGoalManager({ clock: fixedClock() });
  const a = gm.enqueue({ objective: 'a' });
  gm.start(a.id);
  gm.complete(a.id, { steps: 3 });
  assert.equal(a.status, GOAL_STATUS.COMPLETED);
  assert.deepEqual(a.result, { steps: 3 });
  assert.throws(() => gm.fail(a.id, 'late'), /already completed/);

  const b = gm.enqueue({ objective: 'b' });
  gm.start(b.id);
  gm.fail(b.id, 'no path');
  assert.equal(b.status, GOAL_STATUS.FAILED);
  assert.equal(b.reason, 'no path');

  const c = gm.enqueue({ objective: 'c' });
  gm.cancel(c.id, 'human stop');
  assert.equal(c.status, GOAL_STATUS.CANCELLED);
});

test('suspend then resume re-queues the goal as pending', () => {
  const gm = createGoalManager();
  const a = gm.enqueue({ objective: 'a' });
  gm.start(a.id);
  gm.suspend(a.id, 'emergency');
  assert.equal(a.status, GOAL_STATUS.SUSPENDED);
  assert.equal(gm.current, null);
  assert.equal(gm.pending().length, 0);
  gm.resume(a.id);
  assert.equal(a.status, GOAL_STATUS.PENDING);
  assert.equal(gm.pull().id, a.id);
});

test('preempt suspends the running goal and returns it', () => {
  const gm = createGoalManager();
  assert.equal(gm.preempt('nothing running'), null);
  const a = gm.enqueue({ objective: 'auto' });
  gm.start(a.id);
  const suspended = gm.preempt('chat arrived');
  assert.equal(suspended.id, a.id);
  assert.equal(a.status, GOAL_STATUS.SUSPENDED);
  assert.equal(a.reason, 'chat arrived');
});

test('ancestors/depth walk the parent chain, nearest first and cycle-safe', () => {
  const gm = createGoalManager();
  assert.equal(gm.depth('missing'), 0);
  const a = gm.enqueue({ objective: 'a', source: GOAL_SOURCE.AUTONOMOUS });
  const b = gm.enqueue({ objective: 'b', source: GOAL_SOURCE.CHAT, parentGoal: a.id });
  const c = gm.enqueue({ objective: 'c', source: GOAL_SOURCE.CHAT, parentGoal: b.id });
  assert.deepEqual(gm.ancestors(c.id).map(goal => goal.id), [b.id, a.id]);
  assert.equal(gm.depth(c.id), 2);
  assert.equal(gm.depth(a.id), 0);
  // Un padre che non esiste piu' chiude la catena invece di lanciare.
  const orphan = gm.enqueue({ objective: 'orphan', parentGoal: 'g999' });
  assert.deepEqual(gm.ancestors(orphan.id), []);
  // Un ciclo (store modificato a mano) non fa girare all'infinito.
  a.parentGoal = c.id;
  assert.deepEqual(gm.ancestors(a.id).map(goal => goal.id), [c.id, b.id]);
});

test('counts and list filter by status/source', () => {
  const gm = createGoalManager();
  const a = gm.enqueue({ objective: 'a', source: GOAL_SOURCE.CHAT });
  const b = gm.enqueue({ objective: 'b', source: GOAL_SOURCE.AUTONOMOUS });
  gm.start(a.id); gm.complete(a.id);
  const counts = gm.counts();
  assert.equal(counts.completed, 1);
  assert.equal(counts.pending, 1);
  assert.deepEqual(gm.list({ source: GOAL_SOURCE.CHAT }).map(g => g.id), [a.id]);
  assert.deepEqual(gm.list({ status: GOAL_STATUS.PENDING }).map(g => g.id), [b.id]);
  assert.deepEqual(gm.list({ includeTerminal: false }).map(g => g.id), [b.id]);
});

test('snapshot/restore round-trips goals and the id sequence', () => {
  const gm = createGoalManager({ clock: fixedClock() });
  const a = gm.enqueue({ objective: 'a', plan: { objective: 'a', targets: {} } });
  gm.start(a.id); gm.suspend(a.id, 'pause');
  const snap = gm.snapshot();
  const restored = GoalManager.restore(snap);
  assert.equal(restored.get(a.id).status, GOAL_STATUS.SUSPENDED);
  assert.deepEqual(restored.get(a.id).plan, { objective: 'a', targets: {} });
  const next = restored.enqueue({ objective: 'next' });
  assert.equal(next.id, 'g2', 'sequence continues after restore');
});

test('persists through a repository (upsert/find) and hydrates a new instance', () => {
  const store = new JsonMemoryRepository({ dir: null });
  const gm = createGoalManager({ store, clock: fixedClock() });
  const a = gm.enqueue({ objective: 'a', source: GOAL_SOURCE.CHAT });
  gm.start(a.id); gm.complete(a.id, { steps: 1 });

  const reborn = createGoalManager({ store }).hydrate();
  assert.equal(reborn.get(a.id).status, GOAL_STATUS.COMPLETED);
  assert.deepEqual(reborn.get(a.id).result, { steps: 1 });
  assert.equal(reborn.seq, 1);
});

test('persists to a JSON repository on disk and reloads across instances', () => {
  const dir = mkdtempSync(join(tmpdir(), 'goals-'));
  try {
    const store = new JsonMemoryRepository({ dir, logger: null }).load();
    const gm = createGoalManager({ store });
    const a = gm.enqueue({ objective: 'shear a sheep', source: GOAL_SOURCE.CHAT });
    gm.start(a.id); gm.fail(a.id, 'no sheep');
    gm.flush();

    const reloaded = createGoalManager({ store: new JsonMemoryRepository({ dir, logger: null }) }).hydrate();
    assert.equal(reloaded.get(a.id).status, GOAL_STATUS.FAILED);
    assert.equal(reloaded.get(a.id).reason, 'no sheep');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
