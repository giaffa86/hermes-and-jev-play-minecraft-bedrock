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
| **R2** Clarification gate | Wrap `humanCommandPlan`: `orderGaps(text, plan, obs, {memory})` → `ready` \| `needs_input`; ask one question, hold the order, resume on the same sender's answer. **Design decided 07/10/2026**: the pending question lives in the harness-side inbox (`chatInbox`), not in the controller, and an under-specified order never becomes a goal (so no running goal is suspended). `CHAT_CLARIFY` **default on**, kill-switch `off` | **implemented** |
| **R3** Plan trace | One structured `plan_trace` line per decision (objective, subgoal, source, steps, action, refusals, replan reason). Never chain-of-thought | **implemented** — one line per plan *segment* in `runs/<run>/plan-trace.jsonl`, written by the controller |
| **R4** Structured failure | Harness refusal → typed `{step, error, evidence, retryable}`; a step revises its own steps instead of only a global replan | **implemented** — the step is the unit: `retry` retries, `switch` drops the key and republishes `steps[].refused`, `replan` fails the step |
| **R5** Composite goals | `prepare_for_nether` as a DAG over existing milestones, expanded deterministically | **implemented** — a goal may name a **list** of milestones; `milestoneChain` returns the missing closure in dependency order and the plan carries it in `steps[]` |
| **R6** Golden scenarios | Order + observation → expected plan/clarification/refusal, including the C17/C18 negative cases; freezes R1–R5 | **implemented** — nine scenarios in `tests/golden-scenarios.test.mjs`, driven against a scripted harness and asserted on the **R3 trace**; found and fixed a real bug (the `SIGTERM` handler died on a `ReferenceError`) |
| **R7** Capability contract | R0's inventory as a **versioned, self-describing, consumer-validatable** contract (`capability-contract.mjs`), carried over the harness's existing HTTP boundary (`GET /capabilities`). MCP and any registry service stay non-goals: the contract is a read-only *projection*, never a second source of truth | **implemented** — `contractVersion` + `contentHash` + `valid`/`problems` + the frozen key set; `checkCapabilityContract` is the consumer's handshake; `npm run capabilities:check` is the offline gate |

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

### The clarification gate (R2)

An under-specified order is not planned on a hunch: the gate runs on the *decided*
plan, and only two gaps exist — a movement verb with no destination anywhere, and a
place name the world memory does not know.

```text
  ORDER IN "@bot vai"                    human-clarify.mjs (pure, no I/O)
     |                                    YES  dest. verb at all?
     +--> humanCommandPlan    --> plan    YES  plan has waypoint/escort, or is another order?
     |      (deterministic,              YES  follow verb / "here" / explicit coordinates?
     |       else Hermes)                YES  "vai a dormire" (activity after vai a …)?
     |                                   YES  the place is in memory (memory down -> open)?
     +--> orderGaps(text, plan, obs)     YES  an object a partitive names ("portami DEL cibo")?
          |
          +-- ready       -> goal (exactly as before)
          +-- needs_input -> POST /chat/ask
                              inbox: pending[from] = { orderId, from, question,
                                                       originalText, field, reason, askedAt }
                              one chat line: "@Ale dove vuoi che vada?"
                              (NO goal is created)

  NEXT ADDRESSED MESSAGE, SAME SENDER -> the inbox stamps `clarifies` ONCE
          +-- the reply is itself an order ("vai al mulino", "fermati")?
          |      -> it REPLACES the held order (a stop always wins)
          +-- otherwise -> merged: "vai" + "coordinate 120 64 -230" -> the planner
                 still not enough -> a typed refusal, never a second question
```

Properties, covered by `tests/human-clarify.test.mjs` (13),
`tests/bedrock-chat-ask.test.mjs` (6) and `tests/controller-clarify.test.mjs` (5):

- The refusal is reached when a reply does not close the gap: **one question per
  order**, then a typed no (`clarify_refusal`), never a question loop.
