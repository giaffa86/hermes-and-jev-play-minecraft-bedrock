import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { BedrockAdapter } from '../bedrock-adapter.mjs';
import { SHIELD_INGREDIENTS } from '../bedrock-survival.mjs';

const require = createRequire(import.meta.url);
const { createSerializer } = require('bedrock-protocol/src/transforms/serializer');
const serializer = createSerializer('1.26.51');

// Adapter con lo stretto necessario per le opzioni e per il ciclo dello scudo.
// `_sendStackRequest` è stub: registra le richieste e restituisce una risposta
// con lo status voluto, così i test verificano la forma dei pacchetti senza un
// server (la stessa forma che _equipArmor usa per le armature).
function spawnedAdapter ({ stackStatus = 'ok', confirmOffhand = null, failTakes = 0 } = {}) {
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
  adapter.stackRequests = [];
  adapter.equipmentPackets = [];
  adapter.authFrames = [];
  adapter._moveTo = async () => ({ ok: true });
  adapter._queueAuthInput = async (input) => { adapter.authFrames.push(input); };
  adapter._selectHotbarSlot = () => true;
  adapter._resyncByReconnect = async () => { throw new Error('no_reconnect'); };
  adapter._refreshInventory = () => {
    const counts = {};
    for (const slot of adapter.inventorySlots) {
      if (!slot?.count) continue;
      counts[slot.name] = (counts[slot.name] || 0) + slot.count;
    }
    adapter.inventory = counts;
    return counts;
  };
  adapter.world.findBlocks = () => [];
  adapter.world.blockAt = () => ({ name: 'air' });
  adapter._sendStackRequest = async (actions) => {
    adapter.stackRequests.push(actions);
    const action = actions[0];
    const take = action.type_id === 'take';
    if (take && failTakes > 0) {
      // Cursore sporco lato server: il take viene rifiutato con status 50 e
      // l'item resta nello slot (nessuna copia locale stantia da aggiornare).
      failTakes--;
      return { status: 50, containers: [] };
    }
    if (take && adapter.inventorySlots[0]) adapter.inventorySlots[0].count -= 1;
    if (!take && confirmOffhand) {
      // Il server conferma l'offhand con un mob_equipment: è la via autorevole.
      adapter._onMobEquipment({ runtime_entity_id: 7n, window_id: 'offhand', item: { network_id: 42, count: 1, name: 'shield' }, selected_slot: 0 });
    }
    if (stackStatus !== 'ok') return { status: stackStatus, containers: [] };
    if (take) {
      const source = action.source.slot_type.container_id;
      return {
        status: 'ok',
        containers: [
          { slot_type: { container_id: source }, slots: [{ slot: action.source.slot, count: 0, item_stack_id: 0 }] },
          { slot_type: { container_id: 'cursor' }, slots: [{ slot: 0, count: 1, item_stack_id: 9 }] },
        ],
      };
    }
    return {
      status: 'ok',
      containers: [
        { slot_type: { container_id: 'cursor' }, slots: [{ slot: 0, count: 0, item_stack_id: 0 }] },
      ],
    };
  };
  adapter._applyStackResponse = (response) => {
    for (const container of response.containers || []) {
      const cid = container.slot_type?.container_id;
      for (const slot of container.slots || []) {
        if (cid === 'hotbar_and_inventory' || cid === 'inventory' || cid === 'hotbar') {
          if (slot.count === 0) adapter.inventorySlots[slot.slot] = undefined;
        }
      }
    }
  };
  adapter._responseSlotStack = (response, container, slot) => {
    for (const c of response.containers || []) {
      if (c.slot_type?.container_id !== container) continue;
      const hit = (c.slots || []).find(s => s.slot === slot);
      if (hit) return hit.item_stack_id;
    }
    return null;
  };
  adapter._slotInfo = (container, slot, stack = 0) => ({ slot_type: { container_id: container }, slot, stack_id: stack });
  adapter._invSlotAsSource = (index) => (index < 9 ? { container: 'hotbar', slot: index } : { container: 'hotbar_and_inventory', slot: index });
  adapter._returnCursorToInventory = async () => { adapter.returnedCursor = true; };
  // I take/place valgono solo con una finestra aperta: la primitiva condivisa
  // apre l'inventario del giocatore prima di ogni take.
  adapter.openedWindows = 0;
  adapter._ensureInventoryOpen = async () => { adapter.openedWindows++; };
  return adapter;
}

