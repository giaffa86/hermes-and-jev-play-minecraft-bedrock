# Roadmap: a semantic reasoning layer over Jev — corrected against the repository

Status: raw source (design), 2026-10-07. This document **supersedes** the two
Italian drafts `docs/raw/roadmap_reasoning_avanzato.md` (2295 lines) and
`docs/raw/clarification_missing_information_phase.md` (736 lines). Both drafts are
aspirational design prompts written without reading the code: several of their
central claims are factually wrong for this repository. This document keeps the
parts of their intent that are real, records every correction with the evidence
that contradicts the draft, and turns the result into an incremental roadmap whose
first two milestones are already implemented (R0, R1).

It is an `docs/raw/` source: the wiki summarizes and links it
(`docs/wiki/reasoning-roadmap.md`); behaviour is still decided by the code.

## 1. Executive summary

The drafts describe a *semantic compiler*: a human request is parsed by an LLM,
compiled into a `CapabilityPlan` IR, validated against an MCP capability registry
and executed as typed capability invocations on top of Jev. None of that exists,
and the two most load-bearing parts of it (`MCP`, `CapabilityPlan`) do not exist
anywhere in this repository — not as a dependency, not as a server, not as an
identifier outside the drafts themselves.

What *does* exist is a four-way deterministic/LLM split that already solves a
large part of the same problem in a different shape: a declarative progression
DAG, declarative gameplay skills with preconditions/success criteria, a
deterministic skill resolver and verifier, an authoritative `/options` catalogue
and a one-action LLM chooser (Jev). `ragiona` (M12) exists and is deployed, but it
is an **answer** feature, not a planning feature.

The honest refactoring target is therefore not "add MCP" or "write a compiler".
It is: **make the plan a real, typed, verifiable object built from the declarative
files that already exist, and add the one missing decision the drafts are right
about — whether the request is specified enough to start at all.** Everything
else (transport protocols, registries, compiler IRs) must be derived from, and
checked against, that real surface.

## 2. The real pipeline (verified 2026-10-07)

Four roles, as documented in `docs/wiki/architecture-evolution.md`:

| Role | Real code | Question it answers |
|---|---|---|
| Progression Engine | `knowledge/progression.json` + `survival/progression.mjs` (`nextMilestone`) | What comes next in the tech tree? (deterministic) |
| System Two / strategic replanner | `hermesPlan` (`controller.mjs:478`), `humanCommandPlan` (`controller.mjs:911`), `planFromMilestone` (`controller.mjs:361`) | What is worth pursuing now? (one shallow JSON plan) |
| Harness | `bedrock-harness.mjs` `options()` | What can I actually do now? (deterministic, authoritative) |
| System One | `jevDecide` (`controller.mjs:2326`), `hermesDecide` (`controller.mjs:1539`) | What single action do I take now? (one key from `/options`) |

A human chat order is handled by `humanCommandPlan(obs, entry)`:

1. deterministic short-circuits run **before** any model call: `isDropOrder`
   (`plan.drop`), farm order (`plan.farm`), `isCollectOrder` (`plan.collect`),
   `isEquipOrder` (`plan.need='wear_armor'`, `plan.equip=true`), stop order;
2. otherwise `runHermes(prompt, …)` (`controller.mjs:392`) is spawned as
   `hermes chat -Q --oneshot -t '' -q <prompt>` and must return **only** JSON:
   `{"objective": string, "targets": {item:minCount}, "waypoint": {"x","z"}|null, "follow": string|null, "notes": string}`;
3. post-processing for stop / escort / follow / construction / drop / farm / collect.

So the plan is a **shallow JSON object**, not a program of typed capability
invocations:

```
{ objective, targets, waypoint, follow, escort, need, equip, drop, farm, collect,
  construction, skill, milestone, recover, notes }
```

`CURRICULUM=<goal>` replaces step 2 with a deterministic plan built by
`nextMilestone`/`planFromMilestone`; Hermes is then only a fallback.

`ragiona` (M12) sits elsewhere. In `controller.mjs:1148-1176`:

