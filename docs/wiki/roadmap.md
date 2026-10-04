# Roadmap and implementation status

Consolidated view of the port's roadmaps and task notes, with the current
implementation status. This page reorganizes the private handoff documents in
`.private/` (which stay immutable raw sources) into one current-status picture:
what is **done and verified live**, what is **implemented but not yet verified
live**, and what is **not implemented**.

Sources: `.private/ROADMAP.md`, `.private/GOAL.md`, `.private/JEV-TASK.md`,
`.private/DEFENSE-TASK.md`, `.private/FARMING-TASK.md`, `.private/STORAGE-TASK.md`,
`.private/TRADING-TASK.md`, `.private/MINING-20261001.md`, `BEDROCK.md`
(action status + Known issues), `docs/wiki/*`.

> The `.private/*.md` notes are **historical**: `ROADMAP.md` and `GOAL.md` are
> frozen at 2026-10-01 and are now superseded by the code; this page is the
> current-state authority going forward. `BEDROCK.md` remains the operational
> runbook for per-action detail.

## Apiculture follow-up (04/10)

[Bees and honeycomb](bees.md) are implemented and offline-tested after the
campaign close-out: hive/smoke sensing, `harvest_honeycomb`, `harvest_honey`,
`feed_bee`, `breed_bee`, and recipe-driven beehive/honeycomb-block/honey-block/candle
crafting. Full suite: **1150/1150**, including 24 bee tests. The feature is on an
isolated branch, not deployed or live-verified; the bot stays OFF. The historical
campaign snapshot and its six declared validation gaps remain as recorded.

## Legend

- ✅ **Done** — implemented and verified live on the real BDS (or via unit tests where no live signal is obtainable).
- ⚠️ **Implemented, live verification pending** — code + unit tests exist, no live round yet.
- ◑ **Partially implemented** — some pieces done, some missing.
- ❌ **Not implemented**.

## Roadmap artifacts → current status

| `.private/` artifact | What it is | Status | Where the work landed |
|---|---|---|---|
| `ROADMAP.md` | Original port roadmap (division of labour + technical milestones) | ✅ done, superseded (frozen 01/10) | `BEDROCK.md`, `bedrock-adapter.mjs` |
| `GOAL.md` | Original goal + launch runbook (Phases 1–10, two gameplay milestones) | ◑ Phases 1–9 done; Phase 10 (real multiplayer) open; `first_night` chain verified live end-to-end (03/10) | `BEDROCK.md`, `survival/` |
| `JEV-TASK.md` | Jev decision quality + evaluation with new actions | ✅ implemented; live eval scenarios open | `controller-decisions.mjs`, `tests/controller-decisions.test.mjs` |
| `DEFENSE-TASK.md` | Defense strategies (torch/lighting, weapons, shelter, armor, shield) | ◑ partial — `attack_*`, `flee`, `sleep`, `craft_torch`, `recover_loot`, **`place_torch`, `craft_wooden_sword`/`craft_stone_sword`, `go_home`/`retreat`, `equip_armor`, `close_door`, `barricade`, armor points in `/observe`** (02/10), **`craft_shield`, `equip_shield`, `raise_shield`/`lower_shield`** (03/10, offline + live gate evidence) | `bedrock-adapter.mjs` |
| `FARMING-TASK.md` | Farming (plant/resow crops, passive animals, feed/breed/tame/shear) | ◑ mostly done — `plant_<seed>`, `feed_<animal>`, `attack_<animal>`, `throw_egg`, `breed_<animal>`, `tame_<companion>` (wolf/cat/ocelot/parrot + ride horse/donkey/mule/llama/nautilus), `shear_sheep` + `craft_shears`, `craft_bucket` + `milk_<animal>` (03/10, offline-tested) implemented; `plant`/`feed`/`breed`/`throw_egg` + `read_container` **verified live 03/10**; `attack`/`tame`/`shear`/`milk` live pending; axolotl in census (not tameable), mature-crop detection implemented 03/10 (`harvest_<crop>`, live state verified, end-to-end harvest blocked by the cage) | `bedrock-adapter.mjs`, `bedrock-survival.mjs` |
| `STORAGE-TASK.md` | Chest/barrel storage: read, take, deposit | ◑ partial — `read_container` **verified live 03/10** (6 chests/barrels); `take_<item>`/`deposit_<item>` still live pending | `bedrock-adapter.mjs` (`read_container`, `take_<item>`, `deposit_<item>`) |
| `TRADING-TASK.md` | Villager/wandering-trader trade + levelling | ⚠️ implemented, live verification pending | `bedrock-adapter.mjs` + `bedrock-trading.mjs`; see [trading](trading.md) |
| `MINING-20261001.md` | Mining collaudo report | ✅ superseded (ore/durability live) | `BEDROCK.md` (Minerals and durability phase) |
| `INCIDENTS.md` | Operational incidents + anti-damage rules | ✅ rules absorbed into `AGENTS.md` | `AGENTS.md` (Operational safety rules) |
| `BRANCH-FEAT-DROP-PICKUP-NOTE.md` | `feat/drop-pickup` branch analysis + manual port | ✅ done (committed `3bca6b0`) | `bedrock-adapter.mjs` auto-pickup |