function zombie (adapter, runtimeId = 500n, position = { x: 4, y: 63, z: 0 }) {
  adapter._trackEntity({ runtime_id: runtimeId, unique_id: runtimeId + 900n, entity_type: 'minecraft:zombie', position }, 'mob');
}

// ---- dati ---------------------------------------------------------------------------

test('SHIELD_INGREDIENTS matches the Bedrock recipe (1 iron ingot, 6 planks)', () => {
  assert.equal(SHIELD_INGREDIENTS.iron_ingot, 1);
  assert.equal(SHIELD_INGREDIENTS.planks, 6);
});

// ---- opzioni ------------------------------------------------------------------------

test('options offer equip_shield only with a shield in the inventory', () => {
  const adapter = spawnedAdapter();
  adapter.inventory = {};
  assert.ok(!adapter.options().map(o => o.key).includes('equip_shield'), 'no shield, no option');
  adapter.inventory = { shield: 1 };
  assert.ok(adapter.options().map(o => o.key).includes('equip_shield'), 'shield in inventory');
  adapter.offhand = { name: 'shield', count: 1 };
  assert.ok(!adapter.options().map(o => o.key).includes('equip_shield'), 'already equipped');
});

test('options offer raise_shield only with the shield equipped and a hostile at hand', () => {
  const adapter = spawnedAdapter();
  adapter.offhand = { name: 'shield', count: 1 };
  assert.ok(!adapter.options().map(o => o.key).includes('raise_shield'), 'no threat');
  zombie(adapter);
  const withThreat = adapter.options().find(o => o.key === 'raise_shield');
  assert.ok(withThreat, 'threat within range');
  assert.match(withThreat.description, /zombie/);
  adapter.shieldUp = true;
  const keys = adapter.options().map(o => o.key);
  assert.ok(keys.includes('lower_shield'), 'shield up: lower offered');
  assert.ok(!keys.includes('raise_shield'));
});

test('options never offer raise_shield for a hostile out of range', () => {
  const adapter = spawnedAdapter();
  adapter.offhand = { name: 'shield', count: 1 };
  zombie(adapter, 501n, { x: 40, y: 63, z: 0 });
  assert.ok(!adapter.options().map(o => o.key).includes('raise_shield'));
});

test('options offer craft_shield with an iron ingot and 6 planks at a crafting table', () => {
  const adapter = spawnedAdapter();
  adapter.craftingData = {};
  adapter.recipes = new Map([['shield', [{ network_id: 1 }]]]);
  adapter.world.findBlocks = (name) => (name === 'crafting_table' ? [{ name, position: { x: 3, y: 63, z: 0 }, distance: 3 }] : []);
  adapter.inventory = { iron_ingot: 1, oak_planks: 5 };
  assert.ok(!adapter.options().map(o => o.key).includes('craft_shield'), '5 planks are not enough');
  adapter.inventory = { iron_ingot: 1, oak_planks: 4, birch_planks: 2 };
  assert.ok(adapter.options().map(o => o.key).includes('craft_shield'), 'planks of any wood count');
  adapter.inventory = { oak_planks: 6 };
  assert.ok(!adapter.options().map(o => o.key).includes('craft_shield'), 'no iron');
});

// ---- equipaggiamento ----------------------------------------------------------------

test('_equipShield moves the shield onto the offhand slot with two stack requests', async () => {
  const adapter = spawnedAdapter();
  adapter.inventorySlots = [{ network_id: 42, name: 'shield', count: 1, stack_id: 3 }];
  adapter._refreshInventory();
  const result = await adapter._equipShield(50);
  assert.equal(result.ok, true);
  assert.equal(result.equipped, 'shield');
  assert.equal(result.confirmedBy, 'stack_response');
  assert.equal(adapter.inventorySlots[0], undefined, 'source slot emptied by the take');
  assert.equal(adapter.offhand.name, 'shield');
  assert.equal(adapter.stackRequests.length, 2);
  const [take, place] = adapter.stackRequests;
  assert.equal(take[0].type_id, 'take');
  assert.equal(take[0].source.slot_type.container_id, 'hotbar');
  assert.equal(take[0].destination.slot_type.container_id, 'cursor');
  assert.equal(place[0].type_id, 'place');
  assert.equal(place[0].source.slot_type.container_id, 'cursor');
  assert.equal(place[0].destination.slot_type.container_id, 'offhand');
  assert.equal(place[0].destination.slot, 0);
});

