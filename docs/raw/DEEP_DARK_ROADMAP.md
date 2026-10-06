# Roadmap — Deep Dark stealth: sculk sensors, shriekers and the Warden

> Raw source (spec). Synthesis and milestone status in
> [`wiki/deep-dark.md`](../wiki/deep-dark.md).
> Status: **W0 (vibration awareness), W1 (sneak-walk verified from the measured
> speed) and W2 (vibration-cost stealth pathfinding with a mandatory exit route)
> implemented and unit-tested (06/10/2026), never live; W3–W6 spec** (the
> milestone status is tracked in the wiki page, not here).
> Code references: `bedrock-adapter.mjs`, `bedrock-world.mjs`,
> `bedrock-survival.mjs`, `structures.mjs`, `exploration.mjs`, `circuits.mjs`,
> `survival/*`, `knowledge/*.json`.

## Objective

Make the bot able to **enter the Deep Dark and cross an Ancient City's sculk
field without waking the Warden**: move at sneak speed along a route that keeps
every step outside the sculk sensors' hearing, never shriek, and if the Warden
is summoned anyway, leave crouched along a pre-computed return route instead of
running or fighting.

The end state is *observe and report from a safe distance, with a way out* — the
current default in [exploration](../wiki/exploration.md) — turned into something the
bot can actually execute. Looting an Ancient City is explicitly **not** part of
this roadmap.

Design principle, same as the other roadmaps: the Warden is not a prompt problem.
Sculk vibration is a **deterministic, measurable** rule (radius, frequency,
occlusion), so the bot must *model it*, *measure it from the world* and *verify
the absence of a shriek* — never guess that it is being quiet.

---

## Current state (verified from the code)

1. **Structure rule exists, never observed live.** `structures.mjs:84-96` marks
   `ancient_city` from the sculk family (`sculk` ≥ 8 → score 3,
   `sculk_shrieker` ≥ 1 → 3, `sculk_catalyst` ≥ 1 → 2, `minScore: 6`, anchors
   `['sculk_shrieker', 'sculk_catalyst', 'sculk']`). No live run has ever seen
   one (`found: 0`, no false positive either).
2. **The biome is a vocabulary entry and nothing more.** `exploration.mjs:19`
   aliases `deep_dark: ['deep_dark', 'deep dark']`; there is **no**
   `find_deep_dark` action in the adapter, harness or controller.
3. **Sculk blocks are already protected from digging.** `bedrock-adapter.mjs:86`
   `DIG_PROTECTED` already matches `sculk_sensor$` and `sculk_shrieker$`, and
   `circuits.mjs:79,87` lists `sculk_shrieker` in `DANGEROUS_ITEMS` and
   `FORBIDDEN_BLOCKS`. What is missing is the other half of the truth: **any**
   break is itself a vibration, so protection from breaking is not protection
   from being heard.
4. **The sensor can already be *read*.** `bedrock-redstone.mjs:171` (R0) reads
   `sculk_sensor_phase`, and `bedrock-redstone.mjs:56-57` lists
   `sculk_sensor`/`calibrated_sculk_sensor` among the components it senses. The
   primitive to inspect a sensor exists; the model of what it hears does not.
5. **The Warden is a generic hostile.** `bedrock-survival.mjs:17` has `'warden'`
   in `HOSTILE_TYPES`, `:37` gives it height `2.9` (for aiming), and the flee
   behaviour is the generic `awayDirection` (`bedrock-survival.mjs:44-46`). The
   correct tactic (do **not** run) is the opposite of the default.
6. **Sneak is a construction input, not a movement mode.** `bedrock-adapter.mjs`
   `:10188-10204` (`_constructionSneaking`), the input flag at `:9039-9042`
   (used to place a block on an edge for 2.5 s) and the dismount/free-hands path
   (`:12405` `start_sneak`, `:7331` `stop_sneak`). Ordinary movement explicitly
   resets it: `_moveTo` clears the sneak flag at `bedrock-adapter.mjs:10456`.
   Every normal step therefore produces step vibrations.
7. **Effects are parsed but barely used.** `this.effects` (`bedrock-adapter.mjs:408/1646`)
   is consulted only for water breathing, so the **Darkness** effect that the
   Warden inflicts is invisible to the controller.
8. **No underground navigation.** The A* is surface-oriented (support, ±1 steps,
   short falls). [exploration](../wiki/exploration.md) states that the Deep Dark
   needs 3D pathfinding plus dig/place/pillar — the AI-player "advanced
   navigation" milestone ([ai-player-roadmap](../wiki/ai-player-roadmap.md)). The survey
   itself is an histogram of the ~48 loaded blocks, not a map.
