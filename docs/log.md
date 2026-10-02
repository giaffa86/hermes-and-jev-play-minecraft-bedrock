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

## [2026-10-03] ingest | Mission goal/episodic layer over the world graph

- `world-memory.mjs`: mission records carry `rawPrompt`/`intent`/`outcome`/
  `success`; `finishMission`; goal edges `linkMission`/`unlinkMission`/
  `missionRelations`; action history `recordAction`/`missionActions`; episodic
  queries `findPreviousMissions({intent,target})` and
  `findSuccessfulLocationsFor(resource)`.
- `sqlite-memory.mjs` v4 + `memory-store.mjs`: new tables `mission_relation`
  (goal edges, separate from `memory_relation`) and `action_event`.
- Tests: `tests/memory-missions.test.mjs` (15, both backends); suite 435 green.
- `wiki/memory.md` + `verification.md` updated; controller wiring deferred.

## [2026-10-03] ingest | Controller wiring: goal → mission + action events

- `bedrock-harness.mjs`: new routes `POST /mission/link`, `POST /mission/action`,
  `POST /mission/finish` (goal edges, action history, outcome/success).
- `controller.mjs`: each goal becomes a mission (`POST /mission` with `rawPrompt`
  + `intent`), plan targets become `seeks` edges, each executed action is an
  `action_event` (`POST /mission/action`) and the goal end closes the mission
  (`POST /mission/finish`); the controller log carries `missionId` on `result`
  lines. All best-effort (a harness without `/mission` degrades gracefully).
- Tests: `tests/controller-mission.test.mjs` (2); suite 437 green.

## [2026-10-03] doc | Open tasks consolidated on the wiki

- `roadmap.md`: added the goal/episodic memory layer + controller wiring to
  "done", refreshed the test count (437), and added the episodic → semantic
  consolidation to the memory follow-ups.
- `open-questions.md`: added the goal/episodic memory bullet (done + next slice).

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

## [2026-10-02] doc | Exploration spec: travel survival kit + night survival

- Added a "Travel survival kit and adaptation" section to
  `wiki/exploration.md`: a mission can last several in-game days, so it needs a
  pre-departure kit (food, blocks, torches, sword/armor, bed or wool+wood,
  crafting table, free inventory) and night survival in order of preference —
  bed, provisional hut, pillar-up (unreliable vs flying mobs such as phantoms).
- Recorded the gaps in `wiki/open-questions.md` ("Exploration travel kit"):
  `craft_bed`/`place_bed`, travel-kit/loadout, inventory-full handling,
  pillar-up, provisional-hut skill.

## [2026-10-02] doc | Finding: no persistent memory (landmarks, chests, chunks)

