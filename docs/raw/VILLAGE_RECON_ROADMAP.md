# Roadmap — Village reconnaissance and the farm order

> Raw source (spec). Synthesis, milestone status and the readable summary live in
> [`wiki/village-recon.md`](../wiki/village-recon.md).
> Status: **V0–V5 spec** (nothing implemented by this roadmap; the pieces that
> already exist are listed under "Current state" and their status is tracked in
> the wiki page, not here).
> Code references: `bedrock-adapter.mjs`, `bedrock-world.mjs`, `structures.mjs`,
> `world-memory.mjs`, `village-labor.mjs`, `remembered-resource-sites.mjs`,
> `controller.mjs`, `controller-decisions.mjs`, `chat-*.mjs`, `exploration.mjs`.

## Objective

Give the bot a **village inventory it can trust** — houses, beds, animal pens,
plots with their crop and ripeness, storage with what it holds — and make one
spoken order expand into a bounded chain:

> *"raccogli le carote dal campo, rimpianta e metti il raccolto nel baule più
> vicino"*

The analogy is a robot vacuum: the map is built **once** by a slow, bounded,
read-only sweep, and every later task is a lookup plus a route on known cells —
not a new exploration. The end state is that the *order surface* stays one
sentence (`@bot raccogli le carote`) while the chain behind it
(`harvest_<crop>` → `plant_<seed>` → `deposit_<item>`) is driven deterministically
and verified by a **state delta**, never by the model's opinion.

Design principle, same as the other roadmaps: **a village is not a prompt
problem.** Beds, plots, pens and chests are countable, positional facts, so the
bot must *measure them from the world*, *store them with evidence*, and *mark
them stale* — never narrate an inventory it did not read.

## Current state (verified from the code)

The census already exists in pieces; what is missing is the **aggregation** and
one **order semantic**. Everything below was read from the code, not recalled.

1. **Histogram survey + marker detector.** `bedrock-world.mjs:294`
   `surveyBlocks(point, radius = 48, {limit = 20000, maxDistinct = 96,
   airBelow = 3})` returns a histogram by block name; `structures.mjs:150`
   `detectStructures({survey, entities, position, dimension, defs})` applies the
   marker rules of `STRUCTURE_DEFS` (`structures.mjs:35` the `village` rule:
   bell ≥ 1, `/bed$/` ≥ 2, workstations ≥ 1, villagers ≥ 2, `minScore: 5` at
   `structures.mjs:48`). Thresholds are tuned on this world and a rule below its
   `min` never scores.
2. **Live evidence of the detector.** [exploration](../wiki/exploration.md)
   records the live round of 03/10 inside the village: `structure:village` at
   (113, 73, 156), confidence 0.6, score 6, `bed: 30`, `workstations: 315`,
   `villagers: 11`, `missing: bell (0/1)` — plus the Bedrock naming lessons
   (`bed` not `oak_bed`, `stonecutter_block` not `stonecutter`, no `cave_air`).
3. **The survey is an histogram, not a map.** Declared as a known limit in the
   same page: it counts, it does not follow; and it only sees what is loaded
   around the bot (radius 48, budgeted), throttled by `STRUCTURE_RESCAN_MS`
   (`bedrock-adapter.mjs:233`, default 60 s), `STRUCTURE_RADIUS:234` (48) and
   `STRUCTURE_SURVEY_LIMIT:235` (20000).
4. **Memory already has the record kinds — but the census does not read them
   back.** `world-memory.mjs:19` `MEMORY_STATUS` (`known`/`stale`/`invalid`),
   `:29` `VECTOR_KINDS` already includes `container`, `entity`, `resource_site`,
   `:36` `OBSERVATION_CONCEPT_KINDS` maps `contains → resource` and `is_a →
   structure`. The writers all exist (`rememberStructure:378`,
   `rememberResourceSite:332`, `rememberEntity:426`, `rememberContainer:174`,
   `observe:837`) and are called from the adapter, and the read side
   (`findLandmarks:146`, `findContainers:213`, `containersWithItem:226`,
   `findEntities:449`, `findResources:363`) exists too — but, as §"Register vs
   sensor" shows, almost nobody reads it: the *published* census is rebuilt from
   the loaded radius every time.
5. **Container contents survive restarts, but only for taking.** Opening a
   container persists the contents through
   `bedrock-adapter.mjs:7056` → `rememberContainer`, and `_rememberedStorage`
   (`bedrock-adapter.mjs:7183`) offers those remembered containers to `take_*`.
   The **deposit** side does *not* consult memory: `_depositTargetFor`
   (`bedrock-adapter.mjs:7000`) scores `_cachedContainers()` (`:7041`, runtime
   cache, `CONTAINER_TTL_MS` = 5 min at `:182`) with `+100000` for a container
   that already holds the item — so after a restart the bot forgets *which* chest
   holds the carrots, even though the memory still knows.
6. **The three steps of the order already exist as option keys**, from the
   harness, and they are the only authority on validity:
   - `harvest_<crop>` — offered only for a **mature** crop and it **replants**:
     `bedrock-adapter.mjs:4383` "Harvest the mature X … and replant `<seed>`",
     with `_harvestableCrops` at `:8622` separating `ready` from `immature`;
   - `plant_<item>` on a farmland cell — `bedrock-adapter.mjs:4702`;
   - `deposit_<item>` / `dump_inventory` — `bedrock-adapter.mjs:4689` / `:4681`,
     with the deposit policy `_isKeptItem:6974`, `_depositableItems:6984`,
     `DEPOSIT_KEEP_RESERVE = 16` (`:197`), `DEPOSIT_MAX_STACKS = 8` (`:200`).
7. **The censuses the order needs are already observable.** `observe()`
   (`bedrock-adapter.mjs:3916`) exposes `nearby` (histogram), `entities`,
   `structures`, `structureSurvey`, `farmAnimals` (`_nearbyFarmAnimals:11581`),
   and `bed`/beds via `_findBeds` (`:13211`, every bed within 48 blocks with
   `occupied_bit`) — the last one cached with a 30 s TTL and sorted
   free-bed-first.
