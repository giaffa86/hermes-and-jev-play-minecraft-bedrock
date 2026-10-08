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

### R2 — Clarification gate for human orders (IMPLEMENTED)

**Goal.** Add the one decision the drafts get genuinely right: before planning an
order, decide whether it is specified enough — and if not, ask **one** question
and hold the order until the answer comes.

**Why.** This is the entire content of draft B, minus its false examples (C17,
C18) and its missing precondition (C13). Today an under-specified order is
silently resolved to a default (e.g. a movement order with no destination becomes
"follow the sender"), which is sometimes right and sometimes a guess the human
never asked for.

**Existing code involved.** `memory-chat.mjs` `CLARIFY` + reasons (the real,
working precedent), `controller.mjs:564` (`CLARIFY_TOLD`), `:742`
(`tell_clarify`), `humanCommandPlan` (`controller.mjs:924`, the gate wraps it),
`human-replies.mjs` / `chat-i18n.mjs` (the question text goes through the
catalogue, in every language), and — for the pending store — the harness-side
inbox: `bedrock-adapter.mjs:588` (`this.chatInbox = []`), the push site at
`:12042`, the `observe()` slice at `:4466` (`chat: this.chatInbox.slice(-10)`),
and the route block of `bedrock-harness.mjs` (`POST /say`, `/act`,
`/memory/tell/*`).

**New files.** `human-clarify.mjs` (pure): `orderGaps(text, plan, obs, { memory })`
→ `{ status: 'ready' | 'needs_input', missing: [{ field, reason }], question, options }`.

**Data structures.** `ClarificationRequest { orderId, from, xuid, field, reason,
question, askedAt, originalText }`.

**Where the pending question lives (decided 07/10/2026): in the inbox, not in the
controller.** The chat lifecycle belongs to the inbox side; the controller stays
(nearly) stateless with respect to the conversation.

```text
chat inbox  (harness side: bedrock-adapter.mjs `chatInbox`)
  entry = { from, message, type, xuid, at }
      + per-sender pending clarification

  controller                              inbox
  ----------                              -----
  message -> humanCommandPlan -> human-clarify
                    |
                    +-- ready        -> plan -> goal            (as today)
                    +-- needs_input  -> CLARIFY --- POST /chat/ask ---> pending[from] = {orderId, originalText, question, askedAt}
                                       (no goal is created)

  next message, same sender
      -> the inbox decorates that entry with `clarifies: {orderId, originalText, question}`
         (one shot: the entry is cleared, never two answers to one question)
      -> the controller sees { message, clarifies } and re-evaluates the ORIGINAL
         order with the answer instead of treating the text as a fresh order
```

Consequences and rules:

- **No goal is suspended** (decided 07/10/2026): an under-specified order never
  becomes a goal, so there is nothing to suspend. The running goal keeps running,
  and the held order lives only in the inbox.
- **`POST /chat/ask` is the only writer** and it is called by the controller, which
  has already applied the channel gate (allowlist, prefix, age, dedupe — the gate
  lives in the controller, `bedrock-harness.mjs:159`). A stranger can therefore not
  create a pending entry, and an allowlist check on the answer is unnecessary.
- **A pending entry is dropped** after `CHAT_MAX_AGE_MS` (the same window that
  already makes an order `chat_stale`), and it is written by the inbox exactly once.
- **A stop/cancel order always wins**: it clears the pending entry untouched
  instead of being consumed as the answer.
- **One question per order**: after the answer, `human-clarify` runs again on the
  merged order; if it is still not enough the bot **refuses with a typed message**
  and does not ask a second time (no question loop).
- **The entry carries `originalText`**, not just an `orderId`: `observe()` exposes
  only `chatInbox.slice(-10)`, so after a controller restart the original message
  may have scrolled out of the window — the pending record is the only copy.
