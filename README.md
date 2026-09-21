# Hermes and Jev play Minecraft

[Hermes Agent](https://github.com/NousResearch/hermes-agent) plans. [Jev](https://typesafe.ai) (TypeSafe's System-One model) picks one bounded action at a time. A Mineflayer harness decides which actions are valid and executes them. No screenshots, no keypresses, no generated code from any model.

The split is the one [rmalde/minecraft-agent](https://github.com/rmalde/minecraft-agent) used to beat the Ender Dragon from a fresh Survival world in 8:43 with GPT-6 Astra + Jev. That repository has no license, so **nothing here is copied from it**; this is an independent, much smaller implementation of the same architecture, built to (1) run the pattern with Hermes as the planner and (2) reproduce the original result.

## What is in here

| Path | What |
|---|---|
| `harness.mjs` | Pure-Node Minecraft 1.16.5 server ([flying-squid](https://github.com/PrismarineJS/flying-squid), no Java needed) + one Mineflayer bot + a bounded-action HTTP API: `GET /observe`, `GET /options`, `POST /act`, `POST /plan`. **Validity is decided here**, not by the model. |
| `controller.mjs` | The loop. Planner = Hermes via `hermes chat -Q --oneshot` at milestones. Controller = Jev via OpenRouter `POST /api/alpha/decisions` (a `choice` question over the harness's options), or Hermes with `CONTROLLER=hermes`. Logs every plan and decision (choice, probabilities, confidence, cost, latency) to `runs/<id>/controller.jsonl`. |
| `skills/minecraft-bounded-agent/SKILL.md` | Hermes skill: how to drive the harness directly from a Hermes session (`hermes chat -t terminal`). |
| `docs/REPRODUCTION-REPORT.md` | Full report of reproducing the original Ender Dragon result on Linux with the exact models (GPT-6 Astra via Nous Portal, Jev via OpenRouter): **7:45**, 6 bed blasts, 0 deaths, **$0.96** — vs the author's 8:43 and $0.97. |

## Quick start

```bash
npm install
# terminal 1 — server + bot + API (about 25 s to boot, no Java)
RUN_ID=demo node harness.mjs
# terminal 2 — Hermes plans, Jev acts
export OPENROUTER_API_KEY=...          # Jev is served through OpenRouter
RUN_ID=demo WAYPOINT='{"x":380,"z":16}' TARGETS='{"dirt":4}' MAX_STEPS=14 node controller.mjs
```

`hermes` must be on `PATH` and logged in to any provider (Nous Portal, OpenRouter, Anthropic, ...). No other model key is needed; Jev decisions cost about $0.00004 each.

Or let Hermes drive the harness itself, with the skill installed:

```bash
hermes chat -Q --oneshot -t terminal -q "Using the minecraft-bounded-agent skill and the harness on 127.0.0.1:3077: hold >=4 dirt and reach waypoint (380,16) in at most 14 actions."
```

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

`docs/REPRODUCTION-REPORT.md` covers running the original project end to end on Linux (Temurin JDK 17, vanilla 1.16.5 server, the author's seed) with a small relay that routes his exact model calls: `openai/gpt-6-astra` through the Nous Portal OAuth login Hermes already has, `typesafe/jev-1.13` through OpenRouter.

| | Original (`nether-final-08`) | Reproduction (`repro-02`) |
|---|---|---|
| First decision → exit portal | 8:43 | **7:45** |
| Jev decisions / Astra calls | 131 / 35 | 119 / 35 |
| Bed blasts | 6 | 6 |
| Deaths | 0 | 0 |
| Cost | $0.97 ($0.01 Jev, $0.96 Astra) | **$0.963** ($0.010 Jev, $0.953 Astra) |

Not reproduced: the video (the original recorder is a macOS-only native client).

## Design notes

- **Milestone-gated planning.** The planner runs at start, when targets are met, when the waypoint is reached, after two failures, or every N actions; never per step. Plans are JSON `{objective, targets, waypoint}`.
- **Harness-owned validity.** `/options` is the contract: the controller sees only executable, currently-useful moves and returns one key. Bad behaviour is fixed by changing what gets offered.
- **Cheap, fast controller.** Jev answers a `choice` question over the options with probabilities and a confidence in ~0.2 s. Swapping it for a general LLM (tested in the report) was ~8x slower and ~20x the cost for the same decisions.
- **Evidence first.** Every plan, decision and action result is appended to `runs/<id>/`; report from those files, not from memory.

## License

MIT
