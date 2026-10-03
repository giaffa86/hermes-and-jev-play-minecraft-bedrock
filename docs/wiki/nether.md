# Nether and End (survival, ghasts, piglins, endermen, portals)

Roadmap for taking the bot from the first Nether portal to the End while
**surviving the Nether**: locate a nearby portal (reuse the base's), avoid
**ghast** fireballs, **barter gold with piglins**, **never meet an enderman's
gaze**, collect **blaze rods** and **ender pearls**, craft eyes of ender, find the
stronghold, open the End portal, and (stretch) defeat the **Ender Dragon**.

Status: **N0 (awareness and hazards), N1 (portal reach/build/light/enter), N2
(nether survival: non-flammable hub, dimension-aware fall, hazardous landings)
and N3 (dodging an incoming projectile sideways, never into lava) implemented and
unit-tested; all four have a live round (03/10/2026), N1–N3 partial because the
live world is an Overworld room with no obsidian, no loaded portal and no
gun-armed mob; N4–N7 still spec only**.
`knowledge/progression.json` now has the full chain and the
`beat_the_dragon → enter_nether` contradiction is fixed: `beat_the_dragon` is a
real milestone requiring `enter_end`. Full raw source:
[`docs/raw/NETHER_ROADMAP.md`](../raw/NETHER_ROADMAP.md).

Sources: `knowledge/progression.json`, `skills/gameplay/progression/*`,
`bedrock-survival.mjs` (`HOSTILE_TYPES` already includes `ghast`, `blaze`,
`piglin`, `enderman`, `piglbrute`, `hoglin`, `magma_cube`, `ender_dragon`),
`bedrock-adapter.mjs`, [fluids](fluids.md), [goal-achievement](goal-achievement.md).

## Current state

- **`enter_nether` actions exist since N1**: `goto_portal`, `build_portal`,
  `light_portal`, `enter_portal` ([adapter](architecture-evolution.md)), con
  geometria pura in `bedrock-nether.mjs` (`planPortalFrame`, `checkPortalFrame`,
  `portalSiteBlocked`, `portalFrameCandidates`). La skill `enter_nether`
  (`success: {dimension: nether}`) ha ora le azioni che le servono; quello che
  manca nel mondo live è l'**ossidiana** (e un portale caricato).
- **Projectile tracking**: ✅ since N0 — `_onEntityMove` keeps `prev` for
  projectile entities and `_netherView().projectile` answers "is one coming at
  me" ([`bedrock-nether.mjs`](../../bedrock-nether.mjs), `projectileThreat`).
  **Gaze discipline**: the bot *knows* when it is looking at an enderman
  (`gazedAtEnderman`); not staring on purpose is still N5.
- **Fire/lava hazard**: ✅ since N0 at the *awareness* level (`inFire`,
  `fireDistance`, `magmaDistance`, `netherHazard`, governor rules). Full
  movement/blob handling stays in [fluids](fluids.md) M4.
- **No bartering**: `item_use_on_entity` exists for feeding/taming, but no
  `barter_piglin`; and the survival layer classifies piglins as **hostile**, so an
  emergency rule would treat them as enemies.
- **No fortress/stronghold/End-portal actions**; `_refreshNearby` now looks for
  `portal`, `end_portal`, `end_gateway`, `end_portal_frame`, `fire`, `soul_fire`,
  `magma`, `mob_spawner` (N0) but nothing walks to or uses them (N1).
- **Bedrock specifics**: water evaporates in the Nether (no water MLG); **beds
  explode** in the Nether/End; the respawn anchor charges with glowstone; piglins
  zombify in the Overworld and are calmed by **any gold armour**; ghast fireballs
  can be deflected by hitting them.

## Progression chain (added)

```
diamonds
  └── nether_portal          (locate or build; nearby `portal` / 10 obsidian)
        └── enter_nether     (dimension: nether)
              └── nether_survival
                    ├── piglin_barter
                    ├── obtain_blaze_rods        (blaze_rods >= 7)
                    └── obtain_ender_pearls      (ender_pearls >= 12)
                          └── craft_eyes_of_ender (eyes_of_ender >= 12)
                                └── find_stronghold (end_portal_frame within 24)
                                      └── enter_end (dimension: the_end)
                                            └── beat_the_dragon
```

`goals.beat_the_dragon` now points to the real `beat_the_dragon` milestone.
New item tags: `gold_ingots`, `obsidian`, `blaze_rods`, `blaze_powder`,
`ender_pearls`, `eyes_of_ender`.

## Milestones

| # | Milestone | Content | Status |
|---|---|---|---|
| N0 | Nether awareness & hazards | `_refreshNearby` (portal, end_portal_frame, magma, spawner, fire); `/observe.portals`; projectile sensing (`projectileIncoming`); gaze sensing (`gazedAtEnderman`); governor rules. | ◑ implemented + live (03/10/2026), see below |
| N1 | Portal locate/build/light/enter | `goto_portal`, `build_portal`, `light_portal`, `enter_portal`; prefer reusing a nearby portal; verify `portal` block then `dimension: nether`. | ◑ implemented + live partial (03/10/2026), see below |
| N2 | Nether survival | fire/lava avoidance (fluids), minimal nether hub, fall handling (no water), never sleep/place water. | ◑ implemented + live partial (03/10/2026), see below |
| N3 | Ghast avoidance | track fireballs, dodge perpendicular to the trajectory (or deflect), never flee into lava. | ◑ implemented + live partial (03/10/2026), see below |
| N4 | Piglin bartering | wear gold armour for neutrality; `barter_piglin` (gold in hand → `item_use_on_entity` → collect drops); never hit piglins. | ❌ not implemented |
| N5 | Ender gaze & pearls | never aim at enderman eyes; pumpkin option; kill at body/feet; collect pearls. | ❌ not implemented |
| N6 | Fortress & blaze rods | find the fortress (exploration), fight blazes with cover, collect 7 rods. | ❌ not implemented |
| N7 | Endgame | eyes of ender, stronghold via thrown eyes, fill/enter the portal, (stretch) dragon. | ❌ not implemented |

## N0 — Nether awareness & hazards (implemented, live 03/10/2026)

Everything in this section is **perception only**: it tells the planner that a
portal, a fire, a magma block, a spawner, an incoming projectile or an enderman
gaze is there. No action in N0 moves the bot to a portal or fights a ghast.

### Implementation

- **`bedrock-nether.mjs`** (new, pure, no I/O): `portalKind`/`hazardKind`
  (`portal` → nether, `end_portal`/`end_gateway` → end, `end_portal_frame` →
  frame; `fire`/`soul_fire` → fire, `magma` → magma), `isFireBlock`,
  `isSpawnerBlock`, `isProjectileType` (20 types: `fireball`, `small_fireball`,
  `dragon_fireball`, `wither_skull`, `arrow`, `thrown_trident`, `snowball`,
  `egg`, `ender_pearl`, `llama_spit`, `shulker_bullet`, potions, `xp_bottle`,
  `fishing_hook`, `firework_rocket`, `wind_charge`, `evoker_fang`, …),
  `isEndermanType`, `isNetherDimension`/`isEndDimension`, `waterEvaporates`,
  `bedsExplode`, `summarizePortals`, `summarizeHazards`,
  `projectileThreat({from,position,velocity,previous,now})` →
  `{known,incoming,missDistance,timeToImpactMs,speed,source}`,
  `projectileIncoming` (the most urgent one), `gazeVector`, `gazeAngle`,
  `gazedAtEnderman`, `netherHazard` (critical/high/medium/low ladder).
- **Adapter**: `_netherCensus({force})` (the same TTL pattern as
  `_fluidCensus`, `NETHER_RESCAN_MS` = 10 s, radius 32, limit 64; it never
  caches a scan of a world that is not loaded) and `_netherView({force,cells})`,
  published by `observe()` as `nether` and by the gated route
  `GET /observe.portals`.
- **Projectiles**: `_onEntityMove` now stores `entity.prev` **only for projectile
  types**, which is what lets `projectileThreat` fall back to two samples when
  the server does not send a velocity. A `known:false` verdict (no velocity, no
  second sample, stale samples) is **not** an all-clear — it is "unknown".
- **Gaze**: `gazedAtEnderman` compares the bot's own `yaw`/`pitch` (the same
  `_lookAt` convention: yaw 0 = +z) with the vector to the enderman's eyes
  (2.55 blocks above its feet), tolerance 8°.
