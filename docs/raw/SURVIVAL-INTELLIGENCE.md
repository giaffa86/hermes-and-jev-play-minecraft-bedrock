# Survival Intelligence Layer

A deterministic intelligence layer between the user objective and the bounded
actions: progression, survival, declarative skills and verification. It is
inspired by [Voyager](https://github.com/MineDojo/Voyager) concepts (skill library,
curriculum, self-verification, reusable experience) **without** adopting its
code-generation model: here no model generates executable JavaScript for Minecraft
behaviour.

Related documents: [`BEDROCK.md`](../../BEDROCK.md) (Bedrock port), [`README.md`](../../README.md),
[`AGENTS.md`](../../AGENTS.md) (agent notes).

---

## Architecture

```text
                       USER GOAL (GOAL / CURRICULUM)
                          |
                          v
                +--------------------+
                | Progression Engine |  knowledge/progression.json
                |  survival/progression.mjs
                +---------+----------+
                          |
                    desired milestone
                          |
                          v
                +--------------------+        +------------------------------+
                |  Hermes Planner    |<------>| Skill Library (gameplay)     |
                |    System Two      |        | skills/gameplay/**/*.json    |
                +---------+----------+        +------------------------------+
                          |
                    planned skill (optional `skill` field)
                          |
                          v
OBSERVATION ---> +--------------------+
 (/observe)      | Survival Governor  |  knowledge/survival-rules.json
                 | survival/governor  |
                 +---------+----------+
                           |
                     safe objective
                           |
                           v
                 +--------------------+
                 |   Skill Resolver   |  survival/resolver.mjs
                 +---------+----------+
                           |
                           v
                    Harness /options      (the only owner of validity)
                           |
                           v
                         JEV
                     System One
                           |
                       one action
                           |
                           v
                   Bedrock Adapter
                           |
                           v
                      Minecraft
```

Unchanged principles:

- **Models do not control mechanics.** Hermes and Jev do not send packets, do not
  press keys, do not generate executed code and do not bypass `/options`.
- **The harness owns validity.** If an action is not executable or not useful now,
  it is not offered.
- **Jev stays bounded.** It picks exactly one key among those offered.
- **Hermes stays milestone-oriented.** It does not run every tick and does not
  memorize the tech tree: the deterministic knowledge lives in the `knowledge/` files.
- **Deterministic before the prompt.** `code/rules -> compact structured state ->
  model`, never `huge prompt -> the model guesses`.

---

## Modules

| Path | Role |
|---|---|
| `survival/perception.mjs` | Normalizes `/observe` into a survival state: health, hunger, day phase, hostiles with severity, best food, bed, weapon/pickaxe, inventory summary by tag. |
| `survival/risk.mjs` | Risk score 0..100 and level `none/low/medium/high/critical` with explicit `reasons`. |
| `survival/needs.mjs` | Ordered needs: `survive, escape, eat, heal, sleep, shelter, obtain_food, obtain_weapon, obtain_armor, replace_tool, continue_progression`. |
| `survival/rules.mjs` | Explicit evaluator of the JSON rules (closed vocabulary, validated at load). |
| `survival/governor.mjs` | Combines perception/risk/needs/rules into `{mode, priority, reasons, needs, overrideObjective, allowedIntents, preferredSkills, risk}`. |
| `survival/intents.mjs` | Shared intent vocabulary and mapping from `/options` keys → intents (never the reverse). |
| `survival/item-tags.mjs` | Item tags (`logs`, `food`, `stone_tools`, ...) used by verifier and progression. |
| `survival/skills.mjs` | Loader/validator of the declarative gameplay skills in `skills/gameplay/`. |
| `survival/verify.mjs` | Deterministic verification: `verifySkill(skill, before, after)` + criteria vocabulary. |
| `survival/goal-contract.mjs` | Structured Goal Contract (`target`/`constraints`/`success`/`failure`) → `RUNNING/SUCCESS/FAILED/BLOCKED`, evaluated with the verifier vocabulary. |
| `survival/resolver.mjs` | Active skill, emergency filter of options, preferred intents for ranking. |
| `survival/progression.mjs` | Progression graph, validation, resolution of the next missing prerequisite. |
| `survival/experience.mjs` | JSONL rows for `runs/<run>/skills.jsonl`. |
| `knowledge/survival-rules.json` | Deterministic survival policy (when to interrupt progression). |
| `knowledge/progression.json` | Milestone graph and dependencies. |
| `skills/gameplay/` | Declarative gameplay skills (a different concept from the Hermes skill). |

