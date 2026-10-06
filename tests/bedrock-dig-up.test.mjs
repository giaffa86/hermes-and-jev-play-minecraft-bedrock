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

test('up targets refuse missing step and fluids, and treat unknown blocks as raw targets', () => {
  const noStep = upAdapter({ '92,68,149': air });
  assert.equal(noStep.adapter._upTargets().error, 'no_step_ahead');
  const water = upAdapter({ '92,69,149': { name: 'water', boundingBox: 'empty', diggable: false, hardness: 0 } });
  assert.equal(water.adapter._upTargets().error, 'unsafe_block_step');
  const unknown = upAdapter({ '92,69,149': { name: 'unknown', diggable: false, hardness: null, runtimeId: 42 } });
  const plan = unknown.adapter._upTargets();
  assert.equal(plan.error, undefined);
  assert.deepEqual(plan.targets.map(t => `${t.label}${t.raw ? ':raw' : ''}`), ['step:raw', 'head']);
  const open = upAdapter({ '92,69,149': air, '92,70,149': air });
  assert.equal(open.adapter._upTargets().error, undefined, 'scalino già aperto: si sale e basta');
  assert.deepEqual(open.adapter._upTargets().targets, []);
});

test('up targets include the ceiling above the bot when it blocks the jump', () => {
  const { adapter } = upAdapter({ '92,70,148': solid('dirt') });
  const plan = adapter._upTargets();
  assert.equal(plan.error, undefined);
  assert.deepEqual(plan.targets.map(t => t.label), ['ceiling', 'step', 'head']);
});

test('an unknown ceiling is a raw target and dig_up dispatches to raw mining', async () => {
  const { adapter } = upAdapter({ '92,70,148': { name: 'unknown', diggable: false, hardness: null, runtimeId: 42 } });
  assert.equal(adapter._upTargets().targets[0].label, 'ceiling');
  assert.equal(adapter._upTargets().targets[0].raw, true);
  const rawMined = [];
  adapter._mineTarget = async target => { rawMined.push({ label: target.label, raw: !!target.raw }); return { ok: true, block: 'unknown' }; };
  adapter._ascendStair = async () => true;
  const result = await adapter._digUp(1000);
  assert.equal(result.ok, true);
  assert.deepEqual(rawMined, [
    { label: 'ceiling', raw: true },
    { label: 'step', raw: false },
    { label: 'head', raw: false },
  ]);
});

