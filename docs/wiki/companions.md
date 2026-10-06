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

### 2026-10-04: an unreachable mount is refused, not hammered

The live round of 04/10 gave the mount code a second blind spot: `_mountEntity`
interacted with whatever the entity map held, so a donkey 4.6 blocks **below** the
bot (outside the walkable component, `_moveTo` could not descend) collected six
`interact`s over 20-26 s before the action failed as `mount_not_confirmed`. A knob
in the code, not a fact about the world.

`_entityVisible (entity, { ratio = 0.5, samples = 3 })` samples the eye→aim
segment against `this.world.blockAt` (fail-open `{visible:true, unknown:true}`
when the chunk is not loaded) and `_mountEntity` now refuses before writing
anything:

```
{"ok":false,"error":"vehicle_unreachable"}      # donkey 15 blocks away, 6 below
```

with `mount_target_blocked { blockedBy, at }` logged when the line of sight is
what fails instead. The same primitive gates the trade loop (see
[trading](trading.md)), and `_nearbyTraders` now reports the `baby` flag so a
baby villager — which can never trade — is distinguishable from a refusal.

### 2026-10-04 (later): the link packet was never read

The mount confirmation has a client-side bug of its own, found by dumping what the
server sends while the bot interacts. `packet_set_entity_link` carries **one**
`link` (`{ridden_entity_id, rider_entity_id, type, immediate, rider_initiated,
angular_velocity}`), but the handler iterated `packet.links`: the loop never ran, so
**no link was ever applied** — the mount link (type 1) and the dismount link
(type 0) both fell on the floor and `this.riding` stayed `null` for the whole
campaign. The live evidence is a `[packet] { name: 'set_entity_link' }` arriving
during a `mount_donkey` attempt while no `[mount]` was logged.

The handler is now `_onEntityLink (packet)` (single `link`, a `links` array is
still accepted; a link whose rider is not this client is logged as
`entity_link_other`), covered by `tests/bedrock-riding.test.mjs` (16 cases: the
single-`link` shape, a rider that is somebody else, type 0 clearing the state).

**After the fix the mount still fails, and the reason is not ours to fix blind**:
the server never sends that link for our interact. Its only reaction to
`item_use_on_entity {action_type: 'interact'}` on a saddled, tamed, adult donkey
0.75 blocks away with a clear sightline (`air,air,air`) is the donkey's
**inventory window** (`inventory_slot {window_id: 2, slot: 0, item: 'saddle:1:…'}`
plus an `inventory_content`), i.e. the server reads the use as the **sneak**
behaviour. Measured and ruled out on the live server (see
[open-questions](open-questions.md) §Mounting):

- `interaction_model` in the auth frames (`touch` vs `crosshair` vs `classic`): no
  difference;
- the 13 `PROBE_VARIANTS` shapes (`legacy` present/absent, `legacy_request_id`,
  `hotbar`/`held_item`, `item_interact` before/after, `animate swing_arm`,
  `mouse_over_entity`, numeric `transaction_type`): the probe sends *no* reaction
  at all on the donkey (0 resyncs, no window, no link) — the window only appears
  in the **action** path, after the repeated frames of a full action attempt;
- a stale sneak flag: `_freeHands` now sends `stop_sneak` **unconditionally**
  before every interaction (a command, not an assumed state), and the mount still
  ends `mount_not_confirmed`.

### 2026-10-06: boarding the human's boat (detect in production, join behind a flag)

`follow_player` can never deliver on a boat: it is a locomotion intent
(`survival/intents.mjs`, `follow_player: ['travel']`) whose only primitive is
`_moveTo`, and the option is offered only when `entityApproachable(follow,
{range: 3, dy: 2})` — on deep water it disappears and the bot falls back to
`seek_player` on the last known position, i.e. it walks along the shore while the
boat leaves. Boarding is a different action, so it is a different option:
`join_human_mount`. The mission is split into the three pieces the design asks
for.

- **detect** — the server's rider→vehicle links are now kept for *every* rider,
  not only for the bot (`this.entityLinks`, filled in `_onEntityLink`; a non-self
  link used to be logged as `entity_link_other` and discarded), and the `riding`
  flag (flags bit 2) is parsed for other entities too as a fallback before the
  link arrives. `_humanMountView()` answers *which* vehicle the followed human is
  on: from the link (source `link`), or — when the flag says he is riding but no
  link is in yet — the nearest candidate within 6 blocks with
  `mountCapacity(entity) >= 2` (source `proximity`: a good guess, not proof).