- Audited persistence: the only files read at startup are static config
  (`knowledge/*.json`, `skills/gameplay/**`); no runtime state is restored.
  `this.containers` (chest cache) is a volatile in-memory Map, `home` comes from
  spawn/`HOME_WAYPOINT`, and `runs/*.jsonl` are append-only and never read back
  (`survival/experience.mjs` logs skill stats "for a future retrievable
  experience").
- Consequence: the bot cannot remember where the sheep pen or the wool chest is,
  nor the chunks it has explored.
- Recorded in `wiki/open-questions.md` ("No persistent memory") and
  `wiki/exploration.md` (current status).

## [2026-10-02] feat | Goal Contract thin slice (Slice A)

- New pure module `survival/goal-contract.mjs`: `normalizeContract`,
  `evaluateContract`, `contractFromEnv`, `hasContractConfig`,
  `CONTRACT_STATUSES`. A contract is `{goal,target,constraints,success,failure}`
  and evaluates to `RUNNING | SUCCESS | FAILED | BLOCKED` (success wins, then
  failure/constraint violation, then running; invalid/static contradictions are
  blocked). Exported through `survival/index.mjs`.
- New verifier criteria in `survival/verify.mjs`: `deathsAtLeast n` and
  `itemPreserved [item]` (compares the `before` inventory; a held item must not
  decrease). Validation + `CRITERIA_KEYS` updated.
- `controller.mjs` wiring: opt-in via `GOAL_CONTRACT` (JSON), `MAX_DEATHS`,
  `PRESERVE_ITEMS`; evaluates the contract before the loop and every step, logs
  `goal_contract` / `goal_contract_met` / `goal_contract_stop` to
  `runs/<run>/controller.jsonl` and stops on SUCCESS/FAILED/BLOCKED. No contract
  configured = previous behaviour (backward compatible).
- 18 unit tests (`tests/goal-contract.test.mjs`); full suite green (325).
- Docs: `docs/raw/SURVIVAL-INTELLIGENCE.md` (module + criteria + Goal Contract
  section), `wiki/survival-intelligence.md`, `wiki/goal-achievement.md` (G1 thin
  slice implemented), `wiki/roadmap.md`, `wiki/open-questions.md`,
  `wiki/verification.md` (row 56), `.env.example`.

## [2026-10-02] verify | Goal Contract live (Slice A)

- Overlaid the Slice A files into the running `hermes-jev-bedrock` container
  (`docker cp`, non-destructive; the running harness keeps its own code) and ran
  the controller against the live harness (`http://127.0.0.1:3077`).
- **A — pre-loop SUCCESS**: `{"goal":"smoke_ok","success":{"inventoryGte":{"dirt":1}}}`
  → `GOAL CONTRACT SUCCESS` at step 0, evidence `inventory.dirt=2`; log
  `goal_contract` + `goal_contract_stop` written.
- **B — pre-loop FAILED**: `failure:{"deathsAtLeast":0}` → `GOAL CONTRACT FAILED`
  at step 0, reasons `failure criteria met`, evidence `deaths=0`.
- **C — in-loop RUNNING (real actions)**: `success:{"inventoryGte":{"dirt":3}}`,
  `constraints.maxDeaths=1`, `CONTROLLER=jev` ran 8 steps (sleep, mine_dirt ×4,
  collect_drop ×3) and exhausted the budget. Logged `goal_contract RUNNING` at
  step 0. The inventory never reached 3 because the mined dirt drops were not
  collected (`collect_drop` → `item_not_collected`), so the natural in-loop
  SUCCESS transition was not observed. The transition uses the same
  `evaluateContract` call verified live in A.
- Operational finding: the deployed container's `JEV_MODEL=typesafe/jev-1.13`
  with `TYPESAFE_API_KEY` returns TypeSafe `400 Unknown model`; `JEV_MODEL=jev-latest`
  works. `.env.example` already documents the correct value.
- `verification.md` row 56 updated to ✅ with the caveat.

## [2026-10-02] ingest | Exploration M6 — underground targets

- Extended `docs/raw/GOAL_EXPLORATION.md` with **M6 — Ricerca sotterranea**:
  caves (`cave_air`, lush/dripstone caves), abandoned mineshafts, Deep Dark /
  Ancient City (sculk, shriekers, Warden hazard), spawners (`mob_spawner`), plus
  amethyst geodes. Heuristic detectors, hazards (warden/lava/spawner/collapse),
  3D navigation and the underground kit; acceptance criteria and new skill API
  (`explore.findCave/findMineshaft/findSpawner/findDeepDark`).
- `wiki/exploration.md` updated (M6 row, "Underground targets (M6)" section,
  skill API, status), `wiki/open-questions.md` and `index.md` cross-links.

## [2026-10-02] feat | Goal Contract: action budget → EXHAUSTED outcome

- `survival/goal-contract.mjs`: `CONTRACT_STATUSES` adds `exhausted`; new
  `contractStop(contract, obs, {stepsUsed, maxSteps})` = `evaluateContract` plus
  the action budget. While actions remain the contract is `running`; when
  `stepsUsed >= maxSteps` and no success/failure fired it becomes terminal
  `exhausted` (reason `step budget exhausted (n/m)`). Success/failure still win.
- `controller.mjs`: contract evaluated with `stepsUsed = step - 1`; the loop
  stops on `exhausted` too; a post-loop check re-reads `/observe` and closes a
  still-running contract as `exhausted` (or `success` if the last action met it).
  Exit code: `0` on success/no-contract, `2` on `FAILED`/`BLOCKED`/`EXHAUSTED`.
- Tests: +4 in `tests/goal-contract.test.mjs` (22 total). My suite green (329,
  0 fail; the 3 failures in `*memory*.test.mjs` are the concurrent session's
  uncommitted work, not mine).
- Live (2026-10-02): `MAX_STEPS=1` + impossible success → `GOAL CONTRACT
  EXHAUSTED step budget exhausted (1/1)`, log `goal_contract_stop` exhausted,
  real exit code `2`; `MAX_STEPS=0` pre-loop → exhausted, exit `2`; pre-loop
  SUCCESS → exit `0`. `docs/raw/SURVIVAL-INTELLIGENCE.md`,
  `wiki/goal-achievement.md`, `wiki/verification.md` (row 56) updated.

## [2026-10-02] feat | Persistent world memory (SQLite + abstract repository)

- New infrastructure: `world-memory.mjs` (service) over an abstract repository —
  `sqlite-memory.mjs` (**node:sqlite**, WAL, chunk index; default) and
  `memory-store.mjs` (JSON repository, fallback/tests). Same interface
  (get/upsert/find/remove/markStaleBefore/count/flush), so skills/planner never
  see the storage.
- First slice: **landmarks** (`rememberLandmark`; `home` registered at spawn) and
  **container observations** (`rememberContainer`, updated on every chest read).
  Records carry `discoveredAt`/`lastSeenAt`/`confidence` and `known/stale/invalid`
  status — memory is *historical*, not current truth.
- Wired into `bedrock-adapter.mjs` (`/observe.memory`, `_setContainerContents`) and
  `bedrock-harness.mjs` (create `MEMORY_DIR` default `runs/memory`, periodic
  WAL checkpoint, close on shutdown).
- Tests: `memory-store`, `sqlite-memory`, `world-memory` (both backends, incl.
  persistence + chunk-restricted spatial query), `adapter-memory`. Suite green (356).
- Docs: new `wiki/memory.md`; `open-questions.md`/`exploration.md`/`index.md`/
  `sources.md`/`BEDROCK.md` updated; `memory/`, `*.sqlite*` git/image-ignored.

## [2026-10-02] query | Persistent memory verified live on the BDS

- Deployed the memory slice and drove the container via HTTP: on spawn the memory
  registered the `home` landmark; `read_container` read **8 chests/barrels** and
  all were written to the memory (`container_105_72_138` chest had 122 emeralds,
  ...).
- **Restart test**: `docker restart` → boot reloaded
  `{"records":9,"landmarks":1,"containers":8}` from `runs/memory/world.sqlite`
  (SQLite + WAL). Direct SQL (`json_extract` to find the emerald chest, chunk
  spatial sort) works; schema version 2.
- `verification.md` row 39 → ✅; `wiki/memory.md` notes the live result.

## [2026-10-02] feat | Persistent session loop + Goal Manager (AI-player M0→1)

- New pure module `goal-manager.mjs`: goal `{id, type, source, priority, status,
  objective, plan, parameters, parentGoal, attempts, createdAt, startedAt,
  finishedAt, reason, result}`; sources `EMERGENCY/CHAT/WORLD_EVENT/
  PLAYER_BEHAVIOR/CURRICULUM/AUTONOMOUS` with default priorities (emergency >
  chat > curriculum > autonomous); statuses `PENDING → RUNNING → (SUSPENDED) →
  COMPLETED/FAILED` plus `CANCELLED`; at most one `RUNNING` at a time;
  `pull()` (priority then FIFO), `preempt()`, `suspend/resume`, `snapshot/
  restore`, persistence through the memory-repository interface (`kind: 'goal'`).
- `controller.mjs` refactor: the goal body is now `runGoal(goal)` returning an
  outcome instead of `process.exit`; a session loop (`main`) does
  `pull → start → runGoal → complete/fail/cancel → IDLE`. `SESSION=on` keeps the
  process alive in `IDLE`, polling `/observe` for a new goal (an in-game `@bot`
  order becomes a `chat` goal) and running it on the same connection;
  `SESSION=off` (default) preserves the historical one-shot behaviour and exit
  codes. Queue: `runs/<RUN_ID>/goals/world.json`; a `running` goal left by a
  previous run is suspended on startup; transitions logged as `session_state`/
  `goal_start`/`goal_end`. New env vars `SESSION`, `IDLE_POLL_MS`,
  `IDLE_TIMEOUT_MS`.
- Tests: `tests/goal-manager.test.mjs` (12, unit) and
  `tests/controller-session.test.mjs` (3, integration against a fake harness:
  goal → COMPLETED → IDLE with timeout; an idle `@bot` order becoming a new
  completed `chat` goal; one-shot default). Suite green (371).
- Docs: `wiki/ai-player-roadmap.md` (milestone 0→1 implemented + new section),
  `wiki/roadmap.md` (post-goal lifecycle + next planned work), `wiki/
  open-questions.md`, `sources.md`, `BEDROCK.md` (env vars + "Agent session").

## [2026-10-02] feat | Memory producers: resource sites, portals, entities

- `world-memory.mjs`: added `rememberResourceSite`/`findResources({ contains })`,
  `rememberPortal`/`findPortals` (nether-side coords, verified flag),
  `rememberEntity`/`findEntities` (keyed by `uniqueId`, `state`); `observeView`
  now exposes portals + per-kind counts; `findLandmarks` = landmark/structure/home.
- Repositories: `data` JSON now carries **all** extra fields (observations,
  nether, state, ...), not just label/tags/contents; `find` supports `kinds`.
- `bedrock-adapter.mjs`: `_rememberDiscoveries` producer (once per chunk via
  `_maybeRememberDiscoveries`): the `portal` block → portal; nearby ores
  (common from `nearbyBlocks`, rare scanned) → resource site; rideable entities
  → entity.
- Tests for both backends + the adapter producer; suite green (374).
- `wiki/memory.md` + `open-questions.md` updated.

## [2026-10-02] feat | Idle autonomy: needs-driven goals (AI-player M3 first slice)

- New pure module `idle-goals.mjs`: `deriveIdleGoals(observation, {rules})` maps
  the governor/`deriveNeeds` output to ranked candidate goals (survive, escape,
  eat, heal, sleep, shelter, obtain_food/weapon/armor, replace_tool), boosting
  emergency needs (`source: emergency`) above autonomous ones;
  `nextIdleGoal(...)` filters needs attempted within `AUTONOMY_COOLDOWN_MS`
  (anti-loop); `isNeedResolved(need, observation)` is the deterministic,
  harness-side success predicate (the need disappears from observed state).
  `continue_progression` is excluded (no resolvable state; handled by CURRICULUM).
- `controller.mjs`: new `waitForGoal` branch (requires `SESSION=on` and
  `AUTONOMY=on`): with no human order it enqueues the top-need goal as
  `autonomous`/`emergency` with a need-anchored plan (`plan.need`). `goalMet`
  short-circuits on `plan.need` via `isNeedResolved`; such goals skip replanning
  (`replan_skipped`) so the planner cannot detach them from their need. New env
  vars `AUTONOMY`, `AUTONOMY_COOLDOWN_MS`, `AUTONOMY_MAX_GOALS`; autonomous goal
  count is capped per session.
- Tests: `tests/idle-goals.test.mjs` (7 unit) + an autonomy case in
  `tests/controller-session.test.mjs` (night-without-bed → completed
  `autonomous` shelter goal). Suite green (382).
- Docs: `wiki/ai-player-roadmap.md` (M3 first slice + "Still missing"),
  `wiki/roadmap.md`, `wiki/open-questions.md`, `sources.md`, `BEDROCK.md`.

## [2026-10-02] query | Memory producers verified live

- Deployed the producers; the discovery scan dedup was purely per-chunk, so the
  first scan (often before the world was loaded) marked the chunk as done and no
  site was recorded. Moved the bot across chunks and the producers fired:
  `counts {landmark:1, resource_site:2, entity:3, container:8}`.
- Recorded live: `resource_site_7_10` / `resource_site_8_10` (`observations:
  coal_ore/iron_ore/copper_ore/lapis_ore`) and 3 `entity` (2 donkeys + 1 horse,
  keyed by `uniqueId`).
- Fix: `_maybeRememberDiscoveries` now re-scans the same chunk after
  `DISCOVERY_RESCAN_MS` (15 s), not only on chunk change. Test added.
- `verification.md` row 40 → ✅; `wiki/memory.md` notes the live result.

## [2026-10-03] lint | Wiki-lint tool, git hooks, and status reconciliation

- Added `tools/wiki-lint.mjs`: broken-link check, `raw/` → `sources.md` and
  `wiki/` → `index.md` coverage, orphan pages, `log.md` entry format,
  `open-questions.md` "Last lint" vs `log.md`, privacy gate (`.private/`, `.env`,
  `runs/`, `nmp-cache/`, `auth.json`, `memory/` must not be tracked) and a
  secret/personal-data scan (this repo is public).
- Wired the routine: `tools/hooks/pre-commit` (errors block) and
  `tools/hooks/pre-push` (`--strict`: warnings block, incl. privacy), activated
  with `git config core.hooksPath tools/hooks`; npm scripts `wiki:lint` /
  `wiki:lint:strict`. Documented in `docs/llm-wiki.md` and `AGENTS.md`.
- Reconciled stale status: `open-questions.md` said farming and fishing were
  "not started" and listed implemented defense actions as missing — aligned with
  `roadmap.md` (farming core live-verified 03/10, fishing implemented/live
  pending, defense first slice mostly live, only shield left). Added a
  "Documentation integrity" section (interleaved `log.md` dates; stale counts in
  immutable sources).
- Fixed `verification.md` duplicate row numbers (39/40 reused for fluids):
  renumbered the fluid/redstone/nether/Goal-Contract rows to 41–58 and updated
  every internal reference.
- Refreshed the current test count to **383 green unit tests** (2026-10-03) in
  `roadmap.md`, `companions.md`, `survival-intelligence.md`; updated the
  `ai-player-roadmap.md` and `companions.md` one-line summaries in `index.md`.

## [2026-10-02] feat | Chunk memory (visited/frontier, batched) + biome

- `world-memory.mjs`: exploring chunks — `markChunkVisited` (buffered),
  `flushChunks`, `isChunkVisited`, `visitedChunks`, `chunksWithBiome`,
  `unexploredFrontier` (chunks adjacent to a visited one but not visited);
  `flush()`/`close()` flush the buffer; `_kindCounts` accounts for the buffer.
- Repositories: `upsertMany` (SQLite runs it in a transaction; JSON loops);
  the JSON repo now derives `chunk` from the position like SQLite.
- `bedrock-world.mjs`: `biomeAt(pos)` → biome name (e.g. `cherry_grove`).
- `bedrock-adapter.mjs`: the discovery producer records the visited chunk with
  its biome once per chunk.
- Tests both backends + `biomeAt`; suite green (386).
- `wiki/memory.md` + `open-questions.md` updated.

## [2026-10-03] lint | Private-reference and environment-fingerprint checks

- Extended `tools/wiki-lint.mjs`: references to the private Proxmox wiki clone,
  to the host agent schema files or to the private bootstrap/stack repositories
  are now **errors**; environment fingerprints (private LAN/VPN or WAN IPs,
  private domains and DDNS names, the environment SSH username) are **warnings**,
  so the strict pre-push blocks them. The meta-docs are written without the
  literal private tokens on purpose.
- Broadened the secret scan to **every tracked text file** (not just docs):
  private keys, SSH key material/paths, `sk-`/`ts-`/GitHub/Slack/AWS/Google/
  bearer tokens, hardcoded keys, auth-cache JSON, xuid, personal emails,
  plaintext passwords, real usernames/names. Positive control verified
  (injected fake key/IP/username were caught).
- History audit: no real API token, SSH key, `.env`, `auth.json` or token cache
  was ever committed (the only env-like file in history is `.env.example` with
  empty placeholders). The historical leak is limited to the private LAN IPs,
  the environment username and links to the Proxmox wiki pages noted below.
- Current tree verified clean: no link to the Proxmox wiki, no real IP/domain,
  no account identifier. Anonymised the remaining real SSH username in
  `verification.md` (now a `<ssh-user>@<ip-host>` placeholder).
- History note: an earlier scrub commit removed the same data from the tree but
  it is still present in earlier commits already on the public fork (private LAN
  IPs, the environment username, and links to the Proxmox wiki pages) in commits
  `26417f9`, `367f175`, `1a0e3bb`, `d21aaca`, `45822aa`. Removing it from the
  published history needs a rewrite; tracked in
  [open-questions](wiki/open-questions.md).

## [2026-10-02] feat | World knowledge graph (nodes + edges) over SQLite

- `sqlite-memory.mjs` v3: `world_memory` (nodes, `category: spatial|conceptual`,
  nullable coords, `biome` column + index) and a real `memory_relation` table
  (`from_id`/`to_id`/`type`/`confidence`/`status`/timestamps + indexes, FK
  enforced). Migration v2→v3 rebuilds the node table (verified live on 23 rows).
- Repository edges API: `link`/`unlink`/`invalidateRelation`/`relationsFrom`/
  `relationsTo`/`relationCount`; `find` supports `category`, `biome` and a
  `relation: {type,target,direction}` filter. JSON repo has parity.
- `world-memory.mjs`: conceptual nodes (`rememberConcept`, `resource:*`/`biome:*`),
  `link` (auto-creates endpoints → referential integrity), `unlink`,
  `invalidateRelation`, `relationsFrom/To`, `neighbors`, `traverse`, direct
  `find({ kind, relation, nearestTo })`, and derived (never stored) `near`/
  `withinRadius`/`nearest`. Containers/sites materialize `contains` edges, and a
  re-read invalidates the items that are gone (observation ≠ relation).
- Tests both backends (graph, traverse, per-relation query, derived near);
  suite green (394).
- `wiki/memory.md` + `verification.md` row 41 updated.

## [2026-10-02] verify | Session loop + idle autonomy verified live on the BDS

- Deployed the committed controller into the `hermes` container (isolated
  `/tmp/session`, no image rebuild, no restart of `hermes-jev-bedrock`) and ran
  it against the live harness on VM 100 (bot connected, night).
- **Session loop** (`SESSION=on`, `AUTONOMY=off`): a Goal Contract satisfied at
  step 0 → `GOAL g1 COMPLETED`, then `IDLE — waiting for a new goal`, then
  `IDLE timeout (12000 ms)` and exit 0. Queue persisted in
  `runs/collaudo-session/goals/world.json` (`g1 completed`); transitions logged
  (`session_state GOAL_RUNNING → goal_start → goal_end → GOAL_COMPLETED → IDLE`).
- **Idle autonomy** (`SESSION=on`, `AUTONOMY=on`): after the seeded goal the bot
  generated, in `IDLE`, goals from real needs and closed them deterministically:
  - `g2 [escape]` — a zombie villager at ~8.5 blocks; `flee` succeeded and pushed
    it to ~18.8 blocks → `isNeedResolved('escape')` → `GOAL MET`, `COMPLETED`.
  - `g3 [sleep]` — a bed nearby; `sleep` → `{slept:'night_skipped'}` →
    `isNeedResolved('sleep')` → `GOAL MET`, `COMPLETED`.
  Final queue: `g1/g2/g3 completed` (all `autonomous`); `idle_goal` and
  `goal_end` logged.
- **Operational finding**: a *concurrent* session was driving the same harness
  (`goto_waypoint` for 36 s, `path_failed`), so the first autonomy attempt got
  `{"ok":false,"error":"busy"}` on every `/act` (adapter `busy` flag, one action
  at a time). Re-run when the adapter was free → all actions succeeded. Lesson:
  run controllers strictly one at a time against the shared bot.
- `verification.md` rows 59–60 added (✅); `wiki/ai-player-roadmap.md`,
  `wiki/roadmap.md`, `BEDROCK.md` note the live result.

## [2026-10-02] feat | Cross-session goal resume

- `controller.mjs`: at startup a goal left `running` by a previous run is
  suspended (`session restarted`), then — if `RESUME` is on — every `suspended`
  goal is re-queued as `pending` and resumed from its **persisted plan** (no
  reconnect, no LLM re-planning). A new initial goal is seeded only when nothing
  is pending, so a restart continues the previous queue instead of starting over.
  New env var `RESUME` (default: on when `SESSION=on`, off otherwise) and a
  `session_resume` log entry + `RESUME n goal(s) ...` line.
- Tests: two integration cases in `tests/controller-session.test.mjs` (a
  pre-seeded `running` goal is resumed and completed; `RESUME=off` leaves a
  suspended goal parked and seeds a fresh goal). Suite green (399).
- Docs: `wiki/ai-player-roadmap.md` (M0/M1 rows + "Still missing"), `wiki/roadmap.md`,
  `wiki/open-questions.md`, `sources.md`, `BEDROCK.md` (env var + resume bullet).

## [2026-10-02] verify | Cross-session resume verified live on the BDS

- Pre-seeded a goal left `running` by a "previous session" in
  `runs/collaudo-resume/goals/world.json` (a `chat` goal with a persisted plan
  targeting `dirt:1`), then ran the controller (`SESSION=on`, `RESUME` default).
- Result: `RESUME 1 goal(s) from a previous session: live-g1` → the goal was
  suspended on startup, re-queued and executed from its persisted plan →
  `GOAL live-g1 COMPLETED`; **no new initial goal was seeded**; store ended with
  the single resumed goal `completed`. Logs: `session_resume → session_state
  GOAL_RUNNING → goal_start → goal_end → GOAL_COMPLETED → IDLE`. Exit 0 after the
  idle timeout.
- `verification.md` row 61 added (✅ live). Cleanup of `/tmp/session` and the
  `collaudo-resume` run.

## [2026-10-02] feat | Missions + sparse checkpoints (route replay)

- `world-memory.mjs`: mission nodes (`createMission`/`updateMission`/`completeMission`/
  `failMission`/`missions`, lifecycle in `state`, linked `mission --targets--> bi:t`)
  and sparse checkpoint nodes (`addCheckpoint`, `missionCheckpoints`,
  `lastCheckpoint`, `missionRoute` with ordered checkpoints + total distance);
  graph links `has_checkpoint`/`next`.
- `bedrock-adapter.mjs`: records a checkpoint only while a mission is active and
  every ~48 blocks (`CHECKPOINT_MIN_DISTANCE`), hooked to motion end
  (`_finishMotion`) and discovery; the ore scan no longer depends on
  `nearbyBlocks` and also runs at motion end.
- `bedrock-harness.mjs`: `GET /mission`, `POST /mission`, `POST /mission/complete`.
- Tests both backends + the adapter hook; suite green (397).
- **Verified live**: mission created/activated, a sparse checkpoint recorded
  (biome `bamboo_jungle_hills`), completed (`found`); `has_checkpoint`/`targets`
  edges in SQLite. `wiki/memory.md` + `verification.md` row 42 updated.

## [2026-10-02] feat | Travel kit: craft_bed/place_bed + readiness

- `bedrock-adapter.mjs`: `craft_bed` option (3 wool + 3 planks at a table; the
  `wool` item tag now matches any colour) and `place_bed` (reuses `place_*`).
  New `_travelReadiness()` exposed in `/observe.travel`: food, sword, armor,
  blocks, light, night (bed **or** ≥3 wool), crafting table, free inventory +
  the `missing` list.
- Tests: `wool` tag matching, `craft_bed`/`place_bed` options, readiness;
  suite green (402).
- `BEDROCK.md` action table + `verification.md` (rows 43-44) + `exploration.md`
  + `open-questions.md` updated.
- **Live**: `/observe.travel` verified (`missing: [food, armor, light, night,
  craftingTable]`; `sword/blocks/space` present). `craft_bed`/`place_bed` live
  round still pending — **no wool** on the server (no chest holds wool; shears
  need the iron chain).

## [2026-10-02] feat | Emergency producers: PLAYER_DIED → recover_loot (M2 first slice)

- New pure `world-events.mjs`: transition-based `detectEvents(prev, curr)` →
  `PLAYER_DIED` (dead flag flip **or** a new death site, since a poll can miss
  the dead frame), `LOW_HEALTH`, `HOSTILE_AMBUSH`; each event carries a
  `dedupKey` so a persistent condition fires once.
- New pure `emergency-goals.mjs`: `emergencyGoalFor(event, {parentGoal, attempts,
  cooldownMs})` maps events to `EMERGENCY` goals — today `PLAYER_DIED →
  recover_loot` (priority 100, plan `{recover:true}`, loot-priority list,
  `parentGoal`) — with a cooldown/dedup map. Events without a builder (low
  health, ambush) stay with the Survival Governor.
- `controller.mjs`: inside the running goal, `runGoal` compares observations and
  on a critical event returns `{status:'preempted', emergency}`; `main` calls
  `goalManager.preempt()` (the running goal → `SUSPENDED`), enqueues the
  emergency goal, runs it on the next iteration and — via the existing
  `parentGoal` handling — resumes the parent when it completes. `goalMet` closes
  a `plan.recover` goal when the harness clears `deathSite`. New env `EMERGENCY`
  (default on with `SESSION`) and `EMERGENCY_COOLDOWN_MS`.
- Tests: `tests/world-events.test.mjs` (7), `tests/emergency-goals.test.mjs` (4),
  and `tests/controller-session.test.mjs` case 6 (death mid-goal → preempt →
  `recover_loot` → parent resumed and completed). Suite green (414).
- Docs: new `docs/wiki/emergency.md` (producer taxonomy, action-level vs
  goal-level emergency, the preemption flow diagram, boundary rule, dedup,
  status); updated `index.md`, `sources.md`, `wiki/ai-player-roadmap.md`,
  `wiki/roadmap.md`, `wiki/open-questions.md`, `wiki/verification.md` (row 62),
  `BEDROCK.md`.

## [2026-10-02] feat | Exploration M1 core (deterministic planner + driver)

- `exploration.mjs` (pure): `resolveBiomeTarget` (natural language → `minecraft:<id>`,
  aliases for cherry_grove/pale_garden/badlands/mushroom_fields/deep_dark/meadow),
  `spiralOffsets`/`nextExplorationWaypoint` (first unexplored spiral point —
  deterministic sweep), `biomeReached`, `planExplorationStep`
  (move/found/hold/exhausted), `buildExplorationReport`.
- `bedrock-harness.mjs`: `POST /explore {target}` (resolve + create/activate the
  mission) and `GET /explore` (one deterministic step; on `found` it records
  `targetPosition` + completes the mission).
- `explore.mjs`: driver — loop planner → `POST /plan` + `POST /act goto_waypoint`.
- Tests: `tests/exploration.test.mjs` (6); suite green (420).
- `wiki/exploration.md` + `verification.md` (rows 45-46) + `index.md`/`sources.md`
  updated.
- **Verified live**: `POST /explore 'Trova un Cherry Grove'` → `minecraft:cherry_grove`
  and `GET /explore` → `move` to the first unexplored spiral point; the driver
  loop runs but the bot was stuck on a built platform (`target_not_found`).

## [2026-10-02] doc | Track next activities + bot-stuck blocker

- `wiki/roadmap.md` "Next planned work" extended with items 10–12: Exploration
  (M1 core done → end-to-end then M2–M6), Memory follow-ups (structure detector,
  observation log, vector index), Travel kit (loadout/pillar-up/hut/inventory).
  "What is not implemented" updated: exploration now says M2–M6 (M1 core done).
- `wiki/open-questions.md`: new "Bot stuck on a built platform" blocker — the
  deployed bot spawned on `oak_planks`, `path_failed` everywhere and `protected_*`
  on dig; remedy = BDS restart at zero players (or move the structure).

## [2026-10-02] verify | Emergency preemption verified live on the BDS

- Started the controller on the live harness with an unsatisfied goal (`g1`,
  target `diamond:1`) and forced a death via the BDS console (`kill "<bot>"`
  through `screen -S minecraft -X stuff`, the bot being the only player — a test
  fixture, not a gameplay shortcut).
- **Result**: `EMERGENCY PLAYER_DIED: suspend g1 -> run g2` → `g2 [emergency]`
  ran `recover_loot` → `deathSite` cleared → `GOAL g2 COMPLETED` (success via the
  deterministic `plan.recover` predicate) → `g1` resumed and re-planned.
- **Real bug found and fixed**: a periodic replan replaced the emergency goal's
  plan, dropping `plan.recover`, so `g2` never closed (it kept running until the
  budget). `controller.mjs` now skips replanning for `plan.need` **and**
  `plan.recover`; a regression test asserts `replan_skipped {recover:true}` and
  was confirmed to fail without the fix.
- **Known blocker (pre-existing)**: both forced deaths re-triggered the
  respawn-stuck (server ignored `player_action respawn`); each required a BDS
  restart at zero players (verification row 12). The emergency could only
  recover after that.
- Evidence: `runs/collaudo-emergency2/controller.jsonl` (`emergency_preempt`,
  `replan_skipped {recover:true}`, `goal_end completed`, `g1` re-planned).
  Cleaned up `/tmp/session` and the collaudo runs. `verification.md` row 62 → ✅,
  row 12 updated; `wiki/emergency.md` and `wiki/ai-player-roadmap.md` updated.

## [2026-10-02] fix | Respawn stuck after death: auto-reconnect mitigation (verified live)

- Investigated the death→respawn block. Packet capture (`PACKET_DEBUG=1`, new
  env-gated diagnostic logging clientbound packet names after a death) showed the
  connection stays alive (thousands of entity packets) but the BDS **ignores**
  `player_action respawn` (13 requests, 0 `respawn` packets back). A client
  `respawn` packet (`state: 2`, CLIENT_READY) *does* make the server run the
  handshake (`SERVER_SEARCHING` 0 → `SERVER_READY` 1, spawn position) but it still
  never restores health → server-side bug, not client-fixable.
- **Mitigation**: `bedrock-adapter.mjs` watchdog — if the bot is still dead
  `RESPAWN_RECONNECT_MS` (default 25 s) after dying it closes the client; the
  harness reconnects (fresh login) and the player spawns healthy. **Live-verified**
  (twice): `kill` → `respawn_reconnect {deadMs: 25000}` → harness reconnect →
  `health: 20`, **without a BDS restart**. New env var `RESPAWN_RECONNECT_MS`;
  the packet diagnostic is gated behind `PACKET_DEBUG` (default off).
- Docs: `wiki/open-questions.md` (respawn section rewritten with the findings and
  the mitigation), `wiki/verification.md` row 12 → ✅ (mitigated), `BEDROCK.md`
  (env vars + Known issues). Tests green.

## [2026-10-02] doc | Respawn page: state, limits and refinement path

- New `docs/wiki/respawn.md`: the death→respawn flow, the stuck finding (BDS
  ignores `player_action respawn`; a client `respawn` packet runs the handshake
  but the server does not restore health), the **mitigation** (25 s watchdog →
  reconnect), its **limits** (25-40 s gap, fresh session, depends on the harness
  reconnect), and the **refinement path**: confirm with a vanilla client (relay
  capture) to decide server vs client-library bug, then try the in-place ack
  (`player_auth_input` after `SERVER_READY`, `handled_teleport`), then reduce the
  watchdog. Also records where to report: **Mojira only if a vanilla client
  reproduces** (no personal data), otherwise upstream `bedrock-protocol`.
- `index.md`, `open-questions.md` and `verification.md` (row 12) link the page.

## [2026-10-02] feat | Episodic → semantic consolidation (P0) + productivity hints read path

- `world-memory.mjs`: terminal missions are consolidated into a **productivity
  hint** on the spatial node (`productivity.<resource>` = attempts/successes/
  failures/found/confidence/contradicted/outcome/first/last/lastFailureAt/
  sources/sourcesCutoff) — a hint, not a fact (the node keeps its status).
  Anchor resolution: `targets` node → last successful action position → mission
  `targetPosition` → last checkpoint → current position (never the origin);
  chunk episodes fuse on the discovery producer's `resource_site_<cx>_<cz>` id.
  Idempotent (dedup by mission id + `sourcesCutoff` + `consolidated_into`
  relation), contradiction-aware, bounded (`maxHintSources`, `maxHintsPerNode`).
- Read path: `productivityScore`, `productivityHints`, `provenLocationsFor`,
  `observeView().hints`; harness `GET /memory/hints?resource=&limit=` and
  `POST /memory/consolidate` (backfill); the controller adds a "proven
  locations … these are hints, not facts" line to the planner prompt and now
  records `data.position` on every mission action (the anchor evidence).
- Two real bugs fixed: action events with identical `missionId|actionType|
  startedAt` overwrote each other in both repositories (`#<seq>` suffix added,
  collision loop in JSON); and auto-consolidation was skipped when
  `completedAt` landed before the outcome (now attempted on every terminal
  patch). `rememberLandmark`/`rememberResourceSite` now preserve
  `productivity` across a rescan (the discovery loop used to rebuild the record
  from a fixed field list). `addCheckpoint` stores the `label` it accepts.
- Tests: new `tests/memory-consolidation.test.mjs` (27 cases × json/sqlite) plus
  the adapter read-path test; full suite 465 pass / 0 fail. `npm run wiki:lint`
  clean.
- Docs: `wiki/memory.md` (new section + next slices), `wiki/open-questions.md`,
  `wiki/roadmap.md` (done list + next planned work), `wiki/survival-intelligence.md`
  (test count), `index.md`, this log.

## [2026-10-02] lint | Respawn refinement attempt: self-health metadata (failed)

- Tested the hypothesis that the BDS does restore health but the adapter missed
  it: `_applyEntityMetadata` ignored the self player's health (only
  `set_health`/`update_attributes` updated it). Patched it to honor self health
  from metadata and re-ran the death test → the bot still stayed `dead` and the
  watchdog fired. Reverted: the server genuinely does not restore health after
  the respawn handshake, so it is not a missing parse on our side.
