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

// --- N2: senza acqua la caduta è più corta, e l'atterraggio non fa danno ----

const MAGMA = { name: 'magma', boundingBox: 'block', diggable: true };

// Altopiano di pietra a y=74 (x 0..2) sopra il pavimento di `flatWorld`: dal
// bordo si può solo cadere, quattro blocchi sotto c'è il piano.
function plateauWorld ({ landing = STONE } = {}) {
  const world = flatWorld({ minX: 0, maxX: 5, minZ: 0, maxZ: 0, floorY: 70, height: 8 });
  for (let x = 0; x <= 2; x++) world.set(x, 74, 0, STONE);
  if (landing !== STONE) world.set(3, 70, 0, landing);
  return world;
}

const plateauAdapter = (world, dimension) => {
  const adapter = reachAdapter(world, { feet: { x: 2.5, y: 75, z: 0.5 } });
  adapter.dimension = dimension;
  return adapter;
};

test('la caduta permessa dipende dalla dimensione: quattro blocchi in Overworld, due nel Nether', () => {
  const world = plateauWorld();
  const overworld = plateauAdapter(world, 'overworld');
  const nether = plateauAdapter(world, 'nether');

  const steps = (adapter) => [...adapter._neighbors({ x: 2, y: 75, z: 0 })];
  const down = steps(overworld).filter(s => s.x === 3);

  assert.deepEqual(down, [{ x: 3, y: 71, z: 0, cost: 1 + 4 * 0.5 }], 'in Overworld si scende di quattro blocchi');
  assert.deepEqual(steps(nether).filter(s => s.x === 3), [], 'nel Nether (senza acqua) no: la caduta lunga è una condanna');
  assert.equal(nether._netherView().maxFall, 2);
  assert.equal(overworld._netherView().maxFall, 4);
});

test('un atterraggio su magma non è mai una destinazione del pathfinding', () => {
  const world = plateauWorld({ landing: MAGMA });
  const adapter = plateauAdapter(world, 'overworld');

  assert.equal(adapter._standable(3, 71, 0), false, 'appoggio che fa danno');
  assert.deepEqual([...adapter._neighbors({ x: 2, y: 75, z: 0 })].filter(s => s.x === 3), [], 'nessun passo verso il magma');
  assert.equal(adapter._standable(2, 75, 0), true, 'sull\'altopiano di pietra si sta');
});

test('placeReach distingue una destinazione della memoria camminabile da una isolata', () => {
  const world = flatWorld({ minX: 0, maxX: 4, minZ: 0, maxZ: 0 });
  // Tasca isolata a x=8, come nel test del componente.
  world.set(8, 70, 0, STONE);
  world.set(8, 71, 0, AIR);
  world.set(8, 72, 0, AIR);
  const adapter = reachAdapter(world);

  assert.deepEqual(adapter.placeReach({ x: 3, y: 71, z: 0 }), { reachable: true, reason: 'cell', distance: 2.5 });
  assert.equal(adapter.placeReach({ x: 8, y: 71, z: 0 }).reachable, false);
  assert.equal(adapter.placeReach({ x: 8, y: 71, z: 0 }).reason, 'unreachable');
  assert.deepEqual(adapter.placeReach(null), { reachable: false, reason: 'no_position', distance: null });
  assert.deepEqual(adapter.placeReach({ x: NaN, y: 71, z: 0 }), { reachable: false, reason: 'no_position', distance: null });

  // Fail-open: un mondo senza colonne caricate non è una prova di
  // irraggiungibilità, quindi la destinazione resta candidabile.
  const blind = reachAdapter({ map: new Map(), blockAt: () => null, findBlocks: () => [] });
  const verdict = blind.placeReach({ x: 42, y: 70, z: 42 });
  assert.equal(verdict.reachable, true);
  assert.equal(verdict.reason, 'reachability_unknown');
});