- The answer is still an **addressed** message (`@bot coordinate 120 64 -230`): the
  prefix gate runs first, so the pending question does not open a second,
  unaddressed channel — it only supplies the *context* of the reply.
- The decoration is a **hint**: the controller discards the held order when the
  reply is a complete order of its own (`restatesOrder`, stop, drop, collect,
  equip, farm).
- The small-talk branch is skipped while a question is pending, because the closed
  `SMALL_TALK` list contains exactly the confirmation shapes («va bene»,
  «perfetto», «ottimo»).
- The raw reply is offered to the told-fact handler (M10) *alone*, so «l ingresso
  ora è a 130, 62, -240» stays a told fact; the merged text is what the planner
  sees.
- In the adapter the record is stored under both the gamertag and the xuid, is
  consumed by exactly one later message from that sender, and expires at
  `CHAT_ASK_TTL_MS` (default `300000`, the same window as `CHAT_MAX_AGE_MS`), so it
  also survives a controller restart.
- Fail-open: if the place memory is unavailable the gate does not ask.
- Known limitation: a destination that *contains* an item word and is not in memory
  («vai al campo di patate») is read as an object order and never asked about.

### The plan trace (R3)

A run already proved *what* it did (`actions.jsonl`) and *what it cost*
(`summary.json`, `run-facts`). R3 adds *why the plan changed*: one JSON line per
plan **segment** — opened when the controller adopts a plan, closed when that plan
is replaced or the run ends — in `runs/<run>/plan-trace.jsonl`.

```text
  plan born                        plan replaced / run ends
  ---------                        ------------------------
  planForStep  ---> curriculum | construction      \
  hermesPlan   ---> hermes      (+ fallback)        >-- plan.source stamps the plan
  humanCommandPlan | told_goto -> deterministic     /

  planTrace.adopt({step, reason, plan})   <-- per ogni adozione
        |  planTrace.record({step, key, by, reason, ok, error, ms})   <-- per ogni azione
        v
  runs/<run>/plan-trace.jsonl
  { v:1, planId, reason, source, objective, subgoal, steps[], stepCount,
    startedAt, endedAt, ms, endedBy, untilStep, actions, ok, failed,
    decisions[], refusals[], omitted }

  endedBy = replaced | human_order | human_order_override
          | replan:<skill_failed|anti_loop:<key>:<n>|skill_complete|periodic|curriculum>
          | goal_met | goal_met:<reason> | run_end | goal_end | signal:<SIG>
```

Properties, covered by `tests/plan-trace.test.mjs` (9) and by a 6th test in
`tests/controller-clarify.test.mjs` that drives the **real controller** and reads
the file back:

- The line answers the three questions a post-mortem asks — *which plan, where it
  came from, why it stopped* — without joining `controller.jsonl` to
  `actions.jsonl` by hand.
- **A missed flush loses nothing**: `adopt()` closes an open segment by itself, and
  `flush()` is idempotent, so the worst case is a segment spanning two plans.
- **The vocabulary of `source` is closed** (`hermes`, `deterministic`, `curriculum`,
  `construction`) and a value from outside it (e.g. the governor's
  `'governor:normal'`) reads back as `hermes`.
- **It is not a chain-of-thought**: no prompt, no model text, no free prose —
  identifiers, keys and typed errors only.
- **It cannot break a run**: a write error is swallowed and logged once as
  `[plan-trace] write failed:`; there is no env flag to disable it.
- Honest limit: a goal the goal contract closes before any plan is *published*
  leaves no line — there was no plan to trace.

### Structured failure (R4)

A refusal used to be a string in a log line, and the only reaction was a global
replan. R4 makes the refusal a **typed fact about the step that suffered it**, so
the step can retry, change approach, or fail — and say which one it did.

