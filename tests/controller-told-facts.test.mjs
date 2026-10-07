// Told facts on the chat channel (wiki/human-command.md, wiki/memory.md):
// «Ricorda che questo è il campo di patate», «Dov'è il campo di patate?»,
// «Vai al campo di patate». The path is deterministic — no model is involved —
// so this test drives the real controller against a scripted harness and looks
// at what actually crossed the wire: the position attributed to the sender, the
// memory write, and the reply in chat.
//
// The two properties worth a controller-level test (the memory layer has its own
// file) are:
//   * «questo» means *where the sender is* — and if the sender cannot be seen,
//     nothing is written and the bot asks;
//   * a memory order does not interrupt the running goal, while «vai a <luogo>»
//     is a normal movement order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Fake `hermes` CLI (same trick as controller-chat-ack.test.mjs): prints the next
// scripted line, so the test never needs a model.
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

const SENDER_AT = { x: 120, y: 64, z: -230 };

// Scripted harness: the chat order appears from the second observation on (so the
// seeded contract goal closes first) and the memory routes answer with what the
// test declares. Every request is recorded.
function startToldHarness ({
  chatMessage,
  chatFrom = 'Ale',
  senderVisible = true,
  places = [],
  placesError = null,
  tellPlaceAction = 'created',
  tellPlacePrevious = null,
  chatFromObserve = 2,
  ores = [],
} = {}) {
  return new Promise(resolve => {
    const calls = [];
    let observes = 0;
    const chatAt = Date.now();
    const observation = () => ({
      position: { x: 0, y: 64, z: 0 },
      dimension: 'overworld',
      inventory: { dirt: 1 },
      health: 20, food: 20, dead: false, spawned: true,
      self: { username: 'hermes-bot', name: null },
      time: { ticks: 1000, night: false, phase: 'day' },
      entities: senderVisible ? [{ kind: 'player', username: chatFrom, name: chatFrom, position: SENDER_AT }] : [],
      humans: senderVisible ? [{ username: chatFrom, name: chatFrom, position: SENDER_AT }] : [],
      dropped: [], containers: [],
      ores,
      chat: observes >= chatFromObserve && chatFrom
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
        calls.push({ method: req.method, path, query: req.url.split('?')[1] ?? '', payload });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.method === 'GET' && path === '/observe') { observes += 1; res.end(JSON.stringify(observation())); }
        else if (path === '/say') res.end(JSON.stringify({ ok: true, sent: payload.message }));
        else if (path === '/options') res.end(JSON.stringify({ options: [{ key: 'wait', description: 'Wait' }] }));
        else if (path === '/act') res.end(JSON.stringify({ ok: true, ms: 5 }));
        else if (path === '/plan') res.end(JSON.stringify({ ok: true }));
        else if (req.method === 'GET' && path === '/memory/places') {
          if (placesError) res.end(JSON.stringify({ error: placesError }));
          else res.end(JSON.stringify({ places, count: places.length }));
        } else if (path === '/memory/where') res.end(JSON.stringify({ item: payload.item, hits: [], count: 0 }));
        else if (path === '/memory/tell/place') {
          res.end(JSON.stringify({
            ok: true,
            action: tellPlaceAction,
            place: { id: 'landmark_campo_di_patate', label: payload.label ?? payload.name, position: payload.position, dimension: payload.dimension, source: 'told' },
            previous: tellPlacePrevious,
          }));
        } else if (path === '/memory/tell/container' || path === '/memory/tell/contents') {
          res.end(JSON.stringify({ ok: true, container: { id: 'container_1_2_3', label: payload.label ?? 'baule', position: payload.position ?? SENDER_AT, dimension: payload.dimension ?? 'overworld' }, claim: { verdict: 'unverified' } }));
        } else if (path === '/memory/tell/forget') res.end(JSON.stringify({ ok: true, place: { id: payload.id } }));
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
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

const baseEnv = (runId, port, hermesPath) => ({
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

const says = (harness) => harness.calls.filter(c => c.method === 'POST' && c.path === '/say').map(c => c.payload.message);
const writes = (harness) => harness.calls.filter(c => c.method === 'POST' && c.path.startsWith('/memory/tell/'));

// A run id unique per test, and the temp run dir cleaned afterwards.
async function withRun (fn) {
  const runId = `test-told-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  try { return await fn(runId); } finally { rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true }); }
}

test('«questo è il campo di patate» is written where the sender stands, and answered from the catalogue', async () => {
  const harness = await startToldHarness({ chatMessage: '@bot Ricorda che questo è il campo di patate' });
  const fake = fakeHermesQueue(['wait']);
  try {
    await withRun(async (runId) => {
      const { code } = await runController(baseEnv(runId, harness.port, fake.dir));
      assert.equal(code, 0, 'the controller exits cleanly');

      // 1. the position attributed to the place is the *sender's* live position —
      //    no coordinate was in the message.
      const tell = writes(harness).find(c => c.path === '/memory/tell/place');
      assert.ok(tell, `a place was written (calls: ${JSON.stringify(harness.calls.map(c => c.path))})`);
      assert.deepEqual(tell.payload.position, SENDER_AT);
      assert.equal(tell.payload.dimension, 'overworld');
      assert.equal(tell.payload.name, 'campo di patate');
      assert.equal(tell.payload.toldBy, 'Ale', 'the fact remembers who said it');

      // 2. the confirmation in chat is the concrete one — label, position,
      //    dimension — and it is addressed to the sender.
      const replies = says(harness);
      assert.equal(replies.length, 1, `exactly one reply (got ${JSON.stringify(replies)})`);
      assert.match(replies[0], /^@Ale/);
      assert.match(replies[0], /Registrato: campo di patate a 120, 64, -230, Overworld/);

      // 3. remembering does not interrupt the running goal: no human order was
      //    created, and the autonomous goal is untouched.
      const events = readEvents(runId);
      assert.equal(events.some(e => e.type === 'chat_command'), false, 'a memory order is not a goal');
      assert.equal(events.some(e => e.type === 'plan' && e.source === 'human'), false);
      assert.ok(events.some(e => e.type === 'tell_place'), 'the write is logged');
    });
  } finally { harness.server.close(); rmSync(fake.dir, { recursive: true, force: true }); }
});

test('«questo» without a visible sender writes nothing and asks for the coordinates', async () => {
  const harness = await startToldHarness({
    chatMessage: '@bot Ricorda che questo è il campo di patate',
    senderVisible: false,
  });
  const fake = fakeHermesQueue(['wait']);
  try {
    await withRun(async (runId) => {
      const { code } = await runController(baseEnv(runId, harness.port, fake.dir));
      assert.equal(code, 0);
      assert.equal(writes(harness).length, 0, 'a recognised but incomplete order writes nothing');
      const replies = says(harness);
      assert.equal(replies.length, 1);
      assert.match(replies[0], /@Ale/);
      assert.match(replies[0], /coordinate/i, `the bot asks for the coordinates (got ${replies[0]})`);
      const events = readEvents(runId);
      const clarify = events.find(e => e.type === 'tell_clarify');
      assert.equal(clarify?.reason, 'no_sender_position');
    });
  } finally { harness.server.close(); rmSync(fake.dir, { recursive: true, force: true }); }
});

test('a named place answers «dov\'è?» with its provenance', async () => {
  const place = { id: 'landmark_campo_di_patate', label: 'campo di patate', position: SENDER_AT, dimension: 'overworld', source: 'told' };
  const harness = await startToldHarness({ chatMessage: "@bot Dov'è il campo di patate?", places: [place] });
  const fake = fakeHermesQueue(['wait']);
  try {
    await withRun(async (runId) => {
      const { code } = await runController(baseEnv(runId, harness.port, fake.dir));
      assert.equal(code, 0);
      assert.equal(writes(harness).length, 0);
      const replies = says(harness);
      assert.equal(replies.length, 1);
      assert.match(replies[0], /campo di patate è a 120, 64, -230, Overworld/);
      assert.match(replies[0], /me l'hai detto tu/, 'the answer declares the fact was told, not seen');
      const events = readEvents(runId);
      assert.ok(events.some(e => e.type === 'tell_where_place' && e.source === 'told'));
    });
  } finally { harness.server.close(); rmSync(fake.dir, { recursive: true, force: true }); }
});

test('two places with the same name: the bot asks which one, never the nearest', async () => {
  const harness = await startToldHarness({
    chatMessage: "@bot Dov'è il campo di patate?",
    places: [
      { id: 'field_north', label: 'campo di patate', position: { x: 0, y: 64, z: 0 }, dimension: 'overworld', source: 'told' },
      { id: 'field_south', label: 'campo di patate', position: { x: 0, y: 64, z: 900 }, dimension: 'overworld', source: 'told' },
    ],
  });
  const fake = fakeHermesQueue(['wait']);
  try {
    await withRun(async (runId) => {
      const { code } = await runController(baseEnv(runId, harness.port, fake.dir));
      assert.equal(code, 0);
      const replies = says(harness);
      assert.equal(replies.length, 1);
      assert.match(replies[0], /ho 2 posti chiamati "campo di patate"/);
      assert.match(replies[0], /Quale intendi\?/);
      assert.match(replies[0], /campo di patate a 0, 64, 0/);
      assert.match(replies[0], /campo di patate a 0, 64, 900/);
      const events = readEvents(runId);
      const ambiguous = events.find(e => e.type === 'tell_ambiguous');
      assert.equal(ambiguous?.count, 2);
      assert.equal(events.some(e => e.type === 'plan' && e.source === 'human'), false, 'nothing was planned');
    });
  } finally { harness.server.close(); rmSync(fake.dir, { recursive: true, force: true }); }
});

test('«vai al campo di patate» is a movement order to the remembered position', async () => {
  const place = { id: 'landmark_campo_di_patate', label: 'campo di patate', position: SENDER_AT, dimension: 'overworld', source: 'told' };
  const harness = await startToldHarness({ chatMessage: '@bot Vai al campo di patate', places: [place] });
  const fake = fakeHermesQueue(['wait']);
  try {
    await withRun(async (runId) => {
      const { code } = await runController(baseEnv(runId, harness.port, fake.dir));
      assert.equal(code, 0);
      const events = readEvents(runId);
      const plan = events.find(e => e.type === 'plan' && e.deterministic === 'told_goto');
      assert.ok(plan, `a deterministic movement plan is logged (events: ${events.map(e => e.type).join(',')})`);
      assert.deepEqual(plan.plan.waypoint, { x: 120, z: -230 }, 'the destination comes from the name, not from a coordinate in the order');
      assert.equal(plan.plan.follow, null);
      assert.match(plan.plan.objective, /campo di patate/);
      assert.equal(writes(harness).length, 0, 'walking to a place writes nothing');
    });
  } finally { harness.server.close(); rmSync(fake.dir, { recursive: true, force: true }); }
});

test('a correction that says where the place already is does not become «I do not know it»', async () => {
  // Ridire la posizione già registrata non è una correzione: il livello memoria
  // risponde `unchanged` (nessuna riga di storia) e la chat deve confermare, non
  // dire «non conosco il posto».
  const place = { id: 'landmark_ingresso', label: 'ingresso principale', type: 'ingresso_principale', kind: 'landmark', position: { x: 130, y: 62, z: -240 }, dimension: 'overworld', source: 'told', status: 'known' };
  const harness = await startToldHarness({
    chatMessage: "@bot L'ingresso principale ora è a 130, 62, -240",
    places: [place],
    tellPlaceAction: 'unchanged',
  });
  const fake = fakeHermesQueue(['wait']);
  try {
    await withRun(async (runId) => {
      const { code } = await runController(baseEnv(runId, harness.port, fake.dir));
      assert.equal(code, 0);
      const tell = writes(harness).find(c => c.path === '/memory/tell/place');
      assert.ok(tell, 'the correction reaches the memory');
      assert.equal(tell.payload.requireExisting, true, 'a correction never invents a place');
      assert.equal(tell.payload.id, 'landmark_ingresso', 'the identity travels by name, then by id');
      const replies = says(harness);
      assert.equal(replies.length, 1);
      assert.match(replies[0], /Registrato: ingresso principale a 130, 62, -240, Overworld/);
      assert.equal(/non conosco/.test(replies[0]), false, 'unchanged is not unknown');
      const events = readEvents(runId);
      assert.ok(events.some(e => e.type === 'tell_correct' && e.previous === null), 'the correction is logged');
      assert.equal(events.some(e => e.type === 'tell_unknown_place'), false);
    });
  } finally { harness.server.close(); rmSync(fake.dir, { recursive: true, force: true }); }
});

test('a memory route that is down says so instead of inventing an answer', async () => {
  const harness = await startToldHarness({ chatMessage: "@bot Dov'è il campo di patate?", placesError: 'told_facts_disabled' });
  const fake = fakeHermesQueue(['wait']);
  try {
    await withRun(async (runId) => {
      const { code } = await runController(baseEnv(runId, harness.port, fake.dir));
      assert.equal(code, 0);
      const replies = says(harness);
      assert.equal(replies.length, 1);
      assert.match(replies[0], /non riesco a leggere la memoria/);
      const events = readEvents(runId);
      assert.ok(events.some(e => e.type === 'tell_memory_unavailable' && e.reason === 'told_facts_disabled'));
    });
  } finally { harness.server.close(); rmSync(fake.dir, { recursive: true, force: true }); }
});

test('«dimmi le coordinate dei diamanti» answers with the vein the bot sees now, not with a chest', async () => {
  const harness = await startToldHarness({
    chatMessage: '@bot dimmi le coordinate dei diamanti',
    ores: [
      { name: 'deepslate_diamond_ore', position: { x: 61, y: -6, z: 199 }, distance: 7.6, value: 100, harvestable: false },
      { name: 'diamond_ore', position: { x: 52, y: 1, z: 193 }, distance: 12.4, value: 100, harvestable: false },
    ],
  });
  const fake = fakeHermesQueue(['wait']);
  try {
    await withRun(async (runId) => {
      const { code } = await runController(baseEnv(runId, harness.port, fake.dir));
      assert.equal(code, 0, 'the controller exits cleanly');

      // The nearest vein wins, and the answer is a position to dig toward —
      // not the bot's own coordinates and not a chest in the old base.
      const replies = says(harness);
      assert.equal(replies.length, 1, `exactly one reply (got ${JSON.stringify(replies)})`);
      assert.match(replies[0], /^@Ale deepslate_diamond_ore a 61, -6, 199, Overworld — 8 blocchi da me \(visto da me\)/);

      // Nothing was written and the memory catalogue was not consulted for a
      // resource the bot can see right now.
      assert.equal(writes(harness).length, 0);
      assert.equal(harness.calls.some(c => c.path === '/memory/where'), false, 'a live sighting does not need the memory');

      const events = readEvents(runId);
      const ore = events.find(e => e.type === 'tell_where_ore');
      assert.ok(ore, 'the sighting reply is logged');
      assert.equal(ore.item, 'diamond');
      assert.equal(ore.ore, 'deepslate_diamond_ore');
      assert.deepEqual(ore.position, { x: 61, y: -6, z: 199 });
      assert.equal(events.some(e => e.type === 'chat_command'), false, 'a question is not an order');
    });
  } finally { harness.server.close(); rmSync(fake.dir, { recursive: true, force: true }); }
});
