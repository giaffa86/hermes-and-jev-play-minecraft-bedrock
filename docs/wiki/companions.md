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

## What is NOT implemented (riding as transport)

The current code only mounts to **tame**. It does **not** ride a mount around:

- no `ride_<mount>` / `mount_<mount>` action (mount + move + dismount);
- no **saddle** equipping (`horse`/`donkey`/`mule` need a saddle to be ridden);
- no control of a mounted mount (movement while riding, dismount);
- no mount inventory (donkey/mule chest, horse armor / nautilus armor equipping);
- no `axolotl` capture with a bucket, nor `nautilus` armor handling.

To add real riding, the likely pieces are: a `mount` action (empty hand
`interact`), a `saddle` equipping step via `item_use_on_entity` with the saddle
or `inventory_transaction`, a dismount (`player_action` `start_sneaking` / a
dismount input), and keeping the server-authoritative movement while mounted
(the `player_auth_input` `riding` flag, MetadataFlags1 bit 2).

## Verification status

Implemented and unit-tested (270 green tests). **Live verification pending**:
on the 03/10 round there were no companions near the bot, so `tame_<companion>`
was not exercised live; `feed_pig`/`breed_pig` (the closest farming actions)
were verified instead. The `tamed` vs `owner_eid` (runtime id vs unique id)
signal for tameable animals still needs a live confirmation.

## Related pages

- [roadmap](roadmap.md) — overall implementation status.
- [open-questions](open-questions.md) — blockers and verification gaps.
- [overview](overview.md) — project split and components.