- `docs/wiki/respawn.md` "Refinement path" records the failed attempt; remaining
  options are the vanilla-client capture and the in-place ack experiments.

## [2026-10-02] feat | Respawn capture tool (vanilla-client relay)

- New `tools/respawn-capture.mjs`: a ready-to-run MITM relay (`bedrock-protocol`
  `Relay`, `jsp-raknet`, no native binding) that records the death→respawn packet
  sequence of a real client. Logs `respawn`/`player_action`/`set_health`/
  `update_attributes`/`move_player`/`play_status` (+ `player_auth_input` for 6 s
  after a death) to `runs/respawn-capture.jsonl` (git-ignored) and prints a
  timeline on Ctrl+C. This is the step-1 capture of the respawn refinement
  (settle server vs client-library before filing anything).
- `docs/wiki/respawn.md` documents the tool and usage; `sources.md` lists it.
- Verified locally: the relay starts and listens on the configured port.

## [2026-10-02] verify | Goal → mission live collaudo (P1)

- **Deployment realigned** to the container `hermes-jev-bedrock` on VM 100
  (`docker cp` overlay over the baked image — a `docker restart`, never a
  recreate, preserves it; the image rebuild is the proper future deploy).
  Backup of the live DB first (`runs/memory/backup-20261002-232059/`); the
  schema migrated v3→v4 live with **no data loss** (`world_memory` 51 records
  kept, `mission_relation`/`action_event` created, `schema_version=4`).