## Goal phases (from `.private/GOAL.md`)

| Phase | Status | Notes |
|---|---|---|
| 1 — understand original architecture | ✅ | |
| 2 — evaluate Bedrock client libraries | ✅ | `bedrock-protocol@3.60.1` + `nethernet`/Werift |
| 3 — connectivity smoke test | ✅ | spawn as real player, verified |
| 4 — preserve harness contract | ✅ | `/observe` `/options` `/act` `/plan` |
| 5 — port bounded actions | ✅ | see `BEDROCK.md` action status |
| 6 — navigation | ✅ | server-authoritative movement + A*, doors |
| 7 — inventory and crafting | ✅ | planks/sticks/table/pickaxes, smelting |
| 8 — combat and survival state | ✅ basic | `attack_*`, `flee`, `eat` (eat not live) |
| 9 — Hermes + Jev integration | ✅ | end-to-end loop verified |
| 10 — real multiplayer test | ⚠️ | not yet run with a human online |

## Gameplay milestones

| Milestone | Status |
|---|---|
| First: wood → wooden pickaxe → stone → stone pickaxe | ✅ live (`runs/e2e-stone6`, `GOAL MET after 33 actions`) |
| Second: food, coal/iron, smelt, iron tools | ◑ coal + iron + smelt (`iron_ingot`) live; `eat` live pending; `CURRICULUM=first_night` verified live end-to-end (03/10) |

### Goal-driven gameplay benchmarks (proposal)

[`raw/GOAL_ACHIEVEMENT_MINECRAFT.txt`](../raw/GOAL_ACHIEVEMENT_MINECRAFT.txt) proposes
goal-driven agentic gameplay with an explicit **Goal Contract**
(`target`/`constraints`/`success`/`failure` → `RUNNING/SUCCESS/FAILED/BLOCKED`),
a task graph over deterministic primitives, and 5 seed-independent benchmarks.
They map onto the existing progression graph but are not run end-to-end:

| Benchmark | Existing milestone | Status |
|---|---|---|
| 16 logs | `wood` (`logs: 8`) | ✅ wood live; target 16 not run |
| shelter + survive one night | `first_night` + `emergency_shelter` | ✅ live (03/10): `CURRICULUM=first_night` MET — `obtain_food` then `first_night` (`sawNight:true`, health 20) via the base bed, `GOAL MET after 25 actions` |
| iron pickaxe | `iron_age` / `iron_tools` | ◑ iron + smelt live; milestone not run |
| 5 diamonds | `diamonds` (`diamonds: 1`) | ❌ not run |
| build + cross a Nether portal | `enter_nether` | ❌ not implemented; chain added (`nether_portal`) |

The proposal's Goal Contract / persistent Goal Manager layer is missing; the
deterministic execution half (progression + gameplay skills + verifier) already
exists. Synthesis and gaps (incl. `beat_the_dragon` aliased only to
`enter_nether`) in [goal-achievement](goal-achievement.md).

## What is done and verified live

- Connectivity + spawn as a real separate player.
- Server-authoritative movement + A* pathfinding (doors opened along the way).
- Mining (dirt/stone/logs/crops/coal/iron/copper), tool auto-selection, vanilla
  break times, drop collection + auto-pickup.
- Crafting (2×2 / 3×3), placement, smelting chain `raw_iron → iron_ingot`.
- Survival: `attack_*`, `flee`, `sleep`, `dig_up`/`dig_down` (protected),
  death/respawn, `recover_loot` (+XP).
- Robust controller + Jev decision quality (`controller-decisions.mjs`):
  survival priorities, anti-loop, option cap, diagnostics.
- Survival Intelligence Layer (governor, declarative skills, verifier,
  progression) — see [survival-intelligence](survival-intelligence.md).
- Human chat command channel M1–M5 (capture/identify/follow/NL orders, greeting,
  order ack + outcome — live-verified) — see [human-command](human-command.md).
- Trading + levelling code path (unit-tested) — see [trading](trading.md).
- Farming core **verified live on 03/10**: `read_container` (6 chests/barrels),
  `mine_<crop>` → `collect_drop` → `plant_potato` (re-sow, `server_world`),
  `throw_egg`, `feed_pig` (`inlove`), `breed_pig` (`babies: 1`).