9. **Declared default is a stop-gap.** "Observe and report from a safe distance"
   ([exploration](../wiki/exploration.md)) and `explore.findDeepDark()` sketched in
   [`GOAL_EXPLORATION.md`](GOAL_EXPLORATION.md) but never implemented.

### Game mechanics this roadmap must model

Checked against the public mechanics reference on 05/10/2026; each number below
still has to be re-verified against the Bedrock build actually deployed:

- **Sculk Sensor** detects vibrations inside a **sphere of 8 blocks**. A
  vibration caused by a *player* also activates nearby **Sculk Shriekers**.
  **Sneaking prevents the movement vibrations**; **wool occludes** the signal.
- **Sculk Shrieker** shrieks when a player stands on top of it (even crouched)
  or when a nearby sensor is triggered by a player. Naturally generated shriekers
  in the Deep Dark inflict **Darkness** and can summon the Warden; shriekers
  placed by a player or grown by a catalyst are inert.
- **Warden** is summoned after **3 shrieks** (warning level) within the decay
  window, is **blind**, tracks **vibrations and smell**, is 2.9 blocks tall and
  has **500 HP**.

## Proposed vocabulary (closed loaders, per convention)

### New `/options` action keys

| Key | Meaning |
|---|---|
| `find_deep_dark` | Exploration action: descend and reach the `deep_dark` biome (the `explore.findDeepDark()` target of `GOAL_EXPLORATION.md`), report and stop at a safe distance. |
| `sneak_to` / `walk_stealthy` | Move to a waypoint at sneak speed along a route whose cells stay outside every sensor's vibration radius. |
| `step_off_shrieker` | Reposition off a cell that carries a shrieker (or whose floor block is one) before doing anything else. |
| `listen_vibrations` | Diagnostic: sensors and shriekers in radius with distance and phase, the shriek level, the bot's own vibration footprint. |
| `escape_deep_dark` | Route out to the nearest recorded surface checkpoint; crouched, no digging, no placing unless the route requires it. |

### New survival intents (`survival/intents.mjs`)

| Intent | Meaning |
|---|---|
| `stealth` | Move without producing player vibrations. |
| `sculk` | Sense and handle the sensor/shrieker family (protect, never place, never stand on). |
| `warden` | Escape / hold: the tactic when the Warden is summoned or about to be. |

### New item/block tags (`survival/item-tags.mjs`)

| Tag | Members |
|---|---|
| `SCULK_FAMILY` | `sculk`, `sculk_vein`, `sculk_catalyst`, `sculk_sensor`, `calibrated_sculk_sensor`, `sculk_shrieker`, `sculk_sensor_phase` (state) |
| `STEALTH_KIT` | `wool` (occlusion), blocks for bridge/pillar, torches, pickaxe, sword + armor, food, water bucket |
| `WARDEN_TACTIC` | nothing to equip — the tactic is the absence of action (never `start_running`) |

### New governor conditions / verifier criteria

| Name | Meaning |
|---|---|
| `vibrationRisk` | Count (0..n) of loaded sensors whose 8-block sphere contains the destination/bot cell. |
| `shriekerNearby` | A shrieker occupies the bot's cell or its floor cell. |
| `shriekLevel` | Observed shrieks in the decay window (0..3+). |
| `darknessActive` | The Darkness effect is on the bot (the `this.effects` map). |
| `wardenPresent` / `wardenDistance` | Entity registry + distance. |
| `sneakActive` | Verified from server position samples, not from the request. |
| `stealthRoute` | A route exists whose every cell has `vibrationRisk === 0`. |

---

## Milestones

### W0 — Vibration awareness (perception only, no movement change)

**Deliverable**

- New pure module `bedrock-vibration.mjs`:
  - `VIBRATION_RADIUS = 8` and a `vibrationProfile(action)` table (which
    actions vibrate, and at which frequency: step vs break vs place vs open);
  - `vibrationRisk(point, sensors)` — a cell inside any sensor's sphere;
  - `sensorCoverage(sensors, from, to)` — is a *segment* heard (not just the
    endpoint);
  - `shriekerVerdict(cell, shriekers)` — refuse a cell that carries a shrieker;
  - `wardenWarning(shriekLevel, windowMs)` → `clear` / `warning` / `summoned`.
