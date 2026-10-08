// Integration test for "wolf recovery" (patch 7): an open "seguimi" order must
// not die silently when the human leaves the bot's view. The BDS stops sending
// packets for a player outside the view, so `follow_player` is no longer offered
// and the order used to fall back to the model — which waited, forever, without
// telling anybody. Here: a scripted harness that never offers `follow_player`
// (the human is gone) but offers `seek_player` once (the last-known position is
// still fresh); after that the trail is stale too, so the bot waits and — only
// after two blind steps, and only once — asks the human in chat.
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

// Scripted harness for a *lost* follow: `humans` is empty (the player left the
// view), `follow_player` is never offered, `seek_player` is offered only before
// the first action (the memory of the last position goes stale after the first
// failed search), and `wait` is always there. Once `stopAfterActs` actions have
// run, the human writes a new order that closes the goal.
function startLostHarness ({ followFrom = 'Ale', followMessage = '@bot seguimi', stopMessage = '@bot fermati', stopAfterActs = 4, exposeFollow = true } = {}) {
  return new Promise(resolve => {
    const calls = [];
    let observes = 0;
    let acts = 0;
    let seekActs = 0;
    const followAt = Date.now();
    const stopAt = followAt + 1; // distinct: it is the controller dedup key
    const options = () => [
      ...(seekActs === 0 ? [{ key: 'seek_player', description: `Search for ${followFrom} near their last known position (10.0 blocks away)` }] : []),
      { key: 'wait', description: 'Wait for something to happen' },
    ];
    const observation = () => ({
      position: { x: 0, y: 64, z: 0 },
      inventory: { dirt: 1 },
      health: 20, food: 20, dead: false, spawned: true,
      time: { ticks: 1000, night: false, phase: 'day' },
      entities: [], dropped: [], containers: [],
      humans: [],
      ...(exposeFollow
        ? { follow: { name: followFrom, tracked: false, approachable: false, distance: null, lastSeen: { x: 10, y: 64, z: 0 }, lastSeenAgeMs: 5000, searchable: seekActs === 0 } }
        : {}),
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
          if (payload.key === 'seek_player') seekActs += 1;
          res.end(JSON.stringify(payload.key === 'seek_player'
            ? { ok: false, found: false, error: 'player_not_found', target: followFrom, searched: { x: 10, y: 64, z: 0 }, walked: 10.0, ms: 4000 }
            : { ok: true, ms: 0 }));
        } else if (path === '/say') res.end(JSON.stringify({ ok: true, sent: payload.message }));
        else if (path === '/plan') res.end(JSON.stringify({ ok: true }));
        else if (path === '/mission') res.end(JSON.stringify({ ok: true, mission: { id: 'mission_test', type: payload.type, intent: payload.intent } }));
        else if (path === '/mission/finish') res.end(JSON.stringify({ ok: true, mission: { id: payload.missionId, ...payload } }));
        else if (path === '/mission/action' || path === '/mission/link') res.end(JSON.stringify({ ok: true, id: 'x1' }));
        else res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, calls, seekActs: () => seekActs, acts: () => acts }));
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

test('a lost follow walks to the last known position, then asks once in chat', async () => {
  const harness = await startLostHarness();
  const fake = fakeHermesQueue([INIT_PLAN, FOLLOW_PLAN, STOP_PLAN]);
  const runId = `test-follow-lost-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController(baseEnv(runId, harness.port, fake.dir));
    assert.equal(code, 0, `the controller exits cleanly (stdout: ${stdout.slice(-400)})`);

    const acts = harness.calls.filter(c => c.path === '/act').map(c => c.payload.key);
    assert.equal(harness.seekActs(), 1, `the last known position is searched once (acts: ${JSON.stringify(acts)})`);
    assert.equal(acts[0], 'seek_player', `the search comes first (acts: ${JSON.stringify(acts)})`);
    assert.equal(acts.slice(1).every(k => k === 'wait'), true, `then it waits for the human (acts: ${JSON.stringify(acts)})`);
    assert.equal(acts.includes('follow_player'), false, 'the bot cannot follow what it cannot see');

    const events = readEvents(runId);
    assert.equal(events.filter(e => e.type === 'follow_seek').length, 1, 'the deterministic search is announced once');
    assert.equal(events.some(e => e.type === 'follow_order'), false, 'a lost target is not an ongoing chase');
    assert.equal(events.filter(e => e.type === 'follow_lost').length, 1, 'the chat notice is one per episode, not per step');
    assert.equal(events.some(e => e.type === 'anti_loop'), false, 'a search and a wait are not stagnation');
    assert.equal(events.some(e => e.type === 'replan'), false, 'no replan while the order is open');
    assert.equal(events.filter(e => e.type === 'goal_met').length, 1, 'the goal closes exactly once');
    const lost = events.find(e => e.type === 'follow_lost');
    assert.equal(lost.target, 'Ale');
    assert.deepEqual(lost.lastSeen, { x: 10, y: 64, z: 0 }, 'the notice is about the last known position');

    // Il planner non entra mai nel recupero: due ordini tradotti (follow, stop)
    // più il piano iniziale del goal.
    assert.equal(fake.calls().length, 3, `the lost path is deterministic (calls: ${JSON.stringify(fake.calls())})`);

    const says = harness.calls.filter(c => c.method === 'POST' && c.path === '/say').map(c => c.payload.message);
    assert.equal(says[0], '@Ale ok: Follow Ale and stay close — arrivo da Ale', `the order is acked (got ${JSON.stringify(says)})`);
    assert.equal(says.filter(m => /non ti vedo piu/.test(m)).length, 1, `the bot says it lost the human exactly once (got ${JSON.stringify(says)})`);
    assert.match(says.find(m => /non ti vedo piu/.test(m)), /^@Ale non ti vedo piu'\: ti aspetto qui\./, 'the notice starts with the gamertag, not with the trigger');
    assert.equal(says.some(m => /^@Ale fatto: fermati/.test(m)), true, `the closing order is confirmed (got ${JSON.stringify(says)})`);

    assert.match(stdout, /FOLLOW SEARCH Ale: recupero all'ultima posizione nota/, 'the search is visible in the log');
    assert.match(stdout, /FOLLOW LOST Ale: chiedo dove si trova/, 'the notice is visible in the log');

    const followPlans = harness.calls.filter(c => c.path === '/plan' && c.payload.follow).map(c => c.payload.follow);
    assert.equal(followPlans.length >= 1, true, 'the follow is posted to the harness');
    assert.equal(followPlans.every(f => f === 'Ale'), true, `the follow target never changes (got ${JSON.stringify(followPlans)})`);
    // R4: il fallimento di `seek_player` (`player_not_found`) e' un bersaglio
    // spostato, non un vicolo cieco: si ritenta, il piano non viene revisionato.
    const revised = harness.calls.filter(c => c.path === '/plan' && c.payload.steps?.some(s => s.refused));
    assert.equal(revised.length, 0, `a retryable refusal does not revise the plan (got ${JSON.stringify(revised.map(c => c.payload.steps))})`);
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('the lost path also works against a harness that does not report the follow trail', async () => {
  // Un harness più vecchio non manda `follow` nell'osservazione: il recupero
  // non deve dipendere da quel campo (solo i log lo usano, in modo opzionale).
  const harness = await startLostHarness({ exposeFollow: false, stopAfterActs: 2 });
  const fake = fakeHermesQueue([INIT_PLAN, FOLLOW_PLAN, STOP_PLAN]);
  const runId = `test-follow-lost-nofollow-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController(baseEnv(runId, harness.port, fake.dir));
    assert.equal(code, 0, `the controller exits cleanly (stdout: ${stdout.slice(-400)})`);
    const acts = harness.calls.filter(c => c.path === '/act').map(c => c.payload.key);
    assert.equal(acts[0], 'seek_player', `the search still comes first (acts: ${JSON.stringify(acts)})`);
    const events = readEvents(runId);
    assert.equal(events.filter(e => e.type === 'follow_seek').length, 1, 'the search is announced');
    assert.equal(events.filter(e => e.type === 'goal_met').length, 1, 'the goal still closes');
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});
