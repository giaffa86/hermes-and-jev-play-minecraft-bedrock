import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SWEEP_STOP, planExplorationSweep, nextExplorationWaypoint, chunkKey,
} from '../exploration.mjs';

// Il primo milestone del gradino 4: stessa ancorata + visited + config ⇒ stesso
// prossimo waypoint e stessa causa di stop, anche dopo serializzazione/reload.

const ANCHOR = { x: 200, y: 73, z: -40 };

test('same anchor, visited and config produce the same plan (and survive a reload)', () => {
  const config = { spacing: 16, maxRadius: 2, cells: 3, radius: null };
  const visited = [chunkKey(200, -40)];
  const first = planExplorationSweep({ anchor: ANCHOR, visited, ...config });
  const second = planExplorationSweep({ anchor: ANCHOR, visited, ...config });
  assert.deepEqual(second, first);

  // Lo stato che il chiamante persiste è solo (anchor, visited, config): la
  // serializzazione non deve cambiare né il prossimo waypoint né la causa di stop.
  const reloaded = JSON.parse(JSON.stringify({ anchor: ANCHOR, visited, ...config }));
  const after = planExplorationSweep(reloaded);
  assert.deepEqual(after, first);
  assert.deepEqual(after.next, first.next);
  assert.equal(after.stoppedBy, first.stoppedBy);
});

test('the geometric bound is anchored, not relative to the bot', () => {
  // spacing 16, raggio 20: il centro (0) e i quattro ortogonali dell'anello 1
  // (16) sono dentro, le quattro diagonali (22.63) fuori.
  const plan = planExplorationSweep({ anchor: ANCHOR, spacing: 16, maxRadius: 1, radius: 20 });
  assert.equal(plan.planned, 5);
  assert.deepEqual(plan.waypoints[0], { x: 200, z: -40, distance: 0 });
  for (const w of plan.waypoints) assert.ok(w.distance <= 20, `waypoint fuori raggio: ${JSON.stringify(w)}`);
  assert.ok(!plan.waypoints.some(w => w.x !== 200 && w.z !== -40), 'le diagonali non entrano nel raggio');
  assert.equal(plan.stoppedBy, SWEEP_STOP.RADIUS);
  assert.equal(plan.truncated, true);
  assert.equal(plan.boundary.pendingBeyond, 4, 'le quattro diagonali restano fuori');
  assert.equal(plan.boundary.maxDistance, 20);
});

test('the cell budget truncates the walk and says so', () => {
  const plan = planExplorationSweep({ anchor: ANCHOR, spacing: 16, maxRadius: 2, cells: 2 });
  assert.equal(plan.planned, 2);
  assert.equal(plan.remaining, 0);
  assert.equal(plan.truncated, true);
  assert.equal(plan.stoppedBy, SWEEP_STOP.CELLS);
  assert.equal(plan.boundary, null, 'nessun raggio configurato');
});

test('a spiral with nothing left is exhausted, not truncated', () => {
  const plan = planExplorationSweep({ anchor: ANCHOR, spacing: 16, maxRadius: 0, visited: [chunkKey(200, -40)] });
  assert.deepEqual(plan.waypoints, []);
  assert.equal(plan.next, null);
  assert.equal(plan.planned, 0);
  assert.equal(plan.truncated, false);
  assert.equal(plan.stoppedBy, SWEEP_STOP.EXHAUSTED);
  assert.equal(plan.complete, true);
});

test('an exhausted spiral inside the radius is still a radius stop when work remains outside', () => {
  const plan = planExplorationSweep({ anchor: ANCHOR, spacing: 16, maxRadius: 1, radius: 20, visited: [chunkKey(200, -40), chunkKey(216, -40), chunkKey(184, -40), chunkKey(200, -24), chunkKey(200, -56)] });
  assert.deepEqual(plan.waypoints, []);
  assert.equal(plan.stoppedBy, SWEEP_STOP.RADIUS);
  assert.equal(plan.boundary.pendingBeyond, 4);
});

test('the single-step planner is the same spiral with no bound', () => {
  const visited = [chunkKey(200, -40)];
  const sweep = planExplorationSweep({ anchor: ANCHOR, visited, spacing: 96, maxRadius: 4, cells: 1 });
  const step = nextExplorationWaypoint({ origin: ANCHOR, visited, spacing: 96, maxRadius: 4 });
  assert.deepEqual(sweep.next, { ...step, distance: sweep.next.distance });
  assert.deepEqual({ x: sweep.next.x, z: sweep.next.z }, step);
});

test('the walk keeps the spiral order instead of sorting by distance', () => {
  const plan = planExplorationSweep({ anchor: { x: 0, y: 64, z: 0 }, spacing: 96, maxRadius: 1, cells: 3 });
  assert.deepEqual(plan.waypoints.map(w => [w.x, w.z]), [[0, 0], [-96, -96], [0, -96]]);
});

test('visited accepts a Set, the shape the harness reads from memory', () => {
  const plan = planExplorationSweep({ anchor: ANCHOR, spacing: 16, maxRadius: 0, visited: new Set([chunkKey(200, -40)]) });
  assert.equal(plan.planned, 0);
  assert.equal(plan.stoppedBy, SWEEP_STOP.EXHAUSTED);
});

test('no anchor is a refusal, not a truncated census', () => {
  const plan = planExplorationSweep({ visited: [] });
  assert.equal(plan.ok, false);
  assert.equal(plan.error, 'no_anchor');
  assert.equal(plan.truncated, false);
  assert.equal(plan.stoppedBy, null);
  assert.deepEqual(plan.waypoints, []);
});
