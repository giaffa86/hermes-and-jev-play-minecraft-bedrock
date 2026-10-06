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

Status: **V0 model + census + read path + V1/V2 storage path + the V1 sweep action
+ the V3 farm order + the V4 honesty/protection landed (2026-10-06); the live
rounds are still spec.** `world-memory.mjs` keeps discovery and inspection as
two facts with two clocks, the rung-2 query exists, and the storage matcher is a
family match instead of a name whitelist (`0650877`); the adapter now **writes** a
discovery while the bot walks (`_surveyStorage`, `_rememberStorageDiscovery`) and
the **deposit** decision climbs the ladder before looking at the world
(`_storageSearchPlan` → `storage-ladder.mjs`, `c897399`), with
`observe().storage` exposing the register and the chosen rung visible in
`observe().deposit`. The **census** is now a pure module (`village-survey.mjs`)
that calls the detector's own rule instead of a copy, and the sweep is wired as a
**configuration** of the general planner (`villageSweepConfig` →
`planExplorationSweep`, 7 offline cases). The **read path** followed: the adapter
gathers the census's own bounded cell scan and publishes it as
`observe().village` / `GET /observe.village?force=1`. The **sweep action**
followed: `survey_village` walks the general planner's plan (no second engine),
keeps three independent limits and writes a register that makes the next pass —
and a pass after a restart — cheap. The **farm order** followed: `plan.farm` is
classified from a crop family plus a farm verb, and the controller drives the
chain (`harvest` → `plant` → `deposit`) one bounded step at a time against
`/options`, closing on a state delta. The **honesty layer** followed: every
village fact carries `confidence`, `evidence` and `missing`, what is below
threshold is `ignored` instead of invented, `checked` cannot be `false` on a
payload that reports data, and the protection list now really covers a Bedrock
`bed`. What is still missing is the live rounds (the farm-order A/B and the
four-case chest ladder). Everything else on this roadmap is spec.
Everything it builds on (the histogram survey, the marker detector, the container
memory, the harvest/plant/deposit actions, the village chores) already exists and
is listed below as the baseline; the two real gaps are the aggregation and the
meaning of the order.
Full raw source: [`docs/raw/VILLAGE_RECON_ROADMAP.md`](../raw/VILLAGE_RECON_ROADMAP.md).

Sources: `bedrock-world.mjs` (histogram survey), `structures.mjs` (marker rules),
`bedrock-adapter.mjs` (crops, beds, animals, containers, deposit), `world-memory.mjs`
(container/entity/site records), `storage-ladder.mjs` (the order as a pure
decision), `storage-blocks.mjs` (the family matcher), `village-labor.mjs` (the chore layer),
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
even though the memory still knows. **V3 closed the first half** (the words are
now classified by evidence rather than by the backpack, see below) and the
ladder closed the second (`_storageSearchPlan` reads memory before the world).

### Gap 3 — the memory is written and then not read

The bot records what it sees and forgets to consult it. Every writer is called:
`rememberStructure` (`bedrock-adapter.mjs:1306`, inside the survey),
`rememberContainer` (`:7057`, on every open), `rememberEntity:1251`,
`rememberResourceSite:1237`, `rememberLandmark:749`, `markChunkVisited`. Almost
every reader has no production caller — `findEntities:449` is read by tests only,
and `unexploredFrontier` (`world-memory.mjs:512`) has none — while the *published*
census (`observe().structures`, `bed`, `farmAnimals`) is rebuilt from the loaded
radius every time, with a 60 s runtime TTL (`STRUCTURE_RESCAN_MS`, `:233`). The
two readers that do exist are the exceptions that prove the rule:
`scanStructureTarget` (`bedrock-harness.mjs:78`) unions the live survey with
`findLandmarks({kind: 'structure'})` **so a landmark survives a restart**, and
`_rememberedStorage:7183` feeds `take_*` from the remembered containers. There is
no way to ask "what do we know about the village?". The storage half now has
its reader — `_storageSearchPlan` consults the register before the world, and
`observe().storage` publishes it — while the village half (houses, plots, pens)
is still rebuilt from the loaded radius on every call.