- **Mature-crop detection** (03/10): `harvest_<crop>` replaces `mine_<crop>` for
  ripe plants (`growth` 0..7 / `age` 0..3, `mature: null` = fail-open) and
  replants the seed; live `/observe.nearby` shows real growth values, the
  end-to-end harvest is blocked by the cage (only fields at z ≈ 188).
- **Goal/episodic memory layer** (03/10): missions carry `rawPrompt`/`intent`/
  `outcome`/`success`; goal edges `mission_relation` (separate from the world
  graph's `memory_relation`); `action_event` history; episodic queries
  `findPreviousMissions`/`findSuccessfulLocationsFor`. **Wired into the
  controller**: each goal becomes a mission, plan targets become `seeks` edges,
  each action is an `action_event`, the goal end closes the mission with
  outcome/success (best-effort). **Live-verified 02/10** (full chain on the
  deployed container, see [verification](verification.md) row 42.1) — see
  [memory](memory.md).
- **Episodic → semantic consolidation** (02/10): terminal missions write a
  bounded, idempotent **productivity hint** (`productivity.<resource>` with
  attempts/successes/found/confidence/contradicted/sources) on their spatial
  node, anchored to the targets node, the last successful action position, the
  mission `targetPosition`, the last checkpoint or the current position (never
  the origin); chunk episodes fuse on the discovery producer's
  `resource_site_<cx>_<cz>` id. Read path: `GET /memory/hints`,
  `POST /memory/consolidate` (backfill), `/observe.memory.hints` and a
  "proven locations … these are hints, not facts" line in the planner prompt.
  Unit-tested (27 cases × json/sqlite + the adapter read-path test) and
  **live-verified 02/10** (`consolidated_into resource_site_7_9`, hint read back
  from `GET /memory/hints`, `POST /memory/consolidate` → `already_consolidated`)
  — see [memory](memory.md).
- 488 green unit tests (2026-10-02).

## What is implemented but not verified live

- Riding as transport (`mount_<vehicle>`, `dismount`, `_rideToward` for
  boats/minecarts/mounts) — see [companions](companions.md).

- `eat` (needs hunger < 20 and food in inventory).
- Storage: `take_<item>`, `deposit_<item>` (`read_container` is verified live).
- Trading: `open_trade`, `trade_<index>`, `close_trade`,
  `level_<profession>`/`level_trader` (final trade transaction + tier-up
  detection).
- `follow_player` and the chat command channel M1–M3 (wiring + unit tests done);
  greeting + `POST /say` (M5, wiring + unit tests done).
- Farming still live-pending: `attack_<animal>` (skipped, would kill a family
  animal), `tame_<companion>` (no wolf/cat/parrot/horse nearby), `shear_sheep` +
  `craft_shears` (no sheep nearby).
- Tool durability over many blocks / long ore runs (unit-tested only).
- Fishing: `craft_fishing_rod`, `cast_rod`, `reel_in`, `fish` (pure module
  `bedrock-fishing.mjs` + 13 tests; bite detection rewritten 03/10: the server's
  `fish_hook_hook` event first, the dip vs the bobber's settled height as
  fallback; live round pending) — see
  [fishing](fishing.md).
- Defense (first slice, 02/10): `place_torch`, `craft_wooden_sword` /
  `craft_stone_sword`, `go_home` / `retreat` (home = spawn or `HOME_WAYPOINT`),
  `equip_armor` (+ `/observe.armor` points), `close_door`, `barricade`.
  Implemented + unit-tested; `go_home` verified live, the rest live-pending.
- Opportunity goals (02/10): the adapter notices a valuable vein (24-block scan →
  `observe().ores` → `VALUABLE_ORE_SEEN`), `opportunity-goals.mjs` decides
  whether it is worth a detour (relative value, scarcity cap, no chat order, no
  nearly-finished goal) and the `mine_<ore>` option carries tier 4.5. All
  unit-tested; **the controller wiring is not done yet**, so nothing suspends a
  goal on a sighting — see [opportunity](opportunity.md).
- The real-multiplayer test (Phase 10): the `CURRICULUM=first_night` live round
  is done (food + night, 03/10).

## Post-goal lifecycle (milestone 0→1 of the AI-player roadmap)

- **Implemented (2026-10-02)**: the controller is now a **persistent session
  loop** with an explicit `IDLE` state (`SESSION=on`) and a **Goal Manager**
  (`goal-manager.mjs`). When a goal ends it is not `process.exit(0)`-ed: the
  outcome is recorded, the loop enters `IDLE` and keeps polling `/observe` for a
  new goal (an in-game `@bot` order becomes a `chat` goal), then runs it on the
  same harness connection. The queue is persisted in
  `runs/<RUN_ID>/goals/world.json` and a `running` goal left by a previous run
  is suspended on startup. `SESSION=off` (default) preserves the one-shot loop.
  Unit + integration tests: `tests/goal-manager.test.mjs`,
  `tests/controller-session.test.mjs`. **Verified live on the BDS (2026-10-02)**:
  a completed goal → `IDLE` → persisted queue, and (with `AUTONOMY=on`) idle
  goals generated from real needs (`escape` resolved by `flee`, `sleep` verified
  by the harness) and closed deterministically.
- **Still missing**: the remaining needs-driven goals (inventory-full → store,
  else explore) and the loot-priority executor / fluid-dependent events.
  Cross-session **resume**, the first autonomy slice (survival-need goals in
  `IDLE`, opt-in `AUTONOMY=on`) and the first **emergency producer**
  (`PLAYER_DIED → recover_loot`) are implemented — see
  [ai-player-roadmap](ai-player-roadmap.md) and [emergency](emergency.md).

## What is not implemented

- Farming leftovers (`.private/FARMING-TASK.md`): the live milk round (code done
  03/10: `craft_bucket` + `milk_<animal>`, live gate evidence only — no
  cow/bucket/iron, cage).
- Defense leftovers: the shield's live equipping round (code done 03/10:
  `craft_shield`, `equip_shield`, `raise_shield`/`lower_shield`; live gates hold
  — see [verification](verification.md) row 19.3).
