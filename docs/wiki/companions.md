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

Feeds (`TAME_FEED`): `wolf`→`bone`; `cat`/`ocelot`→`raw_cod`/`raw_salmon`;
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

### Still not implemented

- **Saddle** equipping for `horse`/`donkey`/`mule` (they need a saddle to be
  steered once ridden).
- Mount **inventory/armor** (donkey/mule chest, horse armor, nautilus armor).
- `rider_jump` (mount jump) and **minecart steering on rails** (the current ride
  is a straight "forward toward the waypoint" heuristic).
- Boat `paddling_left`/`paddling_right` (46/47) oar animation flags.
- `axolotl` capture with a bucket.

## Verification status

Implemented and unit-tested (383 green tests, 2026-10-03). **Live verification pending**:
on the 03/10 round there were no companions near the bot, so `tame_<companion>`
was not exercised live; `feed_pig`/`breed_pig` (the closest farming actions)
were verified instead. The `tamed` vs `owner_eid` (runtime id vs unique id)
signal for tameable animals still needs a live confirmation.

## Related pages

- [roadmap](roadmap.md) — overall implementation status.
- [open-questions](open-questions.md) — blockers and verification gaps.
- [overview](overview.md) — project split and components.
