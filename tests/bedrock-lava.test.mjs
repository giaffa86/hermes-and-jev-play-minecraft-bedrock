import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cellKey,
  lavaCellKeys,
  inLava,
  lavaDistance,
  deathVerdict,
  lostDrops,
  safeShorePlan,
  fireResistance,
  lavaGap,
  lavaCrossingGate,
  LAVA_DEATH_RADIUS,
  LAVA_CROSS_GAP_LIMIT,
} from '../bedrock-lava.mjs';

const pool = (x, z, y = 62, size = 2) => {
  const cells = [];
  for (let dx = 0; dx < size; dx++) for (let dz = 0; dz < size; dz++) cells.push({ x: x + dx, y, z: z + dz });
  return cells;
};

test('cellKey and inLava floor the coordinates', () => {
  const lava = [{ x: 4, y: 62, z: -3 }];
  const keys = lavaCellKeys(lava);
  assert.equal(cellKey({ x: 4.7, y: 62.9, z: -2.2 }), '4,62,-3');
  assert.equal(inLava({ x: 4.2, y: 62, z: -3 }, keys), true);
  assert.equal(inLava({ x: 5, y: 62, z: -3 }, keys), false);
  assert.equal(inLava(null, keys), false);
  assert.equal(lavaCellKeys([]).size, 0);
});

test('lavaDistance is the closest cell, or null without a census', () => {
  const lava = [{ x: 0, y: 62, z: 0 }, { x: 3, y: 62, z: 4 }];
  assert.equal(lavaDistance({ x: 0, y: 62, z: 1 }, lava), 1);
  assert.equal(lavaDistance({ x: 0, y: 62, z: 1 }, []), null);
  assert.equal(lavaDistance(null, lava), null);
});

test('a death inside or beside lava is not recoverable', () => {
  const lava = pool(10, 10);
  const inside = deathVerdict({ position: { x: 10, y: 62, z: 11 }, lava });
  assert.equal(inside.inLava, true);
  assert.equal(inside.recoverable, false);
  assert.equal(inside.reason, 'in_lava');
  const beside = deathVerdict({ position: { x: 8.5, y: 62, z: 11 }, lava, radius: LAVA_DEATH_RADIUS });
  assert.equal(beside.inLava, false);
  assert.equal(beside.recoverable, false);
  assert.equal(beside.reason, 'lava_near');
  assert.equal(beside.nearest, 1.5);
  const away = deathVerdict({ position: { x: 0, y: 64, z: 0 }, lava });
  assert.equal(away.recoverable, true);
  assert.equal(away.reason, 'safe');
  const unknown = deathVerdict({});
  assert.equal(unknown.known, false);
  assert.equal(unknown.recoverable, null);
  assert.equal(unknown.reason, 'unknown_site');
});

test('drops lying in lava are listed as lost and never chased', () => {
  const lava = pool(4, 4, 61);
  const drops = [
    { id: 1, item: 'iron_ingot', position: { x: 4, y: 61, z: 5 } },
    { id: 2, item: 'dirt', position: { x: 9, y: 61, z: 9 } },
    { id: 3, item: 'oak_log', position: { x: 4, y: 63, z: 5 } },
  ];
  const lost = lostDrops(drops, lava);
  assert.deepEqual(lost, [{ id: 1, item: 'iron_ingot', position: { x: 4, y: 61, z: 5 } }]);
  assert.deepEqual(lostDrops(drops, []), []);
  assert.deepEqual(lostDrops([], lava), []);
});

test('safeShorePlan prefers a water shore over a bare one, and refuses the lava edge', () => {
  const hazards = pool(0, 0, 62, 3); // 3x3 lava at the origin
  const from = { x: 3, y: 62, z: 3 };
  const water = [{ x: 7, y: 62, z: 3 }];
  const plan = safeShorePlan({
    from,
    candidates: [
      { x: 1, y: 62, z: 1 }, // still on the lava edge: refused by minGap
      { x: 6, y: 62, z: 6 }, // far enough, no water
      { x: 6, y: 62, z: 3 }, // far enough, water beside
    ],
    hazards,
    water,
    minGain: 1.5,
  });
  assert.equal(plan.length, 2);
  assert.deepEqual(plan[0].cell, { x: 6, y: 62, z: 3 });
  assert.equal(plan[0].waterAdjacent, true);
  assert.ok(plan[0].score > plan[1].score);
  assert.equal(plan[1].waterAdjacent, false);
  assert.deepEqual(safeShorePlan({ from: null, candidates: [{ x: 1, y: 1, z: 1 }], hazards }), []);
  // Nessun candidato che guadagni distanza: nessuna sponda.
  assert.deepEqual(safeShorePlan({ from, candidates: [{ x: 2, y: 62, z: 2 }], hazards }), []);
});

