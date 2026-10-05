// Integration test for the "lost hold" half of patch 8: when an open "seguimi"
// order has no target at all — the human is not tracked any more and the trail
// of their last known position is stale — the bot must not hand the goal back
// to the model, which in production wandered off (`go_home`, `open_trade`)
// while the order was still open. It waits where it lost the trail, tells the
// human once, and after `LOST_HOLD_MAX_STEPS` blind polls it releases the order
// instead of staying frozen forever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Fake `hermes` CLI: prints the next scripted line and appends it to
// `calls.log`, so the test can count how often the planner was consulted.
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

// Scripted harness where the trail is gone too: no `follow_player`, no
// `seek_player`, no `wait` — only actions the model could pick (`go_home`) and
// `mine_dirt`. This is the production shape that used to send the bot home with
// the order still open. Once `stopAfterActs` actions have run the human writes
// a new order that closes the goal.
function startHoldHarness ({ followFrom = 'Ale', followMessage = '@bot seguimi', stopMessage = '@bot fermati', stopAfterActs = 1 } = {}) {
  return new Promise(resolve => {
    const calls = [];
    let observes = 0;
    let acts = 0;
    const followAt = Date.now();
    const stopAt = followAt + 1; // distinct: it is the controller dedup key
    const options = () => [
      { key: 'go_home', description: 'Go home' },
      { key: 'mine_dirt', description: 'Mine dirt' },
    ];
    const observation = () => ({
      position: { x: 0, y: 64, z: 0 },
      inventory: { dirt: 1 },
      health: 20, food: 20, dead: false, spawned: true,
      time: { ticks: 1000, night: false, phase: 'day' },
      entities: [], dropped: [], containers: [],
      humans: [],
      follow: { name: followFrom, tracked: false, approachable: false, distance: null, lastSeen: { x: 10, y: 64, z: 0 }, lastSeenAgeMs: 900000, searchable: false },
      chat: observes >= 1
        ? [acts >= stopAfterActs
            ? { from: followFrom, message: stopMessage, type: 'chat', xuid: '1234567890', at: stopAt }
            : { from: followFrom, message: followMessage, type: 'chat', xuid: '1234567890', at: followAt }]
        : [],
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
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, calls, observes: () => observes, acts: () => acts }));
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

// The planner queue must also contain the *initial* plan of the seeded goal:
// `runGoal` calls `planForStep(obs, 'start', goal)` before any step.
const INIT_PLAN = JSON.stringify({ objective: 'Wait for orders', targets: {}, waypoint: null, follow: null, notes: 'test' });
const FOLLOW_PLAN = JSON.stringify({ objective: 'Follow Ale and stay close', targets: {}, waypoint: { x: 0, z: 2 }, follow: null, notes: 'test' });
const STOP_PLAN = JSON.stringify({ objective: 'fermati', targets: {}, waypoint: null, follow: null, notes: 'test' });

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
  REPLAN_EVERY: '2',
  FOLLOW_IDLE_POLL_MS: '20',
  LOST_NOTICE_AFTER_STEPS: '2',
  LOST_HOLD_MAX_STEPS: '3',
  ANTI_LOOP_THRESHOLD: '3',
  ANTI_LOOP_COOLDOWN: '3',
  TARGETS: '{"dirt":1}',
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

test('with the trail gone too the bot holds still, warns once and then releases the order', async () => {
  const harness = await startHoldHarness();
  const fake = fakeHermesQueue([INIT_PLAN, FOLLOW_PLAN, 'go_home', 'go_home', STOP_PLAN]);
  const runId = `test-follow-hold-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController(baseEnv(runId, harness.port, fake.dir));
    assert.equal(code, 0, `the controller exits cleanly (stdout: ${stdout.slice(-400)})`);

    const events = readEvents(runId);
    const acts = harness.calls.filter(c => c.path === '/act').map(c => c.payload.key);

    // L'attesa: nessuna azione prima che il tetto scada, e il tetto e' quello
    // dell'ambiente (3 passi), non un numero interno.
    const released = events.filter(e => e.type === 'follow_released');
    assert.equal(released.length, 1, `the order is released exactly once (acts: ${JSON.stringify(acts)})`);
    assert.equal(released[0].steps, 3, `the release happens at the configured ceiling (got ${released[0].steps})`);
    assert.equal(released[0].target, 'Ale');
    assert.equal(events.filter(e => e.type === 'follow_hold').length, 1, 'the hold is announced once, not per poll');

    // Il modello non e' mai stato consultato durante l'attesa: la prima azione
    // arriva solo dopo il rilascio, cioe' dopo i tre giri di attesa.
    const firstActIndex = harness.calls.findIndex(c => c.path === '/act');
    const observesBeforeFirstAct = harness.calls.slice(0, firstActIndex).filter(c => c.path === '/observe').length;
    assert.equal(observesBeforeFirstAct >= 4, true, `the bot polls while holding still (observes before the first action: ${observesBeforeFirstAct})`);
    assert.equal(acts[0], 'go_home', `after the release the model decides again (acts: ${JSON.stringify(acts)})`);

    // Un solo avviso in chat, e nessuna stagnazione: l'attesa non e' anti-loop.
    const says = harness.calls.filter(c => c.method === 'POST' && c.path === '/say').map(c => c.payload.message);
    assert.equal(says.filter(m => /non ti vedo piu/.test(m)).length, 1, `the loss is announced exactly once (got ${JSON.stringify(says)})`);
    assert.equal(events.filter(e => e.type === 'follow_lost').length, 1);
    assert.equal(events.some(e => e.type === 'anti_loop'), false, 'waiting is not stagnation');
    assert.equal(events.filter(e => e.type === 'goal_met').length, 1, 'the goal closes exactly once');

    assert.match(stdout, /FOLLOW HOLD Ale/, 'the hold is visible in the log or at least logged as an event');
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});