- **Full chain observed live** (`RUN_ID=p1-live-2`): goal from `GOAL`/`TARGETS`
  → `POST /mission` (`mission_autonomous_murgzqlh`, `source: controller`,
  `intent: autonomous`, rawPrompt = objective) → `seeks → resource:dirt` →
  8 `action_event` rows carrying `data.position`/`dimension` → close
  `state: cancelled` / `outcome: exhausted` / `success: false`; checkpoints and
  `GET /mission` served the closed mission. Planning (`PLAN`, static fallback
  when Hermes is unavailable), options filtering and the survival verdict were
  logged step by step in `runs/<run>/controller.jsonl`.
- **P0 consolidation verified live** too: the terminal mission wrote
  `consolidated_into resource_site_7_9` (`{"resources":["dirt"],"outcome":"failed"}`),
  the hint is readable from `GET /memory/hints` and `/observe.memory.hints`, and
  `POST /memory/consolidate {limit:20}` answered `already_consolidated` on the
  second pass (idempotency).
- **Two live findings, both closed here.** (1) A fatal controller error left the
  mission `running` forever: `runGoal` is now wrapped, the error is logged as
  `goal_error`, the outcome becomes `failed` with `reason: controller_error: …`,
  the mission closes (`/mission/finish`, `state: failed`) and the run exits
  non-zero instead of retrying silently. Regression test `a fatal controller
  error closes the mission instead of leaking it` in
  `tests/controller-mission.test.mjs`; proven live (`p1-live-4-fatal`).
  (2) The deployed `.env` still carried the stale `JEV_MODEL=typesafe/jev-1.13`
  that makes every decision call die with TypeSafe `400 Unknown model` — removed
  (duplicate key, kept `jev-latest`; `.env` backed up). The container environment
  keeps the old value until the next recreate, so runs must pass `JEV_MODEL`.
