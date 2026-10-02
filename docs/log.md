# Log

Append-only record of wiki operations. Prefix: `## [YYYY-MM-DD] <type> | <title>`
where `<type>` is one of `ingest`, `query`, `lint`, `doc`.

## [2026-10-02] doc | LLM-wiki scaffolded and docs translated to English

- Restructured `docs/` into an LLM wiki (manifest `llm-wiki.md`, `index.md`,
  `log.md`, `sources.md`, `raw/`, `wiki/`).
- Translated `BEDROCK.md` (repo root) and `SURVIVAL-INTELLIGENCE.md`
  (now `docs/raw/SURVIVAL-INTELLIGENCE.md`) from Italian to English.
- Moved `REPRODUCTION-REPORT.md` and `evidence/` into `docs/raw/`; moved
  `HEADLESS-CLIENT.md` into `docs/wiki/headless-client.md`.
- Added synthesis pages: `wiki/overview.md`, `wiki/survival-intelligence.md`,
  `wiki/reproduction.md`, `wiki/open-questions.md`.

## [2026-10-03] ingest | Fishing implemented (rod crafting, cast/bite/reel, water detection)

- Added `bedrock-fishing.mjs` (pure, no socket/world access): `isWaterBlock`,
  `isFishItem`/`isEdibleFish`, `fishCount`/`fishItems`, `shoreCandidates`
  (ground cells adjacent to water within `CAST_RANGE`), `nextBiteDelay` (vanilla
  5–30 s window), `FISHING_ROD_INGREDIENTS`. Unit-tested
  (`tests/bedrock-fishing.test.mjs`, 7 tests).
- Wired `bedrock-adapter.mjs`: `/observe.fishing` context, `craft_fishing_rod`
  option (reuses `craft_` → `_craftItem`), `cast_rod`/`reel_in`/`fish` options +
  actions, and the methods `_findFishingSpot`/`_findBobber`/`_fishingContext`/
  `_castRod`/`_reelIn`/`_fish`. Bite detection = bobber `y` dip (best-effort) +
  timing fallback; reel confirmation is the inventory delta.
- Full suite green (277 tests). Live verification on the BDS pending.
- Updated `wiki/fishing.md` (status → implemented), `roadmap.md` (moved fishing
  from not-implemented to live-pending), `index.md`, `sources.md`.

## [2026-10-03] doc | Fishing roadmap (rod, cast/bite/reel, water detection)

- Added `wiki/fishing.md`: roadmap for fishing — string source (spiders/cobweb),
  `craft_fishing_rod` (recipe already indexed from `crafting_data`),
  `cast_rod`/`reel_in` via `_useItemTransaction(click_air)`, water/shore
  perception (`_findWater`), and the open bite-detection problem (bobber
  metadata vs. timing fallback). Roadmaps now live in the wiki layer, not in
  `.private/`.
- Noted existing reuse: `cod`/`salmon` already in `FOOD_PRIORITY` (→ `food` tag)
  and `SMELT_RECIPES` (`cooked_cod`/`cooked_salmon` via `smoker`).
- Updated `index.md`, `roadmap.md` (not-implemented + next planned work) and
  `open-questions.md`.

## [2026-10-02] doc | Human chat command channel roadmap

- Added `wiki/human-command.md`: roadmap for a human-in-chat natural-language
  command channel (`@bot seguimi`, `@bot aiutami coi mob`).
- Analyzed the current state: chat is already received (packet `text` id 9,
  fields `source_name`/`type`/`message`/`xuid`) but unused; player positions are
  tracked but gamertags are dropped; combat is ready; autonomous exploration is
  the hard gap.
- Defined milestones M1–M5 (capture/identify → follow → NL orders → guided
  mining → ack/exploration) and open questions (trigger syntax, follow
  semantics, plan-override priority, acknowledgement).
- Cross-linked from `index.md`, `overview.md` and `open-questions.md`.

## [2026-10-03] ingest | Trading with villagers/wandering traders + levelling

- Added trader detection (`isTraderType`: villager/villager_v2/wandering_trader/
  trader_llama), `open_trade` (`item_use_on_entity` `interact`), `update_trade`
  offer parsing (NBT → buyA/buyB/sell/uses/maxUses/tier), `trade_<index>` and
  `close_trade` to `bedrock-adapter.mjs`; `/observe` now exposes `traders` and
  `trade`.
