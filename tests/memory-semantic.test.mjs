// Recall semantico sopra la memoria strutturata (P6): l'indice vettoriale è un
// indice *derivato* — SQLite resta la fonte di verità — e serve dove la ricerca
// per campo non sa rispondere. Qui si verifica, con una prova comparativa sullo
// stesso caso concreto, che il percorso vettoriale recupera la località giusta
// dove quello per parola chiave non può, e che il consolidamento di P0 (hint di
// produttività) *migliora* il punteggio del sito che ha davvero funzionato.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorldMemory } from '../world-memory.mjs';

const quiet = { warn () {} };
const BACKENDS = ['json', 'sqlite'];

const withMemory = (backend, fn, options = {}) => {
  const dir = mkdtempSync(join(tmpdir(), `mc-sem-${backend}-`));
  try {
    const wm = createWorldMemory({ dir, backend, logger: quiet, ...options });
    return fn(wm, dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

// Un mondo minimo con due grotte (una provata, una no) e un baule con del ferro.
const seedWorld = (wm) => {
  wm.rememberResourceSite({ id: 'cave_rich', kind: 'cave', position: { x: 120, y: 45, z: 120 }, observations: ['iron_ore', 'iron_ore', 'coal_ore'], tags: ['underground'] });
  wm.rememberResourceSite({ id: 'cave_barren', kind: 'cave', position: { x: 300, y: 40, z: 300 }, observations: ['coal_ore'], tags: ['underground'] });
  wm.rememberResourceSite({ id: 'sand_pit', kind: 'surface_ores', position: { x: 200, y: 70, z: 200 }, observations: ['sand', 'gravel'] });
  const chest = wm.rememberContainer({ type: 'chest', position: { x: 10, y: 64, z: 10 }, contents: { iron_ore: 3, torch: 2 } });
  return { chest };
};

// Una missione chiusa con successo *sul* sito: è la strada che il runtime usa
// davvero (azione registrata con posizione → consolidamento → hint).
const runMission = (wm, { id, resource = 'iron_ore', node = 'cave_rich', outcome = 'ok' }) => {
  const mission = wm.createMission({ id, type: 'collect_resource', target: `resource:${resource}`, intent: 'collect_resource' });
  wm.linkMission(mission.id, 'targets', node);
  wm.linkMission(mission.id, 'seeks', `resource:${resource}`);
  wm.recordAction({ missionId: mission.id, actionType: `mine_${resource}`, outcome: 'ok' });
  if (outcome === 'ok') wm.finishMission(mission.id, { outcome: 'found', success: true, state: 'found' });
  else wm.finishMission(mission.id, { outcome: 'failed', success: false, state: 'failed', failureReason: 'not_found' });
  return mission;
};

for (const backend of BACKENDS) {
  test(`[${backend}] semantic search answers a natural-language query the keyword path cannot`, () => withMemory(backend, (wm) => {
    seedWorld(wm);

    // --- baseline: il percorso per parola chiave -------------------------------
    // La memoria strutturata si interroga per *valori esatti* (`contains` confronta
    // le osservazioni/tag), quindi i termini della query in linguaggio naturale non
    // trovano nulla...
    const perToken = ['iron', 'rich', 'mountain'].map((t) => wm.findResources({ contains: t }).length);
    assert.deepEqual(perToken, [0, 0, 0], 'nessun termine della query è un valore esatto della memoria');
    // ...e il filtro per tipo produce un insieme *non ordinato*: con due grotte non
    // c'è modo di preferire quella ricca di ferro.
    const caves = wm.findResources({ type: 'cave' });
    assert.equal(caves.length, 2);
    assert.equal(caves.every((c) => c.score === undefined), true, 'il percorso strutturato non produce pertinenza');
    assert.equal(wm.findResources({ contains: 'iron_ore' }).length, 1, 'solo nominando la risorsa esatta il filtro è utile');

    // --- percorso vettoriale ---------------------------------------------------
    const hits = wm.semanticSearch('the iron rich cave near the mountain', { limit: 3 });
    assert.equal(hits.length >= 1, true);
    assert.equal(hits[0].id, 'cave_rich', 'precision@1 = 1: la grotta col ferro, non una grotta qualunque');
    assert.equal(hits[0].type, 'cave');
    assert.equal(hits[0].position.x, 120, 'il risultato resta pianificabile (posizione)');
    assert.equal(hits.some((h) => h.id === 'sand_pit'), false, 'il sito di sabbia non ha nulla in comune con la query');
    const barrenRank = hits.findIndex((h) => h.id === 'cave_barren');
    assert.equal(barrenRank === -1 || barrenRank > 0, true, 'una grotta senza ferro non batte quella col ferro');

    // La query "baule" trova il contenitore per la parola giusta.
    const chestHits = wm.semanticSearch('chest with iron ore', { limit: 3 });
    assert.equal(chestHits[0].id, wm.containerId({ x: 10, y: 64, z: 10 }));
  }));

  test(`[${backend}] the P0 consolidation raises the score of the site that actually worked`, () => withMemory(backend, (wm) => {
    seedWorld(wm);
    const before = wm.semanticSearch('iron rich cave', { limit: 3 });
    assert.equal(before[0].id, 'cave_rich');
    assert.equal(before[0].productivity, null, 'prima del consolidamento nessun hint');

    runMission(wm, { id: 'm_ok' });
    const hint = wm.productivityHints({ node: 'cave_rich', resource: 'iron_ore' })[0];
    assert.equal(hint.successes, 1, 'il consolidamento ha prodotto il hint');

    const after = wm.semanticSearch('iron rich cave', { limit: 3, refresh: true });
    assert.equal(after[0].id, 'cave_rich', 'il sito provato resta il primo');
    const gain = after[0].score - before[0].score;
    assert.equal(gain > 0, true, `il hint di produttività alza il punteggio (${before[0].score} → ${after[0].score})`);
    assert.equal(after[0].productivity.iron_ore.successes, 1, 'il risultato porta con sé il hint');

    // Una missione *fallita* sulle stesse coordinate non cancella il valore, ma
    // lascia una traccia che il testo indicizza (utile per evitare il sito).
    runMission(wm, { id: 'm_fail', outcome: 'fail' });
    const contradicted = wm.productivityHints({ node: 'cave_rich', resource: 'iron_ore' })[0];
    assert.equal(contradicted.contradicted, true);
    const afterFail = wm.semanticSearch('iron rich cave', { limit: 3, refresh: true });
    assert.equal(afterFail[0].id, 'cave_rich', 'la contraddizione non fa sparire la località');
  }));

  test(`[${backend}] the vector index is derived: cached, invalidated by writes, never the source of truth`, () => withMemory(backend, (wm) => {
    seedWorld(wm);

    assert.equal(wm.vectorIndex().size >= 4, true, 'un documento per luogo con testo utile');
    // I nodi-concetto non sono destinazioni: stesso `kind` di un luogo ma senza posizione.
    wm.rememberConcept({ kind: 'structure', label: 'cave' });
    const withConcept = wm.vectorIndex({ refresh: true });
    assert.equal(withConcept.search('cave', { limit: 10 }).every((h) => !h.id.startsWith('structure:')), true, 'i concetti restano fuori indice');
    assert.equal(withConcept.size, wm.vectorIndex().size, 'nessun documento in più');
    const first = wm.vectorIndex();
    assert.equal(wm.vectorIndex(), first, 'la cache viene riusata entro il TTL');

    // Una scrittura marca l indice come da ricostruire.
    wm.rememberResourceSite({ id: 'cave_new', kind: 'cave', position: { x: 400, y: 30, z: 400 }, observations: ['diamond_ore'] });
    assert.notEqual(wm.vectorIndex(), first, 'dopo una scrittura l indice è ricostruito');
    assert.equal(wm.semanticSearch('diamond vein', { limit: 3 })[0].id, 'cave_new');

    // Il TTL scade: l indice si ricostruisce anche senza scritture.
    const tiny = createWorldMemory({ repo: wm.repo, backend: null, logger: quiet, vectorTtlMs: 0 });
    assert.notEqual(tiny.vectorIndex(), tiny.vectorIndex(), 'TTL 0 ⇒ ricostruzione a ogni richiesta');

    // Cancellare dal grafo toglie il documento dall indice.
    wm.removeContainer(wm.containerId({ x: 10, y: 64, z: 10 }));
    const hits = wm.semanticSearch('chest with iron ore', { limit: 3, refresh: true });
    assert.equal(hits.some((h) => h.id.startsWith('container_')), false, 'nessun fantasma: l indice è derivato dai record vivi');

    // SQLite/JSON restano la verità: la ricerca non inventa record inesistenti.
    for (const hit of wm.semanticSearch('cave ore', { limit: 10 })) {
      assert.equal(wm.repo.get(hit.id) != null, true, `hit ${hit.id} assente dal repository`);
    }
  }));

  test(`[${backend}] semantic search handles empty and unknown queries without inventing hits`, () => withMemory(backend, (wm) => {
    seedWorld(wm);
    assert.deepEqual(wm.semanticSearch('', { limit: 5 }), []);
    assert.deepEqual(wm.semanticSearch('the near', { limit: 5 }), []);
    assert.deepEqual(wm.semanticSearch('quantum tractor', { limit: 5 }), [], 'nessun termine in comune ⇒ nessun risultato');
    assert.equal(wm.semanticSearch('cave', { limit: 1 }).length, 1, 'limit');
    assert.equal(wm.semanticSearch('cave', { limit: 5, filter: (h) => h.kind === 'resource_site' }).length >= 1, true);
  }));

  test(`[${backend}] a long productive node is not beaten by collisions on other places`, () => withMemory(backend, (wm) => {
    // Molti luoghi "rumorosi" (strutture con etichette lunghe) e un solo sito
    // provato: la query deve scegliere il sito che ha davvero prodotto cibo, non un
    // luogo che per caso condivide una dimensione dell'hash.
    for (let i = 0; i < 12; i++) {
      wm.rememberStructure({
        id: `structure_cave_${110 + i}_71_${140 + i}`, type: 'cave', label: 'Open cave',
        position: { x: 110 + i, y: 71, z: 140 + i },
        evidence: { score: 3, matched: ['air below'], missing: ['cave air (0/32)'] },
      });
    }
    wm.rememberResourceSite({ id: 'resource_site_7_9', kind: 'surface_ores', position: { x: 120, y: 75, z: 152 }, observations: ['dirt', 'potatoes', 'carrots', 'oak_log'] });
    const mission = wm.createMission({ id: 'm_food', type: 'collect_resource', target: 'resource:potatoes', intent: 'collect_resource' });
    wm.linkMission(mission.id, 'targets', 'resource_site_7_9');
    wm.linkMission(mission.id, 'seeks', 'resource:potatoes');
    wm.recordAction({ missionId: mission.id, actionType: 'mine_potatoes', outcome: 'ok' });
    wm.finishMission(mission.id, { outcome: 'found', success: true, state: 'found' });

    const hits = wm.semanticSearch('where did I find potatoes and carrots', { limit: 3, refresh: true });
    assert.equal(hits[0].id, 'resource_site_7_9', `il sito provato deve vincere (${hits.map((h) => `${h.id}:${h.score}`).join(', ')})`);
    assert.equal(hits[0].position.x, 120, 'il risultato resta pianificabile');
    assert.equal(hits[0].productivity.potatoes.successes, 1, 'con il hint del consolidamento');
  }));
}
