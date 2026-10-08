# Reasoning roadmap — a semantic layer over Jev, corrected against the code

Synthesis of [`docs/raw/ROADMAP_refactoring_reasoning.md`](../raw/ROADMAP_refactoring_reasoning.md),
which supersedes two Italian drafts written without reading the repository
([`roadmap_reasoning_avanzato.md`](../raw/roadmap_reasoning_avanzato.md) and
[`clarification_missing_information_phase.md`](../raw/clarification_missing_information_phase.md)).
This page records what the drafts got wrong, what is real, and the resulting plan.

## The drafts' central fiction

Both drafts assume a **semantic compiler**: human request → LLM parse →
`CapabilityPlan` IR → **MCP** validation → typed capability invocations on Jev. Two
load-bearing pieces of that do not exist anywhere in the repo:

- **No MCP.** It is not a dependency, not a server, not an identifier outside the
  two drafts (`grep -rl "MCP"` matches only them, plus a transitive
  `package-lock.json` entry).
- **No `CapabilityPlan` / `CapabilityRegistry`.** The closest real IR is the union
  of a skill definition (`skills/gameplay/**`), a progression milestone
  (`knowledge/progression.json`) and a circuit blueprint (`circuits/*.json`).

Other corrections: the four roles are not Hermes = planner / MCP = contracts /
Jev = missions / bedrockflayer = actuation. Hermes is a **strategic replanner**
(one shallow JSON plan, re-invoked per replan event — see
[architecture-evolution](architecture-evolution.md)); Jev picks **one** bounded
action from `/options`; actuation is `bedrock-adapter.mjs`, a bedrock-protocol
client, not `bedrockflayer`. And `ragiona` (M12) is **deployed but is an answer
marker, not a planner**: it is stripped before the dedup key and the question
router, changes how a *question* is answered, and on an order routes nothing new.

The drafts' two clarification examples are also wrong for this codebase:
«portami del cibo» and «metti il ferro nel baule» with several chests are already
resolved **deterministically** (food policy; `_depositTargetFor` scores a container
that already holds the item `+100000`, then distance), and asking would violate the
repo rule "deterministic before the prompt".

## The real pipeline

Human chat order → `humanCommandPlan` (`controller.mjs:911`): deterministic
short-circuits first (`isDropOrder`, farm, `isCollectOrder`, `isEquipOrder`,
stop), otherwise `runHermes` returning **only** a shallow JSON
`{objective, targets, waypoint, follow, notes}` → controller plan/goal → skill
resolver + progression (`nextMilestone`) → harness `/options` (authoritative) →
Jev picks one key (`jevDecide`) → `/act` → adapter. `CURRICULUM=<goal>` replaces
the Hermes call with a deterministic plan via `planFromMilestone`.

## What the drafts got right

- `/options` remains the only source of valid keys (A §40).
- Invariants: never invent primitives or coordinates without evidence, never call
  `/act` or the actuation layer from a model, never duplicate recipe/pathfinding/
  mission logic, one world memory (A §57/§58).
- Extend existing structures, never build a parallel architecture (A §64).
- A clarification decision is genuinely missing, and its ordering principle —
  "resolve before asking" — is correct (B).

## Roadmap

Namespaced `R0`…`R7` to avoid colliding with the repo's own M1–M12 chat milestones.

