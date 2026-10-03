import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUBBLE_MIN_HEIGHT,
  WATERFALL_MIN_HEIGHT,
  columnTactic,
  findBubbleColumns,
  findWaterfalls,
  landingVerdict,
  summarizeColumn,
  withinColumn,
} from '../bedrock-waterfall.mjs';

const cell = (name, x, y, z) => ({ name, position: { x, y, z } });

// Mappa di blocco per gli atterraggi: `blockAt` la usa per guardare sotto la
// colonna quando la cella non è già fra i blocchi passati.
const world = rows => {
  const map = new Map(rows.map(row => [`${row.position.x},${row.position.y},${row.position.z}`, row]));
  return {
    get: position => map.get(`${position.x},${position.y},${position.z}`) ?? null,
  };
};

test('landingVerdict classifies water, hazards, air, solid and unknown landings', () => {
  assert.deepEqual(landingVerdict(cell('water', 0, 0, 0)), { safe: true, kind: 'water', name: 'water' });
  assert.deepEqual(landingVerdict(cell('flowing_water', 0, 0, 0)), { safe: true, kind: 'water', name: 'flowing_water' });
  for (const name of ['lava', 'flowing_lava', 'magma', 'cactus', 'sweet_berry_bush', 'pointed_dripstone']) {
    assert.equal(landingVerdict(cell(name, 0, 0, 0)).safe, false, name);
    assert.equal(landingVerdict(cell(name, 0, 0, 0)).kind, 'hazard', name);
  }
  assert.deepEqual(landingVerdict(cell('air', 0, 0, 0)), { safe: false, kind: 'air', name: 'air' });
  assert.deepEqual(landingVerdict(cell('cave_air', 0, 0, 0)), { safe: false, kind: 'air', name: 'cave_air' });
  assert.deepEqual(landingVerdict(cell('stone', 0, 0, 0)), { safe: true, kind: 'solid', name: 'stone' });
  // Senza informazione non si dichiara sicuro: null, non true.
  assert.deepEqual(landingVerdict(null), { safe: null, kind: 'unknown', name: null });
  assert.deepEqual(landingVerdict({ position: { x: 0, y: 0, z: 0 } }), { safe: null, kind: 'unknown', name: null });
});

test('findWaterfalls needs a real vertical column with a safe landing', () => {
  const blocks = [
    cell('water', 5, 70, 5),
    cell('flowing_water', 5, 69, 5),
    cell('flowing_water', 5, 68, 5),
  ];
  const below = world([cell('stone', 5, 67, 5)]);
  const from = { x: 5.5, y: 72, z: 5.5 };

  const falls = findWaterfalls(blocks, { from, blockAt: below.get });
  assert.equal(falls.length, 1);
  assert.deepEqual(falls[0].top, { x: 5, y: 70, z: 5 });
  assert.deepEqual(falls[0].bottom, { x: 5, y: 68, z: 5 });
  assert.equal(falls[0].height, 3);
  assert.equal(falls[0].source, 'water');
  assert.equal(falls[0].landing.safe, true);
  assert.equal(falls[0].landing.kind, 'solid');
  assert.equal(falls[0].distance, 2.1);

  // Due celle non sono una cascata (soglia 3), ma lo diventano con minHeight 2.
  const short = [cell('water', 1, 10, 1), cell('water', 1, 9, 1)];
  assert.equal(findWaterfalls(short, { blockAt: () => cell('stone', 0, 0, 0) }).length, 0);
  assert.equal(findWaterfalls(short, { minHeight: 2, blockAt: () => cell('stone', 0, 0, 0) }).length, 1);
  assert.equal(WATERFALL_MIN_HEIGHT, 3);
});

