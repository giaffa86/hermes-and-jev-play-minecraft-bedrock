# Open questions

Known issues, blockers and verification gaps. Sources: `BEDROCK.md` (Known issues)
and `docs/raw/SURVIVAL-INTELLIGENCE.md` (Verification status). For the per-
capability collaudo checklist (done / pending live), see
[verification](verification.md).

## NetherNet instability

- The session drops every few seconds in some time slots (`Player disconnected`
  after 3-20 s, no server-side error). The harness reconnects itself, but during
  reconnection `/options` offers only `wait`.
- `connecterror:9` (InactivityTimeout) persists for hours at zero players; only a
  BDS restart clears it. One solved cause: mining via `item_stack_request` with
  invalid negative ids (fixed by reusing the crafting id sequence).

## Missing Bedrock capabilities (for the full first-night milestone)

- **Food beyond crops** — requires the furnace/smelting chain (exists, needs live
  testing of `eat` with hunger < 20 and food in inventory).
- **Ranged combat** — the bot has **no bow/arrow support**: `attack_*` is melee
  only (`item_use_on_entity`). A bow (`craft_bow`: 3 sticks + 3 string) plus
  arrows (`craft_arrows`: flint + stick + feather) would add a safe creeper
  counter and a way to fight from range. Nothing is implemented yet.
- **Advanced shelter** — no wall/shelter building actions.
- **Nether portal** — not implemented.
- **Fluids** — swimming, drowning/breathing, waterfalls and lava avoidance are
  not implemented; `_passable()` treats `water|lava` as walls (`bedrock-adapter.mjs`).
  Roadmap in [fluids](fluids.md). Two discovery items block M1: the exact Bedrock
  water-movement `input_data` flags/`delta` semantics (needs a packet capture of a
  real player swimming) and whether self metadata exposes `breathing`/air or the
  air budget must be simulated.

## Respawn stuck on live BDS (2026-10-02, resolved)

- The deployed `hermes-jev-bedrock` container was **dead** (`health: 0, deaths: 1`)
  and stuck: `_survivalTick` sent `player_action {action: 'respawn'}` every
  2.5 s but the BDS never replied with the `respawn` packet (no `respawn_packet`
  log), so `/options` degraded to `wait` (`Dead; respawning automatically`).
- **Resolution**: it was a stale NetherNet session state for that player, not a
  protocol bug. A BDS restart at zero players (stop container → `systemctl
  restart minecraft-bedrock` → start container) cleared it; the bot respawned
  alive (`health:20`, spawn point) with an empty inventory (death dropped the
  items, `keep-inventory=false`).
- **Note**: this recovery was a fresh login, so the in-place
  `player_action respawn` flow itself still needs a clean live re-verification
  (die → respawn without a restart). Tracked in [verification](verification.md)
  row 12.

## Live verification pending

- `eat` and the container actions `read_container`/`take_<item>`/`deposit_<item>`
  are covered by unit tests but not yet verified live.
- Trading (`open_trade`/`trade_<index>`/`level_<profession>`) is implemented and
  unit-tested, but the exact client→server transaction that finalises a trade and
  the tier-up detection still need a live round on a real villager. See
  [trading](trading.md).
- A live `CURRICULUM=first_night` round on the BDS was not run (the bot container
  was connected; a concurrent session with the same account would kick it out).

## Design limitations

- **No real exploration**: the bot only "sees" ores within ~±40 loaded blocks (the
  96-block radar is capped by the actively requested subchunks) and has no random
  walk / strip mining / cave exploration. See
  [headless-client](headless-client.md#8-render-distance-not-comparable). A full
  autonomous-exploration spec (find biome/block/structure, deterministic spiral
  planner) exists in [exploration](exploration.md) but is not implemented.
- **Placement** only on a top face adjacent to the bot; no scaling/orientation.
- **Crafting** only one item at a time; special recipes (smithing, anvil, looms)
  not implemented.

## Planned / in progress

- **Persistent agent lifecycle** (AI-player roadmap milestone 0): the controller
  is a one-shot loop (`process.exit(0)` on goal met/budget) while the harness
  keeps the bot connected. Missing: an explicit `IDLE` state and a goal queue so
  the bot can accept a new goal (or autonomous idle behaviour) without
  re-running `controller.mjs`. Full analysis in
  [ai-player-roadmap](ai-player-roadmap.md).

- **Farming** (`.private/FARMING-TASK.md`) — not started: `plant_<seed>`/resow,
  passive-animal `attack_<animal>`, `feed_*`/`breed_*`/`tame_*`/`shear_*`,
  `throw_egg`, milk. Next planned work; consolidated status in
  [roadmap](roadmap.md).
- **Human chat command channel**: natural-language remote control via in-game
  chat (`@bot seguimi`, `@bot aiutami coi mob`). M1–M3 implemented (chat capture,
  allowlist + trigger, NL → Hermes → `/plan`, `follow_player`); **live
  verification on the BDS still pending**. Ack/reply in chat (M5) and autonomous
  exploration remain open. Roadmap in [human-command](human-command.md).
- **Defense completions** — still missing: `place_torch`, `craft_*_sword`,
  `retreat`/`go_home`, `close_door`/`barricade`, armor, shield. See
  [roadmap](roadmap.md).
- **Fishing** — not started: string source, `craft_fishing_rod`,
  `cast_rod`/`reel_in`/`fish`, water/shore detection. The open technical
  question is **bite detection** on a headless client (bobber metadata vs.
  timing fallback). Roadmap in [fishing](fishing.md).
- **Fluids** (swimming, drowning/breathing, waterfalls, lava avoidance, buckets/
  boats/potions) — spec only. Roadmap in [fluids](fluids.md); start at M0 (fluid
  awareness) and M1 (swimming physics + air budget).

## Architecture evolution

Recorded in [architecture-evolution](architecture-evolution.md): Hermes is best
framed as a **strategic replanner, not a hierarchical planner** — it emits one
shallow objective per replan and never decomposes into `goal → subgoal → action`.
Two open design questions follow from that framing:

- **First-class `subgoal`**: add a `subgoal` field to the plan and let Hermes
  keep `objective` stable while rotating `subgoal`/`targets`/`skill`
  (receding-horizon). Today `subgoal` exists only implicitly (the `milestone`
  field in curriculum mode, the `skill` field in free-goal mode).
- **Multi-branch progression**: `resolveMilestone` returns a single deterministic
  `next` (DFS first-hit) — no OR/alternative-path semantics. To support copper /
  iron / exploration paths the graph needs branch nodes and a Hermes scoring
  hook, while Jev stays one-action-at-a-time.
