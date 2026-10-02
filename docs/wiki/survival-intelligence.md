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
   is a dependency graph (`wood → crafting_table → stone_tools → … → enter_nether`).
   `resolveMilestone` returns the first missing prerequisite; with
   `CURRICULUM=<milestone>` the controller drives the chain deterministically and
   uses Hermes only as fallback.

## Key principle

**Deterministic before the prompt**: `code/rules → compact structured state →
model`, never `huge prompt → the model guesses`. The models never control
mechanics and never bypass `/options`.

## Status

204 unit tests green; offline smoke (`wood → crafting table → food → first_night`)
with an emergency interruption passed; live BDS verification of the full milestone
still pending (food beyond crops, shelter, Nether portal). See
[open-questions](open-questions.md).
