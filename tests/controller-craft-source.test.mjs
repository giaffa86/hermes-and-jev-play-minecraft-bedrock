// Integration test for the material-sourcing rule (patch 15): when the order is
// "build a wooden pickaxe" and the plan declares it in `targets`, the harness
// derives what is missing and where to take it (inventory → known chest →
// natural block) and the controller executes that step deterministically —
// no model call, never a step that would dismantle a building.
//
// The scripted harness walks the whole ladder in one goal: the planks come from
// a chest, the sticks are crafted from the planks just taken (an intermediate),
// and only then the pickaxe is crafted — at which point the goal is met.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function fakeHermesQueue (outputs) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-hermes-'));
  const queuePath = join(dir, 'queue.json');
  const popPath = join(dir, 'pop.mjs');
  writeFileSync(queuePath, JSON.stringify(outputs));
  writeFileSync(popPath, `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const path = ${JSON.stringify(queuePath)};
const queue = JSON.parse(readFileSync(path, 'utf8'));
const next = queue.shift() ?? 'wait';
writeFileSync(path, JSON.stringify(queue));
appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, JSON.stringify(next) + '\\n');
process.stdout.write(next);
`);
  const bin = join(dir, 'hermes');
  writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(popPath)}\n`);
  chmodSync(bin, 0o755);
  return {
    dir,
    calls: () => (existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean) : []),
  };
}

// Il ladder completo, come lo calcolerebbe l'adapter: i bauli prima della
// raccolta, l'intermedio fabbricabile prima del baulo successivo.
const CRAFT_STEPS = [
  { key: 'take_oak_planks', source: 'chest', item: 'oak_planks', ingredient: '#planks', target: 'wooden_pickaxe', short: 3, reason: 'take_from_chest' },
  { key: 'craft_stick', source: 'inventory', item: 'stick', ingredient: '#planks', target: 'wooden_pickaxe', short: 2, reason: 'craft_from_inventory' },
  { key: 'craft_wooden_pickaxe', source: 'inventory', item: 'wooden_pickaxe', target: 'wooden_pickaxe', reason: 'craft_target_ready' },
];

function startCraftHarness ({ stopAfterActs = 3 } = {}) {
  return new Promise(resolve => {
    const calls = [];
    let observes = 0;
    let acts = 0;
    const inventory = () => {
      if (acts >= stopAfterActs) return { oak_planks: 4, stick: 2, wooden_pickaxe: 1 };
      if (acts === 2) return { oak_planks: 4, stick: 4 };
      if (acts === 1) return { oak_planks: 6 };
      return {};
    };
    const next = () => (acts < CRAFT_STEPS.length ? CRAFT_STEPS[acts] : null);
    const options = () => {
      const step = next();
      return [
        ...(step ? [{ key: step.key, description: `Craft or take ${step.item} for wooden_pickaxe` }] : []),
        { key: 'wait', description: 'Wait for something to happen' },
      ];
    };
    const observation = () => ({
      position: { x: 0, y: 64, z: 0 },
      inventory: inventory(),
      health: 20, food: 20, dead: false, spawned: true,
      time: { ticks: 1000, night: false, phase: 'day' },
      entities: [], dropped: [], containers: [], humans: [], chat: [],
      follow: null,
      craft: {
        rule: 'inventory_first_then_chests_never_buildings',
        targets: [{ item: 'wooden_pickaxe', need: 1, have: inventory().wooden_pickaxe || 0 }],
        next: next(),
      },
      survival: { mode: 'normal', risk: 0, rule: null, needs: [], reasons: [] },
    });
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const path = req.url.split('?')[0];
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch { /* ignore */ }
        calls.push({ method: req.method, path, payload });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.method === 'GET' && path === '/observe') { observes += 1; res.end(JSON.stringify(observation())); }
        else if (req.method === 'GET' && path === '/options') res.end(JSON.stringify({ options: options() }));
        else if (path === '/act') { acts += 1; res.end(JSON.stringify({ ok: true, ms: 0 })); }
        else if (path === '/say') res.end(JSON.stringify({ ok: true, sent: payload.message }));
        else if (path === '/plan') res.end(JSON.stringify({ ok: true }));
        else if (path === '/mission') res.end(JSON.stringify({ ok: true, mission: { id: 'mission_test', type: payload.type, intent: payload.intent } }));
        else if (path === '/mission/finish') res.end(JSON.stringify({ ok: true, mission: { id: payload.missionId, ...payload } }));
        else if (path === '/mission/action' || path === '/mission/link') res.end(JSON.stringify({ ok: true, id: 'x1' }));
        else res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, calls, acts: () => acts, observes: () => observes }));
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

const INIT_PLAN = JSON.stringify({ objective: 'Build a wooden pickaxe', targets: { wooden_pickaxe: 1 }, waypoint: null, follow: null, notes: 'test' });

const baseEnv = (runId, port, hermesPath) => ({
  HARNESS: `http://127.0.0.1:${port}`,
  RUN_ID: runId,
  PATH: `${hermesPath}:${process.env.PATH}`,
  CONTROLLER: 'hermes',
  SESSION: '1',
  IDLE_POLL_MS: '50',
  IDLE_TIMEOUT_MS: '2000',
  AUTONOMY: '',
  MAX_STEPS: '4',
  REPLAN_EVERY: '8',
  FOLLOW_IDLE_POLL_MS: '20',
  ANTI_LOOP_THRESHOLD: '3',
  ANTI_LOOP_COOLDOWN: '3',
  TARGETS: '{"wooden_pickaxe":1}',
  CHAT_ALLOWLIST: 'Ale',
  CHAT_CONTROL: 'on',
  CHAT_GREET: 'off',
  CHAT_REPLY: 'on',
  OPENROUTER_API_KEY: '',
  TYPESAFE_API_KEY: '',
});

