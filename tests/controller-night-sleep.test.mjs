// Integration tests for the survival-need rule of the night (live 04/10):
// "adesso e' notte ma il bot e' rimasto sveglio (se e' notte ed in superficie la
// priorita' e' dormire nonostante tutto)".
//
// The harness/governor already did the right thing (`needs: ['sleep']` with the
// `night_with_bed` rule, plus a `sleep` option). The controller did not:
//   - in IDLE the needs-driven autonomy sat behind AUTONOMY (off in production),
//     so after the seeded goal (met in 0 actions) the bot waited all night;
//   - inside a goal the action was the model's choice, which could ignore the
//     need (a waypoint to walk, a follow order to keep).
// Expected now: a need the governor declares *right now* becomes a goal even
// with AUTONOMY off, and inside a goal a need the harness can execute (same name
// as the option) wins over everything — including an open follow order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Fake `hermes` CLI (scripted queue, `calls.log` for counting) — same contract as
// tests/controller-follow-order.test.mjs: the initial plan call comes first.
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

// Harness with a bed and a night that ends only when `sleep` is executed. With
// `chat` it also serves a follow order (and, after `stopAfterActs`, the closing
// order) so the night rule can be tested while a chat goal is open.
function startNightHarness ({ offerSleep = true, offerFollow = false, chat = false, stopAfterActs = 4, followFrom = 'Ale' } = {}) {
  return new Promise(resolve => {
    const calls = [];
    let night = true;
    let acts = 0;
    let observes = 0;
    let followActs = 0;
    const followAt = Date.now();
    const stopAt = followAt + 1;
    const observation = () => ({
      position: { x: 0, y: 64, z: 0 },
      inventory: { dirt: 2 },
      health: 20, food: 20, dead: false, spawned: true,
      time: { ticks: night ? 13000 : 0, night, phase: night ? 'night' : 'day' },
      bed: { position: { x: 3, y: 64, z: 0 }, distance: 3 },
      entities: [], dropped: [], containers: [],
      humans: offerFollow ? [{ username: followFrom, distance: 2.8, position: { x: 0, y: 64, z: 2.8 } }] : [],
      chat: chat && observes >= 1
        ? [acts >= stopAfterActs
            ? { from: followFrom, message: '@bot fermati', type: 'chat', xuid: '1234567890', at: stopAt }
            : { from: followFrom, message: '@bot seguimi', type: 'chat', xuid: '1234567890', at: followAt }]
        : [],
    });
    const options = () => [
      ...(offerSleep && night ? [{ key: 'sleep', description: 'Sleep in the bed at {"x":3,"y":64,"z":0} (3.0 blocks away) before the night is dangerous' }] : []),
      ...(offerFollow ? [{ key: 'follow_player', description: `Follow ${followFrom} (2.8 blocks away)` }] : []),
      { key: 'wait', description: 'Wait for something to happen' },
    ];
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
        else if (path === '/act') {
          acts += 1;
          if (payload.key === 'sleep') night = false;
          if (payload.key === 'follow_player') followActs += 1;
          res.end(JSON.stringify(payload.key === 'follow_player'
            ? { ok: true, followed: followFrom, distance: 2.8, ms: 5 }
            : { ok: true, ms: 5, ...(payload.key === 'sleep' ? { slept: 'night_skipped' } : {}) }));
        } else if (path === '/say') res.end(JSON.stringify({ ok: true, sent: payload.message }));
        else if (path === '/plan') res.end(JSON.stringify({ ok: true }));
        else if (path === '/mission') res.end(JSON.stringify({ ok: true, mission: { id: 'mission_test', type: payload.type, intent: payload.intent } }));
        else if (path === '/mission/finish') res.end(JSON.stringify({ ok: true, mission: { id: payload.missionId, ...payload } }));
        else if (path === '/mission/action' || path === '/mission/link') res.end(JSON.stringify({ ok: true, id: 'x1' }));
        else res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, calls, acts: () => acts, followActs: () => followActs }));
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

const INIT_PLAN = JSON.stringify({ objective: 'Wait for orders', targets: {}, waypoint: null, follow: null, notes: 'test' });
const FOLLOW_PLAN = JSON.stringify({ objective: 'Follow Ale and stay close', targets: {}, waypoint: null, follow: null, notes: 'test' });
const STOP_PLAN = JSON.stringify({ objective: 'fermati', targets: {}, waypoint: null, follow: null, notes: 'test' });
const WAIT_DECISION = 'wait';

