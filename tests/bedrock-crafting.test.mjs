import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

// Ricette fittizie con la stessa forma di crafting_data.
const shaped = (networkId, recipeId, width, height, input, output) => ({
  network_id: networkId, recipe_id: recipeId, width, height,
  input: input.map(entry => entry ? { type: 'valid', ...entry } : { type: 'invalid', metadata: 32767, count: 0 }),
  output: [{ network_id: output.networkId, count: output.count, metadata: 0, block_runtime_id: 1 }],
});
const name = n => ({ type: 'valid', descriptor_type: 'name', name: `minecraft:${n}`, metadata: 32767, count: 1 });
const tag = t => ({ type: 'valid', descriptor_type: 'item_tag', tag: `minecraft:${t}`, metadata: 32767, count: 1 });

function craftAdapter () {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.craftingData = {
    shaped_recipes: [
      shaped(715, 'minecraft:oak_planks', 1, 1, [name('oak_log')], { networkId: 5, count: 4 }),
      shaped(1581, 'minecraft:stick', 1, 2, [tag('planks'), tag('planks')], { networkId: 323, count: 4 }),
      shaped(1218, 'minecraft:WorkBench_recipeId', 2, 2, [tag('planks'), tag('planks'), tag('planks'), tag('planks')], { networkId: 58, count: 1 }),
      shaped(1729, 'minecraft:wooden_pickaxe', 3, 3, [tag('planks'), tag('planks'), tag('planks'), null, name('stick'), null, null, name('stick'), null], { networkId: 312, count: 1 }),
    ],
    shapeless_recipes: [],
  };
  adapter.recipes = new Map([
    ['oak_planks', [{ kind: 'shaped', network_id: 715 }]],
    ['stick', [{ kind: 'shaped', network_id: 1581 }]],
    ['crafting_table', [{ kind: 'shaped', network_id: 1218 }]],
    ['wooden_pickaxe', [{ kind: 'shaped', network_id: 1729 }]],
  ]);
  adapter.world.registry = { items: { 5: { name: 'oak_planks' }, 323: { name: 'stick' }, 58: { name: 'crafting_table' }, 312: { name: 'wooden_pickaxe' } } };
  return adapter;
}

const recipe = (adapter, id) => adapter.craftingData.shaped_recipes.find(r => r.network_id === id);

test('crafting grid slots follow the Bedrock inventory and table layouts', () => {
  const adapter = craftAdapter();
  assert.equal(adapter._gridSlotFor(recipe(adapter, 715), 0, false), 30);
  assert.equal(adapter._gridSlotFor(recipe(adapter, 1581), 0, false), 30);
  assert.equal(adapter._gridSlotFor(recipe(adapter, 1581), 1, false), 28);
  assert.deepEqual(
    [0, 1, 2, 3].map(i => adapter._gridSlotFor(recipe(adapter, 1218), i, false)),
    [30, 31, 28, 29],
  );
  assert.deepEqual(
    [0, 1, 2, 4, 7].map(i => adapter._gridSlotFor(recipe(adapter, 1729), i, true)),
    [32, 33, 34, 36, 39],
  );
});

test('ingredient matching understands names and item tags', () => {
  const adapter = craftAdapter();
  assert.equal(adapter._ingredientMatches(name('oak_log'), 'oak_log'), true);
  assert.equal(adapter._ingredientMatches(name('oak_log'), 'birch_log'), false);
  assert.equal(adapter._ingredientMatches(tag('planks'), 'oak_planks'), true);
  assert.equal(adapter._ingredientMatches(tag('planks'), 'oak_log'), false);
  assert.equal(adapter._ingredientMatches(tag('logs'), 'spruce_log'), true);
});

