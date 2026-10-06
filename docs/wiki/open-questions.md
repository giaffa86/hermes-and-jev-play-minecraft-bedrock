# Open questions

Known issues, blockers and verification gaps. Sources: `BEDROCK.md` (Known issues)
and `docs/raw/SURVIVAL-INTELLIGENCE.md` (Verification status). For the per-
capability collaudo checklist (done / pending live), see
[verification](verification.md).

Last lint: 2026-10-04.

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
  is `_resyncByReconnect` (`bedrock-adapter.mjs:5889`), which logs `inventory_resync`
  first — that is not what happened in any of these drops.
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

- **Deep Dark W0/W1: the model is offline, the world has nothing to test it
  against (2026-10-06).** The vibration model and `sneak_to` are unit-tested (25
  cases) but every number comes from the reference rather than the deployed
  build: the 8-block sensor sphere, the player-vibration → shrieker relay, the
  sneak silence (the ceiling `SNEAK_SPEED_CEILING_MPS = 2.6` is a guess about a
  Bedrock server, not a measurement), wool occlusion and the 3-shriek summon.
  The `ancient_city` marker rule has never fired live and no Deep Dark is within
  reach, so the gate is an expedition (W4) or a disposable world copy; the W3
  round (a Warden summoned on purpose) additionally needs explicit consent,
  because the world is shared. A cheap first probe: `GET /observe.sculk` next to
  any sculk and a `sneak_to` on flat ground, to compare the measured speed with
  `WALK_SPEED`. See [deep-dark](deep-dark.md).
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
Two open design questions follow from that framing:

- **First-class `subgoal`**: add a `subgoal` field to the plan and let Hermes
  keep `objective` stable while rotating `subgoal`/`targets`/`skill`
  (receding-horizon). Today `subgoal` exists only implicitly (the `milestone`
  field in curriculum mode, the `skill` field in free-goal mode).
- **Multi-branch progression**: `resolveMilestone` returns a single deterministic
  `next` (DFS first-hit) — no OR/alternative-path semantics. To support copper /
  iron / exploration paths the graph needs branch nodes and a Hermes scoring
  hook, while Jev stays one-action-at-a-time.

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
