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

test('M1: i flag di nuoto finiscono in player_auth_input e sono a fronte', () => {
  const { adapter, blocks } = fluidAdapter({ '0,71,0': water, '0,72,0': water });
  const written = [];
  adapter.client = { write: (name, params) => written.push({ name, params }), entityId: 1 };
  const flags = () => {
    const auth = written.find(w => w.name === 'player_auth_input');
    assert.ok(auth, 'player_auth_input inviato');
    return auth.params.input_data;
  };
  // In acqua profonda: lo stato di nuoto si dichiara entrando.
  adapter._sendAuthInput({ yaw: 0, pitch: 0, tick: 10 });
  assert.ok(flags().includes('start_swimming'), 'start_swimming entrando in acqua');
  assert.equal(adapter._swimming, true, 'lo stato di nuoto è ricordato');
  // Secondo tick, ancora in acqua: nessun nuovo start (transizione a fronte).
  written.length = 0;
  adapter._sendAuthInput({ yaw: 0, pitch: 0, tick: 11 });
  assert.ok(!flags().includes('start_swimming'), 'la transizione si annuncia una volta sola');
  // Sneak in acqua: discesa rapida.
  adapter._sneaking = true;
  written.length = 0;
  adapter._sendAuthInput({ yaw: 0, pitch: 0, tick: 12 });
  assert.ok(flags().includes('want_down'), 'sneak = scendere');
  assert.ok(flags().includes('down'));
  adapter._sneaking = false;
  // La testa esce dall\'acqua (restano i piedi bagnati): fine del nuoto.
  blocks.set('0,72,0', air);
  written.length = 0;
  adapter._sendAuthInput({ yaw: 0, pitch: 0, tick: 13 });
  assert.ok(flags().includes('stop_swimming'), 'stop_swimming uscendo');
  assert.equal(adapter._swimming, false, 'lo stato torna a terra');
  assert.ok(!flags().includes('want_down'), 'a testa fuori non si dichiara discesa');
});

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

// ---------------------------------------------------------------------------
// M3: cascate e colonne di bolle. Il movimento in acqua non esiste ancora
// (`swimSupported = false`): il percorso che si collauda è il **rifiuto
// tipizzato** e il fatto che l'avvicinamento non parta mai. I percorsi `ok` si
// provano dichiarando il nuoto disponibile.
// ---------------------------------------------------------------------------

const soulSand = { name: 'soul_sand', boundingBox: 'block', diggable: true, hardness: 0.5 };
const magma = { name: 'magma', boundingBox: 'block', diggable: true, hardness: 0.5 };

test('M3: il censimento riconosce una cascata con atterraggio sicuro', () => {
  const { adapter } = fluidAdapter({ '3,71,0': water, '3,72,0': water, '3,73,0': water });
  const census = adapter._fluidCensus();
  assert.equal(census.waterfalls.length, 1);
  const fall = census.waterfalls[0];
  assert.deepEqual(fall.top, { x: 3, y: 73, z: 0 });
  assert.deepEqual(fall.bottom, { x: 3, y: 71, z: 0 });
  assert.equal(fall.height, 3);
  assert.equal(fall.source, 'water', 'il nome del blocco in cima alla colonna');
  assert.equal(fall.landing.safe, true, 'la pietra sotto la pozza è un atterraggio sicuro');
  assert.equal(fall.landing.name, 'stone');
  assert.equal(fall.distance, 3.2, 'distanza 3D dai piedi alla cima');
  assert.equal(adapter._columnView().bubbleCount, 0);

  // I piedi fuori dalla colonna: nessuna condizione di cascata.
  assert.equal(adapter._fluidsView().onWaterfall, false);
  assert.equal(adapter._fluidsView().waterfall.height, 3);
  // Dentro la colonna (stessa x,z e quota compresa fra fondo e cima).
  adapter._feet = { x: 3.5, y: 72, z: 0.5 };
  assert.equal(adapter._fluidsView().onWaterfall, true);
  assert.equal(adapter._fluidsView().waterfall.top.y, 73);
});

test('M3: una cascata con atterraggio pericoloso o ignoto non entra nel censimento', () => {
  const unsafe = fluidAdapter({ '3,71,0': water, '3,72,0': water, '3,73,0': water, '3,70,0': lava }).adapter;
  assert.deepEqual(unsafe._waterfalls(), [], 'la lava in fondo scarta la cascata');
  assert.equal(unsafe._columnTactic('descend').error, 'no_column');

  // Mondo senza chunk caricati: l'atterraggio è ignoto, non "sicuro per caso".
  const blind = fluidAdapter({ '3,71,0': water, '3,72,0': water, '3,73,0': water }).adapter;
  blind.world.blockAt = () => null;
  assert.deepEqual(blind._waterfalls(), []);
  const unknown = blind._fluidCensus({ force: true }).waterfalls;
  assert.deepEqual(unknown, [], 'senza `blockAt` non si dichiara un atterraggio');
});

test('M3: _columnView dichiara il limite del nuoto e i tre verdetti', () => {
  const { adapter } = fluidAdapter({ '3,71,0': water, '3,72,0': water, '3,73,0': water });
  const view = adapter._columnView();
  assert.equal(view.swimSupported, false);
  assert.equal(view.waterfallCount, 1);
  assert.equal(view.descend.error, 'swimming_unavailable');
  assert.equal(view.descend.distance, 3.2);
  assert.equal(view.climb.error, 'swimming_unavailable');
  assert.equal(view.bubble.error, 'no_column');
  assert.equal(view.last, null);
});

test('M3: le opzioni di colonna compaiono solo quando il nuoto c\'è', () => {
  const dry = fluidAdapter({ '3,71,0': water, '3,72,0': water, '3,73,0': water }).adapter;
  const dryKeys = dry.options().map(o => o.key);
  assert.ok(!dryKeys.includes('descend_waterfall'), 'senza nuoto non si offre la discesa');
  assert.ok(!dryKeys.includes('climb_waterfall'));
  assert.ok(!dryKeys.includes('use_bubble_column'));

  const swimmer = fluidAdapter({ '3,71,0': water, '3,72,0': water, '3,73,0': water }).adapter;
  swimmer.swimSupported = true;
  const keys = swimmer.options().map(o => o.key);
  assert.ok(keys.includes('descend_waterfall'), 'con il nuoto la discesa è offerta');
  assert.ok(keys.includes('climb_waterfall'));
  const describe = swimmer.options().find(o => o.key === 'descend_waterfall').description;
  assert.match(describe, /Ride the waterfall at \{"x":3,"y":73,"z":0\} down 3 blocks to the landing at \{"x":3,"y":70,"z":0\}/);
});