### What landed (2026-10-06): a pure census, and the sweep as a configuration

Four things stopped being spec and became code:

- **The census is pure.** `village-survey.mjs` exports
  `surveyVillage({nearby, farmAnimals, entities, beds, containers, anchor,
  survey, dimension, scanned, limits})`, consuming the observation the adapter
  already produces and
  returning `{checked, anchor, houses, plots, pens, storage, missing, detection,
  counts, survey}`. Deterministic, clock-free, I/O-free: the same observation
  yields the same census, even through a shuffled input. Houses are bed clusters
  (planar distance — two beds on different floors are one building) with their
  own containers and doors; plots are crop clusters carrying `{crop, seed, cells,
  ready, immature, unknown, center}`; pens are animal clusters that say whether a
  fence stands within `VILLAGE_PEN_RADIUS`; storage is ordered from the anchor
  and keeps `contentsKnown`, so an unopened chest is a *known place with an
  unknown inside* (`contains: null`) instead of a missing fact.
- **It never re-implements the detector.** `structures.mjs` was split (behaviour
  unchanged) into `structureRows` / `scoreStructure` / `scoreStructures`, and the
  census feeds the same rule — so `NOT_FOUND`/`CANDIDATE`/`CONFIRMED`, the score
  and the `missing` list cannot drift from `GET /observe.structures`. `checked`
  is the honest half: `false` with `detection.state: null` means *nobody looked*,
  which is a different fact from `NOT_FOUND` (*looked and empty*).
- **Two inputs the detector wants and the pens must not receive.** `entities` is
  the detector's entity evidence (`observe().entities`, villagers included) and is
  a *different list* from `farmAnimals`, which lives in the pens: feeding the
  livestock to `detectStructures` meant a real village could never reach
  `CONFIRMED`. `survey` is the executor's own histogram: its **counts** cover the
  whole radius while the cell lists are capped per name, so the verdict, the
  `evidence` numbers and the anchor stay identical to `GET /observe.structures`
  while `counts` keeps describing the cells the census could actually cluster.
  And a capped bed list *enriches* the census (`observe().bed` adds `occupied`)
  instead of replacing its cells: it must never shrink it.
- **The sweep is a configuration, not a second engine.**
  `villageSweepConfig({anchor, radius, spacing, visited})` returns exactly the
  input of `planExplorationSweep` (`exploration.mjs`): the anchor from the
  detector, `spacing` 24, a ring count **derived** as
  `floor(radius / (spacing * √2))` so that no waypoint ever falls outside
  `VILLAGE_SURVEY_RADIUS` (48), `cells: null`, and `visited` as an array so the
  config survives `JSON.stringify`. The same `(anchor, visited, config)` gives
  the same plan after a reload, and a visited cell *shrinks* the plan instead of
  moving it. The two budgets stay distinct facts: `VILLAGE_SURVEY_CELLS` (4096)
  counts the **blocks** one waypoint's census may scan, while the planner's
  waypoint budget is the spiral itself.

Tests: `tests/village-survey.test.mjs` (16 cases), `tests/village-sweep.test.mjs`
(7 offline cases), `tests/village-view.test.mjs` (6 cases, the read path),
`tests/village-honesty.test.mjs` (14 cases, the honesty and protection layer) and
`tests/village-sweep-action.test.mjs` (9 cases, the action below).
Still open in this milestone: the memory-first read (`villageRegister`), the
`VILLAGE_PLOT_MIN_CELLS` threshold (a cluster is reported with its count, the
threshold is left to the caller), and the live rows.

### What landed (2026-10-06): the read path — a census the adapter can publish

