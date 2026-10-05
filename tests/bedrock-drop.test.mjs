// M9 adapter test (wiki/human-command.md): "getta <oggetto>" throws inventory
// out with the `drop` action of the item_stack_request, and "cattura <oggetto>"
// only offers the drops the order names. The stack request is stubbed: what
// matters here is the shape of the request, the local inventory accounting and
// the fact that the option exists only when there is something to act on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

function dropAdapter (inventorySlots = []) {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.client = new EventEmitter();
  adapter.client.entityId = 7n;
  adapter.client.write = () => {};
  adapter.position = { x: 0, y: 64.62, z: 0 };
  adapter._feet = { x: 0, y: 63, z: 0 };
  adapter.nearbyBlocks = {};
  adapter.drops = [];
  adapter.world = { registry: { items: {} } };
  adapter.world.findBlocks = () => [];
  // Il mondo serve a `options()` (vista lava/fluidi): tutto aria attorno.
  adapter.world.blockAt = () => ({ name: 'air', runtimeId: 7 });
  adapter.inventory = {};
  adapter.inventorySlots = inventorySlots;
  adapter.stackRequests = [];
  adapter.logs = [];
  adapter.log = (type, data) => adapter.logs.push({ type, ...data });
  // La raggiungibilità del pathing non è l'oggetto di questo test: si assume
  // sempre vero, così `_nearestDrop` non prova a leggere il mondo.
  adapter._reachabilityUsable = () => false;
  // Il server riduce la pila e risponde ok; il mirror locale si aggiorna come
  // farebbe `_applyStackResponse` con i container del response.
  adapter._ensureInventoryOpen = async () => {};
  adapter._sendStackRequest = async actions => {
    const action = actions[0];
    adapter.stackRequests.push(action);
    const slot = adapter.inventorySlots.find(entry => entry && entry.stack_id === action.source.stack_id);
    if (slot) slot.count = Math.max(0, (slot.count || 0) - action.count);
    return { status: 'ok' };
  };
  adapter._applyStackResponse = () => {};
  adapter._refreshInventory();
  return adapter;
}

const slot = (name, count, stackId, index = 0) => ({ name, count, stack_id: stackId, network_id: 100 + index });

function levelDropAdapter() {
  const bot=dropAdapter([slot('baked_potato',31,7)]);
  bot.world.blockAt=({y})=>y===62 ? {name:'stone',boundingBox:'block'}:{name:'air',boundingBox:'empty'};
  bot._lastPitch=75;
  bot.inputs=[];
  bot._queueAuthInput=async input=>bot.inputs.push(input);
  bot._moveTo=async target=>{bot._feet={...target};bot.position={...target,y:target.y+1.62};};
  return bot;
}

test('live drop faces horizontally and leaves the pickup radius before reporting success',async()=>{
  const bot=levelDropAdapter();
  const start={...bot._feet};
  const result=await bot._dropItems({names:['baked_potato'],count:1,leaveDrop:true});
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(bot.inputs[0].pitch,0,'a downward bed camera must not throw at the feet');
  assert.ok(Math.hypot(bot._feet.x-start.x,bot._feet.z-start.z)>=2.5);
  assert.equal(bot.inventory.baked_potato,30,'only one potato leaves the inventory');
});

test('live drop refuses without a clear level route and detects a potato picked back up',async()=>{
  const blocked=dropAdapter([slot('baked_potato',31,7)]);
  const refused=await blocked._dropItems({names:['baked_potato'],count:1,leaveDrop:true});
  assert.equal(refused.error,'drop_clearance_unavailable');
  assert.equal(blocked.stackRequests.length,0);
  const bot=levelDropAdapter();
  bot._moveTo=async()=>{bot.inventorySlots[0].count=31;};
  const result=await bot._dropItems({names:['baked_potato'],count:1,leaveDrop:true});
  assert.equal(result.ok,false);
  assert.equal(result.error,'drop_recollected','a temporary inventory decrease cannot report success');
});

test('_dropItems butta via tutta la pila con l\'azione `drop`, senza cursore', async () => {
  const adapter = dropAdapter([slot('diamond', 3, 7)]);
  const result = await adapter._dropItems({ names: ['diamond'], count: null });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.count, 3);
  assert.equal(adapter.stackRequests.length, 1);
  assert.deepEqual(adapter.stackRequests[0], {
    type_id: 'drop', legacy_type_id: 3, count: 3,
    source: { slot_type: { container_id: 'hotbar' }, slot: 0, stack_id: 7 },
    randomly: false,
  });
  assert.equal(adapter.inventory.diamond, undefined, 'la pila è uscita dall\'inventario locale');
  assert.equal(adapter.logs.at(-1).type, 'drop_item');
});

