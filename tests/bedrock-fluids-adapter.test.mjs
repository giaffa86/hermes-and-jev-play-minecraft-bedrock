// Fluidi (M0 di docs/wiki/fluids.md) nell'adapter: stato delle celle del bot,
// censimento di acqua/lava, fuga dalla lava e rifiuto degli scavi che aprirebbero
// un varco verso un fluido. Mondo finto, nessun socket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

const air = { name: 'air', boundingBox: 'empty', diggable: false, hardness: 0 };
const water = { name: 'water', boundingBox: 'empty', diggable: false, hardness: 0 };
const lava = { name: 'lava', boundingBox: 'empty', diggable: false, hardness: 0 };
const solid = (name = 'stone', extra = {}) => ({ name, boundingBox: 'block', diggable: true, hardness: 0.5, ...extra });

// Mondo finto: un piano di pietra con tre celle d'aria sopra (`floor` = semi-lato,
// 0 = nessun piano), più le celle passate esplicitamente. `findBlocks` filtra per
// nome dentro il raggio, come il mondo vero.
function fluidAdapter (cells = {}, { feet = { x: 0.5, y: 71, z: 0.5 }, floor = 6 } = {}) {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter._feet = { ...feet };
  adapter.position = { x: feet.x, y: feet.y + 1.62, z: feet.z };
  adapter._lastYaw = 0;
  adapter.nearbyBlocks = {};
  adapter.inventory = {};
  // Il mondo finto ha i chunk che definisce: senza questo il censimento si
  // dichiarerebbe "non pronto" (nessuna colonna caricata).
  adapter.world.loaded = new Map([['0,0', {}]]);
  const blocks = new Map();
  if (floor > 0) {
    for (let x = -floor; x <= floor; x++) {
      for (let z = -floor; z <= floor; z++) {
        for (let y = 71; y <= 73; y++) blocks.set(`${x},${y},${z}`, air);
        blocks.set(`${x},70,${z}`, solid());
      }
    }
  }
  for (const [key, block] of Object.entries(cells)) blocks.set(key, block);
  adapter.world.blockAt = ({ x, y, z }) => blocks.get(`${x},${y},${z}`) ?? null;
  adapter.world.findBlocks = (name, position, radius = 32, limit = 256) => {
    // Nessuna colonna caricata ⇒ nessun blocco: è quello che fa il mondo vero.
    if (adapter.world.loaded?.size === 0) return [];
    const out = [];
    for (const [key, block] of blocks) {
      if (block?.name !== name) continue;
      const [x, y, z] = key.split(',').map(Number);
      if (Math.hypot(x - position.x, y - position.y, z - position.z) > radius) continue;
      out.push({ name, position: { x, y, z } });
      if (out.length >= limit) break;
    }
    return out;
  };
  return { adapter, blocks };
}

test('_fluidsView legge le celle del bot e il censimento, senza inventare l\'annegamento', () => {
  const { adapter } = fluidAdapter({ '0,71,0': water, '0,72,0': water, '6,71,0': lava });
  const view = adapter._fluidsView();
  assert.equal(view.inWater, true);
  assert.equal(view.headInWater, true);
  assert.equal(view.inLava, false);
  assert.equal(view.water.count, 2);
  assert.equal(view.lava.count, 1);
  assert.equal(view.lavaDistance, 5.5, 'distanza dai piedi del bot');
  assert.equal(view.air, 300, 'il budget d\'aria è simulato: il server non lo espone');
  assert.equal(view.airSource, 'simulated');
  assert.equal(view.hazard.level, 'medium', 'la lava a 6 blocchi pesa più dell\'essere bagnati');
  assert.deepEqual(view.hazard.reasons, ['lava_in_range', 'head_underwater', 'in_water']);
});

test('_standable rifiuta le celle adiacenti alla lava e il censimento è in cache', () => {
  const { adapter } = fluidAdapter({ '1,71,0': lava });
  assert.equal(adapter._standable(0, 71, 0), false, 'lava in orizzontale ai piedi');
  assert.equal(adapter._standable(0, 71, 2), true, 'a due blocchi di distanza la cella resta valida');
  const first = adapter._fluidCensus();
  assert.equal(adapter._fluidCensus(), first, 'censimento riusato dal TTL');
  const forced = adapter._fluidCensus({ force: true });
  assert.notEqual(forced, first);
  assert.equal(forced.scanned, first.scanned);
});

