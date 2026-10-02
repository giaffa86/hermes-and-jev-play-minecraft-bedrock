import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

function dropAdapter () {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.position = { x: 0, y: 64.62, z: 0 };
  adapter._feet = { x: 0, y: 63, z: 0 };
  adapter.nearbyBlocks = {};
  adapter.inventory = {};
  return adapter;
}

test('_pickupNearby walks onto close drops and reports them', async () => {
  const adapter = dropAdapter();
  adapter.drops = [
    { id: 'a', item: 'coal', count: 1, position: { x: 2, y: 63, z: 0 }, spawnedAt: Date.now() },
    { id: 'b', item: 'coal', count: 1, position: { x: 20, y: 63, z: 0 }, spawnedAt: Date.now() },
  ];
  adapter._moveTo = async target => {
    adapter.drops = adapter.drops.filter(drop => Math.hypot(drop.position.x - target.x, drop.position.z - target.z) > 0.5);
    return { ok: true };
  };
  const picked = await adapter._pickupNearby({ maxDistance: 3.5, budgetMs: 2000 });
  assert.deepEqual(picked, [{ item: 'coal', count: 1 }]);
  assert.equal(adapter.drops.length, 1, 'il drop lontano resta a terra');
});

test('_pickupNearby marks a drop failed when the approach fails', async () => {
  const adapter = dropAdapter();
  adapter.drops = [{ id: 'a', item: 'coal', count: 1, position: { x: 2, y: 63, z: 0 }, spawnedAt: Date.now() }];
  adapter._moveTo = async () => { throw new Error('path_failed'); };
  const picked = await adapter._pickupNearby({ maxDistance: 3.5, budgetMs: 1500 });
  assert.deepEqual(picked, []);
  assert.ok(adapter.drops[0].failedAt, 'segnato come fallito');
});

test('_nearestDrop retries failed drops after ~10s', () => {
  const adapter = dropAdapter();
  adapter.drops = [{ id: 'a', item: 'coal', count: 1, position: { x: 2, y: 63, z: 0 }, failedAt: Date.now() - 11000 }];
  assert.ok(adapter._nearestDrop(), 'ritenta dopo la finestra');
  adapter.drops[0].failedAt = Date.now() - 5000;
  assert.equal(adapter._nearestDrop(), null, 'salta ancora dentro la finestra');
});

test('options put a fresh close drop before the waypoint', () => {
  const adapter = dropAdapter();
  adapter.plan = { waypoint: { x: 30, z: 30 }, targets: {} };
  adapter.drops = [{ id: 'a', item: 'coal', count: 1, position: { x: 2, y: 63, z: 0 }, spawnedAt: Date.now() - 1000 }];
  let keys = adapter.options().map(option => option.key);
  assert.ok(keys.indexOf('collect_drop') < keys.indexOf('goto_waypoint'), 'drop fresco prima del waypoint');
  adapter.drops[0].spawnedAt = Date.now() - 60000;
  keys = adapter.options().map(option => option.key);
  assert.ok(keys.indexOf('goto_waypoint') < keys.indexOf('collect_drop'), 'drop vecchio dopo il waypoint');
});

test('_mineBlock picks up the drop right after breaking', async () => {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.serverAuthBlockBreaking = true;
  adapter.position = { x: 92.5, y: 73.62, z: 148.5 };
  adapter._feet = { x: 92.5, y: 72, z: 148.5 };
  adapter.inventorySlots[3] = { network_id: 341, name: 'wooden_pickaxe', count: 1, stack_id: 5, metadata: 0 };
  const client = adapter.client = new EventEmitter();
  client.entityId = 1;
  client.queue = () => {};
  client.write = () => {};
  const block = { name: 'stone', position: { x: 92, y: 71, z: 148 }, diggable: true, hardness: 1.5, material: 'mineable/pickaxe' };
  let remaining = block;
  adapter.world.blockAt = () => remaining;
  adapter.world.runtimeIdAt = () => 0xf1234567;
  adapter.world.refreshSection = () => { remaining = { name: 'air' }; };
  adapter.world.registry = { items: { 341: { name: 'wooden_pickaxe', maxDurability: 59 } } };
  adapter._refreshNearby = () => {};
  let pickups = 0;
  adapter._pickupNearby = async () => { pickups++; return [{ item: 'cobblestone', count: 1 }]; };
  const result = await adapter._mineBlock(block, 10000);
  assert.equal(result.ok, true);
  assert.equal(pickups, 1);
  assert.deepEqual(result.picked, [{ item: 'cobblestone', count: 1 }]);
});

test('_mineRawCell picks up after breaking an unknown cell', async () => {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.client = { write () {} };
  adapter.position = { x: 0.5, y: 65.62, z: 0.5 };
  adapter._feet = { x: 0.5, y: 64, z: 0.5 };
  let reads = 0;
  adapter.world.blockAt = () => (reads++ < 2 ? { name: 'unknown', runtimeId: 42 } : { name: 'air', runtimeId: 7 });
  adapter.world.runtimeIdAt = () => 42;
  adapter.world.refreshSection = () => {};
  adapter._refreshNearby = () => {};
  adapter._queueAuthInput = async () => {};
  adapter._pickupNearby = async () => [{ item: 'dirt', count: 1 }];
  const result = await adapter._mineRawCell({ x: 0, y: 66, z: 0 }, 2000);
  assert.equal(result.ok, true);
  assert.deepEqual(result.picked, [{ item: 'dirt', count: 1 }]);
});