- Human chat command M5 leftovers (a **human** sender on the BDS) and
  autonomous exploration **M2–M6** (M1 core implemented — see
  [exploration](exploration.md)).
- **Fluids** — swimming, drowning/breathing, waterfalls (descent/ascent), lava
  avoidance, buckets/boats/bubble columns/potions. Roadmap (M0–M6) in
  [fluids](fluids.md) / [`raw/FLUIDS_ROADMAP.md`](../raw/FLUIDS_ROADMAP.md);
  **M0 (fluid awareness) + M1 partial (wading + simulated air budget) + M2
  (Water Breathing detection and the dive/work budget) + M3 (waterfalls and bubble
  columns) + M4 (lava: shores, destroyed loot, crossing gate) + M5 (buckets,
  boats, brewing gate, lava bridge) + M6 (fluid skills, milestones, spatial
  criteria) implemented,
  unit-tested and collaudato live 03/10** (`/observe.fluids`
  census, hazard ladder, `avoid_lava`, dig-neighbour refusal, lava repulsion in
  `_standable`, `airSource` with the simulated `AirMeter`; `/observe.dive` with the
  descent/work/ascent budget and `_underwaterWorkAllowed` gating
  `_mineBlock`/`_collectDrop`; `/observe.waterfall` with the column detection and
  the typed verdicts behind `descend_waterfall`/`climb_waterfall`/
  `use_bubble_column`; `/observe.lava` with the death verdict, the water-preferring
  shore plan, the gap measurement and the crossing gate behind `move_to_safe`/
  `cross_lava`). Deep water is still a wall (`_passable` rejects
  `water|lava`) and the swimming motion/`surface`/`swim_to` remain unimplemented
  because their Bedrock flags need a packet capture of a real player swimming, so
  M3's column **actions** are refused with `swimming_unavailable` for now.