- **Regression**: `p1-live-5` re-ran the normal path after the fix → expected
  `CANCELLED (exhausted)`, `exit=0`.
- **New live blocker found (P2)**: `mine_dirt` succeeds (`destroyedEvent: true`)
  but returns `picked: []`, and the following `collect_drop` fails with
  `item_not_collected` ×4 (`inventory: {}`) — the auto-pickup path
  (`_pickupNearby` + fresh-drop priority) collects nothing either. Mining works,
  the items stay on the ground, so every inventory goal is unreachable. This
  contradicts the earlier ✅ on `verification.md` row 4, now ⚠️
  with the evidence; tracked in `open-questions.md` as the P2
  inventory/interaction front.
- Tests: full suite **466 pass / 0 fail**; `npm run wiki:lint` clean. Docs:
  `wiki/verification.md` (rows 4, 42.1, new 42.2), `wiki/open-questions.md`,
  `wiki/roadmap.md`, this log.

## [2026-10-02] feat | Opportunity layer: valuable-ore goals (data + producer)

- **New data layer** (`ore-value.mjs`, pure): one value table for every ore/item
  drop (diamond 100, emerald 60, gold 40, lapis 30, redstone 25, iron 15, copper
  8, coal 5) and the thresholds the two consumers share — `ORE_EVENT_MIN_VALUE` 5
  (what is worth *reporting*), `ORE_OPTION_PRIORITY_MIN_VALUE` 40 (what earns the
  option-priority lift), `OPPORTUNITY_MIN_VALUE` 40,
  `OPPORTUNITY_MIN_RELATIVE_VALUE` 5, `OPPORTUNITY_STOCK_CAP` 16.
