// Integration smoke for the episodic mission wiring: a controller goal becomes
// a persistent mission in the harness memory (create -> finish with outcome),
// without breaking when the harness does not expose /mission.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function startHarness (observation = { position: { x: 0, y: 64, z: 0 }, inventory: { dirt: 2 }, health: 20, dead: false, time: { ticks: 1000, night: false }, entities: [], chat: [], dropped: [], containers: [] }) {
  return new Promise(resolve => {
    const calls = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const path = req.url.split('?')[0];
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch { /* ignore */ }
        calls.push({ method: req.method, path, payload });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.method === 'GET' && path === '/observe') res.end(JSON.stringify(observation));
        else if (path === '/mission') res.end(JSON.stringify({ ok: true, mission: { id: 'mission_test', type: payload.type, intent: payload.intent, rawPrompt: payload.rawPrompt } }));
        else if (path === '/mission/finish') res.end(JSON.stringify({ ok: true, mission: { id: payload.missionId, ...payload } }));
        else if (path === '/mission/action') res.end(JSON.stringify({ ok: true, id: 'action_1' }));
        else if (path === '/mission/link') res.end(JSON.stringify({ ok: true, id: 'link_1' }));
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
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 20000);
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

const baseEnv = (runId, port) => ({
  HARNESS: `http://127.0.0.1:${port}`,
  RUN_ID: runId,
  CONTROLLER: 'jev',
  MAX_STEPS: '3',
  GOAL_CONTRACT: JSON.stringify({ goal: 'smoke', success: { inventoryGte: { dirt: 1 } } }),
  OPENROUTER_API_KEY: '',
  TYPESAFE_API_KEY: '',
  CHAT_ALLOWLIST: '',
});

test('a goal is wired into a mission: create then finish with success', async () => {
  const { server, port, calls } = await startHarness();
  const runId = `test-mission-${process.pid}-${Date.now()}`;
  try {
    const { code } = await runController(baseEnv(runId, port));
    assert.equal(code, 0);
    const create = calls.find(c => c.method === 'POST' && c.path === '/mission');
    assert.ok(create, 'mission create called');
    assert.ok(create.payload.rawPrompt && create.payload.rawPrompt.includes('dirt'), 'rawPrompt carries the objective');
    assert.ok(create.payload.intent, 'intent set');
    const finish = calls.find(c => c.method === 'POST' && c.path === '/mission/finish');
    assert.ok(finish, 'mission finish called');
    assert.equal(finish.payload.missionId, 'mission_test');
    assert.equal(finish.payload.success, true);
    assert.equal(finish.payload.state, 'found');
  } finally {
    server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
  }
});

test('a harness without /mission degrades gracefully (no crash)', async () => {
  // /mission and friends return {} here (no mission.id): the controller must
  // no-op the episodic wiring, not throw.
  const observation = { position: { x: 0, y: 64, z: 0 }, inventory: { dirt: 2 }, health: 20, dead: false, time: { ticks: 1000, night: false }, entities: [], chat: [], dropped: [], containers: [] };
  const harness = await new Promise(resolve => {
    const s = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.method === 'GET' && req.url.split('?')[0] === '/observe') res.end(JSON.stringify(observation));
      else res.end('{}');
    });
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
  });
  const runId = `test-mission-degrade-${process.pid}-${Date.now()}`;
  try {
    const { code } = await runController(baseEnv(runId, harness.port));
    assert.equal(code, 0, 'controller completes even without /mission support');
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
  }
});

test('a fatal controller error closes the mission instead of leaking it', async () => {
  // Goal non soddisfatto + nessuna chiave API: il provider decisionale esplode a
  // metà run. La missione episodica deve chiudersi come fallita (mai restare
  // RUNNING per sempre) e il processo deve uscire non-zero, con l'errore nei log.
  const observation = { position: { x: 0, y: 64, z: 0 }, inventory: {}, health: 20, dead: false, time: { ticks: 1000, night: false }, entities: [], chat: [], dropped: [], containers: [] };
  const calls = [];
  const harness = await new Promise(resolve => {
    const s = createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const path = req.url.split('?')[0];
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch { /* ignore */ }
        calls.push({ method: req.method, path, payload });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.method === 'GET' && path === '/observe') res.end(JSON.stringify(observation));
        else if (req.method === 'GET' && path === '/options') res.end(JSON.stringify({ options: [{ key: 'mine_dirt', label: 'mine dirt' }] }));
        else if (path === '/mission') res.end(JSON.stringify({ ok: true, mission: { id: 'mission_test', type: payload.type, intent: payload.intent, rawPrompt: payload.rawPrompt } }));
        else if (path === '/mission/finish') res.end(JSON.stringify({ ok: true, mission: { id: payload.missionId, ...payload } }));
        else res.end('{}');
      });
    });
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
  });
  const runId = `test-mission-fatal-${process.pid}-${Date.now()}`;
  try {
    const { code, stderr } = await runController(baseEnv(runId, harness.port));
    assert.notEqual(code, 0, 'a fatal error exits non-zero');
    assert.match(stderr, /ERROR: /, 'the fatal error is visible on stderr');
    const finish = calls.find(c => c.method === 'POST' && c.path === '/mission/finish');
    assert.ok(finish, 'the leaked mission is closed even on a fatal error');
    assert.equal(finish.payload.missionId, 'mission_test');
    assert.equal(finish.payload.success, false);
    assert.equal(finish.payload.state, 'failed');
    assert.match(String(finish.payload.failureReason), /controller_error/, 'failureReason names the controller error');
  } finally {
    harness.server.close();
    rmSync(join(ROOT, 'runs', runId), { recursive: true, force: true });
  }
});