8. **The labour layer already knows the chore.** `village-labor.mjs:94`
   `harvest_crops` is declared as *"Harvest the ripe crops in the village plots
   and replant them, then put the produce away"*, with `store_harvest:108`,
   `plant_crops:161` and ten more chores; `isChoreResolved:400` verifies a **state
   delta** (`choreGain:323`, `villageSnapshot:342`) and `offeredHas`/`offeredMatches`
   (`:308`/`:314`) make `GET /options` the arbiter. `remembered-resource-sites.mjs`
   already maps `carrot → harvest_carrots`.
9. **The shortcut is ambiguous today.** `controller-decisions.mjs:173`
   `orderItem()` resolves the noun only against **inventory keys and visible
   drops**, and `isCollectOrder:221` turns "raccogli &lt;noun&gt;" into a
   *pick-up-from-the-ground* order — with the guard that a number
   (`COLLECT_GATHER_VERB:169` + `ANY_NUMBER:170`) defers to the planner. So
   `@bot raccogli le carote` means "pick up carrot items" **if the bot happens to
   carry carrots or see carrot drops**, and "go harvest carrots" only otherwise;
   the empty case answers `no_drop` (`chat-lang/it.mjs:60`). Same words, two
   different meanings, decided by the backpack.
10. **Nothing aggregates a plot, a pen or a house.** There is no record that
    says "this is the carrot field, these 6 cells are ripe, the nearest chest
    with carrots is at (x,y,z)". `_findBeds` and `_nearbyFarmAnimals` are
    point-in-time views of the loaded radius, recomputed on demand, and never
    written as a village fact.
11. **There is no village read path.** `observe()` publishes `structures` (a
    runtime field, 60 s TTL), `bed`/`farmAnimals` (recomputed on demand) and the
    container cache — never the memory. The nearest thing to a village query is
    `scanStructureTarget` (`bedrock-harness.mjs:78`), which merges the live
    survey with `findLandmarks({kind: 'structure', type})` so a landmark
    survives a restart — but only on the `find_structure` mission path. There is
    no `villageRegister(...)` to ask "what do we know about the village?".

### Game facts this roadmap must model

Checked against the reference on 06/10/2026; each still has to be re-verified on
the deployed Bedrock build before it is trusted.

- A crop is harvestable when its growth is maximal; breaking it immature leaves
  no seed to replant. Bedrock exposes growth in the block state, which
  `_harvestableCrops` already reads.
- `farmland` reverts to `dirt` when jumped on and needs water within 4 blocks to
  stay hydrated; a plot is a set of cells, not one block.
- A bed is `bed` with an `occupied_bit` property (a villager sleeping in it
  refuses the interaction); beds are what makes a house a house for this
  purpose, and they are **not** ours to break.
- Animals breed in pairs of adult, fed, same species, ~1 min cooldown; the
  census must therefore report **adults vs babies**, not just counts.

## Register vs sensor (the memory contract)

The baseline **writes to the memory more than it reads from it**: every writer
is called, and almost every reader has no production caller. The census this
roadmap builds must be published **from the memory**, with the survey acting as
the sensor that renews it. Today, precisely:

| Fact | Written by | Read back by |
|---|---|---|
| structure (incl. `village`) | `bedrock-adapter.mjs:1306`, inside `_surveyStructures` | `bedrock-harness.mjs:78` `scanStructureTarget` — live survey ∪ `memory.findLandmarks({kind:'structure', type})`, **explicitly so a landmark survives a restart**, but only on the `find_structure` mission path |
| container contents | `bedrock-adapter.mjs:7057` on every open | `_rememberedStorage:7183` + `_rememberedContainerFor:7207` for `take_*` (each row carries `rememberedAt`) |
| visited chunks (+ biome) | `markChunkVisited` at the end of a scan, `bedrock-adapter.mjs:~1257` | `bedrock-harness.mjs:508` and `:609` via `visitedChunks` (the explore route); `unexploredFrontier:512` is the API for the same job and has **no production caller** |
| resource site (ore / gather) | `bedrock-adapter.mjs:1237` | `remembered-resource-sites.mjs:52`/`:99` (`findResources`) → the remembered gather route |
| rideable entity | `bedrock-adapter.mjs:1251` | **nothing**: `findEntities:449` is read by tests only |
| home / spawn landmark | `bedrock-adapter.mjs:749` / `:12223` | `nearestLandmark`, plus the home and exploration paths |

Two consequences are part of the design, not tuning:

1. **The read path is the deliverable, not the write path.** The bot writes down
   what it sees and then forgets to consult it: a village detection from
   yesterday is in the database and the census still re-derives everything from
   the loaded radius (`STRUCTURE_RESCAN_MS` = 60 s, `bedrock-adapter.mjs:233`).
   V0 therefore adds `villageRegister({near, dimension, includeStale})`, the
   **memory-first** read that merges remembered facts with the live view and
   says which is which (`source: 'memory' | 'live'`, `status`, `observedAt`,
   `verifiedAt`); the sweep (V1) renews what is `stale` instead of re-measuring
   what is already `known`.
   - the pen census is the first production reader of `findEntities`
     (`rememberEntity:426` already records rideables, `:1251`): a pen stored as
     an entity record survives a restart, a live `_nearbyFarmAnimals` census does
     not;
   - the plot is a `resource_site` (`rememberResourceSite:332`, id
     `plot_<crop>_x_y_z`), which is the *same* record kind
     `remembered-resource-sites.mjs` already turns into a gather route — so a
     plot census feeds the existing chore path instead of duplicating it.
