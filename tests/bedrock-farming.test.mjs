import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BedrockAdapter } from '../bedrock-adapter.mjs';
import { cropMaturity, seedForCrop } from '../bedrock-survival.mjs';

function spawnedAdapter () {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.client = new EventEmitter();
  adapter.client.entityId = 7n;
  adapter.client.write = () => {};
  adapter.position = { x: 0, y: 64.62, z: 0 };
  adapter._feet = { x: 0, y: 63, z: 0 };
  adapter.nearbyBlocks = {};
  adapter.drops = [];
  return adapter;
}

// ---- metadata e censimento ----------------------------------------------------------

test('metadata flags expose baby/tempted/inlove/tamed/sheared and owner', () => {
  const adapter = spawnedAdapter();
  adapter._trackEntity({ runtime_id: 50n, unique_id: 950n, entity_type: 'minecraft:cow', position: { x: 2, y: 63, z: 0 } }, 'mob');
  // baby (bit 11) + inlove (bit 7) + sheared (bit 31) = 2048 + 128 + 2^31
  const bits = (1n << 11n) | (1n << 7n) | (1n << 31n);
  adapter._applyEntityMetadata({ runtime_entity_id: 50n, metadata: [{ key: 0, value: bits }] });
  adapter._applyEntityMetadata({ runtime_entity_id: 50n, metadata: [{ key: 5, value: 7n }] });
  const cow = adapter.entities.get('50');
  assert.equal(cow.baby, true);
  assert.equal(cow.inlove, true);
  assert.equal(cow.sheared, true);
  assert.equal(cow.tempted, false);
  assert.equal(cow.tamed, false);
  assert.equal(cow.ownerEid, '7');
});

test('tamed flag (bit 28) is exposed on tameable animals', () => {
  const adapter = spawnedAdapter();
  adapter._trackEntity({ runtime_id: 51n, unique_id: 951n, entity_type: 'minecraft:wolf', position: { x: 2, y: 63, z: 0 } }, 'mob');
  adapter._applyEntityMetadata({ runtime_entity_id: 51n, metadata: [{ key: 0, value: 1n << 28n }] });
  const wolf = adapter.entities.get('51');
  assert.equal(wolf.tamed, true);
  assert.equal(adapter._nearbyTameable(8)[0].tamed, true);
});

test('_nearbyFarmAnimals lists only farm animals and never villagers', () => {
  const adapter = spawnedAdapter();
  adapter._trackEntity({ runtime_id: 50n, unique_id: 950n, entity_type: 'minecraft:cow', position: { x: 2, y: 63, z: 0 } }, 'mob');
  adapter._trackEntity({ runtime_id: 51n, unique_id: 951n, entity_type: 'minecraft:pig', position: { x: 3, y: 63, z: 0 } }, 'mob');
  adapter._trackEntity({ runtime_id: 52n, unique_id: 952n, entity_type: 'minecraft:villager_v2', position: { x: 4, y: 63, z: 0 } }, 'mob');
  adapter._trackEntity({ runtime_id: 53n, unique_id: 953n, entity_type: 'minecraft:zombie', position: { x: 5, y: 63, z: 0 } }, 'mob');
  const farm = adapter._nearbyFarmAnimals(8);
  assert.deepEqual(farm.map(e => e.type).sort(), ['cow', 'pig']);
  assert.equal(adapter._farmAnimalOfType('cow').runtimeId, '50');
  assert.equal(adapter._farmAnimalOfType('villager_v2'), null);
});

test('_entityOfType falls back from hostiles to farm animals', () => {
  const adapter = spawnedAdapter();
  adapter._trackEntity({ runtime_id: 60n, unique_id: 960n, entity_type: 'minecraft:cow', position: { x: 3, y: 63, z: 0 } }, 'mob');
  assert.equal(adapter._entityOfType('cow').type, 'cow');
  assert.equal(adapter._entityOfType('zombie'), null);
});

// ---- farmland -----------------------------------------------------------------------