test('findWaterfalls refuses a hazard landing and an unknown one, unless asked', () => {
  const blocks = [cell('water', 2, 20, 2), cell('water', 2, 19, 2), cell('water', 2, 18, 2)];
  const lava = world([cell('lava', 2, 17, 2)]);
  assert.deepEqual(findWaterfalls(blocks, { blockAt: lava.get }), []);
  const unsafe = findWaterfalls(blocks, { blockAt: lava.get, includeUnsafe: true });
  assert.equal(unsafe.length, 1);
  assert.equal(unsafe[0].landing.safe, false);

  // Nessun `blockAt` e nessuna cella sotto la colonna: atterraggio ignoto.
  assert.deepEqual(findWaterfalls(blocks), []);
  const unknown = findWaterfalls(blocks, { includeUnsafe: true });
  assert.equal(unknown[0].landing.safe, null);
});

test('findWaterfalls ranks by distance then height and respects the limit', () => {
  const blocks = [
    cell('water', 30, 20, 30), cell('water', 30, 19, 30), cell('water', 30, 18, 30),
    cell('water', 3, 20, 3), cell('water', 3, 19, 3), cell('water', 3, 18, 3), cell('water', 3, 17, 3),
    cell('water', 40, 20, 40), cell('water', 40, 19, 40), cell('water', 40, 18, 40),
  ];
  const solid = () => cell('stone', 0, 0, 0);
  const from = { x: 20, y: 22, z: 20 };
  const ranked = findWaterfalls(blocks, { from, blockAt: solid, limit: 2 });
  assert.equal(ranked.length, 2);
  assert.ok(ranked[0].distance <= ranked[1].distance);
  assert.deepEqual([ranked[0].x, ranked[1].x], [30, 3]);
  // Con il limite alzato l'ordine resta per distanza, e l'altezza non lo scavalca.
  const all = findWaterfalls(blocks, { from, blockAt: solid, limit: 3 });
  assert.deepEqual(all.map(entry => entry.x), [30, 3, 40]);
  assert.deepEqual(all.map(entry => entry.height), [3, 4, 3]);
});

test('findBubbleColumns reads soul sand as up and magma as down', () => {
  const blocks = [
    cell('water', 7, 64, 7), cell('water', 7, 65, 7),
    cell('water', 9, 64, 9), cell('water', 9, 65, 9),
    cell('water', 11, 64, 11), cell('water', 11, 65, 11),
  ];
  const below = world([
    cell('soul_sand', 7, 63, 7),
    cell('magma', 9, 63, 9),
    cell('stone', 11, 63, 11),
  ]);
  const found = findBubbleColumns(blocks, { from: { x: 7.5, y: 66, z: 7.5 }, blockAt: below.get });
  assert.equal(found.length, 2);
  const up = found.find(entry => entry.direction === 'up');
  const down = found.find(entry => entry.direction === 'down');
  assert.equal(up.source, 'soul_sand');
  assert.equal(up.airRefill, true);
  assert.equal(up.height, 2);
  assert.equal(down.source, 'magma');
  assert.equal(down.airRefill, false);
  assert.equal(BUBBLE_MIN_HEIGHT, 2);
  // La colonna su pietra non è una colonna di bolle.
  assert.equal(found.some(entry => entry.x === 11), false);
});

test('withinColumn matches the bot cell against the column span', () => {
  const column = { x: 5, z: 5, top: { x: 5, y: 70, z: 5 }, bottom: { x: 5, y: 66, z: 5 } };
  assert.equal(withinColumn(column, { x: 5.5, y: 68, z: 5.5 }), true);
  assert.equal(withinColumn(column, { x: 5.5, y: 70.9, z: 5.5 }), true);
  assert.equal(withinColumn(column, { x: 5.5, y: 65.4, z: 5.5 }), false);
  assert.equal(withinColumn(column, { x: 5.5, y: 72, z: 5.5 }), false);
  assert.equal(withinColumn(column, { x: 6.5, y: 68, z: 5.5 }), false);
  assert.equal(withinColumn(null, { x: 5, y: 68, z: 5 }), false);
});

