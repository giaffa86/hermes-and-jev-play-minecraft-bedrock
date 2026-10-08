// Integration smoke for the persistent session loop (AI-player roadmap M0->1).
// Boots a fake harness implementing /observe, then runs controller.mjs with a
// Goal Contract that is already satisfied, so the goal completes without any
// decision model. Verifies: the goal is registered and completed, the loop
// enters IDLE instead of exiting, and the queue is persisted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const OBSERVATION = {
  position: { x: 0, y: 64, z: 0 },
  inventory: { dirt: 2 },
  health: 20,
  dead: false,
  time: { ticks: 1000, night: false },
  entities: [],
  chat: [],
  dropped: [],
  containers: [],
};

function startFakeHarness (observation = OBSERVATION) {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.method === 'GET' && req.url === '/observe') res.end(JSON.stringify(observation));
      else res.end('{}');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// A fake `hermes` CLI so the chat->plan translation does not need a real model.
function fakeHermesBin (plan) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-hermes-'));
  const bin = join(dir, 'hermes');
  writeFileSync(bin, `#!/bin/sh\nprintf '%s' '${JSON.stringify(plan)}'\n`);
  chmodSync(bin, 0o755);
  return { dir, path: dir };
}

// Pre-seed a goal store (as a previous session would have left it) to exercise
// cross-session resume.
function seedGoalStore (runId, goals) {
  const dir = join(ROOT, 'runs', runId, 'goals');
  mkdirSync(dir, { recursive: true });
  const records = goals.map(g => ({
    id: g.id, kind: 'goal', status: g.status,
    goal: {
      id: g.id, type: 'chat', source: 'chat', priority: 80, status: g.status,
      objective: g.objective, plan: g.plan, parameters: null, parentGoal: null,
      attempts: 1, createdAt: 1, startedAt: 1, finishedAt: null, reason: g.reason ?? null, result: null,
    },
  }));
  writeFileSync(join(dir, 'world.json'), JSON.stringify({ version: 2, savedAt: Date.now(), records }));
  return dir;
}