- **Bonus of this choice**: the pending question survives a controller restart
  (it is in the adapter), so a player's answer is not lost because the planner was
  restarted in between.

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
different sender does not; a stop order while a question is pending is not consumed
as the answer; a second unanswered reply **refuses** instead of asking again; a
pending question survives a controller restart (the adapter holds it); an expired
held order is dropped; a question-shaped message never enters the gate.

**Acceptance.** two consecutive chat messages complete one order; the ack/outcome
still reach the real sender; no new goal is created by the question.

**Risks.** Medium-high: it changes live chat behaviour. Mitigation: behind
`CHAT_CLARIFY` (**default on**, decided 07/10/2026; kill-switch
`CHAT_CLARIFY=off`), full offline test suite, and `off` is the fallback to the old
planner behaviour for every order.

**Implemented (07/10/2026).** As built, and the decisions taken while building:

- `human-clarify.mjs` (pure, no I/O) exports `orderGaps(text, plan, obs, { memory,
  lang, names })`, `mergeClarifyAnswer(originalText, answer)`,
  `restatesOrder(text)`, `renderClarifyRefusal({lang})`, `planHasDestination`,
  `planIsOtherOrder` and the `CLARIFY_*` constants. Two gaps exist:
  `destination`/`no_destination` (a movement verb with no target anywhere) and
  `place`/`unknown_place` (a name the world memory does not know).
- The gate runs **after** `humanCommandPlan`, on the decided plan — so a plan that
  already carries `waypoint`/`escort.to`, or that is a construction/collect/farm/
  drop/equip order, is never asked about. The ladder is: destination verb? →
  destination in the plan or another order? → follow-verb / `here` / explicit
  coordinates? → an activity after `vai a …`? → the place is in memory (or the
  memory is down → fail-open)? → the name is an object a partitive introduces
  («portami **del** cibo»)? → ask. `planHasDestination` deliberately ignores
  `plan.follow`: the planner fallback always sets it, so it proves nothing.
- The question goes through the five catalogues (`clarify_destination`,
  `clarify_unknown_place` with `{name}`, `clarify_refusal`), never a hardcoded
  string; the refusal is reached when a reply does not close the gap (one question
  per order, then a typed no).
- **The decoration is a hint, not an order** (`replyIsOwnOrder`): a reply that is
  itself a complete order — `restatesOrder` («vai al mulino»), a stop («fermati»
  always wins), or any order the deterministic planner recognises alone (drop,
  collect, equip, farm) — replaces the held order instead of being merged into it.
  Otherwise the held text and the reply are joined (`mergeClarifyAnswer`).
- **The answer is still an addressed message** (`@bot coordinate 120 64 -230`): the
  prefix gate (`matchChatPrefix`) runs before the decoration is read, so the pending
  question never opens a second, unaddressed channel — important with several bots
  on one server. The decoration only supplies the *context* of the reply.
- **The small-talk branch is skipped while a question is pending**: the closed
  `SMALL_TALK` list contains exactly the confirmation shapes a human uses to answer
  («va bene», «perfetto», «ottimo», «d accord»), so a decorated entry must never be
  read as a greeting.
- The reply is offered to the told-fact handler **alone** (`handleToldFact(…,
  {message})`), never as the merged text: a reply that *teaches* a fact («l ingresso
  ora è a 130, 62, -240») must be recognised as a told fact, while the merged text
  is what the planner sees. Every branch logs (`chat_clarify`, `chat_clarify_refused`,
  `chat_clarify_reply` in the adapter, and `chat_command` carries `clarifies`).
- Adapter/harness: `askChat({from, xuid, orderId, originalText, question, field,
  reason})` is the **only writer** (`POST /chat/ask`), plus `GET /chat/pending` and
  `observe().chatPending`; the record lives under both the gamertag and the xuid,
  is consumed by exactly one later message from that sender (`_chatPendingTake`
  deletes every key, a second take finds nothing), and expires at
  `CHAT_ASK_TTL_MS` (default `300000`, the same window as `CHAT_MAX_AGE_MS`), which
  is logged as `chat_ask_stale`.
