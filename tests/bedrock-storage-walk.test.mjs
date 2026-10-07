import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

// 07/10/2026: un `take_*` da memoria è finito `movement timeout` dopo 75 s di
// budget avendo percorso 1,5 blocchi netti, a 6,8 blocchi dal baule. Il verdetto
// `stuck` per-waypoint non era mai scattato (bastava un nuovo minimo di pochi
// centimetri verso il prossimo nodo per azzerare `lastProgressAt`), e il
// fallimento non diceva dove il bot si era fermato. Questi test tengono fermi i
// due pezzi: il watchdog sul bersaglio e il dettaglio nel payload.

function adapter () {
  const a = new BedrockAdapter({ logger: { log () {} } });
  a.spawned = true;
  a.status = 'spawned';
  a.client = { write: () => {} };
  a.position = { x: 0, y: 64, z: 0 };
  a._feet = { x: 0, y: 64, z: 0 };
  a._authTickInterval = 1;
  a._maybeRememberDiscoveries = () => {};
  return a;
}

function walkingMotion (overrides = {}) {
  return {
    active: true, forward: true, yaw: 0, jumpQueued: false, jumpHeldTicks: 0, jumpStart: false,
    index: 0, path: [{ x: 0, y: 64, z: 0 }, { x: 10, y: 64, z: 0 }],
    stopDistance: 0.4, deadline: Date.now() + 60000, arrivalVerticalTolerance: 3,
    bestWaypointDist: Infinity, lastProgressAt: Date.now(), stuckTries: 0,
    bestTargetDist: Infinity, lastTargetProgressAt: Date.now(),
    ...overrides,
  };
}

test('a walk that stops closing in on the target ends as no_progress', () => {
  const a = adapter();
  let outcome = null;
  a._motion = walkingMotion({
    target: { x: 10.5, y: 64, z: 0.5 },
    bestTargetDist: 5, lastTargetProgressAt: Date.now() - 9000,
    resolve: reason => { outcome = reason; },
  });
  a._updateMotionState();
  assert.equal(outcome, 'no_progress', 'dieci secondi senza avvicinarsi non sono un movimento');
  assert.equal(a._motion.active, false);
});

test('a walk that keeps closing in on the target is left alone', () => {
  const a = adapter();
  a._motion = walkingMotion({
    target: { x: 2.5, y: 64, z: 0.5 },
    bestTargetDist: 5, lastTargetProgressAt: Date.now() - 9000,
  });
  a._motion.target = { x: 2.5, y: 64, z: 0.5 };
  a._feet = { x: 0, y: 64, z: 0 };
  a._updateMotionState();
  assert.equal(a._motion.active, true, 'avvicinarsi al bersaglio è progresso, anche dopo otto secondi');
  assert.equal(a._motion.bestTargetDist, Math.hypot(2.5, 0.5), 'il nuovo minimo si ricorda');
});

test('three stalls close a walk as stuck instead of spending the whole budget', async () => {
  const a = adapter();
  a._startNode = () => ({ x: 0, y: 64, z: 0 });
  a._findGoalNodes = () => [{ x: 10, y: 64, z: 0 }];
  a._findPath = () => [{ x: 0, y: 64, z: 0 }, { x: 10, y: 64, z: 0 }];
  let motions = 0;
  a._startMotion = async () => { motions++; return 'no_progress'; };
  const started = Date.now();
  await assert.rejects(
    a._moveTo({ x: 10.5, y: 64, z: 0.5 }, 1, 75000),
    error => {
      assert.equal(error.message, 'stuck', 'il verdetto è `stuck`, non `movement timeout`');
      assert.equal(error.details.outcome, 'no_progress');
      assert.equal(error.details.stalled, true);
      assert.deepEqual(error.details.target, { x: 10.5, y: 64, z: 0.5 });
      return true;
    },
  );
  assert.equal(motions, 3, 'tre tratti fermi di fila, non un budget intero');
  assert.ok(Date.now() - started < 5000, 'il verdetto arriva subito');
});

test('an exhausted budget is still a movement timeout, with its detail', async () => {
  const a = adapter();
  a._startNode = () => ({ x: 0, y: 64, z: 0 });
  a._findGoalNodes = () => [{ x: 10, y: 64, z: 0 }];
  a._findPath = () => [{ x: 0, y: 64, z: 0 }, { x: 10, y: 64, z: 0 }];
  a._startMotion = async () => 'timeout';
  await assert.rejects(
    a._moveTo({ x: 10.5, y: 64, z: 0.5 }, 1, 75000),
    error => {
      assert.equal(error.message, 'movement timeout');
      assert.equal(error.details.progressed, false, 'fermo sul posto: nessun progresso');
      assert.deepEqual(error.details.from, { x: 0, y: 64, z: 0 });
      return true;
    },
  );
});

test('a refused storage walk writes where it stopped into storage_open_failure', async () => {
  const a = adapter();
  const events = [];
  a.onLog = entry => events.push(entry);
  a._openStorageWindow = async () => {
    const error = new Error('movement timeout');
    error.details = { from: { x: 0, y: 64, z: 0 }, position: { x: 0, y: 64, z: 1.5 }, pathNodes: 12, reachedWaypoints: 1, progressed: false };
    throw error;
  };
  const target = { name: 'chest', position: { x: 90, y: 72, z: 160 } };
  await assert.rejects(a._ensureStorageOpen(target), /movement timeout/);
  const failure = events.find(event => event.type === 'storage_open_failure');
  assert.ok(failure, 'il fallimento si registra');
  assert.equal(failure.block, 'chest');
  assert.equal(failure.details.position.x, 0, 'il payload dice dove il bot si è fermato');
  assert.equal(failure.details.progressed, false);
});

test('a refused action carries the walk detail in its result', async () => {
  const a = adapter();
  a._equipArmor = async () => {
    const error = new Error('movement timeout');
    error.details = { position: { x: 3, y: 64, z: 3 }, progressed: false };
    throw error;
  };
  const result = await a.executeAction('equip_armor');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'movement timeout');
  assert.equal(result.details.progressed, false, 'un /act rifiutato dice dove, non solo come');
  assert.deepEqual(result.details.position, { x: 3, y: 64, z: 3 });
});
