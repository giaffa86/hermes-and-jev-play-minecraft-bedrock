// Autonomous exploration M1 driver.
//
// Ciclo deterministico: il planner nel harness decide il prossimo waypoint
// (spirale su chunk inesplorati) o dichiara FOUND; qui si esegue solo il
// movimento bounded. L'LLM non è nel loop.
//
//   RUN_ID=exp TARGET='Trova un Cherry Grove' node explore.mjs
//
import { appendFileSync, mkdirSync } from 'node:fs';

const HARNESS = process.env.HARNESS || 'http://127.0.0.1:3077';
const RUN = process.env.RUN_ID || 'explore';
const TARGET = process.env.TARGET || process.env.GOAL || 'cherry grove';
const MAX_STEPS = +(process.env.MAX_STEPS || 200);

mkdirSync(`runs/${RUN}`, { recursive: true });
const log = (type, data) => appendFileSync(`runs/${RUN}/explore.jsonl`, JSON.stringify({ t: Date.now(), type, ...data }) + '\n');

const post = async (path, payload) => (await fetch(`${HARNESS}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload ?? {}) })).json();
const get = async (path) => (await fetch(`${HARNESS}${path}`)).json();

const started = await post('/explore', { target: TARGET });
if (!started.ok) {
  console.error('cannot start exploration:', started.error, '— supported:', started.supported);
  process.exit(1);
}
console.log(`exploration mission ${started.mission.id} — target ${started.mission.target}`);
log('start', { mission: started.mission.id, target: started.mission.target });

for (let step = 1; step <= MAX_STEPS; step++) {
  const next = await get('/explore');
  if (next.action === 'found') {
    console.log('FOUND:', JSON.stringify(next.report));
    log('found', next.report);
    process.exit(0);
  }
  if (next.action === 'exhausted' || next.action === 'hold') {
    console.log(`STOP (${next.action}${next.reason ? `: ${next.reason}` : ''})`);
    log('stop', next);
    process.exit(next.action === 'exhausted' ? 2 : 0);
  }
  await post('/plan', { waypoint: next.waypoint });
  const result = await post('/act', { key: 'goto_waypoint' });
  log('move', { step, waypoint: next.waypoint, result });
  console.log(`step ${step}: goto ${JSON.stringify(next.waypoint)} -> ${result.ok ? 'ok' : result.error}`);
}

console.log('MAX_STEPS reached');
process.exit(3);
