import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveBiomeTarget, normalizeBiome, biomeReached, spiralOffsets, chunkKey,
  nextExplorationWaypoint, planExplorationStep, buildExplorationReport, SUPPORTED_BIOMES,
} from '../exploration.mjs';

test('biome targets resolve from natural language to a Minecraft id', () => {
  assert.equal(resolveBiomeTarget('Trova un Cherry Grove'), 'minecraft:cherry_grove');
  assert.equal(resolveBiomeTarget('bioma dei ciliegi'), 'minecraft:cherry_grove');
  assert.equal(resolveBiomeTarget('minecraft:pale_garden'), 'minecraft:pale_garden');
  assert.equal(resolveBiomeTarget('isola di funghi'), 'minecraft:mushroom_fields');
  assert.equal(resolveBiomeTarget('qualcosa di inesistente'), null);
  assert.ok(SUPPORTED_BIOMES.includes('minecraft:cherry_grove'));
});

test('normalizeBiome and biomeReached ignore namespace and case', () => {
  assert.equal(normalizeBiome('minecraft:Cherry_Grove'), 'cherry_grove');
  assert.equal(biomeReached('cherry_grove', 'minecraft:cherry_grove'), true);
  assert.equal(biomeReached('plains', 'minecraft:cherry_grove'), false);
  assert.equal(biomeReached(null, 'minecraft:cherry_grove'), false);
});

test('spiralOffsets starts at the centre then expands ring by ring', () => {
  const o = spiralOffsets(1);
  assert.deepEqual(o[0], { dx: 0, dz: 0 });
  assert.equal(o.length, 9, 'centro + anello 1 (8 celle)');
  assert.deepEqual(o.slice(1, 3), [{ dx: -1, dz: -1 }, { dx: 0, dz: -1 }]);
});

test('nextExplorationWaypoint skips visited chunks, deterministically', () => {
  const origin = { x: 0, z: 0 };
  assert.deepEqual(nextExplorationWaypoint({ origin, visited: [], spacing: 96 }), { x: 0, z: 0 });
  assert.deepEqual(nextExplorationWaypoint({ origin, visited: [chunkKey(0, 0)], spacing: 96 }), { x: -96, z: -96 });
});

test('planExplorationStep decides found / move / hold / exhausted', () => {
  const mission = { id: 'm', kind: 'mission', state: 'running', target: 'minecraft:cherry_grove', origin: { x: 0, y: 64, z: 0 } };
  assert.equal(planExplorationStep({ mission, currentBiome: 'cherry_grove', currentPosition: { x: 10, z: 10 } }).action, 'found');
  const move = planExplorationStep({ mission, currentBiome: 'plains', currentPosition: { x: 0, z: 0 }, visited: [chunkKey(0, 0)] });
  assert.equal(move.action, 'move');
  assert.deepEqual(move.waypoint, { x: -96, z: -96 });
  assert.equal(planExplorationStep({ mission: { ...mission, state: 'found' }, currentBiome: 'plains' }).action, 'hold');
  assert.equal(planExplorationStep({}).action, 'hold');
  const visitedAll = spiralOffsets(1).map(o => chunkKey(o.dx * 96, o.dz * 96));
  assert.equal(planExplorationStep({ mission, currentBiome: 'plains', visited: visitedAll, maxRadius: 1 }).action, 'exhausted');
});

test('buildExplorationReport summarises the mission', () => {
  const mission = { id: 'm1', state: 'found', target: 'minecraft:cherry_grove', origin: { x: 0, y: 64, z: 0 }, startedAt: Date.now() - 10000 };
  const report = buildExplorationReport({ mission, currentPosition: { x: 300, z: 400 }, biome: 'minecraft:cherry_grove' });
  assert.equal(report.missionId, 'm1');
  assert.equal(report.target, 'minecraft:cherry_grove');
  assert.equal(report.biome, 'cherry_grove');
  assert.equal(report.distanceFromOrigin, 500);
});
