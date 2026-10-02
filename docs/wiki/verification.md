# Verification status (collaudi)

Consolidated checklist of every capability and its verification status:
what is verified live, what is unit-tested only, and what is still pending a
live round. This is the single place to look before claiming something "works".

Legend:

- ✅ **Live-verified** — exercised on the real BDS and confirmed (server-world
  confirmation, inventory delta, flag, etc.).
- 🧪 **Unit-tested only** — packet shape + pure logic tested; no live round yet.
- ⏳ **Pending live** — implemented, needs a live round (resource/consent needed).
- ⚠️ **Regressed / broken live** — previously verified, now failing on the live BDS.
- ❌ **Not implemented**.

## How to run

```bash
# Unit tests (no server required)
node --test tests/*.test.mjs

# Live round — option A: drive the deployed harness on the Docker host via HTTP
ssh -i <ssh-key> hermesadmin@<ip-host>
sudo docker exec hermes-jev-bedrock node -e \
  'fetch("http://127.0.0.1:3077/observe").then(r=>r.json()).then(console.log)'
# POST /act {"key":"..."} to run one action; POST /plan to set a waypoint.

# Live round — option B: local scripts (stop the container first, one bot account)
node --env-file=.env test-connect.mjs      # connection + spawn
node --env-file=.env test-movement.mjs     # pathfinding toward a waypoint
node --env-file=.env test-survival.mjs     # survival gate
node --env-file=.env test-reconnect.mjs    # 3 logins / teardown
```

> One bot account only: stop the container before a local round
> (`ssh hermesadmin@<ip-host> 'sudo docker stop hermes-jev-bedrock'`). On
> `connecterror:9`, restart the BDS at zero players (`systemctl
> stop/start minecraft-bedrock.service`).

## Collaudi table