test('material planning is used up across slots and rejects shortages', () => {
  const adapter = craftAdapter();
  adapter.inventorySlots = [
    { network_id: 17, name: 'oak_log', count: 2, stack_id: 1 },
    undefined, undefined, undefined,
    { network_id: 5, name: 'oak_planks', count: 3, stack_id: 2 },
  ];
  assert.equal(adapter._hasMaterials(recipe(adapter, 715)), true);
  assert.equal(adapter._hasMaterials(recipe(adapter, 1581)), true);
  adapter.inventorySlots[0].count = 0;
  assert.equal(adapter._hasMaterials(recipe(adapter, 715)), false);
});

test('output slot prefers merging before using an empty slot', () => {
  const adapter = craftAdapter();
  adapter.inventorySlots = [
    { network_id: 5, name: 'oak_planks', count: 60, stack_id: 10 },
    undefined,
  ];
  assert.equal(adapter._findOutputSlot(5), 0, 'una pila esistente con spazio viene estesa');
  adapter.inventorySlots[0].count = 64;
  assert.equal(adapter._findOutputSlot(5), 1, 'a pila piena si usa uno slot vuoto');
});

test('craft actions consume the tracked grid stacks and validate the destination stack', () => {
  const adapter = craftAdapter();
  adapter.inventorySlots[0] = { network_id: 17, name: 'oak_log', count: 1, stack_id: 1 };
  adapter.inventorySlots[1] = { network_id: 58, name: 'crafting_table', count: 1, stack_id: 77 };
  const gridStackIds = new Map([[30, 55], [31, 56], [28, 57], [29, 58]]);
  const { actions, result } = adapter._craftActions(recipe(adapter, 1218), gridStackIds);
  assert.deepEqual(actions.map(a => a.type_id), ['craft_recipe', 'results_deprecated', 'consume', 'consume', 'consume', 'consume', 'place']);
  assert.deepEqual(result, { network_id: 58, count: 1, metadata: 0, block_runtime_id: 1 });
  const consumes = actions.filter(a => a.type_id === 'consume');
  assert.deepEqual(consumes.map(c => c.source.slot), [30, 31, 28, 29]);
  assert.deepEqual(consumes.map(c => c.source.stack_id), [55, 56, 57, 58]);
  const place = actions.at(-1);
  assert.equal(place.source.slot_type.container_id, 'creative_output');
  assert.equal(place.source.slot, 50);
  // Fusione con la pila esistente: lo stack id del destino deve essere quello corrente.
  assert.deepEqual(place.destination, { slot_type: { container_id: 'hotbar' }, slot: 1, stack_id: 77 });
});

test('craft actions pick an empty slot when the output item is not held yet', () => {
  const adapter = craftAdapter();
  adapter.inventorySlots[0] = { network_id: 17, name: 'oak_log', count: 1, stack_id: 1 };
  const { actions } = adapter._craftActions(recipe(adapter, 1218), new Map());
  const place = actions.at(-1);
  assert.deepEqual(place.destination, { slot_type: { container_id: 'hotbar' }, slot: 1, stack_id: 0 });
});

test('stack responses update the local inventory and clear emptied slots', () => {
  const adapter = craftAdapter();
  adapter.inventorySlots = [{ network_id: 17, name: 'oak_log', count: 2, stack_id: 1 }];
  adapter._applyStackResponse({
    status: 'ok',
    containers: [
      { slot_type: { container_id: 'hotbar' }, slots: [{ slot: 0, count: 0 }] },
      { slot_type: { container_id: 'hotbar' }, slots: [{ slot: 1, count: 4, item_stack_id: 90 }] },
      { slot_type: { container_id: 'inventory' }, slots: [{ slot: 0, count: 1, item_stack_id: 91 }] },
      { slot_type: { container_id: 'cursor' }, slots: [{ slot: 0, count: 2, item_stack_id: 92 }] },
    ],
  }, { networkId: 5 });
  assert.equal(adapter.inventorySlots[0], undefined);
  assert.equal(adapter.inventorySlots[1].count, 4);
  assert.equal(adapter.inventorySlots[1].network_id, 5);
  assert.equal(adapter.inventorySlots[9].count, 1);
  assert.equal(adapter._cursor.count, 2);
  assert.equal(adapter._cursor.stack_id, 92);
});
