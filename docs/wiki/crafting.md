# Crafting and material sourcing

Where the bot gets what it is asked to build, and how the rule *"look in your
inventory first, then in the nearby chests — never dismantle a building"* is
enforced. Implemented and tested with the survival ladder on 04/10/2026, not yet
deployed to the live container.

## The rule

A human order ("build me a wooden pickaxe") is expressed as
`plan.targets = {"wooden_pickaxe": 1}` — the planner prompt already maps a
specific requested item onto `targets`. From there the **harness** (which owns
validity: it knows the recipes, the inventory, the read chests and which options
are executable) derives what the target is missing and *where each missing
ingredient can come from*, in this order:

1. **A craftable intermediate already in the inventory** — with two oak logs
   held, `craft_oak_planks` is the next step, and the planks are then used
   instead of fetched.
2. **A known chest** — a read cache (`_cachedContainers`) or a remembered one
   (`_rememberedStorage`), taking the item that satisfies the ingredient
   (`take_oak_planks`).
3. **A natural block, only if the harvest option is already offered** — the
   step is accepted only when `mine_<block>` / `harvest_<crop>` exists among the
   options, otherwise `next` stays `null` and the model decides: an action that
   cannot succeed is never promised.

Buildings are not a source *structurally*, not by a rule that could be
forgotten: the mining census (`_refreshNearby`) is a whitelist of natural blocks
(dirt, grass, stone, cobblestone, ores, logs, crops), so planks, chests,
crafting tables or glass can never appear in a `mine_*` option, and
`DIG_PROTECTED` blocks them in the two dig paths (`dig_down`, `dig_up`).
`mine_owned` remains the only way to take back a block the bot itself placed.

## Where it lives

| Piece | What it does |
|---|---|
| `bedrock-adapter.mjs` `_craftTargets()` | the `plan.targets` / `plan.craft` entries that have a recipe and are not held yet |
| `_craftNeedFor(target)` | the recipe reduced to the missing ingredients, each with `need`/`have`/`short` and up to four chest `sources` |
| `_craftableCandidatesFor(ingredient)` | what can be crafted **now** and satisfies an ingredient (the inventory side of the rule) |
| `_gatherStepFor(ingredient, offered)` | the natural-block fallback, filtered by the options actually offered |
| `_craftSourceStep(needs, offered)` | the chosen `next` step, with its `source` (`inventory` / `chest` / `gather`) and `reason` |
| `_craftNeeds({offerKeys})` | the whole view: `{rule, targets, needs, next}`; `observe().craft` exposes it |
| `options()` | the craft steps are added to the `wantedItems` of the `take_*` block (so the 8-slot cap cannot push them out), and the description of the chosen option states the rule ("inventory first, then the chests; nothing is taken from buildings") |
| `controller.mjs` | a deterministic stage in the goal loop: `craft_source` runs after the survival need and the follow/seek stages and before the model; it announces `CRAFT SOURCE <key> (<source> for <target>)`, logs `craft_source`, and is exonerated from the anti-loop counter (a satisfied step is not stagnation) |

The rule string is `inventory_first_then_chests_never_buildings`.

## Food is not crafting

Eggs are **not** food in Bedrock: they are an ingredient (cake, pumpkin pie), so
`bestFood({egg: N})` is `null`. A bot starving with only raw potatoes would
starve forever because the cooked-food list (`FOOD_PRIORITY`) deliberately
excludes raw potato as well; therefore `LAST_RESORT_FOODS = ['potato']` is
accepted only below `STARVING_FOOD = 4` hunger, and `perceive()` reports
`hasFood` accordingly so the governor asks for `eat` instead of sending the bot
to gather food it could already eat. Real food always wins over the last resort.

## Verification

- `tests/bedrock-craft-source.test.mjs` (11 cases): chest before gathering,
  inventory before the chest, the craft ingredients survive the 8-slot take cap,
  a gather step only among the offered options, never a constructed block,
  `craft_target_ready` when everything is held, `observe().craft`, eggs never
  food, raw potato only at critical hunger, the `eat` option below the threshold.
- `tests/controller-craft-source.test.mjs` (2 cases): the scripted harness walks
  the whole ladder in one goal (`take_oak_planks` → `craft_stick` →
  `craft_wooden_pickaxe`) with a single planner call, and a step the harness does
  not offer is left to the planner instead of being forced.
- Full suite at the time: **1285 pass / 0 fail**.

Live verification is still pending (the rule has not been deployed): the live
round would be a chat order such as *"@bot costruisci un piccone di legno"* with
a chest nearby and no logs held, watching for `CRAFT SOURCE take_oak_planks`.

See [survival-intelligence](survival-intelligence.md) for the need → intent →
action ladder that feeds this stage, and [human-command](human-command.md) for
the order channel.
