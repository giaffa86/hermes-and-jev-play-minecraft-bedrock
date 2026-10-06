# Deep Dark stealth: sculk sensors, shriekers and the Warden

Roadmap for making the bot able to **cross a Deep Dark / Ancient City sculk
field without waking the Warden**: move at sneak speed along a route that keeps
every step outside the sculk sensors' hearing, never trigger a shrieker, and — if
the Warden is summoned anyway — leave crouched along a stored return route
instead of running or fighting.

Status: **W0, W1 and W2 implemented and unit-tested (06/10/2026)**; W3–W6 are
spec. Nothing here is collaudato live: the vibration model (8-block sphere,
player-vibration relay, sneak silence) and the shriek level have never been
observed on the real BDS. Full raw source:
[`docs/raw/DEEP_DARK_ROADMAP.md`](../raw/DEEP_DARK_ROADMAP.md).

Sources: `bedrock-adapter.mjs` (movement, sneak input, `DIG_PROTECTED`, effects
map), `bedrock-world.mjs` (`findBlocks`/`findBlocksByState`),
`bedrock-survival.mjs` (`HOSTILE_TYPES`, flee), `structures.mjs` (the
`ancient_city` marker rule), `exploration.mjs` (the `deep_dark` biome alias),
`circuits.mjs` (`DANGEROUS_ITEMS`/`FORBIDDEN_BLOCKS`), `bedrock-redstone.mjs`
(`sculk_sensor_phase`), [exploration](exploration.md),
[ai-player-roadmap](ai-player-roadmap.md), [fluids](fluids.md) (water in a
tunnel), [redstone](redstone.md) (the sensor primitive).

## Current state (from the code)

- **The marker rule exists, has never fired live.** `structures.mjs:84-96` marks
  `ancient_city` from the sculk family (`sculk` ≥ 8 score 3, `sculk_shrieker` ≥ 1
  score 3, `sculk_catalyst` ≥ 1 score 2, `minScore: 6`). No run has ever seen
  one (`found: 0`).
- **`deep_dark` is only a vocabulary entry.** `exploration.mjs:19` aliases the
  biome, but there is no `find_deep_dark` action anywhere.
- **Breaking sculk is refused twice over.** `DIG_PROTECTED`
  (`bedrock-adapter.mjs:86`) matches the whole family (`sculk$`, `sculk_vein$`,
  `sculk_catalyst$`, `sculk_sensor$`, `sculk_shrieker$`) and `_gatherProtected`
  (`:8499`) protects it by name as well; `circuits.mjs:79,87` keeps
  `sculk_shrieker` out of `DANGEROUS_ITEMS`/`FORBIDDEN_BLOCKS`. Since W0 a `dig_*`
  whose target cell sits inside a sensor sphere is also refused with
  `vibration_risk_<label>` (`_digTargets` `:9002`, `_digUp` `:13384`). But *any*
  break is itself a vibration: protection from breaking is not protection from
  being heard — what a *step* does is W1/W2.
- **Sneak is a movement mode since W1.** `_moveTo`
  (`bedrock-adapter.mjs:10401`) accepts `{ sneak }`, keeps the flag on every tick
  (`_beginMotionTrack` → `_stealthSneaking`, `_physicsStep`) and clears it at the
  end; the input is declared once (`_sendAuthInput` `:9180-9196`, transition
  `start_sneaking`/`stop_sneaking`). The older users remain the construction edge
  placement (`:10386-10402`) and the dismount/free-hand path (`:12603`, `:7471`).
  A plain `goto_waypoint` still walks: every normal step vibrates.
- **The Warden is a generic hostile.** `bedrock-survival.mjs:17`, height `2.9`
  at `:37`, and the generic `awayDirection` flee at `:44-46` — the opposite of
  the correct tactic (do not run). Since W0 the census *sees* it (`_wardenView`
  inside `_sculkCensus`, `bedrock-adapter.mjs:1500`) with presence, distance and
  health, but nothing acts on it yet (W3).
- **Darkness is read since W0.** `this.effects` (`bedrock-adapter.mjs:408`,
  filled by `_onMobEffect` at `:1646`) was consulted only for water breathing;
  the sculk census now reports `darkness` in `/observe.sculk`. Nothing reacts to
  it yet (W5).
