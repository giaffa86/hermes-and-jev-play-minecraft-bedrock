// SQLite memory repository (node:sqlite built-in, nessuna build nativa).
//
// Un piccolo **property graph** sopra SQLite:
//   world_memory      -> nodi  (spatial | conceptual | dynamic)
//   memory_relation   -> archi (from_id --type--> to_id) — FATTI del mondo
//
// Sopra il world graph c'è lo strato **goal/episodico**, separato:
//   mission_relation  -> archi di goal (mission --seeks/targets/destination--> …)
//   action_event      -> cronologia delle azioni di una missione
//
// WAL, indici su kind/type/category/status/chunk/biome e sui lati degli archi.
// Le relazioni spaziali derivate (near/withinRadius/nearest) NON si salvano:
// dipendono dalle coordinate e da una soglia, quindi si calcolano a query time.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SQLITE_SCHEMA_VERSION = 4;
const CHUNK = 16;

const NODE_SCHEMA = `
CREATE TABLE IF NOT EXISTS world_memory (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  type TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'spatial',
  dimension TEXT,
  x REAL, y REAL, z REAL,
  chunk_x INTEGER, chunk_z INTEGER,
  biome TEXT,
  status TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1,
  discovered_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_wm_kind ON world_memory(kind);
CREATE INDEX IF NOT EXISTS idx_wm_kind_type ON world_memory(kind, type);
CREATE INDEX IF NOT EXISTS idx_wm_category ON world_memory(category);
CREATE INDEX IF NOT EXISTS idx_wm_status ON world_memory(status);
CREATE INDEX IF NOT EXISTS idx_wm_chunk ON world_memory(dimension, chunk_x, chunk_z);
CREATE INDEX IF NOT EXISTS idx_wm_biome ON world_memory(dimension, biome);
CREATE INDEX IF NOT EXISTS idx_wm_last_seen ON world_memory(last_seen_at);
`;

const RELATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_relation (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  type TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'known',
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (from_id) REFERENCES world_memory(id) ON DELETE CASCADE,
  FOREIGN KEY (to_id) REFERENCES world_memory(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_rel_from ON memory_relation(from_id, type);
CREATE INDEX IF NOT EXISTS idx_rel_to ON memory_relation(to_id, type);
CREATE INDEX IF NOT EXISTS idx_rel_type ON memory_relation(type, status);
CREATE INDEX IF NOT EXISTS idx_rel_to_status ON memory_relation(to_id, status);
`;

// Archi di goal (mission_relation) e cronologia azioni (action_event): separati
// dal memory_relation così il world graph non mischia "cosa so" e "cosa voglio".
// Niente FOREIGN KEY: target_id punta a un nodo world_memory (garantito dal
// service via _ensureNode), mission_id a una missione (kind: mission).
const MISSION_RELATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS mission_relation (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'known',
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_mrel_mission ON mission_relation(mission_id, relation_type);
CREATE INDEX IF NOT EXISTS idx_mrel_target ON mission_relation(target_id, relation_type);
`;

const ACTION_EVENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS action_event (
  id TEXT PRIMARY KEY,
  mission_id TEXT,
  action_type TEXT NOT NULL,
  target_id TEXT,
  outcome TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_aev_mission ON action_event(mission_id);
CREATE INDEX IF NOT EXISTS idx_aev_action ON action_event(action_type);
`;

const META_SCHEMA = `CREATE TABLE IF NOT EXISTS world_memory_meta (key TEXT PRIMARY KEY, value TEXT);`;

function safeJson (text) {
  try { return JSON.parse(text) ?? {}; } catch { return {}; }
}

export class SqliteMemoryRepository {
  constructor ({ file = ':memory:', logger = console, version = SQLITE_SCHEMA_VERSION } = {}) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.file = file;
    this.logger = logger;
    this.version = version;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(META_SCHEMA);
    this._migrate();
    this.db.exec(NODE_SCHEMA);
    this.db.exec(RELATION_SCHEMA);
    this.db.exec(MISSION_RELATION_SCHEMA);
    this.db.exec(ACTION_EVENT_SCHEMA);
    this._prepare();
  }

  _version () {
    const row = this.db.prepare('SELECT value FROM world_memory_meta WHERE key = ?').get('schema_version');
    return row ? Number(row.value) : null;
  }

  _migrate () {
    const from = this._version();
    if (from != null && from < 3) {
      this.logger?.warn?.(`[memory] migro lo schema SQLite v${from} -> v3 (nodi con category/biome, tabella archi)`);
      this.#rebuildToV3();
    }
    if (from != null && from > this.version) this.logger?.warn?.(`[memory] schema v${from} > v${this.version}`);
    this.db.prepare('INSERT OR REPLACE INTO world_memory_meta (key, value) VALUES (?, ?)').run('schema_version', String(this.version));
  }

  // v2 -> v3: x/y/z diventy nullable (nodi concettuali), aggiunti category/biome.
  #rebuildToV3 () {
    this.db.exec('BEGIN');
    try {
      this.db.exec(`CREATE TABLE world_memory_v3 (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, type TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'spatial', dimension TEXT,
        x REAL, y REAL, z REAL, chunk_x INTEGER, chunk_z INTEGER, biome TEXT,
        status TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1,
        discovered_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, data TEXT NOT NULL DEFAULT '{}')`);
      this.db.exec(`INSERT INTO world_memory_v3
        (id, kind, type, category, dimension, x, y, z, chunk_x, chunk_z, biome, status, confidence, discovered_at, last_seen_at, data)
        SELECT id, kind, type, 'spatial', dimension, x, y, z, chunk_x, chunk_z,
          CASE WHEN kind = 'explored_chunk' THEN json_extract(data, '$.biome') ELSE NULL END,
          status, confidence, discovered_at, last_seen_at, data FROM world_memory`);
      this.db.exec('DROP TABLE world_memory');
      this.db.exec('ALTER TABLE world_memory_v3 RENAME TO world_memory');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  _prepare () {
    this._upsert = this.db.prepare(`INSERT INTO world_memory
      (id, kind, type, category, dimension, x, y, z, chunk_x, chunk_z, biome, status, confidence, discovered_at, last_seen_at, data)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        kind=excluded.kind, type=excluded.type, category=excluded.category, dimension=excluded.dimension,
        x=excluded.x, y=excluded.y, z=excluded.z, chunk_x=excluded.chunk_x, chunk_z=excluded.chunk_z,
        biome=excluded.biome, status=excluded.status, confidence=excluded.confidence,
        last_seen_at=excluded.last_seen_at, data=excluded.data`);
    this._get = this.db.prepare('SELECT * FROM world_memory WHERE id = ?');
    this._remove = this.db.prepare('DELETE FROM world_memory WHERE id = ?');
    this._stale = this.db.prepare(`UPDATE world_memory SET status = 'stale'
      WHERE last_seen_at < ? AND status NOT IN ('invalid', 'stale')`);
    this._count = this.db.prepare('SELECT COUNT(*) AS n FROM world_memory');
    this._link = this.db.prepare(`INSERT INTO memory_relation
      (id, from_id, to_id, type, confidence, status, first_seen_at, last_seen_at, metadata_json)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        confidence=excluded.confidence, status=excluded.status,
        last_seen_at=excluded.last_seen_at, metadata_json=excluded.metadata_json`);
    this._unlink = this.db.prepare('DELETE FROM memory_relation WHERE id = ?');
    this._relFrom = this.db.prepare('SELECT * FROM memory_relation WHERE from_id = ?');
    this._relTo = this.db.prepare('SELECT * FROM memory_relation WHERE to_id = ?');
    this._linkMission = this.db.prepare(`INSERT INTO mission_relation
      (id, mission_id, relation_type, target_id, confidence, status, first_seen_at, last_seen_at, metadata_json)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        confidence=excluded.confidence, status=excluded.status,
        last_seen_at=excluded.last_seen_at, metadata_json=excluded.metadata_json`);
    this._unlinkMission = this.db.prepare('DELETE FROM mission_relation WHERE id = ?');
    this._mrelByMission = this.db.prepare('SELECT * FROM mission_relation WHERE mission_id = ?');
    this._mrelByTarget = this.db.prepare('SELECT * FROM mission_relation WHERE target_id = ?');
    this._recordAction = this.db.prepare(`INSERT INTO action_event
      (id, mission_id, action_type, target_id, outcome, started_at, completed_at, data)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        outcome=excluded.outcome, completed_at=excluded.completed_at, data=excluded.data`);
    this._missionActions = this.db.prepare('SELECT * FROM action_event WHERE mission_id = ?');
  }

  static rowToRecord (row) {
    if (!row) return null;
    const meta = safeJson(row.data);
    const record = {
      ...meta,
      id: row.id,
      kind: row.kind,
      type: row.type,
      category: row.category,
      dimension: row.dimension,
      status: row.status,
      confidence: row.confidence,
      discoveredAt: row.discovered_at,
      lastSeenAt: row.last_seen_at,
    };
    if (row.x != null) record.position = { x: row.x, y: row.y, z: row.z };
    if (row.chunk_x != null) record.chunk = { x: row.chunk_x, z: row.chunk_z };
    if (row.biome != null) record.biome = row.biome;
    return record;
  }

  static rowToRelation (row) {
    if (!row) return null;
    return {
      ...safeJson(row.metadata_json),
      id: row.id,
      from: row.from_id,
      to: row.to_id,
      type: row.type,
      confidence: row.confidence,
      status: row.status,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  get (id) {
    return SqliteMemoryRepository.rowToRecord(this._get.get(id));
  }

  upsert (record) {
    if (!record?.id) throw new Error('memory record needs an id');
    const { id, kind, type, category, dimension, position, biome, status, confidence, discoveredAt, lastSeenAt, ...meta } = record;
    const p = position ?? null;
    this._upsert.run(
      id,
      kind ?? 'unknown',
      type ?? 'unknown',
      category ?? (position ? 'spatial' : 'conceptual'),
      dimension ?? null,
      p ? p.x : null, p ? p.y : null, p ? p.z : null,
      p ? Math.floor(p.x / CHUNK) : null, p ? Math.floor(p.z / CHUNK) : null,
      biome ?? null,
      status ?? 'known',
      confidence ?? 1,
      discoveredAt ?? Date.now(),
      lastSeenAt ?? Date.now(),
      JSON.stringify(meta),
    );
    return id;
  }

  find ({ kind = null, kinds = null, category = null, excludeKind = null, type = null, tag = null, statuses = null, includeInvalid = false, dimension = null, biome = null, near = null, radius = null, relation = null, limit = null } = {}) {
    const where = [];
    const params = [];
    if (kind) { where.push('kind = ?'); params.push(kind); }
    if (Array.isArray(kinds) && kinds.length) { where.push(`kind IN (${kinds.map(() => '?').join(',')})`); params.push(...kinds); }
    if (category) { where.push('category = ?'); params.push(category); }
    if (excludeKind) { where.push('kind != ?'); params.push(excludeKind); }
    if (dimension) { where.push('dimension = ?'); params.push(dimension); }
    if (biome) { where.push('biome = ?'); params.push(biome); }
    if (type) { where.push("(type = ? OR EXISTS (SELECT 1 FROM json_each(world_memory.data, '$.tags') WHERE value = ?))"); params.push(type, type); }
    if (tag) { where.push("EXISTS (SELECT 1 FROM json_each(world_memory.data, '$.tags') WHERE value = ?)"); params.push(tag); }
    if (Array.isArray(statuses) && statuses.length) {
      where.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    } else if (!includeInvalid) {
      where.push("status != 'invalid'");
    }
    // Filtro per relazione: nodi che hanno un arco `type` verso/da `target`.
    if (relation && relation.type && relation.target) {
      const side = relation.direction === 'to' ? 'to_id' : 'from_id';
      const other = relation.direction === 'to' ? 'from_id' : 'to_id';
      where.push(`id IN (SELECT ${side} FROM memory_relation WHERE type = ? AND ${other} = ? AND status != 'invalid')`);
      params.push(relation.type, relation.target);
    }
    if (near && radius != null) {
      where.push('chunk_x BETWEEN ? AND ?');
      params.push(Math.floor((near.x - radius) / CHUNK), Math.floor((near.x + radius) / CHUNK));
      where.push('chunk_z BETWEEN ? AND ?');
      params.push(Math.floor((near.z - radius) / CHUNK), Math.floor((near.z + radius) / CHUNK));
    }
    let sql = 'SELECT * FROM world_memory';
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    if (limit != null) { sql += ' LIMIT ?'; params.push(limit); }
    return this.db.prepare(sql).all(...params).map(SqliteMemoryRepository.rowToRecord);
  }

  remove (id) {
    // Rimuove anche gli archi incidenti (niente edge orfani).
    this.db.prepare('DELETE FROM memory_relation WHERE from_id = ? OR to_id = ?').run(id, id);
    return this._remove.run(id).changes > 0;
  }

  upsertMany (records) {
    if (!records?.length) return 0;
    this.db.exec('BEGIN');
    try {
      for (const record of records) this.upsert(record);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return records.length;
  }

  markStaleBefore ({ kind = null, excludeKind = null, before }) {
    const clauses = ['last_seen_at < ?', "status NOT IN ('invalid', 'stale')"];
    const params = [before];
    if (kind) { clauses.push('kind = ?'); params.push(kind); }
    if (excludeKind) { clauses.push('kind != ?'); params.push(excludeKind); }
    return this.db.prepare(`UPDATE world_memory SET status = 'stale' WHERE ${clauses.join(' AND ')}`).run(...params).changes;
  }

  count ({ kind = null } = {}) {
    if (kind) return this.db.prepare('SELECT COUNT(*) AS n FROM world_memory WHERE kind = ?').get(kind).n;
    return this._count.get().n;
  }

  relationCount () {
    return this.db.prepare('SELECT COUNT(*) AS n FROM memory_relation').get().n;
  }

  missionRelationsCount () {
    return this.db.prepare('SELECT COUNT(*) AS n FROM mission_relation').get().n;
  }

  actionEventCount () {
    return this.db.prepare('SELECT COUNT(*) AS n FROM action_event').get().n;
  }

  // ---- edges -----------------------------------------------------------------

  link ({ id = null, from, to, type, confidence = 1, status = 'known', firstSeenAt = null, lastSeenAt = null, metadata = {} }) {
    if (!from || !to || !type) throw new Error('link needs from, to and type');
    const key = id || `${from}|${type}|${to}`;
    const now = Date.now();
    const existing = this.db.prepare('SELECT first_seen_at FROM memory_relation WHERE id = ?').get(key);
    this._link.run(key, from, to, type, confidence, status, firstSeenAt ?? existing?.first_seen_at ?? now, lastSeenAt ?? now, JSON.stringify(metadata));
    return key;
  }

  unlink ({ id = null, from = null, to = null, type = null }) {
    if (id) return this._unlink.run(id).changes > 0;
    if (!from || !to || !type) throw new Error('unlink needs id or (from, to, type)');
    return this.db.prepare('DELETE FROM memory_relation WHERE from_id = ? AND to_id = ? AND type = ?').run(from, to, type).changes > 0;
  }

  invalidateRelation ({ id = null, from = null, to = null, type = null, before = Date.now() }) {
    if (id) return this.db.prepare("UPDATE memory_relation SET status = 'invalid', last_seen_at = ? WHERE id = ?").run(before, id).changes;
    if (!from || !to || !type) throw new Error('invalidateRelation needs id or (from, to, type)');
    return this.db.prepare("UPDATE memory_relation SET status = 'invalid', last_seen_at = ? WHERE from_id = ? AND to_id = ? AND type = ?").run(before, from, to, type).changes;
  }

  relationsFrom (id, { type = null, statuses = null, includeInvalid = false } = {}) {
    let rows = this._relFrom.all(id);
    if (type) rows = rows.filter(r => r.type === type);
    if (Array.isArray(statuses) && statuses.length) rows = rows.filter(r => statuses.includes(r.status));
    else if (!includeInvalid) rows = rows.filter(r => r.status !== 'invalid');
    return rows.map(SqliteMemoryRepository.rowToRelation);
  }

  relationsTo (id, { type = null, statuses = null, includeInvalid = false } = {}) {
    let rows = this._relTo.all(id);
    if (type) rows = rows.filter(r => r.type === type);
    if (Array.isArray(statuses) && statuses.length) rows = rows.filter(r => statuses.includes(r.status));
    else if (!includeInvalid) rows = rows.filter(r => r.status !== 'invalid');
    return rows.map(SqliteMemoryRepository.rowToRelation);
  }

  // ---- goal/episodico (mission_relation + action_event) ---------------------------

  static rowToMissionRelation (row) {
    if (!row) return null;
    return {
      ...safeJson(row.metadata_json),
      id: row.id,
      missionId: row.mission_id,
      relationType: row.relation_type,
      targetId: row.target_id,
      confidence: row.confidence,
      status: row.status,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  static rowToActionEvent (row) {
    if (!row) return null;
    return {
      ...safeJson(row.data),
      id: row.id,
      missionId: row.mission_id,
      actionType: row.action_type,
      targetId: row.target_id,
      outcome: row.outcome,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  }

  linkMission ({ id = null, missionId, relationType, targetId, confidence = 1, status = 'known', metadata = {} }) {
    if (!missionId || !relationType || !targetId) throw new Error('linkMission needs missionId, relationType and targetId');
    const key = id || `${missionId}|${relationType}|${targetId}`;
    const now = Date.now();
    const existing = this.db.prepare('SELECT first_seen_at FROM mission_relation WHERE id = ?').get(key);
    this._linkMission.run(key, missionId, relationType, targetId, confidence, status, existing?.first_seen_at ?? now, now, JSON.stringify(metadata));
    return key;
  }

  unlinkMission ({ id = null, missionId = null, relationType = null, targetId = null }) {
    if (id) return this._unlinkMission.run(id).changes > 0;
    if (!missionId || !relationType || !targetId) throw new Error('unlinkMission needs id or (missionId, relationType, targetId)');
    return this.db.prepare('DELETE FROM mission_relation WHERE mission_id = ? AND relation_type = ? AND target_id = ?').run(missionId, relationType, targetId).changes > 0;
  }

  missionRelations (missionId, { relationType = null } = {}) {
    let rows = this._mrelByMission.all(missionId);
    if (relationType) rows = rows.filter(r => r.relation_type === relationType);
    return rows.map(SqliteMemoryRepository.rowToMissionRelation);
  }

  missionRelationsByTarget (targetId, { relationType = null } = {}) {
    let rows = this._mrelByTarget.all(targetId);
    if (relationType) rows = rows.filter(r => r.relation_type === relationType);
    return rows.map(SqliteMemoryRepository.rowToMissionRelation);
  }

  recordAction ({ id = null, missionId = null, actionType, targetId = null, outcome = null, startedAt = null, completedAt = null, data = {} }) {
    if (!actionType) throw new Error('recordAction needs actionType');
    const now = Date.now();
    const key = id || `${missionId ?? 'none'}|${actionType}|${targetId ?? 'none'}|${startedAt ?? now}`;
    this._recordAction.run(key, missionId, actionType, targetId, outcome, startedAt ?? now, completedAt ?? null, JSON.stringify(data));
    return key;
  }

  missionActions (missionId) {
    return this._missionActions.all(missionId).map(SqliteMemoryRepository.rowToActionEvent);
  }

  flush () {
    try { this.db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch { /* best-effort */ }
  }

  close () {
    try { this.db.close(); } catch { /* già chiuso */ }
  }
}
