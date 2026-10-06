// Unit test del Survival Intelligence Layer: perception, rischio, bisogni,
// regole dichiarative e governor. Tutto puro: nessun server Minecraft.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  perceive, threatSeverity, assessRisk, deriveNeeds, evaluateSurvival, summarizeSurvival,
  loadSurvivalRules, validateRules, evaluateCondition, ruleMatches, keyMatchesIntents,
  filterOptionsForGovernor, optionIntents,
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

test('an armed bot keeps fight among the emergency intents', () => {
  // La soglia di emergenza e' anche la soglia di ammissione degli intenti
  // (`EMERGENCY_PRIORITY`): finche' nessuna regola >= 95 nominava `fight`,
  // `attack_<tipo>` spariva dalle opzioni in ogni emergenza, anche con un ostile
  // addosso e una spada in zaino. Scenario live 06/10/2026: vita bassa piu'
  // scheletro a distanza di mischia.
  const skeleton = { type: 'skeleton', kind: 'mob', hostile: true, distance: 4, position: { x: 4, y: 63, z: 0 } };
  const armed = evaluateSurvival(observation({ health: 8, inventory: { iron_sword: 1 }, entities: [skeleton] }), { rules });
  assert.equal(armed.mode, 'emergency');
  assert.ok(armed.matchedRules.includes('hostile_melee_armed'), 'con un\'arma in zaino la regola di mischia si accende');
  assert.ok(armed.allowedIntents.includes('fight'), 'con un\'arma in zaino si può rispondere');
  assert.ok(armed.allowedIntents.includes('escape'));

  const unarmed = evaluateSurvival(observation({ health: 8, entities: [skeleton] }), { rules });
  assert.equal(unarmed.mode, 'emergency');
  assert.ok(!unarmed.allowedIntents.includes('fight'), 'senza arma l\'emergenza resta una fuga');

  // A vita piena l'aggiunta non cambia nulla per chi non ha un'arma: resta la
  // regola di cautela preesistente (escape/fight, nessuna restrizione di intenti).
  const unarmedFullHealth = evaluateSurvival(observation({ entities: [skeleton] }), { rules });
  assert.equal(unarmedFullHealth.mode, 'caution');
  assert.equal(unarmedFullHealth.rule, 'hostile_close');
  assert.equal(unarmedFullHealth.allowedIntents, null);
});

