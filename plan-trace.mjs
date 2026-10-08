// R3 — la traccia del piano: una riga strutturata per ogni piano adottato.
//
// Il *perche'* di un run oggi e' sparso fra decine di `log()` diversi: quali
// passi chiedeva quel piano, quale chiave ha scelto il controller, quali rifiuti
// ha visto l'harness, perche' il piano e' stato sostituito. Ricostruirlo vuol
// dire leggere `controller.jsonl` a mano e incrociarlo con `actions.jsonl`.
//
// Questo modulo scrive una riga per **segmento di piano** in
// `runs/<run>/plan-trace.jsonl`:
//
//   {v, planId, source, reason, objective, subgoal, steps[],
//    startedAt, endedAt, ms, endedBy, actions, ok, failed,
//    decisions[{step,key,by,reason}], refusals[{step,key,error,ms}]}
//
// `source` e' la **provenienza del piano** — `hermes` (il modello),
// `deterministic` (un ramo che non chiama il modello), `curriculum` (la
// progressione) o `construction` — non chi l'ha chiesto: un ordine umano puo'
// produrre un piano deterministico o uno di Hermes. Nessun chain-of-thought:
// solo cio' che il controller ha deciso e cio' che l'harness ha risposto.
//
// Il writer non perde un segmento se una `flush()` manca: il segmento resta
// aperto e la riga esce piu' tardi, piu' lunga. Una `flush()` esplicita dice
// *perche'* il segmento si e' chiuso (`endedBy`: `replan:<reason>`,
// `human_order`, `goal_met`, `run_end`, …).
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PLAN_TRACE_VERSION = 1;
// Le provenienze ammesse. Un piano senza `source` e' un piano di Hermes: e' il
// produttore di default da quando esiste il controller.
export const PLAN_SOURCES = Object.freeze(['hermes', 'deterministic', 'curriculum', 'construction']);
const DEFAULT_SOURCE = 'hermes';
// Un segmento lungo (una notte intera su un solo piano) non deve gonfiare il
// file: oltre il tetto si contano le voci omesse, invece di elencarle.
const MAX_ENTRIES = 64;
const MAX_STEPS = 12;

export const planTraceSource = plan => (PLAN_SOURCES.includes(plan?.source) ? plan.source : DEFAULT_SOURCE);

// Gli step di R1 ridotti all'osso: quello che serve a capire il piano, senza i
// campi vuoti. `verify` sono nomi di criterio, mai key di `/options`.
export function planTraceSteps (plan, { limit = MAX_STEPS } = {}) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  return steps.slice(0, limit).map(step => {
    const out = { id: step?.id ?? null, skill: step?.skill ?? null };
    if (step?.circuit) out.circuit = step.circuit;
    if (step?.targets && Object.keys(step.targets).length) out.targets = { ...step.targets };
    if (Array.isArray(step?.verify) && step.verify.length) out.verify = [...step.verify];
    return out;
  });
}

// La forma del piano come la vede la traccia. `stepCount` e' il numero vero di
// step (non quelli mostrati), cosi' un troncamento non mente sul totale.
export function planTraceShape (plan) {
  return {
    source: planTraceSource(plan),
    objective: typeof plan?.objective === 'string' ? plan.objective : null,
    subgoal: typeof plan?.subgoal === 'string' ? plan.subgoal : null,
    steps: planTraceSteps(plan),
    stepCount: Array.isArray(plan?.steps) ? plan.steps.length : 0,
  };
}

