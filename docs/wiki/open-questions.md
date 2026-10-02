# Open questions

Known issues, blockers and verification gaps. Sources: `BEDROCK.md` (Known issues)
and `docs/raw/SURVIVAL-INTELLIGENCE.md` (Verification status). For the per-
capability collaudo checklist (done / pending live), see
[verification](verification.md).

Last lint: 2026-10-03.

## NetherNet instability

- The session drops every few seconds in some time slots (`Player disconnected`
  after 3-20 s, no server-side error). The harness reconnects itself, but during
  reconnection `/options` offers only `wait`.
- `connecterror:9` (InactivityTimeout) persists for hours at zero players; only a
  BDS restart clears it. One solved cause: mining via `item_stack_request` with
  invalid negative ids (fixed by reusing the crafting id sequence).

## Bot stuck on a built platform (2026-10-02)

- The deployed bot spawned on a built structure (`standingOn: oak_planks`) and
  could not move: `goto_waypoint`/`_moveTo` returned `path_failed` in every
  direction, and `dig_up`/`dig_down` returned `protected_head`/`protected_step`
  (`DIG_PROTECTED` covers planks). This blocked the live movement / exploration
  rounds of the session (the planner itself was verified via `GET /explore`).
- Remedy: **restart the BDS at zero players** (the bot respawns at the world
  spawn), or have the human player move/break the structure.

## Missing Bedrock capabilities (for the full first-night milestone)

- **Food beyond crops** — requires the furnace/smelting chain (exists, needs live
  testing of `eat` with hunger < 20 and food in inventory).
- **Ranged combat** — the bot has **no bow/arrow support**: `attack_*` is melee
  only (`item_use_on_entity`). A bow (`craft_bow`: 3 sticks + 3 string) plus
  arrows (`craft_arrows`: flint + stick + feather) would add a safe creeper
  counter and a way to fight from range. Nothing is implemented yet.
- **Advanced shelter** — no wall/shelter building actions.
- **Nether portal** — not implemented.
- **Fluids** — swimming, drowning/breathing, waterfalls and lava avoidance are
  not implemented; `_passable()` treats `water|lava` as walls (`bedrock-adapter.mjs`).
  Roadmap in [fluids](fluids.md). Two discovery items block M1: the exact Bedrock
  water-movement `input_data` flags/`delta` semantics (needs a packet capture of a
  real player swimming) and whether self metadata exposes `breathing`/air or the
  air budget must be simulated.

## Exploration travel kit (multi-day expeditions)

An exploration mission can last **several in-game days**, so the bot needs an
expedition kit and night survival (spec addition in [exploration](exploration.md),
"Travel survival kit and adaptation"). Missing pieces:

- **`craft_bed` / `place_bed`** — **implemented** (3 wool + 3 planks; the `wool`
  tag matches any colour), and `/observe.travel` reports what is missing for a
  trip. Live round pending (no wool available on the server).
- **Travel-kit / loadout** *action* — still no auto-prepare, only the readiness
  checklist. Also missing: inventory-full handling, pillar-up, provisional-hut
  skill.

## Respawn stuck on live BDS (2026-10-02, resolved)

- The deployed `hermes-jev-bedrock` container was **dead** (`health: 0, deaths: 1`)
  and stuck: `_survivalTick` sent `player_action {action: 'respawn'}` every
  2.5 s but the BDS never replied with the `respawn` packet (no `respawn_packet`
  log), so `/options` degraded to `wait` (`Dead; respawning automatically`).
- **Resolution**: it was a stale NetherNet session state for that player, not a
  protocol bug. A BDS restart at zero players (stop container → `systemctl
  restart minecraft-bedrock` → start container) cleared it; the bot respawned
  alive (`health:20`, spawn point) with an empty inventory (death dropped the
  items, `keep-inventory=false`).
- **Note**: this recovery was a fresh login, so the in-place
  `player_action respawn` flow itself still needs a clean live re-verification
  (die → respawn without a restart). Tracked in [verification](verification.md)
  row 12.

## Live verification pending

- `eat`, `take_<item>` and `deposit_<item>` are covered by unit tests but not yet
  verified live. `read_container` **was verified live on 03/10** (6 chests/barrels).
- Farming leftovers: `attack_<animal>` (skipped live, would kill a base animal),
  `tame_<companion>` (no companion near the bot on 03/10), `shear_sheep` +
  `craft_shears` (no sheep nearby), milk (bucket + cow), mature-crop detection.
- Riding as transport (`mount_<vehicle>`/`dismount`/`_rideToward`) is implemented
  but not yet exercised live. See [companions](companions.md).
- Trading (`open_trade`/`trade_<index>`/`level_<profession>`) is implemented and
  unit-tested, but the exact client→server transaction that finalises a trade and
  the tier-up detection still need a live round on a real villager. See
  [trading](trading.md).