test('fireResistance reads the bot effect map and ignores expired entries', () => {
  const active = new Map([['fire_resistance', { name: 'FireResistance', duration: 200, expiresAt: Date.now() + 10000 }]]);
  assert.equal(fireResistance({ effects: active }).active, true);
  assert.equal(fireResistance({ effects: active }).seconds, 10);
  const expired = new Map([['fire_resistance', { name: 'fire_resistance', seconds: 0 }]]);
  assert.equal(fireResistance({ effects: expired }).active, false);
  const other = new Map([['water_breathing', { name: 'water_breathing', seconds: 30 }]]);
  assert.equal(fireResistance({ effects: other }).active, false);
  assert.equal(fireResistance({}).active, false);
});

test('lavaGap measures the first run of lava along a direction and marks truncation', () => {
  const lava = [{ x: 1, y: 62, z: 0 }, { x: 2, y: 62, z: 0 }, { x: 3, y: 62, z: 0 }];
  const measured = lavaGap({ from: { x: 0, y: 62, z: 0 }, direction: { x: 1, z: 0 }, lava });
  assert.equal(measured.gap, 3);
  assert.equal(measured.firstStep, 1);
  assert.equal(measured.lastStep, 3);
  assert.equal(measured.truncated, false);
  assert.equal(measured.reason, 'measured');
  // La sponda opposta oltre il raggio: niente larghezza inventata.
  const cut = lavaGap({ from: { x: 0, y: 62, z: 0 }, direction: { x: 1, z: 0 }, lava, maxSteps: 2 });
  assert.equal(cut.truncated, true);
  assert.equal(cut.reason, 'truncated');
  // Lava non sulla direttrice (o a un'altra quota): nessun attraversamento.
  assert.equal(lavaGap({ from: { x: 0, y: 62, z: 0 }, direction: { x: 1, z: 0 }, lava: [{ x: 2, y: 62, z: 5 }] }).gap, 0);
  assert.equal(lavaGap({ from: { x: 0, y: 62, z: 0 }, direction: { x: 1, z: 0 }, lava: [{ x: 2, y: 80, z: 0 }] }).gap, 0);
  assert.equal(lavaGap({ from: { x: 0, y: 62, z: 0 }, direction: { x: 1, z: 0 }, lava: [] }).reason, 'no_lava');
  assert.equal(lavaGap({ from: null, direction: { x: 1, z: 0 }, lava }).reason, 'missing_inputs');
  assert.equal(lavaGap({ from: { x: 0, y: 62, z: 0 }, direction: { x: 0, z: 0 }, lava }).reason, 'missing_inputs');
});

test('lavaCrossingGate refuses without equipment and names what is missing', () => {
  const empty = lavaCrossingGate({ gap: 2 });
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'not_equipped');
  assert.deepEqual(empty.needs, { blocks: 3, waterBuckets: 1 });
  const wide = lavaCrossingGate({ gap: LAVA_CROSS_GAP_LIMIT + 2, bridgeBlocks: 20 });
  assert.equal(wide.error, 'gap_too_wide');
  assert.equal(wide.limit, LAVA_CROSS_GAP_LIMIT);
  assert.equal(lavaCrossingGate({ gap: null }).error, 'gap_unknown');
  const noResistance = lavaCrossingGate({ gap: 3, bridgeBlocks: 4 });
  assert.equal(noResistance.error, 'no_fire_resistance');
  assert.deepEqual(noResistance.needs, { fireResistance: true });
  // Un buco di un blocco si scavalca senza pozione.
  assert.equal(lavaCrossingGate({ gap: 1, bridgeBlocks: 2, requireResistanceOver: 2 }).ok, true);
});

test('water cannot cross lava in the Nether or the End', () => {
  const nether = lavaCrossingGate({ dimension: 'nether', gap: 2, waterBuckets: 1 });
  assert.equal(nether.ok, false);
  assert.equal(nether.error, 'water_in_nether');
  assert.equal(nether.waterAllowed, false);
  assert.equal(nether.needs.blocks, 3);
  // Con i blocchi giusti la via esiste, ma serve la resistenza al fuoco.
  const bridged = lavaCrossingGate({ dimension: 'nether', gap: 2, bridgeBlocks: 5, waterBuckets: 0 });
  assert.equal(bridged.error, 'no_fire_resistance');
  const ready = lavaCrossingGate({ dimension: 'nether', gap: 2, bridgeBlocks: 5, fireResistance: true });
  assert.equal(ready.ok, true);
  assert.equal(ready.route, 'bridge');
  assert.equal(ready.blocks, 3);
  // Nell'Overworld la via dell'acqua è legittima.
  const overworld = lavaCrossingGate({ gap: 2, waterBuckets: 1, fireResistance: true });
  assert.equal(overworld.ok, true);
  assert.equal(overworld.route, 'water');
  assert.equal(overworld.blocks, 0);
});
