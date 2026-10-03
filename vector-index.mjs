// Vector index — recall *semantico* sopra la memoria strutturata.
//
// Non sostituisce SQLite: è un indice derivato, in memoria, costruito dai record
// del world graph e usato solo per rispondere a domande in linguaggio naturale
// ("la grotta ricca di ferro vicino alla montagna") dove la ricerca esatta per
// campo non sa scegliere fra più candidati.
//
// Nessuna dipendenza e nessun modello esterno: l'embedding è un **hashing
// vettoriale deterministico** (bag of words con IDF non necessaria, firma
// casuale per ridurre le collisioni, normalizzazione L2). Lo stesso testo produce
// sempre lo stesso vettore, quindi i test sono riproducibili e il ranking è
// spiegabile (la somiglianza è il coseno fra i termini condivisi).

// 2048 dimensioni: le collisioni fra termini diversi (che creano similarità
// spurie, l'unico vero rischio dell'hashing vettoriale) diventano rare, mentre il
// costo di un confronto resta trascurabile (una passata sui documenti).
export const DEFAULT_DIMS = 2048;

// Stopword inglesi + italiane (le query del bot sono in entrambe le lingue).
const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'and', 'or', 'is', 'are', 'was',
  'near', 'next', 'some', 'any', 'my', 'me', 'it', 'its', 'that', 'this', 'there', 'here', 'from',
  'di', 'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una', 'del', 'della', 'dei', 'delle',
  'e', 'ed', 'o', 'od', 'in', 'su', 'per', 'con', 'che', 'mi', 'mio', 'mia', 'vicino', 'accanto',
  'poi', 'piu', 'più', 'sono', 'era', 'al', 'allo', 'alla', 'ai', 'agli', 'alle', 'da', 'dal',
]);

// Tokenizzatore: minuscole, accenti rimossi, split non alfanumerico, stopword via.
export function tokenize (text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

// FNV-1a a 32 bit: deterministico e senza dipendenze.
function hash32 (text, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Embedding a firma casuale: ogni termine va in una dimensione (hash) con un
// segno (secondo hash) e peso `1 + ln(tf)`. Poi normalizzazione L2.
export function embed (text, { dims = DEFAULT_DIMS } = {}) {
  const vec = new Array(dims).fill(0);
  const counts = new Map();
  for (const term of tokenize(text)) counts.set(term, (counts.get(term) ?? 0) + 1);
  for (const [term, n] of counts) {
    const idx = hash32(term) % dims;
    const sign = (hash32(term, 0x9e3779b9) & 1) === 1 ? 1 : -1;
    vec[idx] += sign * (1 + Math.log(n));
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (!norm) return vec;
  return vec.map((v) => v / norm);
}

export function cosine (a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

// Le coordinate e i conteggi non entrano nel testo: la similarità deve venire dai
// *termini*, non da un numero che collide con altre dimensioni. La produttività
// entra invece come vocabolo (`rich`/`productive`/`unproductive`), così il
// consolidamento rende un sito simile a "la cava ricca di ferro" invece di vivere
// in una tabella a parte.
export function documentText (record) {
  if (!record) return '';
  const parts = [
    record.id, record.kind, record.type, record.label, record.biome, record.dimension,
  ];
  for (const tag of record.tags ?? []) parts.push(tag);
  for (const observation of record.observations ?? []) parts.push(observation);
  for (const item of Object.keys(record.contents ?? {})) parts.push(item);
  for (const [resource, hint] of Object.entries(record.productivity ?? {})) {
    parts.push(resource);
    if (hint.successes) parts.push('successful productive rich abundant proven');
    if (hint.failures && !hint.successes) parts.push('failed empty unproductive');
  }
  if (record.state && typeof record.state === 'object') {
    for (const [key, value] of Object.entries(record.state)) {
      if (typeof value === 'string') parts.push(key, value);
    }
  }
  return parts.filter(Boolean).join(' ');
}

export class VectorIndex {
  constructor ({ dims = DEFAULT_DIMS, logger = null } = {}) {
    this.dims = dims;
    this.logger = logger;
    this.vectors = new Map();   // id -> Float64Array-ish (Array)
    this.texts = new Map();     // id -> testo indicizzato
  }

  get size () {
    return this.vectors.size;
  }

  add ({ id, text }) {
    if (!id) throw new Error('VectorIndex.add needs an id');
    const clean = String(text ?? '').trim();
    if (!clean) return null;
    this.vectors.set(id, embed(clean, { dims: this.dims }));
    this.texts.set(id, clean);
    return id;
  }

  addRecord (record) {
    return this.add({ id: record?.id, text: documentText(record) });
  }

  remove (id) {
    this.texts.delete(id);
    return this.vectors.delete(id);
  }

  clear () {
    this.vectors.clear();
    this.texts.clear();
  }

  search (query, { limit = 5, minScore = 0, filter = null } = {}) {
    const terms = tokenize(query);
    if (!terms.length) return [];
    const q = embed(query, { dims: this.dims });
    const scored = [];
    for (const [id, vec] of this.vectors) {
      const score = cosine(q, vec);
      if (score <= minScore) continue;
      scored.push({ id, score: Math.round(score * 1000) / 1000, text: this.texts.get(id) ?? null });
    }
    scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    const hits = scored.slice(0, limit);
    return filter ? hits.filter((h) => filter(h)) : hits;
  }
}
