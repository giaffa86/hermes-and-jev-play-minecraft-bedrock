// Integration test for the escort order (2b): «@bot guidami fino al filone».
// The bot must *lead* — walk to the destination the order names and wait for the
// human — and must not degrade the order to `follow_player` (the bot following
// the human, which is the opposite). The choice is deterministic: with an escort
// open the controller picks `escort_to` without asking the model. The goal closes
// when both have arrived: the bot at the destination and the human within the
// gap the harness measures (`observe().escort.gap`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  return { dir, calls: () => (existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean) : []) };
}

const DESTINATION = { x: 8, z: 0 };

// Scripted harness: the bot starts away from the vein, `escort_to` is the only
// useful option while the order is open, and after two actions the human is at
// the destination too — so the escort is fulfilled by the state, not by a claim.
function startEscortHarness ({ from = 'Ale', message = '@bot guidami fino al filone', arriveAfterActs = 2, gapBehind = 4 } = {}) {
  return new Promise(resolve => {
    const calls = [];
    let observes = 0;
    let acts = 0;
    const orderAt = Date.now();
    const escortView = () => ({
      name: from,
      target: { x: DESTINATION.x, y: 64, z: DESTINATION.z, source: 'escort.to' },
      tracked: true,
      gap: acts >= arriveAfterActs ? 4 : gapBehind,
      waiting: acts < arriveAfterActs && gapBehind > 12,
      ready: true,
      limits: { maxGap: 12, resumeGap: 5, waitMs: 60000, lostMs: 20000, timeoutMs: 150000, arriveDistance: 2 },
    });
    const observation = () => ({
      position: acts >= arriveAfterActs ? { x: DESTINATION.x, y: 64, z: DESTINATION.z } : { x: 0, y: 64, z: 0 },
      inventory: { dirt: 1 },
      health: 20, food: 20, dead: false, spawned: true,
      time: { ticks: 1000, night: false, phase: 'day' },
      entities: [], dropped: [], containers: [], humans: [],
      plan: { objective: 'Guidami al filone', targets: {}, waypoint: { x: DESTINATION.x, z: DESTINATION.z }, escort: { from } },
      escort: escortView(),
      chat: observes >= 1 ? [{ from, message, type: 'chat', xuid: '1234567890', at: orderAt }] : [],
    });
    const options = () => [
      { key: 'escort_to', description: `Walk ${from} to ${DESTINATION.x}, ${DESTINATION.z} (4 blocks apart)` },
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
          res.end(JSON.stringify({ ok: true, escorted: from, arrived: acts >= arriveAfterActs, distance: acts >= arriveAfterActs ? 0 : 8, waitedMs: 0, waits: [], ms: 30 }));
        } else if (path === '/say') res.end(JSON.stringify({ ok: true, sent: payload.message }));
        else if (path === '/plan') res.end(JSON.stringify({ ok: true }));
        else if (path === '/mission') res.end(JSON.stringify({ ok: true, mission: { id: 'mission_test', type: payload.type, intent: payload.intent } }));
        else if (path === '/mission/finish') res.end(JSON.stringify({ ok: true, mission: { id: payload.missionId, ...payload } }));
        else if (path === '/mission/action' || path === '/mission/link') res.end(JSON.stringify({ ok: true, id: 'x1' }));
        else res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, calls, acts: () => acts }));
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
const ESCORT_PLAN = JSON.stringify({ objective: 'Guidami al filone', targets: {}, waypoint: DESTINATION, follow: null, notes: 'test' });