- **Detection**: the adapter scans the valuable ore names within 24 blocks (5 s
  TTL, rescan after moving 8) and exposes `observe().ores`
  (`{name, position, distance, value, harvestable}`); `world-events.mjs` raises a
  new `VALUABLE_ORE_SEEN` event per *newly seen* vein (`dedupKey`
  `ore:<name>@<x>,<y>,<z>`, transition-based like the other events).
- **Decision** (`opportunity-goals.mjs`, pure): `evaluateOpportunity` /
  `opportunityGoalFor` map the event to a **suspending** goal — new
  `GOAL_SOURCE.OPPORTUNITY`, priority 55 (between `WORLD_EVENT` 60 and
  `PLAYER_BEHAVIOR` 50), `type: mine_opportunity`, `plan.targets` = one more drop
  than already held, waypoint on the vein. Gate: gold-and-above always
  (absolute); otherwise strictly more valuable than the plan target with a
  scarcity cap (coal and copper count early — cheap ≠ worthless); never over a
  chat order, an emergency or another opportunity; not when the current goal is
  ≥ 90 % done; danger-free and within 24 blocks; 120 s cooldown on the dedup key.
- **Visibility**: the adapter offers `mine_<ore>` for a harvestable valuable ore
  outside the fixed mining list, and `controller-decisions.mjs` ranks it in a new
  tier 4.5 (gold and above), after the plan target (4) and before craft (5). The
  copper→iron case is resolved at the *goal* level (the seen iron becomes the
  plan target), not by the tier.
- Tests: `tests/opportunity-goals.test.mjs`, `tests/adapter-opportunity.test.mjs`
  and four ore cases in `tests/world-events.test.mjs`; full suite **488 pass /
  0 fail** (was 466).
- **Not wired**: `controller.mjs` is untouched (the emergency preempt path has no
  opportunity sibling yet), so an in-flight goal is still never interrupted by a
  vein; no `OPPORTUNITY*` environment switch; no live round.
- Side finding, left unfixed on purpose: `_tradeAt` in `bedrock-adapter.mjs`
  never forwards its `timeoutMs` to `_waitTradeResult`, so trades wait 5 s
  instead of 20 s — recorded in `wiki/open-questions.md`.
- Docs: new `wiki/opportunity.md`; updated `wiki/emergency.md` (producer table
  and boundary), `wiki/ai-player-roadmap.md` (milestones 1/5/8),
  `wiki/roadmap.md`, `wiki/open-questions.md`, `docs/index.md`, `docs/sources.md`.

## [2026-10-03] feat | Saluto proattivo dell'umano (Attention System §6)

- **Goal** (roadmap §6 *Attention System*, milestone 4 *Social behaviour*):
  quando il bot percepisce un umano vicino, si presenta e gli spiega la sintassi
  esatta per assegnargli un ordine (`CHAT_PREFIX`, default `@bot`), invece di
  restare muto. È il primo pezzo **deterministico** del milestone 4: gli eventi
  di attenzione (crouch/jump/stare/hit → `PLAYER_REQUESTS_ATTENTION`) restano
  aperti.
- **Percezione**: `BedrockAdapter._nearbyHumanPlayers()` → `observe().humans`
  (giocatori umani entro `HUMAN_RANGE`, default 32 blocchi, bot escluso,
  ordinati per distanza). Lista **separata** da `entities` perché quella è
  limitata a 8 righe: con otto mob addosso un umano vicino sparirebbe e non
  verrebbe mai salutato.
