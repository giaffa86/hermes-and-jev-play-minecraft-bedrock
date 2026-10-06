> **Bedrock note (WIP)** — This repository is a fork of `teknium1/hermes-and-jev-play-minecraft` to port the agent to Minecraft Bedrock. The full goal, the server details and the launch checklist live in the private local runbook `.private/GOAL.md` (excluded from git). Continue the work only after reading that file.

# Agent notes

Compact guidance for working in this repo.

## Privacy rules — never push personal data to GitHub

This repository is **public**. Before any `git push`:

- Never commit or push personal data: real gamertags or account emails, Microsoft/Xbox credentials or token caches (`nmp-cache/`, `auth.json`), API keys (`.env*`), SSH key paths or key files, xuid/account IDs, allowlists, chat logs.
- Use placeholders in examples and docs (`<gamertag_or_email>`, `<ssh-key>`, `<api-key>`), never real values.
- `.env`, `.private/`, `runs/`, `nmp-cache/`, `auth.json` are gitignored — never `git add -f` them.
- Audit before pushing: `git log -p origin/main..HEAD` plus a `git grep` for the patterns above. If a value already sits in unpushed commits, rewrite the history (scrub it) instead of pushing it or adding a "remove secret" commit.
- If unsure whether something is personal, ask the user before pushing.

## What this is

A minimal reproduction of the rmalde/minecraft-agent planner/controller split: **Hermes** plans milestones, **Jev** (or Hermes) picks one bounded action at a time, and a **Mineflayer + flying-squid harness** executes it. No screenshots, no keypresses, no generated code.

## Project shape

- ESM Node project; no build, no CI, no formatter config.
- `package.json` has convenience scripts: `npm run harness`, `npm run bedrock-harness`, `npm run play`, `npm run test`.
- `test-ping.mjs` is standalone and unrelated to the main Java loop — it pings a Bedrock server (`<ip-server-bedrock>:19132`, `nethernet` transport).
- `survival/` is the deterministic Survival Intelligence Layer (governor, skill resolver, verifier, progression); `knowledge/*.json` holds rules and the milestone graph; `skills/gameplay/**` holds declarative gameplay skills (distinct from the Hermes `SKILL.md`) — including `skills/gameplay/redstone/` for the circuit milestones; `circuits/*.json` holds declarative redstone circuit blueprints built by `build_circuit_<id>` (validated by `circuits.mjs`, results in `runs/<run>/circuits.jsonl`). See `docs/raw/SURVIVAL-INTELLIGENCE.md` and `docs/wiki/redstone.md`.
- `docs/` is an **LLM wiki** (English). Read `docs/index.md` first, then the relevant `docs/wiki/*` pages; raw sources live in `docs/raw/` and `BEDROCK.md` at the root. Conventions and workflows in `docs/llm-wiki.md`. Keep all docs in English.
- Tests: `node --test tests/*.test.mjs` (no server required).
- Wiki lint: `npm run wiki:lint` (strict: `npm run wiki:lint:strict`). The git
  hooks are versioned in `tools/hooks/` and activated with
  `git config core.hooksPath tools/hooks`: `pre-commit` blocks on lint errors,
  `pre-push` blocks on warnings too (including the public-repo privacy scan).

## Entry points

| File | Role | Run it |
|---|---|---|
| `harness.mjs` | Pure-Node Minecraft 1.16.5 server + one Mineflayer bot + bounded-action HTTP API | `RUN_ID=demo node harness.mjs` |
| `bedrock-harness.mjs` | Bedrock bot + bounded-action HTTP API (the real target) | `RUN_ID=demo node bedrock-harness.mjs` |
| `controller.mjs` | Planner/controller loop calling the harness | `OPENROUTER_API_KEY=... RUN_ID=demo node controller.mjs` |
| `skills/minecraft-bounded-agent/SKILL.md` | Hermes skill for driving the harness directly | `hermes skills install https://raw.githubusercontent.com/teknium1/hermes-and-jev-play-minecraft-bedrock/main/skills/minecraft-bounded-agent/SKILL.md` |

## Run the demo

Two terminals required:

```bash
# Terminal 1 — boot the server. First run generates the world, ~25 s.
RUN_ID=demo node harness.mjs
# Wait for: "harness api on 3077"

# Terminal 2 — Hermes plans, Jev acts
export OPENROUTER_API_KEY=sk-or-...
RUN_ID=demo WAYPOINT='{"x":380,"z":16}' TARGETS='{"dirt":4}' MAX_STEPS=14 node controller.mjs
```

