// Unit test del Survival Intelligence Layer: perception, rischio, bisogni,
// regole dichiarative e governor. Tutto puro: nessun server Minecraft.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  perceive, threatSeverity, assessRisk, deriveNeeds, evaluateSurvival, summarizeSurvival,
  loadSurvivalRules, validateRules, evaluateCondition, ruleMatches,
} from '../survival/index.mjs';

const RULES_URL = new URL('../knowledge/survival-rules.json', import.meta.url);
const rules = await loadSurvivalRules(RULES_URL);

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
    ...overrides,
  };
}

// ---- perception ----------------------------------------------------------------------

test('perception classifies threats by type and distance', () => {
  assert.equal(threatSeverity('creeper', 4.2), 'critical');
  assert.equal(threatSeverity('creeper', 8), 'high');
  assert.equal(threatSeverity('creeper', 12), 'medium');
  assert.equal(threatSeverity('creeper', 20), 'low');
  assert.equal(threatSeverity('zombie', 2.5), 'critical');
  assert.equal(threatSeverity('zombie', 12), 'medium');
  assert.equal(threatSeverity('skeleton', 3.5), 'critical');
  assert.equal(threatSeverity('minecraft:spider', 10), 'medium');
});

test('perception derives food, tools, armor and bed from the observation', () => {
  const p = perceive(observation({
    health: 7,
    food: 5,
    inventory: { cooked_beef: 2, stone_pickaxe: 1, wooden_sword: 1, iron_helmet: 1, oak_log: 3 },
    bed: { position: { x: 2, y: 63, z: 2 }, distance: 3 },
    heldDurability: { damage: 58, max: 59 },
    entities: [{ type: 'creeper', kind: 'mob', hostile: true, distance: 4.2, position: { x: 4, y: 63, z: 0 } }],
  }));
  assert.equal(p.health, 7);
  assert.equal(p.bestFood, 'cooked_beef');
  assert.equal(p.hasFood, true);
  assert.equal(p.pickaxe, 'stone_pickaxe');
  assert.equal(p.weapon, 'wooden_sword');
  assert.equal(p.armorCount, 1);
  assert.equal(p.bedAvailable, true);
  assert.equal(p.bedDistance, 3);
  assert.equal(p.nearestThreat.type, 'creeper');
  assert.equal(p.nearestThreat.severity, 'critical');
  assert.equal(p.inventorySummary.logs, 3);
});

// ---- rischio -------------------------------------------------------------------------

test('risk is critical for low health next to a creeper at night', () => {
  const risk = assessRisk(perceive(observation({
    health: 4,
    food: 3,
    entities: [{ type: 'creeper', kind: 'mob', hostile: true, distance: 4.2, position: { x: 4, y: 63, z: 0 } }],
    time: { ticks: 18000, phase: 'night', night: true },
  })));
  assert.equal(risk.level, 'critical');
  assert.equal(risk.score, 100);
  for (const reason of ['critical_health', 'food_low', 'hostile_critical', 'night', 'no_shelter', 'low_health_near_hostile']) {
    assert.ok(risk.reasons.includes(reason), `reason ${reason}`);
  }
});

test('risk is none for a healthy bot on a safe day', () => {
  const risk = assessRisk(perceive(observation()));
  assert.equal(risk.level, 'none');
  assert.equal(risk.score, 0);
  assert.deepEqual(risk.reasons, []);
});

test('risk adds night without shelter and ignores threats while sleeping', () => {
  const night = assessRisk(perceive(observation({ time: { ticks: 18000, phase: 'night', night: true } })));
  assert.ok(night.reasons.includes('night'));
  assert.ok(night.reasons.includes('no_shelter'));
  assert.equal(night.level, 'low');
  const sleeping = assessRisk(perceive(observation({
    sleeping: true,
    entities: [{ type: 'zombie', kind: 'mob', hostile: true, distance: 2, position: { x: 2, y: 63, z: 0 } }],
  })));
  assert.equal(sleeping.level, 'none');
});

// ---- bisogni -------------------------------------------------------------------------

test('hunger while safe produces the eat need, missing food produces obtain_food', () => {
  const eating = deriveNeeds(perceive(observation({ food: 10, inventory: { bread: 1 } })), { level: 'low' });
  assert.ok(eating.includes('eat'));
  const hungryNoFood = deriveNeeds(perceive(observation({ food: 10 })), { level: 'low' });
  assert.ok(hungryNoFood.includes('obtain_food'));
  assert.ok(!hungryNoFood.includes('eat'));
});

