# Nether and End (survival, ghasts, piglins, endermen, portals)

Roadmap for taking the bot from the first Nether portal to the End while
**surviving the Nether**: locate a nearby portal (reuse the base's), avoid
**ghast** fireballs, **barter gold with piglins**, **never meet an enderman's
gaze**, collect **blaze rods** and **ender pearls**, craft eyes of ender, find the
stronghold, open the End portal, and (stretch) defeat the **Ender Dragon**.

Status: **N0 (awareness and hazards) implemented, unit-tested and partially
collaudato live (03/10/2026); N1–N7 still spec only**.
`knowledge/progression.json` now has the full chain and the
`beat_the_dragon → enter_nether` contradiction is fixed: `beat_the_dragon` is a
real milestone requiring `enter_end`. Full raw source:
[`docs/raw/NETHER_ROADMAP.md`](../raw/NETHER_ROADMAP.md).

Sources: `knowledge/progression.json`, `skills/gameplay/progression/*`,
`bedrock-survival.mjs` (`HOSTILE_TYPES` already includes `ghast`, `blaze`,
`piglin`, `enderman`, `piglbrute`, `hoglin`, `magma_cube`, `ender_dragon`),
`bedrock-adapter.mjs`, [fluids](fluids.md), [goal-achievement](goal-achievement.md).

## Current state

- **`enter_nether` is not implemented**: the skill exists (`success: {dimension:
  nether}`) but there is **no portal action** — no `place_obsidian`, no
  `light_portal`/`flint_and_steel`, no "find a nearby `portal`".
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
| N1 | Portal locate/build/light/enter | `goto_portal`, `build_portal`, `light_portal`, `enter_portal`; prefer reusing a nearby portal; verify `portal` block then `dimension: nether`. | ❌ not implemented |
| N2 | Nether survival | fire/lava avoidance (fluids), minimal nether hub, fall handling (no water), never sleep/place water. | ❌ not implemented |
| N3 | Ghast avoidance | track fireballs, dodge perpendicular to the trajectory (or deflect), never flee into lava. | ❌ not implemented |
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

## Dependencies and risks

- **Fluids M0/M4** (lava/fire hazards) and **exploration** (fortress, stronghold)
  are prerequisites.
- **Goal Contract / Goal Manager** ([goal-achievement](goal-achievement.md)) is
  needed for a long persistent Nether run with suspend/resume.
- **Ranged combat** is missing: `_combat` is melee, but blaze and end crystals
  need a bow.
- **Death loses everything** (`keep-inventory=false`) — establish a hub/respawn
  anchor early (N1–N2).
- The ghast dodge geometry must be calibrated to the real projectile speed and
  latency.
- A **`bossDefeated`** verifier criterion does not exist, so `beat_the_dragon`
  cannot be verified today.

## Related pages

- [fluids](fluids.md) — lava/fire hazards and water rules (water is unusable in the Nether).
- [goal-achievement](goal-achievement.md) — Goal Contract, task graph and benchmarks.
- [exploration](exploration.md) — finding the fortress/stronghold.
- [roadmap](roadmap.md) — consolidated implementation status.
- [open-questions](open-questions.md) — blockers and verification gaps.
- [survival-intelligence](survival-intelligence.md) — progression, skills, verifier.
