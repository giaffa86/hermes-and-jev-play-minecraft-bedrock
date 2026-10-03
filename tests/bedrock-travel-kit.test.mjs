import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

// Un adapter "piatto": niente rete, un mondo a celle esplicite, i piedi dove
// diciamo noi. Serve per esercitare il kit di viaggio (loadout, pillar-up,
// rifugio) senza un server.
function flatAdapter ({ inventory = {}, feet = { x: 0.5, y: 63, z: 0.5 } } = {}) {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.client = new EventEmitter();
  adapter.client.entityId = 7n;
  adapter.client.write = () => {};
  adapter.position = { x: feet.x, y: feet.y + 1.62, z: feet.z };
  adapter._feet = { ...feet };
  adapter.inventory = { ...inventory };
  adapter.inventorySlots = Array.from({ length: 36 }, (_, i) => (i === 0 ? { network_id: 1, item: {}, count: 1 } : null));
  adapter.armor = {};
  adapter.drops = [];
  adapter.selectedHotbar = 0;
  adapter.riding = null;
  adapter._onGround = true;
  adapter._motion = null;
  adapter._openDoors = new Map();
  adapter._refreshNearby = () => {};
  const cells = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  adapter.world = {
    blockAt: ({ x, y, z }) => cells.get(key(x, y, z)) ?? { name: 'air', boundingBox: 'empty' },
    findBlocks: () => [],
    runtimeIdAt: () => 1,
    loaded: new Map(),
    set (x, y, z, name = 'stone') { cells.set(key(x, y, z), { name, boundingBox: 'block' }); },
  };
  adapter.world.set(Math.floor(feet.x), Math.floor(feet.y) - 1, Math.floor(feet.z));
  return adapter;
}

// Sostituisce il piazzamento reale: registra la chiamata, materializza il blocco
// e simula l'atterraggio sopra di esso (per il pillar-up).
function stubPlace (adapter, { fail = null } = {}) {
  const calls = [];
  adapter._placeAtCell = async (itemName, blockName, target, support, face) => {
    calls.push({ itemName, blockName, target: { ...target }, support: { ...support }, face });
    if (fail) return { ok: false, error: fail, block: blockName, position: { ...target } };
    adapter.world.set(target.x, target.y, target.z, blockName);
    adapter.inventory[itemName] = Math.max(0, (adapter.inventory[itemName] || 0) - 1);
    adapter._feet = { ...adapter._feet, y: target.y + 1 };
    adapter._onGround = true;
    return { ok: true, block: blockName, position: { ...target } };
  };
  adapter._jumpOnce = async () => {
    adapter._onGround = false;
    adapter._feet = { ...adapter._feet, y: adapter._feet.y + 1.05 }; // salita del salto
    return true;
  };
  return calls;
}

// ---- loadout (_nextKitCraft / _travelKit) -------------------------------------------

test('_nextKitCraft propone il primo pezzo mancante in ordine di dipendenza', () => {
  const nothing = flatAdapter();
  assert.equal(nothing._nextKitCraft(), null);

  const logs = flatAdapter({ inventory: { oak_log: 4 } });
  assert.equal(logs._nextKitCraft(), 'oak_planks');

  const sticks = flatAdapter({ inventory: { oak_planks: 4 } });
  assert.equal(sticks._nextKitCraft(), 'stick');

  const sword = flatAdapter({ inventory: { oak_planks: 4, stick: 2 } });
  assert.equal(sword._nextKitCraft(), 'wooden_sword');

  const table = flatAdapter({ inventory: { oak_planks: 4, stick: 2, wooden_sword: 1 } });
  assert.equal(table._nextKitCraft(), 'crafting_table');

  const torch = flatAdapter({ inventory: { oak_planks: 4, stick: 2, wooden_sword: 1, crafting_table: 1, coal: 1 } });
  assert.equal(torch._nextKitCraft(), 'torch');

  const bed = flatAdapter({ inventory: { oak_planks: 4, stick: 2, wooden_sword: 1, crafting_table: 1, torch: 4, white_wool: 3 } });
  assert.equal(bed._nextKitCraft(), 'bed');

  const done = flatAdapter({ inventory: { oak_planks: 4, stick: 2, wooden_sword: 1, crafting_table: 1, torch: 4, white_wool: 3, bed: 1 } });
  assert.equal(done._nextKitCraft(), null);
});

