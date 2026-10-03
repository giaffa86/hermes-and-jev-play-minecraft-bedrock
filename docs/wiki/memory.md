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
  - consolidation: terminal mission → productivity hint (episodic → semantic)
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

## Missions and checkpoints

An exploration mission is a persistent node (`kind: mission`) with a lifecycle in
`state` (`running`/`paused`/`found`/`failed`/`cancelled`), separate from the
memory `status` freshness. It links to its target (`mission --targets-->
biome:cherry_grove`). Checkpoints are **sparse** nodes linked to the mission
(`mission --has_checkpoint--> checkpoint`) and chained
(`checkpoint[n] --next--> checkpoint[n+1]`), so the route can be reconstructed,
replayed to return to the target, and later guide a player ([exploration](exploration.md) M1/M2/M3).

- `createMission`/`getMission`/`updateMission`/`completeMission`/`failMission`,
  `missions({ state })`.
- `addCheckpoint(missionId, position, { biome })`, `missionCheckpoints`,
  `lastCheckpoint`, `missionRoute` (mission + ordered checkpoints + total
  distance from the origin).
- On spawn a `home` landmark is registered; the adapter records a checkpoint
  **only while a mission is active** and only every `CHECKPOINT_MIN_DISTANCE`
  (~48 blocks) — at motion end / discovery, never at every move.
- HTTP: `GET /mission` (active route), `POST /mission` (create + activate),
  `POST /mission/complete`.

## Goal / episodic layer (mission + mission_relation + action_event)

Sopra il world graph c'è lo strato **goal/episodico**, separato: lega il comando
utente (una *missione*) ai nodi del mondo **senza sporcarli**.

- **`mission`** (nodo `kind: mission`): `rawPrompt`, `intent`
  (`explore | collect_resource | go_to | build | trade | …`), `type`, `target`,
  `state` (running/paused/found/failed/cancelled), `outcome`, `success`,
  `startedAt`/`completedAt`, `result`/`failureReason`. API: `createMission` /
  `updateMission` / `completeMission` / `failMission` / `finishMission`.
- **`mission_relation`** (tabella separata da `memory_relation`): archi **di
  goal** — `mission_42 --seeks--> resource:iron_ore`, `--targets--> cave_07`,
  `--destination--> home`, `--origin`/`--via`. `linkMission` garantisce il target
  come nodo, ma l'arco NON entra nel world graph (`relationsFrom` non lo vede):
  non si mischia "cosa so" con "cosa voglio".
- **`action_event`**: cronologia azioni per missione (`goto`/`mine`/`deposit`/…)
  con `outcome` e timestamp — proiezione del log del controller, non una seconda
  fonte di verità.
- **Query episodiche**: `findPreviousMissions({ intent, target })` e
  `findSuccessfulLocationsFor(resource)` (missioni concluse con successo che
  cercavano una risorsa → il luogo spaziale dove è stata trovata). È il mattone
  del "l'ultima volta ho usato cave_07 per il ferro".
- **Resume**: `missions({ state: 'running' })` elenca le missioni interrotte, da
  riprendere dopo un riavvio.

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
- **Missions + checkpoints**: `createMission`/`addCheckpoint`/`missionRoute` +
  `GET /mission`, `POST /mission`; the adapter records sparse checkpoints during
  an active mission (route replay / escort).
- **Goal/episodic layer**: `linkMission`/`missionRelations`/`recordAction`/
  `missionActions` + `findPreviousMissions`/`findSuccessfulLocationsFor` and
  `finishMission` (outcome/success). **Wired into the controller**: each goal
  becomes a mission (`POST /mission` with `rawPrompt` + `intent`), target items
  become `seeks` edges (`POST /mission/link`), each action is an `action_event`
  (`POST /mission/action`) and the goal end closes the mission (`POST
  /mission/finish` with outcome/success); the controller log carries `missionId`
  on `result` lines. Degrades gracefully if the harness has no `/mission`.
- The adapter persists chest observations (`_setContainerContents`) and runs the
  discovery producers (`_rememberDiscoveries`, once per chunk: portal, resource
  site, notable entities).
- On spawn, `home` is registered once as a landmark; `/observe.memory` exposes a
  compact view (landmarks, containers, portals, kind counts).
- `MEMORY_DIR` (env, default `runs/memory`) selects the directory; the file is
  `world.sqlite` (or `world.json` with `backend: 'json'`).

## Episodic → semantic consolidation

Implemented in `world-memory.mjs`: the service owns the semantics (no separate
module, so the mission lifecycle can call it without an import cycle).

- **Trigger**: every *terminal* mission patch (`finishMission`, `completeMission`,
  `failMission`, `updateMission` with a terminal shape). Consolidation is
  attempted on each terminal patch and is cheap + idempotent, so an outcome that
  arrives after `completedAt` is still consolidated. `autoConsolidate: false`
  disables the hook (used by the backfill test).
