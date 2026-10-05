import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { constructionResponse } from '../construction-api.mjs';
import { constructionAdapter } from './fixtures/construction-adapter.mjs';

async function startFixture () {
  const { adapter, events } = constructionAdapter({ inventory: { cobblestone: 25 } });
  const plans = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    try {
      let response = await constructionResponse(adapter, req.method, req.url, body);
      if (!response && req.url === '/observe') response = [200, { position: adapter.pos(), health: 20, food: 20, inventory: adapter.inventory, dimension: 'overworld', construction: adapter.construction.view(), entities: [], drops: [], chat: [], time: { phase: 'day' }, plan: adapter.plan }];
      if (!response && req.url === '/options') response = [200, { options: adapter.options() }];
      if (!response && req.url === '/plan') { adapter.setPlan(body); plans.push(adapter.plan); response = [200, { ok: true, plan: adapter.plan }]; }
      if (!response && req.url === '/act') response = [200, await adapter.executeAction(body.key)];
      response ??= [200, {}];
      res.writeHead(response[0], { 'Content-Type': 'application/json' }); res.end(JSON.stringify(response[1]));
    } catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, adapter, events, plans, url: `http://127.0.0.1:${server.address().port}` };
}

test('HTTP preview/start/control retain a concrete immutable instance and preview never writes', async () => {
  const { server, adapter, events, url } = await startFixture();
  const post = async (path, body) => (await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  try {
    const request = { type: 'platform', origin: { x: 0, y: 64, z: 0 } };
    const preview = await post('/construction/preview', request);
    assert.equal(preview.ok, true); assert.equal(preview.materials.cobblestone, 25);
    assert.equal(adapter.memory.constructions().length, 0); assert.equal(events.placed.length, 0);
    const start = await post('/construction/start', request);
    const id = start.plan.construction.projectId;
    assert.ok(id); assert.equal(adapter.memory.constructions().length, 1);
    assert.equal((await post('/construction/control', { projectId: id, command: 'pause' })).state, 'paused');
    assert.equal((await post('/construction/control', { projectId: 'wrong', command: 'resume' })).error, 'construction_project_mismatch');
    assert.equal((await post('/construction/control', { projectId: id, command: 'resume' })).state, 'building');
    assert.equal((await post('/construction/start', { projectId: id, parameters: { width: 9 } })).ok, false);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('real controller completes a project through HTTP and cannot stop at the material inventory', { timeout: 30000 }, async () => {
  const { server, adapter, plans, events, url } = await startFixture();
  const dir = mkdtempSync(join(tmpdir(), 'construction-controller-'));
  const runId = `test-construction-controller-${process.pid}-${Date.now()}`;
  writeFileSync(join(dir, 'hermes'), '#!/bin/sh\nprintf "construction_step\\n"\n', { mode: 0o755 });
  try {
    const child = spawn(process.execPath, ['controller.mjs'], { env: { ...process.env,
      PATH: `${dir}:${process.env.PATH}`, HARNESS: url, RUN_ID: runId, CONTROLLER: 'hermes',
      GOAL: 'Build a platform', CONSTRUCTION: JSON.stringify({ type: 'platform', origin: { x: 0, y: 64, z: 0 } }),
      TARGETS: '{}', WAYPOINT: '', CURRICULUM: '', SESSION: '', AUTONOMY: 'off', EMERGENCY: 'off',
      GOAL_CONTRACT: JSON.stringify({ success: { inventoryGte: { cobblestone: 25 } } }),
      CHAT_CONTROL: 'off', CHAT_ALLOWLIST: '', CHAT_GREET: 'off', CHAT_REPLY: 'off',
      MAX_STEPS: '25', REPLAN_EVERY: '2', HERMES_TIMEOUT_MS: '2000',
    } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
    const code = await new Promise(resolve => child.on('close', resolve)); clearTimeout(timer);
    assert.equal(code, 0, stderr + stdout);
    assert.match(stdout, /GOAL (?:CONTRACT )?MET/);
    assert.equal(adapter.construction.project.state, 'complete');
    assert.equal(events.placed.length, 25);
    assert.equal(plans.length, 1, 'periodic replans retain the immutable active construction project');
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true }); rmSync(join('runs', runId), { recursive: true, force: true });
  }
});
