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

### Fixed (2026-10-11): the layout **was** the bug for the 1×2 family

The 2×2 grid has two vertical readings and the adapter was writing the wrong one.
`_gridSlotFor` mapped the first cell of a shaped recipe (row 0, the **top** row) to
slot 30 and the second row to slot 28: the grid went to the server **upside down**
relative to the row-major `[28, 29, 30, 31]` the same adapter uses when it *reads*
the window (`inventory_content`, `bedrock-adapter.mjs:1252-1259`) and relative to
the table grid, which is `32 + proto` row-major. A recipe whose two cells hold
**different** items is a different pattern when flipped, and the server answered
the only thing it could answer: **35**, `ItemStackNetResult.MismatchedRecipeForInputGridItems`.

Why ten days of refusals stayed mysterious:

- the **stick** recipe hid it — a 1×2 with the same item in both cells is the same
grid read either way (8 ok / 0 failed), which is what made "the layout is not the
bug" look safe;
- the reading side of the same file (`[28, 29, 30, 31]`) and the table (`32 + proto`)
were both row-major, so the flip lived only in the *writing* path;
- the workbench case is not symmetric with the bucket: a 3×2 recipe is placed with
`tableYOffset = 1` (bottom-aligned), which matches the vanilla bucket that *does*
craft — so "the offset is wrong" was never the story either.

Two consequences of the refusal are now part of the fix:

- **The refusal is evidence, so it is learned, not repeated.** On a 35 the adapter
  flips the vertical reading, records it (`craft_layout_retry {order, next,
  learned: true}`) and lets the retry path already present in `_craftItem` run
  again; the winning order is kept for the session (`_craftGridOrder`) and the
  orders already refused for that shape are remembered so the two readings cannot
  ping-pong.
- **A refused window is poisoned.** After the 35 the server answers **50**
  (`FailedToValidateDstSlot`) to *every* following request in that window,
  including the `take` of the ingredients (`cursor_take_failed {slotIndex: 2,
  container: 'hotbar', status: 50}`): flipping inside the same window is
  impossible and only the `_resyncByReconnect` that `_craftItem` already performs
  clears it. The window is therefore opened **once per recipe variant**, not once
  per arrangement.

Live proof (`craft-proof-20261011-1`, harness on VM 100, `events.jsonl`):

| t | what | evidence |
| --- | --- | --- |
| 1791718801349 | `craft_lever`, order 0 | `craft_failed_detail … status 35, order 0` |
| 1791718801350 | the flip is learned | `craft_layout_retry {order: 0, next: 1, learned: true}` |
| 1791718801491 | the window is dead | `inventory_resync {reason: slot ids stale after pickups}` → reconnect |
| 1791718813790 | retry from the learned order | `inventory_resync_done {via: reconnect}`, then `{"ok":true,"crafted":"lever","count":1}` in 13.5 s |
| — | `craft_torch`, order already learned | `{"ok":true,"crafted":"torch","count":4}` in **0.35 s** |

The inventory deltas are coherent (`cobblestone 64→63`, `stick 4→2`, `coal 64→63`,
`lever 1`, `torch 4`). Before the fix the same action was **48 attempts and zero
successes** across every ledger on VM 100.

Correction to the earlier reading of the history: `craft_boat` and `craft_charcoal`
were **not** status 35 — their failures are `craft_recipe_missing` (20×) and
`container_open_timeout` (20×), a different signature (recipe lookup by name and
the container wedge), tracked separately in [open-questions](open-questions.md).

Residuals: for a **table** recipe (`width > 2` or `height > 2`) only one
arrangement is tried (`orders = [0]`), so a vertical mis-reading of the 3×3 grid
would not be learned from a 35; the learned order and the refused-order memory are
per session, not persisted; and the fix was proven on `lever` and `torch` — the
family it explains — not on every 1×2 recipe in the game.

The expedition never depended on the recipe: torches are **taken from a chest**
(`take_torch` ok in 45.7 s and 0.3 s in the same run; the harvest chests hold
`soul_torch 58` and `torch 19`). It does not have to any more.

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
