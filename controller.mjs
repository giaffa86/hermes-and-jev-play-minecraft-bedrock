// Planner/controller loop for the harness in harness.mjs.
//   Planner ("System Two")   : Hermes Agent, called at milestones through the `hermes` CLI (any provider Hermes is configured for).
//   Controller ("System One"): Jev (TypeSafe) via OpenRouter's decisions endpoint, ONE bounded action per step.
//                              Set CONTROLLER=hermes to let Hermes pick actions too (slower, ~10x the cost).
// The model never sends keypresses or code: it chooses one key from the list the harness says is valid right now.
import {spawn} from 'node:child_process';
import {appendFileSync, mkdirSync} from 'node:fs';

const HARNESS = process.env.HARNESS || 'http://127.0.0.1:3077';
const RUN = process.env.RUN_ID || 'run';
const GOAL = process.env.GOAL || 'Hold at least 4 dirt in inventory and stand within 2 blocks (XZ) of the waypoint.';
const WAYPOINT = process.env.WAYPOINT ? JSON.parse(process.env.WAYPOINT) : null;   // e.g. {"x":380,"z":16}
const TARGETS = process.env.TARGETS ? JSON.parse(process.env.TARGETS) : {dirt: 4}; // item -> min count
const MAX_STEPS = +(process.env.MAX_STEPS || 20);
const CONTROLLER = process.env.CONTROLLER || 'jev';
const JEV_MODEL = process.env.JEV_MODEL || (process.env.TYPESAFE_API_KEY ? 'jev-latest' : 'typesafe/jev-1.13');
const REPLAN_EVERY = +(process.env.REPLAN_EVERY || 8);

mkdirSync(`runs/${RUN}`, {recursive: true});
const log = (type, data) => appendFileSync(`runs/${RUN}/controller.jsonl`, JSON.stringify({t: Date.now(), type, ...data}) + '\n');
const api = async (method, path, body) => {
  const r = await fetch(HARNESS + path, {method, body: body ? JSON.stringify(body) : undefined, headers: {'Content-Type': 'application/json', Connection: 'close'}});
  return r.json();
};

// ---- planner: Hermes ------------------------------------------------------------------------
// `hermes` è uno shim che fork-a il vero processo: uccidere solo il figlio
// diretto lascia il nipote vivo che tiene aperto lo stdout (spawnSync non
// ritorna mai). Spawn detached + kill del process group al timeout, con
// fallback statico se il provider è giù o lento.
const HERMES_TIMEOUT = +(process.env.HERMES_TIMEOUT_MS || 180000);

function runHermes(prompt) {
  return new Promise(resolve => {
    const child = spawn('hermes', ['chat', '-Q', '--oneshot', '-t', '', '-q', prompt],
      {detached: true, stdio: ['ignore', 'pipe', 'ignore']});
    let out = '';
    let done = false;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', () => finish(null));
    child.on('close', () => finish(out || null));
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      finish(null);
    }, HERMES_TIMEOUT);
  });
}

async function hermesPlan(observation) {
  const prompt = [
    'You are the PLANNER for a Minecraft bot. Return ONLY a JSON object {"objective": string, "targets": {item: minCount}, "waypoint": {"x":int,"z":int} | null, "notes": string}.',
    `Overall goal: ${GOAL}`,
    WAYPOINT ? `Required waypoint (keep it unless reached): ${JSON.stringify(WAYPOINT)}` : '',
    `Required targets: ${JSON.stringify(TARGETS)}`,
    'The harness exposes the currently valid actions (typical keys: goto_waypoint, dig_down, mine_<block>, collect_drop, craft_<item>, place_<item>, wait); the controller will pick one of them. Keep the objective to one sentence the controller can act on now.',
    `Observation: ${JSON.stringify(observation)}`,
  ].filter(Boolean).join('\n');
  const started = Date.now();
  const out = await runHermes(prompt);
  if (out == null) {
    const plan = {objective: GOAL, targets: TARGETS, waypoint: WAYPOINT, notes: 'hermes unavailable; static fallback plan'};
    log('plan_fallback', {plan, ms: Date.now() - started});
    return plan;
  }
  const m = out.match(/\{[\s\S]*\}/);
  const plan = m ? JSON.parse(m[0]) : {objective: GOAL, targets: TARGETS, waypoint: WAYPOINT};
  if (WAYPOINT && !plan.waypoint) plan.waypoint = WAYPOINT;
  log('plan', {plan, ms: Date.now() - started});
  return plan;
}

