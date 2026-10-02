import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BedrockAdapter } from '../bedrock-adapter.mjs';
import {
  bestFood, isHostileType, entityHeight, normalizeEntityType,
  estimatedTimeOfDay, isNightTime, timePhase, awayDirection, rotateDirection,
} from '../bedrock-survival.mjs';

// ---- regole pure --------------------------------------------------------------------

test('hostile classification ignores the minecraft prefix', () => {
  assert.equal(isHostileType('minecraft:zombie'), true);
  assert.equal(isHostileType('ZOMBIE'), true);
  assert.equal(isHostileType('skeleton'), true);
  assert.equal(isHostileType('creeper'), true);
  assert.equal(isHostileType('ender_dragon'), true);
  assert.equal(isHostileType('cow'), false);
  assert.equal(isHostileType('player'), false);
  assert.equal(normalizeEntityType(undefined), '');
});

test('entity heights fall back to a humanoid default', () => {
  assert.equal(entityHeight('zombie'), 1.95);
  assert.equal(entityHeight('minecraft:spider'), 0.9);
  assert.equal(entityHeight('cow'), 1.8);
});

test('bestFood prefers cooked food and skips unsafe or precious items', () => {
  assert.equal(bestFood({ cooked_beef: 1, bread: 3 }), 'cooked_beef');
  assert.equal(bestFood({ bread: 1, carrot: 9 }), 'bread');
  assert.equal(bestFood({ carrot: 1, cookie: 2 }), 'carrot');
  assert.equal(bestFood({ rotten_flesh: 5, spider_eye: 1, golden_apple: 1 }), null);
  assert.equal(bestFood({}), null);
});

test('time of day estimation advances with real time and detects night', () => {
  const now = 1_000_000;
  assert.equal(estimatedTimeOfDay(13999, now, now), 13999);
  assert.equal(estimatedTimeOfDay(13999, now, now + 50), 14000);
  assert.equal(estimatedTimeOfDay(23999, now, now + 50), 0);
  assert.equal(estimatedTimeOfDay(23000, now - 25 * 1000, now), 23500);
  assert.equal(isNightTime(13000), true);
  assert.equal(isNightTime(18000), true);
  assert.equal(isNightTime(23000), true);
  assert.equal(isNightTime(1000), false);
  assert.equal(isNightTime(6000), false);
  assert.equal(timePhase(13000), 'dusk');
  assert.equal(timePhase(18000), 'night');
  assert.equal(timePhase(23000), 'dawn');
  assert.equal(timePhase(6000), 'day');
});

test('away and rotate directions point opposite the threat', () => {
  const away = awayDirection({ x: 0, z: 0 }, { x: 10, z: 0 });
  assert.ok(Math.abs(away.x + 1) < 1e-9 && Math.abs(away.z) < 1e-9);
  const rotated = rotateDirection({ x: 0, z: 1 }, 90);
  assert.ok(Math.abs(rotated.x + 1) < 1e-9 && Math.abs(rotated.z) < 1e-9);
  const same = awayDirection({ x: 5, z: 5 }, { x: 5, z: 5 });
  assert.equal(Math.hypot(same.x, same.z), 1);
});

// ---- adapter: tracking entità --------------------------------------------------------