| # | Capability | Actions / files | Status | Live collaudo (how to trigger) | Notes |
|---|---|---|---|---|---|
| 1 | Connection + spawn | — | ✅ | `test-connect.mjs` or watch `/observe` (`spawned:true`) | Bot appears as a real player. |
| 2 | Movement + pathfinding | `goto_waypoint` | ✅ | `POST /plan {waypoint}` then `goto_waypoint`; `test-movement.mjs` | Server-authoritative + A*, doors opened. |
| 3 | Mining (dirt/stone/logs/ores) | `mine_*` | ✅ | `/act mine_stone` etc.; `test-mining.mjs` | Tool auto-selection, vanilla break times, server confirmation. |
| 4 | Drop collection | `collect_drop` (+ auto-pickup) | ✅ | `/act collect_drop` after a drop | `take_item_entity` confirmation. |
| 5 | Crafting (2×2 / 3×3) | `craft_*` | ✅ | `/act craft_planks` … | `crafting_data` recipes, `item_stack_request`. |
| 6 | Placement | `place_*` | ✅ | `/act place_crafting_table` | `click_block` + world confirmation. |
| 7 | Smelting | `smelt_*` | ✅ | `/act smelt_raw_iron` (furnace + coal) | `iron_ingot` obtained live 02/10. |
| 8 | Combat vs hostiles | `attack_<mob>` | ✅ | `/act attack_zombie` with a mob nearby | Hits land; low damage without a sword. |
| 9 | Flee | `flee` | ✅ | `/act flee` with a hostile nearby | Real separation measured. |
| 10 | Sleep | `sleep` | ✅ | `/act sleep` at night near a bed | `resting` flag / night-skip. |
| 11 | Dig down/up (stairs) | `dig_down`, `dig_up` | ✅ | `/act dig_down` then `dig_up` | `DIG_PROTECTED` guards built blocks. |
| 12 | Death + respawn + loot | `recover_loot` | ⚠️ | die in combat, then `/act recover_loot` | `deathSite`/`recover_loot` verified earlier; **respawn currently stuck on live BDS 1.26.52** — server never answers `player_action respawn` (see [open-questions](open-questions.md)). |
| 13 | Eat | `eat` | ⏳ | `/act eat` with hunger < 20 and food in inventory | Unit-tested; needs the right state live. |
| 14 | Storage read | `read_container` | ✅ | `/act read_container` | 6 chests/barrels read live 03/10. |
| 15 | Storage take/deposit | `take_<item>`, `deposit_<item>` | ⏳ | `/act take_iron_ingot`, `/act deposit_diamond` | Unit-tested; take/deposit delta live pending. |
| 16 | Trading | `open_trade`, `trade_<index>`, `close_trade` | ⏳ | `/act open_trade` on a villager | Final trade transaction + tier-up pending. |
| 17 | Trader levelling | `level_<profession>` | ⏳ | `/act level_farmer` | Cheap-only economy; live tier-up pending. |
| 18 | Follow human / chat | `follow_player` (+ `@bot` M1–M3) | ⏳ | chat `@bot seguimi` with a human online | Wiring + unit tests; live pending. |
| 19 | Plant / resow crops | `plant_<seed>` | ✅ | `/act plant_potato` on free farmland | `plant_potato` re-sowed live 03/10. |
| 20 | Feed farm animals | `feed_<animal>` | ✅ | `/act feed_pig` with carrot | `inlove` confirmed live 03/10. |
| 21 | Breed farm animals | `breed_<animal>` | ✅ | `/act breed_pig` (2 adults + 2 carrots) | Baby pig `baby:true` live 03/10. |
| 22 | Throw egg | `throw_egg` | ✅ | `/act throw_egg` with an egg | Consumed; `chick: none` live 03/10. |
| 23 | Hunt farm animals | `attack_<animal>` | ⏳ | `/act attack_pig` | **Needs user consent** (kills a family animal). |
| 24 | Tame (food) | `tame_wolf`/`tame_cat`/`tame_ocelot`/`tame_parrot` | ⏳ | `/act tame_wolf` with bone | `tamed`/`trusting`/`owner_eid`; live pending. |
| 25 | Tame (ride) | `tame_horse`/`tame_donkey`/`tame_mule`/`tame_llama`/`tame_nautilus` | ⏳ | `/act tame_horse` | Mount-until-`tamed`; live pending. |
| 26 | Shear | `shear_sheep` + `craft_shears` | ⏳ | `/act craft_shears` then `/act shear_sheep` | Needs sheep + 2 iron ingots; live pending. |
| 27 | Ride as transport | `mount_<vehicle>`, `dismount`, `goto_waypoint` (mounted) | ⏳ | place a boat → `/act mount_boat` → `/act goto_waypoint` → `/act dismount` | `set_entity_link` + `client_predicted_vehicle`; live pending. |
| 28 | Fishing | `cast_rod`, `fish`, `reel_in`, `craft_fishing_rod` | ⏳ | `/act fish` at a shore with a rod | Pure module + tests; live pending. |
| 29 | Tool durability (long ore runs) | — | 🧪 | mine many stone/ore blocks, watch `heldDurability` | Only unit-tested. |
| 30 | `CURRICULUM=first_night` end-to-end | controller + curriculum | ⏳ | run controller with `-e CURRICULUM=first_night` | Full autonomous round not run. |
| 31 | Real multiplayer (Phase 10) | — | ⏳ | join with a human player online | Both players visible; not run. |

## Still not implemented

- Milk (bucket + cow); mature-crop growth detection.
- Defense: `place_torch`, `craft_*_sword`, `retreat`/`go_home`, `close_door`,
  `barricade`, armor equip/points, shield.
- Riding extras: saddle equipping, mount inventory/armor, `rider_jump`,
  minecart steering, boat paddling animation.
- Axolotl capture with a bucket.
- Human chat channel M5 (ack/reply) and autonomous exploration.

## Related pages

- [roadmap](roadmap.md) — implementation status per `.private/` task.
- [open-questions](open-questions.md) — blockers and verification gaps.
- [companions](companions.md) — taming/riding companion animals.
- [headless-client](headless-client.md) — how the bot perceives/acts.
