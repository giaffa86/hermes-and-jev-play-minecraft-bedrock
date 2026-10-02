import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

// Registry item: raw_iron 457 -> iron_ingot 458, coal 263, oak_planks 5.
function smeltAdapter () {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.position = { x: 0, y: 0, z: 0 };
  adapter._feet = { x: 0, y: 0, z: 0 };
  adapter.world.registry = {
    items: {
      457: { name: 'raw_iron' },
      458: { name: 'iron_ingot' },
      263: { name: 'coal' },
      5: { name: 'oak_planks' },
      42: { name: 'beef' },
      459: { name: 'cooked_beef' },
    },
  };
  adapter.furnaceRecipes = [
    { input_id: 457, output: { network_id: 458, count: 1 }, block: 'furnace' },
    { input_id: 42, output: { network_id: 459, count: 1 }, block: 'smoker' },
    { input_id: 999, output: { network_id: 998, count: 1 }, block: 'furnace' },
  ];
  adapter.inventorySlots = [];
  adapter.inventory = {};
  adapter.world.findBlocks = () => [];
  return adapter;
}

test('smelt targets resolve names and skip non-furnace blocks', () => {
  const adapter = smeltAdapter();
  const targets = adapter._smeltTargets();
  assert.ok(targets.some(t => t.input === 'raw_iron' && t.output === 'iron_ingot'));
  assert.ok(!targets.some(t => t.input === 'unknown_thing'), 'il blocco smoker è ignorato');
  assert.ok(targets.some(t => t.input === 'sand' && t.output === 'glass'), 'mappa statica');
});

test('fuel picking prefers coal over planks and ignores sticks', () => {
  const adapter = smeltAdapter();
  adapter.inventorySlots[0] = { network_id: 323, name: 'stick', count: 4 };
  adapter.inventorySlots[1] = { network_id: 5, name: 'oak_planks', count: 3 };
  adapter.inventorySlots[2] = { network_id: 263, name: 'coal', count: 1 };
  assert.equal(adapter._pickFuel().name, 'coal');
  adapter.inventorySlots[2] = undefined;
  assert.equal(adapter._pickFuel().name, 'oak_planks');
  adapter.inventorySlots[1] = undefined;
  assert.equal(adapter._pickFuel(), null);
});

test('options offer smelt only with a nearby furnace, input and fuel', () => {
  const adapter = smeltAdapter();
  adapter.drops = [];
  adapter.nearbyBlocks = {};
  adapter.inventorySlots[10] = { network_id: 457, name: 'raw_iron', count: 2, stack_id: 5 };
  adapter.inventorySlots[11] = { network_id: 263, name: 'coal', count: 1, stack_id: 6 };
  adapter.inventory = { raw_iron: 2, coal: 1 };
  adapter.world.findBlocks = name => name === 'furnace' ? [{ position: { x: 1, y: 0, z: 0 }, distance: 1.5 }] : [];
  let keys = adapter.options().map(o => o.key);
  assert.equal(keys.includes('smelt_raw_iron'), true);

  adapter.inventory.coal = 0;
  adapter.inventorySlots[11] = undefined;
  keys = adapter.options().map(o => o.key);
  assert.equal(keys.includes('smelt_raw_iron'), false, 'senza combustibile non si offre');

  adapter.inventory = { furnace: 2 };
  adapter.inventorySlots = [];
  adapter.world.findBlocks = () => [];
  keys = adapter.options().map(o => o.key);
  assert.equal(keys.includes('place_furnace'), true, 'fornace in inventario e nessuna vicina');
  adapter.world.findBlocks = name => name === 'furnace' ? [{ position: { x: 1, y: 0, z: 0 }, distance: 1.5 }] : [];
  keys = adapter.options().map(o => o.key);
  assert.equal(keys.includes('place_furnace'), false, 'fornace già vicina');
});

test('furnace slot tracking maps container updates', () => {
  const adapter = smeltAdapter();
  assert.equal(adapter._trackFurnaceSlot('furnace_ingredient', { network_id: 457, count: 1 }), true);
  assert.equal(adapter._trackFurnaceSlot('blast_furnace_ingredient', { network_id: 457, count: 2 }), true);
  assert.equal(adapter._trackFurnaceSlot('smoker_ingredient', { network_id: 457, count: 3 }), true);
  assert.equal(adapter._trackFurnaceSlot('furnace_output', null), true);
  assert.equal(adapter._trackFurnaceSlot('inventory', { network_id: 457 }), false);
  assert.equal(adapter._furnaceSlots.ingredient.network_id, 457);
  assert.equal(adapter._furnaceSlots.output, null);
  adapter._trackFurnaceSlots([{ network_id: 457, count: 1 }, { network_id: 263, count: 1 }, { network_id: 458, count: 1 }]);
  assert.equal(adapter._furnaceSlots.ingredient.network_id, 457);
  assert.equal(adapter._furnaceSlots.fuel.network_id, 263);
  assert.equal(adapter._furnaceSlots.output.network_id, 458);
});

