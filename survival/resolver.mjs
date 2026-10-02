// Skill Resolver: collega osservazione, governor, plan e grafo di progressione
// alla libreria di skill gameplay.
//
// Regole d'ordine:
//   1. in emergenza vince la skill preferita dal Survival Governor;
//   2. poi la skill richiesta dal plan (Hermes, campo opzionale `skill`);
//   3. poi le preferenze del governor in caution;
//   4. poi il milestone suggerito dalla progressione.
//
// Il resolver filtra/ordina solo le opzioni già offerte dal harness: non
// inventa mai una key. `filterOptionsForGovernor` è l'unico filtro "forte" e
// scatta solo in emergenza; se non resta nulla di utile restituisce le opzioni
// originali.

import { optionIntents } from './intents.mjs';
import { evaluateCriteria } from './verify.mjs';
import { skillById } from './skills.mjs';

// Restituisce la key dell'opzione già offerta che realizza l'intento, o null.
export function findOptionForIntents (options = [], intents = []) {
  for (const option of options) {
    if (optionIntents(option.key).some(intent => intents.includes(intent))) return option;
  }
  return null;
}

// In emergenza restringe le opzioni agli intenti ammessi dal governor.
// Non rimuove mai l'ultima opzione utile: se il filtro svuota il set,
// restituisce le opzioni originali e lo segnala.
export function filterOptionsForGovernor (options = [], governor = null) {
  if (!governor || governor.mode !== 'emergency' || !Array.isArray(governor.allowedIntents)) {
    return { options, filtered: false, removed: [], reason: null };
  }
  const allowed = governor.allowedIntents;
  const nonWait = options.filter(option => option.key !== 'wait');
  const kept = nonWait.filter(option => optionIntents(option.key).some(intent => allowed.includes(intent)));
  if (!kept.length) {
    return { options, filtered: false, removed: [], reason: 'no_allowed_option' };
  }
  const keptKeys = new Set(kept.map(option => option.key));
  return {
    options: kept,
    filtered: true,
    removed: options.filter(option => !keptKeys.has(option.key)).map(option => ({ key: option.key, reason: 'emergency_intent_filter' })),
    reason: null,
  };
}

export function skillApplicable (skill, observation) {
  if (!skill) return false;
  if (!skill.preconditions) return true;
  return evaluateCriteria(skill.preconditions, observation).ok;
}

// Skill attiva per questo ciclo, con la sua provenienza (per log e diagnostica).
export function resolveActiveSkill ({ skills = null, plan = null, governor = null, milestone = null, observation = null } = {}) {
  const candidates = [];
  if (governor?.mode === 'emergency') {
    for (const id of governor.preferredSkills || []) candidates.push({ id, source: 'governor' });
  }
  if (plan?.skill) candidates.push({ id: plan.skill, source: 'plan' });
  for (const id of governor?.preferredSkills || []) candidates.push({ id, source: 'governor' });
  if (milestone?.skill) candidates.push({ id: milestone.skill, source: 'progression' });
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate.id || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    const skill = skillById(skills, candidate.id);
    if (!skill) continue;
    // Se l'osservazione è disponibile, la skill deve essere applicabile ora
    // (precondizioni soddisfatte); altrimenti il candidato successivo prende il posto.
    if (observation && !skillApplicable(skill, observation)) continue;
    return { skill, source: candidate.source };
  }
  return { skill: null, source: null };
}

// Intenti esterni (vocabolario opzioni) coerenti con la skill: usati dal
// controller per il ranking delle opzioni, mai per aggiungerne.
export function skillPreferredIntents (skill) {
  return skill?.intents ? [...skill.intents] : [];
}
