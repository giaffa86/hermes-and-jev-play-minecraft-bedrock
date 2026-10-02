# Fishing (rod, cast, bite, reel)

Roadmap for fishing in the Bedrock port. Status: **not implemented**. Sources:
`bedrock-adapter.mjs`, `bedrock-survival.mjs`, `bedrock-world.mjs`, `BEDROCK.md`.

## Why fishing

Fishing is a self-sustaining **food source** that does not require hunting farm
animals (which the operational safety rules restrict — never mass-slaughter the
base's animals) and works day and night. The caught fish already integrate with
the existing survival machinery:

- `cod` and `salmon` are in `FOOD_PRIORITY`, so they match the `food` tag
  (`survival/item-tags.mjs`) and the `eat` action.
- `cod → cooked_cod` and `salmon → cooked_salmon` are already in
  `SMELT_RECIPES`, with the `smoker` station mapped in `_smeltStationFor`.
- `pufferfish` and `tropical_fish` are deliberately excluded from food
  (pufferfish is poisonous).

## Current state (what can be reused)

| Piece | Status |
|---|---|
| `fishing_rod` recipe (3 sticks + 2 string, 3×3 grid) | already indexed from `crafting_data` in `this.recipes` (`_indexRecipes`); only the `craft_fishing_rod` option is missing |
| String source | none direct; `attack_spider`/`attack_cave_spider` already exist (hostile-mob loop in `options()`); `cobweb` is minable; tamed-cat string gift is a stretch |
| Water blocks (`water`/`flowing_water`) | already recognised as non-walkable (`/water|lava/` in `_canWalkOn`); the bot does not swim, so it must cast from the shore |
| `use_item` `click_air` | `_useItemTransaction(held, 'click_air')` reused by `_eat` and `throw_egg` — the same transaction casts and reels the rod |
| Drop pickup | `collect_drop` + auto-pickup already ready for the caught fish |

## Roadmap

1. **Perception (water/shore)** — add `_findWater(radius)` / `_findShore(radius)`
   using `world.findBlocks(['water', 'flowing_water'], ...)`, filtered to cells
   adjacent to a non-liquid block the bot can stand on, sorted by distance and
   within cast range (~6–10 blocks). Expose the nearest shore in `/observe`
   (`fishingSpots` or `water`) so Jev has the context to choose.
2. **String** — confirm `attack_spider`/`attack_cave_spider` leave `string`
   (inventory delta after `collect_drop`); add `mine_cobweb` only if a cave/
   mineshaft is nearby. The `fishing_rod` recipe uses the exact item, so no new
   `item-tags` entry is required (add a `string` tag only if aggregate counts
   are wanted).
3. **Crafting** — add `craft_fishing_rod` in `options()` when
   `this.recipes.has('fishing_rod')`, `(inventory.stick || 0) >= 3`,
   `(inventory.string || 0) >= 2` and a crafting table is nearby; reuse
   `_craftActions`/`_planGrid` (3×3, same pattern as `craft_stone_pickaxe`).
4. **Actions**:
   - `cast_rod` — equip the rod (hotbar via `_moveSlotToHotbar`), look at the
     water (`_lookAt`), send `use_item` `click_air`; confirmation: the
     `fishing_hook` (bobber) entity appears via `add_entity`.
   - `reel_in` — second `use_item` `click_air` with the rod in hand;
     confirmation: `add_item_entity` / inventory delta (`cod`/`salmon`/…).
   - `fish` (preferred) — one bounded action: cast → wait for the bite → reel →
     report `{ caught: [item], steps }`.
5. **Bite detection** — see below.
6. **Integration** — optionally a declarative skill
   `skills/gameplay/survival/fish.json` (category `survival`, intents
   `collect`/`craft`, `success: inventoryTagGte { food: 1 }`), or attach fishing
   to the existing `obtain_food` skill as an alternative source. Cooking is
   already covered (`smelt_cod`/`smelt_salmon`).

## Proposed actions

| Action | What it does | Reuse |
|---|---|---|
| `craft_fishing_rod` | 3 sticks + 2 string at a nearby crafting table | `_craftActions`/`_planGrid` |
| `cast_rod` | equip rod, look at water, `click_air` → spawns the bobber | `_useItemTransaction(held, 'click_air')` |
| `reel_in` | second `click_air` to pull the line in | same transaction |
| `fish` (preferred) | cast → wait for bite → reel → report `caught` | composes the above |

## The hard part: bite detection

The bot is headless (no sound, no particles), so "the bobber dips" must be
detected from protocol state. Three options, in order of preference:

- **A — deterministic (preferred)**: track the `fishing_hook` entity and detect
  the bite from its metadata or position (the bobber sinks: `y` drops, or a
  "hooked" metadata flag). Extend `_applyEntityMetadata` for the bobber.
- **B — timing fallback**: `fish` casts, waits a random 15–30 s window, then
  reels; retry if empty. Simple but can miss the bite or reel too early.
- **C — drop observation (verification only)**: watch `add_item_entity` for the
  fish, but the reel must *precede* the drop, so this alone is insufficient.

## Acceptance criteria

- `craft_fishing_rod`: `fishing_rod` +1 in inventory, 3 sticks + 2 string consumed.
- `cast_rod`: `fishing_hook` entity observed (or no error and rod still in hand).
- `reel_in`/`fish`: at least one fish in the inventory delta and the `food` tag
  count increased.
- `attack_spider → collect_drop → string`: string in the inventory delta.
- No base blocks destroyed, no villager hit, the bot stays on shore.
- Tests green (`node --test tests/*.test.mjs`); `BEDROCK.md` updated.

## Operational constraints

See [BEDROCK.md](../BEDROCK.md) for the shared field rules: single bot account,
`connecterror:9` recovery, `_nextStackRequest()` ids, `keep-inventory=false`,
and the `BEDROCK_DEBUG`/`BEDROCK_META_LOG` flags. Fishing-specific: the bot never
pathfinds into water — cast from the shore only.

## Open questions

- The Bedrock entity name for the bobber (`fishing_hook`) and whether the BDS
  exposes a "hooked" metadata signal — to be confirmed live.
- Whether a reachable body of water exists near the base; if not, fishing needs
  an artificial pond (bucket, stretch) or stays a secondary food source.

See [open-questions](open-questions.md) and the consolidated status in
[roadmap](roadmap.md).