function runController (env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['controller.mjs'], { cwd: ROOT, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 20000);
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

const baseEnv = (runId, port) => ({
  HARNESS: `http://127.0.0.1:${port}`,
  RUN_ID: runId,
  CONTROLLER: 'jev',
  MAX_STEPS: '3',
  GOAL_CONTRACT: JSON.stringify({ goal: 'smoke', success: { inventoryGte: { dirt: 1 } } }),
  OPENROUTER_API_KEY: '',
  TYPESAFE_API_KEY: '',
  CHAT_ALLOWLIST: '',
});

test('session mode: goal completes, then the loop idles and exits on timeout', async () => {
  const { server, port } = await startFakeHarness();
  const runId = `test-session-${process.pid}-${Date.now()}`;
  const dir = join(ROOT, 'runs', runId);
  try {
    const { code, stdout } = await runController({
      ...baseEnv(runId, port),
      SESSION: 'on',
      IDLE_POLL_MS: '100',
      IDLE_TIMEOUT_MS: '800',
    });
    assert.equal(code, 0, `unexpected exit code; stdout:\n${stdout}`);
    assert.match(stdout, /GOAL g1 \[autonomous\]/);
    assert.match(stdout, /GOAL CONTRACT SUCCESS/);
    assert.match(stdout, /GOAL g1 COMPLETED/);
    assert.match(stdout, /IDLE — waiting for a new goal/);
    // persisted queue: one completed goal survives in the run directory
    const file = join(dir, 'goals', 'world.json');
    assert.ok(existsSync(file), 'goal store was not written');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    const goals = saved.records.filter(r => r.kind === 'goal');
    assert.equal(goals.length, 1);
    assert.equal(goals[0].status, 'completed');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('idle accepts a chat order as a new goal (no reconnect, no re-run)', async () => {
  const chatEntry = { at: Date.now(), from: 'Tester', xuid: 'x-tester', message: '@bot dig here' };
  const { server, port } = await startFakeHarness({ ...OBSERVATION, chat: [chatEntry] });
  const runId = `test-chat-goal-${process.pid}-${Date.now()}`;
  const dir = join(ROOT, 'runs', runId);
  const hermes = fakeHermesBin({ objective: 'Dig where the human asked', targets: {}, waypoint: null });
  try {
    const { code, stdout } = await runController({
      ...baseEnv(runId, port),
      SESSION: 'on',
      IDLE_POLL_MS: '100',
      IDLE_TIMEOUT_MS: '1500',
      CHAT_ALLOWLIST: 'Tester',
      PATH: `${hermes.path}:${process.env.PATH}`,
    });
    assert.equal(code, 0, `unexpected exit code; stdout:\n${stdout}`);
    assert.match(stdout, /GOAL g2 \[chat\] Dig where the human asked/);
    assert.match(stdout, /GOAL g2 COMPLETED/);
    const saved = JSON.parse(readFileSync(join(dir, 'goals', 'world.json'), 'utf8'));
    const chatGoal = saved.records.find(r => r.kind === 'goal' && r.goal.source === 'chat');
    assert.ok(chatGoal, 'chat goal was not persisted');
    assert.equal(chatGoal.status, 'completed');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(hermes.dir, { recursive: true, force: true });
  }
});

function startAutonomyHarness () {
  return new Promise(resolve => {
    let acted = false;
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.method === 'GET' && req.url === '/observe') {
        res.end(JSON.stringify({
          ...OBSERVATION, inventory: {}, food: 20, health: 20,
          time: { ticks: acted ? 0 : 13000, night: !acted },
        }));
      } else if (req.method === 'GET' && req.url === '/options') {
        res.end(JSON.stringify({ options: [{ key: 'wait', description: 'wait' }] }));
      } else if (req.method === 'POST' && req.url === '/act') {
        acted = true;
        res.end(JSON.stringify({ ok: true, ms: 1 }));
      } else {
        res.end('{}');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('idle autonomy: a survival need becomes an autonomous goal and completes', async () => {
  const { server, port } = await startAutonomyHarness();
  const runId = `test-autonomy-${process.pid}-${Date.now()}`;
  const dir = join(ROOT, 'runs', runId);
  const hermes = fakeHermesBin({ objective: 'initial plan', targets: {}, waypoint: null });
  try {
    const { code, stdout } = await runController({
      HARNESS: `http://127.0.0.1:${port}`,
      RUN_ID: runId,
      CONTROLLER: 'hermes',
      MAX_STEPS: '5',
      TARGETS: '{}',
      SESSION: 'on',
      AUTONOMY: 'on',
      IDLE_POLL_MS: '50',
      IDLE_TIMEOUT_MS: '1500',
      OPENROUTER_API_KEY: '',
      TYPESAFE_API_KEY: '',
      CHAT_ALLOWLIST: '',
      PATH: `${hermes.path}:${process.env.PATH}`,
    });
    assert.equal(code, 0, `unexpected exit code; stdout:\n${stdout}`);
    assert.match(stdout, /IDLE -> autonomous goal g\d+ \[shelter\]/);
    assert.match(stdout, /GOAL MET/);
    const saved = JSON.parse(readFileSync(join(dir, 'goals', 'world.json'), 'utf8'));
    const shelter = saved.records.find(r => r.kind === 'goal' && r.goal.parameters?.need === 'shelter');
    assert.ok(shelter, 'autonomous shelter goal was not persisted');
    assert.equal(shelter.status, 'completed');
    assert.equal(shelter.goal.source, 'autonomous');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(hermes.dir, { recursive: true, force: true });
  }
});

function startVillageHarness ({ humans = [] } = {}) {
  return new Promise(resolve => {
    let worked = false;
    const said = [];
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.method === 'GET' && req.url === '/observe') {
        res.end(JSON.stringify({
          ...OBSERVATION,
          humans,
          spawned: true,
          inventory: worked ? { wheat: 2 } : {},
          food: 20, health: 20,
          time: { ticks: 1000, night: false },
          nearby: { wheat: worked ? [] : [{ name: 'wheat', position: { x: 1, y: 64, z: 0 }, distance: 1, mature: true }] },
        }));
      } else if (req.method === 'GET' && req.url === '/options') {
        res.end(JSON.stringify({ options: [{ key: 'harvest_wheat', description: 'harvest the wheat' }] }));
      } else if (req.method === 'POST' && req.url === '/act') {
        worked = true;
        res.end(JSON.stringify({ ok: true, ms: 1 }));
      } else if (req.method === 'POST' && req.url === '/say') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try { said.push(JSON.parse(body).message); } catch { said.push(null); }
          res.end(JSON.stringify({ ok: true }));
        });
      } else {
        res.end('{}');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, said }));
  });
}

test('autonomy narration: the idle bot tells a nearby human what it is about to do', async () => {
  const { server, port, said } = await startVillageHarness({ humans: [{ username: '<gamertag1>', distance: 5 }] });
  const runId = `test-narrate-${process.pid}-${Date.now()}`;
  const dir = join(ROOT, 'runs', runId);
  const hermes = fakeHermesBin({ objective: 'initial plan', targets: {}, waypoint: null });
  try {
    const { code, stdout } = await runController({
      HARNESS: `http://127.0.0.1:${port}`,
      RUN_ID: runId,
      CONTROLLER: 'hermes',
      MAX_STEPS: '5',
      TARGETS: '{}',
      SESSION: 'on',
      AUTONOMY: 'off',
      VILLAGE_WORK: 'on',
      VILLAGE_COOLDOWN_MS: '50',
      IDLE_POLL_MS: '50',
      IDLE_TIMEOUT_MS: '1500',
      CHAT_ALLOWLIST: '<gamertag1>',
      CHAT_REPLY: 'on',
      OPENROUTER_API_KEY: '',
      TYPESAFE_API_KEY: '',
      PATH: `${hermes.path}:${process.env.PATH}`,
    });
    assert.equal(code, 0, `unexpected exit code; stdout:\n${stdout}`);
    assert.match(stdout, /IDLE -> village chore g\d+ \[harvest_crops\]/);
    // The concrete crop the census saw, in the configured language, one line.
    assert.match(stdout, /NARRATE \[g\d+\] In autonomia: sto raccogliendo il grano/);
    assert.ok(said.includes('In autonomia: sto raccogliendo il grano'), `narration never reached /say: ${JSON.stringify(said)}`);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(hermes.dir, { recursive: true, force: true });
  }
});

test('village labor: the idle bot picks an offered chore and closes it on a state delta', async () => {
  const { server, port } = await startVillageHarness();
  const runId = `test-village-${process.pid}-${Date.now()}`;
  const dir = join(ROOT, 'runs', runId);
  const hermes = fakeHermesBin({ objective: 'initial plan', targets: {}, waypoint: null });
  try {
    const { code, stdout } = await runController({
      HARNESS: `http://127.0.0.1:${port}`,
      RUN_ID: runId,
      CONTROLLER: 'hermes',
      MAX_STEPS: '5',
      TARGETS: '{}',
      SESSION: 'on',
      AUTONOMY: 'off',
      VILLAGE_WORK: 'on',
      VILLAGE_COOLDOWN_MS: '50',
      IDLE_POLL_MS: '50',
      IDLE_TIMEOUT_MS: '1500',
      OPENROUTER_API_KEY: '',
      TYPESAFE_API_KEY: '',
      CHAT_ALLOWLIST: '',
      PATH: `${hermes.path}:${process.env.PATH}`,
    });
    assert.equal(code, 0, `unexpected exit code; stdout:\n${stdout}`);
    assert.match(stdout, /IDLE -> village chore g\d+ \[harvest_crops\]/);
    assert.match(stdout, /GOAL MET/);
    const saved = JSON.parse(readFileSync(join(dir, 'goals', 'world.json'), 'utf8'));
    const chore = saved.records.find(r => r.kind === 'goal' && r.goal.parameters?.chore === 'harvest_crops');
    assert.ok(chore, 'village chore goal was not persisted');
    assert.equal(chore.status, 'completed');
    assert.equal(chore.goal.source, 'autonomous');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(hermes.dir, { recursive: true, force: true });
  }
});

// M3c: a productive goal closes by carrying its harvest to the chest. The
// epilogue is a child goal, so it closes on the same state delta (the wheat
// really left the pack), never on the model's word.
function startEpilogueHarness () {
  return new Promise(resolve => {
    let harvested = false;
    let stored = false;
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.method === 'GET' && req.url === '/observe') {
        const depositable = harvested && !stored;
        res.end(JSON.stringify({
          ...OBSERVATION,
          humans: [],
          spawned: true,
          inventory: stored ? { wheat: 2 } : harvested ? { wheat: 3 } : {},
          health: 20,
          food: 20,
          nearby: harvested ? {} : { wheat: [{ name: 'wheat', position: { x: 1, y: 64, z: 0 }, distance: 1, mature: true }] },
          deposit: depositable
            ? { items: [{ item: 'wheat', count: 3 }], total: 3, target: { type: 'chest', position: { x: 2, y: 64, z: 0 }, distance: 2 }, at: Date.now() }
            : { items: [], total: 0, target: null, at: Date.now() },
        }));
      } else if (req.method === 'GET' && req.url === '/options') {
        // The census changed: once the crop is in the pack, harvesting is no
        // longer offered and only the chest is worth an action.
        const options = harvested
          ? [{ key: 'deposit_wheat', description: 'store the wheat' }]
          : [{ key: 'harvest_wheat', description: 'harvest the wheat' }];
        res.end(JSON.stringify({ options }));
      } else if (req.method === 'POST' && req.url === '/act') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          let key = null;
          try { key = JSON.parse(body).key; } catch { key = null; }
          if (key === 'harvest_wheat') harvested = true;
          if (key === 'deposit_wheat') stored = true;
          res.end(JSON.stringify({ ok: true, ms: 1 }));
        });
      } else {
        res.end('{}');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('village labor: a finished harvest walks what it gathered to the chest', async () => {
  const { server, port } = await startEpilogueHarness();
  const runId = `test-epilogue-${process.pid}-${Date.now()}`;
  const dir = join(ROOT, 'runs', runId);
  const hermes = fakeHermesBin({ objective: 'initial plan', targets: {}, waypoint: null });
  try {
    const { code, stdout } = await runController({
      HARNESS: `http://127.0.0.1:${port}`,
      RUN_ID: runId,
      CONTROLLER: 'hermes',
      MAX_STEPS: '5',
      TARGETS: '{}',
      SESSION: 'on',
      AUTONOMY: 'off',
      VILLAGE_WORK: 'on',
      VILLAGE_COOLDOWN_MS: '50',
      IDLE_POLL_MS: '50',
      IDLE_TIMEOUT_MS: '1500',
      OPENROUTER_API_KEY: '',
      TYPESAFE_API_KEY: '',
      CHAT_ALLOWLIST: '',
      PATH: `${hermes.path}:${process.env.PATH}`,
    });
    assert.equal(code, 0, `unexpected exit code; stdout:\n${stdout}`);
    const harvest = stdout.match(/IDLE -> village chore (g\d+) \[harvest_crops\]/);
    assert.ok(harvest, `the harvest chore never started:\n${stdout}`);
    const epilogue = stdout.match(/STORE EPILOGUE after g\d+ -> village chore (g\d+) \[store_harvest\]/);
    assert.ok(epilogue, `the harvest was never carried to the chest:\n${stdout}`);
    const saved = JSON.parse(readFileSync(join(dir, 'goals', 'world.json'), 'utf8'));
    const store = saved.records.find(r => r.kind === 'goal' && r.goal.parameters?.chore === 'store_harvest');
    assert.ok(store, 'the epilogue goal was not persisted');
    assert.equal(store.status, 'completed', 'the epilogue did not close on the state delta');
    assert.equal(store.goal.parameters.epilogueOf, harvest[1]);
    assert.equal(store.goal.plan.chore, 'store_harvest');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(hermes.dir, { recursive: true, force: true });
  }
});

test('cross-session resume: a goal left running is resumed and completed', async () => {
  const { server, port } = await startFakeHarness();
  const runId = `test-resume-${process.pid}-${Date.now()}`;
  const dir = seedGoalStore(runId, [{
    id: 'g7', status: 'running', objective: 'resumed goal from a previous session',
    plan: { objective: 'resumed goal from a previous session', targets: { dirt: 1 }, waypoint: null },
  }]);
  try {
    const { code, stdout } = await runController({
      ...baseEnv(runId, port), SESSION: 'on', IDLE_POLL_MS: '100', IDLE_TIMEOUT_MS: '600',
    });
    assert.equal(code, 0, `unexpected exit code; stdout:\n${stdout}`);
    assert.match(stdout, /RESUME 1 goal\(s\) from a previous session: g7/);
    assert.match(stdout, /GOAL g7 COMPLETED/);
    assert.doesNotMatch(stdout, /GOAL g1 \[/, 'a new goal was seeded despite resumable work');
    const saved = JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8'));
    const ids = saved.records.map(r => r.id);
    assert.deepEqual(ids, ['g7'], 'only the resumed goal should exist');
    assert.equal(saved.records[0].status, 'completed');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resume off (RESUME=off) does not resurrect a suspended goal', async () => {
  const { server, port } = await startFakeHarness();
  const runId = `test-noresume-${process.pid}-${Date.now()}`;
  const dir = seedGoalStore(runId, [{
    id: 'g9', status: 'suspended', objective: 'stale suspended goal',
    plan: { objective: 'stale suspended goal', targets: { dirt: 1 }, waypoint: null },
  }]);
  try {
    const { code, stdout } = await runController({
      ...baseEnv(runId, port), SESSION: 'on', RESUME: 'off', IDLE_POLL_MS: '100', IDLE_TIMEOUT_MS: '600',
    });
    assert.equal(code, 0, `unexpected exit code; stdout:\n${stdout}`);
    assert.doesNotMatch(stdout, /RESUME /);
    assert.match(stdout, /GOAL g10 \[autonomous\]/);
    const saved = JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8'));
    const stale = saved.records.find(r => r.id === 'g9');
    assert.equal(stale.status, 'suspended', 'suspended goal must stay suspended with RESUME=off');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function startEmergencyHarness ({ dirtAt = 4 } = {}) {
  return new Promise(resolve => {
    let acts = 0;
    let deathSite = null;
    let dirt = 2;
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.method === 'GET' && req.url === '/observe') {
        res.end(JSON.stringify({
          ...OBSERVATION, inventory: { dirt }, dirt, deathSite, drops: deathSite ? [{ item: 'diamond' }] : [],
        }));
      } else if (req.method === 'GET' && req.url === '/options') {
        res.end(JSON.stringify({ options: deathSite
          ? [{ key: 'recover_loot', description: 'recover the death site' }]
          : [{ key: 'wait', description: 'wait' }] }));
      } else if (req.method === 'POST' && req.url === '/act') {
        acts += 1;
        if (acts === 1) deathSite = { position: { x: 0, y: 64, z: 0 }, at: Date.now() };
        // recover_loot clears the site only on the 3rd call, so the emergency
        // goal survives a periodic replan (REPLAN_EVERY=2) without losing
        // `plan.recover`; `dirtAt` decide quando il bottino recuperato porta la
        // scorta al bersaglio del padre.
        if (deathSite && acts >= 4) deathSite = null;
        if (acts >= dirtAt) dirt = 5;
        res.end(JSON.stringify({ ok: true, ms: 1 }));
      } else {
        res.end('{}');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('emergency: a death preempts the running goal, recovers loot and resumes it', async () => {
  const { server, port } = await startEmergencyHarness();
  const runId = `test-emergency-${process.pid}-${Date.now()}`;
  const dir = join(ROOT, 'runs', runId);
  const hermes = fakeHermesBin({ objective: 'collect dirt', targets: {}, waypoint: null });
  try {
    const { code, stdout } = await runController({
      HARNESS: `http://127.0.0.1:${port}`,
      RUN_ID: runId,
      CONTROLLER: 'hermes',
      MAX_STEPS: '6',
      TARGETS: '{"dirt":5}',
      WAYPOINT: '',
      GOAL: 'Collect 5 dirt',
      SESSION: 'on',
      EMERGENCY: 'on',
      AUTONOMY: 'off',
      REPLAN_EVERY: '2',
      ANTI_LOOP_THRESHOLD: '10',
      IDLE_POLL_MS: '50',
      IDLE_TIMEOUT_MS: '800',
      OPENROUTER_API_KEY: '',
      TYPESAFE_API_KEY: '',
      CHAT_ALLOWLIST: '',
      PATH: `${hermes.path}:${process.env.PATH}`,
    });
    assert.equal(code, 0, `unexpected exit code; stdout:\n${stdout}`);
    assert.match(stdout, /EMERGENCY PLAYER_DIED: suspend g1 -> run g2/);
    assert.match(stdout, /GOAL g2 \[emergency\] Recover the dropped items/);
    assert.match(stdout, /GOAL g2 COMPLETED/);
    assert.match(stdout, /GOAL g1 COMPLETED/); // the parent resumed and finished
    const saved = JSON.parse(readFileSync(join(dir, 'goals', 'world.json'), 'utf8'));
    const byId = Object.fromEntries(saved.records.map(r => [r.id, r]));
    assert.equal(byId.g1.status, 'completed');
    assert.equal(byId.g2.status, 'completed');
    assert.equal(byId.g2.goal.source, 'emergency');
    assert.equal(byId.g2.goal.parentGoal, 'g1');
    // The emergency goal must not be re-planned (that would drop plan.recover).
    const events = readFileSync(join(dir, 'controller.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.ok(events.some(e => e.type === 'replan_skipped' && e.recover === true),
      'the emergency goal must skip replanning to keep plan.recover');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(hermes.dir, { recursive: true, force: true });
  }
});

// 08/10/2026, in missione (`SESSION=off`): la morte del bot sospende il goal, il
// goal di emergenza recupera il bottino, il padre viene rimesso in coda… e il
// processo esce con `EXIT=0` subito dopo il `RESUME`, lasciando il goal padre
// orfano a metà spedizione. Un goal rimesso in coda è lavoro ancora aperto: si
// esce solo quando la coda è vuota.
test('one-shot mode: a resumed parent is finished before the process exits', async () => {
  const { server, port } = await startEmergencyHarness({ dirtAt: 6 });
  const runId = `test-emergency-oneshot-${process.pid}-${Date.now()}`;
  const dir = join(ROOT, 'runs', runId);
  const hermes = fakeHermesBin({ objective: 'collect dirt', targets: {}, waypoint: null });
  try {
    const { code, stdout } = await runController({
      HARNESS: `http://127.0.0.1:${port}`,
      RUN_ID: runId,
      CONTROLLER: 'hermes',
      MAX_STEPS: '6',
      TARGETS: '{"dirt":5}',
      WAYPOINT: '',
      GOAL: 'Collect 5 dirt',
      SESSION: 'off',
      EMERGENCY: 'on',
      AUTONOMY: 'off',
      REPLAN_EVERY: '2',
      ANTI_LOOP_THRESHOLD: '10',
      OPENROUTER_API_KEY: '',
      TYPESAFE_API_KEY: '',
      CHAT_ALLOWLIST: '',
      PATH: `${hermes.path}:${process.env.PATH}`,
    });
    assert.equal(code, 0, `unexpected exit code; stdout:\n${stdout}`);
    assert.match(stdout, /RESUME g1 \(suspended while g2 ran\)/, 'il padre torna in coda');
    assert.match(stdout, /GOAL g1 COMPLETED/, 'e viene portato a termine prima di uscire');
    const saved = JSON.parse(readFileSync(join(dir, 'goals', 'world.json'), 'utf8'));
    assert.equal(Object.fromEntries(saved.records.map(r => [r.id, r])).g1.status, 'completed');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(hermes.dir, { recursive: true, force: true });
  }
});

test('one-shot mode (default): exits after the goal without idling', async () => {
  const { server, port } = await startFakeHarness();
  const runId = `test-oneshot-${process.pid}-${Date.now()}`;
  const dir = join(ROOT, 'runs', runId);
  try {
    const { code, stdout } = await runController(baseEnv(runId, port));
    assert.equal(code, 0, `unexpected exit code; stdout:\n${stdout}`);
    assert.match(stdout, /GOAL g1 COMPLETED/);
    assert.doesNotMatch(stdout, /IDLE — waiting for a new goal/);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
