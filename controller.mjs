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
import {constructionPlannerInstructions, constructionFromText} from './bedrock-construction.mjs';
import {constructionGoalMet} from './construction.mjs';
import {prepareConstructionPlan} from './construction-planning.mjs';
import {nextIdleGoal, isNeedResolved, DEFAULT_AUTONOMY_COOLDOWN_MS, DEFAULT_MAX_AUTONOMOUS_GOALS} from './idle-goals.mjs';
import {nextVillageChore, isChoreResolved, villageSnapshot, DEFAULT_VILLAGE_COOLDOWN_MS, DEFAULT_VILLAGE_MAX_CHORES} from './village-labor.mjs';
import {detectEvents} from './world-events.mjs';
import {emergencyGoalFor, DEFAULT_EMERGENCY_COOLDOWN_MS} from './emergency-goals.mjs';
import {
  buildCriteria, buildDecisionInstructions, collectFulfilled, detectRepeatedAction, dropCountFromText, dropFulfilled, escortFulfilled, filterOptions,
  farmFulfilled, farmOrderFromText, farmOutcome, farmSnapshot, farmStep,
  inventoryMatchingToken, isCollectOrder, isDropOrder, isEquipOrder, isEscortOrder, isSleepOrder, isStopOrder, matchesItemToken, orderItem, tokenInventoryTotal,
  withStickyEscort, withStickyFollow,
  progressFingerprint, waitOnlyReason, DEFAULT_ANTI_LOOP_THRESHOLD, DEFAULT_FARM_MAX_HARVES, DEFAULT_MAX_OPTIONS,
} from './controller-decisions.mjs';
import {toldIntentFromText, TELL, CLARIFY, formatPosition, dimensionLabel} from './memory-chat.mjs';
import {orderGaps, mergeClarifyAnswer, renderClarifyRefusal, restatesOrder, CLARIFY_NEEDS_INPUT} from './human-clarify.mjs';
import {planGreetings, DEFAULT_GREET_RANGE, DEFAULT_GREET_COOLDOWN_MS} from './human-greeting.mjs';
import {orderAck, orderOutcome, lostNotice, escortWaiting, mountWaitingShore, isSelfTriggering, normalizePrefixes, matchChatPrefix, selfPrefixes, renderReply, clampMessage, DEFAULT_REPLY_MAX_LENGTH} from './human-replies.mjs';
import {answerIntent, renderAnswer, renderFarmNothing, renderNoArmor, renderNoDrop, renderNoItem, renderUnrouted, looksLikeQuestion, looksLikeSmallTalk} from './human-questions.mjs';
import {resolveQuestionIntent, DEFAULT_INTENT_TIMEOUT_MS, DEFAULT_INTENT_MIN_P} from './chat-intent.mjs';
import {composeChatReply, chatLlmConfig, compactChatFacts, createChatMemory, reasonRequest} from './chat-llm.mjs';
import {chatLangConfig, t, languageName, LANGS, listAnd} from './chat-i18n.mjs';
import {narrateGoal, DEFAULT_NARRATE_COOLDOWN_MS} from './chat-narration.mjs';
import {runDir} from './run-paths.mjs';
import {withPlanShape, planStep} from './plan-shape.mjs';
import {createPlanTrace} from './plan-trace.mjs';
import {
  parseMissionRequirements, requirementTakeKeys, isProducingKey, producedGrowth,
  depositedStacks, missionRequirementsMet, missionRequirementsState, renderRequirements, addCounts,
  parseForbiddenKeys,
} from './mission-requires.mjs';
// R4: il rifiuto tipizzato del passo. `siblingKeys` prende il vocabolario degli
// intenti dal modulo dichiarato (R0) per trovare le chiavi alternative che
// `/options` ha davvero offerto.
import {failureRecord, failureDisposition, activeStepId, siblingKeys, reviseSteps, refusalEvidence, MAX_STEP_ATTEMPTS} from './step-failure.mjs';
import {optionIntents} from './survival/intents.mjs';
import {systemOneDecideWithRetry} from './system-one.mjs';
import {
  evaluateCriteria, evaluateSurvival, loadSurvivalRules, loadGameplaySkills, loadProgression,
  resolveMilestone, resolveActiveSkill, skillPreferredIntents, verifySkill, buildSkillRecord, appendSkillRecord,
  chooseNeedAction,
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
const CONSTRUCTION = envJson('CONSTRUCTION', null);
const CONSTRUCTION_AUTHORIZED_CONTAINERS = envJson('CONSTRUCTION_AUTHORIZED_CONTAINERS', []);
const CONSTRUCTION_DESIGN_TIMEOUT = +(process.env.CONSTRUCTION_DESIGN_TIMEOUT_MS || 300000);
const MAX_STEPS = +(process.env.MAX_STEPS || 20);
// Un ordine umano che arriva mentre un goal gira non lo riorienta: il goal va in
// SUSPENDED e l'ordine diventa un goal figlio a priorità CHAT, che al termine lo
// riprende. Questo è il tetto della pila (un ordine dentro un ordine dentro un
// ordine): oltre il tetto l'ordine riorienta il goal in corso invece di
// annidarsi, così una raffica di ordini non costruisce una catena illimitata di
// goal sospesi.
const MAX_GOAL_DEPTH = +(process.env.MAX_GOAL_DEPTH || 3);
// Un ordine "seguimi" aperto non deve girare a vuoto: se `follow_player` riesce
// all'istante (l'umano e' gia' li') il passo successivo attende questo intervallo
// invece di interrogare l'harness in un ciclo stretto.
const FOLLOW_IDLE_POLL_MS = +(process.env.FOLLOW_IDLE_POLL_MS || 3000);
// "Wolf recovery": quando `follow_player` non e' piu' offerto l'umano e' uscito
// dalla vista. L'ordine resta aperto: per due passi consecutivi il bot insiste
// (cerca l'ultima posizione nota, poi aspetta) e solo dopo dice qualcosa in
// chat. Un buco di tracking di un secondo non merita un messaggio: il messaggio
// e' l'ultima risorsa, non la prima.
const LOST_NOTICE_AFTER_STEPS = +(process.env.LOST_NOTICE_AFTER_STEPS || 2);
const LOST_NOTICE_COOLDOWN_MS = +(process.env.LOST_NOTICE_COOLDOWN_MS || 120000);
// Anche la scorta avvisa quando si ferma ad aspettare ("sono a x, y, z"): non e'
// un annuncio di stato ma l'unica cosa che l'umano rimasto indietro non puo'
// vedere da solo. Un messaggio per episodio d'attesa e lo stesso cooldown per
// entrambi i casi (umano dietro, umano fuori vista), cosi' un'attesa lunga non
// diventa una raffica di righe in chat.
const ESCORT_WAITING_COOLDOWN_MS = +(process.env.ESCORT_WAITING_COOLDOWN_MS || 60000);
// L'umano sta salpando e il bot e' rimasto a riva: qui il messaggio non dice
// solo dove si trova (come la scorta), dice anche *cosa* non e' riuscito a fare.
// Stesso schema: uno per episodio d'attesa, con cooldown, riarmato quando il
// quadro cambia (l'umano sbarca, il mezzo si libera, il bot sale).
const MOUNT_WAITING_COOLDOWN_MS = +(process.env.MOUNT_WAITING_COOLDOWN_MS || 60000);
// Quanto si aspetta, a passi fermi, che l'umano perso torni: oltre questo tetto
// l'ordine viene rilasciato (il bot non resta immobile per sempre).
const LOST_HOLD_MAX_STEPS = +(process.env.LOST_HOLD_MAX_STEPS || 120);
const CONTROLLER = process.env.CONTROLLER || 'jev';
const JEV_MODEL = process.env.JEV_MODEL || (process.env.TYPESAFE_API_KEY ? 'jev-latest' : 'typesafe/jev-1.13');
const REPLAN_EVERY = +(process.env.REPLAN_EVERY || 8);
// M14: requisiti di missione («prodotto in questo run», non «trovato in uno
// scrigno»). `MUST_MINE=diamond:2` toglie `take_diamond` dalle opzioni e
// impedisce al goal di chiudere finche' non sono minati; `MUST_DEPOSIT`
// richiede anche che siano usciti verso un contenitore. Vuoti = comportamento
// di prima (l'inventario basta), per non cambiare le altre missioni.
const MUST_MINE = parseMissionRequirements(process.env.MUST_MINE);
const MUST_DEPOSIT = parseMissionRequirements(process.env.MUST_DEPOSIT);
const MISSION_REQUIREMENTS = {mustMine: MUST_MINE, mustDeposit: MUST_DEPOSIT};
const MISSION_REQUIREMENTS_ON = Object.keys(MUST_MINE).length > 0 || Object.keys(MUST_DEPOSIT).length > 0;
// M15: le chiavi che la missione vieta al decider per **tutta** la durata del
// run (`MISSION_FORBID=mount_donkey,mount_horse,throw_egg`). Non e' un divieto
// del mondo — la validita' resta del harness — ma un mandato: il modello non
// deve poterle scegliere, nemmeno al passo dopo il rifiuto che le aveva
// escluse per un passo solo. Vuoto = comportamento di prima.
const MISSION_FORBID = parseForbiddenKeys(process.env.MISSION_FORBID);
const MISSION_FORBID_MAX_STEPS = +(process.env.MISSION_FORBID_MAX_STEPS || 6);
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
// M6.2: il bot risponde anche al proprio nome. `observe().self` espone
// `username` (`BEDROCK_USERNAME`, noto all'avvio) e `name` (il gamertag che il
// server attribuisce al bot, imparato dall'eco in `selfName`): il secondo arriva
// solo a runtime, quindi i prefissi si compongono a ogni osservazione. Con più
// bot sullo stesso server ognuno risponde al proprio nome; `CHAT_SELF_NAME=off`
// spegne i nomi e lascia solo `CHAT_PREFIXES`.
const CHAT_SELF_NAME = (process.env.CHAT_SELF_NAME ?? 'on').toLowerCase() !== 'off';
function chatPrefixes (observation = null) {
  return normalizePrefixes([...CHAT_PREFIXES, ...selfPrefixes(observation?.self, {enabled: CHAT_SELF_NAME})]);
}
const humanCommandSeen = new Set(); // dedup: un comando già eseguito non si ripete
const ignoredChatSeen = new Set(); // dedup della telemetria: un messaggio rifiutato si logga una volta
const reasonCooldown = new Map(); // M11: ultimo ragionamento per mittente
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
// Lingua della chat (M7.2): `CHAT_LANG` sceglie il catalogo dei messaggi
// deterministici (`chat-i18n.mjs`, it/en/fr/es/de). Default italiano, che è il
// comportamento storico del server. Un valore non supportato non spegne nulla:
// si torna al default e lo si dice una volta, perché un refuso silenzioso è
// peggio di un warning. La lingua **non** dipende dall'LLM: il percorso
// deterministico parla la lingua configurata anche senza chiave.
const CHAT_LANG_CONF = chatLangConfig(process.env);
const CHAT_LANG = CHAT_LANG_CONF.lang;
if (CHAT_LANG_CONF.requested && !CHAT_LANG_CONF.supported) {
  console.warn(`CHAT_LANG="${CHAT_LANG_CONF.requested}" non supportata (${LANGS.join(', ')}): uso "${CHAT_LANG}"`);
} else if (CHAT_LANG_CONF.requested) {
  console.log(`CHAT LANG ${CHAT_LANG} (${languageName(CHAT_LANG, {native: true})})`);
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
const CHAT_GREET_TEMPLATE = process.env.CHAT_GREET_TEMPLATE || t(CHAT_LANG, 'greet');
const greetedHumans = new Map(); // gamertag minuscolo -> timestamp ultimo saluto
// Risposta in chat (M5): il bot conferma l'ordine accettato e, alla chiusura del
// goal, ne comunica l'esito al mittente. Come il saluto, è attiva solo se il
// canale ordini è aperto; un ordine già confermato una volta non si ripete
// (dedup in `humanCommandSeen`).
const CHAT_REPLY = process.env.CHAT_REPLY == null
  ? (CHAT_CONTROL !== 'off' && CHAT_ALLOWLIST.size > 0)
  : /^(1|on|true|yes)$/i.test(process.env.CHAT_REPLY);
const CHAT_REPLY_MAX_LENGTH = +(process.env.CHAT_REPLY_MAX_LENGTH || DEFAULT_REPLY_MAX_LENGTH);
// Quanto aspettare e ritentare quando l'harness risponde `rate_limited`: il bot
// parla al massimo una volta al secondo, e un esito perso e' una bugia per
// omissione (vedi `replyChat`).
const CHAT_REPLY_RETRY_MS = +(process.env.CHAT_REPLY_RETRY_MS || 1200);
const CHAT_REPLY_RETRY_MAX_MS = +(process.env.CHAT_REPLY_RETRY_MAX_MS || 4000);
// Annuncio in autonomia (M8): quando parte un goal che nessuno ha chiesto, il bot
// dice cosa sta per fare ("In autonomia: sto raccogliendo le patate") invece di
// sparire nel silenzio. Una volta per goal, con cooldown, e solo se un umano è
// davvero a portata d'orecchio: e' informazione, non un diario. La frase nasce
// dal catalogo (5 lingue) e passa da `saySmart`, quindi il modello può
// riformularla ma non aggiunge fatti né sceglie la lingua.
const CHAT_NARRATE = process.env.CHAT_NARRATE == null
  ? CHAT_REPLY
  : /^(1|on|true|yes)$/i.test(process.env.CHAT_NARRATE);
const CHAT_NARRATE_COOLDOWN_MS = process.env.CHAT_NARRATE_COOLDOWN_MS == null
  ? DEFAULT_NARRATE_COOLDOWN_MS
  : +(process.env.CHAT_NARRATE_COOLDOWN_MS);
const narratedGoals = new Set(); // goalId già annunciati (limitato da rememberSeen)
let lastNarrationAt = 0;
// Domande in chat (M6/M6.1): un messaggio che chiede un fatto sul bot ("dove sei",
// "che fai", "quanti dirt hai") riceve una risposta deterministica dai dati
// dell'harness — nessun goal creato, quindi un goal in corso continua a girare.
// La regex risponde da sola a quello che riconosce; per il resto si chiede a
// System One (Jev) solo se il messaggio *sembra* una domanda (`?` o prima parola
// interrogativa): un ordine non paga mai una chiamata di rete né i suoi 4 s di
// latenza prima dell'ack. Un router assente (nessuna chiave, `off`, timeout,
// errore, bassa probabilità) non trasforma mai una domanda in un ordine: il bot
// dice che non ha capito e non crea alcun goal. `CHAT_INTENT=off` lascia attiva
// la sola regex.
const CHAT_INTENT_KEY = Boolean(process.env.TYPESAFE_API_KEY || process.env.OPENROUTER_API_KEY);
const CHAT_INTENT = process.env.CHAT_INTENT || (CHAT_INTENT_KEY ? 'on' : 'off');
const CHAT_INTENT_ON = /^(1|on|true|yes)$/i.test(CHAT_INTENT);
// Perché il router è indisponibile: `no_key` e `disabled` sono cause diverse, e
// `chat_unrouted.reason` deve poterle distinguere (M7 si guida coi dati).
const CHAT_INTENT_DISABLED_REASON = CHAT_INTENT_KEY ? 'disabled' : 'no_key';
const CHAT_INTENT_MODEL = process.env.CHAT_INTENT_MODEL || null;
const CHAT_INTENT_URL = process.env.CHAT_INTENT_URL || null;
const CHAT_INTENT_TIMEOUT_MS = +(process.env.CHAT_INTENT_TIMEOUT_MS || DEFAULT_INTENT_TIMEOUT_MS);
const CHAT_INTENT_MIN_P = process.env.CHAT_INTENT_MIN_P == null ? DEFAULT_INTENT_MIN_P : +(process.env.CHAT_INTENT_MIN_P);
// M7: chat naturale. L'LLM (DeepSeek per default) riformula le risposte che il
// controller ha già composto; senza chiave (`DEEPSEEK_API_KEY` /
// `CHAT_LLM_API_KEY`) o con `CHAT_LLM=off` tutto resta deterministico.
const CHAT_LLM = chatLlmConfig();
const CHAT_LLM_ON = CHAT_LLM.enabled;
// M11 «ragiona»: l'umano può chiedere una risposta *ragionata* invece di una
// frase del catalogo. Il marcatore (`DEFAULT_REASON_MARKERS`) viene tolto dal
// messaggio; se il resto è una domanda, la risposta la compone M7 dai fatti
// (`observe()` + la memoria delle azioni), senza passare dalle frasi fatte del
// router. Non tocca mai le azioni: un ordine resta un ordine anche con «ragiona»
// in mezzo. Attivo solo dove M7 è configurato (senza chiave non c'è nessun
// ragionamento da chiedere) e con un cooldown per mittente: una risposta libera
// costa una chiamata al modello.
const CHAT_REASON_ON = process.env.CHAT_REASON == null
  ? CHAT_LLM_ON
  : /^(1|on|true|yes)$/i.test(process.env.CHAT_REASON);
const CHAT_REASON_COOLDOWN_MS = +(process.env.CHAT_REASON_COOLDOWN_MS || 5000);
const CHAT_REASON_MARKERS = (process.env.CHAT_REASON_MARKERS || '').split(',').map(word => word.trim().toLowerCase()).filter(Boolean);
// Memoria conversazionale per mittente: solo in RAM, bounded. Serve a non
// ripetere la stessa frase e a capire i seguiti ("e ora?", "grazie").
const chatMemory = createChatMemory();
// Fallback deterministico dello small talk (usato senza LLM): una riga, mai
// scatenante. Con l'LLM è solo il testo di appoggio (`grounding`).
const CHAT_SMALLTALK_TEMPLATE = process.env.CHAT_SMALLTALK_TEMPLATE || t(CHAT_LANG, 'smalltalk');
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
// Lavoro di villaggio: in IDLE il bot si rende utile (coltivazioni, animali,
// legname, pietra, pesca, deposito). Default: come AUTONOMY — chi ha scelto di
// stare fermo (`AUTONOMY=off`) non si mette a lavorare da solo; `VILLAGE_WORK=on`
// lo riaccende senza abilitare l'autonomia generale.
const VILLAGE_WORK = process.env.VILLAGE_WORK == null ? AUTONOMY : /^(1|on|true|yes)$/i.test(process.env.VILLAGE_WORK);
const VILLAGE_COOLDOWN_MS = +(process.env.VILLAGE_COOLDOWN_MS || DEFAULT_VILLAGE_COOLDOWN_MS);
const VILLAGE_MAX_CHORES = +(process.env.VILLAGE_MAX_CHORES || DEFAULT_VILLAGE_MAX_CHORES);
const VILLAGE_STORE_THRESHOLD = +(process.env.VILLAGE_STORE_THRESHOLD || 8);
// M3c — l'epilogo del goal produttivo: chi ha raccolto, riporta. Default: segue
// il lavoro di villaggio (un bot che non lavora non ha niente da riporre).
const VILLAGE_STORE_EPILOGUE = process.env.VILLAGE_STORE_EPILOGUE == null ? VILLAGE_WORK : /^(1|on|true|yes)$/i.test(process.env.VILLAGE_STORE_EPILOGUE);
// Bisogni di sopravvivenza: in IDLE un bisogno che il governor dichiara
// *adesso* genera un goal anche con AUTONOMY off — l'autonomia e' inventarsi
// obiettivi, dormire di notte con un letto a due passi e' la policy di
// sopravvivenza (`knowledge/survival-rules.json`). Cooldown piu' corto di
// quello dell'autonomia: la notte dura pochi minuti e non si aspetta.
const SURVIVAL_IDLE_COOLDOWN_MS = +(process.env.SURVIVAL_IDLE_COOLDOWN_MS || 30000);
// Emergenze (milestone 2): un evento del mondo può sospendere il goal in corso e
// avviarne uno a priorità 100 (es. morte -> recupero loot). Default: attivo in
// modalità sessione.
const EMERGENCY = process.env.EMERGENCY == null ? SESSION : /^(1|on|true|yes)$/i.test(process.env.EMERGENCY);
const EMERGENCY_COOLDOWN_MS = +(process.env.EMERGENCY_COOLDOWN_MS || DEFAULT_EMERGENCY_COOLDOWN_MS);

// `RUNS_DIR` per consegnare il ledger all'host anche quando il harness gira in un
// container (run-paths.mjs): il controller gira sull'host e legge la stessa
// variabile, così run e ledger restano nella stessa cartella.
const RUN_DIR = runDir(RUN);
mkdirSync(RUN_DIR, {recursive: true});
const SKILLS_LOG = `${RUN_DIR}/skills.jsonl`;
const log = (type, data) => appendFileSync(`${RUN_DIR}/controller.jsonl`, JSON.stringify({t: Date.now(), type, ...data}) + '\n');
// R3: la traccia del piano. Una riga per segmento di piano in
// `runs/<run>/plan-trace.jsonl` — vedi plan-trace.mjs per il formato.
// `runProgress` e' lo specchio dei contatori di `runGoal` per il gestore dei
// segnali: `stepsUsed` e `totalCost` sono locali di quel ciclo, e il gestore
// SIGTERM vive fuori. Prima del 07/10/2026 leggeva quei due nomi e moriva con
// `ReferenceError: stepsUsed is not defined`, quindi una run uccisa non
// lasciava ne' `run_end` ne' la traccia (trovato dai golden R6, scenario G4).
const runProgress = {steps: 0, cost: 0};
// M14: quanto il run ha **prodotto** e **depositato**, per oggetto. Vive fuori
// dal goal perche' le preemption umane non devono azzerarlo: un requisito di
// missione e' del run, non di un segmento.
const requirementProgress = {mined: {}, deposited: {}};
const planTrace = createPlanTrace({dir: RUN_DIR});
const api = async (method, path, body) => {
  const r = await fetch(HARNESS + path, {method, body: body ? JSON.stringify(body) : undefined, headers: {'Content-Type': 'application/json', Connection: 'close'}});
  return r.json();
};
const publishPlan = async plan => {
  plan = await prepareConstructionPlan(plan, { explicitTemplate: !!CONSTRUCTION,
    authorizedContainers: CONSTRUCTION?.authorizedContainers ?? CONSTRUCTION_AUTHORIZED_CONTAINERS,
    brief: plan.construction?.brief ?? plan.construction?.design?.intent?.request ?? plan.objective,
    observation: plan.construction && !plan.construction.projectId ? await api('GET', '/observe') : null,
    ask: prompt => runHermes(prompt, { timeoutMs: CONSTRUCTION_DESIGN_TIMEOUT }),
    preview: construction => api('POST', '/construction/preview', construction) });
  const response = await api('POST', '/plan', plan);
  if (response.ok === false || response.error) throw new Error(`plan_rejected: ${response.error ?? 'invalid plan'}`);
  return response.plan ?? plan;
};

// ---- Goal Manager (Agent Core, milestone 1) --------------------------------------------------
// Ogni attività è un goal con fonte, priorità e stato. La coda è persistita
// nello stesso formato dei repository della world memory (kind: 'goal') in una
// directory separata da quella dell'harness, così i due processi non competono
// sullo stesso file.
const goalStore = new JsonMemoryRepository({dir: `${RUN_DIR}/goals`, logger: null}).load();
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
let villageGoalCount = 0;                // lavori di villaggio generati in questa sessione (cap)
const villageAttempts = new Map();       // chore -> ultimo tentativo (anti-loop in IDLE)
const storeEpilogues = new Set();        // goal produttivi già serviti dallo scarico di fine task (M3c)
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

// R5: uno step del curriculum e' un milestone con la skill che lo chiude. La
// forma e' quella di R1 (`planStep`: skill, circuito, targets, criteri), con
// l'id del **milestone** — in una catena il passo e' il milestone — e i criteri
// dichiarati dal milestone (`satisfiedWhen`) uniti a quelli della skill. La
// scelta dell'azione resta di `/options`: qui non entra nessuna key.
function milestoneStep (entry) {
  const base = planStep({ skill: entry.skill, objective: entry.description, targets: {} }, gameplaySkills);
  return {
    ...base,
    id: entry.id,
    milestone: entry.id,
    verify: [...new Set([...base.verify, ...(entry.verify || [])])].sort(),
  };
}

// Piano deterministico da un risultato del progression engine.
function planFromMilestone (result) {
  if (result?.status !== 'next' || !result.skill) return null;
  const def = gameplaySkills.get(result.skill);
  // R5: il piano dichiara **tutta** la catena mancante (`result.steps`), in
  // ordine di dipendenza; il primo e' il passo attivo (`plan.skill`), gli altri
  // sono la previsione — il motore la ricalcola dopo ogni milestone chiuso, e
  // una deviazione del mondo la riscrive senza cerimonie.
  const steps = (result.steps || []).map(milestoneStep);
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
    ...(steps.length ? { steps } : {}),
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

function runHermes(prompt, { timeoutMs = HERMES_TIMEOUT } = {}) {
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
    }, timeoutMs);
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
    'You are the PLANNER for a Minecraft bot. Return ONLY a JSON object {"objective": string, "subgoal": string | null, "targets": {item: minCount}, "waypoint": {"x":int,"z":int} | null, "skill": string | null, "notes": string}.',
    `Overall goal: ${GOAL}`,
    constructionPlannerInstructions(),
    CURRICULUM ? `Overall progression milestone: ${CURRICULUM} (the progression engine verifies it deterministically)` : '',
    curriculumHint?.status === 'next' ? `Suggested next milestone from the progression engine: ${curriculumHint.milestone} (skill "${curriculumHint.skill}"). Use it unless the observation clearly calls for something else.` : '',
    WAYPOINT ? `Required waypoint (keep it unless reached): ${JSON.stringify(WAYPOINT)}` : '',
    `Required targets: ${JSON.stringify(TARGETS)}`,
    `Optional "skill" field, one of the declarative gameplay skills: ${skillList}. Use it when the objective matches one of them; it is verified against harness state, not by you.`,
    'Optional "subgoal" field: the current chunk of the objective, one short phrase (the controller derives it from the skill when you set one). It is not a second objective.',
    provenHintLines(observation),
    recall,
    'The harness exposes the currently valid actions (typical keys: goto_waypoint, dig_down, mine_<block>, collect_drop, craft_<item>, place_<item>, eat, flee, sleep, wait); the controller will pick one of them. Keep the objective to one sentence the controller can act on now.',
    `Observation: ${JSON.stringify(observation)}`,
  ].filter(Boolean).join('\n');
  const started = Date.now();
  const out = await runHermes(prompt);
  if (out == null) {
    const construction = CONSTRUCTION ?? constructionFromText(GOAL, observation);
    const plan = {objective: GOAL, targets: construction ? {} : TARGETS, waypoint: WAYPOINT, ...(construction ? {construction} : {}), source: 'hermes', notes: 'hermes unavailable; static fallback plan'};
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
  plan.construction = CONSTRUCTION ?? plan.construction ?? constructionFromText(GOAL, observation);
  if (plan.construction) { plan.targets = {}; plan.construction.brief ??= GOAL; }
  // R3: la provenienza del piano. `source` non e' chi l'ha chiesto (questo lo
  // dicono i `notes: human:<from>`), e' chi l'ha prodotto.
  if (!plan.source) plan.source = 'hermes';
  log('plan', {plan, ms: Date.now() - started});
  return plan;
}

// In modalità curriculum il piano è deterministico; Hermes resta il fallback
// per gli errori del motore e per le situazioni ambigue.
async function planForStep (observation, reason, goal = null) {
  if (CONSTRUCTION) return {objective: GOAL, targets: {}, construction: CONSTRUCTION, source: 'construction'};
  if (CURRICULUM) {
    const milestone = nextMilestone(observation);
    if (milestone.status === 'met') return {met: true};
    const declared = planFromMilestone(milestone);
    if (declared) {
      const plan = {...declared, source: 'curriculum'};
      log('plan', {plan, ms: 0, curriculum: true, reason});
      return plan;
    }
    log('curriculum_fallback', {reason, milestone});
  }
  const recall = await semanticRecall(goal);
  const plan = await hermesPlan(observation, {recall: semanticRecallLines(recall.hits)});
  return applySemanticWaypoint(plan, recall);
}

// ---- R1: la forma del piano ---------------------------------------------------------------
// Un solo punto dove `objective -> subgoal -> steps[]` viene derivato dagli
// artefatti dichiarativi (skill e progression). Additivo: se un produttore ha
// gia' messo `subgoal`/`steps`, `withPlanShape` non li sovrascrive.
function shapedPlan (plan) {
  return withPlanShape(plan, { skills: gameplaySkills, milestones: progressionGraph.milestones });
}

// ---- comando umano via chat (M1-M3) ---------------------------------------------------------
function isAllowedSender (entry) {
  if (!CHAT_ALLOWLIST.size) return false;
  if (entry.from && CHAT_ALLOWLIST.has(entry.from.toLowerCase())) return true;
  if (entry.xuid && CHAT_ALLOWLIST.has(entry.xuid)) return true;
  return false;
}

// ---- fatti dettati (told facts) ---------------------------------------------------------------
// Ricorda / consulta / correggi / dimentica, più «vai al <luogo nominato>». Il
// riconoscimento è deterministico (memory-chat.mjs) e le frasi escono dal catalogo
// (chat-lang/*): i numeri *sono* l'informazione, quindi qui il modello non
// riformula e non decide cosa il bot sa. Nessuna di queste operazioni interrompe il
// goal in corso; «vai al campo di patate» è un ordine di movimento come gli altri
// (preemption e ripresa normali).
const TOLD_FACTS = process.env.TOLD_FACTS !== 'off';

// R2 (07/10/2026): la porta della chiarificazione. Un ordine che chiede una meta
// e non ne porta una non diventa un goal: si chiede **una volta** la cosa che
// solo l'umano può decidere, e la risposta chiude l'ordine (non ne apre uno
// nuovo). `off` è l'interruttore di sicurezza: la porta sparisce e ogni ordine
// torna al comportamento di prima (fallback del planner).
const CHAT_CLARIFY_ON = (process.env.CHAT_CLARIFY ?? 'on').toLowerCase() !== 'off';

// La memoria dei luoghi, vista dalla porta. Il controller non ha accesso al
// `WorldMemory` (vive nell'harness): chiede per HTTP, come per i fatti dettati.
// Un errore o una rotta giù valgono `null`, e la porta non chiede (fail-open).
const clarifyMemory = {
  async places (name, {limit = 5} = {}) {
    const out = await api('GET', `/memory/places?name=${encodeURIComponent(name)}&limit=${limit}`);
    if (!out || out.error) return {error: out?.error ?? 'memory_unavailable'};
    return {places: Array.isArray(out.places) ? out.places : []};
  },
};

// Il motivo per cui la frase non si è potuta scrivere → la domanda da fare. Un
// comando riconosciuto e incompleto non scrive niente: chiede.
const CLARIFY_TOLD = Object.freeze({
  no_name: 'told_ask_name',
  no_position: 'told_ask_position',
  no_marker: 'told_ask_marker',
  no_sender_position: 'told_no_sender_position',
});

// La posizione viva del mittente: «questo è il campo di patate» vale dove sta lui
// adesso. Se non è in vista non si indovina — si chiedono le coordinate.
function senderPlace (obs, from) {
  const name = String(from ?? '').toLowerCase();
  if (!name) return null;
  const human = (obs?.humans || []).find(h => String(h.username ?? '').toLowerCase() === name);
  const entity = human ?? (obs?.entities || []).find(e => e.kind === 'player' && String(e.username ?? '').toLowerCase() === name);
  if (!entity?.position) return null;
  return {
    position: {x: Math.round(entity.position.x), y: Math.round(entity.position.y), z: Math.round(entity.position.z)},
    dimension: obs?.dimension ?? 'overworld',
  };
}

// Risposta di memoria: testo dal catalogo, senza passare dall'LLM (`saySmart` lo
// riformulerebbe, e una conferma di scrittura deve dire esattamente cosa è stato
// scritto). L'umano è ringraziato col contatto nella memoria conversazionale, così
// le risposte successive restano coerenti.
async function toldSay (entry, {message, prefixes, key, vars = {}}) {
  // Come ogni risposta del canale, la riga è *indirizzata* al mittente (M5):
  // il destinatario deve sapere che la conferma è per lui.
  const body = renderReply(t(CHAT_LANG, key, {name: entry.from ?? '', ...vars}), {}, CHAT_REPLY_MAX_LENGTH);
  const text = entry.from && !body.startsWith('@') ? clampMessage(`@${entry.from} ${body}`, CHAT_REPLY_MAX_LENGTH) : body;
  await replyChat(text, {to: entry.from, context: 'told', prefixes});
  chatMemory.remember(entry.from, message, text);
  return text;
}

// La domanda della chiarificazione: testo dal catalogo, come per i fatti dettati
// (i numeri e i nomi *sono* l'informazione, e una domanda riformulata dall'LLM
// perderebbe l'esempio che l'umano deve imitare). La domanda si registra
// nell'inbox dell'harness: la risposta arriverà come *messaggio successivo* dello
// stesso mittente, e sarà l'inbox a dire che non è un ordine nuovo.
async function clarifySay (entry, {message, prefixes, orderId, question, field = null, reason = null, originalText = null}) {
  const body = renderReply(question, {}, CHAT_REPLY_MAX_LENGTH);
  const text = entry.from && !body.startsWith('@') ? clampMessage(`@${entry.from} ${body}`, CHAT_REPLY_MAX_LENGTH) : body;
  // Prima si deposita la domanda, poi si parla: se il bot non riuscisse a
  // scrivere, la risposta dell'umano verrebbe comunque riconosciuta.
  const stored = await api('POST', '/chat/ask', {
    from: entry.from,
    xuid: entry.xuid ?? null,
    orderId,
    originalText: originalText ?? message,
    question,
    field,
    reason,
  });
  await replyChat(text, {to: entry.from, context: 'clarify', prefixes});
  chatMemory.remember(entry.from, message, text);
  return {text, stored: stored?.ok === true};
}

// Un nome che vale per più di un posto non si risolve: si chiede quale. Mai il
// più vicino — la distanza non è una risposta a "quale intendi?".
function toldOptionLine (place) {
  return `${place.label ?? place.id} a ${formatPosition(place.position)} (${dimensionLabel(place.dimension)})`;
}

async function toldAmbiguous (entry, {message, prefixes, intent, candidates, log}) {
  const name = intent.name ?? intent.container ?? '';
  const options = listAnd(candidates.map(toldOptionLine), CHAT_LANG);
  await toldSay(entry, {message, prefixes, key: 'told_ambiguous', vars: {count: candidates.length, name, options}});
  log('tell_ambiguous', {from: entry.from, xuid: entry.xuid, name, count: candidates.length, candidates: candidates.map(c => c.id)});
  return true;
}

// La memoria non risponde (rotta giù, scrittura rifiutata): si dice, non si finge.
async function toldUnavailable (entry, {message, prefixes, err, log}) {
  const reason = err?.error ?? err?.message ?? 'unknown';
  await toldSay(entry, {message, prefixes, key: 'told_memory_unavailable', vars: {reason}});
  log('tell_memory_unavailable', {from: entry.from, xuid: entry.xuid, reason});
  return true;
}

// Un luogo risolto per nome: `null` se non c'è (allora non si scrive e non si
// naviga), `{ambiguous: true}` se ce n'è più d'uno (si chiede).
// `_obs` per firma uniforme con gli altri `told*`: questa risoluzione legge il
// registro dei luoghi, non l'osservazione.
async function toldResolve (_obs, entry, {message, prefixes, intent, log}) {
  const name = intent.name ?? intent.container ?? '';
  const out = await api('GET', `/memory/places?name=${encodeURIComponent(name)}&limit=10`);
  if (out?.error) return {error: out.error};
  const places = Array.isArray(out?.places) ? out.places : [];
  if (places.length > 1) {
    await toldAmbiguous(entry, {message, prefixes, intent, candidates: places, log});
    return {ambiguous: true};
  }
  return {place: places[0] ?? null};
}

// «Dov'è il campo di patate?» / «Dove posso trovare ferro?» — prima il luogo, poi
// la risorsa: il nome del luogo può contenere la parola della risorsa ("campo di
// patate") e la scelta non è del parser. La provenienza viaggia nella risposta:
// l'umano deve sapere se il bot l'ha visto o se gliel'hanno detto.
// La vena più vicina che il bot vede *adesso* (`obs.ores`). Il nome del blocco
// (`deepslate_diamond_ore`) e l'id dell'item (`diamond`, `lapis_lazuli`) non
// coincidono: si confronta il nucleo del nome del blocco con quello dell'item,
// così «diamanti» trova `diamond_ore` e «lapis» trova `deepslate_lapis_ore`.
function nearestLiveOre (obs, intent) {
  const coreOf = (name) => String(name ?? '').replace(/^deepslate_/, '').replace(/_ore$/, '').split('_')[0];
  const want = coreOf(intent?.item);
  if (!want) return null;
  const hits = (Array.isArray(obs?.ores) ? obs.ores : []).filter((ore) => coreOf(ore?.name) === want);
  if (!hits.length) return null;
  return hits.slice().sort((a, b) => (a?.distance ?? Infinity) - (b?.distance ?? Infinity))[0];
}

async function toldConsult (obs, entry, {message, prefixes, intent, log}) {
  if (intent.name) {
    const resolved = await toldResolve(obs, entry, {message, prefixes, intent, log});
    if (resolved.error) return toldUnavailable(entry, {message, prefixes, err: {error: resolved.error}, log});
    if (resolved.ambiguous) return true;
    const place = resolved.place;
    if (place) {
      const source = place.source === 'told' ? t(CHAT_LANG, 'told_source_told') : '';
      await toldSay(entry, {message, prefixes, key: 'told_where_place', vars: {
        label: place.label ?? place.id,
        pos: formatPosition(place.position),
        dimension: dimensionLabel(place.dimension),
        source,
      }});
      log('tell_where_place', {from: entry.from, xuid: entry.xuid, id: place.id, name: intent.name, source: place.source});
      return true;
    }
    // Un nome che la memoria non conosce non si indovina: se la frase chiedeva
    // anche una risorsa si prova quella, altrimenti si dice che non lo sa.
    if (!intent.item) {
      await toldSay(entry, {message, prefixes, key: 'told_unknown_place', vars: {name: intent.name}});
      log('tell_unknown_place', {from: entry.from, xuid: entry.xuid, name: intent.name});
      return true;
    }
  }
  if (intent.item) {
    // Prima la vena che il bot *vede adesso*: «dimmi le coordinate dei diamanti»
    // vuole un posto da minare, e il ricordo di un baule lontano non è quella
    // risposta. Caso live 07/10/2026: alla domanda il bot rispondeva con le
    // proprie coordinate (router delle domande) e poi con un baule a 60 blocchi;
    // l'utente: «ho chiesto la posizione dei diamanti e invece il bot mi ha
    // comunicato le sue coordinate».
    const ore = nearestLiveOre(obs, intent);
    if (ore) {
      const distance = ore.distance != null ? Math.round(ore.distance) : Math.round(Math.hypot(
        (obs?.position?.x ?? 0) - (ore.position?.x ?? 0),
        (obs?.position?.y ?? 0) - (ore.position?.y ?? 0),
        (obs?.position?.z ?? 0) - (ore.position?.z ?? 0),
      ));
      await toldSay(entry, {message, prefixes, key: 'told_ore_near', vars: {
        ore: ore.name,
        pos: formatPosition(ore.position),
        dimension: dimensionLabel(obs?.dimension),
        distance,
        source: t(CHAT_LANG, 'told_source_seen'),
      }});
      log('tell_where_ore', {from: entry.from, xuid: entry.xuid, item: intent.item, word: intent.word ?? null, ore: ore.name, position: ore.position, distance: ore.distance ?? null});
      return true;
    }
    const out = await api('GET', `/memory/where?item=${encodeURIComponent(intent.item)}&limit=5`);
    if (out?.error) return toldUnavailable(entry, {message, prefixes, err: out, log});
    const hits = Array.isArray(out?.hits) ? out.hits : [];
    if (!hits.length) {
      await toldSay(entry, {message, prefixes, key: 'told_where_none', vars: {item: intent.word ?? intent.item}});
      log('tell_where_none', {from: entry.from, xuid: entry.xuid, item: intent.item, word: intent.word ?? null});
      return true;
    }
    const best = hits[0];
    const label = best.label ?? (best.kind === 'container' ? t(CHAT_LANG, 'told_noun_container') : best.id);
    const verdict = best.source === 'told'
      ? t(CHAT_LANG, best.claim === 'confirmed' ? 'told_claim_verified' : 'told_claim_unverified')
      : '';
    const source = best.source === 'told' ? t(CHAT_LANG, 'told_source_told') + verdict : t(CHAT_LANG, 'told_source_seen');
    const count = best.count != null ? t(CHAT_LANG, 'told_count', {n: best.count}) : '';
    await toldSay(entry, {message, prefixes, key: 'told_where_item', vars: {
      label,
      pos: formatPosition(best.position),
      dimension: dimensionLabel(best.dimension),
      item: intent.word ?? intent.item,
      count,
      source,
    }});
    log('tell_where_item', {from: entry.from, xuid: entry.xuid, item: intent.item, id: best.id, source: best.source, count: best.count ?? null, claim: best.claim ?? null, hits: hits.length});
    return true;
  }
  return false;
}

// Traduce una frase di memoria in scritture e risposte. Torna `true` se il
// messaggio è stato gestito (già risposto), un piano se è l'ordine di movimento
// verso un luogo nominato, `null` se non è un fatto dettato e la chat deve
// proseguire come prima (domande e ordini di sempre).
async function handleToldFact (obs, entry, {message, prefixes}) {
  if (!TOLD_FACTS) return null;
  const sender = senderPlace(obs, entry.from);
  const intent = toldIntentFromText(message, {sender: sender ? entry.from : null, names: Object.keys(obs?.inventory ?? {})});
  if (!intent) return null;
  const who = {from: entry.from, xuid: entry.xuid};
  const dim = (value) => value ?? obs?.dimension ?? 'overworld';

  if (intent.kind === CLARIFY) {
    const numbers = intent.numbers ?? [];
    await toldSay(entry, {message, prefixes, key: CLARIFY_TOLD[intent.reason] ?? 'told_ask_name', vars: {
      name: intent.name ?? intent.container ?? '',
      x: numbers[0] ?? '', y: numbers[1] ?? '', z: numbers[2] ?? '',
    }});
    log('tell_clarify', {...who, reason: intent.reason, via: intent.via, message});
    return true;
  }

  if (intent.kind === TELL.CONSULT) return toldConsult(obs, entry, {message, prefixes, intent, log});

  // «Vai al campo di patate»: non è una scrittura, è un ordine di movimento. Se il
  // nome non è in memoria il messaggio torna al flusso normale (Hermes e il recall
  // semantico possono avere altre idee), e una scorta resta una scorta.
  if (intent.kind === TELL.GOTO_PLACE) {
    if (isEscortOrder(message, obs)) return null;
    const resolved = await toldResolve(obs, entry, {message, prefixes, intent, log});
    if (resolved.error) return toldUnavailable(entry, {message, prefixes, err: {error: resolved.error}, log});
    if (resolved.ambiguous) return true;
    const place = resolved.place;
    if (!place?.position) return null;
    const name = place.label ?? intent.name;
    const plan = {
      objective: t(CHAT_LANG, 'fallback.goto_told', {name}),
      targets: {},
      waypoint: {x: Math.round(place.position.x), z: Math.round(place.position.z)},
      follow: null,
      notes: `human:${entry.from} told_place:${place.id}`,
      source: 'deterministic',
    };
    log('plan', {plan, ms: 0, source: 'human', deterministic: 'told_goto'});
    return plan;
  }

  if (intent.kind === TELL.FORGET_PLACE) {
    const resolved = await toldResolve(obs, entry, {message, prefixes, intent, log});
    if (resolved.error) return toldUnavailable(entry, {message, prefixes, err: {error: resolved.error}, log});
    if (resolved.ambiguous) return true;
    const place = resolved.place;
    if (!place) {
      await toldSay(entry, {message, prefixes, key: 'told_unknown_place', vars: {name: intent.name}});
      log('tell_unknown_place', {...who, name: intent.name, via: 'forget'});
      return true;
    }
    const out = await api('POST', '/memory/tell/forget', {id: place.id, toldBy: entry.from});
    if (out?.error) return toldUnavailable(entry, {message, prefixes, err: out, log});
    await toldSay(entry, {message, prefixes, key: 'told_forget_ack', vars: {label: place.label ?? intent.name}});
    log('tell_forget', {...who, id: place.id, name: intent.name});
    return true;
  }

  if (intent.kind === TELL.CORRECT_PLACE) {
    // Una correzione conserva identità e storia: si passa per il nome (che è la
    // chiave del luogo) e mai per l'id di un posto che l'umano non ha nominato.
    const resolved = await toldResolve(obs, entry, {message, prefixes, intent, log});
    if (resolved.error) return toldUnavailable(entry, {message, prefixes, err: {error: resolved.error}, log});
    if (resolved.ambiguous) return true;
    const out = await api('POST', '/memory/tell/place', {
      name: intent.name,
      label: resolved.place?.label ?? intent.name,
      position: intent.position,
      dimension: dim(intent.dimension),
      toldBy: entry.from,
      id: resolved.place?.id ?? null,
      requireExisting: true,
    });
    if (out?.error) return toldUnavailable(entry, {message, prefixes, err: out, log});
    if (out.action === 'ambiguous') return toldAmbiguous(entry, {message, prefixes, intent, candidates: out.candidates, log});
    if (out.action !== 'corrected' && out.action !== 'unchanged') {
      await toldSay(entry, {message, prefixes, key: 'told_unknown_place', vars: {name: intent.name}});
      log('tell_unknown_place', {...who, name: intent.name, via: 'correct'});
      return true;
    }
    const previous = out.previous?.position ?? null;
    await toldSay(entry, {message, prefixes, key: previous ? 'told_correct_ack' : 'told_place_ack', vars: {
      label: out.place.label ?? intent.name,
      pos: formatPosition(out.place.position),
      dimension: dimensionLabel(out.place.dimension),
      from: previous ? formatPosition(previous) : '',
    }});
    log('tell_correct', {...who, id: out.place.id, name: intent.name, position: intent.position, dimension: out.place.dimension, previous});
    return true;
  }

  if (intent.kind === TELL.REMEMBER_CONTENTS) {
    const position = intent.position ?? sender?.position ?? null;
    if (!position) {
      await toldSay(entry, {message, prefixes, key: 'told_no_sender_position'});
      log('tell_clarify', {...who, reason: 'no_sender_position', via: 'contents', message});
      return true;
    }
    const out = await api('POST', '/memory/tell/contents', {
      position,
      dimension: dim(intent.dimension),
      item: intent.item,
      count: intent.count ?? null,
      label: intent.container,
      type: intent.containerType,
      toldBy: entry.from,
    });
    if (out?.error) return toldUnavailable(entry, {message, prefixes, err: out, log});
    await toldSay(entry, {message, prefixes, key: 'told_contents_ack', vars: {
      item: intent.word ?? intent.item,
      label: out.container?.label ?? intent.container,
      pos: formatPosition(out.container?.position ?? position),
      dimension: dimensionLabel(out.container?.dimension ?? dim(intent.dimension)),
    }});
    log('tell_contents', {...who, id: out.container?.id ?? null, item: intent.item, count: intent.count ?? null, position, verdict: out.claim?.verdict ?? null});
    return true;
  }

  if (intent.kind === TELL.REMEMBER_CONTAINER) {
    const position = intent.position ?? sender?.position ?? null;
    if (!position) {
      await toldSay(entry, {message, prefixes, key: 'told_no_sender_position'});
      log('tell_clarify', {...who, reason: 'no_sender_position', via: intent.via, message});
      return true;
    }
    // La cassa è la sua posizione: la rotta non tocca il contenuto (un baule
    // nominato non è un baule svuotato).
    const out = await api('POST', '/memory/tell/container', {
      label: intent.label ?? intent.container,
      type: intent.containerType,
      position,
      dimension: dim(intent.dimension),
      toldBy: entry.from,
    });
    if (out?.error) return toldUnavailable(entry, {message, prefixes, err: out, log});
    await toldSay(entry, {message, prefixes, key: 'told_container_ack', vars: {
      label: out.container?.label ?? intent.container,
      pos: formatPosition(out.container?.position ?? position),
      dimension: dimensionLabel(out.container?.dimension ?? dim(intent.dimension)),
    }});
    log('tell_container', {...who, id: out.container?.id ?? null, label: intent.container, position, dimension: out.container?.dimension ?? null});
    return true;
  }

  if (intent.kind === TELL.REMEMBER_PLACE) {
    const label = intent.name;
    const position = intent.position ?? sender?.position ?? null;
    if (!position) {
      await toldSay(entry, {message, prefixes, key: 'told_no_sender_position'});
      log('tell_clarify', {...who, reason: 'no_sender_position', via: intent.via, message});
      return true;
    }
    const out = await api('POST', '/memory/tell/place', {
      name: label,
      label,
      position,
      dimension: dim(intent.dimension),
      toldBy: entry.from,
    });
    if (out?.error) return toldUnavailable(entry, {message, prefixes, err: out, log});
    if (out.action === 'ambiguous') return toldAmbiguous(entry, {message, prefixes, intent, candidates: out.candidates, log});
    if (!out.ok) return toldUnavailable(entry, {message, prefixes, err: {error: out.action ?? 'not_stored'}, log});
    if (out.action === 'corrected' && out.previous?.position) {
      // Lo stesso nome a una posizione diversa è lo stesso posto che si è spostato,
      // non un doppione: la conferma lo dice, così l'umano sa che ha corretto.
      await toldSay(entry, {message, prefixes, key: 'told_correct_ack', vars: {
        label: out.place.label ?? label,
        pos: formatPosition(out.place.position),
        dimension: dimensionLabel(out.place.dimension),
        from: formatPosition(out.previous.position),
      }});
      log('tell_correct', {...who, id: out.place.id, name: label, position, dimension: out.place.dimension, previous: out.previous.position, via: intent.via});
      return true;
    }
    await toldSay(entry, {message, prefixes, key: 'told_place_ack', vars: {
      label: out.place.label ?? label,
      pos: formatPosition(out.place.position),
      dimension: dimensionLabel(out.place.dimension),
    }});
    log('tell_place', {...who, id: out.place.id, name: label, position, dimension: out.place.dimension, kind: 'place'});
    return true;
  }

  return null;
}

// Traduce un comando umano in linguaggio naturale in un piano (come hermesPlan,
// ma con il contesto del mittente: gamertag e posizione viva). Hermes è il
// traduttore; il fallback deterministico è "seguire il mittente".
async function humanCommandPlan (obs, entry) {
  const sender = (obs.entities || []).find(e => e.kind === 'player' && e.username && e.username.toLowerCase() === (entry.from || '').toLowerCase());
  const senderPos = sender?.position ?? null;
  const prompt = [
    'You are the PLANNER for a Minecraft bot. A TRUSTED human player sent you a command in chat. Return ONLY a JSON object {"objective": string, "subgoal": string | null, "targets": {item: minCount}, "waypoint": {"x":int,"z":int} | null, "follow": string | null, "notes": string}.',
    `The human (gamertag "${entry.from}") said: "${entry.message}".`,
    constructionPlannerInstructions(),
    senderPos
      ? `The human is currently at ${JSON.stringify(senderPos)}. If they ask you to follow, stay near, or escort them, set "follow" to "${entry.from}" (exact gamertag) and set "waypoint" to their current XZ position.`
      : 'The human position is not visible right now; if they ask you to follow, still set "follow" to their gamertag.',
    'If they ask you to help fight mobs, set the objective to stay near them and attack nearby hostile mobs (keep "follow" set if escorting).',
    'If they ask you to gather or mine a specific item, put it in "targets". If they ask you to stop or resume autonomy, set "objective" accordingly and leave "follow" null.',
    'Keep the objective to one sentence. The controller picks bounded actions from the harness; never invent action keys.',
    // L'objective finisce in chat (ack, esito, "cosa stai facendo?"): va scritto
    // nella lingua di chi ha scritto e in prima persona, come lo direbbe il bot.
    `Write "objective" in the same language as the human message, in the first person, the way the bot would say it out loud (e.g. "sto andando da ${entry.from}", "mi metto l'armatura"). If the message does not make the language clear, write it in ${languageName(CHAT_LANG, {native: true})}.`,
    `Current state: ${JSON.stringify(obs)}`,
  ].join('\n');
  // "getta i diamanti" / "butta via la terra": ordine deterministico
  // sull'inventario, come l'equipaggiamento. Il planner tradurrebbe "getta" in
  // un *target* (cioe' minare!) e comunque non esiste un'opzione che generi lui
  // per buttare via qualcosa. `word` e' la parola dell'umano ("diamanti"),
  // `token` il nome Minecraft ("diamond"), `count` la quota o null = tutto.
  if (isDropOrder(entry.message, obs)) {
    const item = orderItem(entry.message, obs) ?? {};
    const items = inventoryMatchingToken(obs.inventory, item.token);
    const before = {};
    for (const name of items) before[name] = Number(obs.inventory?.[name] || 0);
    const plan = {
      objective: t(CHAT_LANG, 'fallback.drop', {word: item.word ?? item.token ?? ''}),
      targets: {},
      waypoint: null,
      follow: null,
      drop: {token: item.token ?? null, word: item.word ?? null, count: dropCountFromText(entry.message), items, before, recipient:entry.from},
      notes: `human:${entry.from} drop:${item.token}`,
      source: 'deterministic',
    };
    log('plan', {plan, ms: 0, source: 'human', deterministic: 'drop'});
    return plan;
  }
  // "raccogli le carote" / "mieti il grano e rimpiantalo e mettilo nel baule":
  // mietere una coltura nominata e' un ordine di fattoria — una catena bounded
  // (i drop, la mietitura, la rimpiantatura, il deposito) chiusa su un delta di
  // stato — non un pickup da terra. Il pickup vince solo se il raccolto
  // nominato e' *davvero* a terra: li' l'ordine e' raccogliere quello che si
  // vede, e la cache dei drop e' la prova. Senza questa distinzione le stesse
  // parole davanti a un campo finivano in `no_drop` ("non vedo carote a
  // terra") o in una chiamata al planner che mina al posto di raccogliere.
  const farm = farmOrderFromText(entry.message);
  if (farm && !(obs.drops || []).some(d => d.item && matchesItemToken(d.item, farm.crop))) {
    const plan = {
      objective: t(CHAT_LANG, 'fallback.farm', {word: farm.word ?? farm.crop}),
      targets: {},
      waypoint: null,
      follow: null,
      farm: {...farm, before: farmSnapshot(obs, farm.crop)},
      notes: `human:${entry.from} farm:${farm.crop}`,
      source: 'deterministic',
    };
    log('plan', {plan, ms: 0, source: 'human', deterministic: 'farm'});
    return plan;
  }
  // "cattura i diamanti" / "raccogli la spada": raccogli da terra l'oggetto
  // caduto. La lista degli item nasce dai drop che il bot vede adesso
  // (`observe().drops`); se non ne vede nessuno il piano resta vuoto e l'ordine
  // si chiude con un avviso, invece di mandare il bot a *minare* (che e' quello
  // che farebbe il planner con "prendi/cattura <oggetto>").
  if (isCollectOrder(entry.message, obs)) {
    const item = orderItem(entry.message, obs) ?? {};
    const drops = (obs.drops || []).filter(d => matchesItemToken(d.item, item.token));
    const plan = {
      objective: t(CHAT_LANG, 'fallback.collect', {word: item.word ?? item.token ?? ''}),
      targets: {},
      waypoint: null,
      follow: null,
      collect: {token: item.token ?? null, word: item.word ?? null, items: [...new Set(drops.map(d => d.item))].sort(), beforeTotal: tokenInventoryTotal(obs.inventory, item.token)},
      notes: `human:${entry.from} collect:${item.token}`,
      source: 'deterministic',
    };
    log('plan', {plan, ms: 0, source: 'human', deterministic: 'collect'});
    return plan;
  }
  // `equipaggiati con l'elmo` / `mettiti l'armatura` non passa dal planner: e'
  // un ordine di equipaggiamento, deterministico e verificabile (il successo e'
  // `observe().armor` non vuoto) e il fallback "segui il mittente" sarebbe un
  // fraintendimento. Nessuna chiamata a Hermes, nessun modello.
  if (isEquipOrder(entry.message)) {
    const plan = {
      objective: t(CHAT_LANG, 'fallback.equip'),
      targets: {},
      waypoint: null,
      follow: null,
      need: 'wear_armor',
      equip: true,
      notes: `human:${entry.from} equip`,
      source: 'deterministic',
    };
    log('plan', {plan, ms: 0, source: 'human', deterministic: 'equip'});
    return plan;
  }
  // Il sonno è un ordine di bisogno, non di movimento: dirlo al planner significava
  // fargli inventare un letto (08/10/2026: `waypoint {x:129,z:180}`, inesistente) e
  // farlo litigare col governor, che il sonno lo decide sulla percezione vera. Qui
  // si imposta solo il bisogno: chi cammina e quale letto lo sa già l'harness.
  if (isSleepOrder(entry.message)) {
    const plan = {
      objective: t(CHAT_LANG, 'fallback.sleep'),
      targets: {},
      waypoint: null,
      follow: null,
      need: 'sleep',
      notes: `human:${entry.from} sleep`,
      source: 'deterministic',
    };
    log('plan', {plan, ms: 0, source: 'human', deterministic: 'sleep'});
    return plan;
  }
  const started = Date.now();
  const out = await runHermes(prompt);
  // "fermati" non deve mai diventare un inseguimento: il fallback
  // deterministico ("segui chi ti ha scritto") vale per ogni altra richiesta,
  // ma un ordine di stop deve lasciare il bot fermo.
  const stopOrder = isStopOrder(entry.message);
  const fallback = (note) => (stopOrder
    ? {
        objective: t(CHAT_LANG, 'fallback.stop'),
        targets: {},
        waypoint: null,
        follow: null,
        notes: `human:${entry.from} ${note}`,
        source: 'hermes',
      }
    : {
        objective: t(CHAT_LANG, 'fallback.follow', {from: entry.from, message: entry.message}),
        targets: {},
        waypoint: senderPos ? { x: Math.round(senderPos.x), z: Math.round(senderPos.z) } : null,
        follow: entry.from,
        notes: `human:${entry.from} ${note}`,
        source: 'hermes',
      });
  const construction = constructionFromText(entry.message, obs);
  if (out == null && construction) return {objective: entry.message, targets: {}, construction, source: 'deterministic', notes: 'deterministic construction command'};
  if (out == null) { log('plan_fallback', {plan: fallback('hermes unavailable'), ms: Date.now() - started, source: 'human'}); return fallback('hermes unavailable'); }
  const m = out.match(/\{[\s\S]*\}/);
  let plan = null;
  try { plan = m ? JSON.parse(m[0]) : null; } catch { plan = null; }
  if (!plan || typeof plan !== 'object' || typeof plan.objective !== 'string') {
    if (construction) return {objective: entry.message, targets: {}, construction, source: 'deterministic', notes: 'deterministic construction command'};
    log('plan_fallback', {plan: fallback('parse'), ms: Date.now() - started, source: 'human'});
    return fallback('parse');
  }
  if (stopOrder) {
    plan.follow = null;
    plan.escort = null;
    plan.targets = {};
    plan.waypoint = null;
  } else if (isEscortOrder(entry.message)) {
    // «guidami/accompagnami fino a <posto>»: il bot guida, non segue. La meta e'
    // quella che il piano nomina, altrimenti il waypoint gia' noto (es. il
    // filone in memoria) — senza meta l'ordine resta il follow di prima, perche'
    // una scorta senza destinazione non ha niente da guidare.
    const destination = plan.waypoint ?? obs?.plan?.waypoint ?? null;
    if (destination) {
      plan.escort = { from: entry.from, to: { x: destination.x, y: destination.y, z: destination.z } };
      plan.follow = null;
    } else if (plan.follow == null) plan.follow = entry.from;
  } else if (plan.follow == null && /follow|stay near|come with|escort|seguimi|accompagn/i.test(entry.message)) plan.follow = entry.from;
  plan.notes = `human:${entry.from} ${plan.notes || ''}`.trim();
  if (construction || plan.construction) { plan.construction ??= construction; plan.construction.brief = entry.message; plan.targets = {}; plan.follow = null; }
  if (!plan.source) plan.source = 'hermes';
  log('plan', {plan, ms: Date.now() - started, source: 'human'});
  return plan;
}

// Domanda sul bot o ordine? Prima la regex (gratis, offline), poi System One
// sulla lista chiusa di intenti — ma solo se il messaggio sembra una domanda.
// Il router non scrive mai la risposta: la compone `answerIntent` dai dati
// dell'osservazione.
// Tre esiti (M6.1): `answer` (rispondi e non creare goal), `order` (prosegui
// sull'order path: nessuna domanda riconosciuta, oppure `q_none` da un modello
// funzionante — una decisione, non un guasto), `unrouted` (sembrava una domanda
// e non si è potuto decidere: si dice che non si è capito, senza creare goal).
async function resolveQuestion (obs, entry) {
  const decision = await resolveQuestionIntent(entry.message, {
    from: entry.from,
    enabled: CHAT_INTENT_ON,
    disabledReason: CHAT_INTENT_DISABLED_REASON,
    model: CHAT_INTENT_MODEL ?? undefined,
    url: CHAT_INTENT_URL ?? undefined,
    timeoutMs: CHAT_INTENT_TIMEOUT_MS,
    minProbability: CHAT_INTENT_MIN_P,
  });
  if (decision.via === 'jev') {
    log('chat_intent', {
      from: entry.from, xuid: entry.xuid, message: entry.message, reason: decision.reason,
      intent: decision.matched ?? null, chosen: decision.id ?? null, probability: decision.probability,
      model: decision.model, ms: decision.ms, cost: decision.cost, error: decision.error ?? null,
    });
  }
  if (decision.action === 'order') return decision;
  if (decision.action !== 'answer') {
    // Nessun goal: un guasto del router non deve muovere il bot.
    log('chat_unrouted', {
      from: entry.from, xuid: entry.xuid, message: entry.message, reason: decision.reason,
      probability: decision.probability, model: decision.model, ms: decision.ms,
      cost: decision.cost, error: decision.error ?? null,
    });
    return decision;
  }
  const answer = answerIntent(decision.id, obs, {prefixes: entry.prefixes ?? CHAT_PREFIXES, maxLength: CHAT_REPLY_MAX_LENGTH, message: entry.message, lang: CHAT_LANG});
  if (!answer) {
    // Intento in catalogo ma fatto assente (es. inventario vuoto): stesso rifiuto.
    log('chat_unrouted', {
      from: entry.from, xuid: entry.xuid, message: entry.message, reason: 'no_fact',
      probability: decision.probability, model: decision.model, ms: decision.ms, cost: decision.cost, error: null,
    });
    return {...decision, action: 'unrouted', reason: 'no_fact', answer: null};
  }
  log('chat_question', {from: entry.from, xuid: entry.xuid, intent: decision.id, via: decision.via, probability: decision.probability});
  return {...decision, answer};
}

// Cerca nell'ultima osservazione un nuovo comando umano valido. Restituisce
// {plan, entry} oppure null. Dedup per non rieseguire lo stesso messaggio.
// R2: la risposta a una domanda è già un ordine a sé? Allora l'ordine trattenuto
// è superato — si esegue la risposta. Vale per un movimento («vai al mulino»),
// per uno stop («fermati»: un ordine di stop vince sempre) e per qualunque
// ordine deterministico che il planner riconosce da solo (prendi/getta/indossa/
// mieti). Il caso opposto è la risposta che *non* è un ordine — «coordinate 120
// 64 -230» — che si unisce all'ordine trattenuto.
function replyIsOwnOrder (message, obs) {
  return restatesOrder(message)
    || isStopOrder(message)
    || isDropOrder(message, obs)
    || isCollectOrder(message, obs)
    || isEquipOrder(message)
    || isSleepOrder(message)
    || !!farmOrderFromText(message);
}

async function maybeHumanCommand (obs, {history = [], lastResult = null} = {}) {
  if (CHAT_CONTROL === 'off' || !CHAT_ALLOWLIST.size) return null;
  const chat = obs.chat || [];
  const prefixes = chatPrefixes(obs);
  for (let i = chat.length - 1; i >= 0; i--) {
    const entry = chat[i];
    const text = String(entry.message || '').trim();
    // `@bot1` non deve essere letto come `@bot`: vince il prefisso più lungo.
    const match = matchChatPrefix(text, prefixes);
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
    const raw = match.rest;
    if (!raw) continue;
    // Il dedup resta sul testo grezzo: è quello che l'inbox dell'harness ripete.
    const seenKey = `${entry.at}|${entry.from}|${raw}`;
    if (!rememberSeen(humanCommandSeen, seenKey)) continue;
    // M11: «ragiona» è un'istruzione su *come rispondere*, non un ordine, e va
    // tolto prima di ogni interprete (i fatti dettati e il router non devono
    // vederlo). Un messaggio che è *solo* il marcatore non è niente.
    const asked = CHAT_REASON_ON
      ? reasonRequest(raw, CHAT_REASON_MARKERS.length ? {markers: CHAT_REASON_MARKERS} : {})
      : null;
    const reasoned = asked?.reason === true;
    const message = reasoned ? asked.message : raw;
    if (!message) continue;
    // R2: se questo messaggio risponde a una domanda del bot, l'inbox ha
    // timbrato `clarifies` (una volta sola). L'ordine da eseguire è quello
    // **originale** con la risposta attaccata: la risposta da sola non è un
    // ordine («coordinate 120 64 -230»), ma una risposta che è già un ordine
    // completo («vai al mulino») lo sostituisce. Una risposta non è mai small
    // talk: la lista chiusa contiene proprio le forme di conferma («va bene»).
    const pending = entry.clarifies && typeof entry.clarifies === 'object' && entry.clarifies.orderId ? entry.clarifies : null;
    const held = pending && !replyIsOwnOrder(message, obs) ? pending : null;
    const orderText = held ? mergeClarifyAnswer(held.originalText, message) : message;
    // Fatti dettati (M10): ricorda / consulta / correggi / dimentica, e «vai al
    // <luogo nominato>». Riconoscimento deterministico e risposta dal catalogo:
    // nessun modello, nessun goal (tranne il movimento, che è un ordine come gli
    // altri). Sta *prima* di `resolveQuestion` perché «dov'è il campo di patate?»
    // è una domanda la cui risposta è nella memoria, non nel router.
    const told = await handleToldFact(obs, {...entry, message}, {message, prefixes});
    if (told === true) continue;
    if (told && typeof told === 'object') {
      // R1: anche un piano deterministico (la meta' che la memoria gia' conosce)
      // entra nel goal con la sua forma — `subgoal` e un passo con id. Questa
      // uscita anticipata era l'unico piano che arrivava a un goal senza passare
      // da `shapedPlan` (sotto): la traccia R3 lo mostrava con `steps: []` e R4
      // non poteva attribuirgli un rifiuto (`activeStepId` -> null).
      const plan = shapedPlan(told);
      log('chat_command', {from: entry.from, xuid: entry.xuid, prefix: match.prefix, message, deterministic: 'told_goto'});
      const ack = orderAck({from: entry.from, plan, maxLength: CHAT_REPLY_MAX_LENGTH, lang: CHAT_LANG});
      await saySmart('ack', {from: entry.from, message, obs, plan, grounding: ack, fallback: ack, prefixes, reasoned});
      return {plan, entry: {...entry, message, reasoned}};
    }
    // M11: con «ragiona» una domanda non ha una frase fatta da leggere — la
    // risposta la compone M7 dai fatti (che cosa sto facendo, che cosa è andato
    // storto, che cosa mi manca). Se M7 non risponde (spento, in cooldown o in
    // errore) si scende nel flusso normale: mai silenzio.
    if (reasoned && looksLikeQuestion(message)) {
      const answered = await sayReason({from: entry.from, message, obs, prefixes, history, lastResult});
      if (answered) continue;
    }
    // M6/M6.1: prima di tradurre il messaggio in un piano, chiediti se è una
    // domanda. Se lo è, si risponde e si passa al messaggio successivo: nessun
    // goal nasce. Se sembrava una domanda ma il router non ha deciso, si dice
    // che non si è capito — sempre senza creare goal.
    const question = await resolveQuestion(obs, {...entry, message, prefix: match.prefix, prefixes});
    if (question?.action === 'answer' && question.answer) {
      const fallback = renderAnswer({from: entry.from, answer: question.answer, maxLength: CHAT_REPLY_MAX_LENGTH, lang: CHAT_LANG});
      await saySmart('question', {from: entry.from, message, obs, grounding: fallback, fallback, prefixes});
      continue;
    }
    if (question?.action === 'unrouted') {
      const fallback = renderUnrouted({from: entry.from, prefixes, maxLength: CHAT_REPLY_MAX_LENGTH, lang: CHAT_LANG});
      await saySmart('unrouted', {from: entry.from, message, obs, grounding: fallback, fallback, prefixes});
      continue;
    }
    // M7: un saluto o un ringraziamento non è un ordine e non deve diventare un
    // goal. Solo un match esatto (lista chiusa di frasi) arriva qui: un ordine
    // vero non viene mai inghiottito.
    if (!pending && looksLikeSmallTalk(message)) {
      const fallback = renderReply(CHAT_SMALLTALK_TEMPLATE, {name: entry.from ?? '?'}, CHAT_REPLY_MAX_LENGTH);
      log('chat_smalltalk', {from: entry.from, xuid: entry.xuid, message});
      await saySmart('smalltalk', {from: entry.from, message, obs, grounding: null, fallback, prefixes});
      continue;
    }
    log('chat_command', {from: entry.from, xuid: entry.xuid, prefix: match.prefix, message, clarifies: pending?.orderId ?? null});
    const decided = await humanCommandPlan(obs, {...entry, message: orderText});
    // R2 — la porta. Un ordine che chiede una meta e non ne porta una, quando
    // nessuna fonte può risolverla, non diventa un goal: il planner ripiegherebbe
    // su «seguo chi mi ha scritto», che è la risposta a un'altra domanda. Si
    // chiede invece l'unica cosa che può decidere solo l'umano, **una volta per
    // ordine**; il goal nasce quando l'ordine è eseguibile. Se la memoria dei
    // luoghi è giù la porta è aperta (fail-open): meglio un'ipotesi che un bot
    // muto.
    if (CHAT_CLARIFY_ON) {
      const gap = await orderGaps(orderText, decided, obs, {memory: clarifyMemory, lang: CHAT_LANG});
      if (gap.status === CLARIFY_NEEDS_INPUT) {
        const field = gap.missing?.[0]?.field ?? null;
        const reason = gap.missing?.[0]?.reason ?? null;
        if (held) {
          // Ha già risposto e non basta: non si chiede una seconda volta (una
          // domanda che si ripete è un bot che non ascolta). L'ordine muore qui,
          // e questo *è* l'esito: la chat lo dice.
          const body = renderReply(renderClarifyRefusal({lang: CHAT_LANG}), {}, CHAT_REPLY_MAX_LENGTH);
          const text = entry.from && !body.startsWith('@') ? clampMessage(`@${entry.from} ${body}`, CHAT_REPLY_MAX_LENGTH) : body;
          log('chat_clarify_refused', {from: entry.from, xuid: entry.xuid, orderId: held.orderId, field, reason, message: orderText});
          await replyChat(text, {to: entry.from, context: 'clarify', prefixes});
          chatMemory.remember(entry.from, message, text);
          continue;
        }
        const orderId = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const asked = await clarifySay(entry, {message: orderText, prefixes, orderId, question: gap.question, field, reason, originalText: orderText});
        log('chat_clarify', {from: entry.from, xuid: entry.xuid, orderId, field, reason, stored: asked.stored, question: gap.question});
        continue;
      }
    }
    const plan = shapedPlan(decided);
    // M5: conferma dell'ordine in chat. Best-effort (l'adapter applica rate
    // limit e lunghezza); l'esito arriva alla chiusura del goal.
    const ack = orderAck({from: entry.from, plan, maxLength: CHAT_REPLY_MAX_LENGTH, lang: CHAT_LANG});
    await saySmart('ack', {from: entry.from, message, obs, plan, grounding: ack, fallback: ack, prefixes, reasoned});
    return {plan, entry: {...entry, message, reasoned}};
  }
  return null;
}

// M7: risposta chat con l'LLM quando c'è una chiave, altrimenti il testo
// deterministico. L'LLM riformula, non decide: `grounding` porta i fatti veri
// (o la frase già composta) e `fallback` è la rete di sicurezza. Qualsiasi
// guasto — chiave assente, timeout, HTTP, risposta vuota o scatenante — produce
// il fallback, quindi il canale non resta mai muto. Il testo inviato entra nella
// memoria conversazionale del mittente.
async function saySmart (context, {from, message = null, obs = null, plan = null, grounding = null, fallback, prefixes = CHAT_PREFIXES, reasoned = false}) {
  let text = fallback;
  if (CHAT_LLM_ON) {
    try {
      const reply = await composeChatReply({
        message: message ?? grounding ?? '',
        from,
        facts: compactChatFacts(obs, plan),
        grounding,
        history: chatMemory.history(from),
        persona: CHAT_LLM.persona,
        prefixes,
        lang: CHAT_LANG,
        reasoned,
        model: CHAT_LLM.model,
        url: CHAT_LLM.url,
        key: CHAT_LLM.key,
        timeoutMs: CHAT_LLM.timeoutMs,
        thinking: CHAT_LLM.thinking,
        maxLength: CHAT_REPLY_MAX_LENGTH,
      });
      text = reply.text;
      log('chat_llm', {to: from, context, ok: true, via: 'llm', model: reply.model, ms: reply.ms, cost: reply.cost});
    } catch (error) {
      log('chat_llm', {to: from, context, ok: false, via: 'fallback', error: error.message, code: error.code ?? null});
      text = fallback;
    }
  }
  await replyChat(text, {to: from, context, prefixes});
  chatMemory.remember(from, message, text);
  return text;
}

// M11: la risposta «ragionata». Non passa dal catalogo — manda al modello di chat
// i fatti di `observe()` più quelli che servono a *spiegare* (le ultime azioni e
// com'è andata, le vene viste) e la domanda dell'umano, e lascia che sia lui a
// metterli insieme. Ritorna il testo inviato, oppure null quando M7 non è
// disponibile o il mittente ha già ragionato da poco: in quel caso il chiamante
// prosegue nel flusso normale (una risposta fatta è meglio di nessuna risposta).
async function sayReason ({from, message, obs = null, plan = null, prefixes = CHAT_PREFIXES, history = [], lastResult = null}) {
  if (!CHAT_REASON_ON || !CHAT_LLM_ON) return null;
  const now = Date.now();
  const key = from ?? '?';
  const last = reasonCooldown.get(key) ?? 0;
  if (now - last < CHAT_REASON_COOLDOWN_MS) {
    log('chat_reason', {to: from, ok: false, via: 'cooldown', waitMs: CHAT_REASON_COOLDOWN_MS - (now - last), message});
    return null;
  }
  try {
    const reply = await composeChatReply({
      message,
      from,
      facts: compactChatFacts(obs, plan, reasonFacts(obs, {history, lastResult})),
      grounding: null,
      history: chatMemory.history(from),
      persona: CHAT_LLM.persona,
      prefixes,
      lang: CHAT_LANG,
      reasoned: true,
      model: CHAT_LLM.model,
      url: CHAT_LLM.url,
      key: CHAT_LLM.key,
      timeoutMs: CHAT_LLM.timeoutMs,
      thinking: CHAT_LLM.thinking,
      maxLength: CHAT_REPLY_MAX_LENGTH,
    });
    reasonCooldown.set(key, Date.now());
    // La risposta è indirizzata come le altre (M5): l'umano ha parlato in chat a
    // tutti, la risposta è sua. L'indirizzo lo mette il controller, non il
    // modello: un nome storpiato dal modello non è un errore che si vuole.
    const text = clampMessage(/^@\S+/.test(reply.text) ? reply.text : `@${from ?? '?'} ${reply.text}`, CHAT_REPLY_MAX_LENGTH);
    const sent = await replyChat(text, {to: from, context: 'reason', prefixes});
    chatMemory.remember(from, message, text);
    log('chat_reason', {to: from, ok: true, via: 'llm', model: reply.model, ms: reply.ms, cost: reply.cost, message, sent: !!sent?.ok});
    return {text, sent};
  } catch (error) {
    // Un guasto di M7 non è un guasto del canale: si torna al flusso normale.
    log('chat_reason', {to: from, ok: false, via: 'fallback', error: error.message, code: error.code ?? null, message});
    return null;
  }
}

// I fatti che servono a *spiegare*, non solo a descrivere: le ultime azioni con il
// loro esito (dalla memoria azioni del controller) e le vene che il bot ha visto.
// Sono letti dallo stato, non inventati dal modello.
function reasonFacts (obs, {history = [], lastResult = null} = {}) {
  const facts = {};
  const recent = (history ?? []).slice(-6).map(entry => ({action: entry.key, stagnant: entry.stagnant === true}));
  if (recent.length) facts.recentActions = recent;
  if (lastResult) {
    facts.lastResult = {
      action: history.at(-1)?.key ?? null,
      ok: lastResult.ok === true,
      error: lastResult.error ?? null,
    };
  }
  const ores = (obs?.ores ?? []).slice(0, 3).map(ore => ({
    name: ore.name, position: ore.position, distance: ore.distance ?? null,
  }));
  if (ores.length) facts.oresNearby = ores;
  return facts;
}

// Risposta in chat (M5): una riga, indirizzata al mittente, mai scatenante
// (`@<nome> ...`, non `@bot ...`). Ritorna l'esito del POST /say e non lancia
// mai: il canale resta best-effort come il saluto.
async function replyChat (message, {to = null, context = null, prefixes = CHAT_PREFIXES} = {}) {
  if (!CHAT_REPLY || !message) return null;
  if (isSelfTriggering(message, prefixes)) {
    log('chat_reply_refused', {to, context, message, reason: 'would_trigger_the_bot'});
    return {ok: false, error: 'would_trigger_the_bot'};
  }
  let result = await api('POST', '/say', {message}).catch(error => ({ok: false, error: error.message}));
  // Il bot puo' parlare una volta al secondo (`CHAT_MIN_INTERVAL_MS` lato
  // harness) e una risposta dentro quella finestra veniva **scartata**: con
  // l'ack che parte subito e l'esito un istante dopo, l'umano vedeva solo
  // l'ack ottimista. Il 07/10/2026 «non ho diamanti in inventario» e «non ce
  // l'ho fatta: item_not_in_inventory» sono spariti cosi' e in chat e' rimasto
  // un «fatto» mai avvenuto. L'esito onesto non si perde: si ritenta quando
  // l'harness dice quando (`retryInMs`).
  if (result?.ok === false && result.error === 'rate_limited') {
    const wait = Math.min(Math.max(Number(result.retryInMs) || CHAT_REPLY_RETRY_MS, 50), CHAT_REPLY_RETRY_MAX_MS);
    await delay(wait);
    const retry = await api('POST', '/say', {message}).catch(error => ({ok: false, error: error.message}));
    log('chat_reply_retry', {to, context, waitMs: wait, ok: !!retry?.ok, error: retry?.error ?? null, message});
    result = retry?.ok ? {...retry, retried: true} : retry;
  }
  log('chat_reply', {to, context, message, ok: !!result?.ok, error: result?.error ?? null});
  return result;
}

// Stato dell'avviso di scorta: uno per episodio d'attesa, riarmato quando
// l'umano torna a portata, con un cooldown condiviso fra i due casi ('wait' =
// "sei rimasto indietro", 'hold' = "non ti vedo piu'"). Vive accanto
// all'unica funzione che lo consuma, come il resto dello stato di chat.
let escortWaitingSent = false;
let escortHoldNoticeSent = false;
let lastEscortWaitingAt = 0;
let mountWaitingSent = false;
let lastMountWaitingAt = 0;

// La scorta si e' fermata ad aspettare: una riga con le proprie coordinate.
// `episode` sceglie il flag da consumare — 'wait' e' "sei rimasto indietro",
// 'hold' e' "non ti vedo piu'" — e il cooldown e' condiviso: un episodio non
// diventa una raffica, e un umano che torna a portata riarma il messaggio.
// Best-effort come ogni altra risposta: se `/say` non riesce resta nei log.
async function noticeEscortWaiting (target, {reason, episode, obs, step}) {
  const sent = episode === 'hold' ? escortHoldNoticeSent : escortWaitingSent;
  if (sent || Date.now() - lastEscortWaitingAt <= ESCORT_WAITING_COOLDOWN_MS) return null;
  const notice = escortWaiting({from: target ?? null, position: obs?.position ?? null, lang: CHAT_LANG});
  if (!notice) return null; // nessuna posizione leggibile: si tace, non si inventa
  if (episode === 'hold') escortHoldNoticeSent = true; else escortWaitingSent = true;
  lastEscortWaitingAt = Date.now();
  console.log(`ESCORT WAITING ${target}: dico dove aspetto (${reason})`);
  log('escort_waiting', {step, target: target ?? null, reason, episode, position: obs?.position ?? null, gap: obs?.escort?.gap ?? null});
  return replyChat(notice, {to: target ?? null, context: 'escort_waiting'});
}

// L'umano si e' imbarcato e il bot non e' salito: una riga con il mezzo e le
// proprie coordinate, perche' chi sta salpando non puo' vedere ne' che il bot e'
// rimasto a riva ne' da dove recuperarlo. Un messaggio per episodio, con
// cooldown; l'episodio si chiude quando lo stato non e' piu' `WAITING_AT_SHORE`.
// Best-effort come ogni altra risposta: se `/say` non riesce resta nei log.
async function noticeMountWaiting (target, {reason, mount, obs, step}) {
  if (mountWaitingSent || Date.now() - lastMountWaitingAt <= MOUNT_WAITING_COOLDOWN_MS) return null;
  const notice = mountWaitingShore({from: target ?? null, position: obs?.position ?? null, mount: mount?.type ?? null, lang: CHAT_LANG});
  if (!notice) return null; // nessuna posizione (o nessun mezzo): si tace, non si inventa
  mountWaitingSent = true;
  lastMountWaitingAt = Date.now();
  console.log(`MOUNT WAITING ${target}: dico dove aspetto (${reason})`);
  log('mount_waiting_shore', {step, target: target ?? null, reason, mount: mount?.type ?? null, mountId: mount?.runtimeId ?? null, free: mount?.free ?? null, seats: mount?.seats ?? null, source: mount?.source ?? null, position: obs?.position ?? null});
  return replyChat(notice, {to: target ?? null, context: 'mount_waiting_shore'});
}

// Saluto proattivo: un umano fidato percepito vicino riceve una volta (con
// cooldown) un messaggio che spiega come dare un ordine. Si prova solo a bot
// spawnato; se `/say` non esiste (harness Java) la chiamata fallisce e resta nei
// log. Un saluto per umano: dedup per gamertag, non per passo.
async function maybeGreetHumans (obs) {
  if (!CHAT_GREET || !obs?.spawned) return;
  const prefixes = chatPrefixes(obs);
  const greetings = planGreetings({
    humans: obs.humans || [],
    allowlist: CHAT_ALLOWLIST,
    prefixes,
    greeted: greetedHumans,
    now: Date.now(),
    cooldownMs: CHAT_GREET_COOLDOWN_MS,
    range: CHAT_GREET_RANGE,
    template: CHAT_GREET_TEMPLATE,
    lang: CHAT_LANG,
    // M12: il saluto mostra il verbo del ragionamento — quello configurato se
    // c'è, altrimenti quello della lingua (mai una parola che non accenderebbe
    // nulla).
    reason: CHAT_REASON_MARKERS[0] ?? null,
  });
  for (const greet of greetings) {
    // Segna subito il tentativo: su errore si ritenta dopo il cooldown, non a
    // ogni passo (niente spam verso il server né nei log).
    greetedHumans.set(greet.username.toLowerCase(), Date.now());
    const result = await api('POST', '/say', {message: greet.message}).catch(error => ({ok: false, error: error.message}));
    log('chat_greet', {to: greet.username, distance: greet.distance, prefixes, message: greet.message, ok: !!result?.ok, error: result?.error ?? null});
    console.log(`GREET ${greet.username}: ${greet.message}`);
  }
}

// Umani a portata d'orecchio, dedup per gamertag: un annuncio non si ripete se
// il server lista lo stesso giocatore due volte.
function nearbyHumans (obs, range = CHAT_GREET_RANGE) {
  const seen = new Set();
  const out = [];
  for (const human of obs?.humans || []) {
    const username = human?.username ? String(human.username) : null;
    if (!username) continue;
    const key = username.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const distance = human.distance;
    if (distance != null && Number.isFinite(distance) && distance > range) continue;
    out.push({username, distance: distance ?? null});
  }
  return out;
}

// M8: il bot racconta il lavoro che sta iniziando da solo. Deterministico, in
// una lingua sola (quella configurata), una volta per goal e con cooldown;
// nessun umano vicino = nessun messaggio. Best-effort: se `/observe` fallisce
// l'annuncio si salta, il goal parte lo stesso.
async function maybeNarrateGoal (goal) {
  if (!CHAT_NARRATE || !goal?.plan) return null;
  if (goal.type !== 'village' && goal.type !== 'autonomous') return null;
  const narration = narrateGoal(goal.plan, {lang: CHAT_LANG});
  if (!narration) return null;
  const now = Date.now();
  if (lastNarrationAt && now - lastNarrationAt < CHAT_NARRATE_COOLDOWN_MS) return null;
  const obs = await api('GET', '/observe').catch(() => null);
  if (!obs?.spawned) return null;
  const humans = nearbyHumans(obs);
  if (!humans.length) return null;
  // Segnato solo quando l'annuncio parte davvero: un goal partito in solitudine
  // non consuma la sua unica occasione di parlare.
  if (!rememberSeen(narratedGoals, goal.id)) return null;
  lastNarrationAt = now;
  await saySmart('autonomy', {
    from: null, message: narration, obs, plan: goal.plan,
    grounding: narration, fallback: narration, prefixes: chatPrefixes(obs),
  });
  log('autonomy_narration', {
    goalId: goal.id, type: goal.type, chore: goal.plan.chore ?? null, need: goal.plan.need ?? null,
    humans: humans.map(h => h.username), message: narration,
  });
  console.log(`NARRATE [${goal.id}] ${narration}`);
  return narration;
}

// M3c: il goal che ha raccolto riporta. Un `village`/`autonomous` completato che
// lascia ancora roba in zaino accoda una sola `store_harvest` (soglia 1: qualunque
// cosa, non uno stack intero) prima che il loop torni in IDLE. Il successo resta
// un delta di stato: la chore si chiude quando l'inventario cala davvero (e il
// baule cresce), mai perché il modello dice «fatto».
async function maybeStoreEpilogue (goal, outcome) {
  if (!VILLAGE_STORE_EPILOGUE || outcome?.status !== 'success') return null;
  if (goal?.type !== 'village' && goal?.type !== 'autonomous') return null;
  // Solo chi ha prodotto: l'epilogo non ha epilogo, e un bisogno non raccoglie.
  if (!goal.plan?.chore || goal.plan.chore === 'store_harvest') return null;
  const obs = await api('GET', '/observe').catch(() => null);
  if (!obs) return null;
  const availability = await api('GET', '/options').catch(() => null);
  const offered = new Set((availability?.options || []).map(o => o.key));
  const chore = nextVillageChore(obs, {
    offered, storeThreshold: 1, attempts: villageAttempts,
    cooldownMs: 0, allow: candidate => candidate.id === 'store_harvest',
  });
  if (!chore) return null;
  // Segnato solo quando il figlio viene davvero accodato: senza baule
  // raggiungibile o senza niente da riporre il goal non consuma la sua occasione.
  if (!rememberSeen(storeEpilogues, goal.id)) return null;
  villageAttempts.set(chore.id, Date.now());
  const child = goalManager.enqueue({
    type: 'village', source: GOAL_SOURCE.AUTONOMOUS, priority: chore.priority, objective: chore.objective,
    plan: {
      objective: chore.objective, targets: {}, waypoint: null, priority: 'village',
      chore: chore.id, choreTarget: chore.target ?? null,
      choreBefore: villageSnapshot(obs, {spend: chore.spend}), notes: `village:${chore.id}`,
    },
    parameters: {chore: chore.id, reason: chore.reason, epilogueOf: goal.id},
  });
  console.log(`STORE EPILOGUE after ${goal.id} -> village chore ${child.id} [${chore.id}] ${chore.objective}`);
  log('village_store_epilogue', {goalId: goal.id, choreGoalId: child.id, chore: chore.id, reason: chore.reason, count: chore.count});
  return child;
}

// ---- controller: Jev via TypeSafe or OpenRouter ---------------------------------------------
async function jevDecide(observation, options, plan) {
  const criteria = buildCriteria(options);
  const {answers, model, provider, usage, ms, attempts, retries} = await systemOneDecideWithRetry({
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
    cost: usage?.cost, ms, attempts: attempts ?? 1, retries: retries ?? 0,
    candidates,
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
// I target con cui l'ordine umano e' nato: `parameters.targets` per un goal
// creato in chat, `humanOrder.targets` per un ordine che ha riorientato un goal
// autonomo (o una richiesta dello stesso umano). Assente o vuoto = l'ordine non
// dichiarava un obiettivo misurabile, quindi nessun pavimento.
function humanOrderTargets (goal) {
  for (const source of [goal?.humanOrder?.targets, goal?.parameters?.targets]) {
    if (source && Object.keys(source).length) return source;
  }
  return null;
}

// `orderTargets` e' il pavimento di un ordine umano: i target con cui l'ordine
// e' nato. Un replan puo' riscrivere il piano (e deve: il mondo cambia), ma non
// puo' **cancellare il successo** dell'ordine. Il 07/10/2026 «raccolgo un
// diamante» e' finito con `GOAL MET` e un «fatto» in chat 28 s dopo un replan
// che aveva svuotato `targets` — il diamante non c'era (l'aveva raccolto
// l'umano). Senza pavimento un piano senza criteri e' "soddisfatto" a vuoto:
// `Object.entries({}).every(...)` e' true e senza waypoint l'arrivo e' true.
const goalMet = (obs, plan, skillStatus, orderTargets = null) => {
  if (plan.construction) {
    if (plan.construction.command === 'pause') return obs.construction?.projectId === plan.construction.projectId && obs.construction.state === 'paused';
    return constructionGoalMet(obs, plan.construction);
  }
  // Ordini umani sull'inventario (M9): "getta <oggetto>" e' chiuso quando
  // l'oggetto e' uscito, "cattura <oggetto>" quando e' entrato. Entrambi sono
  // ancorati al delta dell'inventario, non a un target del planner.
  if (plan.drop) return dropFulfilled(plan.drop, obs);
  if (plan.collect) return collectFulfilled(plan.collect, obs);
  // Un ordine di fattoria ("raccogli le carote, rimpianta e metti nel baule")
  // e' chiuso quando il raccolto *guadagnato* e' finito negli scrigni noti: il
  // delta del contenuto, non un target del planner.
  if (plan.farm) return farmFulfilled(plan.farm, obs);
  // I piani "seguimi" sono aperti: terminano solo con un nuovo ordine o a fine
  // budget, mai da soli (non hanno target/waypoint terminali).
  if (plan.follow) return false;
  // Una scorta invece si chiude: quando il bot e' alla meta *con* l'umano non
  // rimasto indietro. Il verdetto sta nei dati (posizione del bot e `gap`
  // dell'umano), non nell'opinione del modello.
  if (plan.escort) return escortFulfilled(plan.escort, obs);
  // Un goal autonomo è ancorato al bisogno che l'ha generato: il successo è la
  // scomparsa del bisogno dallo stato del harness, non un target inventato.
  if (plan.need) return isNeedResolved(plan.need, obs, {rules: survivalRules});
  // Un goal di villaggio e' ancorato al lavoro scelto: il successo e' il delta
  // rispetto allo snapshot iniziale (oggetti guadagnati, semi spesi, un cucciolo
  // nato), non un conteggio assoluto dell'inventario.
  if (plan.chore) return isChoreResolved(plan.chore, obs, {before: plan.choreBefore});
  // Un goal di emergenza per il recupero loot termina quando l'harness azzera
  // il sito di morte (nessun drop rimasto).
  if (plan.recover) return !obs.deathSite;
  // In modalità curriculum il goal si chiude solo quando il milestone finale è
  // verificato (ramo `skill` più sotto o progression engine nel replan): i
  // target dell'ultimo piano sono i *prerequisiti* del milestone, non il
  // successo. Senza questa guardia un prerequisito completato (es. `wood`)
  // chiuderebbe il goal al primo passo.
  if (CURRICULUM) return false;
  const orderFloor = orderTargets && Object.keys(orderTargets).length ? orderTargets : null;
  const targetMap = plan.targets && Object.keys(plan.targets).length ? plan.targets : (orderFloor ?? TARGETS);
  const targets = Object.entries(targetMap).every(([item, n]) => (obs.inventory[item] || 0) >= n);
  // M14: l'inventario non prova un minaggio — un diamante preso da uno scrigno
  // sta li' esattamente come uno scavato. Con un requisito configurato il goal
  // chiude solo quando l'oggetto e' stato prodotto (e depositato) **in questo
  // run**. Vale per il goal d'ambiente: un ordine umano non c'entra.
  const mission = orderFloor ? true : missionRequirementsMet(requirementProgress, MISSION_REQUIREMENTS);
  const w = plan.waypoint || WAYPOINT;
  const at = !w || Math.hypot(w.x - obs.position.x, w.z - obs.position.z) <= 2;
  if (plan.skill && skillRun?.id === plan.skill) {
    // Con una skill dichiarata e verificabile il successo lo decide il
    // verifier, non i target. In modalità curriculum l'avanzamento lo gestisce
    // il progression engine. Una skill sconosciuta (skillRun null) ricade sui
    // target, così un refuso del planner non blocca il goal.
    if (CURRICULUM) return false;
    return targets && at && mission && skillStatus?.status === 'success';
  }
  return targets && at && mission;
};

// M14: il credito del requisito. Due letture, entrambe dal **risultato** e non
// dalla chiave: un deposito riuscito nomina cosa e' uscito, e un'azione che
// scava/raccoglie si misura sulla **crescita dell'inventario** (il nome del
// blocco non dice il drop: `mine_deepslate_diamond_ore` da' un diamante come
// `mine_diamond_ore`, e `mine_iron_ore` da' ferro grezzo). Un `take_*` non
// produce niente: il furto non fa progredire il requisito.
const creditMissionResult = async (step, key, result) => {
  if (!result?.ok) return;
  const rows = depositedStacks(result).filter(row => MUST_DEPOSIT[row.item]);
  if (rows.length) {
    for (const row of rows) requirementProgress.deposited = addCounts(requirementProgress.deposited, {[row.item]: row.count});
    log('mission_deposit', {step, key, items: rows,
      state: renderRequirements(missionRequirementsState(requirementProgress, MISSION_REQUIREMENTS))});
  }
  if (!isProducingKey(key)) return;
  const after = (await api('GET', '/observe').catch(() => null))?.inventory ?? null;
  const growth = producedGrowth(obs?.inventory ?? {}, after ?? {}, MUST_MINE);
  if (!Object.keys(growth).length) return;
  requirementProgress.mined = addCounts(requirementProgress.mined, growth);
  log('mission_mined', {step, key, growth,
    state: renderRequirements(missionRequirementsState(requirementProgress, MISSION_REQUIREMENTS))});
};

// Un piano "aperto" (nessun criterio terminale: né target, né waypoint, né
// bisogno, né ordine, né skill) non si chiude prima di aver lavorato: lo
// stesso guardiano vale nel loop del goal e quando un goal sospeso viene
// rivalutato prima della ripresa.
const planIsOpen = (plan) => !plan.follow && !plan.need && !plan.recover && !plan.skill &&
  !plan.drop && !plan.collect && !plan.farm &&
  !Object.keys(plan.targets || {}).length && !Object.keys(TARGETS).length &&
  !plan.waypoint && !WAYPOINT;

// R8: i target del piano ancora da soddisfare. Sono la preparazione possibile
// di un segmento bloccato: finche' ce n'e' uno la skill puo' ancora guadagnarsi
// il prerequisito, quando non ne resta nessuno il blocco e' definitivo.
const unmetTargets = (targets, obs) => Object.entries(targets ?? {})
  .filter(([item, want]) => (obs?.inventory?.[item] || 0) < want)
  .map(([item, want]) => ({item, want, have: obs?.inventory?.[item] || 0}));

// Rivalutazione di un goal sospeso prima di rimetterlo in coda: lo stesso
// predicato di successo del loop, sulla osservazione attuale. Il resume non
// riprende un'azione a metà: se il criterio è già soddisfatto (l'ordine umano
// che ha sospeso il goal ha fatto il lavoro, o il mondo è cambiato) il goal si
// chiude senza rieseguirlo; altrimenti riparte dal primo passo del suo piano,
// rivalutato sul mondo di adesso. Una skill sospesa non è "riuscita": senza
// osservazione skill il piano ricade sui target.
function goalAlreadySatisfied (goal, obs) {
  const sticky = withStickyEscort(withStickyFollow(goal.plan ?? {}, goal.follow), goal.escort);
  const humanOrdered = goal.source === GOAL_SOURCE.CHAT || !!goal.humanOrder;
  if (humanOrdered && planIsOpen(sticky)) return false;
  return goalMet(obs, sticky, null, humanOrderTargets(goal));
}

// Esegue UN goal fino a un esito terminale e restituisce l'esito senza uscire
// dal processo: la persistenza del goal e le transizioni di stato sono
// responsabilità del session loop (main).
async function runGoal (goal) {
skillRun = null;
let obs = await api('GET', '/observe');
// M14: il requisito di missione si annuncia subito, cosi' il ledger dice da
// cosa il goal e' vincolato prima ancora della prima decisione.
if (MISSION_REQUIREMENTS_ON) log('mission_requirements', {mustMine: MUST_MINE, mustDeposit: MUST_DEPOSIT,
  state: renderRequirements(missionRequirementsState(requirementProgress, MISSION_REQUIREMENTS))});
// M15: il divieto si annuncia subito, prima della prima decisione: senza questa
// riga un `take_diamond` che non compare piu' nelle opzioni sembra un caso.
if (MISSION_FORBID.length) log('mission_forbidden', {keys: MISSION_FORBID, maxSteps: MISSION_FORBID_MAX_STEPS});

// ---- Goal Contract (opzionale, Slice A) -----------------------------------------------------
// Con GOAL_CONTRACT (JSON), MAX_DEATHS o PRESERVE_ITEMS il controller valuta un
// contratto strutturato a ogni passo e ne deriva uno stato deterministico:
// RUNNING | SUCCESS | FAILED | BLOCKED. Senza configurazione resta il
// comportamento precedente (nessun contratto).
const goalContract = hasContractConfig() ? contractFromEnv() : null;
const contractBaseline = obs;
let lastContractStatus = null;
let runExitCode = 0; // non-zero quando un contratto termina FAILED/BLOCKED/EXHAUSTED
// Motivo esplicito di un'esecuzione fallita decisa dal loop (es. ordine di
// equipaggiamento senza niente da indossare): finisce in `outcome.reason` e
// quindi nel messaggio di esito all'umano, invece di un generico "failed".
let failureReason = null;
// `stepsUsed` = azioni già eseguite; a fine budget il contratto ancora RUNNING
// viene tradotto in `exhausted` (vedi survival/goal-contract.mjs).
let plan = goal.plan ?? { construction: CONSTRUCTION ?? constructionFromText(goal.objective ?? GOAL, obs) };
function evaluateGoalContract (observation, stepsUsed) {
  if (!goalContract) return null;
  const effectiveContract = plan.construction ? { ...goalContract, success: {
    structureBuilt: { type: observation.construction?.type, projectId: plan.construction.projectId },
  } } : goalContract;
  const status = contractStop(effectiveContract, observation, { before: contractBaseline, stepsUsed, maxSteps: MAX_STEPS });
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

if (goalContract && !plan.construction) {
  const initialContract = evaluateGoalContract(obs, 0);
  if (initialContract.status !== 'running') {
    if (initialContract.status !== 'success') runExitCode = 2;
    log('goal_contract_stop', {step: 0, status: initialContract.status, reasons: initialContract.reasons, evidence: initialContract.evidence});
    console.log(`GOAL CONTRACT ${initialContract.status.toUpperCase()} before the first action`);
    return {status: initialContract.status === 'success' ? 'success' : 'failed', exitCode: runExitCode, steps: 0};
  }
}

let initialPlan = goal.plan || shapedPlan(await planForStep(obs, 'start', goal));
if (initialPlan?.met) {
  console.log('CURRICULUM GOAL already met');
  log('goal_met', {steps: 0, curriculum: CURRICULUM});
  return {status: 'success', exitCode: 0, steps: 0, reason: 'curriculum_already_met'};
}
plan = initialPlan;
// Un ordine "seguimi" e' un impegno aperto (M3): il goal se lo ricorda e resta un
// inseguimento finche' non arriva un altro ordine, anche se un replan riscrive il
// piano senza `follow` (live 04/10: il replan anti-loop cancellava l'ordine, il
// waypoint statico chiudeva il goal e il bot si fermava da solo).
if (initialPlan?.follow) goal.follow = initialPlan.follow;
if (initialPlan?.escort) goal.escort = initialPlan.escort;
if (CONSTRUCTION && !plan.construction) plan = {...plan, targets: {}, construction: CONSTRUCTION};
plan = await publishPlan(plan);
goal.plan = plan; goalManager.persist();
// R3: il primo segmento di traccia del goal. `human_order` se il piano e' nato
// da un ordine in chat (il goal se lo porta dietro), `start` altrimenti. Se un
// segmento e' ancora aperto (questo ordine ha preemptato un goal in corsa) si
// chiude dicendo perche', invece di lasciarlo marcato `replaced`.
const traceReason = (goal.source === GOAL_SOURCE.CHAT || goal.humanOrder) ? 'human_order' : 'start';
if (planTrace.current) planTrace.flush({endedBy: traceReason, step: 0});
planTrace.adopt({step: 0, reason: traceReason, plan});
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
let lastResult = null;         // esito dell'ultima azione (un ordine umano vuoto si chiude solo dopo un successo)
let lastFailedKey = null;
let chosenFingerprint = null;  // fingerprint dell'osservazione al momento della scelta
let lastSurvivalFingerprint = null;
let totalCost = 0;
runProgress.cost = 0;
let goalReached = false;
let stepsUsed = 0;
runProgress.steps = 0;
let prevObs = null;             // osservazione del passo precedente (eventi del mondo)
let lastFollowTarget = null;    // ultimo ordine "seguimi" annunciato nei log
let lastEscortTarget = null;    // ultima scorta annunciata nei log
let lastMountTarget = null;     // ultimo ordine "sali sul mezzo dell'umano" annunciato nei log
let lastNeedKey = null;         // ultimo bisogno di sopravvivenza annunciato nei log
let lastCraftKey = null;        // ultimo passo di approvvigionamento annunciato nei log
let lastEquipKey = null;        // ultimo ordine di equipaggiamento annunciato nei log
// R4: lo stato dei rifiuti del passo attivo. `stepRefusals` sono le chiavi che
// questo passo ha gia' visto rifiutare (`blocked`): restano escluse dalle
// opzioni finche' il passo e' lo stesso, cosi' il modello sceglie l'alternativa
// invece di ripetere la chiave appena rifiutata. `stepFailureAttempts` conta i
// rifiuti per passo: al tetto il passo fallisce e il piano viene ripianificato.
let stepRefusals = new Set();
let stepFailureAttempts = new Map();
// R4: il motivo del replan prodotto da un rifiuto tipizzato. Il rifiuto si
// classifica a **fine** iterazione (dove l'esito dell'azione e' noto), il replan
// gira all'inizio di quella dopo: senza questo canale il motivo andrebbe perso
// (`replanReason` vive dentro un'iterazione).
let pendingStepReplan = null;
let lastDropKey = null;         // ultimo ordine "getta" annunciato nei log
let lastCollectKey = null;      // ultimo ordine "cattura" annunciato nei log
let lostFollowSteps = 0;        // passi consecutivi con l'ordine "seguimi" aperto ma senza bersaglio
let lostEscortSteps = 0;        // passi consecutivi con la scorta aperta ma senza traccia dell'umano
let lostNoticeSent = false;     // l'avviso in chat e' uno per episodio, non uno per cooldown
let lostHoldSteps = 0;          // passi di attesa a tracce perse (nessuna azione, nessun modello)
let blindSteps = 0;             // passi consecutivi con harness cieco (sessione Bedrock caduta)
let forbiddenSteps = 0;         // passi consecutivi in cui il divieto di missione lascia zero azioni lecite
// Harness cieco: la sessione Bedrock e' caduta e non esiste nessuna azione
// reale. Si resiste (la riconnessione e' in corso) per un numero limitato di
// passi, poi il run si ferma con `harness_blind`: un run fermo e leggibile vale
// piu' di un bot che resta immobile e muore. Il 07/10/2026 il controller ha
// deciso `wait` 75 volte con una sola opzione e le ultime 9 morti del run hanno
// come ultima azione `wait(ok)` — la ragione (`not_connected`) era gia' nota e
// veniva solo registrata in `wait_only`.
const HARNESS_BLIND_MAX_STEPS = Number(process.env.HARNESS_BLIND_MAX_STEPS ?? 6);
const HARNESS_BLIND_WAIT_MS = Number(process.env.HARNESS_BLIND_WAIT_MS ?? 5000);
// R8: per quanti passi un segmento puo' restare bloccato (prerequisito mai
// comparso) prima che il goal si chiuda come `goal_blocked`. Durante questi
// passi la skill non si esegue e resta solo la preparazione: se il prerequisito
// arriva (una barca fabbricata) il blocco cade da solo.
const SKILL_BLOCKED_MAX_STEPS = Number(process.env.SKILL_BLOCKED_MAX_STEPS ?? 6);
// R8: le chiavi che *eseguono* il segmento bloccato: la meta del piano. Sono
// fuori dalle opzioni finche' il prerequisito manca; le chiavi di preparazione
// (fabbricare, prendere, cercare) restano offerte.
const BLOCKED_SKILL_KEYS = ['goto_waypoint', 'sneak_to'];
// Combattere a vita bassa e senza arma e' una condizione di morte: la scala
// deterministica non lo sceglie (07/10/2026: `SURVIVAL FIGHT attack_skeleton` a
// hp 4 con l'inventario vuoto, poi morte). Il modello resta libero di scegliere
// `attack_*` quando il piano lo giustifica: qui si toglie solo la scelta
// automatica, non l'opzione.
const FIGHT_MIN_HEALTH = Number(process.env.FIGHT_MIN_HEALTH ?? 10);
const ARMED_ITEMS = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword', 'trident', 'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'copper_axe', 'wooden_axe', 'copper_sword'];
const mayFight = (observation) => {
  const hp = Number(observation?.health ?? 20);
  const armed = ARMED_ITEMS.some(name => (observation?.inventory?.[name] ?? 0) > 0);
  return hp >= FIGHT_MIN_HEALTH && armed;
};
let mountHoldSteps = 0;         // passi a bordo con l'umano (nessuna azione, nessun modello)
let lastLostNoticeAt = 0;       // ultimo avviso "non ti vedo" (cooldown per episodio)
// Il budget e' rinnovabile: un ordine "seguimi" aperto non si esaurisce con
// MAX_STEPS azioni (l'impegno dura finche' non arriva un altro ordine).
let maxSteps = MAX_STEPS;
for (let step = 1; step <= maxSteps; step++) {
  obs = await api('GET', '/observe');
  stepsUsed = step;
  runProgress.steps = step;
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
  const humanCmd = await maybeHumanCommand(obs, {history, lastResult});
  if (humanCmd) {
    // Un ordine umano che arriva mentre un altro lavoro è in corso non lo
    // riorienta: il goal in corso va in SUSPENDED e l'ordine diventa un goal
    // figlio (priorità CHAT) che, al termine, lo riprende — la stessa meccanica
    // dell'emergenza (`SUSPENDED -> PENDING` nel session loop). Riorientano
    // ancora il goal in corso solo due casi: l'ordine di stop, che per
    // definizione chiude quello che sta girando, e la correzione dello stesso
    // richiedente (un secondo ordine dello stesso umano sostituisce il suo
    // precedente: un solo esito, non due). Un goal di emergenza non si sospende
    // per un ordine: prima finisce l'emergenza. L'ack è già partito in
    // `maybeHumanCommand`.
    const stopOrder = isStopOrder(humanCmd.entry.message);
    const requester = goal.source === GOAL_SOURCE.CHAT ? (goal.parameters?.from ?? null) : (goal.humanOrder?.from ?? null);
    const sameRequester = requester != null && String(requester).toLowerCase() === String(humanCmd.entry.from ?? '').toLowerCase();
    const delegated = !stopOrder && !sameRequester && goal.source !== GOAL_SOURCE.EMERGENCY &&
      goalManager.depth(goal.id) < MAX_GOAL_DEPTH;
    if (delegated) {
      // Il figlio nasce in `main` (è lì che si conosce l'esito del preempt): qui
      // si restituisce solo l'ordine da accodare.
      return {status: 'preempted', human: {plan: humanCmd.plan, entry: humanCmd.entry}, steps: stepsUsed, totalCost};
    }
    // `human_order_override` e' il caso in cui l'ordine **non** viene delegato a
    // un goal figlio (catena troppo profonda): il piano in corso viene buttato
    // via, e la traccia deve dirlo con quel nome, non con un generico
    // `human_order`.
    const overridden = !stopOrder && !sameRequester && goal.source !== GOAL_SOURCE.EMERGENCY;
    if (overridden) {
      log('human_order_override', {goalId: goal.id, from: humanCmd.entry.from, depth: goalManager.depth(goal.id), maxDepth: MAX_GOAL_DEPTH, reason: 'max_goal_depth'});
    }
    plan = humanCmd.plan;
    // Un nuovo ordine riorienta l'impegno: "seguimi" apre il follow, qualsiasi
    // altro ordine lo chiude (altrimenti resterebbe appeso per sempre).
    if (plan.follow) goal.follow = plan.follow; else delete goal.follow;
    if (plan.escort) goal.escort = plan.escort; else delete goal.escort;
    planTrace.flush({endedBy: overridden ? 'human_order_override' : 'human_order', step});
    plan = await publishPlan(plan);
    goal.plan = plan; goalManager.persist();
    planTrace.adopt({step, reason: 'human_order', plan});
    skillRun = null; // il piano umano sostituisce la skill attiva
    // R4: un ordine nuovo e' un passo nuovo: le chiavi rifiutate dal passo
    // precedente non valgono piu' (il mondo e l'obiettivo sono cambiati).
    stepRefusals = new Set(); stepFailureAttempts = new Map(); pendingStepReplan = null;
    // Un ordine può riorientare un goal nato autonomo: l'esito di *quel* goal
    // deve tornare a chi ha ordinato (non al planner autonomo).
    goal.humanOrder = {from: humanCmd.entry.from, message: humanCmd.entry.message, objective: plan.objective, at: Date.now(), targets: plan.targets ?? null, reasoned: humanCmd.entry.reasoned === true};
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
  // R8: il prerequisito del segmento. Finche' manca la skill non si esegue
  // (l'azione che la esegue esce dalle opzioni) e, se non e' mai comparso, il
  // goal si chiude esplicitamente dopo `SKILL_BLOCKED_MAX_STEPS` passi: un
  // prerequisito assente e' un blocco, non un «in corso» che consuma il budget.
  // La preparazione (`targets` del piano) resta possibile: se il prerequisito
  // arriva durante il segmento il blocco cade — e' la distinzione fra
  // preparazione ed esecuzione che `verifySkill` ripete sul verdetto.
  let segmentBlocked = false;
  if (skillRun) {
    skillRun.sawNight = skillRun.sawNight || obs.time?.night === true;
    const pre = skillRun.def?.preconditions ? evaluateCriteria(skillRun.def.preconditions, obs) : {ok: true};
    skillRun.preconditionsMet = pre.ok === true;
    if (pre.ok) {
      if (!skillRun.preconditionsEverMet) log('skill_unblocked', {step, skill: skillRun.id, milestone: skillRun.milestone ?? null});
      skillRun.preconditionsEverMet = true;
    } else if (!skillRun.preconditionsEverMet) {
      segmentBlocked = true;
      skillRun.blockedSteps = (skillRun.blockedSteps ?? 0) + 1;
      skillRun.preconditionReason = pre.reason ?? null;
      if (!skillRun.blockedLogged) {
        skillRun.blockedLogged = true;
        log('skill_blocked', {
          step, skill: skillRun.id, milestone: skillRun.milestone ?? null,
          reason: 'preconditions_unmet', precondition: pre.reason ?? null,
          preparing: unmetTargets(plan.targets, obs), maxSteps: SKILL_BLOCKED_MAX_STEPS,
        });
        console.log(`SKILL BLOCKED ${skillRun.id}: prerequisito mancante (${pre.reason ?? 'preconditions'})`);
      }
      if (skillRun.blockedSteps > SKILL_BLOCKED_MAX_STEPS) {
        failureReason = `skill_preconditions_unmet:${skillRun.id}`;
        console.log(`GOAL BLOCKED after ${step - 1} actions: ${skillRun.id} (${skillRun.preconditionReason ?? 'preconditions_unmet'})`);
        log('goal_blocked', {
          steps: step - 1, totalCost, skill: skillRun.id, milestone: skillRun.milestone ?? null,
          reason: 'preconditions_unmet', precondition: skillRun.preconditionReason ?? null,
          blockedSteps: skillRun.blockedSteps, curriculum: CURRICULUM ?? null,
          completedMilestones: [...completedMilestones],
        });
        planTrace.flush({endedBy: 'goal_blocked', step: step - 1});
        break;
      }
    }
    skillStatus = verifySkill(skillRun.def, skillRun.startObservation, obs, {context: {sawNight: skillRun.sawNight}});
    if (skillStatus.status === 'blocked') {
      // Il verdetto protegge gli altri percorsi d'ingresso: prerequisito assente
      // all'inizio **e** alla fine del segmento -> non e' successo (il criterio
      // l'ha soddisfatto qualcos'altro). Il gate qui sopra lo ha gia' dichiarato;
      // nel ledger resta la conferma del verifier, una volta per segmento.
      if (!skillRun.verdictLogged) {
        skillRun.verdictLogged = true;
        log('skill_unverifiable', {step, skill: skillRun.id, reason: skillStatus.reason, precondition: skillStatus.evidence?.precondition ?? null});
      }
    } else if (skillStatus.status === 'success' || skillStatus.status === 'failed') {
      const record = buildSkillRecord({
        skill: skillRun.id, status: skillStatus.status, actions: skillRun.actions,
        startedAt: skillRun.startedAt, failureReason: skillStatus.reason,
        context: {milestone: skillRun.milestone, evidence: skillStatus.evidence},
        // R4: il rifiuto tipizzato che ha portato al fallimento (`{step,
        // stepId, key, error, kind, retryable, evidence}`), se c'e' stato.
        failure: skillRun.lastFailure ?? null,
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
        // R5: chiude il goal il **motore**, non l'uguaglianza con una stringa.
        // Per un goal semplice e' la stessa cosa (il milestone appena verificato
        // entra in `completedMilestones`); per un goal composito e' l'unica cosa
        // che lo puo' chiudere: si chiude quando **tutti** i target sono
        // soddisfatti, non quando ne e' caduto uno.
        const reached = CURRICULUM ? nextMilestone(obs) : null;
        if (reached?.status === 'met') {
          console.log(`GOAL MET after ${step - 1} actions (curriculum ${CURRICULUM})`);
          log('goal_met', {steps: step - 1, totalCost, curriculum: CURRICULUM, targets: reached.targets ?? null, completedMilestones: [...completedMilestones]});
          planTrace.flush({endedBy: 'goal_met', step: step - 1});
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
  // `goalMet` vede il follow del *goal*: un waypoint raggiunto da un piano
  // ripianificato non puo' chiudere un ordine "seguimi" ancora aperto.
  const stickyPlan = withStickyEscort(withStickyFollow(plan, goal.follow), goal.escort);
  // Un ordine umano il cui piano non dichiara nulla di terminale (nessun
  // target/waypoint/follow/need/skill) non e' "soddisfatto": e' solo vuoto.
  // Senza questa guardia un ordine come "mangia le patate" finiva con
  // `GOAL MET after 0 actions` e in chat arrivava un "fatto" mai avvenuto
  // (visto live il 04/10). Un ordine del genere si chiude dopo almeno una
  // azione riuscita.
  const humanOrder = goal.source === GOAL_SOURCE.CHAT || !!goal.humanOrder;
  // Il mittente di un ordine puo' stare in `parameters` (goal nato in chat) o in
  // `humanOrder` (ordine che ha riorientato un goal): le risposte di blocco
  // devono indirizzarsi a lui, altrimenti escono come `@?` (visto live il
  // 07/10/2026 su «non ho diamanti in inventario, non posso gettarlo»).
  const humanSender = goal.humanOrder?.from ?? goal.parameters?.from ?? null;
  const openPlan = planIsOpen(stickyPlan);
  const hasWorked = step > 1 && lastResult?.ok === true;
  if ((!humanOrder || !openPlan || hasWorked) && goalMet(obs, stickyPlan, skillStatus, humanOrderTargets(goal))) {
    console.log(`GOAL MET after ${step - 1} actions`, JSON.stringify({position: obs.position, inventory: obs.inventory}));
    log('goal_met', {steps: step - 1, totalCost, obs});
    planTrace.flush({endedBy: 'goal_met', step: step - 1});
    goalReached = true;
    break;
  }

  // R4: un rifiuto tipizzato del passo precedente entra nella decisione di
  // questo passo. Prima dell'anti-loop, cosi' il motivo preciso (`step_failed:
  // <errore>`) non viene sovrascritto da quello generico (`anti_loop:*`).
  if (replanReason == null && pendingStepReplan) replanReason = pendingStepReplan;
  pendingStepReplan = null;

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
  // Con un ordine "seguimi" aperto il replan periodico e' rumore: l'obiettivo non
  // cambia finche' non arriva un altro ordine, e riscriverebbe il piano (a spese
  // del planner) rischiando target che allontanano il bot dall'umano.
  if (!replanReason && !goal.follow && !goal.escort && step > 1 && step % REPLAN_EVERY === 1) replanReason = 'periodic';
  // Un goal autonomo/emergenza è ancorato al suo predicato di successo
  // (bisogno o recupero loot): non va sostituito da un nuovo piano, o si perde
  // l'ancoraggio e il goal non si chiude. Si salta il replan.
  if (replanReason && (plan.need || plan.recover || plan.construction || plan.drop || plan.collect || plan.farm)) {
    log('replan_skipped', {step, reason: replanReason, need: plan.need ?? null, recover: plan.recover === true});
    replanReason = null;
  }
  if (replanReason) {
    const candidatePlan = shapedPlan(await planForStep(obs, replanReason, goal));
    if (candidatePlan?.met) { log('curriculum_goal_met', {step, reason: replanReason}); planTrace.flush({endedBy: `goal_met:${replanReason}`, step}); goalReached = true; break; }
    const sameSkill = candidatePlan?.skill && candidatePlan.skill === plan.skill;
    const replanTrace = `replan:${replanReason}`;
    plan = withStickyEscort(withStickyFollow(candidatePlan, goal.follow), goal.escort);
    plan = await publishPlan(plan);
    // Il piano pubblicato ha sostituito il precedente: il segmento nuovo si apre
    // solo dopo, cosi' una pubblicazione rifiutata non chiude la traccia vecchia.
    planTrace.flush({endedBy: replanTrace, step});
    goal.plan = plan; goalManager.persist();
    planTrace.adopt({step, reason: replanTrace, plan});
    // Un piano nuovo e' un passo nuovo: i rifiuti del precedente non si portano
    // dietro (sarebbero esclusioni di chiavi senza piu' un passo che le spiega).
    stepRefusals = new Set(); stepFailureAttempts = new Map(); pendingStepReplan = null;
    if (!sameSkill || !skillRun) skillRun = startSkillRun(plan, obs);
    log('replan', {step, reason: replanReason, objective: plan.objective, skill: plan.skill ?? null, milestone: plan.milestone ?? null});
    console.log('REPLAN', replanReason, plan.objective, plan.skill ? `[skill ${plan.skill}]` : '');
  }

  // Skill attiva per ranking e indicazioni di decisione: in emergenza vince il
  // governor, poi il campo `skill` del plan, poi il milestone suggerito.
  const milestoneHint = CURRICULUM ? nextMilestone(obs) : null;
  const active = resolveActiveSkill({skills: gameplaySkills, plan, governor, milestone: milestoneHint, observation: obs});
  const preferredIntents = skillPreferredIntents(active.skill);
  const optionsReply = await api('GET', '/options');
  const options = Array.isArray(optionsReply.options) ? optionsReply.options : [];
  // Quando il harness offre solo `wait` lo stato va spiegato nei log: non è una
  // scelta di Jev ma l'unica azione valida (morte, sonno, nulla di valido).
  if (options.length === 1 && options[0].key === 'wait') {
    log('wait_only', {step, reason: waitOnlyReason(obs)});
  }
  // Harness cieco: la sessione Bedrock è caduta e non c'è nessuna azione reale.
  // Non è una scelta del modello e non è un `wait` da eseguire: il bot immobile
  // viene ucciso. Si resiste un numero limitato di passi (la riconnessione è in
  // corso) e poi il run si ferma con `harness_blind`, senza consumare il budget
  // di azioni: un run fermo e leggibile vale più di un bot che muore in
  // silenzio.
  if (optionsReply.connected === false || options.length === 0) {
    blindSteps += 1;
    log('harness_blind', {step, consecutive: blindSteps, max: HARNESS_BLIND_MAX_STEPS, reason: optionsReply.blind ?? 'empty_options'});
    if (blindSteps > HARNESS_BLIND_MAX_STEPS) {
      runExitCode = 2;
      console.log(`HARNESS BLIND after ${step - 1} actions: nessuna azione valida (${optionsReply.blind ?? 'empty_options'})`);
      log('harness_blind_stop', {steps: step - 1, totalCost, consecutive: blindSteps, reason: optionsReply.blind ?? 'empty_options'});
      break;
    }
    await delay(HARNESS_BLIND_WAIT_MS);
    continue;
  }
  blindSteps = 0;
  // Cosa proporre a Jev: esclusioni esplicite (fallimento, cooldown anti-loop),
  // tetto di rilevanza e boost degli intenti della skill attiva. Il harness
  // resta l'unico proprietario della validità.
  const excludeKeys = [];
  if (lastFailedKey) excludeKeys.push({key: lastFailedKey, reason: 'failed'});
  // R8: un segmento bloccato non esegue la sua skill. Il waypoint e' la meta
  // della skill — camminarci a piedi era il falso «fatto» dell'08/10 — e resta
  // fuori dalle opzioni finche' il prerequisito manca. La preparazione no.
  if (segmentBlocked) for (const key of BLOCKED_SKILL_KEYS) excludeKeys.push({key, reason: 'skill_preconditions_unmet'});
  // M14: un oggetto che la missione deve minare non si prende da uno scrigno.
  // La chiave esce dalle opzioni offerte al decider (il harness la conosce
  // ancora: la validita' resta sua), cosi' il furto non e' una scelta.
  for (const key of requirementTakeKeys(MUST_MINE)) excludeKeys.push({key, reason: 'must_mine'});
  // M15: le chiavi vietate dalla missione non passano da `excludeKeys`: quel
  // canale e' un'esclusione del momento, e il ripiego di `filterOptions`
  // ripristina cio' che ha escluso. Il divieto ha il suo canale (`forbidKeys`),
  // che il ripiego rispetta, e vale per tutta la missione.
  // R4: la chiave che **questo passo** ha visto rifiutare con un approccio
  // bloccato. Resta fuori dalle opzioni finche' il passo e' aperto, cosi' la
  // decisione sceglie l'alternativa invece di ripetere la stessa azione.
  for (const key of stepRefusals) excludeKeys.push({key, reason: 'step_refused'});
  for (const [key, until] of cooldowns) {
    if (until > step) excludeKeys.push({key, reason: `anti_loop_until_${until}`});
    else cooldowns.delete(key);
  }
  const filtered = filterOptions(options, history, {max: MAX_OPTIONS, threshold: ANTI_LOOP_THRESHOLD, targets: plan.targets, preferredIntents, excludeKeys, forbidKeys: MISSION_FORBID});
  log('options', {
    step, offered: options.map(o => o.key), passed: filtered.options.map(o => o.key),
    excluded: filtered.excluded, droppedByCap: filtered.dropped.map(o => o.key),
    note: filtered.note ?? null, fallback: filtered.fallback ?? null,
    skill: active.skill?.id ?? null, skillSource: active.source, preferredIntents,
    ...(MISSION_FORBID.length ? {forbidden: MISSION_FORBID} : {}),
  });
  // M15: se il divieto di missione lascia il decider senza nessuna azione lecita
  // non e' una scelta del modello e non e' un `wait`: e' lo stesso stato cieco
  // del harness senza opzioni, con un motivo diverso. Si resiste un numero
  // limitato di passi, poi il run si chiude con `mission_forbidden_only`: un
  // budget speso su un passo senza azioni lecite e' peggio di un blocco
  // dichiarato (stesso spirito di R8).
  if (filtered.options.length === 0) {
    forbiddenSteps += 1;
    log('options_all_forbidden', {step, consecutive: forbiddenSteps, max: MISSION_FORBID_MAX_STEPS,
      forbidden: MISSION_FORBID, offered: options.map(o => o.key)});
    if (forbiddenSteps > MISSION_FORBID_MAX_STEPS) {
      runExitCode = 2;
      failureReason = 'mission_forbidden_only';
      console.log(`MISSION FORBIDDEN after ${step - 1} actions: nessuna azione lecita (${MISSION_FORBID.join(',')})`);
      log('mission_forbidden_stop', {steps: step - 1, totalCost, consecutive: forbiddenSteps, forbidden: MISSION_FORBID});
      break;
    }
    await delay(HARNESS_BLIND_WAIT_MS);
    continue;
  }
  forbiddenSteps = 0;
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
  // Finche' un ordine "seguimi" resta aperto la scelta e' deterministica: il
  // controller non interroga il modello a ogni passo (l'inseguimento lo esegue
  // l'harness, che muove e traccia per la sua finestra). L'LLM torna in gioco solo
  // quando l'harness non offre `follow_player` (bersaglio non tracciato); in
  // emergenza e' il governor a togliere l'opzione dagli `allowedIntents`.
  // Bisogno di sopravvivenza eseguibile adesso, per intento: respirare, uscire
  // dal pericolo, curarsi, mangiare, dormire. Il bisogno non e' il nome di
  // un'azione (nessuna opzione si chiama `heal`), quindi la scelta passa da
  // `chooseNeedAction`: in emergenza segue gli intenti ammessi dal governor
  // (gia' ordinati per priorita' del pericolo), altrimenti i bisogni in ordine.
  // Si dorme *nonostante tutto*, inseguimento compreso: l'azione non passa dal
  // modello, che poteva scegliere il waypoint e restare sveglio.
  const needAction = chooseNeedAction({ governor, options: filtered.options, policy: { fightAllowed: mayFight(obs) } });
  const needKey = needAction?.key || null;
  const needIntent = needAction?.intent || null;
  // Recupero dell'umano perso: con un ordine di follow aperto, se l'inseguimento
  // non e' piu' possibile si cammina verso l'ultima posizione nota (`seek_player`);
  // se non c'e' nemmeno quella si aspetta. Il bersaglio resta il goal, non il piano.
  // A bordo con l'umano il bot e' passeggero: la posizione la decide il server e
  // l'unica discesa la decide chi guida. Finche' quello stato dura non c'e' nessun
  // fallback di locomozione da offrire — inseguire a piedi un sedile non e'
  // un'azione in ritardo, e' un'azione impossibile. Allo smontaggio lo stato torna
  // `FOLLOWING` e i due rami qui sotto tornano disponibili da soli.
  const mountRiding = !!goal.follow && obs.mountFollow?.state === 'RIDING_WITH_HUMAN';
  const seekKey = !needKey && !mountRiding && goal.follow && filtered.options.some(o => o.key === 'seek_player') ? 'seek_player' : null;
  const followKey = !needKey && !mountRiding && goal.follow && filtered.options.some(o => o.key === 'follow_player') ? 'follow_player' : null;
  // Scorta aperta: si cammina verso la meta e si aspetta chi resta indietro.
  // Anche qui la scelta e' deterministica (nessuna chiamata al modello): l'esito
  // lo misura l'harness (`busy` a parte, `escort_to` dice quanto ha aspettato).
  const escortKey = !needKey && goal.escort && filtered.options.some(o => o.key === 'escort_to') ? 'escort_to' : null;
  if (escortKey && lastEscortTarget !== goal.escort?.from) {
    lastEscortTarget = goal.escort?.from ?? null;
    console.log(`ESCORT ORDER ${goal.escort?.from}: guida verso la meta (nessuna chiamata al modello)`);
    log('escort_order', {step, key: escortKey, target: goal.escort?.from ?? null, destination: goal.escort?.to ?? obs.escort?.target ?? null, waiting: obs.escort?.waiting === true, gap: obs.escort?.gap ?? null});
  } else if (!escortKey) {
    lastEscortTarget = null;
  }
  // La scorta si e' fermata perche' l'umano e' rimasto indietro: gli dice una
  // volta dove lo sta aspettando (`observe().position`), poi si riarma quando
  // torna a portata. Il cooldown copre un'attesa che dura minuti.
  if (goal.escort && obs.escort?.waiting === true) {
    await noticeEscortWaiting(goal.escort?.from, {reason: 'gap', episode: 'wait', obs, step});
  } else if (obs.escort?.waiting !== true) {
    escortWaitingSent = false;
  }
  // L'umano si e' imbarcato e c'e' un posto per il bot: salire *su quel mezzo* e'
  // una scelta deterministica che sta prima della scorta e di ogni fallback di
  // locomozione. Senza questa precedenza il bot inseguirebbe la barca a riva (o
  // salirebbe su un'altra barca col ramo `mount_*` generico), che e' esattamente
  // il comportamento da chiudere. Non e' stagnazione: l'attesa a riva e' il
  // tempo che l'umano torni o liberi un posto.
  const mountKey = !needKey && !mountRiding && goal.follow && filtered.options.some(o => o.key === 'join_human_mount') ? 'join_human_mount' : null;
  if (mountKey && lastMountTarget !== goal.follow) {
    lastMountTarget = goal.follow ?? null;
    console.log(`MOUNT ORDER ${goal.follow}: sale sul mezzo dell'umano (nessuna chiamata al modello)`);
    log('join_human_mount_order', {step, key: mountKey, target: goal.follow ?? null, mount: obs.mountFollow?.mount?.type ?? null, free: obs.mountFollow?.mount?.free ?? null, source: obs.mountFollow?.mount?.source ?? null});
  } else if (!mountKey) {
    lastMountTarget = null;
  }
  // Non e' salito: lo dice una volta, con le coordinate. `mount` e' la vista del
  // mezzo dell'umano; il motivo tipizzato (`human_mount_full`, `join_disabled`,
  // `mount_not_confirmed`...) va nei log, non in chat.
  if (goal.follow && obs.mountFollow?.state === 'WAITING_AT_SHORE') {
    await noticeMountWaiting(goal.follow, {reason: obs.mountFollow?.reason ?? null, mount: obs.mountFollow?.mount ?? null, obs, step});
  } else if (obs.mountFollow?.state !== 'WAITING_AT_SHORE') {
    mountWaitingSent = false;
  }
  // A bordo non c'e' nulla da decidere: il bot e' passeggero, la posizione la
  // scrive il server. L'ordine resta aperto senza consumare budget e senza
  // interrogare il modello (come l'attesa a tracce perse); un bisogno eseguibile
  // — mangiare, curarsi — passa comunque prima: la sosta non e' un silenzio, e'
  // l'unica azione sensata mentre si e' seduti.
  if (mountRiding && !needKey) {
    if (mountHoldSteps === 0) {
      console.log(`MOUNT HOLD ${goal.follow}: a bordo con l'umano (aspetto che sbarchi)`);
      log('mount_ride_hold', {step, target: goal.follow ?? null, reason: obs.mountFollow?.reason ?? null, mount: obs.mountFollow?.mount?.type ?? null, source: obs.mountFollow?.mount?.source ?? null});
    }
    mountHoldSteps += 1;
    await delay(FOLLOW_IDLE_POLL_MS);
    step -= 1; // un'attesa non consuma il budget: l'ordine deve restare aperto
    continue;
  }
  mountHoldSteps = 0;
  // Mentre si e' a bordo l'assenza di inseguimento non e' "umano perso": senza
  // questa esclusione i passi a bordo farebbero partire l'avviso "dove sei?".
  const lostFollow = !!goal.follow && !needKey && !mountRiding && !followKey;
  if (lostFollow) lostFollowSteps += 1; else lostFollowSteps = 0;
  if (needKey && lastNeedKey !== needKey) {
    lastNeedKey = needKey;
    console.log('SURVIVAL ' + (needIntent || 'need').toUpperCase() + ' ' + needKey + ' -> azione deterministica (' + (governor.rule ?? governor.mode) + ')');
    log('survival_need', {step, need: needAction.need ?? null, intent: needIntent, key: needKey, ladder: needAction.source, mode: governor.mode, rule: governor.rule ?? null, risk: governor.risk?.score ?? null, objective: governor.overrideObjective ?? null});
  } else if (!needKey) {
    lastNeedKey = null;
  }
  const pursuitKey = followKey || seekKey;
  if (pursuitKey) lostNoticeSent = false; // torna visibile: un nuovo episodio puo' avvisare di nuovo
  if (pursuitKey && lastFollowTarget !== goal.follow) {
    lastFollowTarget = goal.follow;
    if (followKey) {
      console.log(`FOLLOW ORDER ${goal.follow}: inseguimento deterministico (nessuna chiamata al modello)`);
      log('follow_order', {step, key: followKey, target: goal.follow});
    } else {
      console.log(`FOLLOW SEARCH ${goal.follow}: recupero all'ultima posizione nota (nessuna chiamata al modello)`);
      log('follow_seek', {step, key: seekKey, target: goal.follow, lastSeen: obs.follow?.lastSeen ?? null, lastSeenAgeMs: obs.follow?.lastSeenAgeMs ?? null});
    }
  } else if (!pursuitKey) {
    lastFollowTarget = null;
  }
  // Ultima risorsa: la ricerca autonoma e' fallita (nessun bersaglio per due
  // passi). Un messaggio per episodio, mai a ogni passo.
  if (lostFollow && !lostNoticeSent && lostFollowSteps >= LOST_NOTICE_AFTER_STEPS && Date.now() - lastLostNoticeAt > LOST_NOTICE_COOLDOWN_MS) {
    const notice = lostNotice({from: goal.follow, prefix: CHAT_PREFIXES[0], lang: CHAT_LANG});
    if (notice) {
      lastLostNoticeAt = Date.now();
      lostNoticeSent = true;
      console.log(`FOLLOW LOST ${goal.follow}: chiedo dove si trova (${lostFollowSteps} passi senza bersaglio)`);
      log('follow_lost', {step, target: goal.follow, steps: lostFollowSteps, lastSeen: obs.follow?.lastSeen ?? null, lastSeenAgeMs: obs.follow?.lastSeenAgeMs ?? null});
      void replyChat(notice, {to: goal.follow, context: 'lost_follow'});
    }
  }
  const lostWaitKey = lostFollow && !seekKey && filtered.options.some(o => o.key === 'wait') ? 'wait' : null;
  // L'umano non e' tracciato e la sua traccia non e' percorribile: l'ordine resta
  // aperto e il bot aspetta dove ha perso le tracce invece di lasciare il modello
  // libero di andarsene per la mappa (in produzione: `go_home`, `open_trade`).
  const lostHold = !needKey && !pursuitKey && !lostWaitKey && !!goal.follow &&
    !!obs.follow && !obs.follow.tracked && !obs.follow.searchable;
  if (lostHold) {
    if (lostHoldSteps >= LOST_HOLD_MAX_STEPS) {
      console.log(`FOLLOW RELEASED ${goal.follow}: nessuna traccia da ${lostHoldSteps} passi`);
      log('follow_released', {step, target: goal.follow, steps: lostHoldSteps, lastSeen: obs.follow?.lastSeen ?? null});
      delete goal.follow;
      lostHoldSteps = 0;
      lostFollowSteps = 0;
      lostNoticeSent = false;
    } else {
      if (lostHoldSteps === 0) {
        console.log(`FOLLOW HOLD ${goal.follow}: aspetto dove ho perso le tracce`);
        log('follow_hold', {step, target: goal.follow, lastSeen: obs.follow?.lastSeen ?? null, lastSeenAgeMs: obs.follow?.lastSeenAgeMs ?? null});
      }
      lostHoldSteps += 1;
      await delay(FOLLOW_IDLE_POLL_MS);
      step -= 1; // un'attesa non consuma il budget: l'ordine deve restare aperto
      continue;
    }
  } else {
    lostHoldSteps = 0;
  }
  // Scorta con l'umano fuori portata: come per il follow l'ordine resta aperto e
  // il bot aspetta (senza consumare budget) invece di lasciare il modello libero
  // di andarsene per la mappa; dopo `LOST_HOLD_MAX_STEPS` passi senza traccia
  // l'ordine si chiude, e il motivo finisce nei log (`escort_released`).
  const escortHold = !needKey && !escortKey && !pursuitKey && !!goal.escort && obs.escort?.tracked !== true;
  if (escortHold) {
    if (lostEscortSteps >= LOST_HOLD_MAX_STEPS) {
      console.log(`ESCORT RELEASED ${goal.escort?.from}: nessuna traccia da ${lostEscortSteps} passi`);
      log('escort_released', {step, target: goal.escort?.from ?? null, steps: lostEscortSteps});
      delete goal.escort;
      lostEscortSteps = 0;
    } else {
      if (lostEscortSteps === 0) {
        console.log(`ESCORT HOLD ${goal.escort?.from}: aspetto dove ho perso le tracce`);
        log('escort_hold', {step, target: goal.escort?.from ?? null, tracked: obs.escort?.tracked === true, ready: obs.escort?.ready === true});
      }
      // Una volta per episodio dice dove si e' fermata: chi non ha piu' il bot
      // in vista non ha altre occasioni di saperlo.
      await noticeEscortWaiting(goal.escort?.from, {reason: 'no_track', episode: 'hold', obs, step});
      lostEscortSteps += 1;
      await delay(FOLLOW_IDLE_POLL_MS);
      step -= 1; // un'attesa non consuma il budget: l'ordine deve restare aperto
      continue;
    }
  } else {
    lostEscortSteps = 0;
    escortHoldNoticeSent = false; // tracce ritrovate: un nuovo episodio puo' avvisare
  }
  // Ordine di equipaggiamento umano (`equipaggiati con l'elmo`): quando il
  // piano lo dichiara e l'harness offre davvero `equip_armor`, la scelta e'
  // deterministica — il modello non deve decidere se indossare l'armatura che
  // l'umano ha chiesto. Se `equip_armor` non c'e', l'inventario non ha pezzi:
  // l'ordine non puo' riuscire e si chiude subito, con un avviso (non si lascia
  // il modello libero di girare per la mappa dentro un goal impossibile).
  const canEquip = plan.equip === true && options.some(o => o.key === 'equip_armor');
  const equipKey = !needKey && !pursuitKey && !lostWaitKey && !lostHold && canEquip ? 'equip_armor' : null;
  const equipBlocked = !needKey && !pursuitKey && plan.equip === true && !canEquip;
  if (equipBlocked) {
    // Niente da indossare: si dice all'umano e il goal finisce *fallito* (non
    // "fatto"), invece di lasciare il modello libero dentro un goal impossibile.
    console.log('EQUIP ORDER: nessun pezzo di armatura in inventario');
    log('equip_order', {step, key: null, error: 'no_armor_in_inventory'});
    await replyChat(renderNoArmor({from: humanSender, maxLength: CHAT_REPLY_MAX_LENGTH, lang: CHAT_LANG}), {context: 'equip_no_armor', to: humanSender, prefixes: CHAT_PREFIXES});
    lastEquipKey = 'blocked';
    failureReason = 'no_armor_in_inventory';
    runExitCode = 2;
    break;
  } else if (equipKey && lastEquipKey !== equipKey) {
    lastEquipKey = equipKey;
    console.log('EQUIP ORDER: equip_armor deterministico (nessuna chiamata al modello)');
    log('equip_order', {step, key: equipKey});
  } else if (!equipKey) {
    lastEquipKey = null;
  }
  // Ordine di buttare via ("getta i diamanti"): quando il piano lo dichiara e
  // l'harness offre davvero `drop_item`, la scelta e' deterministica. Se non
  // c'e', l'inventario non ha (o non ha piu') quell'oggetto: l'ordine non puo'
  // riuscire e si chiude subito con un avviso, senza liberare il modello in un
  // goal impossibile.
  const canDrop = !!plan.drop && options.some(o => o.key === 'drop_item');
  const dropKey = !needKey && !pursuitKey && !lostWaitKey && !lostHold && !equipKey && canDrop ? 'drop_item' : null;
  const dropBlocked = !needKey && !pursuitKey && !!plan.drop && !canDrop;
  if (dropBlocked) {
    console.log('DROP ORDER: oggetto non in inventario');
    log('drop_order', {step, key: null, error: 'item_not_in_inventory', token: plan.drop?.token ?? null});
    await replyChat(renderNoItem({from: humanSender, item: plan.drop?.word ?? plan.drop?.token ?? '', maxLength: CHAT_REPLY_MAX_LENGTH, lang: CHAT_LANG}), {context: 'drop_no_item', to: humanSender, prefixes: CHAT_PREFIXES});
    lastDropKey = 'blocked';
    failureReason = 'item_not_in_inventory';
    runExitCode = 2;
    break;
  } else if (dropKey && lastDropKey !== dropKey) {
    lastDropKey = dropKey;
    console.log('DROP ORDER: drop_item deterministico (nessuna chiamata al modello)');
    log('drop_order', {step, key: dropKey, token: plan.drop?.token ?? null, count: plan.drop?.count ?? null});
  } else if (!dropKey) {
    lastDropKey = null;
  }
  // Ordine di raccogliere da terra ("cattura i diamanti"): stesso schema del
  // drop. `collect_drop` e' offerto solo se c'e' un drop che l'ordine nomina
  // (l'harness filtra per token), quindi se manca l'oggetto non e' a terra.
  const canCollect = !!plan.collect && options.some(o => o.key === 'collect_drop');
  const collectKey = !needKey && !pursuitKey && !lostWaitKey && !lostHold && !equipKey && !dropKey && canCollect ? 'collect_drop' : null;
  const collectBlocked = !needKey && !pursuitKey && !!plan.collect && !canCollect;
  if (collectBlocked) {
    console.log('COLLECT ORDER: nessun oggetto a terra');
    log('collect_order', {step, key: null, error: 'no_matching_drop', token: plan.collect?.token ?? null});
    await replyChat(renderNoDrop({from: humanSender, item: plan.collect?.word ?? plan.collect?.token ?? '', maxLength: CHAT_REPLY_MAX_LENGTH, lang: CHAT_LANG}), {context: 'collect_no_drop', to: humanSender, prefixes: CHAT_PREFIXES});
    lastCollectKey = 'blocked';
    failureReason = 'no_matching_drop';
    runExitCode = 2;
    break;
  } else if (collectKey && lastCollectKey !== collectKey) {
    lastCollectKey = collectKey;
    console.log('COLLECT ORDER: collect_drop deterministico (nessuna chiamata al modello)');
    log('collect_order', {step, key: collectKey, token: plan.collect?.token ?? null});
  } else if (!collectKey) {
    lastCollectKey = null;
  }
  // Ordine di fattoria ("raccogli le carote, rimpianta e metti il raccolto nel
  // baule"): una catena bounded e deterministica — i drop del raccolto a terra,
  // la mietitura, la rimpiantatura di compensazione, il deposito — in cui ogni
  // passo esiste solo se `/options` lo offre (l'harness resta il padrone della
  // validita'). Nessuna chiamata al modello.
  const farmAction = !needKey && !pursuitKey && !lostWaitKey && !lostHold && !equipKey && !dropKey && !collectKey
    ? farmStep(plan.farm, obs, filtered.options, {progress: plan.farm?.state ?? null, maxHarves: DEFAULT_FARM_MAX_HARVES})
    : null;
  const farmKey = farmAction?.key ?? null;
  if (plan.farm && !farmKey) {
    // Niente da fare *adesso*: nessuna pianta matura a tiro, nessun raccolto
    // guadagnato da mettere via. Se la catena non ha ancora lavorato e' un
    // ordine a vuoto: si dice all'umano (non si risponde "non vedo carote a
    // terra" davanti a un campo, e non si lascia il goal aperto a girare). Se
    // ha lavorato, l'ordine e' finito e l'esito e' il delta *misurato*.
    const worked = (plan.farm.state?.harvests ?? 0) > 0 || plan.farm.state?.moved === true;
    const outcome = farmOutcome(plan.farm, obs);
    if (!worked) {
      console.log('FARM ORDER: niente da fare adesso');
      log('farm_order', {step, key: null, error: 'nothing_to_do', crop: plan.farm.crop, ...outcome});
      await replyChat(renderFarmNothing({from: humanSender, item: plan.farm.word ?? plan.farm.crop, maxLength: CHAT_REPLY_MAX_LENGTH, lang: CHAT_LANG}), {context: 'farm_nothing', to: humanSender, prefixes: CHAT_PREFIXES});
      failureReason = 'nothing_to_do';
      runExitCode = 2;
      break;
    }
    console.log(`FARM ORDER: catena finita (${plan.farm.crop})`, JSON.stringify(outcome));
    log('farm_order', {step, key: null, done: true, crop: plan.farm.crop, ...outcome});
    // Il raccolto non e' finito negli scrigni (nessun deposito a tiro, o
    // contenuto noto invariato): l'ordine non si dichiara riuscito.
    failureReason = outcome.stored > 0 ? 'produce_stored' : 'produce_not_stored';
    if (outcome.stored <= 0) runExitCode = 2;
    break;
  }
  // Provviste per una costruzione: la regola sta nell'harness (inventario ->
  // bauli -> natura, mai costruzioni) e qui si esegue soltanto, senza chiedere
  // al modello. Il passo vale solo se l'harness lo offre davvero.
  const craftStep = !needKey && !pursuitKey && !lostWaitKey && !lostHold && !equipKey ? (obs.craft?.next ?? null) : null;
  const craftKey = craftStep && filtered.options.some(o => o.key === craftStep.key) ? craftStep.key : null;
  if (craftKey && lastCraftKey !== craftKey) {
    lastCraftKey = craftKey;
    console.log(`CRAFT SOURCE ${craftKey} (${craftStep.source}${craftStep.target ? ' for ' + craftStep.target : ''}): nessuna chiamata al modello`);
    log('craft_source', {step, key: craftKey, source: craftStep.source, item: craftStep.item ?? null, ingredient: craftStep.ingredient ?? null, target: craftStep.target ?? null, reason: craftStep.reason ?? null});
  } else if (!craftKey) {
    lastCraftKey = null;
  }
  const decision = needKey
    ? {key: needKey, reason: 'survival_' + (needIntent || 'need') + ':' + needKey, source: 'survival_need'}
    : mountKey
    ? {key: mountKey, reason: `join_human_mount:${goal.follow}:${obs.mountFollow?.mount?.type ?? ''}`, source: 'join_human_mount'}
    : escortKey
    ? {key: escortKey, reason: `escort_order:${goal.escort?.from ?? ''}`, source: 'escort_order'}
    : followKey
    ? {key: followKey, reason: `follow_order:${goal.follow}`, source: 'follow_order'}
    : seekKey
    ? {key: seekKey, reason: `follow_seek:${goal.follow}`, source: 'follow_seek'}
    : lostWaitKey
    ? {key: lostWaitKey, reason: `follow_lost:${goal.follow}`, source: 'follow_lost'}
    : equipKey
    ? {key: equipKey, reason: 'equip_order', source: 'equip_order'}
    : dropKey
    ? {key: dropKey, reason: 'drop_order', source: 'drop_order'}
    : collectKey
    ? {key: collectKey, reason: 'collect_order', source: 'collect_order'}
    : farmKey
    ? {key: farmKey, reason: `farm_order:${plan.farm?.crop ?? ''}:${farmAction?.phase ?? ''}`, source: 'farm_order'}
    : craftKey
    ? {key: craftKey, reason: `craft_source:${craftStep.source}:${craftKey}`, source: 'craft_source'}
    : (CONTROLLER === 'jev' ? await jevDecide(obs, filtered.options, decisionPlan) : await hermesDecide(obs, filtered.options, decisionPlan));
  const key = decision.key;
  if (typeof decision.cost === 'number') totalCost += decision.cost;
  runProgress.cost = totalCost;
  // Un inseguimento non e' stagnazione: `follow_player` che riesce a distanza e'
  // lo stato desiderato (l'umano e' li'), non un loop da punire con l'anti-loop.
  // Ne' una ricerca ne' un'attesa di recupero sono stagnazione: la prima ha un
  // bersaglio verificato dall'harness, la seconda e' il tempo che l'umano torni.
  chosenFingerprint = pursuitKey || escortKey || mountKey || lostWaitKey || craftKey || equipKey || dropKey || collectKey || farmKey ? null : progressFingerprint(obs, plan);
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
  lastResult = result;
  log('result', {step, key, ok: !!result.ok, error: result.error ?? null, ms: result.ms ?? null, missionId: goal.missionId ?? null});
  if (MISSION_REQUIREMENTS_ON) await creditMissionResult(step, key, result);
  // R4: un rifiuto non e' un errore generico. Si classifica, si marca **il
  // passo** che l'ha subito e si decide cosa farne: ritentare la stessa chiave,
  // cambiare approccio (la chiave rifiutata esce dalle opzioni, le alternative
  // restano) o far fallire il passo e ripianificare. Un rifiuto fuori vocabolario
  // resta `unknown`: terminale, mai indovinato ritentabile.
  let stepFailure = null;
  // `busy` non e' un verdetto sul passo: e' il lock dell'harness (gia' atteso
  // sopra, con `harness_busy` come traccia). Se il lock non si e' liberato non
  // c'e' niente da classificare: il prossimo passo ritenta.
  if (!result.ok && result.error !== 'busy') {
    const stepId = activeStepId(plan);
    const attemptKey = stepId ?? plan.skill ?? '_';
    const attempts = (stepFailureAttempts.get(attemptKey) ?? 0) + 1;
    stepFailureAttempts.set(attemptKey, attempts);
    stepFailure = failureRecord({
      step, stepId, key, error: result.error, attempts,
      evidence: refusalEvidence({observation: obs, plan, result}),
    });
    const disposition = failureDisposition(stepFailure, {attempts, maxAttempts: MAX_STEP_ATTEMPTS});
    const alternatives = siblingKeys(key, options.map(option => option.key), optionIntents);
    if (skillRun) skillRun.lastFailure = stepFailure;
    log('step_failed', {...stepFailure, disposition: disposition.action, dispositionReason: disposition.reason});
    if (disposition.action === 'switch') {
      // L'approccio bloccato esce dalle opzioni: la decisione non puo' ripetere
      // la chiave rifiutata. Le alternative restano offerte (sono il punto dello
      // `switch`) e vengono **registrate** nella revisione del passo, cosi' anche
      // un replan successivo sa cosa l'harness aveva gia' respinto.
      stepRefusals.add(key);
      log('step_switch', {step, stepId, key, alternatives});
    }
    if (disposition.action === 'replan') {
      pendingStepReplan = pendingStepReplan ?? `step_failed:${stepFailure.error}`;
    } else if (disposition.action === 'switch') {
      // La revisione vive **dentro** il passo (`steps[i].refused`) e viene
      // pubblicata: e' il passo che ha rifiutato un approccio a dichiararlo,
      // invece di far ripianificare tutto il piano. Un `retry`, invece, non ha
      // ancora deciso niente: il piano resta com'e' e si ritenta la stessa
      // chiave (nessuna esclusione, altrimenti il ritentativo non esisterebbe).
      const revised = reviseSteps(plan, stepFailure, {alternatives});
      if (revised !== plan) {
        plan = revised;
        goal.plan = plan; goalManager.persist();
        try { plan = await publishPlan(plan); } catch (error) { log('plan_revision_rejected', {step, error: error.message}); }
      }
    }
  }
  // R3: la decisione e il suo esito nella traccia del piano corrente. `by` e' il
  // ramo che ha scelto la chiave (`jev`, `survival_need`, `drop_order`, …).
  planTrace.record({step, key, by: decision.source ?? null, reason: decision.reason ?? null, ok: !!result.ok, error: result.error ?? null, ms: result.ms ?? null, kind: stepFailure?.kind ?? null, retryable: stepFailure?.retryable ?? null, stepId: stepFailure?.stepId ?? null});
  if (goal.missionId) {
    // `data.position` dà al consolidamento un'ancora spaziale forte (l'azione
    // riuscita dice *dove* la risorsa è stata trovata).
    await api('POST', '/mission/action', {missionId: goal.missionId, actionType: key, outcome: result.ok ? 'ok' : (result.error ?? 'failed'), startedAt: actStarted, completedAt: Date.now(), data: {position: obs.position, dimension: obs.dimension}}).catch(() => {});
  }
  console.log(`#${step} ${key} ->`, JSON.stringify(result));
  // Il progresso della catena di fattoria: quante mietiture sono andate a
  // segno, se l'ultima ha ripiantato da se' (se no, il passo successivo semina)
  // e se qualcosa e' stato messo via. Lo stato vive nel piano, cosi' un ordine
  // nuovo (che lo ricrea) riparte da zero e un resume non eredita i contatori
  // di un altro ordine.
  if (plan.farm && farmKey && farmAction) {
    const state = plan.farm.state ?? (plan.farm.state = {harvests: 0, needsPlant: false, moved: false});
    if (farmAction.phase === 'harvest') {
      state.harvests += 1;
      state.needsPlant = result?.replanted?.ok !== true;
      state.replanted = result?.replanted?.ok ?? null;
    } else if (farmAction.phase === 'plant') {
      state.needsPlant = false;
    } else if (farmAction.phase === 'store') {
      state.moved = true;
    }
    log('farm_step', {step, key: farmKey, phase: farmAction.phase, ok: !!result?.ok, error: result?.error ?? null, harvests: state.harvests, needsPlant: state.needsPlant, replanted: state.replanted ?? null});
  }
  // Inseguimento gia' soddisfatto (azione rientrata subito): si attende prima di
  // rileggere lo stato, altrimenti il loop gira a vuoto per ore.
  // Un bisogno risolto in pochi ms (notte saltata) non deve far girare il loop
  // a vuoto; il fingerprint resta comunque contato per il bisogno, cosi' un
  // `sleep` che fallisce e si ripete finisce nell'anti-loop.
  if ((pursuitKey || escortKey || mountKey || needKey || lostWaitKey || equipKey || dropKey || collectKey || farmKey || craftKey) && result?.ok && (result.ms ?? 0) < 250) await delay(FOLLOW_IDLE_POLL_MS);
  if ((goal.follow || goal.escort) && step >= maxSteps) {
    // Il budget si rinnova finche' l'ordine umano resta aperto: l'impegno
    // finisce con un altro ordine (o con un'emergenza che preempta il goal).
    maxSteps += MAX_STEPS;
    console.log(`FOLLOW open: step budget renewed (+${MAX_STEPS} -> ${maxSteps})`);
    log('follow_budget_renewed', {step, maxSteps, escort: !!goal.escort});
  } else if (step >= maxSteps) {
    console.log('step budget exhausted');
    log('budget_exhausted', {steps: step, totalCost});
  }
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
  planTrace.flush({endedBy: 'run_end', step: stepsUsed});
}
// Non si esce dal processo: l'esito torna al session loop (main), che decide se
// registrarlo e passare a IDLE o terminare (modalità one-shot).
return {status: goalReached ? 'success' : (runExitCode ? 'failed' : 'exhausted'), exitCode: runExitCode, steps: stepsUsed, totalCost, ...(failureReason ? {reason: failureReason} : {})};
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
          plan: cmd.plan, parameters: {from: cmd.entry.from, message: cmd.entry.message, targets: cmd.plan.targets ?? null, reasoned: cmd.entry.reasoned === true},
        });
        console.log(`IDLE -> goal ${goal.id} from ${cmd.entry.from}: ${goal.objective}`);
        log('human_order', {from: cmd.entry.from, xuid: cmd.entry.xuid, plan: cmd.plan, goalId: goal.id, via: 'idle'});
        return goal;
      }
      // Bisogni correnti del governor: nessun ordine umano -> se il governor
      // chiede di dormire (notte + letto) o di mettersi al riparo, il goal si
      // crea anche con AUTONOMY off. Il bisogno resta aperto (`plan.need`)
      // finche' il predicato deterministico non dice che e' risolto.
      const governor = evaluateSurvival(obs, {rules: survivalRules});
      // Il harness e' l'unico arbitro di cosa e' valido: la lista delle azioni
      // offerte ora serve sia ai bisogni sia ai lavori di villaggio, quindi si
      // legge una volta per giro di IDLE.
      let offered = null;
      const offeredKeys = async () => {
        if (!offered) {
          const availability = await api('GET', '/options').catch(() => null);
          offered = new Set((availability?.options || []).map(o => o.key));
        }
        return offered;
      };
      let candidate = null;
      if (governor.needs.length) {
        const keys = await offeredKeys();
        candidate = nextIdleGoal(obs, {
          rules: survivalRules, attempts: autonomousAttempts,
          cooldownMs: AUTONOMY ? AUTONOMY_COOLDOWN_MS : SURVIVAL_IDLE_COOLDOWN_MS,
          allow: (c) => keys.has(c.need) && governor.needs.includes(c.need),
        });
      }
      // Autonomia generale (bisogni non correnti): solo quando e' abilitata.
      if (!candidate && AUTONOMY && autonomousGoalCount < AUTONOMY_MAX_GOALS) {
        candidate = nextIdleGoal(obs, {rules: survivalRules, attempts: autonomousAttempts, cooldownMs: AUTONOMY_COOLDOWN_MS});
      }
      if (candidate) {
        autonomousAttempts.set(candidate.need, Date.now());
        if (AUTONOMY) autonomousGoalCount += 1;
        const goal = goalManager.enqueue({
          type: 'autonomous', source: candidate.source, priority: candidate.priority, objective: candidate.objective,
          plan: {objective: candidate.objective, targets: {}, waypoint: null, need: candidate.need, priority: 'autonomy', notes: `autonomy:${candidate.need}`},
          parameters: {need: candidate.need, mode: candidate.mode, reason: candidate.reason},
        });
        console.log(`IDLE -> autonomous goal ${goal.id} [${candidate.need}] ${goal.objective}`);
        log('idle_goal', {goalId: goal.id, need: candidate.need, source: candidate.source, mode: candidate.mode, reason: candidate.reason, autonomy: AUTONOMY});
        return goal;
      }
      // Lavoro nel villaggio: se non c'e' un bisogno da soddisfare, il bot cerca
      // un lavoro utile che il harness sta gia' offrendo (VILLAGE_WORK=off lo spegne).
      if (VILLAGE_WORK && villageGoalCount < VILLAGE_MAX_CHORES) {
        const chore = nextVillageChore(obs, {
          offered: await offeredKeys(), attempts: villageAttempts,
          cooldownMs: VILLAGE_COOLDOWN_MS, storeThreshold: VILLAGE_STORE_THRESHOLD,
        });
        if (chore) {
          villageAttempts.set(chore.id, Date.now());
          villageGoalCount += 1;
          const goal = goalManager.enqueue({
            type: 'village', source: GOAL_SOURCE.AUTONOMOUS, priority: chore.priority, objective: chore.objective,
            plan: {
              objective: chore.objective, targets: {}, waypoint: null, priority: 'village',
              chore: chore.id, choreTarget: chore.target ?? null,
              choreBefore: villageSnapshot(obs, {spend: chore.spend}), notes: `village:${chore.id}`,
            },
            parameters: {chore: chore.id, reason: chore.reason},
          });
          console.log(`IDLE -> village chore ${goal.id} [${chore.id}] ${goal.objective}`);
          log('village_chore', {goalId: goal.id, chore: chore.id, reason: chore.reason, utility: chore.utility, count: chore.count});
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

// M5: l'ordine umano riceve l'esito in chat (goal nato da un ordine, oppure goal
// riorientato da un ordine di stop). Il destinatario è chi ha impartito l'*ultimo*
// ordine su questo goal: un secondo umano che interrompe il lavoro lo sospende
// (non lo riorienta) e apre un goal suo, quindi un goal resta di chi l'ha ordinato
// e l'esito non può finire al primo della lista. Best-effort, mai bloccante.
async function reportHumanOutcome (goal, { status, steps = null, reason = null } = {}) {
  const humanFrom = goal.humanOrder?.from ?? (goal.source === GOAL_SOURCE.CHAT ? (goal.parameters?.from ?? null) : null);
  if (!humanFrom) return null;
  const objective = goal.humanOrder?.objective ?? goal.objective;
  const text = orderOutcome({
    from: humanFrom, status, objective, steps, reason,
    maxLength: CHAT_REPLY_MAX_LENGTH, lang: CHAT_LANG,
  });
  // Qui `obs` non è in scope: l'LLM riceve almeno l'obiettivo e i passi veri dal
  // `grounding`, così può riformulare senza inventare.
  await saySmart('outcome', {
    from: humanFrom,
    plan: {objective, follow: goal.humanOrder?.follow ?? null},
    grounding: text,
    fallback: text,
    reasoned: goal.humanOrder?.reasoned === true || goal.parameters?.reasoned === true,
  });
  return text;
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
    await maybeNarrateGoal(goal);
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
      if (outcome.human) {
        // Un ordine umano ha sospeso il goal in corso: l'ordine diventa un goal
        // figlio (priorità CHAT) e il padre riprenderà quando il figlio termina.
        // Il richiedente resta quello dell'ordine (`parameters.from`), quindi
        // l'esito del figlio va a chi l'ha ordinato.
        const suspended = goalManager.preempt(`human_order:${outcome.human.entry.from}`);
        const child = goalManager.enqueue({
          type: 'chat', source: GOAL_SOURCE.CHAT, objective: outcome.human.plan.objective,
          plan: outcome.human.plan,
          parameters: {from: outcome.human.entry.from, message: outcome.human.entry.message, targets: outcome.human.plan.targets ?? null, reasoned: outcome.human.entry.reasoned === true},
          parentGoal: goal.id,
        });
        console.log(`HUMAN ORDER ${outcome.human.entry.from}: suspend ${goal.id} -> run ${child.id}`);
        log('human_preempt', {parentGoalId: goal.id, goalId: child.id, from: outcome.human.entry.from, xuid: outcome.human.entry.xuid ?? null, plan: outcome.human.plan, suspended: suspended?.id ?? null});
        continue;
      }
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
    planTrace.flush({endedBy: 'goal_end'});
    // M5: l'ordine umano riceve l'esito in chat (goal nato da un ordine, oppure
    // goal riorientato da un ordine). Il destinatario è l'ultimo richiedente.
    await reportHumanOutcome(goal, {status: outcome.status, steps: outcome.steps ?? null, reason: final.reason ?? outcome.reason ?? null});
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
    // M3c: chi ha raccolto adesso riporta, prima di tornare in IDLE.
    await maybeStoreEpilogue(goal, outcome);
    enterState('GOAL_COMPLETED', {goalId: goal.id, status: final.status});
    // La pila dei goal si scioglie prima di ogni uscita: se questo goal aveva
    // sospeso un padre, il padre torna in coda (o si chiude, se nel frattempo è
    // già soddisfatto). Anche in one-shot: il padre resta PENDING e la prossima
    // sessione lo raccoglie, invece di lasciarlo orfano in SUSPENDED.
    if (goal.parentGoal) {
      const parent = goalManager.get(goal.parentGoal);
      if (parent?.status === GOAL_STATUS.SUSPENDED) {
        // Prima di rimettere in coda il goal sospeso si rilegge il mondo: se il
        // suo criterio di successo è già soddisfatto (il figlio ha fatto il
        // lavoro, o il mondo è cambiato) si chiude senza rieseguirlo. La ripresa
        // non riprende un'azione a metà: `runGoal` riparte dal primo passo con
        // il piano rivalutato sul mondo attuale.
        const obs = await api('GET', '/observe').catch(() => null);
        let satisfied = false;
        if (obs) {
          try { satisfied = goalAlreadySatisfied(parent, obs); }
          catch (error) { log('goal_resume_check_failed', {goalId: parent.id, error: error.message}); }
        }
        if (satisfied) {
          goalManager.complete(parent.id, {resumed: false, alreadySatisfied: true});
          console.log(`GOAL ${parent.id} COMPLETED (already satisfied while suspended)`);
          log('goal_resume_satisfied', {goalId: parent.id, after: goal.id, suspendedBy: parent.reason ?? null, steps: 0, totalCost: 0});
          await reportHumanOutcome(parent, {status: 'success', steps: 0, reason: null});
        } else {
          goalManager.resume(parent.id);
          console.log(`RESUME ${parent.id} (suspended while ${goal.id} ran)`);
          log('goal_resumed', {goalId: parent.id, after: goal.id, attempts: parent.attempts, suspendedBy: parent.reason ?? null});
        }
      }
    }
    // Un errore fatale chiude il run (dopo aver chiuso la missione): niente
    // cicli di retry silenziosi in session mode.
    if (outcome.error) { exitCode = outcome.exitCode ?? 1; break; }
    if (!SESSION) {
      // Un padre appena rimesso in coda (`resume` lo riporta a PENDING) e' lavoro
      // ancora aperto: uscire qui lo lasciava orfano a meta' spedizione — live
      // 08/10/2026 il run e' finito con `EXIT=0` subito dopo `RESUME g1`, alla
      // prima morte. Il run one-shot esce solo quando la coda e' vuota.
      if (goalManager.pending().length) continue;
      exitCode = outcome.exitCode;
      break;
    }
  }
  goalManager.flush();
  // Le connessioni keep-alive di fetch tengono vivo il processo: esci esplicitamente.
  process.exit(exitCode);
}

// In session mode un SIGTERM/SIGINT deve salvare la coda prima di uscire.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    // Un timeout di deploy uccide il processo prima del `run_end` normale: senza
    // questa riga una run interrotta non lascia né passi né costo (06/10,
    // `diamond-20261006-4`: ultimo record un `result`, nessun totale).
    log('run_end', {steps: runProgress.steps, totalCost: runProgress.cost, curriculum: CURRICULUM, goalId: goalManager.current?.id ?? null, signal, interrupted: true});
    planTrace.flush({endedBy: `signal:${signal}`, step: runProgress.steps});
    goalManager.flush();
    process.exit(0);
  });
}

await main();
