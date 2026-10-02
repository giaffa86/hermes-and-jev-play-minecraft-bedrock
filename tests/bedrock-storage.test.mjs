import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

// Registry item: iron_ingot 458, gold_ingot 425, dirt 3, oak_planks 5.
function storageAdapter () {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.position = { x: 0, y: 64, z: 0 };
  adapter._feet = { x: 0, y: 64, z: 0 };
  adapter.world.registry = {
    items: {
      458: { name: 'iron_ingot' },
      425: { name: 'gold_ingot' },
      3: { name: 'dirt' },
      5: { name: 'oak_planks' },
    },
  };
  adapter.inventorySlots = [];
  adapter.inventory = {};
  adapter.drops = [];
  adapter.nearbyBlocks = {};
  adapter.client = { write: () => {} };
  adapter.world.findBlocks = () => [];
  adapter._closeContainer = async () => { adapter._openContainer = null; adapter._openContainerBlock = null; adapter._openContainerSlots = []; };
  return adapter;
}

function seedContainer (adapter, { x = 2, y = 64, z = 0, type = 'chest', contents = { iron_ingot: 3 } } = {}) {
  adapter.containers.set(`${x},${y},${z}`, { type, position: { x, y, z }, readAt: Date.now(), contents });
  return { type, position: { x, y, z }, contents };
}

test('storage container slot types map chest/barrel/shulker', () => {
  const adapter = storageAdapter();
  assert.equal(adapter._storageContainerSlotType('chest'), 'container');
  assert.equal(adapter._storageContainerSlotType('trapped_chest'), 'container');
  assert.equal(adapter._storageContainerSlotType('barrel'), 'barrel');
  assert.equal(adapter._storageContainerSlotType('shulker_box'), 'shulker');
  assert.equal(adapter._storageContainerSlotType('unknown_block'), 'container');
});

test('valuable items are ingots, ores and gems — not dirt or planks', () => {
  const adapter = storageAdapter();
  assert.equal(adapter._isValuable('iron_ingot'), true);
  assert.equal(adapter._isValuable('gold_ingot'), true);
  assert.equal(adapter._isValuable('raw_iron'), true);
  assert.equal(adapter._isValuable('diamond'), true);
  assert.equal(adapter._isValuable('dirt'), false);
  assert.equal(adapter._isValuable('oak_planks'), false);
});

test('container contents aggregate slot counts by item name', () => {
  const adapter = storageAdapter();
  const slots = [
    { network_id: 458, name: 'iron_ingot', count: 3 },
    { network_id: 425, name: 'gold_ingot', count: 2 },
    { network_id: 458, name: 'iron_ingot', count: 1 },
    undefined,
    { network_id: 0 },
  ];
  assert.deepEqual(adapter._storageContentsFromSlots(slots), { iron_ingot: 4, gold_ingot: 2 });
});

test('cached containers expire after TTL and are sorted by distance', () => {
  const adapter = storageAdapter();
  seedContainer(adapter, { x: 10, z: 0, contents: { iron_ingot: 1 } });
  seedContainer(adapter, { x: 4, z: 0, contents: { gold_ingot: 2 } });
  const old = Date.now() - 6 * 60 * 1000;
  adapter.containers.set('20,64,0', { type: 'barrel', position: { x: 20, y: 64, z: 0 }, readAt: old, contents: { dirt: 1 } });
  const cached = adapter._cachedContainers();
  assert.equal(cached.length, 2, 'il contenitore scaduto è stato eliminato');
  assert.equal(cached[0].position.x, 4, 'il più vicino viene prima');
  assert.ok(cached.every(c => c.key));
});

