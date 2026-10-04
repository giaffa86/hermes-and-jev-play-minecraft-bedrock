# Companion animals: taming, riding and census

What the bot can do with companion animals (cats, wolves, parrots, rideable
mounts, axolotl, nautilus), what is implemented, and what is still missing.
Sources: `bedrock-survival.mjs`, `bedrock-adapter.mjs`, `BEDROCK.md`
(action status + Farming and companions section).

## Categories

| Category | Types | How it is befriended/tamed | Confirmation signal |
|---|---|---|---|
| Food-tameable | `wolf`, `cat`, `ocelot`, `parrot` | `tame_<type>`: repeated `item_use_on_entity` `interact` with the right food | `tamed` (flags bit 28) for wolf/cat/parrot; `trusting` (flags_extended bit 1) for ocelot; `owner_eid` (key 5) |
| Ride-tameable | `horse`, `donkey`, `mule`, `llama`, `nautilus` | `tame_<type>`: mount repeatedly with an empty hand until the mount stops bucking | `tamed` (flags bit 28) |
| Attractable (not tameable) | `axolotl` | none — follows a player holding a bucket of tropical fish; can be caught in a bucket | none (no `tamed`/`trusting` flag) |

Feeds (`TAME_FEED`): `wolf`→`bone`; `cat`/`ocelot`→`cod`/`salmon`;
`parrot`→`wheat_seeds`/`melon_seeds`/`pumpkin_seeds`/`beetroot_seeds`.

The **nautilus** is the recently added aquatic companion (it has its own armor
set: copper/iron/golden/diamond/netherite nautilus armor, like horse armor). It
is classified as ride-tameable here; its exact taming/riding mechanic still
needs a live round on the BDS.

## What is implemented

- **Census** (`/observe.companions`): `_nearbyCompanion` lists every companion
  within 32 blocks with type, distance, health, `tamed`, `trusting`, `baby` and
  `ownerEid`.
- **Metadata**: `tamed` (MetadataFlags1 bit 28), `trusting` (MetadataFlags2 /
  key 92, bit 1) and `owner_eid` (key 5) are parsed from `set_entity_data`.
- **Taming** (`tame_<companion>`): two paths in `_tameAnimal`:
  - *food*: `_feedEntity` (equip food → `item_use_on_entity` `interact`) until
    `tamed`/`trusting`/`ownerEid` appears;
  - *ride*: `_mountEntity` selects an empty hotbar slot (food in hand would feed
    instead of mounting), approaches and `interact`s until `tamed`.
- **Options**: `tame_<type>` is offered for each wild companion — with the food
  item for food-tameable types, and mount-based for rideable types.

## Riding as transport

Riding is now wired (`mount_<vehicle>`, `dismount`, `_rideToward`):

- **Mount** (`mount_<type>`): empty hand + `item_use_on_entity` `interact`;
  confirmed by the rider→vehicle link (`set_entity_link`, `Link.type` 1 = rider),
  tracked in `this.riding`.
- **Ride**: while mounted, `goto_waypoint` calls `_rideToward` — continuous
  forward `player_auth_input` with `client_predicted_vehicle` (45) + `up`, no
  local physics; the server moves the vehicle and corrects position via
  `correct_player_move_prediction` (`prediction_type: 'vehicle'`).
- **Dismount** (`dismount`): `player_action` `start_sneak`; `Link.type` 0 clears
  `this.riding`.
- **Vehicles**: `isVehicleType` covers boats (`…_boat`, `…_chest_boat`,
  `bamboo_raft`) and minecarts (`…_minecart`); `isRideableType` adds the
  ride-tameable mounts (`horse`/`donkey`/`mule`/`llama`/`nautilus`).

### Live round (2026-10-03): the server does not confirm the mount

