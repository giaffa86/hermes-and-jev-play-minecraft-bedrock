# Roadmap and implementation status

Consolidated view of the port's roadmaps and task notes, with the current
implementation status. This page reorganizes the private handoff documents in
`.private/` (which stay immutable raw sources) into one current-status picture:
what is **done and verified live**, what is **implemented but not yet verified
live**, and what is **not implemented**.

Sources: `.private/ROADMAP.md`, `.private/GOAL.md`, `.private/JEV-TASK.md`,
`.private/DEFENSE-TASK.md`, `.private/FARMING-TASK.md`, `.private/STORAGE-TASK.md`,
`.private/TRADING-TASK.md`, `.private/MINING-20261001.md`, `BEDROCK.md`
(action status + Known issues), `docs/wiki/*`.

> The `.private/*.md` notes are **historical**: `ROADMAP.md` and `GOAL.md` are
> frozen at 2026-10-01 and are now superseded by the code; this page is the
> current-state authority going forward. `BEDROCK.md` remains the operational
> runbook for per-action detail.

## Legend

- ✅ **Done** — implemented and verified live on the real BDS (or via unit tests where no live signal is obtainable).
- ⚠️ **Implemented, live verification pending** — code + unit tests exist, no live round yet.
- ◑ **Partially implemented** — some pieces done, some missing.
- ❌ **Not implemented**.

## Roadmap artifacts → current status

| `.private/` artifact | What it is | Status | Where the work landed |
|---|---|---|---|
| `ROADMAP.md` | Original port roadmap (division of labour + technical milestones) | ✅ done, superseded (frozen 01/10) | `BEDROCK.md`, `bedrock-adapter.mjs` |
| `GOAL.md` | Original goal + launch runbook (Phases 1–10, two gameplay milestones) | ◑ Phases 1–9 done; Phase 10 (real multiplayer) and a full `first_night` run open | `BEDROCK.md`, `survival/` |
| `JEV-TASK.md` | Jev decision quality + evaluation with new actions | ✅ implemented; live eval scenarios open | `controller-decisions.mjs`, `tests/controller-decisions.test.mjs` |
| `DEFENSE-TASK.md` | Defense strategies (torch/lighting, weapons, shelter, armor, shield) | ◑ partial | `bedrock-adapter.mjs` (`attack_*`, `flee`, `sleep`, `craft_torch`, `recover_loot`) |
| `FARMING-TASK.md` | Farming (plant/resow crops, passive animals, feed/breed/tame/shear) | ❌ not started (only `mine_*` on crops + `collect_drop`) | — (next planned work) |
| `STORAGE-TASK.md` | Chest/barrel storage: read, take, deposit | ⚠️ implemented, live verification pending | `bedrock-adapter.mjs` (`read_container`, `take_<item>`, `deposit_<item>`) |
| `TRADING-TASK.md` | Villager/wandering-trader trade + levelling | ⚠️ implemented, live verification pending | `bedrock-adapter.mjs` + `bedrock-trading.mjs`; see [trading](trading.md) |
| `MINING-20261001.md` | Mining collaudo report | ✅ superseded (ore/durability live) | `BEDROCK.md` (Minerals and durability phase) |
| `INCIDENTS.md` | Operational incidents + anti-damage rules | ✅ rules absorbed into `AGENTS.md` | `AGENTS.md` (Operational safety rules) |
| `BRANCH-FEAT-DROP-PICKUP-NOTE.md` | `feat/drop-pickup` branch analysis + manual port | ✅ done (committed `3bca6b0`) | `bedrock-adapter.mjs` auto-pickup |

## Goal phases (from `.private/GOAL.md`)

