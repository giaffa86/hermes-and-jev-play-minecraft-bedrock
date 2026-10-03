// Nether/End in Survival Intelligence (N0 di docs/wiki/nether.md): fuoco, magma,
// proiettili in arrivo e sguardo verso un enderman entrano in perception, rischio,
// bisogni e regole dichiarative. Tutto puro: nessun server Minecraft.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  perceive, perceiveNether, assessRisk, deriveNeeds, evaluateSurvival,
  loadSurvivalRules, evaluateCondition, validateRules, CONDITION_KEYS,
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

function netherObservation (nether, overrides = {}) {
  return observation({ dimension: 'nether', nether, ...overrides });
}

const quiet = {
  dimension: 'nether',
  isNether: true,
  isEnd: false,
  waterEvaporates: true,
  bedsExplode: true,
  inFire: false,
  headInFire: false,
  standingOnFire: false,
  fireDistance: null,
  magmaDistance: null,
  spawnerDistance: null,
  portalDistance: null,
  portals: { nether: { count: 0, nearest: null } },
  projectiles: [],
  projectile: null,
  enderman: null,
  hazard: { level: 'none', reasons: [] },
  ready: true,
};

// ---- perception --------------------------------------------------------------------

test('perceiveNether normalises the nether view and never invents danger', () => {
  const absent = perceiveNether(null);
  assert.equal(absent.known, false);
  assert.equal(absent.inFire, false);
  assert.equal(absent.projectileIncoming, false);
  assert.equal(absent.enderman, null);
  assert.equal(absent.portalCount, 0);

  const view = perceiveNether({
    ...quiet,
    inFire: true,
    fireDistance: 3,
    magmaDistance: 2,
    spawnerDistance: 7,
    portalDistance: 12,
    portals: { nether: { count: 2, nearest: null } },
    projectile: { type: 'fireball', distance: 6, missDistance: 0.4, timeToImpactMs: 900, speed: 12 },
    enderman: { type: 'enderman', distance: 4, angleDeg: 2, gazed: true },
  });
  assert.equal(view.known, true);
  assert.equal(view.inFire, true);
  assert.equal(view.fireWithin, 3);
  assert.equal(view.magmaWithin, 2);
  assert.equal(view.spawnerWithin, 7);
  assert.equal(view.portalCount, 2);
  assert.equal(view.projectileIncoming, true);
  assert.equal(view.projectile.timeToImpactMs, 900);
  assert.equal(view.enderman.gazed, true);
  assert.equal(view.gazeKnown, true);
});

test('perceive() exposes the nether view next to the fluids view', () => {
  const state = perceive(netherObservation({ ...quiet, fireDistance: 1 }));
  assert.equal(state.nether.known, true);
  assert.equal(state.nether.isNether, true);
  assert.equal(state.nether.fireWithin, 1);
  const overworld = perceive(observation());
  assert.equal(overworld.nether.known, false);
});

// ---- risk --------------------------------------------------------------------------

test('risk counts fire, magma, projectiles and the enderman gaze', () => {
  const clean = assessRisk(perceive(netherObservation(quiet)));
  assert.equal(clean.reasons.includes('on_fire'), false);
  assert.equal(clean.level, 'none');

  const burning = assessRisk(perceive(netherObservation({ ...quiet, inFire: true })));
  assert.equal(burning.reasons.includes('on_fire'), true);
  assert.ok(burning.score >= 50, `score ${burning.score}`);

  const adjacent = assessRisk(perceive(netherObservation({ ...quiet, fireDistance: 2 })));
  assert.equal(adjacent.reasons.includes('fire_adjacent'), true);

  const magma = assessRisk(perceive(netherObservation({ ...quiet, magmaDistance: 1 })));
  assert.equal(magma.reasons.includes('on_magma'), true);

  const shot = assessRisk(perceive(netherObservation({
    ...quiet,
    projectile: { type: 'fireball', distance: 8, missDistance: 0, timeToImpactMs: 800 },
  })));
  assert.equal(shot.reasons.includes('projectile_incoming'), true);
  assert.ok(shot.score >= 45, `score ${shot.score}`);

  const gaze = assessRisk(perceive(netherObservation({
    ...quiet,
    enderman: { type: 'enderman', distance: 4, angleDeg: 1, gazed: true },
  })));
  assert.equal(gaze.reasons.includes('gazed_at_enderman'), true);

  const spawner = assessRisk(perceive(netherObservation({ ...quiet, spawnerDistance: 5 })));
  assert.equal(spawner.reasons.includes('spawner_nearby'), true);
});

test('staring at an enderman in the overworld is not a risk', () => {
  const state = perceive(observation({
    nether: { ...quiet, isNether: false, dimension: 'overworld', enderman: { type: 'enderman', distance: 4, angleDeg: 1, gazed: true } },
  }));
  const risk = assessRisk(state);
  assert.equal(risk.reasons.includes('gazed_at_enderman'), false);
});

