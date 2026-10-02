// Verifica deterministica delle skill: i criteri di successo/fallimento sono
// dichiarati nei file JSON della libreria gameplay e valutati osservando lo
// stato del harness, mai chiedendo a un modello se pensa che il task sia
// riuscito.
//
// Vocabolario dei criteri (documentato in docs/SURVIVAL-INTELLIGENCE.md):
//   inventoryGte {item: n}          item esatti in inventario
//   inventoryTagGte {tag: n}        conteggio aggregato per tag (survival/item-tags.mjs)
//   healthAtLeast / foodAtLeast n
//   phaseIn [fasi]                  day | dusk | night | dawn
//   dimension str                   overworld | nether | the_end
//   foodIncreased / healthIncreased prima vs dopo
//   noHostileWithin n               nessun ostile entro n blocchi
//   threatDistanceIncreasedBy n     fuga riuscita di almeno n blocchi
//   nightSurvived                   una notte è passata (before/context.sawNight)
//   allOf [criteri] | anyOf [criteri]
//
// Modulo puro (l'unico I/O è nel loader delle skill).

import { tagCount, tagItems, isKnownTag } from './item-tags.mjs';

function observationOf (observation = {}) {
  return observation || {};
}

function phaseOf (observation) {
  return observationOf(observation).time?.phase ?? null;
}

function nearestThreatDistance (observation) {
  const threats = observationOf(observation).entities || [];
  let min = Infinity;
  for (const entity of threats) {
    if (entity.hostile === false) continue;
    if (Number.isFinite(entity.distance) && entity.distance < min) min = entity.distance;
  }
  return min;
}

export function evaluateCriteria (criteria, observation, { before = null, context = {} } = {}) {
  const after = observationOf(observation);
  const evidence = {};
  const fail = (reason) => ({ ok: false, evidence, reason });

  if (criteria == null) return { ok: true, evidence };

  if (Array.isArray(criteria)) {
    criteria = { allOf: criteria };
  }
  if ('allOf' in criteria) {
    for (const sub of criteria.allOf) {
      const result = evaluateCriteria(sub, after, { before, context });
      Object.assign(evidence, result.evidence);
      if (!result.ok) return fail(result.reason);
    }
    return { ok: true, evidence };
  }
  if ('anyOf' in criteria) {
    const failures = [];
    for (const sub of criteria.anyOf) {
      const result = evaluateCriteria(sub, after, { before, context });
      if (result.ok) return { ok: true, evidence: { ...evidence, ...result.evidence } };
      failures.push(result.reason || 'criterion_failed');
    }
    return fail(failures.join(' or '));
  }
  if ('inventoryGte' in criteria) {
    for (const [item, count] of Object.entries(criteria.inventoryGte)) {
      const held = after.inventory?.[item] || 0;
      evidence[`inventory.${item}`] = held;
      if (held < count) return fail(`inventory.${item}=${held} < ${count}`);
    }
    return { ok: true, evidence };
  }
  if ('inventoryTagGte' in criteria) {
    for (const [tag, count] of Object.entries(criteria.inventoryTagGte)) {
      if (!isKnownTag(tag)) return fail(`unknown item tag: ${tag}`);
      const held = tagCount(after.inventory || {}, tag);
      evidence[`inventory.${tag}`] = held;
      if (held < count) return fail(`inventory.${tag}=${held} < ${count}`);
    }
    return { ok: true, evidence };
  }
  if ('healthAtLeast' in criteria) {
    evidence.health = after.health ?? null;
    return after.health != null && after.health >= criteria.healthAtLeast
      ? { ok: true, evidence }
      : fail(`health=${evidence.health}`);
  }
  if ('foodAtLeast' in criteria) {
    evidence.food = after.food ?? null;
    return after.food != null && after.food >= criteria.foodAtLeast
      ? { ok: true, evidence }
      : fail(`food=${evidence.food}`);
  }
  if ('phaseIn' in criteria) {
    const phase = phaseOf(after);
    evidence.phase = phase;
    return criteria.phaseIn.includes(phase) ? { ok: true, evidence } : fail(`phase=${phase}`);
  }
  if ('dimension' in criteria) {
    evidence.dimension = after.dimension ?? null;
    return after.dimension === criteria.dimension ? { ok: true, evidence } : fail(`dimension=${evidence.dimension}`);
  }
  if ('nearbyBlock' in criteria) {
    const wanted = typeof criteria.nearbyBlock === 'string'
      ? { name: criteria.nearbyBlock, within: null }
      : { name: criteria.nearbyBlock.name, within: criteria.nearbyBlock.within ?? null };
    const found = after.nearby?.[wanted.name] || [];
    evidence[`nearby.${wanted.name}`] = found.length;
    const within = wanted.within == null || found.some(block => (block.distance ?? 0) <= wanted.within);
    return found.length > 0 && within ? { ok: true, evidence } : fail(`nearby ${wanted.name}=${found.length}`);
  }
  if ('foodIncreased' in criteria) {
    const beforeFood = before?.food ?? null;
    const afterFood = after.food ?? null;
    evidence.foodBefore = beforeFood;
    evidence.foodAfter = afterFood;
    return beforeFood != null && afterFood != null && afterFood > beforeFood
      ? { ok: true, evidence }
      : fail(`food ${beforeFood} -> ${afterFood}`);
  }
  if ('healthIncreased' in criteria) {
    const beforeHealth = before?.health ?? null;
    const afterHealth = after.health ?? null;
    evidence.healthBefore = beforeHealth;
    evidence.healthAfter = afterHealth;
    return beforeHealth != null && afterHealth != null && afterHealth > beforeHealth
      ? { ok: true, evidence }
      : fail(`health ${beforeHealth} -> ${afterHealth}`);
  }
  if ('noHostileWithin' in criteria) {
    const distance = nearestThreatDistance(after);
    evidence.nearestHostile = Number.isFinite(distance) ? distance : null;
    return !(distance <= criteria.noHostileWithin) ? { ok: true, evidence } : fail(`hostile at ${distance}`);
  }
  if ('threatDistanceIncreasedBy' in criteria) {
    const beforeDistance = nearestThreatDistance(before);
    const afterDistance = nearestThreatDistance(after);
    evidence.threatDistanceBefore = Number.isFinite(beforeDistance) ? beforeDistance : null;
    evidence.threatDistanceAfter = Number.isFinite(afterDistance) ? afterDistance : null;
    if (!Number.isFinite(beforeDistance)) return { ok: true, evidence };
    if (!Number.isFinite(afterDistance)) return { ok: true, evidence };
    return afterDistance - beforeDistance >= criteria.threatDistanceIncreasedBy
      ? { ok: true, evidence }
      : fail(`threat distance ${beforeDistance} -> ${afterDistance}`);
  }
  if ('nightSurvived' in criteria) {
    const beforePhase = phaseOf(before);
    const afterPhase = phaseOf(after);
    const sawNight = context.sawNight === true || beforePhase === 'night' || beforePhase === 'dusk';
    const dayAgain = afterPhase === 'day' || afterPhase === 'dawn';
    evidence.sawNight = sawNight;
    evidence.phase = afterPhase;
    return sawNight && dayAgain ? { ok: true, evidence } : fail(`night survival not confirmed (sawNight=${sawNight}, phase=${afterPhase})`);
  }
  return fail(`unknown success criterion: ${Object.keys(criteria).join(', ')}`);
}

