import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constructionAdapter } from './fixtures/construction-adapter.mjs';
import { BedrockAdapter } from '../bedrock-adapter.mjs';
import { loadStructures, createBlueprint, planStructure, keyOf, constructionGoalMet } from '../construction.mjs';
import { ConstructionEngine } from '../bedrock-construction.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorldMemory } from '../world-memory.mjs';
import { evaluateCriteria, loadGameplaySkills } from '../survival/index.mjs';
import { optionIntents } from '../survival/intents.mjs';

const origin = { x: 0, y: 64, z: 0 };
const budgetFor = type => planStructure(createBlueprint(loadStructures().get(type)), { origin }).required;

async function finish (adapter, limit = 400) {
  const results = [];
  for (let i = 0; i < limit && adapter.construction.project.state !== 'complete'; i++) {
    const result = await adapter.executeAction('construction_step');
    results.push(result);
    assert.equal(result.ok, true, `${JSON.stringify(result)}; ${JSON.stringify(adapter.construction.view())}`);
  }
  assert.equal(adapter.construction.project.state, 'complete', 'the project must finish within the action budget');
  return results;
}

for (const type of ['platform', 'house', 'bridge', 'warehouse', 'tower']) {
  test(`${type}: complete build through real support/confirmation/pathfinding and functional verification`, { timeout: 120000 }, async () => {
    const { adapter, events } = constructionAdapter({ inventory: budgetFor(type), bridge: type === 'bridge' });
    adapter.setPlan({ objective: `Build ${type}`, targets: {}, construction: { type, origin } });
    const projectId = adapter.plan.construction.projectId;
    assert.ok(projectId);
    await finish(adapter);
    assert.equal(constructionGoalMet({ construction: adapter.construction.view() }, { projectId }), true);
    assert.ok(events.placed.length > 0);
    assert.ok(events.moves.every(path => path.length > 0));
    if (type === 'warehouse') assert.equal(events.opened.length, 4);
    if (type === 'tower') assert.ok(events.mined.length > 0, 'temporary access is dismantled');
    assert.equal(adapter.construction.view().siteIssues.length, 0);
  });
}

test('preview is read-only and a protected existing build is never adopted', () => {
  const { adapter, events, put } = constructionAdapter({ inventory: budgetFor('house') });
  const before = adapter.memory.repo.count({ kind: 'construction' });
  const report = adapter.construction.preview({ type: 'house', origin });
  assert.equal(report.ok, true);
  assert.equal(adapter.memory.repo.count({ kind: 'construction' }), before);
  assert.equal(events.placed.length, 0);
  put(origin, 'oak_planks');
  assert.throws(() => adapter.setPlan({ construction: { type: 'house', origin } }), /construction_site_blocked/);
  assert.equal(events.mined.length, 0);
});

test('server refusal preserves partial progress and reports the failing cell', async () => {
  let count = 0;
  const { adapter, events } = constructionAdapter({ inventory: budgetFor('platform'), refuse: () => ++count === 3 });
  adapter.setPlan({ construction: { type: 'platform', origin } });
  const result = await adapter.executeAction('construction_step');
  assert.equal(result.error, 'construction_place_failed');
  assert.equal(adapter.construction.project.state, 'blocked');
  assert.equal(adapter.construction.project.placed, 2);
  assert.equal(events.mined.length, 0);
});

