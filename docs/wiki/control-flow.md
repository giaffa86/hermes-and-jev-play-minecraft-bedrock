# Control flow (goal → plan → actions)

Topic: how a goal travels from the top of the system down to a single bounded
action in the world, and where each component sits in that chain. This page
makes the planner/controller split in [overview](overview.md) concrete and shows
the boundary between the deterministic layer and the two LLM "systems".

## The loop at a glance

```
                              ┌───────────────────────────────┐
                              │      Progression Engine       │
                              │    deterministic macro-graph  │
                              │   wood → tools → iron → ...   │
                              │  (curriculum mode: next       │
                              │   missing milestone)          │
                              └──────────────┬────────────────┘
                                             │ next milestone (hint / deterministic plan)
                                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│                      SYSTEM TWO — HERMES (planner)                   │
│                                                                      │
│    GOAL + observation (+ milestone hint)                             │
│         → { objective, targets, waypoint, skill }                    │
│                                                                      │
│    • strategic replanner, not hierarchical planner                   │
│    • replans on skill done/failed, anti-loop, every N steps          │
│    • does NOT emit an action sequence                                │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ plan
                               ▼
              ┌─────────────────────────────────────┐
              │          Skill Resolver             │
              │  preconditions → active skill       │
              │  success criteria (for the verifier)│
              │  intent priorities (option boost)   │
              └─────────────────┬───────────────────┘
                                │ preferred intents
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     HARNESS / WORLD MODEL                            │
│                                                                      │
│    state → computes ONLY the currently valid actions                 │
│             /options = [A, B, C, ...]                                │
│    (owns validity; executes the chosen action)                       │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ options
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     SYSTEM ONE — JEV (controller)                    │
│                                                                      │
│    state + plan + options → ONE bounded action                       │
│                     choose(A/B/C)                                    │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ action
                               ▼
                             WORLD
                               │
                               └──────────────────► new state (loop)
```

Cross-cutting, deterministic, at every step:

```
┌──────────────────────────────────────┐
│         Survival Governor            │
│   deterministic rules                │
│   normal / caution / emergency       │
│   (emergency: overrides the objective│
│    shown to the model AND restricts  │
│    /options to the allowed intents)  │
└──────────────────────────────────────┘
```

## Stage by stage

1. **Progression Engine** (`survival/progression.mjs` + `knowledge/progression.json`)
   is the deterministic macro-graph of milestones (`wood → crafting_table →
   stone_tools → … → enter_nether`). In curriculum mode
   (`CURRICULUM=<milestone>`) it returns the *next missing prerequisite* and the
   controller builds a deterministic plan from it; Hermes is then only a
   fallback. In free-goal mode it is not consulted: Hermes plans directly from
   `GOAL`.

2. **System Two — Hermes** (`controller.mjs` → `hermesPlan`) turns the goal
   (plus the observation and, in curriculum mode, the milestone hint) into a
   single shallow JSON plan: `{objective, targets, waypoint, skill}`. It is a
   *shallow* planner: the prompt asks for "one sentence the controller can act
   on now", and it **never emits a sequence of actions**. It is re-invoked only
   on replan events (skill done/failed, anti-loop, every `REPLAN_EVERY` steps).

3. **Skill Resolver** (`survival/resolver.mjs`) picks the active declarative
   gameplay skill (governor preference → `plan.skill` → governor caution →
   progression milestone) and derives its *preferred intents*. Those intents are
   used only to reorder/boost options that the harness already offers — never to
   invent a key.

