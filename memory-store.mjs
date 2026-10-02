// JSON memory repository — fallback / test del repository SQLite.
//
// Stessa interfaccia di `sqlite-memory.mjs` (nodi + archi), così il service
// `WorldMemory` e il planner non sanno dove sono i dati. Persistenza atomica
// (tmp + rename). I nodi sono spatial (con coordinate) o conceptual (senza);
// gli archi stanno a parte (`relations`), come in SQLite.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MEMORY_SCHEMA_VERSION = 3;

const edgeKey = (from, type, to) => `${from}|${type}|${to}`;

export class JsonMemoryRepository {
  constructor ({ dir = null, logger = console, version = MEMORY_SCHEMA_VERSION } = {}) {
    this.dir = dir;
    this.logger = logger;
    this.version = version;
    this.records = new Map();
    this.relations = new Map();
    this.dirty = false;
  }

  get file () {
    return this.dir ? join(this.dir, 'world.json') : null;
  }

  load () {
    if (!this.dir) return this;
    mkdirSync(this.dir, { recursive: true });
    const file = this.file;
    if (!existsSync(file)) return this;
    let raw;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      this.logger?.warn?.(`[memory] world.json corrotto (${error.message}); riparto vuoto`);
      try { renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* ignora */ }
      return this;
    }
    for (const record of Array.isArray(raw?.records) ? raw.records : []) {
      if (record?.id != null) this.records.set(record.id, record);
    }
    for (const relation of Array.isArray(raw?.relations) ? raw.relations : []) {
      if (relation?.id != null) this.relations.set(relation.id, relation);
    }
    return this;
  }

  get (id) {
    return this.records.get(id) ?? null;
  }

  upsert (record) {
    if (!record?.id) throw new Error('memory record needs an id');
    const p = record.position ?? null;
    // Come lo storage SQLite: categoria e chunk derivati.
    this.records.set(record.id, {
      ...record,
      category: record.category ?? (p ? 'spatial' : 'conceptual'),
      chunk: p ? { x: Math.floor(p.x / 16), z: Math.floor(p.z / 16) } : undefined,
    });
    this.dirty = true;
    return record.id;
  }

  find ({ kind = null, kinds = null, category = null, excludeKind = null, type = null, tag = null, statuses = null, includeInvalid = false, dimension = null, biome = null, relation = null, limit = null } = {}) {
    let out = [...this.records.values()];
    if (kind) out = out.filter(r => r.kind === kind);
    if (Array.isArray(kinds) && kinds.length) out = out.filter(r => kinds.includes(r.kind));
    if (category) out = out.filter(r => r.category === category);
    if (excludeKind) out = out.filter(r => r.kind !== excludeKind);
    if (dimension) out = out.filter(r => r.dimension === dimension);
    if (biome) out = out.filter(r => r.biome === biome);
    if (type) out = out.filter(r => r.type === type || (r.tags || []).includes(type));
    if (tag) out = out.filter(r => (r.tags || []).includes(tag));
    if (Array.isArray(statuses) && statuses.length) out = out.filter(r => statuses.includes(r.status));
    else if (!includeInvalid) out = out.filter(r => r.status !== 'invalid');
    if (relation && relation.type && relation.target) {
      const side = relation.direction === 'to' ? 'to' : 'from';
      const other = relation.direction === 'to' ? 'from' : 'to';
      const linked = new Set([...this.relations.values()]
        .filter(e => e.type === relation.type && e.status !== 'invalid' && e[other] === relation.target)
        .map(e => e[side]));
      out = out.filter(r => linked.has(r.id));
    }
    if (limit != null) out = out.slice(0, limit);
    return out;
  }

  remove (id) {
    for (const [key, e] of [...this.relations]) if (e.from === id || e.to === id) this.relations.delete(key);
    const removed = this.records.delete(id);
    if (removed) this.dirty = true;
    return removed;
  }

  upsertMany (records) {
    for (const record of records || []) this.upsert(record);
    return records?.length ?? 0;
  }

  markStaleBefore ({ kind = null, excludeKind = null, before }) {
    let count = 0;
    for (const r of this.records.values()) {
      if (kind && r.kind !== kind) continue;
      if (excludeKind && r.kind === excludeKind) continue;
      if (r.status === 'invalid' || r.status === 'stale') continue;
      if ((r.lastSeenAt ?? r.discoveredAt ?? 0) < before) { r.status = 'stale'; count++; this.dirty = true; }
    }
    return count;
  }

  count ({ kind = null } = {}) {
    if (!kind) return this.records.size;
    let n = 0;
    for (const r of this.records.values()) if (r.kind === kind) n++;
    return n;
  }

  relationCount () {
    return this.relations.size;
  }

  link ({ id = null, from, to, type, confidence = 1, status = 'known', firstSeenAt = null, lastSeenAt = null, metadata = {} }) {
    if (!from || !to || !type) throw new Error('link needs from, to and type');
    const key = id || edgeKey(from, type, to);
    const existing = this.relations.get(key);
    const now = Date.now();
    this.relations.set(key, {
      ...metadata,
      id: key, from, to, type, confidence, status,
      firstSeenAt: firstSeenAt ?? existing?.firstSeenAt ?? now,
      lastSeenAt: lastSeenAt ?? now,
    });
    this.dirty = true;
    return key;
  }

  unlink ({ id = null, from = null, to = null, type = null }) {
    let removed = false;
    if (id) removed = this.relations.delete(id);
    else if (from && to && type) removed = this.relations.delete(edgeKey(from, type, to));
    else throw new Error('unlink needs id or (from, to, type)');
    if (removed) this.dirty = true;
    return removed;
  }

  invalidateRelation ({ id = null, from = null, to = null, type = null, before = Date.now() }) {
    let n = 0;
    for (const e of this.relations.values()) {
      const match = id ? e.id === id : (e.from === from && e.to === to && e.type === type);
      if (match && e.status !== 'invalid') { e.status = 'invalid'; e.lastSeenAt = before; n++; this.dirty = true; }
    }
    return n;
  }

  _relations (predicate, { type = null, statuses = null, includeInvalid = false } = {}) {
    let out = [...this.relations.values()].filter(predicate);
    if (type) out = out.filter(e => e.type === type);
    if (Array.isArray(statuses) && statuses.length) out = out.filter(e => statuses.includes(e.status));
    else if (!includeInvalid) out = out.filter(e => e.status !== 'invalid');
    return out;
  }

  relationsFrom (id, options = {}) {
    return this._relations(e => e.from === id, options);
  }

  relationsTo (id, options = {}) {
    return this._relations(e => e.to === id, options);
  }

  flush () {
    if (!this.dirty || !this.dir) { this.dirty = false; return; }
    const file = this.file;
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({
      version: this.version,
      savedAt: Date.now(),
      records: [...this.records.values()],
      relations: [...this.relations.values()],
    }, null, 2)}\n`);
    renameSync(tmp, file);
    this.dirty = false;
  }

  close () {
    this.flush();
  }
}
