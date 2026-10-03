# Survival Intelligence Layer (synthesis)

A **deterministic** layer between the user objective and the bounded actions,
inspired by Voyager (skill library, curriculum, self-verification) but **without
code-generation**: no model generates executable JavaScript for Minecraft
behaviour.

Full reference: [`docs/raw/SURVIVAL-INTELLIGENCE.md`](../raw/SURVIVAL-INTELLIGENCE.md).
Related: [headless-client](headless-client.md), [overview](overview.md),
[control-flow](control-flow.md).

## What it does

The chain is: **user goal → progression → plan → governor → resolver → bounded
actions → verification → next milestone.**

1. **Survival Governor** (`survival/governor.mjs` + `knowledge/survival-rules.json`)
   scores health/food/hostiles/night and returns `{mode: normal|caution|emergency,
   needs, overrideObjective, allowedIntents, preferredSkills, risk}`. In an
   emergency (priority ≥ 95 or `critical` risk) it overrides the objective shown to
   the model and restricts `/options` to the allowed intents — only removing keys,
   never adding, never emptying the set.
2. **Declarative gameplay skills** (`skills/gameplay/**/*.json`) are JSON contracts
   (preconditions, success/failure criteria, intents) — different from the Hermes
   `SKILL.md`. They never contain executable code.
3. **Skill Resolver** (`survival/resolver.mjs`) picks the active skill: the
   governor's preference in an emergency, then the plan's optional `skill` field,
   then the progression milestone. Its intents boost relevance in option ranking.
4. **Deterministic verification** (`survival/verify.mjs`) checks real harness state
   (inventory by tag, hunger/health deltas, threat distance, night survived) — never
   the model's opinion. Outcomes land in `runs/<run>/skills.jsonl`.
5. **Progression Engine** (`survival/progression.mjs` + `knowledge/progression.json`)
   is a dependency graph (`wood → crafting_table → stone_tools → … → enter_nether →
   nether_survival → … → enter_end → beat_the_dragon`; see [nether](nether.md)).
   `resolveMilestone` returns the first missing prerequisite; with
   `CURRICULUM=<milestone>` the controller drives the chain deterministically and
   uses Hermes only as fallback.
6. **Goal Contract** (`survival/goal-contract.mjs`, Slice A) wraps the shallow
   `plan` in `target`/`constraints`/`success`/`failure` and derives a status
   (`RUNNING`/`SUCCESS`/`FAILED`/`BLOCKED`) with the same verifier vocabulary;
   `maxDeaths`/`preserveItems` become constraints and `deathsAtLeast`/
   `itemPreserved` the new criteria. Opt-in via `GOAL_CONTRACT`/`MAX_DEATHS`/
   `PRESERVE_ITEMS`; see [goal-achievement](goal-achievement.md).

## Key principle

**Deterministic before the prompt**: `code/rules → compact structured state →
model`, never `huge prompt → the model guesses`. The models never control
mechanics and never bypass `/options`.

## Melee and creeper defense

Melee against a creeper is a losing play (≈49 explosion damage). The layer
encodes that deterministically:

- `knowledge/survival-rules.json` → `creeper_immediate` (priority 97): a creeper
  within 6 blocks forces `emergency` with intents `["escape", "shelter"]` and the
  objective *"do not fight it in melee"*; the preferred skill is `escape_hostile`.
- `survival/perception.mjs` gives the creeper its own threat profile (critical at
  5, high at 10, medium at 16).
- The harness filter (`filterOptionsForGovernor`) drops every option whose intents
  are not allowed, so `attack_creeper` → `['fight']` is removed while `flee` →
  `['escape']` stays.
- The defence actions are mapped onto those intents in `survival/intents.mjs`:
  `go_home`/`retreat` → `['escape', 'shelter']`, `close_door`/`barricade` →
  `['shelter']`, `equip_armor` → `['heal']`, `place_torch` → `['build', 'shelter']`.

So in a creeper emergency the bot can flee, retreat home, or barricade a gap —
but never try to punch the creeper.

**Best real-world defence** (for future work): prevent spawns (`place_torch` +
`sleep`), keep a tamed **cat** (creepers flee from cats within ~8 blocks),
and wear armor. **No ranged option exists yet**: the bot has no bow/arrow
support (see [open-questions](open-questions.md)).

## Status

**977 unit tests green (2026-10-03)**; the curriculum chain is verified live
end-to-end (`CURRICULUM=first_night` reached and closed on the real BDS).

