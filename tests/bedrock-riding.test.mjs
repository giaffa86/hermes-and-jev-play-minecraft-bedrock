import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { BedrockAdapter } from '../bedrock-adapter.mjs';
import { isVehicleType, isRideableType } from '../bedrock-survival.mjs';

const require = createRequire(import.meta.url);
const { createSerializer } = require('bedrock-protocol/src/transforms/serializer');
const serializer = createSerializer('1.26.51');

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
  assert.equal(isRideableType('trader_llama'), true); // cavalcati live il 04/10/2026
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

test('_mountEntity refuses a target behind a wall without interacting (live 04/10/2026)', async () => {
  const adapter = spawnedAdapter();
  adapter._trackEntity({ runtime_id: 210n, entity_type: 'minecraft:donkey', position: { x: 2, y: 63, z: 0 } }, 'mob');
  const logs = [];
  adapter.log = (event, fields) => logs.push({ event, fields });
  const packets = [];
  adapter.client.write = (name, params) => packets.push({ name, params });
  adapter._entityVisible = () => ({ visible: false, blockedBy: 'oak_planks', blockedAt: { x: 1, y: 64, z: 0 }, t: 0.5, unknown: false });

  await adapter._mountEntity(adapter.entities.get('210'), Date.now() + 5000);

  assert.equal(packets.filter(p => p.name === 'inventory_transaction').length, 0,
    'niente interact: il donkey è dietro un muro');
  assert.equal(logs.filter(l => l.event === 'mount_target_blocked').length, 1);
  assert.equal(logs.find(l => l.event === 'mount_target_blocked').fields.blockedBy, 'oak_planks');
});

test('_dismount sends player_action start_sneak and clears riding', async () => {
  const adapter = spawnedAdapter();
  adapter.riding = { riddenEntityId: '200', at: Date.now() };
  const actions = [];
  adapter.client.write = (name, payload) => {
    actions.push([name, payload]);
    if (name === 'player_action' && payload.action === 'start_sneak') adapter.riding = null;
  };
  const result = await adapter._dismount();
  assert.equal(result.ok, true);
  assert.ok(actions.some(([n, p]) => n === 'player_action' && p.action === 'start_sneak'));
  // `player_action` senza `position`/`result_position`/`face` non si serializza:
  // lo smontaggio non sarebbe mai partito.
  for (const [name, params] of actions) {
    assert.doesNotThrow(() => serializer.createPacketBuffer({ name, params }), `serialize ${name}`);
  }
});

// ---- mano libera e sneak (regole verificate con un client reale il 04/10/2026) ------

test('_selectHotbarSlot libera la mano solo con allowEmpty', () => {
  const adapter = spawnedAdapter();
  adapter.inventorySlots = [{}, { name: 'dirt', network_id: 5, count: 1 }, {}, {}, {}, {}, {}, {}, {}];
  adapter.selectedHotbar = 1;
  const writes = [];
  adapter.client.write = (name, payload) => writes.push([name, payload]);
  assert.equal(adapter._selectHotbarSlot(0), false, 'uno slot vuoto non è selezionabile di default');
  assert.equal(adapter.selectedHotbar, 1, 'senza allowEmpty non cambia nulla');
  assert.equal(writes.length, 0);
  assert.equal(adapter._selectHotbarSlot(0, { allowEmpty: true }), true);
  assert.equal(adapter.selectedHotbar, 0);
  const equip = writes.find(([n]) => n === 'mob_equipment');
  assert.deepEqual(equip[1].item, { network_id: 0 }, 'slot vuoto = item vuoto');
  assert.equal(equip[1].selected_slot, 0);
});

test('_freeHands spegne lo sneak e seleziona uno slot vuoto', () => {
  const adapter = spawnedAdapter();
  adapter.inventorySlots = [{ name: 'coal', network_id: 9, count: 3 }, {}, {}, {}, {}, {}, {}, {}, {}];
  adapter.selectedHotbar = 0;
  adapter._sneaking = true;
  const writes = [];
  adapter.client.write = (name, payload) => writes.push([name, payload]);
  assert.equal(adapter._freeHands('mount'), 'empty');
  assert.deepEqual(writes.map(([n]) => n), ['player_action', 'mob_equipment']);
  assert.deepEqual([writes[0][1].action, writes[1][1].item.network_id], ['stop_sneak', 0]);
  assert.equal(adapter.selectedHotbar, 1);
  assert.equal(adapter._sneaking, false);
  // mani già libere: lo `stop_sneak` esce comunque — è un comando allo stato del
  // server, non un'ipotesi locale (evidenza live 04/10/2026)
  writes.length = 0;
  assert.equal(adapter._freeHands('mount'), 'empty');
  assert.deepEqual(writes.map(([n]) => n), ['player_action']);
  assert.equal(writes[0][1].action, 'stop_sneak');
});

