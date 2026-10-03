import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  replayRouteFromMission, replayRouteFromPlace, planReplayStep, buildReplayReport,
} from '../exploration.mjs';
import { createWorldMemory } from '../world-memory.mjs';

const mission = {
  id: 'mission_find_biome_abc',
  type: 'find_biome',
  state: 'found',
  target: 'minecraft:cherry_grove',
  origin: { x: 100, y: 70, z: 100 },
  position: { x: 100, y: 70, z: 100 },
  targetPosition: { x: 500, y: 72, z: 500 },
};

test('replayRouteFromMission uses the target position as destination and the checkpoints as guides', () => {
  const checkpoints = [
    { id: 'cp_2', seq: 2, position: { x: 300, y: 71, z: 300 } },
    { id: 'cp_0', seq: 0, position: { x: 150, y: 70, z: 140 } },
    { id: 'cp_1', seq: 1, position: { x: 220, y: 71, z: 200 } },
  ];
  const route = replayRouteFromMission(mission, checkpoints);
  assert.equal(route.source, 'mission');
  assert.equal(route.missionId, 'mission_find_biome_abc');
  assert.equal(route.label, 'minecraft:cherry_grove');
  assert.deepEqual(route.destination, { x: 500, y: 72, z: 500 });
  assert.deepEqual(route.checkpoints.map(c => c.id), ['cp_0', 'cp_1', 'cp_2'], 'le tappe seguono seq');
  assert.deepEqual(route.checkpoints[0].position, { x: 150, y: 70, z: 140 });
});

test('replayRouteFromMission drops checkpoints that sit on the destination', () => {
  const m = { ...mission, targetPosition: null, position: { x: 10, y: 64, z: 10 } };
  const route = replayRouteFromMission(m, [{ id: 'cp_last', seq: 0, position: { x: 42, y: 64, z: 42 } }]);
  assert.deepEqual(route.destination, { x: 42, y: 64, z: 42 }, 'senza targetPosition vale l\'ultima tappa');
  assert.equal(route.checkpoints.length, 0, 'la tappa che È la destinazione non è una guida');
});

test('replayRouteFromMission falls back to position/origin and refuses an empty mission', () => {
  const route = replayRouteFromMission({ id: 'm', position: { x: 1, y: 2, z: 3 } }, []);
  assert.deepEqual(route.destination, { x: 1, y: 2, z: 3 });
  assert.equal(route.checkpoints.length, 0);
  assert.equal(replayRouteFromMission(null, []), null);
  assert.equal(replayRouteFromMission({ id: 'm' }, []), null);
});

test('replayRouteFromPlace turns a world-graph record into a single-destination route', () => {
  const route = replayRouteFromPlace({ id: 'home', kind: 'landmark', type: 'home', label: 'home', position: { x: 108, y: 74, z: 138 } });
  assert.equal(route.source, 'place');
  assert.equal(route.id, 'home');
  assert.equal(route.label, 'home');
  assert.deepEqual(route.destination, { x: 108, y: 74, z: 138 });
  assert.equal(route.checkpoints.length, 0);
  assert.equal(replayRouteFromPlace({ id: 'x' }), null, 'senza posizione non c\'è rotta');
  assert.equal(replayRouteFromPlace(null), null);
});

test('planReplayStep declares arrival inside the radius', () => {
  const route = replayRouteFromMission(mission, []);
  const step = planReplayStep({ route, currentPosition: { x: 503, z: 502 } });
  assert.equal(step.action, 'arrived');
  assert.equal(step.remaining, 3.6);
  assert.deepEqual(step.destination, { x: 500, y: 72, z: 500 });
});

test('planReplayStep walks leg by leg, skipping the legs already behind us', () => {
  const route = replayRouteFromMission(mission, [
    { id: 'cp_far', seq: 0, position: { x: 200, y: 70, z: 200 } },
    { id: 'cp_mid', seq: 1, position: { x: 300, y: 70, z: 300 } },
    { id: 'cp_near', seq: 2, position: { x: 400, y: 70, z: 400 } },
  ]);
  // Da (100,100): la tappa utile è la prima che ci avvicina davvero alla destinazione.
  const fromStart = planReplayStep({ route, currentPosition: { x: 100, z: 100 } });
  assert.equal(fromStart.action, 'move');
  assert.equal(fromStart.via, 'cp_far');
  assert.deepEqual(fromStart.waypoint, { x: 200, z: 200 });
  assert.equal(fromStart.legs, 3);
  assert.equal(fromStart.legsAhead, 3);
  // Da metà strada (350,350): le tappe 0 e 1 sono alle spalle, si punta alla 2.
  const midway = planReplayStep({ route, currentPosition: { x: 350, z: 350 } });
  assert.equal(midway.via, 'cp_near');
  assert.deepEqual(midway.waypoint, { x: 400, z: 400 });
  assert.equal(midway.legsAhead, 1);
});

