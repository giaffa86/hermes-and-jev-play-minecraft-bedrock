// A chat order that asks for an action but whose plan declares no terminal
// criterion (no targets, no waypoint, no follow, no need, no skill) used to be
// "met" at step 0: live, the order «mangia le patate che hai» ended with
// `GOAL MET after 0 actions` and the chat got a "fatto" that never happened.
// Now such an order must run at least one *successful* action before it closes.
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

// Il piano tradotto dall'ordine non ha nulla di terminale: e' il caso che
// chiudeva il goal a zero azioni.
function startOpenPlanHarness ({ orderFrom = 'Ale', orderMessage = '@bot mangia le patate che hai' } = {}) {
  return new Promise(resolve => {
    const calls = [];
    let observes = 0;
    const orderAt = Date.now();
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const path = req.url.split('?')[0];
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch { /* ignore */ }
        calls.push({ method: req.method, path, payload });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.method === 'GET' && path === '/observe') {
          observes += 1;
          res.end(JSON.stringify({
            position: { x: 0, y: 64, z: 0 },
            inventory: { potato: 2 },
            health: 20, food: 20, dead: false, spawned: true,
            time: { ticks: 1000, night: false, phase: 'day' },
            entities: [], dropped: [], containers: [], humans: [],
            survival: { mode: 'normal', risk: 0, rule: null, needs: [], reasons: [] },
            // L'ordine arriva dopo il primo giro: viene raccolto in IDLE, come live.
            chat: observes >= 3 ? [{ from: orderFrom, message: orderMessage, type: 'chat', xuid: '1234567890', at: orderAt }] : [],
          }));
        } else if (req.method === 'GET' && path === '/options') {
          res.end(JSON.stringify({ options: [{ key: 'eat', description: 'Eat the potato you are holding' }, { key: 'wait', description: 'Wait' }] }));
        } else if (path === '/act') res.end(JSON.stringify({ ok: true, ms: 5 }));
        else if (path === '/say') res.end(JSON.stringify({ ok: true, sent: payload.message }));
        else if (path === '/plan') res.end(JSON.stringify({ ok: true }));
        else if (path === '/mission') res.end(JSON.stringify({ ok: true, mission: { id: 'mission_test', type: payload.type, intent: payload.intent } }));
        else if (path === '/mission/finish') res.end(JSON.stringify({ ok: true, mission: { id: payload.missionId, ...payload } }));
        else if (path === '/mission/action' || path === '/mission/link') res.end(JSON.stringify({ ok: true, id: 'x1' }));
        else res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, calls, observes: () => observes }));
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

const INIT_PLAN = JSON.stringify({ objective: 'Wait for chat orders', targets: {}, waypoint: null, follow: null, notes: 'test' });
const OPEN_PLAN = JSON.stringify({ objective: 'Eat the potatoes you have', targets: {}, waypoint: null, follow: null, notes: 'test' });