- A live `CURRICULUM=first_night` round on the BDS was not run (the bot container
  was connected; a concurrent session with the same account would kick it out).

## Persistent memory (landmarks, chests, chunks)

**First slice implemented (2026-10-02)**: a real repository became the source of
truth — `world-memory.mjs` (service) over `sqlite-memory.mjs` (SQLite + WAL,
default) / `memory-store.mjs` (JSON fallback). It persists **landmarks**
(`rememberLandmark`; `home` registered at spawn), **container observations**
(`rememberContainer`), **resource sites** (`rememberResourceSite` from nearby
ores, per chunk), **portals** (`rememberPortal`, the `portal` block +
nether-side coords) and **entities** (`rememberEntity`, rideables keyed by
`uniqueId`), **explored chunks** (`markChunkVisited` with the chunk **biome**,
`unexploredFrontier`), with `known/stale/invalid` status and `lastSeenAt` —
memory is historical, not current truth. The adapter runs the producers once per
chunk. See
[memory](memory.md). `/observe.memory` exposes a compact view; `MEMORY_DIR`
(default `runs/memory`) selects the directory.

Still missing (the rest of the original gap):

- **structures** — villages / Ancient Cities have no heuristic detector yet;
- **mission checkpoints** ([exploration](exploration.md) M1);
- everything else stays ephemeral: `this.containers` (runtime TTL cache, now
  *also* written to memory), `deathSite`, `entities`, `drops`, `_openDoors`, and
  the `runs/*.jsonl` logs (append-only, never read back).

## Design limitations