```js
const asked = CHAT_REASON_ON ? reasonRequest(raw, …) : …;
const reasoned = asked?.reason === true;
const message = reasoned ? asked.message : raw;
if (reasoned && looksLikeQuestion(message)) { … await sayReason({ from: entry.from, … }); }
```

`reasonRequest` (`chat-llm.mjs:88`) strips the marker (`chat-llm.mjs:72-111`:
ragiona, pensaci, rifletti, think, reason, reflechis, piensa, razona, denk,
uberlege, …) with only the punctuation belonging to it. A reasoned *question* is
answered by the M7 model from `observe()` facts instead of a catalogue sentence. A
reasoned *order* is not routed anywhere new: it carries `reasoned` through
`goal.humanOrder`/`parameters` and follows the exact same plan path.

## 3. Corrections register

Each row is a claim from a draft, the verified reality, and the evidence. "Draft"
= `roadmap_reasoning_avanzato.md` (A) or `clarification_missing_information_phase.md` (B).

| # | Draft claim | Reality | Evidence |
|---|---|---|---|
| C1 | A §1: a deterministic router (regex/keyword/hardcoded) interprets human requests | There is no single router. There are per-feature deterministic short-circuits inside `humanCommandPlan`, the M6 `resolveQuestion` closed-intent router (`chat-intent.mjs`), and the M10 `memory-chat.mjs` sentence reader. Anything else goes to Hermes | `controller.mjs:911-1035`; `chat-intent.mjs`; `memory-chat.mjs` |
| C2 | A §1: `ragiona` "è in corso di implementazione" and bypasses the legacy semantic routing to hand the request to Hermes/LLM | `ragiona` is implemented, released and deployed (M12). It is a **marker**, stripped before the dedup key and before the question router. It changes the **answer** (M7 model answers a question from facts), never the routing, and on an order it bypasses nothing | `controller.mjs:1148-1176`; `chat-llm.mjs:72-111`; `docs/wiki/human-command.md` M12 |
| C3 | A §2: four roles are Hermes = reasoning+planning, **MCP** = capability contracts, Jev = deterministic missions, **bedrockflayer** = actuation | Hermes is a **strategic replanner**, not a hierarchical planner (one shallow plan, re-invoked per replan event); MCP does not exist; Jev picks **one** bounded action from `/options`, it is not a mission executor; actuation is `bedrock-adapter.mjs` (bedrock-protocol client) inside the harness process — `bedrockflayer` is not a dependency of this repo | `docs/wiki/architecture-evolution.md`; `package.json`; `grep -rl "MCP"` matches only the two drafts |
| C4 | A §2 flow: Human → Hermes → Capability Plan/IR → **MCP validation** → Jev → actions → bedrockflayer | Real flow: Human → (deterministic short-circuits \| Hermes shallow JSON) → controller plan/goal → skill resolver + progression → harness `/options` (authoritative) → Jev picks one key → `/act` → adapter | `controller.mjs:911`; `bedrock-harness.mjs` |
| C5 | A §3: `ragiona` behaves like a compiler (parser → IR → type system → VM) | Aspirational, not a description of the code. The nearest real structures are `knowledge/progression.json` (prerequisite DAG), `skills/gameplay/**/*.json` (preconditions + success + intents), `survival/{resolver,verify,intents}.mjs`, `/options`, `/act`. Nothing compiles anything today | `survival/*`; `skills/gameplay/**` |
| C6 | A §4: `ragiona` produces 1..N chained semantic steps (`ensure_item(food,32)`, `build_nether_portal()`, …) | No ordered step list exists. A reasoned order produces the same shallow JSON as an unreasoned one | `controller.mjs:1148-1176`, `:911-1035` |
| C7 | A §5: a `CapabilityPlan` IR `{id, capability, arguments, dependencies, preconditions, postconditions, failure policy, status, result}` | Does not exist. The closest real IR is the union of a skill definition, a progression milestone and a circuit blueprint. A plan IR must be **derived from** those, not built beside them | `skills/gameplay/**`; `knowledge/progression.json`; `circuits/*.json` |
| C8 | A §17/§18: MCP is the semantic ABI; a `CapabilityRegistry` holds capability contracts | No MCP, no registry. The real boundary is the harness HTTP API (`/observe`, `/options`, `/act`, `/plan`, `/say`, `/survival`, `/memory/*`); the real static surface is the declarative JSON. R0 below builds the inventory-checked registry **from those files** | `bedrock-harness.mjs`; `tools/capability-inventory.mjs` |
| C9 | A §43: MCP transport (stdio / Streamable HTTP) | Not applicable: there is no MCP client or server to transport | `package.json` |
| C10 | A §62: milestone names `M0`…`M12` | Collides with the repo's own M-numbering, already used by chat features (M6 questions, M7 LLM replies, M8 narration, M9 drop/collect, M10 told facts, M11 ore alert, M12 `ragiona`). This roadmap uses `R0`…`R7` | `docs/index.md`, `docs/wiki/human-command.md` |
| C11 | A §63: files expected to change, naming `CapabilityPlan`/`CapabilityRegistry`/MCP | Those names exist nowhere; a real list must name real files | `grep` of the repo |
| C12 | A §44/§45: first slices are `ragiona procurami N item X` and `ragiona costruisci una spada di ferro` | Not implementable "on top of `ragiona`": `ragiona` is answer-only and does not touch the planner. Those orders would be `humanCommandPlan` + progression/skill work | C2, C6 |
| C13 | B: the clarification decision sits inside the `CapabilityPlan` compiler | Precondition does not exist (C7). The gate must wrap the **real** planner entry point, `humanCommandPlan` | `controller.mjs:911` |
| C14 | B: result ∈ `{READY, NEEDS_INPUT, UNSUPPORTED}` | None of these states exist. What exists is a **stateless, per-message** clarification: `memory-chat.mjs` returns `kind: 'CLARIFY'` (reasons `no_name`, `no_position`, `no_marker`, `no_sender_position`) and the controller answers with `CLARIFY_TOLD[...]`, writing nothing | `memory-chat.mjs:447-517`; `controller.mjs:554`, `:732-738` |
| C15 | B: "Clarification Must Preserve the Pending Goal" (a follow-up merges into the pending goal) | Not implemented. A follow-up is parsed from scratch as a new message; nothing merges. `goalManager.pending()` exists but is the **goal queue**, unrelated to clarification | `controller.mjs:2568`; no `pendingGoalId` in the repo |
| C16 | B: the `REQUEST_RECEIVED → ANALYZING → READY\|NEEDS_INPUT → …` state machine, and a `ClarificationRequest {pendingGoalId,status,missingFields,reason,question,knownOptions,context}` | Neither exists; the chat handler is a single pass | `controller.mjs` chat handler |
| C17 | B: `ragiona portami del cibo` must ask "which food?" | **Wrong for this codebase.** Food choice is resolved deterministically (food policies + `obtain_food` skill + `planTargets`); asking would violate the repo rule "deterministic before the prompt" | `survival/perception.mjs`, `skills/gameplay/survival/obtain_food.json` |
| C18 | B: `metti il ferro nel baule` with several equivalent chests → NEEDS_INPUT | **Wrong for this codebase.** The deposit policy resolves it deterministically: `_depositTargetFor` scores a container that already holds the item `+100000`, then by distance; `dump_inventory`/`deposit_<item>` need no human choice | `bedrock-adapter.mjs` deposit policy (`_depositTargetFor`, `_isKeptItem`, `_depositableItems`) |
| C19 | B: "Do Not Over-Ask" — the human resolves semantic ambiguity, Jev resolves mechanical | True in spirit and consistent with the code's philosophy, but not encoded anywhere as a rule or a test | `AGENTS.md` (deterministic before the prompt; harness owns validity) |
| C20 | B: Golden clarification scenarios, updated compiler model, additional DoD | Nonexistent; becomes R6 | — |