- **Nether rules**: the bot refuses to sleep in the Nether/End
  (`beds_explode_here`) and the `sleep` option is not even offered there; water
  is reported as evaporating rather than as a rescue option.
- **Survival layer**: `perceiveNether` (unknown shape when the field is missing,
  so an old observation never raises a false alarm), risk weights (fire +50, on
  lava +60 from M0, magma +35, incoming projectile +45/+30, enderman gaze +12
  only in the Nether/End, spawner +6), needs (`escape`), conditions and seven
  new rules in `knowledge/survival-rules.json`: `on_fire` (98),
  `projectile_incoming` (96), `magma_contact` (95), `fire_adjacent` (92),
  `fire_near` (72), `gazed_at_enderman` (62), `spawner_nearby` (58).

### Tests

`tests/bedrock-nether.test.mjs` (12 cases), `tests/bedrock-nether-adapter.test.mjs`
(10 cases) and `tests/survival-nether.test.mjs` (7 cases) — 818 tests in the
whole suite at this point. The unit tests are the only place where the
**Nether-specific** branches run: the live world is an Overworld room.

### Live round (03/10/2026, BDS 1.26.52)

- `GET /observe.portals` on the live bot (Overworld, room of oak planks):
  `dimension: overworld`, `isNether: false`, `inFire: false`, no portal, no
  spawner, `hazard: {level: none, reasons: []}`, `scanned: 0`, `ready: true` —
  five consecutive calls cost **56 ms total** (the census is cached).
