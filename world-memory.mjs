// WorldMemory — service sopra un repository (SQLite di default, JSON per test).
//
// Rappresenta ciò che il bot ha *scoperto* del mondo: luoghi, bauli, e in
// seguito siti di risorse, portali, entità. Il service non sa dove sono i dati:
// parla solo con il repository (get/upsert/find/remove/markStaleBefore/count/
// flush), così passare da JSON a SQLite non tocca planner e skill.
//
// Principio cardine: la memoria è **storica**. `lastSeenAt` dice *quando* il bot
// ha osservato qualcosa, non *che esiste ancora*. Lo status (known/stale/invalid)
// evita di trasformare la memoria in una falsa verità corrente.

import { join } from 'node:path';
import { JsonMemoryRepository } from './memory-store.mjs';
import { SqliteMemoryRepository } from './sqlite-memory.mjs';

export const MEMORY_STATUS = Object.freeze({
  KNOWN: 'known',     // probabilmente ancora valido
  STALE: 'stale',     // da verificare prima di dipenderne
  INVALID: 'invalid', // sappiamo che non è più valido
});

export const LANDMARK_KINDS = Object.freeze(['landmark', 'structure', 'home']);

export function distance3d (a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.y ?? 0) - (b.y ?? 0), (a.z ?? 0) - (b.z ?? 0));
}

const round = (p) => ({ x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) });

export class WorldMemory {
  constructor ({
    repo,
    // Un baule visto un po' di tempo fa è "stale" (da rileggere, non da fidarsi).
    containerStaleMs = 5 * 60 * 1000,
    // Un luogo regge più a lungo (le strutture non si spostano), ma resta storico.
    landmarkStaleMs = 6 * 60 * 60 * 1000,
  } = {}) {
    if (!repo) throw new Error('WorldMemory needs a repository');
    this.repo = repo;
    this._chunkBuffer = new Map();   // chunk visitati in RAM, scritti in blocco
    this.containerStaleMs = containerStaleMs;
    this.landmarkStaleMs = landmarkStaleMs;
  }

  // ---- landmarks (luoghi: landmark/structure/resource_site/portal/entity) ---------

  _landmarkId (type, position) {
    const p = round(position);
    return `${type}_${p.x}_${p.y}_${p.z}`;
  }

  rememberLandmark ({ id = null, type, kind = 'landmark', label = null, dimension = 'overworld', position, confidence = 1, tags = [], source = 'discovered' }) {
    if (!type) throw new Error('rememberLandmark needs a type');
    const now = Date.now();
    const key = id || this._landmarkId(type, position);
    const existing = this.repo.get(key);
    const record = {
      id: key,
      kind,
      type,
      label,
      dimension,
      position: round(position),
      discoveredAt: existing?.discoveredAt ?? now,
      lastSeenAt: now,
      confidence,
      status: MEMORY_STATUS.KNOWN,
      tags: [...new Set([...(existing?.tags ?? []), ...tags])],
      source,
    };
    this.repo.upsert(record);
    return record;
  }

  hasLandmark (id) {
    return this.repo.get(id) != null;
  }

  findLandmarks ({ type = null, kind = null, tag = null, includeInvalid = false, near = null, radius = null, limit = null } = {}) {
    // I "luoghi" sono landmark/structure/home; resource_site/portal/entity hanno
    // i loro finder. `kind` può restringere ulteriormente.
    const scope = kind ? { kind } : { kinds: LANDMARK_KINDS };
    const records = this.repo.find({ ...scope, type, tag, includeInvalid, near, radius, limit });
    return records;
  }

  nearestLandmark ({ type = null, kind = null, from, radius = null, includeInvalid = false } = {}) {
    const candidates = this.findLandmarks({ type, kind, includeInvalid, near: from, radius });
    candidates.sort((a, b) => distance3d(a.position, from) - distance3d(b.position, from));
    return candidates[0] ?? null;
  }

  forgetLandmark (id) {
    return this.repo.remove(id);
  }

