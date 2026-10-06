// Deep Dark / stealth (W0+W1 di docs/raw/DEEP_DARK_ROADMAP.md): consapevolezza
// sculk e sneak verificato. Qui si prova il lato adapter: protezione dello scavo,
// rifiuto `vibration_risk_*`, censimento esposto da `/observe.sculk`, conteggio
// degli shriek, dichiarazione dello sneak sulla rete e misura della velocità.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

const require = createRequire(import.meta.url);
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer');
const serializer = createSerializer('1.26.51');
const parser = createDeserializer('1.26.51');

const solid = (name, extra = {}) => ({ name, boundingBox: 'block', diggable: true, hardness: 0.5, ...extra });
const air = { name: 'air', boundingBox: 'empty', diggable: false, hardness: 0 };

// Le celle sculk si costruiscono con l'oggetto proprietà *condiviso*: il test deve
// poter cambiare `active`/`sculk_sensor_phase` fra un censimento e l'altro.
function sensorAt (x, y, z, properties = { sculk_sensor_phase: 0 }) {
  return { name: 'sculk_sensor', position: { x, y, z }, properties, getProperties: () => properties };
}

function shriekerAt (x, y, z, properties = { active: 0, can_summon: 1 }) {
  return { name: 'sculk_shrieker', position: { x, y, z }, properties, getProperties: () => properties };
}

// Bot a (92.5, piedi 72, 148.5) rivolto a sud (+z): davanti un gradino scavabile.
// `loaded` è non vuoto perché un censimento appena connessi non è "pronto" e non
// deve produrre rifiuti (`ready: false` -> nessun `vibration_risk_*`).
function sculkAdapter ({ cells = [], blocks = {} } = {}) {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter._feet = { x: 92.5, y: 72, z: 148.5 };
  adapter.position = { x: 92.5, y: 73.62, z: 148.5 };
  adapter._lastYaw = 0;
  const map = {
    '92,73,149': air,
    '92,72,149': solid('dirt', { material: 'mineable/shovel' }),
    '92,71,149': solid('grass_block', { material: 'mineable/shovel', hardness: 0.6 }),
    '92,70,149': solid('dirt', { material: 'mineable/shovel' }),
    ...blocks,
  };
  const custom = new Map(cells.map(cell => [`${cell.position.x},${cell.position.y},${cell.position.z}`, cell]));
  adapter.world.loaded = new Set(['92,72,148']);
  adapter.world.blockAt = ({ x, y, z }) => custom.get(`${x},${y},${z}`) ?? map[`${x},${y},${z}`] ?? null;
  adapter.world.findBlocks = (names, point) => {
    const wanted = new Set(Array.isArray(names) ? names : [names]);
    return cells
      .filter(cell => wanted.has(cell.name))
      .map(cell => ({ ...cell, distance: +Math.hypot(cell.position.x - point.x, cell.position.y - point.y, cell.position.z - point.z).toFixed(2) }));
  };
  return { adapter, cells };
}

// Bot in fondo a una buca a piedi 68: davanti il gradino, sopra due blocchi da aprire.
function pitAdapter (cells = []) {
  const { adapter } = sculkAdapter({
    cells,
    blocks: {
      '92,67,148': solid('stone'),
      '92,68,149': solid('dirt', { material: 'mineable/shovel' }),
      '92,69,149': solid('dirt', { material: 'mineable/shovel' }),
      '92,70,149': solid('grass_block', { material: 'mineable/shovel', hardness: 0.6 }),
      '92,69,150': air,
      '92,70,150': air,
    },
  });
  adapter._feet = { x: 92.5, y: 68, z: 148.5 };
  adapter.position = { x: 92.5, y: 69.62, z: 148.5 };
  return adapter;
}

function adapterWithDecodedPackets () {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.position = { x: 78.5, y: 73.62, z: 159.5 };
  const packets = [];
  adapter.client = {
    write (name, params) {
      const buffer = serializer.createPacketBuffer({ name, params });
      packets.push(parser.parsePacketBuffer(buffer).data.params);
    },
  };
  return { adapter, packets };
}