- **decide** — `bedrock-mount-follow.mjs` is a pure state machine, unit-tested
  with no server: `FOLLOWING → HUMAN_MOUNT_DETECTED → JOINING_HUMAN_MOUNT →
  RIDING_WITH_HUMAN → FOLLOWING`, with controlled exits to `WAITING_AT_SHORE`
  (`human_mount_unreachable`, `human_mount_full`, `human_mount_unsupported`,
  `join_disabled`, `human_mount_attempts_exhausted`).
  `seatInfo(entity, {riders})` (`bedrock-survival.mjs`) answers
  seats/riders/free with a typed `reason` (`unsupported` = one-seater, `full` =
  no free seat), and capacity is per **entity** (`mountCapacity`) and not per type
  name, so a variant can change it later.
- **act** — `join_human_mount` is dispatched *before* `mount_boat`/`mount_<type>`
  (which board the nearest vehicle of a type, not the human's) and before every
  locomotion fallback, and `optionPriority` ranks it 1.5: above `follow_player`
  (2) and every `mount_*` (8). `_joinHumanMount` targets the human vehicle's
  `runtimeId` — not "the nearest of that type" — approaches to ≤4.5 blocks, looks
  and interacts on the same path as `_mountVehicle`.

The **join itself stays behind `BEDROCK_JOIN_HUMAN_MOUNT=1`** (default off) for the
reason above: the server does not confirm our interact, so a real join would end
`mount_not_confirmed` anyway. With the flag off the refusal is typed and instant
(`join_human_mount_disabled`) and no packet is written.

What the mission already delivers in production is the **worst case removed**:
when the bot cannot board (seat taken, one-seater, unreachable, flag off) the
controller says where it waits — `mount_waiting_shore` in the five languages ("I
could not get on your oak boat: I am waiting here at x 0, y 64, z 0") — once per
episode (`MOUNT_WAITING_COOLDOWN_MS`, default 60 s), instead of ~45 s of silent
stalls. The typed reason stays in the logs (`mount_follow_state`,
`join_human_mount_order`, `mount_waiting_shore`), not in chat.

While the bot is a **passenger** the order stays open but idle: `mountRiding`
(`obs.mountFollow.state === 'RIDING_WITH_HUMAN'`) suppresses `follow_player`,
`seek_player` and `join_human_mount`, the ride is logged once as `mount_ride_hold`
and consumes neither step budget nor a model call (an executable survival need
still goes first), and the *lost human* notice is excluded — being carried is not
"I lost you". On dismount the state is `FOLLOWING` again and the deterministic
follow resumes by itself: the mission needs no second order, and getting off
stays the rider's decision (`dismount` is never acted on its own).

Tested offline: `tests/bedrock-mount-follow.test.mjs` (15 cases: capacity and
seat table, every transition and exit reason, the priority order against
`mount_boat`/`mount_donkey`/`mount_minecart`/`seek_player`/`goto_waypoint`/`wait`,
the non-self link and flag, the dispatch that never falls back to `_mountVehicle`,
the disabled-flag refusal with no packet written) and
`tests/controller-mount-follow.test.mjs` (3 scripted-harness cases: the boarding
order is acted four times in a row while `mount_boat`/`follow_player`/
`seek_player` stay unacted; the shore line is said exactly once, with
coordinates; and — with `follow_player`, `seek_player`, `mount_boat` and
`dismount` all offered — the bot acts *nothing* while carried for four
observations and then acts `follow_player` again on its own after the dismount).
**Live verification pending**, and the real join is still blocked on
the packet capture described in [open-questions](open-questions.md) §Mounting.

### 2026-10-04 (later): shearing verified live, taming blocked on fish

The companion round that had been blocked by the sealed room is now done on the live
server, and the success was checked from the server's side:

| step | live result |
|---|---|
| `take_shears` | `{ok:true, item:'shears', from:'chest', position:(72,71,153), inventoryDelta:1, ms:4965}` |
| `goto_waypoint (97,172)` | `{ok:true, distance:0.54, pathNodes:42}` |
| `shear_sheep` | `{ok:true, sheared:true, type:'sheep'}` |
| `/observe.drops` (independent) | `{item:'gray_wool', count:3, position:(87.76,73.06,171.40)}` |
| `collect_drop` | `{ok:true, picked:3, item:'gray_wool'}` → `gray_wool: 3` in the inventory |

**Taming** is the half that is still open, and it fails for a *material* reason, not a
protocol one: the four untamed cats are 15-21 blocks away and `tame_cat` answers
`{"ok":false,"error":"missing_feed","feed":"cod/salmon"}` before touching the world. The
feed table is the Bedrock one (`tameFeed('cat') = ['cod','salmon']`), and no chest in the
village holds raw cod or salmon — only `tropical_fish` and `pufferfish` — so the cat waits
for the fishing front (no bite yet) or for a fish to be brought home.

### Still not implemented

- **Saddle** equipping for `horse`/`donkey`/`mule` (they need a saddle to be
  steered once ridden).
- Riding as a **passenger on the human's** vehicle: detection, decision and the
  shore message are in production (see the 2026-10-06 round above), but the join
  itself is gated on the same missing `set_entity_link`.
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
