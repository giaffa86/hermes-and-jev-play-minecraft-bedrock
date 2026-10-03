# Fluids: swimming, drowning, waterfalls and lava

Roadmap for making the bot able to operate **in and around fluids**: swim and
cross water, avoid drowning (breathing/air management), exploit waterfalls to
descend and ascend, and **avoid lava** until it is equipped (bucket, fire
resistance, bridging). It also covers every fluid-related skill: buckets, boats,
bubble columns, potions, underwater mining/fishing.

Status: **M0 (fluid awareness) + M1 partial (wading and simulated air budget)
implemented, unit-tested and collaudato live** (03/10/2026); the swimming
*physics* of M1 (ballistic flags, water A*, `swim_to`) is **blocked** by a
missing packet capture — see the M1 section. M2–M6 still spec only (tracked in
[roadmap](roadmap.md) and [open-questions](open-questions.md)). Full raw source:
[`docs/raw/FLUIDS_ROADMAP.md`](../raw/FLUIDS_ROADMAP.md).

Sources: `bedrock-adapter.mjs` (movement, physics, digging, fishing), `BEDROCK.md`
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

## Milestones

| # | Milestone | Content | Status |
|---|---|---|---|
| M0 | Fluid awareness | Pure `bedrock-fluids.mjs`; `/observe.fluids`; scan water/lava; perception + governor rules (`drowning`, `lava_contact`, `lava_near`); pathfinding forbids/repels lava; dig adjacency check; generalized `avoid_lava`. | ◑ implemented + live 03/10/2026 (awareness, census, option gate and rule inertness collaudati live; the escape move and the emergency rules stay unit-tested — no reachable lava from the base room) |
| M1 | Swimming physics & navigation | Water becomes passable; buoyancy/drag/swim speed in `_physicsStep`; correct `input_data` flags (packet-capture task); A* water nodes; air budget + auto-`surface`; `surface`/`swim_to`. | ◑ partial 03/10/2026: **wading** (shallow water traversal + slower local speed) and the **simulated air budget** (`bedrock-air.mjs`, `airSource`) are implemented and unit-tested; the live crossing round is blocked (only deep water within 20.6 blocks, bot sealed in the base room) and the swimming motion/water A*/`surface`/`swim_to` stay unimplemented pending a packet capture of a real player swimming |
| M2 | Breathing & controlled dives | `dive` with air budget; underwater `mine_*`/`collect_drop`; Water Breathing detection; governor `drowning` + `breathe` need. | ❌ not implemented |
| M3 | Waterfalls & bubble columns | `findWaterfalls`/`findBubbleColumns`; `descend_waterfall`, `climb_waterfall`, `use_bubble_column`; pathfinding edges; `dig_down` prefers a nearby waterfall. | ❌ not implemented |
| M4 | Lava: avoid (cross later) | Absolute obstacle + repulsion; `move_to_safe`; lava-death marking; never mine into lava; bucket bridging (`place_water` → obsidian); Nether crossing gated behind `fire_resistance` + bridging. | ❌ not implemented |
| M5 | Buckets, boats, potions | `craft_bucket`/`craft_boat`; `fill_bucket`/`empty_bucket`/`place_water`; boat travel on open water via `mount_*`/`_rideToward`; brewing. | ❌ not implemented |
| M6 | Survival Intelligence integration | Gameplay skills in `skills/gameplay/fluids/`; progression milestones `bucket`, `water_travel`, gated `nether_cross_lava`; docs + tests. | ❌ not implemented |

## Key risks / open questions

- The exact Bedrock water movement flags and `delta` semantics are unknown until a
  packet capture of a real player swimming confirms them (M1's blocker: the
  candidates are `start_swimming`/`stop_swimming` 29/30, `want_up`/`want_down`
  16/17, `auto_jumping_in_water` 7).
- The air budget was never sent by the server, so it is **simulated**
  (`bedrock-air.mjs`, 300 ticks + 4/tick recovery, `airSource: 'simulated'`):
  correct for decisions, still unverified against server truth, and it cannot be
  exercised until the bot can submerge.
- Fall damage is not modelled today: waterfalls solve descent into water, not
  drops onto land. Add `_fallStartY` + a safe-landing predicate.
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