- **Redstone and primitive automation** — switches, delay lines, observers/
  pistons, hoppers, dispensers. Roadmap (R0–R6) in [redstone](redstone.md) /
  [`raw/REDSTONE_ROADMAP.md`](../raw/REDSTONE_ROADMAP.md); **R0 (awareness and
  protection) implemented, unit-tested and collaudato live 03/10**
  (`bedrock-redstone.mjs` vocabulary + `powerOf`/`facingOf`, component list in
  `DIG_PROTECTED`, `_redstoneCensus`/`GET /observe.redstone`,
  `findBlocksByState`); **R1 (oriented placement + repeater delay) implemented and
  unit-tested 03/10** (`place_<component>` via `_placeOriented` place → read →
  correct, `set_repeater_delay[_n]`); **R2 (interaction + sensing) implemented and
  unit-tested, live-sensed 03/10** (`use_redstone` toggle → verify the input *and*
  the downstream outputs → restore, `sense_redstone`, in-place cache on
  `update_block`, `blockPoweredAt`/`circuitActive`); **R3 (declarative circuits)
  implemented, unit-tested and live-refused 03/10** (`circuits/*.json` blueprints
  validated at load, `planCircuit`/`circuitSiteBlocked`/`checkCircuitSuccess` pure,
  `build_circuit_<id>` places in order, sets the repeater delays, triggers,
  verifies and restores, `GET /observe.circuits`, `runs/<run>/circuits.jsonl`) —
  the packet capture the roadmap predicted
  was **not** needed, the state is read back from the world instead. Building and
  using circuits is R3-done, and **R4** (measured delay, placed-block ledger,
  `teardown_circuit`, rollback of a half-built site) is done as well: the timing
  is now read from the bot's own redstone trace instead of being declared. **R5**
  closes the loop with the game itself: the three milestones
  (`redstone_ore` → `redstone_basics` → `redstone_automation`, alias `redstone`)
  and the six declarative skills make circuits *reachable* from the progression,
  the new `circuitBuilt` criterion verifies a build instead of an inventory, and
  the materials bridge turns "missing 1 lever" into the option `craft_lever`
  when the bot can actually craft it. **R6** is the safety milestone: the
  forbidden blocks (TNT, traps, command blocks, barriers, bedrock, crystals, lava)
  are refused twice — at blueprint validation and right inside `_placeAtCell`,
  before the inventory is touched — `DIG_PROTECTED` covers the unbreakable
  administrivia, `MAX_CIRCUIT_COMPONENTS`/`MIN_CLOCK_TICKS`/
  `REDSTONE_TOGGLE_MIN_INTERVAL_MS` cap lag, `circuitSafety` keeps the bot out of
  its own site and out of a piston path, and `GET /observe.circuits.limits`
  publishes the numbers; the live probes (`forbidden_block` on TNT/command
  block/respawn anchor with the world unchanged, control probe on a torch) were run
  03/10 on a diagnostic container. The
  full live build round is still blocked from three sides: mining
  the only cobblestone in reach edits the base, the room's drops fall into the
  cavity under its floor (`reachable: false`), and a `redstone_lamp` needs
  glowstone from the Nether.
- **Goal Contract** — thin slice implemented (`survival/goal-contract.mjs`,
  opt-in via `GOAL_CONTRACT`/`MAX_DEATHS`/`PRESERVE_ITEMS`; status logged). Still
  missing: the persistent Goal Manager/queue, a `target`-driven `obtain_item`
  executor and the semantic-goal interpreter. Proposal in
  [goal-achievement](goal-achievement.md) /
  [`raw/GOAL_ACHIEVEMENT_MINECRAFT.txt`](../raw/GOAL_ACHIEVEMENT_MINECRAFT.txt).
- **Nether / End** — **N0 (awareness + hazards), N1 (portal reach/build/light/
  enter), N2 (nether survival: non-flammable hub, dimension-aware fall,
  hazardous landings), N3 (dodging an incoming projectile sideways, never into
  lava), N4 (bartering with a piglin, never hitting one), N5 (gaze
  discipline, pumpkin mask, torso aim, pearls), N6 (fortress detection,
  blaze hunt with cover, blaze rods) and N7 (eyes of ender, stronghold
  triangulation, frame filling, End portal, real boss verdict) implemented and
  unit-tested; N0
  live-checked 03/10, N1–N7 live only for the typed refusals**: the
  portal/fire/magma/spawner census (`GET /observe.portals`), projectile tracking
  (`projectileThreat`/`projectileIncoming`/`projectileVelocity`), gaze sensing
  (`gazedAtEnderman` now separating `aimingAtEyes` from `gazed`),
  `waterEvaporates`/`bedsExplode`, seven governor rules, the four portal actions
  (`goto_portal`, `build_portal`, `light_portal`, `enter_portal`) with pure frame
  geometry, the survival primitives (`landingHazard`/`maxFallDepth`/
  `isFlammableBlock`/`pickHubBlock`/`shellCells`/`netherHubPlan`, shared shell
  geometry with `build_hut`, `build_nether_hub` remembered as `home`), the
  fireball dodge (`perpendicularDirs`/`breaksLine`/`dodgeCandidates`, action
  `dodge_projectile`), the bartering chain (`barterTarget`/`piglinNeutral`/gold
  vocabulary, `_equipItemInHotbar` shared with feeding, action `barter_piglin`
  verified by a fresh drop, piglins removed from the attack vocabulary) and the
  gaze discipline (`endermanAimPoint`/`aimsAtEndermanEyes`/`isPumpkinMask`,
  `avoid_enderman_gaze`, `equip_pumpkin`, torso aim in `_combat`, `pearls` in the
  view), the blaze hunt (`nether_fortress` detector in `dimension: nether`,
  `lineBlocked`/`coverCandidates`/`blazeTactics`, action `hunt_blaze` that takes
  cover before shooting and refuses to duel while on fire), and the endgame chain
  (`frameHasEye`/`frameStatus` for the twelve frames, `eyeCraftPlan`,
  `eyeReading`/`triangulateStronghold` with every refusal, `bossVerdict` from the
  server's `boss_event` bar cycle, actions `craft_blaze_powder`,
  `craft_ender_eye`, `throw_eye_of_ender`, `find_stronghold`, `fill_end_portal`,
  `enter_end_portal`). Still missing: the
  live happy paths (the base has no obsidian, no ghast, no piglin, no enderman,
  no blaze and no `end_portal_frame`) and the dragon fight (the `bossDefeated`
  criterion exists now; `beat_the_dragon` stays `success: null`). Roadmap in
  [nether](nether.md) / [`raw/NETHER_ROADMAP.md`](../raw/NETHER_ROADMAP.md). The
  progression chain (incl. the fixed `beat_the_dragon`) is already in
  `knowledge/progression.json`.