Claims that are **correct** and must be preserved: A §40 (`/options` remains
authoritative); A §57/§58 invariants (no invented primitives, no invented
coordinates without evidence, no `/act` or actuation-layer calls from the model,
no duplicated recipe/pathfinding/mission logic, a single world memory); A §59
non-goals; A §64 (extend existing structures, never build a parallel
architecture); B's "Resolve Before Asking" ordering *as an intent*; B's "never
guess, never invent coordinates, never start a speculative plan".

## 4. Invariants for every milestone below

1. `ragiona` stays an **answer** marker; any change to it that starts routing or
   planning is a regression unless a milestone says so explicitly.
2. `/options` remains the only source of valid action keys. No plan, subgoal or
   capability may invent a key.
3. Deterministic resolution before the prompt: if the repo can decide (policies,
   observation, world memory, progression), it decides — it does not ask the LLM
   and it does not ask the human.
4. The model never emits chain-of-thought into a log; traces are structured
   *decisions*, not reasoning text.
5. One world memory (`world-memory.mjs` + its repositories). A second store is a
   regression.
6. New guidance extends the existing declarative files (`knowledge/progression.json`,
   `skills/gameplay/**`, `circuits/*.json`); it does not introduce a parallel
   registry of truth.
7. Everything R0–R6 must be verifiable offline by `node --test tests/*.test.mjs`
   and must not weaken `tools/wiki-lint.mjs`.