Result: `GOAL MET after N actions`. Logs land in `runs/demo/controller.jsonl` and `runs/demo/events.jsonl`.

Use `CONTROLLER=hermes` if you lack an OpenRouter key; it is slower and costlier.

## Important env vars

- `RUN_ID` — output directory under `runs/` (default `run`).
- `HARNESS` — harness URL (default `http://127.0.0.1:3077`).
- `WAYPOINT` — JSON `{"x":N,"z":N}`; omit for no waypoint.
- `TARGETS` — JSON `{"dirt":4}` (default `{dirt:4}`).
- `MAX_STEPS` — action budget (default `20`).
- `REPLAN_EVERY` — replan every N actions (default `8`).
- `CONTROLLER` — `jev` (default) or `hermes`.
- `JEV_MODEL` — default `typesafe/jev-1.13`.
- `HERMES_TIMEOUT_MS` — planner timeout before falling back to a static plan (default `180000`).
- `MAX_OPTIONS` — cap on the options passed to Jev (default `12`, `0` disables).
- `ANTI_LOOP_THRESHOLD` / `ANTI_LOOP_COOLDOWN` — stagnant-action replan threshold and cooldown (default `3` / `3`).
- `HARNESS_BUSY_MAX_WAIT_MS` / `HARNESS_BUSY_POLL_MS` — how long the controller waits for the harness lock (a `busy` answer) and how often it retries the same action (default `90000` / `2000`); `busy` never consumes a step.
- `HARNESS_ACTION_TIMEOUT_MS` — ceiling on a single harness action (default `180000`): on expiry the action resolves `{ok:false, error:'action_timeout'}` and the `busy` lock is released even if the body is still pending (a death mid-action used to wedge the whole API).
- `MC_PORT` / `API_PORT` — defaults `25599` / `3077`.
- `OPENROUTER_API_KEY` — required for `CONTROLLER=jev`.
- `CURRICULUM` — optional milestone (`first_night`, `enter_nether`, `redstone_automation`, `bucket`, `water_travel`, `nether_cross_lava`): the progression engine picks missing prerequisites itself; Hermes is only a fallback.
- `PROGRESSION_GOAL` — optional harness-side goal for the diagnostic `GET /survival` route.
- `CHAT_ALLOWLIST` — comma-separated gamertags/xuids allowed to order the bot via in-game chat (enables the `@bot` command channel; see `docs/wiki/human-command.md`).
- `CHAT_PREFIXES` — triggers accepted for an order, comma or space separated (e.g. `@bot,@hermes`; default `@bot`). The longest match wins, so `@bot1` is not `@bot`; several triggers let one bot answer to both a generic word and its own name, and are the prerequisite for running several bots on the same server (each needs its own distinct triggers).
- `CHAT_PREFIX` — legacy single trigger (default `@bot`); summed into `CHAT_PREFIXES`.
- `CHAT_SELF_NAME` — `on`/`off` (default `on`): the bot also answers to **its own name** — `@<BEDROCK_USERNAME>` and the gamertag the server attributes to it (learned from the chat echo, exposed as `observe().self.name`). `on` by default because it is the most natural way to address a bot, and because several bots on one server can then each be called by name without sharing a trigger; `off` keeps only `CHAT_PREFIXES`.
- `CHAT_CONTROL` — `on`/`off` (default `on` when `CHAT_ALLOWLIST` is set).
- `CHAT_GREET` / `CHAT_GREET_RANGE` / `CHAT_GREET_COOLDOWN_MS` / `CHAT_GREET_TEMPLATE` — proactive greeting: a nearby trusted human is told the order syntax via `POST /say` (default on when the channel is open, range `24`, cooldown `600000` ms); the template lists every configured trigger (`{prefixes}`).
- `CHAT_REPLY` — `on`/`off` for the order lifecycle replies (ack + outcome, default on when the channel is open; `CHAT_REPLY_MAX_LENGTH` default `180`).
- `CHAT_MAX_AGE_MS` — an order older than this (default `300000`) is dropped as stale (`chat_stale`) so a restarted controller does not replay the harness inbox.
- `CHAT_INTENT` — `on`/`off` for the chat **question** path (default `on` when `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY` is set): a message that asks about the bot's own state is answered from `observe()` and creates no goal. `CHAT_INTENT_URL` points at an alternative decisions endpoint, `CHAT_INTENT_MODEL` picks the routing model (default `JEV_MODEL`), `CHAT_INTENT_TIMEOUT_MS` (default `4000`) bounds the wait and `CHAT_INTENT_MIN_P` (default `0.4`, `0` = argmax) is the probability floor below which the message is **refused**. The regex fast path needs no key and always runs first. **M6.1**: `looksLikeQuestion` (explicit `?`/`¿` or an interrogative first word, evaluated on the raw text) is a **pre-filter** — a message that is not question-shaped never costs a model call before its ack — and a question-shaped message the router cannot decide (no key, `off`, timeout, error, unparsable, below the floor) is answered with `renderUnrouted` ("non ho capito la domanda. Se era un ordine, scrivi \"@bot <ordine>\"."), logged as `chat_unrouted` with `reason`/`probability`/`model`/`ms`/`cost`, and **creates no goal**. `q_none` from a working model still means "it was an order".
- `CHAT_ECHO_WINDOW_MS` — window (default `15000`) used to recognise the bot's own chat coming back from the server (`chat_echo`); the server rewrites `source_name` with the real gamertag, which differs from `BEDROCK_USERNAME`.
- `SHIELD_THREAT_RANGE` — distance (default `8`) within which a hostile makes `raise_shield` worth offering; the shield lives in the offhand (`equip_shield`) and the use flag is `start_using_item` in `player_auth_input`.
- `STRUCTURE_RESCAN_MS` / `STRUCTURE_RADIUS` / `STRUCTURE_SURVEY_LIMIT` — structure survey throttle (default `60000` ms), radius (default `48`) and cell budget (default `20000`) of the M5/M6 detector exposed by `GET /observe.structures` (see `docs/wiki/exploration.md`).
- `OBSERVATION_DEDUPE_MS` — write-side dedupe window of the observation log (default `300000` ms): re-reading the same fact inside the window keeps the observation already stored instead of appending a row; a *different* value is always a new fact; `0` disables the filter and makes the log append-only (see `docs/wiki/memory.md`).
- `FLUID_RESCAN_MS` / `FLUID_SCAN_RADIUS` / `FLUID_SCAN_LIMIT` / `LAVA_AVOID_RANGE` — fluid census throttle (default `5000` ms), scan radius in blocks (default `24`), cell budget (default `256`) and the lava distance under which `avoid_lava` is offered (default `8`); `WADE_SPEED_FACTOR` scales the local walk speed while wading in shallow water (default `0.5`). The state is exposed by `GET /observe.fluids` (see `docs/wiki/fluids.md`).
- `DIVE_WORK_SECONDS` / `CONDUIT_RESCAN_MS` — work budget (default `3` s) the dive decision in `bedrock-dive.mjs` has to fit, together with the descent/ascent cost, into the remaining air before `_mineBlock`/`_collectDrop` are allowed under water; conduit lookup throttle (default `60000` ms). `GET /observe.dive` reports `{depth, workSeconds, waterBreathing, plan, last}` (see `docs/wiki/fluids.md` §M2).
- `REDSTONE_RESCAN_MS` — redstone census throttle (default `5000` ms); the radius and cell budget are the constants `REDSTONE_SCAN_RADIUS` (16) / `REDSTONE_SCAN_LIMIT` (24) in `bedrock-redstone.mjs`, and `REDSTONE_TRACE_LIMIT` (default `32`) bounds the observed-change trace used to *measure* a circuit's delay. `REDSTONE_TOGGLE_MIN_INTERVAL_MS` (default `500`) is the minimum interval between two toggles of the *same* input (R6: a hand-made clock is lag); the circuit builder is exempt. The state is exposed by `GET /observe.redstone` and `observe().redstone`, the safety numbers by `GET /observe.circuits.limits` (see `docs/wiki/redstone.md`).
- `NETHER_RESCAN_MS` / `NETHER_SCAN_RADIUS` / `NETHER_SCAN_LIMIT` — Nether/End awareness census throttle (default `10000` ms), scan radius (default `32` blocks) and block budget (default `64`) for portals, fire, magma and spawners; the projectile horizon and the enderman gaze tolerance are the constants `PROJECTILE_HORIZON_MS` (4000) / `PROJECTILE_RADIUS` (1.5) / `ENDERMAN_GAZE_RANGE` (16) / `ENDERMAN_GAZE_TOLERANCE_DEG` (8) in `bedrock-nether.mjs`.
- `PORTAL_APPROACH_RANGE` / `PORTAL_ENTER_TIMEOUT_MS` / `PORTAL_FRAME_RADIUS` — N1 portal actions: how close `goto_portal`/`enter_portal` stop (default `2.5` blocks), how long `enter_portal` waits for the server's dimension change (default `15000` ms) and the radius `light_portal` searches for a standing obsidian frame (default `6`). The state is exposed by `GET /observe.portals` and `observe().nether` (see `docs/wiki/nether.md`).
- `BARTER_WAIT_MS` — how long a barter waits for the piglin's drop (default `15000`); `barter_piglin` refuses a brute, a baby or a missing ingot before sending anything (see `docs/wiki/nether.md`).

