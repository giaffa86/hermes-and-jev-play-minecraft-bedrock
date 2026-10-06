// Autonomous exploration M2 driver — route replay.
//
// Rigioca una rotta *registrata* verso un posto già scoperto: i checkpoint di
// una missione (`MISSION_ID`), un posto del world graph (`PLACE_ID`) o
// coordinate esplicite (`X`/`Z`). Le tappe sono guide: qui si esegue solo il
// movimento bounded, il pathfinding locale rifà ogni tratto.
//
//   RUN_ID=exp-replay PLACE_ID=home node explore-replay.mjs
//   RUN_ID=exp-replay MISSION_ID=mission_find_biome_xyz node explore-replay.mjs
//
import { appendFileSync, mkdirSync } from 'node:fs';

const HARNESS = process.env.HARNESS || 'http://127.0.0.1:3077';
const RUN = process.env.RUN_ID || 'explore-replay';
const MISSION_ID = process.env.MISSION_ID || null;
const PLACE_ID = process.env.PLACE_ID || null;
const X = process.env.X != null ? Number(process.env.X) : null;
const Z = process.env.Z != null ? Number(process.env.Z) : null;
const MAX_STEPS = +(process.env.MAX_STEPS || 200);

const RUN_DIR = runDir(RUN);
mkdirSync(RUN_DIR, { recursive: true });
const log = (type, data) => appendFileSync(`${RUN_DIR}/explore-replay.jsonl`, JSON.stringify({ t: Date.now(), type, ...data }) + '\n');

const post = async (path, payload) => (await fetch(`${HARNESS}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload ?? {}) })).json();
const get = async (path) => (await fetch(`${HARNESS}${path}`)).json();

const body = MISSION_ID ? { missionId: MISSION_ID } : PLACE_ID ? { placeId: PLACE_ID } : { x: X, z: Z };
const started = await post('/explore/replay', body);
if (!started.ok) {
  console.error('cannot start the replay:', started.error, '—', started.hint ?? '');
  process.exit(1);
}
console.log(`replay mission ${started.mission.id} — to ${started.route.label} ${JSON.stringify(started.route.destination)} (${started.route.checkpoints.length} legs)`);
log('start', { mission: started.mission.id, route: started.route });

for (let step = 1; step <= MAX_STEPS; step++) {
  const next = await get('/explore/replay');
  if (next.action === 'arrived') {
    console.log('ARRIVED:', JSON.stringify(next.report));
    log('arrived', next.report);
    process.exit(0);
  }
  if (next.action === 'hold') {
    console.log(`STOP (hold: ${next.reason})`);
    log('stop', next);
    process.exit(0);
  }
  await post('/plan', { waypoint: next.waypoint });
  const result = await post('/act', { key: 'goto_waypoint' });
  log('move', { step, waypoint: next.waypoint, via: next.via ?? null, result });
  console.log(`step ${step}: goto ${JSON.stringify(next.waypoint)}${next.via ? ` via ${next.via}` : ''} -> ${result.ok ? 'ok' : result.error}`);
}

console.log('MAX_STEPS reached');
process.exit(3);
