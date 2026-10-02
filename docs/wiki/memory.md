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

## Graph: nodes and edges

The store is a small **property graph** over SQLite, not a flat list:

```
world_memory      -> nodes  (category: spatial | conceptual | dynamic)
memory_relation   -> edges  (from_id --type--> to_id)
```

- **Nodes**: **spatial** ones have coordinates (`home`, `cave_07`,
  `portal_overworld_01`, `horse_03`); **conceptual** ones do not
  (`resource:white_wool`, `biome:cherry_grove`, `structure:ancient_city`). Making
  resources first-class nodes keeps `from`/`to` always a node id (referential
  integrity, `FOREIGN KEY` enforced) instead of a polymorphic
  `'<record id>' | '<entity type>'`.
- **Edges** live in `memory_relation` (`from_id`, `to_id`, `type`, `confidence`,
  `status`, `first_seen_at`, `last_seen_at`, `metadata_json`) with indexes on
  `(from_id,type)`, `(to_id,type)`, `(type,status)`. Examples:
  `chest_91 --contains--> resource:white_wool`,
  `portal_ow --linked_to--> portal_nether`, `cave_07 --leads_to--> mineshaft_02`.
- **API**: `link`/`unlink`/`invalidateRelation`, `relationsFrom`/`relationsTo`,
  `neighbors`, `traverse(start, { depth })`, and the direct planner query
  `find({ kind, relation: { type, target }, nearestTo })`. `traverse` shines on
  chains (`home → portal_ow → portal_nether → fortress`); for most planner
  questions the direct relation query is better.
- **Spatial relations are derived, never stored**: `near(a, b, threshold)`,
  `withinRadius(from, { radius })`, `nearest(from, { kind })`. `near` depends on
  the distance between A and B (not on where the bot is) and would go stale if
  persisted.
- **Observation ≠ relation**: the container/site keeps its raw `observations`,
  and the `contains` edges are *materialized* from the latest observation
  (re-reading a chest invalidates the items that are gone). A future slice can
  make this an explicit observation log feeding the current graph.

## What is implemented

> **Live-verified on 02/10**: the deployed container read 8 chests/barrels (a
> chest at (105,72,138) with 122 emeralds among the rest), then a container
> **restart** reloaded all records from `runs/memory/world.sqlite` — the bot
> remembers the chests and their contents across sessions. The discovery
> producers were also verified live (resource sites, portals, entities), and so
> was the **graph**: schema migrated v2→v3, concept nodes
> (`resource:coal_ore`, `resource:iron_ore`, `resource:copper_ore`,
> `resource:lapis_ore`) and `contains` edges (`resource_site_9_9 --contains-->
> resource:coal_ore`) materialized in SQLite.

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
- **Explored chunks** (`kind: explored_chunk`): `markChunkVisited` (records the
  chunk **biome** via `bedrock-world.biomeAt`), `isChunkVisited`, `visitedChunks`,
  `chunksWithBiome`, and `unexploredFrontier` (chunks adjacent to a visited one
  but not yet visited — the "next place to explore" for the deterministic
  planner). Visits are **buffered in RAM** and written in one transaction
  (`upsertMany`), so the perception loop never does one INSERT per block.
- **Knowledge graph**: `link`/`neighbors`/`traverse`/`find({ relation })` +
  conceptual resource nodes. The producer materializes `contains` edges from
  containers and resource sites (`chest_91 --contains--> resource:white_wool`).
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
- **Mission checkpoints**: persisted exploration routes (see [exploration](exploration.md)).
- **Observation memory**: per-block observations (aggregated, batched with
  `upsertMany`) if a query ever needs them.
- **Vector index** over structured memory for *semantic* recall ("the iron-rich
  cave near the mountain") — on top of SQLite, never replacing it.

## Related pages

- [exploration](exploration.md) — the exploration spec this memory serves.
- [open-questions](open-questions.md) — the "no persistent memory" finding and gaps.
- [control-flow](control-flow.md) — where memory fits in the perceive→act loop.
