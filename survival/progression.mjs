// Progression Engine: grafo dichiarativo dei milestone (knowledge/progression.json)
// e risoluzione dei prerequisiti mancanti.
//
// Dato un obiettivo finale (es. "enter_nether") e lo stato corrente, il motore
// risponde con il primo milestone utile non ancora soddisfatto, risalendo le
// dipendenze. Le decisioni di strategia ambigue restano a Hermes; qui vive solo
// la conoscenza meccanica della catena di progressione.
//
// Un milestone è soddisfatto quando:
//   - è nell'insieme `completed` passato dal controller (verifica reale già
//     avvenuta con verifySkill, anche per criteri dinamici come first_night), o
//   - `satisfiedWhen` è valutabile sull'osservazione corrente e risulta vero.
//
// Modulo quasi puro: solo il loader legge il file JSON.

import { readFileSync } from 'node:fs';
import { evaluateCriteria, validateCriteria } from './verify.mjs';

export function validateProgression (graph) {
  const errors = [];
  if (!graph || typeof graph !== 'object') return ['progression must be an object'];
  if (!graph.milestones || typeof graph.milestones !== 'object') return ['missing milestones object'];
  const ids = Object.keys(graph.milestones);
  for (const id of ids) {
    const node = graph.milestones[id];
    if (!node || typeof node !== 'object') { errors.push(`milestone "${id}": not an object`); continue; }
    if (node.requires != null && !Array.isArray(node.requires)) errors.push(`milestone "${id}": requires must be an array`);
    for (const requirement of node.requires || []) {
      if (!ids.includes(requirement)) errors.push(`milestone "${id}": unknown requirement "${requirement}"`);
    }
    if (node.skill != null && typeof node.skill !== 'string') errors.push(`milestone "${id}": skill must be a string`);
    errors.push(...validateCriteria(node.satisfiedWhen, `milestone "${id}".satisfiedWhen`));
  }
  for (const [goal, target] of Object.entries(graph.goals || {})) {
    if (!ids.includes(target)) errors.push(`goal "${goal}": unknown milestone "${target}"`);
  }
  // Rileva cicli.
  const state = new Map();
  const visit = (id, stack) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') { errors.push(`cycle in progression: ${[...stack, id].join(' -> ')}`); return; }
    state.set(id, 'visiting');
    for (const requirement of graph.milestones[id]?.requires || []) visit(requirement, [...stack, id]);
    state.set(id, 'done');
  };
  for (const id of ids) visit(id, []);
  return errors;
}

export async function loadProgression (url) {
  const graph = JSON.parse(readFileSync(url, 'utf8'));
  const errors = validateProgression(graph);
  if (errors.length) throw new Error(`invalid progression graph:\n${errors.join('\n')}`);
  return graph;
}

function goalId (graph, goal) {
  return graph.goals?.[goal] || goal;
}

// Stato di ogni milestone rispetto all'osservazione corrente.
export function progressionSnapshot (graph, { observation, completed = new Set() } = {}) {
  return Object.keys(graph.milestones).map(id => ({
    id,
    skill: graph.milestones[id].skill ?? null,
    satisfied: isMilestoneSatisfied(graph, id, observation, completed),
  }));
}

function isMilestoneSatisfied (graph, id, observation, completed) {
  const node = graph.milestones[id];
  if (!node) return false;
  if (completed.has(id)) return true;
  if (node.satisfiedWhen) return evaluateCriteria(node.satisfiedWhen, observation).ok;
  return false;
}

// Primo milestone non soddisfatto con tutti i prerequisiti soddisfatti.
// Ritorna:
//   { status: 'met', milestone }                obiettivo già raggiunto
//   { status: 'next', milestone, skill, ... }   prossimo passo utile
//   { status: 'error', reason }                 obiettivo/grafo non utilizzabile
export function resolveMilestone (graph, { goal, observation = {}, completed = new Set() } = {}) {
  const target = goalId(graph, goal);
  if (!graph.milestones[target]) {
    return { status: 'error', reason: `unknown milestone "${target}"`, milestone: null, skill: null };
  }
  const satisfied = (id) => isMilestoneSatisfied(graph, id, observation, completed);
  if (satisfied(target)) return { status: 'met', milestone: target, skill: null };

  let resolved = null;
  const visiting = new Set();
  const visit = (id) => {
    if (resolved) return;
    if (satisfied(id)) return;
    const node = graph.milestones[id];
    if (!node) { resolved = { status: 'error', reason: `unknown requirement "${id}"`, milestone: null, skill: null }; return; }
    if (visiting.has(id)) { resolved = { status: 'error', reason: `cycle through "${id}"`, milestone: null, skill: null }; return; }
    visiting.add(id);
    for (const requirement of node.requires || []) {
      visit(requirement);
      if (resolved) return;
    }
    visiting.delete(id);
    if ((node.requires || []).every(satisfied)) {
      resolved = {
        status: 'next',
        milestone: id,
        skill: node.skill ?? null,
        description: node.description ?? null,
        missing: (node.requires || []).filter(requirement => !satisfied(requirement)),
      };
    }
  };
  visit(target);
  if (resolved) return resolved;
  return { status: 'error', reason: `no unsatisfied milestone reachable from "${target}"`, milestone: null, skill: null };
}
