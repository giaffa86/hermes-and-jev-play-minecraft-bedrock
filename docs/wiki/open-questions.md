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
- **Reconfirmed 2026-10-03**: after a container restart the harness spun on
  `[connect] attempt 1..6 failed: connecterror:9` (backoff 5→60 s) and `/observe`
  stayed `status: error` for minutes; stopping the container for 90 s did not
  help. The remedy that worked: **restart the BDS at zero players**
  (`pct exec 108 -- systemctl stop/start minecraft-bedrock.service`), after which
  the harness reconnected by itself within ~50 s (a container restart just forces
  an immediate retry). The BDS console must be read *inside* the CT:
  `pct exec 108 -- runuser -u minecraft -- screen -S minecraft -X hardcopy -h /tmp/mcscreen.txt`
  then `pct exec 108 -- tail -12 /tmp/mcscreen.txt`.

## Bot stuck on a built platform (2026-10-02)

- The deployed bot spawned on a built structure (`standingOn: oak_planks`) and
  could not move: `goto_waypoint`/`_moveTo` returned `path_failed` in every
  direction, and `dig_up`/`dig_down` returned `protected_head`/`protected_step`
  (`DIG_PROTECTED` covers planks). This blocked the live movement / exploration
  rounds of the session (the planner itself was verified via `GET /explore`).
- Remedy: **restart the BDS at zero players** (the bot respawns at the world
  spawn), or have the human player move/break the structure.
- **Update 2026-10-03 — reachability primitive + room geometry**: the harness no
  longer *offers* actions whose landing cell is unreachable (`reachableCells`,
  `dropReachable`, `mineDropReachable`, `approachReachable`, `entityApproachable`;
  live-verified: `read_container` fails in 19 ms instead of hanging 30 s,
  [verification](verification.md) row 42.3). The bot is however spawned inside a
  **furnished room**: the walkable component at `y=73` is only
  `x114-117 / z156-160`; the bed bank (`x113`, `x117`) plus two `green_carpet`
  blocks at `(113,73,158)`/`(114,73,158)` close the corridor to the only door cell
  `(112,73,158)`, which is standable but isolated. The offered options are
  therefore only `flee` and `dig_down` (which digs the **cobblestone in front** of
  the bot, not the base's floor). `mine_*`, `collect_drop`, `read_container`,
  `attack_*`, `mount_*`, `open_trade` are filtered out; the entities/chests/water
  the pending live rounds need are all outside the component.
- **Pending user decision (asked 2026-10-03, no answer yet)**: (A) allow the bot to
  dig a staircase through the room's cobblestone (wooden floor, carpets, doors,
  beds and chests untouched) — unblocks riding/companion/fishing/inventory live
  rounds; (B) place a chest with food in a reachable cell — unblocks only
  `take_`/`deposit_`/`eat`/trading; (C) no world change — the affected live rounds
  stay documented as environment-blocked. Until an answer arrives the plan in
  force is **(C)**: no change to the base, offline verification only.

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
  `craft_shears` (no sheep nearby). **Milking is implemented and offline-tested
  (03/10)** — `craft_bucket` + `milk_<animal>`, `tests/bedrock-milk.test.mjs` —
  but its live round is blocked by the environment: the farm census has no
  cow/mooshroom, the bot holds no bucket and no iron ingots, and the cage blocks
  any trip to one. Live gate evidence: `/options` withholds `milk_*` and
  `craft_bucket`, `POST /act milk_cow` → `missing_bucket` in 0.00 s, and
  `craft_bucket` → `missing_ingredients` (so the recipe *is* in the server data).
  Mature-crop detection is implemented (03/10) but its end-to-end live harvest
  is blocked by the cage: the only fields (z ≈ 188) are outside the bot's
  walkable component.
- Riding as transport (`mount_<vehicle>`/`dismount`/`_rideToward`) is implemented
  but not yet exercised live. See [companions](companions.md).
- Trading (`open_trade`/`trade_<index>`/`level_<profession>`) is implemented and
  unit-tested. The **packet-level live round was done on 03/10** (capture via
  `GET /debug/packet-debug`): the server ignores the entity interaction and sends
  back only a player-inventory resync — no `container_open`, no `update_trade`.
  The exact client→server transaction that finalises a trade, the tier-up
  detection, and the reason the interaction is ignored all still need a live
  round (see [trading](trading.md)).
- The **furnished room** (see *Bot stuck on a built platform*) blocks every
  remaining P2 live round that needs the floor: riding/companion need an animal at
  the same level, `take_`/`deposit_`/`eat` need a reachable chest/table, fishing
  needs water. Their offline half (unit + packet-serialization tests) is complete.
  [trading](trading.md).
