// R2 — la chiarificazione vista dal controller, sul filo.
//
// Questo test guida il **controller vero** contro un harness scriptato e guarda
// cosa attraversa la rete: la domanda scritta in chat, il `POST /chat/ask` che la
// registra, e — nella seconda metà — la risposta che l'inbox decora con
// `clarifies`. La proprietà centrale è che un ordine ambiguo **non diventa un
// goal**: la porta chiede una volta sola, e il goal nasce solo quando l'ordine è
// eseguibile (cioè quando l'umano ha risposto).
//
// Il finto `hermes` scrive in un file gli argomenti che riceve: è così che si
// prova, senza indovinare, che il planner ha visto l'ordine **originale con la
// risposta attaccata** — non la risposta da sola.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readPlanTrace, PLAN_SOURCES } from '../plan-trace.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SENDER_AT = { x: 120, y: 64, z: -230 };

// Finto `hermes` CLI: registra ogni chiamata (prompt compreso) e risponde sempre
// con lo stesso piano. Il piano **non ha waypoint** — è il caso interessante:
// il planner non ha risolto la meta, e nemmeno il fallback interno.
function fakeHermes (plan) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-hermes-'));
  const logPath = join(dir, 'calls.log');
  const bin = join(dir, 'hermes');
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(logPath)}\nprintf '%s\\n' ${JSON.stringify(JSON.stringify(plan))}\n`);
  chmodSync(bin, 0o755);
  return {
    dir,
    logPath,
    read: () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''),
  };
}

// Harness scriptato. Il messaggio dell'ordine compare dalla seconda osservazione;
// la risposta compare due osservazioni dopo il `POST /chat/ask`, decorata con
// `clarifies` come farebbe l'adapter vero.
function startClarifyHarness ({ orderMessage = '@bot vai', answer = null, places = [] } = {}) {
  return new Promise(resolve => {
    const calls = [];
    let observes = 0;
    let answerFrom = Infinity;
    const chatAt = Date.now();
    const asks = [];
    const observation = () => {
      const chat = [];
      if (observes >= 1) chat.push({ from: 'Ale', message: orderMessage, type: 'chat', xuid: '1234567890', at: chatAt });
      if (answer && observes >= answerFrom) {
        const ask = asks[0];
        chat.push({
          from: 'Ale', message: answer, type: 'chat', xuid: '1234567890', at: chatAt + 1000,
          clarifies: { orderId: ask.payload.orderId, originalText: ask.payload.originalText, question: ask.payload.question },
        });
      }
      return {
        position: { x: 0, y: 64, z: 0 },
        dimension: 'overworld',
        inventory: { dirt: 1 },
        health: 20, food: 20, dead: false, spawned: true,
        self: { username: 'hermes-bot', name: null },
        time: { ticks: 1000, night: false, phase: 'day' },
        entities: [{ kind: 'player', username: 'Ale', name: 'Ale', position: SENDER_AT }],
        humans: [{ username: 'Ale', name: 'Ale', position: SENDER_AT }],
        dropped: [], containers: [], ores: [],
        chat,
      };
    };
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const path = req.url.split('?')[0];
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch { /* ignore */ }
        calls.push({ method: req.method, path, query: req.url.split('?')[1] ?? '', payload });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.method === 'GET' && path === '/observe') { observes += 1; res.end(JSON.stringify(observation())); }
        else if (path === '/say') res.end(JSON.stringify({ ok: true, sent: payload.message }));
        else if (path === '/options') res.end(JSON.stringify({ options: [{ key: 'wait', description: 'Wait' }] }));
        else if (path === '/act') res.end(JSON.stringify({ ok: true, ms: 5 }));
        else if (path === '/plan') res.end(JSON.stringify({ ok: true }));
        else if (path === '/chat/ask') {
          asks.push({ payload });
          // La risposta arriva alla prima osservazione successiva: è il caso più
          // stretto possibile (l'umano ha risposto subito).
          answerFrom = observes + 1;
          res.end(JSON.stringify({ ok: true, pending: [{ ...payload, askedAt: Date.now() }] }));
        } else if (path === '/chat/pending') res.end(JSON.stringify({ pending: [] }));
        else if (req.method === 'GET' && path === '/memory/places') res.end(JSON.stringify({ places, count: places.length }));
        else if (path.startsWith('/memory/')) res.end(JSON.stringify({ ok: true, hits: [], count: 0 }));
        else if (path === '/mission') res.end(JSON.stringify({ ok: true, mission: { id: 'mission_test', type: payload.type, intent: payload.intent } }));
        else if (path === '/mission/finish') res.end(JSON.stringify({ ok: true, mission: { id: payload.missionId, ...payload } }));
        else if (path === '/mission/action' || path === '/mission/link') res.end(JSON.stringify({ ok: true, id: 'x1' }));
        else res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, calls, asks, get observes () { return observes; } }));
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
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

const baseEnv = (runId, port, hermesPath, extra = {}) => ({
  HARNESS: `http://127.0.0.1:${port}`,
  RUN_ID: runId,
  PATH: `${hermesPath}:${process.env.PATH}`,
  CONTROLLER: 'hermes',
  SESSION: '1',
  IDLE_POLL_MS: '100',
  IDLE_TIMEOUT_MS: '3000',
  AUTONOMY: '',
  MAX_STEPS: '3',
  CHAT_LANG: 'it',
  CHAT_ALLOWLIST: 'Ale',
  CHAT_CONTROL: 'on',
  CHAT_GREET: 'off',
  CHAT_LLM: 'off',
  CHAT_CLARIFY: 'on',
  GOAL_CONTRACT: JSON.stringify({ goal: 'keep dirt', success: { inventoryGte: { dirt: 1 } } }),
  OPENROUTER_API_KEY: '',
  TYPESAFE_API_KEY: '',
  ...extra,
});