## 5. The capability surface we actually have (input to R0)

| Layer | Real artifact | Count (2026-10-07, from the R0 inventory) |
|---|---|---|
| Intents vocabulary | `INTENTS` in `survival/intents.mjs` | 23 |
| Option-key → intent map | `KEY_INTENTS` + `PREFIX_INTENTS` in `survival/intents.mjs` (`optionIntents`) | 62 keys + 8 prefixes |
| Gameplay skills | `skills/gameplay/**/*.json`, loaded by `loadGameplaySkills` (`survival/skills.mjs:63`) | 41 files in 6 domains (bootstrap, construction, fluids, progression, redstone, survival) |
| Circuit blueprints | `circuits/*.json`, loaded by `loadCircuits` (`circuits.mjs:311`) | 8 (2 of them orphans, see below) |
| Milestones | `knowledge/progression.json` milestones | 23 |
| Goals | `knowledge/progression.json` goals | 8 |
| Criteria vocabulary | `CRITERIA_KEYS` (`survival/verify.mjs:372`) | 28 |

That table **is** the "registry" the drafts wanted. It exists; what was missing
was a single artifact that reads it as one thing and checks it for holes — now
`tools/capability-inventory.mjs` (the counts above come from it).

The first run reports **zero errors** and a real finding: `auto_door` and
`delay_line` are `buildable` blueprints that no skill declares as a success
criterion (warning `orphan_circuit`) — i.e. they exist but nothing in the
milestone graph can currently ask for them.

## 6. Roadmap

Format per milestone: Goal / Why / Existing code involved / Files expected to
change / New files / Data structures / Tests / Acceptance / Risks.

---

### R0 — Capability inventory (IMPLEMENTED in this change)

**Goal.** One command produces a machine-checkable inventory of the real
capability surface: intents, option-key vocabulary, skills, circuits, milestones,
goals, criteria, plus the cross-checks between them.

**Why.** This is the drafts' `CapabilityRegistry` with the MCP fiction removed. It
makes the "semantic ABI" concrete, gives every later milestone a regression gate,
and surfaces the holes that currently exist silently (a milestone pointing at a
missing skill, a skill naming an unknown intent, a circuit no skill can build).

**Existing code involved.** `survival/intents.mjs`, `survival/skills.mjs`,
`survival/verify.mjs`, `circuits.mjs`, `knowledge/progression.json`.

**New files.** `tools/capability-inventory.mjs` (CLI + `buildInventory()`),
`tests/capability-inventory.test.mjs`.

**Data structures.**

```
CapabilityInventory {
  generatedAt, intents[], optionVocabulary[{pattern, intents[]}],
  skills[{id, category, file, intents[], planTargets, criteria[]}],
  circuits[{id, file, buildable, steps}],
  milestones[{id, skill, requires[], satisfiedWhen}], goals{},
  criteria[],
  issues[{level:'error'|'warning', kind, detail}]
}
```

