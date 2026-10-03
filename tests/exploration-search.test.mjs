import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSearchTarget, SUPPORTED_SEARCH_TARGETS, buildSearchReport, planSearchStep, chunkKey,
} from '../exploration.mjs';

test('search targets resolve from natural language to a Minecraft id and kind', () => {
  assert.deepEqual(resolveSearchTarget('Brown Mushroom'), { kind: 'block', name: 'brown_mushroom', id: 'minecraft:brown_mushroom' });
  assert.deepEqual(resolveSearchTarget('funghi marroni'), { kind: 'block', name: 'brown_mushroom', id: 'minecraft:brown_mushroom' });
  assert.deepEqual(resolveSearchTarget('zucche'), { kind: 'block', name: 'pumpkin', id: 'minecraft:pumpkin' });
  assert.equal(resolveSearchTarget('minecraft:bamboo').name, 'bamboo');
  assert.equal(resolveSearchTarget('tronco di mangrovia').name, 'mangrove_log');
  assert.equal(resolveSearchTarget('canna da zucchero').name, 'sugar_cane');
  assert.deepEqual(resolveSearchTarget('mucca'), { kind: 'entity', name: 'cow', id: 'minecraft:cow' });
  assert.equal(resolveSearchTarget('pecore').kind, 'entity');
  assert.equal(resolveSearchTarget('bee').kind, 'entity');
});

test('an explicit block:/entity: target bypasses the alias table', () => {
  assert.deepEqual(resolveSearchTarget('block:glowstone'), { kind: 'block', name: 'glowstone', id: 'minecraft:glowstone' });
  assert.deepEqual(resolveSearchTarget('entity:creeper'), { kind: 'entity', name: 'creeper', id: 'minecraft:creeper' });
  assert.equal(resolveSearchTarget('block:'), null);
});

test('structure targets resolve to `structure:<type>`, the kind the detector knows', () => {
  assert.deepEqual(resolveSearchTarget('villaggio'), { kind: 'structure', name: 'village', id: 'structure:village' });
  assert.deepEqual(resolveSearchTarget('Villages'), { kind: 'structure', name: 'village', id: 'structure:village' });
  assert.equal(resolveSearchTarget('città antica').name, 'ancient_city');
  assert.equal(resolveSearchTarget('camera delle prove').name, 'trial_chamber');
  assert.equal(resolveSearchTarget('grotta').name, 'cave');
  assert.equal(resolveSearchTarget('miniera abbandonata').name, 'mineshaft');
  assert.equal(resolveSearchTarget('geode di ametista').name, 'amethyst_geode');
  assert.ok(SUPPORTED_SEARCH_TARGETS.includes('structure:village'));
  // La ricerca per nome resta di M1: un bioma non è un blocco né una struttura.
  assert.equal(resolveSearchTarget('cherry grove'), null);
});

test('unknown or non-search targets are refused', () => {
  assert.equal(resolveSearchTarget('cherry grove'), null, 'un bioma non è un target di ricerca');
  assert.equal(resolveSearchTarget('qualcosa di inesistente'), null);
  assert.equal(resolveSearchTarget(''), null);
  assert.equal(resolveSearchTarget(null), null);
  assert.ok(SUPPORTED_SEARCH_TARGETS.includes('minecraft:pumpkin'));
  assert.ok(SUPPORTED_SEARCH_TARGETS.includes('minecraft:cow'));
});

test('buildSearchReport summarises what was found, where and how far', () => {
  const mission = { id: 'm1', type: 'find_block', target: 'minecraft:pumpkin', origin: { x: 0, y: 64, z: 0 }, startedAt: Date.now() - 3000 };
  const matches = [
    { name: 'pumpkin', position: { x: 10, y: 64, z: 0 }, distance: 10 },
    { name: 'pumpkin', position: { x: 0, y: 64, z: 20 }, distance: 20 },
    { name: 'pumpkin', position: { x: 30, y: 64, z: 0 }, distance: 30 },
    { name: 'pumpkin', position: { x: 40, y: 64, z: 0 }, distance: 40 },
    { name: 'pumpkin', position: { x: 50, y: 64, z: 0 }, distance: 50 },
    { name: 'pumpkin', position: { x: 60, y: 64, z: 0 }, distance: 60 },
  ];
  const report = buildSearchReport({ mission, matches, scannedChunks: 7 });
  assert.equal(report.found, true);
  assert.equal(report.kind, 'block');
  assert.equal(report.target, 'minecraft:pumpkin');
  assert.equal(report.count, 6);
  assert.deepEqual(report.best, { name: 'pumpkin', position: { x: 10, y: 64, z: 0 }, distance: 10 });
  assert.equal(report.matches.length, 5, 'il report è limitato a 5 righe');
  assert.equal(report.distanceFromOrigin, 10);
  assert.equal(report.scannedChunks, 7);
  assert.equal(typeof report.durationSeconds, 'number');
  assert.equal(buildSearchReport({ mission: { id: 'm', type: 'find_entity', target: 'minecraft:cow' }, matches: [] }).kind, 'entity');
  assert.equal(buildSearchReport({ mission: { id: 'm', type: 'find_structure', target: 'structure:village' }, matches: [] }).kind, 'structure');
});

test('planSearchStep reports when the scan matched, otherwise explores like M1', () => {
  const mission = { id: 'm', type: 'find_block', state: 'running', target: 'minecraft:pumpkin', origin: { x: 0, y: 64, z: 0 } };
  const matched = planSearchStep({ mission, matches: [{ name: 'pumpkin', position: { x: 5, y: 64, z: 5 }, distance: 7 }], currentPosition: { x: 0, z: 0 }, scannedChunks: 12 });
  assert.equal(matched.action, 'report');
  assert.equal(matched.report.found, true);
  assert.equal(matched.report.scannedChunks, 12, 'il conteggio dei chunk scanditi arriva nel report');

  const empty = planSearchStep({ mission, matches: [], currentPosition: { x: 0, z: 0 }, visited: [chunkKey(0, 0)] });
  assert.equal(empty.action, 'move');
  assert.deepEqual(empty.waypoint, { x: -96, z: -96 }, 'stessa spirale deterministica dell\'M1');

  assert.equal(planSearchStep({ mission: { ...mission, state: 'found' }, matches: [] }).action, 'hold');
  assert.equal(planSearchStep({}).action, 'hold');
});
