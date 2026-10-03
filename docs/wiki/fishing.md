# Fishing (rod, cast, bite, reel)

Fishing in the Bedrock port. Status: **implemented, offline-verified
(03/10); live round pending**.
Sources: `bedrock-adapter.mjs`, `bedrock-fishing.mjs` (pure rules),
`bedrock-survival.mjs`, `bedrock-world.mjs`, `BEDROCK.md`.

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

## What is implemented

| Action | What it does | Reuse |
|---|---|---|
| `craft_fishing_rod` | 3 sticks + 2 string at a nearby crafting table, offered when `this.recipes.has('fishing_rod')` and materials + table are available | `craft_` prefix → `_craftItem` (same as `craft_stone_pickaxe`) |
| `cast_rod` | equip rod, walk to the shore, look at the water, `use_item` `click_air` → confirms the `fishing_hook` (bobber) entity appears | `_useItemTransaction(held, 'click_air')` |
| `reel_in` | second `click_air` to pull the line in → confirms an inventory delta (`fishCount` increase) | same transaction |
| `fish` | one bounded action: cast → wait for the bobber to settle → wait for the bite → reel → report `{ caught, gained, biteDetected, biteSource }` | composes `_castRod` + `_reelIn` |

Supporting pieces:

- **Pure module `bedrock-fishing.mjs`** (no socket/world access, unit-tested):
  `isWaterBlock`, `isFishItem`/`isEdibleFish`, `fishCount`/`fishItems`,
  `shoreCandidates` (ground cells adjacent to water within `CAST_RANGE`),
  `nextBiteDelay` (vanilla 5–30 s window), `FISHING_ROD_INGREDIENTS`.
- **Perception**: `_findFishingSpot()` finds the nearest shore
  (`world.findBlocks('water'/'flowing_water')` + `blockAt` on the 4 horizontal
  neighbours); exposed in `/observe.fishing` (`available`, `spot`, `rod`,
  `string`, `bobberOut`, `fish`).
- **Bite detection** (rewritten 03/10): the primary signal is the **server's own
event** — `entity_event` `fish_hook_hook` (numeric id `13`) on the `fishing_hook`
entity, logged as `fish_bite` (`fish_hook_tease`, id `14`, logs `fish_tease` and
is **not** a bite). The fallback is a dip of the bobber relative to its
**settled** height, because the cast descent used to be mistaken for a bite: the
bobber must hold its `y` within 0.05 for 3 consecutive samples (100 ms apart)
before the watch starts, then sink ≥ 0.2 for two consecutive samples
(`biteSource: 'dip'`). A bobber that disappears while settling is a typed
failure (`bobber_lost`). Either way the reel is confirmed by the inventory
delta, never by a model's opinion; `biteSource` reports which signal fired.

## Acceptance criteria

- `craft_fishing_rod`: `fishing_rod` +1, 3 sticks + 2 string consumed.
- `cast_rod`: `fishing_hook` entity observed (or no error and rod still in hand).
- `reel_in`/`fish`: at least one fish in the inventory delta, `food` tag count
  increased.
- `attack_spider → collect_drop → string`: string in the inventory delta.
- No base blocks destroyed, no villager hit, the bot stays on shore.
- Unit tests green (`node --test tests/*.test.mjs`).

## Verification status

The pure module and the adapter wiring are covered by unit tests
(`tests/bedrock-fishing.test.mjs`, 14 tests: 7 for the pure module, 7 for the
adapter's `_fish`). **The live round ran on 03/10/2026** and closed the supply
chain up to the cast:

- `take_string` (42 from a chest the scan had hidden before), then
  `craft_spruce_planks` → `craft_stick` → **`craft_fishing_rod`** through the 3×3
  workbench path (the very path of rows 47.32/47.33), after which
  `GET /observe.fishing` flips to `{available: true, rod: true}`;
- the bobber's Bedrock entity type **is** `fishing_hook` and the harness tracks it
  (`cast_rod` → `{ok:true, bobber:{x:72.1,y:75.1,z:178.1}, waterAt:{x:72,y:74,z:176}}`,
  the entity read at y=75 for 48 s, bobbing on the water surface of a 256-block
  body of water 4 blocks from the shore);
- **no bite signal ever arrives**: five `fish` runs answer
  `{ok:true, note:'no_bite', biteDetected:false, biteSource:null}`, `grep -c fish_bite`
  over the whole event log is **0**, and the hook despawns about 40 s after the
  cast with nothing caught. So the question “does `fish_hook_hook` arrive?” now has
  a measured answer: **not to this client**, over eight observed minutes of casting.

The same class as the mount/trade/offhand confirmations: the server wants a trigger
only the vanilla client produces, so the next step is a packet capture of a real
player fishing. A fix found on the way is already in: `_onEntityEvent` resolved the
entity **before** the fishing branches, so a hook whose runtime id was not in the
entity map dropped the bite silently — the fishing ids (13/14) are now handled
first (`tests/bedrock-fishing.test.mjs` 13 → 14, the new case falsified against the
old order). `REEL_GRACE_MS` is exported by the pure module but still unused by the
adapter — the grace period is implicit in the settle + bite-window phases.

## Open questions

- Is there a reachable body of water near the base? **Answered live 03/10: yes** — the
  village pond (256 water blocks, the nearest at 4 blocks from the bot) is reachable
  and the rod can be crafted from the string found in the base chests, so fishing is
  a real food source once the bite is understood (see the open question above).
  No artificial pond is needed.
- Should `mine_cobweb` be added for string (only if a cave/mineshaft is nearby)?
  `attack_spider`/`attack_cave_spider` already exist as the primary string source.
- Optional: a declarative skill `skills/gameplay/survival/fish.json` or attach
  fishing to the existing `obtain_food` skill as an alternative source.

See [open-questions](open-questions.md) and the consolidated status in
[roadmap](roadmap.md).