test('the shield is still usable in an emergency (its keys mean shelter)', () => {
  // Visto live il 06/10/2026: frecce di uno scheletro, vita sotto 10, e lo scudo
  // non compariva fra le opzioni perché `raise_shield` non aveva un intento e il
  // filtro lo trattava come `unknown`.
  const verdict = evaluateSurvival(observation({
    health: 8,
    entities: [{ type: 'skeleton', kind: 'mob', hostile: true, distance: 6, position: { x: 6, y: 63, z: 0 } }],
  }), { rules });
  assert.equal(verdict.mode, 'emergency');
  assert.equal(verdict.rule, 'low_health_near_hostile');
  for (const key of ['raise_shield', 'equip_shield', 'lower_shield']) {
    assert.ok(optionIntents(key).includes('shelter'), `${key} resta una difesa in emergenza`);
  }
  const options = [
    { key: 'raise_shield', description: 'x' },
    { key: 'flee', description: 'x' },
    { key: 'mine_dirt', description: 'x' },
    { key: 'wait', description: 'x' },
  ];
  const restricted = filterOptionsForGovernor(options, verdict);
  const keys = restricted.options.map(option => option.key);
  assert.ok(keys.includes('raise_shield'), 'lo scudo non si toglie proprio quando arriva la freccia');
  assert.ok(keys.includes('flee'));
  assert.ok(!keys.includes('mine_dirt'));
  assert.ok(!keys.includes('wait'), 'wait non è mai una risposta in emergenza');
  assert.deepEqual(restricted.removed.map(removed => removed.key), ['mine_dirt', 'wait']);
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

// ---- M3: dentro una cascata ---------------------------------------------------------

test('il governor riconosce di essere dentro una cascata e la tiene fra gli intenti utili', () => {
  const inFall = (onWaterfall, extra = {}) => evaluateSurvival(observation({
    fluids: {
      inWater: true, headInWater: false, air: 300, airSeconds: 15, waterBreathing: false,
      onWaterfall,
      water: { count: 4 }, lava: { count: 0 }, lavaDistance: null,
    },
    ...extra,
  }), { rules });

  const ride = inFall(true);
  assert.equal(ride.rule, 'ride_waterfall');
  assert.ok(ride.matchedRules.includes('ride_waterfall'));
  assert.ok(ride.preferredSkills.includes('surface_for_air'));
  // La regola è di contesto, non di pericolo: non alza la modalità e non
  // sostituisce l'obiettivo (l'obiettivo arriva solo in cautela/emergenza).
  assert.equal(ride.mode, 'normal');
  assert.equal(ride.overrideObjective, null);

  // Fuori dalla colonna la regola non esiste: nessun contesto inventato.
  const dry = inFall(false);
  assert.notEqual(dry.rule, 'ride_waterfall');
  assert.ok(!dry.matchedRules.includes('ride_waterfall'));

  // La regola è di contesto (priorità 54): non entra mai fra quelle di
  // emergenza, quindi non allarga `allowedIntents` — le azioni di colonna
  // arrivano al planner perché fuori dall'emergenza gli intenti non sono
  // ristretti. Il vocabolario però c'è: se un domani una regola di emergenza
  // chiedesse `descend`, `descend_waterfall` sarebbe una chiave coerente.
  const emergency = inFall(true, { health: 2 });
  assert.equal(emergency.mode, 'emergency');
  assert.equal(emergency.allowedIntents.includes('descend'), false);
  assert.equal(keyMatchesIntents('descend_waterfall', ['descend', 'travel']), true);
  assert.equal(keyMatchesIntents('climb_waterfall', ['ascend']), true);
  assert.equal(keyMatchesIntents('use_bubble_column', ['fluid']), true);
  assert.equal(keyMatchesIntents('mine_dirt', ['descend', 'travel']), false);

  // Un'osservazione senza il campo non accende la regola (ignoto = no).
  const unknown = evaluateSurvival(observation({ fluids: { inWater: true, headInWater: false } }), { rules });
  assert.notEqual(unknown.rule, 'ride_waterfall');

  // La condizione è nel vocabolario chiuso e si può usare da una regola nuova.
  assert.equal(evaluateCondition('onWaterfall', true, perceive(observation({ fluids: { onWaterfall: true } }))), true);
  assert.equal(evaluateCondition('onWaterfall', true, perceive(observation({ fluids: {} }))), false);
  assert.equal(evaluateCondition('onWaterfall', false, perceive(observation({}))), true, 'ignoto = non dentro una cascata');
});

// ---- M4: lava addosso, lava vicina e le azioni dedicate -----------------------------

test('il governor distingue la lava addosso da quella vicina e il vocabolario M4 resta coerente', () => {
  const lava = (fluids, extra = {}) => evaluateSurvival(observation({
    fluids: {
      inWater: false, headInWater: false, inLava: false, lavaDistance: 0.7,
      air: 300, airSeconds: 15, waterBreathing: false, water: { count: 0 }, lava: { count: 2 },
      ...fluids,
    },
    ...extra,
  }), { rules });

  // Lava addosso: priorità 100 ⇒ emergenza, con l'obiettivo che dice di uscire.
  const contact = lava({ inLava: true, lavaDistance: 0 });
  assert.equal(contact.rule, 'lava_contact');
  assert.equal(contact.mode, 'emergency');
  assert.match(contact.overrideObjective, /Get out of the lava immediately/);
  assert.ok(contact.allowedIntents.includes('escape'));
  assert.ok(keyMatchesIntents('move_to_safe', contact.allowedIntents), 'la fuga M4 è coerente con gli intenti di emergenza');
  assert.ok(keyMatchesIntents('avoid_lava', contact.allowedIntents));

  // Lava vicina ma non addosso: priorità 88 ⇒ cautela, non emergenza.
  const near = lava({ lavaDistance: 2.5 });
  assert.equal(near.rule, 'lava_near');
  assert.equal(near.mode, 'caution');

  // Lontana: nessuna regola di lava e nessun intento di fuga forzato.
  const far = lava({ lavaDistance: 18 });
  assert.ok(!far.matchedRules.includes('lava_contact'));
  assert.ok(!far.matchedRules.includes('lava_near'));

  // Vocabolario delle nuove chiavi: `cross_lava` è un viaggio, non una fuga.
  assert.equal(keyMatchesIntents('move_to_safe', ['escape']), true);
  assert.equal(keyMatchesIntents('cross_lava', ['travel', 'fluid']), true);
  assert.equal(keyMatchesIntents('cross_lava', ['escape']), false);
  assert.equal(keyMatchesIntents('move_to_safe', ['fluid']), false);

  // Le condizioni della lava sono nel vocabolario chiuso e mappano la percezione.
  // `lavaWithin` è l'alias di `lavaDistance` nella percezione: la regola
  // dichiarativa parla di "lava entro N blocchi".
  assert.equal(evaluateCondition('inLava', true, perceive(observation({ fluids: { inLava: true } }))), true);
  assert.equal(evaluateCondition('inLava', true, perceive(observation({ fluids: {} }))), false);
  assert.equal(evaluateCondition('lavaWithin', 4, perceive(observation({ fluids: { lavaDistance: 2.5 } }))), true);
  assert.equal(evaluateCondition('lavaWithin', 4, perceive(observation({ fluids: { lavaDistance: 9 } }))), false);
});
