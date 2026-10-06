// Integration test for the mount-join mission (the order the user asked to
// pin down): `join_human_mount` must lead the follow order, the generic
// `mount_*` and every locomotion fallback, and when the bot cannot board it
// must say where it is waiting instead of chasing the boat in silence.
//
// Two scripted harnesses, one per phase:
//   - "join":   the human's boat has a free seat and the harness offers the
//               boarding option next to `mount_boat`/`follow_player`/`wait`;
//   - "shore":  the same boat but no boarding option (the adapter stops
//               offering it without the feature flag, or the seat is taken):
//               only `wait` is valid, and the controller says where it waits.
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
  return {
    dir,
    calls: () => (existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean) : []),
  };
}

// `phase: 'join'` — l'umano e' in barca, c'e' un posto libero e l'opzione di
// salita e' offerta accanto ai rami generici. `phase: 'shore'` — l'opzione non
// c'e' piu' (join dietro flag spento, oppure posto occupato): resta solo
// l'attesa, e il controller deve dire *dove* aspetta. `phase: 'ride'` — il bot e'
// a bordo con l'umano per i primi `rideSteps` osservati, poi l'umano sbarca: la
// posizione la scrive il server (nessuna azione), allo smontaggio l'ordine
// riprende da solo.
function startMountHarness ({ phase = 'join', from = 'Ale', stopAfterActs = 4, rideSteps = 4 } = {}) {
  return new Promise(resolve => {
    const calls = [];
    let observes = 0;
    let acts = 0;
    const followAt = Date.now();
    const stopAt = followAt + 1;
    const riding = () => ({
      state: 'RIDING_WITH_HUMAN', action: 'ride', reason: 'riding_with_human', human: from,
      attempts: 0, attemptLimit: 2, joinEnabled: true,
      mount: { type: 'oak_boat', runtimeId: '200', source: 'link', seats: 2, riders: 2, free: 0, joinable: false, reason: 'full', distance: 0.5 },
    });
    const mountView = () => phase === 'ride'
      ? (observes <= rideSteps
          ? riding()
          : { state: 'FOLLOWING', action: 'follow', reason: 'dismounted', human: from, attempts: 0, attemptLimit: 2, joinEnabled: true, mount: null })
      : {
          state: phase === 'join' ? 'JOINING_HUMAN_MOUNT' : 'WAITING_AT_SHORE',
          action: phase === 'join' ? 'join' : 'wait',
          reason: phase === 'join' ? 'human_mount_joinable' : 'join_disabled',
          human: from,
          attempts: 0,
          attemptLimit: 2,
          joinEnabled: phase === 'join',
          mount: { type: 'oak_boat', runtimeId: '200', source: 'link', seats: 2, riders: 1, free: 1, joinable: true, reason: null, distance: 3 },
        };
    const options = () => [
      ...(phase === 'join' ? [{ key: 'join_human_mount', description: "Board Ale's oak_boat (1 free seat(s) of 2, 3.0 blocks away, confirmed by the server link)" }] : []),
      { key: 'follow_player', description: `Follow ${from} (3.0 blocks away)` },
      { key: 'seek_player', description: `Search for ${from} near their last known position (3.0 blocks away)` },
      { key: 'mount_boat', description: 'Board the nearest boat (2.0 blocks away)' },
      ...(phase === 'ride' ? [{ key: 'dismount', description: 'Get off the boat' }] : []),
      { key: 'wait', description: 'Wait for something to happen' },
    ];
    const observation = () => ({
      position: { x: 0, y: 64, z: 0 },
      inventory: { dirt: 1 },
      health: 20, food: 20, dead: false, spawned: true,
      time: { ticks: 1000, night: false, phase: 'day' },
      entities: [], dropped: [], containers: [],
      humans: [{ username: from, distance: 3, position: { x: 0, y: 63, z: 3 } }],
      follow: { tracked: true, approachable: true, distance: 3, lastSeen: { x: 0, y: 63, z: 3 }, lastSeenAgeMs: 500, searchable: true },
      mountFollow: mountView(),
      chat: observes >= 1
        ? [acts >= stopAfterActs
            ? { from, message: '@bot fermati', type: 'chat', xuid: '1234567890', at: stopAt }
            : { from, message: '@bot seguimi', type: 'chat', xuid: '1234567890', at: followAt }]
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
          res.end(JSON.stringify({ ok: true, mounted: phase === 'join' ? 'oak_boat' : undefined, ms: 0 }));
        } else if (path === '/say') res.end(JSON.stringify({ ok: true, sent: payload.message }));
        else if (path === '/plan') res.end(JSON.stringify({ ok: true }));
        else if (path === '/mission') res.end(JSON.stringify({ ok: true, mission: { id: 'mission_test', type: payload.type, intent: payload.intent } }));
        else if (path === '/mission/finish') res.end(JSON.stringify({ ok: true, mission: { id: payload.missionId, ...payload } }));
        else if (path === '/mission/action' || path === '/mission/link') res.end(JSON.stringify({ ok: true, id: 'x1' }));
        else res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, calls }));
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
const FOLLOW_PLAN = JSON.stringify({ objective: 'Follow Ale and stay close', targets: {}, waypoint: { x: 0, z: 3 }, follow: null, notes: 'test' });
const STOP_PLAN = JSON.stringify({ objective: 'fermati', targets: {}, waypoint: null, follow: null, notes: 'test' });
const WAIT_DECISION = 'wait';

const baseEnv = (runId, port, hermesPath, { maxSteps = 4 } = {}) => ({
  HARNESS: `http://127.0.0.1:${port}`,
  RUN_ID: runId,
  PATH: `${hermesPath}:${process.env.PATH}`,
  CONTROLLER: 'hermes',
  SESSION: '1',
  IDLE_POLL_MS: '50',
  IDLE_TIMEOUT_MS: '2000',
  AUTONOMY: '',
  MAX_STEPS: String(maxSteps),
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

test('a mounted human wins over the generic mounts and the follow: the bot boards, it does not chase', async () => {
  const harness = await startMountHarness({ phase: 'join', stopAfterActs: 4 });
  const fake = fakeHermesQueue([INIT_PLAN, FOLLOW_PLAN, STOP_PLAN, WAIT_DECISION]);
  const runId = `test-mount-join-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController(baseEnv(runId, harness.port, fake.dir));
    assert.equal(code, 0, `the controller exits cleanly (stdout: ${stdout.slice(-400)})`);

    const acts = harness.calls.filter(c => c.path === '/act').map(c => c.payload.key);
    assert.ok(acts.length >= 4, `the bot acted (acts: ${JSON.stringify(acts)})`);
    // Le prime azioni dell'ordine sono la salita, non un ramo generico: questo e'
    // esattamente l'ordine `join_human_mount > mount_* > follow/seek` richiesto.
    assert.equal(acts.slice(0, 4).every(k => k === 'join_human_mount'), true, `acts: ${JSON.stringify(acts)}`);
    assert.equal(acts.includes('mount_boat'), false, 'the generic boat branch never runs');
    assert.equal(acts.includes('follow_player'), false, 'no on-foot chase while the boat is boardable');
    assert.equal(acts.includes('seek_player'), false, 'no search fallback while the boat is boardable');

    const events = readEvents(runId);
    assert.equal(events.filter(e => e.type === 'join_human_mount_order').length, 1, 'the boarding order is announced once');
    // Il harness offre *anche* `follow_player` (il caso peggiore): il ramo
    // deterministico dell'inseguimento puo' essere annunciato nei log, ma non
    // deve mai diventare l'azione — l'ha gia' verificato `acts` qui sopra.
    assert.equal(events.some(e => e.type === 'mount_waiting_shore'), false, 'nothing to wait for: the seat was free');
    // Il modello non entra nel ciclo: la scelta di salire e' deterministica.
    const decisions = events.filter(e => e.type === 'decision');
    assert.equal(decisions.length, 0, 'no model decision while the boat is boardable');
  } finally {
    harness.server.close();
  }
});

test('when the bot cannot board it says where it waits, once, and does not chase in silence', async () => {
  const harness = await startMountHarness({ phase: 'shore', stopAfterActs: 4 });
  const fake = fakeHermesQueue([INIT_PLAN, FOLLOW_PLAN, STOP_PLAN, WAIT_DECISION, WAIT_DECISION, WAIT_DECISION, WAIT_DECISION]);
  const runId = `test-mount-shore-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController(baseEnv(runId, harness.port, fake.dir));
    assert.equal(code, 0, `the controller exits cleanly (stdout: ${stdout.slice(-400)})`);

    const acts = harness.calls.filter(c => c.path === '/act').map(c => c.payload.key);
    assert.equal(acts.includes('join_human_mount'), false, 'the boarding option is not offered');
    assert.equal(acts.includes('mount_boat'), false, 'a generic boat is not "the human\'s boat"');

    // Una sola riga, con le coordinate: chi sta salpando non vede che il bot e'
    // rimasto a riva, e da dove recuperarlo.
    const said = harness.calls.filter(c => c.path === '/say').map(c => c.payload.message);
    const shore = said.filter(m => /^@Ale non riesco a salire sulla tua oak boat/.test(m ?? ''));
    assert.equal(shore.length, 1, `one shore line (said: ${JSON.stringify(said)})`);
    assert.match(shore[0], /x 0, y 64, z 0/, 'the line carries the bot\'s coordinates');

    const events = readEvents(runId);
    const waiting = events.filter(e => e.type === 'mount_waiting_shore');
    assert.equal(waiting.length, 1, 'the wait is announced once, not at every step');
    assert.equal(waiting[0].reason, 'join_disabled', 'the typed reason stays in the logs, not in chat');
    assert.equal(waiting[0].mount, 'oak_boat');
  } finally {
    harness.server.close();
  }
});

test('while the bot is carried it holds the order, and the follow resumes on dismount', async () => {
  // Caso peggiore: a bordo il harness offre comunque `follow_player`,
  // `seek_player`, `mount_boat` e perfino `dismount`. Il bot non deve fare nulla
  // finche' e' seduto (nessuna azione, nessun modello) e deve riprendere a
  // seguire appena l'umano sbarca — senza un secondo ordine dell'umano.
  const harness = await startMountHarness({ phase: 'ride', rideSteps: 4, stopAfterActs: 5 });
  const fake = fakeHermesQueue([INIT_PLAN, FOLLOW_PLAN, WAIT_DECISION, WAIT_DECISION, WAIT_DECISION]);
  const runId = `test-mount-ride-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController(baseEnv(runId, harness.port, fake.dir, { maxSteps: 5 }));
    assert.equal(code, 0, `the controller exits cleanly (stdout: ${stdout.slice(-400)})`);

    const acts = harness.calls.filter(c => c.path === '/act').map(c => c.payload.key);
    assert.ok(acts.length >= 3, `the follow resumed after the dismount (acts: ${JSON.stringify(acts)})`);
    assert.equal(acts.every(k => k === 'follow_player'), true, `nothing runs but the resumed follow: ${JSON.stringify(acts)}`);
    assert.equal(acts.includes('mount_boat'), false, 'the bot never boards a different boat');
    assert.equal(acts.includes('dismount'), false, "getting off is the rider's decision, not the bot's");
    assert.equal(acts.includes('join_human_mount'), false, 'the seat the human is in is not offered');

    const events = readEvents(runId);
    assert.equal(events.filter(e => e.type === 'mount_ride_hold').length, 1, 'the ride is announced once, not at every step');
    assert.equal(events.some(e => e.type === 'follow_lost'), false, 'being carried is not "I lost you"');
    assert.equal(events.some(e => e.type === 'mount_waiting_shore'), false, 'no shore line while sharing the boat');
    assert.equal(events.filter(e => e.type === 'decision').length, 0, 'no model call while the order is deterministic');
  } finally {
    harness.server.close();
  }
});
