// `equip_armor` ha la stessa forma di `equip_shield` (take sul cursore + place
// nella container 'armor'), quindi deve avere le stesse due proprieta':
// un `place` rifiutato e' un errore tipizzato con lo status (`armor_place_failed_<status>`,
// con gli esiti di ogni tentativo) e mai un successo dichiarato; un pezzo che
// l'aggregato dice di avere ma che nessuno slot mostra e' uno specchio stantio
// (si risincronizza una volta), non "nessuna armatura".
// Contesto di campo: il 06/10 il run 1 ha fallito un equip di `golden_leggings`
// con un `armor_place_failed` contato dall'harness ma senza status nel payload.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

const CURSOR_STACK = 501;

function cursorEmpty () {
  return { status: 'ok', containers: [{ slot_type: { container_id: 'cursor' }, slots: [{ slot: 0, count: 0, item_stack_id: 0 }] }] };
}

// Fixture: un adapter spawnato con la finestra del giocatore gia' aperta
// (`_ensureInventoryOpen` finta, come in `spawnedAdapter()` di
// `tests/bedrock-survival.test.mjs`), gli stub di container/resync e un
// `_sendStackRequest` che parla come il BDS: take dal cursore vuoto, take da
// uno slot che svuota lo slot e carica il cursore, place che fallisce per i
// primi `placeFailures` tentativi con status 50.
function armorAdapter ({ placeFailures = 0, takeFailures = 0, resyncSlots = null, logs = [] } = {}) {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.client = new EventEmitter();
  adapter.client.entityId = 7n;
  adapter.client.write = () => {};
  adapter.position = { x: 0, y: 64.62, z: 0 };
  adapter._feet = { x: 0, y: 63, z: 0 };
  adapter.inventorySlots = [];
  adapter.inventory = {};
  adapter.stackRequests = [];
  adapter.events = [];
  adapter.openedWindows = 0;
  adapter.closedContainers = 0;
  adapter.resyncs = 0;
  adapter._openContainer = null;
  adapter.log = (type, data) => logs.push({ type, ...(data || {}) });
  adapter._ensureInventoryOpen = async () => { adapter.openedWindows++; adapter.events.push('open'); };
  adapter._closeContainer = async () => { adapter.closedContainers++; adapter.events.push('close'); adapter._openContainer = null; };
  adapter._resyncByReconnect = async () => {
    adapter.resyncs++;
    adapter.events.push('resync');
    if (resyncSlots) for (const [index, slot] of Object.entries(resyncSlots)) adapter.inventorySlots[index] = { ...slot };
    return { ok: true };
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
  adapter._sendStackRequest = async (actions) => {
    adapter.stackRequests.push(actions);
    const action = actions[0];
    const from = action.source.slot_type.container_id;
    const to = action.destination.slot_type.container_id;
    adapter.events.push(`${action.type_id}:${from}/${action.source.slot}->${to}/${action.destination.slot}`);
    if (action.type_id === 'take') {
      if (from === 'cursor') return cursorEmpty();
      if (takeFailures > 0) { takeFailures--; return { status: 50, containers: [] }; }
      const index = action.source.slot;
      adapter.inventorySlots[index] = undefined;
      return {
        status: 'ok',
        containers: [
          { slot_type: { container_id: 'cursor' }, slots: [{ slot: 0, count: 1, item_stack_id: CURSOR_STACK }] },
          { slot_type: { container_id: 'hotbar_and_inventory' }, slots: [{ slot: index, count: 0, item_stack_id: 0 }] },
        ],
      };
    }
    if (placeFailures > 0) { placeFailures--; return { status: 50, containers: [] }; }
    return cursorEmpty();
  };
  return adapter;
}

test('a refused armor place is typed with the status and never fakes a worn piece', async () => {
  const logs = [];
  const adapter = armorAdapter({ placeFailures: 2, logs });
  adapter.inventorySlots[4] = { network_id: 88, name: 'golden_leggings', count: 1, stack_id: 12 };

  const result = await adapter._equipArmor();

  assert.equal(result.ok, false);
  assert.equal(result.error, 'armor_place_failed_50');
  assert.deepEqual(result.failures, [{
    item: 'golden_leggings',
    slot: 2,
    stage: 'place',
    status: 50,
    attempts: [
      { attempt: 1, destination: 'armor/2', status: 50 },
      { attempt: 2, destination: 'armor/2', status: 50 },
    ],
    openContainer: null,
  }]);
  assert.equal(adapter.armor.leggings, null, 'nessun pezzo indossato inventato');
  const places = adapter.stackRequests.filter(a => a[0].type_id === 'place' && a[0].destination.slot_type.container_id === 'armor');
  assert.equal(places.length, 2, 'un solo ripiego, non un ciclo');
  assert.deepEqual(places.map(a => a[0].source.stack_id), [CURSOR_STACK, CURSOR_STACK],
    'il ripiego riusa il cursore ancora carico');
  const failed = logs.filter(l => l.type === 'armor_place_failed');
  assert.equal(failed.length, 2);
  assert.deepEqual(failed.map(l => [l.status, l.attempt]), [[50, 1], [50, 2]]);
  assert.ok(failed[0].cursor_stack_id != null, 'il log porta la stack id del cursore');
});

test('the place is retried once and a flake does not lose the piece', async () => {
  const logs = [];
  const adapter = armorAdapter({ placeFailures: 1, logs });
  adapter.inventorySlots[4] = { network_id: 88, name: 'iron_leggings', count: 1, stack_id: 12 };

  const result = await adapter._equipArmor();

  assert.equal(result.ok, true);
  assert.deepEqual(result.equipped, [{ item: 'iron_leggings', slot: 2 }]);
  assert.deepEqual(result.failures, []);
  assert.equal(adapter.armor.leggings, 'iron_leggings');
  const places = adapter.stackRequests.filter(a => a[0].type_id === 'place' && a[0].destination.slot_type.container_id === 'armor');
  assert.equal(places.length, 2);
  assert.deepEqual(places.map(a => a[0].source.stack_id), [CURSOR_STACK, CURSOR_STACK]);
  assert.equal(logs.filter(l => l.type === 'armor_place_failed').length, 1, 'solo il primo tentativo e\' un fallimento');
  assert.equal(logs.filter(l => l.type === 'armor_equip').length, 1);
});

test('an aggregate without a slot is a stale mirror: one resync, then the piece is worn', async () => {
  const logs = [];
  const adapter = armorAdapter({ resyncSlots: { 7: { network_id: 42, name: 'golden_leggings', count: 1, stack_id: 3 } }, logs });
  adapter.inventory = { golden_leggings: 1 };

  const result = await adapter._equipArmor();

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(adapter.resyncs, 1);
  assert.equal(adapter.armor.leggings, 'golden_leggings');
  assert.equal(logs.filter(l => l.type === 'armor_resync').length, 1);
});

test('a resync that does not produce the slot says which piece it was carrying', async () => {
  const logs = [];
  const adapter = armorAdapter({ logs });
  adapter.inventory = { golden_leggings: 1 };

  const result = await adapter._equipArmor();

  assert.equal(result.ok, false);
  assert.equal(result.error, 'no_armor_in_inventory');
  assert.equal(result.carried, 'golden_leggings');
  assert.equal(adapter.resyncs, 1, 'una sola risincronizzazione, non un ciclo');
  assert.equal(logs.filter(l => l.type === 'armor_resync').length, 1);
  assert.equal(adapter.stackRequests.length, 0, 'senza slot non si manda nessuna richiesta');
});

test('a take that keeps failing does not skip the next piece', async () => {
  const logs = [];
  const adapter = armorAdapter({ takeFailures: 2, logs });
  adapter.inventorySlots[0] = { network_id: 90, name: 'iron_helmet', count: 1, stack_id: 5 };
  adapter.inventorySlots[5] = { network_id: 91, name: 'iron_chestplate', count: 1, stack_id: 6 };

  const result = await adapter._equipArmor();

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.equipped, [{ item: 'iron_chestplate', slot: 1 }]);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].stage, 'take');
  assert.equal(result.failures[0].item, 'iron_helmet');
  assert.equal(adapter.armor.helmet, null);
  assert.equal(adapter.armor.chestplate, 'iron_chestplate');
  assert.equal(logs.filter(l => l.type === 'armor_take_failed').length, 1);
});

