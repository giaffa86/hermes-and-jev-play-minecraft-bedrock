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
4. **Memory already has the record kinds.** `world-memory.mjs:19`
   `MEMORY_STATUS` (`known`/`stale`/`invalid`), `:29` `VECTOR_KINDS` already
   includes `container`, `entity`, `resource_site`, `:36`
   `OBSERVATION_CONCEPT_KINDS` maps `contains → resource` and `is_a →
   structure`. Writers exist: `rememberStructure:378`, `rememberResourceSite:332`,
   `rememberEntity:426`, `rememberContainer:174`, `observe:837`, and the read side
   `findContainers:213` / `containersWithItem:226` (ordered by distance from a
   point, with `includeStale` left to the caller).
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

## Proposed vocabulary (closed loaders, per convention)

### New/changed `/options` action keys

| Key | Meaning |
|---|---|
| `survey_village` | Bounded, read-only reconnaissance: walk the cells around the village anchor that were never scanned, count beds/plots/pens/containers, and write the facts to memory. Refuses `village_too_far`, `survey_budget_exhausted`; never digs, never touches an entity. |

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
  "survey": { "scanned": 0, "truncated": false, "at": 0 },
  "missing": ["bell (0/1)"]
}
```

### New memory records

| Record | Written by | Notes |
|---|---|---|
| `kind: container`, id `container_x_y_z` | `rememberContainer` (already exists) | the deposit side must start reading it, not just the take side |
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
| `VILLAGE_SURVEY_MS` | `600000` | Throttle on `survey_village` (a sweep is expensive; 10 min). |
| `VILLAGE_SURVEY_CELLS` | `4096` | Cell budget of one sweep. |
| `VILLAGE_HOUSE_RADIUS` | `8` | Radius that clusters beds/containers into one house. |
| `VILLAGE_PLOT_MIN_CELLS` | `4` | Below this a crop cluster is not a plot. |
| `VILLAGE_MEMORY_TTL_MS` | `86400000` | After this a village fact is `stale` and must be re-read before it is depended on. |

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
- Every detection writes `plot_<crop>_x_y_z` + the `is_a`/`contains`
  observations, and remembers the containers it saw with their contents.

**Test**: `tests/village-survey.test.mjs` — a synthetic histogram with 30 beds in
three rooms yields three houses, not one blob; 4 cells of carrots are a plot and
3 are not; an enclosure with two adult cows and a calf is one pen with
`adults: 2, babies: 1`; a village with no bell still passes `minScore`
(the existing rule) and reports `missing: bell (0/1)`; an empty input returns
empty arrays and `checked: true`.

**Accettazione**: live `GET /observe.village?force=1` in the known village
returns ≥ 1 house that contains the beds the detector already counted (30), at
least one plot per crop actually visible in `/observe.nearby`, and at least one
storage entry with a position; the payload never contradicts
`GET /observe.structures` on the same survey.

### V1 — The sweep (bounded, read-only reconnaissance)

**Deliverable**

- `survey_village` action: a bounded route that visits the **unscanned** cells
  near the anchor (reusing `markChunkVisited`/the chunk index so a second sweep
  is cheap), scanning per cell and writing facts, with typed refusals
  `village_too_far` and `survey_budget_exhausted` instead of an unbounded walk.
- Hard bounds: `VILLAGE_SURVEY_MS` throttle, `VILLAGE_SURVEY_CELLS` budget, and
  never a dig, never an entity interaction, never a villager. Respect
  `DIG_PROTECTED` (beds, farmland, fences and crops stay intact) and the rule
  that the family base is not ours to reshape.
- The sweep result is a mission (`rememberStructure`/checkpoints already exist),
  so a run interrupted by death resumes instead of restarting.

**Test**: `tests/village-sweep.test.mjs` — the cell budget stops the walk and
reports `truncated`; a second sweep over a fully scanned ring plans zero
movement; a protected block in the way is never broken (the route detours or
refuses); a refusal carries its typed code.

**Accettazione**: live — one sweep of the village produces a census strictly
larger than the V0 single-shot one (more houses/plots/storage reachable), a
second sweep adds **no new facts** (idempotent, inside the
`OBSERVATION_DEDUPE_MS` window), and `node tools/run-facts.mjs <run>` shows the
action in `runs/<run>/actions.jsonl` with its duration.

### V2 — Storage memory on the deposit side (symmetry with `take_*`)

**Deliverable**

- `_depositTargetFor` consults `_rememberedStorage()` (memory) as well as the
  runtime cache, in this order: a **known, non-stale** container that already
  holds the item, then the nearest **reachable** one, then a live scan. A
  remembered container is re-read on the spot before the deposit is claimed
  (the same rule `_rememberedStorage` already documents for taking).
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
  what was walked; a village the bot has never visited has no facts at all.

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
| pure | Sweep budget, second-pass idempotence, protected-block detour | `tests/village-sweep.test.mjs` |
| unit | Deposit target from memory vs cache, stale re-read, fallback | `tests/bedrock-storage-memory.test.mjs` |
| unit | Farm-order classification vs the collect path, chain closing on delta | `tests/controller-farm-order.test.mjs` |
| unit | Reconciliation with `GET /observe.structures` and the chore layer | `tests/village-labor.test.mjs` (extension) |
| unit | Protection: beds/farmland/fences/crops intact, no villager | `tests/village-honesty.test.mjs` |
| live | One sweep > one shot; second sweep adds nothing; `deposit_carrot` after restart lands in the right chest; `@bot raccogli le carote` A/B | host, bounded round |

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