- `CURRICULUM=first_night` is **verified live end-to-end** (2026-10-03,
  `runs/p3-first-night-3`): `obtain_food` (6 actions) → `first_night` (19 actions)
  → `GOAL MET after 25 actions (curriculum first_night)`, mission
  `mission_curriculum_murjqnba` closed `found/success`, exit 0. It is also covered
  offline (`tests/controller-curriculum.test.mjs`, staged fake harness + stub
  planner) and the harness `busy` lock had its own test
  (`tests/controller-busy.test.mjs`). What is still *not* proven live is the
  hostile-start variant: the run survived the night by sleeping in the base bed,
  so an awake night (no bed) remains untested, and the room stays a hostile start
  (see the P2 bullet above).
- **Animal combat target churn** (2026-10-03, live → fixed): `attack_chicken` used
  to end in `combat_timeout` after 35 swings (`weapon: null`, held item a
  `rabbit_foot`) because `_combat` re-resolved "the nearest animal of that type"
  before **every** swing. The live event log proves it: 102 `attack` events in one
  230 s window (22:37:01→22:40:51) spread over ≥15 distinct chicken runtimeIds
  (679:14, 691:21, 676:11, 694:7 …) with **no death in that window** — the damage
  landed on single birds (health dropping to 1-3) but the re-resolution smeared it
  across the flock, so nobody ever died (the log does hold 10 chicken deaths, but
  at 14:43, ~8 h before the fight). `_combat`
  now locks one target by `runtimeId` for the whole fight, confirms the kill only
  through `health <= 0` or an entity removal right after a hit, and answers
  `target_lost` / `target_gone` instead of claiming a kill it did not observe
  (4 unit tests in `tests/bedrock-survival.test.mjs`, 528 green).
  Remaining gap: the live round of `attack_<animal>` still needs the user's consent
  (verification row 23) **and** a reachable animal — inside the base room
  `attack_pig` answers `cannot_reach_target` in 24 s even though a pig pen sits just
  outside the wall.
- **Drop pickup residue** (2026-10-03, live): the residue is entirely the
  *unreachable landing cell* case, and the auto-pickup path now handles it
  instead of burning budget — `_pickupNearby` reads the reachable component and
  skips a trapped drop with a `pickup_skipped` log (`reason: 'unreachable'`,
  `failedAt` marked, zero moves attempted); it was the last drop path without the
  filter (the mining loop, `_collectDrop`, `_nearestDrop({reachableOnly: true})`,
  `read_container` and the entity options already had it). Offline: 2 new tests in
  `tests/bedrock-reachability.test.mjs` (skip with `moves === 0`; collect the
  reachable drop and skip the trapped one). The *live* proof of the skip needs a
  mining action with an unreachable landing cell, i.e. an unblocked environment
  (the room offers no `mine_*` and its floor is protected).
- **`go_home` movement timeout** (2026-10-03, live):
  `#22 go_home → {"ok":false,"error":"go_home_failed: movement timeout"}` on the
  surface near the base; the run recovered on its own (next step mined an oak
  log). Worth a targeted look at the `go_home` budget vs. distance, but it has
  not reproduced as a blocker.

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