2. **The staleness default is a trap.** `findContainers` defaults to
   `includeStale: true` (`world-memory.mjs:213`) and `_rememberedStorage:7183`
   filters only on “contents > 0” plus reachability — so a **stale** chest is
   already good enough to be taken from. That is defensible for an explicit
   `take_*` (the bot walks there and the read re-verifies), but it must never be
   inherited by a deposit target (V2) or by a plot census (V0/V4): the register
   carries the status, and the tolerance stays an explicit caller decision.

Rule for the whole roadmap: **the memory is the register, the survey is the
sensor.** A village fact never comes from the model; it comes either from a
record with a status, or from a fresh measurement that immediately becomes one.

## The chest search: reconnaissance in two depths

"Find the iron in the chests" is the smallest order that shows what the register
is for, and the honest answer is *it depends on what was already measured*:

| What the bot did before | What memory can answer | What the order costs |
|---|---|---|
| opened that chest at some point | its contents, the last time it looked (`lastSeenAt`), and whether the record is `stale` | a lookup plus a walk: `_rememberedStorage:7183` → `_rememberedContainerFor:7207`, and `take_*` re-verifies on arrival |
| opened it in the last 5 minutes | the same, from the runtime cache (`_cachedContainers:7041`, `CONTAINER_TTL_MS:182`) | a lookup plus a walk |
| only walked past it | **nothing**: `rememberContainer` has exactly one call site, `_setContainerContents:7057`, i.e. *only after an open* | walk there and open it (`read_container:4595`), one open per container |

A chest is **opaque from outside**: its contents only become visible when it is
opened, so no amount of reasoning and no block survey can substitute for that
one interaction. But the two halves of the question have very different costs:

- **Where are the containers?** — cheap and needs no interaction at all:
  `_findNearbyStorageBlocks:7029` finds `STORAGE_BLOCKS` in the loaded palette
  (`findBlocks`, radius 32, `STORAGE_SCAN_PER_NAME = 24` at `:159`). It is purely
  runtime today (nothing persists it), which is exactly what the register must
  fix.
- **What is inside them?** — an open per container, batched at
  `STORAGE_READ_LIMIT = 8` per `read_container` (`:164`), and only for the ones
  that are reachable.

Three design consequences:

1. **A container row may be positional-only.** The register needs
   `contentsKnown: false` alongside the contents: knowing *there is a chest here*
   is a navigation fact even when the inside is unknown. Today that row cannot
   exist at all — a chest that was merely seen is not remembered, not even by
   position (the only writer is the post-open one).
2. **A sweep is paid once, a lookup is paid forever.** The reconnaissance is not
   a per-order cost: after the first pass, "find the iron" is answered from the
   memory, and only a `stale` record buys a re-check.
3. **The register says where to look, not what you will find.** A remembered
   "13 iron_ingot" may already be gone (other players move things), which is why
   `take_*` re-reads on arrival and why a `stale` record is a *candidate to
   verify*, never a promise. The cost of being wrong is one wasted walk, paid
   only when someone else emptied the chest.

This is the reason "cerca ferro nei bauli" — not the farm chain — is the first
acceptance case for V0/V2: it exercises the register, the memory read path, the
`stale` discipline and the deposit/take symmetry without involving a single
farming mechanic.

## Discovery and inspection are two different facts

The chest search above collapses two different kinds of knowledge into the one
word *knows*. They are separate facts, they cost different things, and the
register must keep them apart:

| Fact | Question it answers | Written by | Goes stale |
|---|---|---|---|
| **discovery** — `discoveredAt` | *is there a container here?* | the sweep, from the block census (`_findNearbyStorageBlocks`) | slowly — a chest does not move (`CONTAINER_DISCOVERY_STALE_MS`, 6 h) |
| **inspection** — `inspectedAt`, `contents`, `contentsKnown: true` | *what is inside it?* | `read_container` → `_setContainerContents:7057` | quickly — other players move things (`CONTAINER_INSPECTED_STALE_MS`, 5 min) |

A container row is therefore valid in three states, never two:

| `contentsKnown` | `inspectedAt` | What the row means |
|---|---|---|
| `false` | `null` | a chest is here; the inside is unknown |
| `true` | set, fresh | these were the contents at `inspectedAt` |
| `true` | set, old | these *were* the contents — verify before depending |

### The escalation ladder (cheapest knowledge first)

The rule this whole design serves: **the cheapest source of knowledge is used
first**. For an order that needs an item (“find the iron in the chests”):

| Rung | Source | Cost | Where it is today |
|---|---|---|---|
| 1 | a container whose **contents are known** to hold the item | a lookup plus a walk, re-verified on arrival | `containersWithItem:226` / `_rememberedStorage:7183` |
| 2 | a **discovered** container never inspected, nearest first | a lookup plus a walk plus one open | **missing** — nothing writes a discovery row |
| 3 | new storage in the already-loaded/perceived area | one local block scan, no walking beyond `radius` | `_findNearbyStorageBlocks:7029` (runtime only, never persisted) |
| 4 | real reconnaissance: leave the area, sweep new cells | minutes, budgeted by `VILLAGE_SURVEY_CELLS` **and** `VILLAGE_SURVEY_MAX_MS` | `find_structure` / the V1 sweep |

Rungs 1–3 are lookups and local scans; **only rung 4 is exploration**, and it is
the fallback, never the first move. The ladder is part of the planner contract:
**Hermes must not order exploration to Jev while the register can still answer at
rung 1 or 2**, and the register’s job is to make the answer visible
(`observe().village` lists the rungs, so “I don’t know” is *proved* by an empty
list instead of assumed).

### Acceptance test for the ladder: “cerca del ferro nei bauli”

| If the register … | Expected behaviour | Evidence |
|---|---|---|
| knows a chest holding iron | go straight there, re-read, take | `source: 'memory'`, no scan, no sweep |
| knows only unopened chests in the area | inspect those, nearest first, then answer | rung 2 used before rung 3; `inspectedAt` written |
| knows nothing in the area | local discovery (rung 3) within the loaded radius | one `_findNearbyStorageBlocks` pass, rows persisted |
| finds nothing locally either | only then reconnaissance (rung 4) | a bounded sweep, and its new rows are the reward |

