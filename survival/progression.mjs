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
import { evaluateCriteria, validateCriteria, CRITERIA_KEYS } from './verify.mjs';
import { criteriaNames } from '../plan-shape.mjs';

const CRITERIA = new Set(CRITERIA_KEYS);

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
    // R5: un goal puo' valere per piu' milestone (goal composito) — la sua
    // espansione e' l'unione delle chiusure dei target, in ordine di dipendenza.
    const targets = Array.isArray(target) ? target : [target];
    if (!targets.length) errors.push(`goal "${goal}": empty milestone list`);
    for (const id of targets) {
      if (!ids.includes(id)) errors.push(`goal "${goal}": unknown milestone "${id}"`);
    }
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
  let graph;
  try {
    graph = JSON.parse(readFileSync(url, 'utf8'));
  } catch (error) {
    throw new Error(`invalid progression graph: ${error.message}`);
  }
  const errors = validateProgression(graph);
  if (errors.length) throw new Error(`invalid progression graph:\n${errors.join('\n')}`);
  return graph;
}

// R5: i target di un goal. Un goal del grafo puo' essere un id solo (come
// sempre) o una **lista** di id: un goal composito non aggiunge milestone, ne
// unisce due rami gia' dichiarati.
export function goalTargets (graph, goal) {
  const declared = graph?.goals && Object.prototype.hasOwnProperty.call(graph.goals, goal)
    ? graph.goals[goal]
    : goal;
  return (Array.isArray(declared) ? declared : [declared]).map(target => String(target));
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

// R5: la catena dei milestone mancanti, in ordine di dipendenza.
//
// `resolveMilestone` risponde "qual e' il prossimo passo utile"; questo risponde
// anche "e poi?": la chiusura dei target (dichiarata, non inventata) in un ordine
// topologico stabile (prima i prerequisiti, nell'ordine di `requires`), senza i
// milestone gia' soddisfatti. Il primo elemento e' quindi per costruzione un
// milestone con tutti i prerequisiti soddisfatti, cioe' esattamente il `next`.
//
// Ritorna:
//   { status: 'met',   targets, chain: [], steps: [], next: null }
//   { status: 'next',  targets, chain: [id...], steps: [...], next, missing }
//   { status: 'error', reason, targets, chain: [], steps: [], next: null }
export function milestoneChain (graph, { goal, observation = {}, completed = new Set() } = {}) {
  const targets = goalTargets(graph, goal);
  for (const target of targets) {
    if (!graph.milestones?.[target]) {
      return { status: 'error', reason: `unknown milestone "${target}"`, targets, chain: [], steps: [], next: null, missing: [] };
    }
  }
  const satisfied = (id) => isMilestoneSatisfied(graph, id, observation, completed);
  if (targets.every(satisfied)) {
    return { status: 'met', targets, chain: [], steps: [], next: null, missing: [] };
  }
  const order = [];
  const seen = new Set();
  const visiting = new Set();
  let error = null;
  const visit = (id) => {
    if (error || seen.has(id) || satisfied(id)) return;
    const node = graph.milestones[id];
    if (!node) { error = `unknown requirement "${id}"`; return; }
    if (visiting.has(id)) { error = `cycle through "${id}"`; return; }
    visiting.add(id);
    for (const requirement of node.requires || []) {
      visit(requirement);
      if (error) return;
    }
    visiting.delete(id);
    if (!seen.has(id)) { seen.add(id); order.push(id); }
  };
  for (const target of targets) {
    visit(target);
    if (error) break;
  }
  if (error) return { status: 'error', reason: error, targets, chain: [], steps: [], next: null, missing: [] };
  if (!order.length) return { status: 'met', targets, chain: [], steps: [], next: null, missing: [] };
  const steps = order.map(id => milestoneStep(graph, id, satisfied));
  const head = steps.find(step => step.missing.length === 0) ?? steps[0];
  return {
    status: 'next',
    targets,
    chain: order,
    steps,
    next: { status: 'next', milestone: head.id, skill: head.skill, description: head.description, missing: head.missing },
    missing: head.missing,
  };
}

// Uno step della catena: il milestone e la skill che lo chiude, i prerequisiti
// che gli **mancano adesso** (non quelli che mancheranno al suo turno: la
// catena non simula il mondo, elenca ciò che serve) e i criteri con cui il
// verifier lo riconosce. `verify` e' filtrato sul vocabolario del verificatore
// (`CRITERIA_KEYS`): da qui non entra un nome di criterio nuovo.
function milestoneStep (graph, id, satisfied) {
  const node = graph.milestones[id];
  const requires = node.requires || [];
  return {
    id,
    milestone: id,
    skill: node.skill ?? null,
    description: node.description ?? null,
    requires: [...requires],
    missing: requires.filter(requirement => !satisfied(requirement)),
    verify: [...criteriaNames(node.satisfiedWhen)].filter(name => CRITERIA.has(name)).sort(),
  };
}

// Primo milestone non soddisfatto con tutti i prerequisiti soddisfatti.
// Ritorna:
//   { status: 'met', milestone }                obiettivo (o composito) raggiunto
//   { status: 'next', milestone, skill, ... }   prossimo passo utile
//   { status: 'error', reason }                 obiettivo/grafo non utilizzabile
// In piu', in entrambi i casi utili, `targets` (i milestone che il goal nomina:
// uno, o piu' se il goal e' composito) e — su `next` — `chain`/`steps`, la
// chiusura mancante in ordine di dipendenza (vedi `milestoneChain`).
export function resolveMilestone (graph, { goal, observation = {}, completed = new Set() } = {}) {
  const chain = milestoneChain(graph, { goal, observation, completed });
  if (chain.status === 'met') {
    return { status: 'met', milestone: chain.targets[0] ?? null, skill: null, targets: chain.targets, chain: [], steps: [] };
  }
  if (chain.status === 'error') {
    return { status: 'error', reason: chain.reason, milestone: null, skill: null, targets: chain.targets, chain: [], steps: [] };
  }
  return { ...chain.next, targets: chain.targets, chain: chain.chain, steps: chain.steps };
}