4. **Harness / world model** (`bedrock-harness.mjs` + `bedrock-adapter.mjs`)
   owns **validity**: from the current state it computes *only* the actions that
   are executable and useful right now and exposes them as `/options`. The models
   can only choose from that list; bad behaviour is fixed in the harness, not in
   the prompt. When the Bedrock session is **not live** the harness offers
   **nothing** (`adapter.sessionLive` false → `options()` returns `[]`,
   `optionsBlindReason = 'not_connected'`) and says so in the route
   (`connected: false` + `blind`, mirrored by `observe().connected`): before
   07/10/2026 it returned a fake `[{key: 'wait'}]`, which the controller read as
   "the only valid action" while the bot stood still and mobs killed it — 75
   `wait` decisions at a single option and the last 9 deaths of the day having
   `wait(ok)` as their last action. A **blind** harness is a broken run, not a
   quiet one: the controller resists `HARNESS_BLIND_MAX_STEPS` (default 6) steps
   without spending budget (`harness_blind`), then stops with exit code 2 and
   `harness_blind_stop`. `wait` survives only where it is true: a dead or sleeping
   bot is *connected*, and those two branches (plus the harness `busy` lock) still
   answer it.

5. **System One — Jev** (`controller.mjs` → `jevDecide`, via the OpenRouter/TypeSafe
   `/decisions` endpoint) chooses **one** bounded action per step from the
   options, with probabilities and confidence. `CONTROLLER=hermes` swaps this for
   a Hermes call with the same one-action constraint.

6. **World** — the chosen action is executed; the new state feeds the next
   iteration of the loop (re-observe → governor → verify → plan/decision).

The **Survival Governor** (`survival/governor.mjs` + `knowledge/survival-rules.json`)
sits beside the loop, not in it: it scores health/food/hostiles/night on every
observation. In an emergency it overrides the objective shown to the decision
model and restricts `/options` to the allowed intents (removing keys only, never
adding, never emptying the set).

## One action at a time: the harness `busy` lock

The harness executes a single action at a time and answers `{ok: false, error:
'busy'}` while another client is still running one (typical after a controller was
killed mid-action). `busy` is **a lock, not a verdict**: the controller retries the
same key every `HARNESS_BUSY_POLL_MS` up to `HARNESS_BUSY_MAX_WAIT_MS`, logs one
`harness_busy {step, key, attempts, waitedMs, ok, error}` event and only then
records a failure (`{error: 'busy', timeout: true}`). A `busy` answer therefore
never consumes a step — the validity of the retried action stays with the harness,
which answers with a typed error if the action is no longer possible. Without this,
a killed run's leftover action made the next run burn its entire step budget in
seconds of instant `busy` replies (live, 2026-10-03).

The lock is also **bounded from inside**: `executeAction` races the action body
(`_runAction`) against a watchdog, so an action whose promise never settles — the
bot died in the middle of a `read_container` (live, 2026-10-03) and the await hung
forever — ends as `{ok: false, error: 'action_timeout', action, timeoutMs}` with an
`action_timeout` log entry, and the `finally` still releases the lock. Without the
watchdog the whole API answered `busy` (even `wait`) until the container was
restarted. `HARNESS_ACTION_TIMEOUT_MS` (default 180000) is the ceiling; a rejected
body is returned as a typed error, never as an unhandled rejection.

## What System Two does *not* do

Despite the "planner" name, Hermes does **not** decompose the macro task into
elementary actions ahead of time. Task decomposition lives in two deterministic
places instead:

- the **progression graph** (milestone → prerequisite → skill), and
- the **declarative skill contracts** (preconditions + success criteria + intents).

Hermes only supplies the coarse objective/targets/skill; the step-by-step
"spezzatura in azioni elementari" is System One's job, one bounded action at a
time. See also [survival-intelligence](survival-intelligence.md) for the
"deterministic before the prompt" principle.

## Sources

- `controller.mjs` — the loop, `hermesPlan`, `jevDecide`, `goalMet`, replan events.
- `controller-decisions.mjs` — option ranking/cap, anti-loop, decision instructions.
- `survival/progression.mjs`, `knowledge/progression.json` — the macro-graph.
- `survival/resolver.mjs`, `survival/governor.mjs`, `survival/verify.mjs` — the
  deterministic layer.
- `bedrock-harness.mjs`, `bedrock-adapter.mjs` — validity and execution.
- Related wiki: [overview](overview.md), [survival-intelligence](survival-intelligence.md),
  [headless-client](headless-client.md), [architecture-evolution](architecture-evolution.md).
