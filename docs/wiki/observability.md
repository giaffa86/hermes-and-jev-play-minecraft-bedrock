# Observability: what a run can prove about itself

Topic: how a run reports **how long it took, how many actions it spent and what
it cost** without asking anybody's memory. Every number a human is told about a
run (`"circa 7 minuti"`, `"25 azioni"`, a cost in dollars) must come from a file
read in the same turn, or from `GET /stats` on the live harness.

Sources: `run-ledger.mjs`, `plan-trace.mjs`, `run-paths.mjs`, `bedrock-harness.mjs`,
`controller.mjs`, `tools/run-facts.mjs`, `tests/run-ledger.test.mjs`,
`tests/plan-trace.test.mjs`, `tests/run-paths.test.mjs`.

## Why this exists

On 06/10/2026 the first diamond was mined on the live BDS. The run had been driven
**by hand over the HTTP API** by an agent session (one `POST /act` per step) instead
of by `controller.mjs`, so it produced no `controller.jsonl` and — before this
page — no measured metrics at all. When the owner asked how long it took, the
agent answered *"circa 7 minuti e 17 secondi di lavoro attivo"* **without calling a
tool**: nothing in the run directory contained that number, and nothing could
contradict it either. The same turn claimed the bot would "accompany" the owner to
the vein — another sentence with no artifact behind it.

The lesson is not "the model lied": the run genuinely left no trail to read. A
ledger inside the harness fixes that at the source, because the harness is the only
component every driver must pass through.

## What the harness writes

| Artifact | Written by | Content |
|---|---|---|
| `runs/<run>/actions.jsonl` | `run-ledger.mjs`, one append-only line per `POST /act` | `{t, key, ok, ms, error}` — survives a kill mid-run |
| `runs/<run>/summary.json` | `shutdown()` in `bedrock-harness.mjs` | the aggregate: attempts, executed, ok/failed, refusals, action seconds, wall clock, per-key counts |
| `GET /stats` | the running harness | the same aggregate, plus `pid`/`uptimeMs` |
| `runs/<run>/controller.jsonl` | `controller.mjs` | per-step `decision`/`result`, and a `run_end` carrying `totalCost` — now also on SIGTERM/SIGINT, so a run killed by the deploy timeout still reports its cost |
| `runs/<run>/plan-trace.jsonl` | `controller.mjs` via `plan-trace.mjs` (R3) | one line per **plan segment**: its `source`, `objective`/`subgoal`/`steps`, the action keys chosen under it, the typed refusals it saw and the named closure (`endedBy`) |
| `node tools/run-facts.mjs <run>` | CLI | reads all of the above and prints the facts, including the plan-trace summary, or says plainly that nothing is verifiable |

The last of the ledger files answers the question the others leave open: *why did the
plan change?* The actions say what was attempted and the controller log says what was
logged, but the reason a plan was abandoned (`human_order`, `replan:anti_loop:…`,
`goal_met`, `signal:SIGTERM`) used to be scattered across `log()` calls with no single
place to read it. See [reasoning-roadmap](reasoning-roadmap.md) for the R3 shape and
`plan-trace.mjs` for the writer.

## What is counted, and what is not

- **A refused call is not work.** `busy` is the adapter's lock (`"busy"` reaches the
  controller whenever an action is still in flight), so the ledger counts it under
  `refusals` and never in `actionSeconds`; the same holds for `not_connected`,
  `dead` and `sleeping`. Counting them would inflate a run that only waited.
- **`actionSeconds` is the sum of the action durations**, not the wall clock: a
  driver that thinks for 30 s between two actions is not doing Minecraft work in
  that gap. Both numbers are reported, and the run's wall clock is the span from
  the first to the last attempt.
- **The model's tokens and dollars are not visible here.** Jev's `totalCost` is only
  recorded when the decisions endpoint returns a cost per decision (the
  06/10 diamond controller run has no `cost` field, so its `totalCost` stayed 0);
  an agent session driving the API by hand spends tokens outside the harness
  entirely, and those must be read from that agent's own session log.

## Where the files land: `RUNS_DIR`

The harness writes under `runs/<RUN_ID>` **relative to its own working
directory**, and in the deployed setup that directory is inside the harness
container (`hermes-jev-bedrock`, `/app/runs`) — a place nobody on the host can
read. `run-paths.mjs` resolves the path instead: `RUNS_DIR` (default `runs`) is
the root, `RUN_ID` the subdirectory (`runDir()`), and every entry point uses it
(`bedrock-harness.mjs`, `controller.mjs`, `harness.mjs`, the `explore-*.mjs`
drivers). Every one of them has to import it (`import { runDir } from
'./run-paths.mjs'`): the three exploration drivers were the only files that used
`runDir` without the import and no test loaded them, so
`tests/run-paths.test.mjs` now reads the six entry points as text and fails if a
call site has no matching import.

Mount a host directory on `RUNS_DIR` and the ledger of a run is on the host the
moment it is written; without the mount the numbers still exist, but only inside
the container that produced them — which is the whole failure mode this page is
about. The controller runs on the host and reads the same variable, so a run and
its ledger stay in one directory even when the harness is elsewhere.

```bash
# host (the controller side), the same root the container has mounted
RUNS_DIR=/srv/hermes-runs node tools/run-facts.mjs diamond-20261006-4
# container
RUN_ID=diamond-20261006-4 RUNS_DIR=/app/runs node bedrock-harness.mjs
```

## Using it

```bash
# after a run, from the repository root
node tools/run-facts.mjs diamond-20261006-4
node tools/run-facts.mjs runs/p3-first-night-3 --json

# while a harness is live
curl -s 127.0.0.1:3077/stats
```

For a run with no ledger file at all (anything before 06/10/2026, or any capture
directory written by a private helper script), the tool answers `verificabile: NO`
instead of guessing — which is the correct answer to give a human too.

## Related pages

- [verification](verification.md) — the status checklist the numbers feed.
- [control-flow](control-flow.md) — where an action comes from, before it is measured.
- [headless-client](headless-client.md) — what `observe()` reports at the same moments.
