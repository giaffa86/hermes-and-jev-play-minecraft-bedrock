# Verification status (collaudi)

Consolidated checklist of every capability and its verification status:
what is verified live, what is unit-tested only, and what is still pending a
live round. This is the single place to look before claiming something "works".

Legend:

- ✅ **Live-verified** — exercised on the real BDS and confirmed (server-world
  confirmation, inventory delta, flag, etc.).
- 🧪 **Unit-tested only** — packet shape + pure logic tested; no live round yet.
- ⏳ **Pending live** — implemented, needs a live round (resource/consent needed).
- ⚠️ **Regressed / broken live** — previously verified, now failing on the live BDS.
- ❌ **Not implemented**.

## How to run

```bash
# Unit tests (no server required)
node --test tests/*.test.mjs

# Live round — option A: drive the deployed harness on the Docker host via HTTP
ssh -i <ssh-key> <ssh-user>@<ip-host>
sudo docker exec hermes-jev-bedrock node -e \
  'fetch("http://127.0.0.1:3077/observe").then(r=>r.json()).then(console.log)'
# POST /act {"key":"..."} to run one action; POST /plan to set a waypoint.

# Live round — option B: local scripts (stop the container first, one bot account)
node --env-file=.env test-connect.mjs      # connection + spawn
node --env-file=.env test-movement.mjs     # pathfinding toward a waypoint
node --env-file=.env test-survival.mjs     # survival gate
node --env-file=.env test-reconnect.mjs    # 3 logins / teardown
```

> One bot account only: stop the container before a local round
> (`ssh <ssh-user>@<ip-host> 'sudo docker stop hermes-jev-bedrock'`). On
> `connecterror:9`, restart the BDS at zero players (`systemctl
> stop/start minecraft-bedrock.service`).

## Collaudi table