## Architecture gotchas

- **Harness owns validity.** The controller chooses only keys returned by `GET /options`. If the controller misbehaves, fix `options()` in `harness.mjs`, not the prompt.
- **Deterministic survival policy lives in `knowledge/survival-rules.json`**, not in prompts. `/observe.survival` exposes the compact governor verdict; in `emergency` the harness restricts `/options` to the governor's `allowedIntents` (removing keys only, never adding, never emptying the set).
- **Gameplay skills are data, not code** (`skills/gameplay/**/*.json`): preconditions + success criteria + intents. The verifier checks harness state (`verifySkill`), never the model's opinion; results go to `runs/<run>/skills.jsonl`. A milestone whose success is a *build* has no `satisfiedWhen` shortcut: `redstone_automation` closes only through the `circuitBuilt` criterion, which reads the builder's own report and rejects a circuit that was already standing when the skill started. **Redstone circuits follow the same rule** (`circuits/*.json`): the blueprint declares steps, trigger, success checks and how its delay must be measured, `build_circuit_<id>` refuses what it cannot verify (never an empty success), a failed step rolls the site back and `teardown_circuit` removes only the cells the bot placed itself; every attempt is appended to `runs/<run>/circuits.jsonl`.
- `mine_*` options disappear once `plan.targets` are satisfied.
- `wait` is offered only when nothing else is valid.
- `collect_drop` is preferred by the controller logic whenever drops exist; drops expire.
- The harness uses `Connection: close` on HTTP responses because long pathfinding actions can outlive keep-alive sockets.
- **Every `/act` attempt is written to `runs/<run>/actions.jsonl`** (`run-ledger.mjs`): one append-only line per attempt with `ms`, `ok`, `error`, so a hand-driven run leaves the same measurable trail as a controller-driven one. `GET /stats` returns the aggregate, `shutdown()` writes `summary.json`, and `node tools/run-facts.mjs <run>` prints them for any run; `busy` refusals are counted separately and never as action time. The controller flushes a `run_end` (with `totalCost`) on SIGTERM too, so a killed run still reports its cost.
- Pathfinding actions can take up to 45 s; the controller may appear idle while the harness is `busy`.
- The bot join retries for ~30 s; if it fails, the world is likely still generating — just restart `harness.mjs`.