- Adapter census `_refreshSculk()` (throttled by `SCULK_RESCAN_MS`) and a new
  `GET /observe.sculk` route: `{sensors: [{name, position, distance, phase}],
  shriekers: [{position, canSummon, shrieking}], sculkCells, darkness,
  vibrationRiskAtBot, warden: {present, distance, health}}`. Reuse
  `findBlocks`/`findBlocksByState` in `bedrock-world.mjs`; report
  `checked: true` even when the field is empty, so "no sculk loaded" is not
  confused with "not looked".
- Extend `DIG_PROTECTED` (`bedrock-adapter.mjs:86`) to the whole `SCULK_FAMILY`,
  and refuse `dig_*` inside a sensor radius with a typed code
  (`vibration_risk`) — digging is a vibration even when the block is not sculk.
- Pure tests in `tests/bedrock-vibration.test.mjs` (see the test plan).

**Test**: `bedrock-vibration.test.mjs` — a sensor at exactly 8.0 blocks is a
risk, at 8.1 it is not; a segment passing through the sphere is heard even
though both ends are outside; a shrieker on the bot's cell is refused; the
warning threshold flips at the third shriek and decays.

**Accettazione**: live `/observe.sculk` returns the declared shape in the normal
world (empty sensors is a valid answer, `checked: true`); a `dig_down` onto a
sculk block is refused; a unit A/B shows the risk verdict changing with distance.

### W1 — Sneak-walk as a real movement mode

**Deliverable**

- `_moveTo` gains a `{sneak: true}` mode: it sends the sneak input before the
  first movement tick, keeps `sneaking` on every `player_auth_input`, and clears
  it only after the last tick of the path (the opposite of the current
  `bedrock-adapter.mjs:10456` reset).
- Speed verification from the server: sample the authoritative position and
  classify the measured speed against a **sneak ceiling** (sneak is much slower
  than a walk). A measured speed above the ceiling is a typed outcome
  (`not_sneaking`): the server did not accept the state, so the pledge of
  silence is false and the caller must not claim stealth.
- Bounded action `sneak_to` (alias of `walk_stealthy`) and `GET /observe.sneak`
  reporting `{active, speed, ceiling, samples}`.
- Keep `_constructionSneaking` for the construction path; only the stealth path
  uses the new mode.

**Test**: `tests/bedrock-motion.test.mjs` — the speed classifier (below/above
ceiling), the input flags on every tick of a simulated path, the flag cleared at
the end, and that a normal `move_to` is untouched.

**Accettazione**: live A/B on the same 10-block route — `sneak_to` measures the
sneak rate and reports `sneakActive: true` for the whole path; `move_to` on the
same route measures the walk rate. Never claim stealth from the request alone.

### W2 — Stealth pathfinding (vibration-cost A*)

**Deliverable**

- `planStealthRoute(from, to, world)` in a pure module, plugged into the existing
  planner: every cell inside a sensor sphere gets a high cost, a cell carrying a
  shrieker is forbidden, digging is forbidden inside a Deep Dark volume (a break
  is a vibration) and so is placing (the placement itself vibrates).
- A typed refusal `no_stealth_route` instead of a route through a sensor radius:
  the bot stops and reports rather than improvising.
- The stealth route composes with the exploration mission model (M1 spiral,
  checkpoints): **a return route out of the Deep Dark must exist before the bot
  enters**, and it is stored with the mission so `escape_deep_dark` can replay it.
- The plan reports `{cells, maxRisk, sneak: true, exit}` so the harness can show
  the operator what will be walked.

**Implemented (06/10/2026).** `bedrock-vibration.mjs` exports
`SENSOR_CELL_COST = 50`, `stealthCellCost({cell, sensors, shriekers, radius})`,
`astarStealth({start, goal, neighbors, cellCost, maxNodes})`,
`planStealthRoute({start, goal, exit, neighbors, cellCost, maxNodes, maxRisk})`
and `summarizeStealthPlan(plan)`; the adapter wires it through `_stealthPlanner`
(the census as the cost source, `sculk_unknown` when the world was never
scanned), `_planStealthRoute`, `_rememberStealthRoute`/`_stealthRouteView` and
`_moveTo(..., { stealth: true })`. Three deviations from the text above, all of
them narrowing: (a) the planner is pure and takes `neighbors`/`cellCost`
callbacks instead of a `world` — the adapter owns the walk graph and the census,
the planner owns the cost; (b) "no digging and no placing inside the Deep Dark"
holds **by construction**, because the neighbour generator is walking-only, so no
break or placement can appear in a route at all — the two refusals that do exist
live at `_placeAtCell` (`vibration_risk_place`, with an `allowVibrationRisk`
escape for placements that must happen anyway) and at the `mine_<block>` branch
(`vibration_risk_mine: <block> at x,y,z (N sculk sensor(s) in range)`, with
`_pickMineTarget` preferring a silent target when one exists); (c) the exit route
is **re-planned** towards the exit instead of being the inbound path reversed (a
fall works one way only), and a missing exit is its own typed refusal
`no_exit_route`. The action alias is `walk_stealthy`; the last accepted plan stays
in `_stealthRoute` as mission memory for W3's `escape_deep_dark`. Tests: 11 pure
cases in `tests/bedrock-stealth-route.test.mjs` plus 5 adapter cases in
`tests/bedrock-vibration-adapter.test.mjs`; merged suite **1585/1585**. The live
acceptance row below is still pending: the world has no loaded Deep Dark.

