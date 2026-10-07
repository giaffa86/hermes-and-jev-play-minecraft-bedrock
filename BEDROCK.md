# Hermes + Jev → Minecraft Bedrock Edition

This document describes the port of the original project from Minecraft Java
Edition to Minecraft Bedrock Edition.

The architecture is the same: **Hermes** plans, **Jev** picks one action among the
valid ones, and a **Bedrock harness** executes the action in the real world
through an authenticated Bedrock bot. The bot is **headless** (no graphics, no
screenshots, no keypresses): for how it "sees" and "acts" in the server using
only the network protocol, see
[`docs/wiki/headless-client.md`](docs/wiki/headless-client.md).

---

## Bedrock components

| Path | Role |
|---|---|
| `bedrock-harness.mjs` | Container entry point: connects the Bedrock bot to the BDS and exposes the HTTP API (`/observe`, `/options`, `/act`, `/plan`, `/survival`). Also applies the Survival Governor's emergency filter to the options. |
| `bedrock-adapter.mjs` | Adapter that translates Bedrock state into the format expected by `controller.mjs`. It also owns the **deposit policy** (M3c): `_depositableItems` (what stays in the pack: tools, armour, buckets, seeds, torches/stations, `DEPOSIT_KEEP_RESERVE = 16` of every food stack), `_depositTargetFor` (a chest that already holds the item scores `+100000`, then the distance) and the bounded `dump_inventory` action (`DEPOSIT_MAX_STACKS = 8`), with the census exposed as `observe().deposit`. |
| `human-replies.mjs` | The deterministic chat composer: trigger match (`normalizePrefixes`, `selfPrefixes`, `matchChatPrefix`), ack/outcome/failed/stopped/lost templates (read from the i18n catalogue), `clampMessage`, `isSelfTriggering`. |
| `human-questions.mjs` | Chat answers: `matchQuestionIntent`/`answerIntent`/`renderAnswer` over a closed intent list, the vocabulary of the structured goals (`CHORE_LABELS`, `NEED_LABELS`, `choreLabel`, `needLabel`, `planPhrase`, M7.1) and the `renderUnrouted`/`renderNoArmor` fallbacks. Question patterns and small talk cover it/en/fr/es/de. |
| `chat-i18n.mjs` | The message catalogue: `MESSAGES` (it/en/fr/es/de, one entry per key), `t(lang, key, vars)`, `chatLangConfig`/`normalizeLang` for `CHAT_LANG`, `languageName`/`LANG_NATIVE_NAMES` for the prompts, `listAnd`. No I/O: it is the only place a user-facing sentence is written (M7.2). |
| `chat-intent.mjs` / `chat-llm.mjs` | The optional models on the chat path: `chat-intent.mjs` routes a question to an intent (M6), `chat-llm.mjs` rephrases an already-composed reply (M7). Both are typed clients with a timeout and a deterministic fallback. |
| `chat-narration.mjs` | The autonomy narration (M8): `narrateGoal(plan)`/`narrateChore`/`narrateNeed`/`targetWord` compose the sentence "In autonomia: sto raccogliendo le patate" from the catalogue, naming the concrete item the chore saw (never a raw id). Pure, no I/O. |
| `idle-goals.mjs` / `village-labor.mjs` | The `IDLE` producers: survival needs (M3) and village chores (M3b). Pure and deterministic, with a success predicate evaluated on harness state (`isNeedResolved`, `isChoreResolved`). `storableStack` reads the harness census (`observe().deposit`) rather than keeping a second list of what is storable. |
| `controller-decisions.mjs` | Pure controller functions (no I/O): option ranking/cap (including the active skill's intents), anti-loop, progress fingerprint, diagnostics and decision instructions. Unit tests in `tests/controller-decisions.test.mjs`. |
| `survival/` | Deterministic Survival Intelligence Layer: perception, risk/needs, governor, rules, intents, item tags, declarative skills, resolver, verifier, progression, experience. Dedicated unit tests. |
| `knowledge/` | `survival-rules.json` (when to interrupt progression) and `progression.json` (milestone graph with dependencies). |
| `skills/gameplay/` | Declarative gameplay skills (JSON): preconditions, success criteria, intents. A different concept from the Hermes `SKILL.md`; no executable code. |
| `bedrock-world.mjs` | Bedrock 1.26 registry and Prismarine v9 decoder; `subchunk_request` requests, handling of unknown hashes and unreceived sections. |
| `bedrock-lifecycle.mjs` | Disconnects the game before the SCTP/DTLS teardown and waits for async cleanup, reusable from tests. |
| `Dockerfile` | Node.js 24 image with the project and its dependencies. |
| `docker-compose.yml` | Starts the container on the Docker host with the correct networks and Xbox cache persistence. |
| `test-ping.mjs` | NetherNet ping to the Bedrock server. |
| `test-connect.mjs` | Connection + spawn test. |

---

## Requirements

- Minecraft Bedrock Dedicated Server `1.26.50+` with `transport=nethernet`.
- The bot's Microsoft/Xbox account added to the server allowlist.
- A Linux VM/LXC with Docker (tested on host `<ip-host>`).
- Xbox Live token cache in `~/.minecraft/nmp-cache` (populated at first login).

---

## Environment variables

Copy `.env.example` to `.env` and fill in:

```bash
# Bedrock connection
BEDROCK_HOST=<ip-server-bedrock>
BEDROCK_PORT=19132
BEDROCK_USERNAME=<gamertag_or_email>
BEDROCK_AUTH_TITLE=MinecraftNintendoSwitch

# Harness
API_PORT=3077
RUN_ID=demo
MEMORY_DIR=runs/memory   # persistent world memory (SQLite + WAL); default runs/memory
RESPAWN_RECONNECT_MS=25000  # still dead this long after a death -> reconnect (workaround for the BDS respawn bug)
PACKET_DEBUG=               # 1 = log clientbound packet names for 25 s after a death (protocol diagnostics)

# Jev (TypeSafe)
TYPESAFE_API_KEY=ts-...
CONTROLLER=jev
JEV_MODEL=jev-latest

# Objective
GOAL="Hold at least 4 dirt in inventory and stand within 2 blocks of the waypoint."
WAYPOINT='{"x":380,"z":16}'
TARGETS='{"dirt":4}'
MAX_STEPS=20
REPLAN_EVERY=8

# Decision quality (optional)
MAX_OPTIONS=12          # cap on the options passed to Jev (0 = no cap)
ANTI_LOOP_THRESHOLD=3   # consecutive no-progress actions before replan/exclusion
ANTI_LOOP_COOLDOWN=3    # steps the blocked key stays excluded

# Human chat command channel (optional)
CHAT_ALLOWLIST=<gamertag-o-xuid>   # comma-separated; enables @bot control (default prefix)
CHAT_PREFIXES=@bot                 # triggers accepted, comma/space separated (default @bot)
CHAT_PREFIX=@bot                   # legacy single trigger; summed into CHAT_PREFIXES
CHAT_SELF_NAME=on                  # also accept @BEDROCK_USERNAME and the gamertag the server gives the bot
CHAT_CONTROL=on                    # on/off; default on when CHAT_ALLOWLIST is set
# Proactive greeting: a trusted human nearby is told the order syntax via POST /say
CHAT_GREET=on                      # default on when the channel is open
CHAT_GREET_RANGE=24                # blocks within which a human is "perceived"
CHAT_GREET_COOLDOWN_MS=600000      # don't greet the same human again before this (0 = once per session)
CHAT_GREET_TEMPLATE='Ciao {name}! ... {prefix} <ordine>'  # {name}, {prefix}, {prefixes}
CHAT_INTENT=on                     # answer chat questions from observe() (M6); default on with a key
CHAT_INTENT_URL=                   # alternative decisions endpoint (e.g. a local Jev)
CHAT_INTENT_MODEL=                 # routing model (default JEV_MODEL)
CHAT_INTENT_TIMEOUT_MS=4000        # past this a question is refused (M6.1), never turned into a goal
CHAT_INTENT_MIN_P=0.4              # minimum probability for an intent (0 = argmax)
CHAT_REPLY=on                      # on/off for the order lifecycle replies (ack + outcome)
CHAT_REPLY_MAX_LENGTH=180          # clamp on every outgoing reply
CHAT_MAX_AGE_MS=300000             # an order older than this is dropped (chat_stale) after a restart
CHAT_ECHO_WINDOW_MS=15000          # how long the bot recognises its own chat coming back from the server

# Told facts (M10): the human can dictate a fact about the world and the bot
# remembers who said it (source 'told', toldBy/toldAt). A named place has no
# TTL; a chest's content is a partial claim, verified by the next real reading.
# See docs/wiki/human-command.md and docs/raw/TOLD-FACTS.md.
TOLD_FACTS=on                      # on/off; off answers 403 on POST /memory/tell/*
# A write attributed to a sender (toldBy) is refused too when CHAT_ALLOWLIST is
# set in the harness environment (403 told_sender_not_allowed): a dictated fact is
# an order a human gives, so it passes the same gate.

# Chat language (M7.2): every sentence the bot composes by itself (ack, outcome,
# question answers, proactive greeting, refusals) comes from the chat-i18n.mjs
# catalogue. The configured language does not depend on the LLM: without a key
# the deterministic path speaks it too. A clear message always wins (the bot
# replies in the sender's language); CHAT_LANG covers the ambiguous ones.
CHAT_LANG=it                       # it | en | fr | es | de; default it, unknown value falls back with a warning

# Autonomy narration (M8, optional): when a goal nobody asked for starts (a
# village chore, a governor need) the bot says what it is about to do, once per
# goal, in the configured language, and only if a human is within
# CHAT_GREET_RANGE. Informazione, non diario: the sentence is composed
# deterministically and handed to saySmart as grounding.
CHAT_NARRATE=on                    # default: follows CHAT_REPLY (channel open)
CHAT_NARRATE_COOLDOWN_MS=300000    # minimum silence between two announcements (0 = no limit)

# Ore alert (M11): the harness says in chat when the census finds a valuable
# vein — one sentence per vein, once per position, never twice. The ore list is
# folded to its core, so diamond_ore and deepslate_diamond_ore are the same.
ORE_ALERT=diamond                  # comma-separated cores; off/none/'' = silence
ORE_ALERT_RANGE=32                 # only veins within this distance are announced
ORE_ALERT_COOLDOWN_MS=5000         # minimum silence between two alerts

# Natural chat (M7, optional): an LLM rephrases the deterministic reply;
# without a key (or with CHAT_LLM=off) the reply is still sent, in the
# deterministic text (M7.1 keeps that text in the sender's language).
DEEPSEEK_API_KEY=                  # legacy alias of CHAT_LLM_API_KEY, still honoured
CHAT_LLM_API_KEY=                  # the gate (canonical name)
CHAT_LLM=on                        # on with a key; off disables the engine even with a key
CHAT_LLM_MODEL=deepseek-chat       CHAT_LLM_MODEL=deepseek-flash      # DeepSeek-V4.1-Flash (deepseek-chat/reasoner exist too).
                                   # Note: V4.1-Flash thinks by default (effort high); in that mode
                                   # temperature is ignored and max_tokens is shared with the
                                   # reasoning, so with max_tokens 120 the reply comes back empty
                                   # (finish_reason length, measured 07/10/2026).
CHAT_LLM_THINKING=off              # the client's own switch: off (default) sends
                                   # {"thinking":{"type":"disabled"}}; low|high|max send
                                   # reasoning_effort and raise the budget (1200, 2000 for a
                                   # reasoned answer); default|auto send nothing and let the
                                   # provider decide.
CHAT_LLM_URL=https://api.deepseek.com/chat/completions   # any OpenAI-compatible endpoint
CHAT_LLM_TIMEOUT_MS=8000           # past this the template is sent
CHAT_PERSONA='...'                  # persona sentence spliced into the system prompt
CHAT_SMALLTALK_TEMPLATE='@{name} ciao! dimmi pure.'       # greeting fallback

# Reasoned answer (M12, needs M7): a question carrying a deliberation marker is
# answered by the engine from the facts instead of the catalogue sentence. The
# marker is stripped before the dedup and the router; the reply is addressed by
# the controller, and the action is never changed. Off when M7 is off.
CHAT_REASON=on                     # default: the state of M7
CHAT_REASON_COOLDOWN_MS=5000       # per sender; within it the catalogue answers
CHAT_REASON_MARKERS=               # replaces the built-in list (ragiona, pensa, think, ...)
                                   # the proactive greeting teaches the first word (or the language's own)

# Persistent agent session (optional)
SESSION=off                        # on = persistent session loop with an IDLE state; off = one-shot (default)
IDLE_POLL_MS=2000                  # IDLE polling period for new goals
IDLE_TIMEOUT_MS=0                  # 0 = wait forever; >0 = exit after this idle time
RESUME=on                          # on = resume goals suspended in a previous session (default: on when SESSION=on)
EMERGENCY=on                       # on = world events preempt a running goal (e.g. death -> recover loot); default: on when SESSION=on
EMERGENCY_COOLDOWN_MS=60000        # don't re-create the same emergency within this window
AUTONOMY=off                       # on = needs-driven autonomous goals while IDLE (requires SESSION=on)
AUTONOMY_COOLDOWN_MS=120000        # don't retry the same need within this window
AUTONOMY_MAX_GOALS=25              # cap on autonomous goals generated per session
SURVIVAL_IDLE_COOLDOWN_MS=30000    # urgent-needs anti-loop when AUTONOMY=off (0 = no cooldown)
VILLAGE_WORK=on                    # M3b: village chores while IDLE; default: follows AUTONOMY (needs SESSION=on)
VILLAGE_COOLDOWN_MS=120000         # don't retry the same chore within this window
VILLAGE_MAX_CHORES=12              # cap on village chores generated per session
VILLAGE_STORE_THRESHOLD=8          # stack size from which store_harvest is worth offering
VILLAGE_STORE_EPILOGUE=on          # M3c: after a successful village goal, queue the "put the pack away" goal
                                   # (default: follows VILLAGE_WORK; the child is store_harvest with threshold 1)
```

> Never commit `.env` or the `nmp-cache`.

---

## World memory (persistence)

The bot keeps a **persistent world memory** of what it has discovered, so it
survives reconnects and restarts. It is a repository behind an abstract
interface: **SQLite** (`node:sqlite`, WAL) by default, JSON as fallback; the
service (`world-memory.mjs`) is storage-agnostic.

- File: `${MEMORY_DIR}/world.sqlite` (default `runs/memory`), persisted by the
  `runs` Docker volume. `MEMORY_DIR` also accepts a `.sqlite` path.
- Records: `landmarks` (places/structures/portals, plus `home` registered at
  spawn) and `containers` (chest contents, updated on every `read_container`).
- Each record carries `discoveredAt`, `lastSeenAt`, `confidence` and a
  `known/stale/invalid` status: **memory is historical, not current truth**
  (`stale` = verify before depending on it).
- Exposed in `/observe.memory` (compact view). The harness flushes/closes it on
  shutdown and checkpoints the WAL periodically.
- Full design: `docs/wiki/memory.md`.

> The memory is runtime knowledge (coordinates, contents), not source: it is
> git-ignored and excluded from the image (`memory/`, `*.sqlite*`).

## Agent session (goal queue)

The controller owns a **Goal Manager** (`goal-manager.mjs`): every activity is a
goal `{id, type, source, priority, status, objective, plan, parameters}` with
status `pending/running/suspended/completed/failed` (plus `cancelled`) and
source `emergency/chat/world_event/player_behavior/curriculum/autonomous`.
With `SESSION=on` the controller stops being a one-shot loop: when a goal ends
it enters an explicit **IDLE** state, keeps accepting new goals (in-game `@bot`
orders become `chat` goals) and resumes running them **without reconnecting**.
The target state machine is `CONNECTED → IDLE → GOAL_RUNNING → GOAL_COMPLETED →
IDLE` (AI-player roadmap milestone 0→1).

- Queue file: `runs/<RUN_ID>/goals/world.json` (same repository format as the
  world memory, `kind: 'goal'`), so it survives a restart.
- State transitions are logged: `session_state`, `goal_start`, `goal_end` in
  `runs/<RUN_ID>/controller.jsonl`.
- **Cross-session resume**: a goal left `running` by a previous run is
  suspended on startup, then (with `RESUME=on`, default when `SESSION=on`)
  every suspended goal is re-queued as `pending` and resumed from its persisted
  plan — no reconnect and no LLM re-planning. `RESUME=off` keeps them parked.
- **Emergency preemption** (`EMERGENCY=on`, default when `SESSION=on`): a world
  event suspends the running goal and starts a higher-priority one. Today
  `PLAYER_DIED → recover_loot` (priority 100, `parentGoal`); when the death site
  is cleared the parent resumes. Sub-second reactions (flee/dodge/eat) stay with
  the Survival Governor inside the current goal. See
  `docs/wiki/emergency.md`.
- With `AUTONOMY=on` (and `SESSION=on`) `IDLE` is not passive: the bot derives
  goals from its **survival needs** (`idle-goals.mjs`) — eat, heal, sleep/
  shelter, obtain food/weapon/armor, replace tool, escape — picks the highest
  utility one and rates it `emergency` when the governor is in emergency. A goal
  succeeds deterministically when the triggering need disappears from harness
  state (`isNeedResolved`); a per-need cooldown stops retry loops and
  `AUTONOMY_MAX_GOALS` bounds the session.
- With `VILLAGE_WORK=on` (default: it follows `AUTONOMY`, and needs `SESSION=on`)
  `IDLE` also draws on the **village chores** (`village-labor.mjs`, M3b): harvest
  ripe crops, store the harvest, shear sheep, milk cows, collect honey, breed
  animals, plant crops, fish, chop wood, gather stone, mine ore. Two invariants:
  a chore is proposed only when `GET /options` already offers one of its intents
  (the harness is the arbiter) and it succeeds on a **state delta**
  (`isChoreResolved` against the `villageSnapshot` taken at creation), never on an
  absolute count and never on the model's opinion. Chores are `source:
  autonomous` (a chat order or an emergency always wins), bounded by
  `VILLAGE_COOLDOWN_MS` per chore and `VILLAGE_MAX_CHORES` per session; the chat
  side that describes them is M7.1 (`planPhrase`). Unit tests in
  `tests/village-labor.test.mjs` plus the integration case in
  `tests/controller-session.test.mjs`.
- **The work comes home (M3c).** With `VILLAGE_STORE_EPILOGUE=on` a *successful*
  `village`/`autonomous` goal queues one last child goal — `store_harvest` with
  `storeThreshold: 1` — so the cycle is **produce → store → verify**: the parent
  closes as `completed` and a failed chest never rewrites its outcome. The child
  is a normal `autonomous` goal (a chat order arriving first is served first),
  does not count against `VILLAGE_MAX_CHORES`, and closes only on the state
  delta (`isChoreResolved` against the snapshot taken at creation). `dump_inventory`
  moves up to 8 stacks in one bounded action keeping the reserve; the container
  cache is updated from the observed contents *plus* the moved count accumulated
  across stacks (the open-window slot mirror is a photograph from the moment the
  chest was opened, so recomposing from it after every stack erased the previous
  deposits from the cache).
- Default `SESSION=off` preserves the historical one-shot behaviour and exit
  codes (`2` on a `failed` Goal Contract).
- **`IDLE_TIMEOUT_MS` closes the controller, not the bot.** The bot lives in the
  harness (`bedrock-harness.mjs`) and stays connected when the controller exits:
  it is simply still and deaf (no in-game orders, no needs, no chores) until the
  controller is started again, and `RESUME=on` puts the suspended queue back. The
  timer starts when the queue empties and is reset by every goal, so with
  `AUTONOMY=on` it only fires once there is genuinely nothing left to do (the
  autonomy/chore caps reached, no governor need, nobody writing).
- **Nothing in chat disables autonomy.** `isStopOrder` makes *that* order mean
  "stay put" (`fallback.stop`: no `follow`, no `targets`); when the goal ends the
  `IDLE` producers resume. To actually stop the bot, use `SESSION=off`, an
  `IDLE_TIMEOUT_MS` bound, or a signal (SIGTERM/SIGINT flush the queue first).
- **The caps are per process and cover the invented work only.**
  `AUTONOMY_MAX_GOALS` counts the general-autonomy branch (`controller.mjs:1401`)
  and `VILLAGE_MAX_CHORES` is a separate counter — both reset on restart, while
  governor needs and chat orders are never capped.
- **`IDLE` is free.** It only polls `GET /observe` every `IDLE_POLL_MS` and reads
  the chat inbox: no planner, no decision model. Cost accrues per goal (one
  Hermes plan, one Jev decision per action).
- **Urgent needs change cooldown with `AUTONOMY`**: `cooldownMs: AUTONOMY ?
  AUTONOMY_COOLDOWN_MS : SURVIVAL_IDLE_COOLDOWN_MS` (`controller.mjs:1391`) —
  long when autonomy is on (one anti-loop for every branch), short when it is off
  ("the night does not wait").
- **Live-verified on the BDS (2026-10-02)**: a completed goal → `IDLE` with the
  queue persisted, and (with `AUTONOMY=on`) idle goals generated and closed for
  real needs (`escape` via `flee`, `sleep` via the bed).

---

## Deploy on the Docker host

### 1. Copy the project

From the Proxmox host:

```bash
rsync -avz --exclude=node_modules --exclude=runs --exclude=.git \
  <project-path>/ \
  -e 'ssh -i <ssh-key>' \
  <ssh-user>@<ip-host>:~/hermes-jev-bedrock/
```

### 2. Xbox Live cache

Populate `./nmp-cache` with the previously authenticated tokens:

```bash
rsync -avz -e 'ssh -i <ssh-key>' \
  ~/.minecraft/nmp-cache/ \
  <ssh-user>@<ip-host>:~/hermes-jev-bedrock/nmp-cache/
```

> If the cache does not exist, on first boot the container will print a
> `microsoft.com/link` URL and a code to enter after logging in with the bot's
> account.

### 3. Start

```bash
ssh -i <ssh-key> <ssh-user>@<ip-host>
cd ~/hermes-jev-bedrock
# Use --build after changing sources/Dockerfile
sudo docker compose up -d --build
sudo docker logs -f hermes-jev-bedrock
```

### 4. Network checks

From inside the container:

```bash
# Ping the Bedrock server
sudo docker exec hermes-jev-bedrock node test-ping.mjs

# Ping the Hermes container
sudo docker exec hermes-jev-bedrock ping -c 3 <ip-container-hermes>
```

### 5. Start the controller

`controller.mjs` requires the `hermes` CLI for planning. The agent container does
not include the Hermes CLI, so the controller runs **inside the existing Hermes
container** via `docker exec` (no image change). Since this update the controller
imports `controller-decisions.mjs`, `survival/`, `knowledge/` and
`skills/gameplay/`: copy the whole project (or mount the directory read-only)
instead of just two files.

Copy the project into the Hermes container:

```bash
sudo docker cp /home/<ssh-user>/hermes-jev-bedrock/controller.mjs hermes:/tmp/controller.mjs
sudo docker cp /home/<ssh-user>/hermes-jev-bedrock/controller-decisions.mjs hermes:/tmp/controller-decisions.mjs
sudo docker cp /home/<ssh-user>/hermes-jev-bedrock/survival hermes:/tmp/survival
sudo docker cp /home/<ssh-user>/hermes-jev-bedrock/knowledge hermes:/tmp/knowledge
sudo docker cp /home/<ssh-user>/hermes-jev-bedrock/skills hermes:/tmp/skills
```

Run the loop (use `-w /opt/data` to persist runs on the Hermes volume):

```bash
sudo docker exec \
  -w /opt/data \
  -e RUN_ID=demo \
  -e HARNESS=http://hermes-jev-bedrock:3077 \
  -e WAYPOINT='{"x":380,"z":16}' \
  -e TARGETS='{"dirt":4}' \
  -e MAX_STEPS=14 \
  -e CONTROLLER=jev \
  -e TYPESAFE_API_KEY="$TYPESAFE_API_KEY" \
  -e JEV_MODEL=jev-latest \
  hermes node /tmp/controller.mjs
```

For the automatic milestone (deterministic curriculum) add `-e CURRICULUM=first_night`
and omit `WAYPOINT`/`TARGETS`.

Runs are written to `/opt/data/runs` (volume `hermes-data`). To copy them back
into the project:

```bash
sudo docker cp hermes:/opt/data/runs /home/<ssh-user>/hermes-jev-bedrock/runs-from-hermes
```

---

## Network architecture on the Docker host

```text
+----------------+       hermes-internal       +------------------+
|    hermes      | <--------------------------> | hermes-jev-bedrock|
|  (container)   |                              |   (container)     |
+----------------+                              +------------------+
                                                       |
                                                       | bridge
                                                       v
                                               <ip-server-bedrock>:19132
                                               (BDS)
```

- `hermes-internal`: Hermes' Docker network, used for container-to-container
  communication.
- `hermes-jev-bedrock`: local bridge network of the agent container, used to reach
  the BDS and the remote APIs.
- The agent container therefore has two interfaces: one towards Hermes and one
  towards the outside.

---

## Bedrock action status

| Action | Status | Notes |
|---|---|---|
| `wait` | ✅ Working | |
| `goto_waypoint` | ✅ Working | Server-authoritative movement via `player_auth_input` (local physics: gravity, collisions, steps, jumps) + A* pathfinding over the loaded world; opens doors along the path. |
| `sneak_to` | ⚠️ Needs live verification | The *silent* variant of `goto_waypoint`: the sneak input is held on every tick, released at the end of the walk, and the route is planned so that no cell of it lies inside a sculk sensor sphere (vibration-cost A*, shrieker cells forbidden, digging and placing impossible by construction). Silence is **verified, not assumed**: the adapter measures the distance actually accepted by the server against the elapsed time and refuses a speed above the sneak ceiling (`SNEAK_SPEED_CEILING_MPS`, 2.6 m/s) with a typed `not_sneaking`; a walk with no real step is `no_measurement`; a walk that cannot be promised is refused whole (`no_stealth_route`/`no_exit_route`/`sculk_unknown`, the return leg being re-planned before the bot moves). Offered next to `goto_waypoint` when a waypoint is set, also under the alias `walk_stealthy`; refused while riding (`riding`). Measured verdict in `/observe.sneak`, plan in `observe().sneak.route` — W1 and W2 of the [Deep Dark roadmap](docs/wiki/deep-dark.md). |
| `collect_drop` | ✅ Working | Tracks item entities (`move_entity`/`move_entity_delta`), walks to the drop and verifies the pickup (`take_item_entity`). The node search uses the drop's altitude, otherwise a drop below the bot is never reached. |
| `mine_*` | ✅ Working | Real breaking via `player_auth_input` + `block_action`, server confirmation and a destruction event. Before breaking, the adapter selects the right tool (pickaxe/axe/shovel/hoe, best tier) and break times follow the vanilla formula (stone with a wooden pickaxe ≈ 1.3 s). Without a pickaxe the `mine_stone`/`mine_cobblestone` options are not offered (no drop). Ores also need the right rank: `_blockHarvestable` compares the pickaxe rank (wood/gold = 1, stone/copper = 2, iron = 3, diamond = 4, netherite = 5) with the block's `harvestTools` set; `mine_iron_ore` is not offered with a wooden pickaxe. |
| `dig_down` | ✅ Working | Digs one step (head, front and the cell below the front), then advances and descends; the steps remain climbable on the way back up. Refuses protected blocks (tables, containers, stations, and building materials: planks, slabs, stairs, wool, glass, bricks). If the step is already open it just descends. Cells with unresolved hashes (`unknown`) are dug with a raw break. |
| `dig_up` | ✅ Working | Mirror of `dig_down`: also opens the ceiling above the head (needs jump room), the step ahead and the two cells above it, then climbs. `unknown` are raw targets. Verified live on 02/10: exit from the dig pit (from y=67 to y=73, 5 steps) and protection of sensitive blocks (tables, chests, stations). If the step is already open it just climbs. |
| `attack_<mob>` | ✅ Basic | Chases and hits the nearest hostile mob of the requested type (up to 25 s per action) with an `item_use_on_entity` transaction (`action_type: attack`) + `animate swing_arm`; equips the best sword in the hotbar; stops when the mob disappears or its health reaches 0. Verified live on 02/10: 19-20 hits landed in 25 s at 1.6 blocks (without a sword in inventory damage is low; `combat_timeout` reports `hits` and the mob stays damaged). |
| `flee` | ✅ Working | Moves away from the nearest hostile mob trying multiple directions and distances (9-16 blocks) with pathfinding. Verified live on 02/10: real separation of ~7 blocks; if an attempt times out but the separation grows, the action reports `ok` with `partial: true`. |
| `go_home` / `retreat` | ✅ Working | Walks back to the home waypoint (`HOME_WAYPOINT` env JSON, default: the spawn position captured at first spawn); `retreat` is an alias for danger moments. Offered when farther than ~6 blocks from home. **Verified live on 02/10**: from (113, 180) back to home (96, 161), ended ~1.9 blocks away (`pathNodes: 35`). |
| `equip_armor` | ⚠️ Needs live verification | Moves armor pieces from the inventory (0..35) into the armor slots via `item_stack_request` take→cursor→place into the `armor` container (slots 0=helmet, 1=chestplate, 2=leggings, 3=boots). Offered when an armor item (`*_helmet`/`*_chestplate`/`*_leggings`/`*_boots`/`turtle_helmet`/`elytra`) is in the inventory. The worn pieces and their computed vanilla points are exposed in `/observe.armor`. Since 06/10/2026 the action closes a container an action has open before the take, retries a refused place **once** with the cursor still loaded, and fails typed — `armor_place_failed_<status>` with every attempt, `armor_take_failed` in `failures`, `no_armor_in_inventory` with `carried` after one `_resyncByReconnect` (`armor_resync`) when the aggregate shows armor no slot does; the single live refusal of 06/10 (a place towards `armor` whose status was never recorded, the cause still unexplained) is what these types are meant to name on the next attempt. |
| `close_door` | ⚠️ Needs live verification | Closes doors the bot opened (tracked in `_openDoors`) by clicking them (`_blockUseTransaction`); the open set is cleared on the block-update runtime-id change (or optimistically on timeout). Offered when an open door is within ~8 blocks. |
| `barricade` | ⚠️ Needs live verification | Seals a 1×2 opening (feet + head) in one of the four horizontal directions (open cells with a solid floor and solid flanking walls) using 2 placeable blocks via `click_block` top-face placements. Offered when a placeable block (cobblestone/dirt/planks/logs/…) is in the inventory and such a gap is found. |
| `eat` | ✅ Basic | Equips the best available food (safe list: cooked first, then bread/potatoes/carrots/fruit; excludes those with negative effects) and sends `item_use` `click_air`; confirms when hunger rises or the item count drops. Packet shape verified; live testing requires food in inventory and hunger < 20 (so far the bot was full or had no food). |
| `sleep` | ✅ Working | When it is **night or a thunderstorm** (vanilla allows sleep during a daytime thunderstorm, not during plain rain) searches for the nearest bed (`bed` block in the loaded world), walks next to it and clicks it (`click_block`); the `sleep` option is offered on the same condition (`_isSleepTime()` = `_isNight()` or `_isThundering()`), the weather coming from the `level_event`s `start_rain` 3001 / `start_thunder` 3002 / `stop_rain` 3003 / `stop_thunder` 3004 and exposed as `observe().time.rain`/`.thunder`. Confirmed by the `resting` flag in metadata or, with a single player, by the dawn time jump (`slept: 'night_skipped'`). Verified live on 02/10 (two nights skipped); the daytime thunderstorm window is offline-tested (`tests/bedrock-weather-sleep.test.mjs`) and not yet observed live. `player_bed_position` is not used as state (it is the respawn bed); with monsters nearby the server refuses and the action reports `sleep_rejected`. |
| `craft_*` | ✅ Working | Recipes from `crafting_data` (network ids), 2×2 grid in the inventory and 3×3 at the crafting table; `item_stack_request` `craft_recipe` with consumes and output. The `stone_tool_materials`/`stone_crafting_materials` tags are mapped (cobblestone/cobbled_deepslate/blackstone) and `minecraft:coals` (coal + charcoal) for torches; `craft_furnace` uses 8 cobblestone at the table; `craft_wooden_sword` (2 planks + 1 stick) and `craft_stone_sword` (2 cobblestone + 1 stick) are offered at the table for combat; `craft_bed` (3 wool + 3 planks, the `wool` tag matches any colour) for travel. |
| `smelt_*` | ✅ Working | Smelting with a static input→output map (the 1.26 protocol does not send `furnace_recipes` in `crafting_data`; if present, they take priority) and the **right station**: blast furnace (`blast_furnace`) for ores, smoker (`smoker`) for food, base furnace for everything else, with fallback to the furnace if the preferred station is absent. Opens the station (`click_block`), puts 1 material in the right ingredient container (`furnace_ingredient`/`blast_furnace_ingredient`/`smoker_ingredient`) and 1 fuel in `furnace_fuel` (coal/charcoal, then planks/logs), waits for the output from server slot updates (reopening the station as fallback) and takes it into the inventory. **Verified live on 02/10**: `craft_furnace` → `place_furnace` → `smelt_raw_iron` → `iron_ingot` (15.8 s, 1 coal consumed). |
| `recover_loot` | ✅ Working | Post-death recovery: the death site is recorded in `deathSite` (feet position); after respawn the action pathfinds back, collects drops within 12 blocks and stays a moment for the XP orbs. `/observe` exposes `deathSite` and `experience`; the result reports `recovered`, `leftNearby`, `expGained`. **Verified live on 02/10** (`e2e-minerals5`: loot recovered after combat death + `+1 EXP`). Since 07/10/2026 the recovery **re-arms**: once the drops are collected it calls `_equipArmor()` and then `_equipShield()` (the shield only ever goes into the offhand, container 34 slot 1) and reports `rearm: { ok, armor, shield, failures }`, with a `recover_loot_rearm` log line when something went on. The re-arm is **best effort**: a refused place does not fail the recovery (`ok` stays true, `rearm.ok` is false with `error: 'rearm_failed'` only when something was wearable and nothing went on). |
| `rearm_gear` | ⚠️ Needs live verification | Puts the carried armor pieces back on and then the shield in the **offhand** — the same pass `recover_loot` now runs by itself after a death. Offered when a slot carries an armor piece the armor slots do not wear, or the shield sits in the pack instead of the offhand (`_needsRearm`, read from the slots and not from the aggregate counts). The result is `{ ok, armor, shield, failures }` (`shield: 'offhand'` when it landed; `ok: false` / `error: 'rearm_failed'` only when something was wearable and nothing went on). Declares the intents `heal` + `shelter` (`survival/intents.mjs`), so the emergency filter keeps it. No live proof yet: the round that proves it is a death with loot to recover. |
| `place_*` | ✅ Basic | Placement with a `click_block` transaction; used for crafting tables and furnaces. The hotbar swap re-reads the inventory from the server (reconnection) if the stack id is stale. |
| `place_torch` | ⚠️ Needs live verification | Places a torch from the inventory on the top face of a solid block next to the bot (reuses the `place_*` click transaction); offered when a torch is held. Not yet verified live on the BDS. |
| `place_bed` | ⚠️ Needs live verification | Places a bed from the inventory (reuses the `place_*` click transaction); offered when a bed is held and none is nearby. Sets the respawn point. Not yet verified live on the BDS. |
| `read_container` | ✅ Working | Censuses nearby storage containers (`chest`/`trapped_chest`/`barrel`/`shulker_box`): approaches, opens with `click_block` (Bedrock `container` window_type), parses `inventory_content` (slots 0..26, 54 for double chests) and stores into `this.containers` (`Map("<x,y,z>" → { type, readAt, contents })`). Exposed in `/observe.containers` with items and quantities. **Verified live on 03/10** (6 chests/barrels read). |
| `take_<item>` | ⚠️ Needs live verification | Takes the whole item slot from a known, non-expired container (`item_stack_request` take from the container slot to the cursor, then back into inventory), verifies the deltas (inventory +N, chest −N) and updates the cache. Offered only if a known container has the item; the description reports position and quantity. |
| `deposit_<item>` | ⚠️ Needs live verification | Deposits a valuable item (ingots, ores, diamonds, ...) from the inventory into the nearest known/nearby container (take to cursor + place into an empty or partial container slot), verifies the deltas and updates the cache. Mitigation for `keep-inventory=false`. |
| `open_trade` | ⚠️ Needs live verification | Approaches the nearest trader (`villager`/`villager_v2`/`wandering_trader`, tracked in `entities` and exposed in `/observe.traders`), looks at it and sends an `item_use_on_entity` transaction with `action_type: interact` (never `attack`). The server answers with `update_trade` (offers NBT) + `container_open` (`trading`); offers are parsed (buyA/buyB/sell, uses/maxUses, tier) into `this.tradeOffers` and exposed in `/observe.trade`. |
| `trade_<index>` | ⚠️ Needs live verification | Executes the selected offer (0-based index from `/observe.trade.offers`) via `item_stack_request`: `take` from the inventory → cursor → `place` into `trade2_ingredient1`/`trade2_ingredient2` (or `trade_*` for the old UI, chosen by `new_trading_ui`), waits for the result slot, then takes it into the inventory and confirms with inventory deltas (inputs consumed, output gained). Offered only when the inputs are present in the inventory. |
| `close_trade` | ⚠️ Needs live verification | Closes the open trading window and clears the cached offers. |
| `level_<profession>` / `level_trader` | ⚠️ Needs live verification | Deterministic **leveling (maxxing)**: targets the nearest trader of the requested profession (`level_cartographer`, `level_farmer`, ...) or the nearest villager (`level_trader`), opens trade, then loops the cheapest available offer until the trader reaches `max_trade_tier` (master) or the budget runs out. The loop **never spends emeralds or precious resources** as input (see the economy heuristic below); it reports `tier`, `maxTier`, `trades`, `maxed` and, when it stops early, `no_economical_trade` (restock at the workstation needed or no cheap materials). |
| `follow_player` | ⚠️ Needs live verification | Follows a human player by gamertag (`plan.follow`): re-reads their live position each leg and `_moveTo`s within 3 blocks (45 s window, ~64-block tracking range). Offered only when `plan.follow` is set and the player is tracked. Driven by the human chat command channel (`@bot seguimi` → Hermes → `/plan`); see `docs/wiki/human-command.md`. |
| `plant_<seed>` | ✅ Working | Plants a seed/vegetable (`plant_wheat_seeds`, `plant_beetroot_seeds`, `plant_carrot`, `plant_potato`, ...) on the nearest free `farmland` (cell above is `air`): equips the item, walks to the farmland and sends a `click_block` transaction on the top face; confirmed when the crop appears in the cell above the farmland (`confirmedBy: server_world`). Offered only when the item is in the inventory and free farmland is loaded. **Verified live on 03/10** (`plant_potato` → `potatoes` reappeared). |
| `feed_<animal>` | ✅ Working | Feeds the nearest farm animal of the requested type the correct food (`chicken`→`wheat_seeds`, `cow`/`sheep`/`mooshroom`→`wheat`, `pig`/`rabbit`→`carrot`): equips the food and sends `item_use_on_entity` with `action_type: interact`. Confirmed by the animal's `inlove` flag (breeding) or by the consumed item. Offered only when the food is in the inventory. **Verified live on 03/10** (`feed_pig` → `inlove`). A first attempt may return `feed_not_confirmed` while the animal is still wandering: retrying once the bot is close succeeds. |
| `attack_<animal>` | ⚠️ Needs live verification | Hunts the nearest farm animal of the requested type (whitelist `cow`/`mooshroom`/`sheep`/`pig`/`chicken`/`rabbit`) using the same `_combat` loop as hostiles; the drop must be collected with `collect_drop` afterwards. **Never** targets villagers/traders or tamed pets. Not tested live on 03/10 (would kill a family animal without consent). |
| `breed_<animal>` | ✅ Working | Breeds two nearby adults of the same type: feeds both (via `_feedEntity`) and waits for a new baby entity (flag `baby`). Offered only with ≥2 adults and ≥2 feed items; cooldown is implicit in the two-not-`inlove` adults requirement. **Verified live on 03/10** (`breed_pig` → `babies: 1`, `baby:true` in `/observe.farmAnimals`). |
| `throw_egg` | ✅ Working | Throws an egg (`use_item` `click_air`); confirmed by the consumed egg. A chick spawns with 1/8 chance and is reported as `chick: observed`/`none`. **Verified live on 03/10** (`chick: none`, egg consumed). |
| `tame_<companion>` | ⚠️ Needs live verification | Tames the nearest wild companion. **Food-based** (`wolf`→bone, `cat`/`ocelot`→raw cod/salmon, `parrot`→seeds): repeats `item_use_on_entity` `interact` until the `tamed` flag (bit 28, wolf/cat/parrot) or `trusting` (flags_extended bit 1, ocelot) or `owner_eid` = bot appears. **Ride-based** (`horse`/`donkey`/`mule`/`llama`/`nautilus`): mounts with an empty hand until the `tamed` flag appears. Not tested live on 03/10 (no companion near the bot). |
| `shear_sheep` | ⚠️ Needs live verification | Shears the nearest adult, not-yet-sheared sheep with `shears` in hand (`item_use_on_entity` `interact`); confirmed by the `sheared` flag (bit 31). Requires `craft_shears` (2 iron ingots at the table). Not tested live on 03/10 (no sheep near the bot). |
| `craft_shears` | ⚠️ Needs live verification | Crafts `shears` from 2 iron ingots at the crafting table (offered when the recipe is present and a table is nearby). Not tested live on 03/10. |
| `mount_<vehicle>` | ⚠️ Needs live verification | Mounts the nearest rideable of the requested type (boats, minecarts, `horse`/`donkey`/`mule`/`llama`/`nautilus`): selects an empty hand and sends `item_use_on_entity` `interact`; confirmed by the rider→vehicle link (`set_entity_link`, `Link.type` 1). |
| `dismount` | ⚠️ Needs live verification | Dismounts the current vehicle via `player_action` `start_sneak`; confirmed by the link removal (`Link.type` 0). |
| `survey_village` | ⚠️ Needs live verification | Bounded, read-only reconnaissance of the village around its detected anchor: walks the general exploration planner's spiral (`planExplorationSweep`, no second engine), censuses houses, plots, pens and containers, and writes the cells it actually walked into the `village_survey` register so the next pass — including one after a restart — skips them. Three independent limits (cooldown `VILLAGE_SURVEY_MS`, exploration budget `VILLAGE_SURVEY_CELLS`, execution budget `VILLAGE_SURVEY_MAX_MS`), first one reached wins; a mission that cannot start **refuses** with a typed code (`village_unknown`, `village_too_far`, `survey_cooldown`), while a mission that stops early reports `truncated: true` + `stoppedBy`. Never digs and never touches an entity (`DIG_PROTECTED` is a global invariant). The census itself is exposed by `/observe.village`; see the section below. |

### Riding and vehicles (update 03/10/2026)

Riding as transport is now wired: mount a vehicle, ride toward a waypoint and
dismount.

- **Classification**: `isVehicleType` covers boats (every `…_boat`, `…_chest_boat`
  and `bamboo_raft`) and minecarts (`…_minecart`); `isRideableType` adds the
  ride-tameable mounts (`horse`/`donkey`/`mule`/`llama`/`nautilus`).
- **Mount**: `mount_<type>` → empty hand + `item_use_on_entity` `interact`;
  `set_entity_link` (`Link.type` 1 = rider) sets `this.riding`.
- **Ride**: when mounted, `goto_waypoint` calls `_rideToward` instead of `_moveTo`:
  continuous forward `player_auth_input` with the `client_predicted_vehicle` flag
  (45) + `up`, no local physics; the server moves the vehicle and corrects the
  position via `correct_player_move_prediction` (`prediction_type: 'vehicle'`).
  Boats could add `paddling_left`/`paddling_right` (46/47) for oar animation
  (not wired yet).
- **Dismount**: `dismount` → `player_action` `start_sneak`; `Link.type` 0 clears
  `this.riding`.
- **Not implemented yet**: saddle equipping for `horse`/`donkey`/`mule`, mount
  inventory/armor, `rider_jump`, and steering a minecart on rails (the current
  ride is a straight "forward toward the waypoint" heuristic).

### Farming and companions (update 03/10/2026)

Crop cycle (`plant_<seed>`), passive-animal interaction (`feed_<animal>`,
`attack_<animal>`) and the stretch (`throw_egg`, `breed_<animal>`,
`tame_<companion>`, `shear_sheep` + `craft_shears`) are implemented and
unit-tested.

**Live verification (03/10/2026)** on the BDS, driven via the harness HTTP API:

- ✅ `read_container` — 6 chests/barrels censused.
- ✅ `mine_potatoes`/`mine_carrots` → `collect_drop` → `plant_potato` — crop
  harvest, pickup and re-sow confirmed by `server_world`.
- ✅ `throw_egg` — egg consumed, `chick: none` (1/8 did not trigger).
- ✅ `feed_pig` — pig entered `inlove` (first attempt `feed_not_confirmed` while
  the animal wandered; retry close-up succeeded).
- ✅ `breed_pig` — `babies: 1`, baby pig with `baby:true` in `/observe.farmAnimals`.
- ⚠️ Not tested live: `attack_<animal>` (skipped, would kill a family animal),
  `tame_wolf`/`tame_cat` (no wolf/cat nearby), `shear_sheep` + `craft_shears`
  (no sheep nearby).

- **Crop cycle**: `mine_<crop>` (already working) harvests mature crops, then
  `plant_<seed>` re-sows on free `farmland`. The seed→crop map (`wheat_seeds`→
  `wheat`, `carrot`→`carrots`, `potato`→`potatoes`, `beetroot_seeds`→`beetroot`,
  `melon_seeds`/`pumpkin_seeds`→stems, `sweet_berries`, `nether_wart`) lives in
  `bedrock-survival.mjs` (`SEED_TO_CROP`). Crop blocks use the **server** names,
  which are not always the Java ones (`beetroot`, singular, has no `beetroots`).
  Maturity (`growth` metadata) is read per cell (`cropMaturity`): `harvest_<crop>`
  offers itself only for a ripe, reachable crop, replants it from the seed in the
  inventory, and a crop that would drop out of reach is refused whole
  (`crop_not_mature`, `harvest_drop_unreachable`) instead of being broken.
- **Farm animals**: `add_entity`/`set_entity_data` track passive animals; the
  flags metadata now exposes `baby`/`tempted`/`inlove` (bits 11/6/7),
  `tamed` (bit 28), `sheared` (bit 31) and `owner_eid` (key 5), exposed in
  `/observe.farmAnimals` (type, distance, baby/inlove/tempted/sheared, owner).
  `attack_<animal>` reuses `_combat` (target lookup falls back from hostiles to
  farm animals via `_entityOfType`); villagers and tamed pets are excluded.
- **World safety**: `farmland`, fences/gates and crop blocks are now in
  `DIG_PROTECTED`, so `dig_down`/`dig_up` never dig through the family farms
  (`mine_*` still harvests crops on purpose).
- **Companion animals** (`/observe.companions`): the census covers the
  food-tameable (`wolf`, `cat`, `ocelot`, `parrot`), the ride-tameable
  (`horse`, `donkey`, `mule`, `llama`, `nautilus` — the recently added aquatic
  companion with its own armor set) and the `axolotl` (not tameable: it follows
  a player holding a bucket of tropical fish and can be caught in a bucket; no
  `tamed`/`trusting` flag, so no `tame_axolotl` action). `tame_<companion>`
  covers both food- and ride-based taming; `owner_eid` (key 5), `tamed` (flags
  bit 28) and `trusting` (flags_extended bit 1) are the confirmation signals.
- **Still not implemented**: mature-crop growth detection beyond the per-cell
  read above (a *scheduled* growth estimate — "this plot is ripe in N minutes" —
  is not modelled). Milk is implemented (`milk_<animal>`, bucket + cow). See
  `docs/wiki/roadmap.md`.

### Village reconnaissance and the farm order (update 06/10/2026)

A village is a **site**, so it is worth reading once and remembering instead of
re-deriving at every step. Two inputs reach the census: the bounded cell scan the
adapter runs for this purpose (one `surveyBlocks` pass for the names that exist —
the fence family is discovered there, never from a whitelist — plus a capped
`findBlocks` per name: `bed`, the crop blocks and fences) and the general marker
detector, so the verdict (`NOT_FOUND`/`CANDIDATE`/`CONFIRMED`), the evidence and
the anchor cannot drift from `/observe.structures`. Villagers are the detector's
evidence while livestock belongs to the pens: the two lists are different, and
feeding the wrong one to the detector was why a real village could never be
confirmed before 06/10.

- **`/observe.village`** (and `observe().village`, memoized for
  `VILLAGE_RESCAN_MS`, `?force=1` to re-read) exposes houses (beds with their
  `occupied` bit, own containers, nearby doors), plots per crop family with
  `ready`/`immature`/`unknown`, pens with adults/babies and a `fenced` flag, and
the storage rows with what is known about each container.
- **Every fact says how much of it was read**: `confidence` (the share of the
  fact actually measured, never an estimate), `evidence` (the numbers behind it)
  and `missing` (the named holes: `occupancy`, `door`, `container`, `ripeness`,
  `fence`, `contents`). What is below a threshold does not vanish: it is counted
  in `ignored` (`plots`, `animals`, `containers`), and `thresholds` + `limits`
  travel in the payload so a reader never has to guess the rules.
- **The farm order**: `@bot raccogli le carote` (or "mieti il grano e
  rimpiantalo") is classified as `plan.farm = {crop, block, seed, word, replant,
  store, field, before}` — crop family plus a farm verb, no LLM — and the
  controller drives it against `/options` one bounded step at a time:
  `collect_drop` → `harvest_<block>` (cap 8) → `plant_<seed>` (only if the
  harvest did not replant) → `deposit_<crop>` (or `dump_inventory` for "il baule
  più vicino"). The goal closes on a **state delta**: the container must have
  grown *and* the backpack must not have (carrots already in the bag are not a
  harvest). An order naming the crop while the bot holds it and no drop is on
  the ground is a farm order, not the old pick-up order; a number ("raccogli 4
  carote") still goes to the planner. See
  [village reconnaissance](docs/wiki/village-recon.md) and
  [human command](docs/wiki/human-command.md).
- Offline: `tests/village-survey.test.mjs`, `tests/village-view.test.mjs`,
  `tests/village-sweep.test.mjs`, `tests/village-sweep-action.test.mjs`,
  `tests/village-honesty.test.mjs`, `tests/controller-farm-order.test.mjs`.
  The live rounds (a sweep with a bed and farmland deliberately in the route,
  the farm-order A/B, the four-case chest ladder) are still open.

### Trading (update 03/10/2026)

- **Trader detection**: `add_entity`/`set_entity_data` track traders via
  `isTraderType` (`villager`, `villager_v2`, `wandering_trader`, `trader_llama`);
  profession (`variant` metadata) and trade tier (`trade_tier` metadata) are kept
  when the server sends them. `/observe.traders` lists type, position, distance,
  wandering flag and, when known, profession/tier.
- **Opening**: `open_trade` sends `inventory_transaction` `item_use_on_entity`
  with `action_type: interact` (the same wire shape as `attack`, without the
  swing); it is safe (never `attack` on a trader).
- **Offers**: `update_trade` carries `offers` as network NBT
  (`Recipes[].buyA/buyB/sell`, `uses`, `maxUses`, `tier`); parsing handles both
  the full prismarine-nbt tag form and an already-unwrapped plain object, strips
  the `minecraft:` prefix and collapses an empty (`air`) second input to `null`.
  `new_trading_ui` selects the `trade2_*` slot containers (BDS 1.26 uses the new UI).
- **Execution (to confirm live)**: the exact client→server transaction for the
  trade is the remaining reverse-engineering point. The implemented flow is the
  vanilla one: place the buy inputs into the trading ingredient slots, then take
  the result from the trading output; the server consumes the inputs and produces
  the output. Confirm with `BEDROCK_PACKET_LOG=1` (delta of the input/output
  slots and the `item_stack_response`); the `trade_<index>` result reports
  `consumedA`/`consumedB`/`gained` for verification.
- Economy: no random trades — every offer is shown to Jev with cost, output,
  remaining uses and (for wandering traders) a despawn warning; the decision
  stays with the controller.
- **Leveling economy (pure module `bedrock-trading.mjs`)**: items are classified
  as *precious* (diamond/iron/gold/netherite/lapis/ender-pearl/blaze-rod/... —
  never spent by the auto-levelling loop), *emerald* (the currency, avoided), *cheap*
  (paper, glass panes, crops, logs/planks, seeds, wool, coal, flint, ... —
  preferred) and *neutral* (redstone, sculk, copper, ...). `pickBestTrade` picks the
  offer with the lowest per-item input cost among those whose inputs are in the
  inventory and that still have uses left; the default cap (`maxCost=1`) excludes
  emeralds and precious items, so the loop only ever sells cheap/neutral items.
- Profession targeting is **verified live** via `update_trade.display_name`
  (e.g. "Cartographer") — the metadata (`trading_career`/`mark_variant`) is only a
  best-effort hint to order the candidates; a wrong guess is corrected by opening
  the trader and checking the name before levelling. Wandering traders are never
  levelled (no tier progression).

### Survival (update 02/10/2026)

- **Entities**: `add_entity`/`add_player`/`move_entity`/`set_entity_data`/`entity_event`
  feed a map of mobs and players with position, distance and health (`health`
  metadata); a type list classifies hostiles (zombie, skeleton, creeper, enderman, ...).
- **Time of day**: BDS 1.26 does not send `set_time`; time comes from
  `sync_world_clocks` (clock `minecraft:overworld`, `% 24000`) with `set_time` fallback.
- **Player attributes**: `update_attributes` uses the `current` field (not `value`)
  for health, hunger and level/experience (`minecraft:player.level`,
  `minecraft:player.experience`).
- **Death and respawn**: health <= 0 → `dead` state; the client sends a respawn
  `player_action` and completes the flow by answering the server's `Respawn`
  packets with `state = 2` (client_ready). The final position applies at `state 1`;
  fallback at 4 s. Verified live on 02/10 (the bot died in combat and woke up at
  the bed).
- **Post-death recovery**: at death the site is recorded (`deathSite`); after
  respawn `/options` offers `recover_loot`, which returns to the spot, collects
  drops within 12 blocks and stays for the XP orbs. The site remains until there
  is no more loot nearby (or the path fails: retried later). **Verified live on
  02/10** (`recover_loot` → loot recovered + `+1 EXP`).
- **Post-respawn limbo**: if the fallback closes the respawn but health stays at 0
  (server not ready, inputs ignored), the survival tick reopens the respawn flow
  after 5 s (`respawn_limbo_recover`). Recovery observed live on 02/10 with a
  container restart (then automated).
- **Unresolved hashes**: `unknown` blocks are conservative in planning (no paths
  through invisible walls) and diggable with a raw break (`_mineRawCell`).
- `/observe` exposes `time`, `sleeping`, `dead`, `deaths`, `deathSite`,
  `experience`, `entities` (with distance, type and health), `containers`
  (census of read chests/barrels, with position, type, `readAt` and per-item
  contents), `traders` (nearby villagers/wandering traders) and `trade` (the
  parsed offers of the open trading window, with target, tier and UI type).
- `/options` offers `attack_<type>`, `flee`, `eat`, `sleep`, `dig_up` and
  `recover_loot` when valid; `attack_` options are deduplicated per type. It also
  offers `read_container` (nearby unread containers), `take_<item>` (items present
  in a known chest), `deposit_<item>` (valuables with a known/nearby chest),
  `open_trade` (nearby trader), `close_trade`, `trade_<index>` (each offer
  whose inputs are currently in the inventory) and `level_<profession>`/
  `level_trader` (level a non-maxed trader using only cheap trades).
- Verified live (02/10): entity tracking (cat, pigs, creeper/zombie/skeleton with
  health), clock/night, hunger, base beds, attack (landed hits), flee, sleep (two
  nights skipped), death+respawn, mining/breaking (also of `unknown` cells), dig_up
  from the pit, post-death recovery (loot + EXP), coal and iron mined and
  collected, smelting `raw_iron → iron_ingot`. `eat` remains covered by unit tests
  and serialization: live testing needs hunger < 20 and food in inventory.
- Diagnostics: `GET /debug/geom` and `POST /debug/mine` routes (only with
  `BEDROCK_DEBUG=1`); optional logs `BEDROCK_PACKET_LOG=1` and `BEDROCK_META_LOG=1`.

### Stone phase of the milestone (update 01/10/2026)

Chain `wood → wooden pickaxe → dig → stone → stone pickaxe` completed by the
Hermes → Jev → Bedrock loop:

1. `dig_down` digs the staircase in the ground (dirt/grass) and descends one block
   per action; when the step is `stone` the wooden pickaxe is used and the descent
   automatically collects the cobblestone.
2. `mine_stone`/`mine_cobblestone` with `wooden_pickaxe` in hand: server
   confirmation + destruction event with vanilla timing (≈ 1.3 s with a wooden
   pickaxe); drops are collected with `collect_drop`.
3. `craft_stone_pickaxe` (3 cobblestone + 2 sticks) on the 3×3 grid of a crafting
   table.

Reference run: `runs/e2e-stone6/controller.jsonl` — `GOAL MET after 33 actions`,
inventory with `stone_pickaxe: 1` (started from an inventory with no tools: wood,
wooden pickaxe craft, dig and stone pickaxe). Dig-with-descent evidence:
`runs/e2e-stone1/controller.jsonl`.

### Minerals and durability phase (update 01/10/2026)

After stone the next step is ores: coal (any pickaxe) and iron/copper (stone
pickaxe or better). Validity stays in the harness:

1. **Harvest rank**: the `harvestTools` sets of the 1.26 registry, compared with
   previous versions (1.21.42 has no copper tools), give the per-material rank:
   wood/gold = 1, stone/copper = 2, iron = 3, diamond = 4, netherite = 5.
   `_blockHarvestable` rejects the block if no inventory tool covers the rank; the
   `mine_*` options are not offered for the wrong tier.
2. **Tool selection**: `_selectToolFor` prefers the fastest pickaxe *among those
   that drop the item* and uses the absolute fastest only as a fallback. On coal
   the gold pickaxe wins (fast), on iron the stone one kicks in.
3. **Durability**: BDS keeps wear in the NBT `Damage` (metadata stays 0); `/observe`
   exposes `heldDurability: {damage, max}` for the held item and break requests
   send a coherent `predicted_durability`.
4. **Propaedeutic crafts**: mapped the `minecraft:coals` tag (coal + charcoal) for
   `craft_torch`; `craft_furnace` appears with 8 cobblestone and a nearby table.
5. **Ore detection**: `/observe.nearby` includes coal, iron and copper (also
   deepslate variants).

Live evidence (Docker host, container `hermes-jev-bedrock`):

- `runs/e2e-minerals1/controller.jsonl` — `GOAL MET after 2 actions`,
  `mine_copper_ore` with `stone_pickaxe`, `collect_drop` → `raw_copper: 1`.
- `runs/e2e-minerals5/controller.jsonl` — coal mined several times and collected
  (`coal: 6`); combat death with **loot recovery and +1 EXP** (`recover_loot` →
  `recovered: [stone_pickaxe, oak_log, coal, oak_planks, wooden_pickaxe ×2]`).
- `runs/e2e-iron3/controller.jsonl` — `GOAL MET after 25 actions`: re-craft of the
  stone pickaxe, `mine_iron_ore` confirmed and `raw_iron: 1`.
- `runs/e2e-smelt1/controller.jsonl` — `GOAL MET after 3 actions`: `craft_furnace`
  → `place_furnace` → `smelt_raw_iron` → **`iron_ingot: 1`** (`furnace` station,
  1 coal).

204 green unit tests (including `survival/` and `controller-decisions.mjs`).
During these tests were fixed: `dig_down` steering towards the waypoint, full-hotbar
eviction (`hotbar_evict`), container mapping for take/place
(`hotbar`/`hotbar_and_inventory`, open window required) and dirty-cursor recovery
after a failed place.

### Robust controller (update 01/10/2026)

`controller.mjs` no longer hangs when the Hermes planner is unavailable or slow:

1. the CLI is launched with detached `spawn` and, at `HERMES_TIMEOUT_MS` (default
   180000), the whole process group is killed (`SIGKILL`) — the `hermes` shim forks
   a process that would otherwise keep stdout open and make
   `spawnSync`/`execFileSync` wait forever;
2. if the CLI does not answer, the controller degrades to a static plan built from
   `GOAL`/`TARGETS`/`WAYPOINT` (`plan_fallback` in the logs) and continues with Jev;
3. the action that just failed is excluded from the next choice, so a
   `goto_waypoint` with no path does not burn the whole budget.

### Jev decision quality (update 02/10/2026)

The pure logic lives in `controller-decisions.mjs` (18 unit tests in
`tests/controller-decisions.test.mjs`); the harness remains the only owner of
validity and the controller can only reorder, cap or temporarily hide the offered
keys.

1. **Decision instructions** (`buildDecisionInstructions`): explicit priorities —
   survival (flee if health is low or the fight is lost, sleep if night and a bed
   is reachable, eat if hunger is low, attack only with enough health), recovery
   (drops and death site), objective — plus the rule "never repeat an action that
   produced no progress".
2. **Anti-loop**: after each action the controller compares the observation
   fingerprint (rounded position, inventory, plan objective) with the one at choice
   time. `ANTI_LOOP_THRESHOLD` (default 3) consecutive actions of the same key with
   no progress force a replan and put the key in cooldown for `ANTI_LOOP_COOLDOWN`
   steps (default 3). Logs: `no_progress`, `anti_loop`, `replan`. The controller
   never empties the set: if everything is excluded, it restores the harness options.
3. **Option cap**: with more than `MAX_OPTIONS` (default 12; 0 disables) options,
   the most relevant survive (survival → loot recovery → drops → actions that hit
   targets → craft/place/smelt → travel/dig → generic mining → `wait`, with
   distance as tie-break). `wait` is hidden when an alternative exists; the
   excluded ones land in the logs (`options.excluded`, `options.droppedByCap`).
4. **Diagnostics**: every decision logs the candidate keys with per-key probability
   (not just the chosen index), `selectedProbability`, `confidence`, `cost`, `ms`
   and the objective; `wait_only` records the reason (death, sleep, no useful
   option) when the harness offers only `wait`; a **blind harness** (session down,
   `/options` empty or `connected: false`) is not a decision at all: the
   controller waits `HARNESS_BLIND_WAIT_MS` and stops the run after
   `HARNESS_BLIND_MAX_STEPS` consecutive blind steps (`harness_blind`,
   `harness_blind_stop`, exit code 2) without spending action budget;
   `result` records the outcome of every action; `goal_met`/`budget_exhausted`
   include the total cost.
5. **Smoke test**: with a fake harness in `/tmp`, a loop of 3 stagnant
   `goto_waypoint` produced `anti_loop` → replan → exclusion → `mine_dirt` choice
   (log `runs/smoke-decisions/controller.jsonl`).

### Survival Intelligence Layer (update 02/10/2026)

Deterministic layer between the user objective and the bounded actions, inspired by
Voyager concepts (skill library, curriculum, self-verification) **without**
code-generation: no model generates JavaScript for Minecraft behaviour. Full
architecture and extension guides in
[`docs/raw/SURVIVAL-INTELLIGENCE.md`](docs/raw/SURVIVAL-INTELLIGENCE.md).

1. **Survival Governor** (`survival/governor.mjs` + `knowledge/survival-rules.json`):
   health/food/hostiles/night evaluation with explicit rules and priorities. Output
   `{mode: normal|caution|emergency, needs, overrideObjective, allowedIntents,
   preferredSkills, risk}`; with priority ≥ 95 or `critical` risk, emergency kicks
   in, the objective shown to the decision model is overridden and `/options` is
   restricted to the allowed intents (the filter can only remove already-offered
   keys, never add any, and never empties the set).
2. **Compact state in `/observe`**: `survival: {mode, risk, level, rule, needs,
   reasons, overrideObjective}`. `GET /survival` exposes the full governor, the
   active skill and the suggested milestone.
3. **Declarative gameplay skills** (`skills/gameplay/**`): JSON with preconditions,
   success/failure criteria and intents; a different concept from the Hermes skill
   `skills/minecraft-bounded-agent/SKILL.md`. The loader validates files at harness
   and controller startup.
4. **Skill Resolver** (`survival/resolver.mjs`): the active skill is the one the
   governor prefers in an emergency, then the optional `skill` field of the plan,
   then the progression milestone; the active skill's intents boost relevance in
   the controller's option ranking.
5. **Deterministic verification** (`survival/verify.mjs`): `verifySkill(skill,
   before, after)` checks real state (inventory by tag, hunger/health deltas,
   separation from hostiles, night survived). Every outcome lands in
   `runs/<run>/skills.jsonl` (skill, outcome, actions, duration, reason).
6. **Progression Engine** (`survival/progression.mjs` + `knowledge/progression.json`):
   dependency graph; `resolveMilestone` returns the first missing prerequisite.
   With `CURRICULUM=<milestone>` (e.g. `first_night`, `enter_nether`) the controller
   builds the deterministic plans by itself and uses Hermes only as fallback.
7. **Offline smoke test**: fake harness + `hermes` CLI stub ran
   `wood → crafting table → food → first_night` with an emergency interruption
   (creeper at 4.2 blocks, health 4) that filtered options to `[flee, eat]` and
   then resumed from the same milestone; `GOAL MET after 7 actions`, 4 records in
   `runs/smoke-curriculum/skills.jsonl`.

### Inventory and stack ids (update 01/10/2026)

BDS 1.26 does not send slot updates on pickup (`take_item_entity` only updates
aggregate counts). If a pickup merges with an existing stack, the server assigns a
new `stack_id` the client does not know: `take`/`place`/`swap` fail with status
49/50 (`FailedToValidateSrc/DstSlot`).

The adapter handles the case self-healingly:

1. pickups are accumulated in `pickups` and shown in the aggregate (`/observe`)
   until reconciled;
2. if a craft fails with `missing_ingredients` (aggregate > slots) or
   `take_failed_49/50`/`place_failed_49/50`, the adapter reconnects once
   (`inventory_resync` in the logs): at login BDS always sends a full
   `inventory_content` with updated stack ids;
3. then it retries the craft with the fresh ids.

The same resync is used when a hotbar swap or a placement finds a stale stack id.

**Container mapping for take/place (discovered live on 02/10/2026)**:
`item_stack_request` requests are valid only with an **open window** (without a
container BDS answers 49/50). Outside crafting these rules apply:

1. **sources**: hotbar with `hotbar`/0..8, main inventory with
   `hotbar_and_inventory`/**absolute index** (0..35); `inventory` as source gives
   status 49;
2. **destinations**: always `hotbar_and_inventory`/absolute index (0..35);
   `inventory` as destination gives status 50;
3. **direct cross-container swaps** are not accepted: to move an item use
   take→cursor and place→destination;
4. a **failed place leaves the item on the cursor server-side**: subsequent takes
   to the cursor fail with 50 until it is put back into a slot (the adapter retries
   putting it back into the source).

This solved the "full hotbar" block: the bot moves junk into an inventory hole
(eviction) and brings the tool into the hotbar, all via the cursor.

### Crafting and placement (update 01/10/2026)

BDS uses `item_stack_request` with slot **stack ids** and an open container session:

1. `interact open_inventory` opens the inventory (2×2 grid at blocks 30/31/28/29); a
   `click_block` on the table opens the `workbench` window (3×3 grid at blocks
   32..40).
2. For each ingredient: `take` from inventory to cursor, `place` from cursor to grid
   (with the current stack id of the destination slot).
3. The craft request contains `craft_recipe`, `results_deprecated`, a `consume` for
   each grid slot and a `place` from the created output (`creative_output`, slot 50,
   stack id = request id) into the inventory.
4. `item_stack_response` replies are applied to the local inventory copy; grid and
   cursor are tracked and cleaned up on error.

Note: `slot_type.dynamic_container_id` must be **omitted** (with the field present
BDS treats the container as dynamic and rejects requests). The stack ids of
existing piles are mandatory to merge the output; tools (stack 1) do not merge.

Verified on the real server: `oak_log → oak_planks → stick → crafting_table →
place → wooden_pickaxe` and a Hermes → Jev → Bedrock loop with `GOAL MET`
(4 `wooden_pickaxe` in inventory).

### Movement (update 01/10/2026)

BDS 1.26 uses **server-authoritative** movement: the client sends a `player_auth_input`
each tick with simulated position, `move_vector` and intent flags; the tick must
stay inside the rewind window (`rewind_history_size`, 40 ticks) and is realigned by
`correct_player_move_prediction`. The old `move_player` with arbitrary positions is
discarded or rewound by the server: hence the `movement timeout` on routes with
obstacles or elevation changes.

The adapter now:

1. simulates locally walking (0.2158 b/tick), gravity, collisions, steps and jumps;
2. sends the simulated position and intent (`up`, `jumping`, `start_jumping`,
   collision flags) in the same `player_auth_input`;
3. plans with A* over the loaded world (support, ±1 steps, falls up to 4 blocks)
   toward the nearest walkable node to the target;
4. opens closed doors with a `click_block` (`item_interact`) transaction when it
   encounters them;
5. accepts server corrections beyond 0.75 blocks and realigns the tick anchor.

Verified on the real server: exit from the spawn room through the door, 13-21 block
routes with client and server positions coinciding, drop collection with updated
inventory count (`take_item_entity`), and a Hermes → Jev → Bedrock loop with
`GOAL MET` (`oak_log` 9 → 10).

---

## Known issues

- **Climbing out of pits/wells**: solved with `dig_up` (opens ceiling and step and
  climbs); verified live on 02/10 exiting the dig pit (from y=67 to y=73 in 5
  steps). Before the protection, a `dig_up` dug a base chest: it now respects
  `DIG_PROTECTED` like `dig_down`.
- **`connecterror:9`**: the correct teardown passed consecutive cycles, but switching
  between different clients reproduced the block on 01/10. Dead time alone is not a
  proven solution (error persistent for about 9 hours). A BDS restart at zero
  players restores the service. The new harness has a single connection worker;
  `connect()` shares the attempt between concurrent callers and also cleans up
  errors before spawn. Do not consider these tests a guarantee for external clients
  that do not wait for teardown.
- **Respawn stuck after death (server-side, mitigated 2026-10-02)**: the BDS
  ignores `player_action respawn`, so after a death the bot stayed `dead`
  (`health: 0`). A client `respawn` packet (`state: 2`) runs the handshake
  (`SERVER_SEARCHING` → `SERVER_READY`) but does not restore health either — a
  server-side bug. Workaround: if still dead after `RESPAWN_RECONNECT_MS`
  (default 25 s) the adapter closes the client and the harness reconnects (fresh
  login), which spawns the bot alive — verified live, no BDS restart. A clean
  in-place respawn is still missing; details in `docs/wiki/open-questions.md`.
- **Drops during mining (solved 02/10)**: the NetherNet session dropped after 1-2
  dug blocks (`client_close: disconnected`, also from the container). Cause:
  `item_stack_request` of `mine_block` with ids `-1, -2, ...`; the vanilla client
  uses negative odd ids. Fixed using the same sequence as crafting; after the fix
  mining holds (verified live). The general NetherNet instability remains (see below).
- **Attack and damage**: hits are sent and land (verified live), but on armoured mobs
  the per-hit damage is low and `_combat` can expire before the kill
  (`combat_timeout` with `hits` set). Possible improvement: prefer a weapon
  (sword/axe) and/or lengthen the per-action time. `weapon: null` means there was no
  sword in inventory during the test.
- **Registry**: `start_game.block_properties` is not the full runtime-id palette. Do
  not assign the array index to elements, nor force `diggable` or `hardness`.
  `bedrock-world.mjs` uses `prismarine-registry` with `block_network_ids_are_hashes`
  and the vanilla table of the configured version.
- **Chunk parser**: the general `prismarine-chunk` loader does not select 1.26; the
  existing Bedrock v9 decoder is reused explicitly with the 1.26 registry. In this
  BDS `level_chunk` contains biomes and `highest_subchunk_count`: it needs
  `subchunk_request` requests and `subchunk` replies, not the `sub_chunk` event.
- **Unavailable data**: unreceived sections return `null`; hashes not in the registry
  return `unknown`, not air or concrete. At the 01/10 test there are 39-41 unknown
  hashes. Since 02/10 `unknown` is conservative also for pathfinding (before it
  counted as traversable and the bot got stuck against invisible walls);
  `dig_up`/`dig_down` can dig `unknown` cells with a raw break. Dirt, stone and logs
  are recognized with correct hardness.
- **Partial blocks**: the adapter does not know the exact height of beds, slabs and
  stairs; local physics approximates them as full cubes and the server reports the
  correct altitude with `correct_player_move_prediction`. Movement stays smooth, but
  altitude can oscillate ~0.5 blocks on these blocks.
- **Server-authoritative inventory**: BDS does not send inventory updates on pickup;
  the adapter updates the count from the `take_item_entity` packet (collection
  confirmation) and reconciles with `inventory_content` on the next connection.
- **Persistent inventory**: the bot's account is the same one used by the human
  player; the inventory survives between sessions. Controller targets must be chosen
  above the current count.
- **Crafting**: shaped/shapeless recipes with ingredients by name or tag (`planks`,
  `logs`, `stone_tool_materials`) are supported; recipes without a known output
  (multi) and special recipes (smithing, anvil, looms) are not implemented. Crafting
  always uses one item at a time (no `times_crafted > 1`).
- **Placement**: placement only on a top face adjacent to the bot; no block scaling
  or orientation.
- **Items in the world**: a failed craft can leave items in front of the table
  (container closed with a full grid). The adapter cleans the grid before closing
  when it can track it.
- **Stack id after a pickup**: see "Inventory and stack ids". If the aggregate has
  more materials than slots, a craft tries an automatic reconnection
  (`inventory_resync`) before giving up.
- **Unstable NetherNet**: in some time slots the session drops every few seconds
  (BDS log: `Player disconnected` after 3-20 s, no server-side error). The harness
  reconnects by itself; during reconnection `/options` offers only `wait`. One
  specific, solved case was mining (`item_stack_request` with invalid id, see above).
  The documented remedy for the persistent block is a BDS restart at zero players;
  in long runs it is worth raising `MAX_STEPS` because flaps consume steps.
- **`dig_down` and built blocks**: the step is refused (`protected_*`) if
  head/front/step contain tables, containers, stations or building materials
  (planks, slabs, stairs, wool, glass, bricks, concrete). Same for `dig_up`. It
  avoids destroying the base; use `mine_*` for natural blocks.
- **Hermes planner**: the primary provider can run out of quota and the fallback may
  not answer; the controller now degrades to the static plan (see "Robust
  controller") and logs `plan_fallback`.

### Tests and switching between clients

`npm run test-world` checks blocks from a real BDS 1.26.52 capture, singleton
palette with hashes and negative coordinates. `npm run test-reconnect` verifies
three logins, concurrent callers and natural blocks received from the server;
requires `.env` and a valid Xbox cache. `node --env-file=.env test-movement.mjs [x z]`
verifies a route with pathfinding towards a distant waypoint (default `76 148`).
For local tests with the same account, stop the container first.

Stop the container before starting a test on the node with the same account. Wait
for `await closeBedrockClient(client)` (or `await adapter.disconnect()`), then
restart the container. To integrate other actions reuse the adapter's client and
`world.blockAt()`/`world.findBlocks()`: the port remains based on the Prismarine
libraries. Do not change the world to work around a wrong read.

---

## Links

- Original Java repo: `teknium1/hermes-and-jev-play-minecraft`
- Local fork: `giaffa86/hermes-and-jev-play-minecraft-bedrock`
- bedrockflayer NetherNet fork: `giaffa86/mineflayer-for-bedrock-nethernet`
- Local wiki (private, unpublished): Minecraft Bedrock page
- Local wiki (private, unpublished): Hermes Agent page