- **The sensor primitive already exists.** `bedrock-redstone.mjs:172` reads
  `sculk_sensor_phase`, and `:56-57` lists the sensor among the sensed
  components. W0 models *what it hears*: `sensorPhase`, `vibrationRisk` and
  `pointSegmentDistance` (`bedrock-vibration.mjs`), with `_vibrationRiskAt`
  (`bedrock-adapter.mjs:1589`) as the consumption point.
- **No underground navigation.** The A* is surface-oriented; the Deep Dark needs
  the 3D navigation of [ai-player-roadmap](ai-player-roadmap.md), as stated in
  [exploration](exploration.md). The survey is a histogram of the ~48 loaded
  blocks, not a map.

## The mechanics the model must encode

Re-verification needed against the deployed Bedrock build; the current reference:

- **Sculk Sensor** — hears vibrations in a **sphere of 8 blocks**. A vibration
  caused by a *player* also activates nearby **shriekers**. **Sneaking prevents
  movement vibrations**; **wool occludes**.
- **Sculk Shrieker** — shrieks when a player stands on top of it (even crouched)
  or when a nearby sensor is triggered by a player. Natural shriekers inflict
  **Darkness** and can summon the Warden; placed/catalyst-grown shriekers are
  inert.
- **Warden** — **3 shrieks** summon it; blind; follows **vibrations and smell**;
  2.9 blocks tall, **500 HP**.

## Plan (W0–W6)

- **W0 — Vibration awareness. ✅ implemented and unit-tested (06/10/2026).**
  `bedrock-vibration.mjs` is pure and closed: `VIBRATION_RADIUS = 8`,
  `vibrationProfile(action)`, `sensorPhase`/`shriekerState`, `vibrationRisk` (the
  sphere), `pointSegmentDistance` (a whole walking leg, in place of the spec's
  `sensorCoverage`), `shriekerVerdict` (standing on a shrieker is refused even
  crouched), `wardenWarning` (`clear`/`warning`/`summoned`) and `summarizeSculk`.
  The adapter has `_sculkCensus` (throttled by `SCULK_RESCAN_MS`, `ready: false`
  on an unloaded world — and no risk is reported when not ready, because an
  unlooked-at world must not be read as silence — shrieks counted once on the
  `active` transition inside `SHRIEK_WINDOW_MS`), `_wardenView`, `_sculkView`,
  `_vibrationRiskAt`, `observe().sculk` and `GET /observe.sculk`; the whole
  `SCULK_FAMILY` is in `DIG_PROTECTED` and any `dig_*` inside a sensor sphere is
  refused with `vibration_risk_<label>`.
- **W1 — Sneak-walk as a real mode. ✅ implemented and unit-tested (06/10/2026).**
  `_moveTo(..., { sneak: true })` keeps the sneak flag on every tick
  (`SNEAK_SPEED_FACTOR` in `_physicsStep`) and declares it on the wire once, and
  the speed the server actually accepted is measured against the sneak ceiling
  (`classifySneakSpeed`, `SNEAK_SPEED_CEILING_MPS = 2.6`): above it the walk is a
  typed `not_sneaking` failure, because silence must be *verified*, never
  assumed; a track with no real step is `no_measurement`, not a silent success.
  Action `sneak_to` (offered next to `goto_waypoint`, `riding` refusal) +
  `GET /observe.sneak`.
