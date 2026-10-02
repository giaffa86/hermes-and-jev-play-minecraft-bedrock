import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isWaterBlock, isFishItem, isEdibleFish, fishCount, fishItems,
  shoreCandidates, nextBiteDelay, FISHING_ROD_INGREDIENTS,
  BITE_MS_MIN, BITE_MS_MAX, CAST_RANGE,
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
