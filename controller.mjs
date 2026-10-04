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
import {setTimeout as delay} from 'node:timers/promises';
import {createGoalManager, GOAL_SOURCE, GOAL_STATUS} from './goal-manager.mjs';
import {JsonMemoryRepository} from './memory-store.mjs';
import {nextIdleGoal, isNeedResolved, DEFAULT_AUTONOMY_COOLDOWN_MS, DEFAULT_MAX_AUTONOMOUS_GOALS} from './idle-goals.mjs';
import {detectEvents} from './world-events.mjs';
import {emergencyGoalFor, DEFAULT_EMERGENCY_COOLDOWN_MS} from './emergency-goals.mjs';
import {
  buildCriteria, buildDecisionInstructions, detectRepeatedAction, filterOptions,
  progressFingerprint, waitOnlyReason, DEFAULT_ANTI_LOOP_THRESHOLD, DEFAULT_MAX_OPTIONS,
} from './controller-decisions.mjs';
import {planGreetings, DEFAULT_GREETING_TEMPLATE, DEFAULT_GREET_RANGE, DEFAULT_GREET_COOLDOWN_MS} from './human-greeting.mjs';
import {orderAck, orderOutcome, isSelfTriggering, normalizePrefixes, matchChatPrefix, DEFAULT_REPLY_MAX_LENGTH} from './human-replies.mjs';
import {answerIntent, renderAnswer} from './human-questions.mjs';
import {resolveQuestionIntent, DEFAULT_INTENT_TIMEOUT_MS, DEFAULT_INTENT_MIN_P} from './chat-intent.mjs';
import {systemOneDecide} from './system-one.mjs';
import {
  evaluateSurvival, loadSurvivalRules, loadGameplaySkills, loadProgression,
  resolveMilestone, resolveActiveSkill, skillPreferredIntents, verifySkill, buildSkillRecord, appendSkillRecord,
  contractFromEnv, contractStop, hasContractConfig,
} from './survival/index.mjs';

const HARNESS = process.env.HARNESS || 'http://127.0.0.1:3077';
const RUN = process.env.RUN_ID || 'run';
const CURRICULUM = process.env.CURRICULUM || null; // es. first_night, enter_nether
const GOAL = process.env.GOAL || (CURRICULUM
  ? `Progress the Survival tech tree until the "${CURRICULUM}" milestone is complete.`
  : 'Hold at least 4 dirt in inventory and stand within 2 blocks (XZ) of the waypoint.');
