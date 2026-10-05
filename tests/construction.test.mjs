import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadStructures, createBlueprint, planStructure, validateBlueprint, inspectSite, missingMaterials, rotate, placementSupport, constructionGoalMet, bridgeRequest } from '../construction.mjs';
import { constructionFromText } from '../bedrock-construction.mjs';

const catalogue = loadStructures();
const origin = { x: 0, y: 64, z: 0 };
const air = { name: 'air', boundingBox: 'empty' };
const stone = { name: 'stone', boundingBox: 'block' };

test('all five catalogue templates expand with exact material budgets in every rotation', () => {
  assert.equal(catalogue.size, 5);
  for (const def of catalogue.values()) for (const facing of ['south', 'east', 'north', 'west']) {
    const blueprint = createBlueprint(def);
    assert.deepEqual(validateBlueprint(blueprint), []);
    const plan = planStructure(blueprint, { origin, facing });
    assert.equal(Object.values(plan.required).reduce((a, b) => a + b, 0), blueprint.cells.length);
    assert.equal(new Set(plan.cells.map(c => JSON.stringify(c.position))).size, plan.cells.length);
    assert.equal(missingMaterials(plan).reduce((s, c) => s + c.missing, 0), plan.cells.length);
  }
});

test('cardinal rotation preserves handedness and distances', () => {
  assert.deepEqual(rotate([2, 3, 4], 'east'), [4, 3, -2]);
  assert.deepEqual(rotate(rotate([2, 3, 4], 'east'), 'west'), [2, 3, 4]);
});

test('invalid sizes, stateful unsupported palette and impossible storage are rejected before world access', () => {
  assert.throws(() => createBlueprint(catalogue.get('house'), { width: 100 }), /invalid_width/);
  assert.throws(() => createBlueprint(catalogue.get('house'), { palette: { wall: 'tnt' } }), /unsupported_material/);
  assert.throws(() => createBlueprint(catalogue.get('house'), { palette: { roof: 'oak_stairs' } }), /unsupported_material/);
  assert.throws(() => createBlueprint(catalogue.get('warehouse'), { length: 7, chests: 12 }), /does_not_fit/);
  assert.throws(() => planStructure(createBlueprint(catalogue.get('house')), { origin: { x: NaN, y: 64, z: 0 } }), /invalid_site/);
});

test('unknown cells, preexisting matching walls, blocked clearance and interactive terrain never become a clean site', () => {
  const plan = planStructure(createBlueprint(catalogue.get('platform')), { origin });
  const read = p => p.y < 64 ? stone : air;
  assert.equal(inspectSite(plan, read).ok, true);
  assert.equal(inspectSite(plan, () => null).ok, false);
  assert.ok(inspectSite(plan, p => p.x === 0 && p.y === 64 && p.z === 0 ? { name: 'cobblestone', boundingBox: 'block' } : read(p)).issues.some(i => i.reason === 'occupied'));
  assert.ok(inspectSite(plan, p => p.y === 65 ? stone : read(p)).issues.some(i => i.reason === 'clearance_blocked'));
  assert.ok(inspectSite(plan, p => p.y === 63 ? { name: 'chest', boundingBox: 'block' } : read(p)).issues.some(i => i.reason === 'unsafe_terrain'));
});

test('support requires a loaded existing noninteractive block; side support permits roof and bridge spans', () => {
  const cell = { position: { x: 1, y: 65, z: 1 }, block: 'cobblestone' };
  assert.equal(placementSupport(cell, () => null), null);
  assert.deepEqual(placementSupport(cell, p => p.x === 0 ? stone : air), { position: { x: 0, y: 65, z: 1 }, face: 5 });
  assert.equal(placementSupport(cell, () => ({ name: 'chest', boundingBox: 'block' })), null);
});

test('structure goals need this verified project, never inventory or an unrelated completed build', () => {
  const obs = { inventory: { oak_planks: 999 }, construction: { projectId: 'a', state: 'complete', placed: 10, verification: { ok: true } } };
  assert.equal(constructionGoalMet(obs, { projectId: 'a' }), true);
  assert.equal(constructionGoalMet(obs, { projectId: 'b' }), false);
  assert.equal(constructionGoalMet({ ...obs, construction: { ...obs.construction, state: 'building' } }, { projectId: 'a' }), false);
});

test('Italian construction commands retain dimensions, storage demand and pause/resume instance', () => {
  assert.deepEqual(constructionFromText('Costruisci una casa 7×7'), { type: 'house', parameters: { width: 7, length: 7 } });
  assert.equal(constructionFromText('Costruisci un magazzino con 4 casse').parameters.chests, 4);
  assert.deepEqual(constructionFromText('Metti in pausa il cantiere', { construction: { projectId: 'p' } }), { projectId: 'p', command: 'pause' });
  assert.equal(constructionFromText('Seguimi'), null);
});

test('level bridge endpoints map to both exact approaches in every cardinal orientation', () => {
  const from = { x: 10, y: 64, z: 10 };
  for (const [dx, dz] of [[0, 10], [10, 0], [0, -10], [-10, 0]]) {
    const to = { ...from, x: from.x + dx, z: from.z + dz };
    const request = bridgeRequest({ type: 'bridge', from, to });
    const plan = planStructure(createBlueprint(catalogue.get('bridge'), request.parameters), request);
    assert.deepEqual(plan.routes[0].points[0], from);
    assert.deepEqual(plan.routes[0].points.at(-1), to);
  }
  assert.throws(() => bridgeRequest({ type: 'bridge', from, to: { ...from, y: 65, z: 20 } }), /must_be_level/);
  assert.throws(() => bridgeRequest({ type: 'bridge', from, to: { ...from, x: 20, z: 20 } }), /axis_aligned/);
});

test('wooden bridge floors over lava are refused while stone spans remain valid', () => {
  const read = p => p.y === 63 ? (p.z > 0 && p.z < 8 ? { name: 'lava', boundingBox: 'empty' } : stone) : air;
  const wood = planStructure(createBlueprint(catalogue.get('bridge'), { palette: { floor: 'oak_planks' } }), { origin });
  assert.ok(inspectSite(wood, read).issues.some(i => i.reason === 'flammable_lava_bridge'));
  const rock = planStructure(createBlueprint(catalogue.get('bridge')), { origin });
  assert.equal(inspectSite(rock, read).ok, true);
});
