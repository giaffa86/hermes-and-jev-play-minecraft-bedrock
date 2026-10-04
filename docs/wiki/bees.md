# Bees, honeycomb and bottled honey

Status (2026-10-04): **implemented and offline-tested; not deployed or live-verified**.
The bot stays OFF under the [campaign operating policy](verification.md#how-to-run).
Sources: [adapter](../../bedrock-adapter.mjs), [pure bee rules](../../bedrock-bees.mjs),
[tests](../../tests/bedrock-bees.test.mjs), [Bedrock harness](../../bedrock-harness.mjs),
and the official references below.

## Documented game behavior

The official [Bedrock Buzzy Bees release notes](https://feedback.minecraft.net/hc/en-us/articles/360037105792-Minecraft-Buzzy-Bees-1-14-0-Bedrock)
describe harvesting a full hive/nest with shears (honeycomb) or an empty bottle
(honey), and campfire smoke calming bees during harvest.
[Bedrock beta notes](https://feedback.minecraft.net/hc/en-us/articles/360034989811-Minecraft-Beta-1-14-0-1-Xbox-One-Windows-10-Android)
specify maximum honey level 5 and flower-based breeding.
Mojang's [vanilla Bedrock bee definition](https://github.com/Mojang/bedrock-samples/blob/main/behavior_pack/entities/bee.json)
provides the breeding/feeding flower names. The implementation uses a closed
subset of those names; it excludes wither roses and the special golden dandelion.

Before this feature, the repo supported finding bees through exploration and
retrieving `honeycomb` from remembered containers. It had no apiculture actions.

## Observation and bounded actions

`GET /observe` includes `bees`; `GET /observe.bees` forces hive discovery.
The view includes nearby bees (baby, love and anger flags), the available flower,
and hive/nest positions with honey level, smoke verdict, distance and reachability.
It reports neither hidden occupants nor pollen production: these are not known
from the observed block/entity state.

Discovery is limited to **16 hives within 24 blocks**, with a three-second cache
keyed by dimension and player cell. Hive and smoke states are reread on every
view. Explicit harvest always rediscovers its target, then rechecks state after
approach, equipment and the look tick.

| Action | Requirements and confirmation |
|---|---|
| `harvest_honeycomb` | Shears, a full reachable smoked hive/nest, no angry bee in the census. One main-hand `click_block`. Success requires a honey-level reset to 0 plus either an inventory increase or a newly observed honeycomb drop within three blocks of the hive. |
| `harvest_honey` | Empty glass bottle and the same hive safety gates. One `click_block`. Success requires both a honey-bottle inventory increase and a decrease in empty bottles. |
| `feed_bee` | Supported flower, a calm bee within 4.5 blocks with readable clear line of sight, not already in love. One interaction; success requires flower consumption or the bee's love flag. Babies may be fed; their growth is not claimed as measured. |
| `breed_bee` | Two supported flowers (mixed kinds allowed), two calm adult bees within interaction range and four blocks of each other. Feed both, then require a newly tracked baby bee near the pair; two successful feeds alone are insufficient. |
| `craft_beehive` | An available server recipe, its ingredients, and its required crafting table. |
| `craft_honeycomb_block` | Same recipe-driven gate. |
| `craft_honey_block` | Same recipe-driven gate. |
| `craft_candle` | Same recipe-driven gate. |

Crafting reuses the existing item-stack transaction path; no recipe quantities
are invented locally. All four apiculture interactions map to `collect` for
the survival intent filter. `harvest_honey` also receives goal priority for a
`honey_bottle` target in the controller's capped option list.

Actions use the existing HTTP contract, for example:

```bash
curl http://127.0.0.1:3077/observe.bees
curl http://127.0.0.1:3077/options
curl -X POST http://127.0.0.1:3077/act \
  -H 'Content-Type: application/json' -d '{"key":"harvest_honeycomb"}'
```

## Safety and bounded confirmation

The supported smoke layout is deliberately conservative: a **known lit campfire
or soul campfire directly below**, or separated by **one air block**. Any other
intervening block, unreadable cell, missing fire or unknown fire state refuses
harvest. The gate does not claim to model every smoke layout the game accepts.
The installed Bedrock 1.26.51 registry supplies `honey_level` and `extinguished`;
tests enumerate real registry states rather than assuming Java's `lit` property.

Harvest may spend up to eight seconds on approach, then five seconds waiting for
confirmation. Feeding waits three seconds after one interaction; breeding waits
up to eight seconds after feeding both adults. Equipment uses the existing
bounded hotbar path with reconnect/resync disabled. A lost or replaced client
aborts the action, including between the two feeds.

Honeycomb usually becomes a world drop. The result distinguishes `dropped` from
`collected`: drop evidence can confirm harvest with `collected:0` and
`nextAction:"collect_drop"`. It does **not** satisfy an inventory target until
pickup is observed. A honey reset alone, a preexisting drop or an unconverted
glass bottle cannot produce success. Interrupted actions report uncertainty;
they never retry an unsafe click automatically.

Hives, nests and campfires are protected from mining/digging, including explicit
`mine_*`, the common mining primitive and owned-placement recovery. These actions
do not install or ignite campfires, break nests, move bees or infer hidden hive
occupancy. Hive placement, waxing copper and dispenser harvesting are outside
this feature.

## Verification

**24 bee tests; complete suite 1150/1150, zero failures.** Coverage includes real
Bedrock palette states, fresh safety checks, blocked/unreadable sightlines,
single-click transactions, product evidence, disconnects, hive protection,
mixed-flower breeding, existing-baby rejection and server-recipe crafting gates.

A future bounded live round needs an existing full hive/nest with the supported
lit campfire layout and shears or an empty bottle. Record the view, one harvest,
its server evidence and (for honeycomb) pickup before stopping the bot. Feeding,
breeding and the new crafting outputs also remain live validation gaps.

Related: [companions](companions.md), [verification](verification.md),
[roadmap](roadmap.md), [control flow](control-flow.md).
