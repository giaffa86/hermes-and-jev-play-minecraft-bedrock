import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';
import { bestFood, STARVING_FOOD } from '../bedrock-survival.mjs';
import { perceive } from '../survival/perception.mjs';

// Regola dei materiali (utente, 05/10/2026): per costruire qualcosa il bot
// guarda prima cosa ha addosso, poi i bauli vicini, e solo alla fine raccoglie
// in natura — mai smontando una costruzione come una casa.
//
// L'obiettivo vive in `plan.targets` ({"wooden_pickaxe": 1}): da lì l'harness
// ricava la ricetta, cosa manca e *dove* si può prendere, ed espone il passo
// scelto in `observe().craft.next` (che il controller esegue senza interpellare
// il modello). Le opzioni servono solo a dichiarare il passo e a garantire che
// esista davvero: un passo che non può riuscire non viene inventato.

const PLANK = { type: 'valid', descriptor_type: 'item_tag', tag: 'planks' };
const STICK = { type: 'valid', descriptor_type: 'name', name: 'stick' };
const LOG = { type: 'valid', descriptor_type: 'item_tag', tag: 'logs' };

const RECIPE_BODIES = [
  { network_id: 101, width: 3, height: 3, input: [PLANK, PLANK, PLANK, STICK, STICK], output: [{ network_id: 900 }] },
  { network_id: 102, width: 2, height: 2, input: [LOG], output: [{ network_id: 901 }] },
  { network_id: 103, width: 2, height: 2, input: [PLANK, PLANK], output: [{ network_id: 902 }] },
];

function craftAdapter ({ inventory = {}, chests = [], targets = { wooden_pickaxe: 1 }, food = 20 } = {}) {
  const events = [];
  const adapter = new BedrockAdapter({ logger: { log () {} }, onLog: entry => events.push(entry) });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.client = { queue () {} };
  adapter.inventory = { ...inventory };
  adapter.inventorySlots = Object.entries(inventory)
    .map(([name, count], index) => ({ network_id: index + 1, name, count, stack_id: index + 1 }));
  adapter.nearbyBlocks = {};
  adapter.position = { x: 0.5, y: 72.62, z: 0.5 };
  adapter._feet = { x: 0.5, y: 71, z: 0.5 };
  adapter.health = 20;
  adapter.food = food;
  adapter.world = { findBlocks: () => [{ position: { x: 0, y: 72, z: 0 } }], blockAt: () => null, summary: () => ({}), registry: { items: {} } };
  adapter.recipes = new Map([
    ['wooden_pickaxe', [{ network_id: 101 }]],
    ['oak_planks', [{ network_id: 102 }]],
    ['stick', [{ network_id: 103 }]],
  ]);
  adapter.craftingData = { shaped_recipes: RECIPE_BODIES, shapeless_recipes: [] };
  adapter.plan = { ...adapter.plan, objective: 'build a wooden pickaxe', targets: { ...targets } };
  let index = 0;
  adapter.containers = new Map(chests.map(chest => [`c${index}`, {
    type: chest.type ?? 'chest',
    position: chest.position ?? { x: 5 + (index++), y: 72, z: 5 },
    readAt: Date.now(),
    contents: { ...chest.contents },
  }]));
  return { adapter, events };
}

const keys = adapter => adapter.options().map(o => o.key);
const option = (adapter, key) => adapter.options().find(o => o.key === key);

test('un ingrediente mancante si prende dal baulo, non si raccoglie', () => {
  const { adapter } = craftAdapter({ chests: [{ contents: { oak_planks: 4, stick: 2 } }] });
  const craft = adapter._craftNeeds({ offerKeys: keys(adapter) });
  assert.equal(craft.rule, 'inventory_first_then_chests_never_buildings');
  assert.deepEqual(craft.targets, [{ item: 'wooden_pickaxe', need: 1, have: 0 }]);
  const planks = craft.needs[0].missing.find(m => m.ingredient === '#planks');
  assert.equal(planks.need, 3);
  assert.equal(planks.have, 0);
  assert.equal(planks.short, 3);
  assert.equal(planks.sources[0].item, 'oak_planks');
  assert.equal(craft.next.key, 'take_oak_planks');
  assert.equal(craft.next.source, 'chest');
  assert.equal(craft.next.target, 'wooden_pickaxe');
  assert.equal(craft.next.chest.type, 'chest');
  const take = option(adapter, 'take_oak_planks');
  assert.ok(take, 'il prelievo dal baulo è offerto');
  assert.match(take.description, /inventory first, then the chests/);
  assert.match(take.description, /nothing is taken from buildings/);
});