- Known limitation (accepted, documented): a destination name that *contains* an
  item word and is not in memory («vai al campo di patate») is read as an object
  order and never asked about — better a missed question than a wrong one.
- Tests: `tests/human-clarify.test.mjs` (13, the pure gate),
  `tests/bedrock-chat-ask.test.mjs` (6, the inbox store),
  `tests/controller-clarify.test.mjs` (5, the real controller on the wire: no goal
  from an ambiguous order, the question is recorded before it is spoken, a known
  place does not ask, `off` switches the gate off, and Hermes receives the original
  order with the answer attached — and not the answer alone). Full suite 1909/1909.

---

### R3 — Plan trace and structured observability (IMPLEMENTED)

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

**Implemented (07/10/2026).** As built, and the one place it deliberately differs
from the goal above:

- **The line is per plan *segment*, not per decision.** A segment opens when the
  controller adopts a plan and closes when that plan is replaced or the run ends:
  `runs/<run>/plan-trace.jsonl`, one JSON line per segment, written by the
  controller (the same side that writes `controller.jsonl`). The decision-level
  data lives **inside** the line (`decisions[]`, `refusals[]`), so a reader gets
  the plan, its provenance, what was tried under it and why it ended *without*
  joining files — and the file stays proportional to the number of plans, not to
  the number of actions.
- `plan-trace.mjs` (pure + writer) exports `PLAN_TRACE_VERSION`, `PLAN_SOURCES`,
  `planTraceSource(plan)`, `planTraceSteps(plan, {limit})`, `planTraceShape(plan)`,
  `createPlanTrace({dir, now, write})` (`adopt`/`decided`/`refused`/`record`/`flush`)
  and `summarizePlanTrace(rows, {top})`, plus `readPlanTrace(dir)`. The row is
  `{v, planId, step, reason, source, objective, subgoal, steps[], stepCount,`
  `startedAt, endedAt, ms, endedBy, untilStep, actions, ok, failed, decisions[],`
  `refusals[], omitted}`.
- **`source` is stamped on the plan where the plan is born** (`plan.source`), never
  guessed later: `planForStep` stamps `curriculum`/`construction`, `hermesPlan`
  stamps `hermes` (including its static fallback), and the deterministic order
  branches in `humanCommandPlan` plus the told-fact movement (`told_goto`) stamp
  `deterministic`. The vocabulary is the roadmap's three plus `construction` (a
  static plan that never came from a planner); a value outside it reads back as
  `hermes`. `setPlan()` in the adapter stores the plan as it is, so the field is
  inert at runtime and visible in `observe().plan`.
- **The closure is named**: `endedBy` is `replaced` (an `adopt` closed a segment
  nobody flushed), `human_order`, `human_order_override` (the `max_goal_depth`
  case, which throws the running plan away instead of delegating it to a child
  goal), `replan:<reason>` (`skill_failed`, `anti_loop:<key>:<n>`, `skill_complete`,
  `periodic`, `curriculum`), `goal_met`, `goal_met:<reason>`, `run_end`, `goal_end`
  or `signal:<SIG>`. That single field is the *why* that used to be scattered
  across `log()` calls.
- **A missed flush loses nothing**: `adopt()` closes an open segment by itself and
  `flush()` is idempotent, so the worst case is a segment that spans two plans
  instead of a missing row.
- **The trace can never break a run**: write errors are swallowed
  (`console.error('[plan-trace] write failed:', …)`). There is no env flag — the
  trace is always on because it only appends a line per plan.
- Caps: `steps` is compacted to 12 entries (the real `stepCount` is kept),
  `decisions`/`refusals` to 64 each, the overflow counted in `omitted`.