- **Fluids in the survival layer (M0, 2026-10-03)**: the governor vocabulary grew
five conditions (`inWater`, `headInWater`, `inLava`, `lavaWithin`, `airBelow`)
and three rules in `knowledge/survival-rules.json` — `lava_contact` (priority
100, `inLava`, intents `[escape, heal]`, skill `avoid_lava`), `drowning` (98,
`headInWater` + `airBelow 8`, intents `[surface]`) and `lava_near` (88,
`lavaWithin 4`, intents `[escape, travel]`). Lava therefore outranks every
hostile rule. `perceiveFluids()` keeps unknown fluids as `known: false` (no
invented alarm), `risk.mjs` scores `in_lava` +60 / `lava_adjacent` +45 /
`drowning` +45 / `lava_near` +22 / `lava_in_range` +8, the `surface` need fires
only with a known air budget, the intents `swim`/`surface`/`descend`/`ascend`/
`fluid` were added, and the verifier gained `inWater`/`notInLava`/`airAtLeast`
(the last two **fail loudly** when the state is unknown instead of passing).
Live 03/10: a dry bot produces no fluid need and no fluid risk reason
(`GET /survival` unchanged); the air budget is now **simulated**
(`bedrock-air.mjs`, see below), so `drowning`/`surface` have a source and stay
inert only while the bot is dry ([fluids](fluids.md), row 47 of
[verification](verification.md)).

