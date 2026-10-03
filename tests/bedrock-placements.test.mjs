// Registro dei propri piazzamenti (R4) e azione `mine_owned`.
// Mondo e memoria finti: il fixture verifica *chi decide la titolarità* — il
// registro, non il nome del blocco — e che il titolo sopravviva a un restart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

const key = (p) => `${p.x},${p.y},${p.z}`;

function placementAdapter ({
  cells = {}, feet = { x: 0.5, y: 71, z: 0.5 }, placements = [], mineResult = null, inventorySlots = [],
} = {}) {
  const memory = {
    records: new Map(placements.map(r => [key(r.position), { ...r, id: `placement_${r.position.x}_${r.position.y}_${r.position.z}` }])),
    rememberPlacement ({ position, block, item = null, circuitId = null, source = 'place', placedAt = null }) {
      const record = {
        id: `placement_${position.x}_${position.y}_${position.z}`,
        kind: 'placement', type: block, item, circuitId, source, placedAt: placedAt ?? 0, position: { ...position },
      };
      this.records.set(key(position), record);
      return record;
    },
    setPlacementCircuit (position, circuitId) {
      const record = this.records.get(key(position));
      if (!record) return null;
      record.circuitId = circuitId;
      return record;
    },
    placements () { return [...this.records.values()]; },
    forgetPlacement (position) { return this.records.delete(key(position)); },
  };

  const adapter = new BedrockAdapter({ logger: { log () {} }, memory });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.dead = false;
  adapter.client = {};
  adapter._feet = { ...feet };
  adapter.position = { x: feet.x, y: feet.y + 1.62, z: feet.z };
  adapter.inventory = {};
  adapter.inventorySlots = inventorySlots;
  adapter.nearbyBlocks = {};
  adapter.plan = null;

  const blocks = new Map();
  const put = (position, name, diggable = true) => blocks.set(key(position), {
    name, position: { ...position }, diggable, hardness: 1,
  });
  for (const [cellKey, value] of Object.entries(cells)) {
    const [x, y, z] = cellKey.split(',').map(Number);
    const name = typeof value === 'string' ? value : value.name;
    const diggable = typeof value === 'string' ? true : (value.diggable ?? true);
    put({ x, y, z }, name, diggable);
  }

  const events = { mined: [], logs: [], placed: [], authInputs: [] };
  adapter.world.loaded = new Map([['0,0', {}]]);
  adapter.world.blockAt = ({ x, y, z }) => blocks.get(key({ x, y, z })) ?? null;
  adapter.world.runtimeIdAt = () => 1;
  adapter.world.findBlocks = () => [];
  // La reachability resta fuori: il fixture non ha un pathfinder e le celle in
  // gioco stanno tutte a portata.
  adapter._reachabilityUsable = () => false;
  adapter.mineDropReachable = () => true;
  adapter._yawTo = () => 0;
  adapter._lookAt = () => ({ yaw: 0, pitch: 0 });
  adapter._refreshNearby = () => {};
  adapter.log = (type, data) => events.logs.push({ type, data });
  adapter._mineBlock = async (block) => {
    events.mined.push(block.name);
    if (typeof mineResult === 'function') return mineResult(block);
    if (mineResult) return mineResult;
    blocks.delete(key(block.position));
    return { ok: true };
  };
  // Server finto per il percorso reale di piazzamento: il confine è l'input di
  // autenticazione (`_queueAuthInput`, dove viaggia la transazione d'uso), e
  // l'effetto sul mondo avviene qui.
  adapter.client.write = () => {};
  adapter.client.queue = (name, payload) => { events.placed.push({ name, payload }); };
  adapter._queueAuthInput = async (payload) => {
    events.authInputs.push(payload);
    const target = adapter._pendingPlaceTarget;
    if (target) put(target, adapter._pendingPlaceBlock);
  };
  adapter._openContainer = null;
  adapter._closeContainer = async () => {};
  return { adapter, blocks, events, memory, put };
}

test('a placement is written to the ledger and to the world memory (R4)', () => {
  const { adapter, memory, events } = placementAdapter();
  adapter._rememberPlacement({ position: { x: 10, y: 71, z: 10 }, block: 'minecraft:oak_planks', item: 'oak_planks' });

  assert.deepEqual([...adapter._placedBlocks.keys()], ['10,71,10']);
  assert.equal(adapter._placedBlocks.get('10,71,10').block, 'oak_planks', 'il nome è normalizzato');
  assert.equal(adapter._placedBlocks.get('10,71,10').circuit, null);
  const stored = memory.records.get('10,71,10');
  assert.equal(stored.type, 'oak_planks');
  assert.equal(stored.item, 'oak_planks');
  assert.equal(stored.source, 'place');

  adapter._forgetPlacement({ x: 10, y: 71, z: 10 });
  assert.equal(adapter._placedBlocks.size, 0);
  assert.equal(memory.records.size, 0, 'la memoria non conserva celle che non sono più sue');
  assert.equal(events.logs.length, 0, 'nessun errore di persistenza');
});

