# Fluids: swimming, drowning, waterfalls and lava

Roadmap for making the bot able to operate **in and around fluids**: swim and
cross water, avoid drowning (breathing/air management), exploit waterfalls to
descend and ascend, and **avoid lava** until it is equipped (bucket, fire
resistance, bridging). It also covers every fluid-related skill: buckets, boats,
bubble columns, potions, underwater mining/fishing.

Status: **spec only — not implemented** (tracked in
[roadmap](roadmap.md) and [open-questions](open-questions.md)). Full raw source:
[`docs/raw/FLUIDS_ROADMAP.md`](../raw/FLUIDS_ROADMAP.md).

Sources: `bedrock-adapter.mjs` (movement, physics, digging, fishing), `BEDROCK.md`
(action status), [headless-client](headless-client.md) (perception/action model),
[survival-intelligence](survival-intelligence.md) (governor/skills/verifier),
[fishing](fishing.md), [companions](companions.md) (boats/riding).

## Current state (from the code)

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
  is never used as cover from a lava field.
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

## Milestones

| # | Milestone | Content | Status |
|---|---|---|---|
| M0 | Fluid awareness | Pure `bedrock-fluids.mjs`; `/observe.fluids`; scan water/lava; perception + governor rules (`drowning`, `lava_contact`, `lava_near`); pathfinding forbids/repels lava; dig adjacency check; generalized `avoid_lava`. | ❌ not implemented |
| M1 | Swimming physics & navigation | Water becomes passable; buoyancy/drag/swim speed in `_physicsStep`; correct `input_data` flags (packet-capture task); A* water nodes; air budget + auto-`surface`; `surface`/`swim_to`. | ❌ not implemented |
| M2 | Breathing & controlled dives | `dive` with air budget; underwater `mine_*`/`collect_drop`; Water Breathing detection; governor `drowning` + `breathe` need. | ❌ not implemented |
| M3 | Waterfalls & bubble columns | `findWaterfalls`/`findBubbleColumns`; `descend_waterfall`, `climb_waterfall`, `use_bubble_column`; pathfinding edges; `dig_down` prefers a nearby waterfall. | ❌ not implemented |
| M4 | Lava: avoid (cross later) | Absolute obstacle + repulsion; `move_to_safe`; lava-death marking; never mine into lava; bucket bridging (`place_water` → obsidian); Nether crossing gated behind `fire_resistance` + bridging. | ❌ not implemented |
| M5 | Buckets, boats, potions | `craft_bucket`/`craft_boat`; `fill_bucket`/`empty_bucket`/`place_water`; boat travel on open water via `mount_*`/`_rideToward`; brewing. | ❌ not implemented |
| M6 | Survival Intelligence integration | Gameplay skills in `skills/gameplay/fluids/`; progression milestones `bucket`, `water_travel`, gated `nether_cross_lava`; docs + tests. | ❌ not implemented |

## Key risks / open questions

- The exact Bedrock water movement flags and `delta` semantics are unknown until a
  packet capture of a real player swimming confirms them.
- Whether the self metadata exposes `breathing`/air or the air budget must be
  simulated (water cells + timer) is an open discovery item.
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
