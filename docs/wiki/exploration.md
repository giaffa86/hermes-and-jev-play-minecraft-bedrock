# Autonomous exploration (GOAL_EXPLORATION)

Topic: synthesis of the **Autonomous Exploration v1** milestone spec in
[`docs/raw/GOAL_EXPLORATION.md`](../raw/GOAL_EXPLORATION.md). It defines how the
bot should accept high-level search goals ("find a Cherry Grove", "find a
village", "find brown mushrooms"), explore the world autonomously and
reproducibly, and report a structured result. **Status: M1 (find biome) and M2
(route replay) implemented and live-exercised; M3–M6 spec only** (the "no real
exploration" gap of [open-questions](open-questions.md) and
[roadmap](roadmap.md) is now only the *long-distance* part).

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
| M3 | Escort player | **Implemented (harness side, 06/10)**: `escort_to` walks the named human to a known destination (the order's `plan.escort.to`, else the plan `waypoint`, else the active replay route) and **waits** when the human falls behind (`ESCORT_MAX_GAP`, resuming within `ESCORT_RESUME_GAP`); it gives up with `escort_left_behind`/`escort_lost`. The controller picks it deterministically while `goal.escort` is open. *Spec-only part*: the `ESCORTING`/`WAITING_FOR_PLAYER` state machine, and avoiding pointless fights along the way. |
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

- `craft_bed` (3 wool + 3 planks) and `place_bed` — **implemented** (option +
  `wool` tag), and a **travel-kit readiness** checklist is exposed in
  `/observe.travel` (`missing: [...]`). Live round pending (no wool available).
- **Travel-kit / loadout** *action* — **implemented** as `travel_kit` (03/10/2026):
  it crafts the missing pieces in dependency order (planks → sticks → sword →
  crafting table → torches → bed), each piece at most once per call, and reports
  `{ok, before, after, crafted, failed}`. `ok` means *the checklist is now
  green*, not "something was attempted".
- **Inventory-full handling** (drop/consume or abort the trip) — still **not
  implemented**; the readiness checklist keeps reporting `space: false` and the
  loadout does not free slots.
- **Pillar-up** action — **implemented** as `pillar_up`: jump, place the block
  in the cell the feet just left, land on it, repeat. Typed refusals:
  `no_headroom` (fewer than two free cells above the feet — a two-block-tall
  room **cannot** be pillared), `no_placeable_block`, `no_support`,
  `out_of_blocks`, `jump_failed`.
- **Provisional hut** — **implemented** as `build_hut`: walls (feet + head) on
  the four sides plus a roof over the head walls, **skipping cells that are
  already solid** (so a half-built shelter is reused instead of broken) and
  reporting `{ok, placed, failed, skipped, already, covered}` with
  `hut_incomplete` when the ring is not sealed. Declared limits: no door, the
  column above the bot stays open, and it does **not** protect from flying mobs.

### Block placement: the support matters (live finding, 03/10/2026)

`place_*`, `barricade`, `travel_kit` and `build_hut` all end up in
`_placeAtCell`, which clicks the **top face of the support block under the target
cell**. Two live findings made placements fail with an empty target cell
(`place_not_confirmed`, no server-side block update):

- the target cell must be **air** (`_airAt`): a torch is not solid but still
  occupies the cell, and the server refuses the placement
  (`unexpected_block_torch`);
- the support must not be a **usable block** (chest/table/furnace/bed/door/…):
  the click is consumed by that block's own interaction and nothing is placed.
  `_badSupport` filters those, and the search walks a ring (r=1 then r=2, feet
  then head level) because a furnished room can leave the whole first ring
  occupied or unusable.

A third live finding is about the jump: `_jumpOnce` must **not** rebuild
`this._motion` (the pathfinder owns it and `_updateMotionState` dereferences
`motion.target`/`motion.path`) — a free jump uses the dedicated `_freeJump`
channel and declares the same `jumping`/`start_jumping` input flags.

### Live round (03/10/2026) — server-side checks

The bot lives in a walled, furnished room (see the blocker below), so the round
is **partial but server-verified**:

- `travel_kit` → `crafted: [wooden_sword, crafting_table]`,
  `missing: [armor, night]` — the 3×3 sword craft needs a table **placed in the
  world** and that placement worked; armor (leather) and the bed (wool) stay
  missing because no cow/sheep is reachable from the room.
- `place_torch` at (115,73,159) → the block is real: `mine_torch` returned
  `{ok: true, block: 'torch', confirmedBy: 'server_world', picked: [{torch, 1}]}`.
- `place_dirt` (115,73,158) and `place_crafting_table` (115,73,160) → `ok` with
  `_lastPlacement.before: 'air'` / `after: '<block>'`.
- `pillar_up` → `{ok: false, error: 'no_headroom', headroom: 1}`: the live room is
  **two blocks tall**, so the pillar-up cannot exist there. Zero packets sent.
- `build_hut` → one real placement (`wall_head` at (115,74,158), `oak_log`
  6→5), `skipped: 8` (the room already walls those cells), three
  `place_not_confirmed` on the cells whose support is furniture,
  `{covered: 9, error: 'hut_incomplete'}`.

Residual gaps for a *complete* kit are environmental, not missing code: no
reachable wool/leather (armor + bed), a two-block ceiling (pillar-up) and a
furnished first ring (full hut). All three need the bot to leave the room; see
[open-questions](open-questions.md).

## Structures and underground targets (M5/M6)

Caves, mineshafts, the Deep Dark and spawners are the richest resource sources,
so they are first-class exploration targets: same mission model as M1, target
resolved to Minecraft IDs.

```text
village         -> beds + workstations + villagers (the bot lives in one)
cave            -> cave_air volumes, or "air below the feet" on Bedrock palettes
mineshaft       -> planks + rails + fences + cobwebs + spawner
spawner         -> mob_spawner / monster_spawner block (+ the mob type)
amethyst geode  -> amethyst_geode
ancient city    -> deep_dark biome + sculk / sculk_shrieker / sculk_catalyst +
                   reinforced_deepslate
trial chamber   -> trial_spawner / vault + tuff/chiseled bricks
```

### Implementation (03/10/2026)

- **Survey** — `bedrock-world.mjs` `surveyBlocks(point, radius = 48,
  {limit = 20000, maxDistinct = 96, airBelow = 3, ignore})`: one bounded pass
  over the loaded cells, returning a **histogram by block name**
  (`names: Map(name → {count, first})`, `scanned`, `truncated`, `distinct`) — not
  an array per block (48 blocks radius is ~10^5 cells). The cell budget is spent
  **starting from the sections closest to the point**, otherwise a capped survey
  would miss exactly the surroundings of the bot. Air is noise and is ignored,
  **except** below the point: air at `y <= point.y - airBelow` is counted in the
  synthetic `air_below` bucket, which is what makes an invisible cavity
  observable.
- **Detector** — `structures.mjs` (pure, deterministic): `STRUCTURE_DEFS` maps
  each type to block/entity rules `{matcher, min, score, label}` plus `anchors`
  (preference order for the reported position) and `minScore`;
  `detectStructures({survey, entities, position, dimension, defs})` returns
  `{id: 'structure:<type>', type, label, dimension, position, confidence,
  evidence: {score, minScore, matched, missing, blocks, entities}}`, sorted by
  score. A rule below its `min` does not score and shows up in `missing` as
  `"label (count/min)"`. The anchor is the **most specific matched marker** (not
  the centre of the area), and a type is emitted only above `minScore`:
  a room with a crafting table is not a village.
- **Memory** — `WorldMemory.rememberStructure({type, position, confidence,
  evidence, …})` writes a `kind: structure` landmark
  (`structure_<type>_x_y_z`, tags `[structure, <type>]`) and links it to the
  `structure:<type>` concept node with `is_a` + the evidence. Repeated surveys
  do not duplicate records (idempotent by id). Concept nodes are
  `category: conceptual` with no position, so `findLandmarks` filters them out:
  they are knowledge, not places.
- **Adapter** — `_surveyStructures({radius, limit, force})` runs the survey +
  detector (throttled by `STRUCTURE_RESCAN_MS`, default 60 s), remembers every
  detection and logs `structure_detected`; `GET /observe` exposes `structures`
  (≤8) and `structureSurvey` (top 12 names, `scanned`, `truncated`).
- **Route** — `GET /observe.structures[?force&radius&limit]`; the search
  pipeline of M4 also handles structures (`find_structure` missions):
  `scanStructureTarget` merges the live detection with the remembered
  landmarks, so a structure is findable even after a restart.
- **Search aliases** — `resolveSearchTarget` resolves the `structure:` aliases
  (villages/villaggio, mineshaft/miniera, ancient city/città antica, trial
  chamber, spawner, amethyst geode, cave/caverna/grotta) **before** the
  block/entity tables, with the same word-boundary matching.

### Live round (03/10/2026, bot inside a village at (115, 74.6, 157))

`GET /observe.structures?force=1&radius=24&limit=60000` (`scanned 60000`,
`distinct 47`, `truncated: true`) — two real detections and no false positive:

---

- `structure:village` at **(113, 73, 156)**, `confidence 0.6`, score 6,
  matched `beds`/`workstations`/`villagers` — blocks `bed: 30`, `workstations:
  315` (grass_path 306, stonecutter_block 2, blast_furnace 2, fletching_table,
  smithing_table, cartography_table, barrel, lectern), entities `villagers: 11`,
  missing `bell (0/1)`.
- `structure:cave` at **(112, 71, 144)**, `confidence 0.5`, score 3, matched
  `air below` (`831` air cells below the bot's feet) — the tunnel network under
  the base, i.e. the same y=71 cavity documented above.

Then `POST /explore/find {target:'grotta'}` → `report {kind: 'structure',
found: true, best: {name: 'cave', position: (112,71,144), distance: 13.1}}`,
and `{target:'città antica'}` → `move` with `found: 0`.

**Bedrock naming lessons found by the live round**: the bed block is `bed`
(not `oak_bed`), the stonecutter is `stonecutter_block` (not `stonecutter`),
and `cave_air` is absent from the observed palette — hence the `air_below`
measure. The survey histogram of a village room also shows the built counter
(`oak_planks`, `cobblestone`) as top names: detection must key on **markers**,
never on generic building blocks.

### Known limits

- The survey is an **histogram of names**, not a map: it can count a cave but
  not follow it, and it only sees what is loaded around the bot (48 blocks,
  budgeted). Deep structures outside the loaded/charted area stay invisible
  until the bot walks there — that is the job of the M1 spiral + memory.
- Marker thresholds are **tuned on this world** (a village with ≥1 bell, etc.);
  a structure with unusual blocks can be missed. Missing is preferred to
  inventing: a detection needs `minScore`.
- `cave_air` volumes are only detectable on palettes that have the block; on
  Bedrock the cavity signal is `air_below` (min 48 cells), which sees *a* cavity
  below the bot, not necessarily a walkable cave system.
- The Deep Dark/Ancient City rule is a marker rule (sculk family); it has **not**
  been observed live yet.

### Hazards and rules (unchanged)

- **Deep Dark / Warden**: shriekers summon the Warden. Default is **observe and
  report** from a safe distance, never trigger more shriekers or loot without an
  escape route. The stealth execution (sneak route, vibration model, escape
  tactic) is specced in [deep-dark](deep-dark.md) — not implemented.
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

## Observable targets (M4)

Same mission model as M1 with an observable target instead of a biome:
**EXPLORE → SCAN → MATCH BLOCK/ENTITY → REPORT**.

- Target resolution: `resolveSearchTarget(text)` → `{kind: 'block'|'entity', name, id}`.
  The alias table covers brown/red mushroom, pumpkin, bamboo, mangrove log,
  sugar cane, sweet berries, melon, cactus, vine, lily pad, cocoa and a set of
  animals (cow, sheep, pig, chicken, horse, donkey, wolf, cat, villager, bee, …);
  `block:<name>` / `entity:<name>` search *any* id, so an unlisted target is one
  `block:` away. Aliases match on **word boundaries**: "canna da zucchero" does
  not match the `zucche` alias of pumpkin.
- Scan: `scanSearchTarget` in the harness reads the loaded chunks
  (`world.findBlocks(name, position, radius, limit)`, default radius 48) for
  blocks and the seen-entity registry (`_nearbyEntities`, 24-block cap) for
  entities — the bot promises only what it perceives.
- Step: `planSearchStep` returns `report` when the scan matched, otherwise the
  M1 spiral `move` and a rescan at the next step. The report is
  `{found: true, kind, target, count, best: {name, position, distance}, matches
  (≤5), origin, distanceFromOrigin, scannedChunks, durationSeconds}`.
- Harness: `POST /explore/find {target}` (400 `unknown_search_target` + the
  supported list) creates a `find_block`/`find_entity` mission and activates it;
  `GET /explore/find[?radius&limit]` returns one step. Previous `running`
  searches are closed as `superseded` (`superseded_by_new_search`).
- Driver: `RUN_ID=exp-find TARGET='funghi marroni' node explore-find.mjs`.

## Route replay (M2)

"Return to an already-discovered place": the recorded route is replayed as a
sequence of *guides*, not as a compulsory path — the local pathfinder redoes each
leg and may find a better one.

- Source of a route: the **checkpoints of a mission** (`replay_of` edge to the
  source mission), a **place of the world graph** (landmark/`home`/resource site,
  `replays` edge), or explicit **coordinates**.
- Destination: where the thing was found (`targetPosition`), else the last
  checkpoint, else the mission position.
- Pure planner: `replayRouteFromMission`, `replayRouteFromPlace`,
  `planReplayStep` (a leg is a guide only while it moves us *closer* to the
destination: the legs behind us are skipped), `buildReplayReport`.
- Harness: `POST /explore/replay {missionId|placeId|x,z}` creates a `replay`
  mission and activates it; `GET /explore/replay` returns one step
  (`move` / `arrived`, with `via` = the guiding leg); on `arrived` the mission
  closes with `outcome: arrived`, `success: true`. `arrivedRadius` default 6
  blocks, settable per request.
- Driver: `RUN_ID=exp-replay PLACE_ID=home node explore-replay.mjs` (or
  `MISSION_ID=…` / `X=… Z=…`).

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
explore.returnTo(resultId)        # implemented as POST /explore/replay (M2)
explore.findBlock(target)         # implemented as POST /explore/find (M4)
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

◑ **M1 core, M2, M4, M5 and the marker side of M6 implemented.** `exploration.mjs` is the
deterministic planner: biome target resolution (natural language →
`minecraft:<id>`), the expanding-square/spiral over **unexplored chunks**, biome
detection and the structured report — plus the M2 replay primitives, the M4
observable-target search and the M5 structure aliases. The harness steps it
(`POST /explore` creates the
mission, `GET /explore` returns one `move`/`found`/`hold`/`exhausted` step,
`POST/GET /explore/replay` replays a recorded route, `POST/GET /explore/find`
searches a block/entity/structure) and `explore.mjs` / `explore-replay.mjs` /
`explore-find.mjs` are the drivers. Missions + sparse checkpoints are persisted
in the [world memory](memory.md) (`kind: mission`).

Structures and cavities are detected by `structures.mjs` (`surveyBlocks` →
`detectStructures` → `rememberStructure`, exposed by `GET /observe.structures`;
see the M5/M6 section above for the live evidence: a real village at
(113,73,156) and the cavity at (112,71,144)).

Hardening done with the live rounds (03/10):

- a `found` report now carries `found: true`, so closing a mission never claims
  success without its evidence;
- `GET /explore` only ever steps a **`find_biome`** mission (it used to hijack
  whatever `adapter.missionId` pointed at, e.g. a curriculum or replay mission);
- `POST /explore` (and `/explore/replay`, `/explore/find`) closes the previous
  `running` missions of the same kind as `superseded`, so a service restart
  leaves no zombie mission and no stale search is silently resumed.

Live evidence (03/10, container `hermes-jev-bedrock` vs BDS 1.26.52): `POST
/explore {target:'pale garden'}` created the mission and reported
`superseded: [5 stale explorations]`; `GET /explore` kept stepping the
exploration mission while a replay mission was active; `POST /explore/replay
{missionId:'mission_autonomous_murgzqlh', arrivedRadius:2}` → `move` to the
recorded place → `goto_waypoint` ok (`pathNodes: 4`) → `arrived` → mission
`state: arrived`, `outcome: arrived`, `success: true` (+ `replay_of` edge in
SQLite). `POST /explore/replay {placeId:'home'}` resolved the destination from
the world graph (108,74,138) and `goto_waypoint` returned `path_failed` —
21 blocks away, outside the walkable component.

Limits: a full autonomous run over long distances still depends on the
perception cap below (the bot only "sees" loaded blocks near it — see
[headless-client](headless-client.md#8-render-distance-not-comparable)) and on
the bot being able to leave its platform: on the live BDS it is boxed in a 4×5
block room, so the spiral waypoint is 96 blocks away and unreachable
(`target_not_found`), no new biome can be reached and no travel checkpoint is
written. The M4 search works from where the bot stands (it scans the 125 loaded
chunks), so it is live-verifiable in the room, but a target that is not loaded
still needs travel. M3 (escort) was *blocked by the environment* (no human player
connected to the BDS, so `ESCORTING`/`WAITING_FOR_PLAYER` could not be
exercised); on 06/10 the order path was implemented harness-side as `escort_to`
(the bot leads, waits for a lagging human, and closes with a reason) and is
covered by offline tests — see [verification](verification.md) 47.52 and
[human-command](human-command.md). What remains untested is the same thing the
environment blocks: a *real* long escort with a human on the BDS. M5 (structures) and the M6 marker targets are implemented and
live-verified (village + cavity); the multi-leg case of M2 (a route with
intermediate checkpoints) is covered by unit tests, since inside the room no
checkpoint can be earned (they are written every 48 blocks of travel).

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
- [deep-dark](deep-dark.md) — Deep Dark stealth roadmap (sculk vibrations, sneak, Warden).
