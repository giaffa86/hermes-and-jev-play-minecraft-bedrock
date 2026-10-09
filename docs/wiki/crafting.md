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

1. **Inventory** — held ingredients satisfy demand immediately. A ready target is crafted directly.
2. **Remembered/cached storage** — the existing chest selection and re-read behavior apply.
3. **Craft** — craft an intermediate from ingredients already held when storage does not supply it.
4. **Remembered resource site** — choose a compatible `resource_site_*` as a waypoint, then refresh the local census and observe again.
5. **Local census** — select only an actually offered `mine_*` or `harvest_*` action.
6. **Missing materials** — keep an unavailable craft step empty; construction returns its explicit failure with `missingMaterials(...)` evidence.

The shared [resource-site provider](../../remembered-resource-sites.mjs) ranks
observations, consolidated productivity and tags by compatibility, current path
reachability, distance and freshness. Invalid records and other dimensions are
excluded. A stale record can suggest a destination but never authorizes gathering.
When the reachability component is truncated, a complete path through loaded cells
can prove an individual destination; semantic planner recall is unchanged.

A visit is one bounded `goto_waypoint`, separate from gathering. It refreshes the
census after success or a partial/failed walk. The next step uses only live offered
keys, with another check before execution. Empty or failed sites fall back to the
local census and are not retried for five minutes for the same resource/dimension.
No historical coordinate is passed to mining. The planner waypoint is preserved.

The same provider serves [construction](construction.md) without changing its
`authorizedContainers` policy. Both paths exclude project cells, persistent
placements and bot-owned blocks from ordinary gather targets; `DIG_PROTECTED`
and crop maturity protections remain active.

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
| `_gatherStepFor(ingredient, offered)` | shared remembered-site navigation, then natural gathering filtered by live options |
| `_craftSourceStep(needs, offered)` | the chosen `next` step, with its `source` (`inventory` / `chest` / `gather`) and `reason` |
| `_craftNeeds({offerKeys})` | the whole view: `{rule, targets, needs, next}`; `observe().craft` exposes it |
| `options()` | the craft steps are added to the `wantedItems` of the `take_*` block (so the 8-slot cap cannot push them out), and the description of the chosen option states the rule ("inventory first, then the chests; nothing is taken from buildings") |
| `controller.mjs` | a deterministic stage in the goal loop: `craft_source` runs after the survival need and the follow/seek stages and before the model; it announces `CRAFT SOURCE <key> (<source> for <target>)`, logs `craft_source`, and is exonerated from the anti-loop counter (a satisfied step is not stagnation) |

The legacy rule string remains `inventory_first_then_chests_never_buildings`; the detailed sourcing order above governs selection.

## The crafting grid is a model of the server's window

The 2×2 grid inside the inventory (slots 30/28/31/29) and the 3×3 table grid
(`_gridSlotFor`) exist **client-side only**: the adapter has to remember what it
put there, because the BDS does not reliably echo the `crafting_input` container
in `item_stack_response`. Two consequences, both fixed on 06/10/2026 after
`craft_torch` failed twice with `craft_failed` (status 35) in the live run 2:

- `_placeFromCursor(gridSlot, count, cursorStack, networkId)` now receives the
  source slot's `network_id` (read *before* the take, since a one-item pile
  disappears from the slot) and records the cell with it instead of with
  `network_id: 0`. It also logs `craft_grid_place` with
  `{gridSlot, item, count, stackId, echoed, containers}`, so the next live round
  can tell whether the server echoes the grid at all.