test('_travelKit crafta in sequenza i pezzi mancanti e si ferma quando non serve più', async () => {
  const adapter = flatAdapter({ inventory: { oak_log: 4, coal: 1, crafting_table: 1 } });
  const placements = [];
  adapter._placeBlock = async (item) => { placements.push(item); return { ok: true, position: { x: 1, y: 63, z: 0 } }; };
  const crafted = [];
  adapter._craftItem = async (item) => {
    crafted.push(item);
    adapter.inventory[item] = (adapter.inventory[item] || 0) + (item.endsWith('_planks') ? 4 : 1);
    return { ok: true };
  };
  adapter._travelReadiness = () => ({ ready: true, items: {}, missing: [] });
  const result = await adapter._travelKit();
  assert.deepEqual(crafted, ['oak_planks', 'stick', 'wooden_sword', 'torch']);
  assert.deepEqual(placements, ['crafting_table'], 'la spada 3×3 richiede un tavolo piazzato');
  assert.deepEqual(result.crafted.map(c => c.item), crafted);
  assert.deepEqual(result.failed, []);
  assert.equal(result.ok, true);
});

test('_ensureCraftingTable accetta il tavolo vicino, ne piazza uno o fallisce', async () => {
  const nearby = flatAdapter({ inventory: {} });
  nearby.world.findBlocks = (name) => (name === 'crafting_table' ? [{ name, position: { x: 1, y: 63, z: 0 } }] : []);
  assert.deepEqual(await nearby._ensureCraftingTable(), { ok: true, nearby: true, position: { x: 1, y: 63, z: 0 } });

  const portable = flatAdapter({ inventory: { crafting_table: 1 } });
  const placements = [];
  portable._placeBlock = async (item, block) => { placements.push([item, block]); return { ok: true, position: { x: 1, y: 63, z: 0 } }; };
  assert.equal((await portable._ensureCraftingTable()).placed, true);
  assert.deepEqual(placements, [['crafting_table', 'crafting_table']]);

  const bare = flatAdapter({ inventory: {} });
  assert.deepEqual(await bare._ensureCraftingTable(), { ok: false, error: 'no_crafting_table' });
});

test('_travelKit si ferma e lo segnala se serve un tavolo e non ce n\'è nessuno', async () => {
  const adapter = flatAdapter({ inventory: { oak_planks: 4, stick: 2 } });
  adapter._craftItem = async () => { throw new Error('non deve arrivare al craft'); };
  adapter._travelReadiness = () => ({ ready: false, items: {}, missing: ['sword'] });
  const result = await adapter._travelKit();
  assert.deepEqual(result.failed, [{ item: 'wooden_sword', error: 'no_crafting_table' }]);
  assert.equal(result.ok, false);
});

test('_travelKit si ferma al primo craft fallito e lo riporta', async () => {
  const adapter = flatAdapter({ inventory: { oak_log: 4 } });
  adapter._craftItem = async (item) => {
    if (item === 'oak_planks') { adapter.inventory[item] = (adapter.inventory[item] || 0) + 4; return { ok: true }; }
    return { ok: false, error: 'missing_ingredients' };
  };
  adapter._travelReadiness = () => ({ ready: false, items: {}, missing: ['craftingTable'] });
  const result = await adapter._travelKit();
  assert.deepEqual(result.failed, [{ item: 'stick', error: 'missing_ingredients' }]);
  assert.equal(result.ok, false);
});

test('_travelKit registra anche un craft che solleva un\'eccezione', async () => {
  const adapter = flatAdapter({ inventory: { oak_log: 4 } });
  adapter._ensureCraftingTable = async () => ({ ok: true, placed: true });
  adapter._craftItem = async () => { throw new Error('boom'); };
  adapter._travelReadiness = () => ({ ready: false, items: {}, missing: ['sword'] });
  const result = await adapter._travelKit();
  assert.deepEqual(result.failed, [{ item: 'oak_planks', error: 'boom' }]);
});