- `readRunFacts(dir)` gained `planTrace: {count, summary}`, and
  `node tools/run-facts.mjs <run>` prints the block
  (`plan-trace: 2 piani (curriculum=1, hermes=1), 2 passi, 0 decisioni, 1 rifiuti, 1 replan`)
  plus the refusals by typed error, the closure reasons and the last plan's shape.
- Tests: `tests/plan-trace.test.mjs` (9 — the module: source vocabulary, one line
  per segment, idempotent flush, a missed flush, the caps, the three replan
  reasons, the CLI block) and a 6th test in `tests/controller-clarify.test.mjs` that
  drives the **real controller** against the scripted harness for three steps and
  reads the file back (provenance, the preemption's `endedBy: 'human_order'`, the
  chosen keys, `actions === decisions.length`, `failed === 0`). Full suite 1919/1919.
- Honest limit: a goal the goal contract closes **before** any plan is published
  (`GOAL_CONTRACT` already satisfied at step 0) leaves no trace — there was no plan
  to trace. The wire test asserts exactly that; the sixth test covers real steps.

---

### R4 — Structured failure and replan (IMPLEMENTED)

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

**Implemented (07/10/2026).**

- **The vocabulary is closed and ordered**: `step-failure.mjs` (pure, no imports)
  exports `FAILURE_KINDS = ['busy','timeout','transient','moved','blocked',
  'refused','prerequisite','unknown']`, the retryable subset
  (`busy`,`timeout`,`transient`,`moved`), the switching subset (`blocked`),
  `MAX_STEP_ATTEMPTS = 2`, `HINTS` and an **ordered** `RULES` table. Order matters:
  `timeout` before `refused` (a `container_open_timeout` is a timeout),
  `moved` before `blocked`, `blocked` before `prerequisite`. The table was built
  from the *real* refusal strings of `bedrock-adapter.mjs` — `no reachable <ore>
  found nearby`, `<x>_timeout`, `<x>_refused`, `<target>_gone` and
  `player_not_found` (a human who walked away: a moved target, not a fault),
  `no_safe_cell`/`no_place_spot`/`not_diggable_*`/`protected_*`/`unsafe_*`,
  `missing_<item>`/`no_food`/`nothing_to_drop`/`item_not_in_container`.
- **A refusal outside the vocabulary is `unknown` and terminal.** It is never
  guessed retryable: an unrecognised error means the plan has to change, not the
  key. This is the one place the module chooses safety over progress.
- `classifyFailure(error)` → `{kind, retryable}`; `failureRecord({step, stepId,
  key, error, evidence, attempts, at})` adds the `hint` for the kind;
  `failureDisposition(record, {attempts, maxAttempts})` → `{action, reason}` with
  `action ∈ retry|switch|replan` and a self-explaining `reason`
  (`<kind>_retry` / `<kind>_exhausted` / `<kind>_alternative` /
  `<kind>_terminal`). A retryable kind is retried while it has attempts left, then
  the step fails and the plan replans; `blocked` switches approach while it has
  attempts left (`blocked_alternative`); everything else is terminal.
- **The evidence is bounded**: `refusalEvidence({observation, plan, result})` keeps
  the position, dimension, targets and `ms` plus the small extra fields of the
  result — a field whose `JSON.stringify` exceeds 200 characters is dropped, so a
  refusal can never dump the world into a log line.
- **The step is the unit, not the action**: `activeStepId(plan)` finds the step the
  plan declares (the step whose `skill` matches `plan.skill`, else the first, else
  `null`); attempts are counted per step; `reviseSteps(plan, record, {alternatives,
  maxRevisions})` returns a **new** plan with
  `steps[i] = {...step, refused: {step, error, kind, retryable, at, alternatives},
  refusalCount, revisions}` (the last 4 revisions kept) and is inert on a plan
  without steps.