The order of these four rows *is* the test: a run that jumps to rung 4 while
rung 1 or 2 could have answered is a failure, and the ledger says so (a sweep is
a bounded action with its own cost, `runs/<run>/actions.jsonl`).

### What separates them today, and what does not (verified from the code)

| Piece | Verdict |
|---|---|
| ids and timestamps | **ready**: `containerId:169` is spatial (`container_x_y_z`, so a re-write upserts in place) and `rememberContainer:174` already preserves `discoveredAt` across upserts (`existing?.discoveredAt ?? now`) |
| writing a discovery | **missing**: the only writer is post-open (`_setContainerContents:7057`, reached from `read_container`); a merely-seen chest is not remembered at all, not even by position |
| expressing “seen, unknown” | **missing**: `contents = {}` is overloaded (it means both *unknown* and *opened and empty*) and the write unconditionally sets `status: KNOWN`, `confidence: 1`, `lastSeenAt: now`; `source` is free text (`'discovered'` vs `'read_container'`), not a state field |
| a discovery write that does not damage inspection | **must be fixed first**: `_materializeContains:204` invalidates **every** `contains` edge of the id and rebuilds them from the contents it is given, so a naive discovery write with `contents: {}` would **erase** the “13 iron_ingot” learned earlier; `contentsKnown: false` must *skip* materialization, never empty it |
| querying rung 2 | **missing**: `containersWithItem:226` filters on `contents?.[item] > 0` (rung 1 only) and no `findContainers:213` parameter carries `contentsKnown` — “discovered, never inspected, near me” has no query |
| stale refresh | **partial**: `refreshStatuses:1398` is called only by `hydrate:1405` and has no timer, so a long session never promotes anything to `stale`; `findContainers:213` defaults `includeStale: true` while `_rememberedStorage:7183` filters only on “contents > 0” plus reachability. Per-depth TTLs need either a periodic `refreshStatuses()` or a status computed per read from `observedAt`/`inspectedAt` |
| discovery coverage | **partial**: `STORAGE_BLOCKS:157` is an exact-name list (`chest`, `trapped_chest`, `barrel`, `shulker_box`), so dyed shulker boxes are invisible, and the scan is capped at radius 32 with `STORAGE_SCAN_PER_NAME = 24` per name |

Consequence for the milestones: **V0** owns the two-depth record and the ladder
read (including the non-destructive discovery write), **V1** *is* rung 4 (the
sweep), **V2** makes the deposit path climb the ladder instead of asking only the
5-minute runtime cache.

## Rung 4 is the exploration capability, not a village-only engine

Rung 4 is not a village feature that happens to explore: it is the general
**Autonomous Exploration & Discovery** capability (`docs/raw/GOAL_EXPLORATION.md`,
the M1 “find a biome” vertical slice in `exploration.mjs`) applied to one target.
That mechanism already exists and must stay the only one:

| General capability | Where it lives today | Rung 4 of this ladder |
|---|---|---|
| Deterministic planner over unexplored cells | `exploration.mjs:53 spiralOffsets`, `:68 nextExplorationWaypoint({origin, visited, spacing, maxRadius})`, `:106 planExplorationStep` | the sweep route |
| Persistent visited state | `world-memory.mjs:581 markChunkVisited`, `:618 visitedChunks`, `:631 unexploredFrontier` | what “already scanned” means |
| Mission + checkpoints + route replay | `world-memory.mjs:777-911`, `exploration.mjs:251 replayRouteFromMission` | the sweep is a *mission*, not a one-shot action |
| Pause / resume / restart | `POST /explore` supersedes stale `running` missions, `GET /explore` steps one | a sweep interrupted by a death resumes |
| Bounded execution | per-step planning over a persisted mission | `VILLAGE_SURVEY_CELLS` + `VILLAGE_SURVEY_MAX_MS` |
| Structure discovery | `structures.mjs` detector + WorldMemory observations | the village census (V0) |
| The planner never acts | Hermes picks the goal and the harness returns one bounded step | Hermes picks `survey_village`, Jev walks it |
| Position from observation, never from `/locate` | `resolveSearchTarget`/`detectStructures`, no world-query shortcut | the scope freeze below |

**The reuse contract — what V1 adds and what it must not.**

