# Sources

Catalog of the raw sources for this wiki. Sources are immutable; the wiki layer
(`wiki/`) synthesizes and links them. Private sources (`.private/`) are listed but
never committed.

## Primary sources

| Source | Location | Role |
|---|---|---|
| `README.md` | repo root | Project overview, setup, demo, results, design notes. |
| `AGENTS.md` | repo root | Agent notes: what this is, entry points, env vars, architecture gotchas. |
| `BEDROCK.md` | repo root | The operational runbook for the Bedrock port (components, deploy, action status, survival, crafting, movement, known issues). |
| `docs/raw/SURVIVAL-INTELLIGENCE.md` | `docs/raw/` | Full reference for the Survival Intelligence Layer. |
| `docs/raw/REPRODUCTION-REPORT.md` | `docs/raw/` | Full report of reproducing the original Ender Dragon run. |
| `docs/raw/AI_PLAYER_ROADMAP.md` | `docs/raw/` | Evolutionary roadmap from chat-controllable bot to persistent autonomous agent (Goal Manager, suspend/resume, emergency, autonomy, home, navigation, personality). |
| `docs/raw/GOAL_EXPLORATION.md` | `docs/raw/` | Autonomous Exploration v1 spec: find-biome MVP, mission model, deterministic planner, checkpoints, route replay, escort, search blocks/structures. |
| `docs/raw/FLUIDS_ROADMAP.md` | `docs/raw/` | Fluids roadmap (Italian): swimming, drowning/breathing, waterfalls/bubble columns, lava avoidance, buckets/boats/potions, M0–M6 and Survival Intelligence integration. |
| `docs/raw/REDSTONE_ROADMAP.md` | `docs/raw/` | Redstone roadmap (Italian): component sensing, oriented placement, switches/delay lines/observers/hoppers, declarative circuit blueprints, verification/teardown, R0–R6. |
| `docs/raw/GOAL_ACHIEVEMENT_MINECRAFT.txt` | `docs/raw/` | Proposal (Italian): goal-driven agentic gameplay — pipeline, Goal Contract, task graph + primitive skills, suspend/resume, semantic goals, 5 progressive benchmarks. |
| `docs/raw/NETHER_ROADMAP.md` | `docs/raw/` | Nether/End roadmap (Italian): portal locate/build, Nether survival, ghast dodge, piglin bartering, enderman gaze, fortress/blaze, stronghold/End/dragon, N0–N7. |
| `docs/raw/evidence/` | `docs/raw/evidence/` | JSONL evidence from early harness runs. |

## Source code (authoritative for behaviour)

