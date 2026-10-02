// Survival Governor: combina perception, rischio e regole dichiarative in una
// decisione strutturata che può interrompere la progressione.
//
// Output normale:
//   { mode, priority, reasons, needs, overrideObjective, allowedIntents,
//     preferredSkills, rule, matchedRules, risk }
//
// - `mode`: normal | caution | emergency
// - `overrideObjective`: obiettivo pronto per il controller (solo se != normal)
// - `allowedIntents`: restringe gli intenti ammessi in emergenza (il resolver
//   filtra solo le opzioni già offerte dal harness, non ne inventa)
//
// Modulo puro: le regole arrivano da knowledge/survival-rules.json.

import { perceive } from './perception.mjs';
import { assessRisk } from './risk.mjs';
import { deriveNeeds } from './needs.mjs';
import { evaluateRules } from './rules.mjs';

export const EMERGENCY_PRIORITY = 95;
export const CAUTION_PRIORITY = 55;

export const DEFAULT_EMERGENCY_OBJECTIVE = 'Escape immediate danger and recover before resuming progression.';
export const DEFAULT_CAUTION_OBJECTIVE = 'Handle the current survival need before resuming progression.';

// Priorità di fallback quando nessuna regola è soddisfatta ma il punteggio di
// rischio è alto (es. molteplici ostili senza una regola dedicata).
const RISK_DEFAULT_PRIORITY = { critical: 100, high: 70, medium: 40, low: 10, none: 0 };

function unique (values) {
  return [...new Set(values.filter(Boolean))];
}

function ruleIntents (rule) {
  if (!rule) return [];
  return [
    ...(rule.intent ? [rule.intent] : []),
    ...(rule.intents || []),
  ];
}

export function evaluateSurvival (observation = {}, { rules = [] } = {}) {
  const perception = perceive(observation);
  const risk = assessRisk(perception);
  const needs = deriveNeeds(perception, risk);
  const matched = evaluateRules(rules, perception);
  const top = matched[0] || null;
  const priority = top?.priority ?? RISK_DEFAULT_PRIORITY[risk.level] ?? 0;

  let mode = 'normal';
  if (perception.dead) mode = 'emergency';
  else if (priority >= EMERGENCY_PRIORITY || risk.level === 'critical') mode = 'emergency';
  else if (priority >= CAUTION_PRIORITY || risk.level === 'high') mode = 'caution';

  // In emergenza valgono gli intenti delle regole survival con priorità da
  // emergenza; in caution resta tutto disponibile (il governor guida l'obiettivo).
  let allowedIntents = null;
  if (mode === 'emergency') {
    const eligible = matched.filter(rule => rule.priority >= EMERGENCY_PRIORITY);
    allowedIntents = unique(eligible.flatMap(ruleIntents));
    if (!allowedIntents.length) allowedIntents = ['escape', 'eat', 'heal', 'shelter', 'sleep'];
    if (perception.dead) allowedIntents = ['wait'];
  }

  const preferredSkills = unique(matched.flatMap(rule => rule.preferredSkills || []));

  let overrideObjective = null;
  if (mode !== 'normal' && !perception.dead) {
    overrideObjective = top?.objective
      || (mode === 'emergency' ? DEFAULT_EMERGENCY_OBJECTIVE : DEFAULT_CAUTION_OBJECTIVE);
  }

  return {
    mode,
    priority,
    reasons: risk.reasons,
    needs,
    overrideObjective,
    allowedIntents,
    preferredSkills,
    rule: top?.id ?? null,
    matchedRules: matched.map(rule => rule.id),
    risk,
  };
}

// Versione compatta per /observe: deve restare leggibile da un modello.
export function summarizeSurvival (result) {
  return {
    mode: result.mode,
    risk: result.risk.score,
    level: result.risk.level,
    rule: result.rule,
    needs: result.needs,
    reasons: result.reasons,
    overrideObjective: result.overrideObjective,
  };
}
