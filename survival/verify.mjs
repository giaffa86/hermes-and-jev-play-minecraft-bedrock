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
//   deathsAtLeast n                 il contatore morti ha raggiunto n
//   itemPreserved [item]            nessun item della lista è diminuito vs `before`
//   inWater bool / notInLava bool   stato fluido corrente (osservazione `fluids`)
//   airAtLeast n                    aria residua (quando il budget d'aria è noto)
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
  if ('deathsAtLeast' in criteria) {
    const deaths = after.deaths ?? null;
    evidence.deaths = deaths;
    return deaths != null && deaths >= criteria.deathsAtLeast ? { ok: true, evidence } : fail(`deaths=${deaths}`);
  }
  if ('itemPreserved' in criteria) {
    const items = Array.isArray(criteria.itemPreserved) ? criteria.itemPreserved : [];
    const beforeInventory = before?.inventory && typeof before.inventory === 'object' ? before.inventory : null;
    const afterInventory = after.inventory && typeof after.inventory === 'object' ? after.inventory : {};
    for (const item of items) {
      const beforeCount = beforeInventory ? (beforeInventory[item] || 0) : null;
      const afterCount = afterInventory[item] || 0;
      evidence[`inventory.before.${item}`] = beforeCount;
      evidence[`inventory.after.${item}`] = afterCount;
      // Without a baseline a loss cannot be detected; only compare when held before.
      if (beforeCount != null && beforeCount > 0 && afterCount < beforeCount) {
        return fail(`preserved item lost: ${item} ${beforeCount} -> ${afterCount}`);
      }
    }
    return { ok: true, evidence };
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
  if ('inWater' in criteria) {
    const inWater = after.fluids?.inWater === true;
    evidence.inWater = inWater;
    return inWater === criteria.inWater
      ? { ok: true, evidence }
      : fail(`inWater ${inWater}, expected ${criteria.inWater}`);
  }
  if ('notInLava' in criteria) {
    const inLava = after.fluids?.inLava === true;
    evidence.inLava = inLava;
    // Il criterio è una sicurezza: senza il dato fluido non si dichiara successo.
    if (after.fluids == null) return fail('lava state unknown');
    const safe = !inLava;
    return safe === criteria.notInLava
      ? { ok: true, evidence }
      : fail(`inLava ${inLava}, expected not ${criteria.notInLava}`);
  }
  if ('airAtLeast' in criteria) {
    const air = Number.isFinite(after.fluids?.air) ? after.fluids.air : null;
    evidence.air = air;
    if (air == null) return fail('air budget unknown');
    return air >= criteria.airAtLeast
      ? { ok: true, evidence }
      : fail(`air ${air} < ${criteria.airAtLeast}`);
  }
  if ('blockPoweredAt' in criteria) {
    const want = criteria.blockPoweredAt;
    const atLeast = Number.isFinite(want?.atLeast) ? want.atLeast : 1;
    const rows = [
      ...(after.redstone?.components ?? []),
      ...(after.redstone?.ore ?? []),
      ...(after.redstone?.hazards ?? []),
    ];
    const row = rows.find(r => r.position && r.position.x === want.x && r.position.y === want.y && r.position.z === want.z);
    if (!row) return fail(`no redstone component at ${want.x},${want.y},${want.z}`);
    evidence.redstoneAt = { name: row.name, power: row.power ?? null };
    // Come per la lava: uno stato illeggibile non è un successo.
    if (row.power == null) return fail(`power unknown at ${want.x},${want.y},${want.z}`);
    return row.power >= atLeast
      ? { ok: true, evidence }
      : fail(`power ${row.power} < ${atLeast} at ${want.x},${want.y},${want.z}`);
  }
  if ('circuitActive' in criteria) {
    const want = criteria.circuitActive;
    const atLeast = Number.isFinite(want?.atLeast) ? want.atLeast : 1;
    const redstone = after.redstone;
    if (redstone == null) return fail('redstone state unknown');
    const signals = (redstone.power ?? []).map(r => r.signal).filter(v => v != null);
    const maxPower = signals.length ? Math.max(...signals) : null;
    const outputs = redstone.activeOutputs ?? [];
    evidence.redstoneMaxPower = maxPower;
    evidence.redstoneActiveOutputs = outputs.map(o => o.name);
    if (want === false) {
      return (maxPower ?? 0) < atLeast && outputs.length === 0
        ? { ok: true, evidence }
        : fail(`circuit still active (power=${maxPower}, outputs=${outputs.length})`);
    }
    if (outputs.length > 0) return { ok: true, evidence };
    if (maxPower == null) return fail('no readable redstone signal');
    return maxPower >= atLeast ? { ok: true, evidence } : fail(`max power ${maxPower} < ${atLeast}`);
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
  'threatDistanceIncreasedBy', 'nightSurvived', 'deathsAtLeast', 'itemPreserved',
  'inWater', 'notInLava', 'airAtLeast',
  'blockPoweredAt', 'circuitActive',
  'allOf', 'anyOf',
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
    if (key === 'deathsAtLeast' && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) errors.push(`${where}.${key}: must be a non-negative number`);
    if ((key === 'inWater' || key === 'notInLava') && typeof value !== 'boolean') errors.push(`${where}.${key}: must be a boolean`);
    if (key === 'airAtLeast' && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) errors.push(`${where}.${key}: must be a non-negative number`);
    if (key === 'itemPreserved' && (!Array.isArray(value) || !value.length || value.some(item => typeof item !== 'string' || !item))) errors.push(`${where}.${key}: must be a non-empty array of item names`);
    if (key === 'nearbyBlock' && typeof value !== 'string' && (typeof value !== 'object' || !value?.name)) errors.push(`${where}.${key}: must be a block name or {name, within}`);
  }
  return errors;
}
