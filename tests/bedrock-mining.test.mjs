import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { BedrockAdapter } from '../bedrock-adapter.mjs';
const require = createRequire(import.meta.url);
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer');
const serializer = createSerializer('1.26.51');
const parser = createDeserializer('1.26.51');

function miningAdapter (serverAuth, confirmedName = 'air', hardness = 0) {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.serverAuthBlockBreaking = serverAuth;
  adapter.position = { x: 78.5, y: 73.62, z: 159.5 };
  const block = { name: 'potatoes', position: { x: 78, y: 71, z: 160 }, diggable: true, hardness };
  const packets = [];
  const client = adapter.client = new EventEmitter();
  client.entityId = 1;
  client.queue = () => {};
  client.write = (name, params) => packets.push(parser.parsePacketBuffer(serializer.createPacketBuffer({ name, params })).data.params);
  let remaining = block;
  adapter.world.blockAt = () => remaining;
  adapter.world.runtimeIdAt = () => 0xf1234567;
  adapter.world.refreshSection = () => { remaining = confirmedName == null ? null : { name: confirmedName }; };
  adapter._refreshNearby = () => {};
  return { adapter, client, block, packets };
}

test('instant server-auth mining predicts on the same tick as start', async () => {
  const { adapter, block, client, packets } = miningAdapter(true);
  const result = await adapter._mineBlock(block);
  assert.equal(result.ok, true);
  assert.equal(result.confirmedBy, 'server_world');
  assert.deepEqual(packets[0].block_action.map(action => action.action), ['start_break', 'predict_break']);
  assert.deepEqual(packets[1].block_action.map(action => action.action), ['stop_break']);
  assert.equal(packets[0].transaction, undefined);
  assert.equal(client.listenerCount('level_event'), 0);
});

test('legacy mining embeds a transaction with the actual unsigned runtime hash', async () => {
  const { adapter, block, packets } = miningAdapter(false);
  assert.equal((await adapter._mineBlock(block)).ok, true);
  assert.deepEqual(packets[1].input_data, ['block_breaking_delay_enabled', 'block_action', 'item_interact']);
  assert.equal(packets[1].transaction.data.action_type, 'break_block');
  assert.equal(packets[1].transaction.data.block_runtime_id >>> 0, 0xf1234567);
  assert.equal(packets[1].transaction.data.hand, 'main_hand');
  assert.equal(packets[0].block_action[0].action, 'start_break');
});

test('timed mining starts once and predicts on the final progress tick', async () => {
  const { adapter, block, packets } = miningAdapter(true, 'air', 0.1);
  assert.equal((await adapter._mineBlock(block)).ok, true);
  assert.deepEqual(packets.map(packet => packet.block_action?.map(action => action.action)), [
    ['start_break'], ['continue_break'], ['continue_break'], ['continue_break'],
    ['continue_break'], ['continue_break'], ['continue_break', 'predict_break'], ['stop_break'],
  ]);
});

test('held tools encode mine-block variant and compatibility ID separately', async () => {
  const { adapter, block, packets } = miningAdapter(true, 'air', 0.1);
  adapter.inventorySlots[0] = { network_id: 1, stack_id: 80, metadata: 0 };
  adapter.world.registry = { items: { 1: { name: 'iron_sword', maxDurability: 250 } } };
  assert.equal((await adapter._mineBlock(block)).ok, true);
  const request = packets.at(-2).item_stack_request;
  assert.equal(packets.at(-2).input_data.includes('item_stack_request'), true);
  assert.deepEqual(request.actions[0], { type_id: 'mine_block', legacy_type_id: 11,
    hotbar_slot: 0, predicted_durability: 2, network_id: 80 });
});

test('zero-hardness crops do not predict tool damage', async () => {
  const { adapter, block, packets } = miningAdapter(true);
  adapter.inventorySlots[0] = { network_id: 1, stack_id: 80, metadata: 0 };
  adapter.world.registry = { items: { 1: { name: 'iron_sword', maxDurability: 250 } } };
  assert.equal((await adapter._mineBlock(block)).ok, true);
  assert.equal(packets[0].item_stack_request, undefined);
});

test('blocks inside survival mining reach do not require an approach move', async () => {
  const { adapter, block } = miningAdapter(true);
  adapter.position = { x: 82, y: 73.62, z: 160.5 };
  adapter._moveTo = () => { throw new Error('unnecessary movement'); };
  assert.equal((await adapter._mineBlock(block)).ok, true);
});

for (const [name, expected] of [['potatoes', 'block_still_present'], [null, 'block_confirmation_timeout'], ['unknown', 'block_still_present']]) {
  test(`unconfirmed mining (${name}) never reports success`, async () => {
    const { adapter, block, client } = miningAdapter(true, name);
    const result = await adapter._mineBlock(block, 250);
    assert.equal(result.ok, false);
    assert.equal(result.error, expected);
    assert.equal(client.listenerCount('level_event'), 0);
  });
}

test('dig time follows the held tool tier and the block material', () => {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  const stone = { name: 'stone', diggable: true, hardness: 1.5, harvestTools: { 941: true }, material: 'mineable/pickaxe' };
  adapter.inventorySlots = [{ network_id: 341, name: 'wooden_pickaxe' }];
  adapter.selectedHotbar = 0;
  assert.equal(adapter._digTime(stone), (23 + 3) * 50);
  adapter.inventorySlots = [{ network_id: 345, name: 'stone_pickaxe' }];
  assert.equal(adapter._digTime(stone), (12 + 3) * 50);
  adapter.inventorySlots = [];
  assert.equal(adapter._digTime(stone), (150 + 3) * 50, 'a mano la pietra è lentissima');
  const dirt = { name: 'dirt', diggable: true, hardness: 0.5, material: 'mineable/shovel' };
  assert.equal(adapter._digTime(dirt), (15 + 3) * 50);
});

test('heartbeat emits queued actions once per tick', async () => {
  const { adapter, packets } = miningAdapter(true);
  adapter._authTickInterval = true;
  const first = adapter._queueAuthInput({ blockAction: [{ action: 'start_break', position: { x: 0, y: 0, z: 0 }, face: 1 }] });
  const second = adapter._queueAuthInput({ blockAction: [{ action: 'continue_break', position: { x: 0, y: 0, z: 0 }, face: 1 }] });
  assert.equal(packets.length, 0);
  adapter._authTick();
  await first;
  assert.equal(packets.length, 1);
  adapter._authTick();
  await second;
  assert.equal(packets.length, 2);
  assert.equal(packets[1].tick - packets[0].tick, 1n);
});