- Added `bedrock-trading.mjs` (pure economy): profession map, item value
  classification (precious/emerald/cheap/neutral) and `pickBestTrade`.
- Added autonomous trader levelling `level_<profession>`/`level_trader`: loops the
  cheapest available offer (never emeralds nor precious resources) until
  `max_trade_tier`; profession verified live via `update_trade.display_name`.
- Tests: `tests/bedrock-trading.test.mjs` (11) and `tests/bedrock-leveling.test.mjs`
  (11); full suite green (246). Live verification on the BDS pending.
- New page `wiki/trading.md`; updated `index.md`, `sources.md`, `open-questions.md`.

## [2026-10-02] doc | Human chat command channel: M1-M3 implemented

- `bedrock-adapter.mjs`: `_onChat` (`text` id 9 → `chatInbox`), `chat` in
  `observe()`, `username` capture in `_trackEntity`/`_nearbyEntities`,
  `_playerByName`, `follow_player` option + `_followPlayer` action.
- `controller.mjs`: `CHAT_ALLOWLIST`/`CHAT_PREFIX`/`CHAT_CONTROL`, `maybeHumanCommand`
  → Hermes → `/plan` with priority; `goalMet` open-ended for `plan.follow`.
- `controller-decisions.mjs`: `follow_player` ranked tier 2. `tests/*` green
  (+ `follow_player` priority case). `.env.example` documents the new vars.
- Live verification on the BDS still pending.

## [2026-10-02] doc | Bot visibility to other players (not a ghost)

- Added `headless-client.md` §1.1: the bot is a real, fully-visible player
  (player list, default skin, server-authoritative movement); "headless" only
  describes its own missing rendering, not its visibility to others.
- Updated the page's recurring-questions list and the `index.md` summary.

## [2026-10-02] doc | Control-flow page with goal → plan → action diagram

- Added `wiki/control-flow.md`: end-to-end loop (Progression Engine → System
  Two/Hermes → Skill Resolver → harness `/options` → System One/Jev → world),
  with the Survival Governor as a cross-cutting deterministic override.
- Clarified what System Two does *not* do: it is a shallow planner and never
  emits an action sequence; task decomposition is deterministic (progression
  graph + declarative skills).
- Cross-linked from `index.md`, `overview.md` and `survival-intelligence.md`.

## [2026-10-02] doc | Architecture evolution thesis (strategic replanner + subgoal + multi-branch)

- Added `wiki/architecture-evolution.md`: the four-way split (Progression /
  Hermes / harness / Jev), the rename "System Two = strategic replanner, not
  hierarchical planner", and two proposed evolutions — a first-class `subgoal`
  field with receding-horizon planning, and a multi-branch progression graph
  (copper/iron/exploration) with Hermes as branch chooser.
- Mapped "already exists vs proposed" against the code (`milestone`/`skill`
  fields, the replan loop, `resolveMilestone` single-`next` DFS).
- Cross-linked from `index.md`, `overview.md`, `control-flow.md` and
  `open-questions.md`.

## [2026-10-03] doc | Consolidated roadmap + implementation status page

- Added `wiki/roadmap.md`: reorganizes the `.private/` roadmaps/task notes
  (`ROADMAP.md`, `GOAL.md`, `JEV/DEFENSE/FARMING/STORAGE/TRADING-TASK.md`) into
  one current-status view — done/verified-live vs implemented-pending-live vs
  not-implemented — plus GOAL phases, gameplay milestones and next planned work
  (farming first).
- Marked `ROADMAP.md`/`GOAL.md` as historical (frozen 01/10, superseded by code).
- Cross-linked from `index.md`, `sources.md`, `overview.md`, `open-questions.md`.

## [2026-10-03] ingest | Farming slice: plant seeds, feed/hunt farm animals

- `bedrock-survival.mjs`: farm-animal whitelist (`cow`/`mooshroom`/`sheep`/`pig`/
  `chicken`/`rabbit`), `ANIMAL_FEED`, `SEED_TO_CROP`, crop/farmland predicates and
  farm-animal entity heights.