**Cross-checks (errors).** every skill intent ∈ `INTENTS`; every milestone skill
exists; every `requires`/goal target resolves to a milestone; every
`success.circuitBuilt.id` resolves to a circuit; every circuit referenced by a
skill exists; every circuit `buildable` and not referenced by any skill is a
warning (orphan blueprint).

**Tests.** `tests/capability-inventory.test.mjs` asserts the real repository
inventories with zero errors and unique sorted ids; each synthetic break
(milestone → missing skill, `requires` → non-milestone, goal → missing milestone,
skill → missing circuit) is reported as an error; an orphan circuit is a warning,
not an error; an unknown intent is rejected by the loader itself.

**Acceptance.** `node tools/capability-inventory.mjs` prints JSON and exits 0 on
the real repo; `npm test` stays green; `npm run inventory` is available.

**Risks.** Low: read-only, no network, no server. Risk of drift is handled by
the test asserting the real files parse.

---

### R1 — A typed plan: `subgoal` and `steps` (IMPLEMENTED)

**Goal.** Promote the plan from "shallow JSON with a bag of hints" to an explicit
ordered structure: `objective → subgoal → steps[]`, where each step names a
declarative artifact (a skill id and/or a circuit id) and the state it must reach.

**Why.** The drafts are right that a plan should be a typed object; they are wrong
about where it comes from. It comes from `knowledge/progression.json` and
`skills/gameplay/**`, not from a compiler pass. `docs/wiki/architecture-evolution.md`
("Evolution A") already describes this as the project's own next step: exactly one
level between objective and actions, receding-horizon, re-derived at each replan.

**Existing code involved.** `humanCommandPlan` (`controller.mjs:911`),
`hermesPlan` (`:478`), `planFromMilestone` (`:361`), `nextMilestone`
(`survival/progression.mjs`), `verifySkill` (`survival/verify.mjs:345`).
**New file.** `plan-shape.mjs` (pure): `criteriaNames`, `circuitRef`, `planStep`,
`derivePlanShape`, `withPlanShape` — the single place the shape is derived, also
re-used by the R0 inventory.

**Data structures.** add to the existing plan (no new file of truth):

```
plan.subgoal: string|null          // the current chunk, human/machine readable
plan.steps: [{ id, skill, circuit, targets, verify }]  // 1..N, ordered
```

**Tests.** a curriculum plan carries `subgoal` + one step; a free-goal replan keeps
the `objective` stable and changes only `subgoal`; a step's `verify` uses only
`CRITERIA_KEYS`; `/options`-derived action keys are never named in a step.

**Acceptance.** a live `CURRICULUM=first_night` run logs a plan whose `steps` close
through `verifySkill` one at a time; `GOAL MET` is unchanged.

**Risks.** Medium: touches the planner's shape. Mitigation: `steps` is additive;
no consumer may require it in the same change.

**Implemented (this change).** `plan-shape.mjs` derives the shape; `controller.mjs`
applies it through one `shapedPlan()` wrapper at the three points where a plan
becomes a goal (the human order at `maybeHumanCommand`, the initial plan at
`main`, the replan at the step loop). Both planner prompts now accept an optional
`"subgoal"` string, which is a hint only: when the plan names a skill, `subgoal`
**is** that skill's `description` — the model cannot rename the chunk. A plan with
no `objective` (the `{met:true}` sentinel) is left untouched. `tests/plan-shape.test.mjs`
(9 cases) covers the derivation, the `verify ⊆ CRITERIA_KEYS` rule, that a step
never carries an action field, objective stability across a replan, the "producer
wins" rule, and the sentinel. The live `CURRICULUM` acceptance round is still open
(it needs the bot container and a real goal).

---

### R2 — Clarification gate for human orders

**Goal.** Add the one decision the drafts get genuinely right: before planning an
order, decide whether it is specified enough — and if not, ask **one** question
and hold the order until the answer comes.

**Why.** This is the entire content of draft B, minus its false examples (C17,
C18) and its missing precondition (C13). Today an under-specified order is
silently resolved to a default (e.g. a movement order with no destination becomes
"follow the sender"), which is sometimes right and sometimes a guess the human
never asked for.

