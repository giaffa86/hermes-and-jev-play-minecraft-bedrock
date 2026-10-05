import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VILLAGE_CHORES, deriveVillageChores, nextVillageChore, isChoreResolved,
  choreGain, babyCount, villageSnapshot, offeredHas, offeredMatches,
  DEFAULT_VILLAGE_COOLDOWN_MS,
} from '../village-labor.mjs';

const base = (over = {}) => ({
  position: { x: 0, y: 64, z: 0 },
  inventory: {},
  nearby: {},
  farmAnimals: [],
  bees: { hives: [], bees: [], flower: null },
  fishing: { available: false, rod: false, bobberOut: false, fish: 0 },
  containers: [],
  ...over,
});

const ids = list => list.map(c => c.id);
const crop = (mature) => [{ name: 'wheat', position: { x: 1, y: 64, z: 0 }, distance: 1, mature }];

test('no observation, no chores', () => {
  assert.deepEqual(deriveVillageChores({}), []);
});

test('ripe crops are work, unripe ones are not', () => {
  const ripe = deriveVillageChores(base({ nearby: { wheat: crop(true) } }));
  assert.ok(ids(ripe).includes('harvest_crops'));
  assert.equal(deriveVillageChores(base({ nearby: { wheat: crop(false) } })).length, 0);
  // maturity unknown (null) is not a licence to harvest
  assert.equal(deriveVillageChores(base({ nearby: { wheat: crop(null) } })).length, 0);
});

test('the offered options are the authority: no harvest intent, no harvest chore', () => {
  const obs = base({ nearby: { wheat: crop(true) } });
  assert.equal(ids(deriveVillageChores(obs, { offered: new Set(['mine_stone']) })).includes('harvest_crops'), false);
  assert.ok(ids(deriveVillageChores(obs, { offered: new Set(['harvest_wheat']) })).includes('harvest_crops'));
});

test('shearing needs shears and an unsheared sheep', () => {
  const sheep = (over = {}) => ({ type: 'sheep', baby: false, sheared: false, distance: 2, ...over });
  const withShears = base({ inventory: { shears: 1 } });
  assert.ok(ids(deriveVillageChores({ ...withShears, farmAnimals: [sheep()] })).includes('shear_sheep'));
  assert.equal(deriveVillageChores({ ...withShears, farmAnimals: [sheep({ sheared: true })] }).length, 0);
  assert.equal(deriveVillageChores({ ...withShears, farmAnimals: [sheep({ baby: true })] }).length, 0);
  assert.equal(deriveVillageChores(base({ farmAnimals: [sheep()] })).length, 0);
});

test('milking needs a bucket and an adult cow', () => {
  const cow = { type: 'cow', baby: false, distance: 3 };
  assert.ok(ids(deriveVillageChores(base({ inventory: { bucket: 1 }, farmAnimals: [cow] }))).includes('milk_cows'));
  assert.equal(deriveVillageChores(base({ inventory: { bucket: 1 }, farmAnimals: [{ ...cow, baby: true }] })).length, 0);
  assert.equal(deriveVillageChores(base({ farmAnimals: [cow] })).length, 0);
});

test('breeding needs two adults of a species and two feed items', () => {
  const cows = [{ type: 'cow', baby: false }, { type: 'cow', baby: false, distance: 3 }];
  assert.ok(ids(deriveVillageChores(base({ inventory: { wheat: 2 }, farmAnimals: cows }))).includes('tend_animals'));
  assert.equal(deriveVillageChores(base({ inventory: { wheat: 1 }, farmAnimals: cows })).length, 0);
  assert.equal(deriveVillageChores(base({ inventory: { wheat: 2 }, farmAnimals: [cows[0]] })).length, 0);
});

test('a full hive is work only with the tool for it', () => {
  const hive = { type: 'beehive', position: { x: 2, y: 64, z: 0 }, distance: 2, honeyLevel: 5 };
  assert.ok(ids(deriveVillageChores(base({ inventory: { shears: 1 }, bees: { hives: [hive] } }))).includes('collect_honey'));
  assert.ok(ids(deriveVillageChores(base({ inventory: { glass_bottle: 2 }, bees: { hives: [hive] } }))).includes('collect_honey'));
  assert.equal(deriveVillageChores(base({ bees: { hives: [hive] } })).length, 0);
  assert.equal(deriveVillageChores(base({ inventory: { shears: 1 }, bees: { hives: [{ ...hive, honeyLevel: 0 }] } })).length, 0);
});

test('fishing needs water and a rod in hand', () => {
  const spot = { available: true, rod: true, bobberOut: false };
  assert.ok(ids(deriveVillageChores(base({ inventory: { fishing_rod: 1 }, fishing: spot }))).includes('go_fishing'));
  assert.equal(deriveVillageChores(base({ fishing: { available: true, rod: false } })).length, 0);
});

test('wood, stone and ore come from the nearby census', () => {
  const near = {
    oak_log: [{ name: 'oak_log', distance: 3 }, { name: 'oak_log', distance: 6 }],
    stone: [{ name: 'stone', distance: 2 }],
    iron_ore: [{ name: 'iron_ore', distance: 4 }],
  };
  const list = deriveVillageChores(base({ nearby: near }));
  assert.ok(ids(list).includes('chop_wood'));
  assert.ok(ids(list).includes('gather_stone'));
  assert.ok(ids(list).includes('mine_ore'));
  // chop_wood is worthier with more logs, but stone alone still offers only stone
  const onlyStone = deriveVillageChores(base({ nearby: { stone: near.stone } }));
  assert.deepEqual(ids(onlyStone), ['gather_stone']);
});