test('smelt stations are chosen per recipe: ores blast furnace, food smoker', () => {
  const adapter = smeltAdapter();
  assert.equal(adapter._smeltStationFor('raw_iron'), 'blast_furnace');
  assert.equal(adapter._smeltStationFor('iron_ore'), 'blast_furnace');
  assert.equal(adapter._smeltStationFor('potato'), 'smoker');
  assert.equal(adapter._smeltStationFor('beef'), 'smoker');
  assert.equal(adapter._smeltStationFor('sand'), 'furnace');
  assert.equal(adapter._smeltStationFor('cobblestone'), 'furnace');
});

test('smelt station lookup prefers the right one and falls back to the furnace', () => {
  const adapter = smeltAdapter();
  const stations = {
    furnace: [{ position: { x: 1, y: 0, z: 0 }, distance: 1.5 }],
    blast_furnace: [{ position: { x: 2, y: 0, z: 0 }, distance: 2.5 }],
    smoker: [{ position: { x: 3, y: 0, z: 0 }, distance: 3.5 }],
  };
  adapter.world.findBlocks = name => stations[name] || [];
  assert.equal(adapter._findSmeltingStation('blast_furnace').name, 'blast_furnace');
  assert.equal(adapter._findSmeltingStation('smoker').name, 'smoker');
  assert.equal(adapter._findSmeltingStation('furnace').name, 'furnace');
  stations.blast_furnace = [];
  assert.equal(adapter._findSmeltingStation('blast_furnace').name, 'furnace', 'fallback base');
  stations.smoker = [];
  assert.equal(adapter._findSmeltingStation('smoker').name, 'furnace', 'fallback base');
});

test('smelting places input and fuel then takes the output', async () => {
  const adapter = smeltAdapter();
  adapter.inventorySlots[10] = { network_id: 457, name: 'raw_iron', count: 2, stack_id: 5 };
  adapter.inventorySlots[11] = { network_id: 263, name: 'coal', count: 1, stack_id: 6 };
  adapter.inventory = { raw_iron: 2, coal: 1 };
  adapter.client = { write: () => {} };
  adapter.world.findBlocks = name => name === 'furnace' ? [{ position: { x: 1, y: 0, z: 0 }, distance: 1.5 }] : [];
  adapter._ensureFurnaceOpen = async () => { adapter._openContainer = { id: 1, type: 'furnace' }; };
  adapter._returnCursorToInventory = async () => true;
  const requests = [];
  adapter._sendStackRequest = async actions => {
    const a = actions[0];
    requests.push(`${a.type_id}:${a.source.slot_type.container_id}->${a.destination.slot_type.container_id}`);
    if (a.type_id === 'take' && a.source.slot_type.container_id === 'furnace_output') {
      return { status: 'ok', containers: [
        { slot_type: { container_id: 'cursor' }, slots: [{ slot: 0, count: 1, item_stack_id: 77 }] },
        { slot_type: { container_id: 'furnace_output' }, slots: [{ slot: 0, count: 0, item_stack_id: 0 }] },
      ] };
    }
    if (a.type_id === 'take') {
      return { status: 'ok', containers: [{ slot_type: { container_id: 'cursor' }, slots: [{ slot: 0, count: 1, item_stack_id: 70 }] }] };
    }
    if (a.destination.slot_type.container_id === 'furnace_ingredient') {
      return { status: 'ok', containers: [{ slot_type: { container_id: 'furnace_ingredient' }, slots: [{ slot: 0, count: 1, item_stack_id: 71 }] }] };
    }
    if (a.destination.slot_type.container_id === 'furnace_fuel') {
      adapter._furnaceSlots.output = { network_id: 458, count: 1, stack_id: 72 };
      return { status: 'ok', containers: [{ slot_type: { container_id: 'furnace_fuel' }, slots: [{ slot: 0, count: 1, item_stack_id: 72 }] }] };
    }
    return { status: 'ok', containers: [] };
  };
  const result = await adapter._smeltItem('raw_iron');
  assert.deepEqual(
    { ok: result.ok, smelted: result.smelted, output: result.output, count: result.count },
    { ok: true, smelted: 'raw_iron', output: 'iron_ingot', count: 1 },
  );
  assert.deepEqual(requests, [
    'take:hotbar_and_inventory->cursor',
    'place:cursor->furnace_ingredient',
    'take:hotbar_and_inventory->cursor',
    'place:cursor->furnace_fuel',
    'take:furnace_output->cursor',
  ]);
  assert.equal(adapter._furnaceSlots.output, null, 'dopo il ritiro l\'output locale è vuoto');
});