test('M3: le bolle verso l\'alto ripagano l\'aria, quelle di magma chiedono lo sneak', () => {
  const up = fluidAdapter({ '4,70,0': soulSand, '4,71,0': water, '4,72,0': water }).adapter;
  assert.equal(up._bubbles()[0].direction, 'up');
  assert.equal(up._bubbles()[0].airRefill, true);
  assert.equal(up._columnTactic('bubble').error, 'swimming_unavailable', 'serve comunque il nuoto');
  up.swimSupported = true;
  const ride = up._columnTactic('bubble');
  assert.equal(ride.ok, true);
  assert.equal(ride.reason, 'bubble_column');
  assert.equal(ride.plan, null, 'la colonna verso l\'alto non consuma budget');
  assert.ok(up.options().map(o => o.key).includes('use_bubble_column'));

  const down = fluidAdapter({ '5,70,0': magma, '5,71,0': water, '5,72,0': water }).adapter;
  down.swimSupported = true;
  const verdict = down._columnTactic('bubble');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.error, 'sneak_not_supported', 'il magma fa danno senza sneak');
  assert.ok(!down.options().map(o => o.key).includes('use_bubble_column'));
});

test('M3: _useColumn rifiuta senza nuoto e non muove il bot', async () => {
  const { adapter } = fluidAdapter({ '3,71,0': water, '3,72,0': water, '3,73,0': water });
  const logs = [];
  adapter.log = (type, data) => logs.push({ type, ...data });
  let moves = 0;
  adapter._moveTo = async () => { moves++; };

  const refused = await adapter._useColumn('descend');
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'swimming_unavailable');
  assert.equal(refused.kind, 'descend');
  assert.equal(moves, 0, 'nessun avvicinamento quando il verdetto rifiuta');
  assert.equal(logs.filter(l => l.type === 'column_refused').length, 1);
  assert.equal(adapter._waterfallLast, null, 'un rifiuto non scrive l\'ultimo esito');

  const missing = await adapter._useColumn('climb');
  assert.equal(missing.error, 'swimming_unavailable');

  const bubble = await adapter._useColumn('bubble');
  assert.equal(bubble.error, 'no_column');
  assert.equal(moves, 0);
});

test('M3: con il nuoto _useColumn avvicina, attende e verifica dal mondo', async () => {
  const { adapter } = fluidAdapter({ '3,71,0': water, '3,72,0': water, '3,73,0': water });
  adapter.swimSupported = true;
  const logs = [];
  adapter.log = (type, data) => logs.push({ type, ...data });
  let moves = 0;
  adapter._moveTo = async () => {
    moves++;
    // Il server porta i piedi nella pozza in fondo alla cascata.
    adapter._feet = { x: 3.5, y: 70, z: 0.5 };
    adapter.position = { x: 3.5, y: 71.62, z: 0.5 };
  };

  const report = await adapter._useColumn('descend');
  assert.equal(report.ok, true);
  assert.equal(report.kind, 'descend');
  assert.equal(moves, 1);
  assert.equal(report.deltaY, -1);
  assert.deepEqual(report.from, { x: 0.5, y: 71, z: 0.5 });
  assert.equal(report.column.landing.position.y, 70);
  assert.equal(logs.filter(l => l.type === 'column_used').length, 1);
  assert.equal(adapter._waterfallLast.reason, 'traversed');
});

test('M3: dentro la colonna l\'azione è già conclusa e la traversata può fallire', async () => {
  const { adapter } = fluidAdapter({ '3,71,0': water, '3,72,0': water, '3,73,0': water });
  adapter.swimSupported = true;
  adapter._feet = { x: 3.5, y: 72, z: 0.5 };
  let moves = 0;
  adapter._moveTo = async () => { moves++; };
  const inside = await adapter._useColumn('descend');
  assert.equal(inside.ok, true);
  assert.equal(inside.entered, false);
  assert.equal(inside.deltaY, 0);
  assert.equal(moves, 0, 'già dentro: nessun avvicinamento');

  // I piedi non si muovono: niente atterraggio ⇒ fallimento esplicito.
  const stuck = await adapter._waitColumnTraversal('descend', adapter._waterfalls()[0], { timeoutMs: 120, pollMs: 40 });
  assert.equal(stuck.ok, false);
  assert.equal(stuck.error, 'column_not_traversed');
  assert.equal(stuck.deltaY, 0);
});

test('M3: dig_down usa la cascata quando è utilizzabile, altrimenti scava come prima', async () => {
  const { adapter } = fluidAdapter({ '3,71,0': water, '3,72,0': water, '3,73,0': water });
  let dug = 0;
  adapter._digTargets = () => { dug++; return { error: 'no_support_ahead' }; };
  adapter._useColumn = async () => ({ ok: true, kind: 'descend', to: { x: 3.5, y: 70, z: 0.5 }, column: { height: 3 } });
  adapter.swimSupported = true;

  const viaWater = await adapter._digDown();
  assert.equal(viaWater.ok, true);
  assert.equal(viaWater.via, 'waterfall');
  assert.equal(dug, 0, 'con la cascata non si scava');
  assert.equal(viaWater.column.height, 3);

  // Senza nuoto il verdetto rifiuta: lo scavo resta identico a prima.
  const dry = fluidAdapter({ '3,71,0': water, '3,72,0': water, '3,73,0': water }).adapter;
  let dryDug = 0;
  dry._digTargets = () => { dryDug++; return { error: 'no_support_ahead' }; };
  const viaStairs = await dry._digDown();
  assert.equal(viaStairs.ok, false);
  assert.equal(viaStairs.error, 'no_support_ahead');
  assert.equal(dryDug, 1, 'senza cascata utilizzabile si torna alla scala');
});

test('M4: _lavaView misura la lava, il gate e i drop che ci sono già caduti', () => {
  const { adapter } = fluidAdapter({ '1,71,0': lava, '2,71,0': lava });
  adapter.inventory = { cobblestone: 8 };
  adapter.drops = [{ id: 'd1', item: 'dirt', position: { x: 1.5, y: 71.5, z: 0.5 }, spawnedAt: Date.now() }];
  const view = adapter._lavaView();
  assert.equal(view.inLava, false);
  assert.equal(view.lavaDistance, 0.7, 'il bordo del lago è a mezzo blocco in diagonale');
  assert.equal(view.cells, 2);
  assert.deepEqual(view.nearest, { x: 1, y: 71, z: 0 });
  assert.equal(view.fireResistance.active, false);
  assert.equal(view.gap.gap, 2, 'due celle di lava davanti');
  assert.deepEqual(view.gap.direction, { x: 1, z: 0 });
  assert.equal(view.gate.ok, false);
  assert.equal(view.gate.error, 'no_fire_resistance', 'un buco di lava senza pozione non si attraversa');
  assert.equal(view.death, null, 'nessuna morte da giudicare');
  assert.deepEqual(view.lostDrops.map(d => d.item), ['dirt'], 'il drop è nella cella di lava');
  assert.equal(view.last, null);

  // Con la resistenza al fuoco e i blocchi il gate si apre: la vista lo dice.
  adapter.effects = new Map([['fire_resistance', { name: 'fire_resistance', seconds: 60 }]]);
  const armed = adapter._lavaView({ force: true });
  assert.equal(armed.fireResistance.active, true);
  assert.equal(armed.gate.ok, true);
  assert.equal(armed.gate.route, 'bridge');
  assert.equal(armed.gate.blocks, 3, 'gap 2 ⇒ 3 blocchi');
});