test('the whole sculk family is protected from mining, not only the sensor', () => {
  const { adapter } = sculkAdapter();
  // Serve una posizione: un blocco senza posizione (unknown) resta protetto per
  // prudenza, quindi non prova nulla sul vocabolario.
  const at = name => ({ ...solid(name), position: { x: 5, y: 64, z: 5 } });
  for (const name of ['sculk', 'sculk_vein', 'sculk_catalyst', 'sculk_sensor', 'calibrated_sculk_sensor', 'sculk_shrieker']) {
    assert.equal(adapter._gatherProtected(at(name)), true, name);
  }
  assert.equal(adapter._gatherProtected(at('stone')), false);
  assert.equal(adapter._gatherProtected(at('dirt')), false);
  assert.equal(adapter._gatherProtected({ name: null }), true, 'non si scava ciò che non si sa');
});

test('dig_down refuses a block inside a sensor radius and allows it just outside', () => {
  const inside = sculkAdapter({ cells: [sensorAt(92, 72, 145)] });
  const plan = inside.adapter._digTargets();
  assert.equal(plan.error, 'vibration_risk_front');
  assert.equal(plan.sensors, 1);
  assert.deepEqual(plan.position, { x: 92, y: 72, z: 149 });
  assert.deepEqual(plan.nearest.position, { x: 92, y: 72, z: 145 });
  // A 9 blocchi il sensore non sente: la scala resta scavabile.
  const outside = sculkAdapter({ cells: [sensorAt(92, 72, 158)] });
  assert.equal(outside.adapter._digTargets().error, undefined);
});

test('a dig that would vibrate is refused before any block is mined', async () => {
  const { adapter } = sculkAdapter({ cells: [sensorAt(92, 72, 145)] });
  adapter._mineBlock = async () => assert.fail('nothing may be mined inside a sensor radius');
  const result = await adapter._digDown(1000);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'vibration_risk_front');
});

test('dig_up refuses the step inside a sensor radius', () => {
  const adapter = pitAdapter([sensorAt(92, 69, 151)]);
  const plan = adapter._upTargets();
  assert.equal(plan.error, 'vibration_risk_step');
  assert.equal(plan.sensors, 1);
  // Fuori raggio la risalita resta scavabile.
  const outside = pitAdapter([sensorAt(92, 69, 160)]);
  assert.equal(outside._upTargets().error, undefined);
});

test('an unloaded world does not invent a vibration refusal', () => {
  const { adapter } = sculkAdapter({ cells: [sensorAt(92, 72, 145)] });
  adapter.world.loaded = new Set();
  const view = adapter._sculkView();
  assert.equal(view.ready, false);
  assert.equal(view.vibrationRisk, null);
  assert.equal(adapter._vibrationRiskAt({ x: 92, y: 72, z: 149 }), null);
  assert.equal(adapter._digTargets().error, undefined, 'censimento non pronto: nessun rifiuto');
});

test('the sculk view reports sensors, shriekers, darkness and the risk on the bot', () => {
  const sensor = sensorAt(95, 72, 148, { sculk_sensor_phase: 1 });
  const shrieker = shriekerAt(100, 72, 148, { active: 0, can_summon: 1 });
  const inert = shriekerAt(101, 72, 148, { active: 0, can_summon: 0 });
  const { adapter } = sculkAdapter({ cells: [sensor, shrieker, inert] });
  const view = adapter._sculkView();
  assert.equal(view.ready, true);
  assert.equal(view.sensors, 1);
  assert.equal(view.shriekers, 2);
  assert.equal(view.shriekersCanSummon, 1);
  assert.equal(view.shriekersActive, 0);
  assert.equal(view.sensorRows[0].phase, 1);
  assert.equal(view.sensorRows[0].active, true);
  assert.equal(view.shriekerRows[0].canSummon, true);
  assert.equal(view.family.length, 6);
  assert.equal(view.darkness, false);
  assert.equal(view.warden.present, false);
  assert.equal(view.level, 0);
  assert.equal(view.warning.verdict, 'clear');
  assert.equal(view.vibrationRisk.count, 1, 'sensore inattivo a 3 blocchi: scavare lì vibra comunque');
  assert.deepEqual(view.sneak, { active: false, declared: false, last: null, route: null });
  // La vista dedicata può forzare il censimento; `family` è il vocabolario chiuso.
  assert.ok(view.scanned >= 3);
});

