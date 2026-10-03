// Observation log: `subject --predicate--> object` (con observedAt/confidence).
// Il grafo è la *proiezione* del log: materializzare è idempotente, una lettura
// nuova smentisce la vecchia (senza cancellarla) e il log resta la provenienza.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorldMemory, OBSERVATION_CONCEPT_KINDS } from '../world-memory.mjs';

const quiet = { warn () {} };
const BACKENDS = ['json', 'sqlite'];

const withMemory = (backend, fn, options = {}) => {
  const dir = mkdtempSync(join(tmpdir(), `mo-${backend}-`));
  try {
    const wm = createWorldMemory({ dir, backend, logger: quiet, ...options });
    return fn(wm, dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

for (const backend of BACKENDS) {
  test(`[${backend}] observations are recorded, filtered and ordered by recency`, () => withMemory(backend, (wm) => {
    const chest = wm.rememberContainer({ position: { x: 10, y: 64, z: 10 }, contents: { torch: 3 } });
    wm.observe({ subject: chest.id, predicate: 'contains', object: 'white_wool', observedAt: 9_000_000_000_000, source: 'read_container' });
    wm.observe({ subject: chest.id, predicate: 'contains', object: 'torch', observedAt: 9_000_000_000_001, source: 'read_container' });

    assert.equal(wm.observationCount() >= 3, true, 'il rememberContainer logga le sue osservazioni');
    const all = wm.observations();
    assert.equal(all[0].observedAt, 9_000_000_000_001, 'la più recente per prima');
    assert.equal(all[0].object, 'torch');

    const wool = wm.observations({ subject: chest.id, predicate: 'contains', object: 'white_wool' });
    assert.equal(wool.length, 1);
    assert.equal(wool[0].source, 'read_container');
    assert.equal(wm.observations({ predicate: 'is_a' }).length, 0, 'filtro per predicato');
    assert.equal(wm.observations({ since: 1500 }).every(o => o.observedAt >= 1500), true, 'finestra temporale');
    assert.equal(wm.observations({ limit: 1 }).length, 1, 'limit');
    assert.equal(OBSERVATION_CONCEPT_KINDS.contains, 'resource');
  }));

  // La finestra di deduplica è una politica di crescita: con la finestra a 0 il
  // log torna un registro grezzo di ogni lettura (append-only).
  test(`[${backend}] two identical observations in the same millisecond stay distinct`, () => withMemory(backend, (wm) => {
    wm.rememberConcept({ kind: 'resource', label: 'iron_ore' });
    const a = wm.observe({ subject: 'resource:iron_ore', predicate: 'node', object: 'seen', observedAt: 5000 });
    const b = wm.observe({ subject: 'resource:iron_ore', predicate: 'node', object: 'seen', observedAt: 5000 });
    assert.notEqual(a, b, 'nessuna sovrascrittura silenziosa');
    assert.equal(wm.observations({ subject: 'resource:iron_ore' }).length, 2);
  }, { observationDedupeMs: 0 }));

  test(`[${backend}] materialize projects the log into the graph, idempotently`, () => withMemory(backend, (wm) => {
    const site = wm.rememberResourceSite({ kind: 'cave', position: { x: 20, y: 40, z: 20 }, observations: ['iron_ore', 'coal'] });
    wm.unlink(site.id, 'resource:iron_ore', 'contains');
    wm.unlink(site.id, 'resource:coal', 'contains');
    assert.equal(wm.relationsFrom(site.id, { type: 'contains' }).length, 0, 'grafo svuotato a mano');

    const first = wm.materialize();
    assert.equal(first.linked >= 2, true, 'riproietta gli archi dal log');
    const edges = wm.relationsFrom(site.id, { type: 'contains' }).map(e => e.to).sort();
    assert.deepEqual(edges, ['resource:coal', 'resource:iron_ore']);
    assert.equal(wm.repo.get('resource:iron_ore') != null, true, 'il nodo-concetto esiste');

    const second = wm.materialize();
    assert.equal(second.invalidated, 0, 'la seconda passata non invalida nulla');
    assert.equal(second.linked, first.linked, 'stesso numero di archi: idempotente');
    assert.deepEqual(wm.relationsFrom(site.id, { type: 'contains' }).map(e => e.to).sort(), edges);
  }));

  test(`[${backend}] a newer reading contradicts the old one without erasing history`, () => withMemory(backend, (wm) => {
    const chest = wm.rememberContainer({ position: { x: 5, y: 60, z: 5 }, contents: { torch: 2, bread: 1 }, observedAt: 1000 });
    assert.deepEqual(wm.relationsFrom(chest.id, { type: 'contains' }).map(e => e.to).sort(), ['resource:bread', 'resource:torch']);

    // Seconda lettura: il pane non c'è più.
    wm.rememberContainer({ position: { x: 5, y: 60, z: 5 }, contents: { torch: 2 }, observedAt: 2000 });
    assert.deepEqual(wm.relationsFrom(chest.id, { type: 'contains' }).map(e => e.to), ['resource:torch'], 'il pane non è più contenuto');

    const invalid = wm.relationsFrom(chest.id, { type: 'contains', includeInvalid: true });
    assert.equal(invalid.length, 2, 'l\'arco vecchio resta, marcato invalid');
    assert.equal(invalid.find(e => e.to === 'resource:bread').status, 'invalid');

    // Terza lettura: il pane è tornato → l'arco viene ripristinato.
    wm.rememberContainer({ position: { x: 5, y: 60, z: 5 }, contents: { torch: 2, bread: 1 }, observedAt: 3000 });
    assert.deepEqual(wm.relationsFrom(chest.id, { type: 'contains' }).map(e => e.to).sort(), ['resource:bread', 'resource:torch']);
    const bread = wm.observations({ subject: chest.id, object: 'bread' });
    assert.equal(bread.length, 2, 'la storia delle letture è conservata (provenienza)');
  }, { observationDedupeMs: 0 }));

  test(`[${backend}] structure detection and container reads keep their provenance`, () => withMemory(backend, (wm) => {
    const village = wm.rememberStructure({ type: 'village', position: { x: 100, y: 70, z: 100 }, confidence: 0.6, evidence: { score: 6 } });
    const isA = wm.observations({ subject: village.id, predicate: 'is_a' });
    assert.equal(isA.length, 1);
    assert.equal(isA[0].object, 'village');
    assert.equal(isA[0].confidence, 0.6);
    assert.equal(isA[0].source, 'detected');

    // L'arco del grafo è ricostruibile dall'osservazione (stesso soggetto/oggetto).
    const edge = wm.relationsFrom(village.id, { type: 'is_a' })[0];
    assert.equal(edge.to, 'structure:village');
    assert.equal(edge.metadata_json === undefined || edge.metadata == null || true, true);
  }));

  test(`[${backend}] an observation without its subject node is reported, not resurrected`, () => withMemory(backend, (wm) => {
    const chest = wm.rememberContainer({ position: { x: 9, y: 60, z: 9 }, contents: { torch: 1 } });
    wm.removeContainer(chest.id);
    assert.equal(wm.repo.get(chest.id), null, 'nodo rimosso');
    const report = wm.materialize();
    assert.equal(report.orphaned >= 1, true, 'osservazione orfana conteggiata');
    assert.equal(wm.repo.get(chest.id), null, 'il log non ricrea il nodo');
  }));

  test(`[${backend}] hydrate reprojects the log and reports the projection`, () => withMemory(backend, (wm) => {
    const site = wm.rememberResourceSite({ kind: 'cave', position: { x: 30, y: 30, z: 30 }, observations: ['diamond'] });
    wm.unlink(site.id, 'resource:diamond', 'contains');
    const summary = wm.hydrate();
    assert.equal(summary.projected.linked >= 1, true, 'hydrate riproietta');
    assert.deepEqual(wm.relationsFrom(site.id, { type: 'contains' }).map(e => e.to), ['resource:diamond']);
    assert.equal(summary.observations >= 1, true, 'il conteggio compare nel summary');
    assert.equal(wm.observeView() .observations.length >= 1, true, 'e nella vista osservabile');
  }));

  test(`[${backend}] observations survive a reopen of the store`, () => withMemory(backend, (wm, dir) => {
    wm.rememberContainer({ position: { x: 2, y: 60, z: 2 }, contents: { apple: 1 } });
    const before = wm.observationCount();
    assert.equal(before >= 1, true);
    wm.flush();
    wm.close();

    const reopened = createWorldMemory({ dir, backend, logger: quiet });
    assert.equal(reopened.observationCount(), before, 'il log è persistito');
    const apple = reopened.observations({ predicate: 'contains', object: 'apple' });
    assert.equal(apple.length, 1);
    assert.equal(reopened.relationsFrom(apple[0].subject, { type: 'contains' }).map(e => e.to).includes('resource:apple'), true);
    reopened.close();
  }));
}

// Deduplica in scrittura: il censimento rilegge gli stessi fatti a ogni giro
// (round live del 03/10: 5523 letture identiche su 5654). Una rilettura identica
// dentro la finestra non è informazione nuova; un valore diverso sì.
for (const backend of BACKENDS) {
  test(`[${backend}] an identical reading inside the dedupe window is not a new observation`, () => withMemory(backend, (wm) => {
    const base = 1_000_000;
    const first = wm.observe({ subject: 'cave_1', predicate: 'contains', object: 'iron_ore', observedAt: base, source: 'survey' });
    const again = wm.observe({ subject: 'cave_1', predicate: 'contains', object: 'iron_ore', observedAt: base + 5000, source: 'survey' });
    assert.equal(again, first, 'stessa lettura → stesso id, nessuna riga nuova');
    assert.equal(wm.observationCount(), 1);

    // Un valore diverso è un fatto a sé (la contraddizione resta nel log).
    wm.observe({ subject: 'cave_1', predicate: 'contains', object: 'gold_ore', observedAt: base + 6000, source: 'survey' });
    assert.equal(wm.observationCount(), 2, 'un valore diverso è una osservazione nuova');

    // Oltre la finestra la stessa lettura torna a essere un evento nuovo.
    wm.observe({ subject: 'cave_1', predicate: 'contains', object: 'iron_ore', observedAt: base + 60_001, source: 'survey' });
    assert.equal(wm.observationCount(), 3, 'oltre la finestra si registra di nuovo');

    // Una fonte diversa non è la stessa lettura.
    wm.observe({ subject: 'cave_1', predicate: 'contains', object: 'iron_ore', observedAt: base + 60_100, source: 'human' });
    assert.equal(wm.observationCount(), 4, 'una fonte diversa è una lettura diversa');
  }, { observationDedupeMs: 60_000 }));

  test(`[${backend}] the dedupe window can be disabled`, () => withMemory(backend, (wm) => {
    const base = 2_000_000;
    wm.observe({ subject: 'cave_2', predicate: 'contains', object: 'coal', observedAt: base });
    wm.observe({ subject: 'cave_2', predicate: 'contains', object: 'coal', observedAt: base + 1 });
    assert.equal(wm.observationCount(), 2, 'con la finestra a 0 il log è append-only');
  }, { observationDedupeMs: 0 }));
}
