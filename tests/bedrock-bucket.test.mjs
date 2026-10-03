import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUCKET_ITEM,
  WATER_BUCKET_ITEM,
  LAVA_BUCKET_ITEM,
  MILK_BUCKET_ITEM,
  POWDER_SNOW_BUCKET_ITEM,
  WATER_BOTTLE_ITEM,
  BREW_FUEL,
  BREW_BASE,
  BREW_EFFECTS,
  isBucketItem,
  isBoatItem,
  bucketSourceVerdict,
  placeBucketVerdict,
  bucketDelta,
  boatVerdict,
  brewPlan,
} from '../bedrock-bucket.mjs';

const block = (name) => ({ name });

test('isBucketItem knows the five buckets and refuses everything else', () => {
  assert.equal(isBucketItem(BUCKET_ITEM), true);
  assert.equal(isBucketItem(WATER_BUCKET_ITEM), true);
  assert.equal(isBucketItem(LAVA_BUCKET_ITEM), true);
  assert.equal(isBucketItem(MILK_BUCKET_ITEM), true);
  assert.equal(isBucketItem(POWDER_SNOW_BUCKET_ITEM), true);
  assert.equal(isBucketItem('oak_planks'), false);
  assert.equal(isBucketItem(null), false);
});

test('isBoatItem accepts the wood variants and the raft', () => {
  assert.equal(isBoatItem('boat'), true);
  assert.equal(isBoatItem('oak_boat'), true);
  assert.equal(isBoatItem('mangrove_chest_boat'), true);
  assert.equal(isBoatItem('bamboo_raft'), true);
  assert.equal(isBoatItem('minecart'), false);
  assert.equal(isBoatItem(null), false);
});

test('a bucket only fills from a source: flowing water and flowing lava are refused', () => {
  assert.deepEqual(bucketSourceVerdict({ block: block('water') }), { fillable: true, item: WATER_BUCKET_ITEM, name: 'water', reason: 'water_source' });
  assert.deepEqual(bucketSourceVerdict({ block: block('minecraft:water') }).item, WATER_BUCKET_ITEM);
  const flowing = bucketSourceVerdict({ block: block('flowing_water') });
  assert.equal(flowing.fillable, false);
  assert.equal(flowing.reason, 'flowing_water');
  assert.equal(bucketSourceVerdict({ block: block('lava') }).item, LAVA_BUCKET_ITEM);
  assert.equal(bucketSourceVerdict({ block: block('flowing_lava') }).reason, 'flowing_lava');
  assert.equal(bucketSourceVerdict({ block: block('powder_snow') }).item, POWDER_SNOW_BUCKET_ITEM);
  assert.equal(bucketSourceVerdict({ block: block('stone') }).reason, 'not_a_source');
  assert.equal(bucketSourceVerdict({ block: null }).reason, 'unknown_block');
  // Un blocco `unknown` non è una sorgente: meglio non riempire che inventare.
  assert.equal(bucketSourceVerdict({ block: block('unknown') }).fillable, false);
});

test('emptying water onto lava turns it into obsidian, flowing lava into cobblestone', () => {
  const onLava = placeBucketVerdict({ held: WATER_BUCKET_ITEM, block: block('lava') });
  assert.deepEqual([onLava.ok, onLava.result, onLava.reason], [true, 'obsidian', 'water_on_lava_source']);
  const onFlowing = placeBucketVerdict({ held: WATER_BUCKET_ITEM, block: block('flowing_lava') });
  assert.deepEqual([onFlowing.ok, onFlowing.result], [true, 'cobblestone']);
  const onAir = placeBucketVerdict({ held: WATER_BUCKET_ITEM, block: block('air') });
  assert.deepEqual([onAir.ok, onAir.result, onAir.reason], [true, 'water', 'water_source']);
  const onGrass = placeBucketVerdict({ held: WATER_BUCKET_ITEM, block: block('tall_grass') });
  assert.equal(onGrass.ok, true);
  const onStone = placeBucketVerdict({ held: WATER_BUCKET_ITEM, block: block('stone') });
  assert.equal(onStone.error, 'blocked');
});

test('water cannot be placed in the Nether or the End, and milk cannot be poured', () => {
  for (const dimension of ['nether', 'the_nether', 'the_end', 'end']) {
    const verdict = placeBucketVerdict({ held: WATER_BUCKET_ITEM, block: block('air'), dimension });
    assert.equal(verdict.ok, false, dimension);
    assert.equal(verdict.error, 'water_in_nether', dimension);
  }
  // La lava invece si può piazzare nel Nether, e sull'acqua diventa pietra.
  assert.equal(placeBucketVerdict({ held: LAVA_BUCKET_ITEM, block: block('air'), dimension: 'nether' }).ok, true);
  const onWater = placeBucketVerdict({ held: LAVA_BUCKET_ITEM, block: block('water') });
  assert.deepEqual([onWater.ok, onWater.result], [true, 'stone']);
  assert.equal(placeBucketVerdict({ held: MILK_BUCKET_ITEM, block: block('air') }).error, 'not_placeable');
  assert.equal(placeBucketVerdict({ held: BUCKET_ITEM, block: block('air') }).error, 'nothing_to_empty');
  assert.equal(placeBucketVerdict({ held: null, block: block('air') }).error, 'nothing_to_empty');
});

