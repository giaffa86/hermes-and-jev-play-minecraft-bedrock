import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';
import {
  isWaterBlock, isFishItem, isEdibleFish, fishCount, fishItems,
  shoreCandidates, nextBiteDelay, bobberVerdict, FISHING_ROD_INGREDIENTS,
  BITE_MS_MIN, BITE_MS_MAX,
} from '../bedrock-fishing.mjs';

test('water block detection ignores the minecraft prefix', () => {
  assert.equal(isWaterBlock('water'), true);
  assert.equal(isWaterBlock('minecraft:flowing_water'), true);
  assert.equal(isWaterBlock('still_water'), true);
  assert.equal(isWaterBlock('WATER'), true);
  assert.equal(isWaterBlock('stone'), false);
  assert.equal(isWaterBlock('lava'), false);
  assert.equal(isWaterBlock(undefined), false);
});

test('fish item classification: cod/salmon are edible, pufferfish/tropical are not', () => {
  assert.equal(isFishItem('cod'), true);
  assert.equal(isFishItem('minecraft:salmon'), true);
  assert.equal(isFishItem('pufferfish'), true);
  assert.equal(isFishItem('tropical_fish'), true);
  assert.equal(isFishItem('cooked_cod'), false);
  assert.equal(isFishItem('beef'), false);
  assert.equal(isEdibleFish('cod'), true);
  assert.equal(isEdibleFish('salmon'), true);
  assert.equal(isEdibleFish('pufferfish'), false);
  assert.equal(isEdibleFish('tropical_fish'), false);
});

test('fishCount and fishItems aggregate only fish, ignoring prefix and non-fish', () => {
  const inventory = { cod: 2, 'minecraft:salmon': 1, pufferfish: 3, beef: 5, cooked_cod: 1 };
  assert.equal(fishCount(inventory), 6);
  assert.deepEqual(fishItems(inventory), ['cod', 'pufferfish', 'salmon']);
  assert.equal(fishCount({}), 0);
  assert.deepEqual(fishItems({}), []);
});

test('fishing rod recipe needs 3 sticks and 2 string', () => {
  assert.deepEqual(FISHING_ROD_INGREDIENTS, { stick: 3, string: 2 });
});

test('shoreCandidates finds ground cells adjacent to water within cast range', () => {
  const blocks = [
    { name: 'water', position: { x: 10, y: 63, z: 10 } },
    { name: 'grass_block', position: { x: 11, y: 63, z: 10 } }, // adjacent to water + flowing_water (deduped)
    { name: 'dirt', position: { x: 10, y: 63, z: 11 } },        // adjacent to water
    { name: 'stone', position: { x: 10, y: 63, z: 9 } },        // adjacent to water
    { name: 'flowing_water', position: { x: 12, y: 63, z: 10 } },
    { name: 'grass_block', position: { x: 13, y: 63, z: 10 } }, // adjacent to flowing_water
  ];
  const from = { x: 11, y: 64, z: 10 };
  const candidates = shoreCandidates(blocks, from);
  assert.equal(candidates.length, 4);
  // Nearest first.
  assert.equal(candidates[0].name, 'grass_block');
  assert.equal(candidates[0].position.x, 11);
  assert.deepEqual(candidates[0].waterAt, { x: 10, y: 63, z: 10 });
  // Every candidate is a non-water block with a water cell at waterAt.
  for (const c of candidates) {
    assert.equal(isWaterBlock(c.name), false);
    assert.equal(isWaterBlock(blocks.find(b => b.position.x === c.waterAt.x && b.position.y === c.waterAt.y && b.position.z === c.waterAt.z).name), true);
  }
});

test('shoreCandidates respects castRange', () => {
  const blocks = [
    { name: 'water', position: { x: 0, y: 63, z: 0 } },
    { name: 'grass_block', position: { x: 1, y: 63, z: 0 } },
  ];
  const from = { x: 30, y: 64, z: 0 }; // far away
  assert.equal(shoreCandidates(blocks, from).length, 0);
  const near = { x: 1, y: 64, z: 0 };
  assert.equal(shoreCandidates(blocks, near).length, 1);
});