`mount_donkey` against the live BDS 1.26.52 donkey (saddled, 0.75 blocks away)
ends with `mount_not_confirmed` after 20-26 s. The evidence says the packet
arrives: the event log shows 10 `interact {target: 'donkey', distance: 0.75}` and
the server answers with the **donkey's saddle inventory**
(`inventory_slot {window_id: 2, slot: 0, item: 'saddle:1:579'}` plus an
`inventory_content` for `anvil_input`) instead of linking the rider — no
`set_entity_link` ever arrives. Both shapes were tried: the vanilla
`inventory_transaction` with `transaction_type: 'item_use_on_entity'` (what
`_interactEntity` sends) and the bare `interact` packet with `action_id: 0`
(absent from the 1.26.51 map, which only names 3..6); both are ignored. The
transport is not the problem — the same `inventory_transaction` with
`action_type: 'attack'` kills entities live. The working hypothesis is that BDS
1.26.52 expects a trigger we cannot reconstruct without a packet capture from a
real client that mounts (no human player ever joins: see the multiplayer blocker).
`dismount` answers `{ok: true, alreadyDismounted: true}` when riding is unknown.

Companion refusals observed live in the same round: `shear_sheep` →
`missing_shears`, `tame_wolf` → `missing_feed {bone}`, `breed_pig` →
`need_2_feed {carrot}` (the inventory was empty after a death), `fish` →
`missing_fishing_rod`. All of them are typed and immediate — a missing tool is
reported instead of a fake success.

**The cat's food was a Java name (fixed 03/10/2026).** The first live `tame_cat`
of the campaign answered `missing_feed {feed: raw_cod/raw_salmon}` while the bot
was carrying **nine salmon**: the table used the Java spellings, so taming a cat
or an ocelot was impossible no matter what the inventory held. Evidence for the
repair, in order of authority:

- the prismarine registry for `bedrock_1.26.51` (the same loader as
  `bedrock-world.mjs`) has no `raw_cod`/`raw_salmon` and no `beetroots` block —
  the server-side names are `cod`, `salmon`, `beetroot`;
- the server's own behaviour pack agrees: `vanilla_1.26.10/entities/cat.json`
  declares `"minecraft:tameable".tame_items: ["fish", "salmon"]`, where `fish` is
  Bedrock's legacy id for `cod` (the pack is read-only reference, not an edit);
- live, after the deploy, the same two calls answer `missing_feed {feed:
  cod/salmon}` (the refusal now names an item that exists), and `/observe.nearby`
  carries a `beetroot` bucket — the crop census and `DIG_PROTECTED` used the Java
  plural too, so beetroot could never be found, harvested or protected;
- offline, a **registry guard test** (`tests/bedrock-survival.test.mjs`) checks
  every item name in `TAME_FEED_MAP`, `ANIMAL_FEED_MAP`, `FOODS`,
  `PLANTABLE_ITEMS`, `BUCKET_INGREDIENTS`, `SHIELD_INGREDIENTS` and every block
  name in `SEED_TO_CROP_MAP`/`CROP_MAX_GROWTH_MAP` against the registry, and
  asserts that `raw_cod` and `beetroots` never come back.

Two misleading errors were fixed in the same round: `ride` and `follow_player`
answered `unknown_action` (they are not standalone keys — while mounted the bot is
steered with `goto_waypoint`, and `follow_player` needs a plan target). They now
answer `not_riding` / `no_ride_destination` and `no_player_target` with a hint.

### 2026-10-04: a free hand and no sneak (why the mount never linked)

A human player joined the live server for the first time in the campaign, so the
rule behind that failure became **observable** instead of guessed:

| state | right click | effect |
|---|---|---|
| no sneak, no tool in hand | `interact` | **mounts** |
| sneaking | `interact` | opens the animal's inventory (saddle/armor) |
| shears in hand | `interact` | "use tool on entity": saddle on/off, lead off |
| mounted, then shift | — | **dismounts** |

The 03/10 round answered with the donkey's **saddle window** because the server
read our interaction as a sneak (and/or as "use the held item"), and the bot was
in exactly that state. Two real defects sat behind it:

1. `_selectHotbarSlot (index, { allowEmpty = false })` — the mount code asked for
   an **empty** hotbar slot to free the hand, but the method refused precisely
   that (`if (!item?.network_id) return false`), so the bot kept the previous item
   in hand: the "empty hand" the comment promised never happened.
