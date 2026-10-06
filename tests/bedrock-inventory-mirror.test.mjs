// Lo specchio dell'inventario lato client ha due fonti: `pickups` (stima dai
// `take_item_entity`, perche' BDS con inventario server-authoritative non manda
// un aggiornamento di slot al pickup) e `inventorySlots` (la verita' del server
// negli `inventory_content`). Il 06/10 sulla missione diamanti i due si sono
// sommati due volte: 3 diamanti stantii + 2 raccolti al sito di morte = aggregato
// 5, mentre gli slot ne dichiaravano 2 — e da li' il deposito in loop con
// `take_failed_49`. Questi test tengono ferme le due regole che lo impediscono:
// la morte azzera lo specchio, e uno snapshot del server assorbe la stima.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

function mirrorAdapter ({ logs = null } = {}) {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  if (logs) adapter.log = (type, data) => logs.push({ type, ...data });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.client = new EventEmitter();
  adapter.client.entityId = 7n;
  adapter.client.write = () => {};
  adapter.position = { x: 83.2, y: 75.62, z: 176.4 };
  adapter._feet = { x: 83.2, y: 74, z: 176.4 };
  return adapter;
}

function playerSlots (entries) {
  const slots = Array.from({ length: 36 }, () => null);
  for (const [index, slot] of entries) slots[index] = slot;
  return slots;
}

test('death forgets the inventory the server has just dropped', () => {
  const logs = [];
  const adapter = mirrorAdapter({ logs });
  adapter.pickups = { iron_ingot: 64, diamond: 3 };
  adapter.inventorySlots = [{ network_id: 6, name: 'stone_pickaxe', count: 1, stack_id: 9 }];
  adapter._refreshInventory();
  assert.equal(adapter.inventory.diamond, 3);
  assert.equal(adapter.inventory.stone_pickaxe, 1);

  adapter.health = 0;
  adapter._onOwnHealth();

  assert.equal(adapter.dead, true);
  assert.ok(adapter.deathSite, 'il sito di morte resta per il recupero');
  assert.deepEqual(adapter.pickups, {}, 'la stima non sopravvive alla morte');
  assert.deepEqual(adapter.inventorySlots, [], 'gli slot del morto non sono slot veri');
  assert.deepEqual(adapter.inventory, {}, 'aggregato vuoto come l\'inventario del server');
  const reset = logs.find(l => l.type === 'inventory_mirror_reset');
  assert.ok(reset, 'il reset finisce nel log del run');
  assert.equal(reset.reason, 'death');
  assert.match(reset.forgotten, /diamond:3/);
});

test('a pickup after death counts from zero, not on top of the stale stack', async () => {
  const logs = [];
  const adapter = mirrorAdapter({ logs });
  // Stato pre-morte: 3 diamanti (pickups 3, e lo slot del server che li conferma).
  adapter.pickups = { diamond: 3 };
  adapter.inventorySlots = [{ network_id: 4, name: 'diamond', count: 3, stack_id: 9 }];
  adapter._refreshInventory();
  assert.equal(adapter.inventory.diamond, 6, 'pickups e slot sono due fonti che si sommano');

  adapter.health = 0;
  adapter._onOwnHealth();          // la morte fa cadere i 3 diamanti
  adapter.health = 20;
  adapter._onOwnHealth();          // respawn

  // Al sito di morte ne restano 2 raccoglibili: l'aggregato deve dire 2, non
  // 3 + 2 (duplicazione live) e nemmeno 3 (slot stantii).
  adapter.drops = [{ id: 11, runtime_id: 99, item: 'diamond', count: 2, position: { x: 83.2, y: 74, z: 176.4 } }];
  const taken = adapter._onTakeItemEntity({ runtime_entity_id: 99, target: 7n });

  assert.equal(taken.taken, true);
  assert.equal(adapter.inventory.diamond, 2, 'i 3 diamanti di prima non esistono piu\'');
  assert.equal(adapter.drops.length, 0, 'il drop raccolto esce dalla lista');
  assert.equal(logs.filter(l => l.type === 'inventory_mirror_reset').length, 1, 'un reset per morte');
});

test('a repeated take_item_entity for the same drop does not count twice', () => {
  const adapter = mirrorAdapter();
  adapter.drops = [{ id: 12, runtime_id: 100, item: 'coal', count: 4, position: { x: 1, y: 63, z: 0 } }];
  const first = adapter._onTakeItemEntity({ runtime_entity_id: 100, target: 7n });
  const second = adapter._onTakeItemEntity({ runtime_entity_id: 100, target: 7n });
  assert.equal(first.taken, true);
  assert.equal(second.ok, false, 'il drop non esiste piu\'');
  assert.equal(second.error, 'unknown_drop');
  assert.equal(adapter.inventory.coal, 4);
});

