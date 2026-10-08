# Control flow (goal → plan → actions)

Topic: how a goal travels from the top of the system down to a single bounded
action in the world, and where each component sits in that chain. This page
makes the planner/controller split in [overview](overview.md) concrete and shows
the boundary between the deterministic layer and the two LLM "systems".

## The loop at a glance

```
┌──────────────────────────────────────────────────────────────────────┐
│           INPUT — the chat channel  (chat-inbox.mjs, M1)             │
│   @bot <order|question>    allowlist · prefixes · rate limit         │
│   «ragiona» (M12) is a REPLY marker, stripped here: never routed     │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
                 ┌─────────────┴──────────────┐
                 │  DETERMINISTIC SHORT-CUTS  │  no model, no goal
                 │   M6 question (chat-intent)│──► answered from observe()
                 │  M10 told fact (memory-chat)│──► remember / consult
                 │   drop · farm · collect ·  │──► direct action
                 │   equip · stop · told_goto │
                 └─────────────┬──────────────┘
                               │ a real order → plan
                               ▼
              ┌───────────────────────────────────────┐
              │         Progression Engine            │  (curriculum mode:
              │       deterministic macro-graph       │   the next missing
              │      wood → tools → iron → ...        │   prerequisite)
              └───────────────┬───────────────────────┘
                              │ next milestone (hint / deterministic plan)
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│                      SYSTEM TWO — HERMES (planner)                   │
│                                                                      │
│    GOAL + observation (+ milestone hint)                             │
│         → { objective, targets, waypoint, follow, skill }            │
│                                                                      │
│    • strategic replanner, not hierarchical planner                   │
│    • replans on skill done/failed, anti-loop, every N steps          │
│    • does NOT emit an action sequence                                │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ flat plan
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│              R1 — the plan shape  (plan-shape.mjs, pure)             │
│                                                                      │
│   plan.subgoal  ← skill.description | plan.subgoal | milestone       │
│   plan.steps[]  ← { id, skill, circuit, targets, verify }            │
│   verify ⊆ CRITERIA_KEYS · no step ever names a /options key         │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ shaped plan
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                   GOAL MANAGER — the goal stack                      │
│                                                                      │
│   parentGoal · suspend / resume · MAX_GOAL_DEPTH · human_order_*     │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ active goal.plan
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
                               └──► re-observe → verifySkill → governor ──┐
                                                                          │
                                        (next step / next goal) ◄─────────┘
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

1. **Input — the chat channel** (`chat-inbox.mjs`) turns a line of chat into an
   order or a question: `CHAT_ALLOWLIST` gates *who* may order, `CHAT_PREFIXES`
   and `CHAT_SELF_NAME` decide *what* wakes the bot, and `CHAT_ECHO_WINDOW_MS`
   recognises the bot's own line coming back from the server. The `ragiona`
   marker (M12) is stripped here, so it changes the *answer* and never the
   routing — an order with `ragiona` and one without follow the same path.

2. **Deterministic short-cuts** run before any model: a question about the bot's
   own state is answered from `observe()` (M6 `chat-intent`), a dictated fact is
   written to the memory (M10 `memory-chat.mjs`, `CLARIFY` when ambiguous), and a
   direct order (`drop`, farm, `collect`, `equip`, `stop`, `told_goto`) is planned
   without a planner call. Only the direct orders become a goal.

3. **Progression Engine** (`survival/progression.mjs` + `knowledge/progression.json`)
   is the deterministic macro-graph of milestones (`wood → crafting_table →
   stone_tools → … → enter_nether`). In curriculum mode
   (`CURRICULUM=<milestone>`) it returns the *next missing prerequisite* and the
   controller builds a deterministic plan from it; Hermes is then only a
   fallback. In free-goal mode it is not consulted: Hermes plans directly from
   `GOAL`.

4. **System Two — Hermes** (`controller.mjs` → `hermesPlan`) turns the goal
   (plus the observation and, in curriculum mode, the milestone hint) into a
   single shallow JSON plan: `{objective, targets, waypoint, skill}`. It is a
   *shallow* planner: the prompt asks for "one sentence the controller can act
   on now", and it **never emits a sequence of actions**. It is re-invoked only
   on replan events (skill done/failed, anti-loop, every `REPLAN_EVERY` steps).

5. **R1 — the plan shape** (`plan-shape.mjs`, pure) derives `subgoal` and
   `steps[]` from the declarative artifacts (`skills/gameplay/**`,
   `circuits/*.json`, `progression.json`): each step names its skill, its
   circuit (`success.circuitBuilt.id`) and the criteria to verify, filtered to
   `CRITERIA_KEYS`. It is **additive** — a producer that already set
   `subgoal`/`steps` wins — and it never names an option key, so the one level
   it adds stays strategic. `{met: true}` is left untouched.

6. **Goal manager** (`goal-manager.mjs`, used from `controller.mjs`): a human
   order does not reorient the running goal, it becomes a *child* goal
   (`parentGoal`); the parent resumes when the child closes, revalidated first,
   so a goal already satisfied while suspended completes without spending an
   action. A stop order, an order from the same requester, or a chain deeper
   than `MAX_GOAL_DEPTH` still reorients (`human_order_override`).

7. **Skill Resolver** (`survival/resolver.mjs`) picks the active declarative
   gameplay skill (governor preference → `plan.skill` → governor caution →
   progression milestone) and derives its *preferred intents*. Those intents are
   used only to reorder/boost options that the harness already offers — never to
   invent a key.

8. **Harness / world model** (`bedrock-harness.mjs` + `bedrock-adapter.mjs`)
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

9. **System One — Jev** (`controller.mjs` → `jevDecide`, via the OpenRouter/TypeSafe
   `/decisions` endpoint) chooses **one** bounded action per step from the
   options, with probabilities and confidence. `CONTROLLER=hermes` swaps this for
   a Hermes call with the same one-action constraint.

10. **World** — the chosen action is executed; the new state feeds the next
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
time. R1 makes that boundary explicit **without moving it**: `plan-shape.mjs`
derives `subgoal`/`steps[]` *from* the skill contracts, so the decomposition is
still written in data and Hermes still never emits the step list. See also
[survival-intelligence](survival-intelligence.md) for the "deterministic before
the prompt" principle and [reasoning-roadmap](reasoning-roadmap.md) for R0/R1.

## Sources

- `controller.mjs` — the loop, `hermesPlan`, `jevDecide`, `goalMet`, replan events.
- `controller-decisions.mjs` — option ranking/cap, anti-loop, decision instructions.
- `survival/progression.mjs`, `knowledge/progression.json` — the macro-graph.
- `survival/resolver.mjs`, `survival/governor.mjs`, `survival/verify.mjs` — the
  deterministic layer.
- `bedrock-harness.mjs`, `bedrock-adapter.mjs` — validity and execution.
- `plan-shape.mjs` — the R1 plan shape (`derivePlanShape`, `withPlanShape`).
- `tools/capability-inventory.mjs` — the R0 offline inventory of the surface above.
- Related wiki: [overview](overview.md), [survival-intelligence](survival-intelligence.md),
  [headless-client](headless-client.md), [architecture-evolution](architecture-evolution.md),
  [reasoning-roadmap](reasoning-roadmap.md), [goal-stack](goal-stack.md).
