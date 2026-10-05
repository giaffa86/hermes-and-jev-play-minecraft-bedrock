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
import { QUESTION_INTENTS, intentCriteria } from '../human-questions.mjs';

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
function startChatHarness ({ chatFrom = 'Ale', chatMessage = '@bot prendi la terra', chatAgeMs = 0, self = { username: 'hermes-bot', name: null }, options = null, act = null, extra = () => ({}) } = {}) {
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
      // M6.2: come l'adapter, l'osservazione dichiara chi è il bot: `username`
      // (BEDROCK_USERNAME) e `name` (gamertag imparato dall'eco).
      self,
      time: { ticks: 1000, night: false, phase: 'day' },
      entities: [], humans: [], dropped: [], containers: [],
      // `extra()` consente a un test di far evolvere l'osservazione (armatura
      // indossata, inventario) e quindi di verificare un vero criterio di
      // successo invece del solo testo delle risposte.
      ...extra(),
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
        else if (path === '/options') res.end(JSON.stringify({ options: typeof options === 'function' ? options() : (options ?? []) }));
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

// Harness scriptato per gli ordini di equipaggiamento: `equip_armor` è offerto
// solo finché l'armatura è in inventario e, dopo l'azione, l'osservazione mostra
// i pezzi *addosso* — è `observe().armor` il criterio di successo, non
// l'inventario (un elmetto nello zaino non è un elmetto indossato).
async function startEquipHarness ({ chatMessage = "@bot equipaggiati con l'elmetto", inv = { dirt: 1, iron_helmet: 1 } } = {}) {
  let equipped = false;
  // `equip_armor` è offerto solo finché un pezzo di armatura è davvero in
  // inventario (come `options()` dell'adapter): senza armatura l'ordine deve
  // incontrare il rifiuto, non un'azione che fallisce.
  const hasArmor = Object.keys(inv).some(name => /_(helmet|chestplate|leggings|boots)$/.test(name));
  const harness = await startChatHarness({
    chatMessage,
    extra: () => ({
      inventory: equipped ? { dirt: 1 } : { ...inv },
      armor: {
        helmet: equipped ? 'iron_helmet' : null,
        chestplate: null, leggings: null, boots: null,
        points: equipped ? 2 : 0,
      },
    }),
    options: () => (equipped || !hasArmor
      ? [{ key: 'wait', description: 'Wait' }]
      : [
          { key: 'equip_armor', description: 'Equip armor pieces from inventory (helmet/chestplate/leggings/boots)' },
          { key: 'wait', description: 'Wait' },
        ]),
    act: key => {
      if (key === 'equip_armor') equipped = true;
      return { ok: true, ms: 5 };
    },
  });
  return { ...harness, isEquipped: () => equipped };
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

// Più trigger per lo stesso bot (`CHAT_PREFIXES`): il prefisso generico e il
// nome del bot sono equivalenti, e la reply non deve somigliare a un ordine per
// nessuno dei due (altrimenti il bot — o un altro bot sul canale — si riordina).
test('an order is accepted with any configured trigger, and the prefix is stripped', async () => {
  const harness = await startChatHarness({ chatFrom: 'Ale', chatMessage: '@hermes prendi la terra' });
  const fake = fakeHermesQueue([HUMAN_PLAN]);
  const runId = `test-chat-prefixes-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController({
      ...baseEnv(runId, harness.port, fake.dir),
      CHAT_PREFIXES: '@bot,@hermes',
    });
    assert.equal(code, 0);
    assert.match(stdout, /IDLE -> goal \S+ from Ale: prendi la terra/, 'il trigger viene rimosso dal testo dell\'ordine');

    const says = harness.calls.filter(c => c.method === 'POST' && c.path === '/say').map(c => c.payload.message);
    assert.equal(says.length, 2, `ack + esito (got ${JSON.stringify(says)})`);
    for (const msg of says) {
      assert.equal(msg.startsWith('@bot'), false, 'la reply non è un ordine per il trigger generico');
      assert.equal(msg.startsWith('@hermes'), false, 'la reply non è un ordine per il trigger personale');
    }

    const command = readEvents(runId).find(e => e.type === 'chat_command');
    assert.equal(command?.prefix, '@hermes', 'il log dice quale trigger ha matchato');
    assert.equal(command?.message, 'prendi la terra');
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('a message that starts with an unconfigured prefix is not an order', async () => {
  const harness = await startChatHarness({ chatFrom: 'Ale', chatMessage: '@jev fermati' });
  const fake = fakeHermesQueue([HUMAN_PLAN]);
  const runId = `test-chat-noprefix-${process.pid}-${Date.now()}`;
  try {
    const { code } = await runController({
      ...baseEnv(runId, harness.port, fake.dir),
      CHAT_PREFIXES: '@bot,@hermes',
    });
    assert.equal(code, 0);
    assert.equal(harness.calls.filter(c => c.path === '/say').length, 0, 'nessuna reply');
    const events = readEvents(runId);
    assert.equal(events.some(e => e.type === 'chat_command'), false, 'non e un comando');
    assert.equal(events.some(e => e.type === 'chat_ignored'), false, 'non e nemmeno un rifiuto: non era un ordine');
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

// M6 (chat questions): il messaggio con trigger che chiede un fatto sul bot
// riceve una risposta composta da `observe()` — mai scritta dal modello — e
// **non** produce un goal. Il fast path regex risponde senza alcuna chiave.
test('a chat question is answered from the observation and never becomes a goal', async () => {
  const harness = await startChatHarness({ chatFrom: 'Ale', chatMessage: '@bot dove sei?' });
  const fake = fakeHermesQueue([HUMAN_PLAN]);
  const runId = `test-chat-question-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController(baseEnv(runId, harness.port, fake.dir));
    assert.equal(code, 0, 'the controller exits cleanly');
    assert.equal(stdout.includes('from Ale'), false, 'una domanda non diventa un goal');

    const says = harness.calls.filter(c => c.method === 'POST' && c.path === '/say').map(c => c.payload.message);
    assert.equal(says.length, 1, `una sola risposta (got ${JSON.stringify(says)})`);
    assert.match(says[0], /^@Ale /, 'la risposta è indirizzata a chi ha chiesto');
    assert.match(says[0], /64/, 'la posizione viene dai fatti di observe(), non dal modello');

    const events = readEvents(runId);
    assert.equal(events.some(e => e.type === 'chat_command'), false, 'non è un ordine');
    assert.equal(events.some(e => e.type === 'human_order'), false, 'nessun ordine umano registrato');
    const question = events.find(e => e.type === 'chat_question');
    assert.equal(question?.intent, 'q_position');
    assert.equal(question?.via, 'regex');
    const reply = events.find(e => e.type === 'chat_reply');
    assert.equal(reply?.context, 'question', 'la reply è marcata come risposta');
    assert.equal(events.filter(e => e.type === 'chat_reply').length, 1, 'si risponde una volta sola al messaggio');
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

// Stub della decisions API: registra header e body, e sceglie l'opzione passata.
function startDecisionStub ({ choice, probabilities = {} }) {
  return new Promise(resolve => {
    const calls = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        calls.push({ headers: req.headers, body: JSON.parse(body || '{}') });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ model: 'jev-stub', usage: { cost: 0.0002 }, answers: { intent: { choice, probabilities } } }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, calls }));
  });
}