2. `player_action` was written as `{ runtime_entity_id, action }` only. The
   1.26.51 schema also wants `position`, `result_position` and `face`, so
   serializing it throws (`SizeOf error for undefined … reading 'x'`): the
   `start_sneak` of the dismount would never have left the client and the sneak
   flag would have stayed on. All writes now go through
   `_sendPlayerAction (action)`, and `_dismount` clears the flag with
   `stop_sneak` once the link is gone.

`_freeHands (reason)` does both steps: `stop_sneak` when the adapter believes it
is sneaking, then an empty hotbar slot (`{network_id: 0}`); if the hotbar is full
it keeps the block it holds (not a tool) and logs `hand_not_empty`. `_mountEntity`,
`_mountVehicle` and the trade-open loop call it, and `mount_not_confirmed` /
`trade_not_opened` now report the hand state they used.

### Still not implemented

- **Saddle** equipping for `horse`/`donkey`/`mule` (they need a saddle to be
  steered once ridden).
- Mount **inventory/armor** (donkey/mule chest, horse armor, nautilus armor).
- `rider_jump` (mount jump) and **minecart steering on rails** (the current ride
  is a straight "forward toward the waypoint" heuristic).
- Boat `paddling_left`/`paddling_right` (46/47) oar animation flags.
- `axolotl` capture with a bucket.

## Verification status

Implemented and unit-tested (the registry guard test in
`tests/bedrock-survival.test.mjs`, 2026-10-03). **Live verification pending**:
on the first 03/10 round there were no companions near the bot, so
`tame_<companion>` was not exercised live; `feed_pig`/`breed_pig` (the closest
farming actions) were verified instead. The `tamed` vs `owner_eid` (runtime id vs
unique id) signal for tameable animals still needs a live confirmation.

**Round 03/10/2026 (later): the food table is now right, the positive path is not
run yet.** After the naming fix the live calls answer `tame_cat` →
`missing_feed {feed: cod/salmon}` and `tame_ocelot` → the same, `feed_pig` →
`missing_feed {feed: carrot}`, `shear_sheep` → `missing_shears` — every refusal is
typed and instant. The positive tame (eat the feed, walk to the animal, `interact`,
read `tamed`/`trusting`) is blocked by the **world**, not the code: the village
chest that held the only `cod`/`salmon` (`73,71,153`) now reads empty, as do the
potato chest `(72,72,152)` and the rest of the village store, so no raw fish,
carrot or shears remain in reach and there is nothing to feed with. Recorded in
[open questions](open-questions.md). While the feed is missing the `_tameAnimal`
chain beyond item lookup (approach within 4.5 blocks, `item_use_on_entity
interact`, `tamed` confirmation) stays covered by unit tests only.

**Round 03/10/2026 (afternoon): the shearing chain ran live; the tame chain still has nothing to eat.** With iron taken from the village chest (`take_iron_ingot` → 64), `craft_shears` → `{ok:true, crafted:'shears', count:1}` and then **`shear_sheep` → `{ok:true, sheared:true, type:'sheep'}`** — the action found a sheep within 64 blocks and walked to it, so the search + approach + `item_use_on_entity` + confirmation chain is live-verified. The `yellow_wool` drop then appeared in `GET /observe.drops` at 2.3 blocks with `reachable: true`, but the bot had already walked on and `collect_drop` answered `no_drop_nearby`: the wool never entered the inventory, so the *drop* side of shearing is still unit-tested. `milk_cow` (the same `item_use_on_entity` + inventory-delta pattern, see row 19.2 of [verification](verification.md)) is live-verified too. The **tame** chain is still refused live with the right names (`missing_feed {feed: cod/salmon}`): every step after the item gate (approach within 4.5 blocks, `interact`, `tamed` confirmation) remains covered by unit tests only.

## Related pages

- [roadmap](roadmap.md) — overall implementation status.
- [open-questions](open-questions.md) — blockers and verification gaps.
- [overview](overview.md) — project split and components.
