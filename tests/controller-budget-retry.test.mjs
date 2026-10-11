// M25 — il tetto dei token non e' una condizione terminale. L'11/10/2026 il
// tentativo 25 (nessun tetto alle opzioni) e' morto cosi':
//
//   GOAL g1 ERROR: System One HTTP 400: {"detail":{"error_type":"max_tokens_exceeded"}}
//
// La richiesta era troppo grande, non il provider rotto: l'unica cosa che il
// controller puo' togliere e' scelta. Qui si guarda quello che attraversa il
// filo: due richieste al decider, la seconda piu' corta della prima, e una riga
// `decision_budget_retry` nel ledger invece di una run morta.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const PLAN = {
  objective: 'mine copper for the test',
  subgoal: null,
  targets: { copper_ore: 1 },
  waypoint: null,
  skill: null,
  notes: 'test',
};

// Sedici chiavi: con `MAX_OPTIONS` a 12 il primo taglio e' visibile (12 -> 6).
const OPTIONS = Array.from({ length: 16 }, (_, i) => ({
  key: `mine_test_ore_${i}`,
  description: `mine test ore ${i}`,
}));

// Il planner e' Hermes (lo shim risponde sempre col piano); il *decider* e' Jev,
// che parla con l'endpoint scriptato: e' li' che si misura la richiesta.
function fakeHermes () {
  const dir = mkdtempSync(join(tmpdir(), 'fake-hermes-budget-'));
  const bin = join(dir, 'hermes');
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(PLAN)}'\n`);
  chmodSync(bin, 0o755);
  return dir;
}

function startHarness () {
  return new Promise(resolve => {
    const state = { acted: [] };
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.method === 'GET' && req.url === '/observe') {
          res.end(JSON.stringify({
            position: { x: 0, y: 64, z: 0 },
            dimension: 'overworld',
            inventory: {},
            health: 20,
            food: 20,
            dead: false,
            time: { ticks: 2000, night: false, phase: 'day' },
            entities: [], chat: [], drops: [], containers: [],
            // Il modello del mondo: e' il peso vero della richiesta (vivo
            // 11/10/2026: `village` 18.9 KB, `memory` 16.4, `storage` 8.6), ed e'
            // la prima cosa che il taglio toglie.
            village: { checked: true, houses: Array.from({ length: 40 }, (_, i) => ({ x: i, y: 64, z: i, beds: 2 })) },
            memory: { known: Array.from({ length: 40 }, (_, i) => ({ type: 'chest', position: { x: i, y: 64, z: 0 }, contents: { cobblestone: 64 } })) },
            plan: state.plan ?? null,
          }));
        } else if (req.method === 'GET' && req.url === '/options') {
          res.end(JSON.stringify({ options: OPTIONS }));
        } else if (req.method === 'POST' && req.url === '/act') {
          const payload = JSON.parse(body || '{}');
          state.acted.push(payload.key);
          res.end(JSON.stringify({ ok: true, key: payload.key, ms: 1 }));
        } else if (req.method === 'POST' && req.url === '/plan') {
          state.plan = JSON.parse(body || '{}');
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.end('{}');
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state }));
  });
}