- **The alternative is derived, not guessed**: `siblingKeys(key, optionKeys,
  intentsOf)` returns the offered keys that share at least one intent with the
  refused one (`optionIntents` from `survival/intents.mjs`), never the key itself,
  and `unknown` never matches. So `mine_iron_ore` gets `mine_deepslate_iron_ore`
  and `mine_diamond_ore`.
- **The controller wires it in the one place the verdict exists** — right after
  `log('result', …)`: on a failed action (never on `busy`, which is the lock being
  waited and logged as `harness_busy`, not a verdict) it classifies, counts the
  attempt for the active step, logs `step_failed` with the disposition, and then
  *acts* on the disposition:
  - `retry` → nothing changes: no exclusion (otherwise the retry would not exist)
    and no plan revision (the step has not decided anything yet).
  - `switch` → only the refused key is excluded from `/options`
    (`excludeKeys` with `reason: 'step_refused'`), `step_switch` is logged with the
    alternatives, and the plan is **revised and published** so the refusal lives
    inside `steps[].refused` — the step declares it, the whole plan does not
    replan. Excluding the alternatives too would have made the switch impossible.
  - `replan` → the step fails: `step_failed:<error>` becomes the replan reason.
- **`replanReason` lives inside one iteration** (`controller.mjs:2009`), so a
  reason produced at the end of an iteration was silently lost on the next one. R4
  carries it in `pendingStepReplan`, declared outside the loop, consumed at the
  top of the next iteration *before* the anti-loop block so the precise reason is
  not overwritten by `anti_loop:*`. It is cleared with `stepRefusals`/
  `stepFailureAttempts` whenever a plan is adopted (human order or replan).
- **The trace and the skill record carry the type**: `planTrace.record()` gained
  `kind`/`retryable`/`stepId`, a refusal carries them, `planTraceSteps()` puts
  `refused: {error, kind, retryable}` + `refusalCount` on the step, and
  `summarizePlanTrace` adds `refusalsByKind`/`topRefusalKinds`;
  `tools/run-facts.mjs` prints `tipi: blocked=2, prerequisite=1`.
  `buildSkillRecord()` gained `failure` (the typed refusal that failed the skill).
- Tests: `tests/step-failure.test.mjs` (11 — the vocabulary case table built from
  the real strings, the closed-vocabulary assertion, the terminal `unknown`,
  the bounded evidence, retry→exhausted→replan, blocked→switch→exhausted,
  `activeStepId`, `siblingKeys` with the real `optionIntents`, the revision caps),
  `tests/controller-step-failure.test.mjs` (**new**, 2 — the real controller on the
  wire: `/options` with two sibling keys, `/act mine_iron_ore` refusing; a `blocked`
  refusal excludes the key and publishes `steps[].refused` with its alternatives,
  then the goal is met in 2 actions; a terminal one produces
  `replan:step_failed:missing_diamond_pickaxe` and no revision),
  `tests/plan-trace.test.mjs` (+2), and `tests/controller-follow-lost.test.mjs`
  gained the regression assertion that a retryable refusal publishes no plan.
  Full suite **1934/1934** (from 1919).
- The regression that shaped the design: a first version sent `player_not_found` to
  `unknown`, hence to a replan while a follow order was open — the lost-follow path
  is deterministic and must not replan. Hence `moved` covers `*_not_found` and
  `retry` never touches the plan.
- Honest limit: the alternative is only recorded, not yet *chosen* by a planner —
  the decision is still Jev's on the reduced option list. A step that needs a
  different *kind* of approach (not just a sibling mode) still ends in a replan.

---

### R5 — Composite goals as a DAG over milestones (IMPLEMENTED)

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

**Implemented (07/10/2026).**

- **A composite goal is data, not a new engine**: `goals` accepts an id **or an
  array of ids** (`"prepare_for_nether": ["enter_nether", "nether_survival"]`).
  No milestone is invented and no new node is added: the composite goal is the
  union of the closures of its targets. `validateProgression` checks every element
  (`goal "x": unknown milestone "y"`) and rejects an empty list
  (`goal "x": empty milestone list`); `goalTargets(graph, goal)` normalises both
  forms to an array.