test('planReplayStep goes straight to the destination when no leg is ahead', () => {
  const route = replayRouteFromMission(mission, [{ id: 'cp_behind', seq: 0, position: { x: 120, y: 70, z: 120 } }]);
  const step = planReplayStep({ route, currentPosition: { x: 300, z: 300 } });
  assert.equal(step.action, 'move');
  assert.equal(step.via, null);
  assert.deepEqual(step.waypoint, { x: 500, z: 500 });
  assert.equal(step.legsAhead, 0);
});

test('planReplayStep holds without a destination or a position', () => {
  assert.deepEqual(planReplayStep({}), { action: 'hold', reason: 'no_destination' });
  assert.deepEqual(planReplayStep({ route: { destination: { x: 1, z: 1 } } }), { action: 'hold', reason: 'no_position' });
});

test('buildReplayReport records where the replay stopped and its provenance', () => {
  const route = replayRouteFromMission(mission, []);
  const report = buildReplayReport({ route, mission: { ...mission, startedAt: Date.now() - 5000 }, currentPosition: { x: 501.7, y: 72, z: 500.2 } });
  assert.equal(report.arrived, true);
  assert.equal(report.missionId, 'mission_find_biome_abc');
  assert.equal(report.replayOf, 'mission_find_biome_abc');
  assert.equal(report.label, 'minecraft:cherry_grove');
  assert.deepEqual(report.destination, { x: 500, y: 72, z: 500 });
  assert.deepEqual(report.origin, { x: 100, y: 70, z: 100 });
  assert.deepEqual(report.stopPosition, { x: 501.7, y: 72, z: 500.2 });
  assert.equal(report.distanceFromOrigin, 565.7);
  assert.equal(typeof report.durationSeconds, 'number');
});

// La rotta di replay è derivata dai dati *persistiti*: missione registrata,
// checkpoint della catena `has_checkpoint`, posto del world graph.
for (const backend of ['json', 'sqlite']) {
  test(`[${backend}] a stored mission replays from its checkpoints and a landmark replays from the graph`, () => {
    const dir = mkdtempSync(join(tmpdir(), `replay-${backend}-`));
    try {
      const wm = createWorldMemory({ dir, backend, logger: { warn () {} } });
      const mission = wm.createMission({ type: 'find_biome', target: 'minecraft:cherry_grove', origin: { x: 116, y: 75, z: 160 } });
      wm.addCheckpoint(mission.id, { x: 140, y: 75, z: 160 });
      wm.addCheckpoint(mission.id, { x: 170, y: 75, z: 160 });
      wm.updateMission(mission.id, { targetPosition: { x: 200, y: 75, z: 160 } });
      wm.completeMission(mission.id, { biome: 'cherry_grove', found: true });

      const route = replayRouteFromMission(wm.getMission(mission.id), wm.missionCheckpoints(mission.id));
      assert.equal(route.label, 'minecraft:cherry_grove');
      assert.deepEqual(route.destination, { x: 200, y: 75, z: 160 });
      assert.deepEqual(route.checkpoints.map(c => c.position), [{ x: 140, y: 75, z: 160 }, { x: 170, y: 75, z: 160 }]);

      const first = planReplayStep({ route, currentPosition: { x: 116, y: 75, z: 160 } });
      assert.equal(first.action, 'move');
      assert.deepEqual(first.waypoint, { x: 140, z: 160 }, 'la prima tappa registrata guida il primo tratto');
      const done = planReplayStep({ route, currentPosition: { x: 198, y: 75, z: 160 } });
      assert.equal(done.action, 'arrived', 'a due passi dalla destinazione il replay è finito');

      wm.rememberLandmark({ id: 'home', type: 'home', label: 'home', position: { x: 108, y: 74, z: 138 } });
      assert.deepEqual(replayRouteFromPlace(wm.getRecord('home')).destination, { x: 108, y: 74, z: 138 });
      assert.equal(wm.getRecord('does_not_exist'), null);
      assert.equal(wm.getRecord(null), null);
      wm.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
