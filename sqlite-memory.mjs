// SQLite memory repository (node:sqlite built-in, nessuna build nativa).
//
// WAL per letture concorrenti/scritture efficienti, una singola tabella
// `world_memory` (kind/type/dimension/coordinate/status/timestamps + data JSON)
// e un indice per chunk per le query spaziali. Espone la STESSA interfaccia del
// repository JSON, così il service WorldMemory e il planner non cambiano.
//
// Scritture: commit immediato (durabile in WAL). L'alta frequenza va accorpata
// *a monte* (chunk/observations in batch), non una INSERT per blocco.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SQLITE_SCHEMA_VERSION = 2;
const CHUNK = 16;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS world_memory (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  type TEXT NOT NULL,
  dimension TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  z REAL NOT NULL,
  chunk_x INTEGER NOT NULL,
  chunk_z INTEGER NOT NULL,
  status TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1,
  discovered_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_wm_kind ON world_memory(kind);
CREATE INDEX IF NOT EXISTS idx_wm_kind_type ON world_memory(kind, type);
CREATE INDEX IF NOT EXISTS idx_wm_status ON world_memory(status);
CREATE INDEX IF NOT EXISTS idx_wm_chunk ON world_memory(dimension, chunk_x, chunk_z);
CREATE INDEX IF NOT EXISTS idx_wm_last_seen ON world_memory(last_seen_at);
CREATE TABLE IF NOT EXISTS world_memory_meta (key TEXT PRIMARY KEY, value TEXT);
`;

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
    this.db.exec(SCHEMA);
    const row = this.db.prepare('SELECT value FROM world_memory_meta WHERE key = ?').get('schema_version');
    if (!row) this.db.prepare('INSERT INTO world_memory_meta (key, value) VALUES (?, ?)').run('schema_version', String(version));
    else if (Number(row.value) > version) this.logger?.warn?.(`[memory] sqlite schema v${row.value} > v${version}`);

    this._upsert = this.db.prepare(`INSERT INTO world_memory
      (id, kind, type, dimension, x, y, z, chunk_x, chunk_z, status, confidence, discovered_at, last_seen_at, data)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        kind=excluded.kind, type=excluded.type, dimension=excluded.dimension,
        x=excluded.x, y=excluded.y, z=excluded.z, chunk_x=excluded.chunk_x, chunk_z=excluded.chunk_z,
        status=excluded.status, confidence=excluded.confidence, last_seen_at=excluded.last_seen_at, data=excluded.data`);
    this._get = this.db.prepare('SELECT * FROM world_memory WHERE id = ?');
    this._remove = this.db.prepare('DELETE FROM world_memory WHERE id = ?');
    this._stale = this.db.prepare(`UPDATE world_memory SET status = 'stale'
      WHERE last_seen_at < ? AND status NOT IN ('invalid', 'stale')`);
    this._count = this.db.prepare('SELECT COUNT(*) AS n FROM world_memory');
  }

  static rowToRecord (row) {
    if (!row) return null;
    const meta = safeJson(row.data);
    return {
      ...meta,
      id: row.id,
      kind: row.kind,
      type: row.type,
      dimension: row.dimension,
      position: { x: row.x, y: row.y, z: row.z },
      chunk: { x: row.chunk_x, z: row.chunk_z },
      status: row.status,
      confidence: row.confidence,
      discoveredAt: row.discovered_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  get (id) {
    return SqliteMemoryRepository.rowToRecord(this._get.get(id));
  }

  upsert (record) {
    if (!record?.id) throw new Error('memory record needs an id');
    // Campi comuni in colonna; tutto il resto (label, tags, contents,
    // observations, nether, state, ...) in `data` JSON.
    const { id, kind, type, dimension, position, status, confidence, discoveredAt, lastSeenAt, ...meta } = record;
    const p = position || { x: 0, y: 0, z: 0 };
    this._upsert.run(
      id,
      kind ?? 'unknown',
      type ?? 'unknown',
      dimension ?? 'overworld',
      p.x, p.y, p.z,
      Math.floor(p.x / CHUNK), Math.floor(p.z / CHUNK),
      status ?? 'known',
      confidence ?? 1,
      discoveredAt ?? Date.now(),
      lastSeenAt ?? Date.now(),
      JSON.stringify(meta),
    );
    return id;
  }

  find ({ kind = null, kinds = null, excludeKind = null, type = null, tag = null, statuses = null, includeInvalid = false, dimension = null, near = null, radius = null, limit = null } = {}) {
    const where = [];
    const params = [];
    if (kind) { where.push('kind = ?'); params.push(kind); }
    if (Array.isArray(kinds) && kinds.length) { where.push(`kind IN (${kinds.map(() => '?').join(',')})`); params.push(...kinds); }
    if (excludeKind) { where.push('kind != ?'); params.push(excludeKind); }
    if (dimension) { where.push('dimension = ?'); params.push(dimension); }
    if (type) { where.push("(type = ? OR EXISTS (SELECT 1 FROM json_each(world_memory.data, '$.tags') WHERE value = ?))"); params.push(type, type); }
    if (tag) { where.push("EXISTS (SELECT 1 FROM json_each(world_memory.data, '$.tags') WHERE value = ?)"); params.push(tag); }
    if (Array.isArray(statuses) && statuses.length) {
      where.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    } else if (!includeInvalid) {
      where.push("status != 'invalid'");
    }
    // Restringi ai chunk vicini, poi la distanza esatta la calcola il service.
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
    return this._remove.run(id).changes > 0;
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

  // Le scritture SQLite sono già durabili (WAL + synchronous=NORMAL): flush è
  // un punto di sincronizzazione, non una riscrittura completa come per JSON.
  flush () {
    try { this.db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch { /* checkpoint best-effort */ }
  }

  close () {
    try { this.db.close(); } catch { /* già chiuso */ }
  }
}