- *Add*: a village **configuration** of the existing planner (anchor = the
  register's village anchor, spiral spacing/radius, the three limits) and a
  **consumer** at the end (the V0 census, written from what the walk actually saw).
- *Add*: `stoppedBy`/`truncated` and the typed refusals, which are about *this*
  action's budget bookkeeping.
- *Do not add*: a second frontier/spiral implementation, a second visited-chunk
  bookkeeping, a second checkpoint/route format, or a second notion of
  “mission exhausted”. If the sweep needs a behaviour the general planner lacks
  (e.g. a radius-bounded spiral around an anchor), that behaviour goes into
  `exploration.mjs` and the biome/`find_structure` paths get it too.
- *Do not*: make `survey_village` the only door to rung 4. Any later “explore this
  area” order is the same planner with a different target and a different census.

## Proposed vocabulary (closed loaders, per convention)

### New/changed `/options` action keys

| Key | Meaning |
|---|---|
| `survey_village` | Bounded, read-only reconnaissance: walk the cells around the village anchor that were never scanned, count beds/plots/pens/containers, and write the facts to memory. Three independent limits (`VILLAGE_SURVEY_MS` cooldown, `VILLAGE_SURVEY_CELLS` exploration budget, `VILLAGE_SURVEY_MAX_MS` execution budget) stop it deterministically at whichever is reached first, and the census it returns says so with `truncated: true` + `stoppedBy`; when it cannot move at all it instead **refuses** with a typed code (`village_too_far`, `survey_budget_exhausted`). Never digs, never touches an entity — `DIG_PROTECTED` is a global invariant. |

Everything else stays as it is: the chain is composed of keys the harness
already offers (`harvest_*`, `plant_*`, `deposit_*`, `dump_inventory`).

### New `/observe` and `/observe.village` fields (additive)

```jsonc
{
  "checked": true,                 // "looked and found nothing" ≠ "not looked"
  "anchor": { "x": 113, "y": 73, "z": 156 },
  "dimension": "overworld",
  "houses": [{ "anchor": {...}, "beds": [{ "position": {...}, "occupied": false }],
               "containers": [{ "position": {...}, "type": "chest" }],
               "evidence": { "beds": 2, "doors": 1 } }],
  "plots":  [{ "crop": "carrots", "cells": 10, "ready": 6, "immature": 4,
               "seed": "carrot", "center": {...} }],
  "pens":   [{ "anchor": {...}, "fenced": true,
               "animals": [{ "type": "cow", "adults": 2, "babies": 1 }] }],
  "storage":[{ "position": {...}, "type": "chest", "contains": { "carrot": 12 },
               "rememberedAt": 0, "status": "known" }],
  "survey": { "scanned": 0, "truncated": false, "stoppedBy": null, "elapsedMs": 0, "at": 0 },
  "missing": ["bell (0/1)"],
  "detection": { "state": "CONFIRMED",   // NOT_FOUND | CANDIDATE | CONFIRMED
                 "evidence": ["beds 2/2", "workstations 1/1", "villagers 3/2"] }
}
```

**Evidence is graded, not boolean.** `detection.state` is `NOT_FOUND` (the cells
were scanned and stayed empty), `CANDIDATE` (a partial marker match, stored as a
lead) or `CONFIRMED` (the markers `structures.mjs` scores: beds, workstations,
villagers), and `evidence` lists what justified the step. Nothing in this
vocabulary can be produced by a world query — the position comes from the
observation, which is why `/locate` stays out of scope.

**Refusal and truncation are two different facts.** `truncated: true` (with
`stoppedBy`: `"cells"` / `"time"` / `"distance"`) describes the census that *was*
returned — the sweep ran out of one of its budgets and says which. A typed
refusal (`village_too_far`, `survey_budget_exhausted`) is the *action result*: the
mission could not proceed at all. Keeping them apart is what lets the controller
reason without parsing strings.

### New memory records

| Record | Written by | Notes |
|---|---|---|
| `kind: container`, id `container_x_y_z` | `rememberContainer` (**extended**) | fields: `discoveredAt`, `contentsKnown`, `inspectedAt`, `contents`, `status`. A discovery write (`contentsKnown: false`, `contents: {}`, `source: 'discovered'`) must **skip `_materializeContains:204`** so it cannot erase contents learned earlier; only an inspection writes contents. The deposit side must also start reading it, not just the take side |
| `kind: resource_site`, id `plot_<crop>_x_y_z` | new, via `rememberResourceSite` | a plot is a *site*, so it is a vector-indexable target |
| `kind: entity`, id `entity_<uniqueId>` | `rememberEntity` (already exists) | pens reference the remembered animals, not a live census |
| observations `contains` / `is_a` | `observe` (already exists) | the evidence trail, never overwritten |

### New plan field (controller-owned intent, harness-owned validity)

```jsonc
// set by the chat-order classifier, never by the model
"farm": { "crop": "carrot", "replant": true, "store": "known" | "nearest", "field": null }
```

The controller drives the chain step by step against `GET /options`; the
harness still decides which of the three steps is legal *now*.

### New env vars

| Var | Default | Meaning |
|---|---|---|
| `VILLAGE_SURVEY_MS` | `600000` | **Cooldown** between two sweeps (a sweep is expensive; 10 min). It does *not* bound the duration of one sweep. |
| `VILLAGE_SURVEY_CELLS` | `4096` | **Exploration budget**: how many new cells one sweep may scan. |
| `VILLAGE_SURVEY_MAX_MS` | `120000` | **Execution budget**: wall-clock ceiling of one sweep. Pathfinding, detours, chunk loading and obstacles make the cell count a poor proxy for cost, so this limit is not derivable from `VILLAGE_SURVEY_CELLS` and vice versa; the first of the two reached wins (initial value, to be tuned by the first live sweep). |
| `VILLAGE_HOUSE_RADIUS` | `8` | Radius that clusters beds/containers into one house. |
| `VILLAGE_PLOT_MIN_CELLS` | `4` | Below this a crop cluster is not a plot. |
| `VILLAGE_MEMORY_TTL_MS` | `86400000` | After this a village fact is `stale` and must be re-read before it is depended on. |
| `CONTAINER_DISCOVERY_STALE_MS` | `21600000` | A *discovery* (a chest that exists here) goes stale after 6 h: containers do not move, so a place outlives a census. |
| `CONTAINER_INSPECTED_STALE_MS` | `300000` | An *inspection* (what is inside) goes stale after 5 min — today's `containerStaleMs`: other players move things. |

## Milestones

### V0 — Village census (aggregation only, no new movement)

**Deliverable**

- New pure module `village-survey.mjs`: `surveyVillage({blocks, entities,
  containers, anchor, dimension, limits})` → the payload above. Deterministic,
  no I/O, no clock, no LLM (the shape of `structures.mjs`, which is already pure
  and evidence-carrying).
- Clustering rules, each with its own `evidence` and threshold: house = a bed or
  a container plus its reachable surroundings within `VILLAGE_HOUSE_RADIUS`;
  plot = ≥ `VILLAGE_PLOT_MIN_CELLS` cells of the same crop family with a shared
  `farmland` level; pen = a fenced enclosure with animals inside.
- Adapter: extend the structure view (`_surveyStructures:1279`) into a village
  view and expose `GET /observe.village` (additive; `observe().village`), always
  with `checked: true` when a survey ran, so an empty village is not confused
  with "not looked".
- **Memory-first read (the actual deliverable).** A `villageRegister({near,
  dimension, includeStale, limit})` read that answers from WorldMemory first and
  falls back to the live radius, merging the two with an explicit `source`:
  - houses ← `findLandmarks({kind: 'structure', type: 'village'})` + the live
    survey, the same union `scanStructureTarget` (`bedrock-harness.mjs:78`)
    already performs for `find_structure`;
  - plots ← `findResources({type: 'plot'})` / `resource_site` records (the kind
    `remembered-resource-sites.mjs:52` already routes to a gather step);
  - pens ← `findEntities:449` (**the first production reader** of the records
    `rememberEntity:426` already writes at `bedrock-adapter.mjs:1251`) plus the
    live `_nearbyFarmAnimals:11581`;
  - storage ← `findContainers:213` / `containersWithItem:226`, plus the runtime
    `_cachedContainers:7041` — and **never with the `includeStale: true`
    default** (`world-memory.mjs:213`): the register carries `status` and the
    caller decides what it tolerates. Each storage row also carries
    `contentsKnown`, so a chest the sweep only *saw* is a known place with an
    unknown inside instead of a missing fact.
  Each row keeps `status`, `observedAt` (`lastSeenAt`) and `verifiedAt`, so the
  payload can say "known, measured 3 minutes ago" instead of implying freshness.
- **The ladder, and the two-depth record behind it.** The register must answer
  "which chest should I check first?" in the order *contents known → discovered
  but never inspected → local scan → sweep*. That needs three additions:
  `rememberContainer` accepts `contentsKnown` and **skips `_materializeContains`**
  when it is `false` (today a discovery write would erase the contents learned
  earlier); a discovery writer persists the chests
  `_findNearbyStorageBlocks:7029` already sees (today they are runtime-only); and
  `findContainers` gains a `contentsKnown` filter, because rung 2 has no query
  at all. The register exposes the ladder, so "nothing known here" is an empty
  list rather than an assumption — and only then does exploration make sense.
- Every detection writes `plot_<crop>_x_y_z` + the `is_a`/`contains`
  observations, and remembers the containers it saw with their contents — i.e.
  the same facts the read path above consumes, so the register is populated by
  the very sweep that measures it.

**Test**: `tests/village-survey.test.mjs` — a synthetic histogram with 30 beds in
three rooms yields three houses, not one blob; 4 cells of carrots are a plot and
3 are not; an enclosure with two adult cows and a calf is one pen with
`adults: 2, babies: 1`; a village with no bell still passes `minScore`
(the existing rule) and reports `missing: bell (0/1)`; an empty input returns
empty arrays and `checked: true`. Plus the memory half of the same file — a
**populated memory with no live survey** still yields the houses/plots/pens
(`source: 'memory'`, `status: 'known'`), an old record is reported `stale`
rather than dropped, a live fact wins over a remembered one at the same position,
and `findEntities` is genuinely exercised (the pen survives a restart).

**Accettazione**: live `GET /observe.village?force=1` in the known village
returns ≥ 1 house that contains the beds the detector already counted (30), at
least one plot per crop actually visible in `/observe.nearby`, and at least one
storage entry with a position; the payload never contradicts
`GET /observe.structures` on the same survey. Then the **restart check**: with
`STRUCTURE_RESCAN_MS` at its default and the harness just restarted,
`GET /observe.village` (no `force`) still names the village and its plots from
memory with `source: 'memory'` — the census must not be empty just because the
runtime cache is.

### V1 — The sweep (bounded, read-only reconnaissance)

**Deliverable**

- `survey_village` action: **a configuration of the general exploration planner,
  not a second sweep engine** (reuse contract above). It walks only the cells
  that are **not already known**: the visited-chunk index (`visitedChunks`, read
  in production at `bedrock-harness.mjs:508`/`:609`) crossed with the register
  (V0) tells it what is unknown, and `unexploredFrontier`
  (`world-memory.mjs:631`, today with no production caller) gives the cells that
  were never scanned — so a second sweep is cheap and a sweep after a restart is
  not a re-measure from zero. The route stays
  `exploration.mjs` (`nextExplorationWaypoint`/`planExplorationStep`), the
  mission/checkpoint persistence is the existing one, and the village adds an
  anchor, a radius and a census.
- **Three independent limits, the first one reached wins.**
  `VILLAGE_SURVEY_MS` is the *cooldown* between two sweeps (not a bound on one),
  `VILLAGE_SURVEY_CELLS` is the *exploration* budget (how many new cells may be
  scanned) and `VILLAGE_SURVEY_MAX_MS` is the *execution* budget (wall clock).
  Cells are a poor proxy for cost: at 4096 cells pathfinding, detours, chunk
  loading and obstacles can cost very different amounts of real time, so neither
  budget implies the other. Termination is deterministic — the sweep stops at
  whichever limit is reached first and reports `stoppedBy` (`"cells"`,
  `"time"`, `"distance"`).
- **A refusal is not a truncation.** `truncated: true` describes the census that
  was returned; a typed refusal (`village_too_far`, `survey_budget_exhausted`) is
  the action result and means the mission **could not proceed** (no anchor,
  nothing unscanned left, budget already spent). Hermes reasons on fields, never
  on strings.
- **`DIG_PROTECTED` is a global invariant, not survey logic.** A sweep may detour
  or fail, but it may never modify the world to reach a cell: villages, beds,
  farmland, fences and crops stay intact, and "just this one block" is not in
  the contract. Villages and structures carry persistent state (beds, jobs,
  trades, mob behaviour) that is not sacrificial terrain — the same rule that
  already protects chests, tables and stations in the base world.
- The sweep result is a mission (`rememberStructure`/checkpoints already exist),
  so a run interrupted by death resumes instead of restarting.

**Test**: `tests/village-sweep.test.mjs` — the cell budget stops the walk and
reports `truncated` with `stoppedBy: 'cells'`; the execution budget stops it with
`stoppedBy: 'time'` while cells are still unscanned; a second sweep over a fully
scanned ring plans zero movement; **a restart between the first and the second
sweep still plans zero movement** (idempotence must come from `visitedChunks`
plus the register, never from RAM alone); a protected block in the way is never
broken (the route detours or refuses); a refusal carries its typed code and is
distinguishable from a truncated census without parsing text.

**Accettazione**: live — one sweep of the village produces a census strictly
larger than the V0 single-shot one (more houses/plots/storage reachable), a
second sweep adds **no new facts** (idempotent, inside the
`OBSERVATION_DEDUPE_MS` window), and `node tools/run-facts.mjs <run>` shows the
action in `runs/<run>/actions.jsonl` with its duration.

**Scope freeze.** This milestone makes one bounded, memory-aware primitive work
well: no biome heuristics, no "intelligent" village search, and no `/locate`. The
anchor comes from the register and the sweep walks what the frontier says, in the
cheapest order. Guessing where a village *might* be is a different problem, and a
command that hands over knowledge would skip exactly the observation this
roadmap exists to produce.

### V2 — Storage memory on the deposit side (symmetry with `take_*`)

**Deliverable**

- `_depositTargetFor` consults `_rememberedStorage()` (memory) as well as the
  runtime cache, **climbing the same ladder**: a **known, non-stale** container
  that already holds the item, then a discovered-but-uninspected one (one open is
  cheaper than walking to an unknown area), then the nearest **reachable** one,
  then a live scan. A remembered container is re-read on the spot before the
  deposit is claimed (the same rule `_rememberedStorage` already documents for
  taking).
- **The status filter is explicit here, not inherited.** `findContainers`
  defaults to `includeStale: true` (`world-memory.mjs:213`) and
  `_rememberedStorage:7183` tolerates stale records — fine for an explicit
  `take_*`, wrong for a deposit target. The deposit path asks for `known`
  records only, treats a `stale` one as a *candidate to verify*, and never walks
  to a chest on the strength of an old row alone.
- Staleness is honest: a fact older than `VILLAGE_MEMORY_TTL_MS` is `stale`, and
  a `stale` target is verified (`read_container`) before it is used; if the
  verification fails the deposit falls back to the nearest live container.
- `observe().deposit.target` reports where it *would* put the item and whether
  that target came from memory (`remembered: true`), so the operator can see the
  difference between "known" and "guessed".

**Test**: `tests/bedrock-storage-memory.test.mjs` — after a simulated restart
(empty runtime cache, populated memory) the deposit target is the remembered
chest that holds the item; a `stale` record is not used without a re-read; a
failed re-read falls back to the live scan; the distance ordering is by
reachable distance, not by Euclidean distance.

**Accettazione**: live — put carrots in a chest, restart the harness, then
`deposit_carrot`: the item lands in the chest that already holds carrots (not
merely in the nearest one), and `/observe.deposit.target` shows
`remembered: true` before the action and the incremented content after it.

### V3 — The farm order as a single intent

**Deliverable**

- A deterministic classifier (next to `isDropOrder`/`isEquipOrder`, no Hermes):
  an order that names a **crop family** plus a farm verb ("raccogli le carote",
  "mieti il grano e rimpiantalo", "raccogli le patate e mettile nel baule") emits
  `plan.farm = {crop, replant, store, field}` instead of being read as a
  pick-up-from-the-ground order.
- The ambiguity in §Current state 9 is fixed **by evidence, not by wording**:
  `isCollectOrder` keeps winning only when the named item actually exists as a
  drop; a crop named when no such drop exists becomes a farm order (never an
  LLM call, never the `no_drop` refusal for a field standing right there).
- The controller drives the chain against `/options`: `harvest_<crop>` →
  `plant_<seed>` → `deposit_<item>`/`dump_inventory`, one bounded action at a
  time, ending on a **state delta** (`choreGain`-style: crop gained, seed spent,
  container content increased) rather than on the model's word.
- `plan.farm` is protected from the emergency filter the same way
  `humanOrderProtectedKeys` protects a drop/collect order, and it is what the
  chore layer already does autonomously — the order simply makes it explicit.

**Test**: `tests/controller-farm-order.test.mjs` — "raccogli le carote" with
carrots in the inventory is *not* a collect order when no carrot drop exists;
"raccogli 4 carote" stays with the planner (the existing number guard); the
chain closes on the delta and not on the objective text; no step is invented
when `/options` does not offer it (the harness stays the authority).

**Accettazione**: live A/B — with carrots in the backpack, `@bot raccogli le
carote` never answers `no_drop` and ends with: the plot replanted (a `carrots`
block in the harvested cell) **and** the carrots in the chest (content delta
read with `read_container`). A second identical order with everything already
stored and nothing ripe closes as "nothing to do" instead of looping.

### V4 — Honesty, protection and the limits of the map

**Deliverable**

- Every village fact carries `confidence`, `evidence` and `missing`; a type
  below its threshold is absent, not guessed (the existing rule of
  `structures.mjs`).
- Explicit protection list for the recon and the chain: never break beds,
  farmland, fences, crops-to-be; never a villager; never mass-slaughter the
  base's animals (shear/milk/breed stay the preference, and the slaughter stays
  behind an operator decision).
