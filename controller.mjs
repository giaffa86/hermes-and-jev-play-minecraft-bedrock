// Planner/controller loop for the harness in harness.mjs.
//   Planner ("System Two")   : Hermes Agent, called at milestones through the `hermes` CLI (any provider Hermes is configured for).
//   Controller ("System One"): Jev (TypeSafe) via OpenRouter's decisions endpoint, ONE bounded action per step.
//                              Set CONTROLLER=hermes to let Hermes pick actions too (slower, ~10x the cost).
// The model never sends keypresses or code: it chooses one key from the list the harness says is valid right now.
//
// Survival Intelligence Layer (survival/):
//   - the Survival Governor evaluates every observation deterministically;
//   - in emergency it overrides the objective shown to the decision model and
//     the harness restricts /options to the allowed intents (never invents);
//   - the Skill Resolver picks the active declarative gameplay skill (plan
//     field `skill`, governor preference or progression hint) and boosts its
//     intents when options are ranked;
//   - skill success/failure is verified from harness state (verifySkill), and
//     every run appends a line to runs/<run>/skills.jsonl.
// With CURRICULUM=<milestone> the progression engine picks the next missing
// prerequisite on its own (knowledge/progression.json); Hermes is used only
// when the engine cannot decide.
import {spawn} from 'node:child_process';
import {appendFileSync, mkdirSync} from 'node:fs';
import {
  buildCriteria, buildDecisionInstructions, detectRepeatedAction, filterOptions,
  progressFingerprint, waitOnlyReason, DEFAULT_ANTI_LOOP_THRESHOLD, DEFAULT_MAX_OPTIONS,
} from './controller-decisions.mjs';
import {
  evaluateSurvival, loadSurvivalRules, loadGameplaySkills, loadProgression,
  resolveMilestone, resolveActiveSkill, skillPreferredIntents, verifySkill, buildSkillRecord, appendSkillRecord,
} from './survival/index.mjs';

const HARNESS = process.env.HARNESS || 'http://127.0.0.1:3077';
const RUN = process.env.RUN_ID || 'run';
const CURRICULUM = process.env.CURRICULUM || null; // es. first_night, enter_nether
const GOAL = process.env.GOAL || (CURRICULUM
  ? `Progress the Survival tech tree until the "${CURRICULUM}" milestone is complete.`
  : 'Hold at least 4 dirt in inventory and stand within 2 blocks (XZ) of the waypoint.');