  // ---- containers ------------------------------------------------------------------

  containerId (position) {
    const p = round(position);
    return `container_${p.x}_${p.y}_${p.z}`;
  }

  rememberContainer ({ type = 'container', dimension = 'overworld', position, contents = {}, observedAt = null, source = 'read_container' }) {
    const now = observedAt ?? Date.now();
    const id = this.containerId(position);
    const existing = this.repo.get(id);
    this.repo.upsert({
      id,
      kind: 'container',
      type,
      dimension,
      position: round(position),
      contents: { ...contents },
      discoveredAt: existing?.discoveredAt ?? now,
      lastSeenAt: now,
      confidence: 1,
      status: MEMORY_STATUS.KNOWN,
      tags: [],
      source,
    });
    return this.repo.get(id);
  }

  findContainers ({ includeInvalid = false, includeStale = true, near = null, radius = null, limit = null } = {}) {
    return this.repo.find({
      kind: 'container',
      includeInvalid,
      statuses: includeStale ? null : [MEMORY_STATUS.KNOWN],
      near,
      radius,
      limit,
    });
  }

  // Quali bauli *ricordano* di contenere `item` (potrebbero essere stale: chi
  // chiama decide se verificare). Ordina per distanza da `from`.
  containersWithItem (item, { from = null, includeStale = true } = {}) {
    const matches = this.findContainers({ includeStale, near: from, radius: from ? 512 : null })
      .filter((r) => (r.contents?.[item] || 0) > 0);
    if (from) matches.sort((a, b) => distance3d(a.position, from) - distance3d(b.position, from));
    return matches;
  }

  removeContainer (id) {
    return this.repo.remove(id);
  }

  // ---- resource sites / portals / entities -----------------------------------------

  _spatialId (prefix, position) {
    const p = round(position);
    return `${prefix}_${p.x}_${p.y}_${p.z}`;
  }

  // Sito di risorse (caverna, vena, pozzo di lava…): `observations` è l'elenco
  // dei blocchi osservati (ore, lava_pool, ...). L'id è di norma passato dal
  // chiamante per il dedup (es. per chunk).
  rememberResourceSite ({ id = null, kind = 'cave', label = null, dimension = 'overworld', position, observations = [], tags = [], source = 'observed' }) {
    const key = id || this._spatialId('resource_site', position);
    const existing = this.repo.get(key);
    const now = Date.now();
    const record = {
      id: key,
      kind: 'resource_site',
      type: kind,
      label,
      dimension,
      position: round(position),
      discoveredAt: existing?.discoveredAt ?? now,
      lastSeenAt: now,
      confidence: 1,
      status: MEMORY_STATUS.KNOWN,
      observations: [...new Set([...(existing?.observations ?? []), ...observations])],
      tags: [...new Set([...(existing?.tags ?? []), ...tags])],
      source,
    };
    this.repo.upsert(record);
    return record;
  }

  findResources ({ type = null, contains = null, near = null, includeInvalid = false, limit = null } = {}) {
    return this.repo.find({ kind: 'resource_site', type, includeInvalid, near, limit }).filter((r) => {
      if (!contains) return true;
      return (r.observations || []).includes(contains) || (r.tags || []).includes(contains);
    });
  }

  // Portale (di norma nether): relazione fra due luoghi. I campi `overworld`
  // (position) e `nether` si completano quando si visita l'altro lato.
  rememberPortal ({ id = null, position, dimension = 'overworld', portalType = 'nether', nether = null, verified = false, source = 'observed' }) {
    const key = id || this._spatialId('portal', position);
    const existing = this.repo.get(key);
    const now = Date.now();
    const record = {
      id: key,
      kind: 'portal',
      type: portalType,
      dimension,
      position: round(position),
      nether: nether ?? existing?.nether ?? null,
      verified: verified || existing?.verified || false,
      discoveredAt: existing?.discoveredAt ?? now,
      lastSeenAt: now,
      confidence: 1,
      status: MEMORY_STATUS.KNOWN,
      tags: [],
      source,
    };
    this.repo.upsert(record);
    return record;
  }