- `GET /observe` carries the new `nether` key and the governor still answers
  `{mode: normal, risk: 0, needs: [continue_progression]}`; `/options` is
  unchanged (24 options, no regression, `sleep` absent because the room is lit
  and daytime).
- **Projectiles live**: `POST /act {"key":"throw_egg"}` → `{ok: true,
  thrown: "egg"}` and `/observe.portals` caught the flying entity at 14.3 → 15.7
  → 18.4 blocks (distance growing, `projectile: null` = correctly *not*
  incoming). This is the end-to-end proof that a real server entity reaches the
  projectile pipeline.

### Known limits (N0)

- `inFire`, `magma`, `beds_explode_here` and the Nether/End dimension branches
  are covered by unit tests only: the live bot never left the Overworld.
- The "incoming" verdict was never triggered by a *real* hostile projectile
  live (a thrown egg flies away). The dodge itself is N3.
- `gazedAtEnderman` is only a **detection**: nothing prevents the bot from
  aiming at an enderman yet (N5).
- The census is bounded by radius 32 / limit 64, so a portal further away is
  simply not in the view (N1 has to search for it deliberately).
- `portalKind('nether_portal')` returns `null` on purpose: the Bedrock block is
  named `portal`.

## N1 — The portal: reach, build, light, enter (implemented, live partial 03/10/2026)

### Implementation

Geometry lives in [`bedrock-nether.mjs`](../../bedrock-nether.mjs) and is pure:

- `planPortalFrame({origin, axis, withCorners, interiorWidth, interiorHeight})`
  returns the classic 4×5 ring — 14 obsidian with the corners, 10 without — plus
  the interior (2×3), the `ignition` cell (the bottom-row block a lit click has
  to hit, with its face) and the `entry` cell. The frame is built **bottom-up**
  so every block is placed against an already-placed support.