- `bedrock-adapter.mjs`: metadata flags `baby`/`tempted`/`inlove` + `owner_eid`;
  `/observe.farmAnimals`; `plant_<seed>` (click_block on free farmland, confirmed
  by the crop above), `feed_<animal>` (`item_use_on_entity` interact, confirmed by
  `inlove`/consumed), `attack_<animal>` (farm animals via `_entityOfType`);
  farmland/fences/crops added to `DIG_PROTECTED`.
- Tests: `tests/bedrock-farming.test.mjs` (10) + survival map assertions; suite
  257 green. Live verification on the BDS pending.
- `BEDROCK.md` action table + Farming section; `roadmap.md` status updated.

## [2026-10-03] ingest | Farming stretch: breed, tame, shear, throw_egg

- Fixed the metadata flag bits against `protocol.json` (`baby` = 11, `tamed` = 28,
  `sheared` = 31; `owner_eid` = key 5).
- `bedrock-survival.mjs`: tameable whitelist (`wolf`/`cat`/`ocelot`) + `TAME_FEED`
  (bone / raw cod).
- `bedrock-adapter.mjs`: refactored `_feedEntity` (feed a specific entity, base
  for feed/breed/tame); added `throw_egg`, `breed_<animal>`, `tame_wolf`/
  `tame_cat`, `shear_sheep`, `craft_shears`; `/observe.farmAnimals` now carries
  `sheared`; new `_nearbyTameable` census.
- Tests: `tests/bedrock-farming.test.mjs` extended (18); suite 265 green. Live
  verification on the BDS pending.

## [2026-10-03] ingest | Farming live-verified on the BDS

- Redeployed to VM 100 (`hermes-jev-bedrock`) and drove the harness HTTP API.
- ✅ `read_container` (6 chests/barrels), `mine_potatoes`/`mine_carrots` →
  `collect_drop` → `plant_potato` (re-sow, `server_world`), `throw_egg`,
  `feed_pig` (`inlove`), `breed_pig` (`babies: 1`, `baby:true`).
- ⚠️ Not tested: `attack_<animal>` (would kill a family animal), `tame_wolf`/
  `tame_cat` (no wolf/cat nearby), `shear_sheep` + `craft_shears` (no sheep).
- Note: first `feed_pig` attempt returned `feed_not_confirmed` while the pig
  wandered; a retry close-up succeeded — the action may need one retry for
  distant/wandering animals.
- `BEDROCK.md` action table and `roadmap.md` status updated.

## [2026-10-03] ingest | Companion animals: cats, wolves, parrots, mounts, axolotl, nautilus

- `bedrock-survival.mjs`: companion categories — food-tameable (`wolf`→bone,
  `cat`/`ocelot`→raw cod/salmon, `parrot`→seeds), ride-tameable
  (`horse`/`donkey`/`mule`/`llama`/`nautilus`), and `axolotl` (follows with a
  tropical-fish bucket, no tamed flag). `tameFeed` now returns a list.
- `bedrock-adapter.mjs`: parse `trusting` (flags_extended key 92 bit 1);
  `_nearbyCompanion` census + `/observe.companions`; generalized `_tameAnimal`
  (food vs ride via `_mountEntity` with an empty hand) and `_isCompanionTamed`.
- `nautilus` (recently added aquatic companion with its own armor set) is in the
  ride-tameable set; its exact taming mechanic still needs a live round.
- Tests: 270 green (`tests/bedrock-survival.test.mjs` + `bedrock-farming.test.mjs`).
- `BEDROCK.md` + `roadmap.md` updated.
- New page `wiki/companions.md` (categories, implemented taming vs missing riding,
  verification status); cross-linked from `index.md`, `overview.md`, `roadmap.md`.

## [2026-10-03] ingest | Riding as transport: boats, minecarts, mounts

- `bedrock-survival.mjs`: `isVehicleType` (boats `…_boat`/`…_chest_boat`/
  `…_raft`, minecarts `…_minecart`) + `isRideableType` (vehicles + ride-tameable).