// AUTONOMY is explicitly empty: the night rule must not depend on it.
const baseEnv = (runId, port, hermesPath) => ({
  HARNESS: `http://127.0.0.1:${port}`,
  RUN_ID: runId,
  PATH: `${hermesPath}:${process.env.PATH}`,
  CONTROLLER: 'hermes',
  SESSION: '1',
  IDLE_POLL_MS: '50',
  IDLE_TIMEOUT_MS: '2000',
  AUTONOMY: '',
  MAX_STEPS: '5',
  REPLAN_EVERY: '2',
  FOLLOW_IDLE_POLL_MS: '20',
  ANTI_LOOP_THRESHOLD: '3',
  ANTI_LOOP_COOLDOWN: '3',
  SURVIVAL_IDLE_COOLDOWN_MS: '200',
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

test('idle at night: the governor need becomes a sleep goal even with AUTONOMY off', async () => {
  const harness = await startNightHarness({ offerSleep: true });
  const fake = fakeHermesQueue([INIT_PLAN]);
  const runId = `test-night-idle-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController(baseEnv(runId, harness.port, fake.dir));
    assert.equal(code, 0, `the controller exits cleanly (stdout: ${stdout.slice(-400)})`);

    // Il goal si crea dal bisogno dichiarato dal governor (notte + letto).
    assert.match(stdout, /IDLE -> autonomous goal g\d+ \[sleep\]/, `the night need becomes a goal (stdout: ${stdout.slice(-600)})`);
    assert.match(stdout, /SURVIVAL [A-Z]+ sleep -> azione deterministica/, 'the sleep action is deterministic, not a model choice');

    const events = readEvents(runId);
    const idle = events.find(e => e.type === 'idle_goal' && e.need === 'sleep');
    assert.ok(idle, `the idle goal is logged (events: ${JSON.stringify(events.map(e => e.type))})`);
    assert.equal(idle.autonomy, false, 'AUTONOMY was off and the goal still started');
    assert.equal(idle.mode !== 'normal' || idle.reason != null, true, 'the goal carries the governor verdict');
    const need = events.find(e => e.type === 'survival_need');
    assert.equal(need?.need, 'sleep', 'the survival need is announced once');
    assert.equal(events.filter(e => e.type === 'survival_need').length, 1, 'the announcement is not repeated every step');

    // Una sola azione: dormire. Il modello non decide nulla (nessun costo).
    const acts = harness.calls.filter(c => c.path === '/act').map(c => c.payload.key);
    assert.deepEqual(acts, ['sleep'], `the only action is sleep (acts: ${JSON.stringify(acts)})`);
    assert.equal(fake.calls().length, 1, `the planner is consulted only for the seeded plan (calls: ${JSON.stringify(fake.calls())})`);
    assert.equal(events.filter(e => e.type === 'goal_met').length, 2, 'the seeded goal and the night goal are met');

    const saved = JSON.parse(readFileSync(join(ROOT, 'runs', runId, 'goals', 'world.json'), 'utf8'));
    const sleepGoal = saved.records.find(r => r.kind === 'goal' && r.goal.parameters?.need === 'sleep');
    assert.ok(sleepGoal, 'the night goal is persisted');
    assert.equal(sleepGoal.status, 'completed', 'the night goal completes after the sleep');
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('an open follow order does not keep the bot awake: the need comes first', async () => {
  const harness = await startNightHarness({ offerSleep: true, offerFollow: true, chat: true, stopAfterActs: 4 });
  const fake = fakeHermesQueue([INIT_PLAN, FOLLOW_PLAN, STOP_PLAN, WAIT_DECISION]);
  const runId = `test-night-follow-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController(baseEnv(runId, harness.port, fake.dir));
    assert.equal(code, 0, `the controller exits cleanly (stdout: ${stdout.slice(-400)})`);

    const acts = harness.calls.filter(c => c.path === '/act').map(c => c.payload.key);
    assert.equal(acts[0], 'sleep', `sleeping beats the follow order (acts: ${JSON.stringify(acts)})`);
    assert.equal(acts.indexOf('sleep') < acts.indexOf('follow_player'), true, 'the night is skipped before following');
    assert.equal(harness.followActs() >= 3, true, `the follow resumes after dawn (acts: ${JSON.stringify(acts)})`);

    const events = readEvents(runId);
    assert.equal(events.filter(e => e.type === 'survival_need').length, 1, 'the need is announced once');
    assert.equal(events.some(e => e.type === 'follow_order'), true, 'the follow order is still handled');
    assert.equal(events.some(e => e.type === 'anti_loop'), false, 'the night action does not trip the anti-loop');
    assert.equal(events.filter(e => e.type === 'goal_met').length, 1, 'the follow goal still closes on the new order');
    assert.match(stdout, /SURVIVAL [A-Z]+ sleep/, 'the preemption is visible in the log');
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('no invented survival action: a need the harness cannot serve is left to the model', async () => {
  // L'harness è l'unico che decide cosa è valido: se non offre `sleep` (nessun
  // letto raggiungibile) il controller non inventa nulla e torna al modello.
  const harness = await startNightHarness({ offerSleep: false, offerFollow: true, chat: true, stopAfterActs: 4 });
  const fake = fakeHermesQueue([INIT_PLAN, FOLLOW_PLAN, STOP_PLAN, WAIT_DECISION]);
  const runId = `test-night-nosleep-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController(baseEnv(runId, harness.port, fake.dir));
    assert.equal(code, 0, `the controller exits cleanly (stdout: ${stdout.slice(-400)})`);
    const acts = harness.calls.filter(c => c.path === '/act').map(c => c.payload.key);
    assert.equal(acts.includes('sleep'), false, `no sleep action is invented (acts: ${JSON.stringify(acts)})`);
    const events = readEvents(runId);
    assert.equal(events.some(e => e.type === 'survival_need'), false, 'no survival action without the option');
    assert.equal(events.some(e => e.type === 'idle_goal' && e.need === 'sleep'), false, 'without the option no night goal is invented');
    assert.equal(harness.followActs() >= 3, true, `the follow still runs (acts: ${JSON.stringify(acts)})`);
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});