// ---- needs -------------------------------------------------------------------------

test('fire, magma under the feet and an inbound projectile all demand escape', () => {
  const burning = deriveNeeds(perceive(netherObservation({ ...quiet, inFire: true })), { level: 'high' });
  assert.equal(burning.includes('escape'), true);

  const magma = deriveNeeds(perceive(netherObservation({ ...quiet, magmaDistance: 1 })), { level: 'high' });
  assert.equal(magma.includes('escape'), true);

  const shot = deriveNeeds(perceive(netherObservation({
    ...quiet,
    projectile: { type: 'arrow', distance: 5, missDistance: 0.2, timeToImpactMs: 600 },
  })), { level: 'high' });
  assert.equal(shot.includes('escape'), true);

  // Fuoco lontano: nessun bisogno inventato.
  const far = deriveNeeds(perceive(netherObservation({ ...quiet, fireDistance: 9 })), { level: 'low' });
  assert.equal(far.includes('escape'), false);
});

// ---- rules -------------------------------------------------------------------------

test('the new conditions are declared and evaluated', () => {
  for (const key of ['inFire', 'fireWithin', 'magmaWithin', 'projectileIncoming', 'gazedAtEnderman', 'inNether', 'inEnd', 'spawnerWithin']) {
    assert.ok(CONDITION_KEYS.includes(key), `${key} missing from CONDITION_KEYS`);
  }
  const perception = perceive(netherObservation({
    ...quiet,
    inFire: true,
    fireDistance: 2,
    magmaDistance: 1,
    spawnerDistance: 3,
    projectile: { type: 'arrow', distance: 4, missDistance: 0, timeToImpactMs: 700 },
    enderman: { type: 'enderman', distance: 3, angleDeg: 1, gazed: true },
  }));
  assert.equal(evaluateCondition('inFire', true, perception), true);
  assert.equal(evaluateCondition('inNether', true, perception), true);
  assert.equal(evaluateCondition('inEnd', true, perception), false);
  assert.equal(evaluateCondition('projectileIncoming', true, perception), true);
  assert.equal(evaluateCondition('gazedAtEnderman', true, perception), true);
  assert.equal(evaluateCondition('fireWithin', 3, perception), true);
  assert.equal(evaluateCondition('fireWithin', 1, perception), false);
  assert.equal(evaluateCondition('magmaWithin', 1.5, perception), true);
  assert.equal(evaluateCondition('spawnerWithin', 8, perception), true);
  // Nessuna osservazione nether: le condizioni restano false, non `undefined`.
  const bare = perceive(observation());
  assert.equal(evaluateCondition('inFire', true, bare), false);
  assert.equal(evaluateCondition('projectileIncoming', true, bare), false);
  assert.equal(evaluateCondition('gazedAtEnderman', true, bare), false);
  assert.equal(evaluateCondition('fireWithin', 5, bare), false);
});

test('the rules file declares the nether rules and the governor picks them', () => {
  assert.deepEqual(validateRules(rules), []);
  const ids = rules.map(rule => rule.id);
  for (const id of ['on_fire', 'fire_adjacent', 'fire_near', 'magma_contact', 'projectile_incoming', 'gazed_at_enderman', 'spawner_nearby']) {
    assert.ok(ids.includes(id), `${id} missing from survival-rules.json`);
  }

  const burningObs = netherObservation({ ...quiet, inFire: true });
  const burning = evaluateSurvival(burningObs, { rules });
  assert.equal(burning.mode, 'emergency');
  assert.equal(burning.rule, 'on_fire');
  assert.ok(burning.allowedIntents.includes('escape'), `intents ${burning.allowedIntents}`);
  assert.equal(burning.needs.includes('escape'), true);

  const shot = evaluateSurvival(netherObservation({
    ...quiet,
    projectile: { type: 'fireball', distance: 8, missDistance: 0, timeToImpactMs: 900 },
  }), { rules });
  assert.equal(shot.mode, 'emergency');
  assert.equal(shot.rule, 'projectile_incoming');

  // Uno sguardo ricambiato è un avviso, non un'emergenza.
  const gaze = evaluateSurvival(netherObservation({
    ...quiet,
    enderman: { type: 'enderman', distance: 4, angleDeg: 1, gazed: true },
  }), { rules });
  assert.equal(gaze.mode, 'caution');
  assert.equal(gaze.rule, 'gazed_at_enderman');

  const magma = evaluateSurvival(netherObservation({ ...quiet, magmaDistance: 1 }), { rules });
  assert.equal(magma.mode, 'emergency');
  assert.equal(magma.rule, 'magma_contact');

  // Nel Nether tranquillo non scatta nulla di Nether-specifico.
  const calm = evaluateSurvival(netherObservation(quiet), { rules });
  assert.notEqual(calm.rule, 'on_fire');
  assert.equal(calm.mode, 'normal');
});
