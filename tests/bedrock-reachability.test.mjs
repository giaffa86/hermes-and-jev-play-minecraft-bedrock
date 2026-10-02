import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

const AIR = { name: 'air', boundingBox: 'empty' };
const STONE = { name: 'stone', boundingBox: 'block', diggable: true, hardness: 1.5, material: 'mineable/pickaxe' };

// Mondo minimo: un piano di blocchi solidi con `height` celle d'aria sopra.
function flatWorld ({ minX = 0, maxX = 4, minZ = 0, maxZ = 0, floorY = 70, height = 4 } = {}) {
  const map = new Map();
  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z <= maxZ; z++) {
      for (let y = floorY + 1; y <= floorY + height; y++) map.set(`${x},${y},${z}`, AIR);
      map.set(`${x},${floorY},${z}`, STONE);
    }
  }
  return {
    map,
    blockAt: ({ x, y, z }) => map.get(`${x},${y},${z}`) ?? null,
    findBlocks: () => [],
    set: (x, y, z, block) => map.set(`${x},${y},${z}`, block),
  };
}

function reachAdapter (world, { feet = { x: 0.5, y: 71, z: 0.5 } } = {}) {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.position = { x: feet.x, y: feet.y + 1.62, z: feet.z };
  adapter._feet = { ...feet };
  adapter.nearbyBlocks = {};
  adapter.inventory = {};
  adapter.world = world;
  return adapter;
}

test('reachableCells copre il piano calpestabile ed esclude una tasca isolata', () => {
  const world = flatWorld({ minX: 0, maxX: 4, minZ: 0, maxZ: 0 });
  // Tasca isolata a x=8: piano e aria, ma separata dal piano principale.
  world.set(8, 70, 0, STONE);
  world.set(8, 71, 0, AIR);
  world.set(8, 72, 0, AIR);
  const adapter = reachAdapter(world);

  const reach = adapter.reachableCells();
  assert.deepEqual(reach.start, { x: 0, y: 71, z: 0 });
  assert.equal(reach.truncated, false);
  for (let x = 0; x <= 4; x++) {
    assert.ok(reach.cells.has(`${x},71,0`), `cella ${x} raggiungibile`);
  }
  assert.equal(reach.cells.has('8,71,0'), false, 'tasca isolata fuori dal componente');
  assert.equal(adapter.cellReachable({ x: 3.5, y: 71.9, z: 0.5 }), true, 'floor delle coordinate');
  assert.equal(adapter.cellReachable({ x: 8, y: 71, z: 0 }), false);
});

test('reachableCells è in cache per il nodo corrente e ricalcola al movimento', () => {
  const world = flatWorld({ minX: 0, maxX: 4, minZ: 0, maxZ: 0 });
  const adapter = reachAdapter(world);
  const first = adapter.reachableCells();
  assert.equal(adapter.reachableCells(), first, 'stesso componente riusato dalla cache');
  assert.equal(adapter._reachCache.startKey, '0,71,0');

  adapter._feet = { x: 3.5, y: 71, z: 0.5 };
  const moved = adapter.reachableCells();
  assert.equal(moved.start.x, 3, 'nuovo nodo di partenza');
  assert.notEqual(moved, first);
});

