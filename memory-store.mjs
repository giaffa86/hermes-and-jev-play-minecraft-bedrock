// JSON memory repository — fallback / test del repository SQLite.
//
// Stessa interfaccia di `sqlite-memory.mjs` (nodi + archi), così il service
// `WorldMemory` e il planner non sanno dove sono i dati. Persistenza atomica
// (tmp + rename). I nodi sono spatial (con coordinate) o conceptual (senza);
// gli archi stanno a parte (`relations`), come in SQLite.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MEMORY_SCHEMA_VERSION = 5;

const edgeKey = (from, type, to) => `${from}|${type}|${to}`;
const missionEdgeKey = (missionId, type, targetId) => `${missionId}|${type}|${targetId}`;

export class JsonMemoryRepository {
  constructor ({ dir = null, logger = console, version = MEMORY_SCHEMA_VERSION } = {}) {
    this.dir = dir;
    this.logger = logger;
    this.version = version;
    this.records = new Map();
    this.relations = new Map();
    this._missionRelations = new Map();
    this.actionEvents = new Map();
    this._actionSeq = 0;   // garantisce id unici per evento d'azione (non persistito)
    this._observations = new Map();
    this._obsSeq = 0;      // id unici per osservazione (non persistito)
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
    for (const relation of Array.isArray(raw?.missionRelations) ? raw.missionRelations : []) {
      if (relation?.id != null) this._missionRelations.set(relation.id, relation);
    }
    for (const event of Array.isArray(raw?.actionEvents) ? raw.actionEvents : []) {
      if (event?.id != null) this.actionEvents.set(event.id, event);
    }
    for (const obs of Array.isArray(raw?.observations) ? raw.observations : []) {
      if (obs?.id != null) this._observations.set(obs.id, obs);
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

  markStaleBefore ({ kind = null, excludeKind = null, keepPermanent = false, before }) {
    let count = 0;
    for (const r of this.records.values()) {
      if (kind && r.kind !== kind) continue;
      if (excludeKind && r.kind === excludeKind) continue;
      // Un fatto *dettato* permanente non ha TTL: nessuno lo rinfrescherebbe, e la
      // scadenza lo declasserebbe solo perché è passato del tempo.
      if (keepPermanent && r.permanent === true) continue;
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

  missionRelationsCount () {
    return this._missionRelations.size;
  }

  actionEventCount () {
    return this.actionEvents.size;
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

  // ---- goal/episodico (mission_relation + action_event) ---------------------------

  linkMission ({ id = null, missionId, relationType, targetId, confidence = 1, status = 'known', metadata = {} }) {
    if (!missionId || !relationType || !targetId) throw new Error('linkMission needs missionId, relationType and targetId');
    const key = id || missionEdgeKey(missionId, relationType, targetId);
    const existing = this._missionRelations.get(key);
    const now = Date.now();
    this._missionRelations.set(key, {
      ...metadata,
      id: key, missionId, relationType, targetId, confidence, status,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
    });
    this.dirty = true;
    return key;
  }

  unlinkMission ({ id = null, missionId = null, relationType = null, targetId = null }) {
    let removed = false;
    if (id) removed = this._missionRelations.delete(id);
    else if (missionId && relationType && targetId) removed = this._missionRelations.delete(missionEdgeKey(missionId, relationType, targetId));
    else throw new Error('unlinkMission needs id or (missionId, relationType, targetId)');
    if (removed) this.dirty = true;
    return removed;
  }

  missionRelations (missionId, { relationType = null } = {}) {
    let out = [...this._missionRelations.values()].filter(e => e.missionId === missionId);
    if (relationType) out = out.filter(e => e.relationType === relationType);
    return out;
  }

  missionRelationsByTarget (targetId, { relationType = null } = {}) {
    let out = [...this._missionRelations.values()].filter(e => e.targetId === targetId);
    if (relationType) out = out.filter(e => e.relationType === relationType);
    return out;
  }

  recordAction ({ id = null, missionId = null, actionType, targetId = null, outcome = null, startedAt = null, completedAt = null, data = {} }) {
    if (!actionType) throw new Error('recordAction needs actionType');
    const now = Date.now();
    const base = id || `${missionId ?? 'none'}|${actionType}|${targetId ?? 'none'}|${startedAt ?? now}`;
    // L'id generato è unico per evento: due azioni identiche nello stesso
    // millisecondo (o senza `startedAt`) sono due episodi distinti, non una
    // sovrascrittura silenziosa. Un `id` esplicito resta il solo modo di deduplicare.
    let key = id ?? `${base}#${++this._actionSeq}`;
    if (!id) while (this.actionEvents.has(key)) key = `${base}#${++this._actionSeq}`;
    this.actionEvents.set(key, {
      ...data,
      id: key, missionId, actionType, targetId, outcome,
      startedAt: startedAt ?? now, completedAt: completedAt ?? null,
    });
    this.dirty = true;
    return key;
  }

  missionActions (missionId) {
    return [...this.actionEvents.values()].filter(e => e.missionId === missionId);
  }

  // Retention (P6 follow-up): rimuove un singolo evento d'azione.
  removeAction (id) {
    const removed = this.actionEvents.delete(id);
    if (removed) this.dirty = true;
    return removed;
  }

  // ---- observation log (subject/predicate/object) ----------------------------------

  recordObservation ({ id = null, subject, predicate, object, confidence = 1, observedAt = null, source = null, data = {} }) {
    if (!subject || !predicate || object == null) throw new Error('recordObservation needs subject, predicate and object');
    const now = Date.now();
    const base = `${subject}|${predicate}|${object}|${observedAt ?? now}`;
    // Id unico per evento: due letture identiche nello stesso millisecondo sono
    // due osservazioni distinte (stessa regola degli action event).
    let key = id ?? `${base}#${++this._obsSeq}`;
    if (!id) while (this._observations.has(key)) key = `${base}#${++this._obsSeq}`;
    this._observations.set(key, {
      ...data,
      id: key, subject, predicate, object, confidence,
      observedAt: observedAt ?? now, source,
    });
    this.dirty = true;
    return key;
  }

  // Filtro opzionale per soggetto/predicato/oggetto e finestra temporale; ordina
  // dal più recente (la materializzazione legge sempre dal più recente).
  observations ({ subject = null, predicate = null, object = null, since = null, limit = null } = {}) {
    let out = [...this._observations.values()];
    if (subject) out = out.filter(o => o.subject === subject);
    if (predicate) out = out.filter(o => o.predicate === predicate);
    if (object) out = out.filter(o => o.object === object);
    if (since != null) out = out.filter(o => o.observedAt >= since);
    out.sort((a, b) => b.observedAt - a.observedAt || (b.id > a.id ? 1 : -1));
    return limit ? out.slice(0, limit) : out;
  }

  observationCount () {
    return this._observations.size;
  }

  // Potatura del log: rimuove una singola osservazione (usata dalla retention).
  removeObservation (id) {
    const had = this._observations.delete(id);
    if (had) this.dirty = true;
    return had;
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
      missionRelations: [...this._missionRelations.values()],
      actionEvents: [...this.actionEvents.values()],
      observations: [...this._observations.values()],
    }, null, 2)}\n`);
    renameSync(tmp, file);
    this.dirty = false;
  }

  close () {
    this.flush();
  }
}