test('_equipShield reports the server-side offhand confirmation when mob_equipment arrives', async () => {
  const adapter = spawnedAdapter({ confirmOffhand: true });
  adapter.inventorySlots = [{ network_id: 42, name: 'shield', count: 1, stack_id: 3 }];
  adapter._refreshInventory();
  const result = await adapter._equipShield(500);
  assert.equal(result.ok, true);
  assert.equal(result.confirmedBy, 'mob_equipment');
});

test('_equipShield fails fast and typed without a shield, on a failed take and on a failed place', async () => {
  const bare = spawnedAdapter();
  assert.equal((await bare._equipShield(10)).error, 'missing_shield');
  assert.equal(bare.stackRequests.length, 0, 'no packets without a shield');

  const failingTake = spawnedAdapter({ stackStatus: 'error' });
  failingTake.inventorySlots = [{ network_id: 42, name: 'shield', count: 1, stack_id: 3 }];
  failingTake._refreshInventory();
  const takeResult = await failingTake._equipShield(10);
  assert.equal(takeResult.ok, false);
  assert.match(takeResult.error, /^shield_take_failed_/);

  const failingPlace = spawnedAdapter();
  failingPlace.inventorySlots = [{ network_id: 42, name: 'shield', count: 1, stack_id: 3 }];
  failingPlace._refreshInventory();
  let calls = 0;
  const originalSend = failingPlace._sendStackRequest;
  failingPlace._sendStackRequest = async (actions) => {
    calls++;
    if (calls === 2) { failingPlace.stackRequests.push(actions); return { status: 'error', containers: [] }; }
    return originalSend(actions);
  };
  const placeResult = await failingPlace._equipShield(10);
  assert.equal(placeResult.ok, false);
  assert.match(placeResult.error, /^shield_place_failed_/);
  assert.equal(failingPlace.returnedCursor, true, 'the cursor item is given back');
  assert.equal(failingPlace.offhand, null, 'no offhand state claimed');
});

test('_equipShield recovers a dirty cursor: a 50 take, give the cursor back, retry once', async () => {
  const adapter = spawnedAdapter({ failTakes: 1, confirmOffhand: true });
  adapter.inventorySlots = [{ network_id: 42, name: 'shield', count: 1, stack_id: 3 }];
  adapter._refreshInventory();

  const result = await adapter._equipShield(10);
  assert.equal(result.ok, true, 'il secondo take riesce dopo il recupero del cursore');
  assert.equal(result.equipped, 'shield');
  assert.equal(adapter.openedWindows, 1, 'la finestra del giocatore è aperta prima del take');
  assert.equal(adapter.returnedCursor, true, 'il cursore sporco viene rimesso nell\'inventario');
  const takes = adapter.stackRequests.filter((a) => a[0]?.type_id === 'take');
  assert.equal(takes.length, 2, 'un take rifiutato e un ritentativo');
  assert.equal(adapter.offhand?.name, 'shield');
  assert.equal(adapter.inventory.shield ?? 0, 0, "l'inventario non conta più lo scudo");
});

test('_equipShield with a persistently dirty cursor fails typed after a single retry', async () => {
  const adapter = spawnedAdapter({ failTakes: 5 });
  adapter.inventorySlots = [{ network_id: 42, name: 'shield', count: 1, stack_id: 3 }];
  adapter._refreshInventory();

  const result = await adapter._equipShield(10);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'shield_take_failed_50');
  const takes = adapter.stackRequests.filter((a) => a[0]?.type_id === 'take');
  assert.equal(takes.length, 2, 'due take al massimo: nessun retry infinito');
  assert.equal(adapter.offhand, null, 'nessuno stato inventato');
  assert.equal(adapter.inventory.shield, 1, "lo scudo resta nell'inventario");
});

test('_equipArmor usa la stessa primitiva: un take rifiutato non salta l\'armatura', async () => {
  const adapter = spawnedAdapter({ failTakes: 1 });
  adapter.inventorySlots = [{ network_id: 88, name: 'iron_helmet', count: 1, stack_id: 4 }];
  adapter.armor = { helmet: null, chestplate: null, leggings: null, boots: null };
  adapter._refreshInventory();

  const result = await adapter._equipArmor();
  assert.equal(result.ok, true, 'il recupero del cursore vale anche per le armature');
  assert.equal(adapter.armor.helmet, 'iron_helmet');
});

