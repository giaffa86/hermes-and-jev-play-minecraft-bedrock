// Hermes Minecraft harness: flying-squid server (pure Node, no Java) + one Mineflayer bot +
// a bounded-action HTTP API in the spirit of rmalde/minecraft-agent's planner/controller split (own implementation).
//   GET  /observe  -> compact structured observation (position, health, inventory, nearby blocks, drops, recent)
//   GET  /options  -> the bounded actions the harness judges VALID right now (key + description)
//   POST /act {key, objective?} -> execute one action, return its result
//   POST /plan {objective, waypoint, targets} -> record the planner's current plan (shown in /observe)
// The controller (Hermes / Jev) never sends raw keypresses or free-form code — it picks one key.
import {createServer} from 'node:http';
import {appendFileSync, mkdirSync} from 'node:fs';
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';
import {Vec3} from 'vec3';
import flyingSquid from 'flying-squid';

const {pathfinder, Movements, goals} = pf;
const VERSION = '1.16.5', MC_PORT = +(process.env.MC_PORT || 25599), API_PORT = +(process.env.API_PORT || 3077), RUN = process.env.RUN_ID || 'run';
mkdirSync(`runs/${RUN}`, {recursive: true});
// Il nome dell'evento resta in `type`: il payload può portare un `type` che
// altrimenti lo sovrascriverebbe.
const log = (type, data) => appendFileSync(`runs/${RUN}/events.jsonl`, JSON.stringify({t: Date.now(), ...data, type}) + '\n');

// ---- server -------------------------------------------------------------------------------
import {readFileSync} from 'node:fs';
let defaults;
try {
  defaults = JSON.parse(readFileSync(new URL('./node_modules/flying-squid/config/default-settings.json', import.meta.url)));
} catch (error) {
  console.error(`harness: cannot load flying-squid default settings (run npm install first): ${error.message}`);
  process.exit(1);
}
const serv = flyingSquid.createMCServer({
  ...defaults, 'online-mode': false, port: MC_PORT, version: VERSION, gameMode: 0, difficulty: 0, logging: false,
  'view-distance': 6, worldFolder: `runs/${RUN}/world`, generation: {name: 'diamond_square', options: {worldHeight: 80, seed: 424242}},
});
await new Promise(r => serv.on('listening', r));
console.log('server listening', MC_PORT);

// ---- bot ----------------------------------------------------------------------------------
// flying-squid emits 'listening' before it accepts logins; retry the join until spawn.
let bot;
for (let attempt = 0; ; attempt++) {
  await new Promise(r => setTimeout(r, 3000));
  bot = mineflayer.createBot({host: '127.0.0.1', port: MC_PORT, username: 'hermes', version: VERSION});
  bot.loadPlugin(pathfinder);
  const spawned = await new Promise(r => { bot.once('spawn', () => r(true)); bot.once('end', () => r(false)); bot.once('kicked', () => r(false)); });
  if (spawned) break;
  if (attempt > 8) throw new Error('bot could not join');
}
const moves = new Movements(bot);
moves.canDig = true; moves.allow1by1towers = true; moves.scafoldingBlocks = [];
bot.pathfinder.setMovements(moves);
await bot.waitForChunksToLoad();
console.log('bot spawned at', bot.entity.position.floored());

const recent = [];
let plan = null, busy = false, steps = 0;
const push = (entry) => { recent.push(entry); if (recent.length > 8) recent.shift(); };

const pos = () => bot.entity.position.floored();
const inventory = () => Object.fromEntries(bot.inventory.items().map(i => [i.name, (0) + i.count]).reduce((m, [n, c]) => (m.set(n, (m.get(n) || 0) + c), m), new Map()));
const drops = () => Object.values(bot.entities).filter(e => e.name === 'item' && e.position.distanceTo(bot.entity.position) < 24)
  .map(e => ({id: e.id, distance: +e.position.distanceTo(bot.entity.position).toFixed(1), position: e.position.floored()}));
const nearestBlock = (names, max = 16) => bot.findBlock({matching: b => names.includes(b.name), maxDistance: max, count: 1});

function observe() {
  const p = pos();
  const below = bot.blockAt(p.offset(0, -1, 0));
  return {
    step: steps, position: p, health: bot.health, food: bot.food, dimension: 'overworld', standingOn: below?.name,
    inventory: inventory(), drops: drops(), plan,
    nearby: Object.fromEntries(['dirt', 'stone', 'grass_block', 'sand', 'water'].map(n => {
      const b = nearestBlock([n], 12); return [n, b ? {distance: +b.position.distanceTo(bot.entity.position).toFixed(1), position: b.position} : null];
    })),
    recent,
  };
}