- **Policy pura**: `human-greeting.mjs` — `planGreetings({humans, allowlist,
  prefix, greeted, now, cooldownMs, range, template})` restituisce i messaggi da
  inviare *in questo passo*; `renderGreeting` sostituisce `{name}`/`{prefix}`.
  Solo gamertag in allowlist; allowlist vuota → nessun saluto (non si pubblicizza
  un canale che non accetta ordini).
- **Voce**: `BedrockAdapter.sendChat(message, {type='chat'})` accoda un pacchetto
  `text`/`chat` (schema 1.26.51: `category: 'authored'`, `has_filtered_message`,
  `xuid: ''`), usato da `POST /say {message, type?}`. Guardie: richiede
  `status === 'spawned'`, rimuove i ritorni a capo, rifiuta vuoto / >256 char,
  intervallo minimo 1 s tra due messaggi del bot (`CHAT_MAX_LENGTH`,
  `CHAT_MIN_INTERVAL_MS`).
- **Loop**: `controller.mjs` chiama `maybeGreetHumans(obs)` sia nel loop del goal
  sia nel loop `IDLE`, prima del check degli ordini; tenta solo se
  `obs.spawned`, e segna subito il tentativo (su errore si ritenta dopo il
  cooldown, non a ogni passo). Env: `CHAT_GREET` (default on se canale ordini
  aperto), `CHAT_GREET_RANGE`, `CHAT_GREET_COOLDOWN_MS`, `CHAT_GREET_TEMPLATE`.
- **Wire format** verificato offline: `createSerializer('1.26.51')` serializza il
  pacchetto `text` (59 byte) senza errori; nel test l'adapter lo rilegge con il
  deserializer e i campi tornano.
- Tests: nuovo `tests/human-greeting.test.mjs` (8 casi: policy + filtri
  allowlist/raggio/cooldown/umani malformati + `observe().humans` + pacchetto sul
  filo + guardie di `sendChat`); suite completa **510 pass / 0 fail** (era 502).
  `npm run wiki:lint` pulito.
- **Non wired / aperto**: nessun ack di un ordine specifico; nessun `save` dello
  stato "già salutato" tra sessioni (il cooldown vive in memoria); nessun round
  live con un umano reale. Scelta del canale (pubblico vs whisper) e salto del
  saluto in `emergency` annotati in `wiki/open-questions.md`.
- Docs: `wiki/human-command.md` (nuova sezione *Proactive greeting*, M5 da ❌ a ◑,
  tabella capacità, domande aperte), `wiki/ai-player-roadmap.md` (milestone 4),
  `wiki/verification.md` (riga 18), `docs/index.md`, `docs/sources.md`,
  `.env.example`.

## [2026-10-03] doc | Punti aperti del saluto proattivo esplicitati in wiki

- Richiesta: "segna i punti aperti sulla wiki". Registrati esplicitamente i
  cinque punti aperti del saluto proattivo, con un bullet dedicato in
  `wiki/open-questions.md` (sezione *Planned / in progress*) e la stessa lista
  estesa nella sezione *Open questions* di `wiki/human-command.md`:
  1. nessun **ack di un ordine specifico** (il bot saluta, non conferma
     "ricevuto, arrivo");
  2. **canale del saluto**: chat pubblica vs `type: whisper`;
  3. saluto **non saltato in `emergency`** (arriva mentre il bot è attaccato);
  4. **stato "già salutato" solo in memoria** (`greetedHumans` in
     `controller.mjs`): un riavvio del controller risaluta subito lo stesso
     umano, il cooldown non sopravvive al processo e non è persistito in
     `runs/<RUN_ID>/`;
  5. **nessun round live** su BDS: `POST /say` e il saluto sono coperti solo da
     unit test e dalla verifica offline del wire format (1.26.51).
- Nessuna modifica di codice; `npm run wiki:lint:strict` pulito.

## [2026-10-03] feat | Primitive di raggiungibilità: niente azioni irraggiungibili

- **Perché**: i round live P2 bruciavano decine di secondi su azioni che non
  potevano riuscire — `collect_drop` → `item_not_collected` dopo 20 s (un drop
  finito nella cavità sotto il pavimento), `read_container` →
  `container_read_failed` dopo 30 s (container in un'altra componente
  calpestabile). Sintomo unico: il planner riceveva un'offerta di azioni il cui
  esito era **strutturalmente** impossibile.
