// Integration test for the chat milestone M3 (wiki/human-command.md): an order
// "seguimi" is an *open commitment* of the goal, not a plan the model can
// rewrite. Live 04/10 the bot acknowledged the order, followed for a few steps,
// then the anti-loop replan replaced the plan with a static waypoint: the
// waypoint was reached, the goal closed and the bot went IDLE while the human
// was still standing next to it ("non mi sta seguendo").
//
// This test scripts a harness whose `follow_player` always succeeds instantly
// (the human is already within the follow distance) and a fake planner that
// would happily return a plan without `follow` at every periodic replan.
// Expected: the controller keeps issuing `follow_player` past the anti-loop
// threshold, renews the step budget, never asks the planner to replan, and only
// closes the goal when a *new* order arrives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// Scripted harness: the human stands next to the bot (`distance` 2.8, inside the
// `follow_player` stop distance), the chat carries the follow order and, once
// `stopAfterActs` actions have been executed, a new order that closes the chase.
// Every follow action succeeds instantly (ms 0), which is exactly the shape that
// used to trip the anti-loop detector. With `offerFollow: false` the harness
// never offers `follow_player` (target not trackable, governor in emergency).
function startFollowHarness ({ followFrom = 'Ale', followMessage = '@bot seguimi', stopMessage = '@bot fermati', stopAfterActs = 5, offerFollow = true } = {}) {
  return new Promise(resolve => {
    const calls = [];
    let observes = 0;
    let acts = 0;
    let followActs = 0;
    const followAt = Date.now();
    const stopAt = followAt + 1; // distinto: è la chiave di dedup del controller
    const options = () => [
      ...(offerFollow ? [{ key: 'follow_player', description: `Follow ${followFrom} (2.8 blocks away)` }] : []),
      { key: 'wait', description: 'Wait for something to happen' },
    ];
    const observation = () => ({
      position: { x: 0, y: 64, z: 0 },
      inventory: { dirt: 1 },
      health: 20, food: 20, dead: false, spawned: true,
      time: { ticks: 1000, night: false, phase: 'day' },
      entities: [], dropped: [], containers: [],
      humans: [{ username: followFrom, distance: 2.8, position: { x: 0, y: 64, z: 2.8 } }],
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
        else if (path === '/act') {
          acts += 1;
          if (payload.key === 'follow_player') followActs += 1;
          res.end(JSON.stringify(payload.key === 'follow_player'
            ? { ok: true, followed: followFrom, distance: 2.8, ms: 0 }
            : { ok: true, ms: 0 }));
        } else if (path === '/say') res.end(JSON.stringify({ ok: true, sent: payload.message }));
        else if (path === '/plan') res.end(JSON.stringify({ ok: true }));
        else if (path === '/mission') res.end(JSON.stringify({ ok: true, mission: { id: 'mission_test', type: payload.type, intent: payload.intent } }));
        else if (path === '/mission/finish') res.end(JSON.stringify({ ok: true, mission: { id: payload.missionId, ...payload } }));
        else if (path === '/mission/action' || path === '/mission/link') res.end(JSON.stringify({ ok: true, id: 'x1' }));
        else res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, calls, followActs: () => followActs }));
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

// Il piano del planner per "seguimi" non dichiara `follow`: lo aggiunge il
// controller dal testo dell'ordine (è l'invariante di humanCommandPlan).
// NB: la coda del planner finto deve contenere *anche* la chiamata per il piano
// iniziale del goal (`runGoal` fa `planForStep(obs, 'start', goal)` prima di
// qualsiasi passo), altrimenti ogni risposta e' sfalsata di uno.
const INIT_PLAN = JSON.stringify({ objective: 'Wait for orders', targets: {}, waypoint: null, follow: null, notes: 'test' });
const FOLLOW_PLAN = JSON.stringify({ objective: 'Follow Ale and stay close', targets: {}, waypoint: { x: 0, z: 2 }, follow: null, notes: 'test' });
const STOP_PLAN = JSON.stringify({ objective: 'fermati', targets: {}, waypoint: null, follow: null, notes: 'test' });
const WAIT_DECISION = 'wait';

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

test('a follow order is sticky: no anti-loop, no replan, no self-closing goal', async () => {
  const harness = await startFollowHarness();
  const fake = fakeHermesQueue([INIT_PLAN, FOLLOW_PLAN, STOP_PLAN, WAIT_DECISION]);
  const runId = `test-follow-order-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController(baseEnv(runId, harness.port, fake.dir));
    assert.equal(code, 0, `the controller exits cleanly (stdout: ${stdout.slice(-400)})`);

    const acts = harness.calls.filter(c => c.path === '/act').map(c => c.payload.key);
    // L'azione ripetuta supera la soglia dell'anti-loop (3): non deve essere
    // sostituita da un waypoint statico né esclusa dal filtro.
    assert.equal(harness.followActs(), 5, `the bot keeps following (acts: ${JSON.stringify(acts)})`);
    assert.equal(acts.slice(0, 5).every(k => k === 'follow_player'), true, `only follow_player while the order is open (acts: ${JSON.stringify(acts)})`);
    assert.equal(acts.includes('goto_waypoint'), false, 'the follow is never replaced by a static waypoint');

    const events = readEvents(runId);
    assert.equal(events.some(e => e.type === 'anti_loop'), false, 'a satisfied follow is not an anti-loop');
    assert.equal(events.some(e => e.type === 'replan'), false, 'no periodic replan while the order is open');
    assert.equal(events.filter(e => e.type === 'follow_order').length, 1, 'the deterministic follow is announced once');
    assert.equal(events.filter(e => e.type === 'follow_budget_renewed').length, 1, 'the step budget is renewed while the order is open');
    assert.equal(events.filter(e => e.type === 'goal_met').length, 1, 'the goal closes exactly once');
    // ...e si chiude per il *nuovo* ordine, non per il waypoint del replan.
    const met = events.find(e => e.type === 'goal_met');
    assert.equal(met.steps >= 5, true, `the goal closes after the following (steps: ${met.steps})`);
    const order = events.find(e => e.type === 'chat_command' && /seguimi/.test(e.message));
    assert.equal(order?.from, 'Ale', 'the order is attributed to the sender');
    const stop = events.find(e => e.type === 'chat_command' && /fermati/.test(e.message));
    assert.equal(stop?.from, 'Ale', 'the stop order is received mid-goal');

    // Il planner è consultato solo per il piano iniziale e per tradurre i due
    // ordini: nessun replan pagato a ogni passo di inseguimento, e nessuna
    // decisione del modello dopo lo stop (il goal si chiude subito, `goalMet`
    // precede la scelta dell'azione).
    assert.equal(fake.calls().length, 3, `the planner is not in the follow loop (calls: ${JSON.stringify(fake.calls())})`);

    // Follow: il piano inviato al harness porta sempre il `follow` del goal.
    const followPlans = harness.calls.filter(c => c.path === '/plan' && c.payload.follow).map(c => c.payload.follow);
    assert.equal(followPlans.length >= 1, true, 'the follow is posted to the harness');
    assert.equal(followPlans.every(f => f === 'Ale'), true, `the follow target never changes (got ${JSON.stringify(followPlans)})`);

    const says = harness.calls.filter(c => c.method === 'POST' && c.path === '/say').map(c => c.payload.message);
    // orderAck nomina il follow ("— arrivo da Ale") solo quando il piano lo dichiara.
    assert.equal(says[0], '@Ale ok: Follow Ale and stay close — arrivo da Ale', `the order is acked (got ${JSON.stringify(says)})`);
    assert.equal(says.includes('@Ale ok: fermati'), true, `the stop is acked without a follow (got ${JSON.stringify(says)})`);
    assert.equal(says.some(m => /^@Ale fatto: fermati/.test(m)), true, `the outcome follows the closing order (got ${JSON.stringify(says)})`);
    assert.match(stdout, /FOLLOW ORDER Ale: inseguimento deterministico/, 'the deterministic follow is visible in the log');
    assert.match(stdout, /FOLLOW open: step budget renewed/, 'the budget renewal is visible in the log');
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('a follow order whose target is not offered falls back to the decision model', async () => {
  // Se l'harness non offre `follow_player` (bersaglio non tracciato, governor in
  // emergenza) il controller non inventa nulla: torna a chiedere al modello.
  const harness = await startFollowHarness({ offerFollow: false, stopAfterActs: 2 });
  // Step 1: piano iniziale + ordine di follow; step 2: decisione; step 3: arriva
  // lo stop (2 azioni fatte) + decisione. Il piano del planner per lo stop ha
  // `follow: null` (l'ordine lo decide il modello, non il fallback).
  const fake = fakeHermesQueue([INIT_PLAN, FOLLOW_PLAN, WAIT_DECISION, WAIT_DECISION, STOP_PLAN, WAIT_DECISION]);
  const runId = `test-follow-fallback-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController(baseEnv(runId, harness.port, fake.dir));
    assert.equal(code, 0, `the controller exits cleanly (stdout: ${stdout.slice(-400)})`);
    const acts = harness.calls.filter(c => c.path === '/act').map(c => c.payload.key);
    assert.equal(harness.followActs(), 0, `no follow action is invented (acts: ${JSON.stringify(acts)})`);
    assert.equal(acts.every(k => k === 'wait'), true, `the model choice is what runs (acts: ${JSON.stringify(acts)})`);
    const events = readEvents(runId);
    assert.equal(events.some(e => e.type === 'follow_order'), false, 'no deterministic follow without the option');
    assert.equal(events.filter(e => e.type === 'goal_met').length, 1, 'the closing order still ends the goal');
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('a stop order closes the follow even when the planner is down', async () => {
  // `humanCommandPlan` ha un fallback deterministico che trasforma qualunque
  // ordine in "segui chi ti ha scritto": senza la guardia `isStopOrder` un
  // "fermati" tradotto dal fallback riapriva il follow e il goal sticky non si
  // chiudeva mai (bug live 04/10). Qui il planner restituisce spazzatura per
  // l'ordine di stop, quindi si passa proprio da quel fallback.
  const harness = await startFollowHarness({ stopAfterActs: 5 });
  const fake = fakeHermesQueue([INIT_PLAN, FOLLOW_PLAN, 'I cannot help with that.']);
  const runId = `test-follow-stop-fallback-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController(baseEnv(runId, harness.port, fake.dir));
    assert.equal(code, 0, `the controller exits cleanly (stdout: ${stdout.slice(-400)})`);
    const acts = harness.calls.filter(c => c.path === '/act').map(c => c.payload.key);
    assert.equal(harness.followActs(), 5, `the bot follows until the stop order (acts: ${JSON.stringify(acts)})`);
    const events = readEvents(runId);
    assert.equal(events.some(e => e.type === 'plan_fallback'), true, 'the stop order is translated by the fallback');
    assert.equal(events.filter(e => e.type === 'goal_met').length, 1, 'the fallback stop order closes the goal');
    const says = harness.calls.filter(c => c.method === 'POST' && c.path === '/say').map(c => c.payload.message);
    assert.equal(says.some(m => /^@Ale fatto: Stay put and wait for the next order/.test(m)), true, `the stop is confirmed (got ${JSON.stringify(says)})`);
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});
