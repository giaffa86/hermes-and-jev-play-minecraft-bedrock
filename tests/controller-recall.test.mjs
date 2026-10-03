// Integration test for the P6 semantic recall path: the planner prompt carries
// the vector-index hits for the *current* goal, and the recall is an add-on —
// if the route answers badly the plan still happens.
//
// The harness is scripted and the planner is a fake `hermes` binary that records
// its own argv, so the assertions read the exact prompt the controller built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Fake `hermes`: pops the next scripted output and appends its own argv to a log,
// so the test can read the prompt (`-q <prompt>`) the controller passed.
function fakeHermesQueue (outputs) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-hermes-recall-'));
  const queuePath = join(dir, 'queue.json');
  const popPath = join(dir, 'pop.mjs');
  const argvPath = join(dir, 'argv.log');
  writeFileSync(queuePath, JSON.stringify(outputs));
  writeFileSync(argvPath, '');
  writeFileSync(popPath, `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const path = ${JSON.stringify(queuePath)};
const argvPath = ${JSON.stringify(argvPath)};
const queue = JSON.parse(readFileSync(path, 'utf8'));
const next = queue.shift() ?? 'wait';
writeFileSync(path, JSON.stringify(queue));
appendFileSync(argvPath, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(next);
`);
  const bin = join(dir, 'hermes');
  writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(popPath)} "$@"\n`);
  chmodSync(bin, 0o755);
  const prompts = () => readFileSync(argvPath, 'utf8').trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line))
    .map(argv => argv[argv.indexOf('-q') + 1] ?? '');
  return { dir, prompts };
}

const SEARCH_HITS = [
  { id: 'resource_site_7_9', score: 0.61, kind: 'resource_site', type: 'surface_ores', label: 'dirt patch', position: { x: 120, y: 75, z: 152 }, productivity: { dirt: { found: 4 } } },
  { id: 'landmark_home', score: 0.22, kind: 'landmark', type: 'home', label: 'home', position: { x: 113, y: 73, z: 156 }, productivity: null },
];

// Scripted harness: `/observe` hands out dirt only from the second call, so the
// goal contract closes after one action and the planner runs exactly once.
function startHarness ({ search = { hits: SEARCH_HITS, count: SEARCH_HITS.length } } = {}) {
  return new Promise(resolve => {
    const calls = [];
    let observes = 0;
    const observation = () => ({
      position: { x: 115, y: 74, z: 159 },
      inventory: observes > 2 ? { dirt: 1 } : {},
      health: 20, food: 20, dead: false, spawned: true,
      time: { ticks: 1000, night: false, phase: 'day' },
      entities: [], humans: [], dropped: [], containers: [], chat: [],
      memory: { hints: [] },
    });
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const path = req.url.split('?')[0];
        const query = req.url.includes('?') ? new URLSearchParams(req.url.split('?')[1]) : new URLSearchParams();
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch { /* ignore */ }
        calls.push({ method: req.method, path, query: Object.fromEntries(query), payload });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.method === 'GET' && path === '/observe') { observes += 1; res.end(JSON.stringify(observation())); }
        else if (path === '/options') res.end(JSON.stringify({ options: [{ key: 'mine_dirt', label: 'mine dirt', description: 'mine a dirt block' }] }));
        else if (path === '/act') res.end(JSON.stringify({ ok: true, block: 'dirt' }));
        else if (path === '/memory/search') res.end(JSON.stringify(search));
        else if (path === '/plan') res.end(JSON.stringify({ ok: true }));
        else if (path === '/mission') res.end(JSON.stringify({ ok: true, mission: { id: 'mission_recall', type: payload.type, intent: payload.intent } }));
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

const PLAN = JSON.stringify({ objective: 'mine the dirt near home', targets: { dirt: 1 }, waypoint: null, notes: 'test' });

const baseEnv = (runId, port, hermesPath) => ({
  HARNESS: `http://127.0.0.1:${port}`,
  RUN_ID: runId,
  PATH: `${hermesPath}:${process.env.PATH}`,
  CONTROLLER: 'hermes',
  SESSION: '',
  AUTONOMY: '',
  MAX_STEPS: '3',
  GOAL: 'Collect 1 dirt near home',
  TARGETS: '{"dirt":1}',
  GOAL_CONTRACT: JSON.stringify({ goal: 'get dirt', success: { inventoryGte: { dirt: 1 } } }),
  OPENROUTER_API_KEY: '',
  TYPESAFE_API_KEY: '',
  CHAT_ALLOWLIST: '',
});