// Un messaggio che la regex non copre va a System One (Jev) su lista chiusa: il
// modello sceglie l'intento, la risposta resta composta dai fatti.
test('a free-form question is routed by System One and still answered from the facts', async () => {
  const criteria = intentCriteria();
  const choice = Object.keys(criteria).find(key => criteria[key].startsWith('[q_activity]'));
  assert.ok(choice, 'q_activity è offerto al modello');
  const stub = await startDecisionStub({ choice, probabilities: { [choice]: 0.9 } });
  const harness = await startChatHarness({ chatFrom: 'Ale', chatMessage: '@bot che combini?' });
  const fake = fakeHermesQueue([HUMAN_PLAN]);
  const runId = `test-chat-intent-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController({
      ...baseEnv(runId, harness.port, fake.dir),
      TYPESAFE_API_KEY: 'test-key',
      CHAT_INTENT: 'on',
      CHAT_INTENT_URL: `http://127.0.0.1:${stub.port}/v1/systemone`,
    });
    assert.equal(code, 0);
    assert.equal(stdout.includes('from Ale'), false, 'una domanda instradata dal modello non diventa un goal');

    assert.equal(stub.calls.length, 1, 'una sola decisione chiesta');
    assert.equal(stub.calls[0].headers.authorization, 'Bearer test-key');
    const state = JSON.parse(stub.calls[0].body.state);
    assert.equal(state.message, 'che combini?');
    assert.equal(state.from, 'Ale');
    const options = Object.keys(stub.calls[0].body.questions.intent.criteria);
    assert.equal(options.length, QUESTION_INTENTS.length + 1, 'la lista chiusa offre ogni intento più q_none');

    const says = harness.calls.filter(c => c.method === 'POST' && c.path === '/say').map(c => c.payload.message);
    assert.equal(says.length, 1, `una sola risposta (got ${JSON.stringify(says)})`);
    assert.match(says[0], /^@Ale /);

    const events = readEvents(runId);
    assert.equal(events.some(e => e.type === 'chat_command'), false, 'non è un ordine');
    const intent = events.find(e => e.type === 'chat_intent');
    assert.equal(intent?.intent, 'q_activity', 'il log dice quale intento ha scelto il modello');
    assert.equal(intent?.chosen, 'q_activity');
    assert.equal(intent?.probability, 0.9);
    assert.equal(intent?.model, 'jev-stub');
    assert.equal(events.find(e => e.type === 'chat_question')?.via, 'jev');
  } finally {
    stub.server.close();
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

// Un endpoint di decisione che non risponde mai: il router deve andare in
// timeout e rifiutare, non ricadere nell'order path.
function startHangingDecisionStub () {
  return new Promise(resolve => {
    const calls = [];
    const server = createServer((req, _res) => {
      calls.push({ method: req.method, path: req.url });
      // Nessuna risposta: l'unico limite è l'AbortSignal.timeout del controller.
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, calls }));
  });
}

