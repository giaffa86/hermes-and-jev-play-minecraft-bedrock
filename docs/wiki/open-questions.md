# Open questions

Known issues, blockers and verification gaps. Sources: `BEDROCK.md` (Known issues)
and `docs/raw/SURVIVAL-INTELLIGENCE.md` (Verification status). For the per-
capability collaudo checklist (done / pending live), see
[verification](verification.md).

Last lint: 2026-10-08.

## Promoted follow-up tasks (2026-10-04)

The P0 → P7 campaign is closed with its live-only validation gaps declared in
[final report](final-report.md). The following tasks are queued, not implemented
or live-verified by this close-out. The bot remains OFF by default; future
rounds must have one precise objective and stop immediately afterwards.

| Task | Scope and evidence | Acceptance criteria |
|---|---|---|
| `nethernet-ghost-lifecycle` | Investigate SCTP/WebRTC drops and the player entity that remains exposed after transport loss (04/10: deaths 1 → 4, inventory loss, final 2 HP; row 47.34). Recovery is a separate, already observed chain. | Produce a timestamped timeline of channel close, server presence, health/death, reconnect and clean shutdown; compare a bounded walk with container window cycles; identify a supported mitigation or retain a precise external blocker. Do not infer client silence: auth input was sent every 50 ms. |
| `bounded-live-rounds` | Build a reusable runner for start → one mission → evidence → stop, so diagnostics do not leave an unattended bot online. | Enforce a configurable session deadline; prevent simultaneous bot rounds on the shared slot; retain private before/after observations and action/transport outcomes; stop on success, failure, timeout, transport loss or interruption, and verify container exit. Record separately whether the server entity actually left. Offline failure-path tests must prove cleanup. |
| `remembered-storage-revalidation` | Formalize stale locations beyond the ten-minute local open-failure cooldown (`d6adc88`, `6984ea8`; rows 47.45–47.47). An open timeout alone does not prove a chest was removed. | Define evidence-based `known`/`stale`/`invalid` transitions, retry and successful-reread behavior, restart semantics and permanent invalidation criteria; implement them consistently in both memory backends and options/actions, with tests for wrong coordinates, removed containers, transient failures and changed contents. |

`p2-riding`, `p2-companion`, `p2-trade-timeout`, `p2-social`, `p2-fishing`
and `p4-shield` remain live-only validation gaps, not new architecture tasks.
Shield is **code ready, material unavailable / live validation blocked**;
slot 1 is settled by the nautilus-shell A/B, while shield equipping, raising
and protection still lack live evidence. No full crafting chain is planned.
The optional conclusive live round for `6984ea8` is deferred.

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
- **Reconfirmed 2026-10-04 (worse)**: the pattern is now a **session that dies after
  ~1 min 46 s** followed by a `connecterror:9` loop that **never recovers**
  (attempts 1-5, backoff 20/40/80 s). Evidence gathered in that round: the BDS
  console shows the clean pair `Player connected: giaffa86` → `Player Spawned` →
  `Player disconnected` 1 m 46 s later **with no kick reason**, and
  `GET /v1/join` answers **`players: 0`** *while* joins keep failing — so this is
  not the NetherNet single-slot limit (BDS-23121) but a signaling/ICE failure, the
  family of BDS-23072 (BDS ≥ 1.26.30 timeouts) and BDS-23108. What does **not**
  recover it: a container restart (`docker restart hermes-jev-bedrock`), even for a
  fresh client (`attempt 1 failed: connecterror:9`); what does, for a few minutes:
  `systemctl restart minecraft-bedrock.service` on CT 108 (from the VM 100:
  `docker exec hermes proxmoxctl exec 108 --command 'systemctl restart minecraft-bedrock.service' --timeout 60`).
  **Ruled out**: the `minecraft-public-ip-sync` timer (5 min). Its script
  (`/usr/local/sbin/minecraft-public-ip-sync`) rewrites
  `server-udp-ports=<public-ip>:19132:19132` and restarts the BDS **only** when the
  public IP changed *and* `players == 0`; with an unchanged IP it logs
  `OK mapping=…; no restart`. It also **enforces** a single `ip:19132:19132`
  mapping and aborts with `unexpected UDP mapping; manual review required` on
  anything else — so a future multi-mapping experiment (bot + human together,
  `p3-multiplayer`) must be coordinated with that script. **Impact**: a multi-step
  gameplay errand cannot be completed in one window (the fishing rod recovery of
  row 47.43 was interrupted by exactly this).

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
- **Update 2026-10-03 (later) — the walkable component shrank to one cell**: a
  single request tells the whole story. `GET /memory/search?q=…&reachable=1` ->
  `hits[].reachability.detail` = `{feet: true, cells: 1, truncated: false, start:
  {x: 115, y: 73, z: 159}, neighbors: [{116,73,159: feet=bed}, {114,73,159:
  feet=bed}, {115,73,160: feet=crafting_table}, {115,73,158: head=oak_log}]}` —
  floor `oak_planks` at `y=72`, ceiling at `y=75`. East and west are the room's
  **beds** (base furniture); south and north are a `crafting_table` at
  `(115,73,160)` and an `oak_log` at `(115,74,158)`, i.e. **the two blocks the P5
  probes placed** (`place_crafting_table` and `build_hut`). The 10-cell corridor
  measured on 02/10 is gone. Consequences: `_reachabilityUsable()` is false, so
  the P2 filters are **fail-open** again (`/options` offers `mount_donkey`,
  `attack_zombie`, `read_container`, `open_trade` at any distance) and every
  action that needs walking fails (`path_failed`/`target_not_found`); actions
  within reach still work (`mine_dirt` confirmed twice by the server, `craft_*`
  on the adjacent table, `sleep`), and drops land in the cavity below the floor
  (`collect_drop` -> `item_not_collected`). The bot cannot escape on its own:
  `pillar_up` -> `no_headroom` (2-high room), `dig_up` -> `protected_head`
  (planks), and mining is not targetable.
- **Revised pending decision (2026-10-03)**: besides (A)/(B)/(C) above, the
  cheapest fix removes **only the two blocks our own probes placed**
  (`setblock 115 73 160 air`, `setblock 115 74 158 air`): it restores the
  pre-probe state and touches nothing of the base. Without any console edit, a
  harness action that may mine **only the blocks the bot itself placed** (the R4
  placement registry is the natural gate) would do the same from inside the
  world. Recommended: the bot-owned cleanup action, because it unblocks the whole
  live backlog (riding, trade, containers, crops, mounting) with no base
  modification. Until an answer arrives, plan **(C)** stays in force.
- **Update (2026-10-03, later)**: the bot-owned cleanup action now exists. The R4
  placement ledger is persisted in world memory and rehydrated at spawn
  (`kind: placement`, `GET /memory/placements`, `_hydratePlacements`) and
  `mine_owned` removes the nearest cell that is still the bot's own, still in
  reach and still holding the block it left there — a cell someone else changed is
  dropped from the ledger, never mined. Live the refusal path is verified
  (`POST /act {"key":"mine_owned"}` → `nothing_owned_nearby`, `owned: 0`, 1 ms);
  the positive path is block-tested only, because the room offers nothing to
  place (inventory `{dirt: 1}`, and `place_*` exists only for
  `crafting_table`/`furnace`/`torch`/`bed` or a redstone component in hand).
  **The two probe blocks of this room are *not* in the ledger**: they were placed
  before the registry existed and the ledger only knows what it recorded, so
  `mine_owned` cannot claim them. Option A (the console edit) therefore remains
  the only way to remove those two specific blocks; option B now works for
  everything the bot places from now on.
- **Resolved 2026-10-03 (no console edit, no world change)**: the room opened from
  the inside. Two model gaps were in the way, both fixed and live-verified. (1) A
  `green_carpet` in the **feet** cell was read as a wall: low surfaces
  (`*_carpet`, `*_path`, `moss_carpet`) are now floor in `_standable`/`_solidAt`
  while the head cell stays strict (row 47.27), and the bot walked the corridor
  cell by cell — `goto_waypoint` to `{112,158}` → `{distance: 2, pathNodes: 7}`,
  `standingOn: green_carpet`, then `{110,158}` and down to `y=72.62`, out of the
  house. (2) Its own P5 probe block was mined (`mine_oak_log` on `(115,74,158)`,
  confirmed by the server) and the P5 `crafting_table` probe is no longer in the
  world either (verified live with `/explore/find` on 03/10); with the room open
  the ledger cycle was completed end to end (craft → `place_crafting_table` at
  `(106,71,151)` → 1 ledger record → `mine_owned` → ledger back to 0). The base
  itself was never touched, so **(A)/(B)/(C) is moot for this room**: no
  `setblock`, no dug floor, no chest. The remaining live blocker of the session
  is a different one — a **closed door on the bot's cell** (a villager) and the
  mounting/trade/fishing captures, see rows 47.28 and the mount/trade sections
  (swimming no longer belongs on that list: its flags are schema-driven and its
  rates are measurable, the blocker there is the absence of free-surface water at
  the bot's level, row 47.42; fishing: the server sends **no** bite event to this
  client — five `fish` runs, `grep -c fish_bite` = 0, hook despawns after ~40 s;
  **update 04/10**: that reading is honest but was taken while the hook's landing
  cell was unknown, so the cast now carries a verdict (row 47.43,
  `bobber_not_in_water` / `covered: true`) and a **new** blocker sits in front of
  the live test: there is **no rod** (and no string) in the reachable world after
  the 03-04/10 death emptied the inventory;
  see row 28 and [fishing](fishing.md)).
- **Still true**: the base furniture (beds, chests, planks) stays untouchable by
  design, and `mine_owned` only claims what the ledger recorded — the pre-ledger
  probes of this room are gone for another reason (the bot mined them or they
  were removed during the first migration), not because the ledger knew them.

## Mounting a vehicle is never confirmed (2026-10-03)

- `mount_donkey` on a saddled donkey 0.75 blocks away ends `mount_not_confirmed`
  after 20-26 s: the server receives 10 `interact` (`item_use_on_entity`, action
  `interact`) and answers by opening the **donkey's saddle inventory**
  (`inventory_slot {window_id: 2, slot: 0, item: 'saddle:1:579'}` plus an
  `inventory_content` for `anvil_input`) instead of linking the rider — no
  `set_entity_link` ever arrives. Adding a bare `interact` packet with
  `action_id: 0` changes nothing (the 1.26.51 mapper only names 3..6). The
  transport is not the problem: the same transaction with `action_type: 'attack'`
  kills entities live.
- Update 2026-10-04 — the **transaction family is accepted**, the *window still is
  not*. `POST /debug/probe-interact {"action":"attack","variant":"current"}` on a
  nearby pig lands: `healthBefore:10 → healthAfter:9` (`damage:1`) at 4.0 blocks,
  so the standalone `inventory_transaction {item_use_on_entity}` is processed by
  this server, and the `inventory_content` that follows it is **not** a refusal
  signal (the accepted attack produced 8 resyncs, the refused villager
  interaction 0). The same transaction with `action:"interact"` on an
  unobstructed adult farmer opens nothing at 1.6/2.1/2.8/4.0 blocks, day or
  night. Ruled out with evidence: packet shape, `legacy_request_id`,
  `legacy` presence, `hotbar_slot`/`held_item` (empty **and** with an item in
  hand), `player_pos` (already the eye position), `item_interact` before/after the
  frame, `animate swing_arm`, `mouse_over_entity`, the vanilla `npc_open` packet,
  sleeping villagers, behaviour packs, baby villagers. See
  [trading](trading.md) §"Verification status" for the table.