test('_unplantedFarmland returns farmland whose cell above is air', () => {
  const adapter = spawnedAdapter();
  adapter.world.findBlocks = () => [
    { name: 'farmland', position: { x: 10, y: 63, z: 10 }, distance: 1 },
    { name: 'farmland', position: { x: 11, y: 63, z: 10 }, distance: 2 },
  ];
  adapter.world.blockAt = (pos) => (pos.y === 64 && pos.x === 10 ? { name: 'air' } : { name: 'wheat' });
  const free = adapter._unplantedFarmland();
  assert.equal(free.length, 1);
  assert.deepEqual(free[0].position, { x: 10, y: 63, z: 10 });
});

test('options offer plant, attack and feed farming actions', () => {
  const adapter = spawnedAdapter();
  adapter.inventory = { wheat_seeds: 1, wheat: 1, carrot: 1 };
  adapter._trackEntity({ runtime_id: 70n, unique_id: 970n, entity_type: 'minecraft:cow', position: { x: 3, y: 63, z: 0 } }, 'mob');
  adapter._trackEntity({ runtime_id: 71n, unique_id: 971n, entity_type: 'minecraft:pig', position: { x: 4, y: 63, z: 0 } }, 'mob');
  adapter.world.findBlocks = (name) => name === 'farmland'
    ? [{ name: 'farmland', position: { x: 1, y: 63, z: 0 }, distance: 1 }]
    : [];
  adapter.world.blockAt = () => ({ name: 'air' });
  const keys = adapter.options().map(o => o.key);
  assert.ok(keys.includes('plant_wheat_seeds'), 'plant offered');
  assert.ok(keys.includes('feed_cow'), 'feed cow offered');
  assert.ok(keys.includes('feed_pig'), 'feed pig offered');
  assert.ok(keys.includes('attack_cow'), 'attack cow offered');
  assert.ok(keys.includes('attack_pig'), 'attack pig offered');
});

test('executeAction dispatches plant_ and feed_ keys', async () => {
  const adapter = spawnedAdapter();
  adapter.inventory = { wheat_seeds: 1, wheat: 1 };
  adapter.inventorySlots = [{ network_id: 10, name: 'wheat_seeds', count: 1, stack_id: 1 }];
  adapter._plantSeed = async (item) => ({ ok: true, item, crop: 'wheat' });
  adapter._feedAnimal = async (type) => ({ ok: true, type, state: 'inlove' });
  const planted = await adapter.executeAction('plant_wheat_seeds');
  assert.equal(planted.ok, true);
  assert.equal(planted.crop, 'wheat');
  const fed = await adapter.executeAction('feed_cow');
  assert.equal(fed.ok, true);
  assert.equal(fed.state, 'inlove');
});

// ---- plant --------------------------------------------------------------------------

test('_plantSeed clicks farmland and confirms the crop appears', async () => {
  const adapter = spawnedAdapter();
  adapter.inventory = { wheat_seeds: 1 };
  adapter.inventorySlots = [{ network_id: 10, name: 'wheat_seeds', count: 1, stack_id: 1 }];
  adapter.world.findBlocks = () => [{ name: 'farmland', position: { x: 1, y: 63, z: 0 }, distance: 1 }];
  let clicked = false;
  adapter.world.blockAt = (pos) => {
    if (pos.x === 1 && pos.z === 0 && pos.y === 64) return clicked ? { name: 'wheat' } : { name: 'air' };
    return { name: 'farmland' };
  };
  adapter.world.runtimeIdAt = () => 100;
  adapter._selectHotbarSlot = () => true;
  adapter._refreshNearby = () => {};
  adapter._moveTo = async () => ({ ok: true });
  adapter._queueAuthInput = async (input) => { if (input.transaction) clicked = true; };
  const result = await adapter._plantSeed('wheat_seeds');
  assert.equal(result.ok, true);
  assert.equal(result.crop, 'wheat');
  assert.deepEqual(result.position, { x: 1, y: 64, z: 0 });
  assert.equal(clicked, true);
});

test('_plantSeed refuses unknown seeds and missing farmland', async () => {
  const adapter = spawnedAdapter();
  adapter.inventory = {};
  assert.equal((await adapter._plantSeed('bone')).error, 'unknown_seed');
  adapter.inventory = { wheat_seeds: 1 };
  adapter.world.findBlocks = () => [];
  adapter.world.blockAt = () => ({ name: 'air' });
  assert.equal((await adapter._plantSeed('wheat_seeds')).error, 'no_free_farmland');
});

