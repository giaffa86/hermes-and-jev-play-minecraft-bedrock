# AI player roadmap (persistent autonomous agent)

Topic: synthesis of the evolutionary roadmap in
[`docs/raw/AI_PLAYER_ROADMAP.md`](../raw/AI_PLAYER_ROADMAP.md) — taking Hermes
from a *chat-controllable bot* to a *persistent autonomous agent* — plus the
result of its first milestone (the **lifecycle audit**), which answers the
file's opening question with the actual post-goal behaviour observed in the code.

## North star

> Hermes must not live "as long as there is a goal". Hermes must live "as long
> as the agent session is active". Goals are temporary activities inside a
> persistent session.

Concretely, the target is the `test` suite at the end of the roadmap: complete a
goal and stay in the server; accept a new goal while idle without reconnect;
behave as a credible companion with no commands for 20 minutes; suspend the
current task to recover a player's loot on death; resume the previous goal; and
reconnect + restore context if the connection drops.

## Milestone 0 — lifecycle audit (result)

The roadmap's first checkpoint asks a factual question:

> Does Hermes stay connected to the server when a goal ends, or is the player
> bot disconnected / does the process become inactive?

**Answer: the bot stays connected. Goal completion does not disconnect it.** The
separation between *goal lifecycle* and *connection lifecycle* already exists,
but only implicitly — there is no explicit `IDLE` state and no persistent goal
loop yet.

Verified behaviour in the code (authoritative):

| Claim | Status | Where |
|---|---|---|
| Bot stays connected + spawned after goal completion | ✅ yes | `bedrock-harness.mjs` is a long-running HTTP server; the `BedrockAdapter` keeps the connection open regardless of the controller. |
| Goal completion and disconnect are independent events | ✅ yes | The controller never sends a disconnect; no HTTP route disconnects the bot. |
| Disconnect happens only on explicit shutdown / error / admin action | ✅ yes | `shutdown()` → `adapter.disconnect('harness shutdown')` on `SIGTERM`/`SIGINT`; on an unexpected drop `onDisconnect` starts a reconnect worker after 10 s. |
| Can receive a new goal without reconnect | ◑ manual | Restart `controller.mjs` against the same running harness (same `RUN_ID`/`API_PORT`); the bot stays connected, so no reconnect is needed — but there is no live "wait for next goal" loop. |
| Keeps reading chat while idle | ◑ partial | The harness keeps capturing chat into `chatInbox` (exposed in `/observe`), but the *actor* on chat (`maybeHumanCommand`) lives in the controller, which has exited. |
| Enters an explicit `IDLE` state when goal-less | ❌ no | "Idle" today = controller exited, bot standing still in the world. No state machine models it. |

The key fact behind this table: `controller.mjs` is a **one-shot loop**. It runs
`for (let step = 1; step <= MAX_STEPS; step++)`, `break`s on `GOAL MET` /
curriculum goal / budget exhausted, then always ends with `process.exit(0)`. The
harness it drove is a *separate* process that keeps the bot alive. So when the
goal ends the planner dies, but the player bot does not log out.

Two controller details worth knowing:

- `follow` plans are **open-ended**: `goalMet()` returns `false` whenever
  `plan.follow` is set, so a *"follow me"* order never self-completes — it runs
  until a new `@bot` order replaces it or the step budget runs out.
- After the controller exits, new `@bot` chat messages are still captured by the
  harness but **no longer acted on**: the process that polls chat and issues
  `/plan` + `/act` is gone. To drive the bot again you re-run `controller.mjs`.

**Gap to close** (Milestone 0 → 1): make the controller a persistent *session
loop* (or move a `Session Manager` into the harness) that models the
`CONNECTED → IDLE → GOAL_RUNNING → GOAL_COMPLETED → IDLE` cycle and keeps
polling for new goals instead of calling `process.exit(0)`.

## Target state machine

```
DISCONNECTED → CONNECTING → CONNECTED → IDLE → GOAL_RUNNING → GOAL_COMPLETED → IDLE
```