test('la lava vicina offre avoid_lava, senza lava non compare', () => {
  const near = fluidAdapter({ '4,71,0': lava }).adapter;
  const threat = near._lavaThreat();
  assert.deepEqual(threat.position, { x: 4, y: 71, z: 0 });
  assert.equal(threat.distance, 3.5);
  const keys = near.options().map(o => o.key);
  assert.ok(keys.includes('avoid_lava'), 'avoid_lava offerto con la lava a 4 blocchi');
  assert.match(near.options().find(o => o.key === 'avoid_lava').description, /lava at \{"x":4,"y":71,"z":0\}/);

  const none = fluidAdapter({}).adapter;
  assert.equal(none._lavaThreat(), null);
  assert.ok(!none.options().map(o => o.key).includes('avoid_lava'));
});

test('_avoidLava sceglie la cella che guadagna più distanza e si allontana davvero', async () => {
  const { adapter } = fluidAdapter({ '2,71,0': lava });
  const moved = [];
  adapter._moveTo = async (cell) => {
    moved.push(cell);
    adapter._feet = { ...cell };
    adapter.position = { x: cell.x, y: cell.y + 1.62, z: cell.z };
  };
  const result = await adapter._avoidLava();
  assert.equal(result.ok, true);
  assert.equal(result.moved, true);
  assert.ok(result.gain > 0, `guadagno atteso positivo, ricevuto ${result.gain}`);
  assert.equal(moved.length, 1);
  assert.ok(moved[0].x < 0, `la fuga va in -x (cella ${JSON.stringify(moved[0])})`);
  assert.ok(result.lavaDistance > 5, `distanza finale ${result.lavaDistance}`);
  // Senza lava nei paraggi non si muove nulla.
  const quiet = fluidAdapter({}).adapter;
  let calls = 0;
  quiet._moveTo = async () => { calls++; };
  assert.deepEqual(await quiet._avoidLava(), { ok: true, moved: false, reason: 'no_lava_nearby' });
  assert.equal(calls, 0);
});

test('_avoidLava fallisce in modo tipizzato se ogni cella è accanto alla lava', async () => {
  // Pozza di lava che circonda l'unica cella calpestabile: non esiste una fuga.
  const cells = {
    '0,71,0': air,
    '0,70,0': solid(),
  };
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
    cells[`${dx},71,${dz}`] = lava;
  }
  const { adapter } = fluidAdapter(cells, { floor: 0 });
  let calls = 0;
  adapter._moveTo = async () => { calls++; };
  const result = await adapter._avoidLava();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no_safe_cell');
  assert.deepEqual(result.lava, { x: 1, y: 71, z: 0 }, 'la lava più vicina è quella adiacente');
  assert.ok(result.distance <= 1.5, `distanza ${result.distance}`);
  assert.equal(calls, 0, 'nessun movimento tentato');
});

test('_digTargets rifiuta lo scavo accanto alla lava (M0: mai aprirsi un varco)', () => {
  const { adapter } = fluidAdapter({
    '0,72,1': air,
    '0,71,1': solid('dirt', { material: 'mineable/shovel' }),
    '0,70,1': solid('dirt', { material: 'mineable/shovel' }),
    '1,71,1': lava,
  });
  const plan = adapter._digTargets();
  assert.equal(plan.error, 'unsafe_lava_adjacent_front');
  assert.equal(plan.block, 'lava');
  assert.deepEqual(plan.position, { x: 1, y: 71, z: 1 });
});

test('_upTargets rifiuta lo scavo quando adiacente c\'è acqua (allagherebbe il buco)', () => {
  const { adapter } = fluidAdapter({
    '0,72,1': solid('dirt', { material: 'mineable/shovel' }),
    '0,73,1': solid('dirt', { material: 'mineable/shovel' }),
    '1,72,1': water,
  });
  const plan = adapter._upTargets();
  assert.equal(plan.error, 'unsafe_water_adjacent_step');
  assert.equal(plan.block, 'water');
  assert.deepEqual(plan.position, { x: 1, y: 72, z: 1 });
});

test('_digTargets resta invariato quando nessuna cella adiacente è un fluido', () => {
  const { adapter } = fluidAdapter({
    '0,72,1': air,
    '0,71,1': solid('dirt', { material: 'mineable/shovel' }),
    '0,70,1': solid('dirt', { material: 'mineable/shovel' }),
    '0,69,1': solid('dirt', { material: 'mineable/shovel' }),
  });
  const plan = adapter._digTargets();
  assert.equal(plan.error, undefined);
  assert.deepEqual(plan.targets.map(t => t.label), ['front', 'step']);
});