function readEvents (runId) {
  const file = join(ROOT, 'runs', runId, 'controller.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return { type: 'unparsable', line }; }
  });
}

const says = (harness) => harness.calls.filter(c => c.method === 'POST' && c.path === '/say').map(c => c.payload.message);

async function withRun (fn) {
  const runId = `test-clarify-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  try { return await fn(runId); } finally { rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true }); }
}

const NO_DESTINATION_PLAN = { objective: 'sto andando', subgoal: null, targets: {}, waypoint: null, follow: null, notes: 'test' };

test('un ordine di movimento senza meta diventa una domanda registrata nell inbox, non un goal', async () => {
  const harness = await startClarifyHarness({});
  const fake = fakeHermes(NO_DESTINATION_PLAN);
  try {
    await withRun(async (runId) => {
      const { code } = await runController(baseEnv(runId, harness.port, fake.dir));
      assert.equal(code, 0, 'il controller esce pulito');

      // 1. la domanda è registrata nell'inbox **prima** di essere detta: è il
      //    legame «a chi ho chiesto che cosa», e senza di esso la risposta
      //    dell'umano non sarebbe riconoscibile.
      assert.equal(harness.asks.length, 1, 'una domanda sola');
      const ask = harness.asks[0].payload;
      assert.equal(ask.from, 'Ale');
      assert.equal(ask.orderId, harness.asks[0].payload.orderId);
      assert.ok(ask.orderId, 'la domanda ha un id');
      assert.equal(ask.originalText, 'vai', 'l ordine originale viaggia con la domanda');
      assert.equal(ask.field, 'destination');
      assert.equal(ask.reason, 'no_destination');
      assert.ok(ask.question && ask.question.trim(), 'la domanda ha un testo');

      // 2. in chat c'è una sola riga: la domanda, indirizzata al mittente.
      const replies = says(harness);
      assert.equal(replies.length, 1, `una sola riga in chat (got ${JSON.stringify(replies)})`);
      assert.match(replies[0], /^@Ale /);
      assert.equal(replies[0], `@Ale ${ask.question}`, 'la riga in chat è la domanda stessa, non un ack');

      // 3. nessun goal: l'ordine non è eseguibile, quindi non nasce.
      const events = readEvents(runId);
      assert.equal(events.some(e => e.type === 'human_order'), false, 'nessun ordine umano eseguito');
      assert.equal(harness.calls.some(c => c.path === '/plan'), false, 'nessun piano pubblicato');
      const clarify = events.find(e => e.type === 'chat_clarify');
      assert.equal(clarify?.orderId, ask.orderId);
      assert.equal(clarify?.field, 'destination');
      assert.equal(clarify?.stored, true, 'la domanda è stata registrata');
      assert.ok(events.some(e => e.type === 'chat_command'), 'il messaggio resta tracciato come comando');
    });
  } finally { harness.server.close(); rmSync(fake.dir, { recursive: true, force: true }); }
});

test('un posto che la memoria conosce non fa chiedere niente: la porta è trasparente', async () => {
  const place = { id: 'landmark_rifugio', label: 'rifugio', position: SENDER_AT, dimension: 'overworld', source: 'told' };
  const harness = await startClarifyHarness({ orderMessage: '@bot vai al rifugio', places: [place] });
  const fake = fakeHermes(NO_DESTINATION_PLAN);
  try {
    await withRun(async (runId) => {
      const { code } = await runController(baseEnv(runId, harness.port, fake.dir));
      assert.equal(code, 0);
      assert.equal(harness.asks.length, 0, 'niente domande');
      const replies = says(harness);
      assert.ok(replies.length >= 1, `l ordine riceve un ack (got ${JSON.stringify(replies)})`);
      assert.match(replies[0], /^@Ale /);
      assert.equal(replies.some(r => r.includes('?')), false, `nessuna domanda in chat (got ${JSON.stringify(replies)})`);
      assert.ok(readEvents(runId).some(e => e.type === 'human_order'), 'l ordine è diventato un goal');
      // R3: quel goal si chiude **prima** di adottare un piano (il contratto
      // e' gia' soddisfatto all'osservazione 0), quindi non lascia traccia di
      // piano: nessun passo eseguito, nessuna riga. La traccia con dei passi
      // dentro e' il caso dell'ultimo test del file.
      assert.equal(readPlanTrace(join(ROOT, 'runs', runId)), null, 'nessun piano adottato, nessuna traccia');
    });
  } finally { harness.server.close(); rmSync(fake.dir, { recursive: true, force: true }); }
});

test('CHAT_CLARIFY=off spegne la porta: l ordine torna al planner di prima', async () => {
  const harness = await startClarifyHarness({});
  const fake = fakeHermes(NO_DESTINATION_PLAN);
  try {
    await withRun(async (runId) => {
      const { code } = await runController(baseEnv(runId, harness.port, fake.dir, { CHAT_CLARIFY: 'off' }));
      assert.equal(code, 0);
      assert.equal(harness.asks.length, 0, 'nessuna domanda');
      assert.ok(readEvents(runId).some(e => e.type === 'human_order'), 'nessun goal');
    });
  } finally { harness.server.close(); rmSync(fake.dir, { recursive: true, force: true }); }
});

test('la risposta chiude l ordine: il planner riceve l ordine originale con la risposta attaccata', async () => {
  const harness = await startClarifyHarness({ answer: '@bot coordinate 120 64 -230' });
  const fake = fakeHermes(NO_DESTINATION_PLAN);
  try {
    await withRun(async (runId) => {
      const { code } = await runController(baseEnv(runId, harness.port, fake.dir));
      assert.equal(code, 0);

      // Una domanda sola: la risposta non apre un secondo giro.
      assert.equal(harness.asks.length, 1, `una domanda sola (got ${harness.asks.length})`);
      assert.equal(readEvents(runId).filter(e => e.type === 'chat_clarify').length, 1);

      // Il planner ha visto **una** frase: l'ordine trattenuto più la risposta.
      const prompt = fake.read();
      const seen = readEvents(runId).map(e => e.type).join(',');
      assert.match(prompt, /The human \(gamertag "Ale"\) said: "vai coordinate 120 64 -230"\./, `eventi: ${seen}`);
      assert.equal(/The human \(gamertag "Ale"\) said: "coordinate 120 64 -230"\./.test(prompt), false, 'la risposta da sola non è un ordine');

      // E l'ordine è diventato un goal, con l'ack.
      assert.ok(readEvents(runId).some(e => e.type === 'human_order'), 'l ordine è diventato un goal');
      const replies = says(harness);
      assert.match(replies[0], /^@Ale /, `prima la domanda (got ${JSON.stringify(replies)})`);
      assert.ok(replies.length >= 2, `poi l esito dell ordine (got ${JSON.stringify(replies)})`);
    });
  } finally { harness.server.close(); rmSync(fake.dir, { recursive: true, force: true }); }
});

test('una risposta che è già un ordine lo sostituisce: niente fusione', async () => {
  const harness = await startClarifyHarness({ answer: '@bot vai al mulino' });
  const fake = fakeHermes(NO_DESTINATION_PLAN);
  try {
    await withRun(async (runId) => {
      const { code } = await runController(baseEnv(runId, harness.port, fake.dir));
      assert.equal(code, 0);
      const prompt = fake.read();
      assert.match(prompt, /The human \(gamertag "Ale"\) said: "vai al mulino"\./);
      assert.equal(/vai coordinate/.test(prompt), false);
    });
  } finally { harness.server.close(); rmSync(fake.dir, { recursive: true, force: true }); }
});

// R3: un run vero lascia la traccia del piano. Il modulo sa scriverla; questo
// test prova che sia il **controller** a scriverla, e con che cosa dentro —
// provenienza, forma del piano, decisioni prese e motivo di chiusura. Il goal
// qui non e' mai soddisfatto (chiede diamanti che non arrivano), quindi il
// ciclo esegue davvero dei passi.
test('il run lascia la traccia del piano: provenienza, decisioni e chiusura', async () => {
  const harness = await startClarifyHarness({});
  const fake = fakeHermes({ objective: 'mine 4 diamond ore', subgoal: null, targets: { diamond: 4 }, waypoint: null, follow: null, notes: 'test' });
  try {
    await withRun(async (runId) => {
      const { code } = await runController(baseEnv(runId, harness.port, fake.dir, { GOAL_CONTRACT: '', SESSION: '' }));
      const trace = readPlanTrace(join(ROOT, 'runs', runId));
      assert.ok(Array.isArray(trace) && trace.length >= 1, `la traccia del piano esiste (code ${code}, got ${JSON.stringify(trace)})`);
      assert.ok(trace.every(r => r.v === 1 && PLAN_SOURCES.includes(r.source)), `ogni segmento dichiara una provenienza ammessa (got ${JSON.stringify(trace.map(r => r.source))})`);
      assert.ok(trace.every(r => typeof r.objective === 'string' && r.objective.length), 'ogni segmento porta l objective del piano che ha adottato');
      // Il piano autonomo e' stato interrotto da un ordine: il segmento si
      // chiude **con il motivo**, non con un troncamento silenzioso.
      assert.equal(trace[0].reason, 'start');
      assert.equal(trace[0].source, 'hermes', 'il piano autonomo viene dal planner');
      assert.ok(trace.some(r => r.endedBy === 'human_order'), `la sostituzione dice perche ha chiuso il segmento (got ${JSON.stringify(trace.map(r => r.endedBy))})`);
      // Il segmento che ha davvero eseguito dei passi porta le decisioni prese.
      const worked = trace.find(r => r.decisions.length >= 2);
      assert.ok(worked, `un segmento porta le decisioni prese (got ${JSON.stringify(trace)}, eventi: ${readEvents(runId).map(e => e.type).join(',')})`);
      assert.equal(worked.objective, 'mine 4 diamond ore', 'la traccia porta l objective del piano');
      assert.equal(worked.stepCount, 1);
      assert.equal(worked.decisions.every(d => d.key === 'wait'), true, `l unica chiave offerta era wait (got ${JSON.stringify(worked.decisions)})`);
      assert.equal(worked.actions, worked.decisions.length, 'ogni decisione e un tentativo contato');
      assert.ok(worked.ok >= 2 && worked.failed === 0, `nessuna azione fallita (got ok=${worked.ok} failed=${worked.failed})`);
      assert.ok(worked.endedBy, 'il segmento dice come si e chiuso');
    });
  } finally { harness.server.close(); rmSync(fake.dir, { recursive: true, force: true }); }
});