test('M4: i drop nella lava non si inseguono, quelli accanto sì', () => {
  const { adapter } = fluidAdapter({ '1,71,0': lava, '2,71,0': lava });
  const inLava = { id: 'd1', item: 'dirt', position: { x: 1.5, y: 71.5, z: 0.5 }, spawnedAt: Date.now() };
  const onShore = { id: 'd2', item: 'cobblestone', position: { x: 0.5, y: 71.5, z: 0.5 }, spawnedAt: Date.now() };
  adapter.drops = [inLava, onShore];
  assert.equal(adapter._dropInLava(inLava.position), true);
  assert.equal(adapter._dropInLava(onShore.position), false, 'i piedi del bot non sono in lava');
  assert.equal(adapter._nearestDrop().id, 'd2', 'il drop bruciato non è un bersaglio');
  assert.equal(adapter._dropInLava(null), false, 'una posizione ignota non è lava');

  // Senza lava nel censimento la funzione non filtra nulla.
  const dry = fluidAdapter({}).adapter;
  dry.drops = [inLava];
  assert.equal(dry._nearestDrop().id, 'd1');
});

test('M4: la morte in lava distrugge il loot e recover_loot lo rifiuta', async () => {
  const { adapter } = fluidAdapter({ '1,71,0': lava, '2,71,0': lava });
  const logs = [];
  adapter.log = (type, data) => logs.push({ type, ...data });
  let moves = 0;
  adapter._moveTo = async () => { moves++; };
  adapter.deathSite = { position: { x: 1.2, y: 71, z: 0.4 }, at: Date.now(), attempts: 0 };

  const verdict = adapter._deathVerdict();
  assert.equal(verdict.reason, 'in_lava');
  assert.equal(verdict.recoverable, false);
  const view = adapter._lavaView();
  assert.equal(view.death.reason, 'in_lava');

  assert.ok(adapter.options().some(o => o.key === 'recover_loot') === false, 'in lava il loot non si recupera');

  const recovered = await adapter._recoverLoot();
  assert.equal(recovered.ok, false);
  assert.equal(recovered.error, 'drops_lost_in_lava');
  assert.equal(recovered.reason, 'in_lava');
  assert.equal(moves, 0, 'non ci si avvicina nemmeno al sito');
  assert.equal(logs.filter(l => l.type === 'recover_loot_skipped').length, 1);
  assert.equal(adapter.deathSite.lava.recoverable, false, 'il verdetto resta scritto sul sito');

  // Un sito lontano dalla lava resta recuperabile.
  const far = fluidAdapter({ '1,71,0': lava }).adapter;
  far.deathSite = { position: { x: 0.5, y: 71, z: 6.5 }, at: Date.now(), attempts: 0 };
  const safe = far._deathVerdict();
  assert.equal(safe.recoverable, true);
  assert.equal(safe.reason, 'safe');
});

test('M4: move_to_safe rifiuta fuori pericolo e sceglie la sponda d\'acqua', async () => {
  const { adapter } = fluidAdapter({ '1,71,0': lava, '-3,71,0': water });
  adapter._reachabilityUsable = () => false;
  const logs = [];
  adapter.log = (type, data) => logs.push({ type, ...data });
  let moves = 0;
  adapter._moveTo = async () => { moves++; };

  // Lava a mezzo blocco: pericolo addosso ⇒ l'opzione c'è e la fuga muove.
  assert.ok(adapter.options().some(o => o.key === 'move_to_safe'));
  const report = await adapter._moveToSafe();
  assert.equal(report.ok, true);
  assert.equal(moves, 1);
  assert.equal(report.waterAdjacent, true, 'la cella con l\'acqua accanto vince');
  assert.equal(report.from.inLava, false);
  assert.equal(logs.filter(l => l.type === 'move_to_safe').length, 1);
  assert.equal(adapter._lavaLast.waterAdjacent, true);

  // Con la lava lontana l'azione rifiuta e non muove nulla.
  const far = fluidAdapter({ '6,71,0': lava }).adapter;
  far._reachabilityUsable = () => false;
  let farMoves = 0;
  far._moveTo = async () => { farMoves++; };
  assert.ok(!far.options().some(o => o.key === 'move_to_safe'), 'a 5 blocchi non si offre move_to_safe');
  const refused = await far._moveToSafe();
  assert.equal(refused.error, 'not_in_danger');
  assert.equal(farMoves, 0);
  assert.equal(far._lavaLast, null);
});

test('M4: move_to_safe senza sponde praticabili rifiuta con no_safe_cell', async () => {
  const { adapter } = fluidAdapter({ '1,71,0': lava });
  adapter._reachabilityUsable = () => false;
  adapter._standableNear = () => null; // nessuna cella d'appoggio nel raggio
  const logs = [];
  adapter.log = (type, data) => logs.push({ type, ...data });
  let moves = 0;
  adapter._moveTo = async () => { moves++; };

  const report = await adapter._moveToSafe();
  assert.equal(report.ok, false);
  assert.equal(report.error, 'no_safe_cell');
  assert.equal(report.inLava, false);
  assert.equal(moves, 0);
  assert.equal(logs.filter(l => l.type === 'move_to_safe_no_cell').length, 1);
});

test('M4: cross_lava rifiuta dentro la lava, senza lava davanti e a tratto troncato', async () => {
  // Piedi nella lava: prima si esce.
  const inside = fluidAdapter({ '0,71,0': lava, '1,71,0': lava }).adapter;
  assert.equal(inside._lavaView().inLava, true);
  const inLava = await inside._crossLava();
  assert.equal(inLava.error, 'in_lava');

  // Nessuna lava: non c'è nulla da attraversare.
  const dry = fluidAdapter({}).adapter;
  const noLava = await dry._crossLava();
  assert.equal(noLava.error, 'no_lava_ahead');
  assert.equal(dry._lavaView().gap.gap, 0);

  // Lava più larga del raggio di misura: la larghezza non si inventa.
  const wide = fluidAdapter({ '1,71,0': lava, '2,71,0': lava, '3,71,0': lava, '4,71,0': lava, '5,71,0': lava, '6,71,0': lava, '7,71,0': lava }).adapter;
  assert.equal(wide._lavaView().gap.truncated, true);
  const truncated = await wide._crossLava();
  assert.equal(truncated.error, 'gap_unknown');
  assert.match(truncated.hint, /far shore/);
});