- **Productivity hint**: a top-level `productivity` key on the spatial node
  (`resource_site_<cx>_<cz>` for a chunk anchor, or the mission's `targets`
  node): `productivity.iron_ore = { attempts, successes, failures, found,
  confidence, contradicted, outcome, first, last, lastFailureAt, updatedAt,
  sources[], sourcesCutoff }`. It is a **hint, not a fact**: the node keeps its
  known/stale/invalid status and the planner re-verifies on the spot.
- **Anchor resolution** (strongest evidence first): the mission's `targets` node
  with a position → the position of the last successful action (`data.position`,
  recorded by the controller) → `mission.targetPosition` → the last checkpoint →
  the current position. The `origin` is deliberately never used: *starting* a
  mission somewhere does not mean the resource is there.
- **Chunk fusion**: a chunk-anchored episode reuses the discovery producer's id
  (`resource_site_<floor(x/16)>_<floor(z/16)>`), so N episodes in one chunk
  produce one node, not N.
- **Resources**: `seeks` edges + successful `mine_<block>` (+1 each),
  `collect_drop` (`item`/`count`), `take_<item>` (0: intent only) and the
  numeric fields in `result` (`found = max(...)`, so a declared count never
  inflates the estimate).
- **Idempotency**: episodes are deduped by mission id inside `sources`;
  `sourcesCutoff` makes a replay of a truncated source list a no-op; the
  `consolidated_into` mission relation short-circuits an already-merged mission.
- **Contradiction**: a later failure is recorded, not overwritten —
  `contradicted: true`, `confidence = successes/attempts`, `lastFailureAt`; the
  read path can exclude them (`includeContradicted: false`).
- **Bounded**: `maxHintSources` (20) per resource and `maxHintsPerNode` (12) per
  node (the least recently updated hint is dropped).
- **Read path**: `productivityHints(...)` + `productivityScore(entry)` (success
  rate with a yield bonus), `provenLocationsFor(resource, ...)`,
  `GET /memory/hints?resource=&limit=`, `POST /memory/consolidate` (idempotent
  backfill for missions closed before this feature); `observeView()` — hence
  `GET /observe` → `memory.hints` — carries a bounded list, and the controller
  turns it into a "proven locations … these are hints, not facts" line in the
  planner prompt.
- **Preservation**: `rememberLandmark`/`rememberResourceSite` rebuild the record
  from a fixed field list, so they now carry `productivity` over — otherwise the
  discovery rescan would silently erase a consolidation.
- **Tests**: `tests/memory-consolidation.test.mjs` (27 cases × json/sqlite:
  idempotency, merge, contradiction, truncation, caps, chunk fusion, backfill,
  disabled flag, planner/observe views) and the read-path test in
  `tests/adapter-memory.test.mjs` (the hint reaches `observe()` and survives a
  rescan).
- **Known limits**: the yield is an estimate from actions (`mine_<block>` = 1)
  unless the mission declares counts, and the *score* caps that bonus at 10 even
  though `found` stores the observed value; hints are per node, not per
  biome/dimension; consolidation never deletes the episodic record, so a
  retention/pruning policy is still open (see next slices).

## Observation log

The graph is a **projection of a log**: every derived claim is written down as an
observation and the edges are recomputed from it.

- **Shape**: `subject → predicate → object` with `confidence`, `observedAt`,
  `source` and free-form `data`. `OBSERVATION_CONCEPT_KINDS` maps the predicates
  that already exist as concept nodes: `contains → resource:<name>`,
  `is_a → structure:<name>`, `in_biome → biome:<name>`.
- **Producers**: `rememberContainer` (one observation per item),
  `rememberResourceSite` (one per ore) and `rememberStructure` (the `is_a` edge)
  call `observe()`. They keep writing the graph directly: the log is the *history*
  of those writes, not a second source of truth.
- **`materialize({ limit, now })`**: for each `subject|predicate` pair the newest
  observation wins; an edge the log no longer supports is **invalidated** (never
  deleted); observations whose subject node is gone are counted `orphaned` and do
  **not** resurrect the node. Report: `{ observations, subjects, linked,
  invalidated, orphaned, at }`.
- **Relations stay the primitive**: `link()`/`unlink()`/`invalidateRelation()` are
  what the rest of the code uses; `materialize` is the idempotent replay, and
  `hydrate()` runs it at startup (`{ ...summary(), projected }`).
- **Routes**: `GET /memory/observations?subject=&predicate=&object=&limit=`,
  `POST /memory/materialize { limit }`; `observeView()` → `GET /observe` →
  `memory.observations` (bounded) and `summary().observations`.