// ---- feed ---------------------------------------------------------------------------

test('_feedAnimal equips the feed, interacts and detects the inlove state', async () => {
  const adapter = spawnedAdapter();
  adapter.inventory = { wheat: 1 };
  adapter.inventorySlots = [{ network_id: 20, name: 'wheat', count: 1, stack_id: 1 }];
  adapter._trackEntity({ runtime_id: 50n, unique_id: 950n, entity_type: 'minecraft:cow', position: { x: 2, y: 63, z: 0 } }, 'mob');
  adapter._selectHotbarSlot = () => true;
  adapter._moveTo = async () => ({ ok: true });
  adapter._closeContainer = async () => {};
  let interacted = false;
  adapter._interactEntity = () => { interacted = true; return true; };
  adapter._queueAuthInput = async () => {};
  setTimeout(() => { adapter.entities.get('50').inlove = true; }, 300);
  const result = await adapter._feedAnimal('cow');
  assert.equal(result.ok, true);
  assert.equal(result.state, 'inlove');
  assert.equal(interacted, true);
});

test('_feedAnimal reports missing feed and no animal', async () => {
  const adapter = spawnedAdapter();
  adapter.inventory = {};
  assert.equal((await adapter._feedAnimal('cow')).error, 'missing_feed');
  adapter.inventory = { wheat: 1 };
  assert.equal((await adapter._feedAnimal('cow')).error, 'no_animal_nearby');
});

// ---- stretch: throw_egg, breed, tame, shear -----------------------------------------

test('_throwEgg consumes the egg and reports the throw', async () => {
  const adapter = spawnedAdapter();
  adapter.inventory = { egg: 1 };
  adapter.inventorySlots = [{ network_id: 30, name: 'egg', count: 1, stack_id: 1 }];
  adapter._selectHotbarSlot = () => true;
  let used = false;
  adapter._queueAuthInput = async (input) => { if (input.transaction) { used = true; adapter.inventory.egg = 0; } };
  const result = await adapter._throwEgg();
  assert.equal(result.ok, true);
  assert.equal(result.thrown, 'egg');
  assert.equal(used, true);
});

test('_throwEgg reports missing egg', async () => {
  const adapter = spawnedAdapter();
  adapter.inventory = {};
  assert.equal((await adapter._throwEgg()).error, 'missing_egg');
});

test('_breedAnimals feeds two adults and detects a new baby', async () => {
  const adapter = spawnedAdapter();
  adapter.inventory = { wheat: 2 };
  adapter._trackEntity({ runtime_id: 80n, unique_id: 980n, entity_type: 'minecraft:cow', position: { x: 2, y: 63, z: 0 } }, 'mob');
  adapter._trackEntity({ runtime_id: 81n, unique_id: 981n, entity_type: 'minecraft:cow', position: { x: 3, y: 63, z: 0 } }, 'mob');
  const fed = [];
  adapter._feedEntity = async (runtimeId, feed) => {
    fed.push(String(runtimeId));
    if (fed.length === 2) {
      adapter._trackEntity({ runtime_id: 82n, unique_id: 982n, entity_type: 'minecraft:cow', position: { x: 2.5, y: 63, z: 0.5 } }, 'mob');
      adapter.entities.get('82').baby = true;
    }
    return { ok: true, fed: feed, state: 'inlove' };
  };
  const result = await adapter._breedAnimals('cow');
  assert.equal(result.ok, true);
  assert.equal(result.bred, 'cow');
  assert.deepEqual(fed, ['80', '81']);
});

test('_breedAnimals needs two adults and two feed', async () => {
  const adapter = spawnedAdapter();
  adapter.inventory = { wheat: 1 };
  adapter._trackEntity({ runtime_id: 80n, unique_id: 980n, entity_type: 'minecraft:cow', position: { x: 2, y: 63, z: 0 } }, 'mob');
  assert.equal((await adapter._breedAnimals('cow')).error, 'need_2_feed');
  adapter.inventory = { wheat: 2 };
  assert.equal((await adapter._breedAnimals('cow')).error, 'need_2_adults');
});