test('a shriek counts once and the level stays until the window decays', () => {
  const properties = { active: 1, can_summon: 1 };
  const shrieker = { name: 'sculk_shrieker', position: { x: 96, y: 72, z: 148 }, getProperties: () => properties };
  const { adapter } = sculkAdapter({ cells: [shrieker] });
  const first = adapter._sculkCensus({ force: true });
  assert.equal(first.level, 1);
  assert.equal(first.warning.verdict, 'warning');
  assert.equal(first.shriekerRows[0].active, true);
  // Finché resta attivo non si somma due volte.
  assert.equal(adapter._sculkCensus({ force: true }).level, 1);
  // Quando smette, lo shriek è consumato ma il livello resta nella finestra.
  properties.active = 0;
  const after = adapter._sculkCensus({ force: true });
  assert.equal(after.level, 1);
  assert.equal(after.shriekerRows[0].active, false);
  assert.equal(after.warning.verdict, 'warning');
  assert.equal(after.warning.maySummon, false);
});

test('three shriekers at once are a summon, and the warden is reported', () => {
  const cells = [shriekerAt(96, 72, 148, { active: 1 }), shriekerAt(97, 72, 148, { active: 1 }), shriekerAt(98, 72, 148, { active: 1 })];
  const { adapter } = sculkAdapter({ cells });
  adapter.entities.set(7, { runtimeId: 7, type: 'warden', position: { x: 92.5, y: 73.62, z: 160.5 }, health: 500 });
  const view = adapter._sculkView({ force: true });
  assert.equal(view.level, 3);
  assert.equal(view.warning.verdict, 'summoned');
  assert.equal(view.warning.maySummon, true);
  assert.equal(view.warden.present, true);
  assert.equal(view.warden.distance, 12);
  assert.equal(view.warden.health, 500);
});

test('a stealth walk declares sneaking on the wire, with the transitions once', () => {
  const { adapter, packets } = adapterWithDecodedPackets();
  adapter._beginMotionTrack({ sneak: true });
  adapter._sendAuthInput();
  assert.deepEqual(packets[0].input_data.filter(flag => flag.includes('sneak')), ['sneaking', 'start_sneaking']);
  adapter._sendAuthInput();
  assert.deepEqual(packets[1].input_data.filter(flag => flag.includes('sneak')), ['sneaking']);
  adapter._endMotionTrack();
  adapter._sendAuthInput();
  assert.deepEqual(packets[2].input_data.filter(flag => flag.includes('sneak')), ['stop_sneaking']);
});

test('the motion track measures the server position and rejects a walk-speed sneak', () => {
  const { adapter } = sculkAdapter();
  const track = adapter._beginMotionTrack({ sneak: true });
  assert.equal(adapter._sneakView().active, true);
  assert.equal(adapter._sneakView().declared, false);
  track.at = Date.now() - 1000;
  for (const z of [148.5, 149.0, 149.5, 150.0]) {
    adapter.position = { x: 92.5, y: 73.62, z };
    adapter._sampleMotionTrack();
  }
  const slow = adapter._endMotionTrack();
  assert.equal(slow.ok, true);
  assert.equal(slow.sneak, true);
  assert.equal(slow.skipped, 0);
  assert.equal(adapter._sneakView().active, false);
  assert.deepEqual(adapter._sneakView().last, slow);
  assert.equal(adapter._endMotionTrack(), null, 'la chiusura è idempotente');
  // Il server può muovere a velocità di cammino anche se il client chiede sneak:
  // la misura lo scopre e l'esito diventa `not_sneaking`.
  const fast = adapter._beginMotionTrack({ sneak: true });
  fast.at = Date.now() - 1000;
  for (const z of [148.5, 149.5, 150.5, 151.5, 152.5]) {
    adapter.position = { x: 92.5, y: 73.62, z };
    adapter._sampleMotionTrack();
  }
  const verdict = adapter._endMotionTrack();
  assert.equal(verdict.ok, false);
  assert.equal(verdict.error, 'not_sneaking');
  assert.ok(verdict.mps > 2.6);
});

test('a teleport-sized jump is not counted as a silent step', () => {
  const { adapter } = sculkAdapter();
  const track = adapter._beginMotionTrack({ sneak: true });
  track.at = Date.now() - 1000;
  adapter.position = { x: 92.5, y: 73.62, z: 148.5 };
  adapter._sampleMotionTrack();
  adapter.position = { x: 92.5, y: 73.62, z: 200.5 };
  adapter._sampleMotionTrack();
  const result = adapter._endMotionTrack();
  assert.equal(result.skipped, 1);
  assert.equal(result.distanceM, null);
  assert.equal(result.error, 'no_measurement', 'nessun passo reale: nessun verdetto di silenzio');
});

