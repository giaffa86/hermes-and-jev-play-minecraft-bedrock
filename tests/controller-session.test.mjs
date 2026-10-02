// Integration smoke for the persistent session loop (AI-player roadmap M0->1).
// Boots a fake harness implementing /observe, then runs controller.mjs with a
// Goal Contract that is already satisfied, so the goal completes without any
// decision model. Verifies: the goal is registered and completed, the loop
// enters IDLE instead of exiting, and the queue is persisted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const OBSERVATION = {
  position: { x: 0, y: 64, z: 0 },
  inventory: { dirt: 2 },
  health: 20,
  dead: false,
  time: { ticks: 1000, night: false },
  entities: [],
  chat: [],
  dropped: [],
  containers: [],
};

function startFakeHarness (observation = OBSERVATION) {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.method === 'GET' && req.url === '/observe') res.end(JSON.stringify(observation));
      else res.end('{}');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// A fake `hermes` CLI so the chat->plan translation does not need a real model.
function fakeHermesBin (plan) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-hermes-'));
  const bin = join(dir, 'hermes');
  writeFileSync(bin, `#!/bin/sh\nprintf '%s' '${JSON.stringify(plan)}'\n`);
  chmodSync(bin, 0o755);
  return { dir, path: dir };
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

test('session mode: goal completes, then the loop idles and exits on timeout', async () => {
  const { server, port } = await startFakeHarness();
  const runId = `test-session-${process.pid}-${Date.now()}`;
  const dir = join(ROOT, 'runs', runId);
  try {
    const { code, stdout } = await runController({
      ...baseEnv(runId, port),
      SESSION: 'on',
      IDLE_POLL_MS: '100',
      IDLE_TIMEOUT_MS: '800',
    });
    assert.equal(code, 0, `unexpected exit code; stdout:\n${stdout}`);
    assert.match(stdout, /GOAL g1 \[autonomous\]/);
    assert.match(stdout, /GOAL CONTRACT SUCCESS/);
    assert.match(stdout, /GOAL g1 COMPLETED/);
    assert.match(stdout, /IDLE — waiting for a new goal/);
    // persisted queue: one completed goal survives in the run directory
    const file = join(dir, 'goals', 'world.json');
    assert.ok(existsSync(file), 'goal store was not written');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    const goals = saved.records.filter(r => r.kind === 'goal');
    assert.equal(goals.length, 1);
    assert.equal(goals[0].status, 'completed');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('idle accepts a chat order as a new goal (no reconnect, no re-run)', async () => {
  const chatEntry = { at: Date.now(), from: 'Tester', xuid: 'x-tester', message: '@bot dig here' };
  const { server, port } = await startFakeHarness({ ...OBSERVATION, chat: [chatEntry] });
  const runId = `test-chat-goal-${process.pid}-${Date.now()}`;
  const dir = join(ROOT, 'runs', runId);
  const hermes = fakeHermesBin({ objective: 'Dig where the human asked', targets: {}, waypoint: null });
  try {
    const { code, stdout } = await runController({
      ...baseEnv(runId, port),
      SESSION: 'on',
      IDLE_POLL_MS: '100',
      IDLE_TIMEOUT_MS: '1500',
      CHAT_ALLOWLIST: 'Tester',
      PATH: `${hermes.path}:${process.env.PATH}`,
    });
    assert.equal(code, 0, `unexpected exit code; stdout:\n${stdout}`);
    assert.match(stdout, /GOAL g2 \[chat\] Dig where the human asked/);
    assert.match(stdout, /GOAL g2 COMPLETED/);
    const saved = JSON.parse(readFileSync(join(dir, 'goals', 'world.json'), 'utf8'));
    const chatGoal = saved.records.find(r => r.kind === 'goal' && r.goal.source === 'chat');
    assert.ok(chatGoal, 'chat goal was not persisted');
    assert.equal(chatGoal.status, 'completed');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(hermes.dir, { recursive: true, force: true });
  }
});

test('one-shot mode (default): exits after the goal without idling', async () => {
  const { server, port } = await startFakeHarness();
  const runId = `test-oneshot-${process.pid}-${Date.now()}`;
  const dir = join(ROOT, 'runs', runId);
  try {
    const { code, stdout } = await runController(baseEnv(runId, port));
    assert.equal(code, 0, `unexpected exit code; stdout:\n${stdout}`);
    assert.match(stdout, /GOAL g1 COMPLETED/);
    assert.doesNotMatch(stdout, /IDLE — waiting for a new goal/);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