const baseEnv = (runId, port, hermesPath) => ({
  HARNESS: `http://127.0.0.1:${port}`,
  RUN_ID: runId,
  PATH: `${hermesPath}:${process.env.PATH}`,
  CONTROLLER: 'hermes',
  SESSION: '1',
  GOAL: 'Wait for chat orders',
  IDLE_POLL_MS: '50',
  IDLE_TIMEOUT_MS: '2000',
  AUTONOMY: '',
  MAX_STEPS: '4',
  REPLAN_EVERY: '8',
  FOLLOW_IDLE_POLL_MS: '20',
  ANTI_LOOP_THRESHOLD: '3',
  ANTI_LOOP_COOLDOWN: '3',
  TARGETS: '{}',
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

test('a chat order with an empty plan runs an action before saying it is done', async () => {
  const harness = await startOpenPlanHarness();
  const fake = fakeHermesQueue([INIT_PLAN, OPEN_PLAN, 'eat']);
  const runId = `test-chat-open-plan-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController(baseEnv(runId, harness.port, fake.dir));
    assert.equal(code, 0, `the controller exits cleanly (stdout: ${stdout.slice(-600)})`);

    const acts = harness.calls.filter(c => c.path === '/act').map(c => c.payload.key);
    assert.deepEqual(acts, ['eat'], `the order is actually executed (acts: ${JSON.stringify(acts)})`);

    const events = readEvents(runId);
    const chatGoal = events.filter(e => e.type === 'goal_start' && e.source === 'chat');
    assert.equal(chatGoal.length, 1, 'the order becomes a chat goal');
    const met = events.filter(e => e.type === 'goal_met');
    assert.equal(met.length, 2, 'the seeded idle goal and the chat order both close');
    assert.equal(met.at(-1).steps, 1, `the chat order closes only after one action (got ${met.at(-1).steps})`);
    assert.equal(events.filter(e => e.type === 'human_order').length, 1, 'the order is logged once');

    const says = harness.calls.filter(c => c.method === 'POST' && c.path === '/say').map(c => c.payload.message);
    assert.equal(says[0], '@Ale ok: Eat the potatoes you have', `the order is acked (got ${JSON.stringify(says)})`);
    assert.equal(says.some(m => /^@Ale fatto: Eat the potatoes you have/.test(m)), true, `the outcome is reported (got ${JSON.stringify(says)})`);

    assert.match(stdout, /from Ale: Eat the potatoes you have/, 'the order is visible in the log');
    assert.match(stdout, /GOAL MET after 1 actions/, 'the goal closes with one action, not zero');
    assert.equal(fake.calls().length, 3, `the planner translates the order and picks the action (calls: ${JSON.stringify(fake.calls())})`);
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('an open chat order is not closed on a failed action', async () => {
  // Se l'unica azione disponibile fallisce, l'ordine vuoto non puo' dirsi
  // concluso: resta aperto e consuma il budget (poi l'IDLE riprende).
  const offline = await new Promise(resolve => {
    let observes = 0;
    const orderAt = Date.now();
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const path = req.url.split('?')[0];
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch { /* ignore */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.method === 'GET' && path === '/observe') {
          observes += 1;
          res.end(JSON.stringify({
            position: { x: 0, y: 64, z: 0 }, inventory: { potato: 2 }, health: 20, food: 20, dead: false, spawned: true,
            time: { ticks: 1000, night: false, phase: 'day' }, entities: [], dropped: [], containers: [], humans: [],
            survival: { mode: 'normal', risk: 0, rule: null, needs: [], reasons: [] },
            chat: observes >= 3 ? [{ from: 'Ale', message: '@bot mangia le patate che hai', type: 'chat', xuid: '1234567890', at: orderAt }] : [],
          }));
        } else if (req.method === 'GET' && path === '/options') {
          res.end(JSON.stringify({ options: [{ key: 'eat', description: 'Eat the potato you are holding' }] }));
        } else if (path === '/act') res.end(JSON.stringify({ ok: false, error: 'no_food', ms: 5 }));
        else if (path === '/say') res.end(JSON.stringify({ ok: true, sent: payload.message }));
        else if (path === '/plan') res.end(JSON.stringify({ ok: true }));
        else if (path === '/mission') res.end(JSON.stringify({ ok: true, mission: { id: 'm', type: payload.type, intent: payload.intent } }));
        else if (path === '/mission/finish') res.end(JSON.stringify({ ok: true, mission: { id: payload.missionId, ...payload } }));
        else res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
  const fake = fakeHermesQueue([INIT_PLAN, OPEN_PLAN, 'eat', 'eat', 'eat', 'eat', 'eat']);
  const runId = `test-chat-open-plan-fail-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController(baseEnv(runId, offline.port, fake.dir));
    assert.equal(code, 0, `the controller exits cleanly (stdout: ${stdout.slice(-400)})`);
    const events = readEvents(runId);
    const chatMet = events.filter(e => e.type === 'goal_met' && e.steps > 0);
    assert.equal(chatMet.length, 0, 'a failed action does not close an empty order as done');
    const exhausted = events.filter(e => e.type === 'budget_exhausted');
    assert.equal(exhausted.length >= 1, true, `the open order ends on the budget, not on a fake success (got ${JSON.stringify(events.map(e => e.type))})`);
  } finally {
    offline.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});
