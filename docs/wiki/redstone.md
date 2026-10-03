# Redstone and primitive automation

Roadmap for letting the bot **use redstone and build primitive redstone
circuits**: switches, delay lines, automatic lamps, observer/piston harvesters,
hopper item transport, dispensers and (stretch) crafters. It builds on the
verified primitives (placement, `click_block` interaction, containers, crafting,
digging) while never breaking the base's own circuits.

Status: **R0, R1, R2, R3, R4 and R5 implemented and unit-tested (R0 also
collaudato live); the live component round is blocked by the standing "no base
edits" rule (03/10/2026); R6 spec only** (tracked in [roadmap](roadmap.md) and
[open-questions](open-questions.md)). Full raw source:
[`docs/raw/REDSTONE_ROADMAP.md`](../raw/REDSTONE_ROADMAP.md).

Sources: `bedrock-adapter.mjs` (placement, interaction, digging, `DIG_PROTECTED`),
`bedrock-redstone.mjs` (R0: component vocabulary, `powerOf`, `redstoneView`),
`circuits.mjs` + `circuits/*.json` (R3: declarative blueprints and their builder),
`skills/gameplay/redstone/*.json` + `knowledge/progression.json` (R5: the
milestones and the declarative skills),
`bedrock-world.mjs` (block-state decoding, `findBlocksByState`), `BEDROCK.md`
(action status), [survival-intelligence](survival-intelligence.md)
(skills/verifier/progression), [fishing](fishing.md), [fluids](fluids.md) (water
streams for harvesters).

## Current state (from the code and registry)

> Baseline **before R0** (kept for reference; the bullets marked below are the
gaps R0 closed).

- **No redstone support at all** — no block, action or rule mentions redstone.
- **The world model already exposes component state.** `bedrock-world.mjs`
  decodes runtime ids and `blockAt()` returns a Prismarine block with
  `getProperties()`. Confirmed against the `bedrock_1.26.51` registry:

  | Block | State properties |
  |---|---|
  | `redstone_wire` | `redstone_signal` 0..15 |
  | `lever` | `lever_direction`, `open_bit` |
  | `stone_button` / `<wood>_button` | `facing_direction`, `button_pressed_bit` |
  | `repeater`/`unpowered_repeater`/`powered_repeater` | `minecraft:cardinal_direction`, `repeater_delay` 0..3 |
  | `comparator`/`powered_comparator` | `cardinal_direction`, `output_lit_bit`, `output_subtract_bit` |
  | `observer` | `minecraft:facing_direction`, `powered_bit` |
  | `dispenser`/`dropper` | `facing_direction`, `triggered_bit` |
  | `hopper` | `facing_direction`, `toggle_bit` |
  | `piston`/`sticky_piston` | `facing_direction` |
  | `daylight_detector` | `redstone_signal` 0..15 (`_inverted` for night) |
  | `sculk_sensor` | `sculk_sensor_phase` |
  | `tripwire_hook` | `attached_bit`, `direction`, `powered_bit` |
  | `crafter` | `crafting`, `orientation`, `triggered_bit` |
  | `redstone_lamp` / `lit_redstone_lamp` | two **distinct blocks** (lit = name change) |
  | `redstone_ore` / `lit_redstone_ore` (+deepslate) | two distinct blocks |
  | `stone_pressure_plate`, `heavy_weighted_pressure_plate`, ... | `redstone_signal` |
  | `tnt` | `explode_bit` (**hazard**) |

  So **sensing is already possible at the data layer**; only exposure is missing.
- **`DIG_PROTECTED` does not cover redstone** — `dig_up`/`dig_down` can destroy
  pistons, wire, repeaters, observers, exactly the class of bug that once broke a
  base chest.
- **Placement does not control orientation.** `_placeAtCell` always clicks the
  top face (`face: 1`, `clickPos {0.5,1,0.5}`) and confirms only the **name**, not
  the state. Pistons/observers/repeaters/levers/torches need a specific
  `facing_direction`/`cardinal_direction`; wall-mounted components need a side
  face.
- **`click_block` interaction already exists** (`_blockUseTransaction`, used for
  doors/beds/tables): it can activate levers/buttons/pressure plates and cycle
  repeater delay / comparator mode.
- **Mining options come from `_refreshNearby`'s fixed list**, which excludes
  redstone ore and components — so the bot is blind to them.
- **`findBlocks` matches by name, not by state** — it cannot find "a powered
  repeater" or "an open lever".
- **Crafting is generic** (`craft_<item>` reads `crafting_data`); components
  craft if the recipe and materials exist.

## R0 — Awareness and protection (implemented, live 03/10/2026)

The bot now *sees* redstone and refuses to dig through it; it still does not build
circuits (that is R1+).

- **Pure vocabulary** — `bedrock-redstone.mjs` (no I/O): `REDSTONE_ORES`,
  `REDSTONE_COMPONENTS`, `REDSTONE_SOURCES` / `REDSTONE_OUTPUTS`,
  `REDSTONE_HAZARDS` (`tnt`), `isRedstoneOre`, `isRedstoneComponent`, `isHazard`,
  `blockProperties` (tolerant: `getProperties()` / `properties` / `_properties` /
  `states` + `computedStates`), `powerOf` → 0..15 **or `null` when the state is
  unreadable** (a component we cannot read must never look switched off),
  `isPowered`, `facingOf`, `isSource`, `isOutput`, `componentState` and
  `redstoneView` (`components` / `ore` / `power` / `hazards` / `counts`).
  `lit_*`/`powered_*` are **distinct blocks** in Bedrock, so the name already
  carries the signal (= 15); a repeater with no readable properties stays `null`.
- **`DIG_PROTECTED` covers the components** (wire, block, lever, buttons, plates,
  repeaters, comparators, observer, pistons, dispenser, dropper, lamps, daylight
  detector, tripwire hook, target, crafter, sculk sensor). The **ore stays
  mineable**: it is a resource, not a circuit — and it was already covered by
  `_scanValuableOres` / `VALUABLE_ORE_NAMES` (`ore-value.mjs`), so R0 does not
  duplicate that scan.
