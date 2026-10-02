// Unit test del Progression Engine: validazione del grafo, risoluzione delle
// dipendenze e memoria dei milestone verificati. Nessun server richiesto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadProgression, validateProgression, resolveMilestone, progressionSnapshot,
} from '../survival/index.mjs';

const PROGRESSION_URL = new URL('../knowledge/progression.json', import.meta.url);
const graph = await loadProgression(PROGRESSION_URL);

const empty = { inventory: {}, nearby: {}, time: { phase: 'day', night: false } };

test('the shipped progression graph is valid and covers the early chain', () => {
  assert.deepEqual(validateProgression(graph), []);
  for (const id of ['wood', 'crafting_table', 'stone_tools', 'food_and_safety', 'first_night', 'iron_age', 'diamonds', 'enter_nether']) {
    assert.ok(graph.milestones[id], `milestone ${id}`);
  }
});

test('validation catches unknown requirements and cycles', () => {
  const bad = validateProgression({ milestones: { a: { requires: ['ghost'] } } });
  assert.ok(bad.some(error => error.includes('unknown requirement "ghost"')));
  const cycle = validateProgression({ milestones: { a: { requires: ['b'] }, b: { requires: ['a'] } } });
  assert.ok(cycle.some(error => error.includes('cycle')));
});

test('enter_nether from an empty inventory resolves to wood first', () => {
  const result = resolveMilestone(graph, { goal: 'enter_nether', observation: empty });
  assert.equal(result.status, 'next');
  assert.equal(result.milestone, 'wood');
  assert.equal(result.skill, 'acquire_wood');
});

test('each satisfied prerequisite unlocks the next one', () => {
  const withWood = resolveMilestone(graph, {
    goal: 'enter_nether',
    observation: { inventory: { oak_log: 8 }, nearby: {}, time: { phase: 'day' } },
  });
  assert.equal(withWood.milestone, 'crafting_table');

  const withTable = resolveMilestone(graph, {
    goal: 'enter_nether',
    observation: { inventory: { oak_log: 8, crafting_table: 1 }, nearby: {}, time: { phase: 'day' } },
  });
  assert.equal(withTable.milestone, 'stone_tools');
  assert.equal(withTable.skill, 'stone_age');
});

test('a goal already satisfied is reported as met', () => {
  const result = resolveMilestone(graph, { goal: 'wood', observation: { inventory: { oak_log: 10 } } });
  assert.equal(result.status, 'met');
  assert.equal(result.milestone, 'wood');
});

test('first_night resolves through its prerequisites and then waits for verification', () => {
  const start = resolveMilestone(graph, { goal: 'first_night', observation: empty });
  assert.equal(start.milestone, 'wood');
  const afterDeps = resolveMilestone(graph, {
    goal: 'first_night',
    observation: {
      inventory: { oak_log: 8, crafting_table: 1, bread: 1 },
      nearby: {},
      time: { phase: 'day' },
    },
  });
  assert.equal(afterDeps.milestone, 'first_night');
  assert.equal(afterDeps.skill, 'first_night');
  // first_night non ha satisfiedWhen: serve la verifica reale del controller.
  const completed = new Set(['first_night']);
  const met = resolveMilestone(graph, {
    goal: 'first_night',
    observation: {
      inventory: { oak_log: 8, crafting_table: 1, bread: 1 },
      nearby: {},
      time: { phase: 'day' },
    },
    completed,
  });
  assert.equal(met.status, 'met');
});

test('completed memory satisfies milestones with dynamic criteria', () => {
  const observation = { inventory: {}, nearby: {}, time: { phase: 'day' } };
  const result = resolveMilestone(graph, { goal: 'first_night', observation, completed: new Set(['wood', 'crafting_table', 'food_and_safety']) });
  assert.equal(result.milestone, 'first_night');
  const met = resolveMilestone(graph, { goal: 'first_night', observation, completed: new Set(['wood', 'crafting_table', 'food_and_safety', 'first_night']) });
  assert.equal(met.status, 'met');
});

test('a placed crafting table satisfies the crafting_table milestone', () => {
  const result = resolveMilestone(graph, {
    goal: 'enter_nether',
    observation: { inventory: { oak_log: 8 }, nearby: { crafting_table: [{ distance: 4 }] }, time: { phase: 'day' } },
  });
  assert.equal(result.milestone, 'stone_tools');
});

test('unknown goals and graphs fail with a clear reason', () => {
  const result = resolveMilestone(graph, { goal: 'defeat_herobrine', observation: empty });
  assert.equal(result.status, 'error');
  assert.match(result.reason, /unknown milestone/);
});

test('progressionSnapshot lists every milestone with its status', () => {
  const snapshot = progressionSnapshot(graph, { observation: { inventory: { oak_log: 8 } }, completed: new Set() });
  const wood = snapshot.find(entry => entry.id === 'wood');
  assert.equal(wood.satisfied, true);
  const table = snapshot.find(entry => entry.id === 'crafting_table');
  assert.equal(table.satisfied, false);
  assert.equal(snapshot.length, Object.keys(graph.milestones).length);
});