test('needs order survival before progression and add shelter at night', () => {
  const needs = deriveNeeds(perceive(observation({
    health: 4,
    food: 3,
    time: { ticks: 18000, phase: 'night', night: true },
    entities: [{ type: 'creeper', kind: 'mob', hostile: true, distance: 4, position: { x: 4, y: 63, z: 0 } }],
  })), { level: 'critical' });
  assert.deepEqual(needs.slice(0, 3), ['survive', 'escape', 'heal']);
  assert.ok(needs.includes('shelter'));
  assert.ok(!needs.includes('continue_progression'));
  const calm = deriveNeeds(perceive(observation()), { level: 'none' });
  assert.deepEqual(calm, ['continue_progression']);
});

// ---- regole --------------------------------------------------------------------------

test('the shipped survival rules are valid and cover the core situations', () => {
  assert.deepEqual(validateRules(rules), []);
  const ids = rules.map(rule => rule.id);
  for (const id of ['low_food', 'night_unprepared', 'creeper_immediate', 'low_health_near_hostile', 'dead']) {
    assert.ok(ids.includes(id), `rule ${id}`);
  }
});

test('rule validation rejects unknown conditions and bad types', () => {
  const errors = validateRules([
    { id: 'bad', priority: 10, when: { nope: true } },
    { id: 'bad2', priority: 'high', when: { night: 'yes' } },
    { id: 'bad', priority: 20, when: {} },
  ]);
  assert.ok(errors.some(error => error.includes('unknown condition "nope"')));
  assert.ok(errors.some(error => error.includes('priority must be a number')));
  assert.ok(errors.some(error => error.includes('"night" must be a boolean')));
  assert.ok(errors.some(error => error.includes('duplicate rule id')));
});

test('rule conditions evaluate against perception', () => {
  const p = perceive(observation({
    health: 5,
    food: 4,
    time: { ticks: 18000, phase: 'night', night: true },
    entities: [{ type: 'creeper', kind: 'mob', hostile: true, distance: 4, position: { x: 4, y: 63, z: 0 } }],
  }));
  assert.equal(evaluateCondition('healthMax', 8, p), true);
  assert.equal(evaluateCondition('foodMax', 6, p), true);
  assert.equal(evaluateCondition('night', true, p), true);
  assert.equal(evaluateCondition('bedAvailable', false, p), true);
  assert.equal(evaluateCondition('hostileWithin', 5, p), true);
  assert.equal(evaluateCondition('hostileWithin', 3, p), false);
  assert.equal(evaluateCondition('hostileTypeWithin', { creeper: 6 }, p), true);
  assert.equal(evaluateCondition('hostileTypeWithin', { skeleton: 6 }, p), false);
  assert.equal(evaluateCondition('hostileSeverityAtLeast', 'high', p), true);
  assert.throws(() => evaluateCondition('unknown_key', 1, p), /unknown survival condition/);
  assert.equal(ruleMatches({ when: { healthMax: 8, foodMax: 6 } }, p), true);
  assert.equal(ruleMatches({ when: { healthMax: 8, foodMax: 2 } }, p), false);
});

// ---- governor ------------------------------------------------------------------------

test('governor interrupts diamond progression for low health near a hostile', () => {
  const result = evaluateSurvival(observation({
    health: 4,
    food: 3,
    entities: [{ type: 'creeper', kind: 'mob', hostile: true, distance: 4.2, position: { x: 4, y: 63, z: 0 } }],
    time: { ticks: 18000, phase: 'night', night: true },
  }), { rules });
  assert.equal(result.mode, 'emergency');
  assert.equal(result.rule, 'low_health_near_hostile');
  assert.equal(result.risk.level, 'critical');
  assert.ok(result.overrideObjective.match(/escape immediate danger/i));
  for (const intent of ['escape', 'eat', 'heal', 'shelter']) assert.ok(result.allowedIntents.includes(intent));
  assert.ok(!result.allowedIntents.includes('fight'));
  assert.equal(result.preferredSkills[0], 'escape_hostile');
  assert.ok(result.needs.includes('survive'));
});

test('governor is caution (not emergency) when hungry but safe with food', () => {
  const result = evaluateSurvival(observation({ food: 5, inventory: { bread: 2 } }), { rules });
  assert.equal(result.mode, 'caution');
  assert.equal(result.rule, 'low_food');
  assert.equal(result.overrideObjective, 'Eat available food to restore hunger before resuming progression.');
  assert.equal(result.allowedIntents, null);
  assert.deepEqual(result.preferredSkills, ['eat_available_food']);
  assert.ok(result.needs.includes('eat'));
});

