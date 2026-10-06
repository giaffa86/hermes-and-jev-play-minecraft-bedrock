// La portata dello scavo è un numero solo, condiviso dal predicato delle opzioni
// e dall'esecutore. Nasce dal run diamanti del 06/10/2026: `mine_diamond_ore` è
// stato offerto su un blocco a 10,2 blocchi (dietro un muro), la rottura partiva
// comunque e ogni tentativo tornava `block_still_present` — 353 azioni fallite su
// 678, senza che il log dicesse mai *perché*.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

const BOT = { x: 78.5, y: 73.62, z: 159.5 };
// Componente raggiungibile reale (la cella dei piedi + i vicini): con una sola
// cella `_reachabilityUsable()` è falso e i filtri si spengono (fail-open).
const NEAR_CELLS = [
  { x: 78, y: 72, z: 159 }, { x: 78, y: 72, z: 160 }, { x: 79, y: 72, z: 159 },
  { x: 77, y: 72, z: 159 }, { x: 78, y: 73, z: 159 },
];

function ore (position, name = 'diamond_ore') {
  return { name, position, diggable: true, distance: Math.hypot(position.x - BOT.x, position.z - BOT.z) };
}

function reachAdapter ({ cells = NEAR_CELLS, blocks = [] } = {}) {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.position = { ...BOT };
  adapter._feet = { x: 78, y: 72, z: 159 };
  const map = new Map(blocks.map(block => [`${block.position.x},${block.position.y},${block.position.z}`, block]));
  adapter.world.blockAt = pos => map.get(`${pos.x},${pos.y},${pos.z}`) || { name: 'air', boundingBox: 'empty' };
  adapter._vibrationRiskAt = () => null;
  adapter.reachableCells = () => ({ cells: new Set(cells.map(cell => `${cell.x},${cell.y},${cell.z}`)), truncated: false });
  adapter._moveTo = async () => { throw new Error('un predicato non deve muovere il bot'); };
  return adapter;
}

// ---- predicato condiviso -----------------------------------------------------------

test('a mine target beyond reach and unreachable on foot is not a target', () => {
  const far = ore({ x: 90, y: 71, z: 160 });
  const adapter = reachAdapter({ blocks: [far] });
  assert.equal(adapter._blockInReach(far), false, 'a 11,7 blocchi non è a portata');
  assert.equal(adapter.mineTargetReachable(far), false, 'nessuna cella raggiungibile entro la portata di avvicinamento');
  assert.equal(adapter._pickMineTarget([far]), null, 'un bersaglio non minabile non viene scelto');
});

test('a far mine target stays mineable when a reachable cell sits within approach range', () => {
  const far = ore({ x: 84, y: 71, z: 160 });
  const adapter = reachAdapter({ cells: [...NEAR_CELLS, { x: 84, y: 71, z: 159 }], blocks: [far] });
  assert.equal(adapter._blockInReach(far), false, 'serve ancora avvicinarsi');
  assert.equal(adapter.mineTargetReachable(far), true, 'c\'è una cella raggiungibile a tiro');
  assert.equal(adapter._pickMineTarget([far]), far, 'l\'opzione resta offerta: l\'esecutore si avvicina prima di rompere');
});

test('the closest in-reach target wins over the one that would need a walk', () => {
  const walk = ore({ x: 84, y: 71, z: 160 });
  const near = ore({ x: 79, y: 71, z: 160 });
  const adapter = reachAdapter({ cells: [...NEAR_CELLS, { x: 84, y: 71, z: 159 }], blocks: [walk, near] });
  assert.equal(adapter._pickMineTarget([walk, near]), near);
});

test('a buried block in reach is still a target (no regression on the exposed-face rule)', () => {
  const buried = { ...ore({ x: 79, y: 71, z: 160 }), diggable: true };
  const adapter = reachAdapter({ blocks: [] }); // mondo vuoto: i sei vicini sono vuoti, quindi la faccia è scoperta
  assert.equal(adapter._blockExposed(buried), true, 'con i vicini vuoti è esposto');
  assert.equal(adapter._pickMineTarget([buried]), buried);
});

