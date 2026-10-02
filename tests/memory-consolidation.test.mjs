// Consolidamento episodico → semantico: da una missione chiusa (episodio) a un
// *hint di produttività* sul nodo spaziale (conoscenza semantica).
//
// Contratto verificato qui: idempotenza (anche dopo troncamento), provenance,
// merge, contraddizione, derivazione delle risorse, crescita limitata, vista di
// lettura per il planner, persistenza su entrambi i backend.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorldMemory, productivityScore } from '../world-memory.mjs';

const quiet = { warn () {} };
const BACKENDS = ['json', 'sqlite'];

const withMemory = (backend, fn, options = {}) => {
  const dir = mkdtempSync(join(tmpdir(), `mc-${backend}-`));
  try {
    const wm = createWorldMemory({ dir, backend, logger: quiet, ...options });
    return fn(wm, dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

// Missione completa: target spaziale esplicito + risorsa cercata + azione riuscita.
const runMission = (wm, { id, resource = 'iron_ore', node = 'cave_07', outcome = 'ok', mines = 1, result = null }) => {
  const mission = wm.createMission({ id, type: 'collect_resource', target: `resource:${resource}`, intent: 'collect_resource' });
  if (node) wm.linkMission(mission.id, 'targets', node);
  wm.linkMission(mission.id, 'seeks', `resource:${resource}`);
  for (let i = 0; i < mines; i++) {
    wm.recordAction({ missionId: mission.id, actionType: `mine_${resource}`, outcome: 'ok' });
  }
  if (outcome === 'ok') wm.finishMission(mission.id, { outcome: 'found', success: true, state: 'found', result });
  else wm.finishMission(mission.id, { outcome: 'failed', success: false, state: 'failed', failureReason: 'not_found' });
  return mission;
};

const hintFor = (wm, node, resource) => wm.productivityHints({ node, resource })[0] ?? null;

for (const backend of BACKENDS) {
  test(`[${backend}] a closed mission leaves a productivity hint on its spatial target`, () => withMemory(backend, (wm) => {
    wm.rememberLandmark({ type: 'cave', id: 'cave_07', position: { x: 100, y: 64, z: 200 } });
    runMission(wm, { id: 'm1' });

    const hint = hintFor(wm, 'cave_07', 'iron_ore');
    assert.equal(hint.attempts, 1);
    assert.equal(hint.successes, 1);
    assert.equal(hint.failures, 0);
    assert.equal(hint.found, 1, 'una azione mine_iron_ore riuscita = 1');
    assert.equal(hint.confidence, 1);
    assert.equal(hint.contradicted, false);
    assert.equal(hint.outcome, 'ok');
    assert.equal(hint.location, 'cave_07');
    assert.equal(hint.position.x, 100);

    // Provenance: l'episodio sorgente resta tracciabile (arco di goal, non world graph).
    const provenance = wm.missionRelations('m1', { relationType: 'consolidated_into' });
    assert.equal(provenance.length, 1);
    assert.equal(provenance[0].targetId, 'cave_07');
    assert.equal(wm.relationsFrom('m1').length, 0, 'nessun arco di consolidamento nel world graph');
    // L'episodio originale è intatto.
    const mission = wm.getMission('m1');
    assert.equal(mission.success, true);
    assert.equal(mission.outcome, 'found');
    assert.equal(wm.missionActions('m1').length, 1);
  }));

  test(`[${backend}] consolidation is idempotent (same mission applied twice)`, () => withMemory(backend, (wm) => {
    wm.rememberLandmark({ type: 'cave', id: 'cave_07', position: { x: 100, y: 64, z: 200 } });
    runMission(wm, { id: 'm1' });
    const before = hintFor(wm, 'cave_07', 'iron_ore');

    const again = wm.consolidateMission('m1');
    assert.equal(again.ok, true);
    assert.equal(again.skipped, 'already_consolidated');
    assert.deepEqual(hintFor(wm, 'cave_07', 'iron_ore'), before, 'nessun doppio conteggio');
    assert.equal(wm.missionRelations('m1', { relationType: 'consolidated_into' }).length, 1, 'nessuna provenance duplicata');
  }));

  test(`[${backend}] hints survive a reopen and do not double count`, () => withMemory(backend, (wm, dir) => {
    wm.rememberLandmark({ type: 'cave', id: 'cave_07', position: { x: 100, y: 64, z: 200 } });
    runMission(wm, { id: 'm1' });
    wm.close();

    const b = createWorldMemory({ dir, backend, logger: quiet });
    const hint = hintFor(b, 'cave_07', 'iron_ore');
    assert.equal(hint.attempts, 1);
    b.consolidateMission('m1');
    assert.equal(hintFor(b, 'cave_07', 'iron_ore').attempts, 1);
    b.close();
  }));

  test(`[${backend}] two episodes on the same location merge instead of duplicating`, () => withMemory(backend, (wm) => {
    wm.rememberLandmark({ type: 'cave', id: 'cave_07', position: { x: 100, y: 64, z: 200 } });
    runMission(wm, { id: 'm1', mines: 2 });
    runMission(wm, { id: 'm2', mines: 1 });

    const hint = hintFor(wm, 'cave_07', 'iron_ore');
    assert.equal(hint.attempts, 2);
    assert.equal(hint.successes, 2);
    assert.equal(hint.found, 3);
    assert.equal(hint.confidence, 1);
    assert.deepEqual(hint.sources.map(s => s.mission).sort(), ['m1', 'm2']);
    // Un solo hint: la memoria non cresce per episodio (il nodo è un landmark,
    // quindi `findResources`, che è per i resource_site, non lo vede).
    assert.equal(wm.productivityHints({}).length, 1);
    assert.equal(wm.productivityHints({ resource: 'iron_ore' }).length, 1);
  }));

  test(`[${backend}] a later failure is recorded as a contradiction, not overwritten`, () => withMemory(backend, (wm) => {
    wm.rememberLandmark({ type: 'cave', id: 'cave_07', position: { x: 100, y: 64, z: 200 } });
    runMission(wm, { id: 'm_ok', mines: 1 });
    runMission(wm, { id: 'm_ko', outcome: 'failed', mines: 0 });

    const hint = hintFor(wm, 'cave_07', 'iron_ore');
    assert.equal(hint.attempts, 2);
    assert.equal(hint.successes, 1);
    assert.equal(hint.failures, 1);
    assert.equal(hint.contradicted, true);
    assert.equal(hint.confidence, 0.5);
    assert.equal(hint.outcome, 'failed', 'l esito più recente');
    assert.equal(typeof hint.lastFailureAt, 'number');
    // Il fallimento non cancella la località, ma la declassa: esclusa se si vuole
    // solo evidenza pulita.
    assert.equal(wm.provenLocationsFor('iron_ore').length, 1);
    assert.equal(wm.provenLocationsFor('iron_ore', { includeContradicted: false }).length, 0);
  }));

  test(`[${backend}] bounded growth: capped sources stay idempotent through the cutoff`, () => withMemory(backend, (wm) => {
    wm.rememberLandmark({ type: 'cave', id: 'cave_07', position: { x: 100, y: 64, z: 200 } });
    runMission(wm, { id: 'm1' });
    runMission(wm, { id: 'm2' });
    runMission(wm, { id: 'm3' });

    const hint = hintFor(wm, 'cave_07', 'iron_ore');
    assert.equal(hint.sources.length, 2, 'maxHintSources = 2');
    assert.deepEqual(hint.sources.map(s => s.mission), ['m2', 'm3']);
    assert.equal(hint.sourcesCutoff.mission, 'm1');
    assert.equal(typeof hint.sourcesCutoff.at, 'number');
    assert.equal(hint.attempts, 3, 'gli aggregati coprono anche gli episodi troncati');

    // Anche senza la provenance, riapplicare un episodio troncato è un no-op.
    wm.unlinkMission('m1', 'consolidated_into', 'cave_07');
    const replay = wm.consolidateMission('m1');
    assert.equal(replay.ok, true);
    assert.equal(hintFor(wm, 'cave_07', 'iron_ore').attempts, 3);
  }, { maxHintSources: 2 }));

  test(`[${backend}] hints per node are capped (least recently updated dropped)`, () => withMemory(backend, (wm) => {
    wm.rememberLandmark({ type: 'cave', id: 'cave_07', position: { x: 100, y: 64, z: 200 } });
    runMission(wm, { id: 'm_stone', resource: 'stone' });
    runMission(wm, { id: 'm_iron', resource: 'iron_ore' });
    runMission(wm, { id: 'm_coal', resource: 'coal_ore' });

    const hints = wm.productivityHints({ node: 'cave_07' });
    assert.equal(hints.length, 2);
    assert.deepEqual(hints.map(h => h.resource).sort(), ['coal_ore', 'iron_ore']);
  }, { maxHintsPerNode: 2 }));

  test(`[${backend}] a failed episode never creates a location node`, () => withMemory(backend, (wm) => {
    const mission = wm.createMission({ id: 'm_lost', type: 'collect_resource', target: 'resource:diamond' });
    wm.linkMission(mission.id, 'seeks', 'resource:diamond');
    wm.updateMission(mission.id, { targetPosition: { x: 500, y: 40, z: 500 } });
    wm.failMission(mission.id, 'not_found');

    assert.equal(wm.findResources({}).length, 0, 'nessuna località inventata da un fallimento');
    assert.equal(wm.productivityHints({}).length, 0);
    assert.equal(wm.consolidateMission('m_lost').skipped, 'no_anchor');
  }));

  test(`[${backend}] resources are derived from actions (no seeks edge) and anchored at the action position`, () => withMemory(backend, (wm) => {
    const mission = wm.createMission({ id: 'm_free', type: 'collect_resource' });
    // L'adapter/controller registra la posizione dell'azione: è l'evidenza più forte.
    wm.recordAction({ missionId: mission.id, actionType: 'mine_iron_ore', outcome: 'ok', data: { position: { x: 100, y: 60, z: 200 } } });
    wm.recordAction({ missionId: mission.id, actionType: 'mine_stone', outcome: 'failed', data: { position: { x: 101, y: 60, z: 200 } } });
    wm.finishMission(mission.id, { outcome: 'found', success: true, state: 'found' });

    const anchor = 'resource_site_6_12';   // chunk di x=100,z=200 (y=60 → cave)
    const hints = wm.productivityHints({});
    assert.equal(hints.length, 1);
    assert.equal(hints[0].location, anchor);
    assert.equal(hints[0].resource, 'iron_ore');
    assert.equal(hints[0].found, 1);
    assert.equal(wm.repo.get(anchor).type, 'cave');
    assert.deepEqual(wm.repo.get(anchor).observations, [], 'ancora senza false affermazioni sulle risorse');

    // Un secondo episodio nello stesso chunk riusa il nodo.
    const second = wm.createMission({ id: 'm_free2', type: 'collect_resource' });
    wm.recordAction({ missionId: second.id, actionType: 'mine_iron_ore', outcome: 'ok', data: { position: { x: 110, y: 60, z: 205 } } });
    wm.finishMission(second.id, { outcome: 'found', success: true, state: 'found' });
    assert.equal(wm.findResources({}).length, 1);
    assert.equal(hintFor(wm, anchor, 'iron_ore').attempts, 2);
  }));

  test(`[${backend}] mission.result counts feed the yield without inflating it`, () => withMemory(backend, (wm) => {
    wm.rememberLandmark({ type: 'cave', id: 'cave_07', position: { x: 100, y: 64, z: 200 } });
    runMission(wm, { id: 'm1', mines: 1, result: { iron_ore: 4 } });
    const hint = hintFor(wm, 'cave_07', 'iron_ore');
    assert.equal(hint.found, 4, 'il conteggio dichiarato non si somma alle azioni');
    assert.equal(hint.attempts, 1);
  }));

  test(`[${backend}] consolidatePending backfills closed missions and is idempotent`, () => withMemory(backend, (wm) => {
    wm.rememberLandmark({ type: 'cave', id: 'cave_07', position: { x: 100, y: 64, z: 200 } });
    runMission(wm, { id: 'm1' });
    runMission(wm, { id: 'm2' });
    wm.createMission({ id: 'm_running', type: 'collect_resource', target: 'resource:diamond' });

    const first = wm.consolidatePending({});
    assert.equal(first.candidates, 2, 'solo le missioni chiuse');
    assert.equal(first.consolidated, 2);
    const second = wm.consolidatePending({});
    assert.equal(second.processed, 2);
    assert.equal(second.consolidated, 0, 'la seconda passata salta tutto');
    assert.equal(hintFor(wm, 'cave_07', 'iron_ore').attempts, 2);
  }, { autoConsolidate: false }));

  test(`[${backend}] autoConsolidate:false leaves the graph untouched`, () => withMemory(backend, (wm) => {
    wm.rememberLandmark({ type: 'cave', id: 'cave_07', position: { x: 100, y: 64, z: 200 } });
    runMission(wm, { id: 'm1' });
    assert.equal(wm.productivityHints({}).length, 0);
    assert.equal(wm.consolidateMission('m1').ok, true, 'il backfill esplicito resta possibile');
    assert.equal(wm.productivityHints({}).length, 1);
  }, { autoConsolidate: false }));

  test(`[${backend}] the planner view exposes proven locations and observeView carries them`, () => withMemory(backend, (wm) => {
    wm.rememberLandmark({ type: 'cave', id: 'cave_07', position: { x: 100, y: 64, z: 200 } });
    wm.rememberLandmark({ type: 'cave', id: 'cave_12', position: { x: -300, y: 64, z: 50 } });
    runMission(wm, { id: 'm1', node: 'cave_07', mines: 3 });
    runMission(wm, { id: 'm2', node: 'cave_12', outcome: 'failed', mines: 0 });

    const best = wm.provenLocationsFor('iron_ore', { near: { x: 0, y: 64, z: 0 } });
    assert.equal(best.length, 2);
    assert.equal(best[0].location, 'cave_07', 'la località riuscita viene prima');
    assert.equal(best[0].distance, Math.round(Math.hypot(100, 0, 200) * 10) / 10);
    assert.equal(best[0].score, productivityScore(best[0]));
    assert.equal(wm.provenLocationsFor('diamond').length, 0);
    assert.equal(wm.provenLocationsFor('iron_ore', { limit: 1 }).length, 1);

    const view = wm.observeView({ maxHints: 5 });
    assert.equal(view.hints.length, 2);
    assert.equal(view.hints[0].resource, 'iron_ore');
    assert.equal(view.hints[0].location, 'cave_07');
  }));
}

test('productivityScore: success rate dominates, yield refines', () => {
  assert.equal(productivityScore(null), 0);
  assert.equal(productivityScore({ attempts: 0 }), 0);
  assert.equal(productivityScore({ attempts: 4, successes: 4, found: 0 }), 1);
  assert.equal(productivityScore({ attempts: 4, successes: 2, found: 0 }), 0.5);
  assert.equal(productivityScore({ attempts: 2, successes: 2, found: 5 }), 1.5);
  assert.equal(productivityScore({ attempts: 2, successes: 1, found: 20 }), 1);
  assert.equal(
    productivityScore({ attempts: 1, successes: 1, found: 2 }) > productivityScore({ attempts: 2, successes: 1, found: 0 }),
    true, 'la resa non batte la riuscita',
  );
});
