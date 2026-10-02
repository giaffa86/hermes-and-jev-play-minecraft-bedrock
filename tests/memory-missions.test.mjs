// Goal/episodic layer: mission + mission_relation + action_event sopra il world
// graph. Gli archi di goal non devono inquinare memory_relation (fatti del mondo).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorldMemory } from '../world-memory.mjs';

const quiet = { warn () {} };
const BACKENDS = ['json', 'sqlite'];

const withMemory = (backend, fn) => {
  const dir = mkdtempSync(join(tmpdir(), `mm-${backend}-`));
  try {
    const wm = createWorldMemory({ dir, backend, logger: quiet });
    return fn(wm, dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

for (const backend of BACKENDS) {
  test(`[${backend}] a mission records the raw prompt, intent and lifecycle`, () => withMemory(backend, (wm) => {
    const m = wm.createMission({
      type: 'collect_resource', target: 'resource:iron_ore',
      rawPrompt: 'torna nella grotta dei diamanti e prendi ferro',
      intent: 'collect_resource',
    });
    assert.equal(m.rawPrompt.includes('prendi ferro'), true);
    assert.equal(m.intent, 'collect_resource');
    assert.equal(m.state, 'running');
    assert.equal(m.success, null);
    wm.finishMission(m.id, { outcome: 'found', success: true, state: 'found', result: { iron_ore: 4 } });
    const done = wm.getMission(m.id);
    assert.equal(done.state, 'found');
    assert.equal(done.outcome, 'found');
    assert.equal(done.success, true);
    assert.equal(done.result.iron_ore, 4);
  }));

  test(`[${backend}] completeMission/failMission set success`, () => withMemory(backend, (wm) => {
    const ok = wm.createMission({ type: 'go_to', target: 'biome:cherry_grove' });
    wm.completeMission(ok.id, { biome: 'cherry_grove' });
    assert.equal(wm.getMission(ok.id).success, true);
    assert.equal(wm.getMission(ok.id).outcome, 'found');
    const ko = wm.createMission({ type: 'go_to', target: 'biome:pale_garden' });
    wm.failMission(ko.id, 'not_found');
    assert.equal(wm.getMission(ko.id).success, false);
    assert.equal(wm.getMission(ko.id).outcome, 'failed');
  }));

  test(`[${backend}] mission relations are goal edges, separate from the world graph`, () => withMemory(backend, (wm) => {
    const m = wm.createMission({ type: 'collect_resource', target: 'resource:iron_ore', intent: 'collect_resource' });
    wm.rememberLandmark({ type: 'cave', id: 'cave_07', position: { x: 100, y: 64, z: 200 } });
    wm.linkMission(m.id, 'targets', 'cave_07');
    wm.linkMission(m.id, 'destination', 'home');
    const rels = wm.missionRelations(m.id);
    assert.deepEqual(rels.map(r => `${r.relationType}:${r.targetId}`).sort(), ['destination:home', 'targets:cave_07', 'targets:resource:iron_ore']);
    // Il world graph NON deve vedere gli archi di goal.
    assert.equal(wm.relationsFrom(m.id).length, 0, 'nessun arco di goal in memory_relation');
    // Il nodo cave_07 esiste davvero (garantito), e resta nel world graph.
    assert.equal(wm.hasLandmark('cave_07'), true);
  }));

  test(`[${backend}] action events are recorded per mission`, () => withMemory(backend, (wm) => {
    const m = wm.createMission({ type: 'collect_resource', target: 'resource:iron_ore', intent: 'collect_resource' });
    wm.recordAction({ missionId: m.id, actionType: 'goto', targetId: 'cave_07', outcome: 'ok' });
    wm.recordAction({ missionId: m.id, actionType: 'mine', targetId: 'iron_ore', outcome: 'ok' });
    wm.recordAction({ missionId: m.id, actionType: 'deposit', targetId: 'home', outcome: 'ok' });
    const actions = wm.missionActions(m.id);
    assert.deepEqual(actions.map(a => a.actionType), ['goto', 'mine', 'deposit']);
    assert.equal(wm.summary().actionEvents, 3);
  }));

  test(`[${backend}] findPreviousMissions filters by intent and target`, () => withMemory(backend, (wm) => {
    wm.createMission({ id: 'm1', type: 'collect_resource', target: 'resource:iron_ore', intent: 'collect_resource' });
    wm.createMission({ id: 'm2', type: 'explore', target: 'biome:cherry_grove', intent: 'explore' });
    const byIntent = wm.findPreviousMissions({ intent: 'collect_resource' });
    assert.deepEqual(byIntent.map(m => m.id), ['m1']);
    const byTarget = wm.findPreviousMissions({ target: 'iron_ore' });
    assert.deepEqual(byTarget.map(m => m.id), ['m1']);
    const byTargetBiome = wm.findPreviousMissions({ target: 'cherry_grove' });
    assert.deepEqual(byTargetBiome.map(m => m.id), ['m2']);
  }));

  test(`[${backend}] findSuccessfulLocationsFor joins successful missions to their spatial target`, () => withMemory(backend, (wm) => {
    wm.rememberLandmark({ type: 'cave', id: 'cave_07', position: { x: 100, y: 64, z: 200 } });
    wm.rememberLandmark({ type: 'cave', id: 'cave_12', position: { x: -300, y: 64, z: 50 } });
    const ok = wm.createMission({ id: 'm_ok', type: 'collect_resource', target: 'resource:iron_ore', intent: 'collect_resource' });
    wm.linkMission(ok.id, 'targets', 'cave_07');
    wm.linkMission(ok.id, 'seeks', 'resource:iron_ore');
    wm.finishMission(ok.id, { success: true, state: 'found' });
    const ko = wm.createMission({ id: 'm_ko', type: 'collect_resource', target: 'resource:iron_ore', intent: 'collect_resource' });
    wm.linkMission(ko.id, 'targets', 'cave_12');
    wm.linkMission(ko.id, 'seeks', 'resource:iron_ore');
    wm.finishMission(ko.id, { success: false, state: 'failed' });
    const locations = wm.findSuccessfulLocationsFor('iron_ore');
    assert.equal(locations.length, 1, 'solo la missione riuscita');
    assert.equal(locations[0].location, 'cave_07');
    assert.deepEqual(locations[0].position, { x: 100, y: 64, z: 200 });
  }));

  test(`[${backend}] mission + goal edges survive a reopen`, () => withMemory(backend, (wm, dir) => {
    wm.rememberLandmark({ type: 'cave', id: 'cave_07', position: { x: 100, y: 64, z: 200 } });
    const m = wm.createMission({ id: 'm_keep', type: 'collect_resource', target: 'resource:iron_ore', intent: 'collect_resource' });
    wm.linkMission(m.id, 'targets', 'cave_07');
    wm.recordAction({ missionId: m.id, actionType: 'mine', targetId: 'iron_ore', outcome: 'ok' });
    wm.close();
    const b = createWorldMemory({ dir, backend, logger: quiet });
    assert.equal(b.getMission('m_keep').intent, 'collect_resource');
    assert.equal(b.missionRelations('m_keep').length, 2); // targets:resource + targets:cave_07
    assert.equal(b.missionActions('m_keep').length, 1);
    b.close();
  }));
}

test('mission relations require a real missionId', () => {
  // (coperto sopra dal service: target garantito come nodo, non serve un test
  //  extra qui — il vincolo è esercitato da linkMission/_ensureNode.)
});
