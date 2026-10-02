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

const ore = (over = {}) => ({ name: 'diamond_ore', position: { x: 4, y: 12, z: 6 }, distance: 5.2, harvestable: true, ...over });
const oreEvents = events => events.filter(e => e.type === WORLD_EVENTS.VALUABLE_ORE_SEEN);

test('VALUABLE_ORE_SEEN fires when a valuable vein enters view', () => {
  const events = oreEvents(detectEvents(base(), base({ ores: [ore()] })));
  assert.equal(events.length, 1);
  assert.equal(events[0].severity, 'notice');
  assert.equal(events[0].dedupKey, 'ore:diamond_ore@4,12,6');
  assert.deepEqual(events[0].data, {
    ore: 'diamond_ore',
    value: 100,
    drop: 'diamond',
    position: { x: 4, y: 12, z: 6 },
    distance: 5.2,
    harvestable: true,
  });
});

test('VALUABLE_ORE_SEEN does not re-emit for the same block, but a new one counts', () => {
  const seen = [ore()];
  assert.equal(oreEvents(detectEvents(base({ ores: seen }), base({ ores: seen }))).length, 0);
  const twin = [ore(), ore({ position: { x: 5, y: 12, z: 6 } })];
  assert.equal(oreEvents(detectEvents(base({ ores: seen }), base({ ores: twin }))).length, 1);
});

test('VALUABLE_ORE_SEEN reports cheap-but-scarce ores and ignores far ones', () => {
  const coal = { name: 'coal_ore', position: { x: 2, y: 40, z: 2 }, distance: 3, harvestable: true };
  assert.equal(oreEvents(detectEvents(base(), base({ ores: [coal] }))).length, 1);
  const far = ore({ distance: 40, position: { x: 40, y: 12, z: 0 } });
  assert.equal(oreEvents(detectEvents(base(), base({ ores: [far] }))).length, 0);
});

test('a vein already in view at goal start is reported once', () => {
  assert.equal(oreEvents(detectEvents(null, base({ ores: [ore()] }))).length, 1);
});