test("l'inventario viene prima dei bauli", () => {
  const { adapter } = craftAdapter({ inventory: { oak_log: 2 }, chests: [{ contents: { oak_planks: 4, stick: 2 } }] });
  const craft = adapter._craftNeeds({ offerKeys: keys(adapter) });
  assert.equal(craft.next.key, 'craft_oak_planks');
  assert.equal(craft.next.source, 'inventory');
  assert.equal(craft.next.reason, 'craft_from_inventory');
  assert.match(option(adapter, 'craft_oak_planks').description, /inventory first/);
});

test('i materiali del craft passano davanti al tetto di 8 prelievi', () => {
  const clutter = {};
  for (let i = 0; i < 12; i++) clutter[`junk_${i}`] = 1;
  const { adapter } = craftAdapter({ chests: [{ contents: { oak_planks: 4, stick: 2 } }, { contents: clutter }] });
  const offered = keys(adapter);
  assert.ok(offered.includes('take_oak_planks'), 'il materiale del craft non viene tagliato fuori');
  assert.ok(offered.includes('take_stick'), 'vale per ogni ingrediente della ricetta');
});

test('senza inventario né bauli il passo è la raccolta in natura', () => {
  const { adapter } = craftAdapter({});
  assert.equal(adapter._craftNeeds({ offerKeys: ['mine_oak_log', 'wait'] }).next.key, 'mine_oak_log');
  assert.equal(adapter._craftNeeds({ offerKeys: ['mine_oak_log'] }).next.source, 'gather');
  assert.equal(adapter._craftNeeds({ offerKeys: ['mine_dirt'] }).next, null, 'un passo che non può riuscire non viene inventato');
  assert.equal(adapter._craftNeeds().next, null, 'osservando senza opzioni non si promette una raccolta');
});

test('una costruzione non è mai una sorgente naturale', () => {
  const { adapter } = craftAdapter({});
  assert.equal(adapter._gatherStepFor(PLANK, new Set(['mine_oak_planks', 'mine_crafting_table', 'mine_chest'])), null);
  assert.equal(adapter._gatherStepFor(PLANK, new Set(['mine_oak_log'])).key, 'mine_oak_log');
});

test('con tutti i materiali addosso si costruisce subito', () => {
  const { adapter } = craftAdapter({ inventory: { oak_planks: 3, stick: 2 } });
  const craft = adapter._craftNeeds({ offerKeys: keys(adapter) });
  assert.deepEqual(craft.needs[0].missing, []);
  assert.equal(craft.next.key, 'craft_wooden_pickaxe');
  assert.equal(craft.next.reason, 'craft_target_ready');
  assert.match(option(adapter, 'craft_wooden_pickaxe').description, /every material is already in the inventory/);
});

test('obiettivo già soddisfatto: nessun bisogno di materiali', () => {
  const { adapter } = craftAdapter({ inventory: { wooden_pickaxe: 1 } });
  assert.equal(adapter._craftNeeds(), null);
});

test('observe() espone la regola dei materiali', () => {
  const { adapter } = craftAdapter({ chests: [{ contents: { oak_planks: 4 } }] });
  const craft = adapter.observe().craft;
  assert.equal(craft.rule, 'inventory_first_then_chests_never_buildings');
  assert.equal(craft.next.key, 'take_oak_planks');
});

test('le uova non sono cibo; la patata cruda solo con la fame critica', () => {
  assert.equal(bestFood({ egg: 34 }), null);
  assert.equal(bestFood({ egg: 34 }, { allowLastResort: true }), null, 'le uova restano un ingrediente, mai un pasto');
  assert.equal(bestFood({ potato: 4 }), null);
  assert.equal(bestFood({ potato: 4 }, { allowLastResort: true }), 'potato');
  assert.equal(bestFood({ potato: 4, bread: 1 }, { allowLastResort: true }), 'bread', 'il cibo vero resta preferito');
  assert.equal(STARVING_FOOD, 4);
});

test('con la fame critica il governor vede il cibo di ultima istanza', () => {
  const starving = perceive({ inventory: { potato: 4 }, food: 3, health: 20, spawned: true });
  assert.equal(starving.hasFood, true);
  assert.equal(starving.bestFood, 'potato');
  const fed = perceive({ inventory: { potato: 4 }, food: 12, health: 20, spawned: true });
  assert.equal(fed.hasFood, false, 'senza fame critica una patata cruda non è un pasto');
});

test("l'opzione eat compare con la fame critica e una sola patata cruda", () => {
  assert.ok(keys(craftAdapter({ inventory: { potato: 4 }, food: 3, targets: {} }).adapter).includes('eat'));
  assert.ok(!keys(craftAdapter({ inventory: { potato: 4 }, food: 20, targets: {} }).adapter).includes('eat'),
    'sazio non mangia una patata cruda');
});