- `bedrock-adapter.mjs`: `set_entity_link` handler → `this.riding`; handle
  `correct_player_move_prediction` `vehicle` type; `mount_<vehicle>` (empty hand
  + interact), `dismount` (`player_action` start_sneak), `_rideToward` (forward
  `player_auth_input` with `client_predicted_vehicle` flag, no local physics);
  `goto_waypoint` rides when mounted; options offer `mount_*`/`dismount`.
- Tests: `tests/bedrock-riding.test.mjs` (8); suite 285 green.
- `BEDROCK.md` + `companions.md` updated (riding wired; saddle/inventory/steering
  still open).

## [2026-10-03] doc | Verification checklist page (collaudi status)

- Added `wiki/verification.md`: the single collaudo checklist — every capability
  with status (live-verified / unit-tested / pending live / not implemented),
  how to run unit tests and a live round, and how to trigger each live collaudo.
- Cross-linked from `index.md`, `roadmap.md`, `open-questions.md`.

## [2026-10-03] lint | Roadmap status refresh (test count + riding)

- Verified the consolidated tracker `wiki/roadmap.md` against the code: every
  `.private/` task note is represented; the "not implemented" list is accurate
  (`place_torch`, `craft_*_sword`, `retreat`/`go_home`, `close_door`, `barricade`,
  armor, shield, milk, mature-crop detection, chat M5, autonomous exploration).
- Fixed stale test count (265 → 285) and added riding-as-transport to the
  implemented-pending-live list (boats/minecarts/mounts).
- No contradictions found between `roadmap.md`, `open-questions.md` and the code.

## [2026-10-02] lint | Live round blocked: bot dead + respawn stuck on BDS

- Drove the deployed harness on VM 100 (`docker exec hermes-jev-bedrock`,
  `/observe`): bot `health:0 deaths:1`, inventory `{potato:2, egg:1}`.
- `/options` → `wait` only ("Dead; respawning automatically"); container logs
  show `respawn_request` every 2.5 s with **no** `respawn` packet back from the
  server. Death→respawn (claimed verified earlier) is currently regressed.
- Root cause TBD (NetherNet session state vs BDS 1.26.52 respawn trigger).
  Documented in `wiki/open-questions.md` + `wiki/verification.md` (row 12 → ⚠️).

## [2026-10-02] query | Respawn-stuck resolved: stale NetherNet session

- Live round: stopped the bot container → BDS at 0 players → `systemctl restart
  minecraft-bedrock` (first attempt raced on the port; auto-restart brought it
  up, `/v1/join` OK) → started the container.
- Bot respawned alive (`health:20, spawned:true`, spawn point, empty inventory —
  death dropped the items). Conclusion: the stuck respawn was stale NetherNet
  session state, not a protocol bug. Updated `open-questions.md` + `verification.md`.

## [2026-10-02] query | Live trading attempt: open_trade fails on BDS 1.26.52

- After the respawn unblock, surveyed spawn: 2 `villager_v2` (~1.7 m and ~9 m),
  cat, 5 pigs, crops (potatoes/carrots/wheat/beetroots), ores (coal/iron/copper),
  logs (oak/spruce/cherry). No chests in radar.
- `/options` offered `open_trade`/`level_farmer` → `/act open_trade` failed twice
  (`trade_not_opened`). The `interact` was sent but the server answered
  `inventory_content` (`anvil_input`) instead of `update_trade`/`container_open`.
  Root cause TBD. Documented in `trading.md` + `verification.md` row 16.

## [2026-10-02] query | Trading open_trade: definitive live finding (server ignores interact)

- With `BEDROCK_PACKET_LOG=1` on the container: got a `villager_v2` at ~1.9
  blocks; `open_trade` sent `item_use_on_entity` interact 3× (logged) but the
  server sent **no** `update_trade` and **no** `container_open(trading)`.
  Approach >5 blocks also stalls (`trade_approach_failed: stuck`).
- Conclusion: `open_trade` does not work live on BDS 1.26.52; root cause needs a
  protocol-level capture (real client / gophertunnel). Documented in `trading.md`
  + `verification.md` row 16.

## [2026-10-02] ingest | Defense slice: swords, torch placement, go_home/retreat

- `bedrock-adapter.mjs`: added `craft_wooden_sword`/`craft_stone_sword` options
  (reuse `_craftItem`), `place_torch` option (reuse `_placeBlock`), and
  `go_home`/`retreat` (home = spawn at first spawn or `HOME_WAYPOINT` env JSON;
  `_goHome` reuses `_moveTo`). Dispatch wired; 6 new unit tests.