- **No real exploration**: the bot only "sees" ores within ~±40 loaded blocks (the
  96-block radar is capped by the actively requested subchunks) and has no random
  walk / strip mining / cave exploration. See
  [headless-client](headless-client.md#8-render-distance-not-comparable). A full
  autonomous-exploration spec (find biome/block/structure, deterministic spiral
  planner, plus **underground targets**: caves, mineshafts, Deep Dark/Ancient
  City, spawners) exists in [exploration](exploration.md) but is not implemented.
- **Placement** only on a top face adjacent to the bot; no scaling/orientation.
- **No redstone awareness or placement.** `_refreshNearby`'s fixed list excludes
  redstone ore and components, so the bot cannot see or place them; `_placeAtCell`
  cannot set orientation (`facing_direction`/`cardinal_direction`); `DIG_PROTECTED`
  does not cover redstone components. The world model *does* expose component
  state via `blockAt().getProperties()` (`redstone_signal`, `powered_bit`,
  `open_bit`, `repeater_delay`, ...). Roadmap in [redstone](redstone.md).
- **Barricade** (`.private/DEFENSE-TASK.md`): `_barricadeGap` only checks the
  four cells adjacent to the bot, so the bot must already stand next to the 1×2
  opening; it does not search ahead or walk to a gap. Fine for a corridor, hard
  to trigger in the open base (see `verification.md` row 37).
- **Goal Contract**: the thin slice exists (`survival/goal-contract.mjs`, opt-in
  via `GOAL_CONTRACT`/`MAX_DEATHS`/`PRESERVE_ITEMS`, status
  `RUNNING/SUCCESS/FAILED/BLOCKED`), but there is still **no persistent Goal
  Manager/queue, no `target`-driven `obtain_item` executor and no semantic-goal
  interpreter** — a goal is still a string plus a step budget. Proposal and gaps
  in [goal-achievement](goal-achievement.md).
- **`beat_the_dragon` (resolved)**: `goals.beat_the_dragon` used to alias
  `enter_nether`; the graph now has the full
  `nether_portal → … → enter_end → beat_the_dragon` chain and the goal points to
  the real milestone. The underlying Nether capabilities are still missing — see
  [nether](nether.md).
- **No Nether/End capabilities**: no portal action (`goto_portal`/`build_portal`/
  `light_portal`), no fire/lava or ghast-fireball hazard, no piglin bartering, no
  enderman gaze discipline, no fortress/stronghold/End actions, and no
  `bossDefeated` verifier criterion. Roadmap in [nether](nether.md).
- **Crafting** only one item at a time; special recipes (smithing, anvil, looms)
  not implemented.

## Planned / in progress

- **Persistent agent lifecycle** (AI-player roadmap milestone 0→1) —
  **implemented** (2026-10-02): `SESSION=on` turns `controller.mjs` into a
  persistent session loop with an explicit `IDLE` state, and `goal-manager.mjs`
  holds the goal queue (sources/priorities/statuses, preempt/suspend/resume,
  persistence in `runs/<RUN_ID>/goals/world.json`). While idle the bot accepts a
  new `@bot` order as a `chat` goal and runs it without reconnecting; with
  `AUTONOMY=on` it also derives goals from survival needs (`idle-goals.mjs`,
  milestone 3 first slice); cross-session **resume** re-queues suspended goals
  on startup (`RESUME`, default in session mode); an **emergency producer**
  suspends a running goal and starts a higher-priority one on a world event
  (`PLAYER_DIED → recover_loot`, [emergency](emergency.md)). Still missing: the
  remaining needs-driven goals (inventory-full → store, else explore), the
  loot-priority executor and the fluid/fire-dependent events. Full analysis in
  [ai-player-roadmap](ai-player-roadmap.md).

- **Farming** (`.private/FARMING-TASK.md`) — **done and verified live 03/10** for
  the core (`plant_<seed>`, `feed_<animal>`, `breed_<animal>`, `throw_egg`,
  `read_container`); `attack_<animal>`/`tame_<companion>`/`shear_sheep` are
  implemented but live-pending. Remaining gaps: milk and mature-crop detection.
  Consolidated status in [roadmap](roadmap.md).
- **Human chat command channel**: natural-language remote control via in-game
  chat (`@bot seguimi`, `@bot aiutami coi mob`). M1–M3 implemented (chat capture,
  allowlist + trigger, NL → Hermes → `/plan`, `follow_player`); **live
  verification on the BDS still pending**. Ack/reply in chat (M5) and autonomous
  exploration remain open. Roadmap in [human-command](human-command.md).
- **Defense completions** — first slice implemented and mostly live-verified
  (`place_torch`, `craft_*_sword`, `retreat`/`go_home`, `close_door`/`barricade`,
  `equip_armor`, armor points); only the **shield** (stretch) remains. See
  [verification](verification.md) rows 32–38 and [roadmap](roadmap.md).
- **Fishing** — **implemented** (rod crafting, cast/bite/reel, water/shore
  detection, `fish` composer); no live round yet. The open technical question is
  **bite detection** on a headless client (bobber metadata vs. timing fallback).
  Roadmap in [fishing](fishing.md).
- **Fluids** (swimming, drowning/breathing, waterfalls, lava avoidance, buckets/
  boats/potions) — spec only. Roadmap in [fluids](fluids.md); start at M0 (fluid
  awareness) and M1 (swimming physics + air budget).
- **Goal-driven gameplay** — Goal Contract + task graph + 5 progressive
  benchmarks (16 logs, shelter+night, iron pickaxe, 5 diamonds, Nether portal).
  Proposal in [goal-achievement](goal-achievement.md); the 5 benchmarks have
  never been run end-to-end.
- **Nether / End** — portal locate/build/light/enter, Nether survival (ghasts,
  piglins, endermen), fortress/blaze, stronghold, End and dragon. Roadmap in
  [nether](nether.md); the progression chain is already in the graph.
- **Redstone and primitive automation** — spec only. Roadmap in
  [redstone](redstone.md); start at R0 (protect redstone, `/observe.redstone`,
  state-aware search) and R1 (oriented placement, needs a placement packet
  capture).

## Documentation integrity (lint 2026-10-03)

- `log.md` dates are interleaved (entries labelled `2026-10-02` and `2026-10-03`
  alternate): the log is append-ordered but the day labels are inconsistent, so a
  strict chronological check fails. Do not reorder or rewrite history; use the
  commit history for exact ordering, and give new entries the real current date.
- Stale test counts remain in the immutable sources (`BEDROCK.md` minerals section
  and `docs/raw/SURVIVAL-INTELLIGENCE.md` say 204): they are historical snapshots.
  The current count lives in [roadmap](roadmap.md) (383 at 2026-10-03).
- `verification.md` had duplicate row numbers (39/40 reused for the fluids rows);
  renumbered to 41–58 and all internal references updated.
- **Historical privacy leak (public repo)**: earlier commits still on the
  published fork contain private LAN IPs, the environment SSH username and links
  to the private Proxmox wiki pages. A later "privacy scrub" commit removed them
  from the tree but **not from history**. `tools/wiki-lint.mjs` now blocks these
  patterns going forward (private references = errors, environment fingerprints =
  warnings); fully removing them from the *published* history would require a
  history rewrite (force-push).

## Architecture evolution

Recorded in [architecture-evolution](architecture-evolution.md): Hermes is best
framed as a **strategic replanner, not a hierarchical planner** — it emits one
shallow objective per replan and never decomposes into `goal → subgoal → action`.
Two open design questions follow from that framing:

- **First-class `subgoal`**: add a `subgoal` field to the plan and let Hermes
  keep `objective` stable while rotating `subgoal`/`targets`/`skill`
  (receding-horizon). Today `subgoal` exists only implicitly (the `milestone`
  field in curriculum mode, the `skill` field in free-goal mode).
- **Multi-branch progression**: `resolveMilestone` returns a single deterministic
  `next` (DFS first-hit) — no OR/alternative-path semantics. To support copper /
  iron / exploration paths the graph needs branch nodes and a Hermes scoring
  hook, while Jev stays one-action-at-a-time.
