# Fluids: swimming, drowning, waterfalls and lava

Roadmap for making the bot able to operate **in and around fluids**: swim and
cross water, avoid drowning (breathing/air management), exploit waterfalls to
descend and ascend, and **avoid lava** until it is equipped (bucket, fire
resistance, bridging). It also covers every fluid-related skill: buckets, boats,
bubble columns, potions, underwater mining/fishing.

Status: **M0 (fluid awareness) + M1 partial (wading and simulated air budget) +
M2 (breathing and dive budget) + M3 (waterfalls and bubble columns) + M4 (lava:
shores, destroyed loot, crossing gate) + M5 (buckets, boats, brewing gate, lava
bridge) + M6 (fluid skills, milestones, criteria) implemented, unit-tested and
collaudato live** (03/10/2026); the swimming *physics* of M1
(ballistic flags, water A*, `swim_to`) is **blocked** by a missing packet capture —
see the M1 section, and M3's column **actions** inherit that same blocker while
their detection and verdicts work. M6 still spec only (tracked in
[roadmap](roadmap.md) and [open-questions](open-questions.md)).
Full raw source: [`docs/raw/FLUIDS_ROADMAP.md`](../raw/FLUIDS_ROADMAP.md).

Sources: `bedrock-adapter.mjs` (movement, physics, digging, fishing),
`bedrock-dive.mjs` (M2 decision), `bedrock-waterfall.mjs` (M3 columns),
`bedrock-lava.mjs` (M4 lava verdicts), `bedrock-bucket.mjs` (M5 buckets, boats,
brewing), `skills/gameplay/fluids/` (M6 skill contracts), `BEDROCK.md`
(action status), [headless-client](headless-client.md) (perception/action model),
[survival-intelligence](survival-intelligence.md) (governor/skills/verifier),
[fishing](fishing.md), [companions](companions.md) (boats/riding).

## Current state (from the code)

This is the **pre-M0 baseline**; the M0 section below lists what changed. It is
kept because it still describes the parts M1 has to touch (`_passable`, physics,
pathfinding).

- **Fluids are walls.** `_passable()` returns `false` for `water|lava`
  (`// il bot non nuota`), so A* and local physics treat both as solid: the bot
  cannot enter water, and a `goto_waypoint` across a river stalls or detours.
- **No water footing.** `_standable()` needs a solid block below, so a water
  surface is not a valid node.
- **Digging refuses fluids only at the target cell.** `_digTargets()`/`_upTargets()`
  return `unsafe_block_*` for a `water|lava` target, but do not check the
  neighbouring cells or the landing cell (a shaft can still open into lava).
- **Custom server-authoritative movement.** `_sendAuthInput` sends
  `player_auth_input` with `delta` = local velocity and intent flags
  (`jumping`, `want_up`, `start_jumping`, `vertical_collision`, ...). Water physics
  must be modelled client-side or the server rubber-bands the bot via
  `correct_player_move_prediction`.
- **No air/breathing tracking.** `_applyOwnAttributes` reads only health, hunger,
  level, experience. Entity flags are mapped (`flags`, `flags_extended`) but no
  submersion/air flag is wired.
- **`/observe.nearby` does not scan water or lava**, so the controller is blind to
  them.
- **`_flee` flees only mobs**; its standable candidates exclude fluids, so water
  is never used as cover from a lava field. Its mirror for fluids is `_avoid_lava`
  (M0).
- **Death in lava destroys the drops** — `recover_loot` is impossible there, an
  extra reason to treat lava as an absolute hazard.
- **Fishing already knows water** (`isWaterBlock`, `shoreCandidates`,
  `CAST_RANGE` in `bedrock-fishing.mjs`) and its geometry is reusable.

## Design principles (unchanged)

- The harness owns validity: `/options` offers a fluid action only if it is
  executable and useful now.
- Physics/logic stay deterministic and testable in pure modules; no model drives
  mechanics.
- New intents, governor conditions, verifier criteria and item tags go through
  the existing closed, validated vocabularies.
- Lava is a hard hazard by default; crossing it is a gated stretch.

## Proposed vocabulary

- **Actions**: `swim_to`, `surface`, `dive`, `descend_waterfall`,
  `climb_waterfall`, `use_bubble_column`, `avoid_lava`/`move_to_safe`,
  `craft_bucket`, `craft_boat`, `fill_bucket`, `empty_bucket`, `place_water`,
  `brew_water_breathing` / `brew_fire_resistance` / `brew_night_vision`,
  `drink_potion_*` (stretch), `mount_boat` + `goto_waypoint`.
- **Intents** (`survival/intents.mjs`): add `swim`, `surface`, `descend`, `ascend`
  (and `fluid` for buckets). The mapping classifies offered keys, never invents
  them.
- **Governor conditions**: `inWater`, `headInWater`, `airBelow`, `inLava`,
  `lavaWithin`, `onWaterfall`.
- **Item tags**: `buckets`, `boats`, `water_breathing`, `fire_resistance`,
  `potions`.
- **Verifier criteria**: `inWater`, `airAtLeast`, `notInLava`.

## M0 — Fluid awareness (implemented, live 03/10/2026)

The bot cannot swim yet (M1), so M0 stops at *knowing* where the fluids are and
refusing the moves that would end in lava.

**Pure module `bedrock-fluids.mjs`** (no I/O, testable):

- `fluidKind(name)` / `isWaterBlock` / `isLavaBlock` — one classification for
  `water|flowing_water|still_water` and `lava|flowing_lava|still_lava`,
  namespace- and case-insensitive (`MineCraft:LAVA` counts).`bedrock-fishing.mjs`
  keeps the single `isWaterBlock` implementation.
- `summarizeFluids(cells, from)` → `{water:{count,nearest}, lava:{count,nearest},
  waterDistance, lavaDistance}`; `fluidCells(cells)` splits the cells by kind.
- `fluidHazard({inWater, headInWater, inLava, lavaDistance, air})` →
  `level|reasons` with the ladder `critical` (in lava, lava ≤ 2, drowning when
  `headInWater && air ≤ 8`), `high` (lava ≤ 5), `medium` (lava ≤ 10), `low`
  (submerged), `none`. With no air budget it never invents a drowning alarm.
- `rankEscapeCells(candidates, {from, hazards, minGain, limit})` — keeps the
  cells that *gain* distance from the hazard (negative gain is dropped).
- `digFluidRisk({neighbors, avoidWater})` — a dig whose neighbouring cell holds
  lava (always) or water (`avoidWater`) is refused.

**Adapter**

- `_fluidCensus()` scans `water`/`flowing_water`/`lava`/`flowing_lava` with
  `world.findBlocks` inside `FLUID_SCAN_RADIUS`, caches for `FLUID_RESCAN_MS`
  and keeps a `Set` of lava cells. If the world has **no loaded chunk** the
  census is not cached and is reported `ready: false` — an unscanned world is
  not a world without lava.