test('dropReachable accetta un drop sul piano e rifiuta quello in una cavità sotto il pavimento', () => {
  // Riproduce la geometria live: piano di assi a y=72, bot con i piedi a y=73,
  // terreno a y=70 e cavità d\'aria a y=71 sotto le assi.
  const world = flatWorld({ minX: 0, maxX: 4, minZ: 0, maxZ: 0, floorY: 72, height: 3 });
  for (let x = 0; x <= 4; x++) {
    world.set(x, 71, 0, AIR);
    world.set(x, 70, 0, STONE);
  }
  const adapter = reachAdapter(world, { feet: { x: 2.5, y: 73, z: 0.5 } });
  assert.ok(adapter.reachableCells().cells.has('2,73,0'), 'bot sulle assi');

  assert.equal(
    adapter.dropReachable({ x: 2.5, y: 71.125, z: 0.5 }),
    false,
    'drop nella cavità: 2 blocchi sotto i piedi e cella coperta dalle assi',
  );
  assert.equal(adapter.dropReachable({ x: 3.5, y: 73.02, z: 0.5 }), true, 'drop sulle assi');
  assert.equal(adapter.dropReachable({ x: 2.5, y: 69.02, z: 0.5 }), false, 'drop sotto il terreno');

  // Fuori dal bordo delle assi la colonna è aperta: il bot può scendere.
  world.set(5, 74, 0, AIR);
  world.set(5, 73, 0, AIR);
  world.set(5, 72, 0, AIR);
  world.set(5, 71, 0, AIR);
  world.set(5, 70, 0, STONE);
  adapter._reachCache = null;
  assert.equal(adapter.dropReachable({ x: 5.5, y: 71.02, z: 0.5 }), true, 'colonna aperta a lato');
});

test('mineDropReachable valuta la cella d\'arrivo con il blocco già rimosso', () => {
  const world = flatWorld({ minX: 0, maxX: 4, minZ: 0, maxZ: 0 });
  world.set(3, 71, 0, STONE);
  const adapter = reachAdapter(world);
  assert.equal(adapter.mineDropReachable({ x: 3, y: 71, z: 0 }), true, 'blocco scavabile dentro il componente');
  assert.equal(adapter.mineDropReachable({ x: 3, y: 70, z: 0 }), false, 'sotto il blocco non c\'è piano d\'appoggio');

  // Blocco con il tetto solido: scavandolo resta una celletta chiusa.
  const sealed = flatWorld({ minX: 0, maxX: 4, minZ: 0, maxZ: 0 });
  sealed.set(3, 71, 0, STONE);
  sealed.set(3, 72, 0, STONE);
  sealed.set(2, 71, 0, STONE);
  sealed.set(3, 71, 1, STONE);
  sealed.set(3, 71, -1, STONE);
  const sealedAdapter = reachAdapter(sealed);
  assert.equal(sealedAdapter.mineDropReachable({ x: 3, y: 71, z: 0 }), false, 'cella d\'arrivo sigillata');
});

test('options non offre collect_drop per un drop irraggiungibile', () => {
  const world = flatWorld({ minX: 0, maxX: 4, minZ: 0, maxZ: 0, floorY: 72, height: 3 });
  for (let x = 0; x <= 4; x++) {
    world.set(x, 71, 0, AIR);
    world.set(x, 70, 0, STONE);
  }
  const adapter = reachAdapter(world, { feet: { x: 2.5, y: 73, z: 0.5 } });
  adapter.plan = { targets: {} };
  adapter.drops = [{ id: 'trap', item: 'dirt', count: 1, position: { x: 2.5, y: 71.125, z: 0.5 }, spawnedAt: Date.now() }];
  let keys = adapter.options().map(o => o.key);
  assert.equal(keys.includes('collect_drop'), false, 'drop in cavità non offerto');

  adapter.drops = [{ id: 'ok', item: 'dirt', count: 1, position: { x: 3.5, y: 73.02, z: 0.5 }, spawnedAt: Date.now() }];
  keys = adapter.options().map(o => o.key);
  assert.equal(keys.includes('collect_drop'), true, 'drop raggiungibile offerto');
});