test('the ledger is rebuilt from the world memory at spawn', () => {
  const { adapter, memory } = placementAdapter({ placements: [
    { position: { x: 115, y: 73, z: 160 }, type: 'crafting_table', item: 'crafting_table', circuitId: null, placedAt: 1000, source: 'place' },
    { position: { x: 116, y: 73, z: 158 }, type: 'redstone_torch', item: 'redstone_torch', circuitId: 'auto_lamp', placedAt: 2000, source: 'circuit' },
  ] });
  assert.equal(adapter._placedBlocks.size, 0, 'prima dell\'avvio il registro in memoria è vuoto');

  assert.deepEqual(adapter._hydratePlacements(), { hydrated: 2 });
  assert.equal(adapter._placedBlocks.get('115,73,160').block, 'crafting_table');
  assert.equal(adapter._placedBlocks.get('116,73,158').circuit, 'auto_lamp', 'il cantiere è ricordato');
  assert.equal(adapter._placedBlocks.get('116,73,158').at, 2000, 'il timestamp del piazzamento resta quello vero');
  assert.deepEqual(adapter._hydratePlacements(), { hydrated: 0 }, 'idratare due volte non duplica');
  assert.equal(adapter._ownedCells().length, 2);
  assert.equal(memory.records.size, 2, 'idratare non riscrive la memoria');
});

test('mine_owned recovers only what the ledger says is mine: a protected base block is untouched', async () => {
  const { adapter, blocks, events } = placementAdapter({
    feet: { x: 0.5, y: 71, z: 0.5 },
    cells: { '1,71,0': 'crafting_table', '3,71,0': 'crafting_table' },
  });
  adapter._rememberPlacement({ position: { x: 1, y: 71, z: 0 }, block: 'crafting_table', item: 'crafting_table' });

  const candidates = adapter._ownedRecoverable();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].cell.x, 1, 'il tavolo della base (x=3) non è nel registro: non è un candidato');

  const res = await adapter._mineOwned();
  assert.equal(res.ok, true);
  assert.equal(res.block, 'crafting_table', 'un blocco «protetto» piazzato dal bot si può riprendere');
  assert.deepEqual(events.mined, ['crafting_table'], 'un solo blocco, quello suo');
  assert.equal(blocks.has('1,71,0'), false, 'il proprio è stato rimosso');
  assert.equal(blocks.has('3,71,0'), true, 'quello della base è ancora lì');
  assert.equal(adapter._placedBlocks.size, 0);
});

test('a placement someone else changed is dropped, not mined', async () => {
  const { adapter, blocks, memory } = placementAdapter({ cells: { '1,71,0': 'torch' } });
  adapter._rememberPlacement({ position: { x: 1, y: 71, z: 0 }, block: 'crafting_table' });

  assert.equal(adapter._ownedRecoverable().length, 0, 'il mondo non mostra più quel blocco');
  const res = await adapter._mineOwned();
  assert.equal(res.ok, false);
  assert.equal(res.error, 'nothing_owned_nearby');
  assert.equal(res.dropped, 1, 'il titolo su una cella cambiata si butta');
  assert.equal(res.owned, 0);
  assert.equal(adapter._placedBlocks.size, 0);
  assert.equal(memory.records.size, 0, 'nemmeno la memoria lo conserva');
  assert.equal(blocks.get('1,71,0').name, 'torch', 'il blocco di un altro non si tocca');
  assert.equal(blocks.get('1,71,0').name === 'crafting_table', false, 'nessun tavolo inventato');
});

test('a placement out of arm reach stays owned but is not offered', async () => {
  const { adapter } = placementAdapter({ cells: { '40,71,0': 'torch' } });
  adapter._rememberPlacement({ position: { x: 40, y: 71, z: 0 }, block: 'torch' });

  assert.equal(adapter._ownedRecoverable().length, 0, 'fuori portata: non è un\'opzione');
  const res = await adapter._mineOwned();
  assert.equal(res.error, 'nothing_owned_nearby');
  assert.equal(res.dropped, 0);
  assert.equal(res.owned, 1, 'la cella resta sua: è solo lontana');
});

