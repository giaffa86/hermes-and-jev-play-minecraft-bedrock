// Unit test del Progression Engine: validazione del grafo, risoluzione delle
// dipendenze e memoria dei milestone verificati. Nessun server richiesto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadProgression, validateProgression, resolveMilestone, milestoneChain, goalTargets,
  progressionSnapshot, isKnownTag, itemMatchesTag, tagCount, tagItems,
} from '../survival/index.mjs';

const PROGRESSION_URL = new URL('../knowledge/progression.json', import.meta.url);
const graph = await loadProgression(PROGRESSION_URL);

const empty = { inventory: {}, nearby: {}, time: { phase: 'day', night: false } };

test('the shipped progression graph is valid and covers the early chain', () => {
  assert.deepEqual(validateProgression(graph), []);
  for (const id of [
    'wood', 'crafting_table', 'stone_tools', 'food_and_safety', 'first_night',
    'iron_age', 'diamonds', 'nether_portal', 'enter_nether', 'nether_survival',
    'piglin_barter', 'obtain_blaze_rods', 'obtain_ender_pearls',
    'craft_eyes_of_ender', 'find_stronghold', 'enter_end', 'beat_the_dragon',
    'redstone_ore', 'redstone_basics', 'redstone_automation',
  ]) {
    assert.ok(graph.milestones[id], `milestone ${id}`);
  }
});

test('the redstone tags group the dust, the parts and the hoppers', () => {
  for (const tag of ['redstone_dust', 'redstone_parts', 'hoppers']) assert.equal(isKnownTag(tag), true, tag);
  assert.equal(itemMatchesTag('redstone', 'redstone_dust'), true);
  assert.equal(itemMatchesTag('minecraft:redstone', 'redstone_dust'), true);
  assert.equal(itemMatchesTag('redstone_ore', 'redstone_dust'), false, 'il blocco non è la polvere');
  assert.equal(itemMatchesTag('deepslate_redstone_ore', 'redstone_dust'), false);
  const inventory = { redstone: 4, repeater: 1, lever: 2, hopper: 1, obsidian: 9 };
  assert.equal(tagCount(inventory, 'redstone_dust'), 4);
  assert.equal(tagCount(inventory, 'redstone_parts'), 4);
  assert.equal(tagCount(inventory, 'hoppers'), 1);
  assert.deepEqual(tagItems(inventory, 'redstone_parts'), ['hopper', 'lever', 'repeater'], 'anche la hopper è una parte redstone');
});

test('the redstone chain hangs off iron_age and its last node is skill-verified', () => {
  assert.equal(graph.goals.redstone, 'redstone_automation');
  assert.deepEqual(graph.milestones.redstone_ore.requires, ['iron_age']);
  assert.deepEqual(graph.milestones.redstone_ore.satisfiedWhen, { inventoryTagGte: { redstone_dust: 1 } });
  assert.deepEqual(graph.milestones.redstone_basics.requires, ['redstone_ore']);
  assert.deepEqual(graph.milestones.redstone_basics.satisfiedWhen, { inventoryTagGte: { redstone_parts: 1 } });
  assert.equal(graph.milestones.redstone_automation.satisfiedWhen, undefined, 'automation si chiude solo con la skill verificata');
  assert.equal(graph.milestones.redstone_automation.skill, 'build_lamp_switch');

  const milestones = ['wood', 'crafting_table', 'stone_tools', 'iron_age'];
  const base = { inventory: { oak_log: 8, crafting_table: 1, stone_pickaxe: 1, iron_pickaxe: 1 }, nearby: {}, time: { phase: 'day' } };
  const toOre = resolveMilestone(graph, { goal: 'redstone', observation: base, completed: new Set(milestones) });
  assert.equal(toOre.status, 'next');
  assert.equal(toOre.milestone, 'redstone_ore');
  assert.equal(toOre.skill, 'redstone_basics');

  const withDust = { ...base, inventory: { ...base.inventory, redstone: 4 } };
  const toParts = resolveMilestone(graph, { goal: 'redstone', observation: withDust, completed: new Set(milestones) });
  assert.equal(toParts.milestone, 'redstone_basics');
  assert.equal(toParts.skill, 'craft_redstone_part');

  const withParts = { ...base, inventory: { ...base.inventory, redstone: 4, repeater: 1 } };
  const toAutomation = resolveMilestone(graph, { goal: 'redstone', observation: withParts, completed: new Set(milestones) });
  assert.equal(toAutomation.milestone, 'redstone_automation');
  assert.equal(toAutomation.skill, 'build_lamp_switch');

  // La milestone finale non si chiude da sola: l'inventario pieno non basta.
  const stillNext = resolveMilestone(graph, { goal: 'redstone', observation: { ...withParts, inventory: { ...withParts.inventory, redstone_lamp: 3, lever: 3 } }, completed: new Set(milestones) });
  assert.equal(stillNext.status, 'next');
  assert.equal(stillNext.milestone, 'redstone_automation');
  const done = resolveMilestone(graph, { goal: 'redstone', observation: withParts, completed: new Set([...milestones, 'redstone_ore', 'redstone_basics', 'redstone_automation']) });
  assert.equal(done.status, 'met');
});