test('_travelKit non ricrafta quello che c\'è già (idempotente)', async () => {
  const adapter = flatAdapter({ inventory: { oak_planks: 4, stick: 2, wooden_sword: 1, crafting_table: 1, torch: 2, white_wool: 3, bed: 1 } });
  adapter._craftItem = async () => { throw new Error('non deve craftare nulla'); };
  const result = await adapter._travelKit();
  assert.deepEqual(result.crafted, []);
  assert.deepEqual(result.failed, []);
});

// ---- pillar-up ---------------------------------------------------------------------

test('_pillarUp piazza un blocco nella cella dei piedi e ci sale sopra', async () => {
  const adapter = flatAdapter({ inventory: { cobblestone: 4 } });
  const calls = stubPlace(adapter);
  const result = await adapter._pillarUp({ blocks: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.climbed, 2);
  assert.deepEqual(calls.map(c => c.target), [{ x: 0, y: 63, z: 0 }, { x: 0, y: 64, z: 0 }]);
  assert.deepEqual(calls.map(c => c.support), [{ x: 0, y: 62, z: 0 }, { x: 0, y: 63, z: 0 }]);
  assert.ok(calls.every(c => c.face === 1), 'la faccia alta del supporto');
  assert.equal(result.y, 65);
});

test('_pillarUp fallisce in modo tipizzato: senza blocchi, senza supporto, senza salto', async () => {
  const bare = flatAdapter();
  assert.equal((await bare._pillarUp({})).error, 'no_placeable_block');

  const adapter = flatAdapter({ inventory: { cobblestone: 4 } });
  stubPlace(adapter);
  adapter.world.blockAt = () => ({ name: 'air', boundingBox: 'empty' }); // niente pavimento
  assert.equal((await adapter._pillarUp({})).error, 'no_support');

  const jumper = flatAdapter({ inventory: { cobblestone: 4 } });
  stubPlace(jumper);
  jumper._jumpOnce = async () => false;
  const jumpless = await jumper._pillarUp({});
  assert.equal(jumpless.error, 'jump_failed');
  assert.equal(jumpless.steps.at(-1).error, 'jump_failed');
});

test('_pillarUp si ferma se il piazzamento non è confermato e se i blocchi finiscono', async () => {
  const failing = flatAdapter({ inventory: { cobblestone: 4 } });
  stubPlace(failing, { fail: 'place_not_confirmed' });
  const failed = await failing._pillarUp({});
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'place_not_confirmed');

  const short = flatAdapter({ inventory: { cobblestone: 1 } });
  stubPlace(short);
  const out = await short._pillarUp({ blocks: 3 });
  assert.equal(out.error, 'out_of_blocks');
  assert.equal(out.steps.filter(s => s.ok).length, 1);
});

// ---- rifugio provvisorio -----------------------------------------------------------

test('_buildHut alza 4 muri (piedi+testa) e 4 blocchi di tetto', async () => {
  const adapter = flatAdapter({ inventory: { cobblestone: 20 } });
  const calls = stubPlace(adapter);
  const result = await adapter._buildHut();
  assert.equal(result.ok, true);
  assert.equal(result.already, false);
  assert.equal(result.placed.length, 12);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.placed.filter(p => p.label === 'wall_feet').map(p => p.position.y), [63, 63, 63, 63]);
  assert.deepEqual(result.failed, []);
  // i lati sono i quattro vicini orizzontali della cella del bot
  const sides = calls.filter(c => c.face === 1).map(c => `${c.target.x},${c.target.z}`);
  assert.ok(sides.includes('1,0') && sides.includes('-1,0') && sides.includes('0,1') && sides.includes('0,-1'));
});