test('_dropItems rispetta la quota e lascia il resto in inventario', async () => {
  const adapter = dropAdapter([slot('diamond', 3, 7)]);
  const result = await adapter._dropItems({ names: ['diamond'], count: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  assert.equal(adapter.stackRequests[0].count, 2);
  assert.equal(adapter.inventory.diamond, 1, 'un pezzo resta in inventario');
});

test('_dropItems somma più pile dello stesso oggetto (slot diversi)', async () => {
  const slots = [];
  slots[0] = slot('diamond', 2, 7, 0);
  slots[20] = slot('diamond', 1, 8, 20);
  const adapter = dropAdapter(slots);
  const result = await adapter._dropItems({ names: ['diamond'], count: null });
  assert.equal(result.count, 3);
  assert.equal(adapter.stackRequests.length, 2);
  assert.deepEqual(adapter.stackRequests.map(a => a.source.container_id ?? a.source.slot_type.container_id), ['hotbar', 'hotbar_and_inventory']);
  assert.equal(adapter.inventory.diamond, undefined);
});

test('_dropItems si ferma al primo errore senza aver buttato niente', async () => {
  const adapter = dropAdapter([slot('diamond', 3, 7)]);
  adapter._sendStackRequest = async actions => { adapter.stackRequests.push(actions[0]); return { status: 50 }; };
  const result = await adapter._dropItems({ names: ['diamond'], count: null });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'drop_failed_50');
  assert.equal(adapter.logs.at(-1).type, 'drop_item_failed');
});

test('_dropItems non insiste quando il server risponde ok ma il mirror non si muove', async () => {
  const adapter = dropAdapter([slot('diamond', 3, 7)]);
  adapter._sendStackRequest = async actions => { adapter.stackRequests.push(actions[0]); return { status: 'ok' }; };
  const result = await adapter._dropItems({ names: ['diamond'], count: null });
  assert.equal(result.ok, false, 'nessun progresso: fermarsi invece di girare a vuoto');
  assert.equal(result.error, 'drop_no_progress');
  assert.equal(adapter.stackRequests.length, 1);
});

test('_dropItems senza niente in inventario non manda nessuna richiesta', async () => {
  const adapter = dropAdapter([slot('diamond', 3, 7)]);
  const result = await adapter._dropItems({ names: ['dirt'], count: null });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'nothing_to_drop');
  assert.equal(adapter.stackRequests.length, 0);
});

test('_plannedDrop esiste solo se l\'oggetto del piano è ancora in inventario', () => {
  const adapter = dropAdapter([slot('diamond', 3, 7)]);
  assert.equal(adapter._plannedDrop(), null, 'nessun piano, nessun drop');
  adapter.plan = { drop: { token: 'diamond', items: ['diamond'], count: 2 } };
  assert.deepEqual(adapter._plannedDrop(), { names: ['diamond'], count: 2, token: 'diamond' });
  adapter.inventorySlots = [];
  adapter._refreshInventory();
  assert.equal(adapter._plannedDrop(), null, 'pila esaurita: l\'opzione non esiste più');
});

test('options offre drop_item solo con un ordine di gettare e qualcosa da buttare', () => {
  const adapter = dropAdapter([slot('diamond', 3, 7)]);
  adapter.plan = { targets: {} };
  assert.equal(adapter.options().some(option => option.key === 'drop_item'), false);
  adapter.plan = { targets: {}, drop: { token: 'diamond', items: ['diamond'], count: null } };
  const option = adapter.options().find(entry => entry.key === 'drop_item');
  assert.ok(option, 'l\'opzione è offerta');
  assert.match(option.description, /diamond/);
  adapter.inventorySlots = [];
  adapter._refreshInventory();
  assert.equal(adapter.options().some(entry => entry.key === 'drop_item'), false, 'senza l\'oggetto non c\'è nulla da buttare');
});

test('_nearestDrop filtra per gli oggetti di un ordine di raccolta', () => {
  const adapter = dropAdapter();
  adapter.drops = [
    { id: 'a', item: 'coal', count: 1, position: { x: 2, y: 63, z: 0 }, spawnedAt: Date.now() },
    { id: 'b', item: 'diamond', count: 1, position: { x: 4, y: 63, z: 0 }, spawnedAt: Date.now() },
  ];
  assert.equal(adapter._nearestDrop({ names: ['diamond'] }).item, 'diamond');
  assert.equal(adapter._nearestDrop({ names: [] }), null, 'nessun drop dell\'oggetto nominato');
  assert.equal(adapter._nearestDrop().item, 'coal', 'senza filtro resta il più vicino');
});

test('_plannedCollectNames usa il token del piano, non l\'elenco congelato', () => {
  const adapter = dropAdapter();
  adapter.drops = [{ id: 'a', item: 'diamond_pickaxe', count: 1, position: { x: 2, y: 63, z: 0 }, spawnedAt: Date.now() }];
  assert.equal(adapter._plannedCollectNames(), null, 'senza ordine di raccolta nessun filtro');
  adapter.plan = { collect: { token: 'diamond', items: [] } };
  assert.deepEqual(adapter._plannedCollectNames(), ['diamond_pickaxe'], 'il drop arrivato dopo il piano conta comunque');
  assert.deepEqual(adapter._nearestDrop({ names: adapter._plannedCollectNames() }).item, 'diamond_pickaxe');
});

test('options offre collect_drop solo per il drop nominato dall\'ordine', () => {
  const adapter = dropAdapter();
  adapter.drops = [{ id: 'a', item: 'coal', count: 1, position: { x: 2, y: 63, z: 0 }, spawnedAt: Date.now() }];
  adapter.plan = { targets: {}, collect: { token: 'diamond', items: [] } };
  assert.equal(adapter.options().some(option => option.key === 'collect_drop'), false, 'il carbone non è l\'oggetto chiesto');
  adapter.drops.push({ id: 'b', item: 'diamond', count: 1, position: { x: 3, y: 63, z: 0 }, spawnedAt: Date.now() });
  const option = adapter.options().find(entry => entry.key === 'collect_drop');
  assert.ok(option);
  assert.match(option.description, /diamond/);
});