test('beat_the_dragon is a real milestone, no longer aliased to enter_nether', () => {
  assert.equal(graph.goals.beat_the_dragon, 'beat_the_dragon');
  assert.deepEqual(graph.milestones.beat_the_dragon.requires, ['enter_end']);
  assert.deepEqual(graph.milestones.enter_end.requires, ['find_stronghold']);
  assert.deepEqual(graph.milestones.enter_end.satisfiedWhen, { dimension: 'the_end' });
});

test('nether_portal sits between diamonds and enter_nether and prefers a nearby portal', () => {
  const completed = new Set(['wood', 'crafting_table', 'stone_tools', 'iron_age']);
  const ready = { inventory: { diamond: 1 }, nearby: {}, time: { phase: 'day' } };
  const next = resolveMilestone(graph, { goal: 'enter_nether', observation: ready, completed });
  assert.equal(next.milestone, 'nether_portal');
  assert.equal(next.skill, 'nether_portal');
  const withPortal = resolveMilestone(graph, {
    goal: 'enter_nether',
    observation: { inventory: { diamond: 1 }, nearby: { portal: [{ distance: 10 }] }, time: { phase: 'day' } },
    completed,
  });
  assert.equal(withPortal.milestone, 'enter_nether');
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

test('the fluid tags group buckets, boats and potions', () => {
  for (const tag of ['buckets', 'boats', 'potions']) assert.equal(isKnownTag(tag), true, tag);
  assert.equal(itemMatchesTag('bucket', 'buckets'), true);
  assert.equal(itemMatchesTag('minecraft:water_bucket', 'buckets'), true);
  assert.equal(itemMatchesTag('bucket_of_milk', 'buckets'), false, 'non è un nome Bedrock');
  assert.equal(itemMatchesTag('oak_boat', 'boats'), true);
  assert.equal(itemMatchesTag('spruce_chest_boat', 'boats'), true);
  assert.equal(itemMatchesTag('bamboo_raft', 'boats'), true);
  assert.equal(itemMatchesTag('boat_planks', 'boats'), false, 'le assi non sono una barca');
  assert.equal(itemMatchesTag('potion', 'potions'), true);
  assert.equal(itemMatchesTag('splash_potion', 'potions'), true);
  const inventory = { bucket: 1, water_bucket: 2, oak_boat: 1, potion: 2, obsidian: 9 };
  assert.equal(tagCount(inventory, 'buckets'), 3, 'anche i secchi pieni contano');
  assert.equal(tagCount(inventory, 'boats'), 1);
  assert.equal(tagCount(inventory, 'potions'), 2);
  assert.deepEqual(tagItems(inventory, 'buckets'), ['bucket', 'water_bucket']);
});

test('the fluid milestones chain from the iron age to the lava crossing', () => {
  for (const id of ['bucket', 'water_travel', 'nether_cross_lava']) assert.ok(graph.milestones[id], `milestone ${id}`);
  assert.deepEqual(graph.milestones.bucket.requires, ['iron_age']);
  assert.equal(graph.milestones.bucket.skill, 'craft_bucket');
  assert.deepEqual(graph.milestones.bucket.satisfiedWhen, { inventoryTagGte: { buckets: 1 } });
  assert.deepEqual(graph.milestones.water_travel.requires, ['bucket']);
  assert.equal(graph.milestones.water_travel.skill, 'boat_travel');
  assert.equal(graph.milestones.water_travel.satisfiedWhen, null, 'una traversata in barca non si vede da un criterio statico: la chiude solo la skill verificata');
  assert.deepEqual(graph.milestones.nether_cross_lava.requires, ['water_travel']);
  assert.equal(graph.milestones.nether_cross_lava.skill, 'bucket_and_place_water');
  // Le tre sono raggiungibili come obiettivo di curriculum, altrimenti il
  // milestone esiste ma nessun `CURRICULUM=...` può chiederlo.
  assert.equal(graph.goals.water_travel, 'water_travel');
  assert.equal(graph.goals.bucket, 'bucket');
  assert.equal(graph.goals.nether_cross_lava, 'nether_cross_lava');
});

test('the bucket milestone is satisfied by a crafted bucket, not by raw iron', () => {
  const iron = resolveMilestone(graph, { goal: 'bucket', observation: { inventory: { iron_ingot: 3 }, nearby: {}, time: { phase: 'day' } } });
  assert.equal(iron.status, 'next', 'il ferro non è un secchio: il milestone resta da fare');
  assert.equal(iron.milestone, 'bucket');
  assert.equal(iron.skill, 'craft_bucket');
  const crafted = resolveMilestone(graph, { goal: 'bucket', observation: { inventory: { bucket: 1 }, nearby: {}, time: { phase: 'day' } } });
  assert.equal(crafted.status, 'met');
});

// --- R5: goal compositi -----------------------------------------------------

test('a composite goal expands into its targets, in dependency order', () => {
  assert.deepEqual(goalTargets(graph, 'prepare_for_nether'), ['enter_nether', 'nether_survival']);
  // Un goal semplice resta una lista di uno.
  assert.deepEqual(goalTargets(graph, 'enter_nether'), ['enter_nether']);

  const result = resolveMilestone(graph, { goal: 'prepare_for_nether', observation: empty });
  assert.equal(result.status, 'next');
  assert.equal(result.milestone, 'wood', 'il goal composito non cambia il contratto del primo passo');
  assert.deepEqual(result.targets, ['enter_nether', 'nether_survival']);
  assert.deepEqual(result.chain, [
    'wood', 'crafting_table', 'stone_tools', 'iron_age',
    'diamonds', 'nether_portal', 'enter_nether', 'nether_survival',
  ]);
  // Il primo elemento della catena è il `next`: chi lo consuma non deve fidarsi dell'ordine.
  assert.equal(result.chain[0], result.milestone);
  assert.equal(result.steps.length, result.chain.length, 'uno step per milestone mancante');
  for (const step of result.steps) {
    assert.equal(step.id, step.milestone);
    assert.ok(graph.milestones[step.id].skill === step.skill, `skill dichiarata per ${step.id}`);
  }
  // `missing` è ciò che manca **adesso** al passo, non ciò che mancherà quando
  // sarà il suo turno: il primo passo è l'unico a mani libere, gli altri
  // dichiarano ancora il prerequisito che li blocca.
  assert.deepEqual(result.steps[0].missing, [], 'il passo attivo ha tutti i prerequisiti soddisfatti');
  assert.deepEqual(result.steps.find(step => step.id === 'crafting_table').missing, ['wood']);
  assert.deepEqual(result.steps[0].verify, ['inventoryTagGte'], 'il criterio del milestone viaggia con lo step');
  assert.ok(result.steps.find(step => step.id === 'enter_nether').verify.includes('dimension'));
  assert.equal(result.steps.find(step => step.id === 'nether_survival').verify.length, 0, 'nether_survival non ha satisfiedWhen: lo chiude la skill');
});

test('a satisfied prerequisite is skipped, and the chain shortens', () => {
  const withWood = resolveMilestone(graph, {
    goal: 'prepare_for_nether',
    observation: { inventory: { oak_log: 8 }, nearby: {}, time: { phase: 'day' } },
  });
  assert.equal(withWood.milestone, 'crafting_table');
  assert.deepEqual(withWood.chain.slice(0, 3), ['crafting_table', 'stone_tools', 'iron_age']);
  assert.equal(withWood.chain.includes('wood'), false);

  const completed = new Set(['wood', 'crafting_table', 'stone_tools', 'iron_age', 'diamonds', 'nether_portal', 'enter_nether']);
  const almost = resolveMilestone(graph, { goal: 'prepare_for_nether', observation: empty, completed });
  assert.equal(almost.milestone, 'nether_survival');
  assert.deepEqual(almost.chain, ['nether_survival'], 'la catena racconta solo ciò che manca davvero');
});

test('a composite goal closes only when every target is satisfied', () => {
  const deps = ['wood', 'crafting_table', 'stone_tools', 'iron_age', 'diamonds', 'nether_portal'];
  // `enter_nether` è soddisfatto dal mondo (sei nel Nether), `nether_survival` no:
  // un target caduto non chiude il goal.
  const half = resolveMilestone(graph, {
    goal: 'prepare_for_nether',
    observation: { inventory: {}, nearby: {}, time: { phase: 'day' }, dimension: 'nether' },
    completed: new Set(deps),
  });
  assert.equal(half.status, 'next');
  assert.equal(half.milestone, 'nether_survival');
  assert.deepEqual(half.chain, ['nether_survival']);

  const met = resolveMilestone(graph, {
    goal: 'prepare_for_nether',
    observation: { inventory: {}, nearby: {}, time: { phase: 'day' }, dimension: 'nether' },
    completed: new Set([...deps, 'nether_survival']),
  });
  assert.equal(met.status, 'met');
  assert.deepEqual(met.targets, ['enter_nether', 'nether_survival']);
  assert.deepEqual(met.chain, []);
});

test('milestoneChain reports an unusable chain instead of guessing', () => {
  const tiny = { milestones: { a: { requires: [], description: 'a', skill: 's_a' }, b: { requires: ['a'] } }, goals: {} };
  assert.deepEqual(milestoneChain(tiny, { goal: 'a' }).chain, ['a']);
  const ghost = milestoneChain(tiny, { goal: 'ghost' });
  assert.equal(ghost.status, 'error');
  assert.match(ghost.reason, /unknown milestone "ghost"/);
  assert.deepEqual(ghost.steps, [], 'un errore non porta passi');
  const broken = { milestones: { a: { requires: ['ghost'] } }, goals: {} };
  const dangling = milestoneChain(broken, { goal: 'a' });
  assert.equal(dangling.status, 'error');
  assert.match(dangling.reason, /unknown requirement "ghost"/);
  const cyclic = { milestones: { a: { requires: ['b'] }, b: { requires: ['a'] } }, goals: {} };
  assert.match(milestoneChain(cyclic, { goal: 'a' }).reason, /cycle through/);
});

test('validation rejects a composite goal that names an unknown milestone or nothing', () => {
  const bad = validateProgression({ milestones: { a: { requires: [] } }, goals: { trip: ['a', 'ghost'] } });
  assert.ok(bad.some(error => error.includes('goal "trip": unknown milestone "ghost"')));
  const emptyList = validateProgression({ milestones: { a: { requires: [] } }, goals: { trip: [] } });
  assert.ok(emptyList.some(error => error.includes('goal "trip": empty milestone list')));
  assert.deepEqual(validateProgression({ milestones: { a: { requires: [] } }, goals: { trip: ['a'] } }), []);
});