```text
  /act key  --{ok:false, error:'no reachable iron_ore found nearby'}-->
        |
        v   step-failure.mjs (pure, no imports; vocabulary closed & ordered)
  classifyFailure(error) -> { kind, retryable }
     busy | timeout | transient | moved        -> retryable
     blocked                                    -> switchable
     refused | prerequisite | unknown           -> terminal
        |
        v   failureDisposition(record, {attempts, maxAttempts: 2})
  retry  -> nothing changes            (same key, plan untouched)
  switch -> exclude the refused key    + revise & publish steps[].refused
  replan -> pendingStepReplan = 'step_failed:<error>'  (the step fails)
```

Properties, covered by `tests/step-failure.test.mjs` (11),
`tests/controller-step-failure.test.mjs` (2, the real controller on the wire) and
`tests/plan-trace.test.mjs` (+2):

- **The vocabulary comes from the harness, not from imagination**: the case table is
  built from the real refusal strings of `bedrock-adapter.mjs` (`no reachable <ore>
  found nearby`, `<x>_timeout`, `<x>_refused`, `<target>_gone`, `no_safe_cell`,
  `not_diggable_*`, `missing_<item>`, …). The rule order is load-bearing:
  `timeout` before `refused`, `moved` before `blocked`, `blocked` before
  `prerequisite`.
- **An error outside the vocabulary is `unknown` and terminal** — never guessed
  retryable. Safety over progress, in the one place where guessing would loop.
- **The evidence is bounded**: position, dimension, targets, `ms` and the small
  extra fields of the result; a field whose JSON exceeds 200 characters is dropped,
  so a refusal never dumps the world into a log line.
- **The step is the unit**: attempts are counted per `activeStepId(plan)` (the step
  whose `skill` matches `plan.skill`, else the first), and `reviseSteps()` returns a
  *new* plan with `refused {step, error, kind, retryable, at, alternatives}`,
  `refusalCount` and the last 4 revisions — the plan is never mutated in place.
- **The alternative is derived, not guessed**: `siblingKeys` returns the offered
  keys sharing an intent with the refused one (`optionIntents`), never the key
  itself — `mine_iron_ore` → `mine_deepslate_iron_ore`, `mine_diamond_ore`. They are
  *recorded* in the revision; the choice is still Jev's on the reduced option list.
- **A switch must not close its own door**: only the refused key is excluded (a
  first version also excluded the alternatives, making the switch impossible).
- **A retry decides nothing**: no exclusion and no plan revision — otherwise the
  retry would not exist and the plan would churn on a transient.
- **The reason survives the iteration boundary**: `step_failed:<error>` travels in
  `pendingStepReplan` (declared outside the loop) because `replanReason` lives
  inside one iteration, and it is consumed *before* the anti-loop block so the
  precise reason is not overwritten by `anti_loop:*`.
- **The type reaches the files**: the refusal carries `kind`/`retryable`/`stepId`
  in `plan-trace.jsonl`, `summarizePlanTrace` counts `refusalsByKind`,
  `run-facts` prints `tipi: blocked=2, prerequisite=1`, and `buildSkillRecord()`
  records the `failure` that failed the skill.
- **The regression that shaped it**: `player_not_found` was `unknown` → a replan
  while a follow order was open, in a path that is deliberately deterministic. A
  human who walks away is a **moved target**, so `moved` covers `*_not_found` and a
  retryable refusal never touches the plan.
- Honest limit: a step that needs a different *kind* of approach (not a sibling
  mode of the same intent) still ends in a replan.

### Composite goals (R5)

A curriculum goal could only be **one** milestone, so "get ready for the Nether"
had to be expressed as one of its pieces. R5 lets a goal name a **list** of
milestones and hands back the whole missing closure, in dependency order.

