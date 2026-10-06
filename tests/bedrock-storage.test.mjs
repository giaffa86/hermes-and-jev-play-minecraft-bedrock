import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';
import { storageBlockNames } from '../storage-blocks.mjs';

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

test('take options rotate across containers instead of filling the nearest one', () => {
  const adapter = storageAdapter();
  // Forma reale del villaggio (03/10): due scrigni di patate piu vicini, uno di
  // scorte e lo scrigno del pesce piu lontano. Con il riempimento per contenitore
  // il pesce non compariva mai fra le opzioni.
  seedContainer(adapter, { x: 2, contents: { poisonous_potato: 43, potato: 2216, baked_potato: 240 } });
  seedContainer(adapter, { x: 3, contents: { poisonous_potato: 43, potato: 2216, baked_potato: 240 } });
  seedContainer(adapter, { x: 4, contents: { bone_meal: 128, porkchop: 28 } });
  seedContainer(adapter, { x: 5, contents: { tropical_fish: 3, waterlily: 1, kelp: 12, salmon: 9, pufferfish: 7, cod: 6 } });
  const keys = adapter.options().filter((o) => o.key.startsWith('take_')).map((o) => o.key);
  assert.equal(keys.length, 8);
  assert.ok(keys.includes('take_tropical_fish'), `il quarto contenitore deve essere rappresentato: ${keys.join(', ')}`);
  // La rotazione porta prima gli item all'indice 0 di ogni contenitore.
  assert.deepEqual(keys.slice(0, 4), ['take_poisonous_potato', 'take_poisonous_potato', 'take_bone_meal', 'take_tropical_fish']);
});

test('an item named in the plan targets comes first, even from the farthest container', () => {
  const adapter = storageAdapter();
  seedContainer(adapter, { x: 2, contents: { poisonous_potato: 43, potato: 2216, baked_potato: 240 } });
  seedContainer(adapter, { x: 5, contents: { tropical_fish: 3, salmon: 9, pufferfish: 7, cod: 6 } });
  adapter.setPlan({ objective: 'tame a cat', targets: { salmon: 1 } });
  const keys = adapter.options().filter((o) => o.key.startsWith('take_')).map((o) => o.key);
  assert.equal(keys[0], 'take_salmon', `il bersaglio del piano va per primo: ${keys.join(', ')}`);
  assert.ok(keys.includes('take_cod'), `la rotazione rappresenta comunque lo scrigno del pesce: ${keys.join(', ')}`);
});

test('missing finished goods keep a take option when recipe ingredients would fill all eight slots', () => {
  const adapter = storageAdapter();
  const ingredients = Array.from({ length: 10 }, (_, i) => `ingredient_${i}`);
  seedContainer(adapter, { contents: { ...Object.fromEntries(ingredients.map(n => [n, 64])), oak_planks: 139, salmon: 64 } });
  adapter.inventory.salmon = 32;
  adapter.plan = { targets: { oak_planks: 235, salmon: 32 } };
  adapter._craftNeeds = () => ({ needs: [{ missing: [{ sources: ingredients.map(item => ({ item })), ingredient: 'unknown' }] }] });
  const takes = adapter.options().filter(o => o.key.startsWith('take_'));
  assert.equal(takes.length, 8);
  assert.equal(takes[0].key, 'take_oak_planks');
});

test('storage container slot types map chest/barrel/shulker', () => {
  const adapter = storageAdapter();
  assert.equal(adapter._storageContainerSlotType('chest'), 'container');
  assert.equal(adapter._storageContainerSlotType('trapped_chest'), 'container');
  assert.equal(adapter._storageContainerSlotType('barrel'), 'barrel');
  assert.equal(adapter._storageContainerSlotType('shulker_box'), 'shulker');
  assert.equal(adapter._storageContainerSlotType('unknown_block'), 'container');
});

