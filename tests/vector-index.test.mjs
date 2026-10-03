// Indice vettoriale derivato (recall semantico). Modulo puro: nessuna dipendenza,
// nessun modello esterno, stesso testo → stesso vettore.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DIMS, VectorIndex, cosine, documentText, embed, tokenize } from '../vector-index.mjs';

test('tokenize normalizza, rimuove accenti, stopword e token troppo corti', () => {
  assert.deepEqual(tokenize('The Iron-Rich CAVE near the mountain!'), ['iron', 'rich', 'cave', 'mountain']);
  assert.deepEqual(tokenize('città, perché caffè'), ['citta', 'perche', 'caffe']);
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
  assert.deepEqual(tokenize('a b c de'), ['de'], 'i token di una lettera non portano informazione');
});

test('embed è deterministico, normalizzato e di dimensione fissa', () => {
  const a = embed('iron ore cave');
  const b = embed('iron ore cave');
  assert.equal(a.length, DEFAULT_DIMS);
  assert.deepEqual(a, b, 'stesso testo → stesso vettore');
  const norm = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  assert.equal(Math.abs(norm - 1) < 1e-9, true, `norma L2 = 1 (era ${norm})`);
  // Il testo vuoto (o di sole stopword) non produce una direzione.
  assert.equal(embed('').every((v) => v === 0), true);
  assert.equal(embed('the near').every((v) => v === 0), true);
  // `dims` è configurabile.
  assert.equal(embed('iron ore', { dims: 32 }).length, 32);
});

test('cosine misura la sovrapposizione dei termini', () => {
  const q = embed('iron cave');
  assert.equal(Math.abs(cosine(q, embed('iron cave')) - 1) < 1e-9, true);
  assert.equal(cosine(embed('iron cave'), embed('wool banner')) > 0.35, false, 'nessun termine condiviso');
  assert.equal(cosine(q, null), 0);
  assert.equal(cosine([1], [1, 2]), 0, 'dimensioni diverse non sono confrontabili');
});

test('documentText indicizza descrizione, osservazioni, contenuto e produttività', () => {
  const text = documentText({
    id: 'resource_site_7_9',
    kind: 'resource_site',
    type: 'cave',
    label: null,
    biome: 'plains',
    dimension: 'overworld',
    tags: ['underground'],
    observations: ['iron_ore', 'coal_ore'],
    // P0: il consolidamento entra nel testo indicizzato.
    productivity: { iron_ore: { found: 3, attempts: 4, successes: 1, failures: 3 } },
  });
  for (const term of ['cave', 'plains', 'underground', 'iron_ore', 'coal_ore', 'rich', 'productive']) {
    assert.equal(text.includes(term), true, `manca "${term}" in: ${text}`);
  }
  // Coordinate e conteggi non entrano nel testo: non sono parole utili al recall.
  assert.equal(text.includes('120'), false);
  assert.equal(text.includes('found 3'), false);
  // Un sito mai provato non dichiara produttività.
  const unproven = documentText({ id: 'x', kind: 'resource_site', type: 'cave' });
  assert.equal(unproven.includes('proven'), false);
  assert.equal(unproven.includes('empty'), false);
  // Un sito provato e fallito lo dichiara (utile per *evitarlo*).
  const failed = documentText({ id: 'y', kind: 'resource_site', type: 'cave', productivity: { iron_ore: { attempts: 2, failures: 2 } } });
  assert.equal(failed.includes('unproductive'), true);
  assert.equal(documentText(null), '');
});

test('search ordina per similarità e rispetta limit/minScore', () => {
  const index = new VectorIndex({ dims: 64 });
  index.add({ id: 'cave', text: 'resource site cave underground iron ore iron ore' });
  index.add({ id: 'chest', text: 'container chest with iron ore' });
  index.add({ id: 'wool', text: 'container chest with white wool' });

  const hits = index.search('the iron rich cave', { limit: 3 });
  assert.equal(hits[0].id, 'cave');
  assert.equal(hits[0].score > hits[1].score, true);
  assert.equal(hits.some((h) => h.id === 'wool'), false, 'zero similarità ⇒ fuori dal ranking');
  assert.equal(hits[0].text.includes('cave'), true, 'il testo indicizzato resta ispezionabile');

  assert.equal(index.search('iron', { limit: 1 }).length, 1, 'limit');
  assert.equal(index.search('iron', { minScore: 0.9 }).length, 0, 'minScore');
  assert.equal(index.search('', { limit: 3 }).length, 0, 'query senza termini utili');
  assert.equal(index.search('the near', { limit: 3 }).length, 0, 'query di sole stopword');
  assert.equal(index.search('iron', { filter: (h) => h.id === 'wool' }).length, 0, 'filter');
});

test('add/remove/clear e id obbligatorio', () => {
  const index = new VectorIndex({ dims: 32 });
  assert.equal(index.size, 0);
  assert.equal(index.add({ id: 'a', text: 'iron ore' }), 'a');
  assert.equal(index.add({ id: 'b', text: '   ' }), null, 'testo vuoto: niente documento');
  assert.equal(index.size, 1);
  index.addRecord({ id: 'c', kind: 'landmark', type: 'home', label: 'casa' });
  assert.equal(index.size, 2);
  assert.equal(index.remove('a'), true);
  assert.equal(index.remove('a'), false);
  assert.equal(index.size, 1);
  assert.throws(() => index.add({ text: 'iron' }), /needs an id/);
  index.clear();
  assert.equal(index.size, 0);
  assert.equal(index.search('casa').length, 0);
});

test('il ranking è stabile a parità di punteggio (tie-break sull id)', () => {
  const index = new VectorIndex({ dims: 32 });
  index.add({ id: 'b', text: 'iron ore' });
  index.add({ id: 'a', text: 'iron ore' });
  const hits = index.search('iron ore', { limit: 2 });
  assert.deepEqual(hits.map((h) => h.id), ['a', 'b']);
  assert.equal(hits[0].score, hits[1].score);
});
