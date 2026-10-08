// «vai a dormire!» (08/10/2026, live): l'ordine umano più semplice del mondo —
// dormire — non aveva un traduttore deterministico. Il planner Hermes inventava
// un letto (`waypoint {x:129,z:180}`, che nel mondo non esiste: l'unico letto
// libero era a (116,73,195)) e il bot rispondeva «sto andando verso il letto a
// 129,180», cioè una bugia con le coordinate. Il sonno è un *bisogno*, non un
// movimento: il piano dice solo `need: 'sleep'` e chi cammina e quale letto lo
// sa già l'harness (che ha l'opzione `sleep` e il censimento vero).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isSleepOrder } from '../controller-decisions.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('isSleepOrder riconosce il verbo in tutte le lingue del catalogo', () => {
  for (const text of [
    '@bot dormi', '@TrustedPlayer vai a dormire!', '@bot dormiamo', '@TrustedPlayer vado a dormire',
    '@bot nanna', '@bot sleep', '@bot go to bed', '@bot go to sleep', '@bot bedtime',
    '@bot schlafen', '@bot dormir', '@bot duerme', '@bot dormite',
  ]) {
    assert.equal(isSleepOrder(text), true, `"${text}" è un ordine di sonno`);
  }
  for (const text of ['@bot seguimi', '@bot raccogli 4 terra', '@bot fermati', '@bot quanta fame hai', '']) {
    assert.equal(isSleepOrder(text), false, `"${text}" non è un ordine di sonno`);
  }
});

// Fake `hermes` CLI: risponde dalla coda e registra le chiamate (contratto uguale
// agli altri test del controller). Il piano iniziale è il primo della coda.
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

function startSleepHarness ({ order = '@bot vai a dormire', from = 'Ale', orderAfterObservations = 2 } = {}) {
  return new Promise(resolve => {
    const calls = [];
    let night = true;
    let observes = 0;
    let acts = 0;
    const orderAt = Date.now();
    const observation = () => ({
      position: { x: 0, y: 64, z: 0 },
      inventory: { dirt: 2 },
      health: 20, food: 20, dead: false, spawned: true,
      time: { ticks: night ? 13000 : 0, night, phase: night ? 'night' : 'day' },
      bed: { position: { x: 3, y: 64, z: 0 }, distance: 3 },
      entities: [], dropped: [], containers: [], humans: [],
      chat: observes >= orderAfterObservations
        ? [{ from, message: order, type: 'chat', xuid: '1234567890', at: orderAt }]
        : [],
    });
    const options = () => [
      ...(night ? [{ key: 'sleep', description: 'Sleep in the bed at {"x":3,"y":64,"z":0} (3.0 blocks away) before the night is dangerous' }] : []),
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
          if (payload.key === 'sleep') night = false;
          res.end(JSON.stringify(payload.key === 'sleep' ? { ok: true, ms: 5, slept: 'night_skipped' } : { ok: true, ms: 5 }));
        } else if (path === '/say') res.end(JSON.stringify({ ok: true, sent: payload.message }));
        else if (path === '/plan') res.end(JSON.stringify({ ok: true }));
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

function readEvents (runId) {
  const file = join(ROOT, 'runs', runId, 'controller.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return { type: 'unparsable', line }; }
  });
}

// Il seme è insoddisfacibile di proposito: l'ordine di sonno deve arrivare
// mentre un goal è aperto, cioè nel caso vero (il bot stava inseguendo o
// aspettando, non era in IDLE).
const SEED_PLAN = JSON.stringify({ objective: 'Raccogli 99 terra', targets: { dirt: 99 }, waypoint: null, follow: null, notes: 'test' });

const baseEnv = (runId, port, hermesPath) => ({
  HARNESS: `http://127.0.0.1:${port}`,
  RUN_ID: runId,
  PATH: `${hermesPath}:${process.env.PATH}`,
  CONTROLLER: 'hermes',
  SESSION: '1',
  IDLE_POLL_MS: '50',
  IDLE_TIMEOUT_MS: '1500',
  AUTONOMY: '',
  MAX_STEPS: '6',
  REPLAN_EVERY: '8',
  ANTI_LOOP_THRESHOLD: '3',
  ANTI_LOOP_COOLDOWN: '3',
  GOAL: 'Raccogli 99 terra',
  TARGETS: '{"dirt":99}',
  CHAT_ALLOWLIST: 'Ale',
  CHAT_CONTROL: 'on',
  CHAT_GREET: 'off',
  CHAT_REPLY: 'off',
  CHAT_LANG: 'it',
  OPENROUTER_API_KEY: '',
  TYPESAFE_API_KEY: '',
});

test('un ordine di sonno diventa il bisogno `sleep`, senza letti inventati dal planner', async () => {
  const harness = await startSleepHarness({});
  const fake = fakeHermesQueue([SEED_PLAN]);
  const runId = `test-sleep-order-${process.pid}-${Date.now()}`;
  try {
    const { code, stdout } = await runController(baseEnv(runId, harness.port, fake.dir));
    assert.equal(code, 0, `the controller exits cleanly (stdout: ${stdout.slice(-500)})`);

    const events = readEvents(runId);
    const plan = events.find(e => e.type === 'plan' && e.deterministic === 'sleep');
    assert.ok(plan, `l'ordine di sonno ha un piano deterministico (events: ${JSON.stringify(events.filter(e => e.type === 'plan').map(e => e.deterministic ?? e.source))})`);
    assert.equal(plan.source, 'human');
    assert.equal(plan.ms, 0, 'nessuna chiamata al modello: il piano nasce a costo zero');
    assert.equal(plan.plan.need, 'sleep');
    assert.equal(plan.plan.waypoint, null, 'nessuna coordinata inventata: il letto non lo scegliamo noi');
    assert.equal(plan.plan.follow, null, 'un ordine di sonno non è un inseguimento');
    assert.equal(plan.plan.objective, 'vado a letto e dormo fino a mattina', 'la frase è quella del catalogo, non una promessa del modello');

    const acts = harness.calls.filter(c => c.path === '/act').map(c => c.payload.key);
    assert.equal(acts.includes('sleep'), true, `il sonno viene eseguito davvero (acts: ${JSON.stringify(acts)})`);
    assert.equal(harness.calls.some(c => c.path === '/say' && /129|180/.test(c.payload.message ?? '')), false, 'nessun letto inventato viene annunciato in chat');
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(fake.dir, { recursive: true, force: true });
  }
});
