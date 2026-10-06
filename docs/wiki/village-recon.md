# Village reconnaissance and the farm order

A village is countable, not conversational: how many houses, which beds are
free, where the pens are, which plots hold which crop and how much of it is
ripe, which chest holds what. This page tracks the roadmap that turns that into
a **site register** the bot owns — built once by a bounded, read-only sweep, then
consulted as a lookup — and the one spoken order it exists to serve:

> *"raccogli le carote dal campo, rimpianta e metti il raccolto nel baule più
> vicino"*

The analogy is a robot vacuum: the map is drawn on a slow pass, and every later
task is a route over known cells rather than a new exploration.

Status: **V0–V5 spec only** — nothing on this roadmap is implemented. Everything
it builds on (the histogram survey, the marker detector, the container memory,
the harvest/plant/deposit actions, the village chores) already exists and is
listed below as the baseline; the two real gaps are the aggregation and the
meaning of the order.
Full raw source: [`docs/raw/VILLAGE_RECON_ROADMAP.md`](../raw/VILLAGE_RECON_ROADMAP.md).

Sources: `bedrock-world.mjs` (histogram survey), `structures.mjs` (marker rules),
`bedrock-adapter.mjs` (crops, beds, animals, containers, deposit), `world-memory.mjs`
(container/entity/site records), `village-labor.mjs` (the chore layer),
`controller-decisions.mjs` (chat orders), [exploration](exploration.md) (M5/M6
structures), [memory](memory.md) (persistent world memory),
[human-command](human-command.md) (the order channel),
[ai-player-roadmap](ai-player-roadmap.md) (M3b village labor),
[redstone](redstone.md) (the auto-harvest circuit blueprint),
[verification](verification.md) (acceptance evidence),
[open-questions](open-questions.md) (what is still unproven).

## Current state (from the code)

The census exists in pieces; what is missing is the **aggregation** and one
**order semantic**.

| Piece | Where | What it gives |
|---|---|---|
| Histogram survey | `bedrock-world.mjs:294` `surveyBlocks(point, radius = 48, {limit = 20000, maxDistinct = 96, airBelow = 3})` | block-name counts around a point; a counting tool, not a map |
| Marker detector | `structures.mjs:150` `detectStructures`, village rule at `structures.mjs:35` (`minScore: 5` at `:48`) | `structure:village` with `score`, `evidence`, `missing` |
| Live evidence | [exploration](exploration.md) §M5/M6 — village at **(113, 73, 156)**, confidence 0.6, score 6, `bed: 30`, `villagers: 11`, `missing: bell (0/1)` | the thresholds are tuned on this world; the survey is declared an histogram, not a map |
| Survey throttle | `bedrock-adapter.mjs:233-235` `STRUCTURE_RESCAN_MS` (60 s), `STRUCTURE_RADIUS` (48), `STRUCTURE_SURVEY_LIMIT` (20000), `_surveyStructures:1279` | a bounded, cached re-scan of the loaded radius |
| Memory records | `world-memory.mjs:174` `rememberContainer`, `:332` `rememberResourceSite`, `:426` `rememberEntity`, `:378` `rememberStructure`, `:837` `observe`; reads `findContainers:213`, `containersWithItem:226` | the fact kinds already exist, with `known/stale/invalid` |
| Harvest + replant | `bedrock-adapter.mjs:4383` `harvest_<crop>` ("Harvest the mature X … **and replant** `<seed>`"), offered only for a mature crop (`_harvestableCrops:8622`) | the first two steps of the order are one action |
| Plant / deposit | `bedrock-adapter.mjs:4702` `plant_<item>`, `:4689` `deposit_<item>`, `:4681` `dump_inventory` (`DEPOSIT_KEEP_RESERVE:197`, `DEPOSIT_MAX_STACKS:200`) | the third step already exists as a bounded action |
| Beds / animals / storage | `bedrock-adapter.mjs:13211` `_findBeds` (48 blocks, `occupied_bit`, free-first, 30 s cache), `_nearbyFarmAnimals:11581`, `_cachedContainers:7041` | the three censuses, as point-in-time views of the loaded radius |
| Village chores | `village-labor.mjs:94` `harvest_crops` ("Harvest the ripe crops in the village plots **and replant them**, then put the produce away"), `:108` `store_harvest`, `:161` `plant_crops`; verdicts by state delta (`choreGain:323`, `isChoreResolved:400`) | the chain is already a chore the bot can do on its own |
| Chat order path | `controller-decisions.mjs:173` `orderItem` (inventory keys + visible drops only), `:221` `isCollectOrder`, `chat-lang/it.mjs:60` `no_drop` | "raccogli le carote" is a **pick-up-from-the-ground** order whenever the bot carries carrots or sees a carrot drop |

