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
as orthogonal transitions. The connection half exists (the harness reconnect
worker); the goal/idle half is now implemented (below).

## Milestone 1 — Agent Core + session loop (implemented)

The controller is now a **persistent session loop**. With `SESSION=on` it does
not call `process.exit(0)` when a goal ends: it records the outcome, enters an
explicit `IDLE` state and keeps polling `/observe` for a new goal (an in-game
`@bot` order becomes a `chat` goal), then runs it against the **same harness
connection**. `SESSION=off` (default) preserves the historical one-shot loop and
exit codes.

The **Goal Manager** (`goal-manager.mjs`) is the pure Agent Core behind it:

- goal `{id, type, source, priority, status, objective, plan, parameters,
  parentGoal, attempts, createdAt, startedAt, finishedAt, reason, result}`;
- sources `EMERGENCY/CHAT/WORLD_EVENT/PLAYER_BEHAVIOR/CURRICULUM/AUTONOMOUS`
  with default priorities (emergency > chat > curriculum > autonomous);
- statuses `PENDING → RUNNING → (SUSPENDED) → COMPLETED/FAILED` plus
  `CANCELLED`; at most one goal `RUNNING` at a time;
- `pull()` by priority then FIFO; `preempt()` suspends the running goal, and
  `ancestors()`/`depth()` walk the `parentGoal` chain so a suspension can nest
  and unwind (a human order or an emergency, bounded by `MAX_GOAL_DEPTH`);
- `snapshot()/restore()` and persistence through a repository
  (`kind: 'goal'`, file `runs/<RUN_ID>/goals/world.json`).

The session loop wires it as: `pull → start → runGoal → complete/fail/cancel →
IDLE`; transitions are logged (`session_state`, `goal_start`, `goal_end`) and a
goal left `running` by a previous run is suspended on startup. Covered by
`tests/goal-manager.test.mjs` (unit) and `tests/controller-session.test.mjs`
(integration against a fake harness: goal → COMPLETED → IDLE, and an idle `@bot`
order becoming a new completed `chat` goal with no reconnect). **Verified live on
the BDS (2026-10-02)**: a seeded goal completed, the loop entered `IDLE`, the
queue was persisted (`runs/<RUN>/goals/world.json`) and the process stayed alive
until `IDLE_TIMEOUT_MS`.

Still missing (later milestones): the rest of the needs-driven menu
(inventory-full → store, else explore) and a Goal Manager API on the harness HTTP
surface. Nested suspension exists for human orders ([goal-stack](goal-stack.md))
and emergencies, bounded by `MAX_GOAL_DEPTH`. Cross-session **resume** is implemented, and the
first **emergency producer** (`PLAYER_DIED → recover_loot`, which suspends the
running goal and resumes it afterwards) is implemented — see
[emergency](emergency.md). The autonomy slice below is implemented.

## Milestone 3 — Autonomy, first slice (implemented)

With `AUTONOMY=on` (requires `SESSION=on`) the `IDLE` state derives goals from
the **survival needs** already produced by the Survival Intelligence Layer
(`deriveNeeds`/governor): `idle-goals.mjs` maps each actionable need to an
objective and a utility score and picks the best one, ranking `emergency` needs
(governor in emergency: survive/escape/heal) first. The goal is enqueued as
`source: autonomous` (or `emergency`) and its success is the deterministic,
harness-side predicate `isNeedResolved(need, observation)` — the need
disappearing from observation — never the model's opinion. A per-need cooldown
(`AUTONOMY_COOLDOWN_MS`) prevents retry loops and `AUTONOMY_MAX_GOALS` bounds
the session. Not yet produced: "else explore" (`store_harvest` is now also
produced by village labor, below).
Tests: `tests/idle-goals.test.mjs` (unit) and the autonomy case in
`tests/controller-session.test.mjs` (integration: a night-without-bed need
becomes a completed `autonomous` shelter goal). **Verified live on the BDS
(2026-10-02)**: in `IDLE` the bot generated `autonomous` goals for real needs —
`escape` (a hostile at ~9 blocks; `flee` pushed it beyond the danger radius) and
`sleep` (bed reached; `sleep` → `night_skipped`) — each closed by
`isNeedResolved` (deterministic, no LLM in the decision).

## Milestone 3b — Village labor (implemented)

