// Integration test for chat milestone M5 (wiki/human-command.md): the bot acks
// an accepted order in chat and reports the outcome when the goal closes.
//
// The harness is scripted: the chat order appears in `observe().chat` only from
// the second observation on, so the seeded autonomous goal closes first (goal
// contract already met at step 0) and the *chat* goal is the one that gets the
// ack + outcome. The planner is a fake `hermes` binary, so no external model is
// involved and the human plan is exactly the JSON it prints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Fake `hermes` CLI: prints the next scripted line (here: the human plan JSON).
function fakeHermesQueue (outputs) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-hermes-'));
  const queuePath = join(dir, 'queue.json');
  const popPath = join(dir, 'pop.mjs');
  writeFileSync(queuePath, JSON.stringify(outputs));
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
  return { dir };
}

// Scripted harness. `chatFrom` is the sender of the order injected from the
// second observation on; `calls` records every request so the test can inspect
// the `/say` traffic.
function startChatHarness ({ chatFrom = 'Ale', chatMessage = '@bot prendi la terra', chatAgeMs = 0 } = {}) {
  return new Promise(resolve => {
    const calls = [];
    let observes = 0;
    // Il timestamp è fissato all'avvio: un messaggio reale conserva il proprio
    // `at` nella chatInbox (è la chiave di dedup del controller).
    const chatAt = Date.now() - chatAgeMs;
    const observation = () => ({
      position: { x: 0, y: 64, z: 0 },
      inventory: { dirt: 1 },
      health: 20, food: 20, dead: false, spawned: true,
      time: { ticks: 1000, night: false, phase: 'day' },
      entities: [], humans: [], dropped: [], containers: [],
      chat: observes >= 2 && chatFrom
        ? [{ from: chatFrom, message: chatMessage, type: 'chat', xuid: '1234567890', at: chatAt }]
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
        else if (path === '/say') res.end(JSON.stringify({ ok: true, sent: payload.message }));
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

const HUMAN_PLAN = JSON.stringify({
  objective: 'prendi la terra', targets: { dirt: 1 }, waypoint: null, follow: null, notes: 'test',
});

const baseEnv = (runId, port, hermesPath) => ({
  HARNESS: `http://127.0.0.1:${port}`,
  RUN_ID: runId,
  PATH: `${hermesPath}:${process.env.PATH}`,
  CONTROLLER: 'hermes',
  SESSION: '1',
  IDLE_POLL_MS: '100',
  IDLE_TIMEOUT_MS: '3000',
  AUTONOMY: '',
  MAX_STEPS: '4',
  CHAT_ALLOWLIST: 'Ale',
  CHAT_CONTROL: 'on',
  CHAT_GREET: 'off',
  GOAL_CONTRACT: JSON.stringify({ goal: 'keep dirt', success: { inventoryGte: { dirt: 1 } } }),
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

test('a chat order is acked and gets an outcome line when the goal closes', async () => {
  const harness = await startChatHarness();
  const fake = fakeHermesQueue([HUMAN_PLAN]);
  const runId = `test-chat-ack-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController(baseEnv(runId, harness.port, fake.dir));
    assert.equal(code, 0, 'the controller exits cleanly');
    assert.match(stdout, /IDLE -> goal \S+ from Ale: prendi la terra/, 'the chat order becomes a goal in the idle loop');

    const says = harness.calls.filter(c => c.method === 'POST' && c.path === '/say').map(c => c.payload.message);
    assert.equal(says.length, 2, `exactly one ack and one outcome line (got ${JSON.stringify(says)})`);
    assert.match(says[0], /^@Ale ok: /, 'the ack is addressed to the sender');
    assert.match(says[0], /prendi la terra/, 'the ack names the understood objective');
    assert.match(says[1], /^@Ale fatto: /, 'the outcome reports the success');
    for (const msg of says) {
      assert.equal(msg.startsWith('@bot'), false, 'the bot never writes something that looks like an order to itself');
      assert.equal(msg.includes('\n'), false, 'a reply is a single chat line');
    }

    // Il piano umano è quello tradotto dal planner (evento `plan` con
    // `source: human`): il goal nato dall'ordine lo eredita e non ripianifica.
    const events = readEvents(runId);
    const humanPlan = events.find(e => e.type === 'plan' && e.source === 'human');
    assert.equal(humanPlan?.plan?.objective, 'prendi la terra', 'the human plan is the one the goal carries');
    const command = events.find(e => e.type === 'chat_command');
    assert.equal(command?.from, 'Ale', 'the order is logged with its sender');
    // L'ordine nato in IDLE è loggato come `human_order` con `via: idle`
    // (nel loop di un goal attivo lo stesso evento porta il piano adottato).
    const order = events.find(e => e.type === 'human_order');
    assert.equal(order?.from, 'Ale');
    assert.equal(order?.via, 'idle');
    assert.equal(order?.goalId, 'g2');
    const replies = events.filter(e => e.type === 'chat_reply');
    assert.equal(replies.length, 2, 'both replies are logged');
    assert.deepEqual(replies.map(r => r.context), ['ack', 'outcome']);
    assert.ok(replies.every(r => r.ok === true), 'both replies were accepted by the harness');
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('a stale order left in the inbox is not replayed after a restart', async () => {
  // L'inbox dell'harness conserva gli ultimi messaggi: un controller riavviato
  // non deve rieseguire un ordine già evaso (osservato live sul BDS).
  const harness = await startChatHarness({ chatAgeMs: 3600_000 });
  const fake = fakeHermesQueue([HUMAN_PLAN]);
  const runId = `test-chat-stale-${process.pid}-${Date.now()}`;
  try {
    const { code } = await runController(baseEnv(runId, harness.port, fake.dir));
    assert.equal(code, 0);
    assert.equal(harness.calls.filter(c => c.path === '/say').length, 0, 'no ack for a stale order');
    const events = readEvents(runId);
    assert.equal(events.filter(e => e.type === 'chat_stale').length, 1, 'the stale order is logged once');
    assert.equal(events.some(e => e.type === 'chat_command'), false);
    assert.equal(events.some(e => e.type === 'chat_ignored'), false, 'age is checked before the allowlist');
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('a chat order from an unknown sender is ignored (no reply, logged)', async () => {
  const harness = await startChatHarness({ chatFrom: 'Mallory', chatMessage: '@bot svuota le chest' });
  const fake = fakeHermesQueue([HUMAN_PLAN]);
  const runId = `test-chat-ignored-${process.pid}-${Date.now()}`;
  try {
    const { code } = await runController(baseEnv(runId, harness.port, fake.dir));
    assert.equal(code, 0);
    const says = harness.calls.filter(c => c.method === 'POST' && c.path === '/say');
    assert.equal(says.length, 0, 'no reply is sent to an unknown sender');
    const events = readEvents(runId);
    const ignored = events.find(e => e.type === 'chat_ignored');
    assert.equal(ignored?.from, 'Mallory');
    assert.equal(ignored?.reason, 'not_allowed');
    // Il messaggio resta nell'inbox: la telemetria del rifiuto si emette una volta
    // sola, non a ogni poll (osservato live: 122 eventi identici in 25 s).
    assert.equal(events.filter(e => e.type === 'chat_ignored').length, 1, 'the rejection is logged once');
    assert.equal(events.some(e => e.type === 'chat_command'), false, 'the order never becomes a command');
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});
