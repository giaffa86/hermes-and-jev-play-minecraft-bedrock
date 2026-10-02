# Autonomous exploration (GOAL_EXPLORATION)

Topic: synthesis of the **Autonomous Exploration v1** milestone spec in
[`docs/raw/GOAL_EXPLORATION.md`](../raw/GOAL_EXPLORATION.md). It defines how the
bot should accept high-level search goals ("find a Cherry Grove", "find a
village", "find brown mushrooms"), explore the world autonomously and
reproducibly, and report a structured result. **Status: spec only — not
implemented** (this is the "no real exploration" gap tracked in
[open-questions](open-questions.md) and [roadmap](roadmap.md)).

## Goal and examples

High-level, natural-language targets that Hermes turns into an exploration task:

```
Trova un Cherry Grove.
Trova un Pale Garden.
Trova dei funghi marroni.
Trova un villaggio.
Trova una Trial Chamber.
```

The Player Bot explores new areas, avoids re-visiting the same zones, identifies
the target and produces a **reproducible** result. Local movement and immediate
decisions stay with the existing agentic pipeline / Jev.

## Fundamental principle

Exploration must **not** be one long LLM-generated action. It is a three-tier
split, mirroring the planner/controller design elsewhere:

```
LLM                          → high-level objective
deterministic exploration controller → next exploration objective
Jev                          → bounded local action (move/jump/swim/…)
```

This keeps a long search from degenerating into a single unbounded agentic
action; a mission can run for a long time as many small bounded steps.

## Milestones

| # | Milestone | What it adds |
|---|---|---|
| M1 | Find Biome MVP | persistent exploration-mission model, biome targets, deterministic planner (expanding square/spiral over unexplored chunks), checkpoints, biome detection, structured report, remain-at-target. |
| M2 | Route replay | return to an already-discovered place from saved checkpoints (`"torna al Cherry Grove"`); checkpoints are guides, local pathfinding may find better paths between them. |
| M3 | Escort player | walk the player to a discovered location (`ESCORTING` / `WAITING_FOR_PLAYER`, stop if the player lags, avoid pointless fights). |
| M4 | Search blocks/resources | extend `explore/find` to observable targets (mushrooms, pumpkins, bamboo, mangrove trees): `EXPLORE → SCAN → MATCH BLOCK/ENTITY → REPORT`. |
| M5 | Search structures | village, trial chamber, pillager outpost, woodland mansion, ancient city, desert pyramid, jungle temple; heuristic detection first (village = villagers + beds + village blocks + pattern), specific detectors later. |
| M6 | Underground targets | **caves** (`cave_air` volumes, lush/dripstone caves), **mineshafts**, **Deep Dark / Ancient City** (sculk, shriekers), **spawners** (`mob_spawner`); same mission model with a different `target`; warden/lava/spawner hazards and 3D navigation. |

## Exploration mission model (M1)

A persistent mission record, minimal fields:

```
id, type, target, status, origin, startedAt, completedAt,
currentPosition, targetPosition, distanceTravelled, chunksVisited,
route/checkpoints, result, failureReason
```

Status: `PENDING / RUNNING / PAUSED / FOUND / FAILED / CANCELLED`.

The target is always a **Minecraft ID**, never a natural-language string:
*"bioma dei ciliegi" / "foresta di ciliegi" / "cherry biome"* all resolve to
`minecraft:cherry_grove`. Initial biome set: `cherry_grove`, `pale_garden`,
`badlands`, `mushroom_fields`, `deep_dark`, `meadow`.

## Deterministic planner (M1)

- Expanding **square / spiral** outward from the origin over **new, unexplored
  chunks**.
- Avoid already-visited areas, prefer new chunks, keep memory of explored area,
  allow pause/resume and **restart of the service**, avoid loops.
- Priority is *deterministic, observable, reproducible* behaviour — not an
  optimal route.
- Sparse **checkpoints** are saved (not every move): enough to reconstruct the
  route, return to the target and later guide the player.

## Biome detection and report (M1)

The current biome is checked continuously; when `currentBiome == targetBiome`
the mission becomes `FOUND`. The saved result includes coordinates, biome,
timestamp, distance from origin and the route. A structured report (mission id,
target, status, origin, target position, `distanceFromOrigin`,
`distanceTravelled`, `chunksVisited`, `durationSeconds`) lets Hermes phrase a
natural answer:

```
Ho trovato un Cherry Grove a circa 4800 blocchi dalla base. Sono rimasto sul posto.
```

## Remain at target (M1)

After `FOUND` the bot does **not** auto-return. Default is `HOLD_POSITION`: stay
near the found point, keep the target as anchor, dodge danger and eat when
needed, and let the Survival Governor temporarily take priority.

## Travel survival kit and adaptation (multi-day expeditions)

> Requirement added on top of the raw spec: a search can take **several in-game
> days** (a biome may be thousands of blocks away), so a mission is an
> **expedition**, not a single walk. The bot must be prepared before it leaves
> and must survive the nights on the road.

### Pre-departure kit (loadout)

Before starting a mission the bot should carry (or craft on the way):

- food for several days;
- a stack of blocks (bridge / pillar / barricade);
- torches (lighting);
- a sword and any armor;
- **a bed** — or at minimum **wool + wood/planks** to craft one on the road
  (`craft_bed` = 3 wool + 3 planks, then `place_bed`);
- a crafting table (for on-the-road crafts);
- optionally a water bucket;
- **free inventory space** — a full inventory is a real failure mode on a long
  trip.

### Night survival, in order of preference

1. **Bed** (carried, or crafted from wool + planks): `sleep` skips the night
   instantly. Safest, but wool is the scarce input.
2. **Provisional hut**: seal a small shelter with blocks (`barricade` /
   `place_*`) and hide inside until dawn. Needs no wool, but the night passes in
   real time and the shelter must be dark-proof.
3. **Pillar up** (place a block under the feet, jump, repeat, dig down after):
   works against **ground** melee mobs but **not against flying mobs** (phantoms,
   etc.), so it is **not reliable** as a primary strategy.

In every case the Survival Governor handles hunger/health/hostiles and then
**resumes the mission** with the kit intact.

### Adaptation skills

- water crossing (swim / bridge), climbing, rough terrain;
- inventory management (consume/drop, avoid a full inventory mid-trip);
- resume after a Governor interruption without losing the route/checkpoints.

### Capability gaps for this

- `craft_bed` (3 wool + 3 planks) and `place_bed` — **not implemented** (wool is
  obtainable via `shear_sheep`).
- **Travel-kit / loadout** preparation (what to carry before leaving) — **not
  implemented**.
- **Inventory-full handling** (drop/consume or abort the trip) — **not
  implemented**.
- **Pillar-up** action — **not implemented** (the bot has `dig_up`/`dig_down`
  but no "place a block under the feet and climb").
- Shelter building uses `barricade`/`place_*` pieces but there is no
  "build a provisional hut" skill.

## Underground targets (M6)

Caves, mineshafts, the Deep Dark and spawners are the richest resource sources,
so they are first-class exploration targets (same mission model as M1, different
`target`). Targets resolve to Minecraft IDs:

```text
cave            -> cave_air volumes; cave / lush_caves / dripstone_caves biomes
mineshaft       -> mineshaft / abandoned_mineshaft (planks, rails, fences, cobwebs, spawner)
deep dark/city  -> deep_dark biome + sculk / sculk_shrieker / sculk_catalyst +
                   reinforced_deepslate + ancient_city
spawner         -> mob_spawner / monster_spawner block (+ mob type)
amethyst geode  -> amethyst_geode (bonus)
```

Heuristic detection first (cave = `cave_air` clusters or a vertical opening;
mineshaft = planks + rails + cobwebs + spawner; ancient city = an extended sculk
+ deepslate area; spawner = a visible `mob_spawner` block).

**Hazards and rules** (much harsher than surface exploration):

- **Deep Dark / Warden**: shriekers summon the Warden. Default is **observe and
  report** from a safe distance, never trigger more shriekers or loot without an
  escape route.
- **Spawners**: do **not** break a base's spawner without consent; for exploration,
  record it and optionally disable it with light on request. Mob/XP farming is a
  separate, gated milestone. Mineshaft cave-spider spawners are lethal in tight
  spaces.
- **Lava/water**: depends on [fluids](fluids.md) M0/M4 — never dig into lava,
  never open a shaft that breaks into a lava lake.
- **Darkness, gravel/sand collapses, falls, getting lost**: carry torches, leave
  checkpoints, keep a return route.
- **3D navigation**: the current A* is surface-oriented (support, ±1 steps, short
  falls); the underground needs 3D pathfinding plus dig/place/pillar, i.e. the
  AI-player "advanced navigation" milestone ([ai-player-roadmap](ai-player-roadmap.md)).
- **Underground kit**: torches, blocks (bridge/pillar), sword + armor, food, a
  water bucket, a pickaxe, and **free inventory space**.

## Exploration Skill API (target)

```
explore.findBiome(target)
explore.findBlock(target)
explore.findResource(target)
explore.findStructure(target)
explore.findCave()
explore.findMineshaft()
explore.findSpawner()
explore.findDeepDark()
explore.pause() / explore.resume() / explore.cancel()
explore.returnTo(resultId)
explore.escortTo(resultId)
```

## Separation of responsibilities

| Component | Owns |
|---|---|
| **Hermes** | intent, target resolution, mission creation, progress/reporting, user interaction. |
| **Exploration Planner** | where to explore, which zones are visited, checkpoints, mission progress. |
| **Jev / Player Agent** | bounded local actions: move, jump, swim, climb, interact, avoid obstacles. |
| **Survival Governor** | temporary interruption for health/hunger/night/hostiles/fall/equipment, then resume. |

## Definition of Done

`Rive, trova un Cherry Grove.` closes the feature when the system autonomously:
interprets the target → creates a persistent mission → explores new chunks →
survives the trip → recognises the biome → saves coordinates + route → produces
a report → stays on the spot → can return later → can escort the player there.

## Current status in the code

❌ **Not implemented.** What exists today is only the movement primitive layer:
`goto_waypoint` / `_moveTo` (A* pathfinding), `follow_player`, and the bounded
`/options` + `/act` loop. There is no exploration mission model, no expanding
spiral planner, no chunk-visit memory, no biome target resolution, and the bot
has no random walk / strip mining / cave exploration (M6 underground targets —
caves, mineshafts, Deep Dark, spawners — are spec only). There is also **no
persistent memory**: no landmark registry (home, sheep pen, chests) and the
chest cache is volatile (a reconnect wipes it) — see
[open-questions](open-questions.md#no-persistent-memory-landmarks-chests-chunks). The bot only "sees" loaded
blocks near it (see
[headless-client](headless-client.md#8-render-distance-not-comparable)), so
"go find X by yourself" is currently out of reach — the chat-channel roadmap
lists autonomous exploration as M5/out-of-scope in
[human-command](human-command.md).

This spec is the missing piece that the persistent-agent vision
([ai-player-roadmap](ai-player-roadmap.md), milestone 5/6: world awareness +
advanced navigation) depends on.

## Sources

- [`docs/raw/GOAL_EXPLORATION.md`](../raw/GOAL_EXPLORATION.md) — the milestone spec (Italian).
- `bedrock-adapter.mjs` — `_moveTo`/`goto_waypoint`, `follow_player`, chunk request radar.
- `bedrock-world.mjs` — `requestAround`/`findBlocks` (the perception cap behind the "no real exploration" limitation).

## Related pages

- [headless-client](headless-client.md) — how the bot perceives the world and why its render distance is limited.
- [human-command](human-command.md) — chat orders; autonomous exploration is its M5 (out of scope).
- [ai-player-roadmap](ai-player-roadmap.md) — persistent-agent roadmap (world awareness, navigation).
- [roadmap](roadmap.md) — consolidated status ("no real exploration" not implemented).
- [open-questions](open-questions.md) — design limitation: no real exploration.