- `_craftAttempt` no longer stops on the first failed candidate: an item can have
  several recipes (`torch` has both `name:charcoal` 1897 and `tag:coals` 1896),
  and a refusal of one variant must not hide the other. It keeps the first
  failure, tries the rest, and reports `craft_failed_detail` with the grid
  (including each cell's `stack_id`) and the `consumeStackIds` actually sent.
- A `craft_failed` (35) is now in the `syncable` retry set of `_craftItem`, like
  the `take_failed_49/50` and `place_failed_49/50` of a stale stack id: one
  `_resyncByReconnect` plus one attempt. This is safe because the `finally` of
  `_craftAttempt` returns the grid to the pack before the retry.

The layout itself was never the bug: the stick recipe is a 1×2 in the same slots
30/28 and crafted fine 40 ms before the failure.

### Still open: `craft_torch` has never succeeded (status 35)

Ten days later the mitigation above is **not enough**, and the ledger history says
so plainly: across every run on VM 100 `craft_torch` was attempted **22 times and
never succeeded**, `craft_boat` **23 / 0** and `craft_charcoal` **20 / 0**, while
the same code crafts `iron_pickaxe` (3 ok), `diamond_pickaxe` (2 ok), `shield`,
`bucket`, `spruce_planks` and the three wooden/stone tools:
the defect is specific to some recipes, not to crafting.

Live evidence from `diamond-20261010-2` (three refusals, `events.jsonl`):

| t | recipe | width×height | grid as placed | status |
| --- | --- | --- | --- | --- |
| 1791555317699 | `1897` `name:minecraft:charcoal` | 1×2 | `slot 30 charcoal` + `slot 28 stick` | **35** |
| 1791555331978 | `1897` | 1×2 | `slot 30 charcoal` + `slot 28 stick` | **35** |
| 1791555411709 | `1897` | 1×2 | `slot 30 charcoal` + `slot 28 stick` | **35** |

What this rules out, one theory at a time:

- **Not a mis-tracked cell.** Every `craft_grid_place` of the run carries
  `echoed: true` — the server echoes the placement — and the detail now prints
  the real names, not the `name: 0` of the 06/10 round.
- **Not the layout.** Charcoal sits in slot 30 (top-left of the 2×2) and the stick
  in slot 28 (below it): exactly the 1×2 vertical of the stick recipe that works.
- **Not a stale stack id.** `craft_failed` is already in the `syncable` set of
  `_craftItem`, so each refusal was followed by `_resyncByReconnect` and a fresh
  attempt — the three rows above span those attempts and the controller's own
  `REPLAN step_failed:craft_failed` retry.

Hypotheses still untested (each needs a free harness window): **H1** the
`craft_recipe` action must carry the recipe id the server unlocked *for the grid
in use*, and the adapter sends the id read from `crafting_data` (possibly the
table variant); **H2** the multi-candidate loop picks the wrong variant first
(`name:charcoal` 1897 before `tag:coals` 1896) and the refusal leaves the grid in
a state that poisons the sibling attempt — note the third `craft_grid_place` of
each attempt re-uses slot 30 with **coal**; **H3** the `results_deprecated`
descriptor count (torch yields 4) does not match what BDS expects for that
recipe. The discriminating experiment is cheap: craft a `stick` (same 1×2 shape,
same slots) and a torch from **coal** in a quiet window, and keep the full
`item_stack_response` for the failing request instead of only the status.

Until then the expedition does not need the recipe: torches are **taken from a
chest** (`take_torch` ok in 45.7 s and 0.3 s in the same run, the harvest chests
hold `soul_torch 58` and `torch 19`), which is what the mission allows.

## Food is not crafting

Eggs are **not** food in Bedrock: they are an ingredient (cake, pumpkin pie), so
`bestFood({egg: N})` is `null`. The raw potato is different: it is a **safe**
but poor food (1 hunger, 0.6 saturation, no status effect — `minecraft.wiki/w/Poison`
lists only the *poisonous* potato among the Poison sources), so it is the last
entry of `FOOD_PRIORITY`, after every real meal but before anything with a
side effect. `LAST_RESORT_FOODS = ['rotten_flesh', 'chicken', 'poisonous_potato',
'spider_eye']` is accepted only below `STARVING_FOOD = 4` hunger: with a cooked
meal, a carrot or even a plain potato in the inventory the bot never risks
Hunger or Poison, and `perceive()` reports `hasFood` accordingly so the governor
asks for `eat` instead of sending the bot to gather food it could already eat.
Pufferfish (Poison II, one minute) and golden apples stay out of both lists.

## Verification

- `tests/bedrock-craft-source.test.mjs` (11 cases): chest before gathering,
  inventory before the chest, the craft ingredients survive the 8-slot take cap,
  a gather step only among the offered options, never a constructed block,
  `craft_target_ready` when everything is held, `observe().craft`, eggs never
  food, the raw potato as the last *safe* food (it beats every harmful item, and
  `hasFood` is true at hunger 12 and 20), the `eat` option offered from hunger
  12 with a lone raw potato.
- `tests/controller-craft-source.test.mjs` (2 cases): the scripted harness walks
  the whole ladder in one goal (`take_oak_planks` → `craft_stick` →
  `craft_wooden_pickaxe`) with a single planner call, and a step the harness does
  not offer is left to the planner instead of being forced.
- Full suite at the time: **1287 pass / 0 fail**.
- `tests/bedrock-crafting.test.mjs` (23 cases) also pins the grid machinery:
  the torch 1×2 layout in the inventory grid (30/28), `_ingredientMatches` on the
  `coals` tag (coal **and** charcoal, not stick), a placement whose response does
  not echo the grid still naming the cell from the source slot, the status-35
  failure carrying `consumeStackIds`, a rejected variant falling through to the
  next one, and the one-shot resync retry on `craft_failed`. The fixture
  `craftAdapter()` declares both torch recipes, as the server does.

Live verification is still pending (the rule has not been deployed): the live
round would be a chat order such as *"@bot costruisci un piccone di legno"* with
a chest nearby and no logs held, watching for `CRAFT SOURCE take_oak_planks`.

See [survival-intelligence](survival-intelligence.md) for the need → intent →
action ladder that feeds this stage, and [human-command](human-command.md) for
the order channel.

Resource-site supply has offline coverage in
[the provider tests](../../tests/remembered-resource-supply.test.mjs), including
successful navigation and live gathering in both crafting and construction,
stale/invalid/unreachable sites, ranking, local fallback, missing-material evidence,
late resource disappearance, crops, consolidated productivity and placement protection.
This slice has not been deployed or tested against a real BDS.