function readEvents (runId) {
  const file = join(ROOT, 'runs', runId, 'controller.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return { type: 'unparsable', line }; }
  });
}

test('the materials come from the inventory, then a chest, never from a building', async () => {
  const harness = await startCraftHarness();
  const fake = fakeHermesQueue([INIT_PLAN]);
  const runId = `test-craft-source-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController(baseEnv(runId, harness.port, fake.dir));
    assert.equal(code, 0, `the controller exits cleanly (stdout: ${stdout.slice(-600)})`);

    const acts = harness.calls.filter(c => c.path === '/act').map(c => c.payload.key);
    assert.deepEqual(acts, ['take_oak_planks', 'craft_stick', 'craft_wooden_pickaxe'],
      `the ladder runs chest -> intermediate -> target (acts: ${JSON.stringify(acts)})`);
    assert.equal(acts.includes('wait'), false, 'the ladder never falls back on a blind wait');
    assert.equal(acts.some(k => /^(mine|dig)_/.test(k)), false, 'nothing is gathered while the chest has the material');

    const events = readEvents(runId);
    const crafted = events.filter(e => e.type === 'craft_source');
    assert.deepEqual(crafted.map(e => [e.key, e.source]), [
      ['take_oak_planks', 'chest'],
      ['craft_stick', 'inventory'],
      ['craft_wooden_pickaxe', 'inventory'],
    ], `each step is announced with its source (got ${JSON.stringify(crafted.map(e => e.key))})`);
    assert.equal(crafted.every(e => e.target === 'wooden_pickaxe'), true, 'every step serves the declared target');
    assert.equal(events.some(e => e.type === 'anti_loop'), false, 'a progressing ladder is not stagnation');
    assert.equal(events.some(e => e.type === 'replan'), false, 'no replan while the ladder is advancing');
    assert.equal(events.filter(e => e.type === 'goal_met').length, 1, 'the goal closes exactly once');

    // Il modello serve solo per il piano iniziale del goal seminato.
    assert.equal(fake.calls().length, 1, `the ladder is deterministic (calls: ${JSON.stringify(fake.calls())})`);

    assert.match(stdout, /CRAFT SOURCE take_oak_planks \(chest for wooden_pickaxe\)/, 'the chest step is visible in the log');
    assert.match(stdout, /CRAFT SOURCE craft_stick \(inventory for wooden_pickaxe\)/, 'the intermediate craft is visible');
    assert.match(stdout, /CRAFT SOURCE craft_wooden_pickaxe \(inventory for wooden_pickaxe\)/, 'the final craft is visible');
    assert.match(stdout, /GOAL MET/, 'the goal is reported as met');
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('a craft step the harness does not offer is left to the planner', async () => {
  // Se la regola propone un passo che l'harness non offre (es. il baulo è
  // sparito fra l'osservazione e l'azione), il controller non lo esegue a
  // forza: torna al modello con le opzioni reali.
  const offline = await new Promise(resolve => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const path = req.url.split('?')[0];
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch { /* ignore */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.method === 'GET' && path === '/observe') {
          res.end(JSON.stringify({
            position: { x: 0, y: 64, z: 0 }, inventory: {}, health: 20, food: 20, dead: false, spawned: true,
            time: { ticks: 1000, night: false, phase: 'day' }, entities: [], dropped: [], containers: [], humans: [], chat: [],
            craft: { rule: 'inventory_first_then_chests_never_buildings', targets: [{ item: 'wooden_pickaxe', need: 1, have: 0 }], next: CRAFT_STEPS[0] },
          }));
        } else if (req.method === 'GET' && path === '/options') {
          res.end(JSON.stringify({ options: [{ key: 'mine_oak_log', description: 'Mine oak_log' }, { key: 'wait', description: 'Wait' }] }));
        } else if (path === '/act') res.end(JSON.stringify({ ok: true, ms: 5 }));
        else if (path === '/say') res.end(JSON.stringify({ ok: true, sent: payload.message }));
        else if (path === '/plan') res.end(JSON.stringify({ ok: true }));
        else if (path === '/mission') res.end(JSON.stringify({ ok: true, mission: { id: 'm', type: payload.type, intent: payload.intent } }));
        else if (path === '/mission/finish') res.end(JSON.stringify({ ok: true, mission: { id: payload.missionId, ...payload } }));
        else res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
  const fake = fakeHermesQueue([INIT_PLAN, JSON.stringify({ objective: 'Gather oak logs for the pickaxe', targets: { wooden_pickaxe: 1 }, waypoint: { x: 0, z: 2 }, follow: null, notes: 'test' })]);
  const runId = `test-craft-source-fallback-${process.pid}-${Date.now()}`;
  try {
    const { code } = await runController(baseEnv(runId, offline.port, fake.dir));
    assert.equal(code, 0, 'the controller exits cleanly');
    const events = readEvents(runId);
    assert.equal(events.some(e => e.type === 'craft_source'), false,
      'an unoffered step is not executed: the planner chooses among the real options');
    assert.equal(fake.calls().length >= 2, true, 'the model is consulted for the step');
  } finally {
    offline.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});
