# Hermes and Jev play Minecraft

[Hermes Agent](https://github.com/NousResearch/hermes-agent) plans. [Jev](https://typesafe.ai) (TypeSafe's System-One model) picks one bounded action at a time. A Mineflayer harness decides which actions are valid and executes them. No screenshots, no keypresses, no generated code from any model.

> **Bedrock Edition fork**: this repository is the port to Minecraft Bedrock Edition. For specific instructions (Docker, NetherNet, deploy on the Docker host) see [`BEDROCK.md`](BEDROCK.md).  
> See also the Mineflayer-like framework for Bedrock/NetherNet: [`giaffa86/mineflayer-for-bedrock-nethernet`](https://github.com/giaffa86/mineflayer-for-bedrock-nethernet).

The split is the one [rmalde/minecraft-agent](https://github.com/rmalde/minecraft-agent) used to beat the Ender Dragon from a fresh Survival world in 8:43 with GPT-6 Astra + Jev. That repository has no license, so **nothing here is copied from it**; this is an independent, much smaller implementation of the same architecture, built to (1) run the pattern with Hermes as the planner and (2) reproduce the original result.

## What is in here

| Path | What |
|---|---|
| `harness.mjs` | Pure-Node Minecraft 1.16.5 server ([flying-squid](https://github.com/PrismarineJS/flying-squid), no Java needed) + one Mineflayer bot + a bounded-action HTTP API: `GET /observe`, `GET /options`, `POST /act`, `POST /plan`. **Validity is decided here**, not by the model. |
| `bedrock-harness.mjs` | The Bedrock target: the bot (NetherNet transport) plus the same bounded-action API against a Bedrock server. Boot it instead of `harness.mjs` for everything the village runs on; see [`BEDROCK.md`](BEDROCK.md). |
| `bedrock-adapter.mjs` | The Bedrock adapter behind that API: `observe()` (nearby blocks with crop growth, farm animals, bees, fishing, fluids, redstone, portals, containers, drops), `options()` (which intents are valid *right now*) and every action implementation. |
| `idle-goals.mjs` + `village-labor.mjs` | The two deterministic `IDLE` producers: survival **needs** (M3) and village **chores** (M3b). No model decides them; see [Player-facing properties](#player-facing-properties-bedrock). |
| `human-replies.mjs` + `human-questions.mjs` + `chat-llm.mjs` + `chat-i18n.mjs` + `chat-narration.mjs` | The chat layer: the message catalogue (it/en/fr/es/de, `CHAT_LANG`), the deterministic replies and answers (`planPhrase`, `CHORE_LABELS`/`NEED_LABELS`), the optional LLM rephrasing (M6/M7/M7.1/M7.2) and the autonomy narration (M8). |
| `controller.mjs` | The loop. Planner = Hermes via `hermes chat -Q --oneshot` at milestones. Controller = Jev via OpenRouter `POST /api/alpha/decisions` (a `choice` question over the harness's options), or Hermes with `CONTROLLER=hermes`. Logs every plan and decision (choice, candidate keys, per-key probabilities, confidence, cost, latency) to `runs/<id>/controller.jsonl`. Anti-loop: repeated actions with no progress (position, inventory, objective) force a replan and are temporarily excluded. |
| `controller-decisions.mjs` | Pure decision helpers for the controller: option ranking/cap, anti-loop detection, progress fingerprint, wait diagnostics, decision instructions. Unit tests in `tests/controller-decisions.test.mjs`. |
| `survival/` | Deterministic Survival Intelligence Layer: perception, risk/needs scoring, Survival Governor, declarative gameplay-skill loader, skill resolver, deterministic verification, progression resolver, JSONL experience. Pure logic with unit tests; no model, no code generation. |
| `knowledge/survival-rules.json` | When to interrupt progression (low health near a hostile, starving, night unprepared, ...). Explicit condition vocabulary, validated at load. |
| `knowledge/progression.json` | Declarative milestone graph (wood → crafting table → stone tools → food → first night → iron → diamonds → nether) with dependencies, not a hardcoded sequence. |
| `skills/gameplay/` | Declarative gameplay skills (JSON): preconditions, success/failure criteria, intents. Different concept from the Hermes Agent `SKILL.md`; they never contain executable code. |
| `docs/` | An **LLM wiki** (manifest, index, sources, log, raw sources, synthesis pages). Start at [`docs/index.md`](docs/index.md); see [`docs/llm-wiki.md`](docs/llm-wiki.md) for the conventions. |
| `docs/wiki/survival-intelligence.md` | Synthesis of the deterministic Survival Intelligence Layer (governor, skills, resolver, verification, progression). Full reference in [`docs/raw/SURVIVAL-INTELLIGENCE.md`](docs/raw/SURVIVAL-INTELLIGENCE.md). |
| `docs/wiki/headless-client.md` | How the bot sees and acts in the world with no graphics: protocol-level perception and actions, the bounded-action loop, short-range x-ray vision, the absence of real exploration, and why its "render distance" is not comparable to a human's. |
| `skills/minecraft-bounded-agent/SKILL.md` | Hermes skill: how to drive the harness directly from a Hermes session (`hermes chat -t terminal`). |
| `docs/wiki/reproduction.md` | Summary of reproducing the original Ender Dragon result (7:45, exact models). Full report in [`docs/raw/REPRODUCTION-REPORT.md`](docs/raw/REPRODUCTION-REPORT.md). |

## Setup with your Hermes install

Prerequisites:

- **Node.js 18+** (tested on 26). No Java: the Minecraft server is pure Node.
- **Hermes Agent** installed and logged in to any provider — `hermes chat -Q --oneshot -q hi` must answer. Nous Portal, OpenRouter, Anthropic, OpenAI, a local model: anything works, Hermes is only the planner.
- **`OPENROUTER_API_KEY`** for the Jev controller (Jev is served through OpenRouter's decisions endpoint; ~$0.00004 per decision, the demo below costs well under a cent). Skip it and use `CONTROLLER=hermes` if you don't have one.

```bash
git clone https://github.com/teknium1/hermes-and-jev-play-minecraft && cd hermes-and-jev-play-minecraft
npm install

# terminal 1 — server + bot + API. First boot generates the world, ~25 s. Prints "harness api on 3077" when ready.
RUN_ID=demo node harness.mjs

# terminal 2 — Hermes plans, Jev acts
export OPENROUTER_API_KEY=sk-or-...
RUN_ID=demo WAYPOINT='{"x":380,"z":16}' TARGETS='{"dirt":4}' MAX_STEPS=14 node controller.mjs
```

Expected output ends with `GOAL MET after N actions {...}`; the full trail is in `runs/demo/controller.jsonl` (plans + every Jev decision with probabilities, confidence, latency, cost) and `runs/demo/events.jsonl` (harness-side actions and results).

Knobs (all env vars): `GOAL` (free text for the planner), `TARGETS` (`{item: minCount}`), `WAYPOINT` (`{x, z}` or unset), `MAX_STEPS`, `REPLAN_EVERY` (default 8), `CONTROLLER=jev|hermes`, `JEV_MODEL` (default `typesafe/jev-1.13`), `MAX_OPTIONS` (cap on the options passed to the controller, default 12, 0 disables), `ANTI_LOOP_THRESHOLD`/`ANTI_LOOP_COOLDOWN` (default 3), `CURRICULUM=<milestone>` (e.g. `first_night`, `enter_nether`: the progression engine picks the next missing prerequisite itself), `MC_PORT`/`API_PORT` if 25599/3077 are taken, and the human chat command channel: `CHAT_ALLOWLIST` (gamertag/xuid, comma-separated; enables `@bot` control), `CHAT_PREFIXES` (triggers accepted, comma or space separated, e.g. `@bot,@hermes`; default `@bot`, the legacy `CHAT_PREFIX` still works and is summed in), `CHAT_CONTROL` (default `on` when allowlist set), `CHAT_GREET`/`CHAT_GREET_RANGE`/`CHAT_GREET_COOLDOWN_MS`/`CHAT_GREET_TEMPLATE` (proactive greeting: the bot tells a nearby trusted human the order syntax via `POST /say`; default on when the channel is open), `CHAT_INTENT`/`CHAT_INTENT_URL`/`CHAT_INTENT_MODEL`/`CHAT_INTENT_TIMEOUT_MS`/`CHAT_INTENT_MIN_P` (chat **questions**: `@bot dove sei?` is answered from `observe()` — regex fast path, then System One/Jev over a closed intent list — and creates no goal; default on with a TypeSafe/OpenRouter key), `CHAT_SELF_NAME`, `CHAT_REPLY`/`CHAT_REPLY_MAX_LENGTH`, `CHAT_MAX_AGE_MS`, `CHAT_ECHO_WINDOW_MS` (chat lifecycle: answer to its own name, reply length, stale-order window, own-echo recognition), `CHAT_LANG` (language of every sentence the bot composes: `it`/`en`/`fr`/`es`/`de`, default `it`), `DEEPSEEK_API_KEY`/`CHAT_LLM_API_KEY` + `CHAT_LLM`/`CHAT_LLM_URL`/`CHAT_LLM_MODEL`/`CHAT_LLM_TIMEOUT_MS`/`CHAT_PERSONA` (natural chat: an LLM rephrases the deterministic reply, see below), `CHAT_NARRATE`/`CHAT_NARRATE_COOLDOWN_MS` (M8: the bot says out loud what it is about to do on its own) and `SESSION`/`AUTONOMY`/`VILLAGE_WORK` (persistent session, needs-driven goals, village chores; the full table with every default is in [Player-facing properties](#player-facing-properties-bedrock)). The complete list with defaults is in [`BEDROCK.md`](BEDROCK.md#environment-variables) — see `docs/wiki/human-command.md` for the chat design.

### Survival Intelligence Layer

Before the model sees anything, a deterministic layer evaluates the observation and decides whether progression should be interrupted:

- **Survival Governor**: health/food/hostiles/day-night scoring with explicit rules (`knowledge/survival-rules.json`). It returns `{mode: normal|caution|emergency, needs, overrideObjective, allowedIntents, preferredSkills}`; `/observe` exposes a compact version and in an emergency `/options` is restricted to the allowed intents (it can only remove keys the adapter already offered, never invent one).
- **Gameplay skills**: declarative JSON contracts (`skills/gameplay/**`) with preconditions, deterministic success/failure criteria and intents — the Voyager-inspired skill library, with no runtime code generation.
- **Skill Resolver**: picks the active skill (governor in an emergency, then the plan's optional `skill` field, then the progression milestone) and boosts its intents when options are ranked for the controller.
- **Verification**: `verifySkill(skill, before, after)` checks harness state (inventory tags, hunger/health deltas, threat distance, night survived), never the model's opinion. Every run appends to `runs/<run>/skills.jsonl`.
- **Progression Engine**: `knowledge/progression.json` resolves the next missing prerequisite for a goal; with `CURRICULUM=first_night` the controller drives `wood -> crafting table -> food -> first night` on its own, while Hermes remains the fallback for ambiguous situations.

Full architecture and extension guides: [`docs/raw/SURVIVAL-INTELLIGENCE.md`](docs/raw/SURVIVAL-INTELLIGENCE.md) (reference) and [`docs/wiki/survival-intelligence.md`](docs/wiki/survival-intelligence.md) (synthesis).

### Let Hermes drive the harness itself

Install the skill into your Hermes, then hand the goal to a normal Hermes session with the terminal tool:

```bash
hermes skills install https://raw.githubusercontent.com/teknium1/hermes-and-jev-play-minecraft/main/skills/minecraft-bounded-agent/SKILL.md
RUN_ID=demo node harness.mjs   # terminal 1
hermes chat -Q --oneshot -t terminal -q "Use the minecraft-bounded-agent skill against the harness on 127.0.0.1:3077: hold >=4 dirt and reach waypoint (380,16) in at most 14 actions, then report each step."
```

In this mode Hermes is planner and controller (one session, ~10 s per action, roughly $0.20 per demo on a frontier model). It is the easiest way to watch the loop; the Jev controller is the fast, cheap way to run it.

### Troubleshooting

- `bot could not join`: the server is still generating chunks; the harness retries for ~30 s, then give it a second start.
- Controller dies with `other side closed`: an old harness build; both sides now use `Connection: close`, `git pull`.
- Jev returns `{"error": ...}`: the OpenRouter key lacks credit or the decisions endpoint is briefly down; the controller surfaces the raw error. Re-run.
- Nothing happens after `PLAN ...`: the harness is `busy` with a long pathfinding action (up to 45 s); wait.

## Player-facing properties (Bedrock)

The bot is not only a planner/controller demo: it lives in a shared village and a
human can talk to it. These are the properties it guarantees, in the order a
player meets them.

### Chat: orders, questions, small talk

- **Order channel.** With `CHAT_ALLOWLIST` set (`CHAT_CONTROL=on` is the default
then), a trusted human writes `<trigger> <order>` — `@bot prendi 4 legna` — and
the order becomes a `chat` goal planned by Hermes over the harness `/options`,
exactly like any other goal. Triggers are configurable (`CHAT_PREFIXES`, plus the
bot's own name with `CHAT_SELF_NAME=on`); the **longest** trigger wins (so
`@bot1` is not `@bot`), and several triggers let several bots share one server,
each answering to its own name. Nobody outside the allowlist can order the bot
(`chat_ignored`).
- **Questions are not orders.** `@bot dove sei?` is answered from `observe()` and
**creates no goal** (regex fast path, then the decision model over a closed intent
list — `CHAT_INTENT*`). A question the router cannot decide (no key, timeout,
below `CHAT_INTENT_MIN_P`, unparsable) is answered with the way back to the order
syntax and logged as `chat_unrouted`, never turned into an order. The
question-shape pre-filter runs first, so a message that is not question-shaped
never costs a model call before its ack.
- **One reply per message, never silence, never self-trigger.** An order gets one
ack and one outcome; a question one answer; a greeting one line. Replies are
clamped (`CHAT_REPLY_MAX_LENGTH`) and refused if they would start with the bot's
own trigger (`chat_reply_refused`), and the bot recognises its own echo
(`CHAT_ECHO_WINDOW_MS`) so it does not answer itself. Orders that are too old
(`CHAT_MAX_AGE_MS`) are dropped (`chat_stale`).
- **Greeting.** A trusted human who comes within `CHAT_GREET_RANGE` is told the
order syntax once (`CHAT_GREET*`), and it is deterministic **on purpose**: it
exists to teach `{prefix}`/`{prefixes}`, and a model could garble them.

### The reply speaks the sender's language (M7.1); the model only adds naturalness (M7)

- **Deterministic first.** Ack, outcome and answers are composed in code, and the
language is part of that code: the planner must write the objective **in the same
language as the human message and in the first person** (that text is what the ack
sends), the stop/follow/equip fallbacks come from the `CHAT_LANG` catalogue
(`chat-i18n.mjs`), and `human-questions.mjs`
owns `planPhrase` with `CHORE_LABELS`/`NEED_LABELS`, so a village chore, a
survival need, `wear_armor` or a loot recovery is described in the configured
language instead of
echoing the English knowledge-base objective. A human order keeps its own
objective, already in the sender's language. `tests/human-questions.test.mjs`
fails if a new chore or need ships without a label.
- **Then, optionally, an LLM rephrases.** With `DEEPSEEK_API_KEY` (or
`CHAT_LLM_API_KEY`, or any OpenAI-compatible endpoint via
`CHAT_LLM_URL`/`CHAT_LLM_MODEL`), `chat-llm.mjs` rewrites the composed reply so it
sounds like a player; `CHAT_PERSONA` sets the voice. The model receives the
compact facts from `observe()` plus the deterministic text as **grounding**: it
never chooses an action, never creates a goal, may not invent a fact, and its
output is a single clamped line in the sender's language.
- **Failure is always the template.** No key, `CHAT_LLM=off`, timeout, HTTP error,
empty or self-triggering answer → the deterministic text is sent. The key is not
the language switch: it is what makes the phrasing varied. Small talk (`ciao`,
`grazie`) matches an **exact** closed list, so `grazie prendi la legna` stays an
order.
- **Memory.** The last ~6 turns per sender, for up to 8 senders, in RAM only (a
restart forgets).

### One catalogue, five languages (M7.2)

- **`CHAT_LANG` is the language of everything the bot says by itself**: ack,
outcome, question answers, proactive greeting, refusals. Supported values are
`it` (default, the historical behaviour of this server), `en`, `fr`, `es`, `de`;
region codes are tolerated (`en-US` → `en`) and an unknown value is not fatal —
the bot falls back to the default and says so once at startup.
- **The catalogue is the only place a sentence is written.**
`chat-i18n.mjs` holds `MESSAGES` (one entry per key per language) and `t()`;
the code never concatenates a translated fragment. `tests/chat-i18n.test.mjs`
enforces the three properties that keep it honest: every language defines every
key, the placeholders of a key are identical across languages, and the five
versions are actually different strings.
- **A new chore or need cannot ship untranslated.** The village chores and the
survival needs come from the same catalogue (`chore.*`, `need.*`), and the test
walks `VILLAGE_CHORES` and `NEED_PRIORITY` to prove each id has a label in all
five languages.
- **The LLM follows the same rule.** A clear message always wins: the bot
answers in the language the human wrote. `CHAT_LANG` is the fallback used when
the message does not make the language clear (`ok`, `grazie`, a two-word order):
the model is told to use it.
- **What is not translated.** The human's own text, and the objective the planner
writes for an order (M7.1 requires it in the sender's language). A question
written in a language the intent patterns do not cover is still answered: the
`chat_unrouted` reply is in `CHAT_LANG` and teaches the order syntax.

### Saying what it is doing (M8)

- **The bot does not go silent when it works alone.** A goal nobody asked for —
  a village chore, or a survival need the governor decided — is announced once
  in chat: *"In autonomia: sto raccogliendo le patate"* (same sentence in all
  five languages, from the `autonomy_narration`/`narrate.*`/`item.*` keys).
- **The concrete thing, not a category.** The chore carries the crop, the log,
  the ore or the stack it saw (`plan.choreTarget`), and `chat-narration.mjs`
  turns it into words: the item name when the catalogue knows it, otherwise the
  family word (`kind.crop`, `kind.log`, `kind.ore`, …). A raw id never reaches
  the chat.
- **One line, once, and only if someone is listening.** Gate: the goal type is
  `village`/`autonomous`, `CHAT_NARRATE` is on (it defaults to `CHAT_REPLY`),
  `CHAT_NARRATE_COOLDOWN_MS` has elapsed (default 300000), and at least one
  human is within `CHAT_GREET_RANGE`. A goal started in solitude keeps its
  chance to speak later.
- **The model does not decide it.** The sentence is composed deterministically
  and handed to `saySmart` as grounding, so an LLM with a key can rephrase it
  but cannot invent a fact, pick the language or announce a goal of its own.
  With no key, the same sentence is sent verbatim.
- **Evidence in the log.** `autonomy_narration` records the goal, the chore or
  need, the humans in range and the exact message; `NARRATE [gN] …` goes to
  stdout. `tests/chat-narration.test.mjs` covers the composition in every
  language and the integration case asserts the message actually reaches
  `POST /say`.

### The bot is not furniture: idle autonomy and village labor (M3/M3b)

`SESSION=on` gives the bot an `IDLE` state; `AUTONOMY=on` fills it with
**needs-driven** goals (eat, sleep, shelter, a new tool …) and `VILLAGE_WORK=on`
(default: it follows `AUTONOMY`) fills it with **village chores**:

| Property | Guarantee |
|---|---|
| The work is offered | A chore is proposed only when `GET /options` already offers one of its intents — **the harness is the arbiter**, so an invalid intent can never become a goal |
| Success is a state delta | `isChoreResolved` compares against a snapshot captured at creation (items gained, a seed actually spent, a baby born), never an absolute count and never the model's opinion |
| It never outranks the humans | Chores are `source: autonomous`, the lowest priority: a chat order or an emergency always wins |
| It cannot loop | `VILLAGE_COOLDOWN_MS` per chore, `VILLAGE_MAX_CHORES` per session, and a goal without a verifier is never created |

Chores: harvest ripe crops, store the harvest, shear sheep, milk cows, collect
honey, breed animals, plant crops, go fishing, chop wood, gather stone, mine ore.
A chore that cannot be verified is never claimed as done — the goal closes
`failed`/`abandoned`, not `completed`.

#### The knobs, and what they actually do

| Variable | Default | Effect |
|---|---|---|
| `SESSION` | `off` | off = one-shot (one goal, then the process exits); on = the loop with the `IDLE` state |
| `IDLE_POLL_MS` | `2000` | how often `IDLE` re-reads chat, needs and chores |
| `IDLE_TIMEOUT_MS` | `0` | `0` = wait forever; `>0` = the controller exits `0` after that long with no goal produced |
| `AUTONOMY_COOLDOWN_MS` | `120000` | anti-loop per need (and, with `AUTONOMY=on`, also the urgent-needs cooldown) |
| `AUTONOMY_MAX_GOALS` | `25` | cap on autonomy goals per session (counter in memory) |
| `SURVIVAL_IDLE_COOLDOWN_MS` | `30000` | urgent-needs anti-loop when `AUTONOMY=off` — the night does not wait |
| `VILLAGE_COOLDOWN_MS` | `120000` | anti-loop per chore |
| `VILLAGE_MAX_CHORES` | `12` | cap on chores per session |
| `VILLAGE_STORE_THRESHOLD` | `8` | stack size from which storing the harvest is worth it |
| `VILLAGE_STORE_EPILOGUE` | `= VILLAGE_WORK` | after a successful village goal, queue the "put the pack away" goal |
| `VILLAGE_WORK` | `= AUTONOMY` | village chores while `IDLE` |
| `RESUME` | `= SESSION` | re-queue the goals a previous run left suspended |
| `EMERGENCY` | `= SESSION` | a world event (death) preempts the running goal |

- **`IDLE_TIMEOUT_MS` stops the controller, not the bot.** The bot lives in the
harness (`bedrock-harness.mjs`): when the controller exits, the bot stays
connected, still and deaf — no orders, no needs, no chores — until you restart
it. `RESUME=on` puts the suspended queue back.
- **Nothing in chat switches autonomy off.** "stop"/"fermati" only makes *that*
order mean "stay put" (`fallback.stop`: no follow, no targets); when the goal
ends the bot is back in `IDLE`.
- **The caps cover the invented work only, and they are per process.**
`AUTONOMY_MAX_GOALS` and `VILLAGE_MAX_CHORES` reset on restart, while governor
needs and chat orders have no cap: the bot keeps reacting after both.
- **`IDLE` costs nothing.** It only polls `GET /observe` and the chat inbox — no
planner, no decision model. The cost is per goal: one Hermes plan and one
decision per action.
- **Parsing**: an unset or empty value falls back to the default (the `||`
idiom), `0` really disables a cooldown (it is the string `"0"`), and a
non-numeric value disables it silently (`now - last < NaN` is always false).

### The work comes home (M3c)

A productive goal does not end when the last block is mined: it ends when what
was gathered is *usable*. With `VILLAGE_STORE_EPILOGUE=on` (default: it follows
`VILLAGE_WORK`) a **successful** `village`/`autonomous` goal queues one last
goal — `store_harvest` with threshold `1` — so the cycle is **produce → store →
verify**, not a collection of independent chores.

- **The harness decides what is depositable**, through `observe().deposit`
(`_depositableItems`): tools, armour, buckets, seeds, torches and portable
stations, and a food reserve (`DEPOSIT_KEEP_RESERVE = 16` per food stack) stay
in the pack. Note that wheat is *not* food for this purpose.
- **The chest is chosen, not found**: `_depositTargetFor` scores a container
that already holds that item (`+100000`) above a nearer empty one, then the
closest reachable; remembered chests survive restarts.
- **It is one bounded action, not twelve**: `dump_inventory` moves up to
`DEPOSIT_MAX_STACKS = 8` stacks, keeping the reserve, and reports what it moved.
- **It closes on the delta**: the child goal is verified by `isChoreResolved`
against the snapshot taken when it was created, so it is `completed` only if the
items really left the pack (`container_dump` in the run log).
- **The humans still win**: the epilogue is a normal `autonomous` goal, so a
chat order arriving first is served first; the epilogue never counts against
`VILLAGE_MAX_CHORES`.

### Evidence, not memory

Every plan, decision, action result, chat event, skill verification and circuit
build is appended to `runs/<run>/` (`controller.jsonl`, `events.jsonl`,
`skills.jsonl`, `circuits.jsonl`). Report from those files. Incoming orders are
logged there with their sender (which is why `runs/` is gitignored, together with
`.env`, `.private/`, `nmp-cache/` and `auth.json`): the chat trail stays on the
machine, it never goes to git.

## Results

Demo goal, fresh world: *hold ≥ 4 dirt and stand within 2 blocks of waypoint (380, 16)*.

| Run | Planner | Controller | Actions to goal | Controller latency (median) | Model cost |
|---|---|---|---|---|---|
| `jev-03` | Hermes (1 plan, 27 s) | **Jev 1.13** | **4** | **211 ms** | $0.00014 (Jev) |
| `hermes-01` | Hermes | Hermes (`-t terminal`, 1 session) | 4 | ~10 s | ≈ $0.23 |

Two things surfaced while building it, both fixed in the harness rather than the prompt, which is the whole lesson of the original project:

- Jev kept choosing `mine_dirt` after the dirt target was met → the harness now stops offering mining once `plan.targets` are satisfied.
- Jev chose `wait` five times when `goto_waypoint` was the only useful move → `wait` is now offered only when nothing else is valid. Next run: 4 actions, zero waits.

### Reproduction of the original Ender Dragon run

Full write-up: [`docs/raw/REPRODUCTION-REPORT.md`](docs/raw/REPRODUCTION-REPORT.md) (environment, per-stage timeline, verification, cost by lane for every run, what could not be reproduced and why); summary in [`docs/wiki/reproduction.md`](docs/wiki/reproduction.md). Summary: the original project was run end to end on Linux (Temurin JDK 17, vanilla 1.16.5 server, the author's seed) with a small relay that routes his exact model calls: `openai/gpt-6-astra` through the Nous Portal OAuth login Hermes already has, `typesafe/jev-1.13` through OpenRouter.

| | Original (`nether-final-08`) | Reproduction (`repro-02`, exact models) | Reproduction (`repro-01`, substitute models) |
|---|---|---|---|
| First decision → exit portal | 8:43 | **7:45** | 12:37 |
| Controller decisions / planner calls | 131 / 35 | 119 / 35 | 140 / 52 |
| Bed blasts to kill | 6 | 6 | 6 |
| Deaths | 0 | 0 | 0 |
| Controller median latency | ~0.2 s | 227 ms (Jev) | 1.8 s (Gemini 3.8 Flash emulating Jev) |
| Cost | $0.97 ($0.01 Jev, $0.96 Astra) | **$0.963** ($0.010 Jev, $0.953 Astra) | $0.572 |

Total spend across every run in the report (two dragon runs, the Hermes-native test, probes): **$1.96**.

Not reproduced: the video (the original recorder is a macOS-only native client).

## Design notes

- **Milestone-gated planning.** The planner runs at start, when targets are met, when the waypoint is reached, after two failures, or every N actions; never per step. Plans are JSON `{objective, targets, waypoint}`.
- **Harness-owned validity.** `/options` is the contract: the controller sees only executable, currently-useful moves and returns one key. Bad behaviour is fixed by changing what gets offered.
- **Cheap, fast controller.** Jev answers a `choice` question over the options with probabilities and a confidence in ~0.2 s. Swapping it for a general LLM (tested in the report) was ~8x slower and ~20x the cost for the same decisions.
- **Evidence first.** Every plan, decision and action result is appended to `runs/<id>/`; report from those files, not from memory.

## License

MIT
