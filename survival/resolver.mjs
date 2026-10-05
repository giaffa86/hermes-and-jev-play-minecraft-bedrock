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
import { NEED_INTENTS } from './needs.mjs';
import { evaluateCriteria } from './verify.mjs';
import { skillById } from './skills.mjs';

// Restituisce la key dell'opzione già offerta che realizza l'intento, o null.
export function findOptionForIntents (options = [], intents = []) {
  for (const option of options) {
    if (optionIntents(option.key).some(intent => intents.includes(intent))) return option;
  }
  return null;
}

// Ordine di urgenza fra intenti ammessi *contemporaneamente* dal governor: prima
// il respiro, poi uscire dal pericolo, poi curarsi, poi mangiare, poi il riposo.
// Non e' l'ordine delle regole (che e' per priorita' del pericolo): e' l'ordine
// in cui la reazione ha senso — si risale a prendere aria prima di bendarsi.
export const INTENT_URGENCY = ['surface', 'swim', 'ascend', 'escape', 'fight', 'heal', 'eat', 'sleep', 'shelter', 'build', 'smelt', 'craft'];

// A parita' di intento conta la key: scappare dal mob (`flee`) prima di tornare
// a casa (`go_home`, che ha comunque intento `escape` — era il "torna indietro
// spaesato" visto live), mangiare prima di equipaggiare l'armatura quando si e'
// feriti, la riva prima della cascata.
export const PREFERRED_KEYS = {
  escape: ['flee', 'move_to_safe', 'avoid_lava', 'dodge_projectile', 'retreat', 'go_home'],
  heal: ['eat', 'sleep', 'equip_armor', 'equip_pumpkin'],
  eat: ['eat'],
  sleep: ['sleep'],
  surface: ['surface', 'swim_to', 'climb_waterfall'],
  shelter: ['barricade', 'close_door', 'place_torch', 'place_bed', 'go_home', 'retreat'],
  collect: ['harvest_carrots', 'harvest_potatoes', 'collect_drop', 'harvest_honeycomb'],
  smelt: ['smelt_potato', 'smelt_beef', 'smelt_porkchop', 'smelt_chicken'],
  craft: ['craft_bread', 'craft_boat'],
  build: ['pillar_up', 'place_torch'],
};

function pickKeyForIntents (options, intents, preferredKeys) {
  const matching = options.filter(option => option.key !== 'wait' && optionIntents(option.key).some(intent => intents.includes(intent)));
  if (!matching.length) return null;
  for (const intent of intents) {
    for (const key of preferredKeys[intent] || []) {
      const hit = matching.find(option => option.key === key);
      if (hit) return hit;
    }
  }
  return matching[0];
}

// La scala di sopravvivenza: da (governor, opzioni offerte) alla singola key da
// eseguire, senza passare dal modello. L'ordine e' quello dei bisogni del
// governor (gia' per priorita': respiro, fuga, cura, fame, riposo), tradotto in
// intenti; in emergenza gli intenti ammessi dalla regola vengono solo spostati
// davanti, perche' il filtro vero (`filterOptionsForGovernor`) e' gia' passato
// sulle opzioni: l'emergenza decide *cosa e' ammesso*, non riordina la cura
// dopo la fuga. `wait` non viene mai scelta: se non c'e' un'azione di
// sopravvivenza la decisione torna al modello, che e' l'unico a sapere cosa sta
// facendo il piano.
export function chooseNeedAction ({ governor = null, options = [], needIntents = NEED_INTENTS, urgency = INTENT_URGENCY, preferredKeys = PREFERRED_KEYS } = {}) {
  if (!governor || !Array.isArray(options) || !options.length) return null;
  const emergency = governor.mode === 'emergency' && Array.isArray(governor.allowedIntents) && governor.allowedIntents.length > 0;
  let intents = [];
  let need = null;
  if (emergency) {
    const allowed = governor.allowedIntents.filter(intent => intent !== 'wait');
    // L'ordine della regola di emergenza e' gia' la sua policy: la regola a
    // priorita' piu' alta viene prima (un creeper addosso = scappare prima di
    // mangiare, `low_health_near_hostile`; cuori a zero senza minaccia = curarsi
    // prima di tutto, `critical_health`). I bisogni aggiungono in coda gli
    // intenti che la regola non nomina (fame, riposo, raccolto): servono quando
    // il pericolo tace o quando i bisogni non hanno un'azione diretta.
    const ordered = [];
    for (const intent of allowed) ordered.push(intent);
    for (const item of governor.needs || []) {
      const mapped = (needIntents[item] || []).filter(intent => intent !== 'wait');
      if (!mapped.length) continue;
      for (const intent of mapped) if (!ordered.includes(intent)) ordered.push(intent);
    }
    const permitted = new Set(allowed);
    intents = [...ordered.filter(intent => permitted.has(intent)), ...ordered.filter(intent => !permitted.has(intent))];
  } else {
    for (const item of governor.needs || []) {
      const mapped = needIntents[item] || [];
      if (!mapped.length) continue;
      if (!need) need = item;
      for (const intent of mapped) if (!intents.includes(intent)) intents.push(intent);
    }
  }
  if (!intents.length) return null;
  const choice = pickKeyForIntents(options, intents, preferredKeys);
  if (!choice) return null;
  const intent = intents.find(candidate => optionIntents(choice.key).includes(candidate)) || intents[0];
  if (!need) need = (governor.needs || []).find(item => (needIntents[item] || []).includes(intent)) || null;
  return { key: choice.key, intent, need, source: emergency ? 'emergency_ladder' : 'need_ladder' };
}

// In emergenza restringe le opzioni agli intenti ammessi dal governor.
// Non rimuove mai l'ultima opzione utile: se il filtro svuota il set,
// restituisce le opzioni originali e lo segnala.
//
// `protectedKeys` elenca le key che sopravvivono comunque al filtro: serve
// all'ordine umano aperto ("seguimi"). In emergenza il bot tende a curarsi,
// ma un ordine esplicito resta un impegno e avvicinarsi alla persona che
// l'ha chiamato e' la scelta che l'umano si aspetta; il bisogno piu' urgente
// passa comunque prima (catena del controller: `need > follow > modello`).
export function filterOptionsForGovernor (options = [], governor = null, { protectedKeys = [] } = {}) {
  if (!governor || governor.mode !== 'emergency' || !Array.isArray(governor.allowedIntents)) {
    return { options, filtered: false, removed: [], reason: null };
  }
  const allowed = governor.allowedIntents;
  const protect = new Set(protectedKeys);
  const nonWait = options.filter(option => option.key !== 'wait');
  const kept = nonWait.filter(option => protect.has(option.key) || optionIntents(option.key).some(intent => allowed.includes(intent)));
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
