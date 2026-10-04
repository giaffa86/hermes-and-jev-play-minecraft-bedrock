# Fishing (rod, cast, bite, reel)

Fishing in the Bedrock port. Status: **implemented, offline-verified
(03/10); the bobber gets a verdict (04/10); the live cast is blocked on a rod**
(the inventory is empty after a death — see the live round below).
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
- **Bobber verdict** (added 04/10): `bobberVerdict ({ bobber, blockAt })` in the
  pure module answers *where the hook landed* and whether a bite can arrive
there. A bobber floats on the surface, so «in water» counts both the cell it
occupies and the cell below it; a cast that lands on land answers
`{ ok: false, reason: 'not_in_water', at, below }` and `_castRod` **refuses**
with `bobber_not_in_water`, reeling the line back in immediately — previously
the bot waited out the whole 5–30 s bite window and then reported `no_bite`,
which blamed the server for a hook lying on the grass. Water with a solid block
over the surface is **not** refused: the report carries `covered: true` (the
village well is exactly this shape), because whether a covered pool bites is a
game rule the harness must not invent. An unreadable world (`blockAt` absent or
both cells unknown) is **fail-open** (`{ ok: true, reason: 'unknown' }`), so a
missing chunk never turns into a false refusal. `/observe.fishing.bobber`
exposes the same verdict for a cast already in the water.

## Acceptance criteria

- `craft_fishing_rod`: `fishing_rod` +1, 3 sticks + 2 string consumed.
- `cast_rod`: `fishing_hook` entity observed (or no error and rod still in hand).
- `cast_rod` on a hook that lands on **land**: typed `bobber_not_in_water` with the
  `verdict` (`at`/`below` block names) and the line recovered, never a 30 s wait
  followed by `no_bite`.
- `reel_in`/`fish`: at least one fish in the inventory delta, `food` tag count
  increased.
- `attack_spider → collect_drop → string`: string in the inventory delta.
- No base blocks destroyed, no villager hit, the bot stays on shore.
- Unit tests green (`node --test tests/*.test.mjs`).

## Verification status

The pure module and the adapter wiring are covered by unit tests
(`tests/bedrock-fishing.test.mjs`, 20 tests: the pure module including the 04/10
`bobberVerdict`, and the adapter's `_fish`/`_castRod`). **The live round ran on
03/10/2026** and closed the supply chain up to the cast:

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

### 2026-10-04: the bobber gets a verdict, and the rod is gone

`bobberVerdict` closes the ambiguity that the 03/10 round left open. «Five runs
without a bite» had two possible readings — the hook was not really in (open)
water, or the server never sends the bite to this client — and the round could
not tell them apart because the bobber's cell was never checked. Now the cast
reports it: `tests/bedrock-fishing.test.mjs` grew from 14 to 20 cases (the
verdict's land/surface/inside/covered/unknown branches, plus two `_castRod` cases
proving the land cast is **refused and reeled in**, and that a covered surface is
still a valid cast carrying `covered: true`); suite **1108 pass / 0 fail**.
Deployed to the live container (adapter + module, md5 verified) and confirmed on
`/observe.fishing`, which now carries the new `bobber` field (`null` with no cast
out).

The **live cast could not be repeated**: the fishing rod is gone. The bot died in
a cave on the night of 03-04/10 (night walk into a zombie fight, `deaths: 1`) and
a Bedrock respawn empties the inventory, so `fishing_rod`, the 42 string, the
shears and the wool all went with it. Nothing reachable replaces them: the seven
village chests that can be read (and the 27 containers the memory knows) hold no
`string`, no `fishing_rod` and no `stick` — the 42 string came from the bot's own
drop chest at `(92,73,165)` and was taken out for the 03/10 rod. The only string
sources left are spiders (night) or a mineshaft's cobwebs, i.e. a weapon first
(`craft_wooden_sword` needs a crafting table within 32 blocks; the chest holds a
`crafting_table` and one `oak_log` is already in the inventory → planks → sticks
is one craft away). That round was started and then interrupted: sessions on the
BDS now die every ~2 minutes (`connecterror:9`, see
[open-questions](open-questions.md) § NetherNet instability), so a multi-step
gameplay errand cannot be completed in one window.

**What is left for `p2-fishing`**: one cast with a rod in hand, next to water at
the bot's level, and then either the bite (success) or `no_bite` with
`verdict.reason: 'on_surface'`/`'in_water'` and `covered: false` — which would
finally prove the server sends no `fish_hook_hook` to this client (the same
evidence class the mount and the trade need).

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
  No artificial pond is needed. **Update 04/10**: the pond in front of the village
  houses is a **well** — water at `y=73-74` with a solid surface at `y=75` — so it
  is a `covered: true` cast, while the open water of the world (a 256-block lake, and
a flooded ravine 13+ blocks underground) is the water the 03/10 cast used. The
water is fine; the rod is what is missing, and with it the string of the recipe.
- Should `mine_cobweb` be added for string (only if a cave/mineshaft is nearby)?
  `attack_spider`/`attack_cave_spider` already exist as the primary string source.
- Optional: a declarative skill `skills/gameplay/survival/fish.json` or attach
  fishing to the existing `obtain_food` skill as an alternative source.

See [open-questions](open-questions.md) and the consolidated status in
[roadmap](roadmap.md).
