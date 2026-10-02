# Goal achievement (goal-driven agentic gameplay)

Topic: synthesis of the proposal in
[`docs/raw/GOAL_ACHIEVEMENT_MINECRAFT.txt`](../raw/GOAL_ACHIEVEMENT_MINECRAFT.txt) —
taking Hermes from bounded-action automation to **goal-driven gameplay**: the
user gives a game objective, and Hermes builds and executes the plan itself
(`goal → subgoal → action → verify → replan`), instead of Mineflayer-style
`goto/dig/craft` scripting.

Status: **proposal, partially seeded by existing code** — the deterministic
execution/verification half exists (progression graph, gameplay skills, verifier),
the Goal Contract and persistent Goal Manager do not. Related:
[ai-player-roadmap](ai-player-roadmap.md) (Goal Manager, suspend/resume),
[control-flow](control-flow.md) (goal → one action today),
[architecture-evolution](architecture-evolution.md) (subgoal / receding horizon),
[survival-intelligence](survival-intelligence.md) (progression + verifier).

## North star

> "Devin/Codex for Minecraft": the LLM chooses **strategies** over deterministic
> primitives, it does not pilot every movement. `/goal` becomes the main
> interface of the project.

The proposal deliberately avoids "finish Minecraft" as a first milestone — it
contains almost every hard problem at once — and starts from 5 progressive
benchmarks (below).

## Proposed pipeline

```
User Goal
   ↓
Goal Interpreter
   ↓
Planner            (Hermes)
   ↓
Task Graph
   ↓
Executor
   ↓
Minecraft Skills   (deterministic primitives)
   ↓
World State / Inventory / Events
   ↑
Verifier + Replanner
```

Example (`goal: "go to the Nether"`): `obtain(iron_ingot,3) → craft(bucket) →
obtain(water_bucket) → locate(lava_pool) → build_nether_portal() →
ignite_portal() → enter_dimension(nether)`, each node delegated to a skill.

## Goal Contract

The proposal's most concrete addition: a goal is a **structured contract**, not
just an objective string.

```json
{
  "goal": "obtain_diamonds",
  "target": { "item": "diamond", "count": 20 },
  "constraints": {
    "gameMode": "survival",
    "cheats": false,
    "maxDeaths": 2,
    "preserveItems": ["enchanted_diamond_pickaxe"]
  },
  "success": { "inventory.diamond": { ">=": 20 } },
  "failure": { "deaths": { ">": 2 } }
}
```

Status: `RUNNING | SUCCESS | FAILED | BLOCKED`. This is what lets the agent know
*when it is done*, *when to give up*, and *what must not be lost* — currently
missing (the controller stops on `GOAL MET`, a step budget, or an LLM judgement).

## Task graph, primitives and suspend/resume

- **Deterministic skill API** the task graph delegates to: `obtain_item`,
  `mine_block`, `craft_item`, `smelt_item`, `equip_item`, `find_structure`,
  `find_block`, `navigate_to`, `fight_mob`, `place_block`, `build_structure`,
  `sleep`, `eat`, `escape_danger`.
- **Interrupt / suspend / resume**: night falls during `BuildHouse` →
  `suspend(BuildHouse)` → `SurviveNight` → `resume(BuildHouse)`; on death →
  locate death → respawn → recover inventory → resume the original goal.
- **Semantic goals**: "a decent starter base" is translated by the LLM into a
  capability list (shelter, bed, crafting table, furnace, chest, food source,
  lighting, basic tools) and executed deterministically.
- **Layered architecture**: `Brain {Planner, Memory, Goal manager, Replanner}` /
  `Minecraft Adapter {perceive, move, interact, events}` / `Skills {navigation,
  mining, crafting, building, combat, survival}` — so the Bedrock transport can be
  swapped without rewriting the brain.

## Progressive benchmarks

| # | Benchmark | Maps to (existing) | Status |
|---|---|---|---|
| 1 | obtain 16 logs | `wood` milestone (`logs: 8`) | ✅ wood live; target 16 not run |
| 2 | build a shelter and survive one night | `first_night` (+ `emergency_shelter`) | ◑ shelter skill exists; full `CURRICULUM=first_night` not run |
| 3 | obtain an iron pickaxe | `iron_age` / `iron_tools` | ◑ iron + smelt live; full milestone not run |
| 4 | obtain 5 diamonds | `diamonds` (`diamonds: 1`) | ❌ not run; target 5 |
| 5 | build and cross a Nether portal | `enter_nether` | ❌ not implemented |