| Path | What it defines |
|---|---|
| `bedrock-adapter.mjs` | The Bedrock protocol client: perception (`_refreshNearby`), actions (`player_auth_input`, `block_action`, `item_stack_request`, `click_block`), tool selection, mining, digging, containers, trading and trader levelling, chat capture (`text` id 9 → `chatInbox`) and chat **output** (`sendChat` → `text`/`chat` packet), `follow_player`, human players in range (`observe().humans`, `_nearbyHumanPlayers`) and the valuable-ore opportunity scan (`observe().ores`, the `mine_<ore>` options outside the fixed mining list). |
| `bedrock-trading.mjs` | Pure trading economy rules: profession mapping, item value classification, cheapest-trade picker for levelling. |
| `bedrock-bees.mjs` | Pure Bedrock apiculture rules: known honey levels, campfire smoke safety, hive protection and supported feeding flowers. |
| `bedrock-fishing.mjs` | Pure fishing rules: fish classification, water-block detection, shore geometry, bite timing. |
| `bedrock-world.mjs` | Registry + Prismarine v9 decoder, `findBlocks`/`blockAt`, `requestAround` (subchunk requests). |
| `bedrock-harness.mjs` | HTTP API (`/observe`, `/options`, `/act`, `/plan`, `/say`, `/survival`) and the Survival Governor filter; owns the `WorldMemory` (load, periodic flush, close). |
| `world-memory.mjs` | Persistent **world memory** service: landmark/container records, `known/stale/invalid` status, spatial queries; storage-agnostic. |
| `sqlite-memory.mjs` | SQLite repository (`node:sqlite`, WAL, chunk index) — default memory backend. |
| `memory-store.mjs` | JSON repository (same interface) — fallback / tests. |
| `exploration.mjs` | Deterministic exploration M1 planner: biome target resolution, expanding-square/spiral over unexplored chunks, biome detection, report. |
| `explore.mjs` | Exploration M1 driver: loop planner (`GET /explore`) → `goto_waypoint` until FOUND. |
| `bedrock-lifecycle.mjs` | Disconnect/teardown lifecycle. |
| `tools/respawn-capture.mjs` | Diagnostic MITM relay (bedrock-protocol `Relay`) that records a vanilla client's death→respawn packet sequence to `runs/` (git-ignored). |
| `controller.mjs` | The planner/controller loop (incl. the human chat command channel: `CHAT_ALLOWLIST` → Hermes → `/plan`, with the multi-trigger `CHAT_PREFIXES` (`@bot` plus the bot's own name) and the proactive greeting `maybeGreetHumans`: a human nearby is told the order syntax) and the **persistent session loop** (`SESSION=on`): goal → run → IDLE → next goal, with cross-session resume (`RESUME`), no reconnect. |
| `human-replies.mjs` | Pure chat-channel helpers: trigger normalisation/matching (`normalizePrefixes`, `matchChatPrefix`, `DEFAULT_CHAT_PREFIX`) and the ack/outcome rendering (`orderAck`, `orderOutcome`, `renderReply`, `isSelfTriggering`). |
| `human-greeting.mjs` | Pure **proactive greeting** policy (`planGreetings`, `renderGreeting`, `formatPrefixes`): humans in range + allowlist + already-greeted state → the messages to send this step (cooldown per gamertag, zero greetings when the allowlist is empty, every configured trigger listed via `{prefixes}`). |
| `goal-manager.mjs` | Pure **Goal Manager** (Agent Core, M1): goal model, sources/priorities, `PENDING/RUNNING/SUSPENDED/COMPLETED/FAILED` transitions, preemption, snapshot/restore, cross-session resume, persistence via a repository (`kind: 'goal'`). |
| `idle-goals.mjs` | Pure **idle autonomy** (M3): maps survival needs to ranked candidate goals (+`nextIdleGoal` cooldown) and the deterministic `isNeedResolved` success predicate. |
| `world-events.mjs` | Pure **world-event detection** (M2): transition-based `detectEvents(prev, curr)` → `PLAYER_DIED`, `LOW_HEALTH`, `HOSTILE_AMBUSH` and `VALUABLE_ORE_SEEN` (a newly seen ore within 24 blocks), each with a `dedupKey`. |
| `emergency-goals.mjs` | Pure **emergency mapping** (M2): `emergencyGoalFor(event, …)` maps events to preempting `EMERGENCY` goals (`PLAYER_DIED → recover_loot`), with cooldown/dedup. |
| `ore-value.mjs` | Pure **ore/item value table** (`ORE_VALUES`, `ITEM_VALUES`): the deterministic answer to "is this vein worth a detour?" — thresholds for the event floor, the option-priority lift and the opportunity gate. |
| `opportunity-goals.mjs` | Pure **opportunity mapping** (curiosity): `evaluateOpportunity(event, …)` / `opportunityGoalFor(event, …)` turn a `VALUABLE_ORE_SEEN` event into a suspending `OPPORTUNITY` goal (relative-value gate, cooldown/dedup, one level, never over a chat order). |
| `controller-decisions.mjs` | Pure decision helpers (ranking, anti-loop, cap, diagnostics), incl. the **valuable-ore tier 4.5** for gold-and-above ore. |
| `survival/` | Survival Intelligence Layer (governor, resolver, verifier, progression, ...). |
| `knowledge/` | `survival-rules.json`, `progression.json`. |
| `skills/gameplay/` | Declarative gameplay skills. |
| `harness.mjs` | The Java Edition "toy" harness (flying-squid + mineflayer). |

## Private sources (not committed)

| Source | Role |
|---|---|
| `.private/GOAL.md` | The original goal, server details and launch checklist (excluded from git). |
| `.private/*.md` | Task notes (defense, farming, mining, storage, trading, Jev), `ROADMAP.md` and `GOAL.md` (frozen at 01/10, now superseded), and the incident log. Consolidated status in [`wiki/roadmap.md`](wiki/roadmap.md). |

> Never commit `.private/`, `.env`, `runs/`, `nmp-cache/` or `auth.json`.

## Official Bedrock apiculture references

- [Buzzy Bees Bedrock release notes](https://feedback.minecraft.net/hc/en-us/articles/360037105792-Minecraft-Buzzy-Bees-1-14-0-Bedrock): shears/bottle harvest and calming smoke.
- [Bedrock beta 1.14.0.1](https://feedback.minecraft.net/hc/en-us/articles/360034989811-Minecraft-Beta-1-14-0-1-Xbox-One-Windows-10-Android): maximum honey level and flower breeding.
- [Mojang vanilla bee entity](https://github.com/Mojang/bedrock-samples/blob/main/behavior_pack/entities/bee.json): breeding and feeding item names. Synthesis: [bees](wiki/bees.md).