```text
  "prepare_for_nether": ["enter_nether", "nether_survival"]   <-- data, not code
        |
        v   survival/progression.mjs
  milestoneChain(graph, {goal, observation, completed})
     chain = wood -> crafting_table -> stone_tools -> iron_age
             -> diamonds -> nether_portal -> enter_nether -> nether_survival
             (topological, stable; a satisfied node and its subtree are skipped)
     steps[] = { id, milestone, skill, description, requires, missing, verify }
        |
        v   controller.mjs / planFromMilestone
  plan.steps = the whole missing chain   (plan.skill = chain[0])
  the chain is re-derived after every milestone that closes  ->  it shortens itself
  the goal closes when EVERY target is satisfied (not when one is)
```

Properties, covered by `tests/progression.test.mjs` (+5) and by a 4th test in
`tests/controller-curriculum.test.mjs` that drives the **real controller** against a
scripted world:

- **A composite goal is data**: an array in `goals` (`knowledge/progression.json`),
  no new milestone, no new engine. `validateProgression` checks every element and
  rejects an empty list, so a typo fails at load, not at run time.
- **The single-`next` contract survives**: `resolveMilestone` answers exactly as
  before for a simple goal (the `next`/`milestone`/`skill` triple its own suite
  pins) and now also carries `targets`/`chain`/`steps`. `prepare_for_nether` from
  an empty inventory still says `wood` — the composite goal changes the goal, not
  the first step.
- **`met` means *all* the targets**: a milestone satisfied by the world (e.g.
  `enter_nether` once the dimension is `nether`) does not close a composite goal.
  On the wire: after `enter_portal` the third action succeeds and the run keeps
  going — `GOAL MET after 3 actions` never appears — and the fourth action closes
  `nether_survival`.
- **The plan declares the chain and shortens it by itself**: with an early-game
  inventory the four plans of the run carry `steps.length` = 4, 3, 2, 1, and
  `steps[0].id` is always the active milestone. The chain is recomputed from the
  observation at every replan, never copied forward.
- **A step carries the criteria the verifier will use**: `verify` is
  `criteriaNames(satisfiedWhen)` filtered on `CRITERIA_KEYS` (R1's closed
  vocabulary); `nether_survival`, which has no `satisfiedWhen`, carries an empty
  `verify` — it closes only through the verified skill.
- **`missing` is "what is missing now"**: the chain does not simulate the world, so
  a downstream step still lists the prerequisite that currently blocks it. No
  speculative inventory is invented to make the preview prettier.
- **`/options` is never bypassed**: the chain names skills and milestones, never
  keys; the controller still decides on the harness's keys, and the composite test
  asserts an action per stage offered by the scripted world.
- **The inventory tool learned it too** (`tools/capability-inventory.mjs`, R0),
  otherwise the R0 test would report a composite goal as a missing milestone.
- Honest limit: the composite goal chooses its **targets**, not a procedure. A
  capability that is not a milestone in `knowledge/progression.json` still cannot
  be composed.

### Golden scenarios (R6)

R1–R5 added structure; R6 is what keeps it. `tests/golden-scenarios.test.mjs` is a
suite of nine **scenarios** — an order text plus a scripted world in, an expected
plan shape / clarification / refusal out — driven against the **real controller**
over a scripted HTTP harness. No model, no Bedrock, ~15 s.

```text
  scenario row = { order: '@bot vai', world: {...}, env: {...}, expect: {...} }
        |
        +--> scripted harness  /observe /options /act /plan /say /chat/ask /memory/*
        +--> scripted planner  decision keys | the order's plan | SEED_PLAN
        |
        v   the real controller (subprocess, SIGTERM when the row says so)
  runs/<run>/controller.jsonl   +   runs/<run>/plan-trace.jsonl
        |
        v   checkRow(row, outcome)
  the assertion reads the TRACE, not the event: the segment whose objective
  matches the order, with source / subgoal / steps[0].id / targets / verify
```

The nine rows: **G1** a destination-less order asks once and creates no goal;
**G2** a place the memory knows is not asked about and the plan is
`source: 'deterministic'`; **G3** an unknown place asks about the *place*; **G4**
(C17) `ragiona portami del cibo` asks nothing and the marker never reaches the
planner; **G5** (C18) a two-chest deposit asks nothing; **G6** a stop is not a
follow; **G7** a blocked approach is a typed refusal inside the step and in the
trace; **G8** an ambiguous order asks and lets the goal work; **G9** a killed run
still writes its ledger.