for (const backend of ['json', 'sqlite']) {
  test(`${backend}: pause/reopen/resume reconciles the saved project without duplicate placements`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'construction-resume-'));
    let memory = createWorldMemory({ dir, backend, logger: null });
    try {
      const { adapter, events } = constructionAdapter({ inventory: budgetFor('house'), memory });
      adapter.setPlan({ construction: { type: 'house', origin } });
      await adapter.executeAction('construction_step');
      const id = adapter.plan.construction.projectId;
      adapter.construction.control('pause'); memory.close();
      memory = createWorldMemory({ dir, backend, logger: null });
      adapter.memory = memory; adapter.construction = new ConstructionEngine(adapter);
      adapter.setPlan({ construction: { projectId: id, command: 'resume' } });
      await finish(adapter);
      assert.equal(new Set(events.placed.map(e => keyOf(e.position))).size, events.placed.length);
      assert.equal(memory.getConstruction(id).state, 'complete');
      assert.equal(memory.placements().filter(p => p.projectId === id).length, events.placed.length - events.mined.length + 1, 'door upper half is separately owned and removed access leaves the ledger');
    } finally { memory.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test('an external edit blocks resume and is never replaced or mined', async () => {
  const { adapter, events, put } = constructionAdapter({ inventory: budgetFor('platform') });
  adapter.setPlan({ construction: { type: 'platform', origin } });
  await adapter.executeAction('construction_step');
  adapter.construction.control('pause');
  put(events.placed[0].position, 'chest');
  const result = adapter.construction.control('resume');
  assert.equal(result.error, 'construction_site_changed');
  assert.equal(events.mined.length, 0);
});

test('the governor recognises construction actions and build skills reject preexisting completions', () => {
  const after = { construction: { type: 'house', projectId: 'p', state: 'complete', placed: 100, verification: { ok: true } } };
  assert.equal(evaluateCriteria({ structureBuilt: { type: 'house' } }, after).ok, true);
  assert.equal(evaluateCriteria({ structureBuilt: { type: 'house' } }, after, { before: after }).ok, false);
  assert.deepEqual(optionIntents('construction_step'), ['build']);
  assert.equal(loadGameplaySkills().get('build_house').success.structureBuilt.type, 'house');
});

test('watchdog releases the lock and delayed inventory preparation cannot send a later placement', async () => {
  const { adapter, events } = constructionAdapter({ inventory: budgetFor('platform') });
  adapter.setPlan({ construction: { type: 'platform', origin } });
  adapter.inventorySlots.unshift(...Array.from({ length: 9 }, (_, i) => ({ name: 'stick', network_id: i + 50, count: 1 })));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  adapter._moveSlotToHotbar = async () => { await gate; return 0; };
  const oldTimeout = process.env.HARNESS_ACTION_TIMEOUT_MS;
  process.env.HARNESS_ACTION_TIMEOUT_MS = '15';
  try {
    const result = await adapter.executeAction('construction_step');
    assert.equal(result.error, 'action_timeout');
    assert.equal(adapter.busy, false);
    release();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(events.placed.length, 0);
    assert.equal(adapter.construction.project.state, 'paused');
  } finally {
    release();
    if (oldTimeout == null) delete process.env.HARNESS_ACTION_TIMEOUT_MS;
    else process.env.HARNESS_ACTION_TIMEOUT_MS = oldTimeout;
  }
});

test('pause during a pending placement prevents any subsequent mutation', async () => {
  const { adapter, events } = constructionAdapter({ inventory: budgetFor('platform') });
  adapter.setPlan({ construction: { type: 'platform', origin } });
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const original = adapter._placeAtCell.bind(adapter);
  adapter._placeAtCell = async (...args) => { entered(); await gate; return original(...args); };
  const running = adapter.executeAction('construction_step');
  await ready;
  adapter.construction.control('pause');
  release();
  assert.equal((await running).error, 'construction_interrupted');
  assert.equal(events.placed.length, 0);
  assert.equal(adapter.construction.project.state, 'paused');
});

test('unloaded edits and wrong dimensions prevent placement even through a direct act', async () => {
  const { adapter, events } = constructionAdapter({ inventory: budgetFor('platform') });
  adapter.setPlan({ construction: { type: 'platform', origin } });
  const read = adapter.world.blockAt;
  adapter.world.blockAt = p => keyOf(p) === keyOf(origin) ? null : read(p);
  assert.equal((await adapter.executeAction('construction_step')).error, 'construction_site_changed');
  assert.equal(events.placed.length, 0);
  adapter.dimension = 'nether';
  assert.throws(() => adapter.setPlan({ construction: { projectId: adapter.plan.construction.projectId } }), /wrong_dimension/);
});

test('procurement recurses through server recipes, targets a named safe tree and never an unapproved chest', async () => {
  const { adapter, put } = constructionAdapter();
  adapter.setPlan({ construction: { type: 'house', origin } });
  adapter.recipes = new Map([['oak_planks', [{ network_id: 1 }]]]);
  adapter.craftingData = { shapeless_recipes: [{ network_id: 1, width: 1, height: 1,
    input: [{ type: 'valid', descriptor_type: 'name', name: 'minecraft:oak_log' }] }] };
  const tree = { name: 'oak_log', position: { x: -4, y: 64, z: 2 }, distance: 5 };
  put(tree.position, tree.name);
  adapter.world.findBlocks = name => name === 'oak_log' ? [tree] : [];
  adapter._pickMineTarget = rows => rows[0] ?? null;
  adapter._cachedContainers = () => [{ position: { x: 10, y: 64, z: 10 }, contents: { oak_planks: 64 } }];
  adapter._rememberedStorage = () => [];
  const choice = adapter.construction.supplyChoice('oak_planks');
  assert.equal(choice.type, 'mine');
  assert.equal(choice.target.position.x, -4);
  adapter.inventory.oak_log = 1;
  assert.equal(adapter.construction.supplyChoice('oak_planks').type, 'craft');
});

test('approved container procurement passes its exact position and capacity to the primitive', async () => {
  const { adapter } = constructionAdapter();
  const authorized = { x: 10, y: 64, z: 10 };
  adapter.setPlan({ construction: { type: 'house', origin, authorizedContainers: [authorized] } });
  adapter._cachedContainers = () => [{ position: authorized, contents: { oak_planks: 64 } }];
  adapter._rememberedStorage = () => [];
  let called;
  adapter._takeFromContainer = async (item, options) => { called = { item, options }; adapter.inventory[item] = 64; return { ok: true }; };
  assert.equal((await adapter.executeAction('construction_supply')).ok, true);
  assert.equal(called.item, 'oak_planks');
  assert.deepEqual(called.options.position, authorized);
  assert.equal(called.options.maxCount, 64);
});

test('a crash after placement-ledger flush recovers only this project’s own confirmed cells', async () => {
  const { adapter, events } = constructionAdapter({ inventory: budgetFor('platform') });
  adapter.setPlan({ construction: { type: 'platform', origin } });
  const id = adapter.plan.construction.projectId;
  await adapter.executeAction('construction_step');
  const saved = adapter.memory.getConstruction(id);
  saved.claims = {}; saved.placed = 0;
  adapter.memory.saveConstruction(saved);
  adapter.construction = new ConstructionEngine(adapter);
  adapter.setPlan({ construction: { projectId: id } });
  assert.equal(adapter.construction.project.placed, 4);
  assert.equal(events.placed.length, 4);
  assert.equal(Object.keys(adapter.construction.project.claims).length, 4);
});

test('adapter options retain only construction and survival; an emergency plan pauses and resumes the same project', async () => {
  const { adapter } = constructionAdapter({ inventory: budgetFor('platform') });
  adapter.setPlan({ construction: { type: 'platform', origin } });
  const savedPlan = structuredClone(adapter.plan);
  const keys = adapter.options().map(o => o.key);
  assert.ok(keys.includes('construction_step'));
  assert.ok(!keys.some(k => /^(mine_|deposit_|take_|craft_)/.test(k)));
  adapter.setPlan({ targets: { dirt: 1 } });
  assert.equal(adapter.construction.project.state, 'paused');
  adapter.setPlan(savedPlan);
  assert.equal(adapter.construction.project.state, 'building');
  assert.equal(adapter.plan.construction.projectId, savedPlan.construction.projectId);
});

test('full inventory never deposits food, tools or project materials; surplus needs an approved container', () => {
  const { adapter } = constructionAdapter();
  const position = { x: -10, y: 64, z: 0 };
  adapter.setPlan({ construction: { type: 'platform', origin, authorizedContainers: [position] } });
  adapter.inventory = { bread: 64, wooden_pickaxe: 1, cobblestone: 64, flint: 64 };
  adapter.inventorySlots = Array.from({ length: 36 }, () => ({ name: 'bread', count: 64 }));
  adapter._cachedContainers = () => [{ position: { x: -11, y: 64, z: 0 }, contents: {} }];
  adapter._rememberedStorage = () => [];
  assert.equal(adapter.construction.capacity('cobblestone'), 0);
  assert.equal(adapter.construction.supplyChoice('cobblestone'), null);
  adapter._cachedContainers = () => [{ position, contents: {} }];
  assert.deepEqual(adapter.construction.supplyChoice('cobblestone'), { type: 'deposit', item: 'flint', position });
  delete adapter.inventory.flint;
  assert.equal(adapter.construction.supplyChoice('cobblestone'), null);
});

test('the placement repository keeps ownership separate at identical coordinates in different dimensions', () => {
  const { adapter } = constructionAdapter();
  const memory = adapter.memory;
  memory.rememberPlacement({ position: origin, block: 'cobblestone', dimension: 'overworld', projectId: 'surface' });
  memory.rememberPlacement({ position: origin, block: 'blackstone', dimension: 'nether', projectId: 'underworld' });
  assert.equal(memory.placementAt(origin, 'overworld').projectId, 'surface');
  assert.equal(memory.placementAt(origin, 'nether').projectId, 'underworld');
  memory.forgetPlacement(origin, 'nether');
  assert.equal(memory.placementAt(origin, 'nether'), null);
  assert.equal(memory.placementAt(origin, 'overworld').projectId, 'surface');
});

test('completed project reports no demand for its removed temporary access', () => {
  const { adapter } = constructionAdapter();
  adapter.setPlan({ construction: { type: 'house', origin } });
  const project = adapter.construction.project;
  for (const cell of project.plan.cells) {
    if (cell.temporary) project.removed.push(keyOf(cell.position));
    else project.claims[keyOf(cell.position)] = { block: cell.block };
  }
  project.state = 'complete';
  assert.deepEqual(adapter.construction.view().missing, []);
});

test('offered actions gather wood, pick up drops, craft from a server recipe and finish a material-empty project', async () => {
  const { adapter, put, events } = constructionAdapter();
  const trees = [64, 65, 66].map(y => ({ x: -1, y, z: -2 }));
  for (const position of trees) put(position, 'oak_log');
  adapter.world.findBlocks = name => name === 'oak_log' ? trees.map(p => adapter.world.blockAt(p)).filter(b => b.name === name)
    .map(b => ({ ...b, distance: Math.hypot(b.position.x - adapter.position.x, b.position.z - adapter.position.z) })) : [];
  adapter.recipes = new Map([['oak_planks', [{ network_id: 1 }]]]);
  adapter.craftingData = { shapeless_recipes: [{ network_id: 1, width: 1, height: 1,
    input: [{ type: 'valid', descriptor_type: 'name', name: 'minecraft:oak_log' }] }] };
  const refreshSlots = () => {
    adapter.inventorySlots = Object.entries(adapter.inventory).filter(([, count]) => count > 0)
      .map(([name, count], i) => ({ name, count, network_id: i + 1 }));
  };
  // Mining, pickup and crafting simulate server boundaries. Recipe eligibility,
  // option selection, demand, placement and completion remain production logic.
  const mine = adapter._mineBlock.bind(adapter);
  adapter._mineBlock = async block => {
    const result = await mine(block);
    adapter.drops.push({ id: String(block.position.y), item: 'oak_log', count: 1,
      position: { x: -0.5, y: 64.1, z: -1.5 }, spawnedAt: Date.now() });
    return result;
  };
  adapter._collectDrop = async () => {
    assert.equal(adapter.drops.length, 1);
    adapter.drops = [];
    adapter.inventory.oak_log = (adapter.inventory.oak_log ?? 0) + 1;
    refreshSlots();
    return { ok: true, collected: 'oak_log', inventoryDelta: 1 };
  };
  adapter._craftItem = async item => {
    assert.equal(item, 'oak_planks');
    assert.equal(adapter._craftableNow(item), true);
    adapter.inventory.oak_log--;
    adapter.inventory.oak_planks = (adapter.inventory.oak_planks ?? 0) + 4;
    refreshSlots();
    return { ok: true, item, crafted: 4 };
  };
  adapter.setPlan({ construction: { type: 'platform', origin,
    parameters: { width: 3, length: 3, palette: { floor: 'oak_planks' } } } });
  const actions = [];
  for (let i = 0; i < 40 && adapter.construction.project.state !== 'complete'; i++) {
    const keys = adapter.options().map(o => o.key);
    const key = ['collect_drop', 'construction_step', 'construction_supply'].find(k => keys.includes(k));
    assert.ok(key, JSON.stringify(keys));
    actions.push(key);
    const result = await adapter.executeAction(key);
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  assert.equal(adapter.construction.project.state, 'complete');
  assert.equal(actions.filter(k => k === 'construction_supply').length, 6);
  assert.equal(actions.filter(k => k === 'collect_drop').length, 3);
  assert.equal(events.mined.length, 3);
  assert.equal(events.placed.length, 9);
  assert.equal(adapter.inventory.oak_planks, 3);
});

test('a near but off-center work position is recentered when a placed floor blocks its click ray', () => {
  const { adapter, put } = constructionAdapter();
  put({ x: 1, y: 64, z: 0 }, 'oak_planks');
  put({ x: 1, y: 64, z: 1 }, 'oak_planks');
  const cell = { position: { x: 1, y: 64, z: 2 } };
  const support = { position: { x: 1, y: 63, z: 2 }, face: 1 };
  assert.equal(adapter.construction.lineClear({ x: 0, y: 64, z: 1 }, support, cell), true);
  assert.equal(adapter.construction.lineClear({ x: 0.32, y: 64, z: 1.16, actual: true }, support, cell), false);
});

for (const condition of ['night', 'wounded', 'creeper']) {
  test(`construction pauses before placing for the declarative ${condition} survival rule`, async () => {
    const { adapter, events } = constructionAdapter({ inventory: budgetFor('platform') });
    adapter.setPlan({ construction: { type: 'platform', origin } });
    if (condition === 'night') adapter._timeInfo = () => ({ ticks: 15000, phase: 'night', night: true });
    if (condition === 'wounded') adapter.health = 10;
    if (condition === 'creeper') adapter._hostiles = () => [{ type: 'creeper', position: { x: 3, y: 64, z: -2 }, distance: 3 }];
    const result = await adapter.executeAction('construction_step');
    assert.equal(result.error, 'construction_survival_needed');
    assert.equal(adapter.construction.project.state, 'paused');
    assert.equal(events.placed.length, 0);
    assert.ok(result.details.rule);
  });
}

test('survival monitor cancels a pending work movement when a hostile approaches', async () => {
  const { adapter, events } = constructionAdapter({ inventory: budgetFor('platform') });
  adapter.setPlan({ construction: { type: 'platform', origin } });
  adapter._feet = { x: -10.5, y: 64, z: -10.5 }; adapter._syncPositionFromFeet();
  let entered;
  const moving = new Promise(resolve => { entered = resolve; });
  adapter._moveTo = async (_target, _stop, _timeout, { signal }) => {
    entered();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    throw new Error('action_cancelled');
  };
  const running = adapter.executeAction('construction_step');
  await moving;
  adapter._hostiles = () => [{ type: 'zombie', position: { x: -9, y: 64, z: -10 }, distance: 2 }];
  const result = await running;
  assert.equal(result.error, 'construction_survival_needed');
  assert.equal(adapter.construction.project.state, 'paused');
  assert.equal(events.placed.length, 0);
  assert.equal(adapter.busy, false);
});

test('a work movement ending inside the next placement cell is rejected before the server click', async () => {
  const { adapter, events } = constructionAdapter({ inventory: budgetFor('platform') });
  adapter.setPlan({ construction: { type: 'platform', origin } });
  adapter._feet = { x: -10.5, y: 64, z: -10.5 }; adapter._syncPositionFromFeet();
  adapter._moveTo = async () => {
    const cell = adapter.construction.project.plan.cells[0];
    adapter._feet = { x: cell.position.x + 0.5, y: cell.position.y, z: cell.position.z + 0.5 };
    adapter._syncPositionFromFeet();
    return { ok: true };
  };
  const result = await adapter.executeAction('construction_step');
  assert.equal(result.error, 'construction_work_position_changed');
  assert.equal(result.details.occupiedByBot, true);
  assert.equal(events.placed.length, 0);
});

test('a bounded real physics approach preserves the project and places nothing before arrival', async () => {
  const { adapter, events } = constructionAdapter({ inventory: budgetFor('platform') });
  adapter.setPlan({ construction: { type: 'platform', origin } });
  adapter._feet = { x: -14.5, y: 64, z: -10.5 }; adapter._syncPositionFromFeet();
  adapter._onGround = true; adapter._velocity = { x: 0, y: 0, z: 0 };
  const fixtureMove = adapter._moveTo;
  adapter._moveTo = (target, stop, _timeout, options) => BedrockAdapter.prototype._moveTo.call(adapter, target, stop, 150, options);
  adapter._authTickInterval = setInterval(() => adapter._driveMotion(adapter._advanceTick()), 5);
  try {
    const result = await adapter.executeAction('construction_step');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.navigation.arrived, false); assert.equal(result.navigation.progressed, true);
    assert.ok(result.navigation.reachedWaypoints > 0);
    assert.equal(adapter.construction.project.state, 'building');
    assert.equal(events.placed.length, 0); assert.equal(adapter.construction.project.placed, 0);
  } finally { clearInterval(adapter._authTickInterval); adapter._authTickInterval = null; adapter._stopMotion(); }
  adapter._moveTo = fixtureMove;
  await finish(adapter);
});

test('a movement timeout without physical progress blocks with exact navigation evidence', async () => {
  const { adapter, events } = constructionAdapter({ inventory: budgetFor('platform') });
  adapter.setPlan({ construction: { type: 'platform', origin } });
  adapter._feet = { x: -14.5, y: 64, z: -10.5 }; adapter._syncPositionFromFeet();
  adapter._authTickInterval = true; // No client ticks: the real motion watchdog must end the wait.
  adapter._moveTo = (target, stop, _timeout, options) => BedrockAdapter.prototype._moveTo.call(adapter, target, stop, 50, options);
  try {
    const result = await adapter.executeAction('construction_step');
    assert.equal(result.error, 'construction_move_failed'); assert.equal(result.details.progressed, false);
    assert.deepEqual(result.details.position, result.details.from);
    assert.equal(adapter.construction.project.state, 'blocked'); assert.equal(events.placed.length, 0);
  } finally { adapter._authTickInterval = null; adapter._stopMotion(); }
});

test('repeated partial approaches stop within a fixed retry budget without claiming construction', async () => {
  const { adapter, events } = constructionAdapter({ inventory: budgetFor('platform') });
  adapter.setPlan({ construction: { type: 'platform', origin } });
  adapter._feet = { x: -14.5, y: 64, z: -10.5 }; adapter._syncPositionFromFeet();
  adapter._moveTo = async target => {
    const from = { ...adapter._feet }; adapter._feet.x += 0.5; adapter._syncPositionFromFeet();
    const error = new Error('movement timeout');
    error.details = { target, from, position: { ...adapter._feet }, pathNodes: 30, reachedWaypoints: 1, progressed: true };
    throw error;
  };
  let result;
  for (let attempt = 0; attempt < 7; attempt++) result = await adapter.executeAction('construction_step');
  assert.equal(result.error, 'construction_move_failed'); assert.equal(result.details.attempts, 7);
  assert.equal(adapter.construction.project.state, 'blocked'); assert.equal(events.placed.length, 0);
});

test('approved remote supplies require a real approach before withdrawal and subsequent construction', async () => {
  const { adapter, events, put } = constructionAdapter();
  const approved = { x: 15, y: 64, z: 15 }, other = { x: 3, y: 64, z: -4 };
  put(approved, 'chest'); put(other, 'chest');
  adapter.setPlan({ construction: { type: 'platform', origin, authorizedContainers: [approved] } });
  adapter._cachedContainers = () => [other, approved].map(position => ({ position, contents: { cobblestone: 25 } }));
  adapter._rememberedStorage = () => [];
  const fixtureMove = adapter._moveTo;
  adapter._onGround = true; adapter._velocity = { x: 0, y: 0, z: 0 };
  adapter._moveTo = (target, stop, _timeout, options) => BedrockAdapter.prototype._moveTo.call(adapter, target, stop, 1500, options);
  let taken = 0;
  adapter._takeFromContainer = async (item, { position }) => {
    assert.deepEqual(position, approved); assert.equal(item, 'cobblestone');
    assert.ok(adapter._pointDistance(position) <= 3.5, 'never withdraw remotely');
    taken++; adapter.inventory.cobblestone = 25;
    adapter.inventorySlots = [{ name: 'cobblestone', network_id: 1, count: 25 }];
    return { ok: true, count: 25, inventoryDelta: 25 };
  };
  adapter._authTickInterval = setInterval(() => adapter._driveMotion(adapter._advanceTick()), 30);
  try {
    const segment = await adapter.executeAction('construction_supply');
    assert.equal(segment.ok, true, JSON.stringify(segment)); assert.equal(segment.navigation.arrived, false);
    assert.equal(segment.supply.supplied, false); assert.deepEqual(segment.supply.position, approved);
    assert.equal(taken, 0); assert.equal(adapter.inventory.cobblestone ?? 0, 0); assert.equal(events.placed.length, 0);
  } finally { clearInterval(adapter._authTickInterval); adapter._authTickInterval = null; adapter._stopMotion(); }
  adapter._moveTo = (target, stop, timeout, options) => BedrockAdapter.prototype._moveTo.call(adapter, target, stop, timeout, options);
  adapter._authTickInterval = setInterval(() => adapter._driveMotion(adapter._advanceTick()), 5);
  try {
    const acquired = await adapter.executeAction('construction_supply');
    assert.equal(acquired.ok, true, JSON.stringify(acquired)); assert.equal(taken, 1);
    assert.equal(adapter.construction.project.navigation, null); assert.equal(events.placed.length, 0);
  } finally { clearInterval(adapter._authTickInterval); adapter._authTickInterval = null; adapter._stopMotion(); }
  adapter._moveTo = fixtureMove; await finish(adapter);
  assert.equal(events.placed.length, 25); assert.equal(adapter.world.blockAt(other).name, 'chest');
});

test('a failed cached chest is skipped without permitting the adjacent unauthorized chest', () => {
  const { adapter } = constructionAdapter();
  const failed = { x: 10, y: 64, z: 10 }, other = { x: 11, y: 64, z: 10 }, approved = { x: 12, y: 64, z: 10 };
  adapter.setPlan({ construction: { type: 'platform', origin, authorizedContainers: [failed, approved] } });
  adapter._cachedContainers = () => [failed, other, approved].map(position => ({ position, contents: { cobblestone: 64 } }));
  adapter._rememberedStorage = () => [];
  adapter._storageOpenFailures.set(adapter._containerCacheKey(failed), { at: Date.now(), error: 'container_open_timeout' });
  assert.deepEqual(adapter.construction.supplyChoice('cobblestone'), { type: 'take', item: 'cobblestone', position: approved });
});

test('supply navigation has a fixed trip budget and cannot claim any withdrawal on exhaustion', async () => {
  const { adapter } = constructionAdapter();
  const approved = { x: 100, y: 64, z: 100 };
  adapter.setPlan({ construction: { type: 'platform', origin, authorizedContainers: [approved] } });
  adapter._cachedContainers = () => [{ position: approved, contents: { cobblestone: 64 } }]; adapter._rememberedStorage = () => [];
  let taken = 0; adapter._takeFromContainer = async () => { taken++; return { ok: true }; };
  adapter._moveTo = async target => {
    const from = { ...adapter._feet }; adapter._feet.x += 0.5; adapter._syncPositionFromFeet();
    const error = new Error('movement timeout');
    error.details = { target, from, position: { ...adapter._feet }, reachedWaypoints: 1, progressed: true }; throw error;
  };
  let result; for (let i = 0; i < 25; i++) result = await adapter.executeAction('construction_supply');
  assert.equal(result.error, 'construction_move_failed'); assert.equal(result.details.attempts, 25);
  assert.equal(adapter.construction.project.state, 'blocked'); assert.equal(taken, 0);
});