test('options non offre di scavare un blocco il cui drop resterebbe irraggiungibile', () => {
  const world = flatWorld({ minX: 0, maxX: 4, minZ: 0, maxZ: 0 });
  const adapter = reachAdapter(world);
  // Il piano sotto i piedi non lascia appoggio al drop dopo lo scavo.
  adapter.nearbyBlocks = {
    stone: [{ name: 'stone', position: { x: 0, y: 70, z: 0 }, distance: 0.5, diggable: true }],
  };
  assert.equal(adapter.options().map(o => o.key).includes('mine_stone'), false);

  // Un blocco scavabile accanto al bot, con appoggio sotto: offerto.
  world.set(1, 71, 0, STONE);
  adapter.nearbyBlocks = {
    stone: [{ name: 'stone', position: { x: 0, y: 70, z: 0 }, distance: 0.5, diggable: true },
            { name: 'stone', position: { x: 1, y: 71, z: 0 }, distance: 1.2, diggable: true }],
  };
  adapter._pickMineTarget = blocks => blocks[1];
  assert.equal(adapter.options().map(o => o.key).includes('mine_stone'), true);
});

test('_collectDrop fallisce subito (drop_unreachable) senza muoversi', async () => {
  const world = flatWorld({ minX: 0, maxX: 4, minZ: 0, maxZ: 0, floorY: 72, height: 3 });
  for (let x = 0; x <= 4; x++) {
    world.set(x, 71, 0, AIR);
    world.set(x, 70, 0, STONE);
  }
  const adapter = reachAdapter(world, { feet: { x: 2.5, y: 73, z: 0.5 } });
  adapter.drops = [{ id: 'trap', item: 'dirt', count: 1, position: { x: 2.5, y: 71.125, z: 0.5 } }];
  let moves = 0;
  adapter._moveTo = async () => { moves++; return { ok: true }; };

  const result = await adapter._collectDrop(20000);
  assert.deepEqual(result.error, 'drop_unreachable');
  assert.equal(result.item, 'dirt');
  assert.equal(moves, 0, 'nessun tentativo di movimento');
  assert.ok(adapter.drops[0].failedAt, 'drop marchiato come fallito');
});

test('_readContainers salta i contenitori fuori dal componente raggiungibile', async () => {
  const world = flatWorld({ minX: 0, maxX: 4, minZ: 0, maxZ: 0 });
  world.findBlocks = name => (name === 'chest' ? [{ name: 'chest', position: { x: 20, y: 71, z: 0 }, distance: 16 }] : []);
  const adapter = reachAdapter(world);
  let moves = 0;
  adapter._moveTo = async () => { moves++; return { ok: true }; };

  const result = await adapter._readContainers();
  assert.equal(result.error, 'container_unreachable');
  assert.equal(result.containers.length, 1);
  assert.equal(moves, 0, 'nessuna apertura tentata');
  await assert.rejects(() => adapter._ensureStorageOpen({ name: 'chest', position: { x: 20, y: 71, z: 0 } }), /storage_unreachable/);
});

test('senza modello del mondo affidabile i filtri si disattivano (fail-open)', () => {
  const empty = { blockAt: () => null, findBlocks: () => [] };
  const adapter = reachAdapter(empty, { feet: { x: 0.5, y: 71, z: 0.5 } });
  assert.equal(adapter.reachableCells().cells.size, 1, 'componente degenere');
  assert.equal(adapter._reachabilityUsable(), false);
  adapter.drops = [{ id: 'a', item: 'dirt', count: 1, position: { x: 40, y: 20, z: 40 }, spawnedAt: Date.now() }];
  assert.equal(adapter.dropReachable(adapter.drops[0].position), false, 'nessuna cella calpestabile vicina');
  assert.equal(adapter._nearestDrop({ reachableOnly: true })?.id, 'a', 'drop comunque offerto: il modello del mondo è inattendibile');
});

test('reachReport riassume il componente per la diagnosi', () => {
  const world = flatWorld({ minX: 0, maxX: 2, minZ: 0, maxZ: 1 });
  const adapter = reachAdapter(world);
  const report = adapter.reachReport({ maxCells: 2 });
  assert.equal(report.count, 6, '3x2 celle calpestabili');
  assert.equal(report.truncated, false);
  assert.deepEqual(report.bounds.min, { x: 0, y: 71, z: 0 });
  assert.deepEqual(report.bounds.max, { x: 2, y: 71, z: 1 });
  assert.equal(report.cells.length, 2, 'elenco troncato per la risposta HTTP');
  assert.deepEqual(report.start, { x: 0, y: 71, z: 0 });
});

