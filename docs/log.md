# Log

Append-only record of wiki operations. Prefix: `## [YYYY-MM-DD] <type> | <title>`
where `<type>` is one of `ingest`, `query`, `lint`, `doc`.

## [2026-10-02] doc | LLM-wiki scaffolded and docs translated to English

- Restructured `docs/` into an LLM wiki (manifest `llm-wiki.md`, `index.md`,
  `log.md`, `sources.md`, `raw/`, `wiki/`).
- Translated `BEDROCK.md` (repo root) and `SURVIVAL-INTELLIGENCE.md`
  (now `docs/raw/SURVIVAL-INTELLIGENCE.md`) from Italian to English.
- Moved `REPRODUCTION-REPORT.md` and `evidence/` into `docs/raw/`; moved
  `HEADLESS-CLIENT.md` into `docs/wiki/headless-client.md`.
- Added synthesis pages: `wiki/overview.md`, `wiki/survival-intelligence.md`,
  `wiki/reproduction.md`, `wiki/open-questions.md`.

## [2026-10-02] doc | Human chat command channel roadmap

- Added `wiki/human-command.md`: roadmap for a human-in-chat natural-language
  command channel (`@bot seguimi`, `@bot aiutami coi mob`).
- Analyzed the current state: chat is already received (packet `text` id 9,
  fields `source_name`/`type`/`message`/`xuid`) but unused; player positions are
  tracked but gamertags are dropped; combat is ready; autonomous exploration is
  the hard gap.
- Defined milestones M1–M5 (capture/identify → follow → NL orders → guided
  mining → ack/exploration) and open questions (trigger syntax, follow
  semantics, plan-override priority, acknowledgement).
- Cross-linked from `index.md`, `overview.md` and `open-questions.md`.

## [2026-10-03] ingest | Trading with villagers/wandering traders + levelling

- Added trader detection (`isTraderType`: villager/villager_v2/wandering_trader/
  trader_llama), `open_trade` (`item_use_on_entity` `interact`), `update_trade`
  offer parsing (NBT → buyA/buyB/sell/uses/maxUses/tier), `trade_<index>` and
  `close_trade` to `bedrock-adapter.mjs`; `/observe` now exposes `traders` and
  `trade`.
- Added `bedrock-trading.mjs` (pure economy): profession map, item value
  classification (precious/emerald/cheap/neutral) and `pickBestTrade`.
- Added autonomous trader levelling `level_<profession>`/`level_trader`: loops the
  cheapest available offer (never emeralds nor precious resources) until
  `max_trade_tier`; profession verified live via `update_trade.display_name`.
- Tests: `tests/bedrock-trading.test.mjs` (11) and `tests/bedrock-leveling.test.mjs`
  (11); full suite green (246). Live verification on the BDS pending.
- New page `wiki/trading.md`; updated `index.md`, `sources.md`, `open-questions.md`.

## [2026-10-02] doc | Human chat command channel: M1-M3 implemented

- `bedrock-adapter.mjs`: `_onChat` (`text` id 9 → `chatInbox`), `chat` in
  `observe()`, `username` capture in `_trackEntity`/`_nearbyEntities`,
  `_playerByName`, `follow_player` option + `_followPlayer` action.
- `controller.mjs`: `CHAT_ALLOWLIST`/`CHAT_PREFIX`/`CHAT_CONTROL`, `maybeHumanCommand`
  → Hermes → `/plan` with priority; `goalMet` open-ended for `plan.follow`.
- `controller-decisions.mjs`: `follow_player` ranked tier 2. `tests/*` green
  (+ `follow_player` priority case). `.env.example` documents the new vars.
- Live verification on the BDS still pending.

## [2026-10-02] doc | Bot visibility to other players (not a ghost)

- Added `headless-client.md` §1.1: the bot is a real, fully-visible player
  (player list, default skin, server-authoritative movement); "headless" only
  describes its own missing rendering, not its visibility to others.
- Updated the page's recurring-questions list and the `index.md` summary.

## [2026-10-02] doc | Control-flow page with goal → plan → action diagram

- Added `wiki/control-flow.md`: end-to-end loop (Progression Engine → System
  Two/Hermes → Skill Resolver → harness `/options` → System One/Jev → world),
  with the Survival Governor as a cross-cutting deterministic override.
- Clarified what System Two does *not* do: it is a shallow planner and never
  emits an action sequence; task decomposition is deterministic (progression
  graph + declarative skills).