- **Storage**: schema v5 — a JSON `observations` map (`memory-store.mjs`) and an
  `observation` table with `idx_obs_subject(subject, predicate)`,
  `idx_obs_object(object, predicate)`, `idx_obs_time(observed_at)`
  (`sqlite-memory.mjs`). Ids are
  `${subject}|${predicate}|${object}|${observedAt}#seq`, so two observations in the
  same millisecond stay distinct.
- **Contradiction**: a newer reading that disagrees (a chest that no longer holds
  the item, a site with no ore) invalidates the old edge while the old observation
  remains in the log as history.
- **Tests**: `tests/memory-observations.test.mjs` (16 cases × json/sqlite:
  filters, ordering, same-millisecond ids, idempotent replay, contradiction,
  orphan, `hydrate` reprojection, persistence after reopen).

## Semantic recall (vector index)

`vector-index.mjs` is a pure, dependency-free module: tokenizer (lowercase,
accents stripped, stopwords en/it), FNV-1a hashing, `embed()` producing a signed,
L2-normalized bag-of-words vector (2048 dims), `cosine()`, `documentText()` and
`VectorIndex` (`add`/`addRecord`/`remove`/`clear`/`search`).

- **Derived, never authoritative**: `buildVectorIndex()` indexes the *current
  records* — `VECTOR_KINDS` (landmark/structure/home/resource_site/container/
  portal/entity) **with a position**. Concept nodes (`structure:cave`,
  `resource:iron_ore`) share a place kind but are not destinations, so they stay
  out. `semanticSearch(query, { limit, minScore, refresh, filter })` returns
  `{ id, score, kind, type, label, position, productivity }`.
- **Cache**: built lazily, reused while fresh (`vectorTtlMs`, default 5000 ms) and
  marked dirty by `observe()`/`link()`/`unlink()`/`invalidateRelation()` and by
  consolidation. `POST /memory/reindex`, `GET /memory/search?q=&limit=`, and
  `GET /observe` → `memory.vector = { documents, dims, at, stale }`.
- **P0 integration**: `documentText()` indexes the productivity hint keys plus the
  qualitative words (`successful productive rich abundant proven` / `failed empty
  unproductive`), so a site that actually produced comes out for "the rich dirt
  site" instead of living in a separate table. Coordinates and counts are left
  out on purpose: a number is not a retrieval signal and only adds collisions.
- **Why it is worth having (comparative proof, 03/10)**: for *"the iron rich cave
  near the mountain"* the keyword path returns **nothing** (its `contains` values
  are game ids, so `iron` ≠ `iron_ore`) or, with a type filter, an **unordered**
  set of two caves with no relevance score at all; the vector path returns the
  right cave **first** (`precision@1 = 1`) with its position. The live round
  repeated the proof on the deployed memory
  (`resource_site_7_9` first for *"where did I find potatoes and carrots"* and
  *"productive dirt site"*), and a long productive node still wins against 12
  hash-colliding places (regression test). The comparison is measured in
  `tests/memory-semantic.test.mjs`, not claimed in prose.
- **Known limits**: lexical-semantic only (no synonym mapping — a query must use
  the game's vocabulary; `chest` matches only if the container record's `type` is
  `chest`, which is what the adapter stores), collisions are mitigated by 2048
  dimensions but not impossible, and **nothing in the planner reads
  `semanticSearch` yet**: today it is a harness/observability path plus the
  comparative test.

## Next slices

- ~~**Episodic → semantic consolidation**~~: implemented — see the
  "Episodic → semantic consolidation" section above.
- **Retention / pruning policy** for the episodic layer (missions, action events
  and checkpoints only grow today).
- ~~**Structures**~~ (`kind: structure`): implemented — `rememberStructure()`
  writes a `structure_<type>_x_y_z` landmark linked `is_a` to the
  `structure:<type>` concept node with the detector evidence, and the detector
  itself (`structures.mjs` + `surveyBlocks` in `bedrock-world.mjs`) is live
  (village + cavity) — see
  [exploration](exploration.md#structures-and-underground-targets-m5m6).
- ~~**Observation log**~~: implemented — see the "Observation log" section above
  (schema v5, `POST /memory/materialize` idempotent, `GET /memory/observations`).
- ~~**Vector index**~~: implemented — see "Semantic recall (vector index)" above
  (derived index, `GET /memory/search`, comparative proof in
  `tests/memory-semantic.test.mjs`).
- **Planner-side semantic recall**: nothing in the planner queries
  `GET /memory/search` yet. Next step is to let a free-form request ("the rich
  cave") produce candidate locations that the planner can turn into a waypoint,
  with the same "hint, not fact" re-verification as the P0 hints.

## Related pages

- [exploration](exploration.md) — the exploration spec this memory serves.
- [open-questions](open-questions.md) — the "no persistent memory" finding and gaps.
- [control-flow](control-flow.md) — where memory fits in the perceive→act loop.