The pure census had no way to reach a client: `observe()` had no village field,
and `observe().nearby` is a *sample*, not a census (`bedrock-adapter.mjs:1145`):
`findBlocks(name, position, 96, 4)` keeps **four cells per name**, and the live
village has thirty beds. So the adapter owns a bounded scan of its own:

- `_villageCells({point, radius, limit})` runs one `world.surveyBlocks` pass to
  learn **which names exist** — the fence family is discovered from that
  histogram, never from a whitelist — then `world.findBlocks(name, point, 48,
  VILLAGE_CELL_CAP)` for `bed`, the crop blocks and those fences. Maturity is read
  per cell (`cropMaturity`, with a live-column fallback); unreadable stays `null`,
  never guessed.
- A name that hits the per-name cap is **declared** in `blocks.cappedNames`
  (with `blocks.capped: true`): that count is a lower bound, not a measurement.
- `_villageView({force, limits})` memoizes the census for `VILLAGE_RESCAN_MS`
  (60 s) and feeds it the cells, the livestock, the entities (villagers), the beds
  with occupancy, the storage register (`known` → `contentsKnown: true`,
  `toInspect` → `contentsKnown: false`), the detected village's anchor, the survey
  histogram and the scanned count; it adds `at`, `origin` and `blocks` to the pure
  payload. It is exposed as `observe().village` (memoized, so the hot `observe()`
  costs one scan a minute) and as `GET /observe.village?force=1`.

`tests/village-view.test.mjs` covers the collection rather than the arithmetic:
cells come from the world and not from the sample (the observation's `nearby` is
empty on purpose in the test), the detector reads the villagers while the cattle
is a pen, the per-name cap is declared (70 beds in the world ⇒ `cappedNames:
['bed']`, `counts.beds: 64`), the register arrives with both states and ordered
from the anchor, and an adapter with nothing to read answers `checked: false,
state: null` — *not looked* is not *looked and empty*.

### What landed (2026-10-06): the V1 sweep action — a census on legs

`survey_village` is not a second engine: it calls the general planner
(`planExplorationSweep(villageSweepConfig({anchor, visited}))`), walks the
waypoints it returns with `_moveTo`, and censuses at each one. The bounded scan
of the read path is the sensor; the action is only the legs that carry it.

Three limits, three different facts, the first one reached wins:
`VILLAGE_SURVEY_MS` (600 s) is the **cooldown** between two passes,
`VILLAGE_SURVEY_CELLS` (4096) is the **exploration** budget, `VILLAGE_SURVEY_MAX_MS`
(120 s) is the **execution** budget. A pass that runs out returns `ok: true` — the
census exists, it is partial — with `truncated: true` and `stoppedBy:
'cells' | 'time' | 'radius' | 'exhausted'`. A mission that cannot start
**refuses** instead, with a typed code: `village_unknown` (no village identified:
the sweep never invents a centre), `village_too_far` (beyond
`VILLAGE_SURVEY_MAX_DISTANCE`, 256 — reaching the site is a journey, and a journey
budget belongs to the caller), `survey_cooldown`. A refusal starts no mission and
writes nothing. `DIG_PROTECTED` stays a global invariant: a pass may detour or
fail, never modify the world.

**Idempotence lives in the register, not in the RAM.** A pass writes
`kind: village_survey` through `rememberVillageSurvey` (`cells` = the chunk keys
it actually censused, plus a `censuses` counter), and `_villageVisited()` reads it
back — after checking that the record is within `VILLAGE_MEMORY_RADIUS` (8) blocks
of *this* anchor, so two villages a few dozen blocks apart never share cells. This
is a deliberate deviation from the roadmap's first draft: `visitedChunks` is **not**
the sweep's `visited`. The chunk index records *travel* (`markChunkVisited`,
`source: 'travel'`), and a village is normally detected by walking through it, so a
sweep keyed on travel would find its whole assignment already "censused" and scan
nothing. The walk still marks its own chunks — a sweep is also a journey — but
"a restart between the first and the second sweep plans zero movement" is a
statement about the register.