The autonomy slice above keeps the bot *alive*; this one makes it *useful*.
With `VILLAGE_WORK=on` (default: same as `AUTONOMY`) the same `IDLE` state also
asks `village-labor.mjs` for a bounded **chore** drawn from the village's
everyday work: `harvest_crops`, `store_harvest`, `shear_sheep`, `milk_cows`,
`collect_honey`, `tend_animals` (breed), `plant_crops`, `go_fishing`,
`chop_wood`, `gather_stone`, `mine_ore`. Two rules keep it honest:

- **The harness is the arbiter.** A chore is only proposed if `GET /options`
already offers one of its intents (`harvest_*`, `deposit_*`, `shear_sheep`,
`milk_*`, `harvest_honey*`, `feed_*`/`breed_*`, `plant_*`,
`fish`/`cast_rod`/`reel_in`, `mine_*`), so an invalid action can never become a
goal. The module never invents an intent and never overrides a chat order or an
emergency (chores are `autonomous`, the lowest source priority).
- **Success is a state delta**, checked by `isChoreResolved` against a
`villageSnapshot` taken when the goal was created: items gained (`choreGain`), a
seed actually spent (`plant_crops`) or a new baby (`tend_animals`) — never an
absolute count and never the model's opinion. The drop list is fixed at
creation, because after the harvest the crop is gone and the delta would not be
measurable.

Utility ranks the chores (`harvest_crops` 70 … `mine_ore` 40, plus
`min(count,5)*2`), `VILLAGE_COOLDOWN_MS` is the anti-loop and
`VILLAGE_MAX_CHORES` bounds the session. A chore is enqueued as
`source: autonomous` with `plan.chore`/`plan.choreBefore` and `type: 'village'`,
so `goalMet` closes it on the same deterministic predicate the needs use. Tests:
`tests/village-labor.test.mjs` (18 unit tests, no server) plus the village case
in `tests/controller-session.test.mjs` (integration: an offered `harvest_*`
becomes a completed `village` goal).

The chores are the bot's *own* initiative; making the **same chain** answer an
 explicit order (`@bot raccogli le carote`, with the village register it reads
the plot from) is the subject of
[village reconnaissance](village-recon.md).

## Milestone 8 — Autonomy narration (implemented)

*Numbering note: the label follows the wording of the request that authorised
it (M8). It is a slice of milestone 3/4 — autonomy plus social behaviour — not
the `M8 Character` row of the table below.*

Before this slice the bot worked in silence when nobody had asked it anything: a
village chore started, the human in front of it saw it walk away, and had no idea
why. Now the goal announces itself, once, at the moment it starts: *"In
autonomia: sto raccogliendo le patate"*.

The composition lives in `chat-narration.mjs` (pure, no I/O):

| function | role |
|---|---|
| `narrateGoal(plan, {lang})` | picks the frame: a `plan.chore` first, then a `plan.need`; `null` when there is nothing to say |
| `narrateChore(choreId, target, {lang})` | `narrate.<choreId>` from the catalogue, with `{target}` filled by `targetWord`; `null` for an unknown chore |
| `narrateNeed(need, {lang})` | the whole sentence from `narrate_need` + `need.<id>` (a need has its own frame, so it is not wrapped a second time in `autonomy_narration`) |
| `targetWord(target, {lang})` | the concrete item (`item.potato`) when the catalogue knows it, otherwise the family word (`kind.log`, `kind.ore`, `kind.crop`, …), otherwise `kind.goods` |

The concrete name comes from the chore itself: M8 gave every `VILLAGE_CHORES`
entry a `target` (`targetOf` in `village-labor.mjs`, e.g.
`{kind: 'crop', item: 'potato'}` for `harvest_crops`) and the controller copies
it into `plan.choreTarget`. `tests/chat-narration.test.mjs` walks every chore and
every `NEED_PRIORITY` entry to prove each one is announceable in all five
languages, and that a raw id never reaches the chat;
`tests/village-labor.test.mjs` proves a chore reports what it is working on.

In `controller.mjs` the announcement is `maybeNarrateGoal(goal)`, called from
`main()` just before `runGoal(goal)`. Its gates are the whole policy:

1. `CHAT_NARRATE` is on (default: follow `CHAT_REPLY`) and the goal type is
   `village`/`autonomous` — a human order is never narrated back to the human;
2. the goal has something to say (`narrateGoal` returns a sentence);
3. `CHAT_NARRATE_COOLDOWN_MS` (default 300000) has elapsed since the last one;
4. `observe().spawned` and at least one human within `CHAT_GREET_RANGE`
   (`nearbyHumans`);