| Phase | Status | Notes |
|---|---|---|
| 1 — understand original architecture | ✅ | |
| 2 — evaluate Bedrock client libraries | ✅ | `bedrock-protocol@3.60.1` + `nethernet`/Werift |
| 3 — connectivity smoke test | ✅ | spawn as real player, verified |
| 4 — preserve harness contract | ✅ | `/observe` `/options` `/act` `/plan` |
| 5 — port bounded actions | ✅ | see `BEDROCK.md` action status |
| 6 — navigation | ✅ | server-authoritative movement + A*, doors |
| 7 — inventory and crafting | ✅ | planks/sticks/table/pickaxes, smelting |
| 8 — combat and survival state | ✅ basic | `attack_*`, `flee`, `eat` (eat not live) |
| 9 — Hermes + Jev integration | ✅ | end-to-end loop verified |
| 10 — real multiplayer test | ⚠️ | not yet run with a human online |

## Gameplay milestones

| Milestone | Status |
|---|---|
| First: wood → wooden pickaxe → stone → stone pickaxe | ✅ live (`runs/e2e-stone6`, `GOAL MET after 33 actions`) |
| Second: food, coal/iron, smelt, iron tools | ◑ coal + iron + smelt (`iron_ingot`) live; `eat` live pending; full `CURRICULUM=first_night` run not executed |

## What is done and verified live

- Connectivity + spawn as a real separate player.
- Server-authoritative movement + A* pathfinding (doors opened along the way).
- Mining (dirt/stone/logs/crops/coal/iron/copper), tool auto-selection, vanilla
  break times, drop collection + auto-pickup.
- Crafting (2×2 / 3×3), placement, smelting chain `raw_iron → iron_ingot`.
- Survival: `attack_*`, `flee`, `sleep`, `dig_up`/`dig_down` (protected),
  death/respawn, `recover_loot` (+XP).
- Robust controller + Jev decision quality (`controller-decisions.mjs`):
  survival priorities, anti-loop, option cap, diagnostics.
- Survival Intelligence Layer (governor, declarative skills, verifier,
  progression) — see [survival-intelligence](survival-intelligence.md).
- Human chat command channel M1–M3 (capture/identify/follow/NL orders) —
  see [human-command](human-command.md).
- Trading + levelling code path (unit-tested) — see [trading](trading.md).
- 246 green unit tests.

## What is implemented but not verified live

- `eat` (needs hunger < 20 and food in inventory).
- Storage: `read_container`, `take_<item>`, `deposit_<item>`.
- Trading: `open_trade`, `trade_<index>`, `close_trade`,
  `level_<profession>`/`level_trader` (final trade transaction + tier-up
  detection).
- `follow_player` and the chat command channel M1–M3 (wiring + unit tests done).
- Tool durability over many blocks / long ore runs (unit-tested only).
- A live `CURRICULUM=first_night` round and the real-multiplayer test (Phase 10).

## What is not implemented

- Farming (`.private/FARMING-TASK.md`): `plant_<seed>`/resow, passive-animal
  `attack_<animal>`, `feed_*`, `breed_*`, `tame_wolf`/`tame_cat`, `shear_*`,
  `throw_egg`, milk, `farmAnimals` census in `/observe`.
- Defense gaps: `place_torch`, `craft_*_sword`, `retreat`/`go_home`,
  `close_door`, `barricade`, armor equip/armor points, shield (stretch).
- Human chat command M5 (ack/reply in chat) and autonomous exploration.

## Open cross-cutting issues

- NetherNet instability + `connecterror:9` (only a BDS restart at zero players
  clears it) — see [open-questions](open-questions.md).
- No real exploration (strip mining / caves), no shelter building, no nether
  portal — see [open-questions](open-questions.md).

## Next planned work

1. **Farming task** (`.private/FARMING-TASK.md`) — plant/resow crops and passive
   animals.
2. Live verification of the ⚠️ items (storage, trading, `eat`, chat channel).
3. Defense completions (torch placement, swords, shelter) and a full
   `CURRICULUM=first_night` run.

## Related pages

- [overview](overview.md) — project split and components.
- [control-flow](control-flow.md) — goal → plan → single action.
- [human-command](human-command.md) — chat command roadmap M1–M5.
- [trading](trading.md) — villager trade + levelling.
- [open-questions](open-questions.md) — blockers and verification gaps.
