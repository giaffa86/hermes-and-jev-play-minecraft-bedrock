# Goal stack: suspension and resume

Topic: what happens when **a human order arrives while the bot is already
running a goal**. Until 2026-10-06 the new order *reoriented* the running goal
(replaced its `plan` in place, kept one goal, kept one `humanOrder`). Now it
**suspends** the running goal, runs the order as a **child goal** and resumes the
parent when the child closes — the same `SUSPENDED → PENDING` model the
[emergency](emergency.md) producer and the [opportunity](opportunity.md) detour
already use, extended with a real parent/child chain.

Status: **implemented and unit-tested (2026-10-06)**; no live round yet.

## Why suspension instead of reorientation

The old reorientation was one goal carrying two objectives: the parent's progress
was thrown away (`plan` replaced), the goal's `objective`/`plan` no longer
matched its record, and the requester attribution broke — the outcome went to the
goal's original `from`, even when a *second* human had sent the order that was
actually being executed.

Suspension fixes both without a second scheduler:

- the parent goal keeps its own `objective`/`plan`/`humanOrder` while the child
  runs, so the human's order cannot corrupt the parent's record;
- every goal carries the requester of **its own** order (the child's
  `parameters.from`), so ack and outcome always reach the human who asked;
- `goalManager.preempt()` + `goalManager.resume()` already existed for the
  emergency path — the human-order path reuses them instead of a parallel
  mechanism.

## Rules (when an order suspends and when it does not)

`runGoal` reads the order inside the loop (`maybeHumanCommand`). The choice is
made once per order:

| Situation | Behaviour | Why |
|---|---|---|
| The order is a **stop** order (`isStopOrder`) | **reorients** the running goal | "fermati" must close the follow/escort goal, not park it to resume later. Asserted by `tests/controller-follow-order.test.mjs`. |
| The goal's **requester** is the same human (`goal.humanOrder.from === from`, or a `chat` goal whose `parameters.from` matches) | **reorients** (a revision of the same order) | the human changed their mind; nesting a child of their own goal would resume stale work they just revised. |
| The running goal is an `EMERGENCY` goal | **reorients** | an emergency is not suspendable (one level of nesting, same rule as the emergency producer). |
| The parent chain is already `MAX_GOAL_DEPTH` deep (`goalManager.depth(goal.id) >= MAX_GOAL_DEPTH`, default 3) | **reorients** + logs `human_order_override` | bounded stack: the bot must not accumulate unbounded nested orders from several humans. |
| Any other case (autonomous/village/curriculum/opportunity goal, different human) | **suspends** the parent and enqueues the order as a child | the human outranks the plan; the parent comes back. |

A `stop` order from a *different* human therefore still reorients (it is a stop,
not new work); this is deliberate and asserted by the existing follow tests.

## Lifecycle

```text
parent RUNNING ──order (different requester)──▶ parent SUSPENDED
                                                child PENDING → RUNNING
   runGoal returns {status:'preempted', human:{plan, entry}}
   main: preempt('human_order:<from>') + enqueue(child, parentGoal: parent.id)
         console: HUMAN ORDER <from>: suspend <parent> -> run <child>
         log:     human_preempt {from, parentGoalId, goalId, plan}
child terminal (success | failed | exhausted)
   main: parent = goalManager.get(child.parentGoal)
         goalAlreadySatisfied(parent, obs)?
            yes → complete(parent)  print: GOAL <id> COMPLETED (already satisfied while suspended)
                                      log:   goal_resume_satisfied {goalId, after, steps:0}
            no  → resume(parent)    print: RESUME <id> (suspended while <child> ran)
                                      log:   goal_resumed {goalId, after}
   then reportHumanOutcome(child, …) sends the order's ack/outcome to the order's own sender
```

The parent block sits **before** the `error`/`SESSION=off` exits in `main`, so a
child that failed, was cancelled or ended with an error still hands the parent
back (case 2 below). The chain is recursive: an emergency during a human order
suspends the human's child too, and unwinds one level at a time
(`g3 → g2 → g1`).

## Resume is a re-plan, never a mid-action resume

Nothing is checkpointed inside an action. Resuming a goal is exactly what the
session loop does at startup: the goal becomes `PENDING`, `pull()` picks it, and
`runGoal` starts from step 1 with a **fresh `observ()`**. That is why the resume
must first revalidate:

- `goalAlreadySatisfied(goal, obs)` = `goalMet(obs, plan, null) && !planIsOpen(plan)`
  — the last part is the same guard `runGoal` uses for a human order: a plan that
  is open by construction (`follow`, `need`, `recover`, `drop`, `collect`, no
  targets/waypoint) is never "already satisfied", it simply cannot be judged from
  a single observation;
- if satisfied, the parent is **completed without a single action** and the
  completion is logged (`goal_resume_satisfied`), not silently dropped;
- otherwise the parent is `resume()`d and re-runs — `tests/controller-goal-stack.test.mjs`
  case 1 asserts the resumed autonomous goal re-runs its plan from scratch
  (`dig_down` again, not the remaining count).

## Requester attribution

`goal.humanOrder.from` (set by the old reorientation path) is no longer the only
source of a sender. `reportHumanOutcome(goal, {status, steps, reason})` resolves
it as:

```js
const humanFrom = goal.humanOrder?.from
  ?? (goal.source === GOAL_SOURCE.CHAT ? goal.parameters?.from ?? null : null);
```