- Documented limits in the payload and in the wiki: the map is a **histogram
  plus clusters over the loaded radius**, not a voxel map; the sweep only sees
  what was walked; a village the bot has never visited has no facts at all. And
  the register is a **cache of a changing world**, so every row states when it
  was measured instead of implying it is still true (`memory.md` already calls
  this `known`/`stale`/`invalid`).

**Test**: `tests/village-honesty.test.mjs` — a stale record is never used
without verification; `checked: false` is impossible on a payload that reports
data; `missing` names a rule below its `min`; nothing in the recon path emits a
`mine_`/`dig_` key.

**Accettazione**: live — a sweep with a bed and a farmland block deliberately in
the route leaves both intact (block identity unchanged before/after), and
`/observe.village` after the sweep reports `scanned`, `truncated` and the
timestamp truthfully.

### V5 — Documentation and integration

**Deliverable**

- New `docs/wiki/village-recon.md` (readable status), this raw spec, and updates
  to [exploration](../wiki/exploration.md) (M5/M6 structures), the
  [roadmap](../wiki/roadmap.md) and [ai-player-roadmap](../wiki/ai-player-roadmap.md)
  (M3b village labor), [memory](../wiki/memory.md) (container/plot records),
  [verification](../wiki/verification.md) (a row per acceptance above),
  `docs/index.md`, `docs/sources.md`, `docs/log.md`, plus the `BEDROCK.md` action
  table for `survey_village` and the new `/observe.village` route.