- **Cosa**: primitive di raggiungibilità in `bedrock-adapter.mjs` —
  `reachableCells({limit,ttlMs,overrides})` (BFS su `_neighbors` dalla cella del
  bot, cache 1 s invalidata dal movimento, tetto 1200 celle con flag
  `truncated`), `cellReachable`, `approachReachable(position,{range,dy})`,
  `dropReachable`, `mineDropReachable` (BFS con override di **air** sul blocco da
  minare, così la cella d'atterraggio è valutata come sarà dopo la rottura),
  `entityApproachable`, `reachReport({limit,maxCells})`. I filtri sono applicati
  dove nascono le opzioni (drop, `mine_*`, container, entità ostili/animali/
  trader/mount) e non come patch nei call-site.
- **Fail-open obbligatorio**: `_reachabilityUsable()` è falso (quindi nessun
  filtro) quando il componente ha 1 sola cella o il BFS è troncato — i mondi
  sparsi dei test e i mondi grandi restano invariati.
- **Verifica live** (container `jev-navdiag`, VM 100, :3078, codice poi deployato
  in produzione): `/options` ha smesso di offrire `collect_drop`, `mine_*`,
  `read_container`, `attack_*`, `mount_*` con il bot bloccato nella stanza;
  `read_container` → `container_unreachable` in **19 ms** (era 30 355 ms),
  `collect_drop` → `no_drop_nearby`, `flee` con destinazioni tutte fuori
  componente → `flee_failed` in 27 ms; `GET /debug/reach` ha restituito il
  componente reale di 10 celle (`x114-117, y73, z156-160`) e l'evento
  `container_unreachable` elenca i container esclusi. `trader_unreachable` /
  `no_matching_trader` per i villager fuori componente.
- **Test**: `tests/bedrock-reachability.test.mjs` (14 casi, nuovo): componente +
  tasca isolata, cache/ricalcolo al movimento, `dropReachable` nella geometria
  reale (pavimento in planks `y=72`, piedi `y=73`, cavità `y=71`, terreno `y=70`),
  `mineDropReachable` (cella senza supporto / cella sigillata), `options` senza
  `collect_drop`/`mine_stone` impossibili, `_collectDrop` → `drop_unreachable`
  con 0 move, `_readContainers` → `container_unreachable` con 0 move + rifiuto di
  `_ensureStorageOpen`, filtri entità e trader, `_flee` che ignora destinazioni
  fuori componente, fail-open su mondo degenere, limiti di `reachReport`.
  Suite completa: **502 pass / 0 fail** (all'epoca; 514 dopo il fronte trading).
- Commit `23c25c0 feat(nav): reachability primitive — filtro azioni irraggiungibili
  (drop, mine, container, entità)` (`bedrock-adapter.mjs`, `bedrock-harness.mjs`,
  `tests/bedrock-reachability.test.mjs`); rotta diagnostica `GET /debug/reach`
  gated da `BEDROCK_DEBUG`.

## [2026-10-03] verify | Trading: cattura a livello pacchetto, fix del budget di _tradeAt, ipotesi scartate

- **Difetto registrato chiuso**: `_tradeAt (index, { timeoutMs = 20000 })` non
  inoltrava il budget a `_waitTradeResult (timeoutMs = 5000)` (attesa effettiva
  5 s, warning lint "declared but never used"). Ora
  `await this._waitTradeResult(Math.max(500, started + timeoutMs - Date.now()))`;
  test dedicato che cattura il budget inoltrato (20000 → >5000, 800 → 500-800).
- **Strumenti nuovi**: `_armPacketDebug (ms = 25000)` (arma la dump clientbound
  solo con `PACKET_DEBUG=1`), chiamato da `_onOwnHealth` e **all'inizio** di
  `_openTradeWithEntity` (prima la finestra si armava solo dopo il fallimento,
  quindi la cattura non copriva l'interact); rotta `GET /debug/packet-debug?ms=…`
  (gated da `BEDROCK_DEBUG`) per armare la cattura a runtime; `_openTradeWithEntity`
  ora ritorna `attempts` e `distance` sul fallimento e logga
  `packet_debug_armed {reason:'trade_not_opened', trader, distance}`.
- **Pacchetto di apertura**: oltre a `inventory_transaction`/`item_use_on_entity`
  (mantenuto come fallback) il tentativo 1 manda il pacchetto del client vanilla
  `interact { action_id: 'npc_open', target_entity_id, has_position: false }`
  (`_npcOpen`); i tentativi 2-3 mandano anche un frame `player_auth_input` con una
  transazione `click_air` vuota (`_airUseTransaction`), che è l'unico modo di
  alzare il flag `item_interact` (InputData 34) prima della transazione
  sull'entità (in modalità server-autoritativa il commercio **non** è esprimibile
  dentro `player_auth_input`: `TransactionUseItem.action_type` ha solo
  click_block/click_air/break_block/attack).
- **Esito live (container diagnostico `jev-tradecap`, VM 100, :3078, produzione
  fermata)**: `POST /act {"key":"open_trade"}` → `{"ok":false,
  "error":"trade_not_opened","hint":"villager busy, obstructed or not a trader",
  "attempts":3,"distance":3.1}` in ~12,6 s; event log 3× `npc_open`, 2× `interact`
  + 2 `inventory_content` di resync, **nessun** `container_open`, **nessun**
  `update_trade`. Cattura con `PACKET_DEBUG=1`: nella finestra armata il server
  invia solo traffico di routine (7 050 `move_entity_delta`, 6 024
  `set_entity_data`, …, 3 `take_item_entity`) più, dopo ogni `interact`, un
  `inventory_content` con `window_id: 'inventory'` e 36 slot vuoti
  (`container_id` che prismarine etichetta `anvil_input`, etichetta non
  affidabile: enum 1.26.51 vs BDS 1.26.52) — cioè il **resync che il server manda
  quando rifiuta una transazione**.
- **Ipotesi scartate live**: forma del pacchetto (serializza pulito con lo schema
  1.26.51 ed è identica al percorso `attack_<mob>` verificato), `legacy_request_id`,
  pacchetto vanilla `npc_open`, flag `item_interact` nel frame auth, villager
  addormentato (`/observe.time` da `{ticks:23308, phase:'dawn', night:true}` a
  `{ticks:23804, phase:'day', night:false}`: stesso fallimento), behavior pack
  custom (il server carica solo pack vanilla in `/opt/minecraft`).
- **Blocco infrastrutturale attraversato**: durante i tentativi il container è
  entrato nel noto `connecterror:9` (InactivityTimeout NetherNet, backoff
  5→60 s) e non si è ripreso da solo; risolto con il rimedio dei runbook —
  riavvio del BDS a zero giocatori (`pct exec 108 -- systemctl
  stop/start minecraft-bedrock.service`, console letta dentro il CT) → il
  harness si è riconnesso da solo in ~50 s. `jev-tradecap` rimosso, produzione
  `hermes-jev-bedrock` riavviata e ri-deployata (bot spawned, `health 20`,
  `standingOn: oak_planks`, `phase: day`).
- **Test**: `tests/bedrock-trading.test.mjs` 15/15 (budget inoltrato, finestra di
  cattura solo con `PACKET_DEBUG=1`, `npc_open` + fallback + ordine
  `item_interact` prima della transazione, `serializeAll` sullo schema 1.26.51);
  rimossi gli import morti `isVehicleType`/`isCropBlock`/`isFarmlandBlock` e il
  `require('prismarine-nbt')` inutilizzato nel test. Suite completa **514 pass /
  0 fail**.
- **Stato del task**: la parte offline di `p2-trade-timeout` è chiusa; il round
  live resta aperto (il server ignora l'interazione: prossimi passi in
  `wiki/trading.md` — cattura da un client reale, secondo villager).

## [2026-10-03] verify | Curriculum `first_night`: test di scenario, due bug del controller, catena live fino a `acquire_wood`

- **Test di scenario nuovo** `tests/controller-curriculum.test.mjs` (2 casi):
  fake harness HTTP **a stadi** (una sola azione valida per stadio:
  `mine_oak_log` → `craft_crafting_table` → `hunt_cow` → `sleep`) + stub del
  binario `hermes` che pesca le decisioni da una coda (`CONTROLLER=hermes`,
  nessuna API esterna). Il test 1 asserisce l'intera catena
  `wood → crafting_table → food_and_safety → first_night`, i record `plan` con
  `notes = curriculum:<milestone>`, i `skills.jsonl`, l'assenza di
  `curriculum_fallback` e `GOAL MET after 4 actions (curriculum first_night)`.
  Il test 2 parte con i prerequisiti già soddisfatti e verifica che il motore
  risolva direttamente a `first_night` (nessuna sequenza hardcoded).
- **Due bug reali trovati dal test e corretti in `controller.mjs`**:
  1. `goalMet()` chiudeva il goal al **primo** prerequisito completato (dopo
     `skill_success` `skillRun` è `null`, quindi cadeva sul ramo target con
     `planTargets: {}`). Fix: guardia `if (CURRICULUM) return false;` dopo i rami
     `follow`/`need`/`recover` e prima del ramo target — in curriculum il goal si
     chiude solo quando il milestone finale è verificato.
  2. `planFromMilestone()` ereditava il `WAYPOINT` ambientale (knob della demo):
     live il primo passo di `first_night` partiva per `{x:380,z:16}`
     (`#1 goto_waypoint -> target_not_found`). Fix: `waypoint: null`.
- **Collaudo live (BDS 1.26.52, container `hermes-jev-bedrock`, VM 100)**:
  - run con il controller **vecchio** (rsync fallito: `rsync: [sender]
    change_dir "/root/hermes-and-jev-play-minecraft-bedrock" failed: Permission
    denied` — rsync va lanciato **dal locale**, non dentro la VM): evidenza live
    del bug del waypoint (`PLAN … {"x":380,"z":16}`, `#1 goto_waypoint ->
    target_not_found`, `#3` idem, goal exhausted);
  - run dopo il deploy (`sudo docker cp controller.mjs hermes-jev-bedrock:/app/`,
    il controller è un processo nuovo a ogni `docker exec`): `#1 sleep ->
    {"ok":true,"slept":"night_skipped","bed":{"x":116,"y":76,"z":160}}`,
    `#2/#3 mine_oak_log ok` → **la stanza non è un blocker assoluto**: il bot
    dorme e raggiunge i tronchi sopra la stanza;
  - run `MAX_STEPS=12` (`RUN_ID=p3-curriculum-live-3`): `#5 mine_oak_log ok`,
    **`SKILL acquire_wood SUCCESS {"inventory.logs":8}`** dopo 5 azioni (39,9 s:
    mining + `collect_drop`, inventario reale `{oak_log: 8, rabbit_foot: 2,
    torch: 1}`), `REPLAN curriculum Craft a crafting table…` (il motore avanza da
    solo al milestone successivo) e `#6 flee` (zombie_villager_v2 a 11,7 blocchi)
    seguito da `REPLAN periodic … [skill acquire_crafting_table]`: la prelazione
    d'emergenza **non perde il milestone**.
- **Limiti residui**: il milestone finale (`first_night`) non è ancora chiuso live
  (servono cibo e una notte reale dopo il crafting; il budget di 12 passi si
  esaurisce su `acquire_crafting_table`); il test reale multiplayer resta
  impossibile in questa sessione (nessun player umano collegato). Suite: 516
  test verdi.