test('a take by another player is not counted as ours', () => {
  const adapter = mirrorAdapter();
  adapter.drops = [{ id: 13, runtime_id: 101, item: 'iron_ingot', count: 8, position: { x: 1, y: 63, z: 0 } }];
  const result = adapter._onTakeItemEntity({ runtime_entity_id: 101, target: 42n });
  assert.equal(result.ok, true);
  assert.equal(result.taken, false);
  assert.equal(adapter.inventory.iron_ingot, undefined);
  assert.equal(adapter.drops.length, 0, 'l\'entita\' e\' sparita comunque');
});

test('a full player-inventory snapshot absorbs the pickup estimate', () => {
  const adapter = mirrorAdapter();
  adapter.pickups = { diamond: 3 };
  adapter._refreshInventory();
  assert.equal(adapter.inventory.diamond, 3);

  const applied = adapter._applyPlayerInventorySnapshot(
    playerSlots([[0, { network_id: 4, name: 'diamond', count: 2, stack_id: 9 }]]),
    { containerId: null },
  );

  assert.equal(applied, true);
  assert.deepEqual(adapter.pickups, {}, 'lo snapshot e\' piu\' fresco della stima');
  assert.equal(adapter.inventory.diamond, 2, 'aggregato 2, non 5');
});

test('an empty player snapshot does not absorb a fresh pickup', () => {
  const adapter = mirrorAdapter();
  adapter.pickups = { oak_log: 1 };
  adapter.inventorySlots = [{ network_id: 17, name: 'oak_log', count: 1, stack_id: 3 }];
  adapter._refreshInventory();

  adapter._applyPlayerInventorySnapshot(playerSlots([]), { containerId: null });

  assert.deepEqual(adapter.pickups, { oak_log: 1 }, 'un sync vuoto non assorbe nulla');
});

test('the crafting grid is never mistaken for the player inventory', () => {
  const adapter = mirrorAdapter();
  adapter.pickups = { oak_planks: 4 };
  adapter._refreshInventory();
  const applied = adapter._applyPlayerInventorySnapshot(
    playerSlots([[0, { network_id: 5, name: 'oak_planks', count: 4, stack_id: 7 }]]),
    { containerId: 'crafting_input' },
  );
  assert.equal(applied, false);
  assert.deepEqual(adapter.pickups, { oak_planks: 4 });
  assert.equal(adapter.inventory.oak_planks, 4);
});

test('a short player-inventory snapshot does not wipe the mirror', () => {
  const logs = [];
  const adapter = mirrorAdapter({ logs });
  adapter.inventorySlots = [{ network_id: 4, name: 'diamond', count: 2, stack_id: 9 }];
  adapter._refreshInventory();
  assert.equal(adapter.inventory.diamond, 2);

  // Live 06/10, dopo una riconnessione: un `inventory_content` senza slot lascio'
  // lo specchio a 0 e ogni `take_*` rispose `take_failed_49`. I cambi di un
  // singolo slot arrivano da `inventory_slot`, quindi un contenuto corto non e'
  // mai uno snapshot completo e non deve sostituire quello che sappiamo.
  const applied = adapter._applyPlayerInventorySnapshot([], { containerId: 'inventory' });
  const partial = adapter._applyPlayerInventorySnapshot(
    [{ network_id: 5, name: 'cobblestone', count: 1, stack_id: 2 }],
    { containerId: 'inventory' },
  );

  assert.equal(applied, false, 'il pacchetto vuoto viene scartato');
  assert.equal(partial, false, 'e cosi\' anche quello parziale: azzererebbe gli altri 35 slot');
  assert.equal(adapter.inventory.diamond, 2, 'lo specchio resta quello che sapevamo');
  const ignored = logs.find(l => l.type === 'inventory_snapshot_ignored');
  assert.ok(ignored, 'lo scarto finisce nel log del run');
  assert.equal(ignored.container, 'inventory');
  assert.equal(ignored.slots, 0);
  assert.equal(ignored.mirror, 1);
});

test('an anvil_input packet neither wipes the mirror nor counts as inventory', () => {
  const adapter = mirrorAdapter();
  adapter.inventorySlots = [{ network_id: 4, name: 'diamond', count: 2, stack_id: 9 }];
  adapter._refreshInventory();

  // Un container diverso dal giocatore non e' l'inventario: ne' il pacchetto
  // vuoto ne' quello a 36 slot nulli possono cancellare cio' che sappiamo.
  assert.equal(adapter._applyPlayerInventorySnapshot([], { containerId: 'anvil_input' }), false);
  assert.equal(adapter._applyPlayerInventorySnapshot(playerSlots([]), { containerId: 'anvil_input' }), false);
  assert.equal(adapter.inventory.diamond, 2);
  assert.equal(adapter.inventorySlots.length, 1, 'lo specchio non e\' stato toccato');
});
