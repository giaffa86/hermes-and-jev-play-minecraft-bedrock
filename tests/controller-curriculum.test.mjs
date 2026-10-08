// Scenario test for CURRICULUM=<milestone> (P3): the progression engine drives
// the whole chain `wood -> crafting_table -> food_and_safety -> first_night`
// against a scripted world, and the run stops with the milestone MET.
//
// The fake harness owns the world (it *is* the source of truth for options) and
// the fake `hermes` binary only picks one of the offered keys, so the test
// proves: (a) the plan at every step comes from knowledge/progression.json and
// never from the planner ("curriculum_fallback" absent), (b) each skill is
// closed by verifySkill on harness state (not by the model's opinion), and
// (c) the goal ends exactly when the curriculum milestone is verified.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// A fake `hermes` CLI that pops the next decision key from a queue file: the
// controller still owns the loop, we only script the *choice*. In curriculum
// mode the planner never runs, so every `hermes` call here is a decision.
function fakeHermesQueue (keys) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-hermes-'));
  const queuePath = join(dir, 'queue.json');
  const popPath = join(dir, 'pop.mjs');
  writeFileSync(queuePath, JSON.stringify(keys));
  writeFileSync(popPath, `
import { readFileSync, writeFileSync } from 'node:fs';
const path = ${JSON.stringify(queuePath)};
const queue = JSON.parse(readFileSync(path, 'utf8'));
const next = queue.shift() ?? 'wait';
writeFileSync(path, JSON.stringify(queue));
process.stdout.write(next);
`);
  const bin = join(dir, 'hermes');
  writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(popPath)}\n`);
  chmodSync(bin, 0o755);
  return { dir, path: dir };
}

// Scripted world for the first_night chain. The stage is derived from the
// inventory (logs -> table -> food) and from the clock, so `/options` always
// reflects what is actually valid right now.
function startCurriculumHarness (initial = {}) {
  return new Promise(resolve => {
    // The harness owns validity: it offers exactly one action per stage, so a
    // wrong decision can only be taken if the progression chain is wrong.
    const state = {
      stage: 'wood',
      inventory: {},
      health: 20,
      food: 20,
      time: { ticks: 2000, night: false, phase: 'day' },
      acts: [],
      ...initial,
      inventory: { ...(initial.inventory || {}) },
      time: { ...(initial.time || { ticks: 2000, night: false, phase: 'day' }) },
    };
    const optionsFor = () => {
      switch (state.stage) {
        case 'wood': return [{ key: 'mine_oak_log', description: 'mine an oak log' }];
        case 'table': return [{ key: 'craft_crafting_table', description: 'craft a crafting table' }];
        case 'food': return [{ key: 'hunt_cow', description: 'hunt a cow for beef' }];
        case 'sleep': return [{ key: 'sleep', description: 'sleep in the bed through the night' }];
        default: return [{ key: 'wait', description: 'wait' }];
      }
    };
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.method === 'GET' && req.url === '/observe') {
        res.end(JSON.stringify({
          position: { x: 0, y: 64, z: 0 },
          dimension: 'overworld',
          inventory: { ...state.inventory },
          health: state.health,
          food: state.food,
          dead: false,
          time: { ...state.time },
          entities: [],
          chat: [],
          drops: [],
          containers: [],
        }));
      } else if (req.method === 'GET' && req.url === '/options') {
        res.end(JSON.stringify({ options: optionsFor() }));
      } else if (req.method === 'POST' && req.url === '/act') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          let key = null;
          try { key = JSON.parse(body || '{}').key; } catch { key = null; }
          state.acts.push(key);
          if (key === 'mine_oak_log' && state.stage === 'wood') { state.inventory.oak_log = 8; state.stage = 'table'; }
          if (key === 'craft_crafting_table' && state.stage === 'table') { state.inventory.oak_log = 4; state.inventory.crafting_table = 1; state.stage = 'food'; }
          // Hunting takes long enough that night falls before the next step:
          // the observation right after it is already dark.
          if (key === 'hunt_cow' && state.stage === 'food') { state.inventory.beef = 2; state.time = { ticks: 14000, night: true, phase: 'night' }; state.stage = 'sleep'; }
          if (key === 'sleep' && state.stage === 'sleep') { state.time = { ticks: 23000, night: false, phase: 'day' }; state.stage = 'done'; }
          res.end(JSON.stringify({ ok: true, ms: 1 }));
        });
      } else {
        res.end('{}');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state }));
  });
}

// Scripted world for the redstone chain: the bot already has the early-game
// gear (the graph's `wood`/`crafting_table`/`stone_tools`/`iron_age` nodes are
// satisfied by the inventory), so the progression engine must resolve straight
// to `redstone_ore -> redstone_basics -> redstone_automation`. The last stage
// answers with a *circuit report*, because that is what the skill verifies.
function startRedstoneHarness (initial = {}) {
  return new Promise(resolve => {
    const state = {
      stage: 'ore',
      inventory: { oak_log: 8, crafting_table: 1, stone_pickaxe: 1, iron_pickaxe: 1, ...(initial.inventory || {}) },
      health: 20,
      food: 20,
      time: { ticks: 2000, night: false, phase: 'day', ...(initial.time || {}) },
      circuits: { count: 8, buildable: ['lamp_switch'], declared: [], invalid: null, last: null, owned: 0, ...(initial.circuits || {}) },
      acts: [],
    };
    const optionsFor = () => {
      switch (state.stage) {
        case 'ore': return [{ key: 'mine_redstone_ore', description: 'mine redstone ore for dust' }];
        case 'parts': return [{ key: 'craft_repeater', description: 'craft a repeater' }];
        case 'circuit': return [{ key: 'build_circuit_lamp_switch', description: 'build the lamp switch circuit' }];
        default: return [{ key: 'wait', description: 'wait' }];
      }
    };
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.method === 'GET' && req.url === '/observe') {
        res.end(JSON.stringify({
          position: { x: 0, y: 64, z: 0 },
          dimension: 'overworld',
          inventory: { ...state.inventory },
          health: state.health,
          food: state.food,
          dead: false,
          time: { ...state.time },
          entities: [],
          chat: [],
          drops: [],
          containers: [],
          circuits: { ...state.circuits },
        }));
      } else if (req.method === 'GET' && req.url === '/options') {
        res.end(JSON.stringify({ options: optionsFor() }));
      } else if (req.method === 'POST' && req.url === '/act') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          let key = null;
          try { key = JSON.parse(body || '{}').key; } catch { key = null; }
          state.acts.push(key);
          if (key === 'mine_redstone_ore' && state.stage === 'ore') { state.inventory.redstone = 4; state.stage = 'parts'; }
          if (key === 'craft_repeater' && state.stage === 'parts') { state.inventory.repeater = 1; state.stage = 'circuit'; }
          if (key === 'build_circuit_lamp_switch' && state.stage === 'circuit') {
            state.circuits.last = { id: 'lamp_switch', ok: true, error: null, at: Date.now(), steps: 2 };
            state.circuits.owned = 2;
            state.stage = 'done';
          }
          res.end(JSON.stringify({ ok: true, ms: 1 }));
        });
      } else {
        res.end('{}');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state }));
  });
}

// Scripted world for the **composite** goal (R5): the bot already owns the
// early game (logs, table, stone and iron tools), so `prepare_for_nether =
// [enter_nether, nether_survival]` must resolve to the four missing milestones
// `diamonds -> nether_portal -> enter_nether -> nether_survival`, one action
// each. The last two are the point of the test: `enter_nether` is a *target*
// satisfied by the world (the dimension changes) while `nether_survival` is
// not — the goal must survive that and only close on the last one.
function startCompositeHarness () {
  return new Promise(resolve => {
    const state = {
      stage: 'diamonds',
      inventory: { oak_log: 8, crafting_table: 1, stone_pickaxe: 1, iron_pickaxe: 1 },
      health: 20,
      food: 20,
      dimension: 'overworld',
      time: { ticks: 2000, night: false, phase: 'day' },
      acts: [],
    };
    const optionsFor = () => {
      switch (state.stage) {
        case 'diamonds': return [{ key: 'mine_diamond_ore', description: 'mine a diamond' }];
        case 'portal': return [{ key: 'mine_obsidian', description: 'mine obsidian for a portal' }];
        case 'enter': return [{ key: 'enter_portal', description: 'walk into the portal' }];
        case 'survive': return [{ key: 'dig_shelter', description: 'dig a shelter in the Nether' }];
        default: return [{ key: 'wait', description: 'wait' }];
      }
    };
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.method === 'GET' && req.url === '/observe') {
        res.end(JSON.stringify({
          position: { x: 0, y: 64, z: 0 },
          dimension: state.dimension,
          inventory: { ...state.inventory },
          health: state.health,
          food: state.food,
          dead: false,
          time: { ...state.time },
          entities: [],
          chat: [],
          drops: [],
          containers: [],
        }));
      } else if (req.method === 'GET' && req.url === '/options') {
        res.end(JSON.stringify({ options: optionsFor() }));
      } else if (req.method === 'POST' && req.url === '/act') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          let key = null;
          try { key = JSON.parse(body || '{}').key; } catch { key = null; }
          state.acts.push(key);
          if (key === 'mine_diamond_ore' && state.stage === 'diamonds') { state.inventory.diamond = 3; state.stage = 'portal'; }
          if (key === 'mine_obsidian' && state.stage === 'portal') { state.inventory.obsidian = 10; state.stage = 'enter'; }
          if (key === 'enter_portal' && state.stage === 'enter') { state.dimension = 'nether'; state.stage = 'survive'; }
          if (key === 'dig_shelter' && state.stage === 'survive') { state.stage = 'done'; }
          res.end(JSON.stringify({ ok: true, ms: 1 }));
        });
      } else {
        res.end('{}');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state }));
  });
}