test('mine_owned tries the nearest first and reports the typed failure', async () => {
  const { adapter, events } = placementAdapter({
    cells: { '1,71,0': 'torch', '2,71,0': 'torch' },
    mineResult: (block) => (block.position.x === 1 ? { ok: false, error: 'dig_timeout' } : { ok: true }),
  });
  adapter._rememberPlacement({ position: { x: 1, y: 71, z: 0 }, block: 'torch' });
  adapter._rememberPlacement({ position: { x: 2, y: 71, z: 0 }, block: 'torch' });

  const res = await adapter._mineOwned();
  assert.equal(res.ok, true, 'il secondo tentativo riesce');
  assert.deepEqual(events.mined, ['torch', 'torch'], 'prima il più vicino');
  assert.equal(adapter._placedBlocks.has('1,71,0'), true, 'il tentativo fallito non perde il titolo');
  assert.equal(adapter._placedBlocks.has('2,71,0'), false);

  const all = await adapter._mineOwned();
  assert.equal(all.ok, false);
  assert.equal(all.error, 'dig_timeout');
  assert.equal(all.attempts, 1);
  assert.equal(all.failed.length, 1);
});

test('the mine_owned key is not swallowed by the mine_<block> prefix', async () => {
  const { adapter, events } = placementAdapter({ cells: { '1,71,0': 'torch' } });
  adapter._rememberPlacement({ position: { x: 1, y: 71, z: 0 }, block: 'torch' });

  const res = await adapter._runAction('mine_owned');
  assert.equal(res.ok, true, 'il ramo giusto, non "no reachable owned found nearby"');
  assert.deepEqual(events.mined, ['torch']);

  const empty = placementAdapter();
  const refused = await empty.adapter._runAction('mine_owned');
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'nothing_owned_nearby', 'senza registro non si inventa nulla');
});

test('the real placement path writes the ledger', async () => {
  const { adapter, blocks, events, memory } = placementAdapter({
    feet: { x: 0.5, y: 71, z: 0.5 },
    inventorySlots: [{ network_id: 1, name: 'torch', count: 1 }],
  });
  // Il server finto materializza il blocco quando arriva la transazione.
  adapter._pendingPlaceTarget = { x: 1, y: 71, z: 0 };
  adapter._pendingPlaceBlock = 'torch';

  const res = await adapter._placeAtCell('torch', 'torch', { x: 1, y: 71, z: 0 }, { x: 1, y: 70, z: 0 }, 1);
  assert.equal(res.ok, true);
  assert.equal(events.authInputs.length >= 1, true, 'il piazzamento è passato dal confine col server');
  assert.equal(blocks.get('1,71,0').name, 'torch');
  assert.equal(adapter._placedBlocks.get('1,71,0').block, 'torch', 'il piazzamento è nel registro');
  assert.equal(memory.records.get('1,71,0').type, 'torch', 'e nella memoria del mondo');
  assert.equal(memory.records.get('1,71,0').source, 'place');
});

test('teardown forgets the cells in both ledgers', async () => {
  const { adapter, memory } = placementAdapter({ cells: { '1,71,0': 'redstone_torch' } });
  adapter._rememberPlacement({ position: { x: 1, y: 71, z: 0 }, block: 'redstone_torch', circuitId: 'auto_lamp' });
  memory.setPlacementCircuit({ x: 1, y: 71, z: 0 }, 'auto_lamp');

  const report = await adapter._teardownCircuit('auto_lamp');
  assert.equal(report.ok, true);
  assert.deepEqual(report.removed.map(r => r.cell), [{ x: 1, y: 71, z: 0 }]);
  assert.equal(adapter._placedBlocks.size, 0);
  assert.equal(memory.records.size, 0, 'il titolo sparisce anche dalla memoria persistente');
});

test('setPlacementCircuit keeps memory and ledger in sync', () => {
  const { adapter, memory } = placementAdapter();
  adapter._rememberPlacement({ position: { x: 5, y: 70, z: 5 }, block: 'redstone_torch' });
  adapter._setPlacementCircuit({ x: 5, y: 70, z: 5 }, 'auto_door');
  assert.equal(adapter._placedBlocks.get('5,70,5').circuit, 'auto_door');
  assert.equal(memory.records.get('5,70,5').circuitId, 'auto_door');
  assert.equal(adapter._setPlacementCircuit({ x: 9, y: 9, z: 9 }, 'auto_door'), null, 'cella ignota: nessun record inventato');
});
