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

## Respawn stuck on live BDS (2026-10-02) — mitigated by auto-reconnect

- After a death (natural or a console `kill`) the bot stays `dead`
  (`health: 0`): `_survivalTick` sends `player_action {action: 'respawn'}` every
  2.5 s but the BDS never replies with a `respawn` packet, so `/options` degrades
  to `wait` (`Dead; respawning automatically`).
- **What a live packet capture showed** (BDS 1.26.52, NetherNet,
  server-authoritative movement): the connection stays fully alive after the
  death (thousands of entity packets). The server **ignores**
  `player_action respawn`. A client `respawn` packet (`state = 2`, CLIENT_READY)
  *does* make the server run the respawn handshake (`SERVER_SEARCHING` 0 →
  `SERVER_READY` 1, with the spawn position), but it never restores health — the
  player stays dead. This is a **server-side bug**, not fixable purely
  client-side.
- **Mitigation (implemented, live-verified)**: `bedrock-adapter.mjs` runs a
  watchdog — if the bot is still dead `RESPAWN_RECONNECT_MS` (default 25 s) after
  dying it closes the client; the harness reconnects (fresh login) and the player
  spawns healthy. Live 2026-10-02: `kill` → `respawn_reconnect {deadMs: 25000}` →
  harness reconnect → `health: 20`, **without a BDS restart**. The inventory is
  still dropped on death (`keep-inventory=false`), so `recover_loot` still
  matters.
- **Fallback** (previous behaviour, kept for reference): a
  `systemctl restart minecraft-bedrock` at zero players also clears it (fresh
  login).
- A **clean in-place respawn** (no reconnect, no 25 s gap) would need the correct
  server-side protocol exchange; tracked in [verification](verification.md) row 12.
- Diagnostic for future work: `PACKET_DEBUG=1` on the harness logs the names of
  the clientbound packets received right after a death (`rx_packet`).
- **Full state, limits and the refinement path**: [respawn](respawn.md).

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
  redstone ore and components, so the bot cannot *watch* for them; the separate
  opportunity scan (`ore-value.mjs` table → `mine_redstone_ore`/`mine_lapis_ore`
  when harvestable, see [opportunity](opportunity.md)) can since 02/10 at least
  *mine* those veins — the gap is state sensing and placement:
  `_placeAtCell`
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

- **Opportunity goals** (curiosity slice, 02/10) — **implemented at the data,
  decision and option level, unit-tested; the controller wiring is pending**:
  `ore-value.mjs` (value table + thresholds), `VALUABLE_ORE_SEEN` detection in
  `world-events.mjs` (`observe().ores` from the adapter's 24-block scan),
  `opportunity-goals.mjs` (a vein strictly better than the plan target, or gold
  and above absolutely; the drop must still be scarcer than a stack; never over a
  chat order, an emergency, another opportunity or a ≥ 90 % finished goal) and
  the `mine_<ore>` option with its tier 4.5 in `controller-decisions.mjs`. The
  preempt/suspend block in `controller.mjs` has no opportunity sibling yet, so an
  in-flight goal is still never interrupted by a vein; no `OPPORTUNITY*`
  environment switch; no live round. See [opportunity](opportunity.md).

- **Farming** (`.private/FARMING-TASK.md`) — **done and verified live 03/10** for
  the core (`plant_<seed>`, `feed_<animal>`, `breed_<animal>`, `throw_egg`,
  `read_container`); `attack_<animal>`/`tame_<companion>`/`shear_sheep` are
  implemented but live-pending. Remaining gaps: milk and mature-crop detection.
  Consolidated status in [roadmap](roadmap.md).
- **Goal/episodic memory** (02/10) — the mission layer over the world graph is
  implemented (`mission` + `mission_relation` goal edges + `action_event` +
  `findPreviousMissions`/`findSuccessfulLocationsFor`) and **wired into the
  controller** (goal → mission, `seeks` edges, action events with the action
  position, outcome/success on close). The **episodic → semantic consolidation**
  (productivity hints on the target node, idempotent, with provenance and
  contradiction handling) is **implemented, unit-tested and live-verified**: the
  full chain was observed on the deployed container on 02/10 (`RUN_ID=p1-live-2`),
  including the `consolidated_into` edge and the hint returned by
  `GET /memory/hints` / `/observe.memory.hints`, plus `POST /memory/consolidate`
  answering `already_consolidated` (idempotency) on the second pass. Two live
  findings from that round: a fatal controller error used to leave the mission
  `running` forever (**fixed**: close as `failed` with `controller_error: …` and
  exit non-zero, regression test in `tests/controller-mission.test.mjs`), and the
  deployed `.env` still carried the stale `JEV_MODEL=typesafe/jev-1.13` value that
  makes every controller run die with TypeSafe `400 Unknown model` (removed; use
  `jev-latest` with `TYPESAFE_API_KEY`; the container environment keeps the old
  value until the next recreate). Still open: retention/pruning policy for the
  episodic layer; the consolidation write happens on every terminal patch
  (cheap but unconditional). See [memory](memory.md).
- **Drop collection regression** (02/10) — live, mining and pickup disagree:
  `mine_dirt` reports `destroyedEvent: true` and `picked: []`, then the following
  `collect_drop` fails with `item_not_collected` (4/4 attempts, `inventory: {}`),
  and the auto-pickup path (`_pickupNearby` + fresh-drop priority) collects
  nothing. As a consequence every inventory target (`dirt`, wood, food) is
  unreachable and the goal contract can never flip to SUCCESS in-loop. This
  contradicts [verification](verification.md) row 4, which was marked ✅ from an
  earlier session. Tracked as P2 (inventory/interaction front); the hypothesis to
  test is a `take_item_entity` handshake/entity-runtimeId mismatch between the
  drop created by the destroy event and the drop list the adapter caches.
- **Human chat command channel**: natural-language remote control via in-game
  chat (`@bot seguimi`, `@bot aiutami coi mob`). M1–M3 implemented (chat capture,
  allowlist + trigger, NL → Hermes → `/plan`, `follow_player`); **live
  verification on the BDS still pending**. M5 is half-done: the bot speaks
  (`POST /say`) and greets a nearby human with the order syntax, but it does not
  **ack a specific order** yet; autonomous exploration remains open. Open design
  choices: public chat vs whisper, and skipping the greeting in `emergency`.
  Roadmap in [human-command](human-command.md).
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

## Known code defects (not fixed)

- **`_tradeAt` drops its timeout** (`bedrock-adapter.mjs`, found 02/10):
  `async _tradeAt (index, { timeoutMs = 20000 } = {})` never forwards `timeoutMs`
  to `_waitTradeResult (timeoutMs = 5000)`, so every trade effectively waits 5 s
  instead of the intended 20 s. Deliberately left as is: fixing it changes the
  timing of an area whose live transaction handshake is still unverified —
  thread the timeout through during the live trading round and observe the
  result ([trading](trading.md)).

## Documentation integrity (lint 2026-10-03)

- `log.md` dates are interleaved (entries labelled `2026-10-02` and `2026-10-03`
  alternate): the log is append-ordered but the day labels are inconsistent, so a
  strict chronological check fails. Do not reorder or rewrite history; use the
  commit history for exact ordering, and give new entries the real current date.
- Stale test counts remain in the immutable sources (`BEDROCK.md` minerals section
  and `docs/raw/SURVIVAL-INTELLIGENCE.md` say 204): they are historical snapshots.
  The current count lives in [roadmap](roadmap.md) (488 at 2026-10-02).
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