test('un mondo senza chunk caricati non viene dichiarato "senza lava"', () => {
  const { adapter } = fluidAdapter({ '2,71,0': lava });
  adapter.world.loaded = new Map(); // appena connessi: nessuna colonna caricata
  const cold = adapter._fluidCensus();
  assert.equal(cold.ready, false);
  assert.equal(cold.scanned, 0);
  assert.equal(adapter._lavaThreat(), null, 'un mondo non ancora guardato non è un mondo senza lava');
  assert.equal(adapter._fluidsView().ready, false);

  // Il censimento non è stato messo in cache: al primo chunk caricato si rifà.
  adapter.world.loaded = new Map([['0,0', true]]);
  const warm = adapter._fluidCensus();
  assert.notEqual(warm, cold);
  assert.equal(warm.ready, true);
  assert.equal(warm.lava.count, 1);
  assert.equal(adapter._fluidsView().ready, true);
  assert.deepEqual(adapter._lavaThreat().position, { x: 2, y: 71, z: 0 });
});

test('/observe espone i fluidi e un mondo senza findBlocks non fa lanciare nulla', () => {
  const { adapter } = fluidAdapter({ '0,71,0': water });
  const obs = adapter.observe();
  assert.equal(obs.fluids.inWater, true);
  assert.equal(obs.fluids.hazard.level, 'low');
  assert.deepEqual(obs.fluids.hazard.reasons, ['in_water'], 'la testa è fuori dall\'acqua');

  // Fail-open: il censimento non è disponibile ma lo stato della cella dei piedi sì.
  adapter.world.findBlocks = undefined;
  adapter._fluidScan = null;
  const view = adapter._fluidsView();
  assert.equal(view.water.count, 0);
  assert.equal(view.inWater, true);
  assert.equal(view.hazard.level, 'low');
  // Lo scavo resta possibile: senza censimento nessun fluido risulta adiacente.
  assert.doesNotMatch(adapter._digTargets().error ?? '', /unsafe_/);
});

// ---- guado dell'acqua bassa (M1a) ------------------------------------------------
// In una cella con acqua e la testa fuori si cammina sul fondo: nessun nuoto,
// nessun flag di protocollo da indovinare. L'acqua profonda resta un muro.

test('_standable calpesta un guado e la vista lo dichiara', () => {
  const { adapter } = fluidAdapter({ '0,71,0': water });
  assert.equal(adapter._standable(0, 71, 0), true, 'acqua bassa: si cammina sul fondo');
  assert.equal(adapter._standable(0, 72, 0), false, 'sopra l\'acqua non c\'è piano d\'appoggio');
  assert.equal(adapter._wading(), true, 'i piedi sono in acqua e la testa fuori');
  assert.equal(adapter.observe().fluids.wading, true);
  assert.equal(adapter._fluidsView().hazard.level, 'low');
});

test('l\'acqua profonda (testa sommersa) non è calpestabile né raggiungibile', () => {
  const shallow = fluidAdapter({ '0,71,-1': water });
  assert.equal(shallow.adapter._standable(0, 71, -1), true);
  assert.equal(shallow.adapter._wading(), false, 'i piedi del bot sono sulla terraferma');

  const deep = fluidAdapter({ '0,71,-1': water, '0,72,-1': water });
  assert.equal(deep.adapter._standable(0, 71, -1), false, 'nuotare non è ancora supportato (M1)');
  const cells = deep.adapter.reachableCells().cells;
  assert.equal(cells.has('0,71,-1'), false, 'la cella profonda resta fuori dal componente raggiungibile');
  const wadeCells = shallow.adapter.reachableCells().cells;
  assert.equal(wadeCells.has('0,71,-1'), true, 'la cella di guado entra nel componente');
});

test('lava ai piedi non è un guado', () => {
  const { adapter } = fluidAdapter({ '0,71,-1': lava });
  assert.equal(adapter._standable(0, 71, -1), false);
});

test('_neighbors attraversa un guado ma non l\'acqua profonda', () => {
  const shallow = fluidAdapter({ '0,71,-1': water });
  const names = [...shallow.adapter._neighbors({ x: 0, y: 71, z: 0 })].map(n => `${n.x},${n.y},${n.z}`);
  assert.ok(names.includes('0,71,-1'), 'il guado è un vicino');

  const deep = fluidAdapter({ '0,71,-1': water, '0,72,-1': water });
  const deepNames = [...deep.adapter._neighbors({ x: 0, y: 71, z: 0 })].map(n => `${n.x},${n.y},${n.z}`);
  assert.equal(deepNames.includes('0,71,-1'), false);
});