test('_tameAnimal interacts until the tamed flag appears', async () => {
  const adapter = spawnedAdapter();
  adapter.client.entityId = 7n;
  adapter.inventory = { bone: 1 };
  adapter._trackEntity({ runtime_id: 90n, unique_id: 990n, entity_type: 'minecraft:wolf', position: { x: 2, y: 63, z: 0 } }, 'mob');
  let fed = 0;
  adapter._feedEntity = async () => {
    fed++;
    adapter.entities.get('90').tamed = true;
    return { ok: true, state: 'tamed' };
  };
  const result = await adapter._tameAnimal('wolf');
  assert.equal(result.ok, true);
  assert.equal(result.tamed, 'wolf');
  assert.equal(fed, 1);
});

test('_shearSheep interacts and detects the sheared flag', async () => {
  const adapter = spawnedAdapter();
  adapter.inventory = { shears: 1 };
  adapter.inventorySlots = [{ network_id: 40, name: 'shears', count: 1, stack_id: 1 }];
  adapter._trackEntity({ runtime_id: 100n, unique_id: 1000n, entity_type: 'minecraft:sheep', position: { x: 2, y: 63, z: 0 } }, 'mob');
  adapter._selectHotbarSlot = () => true;
  adapter._moveTo = async () => ({ ok: true });
  let interacted = false;
  adapter._interactEntity = () => { interacted = true; return true; };
  adapter._queueAuthInput = async () => {};
  setTimeout(() => { adapter.entities.get('100').sheared = true; }, 300);
  const result = await adapter._shearSheep();
  assert.equal(result.ok, true);
  assert.equal(result.sheared, true);
  assert.equal(interacted, true);
});

test('options offer the farming stretch actions', () => {
  const adapter = spawnedAdapter();
  adapter.inventory = { egg: 1, wheat: 2, bone: 1, shears: 1 };
  adapter._trackEntity({ runtime_id: 80n, unique_id: 980n, entity_type: 'minecraft:cow', position: { x: 2, y: 63, z: 0 } }, 'mob');
  adapter._trackEntity({ runtime_id: 81n, unique_id: 981n, entity_type: 'minecraft:cow', position: { x: 3, y: 63, z: 0 } }, 'mob');
  adapter._trackEntity({ runtime_id: 90n, unique_id: 990n, entity_type: 'minecraft:wolf', position: { x: 4, y: 63, z: 0 } }, 'mob');
  adapter._trackEntity({ runtime_id: 100n, unique_id: 1000n, entity_type: 'minecraft:sheep', position: { x: 5, y: 63, z: 0 } }, 'mob');
  adapter.world.findBlocks = () => [];
  adapter.world.blockAt = () => ({ name: 'air' });
  const keys = adapter.options().map(o => o.key);
  assert.ok(keys.includes('throw_egg'), 'throw_egg offered');
  assert.ok(keys.includes('breed_cow'), 'breed_cow offered');
  assert.ok(keys.includes('tame_wolf'), 'tame_wolf offered');
  assert.ok(keys.includes('shear_sheep'), 'shear_sheep offered');
});

// ---- compagni: ocelot trusting, ride-tame, parrot ----------------------------------

test('trusting flag (flags_extended key 92, bit 1) is exposed on ocelots', () => {
  const adapter = spawnedAdapter();
  adapter._trackEntity({ runtime_id: 52n, unique_id: 952n, entity_type: 'minecraft:ocelot', position: { x: 2, y: 63, z: 0 } }, 'mob');
  adapter._applyEntityMetadata({ runtime_entity_id: 52n, metadata: [{ key: 92, value: 1n << 1n }] });
  const ocelot = adapter.entities.get('52');
  assert.equal(ocelot.trusting, true);
  assert.equal(adapter._nearbyCompanion(8).find(e => e.type === 'ocelot').trusting, true);
});

