# World memory (persistent)

Topic: the **persistent world memory** — what the bot has discovered about the
world, and how it survives across sessions. This is the infrastructure layer the
autonomous exploration and multi-day expeditions build on.

Sources: `memory-store.mjs` (JSON repository), `sqlite-memory.mjs` (SQLite
repository), `world-memory.mjs` (service), `bedrock-harness.mjs` (wiring).

## Why it exists

Before this, the bot had **no persistent memory**: `this.containers` (chest
cache) was a volatile `Map`, `home` came from spawn/env, and the `runs/*.jsonl`
logs were append-only and never read back. So it could not remember *where the
sheep pen is*, *which chest holds the wool*, or *which chunks it had explored*
(see the resolved finding in [open-questions](open-questions.md)).

The cycle changed from:

```
perceive -> act -> forget
```

to:

```
perceive -> update memory -> plan -> act -> verify -> update memory
```

## Architecture

```
Planner / skills
      |
WorldMemoryService  (world-memory.mjs)
  - record model + status (known/stale/invalid)
  - queries: findLandmarks / nearestLandmark / containersWithItem
      |
Memory repository (abstract: get/upsert/find/remove/markStaleBefore/count/flush)
  - SqliteMemoryRepository  (default; node:sqlite, WAL)
  - JsonMemoryRepository    (fallback / tests)
```

Skills and the planner talk **only** to the service, so the storage can change
(JSON -> SQLite -> anything) without touching them.

## Storage: SQLite (built-in) + WAL

- `node:sqlite` (built-in in Node 22.5+/24) — **no native build**, which matters
  because the project installs with `npm install --ignore-scripts`.
- `PRAGMA journal_mode = WAL` for concurrent reads / efficient writes;
  `synchronous = NORMAL`. Committed writes are durable in the WAL.
- One `world_memory` table + a `data` JSON column, with a **chunk index** for
  spatial lookups:

```sql
world_memory (
  id, kind, type, dimension, x, y, z, chunk_x, chunk_z,
  status, confidence, discovered_at, last_seen_at, data
)
-- indexes: kind, (kind,type), status, (dimension,chunk_x,chunk_z), last_seen_at
```

- A spatial query first restricts to nearby chunks (`dimension, chunk_x, chunk_z`),
  then the service computes the exact distance on that subset (no R-tree yet).
- **Write policy**: immediate for critical records (landmark, portal, death site,
  container update); future high-frequency data (chunks seen, observations,
  movement) must be **batched**, never one INSERT per block.

## Record model (shared fields)

```jsonc
{
  "id": "sheep_farm_123_64_-87",
  "kind": "landmark",          // landmark | structure | resource_site | portal | entity | container | home
  "type": "sheep_farm",        // the specific kind (village, ancient_city, nether_portal, chest, ...)
  "dimension": "overworld",
  "position": { "x": 123, "y": 64, "z": -87 },
  "discoveredAt": 1790...,
  "lastSeenAt": 1790...,
  "confidence": 1.0,
  "status": "known",           // known | stale | invalid
  "tags": [],
  "source": "discovered",
  "contents": { "white_wool": 42 }   // containers only (in `data` JSON)
}
```

### Memory is historical, not current truth

`lastSeenAt` means *when the bot observed it*, not *that it still exists*. The
three levels keep an agentic system from turning "it was there" into "it is
there":

| status | meaning |
|---|---|
| `known` | probably still valid |
| `stale` | must be re-checked before depending on it (e.g. a chest read a while ago) |
| `invalid` | known to be gone |

`refreshStatuses()` promotes records older than their TTL to `stale` (never
`invalid`): containers go stale after minutes, landmarks after hours.

## What is implemented

> **Live-verified on 02/10**: the deployed container read 8 chests/barrels (a
> chest at (105,72,138) with 122 emeralds among the rest), then a container
> **restart** reloaded all 9 records (`home` + 8 containers) from
> `runs/memory/world.sqlite` — the bot remembers the chests and their contents
> across sessions. Direct SQL (`json_extract`, chunk-spatial sort) works.

- Landmarks: `rememberLandmark`, `findLandmarks`, `nearestLandmark`, `hasLandmark`.
- Containers: `rememberContainer`, `findContainers`, `containersWithItem`.
- **Resource sites** (`kind: resource_site`): `rememberResourceSite`,
  `findResources({ contains })` — ores observed near the bot, deduped per chunk
  (`observations: ['diamond_ore', 'iron_ore', ...]`).
- **Portals** (`kind: portal`): `rememberPortal`, `findPortals` — the `portal`
  block becomes a portal landmark that carries the nether-side coordinates once
  visited (relation between the two dimensions).
- **Entities** (`kind: entity`): `rememberEntity`, `findEntities` — notable
  rideable entities (horse/donkey/…), keyed by the entity `uniqueId`, with a
  `state` (`leashed`, ...) and a lower `confidence` (they move).
- The adapter persists chest observations (`_setContainerContents`) and runs the
  discovery producers (`_rememberDiscoveries`, once per chunk: portal, resource
  site, notable entities).
- On spawn, `home` is registered once as a landmark; `/observe.memory` exposes a
  compact view (landmarks, containers, portals, kind counts).
- `MEMORY_DIR` (env, default `runs/memory`) selects the directory; the file is
  `world.sqlite` (or `world.json` with `backend: 'json'`).

## Next slices

- **Structures** (`kind: structure`): villages, Ancient Cities, … — heuristic
  detection (villagers + beds + village blocks) in the exploration spec M5. The
  `kind` already exists in the model.
- **Chunk memory**: visited chunks / unexplored frontier (batched inserts).
- **Mission checkpoints**: persisted exploration routes (see [exploration](exploration.md)).
- **Query helpers**: `findResources({ contains })` exists; add
  `nearestLandmark({ kind, radius })` variants as needs appear.
- **Vector index** over structured memory for *semantic* recall ("the iron-rich
  cave near the mountain") — on top of SQLite, never replacing it.

## Related pages

- [exploration](exploration.md) — the exploration spec this memory serves.
- [open-questions](open-questions.md) — the "no persistent memory" finding and gaps.
- [control-flow](control-flow.md) — where memory fits in the perceive→act loop.
