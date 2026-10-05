// Scenario integrato (senza server): un obiettivo di progressione viene
// interrotto da un bisogno di sopravvivenza e poi riprende dallo stesso
// milestone. Verifica l'orchestrazione tra governor, resolver, verifier e
// progression engine: gli stessi moduli usati da harness e controller.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadGameplaySkills, loadProgression, loadSurvivalRules,
  evaluateSurvival, resolveMilestone, resolveActiveSkill, skillPreferredIntents,
  filterOptionsForGovernor, verifySkill, summarizeSurvival,
} from '../survival/index.mjs';
import { rankOptions, filterOptions } from '../controller-decisions.mjs';

const skills = loadGameplaySkills();
const graph = await loadProgression(new URL('../knowledge/progression.json', import.meta.url));
const rules = await loadSurvivalRules(new URL('../knowledge/survival-rules.json', import.meta.url));

function observation (overrides = {}) {
  return {
    spawned: true,
    status: 'spawned',
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20,
    dimension: 'overworld',
    inventory: {},
    entities: [],
    drops: [],
    time: { ticks: 6000, phase: 'day', night: false },
    ...overrides
  };
}

function planFor (milestone) {
  if (milestone?.status !== 'next' || !milestone.skill) return null;
  const def = skills.get(milestone.skill);
  return {
    objective: def.description,
    skill: milestone.skill,
    milestone: milestone.milestone,
    startObservation: null,
    targets: def.planTargets || {},
  };
}

// Un "tick" del controller: governor -> milestone -> skill attiva -> filtro opzioni.
function tick ({ obs, plan, completed, offered, sawNight = false }) {
  const governor = evaluateSurvival(obs, { rules });
  const milestone = resolveMilestone(graph, { goal: 'first_night', observation: obs, completed });
  const active = resolveActiveSkill({ skills, plan, governor, milestone, observation: obs });
  const restricted = filterOptionsForGovernor(offered, governor);
  const objective = governor.mode !== 'normal' && governor.overrideObjective ? governor.overrideObjective : plan?.objective ?? null;
  return { governor, milestone, active, restricted, objective };
}

test('progression objective is interrupted by an emergency and later resumes', () => {
  const completed = new Set();
  const offered = [
    { key: 'mine_oak_log', description: 'Mine oak_log' },
    { key: 'craft_oak_planks', description: 'Craft planks' },
    { key: 'collect_drop', description: 'Collect drop' },
    { key: 'flee', description: 'Run away from creeper' },
    { key: 'eat', description: 'Eat bread' },
    { key: 'wait', description: 'Wait' },
  ];

  // 1. Spawn pulito: il motore punta al primo milestone mancante.
  let plan = planFor(resolveMilestone(graph, { goal: 'first_night', observation: observation(), completed }));
  assert.equal(plan.skill, 'acquire_wood');

  // 2. Il verifier conferma il legno da stato reale del harness.
  const woodObs = observation({ inventory: { oak_log: 5, spruce_log: 5 } });
  assert.equal(verifySkill(skills.get('acquire_wood'), {}, woodObs).status, 'success');
  completed.add('wood');
  plan = planFor(resolveMilestone(graph, { goal: 'first_night', observation: woodObs, completed }));
  assert.equal(plan.skill, 'acquire_crafting_table');

  // 3. Tavolo ottenuto: il prossimo bisogno deterministico è cibo/sicurezza.
  const tableObs = observation({ inventory: { oak_log: 8, crafting_table: 1 } });
  completed.add('crafting_table');
  plan = planFor(resolveMilestone(graph, { goal: 'first_night', observation: tableObs, completed }));
  assert.equal(plan.skill, 'obtain_food');
  assert.equal(plan.milestone, 'food_and_safety');

  // 4. Emergenza: notte, vita 4, creeper a 4 blocchi. La progressione si ferma.
  const dangerObs = observation({
    health: 4,
    food: 3,
    inventory: { oak_log: 8, crafting_table: 1 },
    time: { ticks: 18000, phase: 'night', night: true },
    entities: [{ type: 'creeper', kind: 'mob', hostile: true, distance: 4.2, position: { x: 4, y: 63, z: 0 } }],
  });
  const danger = tick({ obs: dangerObs, plan, completed, offered });
  assert.equal(danger.governor.mode, 'emergency');
  assert.equal(danger.governor.rule, 'low_health_near_hostile');
  assert.notEqual(danger.objective, plan.objective, 'obiettivo del piano sovrascritto');
  assert.ok(/escape immediate danger/i.test(danger.objective));
  assert.equal(danger.active.skill.id, 'escape_hostile');
  assert.equal(danger.active.source, 'governor');
  // Il filtro emergenza toglie tutto ciò che non serve a sopravvivere. Il
  // `collect_drop` resta perché in questo stato vale anche `no_food_available`
  // (cibo 3 e niente di mangiabile addosso): raccogliere cibo è sopravvivenza,
  // e la scala dei bisogni continua a mettere `flee` davanti a tutto.
  assert.deepEqual(danger.restricted.options.map(o => o.key).sort(), ['collect_drop', 'eat', 'flee']);
  for (const option of danger.restricted.options) assert.ok(offered.includes(option), 'nessuna key inventata');
  // La progressione resta memorizzata: il milestone è ancora food_and_safety.
  assert.equal(danger.milestone.milestone, 'food_and_safety');

  // 5. Recupero: il bot è di nuovo in salute e al sicuro. Il governor torna
  //    normale e la progressione riprende dallo stesso milestone.
  const recoveredObs = observation({ health: 18, food: 18, inventory: { oak_log: 8, crafting_table: 1 } });
  const resume = tick({ obs: recoveredObs, plan, completed, offered });
  assert.equal(resume.governor.mode, 'normal');
  assert.equal(resume.objective, plan.objective, 'obiettivo di progressione ripristinato');
  assert.equal(resume.milestone.milestone, 'food_and_safety', 'nessun riavvio da wood');
  assert.equal(resume.active.skill.id, 'obtain_food');
  assert.equal(resume.active.source, 'plan');

  // 6. Cibo ottenuto, poi la notte successiva: verifica e completamento.
  const foodObs = observation({ health: 18, food: 18, inventory: { oak_log: 8, crafting_table: 1, baked_potato: 1 } });
  assert.equal(verifySkill(skills.get('obtain_food'), recoveredObs, foodObs).status, 'success');
  completed.add('food_and_safety');
  const nightPlan = planFor(resolveMilestone(graph, { goal: 'first_night', observation: foodObs, completed }));
  assert.equal(nightPlan.skill, 'first_night');
  const dawn = verifySkill(skills.get('first_night'), foodObs, observation({ time: { ticks: 1000, phase: 'day', night: false } }), { context: { sawNight: true } });
  assert.equal(dawn.status, 'success');
  completed.add('first_night');
  const done = resolveMilestone(graph, { goal: 'first_night', observation: foodObs, completed });
  assert.equal(done.status, 'met');
});