- Open questions filed in [open-questions](../wiki/open-questions.md) instead of
  guessed answers (see Risks).

**Test**: `npm run wiki:lint` (and `--strict` before a push).

**Accettazione**: the wiki lints clean, the roadmap is reachable from
`index.md`, and every claim in the wiki page is traceable to a file:line here.

---

## Test plan

| Level | What | File |
|---|---|---|
| pure | Clustering (houses, plots, pens), thresholds, `missing`, empty input | `tests/village-survey.test.mjs` |
| unit | **Register read**: memory-first without a live survey, `source`/`status`/`observedAt`, live beats remembered, `findEntities` pens survive a restart | `tests/village-register.test.mjs` |
| unit | **The ladder**: known-contents first, discovered-uninspected second, local scan third, sweep last; a discovery write never erases contents learned earlier | `tests/village-register.test.mjs` |
| pure | Two-depth TTLs: a discovery row survives an inspection-TTL expiry; an inspection row is `stale` while its discovery is still fresh | `tests/village-register.test.mjs` |
| pure | Sweep budget (**cells and time**, first limit wins), second-pass idempotence **including a restart between the two passes**, protected-block detour, refusal vs `truncated` | `tests/village-sweep.test.mjs` |
| unit | Deposit target from memory vs cache, stale re-read, fallback | `tests/bedrock-storage-memory.test.mjs` |
| unit | Farm-order classification vs the collect path, chain closing on delta | `tests/controller-farm-order.test.mjs` |
| unit | Reconciliation with `GET /observe.structures` and the chore layer | `tests/village-labor.test.mjs` (extension) |
| unit | Protection: beds/farmland/fences/crops intact, no villager | `tests/village-honesty.test.mjs` |
| live | One sweep > one shot; second sweep adds nothing; `deposit_carrot` after restart lands in the right chest; `@bot raccogli le carote` A/B | host, bounded round |
| live | **The chest ladder**: an order for a known item goes straight to the known chest; with only unopened chests known it inspects them; with nothing known it scans locally; and only an empty local area triggers a sweep | host, bounded round |

