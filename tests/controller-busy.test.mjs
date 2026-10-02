// A `busy` answer from the harness is a lock, not a verdict on the action: the
// controller must wait for the harness to release it instead of burning the
// step budget with instant failures.
//
// Live origin (2026-10-03): a run killed mid-action left the harness busy; the
// next run spent its whole 25-step budget in ~2 minutes of instant `busy`
// replies and never attempted a single real action.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Always picks the same key, whatever the criteria say: the fake harness owns
// validity and offers only one usable action anyway.
function fakeHermesOutput (key) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-hermes-busy-'));
  const bin = join(dir, 'hermes');
  writeFileSync(bin, `#!/bin/sh\nprintf %s ${JSON.stringify(key)}\n`);
  chmodSync(bin, 0o755);
  return dir;
}

// Busy for the first `busyFor` action requests, then a normal world where each
// `mine_dirt` adds one dirt.
function startBusyHarness ({ busyFor = 3 } = {}) {
  return new Promise(resolve => {
    const state = { inventory: {}, actPosts: 0, busyReplies: 0 };
    const server = createServer((req, res) => {
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
        }));
      } else if (req.method === 'GET' && req.url === '/options') {
        res.end(JSON.stringify({ options: [{ key: 'mine_dirt', description: 'mine dirt' }] }));
      } else if (req.method === 'POST' && req.url === '/act') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          state.actPosts += 1;
          if (state.actPosts <= busyFor) {
            state.busyReplies += 1;
            res.end(JSON.stringify({ ok: false, error: 'busy' }));
            return;
          }
          state.inventory.dirt = (state.inventory.dirt || 0) + 1;
          res.end(JSON.stringify({ ok: true, ms: 1 }));
        });
      } else {
        res.end('{}');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state }));
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

test('a busy harness is waited for instead of burning the step budget', async () => {
  const { server, port, state } = await startBusyHarness({ busyFor: 3 });
  const runId = `test-busy-${process.pid}-${Date.now()}`;
  const dir = join(ROOT, 'runs', runId);
  const hermes = fakeHermesOutput('mine_dirt');
  try {
    const { code, stdout, stderr } = await runController({
      HARNESS: `http://127.0.0.1:${port}`,
      RUN_ID: runId,
      CONTROLLER: 'hermes',
      MAX_STEPS: '6',
      // A concrete target keeps the ambient goal from being trivially met and
      // makes the step count in the closing line meaningful.
      TARGETS: '{"dirt":2}',
      CURRICULUM: '',
      WAYPOINT: '',
      HARNESS_BUSY_MAX_WAIT_MS: '5000',
      HARNESS_BUSY_POLL_MS: '25',
      OPENROUTER_API_KEY: '',
      TYPESAFE_API_KEY: '',
      CHAT_ALLOWLIST: '',
      PATH: `${hermes}:${process.env.PATH}`,
    });
    assert.equal(code, 0, `unexpected exit code ${code}; stdout:\n${stdout}\nstderr:\n${stderr}`);
    // Two real actions end the goal: the three busy replies cost nothing.
    assert.match(stdout, /GOAL MET after 2 actions/);
    const events = readFileSync(join(dir, 'controller.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const busy = events.filter(e => e.type === 'harness_busy');
    assert.equal(busy.length, 1, 'one busy episode expected, got ' + JSON.stringify(busy));
    assert.equal(busy[0].attempts, 3, 'the controller must retry until the lock is free');
    assert.equal(busy[0].ok, true, 'the retried action must eventually run');
    // Only the two real actions are recorded and only they consume budget.
    const results = events.filter(e => e.type === 'result');
    assert.equal(results.length, 2, 'busy must not consume a step: ' + JSON.stringify(results.map(r => r.error)));
    assert.ok(results.every(r => r.ok), 'no step may be a busy failure');
    assert.equal(state.busyReplies, 3);
    assert.equal(state.actPosts, 5, 'three busy replies plus two real actions');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(hermes, { recursive: true, force: true });
  }
});
