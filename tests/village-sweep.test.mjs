import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planExplorationSweep, chunkKey } from '../exploration.mjs';
import { villageSweepConfig, surveyVillage, VILLAGE_SURVEY_RADIUS, VILLAGE_SURVEY_SPACING } from '../village-survey.mjs';

// Il villaggio del mondo live: l'anchor che `detectStructures` ha già scelto.
const ANCHOR = { x: 113, y: 73, z: 156 };

test('survey_village is a configuration of the sweep planner, not a second engine', () => {
  const config = villageSweepConfig({ anchor: ANCHOR });
  assert.deepEqual(Object.keys(config).sort(), ['anchor', 'cells', 'maxRadius', 'radius', 'spacing', 'visited'], 'tutto ciò che il planner riceve');
  assert.equal(config.spacing, VILLAGE_SURVEY_SPACING);
  assert.equal(config.radius, VILLAGE_SURVEY_RADIUS);
  assert.equal(config.cells, null, 'il budget di waypoint è la spirale stessa');

  const plan = planExplorationSweep(config);
  assert.equal(plan.ok, true);
  assert.deepEqual({ x: plan.next.x, z: plan.next.z }, { x: ANCHOR.x, z: ANCHOR.z }, 'la spirale parte dall\'anchor del villaggio');
  assert.equal(plan.next.distance, 0);
  assert.equal(plan.waypoints.length, 9, 'centro + un anello: il passo è fine rispetto al bordo');
});

test('the anchored bound is a pure function of anchor + visited + config', () => {
  const config = villageSweepConfig({ anchor: ANCHOR, visited: new Set([chunkKey(ANCHOR.x, ANCHOR.z)]) });
  const first = planExplorationSweep(config);

  assert.ok(Array.isArray(config.visited), 'la configurazione deve sopravvivere a un JSON.stringify');
  assert.deepEqual(JSON.parse(JSON.stringify(config)), config);
  const reloaded = planExplorationSweep(JSON.parse(JSON.stringify(config)));
  assert.deepEqual(reloaded, first, 'stesso stato ⇒ stesso piano, anche dopo un reload');

  const withSet = planExplorationSweep({ ...config, visited: new Set(config.visited) });
  assert.deepEqual(withSet, first, 'array o Set non cambiano il piano');

  assert.equal(first.waypoints.length, 8, 'la cella già visitata non torna nel piano');
  assert.ok(first.waypoints.every(row => row.distance > 0), 'il centro visitato non è più un waypoint');
});

test('no waypoint ever falls outside the bound, so the sweep can be complete', () => {
  const plan = planExplorationSweep(villageSweepConfig({ anchor: ANCHOR }));
  assert.ok(plan.waypoints.every(row => row.distance <= VILLAGE_SURVEY_RADIUS), 'il bordo è un tetto, non una speranza');
  assert.equal(plan.truncated, false);
  assert.equal(plan.stoppedBy, 'exhausted', 'l\'area assegnata è stata percorsa tutta');
  assert.equal(plan.boundary.pendingBeyond, 0);

  const wider = planExplorationSweep(villageSweepConfig({ anchor: ANCHOR, radius: 72 }));
  assert.ok(wider.waypoints.every(row => row.distance <= 72));
  assert.ok(wider.waypoints.length > plan.waypoints.length, 'un raggio più largo è più lavoro, non un numero diverso altrove');
  assert.equal(wider.stoppedBy, 'exhausted');
});

test('an anchor-less sweep refuses instead of inventing an origin', () => {
  const plan = planExplorationSweep(villageSweepConfig({ anchor: null }));
  assert.equal(plan.ok, false);
  assert.equal(plan.error, 'no_anchor', 'un rifiuto, non un censimento vuoto');
  assert.deepEqual(plan.waypoints, []);
  assert.equal(plan.next, null);
  assert.equal(plan.stoppedBy, null);
  assert.equal(plan.config.maxRadius, 1, 'la configurazione che il planner riporta è quella derivata dal raggio');
  assert.equal(planExplorationSweep(villageSweepConfig({ anchor: { x: NaN, y: 64, z: 0 } })).error, 'no_anchor');
});

test('a nonsense spacing or radius falls back, it does not divide by zero', () => {
  const config = villageSweepConfig({ anchor: ANCHOR, spacing: 0, radius: -1 });
  assert.equal(config.spacing, VILLAGE_SURVEY_SPACING);
  assert.equal(config.radius, VILLAGE_SURVEY_RADIUS);
  assert.equal(planExplorationSweep(config).ok, true);
});

test('the waypoint budget and the census budget are two different facts', () => {
  const cells = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }]
    .map(row => ({ position: { x: row.x, y: 64, z: row.z } }));

  const census = surveyVillage({ nearby: { cobblestone: cells }, limits: { maxCells: 3 } });
  assert.equal(census.survey.truncated, true, 'il censimento ha un budget di blocchi');
  assert.equal(census.survey.dropped, 2);

  const plan = planExplorationSweep(villageSweepConfig({ anchor: ANCHOR }));
  assert.equal(plan.truncated, false, 'il piano ha un budget di waypoint, che è la spirale');
  assert.equal(plan.config.cells, null);
});
