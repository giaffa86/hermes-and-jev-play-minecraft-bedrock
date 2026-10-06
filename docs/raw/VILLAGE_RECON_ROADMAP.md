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
| `survey_village` | Bounded, read-only reconnaissance: walk the cells around the village anchor that were never scanned, count beds/plots/pens/containers, and write the facts to memory. Three independent limits (`VILLAGE_SURVEY_MS` cooldown, `VILLAGE_SURVEY_CELLS` exploration budget, `VILLAGE_SURVEY_MAX_MS` execution budget) stop it deterministically at whichever is reached first, and the census it returns says so with `truncated: true` + `stoppedBy`; when the mission cannot start at all it instead **refuses** with a typed code. Landed codes: `village_unknown` (no village identified: the sweep does not invent a centre), `village_too_far` (beyond `VILLAGE_SURVEY_MAX_DISTANCE`), `survey_cooldown` (another pass inside `VILLAGE_SURVEY_MS`). Never digs, never touches an entity — `DIG_PROTECTED` is a global invariant. |

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
               "contentsKnown": true, "status": "known", "rememberedAt": 0 }],
  "survey": { "scanned": 4000, "cells": 8, "dropped": 0, "truncated": false },
  "blocks":  { "distinct": 12, "truncated": false, "capped": false, "cappedNames": [] },
  "origin": { "x": 113, "y": 73, "z": 156 },   // where the census was taken
  "at": 0,
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

