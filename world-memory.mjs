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

export const LANDMARK_KINDS = Object.freeze(['landmark', 'structure', 'resource_site', 'portal', 'entity', 'home']);

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
    // I "luoghi" sono tutto tranne i bauli; `kind` può restringere ulteriormente.
    const scope = kind ? { kind } : { excludeKind: 'container' };
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
    const total = this.repo.count();
    const containers = this.repo.count({ kind: 'container' });
    return { records: total, landmarks: total - containers, containers };
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
    return { landmarks, containers };
  }

  flush () {
    this.repo.flush();
  }

  close () {
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