- Docs: `BEDROCK.md` action table + `roadmap.md` + `verification.md` updated
  (defense gap narrowed to `close_door`/`barricade`/armor/shield).
- Full suite green (291 tests).

## [2026-10-02] query | Defense slice live-verified: go_home works on the BDS

- Deployed the new code to VM 100 (rsync + `docker compose up -d --build`).
- `go_home` live round: set a waypoint at (115, 180), `goto_waypoint` (39 nodes),
  `/options` offered `go_home` ("Return home to {96,74,161} (25 blocks away)"),
  `/act go_home` walked back and ended ~1.9 blocks from home (`pathNodes: 35`).
- `place_torch` and `craft_*_sword` reuse the already-live-verified `place_*` /
  `craft_*` paths (option generation unit-tested); a dedicated live round is
  deferred. `BEDROCK.md` + `verification.md` updated.

## [2026-10-02] ingest | AI-player roadmap + post-goal lifecycle audit

- New raw source `docs/raw/AI_PLAYER_ROADMAP.md` (Italian) digested into a new
  wiki page `wiki/ai-player-roadmap.md`: persistent-agent north star, milestone
  0–8 table (Goal Manager, emergency, autonomy, social, world awareness,
  navigation, hierarchical planning, personality), deferred features.
- **Lifecycle audit (milestone 0) answered from the code**: the bot stays
  connected/spawned after a goal ends — `controller.mjs` is a one-shot loop
  (`break` on `GOAL MET`, then `process.exit(0)`), while `bedrock-harness.mjs`
  keeps the `BedrockAdapter` alive and reconnects on drop; no route disconnects
  the bot (only `SIGTERM`/`SIGINT`). Gap: no explicit `IDLE` state / goal queue,
  so new `@bot` orders are no longer acted on after the controller exits.
- `index.md`, `sources.md`, `wiki/roadmap.md` (post-goal lifecycle section +
  "Next planned work" item 1), `wiki/open-questions.md` (planned) updated.

## [2026-10-02] ingest | Autonomous Exploration v1 spec (GOAL_EXPLORATION)

- New raw source `docs/raw/GOAL_EXPLORATION.md` (Italian) digested into a new
  wiki page `wiki/exploration.md`: find-biome MVP (persistent mission model,
  Minecraft-ID biome targets, deterministic expanding-square/spiral planner,
  checkpoints, biome detection, structured report, HOLD_POSITION), M2 route
  replay, M3 escort, M4 search blocks/resources, M5 search structures, the
  `explore.*` skill API and the responsibility split (Hermes / Exploration
  Planner / Jev / Survival Governor).
- Status recorded as **spec only, not implemented** — matches the existing
  "no real exploration" limitation. Cross-links added from `roadmap.md` and
  `open-questions.md`; `index.md` + `sources.md` updated.

## [2026-10-02] ingest | Defense: equip_armor + close_door

- `bedrock-adapter.mjs`: `equip_armor` (take→cursor→place armor pieces into the
  `armor` container slots 0..3) and `close_door` (clicks `_openDoors` doors shut,
  clearing the set on the runtime-id change). Both offered from `/options`.
- 6 new unit tests; full suite green (297 tests).
- `BEDROCK.md` action table + `roadmap.md` + `verification.md` (rows 35-36)
  updated; defense gap now only `barricade` + armor points + shield.

## [2026-10-02] ingest | Defense complete: barricade + armor points

- `bedrock-adapter.mjs`: `_placeBlock` refactored into a reusable `_placeAtCell`
  (top-face placement at an arbitrary cell); added `barricade` (seals a 1×2
  opening with 2 blocks, feet + head) and armor tracking (`this.armor` +
  `_armorPoints`, exposed in `/observe.armor`). `equip_armor` now records the
  worn pieces. 7 new unit tests; full suite green (304).
- `BEDROCK.md` action table + `roadmap.md` + `verification.md` (rows 37-38)
  updated: defense only leaves the shield (stretch).

## [2026-10-02] ingest | Fluids roadmap (swimming, drowning, waterfalls, lava)