- **The gate is the trace** (`runs/<run>/plan-trace.jsonl`, R3): one segment per
  plan, so a scenario asserts on `source`/`subgoal`/`steps`/`verify` as the
  controller really decided them. The event's `plan` is the goal's shared object
  and can be mutated afterwards; it is read only for what is *not* a property of
  the decision (the fields neutralised by a stop, G6).
- **The seed goal is unsatisfiable on purpose** (`SEED_PLAN.targets = { dirt: 99 }`):
  an order must arrive *while a goal runs*, which is the case the goal stack
  (`human_preempt` → child goal) is for. A satisfiable seed made the scenario
  depend on the polling race.
- **Stopping is part of the fixture**: `stopWhen` is a poll, and the harness counts
  the acts published **after** each plan (`planActs`/`actsAfterPlan`) — a SIGTERM
  sent the instant the plan is published kills the controller *before* it adopts
  the plan into the trace, and the trace only keeps closed segments.
- **It found a real bug**: the `SIGTERM` handler read two variables local to
  `runGoal` (`stepsUsed`, `totalCost`) and died of `ReferenceError` on every
  signal, so a killed run left no `run_end`, no cost and no trace — the opposite of
  what this wiki promised. The counters are now mirrored in a module-level
  `runProgress`; G9 asserts the ledger survives.
- **It found a second, smaller one**: the deterministic `told_goto` exit of
  `maybeHumanCommand` skipped `shapedPlan`, so a place the world memory already knew
  produced a plan with no R1 shape (a trace segment with `steps: []`, and R4 unable
  to attribute a refusal to it). It is shaped like every other plan now.
- **It does not duplicate R2's tests**: `tests/controller-clarify.test.mjs` drives
  the clarification lifecycle over several messages; the golden rows freeze the
  *outcome* of an order in one look, including the negative cases that must not
  ask.

### The capability contract (R7)

R7 was written as *conditional*: expose the R0 inventory as a validated contract over
an explicit transport, but only if a second consumer appears. The second consumer
still does not exist — so what was built is the **contract**, and the transport is the
boundary the project already has. No new process, no MCP, no registry: the contract is
a projection that is *derived* and *never written*.

```text
  knowledge/progression.json   skills/gameplay/**   circuits/*.json
        |                            |                    |
        +----------- buildInventory (R0) ------------------+
                             |
                             v
  capability-contract.mjs   contractVersion / contentHash / valid + problems / counts
        |                                   |
        |  GET /capabilities (bedrock-harness.mjs, read-only, memoised)
        |                                   |
        v                                   v
  checkCapabilityContract(payload)   npm run capabilities:check
  a consumer's handshake             the offline gate (exit 1)
```

- **The contract describes itself**: `contractVersion`
  (`CAPABILITY_CONTRACT_VERSION`), `contentHash` (SHA-256 over the canonicalised
  content — sorted keys, `generatedAt` excluded, so two reads of the same surface
  sign identically), `valid` + `problems` (R0's typed verdict, *carried* instead of
  hidden), `counts`, and the surface: `intents`, `optionVocabulary`, `skills`,
  `circuits`, `milestones`, `goals`, `criteria`.
- **The consumer validates, it does not interpret**: `checkCapabilityContract`
  never throws and refuses `not_an_object`, `missing_key`, `unknown_key`,
  `version_mismatch`, `hash_mismatch`, and `surface_invalid` — a contract the
  producer itself marked broken is not usable.
- **The shape is frozen** by `CAPABILITY_CONTRACT_KEYS`: adding a field to the
  builder fails `tests/capability-contract.test.mjs` until the key list and the
  version are bumped on purpose.
