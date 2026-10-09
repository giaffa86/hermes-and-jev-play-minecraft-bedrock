// L'armatura indossata ha una sola fonte autorevole: la **finestra `armor`**
// (WindowID 120, slot 0..3 = elmo, pettorale, gambali, stivali) che il server
// rispedisce a ogni ingresso e a ogni cambio di pezzo. Il 09/10/2026 il bot
// indossava quattro pezzi da prima della run e `observe().armor` rispondeva
// `null` su tutto: `_onMobEquipment` legge solo la mano selezionata e l'offhand,
// e `_playerSlotIndex` non conosce la finestra 'armor' (gli slot finivano nel
// log e poi scartati). Questi test tengono ferme le tre regole che chiudono il
// buco: la finestra riempie il riflesso, uno slot puo' arrivare *prima* della
// palette (i nomi si risolvono dopo), e uno slot vuoto libera il pezzo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { BedrockAdapter } from '../bedrock-adapter.mjs';
import { perceive } from '../survival/perception.mjs';

const REGISTRY = {
  346: { name: 'iron_helmet' },
  347: { name: 'iron_chestplate' },
  348: { name: 'iron_leggings' },
  349: { name: 'iron_boots' },
};

function armorAdapter ({ logs = [] } = {}) {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.client = new EventEmitter();
  adapter.client.entityId = 7n;
  adapter.client.write = () => {};
  adapter.world = { registry: { items: {} }, summary: () => ({}) };
  adapter.log = (type, data) => logs.push({ type, ...(data || {}) });
  return adapter;
}