test('equip_armor closes the container an action has open before it touches the armor', async () => {
  const adapter = armorAdapter();
  adapter._openContainer = { type: 'chest', position: { x: 1, y: 64, z: 1 } };
  adapter.inventorySlots[3] = { network_id: 77, name: 'iron_boots', count: 1, stack_id: 2 };

  const result = await adapter._equipArmor();

  assert.equal(result.ok, true);
  assert.equal(adapter.closedContainers, 1, 'la finestra del baule e\' chiusa prima del take');
  assert.deepEqual(adapter.events.slice(0, 3), ['close', 'open', 'take:hotbar/3->cursor/0']);
});

test('no armor in the aggregate and no armor in the slots is not a resync', async () => {
  const adapter = armorAdapter();
  const result = await adapter._equipArmor();
  assert.deepEqual(result, { ok: false, error: 'no_armor_in_inventory' });
  assert.equal(adapter.resyncs, 0);
});

// Il run 1 del 06/10 ha lasciato un `armor_place_failed` con status 50 senza
// modo di sapere *quale* finestra fosse aperta: l'ipotesi (una finestra aperta
// al momento del place) andava dedotta per timestamp dagli eventi
// `container_open`. Il payload la nomina. Nel caso vero la finestra e' quella
// che apre il take stesso (`_takeToCursor` -> `_ensureInventoryOpen`), non
// quella presente all'ingresso dell'azione (che il guard chiude).
test('a refused armor place names the window that was open at the place', async () => {
  const logs = [];
  const adapter = armorAdapter({ placeFailures: 2, logs });
  adapter.inventorySlots[4] = { network_id: 88, name: 'golden_leggings', count: 1, stack_id: 12 };
  adapter._ensureInventoryOpen = async () => { adapter._openContainer = { id: 13, type: 'inventory' }; };

  const result = await adapter._equipArmor();

  assert.equal(result.ok, false);
  assert.equal(result.error, 'armor_place_failed_50');
  assert.deepEqual(result.failures[0].openContainer, { id: 13, type: 'inventory' },
    'il fallimento nomina la finestra aperta al momento del place');
  const failed = logs.filter(l => l.type === 'armor_place_failed');
  assert.equal(failed.length, 2);
  assert.deepEqual(failed.map(l => l.openContainer),
    [{ id: 13, type: 'inventory' }, { id: 13, type: 'inventory' }]);
});