| # | Capability | Actions / files | Status | Live collaudo (how to trigger) | Notes |
|---|---|---|---|---|---|
| 1 | Connection + spawn | — | ✅ | `test-connect.mjs` or watch `/observe` (`spawned:true`) | Bot appears as a real player. |
| 2 | Movement + pathfinding | `goto_waypoint` | ✅ | `POST /plan {waypoint}` then `goto_waypoint`; `test-movement.mjs` | Server-authoritative + A*, doors opened. |
| 3 | Mining (dirt/stone/logs/ores) | `mine_*` | ✅ | `/act mine_stone` etc.; `test-mining.mjs` | Tool auto-selection, vanilla break times, server confirmation. |
| 4 | Drop collection | `collect_drop` (+ auto-pickup) | ⚠️ | `/act collect_drop` after a drop | `take_item_entity` confirmation. **Live 2026-10-02 (regression)**: `mine_dirt` succeeds (`destroyedEvent: true`) but `picked: []` and the following `collect_drop` returns `item_not_collected` ×4 with `inventory: {}`; the auto-pickup (`_pickupNearby`, `spawnedAt` priority) did not collect either. Mining works, the items stay on the ground → open blocker for every resource goal (see [open-questions](open-questions.md)); tracked as P2. |
| 5 | Crafting (2×2 / 3×3) | `craft_*` | ✅ | `/act craft_planks` … | `crafting_data` recipes, `item_stack_request`. |
| 6 | Placement | `place_*` | ✅ | `/act place_crafting_table` | `click_block` + world confirmation. |
| 7 | Smelting | `smelt_*` | ✅ | `/act smelt_raw_iron` (furnace + coal) | `iron_ingot` obtained live 02/10. |
| 8 | Combat vs hostiles | `attack_<mob>` | ✅ | `/act attack_zombie` with a mob nearby | Hits land; low damage without a sword. |
| 9 | Flee | `flee` | ✅ | `/act flee` with a hostile nearby | Real separation measured. |
| 10 | Sleep | `sleep` | ✅ | `/act sleep` at night near a bed | `resting` flag / night-skip. |
| 11 | Dig down/up (stairs) | `dig_down`, `dig_up` | ✅ | `/act dig_down` then `dig_up` | `DIG_PROTECTED` guards built blocks. |
| 12 | Death + respawn + loot | `recover_loot` + respawn watchdog | ✅ | die in combat, then `/act recover_loot` | `deathSite`/`recover_loot` verified earlier. **Live 2026-10-02**: the BDS ignores `player_action respawn`, so the bot stayed dead (2/2 forced deaths); a client `respawn` packet runs the handshake but does not restore health — a **server-side bug** (see [open-questions](open-questions.md)). **Mitigation live-verified**: after `RESPAWN_RECONNECT_MS` (default 25 s) still dead, the adapter closes the client; the harness reconnects and the bot spawns `health: 20` **without a BDS restart**. A clean in-place respawn (no reconnect) is still missing; state, limits and refinement in [respawn](respawn.md). |
| 13 | Eat | `eat` | ⏳ | `/act eat` with hunger < 20 and food in inventory | Unit-tested; needs the right state live. |
| 14 | Storage read | `read_container` | ✅ | `/act read_container` | 6 chests/barrels read live 03/10. |
| 15 | Storage take/deposit | `take_<item>`, `deposit_<item>` | ⏳ | `/act take_iron_ingot`, `/act deposit_diamond` | Unit-tested; take/deposit delta live pending. |
| 16 | Trading | `open_trade`, `trade_<index>`, `close_trade` | ⏳ | `/act open_trade` on a villager | **Live 02-03/10 (packet capture, `PACKET_DEBUG=1` + `GET /debug/packet-debug`)**: with a `villager_v2` at 3.1-3.6 blocks the server answers the entity interaction with **only** a player-inventory resync (`inventory_content`, 36 empty slots) — no `container_open`, no `update_trade`. Ruled out by live experiment: packet shape (validated by the 1.26.51 serializer), `legacy_request_id: 0`, the vanilla `interact { action_id: 'npc_open' }` packet (now tried first), the `item_interact` input flag in `player_auth_input`, a sleeping villager (tested at `night: true` **and** `night: false`), custom behaviour packs (server loads vanilla packs only). Open: capture from a real client on the same server, a second villager. Approach >5 blocks still stalls (`stuck`). See [trading](trading.md). |
| 17 | Trader levelling | `level_<profession>` | ⏳ | `/act level_farmer` | Cheap-only economy; live tier-up pending. |
| 18 | Follow human / chat, speak | `follow_player` (+ `@bot` M1–M3); `POST /say` + proactive greeting (M5) | ⏳ | chat `@bot seguimi` with a human online; stand within ~24 blocks and read the bot's greeting | Wiring + unit tests; live pending. |
| 19 | Plant / resow crops | `plant_<seed>` | ✅ | `/act plant_potato` on free farmland | `plant_potato` re-sowed live 03/10. |
| 20 | Feed farm animals | `feed_<animal>` | ✅ | `/act feed_pig` with carrot | `inlove` confirmed live 03/10. |
| 21 | Breed farm animals | `breed_<animal>` | ✅ | `/act breed_pig` (2 adults + 2 carrots) | Baby pig `baby:true` live 03/10. |
| 22 | Throw egg | `throw_egg` | ✅ | `/act throw_egg` with an egg | Consumed; `chick: none` live 03/10. |
| 23 | Hunt farm animals | `attack_<animal>` | ⏳ | `/act attack_pig` | **Needs user consent** (kills a family animal). |
| 24 | Tame (food) | `tame_wolf`/`tame_cat`/`tame_ocelot`/`tame_parrot` | ⏳ | `/act tame_wolf` with bone | `tamed`/`trusting`/`owner_eid`; live pending. |
| 25 | Tame (ride) | `tame_horse`/`tame_donkey`/`tame_mule`/`tame_llama`/`tame_nautilus` | ⏳ | `/act tame_horse` | Mount-until-`tamed`; live pending. |
| 26 | Shear | `shear_sheep` + `craft_shears` | ⏳ | `/act craft_shears` then `/act shear_sheep` | Needs sheep + 2 iron ingots; live pending. |
| 27 | Ride as transport | `mount_<vehicle>`, `dismount`, `goto_waypoint` (mounted) | ⏳ | place a boat → `/act mount_boat` → `/act goto_waypoint` → `/act dismount` | `set_entity_link` + `client_predicted_vehicle`; live pending. |
| 28 | Fishing | `cast_rod`, `fish`, `reel_in`, `craft_fishing_rod` | ⏳ | `/act fish` at a shore with a rod | Pure module + tests; live pending. |
| 29 | Tool durability (long ore runs) | — | 🧪 | mine many stone/ore blocks, watch `heldDurability` | Only unit-tested. |
| 30 | `CURRICULUM=first_night` end-to-end | controller + curriculum | ⏳ | run controller with `-e CURRICULUM=first_night` | Full autonomous round not run. |
| 31 | Real multiplayer (Phase 10) | — | ⏳ | join with a human player online | Both players visible; not run. |
| 32 | Swords (combat) | `craft_wooden_sword`, `craft_stone_sword` | ✅ | `/act craft_wooden_sword` at a table | **`craft_wooden_sword` verified live 02/10**: offered with 2 planks + 1 stick at the placed table → crafted (`wooden_sword: 1`). `craft_stone_sword` uses the same path (unit-tested); combat already verified. |
| 33 | Torch placement | `place_torch` | 🧪 | `/act place_torch` with a torch | Option generation unit-tested; reuse the verified `place_*` path; live pending. |
| 34 | Return home | `go_home`, `retreat` | ✅ | `/act go_home` when far from spawn | Home = spawn or `HOME_WAYPOINT`; verified live 02/10 (returned ~1.9 blocks from home). |
| 35 | Armor equip | `equip_armor` | 🧪 | `/act equip_armor` with armor in inventory | take→cursor→place into `armor` slot; unit-tested; live pending. |
| 36 | Close doors | `close_door` | 🧪 | `/act close_door` after opening a door | Clicks `_openDoors` doors closed; unit-tested; live pending. |
| 37 | Barricade a gap | `barricade` | 🧪 | `/act barricade` at a 1×2 opening | Places 2 blocks (feet+head) via top-face clicks; unit-tested. Live attempt 02/10: explored the base (open garden; a cliff/hole to the east) — no valid 1×2 gap (solid floor + flanking walls), so it was never offered. Needs a doorway/corridor (or an artificial gap). |
| 38 | Armor points in `/observe` | `observe().armor` | 🧪 | read `/observe.armor` | Pieces + computed vanilla points; unit-tested; live pending. |
| 39 | Persistent world memory | `world-memory.mjs`, `sqlite-memory.mjs` | ✅ | `read_container` → restart the container → `/observe.memory` | **Verified live 02/10**: 8 containers recorded; a container restart reloaded **9 records** (1 `home` landmark + 8 containers) from `runs/memory/world.sqlite` (SQLite+WAL); direct SQL (`json_extract`) + chunk-spatial queries work. |
| 40 | Memory producers (ores/portals/entities) | `_rememberDiscoveries` | ✅ | move across chunks → `/observe.memory.counts` | **Verified live 02/10**: recorded 2 `resource_site` (coal/iron/copper/**lapis**) and 3 `entity` (2 donkeys + 1 horse) in the deployed container. |
| 41 | World knowledge graph (nodes + edges) | `link`/`neighbors`/`traverse`/`find({relation})` | ✅ | the producers create `contains` edges → query the DB | **Verified live 02/10**: schema migrated v2→v3 (23 records); concept nodes (`resource:coal_ore/iron_ore/copper_ore/lapis_ore`) + 16 `contains` edges materialized in SQLite; FK enforced. |
| 42 | Missions + checkpoints | `createMission`/`addCheckpoint`/`missionRoute` | ✅ | `POST /mission` → act/move → `GET /mission` | **Verified live 02/10**: mission created + activated, a sparse checkpoint (biome `bamboo_jungle_hills`) added by the producer, completed (`state: found`); `has_checkpoint`/`targets` edges persisted in SQLite. |
| 42.1 | Mission goal/episodic layer | `linkMission`/`missionRelations`/`recordAction`/`missionActions` + `findPreviousMissions`/`findSuccessfulLocationsFor`/`finishMission` | ✅ | `node --test tests/memory-missions.test.mjs tests/controller-mission.test.mjs` | Goal edges separate from the world graph (`mission_relation` vs `memory_relation`); unit-tested on both backends. **Live 2026-10-02** (container on VM 100, `RUN_ID=p1-live-2`): goal from `GOAL`/`TARGETS` → mission `mission_autonomous_murgzqlh` (`source: controller`, `intent: autonomous`, rawPrompt = objective) → `seeks → resource:dirt` → **8 `action_event` rows with `data.position`/`dimension`** → close `state: cancelled`, `outcome: exhausted`, `success: false`; checkpoints (`source: travel`) + `GET /mission` route returned the closed mission. Fatal-error path fixed live: a provider error now closes the mission (`state: failed`, `failureReason: controller_error: …`) and exits non-zero instead of leaking a `running` mission (test in `tests/controller-mission.test.mjs`). |
| 42.2 | Episodic → semantic consolidation (P0) | `world-memory.mjs` (`consolidateMission`, `productivityHints`, `provenLocationsFor`), `GET /memory/hints`, `POST /memory/consolidate` | ✅ | close a resource mission → `GET /memory/hints` | **Live 2026-10-02**: the terminal mission above produced `consolidated_into resource_site_7_9` (`{"resources":["dirt"],"outcome":"failed"}`) and the hint is readable from `GET /memory/hints` and `/observe.memory.hints` (`resource: dirt, score 0, attempts 1, failures 1, found 4, sources:[mission_autonomous_murgzqlh]`). `POST /memory/consolidate` (`{limit:20}`) → `candidates 2, processed 2, consolidated 0` with `already_consolidated` for the same mission (**idempotency verified live**). 27 unit tests ×2 backends; retention policy still open. |
| 42.3 | Reachability filtering of offered actions | `bedrock-adapter.mjs` (`reachableCells`/`cellReachable`/`approachReachable`/`dropReachable`/`mineDropReachable`/`entityApproachable`), `GET /debug/reach` | ✅ | `GET /options` while drops/blocks/entities sit outside the walkable component | **Live 03/10**: with the bot boxed in, the harness stopped offering `collect_drop`, `mine_*`, `read_container`, `attack_*`, `mount_*`; `POST /act read_container` went from a **30.4 s** hang to `container_unreachable` in **19 ms**, and `collect_drop` to `no_drop_nearby`; `GET /debug/reach` returned the real 10-cell component (`x114-117, y73, z156-160`). 14 unit tests (`tests/bedrock-reachability.test.mjs`: trap geometry, entity/trader filters, fail-open, report bounds). Fails open (never filters) on a degenerate component or a truncated BFS. |
| 43 | Bed (craft + place) | `craft_bed`, `place_bed` | 🧪 | `/act craft_bed` with 3 wool + 3 planks + a table | Option + `wool` tag unit-tested; **live pending — no wool** (no chest holds wool; shearing needs shears → iron chain). |
| 44 | Travel-kit readiness | `observe().travel` | ✅ | read `/observe.travel` | **Verified live 02/10**: `missing: [food, armor, light, night, craftingTable]`, with sword/blocks/space present. |
| 45 | Exploration M1 planner | `exploration.mjs`, `POST/GET /explore` | ✅ | `POST /explore {target}` → `GET /explore` | **Verified live 02/10**: `'Trova un Cherry Grove'` → `minecraft:cherry_grove`; step `move` to the first unexplored spiral point (`{x:20,z:63}`), missions + checkpoints persisted. |
| 46 | Exploration driver | `explore.mjs` | 🧪 | `RUN_ID=exp TARGET='…' node explore.mjs` | Loops planner→`goto`; unit-tested, live run blocked (the bot was stuck on a built platform → `target_not_found`). |
| 41 | Swim / cross water | `swim_to`, `surface` | ❌ | `POST /act swim_to` … cross a river | Spec M1 in [fluids](fluids.md); `_passable` currently rejects water. Needs water physics + packet capture. |
| 42 | Drowning / breathing | `/observe.fluids.air`, `dive`, governor `drowning` | ❌ | `dive` underwater and `surface` | Spec M0/M2 in [fluids](fluids.md); air signal vs simulation open. |
| 43 | Waterfall descent / ascent | `descend_waterfall`, `climb_waterfall`, `use_bubble_column` | ❌ | descend + climb a natural waterfall | Spec M3 in [fluids](fluids.md); needs fall-safe landing. |
| 44 | Lava avoidance | `avoid_lava`, A* forbid + repulsion | ❌ | path near lava stays clear | Spec M0/M4 in [fluids](fluids.md); lava currently a wall, so never mined into. |
| 45 | Buckets / boats / potions | `craft_bucket`, `fill_bucket`, `place_water`, `mount_boat`, `brew_*` | ❌ | place water → obsidian; boat across water | Spec M4/M5 in [fluids](fluids.md). |
| 46 | Redstone sensing | `/observe.redstone`, `findBlocksByState` | ❌ | read nearby components + `redstone_signal` | Spec R0 in [redstone](redstone.md); `blockAt().getProperties()` already exposes state. |
| 47 | Oriented placement | `place_<component>`, `set_repeater_delay` | ❌ | place a repeater/piston with the expected facing | Spec R1 in [redstone](redstone.md); needs a placement packet capture. |
| 48 | Trigger components | `use_redstone` | ❌ | `lever → redstone_lamp` toggles | Spec R2 in [redstone](redstone.md); reuses the verified `click_block` path. |
| 49 | Primitive circuits | `build_circuit_<id>` | ❌ | build `lamp_switch` / `delay_line` | Spec R3 in [redstone](redstone.md); declarative blueprints. |
| 50 | Teardown / guardrails | `teardown_circuit` | ❌ | build then teardown, materials returned | Spec R4 in [redstone](redstone.md); `DIG_PROTECTED` must cover redstone. |
| 51 | Nether portal | `goto_portal`, `build_portal`, `light_portal`, `enter_portal` | ❌ | build/light a portal, enter the Nether | Spec N0/N1 in [nether](nether.md); `nether_portal` milestone exists, no action yet. |
| 52 | Nether survival | fire/lava hazard, hub | ❌ | survive the Nether | Spec N2 in [nether](nether.md); depends on [fluids](fluids.md) M0/M4. |
| 53 | Ghast dodge | `dodge_projectile` | ❌ | survive a ghast in the open | Spec N3 in [nether](nether.md); no projectile tracking yet. |
| 54 | Piglin bartering | `barter_piglin` | ❌ | gold barter + collect drops | Spec N4 in [nether](nether.md); reuses `item_use_on_entity`. |
| 55 | Enderman gaze discipline | gaze sensing / look-away | ❌ | no aggro while collecting pearls | Spec N5 in [nether](nether.md). |
| 56 | Fortress / blaze rods | `obtain_blaze_rods` | ❌ | 7 blaze rods, return alive | Spec N6 in [nether](nether.md); needs exploration + ranged combat. |
| 57 | Endgame (stronghold/End/dragon) | `find_stronghold`, `enter_end`, `beat_the_dragon` | ❌ | reach the End; dragon gated | Spec N7 in [nether](nether.md); no `bossDefeated` criterion. |
| 58 | Goal Contract | `survival/goal-contract.mjs`, `GOAL_CONTRACT`/`MAX_DEATHS`/`PRESERVE_ITEMS` | ✅ | run the controller with a contract | Slice A; 22 unit tests. **Live (2026-10-02)**: pre-loop SUCCESS (`dirt>=1`, exit 0) and FAILED (`deathsAtLeast:0`, exit 2); in-loop RUNNING with real Jev actions; `EXHAUSTED` at budget end (`MAX_STEPS=1` and `0`, exit 2). The natural in-loop SUCCESS transition was not reached because the mined dirt drops were not collected (target/height issue, unrelated), so the threshold was never met — same `evaluateContract` call as the live pre-loop cases. |
| 59 | Persistent session loop | `SESSION=on` in `controller.mjs` + `goal-manager.mjs` | ✅ | run a goal, then idle and accept a new one | **Live (2026-10-02)**: goal `g1` completed, `session_state IDLE`, process stays alive until `IDLE_TIMEOUT_MS` then exits 0; queue persisted in `runs/<RUN>/goals/world.json` (`g1 completed`); transitions `goal_start`/`goal_end` logged. Unit + integration tests (`goal-manager`, `controller-session`). |
| 60 | Idle autonomy (survival needs) | `idle-goals.mjs`, `AUTONOMY=on` | ✅ | let the bot idle at night / near a threat | **Live (2026-10-02)**: in `IDLE` the bot generated `autonomous` goals from real needs — `escape` (a zombie villager at ~9 blocks; `flee` pushed it to ~18 blocks → `isNeedResolved`) and `sleep` (bed reached; `sleep` → `night_skipped`) — each `COMPLETED` and logged (`idle_goal`, `goal_end`). Deterministic success, no LLM in the decision. Unit test `idle-goals` + integration case. |
| 61 | Cross-session resume | `RESUME` (default on with `SESSION=on`) | ✅ | leave a non-terminal goal, restart the controller | **Live (2026-10-02)**: a goal left `running` in `runs/<RUN>/goals/world.json` was suspended on startup, then re-queued and resumed from its persisted plan → `COMPLETED` (log `session_resume`, no new seed goal, no reconnect). Integration tests cover resume-on and `RESUME=off`. |
| 62 | Emergency preemption | `world-events.mjs` + `emergency-goals.mjs`, `EMERGENCY` | ✅ | die while a goal is running | A death suspends the running goal and starts an `EMERGENCY` `recover_loot` goal (priority 100, `parentGoal`), which resumes the parent when the harness clears `deathSite`. **Live (2026-10-02)**: on the BDS a console-forced death produced `EMERGENCY PLAYER_DIED: suspend g1 -> run g2`, `g2` ran `recover_loot` (cleared `deathSite`), `g2 COMPLETED` via the `plan.recover` predicate and `g1` resumed and re-planned. The live round found a real bug: a periodic replan replaced `g2`'s plan, dropping `plan.recover`; fixed (replan is skipped for `plan.need`/`plan.recover`) + regression test. Note: both deaths re-triggered the known respawn-stuck (row 12) and needed a BDS restart. See [emergency](emergency.md). |

## Still not implemented

- Milk (bucket + cow); mature-crop growth detection.
- Defense (remaining): shield (stretch).
- Riding extras: saddle equipping, mount inventory/armor, `rider_jump`,
  minecart steering, boat paddling animation.
- Axolotl capture with a bucket.
- Human chat channel M5 (ack/reply) and autonomous exploration.
- **Fluids**: swimming, drowning/breathing, waterfalls (descent/ascent), lava
  avoidance, buckets/boats/bubble columns/potions. Spec in [fluids](fluids.md)
  (rows 41–45); `_passable()` currently treats `water|lava` as walls.
- **Redstone and primitive automation**: sensing, oriented placement, switches,
  delay lines, observers/pistons, hoppers, dispensers, circuit blueprints. Spec
  in [redstone](redstone.md) (rows 46–50); no redstone support today.
- **Goal Contract** — thin slice implemented and unit-tested (row 58); the
  persistent **Goal Manager/queue** is now implemented (rows 59–60), while a
  `target`-driven `obtain_item` executor and the semantic-goal interpreter are
  still missing. Resume of a suspended goal across sessions is also still open.
- **Goal-driven benchmarks** (proposal in [goal-achievement](goal-achievement.md)):
  never run end-to-end — 16 logs (wood live, target 16 not run);
  shelter + survive a night (`first_night`, not run); iron pickaxe (iron + smelt
  live, milestone not run); 5 diamonds (not run); build + cross a Nether portal
  (`enter_nether`, not implemented).
- **Nether / End** — portal locate/build/light/enter, Nether survival (ghast
  dodge, piglin bartering, enderman gaze), fortress/blaze, stronghold and End.
  Spec in [nether](nether.md) (rows 51–57); the progression chain is in
  `knowledge/progression.json` but no capability is implemented.

## Related pages

- [roadmap](roadmap.md) — implementation status per `.private/` task.
- [open-questions](open-questions.md) — blockers and verification gaps.
- [companions](companions.md) — taming/riding companion animals.
- [headless-client](headless-client.md) — how the bot perceives/acts.
