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
  assert.equal(view.air, null, 'il budget d\'aria non è ancora osservato');
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
