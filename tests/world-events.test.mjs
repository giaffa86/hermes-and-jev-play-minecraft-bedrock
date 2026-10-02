import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectEvents, WORLD_EVENTS } from '../world-events.mjs';

const base = (over = {}) => ({
  position: { x: 0, y: 64, z: 0 },
  health: 20,
  dead: false,
  deathSite: null,
  entities: [],
  ...over,
});

const creeper = (distance = 4) => ({ type: 'creeper', distance, hostile: true, position: { x: distance, y: 64, z: 0 } });

test('steady state yields no events', () => {
  assert.deepEqual(detectEvents(base(), base()), []);
});

test('death flag flip yields PLAYER_DIED', () => {
  const events = detectEvents(base({ dead: false }), base({ dead: true, health: 0 }));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, WORLD_EVENTS.PLAYER_DIED);
  assert.equal(events[0].severity, 'critical');
  assert.match(events[0].dedupKey, /^death:/);
});

test('a new death site yields PLAYER_DIED even if the dead frame was missed', () => {
  const events = detectEvents(base(), base({ deathSite: { position: { x: 10, y: 64, z: 20 } } }));
  assert.equal(events.find(e => e.type === WORLD_EVENTS.PLAYER_DIED)?.dedupKey, 'death:10,64,20');
});

test('an unchanged death site does not re-emit PLAYER_DIED', () => {
  const site = { position: { x: 10, y: 64, z: 20 } };
  const events = detectEvents(base({ deathSite: site }), base({ deathSite: site }));
  assert.ok(!events.some(e => e.type === WORLD_EVENTS.PLAYER_DIED));
});

test('LOW_HEALTH fires on the transition and not while it stays low', () => {
  const down = detectEvents(base({ health: 20 }), base({ health: 5 }));
  assert.ok(down.some(e => e.type === WORLD_EVENTS.LOW_HEALTH));
  const still = detectEvents(base({ health: 5 }), base({ health: 4 }));
  assert.ok(!still.some(e => e.type === WORLD_EVENTS.LOW_HEALTH));
});

test('HOSTILE_AMBUSH fires when a hostile enters the critical band', () => {
  const events = detectEvents(base(), base({ entities: [creeper(4)] }));
  assert.ok(events.some(e => e.type === WORLD_EVENTS.HOSTILE_AMBUSH));
  const still = detectEvents(base({ entities: [creeper(4)] }), base({ entities: [creeper(3)] }));
  assert.ok(!still.some(e => e.type === WORLD_EVENTS.HOSTILE_AMBUSH));
});

test('a dead bot does not emit low-health or ambush noise', () => {
  const events = detectEvents(base(), base({ dead: true, health: 0, entities: [creeper(2)] }));
  assert.deepEqual(events.map(e => e.type), [WORLD_EVENTS.PLAYER_DIED]);
});