// Bounded actions. Validity is decided HERE (harness), not by the model — the repo's key design choice.
function options() {
  const o = [];
  const inv = inventory(), d = drops();
  if (plan?.waypoint && Math.hypot(plan.waypoint.x - pos().x, plan.waypoint.z - pos().z) > 2)
    o.push({key: 'goto_waypoint', description: `Pathfind to the planner waypoint ${JSON.stringify(plan.waypoint)} (${Math.hypot(plan.waypoint.x - pos().x, plan.waypoint.z - pos().z).toFixed(0)} blocks away)`});
  // Harness-owned validity: once the planner's targets are satisfied, mining is no longer offered at all
  // (a controller that is only shown useful moves cannot over-mine — the fix lives here, not in a longer prompt).
  const targetsMet = plan?.targets && Object.entries(plan.targets).every(([item, n]) => (inv[item] || 0) >= n);
  for (const name of ['dirt', 'stone', 'sand']) {
    const b = nearestBlock([name], 8);
    const wanted = !plan?.targets || (plan.targets[name] && (inv[name] || 0) < plan.targets[name]);
    if (b && !d.length && !targetsMet && wanted) o.push({key: `mine_${name}`, description: `Mine one ${name} block at ${JSON.stringify(b.position)} (${b.position.distanceTo(bot.entity.position).toFixed(1)} away); its drop appears nearby`});
  }
  if (d.length) o.push({key: 'collect_drop', description: `Walk onto the nearest dropped item (${d[0].distance} blocks away) to pick it up`});
  // 'wait' is only offered when nothing useful exists (same filter the original project converged on).
  if (!o.length) o.push({key: 'wait', description: 'Wait 2 seconds for fresh observations'});
  return o;
}

async function act(key) {
  if (busy) return {ok: false, error: 'busy'};
  busy = true; steps++;
  const started = Date.now(); let result;
  try {
    if (key === 'goto_waypoint' && plan?.waypoint) {
      const w = plan.waypoint;
      await Promise.race([bot.pathfinder.goto(new goals.GoalNearXZ(w.x, w.z, 1)), new Promise((_, rej) => setTimeout(() => rej(new Error('travel timeout 45s')), 45000))]);
      result = {ok: true, position: pos()};
    } else if (key.startsWith('mine_')) {
      const b = nearestBlock([key.slice(5)], 8);
      if (!b) throw new Error('block no longer nearby');
      if (b.position.distanceTo(bot.entity.position) > 4.5) await bot.pathfinder.goto(new goals.GoalNear(b.position.x, b.position.y, b.position.z, 3));
      await bot.dig(b, true);
      await new Promise(r => setTimeout(r, 600));
      result = {ok: true, mined: b.name, drops: drops().length};
    } else if (key === 'collect_drop') {
      const d = drops()[0]; if (!d) throw new Error('no drop nearby');
      const before = bot.inventory.items().reduce((n, i) => n + i.count, 0);
      await Promise.race([bot.pathfinder.goto(new goals.GoalBlock(d.position.x, d.position.y, d.position.z)), new Promise((_, rej) => setTimeout(() => rej(new Error('collect timeout 20s')), 20000))]);
      await new Promise(r => setTimeout(r, 800));
      const after = bot.inventory.items().reduce((n, i) => n + i.count, 0);
      result = {ok: after > before, picked: after - before, inventory: inventory()};
    } else if (key === 'wait') {
      await new Promise(r => setTimeout(r, 2000)); result = {ok: true};
    } else throw new Error(`unknown or currently invalid action ${key}`);
  } catch (e) { bot.pathfinder.stop(); result = {ok: false, error: e.message}; }
  finally { busy = false; }
  const entry = {action: key, result, position: pos(), ms: Date.now() - started};
  push(entry); log('action', {step: steps, ...entry});
  return result;
}

createServer(async (req, res) => {
  const body = await new Promise(r => { let s = ''; req.on('data', c => s += c); req.on('end', () => r(s)); });
  const send = (code, obj) => { res.writeHead(code, {'Content-Type': 'application/json'}); res.end(JSON.stringify(obj)); };
  try {
    if (req.method === 'GET' && req.url === '/observe') return send(200, observe());
    if (req.method === 'GET' && req.url === '/options') return send(200, {options: options()});
    if (req.method === 'POST' && req.url === '/plan') { plan = JSON.parse(body); log('plan', {plan}); return send(200, {ok: true, plan}); }
    if (req.method === 'POST' && req.url === '/act') { const {key} = JSON.parse(body); log('decision', {step: steps + 1, key}); return send(200, await act(key)); }
    send(404, {error: 'unknown route'});
  } catch (e) { send(500, {error: e.message}); }
}).listen(API_PORT, '127.0.0.1', () => console.log('harness api on', API_PORT)).keepAliveTimeout = 0;