- `checkPortalFrame(plan, blockAt)` verifies a frame that is already standing:
  obsidian around, air (or `portal`) inside, and reports `missing`/`blocked` with
  the guilty cell. It is the only thing that decides whether a candidate is a
  portal — against the real world, never against a hopeful pattern match.
- `portalSiteBlocked(plan, blockAt)` refuses a site that is occupied or floats
  (only the bottom row needs ground; the columns stand on the bottom row).
- `portalFrameCandidates(blocks)` derives candidate frames from the obsidian
  blocks the bot can see (each block can be a bottom-row column or a corner, on
  both axes), so `light_portal` works on a frame it did not build.

The adapter turns that into four actions (`bedrock-adapter.mjs`):

| Action | What it does | Typed refusals |
| --- | --- | --- |
| `goto_portal` | walks to the nearest known `portal` block (census N0), reachability-gated | `no_portal_known`, `portal_unreachable`, `move_failed` |
| `build_portal` | picks the first free site around the bot (never inside it), places the frame bottom-up | `missing_materials`, `no_portal_site`, `portal_frame_incomplete` |
| `light_portal` | finds a standing frame, clicks the ignition cell with flint and steel, waits for a `portal` block | `missing_flint_and_steel`, `no_portal_frame`, `portal_not_lit` |
| `enter_portal` | walks into the portal column and waits for `this.dimension` to change | `no_portal_known`, `dimension_unchanged` |

`enter_portal` never guesses: the success is the server's `change_dimension`
packet (already tracked at `start_game`/`change_dimension`). `goto_portal` and
`enter_portal` appear in `/options` only when the census sees a portal *and* the
reachability says the bot can stand next to it; `build_portal` needs 14 obsidian,
`light_portal` needs flint and steel **and** a frame that is not lit yet.
`/observe.portals` also reports `portalFrame` (the last build attempt).

Survival intents: `goto_portal`/`enter_portal` → `travel`, `build_portal`/
`light_portal` → `build` (`survival/intents.mjs`).

### Tests

- `tests/bedrock-nether.test.mjs`: 5 new cases (17 total) — ring geometry and
  ignition cell, z axis and the minimal 10-obsidian frame, `checkPortalFrame`
  with a complete/holed/occupied/already-lit frame, `portalSiteBlocked`
  (occupied, no support, invalid plan), `portalFrameCandidates`.
- `tests/bedrock-nether-adapter.test.mjs`: 6 new cases (17 total) — typed
  refusals, `goto_portal` walking to the block centre, `portal_unreachable`,
  `enter_portal` waiting for the dimension change (and staying honest when it
  does not come), `build_portal` site choice/bottom-up order/half frame,
  `light_portal` click transaction and confirmation, `/options` gating.
- The world fixture of that file now returns **integer cell positions**, like
  production `findBlocks`; the N0 distances were re-baselined accordingly (the
  old centre-based positions hid a `+0.5` error in the approach target).

### Live round (03/10/2026, BDS 1.26.52)

| Probe | Result |
| --- | --- |
| `GET /observe.portals` | `portals.nether.count 0`, `portalFrame null`, `ready true` (~14 ms) |
| `POST /act goto_portal` | `no_portal_known` (13 ms) |
| `POST /act enter_portal` | `no_portal_known` (13 ms) |
| `POST /act build_portal` | `missing_materials {obsidian: need 14, have 0}` (13 ms) |
| `POST /act light_portal` | `missing_flint_and_steel` (14 ms) |
| `GET /options` | no portal key offered (nothing to reach, build or light) |

An exploration search for `block:portal` over 125 loaded columns (radius 48)
reported `found 0`: the base has no portal and no obsidian, so the live round can
only exercise the **refusals**. Each one is immediate (13–14 ms) and typed —
no pathfinder budget burned on an impossible goal.

### Known limits (N1)

- The **happy path is unit-only**: no obsidian and no loaded portal live, so
  `build_portal`/`light_portal`/`enter_portal` success was never observed on the
  server. That is the first thing to do inside the Nether (or with obsidian in
  the inventory).