with interruption (`GOAL_SUSPENDED` / `EMERGENCY_GOAL` / `RESUME_PREVIOUS_GOAL`)
and connection loss (`CONNECTION_LOST → RECONNECTING → RESTORE_STATE → RESUME`)
as orthogonal transitions. Today only the connection half of this exists (the
harness reconnect worker); the goal/idle half does not.

## Roadmap milestones

The roadmap orders the work in nine milestones. The first (persistence) is the
audit above; the rest are design sketches, none implemented yet:

| # | Milestone | What it introduces |
|---|---|---|
| 0 | Lifecycle persistence | separate goal/connection lifecycle, idle state, new goal without reconnect, reconnect without losing agent state. |
| 1 | Agent Core | a **Goal Manager**: every activity is a `goal {id, type, source, priority, status, parameters, parentGoal, createdAt}` with status `PENDING/RUNNING/SUSPENDED/COMPLETED/FAILED` and sources `CHAT/AUTONOMOUS/WORLD_EVENT/PLAYER_BEHAVIOR/EMERGENCY`. Chat commands become goals, never raw primitives. |
| 2 | Emergency system | world events auto-create preempting goals — `PLAYER_DIED → RECOVER_PLAYER_LOOT (CRITICAL)` with loot priorities (netherite/diamond → enchanted → elytra → …) and risk awareness (lava/warden/nether). |
| 3 | Autonomy | needs-driven idle behaviour (food low → find food; tool missing → craft; inventory full → store; night → shelter; else explore) via state + rules + utility score, **not** an LLM per decision. |
| 4 | Social behaviour | attention system (crouch/jump/stare/light hit → `PLAYER_REQUESTS_ATTENTION`) and contextual assistance (mining/fighting/building/fleeing/exploring → assist/observe/ignore). |
| 5 | World awareness | home system (bed/chest/furnace/table/storage/safe area) and world memory (resource spots, caves, villages, danger zones, structures, death locations). |
| 6 | Advanced navigation | world-modifying pathfinding: bridge, pillar, dig tunnel, safe descent, break obstacle. |
| 7 | Planning | hierarchical goals with prerequisites and subgoals (e.g. `FIND_DIAMONDS → iron pickaxe → iron → smelt → …`), failure recovery. |
| 8 | Character | personality layer (curiosity/risk tolerance/…) that *modulates* the Goal Manager weights, plus a player model; last, after the rest is stable. |

## Explicitly deferred

No LLM-for-every-decision, no complex dialogue, no simulated emotions, no huge
vector memory DB, no multi-agent coordination, no online learning — until
Hermes reliably does: stay connected, goal, interrupt, resume, survive, recover
loot, navigate, help, remember, idle intelligently.

## Relationship to what exists today

The roadmap's "chat → goal, never raw primitives" principle is *partially*
already true: the chat channel ([human-command](human-command.md)) routes a
natural-language order through Hermes into a `plan` (`/plan`), and Jev only ever
picks bounded keys from `/options`. What is missing is the *persistent* layer
around it — a goal queue with priorities/suspend/resume and an idle loop — rather
than the one-shot plan that `controller.mjs` currently is.

## Sources

- [`docs/raw/AI_PLAYER_ROADMAP.md`](../raw/AI_PLAYER_ROADMAP.md) — the roadmap (Italian).
- `controller.mjs` — the one-shot loop, `goalMet`, `process.exit(0)`, `maybeHumanCommand`.
- `bedrock-harness.mjs` — long-running server, reconnect worker, `shutdown()`.
- `bedrock-adapter.mjs` — connection lifecycle, chat capture (`chatInbox`).

## Related pages

- [control-flow](control-flow.md) — how a goal travels down to one bounded action today.
- [human-command](human-command.md) — the chat command channel (M1–M3 done).
- [architecture-evolution](architecture-evolution.md) — Hermes as strategic replanner.
- [roadmap](roadmap.md) — consolidated implementation status of the current port.
- [open-questions](open-questions.md) — blockers and gaps.