- `_fluidsView()` reads the bot's feet/head cells on every call and joins the
  cached census + `fluidHazard` verdict. Exposed as `observe().fluids` and by
  `GET /observe.fluids[?force=1]` (with the cell list).
- `_standable()` refuses a cell adjacent to a lava cell (repulsion), so the
  pathfinder and every `_standableNear`-based move (`_flee`, `_avoidLava`)
  steer clear.
- `_digTargets()`/`_upTargets()` check the cells *around* each dig target with
  `digFluidRisk` (the direct-fluid check still wins, so the reported reason stays
  the specific one). A staircase next to a lake is refused: at M0 a flooded shaft
  is not survivable.
- `avoid_lava` is offered only when a lava cell is within `LAVA_AVOID_RANGE`
  (option gate); `_avoidLava()` ranks `16` directions × radii `12/8/16` with
  `rankEscapeCells`, filters by reachability and moves once. Typed errors:
  `no_position`, `no_lava_nearby`, `no_safe_cell`, `avoid_lava_failed`.
- `_applyOwnAttributes` now also stores an air/breathing attribute in
  `this.air` **if the server sends one** (M1 adds the simulated meter when it
  does not).

**Survival layer** — the closed vocabularies were extended, not bypassed:

- Governor conditions `inWater`, `headInWater`, `inLava`, `lavaWithin`,
  `airBelow` (`survival/rules.mjs`), with three rules in
  `knowledge/survival-rules.json`: `lava_contact` (100, `inLava`, → `avoid_lava`),
  `drowning` (98, `headInWater && airBelow 8`, → `surface`), `lava_near`
  (88, `lavaWithin 4`, → `avoid_lava`). Lava outranks every hostile rule.
- `perceiveFluids()` in `survival/perception.mjs` (unknown fluids stay
  `known: false`, no alarm); fluid scores in `survival/risk.mjs`
  (`in_lava` +60, `lava_adjacent` +45, `drowning` +45, `lava_near` +22,
  `lava_in_range` +8, `in_water`/`head_underwater` as signals);
  the `surface` need (only when the air budget is known and low); intents
  `swim`, `surface`, `descend`, `ascend`, `fluid`; verifier criteria
  `inWater`, `notInLava`, `airAtLeast` (the last two fail loudly when the state
  is unknown instead of passing).

**Live round (VM 100, container `hermes-jev-bedrock`, BDS 1.26.52 — 03/10/2026)**