**Only a reached waypoint is marked censused.** The census is a scan around where
the bot actually *is*, so recording a failed waypoint's cell would make the next
pass skip an area nobody ever looked at: the register may under-claim, never
over-claim. A truncated or blocked pass still records the cells it reached, which
is exactly what lets the next pass resume where this one stopped.

`tests/village-sweep-action.test.mjs` covers it offline by replacing `_moveTo`
with a logging walk: a completed pass walks the planner's waypoints and writes the
register with the `busy` lock released; the cell budget truncates with `stoppedBy:
'cells'` while the action stays `ok: true`, the execution budget with `'time'`
while cells are still unscanned; an unreachable waypoint stops the pass with
`blocked: true` and records only what it reached; a second pass over a censused
ring plans zero movement, and so does one after a restart (fresh RAM, register
loaded from disk); another village's cells are never reused; the three refusals
are typed and start no mission; the option appears only with an anchor and outside
the cooldown. The `'radius'` stop remains the *planner's* own guard
(`tests/exploration-sweep.test.mjs`): `villageSweepConfig` derives the ring count
from the bound, so the assigned area closes with `'exhausted'` rather than being
truncated by construction.

### What landed (2026-10-06): the farm order, a chain that closes on a delta

The order that motivated this whole roadmap is now a deterministic plan field
instead of a coincidence of words. `farmOrderFromText`
(`controller-decisions.mjs`) sits next to `isDropOrder`/`isEquipOrder`, reads a
crop token (carrot, wheat, beetroot — `ITEM_WORDS` now knows them in five
languages) plus a farm verb, and emits `plan.farm = {crop, block, seed, word,
replant, store, field, before}`. It returns `null` — leaving the order to the
planner — when a number is present ("raccogli 4 carote"), when the verb is
`cattura` (a capture, not a harvest) and when the named token is not a crop. The
ambiguity of Gap 2 is therefore settled by **evidence**: `isCollectOrder` still
wins when a drop of that crop is really on the ground, otherwise a crop named in
front of a field is a farm order. No LLM call, no `no_drop` for the field
standing right there.

The chain is one step per decision, chosen against `/options` — the harness
remains the authority on what is legal *now*:

| Step | Key | Fires when |
|---|---|---|
| 1. pickup | `collect_drop` | a drop of *that crop* is on the ground |
| 2. harvest | `harvest_<block>` | the harness offers it (ripe, reachable) and `harvests < DEFAULT_FARM_MAX_HARVES` (8) |
| 3. replant | `plant_<seed>` | the last harvest reported `replanted.ok !== true` — never "seed the whole village" |
| 4. store | `deposit_<crop>` (`store: 'known'`) / `dump_inventory` (`'nearest'`) | `held > before.inventory[crop]` |

A `null` step is not an error: at the first decision it means "nothing to do"
(the human gets a one-line reply instead of a refusal), after some work it means
the chain is finished, and the outcome is measured — `produce_stored` or
`produce_not_stored`.

**The delta is the acceptance criterion.** `farmSnapshot` records, when the plan
is created, how much of the crop the bot holds and how much of it already sits
in known containers; `farmStored` sums `observe().containers` and
`observe().storage.known` deduplicated by position (a chest read twice is not
counted twice) and `farmFulfilled` requires the container to have grown **and**
the backpack not to. Putting away carrots that were already there is not a
harvest. The plan is logged with `deterministic: 'farm'`, and `farmOptionKeys`
joins `humanOrderProtectedKeys` in the emergency filter, because `plant_*`,
`deposit_*` and `dump_inventory` carry intent `unknown` and would otherwise be
hidden exactly when the human's order is the last thing the bot should keep
doing.

**One policy, two readers.** The food reserve (`DEPOSIT_KEEP_RESERVE`, 16)
keeps carrots and potatoes in the backpack as emergency food — which would make
the harness offer `dump_inventory` and then refuse it as "nothing worth
storing". `_depositableItems({reserve, exempt})` now exempts `plan.farm.crop` by
default, and the deposit section of `options()` offers that crop even though
`_isValuable` (ingots, ores, gems) does not match it: the offer and the action
that executes it read the same rule.