  findPortals ({ type = null, near = null, includeInvalid = false, limit = null } = {}) {
    return this.repo.find({ kind: 'portal', type, near, includeInvalid, limit });
  }

  // Entità persistente/semi-persistente (cavallo legato, animale in recinto…).
  // `state` è ciò che sappiamo (leashed, owner, ...), `lastSeenAt` quando.
  rememberEntity ({ id = null, type, dimension = 'overworld', position, state = {}, confidence = 0.75, source = 'observed' }) {
    if (!type) throw new Error('rememberEntity needs a type');
    const key = id || this._spatialId(`entity_${type}`, position);
    const existing = this.repo.get(key);
    const now = Date.now();
    const record = {
      id: key,
      kind: 'entity',
      type,
      dimension,
      position: round(position),
      state: { ...(existing?.state ?? {}), ...state },
      discoveredAt: existing?.discoveredAt ?? now,
      lastSeenAt: now,
      confidence,
      status: MEMORY_STATUS.KNOWN,
      tags: [],
      source,
    };
    this.repo.upsert(record);
    return record;
  }

  findEntities ({ type = null, near = null, includeInvalid = false, limit = null } = {}) {
    return this.repo.find({ kind: 'entity', type, near, includeInvalid, limit });
  }

  // ---- explored chunks (batched) ---------------------------------------------------

  _chunkKey (dimension, x, z) {
    return `chunk_${dimension}_${x}_${z}`;
  }

  // Segna un chunk come visitato, con il bioma. Bufferizzato in RAM e scritto in
  // blocco (`upsertMany`): una INSERT per blocco visto sarebbe un disastro; per
  // chunk sarebbe tollerabile, ma il batch uniforma l'alta frequenza futura.
  markChunkVisited ({ x, z, dimension = 'overworld', biome = null, y = 64, at = Date.now() }) {
    const key = this._chunkKey(dimension, x, z);
    const existing = this._chunkBuffer.get(key) ?? this.repo.get(key);
    const record = {
      id: key,
      kind: 'explored_chunk',
      type: 'chunk',
      dimension,
      position: { x: x * 16 + 8, y, z: z * 16 + 8 },
      biome: biome ?? existing?.biome ?? null,
      visits: (existing?.visits ?? 0) + 1,
      discoveredAt: existing?.discoveredAt ?? at,
      lastSeenAt: at,
      confidence: 1,
      status: MEMORY_STATUS.KNOWN,
      tags: [],
      source: 'travel',
    };
    this._chunkBuffer.set(key, record);
    return record;
  }

  flushChunks () {
    if (!this._chunkBuffer.size) return 0;
    const records = [...this._chunkBuffer.values()];
    this.repo.upsertMany(records);
    this._chunkBuffer.clear();
    return records.length;
  }

  isChunkVisited ({ x, z, dimension = 'overworld' }) {
    const key = this._chunkKey(dimension, x, z);
    return this._chunkBuffer.has(key) || this.repo.get(key) != null;
  }

  // Le query che devono essere complete flushano prima (le chiama il planner,
  // non il loop di percezione).
  visitedChunks ({ dimension = 'overworld', near = null, radius = null, limit = null } = {}) {
    this.flushChunks();
    return this.repo.find({ kind: 'explored_chunk', dimension, near, radius, limit });
  }

  chunksWithBiome (biome, { dimension = 'overworld', limit = null } = {}) {
    this.flushChunks();
    return this.repo.find({ kind: 'explored_chunk', dimension, limit }).filter(r => r.biome === biome);
  }

