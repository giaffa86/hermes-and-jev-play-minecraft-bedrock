import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BedrockAdapter } from '../bedrock-adapter.mjs';
import { isMilkableType, MILKABLE_TYPE_COUNT, BUCKET_INGREDIENTS } from '../bedrock-survival.mjs';

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
  adapter.inventorySlots = [];
  adapter._selectHotbarSlot = () => true;
  adapter._moveTo = async () => ({ ok: true });
  adapter._queueAuthInput = async () => {};
  adapter._interactEntity = () => true;
  adapter.world.findBlocks = () => [];
  adapter.world.blockAt = () => ({ name: 'air' });
  return adapter;
}

function cow (adapter, runtimeId = 300n, position = { x: 2, y: 63, z: 0 }) {
  adapter._trackEntity({ runtime_id: runtimeId, unique_id: runtimeId + 900n, entity_type: 'minecraft:cow', position }, 'mob');
}

// ---- dati ---------------------------------------------------------------------------

test('isMilkableType covers cows and mooshrooms only', () => {
  assert.equal(isMilkableType('cow'), true);
  assert.equal(isMilkableType('minecraft:cow'), true);
  assert.equal(isMilkableType('mooshroom'), true);
  assert.equal(isMilkableType('pig'), false);
  assert.equal(isMilkableType('sheep'), false);
  assert.equal(isMilkableType('villager_v2'), false);
  assert.equal(isMilkableType(null), false);
  assert.equal(MILKABLE_TYPE_COUNT, 2);
  assert.equal(BUCKET_INGREDIENTS.iron_ingot, 3);
});

// ---- opzioni ------------------------------------------------------------------------

test('options offer milk_<animal> only with a bucket and a milkable animal at hand', () => {
  const adapter = spawnedAdapter();
  cow(adapter);
  adapter.inventory = {};
  assert.ok(!adapter.options().map(o => o.key).includes('milk_cow'), 'no bucket, no option');
  adapter.inventory = { bucket: 1 };
  assert.ok(adapter.options().map(o => o.key).includes('milk_cow'), 'bucket + cow, option offered');
});

test('options never offer milk_ for a non-milkable animal', () => {
  const adapter = spawnedAdapter();
  adapter.inventory = { bucket: 1 };
  adapter._trackEntity({ runtime_id: 301n, unique_id: 1201n, entity_type: 'minecraft:pig', position: { x: 2, y: 63, z: 0 } }, 'mob');
  const keys = adapter.options().map(o => o.key);
  assert.ok(!keys.includes('milk_pig'));
  assert.ok(!keys.includes('milk_cow'));
});

test('options offer craft_bucket with 3 iron ingots at a crafting table', () => {
  const adapter = spawnedAdapter();
  adapter.craftingData = {};
  adapter.recipes = new Map([['bucket', [{ network_id: 1 }]]]);
  adapter.world.findBlocks = (name) => (name === 'crafting_table' ? [{ name, position: { x: 3, y: 63, z: 0 }, distance: 3 }] : []);
  adapter.inventory = { iron_ingot: 2 };
  assert.ok(!adapter.options().map(o => o.key).includes('craft_bucket'), '2 ingots are not enough');
  adapter.inventory = { iron_ingot: 3 };
  assert.ok(adapter.options().map(o => o.key).includes('craft_bucket'), '3 ingots + table');
});

// ---- esecuzione ---------------------------------------------------------------------

test('_milkAnimal interacts and confirms from the milk bucket in the inventory', async () => {
  const adapter = spawnedAdapter();
  cow(adapter);
  adapter.inventory = { bucket: 1 };
  adapter.inventorySlots = [{ network_id: 40, name: 'bucket', count: 1, stack_id: 1 }];
  let interacted = 0;
  adapter._interactEntity = () => {
    interacted++;
    adapter.inventory = { milk_bucket: 1 };
    return true;
  };
  const result = await adapter._milkAnimal('cow');
  assert.equal(result.ok, true);
  assert.equal(result.milked, 'cow');
  assert.equal(result.milk, 1);
  assert.equal(result.confirmedBy, 'milk_bucket');
  assert.equal(result.bucketLeft, 0);
  assert.equal(interacted, 1);
});

test('_milkAnimal accepts a consumed bucket as confirmation', async () => {
  const adapter = spawnedAdapter();
  cow(adapter);
  adapter.inventory = { bucket: 2 };
  adapter.inventorySlots = [{ network_id: 40, name: 'bucket', count: 2, stack_id: 1 }];
  adapter._interactEntity = () => {
    adapter.inventory = { bucket: 1 };
    return true;
  };
  const result = await adapter._milkAnimal('cow');
  assert.equal(result.ok, true);
  assert.equal(result.confirmedBy, 'bucket_consumed');
  assert.equal(result.bucketLeft, 1);
});

test('_milkAnimal fails fast without a bucket, a cow or a milkable type', async () => {
  const adapter = spawnedAdapter();
  cow(adapter);
  adapter.inventory = {};
  assert.equal((await adapter._milkAnimal('cow')).error, 'missing_bucket');
  adapter.inventory = { bucket: 1 };
  assert.equal((await adapter._milkAnimal('pig')).error, 'not_milkable');
  adapter.entities.clear();
  assert.equal((await adapter._milkAnimal('cow')).error, 'no_milkable_nearby');
});

test('_milkAnimal reports an unreachable animal instead of burning the budget', async () => {
  const adapter = spawnedAdapter();
  cow(adapter);
  adapter.inventory = { bucket: 1 };
  adapter.inventorySlots = [{ network_id: 40, name: 'bucket', count: 1, stack_id: 1 }];
  adapter._moveTo = async () => { throw new Error('path_failed'); };
  adapter.entities.get('300').position = { x: 12, y: 63, z: 0 };
  const result = await adapter._milkAnimal('cow', 300);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'animal_unreachable');
});

test('_milkAnimal times out with a typed error when the server ignores the interaction', async () => {
  const adapter = spawnedAdapter();
  cow(adapter);
  adapter.inventory = { bucket: 1 };
  adapter.inventorySlots = [{ network_id: 40, name: 'bucket', count: 1, stack_id: 1 }];
  const result = await adapter._milkAnimal('cow', 200);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'milk_not_confirmed');
  assert.equal(result.type, 'cow');
});

test('executeAction routes milk_<animal> to _milkAnimal', async () => {
  const adapter = spawnedAdapter();
  cow(adapter);
  adapter.inventory = { bucket: 1 };
  adapter.inventorySlots = [{ network_id: 40, name: 'bucket', count: 1, stack_id: 1 }];
  adapter._interactEntity = () => { adapter.inventory = { milk_bucket: 1 }; return true; };
  const result = await adapter.executeAction('milk_cow');
  assert.equal(result.ok, true);
  assert.equal(result.milked, 'cow');
});