**Existing code involved.** `memory-chat.mjs` `CLARIFY` + reasons (the real,
working precedent), `controller.mjs:554` (`CLARIFY_TOLD`), `:732-738`
(`tell_clarify`), `humanCommandPlan` (the gate wraps it), `human-replies.mjs` /
`chat-i18n.mjs` (the question text goes through the catalogue, in every language).

**New files.** `human-clarify.mjs` (pure): `orderGaps(text, plan, obs, { memory })`
→ `{ status: 'ready' | 'needs_input', missing: [{ field, reason }], question, options }`.

**Data structures.** `ClarificationRequest { orderId, from, field, reason, question,
askedAt, originalText }`, held in controller memory (one per sender), dropped on
`CHAT_MAX_AGE_MS`.

**Policy ("resolve before asking", restated for this repo).** In order: (1) explicit
request, (2) conversational context, (3) world memory (`resolvePlace`,
`whereToFind`), (4) current observation, (5) deterministic policies
(`_depositTargetFor`, food policy, progression), (6) runtime-resolvable parameter
(delegated to Jev), (7) ask the human — and only for a field the *human* must
decide (goal, destination, target, quantity, an irreversible choice). The gate must
**never** ask what C17/C18 show the repo already resolves.

**Tests.** a movement order with no destination asks for the destination; the same
order with a remembered place resolves and does not ask; «metti il ferro nel baule»
with several chests does **not** ask (deposit policy); «portami del cibo» does not
ask; a follow-up from the same sender completes the held order; a follow-up from a
different sender does not; an expired held order is dropped; a question-shaped
message never enters the gate.

**Acceptance.** two consecutive chat messages complete one order; the ack/outcome
still reach the real sender; no new goal is created by the question.

**Risks.** Medium-high: it changes live chat behaviour. Mitigation: behind
`CHAT_CLARIFY` (default off in the first release), full offline test suite, and a
live round before enabling.

---

### R3 — Plan trace and structured observability

**Goal.** One structured line per plan decision (`plan_trace`): objective, subgoal,
source (`deterministic|hermes|curriculum`), steps, the chosen action key, the
refusals it saw, and the replan reasons. No chain-of-thought ever.

**Why.** Draft A §41/§42 asks for a reasoning trace; this repo's own rule is that a
number about a run must be readable from a file (`AGENTS.md`, observability). Today
the *why* of a replan is scattered across `log()` calls.

**Existing code involved.** `run-ledger.mjs` (`runs/<run>/actions.jsonl`),
`controller.mjs` `log()`/`planForStep`/`jevDecide`, `tools/run-facts.mjs`.

**Tests.** a plan trace line carries the source and the step count; a
`skill_failed`/`anti_loop`/`human_order_override` replan writes its reason;
`tools/run-facts.mjs` prints the trace summary.

**Acceptance.** a run can be explained from its files alone, without the chat.

**Risks.** Low.

---

### R4 — Structured failure and replan

**Goal.** Turn a harness refusal into typed feedback that a plan step understands:
`{ step, error, evidence, retryable }`, and let a failed step revise its own
`steps[]` instead of only triggering a global replan.

**Why.** Draft A §54 F. Today a refusal is logged and the whole plan is replanned;
a step cannot say "this approach was refused, try the other one".

**Existing code involved.** the refusal vocabulary (`no reachable <ore> found
nearby`, `fell_tree_refused`, `container_open_timeout`, `action_timeout`, …),
`skills/gameplay/**` `success`, `verifySkill`.

**Tests.** a refused step is marked with the typed error and its evidence; a
non-retryable refusal fails the step and the plan; a retryable one picks the
alternative.

**Risks.** Medium.

---

### R5 — Composite goals as a DAG over milestones

**Goal.** An explicit multi-step goal (`prepare_for_nether`) expressed as a DAG of
existing milestones, resolved deterministically.

**Why.** Draft A §7/§54 G wants composite high-level capabilities and forbids LLM
low-level procedures. `knowledge/progression.json` already holds all the
prerequisites; today only `goals` aliasing to a single milestone is exposed.

**Existing code involved.** `goals` in `knowledge/progression.json`,
`resolveMilestone`/`nextMilestone`, `planFromMilestone`.