### Gap 1 — nothing aggregates a house, a plot or a pen

There is no record that says "this is the carrot field, six of its cells are
ripe, the nearest chest that already holds carrots is at (x,y,z)". The beds, the
animals and the containers are recomputed on demand from the loaded radius and
never written as a village fact, so "the inventory of the village" cannot be
read back, compared over time, or depended on after a restart.

### Gap 2 — the shortcut is ambiguous, and the deposit side has no memory

`@bot raccogli le carote` means *pick up carrot items* **if** the bot carries
carrots or sees a drop, and *go harvest carrots* only otherwise — same words,
two meanings, decided by the backpack (`controller-decisions.mjs:173,221`). And
while opening a container persists its contents through
`bedrock-adapter.mjs:7056` → `rememberContainer`, the **deposit** target
(`_depositTargetFor:7000`) reads only the runtime cache (`_cachedContainers:7041`,
TTL 5 min): after a restart the bot forgets *which* chest holds the carrots,
even though the memory still knows.

## The design in brief

- **V0 — census.** A pure `village-survey.mjs` clusters houses (beds/containers
  within `VILLAGE_HOUSE_RADIUS`), plots (≥ `VILLAGE_PLOT_MIN_CELLS` cells of one
  crop, with ripeness), pens (fenced, `adults`/`babies`) and storage (container
  contents); `GET /observe.village` exposes it with `checked: true`, so "looked
  and found nothing" is never confused with "not looked".
- **V1 — the sweep.** `survey_village` walks only the unscanned cells near the
  anchor, throttled by `VILLAGE_SURVEY_MS` and bounded by `VILLAGE_SURVEY_CELLS`,
  with typed refusals (`village_too_far`, `survey_budget_exhausted`); never a
  dig, never an entity, never a villager. A second sweep must add no new facts.
- **V2 — storage memory on the deposit side.** `_depositTargetFor` consults the
  remembered containers, prefers a known non-stale chest that already holds the
  item, re-verifies it on the spot, and falls back to the live scan — with
  `remembered: true` visible in `observe().deposit.target`.
- **V3 — the order.** A deterministic classifier turns a **crop family + farm
  verb** into `plan.farm = {crop, replant, store, field}`, keeps
  `isCollectOrder` only when the named drop really exists, drives
  `harvest_<crop>` → `plant_<seed>` → `deposit_<item>` against `GET /options`,
  and closes on a **state delta**, never on the model's word. No Hermes call.
- **V4 — honesty and protection.** Every fact carries `confidence`, `evidence`
  and `missing`; a fact older than `VILLAGE_MEMORY_TTL_MS` is `stale` and must be
  re-read before it is used; beds, farmland, fences and standing crops are never
  broken, and a villager is never touched.
- **V5 — documentation.** This page, the raw spec and the cross-links (plus the
  `BEDROCK.md` action table and the `/observe.village` route).

| Milestone | Deliverable | Status |
|---|---|---|
| V0 | Pure census `village-survey.mjs` + `GET /observe.village` + memory writes | spec |
| V1 | `survey_village`: bounded read-only sweep, typed refusals, idempotent | spec |
| V2 | Deposit target from memory (symmetry with `take_*`), stale re-read | spec |
| V3 | Farm order as one intent → `plan.farm` → verified chain | spec |
| V4 | Confidence/evidence/missing + protection + declared limits | spec |
| V5 | Wiki/raw/`BEDROCK.md` wiring | spec (this page) |

## Answering the shortcut

`raccogli le carote` is the right **surface**, and it must expand to
`harvest_carrot` → `plant_carrot` → `deposit_carrot`: the three steps are already
offered by the harness, one bounded action at a time, and the delta is checkable
(a `carrots` block standing in the harvested cell, the carrot count in the
inventory, a chest that holds more carrots than before). The shortcut alone is
not enough, because it is ambiguous today (Gap 2) — the fix is evidence-based:
the collect path keeps winning only when the thing named is really on the ground.

What this roadmap deliberately does **not** do: a voxel map or room
segmentation, renovating the houses, villager engineering, redstone farming,
looting the village chests, slaughtering the base's animals, or letting the model
supply a single fact about the village.
