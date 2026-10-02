# Hermes and Jev play Minecraft

[Hermes Agent](https://github.com/NousResearch/hermes-agent) plans. [Jev](https://typesafe.ai) (TypeSafe's System-One model) picks one bounded action at a time. A Mineflayer harness decides which actions are valid and executes them. No screenshots, no keypresses, no generated code from any model.

> **Bedrock Edition fork**: questo repository è il porting su Minecraft Bedrock Edition. Per istruzioni specifiche (Docker, NetherNet, deploy sull'host Docker) vedi [`BEDROCK.md`](BEDROCK.md).  
> Vedi anche il framework Mineflayer-like per Bedrock/NetherNet: [`giaffa86/mineflayer-for-bedrock-nethernet`](https://github.com/giaffa86/mineflayer-for-bedrock-nethernet).

The split is the one [rmalde/minecraft-agent](https://github.com/rmalde/minecraft-agent) used to beat the Ender Dragon from a fresh Survival world in 8:43 with GPT-6 Astra + Jev. That repository has no license, so **nothing here is copied from it**; this is an independent, much smaller implementation of the same architecture, built to (1) run the pattern with Hermes as the planner and (2) reproduce the original result.

## What is in here

| Path | What |
|---|---|
| `harness.mjs` | Pure-Node Minecraft 1.16.5 server ([flying-squid](https://github.com/PrismarineJS/flying-squid), no Java needed) + one Mineflayer bot + a bounded-action HTTP API: `GET /observe`, `GET /options`, `POST /act`, `POST /plan`. **Validity is decided here**, not by the model. |
| `controller.mjs` | The loop. Planner = Hermes via `hermes chat -Q --oneshot` at milestones. Controller = Jev via OpenRouter `POST /api/alpha/decisions` (a `choice` question over the harness's options), or Hermes with `CONTROLLER=hermes`. Logs every plan and decision (choice, candidate keys, per-key probabilities, confidence, cost, latency) to `runs/<id>/controller.jsonl`. Anti-loop: repeated actions with no progress (position, inventory, objective) force a replan and are temporarily excluded. |
| `controller-decisions.mjs` | Pure decision helpers for the controller: option ranking/cap, anti-loop detection, progress fingerprint, wait diagnostics, decision instructions. Unit tests in `tests/controller-decisions.test.mjs`. |
| `survival/` | Deterministic Survival Intelligence Layer: perception, risk/needs scoring, Survival Governor, declarative gameplay-skill loader, skill resolver, deterministic verification, progression resolver, JSONL experience. Pure logic with unit tests; no model, no code generation. |
| `knowledge/survival-rules.json` | When to interrupt progression (low health near a hostile, starving, night unprepared, ...). Explicit condition vocabulary, validated at load. |
| `knowledge/progression.json` | Declarative milestone graph (wood → crafting table → stone tools → food → first night → iron → diamonds → nether) with dependencies, not a hardcoded sequence. |
| `skills/gameplay/` | Declarative gameplay skills (JSON): preconditions, success/failure criteria, intents. Different concept from the Hermes Agent `SKILL.md`; they never contain executable code. |
| `docs/SURVIVAL-INTELLIGENCE.md` | Architecture, contracts and how to add a gameplay skill or a progression milestone. |
| `docs/HEADLESS-CLIENT.md` | How the bot acts in the server with no graphics: headless client, protocol-level perception and actions, bounded-action loop. |
| `skills/minecraft-bounded-agent/SKILL.md` | Hermes skill: how to drive the harness directly from a Hermes session (`hermes chat -t terminal`). |
| `docs/REPRODUCTION-REPORT.md` | Full report of reproducing the original Ender Dragon result on Linux with the exact models (GPT-6 Astra via Nous Portal, Jev via OpenRouter): **7:45**, 6 bed blasts, 0 deaths, **$0.96** — vs the author's 8:43 and $0.97. |

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

Knobs (all env vars): `GOAL` (free text for the planner), `TARGETS` (`{item: minCount}`), `WAYPOINT` (`{x, z}` or unset), `MAX_STEPS`, `REPLAN_EVERY` (default 8), `CONTROLLER=jev|hermes`, `JEV_MODEL` (default `typesafe/jev-1.13`), `MAX_OPTIONS` (cap on the options passed to the controller, default 12, 0 disables), `ANTI_LOOP_THRESHOLD`/`ANTI_LOOP_COOLDOWN` (default 3), `CURRICULUM=<milestone>` (e.g. `first_night`, `enter_nether`: the progression engine picks the next missing prerequisite itself), `MC_PORT`/`API_PORT` if 25599/3077 are taken.

### Survival Intelligence Layer

Before the model sees anything, a deterministic layer evaluates the observation and decides whether progression should be interrupted:

- **Survival Governor**: health/food/hostiles/day-night scoring with explicit rules (`knowledge/survival-rules.json`). It returns `{mode: normal|caution|emergency, needs, overrideObjective, allowedIntents, preferredSkills}`; `/observe` exposes a compact version and in an emergency `/options` is restricted to the allowed intents (it can only remove keys the adapter already offered, never invent one).
- **Gameplay skills**: declarative JSON contracts (`skills/gameplay/**`) with preconditions, deterministic success/failure criteria and intents — the Voyager-inspired skill library, with no runtime code generation.
- **Skill Resolver**: picks the active skill (governor in an emergency, then the plan's optional `skill` field, then the progression milestone) and boosts its intents when options are ranked for the controller.
- **Verification**: `verifySkill(skill, before, after)` checks harness state (inventory tags, hunger/health deltas, threat distance, night survived), never the model's opinion. Every run appends to `runs/<run>/skills.jsonl`.
- **Progression Engine**: `knowledge/progression.json` resolves the next missing prerequisite for a goal; with `CURRICULUM=first_night` the controller drives `wood -> crafting table -> food -> first night` on its own, while Hermes remains the fallback for ambiguous situations.

Full architecture and extension guides: [`docs/SURVIVAL-INTELLIGENCE.md`](docs/SURVIVAL-INTELLIGENCE.md).

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

Full write-up: [`docs/REPRODUCTION-REPORT.md`](docs/REPRODUCTION-REPORT.md) (environment, per-stage timeline, verification, cost by lane for every run, what could not be reproduced and why). Summary: the original project was run end to end on Linux (Temurin JDK 17, vanilla 1.16.5 server, the author's seed) with a small relay that routes his exact model calls: `openai/gpt-6-astra` through the Nous Portal OAuth login Hermes already has, `typesafe/jev-1.13` through OpenRouter.

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