`tests/controller-farm-order.test.mjs` (10 offline cases) covers the classifier,
the step order — including the case that used to fail, carrots in the backpack
with no drop ⇒ `harvest_carrots` — the harvest cap, the delta gating, the dedupe
of the two content sources and the adapter's exemption policy.

### What landed (2026-10-06): honesty, protection and the limits of the map

A census that guesses is worse than a census that says nothing, because the
guess is indistinguishable from a measurement once it is in the payload. V4
makes the difference structural rather than stylistic.

**Confidence is the share of the fact that was read.** Every house, plot, pen
and storage row now carries three fields instead of an adjective:

| Fact | `evidence` | `confidence` | `missing` when a hole exists |
|---|---|---|---|
| house | `{beds, doors, containers}` | share of beds whose `occupied` was read | `occupancy`, `door`, `container` |
| plot | `{cells, ready, immature, unknown}` | share of cells whose ripeness was read | `ripeness` |
| pen | `{animals, adults, babies, fenced}` | share of animals that had a position | `fence` |
| storage | `{contents}` (implicit) | `1` when `contentsKnown`, else `0` | `contents` |

A house with one unread bed out of two is `confidence: 0.5` and says
`missing: ['occupancy']` — it never rounds up to "there is a free bed".
`detection.confidence` reuses the detector's own formula
(`structures.mjs:226`), so a `CANDIDATE` verdict legitimately carries a number
below 0.5 rather than a fake 1.

**Below the threshold is absent, and it is visible.** A crop cluster under
`VILLAGE_PLOT_MIN_CELLS` produces no plot; the clusters that were dropped are
counted in `ignored.plots`, an animal without coordinates in
`ignored.animals`, a storage row without a position in `ignored.containers`.
Without `ignored`, "seen and below the threshold" would be indistinguishable
from "never looked at". The same reasoning fixes `checked`: it is now
`observed || scanned > 0`, where `observed` means the payload has at least one
cell, animal or storage row — a payload that reports data cannot claim it never
looked. `survey.scanned` is `max(scanned, cells)` so the counter can never say
it read less than the payload reports, and a payload nobody looked at names
**no** `missing` marker: a hole exists relative to a measurement, and with no
measurement there is nothing to be missing relative to.

**The rules travel with the facts.** `thresholds` is in the payload
(`{houseRadius, plotRadius, penRadius, plotMinCells, maxCells}`), so a reader
re-derives the same clusters instead of guessing them from prose, and
`VILLAGE_PLOT_MIN_CELLS` is finally applied *in* the census (the leftover of
V0) with the adapter's env override (`bedrock-adapter.mjs`, folded in as
`limits.plotMinCells`). The payload also states the sensor's own limits
(`limits`: radius, per-name cell cap, rescan throttle, survey radius, maximum
distance), so "how much does this map cover" is answerable from the data.

**Unknown contents is not an empty chest.** A storage row with
`contentsKnown: false` is `contains: null`, `confidence: 0`,
`missing: ['contents']`; an inspected row is `confidence: 1`. A stale item stays
usable, but only through `planStorageSearch`, which answers `verify: true`: the
ladder orders the walk, it does not license belief.

**Two protection lists, one of them wrong until now.** `DIG_PROTECTED`
(`bedrock-adapter.mjs:98`) already covered farmland (`farmland$`), fences
(`_fence$`), crops (`wheat$|carrots$|potatoes$|beetroot$`) and the village's
built furniture, but it matched beds with `_bed$` — and the Bedrock block is
named plain `bed`. A village bed was therefore diggable. It is now `(^|_)bed$`,
which covers `bed` and the Java-style `oak_bed` while leaving the crop exemption
at `:9145` intact (a *mature* crop must stay breakable or `harvest_<block>`
could not work). The second list is the chain's own: no key returned by
`farmOptionKeys` starts with `mine_` or `dig_`, and the test checks that against
the source text of `village-survey.mjs` as well.