test('_buildHut salta le celle già solide e resta un no-op se il riparo esiste', async () => {
  const half = flatAdapter({ inventory: { cobblestone: 20 } });
  stubPlace(half);
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    half.world.set(Math.floor(half._feet.x) + dx, 63, Math.floor(half._feet.z) + dz);
  }
  const partial = await half._buildHut();
  assert.equal(partial.ok, true);
  assert.equal(partial.skipped, 4);
  assert.equal(partial.placed.length, 8);

  const sealed = flatAdapter({ inventory: { cobblestone: 20 } });
  stubPlace(sealed);
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (const y of [63, 64, 65]) sealed.world.set(dx, y, dz);
  }
  const done = await sealed._buildHut();
  assert.equal(done.ok, true);
  assert.equal(done.already, true);
  assert.equal(done.placed.length, 0);
  assert.equal(done.skipped, 12);
});

test('_buildHut riporta hut_incomplete se un piazzamento non passa', async () => {
  const adapter = flatAdapter({ inventory: { cobblestone: 20 } });
  stubPlace(adapter, { fail: 'place_not_confirmed' });
  const result = await adapter._buildHut();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'hut_incomplete');
  assert.equal(result.failed.length, 12);
});

test('_placeableBlock con richest preferisce lo stack più grosso', async () => {
  const adapter = flatAdapter({ inventory: { dirt: 1, oak_planks: 10 } });
  assert.equal(adapter._placeableBlock(), 'dirt');
  assert.equal(adapter._placeableBlock({ richest: true }), 'oak_planks');
  const calls = stubPlace(adapter);
  await adapter._buildHut();
  assert.ok(calls.every(c => c.blockName === 'oak_planks'), 'il rifugio spende lo stack più grosso');
});

test('_findPlacementTarget salta una cella occupata da una torcia', () => {
  const adapter = flatAdapter({ inventory: { crafting_table: 1 } });
  adapter.world.blockAt = ({ x, y, z }) => {
    if (x === 1 && y === 63 && z === 0) return { name: 'torch', boundingBox: 'empty' };
    if (y === 62) return { name: 'stone', boundingBox: 'block' };
    return { name: 'air', boundingBox: 'empty' };
  };
  const spot = adapter._findPlacementTarget('crafting_table');
  assert.notDeepEqual(spot.target, { x: 1, y: 63, z: 0 }, 'la cella con la torcia non è un bersaglio valido');
  assert.equal(spot.target.y, 63);
  assert.equal(Math.max(Math.abs(spot.target.x), Math.abs(spot.target.z)), 1, 'resta nel primo anello');
});

test('_headroom conta le celle libere fino al tetto e _pillarUp si ferma senza spazio', async () => {
  const adapter = flatAdapter({ inventory: { cobblestone: 8 } });
  adapter.world.set(Math.floor(adapter._feet.x), Math.floor(adapter._feet.y + 0.1) + 2, Math.floor(adapter._feet.z));
  assert.equal(adapter._headroom(), 1, 'solo la cella della testa è libera');
  const calls = stubPlace(adapter);
  const res = await adapter._pillarUp({ blocks: 1 });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'no_headroom', 'errore tipizzato invece di un salto impossibile');
  assert.equal(calls.length, 0, 'nessun piazzamento tentato');
});

test('_pillarUp non piazza mentre i piedi sono ancora nella cella', async () => {
  const adapter = flatAdapter({ inventory: { cobblestone: 8 } });
  const calls = stubPlace(adapter);
  adapter._jumpOnce = async () => { adapter._onGround = false; return true; }; // salto che non alza i piedi
  const res = await adapter._pillarUp({ blocks: 1, timeoutMs: 6000 });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'jump_failed', 'il piazzamento è rimandato finché la cella è occupata dal corpo');
  assert.equal(calls.length, 0, 'nessuna transazione inviata dentro il giocatore');
});

// ---- salto a comando (canale dedicato, fuori dal pathfinder) ------------------------

