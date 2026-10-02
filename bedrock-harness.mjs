// Hermes Bedrock harness: un bot Bedrock reale + bounded-action HTTP API.
//   GET  /observe  -> stato normalizzato del bot
//   GET  /options  -> azioni valide in questo momento
//   POST /act {key} -> esegue un'azione
//   POST /plan {objective, waypoint, targets} -> registra il piano corrente
// Il controller sceglie solo chiavi restituite da /options; la validità è qui.
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import { BedrockAdapter } from './bedrock-adapter.mjs';
import { setTimeout as delay } from 'node:timers/promises';

console.log('BEDROCK HARNESS VERSION 2');
const API_PORT = +(process.env.API_PORT || 3077);
const API_HOST = process.env.API_HOST || '127.0.0.1';
const RUN = process.env.RUN_ID || 'run';

mkdirSync(`runs/${RUN}`, { recursive: true });
const eventLog = (type, data) => appendFileSync(`runs/${RUN}/events.jsonl`, JSON.stringify({ t: Date.now(), type, ...data }) + '\n');

let server;
let shuttingDown = false;
const shutdownSignal = new AbortController();
let connectionWorker = null;

const adapter = new BedrockAdapter({
  // onLog: (entry) => eventLog(entry.type, entry),
  onDisconnect: () => {
    console.warn('[adapter] disconnected; will reconnect');
    startConnectionWorker(10000);
  },
});

function startConnectionWorker (initialDelay = 0) {
  if (connectionWorker || shuttingDown) return;
  connectionWorker = connectLoop(initialDelay).catch(error => {
    if (!shuttingDown) console.error('[connectLoop]', error.message);
  }).finally(() => {
    connectionWorker = null;
    if (!shuttingDown && !adapter.spawned) startConnectionWorker(10000);
  });
}

async function shutdown () {
  if (shuttingDown) return;
  shuttingDown = true;
  shutdownSignal.abort();
  console.log('Disconnecting bot and waiting for NetherNet teardown');
  server?.close();
  server?.closeAllConnections();
  try { await adapter.disconnect('harness shutdown'); }
  catch (error) { console.error('Shutdown failed:', error.message); process.exitCode = 1; }
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
  // Non usciamo: in un servizio long-running e' meglio loggare e continuare.
});

async function connectLoop (initialDelay = 0) {
  if (initialDelay) await delay(initialDelay, undefined, { signal: shutdownSignal.signal });
  let attempt = 0;
  while (!shuttingDown) {
    attempt++;
    try {
      await adapter.connect();
      console.log('bedrock harness connected after attempt', attempt);
      return;
    } catch (err) {
      console.error(`[connect] attempt ${attempt} failed:`, err.message || err);
      if (shuttingDown) return;
      const delayMs = Math.min(5000 * 2 ** Math.min(attempt - 1, 4), 60000);
      console.log(`[connect] retrying in ${delayMs}ms...`);
      await delay(delayMs, undefined, { signal: shutdownSignal.signal });
    }
  }
}

if (!shuttingDown) {
console.log('bedrock harness starting; api on', API_PORT);
server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  console.log('[http]', req.method, req.url, 'body_len', body.length);
  const safeJson = (obj) => JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? v.toString() : v);
  let response;
  try {
    if (req.method === 'GET' && req.url === '/observe') response = [200, adapter.observe()];
    else if (req.method === 'GET' && req.url === '/options') response = [200, { options: adapter.options() }];
    else if (process.env.BEDROCK_DEBUG && req.method === 'GET' && req.url === '/debug/geom') response = [200, geometryReport(adapter)];
    else if (process.env.BEDROCK_DEBUG && req.method === 'POST' && req.url === '/debug/mine') {
      const { x, y, z } = JSON.parse(body);
      const block = adapter.world.blockAt({ x, y, z });
      if (!block) response = [200, { ok: false, error: 'block_not_loaded' }];
      else response = [200, await adapter._mineTarget({ cell: { x, y, z }, block, raw: block.name === 'unknown' })];
    }
    else if (req.method === 'POST' && req.url === '/plan') { adapter.setPlan(JSON.parse(body)); response = [200, { ok: true, plan: adapter.plan }]; }
    else if (req.method === 'POST' && req.url === '/act') { const { key } = JSON.parse(body); response = [200, await adapter.executeAction(key)]; }
    else response = [404, { error: 'unknown route' }];

    // Solo lettura: griglia camminabile attorno al bot e validità della risalita.
    function geometryReport (a) {
      if (!a._feet) return { error: 'no_position' };
      const feet = a._feet;
      const cx = Math.floor(feet.x), cz = Math.floor(feet.z), cy = Math.floor(feet.y + 1e-3);
      const grid = [];
      for (let dy = 5; dy >= -3; dy--) {
        const cells = [];
        for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
          if (a._standable(cx + dx, cy + dy, cz + dz)) cells.push(`${dx >= 0 ? '+' : ''}${dx},${dz >= 0 ? '+' : ''}${dz}`);
        }
        grid.push({ dy, cells });
      }
      const upTargets = {};
      const savedYaw = a._lastYaw;
      for (const yaw of [0, 90, 180, -90]) { a._lastYaw = yaw; const plan = a._upTargets(); upTargets[yaw] = plan.error || plan.targets.map(t => t.label); }
      a._lastYaw = savedYaw;
      const bed = a._findBed();
      const bedCenter = bed ? { x: bed.position.x + 0.5, y: bed.position.y, z: bed.position.z + 0.5 } : null;
      const blocks = [];
      for (let dy = -1; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          for (let dz = -4; dz <= 4; dz++) {
            const b = a.world.blockAt({ x: cx + dx, y: cy + dy, z: cz + dz });
            if (b && b.name === 'air') continue;
            blocks.push(`${dx >= 0 ? '+' : ''}${dx},${dy >= 0 ? '+' : ''}${dy},${dz >= 0 ? '+' : ''}${dz}=${b ? `${b.name}${b.diggable ? 'D' : '-'}` : 'NULL'}`);
          }
        }
      }
      return {
        feet, position: a.pos(), startNode: a._startNode(), grid, upTargets, bed, blocks,
        bedGoals: bed ? a._findGoalNodes(bedCenter).map(goal => ({ goal, hasPath: !!a._findPath(a._startNode(), goal) })) : null,
        standingOn: a.standingOn,
      };
    }
  } catch (e) {
    console.error('[http] error handling', req.method, req.url, e);
    response = [500, { error: e.message }];
  }
  try {
    if (!res.headersSent && !res.writableEnded) {
      res.writeHead(response[0], { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(safeJson(response[1]));
    } else {
      console.error('[http] response already sent/ended', req.method, req.url);
    }
  } catch (e) {
    console.error('[http] failed to write response', req.method, req.url, e.message);
  }
}).listen(API_PORT, API_HOST, () => console.log('harness api on', API_PORT));

startConnectionWorker();
}
