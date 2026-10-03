# Redstone and primitive automation

Roadmap for letting the bot **use redstone and build primitive redstone
circuits**: switches, delay lines, automatic lamps, observer/piston harvesters,
hopper item transport, dispensers and (stretch) crafters. It builds on the
verified primitives (placement, `click_block` interaction, containers, crafting,
digging) while never breaking the base's own circuits.

Status: **R0, R1 and R2 implemented and unit-tested (R0 also collaudato live);
the live component round is blocked by the standing "no base edits" rule
(03/10/2026); R3–R6 spec only** (tracked in [roadmap](roadmap.md) and
[open-questions](open-questions.md)). Full raw source:
[`docs/raw/REDSTONE_ROADMAP.md`](../raw/REDSTONE_ROADMAP.md).

Sources: `bedrock-adapter.mjs` (placement, interaction, digging, `DIG_PROTECTED`),
`bedrock-redstone.mjs` (R0: component vocabulary, `powerOf`, `redstoneView`),
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

## Proposed vocabulary

- **Actions**: `build_circuit_<id>`, `use_redstone`, `set_repeater_delay`,
  `sense_redstone`, `teardown_circuit`, `mine_redstone_ore` (via `_refreshNearby`).
  Implemented: `use_redstone`, `sense_redstone`, `set_repeater_delay`,
  `mine_redstone_ore`; still missing: `build_circuit_<id>` (R3) and
  `teardown_circuit` (R4).
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
| R3 | Primitive circuits | Declarative `circuits/*.json` blueprints (`lamp_switch`, `delay_line`, `auto_lamp`, `auto_door`, `auto_harvest`, `auto_dispense`, `hopper_chain`, `crafter_pulse`) + `build_circuit_<id>` bounded action. | ❌ not implemented |
| R4 | Verify, teardown, guardrails | Deterministic circuit verifier; `teardown_circuit` limited to bot-built blocks; rollback on partial failure; no redstone edits outside owned circuits. | ❌ not implemented |
| R5 | Automation & integration | Gameplay skills `skills/gameplay/redstone/`; progression milestones `redstone_ore`/`redstone_basics`/`redstone_automation`; integrate farming (`auto_harvest`), storage (`hopper_chain`), defense (`auto_lamp`), fluids (water stream). | ❌ not implemented |
| R6 | Limits & docs | No command blocks, no TNT/traps, lag/size caps, bot-safety, runbook/wiki updates. | ❌ not implemented |

## Key risks / open questions

- **Oriented placement (R1)**: resolved without a packet capture — the
  deterministic place → read → correct loop reads the state the server actually
  derived. What remains open is the **live component round** (plan C blocks the
  only cobblestone in reach) and the face dimension (a family that reacts to the
  clicked face).
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