// L'endpoint decisionale scriptato: `overflows` risposte 400 `max_tokens_exceeded`
// e poi le decisioni vere (sempre `a0`: la prima opzione passata dai filtri).
function startDecisions ({ overflows = 1 } = {}) {
  return new Promise(resolve => {
    const calls = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const payload = JSON.parse(body || '{}');
        calls.push(payload);
        res.writeHead(calls.length <= overflows ? 400 : 200, { 'Content-Type': 'application/json' });
        if (calls.length <= overflows) {
          res.end(JSON.stringify({ detail: { error_type: 'max_tokens_exceeded' } }));
        } else {
          res.end(JSON.stringify({ model: 'jev-test', answers: { action: { choice: 'a0', probabilities: { a0: 0.9 } } } }));
        }
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
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 30000);
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

const ledger = (runId) => {
  const file = join(ROOT, 'runs', runId, 'controller.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
};

test('a decision the provider refuses for its size is retried smaller, not fatal', async () => {
  const { server, port } = await startHarness();
  // Due rifiuti: il primo taglia la scelta, il secondo anche lo stato.
  const decisions = await startDecisions({ overflows: 2 });
  const runId = `test-budget-retry-${process.pid}-${Date.now()}`;
  const hermes = fakeHermes();
  try {
    const { code, stdout, stderr } = await runController({
      HARNESS: `http://127.0.0.1:${port}`,
      RUN_ID: runId,
      CONTROLLER: 'jev',
      MAX_STEPS: '2',
      REPLAN_EVERY: '0',
      MAX_OPTIONS: '12',
      TARGETS: '{"copper_ore":1}',
      CURRICULUM: '',
      WAYPOINT: '',
      CHAT_ALLOWLIST: '',
      CHAT_CONTROL: 'off',
      OPENROUTER_API_KEY: '',
      TYPESAFE_API_KEY: 'test-key',
      JEV_MODEL: 'jev-test',
      SYSTEM_ONE_URL: `http://127.0.0.1:${decisions.port}/v1/systemone`,
      HERMES_TIMEOUT_MS: '20000',
      PATH: `${hermes}:${process.env.PATH}`,
    });
    assert.equal(code, 0, `la run non deve morire per il tetto dei token; stdout:\n${stdout}\nstderr:\n${stderr}`);

    // Un passo, due rifiuti, tre richieste: ognuna piu' piccola della precedente,
    // e il passo dopo riparte dal tetto pieno (il taglio non e' permanente).
    assert.equal(decisions.calls.length, 4, 'due rifiuti, due tagli, piu\' il passo successivo');
    const counts = decisions.calls.map(call => Object.keys(call.questions?.action?.criteria ?? {}).length);
    assert.deepEqual(counts.slice(0, 3), [12, 6, 4], 'prima la scelta, poi ancora meno scelta');
    assert.equal(counts[3], 12, 'il taglio non e\' permanente: il passo dopo riprova pieno');

    // Seconda leva, la piu' pesante: lo stato. Il primo tentativo porta il modello
    // del mondo, il terzo no.
    const sizes = decisions.calls.map(call => JSON.stringify(call.state ?? '').length);
    assert.ok(sizes[0] > 1000, 'il primo tentativo porta davvero il mondo addosso');
    assert.ok(sizes[2] < sizes[0] / 2, `lo stato deve dimagrire (${sizes.slice(0, 3).join(' -> ')})`);
    assert.ok(JSON.stringify(decisions.calls[0].state).includes('village'), 'prima c\'e\' il villaggio');
    assert.ok(!JSON.stringify(decisions.calls[2].state).includes('village'), 'dopo il taglio no');

    // Il taglio e' scritto nel ledger, e la decisione e' arrivata lo stesso.
    const retries = ledger(runId).filter(e => e.type === 'decision_budget_retry');
    assert.equal(retries.length, 2, 'due tagli, due righe: ' + JSON.stringify(ledger(runId).map(e => e.type)));
    assert.deepEqual(retries.map(r => [r.from, r.cap, r.to, r.slim]), [[12, 6, 6, 1], [6, 4, 4, 2]]);
    assert.match(retries[0].error, /max_tokens_exceeded/);
    assert.ok(retries[0].stateBytes > 1000, 'la riga dice quanto era grande la richiesta rifiutata');
    const chosen = ledger(runId).filter(e => e.type === 'decision');
    assert.ok(chosen.length >= 1, 'la decisione e\' stata presa dopo il taglio');
    assert.equal(chosen[0].controller, 'jev');
    assert.equal(chosen[0].optionsCount, 4);
    assert.equal(chosen[0].slim, 2);
  } finally {
    server.close();
    decisions.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(hermes, { recursive: true, force: true });
  }
});

test('a provider that refuses for its size forever is still fatal, with the attempt count', async () => {
  const { server, port } = await startHarness();
  const decisions = await startDecisions({ overflows: 99 });
  const runId = `test-budget-retry-hard-${process.pid}-${Date.now()}`;
  const hermes = fakeHermes();
  try {
    const { code, stdout } = await runController({
      HARNESS: `http://127.0.0.1:${port}`,
      RUN_ID: runId,
      CONTROLLER: 'jev',
      MAX_STEPS: '2',
      REPLAN_EVERY: '0',
      MAX_OPTIONS: '12',
      DECISION_BUDGET_RETRIES: '1',
      TARGETS: '{"copper_ore":1}',
      CURRICULUM: '',
      WAYPOINT: '',
      CHAT_ALLOWLIST: '',
      CHAT_CONTROL: 'off',
      OPENROUTER_API_KEY: '',
      TYPESAFE_API_KEY: 'test-key',
      JEV_MODEL: 'jev-test',
      SYSTEM_ONE_URL: `http://127.0.0.1:${decisions.port}/v1/systemone`,
      HERMES_TIMEOUT_MS: '20000',
      PATH: `${hermes}:${process.env.PATH}`,
    });
    assert.notEqual(code, 0, 'un tetto che non si scioglie resta un errore');
    assert.match(stdout, /max_tokens_exceeded/, 'il motivo resta nel log');
    // Un taglio (12 -> 6) e poi la resa: due richieste, non un ciclo infinito.
    assert.equal(decisions.calls.length, 2, 'il numero di tagli e\' bounded');
  } finally {
    server.close();
    decisions.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
    rmSync(hermes, { recursive: true, force: true });
  }
});
