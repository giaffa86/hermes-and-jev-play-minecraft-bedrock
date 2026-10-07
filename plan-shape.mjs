// R1 — la forma tipizzata del piano: `objective → subgoal → steps[]`.
//
// Un piano qui e' sempre stato un JSON piatto con un sacco di suggerimenti
// (`objective`, `targets`, `waypoint`, `skill`, `follow`, …). Questo modulo non
// aggiunge una seconda fonte di verita': **deriva** da cio' che il progetto gia'
// dichiara — `skills/gameplay/**` e `knowledge/progression.json` — una struttura
// esplicita, ordinata, di uno solo livello sopra le azioni:
//
//   plan.subgoal : string|null   il pezzo corrente dell'objective (leggibile)
//   plan.steps   : [{ id, skill, circuit, targets, verify }]
//
// Ogni step nomina un artefatto dichiarativo (una skill e/o un circuito) e lo
// stato che deve raggiungere (`verify`, nomi di criterio da `CRITERIA_KEYS`).
// Nessuno step nomina una key di `/options`: le azioni restano una scelta del
// controller a runtime, mai un campo del piano. Il modulo e' puro: nessuna rete,
// nessun server, nessun orologio.

import { CRITERIA_KEYS } from './survival/verify.mjs';

const CRITERIA = new Set(CRITERIA_KEYS);

// I nomi di criterio usati da un blocco `success`, appiattendo i combinatori.
export function criteriaNames (criteria, out = new Set()) {
  if (!criteria || typeof criteria !== 'object') return out;
  if (Array.isArray(criteria)) {
    for (const sub of criteria) criteriaNames(sub, out);
    return out;
  }
  for (const [key, value] of Object.entries(criteria)) {
    if (key === 'allOf' || key === 'anyOf') criteriaNames(value, out);
    else out.add(key);
  }
  return out;
}

// Il circuito che una skill dichiara come proprio criterio di successo, se c'e'.
export function circuitRef (def) {
  const success = def?.success;
  if (success && typeof success === 'object' && success.circuitBuilt && typeof success.circuitBuilt === 'object') {
    return success.circuitBuilt.id || null;
  }
  if (Array.isArray(success)) {
    for (const sub of success) {
      const ref = circuitRef({ success: sub });
      if (ref) return ref;
    }
  }
  return null;
}

function slug (text) {
  const cleaned = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.slice(0, 48) || null;
}

// Lo step derivato: la skill decide `targets`, `circuit` e `verify`; senza skill
// resta lo step dell'objective, con i `targets` del piano e nessun criterio.
export function planStep (plan, skills) {
  const def = plan?.skill ? skills.get(plan.skill) : null;
  const declaredTargets = def?.planTargets && Object.keys(def.planTargets).length ? def.planTargets : plan?.targets;
  return {
    id: plan?.skill || slug(plan?.objective) || 'step',
    skill: plan?.skill || null,
    circuit: def ? circuitRef(def) : null,
    targets: { ...(declaredTargets || {}) },
    // Solo nomi di criterio che il verificatore conosce: una skill non puo'
    // introdurre un criterio nuovo passando da qui.
    verify: def ? [...criteriaNames(def.success)].filter(name => CRITERIA.has(name)).sort() : [],
  };
}

// La forma completa. Un solo step: R1 promuove un livello, non una gerarchia.
// Se un domani il piano arrivera' con piu' subgoal, e' qui che si espandono.
export function derivePlanShape (plan, { skills = new Map(), milestones = {} } = {}) {
  if (!plan || typeof plan !== 'object') return { subgoal: null, steps: [] };
  const def = plan.skill ? skills.get(plan.skill) : null;
  const milestone = plan.milestone && milestones[plan.milestone] ? milestones[plan.milestone] : null;
  const subgoal = def?.description
    || plan.subgoal
    || milestone?.description
    || (plan.milestone ? `Complete the "${plan.milestone}" milestone.` : null)
    || plan.objective
    || null;
  return { subgoal, steps: [planStep(plan, skills)] };
}

// Applica la forma a un piano esistente **senza** sovrascrivere quello che il
// produttore ha gia' messo (additivo: nessun consumatore puo' richiederlo). Un
// piano senza `objective` e' un sentinella (`{met:true}`), non un piano: resta com'e'.
export function withPlanShape (plan, artifacts = {}) {
  if (!plan || typeof plan !== 'object' || typeof plan.objective !== 'string') return plan;
  const shape = derivePlanShape(plan, artifacts);
  return {
    ...plan,
    subgoal: plan.subgoal ?? shape.subgoal,
    steps: Array.isArray(plan.steps) && plan.steps.length ? plan.steps : shape.steps,
  };
}