function closeStub (stub) {
  stub.server.closeAllConnections?.();
  stub.server.close();
}

// M6.1: senza router una domanda non si trasforma in un ordine. Il bot dice che
// non ha capito (con la sintassi per rimediare) e non crea nessun goal.
test('without System One a question is refused, not turned into an order (M6.1)', async () => {
  const harness = await startChatHarness({ chatFrom: 'Ale', chatMessage: '@bot che combini?' });
  const fake = fakeHermesQueue([HUMAN_PLAN]);
  const runId = `test-chat-unrouted-nokey-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController({ ...baseEnv(runId, harness.port, fake.dir), CHAT_INTENT: 'off' });
    assert.equal(code, 0);
    assert.equal(stdout.includes('from Ale'), false, 'una domanda senza router non diventa un goal');

    const says = harness.calls.filter(c => c.method === 'POST' && c.path === '/say').map(c => c.payload.message);
    assert.equal(says.length, 1, `un solo rifiuto (got ${JSON.stringify(says)})`);
    assert.match(says[0], /^@Ale /);
    assert.match(says[0], /non ho capito la domanda/);
    assert.match(says[0], /@bot( o @[^ ]+)* <ordine>/, 'il rifiuto mostra la via d\'uscita verso gli ordini');

    const events = readEvents(runId);
    assert.equal(events.some(e => e.type === 'chat_command'), false, 'nessun ordine creato');
    assert.equal(events.some(e => e.type === 'chat_question'), false, 'nessuna risposta data');
    const unrouted = events.find(e => e.type === 'chat_unrouted');
    assert.equal(unrouted?.reason, 'no_key', 'la telemetria distingue no_key da disabled');
    assert.equal(events.find(e => e.type === 'chat_reply' && e.context === 'unrouted') != null, true);
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

// Il pre-filtro: un messaggio che non ha forma di domanda non chiede nulla a Jev
// e resta un ordine, anche con il router configurato e funzionante.
test('a message that is not question-shaped skips the router entirely (pre-filter)', async () => {
  const stub = await startDecisionStub({ choice: 'a0', probabilities: { a0: 0.99 } });
  const harness = await startChatHarness({ chatFrom: 'Ale', chatMessage: '@bot sei un cretino' });
  const fake = fakeHermesQueue([HUMAN_PLAN]);
  const runId = `test-chat-prefilter-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController({
      ...baseEnv(runId, harness.port, fake.dir),
      TYPESAFE_API_KEY: 'test-key',
      CHAT_INTENT: 'on',
      CHAT_INTENT_URL: `http://127.0.0.1:${stub.port}/v1/systemone`,
    });
    assert.equal(code, 0);
    assert.equal(stub.calls.length, 0, 'un ordine non paga una chiamata di rete');
    assert.match(stdout, /IDLE -> goal \S+ from Ale: /, 'resta un ordine');
    const events = readEvents(runId);
    assert.ok(events.some(e => e.type === 'chat_command'));
    assert.equal(events.some(e => e.type === 'chat_intent'), false, 'il modello non viene nemmeno interrogato');
  } finally {
    closeStub(stub);
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

// "riesci a raggiungermi?" è un ordine espresso come domanda: se il modello
// funziona e dice `q_none`, il messaggio deve tornare all'order path.
test('an order phrased as a question is decided by the model, not by the guard', async () => {
  const criteria = intentCriteria();
  const choice = Object.keys(criteria).find(key => criteria[key].startsWith('[q_none]'));
  const stub = await startDecisionStub({ choice, probabilities: { [choice]: 0.95 } });
  const harness = await startChatHarness({ chatFrom: 'Ale', chatMessage: '@bot riesci a raggiungermi?' });
  const fake = fakeHermesQueue([HUMAN_PLAN]);
  const runId = `test-chat-qnone-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController({
      ...baseEnv(runId, harness.port, fake.dir),
      TYPESAFE_API_KEY: 'test-key',
      CHAT_INTENT: 'on',
      CHAT_INTENT_URL: `http://127.0.0.1:${stub.port}/v1/systemone`,
    });
    assert.equal(code, 0);
    assert.equal(stub.calls.length, 1, 'una domanda in forma di domanda viene instradata');
    assert.match(stdout, /IDLE -> goal \S+ from Ale: /, 'q_none significa ordine');
    const events = readEvents(runId);
    assert.ok(events.some(e => e.type === 'chat_command'));
    assert.equal(events.some(e => e.type === 'chat_unrouted'), false, 'q_none è una decisione, non un guasto');
    assert.equal(events.find(e => e.type === 'chat_intent')?.reason, 'not_a_question');
  } finally {
    closeStub(stub);
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

// Un router che non risponde in tempo: la domanda resta senza risposta, ma non
// diventa un ordine. Il messaggio deve stare **fuori** dalla fast path regex
// (`q_health`/`q_inventory` risponderebbero offline, senza mai toccare il
// router): `chi mi sta guardando?` è una domanda che nessuna regex copre.
test('a router timeout is reported and the bot does not move', async () => {
  const stub = await startHangingDecisionStub();
  const harness = await startChatHarness({ chatFrom: 'Ale', chatMessage: '@bot chi mi sta guardando?' });
  const fake = fakeHermesQueue([HUMAN_PLAN]);
  const runId = `test-chat-timeout-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController({
      ...baseEnv(runId, harness.port, fake.dir),
      TYPESAFE_API_KEY: 'test-key',
      CHAT_INTENT: 'on',
      CHAT_INTENT_TIMEOUT_MS: '60',
      CHAT_INTENT_URL: `http://127.0.0.1:${stub.port}/v1/systemone`,
    });
    assert.equal(code, 0);
    assert.equal(stdout.includes('from Ale'), false, 'il timeout non muove il bot');
    const says = harness.calls.filter(c => c.method === 'POST' && c.path === '/say').map(c => c.payload.message);
    assert.equal(says.length, 1, `un solo rifiuto (got ${JSON.stringify(says)})`);
    assert.match(says[0], /non ho capito la domanda/);
    const events = readEvents(runId);
    assert.equal(events.some(e => e.type === 'chat_command'), false);
    assert.equal(events.find(e => e.type === 'chat_unrouted')?.reason, 'timeout');
    assert.equal(events.find(e => e.type === 'chat_reply' && e.context === 'unrouted') != null, true);
  } finally {
    closeStub(stub);
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

// Il caso che ha motivato M6.1: una domanda innocua con il router giù non deve
// diventare `follow <sender>`. Il messaggio è fuori dalla fast path regex
// (`q_health` risponderebbe offline), così il rifiuto è davvero quello di M6.1.
test('a question can no longer become a follow goal when the router is down (M6.1)', async () => {
  const harness = await startChatHarness({ chatFrom: 'Ale', chatMessage: '@bot chi mi sta guardando?' });
  const fake = fakeHermesQueue([HUMAN_PLAN]);
  const runId = `test-chat-nofollow-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController({ ...baseEnv(runId, harness.port, fake.dir), CHAT_INTENT: 'off' });
    assert.equal(code, 0);
    assert.equal(stdout.includes('from Ale'), false, 'nessun goal: niente follow');
    const says = harness.calls.filter(c => c.method === 'POST' && c.path === '/say').map(c => c.payload.message);
    assert.match(says[0], /non ho capito la domanda/, 'rifiuto, non silenzio');
    const events = readEvents(runId);
    assert.equal(events.some(e => e.type === 'chat_command'), false);
    assert.equal(events.some(e => e.type === 'plan' && e.source === 'human'), false, 'nessun piano umano creato');
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

// Senza router un messaggio non in forma di domanda resta un ordine: il canale
// non si zittisce mai, e il comportamento di M5 è intatto.
test('without System One a plain order still works (no silent channel)', async () => {
  const harness = await startChatHarness({ chatFrom: 'Ale', chatMessage: '@bot prendi la terra' });
  const fake = fakeHermesQueue([HUMAN_PLAN]);
  const runId = `test-chat-nointent-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController({ ...baseEnv(runId, harness.port, fake.dir), CHAT_INTENT: 'off' });
    assert.equal(code, 0);
    assert.match(stdout, /IDLE -> goal \S+ from Ale: /, 'senza router il messaggio resta un ordine');
    const events = readEvents(runId);
    assert.ok(events.some(e => e.type === 'chat_command'), 'loggato come comando');
    assert.equal(events.some(e => e.type === 'chat_question'), false, 'nessuna risposta: non è stato interpretato');
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('the bot answers to its own auth name (BEDROCK_USERNAME)', async () => {
  const harness = await startChatHarness({
    chatFrom: 'Ale', chatMessage: '@hermes-bot prendi la terra',
    self: { username: 'hermes-bot', name: null },
  });
  const fake = fakeHermesQueue([HUMAN_PLAN]);
  const runId = `test-chat-selfname-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController(baseEnv(runId, harness.port, fake.dir));
    assert.equal(code, 0);
    assert.match(stdout, /IDLE -> goal \S+ from Ale: /, 'chiamato per nome, l\'ordine è accettato');
    const says = harness.calls.filter(c => c.method === 'POST' && c.path === '/say');
    assert.ok(says.some(c => /^@Ale ok: /.test(String(c.payload?.message ?? ''))), 'ack al mittente');
    const cmd = readEvents(runId).find(e => e.type === 'chat_command');
    assert.equal(cmd?.prefix, '@hermes-bot', 'il trigger riconosciuto è il nome, non @bot');
    assert.equal(cmd?.message, 'prendi la terra', 'il nome è stato rimosso dal messaggio');
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('the bot answers to the gamertag the server gave it (learned at runtime)', async () => {
  const harness = await startChatHarness({
    chatFrom: 'Ale', chatMessage: '@Miner prendi la terra',
    self: { username: 'hermes-bot', name: 'Miner' },
  });
  const fake = fakeHermesQueue([HUMAN_PLAN]);
  const runId = `test-chat-ownname-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController(baseEnv(runId, harness.port, fake.dir));
    assert.equal(code, 0);
    assert.match(stdout, /IDLE -> goal \S+ from Ale: /, 'il gamertag appreso è un trigger');
    const cmd = readEvents(runId).find(e => e.type === 'chat_command');
    assert.equal(cmd?.prefix, '@miner', 'trigger normalizzato in minuscolo');
    assert.equal(cmd?.message, 'prendi la terra');
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test('CHAT_SELF_NAME=off leaves only the configured triggers', async () => {
  const harness = await startChatHarness({
    chatFrom: 'Ale', chatMessage: '@hermes-bot prendi la terra',
    self: { username: 'hermes-bot', name: 'Miner' },
  });
  const fake = fakeHermesQueue([HUMAN_PLAN]);
  const runId = `test-chat-noselfname-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController({ ...baseEnv(runId, harness.port, fake.dir), CHAT_SELF_NAME: 'off' });
    assert.equal(code, 0);
    assert.equal(stdout.includes('from Ale'), false, 'senza i nomi il messaggio non è un ordine');
    assert.equal(harness.calls.filter(c => c.method === 'POST' && c.path === '/say').length, 0, 'nessun ack');
    assert.equal(readEvents(runId).some(e => e.type === 'chat_command'), false);
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test("un ordine di equipaggiamento è deterministico: equip_armor scelto dal controller, non dal modello", async () => {
  const harness = await startEquipHarness();
  // Coda vuota: se il controller interrogasse Hermes, il finto CLI stamperebbe
  // 'wait' e nessuna azione di equipaggiamento verrebbe eseguita.
  const fake = fakeHermesQueue([]);
  const runId = `test-chat-equip-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController({
      ...baseEnv(runId, harness.port, fake.dir),
      // Nessun contratto e target già soddisfatto: il goal autonomo seminato si
      // chiude a passo 0 e l'ordine in chat viene preso in IDLE come goal `chat`
      // a sé (se il goal autonomo fosse ancora aperto l'ordine verrebbe
      // assorbito da quello, come in `maybeHumanCommand` dentro `runGoal`).
      GOAL_CONTRACT: '', TARGETS: '{"dirt":1}', GOAL: 'wait for orders',
    });
    assert.equal(code, 0, `controller exited with ${code}`);
    assert.match(stdout, /EQUIP ORDER: equip_armor deterministico/, stdout);
    assert.equal(harness.isEquipped(), true, "l'armatura è finita addosso, non solo in inventario");

    const events = readEvents(runId);
    const plan = events.find(e => e.type === 'plan' && e.deterministic === 'equip');
    assert.equal(plan?.plan?.need, 'wear_armor', 'il piano dichiara un bisogno verificabile');
    assert.equal(plan?.plan?.equip, true);
    assert.equal(plan?.plan?.follow, null, 'un ordine di equipaggiamento non è un `follow`');
    assert.equal(events.some(e => e.type === 'plan_fallback'), false, 'Hermes non è mai interrogato');

    const acts = harness.calls.filter(c => c.path === '/act');
    assert.deepEqual(acts.map(c => c.payload.key), ['equip_armor']);
    // Una sola azione eseguita: nessun passo sprecato in `wait` o in ripensamenti.
    assert.equal(events.filter(e => e.type === 'result').length, 1);
    const says = harness.calls.filter(c => c.method === 'POST' && c.path === '/say').map(c => c.payload.message);
    assert.match(says[0], /^@Ale ok: /, 'ack immediato');
    // `stepsUsed` conta anche l'iterazione che *conferma* il successo (`goalMet`
    // è valutato in testa al loop), quindi le azioni riportate sono 1 + 1.
    assert.match(says[1], /^@Ale fatto: .*\(2 azioni\)/, 'esito con il conteggio azioni');
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test("un ordine di equipaggiamento senza armatura lo dice all'umano e fallisce, senza girare a vuoto", async () => {
  const harness = await startEquipHarness({ inv: { dirt: 1 } });
  const fake = fakeHermesQueue([]);
  const runId = `test-chat-equip-none-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController({
      ...baseEnv(runId, harness.port, fake.dir),
      GOAL_CONTRACT: '', TARGETS: '{"dirt":1}', GOAL: 'wait for orders',
    });
    assert.equal(code, 0, `controller exited with ${code}`);

    const events = readEvents(runId);
    const equip = events.find(e => e.type === 'equip_order');
    assert.equal(equip?.error, 'no_armor_in_inventory', `${stdout}\n${JSON.stringify(events)}`);
    const end = events.find(e => e.type === 'goal_end' && e.status === 'failed');
    assert.equal(end?.reason, 'no_armor_in_inventory', 'il motivo arriva fino a goal_end');

    const says = harness.calls.filter(c => c.method === 'POST' && c.path === '/say').map(c => c.payload.message);
    assert.match(says[0], /^@Ale ok: /);
    assert.ok(says.some(m => /non ho armatura in inventario/.test(m)), `manca il rifiuto: ${JSON.stringify(says)}`);
    assert.ok(says.some(m => /non ce l'ho fatta/.test(m)), `manca l'esito di fallimento: ${JSON.stringify(says)}`);
    assert.equal(harness.calls.some(c => c.path === '/act'), false, "nessuna azione: non c'è nulla da equipaggiare");
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

// Harness scriptato per gli ordini sull'inventario (M9). L'oggetto nominato
// decide se `drop_item`/`collect_drop` esistono, esattamente come `_plannedDrop`
// e `_plannedCollectNames` nell'adapter: senza l'oggetto nello zaino o a terra
// l'opzione non c'è e l'ordine deve incontrare il rifiuto, non un'azione che
// fallisce.
async function startInventoryHarness ({ chatMessage, inv = {}, drops = [], token }) {
  let inventory = { ...inv };
  let ground = drops.map((item, index) => ({ id: `d${index}`, item, count: 1, position: { x: 2, y: 63, z: 0 } }));
  const matches = name => (token === 'armor'
    ? /_(helmet|chestplate|leggings|boots)$/.test(name)
    : String(name).includes(token));
  const harness = await startChatHarness({
    chatMessage,
    extra: () => ({ inventory: { ...inventory }, drops: ground, dropped: ground }),
    options: () => {
      const offered = [];
      if (Object.entries(inventory).some(([name, count]) => count > 0 && matches(name))) {
        offered.push({ key: 'drop_item', description: `Drop ${token} from the inventory` });
      }
      if (ground.some(drop => matches(drop.item))) {
        offered.push({ key: 'collect_drop', description: `Pick up ${token} (2.0 blocks away)` });
      }
      return offered.length ? offered : [{ key: 'wait', description: 'Wait' }];
    },
    act: key => {
      if (key === 'drop_item') inventory = {};
      else if (key === 'collect_drop') {
        for (const drop of ground) inventory[drop.item] = (inventory[drop.item] || 0) + drop.count;
        ground = [];
      }
      return { ok: true, ms: 5 };
    },
  });
  return { ...harness, inventory: () => ({ ...inventory }), ground: () => [...ground] };
}

test("un ordine \"getta i diamanti\" è deterministico: drop_item scelto dal controller, non dal modello", async () => {
  const harness = await startInventoryHarness({
    chatMessage: '@bot getta i diamanti',
    inv: { dirt: 1, diamond: 3 },
    token: 'diamond',
  });
  const fake = fakeHermesQueue([]);
  const runId = `test-chat-drop-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController({
      ...baseEnv(runId, harness.port, fake.dir),
      GOAL_CONTRACT: '', TARGETS: '{"dirt":1}', GOAL: 'wait for orders',
    });
    assert.equal(code, 0, `controller exited with ${code}\n${stdout}`);
    assert.match(stdout, /DROP ORDER: drop_item deterministico/, stdout);
    assert.deepEqual(harness.inventory(), {}, "i diamanti sono usciti dall'inventario");

    const events = readEvents(runId);
    const plan = events.find(e => e.type === 'plan' && e.deterministic === 'drop');
    assert.equal(plan?.plan?.drop?.token, 'diamond');
    assert.equal(plan?.plan?.drop?.count, null, 'nessun numero: si butta tutto');
    assert.equal(plan?.plan?.follow, null, 'un ordine di gettare non è un `follow`');
    assert.equal(events.some(e => e.type === 'plan_fallback'), false, 'Hermes non è mai interrogato');

    const acts = harness.calls.filter(c => c.path === '/act');
    assert.deepEqual(acts.map(c => c.payload.key), ['drop_item'], 'una sola azione, nessun ripensamento');
    assert.equal(events.find(e => e.type === 'goal_end')?.status, 'completed');
    const says = harness.calls.filter(c => c.method === 'POST' && c.path === '/say').map(c => c.payload.message);
    assert.match(says[0], /^@Ale ok: /, 'ack immediato');
    assert.match(says[1], /^@Ale fatto: /, 'esito positivo');
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test("un ordine di gettare senza l'oggetto in inventario lo dice all'umano e non agisce", async () => {
  const harness = await startInventoryHarness({
    chatMessage: '@bot getta i diamanti',
    inv: { dirt: 1 },
    token: 'diamond',
  });
  const fake = fakeHermesQueue([]);
  const runId = `test-chat-drop-none-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController({
      ...baseEnv(runId, harness.port, fake.dir),
      GOAL_CONTRACT: '', TARGETS: '{"dirt":1}', GOAL: 'wait for orders',
    });
    assert.equal(code, 0, `controller exited with ${code}\n${stdout}`);
    assert.match(stdout, /DROP ORDER: oggetto non in inventario/, stdout);

    const events = readEvents(runId);
    const order = events.find(e => e.type === 'drop_order');
    assert.equal(order?.error, 'item_not_in_inventory', `${stdout}\n${JSON.stringify(events)}`);
    assert.equal(events.find(e => e.type === 'goal_end' && e.status === 'failed')?.reason, 'item_not_in_inventory');
    const says = harness.calls.filter(c => c.method === 'POST' && c.path === '/say').map(c => c.payload.message);
    assert.ok(says.some(m => /non ho diamanti in inventario/.test(m)), `manca il rifiuto: ${JSON.stringify(says)}`);
    assert.equal(harness.calls.some(c => c.path === '/act'), false, 'nessuna azione: non c\'è nulla da buttare');
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test("un ordine \"cattura i diamanti\" è deterministico: collect_drop cerca solo l'oggetto nominato", async () => {
  const harness = await startInventoryHarness({
    chatMessage: '@bot cattura i diamanti',
    inv: { dirt: 1 },
    drops: ['diamond'],
    token: 'diamond',
  });
  const fake = fakeHermesQueue([]);
  const runId = `test-chat-collect-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController({
      ...baseEnv(runId, harness.port, fake.dir),
      GOAL_CONTRACT: '', TARGETS: '{"dirt":1}', GOAL: 'wait for orders',
    });
    assert.equal(code, 0, `controller exited with ${code}\n${stdout}`);
    assert.match(stdout, /COLLECT ORDER: collect_drop deterministico/, stdout);
    assert.equal(harness.inventory().diamond, 1, 'il diamante è finito in inventario');
    assert.equal(harness.ground().length, 0, 'non c\'è più niente a terra');

    const events = readEvents(runId);
    const plan = events.find(e => e.type === 'plan' && e.deterministic === 'collect');
    assert.equal(plan?.plan?.collect?.token, 'diamond');
    assert.deepEqual(plan?.plan?.collect?.items, ['diamond']);
    assert.equal(events.some(e => e.type === 'plan_fallback'), false, 'Hermes non è mai interrogato');
    assert.deepEqual(harness.calls.filter(c => c.path === '/act').map(c => c.payload.key), ['collect_drop']);
    assert.equal(events.find(e => e.type === 'goal_end')?.status, 'completed');
    const says = harness.calls.filter(c => c.method === 'POST' && c.path === '/say').map(c => c.payload.message);
    assert.match(says[0], /^@Ale ok: /);
    assert.match(says[1], /^@Ale fatto: /);
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

test("un ordine di catturare senza l'oggetto a terra lo dice all'umano e non agisce", async () => {
  const harness = await startInventoryHarness({
    chatMessage: '@bot cattura i diamanti',
    inv: { dirt: 1 },
    drops: [],
    token: 'diamond',
  });
  const fake = fakeHermesQueue([]);
  const runId = `test-chat-collect-none-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController({
      ...baseEnv(runId, harness.port, fake.dir),
      GOAL_CONTRACT: '', TARGETS: '{"dirt":1}', GOAL: 'wait for orders',
    });
    assert.equal(code, 0, `controller exited with ${code}\n${stdout}`);
    assert.match(stdout, /COLLECT ORDER: nessun oggetto a terra/, stdout);

    const events = readEvents(runId);
    const order = events.find(e => e.type === 'collect_order');
    assert.equal(order?.error, 'no_matching_drop', `${stdout}\n${JSON.stringify(events)}`);
    assert.equal(events.find(e => e.type === 'goal_end' && e.status === 'failed')?.reason, 'no_matching_drop');
    const says = harness.calls.filter(c => c.method === 'POST' && c.path === '/say').map(c => c.payload.message);
    assert.ok(says.some(m => /non vedo diamanti a terra/.test(m)), `manca il rifiuto: ${JSON.stringify(says)}`);
    assert.equal(harness.calls.some(c => c.path === '/act'), false, 'nessuna azione: non c\'è nulla da raccogliere');
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

// "che fai?" è la domanda sull'attività corrente: il fast path regex la
// riconosce (`q_activity`), la risposta cita quello che il bot sta facendo
// davvero (`observe().plan`) e non nasce alcun goal. Vale anche senza `?`
// grazie al pattern, e in tutte e cinque le lingue.
test('"@bot che fai?" is answered with the current activity and creates no goal', async () => {
  const harness = await startChatHarness({
    chatFrom: 'Ale',
    chatMessage: '@bot che fai?',
    // Il piano attivo è la fonte della frase: la risposta non inventa nulla.
    extra: () => ({ plan: { objective: 'mine 4 dirt' } }),
  });
  const fake = fakeHermesQueue([HUMAN_PLAN]);
  const runId = `test-chat-activity-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController(baseEnv(runId, harness.port, fake.dir));
    assert.equal(code, 0, `controller exited with ${code}\n${stdout}`);
    assert.equal(stdout.includes('from Ale'), false, 'una domanda non diventa un goal');

    const says = harness.calls.filter(c => c.method === 'POST' && c.path === '/say').map(c => c.payload.message);
    assert.equal(says.length, 1, `una sola risposta (got ${JSON.stringify(says)})`);
    assert.match(says[0], /^@Ale /, 'la risposta è indirizzata a chi ha chiesto');
    assert.match(says[0], /mine 4 dirt/, `la risposta cita l'attività corrente (got ${says[0]})`);

    const events = readEvents(runId);
    const question = events.find(e => e.type === 'chat_question');
    assert.equal(question?.intent, 'q_activity', JSON.stringify(events));
    assert.equal(question?.via, 'regex', 'il fast path risponde senza chiave');
    assert.equal(events.some(e => e.type === 'chat_command'), false, 'non è un ordine');
    assert.equal(events.filter(e => e.type === 'chat_reply').length, 1, 'si risponde una volta sola');
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});

// Il caso senza piano attivo: nessun obiettivo inventato, solo lo stato vero.
test('"che fai?" with no active goal answers the idle state, never a made-up objective', async () => {
  const harness = await startChatHarness({ chatFrom: 'Ale', chatMessage: '@bot che fai' });
  const fake = fakeHermesQueue([HUMAN_PLAN]);
  const runId = `test-chat-activity-idle-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController(baseEnv(runId, harness.port, fake.dir));
    assert.equal(code, 0, `controller exited with ${code}\n${stdout}`);
    const says = harness.calls.filter(c => c.method === 'POST' && c.path === '/say').map(c => c.payload.message);
    assert.equal(says.length, 1, `una sola risposta (got ${JSON.stringify(says)})`);
    assert.match(says[0], /in attesa di ordini/, `nessun obiettivo inventato (got ${says[0]})`);
    const events = readEvents(runId);
    assert.equal(events.find(e => e.type === 'chat_question')?.intent, 'q_activity');
    assert.equal(events.some(e => e.type === 'chat_command'), false);
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});