export function createPlanTrace ({ dir, file = null, now = Date.now, write = appendFileSync } = {}) {
  const target = file ?? join(dir, 'plan-trace.jsonl');
  const rows = [];
  let current = null;
  let seq = 0;
  const push = (name, entry) => {
    if (!current) return false;
    if (current[name].length >= MAX_ENTRIES) {
      current.omitted[name] = (current.omitted[name] ?? 0) + 1;
      return false;
    }
    current[name].push(entry);
    return true;
  };
  return {
    file: target,
    get rows () { return rows; },
    get current () { return current; },
    // Apre un segmento. Un segmento ancora aperto viene chiuso come `replaced`:
    // l'ultima riga e' sempre completa anche se il chiamante dimentica una
    // `flush()` esplicita.
    adopt ({ step = null, reason = 'start', plan = null } = {}) {
      if (current) this.flush({ endedBy: 'replaced', step });
      const shape = planTraceShape(plan);
      current = {
        v: PLAN_TRACE_VERSION,
        planId: `p${++seq}`,
        step,
        reason,
        source: shape.source,
        objective: shape.objective,
        subgoal: shape.subgoal,
        steps: shape.steps,
        stepCount: shape.stepCount,
        startedAt: now(),
        endedAt: null,
        ms: null,
        endedBy: null,
        actions: 0,
        ok: 0,
        failed: 0,
        decisions: [],
        refusals: [],
        omitted: {},
      };
      return current.planId;
    },
    decided ({ step = null, key = null, by = null, reason = null } = {}) {
      return push('decisions', { step, key, by, reason });
    },
    refused ({ step = null, key = null, error = null, ms = null } = {}) {
      return push('refusals', { step, key, error, ms });
    },
    // Un esito d'azione: conta e finisce in `decisions` o `refusals`. `by` e'
    // il ramo che ha scelto la chiave (`jev`, `survival_need`, `drop_order`, …).
    record ({ step = null, key = null, by = null, reason = null, ok = null, error = null, ms = null } = {}) {
      if (!current) return null;
      current.actions += 1;
      if (ok === true) current.ok += 1;
      else current.failed += 1;
      if (ok === true) this.decided({ step, key, by, reason });
      else this.refused({ step, key, error: error ?? 'unknown', ms });
      return current;
    },
    // Chiude il segmento e scrive la riga. Idempotente: la seconda chiamata non
    // fa nulla, cosi' piu' punti di chiusura possono chiamarla senza duplicare.
    flush ({ endedBy = null, step = null } = {}) {
      if (!current) return null;
      const row = { ...current, untilStep: step ?? current.step, omitted: { ...current.omitted } };
      row.endedAt = now();
      row.ms = row.endedAt - row.startedAt;
      row.endedBy = endedBy;
      for (const name of Object.keys(row.omitted)) if (!row.omitted[name]) delete row.omitted[name];
      current = null;
      rows.push(row);
      try { write(target, JSON.stringify(row) + '\n'); }
      catch (error) { console.error('[plan-trace] write failed:', error.message); }
      return row;
    },
  };
}

export function summarizePlanTrace (rows = [], { top = 10 } = {}) {
  const bySource = {};
  const endedBy = {};
  const refusalsByError = {};
  let decisions = 0;
  let refusals = 0;
  let steps = 0;
  let actions = 0;
  let ok = 0;
  let failed = 0;
  let replans = 0;
  let omitted = 0;
  for (const row of rows) {
    const source = row?.source ?? DEFAULT_SOURCE;
    bySource[source] = (bySource[source] ?? 0) + 1;
    const end = row?.endedBy ?? 'open';
    endedBy[end] = (endedBy[end] ?? 0) + 1;
    if (end.startsWith('replan')) replans += 1;
    decisions += row?.decisions?.length ?? 0;
    refusals += row?.refusals?.length ?? 0;
    for (const refusal of row?.refusals ?? []) {
      const error = refusal?.error ?? 'unknown';
      refusalsByError[error] = (refusalsByError[error] ?? 0) + 1;
    }
    steps += row?.steps?.length ?? 0;
    actions += row?.actions ?? 0;
    ok += row?.ok ?? 0;
    failed += row?.failed ?? 0;
    for (const count of Object.values(row?.omitted ?? {})) omitted += count;
  }
  const last = rows.at(-1) ?? null;
  const rank = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, top);
  return {
    plans: rows.length,
    bySource,
    replans,
    endedBy,
    steps,
    decisions,
    refusals,
    refusalsByError,
    actions,
    ok,
    failed,
    omitted,
    topSources: rank(bySource),
    topRefusals: rank(refusalsByError),
    topEndedBy: rank(endedBy),
    firstAt: rows.at(0)?.startedAt ?? null,
    lastAt: last?.endedAt ?? null,
    lastPlan: last
      ? { planId: last.planId ?? null, source: last.source ?? DEFAULT_SOURCE, objective: last.objective ?? null, subgoal: last.subgoal ?? null, stepCount: last.stepCount ?? (last.steps?.length ?? 0), steps: last.steps ?? [] }
      : null,
  };
}

export function readPlanTrace (dir) {
  const file = join(dir, 'plan-trace.jsonl');
  if (!existsSync(file)) return null;
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* una riga tronca non e' un record */ }
  }
  return rows;
}