**Test**: `tests/bedrock-stealth-route.test.mjs` — a route that would shorten
through a sensor sphere is either detoured or refused, never shortened; a
shrieker cell is forbidden; the exit route is present in every accepted plan.

**Accettazione**: unit for the planner; live only if the world offers a
two-sensor corridor — sneak through it and show **no** phase activation in
`/observe.sculk` (and a `maxRisk: 0` plan).

### W3 — Shrieker and Warden warning

**Deliverable**

- `shriekLevel` from the observable signals: the `shrieking` transition of a
  natural shrieker, plus the Darkness effect as the second signal, with a decay
  window. If the server does not expose the warning level, the counter is a
  **lower bound** and the roadmap says so (see risks).
- `wardenWarning` verdict `clear` / `warning` / `summoned`, and the tactic:
  - **warning** (shrieks started, Warden not yet summoned): freeze, then leave
    the sensor radius crouched along the stored return route; never run.
  - **summoned**: `escape_deep_dark` crouched along the return route; never dig,
    never place, never `start_running` (running vibrates); when the exit is far
    and the Warden is within hearing range, *hold* rather than move.
- `GET /observe.warden` with `{present, distance, health, shriekLevel, verdict,
  darkness}` and the `escape_deep_dark` action.
- The governor must **block** the generic flee (`awayDirection`) for
  `warden` — the survival default (`bedrock-survival.mjs:44-46`) is wrong here.

**Test**: `tests/bedrock-warden.test.mjs` — verdict transitions, the decay
window, the tactic chosen for each verdict, and the anti-run assertion (a
`summoned` state never plans `start_running`).

**Accettazione**: unit + simulation only, until a world where summoning the
Warden is acceptable is available. **Never summon the Warden in the shared
family world for a test without explicit consent.**

### W4 — Underground 3D navigation (the enabler)

**Deliverable**

- 3D pathfinding in the planner: support/±1 steps/short falls **plus** vertical
  moves — pillar up, bridge over, dig a tunnel (through `DIG_PROTECTED` and the
  fluid checks of [fluids](../wiki/fluids.md)), with the same cost hooks as W2 so a
  stealth route can use them.