- **No real exploration** (03/10: M1+M2+M4 implemented, the long-distance run is
  what is still missing): the bot only "sees" ores within ~±40 loaded blocks (the
  96-block radar is capped by the actively requested subchunks) and has no random
  walk / strip mining / cave exploration. See
  [headless-client](headless-client.md#8-render-distance-not-comparable). The
  deterministic planner (find biome, spiral over unexplored chunks, checkpoints,
  report), the route replay (return to a recorded place) and the observable-target
  search (a block or an entity, from where the bot stands) are live-exercised
  ([verification](verification.md) rows 45/45.1/45.2), but **an end-to-end run
  cannot happen while the bot is boxed in the room**: the first spiral waypoint is
  96 blocks away → `target_not_found`, and a target that is not in the 125 loaded
  chunks still needs travel. Still spec only in
  [exploration](exploration.md): M3 escort (blocked by the environment, no human
  player on the BDS), M5 structures and the **underground targets** (caves,
  mineshafts, Deep Dark/Ancient City, spawners).
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
  implemented but live-pending. Remaining gaps: the live milk round (the code is
  done and offline-tested: `craft_bucket` + `milk_<animal>`, 03/10 — blocked by
  the environment, no cow/bucket/iron and the cage). Mature-crop detection is
  implemented (`harvest_<crop>`, 03/10) with the live state verified, but the
  end-to-end harvest is blocked by the cage.
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
- **Drop collection regression** (02/10) — **resolved on 03/10**: it was a
  *geometry* case, not a broken `take_item_entity` handshake. The live event log of
  `p3-first-night-3` (03/10, 00:34:59→00:43:30) shows the pickup path working
  throughout (`pickup` events for `torch`, `oak_log`, `potato`, `carrot`, `egg`;
  `mine_potatoes picked: [{potato: 1}]` and `mine_carrots picked: [{carrot: 1}]`
  feeding `obtain_food SUCCESS {inventory.food: 3}`; ~14× `collect_drop → {egg}`
  with the egg count 1→27). What failed were the drops whose landing cell is
  outside the walkable component — the dirt dug *inside* the base room falls into
  the cavity under the planks, so `collect_drop` answered `item_not_collected`
  while the item was still in the block below. See the reachability primitive in
  [verification](verification.md) row 42.3 and the bullet below.
- **Human chat command channel**: natural-language remote control via in-game
  chat (`@bot seguimi`, `@bot aiutami coi mob`). M1–M3 implemented (chat capture,
  allowlist + trigger, NL → Hermes → `/plan`, `follow_player`); **M5 is now
  implemented and live-verified** (ack of the order + outcome line, see below);
  the inbound path with a **human** sender is still pending (no human connects to
  the BDS). Autonomous exploration remains open. Roadmap in
  [human-command](human-command.md).
- **Proactive greeting** (AI-player roadmap §6 *Attention System*, milestone 4
  first slice) — **implemented and unit-tested, live round pending**: perception
  `_nearbyHumanPlayers()` → `observe().humans` (humans only, ≤ 32 blocks, bot
  excluded, separate from the 8-row `entities` list); pure policy
  `human-greeting.mjs` (`planGreetings`: allowlist + range + per-gamertag
  cooldown, **empty allowlist ⇒ no greeting**); speech `sendChat()` →
  `POST /say` (M5, rate-limited, 256-char cap); `maybeGreetHumans()` in both
  controller loops (goal and `IDLE`), gated on `obs.spawned`. M5 replies are now
  live-verified (ack + outcome; sender = a real client account, not a human).
  Still open:
  - **human sender on the BDS** — the live round used the bot's own account
    through `POST /say` → server → bot (no human connects during autonomous
    runs);
  - **greeting channel**: public `chat` vs `type: whisper` (quieter hello);
  - **greeting during `emergency`**: not skipped today (the message is only
    informational, but it fires while the bot is being attacked);
  - **greeted state is in memory only** (`greetedHumans` map in `controller.mjs`):
    a controller restart re-greets the same human immediately (the cooldown does
    not survive the process; no persistence). The same in-memory state means a
    restarted controller sees the harness inbox again: orders older than
    `CHAT_MAX_AGE_MS` (5 min) are now dropped as stale (`chat_stale`), which is
    what keeps a restart from replaying an already-served order.
  - **no live round** with a real human on the BDS (`POST /say` never exercised
    against the deployed container).
  See [human-command](human-command.md#proactive-greeting-6-attention-system).
- **Defense completions** — first slice implemented and mostly live-verified
  (`place_torch`, `craft_*_sword`, `retreat`/`go_home`, `close_door`/`barricade`,
  `equip_armor`, armor points). The **shield** is now implemented too (row 19.3:
  `craft_shield`, `equip_shield` on the offhand, `raise_shield`/`lower_shield`
  with the `start_using_item` flag) but the live equipping round is still open:
  it needs an iron ingot + 6 planks the cage cannot mine, and a hostile that
  reaches the bot. See [verification](verification.md) rows 32–38 and 19.3,
  [roadmap](roadmap.md).
- **Fishing** — **implemented, bite detection rewritten 03/10**: the bite is no
  longer a local heuristic but the server's `fish_hook_hook` event (numeric id
  `13`), logged as `fish_bite` (`fish_hook_tease`, id `14`, logs `fish_tease` and
  is not a bite); the fallback is a dip of ≥ 0.2 **relative to the bobber's
  settled height** (the cast descent used to be read as a bite, so every cast
  reeled in early with `biteDetected: true` and zero fish). The settle phase
  needs 3 samples within 0.05 and a disappearing bobber is a typed `bobber_lost`.
  6 new adapter tests (13 in `tests/bedrock-fishing.test.mjs`). What is left is
  live: a reachable shore near the base, the real `fishing_hook` entity name and
  whether the BDS really sends that event.
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

- ~~**`_tradeAt` drops its timeout**~~ — **fixed 2026-10-03**: the remaining
  budget is forwarded to `_waitTradeResult` and covered by a unit test
  ([trading](trading.md)); the live handshake round is still pending. No other
  known defect is open at the moment.

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