- Building consumes a real inventory (14 obsidian) and cannot be undone; the
  action refuses to start without the full material instead of leaving a half
  frame (the same rule as `build_hut`).
- `enter_portal` walks into the column; the walk-in height (bottom row at feet
  level, first `portal` block at head level) matches the vanilla layout, but the
  live confirmation of “the server teleports me” is still missing.
- No portal *search* yet: `goto_portal` uses the N0 census (radius 32), so a
  portal further away is invisible until N1 grows a deliberate search (the
  `find_block` mission already exists and can locate an unlit frame by
  `obsidian`).

## N2 — Nether survival (implemented, live partial 03/10/2026)

Three certainties of the Overworld fall away in the Nether: water evaporates (no
MLG, no rescue shower after a fall), the floor can be magma or fire (landing
there hurts even though the cell is “walkable”), and the planks we use for the
night shelter turn into firewood. N2 answers those three with primitives the
pathfinder and the builder can ask for, plus one action that leaves a place
behind.

### Implementation

- **`bedrock-nether.mjs`** (pure): `landingHazard(name)` (`lava`/`flowing_lava`
  → `lava`, `magma`, `fire`/`soul_fire` → `fire`, `cactus`) and `safeLanding`;
  `maxFallDepth(dimension)` (`OVERWORLD_MAX_FALL` 4, `NETHER_LIKE_MAX_FALL` 2);
  `isFlammableBlock(name)` (an explicit set plus the `_planks`/`_log`/`_wood`/
  `_stem`/`_hyphae`/`_wool`/`_fence`/`_slab`/`_stairs`/`_door`/`_leaves`/…
  suffixes); `pickHubBlock(owned)` (the most abundant **non-flammable** block);
  `shellCells(feet, {roofCenter})` and `netherHubPlan({feet, block})` — the
  shelter geometry lives here so the Nether can inspect it without touching the
  adapter (and so `build_hut` and the hub share one definition of “a shelter”).
- **Pathfinding safety**: `_neighbors` caps the fall at `maxFallDepth` and
  `break`s at the first landing whose support is a `landingHazard`;
  `_standable` refuses a cell whose support hurts (magma, fire, cactus) in **any**
  dimension, so the step neighbours are covered too. `/observe.portals` now
  carries `maxFall` and the last hub.
- **`_netherHub`** (action `build_nether_hub`): refuses outside the Nether/End
  (`wrong_dimension`), asks `pickHubBlock` for a non-flammable block (only wood
  owned → `no_hub_materials` with the refused `flammable` list), then builds the
  12-cell shell **bottom-up, never above its own head**, through the shared
  `_shellAround(cells, block)` helper that `_buildHut` uses as well. When the
  shell is sealed it is remembered in memory as `kind: home` (`nether_hub`), so
  the bot has a place to come back to; an incomplete shell returns
  `hub_incomplete` and is **not** remembered as home.
- **Never sleep / never place water**: sleep in the Nether was already refused by
  N0 (`beds_explode_here`, the option is not even offered) and no action in the
  adapter places water at all — so “no water MLG” is structural rather than a
  guard, which is why the fall rule is the interesting half of N2.

### Tests

`tests/bedrock-nether.test.mjs` (6 pure N2 cases: fall depth per dimension,
landing hazards, flammability, `pickHubBlock`, `shellCells`, `netherHubPlan`),
`tests/bedrock-nether-adapter.test.mjs` (5 cases: `wrong_dimension`,
`no_hub_materials` with the flammable list, a sealed hub with the wood untouched
and the `home` landmark written, `hub_incomplete` without the landmark, option
gating), `tests/bedrock-reachability.test.mjs` (2 cases: four-block fall in the
Overworld vs two in the Nether, no step onto a magma landing) and the
`build_nether_hub` intent assertion in `tests/gameplay-skills.test.mjs` — **843
tests** in the whole suite.

### Live round (03/10/2026, BDS 1.26.52)

