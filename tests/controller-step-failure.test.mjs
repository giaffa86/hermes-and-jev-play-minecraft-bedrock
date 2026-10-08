// R4: un rifiuto dell'harness non e' un errore generico. Il controller lo
// classifica (`step-failure.mjs`), lo marca **sul passo** che l'ha subito e
// decide: ritentare, cambiare approccio (`switch`: la chiave rifiutata esce
// dalle opzioni) o far fallire il passo e ripianificare (`replan`).
//
// Qui si guarda quello che attraversa il filo: quale chiave viene chiesta
// all'harness, cosa finisce nel piano ripubblicato, cosa resta nella traccia.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { readPlanTrace, summarizePlanTrace } from '../plan-trace.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Un piano senza skill dichiarata: gli step esistono lo stesso (R1 li deriva
// dall'obiettivo) e la verifica resta quella dei `targets`, senza una skill che
// possa fallire e sporcare il caso.
const PLAN = {
  objective: 'mine copper for the test',
  subgoal: null,
  targets: { copper_ore: 1 },
  waypoint: null,
  skill: null,
  notes: 'test',
};

// Due chiavi sorelle (stesso intento `mine`): e' il caso in cui `switch` ha
// davvero un'alternativa da offrire.
const OPTIONS = [
  { key: 'mine_iron_ore', description: 'mine iron ore' },
  { key: 'mine_copper_ore', description: 'mine copper ore' },
];

// Lo shim di Hermes risponde al *planner* con il piano e al *decisore* con la
// prima chiave elencata nel prompt — cioe' la prima che `/options` ha offerto
// **dopo** i filtri del controller. Cosi' e' il controller a scegliere (e la
// sua esclusione a mordere), non lo shim.
function fakeHermes () {
  const dir = mkdtempSync(join(tmpdir(), 'fake-hermes-step-'));
  const bin = join(dir, 'hermes');
  writeFileSync(bin, `#!/bin/sh
prompt="$7"
case "$prompt" in
  "Objective: "*)
    printf '%s\\n' "$prompt" | sed -n 's/^- \\([a-zA-Z0-9_]*\\):.*/\\1/p' | head -n 1
    ;;
  *)
    printf '%s\\n' '${JSON.stringify(PLAN)}'
    ;;
esac
`);
  chmodSync(bin, 0o755);
  return dir;
}

// L'harness scriptato: `mine_iron_ore` rifiuta sempre con `refusal`, il minerale
// alternativo riesce e soddisfa il target. `state` e' l'evidenza del test.
function startHarness ({ refusal }) {
  return new Promise(resolve => {
    const state = { acted: [], plans: [], inventory: {}, plan: null };
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.method === 'GET' && req.url === '/observe') {
          res.end(JSON.stringify({
            position: { x: 0, y: 64, z: 0 },
            dimension: 'overworld',
            inventory: { ...state.inventory },
            health: 20,
            food: 20,
            dead: false,
            time: { ticks: 2000, night: false, phase: 'day' },
            entities: [], chat: [], drops: [], containers: [],
            plan: state.plan,
          }));
        } else if (req.method === 'GET' && req.url === '/options') {
          res.end(JSON.stringify({ options: OPTIONS }));
        } else if (req.method === 'POST' && req.url === '/act') {
          const payload = JSON.parse(body || '{}');
          state.acted.push(payload.key);
          if (payload.key === 'mine_iron_ore') {
            res.end(JSON.stringify({ ok: false, error: refusal, ms: 300 }));
            return;
          }
          state.inventory.copper_ore = 1;
          res.end(JSON.stringify({ ok: true, ms: 5 }));
        } else if (req.method === 'POST' && req.url === '/plan') {
          const plan = JSON.parse(body || '{}');
          state.plans.push(plan);
          state.plan = plan;
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.end('{}');
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state }));
  });
}

function runController (env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['controller.mjs'], { cwd: ROOT, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 40000);
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

const eventsOf = runId => readFileSync(join(ROOT, 'runs', runId, 'controller.jsonl'), 'utf8')
  .trim().split('\n').map(line => JSON.parse(line));

function withRun (fn) {
  const runId = `test-step-failure-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = join(ROOT, 'runs', runId);
  const hermes = fakeHermes();
  return fn({ runId, dir, hermes }).finally(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(hermes, { recursive: true, force: true });
  });
}

const baseEnv = (port, runId, hermes) => ({
  HARNESS: `http://127.0.0.1:${port}`,
  RUN_ID: runId,
  CONTROLLER: 'hermes',
  MAX_STEPS: '3',
  REPLAN_EVERY: '0',
  TARGETS: '{"copper_ore":1}',
  CURRICULUM: '',
  WAYPOINT: '',
  CHAT_ALLOWLIST: '',
  CHAT_CONTROL: 'off',
  OPENROUTER_API_KEY: '',
  TYPESAFE_API_KEY: '',
  HERMES_TIMEOUT_MS: '20000',
  PATH: `${hermes}:${process.env.PATH}`,
});