test('the mining reach is one number: inside it yes, past it no', () => {
  const inside = ore({ x: 83, y: 73, z: 159 });   // centro (83.5, 73.5, 159.5) → 5,02 blocchi dagli occhi
  const outside = ore({ x: 84, y: 73, z: 159 });  // centro (84.5, 73.5, 159.5) → 6,02
  const adapter = reachAdapter({ blocks: [inside, outside] });
  assert.equal(adapter._blockInReach(inside), true);
  assert.equal(adapter._blockInReach(outside), false);
  assert.equal(adapter.mineTargetReachable(inside), true);
});

test('the offer rule is exactly "there is a mineable target": no key without one', () => {
  const near = ore({ x: 79, y: 71, z: 160 }, 'iron_ore');
  const far = ore({ x: 90, y: 71, z: 160 }, 'diamond_ore');
  const adapter = reachAdapter({ cells: [...NEAR_CELLS, { x: 84, y: 71, z: 159 }], blocks: [near, far] });
  const byName = { iron_ore: [near], diamond_ore: [far] };
  const offered = Object.entries(byName)
    .filter(([, blocks]) => adapter._pickMineTarget(blocks) !== null)
    .map(([name]) => `mine_${name}`);
  assert.deepEqual(offered, ['mine_iron_ore']);
  for (const blocks of Object.values(byName)) {
    const target = adapter._pickMineTarget(blocks);
    if (target) assert.ok(adapter.mineTargetReachable(target), 'si offre solo ciò che è minabile');
  }
});

// ---- esecutore ---------------------------------------------------------------------

function mineAdapter (blockPosition, { hardness = 0, confirmTo = 'air' } = {}) {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.serverAuthBlockBreaking = true;
  adapter.position = { ...BOT };
  let current = { name: 'diamond_ore', position: blockPosition, diggable: true, hardness };
  const packets = [];
  const client = adapter.client = new EventEmitter();
  client.entityId = 1;
  client.queue = () => {};
  client.write = (name, params) => packets.push({ name, params });
  adapter.world.blockAt = () => current;
  adapter.world.runtimeIdAt = () => 0xf1234567;
  adapter.world.refreshSection = () => { current = confirmTo == null ? null : { name: confirmTo, position: blockPosition }; };
  adapter._refreshNearby = () => {};
  adapter.moveCalls = 0;
  adapter._moveTo = async () => { adapter.moveCalls += 1; return false; };
  return { adapter, block: current, packets };
}

test('the executor refuses a block it cannot approach instead of hammering block_still_present', async () => {
  const { adapter, block, packets } = mineAdapter({ x: 90, y: 71, z: 160 }, { hardness: 3, confirmTo: 'diamond_ore' });
  const logs = [];
  adapter.onLog = entry => logs.push(entry);
  const result = await adapter._mineBlock(block);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'mine_target_unreachable');
  assert.ok(result.distance > 5, `distanza dichiarata (${result.distance})`);
  assert.equal(adapter.moveCalls, 1, 'un solo tentativo di avvicinamento, non un ciclo');
  assert.equal(packets.filter(packet => packet.params?.block_action).length, 0, 'nessun pacchetto di rottura inviato da fuori portata');
  assert.equal(logs.filter(entry => entry.type === 'mine_target_unreachable').length, 1);
});

test('a block in reach is mined without approaching (the guard does not fire)', async () => {
  const { adapter, block, packets } = mineAdapter({ x: 79, y: 71, z: 160 });
  const result = await adapter._mineBlock(block);
  assert.equal(result.ok, true);
  assert.equal(adapter.moveCalls, 0, 'a portata non ci si muove');
  assert.ok(packets.some(packet => packet.params?.block_action), 'la rottura parte');
});