test('unlabelled chest window updates are never mapped to player inventory', () => {
  const adapter = storageAdapter();
  adapter._openContainer = { id: 2, type: 'container' };
  assert.equal(adapter._playerSlotIndex(null, 2, 26), null);
  assert.equal(adapter._playerSlotIndex('hotbar_and_inventory', 2, 26), 26);
  assert.equal(adapter._playerSlotIndex(null, 0, 26), 26);
  adapter._openContainer = { id: 2, type: 'workbench' };
  assert.equal(adapter._playerSlotIndex(null, 2, 26), null);
  adapter._openContainer = { id: 2, type: 'inventory' };
  assert.equal(adapter._playerSlotIndex(null, 2, 26), 26);
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

test('an explicit waypoint stays offered when the horizontal position matches but elevation does not', () => {
  const adapter = storageAdapter();
  adapter.plan = { waypoint: { x: 0, y: 80, z: 0 } };
  assert.ok(adapter.options().some(o => o.key === 'goto_waypoint'));
  adapter.plan = { waypoint: { x: 0, y: 64, z: 0 } };
  assert.ok(!adapter.options().some(o => o.key === 'goto_waypoint'));
  adapter.plan = { waypoint: { x: 0, z: 0 } };
  assert.ok(!adapter.options().some(o => o.key === 'goto_waypoint'));
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

// Live 04/10/2026: un take verso un cursore già occupato viene rifiutato da BDS
// con status 50 (FailedToValidateDstSlot), anche con lo stesso item. Il take
// deve quindi svuotare il cursore *prima*, altrimenti l'errore accusa il baule.
test('a take with a dirty cursor empties it before taking from the container', async () => {
  const adapter = storageAdapter();
  const entry = seedContainer(adapter);
  const slots = [{ network_id: 458, name: 'iron_ingot', count: 3, stack_id: 5 }];
  adapter._ensureStorageOpen = async () => {
    adapter._openContainer = { id: 1, type: 'container' };
    adapter._openContainerBlock = { name: 'chest', position: entry.position };
    adapter._openContainerSlots = slots;
  };
  adapter._cursor = { network_id: 458, name: 'iron_ingot', count: 1, stack_id: 42 };
  const order = [];
  adapter._returnCursorToInventory = async () => {
    order.push('return_cursor');
    adapter.inventorySlots[0] = { network_id: 458, name: 'iron_ingot', count: 1, stack_id: 43 };
    adapter._cursor = null;
    return true;
  };
  adapter._sendStackRequest = async actions => {
    order.push(`${actions[0].type_id}:${actions[0].source.slot_type.container_id}@${actions[0].source.slot}`);
    return {
      status: 'ok',
      containers: [
        { slot_type: { container_id: 'cursor' }, slots: [{ slot: 0, count: 3, item_stack_id: 70 }] },
        { slot_type: { container_id: 'container' }, slots: [{ slot: 0, count: 0, item_stack_id: 0 }] },
      ],
    };
  };
  const result = await adapter._takeFromContainer('iron_ingot');
  assert.equal(result.ok, true, 'il take riesce una volta svuotato il cursore');
  assert.deepEqual(order.slice(0, 2), ['return_cursor', 'take:container@0'], 'il cursore si svuota prima del take');
  assert.equal(adapter.containers.get('2,64,0').contents.iron_ingot, undefined);
});

test('a take fails typed cursor_busy when the cursor cannot be emptied', async () => {
  const adapter = storageAdapter();
  const entry = seedContainer(adapter);
  adapter._ensureStorageOpen = async () => {
    adapter._openContainer = { id: 1, type: 'container' };
    adapter._openContainerBlock = { name: 'chest', position: entry.position };
    adapter._openContainerSlots = [{ network_id: 458, name: 'iron_ingot', count: 3, stack_id: 5 }];
  };
  adapter._cursor = { network_id: 425, name: 'gold_ingot', count: 1, stack_id: 42 };
  let sent = 0;
  adapter._returnCursorToInventory = async () => false;
  adapter._sendStackRequest = async () => { sent++; return { status: 'ok', containers: [] }; };
  assert.deepEqual(await adapter._takeFromContainer('iron_ingot'), { ok: false, error: 'cursor_busy' });
  assert.equal(sent, 0, 'senza cursore libero non si manda nessun take');
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

test('a targeted take uses the requested chest and quantity even when a nearer chest holds the item', async () => {
  const adapter = storageAdapter();
  const nearer = seedContainer(adapter, { x: 2, contents: { iron_ingot: 20 } });
  const authorized = seedContainer(adapter, { x: 8, contents: { iron_ingot: 20 } });
  const opened = [];
  adapter._ensureStorageOpen = async entry => {
    opened.push(entry.position);
    adapter._openContainerSlots = [{ network_id: 458, name: 'iron_ingot', count: 20, stack_id: 5 }];
  };
  let requestedCount;
  adapter._sendStackRequest = async ([action]) => {
    requestedCount = action.count;
    return { status: 'ok', containers: [] };
  };
  adapter._returnCursorToInventory = async () => {
    adapter.inventory.iron_ingot = requestedCount;
    return true;
  };
  const result = await adapter.executeAction('take_iron_ingot', { position: authorized.position, maxCount: 2 });
  assert.equal(result.ok, true);
  assert.deepEqual(opened, [authorized.position]);
  assert.deepEqual(result.position, authorized.position);
  assert.equal(result.count, 2);
  assert.equal(result.inventoryDelta, 2);
  assert.equal(adapter.containers.get('2,64,0').contents.iron_ingot, nearer.contents.iron_ingot);
});

test('a targeted take never falls back to another chest if its target is unknown', async () => {
  const adapter = storageAdapter();
  seedContainer(adapter);
  adapter._ensureStorageOpen = async () => assert.fail('no other chest may be opened');
  assert.equal((await adapter.executeAction('take_iron_ingot', { position: { x: 99, y: 64, z: 0 } })).error, 'item_not_in_container');
});

test('targeted take rejects malformed coordinates and unbounded quantities before opening a chest', async () => {
  const adapter = storageAdapter();
  adapter._ensureStorageOpen = async () => assert.fail('invalid withdrawal must not open a chest');
  for (const position of [null, {}, { x: 2.5, y: 64, z: 0 }, { x: 2, y: '64', z: 0 }]) {
    assert.equal((await adapter.executeAction('take_iron_ingot', { position })).error, 'invalid_container_position');
  }
  for (const maxCount of [0, -1, 65, 1.5, '2']) {
    assert.equal((await adapter.executeAction('take_iron_ingot', { maxCount })).error, 'invalid_take_count');
  }
  assert.equal(adapter.busy, false);
});

// Live 03/10: il contenuto di un container arriva in un pacchetto separato,
// spesso qualche centinaio di ms dopo `container_open`. Con il vecchio
// `delay(200)` fisso il take leggeva le slot della finestra **precedente** e
// dichiarava `item_not_in_container` su una cache ancora piena (baule a
// (90,73,160) con 795 lingotti).
function delayedContainerOpen (adapter, { windowId = 10, slots, delayMs = 300 } = {}) {
  adapter.opens = 0;
  adapter._queueAuthInput = async () => {
    adapter.opens++;
    adapter._openContainer = { id: windowId, type: 'container' };
    setTimeout(() => {
      if (adapter._openContainer?.id !== windowId) return; // finestra già chiusa
      adapter._openContainerSlots = slots;
      adapter._openContainerContentAt = Date.now();
      for (const waiter of adapter._containerContentWaiters.filter(w => w.windowId === windowId)) waiter.resolve(true);
    }, delayMs);
  };
  adapter._waitForContainerOpen = async () => ({ window_type: 'container', window_id: windowId });
}

test('the take waits for the container content and uses its slots', async () => {
  const adapter = storageAdapter();
  seedContainer(adapter, { contents: { iron_ingot: 3 } });
  // Slot rimaste dal contenitore precedente: se il take le usasse, l'item non
  // ci sarebbe e la cache verrebbe riscritta con dati falsi.
  adapter._openContainerSlots = [{ network_id: 5, name: 'oak_planks', count: 1, stack_id: 1 }];
  const ironSlots = [];
  ironSlots[0] = { network_id: 458, name: 'iron_ingot', count: 3, stack_id: 99 };
  delayedContainerOpen(adapter, { slots: ironSlots });
  const requests = [];
  adapter._sendStackRequest = async ([request]) => { requests.push(request); return { status: 'ok', containers: [] }; };
  adapter._applyStackResponse = () => {};
  adapter._returnCursorToInventory = async () => true;
  adapter._refreshInventory = () => {};

  const result = await adapter._takeFromContainer('iron_ingot');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.count, 3);
  assert.equal(adapter.opens, 1);
  assert.equal(requests[0].source.slot, 0, 'slot del contenuto appena arrivato');
  assert.equal(requests[0].source.stack_id, 99);
  assert.equal(adapter._cachedContainers().find(c => c.type === 'chest').contents.iron_ingot, undefined, 'lo scrigno si svuota nella cache');
});

test('a window that never sends its content is retried, then typed', async () => {
  const adapter = storageAdapter();
  adapter.opens = 0;
  adapter._queueAuthInput = async () => { adapter.opens++; adapter._openContainer = { id: 10, type: 'container' }; };
  adapter._waitForContainerOpen = async () => ({ window_type: 'container', window_id: 10 });
  await assert.rejects(
    () => adapter._ensureStorageOpen({ name: 'chest', position: { x: 2, y: 64, z: 0 }, distance: 2 }, { contentTimeoutMs: 30 }),
    /container_content_timeout/,
  );
  assert.equal(adapter.opens, 3, 'un tentativo per apertura, poi errore tipizzato');
  assert.equal(adapter._openContainer, null, 'nessuna finestra lasciata aperta');
});

test('a second container never accepts the previous window content', async () => {
  const adapter = storageAdapter();
  const first = seedContainer(adapter, { x: 2, contents: { iron_ingot: 3 } });
  const second = seedContainer(adapter, { x: 3, contents: { gold_ingot: 7 } });
  adapter.opens = 0;
  adapter._reachabilityUsable = () => false;
  adapter._waitForContainerOpen = async () => ({ window_type: 'container', window_id: adapter._openContainer?.id });
  adapter._queueAuthInput = async () => {
    adapter.opens++;
    const id = 10 + adapter.opens - 1;
    adapter._openContainer = { id, type: 'container' };
    if (id === 10) { // solo il primo contenitore consegna il suo contenuto
      adapter._openContainerSlots = [{ network_id: 458, name: 'iron_ingot', count: 3, stack_id: 99 }];
      adapter._openContainerContentAt = Date.now();
      adapter._openContainerContentWindow = id;
    }
  };
  adapter._closeContainer = async () => {
    adapter._openContainer = null;
    adapter._openContainerBlock = null;
    adapter._openContainerSlots = [];
    adapter._openContainerContentAt = 0;
    adapter._openContainerContentWindow = null;
  };

  await adapter._ensureStorageOpen(first);
  assert.equal(adapter.opens, 1);
  assert.equal(adapter._openContainerSlots[0].name, 'iron_ingot', 'il primo contenitore ha consegnato il contenuto');
  // Live 03/10: la finestra 3..10 si aprivano senza contenuto e il flag della
  // finestra 2 restava acceso, così la lettura scriveva {} nella cache e il take
  // dichiarava item_not_in_container su uno scrigno pieno di ferro.
  await assert.rejects(
    () => adapter._ensureStorageOpen(second, { contentTimeoutMs: 20 }),
    /container_content_timeout/,
  );
  assert.equal(adapter.opens, 4, 'il secondo contenitore viene ritentato tre volte senza accettare il contenuto della finestra precedente');
});

test('_waitForContainerContent only accepts the content of the window it waits for', async () => {
  const adapter = storageAdapter();
  adapter._openContainer = { id: 2, type: 'container' };
  adapter._openContainerSlots = [{ network_id: 458, name: 'iron_ingot', count: 3, stack_id: 99 }];
  adapter._openContainerContentAt = Date.now();
  adapter._openContainerContentWindow = 2;
  assert.equal(await adapter._waitForContainerContent(2, 20), true, 'la finestra 2 ha il suo contenuto');
  // Live 03/10: la finestra 3 si apriva con il contenuto della 2 ancora registrato
  // e la lettura dichiarava {} uno scrigno pieno.
  assert.equal(await adapter._waitForContainerContent(3, 20), false, 'il contenuto della finestra 2 non vale per la 3');
});

test('a take never rewrites the cache when the container content is missing', async () => {
  const adapter = storageAdapter();
  seedContainer(adapter, { contents: { iron_ingot: 3 } });
  adapter._ensureStorageOpen = async () => { throw new Error('container_content_timeout'); };
  const result = await adapter._takeFromContainer('iron_ingot');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'container_content_timeout');
  assert.deepEqual(adapter._cachedContainers()[0].contents, { iron_ingot: 3 }, 'la cache resta quella buona');
});

test('the storage scan asks for more than the nearest handful per name', () => {
  const adapter = storageAdapter();
  const calls = [];
  adapter.world.findBlocks = (name, _position, radius, count) => {
    calls.push({ name, radius, count });
    return [];
  };
  adapter._findNearbyStorageBlocks();
  // I nomi concreti sono i quattro base più le 16 tinte di shulker: la scansione
  // fa un giro per nome, quindi il numero lo decide il matcher, non il test.
  assert.equal(calls.length, storageBlockNames().length, 'un giro per ogni nome di contenitore');
  assert.deepEqual([...new Set(calls.map(c => c.name))], storageBlockNames());
  for (const call of calls) {
    assert.ok(call.count >= 16, `troppi pochi blocchi per nome: ${call.name} ${call.count}`);
  }
});

test('reading a wall of chests stops at the limit, nearest first', async () => {
  const adapter = storageAdapter();
  const chests = [];
  for (let i = 0; i < 20; i++) {
    chests.push({ name: 'chest', position: { x: i, y: 64, z: 0 }, distance: i });
  }
  adapter.world.findBlocks = (name) => (name === 'chest' ? [...chests] : []);
  adapter._reachabilityUsable = () => false;
  const opened = [];
  adapter._ensureStorageOpen = async (block) => { opened.push(block.position.x); adapter._openContainerSlots = []; };
  const result = await adapter._readContainers();
  assert.equal(result.ok, true);
  assert.equal(result.considered, 20, 'il censimento vede tutta la parete');
  assert.equal(result.read, 8, 'la lettura si ferma al limite');
  assert.equal(result.truncated, true);
  assert.deepEqual(opened, [...Array(8).keys()], 'si leggono i contenitori più vicini, in ordine');
});

test('a slow read stops on its budget instead of running to the action timeout', async () => {
  const adapter = storageAdapter();
  const chests = [];
  for (let i = 0; i < 8; i++) chests.push({ name: 'chest', position: { x: i, y: 64, z: 0 }, distance: i });
  adapter.world.findBlocks = (name) => (name === 'chest' ? [...chests] : []);
  adapter._reachabilityUsable = () => false;
  let opened = 0;
  adapter._ensureStorageOpen = async () => { opened++; await new Promise(r => setTimeout(r, 25)); adapter._openContainerSlots = []; };
  const result = await adapter._readContainers({ budgetMs: 40 });
  assert.equal(result.ok, true);
  assert.equal(result.budgetExceeded, true, 'il budget ferma la lettura');
  assert.ok(opened < 8, `non si legge tutta la parete con il budget: ${opened}`);
  assert.equal(result.read, opened);
});

test('the read walks with a short timeout, an explicit take keeps the generous one', async () => {
  const adapter = storageAdapter();
  const chest = { name: 'chest', position: { x: 20, y: 64, z: 0 }, distance: 20 };
  adapter.world.findBlocks = (name) => (name === 'chest' ? [chest] : []);
  adapter._reachabilityUsable = () => false;
  const walks = [];
  adapter._moveTo = async (target, radius, timeoutMs) => { walks.push({ target, radius, timeoutMs }); return { ok: true }; };
  adapter._openContainerSlots = [];
  adapter._waitForContainerOpen = async () => { throw new Error('container_open_timeout'); };
  adapter._waitForContainerContent = async () => false;
  await adapter._readContainers({ budgetMs: 1000 }).catch(() => {});
  assert.equal(walks.length, 1);
  assert.equal(walks[0].timeoutMs, 8000, 'nella lettura il cammino è corto');
  // Un `take_*` esplicito non cambia il timeout generoso.
  await adapter._ensureStorageOpen(chest).catch(() => {});
  assert.equal(walks[1].timeoutMs, 30000, 'il take mantiene il default');
});

// Live 04/10/2026: le opzioni `take_*` derivano dalla memoria durevole dei
// contenitori (sopravvivono al riavvio) mentre `_cachedContainers` è la cache
// runtime nata da una lettura: senza fallback l'opzione esisteva e l'azione
// rispondeva `item_not_in_container` in millisecondi (`take_cobblestone`).
// La memoria diventa quindi un bersaglio: il bot ci cammina e lo apre.
test('a take falls back to a remembered container when the runtime cache is empty', async () => {
  const adapter = storageAdapter();
  const opened = [];
  adapter.memory = {
    findContainers: ({ limit }) => {
      assert.equal(limit, 64, 'la memoria si interroga con un limite');
      return [
        { id: 'container_12_64_0', type: 'chest', position: { x: 12, y: 64, z: 0 }, contents: { dirt: 4 }, lastSeenAt: 111 },
        { id: 'container_9_64_0', type: 'barrel', position: { x: 9, y: 64, z: 0 }, contents: { iron_ingot: 2 }, lastSeenAt: 222 },
      ];
    },
  };
  adapter._ensureStorageOpen = async target => {
    opened.push(target.position);
    adapter._openContainer = { id: 3, type: 'container' };
    adapter._openContainerBlock = { name: target.name, position: target.position };
    adapter._openContainerSlots = [{ network_id: 458, name: 'iron_ingot', count: 2, stack_id: 11 }];
  };
  const requests = [];
  adapter._sendStackRequest = async actions => {
    requests.push(`${actions[0].type_id}:${actions[0].source.slot_type.container_id}@${actions[0].source.slot}`);
    return {
      status: 'ok',
      containers: [{ slot_type: { container_id: 'cursor' }, slots: [{ slot: 0, count: 2, item_stack_id: 33 }] }],
    };
  };
  const events = [];
  adapter.log = (type, data) => events.push([type, data]);
  adapter._returnCursorToInventory = async () => { adapter._cursor = null; return true; };
  const result = await adapter._takeFromContainer('iron_ingot');
  assert.equal(result.ok, true, `il take dalla memoria riesce: ${JSON.stringify(result)}`);
  assert.equal(result.remembered, true, 'il risultato dichiara la provenienza dalla memoria');
  assert.equal(result.from, 'barrel', 'il contenitore ricordato è il bersaglio');
  assert.deepEqual(opened[0], { x: 9, y: 64, z: 0 }, 'il bot apre il contenitore ricordato');
  assert.deepEqual(requests, ['take:barrel@0']);
  assert.equal(events[0][0], 'container_take_remembered', `log diagnostico: ${events.map(e => e[0]).join(', ')}`);
  assert.equal(events[0][1].distance, 9, 'la distanza è quella della posizione ricordata');
});

test('a remembered container that no longer holds the item re-aligns and refuses', async () => {
  const adapter = storageAdapter();
  adapter.memory = {
    findContainers: () => [{ id: 'container_9_64_0', type: 'chest', position: { x: 9, y: 64, z: 0 }, contents: { iron_ingot: 2 }, lastSeenAt: 222 }],
  };
  adapter._ensureStorageOpen = async target => {
    adapter._openContainer = { id: 3, type: 'container' };
    adapter._openContainerBlock = { name: target.name, position: target.position };
    adapter._openContainerSlots = [{ network_id: 425, name: 'gold_ingot', count: 1, stack_id: 12 }];
  };
  let sent = 0;
  adapter._sendStackRequest = async () => { sent++; return { status: 'ok', containers: [] }; };
  assert.deepEqual(await adapter._takeFromContainer('iron_ingot'), { ok: false, error: 'item_not_in_container' });
  assert.equal(sent, 0, 'nessuna transazione su un contenitore che non ha più l’item');
  assert.deepEqual(adapter.containers.get('9,64,0').contents, { gold_ingot: 1 }, 'la cache si riallinea sul contenuto reale');
});

test('a take prefers the runtime cache and only then the memory', async () => {
  const adapter = storageAdapter();
  seedContainer(adapter, { x: 2, contents: { iron_ingot: 3 } });
  let memoryAsked = 0;
  adapter.memory = { findContainers: () => { memoryAsked++; return [{ type: 'chest', position: { x: 40, y: 64, z: 0 }, contents: { iron_ingot: 9 } }]; } };
  const opened = [];
  adapter._ensureStorageOpen = async target => {
    opened.push(target.position.x);
    adapter._openContainer = { id: 1, type: 'container' };
    adapter._openContainerBlock = { name: target.name, position: target.position };
    adapter._openContainerSlots = [{ network_id: 458, name: 'iron_ingot', count: 3, stack_id: 5 }];
  };
  adapter._sendStackRequest = async () => ({ status: 'ok', containers: [{ slot_type: { container_id: 'cursor' }, slots: [{ slot: 0, count: 3, item_stack_id: 70 }] }] });
  adapter._returnCursorToInventory = async () => { adapter._cursor = null; return true; };
  const result = await adapter._takeFromContainer('iron_ingot');
  assert.equal(result.ok, true);
  assert.equal(result.remembered, undefined, 'la cache fresca non è una lettura dalla memoria');
  assert.deepEqual(opened, [2], 'si usa il contenitore appena letto, non quello più lontano in memoria');
  assert.equal(memoryAsked, 0, 'con una cache che basta la memoria non serve');
});

test('a remembered item in a container the bot cannot reach is reported as such', async () => {
  const adapter = storageAdapter();
  adapter.memory = {
    findContainers: () => [
      { id: 'container_90_73_160', type: 'chest', position: { x: 90, y: 73, z: 160 }, contents: { iron_ingot: 731, gold_ingot: 144 } },
      { id: 'container_91_73_160', type: 'chest', position: { x: 91, y: 73, z: 160 }, contents: { iron_ingot: 731 } },
    ],
  };
  adapter._reachabilityUsable = () => true;
  adapter.approachReachable = () => false;
  const result = await adapter._takeFromContainer('iron_ingot');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'container_unreachable', `non «non esiste»: ${JSON.stringify(result)}`);
  assert.match(result.hint, /2 remembered container\(s\) hold iron_ingot/);
});

test('with an unusable reachability model the remembered container is tried anyway', async () => {
  const adapter = storageAdapter();
  adapter.memory = { findContainers: () => [{ id: 'c', type: 'chest', position: { x: 9, y: 64, z: 0 }, contents: { iron_ingot: 2 } }] };
  adapter._reachabilityUsable = () => false;
  adapter.approachReachable = () => { throw new Error('non deve essere interrogato'); };
  const opened = [];
  adapter._ensureStorageOpen = async target => {
    opened.push(target.position.x);
    adapter._openContainer = { id: 3, type: 'container' };
    adapter._openContainerBlock = { name: target.name, position: target.position };
    adapter._openContainerSlots = [{ network_id: 458, name: 'iron_ingot', count: 2, stack_id: 11 }];
  };
  adapter._sendStackRequest = async () => ({ status: 'ok', containers: [{ slot_type: { container_id: 'cursor' }, slots: [{ slot: 0, count: 2, item_stack_id: 33 }] }] });
  adapter._returnCursorToInventory = async () => { adapter._cursor = null; return true; };
  const result = await adapter._takeFromContainer('iron_ingot');
  assert.equal(result.ok, true, `fail-open come le altre primitive: ${JSON.stringify(result)}`);
  assert.deepEqual(opened, [9]);
});

test('take options survive a restart thanks to the remembered containers', () => {
  const adapter = storageAdapter();
  // Dopo un riavvio la cache runtime è vuota: le opzioni vengono dalla memoria.
  adapter.memory = {
    findContainers: () => [
      { type: 'chest', position: { x: 92, y: 73, z: 165 }, contents: { bucket: 1 }, lastSeenAt: 1 },
      { type: 'barrel', position: { x: 111, y: 72, z: 160 }, contents: { coal: 64 }, lastSeenAt: 2 },
    ],
  };
  adapter._reachabilityUsable = () => true;
  adapter.approachReachable = () => true;
  const takes = adapter.options().filter(o => o.key.startsWith('take_'));
  assert.deepEqual(takes.map(o => o.key), ['take_bucket', 'take_coal']);
  assert.match(takes[0].description, /remembered: re-read on arrival/, `deve dichiarare la provenienza: ${takes[0].description}`);
  assert.match(takes[0].description, /92/);
});

test('a remembered container out of the walkable component is not offered', () => {
  const adapter = storageAdapter();
  adapter.memory = {
    findContainers: () => [
      { type: 'chest', position: { x: 90, y: 73, z: 160 }, contents: { iron_ingot: 731 } },
      { type: 'chest', position: { x: 92, y: 73, z: 165 }, contents: { bucket: 1 } },
    ],
  };
  adapter._reachabilityUsable = () => true;
  adapter.approachReachable = position => position.x === 92;
  const takes = adapter.options().filter(o => o.key.startsWith('take_'));
  assert.deepEqual(takes.map(o => o.key), ['take_bucket'], `solo il baule raggiungibile: ${takes.map(o => o.key).join(', ')}`);
});

test('the runtime cache wins over the memory for the same container', () => {
  const adapter = storageAdapter();
  seedContainer(adapter, { x: 2, contents: { iron_ingot: 3 } });
  adapter.memory = { findContainers: () => [{ type: 'chest', position: { x: 2, y: 64, z: 0 }, contents: { iron_ingot: 99 } }] };
  adapter._reachabilityUsable = () => true;
  adapter.approachReachable = () => true;
  const takes = adapter.options().filter(o => o.key.startsWith('take_'));
  assert.equal(takes.length, 1, `nessun doppione per lo stesso baule: ${takes.map(o => o.key).join(', ')}`);
  assert.doesNotMatch(takes[0].description, /remembered/, `la cache fresca non è «remembered»: ${takes[0].description}`);
});

test('a remembered container gets a longer walk budget than a cached one', async () => {
  const adapter = storageAdapter();
  const budgets = [];
  adapter.memory = {
    findContainers: () => [
      { type: 'chest', position: { x: 92, y: 73, z: 165 }, contents: { bucket: 1 }, lastSeenAt: 5 },
    ],
  };
  adapter._ensureStorageOpen = async (target, options = {}) => {
    budgets.push({ from: target.remembered ? 'memory' : 'cache', walkTimeoutMs: options.walkTimeoutMs });
    adapter._openContainer = { id: 2, type: 'container' };
    adapter._openContainerSlots = [{ network_id: 77, name: target.remembered ? 'bucket' : 'dirt', count: 1, stack_id: 3 }];
  };
  adapter._sendStackRequest = async () => ({
    status: 'ok',
    containers: [{ slot_type: { container_id: 'cursor' }, slots: [{ slot: 0, count: 1, item_stack_id: 9 }] }],
  });
  adapter._returnCursorToInventory = async () => { adapter._cursor = null; return true; };
  const remembered = await adapter._takeFromContainer('bucket');
  assert.equal(remembered.ok, true, JSON.stringify(remembered));
  // La camminata verso un baule ricordato può superare i 30 s (live 04/10/2026: 31 s
  // per 21 blocchi, arrivando a tre blocchi dal bersaglio).
  assert.deepEqual(budgets, [{ from: 'memory', walkTimeoutMs: 75000 }]);
  budgets.length = 0;
  seedContainer(adapter, { x: 2, contents: { dirt: 4 } });
  adapter._openContainerSlots = [{ network_id: 77, name: 'dirt', count: 1, stack_id: 3 }];
  const cached = await adapter._takeFromContainer('dirt');
  assert.equal(cached.ok, true, JSON.stringify(cached));
  assert.deepEqual(budgets, [{ from: 'cache', walkTimeoutMs: undefined }], 'la cache fresca tiene il default');
});

test('a remembered container that just failed to open is not offered, but comes back later', () => {
  const adapter = storageAdapter();
  adapter.memory = {
    findContainers: () => [{ type: 'chest', position: { x: 93, y: 72, z: 160 }, contents: { egg: 16 } }],
  };
  adapter._reachabilityUsable = () => true;
  adapter.approachReachable = () => true;
  const keys = () => adapter.options().filter(o => o.key.startsWith('take_')).map(o => o.key);
  assert.deepEqual(keys(), ['take_egg'], 'senza fallimenti il contenitore è offribile');
  // Live 04/10: la cassa ricordata a (93,72,160) non esiste più (il baule è un blocco
  // più in alto) e l'apertura costa 18 s di tentativi.
  adapter._storageOpenFailures.set('93,72,160', { at: Date.now(), error: 'container_open_timeout' });
  assert.deepEqual(keys(), [], 'un fallimento recente toglie l\'offerta');
  adapter._storageOpenFailures.set('93,72,160', { at: Date.now() - 11 * 60 * 1000, error: 'container_open_timeout' });
  assert.deepEqual(keys(), ['take_egg'], 'scaduto il cooldown il contenitore torna offribile');
});

test('a failed open is recorded, and a success clears it', async () => {
  const adapter = storageAdapter();
  adapter.memory = {
    findContainers: () => [{ type: 'chest', position: { x: 9, y: 64, z: 0 }, contents: { iron_ingot: 2 }, lastSeenAt: 1 }],
  };
  const events = [];
  adapter.log = (type, data) => events.push([type, data]);
  adapter._openStorageWindow = async () => { throw new Error('container_open_timeout'); };
  const failed = await adapter._takeFromContainer('iron_ingot');
  assert.equal(failed.error, 'container_open_timeout', `un fallimento di apertura resta un esito tipizzato: ${JSON.stringify(failed)}`);
  assert.equal(adapter._storageOpenFailures.get('9,64,0').error, 'container_open_timeout', 'il fallimento è registrato');
  assert.ok(events.some(e => e[0] === 'storage_open_failure'), `log diagnostico: ${events.map(e => e[0]).join(', ')}`);
  // La richiesta esplicita resta possibile (l'offerta no): il secondo tentativo apre.
  adapter._openStorageWindow = async (target, options) => {
    assert.equal(options.walkTimeoutMs, 75000, 'da memoria il budget di cammino è quello lungo');
    adapter._openContainer = { id: 2, type: 'container' };
    adapter._openContainerSlots = [{ network_id: 55, name: 'iron_ingot', count: 2, stack_id: 8 }];
  };
  adapter._sendStackRequest = async () => ({
    status: 'ok',
    containers: [{ slot_type: { container_id: 'cursor' }, slots: [{ slot: 0, count: 2, item_stack_id: 12 }] }],
  });
  adapter._returnCursorToInventory = async () => { adapter._cursor = null; return true; };
  const ok = await adapter._takeFromContainer('iron_ingot');
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(adapter._storageOpenFailures.has('9,64,0'), false, 'un\'apertura riuscita cancella il fallimento');
});

test('an explicit take prefers a remembered container that has not just failed', async () => {
  const adapter = storageAdapter();
  adapter.memory = {
    findContainers: () => [
      { type: 'chest', position: { x: 93, y: 72, z: 160 }, contents: { egg: 16 }, lastSeenAt: 1 },
      { type: 'chest', position: { x: 71, y: 71, z: 153 }, contents: { egg: 16 }, lastSeenAt: 2 },
    ],
  };
  adapter._storageOpenFailures.set('93,72,160', { at: Date.now(), error: 'container_open_timeout' });
  const opened = [];
  adapter._ensureStorageOpen = async target => {
    opened.push(target.position);
    adapter._openContainer = { id: 4, type: 'container' };
    adapter._openContainerSlots = [{ network_id: 91, name: 'egg', count: 1, stack_id: 6 }];
  };
  adapter._sendStackRequest = async () => ({
    status: 'ok',
    containers: [{ slot_type: { container_id: 'cursor' }, slots: [{ slot: 0, count: 1, item_stack_id: 30 }] }],
  });
  adapter._returnCursorToInventory = async () => { adapter._cursor = null; return true; };
  const result = await adapter._takeFromContainer('egg');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(opened, [{ x: 71, y: 71, z: 153 }], 'il baule appena fallito non è il primo tentativo');
  // E se è l'unico che lo dichiara, si ritenta comunque (nessun rifiuto a priori).
  adapter.containers.clear();   // cache runtime fredda: si torna alla memoria
  adapter.memory = { findContainers: () => [{ type: 'chest', position: { x: 93, y: 72, z: 160 }, contents: { egg: 16 } }] };
  const events = [];
  adapter.log = (type, data) => events.push([type, data]);
  const retry = await adapter._takeFromContainer('egg');
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.deepEqual(opened[1], { x: 93, y: 72, z: 160 });
  assert.ok(events.some(e => e[0] === 'container_take_retrying'), `log: ${events.map(e => e[0]).join(', ')}`);
});

test('a container read skips a container that just failed to open', async () => {
  const adapter = storageAdapter();
  adapter._findNearbyStorageBlocks = () => [
    { name: 'chest', position: { x: 2, y: 64, z: 0 } },
    { name: 'chest', position: { x: 9, y: 64, z: 0 } },
  ];
  adapter._reachabilityUsable = () => false;
  const opened = [];
  adapter._ensureStorageOpen = async target => {
    opened.push(target.position);
    adapter._openContainer = { id: 2, type: 'container' };
    adapter._openContainerSlots = [{ network_id: 5, name: 'dirt', count: 1, stack_id: 2 }];
  };
  const events = [];
  adapter.log = (type, data) => events.push([type, data]);
  const first = await adapter._readContainers();
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(opened.length, 2, 'senza fallimenti la lettura li tocca entrambi');
  // Live 04/10: un baule che non si apre costa ~18 s a ogni lettura.
  adapter._storageOpenFailures.set('2,64,0', { at: Date.now(), error: 'container_open_timeout' });
  opened.length = 0;
  const second = await adapter._readContainers();
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.deepEqual(opened, [{ x: 9, y: 64, z: 0 }], 'il contenitore in cooldown è saltato');
  assert.ok(events.some(e => e[0] === 'container_read_skipped'), `log: ${events.map(e => e[0]).join(', ')}`);
});

// ---- M3c: lo scarico di fine lavoro ----------------------------------------------------------
// Un baule finto che si comporta davvero: `take`/`place` spostano i conteggi
// slot per slot, così il dump multi-stack è verificabile sul delta reale di
// inventario e contenuto (l'invariante di M3c: mai un successo dichiarato).
function workingChest (adapter, entry) {
  const requests = [];
  // Il mirror di una finestra di baule singolo (27 slot), come lo vede il client.
  const slots = new Array(27);
  for (const [item, count] of Object.entries(entry.contents || {})) {
    slots[slots.findIndex(s => !s)] = { network_id: 1, name: item, count, stack_id: 5 };
  }
  adapter._ensureStorageOpen = async () => {
    adapter._openContainer = { id: 1, type: 'container' };
    adapter._openContainerBlock = { name: entry.type, position: entry.position };
    adapter._openContainerSlots = slots;
  };
  adapter._sendStackRequest = async actions => {
    const a = actions[0];
    requests.push({ type: a.type_id, fromSlot: a.source.slot, toSlot: a.destination.slot });
    if (a.type_id === 'take') {
      const source = adapter.inventorySlots[a.source.slot];
      const remaining = source ? Math.max(0, (source.count || 0) - a.count) : 0;
      if (source) source.count = remaining;
      if (source && remaining <= 0) adapter.inventorySlots[a.source.slot] = undefined;
      return {
        status: 'ok',
        containers: [
          { slot_type: { container_id: 'cursor' }, slots: [{ slot: 0, count: a.count, item_stack_id: 70 }] },
          { slot_type: { container_id: 'hotbar_and_inventory' }, slots: [{ slot: a.source.slot, count: remaining, item_stack_id: source?.stack_id || 0 }] },
        ],
      };
    }
    // Il mirror degli slot non si aggiorna dalla risposta `place` (il client lo
    // fa per conto suo): la verifica resta quella dell'adapter, sul suo registro.
    return { status: 'ok', containers: [{ slot_type: { container_id: 'cursor' }, slots: [{ slot: 0, count: 0 }] }] };
  };
  return requests;
}

test('the keep list leaves tools, gear, seeds and a food reserve in the pack', () => {
  const adapter = storageAdapter();
  adapter.inventory = {
    iron_pickaxe: 1, cooked_beef: 3, wheat_seeds: 12, torch: 20,
    wheat: 30, cobblestone: 64, raw_iron: 5, milk_bucket: 1,
  };
  const items = adapter._depositableItems();
  const byName = Object.fromEntries(items.map(e => [e.item, e.count]));
  assert.equal(byName.iron_pickaxe, undefined, 'gli attrezzi restano');
  assert.equal(byName.cooked_beef, undefined, 'il cibo sotto la riserva resta');
  assert.equal(byName.wheat_seeds, undefined, 'le sementi restano');
  assert.equal(byName.torch, 4, 'le torce sono una riserva: l\'eccesso va in baule');
  assert.equal(byName.milk_bucket, undefined, 'i secchi non si depositano');
  assert.equal(byName.wheat, 30, 'il grano non è cibo: è tutto roba da baule');
  assert.equal(byName.cobblestone, 64, 'i ciottoli sono tutti depositabili');
  assert.equal(byName.raw_iron, 5, 'il minerale grezzo è valore');
  assert.equal(items[0].item, 'cobblestone', 'il più abbondante per primo');
  const noReserve = Object.fromEntries(adapter._depositableItems({reserve: 0}).map(e => [e.item, e.count]));
  assert.equal(noReserve.wheat, 30, 'riserva 0 = tutto depositabile');
  assert.equal(noReserve.cooked_beef, 3);
});

test('a chest that already holds the item beats a nearer empty one', () => {
  const adapter = storageAdapter();
  seedContainer(adapter, { x: 2, y: 64, z: 0, contents: {} });
  seedContainer(adapter, { x: 40, y: 64, z: 0, contents: { cobblestone: 12 } });
  assert.equal(adapter._depositTargetFor('cobblestone').position.x, 40, 'si accorpa dove l\'item vive già');
  assert.equal(adapter._depositTargetFor('wheat').position.x, 2, 'senza l\'item vince la distanza');
  assert.equal(adapter._depositTargetFor(null, {cachedOnly: true}).position.x, 2);
});

test('observe exposes what is depositable and where it would go', () => {
  const adapter = storageAdapter();
  seedContainer(adapter, { x: 2, y: 64, z: 0, contents: {} });
  adapter.inventory = { cobblestone: 64, iron_pickaxe: 1, cooked_beef: 2 };
  const state = adapter.observe().deposit;
  assert.deepEqual(state.items, [{ item: 'cobblestone', count: 64 }]);
  assert.equal(state.total, 64);
  assert.equal(state.target.type, 'chest');
  assert.ok(state.target.distance > 1 && state.target.distance < 3, `distanza ${state.target.distance}`);
  assert.deepEqual(state.target.position, { x: 2, y: 64, z: 0 });
});

test('dump_inventory empties the pack into the right chest and keeps the reserve', async () => {
  const logs = [];
  const adapter = storageAdapter();
  adapter.log = (event, payload) => logs.push({ event, ...payload });
  adapter._reachabilityUsable = () => false;
  seedContainer(adapter, { x: 2, y: 64, z: 0, type: 'chest', contents: {} });
  const far = seedContainer(adapter, { x: 30, y: 64, z: 0, type: 'chest', contents: { cobblestone: 4 } });
  adapter.inventorySlots[10] = { network_id: 1, name: 'cobblestone', count: 64, stack_id: 11 };
  adapter.inventorySlots[11] = { network_id: 2, name: 'wheat', count: 30, stack_id: 12 };
  adapter.inventorySlots[12] = { network_id: 3, name: 'iron_pickaxe', count: 1, stack_id: 13 };
  adapter.inventorySlots[13] = { network_id: 4, name: 'cooked_beef', count: 20, stack_id: 14 };
  for (const [id, name] of [[1, 'cobblestone'], [2, 'wheat'], [3, 'iron_pickaxe'], [4, 'cooked_beef']]) adapter.world.registry.items[id] = { name };
  adapter._refreshInventory();
  const requests = workingChest(adapter, far);
  adapter._returnCursorToInventory = async () => true;
  const result = await adapter._dumpInventory();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.into, 'chest');
  assert.equal(result.position.x, 30, 'il baule che già contiene i ciottoli');
  const items = Object.fromEntries(result.items.map(e => [e.item, e.count]));
  assert.equal(items.cobblestone, 64);
  assert.equal(items.wheat, 30, 'il grano non è cibo: va tutto in baule');
  assert.equal(items.cooked_beef, 4, 'del cibo si riporta solo il surplus oltre la riserva');
  assert.equal(items.iron_pickaxe, undefined);
  assert.equal(result.stacks, 3, 'tre stack, uno per item');
  assert.equal(adapter.inventory.cobblestone, undefined, 'i ciottoli sono tutti nel baule');
  assert.equal(adapter.inventory.wheat, undefined);
  assert.equal(adapter.inventory.cooked_beef, 16, 'la riserva di cibo resta in zaino');
  assert.equal(adapter.inventory.iron_pickaxe, 1);
  assert.equal(adapter.containers.get('30,64,0').contents.cobblestone, 68);
  assert.equal(adapter.containers.get('30,64,0').contents.wheat, 30);
  assert.equal(adapter.containers.get('30,64,0').contents.cooked_beef, 4);
  assert.equal(adapter.containers.get('2,64,0').contents.cobblestone, undefined, 'il baule vicino non si tocca');
  assert.equal(requests.length, 6, 'tre stack = tre take + tre place');
  assert.ok(logs.some(l => l.event === 'container_dump'), `log: ${logs.map(l => l.event).join(', ')}`);
});

test('dump_inventory fails cleanly with nothing to store', async () => {
  const adapter = storageAdapter();
  adapter.inventory = { iron_pickaxe: 1 };
  assert.deepEqual(await adapter._dumpInventory(), { ok: false, error: 'nothing_to_deposit' });
  adapter.inventory = { cobblestone: 64 };
  assert.deepEqual(await adapter._dumpInventory(), { ok: false, error: 'container_not_found' });
});

test('options offer the single dump when there is something to store', () => {
  const adapter = storageAdapter();
  adapter._reachabilityUsable = () => false;
  adapter.inventory = { cobblestone: 64, iron_pickaxe: 1 };
  assert.equal(adapter.options().some(o => o.key === 'dump_inventory'), false, 'senza baule non si scarica');
  seedContainer(adapter, { contents: {} });
  const option = adapter.options().find(o => o.key === 'dump_inventory');
  assert.ok(option, 'con un baule noto e roba da riporre il dump è offerto');
  assert.match(option.description, /1 item type\(s\) \(cobblestone\)/);
});