test('nextBiteDelay stays inside the vanilla 5–30 s window', () => {
  assert.ok(BITE_MS_MIN >= 5000 && BITE_MS_MAX <= 30000);
  for (let i = 0; i < 200; i++) {
    const d = nextBiteDelay();
    assert.ok(d >= BITE_MS_MIN && d <= BITE_MS_MAX, `delay ${d} out of range`);
  }
  assert.equal(nextBiteDelay(() => 0), BITE_MS_MIN);
  assert.equal(nextBiteDelay(() => 1), BITE_MS_MAX);
});

// --- Rilevamento del morso a livello di adapter (2026-10-03) ---------------
// Il morso arriva dal server come evento di protocollo `fish_hook_hook`; il
// fallback è l'affondo del bobber rispetto alla sua quota di riposo. Il calo
// del lancio non deve contare come morso.

function fishAdapter ({ ys, logs = [] } = {}) {
  const adapter = new BedrockAdapter({ logger: { log () {} }, onLog: (entry) => logs.push(entry) });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.position = { x: 0, y: 63, z: 0 };
  adapter.inventory = { fishing_rod: 1 };
  adapter.entities.set('9', { runtimeId: '9', type: 'fishing_hook', position: { x: 1, y: ys[0], z: 0 } });
  let i = 0;
  adapter._findBobber = () => {
    const y = ys[Math.min(i++, ys.length - 1)];
    if (y == null) return null;
    return { runtimeId: '9', type: 'fishing_hook', position: { x: 1, y, z: 0 } };
  };
  adapter._castRod = async () => ({ ok: true, waterAt: { x: 1, y: 63, z: 0 } });
  adapter._reelIn = async () => ({ ok: true, caught: [], gained: 0, note: 'no_bite' });
  adapter.logs = logs;
  return adapter;
}

test('the cast descent is not reported as a bite (no false positive)', async () => {
  // Il bobber scende dal lancio (63.00 → 62.80) e poi si posa a ~62.98:
  // con la vecchia logica la discesa superava subito la soglia di 0.2.
  const adapter = fishAdapter({ ys: [63.00, 62.80, 62.97, 62.99, 62.98, 62.98, 62.98, 62.98] });
  const result = await adapter._fish({ biteWindowMs: 250, settleTimeoutMs: 900, settleSamples: 2 });
  assert.equal(result.biteDetected, false, 'la discesa del lancio non è un morso');
  assert.equal(result.biteSource, null);
  assert.equal(result.note, 'no_bite');
});

test('a fish_hook_hook event marks the bite with its source', async () => {
  const adapter = fishAdapter({ ys: [62.98, 62.98, 62.98, 62.98, 62.98] });
  adapter._reelIn = async () => ({ ok: true, caught: ['cod'], gained: 1 });
  setTimeout(() => adapter._onEntityEvent({ runtime_entity_id: '9', event_id: 'fish_hook_hook' }), 150);
  const result = await adapter._fish({ biteWindowMs: 1500, settleTimeoutMs: 900, settleSamples: 2 });
  assert.equal(result.biteDetected, true);
  assert.equal(result.biteSource, 'event');
  assert.deepEqual(result.caught, ['cod']);
  assert.ok(adapter.logs.some(e => e.type === 'fish_bite'), 'evento fish_bite loggato');
});

test('the numeric event id 13 and the tease id 14 are understood', () => {
  const adapter = fishAdapter({ ys: [62.98] });
  adapter._onEntityEvent({ runtime_entity_id: '9', event_id: 13 });
  adapter._onEntityEvent({ runtime_entity_id: '9', event_id: 'fish_hook_tease' });
  assert.ok(adapter._fishBiteAt > 0, 'id numerico 13 = fish_hook_hook');
  assert.ok(adapter._fishTeaseAt > 0, 'fish_hook_tease registrato a parte');
  adapter._onEntityEvent({ runtime_entity_id: '9', event_id: 'jump' });
  assert.equal(adapter.logs.filter(e => e.type === 'fish_bite').length, 1);
});

