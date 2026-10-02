import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

const SOLID = { name: 'stone', boundingBox: 'block', diggable: true, hardness: 1.5 };
const UNKNOWN = { name: 'unknown', boundingBox: 'block', diggable: false, hardness: null };
const AIR = { name: 'air', boundingBox: 'empty', diggable: false, hardness: 0 };
const GROUND_Y = 63;

test('unknown blocks are treated as solid for planning and never crossed', () => {
  const blocks = new Set();
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 8; z++) blocks.add(`${x},${GROUND_Y},${z}`);
  // Muro di blocchi unknown attraverso la mappa.
  for (let x = -2; x <= 2; x++) for (let y = GROUND_Y + 1; y <= GROUND_Y + 2; y++) blocks.add(`${x},${y},3`);
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.world = { blockAt: ({ x, y, z }) => blocks.has(`${x},${y},${z}`) ? (y === GROUND_Y ? SOLID : UNKNOWN) : AIR };
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter._feet = { x: 0.5, y: GROUND_Y + 1, z: 0.5 };
  adapter._velocity = { x: 0, y: 0, z: 0 };
  adapter._onGround = true;
  adapter._syncPositionFromFeet();
  assert.equal(adapter._passable(UNKNOWN), false);
  const path = adapter._findPath(adapter._startNode(), { x: 0, y: GROUND_Y + 1, z: 6 });
  if (path) assert.ok(path.every(node => node.z !== 3), 'nessun nodo dentro il muro unknown');
});

test('raw mining breaks an unknown cell and confirms the world update', async () => {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.client = { write () {} };
  adapter.position = { x: 0.5, y: GROUND_Y + 2.62, z: 0.5 };
  adapter._feet = { x: 0.5, y: GROUND_Y + 1, z: 0.5 };
  let reads = 0;
  adapter.world.blockAt = () => (reads++ < 2 ? { ...UNKNOWN, runtimeId: 42 } : { ...AIR, runtimeId: 7 });
  adapter.world.runtimeIdAt = () => 42;
  adapter.world.refreshSection = () => {};
  adapter._refreshNearby = () => {};
  const sent = [];
  adapter._queueAuthInput = async input => { sent.push(input); };
  const result = await adapter._mineRawCell({ x: 0, y: GROUND_Y + 3, z: 0 }, 2000);
  assert.equal(result.ok, true);
  assert.equal(result.block, 'unknown');
  assert.ok(sent.some(input => input.blockAction?.[0]?.action === 'start_break'), 'invia start_break');
  assert.ok(sent.some(input => input.blockAction?.[0]?.action === 'continue_break'), 'invia continue_break');
});

test('_mineTarget dispatches known blocks to _mineBlock and unknown to raw mining', async () => {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  const calls = [];
  adapter._mineBlock = async block => { calls.push(`block:${block.name}`); return { ok: true }; };
  adapter._mineRawCell = async cell => { calls.push(`raw:${cell.x},${cell.y},${cell.z}`); return { ok: true }; };
  await adapter._mineTarget({ cell: { x: 1, y: 2, z: 3 }, block: SOLID, label: 'step' });
  await adapter._mineTarget({ cell: { x: 1, y: 4, z: 3 }, block: UNKNOWN, label: 'head', raw: true });
  assert.deepEqual(calls, ['block:stone', 'raw:1,4,3']);
});