const WAYPOINT = process.env.WAYPOINT ? JSON.parse(process.env.WAYPOINT) : null;   // e.g. {"x":380,"z":16}
const TARGETS = process.env.TARGETS ? JSON.parse(process.env.TARGETS) : {dirt: 4}; // item -> min count
const MAX_STEPS = +(process.env.MAX_STEPS || 20);
const CONTROLLER = process.env.CONTROLLER || 'jev';
const JEV_MODEL = process.env.JEV_MODEL || (process.env.TYPESAFE_API_KEY ? 'jev-latest' : 'typesafe/jev-1.13');
const REPLAN_EVERY = +(process.env.REPLAN_EVERY || 8);
// Diagnostica/anti-loop (0 disabilita il tetto; soglia in azioni consecutive).
const MAX_OPTIONS = process.env.MAX_OPTIONS == null ? DEFAULT_MAX_OPTIONS : +(process.env.MAX_OPTIONS);
const ANTI_LOOP_THRESHOLD = +(process.env.ANTI_LOOP_THRESHOLD || DEFAULT_ANTI_LOOP_THRESHOLD);
const ANTI_LOOP_COOLDOWN = +(process.env.ANTI_LOOP_COOLDOWN || 3);
// Comando umano via chat (M1-M3): attivo solo se CHAT_ALLOWLIST è valorizzato
// (gamertag/xuid separati da virgola). CHAT_PREFIX è il prefisso che scatena l'ordine.
const CHAT_CONTROL = process.env.CHAT_CONTROL || (process.env.CHAT_ALLOWLIST ? 'on' : 'off');
const CHAT_ALLOWLIST = new Set((process.env.CHAT_ALLOWLIST || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const CHAT_PREFIX = (process.env.CHAT_PREFIX || '@bot').toLowerCase();
const humanCommandSeen = new Set(); // dedup: un comando già eseguito non si ripete

mkdirSync(`runs/${RUN}`, {recursive: true});
const SKILLS_LOG = `runs/${RUN}/skills.jsonl`;
const log = (type, data) => appendFileSync(`runs/${RUN}/controller.jsonl`, JSON.stringify({t: Date.now(), type, ...data}) + '\n');
const api = async (method, path, body) => {
  const r = await fetch(HARNESS + path, {method, body: body ? JSON.stringify(body) : undefined, headers: {'Content-Type': 'application/json', Connection: 'close'}});
  return r.json();
};

// ---- Survival Intelligence Layer ------------------------------------------------------------
// Caricati e validati all'avvio: un file rotto deve fallire prima del primo passo.
const survivalRules = await loadSurvivalRules(new URL('./knowledge/survival-rules.json', import.meta.url));
const gameplaySkills = loadGameplaySkills();
const progressionGraph = await loadProgression(new URL('./knowledge/progression.json', import.meta.url));

const completedMilestones = new Set();   // verificati davvero in questa sessione
let skillRun = null;                     // {id, def, milestone, startedAt, startObservation, actions, sawNight}

function milestoneForSkill (skillId) {
  for (const [id, node] of Object.entries(progressionGraph.milestones)) {
    if (node.skill === skillId) return id;
  }
  return null;
}

function startSkillRun (plan, observation) {
  if (!plan?.skill) return null;
  const def = gameplaySkills.get(plan.skill);
  if (!def) return null;
  return {
    id: plan.skill,
    def,
    milestone: plan.milestone || milestoneForSkill(plan.skill),
    startedAt: Date.now(),
    startObservation: observation,
    actions: 0,
    sawNight: observation?.time?.night === true,
  };
}

// Piano deterministico da un risultato del progression engine.
function planFromMilestone (result) {
  if (result?.status !== 'next' || !result.skill) return null;
  const def = gameplaySkills.get(result.skill);
  return {
    objective: def?.description || `Complete the "${result.milestone}" milestone.`,
    skill: result.skill,
    milestone: result.milestone,
    targets: def?.planTargets && Object.keys(def.planTargets).length ? def.planTargets : {},
    waypoint: WAYPOINT,
    priority: 'progression',
    notes: `curriculum:${result.milestone}`,
  };
}

function nextMilestone (observation) {
  return resolveMilestone(progressionGraph, {goal: CURRICULUM, observation, completed: completedMilestones});
}

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
  const skillList = [...gameplaySkills.keys()].join(', ');
  const curriculumHint = CURRICULUM ? nextMilestone(observation) : null;
  const prompt = [
    'You are the PLANNER for a Minecraft bot. Return ONLY a JSON object {"objective": string, "targets": {item: minCount}, "waypoint": {"x":int,"z":int} | null, "skill": string | null, "notes": string}.',
    `Overall goal: ${GOAL}`,
    CURRICULUM ? `Overall progression milestone: ${CURRICULUM} (the progression engine verifies it deterministically)` : '',
    curriculumHint?.status === 'next' ? `Suggested next milestone from the progression engine: ${curriculumHint.milestone} (skill "${curriculumHint.skill}"). Use it unless the observation clearly calls for something else.` : '',
    WAYPOINT ? `Required waypoint (keep it unless reached): ${JSON.stringify(WAYPOINT)}` : '',
    `Required targets: ${JSON.stringify(TARGETS)}`,
    `Optional "skill" field, one of the declarative gameplay skills: ${skillList}. Use it when the objective matches one of them; it is verified against harness state, not by you.`,
    'The harness exposes the currently valid actions (typical keys: goto_waypoint, dig_down, mine_<block>, collect_drop, craft_<item>, place_<item>, eat, flee, sleep, wait); the controller will pick one of them. Keep the objective to one sentence the controller can act on now.',
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

// In modalità curriculum il piano è deterministico; Hermes resta il fallback
// per gli errori del motore e per le situazioni ambigue.
async function planForStep (observation, reason) {
  if (CURRICULUM) {
    const milestone = nextMilestone(observation);
    if (milestone.status === 'met') return {met: true};
    const plan = planFromMilestone(milestone);
    if (plan) {
      log('plan', {plan, ms: 0, curriculum: true, reason});
      return plan;
    }
    log('curriculum_fallback', {reason, milestone});
  }
  return hermesPlan(observation);
}

// ---- comando umano via chat (M1-M3) ---------------------------------------------------------
function isAllowedSender (entry) {
  if (!CHAT_ALLOWLIST.size) return false;
  if (entry.from && CHAT_ALLOWLIST.has(entry.from.toLowerCase())) return true;
  if (entry.xuid && CHAT_ALLOWLIST.has(entry.xuid)) return true;
  return false;
}

// Traduce un comando umano in linguaggio naturale in un piano (come hermesPlan,
// ma con il contesto del mittente: gamertag e posizione viva). Hermes è il
// traduttore; il fallback deterministico è "seguire il mittente".
async function humanCommandPlan (obs, entry) {
  const sender = (obs.entities || []).find(e => e.kind === 'player' && e.username && e.username.toLowerCase() === (entry.from || '').toLowerCase());
  const senderPos = sender?.position ?? null;
  const prompt = [
    'You are the PLANNER for a Minecraft bot. A TRUSTED human player sent you a command in chat. Return ONLY a JSON object {"objective": string, "targets": {item: minCount}, "waypoint": {"x":int,"z":int} | null, "follow": string | null, "notes": string}.',
    `The human (gamertag "${entry.from}") said: "${entry.message}".`,
    senderPos
      ? `The human is currently at ${JSON.stringify(senderPos)}. If they ask you to follow, stay near, or escort them, set "follow" to "${entry.from}" (exact gamertag) and set "waypoint" to their current XZ position.`
      : 'The human position is not visible right now; if they ask you to follow, still set "follow" to their gamertag.',
    'If they ask you to help fight mobs, set the objective to stay near them and attack nearby hostile mobs (keep "follow" set if escorting).',
    'If they ask you to gather or mine a specific item, put it in "targets". If they ask you to stop or resume autonomy, set "objective" accordingly and leave "follow" null.',
    'Keep the objective to one sentence. The controller picks bounded actions from the harness; never invent action keys.',
    `Current state: ${JSON.stringify(obs)}`,
  ].join('\n');
  const started = Date.now();
  const out = await runHermes(prompt);
  const fallback = (note) => ({
    objective: `Follow ${entry.from} and obey their last order: "${entry.message}"`,
    targets: {},
    waypoint: senderPos ? { x: Math.round(senderPos.x), z: Math.round(senderPos.z) } : null,
    follow: entry.from,
    notes: `human:${entry.from} ${note}`,
  });
  if (out == null) { log('plan_fallback', {plan: fallback('hermes unavailable'), ms: Date.now() - started, source: 'human'}); return fallback('hermes unavailable'); }
  const m = out.match(/\{[\s\S]*\}/);
  let plan = null;
  try { plan = m ? JSON.parse(m[0]) : null; } catch { plan = null; }
  if (!plan || typeof plan !== 'object' || typeof plan.objective !== 'string') {
    log('plan_fallback', {plan: fallback('parse'), ms: Date.now() - started, source: 'human'});
    return fallback('parse');
  }
  if (plan.follow == null && /follow|stay near|come with|escort|seguimi|accompagn/i.test(entry.message)) plan.follow = entry.from;
  plan.notes = `human:${entry.from} ${plan.notes || ''}`.trim();
  log('plan', {plan, ms: Date.now() - started, source: 'human'});
  return plan;
}

// Cerca nell'ultima osservazione un nuovo comando umano valido. Restituisce
// {plan, entry} oppure null. Dedup per non rieseguire lo stesso messaggio.
async function maybeHumanCommand (obs) {
  if (CHAT_CONTROL === 'off' || !CHAT_ALLOWLIST.size) return null;
  const chat = obs.chat || [];
  for (let i = chat.length - 1; i >= 0; i--) {
    const entry = chat[i];
    const text = String(entry.message || '').trim();
    if (!text.toLowerCase().startsWith(CHAT_PREFIX)) continue;
    if (!isAllowedSender(entry)) {
      log('chat_ignored', {from: entry.from, xuid: entry.xuid, reason: 'not_allowed'});
      continue;
    }
    const message = text.slice(CHAT_PREFIX.length).trim();
    if (!message) continue;
    const seenKey = `${entry.at}|${entry.from}|${message}`;
    if (humanCommandSeen.has(seenKey)) continue;
    humanCommandSeen.add(seenKey);
    log('chat_command', {from: entry.from, xuid: entry.xuid, message});
    const plan = await humanCommandPlan(obs, {...entry, message});
    return {plan, entry: {...entry, message}};
  }
  return null;
}

// ---- controller: Jev via TypeSafe or OpenRouter ---------------------------------------------
async function jevDecide(observation, options, plan) {
  const typesafeKey = process.env.TYPESAFE_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const key = typesafeKey || openrouterKey;
  if (!key) throw new Error('TYPESAFE_API_KEY or OPENROUTER_API_KEY is required for CONTROLLER=jev');
  const criteria = buildCriteria(options);
  const body = {
    model: JEV_MODEL,
    state: JSON.stringify({...observation, plan: observation.plan ?? plan, recent: observation.recent?.slice(-4)}),
    questions: {action: {type: 'choice', instructions: buildDecisionInstructions(plan), criteria}},
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
  const chosen = options[idx];
  if (!chosen) throw new Error(`decision model chose unknown option ${ans.choice}`);
  const probabilities = ans.probabilities || {};
  const probabilityOf = (choice) => probabilities[choice] ?? (Array.isArray(probabilities) ? probabilities[+choice.slice(1)] : null);
  // Diagnostica: probabilità per key candidata (non solo per indice) e scelta.
  const candidates = options
    .map((o, i) => ({key: o.key, choice: `a${i}`, p: probabilityOf(`a${i}`)}))
    .sort((a, b) => (b.p ?? -1) - (a.p ?? -1));
  log('decision', {
    controller: 'jev', provider: typesafeKey ? 'typesafe' : 'openrouter', model: data.model,
    choice: ans.choice, key: chosen.key, probabilities, confidence: ans.confidence,
    cost: data.usage?.cost, ms: Date.now() - started, candidates,
    selectedProbability: probabilityOf(ans.choice), optionsCount: options.length, objective: plan.objective,
  });
  return {key: chosen.key, cost: data.usage?.cost ?? null};
}

// ---- controller: Hermes (fallback) ------------------------------------------------------------
async function hermesDecide(observation, options, plan) {
  const prompt = `Objective: ${plan.objective}\nObservation: ${JSON.stringify(observation)}\nValid actions:\n${options.map(o => `- ${o.key}: ${o.description}`).join('\n')}\nReply with ONLY the key of the single best action.`;
  const started = Date.now();
  const out = (await runHermes(prompt))?.trim();
  const key = out
    ? (options.find(o => out.includes(o.key))?.key || options.at(-1).key)
    : (options.find(o => o.key === 'wait')?.key || options[0].key);
  log('decision', {controller: 'hermes', key, fallback: out == null, ms: Date.now() - started, optionsCount: options.length, objective: plan.objective});
  return {key, cost: null};
}

// ---- loop -----------------------------------------------------------------------------------
const goalMet = (obs, plan, skillStatus) => {
  // I piani "seguimi" sono aperti: terminano solo con un nuovo ordine o a fine
  // budget, mai da soli (non hanno target/waypoint terminali).
  if (plan.follow) return false;
  const targetMap = plan.targets && Object.keys(plan.targets).length ? plan.targets : TARGETS;
  const targets = Object.entries(targetMap).every(([item, n]) => (obs.inventory[item] || 0) >= n);
  const w = plan.waypoint || WAYPOINT;
  const at = !w || Math.hypot(w.x - obs.position.x, w.z - obs.position.z) <= 2;
  if (plan.skill && skillRun?.id === plan.skill) {
    // Con una skill dichiarata e verificabile il successo lo decide il
    // verifier, non i target. In modalità curriculum l'avanzamento lo gestisce
    // il progression engine. Una skill sconosciuta (skillRun null) ricade sui
    // target, così un refuso del planner non blocca il goal.
    if (CURRICULUM) return false;
    return targets && at && skillStatus?.status === 'success';
  }
  return targets && at;
};

let obs = await api('GET', '/observe');
let initialPlan = await planForStep(obs, 'start');
if (initialPlan?.met) {
  console.log('CURRICULUM GOAL already met');
  log('goal_met', {steps: 0, curriculum: CURRICULUM});
  process.exit(0);
}
let plan = initialPlan;
await api('POST', '/plan', plan);
skillRun = startSkillRun(plan, obs);
console.log('PLAN', plan.objective, plan.waypoint ? JSON.stringify(plan.waypoint) : '', plan.skill ? `[skill ${plan.skill}]` : '');
let history = [];              // [{key, stagnant}] per l'anti-loop
const cooldowns = new Map();   // key -> primo step in cui torna proponibile
let lastKey = null;            // ultima azione eseguita
let lastFailedKey = null;
let chosenFingerprint = null;  // fingerprint dell'osservazione al momento della scelta
let lastSurvivalFingerprint = null;
let totalCost = 0;
let goalReached = false;
for (let step = 1; step <= MAX_STEPS; step++) {
  obs = await api('GET', '/observe');
  // Comando umano via chat (M3): priorità sul piano autonomo finché non arriva
  // un nuovo ordine. Il governor resta comunque l'ultima parola sulle opzioni.
  const humanCmd = await maybeHumanCommand(obs);
  if (humanCmd) {
    plan = humanCmd.plan;
    await api('POST', '/plan', plan);
    skillRun = null; // il piano umano sostituisce la skill attiva
    console.log('HUMAN ORDER', humanCmd.entry.from, '->', plan.objective, plan.follow ? `[follow ${plan.follow}]` : '');
    log('human_order', {from: humanCmd.entry.from, xuid: humanCmd.entry.xuid, plan});
  }
  const governor = evaluateSurvival(obs, {rules: survivalRules});
  const survivalFingerprint = `${governor.mode}|${governor.rule}|${governor.reasons.join(',')}`;
  if (survivalFingerprint !== lastSurvivalFingerprint) {
    log('survival', {mode: governor.mode, rule: governor.rule, priority: governor.priority, risk: governor.risk.score, level: governor.risk.level, needs: governor.needs, reasons: governor.reasons, overrideObjective: governor.overrideObjective});
    lastSurvivalFingerprint = survivalFingerprint;
  }

  // --- verifica deterministica della skill attiva -----------------------------
  let skillStatus = null;
  let replanReason = null;
  if (skillRun) {
    skillRun.sawNight = skillRun.sawNight || obs.time?.night === true;
    skillStatus = verifySkill(skillRun.def, skillRun.startObservation, obs, {context: {sawNight: skillRun.sawNight}});
    if (skillStatus.status === 'success' || skillStatus.status === 'failed') {
      const record = buildSkillRecord({
        skill: skillRun.id, status: skillStatus.status, actions: skillRun.actions,
        startedAt: skillRun.startedAt, failureReason: skillStatus.reason,
        context: {milestone: skillRun.milestone, evidence: skillStatus.evidence},
      });
      await appendSkillRecord(SKILLS_LOG, record);
      log(skillStatus.status === 'success' ? 'skill_success' : 'skill_failed', {...record, evidence: skillStatus.evidence});
      console.log(skillStatus.status === 'success'
        ? `SKILL ${skillRun.id} SUCCESS ${JSON.stringify(skillStatus.evidence)}`
        : `SKILL ${skillRun.id} FAILED (${skillStatus.reason})`);
      const finished = skillRun;
      skillRun = null;
      if (skillStatus.status === 'success') {
        if (finished.milestone) completedMilestones.add(finished.milestone);
        if (CURRICULUM && finished.milestone === CURRICULUM) {
          console.log(`GOAL MET after ${step - 1} actions (curriculum ${CURRICULUM})`);
          log('goal_met', {steps: step - 1, totalCost, curriculum: CURRICULUM, completedMilestones: [...completedMilestones]});
          goalReached = true;
          break;
        }
        replanReason = CURRICULUM ? 'curriculum' : 'skill_complete';
      } else {
        replanReason = 'skill_failed';
      }
      obs.skillResult = {skill: finished.id, status: skillStatus.status, evidence: skillStatus.evidence};
    }
  }
  if (goalMet(obs, plan, skillStatus)) {
    console.log(`GOAL MET after ${step - 1} actions`, JSON.stringify({position: obs.position, inventory: obs.inventory}));
    log('goal_met', {steps: step - 1, totalCost, obs});
    goalReached = true;
    break;
  }

  // Esito dell'azione precedente: senza progresso (posizione, inventario e
  // obiettivo invariati) alimenta l'anti-loop.
  if (lastKey) {
    const fingerprint = progressFingerprint(obs, plan);
    const stagnant = chosenFingerprint != null && fingerprint === chosenFingerprint;
    history.push({key: lastKey, stagnant, at: Date.now()});
    if (history.length > 40) history.shift();
    const repeated = detectRepeatedAction(history, lastKey, {threshold: ANTI_LOOP_THRESHOLD});
    if (stagnant) log('no_progress', {step: step - 1, key: lastKey, streak: repeated.count});
    if (repeated.repeated) {
      cooldowns.set(lastKey, step + ANTI_LOOP_COOLDOWN);
      replanReason = replanReason || `anti_loop:${lastKey}:${repeated.count}`;
      log('anti_loop', {step, key: lastKey, streak: repeated.count, cooldownUntilStep: step + ANTI_LOOP_COOLDOWN});
      console.log(`ANTI-LOOP ${lastKey} x${repeated.count}: replan + exclude until step ${step + ANTI_LOOP_COOLDOWN}`);
    }
  }
  if (!replanReason && step > 1 && step % REPLAN_EVERY === 1) replanReason = 'periodic';
  if (replanReason) {
    const candidatePlan = await planForStep(obs, replanReason);
    if (candidatePlan?.met) { log('curriculum_goal_met', {step, reason: replanReason}); goalReached = true; break; }
    const sameSkill = candidatePlan?.skill && candidatePlan.skill === plan.skill;
    plan = candidatePlan;
    await api('POST', '/plan', plan);
    if (!sameSkill || !skillRun) skillRun = startSkillRun(plan, obs);
    log('replan', {step, reason: replanReason, objective: plan.objective, skill: plan.skill ?? null, milestone: plan.milestone ?? null});
    console.log('REPLAN', replanReason, plan.objective, plan.skill ? `[skill ${plan.skill}]` : '');
  }

  // Skill attiva per ranking e indicazioni di decisione: in emergenza vince il
  // governor, poi il campo `skill` del plan, poi il milestone suggerito.
  const milestoneHint = CURRICULUM ? nextMilestone(obs) : null;
  const active = resolveActiveSkill({skills: gameplaySkills, plan, governor, milestone: milestoneHint, observation: obs});
  const preferredIntents = skillPreferredIntents(active.skill);
  const {options} = await api('GET', '/options');
  // Quando il harness offre solo `wait` lo stato va spiegato nei log: non è una
  // scelta di Jev ma l'unica azione valida (riconnessione, morte, sonno, ...).
  if (options.length === 1 && options[0].key === 'wait') {
    log('wait_only', {step, reason: waitOnlyReason(obs)});
  }
  // Cosa proporre a Jev: esclusioni esplicite (fallimento, cooldown anti-loop),
  // tetto di rilevanza e boost degli intenti della skill attiva. Il harness
  // resta l'unico proprietario della validità.
  const excludeKeys = [];
  if (lastFailedKey) excludeKeys.push({key: lastFailedKey, reason: 'failed'});
  for (const [key, until] of cooldowns) {
    if (until > step) excludeKeys.push({key, reason: `anti_loop_until_${until}`});
    else cooldowns.delete(key);
  }
  const filtered = filterOptions(options, history, {max: MAX_OPTIONS, threshold: ANTI_LOOP_THRESHOLD, targets: plan.targets, preferredIntents, excludeKeys});
  log('options', {
    step, offered: options.map(o => o.key), passed: filtered.options.map(o => o.key),
    excluded: filtered.excluded, droppedByCap: filtered.dropped.map(o => o.key),
    note: filtered.note ?? null, fallback: filtered.fallback ?? null,
    skill: active.skill?.id ?? null, skillSource: active.source, preferredIntents,
  });
  // Dopo una morte l'obiettivo immediato è recuperare loot ed EXP al sito.
  // In emergenza il governor vince su tutto: l'obiettivo mostrato al modello
  // diventa la necessità survival corrente (drop e progressi restano nel plan).
  let decisionPlan = plan;
  if (governor.mode !== 'normal' && governor.overrideObjective) {
    decisionPlan = {
      ...plan,
      objective: governor.overrideObjective,
      priority: 'survival',
      source: `governor:${governor.rule ?? governor.mode}`,
      skill: active.source === 'governor' ? active.skill?.id ?? plan.skill : plan.skill,
    };
  } else if (obs.deathSite && !obs.dead) {
    decisionPlan = { ...plan, objective: `Recover the dropped items and XP at the death site ${JSON.stringify(obs.deathSite.position)}: choose recover_loot until no loot is left nearby, then resume the previous objective.` };
  }
  const decision = CONTROLLER === 'jev' ? await jevDecide(obs, filtered.options, decisionPlan) : await hermesDecide(obs, filtered.options, decisionPlan);
  const key = decision.key;
  if (typeof decision.cost === 'number') totalCost += decision.cost;
  chosenFingerprint = progressFingerprint(obs, plan);
  const result = await api('POST', '/act', {key});
  if (skillRun) skillRun.actions += 1;
  lastFailedKey = result.ok ? null : key;
  lastKey = key;
  log('result', {step, key, ok: !!result.ok, error: result.error ?? null, ms: result.ms ?? null});
  console.log(`#${step} ${key} ->`, JSON.stringify(result));
  if (step === MAX_STEPS) { console.log('step budget exhausted'); log('budget_exhausted', {steps: step, totalCost}); }
}
if (!goalReached) {
  log('run_end', {steps: MAX_STEPS, totalCost, curriculum: CURRICULUM, completedMilestones: [...completedMilestones]});
}
// Le connessioni keep-alive di fetch tengono vivo il processo: esci esplicitamente.
process.exit(0);