test('M4/M5: cross_lava chiede il gate e poi costruisce il ponte una cella per volta', async () => {
  const { adapter, blocks } = fluidAdapter({ '1,71,0': lava, '2,71,0': lava, '8,71,0': lava });
  adapter.inventory = { cobblestone: 8 };
  const logs = [];
  adapter.log = (type, data) => logs.push({ type, ...data });

  // Il tratto più corto è quello davanti (2 celle), non quello a 8.
  assert.equal(adapter._lavaView().gap.gap, 2);

  const gateClosed = await adapter._crossLava();
  assert.equal(gateClosed.ok, false);
  assert.equal(gateClosed.error, 'no_fire_resistance');
  assert.equal(gateClosed.gate.error, 'no_fire_resistance');
  assert.ok(!adapter.options().some(o => o.key === 'cross_lava'), 'senza gate non si offre');

  adapter.effects = new Map([['fire_resistance', { name: 'fire_resistance', seconds: 60 }]]);
  assert.ok(adapter.options().some(o => o.key === 'cross_lava'), 'col gate aperto l\'opzione compare');

  // Il ponte: una cella per passo, ognuna confermata dal mondo e calpestata solo
  // dopo essere diventata solida. La faccia è quella del blocco d'appoggio.
  const moves = [];
  const placements = [];
  adapter._moveTo = async (point) => { moves.push(point); };
  adapter._placeAtCell = async (item, block, cell, support, face) => {
    placements.push({ item, block, cell, support, face });
    blocks.set(`${cell.x},${cell.y},${cell.z}`, solid(block));
    return { ok: true, block, position: cell };
  };
  const bridged = await adapter._crossLava();
  assert.deepEqual([bridged.ok, bridged.crossed, bridged.blocks, bridged.route], [true, true, 2, 'bridge']);
  assert.deepEqual(placements.map(p => p.cell), [{ x: 1, y: 71, z: 0 }, { x: 2, y: 71, z: 0 }]);
  assert.deepEqual(placements.map(p => p.support), [{ x: 0, y: 71, z: 0 }, { x: 1, y: 71, z: 0 }]);
  assert.deepEqual(placements.map(p => p.face), [5, 5], 'si clicca la faccia est del blocco d\'appoggio');
  assert.equal(moves.length, 2, 'un passo per cella');
  assert.equal(logs.filter(l => l.type === 'lava_bridged').length, 1);
  assert.equal(logs.filter(l => l.type === 'cross_lava_started').length, 1);

  // Un buco largo più di quattro celle non entra nel gate.
  const tooWide = fluidAdapter({ '1,71,0': lava, '2,71,0': lava, '3,71,0': lava, '4,71,0': lava, '5,71,0': lava }).adapter;
  tooWide.inventory = { cobblestone: 32 };
  tooWide.effects = new Map([['fire_resistance', { name: 'fire_resistance', seconds: 60 }]]);
  const refused = await tooWide._crossLava();
  assert.equal(refused.error, 'gap_too_wide');
  assert.equal(refused.gate.limit, 4);
});

// --- M5: secchi, barche e pozioni -------------------------------------------
// Il fixture riusa `fluidAdapter` e aggiunge solo ciò che serve a un "click":
// l'uso viene simulato (inventario e/o mondo cambiati dal server), perché la
// conferma di un riempimento/svuotamento arriva dal server, non dal bot.
function bucketAdapter ({ cells = {}, inventory = {}, use = null, mount = true, floor = 6 } = {}) {
  const { adapter, blocks } = fluidAdapter(cells, { floor });
  adapter.client = {};           // `executeAction` esige una connessione viva
  adapter.inventory = { ...inventory };
  adapter.inventorySlots = [
    { network_id: 1, name: 'bucket', count: 1 },
    { network_id: 2, name: 'water_bucket', count: 1 },
    { network_id: 3, name: 'glass_bottle', count: 1 },
  ];
  adapter.selectedHotbar = 0;
  adapter.world.runtimeIdAt = () => 1;
  const inputs = [];
  const moves = [];
  const logs = [];
  adapter.log = (type, data) => logs.push({ type, ...(data ?? {}) });
  adapter._queueAuthInput = async (packet) => {
    inputs.push(packet);
    if (packet?.transaction && use) use({ adapter, blocks, packet });
  };
  adapter._lookAt = () => ({ yaw: 0, pitch: 0 });
  adapter._moveTo = async (point) => { moves.push(point); };
  adapter._equipForUse = async (item) => ((adapter.inventory[item] || 0) > 0 ? { ok: true, slotIndex: 0 } : { ok: false, error: `missing_${item}` });
  adapter._interactEntity = () => { if (mount) adapter.riding = { riddenEntityId: 7 }; };
  adapter._craftItem = async (item) => ({ ok: true, crafted: item, count: 1 });
  return { adapter, blocks, inputs, moves, logs };
}

const obsidianBlock = { name: 'obsidian', boundingBox: 'block', diggable: true, hardness: 5 };

test('_bucketSources legge il mondo e scarta l\'acqua che scorre', () => {
  const { adapter } = bucketAdapter({ cells: { '4,71,0': water, '3,71,0': { name: 'flowing_water' }, '2,71,0': lava } });
  const sources = adapter._bucketSources();
  assert.equal(sources.length, 2, 'solo le sorgenti: l\'acqua che scorre non si raccoglie');
  assert.deepEqual(sources.map(s => [s.block, s.item, s.distance]), [['lava', 'lava_bucket', 2.09], ['water', 'water_bucket', 4.05]]);
  assert.equal(sources[0].reason, 'lava_source');
  assert.equal(adapter._bucketsHeld().empty, 0);
});

test('_fillBucket conferma dal delta di inventario', async () => {
  const { adapter, inputs, logs } = bucketAdapter({
    cells: { '3,71,0': water },
    inventory: { bucket: 1 },
    use: ({ adapter: a }) => { a.inventory.bucket = 0; a.inventory.water_bucket = 1; },
  });
  const result = await adapter._fillBucket();
  assert.equal(result.ok, true);
  assert.equal(result.filled, 'water_bucket');
  assert.equal(result.confirmedBy, 'inventory_delta');
  assert.deepEqual(result.source, { x: 3, y: 71, z: 0 });
  assert.deepEqual(result.delta, { bucket: -1, water_bucket: 1 });
  assert.equal(adapter._bucketLast.ok, true);
  assert.equal(logs.filter(l => l.type === 'bucket_filled').length, 1);
  assert.ok(inputs.some(i => i.transaction?.data?.action_type === 'click_block'), 'il click arriva sul blocco');
});