function spawnedAdapter () {
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

test('add_entity tracks mobs, positions and hostile distance', () => {
  const adapter = spawnedAdapter();
  adapter._trackEntity({ runtime_id: 42n, unique_id: 900n, entity_type: 'minecraft:zombie', position: { x: 3, y: 63, z: 0 } }, 'mob');
  adapter._trackEntity({ runtime_id: 43n, unique_id: 901n, entity_type: 'minecraft:cow', position: { x: 5, y: 63, z: 0 } }, 'mob');
  const nearby = adapter._nearbyEntities(8);
  assert.equal(nearby.length, 2);
  assert.equal(nearby[0].type, 'zombie');
  assert.equal(nearby[0].hostile, true);
  assert.equal(nearby[1].hostile, false);
  const hostiles = adapter._hostiles();
  assert.equal(hostiles.length, 1);
  assert.equal(hostiles[0].type, 'zombie');
  assert.ok(hostiles[0].distance > 2.9 && hostiles[0].distance < 3.2);
});

test('move_entity_delta applies absolute coordinates and removal works by unique id', () => {
  const adapter = spawnedAdapter();
  adapter._trackEntity({ runtime_id: 42n, unique_id: 900n, entity_type: 'zombie', position: { x: 1, y: 63, z: 0 } }, 'mob');
  adapter._onEntityMove({ runtime_entity_id: 42n, x: 4, y: 63, z: 1 });
  assert.deepEqual(adapter.entities.get('42').position, { x: 4, y: 63, z: 1 });
  adapter._onEntityRemove({ entity_id_self: 900n });
  assert.equal(adapter.entities.size, 0);
});

test('entity metadata updates mob health and own sleeping flag', () => {
  const adapter = spawnedAdapter();
  adapter._trackEntity({ runtime_id: 42n, unique_id: 900n, entity_type: 'zombie', position: { x: 3, y: 63, z: 0 } }, 'mob');
  adapter._applyEntityMetadata({ runtime_entity_id: 42n, metadata: [{ key: 'health', value: 12 }] });
  assert.equal(adapter.entities.get('42').health, 12);
  adapter._applyEntityMetadata({ runtime_entity_id: 7n, metadata: [{ key: 'flags', value: { resting: true, sneaking: false } }] });
  assert.equal(adapter.sleeping, true);
  adapter._applyEntityMetadata({ runtime_entity_id: 7n, metadata: [{ key: 'flags', value: { resting: false } }] });
  assert.equal(adapter.sleeping, false);
});

test('numeric metadata flags fall back to the resting bit', () => {
  const adapter = spawnedAdapter();
  const resting = 1n << 23n;
  adapter._applyEntityMetadata({ runtime_entity_id: 7n, metadata: [{ key: 0, value: resting }] });
  assert.equal(adapter.sleeping, true);
  adapter._applyEntityMetadata({ runtime_entity_id: 7n, metadata: [{ key: 0, value: 0n }] });
  assert.equal(adapter.sleeping, false);
});

test('own attributes use the current field for health and hunger', () => {
  const adapter = spawnedAdapter();
  adapter._applyOwnAttributes({ runtime_entity_id: 7n, attributes: [
    { name: 'minecraft:health', current: 15, value: 0 },
    { name: 'minecraft:player.hunger', current: 11, value: 0 },
  ] });
  assert.equal(adapter.health, 15);
  assert.equal(adapter.food, 11);
  // Pacchetto di un'altra entità: ignorato.
  adapter._applyOwnAttributes({ runtime_entity_id: 42n, attributes: [{ name: 'minecraft:player.hunger', current: 3 }] });
  assert.equal(adapter.food, 11);
});

test('bed positions do not mark the bot as sleeping (only the resting flag does)', () => {
  const adapter = spawnedAdapter();
  adapter._applyEntityMetadata({ runtime_entity_id: 7n, metadata: [{ key: 'player_bed_position', value: { x: 92, y: 73, z: 162 } }] });
  assert.equal(adapter.sleeping, false);
  adapter._applyEntityMetadata({ runtime_entity_id: 7n, metadata: [{ key: 'flags', value: { resting: true } }] });
  assert.equal(adapter.sleeping, true);
});

test('death and respawn flip the survival state', () => {
  const adapter = spawnedAdapter();
  adapter.health = 0;
  adapter._onOwnHealth();
  assert.equal(adapter.dead, true);
  assert.equal(adapter.deaths, 1);
  adapter._onRespawnPacket({ state: 1, position: { x: 10, y: 70.62, z: 10 } });
  assert.equal(adapter.dead, false);
  assert.deepEqual(adapter.position, { x: 10, y: 70.62, z: 10 });
  assert.equal(adapter._feet.y, 70.62 - 1.62);
});

test('set_time enables the night estimate in observe', () => {
  const adapter = spawnedAdapter();
  adapter._recordTime(18000);
  const info = adapter._timeInfo();
  assert.equal(info.phase, 'night');
  assert.equal(info.night, true);
  assert.equal(adapter._isNight(), true);
});

test('sync_world_clocks picks the overworld clock and follows sync_state', () => {
  const adapter = spawnedAdapter();
  adapter._onWorldClocks({
    payload_type: 'initialize_registry',
    clocks: [
      { id: 1n, name: 'minecraft:other', time: 1000, paused: false },
      { id: 2n, name: 'minecraft:overworld', time: 8000, paused: false },
    ],
  });
  assert.equal(adapter._worldClockId, '2');
  assert.equal(adapter._timeInfo().phase, 'day');
  adapter._onWorldClocks({ payload_type: 'sync_state', sync_states: [{ clock_id: 2n, time: 14000, paused: false }] });
  assert.equal(adapter._timeInfo().ticks, 14000);
  assert.equal(adapter._isNight(), true);
  // Un sync_state di un altro clock non deve toccare l'ora scelta.
  adapter._onWorldClocks({ payload_type: 'sync_state', sync_states: [{ clock_id: 1n, time: 6000, paused: false }] });
  assert.equal(adapter._timeInfo().ticks, 14000);
});

test('a server respawn packet while dead completes with client_ready and revives', () => {
  const adapter = spawnedAdapter();
  const packets = [];
  adapter.client.write = (name, params) => packets.push({ name, params });
  adapter.health = 0;
  adapter._onOwnHealth();
  assert.equal(adapter.dead, true);
  // state 0 (searching): si risponde client_ready ma non si risorge sulla posizione di morte.
  adapter._onRespawnPacket({ state: 0, position: { x: 83, y: 75, z: 176 } });
  assert.equal(adapter.dead, true, 'state 0 non chiude il respawn');
  assert.equal(packets[0].name, 'respawn');
  assert.equal(packets[0].params.state, 2);
  // state 1 (server ready): posizione finale e stato vivo.
  adapter._onRespawnPacket({ state: 1, position: { x: 90, y: 74.62, z: 150 } });
  assert.equal(adapter.dead, false);
  assert.equal(adapter.position.y, 74.62);
  assert.equal(adapter._feet.y, 74.62 - 1.62);
});

test('respawn fallback closes the death state when state 1 never arrives', () => {
  const adapter = spawnedAdapter();
  adapter.client.write = () => {};
  adapter.health = 0;
  adapter._onOwnHealth();
  adapter._onRespawnPacket({ state: 0, position: { x: 83, y: 75, z: 176 } });
  assert.equal(adapter.dead, true);
  adapter._pendingRespawn.at = Date.now() - 5000;
  adapter._survivalTick();
  assert.equal(adapter.dead, false);
});

test('unsolicited respawn packets do not move the bot', () => {
  const adapter = spawnedAdapter();
  adapter._onRespawnPacket({ position: { x: 0, y: 0, z: 0 } });
  assert.deepEqual(adapter.position, { x: 0, y: 64.62, z: 0 });
  assert.equal(adapter.dead, false);
});

// ---- adapter: options e azioni --------------------------------------------------------

test('options offer attack, flee, eat and sleep when the situation requires it', () => {
  const adapter = spawnedAdapter();
  adapter.nearbyBlocks = {};
  adapter.drops = [];
  adapter.inventory = { bread: 2, cooked_beef: 1 };
  adapter.food = 9;
  adapter._trackEntity({ runtime_id: 42n, unique_id: 900n, entity_type: 'minecraft:zombie', position: { x: 4, y: 63, z: 0 } }, 'mob');
  adapter._recordTime(18000);
  adapter.world.findBlocks = (name) => name === 'bed' ? [{ name: 'bed', position: { x: 2, y: 63, z: 2 }, distance: 3 }] : [];
  const keys = adapter.options().map(o => o.key);
  assert.ok(keys.includes('attack_zombie'), 'attack option');
  assert.ok(keys.includes('flee'), 'flee option');
  assert.ok(keys.includes('eat'), 'eat option');
  assert.ok(keys.includes('sleep'), 'sleep option');
});

test('options collapse to wait while dead or sleeping', () => {
  const adapter = spawnedAdapter();
  adapter.dead = true;
  assert.deepEqual(adapter.options().map(o => o.key), ['wait']);
  adapter.dead = false;
  adapter.sleeping = true;
  assert.deepEqual(adapter.options().map(o => o.key), ['wait']);
});

test('executeAction refuses actions while dead or sleeping', async () => {
  const adapter = spawnedAdapter();
  adapter.dead = true;
  const dead = await adapter.executeAction('mine_stone');
  assert.equal(dead.error, 'dead');
  adapter.dead = false;
  adapter.sleeping = true;
  const sleeping = await adapter.executeAction('eat');
  assert.equal(sleeping.error, 'sleeping');
});

test('attack options are deduped by mob type', () => {
  const adapter = spawnedAdapter();
  adapter.nearbyBlocks = {};
  adapter.drops = [];
  adapter.inventory = {};
  adapter._trackEntity({ runtime_id: 1n, unique_id: 11n, entity_type: 'zombie', position: { x: 5, y: 63, z: 0 } }, 'mob');
  adapter._trackEntity({ runtime_id: 2n, unique_id: 12n, entity_type: 'zombie', position: { x: 6, y: 63, z: 0 } }, 'mob');
  adapter._trackEntity({ runtime_id: 3n, unique_id: 13n, entity_type: 'skeleton', position: { x: 7, y: 63, z: 0 } }, 'mob');
  const attackKeys = adapter.options().map(o => o.key).filter(key => key.startsWith('attack_'));
  assert.deepEqual(attackKeys, ['attack_zombie', 'attack_skeleton']);
});

test('attack uses an item_use_on_entity transaction with swing animation', () => {
  const adapter = spawnedAdapter();
  const packets = [];
  adapter.client.write = (name, params) => packets.push({ name, params });
  adapter.inventorySlots[0] = { network_id: 10, name: 'wooden_sword', count: 1, stack_id: 3 };
  adapter.selectedHotbar = 0;
  adapter._attackEntity({ type: 'zombie', runtimeId: '42', position: { x: 3, y: 63, z: 0 } });
  const attack = packets.find(p => p.name === 'inventory_transaction');
  assert.equal(attack.params.transaction.transaction_type, 'item_use_on_entity');
  assert.equal(attack.params.transaction.transaction_data.action_type, 'attack');
  assert.equal(attack.params.transaction.transaction_data.entity_runtime_id, 42n);
  assert.equal(attack.params.transaction.transaction_data.click_pos.y, 63 + 1.95 / 2);
  assert.equal(packets.some(p => p.name === 'animate' && p.params.action_id === 'swing_arm'), true);
});

test('combat chases and returns success when the mob dies', async () => {
  const adapter = spawnedAdapter();
  adapter._queueAuthInput = async () => {};
  adapter._selectWeapon = async () => null;
  adapter._moveTo = async () => ({ ok: true });
  let hits = 0;
  adapter._attackEntity = () => {
    hits++;
    if (hits >= 2) {
      const tracked = adapter.entities.get('42');
      tracked.health = 0;
      tracked.deadAt = Date.now();
    }
    return true;
  };
  adapter._trackEntity({ runtime_id: 42n, unique_id: 900n, entity_type: 'zombie', position: { x: 2, y: 63, z: 0 } }, 'mob');
  const result = await adapter._combat('zombie', 3000);
  assert.equal(result.ok, true);
  assert.equal(result.killed, true);
  assert.equal(hits, 2);
});

test('eat uses a click_air item use transaction and confirms on hunger rise', async () => {
  const adapter = spawnedAdapter();
  adapter.food = 12;
  adapter.inventory = { cooked_beef: 2 };
  adapter.inventorySlots[0] = { network_id: 10, name: 'cooked_beef', count: 2, stack_id: 3 };
  const transactions = [];
  adapter._queueAuthInput = async (input) => {
    transactions.push(input);
    adapter.food = 18; // il server conferma subito
  };
  const result = await adapter._eat(1000);
  assert.equal(result.ok, true);
  assert.equal(result.item, 'cooked_beef');
  assert.equal(transactions[0].transaction.data.action_type, 'click_air');
  assert.equal(transactions[0].transaction.data.face, 255);
});

test('eat reports missing food without touching the client', async () => {
  const adapter = spawnedAdapter();
  const result = await adapter._eat(1000);
  assert.deepEqual(result, { ok: false, error: 'no_food' });
});

test('flee picks a standable point away from the threat and walks there', async () => {
  const adapter = spawnedAdapter();
  adapter._trackEntity({ runtime_id: 42n, unique_id: 900n, entity_type: 'zombie', position: { x: -4, y: 63, z: 0 } }, 'mob');
  adapter._standableNear = point => ({ x: point.x, y: adapter._feet.y, z: point.z });
  let target = null;
  adapter._moveTo = async (point) => { target = point; return { ok: true }; };
  const result = await adapter._flee(5000);
  assert.equal(result.ok, true);
  assert.equal(result.from, 'zombie');
  assert.ok(target.x > adapter._feet.x, 'si allontana dal mob a ovest');
});

test('flee counts a timeout as success when it still gains distance', async () => {
  const adapter = spawnedAdapter();
  adapter._trackEntity({ runtime_id: 42n, unique_id: 900n, entity_type: 'zombie', position: { x: -4, y: 63, z: 0 } }, 'mob');
  adapter._standableNear = point => ({ x: point.x, y: adapter._feet.y, z: point.z });
  adapter._moveTo = async () => {
    adapter._feet.x += 10;
    adapter._syncPositionFromFeet();
    throw new Error('movement timeout');
  };
  const result = await adapter._flee(5000);
  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
});

test('sleepInBed reports success when the night is skipped (fast-forward)', async () => {
  const adapter = spawnedAdapter();
  adapter._recordTime(18000);
  adapter.world.findBlocks = name => name === 'bed' ? [{ name: 'bed', position: { x: 0, y: 63, z: 2 }, distance: 2 }] : [];
  let inputs = 0;
  adapter._queueAuthInput = async () => {
    inputs++;
    if (inputs >= 2) adapter._recordTime(200); // il server salta la notte al click
  };
  const result = await adapter._sleepInBed({ confirmMs: 300 });
  assert.equal(result.ok, true);
  assert.equal(result.slept, 'night_skipped');
});

test('sleepInBed clicks the bed and reports the rejection when sleep does not start', async () => {
  const adapter = spawnedAdapter();
  adapter._recordTime(18000);
  adapter.world.findBlocks = (name) => name === 'bed' ? [{ name: 'bed', position: { x: 0, y: 63, z: 2 }, distance: 2 }] : [];
  adapter._queueAuthInput = async () => {};
  const result = await adapter._sleepInBed({ confirmMs: 10 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'sleep_rejected');
});
