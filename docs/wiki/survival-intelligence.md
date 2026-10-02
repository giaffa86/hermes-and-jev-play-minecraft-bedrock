# Survival Intelligence Layer (synthesis)

A **deterministic** layer between the user objective and the bounded actions,
inspired by Voyager (skill library, curriculum, self-verification) but **without
code-generation**: no model generates executable JavaScript for Minecraft
behaviour.

Full reference: [`docs/raw/SURVIVAL-INTELLIGENCE.md`](../raw/SURVIVAL-INTELLIGENCE.md).
Related: [headless-client](headless-client.md), [overview](overview.md),
[control-flow](control-flow.md).

## What it does

The chain is: **user goal → progression → plan → governor → resolver → bounded
actions → verification → next milestone.**

1. **Survival Governor** (`survival/governor.mjs` + `knowledge/survival-rules.json`)
   scores health/food/hostiles/night and returns `{mode: normal|caution|emergency,
   needs, overrideObjective, allowedIntents, preferredSkills, risk}`. In an
   emergency (priority ≥ 95 or `critical` risk) it overrides the objective shown to
   the model and restricts `/options` to the allowed intents — only removing keys,
   never adding, never emptying the set.
2. **Declarative gameplay skills** (`skills/gameplay/**/*.json`) are JSON contracts
   (preconditions, success/failure criteria, intents) — different from the Hermes
   `SKILL.md`. They never contain executable code.
3. **Skill Resolver** (`survival/resolver.mjs`) picks the active skill: the
   governor's preference in an emergency, then the plan's optional `skill` field,
   then the progression milestone. Its intents boost relevance in option ranking.
4. **Deterministic verification** (`survival/verify.mjs`) checks real harness state
   (inventory by tag, hunger/health deltas, threat distance, night survived) — never
   the model's opinion. Outcomes land in `runs/<run>/skills.jsonl`.
5. **Progression Engine** (`survival/progression.mjs` + `knowledge/progression.json`)
   is a dependency graph (`wood → crafting_table → stone_tools → … → enter_nether →
   nether_survival → … → enter_end → beat_the_dragon`; see [nether](nether.md)).
   `resolveMilestone` returns the first missing prerequisite; with
   `CURRICULUM=<milestone>` the controller drives the chain deterministically and
   uses Hermes only as fallback.
6. **Goal Contract** (`survival/goal-contract.mjs`, Slice A) wraps the shallow
   `plan` in `target`/`constraints`/`success`/`failure` and derives a status
   (`RUNNING`/`SUCCESS`/`FAILED`/`BLOCKED`) with the same verifier vocabulary;
   `maxDeaths`/`preserveItems` become constraints and `deathsAtLeast`/
   `itemPreserved` the new criteria. Opt-in via `GOAL_CONTRACT`/`MAX_DEATHS`/
   `PRESERVE_ITEMS`; see [goal-achievement](goal-achievement.md).

## Key principle

**Deterministic before the prompt**: `code/rules → compact structured state →
model`, never `huge prompt → the model guesses`. The models never control
mechanics and never bypass `/options`.

## Melee and creeper defense

Melee against a creeper is a losing play (≈49 explosion damage). The layer
encodes that deterministically:

- `knowledge/survival-rules.json` → `creeper_immediate` (priority 97): a creeper
  within 6 blocks forces `emergency` with intents `["escape", "shelter"]` and the
  objective *"do not fight it in melee"*; the preferred skill is `escape_hostile`.
- `survival/perception.mjs` gives the creeper its own threat profile (critical at
  5, high at 10, medium at 16).
- The harness filter (`filterOptionsForGovernor`) drops every option whose intents
  are not allowed, so `attack_creeper` → `['fight']` is removed while `flee` →
  `['escape']` stays.
- The defence actions are mapped onto those intents in `survival/intents.mjs`:
  `go_home`/`retreat` → `['escape', 'shelter']`, `close_door`/`barricade` →
  `['shelter']`, `equip_armor` → `['heal']`, `place_torch` → `['build', 'shelter']`.

So in a creeper emergency the bot can flee, retreat home, or barricade a gap —
but never try to punch the creeper.

**Best real-world defence** (for future work): prevent spawns (`place_torch` +
`sleep`), keep a tamed **cat** (creepers flee from cats within ~8 blocks),
and wear armor. **No ranged option exists yet**: the bot has no bow/arrow
support (see [open-questions](open-questions.md)).

## Status

465 unit tests green (2026-10-02); offline smoke (`wood → crafting table → food → first_night`)
with an emergency interruption passed; live BDS verification of the full milestone
still pending (food beyond crops, shelter, Nether portal). See
[open-questions](open-questions.md).
