import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

const require = createRequire(import.meta.url);
const { createSerializer } = require('bedrock-protocol/src/transforms/serializer');
const serializer = createSerializer('1.26.51');

function packetAdapter () {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.client = new EventEmitter();
  adapter.client.entityId = 7n;
  adapter.client.write = () => {};
  adapter.position = { x: 0, y: 64.62, z: 0 };
  adapter._feet = { x: 0, y: 63, z: 0 };
  return adapter;
}

function capture (adapter) {
  const packets = [];
  adapter.client.write = (name, params) => packets.push({ name, params });
  return packets;
}

function serializeAll (packets) {
  for (const packet of packets) {
    assert.doesNotThrow(() => serializer.createPacketBuffer({ name: packet.name, params: packet.params }),
      `serialize ${packet.name}`);
  }
}

test('attack transaction, swing and respawn packets serialize against protocol 1.26.51', () => {
  const adapter = packetAdapter();
  adapter.inventorySlots[0] = { network_id: 10, name: 'wooden_sword', count: 1, stack_id: 1 };
  adapter.selectedHotbar = 0;
  const packets = capture(adapter);
  adapter._attackEntity({ type: 'zombie', runtimeId: '42', position: { x: 1, y: 64, z: 1 } });
  adapter.dead = true;
  adapter._respawnAt = 0;
  adapter._survivalTick();
  adapter.dead = false;
  adapter.sleeping = true;
  adapter._bedCache = { at: Date.now(), bed: { position: { x: 1, y: 64, z: 1 } } };
  adapter._wake();
  adapter.sleeping = false;
  assert.ok(packets.length >= 4, 'attack + swing + respawn + stop_sleeping');
  serializeAll(packets);
});

test('eating click_air auth input serializes against protocol 1.26.51', () => {
  const adapter = packetAdapter();
  adapter.inventorySlots[0] = { network_id: 10, name: 'bread', count: 1, stack_id: 2 };
  adapter.selectedHotbar = 0;
  const packets = capture(adapter);
  adapter._sendAuthInput({
    yaw: 12,
    pitch: -3,
    transaction: adapter._useItemTransaction(adapter.inventorySlots[0], 'click_air'),
  });
  assert.equal(packets[0].name, 'player_auth_input');
  serializeAll(packets);
});

test('bed interaction uses the same click_block auth transaction as doors', () => {
  const adapter = packetAdapter();
  const packets = capture(adapter);
  adapter._sendAuthInput({
    yaw: 0,
    pitch: 10,
    transaction: adapter._blockUseTransaction({ x: 1, y: 63, z: 1 }),
  });
  assert.equal(packets[0].params.transaction.data.action_type, 'click_block');
  serializeAll(packets);
});