| Probe | Result |
|---|---|
| `GET /observe.fluids?force=1` | `ready: true`, 259 fluid cells within 24 blocks: `water 8` (nearest 20.6, a pond), `lava 251` (nearest 15.4 at y=59) |
| `observe().fluids` on a dry bot | `hazard {level: none, reasons: []}`, `air: null` (pre-M1: the M1 section below adds the simulated budget) |
| `GET /options` (23 keys) | no `avoid_lava`: the nearest lava is 15.4 blocks away, beyond `LAVA_AVOID_RANGE` |
| `POST /act {avoid_lava}` | `{ok: true, moved: false, reason: 'no_lava_nearby'}` — typed, no movement, no burn |
| `GET /survival` | governor unaffected by the new rules: `night_with_bed`, risk `low`, needs `[sleep, continue_progression]` — no fluid noise on a dry bot |
| `POST /act {dig_down}` | `protected_front` (the room's floor), i.e. the dig path still ends on protection first |
| census while no chunk was loaded | `ready: false`, `scanned: 0` — the guard that prevents "no lava" being claimed for an unscanned world |

**Known limits (M0)**

- The escape *movement* of `avoid_lava` was not exercised live: from the base
  room the nearest lava (15.4 blocks below, y=59) is unreachable and the option
  gate correctly stays closed. Rank/move/typed failures are covered by unit
  tests.
- `air` was unknown live (`null`) in the first round; the M1 section below adds a
  **simulated** budget, so the `drowning` rule and the `surface` need now have a
  source (they remain inert only while the bot stays dry).
- Refusing a dig next to **water** is a deliberate M0 conservatism (a flooded
  shaft is not survivable without swimming). M1 was meant to relax it, but the
  wading round could not be run live, so the refusal is still in place.
- The census is bounded: `FLUID_SCAN_LIMIT` cells, radius 24 by default, and a
  large ocean will hit the limit — the nearest cells are what matters, but the
  counts saturate.

## M1 — Swimming: partial (wading + simulated air, 03/10/2026)

M1 asks for three things: water becomes traversable, the movement flags match
what the server expects, and the air budget is known. The first and third are
implemented and unit-tested; the second is **blocked** (see below).

**Wading (`_standable`, `_wadeable`, `_wading`)**

- `_passable()` still refuses `water|lava` — the bot does not swim — but
  `_standable()` now accepts a cell whose **feet** hold water **when the cell
  above is free**: that is wading, i.e. walking on the bottom with the head out.
  Deep water (water in the head cell too) stays a wall, so the invariant "no
  swimming yet" is preserved by construction; lava never qualifies.
- A* picks this up automatically (`_neighbors` is gated by `_standable`), so
  `goto_waypoint`/`_moveTo` cross a one-block stream, and `_reachableCells`
  includes the wadeable cells while deep water stays outside the component.
- `_physicsStep` walks at `WALK_SPEED * WADE_SPEED_FACTOR` (default `0.5`) while
  `_wading()`: the server moves players slower in water and a faster local
  prediction is corrected (rubber-band).
- `observe().fluids.wading` and `GET /observe.fluids` expose the state.

**Simulated air budget (`bedrock-air.mjs`, pure)**

- The server never sent a `minecraft:air` attribute in the live round, so the
  budget is simulated with the vanilla model: `MAX_AIR = 300` ticks (15 s) with
  the head under water, `AIR_RECOVER_PER_TICK = 4` out of it. `AirMeter` holds
  the counter; `_airTick()` advances it once per simulated tick inside
  `_physicsStep`, and `observe().fluids` reports `air`, `airSeconds` and
  **`airSource: 'simulated' | 'server'`** (if the attribute ever arrives, the
  server value wins and the counter is aligned to it).
- Deliberately **no damage is simulated** (health belongs to the server): the
  meter only drives decisions — the `drowning` rule, the `surface` need and the
  `fluidHazard` ladder.

**Tests**: `tests/bedrock-fluids.test.mjs` (8), `tests/bedrock-fluids-adapter.test.mjs`
(15: census/hazard/dig/lava gate + 5 wading + 3 air), `tests/bedrock-air.test.mjs`
(5). Full suite 698 tests, 0 failures.
**Live round (03/10/2026, container `hermes-jev-bedrock`, BDS 1.26.52)**

- `GET /observe.fluids?force=1` → `ready: true`, `scanned: 259`, `lavaCells 251`
  (nearest 15.4, y=59), `waterCells 8` (nearest 20.6, cells `(116,71,180)` **and**
  `(116,70,180)`); `wading: false`, `air: 300`, `airSeconds: 15`,
  `airSource: 'simulated'`, `hazard {level: 'none'}`.
- `GET /survival` → `mode: normal`, `risk none`, needs `[continue_progression]`,
  **no** drowning/surface rule on a dry bot: the simulated budget does not invent
  an emergency.
- `GET /options` (19 keys) unchanged in kind; `POST /plan {waypoint:{x:116,z:180}}`
  + `goto_waypoint` → `path_failed` (fresh evidence of the cage).

**Known limits / blocker (M1)**

- The live acceptance of M1 — *cross a river/lake to the opposite shore* —
  **cannot be run**: the only water the census knows is a **two-cell-deep** pool
  (`y=70` + `y=71`) 20.6 blocks away, i.e. deep water that needs swimming, and the
  bot is sealed in a furnished base room (waypoints → `path_failed` /
  `target_not_found`). Wading is therefore verified by unit tests only, and the
  option was **not** exercised live.
- Swimming **motion** is not implemented and must not be guessed: the Bedrock
  `input_data` flags honest to confirm are `start_swimming`/`stop_swimming`
  (29/30), `want_up`/`want_down` (16/17) and `auto_jumping_in_water` (7), plus the
  `delta` model and the buoyancy/drag constants. The discovery task — capture the
  traffic of a **real player swimming** in this BDS — needs a real client
  connected while it swims (no human joins the server during autonomous runs,
  `m01312`), so M1's `surface`/`swim_to`, water A* nodes and buoyancy stay
  unimplemented rather than shipped unverified.
- Digging next to water is still refused (the M0 conservatism): relaxing it
  requires knowing whether the shaft floods, which needs the same live round.
- `WADE_SPEED_FACTOR` is a conservative guess (half of the land speed); the first
  live wade will tell whether it should be tuned.

## M2 — Breathing and controlled dives (implemented, live 03/10/2026)

M2 asks for four things: a dive decision with an air budget, a gate on the work
that happens under water, real **Water Breathing** detection, and a governor that
knows the difference. All four are implemented; the underwater *movement* is not
(the M1 blocker), so the live round exercises the decision rather than swimming.

**`bedrock-dive.mjs` (pure, no I/O)**

- `waterBreathingSources({armor, effects, conduits})` → `{active, sources, conduitsNear}`.
  Two sources are *real*: a `turtle_helmet` on the head, and an effect whose
  registry name normalizes to `water_breathing` (`WaterBreathing` →
  `water_breathing`), with `duration` in **ticks** (`-1` = infinite, `0` = already
  expired, so it does not protect). **Conduits are reported but never count as
  active**: their effect needs a validated 3×3 water prism the bot cannot verify,
  and claiming it would be invented safety.
- `divePlan({air, depth, workSeconds, waterBreathing})` costs descent
  (`0.6 s/block`), the work, and the ascent (`0.7 s/block`) against
  `airSeconds − DIVE_RESERVE_SECONDS` (3 s). Typed errors: `no_water`,
  `unknown_air`, `air_too_low` (not even the round trip fits), `work_too_long`
  (with `maxWorkSeconds`); on success it reports `abortAtSeconds`, the instant the
  ascent has to start. With breathing active there is no budget (`held: true`).
- `underwaterWork(...)` is the single decision used everywhere: head above water →
  allowed (`head_above_water`), otherwise `budget_ok`, `water_breathing`, or the
  refusal reason.

**Adapter**

- `this.effects` is filled by the `mob_effect` packet (`add`/`update`/`remove`),
  filtered to the bot's own runtime id; each entry keeps its remaining seconds and
  an `expiresAt` — the server does **not** always send `remove` when an effect
  ends, so `_activeEffects()` drops expired entries by itself.
  `observe().fluids.waterBreathing` and `GET /observe.dive` expose
  `{active, sources, conduitsNear}`.
- `_diveDepth()` counts the water cells above the head: that is the distance to the
  surface, i.e. the ascent the budget has to pay for.
- `_underwaterWorkAllowed(workSeconds = DIVE_WORK_SECONDS)` is called by
  `_mineBlock` (before any packet) and by `_collectDrop`: it logs
  `underwater_work_refused` and returns
  `{ok: false, error: 'air_too_low' | 'work_too_long' | 'unknown_air'}` instead of
  burning a 20–30 s movement into a drowning.
- `GET /observe.dive[?workSeconds=N]` reports `{depth, workSeconds, waterBreathing, plan, last}`.

**Survival layer**: new boolean condition `waterBreathing`; the `drowning` rule now
requires `waterBreathing: false`; `deriveNeeds` does not ask for `surface` and
`assessRisk` does not score `drowning` while breathing is active (only the
informational `head_underwater` reason stays). Unknown = `false` = prudent.

**Tests**: `tests/bedrock-dive.test.mjs` (5), `tests/bedrock-fluids-adapter.test.mjs`
(23, +5 for effects/dive/gate), `tests/survival-governor.test.mjs` (+1). Full
suite 920 tests, 0 failures.

**Live round (03/10/2026, container `hermes-jev-bedrock`, BDS 1.26.52)**

| Probe | Result |
|---|---|
| `GET /observe.dive` (dry bot) | `{depth: 0, workSeconds: 3, waterBreathing: {active: false, sources: [], conduitsNear: 0}, plan: null, last: null}` |
| `GET /observe.dive?workSeconds=20` | `workSeconds: 20`, `plan: null` (dry) |
| `POST /act {"key":"mine_cobblestone"}` | `{ok: true, confirmedBy: 'server_world', ms: 2768}` — the gate is transparent when dry and `last` stays `null` (it never engaged, so no refusal was invented) |
| `effect @a water_breathing 600 0` in the BDS console | `/observe.dive` → `{active: true, sources: [{kind: 'effect', name: 'water_breathing', seconds: 600, amplifier: 0}]}`, one `mob_effect` event in `runs/demo/events.jsonl`; the same source then counted down across probes (493 → 481 → 469 → 461 s), i.e. the tick→second conversion and the remaining-time math follow the server |
| `effect @a clear`, then a second `effect … 5 0` in the console | **no change observed** (the first console command landed, the following ones did not), so the `remove` path is unit-tested only |
| Waiting out the effect | `active: false` again on its own, with the event log still holding **two** `mob_effect` packets (`add` + `update`, no `remove`): the expiry is handled by `expiresAt`/`_activeEffects()` exactly as designed, so the auto-expiry is **live-verified** |

**Known limits (M2)**

- The underwater refusal (`air_too_low` / `work_too_long`) is **unit-tested only**:
  the bot cannot get its head under water (sealed base room, the only deep water is
  20.6 blocks away, and swimming is the M1 blocker). The live round therefore shows
  the gate as transparent, not as refusing.
- The turtle-helmet source is not exercised live either (no helmet and no scutes in
  the room); the conduit source is deliberately informational.
- `DIVE_WORK_SECONDS` (3 s) is an estimate for one hand-mined block: a hard block
  with the wrong tool takes longer, and the gate does not consult the tool yet.
- Only the effects the *bot* receives are known. A potion drunk through the
  inventory would arrive the same way (`mob_effect`), but that path has not been
  observed live.

## M3 — Waterfalls and bubble columns (implemented, live partial 03/10/2026)

M3 turns a drop and a column of bubbles into **routes**: a waterfall is a free
(and safe) descent, a bubble column is an elevator. The detection, the decisions
and the typed refusals are implemented and unit-tested; the descent itself is
blocked by the same missing swimming motion as M1, so the live round exercises
the refusals rather than the ride.

**`bedrock-waterfall.mjs` (pure, no I/O)**

- `findWaterfalls(blocks, {from, minHeight, limit, includeUnsafe, blockAt})`
  groups the water cells of the census by column, keeps the vertical runs of at
  least `WATERFALL_MIN_HEIGHT` (3) and looks at the block **under** the bottom with
  `landingVerdict`: water and solid ground are safe, `lava`/`magma`/`fire`/
  `cactus`/… are hazards, `air` is a fall onto nothing, and an unreadable block is
  **unknown** (`safe: null`). Only safe landings make the list; distance is
  measured from the bot to the **top** of the column.
- `findBubbleColumns(blocks, …)` finds water above `soul_sand` (pushes up, and
  `airRefill: true`) or above `magma` (pushes down).
- `columnTactic({kind, column, feet, air, waterBreathing, swimSupported})` is the
  single decision used by the actions, `/observe.waterfall` and `dig_down`. Its
  precedence is deliberate: `no_column` → `already_inside` (descending while
  already in the column is a no-op) → `too_far` → `sneak_not_supported` (a magma
  column: without a sneak flag the bot would burn) → `unsafe_landing` →
  `unknown_landing` → **`swimming_unavailable`** → the M2 dive budget
  (`divePlan`, depth = column height, `workSeconds: 0`). A column up is free: it
  refills the air instead of costing it.

**Adapter**

- `_fluidCensus()` now also builds `waterfalls`/`bubbles` from the same water
  cells (cached with the census, `FLUID_RESCAN_MS`), and `_fluidsView()` exposes
  `waterfall`, `bubbleColumn` and `onWaterfall` (feet inside a column).
- `swimSupported` is a **declared** flag that is `false` today: it is the honest
  name of the M1 blocker. Every column action goes through `columnTactic`, so the
  missing swimming motion is expressed once instead of being sprinkled around.
- `descend_waterfall` / `climb_waterfall` / `use_bubble_column` → `_useColumn()`:
  verdict, approach to the column top (`_moveTo`), then `_waitColumnTraversal()`
  which waits for **the server** to bring the feet to the landing (down) or to the
top (up). It never simulates water physics and never claims success it cannot
  see: if the feet do not move it returns `column_not_traversed` with `deltaY`.
  The report is stored in `_waterfallLast` and logged (`column_refused`,
  `column_used`, `column_not_traversed`, `column_approach_failed`).
- `dig_down` now prefers a **usable** waterfall (same verdict as the action) and
  otherwise performs exactly the old stair dig — the acceptance "`dig_*`
  unchanged without water" holds by construction, because the tactic refuses
  before anything else when there is no column.
- `GET /observe.waterfall[?force=1]` reports counts, the compact waterfall and
  bubble rows, `onWaterfall` and the three verdicts **without executing them** —
  so the live round can read the reason of a refusal.

**Survival layer**: new boolean condition `onWaterfall` (unknown = `false`), a
contextual rule `ride_waterfall` (priority 54: stay in the column until the
landing pool, then leave the water) and the intents
`descend_waterfall: [descend, travel]`, `climb_waterfall: [ascend, travel]`,
`use_bubble_column: [fluid, ascend, descend, travel]`.

**Tests**: `tests/bedrock-waterfall.test.mjs` (8, pure: landings, runs, ordering,
all the tactic branches), `tests/bedrock-fluids-adapter.test.mjs` (32, +9 for M3),
`tests/survival-governor.test.mjs` (+1). Full suite 938 tests, 0 failures.

**Live round (03/10/2026, container `hermes-jev-bedrock`, BDS 1.26.52)**

| Probe | Result |
|---|---|
| `GET /observe.waterfall?force=1` | `swimSupported: false`, counts 0/0, `onWaterfall: false`, all three verdicts `no_column` — the census ran on the real world (259 cells) without inventing a column |
| `GET /observe.fluids?force=1` | `waterfall: null`, `bubbleColumn: null`, `onWaterfall: false`, `ready: true`, `water: 8`, `lava: 251`, `waterDistance: 20.6` |
| The only water in range | a **2×2×2 pool** at `x=116..117, z=180..181, y=70..71` — two blocks high, i.e. below `WATERFALL_MIN_HEIGHT` (3), and the columns have no bubble source |
| `POST /act {"key":"descend_waterfall"}` | `{ok: false, error: 'no_column', kind: 'descend', column: null}` in **10.6 ms** (no movement, no burn) |
| `POST /act {"key":"climb_waterfall"}` / `{"key":"use_bubble_column"}` | `no_column` in **3.7 ms** each |
| `GET /options` | 28 keys, **none** of the three column actions (the gate agrees with the verdict) |
| `GET /survival` | rule `night_with_bed`, `matchedRules: [night_with_bed]` — `ride_waterfall` does **not** fire on a dry bot |
| Rules loaded in the container | `loadSurvivalRules` shows `ride_waterfall {when: {onWaterfall: true}}` and `keyMatchesIntents('descend_waterfall', ['descend']) === true` |
| Regression | `/observe` gained `fluids.waterfall`/`bubbleColumn`/`onWaterfall`; `/observe.dive` unchanged (`depth 0`, `plan null`, `waterBreathing {active: false}`) |

**Known limits (M3)**

- **No waterfall exists in the loaded area**, so live evidence is the refusal
  (`no_column`) and the fact that the census does not hallucinate a column. The
  `swimming_unavailable` branch, the approach and the traversal verification are
  **unit-tested only**. A real ride needs the M1 swimming motion — the same
  missing packet capture of a real player swimming (`m01312`).
- No column was fabricated for the test: that would mean placing water in the
  shared world (the base plan forbids touching it), and leaving flowing water
  behind changes the world permanently.
- **Pathfinding column edges were deliberately not added.** A descent edge into
  water the bot cannot swim out of is a trap, not an optimisation: the edges must
  land with M1's swimming, which is what makes the landing survivable. Until then
  a waterfall is used as a *route* only through the explicit action.
- `WATERFALL_MIN_HEIGHT = 3` is a judgment call (3 blocks is a real drop, 2 is a
  step), and the bonus of a waterfall over a stair dig is not yet measured.
- The landing check reads the block under the column from the loaded chunk: if the
  landing is not loaded the column is ignored (prudent, but on a long fall the
  interesting part is exactly the chunk that is not loaded).
- Fall damage is still not modelled (see the risks): a waterfall is safe *because*
  the landing is water, not because the bot understands the fall.

## M4 — Lava: shores, destroyed loot and a crossing gate (implemented, live partial 03/10/2026)

Lava is the one fluid that is *never* a route: it is an absolute obstacle, and the
M4 work is about not losing what it destroys and not walking into it when a
later milestone could have made it crossable.

### Implementation

- **`bedrock-lava.mjs`** (pure, no I/O, five decisions that can be checked
offline):
  - `deathVerdict({position, lava, radius})` → `{known, inLava, nearest,
    recoverable, reason}` with `reason ∈ in_lava | lava_near | safe |
    unknown_site`. Inside the lava — or within `LAVA_DEATH_RADIUS = 2` — the
    loot is gone, so `recoverable: false`.
  - `lostDrops(drops, lava)` → the tracked drops whose cell *is* lava.
  - `safeShorePlan({from, candidates, hazards, water})` → escape cells ranked by
    `gain + (waterAdjacent ? 2 : 0)`: water next to the cell is worth more
    because entering water puts the fire out. Cells closer than
    `SAFE_SHORE_MIN_GAP = 2` to lava are refused (a shore one block from the
    lava is a bet, not a shore).
  - `lavaGap({from, direction, lava, maxSteps})` → the **first** stretch of lava
    along a direction, in one-block steps, with `truncated: true` when the lava
    continues past the scan: the far shore is never invented. `lateral` defaults
    to 0 — with a lateral tolerance the stretch widens by two cells, and a
    measurement that lies wide is worse than no measurement.
  - `lavaCrossingGate({dimension, gap, fireResistance, waterBuckets,
    bridgeBlocks})` → `gap_unknown`, `gap_too_wide` (over
    `LAVA_CROSS_GAP_LIMIT = 4`), **`water_in_nether`** (a water bucket cannot be
    placed in the Nether or the End: saying otherwise would be the most
    expensive lie of this milestone), `not_equipped`, `no_fire_resistance` (a gap
    over one block needs the potion), or `{ok: true, route: 'none' | 'bridge' |
    'water', blocks}`.
  - `fireResistance({effects})` normalises the effect name (`water_breathing`
    style) and drops expired entries (`seconds <= 0`).
- **Adapter**: `_dropInLava(position)` (feeds `_nearestDrop`, so a burnt drop is
  never chased); `_deathVerdict()` recomputed from the census (the verdict does
  not depend on the order of actions) and `_recoverLoot()` returning
  `drops_lost_in_lava` + log `recover_loot_skipped` **before** moving; the
  `recover_loot` option disappears entirely when the site is unrecoverable;
  `_lavaGapAhead()` measuring the four cardinal directions from the occupied
  cell (the bot's feet are fractional: measuring from `0.5` would match no whole
  cell) and keeping the shortest stretch; `_lavaView({force})` → dimension,
  `inLava`, `lavaDistance`, `cells`, `fireResistance`, `gap`, `gate`,
  `lostDrops`, `death`, `last`; `_moveToSafe({timeoutMs})` (refuses with
  `not_in_danger` when the lava is not on top of the bot, builds candidates from
  `_standableNear` on rings 4/8/12, ranks them with `safeShorePlan`, and records
  the after-verdict in `_lavaLast`); `_crossLava()` (typed refusals `in_lava`,
  `no_lava_ahead`, `gap_unknown`, then the gate error, and with the gate open
  `bridge_not_implemented` + the plan it would follow: the bridge is M5/M6, and a
  fake success here would be the worst possible outcome).
- **Governor**: no new condition — `inLava`, `lavaWithin` and the `lava_contact`
  (priority 100 ⇒ emergency) / `lava_near` (88 ⇒ caution) rules already existed
  from M0; `survival/intents.mjs` gains `move_to_safe: ['escape','travel']` and
  `cross_lava: ['travel','fluid']`, so the new keys are coherent with the intent
  vocabulary an emergency rule can request.
- **Harness**: `GET /observe.lava[?force=1]` → `adapter._lavaView({force})`, and
  `lava` inside `/observe`.

### Tests

- `tests/bedrock-lava.test.mjs` — 9 pure cases: cell keys and `inLava` with
  rounding, distances, every `deathVerdict` outcome, `lostDrops` ignoring lava on
  another Y, `safeShorePlan` (the water flank wins, the lava edge is refused, no
  candidate that gains ⇒ empty list), `fireResistance`, `lavaGap` (measured,
  truncated, outside the direction, other height, missing inputs) and the whole
  `lavaCrossingGate` ladder including the Nether water refusal.
- `tests/bedrock-fluids-adapter.test.mjs` — +7 M4 cases (39 in total): the view
  with distance, gap, gate and lost drops; the gate armed by a real
  `fire_resistance` effect; the drop filter; the lava death + `recover_loot`
  refusal with zero moves; `move_to_safe` refusing out of danger, choosing the
  water flank, and `no_safe_cell` with no candidate; `cross_lava` refusing inside
  the lava, with no lava ahead and on a truncated stretch; the gate ladder and the
  `bridge_not_implemented` plan.
- `tests/survival-governor.test.mjs` — +1 case: lava on top of the bot ⇒ emergency
  with the `lava_contact` objective, lava within 4 ⇒ caution, the two new keys
  coherent with the intents, and the `inLava`/`lavaWithin` conditions mapping the
  perception (where `lavaWithin` is the alias of `lavaDistance`).
- Suite: **955 tests, 0 failures** (03/10/2026).

### Live round (03/10/2026)

| Probe | Result |
|---|---|
| `GET /observe.lava?force=1` | `inLava: false`, `lavaDistance: 15.4` (nearest `{x:111,y:59,z:155}`, 251 cells in a cave **below** the room), `cells: 251`, `lostDrops: []`, `death: null`, `gap: {gap:0, reason:'no_lava'}`, `gate: {ok:true, route:'none'}` |
| `POST /act move_to_safe` | `{"ok":false,"error":"not_in_danger","inLava":false,"lavaDistance":15.4}` — immediate, no movement, no burn |
| `POST /act cross_lava` | `{"ok":false,"error":"no_lava_ahead","lavaDistance":15.4}` |
| `GET /options` | 26 keys, **neither** `move_to_safe` nor `cross_lava` (and no `recover_loot`: there is no death site) |
| `GET /survival` | `mode: normal`, no lava rule matched, no lava risk — the rules stay inert on a bot that is not near lava |
| `GET /observe` | `lava` present next to `fluids`/`dive` (regression check), bot `spawned` at (115.5, 74.62, 159.5) with its inventory unchanged |

### Known limits

- The **bridge is not built**: `cross_lava` stops at `bridge_not_implemented` with
  the plan in hand. That is deliberate — the building primitive belongs to M5/M6,
  and M0's rule is that a typed refusal is worth more than a nominal success.
- The **escape move** (`move_to_safe`) was never exercised live: the base room's
  lava is 15.4 blocks below the floor. Its shore choice, its preference for water
  and its `no_safe_cell` path are unit-tested only.
- No lava was fabricated for the test (`setblock`/buckets would modify the shared
  world and leave flowing lava behind): the acceptance criterion "live escape from
  the lava edge" stays **unmet on the live side** and is recorded as such.
- No `place_water` exists yet, so the obsidian route in the gate is decision-only:
  `route: 'water'` describes what M5 will do, and the gate refuses the Nether
  before it can be attempted.
- The gap measurement is bounded by the fluid census radius
  (`FLUID_SCAN_RADIUS`, 24 by default): a lake wider than that is reported
  `truncated` (and therefore `gap_unknown`), never `gap_too_wide`.
- Death in lava itself was not observed live (no death in this round): the
  destroyed-loot verdict is unit-tested against a synthetic death site, and it is
  the *next* lava contact that will exercise it end to end.

## M5 — Buckets, boats, brewing and the lava bridge (implemented, live 03/10/2026)

### Implementation

- **`bedrock-bucket.mjs` (pure)**: `bucketSourceVerdict({block})` (a source is
  distinguished by the **block name** — `water` vs `flowing_water`, `lava` vs
  `flowing_lava` — not by `liquid_depth`; powder snow fills too),
  `placeBucketVerdict({held, block, dimension})` → `obsidian` on a lava
  **source**, `cobblestone` on flowing lava, `water`/`lava`/`powder_snow`
  otherwise, with the Nether/End refused from the start (`water_in_nether`),
  `bucketDelta({before, after, item, spentItem})` (a bucket counts as filled only
  when the product was gained **and** the container was spent; `spentItem` is the
  glass bottle for a potion), `boatVerdict({boats, water, riding, waterDistance})`
  (needs a boat in the inventory and `BOAT_MIN_WATER` 3 water cells within
  `BOAT_WATER_RANGE` 16), `brewPlan({effect, stand, fuel, waterBottles,
  netherWart, ingredients})` with `BREW_RECIPES` (`water_breathing`: pufferfish,
  `fire_resistance`: magma cream, `night_vision`: golden carrot) and the three
  steps (bottle → awkward potion → effect).
- **`bedrock-adapter.mjs`**: `_bucketsHeld`, `_bucketSources({radius: 16})`
  (reads the **block name from the world**, so flowing water is not offered as a
  source), `_useOnSource` (equip → approach → look → use → confirm from the
  inventory delta), `_fillBucket`, `_fillBottle`, `_emptyBucket(item, target)`
  (the pure verdict runs *before* any packet; the confirmation reads the world —
  the cell changed, or water ended up above it), `_boatCount`/`_nearestBoat`/
  `_craftBoat`/`_mountBoat`, `_brewStand`/`_brewPlan`/`_brew`, `_bucketView`, and
  **`_bridgeLava`**: it walks the gap one cell at a time, pours a water bucket on
  the lava when one is in the inventory (obsidian) or places the most abundant
  block, and only advances onto a cell it has seen become solid — a stalled
  bridge stops on a safe footing and says so. `_crossLava` now delegates to it
  (M4's `bridge_not_implemented` is gone).
- Options: `fill_bucket`, `place_water` (the description says it will turn the
  lava into obsidian when the target is a source), `fill_bottle`, `craft_boat`,
  `mount_boat`, each gated by the corresponding pure verdict. `GET
  /observe.bucket` exposes `held`, `sources`, `water`, `lava`, `boat`, `brew` and
  `last`.
- **The brewing stand interaction is deliberately not implemented**:
  `brew_<effect>` answers `brew_not_implemented` with the full plan. The plan is
  honest (it names every missing item and the three steps) and the container
  interaction is the one piece of M5 left to do.

### Tests

**977 tests** (was 955): 8 pure in `tests/bedrock-bucket.test.mjs` (source vs
flowing, every placement result, bucket delta with a spent bottle, boat gate,
brew plan), 12 new adapter cases in `tests/bedrock-fluids-adapter.test.mjs` (51
total: the source census, the fill confirmed by the inventory delta, the bottle,
`_emptyBucket` reading obsidian back from the world, the Nether and blocked-cell
refusals, `_craftBoat`, `mount_boat` including `mount_not_confirmed`, `_brew`, the
option gating, `observe().bucket`), the rewritten M4 `cross_lava` test (it now
asserts the **bridge**: cells, supports, face 5, two moves, `lava_bridged`), a
water-bridge test, the bridge refusals, and a dispatch test. The dispatch test
exists because of a real defect: `place_water` and `mount_boat` were answering
`missing_item`/`no_rideable_nearby` because the new branches sat **after** the
generic `key.startsWith('mount_')`/`('place_')` branches; the M5 block now sits
first, and the test calls `executeAction('fill_bucket' | 'place_water' |
'mount_boat')` so the ordering cannot regress silently.

### Live round (03/10/2026)

`GET /observe.bucket?force=1` on the deployed container: no bucket of any kind
(`held` all zero), **4 lava sources** at y=59 (`111,59,155` at 15.68 blocks,
`110,59,156`, `110,59,155`, `111,59,154` — the list is capped at 4), water `8`
cells at 20.6 blocks (`116,71,180`), lava `251` cells at 15.4, no boat
(`missing_boat`), no brewing stand, `last: null`.

| probe | live answer | ms |
|---|---|---|
| `fill_bucket` | `missing_bucket` | 18 |
| `place_water` | `missing_water_bucket` | 15 |
| `place_lava` | `missing_lava_bucket` | 14 |
| `fill_bottle` | `missing_glass_bottle` | 16 |
| `craft_boat` | `craft_recipe_missing` | 21 |
| `mount_boat` | `missing_boat` | 17 |
| `brew_water_breathing` | `missing_brewing_stand` + `missing: [brewing_stand, blaze_powder, potion, nether_wart, pufferfish]` + the 3-step plan | 19 |
| `cross_lava` | `no_lava_ahead` (the measured gap is 0: no lava on the four cardinal directions) | 16 |

`/options` returns 22 keys and **none** of the M5 actions (the gates are closed),
`/observe.lava` keeps reporting `gap {gap: 0, reason: 'no_lava'}` and
`gate {ok: true, route: 'none'}`. As for M2–M4, the bottle in hand is the only
reason the hidden lava 15.4 blocks below the room is out of reach, so the happy
paths (fill → pour → obsidian, the bridge, the boat ride) are unit-tested and the
live round is a refusal round. No lava was fabricated with `setblock` (shared
world, and flowing lava would be left behind).

### Known limits

- The brewing stand is planned but never clicked (`brew_not_implemented`): the
  container interaction (fuel slot, three bottle slots, ingredient slot,
  wait for the bubble animation) is future work.
- `_bridgeLava` places at most `LAVA_CROSS_GAP_LIMIT + 1` cells and refuses a
  gap wider than 4 (`gap_too_wide`), and it refuses a `truncated` measurement
  (`gap_unknown`): a real lava lake stays out of bounds.
- Placing water in the Nether is refused from the verdict up
  (`water_in_nether`), so the Nether crossing still needs the block bridge.
- `mount_boat` needs a boat in the inventory: `craft_boat` is gated on a
  server-provided recipe whose id matches `isBoatItem` (wood variants); the ride
  itself reuses `_rideToward`, which still walks rather than paddles.
- The water bucket is consumed by the first bridge cell even when the pour is not
  confirmed (the inventory delta is the only local truth available).

## M6 — Fluid skills, milestones and criteria (implemented, live 03/10/2026)

### Implementation

- **Nine skill contracts** in `skills/gameplay/fluids/`: `cross_water`,
  `survive_drowning`, `escape_lava`, `descend_waterfall`, `climb_waterfall`,
  `craft_bucket`, `bucket_and_place_water`, `boat_travel`,
  `brew_water_breathing`. Each one declares preconditions, a success criterion the
  verifier can evaluate on two observations, its intents and (when the capability
  is genuinely missing) a **`blocked` reason** — the schema now accepts that field,
  so the library announces its own holes instead of leaving them to be deduced
  from the name. Five are blocked today (`cross_water`, `survive_drowning`,
  `descend_waterfall`, `climb_waterfall` on M1's swimming motion,
  `brew_water_breathing` on the unwritten brewing-stand interaction).
- **Item tags** (`survival/item-tags.mjs`): `buckets` (`bucket` and every
  `*_bucket`, filled or empty), `boats` (`boat`, `*_boat`, `*_chest_boat`,
  `*_raft`) and `potions`.
- **Four new verifier criteria** (`survival/verify.mjs`), all reading real
  observation fields: `waterBreathing` (the server's effect or the turtle helmet,
  in either shape the adapter exposes), and the three spatial ones —
  `descendedAtLeast`, `climbedAtLeast` and `movedAtLeast` compare the `before` and
  `after` observations, so "I went down 8 blocks" is a measurement, not a claim.
  A missing position fails the criterion instead of passing it.
- **Three milestones** in `knowledge/progression.json` — `bucket`
  (`requires: [iron_age]`, satisfied by `inventoryTagGte {buckets: 1}`),
  `water_travel` (`requires: [bucket]`, `satisfiedWhen: null`: a boat crossing is
  not visible to a static criterion, so only the verified skill can close it) and
  `nether_cross_lava` (`requires: [water_travel]`, skill
  `bucket_and_place_water`) — plus the matching `goals` entries, which is what
  makes `CURRICULUM=bucket|water_travel|nether_cross_lava` route to them.

### Tests

**984 tests** (was 977). `tests/gameplay-skills.test.mjs`: the nine ids load, the
`blocked` set is exactly the five blocked skills and each reason is a sentence
(not a placeholder), the criteria verify on real observations (`craft_bucket`
needs the bucket item, `bucket_and_place_water` needs **obsidian** — not the pour
— `escape_lava` refuses to promote without the fluid datum), the spatial criteria
compare the two positions (a descent is not an ascent; without a position nothing
is declared), and `waterBreathing` accepts both shapes. `tests/progression.test.mjs`:
the tag grouping (`water_bucket` counts, `bucket_of_milk` is not a Bedrock name,
`boat_planks` is not a boat), the milestone chain and its `requires`, the `null`
`satisfiedWhen` of the travel milestone, and the bucket milestone refusing raw
iron.

### Live round (03/10/2026)

In the deployed container: `loadGameplaySkills()` → **35 skills, 9 of them
fluids**; `loadProgression()` → **23 milestones** and 8 curriculum goals
(`bucket`, `water_travel`, `nether_cross_lava` included);
`resolveMilestone(water_travel)` → `{status: 'next', milestone: 'wood', skill:
'acquire_wood'}` — the new goal resolves **through the chain** to the first unmet
prerequisite instead of erroring; `verifySkill(descend_waterfall, {y: 90},
{y: 82})` → `success` with evidence `{yBefore: 90, yAfter: 82, deltaY: -8,
health: 20}`; the tags count `{water_bucket: 2, oak_boat: 1, potion: 1}` as
`buckets: 2`, `boats: 1`, `potions: 1`.

Then a real curriculum round (`RUN_ID=m6-live-1`, `CURRICULUM=water_travel`,
`MAX_STEPS=2`) ran against the BDS: `GOAL g1 [curriculum] Progress the Survival
tech tree until the "water_travel" milestone is complete.`, first plan
`stone_age`, `#1 sleep -> {slept: 'night_skipped'}`,
`#2 mine_cobblestone -> {ok: true, confirmedBy: 'server_world', destroyedEvent:
true}`, `step budget exhausted`, `CANCELLED (exhausted)`, `exit=0`. The new goal
is therefore wired end-to-end: accepted, resolved to the prerequisite chain and
executed with server confirmation.

### Known limits

- The five `blocked` skills are honest but they are still **not executable**: four
  wait for M1's swimming motion and one for the brewing-stand interaction.
- `water_travel` and `nether_cross_lava` have no static `satisfiedWhen`: they can
  only be closed by a verified skill run, which is the honest shape (there is no
  static fact that says "the bot crossed").
- `movedAtLeast` measures displacement between two observations: it cannot tell a
  crossing from a walk along the shore, which is why `cross_water` also requires
  `inWater: false` and its notes say the criterion is a proxy.
- `nearbyBlock` reads the adapter's nearby block list (capped): `obsidian` proves
  the pour only because the new block is close enough to be in that list.

### Milestones

| # | Milestone | Content | Status |
|---|---|---|---|
| M0 | Fluid awareness | Pure `bedrock-fluids.mjs`; `/observe.fluids`; scan water/lava; perception + governor rules (`drowning`, `lava_contact`, `lava_near`); pathfinding forbids/repels lava; dig adjacency check; generalized `avoid_lava`. | ◑ implemented + live 03/10/2026 (awareness, census, option gate and rule inertness collaudati live; the escape move and the emergency rules stay unit-tested — no reachable lava from the base room) |
| M1 | Swimming physics & navigation | Water becomes passable; buoyancy/drag/swim speed in `_physicsStep`; correct `input_data` flags (packet-capture task); A* water nodes; air budget + auto-`surface`; `surface`/`swim_to`. | ◑ partial 03/10/2026: **wading** (shallow water traversal + slower local speed) and the **simulated air budget** (`bedrock-air.mjs`, `airSource`) are implemented and unit-tested; the live crossing round is blocked (only deep water within 20.6 blocks, bot sealed in the base room) and the swimming motion/water A*/`surface`/`swim_to` stay unimplemented pending a packet capture of a real player swimming |
| M2 | Breathing & controlled dives | `dive` with air budget; underwater `mine_*`/`collect_drop`; Water Breathing detection; governor `drowning` + `breathe` need. | ◑ implemented + live 03/10/2026: the **decision** (budget, `waterBreathing`, the gate on `mine_*`/`collect_drop`) is implemented, unit-tested and collaudato live (effect detected and counted down by the real server; the gate transparent on a dry bot). The underwater *move* stays blocked by M1: from the base room the head never gets under water, so the refusal path is unit-tested only. |
| M3 | Waterfalls & bubble columns | `findWaterfalls`/`findBubbleColumns`; `descend_waterfall`, `climb_waterfall`, `use_bubble_column`; pathfinding edges; `dig_down` prefers a nearby waterfall. | ◑ implemented + live partial 03/10/2026: detection (`findWaterfalls`/`findBubbleColumns` on the real census), the three actions with typed verdicts, the `onWaterfall` governor condition and the `dig_down` preference are implemented and unit-tested; live only the **refusal** path was observable (no waterfall exists in the loaded area: the only water is a 2-high pool), so the descent/climb themselves stay blocked by the M1 swimming blocker. Pathfinding column edges were deliberately **not** added yet (see the M3 section). |
| M4 | Lava: avoid (cross later) | Absolute obstacle + repulsion; `move_to_safe`; lava-death marking; never mine into lava; bucket bridging (`place_water` → obsidian); Nether crossing gated behind `fire_resistance` + bridging. | ◑ implemented + live 03/10/2026: `bedrock-lava.mjs` (death verdict, water-preferring shore plan, gap measurement, crossing gate), the `move_to_safe`/`cross_lava` actions with typed refusals, the drop filter and the destroyed-loot verdict on `recover_loot` are implemented and unit-tested; live the bot has no reachable lava (nearest is 15.4 blocks below the base room) so only the refusals were observable — the bridge build and the real escape move stay unit-tested |
| M5 | Buckets, boats, potions | `craft_bucket`/`craft_boat`; `fill_bucket`/`empty_bucket`/`place_water`; boat travel on open water via `mount_*`/`_rideToward`; brewing. | ◑ implemented + live 03/10/2026: `bedrock-bucket.mjs` (source/placement verdicts, bucket delta, boat gate, brew plan), `fill_bucket`/`fill_bottle`/`place_water`/`place_lava`/`craft_boat`/`mount_boat`/`brew_*` actions, `_bucketView` + `GET /observe.bucket`, and the **lava bridge** (`_bridgeLava`, which closes M4's `bridge_not_implemented`) are implemented and unit-tested; live every action answers a typed refusal in milliseconds (no bucket, no boat, no stand, no reachable lava) — the `craft_bucket`→`fill_bucket`→`place_water` chain, the boat ride and the brewing-stand interaction stay unit-tested (see the M5 section) |
| M6 | Survival Intelligence integration | Gameplay skills in `skills/gameplay/fluids/`; progression milestones `bucket`, `water_travel`, gated `nether_cross_lava`; docs + tests. | ◑ implemented + live 03/10/2026: 9 skill contracts (`skills/gameplay/fluids/`), the tags `buckets`/`boats`/`potions`, four new verifier criteria (`waterBreathing`, `descendedAtLeast`, `climbedAtLeast`, `movedAtLeast`), the `blocked` field on the skill schema, the three milestones + the matching `CURRICULUM` goals; live the container loads 35 skills (9 fluids), resolves `CURRICULUM=water_travel` through the new chain (`wood` → … → `bucket` → `water_travel`) and closes a run with real actions. The five skills that depend on swimming/brewing declare their own `blocked` reason instead of pretending to be executable |

## Key risks / open questions

- The exact Bedrock water movement flags and `delta` semantics are unknown until a
  packet capture of a real player swimming confirms them (M1's blocker: the
  candidates are `start_swimming`/`stop_swimming` 29/30, `want_up`/`want_down`
  16/17, `auto_jumping_in_water` 7).
- The air budget was never sent by the server, so it is **simulated**
  (`bedrock-air.mjs`, 300 ticks + 4/tick recovery, `airSource: 'simulated'`):
  correct for decisions, still unverified against server truth. M2 uses it for the
  dive decision, but the **underwater** path (the refusal of `mine_*`/
  `collect_drop` while the head is under water) has never been exercised live: the
  bot cannot submerge from the base room, so only the dry (transparent) branch was
  collaudato.
- Water Breathing detection is real (turtle helmet + a `mob_effect` effect, both
  counted down live against the server) but only the effect source was observed;
  the helmet needs scutes the bot does not have, and the conduit is reported
  without ever being trusted (a conduit’s effect depends on a validated 3×3 water
  prism the bot cannot verify).
- `DIVE_WORK_SECONDS` (3 s) is an estimate for one hand-mined block: the gate does
  not consult the tool yet, so a slow block can outlast the work budget it claims.
- Lava crossing is decision-complete and the bridge exists (`_bridgeLava`
  pours water/places blocks one cell at a time and only advances on a confirmed
  cell), but it has **never been exercised live**: no lava is reachable from the
  base room, so the happy path is unit-tested only. The gate still refuses
  anything wider than 4 cells or `truncated`.
- The M6 skills that wait on the swimming motion (M1) or on the brewing stand
  (M5) say so in their own `blocked` field: a planning pass can read the reason
  without a human having to remember it.
- The brewing stand is the one M5 hole: the plan is computed and honest
  (`brew_not_implemented` with the missing list and the three steps), the
  container interaction is not written.
- `place_water` on lava gives obsidian only when the target is a **source**;
  on flowing lava it gives cobblestone. That distinction comes from the block
  name the server sends, not from the visual "is it lava" question.
- The M5 dispatch ordering was a real defect (the generic `mount_`/`place_`
  prefixes shadowed the new branches): any future action whose name starts like a
  generic prefix must be added **before** it, and `tests/bedrock-fluids-adapter.test.mjs`
  now pins the ordering.
- The lava gap is measured from the loaded census radius: a wide lake is
  `truncated` ⇒ `gap_unknown`. Measuring further would need a scan that costs
  more than the answer is worth today, and a wrong width is worse than no width.
- `move_to_safe` prefers a shore with water next to it (+2 score). That is a
  heuristic from the raw roadmap ("water puts out the fire"), not a measured
  advantage: it is not yet known whether the extra walk is worth it.
- Fall damage is not modelled today: waterfalls solve descent into water, not
  drops onto land. Add `_fallStartY` + a safe-landing predicate.
- A waterfall is only a route once the bot can **leave** the water: the M3 column
  actions, the pathfinding edges and the `ride_waterfall` rule all wait on M1's
  swimming motion (`swimSupported` is `false` by declaration, not by accident).
- Deep-water air budgeting and large-ocean scan performance must be bounded.
- Family-base water features (wells, irrigation, waterfalls) must not be broken
  or redirected without consent.

## Related pages

- [roadmap](roadmap.md) — consolidated implementation status.
- [open-questions](open-questions.md) — blockers and verification gaps.
- [verification](verification.md) — collaudo checklist.
- [fishing](fishing.md) — the existing water-based capability.
- [companions](companions.md) — boats/mounts, the base for boat travel.
- [headless-client](headless-client.md) — protocol-level perception and the
  bounded-action loop.
- [survival-intelligence](survival-intelligence.md) — governor, skills, verifier,
  progression.