- New raw source `docs/raw/FLUIDS_ROADMAP.md` (Italian) digested into a new wiki
  page `wiki/fluids.md`: the bot cannot currently enter water (`_passable()`
  returns false for `water|lava`), there is no air/breathing tracking,
  `/observe.nearby` does not scan fluids, and digging only refuses a fluid cell
  at the target. The roadmap defines M0–M6: fluid awareness (`bedrock-fluids.mjs`,
  `/observe.fluids`, governor `drowning`/`lava_contact`/`lava_near`, lava
  forbidden in A*, dig adjacency check), swimming physics + air budget,
  controlled dives, waterfall descent/ascent + bubble columns, lava avoidance
  (gated crossing), buckets/boats/potions, and Survival Intelligence integration
  (skills/progression/verifier tags).
- Status recorded as **spec only, not implemented**; two protocol-discovery
  items block M1 (Bedrock water-movement `input_data`/`delta` semantics, and
  whether self metadata exposes `breathing`/air).
- Cross-links added from `roadmap.md` (not-implemented + next work),
  `open-questions.md` and `verification.md` (rows 39–43); `index.md` +
  `sources.md` updated. Private handoff: `.private/FLUIDS-TASK.md` (not committed).

## [2026-10-02] doc | Creeper defense: map the new defence actions onto intents

- Gap found: `go_home`/`retreat`/`close_door`/`barricade`/`equip_armor` were
  `unknown` intents, so the governor's emergency filter removed them — exactly
  in a creeper emergency. `survival/intents.mjs` now maps them
  (`go_home`/`retreat` → `['escape','shelter']`, `close_door`/`barricade` →
  `['shelter']`, `equip_armor` → `['heal']`, `place_torch` → `['build','shelter']`).
- `knowledge/survival-rules.json`: `creeper_immediate` now allows
  `["escape","shelter"]` (retreat/barricade stay available, melee does not).
- Tests added/updated; suite green (305). Documented in
  `wiki/survival-intelligence.md`; bow/arrow gap recorded in
  `wiki/open-questions.md`.

## [2026-10-02] ingest | Redstone roadmap (sensing, oriented placement, primitive circuits)

- New raw source `docs/raw/REDSTONE_ROADMAP.md` (Italian) digested into a new
  wiki page `wiki/redstone.md`. Findings from the code/registry: no redstone
  support today, but `bedrock-world.mjs` already decodes component state via
  `blockAt().getProperties()` (`redstone_wire.redstone_signal` 0..15,
  `lever.open_bit`, `repeater.repeater_delay` + `cardinal_direction`,
  `observer.powered_bit`, `dispenser.triggered_bit`, `piston.facing_direction`,
  ...); `DIG_PROTECTED` does **not** cover redstone; `_placeAtCell` cannot set
  orientation; `_refreshNearby`/`findBlocks` are name-only.
- Roadmap R0–R6: protect redstone + `/observe.redstone` + state-aware search;
  oriented placement (blocked on a placement packet capture); interaction/sensing;
  declarative `circuits/*.json` (`lamp_switch`, `delay_line`, `auto_lamp`,
  `auto_harvest`, `hopper_chain`, ...) with `build_circuit_<id>`; verification,
  `teardown_circuit` and guardrails; Survival Intelligence integration
  (skills/progression/verifier/tags); limits (no TNT/command blocks, lag caps).
- Status **spec only, not implemented**. Cross-links added from `roadmap.md`,
  `open-questions.md` and `verification.md` (rows 44–48); `index.md` +
  `sources.md` updated. Private handoff: `.private/REDSTONE-TASK.md` (not committed).

## [2026-10-02] query | Barricade collaudo blocked: no valid 1×2 gap at the base

- Deployed the defence slice (incl. `barricade`, `equip_armor`); bot spawned at
  home. `mine_dirt`/`mine_grass_block` gave dirt (note: a drop 3.6 blocks below
  the bot is unreachable — the known "drop below" quirk).
- Enabled `BEDROCK_DEBUG` and used `/debug/geom`: the base is an **open garden**
  (grass paths, trees, a crafting table) with a cliff/hole to the east (no floor
  at x≈93-95, z≈144-148). `_barricadeGap` never found a 1×2 opening with a solid
  floor + flanking walls, so `barricade` was never offered. Live verification
  needs a doorway/corridor or an artificial gap.
