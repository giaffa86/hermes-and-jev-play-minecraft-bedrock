import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOpportunity, opportunityGoalFor, INTERRUPTIBLE_SOURCES, DEFAULT_OPPORTUNITY_COOLDOWN_MS } from '../opportunity-goals.mjs';
import { GOAL_SOURCE, SOURCE_PRIORITY } from '../goal-manager.mjs';
import { WORLD_EVENTS } from '../world-events.mjs';
import { oreValue, oreDrop, itemValue, bestTargetValue } from '../ore-value.mjs';

const oreEvent = (name, { distance = 6, position = { x: 10, y: 40, z: -8 }, harvestable = true } = {}) => ({
  type: WORLD_EVENTS.VALUABLE_ORE_SEEN,
  severity: 'notice',
  dedupKey: `ore:${name}@${position.x},${position.y},${position.z}`,
  data: { ore: name, value: oreValue(name), drop: oreDrop(name), position, distance, harvestable },
});

const goal = (targets = { dirt: 4 }, source = GOAL_SOURCE.CURRICULUM) => ({
  source,
  plan: { targets, objective: 'collect dirt', waypoint: null },
});

test('ore-value table: values, drops and wood baseline', () => {
  assert.equal(oreValue('diamond_ore'), 100);
  assert.equal(oreValue('deepslate_diamond_ore'), 100);
  assert.equal(oreDrop('iron_ore'), 'raw_iron');
  assert.equal(oreValue('stone'), 0);
  assert.equal(itemValue('raw_iron'), 15);
  assert.equal(itemValue('oak_log'), 3);
  assert.equal(itemValue('birch_planks'), 3);
  assert.equal(itemValue('dirt'), 0);
  assert.equal(bestTargetValue({ dirt: 4, raw_iron: 2 }), 15);
});

test('a non-event yields no opportunity', () => {
  assert.deepEqual(evaluateOpportunity(null), { eligible: false, reason: 'not_an_event', spec: null });
  assert.equal(evaluateOpportunity({ type: 'LOW_HEALTH' }).reason, 'unsupported_event');
});

test('a valuable vein suspends a curriculum goal and carries a bounded plan', () => {
  const event = oreEvent('diamond_ore');
  const { eligible, spec } = evaluateOpportunity(event, { currentGoal: goal() });
  assert.equal(eligible, true);
  assert.equal(spec.type, 'mine_opportunity');
  assert.equal(spec.priority, SOURCE_PRIORITY[GOAL_SOURCE.OPPORTUNITY]);
  assert.equal(spec.plan.opportunity, true);
  assert.deepEqual(spec.plan.targets, { diamond: 1 });
  assert.deepEqual(spec.plan.waypoint, { x: 10, z: -8 });
  assert.equal(spec.plan.notes, `opportunity:${WORLD_EVENTS.VALUABLE_ORE_SEEN}`);
  assert.equal(spec.parameters.ore, 'diamond_ore');
  assert.equal(spec.parameters.value, 100);
  assert.equal(spec.parameters.heldBefore, 0);
});

test('the opportunity priority sits between world events and the curriculum', () => {
  assert.ok(SOURCE_PRIORITY[GOAL_SOURCE.OPPORTUNITY] < SOURCE_PRIORITY[GOAL_SOURCE.WORLD_EVENT]);
  assert.ok(SOURCE_PRIORITY[GOAL_SOURCE.OPPORTUNITY] > SOURCE_PRIORITY[GOAL_SOURCE.CURRICULUM]);
  assert.ok(SOURCE_PRIORITY[GOAL_SOURCE.OPPORTUNITY] < SOURCE_PRIORITY[GOAL_SOURCE.CHAT]);
});

test('copper target + iron vein: the better ore is taken, then the parent resumes', () => {
  const { eligible, spec, targetValue, value } = evaluateOpportunity(oreEvent('iron_ore'), {
    currentGoal: goal({ raw_copper: 4 }),
  });
  assert.equal(eligible, true);
  assert.equal(value, 15);
  assert.equal(targetValue, 8);
  assert.deepEqual(spec.plan.targets, { raw_iron: 1 });
});

test('coal counts as an opportunity (scarce early), and copper beats coal', () => {
  // Coal is the cheapest ore but still worth seizing: a dirt goal does not beat it.
  assert.equal(evaluateOpportunity(oreEvent('coal_ore'), { currentGoal: goal() }).eligible, true);
  // Copper is worth more than a coal target, so it interrupts the coal goal.
  assert.equal(evaluateOpportunity(oreEvent('copper_ore'), { currentGoal: goal({ coal: 6 }) }).eligible, true);
  // The other way round the vein is cheaper than the target: skip it.
  assert.equal(evaluateOpportunity(oreEvent('coal_ore'), { currentGoal: goal({ raw_copper: 6 }) }).reason, 'too_cheap');
  // Wood is the baseline of the early game; coal still wins.
  assert.equal(evaluateOpportunity(oreEvent('coal_ore'), { currentGoal: goal({ oak_log: 8 }) }).eligible, true);
});