| Milestone | What | Status |
|---|---|---|
| **R0** Capability inventory | One command emits a machine-checkable inventory of intents, option vocabulary, skills, circuits, milestones, criteria, and the cross-checks between them (`tools/capability-inventory.mjs`) — the drafts' "registry" with the MCP fiction removed | **implemented** |
| **R1** Typed plan | Add `plan.subgoal` + `plan.steps[]` (each naming a skill/circuit + its verify criteria), derived from the declarative files; exactly one level above actions ("Evolution A") | **implemented** |
| **R2** Clarification gate | Wrap `humanCommandPlan`: `orderGaps(text, plan, obs, {memory})` → `ready` \| `needs_input`; ask one question, hold the order, resume on the same sender's answer. Behind `CHAT_CLARIFY` | proposed |
| **R3** Plan trace | One structured `plan_trace` line per decision (objective, subgoal, source, steps, action, refusals, replan reason). Never chain-of-thought | proposed |
| **R4** Structured failure | Harness refusal → typed `{step, error, evidence, retryable}`; a step revises its own steps instead of only a global replan | proposed |
| **R5** Composite goals | `prepare_for_nether` as a DAG over existing milestones, expanded deterministically | proposed |
| **R6** Golden scenarios | Order + observation → expected plan/clarification/refusal, including the C17/C18 negative cases; freezes R1–R5 | proposed |
| **R7** (conditional) contracts over a process boundary | Only if a second consumer appears; MCP explicitly deferred to avoid a second source of truth | deferred |

### The plan shape (R1)

Hermes still emits a flat JSON; the shape is *derived* from the declarative
artifacts by a pure module, so the decomposition stays data and no step ever names
an action key:

```text
        PLAN IN (flat)                        DERIVATION SOURCES
+---------------------------------+
| { objective, targets, waypoint, |   plan-shape.mjs    <- skills/gameplay/**  (description,
|   follow, skill, subgoal? }     |   (pure, additive)  <-   success criteria -> verify)
+----------------+----------------+                     <- circuits/*.json    (success.circuitBuilt.id)
                 |                                      <- progression.json   (milestone -> subgoal)
                 v                                      <- CRITERIA_KEYS      (verify filter)
        plan.subgoal <- skill.description | plan.subgoal | milestone | objective
        plan.steps[] <- { id, skill, circuit, targets, verify }
                 |
                 v
        PLAN OUT (shaped, goal.plan)
```

Properties, all covered by `tests/plan-shape.test.mjs`: `verify` is always a
subset of `CRITERIA_KEYS`; a step's keys are exactly
`{id, skill, circuit, targets, verify}`; a producer that already set
`subgoal`/`steps` wins; the `{met: true}` sentinel is untouched; a replan keeps
`objective` (the controller holds it) and rotates `subgoal`.

## Real capability surface (the R0 input)

| Layer | Artifact | Count (07/10/2026, from the R0 inventory) |
|---|---|---|
| Intents | `INTENTS` in `survival/intents.mjs` | 23 |
| Option-key → intent | `KEY_INTENTS` + `PREFIX_INTENTS` (`optionIntents`) | 62 keys + 8 prefixes |
| Gameplay skills | `skills/gameplay/**/*.json` (`loadGameplaySkills`) | 41 in 6 domains |
| Circuit blueprints | `circuits/*.json` (`loadCircuits`) | 8 (2 orphans) |
| Milestones | `knowledge/progression.json` | 23 |
| Goals | `knowledge/progression.json` | 8 |
| Criteria | `CRITERIA_KEYS` (`survival/verify.mjs:372`) | 28 |

The inventory's first run has **zero errors** and one real finding: `auto_door` and
`delay_line` are buildable blueprints that no skill/milestone claims (`orphan_circuit`).

## Open questions

Carried from the raw doc §9: whether a held (clarifying) order suspends the
running goal; how to expose multi-branch progression without breaking
`resolveMilestone`'s single-`next` contract; whether `CHAT_CLARIFY` stays opt-in;
whether the R0 inventory belongs in CI. **R1 answered the `subgoal`
verification question**: it is verified by the skill's own `success` criteria
(filtered to `CRITERIA_KEYS`), so `verifySkill` is not duplicated and no second
per-subgoal criterion exists.

New from R0: should `auto_door` and `delay_line` be wired into a milestone (a skill
whose `success.circuitBuilt.id` names them), or are they deliberately unused
blueprints? The inventory reports them as orphans on every run until one of the two
is true.
