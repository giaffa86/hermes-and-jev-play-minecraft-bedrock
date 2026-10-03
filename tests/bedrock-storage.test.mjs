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
  assert.equal(calls.length, 4, 'un giro per ogni nome di contenitore');
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