// Lo stesso payload per lo scudo: il suo rifiuto del run 1 era `offhand/0` con
// la finestra del giocatore aperta, e il numero dello slot non e' mai stato
// l'unica spiegazione possibile.
test('a refused shield place names the window that was open at the place', async () => {
  const logs = [];
  const adapter = armorAdapter({ logs });
  adapter.inventory = { shield: 1 };
  adapter.inventorySlots[2] = { network_id: 66, name: 'shield', count: 1, stack_id: 4 };
  adapter._sendStackRequest = async (actions) => {
    const action = actions[0];
    if (action.type_id === 'take') {
      return {
        status: 'ok',
        containers: [
          { slot_type: { container_id: 'cursor' }, slots: [{ slot: 0, count: 1, item_stack_id: CURSOR_STACK }] },
          { slot_type: { container_id: 'hotbar_and_inventory' }, slots: [{ slot: 2, count: 0, item_stack_id: 0 }] },
        ],
      };
    }
    return { status: 50, containers: [] };
  };
  adapter._ensureInventoryOpen = async () => { adapter._openContainer = { id: 2, type: 'inventory' }; };
  adapter._waitOffhandConfirm = async () => ({ confirmedBy: 'none' });

  const result = await adapter._equipShield(10);

  assert.equal(result.ok, false);
  assert.equal(result.error, 'shield_place_failed_50');
  assert.deepEqual(result.openContainer, { id: 2, type: 'inventory' });
  const failed = logs.filter(l => l.type === 'shield_place_failed');
  assert.deepEqual(failed.filter(l => l.mode === 'place').map(l => [l.destination, l.openContainer]),
    [['offhand/1', { id: 2, type: 'inventory' }], ['offhand/0', { id: 2, type: 'inventory' }]]);
  assert.deepEqual(failed.filter(l => l.mode === 'swap').map(l => l.destination), ['offhand/1'],
    'rifiutati entrambi i place, il terzo tentativo e lo swap');
});