// Env JSON invalido = errore di configurazione: fallire subito con un messaggio
// azionabile invece che con uno SyntaxError nudo.
function envJson (name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try { return JSON.parse(raw); }
  catch (error) { throw new Error(`${name} non è JSON valido: ${error.message}`); }
}
const WAYPOINT = envJson('WAYPOINT', null);   // e.g. {"x":380,"z":16}
const TARGETS = envJson('TARGETS', {dirt: 4}); // item -> min count
const MAX_STEPS = +(process.env.MAX_STEPS || 20);
const CONTROLLER = process.env.CONTROLLER || 'jev';
const JEV_MODEL = process.env.JEV_MODEL || (process.env.TYPESAFE_API_KEY ? 'jev-latest' : 'typesafe/jev-1.13');
const REPLAN_EVERY = +(process.env.REPLAN_EVERY || 8);
// Diagnostica/anti-loop (0 disabilita il tetto; soglia in azioni consecutive).
const MAX_OPTIONS = process.env.MAX_OPTIONS == null ? DEFAULT_MAX_OPTIONS : +(process.env.MAX_OPTIONS);
const ANTI_LOOP_THRESHOLD = +(process.env.ANTI_LOOP_THRESHOLD || DEFAULT_ANTI_LOOP_THRESHOLD);
// Il harness esegue una sola azione alla volta: se il lock è occupato (tipico
// dopo che un run è stato ucciso a metà di un'azione lunga) risponde `busy` in
// pochi ms. Attesa massima e passo di polling del retry, entrambi osservabili
// nel log `harness_busy`.
const HARNESS_BUSY_MAX_WAIT_MS = +(process.env.HARNESS_BUSY_MAX_WAIT_MS || 90000);
const HARNESS_BUSY_POLL_MS = +(process.env.HARNESS_BUSY_POLL_MS || 2000);
const ANTI_LOOP_COOLDOWN = +(process.env.ANTI_LOOP_COOLDOWN || 3);
// Comando umano via chat (M1-M3): attivo solo se CHAT_ALLOWLIST è valorizzato
// (gamertag/xuid separati da virgola). I prefissi che scatenano l'ordine sono
// `CHAT_PREFIXES` (lista separata da virgola, es. `@bot,@hermes`); il singolo
// `CHAT_PREFIX` resta valido e i due si sommano. Più bot sullo stesso server
// devono avere prefissi *distinti*: un trigger condiviso li farebbe agire tutti.
const CHAT_CONTROL = process.env.CHAT_CONTROL || (process.env.CHAT_ALLOWLIST ? 'on' : 'off');
const CHAT_ALLOWLIST = new Set((process.env.CHAT_ALLOWLIST || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const CHAT_PREFIXES = normalizePrefixes([process.env.CHAT_PREFIXES, process.env.CHAT_PREFIX].filter(Boolean));
const humanCommandSeen = new Set(); // dedup: un comando già eseguito non si ripete
const ignoredChatSeen = new Set(); // dedup della telemetria: un messaggio rifiutato si logga una volta
// Un ordine vecchio non va rieseguito: l'inbox dell'harness conserva gli ultimi
// messaggi, quindi un riavvio del controller (osservato live) rileggerebbe
// ordini già evasi. `at` è l'orologio dell'adapter, non del planner.
const CHAT_MAX_AGE_MS = +(process.env.CHAT_MAX_AGE_MS || 300000);
// Dedup con tetto: in una sessione lunga (o con chat ripetuta) i set di chiavi
// non devono crescere senza limite. Set conserva l'ordine di inserimento,
// quindi l'eviction FIFO è `values().next().value`.
const SEEN_LIMIT = 200;
function rememberSeen (set, key, limit = SEEN_LIMIT) {
  if (set.has(key)) return false;
  set.add(key);
  while (set.size > limit) set.delete(set.values().next().value);
  return true;
}
// Saluto proattivo (roadmap AI player §6, Attention System): percepito un umano
// vicino, il bot si presenta e gli spiega la sintassi per assegnargli un ordine.
// Attivo solo se il canale ordini è aperto (allowlist presente), altrimenti
// pubblicizzerebbe un canale che non accetta nulla.
const CHAT_GREET = process.env.CHAT_GREET == null
  ? (CHAT_CONTROL !== 'off' && CHAT_ALLOWLIST.size > 0)
  : /^(1|on|true|yes)$/i.test(process.env.CHAT_GREET);
const CHAT_GREET_RANGE = +(process.env.CHAT_GREET_RANGE || DEFAULT_GREET_RANGE);
const CHAT_GREET_COOLDOWN_MS = process.env.CHAT_GREET_COOLDOWN_MS == null
  ? DEFAULT_GREET_COOLDOWN_MS
  : +(process.env.CHAT_GREET_COOLDOWN_MS);
const CHAT_GREET_TEMPLATE = process.env.CHAT_GREET_TEMPLATE || DEFAULT_GREETING_TEMPLATE;
const greetedHumans = new Map(); // gamertag minuscolo -> timestamp ultimo saluto
// Risposta in chat (M5): il bot conferma l'ordine accettato e, alla chiusura del
// goal, ne comunica l'esito al mittente. Come il saluto, è attiva solo se il
// canale ordini è aperto; un ordine già confermato una volta non si ripete
// (dedup in `humanCommandSeen`).
const CHAT_REPLY = process.env.CHAT_REPLY == null
  ? (CHAT_CONTROL !== 'off' && CHAT_ALLOWLIST.size > 0)
  : /^(1|on|true|yes)$/i.test(process.env.CHAT_REPLY);
const CHAT_REPLY_MAX_LENGTH = +(process.env.CHAT_REPLY_MAX_LENGTH || DEFAULT_REPLY_MAX_LENGTH);
// Domande in chat (M6): un messaggio che chiede un fatto sul bot ("dove sei",
// "che fai", "quanti dirt hai") riceve una risposta deterministica dai dati
// dell'harness — nessun goal creato, quindi un goal in corso continua a girare.
// La regex risponde da sola a quello che riconosce; il resto lo instrada System
// One (Jev) su una lista chiusa di intenti, se c'è una chiave. `CHAT_INTENT=off`
// lascia attiva la sola regex (il bot non resta muto senza chiave o offline).
const CHAT_INTENT = process.env.CHAT_INTENT || ((process.env.TYPESAFE_API_KEY || process.env.OPENROUTER_API_KEY) ? 'on' : 'off');
const CHAT_INTENT_ON = /^(1|on|true|yes)$/i.test(CHAT_INTENT);
const CHAT_INTENT_MODEL = process.env.CHAT_INTENT_MODEL || null;
const CHAT_INTENT_URL = process.env.CHAT_INTENT_URL || null;
const CHAT_INTENT_TIMEOUT_MS = +(process.env.CHAT_INTENT_TIMEOUT_MS || DEFAULT_INTENT_TIMEOUT_MS);
const CHAT_INTENT_MIN_P = process.env.CHAT_INTENT_MIN_P == null ? DEFAULT_INTENT_MIN_P : +(process.env.CHAT_INTENT_MIN_P);
// Session mode (AI-player roadmap M0->1): con SESSION=on il controller non
// esce a fine goal ma resta in IDLE e accetta nuovi goal (ordini in chat)
// senza riconnettersi. Default off = comportamento one-shot storico.
const SESSION = /^(1|on|true|yes)$/i.test(process.env.SESSION || '');
const IDLE_POLL_MS = +(process.env.IDLE_POLL_MS || 2000);
const IDLE_TIMEOUT_MS = +(process.env.IDLE_TIMEOUT_MS || 0); // 0 = attesa senza scadenza
// Resume cross-sessione: all'avvio, i goal `suspended` salvati nel run
// precedente tornano in coda (il loro piano è persistito, niente riconnessione
// né ri-pianificazione LLM). Default: attivo in modalità sessione.
const RESUME = process.env.RESUME == null ? SESSION : /^(1|on|true|yes)$/i.test(process.env.RESUME);
// Autonomia (milestone 3): in IDLE il bot genera da sé goal dai bisogni
// (deterministico, non un LLM per decisione). Richiede SESSION=on.
const AUTONOMY = /^(1|on|true|yes)$/i.test(process.env.AUTONOMY || '');
const AUTONOMY_COOLDOWN_MS = +(process.env.AUTONOMY_COOLDOWN_MS || DEFAULT_AUTONOMY_COOLDOWN_MS);
const AUTONOMY_MAX_GOALS = +(process.env.AUTONOMY_MAX_GOALS || DEFAULT_MAX_AUTONOMOUS_GOALS);
// Emergenze (milestone 2): un evento del mondo può sospendere il goal in corso e
// avviarne uno a priorità 100 (es. morte -> recupero loot). Default: attivo in
// modalità sessione.
const EMERGENCY = process.env.EMERGENCY == null ? SESSION : /^(1|on|true|yes)$/i.test(process.env.EMERGENCY);
const EMERGENCY_COOLDOWN_MS = +(process.env.EMERGENCY_COOLDOWN_MS || DEFAULT_EMERGENCY_COOLDOWN_MS);

mkdirSync(`runs/${RUN}`, {recursive: true});
const SKILLS_LOG = `runs/${RUN}/skills.jsonl`;
const log = (type, data) => appendFileSync(`runs/${RUN}/controller.jsonl`, JSON.stringify({t: Date.now(), type, ...data}) + '\n');
const api = async (method, path, body) => {
  const r = await fetch(HARNESS + path, {method, body: body ? JSON.stringify(body) : undefined, headers: {'Content-Type': 'application/json', Connection: 'close'}});
  return r.json();
};

// ---- Goal Manager (Agent Core, milestone 1) --------------------------------------------------
// Ogni attività è un goal con fonte, priorità e stato. La coda è persistita
// nello stesso formato dei repository della world memory (kind: 'goal') in una
// directory separata da quella dell'harness, così i due processi non competono
// sullo stesso file.
const goalStore = new JsonMemoryRepository({dir: `runs/${RUN}/goals`, logger: null}).load();
const goalManager = createGoalManager({store: goalStore}).hydrate();
const enterState = (state, extra = {}) => {
  log('session_state', {state, runningGoal: goalManager.current?.id ?? null, ...extra});
};

// ---- Survival Intelligence Layer ------------------------------------------------------------
// Caricati e validati all'avvio: un file rotto deve fallire prima del primo passo.
const survivalRules = await loadSurvivalRules(new URL('./knowledge/survival-rules.json', import.meta.url));
const gameplaySkills = loadGameplaySkills();
const progressionGraph = await loadProgression(new URL('./knowledge/progression.json', import.meta.url));

const completedMilestones = new Set();   // verificati davvero in questa sessione
let skillRun = null;                     // {id, def, milestone, startedAt, startObservation, actions, sawNight}
let autonomousGoalCount = 0;             // goal autonomi generati in questa sessione (cap)
const autonomousAttempts = new Map();    // need -> ultimo tentativo (anti-loop in IDLE)
const emergencyAttempts = new Map();     // dedupKey evento -> ultima emergenza creata

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
    // Il waypoint ambientale (`WAYPOINT`, knob della demo) non appartiene al
    // milestone: appeso a ogni passo farebbe offrire `goto_waypoint` e
    // devierebbe il goal verso coordinate arbitrarie (visto live: il primo
    // passo di `first_night` partiva per {x:380,z:16} e finiva in
    // `target_not_found`). Il curriculum naviga per milestone, non per waypoint.
    waypoint: null,
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

// P0 (memoria episodico → semantico): i suggerimenti di produttività sono
// preferenze, non fatti — entrano nel prompt come indizi da ri-verificare.
function provenHintLines (observation, limit = 5) {
  const hints = observation?.memory?.hints ?? [];
  if (!hints.length) return '';
  const text = hints.slice(0, limit).map(h => {
    const pos = h.position ? `${h.position.x},${h.position.z}` : '?,';
    const flag = h.contradicted ? ', contradicted' : '';
    return `${h.resource} near ${pos} (success ${h.confidence}${flag})`;
  }).join('; ');
  return `Proven locations from past episodes (prefer them, but re-verify on the spot — these are hints, not facts): ${text}`;
}

// P6 (indice vettoriale): il recall semantico entra nel prompt come **indizio**,
// mai come fatto, esattamente come i suggerimenti di produttività di P0. La query
// viene dal goal in corso: l'harness non conosce l'obiettivo, il controller sì.
function recallQuery (goal) {
  const parts = [goal?.objective, goal?.type, ...Object.keys(TARGETS ?? {})].filter(Boolean);
  return parts.join(' ').trim().slice(0, 200);
}

function semanticRecallLines (hits, limit = 3) {
  const rows = (hits ?? []).slice(0, limit).filter(h => h?.id);
  if (!rows.length) return '';
  const text = rows.map(h => {
    const pos = h.position ? `${h.position.x},${h.position.z}` : '?';
    const what = h.label ?? h.type ?? h.kind ?? 'place';
    const hint = h.productivity ? ', proven' : '';
    return `${what} at ${pos} (${h.score}${hint})`;
  }).join('; ');
  return `Similar places from memory (semantic recall — hints, re-verify on the spot): ${text}`;
}

// Il recall non deve mai bloccare un piano: se la rotta manca o risponde male si
// prosegue senza indizi, con l'errore nel log. `reachable=1` chiede all'harness
// di dire quali hit sono camminabili, così un hit può diventare una destinazione.
async function semanticRecall (goal) {
  const query = recallQuery(goal);
  if (!query) return { query, hits: [], candidate: null };
  let out = null;
  let error = null;
  try {
    out = await api('GET', `/memory/search?q=${encodeURIComponent(query)}&limit=3&reachable=1`);
    if (!Array.isArray(out?.hits)) { error = out?.error ?? 'no_hits'; out = null; }
  } catch (err) { error = err.message; }
  const hits = out?.hits ?? [];
  log('semantic_recall', {query, hits: hits.map(h => ({id: h.id, score: h.score})), error});
  return { query, hits, candidate: out?.candidate ?? null, candidateReason: out?.candidateReason ?? null };
}

// P6: un hit semantico diventa un **waypoint** solo se l'harness lo dichiara
// raggiungibile e il piano non ne ha già uno (il goal esplicito e il curriculum
// comandano). La memoria suggerisce, il mondo decide: una reachability
// sconosciuta non è una conferma, quindi non si parte.
function applySemanticWaypoint (plan, recall) {
  if (!plan || CURRICULUM || WAYPOINT || plan.waypoint || plan.follow || plan.need || plan.recover) return plan;
  const candidate = recall?.candidate;
  if (!candidate?.position) {
    if (recall?.hits?.length || recall?.candidateReason) {
      log('semantic_waypoint_skipped', {reason: recall?.candidateReason ?? 'no_reachable_place', hits: recall?.hits?.length ?? 0});
    }
    return plan;
  }
  const waypoint = {x: Math.round(candidate.position.x), z: Math.round(candidate.position.z)};
  log('semantic_waypoint', {place: candidate.id, score: candidate.score, waypoint, reachability: candidate.reachability ?? null});
  const note = `waypoint from memory: ${candidate.id}`;
  return {...plan, waypoint, notes: plan.notes ? `${plan.notes} (${note})` : note};
}

async function hermesPlan(observation, { recall = '' } = {}) {
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
    provenHintLines(observation),
    recall,
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
  let plan = {objective: GOAL, targets: TARGETS, waypoint: WAYPOINT};
  if (m) {
    try { plan = JSON.parse(m[0]); }
    catch (error) { log('plan_parse_failed', {raw: m[0].slice(0, 500), error: error.message}); }
  }
  if (WAYPOINT && !plan.waypoint) plan.waypoint = WAYPOINT;
  log('plan', {plan, ms: Date.now() - started});
  return plan;
}

// In modalità curriculum il piano è deterministico; Hermes resta il fallback
// per gli errori del motore e per le situazioni ambigue.
async function planForStep (observation, reason, goal = null) {
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
  const recall = await semanticRecall(goal);
  const plan = await hermesPlan(observation, {recall: semanticRecallLines(recall.hits)});
  return applySemanticWaypoint(plan, recall);
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

// Domanda sul bot o ordine? Prima la regex (gratis, offline), poi System One
// sulla lista chiusa di intenti. Il router non scrive mai la risposta: la
// compone `answerIntent` dai dati dell'osservazione. Un router indisponibile
// (nessuna chiave, timeout, errore, bassa probabilità) non zittisce il canale:
// il messaggio resta un ordine, come prima di M6.
async function resolveQuestion (obs, entry) {
  const decision = await resolveQuestionIntent(entry.message, {
    from: entry.from,
    enabled: CHAT_INTENT_ON,
    model: CHAT_INTENT_MODEL ?? undefined,
    url: CHAT_INTENT_URL ?? undefined,
    timeoutMs: CHAT_INTENT_TIMEOUT_MS,
    minProbability: CHAT_INTENT_MIN_P,
  });
  if (!decision) return null;
  if (decision.via === 'jev') {
    log('chat_intent', {
      from: entry.from, xuid: entry.xuid, message: entry.message, reason: decision.reason,
      intent: decision.matched ?? null, chosen: decision.id ?? null, probability: decision.probability,
      model: decision.model, ms: decision.ms, cost: decision.cost, error: decision.error ?? null,
    });
  }
  if (!decision.id) return null;
  const answer = answerIntent(decision.id, obs, {prefixes: CHAT_PREFIXES, maxLength: CHAT_REPLY_MAX_LENGTH});
  if (!answer) return null;
  log('chat_question', {from: entry.from, xuid: entry.xuid, intent: decision.id, via: decision.via, probability: decision.probability});
  return {...decision, answer};
}

// Cerca nell'ultima osservazione un nuovo comando umano valido. Restituisce
// {plan, entry} oppure null. Dedup per non rieseguire lo stesso messaggio.
async function maybeHumanCommand (obs) {
  if (CHAT_CONTROL === 'off' || !CHAT_ALLOWLIST.size) return null;
  const chat = obs.chat || [];
  for (let i = chat.length - 1; i >= 0; i--) {
    const entry = chat[i];
    const text = String(entry.message || '').trim();
    // `@bot1` non deve essere letto come `@bot`: vince il prefisso più lungo.
    const match = matchChatPrefix(text, CHAT_PREFIXES);
    if (!match) continue;
    // Età del messaggio: se l'adapter ha timbrato `at`, un ordine più vecchio
    // della finestra è storia, non un comando (fail-open se `at` manca).
    const stampedAt = Number(entry.at);
    const age = Number.isFinite(stampedAt) && stampedAt > 0 ? Date.now() - stampedAt : 0;
    if (age > CHAT_MAX_AGE_MS) {
      if (rememberSeen(ignoredChatSeen, `stale|${entry.at}|${entry.from}|${entry.message}`)) {
        log('chat_stale', {from: entry.from, xuid: entry.xuid, ageMs: Math.round(age), maxAgeMs: CHAT_MAX_AGE_MS});
      }
      continue;
    }
    if (!isAllowedSender(entry)) {
      // La chat resta nell'inbox dell'harness finché non viene sommersa da altri
      // messaggi: senza dedup il rifiuto verrebbe ri-loggato a ogni poll (osservato
      // live: 122 eventi identici in 25 s). Si logga una volta per messaggio.
      if (rememberSeen(ignoredChatSeen, `${entry.at}|${entry.from}|${entry.message}`)) {
        log('chat_ignored', {from: entry.from, xuid: entry.xuid, reason: 'not_allowed'});
      }
      continue;
    }
    const message = match.rest;
    if (!message) continue;
    const seenKey = `${entry.at}|${entry.from}|${message}`;
    if (!rememberSeen(humanCommandSeen, seenKey)) continue;
    // M6: prima di tradurre il messaggio in un piano, chiediti se è una domanda.
    // Se lo è, si risponde e si passa al messaggio successivo: nessun goal nasce.
    const question = await resolveQuestion(obs, {...entry, message, prefix: match.prefix});
    if (question?.answer) {
      await replyChat(renderAnswer({from: entry.from, answer: question.answer, maxLength: CHAT_REPLY_MAX_LENGTH}), {to: entry.from, context: 'question'});
      continue;
    }
    log('chat_command', {from: entry.from, xuid: entry.xuid, prefix: match.prefix, message});
    const plan = await humanCommandPlan(obs, {...entry, message});
    // M5: conferma dell'ordine in chat. Best-effort (l'adapter applica rate
    // limit e lunghezza); l'esito arriva alla chiusura del goal.
    await replyChat(orderAck({from: entry.from, plan, maxLength: CHAT_REPLY_MAX_LENGTH}), {to: entry.from, context: 'ack'});
    return {plan, entry: {...entry, message}};
  }
  return null;
}

// Risposta in chat (M5): una riga, indirizzata al mittente, mai scatenante
// (`@<nome> ...`, non `@bot ...`). Ritorna l'esito del POST /say e non lancia
// mai: il canale resta best-effort come il saluto.
async function replyChat (message, {to = null, context = null} = {}) {
  if (!CHAT_REPLY || !message) return null;
  if (isSelfTriggering(message, CHAT_PREFIXES)) {
    log('chat_reply_refused', {to, context, message, reason: 'would_trigger_the_bot'});
    return {ok: false, error: 'would_trigger_the_bot'};
  }
  const result = await api('POST', '/say', {message}).catch(error => ({ok: false, error: error.message}));
  log('chat_reply', {to, context, message, ok: !!result?.ok, error: result?.error ?? null});
  return result;
}

// Saluto proattivo: un umano fidato percepito vicino riceve una volta (con
// cooldown) un messaggio che spiega come dare un ordine. Si prova solo a bot
// spawnato; se `/say` non esiste (harness Java) la chiamata fallisce e resta nei
// log. Un saluto per umano: dedup per gamertag, non per passo.
async function maybeGreetHumans (obs) {
  if (!CHAT_GREET || !obs?.spawned) return;
  const greetings = planGreetings({
    humans: obs.humans || [],
    allowlist: CHAT_ALLOWLIST,
    prefixes: CHAT_PREFIXES,
    greeted: greetedHumans,
    now: Date.now(),
    cooldownMs: CHAT_GREET_COOLDOWN_MS,
    range: CHAT_GREET_RANGE,
    template: CHAT_GREET_TEMPLATE,
  });
  for (const greet of greetings) {
    // Segna subito il tentativo: su errore si ritenta dopo il cooldown, non a
    // ogni passo (niente spam verso il server né nei log).
    greetedHumans.set(greet.username.toLowerCase(), Date.now());
    const result = await api('POST', '/say', {message: greet.message}).catch(error => ({ok: false, error: error.message}));
    log('chat_greet', {to: greet.username, distance: greet.distance, prefixes: CHAT_PREFIXES, message: greet.message, ok: !!result?.ok, error: result?.error ?? null});
    console.log(`GREET ${greet.username}: ${greet.message}`);
  }
}

// ---- controller: Jev via TypeSafe or OpenRouter ---------------------------------------------
async function jevDecide(observation, options, plan) {
  const criteria = buildCriteria(options);
  const {answers, model, provider, usage, ms} = await systemOneDecide({
    model: JEV_MODEL,
    state: {...observation, plan: observation.plan ?? plan, recent: observation.recent?.slice(-4)},
    questions: {action: {type: 'choice', instructions: buildDecisionInstructions(plan), criteria}},
  });
  const ans = answers.action;
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
    controller: 'jev', provider, model,
    choice: ans.choice, key: chosen.key, probabilities, confidence: ans.confidence,
    cost: usage?.cost, ms, candidates,
    selectedProbability: probabilityOf(ans.choice), optionsCount: options.length, objective: plan.objective,
  });
  return {key: chosen.key, cost: usage?.cost ?? null};
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
  // Un goal autonomo è ancorato al bisogno che l'ha generato: il successo è la
  // scomparsa del bisogno dallo stato del harness, non un target inventato.
  if (plan.need) return isNeedResolved(plan.need, obs, {rules: survivalRules});
  // Un goal di emergenza per il recupero loot termina quando l'harness azzera
  // il sito di morte (nessun drop rimasto).
  if (plan.recover) return !obs.deathSite;
  // In modalità curriculum il goal si chiude solo quando il milestone finale è
  // verificato (ramo `skill` più sotto o progression engine nel replan): i
  // target dell'ultimo piano sono i *prerequisiti* del milestone, non il
  // successo. Senza questa guardia un prerequisito completato (es. `wood`)
  // chiuderebbe il goal al primo passo.
  if (CURRICULUM) return false;
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

// Esegue UN goal fino a un esito terminale e restituisce l'esito senza uscire
// dal processo: la persistenza del goal e le transizioni di stato sono
// responsabilità del session loop (main).
async function runGoal (goal) {
skillRun = null;
let obs = await api('GET', '/observe');

// ---- Goal Contract (opzionale, Slice A) -----------------------------------------------------
// Con GOAL_CONTRACT (JSON), MAX_DEATHS o PRESERVE_ITEMS il controller valuta un
// contratto strutturato a ogni passo e ne deriva uno stato deterministico:
// RUNNING | SUCCESS | FAILED | BLOCKED. Senza configurazione resta il
// comportamento precedente (nessun contratto).
const goalContract = hasContractConfig() ? contractFromEnv() : null;
const contractBaseline = obs;
let lastContractStatus = null;
let runExitCode = 0; // non-zero quando un contratto termina FAILED/BLOCKED/EXHAUSTED
// `stepsUsed` = azioni già eseguite; a fine budget il contratto ancora RUNNING
// viene tradotto in `exhausted` (vedi survival/goal-contract.mjs).
function evaluateGoalContract (observation, stepsUsed) {
  if (!goalContract) return null;
  const status = contractStop(goalContract, observation, { before: contractBaseline, stepsUsed, maxSteps: MAX_STEPS });
  if (status.status !== lastContractStatus) {
    lastContractStatus = status.status;
    log('goal_contract', {
      step: stepsUsed, status: status.status, goal: goalContract.goal ?? null,
      reasons: status.reasons, evidence: status.evidence,
    });
    console.log(`GOAL CONTRACT ${status.status.toUpperCase()}${status.reasons.length ? ' ' + status.reasons.join('; ') : ''}`);
  }
  return status;
}
if (goalContract) {
  const initialContract = evaluateGoalContract(obs, 0);
  if (initialContract.status !== 'running') {
    if (initialContract.status !== 'success') runExitCode = 2;
    log('goal_contract_stop', {step: 0, status: initialContract.status, reasons: initialContract.reasons, evidence: initialContract.evidence});
    console.log(`GOAL CONTRACT ${initialContract.status.toUpperCase()} before the first action`);
    return {status: initialContract.status === 'success' ? 'success' : 'failed', exitCode: runExitCode, steps: 0};
  }
}

let initialPlan = goal.plan || await planForStep(obs, 'start', goal);
if (initialPlan?.met) {
  console.log('CURRICULUM GOAL already met');
  log('goal_met', {steps: 0, curriculum: CURRICULUM});
  return {status: 'success', exitCode: 0, steps: 0, reason: 'curriculum_already_met'};
}
let plan = initialPlan;
await api('POST', '/plan', plan);
// Archi di goal: ogni target dell'obiettivo diventa una risorsa cercata
// (mission --seeks--> resource:<item>). Best-effort, non blocca il loop.
if (goal.missionId && plan?.targets) {
  for (const item of Object.keys(plan.targets)) {
    if (!item) continue;
    await api('POST', '/mission/link', {missionId: goal.missionId, relationType: 'seeks', targetId: `resource:${item}`}).catch(() => {});
  }
}
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
let stepsUsed = 0;
let prevObs = null;             // osservazione del passo precedente (eventi del mondo)
for (let step = 1; step <= MAX_STEPS; step++) {
  obs = await api('GET', '/observe');
  stepsUsed = step;
  // Saluto proattivo: indipendente dal goal, un umano vicino va informato di
  // come comandare il bot (una volta, con cooldown).
  await maybeGreetHumans(obs);
  // Goal Contract: SUCCESS/FAILED/BLOCKED interrompono il loop prima delle
  // altre logiche (il contratto è la fonte di verità del run quando presente).
  const contractStatus = evaluateGoalContract(obs, step - 1);
  if (contractStatus?.status === 'success') {
    console.log(`GOAL CONTRACT MET after ${step - 1} actions`, JSON.stringify(contractStatus.evidence));
    log('goal_contract_met', {steps: step - 1, totalCost, goal: goalContract.goal ?? null, evidence: contractStatus.evidence});
    goalReached = true;
    break;
  }
  if (contractStatus?.status === 'failed' || contractStatus?.status === 'blocked' || contractStatus?.status === 'exhausted') {
    runExitCode = 2;
    console.log(`GOAL CONTRACT ${contractStatus.status.toUpperCase()} after ${step - 1} actions: ${contractStatus.reasons.join('; ')}`);
    log('goal_contract_stop', {steps: step - 1, totalCost, status: contractStatus.status, reasons: contractStatus.reasons, evidence: contractStatus.evidence});
    break;
  }
  // Emergenze (M2): un evento del mondo può sospendere il goal in corso e
  // creare un goal a priorità 100. Qui si decide solo di *preemptare*: il
  // session loop (main) sospende il goal e accoda l'emergenza, che verrà
  // eseguita al prossimo giro; il padre è ripreso quando l'emergenza finisce.
  // Un goal di emergenza non si preempta da solo (un livello di annidamento).
  if (EMERGENCY && goal.source !== GOAL_SOURCE.EMERGENCY) {
    for (const event of detectEvents(prevObs, obs)) {
      const spec = emergencyGoalFor(event, {parentGoal: goal.id, attempts: emergencyAttempts, cooldownMs: EMERGENCY_COOLDOWN_MS});
      if (!spec) continue;
      emergencyAttempts.set(spec.dedupKey, Date.now());
      log('emergency_event', {step, type: event.type, severity: event.severity, dedupKey: spec.dedupKey, goalId: goal.id});
      return {status: 'preempted', emergency: spec, steps: stepsUsed, totalCost};
    }
  }
  prevObs = obs;
  // Comando umano via chat (M3): priorità sul piano autonomo finché non arriva
  // un nuovo ordine. Il governor resta comunque l'ultima parola sulle opzioni.
  const humanCmd = await maybeHumanCommand(obs);
  if (humanCmd) {
    plan = humanCmd.plan;
    await api('POST', '/plan', plan);
    skillRun = null; // il piano umano sostituisce la skill attiva
    // Un ordine può riorientare un goal nato autonomo: l'esito di *quel* goal
    // deve tornare a chi ha ordinato (non al planner autonomo).
    goal.humanOrder = {from: humanCmd.entry.from, message: humanCmd.entry.message, objective: plan.objective, at: Date.now()};
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
  // Un goal autonomo/emergenza è ancorato al suo predicato di successo
  // (bisogno o recupero loot): non va sostituito da un nuovo piano, o si perde
  // l'ancoraggio e il goal non si chiude. Si salta il replan.
  if (replanReason && (plan.need || plan.recover)) {
    log('replan_skipped', {step, reason: replanReason, need: plan.need ?? null, recover: plan.recover === true});
    replanReason = null;
  }
  if (replanReason) {
    const candidatePlan = await planForStep(obs, replanReason, goal);
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
  const actStarted = Date.now();
  let result = await api('POST', '/act', {key});
  // `busy` non è un verdetto sull'azione: il harness sta ancora eseguendo
  // l'azione di un altro client. Bruciare il budget con risposte istantanee non
  // prova nulla, quindi si attende il rilascio del lock (tetto esplicito) e si
  // riprova la stessa chiave: la validità resta del harness, che risponde con un
  // errore tipizzato se nel frattempo l'azione non è più possibile.
  if (result && !result.ok && result.error === 'busy') {
    const busyFrom = Date.now();
    let attempts = 0;
    while (!result.ok && result.error === 'busy' && Date.now() - busyFrom < HARNESS_BUSY_MAX_WAIT_MS) {
      await delay(HARNESS_BUSY_POLL_MS);
      attempts += 1;
      result = await api('POST', '/act', {key});
    }
    const waitedMs = Date.now() - busyFrom;
    log('harness_busy', {step, key, attempts, waitedMs, ok: !!result.ok, error: result.error ?? null});
    if (!result.ok && result.error === 'busy') result = {ok: false, error: 'busy', timeout: true, waitedMs};
  }
  if (skillRun) skillRun.actions += 1;
  lastFailedKey = result.ok ? null : key;
  lastKey = key;
  log('result', {step, key, ok: !!result.ok, error: result.error ?? null, ms: result.ms ?? null, missionId: goal.missionId ?? null});
  if (goal.missionId) {
    // `data.position` dà al consolidamento un'ancora spaziale forte (l'azione
    // riuscita dice *dove* la risorsa è stata trovata).
    await api('POST', '/mission/action', {missionId: goal.missionId, actionType: key, outcome: result.ok ? 'ok' : (result.error ?? 'failed'), startedAt: actStarted, completedAt: Date.now(), data: {position: obs.position, dimension: obs.dimension}}).catch(() => {});
  }
  console.log(`#${step} ${key} ->`, JSON.stringify(result));
  if (step === MAX_STEPS) { console.log('step budget exhausted'); log('budget_exhausted', {steps: step, totalCost}); }
}
// Budget esaurito con il contratto ancora RUNNING: chiude il contratto con
// esito `exhausted` (dopo aver riletto lo stato, nel caso l'ultima azione
// abbia centrato il successo).
if (!goalReached && goalContract && lastContractStatus === 'running') {
  const finalObs = await api('GET', '/observe').catch(() => null);
  if (finalObs) {
    const final = evaluateGoalContract(finalObs, MAX_STEPS);
    if (final.status === 'success') {
      console.log(`GOAL CONTRACT MET after ${MAX_STEPS} actions`, JSON.stringify(final.evidence));
      log('goal_contract_met', {steps: MAX_STEPS, totalCost, goal: goalContract.goal ?? null, evidence: final.evidence});
      goalReached = true;
    } else if (final.status === 'failed' || final.status === 'blocked' || final.status === 'exhausted') {
      runExitCode = 2;
      log('goal_contract_stop', {steps: MAX_STEPS, totalCost, status: final.status, reasons: final.reasons, evidence: final.evidence});
    }
  }
}
if (!goalReached) {
  log('run_end', {steps: stepsUsed, totalCost, curriculum: CURRICULUM, completedMilestones: [...completedMilestones], goalId: goal.id});
}
// Non si esce dal processo: l'esito torna al session loop (main), che decide se
// registrarlo e passare a IDLE o terminare (modalità one-shot).
return {status: goalReached ? 'success' : (runExitCode ? 'failed' : 'exhausted'), exitCode: runExitCode, steps: stepsUsed, totalCost};
}

// ---- session loop: IDLE <-> GOAL_RUNNING ----------------------------------------------------
function seedInitialGoal () {
  return goalManager.enqueue({
    type: CURRICULUM ? 'curriculum' : 'autonomous',
    source: CURRICULUM ? GOAL_SOURCE.CURRICULUM : GOAL_SOURCE.AUTONOMOUS,
    objective: GOAL,
    parameters: {curriculum: CURRICULUM, waypoint: WAYPOINT, targets: TARGETS, maxSteps: MAX_STEPS},
  });
}

// IDLE: nessun goal attivo. In session mode si resta in attesa di un nuovo
// goal (per ora solo ordini in chat); senza SESSION si esce.
async function waitForGoal () {
  console.log(`IDLE — waiting for a new goal (chat orders accepted${IDLE_TIMEOUT_MS ? `, timeout ${IDLE_TIMEOUT_MS} ms` : ''})`);
  enterState('IDLE');
  const startedAt = Date.now();
  while (true) {
    const obs = await api('GET', '/observe').catch(() => null);
    if (obs) {
      await maybeGreetHumans(obs);
      const cmd = await maybeHumanCommand(obs);
      if (cmd) {
        const goal = goalManager.enqueue({
          type: 'chat', source: GOAL_SOURCE.CHAT, objective: cmd.plan.objective,
          plan: cmd.plan, parameters: {from: cmd.entry.from, message: cmd.entry.message},
        });
        console.log(`IDLE -> goal ${goal.id} from ${cmd.entry.from}: ${goal.objective}`);
        log('human_order', {from: cmd.entry.from, xuid: cmd.entry.xuid, plan: cmd.plan, goalId: goal.id, via: 'idle'});
        return goal;
      }
      // Autonomia: nessun ordine umano -> un goal dai bisogni, deterministico.
      if (AUTONOMY && autonomousGoalCount < AUTONOMY_MAX_GOALS) {
        const candidate = nextIdleGoal(obs, {rules: survivalRules, attempts: autonomousAttempts, cooldownMs: AUTONOMY_COOLDOWN_MS});
        if (candidate) {
          autonomousAttempts.set(candidate.need, Date.now());
          autonomousGoalCount += 1;
          const goal = goalManager.enqueue({
            type: 'autonomous', source: candidate.source, priority: candidate.priority, objective: candidate.objective,
            plan: {objective: candidate.objective, targets: {}, waypoint: null, need: candidate.need, priority: 'autonomy', notes: `autonomy:${candidate.need}`},
            parameters: {need: candidate.need, mode: candidate.mode, reason: candidate.reason},
          });
          console.log(`IDLE -> autonomous goal ${goal.id} [${candidate.need}] ${goal.objective}`);
          log('idle_goal', {goalId: goal.id, need: candidate.need, source: candidate.source, mode: candidate.mode, reason: candidate.reason});
          return goal;
        }
      }
    }
    if (IDLE_TIMEOUT_MS && Date.now() - startedAt >= IDLE_TIMEOUT_MS) {
      console.log(`IDLE timeout (${IDLE_TIMEOUT_MS} ms) with no new goal`);
      return null;
    }
    await delay(IDLE_POLL_MS);
  }
}

async function main () {
  // Un goal rimasto RUNNING in un run precedente viene sospeso (non sappiamo a
  // che punto dell'azione fosse); poi, se RESUME è attivo, tutti i goal
  // SUSPENDED vengono rimessi in coda come PENDING. Così un riavvio del
  // controller riprende il lavoro interrotto senza perdere la coda.
  for (const stale of goalManager.list({status: GOAL_STATUS.RUNNING})) goalManager.suspend(stale.id, 'session restarted');
  if (RESUME) {
    const suspended = goalManager.list({status: GOAL_STATUS.SUSPENDED});
    for (const goal of suspended) goalManager.resume(goal.id);
    if (suspended.length) {
      console.log(`RESUME ${suspended.length} goal(s) from a previous session: ${suspended.map(g => g.id).join(', ')}`);
      log('session_resume', {goalIds: suspended.map(g => g.id), count: suspended.length});
    }
  }
  // Semina un goal iniziale solo se non c'è già lavoro pendente da riprendere.
  if (goalManager.pending().length === 0) seedInitialGoal();
  let exitCode = 0;
  while (true) {
    let goal = goalManager.pull();
    if (!goal) {
      if (!SESSION) break;
      goal = await waitForGoal();
      if (!goal) break;
    }
    goalManager.start(goal.id);
    enterState('GOAL_RUNNING', {goalId: goal.id, source: goal.source});
    console.log(`GOAL ${goal.id} [${goal.source}] ${goal.objective}`);
    log('goal_start', {goalId: goal.id, source: goal.source, priority: goal.priority, objective: goal.objective, plan: goal.plan ?? null});
    // Wiring memoria episodica: il goal diventa una missione persistente nel
    // world memory dell'harness (rawPrompt = obiettivo, intent = tipo goal).
    goal.missionId = null;
    try {
      const missionRes = await api('POST', '/mission', {type: goal.type, intent: goal.type, rawPrompt: goal.objective, source: 'controller'});
      goal.missionId = missionRes.mission?.id ?? null;
      if (goal.missionId) log('mission_start', {goalId: goal.id, missionId: goal.missionId, type: goal.type, intent: goal.type});
    } catch (error) {
      log('mission_create_failed', {goalId: goal.id, error: error.message});
    }
    let outcome;
    try {
      outcome = await runGoal(goal);
    } catch (error) {
      // Errore fatale (provider decisionale non raggiungibile, bug interno): il
      // processo non deve morire lasciando la missione episodica aperta per
      // sempre. Si registra l'esito fallito e si chiude il run.
      console.error(`GOAL ${goal.id} ERROR: ${error.message}`);
      log('goal_error', {goalId: goal.id, missionId: goal.missionId ?? null, error: error.message});
      outcome = {status: 'failed', reason: `controller_error: ${error.message}`, exitCode: 1, steps: null, totalCost: null, error: true};
    }
    if (outcome.status === 'preempted') {
      // Sospende il goal in corso e accoda l'emergenza (priorità più alta):
      // verrà eseguita al prossimo giro e, al termine, il padre riprenderà.
      const suspended = goalManager.preempt(`emergency:${outcome.emergency.type}`);
      const child = goalManager.enqueue(outcome.emergency);
      console.log(`EMERGENCY ${outcome.emergency.eventType ?? outcome.emergency.type}: suspend ${goal.id} -> run ${child.id}`);
      log('emergency_preempt', {parentGoalId: goal.id, emergencyGoalId: child.id, eventType: outcome.emergency.eventType ?? null, type: outcome.emergency.type, suspended: suspended?.id ?? null});
      continue;
    }
    if (outcome.status === 'success') goalManager.complete(goal.id, {steps: outcome.steps, totalCost: outcome.totalCost});
    else if (outcome.status === 'failed') goalManager.fail(goal.id, outcome.reason ?? 'failed', {steps: outcome.steps, totalCost: outcome.totalCost});
    else goalManager.cancel(goal.id, outcome.reason ?? 'exhausted');
    const final = goalManager.get(goal.id);
    console.log(`GOAL ${goal.id} ${final.status.toUpperCase()}${final.reason ? ` (${final.reason})` : ''} after ${outcome.steps ?? '?'} actions`);
    log('goal_end', {goalId: goal.id, status: final.status, reason: final.reason, steps: outcome.steps, totalCost: outcome.totalCost});
    // M5: l'ordine umano riceve l'esito in chat (goal nato da un ordine, oppure
    // goal autonomo riorientato da un ordine). Best-effort, mai bloccante.
    const humanFrom = goal.source === GOAL_SOURCE.CHAT ? (goal.parameters?.from ?? null) : (goal.humanOrder?.from ?? null);
    if (humanFrom) {
      await replyChat(orderOutcome({
        from: humanFrom,
        status: outcome.status,
        objective: goal.humanOrder?.objective ?? goal.objective,
        steps: outcome.steps ?? null,
        reason: final.reason ?? outcome.reason ?? null,
        maxLength: CHAT_REPLY_MAX_LENGTH,
      }), {to: humanFrom, context: 'outcome'});
    }
    // Chiusura della missione episodica con esito e successo (best-effort).
    if (goal.missionId) {
      const finish = outcome.status === 'success'
        ? {outcome: 'found', success: true, state: 'found', result: {steps: outcome.steps, totalCost: outcome.totalCost}}
        : outcome.status === 'failed'
          ? {outcome: 'failed', success: false, state: 'failed', failureReason: outcome.reason ?? 'failed'}
          : {outcome: 'exhausted', success: false, state: 'cancelled', failureReason: 'exhausted'};
      try {
        await api('POST', '/mission/finish', {missionId: goal.missionId, ...finish});
        log('mission_end', {goalId: goal.id, missionId: goal.missionId, ...finish});
      } catch (error) {
        log('mission_finish_failed', {goalId: goal.id, missionId: goal.missionId, error: error.message});
      }
    }
    enterState('GOAL_COMPLETED', {goalId: goal.id, status: final.status});
    // Un errore fatale chiude il run (dopo aver chiuso la missione): niente
    // cicli di retry silenziosi in session mode.
    if (outcome.error) { exitCode = outcome.exitCode ?? 1; break; }
    if (!SESSION) { exitCode = outcome.exitCode; break; }
    if (goal.parentGoal) {
      const parent = goalManager.get(goal.parentGoal);
      if (parent?.status === GOAL_STATUS.SUSPENDED) goalManager.resume(parent.id);
    }
  }
  goalManager.flush();
  // Le connessioni keep-alive di fetch tengono vivo il processo: esci esplicitamente.
  process.exit(exitCode);
}

// In session mode un SIGTERM/SIGINT deve salvare la coda prima di uscire.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { goalManager.flush(); process.exit(0); });
}

await main();