test('placeCandidate promuove solo un luogo confermato camminabile', () => {
  const world = flatWorld({ minX: 0, maxX: 6, minZ: 0, maxZ: 0 });
  // Tasca isolata a x=12: calpestabile ma fuori dal componente.
  world.set(12, 70, 0, STONE);
  world.set(12, 71, 0, AIR);
  world.set(12, 72, 0, AIR);
  const adapter = reachAdapter(world);
  const hits = [
    { id: 'far_cave', position: { x: 12, y: 71, z: 0 } },
    { id: 'near_patch', position: { x: 5, y: 71, z: 0 } },
  ];

  const pick = adapter.placeCandidate(hits);
  assert.equal(pick.reason, null);
  assert.equal(pick.candidate.id, 'near_patch', 'il primo hit confermato, non il primo in assoluto');
  assert.equal(pick.hits[0].reachability.reachable, false);
  assert.equal(pick.hits[0].reachability.reason, 'unreachable');
  assert.equal(pick.hits[1].reachability.reason, 'cell');

  // Solo luoghi isolati: nessun candidato e il motivo lo dice.
  assert.deepEqual(adapter.placeCandidate([hits[0]]).candidate, null);
  assert.equal(adapter.placeCandidate([hits[0]]).reason, 'all_unreachable');
  assert.equal(adapter.placeCandidate([]).reason, 'no_hits');

  // Reachability ignota (mondo senza colonne caricate): **non** è una conferma,
  // perché un luogo nuovo non si sceglie su una stima.
  const blind = reachAdapter({ map: new Map(), blockAt: () => null, findBlocks: () => [] });
  const blindPick = blind.placeCandidate([{ id: 'unknown_cave', position: { x: 3, y: 71, z: 0 } }]);
  assert.equal(blindPick.candidate, null);
  assert.equal(blindPick.reason, 'reachability_unknown');
  assert.equal(blindPick.hits[0].reachability.detail.cells, 1, 'il dettaglio spiega perché il verdetto manca');
});

// Dal vivo (03/10) il bot è rimasto chiuso in casa perché il corridoio verso la
// porta è coperto da due `green_carpet`: il registry li riporta come
// `boundingBox: 'block'`, ma il giocatore ci cammina sopra. Il tappeto è
// pavimento, non muro — sia nel pathfinding sia nella fisica locale.
test('un corridoio di tappeti è percorribile: il tappeto è pavimento, non muro', () => {
  const world = flatWorld({ minX: 0, maxX: 4, minZ: 0, maxZ: 0, floorY: 72, height: 3 });
  world.set(1, 73, 0, { name: 'green_carpet', boundingBox: 'block' });
  world.set(2, 73, 0, { name: 'green_carpet', boundingBox: 'block' });
  const adapter = reachAdapter(world, { feet: { x: 0.5, y: 73, z: 0.5 } });

  assert.equal(adapter._standable(1, 73, 0), true, 'la cella del tappeto è calpestabile');
  assert.equal(adapter._standableWhy(1, 73, 0).reason, 'ok');
  assert.equal(adapter._solidAt(1, 73, 0), false, 'nella fisica locale il tappeto non ferma il passo');

  const reach = adapter.reachableCells();
  assert.ok(reach.cells.has('1,73,0') && reach.cells.has('2,73,0'), 'il corridoio è attraversabile');
  assert.equal(adapter.cellReachable({ x: 3.5, y: 73, z: 0.5 }), true, 'e la cella oltre il corridoio è raggiungibile');
  assert.equal(adapter._reachabilityUsable(), true, 'il componente resta affidabile');
});

test('un tappeto all\'altezza della testa resta un muro, lastre e letti restano muri', () => {
  const head = flatWorld({ minX: 0, maxX: 2, minZ: 0, maxZ: 0, floorY: 72, height: 3 });
  head.set(1, 74, 0, { name: 'green_carpet', boundingBox: 'block' });
  const adapter = reachAdapter(head, { feet: { x: 0.5, y: 73, z: 0.5 } });
  assert.equal(adapter._standable(1, 73, 0), false, 'un tappeto a livello testa blocca');
  assert.equal(adapter._standableWhy(1, 73, 0).reason, 'head');
  assert.equal(adapter.cellReachable({ x: 1.5, y: 73, z: 0.5 }), false);

  // Lastra e letto sono alti 0.5-0.56: servirebbe un salto, che il movimento non
  // modella. Meglio un rifiuto esplicito che una destinazione mai confermata.
  const tall = flatWorld({ minX: 0, maxX: 2, minZ: 0, maxZ: 0, floorY: 72, height: 3 });
  tall.set(1, 73, 0, { name: 'oak_slab', boundingBox: 'block' });
  tall.set(2, 73, 0, { name: 'bed', boundingBox: 'block' });
  const tallAdapter = reachAdapter(tall, { feet: { x: 0.5, y: 73, z: 0.5 } });
  assert.equal(tallAdapter._standable(1, 73, 0), false);
  assert.equal(tallAdapter._standableWhy(1, 73, 0).reason, 'feet');
  assert.equal(tallAdapter._standable(2, 73, 0), false);
  assert.equal(tallAdapter._solidAt(1, 73, 0), true, 'la lastra resta solida nella fisica');
  assert.equal(tallAdapter._solidAt(2, 73, 0), true, 'il letto resta solido nella fisica');
});

