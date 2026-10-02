# Reproduction Report — rmalde/minecraft-agent (GPT-6 Astra + JEV Ender Dragon run)

**Date:** 2026-09-20/21 · **Host:** Linux (Hermes workstation) · **Runs:** `repro-02` (exact models, headline) and `repro-01` (substitute models)

## Verdict

✅ **Reproduced with the author's exact models.** Fresh Survival/Peaceful world on his seed, empty inventory, his harness unmodified, GPT-6 Astra planning and JEV 1.13 choosing actions → Ender Dragon killed with **6 bed explosions** → exit portal, **0 deaths, final health 20**, no restarts or operator intervention, **7 min 45 s** — 58 s faster than his published 8:43.

❌ Not reproduced: the **video**. The native recorder is a hidden macOS Minecraft client; there is no Linux equivalent in the repo, so `verify-run.mjs` fails only at its ffprobe step. Every non-video artifact it requires is present.

---

## 1. What the project is

[rmalde/minecraft-agent](https://github.com/rmalde/minecraft-agent) — JavaScript, ~10k LOC, **no LICENSE file** (ideas only; no code may be copied into hermes-agent). It beats Minecraft Java 1.16.5 from spawn to dragon kill with two models and zero screenshots or keypresses:

| Layer | Model / component | Role |
|---|---|---|
| Planner ("System Two") | `openai/gpt-6-astra`, chat completions, JSON output, low reasoning | Sets `{objective, targets, waypoint}`; called only on milestones (initial, dimension change, inventory-stage change, 2 failures, waypoint reached, 120 s periodic); runs asynchronously so actions never wait on it; a plan whose stage changed in flight is discarded |
| Controller ("System One") | `typesafe/jev-1.13` via `POST /api/alpha/decisions` (a `choice` question over `a0..aN` with criteria strings) | Picks ONE action per tick from the list the harness offers; returns choice + probabilities + confidence in ~0.2 s |
| Harness | Mineflayer + patched pathfinder + read-only Java dragon sensor (`javaagent`) | Owns action **validity** (escape actions preempt everything when a breath cloud threatens; completed waypoints stop being offered; "wait" filtered when anything useful exists); compacts observations; logs every request/response/action to `events.jsonl`; `verify-run.mjs` demands dragon-death + exit-portal evidence |

The author's stated lesson: failures were fixed by changing harness action validity/execution, not by longer prompts.

**Author's published result (`nether-final-08`):** 8:43.3, 131 JEV decisions, 35 Astra calls, 6 bed blasts, no deaths.

---

## 2. Environment

| Component | Author | This reproduction |
|---|---|---|
| OS / Java | macOS, Mojang-bundled JRE | Linux, Temurin **JDK 17.0.20.1** (tarball, no root) |
| Server | vanilla `server.jar` 1.16.5 | vanilla 1.16.5 from Mojang piston-meta; `online-mode=false`, port 25576 |
| World | seed `8398967436125155523`, Survival, Peaceful | **identical**; fresh `level-name` per run (`repro-01`, `repro-02`) as he prescribes |
| Dragon sensor | `observer/dragon-observer.jar` on :3093 | built from his source with javassist 3.30.2 — worked unmodified |
| Node deps | `package-lock.json` | `npm ci` from his lockfile: mineflayer 4.39.0, pathfinder 2.4.5, his `patch-pathfinder.mjs` applied |
| Agent | `nether-agent.mjs` | **unmodified** |
| Model access | `model-relay.mjs` → Google Secret Manager → OpenRouter | `hermes_relay.py`: same `{path, body}` → `{data, latencyMs}` contract; **planner → Nous Portal (Hermes OAuth) via `agent.auxiliary_client.call_llm`**, **controller → OpenRouter `/api/alpha/decisions`** with the OpenRouter key from the Hermes `.env` (memory only, never logged) |
| Recording | hidden native Minecraft client (macOS) | none |

Seed/worldgen match confirmed by the route data working as-is: spawn village, the three supply chests (iron pickaxe, 21 obsidian, flint, iron), the ruined entry portal and the naturally active End portal at `(-1130, 34, 856)`.

### Why the planner rides Nous Portal, not OpenRouter

OpenRouter returns HTTP 403 for every OpenAI model on this account (*"this user has been blocked for a previous policy violation"* — an OpenAI-side block). The Nous Portal inference API serves `openai/gpt-6-astra` under the existing Hermes OAuth login, so the planner lane goes there. Same model id, same prompt, same `response_format`, same `reasoning: low`.

### A note on my first attempt

My first pass concluded both of his models were unreachable and ran `repro-01` with substitutes (Claude Sonnet 5 planner, Gemini 3.8 Flash emulating the JEV contract). That was wrong: I had not tried the Nous Portal route for Astra, and my two JEV probes both hit timeouts that turned out to be transient — a later probe answered in ~400 ms. `repro-02` corrects this; `repro-01` is kept below as a useful controller-latency comparison.

---

## 3. Results

| Metric | Author `nether-final-08` | **`repro-02` (exact models)** | `repro-01` (substitutes) |
|---|---|---|---|
| First decision → exit portal | 8:43 | **7:45** | 12:37 |
| Controller decisions | 131 | **119** | 140 |
| Planner calls | 35 | **35** | 52 |
| Bed blasts to kill | 6 | **6** | 6 |
| Dragon health per blast | — | 200→166, 172→130, 136→94, 100→61, 67→25, 31→**0** | 200→159 … 39→0 |
| Deaths / restarts / operator repair | 0 / 0 / 0 | **0 / 0 / 0** | 0 / 0 / 0 |
| Final health | full | **20** | 20 |
| Nether entered / exited | — | **2:56 / 4:47** | 4:03 / 6:57 |
| Controller median latency | ~0.2 s (JEV) | **227 ms** (`typesafe/jev-1.13-20260917`) | 1.80 s (Gemini 3.8 Flash) |
| Planner median latency | — | 4.9 s (`openai/gpt-6-astra`, async) | 3.6 s (Claude Sonnet 5) |
| Model errors | — | **0** of 155 calls | 0 of 198 calls |
| Cost (see §3b) | $0.97 | **$0.963** ($0.953 Astra + $0.010 JEV) | $0.572 |

### `repro-02` timeline (t = 0 at first decision, 00:53:50 UTC)

| t | Stage | What happened |
|---|---|---|
| 0:00 | `prepare` | Loot blacksmith chest → iron pickaxe + obsidian; collect 8 village beds along `preparationBeds`; loot two more chests → 12 obsidian, flint, iron; craft flint & steel; mine navigation blocks |
| 2:39 | `entry` | Repair ruined portal frame with obsidian, ignite, step through |
| 2:56 | `nether` | **Nether entered**; walk/dig/bridge along surveyed route to exit site; build & ignite exit portal |
| 4:47 | `stronghold` | **Nether exited** beside the active End portal; short checked descent into the portal |
| 5:05 | `combat` | Wait outside fountain, escape breath, retreat from strafes, approach on perch; six `one_timed_bed` attacks from cover |
| 7:35 | `exit` | Dragon dead (sensor: health 0.0, phase 9) |
| **7:45** | `complete` | `game_state_change reason=4` → `victory.json` (`won: true, dragonKilled: true`) |

JEV action mix (119 decisions): wait 18, exit-route travel 17, entry-portal work 15, bed collection 13, Nether travel 10, take/loot 8, one_timed_bed 8, navigation blocks 6, bridge 5, chest 4. Astra produced 31 distinct objectives that track the author's stage order exactly; no `plan_error`, no discarded stale plans.

### Where the 4-minute gap in `repro-01` came from

Same route and stage structure; the difference is controller latency: 140 decisions × (1.8 s − 0.23 s) ≈ 3.7 min, plus slower planner turnaround. Combat still took 6 blasts with no deaths in both runs — the harness owns the bed-timing window, so decision latency did not affect the kill.

---

## 3b. Cost

The author reported **< $1 per run ($0.01 JEV, $0.96 Astra)**. Our exact-model run matches almost to the cent.

| Run | Lane | Model | Calls | Tokens in / out | Cost (USD) | Source |
|---|---|---|---|---|---|---|
| **`repro-02`** (exact) | Planner | `openai/gpt-6-astra` via Nous Portal | 34 | 52.8k / 5.9k | **$0.953** | Nous Portal `usage.cost` per response |
| | Controller | `typesafe/jev-1.13` via OpenRouter | 119 | 236.6k / 3.5k | **$0.010** | OpenRouter `usage.cost` |
| | | | | **run total** | **$0.963** | (author: $0.97) |
| `repro-01` (substitutes) | Planner | `anthropic/claude-sonnet-5` via OpenRouter | 54 | 123.2k / 11.4k | $0.361 | OpenRouter `usage.cost` |
| | Controller | `google/gemini-3.8-flash` emulating JEV | 144 | 242.0k / 8.0k | $0.212 | OpenRouter `usage.cost` |
| | | | | run total | $0.572 | |
| `hermes-01` (Hermes-native harness test) | Hermes agent | `anthropic/claude-fable-5.1` via Nous Portal | 1 session | 70k cache-read + 12.7k cache-write / 1.1k | $0.234 | Hermes `sessions.estimated_cost_usd` (estimated, provider models API) |
| Setup probes | Astra smoke via `hermes chat` + relay smoke | Nous Portal | 3 | 15.1k / <100 | $0.191 | Hermes estimate ($0.190) + relay ($0.0014); the 403 OpenRouter Astra probes and the JEV probes were free |
| | | | | **grand total, all three runs + probes** | **$1.96** | |

Notes: `repro-01`/`repro-02` figures are provider-reported per call and summed from `relay-repro-01.log` / `relay.log`; the `repro-02` planner cost is identical in shape to the author's ($0.953 vs $0.96) because the prompt/plan pattern is his, unchanged. JEV is 1% of the exact run's cost, as in his run. The JEV emulation with Gemini in `repro-01` cost 21× real JEV ($0.212 vs $0.010) and was 8× slower.

---

## 4. Verification

`verify-run.mjs` requires (a) dragon-death evidence, (b) the exit-portal event, (c) the video. (a) and (b) hold for both runs; (c) fails on the missing `full-playthrough.mp4`.

- `victory.json`: `won: true, dragonKilled: true`, health 20
- Dragon sensor at kill: `health: 0.0, phase: 9` — read-only server hitbox, no game state modified
- `events.jsonl`: `nether_entered`, `nether_exited`, `game_won {reason: 4}`; 0 `death`, 0 `kicked`, 0 `error`
- Source hashes frozen per run by his `freeze-run.mjs` (`runs/<run>/source/`, `run-config.json` — includes a `substitutions` block stating exactly what differs from his setup)

Evidence kept under `~/.hermes/cache/scratch/mc-agent/`:
- `runs/repro-02/{events.jsonl, victory.json, status.json, run-config.json, agent.out, source/}` and the same for `runs/repro-01/`
- `relay.log` (repro-02: every model call — route, model, latency, JEV choice + confidence, cost) and `relay-repro-01.log`
- Worlds: `server/repro-02/`, `server/repro-01/`

---

## 5. Hermes-native harness test (earlier in the session)

Before the reproduction, the same planner/controller split was exercised **inside Hermes**: a pure-Node `flying-squid` 1.16.5 server + Mineflayer + a bounded-action HTTP harness (`/observe`, `/options`, `/act`, `/plan`), driven by `hermes chat -Q --oneshot -t terminal`. Hermes posted a plan and completed "hold ≥4 dirt and reach waypoint (380,16)" in **4 of 14 allowed actions**, only ever choosing keys the harness offered. Evidence: `~/.hermes/cache/scratch/mc-hermes/runs/hermes-01/events.jsonl`, session `20260920_145629_8a05f7`.

---

## 6. How this maps onto Hermes

- **Planner = Hermes** (normal turn or `complete_structured` aux call) — milestone-triggered, async, cache-safe (state rides the user message; system prompt stays byte-stable).
- **Controller = JEV** — reachable today on OpenRouter (`/api/alpha/decisions`) and via the catalog plugin `jev-typesafe` (`jev_route` is this exact `choice` call). Related in-tree work: #113837, #113008, #114377.
- **Harness = optional skill** (`optional-skills/gaming/minecraft-bounded-agent`): bounded-action HTTP API + `events.jsonl` + verify step. No core tool required.
- General ideas worth borrowing: milestone-gated async planning with stage-changed discard; harness-owned action validity (the model chooses from a filtered list, never invents); a verifier that refuses success without independent evidence.

---

## 7. Remaining gap and how to close it

Only the recording. Options: (a) run his native client on a Mac; (b) a Linux path via Prismarine Viewer headless capture (his older `recorded-06` pipeline, `assemble-video.mjs`), which he explicitly downgraded in favour of the native client. Everything else is reproduced.
