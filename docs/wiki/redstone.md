# Redstone and primitive automation

Roadmap for letting the bot **use redstone and build primitive redstone
circuits**: switches, delay lines, automatic lamps, observer/piston harvesters,
hopper item transport, dispensers and (stretch) crafters. It builds on the
verified primitives (placement, `click_block` interaction, containers, crafting,
digging) while never breaking the base's own circuits.

Status: **spec only — not implemented** (tracked in [roadmap](roadmap.md) and
[open-questions](open-questions.md)). Full raw source:
[`docs/raw/REDSTONE_ROADMAP.md`](../raw/REDSTONE_ROADMAP.md).

Sources: `bedrock-adapter.mjs` (placement, interaction, digging, `DIG_PROTECTED`),
`bedrock-world.mjs` (block-state decoding), `BEDROCK.md` (action status),
[survival-intelligence](survival-intelligence.md) (skills/verifier/progression),
[fishing](fishing.md), [fluids](fluids.md) (water streams for harvesters).

## Current state (from the code and registry)

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

## Proposed vocabulary

- **Actions**: `build_circuit_<id>`, `use_redstone`, `set_repeater_delay`,
  `sense_redstone`, `teardown_circuit`, `mine_redstone_ore` (via `_refreshNearby`).
- **Intents**: `redstone`, `toggle`, `sense`.
- **Item tags**: `redstone_dust`, `redstone_components`, `pistons`, `hoppers`.
- **Conditions/criteria**: `redstoneNearby`, `tntNearby`, `blockPoweredAt` /
  `circuitActive`.

## Milestones

| # | Milestone | Content | Status |
|---|---|---|---|
| R0 | Awareness & protection | Add redstone to `DIG_PROTECTED`; extend `_refreshNearby` (ore + components); `/observe.redstone`; state-aware `findBlocksByState`; pure `bedrock-redstone.mjs` (`powerOf`, `isSource/isOutput`, `tnt` hazard). | ❌ not implemented |
| R1 | Oriented placement | Extend `_placeAtCell` with desired state/facing and side faces; confirm name+properties; place→read→correct retry; packet-capture task for placement orientation; repeater delay via interaction. | ❌ not implemented |
| R2 | Interaction & sensing | `use_redstone` (lever/button) with state + downstream verification; redstone cache in `/observe`; `sense_redstone`; verifier criteria. | ❌ not implemented |
| R3 | Primitive circuits | Declarative `circuits/*.json` blueprints (`lamp_switch`, `delay_line`, `auto_lamp`, `auto_door`, `auto_harvest`, `auto_dispense`, `hopper_chain`, `crafter_pulse`) + `build_circuit_<id>` bounded action. | ❌ not implemented |
| R4 | Verify, teardown, guardrails | Deterministic circuit verifier; `teardown_circuit` limited to bot-built blocks; rollback on partial failure; no redstone edits outside owned circuits. | ❌ not implemented |
| R5 | Automation & integration | Gameplay skills `skills/gameplay/redstone/`; progression milestones `redstone_ore`/`redstone_basics`/`redstone_automation`; integrate farming (`auto_harvest`), storage (`hopper_chain`), defense (`auto_lamp`), fluids (water stream). | ❌ not implemented |
| R6 | Limits & docs | No command blocks, no TNT/traps, lag/size caps, bot-safety, runbook/wiki updates. | ❌ not implemented |

## Key risks / open questions

- **Oriented placement is the blocker (R1)**: how the BDS derives block state from
  player yaw/pitch, clicked face and `click_pos` needs a packet capture.
  Fallback: a deterministic place → read → correct loop.
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
