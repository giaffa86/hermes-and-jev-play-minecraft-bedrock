// R4 — il rifiuto tipizzato: cosa l'harness ha detto no, e cosa ne fa il passo.
//
// Fino a R3 un rifiuto era una stringa in un log (`no reachable iron_ore found
// nearby`) e l'unica reazione possibile era il replan globale: un passo non
// poteva dire «questo approccio e' stato rifiutato, prova l'altro». Il
// vocabolario dei rifiuti e' pero' gia' tipizzato dal harness, e porta
// un'informazione che il `log('result')` buttava via: *quale* rifiuto.
//
// Questo modulo e' puro: classifica un errore dell'harness in un rifiuto
// strutturato `{step, stepId, key, error, kind, retryable, hint, evidence}`,
// dice cosa il passo puo' farne (`retry` / `switch` / `replan`) e sa scrivere il
// rifiuto **dentro** lo step (`steps[i].refused`), cosi' il passo che e' stato
// rifiutato porta con se' la sua revisione invece di far ripianificare tutto.
//
// La classificazione non e' un giudizio sul mondo: e' una lettura dei rifiuti
// che l'harness sa gia' produrre. Un errore fuori vocabolario e' `unknown` e
// terminale — mai indovinato come ritentabile.

export const STEP_FAILURE_VERSION = 1;

// I tipi ammessi, in ordine di valutazione delle regole (il primo che combacia
// vince). `busy` e' un lock, non un verdetto: lo nomina qui perche' la traccia
// deve poterlo leggere, ma il controller lo consuma prima di arrivare qui.
export const FAILURE_KINDS = Object.freeze([
  'busy',        // il lock dell'harness era tenuto
  'timeout',     // il harness ha toccato il proprio tetto di tempo
  'transient',   // client/world non pronto
  'moved',       // il bersaglio si e' spostato (o e' sparito) tra decisione e azione
  'blocked',     // approccio/bersaglio non disponibile: irraggiungibile, protetto, non sicuro
  'refused',     // una regola del harness ha detto no deliberatamente
  'prerequisite',// al passo manca qualcosa: il piano deve aggiungere il passo che lo procura
  'unknown',     // fuori vocabolario
]);

// Ritentabile: *la stessa chiave* puo' tornare. `blocked` non e' ritentabile ma
// un altro approccio puo' funzionare (`switch`); tutto il resto fallisce il
// passo e fa ripianificare il piano.
export const RETRYABLE_KINDS = Object.freeze(['busy', 'timeout', 'transient', 'moved']);
export const SWITCH_KINDS = Object.freeze(['blocked']);
// Quante volte lo stesso passo puo' essere rifiutato prima che il rifiuto conti
// come fallimento del passo. Due: un ritentativo vero e una alternativa.
export const MAX_STEP_ATTEMPTS = 2;

const HINTS = Object.freeze({
  busy: 'the harness lock was held: the same action is worth retrying',
  timeout: 'the harness hit its own deadline: retryable, but the approach may just be too slow',
  transient: 'the client or the world was not ready: retryable',
  moved: 'the target moved away between the decision and the action: look again',
  blocked: 'this approach or target is not available (unreachable, protected, unsafe): another one may be',
  refused: 'the harness rule refused the action deliberately: the plan must change, not the key',
  prerequisite: 'the step is missing something it needs: the plan must add the step that provides it',
  unknown: 'not in the vocabulary: terminal until the plan changes',
});

// Le regole, in ordine. `[a-z_]+` in coda: le famiglie del harness sono
// `<qualcosa>_timeout` (action/container_open/mining/smelt/trade_result/ride/
// escort/combat/pillar/shell/raw_break/bridge/block_confirmation) e
// `<bersaglio>_gone` (animal/sheep/trader/vehicle/piglin) e `player_not_found`
// (un umano che si e' allontanato mentre il bot lo cercava).
const RULES = Object.freeze([
  { kind: 'busy', test: /^busy$/ },
  { kind: 'timeout', test: /(^|_)timeout$/ },
  { kind: 'refused', test: /(^|_)refused$/ },
  { kind: 'transient', test: /^(not_connected|world_not_loaded|not_ready|not_spawned|harness_blind|action_in_progress|orientation_not_confirmed|mount_not_confirmed|gap_unknown)$/ },
  { kind: 'moved', test: /(^|_)(gone|left|not_found)$/ },
  {
    kind: 'blocked',
    test: /(^|_)unreachable$|^no reachable |^no_(safe_cell|place_spot|gap_to_bridge|lava_ahead|position|placeable_block|diggable)|^not_diggable_|^protected_|^unsafe_|^block_still_present$|^position_required$|^mine_target_missing$/,
  },
  {
    kind: 'prerequisite',
    test: /^missing_|^no_(food|feed_for_type|armor_in_inventory|repeater_nearby|escort_target|player_target)|^nothing_to_(drop|deposit)|^item_not_in_container$/,
  },
]);

const unknown = () => ({ kind: 'unknown', retryable: false });

// Il rifiuto dell'harness -> il suo tipo. `no reachable iron_ore found nearby`
// non e' un errore generico: e' `blocked`, e il prossimo tentativo deve cambiare
// approccio, non ripetere la stessa chiave.
export function classifyFailure (error) {
  const name = typeof error === 'string' ? error : String(error?.message ?? error ?? '');
  if (!name) return unknown();
  for (const rule of RULES) {
    if (rule.test.test(name)) return { kind: rule.kind, retryable: RETRYABLE_KINDS.includes(rule.kind) };
  }
  return unknown(name);
}

export const isRetryable = kind => RETRYABLE_KINDS.includes(kind);