- **The engine gained a chain, the resolver kept its contract**: new
  `milestoneChain(graph, {goal, observation, completed})` returns
  `{status, targets, chain, steps, next, missing}` where `chain` is the missing
  milestones in a **stable topological order** (prerequisites first, in the
  order of `requires`; a satisfied milestone and its whole subtree are skipped).
  `resolveMilestone` is now a thin wrapper over it: a simple goal answers exactly
  as before (same fields, plus `targets`/`chain`/`steps`), so the tests that
  assert `next`/`milestone`/`skill` — the single-`next` contract its own suite
  pins — are untouched. `met` is true only when **every** target is satisfied: a
  satisfied target no longer closes a composite goal.
- **A step carries what the verifier will use**: `milestoneStep(graph, id,
  satisfied)` → `{id, milestone, skill, description, requires, missing, verify}`,
  with `verify` = `criteriaNames(satisfiedWhen)` filtered on `CRITERIA_KEYS` — the
  same closed vocabulary of R1. `missing` is what the step lacks **now**, not what
  it will lack when its turn comes: the chain does not simulate the world (no
  speculative inventory), it lists what to do. The head
  (`steps.find(s => s.missing.length === 0) ?? steps[0]`) is the `next`.
- **The controller plans the whole chain, not just the step**: `planFromMilestone`
  maps `result.steps` through `milestoneStep(entry)` (R1's `planStep` shape plus
  the milestone id and the milestone's own criteria) and puts them on `plan.steps`;
  `withPlanShape` is additive, so the producer wins. A plan for
  `prepare_for_nether` on a fresh-ish bot therefore declares eight steps, the
  first being the active one. The chain is **re-derived** after every milestone
  that closes, so the plan shortens by itself as the world changes.
- **What closes the goal is the engine, not a string comparison**: the old
  `finished.milestone === CURRICULUM` became `nextMilestone(obs).status === 'met'`,
  which for a simple goal is the same thing (the verified milestone just entered
  `completedMilestones`) and for a composite one is the only correct rule.
  `goal_met` now carries `targets`.
- Tests: `tests/progression.test.mjs` (+5 — the expansion order and the step
  fields, a satisfied prerequisite that shortens the chain, `met` only with every
  target, the `error` paths of `milestoneChain`, the composite validation) and
  `tests/controller-curriculum.test.mjs` (+1 — the real controller on the wire:
  `CURRICULUM=prepare_for_nether` walks `diamonds → nether_portal →
  enter_nether → nether_survival` in four actions, every plan declares the chain
  that is still missing (`steps.length` = 4, 3, 2, 1), and `enter_nether` — a
  satisfied **target** — does not close the goal; only the last milestone does).
  `tools/capability-inventory.mjs` (R0) learned the array form, so the inventory
  reports `goal_target_missing` only for a target that really is missing.
  Full suite **1940/1940** (from 1934).
- Honest limit: the composite goal chooses its **targets**, not a procedure. The
  chain is the dependency closure of nodes declared in
  `knowledge/progression.json`; a capability that is not a milestone still cannot
  be composed, and the per-step order inside a milestone (what to mine first) is
  still the harness's `/options` and Jev's choice.

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

1. ~~`plan.subgoal` in free-goal mode~~ — **answered by R1**: the controller holds
   `goal.objective` and the derived `subgoal` rotates; no `objectiveId` was needed.
2. ~~Where a `subgoal` is verified~~ — **answered by R1**: the skill's own
   `success` criteria filtered to `CRITERIA_KEYS`; `verifySkill` is not duplicated.
3. ~~Does a held order suspend the running goal?~~ — **answered 07/10/2026: no.** An
   under-specified order never becomes a goal; it is held in the inbox and the
   running goal is untouched. See the R2 section for the pending-store design.
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