test('_jumpOnce senza percorso usa _freeJump e non sovrascrive _motion', async () => {
  const adapter = flatAdapter({});
  const jump = adapter._jumpOnce(1500);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(adapter._motion, null, 'il movimento del pathfinder resta intatto');
  assert.equal(adapter._freeJump?.queued, true, 'salto in coda sul canale dedicato');
  adapter._onGround = false; // il salto è partito
  assert.equal(await jump, true);
  assert.equal(adapter._freeJump, null, 'canale liberato alla fine');
});

test('_jumpOnce con un percorso attivo arma quel percorso senza sostituirlo', async () => {
  const adapter = flatAdapter({});
  const motion = {
    active: true, forward: false, yaw: 0, path: [{ x: 0, y: 63, z: 0 }], index: 0,
    target: { x: 0.5, y: 63, z: 0.5 }, stopDistance: 1, deadline: Date.now() + 5000, resolve: null,
    jumpQueued: false, jumpHeldTicks: 0, jumpStart: false,
  };
  adapter._motion = motion;
  const jump = adapter._jumpOnce(1500);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(adapter._motion, motion, '_motion resta lo stesso oggetto (target/path intatti)');
  assert.equal(motion.jumpQueued, true, 'salto delegato al percorso');
  adapter._onGround = false;
  assert.equal(await jump, true);
  assert.equal(adapter._freeJump, null, 'nessun canale libero in parallelo');
});

test('_physicsStep consuma il salto libero anche senza _motion', () => {
  const adapter = flatAdapter({});
  adapter._velocity = { x: 0, y: 0, z: 0 };
  adapter._freeJump = { queued: true, heldTicks: 6, start: true };
  adapter._onGround = true;
  assert.doesNotThrow(() => adapter._physicsStep(), 'senza percorso la fisica non deve lanciare');
  assert.equal(adapter._onGround, false, 'il salto stacca da terra');
  assert.ok(adapter._velocity.y > 0, 'impulso verticale verso l\'alto');
  assert.equal(adapter._freeJump.queued, false, 'consumato una volta sola');
});

test('_sendAuthInput dichiara il salto libero con i flag del percorso', () => {
  const adapter = flatAdapter({});
  const packets = [];
  adapter.client.write = (name, data) => packets.push({ name, data });
  adapter._freeJump = { queued: false, heldTicks: 6, start: true };
  adapter._sendAuthInput({ yaw: 0, pitch: 0 });
  const input = packets.find(p => p.name === 'player_auth_input')?.data?.input_data ?? [];
  assert.ok(input.includes('jumping') && input.includes('want_up'), 'flag di salto presenti');
  assert.ok(input.includes('start_jumping'), 'avvio del salto dichiarato');
  assert.equal(adapter._freeJump.start, false, 'start_jumping si dichiara una volta sola');
});

// ---- opzioni -----------------------------------------------------------------------

test('options offre travel_kit, pillar_up e build_hut solo quando servono', () => {
  const adapter = flatAdapter({ inventory: { oak_log: 4, cobblestone: 8 } });
  adapter._isNight = () => false;
  adapter._hostiles = () => [];
  let keys = adapter.options().map(o => o.key);
  assert.ok(keys.includes('travel_kit'), 'c\'è un pezzo del kit da craftare');
  assert.ok(keys.includes('pillar_up'), 'a terra e con un blocco piazzabile');
  assert.equal(keys.includes('build_hut'), false, 'giorno e nessun ostile');

  adapter._isNight = () => true;
  keys = adapter.options().map(o => o.key);
  assert.ok(keys.includes('build_hut'));

  const airborne = flatAdapter({ inventory: { cobblestone: 8 } });
  airborne._onGround = false;
  airborne._isNight = () => false;
  airborne._hostiles = () => [];
  assert.equal(airborne.options().map(o => o.key).includes('pillar_up'), false);

  const noBlocks = flatAdapter({ inventory: { white_wool: 3 } });
  noBlocks._isNight = () => false;
  noBlocks._hostiles = () => [];
  const noBlockKeys = noBlocks.options().map(o => o.key);
  assert.equal(noBlockKeys.includes('pillar_up'), false);
  assert.equal(noBlockKeys.includes('build_hut'), false);
});
