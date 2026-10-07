// R1: la forma del piano (`subgoal` + `steps[]`) e' derivata dagli artefatti
// dichiarativi, non inventata dal modello; e nessuno step nomina una key di
// `/options`, che resta una scelta del controller a runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { derivePlanShape, withPlanShape, planStep } from '../plan-shape.mjs';
import { loadGameplaySkills } from '../survival/skills.mjs';
import { loadCircuits } from '../circuits.mjs';
import { CRITERIA_KEYS } from '../survival/verify.mjs';
import { declaredOptionVocabulary } from '../survival/intents.mjs';

const skills = loadGameplaySkills();
const circuits = loadCircuits();
const milestones = {};
const CRITERIA = new Set(CRITERIA_KEYS);

function findSkill (predicate) {
  return [...skills.values()].find(predicate);
}

test('a plan with a known skill carries the skill description as subgoal and one step', () => {
  const skill = findSkill(def => def.category === 'survival');
  const plan = { objective: 'survive the first night', skill: skill.id, targets: {} };
  const shape = derivePlanShape(plan, { skills, milestones });
  assert.equal(shape.subgoal, skill.description);
  assert.equal(shape.steps.length, 1);
  const step = shape.steps[0];
  assert.equal(step.id, skill.id);
  assert.equal(step.skill, skill.id);
  assert.equal(step.circuit, null);
});

test('a step verifies only through criteria the verifier knows', () => {
  for (const skill of skills.values()) {
    const step = planStep({ objective: 'x', skill: skill.id }, skills);
    assert.ok(step.verify.every(name => CRITERIA.has(name)), `${skill.id}: ${step.verify.join(',')}`);
    assert.deepEqual(step.verify, [...step.verify].sort());
  }
});

test('a circuit skill names its circuit; a plan without a skill names none', () => {
  const circuitSkill = findSkill(def => def.success?.circuitBuilt?.id);
  assert.ok(circuitSkill, 'expected at least one circuit skill');
  assert.equal(planStep({ objective: 'x', skill: circuitSkill.id }, skills).circuit, circuitSkill.success.circuitBuilt.id);
  assert.ok(circuits.has(circuitSkill.success.circuitBuilt.id));
  assert.equal(planStep({ objective: 'x' }, skills).circuit, null);
});

test('a step never carries an action field: it names skills and criteria only', () => {
  const optionKeys = new Set(declaredOptionVocabulary().keys.map(entry => entry.key));
  for (const skill of skills.values()) {
    const step = planStep({ objective: 'x', skill: skill.id }, skills);
    assert.deepEqual(Object.keys(step).sort(), ['circuit', 'id', 'skill', 'targets', 'verify']);
    for (const name of Object.keys(step)) assert.ok(!optionKeys.has(name), `field is an option key: ${name}`);
    // `verify` e' l'unico posto dove vive un criterio: deve essere vocabolario
    // del verifier, mai una key di /options.
    for (const name of step.verify) assert.ok(!optionKeys.has(name), `verify carries an option key: ${name}`);
  }
});

test('derivePlanShape leaves objective untouched and only derives subgoal + steps', () => {
  const plan = { objective: 'gather iron', skill: null, targets: { iron_ore: 3 } };
  const shape = derivePlanShape(plan, { skills, milestones });
  assert.deepEqual(Object.keys(shape).sort(), ['steps', 'subgoal']);
  assert.equal(plan.objective, 'gather iron');
});

test('a replan keeps the objective and changes only the subgoal', () => {
  const before = withPlanShape({ objective: 'first night', skill: 'obtain_food' }, { skills, milestones });
  const after = withPlanShape({ objective: 'first night', skill: 'stone_age' }, { skills, milestones });
  assert.equal(before.objective, after.objective);
  assert.notEqual(before.subgoal, after.subgoal);
  assert.notDeepEqual(before.steps, after.steps);
});

test('withPlanShape never overwrites a subgoal or steps the producer already set', () => {
  const explicit = { objective: 'x', subgoal: 'hand-written', steps: [{ id: 's0', skill: null, circuit: null, targets: {}, verify: [] }] };
  const shaped = withPlanShape(explicit, { skills, milestones });
  assert.equal(shaped.subgoal, 'hand-written');
  assert.deepEqual(shaped.steps, explicit.steps);
});

test('a plan with no skill still carries one step and the plan targets', () => {
  const shaped = withPlanShape({ objective: 'walk to the waypoint', targets: { dirt: 4 } }, { skills, milestones });
  assert.equal(shaped.steps.length, 1);
  assert.deepEqual(shaped.steps[0].targets, { dirt: 4 });
  assert.equal(shaped.steps[0].verify.length, 0);
});

test('a sentinel plan (no objective) is left untouched', () => {
  assert.deepEqual(withPlanShape({ met: true }, { skills, milestones }), { met: true });
});