test('un tappeto senza pavimento sotto non è un appoggio', () => {
  const world = flatWorld({ minX: 0, maxX: 1, minZ: 0, maxZ: 0, floorY: 72, height: 3 });
  world.set(1, 73, 0, { name: 'green_carpet', boundingBox: 'block' });
  world.set(1, 72, 0, AIR);
  const adapter = reachAdapter(world, { feet: { x: 0.5, y: 73, z: 0.5 } });
  assert.equal(adapter._standable(1, 73, 0), false);
  assert.equal(adapter._standableWhy(1, 73, 0).reason, 'no_floor');
});

// Il bot può trovarsi *dentro* un blocco solido: una porta chiusa da un villager
// addosso (villaggio, 03/10), o una cella che il modello legge come solida mentre
// il server tiene lì il bot. La cella che il corpo occupa già non può fermare il
// passo, altrimenti il bot resta congelato per sempre; le celle che non occupa
// restano muri, porte comprese.
// Il server non lascia muovere il bot fuori da una porta chiusa che lo contiene:
// il movimento locale da solo non basta (provato live il 03/10). Prima si apre la
// porta che il bot ha addosso, con lo stesso click_block della porta davanti.
test('_doorAhead segnala per primo la porta chiusa che il bot ha addosso', () => {
  const door = { name: 'wooden_door', boundingBox: 'block', diggable: true, hardness: 3 };
  const world = flatWorld({ minX: 0, maxX: 3, minZ: 0, maxZ: 1, floorY: 72, height: 3 });
  world.set(1, 73, 0, door);
  world.set(1, 74, 0, door);
  const adapter = reachAdapter(world, { feet: { x: 1.5, y: 73, z: 0.5 } });
  adapter._motion = { active: true, yaw: 0 };
  assert.deepEqual(adapter._doorAhead(), { x: 1, y: 73, z: 0 }, 'la porta occupata è il primo bersaglio');
  // La porta davanti (yaw 0 = +z) viene comunque riconosciuta quando libera.
  world.set(1, 73, 1, door);
  world.set(1, 74, 1, door);
  adapter._openDoors.add('1,73,0');
  adapter._openDoors.add('1,74,0');
  assert.deepEqual(adapter._doorAhead(), { x: 1, y: 73, z: 1 }, 'aperta quella addosso resta la porta davanti');
  // Senza porte chiuse non c'è nulla da aprire (nessun click a vuoto).
  const free = reachAdapter(flatWorld({ minX: 0, maxX: 3, minZ: 0, maxZ: 1, floorY: 72, height: 3 }), { feet: { x: 1.5, y: 73, z: 0.5 } });
  free._motion = { active: true, yaw: 0 };
  assert.equal(free._doorAhead(), null);
});