const baseEnv = (runId, port, hermesPath) => ({
  HARNESS: `http://127.0.0.1:${port}`,
  RUN_ID: runId,
  PATH: `${hermesPath}:${process.env.PATH}`,
  CONTROLLER: 'hermes',
  SESSION: '1',
  IDLE_POLL_MS: '50',
  IDLE_TIMEOUT_MS: '2000',
  AUTONOMY: '',
  MAX_STEPS: '3',
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

test('an escort order leads, does not follow, and closes when both arrive', async () => {
  const harness = await startEscortHarness();
  const fake = fakeHermesQueue([INIT_PLAN, ESCORT_PLAN, INIT_PLAN]);
  const runId = `test-escort-order-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController(baseEnv(runId, harness.port, fake.dir));
    assert.equal(code, 0, `the controller exits cleanly (stdout: ${stdout.slice(-400)})`);

    const acts = harness.calls.filter(c => c.path === '/act').map(c => c.payload.key);
    assert.ok(acts.length >= 2, `the escort acted (acts: ${JSON.stringify(acts)})`);
    assert.equal(acts[0], 'escort_to', `the escort leads (acts: ${JSON.stringify(acts)})`);
    assert.equal(acts.includes('follow_player'), false, 'an escort order is not a follow order');
    assert.equal(acts.some(key => key.startsWith('mine_') || key === 'collect_drop'), false, 'the escort does not wander off to mine');

    const published = harness.calls.filter(c => c.path === '/plan').map(c => c.payload.plan ?? c.payload);
    const escortPlan = published.find(plan => plan?.escort);
    assert.ok(escortPlan, `the escort plan reaches the harness (plans: ${JSON.stringify(published.slice(-3))})`);
    assert.equal(escortPlan.escort.from, 'Ale');
    assert.deepEqual(escortPlan.escort.to, { x: DESTINATION.x, z: DESTINATION.z });
    assert.equal(escortPlan.follow ?? null, null, 'the escort clears the follow');

    const events = readEvents(runId);
    assert.equal(events.filter(e => e.type === 'escort_order').length, 1, 'the escort is announced once, not per step');
    assert.equal(events.some(e => e.type === 'decision'), false, 'the escort is chosen deterministically, without the model');
    assert.equal(events.some(e => e.type === 'anti_loop'), false, 'leading is not stagnation');
    assert.equal(events.some(e => e.type === 'replan'), false, 'no replan while the order is open');
    assert.equal(events.filter(e => e.type === 'goal_met').length, 1, 'the goal closes exactly once, when both have arrived');
  } finally {
    harness.server.close();
  }
});

// La scorta che si ferma ad aspettare lo dice in chat, con le proprie
// coordinate: è l'unica cosa che l'umano rimasto indietro non può vedere da
// solo. Una riga per episodio — non a ogni passo — e il testo arriva dal
// catalogo, mai dal modello.
test('a waiting escort tells the human where it is waiting, once', async () => {
  const harness = await startEscortHarness({ gapBehind: 40, arriveAfterActs: 4 });
  const fake = fakeHermesQueue([INIT_PLAN, ESCORT_PLAN, INIT_PLAN]);
  const runId = `test-escort-waiting-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController({ ...baseEnv(runId, harness.port, fake.dir), MAX_STEPS: '5' });
    assert.equal(code, 0, `the controller exits cleanly (stdout: ${stdout.slice(-400)})`);

    const acts = harness.calls.filter(c => c.path === '/act').map(c => c.payload.key);
    assert.equal(acts.filter(key => key === 'escort_to').length >= 2, true,
      `the escort keeps leading while the human is behind (acts: ${JSON.stringify(acts)})`);

    const events = readEvents(runId);
    const notices = events.filter(e => e.type === 'escort_waiting');
    assert.equal(notices.length, 1, `the waiting notice is one per episode, not per step (got ${notices.length})`);
    assert.equal(notices[0].target, 'Ale');
    assert.equal(notices[0].episode, 'wait');
    assert.equal(notices[0].reason, 'gap');
    assert.equal(notices[0].gap, 40, 'the notice is about the distance the harness measured');
    assert.deepEqual(notices[0].position, { x: 0, y: 64, z: 0 }, 'the notice carries the bot position from observe()');

    const says = harness.calls.filter(c => c.method === 'POST' && c.path === '/say').map(c => c.payload.message);
    const waiting = says.filter(m => /ti aspetto qui/.test(m));
    assert.equal(waiting.length, 1, `the bot says where it waits exactly once (got ${JSON.stringify(says)})`);
    assert.equal(waiting[0], '@Ale ti aspetto qui: sono a x 0, y 64, z 0.', 'the line is the catalogue one, filled with the real coordinates');
    assert.equal(says.every(m => m.startsWith('@Ale')), true, 'every line is addressed to the human, never to a trigger');

    assert.match(stdout, /ESCORT WAITING Ale: dico dove aspetto \(gap\)/, 'the notice is visible in the log');
    assert.equal(events.filter(e => e.type === 'goal_met').length, 1, 'the goal still closes when the human catches up');
  } finally {
    harness.server.close();
  }
});
