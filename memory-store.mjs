// JSON memory repository — fallback / test del repository SQLite.
//
// Stessa interfaccia di `sqlite-memory.mjs` (get/upsert/find/remove/
// markStaleBefore/count/flush/close) così il service `WorldMemory` e il
// planner non sanno dove sono i dati. Persistenza atomica (tmp + rename).
//
// Forma del record (condivisa con SQLite):
//   { id, kind, type, dimension, position:{x,y,z}, status, confidence,
//     discoveredAt, lastSeenAt, label?, tags?, source?, contents? }

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MEMORY_SCHEMA_VERSION = 2;

export class JsonMemoryRepository {
  constructor ({ dir = null, logger = console, version = MEMORY_SCHEMA_VERSION } = {}) {
    this.dir = dir;
    this.logger = logger;
    this.version = version;
    this.records = new Map();
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
    return this;
  }

  get (id) {
    return this.records.get(id) ?? null;
  }

  upsert (record) {
    if (!record?.id) throw new Error('memory record needs an id');
    this.records.set(record.id, { ...record });
    this.dirty = true;
    return record.id;
  }

  find ({ kind = null, kinds = null, excludeKind = null, type = null, tag = null, statuses = null, includeInvalid = false, dimension = null, limit = null } = {}) {
    let out = [...this.records.values()];
    if (kind) out = out.filter(r => r.kind === kind);
    if (Array.isArray(kinds) && kinds.length) out = out.filter(r => kinds.includes(r.kind));
    if (excludeKind) out = out.filter(r => r.kind !== excludeKind);
    if (dimension) out = out.filter(r => r.dimension === dimension);
    if (type) out = out.filter(r => r.type === type || (r.tags || []).includes(type));
    if (tag) out = out.filter(r => (r.tags || []).includes(tag));
    if (statuses) out = out.filter(r => statuses.includes(r.status));
    else if (!includeInvalid) out = out.filter(r => r.status !== 'invalid');
    if (limit != null) out = out.slice(0, limit);
    return out;
  }

  remove (id) {
    const removed = this.records.delete(id);
    if (removed) this.dirty = true;
    return removed;
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

  flush () {
    if (!this.dirty || !this.dir) { this.dirty = false; return; }
    const file = this.file;
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: this.version, savedAt: Date.now(), records: [...this.records.values()] }, null, 2)}\n`);
    renameSync(tmp, file);
    this.dirty = false;
  }

  close () {
    this.flush();
  }
}
