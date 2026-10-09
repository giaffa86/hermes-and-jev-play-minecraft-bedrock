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

test('un tratto che si allontana dal bersaglio per prendere la porta non è no_progress', () => {
  // 08/10/2026: uscendo da casa per seguire il giocatore il bot doveva prima
  // puntare alla porta (che stava *dietro* al bersaglio) e il watchdog del
  // bersaglio chiudeva il tratto come `no_progress` dopo 8 s mentre il percorso
  // avanzava regolarmente. Un nodo di percorso superato è progresso: il tratto
  // non si chiude finché il percorso avanza.
  const a = adapter();
  a._motion = walkingMotion({
    target: { x: 10.5, y: 64, z: 0.5 },
    bestTargetDist: 5, lastTargetProgressAt: Date.now() - 9000,
    lastIndexProgressAt: Date.now() - 200,
  });
  a._feet = { x: 0, y: 64, z: 0 };
  a._updateMotionState();
  assert.equal(a._motion.active, true, 'il nodo superato è progresso');
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

test('a refused storage walk writes where it stopped, and does not hide the container', async () => {
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
  const failure = events.find(event => event.type === 'storage_approach_failure');
  assert.ok(failure, `il fallimento del cammino si registra: ${events.map(e => e.type).join(', ')}`);
  assert.equal(failure.block, 'chest');
  assert.equal(failure.details.position.x, 0, 'il payload dice dove il bot si è fermato');
  assert.equal(failure.details.progressed, false);
  // 08/10/2026: un `movement timeout` non è una memoria sbagliata — metteva il
  // baule in cooldown per dieci minuti (`container_read_skipped` 17 volte nel
  // run della spedizione) mentre il cammino del tentativo dopo poteva riuscire.
  assert.equal(a._inOpenFailureCooldown(target.position), false, 'il baule resta offribile');
});

test('the sightline does not call the target block itself an obstruction', () => {
  const a = adapter();
  a.position = { x: 0.5, y: 65.62, z: 0.5 };
  // Live 08/10/2026: il payload diceva `["air","chest!","chest!"]` su un baule a
  // 1,8 blocchi e la lettura si ri-avvicinava a 1,5 per un muro che non c'era.
  a.world.blockAt = cell => (cell.x >= 2 ? { name: 'chest' } : { name: 'air' });
  const target = { x: 2, y: 65, z: 0 };
  const clear = a._sightlineTo({ x: 2.5, y: 65.5, z: 0.5 }, target);
  assert.ok(clear.includes('chest'), `il baule si vede: ${clear.join(',')}`);
  assert.ok(!clear.some(sample => sample.endsWith('!')), `il bersaglio solido non è un muro: ${clear.join(',')}`);
  // Un muro *prima* del baule resta un'ostruzione.
  a.world.blockAt = cell => (cell.x >= 2 ? { name: 'chest' } : cell.x >= 1 ? { name: 'oak_planks' } : { name: 'air' });
  const blocked = a._sightlineTo({ x: 2.5, y: 65.5, z: 0.5 }, target);
  assert.ok(blocked.some(sample => sample.endsWith('!')), `un muro davanti resta segnalato: ${blocked.join(',')}`);
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

// 08/10/2026: per 70 minuti ogni apertura di baule e' finita
// `container_open_timeout` — anche con il bot a 1,1 blocchi dallo scrigno — e
// l'artefatto diceva solo quello. Due cose sono cambiate: l'apertura cammina
// finche' il contenitore non e' addosso (non si ferma a tre blocchi) e il
// fallimento porta con se' che cosa il client credeva di cliccare.
test('opening a chest walks up to two blocks and reports every attempt', async () => {
  const a = adapter();
  a._reachabilityUsable = () => false;
  const walks = [];
  a._moveTo = async (target, radius, timeoutMs) => { walks.push({ target, radius, timeoutMs }); return { ok: true }; };
  let opens = 0;
  a._queueAuthInput = async () => { opens++; };
  a._waitForContainerOpen = () => {
    // Come l'adapter vero: la promise della finestra si rigetta una volta sola e
    // qualcuno la ascolta, altrimenti il test muore di unhandled rejection.
    const pending = Promise.reject(new Error('container_open_timeout'));
    pending.catch(() => {});
    return pending;
  };
  const events = [];
  a.onLog = entry => events.push(entry);
  const target = { name: 'chest', position: { x: 2, y: 64, z: 0 }, distance: 12 };
  await assert.rejects(
    a._openStorageWindow(target, { walkTimeoutMs: 15000 }),
    error => {
      assert.equal(error.message, 'container_open_timeout', 'il rifiuto del server resta quello vero');
      assert.equal(error.details.attempts.length, 3, 'tre tentativi, tutti dichiarati');
      assert.equal(error.details.attempts[0].block, 'block_unknown', 'il blocco non noto e scritto, non taciuto');
      assert.equal(typeof error.details.attempts[0].distance, 'number');
      assert.equal(typeof error.details.attempts[0].held, 'object');
      return true;
    },
  );
  assert.equal(walks[0].radius, 2, 'il contenitore si apre da addosso');
  assert.equal(opens, 3, 'un click per tentativo');
  assert.deepEqual(walks[0].target, { x: 2.5, y: 64, z: 0.5 });
  assert.ok(events.some(event => event.type === 'container_open_failed'), 'il fallimento finale si registra con i tentativi');
});

// Live 08/10/2026, tentativo 16: il tratto si spostava di mezzo blocco in tondo
// senza avvicinarsi al bersaglio, quindi `attempts` tornava a zero a ogni giro e
// il bot rigirava su se stesso fino a consumare i 45 s del budget in `movement
// timeout` (`progressed: false`, nessun verdetto interno).
test('un tratto che sposta il bot senza avvicinarlo non azzera il contatore', async () => {
  const a = adapter();
  a._startNode = () => ({ x: 0, y: 64, z: 0 });
  a._findGoalNodes = () => [{ x: 10, y: 64, z: 0 }];
  a._findPath = () => [{ x: 0, y: 64, z: 0 }, { x: 10, y: 64, z: 0 }];
  let motions = 0;
  a._startMotion = async () => {
    motions++;
    a._feet = { x: 0, y: 64, z: motions % 2 ? 0.5 : 0 };
    return 'stuck';
  };
  await assert.rejects(
    a._moveTo({ x: 10.5, y: 64, z: 0.5 }, 1, 75000),
    error => {
      assert.equal(error.message, 'stuck', 'il verdetto arriva prima del budget, non come `movement timeout`');
      assert.equal(error.details.outcome, 'stuck');
      return true;
    },
  );
  assert.ok(motions <= 5, `pochi tratti di fila, non un budget intero (${motions})`);
});