5. the goal is remembered in `narratedGoals` **only when the message is actually
   sent**, so a goal that starts in solitude keeps its chance to speak later.

The message goes through `saySmart` as both text and `grounding`, so the M7 LLM
can rephrase it but cannot invent a fact, pick another language or announce a
goal of its own; with no key the same sentence is sent verbatim. The log carries
`autonomy_narration` (`goalId`, `type`, `chore`/`need`, `humans`, message) and
`NARRATE [gN] …` on stdout. There is deliberately **no** end-of-goal
announcement: the chat is for the humans, not a journal.

Integration proof: the village case in `tests/controller-session.test.mjs`
asserts that, with a human at distance 5 and the channel open, the sentence
*"In autonomia: sto raccogliendo il grano"* actually reaches `POST /say`.

## Milestone 3c — The work comes home (implemented)

M3b gave the bot chores; M3c gives it an **economic cycle**: a productive goal
ends when what it gathered is *usable*, not when the last block is mined. On a
successful `village`/`autonomous` goal, and with `VILLAGE_STORE_EPILOGUE=on`
(default: it follows `VILLAGE_WORK`), `maybeStoreEpilogue` queues one last child
goal — `store_harvest` with `storeThreshold: 1` — before the loop returns to
`IDLE`. The sequence is **produce → store → verify**.

Why a child goal and not a step inside the parent: the store closes on
`isChoreResolved`, the same state-delta verifier the chores use, and it keeps
the parent's outcome untouched — a harvest that succeeded is not turned into a
failure because the chest was full. The child is enqueued only when

1. the parent finished `success` (a failed goal has nothing to store),
2. its type is `village`/`autonomous` (a chat order ends where the human
   asked it to end; the M8 narration is not a reason to walk to a chest),
3. it is not itself a `store_harvest` (no epilogue of an epilogue),
4. `GET /options` still offers a deposit and `observe().deposit` still lists
   something worth storing,
5. it has not already been served (`storeEpilogues`).

It is a normal `autonomous` goal (`priority` 20), so a chat order that arrives
in the meantime is served first, and it does **not** count against
`VILLAGE_MAX_CHORES`: it is the tail of a goal already counted.

### Where the policy lives: the harness

| Piece | Guarantee |
|---|---|
| `_depositableItems({reserve})` | decides *what* is depositable: tools and armour, a bucket, seeds, torches and portable stations, and `DEPOSIT_KEEP_RESERVE = 16` of every food stack stay in the pack. Wheat is **not** food for this purpose |
| `_depositTargetFor(item, {position, cachedOnly})` | decides *where*: a container that already holds that item scores `+100000`, then the distance, then the first reachable storage block. Only cached containers are used when the moment must stay cheap |
| `dump_inventory` | one bounded action (`DEPOSIT_MAX_STACKS = 8`) instead of a chore per item; it keeps the reserve and returns what it moved |
| `observe().deposit` | the same census, exposed to the controller: `{items, total, target, at}` — `storableStack` in `village-labor.mjs` reads *this* first and only falls back to its own family filter |

The container cache is updated from the **observed** contents plus the moved
count, accumulated across the stacks of one dump: the open-window slot mirror is
a photograph taken when the chest was opened, so recomposing the contents from
it after every stack used to erase the previous deposits from the cache (and
with them the "this chest already holds that item" score).

### Proof and limits

`tests/bedrock-storage.test.mjs` (51 tests) covers the keep list with its
reserve, the chest that already holds the item beating a nearer empty one, the
census exposed by `observe()`, a full dump (inventory, cache, request count and
`container_dump`) and the two clean failures (`nothing_to_deposit`,
`container_not_found`). `tests/village-labor.test.mjs` proves that the chore
follows the harness census (and that an empty census beats a full stack: the
harness is the arbiter). The integration case *"village labor: a finished
harvest walks what it gathered to the chest"* in `tests/controller-session.test.mjs`
asserts the whole chain: `harvest_crops` runs, then
`STORE EPILOGUE after gN -> village chore gN+1 [store_harvest]`, and the child is
persisted `completed` with `parameters.epilogueOf = gN`.

**Open.** The epilogue consolidates nothing: it walks to the best chest it knows
rather than spreading one item per chest. It stores raw produce only — smelting
first (ore, meat, charcoal) is M9. In one-shot mode the child stays queued and is
resumed with `RESUME=on`, and the M8 narration may (correctly) announce the
epilogue as its own goal.

## Roadmap milestones