test('a blocked refusal marks the step, drops the key and the next decision picks the alternative', async () => {
  const { server, port, state } = await startHarness({ refusal: 'no reachable iron_ore found nearby' });
  await withRun(async ({ runId, dir, hermes }) => {
    try {
      const { code, stdout, stderr } = await runController(baseEnv(port, runId, hermes));
      assert.equal(code, 0, `unexpected exit code ${code}; stdout:\n${stdout}\nstderr:\n${stderr}`);

      const events = eventsOf(runId);
      const failed = events.filter(e => e.type === 'step_failed');
      assert.equal(failed.length, 1, 'un rifiuto, un record: ' + JSON.stringify(events.map(e => e.type)));
      assert.equal(failed[0].error, 'no reachable iron_ore found nearby');
      assert.equal(failed[0].kind, 'blocked');
      assert.equal(failed[0].retryable, false);
      assert.equal(failed[0].attempts, 1);
      assert.ok(failed[0].stepId, 'il rifiuto appartiene a un passo, non al vuoto');
      assert.equal(failed[0].disposition, 'switch');
      assert.equal(failed[0].dispositionReason, 'blocked_alternative');
      // L'evidenza e' uno stato, non un dump: posizione e dimensione bastano.
      assert.equal(failed[0].evidence.dimension, 'overworld');
      assert.equal(failed[0].evidence.position.x, 0);

      const switched = events.filter(e => e.type === 'step_switch');
      assert.equal(switched.length, 1);
      assert.deepEqual(switched[0].alternatives, ['mine_copper_ore']);

      // La prova che l'esclusione morde: la chiave rifiutata non viene richiesta
      // una seconda volta, l'alternativa si'.
      assert.deepEqual(state.acted, ['mine_iron_ore', 'mine_copper_ore']);
      assert.match(stdout, /GOAL MET after 2 actions/);

      // Il piano ripubblicato porta il rifiuto **sullo step**.
      const revision = state.plans.at(-1);
      assert.equal(revision.steps[0].refused.error, 'no reachable iron_ore found nearby');
      assert.equal(revision.steps[0].refused.kind, 'blocked');
      assert.equal(revision.steps[0].refused.retryable, false);
      assert.equal(revision.steps[0].refusalCount, 1);
      assert.deepEqual(revision.steps[0].refused.alternatives, ['mine_copper_ore']);

      // E la traccia lo dice senza dover leggere `controller.jsonl` a mano.
      const trace = readPlanTrace(dir);
      assert.ok(Array.isArray(trace) && trace.length >= 1, 'la traccia del piano esiste');
      const refused = trace.flatMap(row => row.refusals);
      assert.equal(refused.length, 1);
      assert.equal(refused[0].kind, 'blocked');
      assert.equal(refused[0].retryable, false);
      assert.equal(refused[0].stepId, failed[0].stepId);
      assert.deepEqual(summarizePlanTrace(trace).refusalsByKind, { blocked: 1 });
    } finally {
      server.close();
    }
  });
});

test('a terminal refusal fails the step and replans instead of revising the plan', async () => {
  const { server, port, state } = await startHarness({ refusal: 'missing_diamond_pickaxe' });
  await withRun(async ({ runId, dir, hermes }) => {
    try {
      const { code, stdout, stderr } = await runController(baseEnv(port, runId, hermes));
      assert.equal(code, 0, `unexpected exit code ${code}; stdout:\n${stdout}\nstderr:\n${stderr}`);

      const events = eventsOf(runId);
      const failed = events.filter(e => e.type === 'step_failed');
      assert.ok(failed.length >= 1, 'il rifiuto terminale e` registrato: ' + JSON.stringify(events.map(e => e.type)));
      assert.equal(failed[0].error, 'missing_diamond_pickaxe');
      assert.equal(failed[0].kind, 'prerequisite');
      assert.equal(failed[0].retryable, false);
      assert.equal(failed[0].disposition, 'replan');
      assert.equal(failed[0].dispositionReason, 'prerequisite_terminal');

      // Un rifiuto terminale non revisiona il passo: cambia il piano, ed e' il
      // replan a portare il motivo tipizzato.
      const replans = events.filter(e => e.type === 'replan');
      assert.ok(replans.some(r => r.reason === 'step_failed:missing_diamond_pickaxe'),
        'il replan deve dire perche`: ' + JSON.stringify(replans.map(r => r.reason)) + ' eventi: ' + events.map(e => e.type).join(','));
      assert.equal(events.filter(e => e.type === 'step_switch').length, 0);
      assert.ok(state.plans.every(plan => !plan.steps?.[0]?.refused), 'nessuna revisione del passo');

      // Il rifiuto resta comunque nella traccia, con il suo tipo.
      const trace = readPlanTrace(dir);
      assert.ok(Array.isArray(trace) && trace.length >= 1);
      const kinds = summarizePlanTrace(trace).refusalsByKind;
      assert.ok(kinds.prerequisite >= 1, `il tipo deve essere contato: ${JSON.stringify(kinds)}`);
    } finally {
      server.close();
    }
  });
});