test('_tameAnimal mounts a rideable horse until tamed', async () => {
  const adapter = spawnedAdapter();
  adapter.client.entityId = 7n;
  adapter.inventory = {};
  adapter._trackEntity({ runtime_id: 110n, unique_id: 1110n, entity_type: 'minecraft:horse', position: { x: 2, y: 63, z: 0 } }, 'mob');
  let mounted = 0;
  adapter._mountEntity = async () => { mounted++; adapter.entities.get('110').tamed = true; };
  const result = await adapter._tameAnimal('horse');
  assert.equal(result.ok, true);
  assert.equal(result.tamed, 'horse');
  assert.equal(mounted, 1);
});

test('_tameAnimal tames a parrot with wheat seeds', async () => {
  const adapter = spawnedAdapter();
  adapter.client.entityId = 7n;
  adapter.inventory = { wheat_seeds: 1 };
  adapter._trackEntity({ runtime_id: 111n, unique_id: 1111n, entity_type: 'minecraft:parrot', position: { x: 2, y: 63, z: 0 } }, 'mob');
  let fed = null;
  adapter._feedEntity = async (_runtimeId, feed) => { fed = feed; adapter.entities.get('111').tamed = true; return { ok: true, state: 'tamed' }; };
  const result = await adapter._tameAnimal('parrot');
  assert.equal(result.ok, true);
  assert.equal(fed, 'wheat_seeds');
});

test('options offer tame_ for rideables and food-tameable companions', () => {
  const adapter = spawnedAdapter();
  adapter.client.entityId = 7n;
  adapter.inventory = { wheat_seeds: 1 };
  adapter._trackEntity({ runtime_id: 110n, unique_id: 1110n, entity_type: 'minecraft:horse', position: { x: 2, y: 63, z: 0 } }, 'mob');
  adapter._trackEntity({ runtime_id: 111n, unique_id: 1111n, entity_type: 'minecraft:parrot', position: { x: 3, y: 63, z: 0 } }, 'mob');
  adapter.world.findBlocks = () => [];
  adapter.world.blockAt = () => ({ name: 'air' });
  const keys = adapter.options().map(o => o.key);
  assert.ok(keys.includes('tame_horse'), 'tame_horse offered');
  assert.ok(keys.includes('tame_parrot'), 'tame_parrot offered');
});

// ---- colture: maturazione -----------------------------------------------------------

test('cropMaturity reads the Bedrock growth/age state', () => {
  const crop = (name, props) => ({ name, getProperties: () => props });
  assert.equal(cropMaturity({ name: 'stone' }), null);
  assert.deepEqual(cropMaturity(crop('wheat', { growth: 7 })), { name: 'wheat', growth: 7, max: 7, mature: true });
  assert.deepEqual(cropMaturity(crop('wheat', { growth: 3 })), { name: 'wheat', growth: 3, max: 7, mature: false });
  assert.deepEqual(cropMaturity(crop('nether_wart', { age: 3 })), { name: 'nether_wart', growth: 3, max: 3, mature: true });
  assert.deepEqual(cropMaturity(crop('nether_wart', { age: 1 })), { name: 'nether_wart', growth: 1, max: 3, mature: false });
  // Stato non leggibile: maturità *ignota*, non "acerba".
  assert.deepEqual(cropMaturity({ name: 'potatoes' }), { name: 'potatoes', growth: null, max: 7, mature: null });
});

test('cropMaturity reads a spread block that only kept `_properties`', () => {
  // `BedrockWorld.findBlocks` restituiva `{...block, distance}`: lo stato
  // sopravvive in `_properties`, i metodi no. Live questo rendeva la maturità
  // ignota (fail-open) su tutte le colture.
  const spread = { name: 'potatoes', stateId: 1913, _properties: { growth: 7 }, computedStates: {} };
  assert.deepEqual(cropMaturity(spread), { name: 'potatoes', growth: 7, max: 7, mature: true });
  assert.deepEqual(cropMaturity({ ...spread, _properties: { growth: 2 } }), { name: 'potatoes', growth: 2, max: 7, mature: false });
  assert.deepEqual(cropMaturity({ name: 'nether_wart', _properties: { age: 3 } }), { name: 'nether_wart', growth: 3, max: 3, mature: true });
  // `computedStates` non deve nascondere lo stato letto da `_properties`.
  assert.deepEqual(cropMaturity({ name: 'wheat', _properties: { growth: 5 }, computedStates: { growth: 5 } }), { name: 'wheat', growth: 5, max: 7, mature: false });
});

