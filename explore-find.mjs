// Autonomous exploration M4 driver — observable targets (blocks / entities).
//
// Stessa struttura dell'M1: il planner nel harness scandisce i chunk caricati e
// decide se il target è stato trovato; qui si esegue solo il movimento bounded.
//
//   RUN_ID=exp-find TARGET='funghi marroni' node explore-find.mjs
//   RUN_ID=exp-find TARGET='block:oak_log' node explore-find.mjs
//
import { appendFileSync, mkdirSync } from 'node:fs';
import { runDir } from './run-paths.mjs';

const HARNESS = process.env.HARNESS || 'http://127.0.0.1:3077';
const RUN = process.env.RUN_ID || 'explore-find';
const TARGET = process.env.TARGET || process.env.GOAL || 'brown mushroom';
const RADIUS = process.env.RADIUS || '';
const MAX_STEPS = +(process.env.MAX_STEPS || 200);

const RUN_DIR = runDir(RUN);
mkdirSync(RUN_DIR, { recursive: true });
const log = (type, data) => appendFileSync(`${RUN_DIR}/explore-find.jsonl`, JSON.stringify({ t: Date.now(), type, ...data }) + '\n');

const post = async (path, payload) => (await fetch(`${HARNESS}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload ?? {}) })).json();
const get = async (path) => (await fetch(`${HARNESS}${path}`)).json();
const query = RADIUS ? `?radius=${encodeURIComponent(RADIUS)}` : '';

const started = await post('/explore/find', { target: TARGET });
if (!started.ok) {
  console.error('cannot start the search:', started.error, '— supported:', started.supported);
  process.exit(1);
}
console.log(`search mission ${started.mission.id} — ${started.resolved.kind} ${started.resolved.id}`);
log('start', { mission: started.mission.id, resolved: started.resolved });

for (let step = 1; step <= MAX_STEPS; step++) {
  const next = await get(`/explore/find${query}`);
  if (next.action === 'report') {
    console.log('FOUND:', JSON.stringify(next.report));
    log('found', next.report);
    process.exit(0);
  }
  if (next.action !== 'move') {
    console.log(`STOP (${next.action}${next.reason ? `: ${next.reason}` : ''})`);
    log('stop', next);
    process.exit(0);
  }
  await post('/plan', { waypoint: next.waypoint });
  const result = await post('/act', { key: 'goto_waypoint' });
  log('move', { step, waypoint: next.waypoint, scan: next.scan ?? null, result });
  console.log(`step ${step}: goto ${JSON.stringify(next.waypoint)} -> ${result.ok ? 'ok' : result.error}`);
}

console.log('MAX_STEPS reached');
process.exit(3);