- **Perception** — `_redstoneCensus()` runs **one** `world.findBlocks(...)` for
  the whole vocabulary (`REDSTONE_NEARBY_NAMES`, radius `REDSTONE_SCAN_RADIUS` =
  16, limit `REDSTONE_SCAN_LIMIT` = 24) with a `REDSTONE_RESCAN_MS` (5 s) TTL,
  called from `_refreshNearby()`; a world with no loaded column is *not* cached
  and reports `ready: false`. `GET /observe.redstone` (and `observe().redstone`)
  exposes `{components, ore, power, hazards, tntNearby, counts, found, loaded,
  ready, at}`; `?force=1` refetches.
- **State-aware search** — `bedrock-world.mjs` now shares one scan engine
  (`_scanBlocks`, whose `accept` predicate runs *before* the `count` budget is
  spent) between `findBlocks` (by name) and the new
  `findBlocksByState(names, predicate, point, radius, count)` ("a powered
  repeater", "an open lever"); `_blockProps(position)` reads a single cell.
- **Tests**: `tests/bedrock-redstone.test.mjs` (pure),
  `tests/bedrock-redstone-adapter.test.mjs` (census, TTL, no-columns guard,
  `_blockProps`), plus a redstone refusal case in `tests/bedrock-dig.test.mjs`
  (`protected_step` / `protected_front` / `protected_head`, and the ore still
  minable).
- **Live round (03/10/2026)**: `GET /observe.redstone` → `components: []`,
  `ore: []`, `tntNearby: false`, `found: 0`, `loaded: 125`, `ready: true`; the
  same object is inside `GET /observe`; `dig_down` → `protected_front` and
  `dig_up` → `protected_head` (the protection path is live-active — the bot's
  room is planks, so the refusal fires before any redstone). The census is bounded
  and never fabricates a pericolo on a clean world.
- **Known limits (R0)**: the bot's room has no redstone component, so a live
  read of `powerOf` on a real circuit was impossible; the ore mining round was not
  exercised (no iron pickaxe, so the option correctly stays absent); the census
  radius is 16 blocks — a circuit further out is invisible until the bot walks
  closer.

## R1 — Oriented placement and repeater delay (implemented, unit-tested 03/10/2026)

The bot can now place a redstone component *with a wanted direction* and change a
repeater's delay, verifying the result on the world state instead of trusting the
packet shape.

- **Pure helpers** (`bedrock-redstone.mjs`): `normalizeFacing` (numbers 0..5 →
  `down`/`up`/`north`/`south`/`west`/`east`, `minecraft:` prefix stripped,
  spaces/dashes folded), `facingMatches(actual, wanted)` — **tolerant by design**:
  equality after normalisation, or one value being a token of a compound one (a
  floor lever is `lever_direction = down_east_west`, which counts as `east`/`west`),
  `isRepeater`, `repeaterDelay` (0..3, clamped, `null` when unreadable) and
  `PLACEMENT_YAW_STEPS = [0, 90, 180, 270]`.
- **The BDS derives, we observe.** How the server turns player yaw + clicked face
  + `click_pos` into `facing_direction`/`cardinal_direction`/`lever_direction` is
  still undocumented per family, so R1 does not guess it: it **places, reads the
  state back from the world and corrects on the next candidate yaw** (the
  packet-capture idea of the roadmap turned out to be unnecessary). A wrong
  attempt is *removed* (`_mineBlock`, 8 s budget) before the next one, so no
  orphan block is left behind on the correction path. `tries` is bounded (4
  cardinal yaws by default).
- **`_placeAtCell(itemName, blockName, target, support, face, clickPos, { yaw, pitch })`**
  gained an explicit orientation override; every existing call site keeps the
  previous behaviour (the yaw is still aimed at the target cell when no override
  is given).
- **`_placeOriented(itemName, blockName, { facing, face, tries })`** returns
  `{ok, block, position, face, facing, wanted, attempts, corrected, tried}` —
  `facing`/`tried` are the **normalised** values actually read back. Failures are
  typed: `no_place_spot`, the propagated `_placeAtCell` error (`missing_item`,
  `place_not_confirmed`, …), `orientation_not_confirmed` (bounded tries) and the
  `oriented_place_stuck` log when the block just placed could not be removed (the
  last placement stays in the world and the caller is told the real facing).
- **Repeater delay via interaction** (`_cycleRepeater` / `_setRepeaterDelay`): the
  delay cycles 0→1→2→3→0 on `click_block`, so the adapter clicks
  `(target − current + 4) % 4` times and **re-reads the state after every click**;
  a click that changes nothing is an error, not a success. Returns
  `{ok, position, before, delay, clicks, wanted}` (or `{already: true}` when the
  delay is the one wanted) and `no_repeater_nearby`, `not_a_repeater`,
  `repeater_unreachable` (reachability gate), `repeater_state_unreadable`,
  `repeater_delay_not_confirmed`.
- **Options / actions**: `place_<component>` is offered for every redstone
  component in the inventory (the **ore** is excluded — it is a resource, not a
  component; dust maps to its block through `REDSTONE_ITEM_BLOCKS`, so
  `place_redstone` places `redstone_wire`), and `set_repeater_delay` appears when
  a repeater is in the R0 census. `executeAction` routes a component through
  `_placeOriented` (a non-component keeps the plain `_placeBlock` path) and
  accepts `set_repeater_delay` (next value) and `set_repeater_delay_<0..3>`
  (anything else → `bad_delay`).
- **Tests**: 4 new pure cases in `tests/bedrock-redstone.test.mjs`
  (`normalizeFacing`, `facingMatches`, `isRepeater`/`repeaterDelay`,
  `PLACEMENT_YAW_STEPS`) and `tests/bedrock-redstone-place.test.mjs` (12 cases)
  with a fake world that **models the server**: the facing of the placed block is
  derived from the yaw (so the correction path is real: 1 removal + 2 attempts),
  an impossible facing ends `orientation_not_confirmed` after 4 attempts, a failed
  removal stops the loop, the placement error propagates, `executeAction`
  routes/does not route, and the repeater delay advances/wraps/refuses.
- **Live round (03/10/2026, VM 100, BDS 1.26.52, bot in its room)**:
  `GET /observe.redstone` → `counts {components: 0, ore: 0, hazards: 0}`,
  `ready: true`, `loaded: 125` (the room has no component); the R1 route is live
  and typed — `place_lever` → `{ok: false, error: 'missing_item', attempts: 1,
  tried: []}`, `place_redstone` → **`no_place_spot`** (once, during a transient
  world-view hiccup, see limits), `set_repeater_delay` → `no_repeater_nearby`,
  `set_repeater_delay_9` → `bad_delay`; the non-component path is untouched —
  `place_torch` → `{ok: true, block: 'torch', position: {x: 116, y: 73, z: 158}}`
  (a real server-side placement, inventory torch 2→1). The chain towards a real
  component was walked as far as the standing constraint allows: `craft_lever` →
  `missing_ingredients` (the generic craft branch exists; the missing ingredient
  is cobblestone), `craft_wooden_pickaxe` → `{ok: true, crafted: 'wooden_pickaxe'}`
  (consumes 3 planks + 2 sticks) and **with the pickaxe `mine_cobblestone` appears
  in `/options`** — the only cobblestone within reach is the base's own wall
  ((114–116, 73–74, 161), 1.7–2.3 blocks).
- **Blocked live round (environmental, not a code gap)**: the remaining steps are
  `mine_cobblestone` → `craft_lever` → `place_lever` → read the state back, i.e. a
  full live R1 verification. Mining those blocks edits the base, which the
  standing **plan C** (no base edits, after the unanswered A/B/C question
  m01403) forbids; the drop is recoverable and the block re-placeable, so the
  round is *one permission away*.
- **Known limits (R1)**: the per-family rule is still discovered, not documented
  (by design), and only the 90° yaw dimension is explored — a family that reacts
  to the *clicked face* (wall-mounted levers, torches) has `face` as a parameter
  but no candidate sequence over faces yet; a correction costs one extra placement
  plus one mining per wrong candidate (the block is recovered, never dropped); on
  a total failure the last placement stays in the world and the caller gets the
  actual facing; the delay change assumes clicks are delivered in order (no
  batching).
- **Bug found by the tests**: in `_cycleRepeater` the local `let delay` **shadowed
  the imported `delay` from `node:timers/promises`**, so the first click that did
  not change the state threw `TypeError: delay is not a function` instead of
  reporting `repeater_delay_not_confirmed`; the local is now named `current`.

## R2 — Interaction and sensing (implemented, unit-tested 03/10/2026)

The bot can now **command** redstone and **sense** it continuously.

- **Only the inputs are commanded** (`bedrock-redstone.mjs`): `REDSTONE_INPUTS` is
  the closed set a click can act on — `lever`, `stone_button`, `wooden_button`,
  `polished_blackstone_button`. Torches, blocks of redstone, pressure plates and
  observers are *sources*, not switches: clicking them is not a way to change a
  circuit, so `isRedstoneInput` keeps them out.
- **State reading never guesses**: `inputOn(block)` returns `true`/`false` from
  `open_bit`/`button_pressed_bit` (falling back to the readable signal), and
  **`null` when the state cannot be read**. A component whose state is unknown is
  never treated as "off". Same rule for `summarizeRedstone`, where `maxPower` is
  `null` — not `0` — when no signal is readable.
- **`use_redstone`** (`_useRedstone({position, restore, timeoutMs})`) toggles the
  nearest reachable input, verifies **its own state change** *and* the downstream
  effect (the census is re-read so `effects` lists the outputs that moved to
  `lit_*`/`powered_*`/`extended_*`), then — `restore: true` by default —
  **puts the input back at rest**, so a probe never leaves a clock running.
  Returns `{ok, name, position, before, after, effects, active, restored}` and
  logs `use_redstone`. Typed failures: `redstone_unknown` (census not ready),
  `no_redstone_input`, `not_an_input` (an output was asked for),
  `input_unreachable` (only reachable via an explicit position: `_pickRedstoneInput`
  already drops the unreachable ones), `redstone_state_unreadable` (nothing to
  verify against), `redstone_not_toggled` (the click changed nothing).
- **`use_redstone` is a click, not a packet shape**: `_clickRedstoneInput(cell,
  wanted, {timeoutMs})` sends one `click_block` with yaw/pitch aimed at the cell
  and waits for the world to report the wanted state — so a wrong click is an
  error, never a success.
- **Continuous sensing** (`_noteRedstoneUpdate`, called from `_onBlockUpdate`): a
  server block update patches the cached census **in place** — no new
  `findBlocks` — and records `_redstoneChange = {position, name, previous,
  power, powerKnown, at}`. A non-redstone update leaves the cache alone. The
  view (`_redstoneView`, exposed as `GET /observe.redstone` and as the `redstone`
  key of `GET /observe`) merges the census with `summarizeRedstone` and
  `lastChange`.
- **`sense_redstone`** is the diagnostic action (`{ok, power, maxPower, active,
  activeOutputs, counts, found, lastChange}`, `{ok: false, error:
  'redstone_unknown'}` on a cold world) and it is offered **only when the census
  is ready and has found something** — a diagnostic on an empty census is not
  worth a turn. `use_redstone` is offered only when an input is actually at
  reach. `GET /survival` gained a `redstone: {maxPower, active, activeOutputs,
  counts, lastChange}` section (`null` while the census is not ready).
- **Intents** (`survival/intents.mjs`): `redstone`, `toggle`, `sense` are new;
  `use_redstone`/`set_repeater_delay` → `['toggle','redstone']`, `sense_redstone`
  → `['sense','redstone']`, `set_repeater_delay_<n>` via a prefix rule (a plain
  `place_*` keeps mapping to `build`).
- **Verifier criteria** (`survival/verify.mjs`, both in `CRITERIA_KEYS`):
  **`blockPoweredAt`** `{x,y,z,atLeast=1}` fails on a missing cell and on an
  unreadable power — evidence `redstoneAt = {name, power}`; **`circuitActive`**
  accepts `true`, `{atLeast}` or `false` and passes on an active output or on a
  sufficient `maxPower` (with `false` it requires no active output *and* a
  signal below the threshold); a missing `redstone` section is `redstone state
  unknown`, never a pass.
- **Tests**: `tests/bedrock-redstone.test.mjs` (18 cases now) covers the pure
  layer — the input set, `inputOn` in all four shapes, `isActiveOutput` (TNT is a
  hazard, not an output; an unreadable power is not "off"), `activeOutputs`,
  `componentAt` and `summarizeRedstone`. `tests/bedrock-redstone-use.test.mjs`
  (10 cases) drives the **real census** over a fake world that models the server
  (a click flips `open_bit`/`button_pressed_bit` and lights the linked lamp), so
  the toggle/effect/restore path, the four typed failures, the in-place cache
  update (one `findBlocks` before *and* after an `update_block`), the option
  gating and `executeAction` are all exercised. `tests/bedrock-redstone-criteria.test.mjs`
  (4 cases) pins `blockPoweredAt`/`circuitActive` and their place in the criteria
  vocabulary.
- **Live round (03/10/2026, VM 100, BDS 1.26.52, bot in its room — no component
  in reach)**: `GET /observe.redstone` returns the R2 keys with honest values
  (`maxPower: null`, `active: false`, `activeOutputs: []`, `sourceCount: 0`,
  `outputCount: 0`, `componentCount: 0`, `lastChange: null`, `ready: true`,
  `loaded: 125`); `GET /survival` carries `redstone: {maxPower: null, active:
  false, activeOutputs: [], counts: {components: 0, ore: 0, hazards: 0},
  lastChange: null}`; `POST /act {"key":"use_redstone"}` →
  `{ok: false, error: 'no_redstone_input', position: null}` (typed, no burn) and
  `POST /act {"key":"sense_redstone"}` → `{ok: true, power: [], maxPower: null,
  active: false, activeOutputs: [], counts: {…0…}, found: 0, lastChange: null}`;
  `/options` offers no redstone key while the census is empty (the gating works
  live). The toggle/effect path cannot be exercised live for the same reason as
  R1 — the only redstone input reachable would have to be crafted from the
  base's own cobblestone (plan C, no base edits) — so it stays covered by the
  unit tests with the modelled server.
- **Bugs found by the tests**: `_noteRedstoneUpdate` used `REDSTONE_ORES.has(...)`
  but `REDSTONE_ORES` is an **array** (→ `TypeError: REDSTONE_ORES.has is not a
  function`); it now goes through `isRedstoneOre(name)`. And `_pickRedstoneInput`
  already filters by reachability, so `input_unreachable` is only reachable with
  an explicit position (the test was wrong, not the code).
- **Known limits (R2)**: `effects` are read from the census right after the click
  (a delay line or a long piston animation is not waited for — a `delay_line`
  circuit needs R4's verifier); a `sense_redstone` snapshot is only as fresh as
  the cache TTL unless an `update_block` arrived; buttons have no "press" timing
  (a click is instantaneous, so a wooden button's pulse is observed, not held);
  the `circuitActive` criterion is a summary, not a topology check.

## R3 — Primitive circuits (implemented, unit-tested and live-refused 03/10/2026)

A circuit is now **data, not code**: `circuits/*.json` declares what to build and
`build_circuit_<id>` builds, triggers and verifies it.

- **The blueprint is a document** (`circuits.mjs`, `CIRCUIT_SCHEMA_VERSION = 1`):
  `id`, `description`, `requires`, `anchor {offset, minClear}`, `steps
  [{item, block, offset, supportOffset, face, facing, delay, label}]`, `trigger`,
  `success [{offset, property, expected}]`, `post [{action, offset, delay}]`,
  optional `buildable: false` + `blocked` + `dependsOn`. `validateCircuit`
  rejects the impossible *before* the bot moves: a step whose support is placed
  later (`order N`), a duplicate cell, an undeclared or under-declared material
  (`requires.repeater: 2 < 3 steps need it`), a trigger or a success check on a
  cell no step places, a `post` on something that is not a repeater, a delay
  outside 0..3, too many steps (`MAX_CIRCUIT_STEPS = 48`) — and any **dangerous
  item** (`DANGEROUS_ITEMS`: `tnt`, `trapped_chest`, `tripwire_hook`,
  `sculk_shrieker`, `respawn_anchor`): a circuit with traps is never built.
  `loadCircuits()` fails at start-up on a broken file (the gameplay-skill
  discipline) and rejects duplicate ids.
- **Rotation is rigid and derived from the bot's own gaze**: `FORWARD`/`ROTATIONS`
  map south=identity, north=`[-x,y,-z]`, east=`[z,y,x]`, west=`[-z,y,-x]` — the
  blueprint's "forward" is the direction the bot faces, its "right" follows
  (`south → east`), and the Y is never rotated. `circuitAnchor(feet, facing)` puts
  the work site **one step in front of the bot** (never inside it), so the same
  blueprint is buildable facing any of the four cardinal directions.
- **`planCircuit(def, {origin, facing, available})`** is pure: it returns the
  absolute cells with their supports, the trigger, the success checks, the `post`
  rows, the missing materials (`{item, need, have}`) and `ok`. Two more pure
  helpers keep the adapter honest: **`circuitSiteBlocked(plan, world)`** reports
  `occupied` / `no_support` / `usable_block` (a chest is not a support: clicking
  it opens the container) and treats the plan's own cells as valid supports;
  **`checkCircuitSuccess(def, {origin, facing, read})`** pins `no_block` /
  `property_unreadable` / `value_mismatch` and **refuses to report success when
  the blueprint declares no check** (`empty: true` ⇒ `ok: false` — no empty
  success). `expectedDelayTicks(def)` sums `delay + 1` per repeater row.
- **Eight blueprints, four of them buildable**: `lamp_switch` (lever + lamp),
  `delay_line` (lever + 3 repeaters whose delays are *set* after placement +
  lamp, `expectedDelayTicks: 6`), `auto_lamp` (daylight detector + lamp — it has
  no trigger and no state check, `verifyNote` says why: the output follows the
  time of day, so the live round reads `/observe.time` with the lamp) and
  `auto_door` (lever + fence gate, success on the gate's `open_bit`). The other
  four are declared and **refused with a reason**: `auto_harvest` (needs the M1
  fluid milestone and a hopper output strategy), `auto_dispense` (a repeater
  clock keeps running while the lever is held, and a dispenser state needs a
  verifier the blueprint cannot express), `hopper_chain`
  (the hopper sits *on* the chest, a usable block for the placement primitive),
  `crafter_pulse` (needs a pulse, not a held lever, and R5's verifier).
- **`build_circuit_<id>`** (`_buildCircuit`): resolve the blueprint → refuse if
  declared → refuse the missing materials → refuse a blocked site → move to the
  anchor only when the cell is not already at reach (`_approachFor`) → place the
  steps **in order**, each one with yaw/pitch aimed at the cell → set the repeater
  delays → **force a redstone census** (the components just placed must be in it)
  → trigger and verify **while the trigger is still active** → trigger again to
  put it back at rest. Typed outcomes: `unknown_circuit` (+`known`),
  `circuit_not_buildable` (+`reason`), `missing_materials` (+`missing`),
  `circuit_site_blocked` (+`blocked`), `circuit_incomplete` (+`placed`/`failed`),
  `circuit_delay_not_confirmed`, `<trigger error>`, `circuit_verify_failed`.
  **A direction the server did not honour is an error, not a crooked circuit**:
  when a step declares `facing`, `_placeCircuitStep` compares what the world
  reports (`normalizeFacing(facingOf(...))`) and fails with
  `orientation_not_confirmed` **without** retrying — the R1 retry mines and
  replaces, which `DIG_PROTECTED` forbids for components.
- **Nothing is left running**: the trigger is restored (the second toggle's
  result is `trigger.restored`), and a trigger that is only *held* (a clock) is
  not offered at all.
- **Observability**: `GET /observe.circuits` returns `{count, buildable,
  declared: [{id, blocked}], invalid, last}` — `last` is the full report of the
  previous build — and the harness appends **one record per attempt** to
  `runs/<run>/circuits.jsonl` (like `skills.jsonl`), including the refusals that
  never reach the site, so a run can be read back afterwards.
- **Tests**: `tests/circuits.test.mjs` (10 cases) covers the catalogue, every
  validation message, the rotation rigidity, `circuitAnchor` in all four
  directions, `planCircuit`, `circuitSiteBlocked` (including the support false
  positive it originally had), `checkCircuitSuccess` and `loadCircuits` on
  temporary directories. `tests/bedrock-circuits.test.mjs` (9 cases) drives the
  real catalog through the adapter on a fake world where the server consumes the
  inventory, writes the block with a facing of its choosing and flips the linked
  lamp: the two full builds (`lamp_switch`, `delay_line` with delays `[0,1,2]`),
  the trigger restore, the intermediate failures (`missing_materials`,
  `circuit_site_blocked` with `occupied` and `usable_block`, `circuit_incomplete`
  on `place_not_confirmed`), the wrong-orientation refusal, `auto_lamp`'s
  deliberate non-verification, the option gating and `_facingFromYaw`. Suite:
  **767 tests green**.
- **Live round (03/10/2026, VM 100, container `hermes-jev-bedrock`, BDS 1.26.52,
  bot at (115.5, 74.62, 159.47))** — the catalogue and every refusal were
  exercised for real: `GET /observe.circuits` → `count: 8`, `buildable:
  [auto_door, auto_lamp, delay_line, lamp_switch]`, the four declared circuits
  with their reasons, `invalid: null`; `/options` offers **no** `build_circuit_*`
  (no materials in the room — the gating is live); `POST /act
  {"key":"build_circuit_lamp_switch"}` → `{ok: false, error:
  'missing_materials', missing: [{redstone_lamp, 1, 0}, {lever, 1, 0}]}`;
  `build_circuit_auto_harvest` → `{ok: false, error: 'circuit_not_buildable',
  reason: 'the water channel needs the M1 fluid milestone …'}`;
  `build_circuit_nope` → `{ok: false, error: 'unknown_circuit', known: […8 ids…]}`.
  All three answered in milliseconds and **all three landed in
  `runs/demo/circuits.jsonl`** (`{action, id, ok, error}` per line), which is the
  file the next run reads.
- **Known limits (R3)**: the **acceptance build** from the raw roadmap
  (`build_circuit_lamp_switch`, `build_circuit_delay_line`) cannot be exercised
  live in the standing room — a `redstone_lamp` needs glowstone and four
  redstone dust, i.e. a trip to the Nether, and plan C forbids touching the
  base's own cobblestone — so the built-and-verified path is covered by the
  adapter tests with a modelled server, exactly like R1/R2. `checkCircuitSuccess`
  compares block **properties**, not behaviour: a lamp that stays lit for another
  reason still passes, and **timing** is only declared (`expectedDelayTicks`) in
  this slice — R4 measures it. Only one work site at a time, and `auto_door`
  builds the fence-gate variant: the piston variant needs the live block name of
  `sticky_piston`'s arm.


## R4 — The verifier measures, the teardown stays inside what the bot built (implemented, unit-tested 03/10/2026)

R3 declared a delay and trusted the block properties. R4 makes the timing a
*measurement* and gives the bot a way back: it can dismantle what it built, and
nothing else.

- **The delay is measured, not deduced** (`circuits.mjs`):
  `measureCircuitDelay({trace, cell, triggeredAt, expectedTicks, toleranceMs})`
  takes the bot's own redstone trace (the last `REDSTONE_TRACE_LIMIT = 32`
  observed block changes, `[position, name, power, at]` in order — the adapter
  appends to it from `_noteRedstoneUpdate`) and returns the first change **at the
  declared output cell** that happened *after* the trigger:
  `{expectedTicks, expectedMs: expectedTicks * TICK_MS, toleranceMs, measuredMs,
  measuredTicks, ok, samples}`. `TICK_MS = 50`. Three honest states: no sample ⇒
  `measuredMs: null` and `ok: null` (never a success), a sample inside the
  tolerance ⇒ `ok: true`, a sample outside ⇒ `ok: false`. A change *before* the
  trigger is not an answer, and only the declared cell counts as a sample.
- **A blueprint declares how it wants to be measured**:
  `measure: {expectedTicks, outputOffset, required, toleranceMs}` — `outputOffset`
  must be a cell some step places (validated) and `required: true` means "if the
  delay cannot be measured, the build is not done". `delay_line` now declares
  `{expectedTicks: 6, outputOffset: [0,0,4], required: true, toleranceMs: 60}`:
  its acceptance is *six redstone ticks between the lever and the lamp*.
- **The ledger of what the bot placed** (`_placedBlocks`, key `"x,y,z"`):
  `_placeAtCell` records every successful placement
  (`{block, item, at, source, circuit}`) and `_buildCircuit` stamps `circuit:
  <id>` on the cells of its work site. The ledger is what makes a teardown
  *owned*: a cell the bot never placed cannot be removed.
- **`teardown_circuit`** (and `teardown_circuit_<id>`): removes the circuit cells
  the bot placed, one by one, and **skips** any cell that is no longer the block
  it placed (`{reason: 'changed', expected, found}` — someone else touched it) or
  is not in the ledger (`not_owned`). Report: `{ok, error, id, removed, skipped,
  failed, remaining}` with `nothing_to_tear_down` / `no_circuit_built` when there
  is nothing of its own, and `teardown_incomplete` when a removal fails. It is
  offered only when the ledger holds circuit cells, and it **never touches the
  rest of the world** — a torch or a hut wall the bot placed through the same
  primitive is not a circuit and stays.
- **A half-built site does not stay up**: `_buildCircuit(..., {rollback: true})`
  (the default) tears down the steps it had already placed when a later step
  fails, and reports `rollback: {removed, skipped, failed}`. A `placed` step that
  the server refuses is still reported — the report is the record, the world
  goes back to its previous state.
- **Error ladder**: the block checks come first (`circuit_verify_failed`), then
  the timing: `circuit_delay_not_confirmed` (a `post` failed),
  `circuit_delay_unmeasured` (the blueprint requires the measurement and nothing
  arrived), `circuit_delay_mismatch` (measured outside the tolerance). A wrong
  delay is an error even when every block is exactly where the blueprint wanted
  it.
- **Intent mapping**: `teardown_circuit` (and the `teardown_circuit_<id>`
  variant) → `build` + `redstone` in `survival/intents.mjs`; `REDSTONE_TRACE_LIMIT`
  is configurable (default 32).
- **Tests**: `tests/circuits.test.mjs` adds `measureCircuitDelay` (no sample, the
  right sample, a change in another cell, a change before the trigger, a late
  delay) and the `measure` validation messages; `tests/bedrock-circuits.test.mjs`
  adds the measured `delay_line` (`linkDelayMs: 300` ⇒ `measuredMs: 300`,
  `measuredTicks: 6`), the mismatch (`900 ms` ⇒ `circuit_delay_mismatch` with
  every block still correct), the unmeasured case (`traceUpdates: false` ⇒
  `circuit_delay_unmeasured`), the rollback on a failed step, the teardown of
  owned cells (with the option appearing and disappearing), the cell someone else
  changed (skipped, not mined) and the two "nothing to tear down" errors. Suite:
  **774 tests green**.
- **Live round (03/10/2026, container `hermes-jev-bedrock`)**: `/observe.circuits`
  → `{count: 8, buildable: […4…], declared: […4 with a reason…], invalid: null,
  last: null, owned: 0}`; `/options` → 22 keys with **no** `teardown_circuit` and
  no `build_circuit_*` (nothing owned, nothing buildable in the room);
  `POST /act {"key":"teardown_circuit"}` → `{ok: false, error:
  'nothing_to_tear_down', id: null, owned: 0}` in milliseconds, twice (before and
  after a failed `place_torch`); `build_circuit_delay_line` → `missing_materials`
  (cobblestone, lever, repeater ×3, redstone_lamp) and the attempt landed in
  `runs/demo/circuits.jsonl`.
- **Known limits (R4)**: the measured path, the rollback and the teardown of real
  cells are covered by the adapter tests with a modelled server, because the
  standing room has no redstone material and plan C forbids touching the base —
  the live round exercises the empty/refused paths (`owned: 0`,
  `nothing_to_tear_down`, `missing_materials`, the JSONL row). The measurement
  depends on the server reporting block updates for the output: if it stays
  silent, the honest answer is `circuit_delay_unmeasured`, not a passed test. A
  tolerance of ±60 ms absorbs the 50 ms tick but cannot tell "6 ticks late" from
  "one tick late, seven times": it is a timing check, not a trace analysis.
  `teardown_circuit` does not check whether the cell is *still powered* by
  something else; it removes the owned block and leaves the neighbour's wire
  alone.

## R5 — Automation and integration (implemented, unit-tested 03/10/2026)

R5 is what turns the R3/R4 builder from a catalogue of actions into something the
*progression* can reach. Two halves:

**1. The milestones and their skills are data.**

`knowledge/progression.json` gains three chained nodes below `iron_age`:

| milestone | requires | skill | closes when |
|---|---|---|---|
| `redstone_ore` | `iron_age` | `redstone_basics` | `inventoryTagGte {redstone_dust: 1}` |
| `redstone_basics` | `redstone_ore` | `craft_redstone_part` | `inventoryTagGte {redstone_parts: 1}` |
| `redstone_automation` | `redstone_basics` | `build_lamp_switch` | no `satisfiedWhen`: only a *verified* circuit |

`goals.redstone` is an alias of `redstone_automation`, so
`CURRICULUM=redstone` works like `CURRICULUM=first_night`. The last node has **no**
`satisfiedWhen` on purpose: an inventory full of levers and lamps is not
automation, so it closes only through the real verification (the
`completedMilestones` path, as `first_night` does).

The six skills in `skills/gameplay/redstone/`:

- `redstone_basics` — preconditions `inventoryTagGte {iron_tools: 1}` (redstone ore
  needs an iron pickaxe); success `inventoryTagGte {redstone_dust: 1}`.
- `craft_redstone_part` — success `inventoryTagGte {redstone_parts: 1}`
  (repeater/comparator/piston/observer/dispenser/dropper/lever/torch/detector/…).
- `build_lamp_switch`, `build_auto_lamp`, `build_auto_harvest`, `build_hopper_chain`
  — one per integration named by the roadmap (defense/light → `auto_lamp`,
  farming → `auto_harvest`, storage → `hopper_chain`), each with success
  `{circuitBuilt: {id: <blueprint>}}`. The two blueprints that are still
  `buildable: false` are declared anyway, with the reason and a note that they are
  **not reachable today**; the skill exists so the gap is visible in the graph
  instead of hidden in a doc.

Two new tags in `survival/item-tags.mjs` feed those criteria: `redstone_dust`
(`redstone`/`redstone_dust`) and `redstone_parts` (`REDSTONE_PART_NAMES`, 17
items), plus `hoppers`.

**2. The verifier can trust a circuit (new criterion `circuitBuilt`).**

`verifySkill` could already check an *inventory*, not a *build*. `circuitBuilt`
reads `after.circuits.last` (the report `_buildCircuit` now stamps with `at`) and
fails when there is no report, when the id is not the one the skill asks for,
when `ok` is false, and — this matters — when `before.circuits.last.at` equals
`after.circuits.last.at`: a circuit that was already there does **not** count as
the skill's success. Evidence: `{circuitBuilt, circuitAt, circuitSteps,
circuitDelay}`.

**3. The materials bridge.**

A blueprint asks for blocks; the bot has resources. `_circuitOptionFor(def)`
closes the gap: when `plan.missing` is not empty it publishes
`craft_<item>` — *only* if that item is craftable **right now**
(`_craftableNow`: known recipe + ingredients held + a crafting table within 32
blocks when the recipe is bigger than 2×2) — with the description `Craft
<item> for the <id> circuit (missing …)`. Only the first craftable missing
material is offered, so the option list does not explode. When nothing is
missing the same function publishes `build_circuit_<id>` after the site check.
The result: `/options` never shows a workshop the bot cannot pay for, and it
shows the next step *towards* one (craft the lever → build the door) instead of
a dead end.

**Tests.** `tests/progression.test.mjs` (tags + the three milestones, including
that a full lamp/lever inventory does **not** close `redstone_automation`),
`tests/bedrock-redstone-criteria.test.mjs` (`circuitBuilt` in all its forms,
`CRITERIA_KEYS`), `tests/gameplay-skills.test.mjs` (the six skills and the exact
`circuitBuilt` success of each builder), `tests/controller-curriculum.test.mjs`
(`CURRICULUM=redstone_automation` driven by a staged fake harness with a fake
`hermes` on PATH: three skills, `GOAL MET after 3 actions`, the evidence in
`skills.jsonl`), `tests/bedrock-circuits.test.mjs` (the materials bridge: a
2×3 recipe needs the table, an uncraftable material offers nothing, a complete
inventory offers the site).

**Live round (03/10/2026).** The extended graph loads and resolves on the BDS:
in the container `resolveMilestone` returns
`{status:'next', milestone:'redstone_automation', skill:'build_lamp_switch'}`,
26 skills load (6 redstone), and `CURRICULUM=redstone_automation` drives a real
prerequisite (`stone_age` → 3× `mine_cobblestone` confirmed by the server) before
the action budget runs out; the final plan resolves to targets
`{redstone_lamp: 1, lever: 1}` with success `{circuitBuilt: {id: 'lamp_switch'}}`.
`GET /observe.circuits` reports the 8 blueprints (4 buildable, `owned: 0`,
`last: null`) and `/options` offers neither `build_circuit_*` nor `craft_lever`:
with the bot's real inventory the bridge correctly says *nothing is craftable
yet*.

**Known limits (R5).**

- The end-to-end live build (mine ore → craft → build → verify → teardown) is
  still not reachable in this base and for three independent reasons: the room's
  drops fall into the cavity under its floor and report `reachable: false`
  (the known pickup blocker), the only cobblestone in reach *is* the base wall,
  and a `redstone_lamp` needs Nether glowstone. Everything between
  `craft_<item>` and `circuitBuilt` is covered by the fake-server tests.
- `_craftableNow` sees **crafting** only: a material obtained by *smelting*
  (cobblestone → stone, which `auto_door` needs) is not offered as a bridge step.
  The manual path (`mine_cobblestone`, then `smelt_cobblestone` when a furnace and
  fuel are in reach) is in `/options` when the materials exist.
- Only the **first** craftable missing material is offered per blueprint: for
  `auto_door` the order is the blueprint's `requires` order, so the lever comes
  before the fence gate. It is a hint, not a plan.
- The two `buildable: false` skills (`build_auto_harvest`, `build_hopper_chain`)
  are declared and will fail the milestone: this is intentional (the gap is
  documented), but it also means `CURRICULUM=redstone_automation` cannot be
  closed through them.

## Proposed vocabulary

- **Actions**: `build_circuit_<id>`, `use_redstone`, `set_repeater_delay`,
  `sense_redstone`, `teardown_circuit`, `mine_redstone_ore` (via `_refreshNearby`).
  `craft_<item>` (R5) is not a redstone action of its own: it is published by the
  circuit option when a blueprint's first craftable missing material can be made
  now.
  Implemented: `use_redstone`, `sense_redstone`, `set_repeater_delay`,
  `mine_redstone_ore`, `build_circuit_<id>`, `teardown_circuit` (and its
  `teardown_circuit_<id>` variant).
- **Intents**: `redstone`, `toggle`, `sense`.
- **Item tags**: `redstone_dust`, `redstone_components`, `pistons`, `hoppers`.
- **Conditions/criteria**: `redstoneNearby`, `tntNearby`, `blockPoweredAt` /
  `circuitActive` (implemented in `survival/verify.mjs`; `redstoneNearby` and
  `tntNearby` are not yet wired into a skill).

## Milestones

| # | Milestone | Content | Status |
|---|---|---|---|
| R0 | Awareness & protection | Add redstone to `DIG_PROTECTED`; extend `_refreshNearby` (ore + components); `/observe.redstone`; state-aware `findBlocksByState`; pure `bedrock-redstone.mjs` (`powerOf`, `isSource/isOutput`, `tnt` hazard). | ◑ implemented + live: awareness, census and dig protection done; circuit *building* is R1+ |
| R1 | Oriented placement | Extend `_placeAtCell` with desired state/facing and side faces; confirm name+properties; place→read→correct retry; packet-capture task for placement orientation; repeater delay via interaction. | ◑ place→read→correct + repeater delay implemented and unit-tested; packet capture **not needed**; the live component round is blocked by plan C (no base edits) |
| R2 | Interaction & sensing | `use_redstone` (lever/button) with state + downstream verification; redstone cache in `/observe`; `sense_redstone`; verifier criteria. | ◑ implemented + unit-tested and live-sensed (in-place cache, `use_redstone`, `sense_redstone`, `blockPoweredAt`/`circuitActive`); the live toggle is blocked by plan C |
| R3 | Primitive circuits | Declarative `circuits/*.json` blueprints (`lamp_switch`, `delay_line`, `auto_lamp`, `auto_door`, `auto_harvest`, `auto_dispense`, `hopper_chain`, `crafter_pulse`) + `build_circuit_<id>` bounded action. | ◑ `circuits.mjs` + 8 blueprints (4 buildable, 4 declared with a reason) + `build_circuit_<id>` implemented, unit-tested (19 cases) and live-refused (catalogue, gating, `circuits.jsonl`); the acceptance *build* needs a redstone lamp (Nether) and is blocked by plan C |
| R4 | Verify, teardown, guardrails | Deterministic circuit verifier; `teardown_circuit` limited to bot-built blocks; rollback on partial failure; no redstone edits outside owned circuits. | ◑ measured delay (`measureCircuitDelay` from the `_redstoneTrace`, `required`/`toleranceMs` per blueprint), placed-block ledger, `teardown_circuit[_<id>]` limited to circuit cells the bot placed (a cell someone else changed is skipped), rollback of a half-built site; unit-tested (24 + 21 cases) and live-verified on the empty/refused paths |
| R5 | Automation & integration | Gameplay skills `skills/gameplay/redstone/`; progression milestones `redstone_ore`/`redstone_basics`/`redstone_automation`; integrate farming (`auto_harvest`), storage (`hopper_chain`), defense (`auto_lamp`), fluids (water stream). | ◑ 6 declarative skills + the 3 chained milestones + goal alias `redstone` + the `circuitBuilt` verifier criterion + the materials bridge (`craft_<item>` for a blueprint's first craftable missing material, `build_circuit_<id>` when nothing is missing); unit-tested (progression, criteria, skills, curriculum scenario, materials bridge) and live-resolved on the BDS (graph loads, `CURRICULUM=redstone_automation` drives `stone_age`); the live *build* is blocked by the room (unreachable drops, base wall, Nether glowstone) |
| R6 | Limits & docs | No command blocks, no TNT/traps, lag/size caps, bot-safety, runbook/wiki updates. | ❌ not implemented |

## Key risks / open questions

- **Oriented placement (R1)**: resolved without a packet capture — the
  deterministic place → read → correct loop reads the state the server actually
  derived. What remains open is the **live component round** (plan C blocks the
  only cobblestone in reach) and the face dimension (a family that reacts to the
  clicked face). R3 inherits the same constraint one level up: the blueprints are
  validated and the builder is typed, but *building* a lamp needs materials the
  room does not have.
- **The world view can drop a section under the bot**: during the live round
  `standingOn` went `oak_planks` → `null`, `headroom` → 0 and the placement search
  answered `no_place_spot` (the ring requires *visible* air), while the bot had not
  moved; a few seconds later the same call answered `missing_item` again. The
  census/placement code treats `unknown` as solid on purpose, so this is a
  conservative, typed failure rather than a wrong placement.
- Some blocks (`note_block`, generic `pressure_plate`, `tripwire`) are absent from
  the `bedrock_1.26.51` registry — confirm the correct names or drop them.
- Repeater delay is in ticks; live timing must calibrate the verifier.
- "Circuit works" must be verified on the **output** (lamp/piston/dispenser), not
  only on the wire's `redstone_signal`.
- Redstone is a scarce resource (the base's supply came from a broken chest);
  inventory must be census'd and materials returned via teardown.
- Large circuits / fast clocks hurt the shared BDS TPS; size caps and forced
  shutdown of clocks.

## Related pages

- [roadmap](roadmap.md) — consolidated implementation status.
- [open-questions](open-questions.md) — blockers and verification gaps.
- [verification](verification.md) — collaudo checklist.
- [fluids](fluids.md) — water streams used by some harvesters.
- [fishing](fishing.md) — example of a pure rules module + declarative verification.
- [survival-intelligence](survival-intelligence.md) — governor, skills, verifier,
  progression.
- [headless-client](headless-client.md) — protocol-level perception and the
  bounded-action loop.