test('entityApproachable filtra le entità fuori dal componente', () => {
  const world = flatWorld({ minX: 0, maxX: 4 });
  const adapter = reachAdapter(world);
  assert.equal(adapter.entityApproachable({ position: { x: 1.5, y: 71, z: 0.5 } }), true);
  assert.equal(adapter.entityApproachable({ position: { x: 40.5, y: 71, z: 40.5 } }), false);
  assert.equal(adapter.entityApproachable({}), true, 'posizione ignota: fail-open');
});

test('options non offre caccia/monta per animali irraggiungibili', () => {
  const world = flatWorld({ minX: 0, maxX: 4 });
  const adapter = reachAdapter(world);
  adapter.drops = [];
  adapter.plan = { targets: {} };
  adapter._nearbyFarmAnimals = () => [{ type: 'cow', position: { x: 40, y: 71, z: 40 }, distance: 39, baby: false }];
  adapter._nearbyRideable = () => [{ type: 'donkey', position: { x: 40, y: 71, z: 40 }, distance: 39 }];
  let keys = adapter.options().map(o => o.key);
  assert.equal(keys.includes('attack_cow'), false, 'animale irraggiungibile non offerto');
  assert.equal(keys.includes('mount_donkey'), false, 'mezzo irraggiungibile non offerto');

  adapter._nearbyFarmAnimals = () => [{ type: 'cow', position: { x: 3, y: 71, z: 0 }, distance: 2.5, baby: false }];
  adapter._nearbyRideable = () => [{ type: 'donkey', position: { x: 3, y: 71, z: 0 }, distance: 2.5 }];
  keys = adapter.options().map(o => o.key);
  assert.equal(keys.includes('attack_cow'), true, 'animale a tiro offerto');
  assert.equal(keys.includes('mount_donkey'), true, 'mezzo a tiro offerto');
});

test('_flee ignora destinazioni fuori dal componente raggiungibile', async () => {
  const world = flatWorld({ minX: 0, maxX: 4 });
  const adapter = reachAdapter(world);
  adapter._hostiles = () => [{ type: 'zombie', position: { x: 8.5, y: 71, z: 0.5 }, distance: 8 }];
  adapter._standableNear = () => ({ x: 20, y: 71, z: 0 });
  let moves = 0;
  adapter._moveTo = async () => { moves++; return { ok: true }; };

  const stuck = await adapter._flee(200);
  assert.equal(stuck.ok, false);
  assert.match(stuck.error, /^flee_failed/);
  assert.equal(moves, 0, 'nessun move verso una cella irraggiungibile');

  adapter._standableNear = () => ({ x: 3, y: 71, z: 0 });
  const fled = await adapter._flee(2000);
  assert.equal(fled.ok, true);
  assert.equal(moves, 1);
  assert.equal(fled.from, 'zombie');
});

