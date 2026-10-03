# Nether and End (survival, ghasts, piglins, endermen, portals)

Roadmap for taking the bot from the first Nether portal to the End while
**surviving the Nether**: locate a nearby portal (reuse the base's), avoid
**ghast** fireballs, **barter gold with piglins**, **never meet an enderman's
gaze**, collect **blaze rods** and **ender pearls**, craft eyes of ender, find the
stronghold, open the End portal, and (stretch) defeat the **Ender Dragon**.

Status: **N0 (awareness and hazards), N1 (portal reach/build/light/enter), N2
(nether survival: non-flammable hub, dimension-aware fall, hazardous landings),
N3 (dodging an incoming projectile sideways, never into lava), N4 (bartering
with a piglin, never hitting one), N5 (gaze discipline, pumpkin mask, torso
aim, pearls) and N6 (fortress detection, blaze hunt with cover, blaze rods)
implemented and unit-tested; all seven have a live round (03/10/2026), N1–N6
partial because the live world is an Overworld room with no obsidian, no loaded
portal, no gun-armed mob, no piglin, no enderman and no blaze; N7 still spec
only**.
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
| N4 | Piglin bartering | wear gold armour for neutrality; `barter_piglin` (gold in hand → `item_use_on_entity` → collect drops); never hit piglins. | ◑ implemented + live partial (03/10/2026), see below |
| N5 | Ender gaze & pearls | never aim at enderman eyes; pumpkin option; kill at body/feet; collect pearls. | ◑ implemented + live partial (03/10/2026), see below |
| N6 | Fortress & blaze rods | find the fortress (exploration), fight blazes with cover, collect 7 rods. | ◑ implemented + live partial (03/10/2026), see below |
| N7 | Endgame | eyes of ender, stronghold via thrown eyes, fill/enter the portal, (stretch) dragon. | ❌ not implemented |

## N0 — Nether awareness & hazards (implemented, live 03/10/2026)

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

## N4 — Bartering with a piglin (implemented, live partial 03/10/2026)

Gold is the only currency the Nether accepts, and the piglins are the only bank:
`barter_piglin` hands an ingot to an **adult** piglin and collects what it throws
back. Two rules are not preferences but game mechanics — a **brute** never
barters, and a **hit** makes every piglin in the area hostile for good — so both
are enforced before any packet leaves the bot.

### Implementation

- **`bedrock-nether.mjs`** (pure): `PIGLIN_TYPES`/`isPiglinType` (`piglin`,
  `piglin_brute`); `BARTER_INGOT` (`gold_ingot`) + `isBarterPayment`; the gold-armour
  vocabulary (`GOLD_ARMOR_PIECES`, `isGoldArmorPiece`, `goldArmorWorn`,
  `piglinNeutral({worn})` — in Bedrock *any* gold piece makes the piglins neutral);
  `BARTER_REWARDS`/`isBarterReward` (the loot table, kept for the **report** only:
  the success criterion is a fresh drop, not a whitelist, so a future game update
  cannot turn verification into a false negative); `barterTarget({piglins, from,
  range})` → `{target, nearest}` — the nearest adult non-brute plus the nearest
  piglin overall, so the caller can say *why* it refused (a brute or a baby).
- **`_equipItemInHotbar(name)`**: the “hold the item, then interact” prelude
  (resync once when the slot is not found, move it into the hotbar, select it,
  close an open container) was extracted from `_feedEntity` and is now shared by
  feeding, taming and bartering — one definition of a step every interaction
  needs.
- **`_barterPiglin`** (action `barter_piglin`): refuses `no_piglin_nearby`
  (with the range), `piglin_brute_not_barterable`, `piglin_baby_not_barterable`,
  `missing_gold_ingot`, `piglin_gone`, `piglin_unreachable` (the same
  reachability gate as feeding); then looks at the piglin and sends
  `item_use_on_entity` with **`interact`** (never `attack`) every second, and
  **verifies by observation**: success is a *fresh drop* within 8 blocks of the
  piglin, which is then collected with the existing `_collectDrop` primitive.
  Timeout → `barter_not_confirmed` **with** `gaveIngot` (the difference between
  “the piglin took the gold and threw nothing” and “the hand-over never
  happened”), never a success on an unverified trade.
- **A piglin is never an attack target**: `options()` skips piglins in the
  hostile loop, so `attack_piglin`/`attack_piglin_brute` can no longer be offered
  even though both are in `HOSTILE_TYPES` (they *are* dangerous — the point is
  that the only profitable answer is neutrality or flight).
- **Sensing**: `/observe.portals` now carries `piglin` (`{type, distance, baby,
  brute, barterable, position}` or `null`), `goldArmor` (`{worn, neutral}`) and
  the last `barter` report. The option is offered only when a barterable piglin
  is in range **and** the bot owns a gold ingot, and its description warns
  `(no gold armour worn: it may turn hostile)` when the bot is not neutral.

### Tests

`tests/bedrock-nether.test.mjs` (3 pure cases: piglin classification + the gold
vocabulary, gold-armour neutrality, `barterTarget` with a brute/baby/out-of-range
and a row without a position), `tests/bedrock-nether-adapter.test.mjs` (5 cases:
the four typed refusals with **zero packets**, a full barter where the real
`_interactEntity` runs and every captured `inventory_transaction` is
`item_use_on_entity`/`interact` (never `attack`) with the ingot spent, the drop
collected and `_barterLast` written, an unconfirmed trade that reports
`gaveIngot: false` instead of a false success, the option gating + the
`attack_piglin` absence + the neutrality warning, and `_netherView` carrying the
piglin and the last barter) and the `barter_piglin` intent assertion — **859
tests** in the whole suite.

### Live round (03/10/2026, BDS 1.26.52)

| Probe | Result |
| --- | --- |
| `GET /observe.portals` | `piglin: null`, `goldArmor: {worn: [], neutral: false}`, `barter: null` (new sensing exposed) |
| `POST /act {"key":"barter_piglin"}` | `{ok: false, error: no_piglin_nearby, range: 16}` — immediate, zero packets |
| `GET /options` | 22 keys, **none** about piglins or bartering (`attack_zombie` still offered for the zombie villager: the attack path is unchanged) |
| `GET /observe` (entities) | villagers, cat, donkey, wandering trader, leash knot — **no piglin** (piglins zombify in the Overworld) |
| `POST /act {"key":"wait"}` | `{ok: true}` — dispatch healthy after the new branch |

### Known limits (N4)

- **No piglin was ever met live**: the base room is an Overworld room and
  piglins zombify outside the Nether, so the happy path (hand over the ingot, see
  the drop appear, collect it) is covered by unit tests only — the live round
  proves the typed refusal, the new sensing and that the attack path did not
  regress. The live acceptance of the raw roadmap (“a live barter completes and
  no piglin is hostile at the end”) is **not** satisfied.
- The barter is one ingot per action: no batching, no waiting out a piglin that is
  busy with another ingot, and no “recover the ingot if the piglin despawns”.
- **`_equipItemInHotbar` now owns the resync path for feeding too**: the refactor
  keeps the previous error vocabulary (`missing_feed`, `feed_equip_failed: …`) but
  the message text for a failed hotbar move is the shared one.
- Gold armour is only *reported*, not equipped automatically: `equip_armor`
  already equips any armour in the inventory, and the survival layer decides
  whether spending gold on armour is worth it.

## N5 — Ender gaze and pearls (implemented, live partial 03/10/2026)

### Implementation

Geometry and predicates live in [`bedrock-nether.mjs`](../../bedrock-nether.mjs):
`endermanAimPoint` (the torso, 1.45 above the feet, always **below** the eyes at
2.55), `aimsAtEndermanEyes` (tells whether a given aim height is at eye level,
`null` when unknown), `isPumpkinMask`/`pumpkinMaskWorn` and `isEnderPearl`.
`gazedAtEnderman` now reports two separate facts: `aimingAtEyes` (where the bot
is looking) and `gazed` (whether the enderman notices). With a pumpkin on the
head the bot can aim at the eyes and still be ignored, and the survival layer
reads the second fact, not the first.

In the adapter:

- `_combat` and `_attackEntity` aim an enderman at the torso (via
  `endermanAimPoint`), never at the eye height;
- `avoid_enderman_gaze` → `_avoidGaze`: two sides at ±120° and the back at 180°,
  all with the pitch down, ranked by how far they leave the eye axis, and
  verified **from perception** (`gaze_cleared`), with typed refusals
  (`no_enderman`, `no_gaze_escape`, `gaze_not_cleared`, `not_ready`) and
  `protected: true` short-circuit when a mask is worn;
- `equip_pumpkin` → `_equipPumpkin`: a carved pumpkin goes in the helmet slot,
  with its own path because `_armorSlotFor` does not know `carved_pumpkin`;
- `_netherView()` exposes `enderman.{aimingAtEyes,gazed,protected}`, `pearls`
  (counted from the slots, not from the summary map) and `pumpkin`.

### Tests

Three pure cases in `tests/bedrock-nether.test.mjs` (the two facts separated by
`protected`, the torso/eye invariant, the name predicates) and eight adapter
cases in `tests/bedrock-nether-adapter.test.mjs` (the view, `_pearlsHeld`, the
candidates, a successful `_avoidGaze` that verifies itself, its refusals, the
pumpkin equip with the armor slot checked, the option gates, and `_combat`
aiming exactly at the torso pitch). Suite: **870 tests**.

### Live round (03/10/2026)

| Probe | Result |
| --- | --- |
| `GET /observe` → `nether` | `enderman: null`, `pearls: 0`, `pumpkin: false`, `projectile: null` — the new perception is exposed and inert with no enderman around |
| `POST /act avoid_enderman_gaze` | `{"ok":false,"error":"no_enderman"}` immediately (no 3 s sweep) |
| `POST /act equip_pumpkin` | `{"ok":false,"error":"missing_pumpkin"}` in 0.01 s |
| `GET /options` | no `avoid_enderman_gaze`/`equip_pumpkin`, 26 ordinary keys (the gates hold) |
| `POST /act wait` | `{"ok":true}` — dispatch has no regression |
| `/observe.entities` | `villager_v2`, `cat`, `donkey`: the server sends **bare** type names, no `minecraft:` prefix |

### Known limits (N5)

- **No enderman was met live** (the live room is an Overworld room): the happy
  paths (mask, gaze escape, torso kill, pearl collection) are covered by unit
  tests only.
- The gaze escape is a head movement, not a path: it breaks the line instead of
  walking away, which is exactly what the enderman checks.
- Killing an enderman still goes through the generic `attack_<type>`: there is no
  `hunt_enderman` that decides to fight one only for its pearls.
- `pearls` counts the pearls in the slots; the drop of a kill is collected by the
  existing `collect_drop` path.
- A **namespaced** entity type (`minecraft:enderman`) used to be invisible to
  `_entityOfType`, which made `attack_enderman` impossible against a server that
  sends the prefix. Found by a unit test and fixed by comparing normalized
  names; the live server sends bare types, so it was never observed live.


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

## N6 — Fortress and blaze rods (implemented, live partial 03/10/2026)

The Nether's first real obstacle is not the walk: it is finding a **fortress** in
a dimension that is mostly empty, and surviving the **blazes** that guard it. N6
is two halves — *recognition* and *hunt* — and the split matters, because a
detector that hallucinates a fortress sends the bot on a long wrong trip.

### Implementation

| Layer | What it does |
|---|---|
| `structures.mjs` | New `nether_fortress` def (dimension `nether`): `nether_brick*` >= 12 (3 pts), nether brick trims (`fence`/`stairs`/`slab`/`wall`, `chiseled_`/`cracked_`) >= 2 (2 pts), `nether_wart` >= 1 (1 pt), spawner >= 1 (1 pt), a **blaze** within range (3 pts), `minScore 6`; anchors blaze -> bricks -> spawner. |
| `exploration.mjs` | `SEARCH_STRUCTURES.nether_fortress` aliases (`fortress`, `nether fortress`, `fortezza`, `fortezza del nether`, `fortezza nether`) so `POST /explore/find {"target":"fortezza"}` works like any other M4 target. |
| `bedrock-nether.mjs` | `lineBlocked({from,to,solid,step,skip})` samples the shot segment (the last sample *is* the target: a wall at the blaze's own cell is not cover); `coverCandidates({from,target,cells,solid,radius,limit})` keeps the cells whose shot is broken, nearest first (bot aim at eyes 1.62, blaze chest at 0.9); `blazeTactics({distance,health,cover,onFire,...})` -> `retreat` (`low_health`, `on_fire_with_cover`, `on_fire_without_cover`), `approach` (`unknown_distance`, `out_of_range`), `take_cover` (`no_line_of_sight`), `fight` (`in_reach`, `no_cover_available`); `blazeRodProgress({inventory,need})`. |
| `bedrock-adapter.mjs` | `_blazeRows`, `_coverFrom` (walkable candidates from `_standableNear`, `cellReachable`, never lava-adjacent — a cell the world does not know is **not** cover), `_inFire` (reads the top-level `inFire` of the nether view, not `hazard.inFire`), `_huntBlaze({timeoutMs})` — typed refusals `not_ready`/`no_blaze_nearby`/`too_hurt`, then assess -> retreat or take cover -> `_combat('blaze')` -> `_collectDrop`, with `blaze_hunted`/`blaze_retreated`/`blaze_cover_failed` logs; the option `hunt_blaze` appears only with a blaze within `BLAZE_RANGE` (16) and `health > BLAZE_RETREAT_HEALTH` (6); `_netherView` exposes `blaze`, `rods`, `hunt`. |
| `survival/intents.mjs` | `hunt_blaze: ['fight', 'collect']`. |

### Tests

`node --test tests/*.test.mjs` -> **885 tests, 885 pass**. The new ones: 5 pure
(`isBlazeType`/`isBlazeRod`, `lineBlocked` samples/skip, `coverCandidates`
ordering + no-cover, `blazeTactics` order of urgencies, `blazeRodProgress`), 8
adapter (`_coverFrom` with a real wall, the full hunt with cover ->
`['take_cover', 'fight', 'collect']` and one rod collected, fight in the open
with no cover, the two refusals, retreat on fire without cover, retreat *into*
cover with the line broken, fight when the cover cannot be reached, the option
gating), 1 detector (`nether_fortress` needs markers: bricks alone score 3 < 6,
bricks + trims 5 < 6, in the Overworld the def is skipped) and 1 search alias.

The tests found two real bugs: `_inFire()` read `hazard.inFire` (the field lives
at the top level of the view, so the bot was never "on fire" and would have
duelled while burning) and `_coverFrom` accepted any cell `_solidAt` called
solid — including cells the world does not know, so an unloaded chunk counted as
a wall and the bot walked into the open believing it was covered.

### Live round (03/10/2026)

The live world is the usual Overworld room: there is no fortress and no blaze.

| Probe | Answer |
|---|---|
| `GET /observe.nether` | `blaze: null`, `rods: 0`, `hunt: null` |
| `POST /act {"key":"hunt_blaze"}` | `{"ok":false,"error":"no_blaze_nearby","range":16}` — immediate |
| `GET /options` | 24 keys, no `hunt_blaze` |
| `POST /explore/find {"target":"fortezza del nether"}` | `ok`, mission `mission_find_structure_muryvma5` `type: find_structure` `target: structure:nether_fortress`, supersedes the previous search |
| `GET /explore/find` | `{"action":"move","waypoint":{"x":20,"z":64},"scan":{"radius":48,"found":0,"scannedChunks":125}}` |
| `GET /observe` (structures) | `["village","cave"]` only — the nether def is skipped in the Overworld, no phantom fortress |
| `POST /explore/find {"target":"cherry grove"}` | still `unknown_search_target` with the supported list, which now includes `structure:nether_fortress` |

### Known limits

- **No blaze, no fortress live**: the happy path (cover -> fight -> rod) is
  covered by unit tests only. The typed refusals and the detector's dimension
  guard *are* live-verified.
- **`_combat` is melee**: a blaze flies and shoots; N6 fights it when it is in
  reach and hides otherwise, but ranged combat is still missing.
- The hunt is a **single fight**, not a farm: it stops after one kill, so
  reaching seven rods is the progression engine's job (one `hunt_blaze` per rod).
- `nether_wart` is not an anchor: a corridor of bricks only stays under the
  threshold (5 < 6) and is not detected.

## Dependencies and risks

- **Fluids M0/M4** (lava/fire hazards) and **exploration** (fortress, stronghold)
  are prerequisites.
- **Goal Contract / Goal Manager** ([goal-achievement](goal-achievement.md)) is
  needed for a long persistent Nether run with suspend/resume.
- **Ranged combat** is missing: `_combat` is melee, but blaze and end crystals
  need a bow — N6 fights blazes only in reach and takes cover otherwise.
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