test('_physicsStep cammina più piano mentre guada', () => {
  const { adapter } = fluidAdapter({ '0,71,0': water });
  adapter._motion = { active: true, forward: true, yaw: 0, jumpQueued: false, jumpHeldTicks: 0 };
  adapter._physicsStep();
  const wet = adapter._feet.z - 0.5;

  const dry = fluidAdapter({});
  dry.adapter._motion = { active: true, forward: true, yaw: 0, jumpQueued: false, jumpHeldTicks: 0 };
  dry.adapter._physicsStep();
  const land = dry.adapter._feet.z - 0.5;

  assert.ok(Math.abs(wet - 0.1079) < 1e-3, `passo in acqua ${wet}`);
  assert.ok(Math.abs(land - 0.2158) < 1e-3, `passo a terra ${land}`);
});

// ---- aria simulata (M1b parziale) ------------------------------------------------
// Il server non manda l'attributo `minecraft:air`, quindi il budget è simulato:
// etichettato `airSource: 'simulated'` e usato dalle regole, senza mai fingere
// danno (la salute resta del server).

test('con la testa sott\'acqua il contatore d\'aria scende fino all\'allarme', () => {
  const { adapter } = fluidAdapter({ '0,71,0': water, '0,72,0': water });
  const view = adapter._fluidsView();
  assert.equal(view.headInWater, true);
  assert.equal(view.air, 300);
  assert.equal(view.airSource, 'simulated');
  assert.equal(view.hazard.level, 'low', 'aria piena: ancora nessun annegamento');

  for (let i = 0; i < 292; i++) adapter._airTick();
  assert.equal(adapter.air, 8);
  const critical = adapter._fluidsView();
  assert.equal(critical.hazard.level, 'critical');
  assert.ok(critical.hazard.reasons.includes('drowning'));
  assert.equal(critical.airSeconds, 0.4);
});

test('fuori dall\'acqua l\'aria si recupera e la vista non segnala nulla', () => {
  const { adapter } = fluidAdapter({});
  adapter.air = 40;
  adapter._airMeter.set(40);
  adapter._airTick();
  assert.equal(adapter.air, 44, 'quattro tick di recupero per tick');
  assert.equal(adapter._fluidsView().hazard.level, 'none');
});

test('un attributo del server vince sul contatore simulato', () => {
  const { adapter } = fluidAdapter({ '0,71,0': water, '0,72,0': water });
  adapter._applyOwnAttributes({ attributes: [{ name: 'minecraft:air', current: 123 }] });
  assert.equal(adapter.air, 123);
  assert.equal(adapter.airSource, 'server');
  adapter._airTick();
  assert.equal(adapter.air, 123, 'la verità del server resta');
  assert.equal(adapter._airMeter.value, 122, 'il contatore resta allineato');
});

// --- M2: respirare e gestire una discesa ------------------------------------
// Il cancello del respiro passa da ogni scavo e da ogni raccolta: con la testa
// fuori dall'acqua non deve costare nulla, con la testa sotto deve rifiutare
// ciò che non sta nel budget. Il mondo finto ha il registro degli effetti
// (names da `WaterBreathing`) e l'armatura dell'adapter.

function breathAdapter (cells = {}, extra = {}) {
  const { adapter } = fluidAdapter(cells, extra);
  adapter.world.registry = { effects: { 13: { id: 13, name: 'WaterBreathing', displayName: 'Water Breathing' } } };
  adapter.client = { write () {} };
  return adapter;
}

test('_onMobEffect traccia solo gli effetti del bot e li rimuove', () => {
  const adapter = breathAdapter({});
  adapter.client.entityId = 7;
  adapter._onMobEffect({ runtime_entity_id: 9n, event_id: 'add', effect_id: 13, amplifier: 0, duration: 600 });
  assert.equal(adapter.effects.size, 0, 'un effetto di un altro mob non riguarda il bot');

  adapter._onMobEffect({ runtime_entity_id: 7n, event_id: 'add', effect_id: 13, amplifier: 1, duration: 600 });
  assert.equal(adapter.effects.size, 1);
  assert.equal(adapter._waterBreathing().active, true);
  assert.equal(adapter._waterBreathing().sources[0].seconds, 30);

  adapter._onMobEffect({ runtime_entity_id: 7n, event_id: 'update', effect_id: 13, amplifier: 0, duration: -1 });
  assert.equal(adapter._waterBreathing().sources[0].seconds, 'infinite');
  adapter._onMobEffect({ runtime_entity_id: 7n, event_id: 'remove', effect_id: 13 });
  assert.equal(adapter.effects.size, 0);
  assert.equal(adapter._waterBreathing().active, false);

  // Il server non manda sempre un `remove` quando l'effetto finisce: la scadenza
  // basta a smettere di considerarlo attivo (e a buttarlo via).
  adapter._onMobEffect({ runtime_entity_id: 7n, event_id: 'add', effect_id: 13, duration: 20 });
  adapter.effects.get('water_breathing').expiresAt = Date.now() - 1;
  assert.equal(adapter._waterBreathing().active, false);
  assert.equal(adapter.effects.size, 0, 'un effetto scaduto non resta in mappa');
  // Un id che il registro non conosce resta leggibile come `effect_<id>`.
  adapter._onMobEffect({ runtime_entity_id: 7n, event_id: 'add', effect_id: 99, duration: 20 });
  assert.deepEqual([...adapter.effects.keys()], ['effect_99']);
});