test('un bot dentro una porta chiusa esce dalla cella che occupa (ma non entra nella porta accanto)', () => {
  const door = { name: 'wooden_door', boundingBox: 'block', diggable: true, hardness: 3 };
  const world = flatWorld({ minX: 0, maxX: 3, minZ: 0, maxZ: 0, floorY: 72, height: 3 });
  // Porta chiusa addosso al bot: piedi e testa nella cella della porta (x=1).
  world.set(1, 73, 0, door);
  world.set(1, 74, 0, door);
  // Seconda porta chiusa a x=2: il bot non la occupa.
  world.set(2, 73, 0, door);
  world.set(2, 74, 0, door);
  const adapter = reachAdapter(world, { feet: { x: 1.5, y: 73, z: 0.5 } });

  // Per il pathfinding una porta è attraversabile (il movimento la aprirebbe con
  // un'interazione), per la fisica locale chiusa è solida: è l'incoerenza che
  // lascia il bot dentro la cella quando la porta si chiude addosso.
  assert.equal(adapter._standable(1, 73, 0), true);
  assert.equal(adapter._solidAt(1, 73, 0), true);
  assert.equal(adapter._collides(1.5, 73, 0.5), true, 'senza eccezione il modello congelerebbe il bot dentro la porta');

  // Con l'eccezione "celle già occupate dal corpo" il bot può uscire...
  assert.equal(adapter._collides(1.1, 73, 0.5, { ignoreSelf: true }), false, 'lo spazio ad ovest è libero');
  const startX = adapter._feet.x;
  for (let i = 0; i < 12; i++) adapter._moveHorizontal(-0.1, 0);
  assert.ok(adapter._feet.x < startX, 'il bot si muove');
  assert.equal(Math.floor(adapter._feet.x), 0, 'ed è uscito dalla cella della porta');

  // ...ma la porta chiusa accanto resta un muro: nessun passaggio attraverso.
  assert.equal(adapter._collides(2.5, 73, 0.5, { ignoreSelf: true }), true, 'una porta non occupata non si attraversa');
  const inside = reachAdapter(world, { feet: { x: 1.5, y: 73, z: 0.5 } });
  for (let i = 0; i < 6; i++) inside._moveHorizontal(0.1, 0);
  assert.equal(Math.floor(inside._feet.x), 1, 'il bot resta nella cella che occupa: non entra nella porta accanto');
});

test('_entityVisible campiona la linea di vista e nomina il blocco che la blocca', () => {
  const world = flatWorld({ minX: 0, maxX: 6, minZ: 0, maxZ: 0 });
  const adapter = reachAdapter(world);
  adapter._trackEntity({ runtime_id: 9n, entity_type: 'minecraft:villager', position: { x: 5, y: 71, z: 0 } }, 'mob');
  const entity = adapter.entities.get('9');

  const clear = adapter._entityVisible(entity);
  assert.equal(clear.visible, true);
  assert.equal(clear.unknown, false);
  assert.equal(clear.blockedBy, null);

  // Un muro nel segmento occhio→petto: l'interazione non ha linea di vista.
  world.set(2, 72, 0, STONE);
  const blocked = adapter._entityVisible(entity);
  assert.equal(blocked.visible, false);
  assert.equal(blocked.blockedBy, 'stone');
  assert.deepEqual(blocked.blockedAt, { x: 2, y: 72, z: 0 });
  assert.equal(typeof blocked.t, 'number');
});

test('_entityVisible è fail-open su un mondo illeggibile', () => {
  const adapter = reachAdapter(flatWorld());
  adapter.world = { blockAt: () => null, findBlocks: () => [] };
  adapter._trackEntity({ runtime_id: 10n, entity_type: 'minecraft:villager', position: { x: 4, y: 71, z: 0 } }, 'mob');
  const unknown = adapter._entityVisible(adapter.entities.get('10'));
  assert.equal(unknown.visible, true, 'un modello incompleto non rifiuta l\'azione');
  assert.equal(unknown.unknown, true);

  assert.equal(adapter._entityVisible(null).visible, true);
  assert.equal(adapter._entityVisible({ type: 'villager', position: { x: 1, y: 1, z: 1 } }).visible, true);
});


test('_entityVisible tests door geometry and every intervening cell', () => {
  const world = flatWorld({ maxX: 8 });
  const adapter = reachAdapter(world);
  const entity = { type: 'villager', position: { x: 7.5, y: 71.72, z: 0.5 } };
  const door = { name: 'wooden_door', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 0.1875]] };
  world.set(1, 72, 0, door);
  assert.equal(adapter._entityVisible(entity).visible, true);
  world.set(1, 72, 0, { ...door, shapes: [[0, 0, 0, 0.1875, 1, 1]] });
  assert.equal(adapter._entityVisible(entity).visible, false);
  world.set(1, 72, 0, AIR);
  world.set(6, 72, 0, STONE);
  assert.deepEqual(adapter._entityVisible(entity).blockedAt, { x: 6, y: 72, z: 0 });
});