function runController (env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['controller.mjs'], { cwd: ROOT, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 25000);
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test('CURRICULUM=first_night: the progression engine drives the chain to the milestone', async () => {
  const { server, port, state } = await startCurriculumHarness();
  const runId = `test-curriculum-${process.pid}-${Date.now()}`;
  const dir = join(ROOT, 'runs', runId);
  const hermes = fakeHermesQueue(['mine_oak_log', 'craft_crafting_table', 'hunt_cow', 'sleep']);
  try {
    const { code, stdout, stderr } = await runController({
      HARNESS: `http://127.0.0.1:${port}`,
      RUN_ID: runId,
      CONTROLLER: 'hermes',
      CURRICULUM: 'first_night',
      MAX_STEPS: '8',
      TARGETS: '{}',
      // The demo waypoint must NOT leak into a milestone plan: it would offer
      // `goto_waypoint` and drag the curriculum to arbitrary coordinates.
      WAYPOINT: '{"x":380,"z":16}',
      SESSION: '',
      AUTONOMY: 'off',
      OPENROUTER_API_KEY: '',
      TYPESAFE_API_KEY: '',
      CHAT_ALLOWLIST: '',
      PATH: `${hermes.path}:${process.env.PATH}`,
    });
    assert.equal(code, 0, `unexpected exit code ${code}; stdout:\n${stdout}\nstderr:\n${stderr}`);

    // The seeded goal is the curriculum one, and it closes on the milestone.
    assert.match(stdout, /GOAL g1 \[curriculum\]/);
    assert.match(stdout, /GOAL MET after 4 actions \(curriculum first_night\)/);
    assert.match(stdout, /GOAL g1 COMPLETED/);
    // Every skill of the chain was verified on harness state.
    for (const skill of ['acquire_wood', 'acquire_crafting_table', 'obtain_food', 'first_night']) {
      assert.match(stdout, new RegExp(`SKILL ${skill} SUCCESS`), `${skill} was not verified`);
    }
    assert.deepEqual(state.acts, ['mine_oak_log', 'craft_crafting_table', 'hunt_cow', 'sleep'],
      'the actions must follow the progression chain');

    const events = readFileSync(join(dir, 'controller.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const plans = events.filter(e => e.type === 'plan');
    assert.deepEqual(
      plans.map(e => e.plan.skill),
      ['acquire_wood', 'acquire_crafting_table', 'obtain_food', 'first_night'],
      'plans must come from the progression graph, in prerequisite order',
    );
    assert.ok(plans.every(e => e.curriculum === true && e.plan.notes === `curriculum:${e.plan.milestone}`),
      'every plan must come from the progression engine');
    assert.ok(plans.every(e => e.plan.waypoint === null),
      'an ambient WAYPOINT must not be inherited by a milestone plan');
    // The milestone must say what it is after, otherwise the decision model
    // picks among the intermediate recipes at random (seen live: five
    // craft_oak_planks and no crafting table).
    const tablePlan = plans.find(e => e.plan.milestone === 'crafting_table');
    assert.deepEqual(tablePlan?.plan.targets, { crafting_table: 1 },
      'the crafting table milestone must carry its target');
    assert.ok(!events.some(e => e.type === 'curriculum_fallback'),
      'the planner must not be needed: the progression engine resolved every milestone');
    // Skill records carry the milestone they close (provenance for the memory layer).
    const skills = readFileSync(join(dir, 'skills.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(
      skills.map(s => [s.skill, s.status, s.context?.milestone]),
      [
        ['acquire_wood', 'success', 'wood'],
        ['acquire_crafting_table', 'success', 'crafting_table'],
        ['obtain_food', 'success', 'food_and_safety'],
        ['first_night', 'success', 'first_night'],
      ],
    );
    const met = events.find(e => e.type === 'goal_met');
    assert.equal(met.curriculum, 'first_night');
    assert.equal(met.steps, 4);
    assert.deepEqual(
      [...met.completedMilestones].sort(),
      ['crafting_table', 'first_night', 'food_and_safety', 'wood'],
    );
    // The goal store keeps the curriculum source and the completed status.
    if (existsSync(join(dir, 'world.json'))) {
      const saved = JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8'));
      const goal = saved.records.find(r => r.kind === 'goal');
      assert.equal(goal.status, 'completed');
      assert.equal(goal.goal.source, 'curriculum');
    }
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(hermes.dir, { recursive: true, force: true });
  }
});

test('CURRICULUM=redstone_automation: the chain ends on a verified circuit, not on an inventory', async () => {
  const { server, port, state } = await startRedstoneHarness();
  const runId = `test-curriculum-redstone-${process.pid}-${Date.now()}`;
  const dir = join(ROOT, 'runs', runId);
  const hermes = fakeHermesQueue(['mine_redstone_ore', 'craft_repeater', 'build_circuit_lamp_switch']);
  try {
    const { code, stdout, stderr } = await runController({
      HARNESS: `http://127.0.0.1:${port}`,
      RUN_ID: runId,
      CONTROLLER: 'hermes',
      CURRICULUM: 'redstone_automation',
      MAX_STEPS: '6',
      TARGETS: '{}',
      WAYPOINT: '{"x":380,"z":16}',
      SESSION: '',
      AUTONOMY: 'off',
      OPENROUTER_API_KEY: '',
      TYPESAFE_API_KEY: '',
      CHAT_ALLOWLIST: '',
      PATH: `${hermes.path}:${process.env.PATH}`,
    });
    assert.equal(code, 0, `unexpected exit code ${code}; stdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.match(stdout, /GOAL MET after 3 actions \(curriculum redstone_automation\)/);
    for (const skill of ['redstone_basics', 'craft_redstone_part', 'build_lamp_switch']) {
      assert.match(stdout, new RegExp(`SKILL ${skill} SUCCESS`), `${skill} was not verified`);
    }
    assert.deepEqual(state.acts, ['mine_redstone_ore', 'craft_repeater', 'build_circuit_lamp_switch'],
      'the actions must follow the redstone chain');

    const events = readFileSync(join(dir, 'controller.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const plans = events.filter(e => e.type === 'plan');
    assert.deepEqual(
      plans.map(e => e.plan.milestone),
      ['redstone_ore', 'redstone_basics', 'redstone_automation'],
      'plans must come from the progression graph, in prerequisite order',
    );
    assert.deepEqual(plans.map(e => e.plan.skill),
      ['redstone_basics', 'craft_redstone_part', 'build_lamp_switch']);
    assert.ok(plans.every(e => e.plan.waypoint === null), 'no ambient waypoint in a milestone plan');
    assert.ok(!events.some(e => e.type === 'curriculum_fallback'), 'the planner must not be needed');

    const skills = readFileSync(join(dir, 'skills.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(
      skills.map(s => [s.skill, s.status, s.context?.milestone]),
      [
        ['redstone_basics', 'success', 'redstone_ore'],
        ['craft_redstone_part', 'success', 'redstone_basics'],
        ['build_lamp_switch', 'success', 'redstone_automation'],
      ],
    );
    // L'evidenza del circuito è quella del verifier, non una deduzione.
    assert.equal(skills[2].context.evidence.circuitBuilt, 'lamp_switch');
    const met = events.find(e => e.type === 'goal_met');
    assert.equal(met.curriculum, 'redstone_automation');
    assert.equal(met.steps, 3);
    assert.deepEqual([...met.completedMilestones].sort(),
      ['redstone_automation', 'redstone_basics', 'redstone_ore']);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(hermes.dir, { recursive: true, force: true });
  }
});

test('CURRICULUM=prepare_for_nether: a composite goal closes only on its last target, and every plan carries the chain (R5)', async () => {
  const { server, port, state } = await startCompositeHarness();
  const runId = `test-curriculum-composite-${process.pid}-${Date.now()}`;
  const dir = join(ROOT, 'runs', runId);
  const hermes = fakeHermesQueue(['mine_diamond_ore', 'mine_obsidian', 'enter_portal', 'dig_shelter']);
  try {
    const { code, stdout, stderr } = await runController({
      HARNESS: `http://127.0.0.1:${port}`,
      RUN_ID: runId,
      CONTROLLER: 'hermes',
      CURRICULUM: 'prepare_for_nether',
      MAX_STEPS: '8',
      TARGETS: '{}',
      WAYPOINT: '',
      SESSION: '',
      AUTONOMY: 'off',
      OPENROUTER_API_KEY: '',
      TYPESAFE_API_KEY: '',
      CHAT_ALLOWLIST: '',
      PATH: `${hermes.path}:${process.env.PATH}`,
    });
    assert.equal(code, 0, `unexpected exit code ${code}; stdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.deepEqual(state.acts, ['mine_diamond_ore', 'mine_obsidian', 'enter_portal', 'dig_shelter'],
      'the actions must walk the composite chain in dependency order');

    const events = readFileSync(join(dir, 'controller.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const plans = events.filter(e => e.type === 'plan');
    assert.deepEqual(plans.map(e => e.plan.milestone),
      ['diamonds', 'nether_portal', 'enter_nether', 'nether_survival'],
      'the chain must be re-derived after every milestone that closes');
    // R5: il piano dichiara **tutta** la catena mancante, e si accorcia da sola.
    assert.deepEqual(plans[0].plan.steps.map(s => s.id),
      ['diamonds', 'nether_portal', 'enter_nether', 'nether_survival']);
    assert.deepEqual(plans.map(e => e.plan.steps.length), [4, 3, 2, 1],
      'every plan carries exactly the milestones still missing');
    assert.equal(plans[0].plan.steps[0].id, plans[0].plan.milestone, 'the first step is the active one');
    assert.ok(plans[0].plan.steps.find(s => s.id === 'enter_nether').verify.includes('dimension'),
      'a step carries the criteria the verifier will use');
    assert.ok(plans.every(e => e.plan.waypoint === null), 'no ambient waypoint in a curriculum plan');
    assert.ok(!events.some(e => e.type === 'curriculum_fallback'), 'the planner must not be needed');

    // La prova del goal composito: `enter_nether` cade al terzo passo (il mondo
    // è cambiato), ma il goal **non** si chiude finche' non cade anche l'ultimo.
    assert.doesNotMatch(stdout, /GOAL MET after 3 actions/, 'a satisfied target must not close a composite goal');
    assert.match(stdout, /GOAL MET after 4 actions \(curriculum prepare_for_nether\)/);
    const met = events.find(e => e.type === 'goal_met');
    assert.deepEqual(met.targets, ['enter_nether', 'nether_survival'], 'the goal_met names both targets');
    assert.deepEqual([...met.completedMilestones].sort(),
      ['diamonds', 'enter_nether', 'nether_portal', 'nether_survival']);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(hermes.dir, { recursive: true, force: true });
  }
});

test('CURRICULUM=first_night: satisfied prerequisites are skipped, only the open one is planned', async () => {
  // The bot already has logs, a crafting table and food: the progression engine
  // must resolve straight to the final milestone instead of replaying a fixed
  // sequence. Night is already falling, so a single `sleep` closes it.
  const { server, port } = await startCurriculumHarness({
    stage: 'sleep',
    inventory: { oak_log: 8, crafting_table: 1, beef: 2 },
    time: { ticks: 14000, night: true, phase: 'night' },
  });
  const runId = `test-curriculum-skip-${process.pid}-${Date.now()}`;
  const dir = join(ROOT, 'runs', runId);
  const hermes = fakeHermesQueue(['sleep']);
  try {
    const { code, stdout } = await runController({
      HARNESS: `http://127.0.0.1:${port}`,
      RUN_ID: runId,
      CONTROLLER: 'hermes',
      CURRICULUM: 'first_night',
      MAX_STEPS: '6',
      TARGETS: '{}',
      WAYPOINT: '',
      SESSION: '',
      AUTONOMY: 'off',
      OPENROUTER_API_KEY: '',
      TYPESAFE_API_KEY: '',
      CHAT_ALLOWLIST: '',
      PATH: `${hermes.path}:${process.env.PATH}`,
    });
    assert.equal(code, 0, `unexpected exit code ${code}; stdout:\n${stdout}`);
    const events = readFileSync(join(dir, 'controller.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const plans = events.filter(e => e.type === 'plan');
    assert.deepEqual(plans.map(e => e.plan.skill), ['first_night'],
      'satisfied prerequisites must not be planned again');
    assert.match(stdout, /GOAL MET after 1 actions \(curriculum first_night\)/);
    const skills = readFileSync(join(dir, 'skills.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(skills.map(s => s.skill), ['first_night']);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(hermes.dir, { recursive: true, force: true });
  }
});
