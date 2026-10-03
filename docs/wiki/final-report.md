# Final report — P0 → P7 campaign (2026-10-02 → 2026-10-03)

Synthetic close-out of the priority campaign run against the goal contract
(`P0 → P7`, one front at a time, live evidence for live-only tasks). Every claim
below is backed by a repo commit, a unit test file or a live probe recorded in
[verification](verification.md).

Session shape: **66 commits**, suite **466 → 1069 tests** (`node --test
tests/*.test.mjs`, 79 files), 14 of 23 goal tasks complete, 1 skipped as an
environmental blocker.

## 1. Completed (code + tests + live where required + docs)

| Front | Commit | Live evidence |
|------|------|------|
| **P0** episodic → semantic consolidation | `0c10489`, `8a1b2ad` | `POST /memory/consolidate` twice → the second run answers `already_consolidated` (idempotence, live); `GET /memory/hints` returns the productivity hint with its source episodes |
| **P1** goal → mission end-to-end | `166d97c` | live chain: goal ingestion → plan → mission → action → feedback → typed close; the mission-leak fix verified with a deliberately broken model (`GOAL ERROR`, mission `failed`, exit 1) |
| **P3** `CURRICULUM=first_night` | `69f9070`, `db358b8` | **GOAL MET after 25 actions**: `acquire_wood`, `acquire_crafting_table`, `obtain_food`, then `first_night SUCCESS {sawNight:true, health:20}` |
| **P4** milk, mature crops, shield, chat M5 | `b199e3d`, `bc98b66`, `cead846`, `a9bfc41` | typed refusals live + crop states readable live (`growth 7/7/6/6`) + `eat` with an inventory delta |
| **P4** exploration M1/M2/M4/M5/M6 | `0c28ab8`, `596dd3e`, `0e87a20` | route replay `arrived` with a `replay_of` edge; `block:oak_log` search `found:true count:16`; village detection (score 6) and a cavity (`air below: 831`) |
| **P5** travel kit | `f45a35b` | `place_torch` confirmed by `mine_torch`; `pillar_up → no_headroom` (headroom 1); `build_hut` placed one block and skipped 8 already-solid cells |
| **P6** observation log + vector index | `8e25cbd` | 44 documents / 2048 dims reindexed live; `"productive dirt site"` returns the consolidated site first (0.407) |
| **P7** fluids M0 → M6 | `cbd1f46`, `b1a16ba`, `aca2ac6`, `520e891`, `e0fb3cf`, `c380ef9`, `ef88074` | M0–M6 all have a live refusal round; a real server effect (`water_breathing`) recognised and counted down; `CURRICULUM=water_travel` accepted and run |
| **P7** redstone R0 → R6 | `3fe52b2`, `768e0eb`, `3312061`, `55c73a5`, `b144557`, `cb61f62`, `df0c52a` | censuses, typed refusals, `CURRICULUM=redstone_automation` forwarded to the BDS |
| **P7** nether/End N0 → N7 | `c761ae4`, `985f783`, `7ae4717`, `bda3d4f`, `d62f6c6`, `ff6b31b`, `6962101`, `9d2a32d` | projectile captured in flight, gaze/mask/pearl probes, fortress search, six endgame actions refused in 19–21 ms |
| **P2** harness reliability | `23c25c0`, `3fad8e1`, `ddf6426`, `068b64c`, `db8e9fa`, `5c88d4c` | reachability turned a 30.4 s hang into a 19 ms `container_unreachable`; the action lock now always releases (`action_timeout`) |
| **P6** semantic recall in the planner | `9400f45` | `semantic_recall` live: query built from the goal, three hits, `error: null`, planner prompt carrying the lines |
| **P6** hit → real waypoint | `937244c` | live refusal, honestly: all three hits came back `reachability_unknown`, so `semantic_waypoint_skipped` and no destination was invented |
| **P6** episodic retention (dry-run first) | `8b5d2e6` | `POST /memory/prune` live: dry-run lists 40 candidates, a real run with `keepMissions: 50` deletes nothing and every count stays identical |
| **P6** observation-log retention (dedupe + prune) | `cd5d4f9` | live 5654 rows → **32 facts / 131 rows**, same search hits and scores before/after, then **0 growth in 180 s** with the write-side dedupe on (was ~280 rows/min) |
| **R4** persistent placement ledger + `mine_owned` | `d866a5b`, `7553510` | route and refusal live (`GET /memory/placements` → `count: 0`; `mine_owned` → `nothing_owned_nearby`, `owned: 0`, 1 ms, logged as an action); **then the positive cycle live too**: `craft_crafting_table` → `place_crafting_table` at `(106,71,151)` → 1 ledger record → `mine_owned` → ledger back to 0 |
| **P2/P4** iron take, 3×3 crafting, bounded container read | `92dd7ed` | live: `take_iron_ingot` → 64 → `craft_bucket` → **`milk_cow`** (`milk_bucket`); `craft_shears` → **`shear_sheep`** (`sheared:true`); `harvest_carrots` (2 carrots + replant, server-confirmed); `read_container` 66 s `ok:true`; typed refusals (`tame_cat` `missing_feed {cod/salmon}`, `open_trade` `trader_unreachable`, `mount_donkey` `no_rideable_nearby`). Rows 47.32–47.34. |
| **P2/P4** low surfaces, the equip inventory window, the door trap | `7553510` | the bot walked out of the room that had sealed it (`green_carpet` corridor, `{distance: 2, pathNodes: 7`}`, then a 38-node walk to the potato field); `harvest_potatoes` live end-to-end (growth read, server-confirmed break, replant); `read_container` read 7 chests; `take_shield` live from a village chest; the take fixed at the source (`_ensureInventoryOpen`) so the failure moved to the offhand place (still 50); the door a villager closed on the bot's cell opened by the bot itself (`[door_opened] {key: '90,73,163'}` → `pathNodes: 5`), with no world edit |

## 2. Improved but not complete

- **Riding**: `mount_donkey` → `mount_not_confirmed` after 20–26 s. The server
  receives ten `interact` and answers with the donkey's saddle inventory, never a
  `set_entity_link`; two packet shapes tried, both ignored. Code, readiness
  filters and typed errors are done; the confirmation needs an external capture.
- **Companion happy paths**: the shearing chain ran live — `take_iron_ingot` (64)
  → `craft_shears` → **`shear_sheep` → `{ok:true, sheared:true}`** — and milking is
  complete (`craft_bucket` → `milk_cow` → `milk_bucket`, row 19.2), but the
  **tame** path is still refused live (`missing_feed {feed: cod/salmon}`): the only
  raw fish the bot owned was lost with an inventory, the village fish chest now
  reads empty, and no bone exists. `breed_<type>`/`attack_<animal>` remain as
  typed refusals (`need_2_feed`, `cannot_reach_target`).
- **Container reads on a live server**: fixed twice (stale window contents, the
  six-blocks-per-name scan) and bounded, but the **BDS still drops the session
  during a read** at unpredictable lengths (66 s once, 140 s twice) — see the
  blocker table and open questions. The action now survives the drop and reports
  what it read instead of dying on the watchdog.
- **Everything that needs walking — unblocked 03/10**: the walkable component was
  one cell because low surfaces (`green_carpet`) read as walls; after the
  `_lowProfile` fix the bot left the room on its own, so the walking rounds are
  possible again (crops and the containers were then verified live). What remains
  out of reach is no longer geometry: the mount/trade/swim confirmations need a
  real-client capture, and the farm census has no cow and no sheep.
- **Fishing**: the supply chain is proven live (chest string → `craft_spruce_planks`
  → `craft_stick` → **`craft_fishing_rod`**), the bobber floats in the village pond
  (`fishing_hook` at y=75 over a 256-block body of water) — but the **bite never
  arrives**: five `fish` runs answer `note:'no_bite'`, `grep -c fish_bite` over the
  event log is 0, the hook despawns after ~40 s. The `_onEntityEvent` guard that
  swallowed a bite (entity resolution before the event id) is fixed and tested; the
  missing signal needs a real-client capture, like the mount/trade/offhand family.
- **Trading (`p2-trade-timeout`)**: the budget defect is fixed and tested
  (`_waitTradeResult`/`_tradeAt`); the window still never opens
  (`trade_not_opened` with the vanilla `npc_open` packet and the `item_interact`
  auth flag both tried).
- **Fluids M1 (swim)**: wading and a simulated air budget exist; the real swimming
  physics (`start_swimming`/`want_up`/`want_down`, `delta` handling) is
  deliberately not guessed — it needs a capture of a real client swimming.
- **Redstone/Nether happy paths**: circuits are declaratively planned and the R6
  safety limits are live-probed, but no lapis/redstone/obsidian/glowstone exists
  in the live world, so the builds themselves are unit-tested only.
- **Placement recovery (`mine_owned`)**: the ledger is persistent and the action
  reconciles, reaches and removes — **live both ways now**: outside the room the
  bot crafted a table, placed it (`place_crafting_table` → 1 ledger record),
  `mine_owned` removed it and the ledger returned to 0. The two probe blocks that
  sealed the room predate the ledger, so no action could ever claim them (they are
  gone anyway, and the room opened without a console edit — see open questions).

## 3. Blockers (root cause, attempts, next action)

| Blocker | Root cause | Attempts | Next action |
|------|------|------|------|
| No human player ever joins the BDS | Environmental (user-declared, m01312) | Chat order flow, allowlist, stale-inbox and self-echo handling all fixed and live-verified with the bot's own echo | Keep the multiplayer/social items documented as blocked; a real player would unblock chat orders, escort and the mount/trade captures at once |
| ~~Entities and containers outside the walkable component~~ (resolved 03/10) | Low surfaces (`green_carpet`) read as walls, so the bot's feet cell was solid and the walkable component stayed one cell wide; the server also refused to move a bot whose own cell held a closed door | `_lowProfile`, `_selfCells`/`ignoreSelf`, `_doorAhead` (rows 47.27/47.28) | Closed: the bot walked out by itself (`y 73 → 72.62`), crops and containers were verified live, and a door closed on its cell now opens from the inside. No `setblock`, no world edit — (A)/(B)/(C) is moot |
| BDS 1.26.52 ignores `player_action respawn` | Server-side bug (health never restored) | `respawn` packet state 2, `PACKET_DEBUG=1` packet dump | Mitigated by the auto-reconnect watchdog; a clean in-place respawn stays impossible |
| Mounting and the trade window are never confirmed | The server wants a trigger the vanilla client produces; no capture available | M0+ two packet shapes for the mount, `npc_open` + `item_interact` for the trade | Capture a real client mounting a saddled donkey and opening a trade |
| The BDS drops the session during a container read | NetherNet data-channel close (`connection.js:31,35,43,47` → `_lifecycleCloseReason`), not a kick and not an idle timeout: no `kicked` event, `player_auth_input` every 50 ms | Eight drops on 03/10, seven around a `read_container` (two after ~140 s, one at 180 s, one mid-read at 66 s with 8 windows); the adapter caps the read (8 containers, 90 s, 8 s per walk) so the action survives, and `connectLoop` restores the bot by itself (observed twice, inventory intact) | A bounded experiment separating "many window cycles" from "a long walk with no movement" by watching the console timestamps |
| Live crop growth was `null` | `findBlocks` spread the prismarine Block, losing `getProperties()` | Added `_properties` fallback, then stopped spreading | Resolved (`growth 7/7/6/6` live); kept as a regression test |

## 4. Tests

- `node --test tests/*.test.mjs` → **1068 pass / 0 fail** (79 files). The one flake
  that used to appear under full-suite load
  (`tests/bedrock-circuits.test.mjs`, "a different delay is an error", which
  measured real tick timing) is **fixed**: the delay measurement reads an
  injectable clock (`this._now`) and the fixture drives it, so the numbers are
  exact; 15 sequential runs and 4 parallel runs under CPU load are green.
- Purely unit-tested modules added: consolidation, observation log, vector index,
  `structures`, `exploration`, `bedrock-fluids`, `bedrock-air`, `bedrock-dive`,
  `bedrock-waterfall`, `bedrock-lava`, `bedrock-bucket`, `bedrock-redstone`,
  `circuits`, `bedrock-nether`, `bedrock-end`, `human-replies`, action-lock, and
  the placement ledger on both storage backends.
- Live rounds performed (each in [verification](verification.md)): goal→mission,
  curriculum `first_night`, consolidation idempotence, mining/pickup, chat M5,
  crops, milk, shield, travel kit, exploration M2/M4/M5/M6, fluids M0–M6, redstone
  R0–R6, nether N0–N7, P2 refusals, semantic recall and waypoint, both retention
  fronts, the placement ledger (route + refusal), the iron take → 3×3 craft →
  milk → shear → carrots round, and the bounded container read (66 s, `ok:true`,
  session drop survived).
- `npm run wiki:lint` → no errors (39 files, 421 relative links).
- **Deployment parity re-checked**: a full `git ls-files` + `rsync` + `docker cp`
  re-deploy followed the container rebuild (`docker compose up -d` drops every
  `docker cp` overlay, and enabling `BEDROCK_DEBUG=1` needs a recreate — a live
  trap now written down). Every tracked file is in `/app` and the adapter md5 in
  the container equals the md5 at HEAD (`c7827c9f…`), so the live evidence in
  [verification](verification.md) was produced by the code at HEAD. The tracked
  `Dockerfile` is part of that sync; the local-only paths are `docker-compose.yml`,
  `.gitignore`, `explore-find.mjs`, `tools/respawn-capture.mjs`.
- **`BEDROCK_DEBUG` is off** in the running container: `/debug/reach` answers
  `{"error":"unknown route"}`, so the `/debug/*` routes (and `/debug/mine`, which
  bypasses `DIG_PROTECTED`) are unreachable until the env var is set and the
  container recreated. The earlier note about leaving `BEDROCK_DEBUG=1` on during
  the door-trap diagnosis is superseded: the deployed container does not have it,
  and the flag must be *empty* (or absent) in `~/hermes-jev-bedrock/.env` before
  closing the session.

## 5. Main changes

- **Memory**: consolidation into productivity hints with provenance,
  `observation` table (schema v5 in both backends), derived vector index, new
  routes `GET /memory/hints|observations|search`, `POST /memory/consolidate|materialize|reindex`.
- **Harness**: ~25 new `/observe.*` and `/debug/*` routes (fluids, dive, waterfall,
  lava, bucket, end, portals, circuits, memory, reach, packet-debug), `POST /say`.
- **Adapter**: reachability primitive, mature-crop gate, milk/shield/offhand,
  travel kit, structure/cavity detector, fluid census + hazard ladder, waterfalls,
  lava shores and the bridge, buckets/boats, circuit builder, nether hazards, gaze
  discipline, endgame, and an action watchdog.
- **Survival layer**: new conditions (`inWater`, `lavaWithin`, `waterBreathing`,
  `onWaterfall`), needs/intents for fluids and redstone, 4 spatial verifier
  criteria, 9 fluid + 6 redstone skills, 6 progression milestones.

## 6. Wiki

- Repo `docs/`: new pages `respawn.md`, `final-report.md`; new milestone sections
  and rows in `memory.md`, `exploration.md`, `fluids.md`, `redstone.md`,
  `nether.md`, `companions.md`, `control-flow.md`, `roadmap.md`,
  `open-questions.md`, `survival-intelligence.md`, `verification.md` (rows 42.x
  and 47.1–47.34) plus a `log.md` entry per front.
- The separate private homelab wiki (outside this repository) got one section per
  front on its Minecraft page, plus a summary bullet, an open-questions row and a
  log entry for each front; both wikis are kept in sync at the end of every front.

## 7. Next five tasks, ordered by technical dependency

1. **Finish the shield round the honest way** (row 19.3): the take is fixed and
   live, the `place` into `offhand`/0 still answers 50. Probe it with
   `POST /debug/isr` (any stack-request shape, no code change) — note that
   `BEDROCK_DEBUG` is **off** in the running container, so the route must be
   enabled and the container recreated first — and, if a real
   client ever joins, capture one equipping a shield — the same capture family as
   mounting a saddled donkey, opening a trade window and swimming (M1).
2. **Packet capture from a real client** (mount, trade, swim, shield offhand, and
   the container-read session drop): one capture unblocks
   `p2-riding`, `p2-trade-timeout` and fluids M1 with the same work.
3. **`p2-companion` tame happy path**: the supply chain is now live
   (`take_iron_ingot` → `craft_bucket`/`craft_shears`, `shear_sheep` verified), so
   the only missing ingredient is **raw fish** — the village fish chest now reads
   empty. Either fish for one (a rod is 3 sticks + 2 string: spiders, or another
   chest) or find the fish in another chest; then `tame_cat` is a straight live round.
4. **The BDS session drop during container reads** (row 47.34): the action is
   bounded and survives now, but the trigger is unknown. A bounded experiment
   (reads whose walks all succeed vs reads with failing walks, watching the console
   timestamps) would settle whether it is the failed walking traffic or the number
   of windows opened.
5. **Dragon fight** (`beat_the_dragon`): the `bossDefeated` criterion exists and is
   real, but crystals, the perching phase and the pursuit logic do not — the
   largest remaining capability gap, and the only one with no live path yet.

## Related pages

- [Verification](verification.md) — the per-capability table these claims rest on.
- [Open questions](open-questions.md) — blockers with root cause and attempts.
- [Roadmap](roadmap.md) — the long-term shape, milestone by milestone.