// 08/10/2026: in casa il bot non seguiva il giocatore — «la porta era chiusa e non
// riusciva ad aprirla, ho dovuto aprire io per liberarlo». La famiglia apribile
// conteneva solo `*_door`: un cancelletto chiuso non era percorribile per l'A*,
// non veniva mai cliccato e `DIG_PROTECTED` (`_fence_gate$`) vieta di romperlo,
// quindi un recinto con cancello era una gabbia. Questi test tengono fermi i tre
// pezzi: la famiglia, la cella che il percorso attraversa, e il click che non
// richiude una porta che il mondo dice già aperta.
test('un cancello chiuso è una via di uscita, non una gabbia', () => {
  const gate = { name: 'oak_fence_gate', boundingBox: 'block', getProperties: () => ({ open_bit: false }) };
  const world = flatWorld({ minX: 0, maxX: 6, maxZ: 0 });
  world.set(3, 71, 0, gate);
  const adapter = reachAdapter(world, { feet: { x: 2.5, y: 71, z: 0.5 } });
  assert.equal(adapter._isDoorBlock(gate), true, 'il cancelletto entra nella famiglia apribile');
  assert.equal(adapter._passableForPath(gate), true, 'da chiuso si attraversa: il movimento lo apre');
  assert.equal(adapter._standable(3, 71, 0), true, 'la cella del cancelletto resta nel grafo');
  adapter._motion = { active: true, yaw: 180, index: 0, path: [{ x: 3, y: 71, z: 0 }, { x: 4, y: 71, z: 0 }] };
  assert.deepEqual(adapter._doorAhead(), { x: 3, y: 71, z: 0 }, 'il cancelletto è il prossimo nodo: va aperto');
  assert.equal(adapter._doorParts({ x: 3, y: 71, z: 0 }, gate).length, 1, 'occupa una cella sola');
});

test('una botola sotto i piedi non viene aperta camminandoci sopra', () => {
  const trapdoor = { name: 'oak_trapdoor', boundingBox: 'block', getProperties: () => ({ open_bit: false }) };
  const world = flatWorld({ minX: 0, maxX: 3, maxZ: 0 });
  world.set(1, 70, 0, trapdoor); // il pavimento su cui il bot cammina
  const adapter = reachAdapter(world, { feet: { x: 1.5, y: 71, z: 0.5 } });
  adapter._motion = { active: true, yaw: 0, index: 0, path: [{ x: 2, y: 71, z: 0 }] };
  assert.equal(adapter._doorAhead(), null, 'il portello sotto i piedi non è un ostacolo da aprire');
});

test('una porta chiusa davanti si vede anche se lo yaw punta altrove', () => {
  const door = { name: 'oak_door', boundingBox: 'block', getProperties: () => ({ upper_block_bit: false, open_bit: false }) };
  const upper = { name: 'oak_door', boundingBox: 'block', getProperties: () => ({ upper_block_bit: true, open_bit: false }) };
  const world = flatWorld({ minX: 0, maxX: 4, maxZ: 0 });
  world.set(2, 71, 0, door);
  world.set(2, 72, 0, upper);
  const adapter = reachAdapter(world, { feet: { x: 1.5, y: 71, z: 0.5 } });
  // Lo yaw punta a +z (il giocatore è fuori, di lato); la porta è a +x, sul percorso.
  adapter._motion = { active: true, yaw: 0, index: 0, path: [{ x: 2, y: 71, z: 0 }, { x: 3, y: 71, z: 0 }] };
  assert.deepEqual(adapter._doorAhead(), { x: 2, y: 71, z: 0 }, 'il nodo di percorso basta a vedere la porta');
});

test('_doorParts normalizza la metà superiore e parte dalla base', () => {
  const lower = { name: 'oak_door', getProperties: () => ({ upper_block_bit: false, open_bit: false }) };
  const upper = { name: 'oak_door', getProperties: () => ({ upper_block_bit: true, open_bit: false }) };
  const air = { name: 'air', boundingBox: 'empty' };
  const adapter = reachAdapter(flatWorld({ minX: 0, maxX: 1, maxZ: 0 }));
  assert.deepEqual(adapter._doorParts({ x: 1, y: 71, z: 0 }, lower), [{ x: 1, y: 71, z: 0 }, { x: 1, y: 72, z: 0 }]);
  assert.deepEqual(adapter._doorParts({ x: 1, y: 72, z: 0 }, upper), [{ x: 1, y: 71, z: 0 }, { x: 1, y: 72, z: 0 }]);
  assert.deepEqual(adapter._doorParts({ x: 1, y: 71, z: 0 }, air), [{ x: 1, y: 71, z: 0 }], 'un blocco qualsiasi è la sua cella');
});