test('_freeHands non inventa una slot vuota se la hotbar è piena', () => {
  const adapter = spawnedAdapter();
  const logs = [];
  adapter.onLog = (entry) => logs.push(entry);
  adapter.inventorySlots = Array.from({ length: 9 }, (_, i) => ({ name: 'dirt', network_id: i + 1, count: 1 }));
  adapter.selectedHotbar = 3;
  assert.equal(adapter._freeHands('mount'), 'full_hotbar');
  assert.equal(adapter.selectedHotbar, 3, 'nessuno slot vuoto: la mano resta quella che era');
  assert.ok(logs.some(e => e.type === 'hand_not_empty'), 'la diagnosi dichiara la hotbar piena');
});

test('_mountVehicle prepara mano libera e niente sneak, e riporta la mano nella diagnosi', async () => {
  const adapter = spawnedAdapter();
  adapter.inventorySlots = [{ name: 'dirt', network_id: 4, count: 2 }, {}, {}, {}, {}, {}, {}, {}, {}];
  adapter.selectedHotbar = 0;
  adapter._sneaking = true;
  adapter._trackEntity({ runtime_id: 200n, unique_id: 2000n, entity_type: 'minecraft:donkey', position: { x: 2, y: 63, z: 0 } }, 'mob');
  adapter._moveTo = async () => ({ ok: true });
  const writes = [];
  adapter.client.write = (name, payload) => writes.push([name, payload]);
  adapter._interactEntity = () => true; // il server non manda il link: nessun mount
  const result = await adapter._mountVehicle('donkey', 300);
  assert.deepEqual([result.ok, result.error, result.hand], [false, 'mount_not_confirmed', 'empty']);
  assert.ok(writes.some(([n, p]) => n === 'player_action' && p.action === 'stop_sneak'), 'sneak spento prima dell\'interact');
  assert.ok(writes.some(([n, p]) => n === 'mob_equipment' && p.item.network_id === 0), 'slot vuoto selezionato');
});

test('_dismount spegne lo sneak dopo il link di rimozione', async () => {
  const adapter = spawnedAdapter();
  adapter.riding = { riddenEntityId: '200', at: Date.now() };
  const actions = [];
  adapter.client.write = (name, payload) => {
    actions.push([name, payload]);
    if (name === 'player_action' && payload.action === 'start_sneak') adapter.riding = null;
  };
  const result = await adapter._dismount(1000);
  assert.equal(result.ok, true);
  assert.deepEqual(actions.map(([n, p]) => `${n}:${p.action}`), ['player_action:start_sneak', 'player_action:stop_sneak']);
  assert.equal(adapter._sneaking, false, 'lo sneak dello smontaggio non resta addosso al bot');
  for (const [name, params] of actions) {
    assert.doesNotThrow(() => serializer.createPacketBuffer({ name, params }), `serialize ${name}`);
  }
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

// ---- link di mount: il pacchetto porta UN link, non una lista ------------------------

test('_onEntityLink legge il campo `link` singolo e conferma il mount (live 04/10/2026)', () => {
  const adapter = spawnedAdapter();
  const logs = [];
  adapter.log = (tag, data) => logs.push([tag, data]);
  // Forma reale dello schema 1.26.51 (`packet_set_entity_link` -> `link`), con
  // gli id decodificati come zigzag64 (BigInt): il gestore confrontava
  // `packet.links`, che non esiste, e non impostava mai `riding`.
  const seen = adapter._onEntityLink({
    link: { ridden_entity_id: 200n, rider_entity_id: 7n, type: 1, immediate: false },
  });
  assert.equal(adapter.riding?.riddenEntityId, '200');
  assert.equal(logs.at(-1)?.[0], 'mount');
  assert.deepEqual(seen, [{ rider: '7', ridden: '200', type: 1 }]);
});

test('_onEntityLink ignora un altro cavaliere e il tipo 0 smonta', () => {
  const adapter = spawnedAdapter();
  adapter.riding = { riddenEntityId: '200', at: Date.now() };
  // Un link di un altro giocatore non tocca lo stato locale.
  adapter._onEntityLink({ link: { ridden_entity_id: 200n, rider_entity_id: 9n, type: 1 } });
  assert.equal(adapter.riding?.riddenEntityId, '200');
  // Il tipo 0 è lo smontaggio di questo cavaliere.
  adapter._onEntityLink({ link: { ridden_entity_id: 200n, rider_entity_id: 7n, type: 0 } });
  assert.equal(adapter.riding, null);
  // Compatibilità: una lista `links` resta accettata.
  adapter._onEntityLink({ links: [{ ridden_entity_id: 201n, rider_entity_id: 7n, type: 2 }] });
  assert.equal(adapter.riding?.riddenEntityId, '201');
  // Pacchetto vuoto: nessun effetto e nessuna eccezione.
  assert.deepEqual(adapter._onEntityLink({}), []);
});