- Hypothesis (still open): BDS 1.26.52 expects a trigger only a real client
  produces (a different ordering or an extra packet). Next step: a packet capture
  from a real client mounting a saddled donkey **made with `PACKET_DEBUG=1`**, or
  a client-side packet dump — the game channel is DTLS, so the pcap of the human
  session carries only sizes and timing (no game packets).
- Update 2026-10-04 (later) — **a real client-side bug was found and fixed, the
  server's answer did not change**. `packet_set_entity_link` carries **one** `link`,
  but the handler iterated `packet.links`: the loop never ran, so the mount link
  (type 1) and the dismount link (type 0) were both dropped and `this.riding` never
  became non-null. A live packet dump shows `[packet] { name: 'set_entity_link' }`
  during a `mount_donkey` attempt while no `[mount]` was logged. The handler is now
  `_onEntityLink (packet)` + `tests/bedrock-riding.test.mjs` (16 cases). **With the
  fix in place the server still does not send that link for our interact**: on a
  saddled, tamed, adult donkey at 0.75 blocks, sightline `air,air,air`, daytime,
  empty hand, the only reaction is the donkey's inventory window
  (`inventory_slot {window_id: 2, slot: 0, item: 'saddle:1:…'}`), i.e. the server
  reads the use as **sneak** (open the animal's inventory). Ruled out with live
  measurements: `interaction_model` (`touch`/`crosshair`/`classic`), the 13 probe
  variants (which produce **no** reaction at all on the donkey — the window appears
  only after the repeated frames of a full action), `legacy`/`legacy_request_id`,
  `hotbar`/`held_item`, and a stale sneak flag (a `stop_sneak` is now sent
  unconditionally before every interaction and the mount still fails).
- New diagnostic surface (kept, gated by `BEDROCK_DEBUG`):
  `POST /debug/probe-interact` takes `interaction_model`/`interact_rotation`/
  `approach`, and `GET /debug/packet-debug?ms=5000&hex=inventory_slot,
  set_entity_link` logs the raw bytes of the named inbound packets (`[rx_hex]`).
- What would settle it: a **client-side** packet dump (or a MITM proxy that
  terminates the DTLS) from a vanilla client mounting a saddled donkey. A network
  capture is useless — NetherNet's game channel is DTLS, so the pcap of the human
  session carried sizes and timing only.
- Mitigation in place: the readiness filter refuses fast (`vehicle_unreachable`
  from the room, `no_boat_nearby` without a boat) instead of spending 20-26 s, and
  `ride`/`follow_player` answer `not_riding`/`no_player_target` with a hint
  instead of `unknown_action`.
- Update 2026-10-06 — **the same missing link now blocks a second, narrower ask:
sitting on the human's boat.** The chain around it is implemented and in
  production (rider links kept for every rider, `riding` flag read on non-self
  entities, `seatInfo`/`mountCapacity`, the pure state machine
  `bedrock-mount-follow.mjs`, the `join_human_mount` option ranked above
  `mount_*` and every locomotion fallback), and the *real* join is behind
  `BEDROCK_JOIN_HUMAN_MOUNT=1` (default off) precisely because the server never
  confirms our `interact`: with the flag on it would end `mount_not_confirmed`
  like `mount_donkey`. The packet capture below is therefore still the one
  unblocking fact for both. What no longer waits on it is the *refusal*: the bot
  stops the silent chase, says where it is waiting (`mount_waiting_shore`, once
  per episode) and logs a typed reason (`human_mount_full`,
  `human_mount_unsupported`, `human_mount_unreachable`, `join_disabled`,
  `human_mount_attempts_exhausted`).

## Containers outside the walkable component (2026-10-03)

- The bot discovers 4 real containers (chest (105,72,138), barrel (111,72,160),
  chest (95,72,161), chest (95,73,161)) and every `read_container` burns 30 s and
  ends `container_read_failed: movement timeout`. The reachability filter removes
  *offered* keys, and an explicit `/act read_container` still runs; here the BFS
  component says the neighbourhood is reachable, but the actual walk fails — the
  primitive answers *graph* reachability, not "a path the local walker can
  execute" (probable culprits: a fall/stair edge, or the target cell having no
  free approach side). Worth checking whether the approach cell can be validated
  before the walk (the typed `container_unreachable` error already exists; row
  42.3 of [verification](verification.md) shows it in the boxed-in case).
- **Update 2026-10-03 (later): part of this was not "outside the component" at all.**
  `_findNearbyStorageBlocks` asked `findBlocks(name, position, radius, 6)` — **six blocks
  per storage name** — so a wall of chests hid the iron chest standing two blocks away
  (walking two blocks west changed the answer), and the windows that *did* open were read
  with a stale slot array. With `STORAGE_SCAN_PER_NAME = 24`, the per-window content wait
  and the bounded read, `read_container` now lists the iron chests and
  `take_iron_ingot` works live (rows 47.33/15 of [verification](verification.md)). The
  `movement timeout` failures for containers genuinely beyond the walkable component
  remain — they cost 30 s each when asked for explicitly.

## The walker's stall verdict, and where it stopped (2026-10-07)

- Three live failures shared one shape: the destination was reachable on paper
  (`GET /debug/path` returned complete routes of 12-14 nodes, the chest 1.6-6.8
  blocks away) and the walk still ended `movement timeout`, spending the whole
  budget. `runs/demo-r3/events.jsonl` rows 6879 and 6918: 75 s of budget and 1,5
  blocks covered, 6,8 blocks short of the chest — the bot thrashed, and the
  per-waypoint `stuck` verdict never fired because a new minimum of a few
  centimetres toward the **next node** resets `lastProgressAt`. A reconstruction
  attempt with the same build and a chest 3,9 blocks away succeeded twice in 7.3 s
  and 6.2 s, so the geometry is not the cause: the stall is.
- `_updateMotionState` now also watches the **distance to the goal node**: no new
  minimum of 25 cm for `MOVE_STALL_MS = 8000` ends the motion as `no_progress`, and
  three stalls in a row close the walk as `stuck` (~25 s) instead of burning the
  whole budget, with `details` (`from`, `position`, `pathNodes`, `reachedWaypoints`,
  `outcome`, `stalled: true`) saying where it gave up.
- `storage_open_failure` and the `/act` result now carry `_moveTo`'s
  `error.details` (both used to drop it), so the next failure names the position
  instead of only the error. **Offline only** (6 new cases in
  `tests/bedrock-storage-walk.test.mjs`): the live round that hunts the failure
  with the new payload is still open.
- Still open: the walker spends the whole `STORAGE_TAKE_WALK_MS` when it is slower
  than the deadline but genuinely progressing, and the "close enough to open
  anyway (≤4,5 blocks)" fallback is not implemented — it changes what *arrived*
  means, so it needs its own round.

## Taking from a container: the cache expires, the memory remembers (2026-10-04)

- `take_<item>` options came only from the **runtime** cache (`_cachedContainers()`, filled
  by a read and expiring with `CONTAINER_TTL_MS`), so after a restart — the durable
  container memory keeps 27 chests, the runtime cache is empty — **no `take_*` was
  offered at all**, and an explicit `/act` answered `item_not_in_container` in
  milliseconds (`take_cobblestone`, live 04/10: that branch fires when the cached
  contents no longer match the window that actually opened, and it re-aligns the cache
  before refusing). *(An earlier version of this note claimed the options came from the
  durable memory — wrong: `options()` read `const cached = this._cachedContainers()`.)*
- **Fixed the same day**: the option list merges both sources and a remembered container
  is offered only when the walkable model says it is reachable, labelled
  `(remembered: re-read on arrival)`. `_takeFromContainer` accepts either source, walks
  with a dedicated budget (`STORAGE_TAKE_WALK_MS = 75000`) when the target comes from
  memory, opens the container and re-reads it on the spot; if the memory declares the
  item but no remembered container is reachable it answers `container_unreachable` with
  `"<n> remembered container(s) hold <item>, none is reachable now"` instead of denying
  the item exists. Live 04/10: after a restart, 8 `take_*` options all labelled
  `remembered`, and `take_bucket` succeeded with `{ok:true, item:'bucket', from:'chest',
  position:{x:92,y:73,z:165}, remembered:true, ms:546}` — the first attempt had spent the
  old 30 s budget on the 21-block walk and timed out three blocks short.

  cursor as the destination of every `take` and answers `50` (`FailedToValidateDstSlot`)
  whenever it already holds a stack — even the same item. The local model could lose
  track of that stack (an optimistic `_cursor = null` after a failed place-back in
  `_moveItemViaCursor`), and every later cleanup is guarded by
  `this._cursor?.count > 0`, so the refusal was permanent. Fixed and live-verified
  (row 47.44 of [verification](verification.md)); the same live A/B settled the offhand
  destination: **slot 1**, not 0.

## The BDS drops the session during a container read (2026-10-03)

- Four times in one afternoon the server closed the session while a `read_container`
  was running: twice right after a ~140 s read (`client_close {reason:'disconnected'}`
  at 10:36:46 and 11:08:25), once 180 s into a read (the harness then answered
  `action_timeout`), and once **mid-read after only 66 s and 8 windows** — the read
  that was supposed to be safe. Every time, the following actions answer `not_connected`.
- What the server says: the BDS console (`screen` hardcopy through the Proxmox broker)
  logs just `Player disconnected: <player>, xuid: …` — **no kick reason, no crash, no
  error**. On the last round the harness reconnected **by itself** ~5 s later
  (`Player connected` → `Player Spawned`) and resumed, so the `connecterror:9` loop seen
  earlier is a *transient* state, not a permanent one; twice a
  `systemctl restart minecraft-bedrock.service` on CT 108 was still needed to get back
  quickly.
- **Diagnosis refined the same evening — the drop is at the transport layer**: the reason
  string in `client_close` does **not** come from the game. `bedrock-lifecycle.mjs:12`
  (`trackNethernetClient`) captures `client._lifecycleCloseReason` from nethernet's
  `handleConnectionClosed(connection, reason)`, and nethernet sets that reason to
  `'disconnected'` when the WebRTC **data channel** fires `onclose`/`onerror`
  (`node_modules/nethernet/src/connection.js:31,35,43,47`). No `kick` packet was ever
  logged (`client.on('kick')` in `bedrock-adapter.mjs` logs `kicked`), so this is a
  transport failure: the SCTP/WebRTC session to the BDS dies, it is not a game-level kick.