test('_fillBucket rifiuta senza secchio, senza sorgente e con la sola acqua che scorre', async () => {
  const empty = bucketAdapter({ cells: { '3,71,0': water } });
  const noBucket = await empty.adapter._fillBucket();
  assert.deepEqual([noBucket.ok, noBucket.error], [false, 'missing_bucket']);
  assert.equal(empty.inputs.length, 0);

  const noSource = bucketAdapter({ inventory: { bucket: 1 } });
  const nothing = await noSource.adapter._fillBucket();
  assert.deepEqual([nothing.ok, nothing.error], [false, 'no_source_nearby']);
  assert.equal(noSource.inputs.length, 0);

  const flowing = bucketAdapter({ cells: { '3,71,0': { name: 'flowing_water' } }, inventory: { bucket: 1 } });
  assert.equal((await flowing.adapter._fillBucket()).error, 'no_source_nearby');
});

test('_fillBottle riempie la fiala alla sorgente', async () => {
  const { adapter, logs } = bucketAdapter({
    cells: { '2,71,0': water },
    inventory: { glass_bottle: 2 },
    use: ({ adapter: a }) => { a.inventory.glass_bottle = 1; a.inventory.potion = 1; },
  });
  const result = await adapter._fillBottle();
  assert.deepEqual([result.ok, result.filled, result.confirmedBy], [true, 'potion', 'inventory_delta']);
  assert.equal(logs.filter(l => l.type === 'bucket_filled').length, 1);
});

test('_emptyBucket versa l\'acqua sulla lava e legge l\'ossidiana dal mondo', async () => {
  const { adapter, blocks, logs } = bucketAdapter({
    cells: { '3,71,0': lava },
    inventory: { water_bucket: 1 },
    use: ({ blocks: b }) => { b.set('3,71,0', obsidianBlock); adapter.inventory.water_bucket = 0; adapter.inventory.bucket = 1; },
  });
  const result = await adapter._emptyBucket();
  assert.equal(result.ok, true);
  assert.equal(result.expected, 'obsidian');
  assert.equal(result.world, 'obsidian');
  assert.equal(result.confirmedBy, 'server_world');
  assert.equal(result.reason, 'water_on_lava_source');
  assert.ok(blocks.get('3,71,0').name === 'obsidian');
  assert.ok(logs.some(l => l.type === 'bucket_emptied'));
});

test('_emptyBucket rifiuta nel Nether e su un blocco solido', async () => {
  const nether = bucketAdapter({ inventory: { water_bucket: 1 } });
  nether.adapter.dimension = 'nether';
  const refused = await nether.adapter._emptyBucket({ target: { x: 2, y: 71, z: 0 } });
  assert.deepEqual([refused.ok, refused.error], [false, 'water_in_nether']);
  assert.equal(nether.inputs.length, 0, 'nessun pacchetto: il verdetto lo dice prima');

  const blocked = bucketAdapter({ cells: { '0,71,1': solid() }, inventory: { water_bucket: 1 } });
  const verdict = await blocked.adapter._emptyBucket();
  assert.equal(verdict.error, 'blocked');
  assert.equal(blocked.inputs.length, 0);

  const nothing = bucketAdapter();
  assert.equal((await nothing.adapter._emptyBucket()).error, 'missing_water_bucket');
});

test('_craftBoat chiede la ricetta e le assi giuste', async () => {
  const noRecipe = bucketAdapter({ inventory: { oak_planks: 8 } });
  assert.deepEqual([(await noRecipe.adapter._craftBoat()).ok, (await noRecipe.adapter._craftBoat()).error], [false, 'craft_recipe_missing']);

  const fewPlanks = bucketAdapter({ inventory: { oak_planks: 3 } });
  fewPlanks.adapter.recipes = new Map([['oak_boat', { output: 'oak_boat' }]]);
  const short = await fewPlanks.adapter._craftBoat();
  assert.deepEqual([short.error, short.missing], ['missing_ingredients', { planks: 2 }]);

  const ready = bucketAdapter({ inventory: { oak_planks: 5 } });
  ready.adapter.recipes = new Map([['oak_boat', { output: 'oak_boat' }]]);
  const crafted = await ready.adapter._craftBoat();
  assert.deepEqual([crafted.ok, crafted.crafted], [true, 'oak_boat']);
  assert.equal(ready.logs.filter(l => l.type === 'boat_crafted').length, 1);
});

test('mount_boat esige la barca e l\'acqua aperta', async () => {
  const noBoat = bucketAdapter({ cells: { '1,71,0': water, '2,71,0': water, '3,71,0': water } });
  assert.equal((await noBoat.adapter._mountBoat()).error, 'missing_boat');

  const noWater = bucketAdapter({ cells: { '1,71,0': water }, inventory: { oak_boat: 1 } });
  const refused = await noWater.adapter._mountBoat();
  assert.deepEqual([refused.ok, refused.error], [false, 'no_water_nearby']);

  const ready = bucketAdapter({
    cells: { '1,71,0': water, '2,71,0': water, '3,71,0': water, '4,71,0': water },
    inventory: { oak_boat: 1 },
  });
  ready.adapter.entities.set('7', { kind: 'mob', type: 'boat', position: { x: 2.5, y: 71, z: 0.5 }, runtimeId: 7 });
  ready.adapter._entityDistance = () => 1.4;
  const mounted = await ready.adapter._mountBoat();
  assert.deepEqual([mounted.ok, mounted.mounted, mounted.ridden], [true, 'boat', 7]);
  assert.equal(ready.logs.filter(l => l.type === 'boat_mounted').length, 1);

  const noConfirm = bucketAdapter({
    cells: { '1,71,0': water, '2,71,0': water, '3,71,0': water, '4,71,0': water },
    inventory: { oak_boat: 1 },
    mount: false,
  });
  noConfirm.adapter.entities.set('7', { kind: 'mob', type: 'boat', position: { x: 2.5, y: 71, z: 0.5 }, runtimeId: 7 });
  noConfirm.adapter._entityDistance = () => 1.4;
  const stuck = await noConfirm.adapter._mountBoat({ timeoutMs: 300 });
  assert.deepEqual([stuck.ok, stuck.error], [false, 'mount_not_confirmed']);
});