test('the server armor window fills the mirror and the protection points', () => {
  const logs = [];
  const adapter = armorAdapter({ logs });
  adapter.world.registry.items = REGISTRY;

  for (const slot of [0, 1, 2, 3]) {
    assert.equal(adapter._applyArmorWindowSlot(slot, { network_id: 346 + slot, count: 1, stack_id: 690 + slot }), true);
  }

  assert.deepEqual(adapter.armor, { helmet: 'iron_helmet', chestplate: 'iron_chestplate', leggings: 'iron_leggings', boots: 'iron_boots' });
  assert.equal(adapter._armorPoints(), 15); // ferro: 2 + 6 + 5 + 2
  assert.deepEqual(adapter._wornArmor(), ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']);
  assert.equal(logs.filter(l => l.type === 'armor_slot').length, 4);
  assert.equal(logs.at(-1).worn, 'iron_helmet iron_chestplate iron_leggings iron_boots');
});

test('a window that arrives before the item palette is named later, not frozen as null', () => {
  const adapter = armorAdapter();

  // Ordine reale del BDS: gli slot della finestra arrivano prima di `start_game`.
  adapter._applyArmorWindowSlot(0, { network_id: 346, count: 1, stack_id: 690 });
  assert.equal(adapter.armor.helmet, null, 'senza palette il nome non c\'è ancora');

  // La palette arriva (start_game/item_registry): il nome si risolve senza
  // aspettare un altro pacchetto della finestra.
  adapter.world.registry.items = REGISTRY;
  adapter._refreshArmorMirror();
  assert.equal(adapter.armor.helmet, 'iron_helmet');
});

test('an emptied armor slot frees the piece instead of keeping it worn', () => {
  const adapter = armorAdapter({});
  adapter.world.registry.items = REGISTRY;
  adapter._applyArmorWindowSlot(0, { network_id: 346, count: 1, stack_id: 1 });
  adapter._applyArmorWindowSlot(1, { network_id: 347, count: 1, stack_id: 2 });
  assert.equal(adapter._armorPoints(), 8);

  adapter._applyArmorWindowSlot(0, { network_id: 0, count: 0 });
  assert.equal(adapter.armor.helmet, null);
  assert.equal(adapter._armorPoints(), 6);
  assert.equal(adapter._wornArmor().join(' '), 'iron_chestplate');
});

test('only the four armor slots are accepted (the window\'s extra slot is not a piece)', () => {
  const adapter = armorAdapter({});
  adapter.world.registry.items = REGISTRY;
  assert.equal(adapter._applyArmorWindowSlot(4, { network_id: 387, count: 1 }), false);
  assert.equal(adapter._applyArmorWindowSlot(-1, { network_id: 346, count: 1 }), false);
  assert.deepEqual(adapter.armor, { helmet: null, chestplate: null, leggings: null, boots: null });
});

test('the inventory_slot handler reads the armor window before the player-slot mapping', () => {
  // La trappola verificata dal vivo: `_playerSlotIndex` non conosce la finestra
  // 'armor' e la scarterebbe, quindi il ramo deve venire prima. Si cerca la
  // *chiamata*: il commento sopra il ramo nomina `_playerSlotIndex` prima di lui.
  const source = readFileSync(new URL('../bedrock-adapter.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("client.on('inventory_slot'");
  assert.ok(start > 0, 'il gestore inventory_slot esiste');
  const body = source.slice(start, source.indexOf("client.on('mob_equipment'", start));
  const armorBranch = body.indexOf('_applyArmorWindowSlot');
  const playerMapping = body.indexOf('const index = this._playerSlotIndex(');
  assert.ok(armorBranch > 0, 'il gestore legge la finestra armor');
  assert.ok(playerMapping > 0, 'il gestore mappa le slot del giocatore');
  assert.ok(armorBranch < playerMapping, 'il ramo armor precede _playerSlotIndex');
});

// La durabilità dei pezzi indossati non esisteva: `_applyArmorWindowSlot` teneva
// solo `{name, network_id, count, stack_id}` e buttava via `metadata`/`extra`,
// dove sta l'NBT Damage che `_itemDamage()` legge. Il massimo arriva dal registro
// (per *nome*, quindi affidabile anche quando gli id inclusi non lo sono).
test('a worn piece carries its durability, and an unknown maximum is not a false zero', () => {
  const adapter = armorAdapter({});
  adapter.world.registry.items = { ...REGISTRY, 346: { name: 'iron_helmet', maxDurability: 165 } };

  adapter._applyArmorWindowSlot(0, { network_id: 346, count: 1, stack_id: 690, extra: { nbt: { nbt: { value: { Damage: { value: 160 } } } } } });
  const [helmet] = adapter._armorSlots();
  assert.equal(helmet.damage, 160);
  assert.equal(helmet.max, 165);
  assert.equal(helmet.remaining, 5);
  assert.equal(helmet.low, true, '5/165 è sotto il 10%: va sostituito');

  // Senza `maxDurability` nel registro la durabilità *consumata* resta quella che
  // dice il server (metadata come ripiego), ma non si inventa un massimo.
  adapter._applyArmorWindowSlot(1, { network_id: 999, count: 1, stack_id: 1, metadata: 3 });
  const chest = adapter._armorSlots()[1];
  assert.equal(chest.damage, 3);
  assert.equal(chest.max, null);
  assert.equal(chest.remaining, null);
  assert.equal(chest.low, null);
});

// Un pezzo indossato che la palette non sa (ancora) nominare non è pelle nuda:
// `wornArmorCount` contava i nomi e rispondeva zero, quindi `wear_armor` restava
// impossibile per un bot già vestito.
test('a piece the palette cannot name is still worn, not bare skin', () => {
  const adapter = armorAdapter({});
  adapter.inventory = {};
  adapter._applyArmorWindowSlot(0, { network_id: 12345, count: 1, stack_id: 1 });

  assert.equal(adapter.armor.helmet, null, 'il nome non si sa');
  assert.equal(adapter._armorSlots()[0].network_id, 12345, 'ma il pezzo è tracciato');
  const obs = adapter.observe();
  assert.equal(obs.armor.unresolved, 1);
  const perception = perceive(obs);
  assert.equal(perception.wornArmorCount, 1, 'un pezzo non nominabile è comunque addosso');
  assert.deepEqual(perception.wornArmor, [], 'i nomi restano ignoti');
});

test('without `slots` the count still reads the names (the Java harness shape)', () => {
  assert.equal(perceive({ armor: { helmet: 'iron_helmet', chestplate: null, leggings: null, boots: null } }).wornArmorCount, 1);
  assert.equal(perceive({ armor: { slots: [null, { name: 'iron_boots' }, null, null] } }).wornArmorCount, 1);
  assert.equal(perceive({ armor: { slots: [null, null, null, null], helmet: 'iron_helmet' } }).wornArmorCount, 0, 'gli slot vuoti vincono sui nomi');
});