- **The client is not silent**: `_authTickInterval` sends `player_auth_input` every 50 ms
  while spawned (`bedrock-adapter.mjs:589` → `_authTick`), so an earlier reading of this
  section ("the client stops producing traffic while the walk fails, and the server times
  the session out") no longer explains it. The only deliberate disconnect in the adapter
  is `_resyncByReconnect` in `bedrock-adapter.mjs`, which logs `inventory_resync`
  first — and since 06/10 it no longer drops the session by default: it asks the
  player window for a fresh `inventory_content` and reconnects only when that
  fails (see *The resync wedged the server* below). That is not what happened in
  any of these drops.
- **Recovery is automatic**: `onDisconnect` → `startConnectionWorker(10000)` →
  `connectLoop` retries until the bot is spawned again (`bedrock-harness.mjs:124-138`).
  On 03/10 the bot came back **by itself** twice with its inventory intact, so a BDS
  restart is usually unnecessary; the `connecterror:9` state can still need a few
  attempts (in one round a `systemctl restart minecraft-bedrock.service` on CT 108 was
  used to come back promptly).
- **Leading hypothesis (now narrower)**: the channel dies during heavy clientbound bursts
  — the eighth drop of the day happened again around a `read_container` (many windows,
  `inventory_content` bursts). Separating "many open/close windows" from "a long walk with
  no movement" still needs a bounded experiment; what is confirmed is the mechanism: a
  transport close, not a kick and not an idle timeout.
- **Mitigation in the adapter** (row 47.33 of [verification](verification.md)): the scan
  no longer stops at six blocks per storage name, the read is capped at 8 containers and
  90 s, and each walk gets 8 s instead of 30 s. Result: the same read now returns
  `{ok:true, read:3, ms:65644}` — the action **survives** the drop and reports what it
  read, instead of dying on the 180 s watchdog.
- **Open**: a bounded experiment comparing window cycles and walks with timestamped
  traffic evidence is queued as `nethernet-ghost-lifecycle` above. It must not assume
  there is no traffic during walks: auth input is sent every 50 ms. No extra round
  was attempted at campaign close-out.
- **Update 2026-10-04 (later) — the drop is cheap for the session, expensive for the
  entity.** Four more drops in one evening, all around real work: a read that answered
  `container_read_failed` after 33.5 s (the next request already said `spawned:false`,
  `not_connected`), an earlier read that collected 2 chests in 121 s, and a `take_shears`
  that ran two minutes before the session closed (the container then reconnected by
  itself: `[spawn] entityId 260`, `bedrock harness connected after attempt 1`). New and
  measured: **while the session is down the player entity stays in the world**. The bot
  was at the world spawn at night, so `deaths` went **1 → 4** in a few minutes
  (`[respawn_request]`, `[respawn_reconnect] {deadMs: 25042}`, `[respawn_limbo_recover]
  {health: 0, deaths: 4}`), each death dropping the inventory (16 eggs, recovered only if
  `recover_loot` runs before the drops expire) and the round ending at 2 HP in
  `emergency` (`critical_health`, `hostile_critical`, `multiple_hostiles`, `night`).
- **What still works live (re-observed 04/10)**: the respawn chain
  (`player_action respawn` → the BDS answers `respawn` packets after ~25 s or a forced
  reconnect → `respawn_ready` state 0/1 → `[respawn]` at the world spawn with health 20),
  the `dead` fallback of `options()` (`[{key:'wait', description:'Dead; respawning
  automatically'}]`) and `recover_loot` offered with a fresh `deathSite` after every
  death.
- **Operational consequence**: a live round that needs a walk *plus* an interaction costs
  a session that the transport drops within ~30-60 s of real work, so the sessions of
  04/10 were spent re-verifying what was already known. The bot container was stopped
  (`docker stop hermes-jev-bedrock`) once the deaths started repeating, so the entity left
  the world and stopped dying; the world itself is untouched and the bot comes back with
  `docker start`.

- **Update 2026-10-07 — the wedge, and the silence that made it lethal.** In the
  `diamond-20261007-1` expedition the transport no longer dropped a session *during*
  one action: it dropped it ~2 minutes after login, five times in one day, always as
  `Server closed connection: connecterror:9` → `[client_close] {reason:
  'connecterror:9'}` → `[connect] attempt N failed: connecterror:9` (backoff up to
  60 s), with the BDS console showing `Player disconnected` 2:00 after `Player
  Spawned` and no kick reason; the third one was preceded by
  `[unhandledRejection] Error: container_open_timeout` (stack `at Timeout._onTimeout
  (file:///app/bedrock-adapter.mjs:6139:16)`, i.e. `_waitForContainerOpen`). The
  leftover rejection is now suppressed (`pending.catch(() => {})`), **and it was not
  the cause**: two rejections appeared after the patch and the sessions kept dying.
  The five `systemctl restart minecraft-bedrock` rounds (bot container stopped first,
  `playerCount 0` verified) bought minutes, not stability, so the transport cause is
  still **open**. What is fixed is the *consequence*: while blind, the adapter
  advertised a fake `wait`, the controller obeyed it (75 decisions at a single
  option), and the idle entity was killed — 9 of the 11 deaths of the day have
  `wait(ok)` as their last action, 12-164 s before dying. A blind harness is now
  explicit (`connected: false`, `blind`, empty `/options`) and the run stops with
  `harness_blind_stop`, and the deterministic ladder no longer sends an unarmed bot
  to fight (`policy.fightAllowed`). Both are unit-tested; the live half (a run that
  now *stops* instead of dying) needs a session that lasts longer than two minutes.
- **Update 2026-10-07 (later the same day) — the Docker bridge NAT was the cause.**
  Measured with a throwaway container from the same image and the same `.env`, changing
  only the network: with `--network host` it connected (`attempt 5`) after the 7th BDS
  restart and held one session **6 min 47 s with zero `client_close`** (BDS console:
  `Player Spawned 14:46:50` → `Player disconnected 14:53:34`), while the same period on
  `hermes-internal` shows 18 drops and no successful reconnect. So the NetherNet
  UDP/WebRTC session does not survive the bridge NAT. `docker-compose.yml` now runs the
  harness with `network_mode: host`, `API_HOST=172.29.0.1` (the gateway of
  `hermes-internal`) and `HARNESS=http://172.29.0.1:3077`; a scoped host rule
  (`ufw allow from 172.29.0.0/24 to 172.29.0.1 port 3077 proto tcp`) keeps the API
  reachable from the controller inside the `hermes` container while leaving it
  unexposed to the LAN, and `mission.sh` uses the same URL.
- **Residual (smaller, still open)**: with host networking an **idle** session is
  stable, but during a run 13 drops per 30 min still appear and they are
  action-correlated (pathfinding, `survey_village`, container windows). `connecterror:9`
  is nethernet's `InactivityTimeout` (`node_modules/nethernet/src/signalling.js:18`), so
  the event loop blocking during a heavy action is the next candidate — a bounded
  experiment (idle vs. busy) is the cheapest way to separate it from the transport.
  Also unchanged: when logins stop being accepted, only a BDS restart clears it.

## Missing Bedrock capabilities (for the full first-night milestone)

- **Food beyond crops** — requires the furnace/smelting chain (exists, needs live
  testing of `eat` with hunger < 20 and food in inventory).
- **Ranged combat** — the bot has **no bow/arrow support**: `attack_*` is melee
  only (`item_use_on_entity`). A bow (`craft_bow`: 3 sticks + 3 string) plus
  arrows (`craft_arrows`: flint + stick + feather) would add a safe creeper
  counter and a way to fight from range. Nothing is implemented yet.
- **Advanced shelter** — no wall/shelter building actions.
- **Nether portal** — the bot *sees* a portal since N0 (`GET /observe.portals`,
  `_netherCensus`) and since N1 it can walk to it, build a frame (14 obsidian,
  bottom-up, never inside itself), light it with flint and steel and step in
  waiting for the server's dimension change. What is missing is the **live happy
  path**: the base has no obsidian and no loaded portal, so live only the typed
  refusals (`no_portal_known`, `missing_materials`, `missing_flint_and_steel`)
  were observed. No deliberate portal *search* either (the census radius is 32).
- **Fluids** — **M0 (fluid awareness), M1 partial (wading + simulated air
  budget), M2 (breathing + dive budget), M3 (waterfalls + bubble columns), M4
  (lava shores, destroyed loot, crossing gate), M5 (buckets, boats, brewing
  gate, lava bridge) and M6 (fluid skills, milestones, spatial criteria)
  implemented and collaudati live
  03/10**: the bot knows where water and
  lava are (`GET /observe.fluids`, census + hazard ladder), refuses digs that
  would open into a fluid, repels lava in `_standable` and can `avoid_lava` when
  lava is within range; the governor gained the
  `lava_contact`/`drowning`/`lava_near` rules. M1 added **wading** (shallow water
  is traversable: `_standable` accepts a water feet-cell with a free head cell,
  A* picks it up automatically, `WADE_SPEED_FACTOR` slows the local prediction)
  and a **simulated air budget** (`bedrock-air.mjs`: 300 ticks, 4/tick recovery,
  exposed as `air`/`airSeconds` with `airSource: 'simulated'`, no simulated
  damage). M2 added the real **Water Breathing** detection (turtle helmet or a
  `mob_effect` effect, remaining seconds counted down from the packet duration)
  and the dive decision (`bedrock-dive.mjs`, `GET /observe.dive`): descent +
  work + ascent must fit the air minus a 3 s reserve, otherwise `_mineBlock` and
  `_collectDrop` refuse with `air_too_low`/`work_too_long` **before** any packet,
  and while breathing is active the `drowning` rule and the `surface` need stand
  down. M3 added `bedrock-waterfall.mjs` (waterfall detection with a **landing
  verdict** — water or solid ground safe, lava/magma/fire/cactus hazards, `air` a
  fall onto nothing, unreadable = unknown — and `soul_sand`/`magma` bubble
  columns), the single decision `columnTactic` behind
  `descend_waterfall`/`climb_waterfall`/`use_bubble_column` and behind the
  `dig_down` water preference, the `onWaterfall` governor condition with the
  `ride_waterfall` rule, and `GET /observe.waterfall` for the verdicts; the live
  round could only observe the refusals (`no_column`: the only water in reach is
  a two-block pool, no column anywhere in 24 blocks) because riding a waterfall
  needs swimming, and the pathfinding column edges are deliberately left out (a
  descent into water the bot cannot leave would be a trap). M4 added
  `bedrock-lava.mjs` and `GET /observe.lava`: the death verdict on a loot site
  destroyed by lava (within 2 blocks the loot is gone and `recover_loot` is not
  even offered), the escape plan that prefers a shore with **water** next to it,
  the first-stretch gap measurement along the four cardinal directions, and the
  crossing gate (`fire_resistance` + a bridge, or water → obsidian where water can
  be placed — never in the Nether/End). `move_to_safe` and `cross_lava` refuse with
  typed errors (`not_in_danger`, `no_lava_ahead`, `gap_unknown`, `gap_too_wide`,
  `no_fire_resistance`, `water_in_nether`); the bridge build landed in M5
  (`_bridgeLava` pours water on the lava or places blocks one cell at a time and
  only advances on a cell the world confirmed), but the live round only observed
  the refusals (the room's lava is 15.4 blocks below the floor). M5 added
  `bedrock-bucket.mjs` and `GET /observe.bucket`: the source verdict (the block
  name, not `liquid_depth`, tells a source from flowing water), the placement
  verdict (obsidian on a lava source, cobblestone on flowing lava, water refused
  in the Nether), the fill confirmed by the inventory delta, the boat gate, and
  `brewPlan`; `brew_<effect>` honestly answers `brew_not_implemented` with the
  plan because the brewing-stand interaction is not written — the one M5 hole.
  A real defect was found by the live round and fixed: `place_water`/`mount_boat`
  were shadowed by the generic `place_`/`mount_` dispatch prefixes (they answered
  `missing_item`/`no_rideable_nearby`), and the M5 branches now sit before them
  with a dispatch test pinning the order.
  Still missing: swimming itself — `_passable()` treats `water|lava` as
  walls, so deep water, `surface`, `swim_to` and the water A* nodes wait for the
  measured vertical rates. The flags are no longer a guess (`swimInputFlags` from
  the 1.26.51 `InputData` mapper, semantics confirmed by the human session of
  04/10) and the measurement is no longer imagination either: `adapter.swimMeasure`
  (`POST /debug/swim-measure`) holds `want_up`/`want_down`/nothing while sampling
  the **server's own** positions, so one call next to open water yields the three
  rates. What is missing is the water: the village pond is a **covered well**
  (solid surface at `y=75` over water at `y=73-74`, structure detector: `Village`
  at `(74,76,174)`) and the only deep water is a **flooded amphitheatre 13-17
  blocks underground** (`ys=56..58`), so `enterWater` answers `water_covered` or
  `no_water_at_level` and the rates stay unmeasured — a world-access blocker, not
  a protocol one. The air budget is still simulated (no `minecraft:air` attribute
  from the server), and the underwater refusal has only been unit-tested.
  Roadmap and limits in [fluids](fluids.md).

## Exploration travel kit (multi-day expeditions)

An exploration mission can last **several in-game days**, so the bot needs an
expedition kit and night survival (spec addition in [exploration](exploration.md),
"Travel survival kit and adaptation"). Missing pieces:

- **`craft_bed` / `place_bed`** — **implemented** (3 wool + 3 planks; the `wool`
  tag matches any colour), and `/observe.travel` reports what is missing for a
  trip. Live round pending (no wool available on the server).
- **Travel-kit / loadout** *action* — **implemented** as `travel_kit`
  (03/10/2026): crafts the missing pieces in dependency order (planks → sticks →
  sword → table → torches → bed), each at most once per call, and reports
  `{ok, before, after, crafted, failed}`. **Pillar-up** (`pillar_up`) and the
  **provisional hut** (`build_hut`) are implemented too, and all three were
  exercised live on 03/10/2026 (see [exploration](exploration.md) and
  [verification](verification.md) row 45.4).
- **Still open**: **inventory-full handling** (drop/consume or abort the trip);
  the loadout reports `space: false` but does not free slots.
- **Live residuals (environmental, not code)**: no reachable wool/leather, so
  armor and the bed stay missing; the bot's room is two blocks tall, so
  `pillar_up` refuses with the typed `no_headroom`; and the first ring around the
  bot is furnished, so `build_hut` cannot seal (it placed one wall and reported
  `hut_incomplete`). All three need the bot to leave the room — same blocker as
  below.

## The re-arm after a recovery has no live proof (2026-10-07)

`recover_loot` now re-arms (`_equipArmor` then `_equipShield`, the shield into
the offhand) and the standalone `rearm_gear` action exposes the same pass, but
**no round has ever run it on the BDS**: run 2 (`demo-r2`) and run 3 (`demo-r3`)
logged **zero** `equip_*` attempts, and the only live `equip_armor` (run 1,
06/10) was refused by the server with `status 50` — the refusal `4ec6820` now
types and retries once, and that commit **is not deployed** either (the live
image is `225440a`).

What is missing is cheap and unambiguous: a death with loot to recover. The
round dies once, runs `recover_loot`, and reads `rearm` in the payload, the
`recover_loot_rearm` log line, `observe().armor` and the offhand slot. Open
until then:

- Does a **genuine** `armor_place_failed_50` survive the single retry? The armor
  retries the *same* place (`armor/2` with the same stack id) while the shield
  falls back to a different offhand slot — if the refusal is real, only the
  shield has a second chance.
- Is the offhand slot index stable across reconnects? `equip_shield` already
  carries `OFFHAND_FALLBACK_SLOT = 0` for the servers that answer 50 on slot 1.

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

- **The village storage register now writes and reads, but the four-case live
  round has not run (2026-10-06).** V1+V2 (`c897399`) close the two wiring gaps: a
  discovery is written during the chunk sweep and by the live deposit fallback
  (`contentsKnown: false`, `source: 'discovered'`), and `_depositTargetFor`
  climbs the ladder in `storage-ladder.mjs` before touching the world (idem
  `_storageSearchPlan`), so a known chest with the item beats a nearer empty one
  and a stale inspection is re-read on arrival. The offline proof is 10 cases in
  `tests/bedrock-storage-memory.test.mjs`. What is missing is the live row the
  roadmap calls the acceptance test: (1) a chest known to hold iron → the bot
  walks there from memory with no scan, (2) only unopened chests known → it
  inspects the nearest, (3) nothing known in the area → a local scan that
  *persists* the rows, (4) only an empty local area → the sweep. It needs a
  read-only round near the village (113, 73, 156) with no controller running.
  The rung-4 action is no longer spec: `survey_village` landed on 06/10
  (`_surveyVillage`, three independent limits `VILLAGE_SURVEY_MS` /
  `VILLAGE_SURVEY_CELLS` / `VILLAGE_SURVEY_MAX_MS`, a refusal distinct from a
  truncation, and the `kind: village_survey` register for idempotence — 9 offline
  cases), and so did the farm order (`@bot raccogli le carote` → `plan.farm`, a
  chain that closes on a state delta — 10 offline cases). Both are waiting for
  their first live row, and so is the census itself: `GET /observe.village` has
  never been read against the real village. See
  [village-recon](village-recon.md).

- **Deep Dark W0–W2: the model is offline, the world has nothing to test it
  against (2026-10-06).** The vibration model, `sneak_to` and the silent route
  planner are unit-tested (41 cases) but every number comes from the reference
  rather than the deployed build: the 8-block sensor sphere, the player-vibration
  → shrieker relay, the sneak silence (the ceiling
  `SNEAK_SPEED_CEILING_MPS = 2.6` is a guess about a Bedrock server, not a
  measurement) and `SENSOR_CELL_COST = 50` (a planner weight, not a game rule),
  wool occlusion and the 3-shriek summon.
  The `ancient_city` marker rule has never fired live and no Deep Dark is within
  reach, so the gate is an expedition (W4) or a disposable world copy; the W3
  round (a Warden summoned on purpose) additionally needs explicit consent,
  because the world is shared. A cheap first probe: `GET /observe.sculk` next to
  any sculk and a `sneak_to` on flat ground, to compare the measured speed with
  `WALK_SPEED`. For W2 the missing live proof is a two-sensor corridor: the plan
  must come back with `maxRisk: 0` and `/observe.sculk` must show no phase
  activation. See [deep-dark](deep-dark.md).
- **Companion taming: the code is right, the world is out of stock (2026-10-03).**
  After the naming fix (`cod`/`salmon`, see [companions](companions.md)) the live
  calls are typed and instant — `tame_cat` → `missing_feed {cod/salmon}`,
  `feed_pig` → `missing_feed {carrot}`, `shear_sheep` → `missing_shears`,
  `take_carrot` → `item_not_in_container` — but the **positive** path (feed →
  approach → `interact` → `tamed`) cannot run because there is nothing left to
  feed with. `read_container` around the village now reports the fish chest
  `(73,71,153)` **empty**, the potato chest `(72,72,152)` **empty** and `(95,72,165)`
  **empty** (the base chests `(90,73,160)`, `(90,72,160)`, `(91,73,160)`,
  `(91,72,160)`, `(111,72,160)` are intact). The only reads that reach the report
  are windows that opened successfully, so these are genuinely empty containers.
  Cause **not determined**: `_takeFromContainer` takes **one stack** per call
  (`take_cod` delivered 6, `take_salmon` 9), which cannot account for 2216
  potatoes, 235 carrots, 214 wheat and 2 shears disappearing between the take
  tests and this reading. Two tameable cats are in range (28.5 blocks at
  `132.5,73,136.7` and 28.6 at `99.0,74,182.9`, both `tamed: false`), so the round
  is ready the moment raw fish exists again — via a fishing rod, a re-stocked
  chest, or a world whose store has not been emptied.
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

- ~~**structures**~~ — implemented 03/10: `surveyBlocks` + `structures.mjs`
  detectors, `rememberStructure` landmarks, `GET /observe.structures`, structure
  search (`find_structure`), live-verified on a real village at (113,73,156) and
  on the cavity at (112,71,144) — see
  [exploration](exploration.md#structures-and-underground-targets-m5m6);
- **mission checkpoints** ([exploration](exploration.md) M1);
- everything else stays ephemeral: `this.containers` (runtime TTL cache, now
  *also* written to memory), `deathSite`, `entities`, `drops`, `_openDoors`, and
  the `runs/*.jsonl` logs (append-only, never read back).

## Design limitations

- **No real exploration** (03/10: M1+M2+M4+M5 implemented, the long-distance run is
  what is still missing): the bot only "sees" ores within ~±40 loaded blocks (the
  96-block radar is capped by the actively requested subchunks) and has no random
  walk / strip mining / cave exploration. See
  [headless-client](headless-client.md#8-render-distance-not-comparable). The
  deterministic planner (find biome, spiral over unexplored chunks, checkpoints,
  report), the route replay (return to a recorded place), the observable-target
  search (a block or an entity, from where the bot stands) and the **structure /
  cavity detector** are live-exercised
  ([verification](verification.md) rows 45/45.1/45.2/45.3), but **an end-to-end
  run cannot happen while the bot is boxed in the room**: the first spiral
  waypoint is 96 blocks away → `target_not_found`, and a target that is not in
  the 125 loaded chunks still needs travel. M3 escort is no longer only spec —
  `escort_to` (06/10) makes the bot lead a named human and wait when they fall
  behind, with offline coverage ([verification](verification.md) 47.52) — but it
  has never been run with a real human on the BDS, which is exactly what the
  environment blocks. Still spec only in
  [exploration](exploration.md): the *deep* side of M6 (following a cave system beyond
  the loaded radius, Deep Dark/Ancient City never observed live).
- **Placement** only on a top face adjacent to the bot; no scaling/orientation.
- **Redstone awareness (R0), oriented placement (R1), interaction/sensing (R2),
  primitive circuits (R3), measured verification/teardown (R4), the
  progression integration (R5) and the limits/safety layer (R6) done (03/10).**
  R6 turned the last spec bullet into code: `FORBIDDEN_BLOCKS`/`forbiddenBlock`
  refuse TNT, traps, command blocks, barriers, bedrock, end crystals and lava
  **twice** (blueprint validation and `_placeAtCell`, which gives up before
  touching the inventory — live: `forbidden_block` with the target cell unchanged,
  control probe on a torch), `DIG_PROTECTED` covers the unbreakable administrivia,
  `MAX_CIRCUIT_COMPONENTS` (24 lag components) / `MIN_CLOCK_TICKS` (8) /
  `REDSTONE_TOGGLE_MIN_INTERVAL_MS` (500, the same input cannot be toggled twice in
  a row) cap the lag a circuit can cause, `circuitSafety` keeps the bot out of its
  own site and out of a piston path, and `GET /observe.circuits.limits` publishes
  all of it. The toggle rate limit is **unit-tested only** (the base room has no
  lever and plan C forbids adding one) and `bot_in_piston_path` is only reachable
  by a synthetic plan, because no buildable blueprint moves a piston yet.
  `bedrock-redstone.mjs` now owns the vocabulary (components, sources, outputs,
  `tnt` hazard) and reads state through `powerOf`/`facingOf`/`blockProperties`
  (`null` when unreadable — never "off" by assumption); the component list is in
  `DIG_PROTECTED`, `_redstoneCensus` feeds `GET /observe.redstone` (one scan,
  `REDSTONE_RESCAN_MS` TTL, `ready: false` on an unloaded world) and
  `findBlocksByState` can search by state ("a powered repeater"). **R1** adds
  `place_<component>` through `_placeOriented` — place, read the facing back from
  the world, remove the wrong placement and retry on the next 90° yaw (bounded
  tries, typed `orientation_not_confirmed`/`oriented_place_stuck`/`no_place_spot`) —
  plus `set_repeater_delay[_n]` via repeated `click_block` with a state re-read
  after every click and `facingMatches` tolerant of compound values
  (`lever_direction = down_east_west`). The packet capture the roadmap expected
  turned out to be unnecessary. **R2** closes the *use* side: `use_redstone`
  toggles the nearest reachable input, verifies its state **and** the downstream
  outputs and then restores it (no clock left running), `_noteRedstoneUpdate`
  patches the census in place on every `update_block` (no extra `findBlocks`),
  `sense_redstone` and the `redstone` section of `GET /survival` expose the
  verdict, and the verifier gained `blockPoweredAt`/`circuitActive` (a missing or
  unreadable state is a failure, never a pass). **R3** makes a circuit *data*:
  `circuits/*.json` declares steps, trigger, success checks and materials,
  `circuits.mjs` validates every blueprint at load (impossible support order,
  duplicate cells, under-declared materials, traps like `tnt`) and plans/checks
  it purely (`planCircuit`, `circuitSiteBlocked`, `checkCircuitSuccess` — which
  refuses an empty success), and `build_circuit_<id>` places in order, sets the
  repeater delays, triggers, verifies **with the trigger still active** and then
  restores it; `GET /observe.circuits` exposes the catalogue and the last report,
  and every attempt lands in `runs/<run>/circuits.jsonl`. Four blueprints are
  buildable (`lamp_switch`, `delay_line`, `auto_lamp`, `auto_door`), four are
  declared and refused with a reason. **R4** makes the verification honest: the
  six-tick delay is *measured* from the bot's own redstone trace
  (`measureCircuitDelay`, `required`/`toleranceMs` per blueprint) instead of
  being declared, a `required` measurement that never arrives is
  `circuit_delay_unmeasured` and a late one `circuit_delay_mismatch`, a failed
  step rolls back the cells already placed, and `teardown_circuit` removes only
  circuit cells **the bot placed** (a cell someone else changed is skipped, not
  mined). **R5** connects all of it to the progression: `redstone_ore` →
  `redstone_basics` → `redstone_automation` in `knowledge/progression.json`
  (alias `goals.redstone`), six declarative skills in
  `skills/gameplay/redstone/` (two of which declare a blueprint that is still
  `buildable: false`, so the gap is visible in the graph), the new verifier
  criterion `circuitBuilt` (a circuit built *before* the skill started does not
  count), and the materials bridge: a blueprint with missing materials publishes
  `craft_<item>` for the first one that is craftable right now (`_craftableNow`:
  recipe + ingredients + a table within 32 blocks for recipes bigger than 2×2),
  and `build_circuit_<id>` only when nothing is missing. Still open: the **live**
  component/build round (R1, R2, R3's acceptance build and R5's curriculum share
  it) is blocked from three sides — the standing "no base edits" rule (the single
  cobblestone in reach is the room's own wall, so `mine_cobblestone → craft_lever
  → place_lever → use_redstone` was not run), the room's drops falling into the
  cavity under its floor (`reachable: false`, the known pickup blocker) and the
  fact that a `redstone_lamp` needs glowstone from the Nether. `_craftableNow`
  also sees crafting only, not smelting (cobblestone → stone, which `auto_door`
  needs). The
  ore was already mineable from the opportunity scan (`ore-value.mjs`) when an
  iron pickaxe is held; the live rounds of R2, R3 and R5 did verify the sensing
  keys, the catalogue, the typed routes, the option gating and that the extended
  graph resolves on the BDS (`CURRICULUM=redstone_automation` → `stone_age`).
  Roadmap in
  [redstone](redstone.md).
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
- **No Nether/End capabilities (N0/N1/N2/N3/N4/N5/N6/N7 done)**: N0 (awareness and hazards) is
  implemented, unit-tested and live-checked 03/10 — portal/fire/magma/spawner
  census, projectile tracking, enderman gaze sensing, `waterEvaporates`/
  `bedsExplode` and seven governor rules, all *perception only*; N1 adds the four
  portal actions (`goto_portal`, `build_portal`, `light_portal`, `enter_portal`)
  with pure frame geometry and typed refusals; N2 adds the survival primitives
  (`landingHazard`, `maxFallDepth`, `isFlammableBlock`, `pickHubBlock`,
  `shellCells`, `netherHubPlan`) and the `build_nether_hub` action, with a
  dimension-aware fall cap and a refusal to ever land on magma/fire/cactus; N3
  adds the dodge (`perpendicularDirs`, `lateralOffset`, `breaksLine`,
  `dodgeCandidates`, action `dodge_projectile`); N4 adds the bartering vocabulary
  (`PIGLIN_TYPES`, `BARTER_INGOT`, `goldArmorWorn`/`piglinNeutral`,
  `barterTarget`, `isBarterReward`), the shared `_equipItemInHotbar` (extracted
  from feeding) and the action `barter_piglin`, verified by a *fresh drop* and
  never by a whitelist — plus the removal of piglins from the attack options
  (hitting one closes the barter forever); N5 adds the gaze discipline
  (`endermanAimPoint`/`aimsAtEndermanEyes`/`isPumpkinMask`, `gazedAtEnderman`
  separating `aimingAtEyes` from `gazed`, actions `avoid_enderman_gaze` and
  `equip_pumpkin`, torso aim in `_combat`, `pearls` counted from the slots) — all
  unit-tested, live-checked
  only for the refusals (the live world is an Overworld room with no obsidian, no
  ghast, no piglin, no enderman and no blaze); N6 adds the `nether_fortress`
  detector (dimension-scoped, so the Overworld survey never invents one) and the
  `hunt_blaze` action (`lineBlocked`/`coverCandidates`/`blazeTactics`: low health
  and *being on fire* come before shooting, cover before approaching, and an
  unknown cell is not cover). N7 closes the chain: eyes of ender
  (`eyeCraftPlan`, `craft_blaze_powder`, `craft_ender_eye`), the thrown eye and
  its triangulation (`eyeReading`, `triangulateStronghold` with `readings_too_close`/
  `parallel_rays`/`stale_reading` and the rest), `find_stronghold`,
  `fill_end_portal` (the eye bit is read back **from the world**, and one
  unreadable frame is enough to refuse `complete`), `enter_end_portal`, and a
  real **`bossDefeated`** verifier criterion fed by the server's `boss_event`
  bar cycle — not by a vanished entity, which would also be true after simply
  leaving the End. Still missing: the dragon **fight** (end crystals, perch
  phase, ranged combat), so `beat_the_dragon` keeps `success: null`. Roadmap in [nether](nether.md).
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
  (`PLAYER_DIED → recover_loot`, [emergency](emergency.md)); since 2026-10-06 a
  **human order** does the same — it suspends the running goal, runs as a child
  goal with its own requester and hands the parent back revalidated after
  `goalAlreadySatisfied` ([goal-stack](goal-stack.md)). Still missing: the
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
  value until the next recreate).

  **P6 follow-ups are done too (03/10).** The **observation log** is implemented
  (`subject/predicate/object` + `confidence`/`observedAt`/`source`, schema v5 in
  both repositories, `POST /memory/materialize` idempotent, `GET
  /memory/observations`): the graph is now a *projection* of the log, newest
  observation per `subject|predicate` wins and an edge the log no longer supports
  is invalidated, never deleted. The **vector index** for semantic recall is
  implemented too (`vector-index.mjs`, a derived dependency-free index over the
  current records, `GET /memory/search`, `POST /memory/reindex`, `TTL` cache
  invalidated by writes and by consolidation) — SQLite stays the source of truth.
  Live on the deployed container: migration v4 → v5 with no data loss (141
  records, 34 observations), `materialize` replaying with identical numbers, and
  `?q=productive%20dirt%20site` ranking the consolidated `resource_site_7_9`
  first; the comparative test shows the keyword path returning nothing for *"the
  iron rich cave near the mountain"* while the vector path returns the right cave
  first. **Retention done (03/10/2026)**: `pruneEpisodic` (and `POST
  /memory/prune`) prunes only terminal missions that already carry the
  `consolidated_into` relation, never a running or unconsolidated one, with
  `minAgeMs` for the recent past — and **dry-run by default**. Live: 40 terminal
  missions, 8 consolidated (the only eligible ones), 32 protected; a real call
  with the default window deleted nothing and the counts plus the productivity
  hints were unchanged. The **observation log** has its own retention too
  (03/10/2026): a write-side dedupe (`observationDedupeMs`, default 5 min) stops
  the census from appending the same reading again, and `pruneObservations` /
  `POST /memory/observations/prune` drop the superseded evidence beyond
  `keepPerFact` per fact — live the log went from **5654 rows to 131** with the
  projection and the semantic-search scores identical, and stayed at 131 for
  three further minutes while the census kept running. Still open: an
  unconsolidated backlog blocks the episodic pruning by design. The
  consolidation write happens on every terminal patch (cheap but unconditional);
  recall is lexical-semantic, so a query must use the game's vocabulary (`iron` ≠
  `iron_ore`). The planner now consumes it (03/10/2026): the controller derives a
  query from the running goal and puts the top 3 hits in the planner prompt as
  hints next to the P0 productivity ones (fail-open, `semantic_recall` event,
  `tests/controller-recall.test.mjs`, live on the container). Still open: turning
  a hit into a real waypoint for a free-form goal. See [memory](memory.md).
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
  allowlist + **multi-trigger** `CHAT_PREFIXES`, e.g. `@bot,@hermes`, so one bot
  answers to both a generic word and its own name — required once several bots
  share a server; NL → Hermes → `/plan`, `follow_player`); **M5 is now
  implemented and live-verified** (ack of the order + outcome line, see below);
  **M6 (chat questions) is implemented and unit-tested**: `@bot dove sei?` is
  answered from `observe()` (regex fast path, then System One/Jev over a closed
  intent list; the model picks an option and never writes the answer) and creates
  no goal. **M6.1** closed the fail-open boundary: `looksLikeQuestion` (raw text:
  explicit `?`/`¿` or an interrogative first word, bare `hai`/`sei`/`stai`
  excluded) is a **pre-filter** — a message that is not question-shaped never
  costs a model call before its ack — and a question-shaped message the router
  cannot decide (off, no key, timeout, error, unparsable, below
  `CHAT_INTENT_MIN_P`) is refused with the way back to the order syntax and
  logged as `chat_unrouted`, **never** turned into `follow <sender>`. `q_none`
  from a working model still means "it was an order". The inbound path with
  a **human** sender is still pending (no human connects to the BDS), and the
  question path has not had a live round on the BDS yet (a real chat message,
  not `POST /say`). Autonomous exploration remains open. Roadmap in
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
  with the `start_using_item` flag). The take path was fixed and the offhand
  destination settled live on 04/10 (**slot 1**, row 47.44), so what the live round
  still needs is simply a shield: the village chest that held one is no longer
  present in the live census. **Validation pending due to missing material**;
  the full iron/planks crafting chain is deferred at campaign close-out.
  See [verification](verification.md) rows 32–38, 19.3 and 47.44,
  [roadmap](roadmap.md).
- **Fishing** — **implemented, bite detection rewritten 03/10, bobber verdict added
  04/10**: the bite is no
  longer a local heuristic but the server's `fish_hook_hook` event (numeric id
  `13`), logged as `fish_bite` (`fish_hook_tease`, id `14`, logs `fish_tease` and
  is not a bite); the fallback is a dip of ≥ 0.2 **relative to the bobber's
  settled height** (the cast descent used to be read as a bite, so every cast
  reeled in early with `biteDetected: true` and zero fish). The settle phase
  needs 3 samples within 0.05 and a disappearing bobber is a typed `bobber_lost`.
  The 04/10 verdict answers *where the hook landed* (land → typed
  `bobber_not_in_water` with the block names + the line reeled back; covered
  surface → a valid cast flagged `covered: true`; unreadable world → fail-open)
  and is exposed in `/observe.fishing.bobber`. 20 tests in
  `tests/bedrock-fishing.test.mjs`. What is left is live: a rod (the inventory is
  empty, row 47.43), water at the bot's level, and one cast to decide whether the
  BDS sends that event at all.
  Roadmap in [fishing](fishing.md).
- **Fluids** (swimming, drowning/breathing, waterfalls, lava avoidance, buckets/
  boats/potions) — M0 + M1 partial (wading + simulated air + the measurement
  probe) + M2 (breathing) + M3 (waterfalls/bubble columns, detection and verdicts)
  + M4 (lava shores, destroyed loot, crossing gate) + M5 (buckets, boats, brewing
  gate, lava bridge) + M6 (fluid skills, milestones, spatial criteria)
  implemented and live 03/10; the swimming **motion** (the rates) is still the
  open blocker, and it is world access rather than protocol: the probe is ready,
  the world around the bot has no free-surface water at its level (a covered
  village well above, a flooded ravine 13+ blocks below). Roadmap in
  [fluids](fluids.md).
- **Goal-driven gameplay** — Goal Contract + task graph + 5 progressive
  benchmarks (16 logs, shelter+night, iron pickaxe, 5 diamonds, Nether portal).
  Proposal in [goal-achievement](goal-achievement.md); the 5 benchmarks have
  never been run end-to-end.
- **Nether / End** — portal locate/build/light/enter, Nether survival (ghasts,
  piglins, endermen), fortress/blaze, stronghold, End and dragon. Roadmap in
  [nether](nether.md); the progression chain is already in the graph.
- **Redstone and primitive automation** — R0 done (awareness + protection, live
  03/10), R1 done (oriented placement + repeater delay, unit-tested 03/10), R2
  done (interaction + sensing, unit-tested and live-sensed 03/10) and R3 done
  (declarative circuits: `circuits/*.json` validated at load, pure planner and
  checks, `build_circuit_<id>` that places/triggers/verifies/restores,
  `GET /observe.circuits`, `runs/<run>/circuits.jsonl` — unit-tested and
  live-refused 03/10) and R4 done (the delay is *measured* from the block-update
  trace, `teardown_circuit` limited to the cells the bot placed itself, rollback
  of a half-built site, `measure.required`/tolerance per blueprint — unit-tested
  03/10), R5 done (six declarative skills, `redstone_ore` → `redstone_basics` →
  `redstone_automation` in the progression with the alias `redstone`, the
  `circuitBuilt` criterion and the materials bridge `craft_<item>` — unit-tested
  and live-resolved on the BDS 03/10) and R6 spec only. Roadmap in
  [redstone](redstone.md); next is R6, while the live build round still shares
  the "no base edits" blocker (unreachable drops in the room's cavity, the base
  wall as the only cobblestone, and a `redstone_lamp` needs Nether glowstone).

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
- **Language drift in `log.md` — resolved 04/10**: the user selected concise
  English rewriting. The actual Italian span contained **46 entries** (the
  previous note said 47), from proactive greetings through observation
  retention. Each entry retains its date, type, position, result, evidence
  and then-current blocker; later results do not retroactively upgrade earlier
  probes. Full protocol detail remains in the linked capability pages and git
  history. The entry type set is documented in the log header; mechanical lint
  still does not detect language.
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
One of the two design questions that followed from that framing is now closed:

- **First-class `subgoal` — CLOSED by R1** (07/10/2026). `plan.subgoal` and
  `plan.steps[]` exist, but they are **derived** by the pure module
  `plan-shape.mjs` from the skill contracts and the milestone graph, not authored
  by Hermes: the controller holds `goal.objective` and the `subgoal` rotates. The
  per-chunk verification is the skill's own `success` criteria filtered to
  `CRITERIA_KEYS`. See [reasoning-roadmap](reasoning-roadmap.md).
- **Multi-branch progression** (still open): `resolveMilestone` returns a single
  deterministic `next` (DFS first-hit) — no OR/alternative-path semantics. To
  support copper / iron / exploration paths the graph needs branch nodes and a
  Hermes scoring hook, while Jev stays one-action-at-a-time.

## Material sourcing, the survival ladder and the chat orders (04/10/2026)

- **The material rule is deployed** (05/10/2026). The sourcing ladder
  (`observe().craft`, the `craft_source` controller stage) and the food
  correction (`LAST_RESORT_FOODS`, `STARVING_FOOD`) are on the live containers
  (`bedrock-adapter.mjs` `25b33d50…`, `controller.mjs` `1def6142…`); the branch is
  `wip-live-20261005` at `f3c8d46` with 1287 passing tests. Live round still to
  run: ask in chat for a wooden pickaxe with a chest nearby and no logs held,
  then watch for `CRAFT SOURCE take_oak_planks`.
- **The `surface` branch is unit-tested but never exercised live.** The census
  knows only a two-cell-deep pool, so a real drowning round (head under water,
  air below `DROWNING_AIR = 60`, `surface` offered) still has to happen.
- **The chat-order contract is fixed** (05/10/2026). An order whose plan declares
  no terminal criterion (no targets, waypoint, follow, need or skill) used to
  close at once: *"eat the potatoes you have"* (`g21`) ended with
  `GOAL MET after 0 actions` and the chat got a "done" that never happened. The
  met check now requires at least one **successful** action before such an order
  can close, and an order that never succeeds ends on the step budget instead of
  a fake success (`tests/controller-chat-open-plan.test.mjs`).
- **Eggs, and why the bot was stuck at 2 hearts.** Eggs are an ingredient, never
  a meal; the bot had only 34 eggs and 4 raw potatoes, so `bestFood` returned
  `null` and the governor kept asking for `obtain_food`. The raw potato was put
  in the last-resort list first, then moved where it belongs (05/10/2026): it is
  **safe** — only the *poisonous* potato applies Poison (60%, 5 s) — so it is the
  last entry of `FOOD_PRIORITY`, a meal the bot eats whenever hunger drops below
  18, while `rotten_flesh`, raw `chicken`, `poisonous_potato` and `spider_eye`
  stay behind the `STARVING_FOOD = 4` gate. Worth remembering for any live
  round: a plain potato is never a risk, it is just a poor meal.
- **The `AUTONOMY=off` invariant holds**: the needs-driven idle autonomy is still
  opt-in; what runs by default is only the *rule-driven* ladder plus the
  survival needs the governor declares right now.

## Mining, vertical escape and the deposit (06/10/2026)

Observed in the hand-driven diamond mission (see [log.md](../log.md), entry
*Diamond mission end to end*). All eight are harness behaviour seen live, not
unit-test guesses.

- **There is no "dig straight up" action.** `dig_up` (`_upTargets`,
  `bedrock-adapter.mjs:14204`) builds the target list for all four directions
  (`{"0"|"90"|"180"|"-90": "no_step_ahead" | ["ceiling","step","head"]}`) but the
  option is pushed **only for the direction the bot is currently facing**
  (`_digDirection()`); `dig_up` then mines `ownCeiling + step + head` and steps
  1 forward + 1 up. A bot facing an open side gets `no_step_ahead` even when the
  opposite direction is solid. Twice the bot stranded itself in the tunnel it had
  just dug (at ~y 29.6 and ~y 48.6) with `dig_up`/`dig_down` both refused;
  `pillar_up` was refused too (`{"ok":false,"error":"no_headroom","block":
  "cobblestone","headroom":1}` — it needs 2) and `barricade` failed 24 times in a
  row with `barricade_incomplete`. **The only fix that worked was turning the
  bot**: a `goto_waypoint` to a waypoint 3 blocks away re-aims `_digDirection()`
  and `dig_up` reappears. Worth a real `dig_straight_up` (or making the option
  facing-independent) before any autonomous mining plan relies on making its own
  shaft. **Fixed (06/10/2026)**: `_upTargets()` tries the facing direction first
  and then the other three cardinals (`_upTargetsFor(d)` holds the unchanged body,
  `bedrock-adapter.mjs`), so a bot whose front is open climbs the opposite way; a
  direction that can climb still wins over a detour, so the stair stays straight,
  and when none of the four works the error is still the facing one with `tried`
  listing the four attempts. `dig_down` was left alone: no `_digTargets` refusal
  was ever recorded, only the stranding — and `dig_up` coming back is what
  unblocks it. `tests/bedrock-dig-up.test.mjs` (the tunnel case, the
  straight-stair preference, the all-four-fail error).
- **`go_home` fails from a deep shaft.** From the mine bottom it answered
  `go_home_failed: path_failed` eight times in a row (once `movement timeout`),
  and later `go_home_failed: movement timeout` even after the reachable set had
  grown to 1200 cells spanning the surface. The return worked only by walking
  waypoint hops. Same family as the earlier "no real exploration / no long-path
  planning" gap. **Fixed (06/10/2026)**: 1200 *was* the BFS limit
  (`reachableCells({ limit: 1200 })`), i.e. a truncated set, not a route to the
  surface. `_goHome` now gives the direct `_moveTo` 60% of its budget and, when
  that does not arrive, hands the rest to `_homeHops` — a greedy walk over the
  reachable cells, each hop at most 24 blocks away and (3D) at least one block
  closer to home, each hop bounded to 12 s so the 5000-node A* budget
  (`PATH_MAX_NODES`) is never asked for a 50-block climb in one go. The result
  says which mechanism worked (`via: 'direct'` / `via: 'hops'`) and a failed
  return carries the trail of cells walked plus `no_progress` or
  `hop_budget_exhausted`; `tests/bedrock-go-home.test.mjs`.
- **`mine_<ore>` requires a *reachable* drop cell**, not just visibility:
  `{"ok":false,"error":"no reachable diamond_ore found nearby"}` while `/options`
  advertised `mine_diamond_ore at {"x":90,"y":11,"z":191} (11.7 blocks away,
  opportunity)`. Digging closer first is mandatory. And a *distant* ore attempt is
  actively harmful: 10 consecutive `mine_diamond_ore` calls returned
  `block_still_present` while the bot walked to the ore and fell back down the
  shaft. **Fixed (06/10/2026)**: `mineTargetReachable()` (`bedrock-adapter.mjs`) is
  now the single predicate shared by `_pickMineTarget` (which decides what
  `/options` offers) and `_mineBlock` (which executes) — mineable means in reach
  (`MINE_REACH = 5.1`) or a reachable cell within `MINE_APPROACH_RANGE = 2.5` — and
  the executor answers `mine_target_unreachable` with the measured distance
  instead of sending a break from out of range.
  `tests/bedrock-mining-reach.test.mjs`.
- **`deposit_<item>` names one container and uses another.** The offered key read
  `deposit_diamond | Deposit 2 diamond into the 201 at {"x":105,"y":72,"z":138}`
  but the action performed went to (91,73,160), because the description uses the
  cached `depositTarget` while `_depositItem(itemName, {position})`
  (`bedrock-adapter.mjs:~5380`) resolves through `_depositTargetFor(itemName)`,
  which prefers a container that already holds the same item. The description also
  prints the container type as the runtime id `201` instead of `chest`. A
  count-limited deposit is impossible through the key alone (`take_<item>` accepts
  `maxCount`, `deposit_<item>` does not): the only way to move exactly 2 is to hold
  exactly 2 and pass an explicit `position` in the `/act` body
  (`bedrock-harness.mjs:745-749` forwards both).
- **Fences decode as `unknown-`**, so the village census reports
  `fenced: false, missing: ['fence']` for **every** pen — including the pen whose
  ring of unmapped cells is plainly visible in `/debug/geom`. Any "is the pen
  closed?" decision made from `observe().village` is therefore unusable; the pen in
  this mission had to be confirmed by reading the geometry by hand.
- **`/debug/reach` caps `cells` at 200, sorted by y** — the default reads like "the
  bot is in a 4-cell pocket" when `?limit=900` shows 1200 cells. Misleading
  diagnostic; a `truncated` flag (like the census has) would settle it.
- **`iron_age` and the iron pickaxe disagree**: progression's `iron_age` is
  satisfied by any `iron_(pickaxe|axe|shovel|sword|hoe)`, so a carried
  `iron_sword` closes it, while the adapter offers `mine_diamond_ore` only with a
  real iron **pickaxe**. The engine therefore believes the tier is done and never
  steers the bot to craft the pickaxe — the diamond milestone has no live path
  unless a chest happens to hold one.
- **`equip_armor` failed once** with `armor_equip_failed` while the bot held
  `golden_leggings` and `observe().armor` stayed empty. Only one attempt was made;
  not reproduced.

  Fixed (06/10/2026): the counter dump kept `armor_place_failed=1` and no
  `armor_take_failed`, so the **place** into the `armor` container had been
  refused and its status discarded. The action now closes a container an action
  has open, retries the place once with the cursor still loaded, fails typed
  (`armor_place_failed_<status>` plus `failures[].attempts`) and, when the
  aggregate shows armor no slot does, does one `_resyncByReconnect`
  (`armor_resync`) before declaring `no_armor_in_inventory` with the `carried`
  piece. The refusal itself stays open: no live attempt has printed its status
  yet.

## Death, the inventory mirror and the skeleton defense (06/10/2026)

Two more defects from the same mission, both seen *after* the audit rejected the
goal and both fixed with a regression test (see [log.md](../log.md), entry
*Three defects from the diamond mission*).

- **`recover_loot` duplicated the inventory.** `take_item_entity` confirms a
  pickup the BDS never echoes back in `inventory_content`, so the adapter keeps
  `this.pickups` as a mirror next to the inventory slots. Nothing cleared either
  on death, so after a death the same item was counted again (`iron_ingot`
  64 → 128, `coal` 64 → 128, `diamond` 3 → 5) and the subsequent deposit could
  never succeed (`take_failed_49`): the mirrored count and the real stack
  disagreed. Fixed: the death branch of `_onOwnHealth` calls
  `_forgetDroppedInventory('death')` (logged as `inventory_mirror_reset`, with the
  forgotten map), and a **full** 36-slot player snapshot absorbs the pickups
  (`_absorbPickups`, `pickups_absorbed`) while an empty snapshot never does.
  `tests/bedrock-inventory-mirror.test.mjs` pins the seven behaviours, including
  a pickup after the death counting from zero (2, not 5).
- **A skeleton inside the spawn house produced a death loop.** 5 deaths, hp 0,
  mode `emergency`, and the killer standing 3.3 blocks away with arrows landing;
  it was indoors, so daylight never burned it. The two harness-side causes of the
  bot not answering are fixed in [emergency](emergency.md) (`fight` was
  unreachable under the emergency filter, the shield was always removed).
  *Left open*: nothing makes the bot leave the mob's reach on respawn, and a
  skeleton that camps a spawn point is still a death loop — that needs a
  "respawn, then immediately move and fight" policy, not another option filter.
- **The deposit was declared successful on a prediction, not on the world.**
  `deposit_<item>` trusted the `ok` of its two stack requests and the adapter's own
  register, never the container — so it could log `container_deposit ok` while the
  chest read-back showed nothing, and a stack of 64 placed on a pile of 4
  overflows into a second slot that the `place` response does not even name. The
  step is now a **postconditioned operation**: the return carries
  `before/after {held, stored}` (`held` from the player slots, never the aggregate
  that still contains the pickups; `stored` from `_storageItemCountAfter`, which
  closes and reopens the container and counts the item in the fresh mirror, logged
  as `container_reread`), it fails `deposit_unverified` — logged as
  `container_deposit_unverified` with `takeStatus`, `placeStatus`, `playerReported`
  and the expected numbers — when the chest did not grow, and a stale-mirror
  failure (`missing_item`, `take_failed_49/50`, `place_failed_49/50`) is retried
  once after `_resyncByReconnect` (`retriedAfterResync`). `tests/bedrock-storage.test.mjs`
  pins the three behaviours; a second hole (a **short** player snapshot wiping the
  mirror after a reconnect, now `inventory_snapshot_ignored`) is pinned in
  `tests/bedrock-inventory-mirror.test.mjs`.

## The ten deaths of run 2: what was policy and what was a defect (06/10/2026)

The driver dumped the ten `death` events of `demo-r2` from the container ledger
with two minutes of context each. **Five are driver decisions, two are harness
defects (both fixed), and the count itself was wrong.** The driver-side ones:
three deaths while mining or descending with low health instead of eating and
retreating (20:32:22 at (88.5, 17.6, 208.5); 21:31:53 at (89.3, 20.6, 185.65)
after six failed `go_home` and the fall damage they cost; 21:37:29 at (90.6,
17.6, 180.5) while recovering the loot of the previous one), one `flee` that
failed (22:27:32 at (85.4, 73.6, 167.5)), and sending the bot to sleep in a base
that was **dark and unlit** — the torch crafting that would have lit it was
broken at the time (`5fa6f04`) — with a skeleton already inside.

- **One death wrote several `death` events.** `dead` is a client state: the
  fallback `_finishRespawn` clears it while the BDS still reports health 0, so
  the next health attribute re-entered the death branch and counted the same
  death again — four extra events at 22:24:00, 22:24:24, 22:24:48 and 22:25:16
  at the same coordinate, and a `respawn_reconnect { deadMs: 25023 }` that timed
  the last cycle rather than the death. Fixed: a death is an **episode**
  (`_deathEpisode`, health 0 → health > 0) and `alive_again` now fires even when
  `dead` was already closed by the fallback. See [respawn](respawn.md) and
  `tests/bedrock-death-episode.test.mjs`. The counter mismatch is data, not a
  bug: `deaths` is per process and restarts with the harness (10 ledger events,
  7 in the counter), so **the ledger is the record**.
- **Combat fought a ghost of the previous session.** The skeleton that killed
  the bot was revealed by an `entity_add` *after* the respawn reconnect — the
  entity list is rebuilt at the rejoin — with runtime id 508, while `_combat`
  held the 50 of the dead session, and `add_entity` had left the old runtime id
  in `this.entities` (pruning only clears it after 60 s without packets). The
  result was 25 `attack` packets whose `targetHealth` never moved from 12 and an
  `attack_skeleton` that answered `{ ok: false, error: 'died_in_combat', hits:
  25 }`: an iron sword doing literally nothing. Fixed in three places (a
  runtime-id tombstone on re-add, a census reset at `start_game`, and a
  `ATTACK_SILENT_HITS` re-lock in `_combat`), pinned by
  `tests/bedrock-entity-ghost.test.mjs`.
- **Still open.** Nothing makes the bot leave a mob's reach right after a
  respawn: a skeleton camping the spawn point is still a death loop, and it needs
  a *"respawn, then immediately move and fight"* policy — the same item left open
  in the skeleton-defense section above. It is a policy gap, not an option
  filter.

## The resync wedged the server (06/10/2026)

Run 2's deposit loop ended with the server refusing every new session:
`connecterror:9` on `[connect] attempt 5/6/8`, until the bot container was
restarted. The cause was the only refresh path the adapter had: `_resyncByReconnect`
dropped the session and reconnected immediately, purely to receive a fresh
`inventory_content` with new stack ids. `connecterror:9` is nethernet's
`ErrorCode.InactivityTimeout` (`node_modules/nethernet/src/signalling.js:18`,
armed at `src/client.js:210`): the negotiation never completes because the BDS
still holds the previous session, and the retry loop only piles up half-open ones.

Fixed in three parts, all pinned by `tests/bedrock-resync.test.mjs`: ask the
player window first (`_refreshInventoryFromServer` — `open_inventory` makes the
server send the 36 slots, no session touched), let the server settle before a
reconnect (`INVENTORY_RESYNC_SETTLE_MS`, 1500 ms), and refuse a second reconnect
inside `INVENTORY_RESYNC_COOLDOWN_MS` (30 s) with a typed
`inventory_resync_throttled`; a reconnect that fails or never spawns is reported
as `inventory_resync_wedged` instead of leaving a stale mirror silently. The
in-place refresh is skipped whenever it would destroy work in progress — any
other container open (a chest), a non-empty crafting grid, or a stack on the
cursor — so those paths still reconnect, after the settle delay.

*Open*: no live run has exercised the new path yet. Two numbers to watch in the
next round: whether the player-window refresh is enough for the deposit path
(there the chest **is** open, so it falls back to the reconnect by design) and
whether `INVENTORY_RESYNC_SETTLE_MS` = 1500 ms matches this world's session
release time. Both are guesses, not measurements.

## The crafting grid and the torch the server refused (06/10/2026)

`craft_torch` failed in run 2 of the diamond mission with a bare
`craft_failed` (status 35) twice in a row, 7 s apart, at the same position — and
the failure detail showed the adapter did not even know what it had put in the
grid:

```json
{"item":"torch","network_id":1897,"width":1,"height":2,
 "input":["name:minecraft:charcoal","name:minecraft:stick"],
 "grid":[{"slot":30,"name":0,"count":1},{"slot":28,"name":0,"count":1}],
 "status":35}
```

The two `place` requests into the grid had just been answered `{"statuses":["ok"]}`,
and 40 ms earlier the same path had crafted `spruce_planks` (4) and `stick` (4)
through the very same slots 30/28. So the layout and the tag matching are not the
cause: `_ingredientMatches` already maps the `coals` tag onto `/^(coal|charcoal)$/`,
and recipe 1897 names `charcoal` and `stick` explicitly.

Three code-level defects were fixed (all with regression tests in
`tests/bedrock-crafting.test.mjs`):

- **The grid model never learned what it placed.** `_placeFromCursor` called
  `_applyStackResponse(response)` **without** a `networkId`, and it runs right
after `_clearCraftingGrid`, so the only identity a cell could record was
  `network_id: 0` — the `name: 0` in the log above. It now passes the source
  slot's `network_id` (read *before* the take: a one-item pile disappears from
the slot and takes its id with it) and records the cell even when the response
does not name it, logging `craft_grid_place` with `{gridSlot, item, count,
  stackId, echoed, containers}`. `echoed: false` is the evidence that the server
  is not echoing the `crafting_input` container back at all.
- **A rejected variant stopped the search.** `_craftAttempt` returned on the
  first `craft_failed`, so with two torch recipes declared by the server
  (`tag:coals` 1896 and `name:charcoal` 1897) a refusal of 1897 meant 1896 was
  never tried — even though the bot carried both coal and charcoal. It now keeps
  the first failure and continues to the next candidate, returning it only when
  no variant passes.
- **A status 35 was never retried.** `craft_failed` joined the `syncable` set in
  `_craftItem` (`missing_ingredients|craft_failed|take_failed_49/50|place_failed_49/50`),
  so it gets **one** `_resyncByReconnect` and one more attempt. That is safe
  because the `finally` of `_craftAttempt` already returns the grid to the pack
  (`_clearCraftingGrid` + `_returnCursorToInventory`), so a retry re-reads the
  world instead of replaying a stale model.

`craft_failed_detail` now also carries `consumeStackIds` — the cell → stack id
pairs actually sent in the `consume` actions — and each grid cell's `stack_id`.
Together with `craft_grid_place` that is what a live round needs to answer the
question the packets would answer.

**Still open**: the 35 itself is not explained. `runs/demo-r2/events.jsonl` has
no `packet`/`rx_hex` events in that window (`BEDROCK_PACKET_LOG=1`, which run 1
had with `packet=179151`), and the torch is absent from the `recipe_sample`
(720 rows covering only `wooden_pickaxe` and `stone_pickaxe`, i.e. its variants
and their network ids are unknown). The decisive cheap experiment is to repeat
`craft_torch` carrying **only** coal, then **only** charcoal: if the coals variant
fails identically the problem is in the consume/stack-id path, if it passes the
35 was the charcoal variant.

## Told facts (2026-10-07) — live over HTTP, the in-game chat round still open

The four memory operations and the movement order are implemented and
unit-tested ([verification](verification.md) 47.58–47.59,
[human command](human-command.md#told-facts-m10-the-human-teaches-the-bot-remembers),
[TOLD-FACTS](../raw/TOLD-FACTS.md)). What is still open:

- **The in-game chat round.** The runtime is deployed on the production
  harness (VM 100, `hermes-jev-bedrock`, commit `c70acc5`, 07/10 14:0x UTC) and
  the feature was then driven **live against the real world memory** with the bot
  connected to BDS 1.26.52: created at 92/74/169 → repeated (`unchanged`, no
  history row) → corrected to 130/70/-240 (same id, `historyCount` 1,
  `previous` kept) → **survived a container restart** → forgotten (`invalid`, out
  of `/memory/places`, still there with `includeInvalid=1`); a claim of 5 iron on
  a chest the bot had already read (91/73/160) added the label «baule di casa»
  and a `unverified` claim while the observed 411 stayed and the container kept
  `source: 'discovered'`/`permanent: false`; `/options` (25 keys) and `/survival`
  still answered after the deploy. What has **not** run is the part only a human
  can do: no sentence of this feature has been **typed into a live BDS**, so the
  chat *reply* path (`replyChat`, `saySmart`) is still exercised with a scripted
  harness, exactly as for the other chat milestones — dictate a place at the
  speaker's own coordinates from in-game chat, restart the bot, ask for it,
  correct it, and check that the answer names the provenance. The
  `CHAT_ALLOWLIST` gate on the writes answered 403 `told_sender_not_allowed` for
  a sender outside it in the integration tests and in the local live round; on
  the production container `CHAT_ALLOWLIST` is **not** set, so the gate is inert
  there (the route is as open as `/act` on the loopback API).
- **`told_goto` still verifies a plain waypoint.** The plan carries
  `notes: human:<from> told_place:<id>`, but success is the ordinary arrival at
  the coordinates; nothing checks that the position the bot reached **is** the
  remembered one (or that a corrected place moved the destination). A future
  slice should close the loop with the place id.
- **Two names for one place create two records.** The create-vs-correct
  decision is made on the **exact** name: «il campo» and «campo di patate» are
  two places pointing at the same field. The ambiguity reply is the safety net
  (`ho 2 posti chiamati "…"`), not a fix — a synonym/alias relation would be the
  real one.
- **No expiry is offered to the human.** A named place is `permanent` by
  construction and a claim ages after `toldClaimStaleMs` (7 days, a constructor
  option, not an env var), but nothing lets the human say «this one expires in a
  week». Deleting/invalidating by hand is the current answer.
- **No `q_memory` question intent.** The request spoke of routing recall through a
  new question intent; the implementation answers **consult** deterministically in
  `handleToldFact`, before `resolveQuestion`, so a memory question costs no model
  call and `QUESTION_INTENTS` is untouched. The cost is the other side of the
  same coin: a memory question phrased in a way `memory-chat.mjs` does not
  recognise falls to the ordinary flow (Hermes, semantic recall) instead of being
  routed to the memory. A `q_memory` intent is the natural fallback if that shows
  up in the field — it would be the only part of this feature that needs a model.
  Related: a told landmark has no relations to update (it is not linked to a
  concept node), so a correction only has to move the record and the derived
  index — which it does.
- **The console is not wired.** `feat/companion-webconsole` (another session)
  is the "future console" the routes were shaped for; nothing here imports it
  and no code depends on it.

## The chat replies that were not true (2026-10-07)

The four defects the owner found by reading the live chat are fixed and each is
pinned by a test that fails without its edit ([verification](verification.md)
47.60, [CHAT-REPLY-TRUTH](../raw/CHAT-REPLY-TRUTH.md)). What is still open:

- **The deploy has now run, except the ore alert.** Per the owner's report of
  2026-10-07 the chat engine **M7 is on for the first time** together with
  «ragiona» (M12) and the rest of branch `fix/told-parse-guards`: the controller
  fixes (the order-target floor, the sender, the rate-limit retry, the parser
  guards) ship with a controller restart, and that restart has happened. The ore
  alert lives in the **adapter and the harness**: its code is already copied into
  `hermes-jev-bedrock:/app`, but the **running process still predates it**, so it
  needs a `hermes-jev-bedrock` container restart (the bot leaves and rejoins
  ~30 s, and a BDS restart is sometimes needed for stale peer state). It has NOT
  been restarted — the owner decides when.
- **The order-target floor is a cap, not a proof.** If the planner empties
  `plan.targets`, the order falls back to the targets it was born with; but a
  goal whose original order had no numeric target at all («seguimi») still
  closes on the waypoint rule. No test covers "the order had targets and the
  planner *changed* them to a harder set".
- **The ore alert is unheard.** `ORE_ALERT` (default `diamond`, five-language
  sentence from the catalogue, one message per vein, `ORE_ALERT_COOLDOWN_MS`
  between two alerts) has never been read in game: the timing during a follow
  and the wording in the other languages are unverified, and the alert only
  speaks for ores the census already found (`ORE_ALERT_RANGE`, default 32).
- **«ragiona» has now met a real provider (in Italian only).** The marker, the
  stripped sentence, the reasoned prompt and the token budget are unit-tested
  and the owner reports a live end-to-end Italian round against the real
  provider: a normal answer in 868 ms and a reasoned one in 886 ms. With thinking
  left on the line came back **empty** (`finish_reason: 'length'`), so the client
  now sends `{"thinking":{"type":"disabled"}}` for the chat line (the greeting
  does not pay for reasoning) while «ragiona» raises the budget to 2000 tokens.
  What is still open: the German/Spanish/French wording, the word list
  (`DEFAULT_REASON_MARKERS`) as a translation review, and the real cost of a long
  answer. `CHAT_REASON` follows M7: with no key there is no reasoned answer at
  all.
- **M7 was off in production, and is now on.** The controller environment used
  to have no `DEEPSEEK_API_KEY` and no `CHAT_LLM_*`, so every "frase fatta" the
  owner read *then* was the deployed configuration, not a defect. The active
  configuration reported on 2026-10-07 is the intended one:
  `CHAT_LLM_URL=https://api.deepseek.com/chat/completions`,
  `CHAT_LLM_MODEL=deepseek-flash`, `CHAT_LLM_THINKING=off`. `CHAT_LLM_API_KEY` is
  the canonical name (`DEEPSEEK_API_KEY` is the legacy alias still honoured by
  `chatLlmKey`, and asserted by `tests/chat-llm.test.mjs`): keep the alias
  commented in `.env` and carry only the canonical one in a production env.
- **`saySmart` never sees a rejection.** `replyChat` retries once on
  `rate_limited`; two messages inside `CHAT_MIN_INTERVAL_MS` still lose the
  second one if the retry also lands inside the window (the backoff is bounded
  at `CHAT_REPLY_RETRY_MAX_MS`, 4000).
- **Two circuit blueprints are orphans.** The R0 inventory
  (`node tools/capability-inventory.mjs`) reports `auto_door` and `delay_line` as
  `buildable` blueprints that no skill declares as a success criterion
  (`success.circuitBuilt.id`), so no milestone can currently ask for them. Either
  wire them into a skill/milestone or document them as unused fixtures.

## The live chat engine now runs the roadmap (2026-10-08)

- The `hermes-jev-bedrock` container — the harness behind `/observe`, `/options`,
  `/act`, `/say`, `/memory/*` and now `GET /capabilities` — was rebuilt on
  08/10/2026 from the pushed commit `a2f68d5`, so the R7 contract route and the
  M11 ore alert are live (row 47.70 of [verification](verification.md)).
- The **controller** is a separate process, started from a release snapshot
  (`/opt/data/minecraft-releases/<release>`) inside the `hermes` container. On
  08/10/2026 the `chat-truth-ce8dea7` snapshot (the M7–M12 chat engine deployed on
  07/10) was swapped for `chat-truth-4e9f2c0`, built from the same pushed commit:
  the R2 clarification gate, the R3 plan trace, the R4 typed step failures and the
  R5 composite goals are now in the running planner loop, and the live controller
  wrote its first `plan-trace.jsonl` segment. The swap is a release deploy, not a
  container rebuild, and it interrupts the live chat engine for a few seconds —
  which is why it stays the owner's decision rather than an autonomous one.
