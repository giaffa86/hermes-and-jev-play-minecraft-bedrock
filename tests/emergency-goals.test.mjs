import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emergencyGoalFor, DEFAULT_EMERGENCY_COOLDOWN_MS, RECOVER_LOOT_OBJECTIVE } from '../emergency-goals.mjs';
import { WORLD_EVENTS } from '../world-events.mjs';

const deathEvent = (key = 'death:10,64,20') => ({
  type: WORLD_EVENTS.PLAYER_DIED,
  severity: 'critical',
  dedupKey: key,
  data: { deathSite: { position: { x: 10, y: 64, z: 20 } } },
});

test('PLAYER_DIED maps to an emergency recover-loot goal anchored to the parent', () => {
  const spec = emergencyGoalFor(deathEvent(), { parentGoal: 'g1', now: 1000 });
  assert.equal(spec.source, 'emergency');
  assert.equal(spec.priority, 100);
  assert.equal(spec.parentGoal, 'g1');
  assert.equal(spec.type, 'recover_loot');
  assert.equal(spec.eventType, 'PLAYER_DIED');
  assert.equal(spec.objective, RECOVER_LOOT_OBJECTIVE);
  assert.equal(spec.plan.recover, true);
  assert.deepEqual(spec.plan.targets, {});
  assert.equal(spec.plan.waypoint, null);
  assert.equal(spec.parameters.emergency, 'player_died');
  assert.ok(Array.isArray(spec.parameters.lootPriority));
  assert.equal(spec.dedupKey, 'death:10,64,20');
});

test('the same event within the cooldown is not re-created', () => {
  const attempts = new Map([['death:10,64,20', 1000]]);
  assert.equal(emergencyGoalFor(deathEvent(), { attempts, now: 1000 + DEFAULT_EMERGENCY_COOLDOWN_MS - 1 }), null);
  assert.ok(emergencyGoalFor(deathEvent(), { attempts, now: 1000 + DEFAULT_EMERGENCY_COOLDOWN_MS + 1 }));
});

test('events without a builder do not become goals (governor handles them)', () => {
  assert.equal(emergencyGoalFor({ type: WORLD_EVENTS.LOW_HEALTH, dedupKey: 'health:5' }), null);
  assert.equal(emergencyGoalFor({ type: WORLD_EVENTS.HOSTILE_AMBUSH, dedupKey: 'ambush:creeper' }), null);
});

test('an empty or unknown event is ignored', () => {
  assert.equal(emergencyGoalFor(null), null);
  assert.equal(emergencyGoalFor({}), null);
  assert.equal(emergencyGoalFor({ type: 'NOT_AN_EVENT' }), null);
});