test('skill intents reorder the controller options without inventing keys', () => {
  const offered = [
    { key: 'craft_oak_planks', description: 'Craft planks' },
    { key: 'goto_waypoint', description: 'Go to waypoint' },
    { key: 'mine_oak_log', description: 'Mine oak_log at ... (3.0 blocks away)' },
    { key: 'collect_drop', description: 'Collect the drop' },
    { key: 'wait', description: 'Wait' },
  ];
  const ranked = rankOptions(offered, { targets: {}, preferredIntents: skillPreferredIntents(skills.get('acquire_wood')) });
  assert.deepEqual(ranked.map(o => o.key), ['collect_drop', 'mine_oak_log', 'goto_waypoint', 'craft_oak_planks', 'wait']);
  const filtered = filterOptions(offered, [], { max: 12, targets: {}, preferredIntents: ['mine'] });
  for (const option of filtered.options) assert.ok(offered.includes(option), 'solo key offerte dal harness');
});

test('emergency filtering can never leave the decision model without options', () => {
  const offered = [{ key: 'mine_stone', description: 'Mine stone' }, { key: 'wait', description: 'Wait' }];
  const governor = evaluateSurvival(observation({
    health: 2,
    entities: [{ type: 'zombie', kind: 'mob', hostile: true, distance: 2, position: { x: 2, y: 63, z: 0 } }],
  }), { rules });
  assert.equal(governor.mode, 'emergency');
  const restricted = filterOptionsForGovernor(offered, governor);
  assert.ok(restricted.options.length > 0);
  assert.equal(restricted.filtered, false);
  assert.equal(restricted.reason, 'no_allowed_option');
});

test('the compact survival payload is small and actionable for the planner', () => {
  const summary = summarizeSurvival(evaluateSurvival(observation({
    food: 5,
    inventory: { bread: 1 },
  }), { rules }));
  assert.deepEqual(summary.needs, ['eat', 'continue_progression']);
  assert.equal(summary.mode, 'caution');
  assert.ok(summary.risk > 0 && summary.risk <= 100);
  assert.ok(JSON.stringify(summary).length < 400, 'payload compatto');
});