| Probe | Result |
| --- | --- |
| `GET /observe.portals` | `dimension: overworld`, `isNether: false`, **`maxFall: 4`**, `hub: null`, `ready: true` |
| `POST /act {"key":"build_nether_hub"}` | `{ok: false, error: wrong_dimension, dimension: overworld}` — immediate, typed, zero packets |
| `GET /options` | 25 keys, **none** about portals or the hub (the hub needs the Nether) |
| `POST /act {"key":"wait"}` | `{ok: true}` — dispatch still healthy after the new branch |

### Known limits (N2)

- **The Nether branches are unit-tested only**: the live bot never left the
  Overworld, so “a cobblestone hub actually gets built in the Nether”, the
  two-block fall cap and the magma-landing refusal have no live evidence. The
  live round proves the refusal and that nothing regressed in the Overworld.
- The hub is a shell, not a base: no chest, no portal inside it, no roof centre
  (the shell keeps the bot's own column open for headroom, exactly like
  `build_hut`), and the material comes from the inventory — no netherrack
  *mining* strategy yet.
- **No void protection**: a fall into the void is not a “landing”, so the
  `landingHazard` list cannot catch it; lava *crossing* (bridging) is M4 of
  [fluids](fluids.md) and is still missing, so the bot can be safe but stuck on
  one side of a lava lake.
- The hazard refusal is deliberately broader than the Nether: magma, fire and
  cactus are never a destination in the Overworld either. That is a behaviour
  change for the pathfinder (documented here, covered by tests).

## N3 — Dodging a projectile (implemented, live partial 03/10/2026)

A fireball is **faster than the bot**, so “running away” is a decision to be hit
from behind: the only direction that changes the geometry is the **perpendicular**
to the flight path. N3 turns the N0 sensing (`projectileIncoming`) into an action
that steps out of the line — and refuses to do it into lava, which is the classic
way to die while escaping a ghast.

### Implementation

- **`bedrock-nether.mjs`** (pure): `projectileVelocity({position, velocity,
  previous, now})` (declared velocity first, otherwise the two samples, otherwise
  `null` — an unknown trajectory is never invented; `projectileThreat` now uses
  it too, so sensing and dodging measure speed in one place);
  `perpendicularDirs({from, projectile})` (the two horizontal perpendiculars of
  the flight direction, or of the projectile→bot line when the speed is unknown);
  `lateralOffset({point, from, projectile})` (distance from the line of fire,
  the quantity a dodge must grow); `breaksLine({from, candidate, projectile,
  margin})`; `dodgeCandidates({from, projectile, distances})` — both sides, at the
  feet's cell level, ordered by lateral distance descending, never the bot's own
  column.
- **`_incomingThreat`**: the summary in `/observe.portals.projectile` has the
  distance and the ETA but not the trajectory, so the action re-derives the
  velocity from the projectile row (`_projectileRows` keeps `prev`) with the same
  pure helper the census uses.
- **`_dodgeProjectile`** (action `dodge_projectile`): refuses with
  `no_projectile_incoming` when nothing is inbound; otherwise filters the
  candidates by `breaksLine` (a move along the trajectory is not a dodge), by
  `cellReachable` (fail-open when the reachability census is unusable), by
  `_standable` (a landing that hurts is not a destination, N2) and by
  `_lavaAdjacent`; tries them in order and **verifies by observation** — the
  dodge succeeded when `_incomingThreat()` is gone after the move, not when the
  bot moved. Errors: `not_ready`, `no_projectile_incoming`, `no_dodge_spot`
  (with the threat summary and the raw candidate count), `dodge_failed` (with the
  last reason).
- **Option gating**: `dodge_projectile` is offered only when a threat exists
  **and** at least one candidate survives the filters, so the planner is never
  given a dodge that cannot happen. Intent `['escape', 'travel']`, which is what
  the `projectile_incoming` governor rule already asks for (`escape`/`shelter`).

### Tests