**Refusal and truncation are two different facts.** `truncated: true` describes
the census that *was* returned — the sweep stopped before the spiral was walked
out, and the **action result** carries `stoppedBy` with the cause that fired:
`"cells"` (the exploration budget), `"radius"` (the bound was reached with
unvisited cells still outside it), `"time"` (the executor's wall-clock budget); a
spiral walked out to its end is `"exhausted"` with `truncated: false`. A typed
refusal is the *action result* instead of a census: the mission could not proceed
at all. Keeping them apart is what lets the controller reason without parsing
strings. The view's own `survey` block is smaller and purely descriptive
(`scanned`, `cells`, `dropped`, `truncated`): a *look* is not a *mission*.

**The bound is anchored; the clock is not part of the plan.** The geometric limit
is a pure function of `(anchor, visited, config)`: the distance is measured from
the anchor, never from the bot's current position, so the same state produces the
same next waypoint and the same stop cause after a restart (serialise the state,
reload it, re-plan: same answer). The wall-clock budget is deliberately *not* an
input to the planner — `planExplorationSweep` in `exploration.mjs` is pure and
clock-free, and `"time"` is stamped by whoever walks.

### New memory records

| Record | Written by | Notes |
|---|---|---|
| `kind: container`, id `container_x_y_z` | `rememberContainer` (**extended**) | fields: `discoveredAt`, `contentsKnown`, `inspectedAt`, `contents`, `status`. A discovery write (`contentsKnown: false`, `contents: {}`, `source: 'discovered'`) must **skip `_materializeContains:204`** so it cannot erase contents learned earlier; only an inspection writes contents. The deposit side must also start reading it, not just the take side |
| `kind: resource_site`, id `plot_<crop>_x_y_z` | new, via `rememberResourceSite` | a plot is a *site*, so it is a vector-indexable target |
| `kind: village_survey`, id `village_survey_x_y_z` | new, `rememberVillageSurvey` | the sweep register: `cells` = the chunk keys actually censused, `censuses` counter, `radius`, `surveyedAt`. It is what makes a later sweep cheap and a restart non-repeating, and it records *looking*, not *passing* (`kind: explored_chunk` records travel) |
| `kind: entity`, id `entity_<uniqueId>` | `rememberEntity` (already exists) | pens reference the remembered animals, not a live census |
| observations `contains` / `is_a` | `observe` (already exists) | the evidence trail, never overwritten |

### New plan field (controller-owned intent, harness-owned validity)

```jsonc
// set by the chat-order classifier, never by the model
"farm": { "crop": "carrot", "block": "carrots", "seed": "carrot", "word": "carote",
          "replant": true, "store": "known" | "nearest" | null, "field": null,
          "before": { "inventory": { "carrot": 3 }, "contained": 0, "at": 0 } }
```

The controller drives the chain step by step against `GET /options`; the
harness still decides which of the three steps is legal *now*. Two fields carry
the intent's **evidence** rather than its wording: `word` is the token the human
used (what the chat reply echoes back) and `before` is the state snapshot the
closing delta is measured against. `store: null` means the order declined
storage, so the chain ends at the plot instead of guessing a chest.

### New env vars

| Var | Default | Meaning |
|---|---|---|
| `VILLAGE_SURVEY_MS` | `600000` | **Cooldown** between two sweeps (a sweep is expensive; 10 min). It does *not* bound the duration of one sweep. |
| `VILLAGE_SURVEY_CELLS` | `4096` | **Census budget**: how many block cells one waypoint's census may scan (the `limits.maxCells` of `surveyVillage`). It is *not* the planner's waypoint budget, which is the spiral itself. |
| `VILLAGE_SURVEY_RADIUS` | `48` | Block bound of one village sweep, measured from the anchor (same reach as `STRUCTURE_RADIUS`). |
| `VILLAGE_SURVEY_SPACING` | `24` | Side of one spiral cell of the walk: finer than the bound, so a village is a handful of waypoints. The planner's ring count is derived from these two (`floor(radius / (spacing * √2))`), never set by hand. |
| `VILLAGE_SURVEY_MAX_MS` | `120000` | **Execution budget**: wall-clock ceiling of one sweep. Pathfinding, detours, chunk loading and obstacles make the cell count a poor proxy for cost, so this limit is not derivable from `VILLAGE_SURVEY_CELLS` and vice versa; the first of the two reached wins (initial value, to be tuned by the first live sweep). |
| `VILLAGE_SURVEY_MAX_DISTANCE` | `256` | Beyond this the sweep **refuses** with `village_too_far` instead of travelling: reaching the site is a journey, and a journey budget belongs to whoever calls, not to the reconnaissance. |
| `VILLAGE_RESCAN_MS` | `60000` | **Throttle of the view** (`GET /observe.village`, `observe().village`): the census is a fact of a *site*, not of an instant, so it is read once and reused. It is not the sweep cooldown (`VILLAGE_SURVEY_MS`), which bounds a whole mission. |
| `VILLAGE_CELL_CAP` | `64` | Cell cap **per block name** of the view's scan (`findBlocks` returns at most N). A name that hits it is reported in `blocks.cappedNames`: its count is a lower bound, never a measurement. |
| `VILLAGE_HOUSE_RADIUS` | `8` | Radius that clusters beds/containers into one house. |
| `VILLAGE_PLOT_MIN_CELLS` | `4` | Below this a crop cluster is not a plot. |
| `VILLAGE_MEMORY_TTL_MS` | `86400000` | After this a village fact is `stale` and must be re-read before it is depended on. |
| `CONTAINER_DISCOVERY_STALE_MS` | `21600000` | A *discovery* (a chest that exists here) goes stale after 6 h: containers do not move, so a place outlives a census. |
| `CONTAINER_INSPECTED_STALE_MS` | `300000` | An *inspection* (what is inside) goes stale after 5 min — today's `containerStaleMs`: other players move things. |

## Milestones

### V0 — Village census (aggregation only, no new movement)

**Deliverable**

- New pure module `village-survey.mjs`: `surveyVillage({nearby, farmAnimals,
  entities, beds, containers, anchor, survey, dimension, scanned, limits})` → the
  payload above.
  Deterministic, no I/O, no clock, no LLM. **Landed**: the signature consumes the
  observation shape the adapter already produces (`nearby` cells with `mature`,
  `farmAnimals`, `bed`, the storage register) and it does not reimplement the
  detector — `structures.mjs` was split (behaviour unchanged,
  `tests/structures.test.mjs` 6/6) into `structureRows({survey, entities})`,
  `scoreStructure(def, {blockRows, entityRows, dimension})` and
  `scoreStructures(...)`, and the census calls the same rule, so
  `NOT_FOUND`/`CANDIDATE`/`CONFIRMED` can never drift from
  `GET /observe.structures`. `tests/village-survey.test.mjs` (16 cases) covers
  the pure half. Still open here: the memory-first read below is not landed.
- **Two inputs the detector needs and the pens must not get (landed).**
  `entities` is the detector's entity evidence (`observe().entities`, villagers
  included) and is a *different list* from `farmAnimals`, which lives in the
  pens: the live path used to feed `farmAnimals` to `detectStructures`, so a real
  village could never reach `CONFIRMED` (no villagers in the livestock list).
  `survey` is the executor's own `surveyBlocks().names` histogram, merged into the
  census histogram: its *counts* are the whole radius's while the cell lists are
  capped per name, so the verdict, the `evidence` numbers and the anchor's `first`
  position stay identical to `GET /observe.structures` — and `counts` keeps
  describing the cells the census could actually cluster. `withBeds` now
  *enriches* the bed cells (`observe().bed` carries `occupied`) instead of
  replacing them: a capped bed list must never shrink a census.