// Confronta osservazione iniziale e corrente e produce lo stato della skill.
export function verifySkill (skill, before, after, { context = {} } = {}) {
  const id = typeof skill === 'string' ? skill : skill?.id;
  const evidence = {};
  if (!after) return { status: 'running', skill: id, evidence, reason: 'no_observation' };
  if (after.dead === true && !skill?.allowDeath) {
    return { status: 'failed', skill: id, evidence: { dead: true }, reason: 'died' };
  }
  if (skill?.failure) {
    const failure = evaluateCriteria(skill.failure, after, { before, context });
    Object.assign(evidence, failure.evidence);
    if (failure.ok) return { status: 'failed', skill: id, evidence, reason: failure.reason || 'failure_criteria' };
  }
  if (skill?.success) {
    const success = evaluateCriteria(skill.success, after, { before, context });
    Object.assign(evidence, success.evidence);
    if (success.ok) return { status: 'success', skill: id, evidence, reason: null };
    return { status: 'running', skill: id, evidence, reason: success.reason };
  }
  // Una skill senza criteri non può essere verificata: non dichiarare successo.
  return { status: 'running', skill: id, evidence, reason: 'no_success_criteria' };
}

// Solo per diagnostica/evidence: item presenti per tag.
export function tagEvidence (inventory, tag) {
  return tagItems(inventory, tag);
}

export const CRITERIA_KEYS = [
  'inventoryGte', 'inventoryTagGte', 'healthAtLeast', 'foodAtLeast', 'phaseIn',
  'dimension', 'nearbyBlock', 'foodIncreased', 'healthIncreased', 'noHostileWithin',
  'threatDistanceIncreasedBy', 'nightSurvived', 'allOf', 'anyOf',
];

// Validazione ricorsiva usata dal loader delle skill e del grafo: un refuso in
// un file JSON deve fallire subito, non valutare `false` per sempre.
export function validateCriteria (criteria, where = 'criteria') {
  const errors = [];
  if (criteria == null) return errors;
  if (Array.isArray(criteria)) {
    criteria.forEach((sub, index) => errors.push(...validateCriteria(sub, `${where}[${index}]`)));
    return errors;
  }
  if (typeof criteria !== 'object') return [`${where}: criteria must be an object`];
  for (const [key, value] of Object.entries(criteria)) {
    if (!CRITERIA_KEYS.includes(key)) { errors.push(`${where}: unknown criterion "${key}"`); continue; }
    if ((key === 'allOf' || key === 'anyOf') && !Array.isArray(value)) { errors.push(`${where}.${key}: must be an array`); continue; }
    if (key === 'allOf' || key === 'anyOf') {
      value.forEach((sub, index) => errors.push(...validateCriteria(sub, `${where}.${key}[${index}]`)));
    }
    if (key === 'inventoryGte' && (!value || typeof value !== 'object')) errors.push(`${where}.${key}: must be an object {item: count}`);
    if (key === 'inventoryTagGte') {
      if (!value || typeof value !== 'object') errors.push(`${where}.${key}: must be an object {tag: count}`);
      else for (const [tag, count] of Object.entries(value)) {
        if (!isKnownTag(tag)) errors.push(`${where}.${key}.${tag}: unknown item tag`);
        if (typeof count !== 'number' || count < 0) errors.push(`${where}.${key}.${tag}: count must be a number`);
      }
    }
    if (key === 'phaseIn' && !Array.isArray(value)) errors.push(`${where}.${key}: must be an array of phases`);
    if (key === 'nearbyBlock' && typeof value !== 'string' && (typeof value !== 'object' || !value?.name)) errors.push(`${where}.${key}: must be a block name or {name, within}`);
  }
  return errors;
}