  // Frontiera: chunk adiacenti a quelli visitati e non ancora visitati — la
  // "prossima cosa da esplorare" per il planner deterministico.
  unexploredFrontier ({ dimension = 'overworld', near = null, radius = 512, limit = null } = {}) {
    this.flushChunks();
    const visited = this.repo.find({ kind: 'explored_chunk', dimension, near, radius });
    const seen = new Set(visited.map(r => `${r.chunk?.x},${r.chunk?.z}`));
    const frontier = new Map();
    for (const r of visited) {
      const cx = r.chunk?.x, cz = r.chunk?.z;
      if (cx == null || cz == null || Number.isNaN(cx) || Number.isNaN(cz)) continue;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (!dx && !dz) continue;
          const key = `${cx + dx},${cz + dz}`;
          if (seen.has(key) || frontier.has(key)) continue;
          frontier.set(key, { x: cx + dx, z: cz + dz, center: { x: (cx + dx) * 16 + 8, y: 64, z: (cz + dz) * 16 + 8 } });
        }
      }
    }
    let out = [...frontier.values()];
    if (near) out.sort((a, b) => distance3d(a.center, near) - distance3d(b.center, near));
    if (limit) out = out.slice(0, limit);
    return out;
  }

  // ---- status ----------------------------------------------------------------------

  // Promuove a STALE ciò che è stato osservato troppo tempo fa. Non invalida
  // nulla: l'obsolescenza va *verificata*, non assunta.
  refreshStatuses (now = Date.now()) {
    this.repo.markStaleBefore({ kind: 'container', before: now - this.containerStaleMs });
    this.repo.markStaleBefore({ excludeKind: 'container', before: now - this.landmarkStaleMs });
  }

  // ---- hydrate / summary -----------------------------------------------------------

  hydrate (now = Date.now()) {
    this.refreshStatuses(now);
    return this.summary();
  }

  summary () {
    this.flushChunks();
    const total = this.repo.count();
    const containers = this.repo.count({ kind: 'container' });
    const chunks = this.repo.count({ kind: 'explored_chunk' });
    return { records: total, landmarks: total - containers - chunks, containers, chunks };
  }

  observeView ({ maxContainers = 20, maxLandmarks = 20 } = {}) {
    const landmarks = this.findLandmarks({ limit: maxLandmarks }).map((r) => ({
      id: r.id, type: r.type, kind: r.kind, label: r.label ?? null, position: r.position,
      status: r.status, lastSeenAt: r.lastSeenAt,
    }));
    const containers = this.findContainers({ includeInvalid: true, limit: maxContainers }).map((r) => ({
      id: r.id, type: r.type, position: r.position, contents: r.contents,
      status: r.status, observedAt: r.observedAt ?? r.lastSeenAt,
    }));
    const portals = this.findPortals({ limit: maxLandmarks }).map((r) => ({
      id: r.id, type: r.type, position: r.position, nether: r.nether ?? null, status: r.status,
    }));
    return { landmarks, containers, portals, counts: this._kindCounts() };
  }

  _kindCounts () {
    const counts = {};
    for (const kind of ['landmark', 'structure', 'home', 'resource_site', 'portal', 'entity', 'container']) {
      const n = this.repo.count({ kind });
      if (n) counts[kind] = n;
    }
    // I chunk sono bufferizzati: conta anche quelli non ancora scritti.
    const chunks = this.repo.count({ kind: 'explored_chunk' }) + [...this._chunkBuffer.keys()].filter((k) => !this.repo.get(k)).length;
    if (chunks) counts.explored_chunk = chunks;
    return counts;
  }

  flush () {
    this.flushChunks();
    this.repo.flush();
  }

  close () {
    this.flushChunks();
    this.repo.close();
  }
}

function buildRepository ({ repo, dir, backend, logger }) {
  if (repo) return repo;
  if (backend === 'json') return new JsonMemoryRepository({ dir, logger }).load();
  const file = dir.endsWith('.sqlite') || dir.endsWith('.db') ? dir : join(dir, 'world.sqlite');
  return new SqliteMemoryRepository({ file, logger });
}

export function createWorldMemory ({ repo = null, dir = './memory', backend = 'sqlite', logger = console, ...options } = {}) {
  return new WorldMemory({ repo: buildRepository({ repo, dir, backend, logger }), ...options });
}