test('seedForCrop maps a crop back to the item that replants it', () => {
  assert.equal(seedForCrop('wheat'), 'wheat_seeds');
  assert.equal(seedForCrop('carrots'), 'carrot');
  assert.equal(seedForCrop('potatoes'), 'potato');
  assert.equal(seedForCrop('stone'), null);
});

test('options offer harvest_ for a mature crop, never a destructive mine_', () => {
  const adapter = spawnedAdapter();
  adapter._reachabilityUsable = () => false;
  adapter.world.findBlocks = () => [];
  adapter.world.blockAt = pos => (pos.y === 63
    ? { name: 'potatoes', getProperties: () => ({ growth: 7 }), hardness: 0, diggable: true }
    : { name: 'air' });
  adapter.nearbyBlocks = {
    potatoes: [{ name: 'potatoes', position: { x: 1, y: 63, z: 0 }, distance: 1, diggable: true, hardness: 0 }],
  };
  const options = adapter.options();
  const harvest = options.find(o => o.key === 'harvest_potatoes');
  assert.ok(harvest, 'harvest_potatoes offered');
  assert.equal(options.some(o => o.key === 'mine_potatoes'), false, 'crop not offered as mine_');
  assert.match(harvest.description, /\(1 blocks away\)/);
  assert.match(harvest.description, /replant potato/);
});

test('options skip immature crops and say how many are left to grow', () => {
  const adapter = spawnedAdapter();
  adapter._reachabilityUsable = () => false;
  adapter.world.findBlocks = () => [];
  const row = (x, distance) => ({ name: 'carrots', position: { x, y: 63, z: 0 }, distance, diggable: true, hardness: 0 });
  adapter.world.blockAt = pos => ({
    name: 'carrots', getProperties: () => ({ growth: pos.x === 1 ? 7 : 2 }), hardness: 0, diggable: true,
  });
  adapter.nearbyBlocks = { carrots: [row(1, 1), row(2, 2)] };
  const harvest = adapter.options().find(o => o.key === 'harvest_carrots');
  assert.ok(harvest);
  assert.match(harvest.description, /1 immature left to grow/);

  // Solo acerbe: nessuna opzione (né harvest_ né mine_).
  adapter.world.blockAt = () => ({ name: 'carrots', getProperties: () => ({ growth: 0 }), hardness: 0, diggable: true });
  const keys = adapter.options().map(o => o.key);
  assert.equal(keys.some(k => k.includes('carrots')), false);
});

test('_mineBlock refuses a known-immature crop without touching the wire', async () => {
  const adapter = spawnedAdapter();
  adapter.world.blockAt = () => ({ name: 'wheat', getProperties: () => ({ growth: 1 }), hardness: 0, diggable: true });
  let sent = 0;
  adapter._queueAuthInput = async () => { sent++; };
  const result = await adapter._mineBlock({ name: 'wheat', position: { x: 1, y: 63, z: 0 } });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'crop_not_mature');
  assert.equal(result.growth, 1);
  assert.equal(sent, 0, 'nessun pacchetto inviato');
});

test('executeAction refuses mine_ when every crop of that type is immature', async () => {
  const adapter = spawnedAdapter();
  adapter.world.findBlocks = () => [{ name: 'potatoes', position: { x: 1, y: 63, z: 0 }, distance: 1, diggable: true }];
  adapter.world.blockAt = () => ({ name: 'potatoes', getProperties: () => ({ growth: 4 }), hardness: 0, diggable: true });
  const result = await adapter.executeAction('mine_potatoes');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'crop_not_mature: potatoes');
});

