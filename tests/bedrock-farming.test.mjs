import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

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

test('metadata flags expose baby/tempted/inlove and owner on farm animals', () => {
  const adapter = spawnedAdapter();
  adapter._trackEntity({ runtime_id: 50n, unique_id: 950n, entity_type: 'minecraft:cow', position: { x: 2, y: 63, z: 0 } }, 'mob');
  // baby (bit 8) + inlove (bit 7) = 256 + 128 = 384
  adapter._applyEntityMetadata({ runtime_entity_id: 50n, metadata: [{ key: 0, value: 384 }] });
  adapter._applyEntityMetadata({ runtime_entity_id: 50n, metadata: [{ key: 5, value: 7n }] });
  const cow = adapter.entities.get('50');
  assert.equal(cow.baby, true);
  assert.equal(cow.inlove, true);
  assert.equal(cow.tempted, false);
  assert.equal(cow.ownerEid, '7');
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