test('_brew rifiuta per materiale e dichiara il residuo quando c\'è tutto', async () => {
  const bare = bucketAdapter();
  assert.equal((await bare.adapter._brew('water_breathing')).error, 'missing_brewing_stand');
  assert.equal(bare.logs.filter(l => l.type === 'brew_refused').length, 1);

  const stand = bucketAdapter({ cells: { '1,71,0': { name: 'brewing_stand', boundingBox: 'block', diggable: true, hardness: 0.5 } } });
  assert.equal((await stand.adapter._brew('water_breathing')).error, 'missing_blaze_powder');

  const ready = bucketAdapter({
    cells: { '1,71,0': { name: 'brewing_stand', boundingBox: 'block', diggable: true, hardness: 0.5 } },
    inventory: { blaze_powder: 1, potion: 3, nether_wart: 2, pufferfish: 1 },
  });
  const blocked = await ready.adapter._brew('water_breathing');
  assert.deepEqual([blocked.ok, blocked.error], [false, 'brew_not_implemented']);
  assert.equal(blocked.plan.ok, true);
  assert.equal(blocked.plan.steps.length, 3);
  assert.equal(ready.logs.filter(l => l.type === 'brew_blocked').length, 1);
  // Una ricetta che non conosciamo resta un rifiuto, non una pozione a caso.
  assert.equal((await ready.adapter._brew('strength')).error, 'unknown_recipe');
});

test('le opzioni M5 compaiono solo con i materiali e il verdetto giusti', () => {
  const withBucket = bucketAdapter({ cells: { '3,71,0': water }, inventory: { bucket: 1 } });
  const offered = withBucket.adapter.options();
  assert.ok(offered.some(o => o.key === 'fill_bucket'));
  assert.match(offered.find(o => o.key === 'fill_bucket').description, /Fill a bucket with water at \{"x":3,"y":71,"z":0\}/);

  const withWater = bucketAdapter({ cells: { '3,71,0': lava }, inventory: { water_bucket: 1 } });
  const pour = withWater.adapter.options().find(o => o.key === 'place_water');
  assert.ok(pour, 'con un secchio d\'acqua e la lava davanti l\'opzione c\'è');
  assert.match(pour.description, /obsidian/);

  const noBucket = bucketAdapter({ cells: { '3,71,0': water } });
  assert.ok(!noBucket.adapter.options().some(o => o.key === 'fill_bucket'));

  const boat = bucketAdapter({ inventory: { oak_planks: 6 }, cells: { '2,70,1': { name: 'crafting_table', boundingBox: 'block', diggable: true, hardness: 2.5 } } });
  boat.adapter.recipes = new Map([['oak_boat', { output: 'oak_boat' }]]);
  assert.ok(boat.adapter.options().some(o => o.key === 'craft_boat'));
  boat.adapter.inventory = { oak_planks: 3 };
  assert.ok(!boat.adapter.options().some(o => o.key === 'craft_boat'), 'con tre assi la barca non si offre');

  const view = withBucket.adapter.observe().bucket;
  assert.equal(view.sources.length, 1);
  assert.equal(view.boat.inInventory, 0);
  assert.equal(view.brew.stand, false);
  assert.equal(view.brew.effects.water_breathing, 'missing_brewing_stand');
});

test("M5: il ponte puo usare l'acqua (ossidiana) invece dei blocchi", async () => {
  const { adapter, blocks, logs, inputs } = bucketAdapter({
    cells: { '1,71,0': lava, '2,71,0': lava },
    inventory: { water_bucket: 2 },
    use: ({ adapter: a, blocks: b, packet }) => {
      const p = packet.transaction.data.block_position;
      b.set(`${p.x},${p.y},${p.z}`, obsidianBlock);
      a.inventory.water_bucket -= 1;
      a.inventory.bucket = (a.inventory.bucket || 0) + 1;
    },
  });
  adapter.effects = new Map([['fire_resistance', { name: 'fire_resistance', seconds: 60 }]]);
  const report = await adapter._bridgeLava();
  assert.deepEqual([report.ok, report.crossed, report.blocks], [true, true, 2]);
  assert.deepEqual(report.placed.map(p => [p.via, p.world]), [['water', 'obsidian'], ['water', 'obsidian']]);
  assert.equal(blocks.get('1,71,0').name, 'obsidian');
  assert.equal(blocks.get('2,71,0').name, 'obsidian');
  assert.ok(inputs.some(i => i.transaction?.data?.action_type === 'click_block'), 'l\'acqua si versa col click sul blocco');
  assert.equal(logs.filter(l => l.type === 'lava_bridged').length, 1);
});

test('M5: senza gate il ponte non parte, e i rifiuti sono quelli di M4', async () => {
  const { adapter, inputs } = bucketAdapter({ cells: { '1,71,0': lava, '2,71,0': lava } });
  const refused = await adapter._bridgeLava();
  assert.deepEqual([refused.ok, refused.error], [false, 'not_equipped']);
  assert.equal(inputs.length, 0, 'nessun pacchetto: si rifiuta prima di toccare la lava');
  assert.equal(adapter._bucketLast, null);

  const inside = bucketAdapter({ cells: { '0,71,0': lava, '1,71,0': lava } });
  assert.equal((await inside.adapter._bridgeLava()).error, 'in_lava');

  const dry = bucketAdapter();
  assert.equal((await dry.adapter._bridgeLava()).error, 'no_lava_ahead');
});

test('M5: fill_bucket, place_water e mount_boat arrivano al ramo giusto', async () => {
  // I prefissi generici (`place_<blocco>`, `mount_<tipo>`) intercettavano
  // `place_water`/`mount_boat`: difetto visto live, coperto qui.
  const cap = bucketAdapter({
    cells: { '3,71,0': water },
    inventory: { bucket: 1 },
    use: ({ adapter: a }) => { a.inventory.bucket = 0; a.inventory.water_bucket = 1; },
  });
  assert.equal((await cap.adapter.executeAction('fill_bucket')).filled, 'water_bucket');

  const pour = bucketAdapter({
    cells: { '3,71,0': lava },
    inventory: { water_bucket: 1 },
    use: ({ blocks: b }) => b.set('3,71,0', obsidianBlock),
  });
  const poured = await pour.adapter.executeAction('place_water');
  assert.deepEqual([poured.ok, poured.expected], [true, 'obsidian'], 'place_water non è il piazzamento del blocco "water"');

  const board = bucketAdapter({
    cells: { '1,71,0': water, '2,71,0': water, '3,71,0': water, '4,71,0': water },
    inventory: { oak_boat: 1 },
  });
  board.adapter.entities.set('7', { kind: 'mob', type: 'boat', position: { x: 2.5, y: 71, z: 0.5 }, runtimeId: 7 });
  board.adapter._entityDistance = () => 1.4;
  const boarded = await board.adapter.executeAction('mount_boat');
  assert.deepEqual([boarded.ok, boarded.mounted], [true, 'boat'], 'mount_boat non è la cavalcatura di un tipo "boat" generico');
});