test('smelting without a recipe or fuel fails cleanly', async () => {
  const adapter = smeltAdapter();
  adapter.inventorySlots[10] = { network_id: 457, name: 'raw_iron', count: 1, stack_id: 5 };
  assert.deepEqual(await adapter._smeltItem('raw_iron'), { ok: false, error: 'no_fuel' });
  adapter.inventorySlots[11] = { network_id: 263, name: 'coal', count: 1 };
  assert.deepEqual(await adapter._smeltItem('diamond'), { ok: false, error: 'smelt_recipe_missing' });
});

test('smelting in a blast furnace uses the blast furnace ingredient container', async () => {
  const adapter = smeltAdapter();
  adapter.inventorySlots[10] = { network_id: 457, name: 'raw_iron', count: 2, stack_id: 5 };
  adapter.inventorySlots[11] = { network_id: 263, name: 'coal', count: 1, stack_id: 6 };
  adapter.client = { write: () => {} };
  adapter.world.findBlocks = name => name === 'blast_furnace' ? [{ position: { x: 1, y: 0, z: 0 }, distance: 1.5 }] : [];
  adapter._ensureFurnaceOpen = async station => { adapter._openStation = station.name; adapter._openContainer = { id: 1, type: 'blast_furnace' }; };
  adapter._returnCursorToInventory = async () => true;
  const containers = [];
  adapter._sendStackRequest = async actions => {
    const a = actions[0];
    if (a.type_id === 'place') containers.push(a.destination.slot_type.container_id);
    if (a.type_id === 'take' && a.source.slot_type.container_id === 'furnace_output') {
      return { status: 'ok', containers: [{ slot_type: { container_id: 'cursor' }, slots: [{ slot: 0, count: 1, item_stack_id: 77 }] }] };
    }
    if (a.type_id === 'take') {
      return { status: 'ok', containers: [{ slot_type: { container_id: 'cursor' }, slots: [{ slot: 0, count: 1, item_stack_id: 70 }] }] };
    }
    if (a.destination.slot_type.container_id === 'blast_furnace_ingredient') {
      return { status: 'ok', containers: [{ slot_type: { container_id: 'blast_furnace_ingredient' }, slots: [{ slot: 0, count: 1, item_stack_id: 71 }] }] };
    }
    if (a.destination.slot_type.container_id === 'furnace_fuel') {
      adapter._furnaceSlots.output = { network_id: 458, count: 1, stack_id: 72 };
      return { status: 'ok', containers: [{ slot_type: { container_id: 'furnace_fuel' }, slots: [{ slot: 0, count: 1, item_stack_id: 72 }] }] };
    }
    return { status: 'ok', containers: [] };
  };
  const result = await adapter._smeltItem('raw_iron');
  assert.equal(result.ok, true);
  assert.equal(result.station, 'blast_furnace');
  assert.equal(adapter._openStation, 'blast_furnace');
  assert.deepEqual(containers, ['blast_furnace_ingredient', 'furnace_fuel']);
});

test('executeAction routes smelt_ and recover_loot to the adapter actions', async () => {
  const adapter = smeltAdapter();
  adapter.client = { write: () => {} };
  adapter.busy = false;
  let smelted = null;
  adapter._smeltItem = async name => { smelted = name; return { ok: true, smelted: name }; };
  assert.equal((await adapter.executeAction('smelt_raw_iron')).ok, true);
  assert.equal(smelted, 'raw_iron');
  adapter.deathSite = { position: { x: 1, y: 2, z: 3 }, at: Date.now(), attempts: 0 };
  adapter._recoverLoot = async () => ({ ok: true, recovered: [] });
  assert.equal((await adapter.executeAction('recover_loot')).ok, true);
});