`tests/village-honesty.test.mjs` (14 offline cases) covers all of it: a payload
that reports data is never `checked: false`; a payload nobody looked at claims
nothing; "looked and empty" names every rule below its `min`; confidence is the
read share for plots, houses and pens; unknown contents is not an empty chest; a
sub-threshold cluster is absent and counted in `ignored`; the thresholds travel;
a stale memory is used only with `verify: true`; and `farmland`, `bed`,
`oak_fence` and an immature `carrots` all stop `_digTargets` with a typed
`protected_*` error while the chain still breaks the ripe crop it harvested and
never the farmland underneath it.

## Register or sensor?

**The memory is the register, the survey is the sensor.** That is the discipline
this roadmap adds, and it is what makes the robot-vacuum analogy true: the map
survives the restart, and a sweep renews what is old instead of re-measuring what
is already known. Two consequences, both part of the design:

1. **The read path is the deliverable.** V0 adds
   `villageRegister({near, dimension, includeStale})`: houses from
   `findLandmarks` ∪ the live survey, plots from the `resource_site` records (the
   same kind `remembered-resource-sites.mjs` already routes to a gather step),
   pens from `findEntities` — the **first production reader** of what
   `rememberEntity` already stores — and storage from
   `findContainers`/`containersWithItem`. Every row carries
   `source: 'memory' | 'live'`, `status` and `observedAt`/`verifiedAt`, so the
   payload says *measured three minutes ago*, not *true*.
2. **The staleness default is a trap.** `findContainers` defaults to
   `includeStale: true` (`world-memory.mjs:213`) and `_rememberedStorage`
   filters only on "contents > 0" plus reachability — so a **stale** chest is
   already good enough to take from. Defensible for an explicit `take_*`, never
   inherited by a deposit target (V2) or a plot census: the register carries the
   status and the caller decides what it tolerates.

Freshness stays per fact, not per village: a sweep that runs out of budget or
dies halfway leaves some cells renewed and others old, so the register must be
readable at cell granularity and report `truncated` — never one village-wide
"last scanned at" that would make an old plot look fresh.

### The chest search: two depths of reconnaissance

"Find the iron in the chests" is the smallest order that shows what the register
is for, and it splits cleanly into two questions with very different costs:

- **Where are the containers?** Cheap, needs no interaction: chest blocks are
  blocks, and `_findNearbyStorageBlocks:7029` already finds them in the loaded
  palette (`STORAGE_SCAN_PER_NAME = 24` at `:159`, radius 32). Purely runtime
  today — nothing persists them.
- **What is inside them?** One open per container, batched at
  `STORAGE_READ_LIMIT = 8` per `read_container` (`:164`). A chest is opaque from
  outside, so no survey and no reasoning can substitute for that interaction.

So the reconnaissance is paid **once, not per order**, and only for chests that
were never opened: after a first pass "find the iron" is a lookup in the memory
(`_rememberedStorage:7183` → `_rememberedContainerFor:7207`) plus a walk, and
`take_*` re-verifies on arrival. A remembered "13 iron_ingot" may already be gone
— **the register says where to look, not what you will find**, and the cost of
being wrong is one wasted walk.

This also fixes what a container row must contain: `contentsKnown`, so a chest
the sweep only *saw* is a known place with an unknown inside instead of a
missing fact. Today that row cannot exist at all — `rememberContainer` has
exactly one call site, `_setContainerContents:7057`, so a chest that was never
opened is not remembered, not even by position.

### Discovery and inspection are two facts, and the ladder orders them

*Is there a container here?* and *what is inside it?* are separate facts with
separate lifetimes. A row is in one of three states — `contentsKnown: false` with
no `inspectedAt`; contents known and fresh; contents known but old. A discovery
(slow TTL, containers do not move) must outlive an inspection (fast TTL, other
players move things): hence two clocks, `CONTAINER_DISCOVERY_STALE_MS` (6 h) and
`CONTAINER_INSPECTED_STALE_MS` (5 min).