test('_waterBreathing legge l\'elmo di tartaruga e i conduit vicini', () => {
  const adapter = breathAdapter({ '3,71,0': { name: 'conduit', boundingBox: 'block', diggable: true, hardness: 0.5 } });
  assert.equal(adapter._waterBreathing().active, false);
  assert.equal(adapter._waterBreathing().conduitsNear, 1, 'il conduit resta un indizio, non una certezza');
  adapter.armor.helmet = 'turtle_helmet';
  const source = adapter._waterBreathing().sources[0];
  assert.deepEqual(source, { kind: 'armor', name: 'turtle_helmet' });
  adapter.armor.helmet = 'iron_helmet';
  assert.equal(adapter._waterBreathing().active, false);
});

test('_diveView conta i blocchi d\'acqua sopra la testa', () => {
  const dry = breathAdapter({});
  assert.equal(dry._diveView().depth, 0);
  assert.equal(dry._diveView().plan, null, 'fuori dall\'acqua non c\'è un piano di discesa');

  const wet = breathAdapter({ '0,71,0': water, '0,72,0': water, '0,73,0': water });
  const view = wet._diveView();
  assert.equal(view.depth, 2, 'acqua alla testa e un blocco sopra: è la distanza dalla superficie');
  assert.equal(view.workSeconds, 3);
  assert.equal(view.plan.ok, true);
  assert.equal(view.plan.depth, 2);
});

test('_underwaterWorkAllowed non blocca un bot asciutto e rifiuta il lavoro troppo lungo', () => {
  const dry = breathAdapter({});
  assert.deepEqual(dry._underwaterWorkAllowed(), { allowed: true, reason: 'head_above_water', plan: null });

  const wet = breathAdapter({ '0,71,0': water, '0,72,0': water, '0,73,0': water });
  const allowed = wet._underwaterWorkAllowed(3);
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.reason, 'budget_ok');
  assert.equal(wet._diveLast.reason, 'budget_ok', 'l\'ultima discesa accettata resta in vista');

  wet.air = 20;
  const refused = wet._underwaterWorkAllowed(3);
  assert.equal(refused.allowed, false);
  assert.equal(refused.reason, 'air_too_low');
  assert.equal(refused.depth, 2);

  wet.air = 300;
  const tooLong = wet._underwaterWorkAllowed(120);
  assert.equal(tooLong.reason, 'work_too_long');

  // Con il respiro attivo il budget non esiste più.
  wet.armor.helmet = 'turtle_helmet';
  wet.air = 20;
  assert.equal(wet._underwaterWorkAllowed(3).reason, 'water_breathing');
});

test('_mineBlock e _collectDrop passano dal cancello del respiro', async () => {
  const adapter = breathAdapter({ '1,71,0': water, '0,71,0': water, '0,72,0': water, '0,73,0': water });
  adapter.air = 10;
  const target = { name: 'stone', position: { x: 1, y: 70, z: 0 } };
  const refused = await adapter._mineBlock(target);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'air_too_low');
  assert.equal(refused.air, 10);

  const drop = await adapter._collectDrop(1000);
  assert.equal(drop.ok, false);
  assert.equal(drop.error, 'air_too_low');

  // Con il respiro attivo lo scavo non viene rifiutato dal cancello: arriva
  // oltre e si ferma per il motivo successivo (nessun client/utensile nel finto).
  adapter.armor.helmet = 'turtle_helmet';
  let beyond = null;
  try {
    beyond = await adapter._mineBlock(target);
  } catch (error) {
    beyond = { error: error.message };
  }
  assert.notEqual(beyond?.error, 'air_too_low');
});
