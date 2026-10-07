// `recover_loot` non finisce più col bot nudo: dopo aver raccolto i drop rimette
// addosso l'armatura e lo scudo che il loot ha restituito, e lo scudo va
// **sempre** nell'offhand (la mano sinistra, container `offhand`, slot 1).
// Contesto di campo: il 06/10/2026 il run 2 (`demo-r2`) è morto 10 volte e
// armatura e scudo raccolti sono rimasti in zaino — `_recoverLoot()` non
// chiamava né `_equipArmor()` né `_equipShield()`, e i run 2 e 3 hanno zero
// tentativi `equip_*` nel ledger.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BedrockAdapter } from '../bedrock-adapter.mjs';
import { optionIntents } from '../survival/intents.mjs';

const CURSOR_STACK = 501;

// Fixture: un adapter spawnato sul sito di morte (nessuna camminata), con un
// drop da raccogliere, l'armatura finta e lo scudo vero (`_equipShield` reale,
// così il place nell'offhand è quello che manda il pacchetto).
function lootAdapter ({ armorResult = { ok: true, equipped: [{ item: 'golden_leggings', slot: 2 }] }, logs = [] } = {}) {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.client = new EventEmitter();
  adapter.client.entityId = 7n;
  adapter.client.write = () => {};
  adapter.position = { x: 0.5, y: 63.62, z: 0.5 };
  adapter._feet = { x: 0.5, y: 63, z: 0.5 };
  adapter.nearbyBlocks = {};
  adapter.drops = [];
  adapter.deathSite = { position: { x: 0, y: 63, z: 0 }, at: 1791304207658 };
  adapter.armor = { helmet: null, chestplate: null, leggings: null, boots: null };
  adapter.offhand = null;
  adapter.inventorySlots = [];
  adapter.inventory = {};
  adapter.stackRequests = [];
  adapter.equipCalls = [];
  adapter.log = (type, data) => logs.push({ type, ...(data || {}) });
  adapter.world.findBlocks = () => [];
  adapter.world.blockAt = () => ({ name: 'air' });
  adapter._moveTo = async () => ({ ok: true });
  adapter._queueAuthInput = async () => {};
  adapter._selectHotbarSlot = () => true;
  adapter._resyncByReconnect = async () => { throw new Error('no_reconnect'); };
  adapter._deathVerdict = () => ({ inLava: false, recoverable: true, reason: null, nearest: null });
  let dropsLeft = 1;
  adapter._nearestDropNear = () => (dropsLeft > 0 ? { item: 'golden_leggings', position: { x: 0, y: 63, z: 0 }, count: 1 } : null);
  adapter._collectDrop = async () => {
    if (dropsLeft <= 0) return { ok: false, error: 'no_drop' };
    dropsLeft--;
    return { ok: true, item: 'golden_leggings' };
  };
  adapter._equipArmor = async () => {
    adapter.equipCalls.push('equip_armor');
    if (armorResult.ok) adapter.armor.leggings = 'golden_leggings';
    return armorResult;
  };
  adapter._refreshInventory = () => {
    const counts = {};
    for (const slot of adapter.inventorySlots) {
      if (!slot?.count) continue;
      counts[slot.name] = (counts[slot.name] || 0) + slot.count;
    }
    adapter.inventory = counts;
    return counts;
  };
  adapter._ensureInventoryOpen = async () => {};
  adapter._invSlotAsSource = (index) => (index < 9 ? { container: 'hotbar', slot: index } : { container: 'hotbar_and_inventory', slot: index });
  adapter._slotInfo = (container, slot, stack = 0) => ({ slot_type: { container_id: container }, slot, stack_id: stack });
  adapter._returnCursorToInventory = async () => { adapter.returnedCursor = true; };
  adapter._sendStackRequest = async (actions) => {
    adapter.stackRequests.push(actions);
    const action = actions[0];
    if (action.type_id === 'take') {
      const source = action.source.slot_type.container_id;
      adapter.inventorySlots[action.source.slot] = undefined;
      return {
        status: 'ok',
        containers: [
          { slot_type: { container_id: source }, slots: [{ slot: action.source.slot, count: 0, item_stack_id: 0 }] },
          { slot_type: { container_id: 'cursor' }, slots: [{ slot: 0, count: 1, item_stack_id: CURSOR_STACK }] },
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
  return adapter;
}

test('recover_loot rimette addosso armatura e scudo, e lo scudo finisce nell\'offhand', async () => {
  const logs = [];
  const adapter = lootAdapter({ logs });
  // Lo scudo raccolto dal loot è nello zaino (slot 3):
  adapter.inventorySlots[3] = { network_id: 42, name: 'shield', count: 1, stack_id: 9 };
  adapter._refreshInventory();
  assert.equal(adapter.inventory.shield, 1, 'scudo in zaino: il recupero deve rimetterlo addosso');

  const result = await adapter._recoverLoot({ collectRounds: 1 });

  assert.equal(result.ok, true);
  assert.deepEqual(result.recovered, ['golden_leggings']);
  assert.deepEqual(adapter.equipCalls, ['equip_armor'], 'armatura prima');
  assert.deepEqual(result.rearm, { ok: true, armor: [{ item: 'golden_leggings', slot: 2 }], shield: 'offhand', failures: [] });
  assert.equal(adapter.armor.leggings, 'golden_leggings', 'il pezzo è indossato davvero');
  assert.equal(adapter.offhand?.name, 'shield', 'lo scudo è indossato, non in zaino');

  const places = adapter.stackRequests.filter(actions => actions[0].type_id === 'place');
  assert.equal(places.length, 1, 'un solo place, nessun ripiego inutile');
  assert.equal(places[0][0].destination.slot_type.container_id, 'offhand', 'lo scudo vive solo nell\'offhand');
  assert.equal(places[0][0].destination.slot, 1, 'OFFHAND_SLOT = 1: con 0 il server risponde 50');

  const rearmLog = logs.filter(entry => entry.type === 'recover_loot_rearm');
  assert.equal(rearmLog.length, 1);
  assert.equal(rearmLog[0].shield, 'offhand');
  const lootLog = logs.find(entry => entry.type === 'recover_loot');
  assert.equal(lootLog.rearm.shield, 'offhand', 'anche il log del recupero porta il riarmo');
});

test('un riarmo che fallisce non fa fallire il recupero del loot', async () => {
  const logs = [];
  const adapter = lootAdapter({
    armorResult: { ok: false, error: 'armor_place_failed_50', carried: 'golden_leggings' },
    logs,
  });

  const result = await adapter._recoverLoot({ collectRounds: 1 });

  assert.equal(result.ok, true, 'il loot è recuperato: il riarmo è best effort');
  assert.deepEqual(result.recovered, ['golden_leggings']);
  assert.equal(result.rearm.ok, false, 'niente è entrato, ma solo il riarmo fallisce');
  assert.equal(result.rearm.error, 'rearm_failed');
  assert.deepEqual(result.rearm.armor, []);
  assert.deepEqual(result.rearm.failures, [{ stage: 'armor', error: 'armor_place_failed_50', carried: 'golden_leggings' }]);
  assert.equal(adapter.armor.leggings, null, 'nessun pezzo indossato inventato');
  assert.equal(logs.filter(entry => entry.type === 'recover_loot_rearm').length, 1);
});

test('senza niente da indossare il riarmo non invia richieste e non logga', async () => {
  const logs = [];
  const adapter = lootAdapter({ armorResult: { ok: false, error: 'no_armor_in_inventory' }, logs });

  const result = await adapter._recoverLoot({ collectRounds: 1 });

  assert.equal(result.ok, true);
  assert.deepEqual(result.rearm, { ok: true, armor: [], shield: null, failures: [] }, '`no_armor_in_inventory` non è un fallimento');
  assert.equal(logs.filter(entry => entry.type === 'recover_loot_rearm').length, 0);
  assert.equal(adapter.stackRequests.length, 0, 'niente da indossare, niente richieste di stack');
});

test('rearm_gear è offerto solo con un pezzo in zaino o uno scudo fuori dall\'offhand', () => {
  const adapter = lootAdapter();
  const keys = () => adapter.options().map(option => option.key);
  assert.ok(!keys().includes('rearm_gear'), 'niente in zaino, niente opzione');

  adapter.inventorySlots[3] = { network_id: 42, name: 'golden_leggings', count: 1, stack_id: 3 };
  assert.ok(keys().includes('rearm_gear'), 'gambali in zaino');
  adapter.armor.leggings = 'golden_leggings';
  assert.ok(!keys().includes('rearm_gear'), 'già indossati');

  adapter.inventorySlots[4] = { network_id: 43, name: 'shield', count: 1, stack_id: 4 };
  adapter._refreshInventory();
  assert.ok(keys().includes('rearm_gear'), 'scudo in zaino');
  adapter.offhand = { name: 'shield', count: 1 };
  assert.ok(!keys().includes('rearm_gear'), 'scudo già nell\'offhand');
});

test('rearm_gear ha un intento dichiarato e il dispatch lo instrada', async () => {
  assert.deepEqual(optionIntents('rearm_gear'), ['heal', 'shelter'],
    'senza la voce sarebbe `unknown` e il filtro di emergenza la toglierebbe');

  const adapter = lootAdapter();
  const result = await adapter.executeAction('rearm_gear');
  assert.equal(result.ok, true);
  assert.deepEqual(adapter.equipCalls, ['equip_armor']);
});