test('sowing needs seeds and a plant option', () => {
  const obs = base({ inventory: { wheat_seeds: 3 } });
  assert.equal(deriveVillageChores(obs, { offered: new Set(['plant_wheat_seeds']) }).length, 1);
  assert.equal(deriveVillageChores(obs, { offered: new Set(['harvest_wheat']) }).length, 0);
  assert.equal(deriveVillageChores(base({ inventory: {} }), { offered: new Set(['plant_wheat_seeds']) }).length, 0);
});

test('storing needs a full stack and a reachable chest', () => {
  const obs = base({ inventory: { wheat: 8 }, containers: [{ type: 'chest', position: { x: 1, y: 64, z: 0 } }] });
  const chore = deriveVillageChores(obs, { offered: new Set(['deposit_wheat']) }).find(c => c.id === 'store_harvest');
  assert.ok(chore);
  assert.deepEqual(chore.spend, { item: 'wheat', count: 8 });
  // the wrong chest option (or none) is not a storable stack
  assert.equal(deriveVillageChores(obs, { offered: new Set(['deposit_stone']) }).length, 0);
  assert.equal(deriveVillageChores(base({ inventory: { wheat: 2 } }), { offered: new Set(['deposit_wheat']) }).length, 0);
});

test('the best chore wins and the cooldown skips an attempt', () => {
  const obs = base({ nearby: { wheat: crop(true) }, inventory: { shears: 1 }, farmAnimals: [{ type: 'sheep', baby: false, sheared: false }] });
  const best = nextVillageChore(obs);
  assert.equal(best.id, 'harvest_crops');
  const attempts = new Map([[best.id, 0]]);
  const second = nextVillageChore(obs, { attempts, now: 1000, cooldownMs: DEFAULT_VILLAGE_COOLDOWN_MS });
  assert.equal(second.id, 'shear_sheep');
  // once the cooldown expires the chore is available again
  const later = nextVillageChore(obs, { attempts, now: DEFAULT_VILLAGE_COOLDOWN_MS + 1, cooldownMs: DEFAULT_VILLAGE_COOLDOWN_MS });
  assert.equal(later.id, 'harvest_crops');
});

test('allow filters the candidate set', () => {
  const obs = base({ nearby: { wheat: crop(true) }, farmAnimals: [] });
  assert.equal(nextVillageChore(obs, { allow: c => c.id !== 'harvest_crops' }), null);
});

test('gain is a delta, never an absolute count', () => {
  const obs = base({ inventory: { wheat: 3, white_wool: 2 } });
  const before = villageSnapshot(base({ inventory: { wheat: 1, white_wool: 2 } }));
  const harvest = VILLAGE_CHORES.find(c => c.id === 'harvest_crops');
  assert.equal(choreGain(harvest, obs, before), 2);
  const shear = VILLAGE_CHORES.find(c => c.id === 'shear_sheep');
  assert.equal(choreGain(shear, obs, before), 0);
  assert.equal(choreGain(shear, base({ inventory: { white_wool: 3 } }), before), 1);
});

test('harvest resolves on the item gained, unknown chore never resolves', () => {
  const before = villageSnapshot(base({ inventory: { wheat: 0 } }));
  assert.equal(isChoreResolved('harvest_crops', base({ inventory: { wheat: 1 } }), { before }), false);
  assert.equal(isChoreResolved('harvest_crops', base({ inventory: { wheat: 2 } }), { before }), true);
  assert.equal(isChoreResolved('nonsense', base({ inventory: { wheat: 99 } }), { before }), false);
});

test('spend chores resolve when the seed is actually used', () => {
  const chore = nextVillageChore(base({ inventory: { wheat_seeds: 2 } }), { offered: new Set(['plant_wheat_seeds']) });
  assert.equal(chore.id, 'plant_crops');
  const before = villageSnapshot(base({ inventory: { wheat_seeds: 2 } }), { spend: chore.spend });
  assert.equal(isChoreResolved('plant_crops', base({ inventory: { wheat_seeds: 2 } }), { before }), false);
  assert.equal(isChoreResolved('plant_crops', base({ inventory: { wheat_seeds: 1 } }), { before }), true);
});

test('breeding resolves when a baby appears', () => {
  const before = villageSnapshot(base({ farmAnimals: [{ type: 'cow', baby: false }, { type: 'cow', baby: false }] }));
  assert.equal(babyCount(base({ farmAnimals: [{ type: 'cow', baby: false }] })), 0);
  assert.equal(isChoreResolved('tend_animals', base({ farmAnimals: [{ type: 'cow', baby: false }, { type: 'cow', baby: false }] }), { before }), false);
  assert.equal(isChoreResolved('tend_animals', base({ farmAnimals: [{ type: 'cow', baby: true }] }), { before }), true);
  // no snapshot, no claim
  assert.equal(isChoreResolved('tend_animals', base({ farmAnimals: [{ type: 'cow', baby: true }] }), {}), false);
});

test('option matching accepts a Set or an array', () => {
  assert.equal(offeredHas(new Set(['deposit_wheat']), 'deposit_wheat'), true);
  assert.equal(offeredHas(['deposit_wheat'], 'deposit_wheat'), true);
  assert.equal(offeredHas(['deposit_wheat'], 'deposit_stone'), false);
  assert.equal(offeredHas(null, 'deposit_wheat'), false);
  assert.equal(offeredMatches(new Set(['harvest_wheat']), [/^harvest_/]), true);
  assert.equal(offeredMatches(['plant_carrot'], [/^plant_/]), true);
  assert.equal(offeredMatches(['mine_stone'], [/^plant_/]), false);
});