// M1 (04/10/2026): i ratei del nuoto si misurano. La sonda forza l'intenzione
// verticale nei frame e riferisce la quota che il **server** conferma; il test
// verifica entrambe le cose (frame + report) e che la sonda si spenga sempre.
test('M1: swimMeasure misura la risalita con want_up e spegne la sonda', async () => {
  const { adapter } = fluidAdapter({ '0,71,0': water, '0,72,0': water });
  const written = [];
  adapter.client = { write: (name, params) => written.push({ name, params }), entityId: 1 };
  const y0 = adapter.position.y;
  const probe = adapter.swimMeasure({ mode: 'up', ms: 200, sampleMs: 40 });
  // Il server conferma la risalita: la quota (autorevole) sale mentre la sonda è accesa.
  for (let step = 1; step <= 4; step++) {
    await new Promise(resolve => setTimeout(resolve, 30));
    adapter.position = { x: 0.5, y: y0 + step * 0.25, z: 0.5 };
    adapter._sendAuthInput({ yaw: 0, pitch: 0, tick: 100 + step });
  }
  const report = await probe;
  assert.equal(report.ok, true);
  assert.equal(report.mode, 'up');
  assert.equal(report.headInWater, true, 'testa in acqua: è la condizione della misura');
  assert.ok(report.deltaY > 0, `quota salita (${report.deltaY})`);
  assert.ok(report.ratePerSecond > 0, `rateo positivo (${report.ratePerSecond})`);
  assert.ok(report.samples.length >= 2, 'ci sono campioni');
  const auth = written.find(w => w.name === 'player_auth_input');
  assert.ok(auth, 'player_auth_input inviato durante la misura');
  assert.ok(auth.params.input_data.includes('want_up'), 'la sonda dichiara want_up');
  assert.ok(!auth.params.input_data.includes('want_down'), 'e non want_down');
  assert.equal(adapter._swimProbe, null, 'la sonda si spegne a fine misura');
  // Spenta la sonda, il frame torna a non dichiarare l'intenzione verticale.
  written.length = 0;
  adapter._sendAuthInput({ yaw: 0, pitch: 0, tick: 200 });
  const after = written.find(w => w.name === 'player_auth_input');
  assert.ok(!after.params.input_data.includes('want_up'), 'nessuna intenzione verticale residua');
});

test('M1: swimMeasure in discesa dichiara want_down e riferisce il segno', async () => {
  const { adapter } = fluidAdapter({ '0,71,0': water, '0,72,0': water });
  const written = [];
  adapter.client = { write: (name, params) => written.push({ name, params }), entityId: 1 };
  const y0 = adapter.position.y;
  const probe = adapter.swimMeasure({ mode: 'down', ms: 200, sampleMs: 40 });
  for (let step = 1; step <= 4; step++) {
    await new Promise(resolve => setTimeout(resolve, 30));
    adapter.position = { x: 0.5, y: y0 - step * 0.2, z: 0.5 };
    adapter._sendAuthInput({ yaw: 0, pitch: 0, tick: 300 + step });
  }
  const report = await probe;
  assert.equal(report.ok, true);
  assert.ok(report.deltaY < 0, `quota scesa (${report.deltaY})`);
  assert.ok(report.ratePerSecond < 0, `rateo negativo (${report.ratePerSecond})`);
  const auth = written.find(w => w.name === 'player_auth_input');
  assert.ok(auth.params.input_data.includes('want_down'), 'la sonda dichiara want_down');
  assert.ok(auth.params.input_data.includes('down'));
  assert.ok(!auth.params.input_data.includes('want_up'), 'e non want_up');
});

test('M1: swimMeasure rifiuta in modo tipizzato fuori dall\'acqua, da montato e con un modo ignoto', async () => {
  const dry = fluidAdapter({}).adapter;
  dry.client = { write () {}, entityId: 1 };
  assert.deepEqual(await dry.swimMeasure({ mode: 'up', ms: 100 }), {
    ok: false, error: 'not_in_water', position: { ...dry.position },
  });

  const { adapter } = fluidAdapter({ '0,71,0': water, '0,72,0': water });
  adapter.client = { write () {}, entityId: 1 };
  const unknown = await adapter.swimMeasure({ mode: 'sideways', ms: 100 });
  assert.equal(unknown.error, 'unknown_mode');
  assert.deepEqual(unknown.modes, ['none', 'up', 'down']);

  adapter.riding = { riddenEntityId: '9' };
  assert.equal((await adapter.swimMeasure({ mode: 'up', ms: 100 })).error, 'riding');

  adapter.riding = null;
  adapter.spawned = false;
  assert.equal((await adapter.swimMeasure({ mode: 'up', ms: 100 })).error, 'not_spawned');
});

// M1 (04/10/2026): il pathfinder non attraversa l'acqua profonda (M3: una
// discesa in un pozzo da cui non si esce è una trappola), ma per nuotare — e per
// misurare i ratei — bisogna poterci entrare: `enterWater` fa un passo
// deliberato verso la colonna scelta dal censimento, con un percorso di un solo
// nodo (nessun A*, nessuna modifica a `_standable`).
test('M1: enterWater sceglie una colonna profonda e ci entra (nessun A*)', async () => {
  const { adapter } = fluidAdapter({ '3,71,0': water, '3,72,0': water, '3,73,0': water, '3,74,0': water });
  const calls = [];
  adapter._startMotion = (path, goalNode, target, stopDistance, deadline) => {
    calls.push({ path, goalNode, target, stopDistance, deadline });
    // Il server conferma la discesa: i piedi arrivano sul fondo della colonna.
    adapter._feet = { x: target.x, y: 71, z: target.z };
    adapter.position = { x: target.x, y: 72.62, z: target.z };
    return Promise.resolve('goal');
  };
  const report = await adapter.enterWater();
  assert.equal(report.ok, true);
  assert.equal(report.entered, true);
  assert.deepEqual(report.cell, { x: 3, y: 74, z: 0 }, "la cella d'ingresso è la superficie della colonna");
  assert.equal(report.depth, 4);
  assert.equal(report.headInWater, true, "testa sott'acqua: è la condizione della misura");
  assert.equal(report.position.y, 72.62);
  assert.equal(calls.length, 1, 'la prima colonna basta');
  assert.deepEqual(calls[0].path, [{ x: 3, y: 74, z: 0 }], 'percorso di un nodo: nessun A*');
  assert.deepEqual(calls[0].goalNode, { x: 3, y: 74, z: 0 });
  assert.equal(adapter._waterEnterLast.entered, true, 'il report resta leggibile');
});

