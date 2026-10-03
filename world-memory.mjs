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

const TERMINAL_MISSION_STATES = new Set(['found', 'failed', 'cancelled']);

// Punteggio dell'hint di produttività: la *riuscita* conta più della resa.
// `confidence * (1 + min(found, 10)/10)` → 0 se non ha mai funzionato, ~1.1 quando
// funziona sempre con resa abbondante. È una preferenza per il planner, non un fatto.
export function productivityScore (entry) {
  if (!entry) return 0;
  const attempts = entry.attempts ?? 0;
  const confidence = attempts ? (entry.successes ?? 0) / attempts : 0;
  return Math.round(confidence * (1 + Math.min(entry.found ?? 0, 10) / 10) * 1000) / 1000;
}

export class WorldMemory {
  constructor ({
    repo,
    // Un baule visto un po' di tempo fa è "stale" (da rileggere, non da fidarsi).
    containerStaleMs = 5 * 60 * 1000,
    // Un luogo regge più a lungo (le strutture non si spostano), ma resta storico.
    landmarkStaleMs = 6 * 60 * 60 * 1000,
    // Consolidamento episodico→semantico alla chiusura di una missione.
    autoConsolidate = true,
    // Crescita limitata: episodi tracciati per (nodo, risorsa) e risorse per nodo.
    maxHintSources = 20,
    maxHintsPerNode = 12,
  } = {}) {
    if (!repo) throw new Error('WorldMemory needs a repository');
    this.repo = repo;
    this._chunkBuffer = new Map();   // chunk visitati in RAM, scritti in blocco
    this.containerStaleMs = containerStaleMs;
    this.landmarkStaleMs = landmarkStaleMs;
    this.autoConsolidate = autoConsolidate;
    this.maxHintSources = maxHintSources;
    this.maxHintsPerNode = maxHintsPerNode;
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
      // La conoscenza consolidata (hint di produttività) sopravvive alla
      // ri-osservazione: è derivata dagli episodi, non dall'ultima scansione.
      ...(existing?.productivity ? { productivity: existing.productivity } : {}),
      source,
    };
    this.repo.upsert(record);
    return record;
  }

  hasLandmark (id) {
    return this.repo.get(id) != null;
  }

  // Accesso diretto per id: i consumer che hanno già un id noto (es. il replay di
  // una rotta verso un posto registrato) non devono rifare una ricerca.
  getRecord (id) {
    return id ? (this.repo.get(id) ?? null) : null;
  }

  findLandmarks ({ type = null, kind = null, tag = null, includeInvalid = false, near = null, radius = null, limit = null } = {}) {
    // I "luoghi" sono landmark/structure/home; resource_site/portal/entity hanno
    // i loro finder. `kind` può restringere ulteriormente.
    const scope = kind ? { kind } : { kinds: LANDMARK_KINDS };
    const records = this.repo.find({ ...scope, type, tag, includeInvalid, near, radius, limit });
    // Un landmark è un *luogo*: i nodi-concetto (`structure:village`, categoria
    // `conceptual` e senza posizione, creati come bersaglio del link `is_a`) non
    // sono posti da raggiungere e non devono sporcare questa ricerca.
    return records.filter(record => record.category !== 'conceptual' && record.position);
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
      ...(existing?.productivity ? { productivity: existing.productivity } : {}),
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
  // Struttura riconosciuta euristicamente (`kind: structure`, spec M5/M6): un
  // landmark con tipo leggibile, collegato al concetto `structure:<tipo>` così il
  // planner può chiedere "i villaggi che conosco" senza leggere i blocchi.
  // L'evidenza della detection (conteggi, punteggio, marker mancanti) viaggia in
  // `metadata` della relazione `is_a`: i repository spalmano `metadata` *piatto*
  // nel record della relazione, quindi si rilegge come `relation.evidence`.
  rememberStructure ({ id = null, type, label = null, dimension = 'overworld', position, confidence = 0.6, evidence = null, tags = [], source = 'detected' }) {
    if (!type) throw new Error('rememberStructure: type required');
    const landmarkId = id || this._landmarkId(`structure_${type}`, position);
    const record = this.rememberLandmark({
      id: landmarkId,
      type,
      kind: 'structure',
      label: label ?? type,
      dimension,
      position,
      confidence,
      tags: ['structure', type, ...tags],
      source,
    });
    this.link(landmarkId, this.conceptId('structure', type), 'is_a', { confidence, metadata: evidence ? { evidence } : undefined });
    return record;
  }

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

  createMission ({ id = null, type = 'exploration', target = null, dimension = 'overworld', origin = null, state = 'running', source = 'planner', rawPrompt = null, intent = null }) {
    const key = id ?? `mission_${type}_${Date.now().toString(36)}`;
    const now = Date.now();
    const record = {
      id: key,
      kind: 'mission',
      type,
      target,
      intent,
      rawPrompt,
      dimension,
      position: origin ? round(origin) : null,
      origin: origin ? round(origin) : null,
      currentPosition: origin ? round(origin) : null,
      state,
      outcome: null,
      success: null,
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
    // È un arco DI GOAL: vive in mission_relation, non nel world graph.
    if (target) this.linkMission(key, 'targets', target.includes(':') ? target : `biome:${target}`);
    return record;
  }

  updateMission (id, patch = {}) {
    const mission = this.repo.get(id);
    if (!mission) return null;
    const record = { ...mission, ...patch, id, lastSeenAt: Date.now() };
    this.repo.upsert(record);
    // Consolidamento episodico→semantico quando la missione è chiusa: best-effort,
    // non deve mai rompere il lifecycle (consolidateMission non lancia). È
    // idempotente, quindi si può richiamare a ogni patch terminale: se la
    // missione è già consolidata o non ha ancora un esito, esce subito.
    if (this.autoConsolidate && this._isTerminal(record)) this.consolidateMission(id);
    return record;
  }

  completeMission (id, result = null) {
    return this.updateMission(id, { state: 'found', completedAt: Date.now(), result, outcome: 'found', success: true });
  }

  failMission (id, failureReason = null) {
    return this.updateMission(id, { state: 'failed', completedAt: Date.now(), failureReason, outcome: 'failed', success: false });
  }

  // Chiusura generica: esito e successo sono campi del livello episodico,
  // distinti dallo `state` del ciclo di vita della missione.
  finishMission (id, { outcome = null, success = null, result = null, failureReason = null, state = null } = {}) {
    const patch = { completedAt: Date.now() };
    if (outcome != null) patch.outcome = outcome;
    if (success != null) patch.success = success;
    if (result != null) patch.result = result;
    if (failureReason != null) patch.failureReason = failureReason;
    if (state != null) patch.state = state;
    return this.updateMission(id, patch);
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
      label,
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

  // ---- goal/episodico (mission_relation + action_event) ----------------------------
  //
  // Gli archi di goal collegano la missione ai nodi del world graph SENZA
  // sporcarlo: `mission_42 --seeks--> resource:iron_ore` è un intent, non un fatto.

  // Collega la missione a un nodo (target/seeks/destination/origin/via). Il target
  // viene garantito come nodo esistente, ma l'arco vive in mission_relation.
  linkMission (missionId, relationType, targetId, { confidence = 1, metadata = {} } = {}) {
    if (!missionId || !relationType || !targetId) throw new Error('linkMission needs missionId, relationType and targetId');
    this._ensureNode(targetId);
    return this.repo.linkMission({ missionId, relationType, targetId, confidence, metadata });
  }

  unlinkMission (missionId, relationType, targetId) {
    return this.repo.unlinkMission({ missionId, relationType, targetId });
  }

  missionRelations (missionId, { relationType = null } = {}) {
    return this.repo.missionRelations(missionId, { relationType });
  }

  // Cronologia azioni della missione (goto/mine/deposit/…): proiezione del log
  // del controller, non una seconda fonte di verità sul mondo.
  recordAction ({ missionId = null, actionType, targetId = null, outcome = null, startedAt = null, completedAt = null, data = {} }) {
    return this.repo.recordAction({ missionId, actionType, targetId, outcome, startedAt, completedAt, data });
  }

  missionActions (missionId) {
    return this.repo.missionActions(missionId);
  }

  // Missioni precedenti per intent/target (memoria episodica: "come ho fatto l'ultima
  // volta che mi hanno chiesto X").
  findPreviousMissions ({ intent = null, target = null, limit = null } = {}) {
    let records = this.missions({ limit: null });
    if (intent) records = records.filter(m => m.intent === intent);
    if (target) {
      const plain = String(target).replace(/^[a-z]+:/, '');
      const byTarget = new Set(this.repo.missionRelationsByTarget(target.includes(':') ? target : `resource:${target}`, {}).map(r => r.missionId));
      records = records.filter(m => {
        if (!m.target) return byTarget.has(m.id);
        return m.target === target || String(m.target).replace(/^[a-z]+:/, '') === plain || byTarget.has(m.id);
      });
    }
    return limit != null ? records.slice(0, limit) : records;
  }

  // Dove una risorsa è stata trovata con successo in passato: missioni concluse con
  // successo che cercavano `resource:iron_ore`, unendo il target spaziale (targets).
  findSuccessfulLocationsFor (resource, { limit = null } = {}) {
    const resourceId = resource.includes(':') ? resource : `resource:${resource}`;
    const seeking = this.repo.missionRelationsByTarget(resourceId, { relationType: 'seeks' });
    const out = [];
    for (const rel of seeking) {
      const mission = this.getMission(rel.missionId);
      if (!mission) continue;
      if (mission.success !== true && mission.state !== 'found') continue;
      for (const edge of this.repo.missionRelations(mission.id)) {
        if (edge.relationType !== 'targets') continue;
        const node = this.repo.get(edge.targetId);
        if (!node?.position) continue;
        out.push({
          location: node.id,
          type: node.type,
          position: node.position,
          mission: mission.id,
          intent: mission.intent,
          completedAt: mission.completedAt,
          result: mission.result ?? null,
        });
      }
    }
    out.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
    return limit != null ? out.slice(0, limit) : out;
  }

  // ---- consolidamento episodico → semantico ----------------------------------------
  //
  // Le missioni restano episodi immutabili. Il consolidamento ne deriva un *hint di
  // produttività* sul nodo spaziale dove la missione ha lavorato:
  //
  //   resource_site_3_-2.productivity.iron_ore = {
  //     attempts, successes, failures, found, confidence, outcome, contradicted,
  //     first, last, lastFailureAt, sources: [{ mission, at, outcome, found }] }
  //
  // Non è un fatto sul mondo (non tocca lo status known/stale/invalid): è una
  // preferenza, così una località «proveniente» viene preferita senza diventare
  // una verità. Proprietà garantite:
  // - idempotente: la stessa missione non viene mai contata due volte (dedup per id
  //   in `sources`, più `sourcesCutoff` quando la lista è troncata);
  // - con provenance: ogni missione consolidata lascia un arco
  //   `mission --consolidated_into--> nodo` (mission_relation, non world graph);
  // - contraddizioni esplicite: successi e fallimenti sulla stessa risorsa
  //   convivono (`contradicted: true`), `confidence = successes/attempts`;
  // - crescita limitata: `maxHintSources` per (nodo, risorsa), `maxHintsPerNode`
  //   per nodo, e un solo sito di risorse per chunk.

  _isTerminal (mission) {
    if (!mission) return false;
    return mission.completedAt != null || TERMINAL_MISSION_STATES.has(mission.state) || mission.success != null;
  }

  _canonicalResource (name) {
    return String(name ?? '').trim().replace(/^[a-z]+:/, '').replace(/^deepslate_/, '');
  }

  _episodeOutcome (mission) {
    if (mission.success === true || mission.state === 'found' || mission.outcome === 'found') return 'ok';
    if (mission.success === false || TERMINAL_MISSION_STATES.has(mission.state)) return 'failed';
    return null;
  }

  // I repository appiattiscono `data` nell'evento d'azione (`data.position` →
  // `position`): accetta entrambe le forme senza duplicare la lettura.
  _actionField (action, key) {
    if (!action) return null;
    return action.data?.[key] ?? action[key] ?? null;
  }

  // Risorse toccate dall'episodio: `seeks` (intento), `mine_<blocco>`/`take_<item>`
  // riusciti (evidenza) e i conteggi numerici in `result`. `found` è una stima.
  _episodeResources (mission, { actions = null } = {}) {
    const resources = new Map();
    const bump = (name, found = 0) => {
      const key = this._canonicalResource(name);
      if (!key) return null;
      const entry = resources.get(key) ?? { resource: key, found: 0 };
      entry.found += found;
      resources.set(key, entry);
      return entry;
    };
    for (const edge of this.repo.missionRelations(mission.id, { relationType: 'seeks' })) bump(edge.targetId, 0);
    for (const action of actions ?? this.missionActions(mission.id)) {
      if (!action || action.outcome !== 'ok') continue;
      const type = String(action.actionType ?? '');
      if (type.startsWith('mine_')) bump(type.slice('mine_'.length), 1);
      else if (type === 'collect_drop') {
        const item = this._actionField(action, 'item');
        if (item) bump(item, this._actionField(action, 'count') ?? 1);
      } else if (type.startsWith('take_')) bump(type.slice('take_'.length), 0);
    }
    const result = mission.result && typeof mission.result === 'object' ? mission.result : {};
    const counts = { ...result, ...(result.counts && typeof result.counts === 'object' ? result.counts : {}) };
    for (const [key, value] of Object.entries(counts)) {
      if (typeof value !== 'number') continue;
      const entry = resources.get(this._canonicalResource(key));
      if (entry) entry.found = Math.max(entry.found, value);
    }
    return resources;
  }

  // Nodo spaziale a cui attribuire l'episodio. Ordine: target esplicito della
  // missione → posizione di un'azione riuscita → targetPosition → ultimo checkpoint
  // → posizione corrente. L'origine non è un'ancora: è dove la missione è partita.
  _missionAnchor (mission, { actions = null, create = false } = {}) {
    for (const edge of this.repo.missionRelations(mission.id)) {
      if (edge.relationType !== 'targets') continue;
      const node = this.repo.get(edge.targetId);
      if (node?.position) return { node, origin: 'targets' };
    }
    const acts = actions ?? this.missionActions(mission.id);
    const acted = [...acts].reverse().find(a => a?.outcome === 'ok' && this._actionField(a, 'position'));
    const at = this._actionField(acted, 'position') ?? mission.targetPosition ?? this.lastCheckpoint(mission.id)?.position ?? mission.currentPosition ?? null;
    if (!at) return null;
    return { node: this._chunkAnchor(at, { create }), origin: acted ? 'action' : 'movement' };
  }

  // Ancora spaziale = sito di risorse del chunk, con lo stesso id della discovery
  // scan dell'adapter: un chunk, un nodo → gli episodi vicini si fondono invece di
  // moltiplicare i nodi. `create` è concesso solo agli episodi riusciti.
  _chunkAnchor (position, { create = false } = {}) {
    const id = `resource_site_${Math.floor(position.x / 16)}_${Math.floor(position.z / 16)}`;
    const existing = this.repo.get(id);
    if (existing) return existing;
    if (!create) return null;
    return this.rememberResourceSite({
      id,
      kind: (position.y ?? 64) < 62 ? 'cave' : 'surface_ores',
      position,
      observations: [],       // nessuna affermazione sulle risorse: è solo un'ancora
      source: 'consolidated',
    });
  }

  _sourceOrder (source) {
    return `${String(source?.at ?? 0).padStart(16, '0')}|${source?.mission ?? ''}`;
  }

  // Fusione idempotente di un episodio nell'hint (nodo, risorsa).
  // `changed: false` = già applicato → il chiamante non riscrive il nodo.
  _mergeHint (node, resource, episode) {
    const productivity = node.productivity && typeof node.productivity === 'object' ? node.productivity : {};
    const prev = productivity[resource] ?? null;
    if (!prev) return { changed: true, entry: this._hintEntry(episode, null) };
    const sources = Array.isArray(prev.sources) ? prev.sources : [];
    if (sources.some(s => s.mission === episode.mission)) return { changed: false, entry: prev };
    const cutoff = prev.sourcesCutoff ?? null;
    if (cutoff && this._sourceOrder(episode) <= this._sourceOrder(cutoff)) return { changed: false, entry: prev };
    return { changed: true, entry: this._hintEntry(episode, prev) };
  }

  _hintEntry (episode, prev) {
    const attempts = (prev?.attempts ?? 0) + 1;
    const successes = (prev?.successes ?? 0) + (episode.outcome === 'ok' ? 1 : 0);
    const failures = (prev?.failures ?? 0) + (episode.outcome === 'ok' ? 0 : 1);
    const found = (prev?.found ?? 0) + (episode.found ?? 0);
    const all = [...(Array.isArray(prev?.sources) ? prev.sources : []), {
      mission: episode.mission, at: episode.at, outcome: episode.outcome, found: episode.found ?? 0,
    }];
    all.sort((a, b) => (a.at - b.at) || String(a.mission).localeCompare(String(b.mission)));
    let dropped = [];
    if (all.length > this.maxHintSources) dropped = all.splice(0, all.length - this.maxHintSources);
    const cutoffCandidate = dropped[dropped.length - 1] ?? null;
    const sourcesCutoff = cutoffCandidate && this._sourceOrder(cutoffCandidate) > this._sourceOrder(prev?.sourcesCutoff)
      ? { at: cutoffCandidate.at, mission: cutoffCandidate.mission }
      : (prev?.sourcesCutoff ?? null);
    const entry = {
      attempts,
      successes,
      failures,
      found,
      confidence: Math.round((successes / attempts) * 1000) / 1000,
      contradicted: successes > 0 && failures > 0,
      outcome: episode.outcome,
      first: prev?.first ?? episode.at,
      last: episode.at,
      lastFailureAt: episode.outcome === 'ok' ? (prev?.lastFailureAt ?? null) : episode.at,
      updatedAt: episode.at,
      sources: all,
    };
    if (sourcesCutoff) entry.sourcesCutoff = sourcesCutoff;
    return entry;
  }

  // Tiene le `maxHintsPerNode` risorse più di recente aggiornate.
  _capHints (productivity) {
    const entries = Object.entries(productivity);
    if (entries.length <= this.maxHintsPerNode) return productivity;
    entries.sort((a, b) => (b[1]?.updatedAt ?? 0) - (a[1]?.updatedAt ?? 0) || a[0].localeCompare(b[0]));
    return Object.fromEntries(entries.slice(0, this.maxHintsPerNode));
  }

  // Consolida un episodio chiuso nell'hint di produttività del nodo spaziale.
  // Non lancia mai: è chiamato dal lifecycle di missione (best-effort).
  consolidateMission (missionId, { create = true } = {}) {
    try {
      const mission = this.getMission(missionId);
      if (!mission) return { ok: false, reason: 'no_mission', mission: missionId };
      if (!this._isTerminal(mission)) return { ok: false, reason: 'not_terminal', mission: missionId };
      const known = this.missionRelations(mission.id, { relationType: 'consolidated_into' });
      if (known.length) return { ok: true, skipped: 'already_consolidated', mission: mission.id, anchor: known[0].targetId };
      const outcome = this._episodeOutcome(mission);
      if (!outcome) return { ok: false, reason: 'no_outcome', mission: mission.id };
      const actions = this.missionActions(mission.id);
      const resources = this._episodeResources(mission, { actions });
      if (!resources.size) return { ok: true, skipped: 'no_resources', mission: mission.id };
      const anchor = this._missionAnchor(mission, { actions, create: create && outcome === 'ok' });
      if (!anchor?.node) return { ok: true, skipped: 'no_anchor', mission: mission.id };
      const node = anchor.node;
      const at = mission.completedAt ?? Date.now();
      const productivity = { ...(node.productivity ?? {}) };
      const applied = [];
      for (const [resource, stats] of resources) {
        const merged = this._mergeHint(node, resource, { mission: mission.id, at, outcome, found: stats.found ?? 0 });
        if (!merged.changed) { applied.push({ resource, node: node.id, unchanged: true }); continue; }
        productivity[resource] = merged.entry;
        applied.push({
          resource, node: node.id, attempts: merged.entry.attempts,
          confidence: merged.entry.confidence, found: merged.entry.found,
          contradicted: merged.entry.contradicted,
        });
      }
      if (applied.some(a => !a.unchanged)) {
        this.repo.upsert({ ...node, productivity: this._capHints(productivity) });
      }
      this.linkMission(mission.id, 'consolidated_into', node.id, {
        metadata: { resources: applied.map(a => a.resource), outcome, origin: anchor.origin },
      });
      return { ok: true, mission: mission.id, anchor: node.id, origin: anchor.origin, outcome, resources: applied };
    } catch (error) {
      this.logger?.warn?.(`[memory] consolidamento di ${missionId} fallito: ${error.message}`);
      return { ok: false, reason: 'error', mission: missionId, error: error.message };
    }
  }

  // Backfill: consolida le missioni chiuse non ancora consolidate (ordine
  // cronologico). Idempotente: una seconda passata salta tutto.
  consolidatePending ({ limit = 50, since = null, create = true } = {}) {
    let missions = this.missions({ limit: null }).filter(m => this._isTerminal(m));
    if (since != null) missions = missions.filter(m => (m.completedAt ?? 0) >= since);
    missions.sort((a, b) => (a.completedAt ?? a.startedAt ?? 0) - (b.completedAt ?? b.startedAt ?? 0));
    const results = missions.slice(0, limit).map(m => this.consolidateMission(m.id, { create }));
    return {
      ok: true,
      candidates: missions.length,
      processed: results.length,
      consolidated: results.filter(r => r.ok && !r.skipped).length,
      results,
    };
  }

  // Vista semantica: hint di produttività per risorsa/nodo, ordinati per punteggio.
  productivityHints ({ resource = null, node = null, near = null, radius = null, includeContradicted = true, limit = null } = {}) {
    const single = node ? this.repo.get(node) : null;
    const nodes = node ? (single ? [single] : []) : this.repo.find({
      kinds: ['resource_site', 'landmark', 'structure', 'home'], near, radius, includeInvalid: false,
    });
    const wanted = resource ? this._canonicalResource(resource) : null;
    const out = [];
    for (const n of nodes) {
      const hints = n?.productivity && typeof n.productivity === 'object' ? n.productivity : null;
      if (!hints) continue;
      for (const [key, entry] of Object.entries(hints)) {
        if (wanted && key !== wanted) continue;
        if (!includeContradicted && entry.contradicted) continue;
        out.push({
          location: n.id, kind: n.kind, type: n.type, position: n.position ?? null,
          resource: key, score: productivityScore(entry), ...entry,
        });
      }
    }
    out.sort((a, b) => b.score - a.score || (b.last ?? 0) - (a.last ?? 0) || a.location.localeCompare(b.location));
    return limit != null ? out.slice(0, limit) : out;
  }

  // Località che hanno già funzionato per una risorsa (vista semantica, da
  // preferire nel planning; `findSuccessfulLocationsFor` resta la vista episodica).
  provenLocationsFor (resource, { near = null, limit = null, minConfidence = 0, includeContradicted = true } = {}) {
    let hints = this.productivityHints({ resource, includeContradicted });
    if (minConfidence > 0) hints = hints.filter(h => h.confidence >= minConfidence);
    if (near) {
      hints = hints.filter(h => h.position != null);
      for (const hint of hints) hint.distance = +distance3d(hint.position, near).toFixed(1);
      hints.sort((a, b) => (b.score - a.score) || (a.distance - b.distance));
    }
    return limit != null ? hints.slice(0, limit) : hints;
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
      missions: this.repo.count({ kind: 'mission' }),
      relations: typeof this.repo.relationCount === 'function' ? this.repo.relationCount() : 0,
      missionRelations: typeof this.repo.missionRelationsCount === 'function' ? this.repo.missionRelationsCount() : 0,
      actionEvents: typeof this.repo.actionEventCount === 'function' ? this.repo.actionEventCount() : 0,
    };
  }

  observeView ({ maxContainers = 20, maxLandmarks = 20, maxHints = 10 } = {}) {
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
    const hints = this.productivityHints({ limit: maxHints }).map(h => ({
      location: h.location, kind: h.kind, position: h.position, resource: h.resource,
      score: h.score, confidence: h.confidence, found: h.found, attempts: h.attempts,
      contradicted: h.contradicted, last: h.last,
    }));
    return { landmarks, containers, portals, hints, counts: this._kindCounts() };
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
    const missionRelations = typeof this.repo.missionRelationsCount === 'function' ? this.repo.missionRelationsCount() : 0;
    if (missionRelations) counts.missionRelations = missionRelations;
    const actionEvents = typeof this.repo.actionEventCount === 'function' ? this.repo.actionEventCount() : 0;
    if (actionEvents) counts.actionEvents = actionEvents;
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