The design rule is **the cheapest source of knowledge is used first**, and for an
order that needs an item it is a four-rung ladder: (1) a container whose contents
are *known* to hold it → (2) a container merely *discovered* → (3) a local scan of
the already-loaded area → (4) real reconnaissance. Only rung 4 is exploration,
and **Hermes must not order it while the register can still answer at rung 1 or
2** — which is why the register must *expose* the ladder: an empty list proves "I
don't know" instead of assuming it.

What the code allowed *before* V0, and what changed (checked in the code):

- **Landed (2026-10-06, `0650877`)**: `containerId` is spatial, so a re-write
  upserts in place, and `rememberContainer` still preserves `discoveredAt`.
  `rememberContainer` now takes a *write kind*: a call without a `contents`
  payload (or with `contentsKnown: false`) is a **discovery** that updates
  `type`/`position`/`discoveredAt`/`lastSeenAt` and never touches `contents`,
  `inspectedAt` or the `contains` edges; a call with a payload is an
  **inspection** and is the only write that stores contents and re-materializes
  the edges. `contents: null` means *not measured*, `{}` means *measured and
  empty* — so "never inspected", "inspected and empty", "inspected with
  contents" and "contents stale" are four distinguishable states
  (`describeContainer`, `CONTAINER_INSPECTION_STATE`).
- **Landed**: staleness is computed **on read** from `inspectedAt`/`discoveredAt`
  (`CONTAINER_INSPECTED_STALE_MS` 5 min, `CONTAINER_DISCOVERY_STALE_MS` 6 h), so no
  timer and no `hydrate` are needed; `findContainers({ includeStale })` answers
  with the derived value, and a status already marked stale stays stale.
  `containersToInspect` is the rung-2 query, ordered by distance.
- **Landed**: the storage names moved out of the adapter's exact-name whitelist
  into `storage-blocks.mjs`, which matches exact names *and* families
  (`*_shulker_box`), with `addStorageBlockName`/`addStorageBlockFamily` as the
  extension points — so dyed shulker boxes are no longer invisible.
- **Landed (V1+V2, `c897399`)**: the write exists and the deposit path reads.
  `_surveyStorage()` (throttled by `STORAGE_DISCOVERY_RESCAN_MS`, radius
  `STORAGE_DISCOVERY_RADIUS`) records every storage block in the loaded area as a
  *discovery* (`contentsKnown: false`, `source: 'discovered'`) from the chunk
  sweep, and the live fallback of `_depositTargetFor` does the same before
  choosing a block, so the register learns while the bot works.
  `_depositTargetFor` climbs the ladder (`_storageSearchPlan` →
  `planStorageSearch`): a remembered container that holds the item, then a
  discovered-not-inspected one, then the 5-minute runtime cache, then a live
  scan. The target it returns carries `rung`, `step`, `verify` (a stale
  inspection is re-read by the open), `stale`, `remembered` and the whole
  `ladder`; a remembered target that fails to open falls back **once** to a live
  container (`retriedAfterStale`), and a `missing_item` never does.
- **Still missing**: the bounded sweep itself (`survey_village`, rung 4) and the
  farm-order classifier (V3). Rung 3 is a live scan that now *persists* what it
  sees, but it has no cost budget beyond the scan radius.

The acceptance test is exactly the order the owner described: iron known in a
chest → go there; only unopened chests known → inspect them; nothing known →
local scan; only an empty local area → sweep. A run that jumps to the sweep is a
failure, and `runs/<run>/actions.jsonl` shows it.

## Rung 4 is the exploration capability, specialized