test('_harvestCrop harvests a mature crop through executeAction and replants it', async () => {
  const adapter = spawnedAdapter();
  adapter.inventory = { potato: 2 };
  adapter._reachabilityUsable = () => false;
  adapter.world.findBlocks = () => [{ name: 'potatoes', position: { x: 1, y: 63, z: 0 }, distance: 1, diggable: true }];
  adapter.world.blockAt = () => ({ name: 'potatoes', getProperties: () => ({ growth: 7 }), hardness: 0, diggable: true });
  adapter._mineBlock = async () => ({
    ok: true, block: 'potatoes', position: { x: 1, y: 63, z: 0 },
    crop: { name: 'potatoes', growth: 7, maxGrowth: 7 }, picked: [{ item: 'potato', count: 1 }],
  });
  let planted = null;
  adapter._plantSeed = async item => { planted = item; return { ok: true, item, crop: 'potatoes' }; };
  const result = await adapter.executeAction('harvest_potatoes');
  assert.equal(result.ok, true);
  assert.equal(result.crop, 'potatoes');
  assert.equal(result.growth, 7);
  assert.equal(planted, 'potato');
  assert.equal(result.replanted.ok, true);
});

test('_harvestCrop skips the replant without a seed and rejects non-crops', async () => {
  const adapter = spawnedAdapter();
  adapter.inventory = {};
  adapter._reachabilityUsable = () => false;
  adapter.world.findBlocks = () => [{ name: 'wheat', position: { x: 1, y: 63, z: 0 }, distance: 1, diggable: true }];
  adapter.world.blockAt = () => ({ name: 'wheat', getProperties: () => ({ growth: 7 }), hardness: 0, diggable: true });
  adapter._mineBlock = async () => ({ ok: true, block: 'wheat', crop: { name: 'wheat', growth: 7, maxGrowth: 7 } });
  adapter._plantSeed = async () => { throw new Error('should not be called'); };
  const harvested = await adapter._harvestCrop('wheat');
  assert.equal(harvested.ok, true);
  assert.equal(harvested.replanted, null);
  assert.equal((await adapter._harvestCrop('stone')).error, 'not_a_crop');
});

test('_harvestCrop fails fast when the mature crop drop would be unreachable', async () => {
  const adapter = spawnedAdapter();
  adapter._reachabilityUsable = () => true;
  adapter.mineDropReachable = () => false;
  adapter.world.findBlocks = () => [{ name: 'potatoes', position: { x: 1, y: 63, z: 0 }, distance: 1, diggable: true }];
  adapter.world.blockAt = () => ({ name: 'potatoes', getProperties: () => ({ growth: 7 }), hardness: 0, diggable: true });
  adapter._mineBlock = async () => { throw new Error('should not mine'); };
  const result = await adapter._harvestCrop('potatoes');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'drop_unreachable');
});

test('_harvestCrop distinguishes "nothing to harvest" from "still growing"', async () => {
  const empty = spawnedAdapter();
  empty.world.findBlocks = () => [];
  empty._mineBlock = async () => { throw new Error('should not mine'); };
  assert.deepEqual(await empty._harvestCrop('wheat'), { ok: false, error: 'no_crop_found', crop: 'wheat', immature: 0 });

  const growing = spawnedAdapter();
  growing.world.findBlocks = () => [{ name: 'potatoes', position: { x: 1, y: 63, z: 0 }, distance: 1, diggable: true }];
  growing.world.blockAt = () => ({ name: 'potatoes', getProperties: () => ({ growth: 3 }), hardness: 0, diggable: true });
  growing._mineBlock = async () => { throw new Error('should not mine'); };
  assert.deepEqual(await growing._harvestCrop('potatoes'), { ok: false, error: 'crop_not_mature', crop: 'potatoes', immature: 1 });
});

test('_refreshNearby annotates crop rows with the growth state', () => {
  const adapter = spawnedAdapter();
  adapter.world.findBlocks = name => (name === 'potatoes'
    ? [{ name: 'potatoes', position: { x: 1, y: 63, z: 0 }, distance: 1, diggable: true, hardness: 0, getProperties: () => ({ growth: 4 }) }]
    : []);
  adapter._refreshNearby();
  const row = adapter.nearbyBlocks.potatoes[0];
  assert.equal(row.growth, 4);
  assert.equal(row.maxGrowth, 7);
  assert.equal(row.mature, false);
  // Le righe non-coltura restano invariate (nessun campo di crescita).
  assert.equal(Object.keys(adapter.nearbyBlocks.dirt[0] || {}).includes('growth'), false);
});