// ---- controller: Jev via TypeSafe or OpenRouter ---------------------------------------------
async function jevDecide(observation, options, plan) {
  const typesafeKey = process.env.TYPESAFE_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const key = typesafeKey || openrouterKey;
  if (!key) throw new Error('TYPESAFE_API_KEY or OPENROUTER_API_KEY is required for CONTROLLER=jev');
  const criteria = Object.fromEntries(options.map((o, i) => [`a${i}`, o.description]));
  const body = {
    model: JEV_MODEL,
    state: JSON.stringify({...observation, recent: observation.recent?.slice(-4)}),
    questions: {action: {type: 'choice', instructions:
      `You control a Minecraft player. Current objective from the planner: ${plan.objective}. Targets: ${JSON.stringify(plan.targets)}. ` +
      'Pick the single action that makes the most progress now. Prefer collecting a nearby drop over mining more; prefer travel once targets are met; wait only if nothing else is useful.',
      criteria}},
  };
  const started = Date.now();
  let data;
  if (typesafeKey) {
    const r = await fetch('https://api.typesafe.ai/v1/systemone', {method: 'POST', headers: {Authorization: `Bearer ${key}`, 'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    data = await r.json();
    if (!r.ok) throw new Error(`TypeSafe error ${r.status}: ${JSON.stringify(data)}`);
  } else {
    const r = await fetch('https://openrouter.ai/api/alpha/decisions', {method: 'POST', headers: {Authorization: `Bearer ${key}`, 'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    data = await r.json();
    if (data.error) throw new Error(JSON.stringify(data.error));
  }
  const ans = data.answers.action;
  const idx = +ans.choice.slice(1);
  log('decision', {controller: 'jev', provider: typesafeKey ? 'typesafe' : 'openrouter', model: data.model, choice: ans.choice, key: options[idx].key, probabilities: ans.probabilities, confidence: ans.confidence, cost: data.usage?.cost, ms: Date.now() - started});
  return options[idx].key;
}

// ---- controller: Hermes (fallback) ------------------------------------------------------------
async function hermesDecide(observation, options, plan) {
  const prompt = `Objective: ${plan.objective}\nObservation: ${JSON.stringify(observation)}\nValid actions:\n${options.map(o => `- ${o.key}: ${o.description}`).join('\n')}\nReply with ONLY the key of the single best action.`;
  const started = Date.now();
  const out = (await runHermes(prompt))?.trim();
  const key = out
    ? (options.find(o => out.includes(o.key))?.key || options.at(-1).key)
    : (options.find(o => o.key === 'wait')?.key || options[0].key);
  log('decision', {controller: 'hermes', key, fallback: out == null, ms: Date.now() - started});
  return key;
}

const goalMet = (obs, plan) => {
  const targets = Object.entries(plan.targets || TARGETS).every(([item, n]) => (obs.inventory[item] || 0) >= n);
  const w = plan.waypoint || WAYPOINT;
  const at = !w || Math.hypot(w.x - obs.position.x, w.z - obs.position.z) <= 2;
  return targets && at;
};

// ---- loop -----------------------------------------------------------------------------------
let obs = await api('GET', '/observe');
let plan = await hermesPlan(obs);
await api('POST', '/plan', plan);
console.log('PLAN', plan.objective, plan.waypoint ? JSON.stringify(plan.waypoint) : '');
let spent = 0;
let lastFailedKey = null;
for (let step = 1; step <= MAX_STEPS; step++) {
  obs = await api('GET', '/observe');
  if (goalMet(obs, plan)) { console.log(`GOAL MET after ${step - 1} actions`, JSON.stringify({position: obs.position, inventory: obs.inventory})); log('goal_met', {steps: step - 1, obs}); break; }
  if (step > 1 && step % REPLAN_EVERY === 1) { plan = await hermesPlan(obs); await api('POST', '/plan', plan); console.log('REPLAN', plan.objective); }
  const {options} = await api('GET', '/options');
  // Non ripetere l'azione che ha appena fallito: il prossimo passo prova altro.
  const usable = lastFailedKey && options.length > 1 ? options.filter(o => o.key !== lastFailedKey) : options;
  const key = CONTROLLER === 'jev' ? await jevDecide(obs, usable, plan) : await hermesDecide(obs, usable, plan);
  const result = await api('POST', '/act', {key});
  lastFailedKey = result.ok ? null : key;
  console.log(`#${step} ${key} ->`, JSON.stringify(result));
  if (step === MAX_STEPS) { console.log('step budget exhausted'); log('budget_exhausted', {steps: step}); }
}
// Le connessioni keep-alive di fetch tengono vivo il processo: esci esplicitamente.
process.exit(0);