test('a bite is registered even when the hook runtime id is unknown', () => {
  const adapter = fishAdapter({ ys: [62.98] });
  adapter._onEntityEvent({ runtime_entity_id: '9999', event_id: 'fish_hook_hook' });
  assert.ok(adapter._fishBiteAt > 0, 'il morso non deve dipendere dalla risoluzione dell entita');
  const bite = adapter.logs.filter(e => e.type === 'fish_bite');
  assert.equal(bite.length, 1);
  assert.equal(bite[0].runtimeId, '9999');
  assert.equal(bite[0].entityType, null);
});

test('the dip fallback needs two consecutive samples under the resting level', async () => {
  const adapter = fishAdapter({ ys: [62.98, 62.98, 62.98, 62.70, 62.68, 62.68] });
  const result = await adapter._fish({ biteWindowMs: 1500, settleTimeoutMs: 900, settleSamples: 2 });
  assert.equal(result.biteDetected, true);
  assert.equal(result.biteSource, 'dip');
  assert.ok(adapter.logs.some(e => e.type === 'fish_bite_detected' && e.source === 'dip'));
});

test('a single dip sample is not a bite', async () => {
  const adapter = fishAdapter({ ys: [62.98, 62.98, 62.98, 62.70, 62.98, 62.98, 62.98, 62.98] });
  const result = await adapter._fish({ biteWindowMs: 250, settleTimeoutMs: 900, settleSamples: 2 });
  assert.equal(result.biteDetected, false, 'il galleggiamento non è un morso');
  assert.equal(result.biteSource, null);
});

test('a bobber that disappears while settling is a typed failure', async () => {
  const adapter = fishAdapter({ ys: [63.5, null] });
  const result = await adapter._fish({ biteWindowMs: 300, settleTimeoutMs: 600, settleSamples: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'bobber_lost');
  assert.equal(result.biteDetected, false);
});

// --- Dove è finito il bobber (2026-10-04) ----------------------------------
// Un gancio che atterra sulla terraferma non prenderà mai nulla: aspettare la
// finestra del morso (5-30 s) e riportare `no_bite` accuserebbe il server a torto.

test('bobberVerdict: sulla terraferma il morso non può arrivare', () => {
  const world = {
    '3,63,0': 'grass_block',
    '3,62,0': 'dirt',
  };
  const v = bobberVerdict({
    bobber: { position: { x: 3.2, y: 63.1, z: 0.4 } },
    blockAt: p => (world[`${p.x},${p.y},${p.z}`] ? { name: world[`${p.x},${p.y},${p.z}`] } : null),
  });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'not_in_water');
  assert.equal(v.unknown, false);
  assert.deepEqual(v.cell, { x: 3, y: 63, z: 0 });
  assert.equal(v.at, 'grass_block');
  assert.equal(v.below, 'dirt');
  assert.equal(v.waterCell, null);
});

test('bobberVerdict: un bobber che galleggia sta nella cella sopra l\'acqua', () => {
  const world = { '3,63,0': 'water', '3,64,0': 'air' };
  const v = bobberVerdict({
    bobber: { position: { x: 3.5, y: 64.1, z: 0.5 } },
    blockAt: p => (world[`${p.x},${p.y},${p.z}`] ? { name: world[`${p.x},${p.y},${p.z}`] } : null),
  });
  assert.equal(v.ok, true);
  assert.equal(v.reason, 'on_surface');
  assert.deepEqual(v.waterCell, { x: 3, y: 63, z: 0 });
  assert.equal(v.covered, false, 'superficie aperta');
  assert.equal(v.above, 'air');
});

test('bobberVerdict: acqua coperta — il dato che serve alla diagnosi (il pozzo)', () => {
  const world = { '3,63,0': 'water', '3,64,0': 'oak_planks' };
  const v = bobberVerdict({
    bobber: { position: { x: 3.5, y: 64.1, z: 0.5 } },
    blockAt: p => (world[`${p.x},${p.y},${p.z}`] ? { name: world[`${p.x},${p.y},${p.z}`] } : null),
  });
  assert.equal(v.ok, true, 'in acqua resta in acqua');
  assert.equal(v.covered, true);
  assert.equal(v.above, 'oak_planks');
});