## Open cross-cutting issues

- NetherNet instability + `connecterror:9` (only a BDS restart at zero players
  clears it) — see [open-questions](open-questions.md).
- No real exploration (strip mining / caves), no shelter building, no nether
  portal — see [open-questions](open-questions.md); the exploration spec is in
  [exploration](exploration.md).

## Next planned work

**Campaign close-out, 04/10:** the bot remains OFF by default. The immediate
queued work is transport/entity lifecycle, bounded live rounds and remembered
storage revalidation; see [promoted tasks](open-questions.md#promoted-follow-up-tasks-2026-10-04)
for acceptance criteria. The older backlog below describes longer-term work,
not instructions to restart the campaign. Shield is code ready but lacks
materials for live validation; the full crafting chain is deferred. Riding,
companion, trade, social and fishing remain declared live-only gaps in the
[final report](final-report.md).

1. **Goal Manager producers** (AI-player roadmap milestone 2+): the session
   loop, the goal queue, the first autonomy slice (survival-need goals in
   `IDLE`, `idle-goals.mjs`, opt-in `AUTONOMY=on`) and the first emergency
   producer (`PLAYER_DIED → recover_loot`, [emergency](emergency.md)) exist.
   Next: inventory-full → store / else-explore autonomy, and promoting the
   `LOW_HEALTH`/`HOSTILE_AMBUSH` events — see
   [ai-player-roadmap](ai-player-roadmap.md).
2. **Live-verify the farming actions** on the BDS (`plant_<seed>`/`feed_`/
   `attack_<animal>`/`throw_egg`/`breed_*`/`tame_*`/`shear_sheep`), then the
   live round of milk (code done 03/10).
3. Live verification of the other ⚠️ items (storage, trading, `eat`, chat
   channel).
4. Defense completions (torch placement, swords, shelter); the
   `CURRICULUM=first_night` live round is complete (food + night survived,
   03/10) and the chain is offline-verified by
   `tests/controller-curriculum.test.mjs`.
5. Live-verify fishing: `craft_fishing_rod` → `cast_rod`/`reel_in` (or a single
   `fish`), `food` tag integration — see [fishing](fishing.md). Bite detection is
   offline-verified since 03/10 (`fish_hook_hook` + dip fallback); the live round
   still has to confirm the bobber entity name and that the server really sends
   the event.
6. **Fluids** (spec in [fluids](fluids.md)): **M0 + M1 partial + M2 + M3 + M4 + M5 + M6 done** (03/10 —
   fluid awareness: `/observe.fluids`, hazard ladder, `avoid_lava`, dig
   adjacency, lava repulsion; live round documented in [verification](verification.md)
   rows 47/47.1). M1's wading (shallow water traversal at `WADE_SPEED_FACTOR`)
   and the **simulated** air budget (`bedrock-air.mjs`, `airSource`) are done;
   M2 adds the real **Water Breathing** detection (turtle helmet + `mob_effect`
   effects with tick→second countdown) and the dive decision
   (`bedrock-dive.mjs`: descent/work/ascent against the air minus a 3 s reserve),
   which gates `_mineBlock` and `_collectDrop` under water and releases the
   `drowning` rule while breathing; M3 adds `bedrock-waterfall.mjs` (waterfall and
   bubble-column detection with a landing verdict, `columnTactic` as the single
   decision, the `onWaterfall` governor condition and the `ride_waterfall` rule)
   plus the `dig_down` preference for a usable waterfall — its live round could
   only observe the refusals (`no_column`: the only water in reach is a 2-high
   pool), and the pathfinding column edges are deliberately **not** there because a
   descent into water the bot cannot leave would be a trap. M4 adds
   `bedrock-lava.mjs` (the death verdict on a burnt loot site, the shore plan that
   prefers water, the gap measurement and the crossing gate) with `move_to_safe`
   and `cross_lava`: the bot now refuses to chase loot destroyed by lava and will
   not cross a lava gap without fire resistance and a bridge — the bridge build
   itself is M5/M6, so the action stops at `bridge_not_implemented` with the plan
   in hand. Its live round could only observe the refusals (`not_in_danger`,
   `no_lava_ahead`: the room's lava sits 15.4 blocks below the floor). The underwater refusal
   is unit-tested only:
   the swimming motion (`surface`/`swim_to`, water A* nodes, buoyancy/`delta`
   flags) stays unimplemented because it needs a packet capture of a real player
   swimming, which requires a human on the BDS during a run. The remaining fluid
   milestones are therefore parked with a documented blocker; the next
   macro-area is **Redstone R0** (below), a deviation to record in the final
   report.
7. **Redstone** (R0+R1+R2+R3+R4+R5+R6 done 03/10, spec in [redstone](redstone.md)): R0 (protect
   redstone in `DIG_PROTECTED`, `/observe.redstone`, state-aware search) is
   implemented, unit-tested and collaudato live (see [verification](verification.md)
   row 47.2); **R1** oriented placement + repeater delay is implemented and
   unit-tested (row 47.3) — place → read → correct, no packet capture needed;
   **R2** interaction + sensing is implemented, unit-tested and live-sensed
   (row 47.4); **R3** declarative circuits (`circuits/*.json` + `circuits.mjs` +
   `build_circuit_<id>` + `runs/<run>/circuits.jsonl`) is implemented,
   unit-tested and live-refused (row 47.5: catalogue, gating and typed refusals
   on the BDS); **R4** (the verifier *measures* the delay from the block-update
   trace, a ledger of the blocks the bot placed, `teardown_circuit` limited to
   them, rollback of a half-built site) is implemented and unit-tested (row
   47.6). **R5** (6 declarative skills, the 3 chained milestones + alias
   `redstone`, the `circuitBuilt` criterion, the materials bridge
   `craft_<item>`) is implemented and unit-tested (row 47.7) and live-resolved
   on the BDS; it shares the live blocker of R1/R2/R3/R4: no component is
   obtainable in the base room without editing the base (cobblestone = the room's
   own wall), the drops land in the cavity under its floor, and a
   `redstone_lamp` needs glowstone. **R6** (limits, safety rules and the
   runbook: no command blocks, no TNT/traps, lag and size caps, bot safety) is
   implemented, unit-tested and live-probed (row 47.8): the forbidden blocks are
   refused both at load time and inside `_placeAtCell`, the lag caps and the
   toggle rate limit are declared and published by `/observe.circuits.limits`,
   and `circuitSafety` keeps the bot out of its own site and out of a piston path.
   The redstone macro-area is therefore **complete as specified (R0–R6)**; what is
   missing is a *live build* of a full circuit, which needs the base-edits question
   to be answered (m01403) or materials imported from outside the room.
8. **Goal Contract** (proposal in [goal-achievement](goal-achievement.md)):
   schema + status machine over the existing progression graph, then the 5
   progressive benchmarks (16 logs → shelter+night → iron pickaxe → 5 diamonds
   → Nether portal) as `CURRICULUM` goals run end-to-end. Depends on the
   AI-player Goal Manager (milestone 1).
9. **Nether / End** (spec in [nether](nether.md)): N0 done (portal/fire/magma/
   spawner census, projectile + gaze sensing, governor rules), N1 done (portal
   reach/build/light/enter), N2 done (nether survival: non-flammable hub,
   dimension-aware fall, hazardous landings), N3 done (dodge an incoming
   projectile sideways, never into lava), N4 done (bartering with a piglin,
   never hitting one), N5 done (gaze discipline, pumpkin mask, torso aim,
   pearls) and N6 done (fortress detector + blaze hunt with cover and rods), all
   unit-tested and live-checked for the refusals; N7 is done too (eyes of ender,
   stronghold triangulation, frame filling, End portal entry, real `bossDefeated`
   criterion), also live-checked for the refusals — the dragon **fight** is the
   remaining piece.
10. **Exploration** (spec in [exploration](exploration.md)): M1 core, M2
    (route replay) and M4 (observable targets) are implemented and live-exercised
    (`exploration.mjs` target resolution + spiral planner + report + replay +
    block/entity search, `POST/GET /explore`, `POST/GET /explore/replay`,
    `POST/GET /explore/find`, drivers `explore.mjs` / `explore-replay.mjs` /
    `explore-find.mjs`, missions + sparse checkpoints in the
    [world memory](memory.md)). M4 (block/entity search) and M5/M6 (structure and
    cavity detector, `GET /observe.structures`, `find_structure` searches) are
    done and live-verified (a real village at (113,73,156), the cavity at
    (112,71,144)). Next: run M1 end-to-end on the BDS once the bot can travel
    (today the spiral waypoint is 96 blocks away and unreachable; M4, M2 and the
    detector work from where the bot stands), then M3 (escort, blocked: no human
    player on the BDS) and the deep side of M6 (following a cave system beyond
    the loaded radius; the Deep Dark rule has never been observed live).
11. **Memory follow-ups** (see [memory](memory.md)): ~~a **structure detector**
    (villages / Ancient Cities → `structure:*` nodes)~~ **done** (03/10:
    `structures.mjs` + `surveyBlocks`, M5/M6), ~~an explicit **observation log**~~
    **done** (03/10: `subject/predicate/object` + confidence/observedAt/source,
    schema v5, `POST /memory/materialize` idempotent, `GET /memory/observations`;
    the graph is a projection of the log), ~~a **vector index** for semantic
    recall~~ **done** (03/10: `vector-index.mjs` — a *derived* index over the
    current records with a TTL cache, `GET /memory/search` / `POST /memory/reindex`,
    comparative proof in `tests/memory-semantic.test.mjs`; SQLite stays the truth).
    What is left: the **observation log** is bounded too now (03/10:
    `observationDedupeMs` stops the census from re-appending an unchanged reading,
    `pruneObservations` / `POST /memory/observations/prune` drop the superseded
    evidence — live 5654 -> 131 rows with the projection unchanged, and flat
    afterwards; the graph, missions and hints have `pruneEpisodic` /
    `POST /memory/prune`, dry-run by default, only consolidated terminal
    missions), and turning a
    **semantic hit into a real waypoint** *is* wired (03/10: `reachable=1` on
    `GET /memory/search` -> `placeCandidate` -> `applySemanticWaypoint`, with
    `reachability_unknown` treated as "not confirmed"; the live round shows the
    refusal because the bot's walkable component is one cell — see
    [open questions](open-questions.md)). **Planner-side recall is wired**
    (03/10: the controller queries `GET /memory/search` before every plan with a
    goal-derived query and injects the hits as hints — fail-open,
    `tests/controller-recall.test.mjs`). The graph, producers,
    chunk memory, missions, the goal/episodic controller wiring and the
    **episodic → semantic consolidation** (productivity hints on the target node)
    are implemented and unit-tested.
12. **Travel kit** (spec in
    [exploration](exploration.md#travel-survival-kit-and-adaptation-multi-day-expeditions)):
    `craft_bed`/`place_bed` + `/observe.travel` readiness, and the missing
    actions — **`travel_kit`** loadout, **`pillar_up`** and **`build_hut`** — are
    implemented and unit-tested (`tests/bedrock-travel-kit.test.mjs`, 20 cases)
    and were exercised live on 03/10/2026 (`travel_kit` crafted sword + table,
    `pillar_up` → typed `no_headroom` with the room two blocks tall, `build_hut`
    placed one wall and reported `hut_incomplete` on the furniture supports).
    Remaining: **inventory-full** handling, and the environmental residuals
    (armor/bed need wool and leather, pillar-up and a full hut need headroom and
    a free ring), plus the `craft_bed` live round gated by wool (no chest holds
    wool; shears need the iron chain).

> **Blocker (2026-10-02)**: the deployed bot got stuck on a built platform
> (`standingOn: oak_planks`; `path_failed` everywhere, `dig_up`/`dig_down`
> `protected_*`). Live movement/exploration rounds need a **BDS restart at zero
> players** (the bot respawns at the world spawn) or a human to move the
> structure.

## Related pages

- [overview](overview.md) — project split and components.
- [control-flow](control-flow.md) — goal → plan → single action.
- [human-command](human-command.md) — chat command roadmap M1–M5.
- [trading](trading.md) — villager trade + levelling.
- [companions](companions.md) — taming/riding companion animals.
- [verification](verification.md) — collaudo checklist (status per capability).
- [open-questions](open-questions.md) — blockers and verification gaps.
- [ai-player-roadmap](ai-player-roadmap.md) — persistent-autonomous-agent roadmap and the post-goal lifecycle audit.
- [exploration](exploration.md) — autonomous-exploration spec (find biome/block/structure).
- [fluids](fluids.md) — swimming/drowning/breathing, waterfalls, lava avoidance, buckets/boats/potions.
- [redstone](redstone.md) — redstone sensing/placement and primitive circuit automation.
- [goal-achievement](goal-achievement.md) — Goal Contract, task graph, semantic goals, 5 progressive benchmarks.
- [nether](nether.md) — Nether/End survival, ghasts, piglins, endermen, portals.

  see below), N5 is done too (gaze discipline and pumpkin mask), and N7 completes the
  chain (eyes of ender, stronghold, frames, End portal, boss verdict); the dragon
  fight is what is still missing.