Operational constraints for the live rows: one bot account at a time, the base
untouched (no borrowed or broken blocks), and no animal killed without an
explicit operator decision.

## Risks and open questions

1. **Clustering is a heuristic.** A house is a judgement call (a bed and a door
   make a bedroom; two beds in a shared hall make a dormitory). The roadmap
   accepts that and reports the evidence, so a wrong cluster is visible instead
   of silent.
2. **Is the growth state fully reliable on Bedrock?** `_harvestableCrops`
   already separates `ready` from `immature`, but "maturity unknown = treat as
   before" is the current conservative default; a plot census inherits that
   uncertainty and must not claim ripeness it cannot read.
3. **Cost.** A sweep is pure walking. Without the cell budget and the 10-minute
   throttle it can burn an entire action budget to re-measure what was already
   known; the throttle is part of the design, not a tuning knob.
4. **The world changes under the bot.** A human moves a chest, harvests a plot or
   kills an animal. Hence `VILLAGE_MEMORY_TTL_MS` + `stale` + re-verify: a fact
   is a *memory*, never a promise.
5. **A remembered chest is not a reachable chest.** Reachability
   (`approachReachable`) is only meaningful when the reachability model is
   usable; outside it the code is deliberately fail-open, and the deposit then
   discovers the truth by walking.
6. **The order's surface language.** "Raccogli le carote" vs "mieti" vs
   "prendi le carote dal campo" must not become a keyword list to memorise:
   the classifier reads a crop family plus a farm verb, and the fallback stays
   the planner — a miss is a planner call, never a wrong action.
7. **Should recon ever be autonomous?** V1 exposes `survey_village`; whether the
   idle autonomy should schedule it (like `village-labor.mjs` schedules chores)
   is an operator decision, not a technical one. Default: on request only.
8. **Multi-village.** Nothing here assumes one village. The anchor and the
   records are positional, so a second village is a second set of facts — but
   "the nearest village" as a concept does not exist yet.
9. **A partially renewed register.** Freshness is per fact (`observedAt`,
   `verifiedAt`), not per village: a sweep that hits its cell budget, dies, or
   is refused halfway leaves some cells renewed and others still old. The
   register must therefore be readable at cell/fact granularity (and report
   `truncated`), never as one village-wide "last scanned at" that would make an
   old plot look fresh.

## Non-objectives (for now)

- A voxel map, room segmentation or floor plans: the census is counts plus
  positions and clusters, not geometry.
- Rebuilding, renovating or villager-engineering (professions, trades, breeding
  programs) — separate roadmaps.
- Farming automation with redstone (`skills/gameplay/redstone/build_auto_harvest.json`
  exists; wiring a real farm to hoppers is its own milestone).
- Looting village chests, or treating the base's storage as a resource.
- Slaughtering the base's animals for food.
- A full "village model" for the LLM to reason about: the model is a fallback
  here, never the source of a fact.
- `/locate` or any command that hands over a position without observation: it
  would bypass the frontier, `visitedChunks` and the register in one step.
- Biome heuristics or a "smart" village search: rung 4 walks where the frontier
  says, in the cheapest order; where a village *might* be is another problem.
