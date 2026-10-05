import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

const bed = { position: { x: 2, y: 63, z: 0 } };

function room ({ sealed = false } = {}) {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.position = { x: 0.5, y: 64.62, z: 0.5 };
  adapter._feet = { x: 0.5, y: 63, z: 0.5 };
  adapter._recordTime(18000);
  adapter.world.blockAt = ({ x, y, z }) => {
    if (x === 2 && y === 63 && z === 0) return { name: 'bed', boundingBox: 'empty', shapes: [[0, 0, 0, 1, 0.5625, 1]] };
    const wall = sealed ? Math.max(Math.abs(x - 2), Math.abs(z)) === 1 : x === 1 && z === 0;
    if (y === 62 || (wall && (y === 63 || y === 64))) return { name: 'stone', boundingBox: 'block' };
    return { name: 'air', boundingBox: 'empty' };
  };
  adapter._sendSleepAction = () => {};
  return adapter;
}

test('a nearby bed behind a wall requires a complete approach to its visible side', async () => {
  const adapter = room();
  assert.equal(adapter._bedVisible(bed), false);
  let movement;
  adapter._moveTo = async (target, distance, timeout, options) => {
    movement = { target, distance, options };
    adapter._feet = { ...target };
    adapter.position = { ...target, y: target.y + 1.62 };
  };
  let clicks = 0;
  adapter._queueAuthInput = async input => {
    if (input.transaction) {
      assert.equal(adapter._bedVisible(bed), true);
      clicks++;
      adapter.sleeping = true;
    }
  };
  const result = await adapter._trySleepInBed(bed, { confirmMs: 10 });
  assert.equal(result.ok, true);
  assert.equal(clicks, 1);
  assert.equal(movement.options.preciseArrival, true);
  assert.equal(movement.options.verticalTolerance, 0.15);
  assert.equal(movement.distance, 0.08);
  assert.notDeepEqual(adapter._feet, { x: 2.5, y: 63, z: 0.5 });
});

test('a movement acknowledgement does not authorize a click through the wall', async () => {
  const adapter = room();
  adapter._moveTo = async () => ({ ok: true }); // Server leaves the player outside.
  adapter._queueAuthInput = async () => assert.fail('an obstructed bed must not be clicked');
  const result = await adapter._trySleepInBed(bed, { confirmMs: 10 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'bed_click_obstructed');
});

test('a sealed bedroom has no usable approach, even when its bed is within reach', async () => {
  const adapter = room({ sealed: true });
  adapter._moveTo = async () => assert.fail('there is no visible standing cell');
  adapter._queueAuthInput = async () => assert.fail('a sealed bedroom must not be clicked');
  const result = await adapter._trySleepInBed(bed, { confirmMs: 10 });
  assert.equal(result.error, 'bed_access_unavailable');
});

test('unknown cells and blocked headroom cannot establish safe bed access', () => {
  const adapter = room();
  const read = adapter.world.blockAt;
  adapter.world.blockAt = () => ({ name: 'unknown', boundingBox: 'empty' });
  assert.equal(adapter._bedVisible(bed), false);
  assert.equal(adapter._bedStandSpot(bed), null);
  adapter.world.blockAt = p => p.y === 64 ? { name: 'stone', boundingBox: 'block' } : read(p);
  assert.equal(adapter._bedStandSpotFree({ x: 3.5, y: 63, z: 0.5 }), false);
});

test('a partial path cannot establish a bed standing cell', () => {
  const adapter = room();
  adapter._findPath = start => [start];
  assert.equal(adapter._bedStandSpot(bed), null);
});

test('a bedroom approach uses the doorway instead of a nearby cell outside its wall', () => {
  const adapter = room();
  const insideBed = { position: { x: 3, y: 63, z: 0 } };
  adapter.world.blockAt = ({ x, y, z }) => {
    if (x === 3 && y === 63 && z === 0) return { name: 'bed', boundingBox: 'empty', shapes: [[0, 0, 0, 1, 0.5625, 1]] };
    if (x === 1 && z === 0 && (y === 63 || y === 64)) return { name: 'wooden_door', boundingBox: 'block', shapes: [[0, 0, 0, 0.1875, 1, 1]], getProperties: () => ({ open_bit: false }) };
    const wall = ((x === 1 || x === 5) && Math.abs(z) <= 2) || ((z === -2 || z === 2) && x >= 1 && x <= 5);
    if (y === 62 || (wall && (y === 63 || y === 64))) return { name: 'stone', boundingBox: 'block' };
    return { name: 'air', boundingBox: 'empty' };
  };
  const spot = adapter._bedStandSpot(insideBed);
  assert.ok(spot, 'the bed has an accessible standing cell inside the room');
  assert.ok(spot.x > 2 && spot.x < 5);
  const goal = { x: Math.floor(spot.x), y: spot.y, z: Math.floor(spot.z) };
  const path = adapter._findPath(adapter._startNode(), goal);
  assert.ok(path.some(p => p.x === 1 && p.z === 0), 'the route enters through the wooden door');
  assert.equal(adapter._bedVisible(insideBed, { ...spot, y: spot.y + 1.62 }), true);
});