// Il feedback tipizzato che un passo capisce: `{step, error, evidence,
// retryable}` (roadmap R4) piu' il contesto che serve a leggerlo e a ricondurlo
// allo step che l'ha subito.
export function failureRecord ({
  step = null, stepId = null, key = null, error = null, evidence = null,
  attempts = 1, at = Date.now(),
} = {}) {
  const { kind, retryable } = classifyFailure(error);
  return {
    step,
    stepId,
    key,
    error: typeof error === 'string' ? error : String(error ?? 'unknown'),
    kind,
    retryable,
    hint: HINTS[kind] ?? null,
    attempts,
    evidence: evidence ?? null,
    at,
  };
}

// Cosa fare del rifiuto: `retry` (stessa chiave, il passo resta), `switch`
// (stessa passo, altro approccio) o `replan` (il passo e' fallito e il piano
// deve cambiare). Un ritentabile che ha esaurito i tentativi non e' piu'
// ritentabile: diventa un fallimento del passo.
export function failureDisposition (record, { attempts = record?.attempts ?? 1, maxAttempts = MAX_STEP_ATTEMPTS } = {}) {
  if (!record) return { action: 'replan', reason: 'unknown', kind: 'unknown', retryable: false };
  const common = { kind: record.kind, retryable: !!record.retryable, attempts };
  const exhausted = attempts >= maxAttempts;
  if (record.retryable) {
    return exhausted
      ? { action: 'replan', reason: `${record.kind}_exhausted`, ...common }
      : { action: 'retry', reason: `${record.kind}_retry`, ...common };
  }
  if (SWITCH_KINDS.includes(record.kind)) {
    return exhausted
      ? { action: 'replan', reason: `${record.kind}_exhausted`, ...common }
      : { action: 'switch', reason: `${record.kind}_alternative`, ...common };
  }
  return { action: 'replan', reason: `${record.kind}_terminal`, ...common };
}

// Lo step a cui il rifiuto appartiene: quello che il piano dichiara attivo (il
// suo campo `skill`), altrimenti il primo. Serve a marcare **quel** passo.
export function activeStepId (plan) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  if (!steps.length) return null;
  const wanted = plan?.skill ? steps.find(step => step?.skill === plan.skill) : null;
  return (wanted ?? steps[0])?.id ?? null;
}

// Le altre chiavi offerte che servono lo stesso intento: l'alternativa di un
// approccio rifiutato (`mine_iron_ore` rifiutata -> `mine_deepslate_iron_ore`).
// `intentsOf` e' iniettato per restare puri e non dipendere dal vocabolario:
// l'harness resta l'unica fonte di validita', quindi le alternative si cercano
// solo tra le chiavi che `/options` ha davvero offerto.
export function siblingKeys (key, optionKeys = [], intentsOf = () => []) {
  const mine = new Set(intentsOf(key).filter(intent => intent !== 'unknown'));
  if (!mine.size) return [];
  const out = [];
  for (const other of optionKeys) {
    if (other === key) continue;
    const theirs = intentsOf(other).filter(intent => intent !== 'unknown');
    if (theirs.some(intent => mine.has(intent))) out.push(other);
  }
  return out;
}

// Il passo rifiutato porta la sua revisione dentro `steps[]`: il rifiuto
// tipizzato, quante volte e' successo e la sua storia recente. Il piano non
// viene mutato: ne torna uno nuovo (o lo stesso oggetto, se non c'e' nulla da
// marcare), cosi' il chiamante sa se c'e' qualcosa da pubblicare.
export function reviseSteps (plan, record, { alternatives = [], maxRevisions = 4 } = {}) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  if (!record || !steps.length) return plan;
  const wanted = record.stepId ?? activeStepId(plan);
  let index = wanted != null ? steps.findIndex(step => step?.id === wanted) : -1;
  if (index < 0) index = 0;
  const step = steps[index] ?? {};
  const history = Array.isArray(step.revisions) ? step.revisions : [];
  const revisions = [...history, {
    step: record.step ?? null,
    error: record.error,
    kind: record.kind,
    retryable: !!record.retryable,
    at: record.at ?? null,
  }].slice(-maxRevisions);
  const revised = {
    ...step,
    refused: {
      step: record.step ?? null,
      error: record.error,
      kind: record.kind,
      retryable: !!record.retryable,
      at: record.at ?? null,
      alternatives: [...alternatives],
    },
    refusalCount: (step.refusalCount ?? 0) + 1,
    revisions,
  };
  const next = [...steps];
  next[index] = revised;
  return { ...plan, steps: next };
}

// L'evidenza di un rifiuto: cosa il controller sapeva *e* cosa il harness ha
// detto oltre a `ok`/`error`. Piccola per costruzione (un campo grande non e'
// evidenza, e' dump): la posizione, la dimensione, i target del piano e i campi
// extra del rifiuto, scartando quelli troppo grossi.
export function refusalEvidence ({ observation = null, plan = null, result = null } = {}) {
  const evidence = {};
  if (observation?.position) evidence.position = { ...observation.position };
  if (observation?.dimension) evidence.dimension = observation.dimension;
  if (plan?.targets && Object.keys(plan.targets).length) evidence.targets = { ...plan.targets };
  if (result && Number.isFinite(result.ms)) evidence.ms = result.ms;
  if (result) {
    for (const [name, value] of Object.entries(result)) {
      if (name === 'ok' || name === 'error' || name === 'ms' || value == null) continue;
      let size = 0;
      try { size = JSON.stringify(value)?.length ?? 0; } catch { continue; }
      if (size > 200) continue;
      evidence[name] = value;
    }
  }
  return evidence;
}
