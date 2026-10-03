# Final report — P0 → P7 campaign (2026-10-02 → 2026-10-03)

Synthetic close-out of the priority campaign run against the goal contract
(`P0 → P7`, one front at a time, live evidence for live-only tasks). Every claim
below is backed by a repo commit, a unit test file or a live probe recorded in
[verification](verification.md).

Session shape: **51 commits**, suite **466 → 987 tests** (`node --test
tests/*.test.mjs`, 75 files), 11 of 23 goal tasks complete, 1 skipped as an
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
| **R4** persistent placement ledger + `mine_owned` | `d866a5b` | route and refusal live (`GET /memory/placements` → `count: 0`; `mine_owned` → `nothing_owned_nearby`, `owned: 0`, 1 ms, logged as an action); the positive cycle is block-tested because the room offers nothing to place |

## 2. Improved but not complete

- **Riding**: `mount_donkey` → `mount_not_confirmed` after 20–26 s. The server
  receives ten `interact` and answers with the donkey's saddle inventory, never a
  `set_entity_link`; two packet shapes tried, both ignored. Code, readiness
  filters and typed errors are done; the confirmation needs an external capture.
- **Companion happy paths**: `tame_<type>`, `shear_sheep`, `breed_<type>`,
  `attack_<animal>` answer typed refusals live (`missing_feed`, `missing_shears`,
  `need_2_feed`, `cannot_reach_target`); no sheep/bone/iron/rod is available and
  the animals sit outside the walkable component.
- **Everything that needs walking** (companion happy paths, fishing, containers,
  trade, mounting, crop harvesting): the bot's walkable component is **one cell**
  (see the blocker below), so `path_failed`/`target_not_found` is the honest
  answer until the room is addressed.
- **Fishing**: bite detection rewritten from the `fish_hook_hook` event (the cast
  descent used to be read as a bite); live only `missing_fishing_rod`.
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
  reconciles, reaches and removes; live it only answers the refusal
  (`nothing_owned_nearby`), because the room offers nothing to place (inventory
  `{dirt: 1}`, and `place_*` exists only for `crafting_table`/`furnace`/`torch`/
  `bed` or a redstone component). The two probe blocks that seal the room predate
  the ledger, so no action can claim them.

## 3. Blockers (root cause, attempts, next action)

| Blocker | Root cause | Attempts | Next action |
|------|------|------|------|
| No human player ever joins the BDS | Environmental (user-declared, m01312) | Chat order flow, allowlist, stale-inbox and self-echo handling all fixed and live-verified with the bot's own echo | Keep the multiplayer/social items documented as blocked; a real player would unblock chat orders, escort and the mount/trade captures at once |
| Entities and containers outside the walkable component | The bot lives in a sealed room; the walkable BFS component is now **one cell** — east/west are the room's beds, north/south are the two blocks the P5 probes placed (`place_crafting_table`, `build_hut`) | Reachability filters, typed errors, `movement timeout` findings, `placeReach` per-neighbour diagnostic | Answer the room question (m01403): remove the two probe blocks from the console (and, if needed, the two carpets closing the corridor), or ship a bot-owned cleanup action — or accept the room and stop claiming those live rounds |
| BDS 1.26.52 ignores `player_action respawn` | Server-side bug (health never restored) | `respawn` packet state 2, `PACKET_DEBUG=1` packet dump | Mitigated by the auto-reconnect watchdog; a clean in-place respawn stays impossible |
| Mounting and the trade window are never confirmed | The server wants a trigger the vanilla client produces; no capture available | M0+ two packet shapes for the mount, `npc_open` + `item_interact` for the trade | Capture a real client mounting a saddled donkey and opening a trade |
| Live crop growth was `null` | `findBlocks` spread the prismarine Block, losing `getProperties()` | Added `_properties` fallback, then stopped spreading | Resolved (`growth 7/7/6/6` live); kept as a regression test |

## 4. Tests

- `node --test tests/*.test.mjs` → **1045 pass / 0 fail** (81 files). The one flake
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
  fronts, the placement ledger (route + refusal).
- `npm run wiki:lint` → no errors (39 files, 416 relative links).
- **Deployment parity re-checked** after the last front: `md5sum` of every
  git-tracked file outside `docs/` and `tests/` compared against the live
  container's `/app` → **119 local / 114 in the container, no differing file**;
  the five local-only paths are build inputs and local drivers (`Dockerfile`,
  `docker-compose.yml`, `.gitignore`, `explore-find.mjs`,
  `tools/respawn-capture.mjs`). So the live evidence in
  [verification](verification.md) was produced by the code at HEAD, not by a
  stale copy.

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
  and 47.1–47.25) plus a `log.md` entry per front.
- The separate private homelab wiki (outside this repository) got one section per
  front on its Minecraft page, plus a summary bullet, an open-questions row and a
  log entry for each front; both wikis are kept in sync at the end of every front.

## 7. Next five tasks, ordered by technical dependency

1. **Unblock the live environment** (m01403): answer A/B/C on the room. The
   cheapest version is removing **only the two blocks our own probes placed**
   (`setblock 115 73 160 air`, `setblock 115 74 158 air`); if that is not enough,
   the two carpets that close the corridor to the door. Almost every remaining
   live-only item (companion, fishing, containers, trade, mounting, crops) sits
   behind it. The no-console variant exists now (`mine_owned` over the persistent
   R4 ledger), but it can only claim blocks placed **after** the registry shipped:
   the two probe blocks that seal this room were placed before it and are not in
   the ledger, so the console edit is still the only way to remove those two.
2. **Packet capture from a real client** (mount, trade, swim): one capture unblocks
   `p2-riding`, `p2-trade-timeout` and fluids M1 with the same work.
3. **`p2-companion` / `p2-fishing` happy paths**: need iron ingots (shears, bucket,
   shield), a bone and a fishing rod — a deterministic supply chain goal, then the
   live rounds.
4. **Exploration M6 deep side**: cave systems beyond the loaded radius, plus the
   structure→vector-index integration for "the iron-rich cave near the mountain".
5. **Dragon fight** (`beat_the_dragon`): the `bossDefeated` criterion exists and is
   real, but crystals, the perching phase and the pursuit logic do not — the
   largest remaining capability gap, and the only one with no live path yet.

## Related pages

- [Verification](verification.md) — the per-capability table these claims rest on.
- [Open questions](open-questions.md) — blockers with root cause and attempts.
- [Roadmap](roadmap.md) — the long-term shape, milestone by milestone.
