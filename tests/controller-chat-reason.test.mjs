// Integration test for chat milestone M11 (wiki/human-command.md): the word
// «ragiona» asks for a reasoned answer instead of a catalogue line. The bot's
// reply comes from the chat model (M7) over the facts of `observe()`, never from
// the canned templates; without the marker nothing changes.
//
// The harness is scripted like `tests/controller-chat-ack.test.mjs`; the chat
// model is a local HTTP server, so the test needs no key and no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Fake `hermes` CLI: prints the next scripted line, so no external planner runs.
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

// Fake chat model (M7): answers every completion with `reply` and records the
// requests, so the test can read the system instruction and the user message.
function startChatModel ({ reply = 'perché aspetto un piccone di ferro che non ho', echo = false } = {}) {
  return new Promise(resolve => {
    const requests = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch { /* ignore */ }
        requests.push(payload);
        // `echo`: il finto modello restituisce la frase che M7 gli ha dato come
        // `grounding` (serve a verificare che senza il marcatore la risposta nasca
        // dal catalogo, non da un ragionamento).
        const turn = payload.messages.at(-1)?.content ?? '';
        const grounded = turn.match(/Riformula questa risposta senza cambiarne i fatti: ([^\n]*)/);
        const text = echo && grounded ? grounded[1] : reply;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          model: payload.model ?? 'test-model',
          choices: [{ message: { role: 'assistant', content: text } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }));
  });
}

