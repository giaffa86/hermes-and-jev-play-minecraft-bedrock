// Retention dell'episodico (P6 follow-up): la memoria delle missioni, degli
// action event e dei checkpoint non cresce all'infinito.
//
// Contratto verificato qui, su entrambi i backend: il dry-run è il default e non
// tocca niente; una potatura reale cancella solo missioni terminali **già
// consolidate** oltre la finestra `keepMissions`; una missione non consolidata
// (o non terminale, o troppo giovane) non viene mai toccata; gli hint di
// produttività — cioè la conoscenza semantica — sopravvivono ai loro episodi.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorldMemory } from '../world-memory.mjs';

const quiet = { warn () {} };
const BACKENDS = ['json', 'sqlite'];

const withMemory = (backend, fn, options = {}) => {
  const dir = mkdtempSync(join(tmpdir(), `mc-prune-${backend}-`));
  try {
    const wm = createWorldMemory({ dir, backend, logger: quiet, ...options });
    return fn(wm, dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

// Missione chiusa e consolidata: nodo spaziale target + risorsa cercata.
const closedMission = (wm, { id, node = 'cave_07', resource = 'iron_ore', mines = 1, checkpoints = 0, at = null }) => {
  const mission = wm.createMission({ id, type: 'collect_resource', target: `resource:${resource}`, intent: 'collect_resource' });
  wm.linkMission(mission.id, 'targets', node);
  wm.linkMission(mission.id, 'seeks', `resource:${resource}`);
  for (let i = 0; i < mines; i++) wm.recordAction({ missionId: mission.id, actionType: `mine_${resource}`, outcome: 'ok' });
  for (let i = 0; i < checkpoints; i++) wm.addCheckpoint(mission.id, { x: 100 + i, y: 64, z: 200 + i });
  wm.finishMission(mission.id, { outcome: 'found', success: true, state: 'found' });
  // Tempo di chiusura esplicito: la finestra `keepMissions` è una scelta sul
  // tempo, e a parità di millisecondo l'ordine sarebbe ambiguo.
  if (at != null) wm.updateMission(mission.id, { completedAt: at, startedAt: at });
  return mission;
};

for (const backend of BACKENDS) {
  test(`[${backend}] prune is a dry-run by default and deletes nothing`, () => withMemory(backend, (wm) => {
    wm.rememberLandmark({ type: 'cave', id: 'cave_07', position: { x: 100, y: 64, z: 200 } });
    closedMission(wm, { id: 'm1', checkpoints: 2, at: 1000 });
    closedMission(wm, { id: 'm2', at: 2000 });
    closedMission(wm, { id: 'm3', at: 3000 });

    const report = wm.pruneEpisodic({ keepMissions: 1 });
    assert.equal(report.dryRun, true, 'senza dryRun:false il report è un dry-run');
    assert.equal(report.candidates, 3);
    assert.equal(report.kept, 1);
    assert.equal(report.deleted.missions, 2);
    assert.equal(report.deleted.actions, 2);
    assert.equal(report.deleted.checkpoints, 2);

    // Niente è stato toccato davvero.
    for (const id of ['m1', 'm2', 'm3']) assert.ok(wm.getMission(id), `${id} è ancora lì`);
    assert.equal(wm.missionActions('m1').length, 1);
    assert.equal(wm.missionCheckpoints('m1').length, 2);
    assert.equal(wm.summary().missionRelations, 12, '4 archi di goal per missione');
  }));

  test(`[${backend}] a real prune removes only consolidated missions outside the keep window`, () => withMemory(backend, (wm) => {
    wm.rememberLandmark({ type: 'cave', id: 'cave_07', position: { x: 100, y: 64, z: 200 } });
    closedMission(wm, { id: 'm1', checkpoints: 2, at: 1000 });
    closedMission(wm, { id: 'm2', at: 2000 });
    closedMission(wm, { id: 'm3', mines: 3, at: 3000 });

    const report = wm.pruneEpisodic({ keepMissions: 1, dryRun: false });
    assert.equal(report.dryRun, false);
    assert.equal(report.deleted.missions, 2);
    assert.deepEqual(
      report.details.map(d => d.mission).sort(),
      ['m1', 'm2'],
      'le due missioni fuori finestra, non quella più recente',
    );

    // Gli episodi potati sono spariti con i loro archi e i loro checkpoint.
    assert.equal(wm.getMission('m1'), null);
    assert.equal(wm.getMission('m2'), null);
    assert.equal(wm.missionActions('m1').length, 0);
    assert.equal(wm.missionRelations('m1').length, 0);
    assert.equal(wm.getRecord('checkpoint_m1_0_100_200'), null);
    assert.equal(wm.summary().missionRelations, 4, 'restano solo gli archi di m3');

    // La missione più recente è intatta, con i suoi episodi.
    assert.ok(wm.getMission('m3'));
    assert.equal(wm.missionActions('m3').length, 3);
    assert.equal(wm.missionRelations('m3', { relationType: 'consolidated_into' }).length, 1);
  }));

  test(`[${backend}] the semantic knowledge survives the episodes it came from`, () => withMemory(backend, (wm) => {
    wm.rememberLandmark({ type: 'cave', id: 'cave_07', position: { x: 100, y: 64, z: 200 } });
    closedMission(wm, { id: 'm1', mines: 2, at: 1000 });
    closedMission(wm, { id: 'm2', mines: 3, at: 2000 });
    closedMission(wm, { id: 'm3', at: 3000 });

    const before = wm.productivityHints({ node: 'cave_07', resource: 'iron_ore' })[0];
    assert.equal(before.attempts, 3);
    assert.equal(before.found, 6);

    const report = wm.pruneEpisodic({ keepMissions: 1, keepActions: 1, dryRun: false });
    assert.equal(report.deleted.missions, 2);
    // La missione tenuta perde gli action event vecchi, non il nodo.
    assert.equal(wm.missionActions('m3').length, 1);

    const after = wm.productivityHints({ node: 'cave_07', resource: 'iron_ore' })[0];
    assert.deepEqual(
      { attempts: after.attempts, successes: after.successes, found: after.found },
      { attempts: 3, successes: 3, found: 6 },
      'l\'hint consolidato non si perde con la potatura',
    );
    // La provenienza resta: i `sources` puntano a missioni che non esistono più,
    // ed è il motivo per cui la potatura non deve toccare gli hint (sono la copia).
    assert.equal(after.sources.length, 3);
  }));

  test(`[${backend}] unconsolidated, running and too-young missions are never pruned`, () => withMemory(backend, (wm) => {
    const base = Date.now();
    wm.rememberLandmark({ type: 'cave', id: 'cave_07', position: { x: 100, y: 64, z: 200 } });
    closedMission(wm, { id: 'm1', at: base - 3000 });
    closedMission(wm, { id: 'm2', at: base - 2000 });
    closedMission(wm, { id: 'm3', at: base - 1000 });

    // Missione terminale ma **non** consolidata: nessuna risorsa cercata, quindi
    // `consolidateMission` la salta (`no_resources`) e non esiste watermark.
    const orphan = wm.createMission({ id: 'morphan', type: 'travel', target: 'home', intent: 'travel' });
    wm.finishMission('morphan', { outcome: 'cancelled', success: false, state: 'cancelled' });
    wm.updateMission('morphan', { completedAt: base - 500, startedAt: base - 500 });
    assert.equal(wm.missionRelations('morphan', { relationType: 'consolidated_into' }).length, 0);

    // Missione ancora in corso.
    const running = wm.createMission({ id: 'mrunning', type: 'collect_resource', target: 'resource:dirt', intent: 'collect_resource' });

    const old = wm.pruneEpisodic({ keepMissions: 0, minAgeMs: 60_000, dryRun: false });
    assert.equal(old.deleted.missions, 0, 'troppo giovani per minAgeMs');
    assert.equal(old.skipped.tooYoung, 3);
    assert.equal(old.skipped.unconsolidated, 1);
    assert.ok(wm.getMission('morphan'));
    assert.ok(wm.getMission('mrunning'));

    const now = wm.pruneEpisodic({ keepMissions: 0, minAgeMs: 0, dryRun: false });
    assert.equal(now.deleted.missions, 3, 'le tre consolidate');
    assert.equal(now.skipped.unconsolidated, 1);
    assert.equal(now.candidates, 4, 'le missioni in corso non sono candidate');
    assert.ok(wm.getMission('morphan'), 'una non consolidata non si pota mai');
    assert.ok(wm.getMission('mrunning'), 'una in corso non si pota mai');
    assert.equal(orphan.id, 'morphan');
    assert.equal(running.state, 'running');
  }));

  test(`[${backend}] keeping the newest actions of a kept mission is bounded by keepActions`, () => withMemory(backend, (wm) => {
    wm.rememberLandmark({ type: 'cave', id: 'cave_07', position: { x: 100, y: 64, z: 200 } });
    const mission = wm.createMission({ id: 'm1', type: 'collect_resource', target: 'resource:iron_ore', intent: 'collect_resource' });
    wm.linkMission('m1', 'targets', 'cave_07');
    wm.linkMission('m1', 'seeks', 'resource:iron_ore');
    for (let i = 0; i < 5; i++) {
      wm.recordAction({ missionId: 'm1', actionType: 'mine_iron_ore', outcome: 'ok', startedAt: 1000 + i });
    }
    wm.finishMission('m1', { outcome: 'found', success: true, state: 'found' });
    assert.equal(mission.id, 'm1');

    const dry = wm.pruneEpisodic({ keepMissions: 1, keepActions: 2 });
    assert.equal(dry.deleted.actions, 3);
    assert.equal(dry.deleted.missions, 0, 'la missione resta');
    assert.equal(wm.missionActions('m1').length, 5, 'il dry-run non taglia');

    const real = wm.pruneEpisodic({ keepMissions: 1, keepActions: 2, dryRun: false });
    assert.equal(real.deleted.actions, 3);
    const left = wm.missionActions('m1').map(e => e.startedAt).sort((a, b) => a - b);
    assert.deepEqual(left, [1003, 1004], 'restano i due action event più recenti');
    assert.ok(wm.getMission('m1'));
  }));

  test(`[${backend}] checkpoints of a kept mission are bounded by keepCheckpoints`, () => withMemory(backend, (wm) => {
    wm.rememberLandmark({ type: 'cave', id: 'cave_07', position: { x: 100, y: 64, z: 200 } });
    closedMission(wm, { id: 'm1', checkpoints: 4 });
    assert.equal(wm.missionCheckpoints('m1').length, 4);

    const report = wm.pruneEpisodic({ keepMissions: 1, keepCheckpoints: 1, dryRun: false });
    assert.equal(report.deleted.checkpoints, 3);
    const left = wm.missionCheckpoints('m1');
    assert.equal(left.length, 1);
    assert.equal(left[0].seq, 3, 'resta il checkpoint più recente');
  }));
}

test('the pruning report is JSON-serializable (the harness route returns it as is)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-prune-json-'));
  try {
    const wm = createWorldMemory({ dir, backend: 'json', logger: quiet });
    const base = Date.now();
    wm.rememberLandmark({ type: 'cave', id: 'cave_07', position: { x: 100, y: 64, z: 200 } });
    closedMission(wm, { id: 'm1', at: base - 2000 });
    closedMission(wm, { id: 'm2', at: base - 1000 });
    const report = wm.pruneEpisodic({ keepMissions: 1, dryRun: false });
    const round = JSON.parse(JSON.stringify(report));
    assert.equal(round.dryRun, false);
    assert.equal(round.deleted.missions, 1);
    assert.equal(round.details.length, 1);
    assert.equal(round.details[0].mission, 'm1', 'la finestra tiene la missione più recente (m2)');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- retention del log delle osservazioni -------------------------------------
// Il log è l'evidenza; la conoscenza è la sua proiezione. Si tengono le
// `keepPerFact` letture più recenti per (soggetto, predicato, oggetto): la
// proiezione usa comunque la più recente, quindi l'evidenza superata è ridondante.

const logFact = (wm, { subject = 'cave_07', predicate = 'contains', object = 'iron_ore', times = [] }) => {
  for (const at of times) wm.observe({ subject, predicate, object, observedAt: at, source: 'test' });
};

for (const backend of BACKENDS) {
  test(`[${backend}] observation pruning is a dry-run by default and keeps the newest per fact`, () => withMemory(backend, (wm) => {
    const base = Date.now();
    logFact(wm, { times: [base - 4000, base - 3000, base - 2000, base - 1000] });
    logFact(wm, { subject: 'cave_08', object: 'gold_ore', times: [base - 2000] });
    assert.equal(wm.observationCount(), 5);

    const dry = wm.pruneObservations({ keepPerFact: 2 });
    assert.equal(dry.dryRun, true, 'senza dryRun:false non si cancella');
    assert.equal(dry.facts, 2, 'due fatti distinti');
    assert.equal(dry.kept, 3, '2 del primo fatto + 1 del secondo');
    assert.equal(dry.deleted.observations, 2);
    assert.equal(wm.observationCount(), 5, 'il dry-run non tocca il log');

    const real = wm.pruneObservations({ keepPerFact: 2, dryRun: false });
    assert.equal(real.deleted.observations, 2);
    assert.equal(wm.observationCount(), 3);
    const left = wm.observations({ subject: 'cave_07' }).map(o => o.observedAt);
    assert.deepEqual(left, [base - 1000, base - 2000], 'restano le due letture più recenti, dal più recente');
    assert.equal(wm.observations({ subject: 'cave_08' }).length, 1, 'l\'altro fatto è intatto');
  }, { observationDedupeMs: 0 }));

  test(`[${backend}] minAgeMs protects the recent evidence`, () => withMemory(backend, (wm) => {
    const base = Date.now();
    logFact(wm, { times: [base - 5000, base - 100] });

    const report = wm.pruneObservations({ keepPerFact: 1, minAgeMs: 60000, dryRun: false });
    assert.equal(report.deleted.observations, 0);
    assert.equal(report.skipped.tooYoung, 1, 'la lettura superata ma recente resta');
    assert.equal(wm.observationCount(), 2);
  }, { observationDedupeMs: 0 }));

  test(`[${backend}] pruning superseded evidence never changes the projection`, () => withMemory(backend, (wm) => {
    const base = Date.now();
    wm.rememberResourceSite({ id: 'cave_07', kind: 'cave', position: { x: 100, y: 64, z: 200 }, observations: ['iron_ore'] });
    // Evidenza superata: due letture più vecchie dello stesso fatto.
    wm.observe({ subject: 'cave_07', predicate: 'contains', object: 'gold_ore', observedAt: base - 1000, source: 'test' });
    wm.observe({ subject: 'cave_07', predicate: 'contains', object: 'diamond', observedAt: base - 5000, source: 'test' });
    wm.materialize();
    const before = JSON.stringify(wm.getRecord('cave_07'));
    assert.ok(before.includes('iron_ore'), 'il nodo ha la sua osservazione di risorsa');

    const report = wm.pruneObservations({ keepPerFact: 0, dryRun: false });
    assert.ok(report.deleted.observations >= 3, `evidenza potata (${report.deleted.observations})`);
    assert.equal(wm.observationCount(), 0, 'il log è vuoto');
    wm.materialize();
    assert.equal(JSON.stringify(wm.getRecord('cave_07')), before, 'la proiezione (il nodo) non cambia');
  }, { observationDedupeMs: 0 }));

  test(`[${backend}] the observation pruning report is JSON-serializable and bounded`, () => withMemory(backend, (wm) => {
    const base = Date.now();
    const times = [];
    for (let i = 0; i < 40; i++) times.push(base - (40 - i) * 1000);
    logFact(wm, { times });
    const report = JSON.parse(JSON.stringify(wm.pruneObservations({ keepPerFact: 5, dryRun: false })));
    assert.equal(report.deleted.observations, 35);
    assert.equal(report.kept, 5);
    assert.equal(report.total, 40);
    assert.equal(report.details.length, 20, 'i dettagli sono limitati a 20 voci');
    assert.equal(wm.observationCount(), 5);
  }, { observationDedupeMs: 0 }));
}
