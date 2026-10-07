#!/usr/bin/env node
// Inventario delle capability reali (R0 di docs/raw/ROADMAP_refactoring_reasoning.md).
//
// Legge come un'unica cosa la superficie dichiarativa che il progetto gia' ha —
// vocabolario degli intenti, mappa key->intento di /options, skill gameplay,
// blueprint dei circuiti, milestone/goal e vocabolario dei criteri — e la
// **controlla**: un riferimento che non risolve e' un errore, non un `false`
// silenzioso.
//
// Questo e' il "registry" delle bozze di roadmap (roadmap_reasoning_avanzato.md,
// clarification_missing_information_phase.md) senza la finzione MCP: nessun
// transport, nessun server, nessuna seconda fonte di verita'. `/options` resta
// autoritativo a runtime; l'inventario dice cosa il codice dichiara e se i
// collegamenti fra i file reggono.
//
// Uso:
//   node tools/capability-inventory.mjs            # JSON su stdout, exit 0
//   node tools/capability-inventory.mjs --summary   # riassunto leggibile
//   node tools/capability-inventory.mjs --check     # exit 1 se ci sono errori

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { declaredOptionVocabulary, INTENTS } from '../survival/intents.mjs';
import { loadGameplaySkills } from '../survival/skills.mjs';
import { CRITERIA_KEYS, validateCriteria } from '../survival/verify.mjs';
import { loadCircuits } from '../circuits.mjs';
import { circuitRef, criteriaNames } from '../plan-shape.mjs';

const DEFAULT_PROGRESSION = new URL('../knowledge/progression.json', import.meta.url);

export function buildInventory ({ skillsRoot, circuitsRoot, progressionPath } = {}) {
  const issues = [];
  const error = (kind, detail) => issues.push({ level: 'error', kind, detail });
  const warning = (kind, detail) => issues.push({ level: 'warning', kind, detail });

  const skillsMap = loadGameplaySkills(skillsRoot);
  const circuitsMap = loadCircuits(circuitsRoot);
  let progression;
  try {
    progression = JSON.parse(readFileSync(progressionPath || DEFAULT_PROGRESSION, 'utf8'));
  } catch (cause) {
    throw new Error(`invalid progression graph: ${cause.message}`);
  }

  const skills = [...skillsMap.values()]
    .map(def => ({
      id: def.id,
      category: def.category || null,
      intents: [...(def.intents || [])],
      planTargets: { ...(def.planTargets || {}) },
      blocked: def.blocked || null,
      circuit: circuitRef(def),
      criteria: [...criteriaNames(def.success)].sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const circuits = [...circuitsMap.values()]
    .map(def => ({
      id: def.id,
      buildable: def.buildable !== false,
      steps: Array.isArray(def.steps) ? def.steps.length : 0,
      requires: Object.keys(def.requires || {}).sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const milestones = Object.entries(progression.milestones || {})
    .map(([id, def]) => ({
      id,
      skill: def.skill || null,
      requires: [...(def.requires || [])],
      satisfiedWhen: def.satisfiedWhen ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const goals = { ...(progression.goals || {}) };

  // ------------------------------------------------------------------ controlli
  const skillIds = new Set(skills.map(s => s.id));
  const milestoneIds = new Set(milestones.map(m => m.id));
  const circuitIds = new Set(circuits.map(c => c.id));

  for (const milestone of milestones) {
    if (milestone.skill && !skillIds.has(milestone.skill)) {
      error('milestone_skill_missing', `milestone "${milestone.id}" names skill "${milestone.skill}", which does not exist`);
    }
    for (const req of milestone.requires) {
      if (!milestoneIds.has(req)) {
        error('milestone_requires_missing', `milestone "${milestone.id}" requires "${req}", which is not a milestone`);
      }
    }
    for (const problem of validateCriteria(milestone.satisfiedWhen, `milestone ${milestone.id}.satisfiedWhen`)) {
      error('milestone_criteria_invalid', problem);
    }
  }

  for (const [goal, target] of Object.entries(goals)) {
    if (!milestoneIds.has(target)) {
      error('goal_target_missing', `goal "${goal}" points at milestone "${target}", which does not exist`);
    }
  }

  for (const skill of skills) {
    if (skill.circuit && !circuitIds.has(skill.circuit)) {
      error('skill_circuit_missing', `skill "${skill.id}" builds circuit "${skill.circuit}", which does not exist`);
    }
    for (const intent of skill.intents) {
      // Difesa in profondita': `loadGameplaySkills` gia' rifiuta un intento
      // fuori vocabolario (quindi qui non si arriva dal loader dei file), ma
      // l'inventario non deve dipendere dalla validazione di un altro modulo.
      if (!INTENTS.includes(intent)) error('skill_intent_unknown', `skill "${skill.id}" names intent "${intent}", which is outside the vocabulary`);
    }
  }

  const claimedCircuits = new Set(skills.map(s => s.circuit).filter(Boolean));
  for (const circuit of circuits) {
    if (circuit.buildable && !claimedCircuits.has(circuit.id)) {
      warning('orphan_circuit', `circuit "${circuit.id}" is buildable but no skill declares it as a success criterion`);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    intents: [...INTENTS],
    optionVocabulary: declaredOptionVocabulary(),
    skills,
    circuits,
    milestones,
    goals,
    criteria: [...CRITERIA_KEYS],
    issues,
  };
}

function main () {
  const args = process.argv.slice(2);
  const inventory = buildInventory();
  const errors = inventory.issues.filter(issue => issue.level === 'error');
  const warnings = inventory.issues.filter(issue => issue.level === 'warning');

  if (args.includes('--summary')) {
    console.log(`capability inventory — ${inventory.generatedAt}`);
    console.log(`  intents         ${inventory.intents.length}`);
    console.log(`  option keys     ${inventory.optionVocabulary.keys.length} + ${inventory.optionVocabulary.patterns.length} patterns`);
    console.log(`  skills          ${inventory.skills.length}`);
    console.log(`  circuits        ${inventory.circuits.length}`);
    console.log(`  milestones      ${inventory.milestones.length}`);
    console.log(`  goals           ${Object.keys(inventory.goals).length}`);
    console.log(`  criteria        ${inventory.criteria.length}`);
    console.log(`  errors          ${errors.length}`);
    console.log(`  warnings        ${warnings.length}`);
    for (const issue of [...errors, ...warnings]) console.log(`    [${issue.level}] ${issue.kind}: ${issue.detail}`);
  } else {
    process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
  }

  if (args.includes('--check') && errors.length) process.exit(1);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly || (process.argv[1] && process.argv[1].endsWith('capability-inventory.mjs'))) main();

export { circuitRef, criteriaNames, main };