The roadmap orders the work in nine milestones. Milestone 0 is the audit above
and milestone 1 (Agent Core) is implemented; the rest are design sketches, with
partial slices where noted (milestone 2 emergency, 3 autonomy, 4 greeting,
5/8 curiosity):

| # | Milestone | What it introduces |
|---|---|---|
| 0 | Lifecycle persistence | separate goal/connection lifecycle, idle state, new goal without reconnect, reconnect without losing agent state. ✅ session loop + `IDLE` (opt-in `SESSION=on`) + cross-session resume (`RESUME`, default on) |
| 1 | Agent Core | a **Goal Manager**: every activity is a `goal {id, type, source, priority, status, parameters, parentGoal, createdAt}` with status `PENDING/RUNNING/SUSPENDED/COMPLETED/FAILED` and sources `CHAT/AUTONOMOUS/WORLD_EVENT/PLAYER_BEHAVIOR/EMERGENCY/OPPORTUNITY`. Chat commands become goals, never raw primitives. ✅ `goal-manager.mjs` (persistence + preempt/suspend/resume + cross-session resume; producers: chat/curriculum/autonomy/opportunity — the last one not yet wired into the loop) |
| 2 | Emergency system | world events auto-create preempting goals — `PLAYER_DIED → RECOVER_PLAYER_LOOT (CRITICAL)` with loot priorities (netherite/diamond → enchanted → elytra → …) and risk awareness (lava/warden/nether). ◑ `PLAYER_DIED → recover_loot` implemented and **live-verified** (2026-10-02) (`world-events.mjs` + `emergency-goals.mjs`, opt-in default in session); see [emergency](emergency.md). Loot-priority executor, fluid/fire events and nested preemption still open |
| 3 | Autonomy | needs-driven idle behaviour (food low → find food; tool missing → craft; inventory full → store; night → shelter; else explore) via state + rules + utility score, **not** an LLM per decision. ◑ survival needs implemented (`idle-goals.mjs`, opt-in `AUTONOMY=on`); the inventory-full branch is implemented as the **store epilogue** (M3c, below); explore still open; the autonomous goal now announces itself in chat (M8, below) |
| 4 | Social behaviour | attention system (crouch/jump/stare/light hit → `PLAYER_REQUESTS_ATTENTION`) and contextual assistance (mining/fighting/building/fleeing/exploring → assist/observe/ignore). ◑ deterministic slice implemented: **proactive greeting** — a human perceived nearby is told the exact order syntax (`human-greeting.mjs` + `observe().humans` + `POST /say`, see [human-command](human-command.md)); the attention *events* (crouch/jump/stare/hit) are still open |
| 5 | World awareness | home system (bed/chest/furnace/table/storage/safe area) and world memory (resource spots, caves, villages, danger zones, structures, death locations). ◑ world memory implemented (`world-memory.mjs` + the mission/episode layer, see [memory](memory.md)); the **opportunity slice** — a valuable vein in sight suspends the goal and the bot takes the detour — is the deterministic curiosity step of this milestone (`ore-value.mjs` + [opportunity-goals.mjs](../../opportunity-goals.mjs), see [opportunity](opportunity.md)): detection + decision + option done, controller wiring pending |
| 6 | Advanced navigation | world-modifying pathfinding: bridge, pillar, dig tunnel, safe descent, break obstacle. |
| 7 | Planning | hierarchical goals with prerequisites and subgoals (e.g. `FIND_DIAMONDS → iron pickaxe → iron → smelt → …`), failure recovery. |

[`raw/GOAL_ACHIEVEMENT_MINECRAFT.txt`](../raw/GOAL_ACHIEVEMENT_MINECRAFT.txt)
sharpens milestones 1 and 7 with a **Goal Contract** (constraints + formal
`success`/`failure` + `RUNNING/SUCCESS/FAILED/BLOCKED`) and a task graph over
deterministic primitive skills, plus 5 progressive benchmarks; see
[goal-achievement](goal-achievement.md) for the mapping onto the existing
progression engine.
| 8 | Character | personality layer (curiosity/risk tolerance/…) that *modulates* the Goal Manager weights, plus a player model; last, after the rest is stable. ◑ curiosity exists today as a **deterministic gate**, not a weight: `opportunity-goals.mjs` decides from relative value, scarcity and interruptibility whether a sighting is worth a detour ([opportunity](opportunity.md)) |

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
- [goal-achievement](goal-achievement.md) — Goal Contract, task graph and progressive benchmarks.
- [open-questions](open-questions.md) — blockers and gaps.