test('bobberVerdict: fail-open su un mondo che non si sa leggere', () => {
  assert.equal(bobberVerdict({}).reason, 'no_bobber');
  assert.equal(bobberVerdict({ bobber: { position: { x: 1, y: 2, z: 3 } } }).unknown, true);
  const blind = bobberVerdict({ bobber: { position: { x: 1.2, y: 2.9, z: 3.2 } }, blockAt: () => null });
  assert.equal(blind.ok, false);
  assert.equal(blind.reason, 'not_in_water');
  assert.equal(blind.unknown, true, 'celle non caricate: non è una prova');
});

function castFixture ({ blockAt, bobber = { x: 4.5, y: 64.1, z: 0.5 } } = {}) {
  const logs = [];
  const adapter = new BedrockAdapter({ logger: { log () {} }, onLog: e => logs.push(e) });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.position = { x: 0, y: 64, z: 0 };
  adapter.inventory = { fishing_rod: 1 };
  adapter.inventorySlots = [{ name: 'fishing_rod', count: 1, network_id: 1 }];
  adapter.selectedHotbar = 0;
  adapter.world = { blockAt: p => blockAt(p) };
  adapter._findFishingSpot = () => ({ name: 'sand', position: { x: 1, y: 63, z: 0 }, waterAt: { x: 2, y: 63, z: 0 }, distance: 1 });
  adapter._selectHotbarSlot = () => true;
  adapter._lookAt = () => ({ yaw: 0, pitch: 0 });
  adapter._queueAuthInput = async () => true;
  adapter._useItemTransaction = () => ({ type_id: 'use_item' });
  adapter._pointDistance = () => 1;
  adapter._findBobber = () => ({ runtimeId: '9', type: 'fishing_hook', position: bobber });
  adapter.reels = 0;
  adapter._reelIn = async () => { adapter.reels++; return { ok: true, caught: [], gained: 0 }; };
  adapter.logs = logs;
  return adapter;
}

test('_castRod rifiuta il lancio finito sulla terraferma e recupera la lenza', async () => {
  const world = { '4,64,0': 'grass_block', '4,63,0': 'dirt' };
  const adapter = castFixture({ blockAt: p => (world[`${p.x},${p.y},${p.z}`] ? { name: world[`${p.x},${p.y},${p.z}`] } : null) });
  const result = await adapter._castRod({ timeoutMs: 2000 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'bobber_not_in_water');
  assert.equal(result.verdict.reason, 'not_in_water');
  assert.equal(adapter.reels, 1, 'la lenza si recupera invece di restare fuori 30 s');
  assert.ok(adapter.logs.some(e => e.type === 'bobber_not_in_water'), 'rifiuto loggato');
});

test('_castRod conferma un bobber sulla superficie e segnala l\'acqua coperta', async () => {
  const open = { '4,63,0': 'water', '4,64,0': 'air' };
  const covered = { '4,63,0': 'water', '4,64,0': 'oak_planks' };
  const asWorld = w => (p => (w[`${p.x},${p.y},${p.z}`] ? { name: w[`${p.x},${p.y},${p.z}`] } : null));

  const ok = await castFixture({ blockAt: asWorld(open) })._castRod({ timeoutMs: 2000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.verdict.reason, 'on_surface');
  assert.equal(ok.verdict.covered, false);

  const lid = castFixture({ blockAt: asWorld(covered) });
  const coveredReport = await lid._castRod({ timeoutMs: 2000 });
  assert.equal(coveredReport.ok, true, 'coperta resta un lancio valido');
  assert.equal(coveredReport.verdict.covered, true);
  assert.ok(lid.logs.some(e => e.type === 'bobber_water_covered'), 'la copertura è loggata per la diagnosi');
});