---

## HTTP contracts

### `GET /observe`

The existing normalized observation gains a compact section:

```json
{
  "health": 4, "food": 3,
  "survival": {
    "mode": "emergency",
    "risk": 100,
    "level": "critical",
    "rule": "low_health_near_hostile",
    "needs": ["survive", "escape", "heal"],
    "reasons": ["critical_health", "food_low", "hostile_critical", "night"],
    "overrideObjective": "Escape immediate danger and recover health before resuming progression."
  }
}
```

The payload stays small on purpose: it is meant for the planner, not for debugging.

### `GET /options`

The harness keeps offering only valid actions. In an emergency (`mode: emergency`)
it restricts them to the intents allowed by the governor (`allowedIntents`). The
filter:

- never adds non-existent keys;
- never returns an empty set (if nothing allowed remains, it falls back to the
  original options and reports `filterReason: "no_allowed_option"`);
- is the only "strong" filter; the rest is ranking.

The response adds metadata (`survival`, `filtered`, `removed`, `filterReason`)
without breaking the `{ options }` format used by the controller.

### `GET /survival` (diagnostics)

Full governor, active skill with provenance (`plan`, `governor`, `progression`) and
the milestone suggested by the graph (with `PROGRESSION_GOAL`).

---

## Survival Governor

Output:

```json
{
  "mode": "normal|caution|emergency",
  "priority": 0,
  "reasons": ["food_low"],
  "needs": ["eat", "continue_progression"],
  "overrideObjective": null,
  "allowedIntents": null,
  "preferredSkills": ["eat_available_food"],
  "rule": "low_food",
  "matchedRules": ["low_food", "hungry"],
  "risk": { "level": "low", "score": 18, "threats": [], "reasons": ["food_low"] }
}
```

- `normal`: no relevant rule, no override.
- `caution` (priority ≥ 55 or `high` risk): the objective shown to the decision
  model is replaced with `overrideObjective`, all options remain.
- `emergency` (priority ≥ 95 or `critical` risk): as above and additionally
  `allowedIntents` restricts `/options`. Dying is a special case: only `wait`.

**Where does the deterministic policy live?** In `knowledge/survival-rules.json`,
never in prompts. To add a policy:

1. choose the conditions from the vocabulary (`healthMax`, `foodMax`, `phase`,
   `night`, `bedAvailable`, `hasFood`, `weaponInInventory`, `hostileWithin`,
   `hostileSeverityAtLeast`, `hostileTypeWithin`, `sleeping`, `dead`,
   `lootNearby`, `timeKnown`, `pickaxeInInventory`);
2. assign `priority` (≥ 95 emergency, ≥ 55 caution);
3. declare `intents` (what must stay possible), `objective` (sentence for the
   decision model) and `preferredSkills` (gameplay library skills, in order);
4. add a test in `tests/survival-governor.test.mjs`. The loader validates files at
   startup: a typo in a condition fails immediately with a clear message.

---

## Gameplay skill vs Hermes Agent skill

| | Hermes Agent skill | Gameplay skill |
|---|---|---|
| Where | `skills/minecraft-bounded-agent/SKILL.md` | `skills/gameplay/**/*.json` |
| What it is | Instructions for a Hermes session with the terminal tool | Deterministic contract executable by the controller |
| Who uses it | Hermes Agent (LLM) | Governor, resolver, verifier, progression engine |
| Content | Discursive Markdown | Validated JSON with criteria and intents |
| Executable code | No | No (100% declarative) |

### Schema of a gameplay skill

```json
{
  "id": "acquire_wood",
  "description": "Acquire enough logs for early-game crafting.",
  "category": "bootstrap",
  "preconditions": { "inventoryTagGte": { "logs": 0 } },
  "success": { "inventoryTagGte": { "logs": 8 } },
  "failure": null,
  "intents": ["mine", "collect", "travel"],
  "planTargets": { "oak_log": 8 },
  "allowDeath": false
}
```

Allowed intents: `escape, fight, eat, heal, sleep, shelter, recover, collect,
travel, mine, craft, smelt, build, wait`.

### How to add a gameplay skill

