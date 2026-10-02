// Goal Contract: un obiettivo strutturato attorno al `plan`, non solo una
// stringa. Il contratto dichiara target/vincoli/completamento/fallimento e il
// controller ne deriva uno stato deterministico:
//
//   RUNNING | SUCCESS | FAILED | BLOCKED
//
// Modulo puro: nessun I/O. I criteri riusano il vocabolario di verify.mjs
// (success/failure) e i vincoli di alto livello (maxDeaths, preserveItems)
// vengono tradotti in controlli deterministici sull'osservazione del harness.
//
// Vedi docs/wiki/goal-achievement.md (proposal) e
// docs/raw/GOAL_ACHIEVEMENT_MINECRAFT.txt.

import { evaluateCriteria, validateCriteria } from './verify.mjs';

export const CONTRACT_STATUSES = ['running', 'success', 'failed', 'blocked'];

function normalizeItems (value) {
  if (value == null) return null;
  if (!Array.isArray(value)) return value;
  return value.filter(item => typeof item === 'string' && item.length > 0);
}

// Normalizza e valida un contratto grezzo. Non lancia mai: gli errori finiscono
// in `errors` e lo stato risultante sarà `blocked`.
export function normalizeContract (raw = {}) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { goal: null, target: null, success: null, failure: null, constraints: {}, errors: ['contract must be an object'] };
  }
  const errors = [];
  errors.push(...validateCriteria(raw.success, 'contract.success'));
  errors.push(...validateCriteria(raw.failure, 'contract.failure'));
  if (raw.goal != null && typeof raw.goal !== 'string') errors.push('goal must be a string');
  if (raw.target != null && (typeof raw.target !== 'object' || Array.isArray(raw.target))) errors.push('target must be an object');

  const input = raw.constraints && typeof raw.constraints === 'object' && !Array.isArray(raw.constraints) ? raw.constraints : {};
  const constraints = {};
  if (input.maxDeaths != null) {
    if (typeof input.maxDeaths !== 'number' || !Number.isFinite(input.maxDeaths) || input.maxDeaths < 0) {
      errors.push('constraints.maxDeaths must be a non-negative number');
    } else {
      constraints.maxDeaths = input.maxDeaths;
    }
  }
  if (input.preserveItems != null) {
    const items = normalizeItems(input.preserveItems);
    if (!Array.isArray(items) || !items.length) errors.push('constraints.preserveItems must be a non-empty array of item names');
    else constraints.preserveItems = items;
  }
  if (input.gameMode != null) {
    if (typeof input.gameMode !== 'string') errors.push('constraints.gameMode must be a string');
    else constraints.gameMode = input.gameMode;
  }
  if (input.cheats != null) {
    if (typeof input.cheats !== 'boolean') errors.push('constraints.cheats must be a boolean');
    else constraints.cheats = input.cheats;
  }
  return { goal: raw.goal ?? null, target: raw.target ?? null, success: raw.success ?? null, failure: raw.failure ?? null, constraints, errors };
}

// Valuta il contratto sull'osservazione corrente. Precedenza:
//   1. errore/limite statico            -> blocked
//   2. success                          -> success
//   3. failure o vincolo violato        -> failed
//   4. altrimenti                       -> running
export function evaluateContract (contract, observation, { before = null, context = {} } = {}) {
  if (!contract || typeof contract !== 'object') {
    return { status: 'blocked', reasons: ['contract must be an object'], evidence: {} };
  }
  if ((contract.errors || []).length) {
    return { status: 'blocked', reasons: [...contract.errors], evidence: {} };
  }
  const constraints = contract.constraints || {};
  // Limiti statici che l'ambiente corrente non può soddisfare.
  if (constraints.cheats === true) {
    return { status: 'blocked', reasons: ['cheats required but the server runs with allow-cheats=false'], evidence: {} };
  }
  if (constraints.gameMode && observation?.gameMode != null && observation.gameMode !== constraints.gameMode) {
    return { status: 'blocked', reasons: [`gameMode=${observation.gameMode} != ${constraints.gameMode}`], evidence: {} };
  }
  const hasCompletion = contract.success != null || contract.failure != null ||
    constraints.maxDeaths != null || (constraints.preserveItems?.length ?? 0) > 0;
  if (!hasCompletion) {
    return { status: 'blocked', reasons: ['contract has no success, failure or constraint to evaluate'], evidence: {} };
  }

  const evidence = {};
  if (contract.success != null) {
    const result = evaluateCriteria(contract.success, observation, { before, context });
    Object.assign(evidence, result.evidence);
    if (result.ok) return { status: 'success', reasons: [], evidence };
  }
  if (contract.failure != null) {
    const result = evaluateCriteria(contract.failure, observation, { before, context });
    Object.assign(evidence, result.evidence);
    if (result.ok) return { status: 'failed', reasons: [result.reason || 'failure criteria met'], evidence };
  }
  const reasons = [];
  if (constraints.maxDeaths != null && Number.isFinite(observation?.deaths) && observation.deaths > constraints.maxDeaths) {
    evidence.deaths = observation.deaths;
    reasons.push(`deaths=${observation.deaths} > maxDeaths=${constraints.maxDeaths}`);
  }
  if (constraints.preserveItems?.length) {
    const result = evaluateCriteria({ itemPreserved: constraints.preserveItems }, observation, { before, context });
    Object.assign(evidence, result.evidence);
    if (!result.ok) reasons.push(result.reason || 'preserved item lost');
  }
  if (reasons.length) return { status: 'failed', reasons, evidence };
  return { status: 'running', reasons: [], evidence };
}

// Costruisce il contratto dall'ambiente del controller:
//   GOAL_CONTRACT   JSON {goal,target,constraints,success,failure}
//   MAX_DEATHS      scorciatoia per constraints.maxDeaths
//   PRESERVE_ITEMS  lista separata da virgole (item esatti)
// Ritorna sempre un contratto normalizzato (eventuali errori in `errors`).
export function contractFromEnv (env = process.env) {
  const constraints = {};
  if (env.MAX_DEATHS != null && env.MAX_DEATHS !== '') constraints.maxDeaths = Number(env.MAX_DEATHS);
  if (env.PRESERVE_ITEMS) constraints.preserveItems = env.PRESERVE_ITEMS.split(',').map(item => item.trim()).filter(Boolean);
  let raw = {};
  if (env.GOAL_CONTRACT) {
    try {
      raw = JSON.parse(env.GOAL_CONTRACT);
    } catch (error) {
      return { goal: null, target: null, success: null, failure: null, constraints, errors: [`GOAL_CONTRACT is not valid JSON: ${error.message}`] };
    }
  }
  return normalizeContract({ ...raw, constraints: { ...(raw.constraints || {}), ...constraints } });
}

// True se l'ambiente configura almeno un vincolo/condizione: permette al
// controller di restare retrocompatibile quando non c'è nessun contratto.
export function hasContractConfig (env = process.env) {
  return Boolean(env.GOAL_CONTRACT || (env.MAX_DEATHS != null && env.MAX_DEATHS !== '') || env.PRESERVE_ITEMS);
}