test('read_container opens nearby chests and caches their contents', async () => {
  const adapter = storageAdapter();
  adapter.world.findBlocks = name => name === 'chest'
    ? [{ name: 'chest', position: { x: 2, y: 64, z: 0 }, distance: 2 }]
    : [];
  const slots = [{ network_id: 458, name: 'iron_ingot', count: 3 }, { network_id: 3, name: 'dirt', count: 12 }];
  adapter._ensureStorageOpen = async () => {
    adapter._openContainer = { id: 1, type: 'container' };
    adapter._openContainerBlock = { name: 'chest', position: { x: 2, y: 64, z: 0 } };
    adapter._openContainerSlots = slots;
  };
  const result = await adapter._readContainers();
  assert.equal(result.ok, true);
  assert.equal(result.read, 1);
  assert.equal(result.containers[0].contents.iron_ingot, 3);
  assert.deepEqual(adapter.containers.get('2,64,0').contents, { iron_ingot: 3, dirt: 12 });
  const obs = adapter.observe();
  assert.equal(obs.containers.length, 1);
  assert.equal(obs.containers[0].type, 'chest');
});

test('read_container without nearby storage blocks fails cleanly', async () => {
  const adapter = storageAdapter();
  adapter.world.findBlocks = () => [];
  assert.deepEqual(await adapter._readContainers(), { ok: false, error: 'container_not_found' });
});

test('take_<item> withdraws from a known container and verifies the delta', async () => {
  const adapter = storageAdapter();
  const entry = seedContainer(adapter);
  const slots = [{ network_id: 458, name: 'iron_ingot', count: 3, stack_id: 5 }];
  adapter._ensureStorageOpen = async () => {
    adapter._openContainer = { id: 1, type: 'container' };
    adapter._openContainerBlock = { name: 'chest', position: entry.position };
    adapter._openContainerSlots = slots;
  };
  const requests = [];
  adapter._sendStackRequest = async actions => {
    const a = actions[0];
    requests.push(`${a.type_id}:${a.source.slot_type.container_id}@${a.source.slot}->${a.destination.slot_type.container_id}`);
    return {
      status: 'ok',
      containers: [
        { slot_type: { container_id: 'cursor' }, slots: [{ slot: 0, count: 3, item_stack_id: 70 }] },
        { slot_type: { container_id: 'container' }, slots: [{ slot: 0, count: 0, item_stack_id: 0 }] },
      ],
    };
  };
  adapter._returnCursorToInventory = async () => {
    const cur = adapter._cursor;
    if (cur?.count > 0) {
      const name = adapter.world.registry.items[cur.network_id]?.name;
      adapter.inventory[name] = (adapter.inventory[name] || 0) + cur.count;
      adapter.inventorySlots[0] = { network_id: cur.network_id, name, count: cur.count, stack_id: 1 };
      adapter._cursor = null;
    }
    return true;
  };
  const result = await adapter._takeFromContainer('iron_ingot');
  assert.equal(result.ok, true);
  assert.equal(result.count, 3);
  assert.equal(result.inventoryDelta, 3, 'inventario +3');
  assert.equal(adapter.inventory.iron_ingot, 3);
  assert.equal(adapter.containers.get('2,64,0').contents.iron_ingot, undefined, 'il baule è stato aggiornato');
  assert.deepEqual(requests, ['take:container@0->cursor']);
});

test('take_<item> fails cleanly when the item is not in a container', async () => {
  const adapter = storageAdapter();
  assert.deepEqual(await adapter._takeFromContainer('iron_ingot'), { ok: false, error: 'item_not_in_container' });
});

