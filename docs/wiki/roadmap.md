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

## Legend

- ✅ **Done** — implemented and verified live on the real BDS (or via unit tests where no live signal is obtainable).
- ⚠️ **Implemented, live verification pending** — code + unit tests exist, no live round yet.
- ◑ **Partially implemented** — some pieces done, some missing.
- ❌ **Not implemented**.

## Roadmap artifacts → current status

| `.private/` artifact | What it is | Status | Where the work landed |
|---|---|---|---|
| `ROADMAP.md` | Original port roadmap (division of labour + technical milestones) | ✅ done, superseded (frozen 01/10) | `BEDROCK.md`, `bedrock-adapter.mjs` |
| `GOAL.md` | Original goal + launch runbook (Phases 1–10, two gameplay milestones) | ◑ Phases 1–9 done; Phase 10 (real multiplayer) and a full `first_night` run open | `BEDROCK.md`, `survival/` |
| `JEV-TASK.md` | Jev decision quality + evaluation with new actions | ✅ implemented; live eval scenarios open | `controller-decisions.mjs`, `tests/controller-decisions.test.mjs` |
| `DEFENSE-TASK.md` | Defense strategies (torch/lighting, weapons, shelter, armor, shield) | ◑ partial — `attack_*`, `flee`, `sleep`, `craft_torch`, `recover_loot`, **`place_torch`, `craft_wooden_sword`/`craft_stone_sword`, `go_home`/`retreat`, `equip_armor`, `close_door`, `barricade`, armor points in `/observe`** (02/10); only the shield (stretch) remains | `bedrock-adapter.mjs` |
| `FARMING-TASK.md` | Farming (plant/resow crops, passive animals, feed/breed/tame/shear) | ◑ mostly done — `plant_<seed>`, `feed_<animal>`, `attack_<animal>`, `throw_egg`, `breed_<animal>`, `tame_<companion>` (wolf/cat/ocelot/parrot + ride horse/donkey/mule/llama/nautilus), `shear_sheep` + `craft_shears` implemented; `plant`/`feed`/`breed`/`throw_egg` + `read_container` **verified live 03/10**; `attack`/`tame`/`shear` live pending; axolotl in census (not tameable), milk + mature-crop detection still open | `bedrock-adapter.mjs`, `bedrock-survival.mjs` |
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
| Second: food, coal/iron, smelt, iron tools | ◑ coal + iron + smelt (`iron_ingot`) live; `eat` live pending; full `CURRICULUM=first_night` run not executed |

### Goal-driven gameplay benchmarks (proposal)

[`raw/GOAL_ACHIEVEMENT_MINECRAFT.txt`](../raw/GOAL_ACHIEVEMENT_MINECRAFT.txt) proposes
goal-driven agentic gameplay with an explicit **Goal Contract**
(`target`/`constraints`/`success`/`failure` → `RUNNING/SUCCESS/FAILED/BLOCKED`),
a task graph over deterministic primitives, and 5 seed-independent benchmarks.
They map onto the existing progression graph but are not run end-to-end:

| Benchmark | Existing milestone | Status |
|---|---|---|
| 16 logs | `wood` (`logs: 8`) | ✅ wood live; target 16 not run |
| shelter + survive one night | `first_night` + `emergency_shelter` | ◑ skill exists; full run not executed |
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
- Human chat command channel M1–M3 (capture/identify/follow/NL orders) —
  see [human-command](human-command.md).
- Trading + levelling code path (unit-tested) — see [trading](trading.md).
- Farming core **verified live on 03/10**: `read_container` (6 chests/barrels),
  `mine_<crop>` → `collect_drop` → `plant_potato` (re-sow, `server_world`),
  `throw_egg`, `feed_pig` (`inlove`), `breed_pig` (`babies: 1`).
- 285 green unit tests.

## What is implemented but not verified live

- Riding as transport (`mount_<vehicle>`, `dismount`, `_rideToward` for
  boats/minecarts/mounts) — see [companions](companions.md).

- `eat` (needs hunger < 20 and food in inventory).
- Storage: `take_<item>`, `deposit_<item>` (`read_container` is verified live).
- Trading: `open_trade`, `trade_<index>`, `close_trade`,
  `level_<profession>`/`level_trader` (final trade transaction + tier-up
  detection).
- `follow_player` and the chat command channel M1–M3 (wiring + unit tests done).
- Farming still live-pending: `attack_<animal>` (skipped, would kill a family
  animal), `tame_<companion>` (no wolf/cat/parrot/horse nearby), `shear_sheep` +
  `craft_shears` (no sheep nearby).
- Tool durability over many blocks / long ore runs (unit-tested only).
- Fishing: `craft_fishing_rod`, `cast_rod`, `reel_in`, `fish` (pure module
  `bedrock-fishing.mjs` + unit tests; no live round yet) — see
  [fishing](fishing.md).
