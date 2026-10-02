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
    this._materializeContains(id, contents);
    return this.repo.get(id);
  }

  // Materializza gli archi `contains` dall'ultima osservazione: se un item non
  // c'è più nell'ultima lettura, l'arco viene invalidato (observation ≠ relation).
  _materializeContains (id, contents) {
    for (const e of this.repo.relationsFrom(id, { type: 'contains' })) this.repo.invalidateRelation({ id: e.id });
    for (const [item, count] of Object.entries(contents || {})) {
      if (!count) continue;
      const node = this.rememberConcept({ kind: 'resource', label: item });
      this.repo.link({ from: id, to: node.id, type: 'contains', metadata: { count } });
    }
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
    for (const ore of record.observations) {
      const node = this.rememberConcept({ kind: 'resource', label: ore });
      this.repo.link({ from: key, to: node.id, type: 'contains' });
    }
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
    // `biome` è una colonna indicizzata (idx_wm_biome), non un filtro in JS.
    return this.repo.find({ kind: 'explored_chunk', dimension, biome, limit });
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

  // ---- grafo: nodi concettuali + archi --------------------------------------------

  // Un nodo concettuale non ha coordinate: `resource:white_wool`,
  // `biome:cherry_grove`, `structure:ancient_city`. Così `to`/`from` sono sempre
  // un id di nodo (integrità referenziale), anche per le risorse astratte.
  conceptId (kind, name) {
    return `${kind}:${name}`;
  }

  rememberConcept ({ id = null, kind = 'resource', label = null, tags = [] }) {
    const key = id ?? (label ? this.conceptId(kind, label) : null);
    if (!key) throw new Error('rememberConcept needs an id or label');
    const existing = this.repo.get(key);
    const now = Date.now();
    const record = {
      id: key,
      kind,
      type: key.includes(':') ? key.slice(key.indexOf(':') + 1) : key,
      label: label ?? existing?.label ?? null,
      category: 'conceptual',
      position: null,
      discoveredAt: existing?.discoveredAt ?? now,
      lastSeenAt: now,
      confidence: 1,
      status: MEMORY_STATUS.KNOWN,
      tags: [...new Set([...(existing?.tags ?? []), ...tags])],
      source: 'derived',
    };
    this.repo.upsert(record);
    return record;
  }

  // Archi (relazioni semantiche, persistite): `contains`, `leads_to`, `linked_to`,
  // `inside`, `unlocks`, `tethered_to`, ...
  // Garantisce che gli estremi esistano come nodi (integrità referenziale): un id
  // `kind:name` diventa un nodo concettuale, uno senza prefisso un nodo generico.
  // Così `to` non è mai un tipo polimorfico.
  _ensureNode (id) {
    if (this.repo.get(id)) return;
    const [kind, ...rest] = id.includes(':') ? id.split(':') : ['node', id];
    this.rememberConcept({ id, kind, label: rest.join(':') || null });
  }

  link (from, to, type, { confidence = 1, metadata = {} } = {}) {
    this._ensureNode(from);
    this._ensureNode(to);
    return this.repo.link({ from, to, type, confidence, metadata });
  }

  unlink (from, to, type) {
    return this.repo.unlink({ from, to, type });
  }

  invalidateRelation (from, to, type) {
    return this.repo.invalidateRelation({ from, to, type });
  }

  relationsFrom (id, options) {
    return this.repo.relationsFrom(id, options);
  }

  relationsTo (id, options) {
    return this.repo.relationsTo(id, options);
  }

  neighbors (id, { type = null, direction = 'both' } = {}) {
    const out = [];
    if (direction !== 'in') for (const e of this.repo.relationsFrom(id, { type })) out.push({ id: e.to, direction: 'out', relation: e });
    if (direction !== 'out') for (const e of this.repo.relationsTo(id, { type })) out.push({ id: e.from, direction: 'in', relation: e });
    return out;
  }

  // BFS limitato. Utile per catene (home → portal → nether → fortress); per molte
  // decisioni del planner basta `find({ relation: {...}, nearestTo })`.
  traverse (startId, { type = null, direction = 'out', depth = 1 } = {}) {
    const result = [];
    const visited = new Set([startId]);
    let frontier = [{ id: startId, path: [startId] }];
    for (let d = 0; d < depth; d++) {
      const next = [];
      for (const { id, path } of frontier) {
        for (const nb of this.neighbors(id, { type, direction })) {
          if (visited.has(nb.id)) continue;
          visited.add(nb.id);
          result.push({ id: nb.id, node: this.repo.get(nb.id), via: nb.relation, path: [...path, nb.id] });
          next.push({ id: nb.id, path: [...path, nb.id] });
        }
      }
      frontier = next;
    }
    return result;
  }

  // Query diretta del planner: nodi per kind/type, eventualmente filtrati da una
  // relazione verso un target, ordinati per distanza da un punto.
  find ({ kind = null, type = null, relation = null, nearestTo = null, radius = null, includeInvalid = false, limit = null } = {}) {
    let records = this.repo.find({ kind, type, relation, includeInvalid, near: nearestTo, radius });
    if (nearestTo) records = records.filter(r => r.position).sort((a, b) => distance3d(a.position, nearestTo) - distance3d(b.position, nearestTo));
    if (limit != null) records = records.slice(0, limit);
    return records;
  }

  // ---- predicati spaziali DERIVATI (mai persistiti) ---------------------------------

  // near dipende solo dalla distanza fra A e B e da una soglia, non dal bot.
  near (a, b, threshold = 16) {
    const pa = typeof a === 'string' ? this.repo.get(a)?.position : a;
    const pb = typeof b === 'string' ? this.repo.get(b)?.position : b;
    return distance3d(pa, pb) <= threshold;
  }

  withinRadius (from, { radius = 64, ...filter } = {}) {
    return this.repo.find({ ...filter, near: from, radius });
  }

  nearest (from, filter = {}) {
    const records = this.repo.find({ ...filter, near: from, radius: filter.radius ?? 1024 });
    return records.filter(r => r.position).sort((a, b) => distance3d(a.position, from) - distance3d(b.position, from))[0] ?? null;
  }

  // ---- missions + checkpoints -------------------------------------------------------
  //
  // Una missione è un nodo persistente (`kind: mission`) con un ciclo di vita in
  // `state` (running/paused/found/failed/cancelled) — distinto dallo `status`
  // di freschezza della memoria. I checkpoint sono nodi sparsi collegati dalla
  // missione (`mission --has_checkpoint--> checkpoint`) e in catena
  // (`checkpoint[n] --next--> checkpoint[n+1]`), così la rotta si ricostruisce.

  createMission ({ id = null, type = 'exploration', target = null, dimension = 'overworld', origin = null, state = 'running', source = 'planner' }) {
    const key = id ?? `mission_${type}_${Date.now().toString(36)}`;
    const now = Date.now();
    const record = {
      id: key,
      kind: 'mission',
      type,
      target,
      dimension,
      position: origin ? round(origin) : null,
      origin: origin ? round(origin) : null,
      currentPosition: origin ? round(origin) : null,
      state,
      startedAt: now,
      completedAt: null,
      result: null,
      failureReason: null,
      discoveredAt: now,
      lastSeenAt: now,
      confidence: 1,
      status: MEMORY_STATUS.KNOWN,
      tags: [],
      source,
    };
    this.repo.upsert(record);
    // La missione punta al suo target (nodo concettuale: biome:…/structure:…/resource:…).
    if (target) this.link(key, target.includes(':') ? target : `biome:${target}`, 'targets');
    return record;
  }

  updateMission (id, patch = {}) {
    const mission = this.repo.get(id);
    if (!mission) return null;
    const record = { ...mission, ...patch, id, lastSeenAt: Date.now() };
    this.repo.upsert(record);
    return record;
  }

  completeMission (id, result = null) {
    return this.updateMission(id, { state: 'found', completedAt: Date.now(), result });
  }

  failMission (id, failureReason = null) {
    return this.updateMission(id, { state: 'failed', completedAt: Date.now(), failureReason });
  }

  getMission (id) {
    const record = this.repo.get(id);
    return record && record.kind === 'mission' ? record : null;
  }

  missions ({ state = null, limit = null } = {}) {
    let records = this.repo.find({ kind: 'mission', limit: null });
    if (state) records = records.filter(r => r.state === state);
    records.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    return limit != null ? records.slice(0, limit) : records;
  }

  addCheckpoint (missionId, position, { biome = null, label = null, at = Date.now() } = {}) {
    const mission = this.getMission(missionId);
    if (!mission) throw new Error('addCheckpoint needs an existing mission');
    const existing = this.missionCheckpoints(missionId);
    const seq = existing.length;
    const prev = existing[existing.length - 1] ?? null;
    const p = round(position);
    const key = `checkpoint_${missionId}_${seq}_${p.x}_${p.z}`;
    const record = {
      id: key,
      kind: 'checkpoint',
      type: 'route',
      dimension: mission.dimension,
      position: p,
      biome,
      seq,
      at,
      discoveredAt: at,
      lastSeenAt: at,
      confidence: 1,
      status: MEMORY_STATUS.KNOWN,
      tags: [],
      source: 'travel',
    };
    this.repo.upsert(record);
    this.link(missionId, key, 'has_checkpoint');
    if (prev) this.link(prev.id, key, 'next');
    return record;
  }

  // Checkpoint della missione, ordinati per `seq` (la catena `next` li collega).
  missionCheckpoints (missionId) {
    const ids = this.repo.relationsFrom(missionId, { type: 'has_checkpoint' }).map(e => e.to);
    return ids.map(id => this.repo.get(id)).filter(Boolean).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  }

  lastCheckpoint (missionId) {
    const cps = this.missionCheckpoints(missionId);
    return cps[cps.length - 1] ?? null;
  }

  // Rotta persistita: missione + checkpoint + distanza totale stimata.
  missionRoute (missionId) {
    const mission = this.getMission(missionId);
    if (!mission) return null;
    const checkpoints = this.missionCheckpoints(missionId);
    // Distanza totale: dall'origine (se c'è) attraverso i checkpoint.
    const points = mission.origin ? [mission.origin, ...checkpoints.map(c => c.position)] : checkpoints.map(c => c.position);
    let distanceTravelled = 0;
    for (let i = 1; i < points.length; i++) distanceTravelled += distance3d(points[i - 1], points[i]);
    return { mission, checkpoints, distanceTravelled: +distanceTravelled.toFixed(1) };
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
    const containers = this.repo.count({ kind: 'container' });
    const chunks = this.repo.count({ kind: 'explored_chunk' });
    const concepts = this.repo.count({ kind: 'resource' }) + this.repo.count({ kind: 'biome' }) + this.repo.count({ kind: 'structure' });
    return {
      records: this.repo.count(),
      containers,
      chunks,
      concepts,
      relations: typeof this.repo.relationCount === 'function' ? this.repo.relationCount() : 0,
    };
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
    for (const kind of ['landmark', 'structure', 'home', 'resource_site', 'portal', 'entity', 'container', 'resource', 'biome', 'mission', 'checkpoint']) {
      const n = this.repo.count({ kind });
      if (n) counts[kind] = n;
    }
    // I chunk sono bufferizzati: conta anche quelli non ancora scritti.
    const chunks = this.repo.count({ kind: 'explored_chunk' }) + [...this._chunkBuffer.keys()].filter((k) => !this.repo.get(k)).length;
    if (chunks) counts.explored_chunk = chunks;
    const relations = typeof this.repo.relationCount === 'function' ? this.repo.relationCount() : 0;
    if (relations) counts.relations = relations;
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