`tests/bedrock-nether.test.mjs` (4 pure cases: `projectileVelocity` from declared
speed / samples / stale sample, `perpendicularDirs` incl. the unknown-speed
fallback and the “no information” case, `lateralOffset`/`breaksLine` with a
point on the trajectory, `dodgeCandidates` both sides + multiple distances +
never the bot column), `tests/bedrock-nether-adapter.test.mjs` (4 cases:
`_dodgeProjectile` moves to one of the two lateral cells and succeeds when the
threat clears, `no_projectile_incoming` with 0 pathfinding attempts,
`no_dodge_spot` with the lateral cells walled and a lava-adjacent candidate
dropped, option gating) and the `dodge_projectile` intent assertion — **851
tests** in the whole suite. The adapter fixture now gives blocks a `boundingBox`
(`_standable` needs a full one for the support).

### Live round (03/10/2026, BDS 1.26.52)

| Probe | Result |
| --- | --- |
| `POST /act {"key":"dodge_projectile"}` (quiet world) | `{ok: false, error: no_projectile_incoming}` — immediate, zero packets |
| `GET /options` | 24 keys, **no** `dodge_projectile` (the option is gated on an inbound threat) |
| `POST /act {"key":"throw_egg"}` | `{ok: true, thrown: egg, chick: none}` (inventory 24 → 22 eggs) |
| `dodge_projectile` right after the throw | `{ok: false, error: no_projectile_incoming}` — the egg flies **away**, and an outbound projectile is not an inbound one |
| `GET /observe.portals` | `dimension: overworld`, `maxFall: 4`, `hub: null`, `ready: true`, `projectile: null` — no N2/N0 regression |
| `/observe` | `spawned`, health 20, food 19, inventory intact |

### Known limits (N3)

- **No real inbound fireball was observed live**: the base room has no ghast (and
  the bot's own egg is outbound), so the happy path — stepping out of the line
  and watching the threat disappear — is covered by unit tests only, exactly like
  N1/N2. The live round proves the typed refusal, the option gating and that
  throwing and dodging did not disturb the rest of the loop.
- The dodge assumes a **straight, horizontal** trajectory (the pure geometry works
  in plan view): a fireball on a steep dive is handled by the projectile→bot
  fallback line, not by real 3D prediction, and the expected flight time is not
  used to choose *how far* to step (`DODGE_DISTANCE` is a constant of 3 blocks).
- **No deflection and no ranged answer**: the roadmap allows hitting the fireball
  back, but there is no bow/melee-deflect primitive; `flee` still exists for
  ground mobs and does not know about trajectories (the governor prefers
  `dodge_projectile` when a projectile is inbound, both share the `escape`
  intent).
- The action spends at most `timeoutMs` (8 s) across its candidates; a fireball
  with an ETA shorter than a pathfinding step can still arrive first, which is
  why the geometry prefers the *closest* lateral cell with the greatest lateral
  growth rather than the safest one further away.

## Dependencies and risks

- **Fluids M0/M4** (lava/fire hazards) and **exploration** (fortress, stronghold)
  are prerequisites.
- **Goal Contract / Goal Manager** ([goal-achievement](goal-achievement.md)) is
  needed for a long persistent Nether run with suspend/resume.
- **Ranged combat** is missing: `_combat` is melee, but blaze and end crystals
  need a bow.
- **Death loses everything** (`keep-inventory=false`) — establish a hub/respawn
  anchor early (N1–N2).
- The ghast dodge geometry is straight-line in plan view and its step distance is
  a constant: calibrating it against the real fireball speed, latency and the
  server's knockback needs a live ghast (missing from the base).
- A **`bossDefeated`** verifier criterion does not exist, so `beat_the_dragon`
  cannot be verified today.

## Related pages

- [fluids](fluids.md) — lava/fire hazards and water rules (water is unusable in the Nether).
- [goal-achievement](goal-achievement.md) — Goal Contract, task graph and benchmarks.
- [exploration](exploration.md) — finding the fortress/stronghold.
- [roadmap](roadmap.md) — consolidated implementation status.
- [open-questions](open-questions.md) — blockers and verification gaps.
- [survival-intelligence](survival-intelligence.md) — progression, skills, verifier.