- **W2 — Stealth pathfinding. ✅ implemented and unit-tested (06/10/2026).**
  The planner is pure (`SENSOR_CELL_COST = 50` per risky cell, shrieker cells
  forbidden, `astarStealth` + `planStealthRoute` in `bedrock-vibration.mjs`) and
  the adapter feeds it the census (`_stealthPlanner` → `sculk_unknown` when the
  world was never scanned) and the walk graph (`_neighbors`, so a route can only
  contain steps, never a break or a placement). The exit route is **re-planned**,
  not the inbound path reversed (a fall works one way only), and a plan without
  one is refused as `no_exit_route`; a plan crossing a sphere is refused as
  `no_stealth_route` and never silently shortened. The accepted plan stays in
  `_stealthRoute` (mission memory for W3's `escape_deep_dark`) and travels back in
  the result as `{cells, maxRisk, sneak: true, exit}`; `_placeAtCell` refuses
  `vibration_risk_place` and the `mine_<block>` branch refuses
  `vibration_risk_mine` unless a silent target exists. Actions: `sneak_to` /
  `walk_stealthy`.
- **W3 — Shrieker/Warden warning.** `shriekLevel` (shrieking transitions +
  Darkness, lower bound if the server hides the warning level), `wardenWarning`
  verdicts `clear`/`warning`/`summoned`, and the tactic: freeze and leave
  crouched along the return route; never `start_running`; hold when the exit is
  far. The governor must **block** the generic flee for `warden`.
- **W4 — Underground 3D navigation.** Pillar/bridge/tunnel through
  `DIG_PROTECTED` and the [fluids](fluids.md) checks, the same cost hooks as W2,
  and `find_deep_dark` (the M6 target of [exploration](exploration.md)) with a
  descent route and a return route.
- **W5 — Darkness, kit, mission.** Darkness as a warning that the Warden may
  already be near; the Deep Dark kit as a declared state plus an **escape
  budget**; a `reach_deep_dark` progression milestone behind advanced navigation
  + exploration, and a `CURRICULUM=deep_dark`.
- **W6 — Limits and docs.** Observe, never loot; never break or place
  shrieker/sensor/catalyst; **never a Warden in the shared world without consent**;
  no client-side "silence" trick; documentation in `BEDROCK.md` and this page.

## Status by milestone

| # | Milestone | Content | Status |
|---|---|---|---|
| W0 | Vibration awareness | Pure vibration model + whole `SCULK_FAMILY` in `DIG_PROTECTED` + `vibration_risk_<label>` + `/observe.sculk`. | ✅ implemented, unit-tested (11 pure + 8 adapter cases); never live |
| W1 | Sneak-walk as a real mode | Persistent sneak flag, speed verdict measured from the server (`not_sneaking`), `sneak_to`, `/observe.sneak`. | ✅ implemented, unit-tested (6 adapter cases); never live |
| W2 | Stealth pathfinding | Vibration cost, forbidden shrieker cells, walk-only routes (no dig/place by construction), mandatory re-planned return route, `no_stealth_route`/`no_exit_route`. | ✅ implemented, unit-tested (11 pure + 5 adapter cases); never live |
| W3 | Shrieker/Warden warning | `shriekLevel` verdicts and the crouched-escape tactic; the governor must block the generic flee for a Warden. | ❌ spec |
| W4 | Underground 3D navigation | Pillar/bridge/tunnel with the fluid checks, `find_deep_dark` and the descent/return routes. | ❌ spec |
| W5 | Darkness, kit, mission | Darkness as a proximity warning, the declared kit + escape budget, `reach_deep_dark`, `CURRICULUM=deep_dark`. | ❌ spec |
| W6 | Limits and docs | Observe, never loot; never a Warden in the shared world without consent; `BEDROCK.md` + this page. | ◑ `sneak_to` and the observation routes documented; the rest is spec |

## Open risks

- The Bedrock numbers (8-block sphere, player-vibration relay, wool occlusion,
  3-shriek summon) need a live probe before being trusted.
- The shriek warning level may not be observable in the block state, making
  `shriekLevel` a lower bound.
- No loaded Ancient City in this world: the live proof needs an expedition or a
  disposable world copy, and the W3 live round needs explicit consent.
- Bedrock Warden AI (hearing, smell) may differ from the reference.

## Related pages

- [exploration](exploration.md) — the mission model, the M6 underground targets and the current "observe from a safe distance" default.
- [ai-player-roadmap](ai-player-roadmap.md) — world awareness and advanced (3D) navigation.
- [fluids](fluids.md) — water in a tunnel/bridge route.
- [redstone](redstone.md) — the sensor state primitive (`sculk_sensor_phase`).
- [survival-intelligence](survival-intelligence.md) — governor, skills, verifier, progression.
- [verification](verification.md) — collaudo status per capability (nothing here is live yet).
- [open-questions](open-questions.md) — tracked gaps and blockers.
- [roadmap](roadmap.md) — consolidated status.
