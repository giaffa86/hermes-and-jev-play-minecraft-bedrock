import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

const solid = (name, extra = {}) => ({ name, boundingBox: 'block', diggable: true, hardness: 0.5, ...extra });
const air = { name: 'air', boundingBox: 'empty', diggable: false, hardness: 0 };

// Bot in fondo a una buca a (92.5, piedi 68, 148.5) rivolto a sud (+z):
// davanti ai piedi c'è il gradino, sopra due blocchi da aprire.
function upAdapter (cells = {}) {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter._feet = { x: 92.5, y: 68, z: 148.5 };
  adapter.position = { x: 92.5, y: 69.62, z: 148.5 };
  adapter._lastYaw = 0;
  const blocks = {
    '92,67,148': solid('stone'),
    '92,68,149': solid('dirt', { material: 'mineable/shovel' }),
    '92,69,149': solid('dirt', { material: 'mineable/shovel' }),
    '92,70,149': solid('grass_block', { material: 'mineable/shovel', hardness: 0.6 }),
    '92,68,150': solid('stone'),
    '92,69,150': air,
    '92,70,150': air,
    ...cells,
  };
  adapter.world.blockAt = ({ x, y, z }) => blocks[`${x},${y},${z}`] ?? null;
  adapter.world.findBlocks = () => [];
  return { adapter, blocks };
}

test('up targets are the step and head cells above the block ahead', () => {
  const { adapter } = upAdapter();
  const plan = adapter._upTargets();
  assert.equal(plan.error, undefined);
  assert.deepEqual(plan.targets.map(t => t.label), ['step', 'head']);
  assert.deepEqual(plan.targets.map(t => t.block.name), ['dirt', 'grass_block']);
  assert.deepEqual(plan.front, { x: 92, y: 68, z: 149 });
  assert.deepEqual(plan.step, { x: 92, y: 69, z: 149 });
});

test('up targets refuse missing step, fluids, unknown blocks and open passages', () => {
  const noStep = upAdapter({ '92,68,149': air });
  assert.equal(noStep.adapter._upTargets().error, 'no_step_ahead');
  const water = upAdapter({ '92,69,149': { name: 'water', boundingBox: 'empty', diggable: false, hardness: 0 } });
  assert.equal(water.adapter._upTargets().error, 'unsafe_block_step');
  const unknown = upAdapter({ '92,69,149': { name: 'unknown', diggable: false, hardness: null } });
  assert.equal(unknown.adapter._upTargets().error, 'block_unknown');
  const open = upAdapter({ '92,69,149': air, '92,70,149': air });
  assert.equal(open.adapter._upTargets().error, 'already_open');
});

test('up targets include the ceiling above the bot when it blocks the jump', () => {
  const { adapter } = upAdapter({ '92,70,148': solid('dirt') });
  const plan = adapter._upTargets();
  assert.equal(plan.error, undefined);
  assert.deepEqual(plan.targets.map(t => t.label), ['ceiling', 'step', 'head']);
});

test('dig_up mines step and head then climbs the stair', async () => {
  const { adapter } = upAdapter();
  const mined = [];
  adapter._mineBlock = async block => { mined.push(block.name); return { ok: true, block: block.name, tool: null }; };
  adapter._ascendStair = async () => { adapter._feet.y += 1; return true; };
  const result = await adapter._digUp(1000);
  assert.equal(result.ok, true);
  assert.deepEqual(mined, ['dirt', 'grass_block']);
  assert.equal(result.moved, true);
  assert.deepEqual(result.dug.map(d => d.label), ['step', 'head']);
});

test('options offer dig_up while a climbable step exists', () => {
  const { adapter } = upAdapter();
  adapter.drops = [];
  adapter.nearbyBlocks = {};
  assert.equal(adapter.options().some(o => o.key === 'dig_up'), true);
  const open = upAdapter({ '92,68,149': air });
  open.adapter.drops = [];
  open.adapter.nearbyBlocks = {};
  assert.equal(open.adapter.options().some(o => o.key === 'dig_up'), false);
});