The 5 benchmarks are intentionally seed-independent: passing #5 from a random
spawn with no per-seed script would already be a credible milestone.

## Relationship to what exists

- **Progression engine** (`survival/progression.mjs` + `knowledge/progression.json`)
  is the deterministic *seed* of the proposal's Task Graph: milestones with
  `requires`, `skill`, `satisfiedWhen`; `CURRICULUM=<milestone>` already routes a
  goal with Hermes as fallback.
- **Gameplay skills + verifier** (`skills/gameplay/**`, `survival/verify.mjs`) are
  the execution/verification half: data, not code; success read from harness data.
- **`/plan` + the `plan` object** hold a shallow objective/waypoint/targets —
  no Goal Contract, no constraints, no task graph.
- **Chat channel** (`human-command`) routes NL → Hermes → `/plan`, i.e. the
  "chat → goal, never raw primitives" principle is partially real.
- **AI-player roadmap** milestones 1 (Goal Manager) and 7 (hierarchical
  planning) are exactly the persistent/task-graph layer this proposal needs;
  suspending to survive the night / recover loot is its milestone 2.
- The **harness HTTP API** (`/observe` `/options` `/act` `/plan`) is the Bedrock
  analogue of the Java 1.21.9 JSON-RPC/WebSocket server channel the proposal
  mentions — a second, out-of-world channel for Hermes (Bedrock has no cheats).

## Gaps, risks and contradictions

- **`goals.beat_the_dragon` (resolved)**: it used to be aliased to
  `enter_nether`. The graph now has the real chain
  `nether_portal → enter_nether → nether_survival → {piglin_barter,
  obtain_blaze_rods, obtain_ender_pearls} → craft_eyes_of_ender →
  find_stronghold → enter_end → beat_the_dragon`, and `goals.beat_the_dragon`
  points to `beat_the_dragon`. The *capabilities* behind those milestones are
  still not implemented (see [nether](nether.md)).
- **No Goal Contract in code**: no constraints (`maxDeaths`, `preserveItems`), no
  formal success/failure expression; a goal is a string + a step budget.
