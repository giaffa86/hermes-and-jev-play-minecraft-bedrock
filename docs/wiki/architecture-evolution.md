# Architecture evolution (design thesis)

Topic: why the current three-way separation is the project's core strength, how
to *name* it precisely, and the two smallest evolutions that would strengthen
Hermes' strategic horizon without turning it into a classical hierarchical
planner. This page records the reasoning and the open design questions; it does
**not** describe implemented behaviour (that is
[control-flow](control-flow.md)).

## The four roles, cleanly separated

A common failure mode of Minecraft agents is to load all of this into one LLM.
Here it is split into four responsibilities:

| Layer | Answers | Owner |
|---|---|---|
| Progression Engine | "What comes **next** in the tech tree?" | `knowledge/progression.json` + `survival/progression.mjs` (deterministic) |
| Hermes (System Two) | "What is **worth pursuing now**?" | `hermesPlan` in `controller.mjs` (LLM) |
| Harness | "What can I **actually do now**?" | `bedrock-harness.mjs` `/options` (deterministic) |
| Jev (System One) | "What **action** do I take now?" | `jevDecide` in `controller.mjs` (LLM, one bounded action) |

Emergent behaviour is the product of all four, not of any single planner:

```
Hermes objective  +  progression graph  +  skill contracts
     +  harness affordances  +  Jev repeated decisions
          →  emergent behaviour
```

## Rename: System Two = strategic replanner, not hierarchical planner

"Planner (System Two)" is conceptually right but over-credits Hermes. Hermes does
**not** do hierarchical decomposition of the classic kind:

```
goal → subgoal → subgoal → action        ← NOT what Hermes does
```

Hermes maps `state → next strategic objective` (one shallow JSON plan). The
missing hierarchy level is *deliberate*: it is exactly what keeps the system
reactive to the real world instead of locked into a precomputed script
("1. find tree → 2. walk → 3. mine → 4. craft …" would destroy the architecture's
strongest property). So the accurate label is **strategic replanner**: Hermes is
re-invoked on replan events (`skill_complete`, `skill_failed`, `anti_loop`,
periodic `REPLAN_EVERY`) and looks slightly further ahead than Jev, committing
only to the next chunk.

## What already exists vs what is proposed

| Concept | Status today | Proposal |
|---|---|---|
| A subgoal/chunk level | **Partially.** In curriculum mode `planFromMilestone` sets a `milestone` field and `resolveMilestone` advances to the next missing prerequisite. In free-goal mode only the optional `skill` field exists; there is no first-class `subgoal`. | Make `subgoal` a first-class plan field in free-goal mode (see below). |
| Receding-horizon planning | **Partially.** The replan loop already re-invokes Hermes per chunk. But each free-goal replan re-derives from `GOAL`; the objective is not held stable while only the chunk rotates. | Hermes keeps `objective` stable and rotates `subgoal`/`targets`/`skill` per replan. |
| Multi-branch progression | **Not present.** `requires` is an array (a DAG, diamonds allowed), but `resolveMilestone` returns a single deterministic `next` (DFS first-hit). No OR/alternative-path semantics; `goals` maps each goal to one milestone. | Add branch nodes / OR-requirements so the engine exposes candidate branches and Hermes picks one. |

## Evolution A — a single intermediate decomposition level

Add exactly **one** level between objective and actions, in free-goal mode, by
promoting the existing `skill`/`milestone` machinery into an explicit `subgoal`
field. Hermes would move from:

```json
{ "objective": "Obtain enough iron for an iron pickaxe",
  "targets": { "iron_ingot": 3 } }
```

to:

```json
{ "objective": "Obtain enough iron for an iron pickaxe",
  "subgoal": "Acquire raw iron",
  "targets": { "raw_iron": 3 },
  "skill": "mine_iron" }
```

and, at the next replan:

```json
{ "objective": "Obtain enough iron for an iron pickaxe",
  "subgoal": "Smelt collected raw iron",
  "targets": { "iron_ingot": 3 },
  "skill": "smelt_iron" }
```

This is **not a precomputed plan**. It is *receding-horizon planning*: Hermes
looks a little further ahead than Jev, but still commits only to the next chunk,
so the system keeps reacting to the real state of the world. Note that the skill
contracts already carry the per-chunk `success` criteria, so `verifySkill` would
verify each subgoal deterministically as it does today — the new field mostly
makes the *intent* explicit and stable across replans.

## Evolution B — multi-branch progression graph

Modern Minecraft makes the deterministic layer richer without loading the LLMs
(e.g. Java 1.21.9 copper tools: faster/durable than stone, same damage). The
progression graph can grow from a single rigid chain into alternative paths, and
that is precisely where "System Two" earns its name:

```
                  ┌─ copper path ─────┐
wood → stone ─────┼─ iron path ───────┼─► objective
                  └─ exploration path ┘
                           ▲
                           │
                        Hermes
              chooses strategy from current state
```

The split becomes: the **Progression Engine defines what is possible** (nodes +
dependencies), **Hermes chooses which branch to pursue** dynamically from the
state, the **skills translate the branch into affordances/intents**, and **Jev
stays one-action-at-a-time**. This requires the engine to grow a
branch-exposure mechanism: `resolveMilestone` today returns one `next`; it would
need to return *candidate branches* plus a hook for Hermes to score them (state →
branch choice).

## What must stay fixed

- **Jev remains rigidly one-action-at-a-time.** The asymmetry
  (replanner with a slightly wider horizon / actor with none) is the point.
- **Harness owns validity.** No subgoal or branch ever invents an action key.
- **Deterministic before the prompt.** The graph and skill contracts keep
  encoding mechanics; Hermes encodes *strategy only*.

## Open questions

- **Plan schema**: add `subgoal` (string) + keep `skill` + `milestone`? Or reuse
  `milestone` for free-goal mode too? Where is `subgoal` verified — by the skill's
  `success` criteria, or by a separate per-subgoal criterion?
- **Objective stability across replans**: how does the controller know a replan is
  "advance the subgoal" vs "abandon the objective"? A cheap heuristic (Hermes
  re-emits the same `objective` + a new `subgoal`) vs an explicit `objectiveId`?
- **Branch semantics**: `requires` needs OR-nodes (`anyOf` of prerequisite sets)
  or dedicated branch nodes. How does `resolveMilestone` expose candidates without
  breaking the current single-`next` contract and its tests?
- **Branch scoring**: what state feeds Hermes' branch choice (inventory, time
  budget, nearby resources, biome)? Deterministic pre-filter + LLM pick, or pure
  LLM?
- **Copper path data**: which Minecraft version is the *Bedrock* target actually
  on? The copper-tool example is Java 1.21.9; Bedrock parity must be confirmed
  before encoding it in `knowledge/progression.json`.

## Sources

- `controller.mjs` — `hermesPlan`, `planFromMilestone`, replan loop, `goalMet`.
- `survival/progression.mjs`, `knowledge/progression.json` — the graph and the
  single-`next` resolver.
- `skills/gameplay/**/*.json` — the existing per-chunk skill contracts.
- Related wiki: [control-flow](control-flow.md),
  [survival-intelligence](survival-intelligence.md),
  [open-questions](open-questions.md).