function readEvents (runId) {
  const file = join(ROOT, 'runs', runId, 'controller.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return { type: 'unparsable', line }; }
  });
}

test('the planner prompt carries the semantic recall of the current goal', async () => {
  const hermes = fakeHermesQueue([PLAN, 'mine_dirt']);
  const { server, port, calls } = await startHarness();
  const runId = `test-recall-${Date.now().toString(36)}`;
  try {
    const { code, stderr } = await runController(baseEnv(runId, port, hermes.dir));
    assert.equal(code, 0, stderr);

    // La query viene dal goal in corso, non dal mondo: obiettivo + target.
    const searches = calls.filter(c => c.path === '/memory/search');
    assert.equal(searches.length, 1, 'una sola ricerca per piano');
    assert.match(searches[0].query.q, /Collect 1 dirt near home/);
    assert.match(searches[0].query.q, /dirt/);
    assert.equal(searches[0].query.limit, '3');

    // Il recall finisce nel prompt del planner, insieme agli indizi di P0.
    const planPrompt = hermes.prompts().find(p => p.includes('PLANNER'));
    assert.ok(planPrompt, 'il planner ha girato');
    assert.match(planPrompt, /Similar places from memory \(semantic recall — hints, re-verify on the spot\)/);
    assert.match(planPrompt, /dirt patch at 120,152 \(0\.61, proven\)/);
    assert.match(planPrompt, /home at 113,156 \(0\.22\)/);

    // Tracciabilità: l'evento porta query e hit, senza errori.
    const recall = readEvents(runId).filter(e => e.type === 'semantic_recall');
    assert.equal(recall.length, 1);
    assert.deepEqual(recall[0].hits, [{ id: 'resource_site_7_9', score: 0.61 }, { id: 'landmark_home', score: 0.22 }]);
    assert.equal(recall[0].error, null);

    // Il percorso normale non è disturbato: il contratto si chiude all'azione 1.
    const contract = readEvents(runId).filter(e => e.type === 'goal_contract');
    assert.equal(contract.at(-1).status, 'success');
    assert.equal(contract.at(-1).step, 1);
  } finally {
    server.close();
    rmSync(hermes.dir, { recursive: true, force: true });
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
  }
});

test('a broken recall route does not stop the plan (fail-open)', async () => {
  const hermes = fakeHermesQueue([PLAN, 'mine_dirt']);
  const { server, port } = await startHarness({ search: { error: 'vector index unavailable' } });
  const runId = `test-recall-off-${Date.now().toString(36)}`;
  try {
    const { code, stderr } = await runController(baseEnv(runId, port, hermes.dir));
    assert.equal(code, 0, stderr);

    const recall = readEvents(runId).filter(e => e.type === 'semantic_recall');
    assert.equal(recall.length, 1);
    assert.deepEqual(recall[0].hits, []);
    assert.equal(recall[0].error, 'vector index unavailable');

    const planPrompt = hermes.prompts().find(p => p.includes('PLANNER'));
    assert.ok(planPrompt);
    assert.doesNotMatch(planPrompt, /semantic recall/, 'senza hit il prompt non promette indizi');

    const contract = readEvents(runId).filter(e => e.type === 'goal_contract');
    assert.equal(contract.at(-1).status, 'success');
  } finally {
    server.close();
    rmSync(hermes.dir, { recursive: true, force: true });
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
  }
});