- **No persistent Goal Manager / task graph**: `controller.mjs` is one-shot
  (`process.exit(0)`), see [ai-player-roadmap](ai-player-roadmap.md#milestone-0--lifecycle-audit-result).
- **No first-class semantic-goal interpreter**: Hermes emits a shallow `plan`;
  there is no capability list derived from an NL goal as a reviewable artifact.
- **Benchmarks 1–5 not run end-to-end**, and target counts differ from the
  current milestone thresholds (8 vs 16 logs; 1 vs 5 diamonds).
- The proposal's primitive vocabulary (`obtain_item`, `build_structure`, ...)
  largely overlaps the existing intent/action vocabulary and gameplay skills;
  normalizing them is design work, not greenfield.

## Proposed workstreams (complementary to the AI-player milestones)

| # | Workstream | Deliverable | Depends on |
|---|---|---|---|
| G1 | Goal Contract | JSON schema + status machine (`RUNNING/SUCCESS/FAILED/BLOCKED`), `success`/`failure`/`constraints` evaluable on `/observe` | AI-player M1 |

**G1 thin slice — implemented.** `survival/goal-contract.mjs` (`normalizeContract`,
`evaluateContract`, `contractFromEnv`, `hasContractConfig`), exported through
`survival/index.mjs`, wired into `controller.mjs`: opt-in via `GOAL_CONTRACT`
(JSON) + `MAX_DEATHS` + `PRESERVE_ITEMS`; the controller logs `goal_contract` /
`goal_contract_met` / `goal_contract_stop` and stops on
`SUCCESS`/`FAILED`/`BLOCKED`. New verifier criteria `deathsAtLeast` and
`itemPreserved`. 18 unit tests (`tests/goal-contract.test.mjs`). Still missing:
the persistent Goal Manager / queue (AI-player M1), a `target`-driven
`obtain_item` executor, and the semantic-goal interpreter (G4).
| G2 | Primitive vocabulary | Normalize the proposal's skill API onto the existing intents/actions/gameplay skills | — |
| G3 | Task graph | Merge the progression graph with sub-goal nodes + prerequisites; keep deterministic resolution | AI-player M7 |
| G4 | Interpreter | NL goal → capability list (shelter/bed/table/...) as a Hermes artifact, then deterministic execution | human-command |
| G5 | Constraints & recovery | `maxDeaths`, `preserveItems`, failure → replan; unsafe-goal refusal | AI-player M2 |
| G6 | Benchmarks | The 5 benchmarks as `CURRICULUM` goals, verified live on the real BDS | G1–G4 |

## How to fill the missing agentic meta (concrete plan)

The proposal's meta layer is missing, but the deterministic half already exists.
The shortest path is to **wrap**, not rewrite:

1. **G1 — Goal Contract as a thin object around `plan`.** Add a
   `knowledge/goal-contracts.json` (or a `goalContract` field on the plan) with
   `target`/`constraints`/`success`/`failure`, and evaluate them with the
   existing `evaluateCriteria` + `evaluateCondition` vocabulary. New criteria
   needed: `deathsAtLeast`, `itemPreserved`, `bossDefeated`.
2. **G2 — Reuse the existing vocabularies.** The proposal's `obtain_item`,
   `mine_block`, `craft_item`, `navigate_to`, ... already exist as `/options`
   keys + intents + gameplay skills; normalize the names instead of adding a
   parallel API.
3. **G3 — Task graph = progression graph + `subgoal`.** `resolveMilestone`
   already walks prerequisites; add subgoal rotation (receding horizon) rather
   than a new planner. See [architecture-evolution](architecture-evolution.md).
4. **G4 — Interpreter as a Hermes artifact.** For a semantic goal, Hermes emits
   a capability list that must **resolve to existing milestones/skills**; if a
   capability has no milestone, the goal is `BLOCKED`, not hallucinated.
5. **G5 — Constraints & recovery in the controller.** Enforce `maxDeaths` and
   `preserveItems`; on failure mark the contract `FAILED` and replan; the
   governor keeps preempting (it already does).
6. **G6 — Persistence.** The Goal Manager itself is AI-player milestone 1
   (queue + `IDLE`/`GOAL_RUNNING`/`SUSPENDED`). Until then, benchmarks run as
   one-shot `CURRICULUM` rounds — which is enough to *measure* capability.

## How to execute the unexecuted benchmarks

Each benchmark is already a `CURRICULUM` goal; the gap is capability + a live
round, not new orchestration:

```bash
# against the running harness (one bot account: stop the container first)
RUN_ID=bench1 MAX_STEPS=200 CURRICULUM=first_night \
  OPENROUTER_API_KEY=... node controller.mjs
```

| Benchmark | Command (`CURRICULUM=`) | Prerequisite capability | Blocker |
|---|---|---|---|
| 16 logs | `wood` | `mine_*`/`collect_drop` | only target count (8 → 16) |
| shelter + night | `first_night` | shelter building | no wall/shelter actions beyond `barricade`/`dig_down`; `sleep` is not live |
| iron pickaxe | `iron_age` | smelting + tools | `eat`/long-run durability not live; full run not done |
| 5 diamonds | `diamonds` | mining | target count (1 → 5); live round |
| Nether portal | `enter_nether` | portal actions | `enter_nether` not implemented (see [nether](nether.md)) |

The honest measurement today is **steps to `GOAL MET`** per benchmark; the
sub-goal is to lower it without per-seed scripting.

## Related pages

- [ai-player-roadmap](ai-player-roadmap.md) — persistent agent, Goal Manager, suspend/resume.
- [control-flow](control-flow.md) — how a goal reaches one bounded action today.
- [architecture-evolution](architecture-evolution.md) — subgoal / receding-horizon planning.
- [survival-intelligence](survival-intelligence.md) — progression graph, skills, verifier.
- [human-command](human-command.md) — chat → goal channel.
- [roadmap](roadmap.md) — consolidated implementation status.
- [fluids](fluids.md), [redstone](redstone.md) — capability roadmaps the task graph will call into.