test('sneak_to is refused as not_sneaking when the measured speed is too high', async () => {
  const { adapter } = sculkAdapter();
  adapter.plan = { waypoint: { x: 100, y: 72, z: 148 } };
  const calls = [];
  let measured = { ok: false, error: 'not_sneaking', mps: 4.317 };
  adapter._moveTo = async (target, stop, timeout, options) => {
    calls.push({ target, stop, timeout, options });
    adapter._lastSneak = measured;
    return { ok: true, distance: 8 };
  };
  const refused = await adapter._runAction('sneak_to');
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'not_sneaking');
  assert.equal(refused.measured.mps, 4.317);
  assert.equal(calls[0].options.sneak, true);
  assert.deepEqual(calls[0].target, { x: 100, y: 72, z: 148 });
  assert.equal(calls[0].stop, 2);
  measured = { ok: true, error: null, mps: 1.3 };
  const silent = await adapter._runAction('sneak_to');
  assert.equal(silent.ok, true);
  assert.equal(silent.sneak.mps, 1.3);
});

test('sneak_to refuses while riding instead of walking the mount', async () => {
  const { adapter } = sculkAdapter();
  adapter.plan = { waypoint: { x: 100, y: 72, z: 148 } };
  adapter.riding = { runtimeId: 1 };
  adapter._moveTo = async () => assert.fail('must not walk while riding');
  const result = await adapter._runAction('sneak_to');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'riding');
});

test('the silent variant is offered next to goto_waypoint', () => {
  const { adapter } = sculkAdapter();
  adapter.plan = { waypoint: { x: 100, y: 72, z: 148 } };
  const options = adapter.options();
  const keys = options.map(option => option.key);
  assert.ok(keys.includes('goto_waypoint'));
  assert.ok(keys.includes('sneak_to'));
  assert.ok(keys.includes('walk_stealthy'), 'W2: la rotta silenziosa si può chiedere per nome');
  const stealthy = options.find(option => option.key === 'walk_stealthy');
  assert.match(stealthy.description, /no_stealth_route/, 'la descrizione dice come si rifiuta');
  adapter.plan = null;
  assert.ok(!adapter.options().map(option => option.key).includes('sneak_to'));
});

// ---- W2: rotta silenziosa ----------------------------------------------------
// Il mondo finto di `sculkAdapter` non ha una topologia: per provare la *catena*
// (censimento -> costo -> piano -> risultato) si sostituiscono `_neighbors` e
// `_findGoalNodes` con una corsia, e `_startMotion` con un movimento che arriva.
// Così il test dice se il piano è silenzioso, non se il server sa camminare.
function stealthLane ({ sensors = [] } = {}) {
  const { adapter } = sculkAdapter({ cells: sensors });
  adapter.client = {};
  adapter._authTickInterval = 1;
  adapter._startNode = () => ({ x: 92, y: 72, z: 148 });
  adapter._findGoalNodes = () => [{ x: 96, y: 72, z: 148 }];
  adapter._neighbors = node => [
    { x: node.x + 1, y: node.y, z: node.z, cost: 1 },
    { x: node.x - 1, y: node.y, z: node.z, cost: 1 },
  ].filter(cell => cell.x >= 92 && cell.x <= 96 && cell.z === 148);
  // Come il vero `_startMotion`: il tracciato vive dentro `_motion`, così
  // `_stopMotion` lo chiude e la misura arriva (qui: zero passi).
  adapter._startMotion = async function () { this._motion = { track: this._motionTrack, index: 0 }; return 'goal'; };
  return adapter;
}

test('walk_stealthy walks a planned route and carries the plan in the result', async () => {
  // Il sensore c'è ma è 28 blocchi sopra: nessuna cella della corsia è nella sfera.
  const adapter = stealthLane({ sensors: [sensorAt(95, 100, 148)] });
  adapter.plan = { waypoint: { x: 96, y: 72, z: 148 } };
  const result = await adapter._runAction('walk_stealthy');
  assert.equal(result.ok, true);
  assert.equal(result.stealth, true);
  assert.equal(result.plan.cells, 5, 'la corsia è lunga cinque celle');
  assert.equal(result.plan.maxRisk, 0);
  assert.equal(result.plan.sneak, true);
  assert.deepEqual(result.plan.from, { x: 92, y: 72, z: 148 });
  assert.deepEqual(result.plan.to, { x: 96, y: 72, z: 148 });
  assert.equal(result.plan.exit.cells, 5, 'il ritorno è pianificato, non sperato');
  assert.deepEqual(result.plan.exit.target, { x: 92, y: 72, z: 148 });
  // Nessun passo è stato misurato (`_startMotion` è finto): l'esito è un
  // successo di rotta, non una dichiarazione di silenzio.
  assert.equal(result.sneak.error, 'no_measurement');
  const view = adapter._sneakView();
  assert.equal(view.route.cells, 5);
  assert.equal(view.route.maxRisk, 0);
  assert.equal(view.route.exit.cells, 5);
  assert.equal(view.active, false, 'il tracciato è chiuso a fine movimento');
});