test('columnTactic refuses honestly before promising a descent', () => {
  const column = {
    x: 5,
    z: 5,
    top: { x: 5, y: 70, z: 5 },
    bottom: { x: 5, y: 66, z: 5 },
    height: 5,
    direction: null,
    landing: { position: { x: 5, y: 65, z: 5 }, name: 'water', safe: true, kind: 'water' },
  };
  const feet = { x: 5.5, y: 71, z: 5.5 };

  // Nessuna colonna.
  assert.equal(columnTactic({ column: null }).error, 'no_column');

  // L'atterraggio pericoloso e quello ignoto vincono sul resto.
  const badLanding = { ...column, landing: { ...column.landing, safe: false } };
  assert.equal(columnTactic({ column: badLanding, feet }).error, 'unsafe_landing');
  const unknownLanding = { ...column, landing: { position: { x: 5, y: 65, z: 5 }, name: null, safe: null, kind: 'unknown' } };
  assert.equal(columnTactic({ column: unknownLanding, feet }).error, 'unknown_landing');

  // Distanza massima.
  assert.equal(columnTactic({ column, feet, distance: 40 }).error, 'too_far');

  // Senza il movimento in acqua (M1) non si scende: rifiuto tipizzato.
  assert.equal(columnTactic({ column, feet, swimSupported: false }).error, 'swimming_unavailable');

  // Con il nuoto disponibile serve l'aria per tutta la colonna.
  const dry = columnTactic({ column, feet, swimSupported: true, air: 300 });
  assert.equal(dry.ok, true);
  assert.equal(dry.reason, 'descend_waterfall');
  assert.equal(dry.plan.ok, true);
  assert.equal(columnTactic({ column, feet, swimSupported: true, air: 60 }).error, 'air_too_low');
  assert.equal(columnTactic({ column, feet, swimSupported: true, air: null }).error, 'unknown_air');
  // Con Water Breathing il budget non serve.
  assert.equal(columnTactic({ column, feet, swimSupported: true, waterBreathing: true }).reason, 'descend_waterfall');

  // Già dentro la colonna: non si rientra.
  const inside = columnTactic({ column, feet: { x: 5.5, y: 68, z: 5.5 }, swimSupported: true, air: 300 });
  assert.equal(inside.ok, true);
  assert.equal(inside.reason, 'already_inside');

  // Salita: stessa disciplina di budget.
  assert.equal(columnTactic({ kind: 'climb', column, feet, swimSupported: true, air: 300 }).reason, 'climb_waterfall');

  // Colonna di bolle: verso l'alto ripristina l'aria, verso il basso serve lo sneak.
  const up = { ...column, direction: 'up', source: 'soul_sand', airRefill: true };
  const bubbleUp = columnTactic({ kind: 'bubble', column: up, feet, swimSupported: true, air: null });
  assert.equal(bubbleUp.ok, true);
  assert.equal(bubbleUp.reason, 'bubble_column');
  assert.equal(bubbleUp.plan, null);
  // Anche la colonna di bolle richiede di poter entrare in acqua.
  assert.equal(columnTactic({ kind: 'bubble', column: up, feet, swimSupported: false }).error, 'swimming_unavailable');
  const down = { ...column, direction: 'down', source: 'magma', airRefill: false };
  assert.equal(columnTactic({ kind: 'bubble', column: down, feet, swimSupported: true, air: 300 }).error, 'sneak_not_supported');
});

test('summarizeColumn keeps the compact row and computes the distance', () => {
  const column = {
    x: 5,
    z: 5,
    top: { x: 5, y: 70, z: 5 },
    bottom: { x: 5, y: 68, z: 5 },
    height: 3,
    source: 'flowing_water',
    landing: { position: { x: 5, y: 67, z: 5 }, name: 'stone', safe: true, kind: 'solid' },
  };
  assert.equal(summarizeColumn(null), null);
  const row = summarizeColumn(column, { x: 5.5, y: 72, z: 5.5 });
  assert.equal(row.x, 5);
  assert.equal(row.height, 3);
  assert.equal(row.direction, null);
  assert.equal(row.landing.name, 'stone');
  assert.equal(row.distance, 2.1);
});