- **It adds no second source of truth**: the payload is a projection of the
  declarative files, read-only; the harness only reads it (`/options` stays the
  authoritative runtime answer). If a second consumer ever needs to *author* a
  capability or speak another language, the transport can move — MCP included —
  without moving the producer.
- **The honest residual**: the route is wiring, checked by reading. The harness
  starts its HTTP server only after the bot connects, so no offline test can reach
  `GET /capabilities`; what the tests cover is exactly what the route returns.

## Real capability surface (the R0 input)

| Layer | Artifact | Count (07/10/2026, from the R0 inventory) |
|---|---|---|
| Intents | `INTENTS` in `survival/intents.mjs` | 23 |
| Option-key → intent | `KEY_INTENTS` + `PREFIX_INTENTS` (`optionIntents`) | 62 keys + 8 prefixes |
| Gameplay skills | `skills/gameplay/**/*.json` (`loadGameplaySkills`) | 41 in 6 domains |
| Circuit blueprints | `circuits/*.json` (`loadCircuits`) | 8 (2 orphans) |
| Milestones | `knowledge/progression.json` | 23 |
| Goals | `knowledge/progression.json` | 9 (one of them composite: `prepare_for_nether`) |
| Criteria | `CRITERIA_KEYS` (`survival/verify.mjs:372`) | 28 |

The inventory's first run has **zero errors** and one real finding: `auto_door` and
`delay_line` are buildable blueprints that no skill/milestone claims (`orphan_circuit`).

## Open questions

Carried from the raw doc §9: how to expose multi-branch progression without
breaking `resolveMilestone`'s single-`next` contract; whether the R0 inventory
belongs in CI. **R1 answered the `subgoal`
verification question**: it is verified by the skill's own `success` criteria
(filtered to `CRITERIA_KEYS`), so `verifySkill` is not duplicated and no second
per-subgoal criterion exists. **R2's suspension question is answered too** (no: an
under-specified order is not a goal, so nothing is suspended) and the pending
question is stored in the harness inbox, which also makes it survive a controller
restart. **`CHAT_CLARIFY` is not opt-in**: it is on by default, with `off` as the
kill-switch that restores the old planner fallback. **R3 answered where a run's
*motives* live**: in `runs/<run>/plan-trace.jsonl`, one line per plan segment (not
per action), with `source` stamped on the plan when it is born and `endedBy` naming
its closure (`human_order`, `replan:anti_loop:…`, `goal_met`, `signal:SIGTERM`, …).
**R5 answered the multi-branch question without touching the single-`next`
contract**: `resolveMilestone` keeps answering the same five calls a simple goal
always answered (its own suite is untouched) and gained `targets`/`chain`/`steps`,
while the new `milestoneChain` is the one that expands a composite goal. A goal can
now name a list of milestones; what is still open is whether the *targets* should
ever be proposed by a model instead of being authored in `knowledge/progression.json`
(today they are data, and R5 deliberately kept them that way).

New from R0: should `auto_door` and `delay_line` be wired into a milestone (a skill
whose `success.circuitBuilt.id` names them), or are they deliberately unused
blueprints? The inventory reports them as orphans on every run until one of the two
is true.

New from R6: the golden scenarios run the real controller against a **scripted**
harness, so they freeze the controller's decisions, never the world's answers — no
row touches a live Bedrock server, and none exercises a model-driven decision
(`CONTROLLER=jev` needs an API key). What a live golden run should add, and whether
it belongs in this suite or in the container's collaudo, is open.

**R7 partly answered the CI question**: `npm run capabilities:check` is a gate that
exits 1 when the contract does not hold, so wiring it into the pre-push hook or CI is
now a one-line decision rather than a new tool — still a decision, still open. New
from R7: the contract version is bumped by hand, and the only thing enforcing the
protocol is `tests/capability-contract.test.mjs`. Whether a *second* consumer will
ever exist (and which one it would be: another agent, a second bot, an editor
plugin) stays the trigger that would move the transport.