test('walk_stealthy refuses the whole walk when the lane crosses a sensor sphere', async () => {
  const adapter = stealthLane({ sensors: [sensorAt(95, 72, 148)] });
  adapter.plan = { waypoint: { x: 96, y: 72, z: 148 } };
  adapter._startMotion = async () => assert.fail('una rotta rumorosa non si cammina');
  const result = await adapter._runAction('walk_stealthy');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no_stealth_route');
  assert.equal(adapter._stealthRouteView(), null, 'nessuna rotta da ripercorrere: non se ne è accettata una');
});

test('a stealth route is not promised on a world that was never scanned', async () => {
  const adapter = stealthLane({ sensors: [sensorAt(95, 72, 148)] });
  adapter.world.loaded = new Set();
  adapter.plan = { waypoint: { x: 96, y: 72, z: 148 } };
  adapter._startMotion = async () => assert.fail('senza censimento non si promette silenzio');
  const result = await adapter._runAction('sneak_to');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'sculk_unknown');
});

test('placing inside a sensor sphere is refused, and the refusal is the vibration one', async () => {
  const { adapter } = sculkAdapter({ cells: [sensorAt(92, 72, 145)] });
  const clickPos = { x: 0.5, y: 1, z: 0.5 };
  const support = { x: 92, y: 71, z: 148 };
  const risky = await adapter._placeAtCell('torch', 'torch', { x: 92, y: 72, z: 148 }, support, 1, clickPos, { projectId: 'test' });
  assert.equal(risky.ok, false);
  assert.equal(risky.error, 'vibration_risk_place');
  assert.equal(risky.sensors, 1);
  assert.deepEqual(risky.position, { x: 92, y: 72, z: 148 });
  // Stessa chiamata, ma il rischio è dichiarato accettato: si arriva al
  // controllo successivo, quindi il rifiuto di prima era davvero la vibrazione.
  const allowed = await adapter._placeAtCell('torch', 'torch', { x: 92, y: 72, z: 148 }, support, 1, clickPos, { projectId: 'test', allowVibrationRisk: true });
  assert.equal(allowed.error, 'construction_inventory_stale');
  // E fuori dalla sfera non c'è nessun rifiuto di vibrazione.
  const outside = await adapter._placeAtCell('torch', 'torch', { x: 92, y: 72, z: 160 }, support, 1, clickPos, { projectId: 'test' });
  assert.equal(outside.error, 'construction_inventory_stale');
});

test('mining picks a silent target, and names the noisy one when there is no choice', async () => {
  const ore = position => ({ ...solid('diamond_ore'), name: 'diamond_ore', position });
  const noisy = ore({ x: 92, y: 72, z: 149 });
  const quiet = ore({ x: 92, y: 72, z: 152 });
  // Fuori dalla sfera, a portata e senza sensori: si sceglie quello.
  const near = sculkAdapter({ cells: [quiet] }).adapter;
  assert.equal(near._pickMineTarget([quiet]), quiet, 'silenzioso e a portata: si scava');
  // Dentro la sfera: il bersaglio rumoroso non si sceglie mai.
  const { adapter } = sculkAdapter({ cells: [sensorAt(92, 72, 145)] });
  assert.equal(adapter._pickMineTarget([noisy]), null);
  const blocked = adapter._vibrationBlockedTarget([noisy]);
  assert.equal(blocked.block, 'diamond_ore');
  assert.equal(blocked.sensors, 1);
  assert.deepEqual(blocked.position, { x: 92, y: 72, z: 149 });
  // E l'azione dice *perché* non c'è un bersaglio, invece di "non trovato".
  const caused = sculkAdapter({ cells: [sensorAt(92, 72, 145), noisy] }).adapter;
  caused._mineBlock = async () => assert.fail('nulla si scava dentro la sfera');
  const result = await caused._runAction('mine_diamond_ore');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'vibration_risk_mine: diamond_ore at 92,72,149 (1 sculk sensor(s) in range)');
});