**Tests.** `prepare_for_nether` expands into the missing prerequisites in
dependency order; a satisfied prerequisite is skipped; `/options` is never
bypassed.

**Risks.** Medium: `nextMilestone` currently returns a single deterministic `next`
(DFS first hit). Extending it must not break the single-`next` contract its tests
assert.

---

### R6 — Golden scenarios and regression hardening

**Goal.** A suite of golden scenarios (order text + observation → expected plan
shape / expected clarification / expected refusal), including Italian orders and
the C17/C18 negative cases.

**Why.** Draft A §54 H and draft B's golden scenarios. This is what freezes R1–R5.

**Tests.** the scenarios are themselves the tests, run offline.

**Acceptance.** every scenario is deterministic; the suite fails if a plan shape
regresses.

**Risks.** Low.

---

### R7 — (conditional) capability contracts across a process boundary

**Goal.** Only if a second consumer of the capability surface appears, expose the
R0 inventory as a validated contract over an explicit transport.

**Why.** Drafts A §43/§54 C/D want MCP. There is exactly one consumer today (the
controller + harness in one codebase). Introducing a transport now would add a
second source of truth and violate invariant 6. Recorded here so the intent is not
lost, and explicitly deferred.

**Non-goal until then.** MCP, a capability registry service, and any plan IR
serialized over the wire.

## 7. Definition of Done (revised)

The drafts' ultimate DoD (A §65) is the right *end state* but assumes MCP. The
reachable version:

`ragiona preparati per andare nel Nether` must become: human language →
deterministic-enough check (R2: it is, or one question is asked) → a plan with an
`objective`, a `subgoal` and an ordered `steps[]` (R1) → each step resolved
against the declarative skills/milestones/circuits and the authoritative `/options`
(R0) → Jev picking one bounded action per step → a verified state delta per step
(`verifySkill`) → a structured replan when a step is refused (R4) → a final
verified goal state, all of it explained by the run's own files (R3).

It must **not**: invent primitives or coordinates without evidence, name an action
key not in `/options`, call `/act` or the adapter from a model, replicate
recipe/pathfinding/mission logic, keep a second world memory, or answer with
chain-of-thought.

## 8. Non-goals (inherited and confirmed)

- Replacing Jev with a smarter action chooser: Jev stays one bounded action.
- A hierarchical planner that precomputes a long script: the project deliberately
  keeps only one level (R1) so reactivity survives.
- MCP, a registry service, a workflow engine, a DAG executor with retries/parallel
  branches (R7 deferred; A §6 confirmed).
- Replacing Mineflayer/Java tooling as an execution layer (A §55): other projects'
  schemas are references, not targets.
- Any behaviour change to `ragiona` beyond what R1–R2 explicitly add.

## 9. Open questions

1. `plan.subgoal` in free-goal mode: is the objective held stable by a heuristic
   ("same objective + new subgoal") or by an explicit `objectiveId`?
2. Where is a `subgoal` verified — the skill's own `success`, or a separate
   criterion? (R1 must not duplicate `verifySkill`.)
3. The clarification gate (R2): does a held order suspend the running goal the way
   a normal order does, or does it never start one until the answer arrives?
4. Multi-branch progression (architecture-evolution "Evolution B"): how to expose
   candidate branches from `resolveMilestone` without breaking the single-`next`
   contract, and what deterministic pre-filter feeds the branch score?
5. Is `CHAT_CLARIFY` default-on acceptable, or must it stay opt-in after the first
   live round?
6. Does the R0 inventory belong in CI (a wiki-lint-style gate) or only in `npm run
   inventory`?

## 10. Sources

- `docs/raw/roadmap_reasoning_avanzato.md` (superseded draft A)
- `docs/raw/clarification_missing_information_phase.md` (superseded draft B)
- `docs/wiki/architecture-evolution.md` (the real forward evolution)
- code: `controller.mjs`, `chat-llm.mjs`, `memory-chat.mjs`, `survival/*`,
  `knowledge/progression.json`, `skills/gameplay/**`, `circuits/*.json`,
  `bedrock-harness.mjs`, `bedrock-adapter.mjs`