test('governor does not override a healthy day with no threats', () => {
  const result = evaluateSurvival(observation({ inventory: { wooden_pickaxe: 1 } }), { rules });
  assert.equal(result.mode, 'normal');
  assert.equal(result.priority, 0);
  assert.equal(result.overrideObjective, null);
  assert.equal(result.allowedIntents, null);
  assert.deepEqual(result.needs, ['continue_progression']);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.rule, null);
});

test('governor treats a close creeper as an emergency even at full health', () => {
  const result = evaluateSurvival(observation({
    entities: [{ type: 'creeper', kind: 'mob', hostile: true, distance: 4.2, position: { x: 4, y: 63, z: 0 } }],
  }), { rules });
  assert.equal(result.mode, 'emergency');
  assert.equal(result.rule, 'creeper_immediate');
  assert.deepEqual(result.allowedIntents, ['escape', 'shelter']);
  assert.equal(result.preferredSkills[0], 'escape_hostile');
});

test('governor asks for shelter at night without a bed', () => {
  const result = evaluateSurvival(observation({ time: { ticks: 18000, phase: 'night', night: true } }), { rules });
  assert.equal(result.mode, 'caution');
  assert.equal(result.rule, 'night_unprepared');
  assert.ok(result.needs.includes('shelter'));
  assert.deepEqual(result.preferredSkills, ['emergency_shelter', 'first_night']);
});

test('governor prefers sleeping when a bed is available at night', () => {
  const result = evaluateSurvival(observation({
    time: { ticks: 18000, phase: 'night', night: true },
    bed: { position: { x: 2, y: 63, z: 2 }, distance: 3 },
  }), { rules });
  assert.equal(result.mode, 'caution');
  assert.equal(result.rule, 'night_with_bed');
  assert.ok(result.needs.includes('sleep'));
  assert.deepEqual(result.preferredSkills, ['first_night']);
});

test('governor while dead can only wait and has no override objective', () => {
  const result = evaluateSurvival(observation({ dead: true, health: 0 }), { rules });
  assert.equal(result.mode, 'emergency');
  assert.equal(result.rule, 'dead');
  assert.deepEqual(result.allowedIntents, ['wait']);
  assert.equal(result.overrideObjective, null);
});

test('summarizeSurvival returns the compact shape exposed by /observe', () => {
  const summary = summarizeSurvival(evaluateSurvival(observation({ food: 5, inventory: { bread: 1 } }), { rules }));
  assert.deepEqual(Object.keys(summary).sort(), ['level', 'mode', 'needs', 'overrideObjective', 'reasons', 'risk', 'rule']);
  assert.equal(summary.mode, 'caution');
  assert.equal(summary.risk, 18);
  assert.deepEqual(summary.reasons, ['food_low']);
});

// ---- M2: respirare sott'acqua --------------------------------------------------------

test('il governor non dichiara annegamento quando il respiro è attivo', () => {
  const wet = (waterBreathing) => observation({
    fluids: {
      inWater: true, headInWater: true, air: 4, airSeconds: 0.2,
      waterBreathing,
      water: { count: 3 }, lava: { count: 0 }, lavaDistance: null,
    },
  });

  const drowning = evaluateSurvival(wet({ active: false, sources: [], conduitsNear: 0 }), { rules });
  assert.equal(drowning.rule, 'drowning');
  assert.equal(drowning.mode, 'emergency');
  assert.ok(drowning.needs.includes('surface'));
  assert.ok(drowning.reasons.includes('drowning'));

  // Elmo di tartaruga o effetto `water_breathing`: l'acqua non toglie aria, quindi
  // né la regola né il bisogno né il punteggio di rischio scattano. Resta solo la
  // nota informativa.
  const held = evaluateSurvival(wet({ active: true, sources: [{ kind: 'armor', name: 'turtle_helmet' }], conduitsNear: 0 }), { rules });
  assert.equal(held.rule, null);
  assert.notEqual(held.mode, 'emergency');
  assert.ok(!held.needs.includes('surface'));
  assert.ok(held.reasons.includes('head_underwater'));
  assert.ok(!held.reasons.includes('drowning'));
  assert.ok(held.risk.score < drowning.risk.score);

  // Un'osservazione senza il campo resta prudente: ignoto = non respira.
  const unknown = evaluateSurvival(observation({ fluids: { inWater: true, headInWater: true, air: 4 } }), { rules });
  assert.equal(unknown.rule, 'drowning');
});