test('M1: enterWater non inventa una nuotata senza acqua profonda', async () => {
  const dry = fluidAdapter({}).adapter;
  const noWater = await dry.enterWater();
  assert.equal(noWater.error, 'no_deep_water');
  assert.equal(noWater.depth, 2);
  assert.equal(noWater.water.count, 0);

  // Una pozzanghera di una cella non è una colonna: misurarci i ratei sarebbe
  // misurare il fondo. Con la soglia a 1 la stessa cella vale.
  const { adapter } = fluidAdapter({ '3,71,0': water });
  const shallow = await adapter.enterWater();
  assert.equal(shallow.error, 'no_deep_water');
  const calls = [];
  adapter._startMotion = (_path, _goalNode, target) => {
    calls.push(target);
    adapter._feet = { x: target.x, y: 71, z: target.z };
    return Promise.resolve('goal');
  };
  const withDepthOne = await adapter.enterWater({ depth: 1 });
  assert.equal(withDepthOne.ok, true);
  assert.equal(withDepthOne.depth, 1);
  assert.equal(calls.length, 1);

  // Una colonna profonda ma lontana non si raggiunge a nuoto: si dichiara.
  const far = fluidAdapter({ '5,71,0': water, '5,72,0': water, '5,73,0': water }).adapter;
  far._startMotion = () => Promise.resolve('goal');
  assert.equal((await far.enterWater({ maxDistance: 2 })).error, 'no_deep_water');
});

test('M1: enterWater è idempotente in acqua e riferisce i tentativi falliti', async () => {
  // Già in acqua: nessun passo, nessuna colonna cercata.
  const { adapter } = fluidAdapter({ '0,71,0': water, '0,72,0': water });
  let motions = 0;
  adapter._startMotion = () => { motions++; return Promise.resolve('goal'); };
  const already = await adapter.enterWater();
  assert.equal(already.ok, true);
  assert.equal(already.already, true);
  assert.equal(already.headInWater, true);
  assert.equal(motions, 0, 'già in acqua: nessun movimento');

  // Il passo non porta in acqua (mondo ostile): tre tentativi e un rifiuto tipizzato.
  const { adapter: stuck } = fluidAdapter({
    '3,71,0': water, '3,72,0': water, '3,73,0': water,
    '4,71,0': water, '4,72,0': water, '4,73,0': water,
    '5,71,0': water, '5,72,0': water, '5,73,0': water,
  });
  const tried = [];
  stuck._startMotion = (_path, goalNode) => { tried.push(goalNode); return Promise.resolve('stuck'); };
  const failed = await stuck.enterWater();
  assert.equal(failed.error, 'water_not_reached');
  assert.equal(failed.attempts.length, 3, 'prova le prime tre colonne, non tutte');
  assert.deepEqual(failed.attempts[0], {
    cell: { x: 3, y: 73, z: 0 }, depth: 3, reason: 'stuck', entered: false,
  });
  assert.ok(tried.every(node => node.y === 73), 'ogni tentativo mira alla superficie della colonna');

  stuck.riding = { riddenEntityId: '9' };
  assert.equal((await stuck.enterWater()).error, 'riding');
  stuck.riding = null;
  stuck.spawned = false;
  assert.equal((await stuck.enterWater()).error, 'not_spawned');
});

test('M1: enterWater scarta una colonna coperta e sceglie quella aperta', async () => {
  // Live 04/10: lo stagno del villaggio ha l'acqua a y=73-74 e una superficie
  // solida a y=75 — il passo verso la colonna arrivava sul coperchio e il
  // movimento lo dichiarava raggiunto (`|Δy| < 3`), quindi `enterWater` diceva
  // `water_not_reached` con l'acqua a due blocchi. Il coperchio si dichiara.
  const covered = { name: 'ice', boundingBox: 'block', diggable: true, hardness: 0.5 };
  const { adapter } = fluidAdapter({
    '3,71,0': water, '3,72,0': water, '3,73,0': water, '3,74,0': covered,
    '5,71,0': water, '5,72,0': water, '5,73,0': water,
  });
  const nodes = [];
  adapter._startMotion = (_path, goalNode, target) => {
    nodes.push(goalNode);
    adapter._feet = { x: target.x, y: goalNode.y - 1, z: target.z };
    return Promise.resolve('goal');
  };
  const report = await adapter.enterWater();
  assert.equal(report.ok, true, 'entra nella colonna aperta');
  assert.deepEqual(report.cell, { x: 5, y: 73, z: 0 }, 'la colonna coperta non viene nemmeno provata');
  assert.equal(nodes.length, 1);

  // Solo colonne coperte: si dichiara, elencando quelle scartate.
  const { adapter: onlyCovered } = fluidAdapter({
    '3,71,0': water, '3,72,0': water, '3,73,0': water, '3,74,0': covered,
  });
  let motions = 0;
  onlyCovered._startMotion = () => { motions++; return Promise.resolve('goal'); };
  const refused = await onlyCovered.enterWater();
  assert.equal(refused.error, 'water_covered');
  assert.deepEqual(refused.columns, [{ x: 3, y: 71, z: 0 }]);
  assert.equal(motions, 0, 'nessun passo verso un coperchio');
});

test('M1: enterWater non si tuffa in una colonna che sta in fondo a un dirupo', async () => {
  // Live 04/10: intorno al bot l'unica acqua profonda era un anfiteatro allagato
  // a y=56-58 mentre i piedi stavano a y=71 — `_stepToward` verso di lui avrebbe
  // portato il bot a camminare nel vuoto. La misura si fa dove si **entra**
  // camminando: una colonna a più di quattro blocchi sotto i piedi si rifiuta.
  const { adapter } = fluidAdapter({
    '3,56,0': water, '3,57,0': water, '3,58,0': water,
  });
  let motions = 0;
  adapter._startMotion = () => { motions++; return Promise.resolve('goal'); };
  const refused = await adapter.enterWater({ maxDistance: 8 });
  assert.equal(refused.error, 'no_water_at_level');
  assert.deepEqual(refused.columns, [{ x: 3, y: 56, z: 0 }], 'la colonna scartata è elencata');
  assert.equal(motions, 0, 'nessun passo verso il dirupo');

  // Tre blocchi sotto i piedi sono ancora un passo (si scende in acqua).
  const { adapter: lowBank } = fluidAdapter({
    '3,68,0': water, '3,69,0': water, '3,70,0': water,
  }, { feet: { x: 0.5, y: 71, z: 0.5 } });
  const nodes = [];
  lowBank._startMotion = (_path, goalNode, target) => {
    nodes.push(goalNode);
    lowBank._feet = { x: target.x, y: 68, z: target.z };
    return Promise.resolve('goal');
  };
  const report = await lowBank.enterWater();
  assert.equal(report.ok, true);
  assert.equal(report.depth, 3);
  assert.equal(report.headInWater, true);
  assert.equal(nodes.length, 1);
});
