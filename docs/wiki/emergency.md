# Emergency goals (world events → preempting goals)

Topic: how a **world event suspends the running goal and starts a
higher-priority one** — the "Emergency system" milestone (M2) of the
[AI-player roadmap](ai-player-roadmap.md) — and where the boundary lies with the
Survival Governor.

Sources: `world-events.mjs`, `emergency-goals.mjs`, `goal-manager.mjs`,
`controller.mjs`, `survival/governor.mjs`.

## Producer taxonomy

A **producer** is a source that *creates goals* in the `GoalManager` queue.

| Producer | `source` | Creates goals when | Where |
|---|---|---|---|
| Initial seed | `curriculum` / `autonomous` | controller start | `seedInitialGoal()` |
| Chat channel | `chat` | a trusted human sends `@bot …` while `IDLE` | `waitForGoal()` |
| Idle autonomy | `autonomous` / `emergency` | a survival need appears while `IDLE` | [idle-goals.mjs](../../idle-goals.mjs) |
| **World events** | `emergency` | an event happens **while a goal is RUNNING** | [world-events.mjs](../../world-events.mjs) + [emergency-goals.mjs](../../emergency-goals.mjs) |
| **Opportunities** | `opportunity` | a valuable vein comes in sight **while a goal is RUNNING** | [world-events.mjs](../../world-events.mjs) + [opportunity-goals.mjs](../../opportunity-goals.mjs) |

The first three only fire while the agent is idle. The last two can interrupt an
in-flight goal, but differently: the emergency **preempts** it because continuing
is harmful, the opportunity only **suspends** it because something better is in
reach ([opportunity](opportunity.md)).

## Two levels of emergency

### Action level — Survival Governor (already existed)

Every step, `evaluateSurvival()` (in `survival/governor.mjs`) computes a
deterministic verdict from the observation. In `emergency` it:

- overrides the objective shown to the decision model
  (`decisionPlan.overrideObjective`);
- makes the harness restrict `/options` to `allowedIntents` (it removes keys,
  it never adds any).

This is the right place for **sub-second reactions** inside the current goal
(flee from a creeper, eat, dodge). The goal's identity does not change.

### Goal level — emergency producer (this slice)

Some events deserve their **own goal**: a multi-step activity that must survive
a replan, be visible in the queue/history, carry a priority, and have a parent
to return to. For those, `world-events.mjs` detects the event and
`emergency-goals.mjs` maps it to an `EMERGENCY` goal.

## Flow: a death preempts the running goal

```
GOAL RUNNING: "mine 16 logs" (source curriculum)
   │   every step the controller fetches /observe
   │
   ├─ world event = PLAYER_DIED      (dead flag flips, or a new death site appears)
   │
   ├─ runGoal() returns { status: 'preempted', emergency }
   │
   ├─ goalManager.preempt('emergency:PLAYER_DIED')
   │        └─ "mine 16 logs"  →  SUSPENDED
   │
   ├─ goalManager.enqueue({ source: EMERGENCY, priority: 100,
   │         parentGoal: "mine-16-logs",
   │         plan: { recover: true, ... } })      → new goal RUNNING
   │
   ├─ runGoal(emergency): `recover_loot` until the harness clears `deathSite`
   │
   └─ on completion: goalManager.resume("mine-16-logs")  → the parent resumes
```

State machine of the two goals:

```
RUNNING(parent) ──event──► preempt ──► SUSPENDED(parent)
                                            │
                             (emergency goal) RUNNING(child, parentGoal=parent)
                                            │
                                  complete ─┴─► PENDING(parent) ──► RUNNING(parent)
```

Mapping implemented today: **`PLAYER_DIED → recover_loot`** (loot priority list,
`plan.recover = true`; success = `deathSite` cleared by the harness, checked in
`goalMet`, never by the model). `LOW_HEALTH` and `HOSTILE_AMBUSH` are detected
but **not** turned into goals: the governor already handles them instantly.

## Boundary rule (what becomes a goal)

| Case | Level | Why |
|---|---|---|
| Creeper about to explode, projectile, lava under foot | governor | must be sub-second, inside the current plan |
| Recover loot after death | **emergency goal** | multi-step, survives replan/restart, deserves a record + parent |
| Low health / eat / heal | governor | one action (`eat`/`flee`), override is enough |
| Rescue a player, flee a lasting hazard | emergency goal | multi-step, player-facing |
| Drowning / on fire / lava near | governor or goal | blocked: needs fluid/fire perception ([fluids](fluids.md) M0) |
| A richer vein in sight while a goal runs | **opportunity goal** | multi-step detour that needs a parent to resume (suspended, not preempted) — [opportunity](opportunity.md) |
| A human `@bot` order while a goal runs | **child goal (suspend + resume)** | the human outranks the plan; the order runs as its own goal with its own requester and the parent is revalidated before resuming — [goal-stack](goal-stack.md) |

## Dedup and anti-oscillation

- Every event carries a `dedupKey` (e.g. `death:<x>,<y>,<z>`), so a condition
  that persists across steps fires once.
- `emergencyGoalFor` refuses to re-create an event within
  `EMERGENCY_COOLDOWN_MS` (default 60 s); a failed emergency is retried later,
  not in a tight loop.
- **One level of nesting**: an `EMERGENCY` goal does not preempt itself, so
  `runGoal` skips event detection when `goal.source === EMERGENCY`.
- Interaction with the Goal Contract: the contract is evaluated first, so a
  contract that terminates the goal on death still wins; preemption happens
  before any *action* is chosen.

## Configuration

`EMERGENCY` (default: on when `SESSION=on`), `EMERGENCY_COOLDOWN_MS` (default
60000). See [BEDROCK.md](../../BEDROCK.md) → "Agent session".

## Status

- **Implemented and live-verified (BDS, 2026-10-02)**: `world-events.mjs`
  (`detectEvents`), `emergency-goals.mjs` (`emergencyGoalFor`), controller wiring
  (preempt in `runGoal`, enqueue + resume in `main`), `plan.recover` success
  predicate. Unit tests (`tests/world-events.test.mjs`,
  `tests/emergency-goals.test.mjs`) + an integration test (death → preempt →
  `recover_loot` → parent resumed and completed). Live: a forced death produced
  `EMERGENCY PLAYER_DIED: suspend g1 -> run g2`; `g2` ran `recover_loot`,
  `COMPLETED` via `plan.recover`, and `g1` resumed. The live round exposed a real
  bug — a periodic replan replaced the emergency plan, dropping `plan.recover` —
  fixed by skipping replanning for `plan.need`/`plan.recover` (regression test).
- **Missing**: mapping the detected `LOW_HEALTH`/`HOSTILE_AMBUSH` events (kept at
  the governor for now); a loot-priority executor; nested preemption (parent
  chains); world events that need fluid/fire perception ([fluids](fluids.md) M0).
- **Known blocker (not this module)**: on the live BDS both forced deaths left
  the bot stuck in `dead` (the server ignored `player_action respawn` — see
  [open-questions](open-questions.md) / verification row 12), so the emergency
  could only recover after a BDS restart at zero players.

## Related pages

- [opportunity](opportunity.md) — the suspending counterpart (a better vein in sight).
- [goal-stack](goal-stack.md) — the human-order sibling (an order suspends the running goal).
- [ai-player-roadmap](ai-player-roadmap.md) — M2 in the nine-milestone plan.
- [survival-intelligence](survival-intelligence.md) — the governor (action level).
- [control-flow](control-flow.md) — where emergency goals sit in the loop.
- [roadmap](roadmap.md) — overall status and next planned work.