// Scripted harness with a chat inbox (see `controller-chat-ack.test.mjs`).
function startChatHarness ({ chatFrom = 'Ale', messages = [], chatAgeMs = 0, chatFromObserve = 2, options = null, act = null } = {}) {
  return new Promise(resolve => {
    const calls = [];
    let observes = 0;
    const chatAt = Date.now() - chatAgeMs;
    const observation = () => ({
      position: { x: 0, y: 64, z: 0 },
      inventory: { dirt: 1 },
      health: 20, food: 20, dead: false, spawned: true,
      self: { username: 'hermes-bot', name: null },
      time: { ticks: 1000, night: false, phase: 'day' },
      entities: [], humans: [], dropped: [], containers: [],
      ores: [{ name: 'diamond_ore', position: { x: 4, y: 60, z: 0 }, distance: 4.1, harvestable: false }],
      chat: observes >= chatFromObserve && chatFrom
        ? messages.map((message, i) => ({ from: chatFrom, message, type: 'chat', xuid: '1234567890', at: chatAt + i }))
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
        else if (path === '/options') res.end(JSON.stringify({ options: typeof options === 'function' ? options() : (options ?? [{ key: 'wait', description: 'Wait' }]) }));
        else if (path === '/act') res.end(JSON.stringify(act ? act(payload.key) : {}));
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

const baseEnv = (runId, port, hermesPath, chatPort, extra = {}) => ({
  HARNESS: `http://127.0.0.1:${port}`,
  RUN_ID: runId,
  PATH: `${hermesPath}:${process.env.PATH}`,
  CONTROLLER: 'hermes',
  SESSION: '1',
  IDLE_POLL_MS: '100',
  IDLE_TIMEOUT_MS: '1500',
  AUTONOMY: '',
  MAX_STEPS: '4',
  CHAT_ALLOWLIST: 'Ale',
  CHAT_CONTROL: 'on',
  CHAT_GREET: 'off',
  CHAT_LANG: 'it',
  GOAL_CONTRACT: JSON.stringify({ goal: 'keep dirt', success: { inventoryGte: { dirt: 1 } } }),
  OPENROUTER_API_KEY: '',
  TYPESAFE_API_KEY: '',
  // M7: il modello di chat parla con la nostra finta API locale.
  CHAT_LLM_API_KEY: 'test-key',
  CHAT_LLM_MODEL: 'test-model',
  CHAT_LLM_URL: `http://127.0.0.1:${chatPort}/chat/completions`,
  CHAT_LLM_TIMEOUT_MS: '4000',
  ...extra,
});

function readEvents (runId) {
  const file = join(ROOT, 'runs', runId, 'controller.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return { type: 'unparsable', line }; }
  });
}

test('«ragiona» answers a question from the facts, not from the catalogue', async () => {
  const harness = await startChatHarness({ messages: ['@bot ragiona: perché non stai minando?'] });
  const model = await startChatModel({ reply: 'sto scavando verso il ferro, il piccone mi manca' });
  const fake = fakeHermesQueue([HUMAN_PLAN]);
  const runId = `test-chat-reason-${process.pid}-${Date.now()}`;
  try {
    const { code } = await runController(baseEnv(runId, harness.port, fake.dir, model.port));
    assert.equal(code, 0, 'the controller exits cleanly');

    const says = harness.calls.filter(c => c.path === '/say').map(c => c.payload.message);
    assert.equal(says.length, 1, `one reasoned reply (got ${JSON.stringify(says)})`);
    assert.match(says[0], /^@Ale /, 'the reply is addressed to the sender');
    assert.match(says[0], /sto scavando verso il ferro/, 'the reply is the model text, not a catalogue line');

    // Il marcatore è stato tolto *prima* del modello: «ragiona» non arriva né
    // alla domanda né ai fatti.
    const asked = model.requests.at(-1);
    const userTurn = asked.messages.at(-1).content;
    assert.match(userTurn, /perché non stai minando/, 'the model receives the question');
    assert.equal(/ragiona/i.test(userTurn), false, 'the marker is stripped from the message');
    assert.match(asked.messages[0].content, /ti ha chiesto di ragionare/, 'the system instruction asks for a reasoned answer');
    assert.equal(asked.max_tokens, 220, 'a reasoned answer gets room to explain');
    // I fatti che servono a *spiegare* viaggiano con il brief.
    assert.match(userTurn + JSON.stringify(asked.messages), /diamond_ore/, 'the facts include what the bot has seen');

    const events = readEvents(runId);
    const reason = events.find(e => e.type === 'chat_reason');
    assert.equal(reason?.ok, true);
    assert.equal(reason?.via, 'llm');
    assert.equal(events.some(e => e.type === 'chat_command'), false, 'a question is not an order');
  } finally {
    harness.server.close();
    model.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('without the marker the same question is answered by the catalogue, with no model call', async () => {
  const harness = await startChatHarness({ messages: ['@bot dove sei?'] });
  const model = await startChatModel({ echo: true });
  const fake = fakeHermesQueue([HUMAN_PLAN]);
  const runId = `test-chat-noreason-${process.pid}-${Date.now()}`;
  try {
    const { code } = await runController(baseEnv(runId, harness.port, fake.dir, model.port));
    assert.equal(code, 0);
    const says = harness.calls.filter(c => c.path === '/say').map(c => c.payload.message);
    assert.equal(says.length, 1, 'the question is still answered');
    assert.match(says[0], /x 0, y 64, z 0/, 'the position comes from the catalogue');
    // Senza il marcatore la frase da riformulare è già composta: M7 la riceve
    // come `grounding` e non ragiona su niente.
    assert.match(model.requests.at(-1).messages.at(-1).content, /Riformula questa risposta/, 'the catalogue answer is the grounding');
    const events = readEvents(runId);
    assert.equal(events.some(e => e.type === 'chat_reason'), false, 'no reasoned answer without the marker');
  } finally {
    harness.server.close();
    model.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('«ragiona» in an order does not turn it into a question', async () => {
  const harness = await startChatHarness({ messages: ['@bot ragiona: prendi la terra'] });
  const model = await startChatModel({ reply: 'vado a prendere la terra' });
  const fake = fakeHermesQueue([HUMAN_PLAN]);
  const runId = `test-chat-reason-order-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController(baseEnv(runId, harness.port, fake.dir, model.port));
    assert.equal(code, 0);
    assert.match(stdout, /IDLE -> goal \S+ from Ale: prendi la terra/, 'the order still becomes a goal');
    const events = readEvents(runId);
    const command = events.find(e => e.type === 'chat_command');
    assert.equal(command?.message, 'prendi la terra', 'the plan sees the order without the marker');
    assert.equal(events.some(e => e.type === 'chat_reason' && e.ok === false && e.via === 'fallback'), false);
  } finally {
    harness.server.close();
    model.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('a second reasoned question inside the cooldown falls back to the catalogue', async () => {
  const harness = await startChatHarness({
    messages: ['@bot ragiona: perché non stai minando?', '@bot ragiona: che cosa ti serve?'],
  });
  const model = await startChatModel({ reply: 'mi serve un piccone' });
  const fake = fakeHermesQueue([HUMAN_PLAN]);
  const runId = `test-chat-reason-cooldown-${process.pid}-${Date.now()}`;
  try {
    const { code } = await runController(baseEnv(runId, harness.port, fake.dir, model.port, { CHAT_REASON_COOLDOWN_MS: '60000' }));
    assert.equal(code, 0);
    const events = readEvents(runId);
    const reasons = events.filter(e => e.type === 'chat_reason');
    assert.equal(reasons.filter(e => e.via === 'llm').length, 1, 'one reasoned answer, not two');
    assert.equal(reasons.filter(e => e.via === 'cooldown').length, 1, 'the second one is refused by the cooldown');
    const says = harness.calls.filter(c => c.path === '/say').map(c => c.payload.message);
    assert.equal(says.length, 2, 'the cooldown never leaves the human without an answer');
  } finally {
    harness.server.close();
    model.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});