test('commercio e leveling non offerti con un trader irraggiungibile', async () => {
  const world = flatWorld({ minX: 0, maxX: 4 });
  const adapter = reachAdapter(world);
  adapter.drops = [];
  adapter.plan = { targets: {} };
  const trader = (position, distance) => [{ type: 'villager_v2', profession: 'farmer', position, distance, tradeTier: 0, maxTradeTier: 4 }];
  adapter._nearbyTraders = () => trader({ x: 40, y: 71, z: 40 }, 39);
  let keys = adapter.options().map(o => o.key);
  assert.equal(keys.some(k => k.startsWith('level_')), false, 'level_farmer non offerto');
  assert.equal(keys.includes('open_trade'), false, 'open_trade non offerto');
  const res = await adapter._levelTrader({ profession: 'farmer' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'trader_unreachable');

  adapter._nearbyTraders = () => trader({ x: 3, y: 71, z: 0 }, 2.5);
  keys = adapter.options().map(o => o.key);
  assert.equal(keys.includes('level_farmer'), true, 'trader a tiro offerto');
});

test('il pickup automatico salta un drop in una tasca irraggiungibile senza spendere move', async () => {
  // Geometria live: assi a y=72 (il bot ci sta sopra), cavità d'aria a y=71,
  // terreno a y=70. Il drop del mining finisce nella cavità, sotto le assi.
  const world = flatWorld({ minX: 0, maxX: 4, minZ: 0, maxZ: 0, floorY: 72, height: 3 });
  for (let x = 0; x <= 4; x++) {
    world.set(x, 71, 0, AIR);
    world.set(x, 70, 0, STONE);
  }
  const adapter = reachAdapter(world, { feet: { x: 2.5, y: 73, z: 0.5 } });
  adapter.drops = [{ id: 'trap', item: 'dirt', count: 1, position: { x: 2.5, y: 71.125, z: 0.5 }, spawnedAt: Date.now() }];
  const logs = [];
  adapter.log = (type, data) => logs.push({ type, ...data });
  let moves = 0;
  adapter._moveTo = async () => { moves++; return { ok: true }; };

  const picked = await adapter._pickupNearby();
  assert.deepEqual(picked, [], 'niente raccolto');
  assert.equal(moves, 0, 'nessun tentativo di movimento verso la cavità');
  assert.ok(adapter.drops[0].failedAt > 0, 'drop marchiato: non ritentato subito');
  const skipped = logs.find(e => e.type === 'pickup_skipped');
  assert.ok(skipped, 'il motivo del mancato pickup finisce nel log');
  assert.equal(skipped.reason, 'unreachable');
  assert.equal(skipped.item, 'dirt');
  assert.equal(skipped.skipped, 1);
});

test('il pickup automatico raccoglie il drop raggiungibile e ignora quello imprigionato', async () => {
  const world = flatWorld({ minX: 0, maxX: 4, minZ: 0, maxZ: 0, floorY: 72, height: 3 });
  for (let x = 0; x <= 4; x++) {
    world.set(x, 71, 0, AIR);
    world.set(x, 70, 0, STONE);
  }
  const adapter = reachAdapter(world, { feet: { x: 2.5, y: 73, z: 0.5 } });
  adapter.drops = [
    { id: 'trap', item: 'dirt', count: 1, position: { x: 2.5, y: 71.125, z: 0.5 }, spawnedAt: Date.now() },
    { id: 'ok', item: 'dirt', count: 1, position: { x: 3.5, y: 73.02, z: 0.5 }, spawnedAt: Date.now() },
  ];
  const logs = [];
  adapter.log = (type, data) => logs.push({ type, ...data });
  let moves = 0;
  // Il server conferma la raccolta rimuovendo l'item entity.
  adapter._moveTo = async () => { moves++; adapter.drops = adapter.drops.filter(d => d.id !== 'ok'); return { ok: true }; };

  const picked = await adapter._pickupNearby();
  assert.deepEqual(picked, [{ item: 'dirt', count: 1 }], 'raccolto il drop raggiungibile');
  assert.equal(moves, 1, 'un solo movimento, verso il drop raggiungibile');
  assert.ok(logs.some(e => e.type === 'pickup' && e.item === 'dirt'), 'pickup loggato');
  // Al giro successivo (limit 2) resta solo il drop imprigionato: viene segnalato
  // e marchiato, senza tentare un movimento inutile.
  const skipped = logs.find(e => e.type === 'pickup_skipped');
  assert.ok(skipped, 'il drop imprigionato viene segnalato come skip');
  assert.equal(skipped.skipped, 1);
  assert.ok(adapter.drops.find(d => d.id === 'trap').failedAt > 0, 'drop imprigionato marchiato');
});