- `find_deep_dark`: the M6 target of [exploration](../wiki/exploration.md)
  ("reach the `deep_dark` biome without summoning the Warden; if found, stop at a
  safe distance and report"), with a descent route, checkpoints and a return
  route.
- The survey limitation stays explicit: the histogram sees the loaded blocks, it
  does not follow a structure.

**Test**: `tests/bedrock-3d-nav.test.mjs` — a tunnel/bridge/pillar route through a
synthetic heightmap, a protected block in the tunnel is refused, a route with no
support below is not silently planned.

**Accettazione**: spec + unit for the planner; the live descent is deferred until
a Deep Dark target is reachable in a bounded round.

### W5 — Darkness, kit and mission integration

**Deliverable**

- Darkness handling from the existing effects map (`bedrock-adapter.mjs:408/1646`):
  report `darknessActive` as a **warning that the Warden may already be near**,
  never as a blocker. The mitigation is the return route plus the hold tactic
  (no night-vision dependency).
- Deep Dark kit as a declared state (like the trip kit): torches, blocks for
  bridge/pillar, sword + armor, food, a water bucket, a pickaxe and **free
  inventory space** — plus an **escape budget**: never enter when the exit needs
  more travel than the remaining budget allows.
- Progression: a `reach_deep_dark` milestone gated behind the advanced-navigation
  and exploration milestones, and a `CURRICULUM=deep_dark` entry for the bounded
  curriculum runs.

**Test**: `tests/bedrock-deep-kit.test.mjs` — the kit state and the escape
budget refusal; the Darkness effect surfaced in `observe()`.

**Accettazione**: unit; live only for the kit/visibility part (Darkness can be
induced with a shrieker, which is exactly what W3 forbids without consent).

### W6 — Limits, safety, documentation

**Deliverable**

- **Not looting** the Ancient City in this version: observe and report; a loot
  milestone is separate and gated behind a real escape route.
- Never break **or place** a shrieker/sensor/catalyst (`DIG_PROTECTED` +
  `FORBIDDEN_BLOCKS`, completed in W0).
- Never a Warden in the shared world without explicit consent: the W3 live proof
  is either a disposable copy of the world or an explicit operator decision.
- No sound or client-side "silence" trick: the honest model is the server's
  rules; `sneakActive` is verified, not assumed.
- Documentation: `BEDROCK.md` action table, a new `wiki/deep-dark.md`, plus
  [exploration](../wiki/exploration.md), [verification](../wiki/verification.md),
  [open-questions](../wiki/open-questions.md) and [roadmap](../wiki/roadmap.md).

**Test**: the wiki lint and the privacy gate on the new files.

**Accettazione**: docs consistent with the code and the roadmap linked from
`index.md`.

---

## Test plan

| Level | What | File |
|---|---|---|
| pure | Vibration radius/segment risk, shrieker cell verdict, warning threshold, decay | `tests/bedrock-vibration.test.mjs` |
| pure | Sneak speed classifier + input flags | `tests/bedrock-motion.test.mjs` |
| pure | Stealth route cost, refusal and exit invariant | `tests/bedrock-stealth-route.test.mjs` |
| unit | `walk_stealthy` plan pass-through and `sculk_unknown`, `vibration_risk_place`/`vibration_risk_mine` refusals | `tests/bedrock-vibration-adapter.test.mjs` |
| pure | Warden verdict transitions and anti-run tactic | `tests/bedrock-warden.test.mjs` |
| pure | 3D route (tunnel/bridge/pillar), protected block refusal | `tests/bedrock-3d-nav.test.mjs` |
| unit | `DIG_PROTECTED` covers the whole `SCULK_FAMILY`; `FORBIDDEN_BLOCKS` unchanged | `tests/bedrock-dig.test.mjs` |
| unit | `ancient_city` rule unchanged and its live gap flagged | `tests/structures.test.mjs` |
| live | `/observe.sculk` shape, refused dig, sneak A/B, refused route | BDS host, bounded round |

Operational constraints for the live rows: one bot account at a time, stop the
container when the round ends, keep the base untouched, and no Warden in the
shared world.

## Risks and open questions

1. **Are the Bedrock 1.26.x numbers the Java numbers?** The 8-block sphere, the
   player-vibration relay to shriekers, the wool occlusion and the 3-shriek
   summon must be re-verified on the deployed build (block-state capture or a
   controlled probe) before the model is trusted. Until then the roadmap numbers
   are the reference, not a guarantee.
2. **Is the shriek warning level observable?** If `warning_level` is not exposed
   in the block state, `shriekLevel` is reconstructed from `shrieking`
   transitions and Darkness — a lower bound that can under-count.
3. **Warden AI on Bedrock** (hearing distance, smell) may differ from the
   reference; the tactic must not depend on exact numbers beyond "far is safer".
4. **No loaded Ancient City in this world.** The detector has never fired live;
   the whole live proof needs either a long expedition or a disposable copy of a
   Deep Dark world.
5. **Shared family world.** Summoning a Warden is a destructive, persistent
   event: W3's live acceptance is deferred and gated on explicit consent.
6. **Sneak speed vs the server.** The Bedrock server may move the bot differently
   from the request; W1 measures the authoritative speed instead of assuming, and
   a mismatch is a typed failure, not a silent "quiet" run.
7. **Held-item/offhand requirement for sensors.** Sculk sensors detect item
   interactions (e.g. eating); the vibration profile has to be honest about the
   actions the bot already performs while walking.

## Non-objectives (for now)

- Fighting the Warden (500 HP, blind but deadly: a melee duel is a death
  sentence).
- Looting the Ancient City, its chests or its Redstone-engineered treasure.
- Sculk farms, catalyst XP farming and shrieker engineering.
- Any client-side "silence"/anti-vibration exploit.
- A full 3D voxel planner beyond what `find_deep_dark` needs.
