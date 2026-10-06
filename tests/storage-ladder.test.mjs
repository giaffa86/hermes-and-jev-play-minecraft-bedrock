// The knowledge ladder: which rung of the container search answers next.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planStorageSearch, STORAGE_RUNG, STORAGE_STEP } from '../storage-ladder.mjs';

const at = (x, z = 0) => ({ position: { x, y: 64, z } });
const knownRow = (x, count, extra = {}) => ({ ...at(x), id: `container_${x}`, type: 'chest', contents: { iron_ingot: count }, contentsKnown: true, ...extra });

test('a fresh remembered container wins: take, no verification', () => {
  const plan = planStorageSearch({ item: 'iron_ingot', known: [knownRow(10, 3)], toInspect: [at(1)], local: [at(0)], from: { x: 0, y: 64, z: 0 } });
  assert.equal(plan.rung, STORAGE_RUNG.KNOWN_ITEM);
  assert.equal(plan.step, STORAGE_STEP.TAKE);
  assert.equal(plan.reason, 'known_item');
  assert.equal(plan.target.position.x, 10);
  assert.equal(plan.target.count, 3);
  assert.equal(plan.target.verify, false, 'una memoria fresca non richiede una rilettura');
  assert.deepEqual(plan.ladder.map((l) => l.available), [1, 1, 1, 1]);
});

test('a stale memory is still cheaper than opening an unknown chest, but it must be verified', () => {
  const plan = planStorageSearch({ item: 'iron_ingot', known: [knownRow(10, 3, { contentsStale: true })], toInspect: [at(1)] });
  assert.equal(plan.rung, STORAGE_RUNG.KNOWN_ITEM);
  assert.equal(plan.target.verify, true);
  assert.equal(plan.reason, 'known_item_stale');
});

test('verifyStale:false refuses to walk on a stale memory and falls to the next rung', () => {
  const plan = planStorageSearch({ item: 'iron_ingot', known: [knownRow(10, 3, { contentsStale: true })], toInspect: [at(1)], verifyStale: false });
  assert.equal(plan.rung, STORAGE_RUNG.INSPECT);
  assert.equal(plan.step, STORAGE_STEP.INSPECT);
});

test('fresh rows are preferred over stale ones, and both over rung 2', () => {
  const plan = planStorageSearch({
    item: 'iron_ingot',
    known: [knownRow(2, 1, { contentsStale: true }), knownRow(9, 1)],
    toInspect: [at(0)],
    from: { x: 0, y: 64, z: 0 },
  });
  assert.equal(plan.target.position.x, 9);
  assert.equal(plan.target.verify, false);
});

test('with nothing remembered, rung 2 opens the nearest discovered container', () => {
  const plan = planStorageSearch({ item: 'iron_ingot', toInspect: [at(30), at(5), at(12)], local: [at(1)], from: { x: 0, y: 64, z: 0 } });
  assert.equal(plan.rung, STORAGE_RUNG.INSPECT);
  assert.equal(plan.step, STORAGE_STEP.INSPECT);
  assert.equal(plan.target.position.x, 5);
  assert.equal(plan.reason, 'discovered_not_inspected');
});

test('a row whose inspection expired is a rung 2 candidate even without an explicit flag', () => {
  const plan = planStorageSearch({ item: 'iron_ingot', toInspect: [{ ...at(3), id: 'container_3', contentsKnown: true, inspectionStale: true, needsInspection: true }] });
  assert.equal(plan.rung, STORAGE_RUNG.INSPECT);
  assert.equal(plan.target.position.x, 3);
});

test('a container visible right now that the register does not know is rung 3: discover it', () => {
  const plan = planStorageSearch({ item: 'iron_ingot', local: [at(7)], from: { x: 0, y: 64, z: 0 } });
  assert.equal(plan.rung, STORAGE_RUNG.LOCAL);
  assert.equal(plan.step, STORAGE_STEP.REMEMBER);
  assert.equal(plan.reason, 'local_scan');
});

test('local rows the register already knows are not rung 3', () => {
  const plan = planStorageSearch({ item: 'iron_ingot', local: [{ ...at(7), id: 'container_7', known: true }], canSweep: true });
  assert.equal(plan.rung, STORAGE_RUNG.SWEEP, 'niente di locale non noto: resta il giro di ricognizione');
});

test('with nothing known anywhere, a sweep is the only honest answer', () => {
  const plan = planStorageSearch({ item: 'iron_ingot' });
  assert.equal(plan.rung, STORAGE_RUNG.SWEEP);
  assert.equal(plan.step, STORAGE_STEP.SWEEP);
  assert.equal(plan.reason, 'nothing_known_locally');
  assert.equal(plan.target, null);
});

test('without a sweep available the ladder stops instead of inventing a step', () => {
  const plan = planStorageSearch({ item: 'iron_ingot', canSweep: false });
  assert.equal(plan.rung, STORAGE_RUNG.NONE);
  assert.equal(plan.step, STORAGE_STEP.NONE);
  assert.equal(plan.reason, 'nothing_known');
});

test('an unreachable remembered container is reported, not chosen', () => {
  const plan = planStorageSearch({ item: 'iron_ingot', known: [knownRow(10, 4, { reachable: false })], toInspect: [at(2)], from: { x: 0, y: 64, z: 0 } });
  assert.equal(plan.rung, STORAGE_RUNG.INSPECT, 'non si sceglie un baule che non si può raggiungere');
  assert.equal(plan.blocked.length, 1);
  assert.equal(plan.blocked[0].reason, 'unreachable');
  assert.equal(plan.blocked[0].position.x, 10);
});

test('a remembered container without the item is not rung 1', () => {
  const plan = planStorageSearch({ item: 'iron_ingot', known: [{ ...at(10), id: 'c', contents: { coal: 5 }, contentsKnown: true }], toInspect: [at(30)] });
  assert.equal(plan.rung, STORAGE_RUNG.INSPECT);
  assert.deepEqual(plan.ladder.map((l) => l.available), [0, 1, 0, 1]);
});

test('all unreachable candidates and no sweep reports all_unreachable', () => {
  const plan = planStorageSearch({ item: 'iron_ingot', known: [knownRow(10, 1, { reachable: false })], canSweep: false });
  assert.equal(plan.rung, STORAGE_RUNG.NONE);
  assert.equal(plan.reason, 'all_unreachable');
});