1. Create `skills/gameplay/<category>/<id>.json` with `id` and `description`;
2. declare `preconditions` and `success` with the criteria vocabulary
   (`inventoryGte`, `inventoryTagGte`, `healthAtLeast`, `foodAtLeast`, `phaseIn`,
   `dimension`, `nearbyBlock`, `foodIncreased`, `healthIncreased`,
   `noHostileWithin`, `threatDistanceIncreasedBy`, `nightSurvived`,
   `deathsAtLeast`, `itemPreserved`, `allOf`, `anyOf`; for tags see
   `survival/item-tags.mjs`);
3. list the `intents` useful for option ranking and, if needed, the suggested
   `planTargets`;
4. optionally link a milestone in `knowledge/progression.json` with
   `"skill": "<id>"`;
5. add a test in `tests/gameplay-skills.test.mjs`. The loader validates all files
   at harness and controller startup.

The skill must never declare actions: those remain the ones from `/options`.
`intents` only orders/filters what the harness already offers.

---

## Deterministic verification

`verifySkill(skill, observationBefore, observationAfter)` returns:

```json
{ "status": "success", "skill": "acquire_wood", "evidence": { "inventory.logs": 10 }, "reason": null }
```

- `success`: the `success` criteria are satisfied **by the harness data**;
- `failed`: the `failure` criteria are satisfied or the bot died (`allowDeath`
  disables the latter check);
- `running`: neither success nor failure.

Verification never asks a model whether the task succeeded. Every success/failure
outcome lands in `runs/<run>/skills.jsonl`:

```json
{"t": 1790948940243, "skill": "acquire_wood", "success": true, "status": "success", "actions": 1, "elapsedMs": 20, "failureReason": null, "context": {"milestone": "wood", "evidence": {"inventory.logs": 8}}}
```

No embeddings or vector database: flat JSON rows, ready for future retrievable
experience.

---

## Goal Contract (Slice A)

`survival/goal-contract.mjs` wraps the shallow `plan` in a structured objective
and gives the controller a deterministic status:

```text
RUNNING | SUCCESS | FAILED | BLOCKED | EXHAUSTED
```

```json
{
  "goal": "obtain_diamonds",
  "target": { "item": "diamond", "count": 20 },
  "constraints": { "maxDeaths": 2, "preserveItems": ["diamond_pickaxe"] },
  "success": { "inventoryTagGte": { "diamonds": 20 } },
  "failure": { "deathsAtLeast": 3 }
}
```

- `normalizeContract(raw)` validates `success`/`failure` with the verifier
  vocabulary and collects errors instead of throwing; invalid contracts are
  `blocked`, never a silent success.
- `evaluateContract(contract, obs, { before })` precedence: invalid/static
  contradiction → `blocked`; `success` → `success`; `failure` **or a violated
  constraint** (`maxDeaths`, `preserveItems`) → `failed`; otherwise `running`.
- `contractFromEnv()` reads `GOAL_CONTRACT` (JSON) with the `MAX_DEATHS` and
  `PRESERVE_ITEMS` shortcuts; `hasContractConfig()` keeps the controller
  backward-compatible when no contract is configured (opt-in).
- `contractStop(contract, obs, { stepsUsed, maxSteps })` is `evaluateContract`
  plus the **action budget**: while actions remain the contract is `running`;
  when `stepsUsed >= maxSteps` (controller `MAX_STEPS`) and no success/failure
  fired, it becomes `exhausted`. `exhausted` is terminal and means "out of
  actions", not "a failure criterion fired".
- The controller evaluates the contract at the start and every step, logs
  `goal_contract` / `goal_contract_met` / `goal_contract_stop` to
  `runs/<run>/controller.jsonl`, and stops on
  `SUCCESS`/`FAILED`/`BLOCKED`/`EXHAUSTED`.
- Exit code is `0` on `SUCCESS` (and when no contract is configured) and `2` on
  `FAILED`/`BLOCKED`/`EXHAUSTED`, so a runner can distinguish an unmet goal from
  a completed one.
- New criteria: `deathsAtLeast n` and `itemPreserved [item]` (compares against
  the `before` inventory; an item held at the start must not decrease).

---

## Progression Engine

`knowledge/progression.json` represents dependencies, not a rigid sequence:

```json
{
  "milestones": {
    "wood": { "requires": [], "skill": "acquire_wood", "satisfiedWhen": { "inventoryTagGte": { "logs": 8 } } },
    "crafting_table": { "requires": ["wood"], "skill": "acquire_crafting_table" },
    "iron_age": { "requires": ["stone_tools"], "skill": "acquire_iron" },
    "enter_nether": { "requires": ["diamonds"], "skill": "enter_nether" }
  },
  "goals": { "first_night": "first_night", "enter_nether": "enter_nether" }
}
```