test('bucketDelta confirms a fill from the inventory delta alone', () => {
  const filled = bucketDelta({ before: { bucket: 2 }, after: { bucket: 1, water_bucket: 1 }, item: WATER_BUCKET_ITEM });
  assert.deepEqual([filled.ok, filled.gained, filled.spent, filled.delta.water_bucket], [true, 1, 1, 1]);
  const placed = bucketDelta({ before: { water_bucket: 1 }, after: { bucket: 1 }, item: WATER_BUCKET_ITEM });
  assert.equal(placed.ok, false);
  assert.equal(placed.gained, 0);
  assert.equal(placed.spent, 0);
  assert.equal(placed.delta.bucket, 1);
  const unchanged = bucketDelta({ before: { bucket: 1 }, after: { bucket: 1 }, item: WATER_BUCKET_ITEM });
  assert.deepEqual(unchanged, { delta: {}, gained: 0, spent: 0, ok: false });
});

test('bucketDelta counts the spent container of a bottle too', () => {
  const filled = bucketDelta({ before: { glass_bottle: 2 }, after: { glass_bottle: 1, potion: 1 }, item: 'potion', spentItem: 'glass_bottle' });
  assert.deepEqual([filled.ok, filled.gained, filled.spent], [true, 1, 1]);
  const wrong = bucketDelta({ before: { glass_bottle: 2 }, after: { glass_bottle: 1, potion: 1 }, item: 'potion' });
  assert.equal(wrong.ok, false, 'senza dichiarare la fiala consumata non c\'è conferma');
});

test('a boat needs open water and an empty seat', () => {
  const water = { count: 8, nearest: { distance: 4 } };
  assert.deepEqual(boatVerdict({ boats: 1, water }), { ok: true, error: null, waterCount: 8, waterDistance: 4, reason: 'open_water' });
  assert.equal(boatVerdict({ boats: 1, water, riding: true }).error, 'already_riding');
  assert.equal(boatVerdict({ boats: 0, water }).error, 'missing_boat');
  assert.equal(boatVerdict({ boats: 1, water: { count: 2, nearest: { distance: 3 } } }).error, 'no_water_nearby');
  assert.equal(boatVerdict({ boats: 1, water: { count: 40, nearest: { distance: 40 } } }).error, 'no_water_nearby');
  assert.equal(boatVerdict({ boats: 1, water: null }).error, 'no_water_nearby');
  // La distanza può arrivare anche come campo esplicito (dal censimento).
  assert.equal(boatVerdict({ boats: 1, water: { count: 5 }, waterDistance: 2 }).ok, true);
});

test('brewPlan lists the steps and reports the first missing material', () => {
  const ready = brewPlan({ effect: 'water_breathing', stand: true, fuel: 1, waterBottles: 1, netherWart: 1, ingredients: { pufferfish: 1 } });
  assert.equal(ready.ok, true);
  assert.equal(ready.ingredient, 'pufferfish');
  assert.equal(ready.fuel, BREW_FUEL);
  assert.equal(ready.steps.length, 3);
  assert.match(ready.steps[1], new RegExp(BREW_BASE));

  const noStand = brewPlan({ effect: 'water_breathing', fuel: 9, waterBottles: 9, netherWart: 9, ingredients: { pufferfish: 9 } });
  assert.equal(noStand.error, 'missing_brewing_stand');
  assert.deepEqual(noStand.missing, ['brewing_stand']);
  assert.equal(brewPlan({ effect: 'water_breathing', stand: true, waterBottles: 1, netherWart: 1, ingredients: { pufferfish: 1 } }).error, `missing_${BREW_FUEL}`);
  assert.equal(brewPlan({ effect: 'water_breathing', stand: true, fuel: 1, netherWart: 1, ingredients: { pufferfish: 1 } }).error, `missing_${WATER_BOTTLE_ITEM}`);
  assert.equal(brewPlan({ effect: 'fire_resistance', stand: true, fuel: 1, waterBottles: 1, ingredients: { magma_cream: 1 } }).error, `missing_${BREW_BASE}`);
  const noIngredient = brewPlan({ effect: 'night_vision', stand: true, fuel: 1, waterBottles: 1, netherWart: 1 });
  assert.equal(noIngredient.error, 'missing_golden_carrot');
  assert.deepEqual(noIngredient.missing, ['golden_carrot']);
  assert.equal(brewPlan({ effect: 'strength', stand: true, fuel: 1, waterBottles: 1, netherWart: 1 }).error, 'unknown_recipe');
  assert.deepEqual(BREW_EFFECTS.sort(), ['fire_resistance', 'night_vision', 'water_breathing']);
});