so a chat-sourced goal reports to the human in **its own** `parameters.from` even
when a later goal has a different sender. `human_order` (the reorientation event)
now carries `from`, and the new `human_preempt` event carries `from` +
`parentGoalId` + `goalId`, so the log distinguishes "was revised" from "was
suspended". Consecutive orders from two different humans (case 5) each get their
own ack/outcome pair, and neither message carries the other human's objective.

## The six cases

| # | Case | Expected |
|---|---|---|
| 1 | autonomous A → human B → B done | `HUMAN ORDER B: suspend A -> run B`, B completes, `RESUME A`, A re-runs its plan and completes; A's plan never contains B's plan. |
| 2 | autonomous A → human B → B failed | B fails (`no_matching_drop`, no `/act`), A is **still** resumed and completes; no fake success line to B (only the ack + the refusal). |
| 3 | autonomous A → human B → emergency → B → A | `HUMAN ORDER … suspend A -> run B`, then `EMERGENCY PLAYER_DIED: suspend B -> run E`; the unwind order is `RESUME B`, `RESUME A`; the persisted records carry `E.parentGoal = B`, `B.parentGoal = A`. |
| 4 | suspended goal already satisfied | `GOAL A COMPLETED (already satisfied while suspended)`, no `RESUME A`, zero actions for A, `goal_resume_satisfied`. |
| 5 | two different humans, consecutive orders | each order is its own child with its own `parameters.from`; every message to B names B's order and every message to A names A's; both children parent the same suspended A. |
| 6 | controller restart with suspended goals | `RESUME N goal(s) from a previous session` re-queues them; `pull()` priority/FIFO runs the child before the parent; the `parentGoal` link survives the round-trip in `runs/<RUN>/goals/world.json`. |

## Boundary with the other suspend/resume producers

| Producer | Source | Suspends the running goal? | Parent resume |
|---|---|---|---|
| World event (death) | `EMERGENCY` (priority 100) | yes, `preempt()` | yes, revalidated ([emergency](emergency.md)) |
| Valuable vein in sight | `OPPORTUNITY` (55) | yes (spec) | yes ([opportunity](opportunity.md)) |
| Human `@bot` order | `CHAT` (80) | yes, unless stop/same requester/emergency/depth cap | yes, revalidated (this page) |

An `EMERGENCY` goal never suspends itself, and a human order never suspends an
emergency: both keep the nesting bounded by construction.

## Configuration

- `MAX_GOAL_DEPTH` (default `3`) — depth of the parent chain (`goalManager.depth`)
  above which a new human order reorients the running goal instead of nesting.
  A depth-capped preemption logs `human_order_override` with the depth.
- Everything else is unchanged: `SESSION`, `RESUME`, `CHAT_CONTROL`,
  `CHAT_ALLOWLIST`, `CHAT_REPLY`. Suspension emits no new chat traffic — the
  narration and greeting rules are untouched.

## Evidence

- `tests/controller-goal-stack.test.mjs` — the six cases plus the
  same-requester boundary, against a scripted harness (`startStackHarness`):
  7 tests, all green.
- `tests/goal-manager.test.mjs` — `ancestors`/`depth` (nearest-first,
  orphan-safe, cycle-safe) on top of the pre-existing queue/preempt/resume unit
  tests: 13 tests, all green.
- Existing suites still green: `node --test tests/controller-*.test.mjs
  tests/goal-manager.test.mjs` (goal, chat, follow, escort, mount, mission,
  curriculum) — 112 pass before the new file, plus the two files above.

## Open edges

- **A stop order still closes the goal.** `@bot fermati` mid-goal is a
  reorientation that *satisfies* the running follow plan and closes it; it is not
  a "suspend and ask later". Left as is on purpose (the follow tests define it).
- **`MAX_GOAL_DEPTH` overflow degrades to reorientation.** The third nested order
  replaces the running goal's plan, i.e. the old behaviour, rather than being
  refused. No chat line tells the human the order was not queued.
- **Startup resume stays flat.** Goals suspended by a *previous session* are
  re-queued by priority/FIFO with no world revalidation (`goalAlreadySatisfied`
  needs a live observation that the startup path does not fetch, and
  `tests/controller-session.test.mjs` asserts the current ordering). A goal
  left over between sessions may therefore run one stale step before its own
  `goalMet`.
- **Children of a child**: the chain is bounded by `MAX_GOAL_DEPTH`, but the
  records only carry one `parentGoal`; nothing currently *walks* the chain to
  decide chat policy (a reorientation on a grandchild reports to that child's
  requester, which is the intended behaviour but not separately tested).
- **Live round**: all of the above is scripted-harness evidence; no human has yet
  sent two consecutive orders to the bot on the real BDS.

## Related pages

- [emergency](emergency.md) — the emergency producer that shares the preempt/resume model.
- [opportunity](opportunity.md) — the value-driven detour that also suspends and resumes.
- [human-command](human-command.md) — the chat channel that produces the orders.
- [ai-player-roadmap](ai-player-roadmap.md) — the Goal Manager milestone.
- [goal-achievement](goal-achievement.md) — suspend/resume in the goal-driven proposal.
- [control-flow](control-flow.md) — where the goal transitions sit in the loop.
- [verification](verification.md) — row 63.