test('_onMobEquipment tracks the offhand and ignores other windows', () => {
  const adapter = spawnedAdapter();
  adapter._onMobEquipment({ selected_slot: 3, window_id: 'inventory', item: { network_id: 42, count: 1 } });
  assert.equal(adapter.selectedHotbar, 3);
  assert.equal(adapter.offhand, null);
  adapter._onMobEquipment({ selected_slot: 3, window_id: 'offhand', item: { network_id: 42, count: 1, name: 'shield' } });
  assert.equal(adapter.offhand.name, 'shield');
  assert.ok(adapter._offhandConfirmedAt > 0);
  adapter._onMobEquipment({ selected_slot: 3, window_id: 'offhand', item: { network_id: 0, count: 0 } });
  assert.equal(adapter.offhand, null, 'empty offhand clears the state');
});

// ---- alzare e abbassare -------------------------------------------------------------

test('_raiseShield sends an auth frame with start_using_item', async () => {
  const adapter = spawnedAdapter();
  adapter.offhand = { name: 'shield', count: 1 };
  adapter.yaw = 90;
  const result = await adapter._raiseShield();
  assert.equal(result.ok, true);
  assert.equal(adapter.shieldUp, true);
  assert.equal(adapter.authFrames.length, 1);
  assert.equal(adapter.authFrames[0].useItem, true);
});

test('_raiseShield faces the threat, fails typed without a shield and is idempotent', async () => {
  const adapter = spawnedAdapter();
  assert.equal((await adapter._raiseShield()).error, 'shield_not_equipped');
  assert.equal(adapter.authFrames.length, 0);
  adapter.offhand = { name: 'shield', count: 1 };
  zombie(adapter);
  const result = await adapter._raiseShield();
  assert.equal(result.target, 'zombie');
  assert.ok(adapter.authFrames[0].pitch > 0, 'looks slightly down at the zombie');
  const again = await adapter._raiseShield();
  assert.equal(again.already, true);
  assert.equal(adapter.authFrames.length, 1, 'no extra frame when already up');
});

test('_lowerShield sends a plain frame and clears the flag', async () => {
  const adapter = spawnedAdapter();
  adapter.offhand = { name: 'shield', count: 1 };
  adapter.shieldUp = true;
  const result = await adapter._lowerShield();
  assert.equal(result.ok, true);
  assert.equal(result.raised, false);
  assert.equal(adapter.shieldUp, false);
  assert.equal(adapter.authFrames.length, 1);
  assert.ok(!adapter.authFrames[0].useItem, 'the frame does not hold start_using_item');
});

// ---- dispatch -----------------------------------------------------------------------

test('the auth frame carries start_using_item and serializes with the live schema', () => {
  const adapter = spawnedAdapter();
  const packets = [];
  adapter.client.write = (name, params) => packets.push({ name, params });
  adapter._sendAuthInput({ useItem: true });
  assert.equal(packets.length, 1);
  assert.equal(packets[0].name, 'player_auth_input');
  assert.ok(packets[0].params.input_data.includes('start_using_item'), 'input flag 53 declared');
  assert.doesNotThrow(() => serializer.createPacketBuffer({ name: packets[0].name, params: packets[0].params }));
  packets.length = 0;
  adapter._sendAuthInput({});
  assert.ok(!packets[0].params.input_data.includes('start_using_item'), 'plain frame stays plain');
});

test('executeAction routes equip_shield, raise_shield and lower_shield', async () => {
  const adapter = spawnedAdapter();
  adapter.inventorySlots = [{ network_id: 42, name: 'shield', count: 1, stack_id: 3 }];
  adapter._refreshInventory();
  const equipped = await adapter.executeAction('equip_shield');
  assert.equal(equipped.ok, true);
  zombie(adapter);
  const raised = await adapter.executeAction('raise_shield');
  assert.equal(raised.ok, true);
  assert.equal(adapter.shieldUp, true);
  const lowered = await adapter.executeAction('lower_shield');
  assert.equal(lowered.ok, true);
  assert.equal(adapter.shieldUp, false);
});