test('deposit_<item> moves valuables into a container and verifies the delta', async () => {
  const adapter = storageAdapter();
  const entry = seedContainer(adapter, { contents: {} });
  adapter.inventorySlots[10] = { network_id: 458, name: 'iron_ingot', count: 4, stack_id: 9 };
  adapter.inventory = { iron_ingot: 4 };
  adapter._ensureStorageOpen = async () => {
    adapter._openContainer = { id: 1, type: 'container' };
    adapter._openContainerBlock = { name: 'chest', position: entry.position };
    adapter._openContainerSlots = new Array(27); // baule singolo: 27 slot (vuote)
  };
  const requests = [];
  adapter._sendStackRequest = async actions => {
    const a = actions[0];
    requests.push(`${a.type_id}:${a.source.slot_type.container_id}@${a.source.slot}->${a.destination.slot_type.container_id}@${a.destination.slot}`);
    if (a.type_id === 'place') {
      return {
        status: 'ok',
        containers: [
          { slot_type: { container_id: 'container' }, slots: [{ slot: 0, count: 4, item_stack_id: 71 }] },
        ],
      };
    }
    return {
      status: 'ok',
      containers: [{ slot_type: { container_id: 'cursor' }, slots: [{ slot: 0, count: 4, item_stack_id: 70 }] }],
    };
  };
  adapter._returnCursorToInventory = async () => true;
  const result = await adapter._depositItem('iron_ingot');
  assert.equal(result.ok, true);
  assert.equal(result.count, 4);
  assert.equal(adapter.containers.get('2,64,0').contents.iron_ingot, 4, 'il baule registra il deposito');
  assert.deepEqual(requests, [
    'take:hotbar_and_inventory@10->cursor@0',
    'place:cursor@0->container@0',
  ]);
});

test('deposit_<item> without a container or item fails cleanly', async () => {
  const adapter = storageAdapter();
  assert.deepEqual(await adapter._depositItem('iron_ingot'), { ok: false, error: 'container_not_found' });
  seedContainer(adapter, { contents: {} });
  assert.deepEqual(await adapter._depositItem('iron_ingot'), { ok: false, error: 'missing_item' });
});

test('options offer take/deposit only with a known container', () => {
  const adapter = storageAdapter();
  adapter.world.findBlocks = () => [];
  adapter.inventory = { iron_ingot: 2 };
  adapter.inventorySlots[10] = { network_id: 458, name: 'iron_ingot', count: 2, stack_id: 1 };
  let keys = adapter.options().map(o => o.key);
  assert.equal(keys.includes('read_container'), false);
  assert.equal(keys.includes('take_iron_ingot'), false);
  assert.equal(keys.includes('deposit_iron_ingot'), false, 'senza baule noto non si deposita');

  seedContainer(adapter, { contents: { iron_ingot: 3 } });
  keys = adapter.options().map(o => o.key);
  assert.equal(keys.includes('take_iron_ingot'), true);
  assert.equal(keys.includes('deposit_iron_ingot'), true);
});

test('options offer read_container for uncached nearby chests', () => {
  const adapter = storageAdapter();
  adapter.world.findBlocks = name => name === 'chest'
    ? [{ name: 'chest', position: { x: 2, y: 64, z: 0 }, distance: 2 }]
    : [];
  let keys = adapter.options().map(o => o.key);
  assert.equal(keys.includes('read_container'), true, 'baule vicino non censito');

  adapter.containers.set('2,64,0', { type: 'chest', position: { x: 2, y: 64, z: 0 }, readAt: Date.now(), contents: {} });
  keys = adapter.options().map(o => o.key);
  assert.equal(keys.includes('read_container'), false, 'baule già letto di recente');
});

test('executeAction routes read_container, take_ and deposit_', async () => {
  const adapter = storageAdapter();
  const calls = [];
  adapter._readContainers = async () => { calls.push('read'); return { ok: true }; };
  adapter._takeFromContainer = async item => { calls.push(`take:${item}`); return { ok: true }; };
  adapter._depositItem = async item => { calls.push(`deposit:${item}`); return { ok: true }; };
  assert.equal((await adapter.executeAction('read_container')).ok, true);
  assert.equal((await adapter.executeAction('take_iron_ingot')).ok, true);
  assert.equal((await adapter.executeAction('deposit_gold_ingot')).ok, true);
  assert.deepEqual(calls, ['read', 'take:iron_ingot', 'deposit:gold_ingot']);
});