`resolveMilestone(graph, {goal, observation, completed})` answers:

- `{status: "met"}` goal already reached;
- `{status: "next", milestone, skill, missing}` first unsatisfied milestone with all
  prerequisites satisfied;
- `{status: "error", reason}` unusable goal/graph (in that case the controller
  falls back to Hermes).

A milestone is satisfied if `completed` (real verification already happened)
contains it or if `satisfiedWhen` is evaluable on the current observation.

### How to add a milestone

1. add the node in `knowledge/progression.json` with `requires`, `skill`,
   `description` and, if statically verifiable, `satisfiedWhen`;
2. create the corresponding gameplay skill in `skills/gameplay/`;
3. add the alias in `goals` if it must be usable as an objective;
4. add a test in `tests/progression.test.mjs`.

---

## Curriculum mode (Phase 10)

With `CURRICULUM=<milestone>` the controller does not ask Hermes to remember the
tech tree:

```text
overall goal (CURRICULUM)
  -> progression engine: next missing prerequisite
  -> gameplay skill
  -> deterministic plan (objective from the catalog, planTargets from the skill)
  -> bounded actions + verification
  -> milestone completed -> next prerequisite
```

Hermes remains the fallback when the engine cannot decide (`error`) or when the
observation is ambiguous; periodic/anti-loop replans in curriculum mode recompute
the milestone without starting over.

Example run of the `first_night` milestone:

```bash
CURRICULUM=first_night CONTROLLER=jev RUN_ID=first-night MAX_STEPS=120 node controller.mjs
```

Steps logged in `runs/<run>/controller.jsonl`: `survival` (mode/rule changes),
`plan`, `replan` (`curriculum`), `skill_success`/`skill_failed`, `options` (with
`skill`, `skillSource`, `preferredIntents`), `decision`, `result`, `goal_met`.

---

## First end-to-end milestone

```text
spawn Survival
  -> wood (acquire_wood)
  -> crafting table (acquire_crafting_table)
  -> stone tools (stone_age)
  -> usable food (obtain_food)
  -> first night (first_night)
```

The architecture is ready to run on different spawns without supplying every
intermediate objective: the graph resolves the prerequisites and the verifier
confirms them from real data. The existing and missing Bedrock capabilities are
listed in [`BEDROCK.md`](../../BEDROCK.md); among the known blockers: rations/hunting
for food beyond crops, the Nether portal, NetherNet stability in critical time
slots.

---

## Tests

```bash
node --test tests/survival-governor.test.mjs tests/gameplay-skills.test.mjs tests/progression.test.mjs tests/survival-integration.test.mjs
node --test tests/*.test.mjs   # full suite
```

They cover, without a server: hostile classification, food selection, risk scoring,
needs, rules, governor, skill schema/loader, resolver/emergency filter,
verification with evidence, progression dependencies, milestone memory and an
integrated `progression -> emergency -> resume` scenario.

The controller smoke test in curriculum mode uses a fake harness and a stub of the
`hermes` CLI: no calls to external providers, no Minecraft server (see history in
`runs/smoke-curriculum/`).

## Verification status (02/10/2026)

- **Unit + offline integration**: full green suite (204 tests: 149 pre-existing +
  55 new).
- **Harness**: offline boot verified with unreachable endpoint — `GET /observe`
  exposes the compact `survival`, `GET /options` adds the filter metadata and
  `GET /survival` answers.
- **Controller in curriculum mode**: end-to-end smoke with fake harness and `hermes`
  stub — `wood -> crafting table -> food -> first_night` with an emergency
  interruption (creeper at 4.2 blocks, health 4), options filtered to `[flee, eat]`,
  resume from the same milestone, `GOAL MET after 7 actions` and 4 records in
  `runs/smoke-curriculum/skills.jsonl`.
- **Live verification on BDS**: not run in this session because the bot container
  was connected and active (a concurrent session with the same account would have
  kicked it out). To retry in a free window: real `GET /observe` → `survival`, and a
  `CURRICULUM=first_night` round on the world.
- **Missing Bedrock capabilities for the full milestone**: food beyond crops
  requires the furnace/smelting chain (exists but needs live testing); advanced
  shelter actions (wall/shelter building) and Nether portal support are missing;
  the NetherNet instability documented in `BEDROCK.md` remains.