test('a stocked-up drop stops triggering the relative path, but not a diamond', () => {
  const coal = evaluateOpportunity(oreEvent('coal_ore'), { currentGoal: goal(), holdings: { coal: 16 } });
  assert.equal(coal.eligible, false);
  assert.equal(coal.reason, 'stocked_up');
  assert.equal(coal.held, 16);
  const diamond = evaluateOpportunity(oreEvent('diamond_ore'), { currentGoal: goal(), holdings: { diamond: 64 } });
  assert.equal(diamond.eligible, true, 'gold and above ignore the stock cap');
});

test('holdings drive the success target: one more than the one held now', () => {
  const { spec } = evaluateOpportunity(oreEvent('diamond_ore'), { currentGoal: goal(), holdings: { diamond: 2 } });
  assert.deepEqual(spec.plan.targets, { diamond: 3 });
  assert.equal(spec.parameters.heldBefore, 2);
});

test('unharvestable, far, dangerous and nested chances are refused', () => {
  const base = { currentGoal: goal() };
  assert.equal(evaluateOpportunity(oreEvent('diamond_ore', { harvestable: false }), base).reason, 'unharvestable');
  assert.equal(evaluateOpportunity(oreEvent('diamond_ore', { distance: 30 }), base).reason, 'out_of_range');
  assert.equal(evaluateOpportunity(oreEvent('diamond_ore'), { ...base, danger: true }).reason, 'danger');
  const nested = { source: GOAL_SOURCE.OPPORTUNITY, plan: { targets: { diamond: 1 }, opportunity: true } };
  assert.equal(evaluateOpportunity(oreEvent('diamond_ore'), { currentGoal: nested }).reason, 'nested_opportunity');
});

test('only chosen work is interruptible: a chat order or an emergency is not', () => {
  assert.deepEqual(INTERRUPTIBLE_SOURCES, [GOAL_SOURCE.CURRICULUM, GOAL_SOURCE.AUTONOMOUS]);
  assert.equal(evaluateOpportunity(oreEvent('diamond_ore'), { currentGoal: goal({}, GOAL_SOURCE.CHAT) }).reason, 'not_interruptible');
  assert.equal(evaluateOpportunity(oreEvent('diamond_ore'), { currentGoal: goal({}, GOAL_SOURCE.EMERGENCY) }).reason, 'not_interruptible');
  assert.equal(evaluateOpportunity(oreEvent('diamond_ore'), { currentGoal: goal({}, GOAL_SOURCE.AUTONOMOUS) }).eligible, true);
  // No current goal (idle session): nothing to suspend, so it is still eligible.
  assert.equal(evaluateOpportunity(oreEvent('diamond_ore')).eligible, true);
});

test('a goal that is almost finished is not interrupted', () => {
  assert.equal(evaluateOpportunity(oreEvent('diamond_ore'), { currentGoal: goal(), progress: 0.95 }).reason, 'goal_almost_done');
  assert.equal(evaluateOpportunity(oreEvent('diamond_ore'), { currentGoal: goal(), progress: 0.5 }).eligible, true);
});

test('opportunityGoalFor stamps the source, keeps a parent and honours the cooldown', () => {
  const parent = goal();
  const event = oreEvent('diamond_ore');
  const attempts = new Map();
  const first = opportunityGoalFor(event, { parentGoal: parent, currentGoal: parent, attempts });
  assert.equal(first.source, GOAL_SOURCE.OPPORTUNITY);
  assert.equal(first.parentGoal, parent);
  assert.equal(first.eventType, WORLD_EVENTS.VALUABLE_ORE_SEEN);
  assert.equal(first.dedupKey, event.dedupKey);
  attempts.set(event.dedupKey, Date.now());
  assert.equal(opportunityGoalFor(event, { parentGoal: parent, currentGoal: parent, attempts }), null);
  const later = opportunityGoalFor(event, {
    parentGoal: parent,
    currentGoal: parent,
    attempts,
    now: Date.now() + DEFAULT_OPPORTUNITY_COOLDOWN_MS + 1,
  });
  assert.ok(later, 'after the cooldown the same vein is worth another try');
});

test('a refused chance leaves the attempts map untouched', () => {
  const attempts = new Map();
  assert.equal(opportunityGoalFor(oreEvent('coal_ore'), { currentGoal: goal({ raw_copper: 6 }), attempts }), null);
  assert.equal(attempts.size, 0);
});