- Clustering rules, each with its own `evidence` and threshold: house = a bed or
  a container plus its reachable surroundings within `VILLAGE_HOUSE_RADIUS`;
  plot = ≥ `VILLAGE_PLOT_MIN_CELLS` cells of the same crop family with a shared
  `farmland` level; pen = a fenced enclosure with animals inside.
- Adapter: extend the structure view (`_surveyStructures:1279`) into a village
  view and expose `GET /observe.village` (additive; `observe().village`), always
  with `checked: true` when a survey ran, so an empty village is not confused
  with "not looked". **Landed (the read path)**: `_villageCells({point, radius,
  limit})` is the census's own bounded scan — one `world.surveyBlocks` pass for
  the names that exist (the fence family is discovered from it, never from a
  whitelist) plus `world.findBlocks(name, point, STRUCTURE_RADIUS,
  VILLAGE_CELL_CAP)` for `bed`, the crop blocks (`CROP_BLOCKS`) and those fences,
  maturity read per cell via `cropMaturity` with a live-column fallback
  (unreadable stays `null`, never guessed). `_villageView({force, limits})`
  memoizes the census for `VILLAGE_RESCAN_MS`, feeds it the cells, the livestock,
  the entities (villagers), the beds with occupancy, the storage register
  (`known` → `contentsKnown: true`, `toInspect` → `contentsKnown: false`), the
  anchor of the detected village, the survey histogram and the scanned count; it
  adds `at`, `origin` and `blocks` (`{distinct, truncated, capped, cappedNames}`)
  to the pure payload. `observe().village` carries it (memoized, so the hot
  `observe()` costs one scan a minute) and `GET /observe.village?force=1` re-reads
  on demand. `tests/village-view.test.mjs` (6 cases) covers the collection: cells
  from the world and not from the `observe().nearby` sample (4 per name), the
  detector reading villagers, memoization and `force`, the per-name cap declared,
  the register's two states, and "not looked" staying `checked: false,
  state: null`.
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
empty arrays and `checked: true`. **Landed (13 cases)**: empty input ⇒
`checked: false, state: null`; looked-and-empty ⇒ `NOT_FOUND` with its `missing`
list; two beds ⇒ `CANDIDATE` with `evidence: ['beds 2']` and already one house;
a full site ⇒ `CONFIRMED` anchored on the bell, not on the beds; two bed clusters
20 blocks apart ⇒ two houses, each with its own container; `observe().bed`
enriching `occupied` without doubling a bed; a plot with
`{crop, seed, cells, ready, immature, unknown, center}`; unreadable maturity ⇒
`unknown`, never guessed; different crops never merging; pens fenced/unfenced
with villagers excluded from the animals; storage ordered from the anchor with
`contains: null` for `contentsKnown: false`; the cell budget reporting
`dropped`/`truncated`; and a shuffled input giving the identical census. Still
open in this file: the **memory half** of the same file (a populated memory with
no live survey, `source: 'memory'`, an old record reported `stale` rather than
dropped, a live fact winning over a remembered one, `findEntities` genuinely
exercised).

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
  anchor, a radius and a census. **Landed (the wiring, not a second engine)**:
  `villageSweepConfig({anchor, radius = VILLAGE_SURVEY_RADIUS, spacing =
  VILLAGE_SURVEY_SPACING, visited = []})` in `village-survey.mjs` builds exactly
  the planner's input — a function, not a planner:

| Planner input | Where it comes from | Notes |
|---|---|---|
| `anchor` | the detector's anchor (bell → bed → composter) | the geometric origin; `null` or non-finite ⇒ `planExplorationSweep` refuses with `no_anchor` |
| `spacing` | `VILLAGE_SURVEY_SPACING` (24) | the side of one spiral cell: a village is a handful of cells, not a region |
| `maxRadius` | **derived**: `floor(radius / (spacing * √2))` | the rings that fit *inside* the bound, so no waypoint is ever planned outside it and the assigned area closes with `stoppedBy: 'exhausted'`, `truncated: false` |
| `radius` | `VILLAGE_SURVEY_RADIUS` (48) | the anchored block bound, the same reach as `STRUCTURE_RADIUS` |
| `cells` | always `null` | the *waypoint* budget is the spiral itself; `VILLAGE_SURVEY_CELLS` bounds the *blocks* censused per waypoint — two different budgets, never conflated |
| `visited` | the register's already-censused cells (∪ the last sweep's, in RAM), passed as an **array** | the config must survive `JSON.stringify`, so it is never a `Set` (the planner accepts both). **Not `visitedChunks`** — the deviation is explained in the landed note below |

  `tests/village-sweep.test.mjs` (7 offline cases) pins the contract: the key set
  the planner receives, the anchor as the first waypoint, the same `(anchor,
  visited, config)` through a JSON serialise/reload, `array` and `Set` giving the
  same plan, `visited` shrinking the plan instead of moving it, no waypoint
  beyond the bound, the `no_anchor` refusal, and the two budgets staying two
  distinct facts.
- **Landed — the action, not a second engine** (`_surveyVillage` in
  `bedrock-adapter.mjs`): the three limits above, the typed refusals, the walk
  through `_moveTo` and the register write. `_villageVisited()` reads the sweep's
  cells from `memory.villageSurvey({near: anchor, radius: VILLAGE_MEMORY_RADIUS})`,
  checks that the record belongs to *this* site (≤ 8 blocks from the anchor: two
  villages a few dozen blocks apart never share cells) and unions the last
  sweep's cells only when they are the same site. **Only a reached waypoint is
  marked censused**: the census is a scan around where the bot *is*, so recording
  a failed waypoint's cell would make a later sweep skip an area nobody ever
  looked at — the register may under-claim, never over-claim. A truncated or
  blocked pass still writes the cells it did reach, which is exactly what lets the
  next pass resume where this one stopped. `tests/village-sweep-action.test.mjs`
  (9 offline cases).
- **`visitedChunks` is deliberately *not* the sweep's `visited`** (a documented
  deviation from the earlier draft of this milestone, and the reason is the point
  of it): the chunk index records *travel* (`markChunkVisited`, `source:
  'travel'`), and a village is normally detected by walking through it — so a
  sweep keyed on travel would find its whole assignment already "censused" and
  would never scan anything. The index still receives its own writes (the walk is
  a journey, and each reached cell is marked), but idempotence comes from the
  register, which records *looking*. "A restart between the first and the second
  sweep plans zero movement" is therefore a statement about
  `kind: village_survey`, not about the chunk index.
- **The radius bound cannot fire from this action, and that is deliberate**:
  `villageSweepConfig` derives `maxRadius` from `radius`, so every planned
  waypoint is *inside* the bound and the assigned area closes with
  `stoppedBy: 'exhausted'`, `truncated: false`. `'radius'` stays the planner's own
  guard for a caller that sets `maxRadius` by hand
  (`tests/exploration-sweep.test.mjs`), and the action propagates
  `stoppedBy`/`boundary` verbatim when it does appear.
- **Three independent limits, the first one reached wins.**
  `VILLAGE_SURVEY_MS` is the *cooldown* between two sweeps (not a bound on one),
  `VILLAGE_SURVEY_CELLS` is the *exploration* budget (how many new cells may be
  scanned) and `VILLAGE_SURVEY_MAX_MS` is the *execution* budget (wall clock).
  Cells are a poor proxy for cost: at 4096 cells pathfinding, detours, chunk
  loading and obstacles can cost very different amounts of real time, so neither
  budget implies the other. Termination is deterministic — the sweep stops at
  whichever limit is reached first and reports `stoppedBy`: `"cells"` (the
  exploration budget), `"radius"` (the anchored bound was reached with unvisited
  cells still outside it) or `"exhausted"` (the spiral inside the bound is fully
  walked, `truncated: false`). The wall-clock budget is stamped by the executor
  as `"time"`: `planExplorationSweep` in `exploration.mjs` is pure and
  clock-free, the bound is measured **from the anchor**, and the bot's position
  is not an input — so `(anchor, visited, config)` reproduces the same next
  waypoint and the same stop cause after a restart. **Landed**:
  `tests/exploration-sweep.test.mjs` (9 offline cases).
- **A refusal is not a truncation.** `truncated: true` describes the census that
  was returned; a typed refusal (`village_unknown`, `village_too_far`,
  `survey_cooldown`) is the action result and means the mission **could not
  proceed** (no anchor, too far to be reconnaissance, budget already spent).
  Hermes reasons on fields, never on strings.
- **`DIG_PROTECTED` is a global invariant, not survey logic.** A sweep may detour
  or fail, but it may never modify the world to reach a cell: villages, beds,
  farmland, fences and crops stay intact, and "just this one block" is not in
  the contract. Villages and structures carry persistent state (beds, jobs,
  trades, mob behaviour) that is not sacrificial terrain — the same rule that
  already protects chests, tables and stations in the base world.
- The sweep result is a mission (`rememberStructure`/checkpoints already exist),
  so a run interrupted by death resumes instead of restarting.

**Test**: the planner half is landed and offline in
`tests/exploration-sweep.test.mjs`; **the action half is landed too**, in
`tests/village-sweep-action.test.mjs`: a completed sweep walks the planner's
waypoints and writes the register (anchor first, the config identical to
`planExplorationSweep`'s, the `busy` lock released, the walk marked in the chunk
index); the cell budget truncates the walk with `stoppedBy: 'cells'` while the
action itself stays `ok: true`; the execution budget truncates with
`stoppedBy: 'time'` while cells are still unscanned; the geometric bound is the
planner's (the assigned area closes with `'exhausted'`); a waypoint that cannot
be reached stops the pass with `blocked: true` and only the reached cells are
recorded; a second sweep over a fully scanned ring plans zero movement; **a
restart between the first and the second sweep still plans zero movement** (RAM
fresh, register loaded — the idempotence is the register's, never the RAM's); the
censused cells of another village are never reused; the three refusals are typed
and start no mission; the option is offered only with an anchor and outside the
cooldown. A protected block in the way is never broken (the route detours or
fails — the sweep never digs), and the typed code makes a refusal distinguishable
from a truncated census without parsing text.

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
- The controller drives the chain against `/options`: `harvest_<block>` →
  `plant_<seed>` → `deposit_<item>`/`dump_inventory`, one bounded action at a
  time, ending on a **state delta** (`choreGain`-style: crop gained, seed spent,
  container content increased) rather than on the model's word.
- `plan.farm` is protected from the emergency filter the same way
  `humanOrderProtectedKeys` protects a drop/collect order, and it is what the
  chore layer already does autonomously — the order simply makes it explicit.

**Landed (2026-10-06)** — the classifier and the chain, both deterministic and
offline-tested:

- `farmOrderFromText(message)` in `controller-decisions.mjs` (pure, next to
  `isDropOrder`/`isEquipOrder`) reads a crop token through `matchItemWordText`
  (which now knows carrot, wheat and beetroot in five languages) plus a farm
  verb, and returns `{crop, block, seed, word, replant, store, field}`. It
  refuses — returns `null`, so the order stays with the planner — as soon as a
  number is present ("raccogli 4 carote"), when the verb is `cattura` (a
  capture, not a harvest) and when the named token is not a crop at all. That
  is what leaves the existing semantics of "raccogli X" intact.
- `farmStep(farm, obs, options, {progress, maxHarves})` picks at most one step
  per decision, in this order: `collect_drop` (only when a drop of *that* crop
  is on the ground), `harvest_<block>` (the harness offers it only with a ripe,
  reachable crop, so its presence *is* the evidence), `plant_<seed>` (only when
  the last harvest reported `replanted.ok !== true` — otherwise the order would
  seed the whole village) and finally the deposit (`deposit_<crop>` for
  `store: 'known'`, `dump_inventory` for `'nearest'`). `null` means "nothing
  legal now" and closes the goal.
- **The chain closes on a delta, not on a count.** `farmSnapshot` records the
  crop held and the crop already inside known containers when the plan is
  created, and the deposit step fires only while `held >
  before.inventory[crop]`: those three carrots that were in the backpack before
  the order are never "the harvest", so a run cannot claim success by putting
  away what it already had. `farmStored` deduplicates `observe().containers`
  against `observe().storage.known` by position (a chest read twice is not
  counted twice) and `farmFulfilled` = "the container grew **and** the backpack
  did not".
- **The food reserve does not hold the harvest hostage.**
  `_depositableItems({reserve, exempt})` in `bedrock-adapter.mjs` exempts
  `plan.farm.crop` by default, and the deposit section of `options()` offers
  that crop even though `_isValuable` (ingots, ores, gems) does not match it.
  Without the exemption the option would be offered and then refused by the
  policy that decides what is worth storing; offer and action now read the same
  rule.
- **The emergency filter knows the farm vocabulary.** `farmOptionKeys` in
  `bedrock-survival.mjs` joins the protected keys of `/options`, because
  `plant_*`, `deposit_*` and `dump_inventory` carry intent `unknown` and an
  emergency would otherwise hide the very steps the human asked for.
- `tests/controller-farm-order.test.mjs` (10 offline cases): the classifier,
  the step order (including "carrots in the backpack and no drop ⇒ harvest"),
  the cap `DEFAULT_FARM_MAX_HARVES = 8`, the delta gating, the dedupe of the
  two content sources and the adapter's exemption policy.

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

**Landed (2026-10-06)** — honesty as a structure of the payload, and the two
protection lists the recon depends on:

- **Confidence is the share of the fact that was read, never an estimate.**
  Each house, plot, pen and storage row carries `confidence` (`shareOf`, a
  rounded ratio, `null` when the denominator is 0), `evidence` (the numbers that
  produced it: `{beds, doors, containers}` for a house, `{cells, ready,
  immature, unknown}` for a plot, `{animals, adults, babies, fenced}` for a pen)
  and `missing` (a named hole: `occupancy`, `door`, `container`, `ripeness`,
  `fence`, `contents`). A house with one unread bed out of two is `confidence:
  0.5` and says `missing: ['occupancy']` — it does not round up to "a free bed
  exists". `detection.confidence` reuses the detector's own formula
  (`structures.mjs:226`), so `CANDIDATE` legitimately carries a number < 0.5.
- **Below threshold is absent, not guessed — and it is visible.** A crop cluster
  under `VILLAGE_PLOT_MIN_CELLS` produces no plot, and the count of clusters that
  were dropped is reported in `ignored.plots`; an animal the scan could not
  locate is `ignored.animals`, and a storage row without coordinates is
  `ignored.containers`. Without `ignored`, "seen and below the threshold" would
  look identical to "never looked". For the same reason `checked` is now
  `observed || scanned > 0`: a payload that reports a cell, an animal or a
  container has been looked at by definition, and `survey.scanned` is
  `max(scanned, cells)` so a counter can never claim to have read less than the
  payload reports. A payload that was never looked at names **no** missing
  marker (`missing` is gated on `checked`): a hole is relative to a measurement,
  and with no measurement there is nothing to be missing relative to.
- **`thresholds` travels with the facts.** `{houseRadius, plotRadius, penRadius,
  plotMinCells, maxCells}` is in the payload, so a reader re-derives the same
  clusters instead of guessing the rules from prose, and `VILLAGE_PLOT_MIN_CELLS`
  is applied in the census (the V0 note above is closed) with the adapter's
  `VILLAGE_PLOT_MIN_CELLS` env override folded in as `limits.plotMinCells`.
- **A storage row says whether its contents are known.** `contentsKnown: false`
  is `contains: null`, `confidence: 0`, `missing: ['contents']` — an unopened
  chest is never an empty one — and `contentsKnown: true` is `confidence: 1`.
  A stale item is still *usable*, but only with `verify: true` from
  `planStorageSearch`: the ladder orders the walk, it does not license belief.
- **Two protection lists, one of them fixed here.** `DIG_PROTECTED`
  (`bedrock-adapter.mjs:98`) already covered farmland (`farmland$`), fences
  (`_fence$`), crops (`wheat$|carrots$|potatoes$|beetroot$`) and the built
  furniture — but it matched beds with `_bed$`, and the Bedrock block is named
  plain `bed`, so **a village bed was diggable**. It is now `(^|_)bed$`, which
  covers `bed` and the Java-style `oak_bed` without touching the crop exemption
  at `:9145` (a *mature* crop must stay breakable, or `harvest_<block>` could not
  work). The second list is the chain's: `farmOptionKeys` contains no `mine_`/
  `dig_` key, checked by the test against the source text.
- `tests/village-honesty.test.mjs` (14 offline cases): a payload that reports
  data is never `checked: false`; a payload nobody looked at claims nothing (no
  state, no evidence, no `missing`); "looked and empty" names every rule below
  its `min`; confidence is the read share for plots, houses and pens; unknown
  contents is not an empty chest; a crop cluster below the threshold is absent
  and counted in `ignored`; the thresholds travel; a stale memory is used only
  with `verify: true`; no destructive key exists in the recon path; and
  `farmland`, `bed`, `oak_fence` and an immature `carrots` all stop `_digTargets`
  with a typed `protected_*` error while the chain still breaks the ripe crop it
  harvested and never the farmland under it.

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
| pure | Clustering (houses, plots, pens), thresholds, `confidence`/`evidence`/`missing`, `ignored`, empty input | `tests/village-survey.test.mjs` |
| unit | **Register read**: memory-first without a live survey, `source`/`status`/`observedAt`, live beats remembered, `findEntities` pens survive a restart | `tests/village-register.test.mjs` |
| unit | **The ladder**: known-contents first, discovered-uninspected second, local scan third, sweep last; a discovery write never erases contents learned earlier | `tests/village-register.test.mjs` |
| pure | Two-depth TTLs: a discovery row survives an inspection-TTL expiry; an inspection row is `stale` while its discovery is still fresh | `tests/village-register.test.mjs` |
| pure | **Landed**: `villageSweepConfig` → `planExplorationSweep` (anchor first, derived rings, JSON serialise/reload, `visited` shrinks the plan, `no_anchor`), waypoint budget ≠ census budget | `tests/village-sweep.test.mjs` |
| unit | Sweep budget (**cells and time**, first limit wins), second-pass idempotence **including a restart between the two passes**, protected-block detour, refusal vs `truncated` | `tests/village-sweep.test.mjs` (action half, open) |
| unit | Deposit target from memory vs cache, stale re-read, fallback | `tests/bedrock-storage-memory.test.mjs` |
| unit | **Landed (10)**: farm-order classification vs the collect path, chain closing on delta, adapter's food-reserve exemption | `tests/controller-farm-order.test.mjs` |
| unit | Reconciliation with `GET /observe.structures` and the chore layer | `tests/village-labor.test.mjs` (extension) |
| unit | **Landed (14)**: honesty (confidence = read share, `missing` gated on `checked`, `ignored` for below-threshold), stale memory only with `verify`, no destructive key, `bed`/`farmland`/`fence`/immature crop protected | `tests/village-honesty.test.mjs` |
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