test('il click non richiude una porta che il mondo dice già aperta', () => {
  const plate = { name: 'wooden_door', boundingBox: 'block' };
  const upper = { ...plate, getProperties: () => ({ upper_block_bit: true, open_bit: false }) };
  const world = flatWorld({ minX: 0, maxX: 3, maxZ: 0 });
  world.set(1, 71, 0, { ...plate, getProperties: () => ({ upper_block_bit: false, open_bit: true }) });
  world.set(1, 72, 0, upper);
  world.runtimeIdAt = () => 42;
  const adapter = reachAdapter(world, { feet: { x: 0.5, y: 71, z: 0.5 } });
  const sent = [];
  adapter._sendAuthInput = input => sent.push(input);
  adapter._driveMotion = () => {};
  adapter._survivalTick = () => {};
  adapter._blockUseTransaction = pos => ({ click: pos });
  const request = () => ({ pos: { x: 1, y: 71, z: 0 }, key: '1,71,0', sent: false, at: Date.now() });
  adapter._motion = { active: true, yaw: -90, index: 0, path: [], useRequest: request() };
  adapter._authTick();
  assert.equal(sent[0].transaction, null, 'nessun click: la porta è già aperta');
  assert.equal(adapter._openDoors.has('1,71,0'), true);
  assert.equal(adapter._openDoors.has('1,72,0'), true, 'la credenza cade su entrambe le metà');

  // Credenza opposta: la porta è chiusa e il click parte, con i due watcher.
  world.set(1, 71, 0, { ...plate, getProperties: () => ({ upper_block_bit: false, open_bit: false }) });
  adapter._openDoors.clear();
  adapter._doorWatchers.clear();
  adapter._motion.useRequest = request();
  adapter._authTick();
  assert.deepEqual(sent[1].transaction, { click: { x: 1, y: 71, z: 0 } }, 'una porta chiusa si clicca');
  assert.equal(adapter._doorWatchers.size, 2, 'si osserva il cambio di entrambe le metà');
});

// Live 08/10/2026 (`diamond-20261009-3`): tre `stuck` davanti a una porta chiusa,
// e nessuna riga che dicesse perché. L'attesa del click è voluta: lo stallo non
// deve dichiararla per primo, e quando scade l'arresto ha un nome.
test('una porta che non si apre nomina il motivo dello `stuck`', () => {
  const world = flatWorld({ minX: 0, maxX: 3, minZ: 0, maxZ: 3 });
  world.set(1, 71, 1, { name: 'wooden_door', boundingBox: 'block', getProperties: () => ({ upper_block_bit: false, open_bit: false }) });
  world.set(1, 72, 1, { name: 'wooden_door', boundingBox: 'block', getProperties: () => ({ upper_block_bit: true, open_bit: false }) });
  const adapter = reachAdapter(world, { feet: { x: 0.5, y: 71, z: 0.5 } });
  const logs = [];
  adapter.log = (type, data) => logs.push({ type, data });
  let finished = null;
  adapter._finishMotion = reason => { finished = reason; };
  adapter._motion = {
    active: true, yaw: 0, index: 0,
    path: [{ x: 1, y: 71, z: 1 }, { x: 2, y: 71, z: 1 }],
    target: { x: 2.5, y: 71, z: 1.5 }, stopDistance: 0.8, deadline: Date.now() + 10000,
    bestTargetDist: Infinity, bestWaypointDist: 1,
    lastTargetProgressAt: Date.now(), lastIndexProgressAt: Date.now(), lastProgressAt: Date.now() - 3000,
    stuckTries: 0,
    useRequest: { pos: { x: 1, y: 71, z: 1 }, key: '1,71,1', sent: true, at: Date.now() - 4000 },
  };
  adapter._updateMotionState();
  const blocked = logs.find(row => row.type === 'door_blocked');
  assert.ok(blocked, 'la porta chiusa è nominata nel ledger');
  assert.deepEqual(blocked.data.position, { x: 1, y: 71, z: 1 });
  assert.equal(blocked.data.waitedMs >= 4000, true, 'il tempo di attesa è riportato');
  assert.deepEqual(blocked.data.from, { x: 0.5, y: 71, z: 0.5 }, 'la posizione del bot è riportata');
  assert.equal(finished, 'stuck');
  assert.equal(adapter._motion.jumpQueued, undefined, 'l\'attesa della porta non fa saltare il bot');
});
