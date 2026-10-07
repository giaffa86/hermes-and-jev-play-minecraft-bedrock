// R0: l'inventario delle capability debe (a) descrivere il repo reale senza
// errori e (b) **accorgersi** di un collegamento rotto invece di tacerlo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildInventory } from '../tools/capability-inventory.mjs';

function fixture ({ skills = {}, circuits = {}, progression = { goals: {}, milestones: {} } }) {
  const root = mkdtempSync(join(tmpdir(), 'capinv-'));
  const skillsDir = join(root, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  for (const [name, def] of Object.entries(skills)) writeFileSync(join(skillsDir, name), JSON.stringify(def));
  const circuitsDir = join(root, 'circuits');
  mkdirSync(circuitsDir, { recursive: true });
  for (const [name, def] of Object.entries(circuits)) writeFileSync(join(circuitsDir, name), JSON.stringify(def));
  const progressionPath = join(root, 'progression.json');
  writeFileSync(progressionPath, JSON.stringify(progression));
  return {
    skillsRoot: pathToFileURL(`${skillsDir}/`),
    circuitsRoot: circuitsDir,
    progressionPath,
  };
}

function skill (id, extra = {}) {
  return { id, description: `${id} fixture`, intents: [], ...extra };
}

const lamp = {
  schemaVersion: 1,
  id: 'lamp_switch',
  description: 'fixture lamp',
  requires: { redstone_lamp: 1, lever: 1 },
  buildable: true,
  steps: [
    { item: 'redstone_lamp', offset: [0, 0, 0], label: 'lamp' },
    { item: 'lever', offset: [0, 1, 0], supportOffset: [0, 0, 0], face: 1, label: 'lever' },
  ],
  notes: 'fixture',
};

function kinds (inventory, level) {
  return inventory.issues.filter(issue => issue.level === level).map(issue => issue.kind).sort();
}

test('the real repository inventories cleanly', () => {
  const inventory = buildInventory();
  assert.equal(kinds(inventory, 'error').length, 0, JSON.stringify(inventory.issues, null, 2));
  assert.ok(inventory.skills.length > 0, 'expected skills');
  assert.ok(inventory.circuits.length > 0, 'expected circuits');
  assert.ok(inventory.milestones.length > 0, 'expected milestones');
  assert.ok(inventory.intents.length > 0, 'expected intents');
  assert.ok(inventory.criteria.length > 0, 'expected criteria');

  const ids = inventory.skills.map(s => s.id);
  assert.deepEqual(ids, [...ids].sort(), 'skills must be sorted by id');
  assert.equal(new Set(ids).size, ids.length, 'skill ids must be unique');
});

test('a milestone that names a missing skill is an error', () => {
  const inventory = buildInventory(fixture({
    skills: { 'a.json': skill('a_skill') },
    progression: { goals: {}, milestones: { m1: { skill: 'ghost_skill', requires: [] } } },
  }));
  assert.deepEqual(kinds(inventory, 'error'), ['milestone_skill_missing']);
});

test('a milestone that requires a non-milestone is an error', () => {
  const inventory = buildInventory(fixture({
    skills: { 'a.json': skill('a_skill') },
    progression: { goals: {}, milestones: { m1: { skill: 'a_skill', requires: ['m404'] } } },
  }));
  assert.deepEqual(kinds(inventory, 'error'), ['milestone_requires_missing']);
});

test('a goal pointing at a missing milestone is an error', () => {
  const inventory = buildInventory(fixture({
    skills: { 'a.json': skill('a_skill') },
    progression: { goals: { survive: 'm404' }, milestones: { m1: { skill: 'a_skill', requires: [] } } },
  }));
  assert.deepEqual(kinds(inventory, 'error'), ['goal_target_missing']);
});

test('a skill building a circuit that does not exist is an error', () => {
  const inventory = buildInventory(fixture({
    skills: { 'a.json': skill('a_skill', { success: { circuitBuilt: { id: 'ghost_circuit' } } }) },
  }));
  assert.deepEqual(kinds(inventory, 'error'), ['skill_circuit_missing']);
});

test('an intent outside the vocabulary is rejected when the skill is loaded', () => {
  // Il vocabolario e' gia' un cancello del loader, non un controllo a valle:
  // una skill con un intento inventato non entra proprio nell'inventario.
  assert.throws(
    () => buildInventory(fixture({ skills: { 'a.json': skill('a_skill', { intents: ['not_an_intent'] }) } })),
    /unknown intent "not_an_intent"/,
  );
});

test('a buildable circuit no skill claims is a warning, not an error', () => {
  const inventory = buildInventory(fixture({
    skills: { 'a.json': skill('a_skill') },
    circuits: { 'lamp.json': lamp },
  }));
  assert.deepEqual(kinds(inventory, 'error'), []);
  assert.deepEqual(kinds(inventory, 'warning'), ['orphan_circuit']);
});

test('a circuit claimed by a skill is inventoried with its steps and requires', () => {
  const inventory = buildInventory(fixture({
    skills: { 'a.json': skill('a_skill', { success: { circuitBuilt: { id: 'lamp_switch' } } }) },
    circuits: { 'lamp.json': lamp },
  }));
  assert.deepEqual(kinds(inventory, 'warning'), []);
  assert.deepEqual(inventory.circuits, [{
    id: 'lamp_switch',
    buildable: true,
    steps: 2,
    requires: ['lever', 'redstone_lamp'],
  }]);
  assert.equal(inventory.skills[0].circuit, 'lamp_switch');
});