The bounded sweep is not a village-only engine: it is the general **Autonomous
Exploration & Discovery** capability — the M1 “find a biome” planner in
`exploration.mjs` (`spiralOffsets:53`, `nextExplorationWaypoint:68`,
`planExplorationStep:106`) with persisted missions and checkpoints in
`world-memory.mjs:777-911` — pointed at a village. The mapping is one-to-one:
deterministic spiral over unexplored cells, persistent
`visitedChunks`/`unexploredFrontier` (`world-memory.mjs:581`/`:618`/`:631`),
mission + checkpoints + `replayRouteFromMission`, pause/resume/restart, bounded
execution. The village adds only a **configuration** (anchor, spiral radius, the
three limits) and a **consumer** (the V0 census, written from what the walk
actually saw).

The rule that follows: no second frontier/spiral implementation, no second
visited-chunk bookkeeping, no second checkpoint format, no second notion of
“mission exhausted”. If the sweep needs a behaviour the general planner lacks — a
radius-bounded spiral around an anchor, say — that behaviour goes into
`exploration.mjs`, where the biome and `find_structure` searches benefit from it
too. And `survey_village` must not become the only door to rung 4: a later
“explore this area” order is the same planner with a different target and a
different census.

Structure detection is **graded, not boolean**: `NOT_FOUND` / `CANDIDATE` /
`CONFIRMED`, with the evidence that justified the step attached, so “there is a
village here” is never a bare claim. That is also why `/locate` stays out of
scope: a position handed over by a command carries no observation at all, and the
order the register exists to record would be inverted.

## The design in brief

- **V0 — census.** A pure `village-survey.mjs` clusters houses (beds/containers
  within `VILLAGE_HOUSE_RADIUS`), plots (≥ `VILLAGE_PLOT_MIN_CELLS` cells of one
  crop, with ripeness), pens (fenced, `adults`/`babies`) and storage (container
  contents); `GET /observe.village` exposes it with `checked: true`, so "looked
  and found nothing" is never confused with "not looked". The adapter **reads
  the register first** (`villageRegister`, memory ∪ live, with `source`/`status`),
  and the survey writes back the facts it just measured.
- **V1 — the sweep.** `survey_village` walks only the unscanned cells near the
  anchor under **three independent limits**: `VILLAGE_SURVEY_MS` is the *cooldown*
  between sweeps, `VILLAGE_SURVEY_CELLS` the *exploration* budget and
  `VILLAGE_SURVEY_MAX_MS` the *execution* budget — cells are a poor proxy for
  cost, so neither budget implies the other, and the sweep stops deterministically
  at whichever is reached first, reporting `truncated: true` + `stoppedBy`
  (`cells` / `radius` / `time`; `exhausted` when the spiral was walked out, which
  is `truncated: false`). The bound is measured **from the anchor** and the
  planner (`planExplorationSweep` in `exploration.mjs`, landed offline in
  `tests/exploration-sweep.test.mjs`) is pure and clock-free: the same
  `(anchor, visited, config)` gives the same next waypoint and the same stop cause
  after a reload, and `time` is an executor-side stamp. A
  typed refusal (`village_too_far`, `survey_budget_exhausted`) is a different fact:
  the mission could not proceed. `DIG_PROTECTED` is a **global invariant**, not
  survey logic: the route may detour or refuse, never dig; villages, beds,
  farmland, fences and crops stay intact. A second sweep must add no new facts —
  and a **restart between the two sweeps** must not change that, or the
  idempotence would be RAM state rather than persisted knowledge. No biome
  heuristics, no "smart" village search, no `/locate`.
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
| V0 | Two-fact container record (`discoveredAt`/`inspectedAt`/`contentsKnown`) + read-time staleness + rung-2 query + ladder | **model landed** (`0650877`); census/register still spec |
| V1 | discovery write in the live path (`_surveyStorage`/`_rememberStorageDiscovery`, throttled, family matcher) | **landed** (`c897399`); the `survey_village` sweep itself still spec |
| V2 | Deposit target from memory (symmetry with `take_*`), stale re-read | **landed** (`c897399`) |
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