- Defense (first slice, 02/10): `place_torch`, `craft_wooden_sword` /
  `craft_stone_sword`, `go_home` / `retreat` (home = spawn or `HOME_WAYPOINT`),
  `equip_armor` (+ `/observe.armor` points), `close_door`, `barricade`.
  Implemented + unit-tested; `go_home` verified live, the rest live-pending.
- A live `CURRICULUM=first_night` round and the real-multiplayer test (Phase 10).

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
  `tests/controller-session.test.mjs`.
- **Still missing**: resume of a suspended goal across sessions, the remaining
  needs-driven goals (inventory-full → store, else explore), and world-event/
  emergency producers that preempt a *running* goal. The first autonomy slice
  (survival-need goals in `IDLE`, opt-in `AUTONOMY=on`) is implemented — see
  [ai-player-roadmap](ai-player-roadmap.md).

## What is not implemented

- Farming leftovers (`.private/FARMING-TASK.md`): milk (bucket + cow) and
  mature-crop growth detection.
- Defense gaps (remaining): shield (stretch).
- Human chat command M5 (ack/reply in chat) and autonomous exploration
  (spec in [exploration](exploration.md)).
- **Fluids** — swimming, drowning/breathing, waterfalls (descent/ascent), lava
  avoidance, buckets/boats/bubble columns/potions. Roadmap (M0–M6) in
  [fluids](fluids.md) / [`raw/FLUIDS_ROADMAP.md`](../raw/FLUIDS_ROADMAP.md);
  fluids are currently walls (`_passable` rejects `water|lava`).
- **Redstone and primitive automation** — switches, delay lines, observers/
  pistons, hoppers, dispensers. Roadmap (R0–R6) in [redstone](redstone.md) /
  [`raw/REDSTONE_ROADMAP.md`](../raw/REDSTONE_ROADMAP.md); no redstone support
  today, but the world model already exposes component `getProperties()` state.
- **Goal Contract** — thin slice implemented (`survival/goal-contract.mjs`,
  opt-in via `GOAL_CONTRACT`/`MAX_DEATHS`/`PRESERVE_ITEMS`; status logged). Still
  missing: the persistent Goal Manager/queue, a `target`-driven `obtain_item`
  executor and the semantic-goal interpreter. Proposal in
  [goal-achievement](goal-achievement.md) /
  [`raw/GOAL_ACHIEVEMENT_MINECRAFT.txt`](../raw/GOAL_ACHIEVEMENT_MINECRAFT.txt).
- **Nether / End** — `enter_nether` has no portal action; no fire/lava hazard,
  no ghast projectile dodge, no piglin bartering, no enderman gaze discipline,
  no fortress/stronghold/End actions, no `bossDefeated` verifier. Roadmap in
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

1. **Goal Manager producers** (AI-player roadmap milestone 2+): the session
   loop, the goal queue and the first autonomy slice (survival-need goals in
   `IDLE`, `idle-goals.mjs`, opt-in `AUTONOMY=on`) exist. Next: inventory-full →
   store / else-explore autonomy, and world-event/emergency goals that preempt a
   running goal — see [ai-player-roadmap](ai-player-roadmap.md).
2. **Live-verify the farming actions** on the BDS (`plant_<seed>`/`feed_`/
   `attack_<animal>`/`throw_egg`/`breed_*`/`tame_*`/`shear_sheep`), then milk +
   mature-crop detection.
3. Live verification of the other ⚠️ items (storage, trading, `eat`, chat
   channel).
4. Defense completions (torch placement, swords, shelter) and a full
   `CURRICULUM=first_night` run.
5. Live-verify fishing: `craft_fishing_rod` → `cast_rod`/`reel_in` (or a single
   `fish`), bite detection, `food` tag integration — see [fishing](fishing.md).
6. **Fluids** (spec in [fluids](fluids.md)): start with M0 (fluid awareness,
   `/observe.fluids`, lava forbidden in A*, dig adjacency check), then M1
   (swimming physics + air budget). Requires a packet capture of a real player
   swimming to confirm the Bedrock water movement flags/`delta` semantics.
7. **Redstone** (spec in [redstone](redstone.md)): start with R0 (protect
   redstone in `DIG_PROTECTED`, `/observe.redstone`, state-aware search) and R1
   (oriented placement — needs a packet capture of a real placement to confirm
   how the BDS derives block state from yaw/face/click position).
8. **Goal Contract** (proposal in [goal-achievement](goal-achievement.md)):
   schema + status machine over the existing progression graph, then the 5
   progressive benchmarks (16 logs → shelter+night → iron pickaxe → 5 diamonds
   → Nether portal) as `CURRICULUM` goals run end-to-end. Depends on the
   AI-player Goal Manager (milestone 1).
9. **Nether / End** (spec in [nether](nether.md)): start at N0/N1 (locate or
   build a portal, `/observe.portals`, fire/lava + projectile/gaze sensing),
   then N2/N3 (survive the Nether, dodge ghast fireballs), N4/N5 (piglin
   bartering, enderman gaze discipline), N6/N7 (fortress, blaze rods, End).

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