- **Redstone in the survival layer (R2, 2026-10-03)**: the governor vocabulary
gained the intents `redstone`, `toggle` and `sense` — `use_redstone` and
`set_repeater_delay[_n]` map to `[toggle, redstone]`, `sense_redstone` to
`[sense, redstone]`, and a plain `place_*` keeps mapping to `build` — and the
verifier gained two criteria that **fail loudly instead of passing on a
missing datum**: `blockPoweredAt {x,y,z,atLeast}` (a cell that is absent or a
power that is unreadable is a failure) and `circuitActive` (`true`,
`{atLeast}` or `false`; with `false` it requires no active output *and* a
signal below the threshold). A missing `redstone` section in the observation
is `redstone state unknown`. The adapter side reads `inputOn` as `true`/
`false`/**`null`** (a lever of unknown state is never "off") and
`summarizeRedstone` reports `maxPower: null` — not `0` — when nothing is
readable; `use_redstone` restores the input after probing, so no clock is
left running ([redstone](redstone.md), row 47.4 of
[verification](verification.md)).

- **Circuit blueprints as data (R3, 2026-10-03)**: the same discipline reaches
building a circuit. A blueprint is a JSON document (`circuits/*.json`,
validated at load by `circuits.mjs`: support order, duplicate cells,
under-declared materials, traps like `tnt` are refused before the bot moves);
the planner and the success check are pure (`planCircuit`,
`circuitSiteBlocked`, `checkCircuitSuccess`), and `checkCircuitSuccess`
returns `empty: true` → `ok: false` when the blueprint declares no check, so
there is **no empty success**. `build_circuit_<id>` places in order, sets the
repeater delays, triggers the circuit, verifies **with the trigger still
active** and then restores it (no clock left running); a direction the server
did not honour is `orientation_not_confirmed` instead of a crooked circuit,
and every attempt is appended to `runs/<run>/circuits.jsonl`. Four blueprints
are buildable (`lamp_switch`, `delay_line`, `auto_lamp`, `auto_door`), four
are declared and refused with a reason ([redstone](redstone.md), row 47.5 of
[verification](verification.md)).

- **A verifier that measures instead of trusting (R4, 2026-10-03)**: the timing of
  a circuit is no longer a declaration. `measureCircuitDelay` reads the bot's own
  redstone trace (the last bounded block updates) and reports the first change at
  the blueprint's declared output **after** the trigger: `measuredMs`,
  `measuredTicks`, and `ok` — with three honest states, because no sample is
  `ok: null` (never a pass) and a sample outside the tolerance is
  `circuit_delay_mismatch`. A blueprint can make it mandatory (`measure:
  {expectedTicks, outputOffset, required, toleranceMs}` — `delay_line` asks for
  six ticks ± 60 ms), and **a wrong timing is an error even when every block sits
  exactly where it was asked to**. The same slice gives the bot a safe way back:
  `_placeAtCell` keeps a ledger of what it placed, `_buildCircuit` stamps it with
  the circuit id, and `teardown_circuit` removes **only** those cells — skipping
  any cell someone else changed and leaving the rest of the world untouched —
  while a failed step rolls the half-built site back. Error ladder:
  `circuit_verify_failed` → `circuit_delay_not_confirmed` →
  `circuit_delay_unmeasured` → `circuit_delay_mismatch` ([redstone](redstone.md),
  row 47.6 of [verification](verification.md)).

- **Circuits as a progression goal (R5, 2026-10-03)**: redstone is no longer a
  catalogue of actions next to the game — it is *inside* the game. Three chained
  milestones (`redstone_ore` → `redstone_basics` → `redstone_automation`) hang
  below `iron_age`, with the alias `goals.redstone`, and six declarative skills
  in `skills/gameplay/redstone/` describe them; the final one has **no**
  `satisfiedWhen`, so an inventory full of lamps and levers closes nothing — only
  a verified build does. That verification is the new criterion `circuitBuilt`,
  which reads the builder's own report and refuses a circuit that was already
  standing before the skill started. Between resources and blueprints sits a
  bridge: a blueprint with missing materials publishes `craft_<item>` for the
  first material that is craftable *now* (`_craftableNow`: recipe + ingredients,
  plus a crafting table within 32 blocks when the recipe is bigger than 2×2)
  instead of a dead end, and `build_circuit_<id>` appears when nothing is
  missing. Two of the six skills declare a blueprint that is still
  `buildable: false` on purpose: the gap is visible in the graph, not hidden in a
  document ([redstone](redstone.md), row 47.7 of [verification](verification.md)).

- **Wading and the simulated air budget (M1 partial, 2026-10-03)**: shallow water
is now traversable — `_standable` accepts a feet cell holding water **when the
cell above is free** (deep water still a wall, lava never) — and A* picks it up
for free because `_neighbors` is gated by `_standable`; `_physicsStep` walks at
`WALK_SPEED * WADE_SPEED_FACTOR` (default `0.5`) while `_wading()`, and
`observe().fluids.wading` exposes the state. The air budget is modelled in the
pure module `bedrock-air.mjs` (`MAX_AIR = 300` ticks, `AIR_RECOVER_PER_TICK = 4`,
`airStep`, `airSeconds`, `class AirMeter`): `_airTick()` advances it once per
simulated tick in `_physicsStep`, `observe().fluids` reports `air`,
`airSeconds` and **`airSource: 'simulated' | 'server'`** (a server attribute,
if it ever arrives, wins and re-aligns the meter), and **no damage is
simulated** — health stays the server's, the meter only drives the `drowning`
rule, the `surface` need and the hazard ladder. Live: `air: 300`,
`airSeconds: 15`, `airSource: 'simulated'`, no invented emergency on a dry bot;
the swimming motion (`surface`/`swim_to`) is blocked by the missing packet
capture of a real player swimming.

- **Breathing and the dive budget (M2, 2026-10-03)**: the second half of the fluid
work is a *decision*, not a movement. `bedrock-dive.mjs` costs a dive as
`descent (0.6 s/block) + work + ascent (0.7 s/block)` against `airSeconds − 3 s`,
and `underwaterWork()` is the one gate: head above water → allowed, otherwise
`budget_ok` or a typed refusal (`air_too_low`, `work_too_long`, `unknown_air`).
Water Breathing is detected from **real** sources only — a `turtle_helmet` on the
head or a `mob_effect` effect normalized to `water_breathing` (the packet carries
**ticks**, the meter converts, `-1` = infinite, `0` = already expired); a conduit
is reported (`conduitsNear`) but never trusted, because its effect depends on a
validated 3×3 water prism the bot cannot verify — inventing safety would be worse
than refusing. The governor follows: a new `waterBreathing` condition, `drowning`
now requires `waterBreathing: false`, and the `surface` need plus the `drowning`
risk stand down while breathing is held (unknown = `false` = prudent).
`_mineBlock` and `_collectDrop` ask `_underwaterWorkAllowed()` before sending
anything, so a dive that would not fit is refused in milliseconds instead of
burning a 20–30 s movement into a drowning. Live: `/observe.dive` reports
`depth: 0` and the gate transparent on a dry bot (`mine_cobblestone` still ok in
2.8 s, `last: null`); an `effect @a water_breathing 600 0` typed in the BDS
console was picked up as `{kind: 'effect', seconds: 600}` and counted down across
probes (493 → 481 → 469 → 461 s), proving the tick→second math against the real
server. The refusal path itself stays unit-tested: the bot cannot submerge from
the base room (M1's swimming blocker).

- **Waterfall and bubble-column tactics (M3, 2026-10-03)**: `bedrock-waterfall.mjs`
turns a drop into a *route with a verdict*. A waterfall is a vertical run of at
least three water cells whose **landing** is read under the bottom:
`landingVerdict` says safe for water and solid ground, hazard for
`lava`/`magma`/`fire`/`cactus`/..., `safe: null` (unknown) when the block cannot be
read, and `air` is a fall onto nothing — an unknown landing is **not** treated as
safe. `columnTactic()` is the one decision behind `descend_waterfall`,
`climb_waterfall`, `use_bubble_column` and the `dig_down` water preference, and
its order is deliberate: `no_column` → `already_inside` → `too_far` →
`sneak_not_supported` (a magma column would burn without a sneak flag) →
`unsafe_landing` → `unknown_landing` → **`swimming_unavailable`** → the M2 dive
budget (a column *up* refills the air instead of costing it). The governor gained
the `onWaterfall` condition and the contextual `ride_waterfall` rule (priority 54:
stay in the column until the landing pool), which by design never enters
`allowedIntents` in an emergency. Live the census found **no column at all** in 24
blocks (the only water is a two-block pool: below the threshold), so the round
documents the refusal — `no_column` in 3.7–10.6 ms for all three actions, none of
them offered by `/options`, `ride_waterfall` not firing on a dry bot — while the
ride itself waits on M1's swimming. The pathfinding column edges were left out on
purpose: a descent into water the bot cannot leave is a trap, not an
optimisation.

- **Buckets, boats and the lava bridge (M5, 2026-10-03)**: `bedrock-bucket.mjs`
keeps the three decisions apart — *is this a source* (`bucketSourceVerdict`: the
block name, not `liquid_depth`, says `water` vs `flowing_water`), *what happens
when it is poured* (`placeBucketVerdict`: obsidian on a lava source, cobblestone
on flowing lava, and the Nether refuses water outright), and *did it fill*
(`bucketDelta`: the product gained **and** the container spent). The boat gate
(`boatVerdict`) wants a boat in the inventory and three water cells within 16
blocks, and `brewPlan` names every missing item and the three brewing steps while
the stand interaction answers `brew_not_implemented`. The bridge
(`_bridgeLava`) is the executor of M4's gate: one cell at a time, water poured on
the lava when a bucket is in hand (obsidian) or the most abundant block placed,
and the next cell is only stepped on after the world confirms it — a stalled
bridge stops on a safe footing instead of pretending to have crossed.
- **Lava as an absolute obstacle (M4, 2026-10-03)**: `bedrock-lava.mjs` decides
three things the governor and the recovery path both need. **A lava death
destroys the loot**: `deathVerdict({position, lava})` marks the site
`recoverable: false` when the bot died inside the lava — or within
`LAVA_DEATH_RADIUS` 2, because a drop on the edge falls in — and `recover_loot`
then returns `drops_lost_in_lava` **without moving** (the option is not even
offered) and a tracked drop sitting in a lava cell is filtered out of
`_nearestDrop`. **The escape prefers water**: `safeShorePlan()` scores each
standable candidate `gain + (waterAdjacent ? 2 : 0)` and refuses anything closer
than `SAFE_SHORE_MIN_GAP` 2 to the lava, because a shore one block from the edge
is a bet and water puts the fire out. **Crossing is gated**: `lavaGap()` measures
the first stretch of lava along a direction in one-block steps and reports
`truncated` instead of guessing a far shore, and `lavaCrossingGate()` requires
fire resistance plus a bridge — or water → obsidian *where water can be placed*,
which is never the Nether or the End (`water_in_nether`). `move_to_safe` and
`cross_lava` expose those verdicts as actions, and the second stops at
`bridge_not_implemented` with the plan in hand: the bridge is M5/M6 and a nominal
success would be the most expensive lie of the milestone. Live the lava is 15.4
blocks below the base room, so the round shows the refusals (`not_in_danger`,
`no_lava_ahead`) and no action in `/options`.

- **Mature-crop detection (2026-10-03)**: `cropMaturity()`/`seedForCrop()` live in
`bedrock-survival.mjs` (`growth` 0..7 for wheat/carrots/potatoes/beetroots/melon
stem/pumpkin stem/sweet berry bush, `age` 0..3 for nether wart); the adapter
offers `harvest_<crop>` only for ripe plants and replants the seed it yields,
refuses `mine_<crop>` on an unripe plant (`crop_not_mature`, checked again inside
`_mineBlock`), and keeps **fail-open** semantics when the state cannot be read
(unknown maturity behaves as before). Finding that made it work live: `findBlocks()`
returned `{...block, distance}`, and spreading a prismarine Block loses
`getProperties()` → every growth read came back `null`, silently turning the gate
off. Live: `/observe.nearby` now reports `potatoes growth 7/7/6/6, mature true/false`,
`carrots growth 7`; `harvest_potatoes` fails in 0.01 s with `drop_unreachable`
(the only fields are outside the bot's walkable component), `harvest_wheat` with
`no_crop_found`.
- **Blaze hunt (N6, 2026-10-03)**: `hunt_blaze` carries `[fight, collect]`, and
  the interesting part is what it *refuses*: the tactic ladder puts survival
  before damage (`low_health`, then any fire on the bot, only then cover and
  approach), and `_coverFrom` treats an **unknown** cell as no cover at all —
  an unloaded chunk does not stop a fireball, and a bot that believes it is
  hidden walks into the open. Same honesty in the detector: `nether_fortress`
  is scoped to `dimension: nether`, so the Overworld survey never invents one.
- **Ender gaze (N5, 2026-10-03)**: the survival layer reads `nether.enderman.gazed`, and that flag is now disciplined twice over: the aim of a fight is the torso (`endermanAimPoint`, 1.45 vs eyes at 2.55) and `avoid_enderman_gaze` (`escape`/`shelter`) turns the head off the eye axis, verified from perception; `equip_pumpkin` (`heal`/`shelter`) is the passive answer — with a mask the bot may look at the eyes and `gazed` stays false, so the risk rule does not fire for a danger that no longer exists.
- **Boss verdict (N7, 2026-10-03)**: the endgame added the first verifier criterion
  that reads a **server event** instead of the world: `bossDefeated` accepts only
  `true` and only from a `show_bar` → `hide_bar` cycle in `observation.boss`
  (the adapter fills it from the Bedrock `boss_event` packet, never from an
  entity that disappeared — leaving the End does that too). Every other outcome
  fails loudly with the reason (`no_boss_bar`, `boss_bar_visible`,
  `hidden_before_shown`), so a dragon cannot be declared dead by a bot that
  simply walked away. The same honesty drives the frames: `frameStatus` refuses
  `complete` if even one `end_portal_frame` has an unreadable eye bit.
- **Bartering (N4, 2026-10-03)**: a new `barter` intent in the vocabulary and
  `barter_piglin → ['barter', 'collect']`. No rule was needed: the value here is
  the *removal* of a temptation — `piglin` and `piglin_brute` are in
  `HOSTILE_TYPES`, so the adapter used to offer `attack_piglin`; hitting one
  closes the barter forever, and the option list no longer contains it.
- **Projectile dodge (N3, 2026-10-03)**: the `projectile_incoming` rule already
  asked for `escape`/`shelter` and the only action carrying `escape` was `flee`
  (run away from the nearest *entity*), which is the wrong answer to something
  faster than the bot. `dodge_projectile` carries `['escape', 'travel']` and moves
  *sideways* out of the line of fire; the governor therefore prefers it when a
  projectile is inbound without any new rule being needed — the gap was an action,
  not a verdict.
- **Nether survival (N2, 2026-10-03)**: the survival layer does not need new
  rules for this — N2 changes what the *pathfinder* is willing to do. In the
  Nether/End the fall cap drops from four blocks to two (`maxFallDepth`, no
  water to break a fall) and a cell whose support is magma, fire or cactus is no
  longer standable **in any dimension** (`landingHazard`); the shelter is built
  with a non-flammable block (`isFlammableBlock`/`pickHubBlock`) and remembered
  as `kind: home` only when it is sealed.
- **Portal actions (N1, 2026-10-03)**: the four actions
  (`goto_portal`/`build_portal`/`light_portal`/`enter_portal`) are mapped to the
  `travel`/`build` intents in `survival/intents.mjs`, so a curriculum step that
  asks for `enter_nether` has something to execute. The frame geometry is pure
  (`planPortalFrame`/`checkPortalFrame`/`portalSiteBlocked`/
  `portalFrameCandidates`) and `enter_portal` confirms itself from the server's
  dimension packet, not from the bot's own opinion.
- **Nether hazards in the survival layer (N0, 2026-10-03)**: `perceiveNether()`
normalises a new `observation.nether` block (portal/fire/magma/spawner
distances, the most urgent incoming projectile, the enderman being stared at,
`waterEvaporates`/`bedsExplode`) and stays `known: false` when the field is
missing, so an old observation never raises a false alarm. Risk weights:
`on_fire` +50, `magma_contact` +35, `projectile_incoming` +45 (or +30 when it is
still seconds away), `gazed_at_enderman` +12 **only in the Nether/End**,
`spawner_nearby` +6. Eight conditions (`inFire`, `fireWithin`, `magmaWithin`,
`projectileIncoming`, `gazedAtEnderman`, `inNether`, `inEnd`, `spawnerWithin`)
and seven rules: `on_fire` (98), `projectile_incoming` (96), `magma_contact`
(95), `fire_adjacent` (92), `fire_near` (72), `gazed_at_enderman` (62),
`spawner_nearby` (58). A quiet Overworld produces nothing, and the bot refuses
to sleep in a dimension where beds explode (`beds_explode_here`). What is
*missing* is the acting half: no dodge, no portal action, no barter.

- **Offline (deterministic, no model)**: `tests/controller-curriculum.test.mjs`
drives `CURRICULUM=first_night` against a staged fake harness (one valid action
per stage) plus a stub `hermes` binary, and asserts the whole chain
`wood → crafting_table → food_and_safety → first_night`,
the `plan.notes = curriculum:<milestone>` provenance, the `skills.jsonl`
milestones, the absence of `curriculum_fallback` (the planner is not needed)
and `GOAL MET after 4 actions (curriculum first_night)`. A second test starts
with the prerequisites already satisfied and asserts that the engine resolves
straight to `first_night` (no hardcoded sequence).
- **Two controller bugs fixed by that test** (2026-10-03): `goalMet()` closed the
goal after the *first* prerequisite (in curriculum mode it must only close on the
final milestone), and `planFromMilestone()` inherited the ambient `WAYPOINT`
knob, so every milestone was anchored to the demo waypoint (`goto_waypoint →
target_not_found` at step 1).
- **Live (BDS 1.26.52, container `hermes-jev-bedrock`)**: `CURRICULUM=first_night`
reached the milestone and closed it (`runs/p3-first-night-3`, 2026-10-03):
`SKILL obtain_food SUCCESS {"inventory.food":3}` after 6 actions (41.7 s),
`SKILL first_night SUCCESS {"sawNight":true,"phase":"day","health":20}` after 19
more (152.7 s), then `GOAL MET after 25 actions (curriculum first_night)` with the
mission closed `found/success` and exit 0. The chain before that is also live: a
previous run reached `SKILL acquire_wood SUCCESS {"inventory.logs":8}` (5 actions,
39.9 s) and the engine replanned to `acquire_crafting_table` on its own,
surviving an unrelated zombie_villager_v2 emergency (`flee`) across the periodic
replan. The final night was survived by **sleeping in the bed**
(`#25 sleep → {"slept":"night_skipped","bed":{"x":113,"y":73,"z":156}}`), so
`nightSurvived` came from the `night → day` phase transition rather than from
staying awake. Residue seen live but non-blocking: two `item_not_collected` on
mined dirt drops and one `go_home_failed: movement timeout`. The `attack_chicken →
combat_timeout` residue was diagnosed (the combat loop re-resolved its target
before every swing, smearing 102 hits over ≥15 chickens with 0 deaths) and fixed
by locking a single target by `runtimeId` (see
[open questions](open-questions.md)).
- **Harness lock handling**: a `busy` answer is a lock, not a verdict. After a run
was killed mid-action the harness stayed busy and the next run burned its whole
step budget on instant `busy` replies; `controller.mjs` now retries with
`HARNESS_BUSY_MAX_WAIT_MS` / `HARNESS_BUSY_POLL_MS` and logs `harness_busy`
(`tests/controller-busy.test.mjs`: three `busy` replies then the action runs, two
real steps, `GOAL MET after 2 actions`).

See [open-questions](open-questions.md) and [verification](verification.md).