- `verification.md` row 37 + `open-questions.md` (design limitation) updated.
  `equip_armor` live round deferred (no armor in inventory).

## [2026-10-02] query | craft_wooden_sword verified live

- Chain: `mine_oak_log` ×2 (auto-pickup) → `craft_oak_planks` ×2 → `craft_stick`
  → `craft_crafting_table` → `place_crafting_table` (91,72,144) →
  `craft_wooden_sword`. Result `{ok:true, crafted:"wooden_sword", count:1}`;
  `/observe.inventory.wooden_sword = 1`. Option was offered with 2 planks + 1
  stick at the table.
- Torch chain derailed by the "drop below/on canopy" quirk (a log at y=77 was
  not picked up → no planks → no pickaxe → no coal), so `place_torch` stays
  unit-tested. `verification.md` row 32 → ✅.

## [2026-10-02] ingest | Goal-driven gameplay proposal (Goal Contract + 5 benchmarks)

- New raw source `docs/raw/GOAL_ACHIEVEMENT_MINECRAFT.txt` (Italian) digested
  into a new wiki page `wiki/goal-achievement.md`: the pipeline (User Goal →
  Goal Interpreter → Planner → Task Graph → Executor → Skills → Verifier +
  Replanner), the **Goal Contract** (`target`/`constraints`/`success`/`failure`
  → `RUNNING/SUCCESS/FAILED/BLOCKED`), the deterministic primitive skill API,
  interrupt/suspend/resume, semantic goals, and 5 progressive seed-independent
  benchmarks.
- The 5 benchmarks were mapped onto the existing progression graph: 16 logs →
  `wood`; shelter + night → `first_night`; iron pickaxe → `iron_age`/`iron_tools`;
  5 diamonds → `diamonds`; Nether portal → `enter_nether`. None is run end-to-end.
- Relationship recorded: the progression engine + gameplay skills + verifier are
  the deterministic execution half; the Goal Contract, persistent Goal Manager
  and task graph are missing (AI-player milestones 1 and 7). Flagged the
  contradiction that `goals.beat_the_dragon` is aliased only to `enter_nether`.
- Cross-links added from `roadmap.md` (benchmarks table + not-implemented + next
  work), `ai-player-roadmap.md` (milestones 1/7), `open-questions.md` and
  `verification.md`; `index.md` + `sources.md` updated.

## [2026-10-02] ingest | Nether/End roadmap + fix beat_the_dragon contradiction

- **Contradiction fixed in code**: `knowledge/progression.json` now has the full
  chain `diamonds → nether_portal → enter_nether → nether_survival →
  {piglin_barter, obtain_blaze_rods, obtain_ender_pearls} → craft_eyes_of_ender →
  find_stronghold → enter_end → beat_the_dragon`, and `goals.beat_the_dragon`
  points to the real `beat_the_dragon` milestone (no longer to `enter_nether`).
  Added 9 declarative skills in `skills/gameplay/progression/` and 6 item tags
  (`gold_ingots`, `obsidian`, `blaze_rods`, `blaze_powder`, `ender_pearls`,
  `eyes_of_ender`). Tests updated; full suite green (307).
- New raw source `docs/raw/NETHER_ROADMAP.md` (Italian) digested into a new wiki
  page `wiki/nether.md`: locate/build/light/enter a portal (reuse the base one),
  Nether survival (fire/lava), **ghast fireball dodge**, **piglin gold
  bartering**, **enderman gaze discipline**, fortress/blaze rods, stronghold/End
  and the dragon (stretch). Status: chain present, capabilities not implemented.
- Extended `wiki/goal-achievement.md` with the concrete plan to fill the missing
  agentic meta (Goal Contract wrapping `plan`, reuse the existing vocabularies,
  progression+subgoal task graph, interpreter as a Hermes artifact) and with the
  benchmark execution table (`CURRICULUM` commands + blockers).
- Cross-links from `roadmap.md`, `open-questions.md`, `verification.md`
  (rows 49–55); `index.md` + `sources.md` updated. Private handoff:
  `.private/NETHER-TASK.md` (not committed).