test('up targets refuse protected blocks like chests', () => {
  const { adapter } = upAdapter({ '92,69,149': solid('chest') });
  const plan = adapter._upTargets();
  assert.equal(plan.error, 'protected_step');
  assert.equal(plan.block, 'chest');
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

test('the live pit: steps north from feet 67 under a ceiling 3 above are climbed', () => {
  const blocks = new Set();
  const BX = 92, BZ = 155, FY = 67;
  for (let x = 91; x <= 94; x++) for (let z = 150; z <= 158; z++) blocks.add(`${x},${FY - 1},${z}`); // pavimento
  for (let x = 91; x <= 94; x++) for (let z = 150; z <= 158; z++) blocks.add(`${x},${FY + 4},${z}`); // superficie
  for (let x = 91; x <= 94; x++) for (let z = 150; z <= 158; z++) {
    if (x === BX && z === BZ) continue; // cella del bot
    if (x === BX + 1 && z === BZ) continue; // cunicolo 1 alto a est
    blocks.add(`${x},${FY},${z}`);
  }
  for (let z = 154; z <= 156; z++) for (const y of [FY + 1, FY + 2]) blocks.delete(`${BX},${y},${z}`);
  blocks.delete(`${BX},${FY + 3},${BZ}`); // volta aperta sopra il cunicolo nord
  blocks.add(`${BX},${FY + 3},${BZ}`);    // ...tranne sopra il bot
  const world = { blockAt: ({ x, y, z }) => blocks.has(`${x},${y},${z}`) ? SOLID : AIR };
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.world = world;
  adapter._feet = { x: BX + 0.5, y: FY, z: BZ + 0.7 };
  adapter._velocity = { x: 0, y: 0, z: 0 };
  adapter._onGround = true;
  adapter._syncPositionFromFeet();
  adapter._motion = { active: true, forward: true, yaw: 180, jumpQueued: false, jumpHeldTicks: 0, jumpStart: false }; // nord
  let climbed = 0;
  for (let i = 0; i < 60; i++) {
    adapter._physicsStep();
    climbed = Math.max(climbed, adapter._feet.y);
  }
  assert.ok(climbed >= FY + 1 - 1e-6, `sale sul primo gradino (max ${climbed})`);
  assert.ok(adapter._feet.z <= 154.9, 'avanza verso nord');
});

// ---- fisica: buca alta due blocchi con gradino e volta --------------------------------

const SOLID = { name: 'stone', boundingBox: 'block' };
const AIR = { name: 'air', boundingBox: 'empty' };
const GROUND_Y = 63; // primo blocco del pavimento: i piedi stanno a 64.

function physicsWorld () {
  const blocks = new Set();
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 8; z++) blocks.add(`${x},${GROUND_Y},${z}`);
  // Terreno rialzato di un blocco oltre il gradino (z >= 1).
  for (let x = -2; x <= 2; x++) for (let z = 1; z <= 8; z++) blocks.add(`${x},${GROUND_Y + 1},${z}`);
  return {
    blocks,
    blockAt: ({ x, y, z }) => blocks.has(`${x},${y},${z}`) ? SOLID : AIR,
  };
}

test('the pit blocks the climb until the ceiling is opened, then the step is climbed', () => {
  const world = physicsWorld();
  world.blocks.add(`0,${GROUND_Y + 3},0`); // volta sopra il bot a 66
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.world = world;
  adapter._feet = { x: 0.5, y: GROUND_Y + 1, z: 0.5 };
  adapter._velocity = { x: 0, y: 0, z: 0 };
  adapter._onGround = true;
  adapter._syncPositionFromFeet();
  adapter._motion = { active: true, forward: true, yaw: 0, jumpQueued: false, jumpHeldTicks: 0, jumpStart: false };
  for (let i = 0; i < 40; i++) adapter._physicsStep();
  assert.ok(adapter._feet.y <= GROUND_Y + 1.5, 'senza spazio per il salto non sale sul gradino');
  assert.ok(adapter._feet.z < 1, 'resta bloccato davanti al gradino');
  // La volta viene aperta (dig_up): ora il salto ha spazio.
  world.blocks.delete(`0,${GROUND_Y + 3},0`);
  for (let i = 0; i < 20; i++) adapter._physicsStep();
  assert.ok(adapter._feet.y >= GROUND_Y + 2 - 1e-6, 'con la volta aperta sale sul gradino');
  assert.ok(adapter._feet.z > 1, 'supera il gradino');
});

// ---- direzione: la scalinata sale anche alle spalle ------------------------------------

test('an open side does not strand the bot: the stair climbs the opposite way', () => {
  const { adapter } = upAdapter({
    '92,68,149': air,
    '92,68,147': solid('stone'),
    '92,69,147': solid('dirt', { material: 'mineable/shovel' }),
    '92,70,147': solid('grass_block', { material: 'mineable/shovel', hardness: 0.6 }),
  });
  adapter.drops = [];
  adapter.nearbyBlocks = {};
  const plan = adapter._upTargets();
  assert.equal(plan.error, undefined, 'la direzione di sguardo è aperta, quella alle spalle è solida');
  assert.deepEqual(plan.direction, { dx: 0, dz: -1 });
  assert.deepEqual(plan.front, { x: 92, y: 68, z: 147 });
  assert.deepEqual(plan.targets.map(t => `${t.label}:${t.block.name}`), ['step:dirt', 'head:grass_block']);
  assert.equal(adapter.options().some(o => o.key === 'dig_up'), true, 'dig_up torna nell\'elenco');
});

test('the facing direction still wins when it can climb too (the stair stays straight)', () => {
  const { adapter } = upAdapter({
    '92,68,147': solid('stone'),
    '92,69,147': solid('dirt', { material: 'mineable/shovel' }),
    '92,70,147': solid('grass_block', { material: 'mineable/shovel', hardness: 0.6 }),
  });
  const plan = adapter._upTargets();
  assert.deepEqual(plan.direction, { dx: 0, dz: 1 });
  assert.deepEqual(plan.front, { x: 92, y: 68, z: 149 });
});

test('when no direction can climb, the error is the facing one and every direction is listed', () => {
  const { adapter } = upAdapter({ '92,68,149': air });
  const plan = adapter._upTargets();
  assert.equal(plan.error, 'no_step_ahead');
  assert.equal(plan.tried.length, 4);
  assert.deepEqual(plan.tried[0].direction, { dx: 0, dz: 1 });
  assert.equal(plan.tried[0].error, 'no_step_ahead');
});
