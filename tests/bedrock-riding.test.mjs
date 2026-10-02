import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BedrockAdapter } from '../bedrock-adapter.mjs';
import { isVehicleType, isRideableType } from '../bedrock-survival.mjs';

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

// ---- classificazione veicoli --------------------------------------------------------

test('isVehicleType and isRideableType classify boats, minecarts and mounts', () => {
  assert.equal(isVehicleType('boat'), true);
  assert.equal(isVehicleType('oak_boat'), true);
  assert.equal(isVehicleType('oak_chest_boat'), true);
  assert.equal(isVehicleType('bamboo_raft'), true);
  assert.equal(isVehicleType('minecart'), true);
  assert.equal(isVehicleType('chest_minecart'), true);
  assert.equal(isVehicleType('hopper_minecart'), true);
  assert.equal(isVehicleType('cow'), false);
  assert.equal(isRideableType('horse'), true); // cavalcabile domabile
  assert.equal(isRideableType('nautilus'), true);
  assert.equal(isRideableType('boat'), true);
  assert.equal(isRideableType('cow'), false);
});

// ---- censimento e mount -------------------------------------------------------------

test('_nearbyRideable lists boats/minecarts/mounts and never other mobs', () => {
  const adapter = spawnedAdapter();
  adapter._trackEntity({ runtime_id: 200n, unique_id: 2000n, entity_type: 'minecraft:boat', position: { x: 2, y: 63, z: 0 } }, 'mob');
  adapter._trackEntity({ runtime_id: 201n, unique_id: 2001n, entity_type: 'minecraft:minecart', position: { x: 3, y: 63, z: 0 } }, 'mob');
  adapter._trackEntity({ runtime_id: 202n, unique_id: 2002n, entity_type: 'minecraft:cow', position: { x: 4, y: 63, z: 0 } }, 'mob');
  const rideable = adapter._nearbyRideable(8);
  assert.deepEqual(rideable.map(e => e.type).sort(), ['boat', 'minecart']);
});

test('_mountVehicle interacts and confirms via the riding link', async () => {
  const adapter = spawnedAdapter();
  adapter.inventorySlots = [{}, {}, {}, {}, {}, {}, {}, {}, {}];
  adapter._trackEntity({ runtime_id: 200n, unique_id: 2000n, entity_type: 'minecraft:boat', position: { x: 2, y: 63, z: 0 } }, 'mob');
  adapter._selectHotbarSlot = () => true;
  adapter._moveTo = async () => ({ ok: true });
  let interacted = false;
  adapter._interactEntity = () => { interacted = true; adapter.riding = { riddenEntityId: '200', at: Date.now() }; return true; };
  const result = await adapter._mountVehicle('boat');
  assert.equal(result.ok, true);
  assert.equal(result.mounted, 'boat');
  assert.equal(interacted, true);
});

test('_mountVehicle reports no rideable and already riding', async () => {
  const adapter = spawnedAdapter();
  adapter.inventory = {};
  adapter.world.findBlocks = () => [];
  adapter.world.blockAt = () => ({ name: 'air' });
  assert.equal((await adapter._mountVehicle('boat')).error, 'no_rideable_nearby');
  adapter.riding = { riddenEntityId: '200', at: Date.now() };
  assert.equal((await adapter._mountVehicle('boat')).error, 'already_riding');
});

test('_dismount sends player_action start_sneak and clears riding', async () => {
  const adapter = spawnedAdapter();
  adapter.riding = { riddenEntityId: '200', at: Date.now() };
  const actions = [];
  adapter.client.write = (name, payload) => {
    actions.push([name, payload]);
    if (name === 'player_action') adapter.riding = null;
  };
  const result = await adapter._dismount();
  assert.equal(result.ok, true);
  assert.ok(actions.some(([n, p]) => n === 'player_action' && p.action === 'start_sneak'));
});

// ---- movimento da montato -----------------------------------------------------------

test('_rideToward errors when not riding and returns when close', async () => {
  const adapter = spawnedAdapter();
  assert.equal((await adapter._rideToward({ x: 5, z: 5 })).error, 'not_riding');
  adapter.riding = { riddenEntityId: '200', at: Date.now() };
  adapter.position = { x: 0, y: 64.62, z: 0 };
  const result = await adapter._rideToward({ x: 1, z: 0 }, 3, 5000);
  assert.equal(result.ok, true);
});

test('_sendAuthInput adds client_predicted_vehicle and up while riding forward', () => {
  const adapter = spawnedAdapter();
  const writes = [];
  adapter.client.write = (name, payload) => writes.push([name, payload]);
  adapter.riding = { riddenEntityId: '200', at: Date.now() };
  adapter._ridingForward = true;
  adapter._ridingYaw = 90;
  adapter._sendAuthInput({});
  const auth = writes.find(([n]) => n === 'player_auth_input');
  assert.ok(auth, 'player_auth_input sent');
  assert.ok(auth[1].input_data.includes('client_predicted_vehicle'));
  assert.ok(auth[1].input_data.includes('up'));
  assert.deepEqual(auth[1].move_vector, { x: 0, z: 1 });
});

test('options offer mount_<type> and dismount', () => {
  const adapter = spawnedAdapter();
  adapter.inventory = {};
  adapter._trackEntity({ runtime_id: 200n, unique_id: 2000n, entity_type: 'minecraft:boat', position: { x: 2, y: 63, z: 0 } }, 'mob');
  adapter.world.findBlocks = () => [];
  adapter.world.blockAt = () => ({ name: 'air' });
  let keys = adapter.options().map(o => o.key);
  assert.ok(keys.includes('mount_boat'), 'mount_boat offered');
  adapter.riding = { riddenEntityId: '200', at: Date.now() };
  keys = adapter.options().map(o => o.key);
  assert.ok(keys.includes('dismount'), 'dismount offered');
});
