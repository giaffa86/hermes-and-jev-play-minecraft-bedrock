# Fluids: swimming, drowning, waterfalls and lava

Roadmap for making the bot able to operate **in and around fluids**: swim and
cross water, avoid drowning (breathing/air management), exploit waterfalls to
descend and ascend, and **avoid lava** until it is equipped (bucket, fire
resistance, bridging). It also covers every fluid-related skill: buckets, boats,
bubble columns, potions, underwater mining/fishing.

Status: **M0 (fluid awareness) implemented, unit-tested and collaudato live**
(03/10/2026); M1–M6 still spec only (tracked in [roadmap](roadmap.md) and
[open-questions](open-questions.md)). Full raw source:
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
  `this.air` **if the server sends one**.

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
| `observe().fluids` on a dry bot | `hazard {level: none, reasons: []}`, `air: null` |
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
- `air` is still unknown live (`null`): the `drowning` rule and the `surface`
  need stay inert until a server attribute or the M1 air simulation provides a
  budget.
- Refusing a dig next to **water** is a deliberate M0 conservatism (a flooded
  shaft is not survivable without swimming). M1 relaxes it.
- The census is bounded: `FLUID_SCAN_LIMIT` cells, radius 24 by default, and a
  large ocean will hit the limit — the nearest cells are what matters, but the
  counts saturate.

## Milestones

| # | Milestone | Content | Status |
|---|---|---|---|
| M0 | Fluid awareness | Pure `bedrock-fluids.mjs`; `/observe.fluids`; scan water/lava; perception + governor rules (`drowning`, `lava_contact`, `lava_near`); pathfinding forbids/repels lava; dig adjacency check; generalized `avoid_lava`. | ◑ implemented + live 03/10/2026 (awareness, census, option gate and rule inertness collaudati live; the escape move and the emergency rules stay unit-tested — no reachable lava from the base room) |
| M1 | Swimming physics & navigation | Water becomes passable; buoyancy/drag/swim speed in `_physicsStep`; correct `input_data` flags (packet-capture task); A* water nodes; air budget + auto-`surface`; `surface`/`swim_to`. | ❌ not implemented |
| M2 | Breathing & controlled dives | `dive` with air budget; underwater `mine_*`/`collect_drop`; Water Breathing detection; governor `drowning` + `breathe` need. | ❌ not implemented |
| M3 | Waterfalls & bubble columns | `findWaterfalls`/`findBubbleColumns`; `descend_waterfall`, `climb_waterfall`, `use_bubble_column`; pathfinding edges; `dig_down` prefers a nearby waterfall. | ❌ not implemented |
| M4 | Lava: avoid (cross later) | Absolute obstacle + repulsion; `move_to_safe`; lava-death marking; never mine into lava; bucket bridging (`place_water` → obsidian); Nether crossing gated behind `fire_resistance` + bridging. | ❌ not implemented |
| M5 | Buckets, boats, potions | `craft_bucket`/`craft_boat`; `fill_bucket`/`empty_bucket`/`place_water`; boat travel on open water via `mount_*`/`_rideToward`; brewing. | ❌ not implemented |
| M6 | Survival Intelligence integration | Gameplay skills in `skills/gameplay/fluids/`; progression milestones `bucket`, `water_travel`, gated `nether_cross_lava`; docs + tests. | ❌ not implemented |

## Key risks / open questions

- The exact Bedrock water movement flags and `delta` semantics are unknown until a
  packet capture of a real player swimming confirms them.
- The air budget is still unknown live: `_applyOwnAttributes` stores an air
  attribute *if the server sends one*, and it never did in the live round, so
  `drowning` and `surface` are inert. M1 must either find the metadata or
  simulate the budget (water cells + timer).
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