## External prerequisites

- Node.js 18+ (tested on 26).
- Hermes Agent installed and working: `hermes chat -Q --oneshot -q hi` must answer.
- OpenRouter key for the default Jev controller.
- No Java is required; the Minecraft server is pure Node (`flying-squid`).

## Operational safety rules (learned in the field)

- **Never `git add -A` in a worktree without reading `git status` first**: working symlinks (e.g. `node_modules`) must never be committed. `.gitignore` uses `node_modules` without a slash precisely to also cover symlinks. If dependencies are needed in a worktree, use a symlink outside the repo or `NODE_PATH`.
- **Never merge or deploy to `main` while another session has uncommitted changes** or a controller is running: check `git status` and the processes first (`docker exec hermes ps aux | grep controller`).
- **Never restart or rebuild the production container while a run is active**.
- **In the base world**: never dig/break chests, tables, stations or built blocks (`DIG_PROTECTED` applies to `dig_down` and `dig_up`); prefer collecting/shearing over killing animals; never touch villagers.
- **Before claiming a file is saved or a fix is done, verify it** (`ls`, `node --test`, `/observe`): no results announced without a check.
- **Before quoting a number about a run** (duration, action count, cost), read it from a file in the same turn: `node tools/run-facts.mjs <run>`, `GET /stats` on a live harness, or `runs/<run>/{actions.jsonl,summary.json,controller.jsonl}`. A duration recalled from the conversation is not evidence — on 06/10/2026 an agent answered *"7 minutes and 17 seconds of active work"* for the diamond run and no artifact contained that figure (the run had been driven by hand over `/act`, which used to leave no ledger at all).
- **Privacy audit before every push** (`git log -p origin/main..HEAD` + grep for gamertag/xuid/keys/cache).