- Cross-linked from `index.md`, `overview.md` and `survival-intelligence.md`.

## [2026-10-02] doc | Architecture evolution thesis (strategic replanner + subgoal + multi-branch)

- Added `wiki/architecture-evolution.md`: the four-way split (Progression /
  Hermes / harness / Jev), the rename "System Two = strategic replanner, not
  hierarchical planner", and two proposed evolutions — a first-class `subgoal`
  field with receding-horizon planning, and a multi-branch progression graph
  (copper/iron/exploration) with Hermes as branch chooser.
- Mapped "already exists vs proposed" against the code (`milestone`/`skill`
  fields, the replan loop, `resolveMilestone` single-`next` DFS).
- Cross-linked from `index.md`, `overview.md`, `control-flow.md` and
  `open-questions.md`.

## [2026-10-03] doc | Consolidated roadmap + implementation status page

- Added `wiki/roadmap.md`: reorganizes the `.private/` roadmaps/task notes
  (`ROADMAP.md`, `GOAL.md`, `JEV/DEFENSE/FARMING/STORAGE/TRADING-TASK.md`) into
  one current-status view — done/verified-live vs implemented-pending-live vs
  not-implemented — plus GOAL phases, gameplay milestones and next planned work
  (farming first).
- Marked `ROADMAP.md`/`GOAL.md` as historical (frozen 01/10, superseded by code).
- Cross-linked from `index.md`, `sources.md`, `overview.md`, `open-questions.md`.

## [2026-10-03] ingest | Farming slice: plant seeds, feed/hunt farm animals

- `bedrock-survival.mjs`: farm-animal whitelist (`cow`/`mooshroom`/`sheep`/`pig`/
  `chicken`/`rabbit`), `ANIMAL_FEED`, `SEED_TO_CROP`, crop/farmland predicates and
  farm-animal entity heights.
- `bedrock-adapter.mjs`: metadata flags `baby`/`tempted`/`inlove` + `owner_eid`;
  `/observe.farmAnimals`; `plant_<seed>` (click_block on free farmland, confirmed
  by the crop above), `feed_<animal>` (`item_use_on_entity` interact, confirmed by
  `inlove`/consumed), `attack_<animal>` (farm animals via `_entityOfType`);
  farmland/fences/crops added to `DIG_PROTECTED`.
- Tests: `tests/bedrock-farming.test.mjs` (10) + survival map assertions; suite
  257 green. Live verification on the BDS pending.
- `BEDROCK.md` action table + Farming section; `roadmap.md` status updated.

## [2026-10-03] ingest | Farming stretch: breed, tame, shear, throw_egg

- Fixed the metadata flag bits against `protocol.json` (`baby` = 11, `tamed` = 28,
  `sheared` = 31; `owner_eid` = key 5).
- `bedrock-survival.mjs`: tameable whitelist (`wolf`/`cat`/`ocelot`) + `TAME_FEED`
  (bone / raw cod).
- `bedrock-adapter.mjs`: refactored `_feedEntity` (feed a specific entity, base
  for feed/breed/tame); added `throw_egg`, `breed_<animal>`, `tame_wolf`/
  `tame_cat`, `shear_sheep`, `craft_shears`; `/observe.farmAnimals` now carries
  `sheared`; new `_nearbyTameable` census.
- Tests: `tests/bedrock-farming.test.mjs` extended (18); suite 265 green. Live
  verification on the BDS pending.

## [2026-10-03] ingest | Farming live-verified on the BDS

- Redeployed to VM 100 (`hermes-jev-bedrock`) and drove the harness HTTP API.
- ✅ `read_container` (6 chests/barrels), `mine_potatoes`/`mine_carrots` →
  `collect_drop` → `plant_potato` (re-sow, `server_world`), `throw_egg`,
  `feed_pig` (`inlove`), `breed_pig` (`babies: 1`, `baby:true`).
- ⚠️ Not tested: `attack_<animal>` (would kill a family animal), `tame_wolf`/
  `tame_cat` (no wolf/cat nearby), `shear_sheep` + `craft_shears` (no sheep).
- Note: first `feed_pig` attempt returned `feed_not_confirmed` while the pig
  wandered; a retry close-up succeeded — the action may need one retry for
  distant/wandering animals.
- `BEDROCK.md` action table and `roadmap.md` status updated.
