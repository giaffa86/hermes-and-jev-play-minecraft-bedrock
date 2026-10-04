# Trading with villagers and wandering traders

What the bot can do with traders, and how it chooses *economical* trades.
Sources: `bedrock-adapter.mjs`, `bedrock-trading.mjs`, `BEDROCK.md`
(action status + Trading section), `.private/TRADING-TASK.md`.

## Scope

The bot can buy/sell with **villagers** (`villager`/`villager_v2`) and
**wandering traders**, and — the newest part — autonomously **level a trader to
master** ("maxxing") using only cheap, non-precious inputs.

## What is implemented

| Capability | Action | Notes |
|---|---|---|
| Detect traders | — | `add_entity`/`set_entity_data` track `villager`, `villager_v2`, `wandering_trader`, `trader_llama` (`isTraderType`). Exposed in `/observe.traders` (type, position, distance, profession, trade tier). |
| Open trade | `open_trade` | Approaches, looks at the trader and sends `inventory_transaction` `item_use_on_entity` with `action_type: interact` (never `attack`). The server answers with `update_trade` + `container_open` (`trading`). |
| Read offers | — | `update_trade.offers` (network NBT) is parsed into `tradeOffers`: `buyA`/`buyB`/`sell`, `uses`/`maxUses`, `tier`. Exposed in `/observe.trade`. |
| Execute one trade | `trade_<index>` | `item_stack_request` take→cursor→place into the trading ingredient slots (`trade2_*` for the new UI, `trade_*` for the old), then takes the result; confirmed by inventory deltas. Offered only when the inputs are in the inventory. |
| Close trade | `close_trade` | Closes the window and clears the cached offers. |
| **Level a trader** | `level_<profession>` / `level_trader` | Deterministic loop: picks the cheapest available offer and repeats until `max_trade_tier` (master) or the budget runs out. |

## Leveling (maxxing)

- **Targeting**: `level_cartographer`, `level_farmer`, ... target the nearest
  trader of that profession; `level_trader` targets the nearest villager. The
  profession is verified **live** against `update_trade.display_name`
  (e.g. "Cartographer") — the metadata (`trading_career`/`mark_variant`) is only
  a best-effort hint to order candidates, so a wrong guess is corrected before
  trading. Wandering traders are never levelled (no tier progression).
- **Economy** (pure module `bedrock-trading.mjs`): each input item is classified
  as *precious* (diamond, iron, gold, netherite, lapis, ender-pearl, blaze-rod,
  emerald block, ...), *emerald* (the currency), *cheap* (paper, glass panes,
  crops, logs/planks, seeds, wool, coal, flint, ...) or *neutral* (redstone,
  sculk, copper, ...). `pickBestTrade` picks the offer with the lowest per-item
  input cost among those whose inputs are in the inventory and that still have
  uses left. The default cap (`maxCost=1`) excludes **emeralds and precious
  items**, so the loop only ever *sells* cheap/neutral items — it never wastes
  the bot's scarce emeralds or valuables.
- **Bounded progress**: each invocation makes progress and reports `tier`,
  `maxTier`, `trades`, `maxed`. It stops early with `no_economical_trade` when
  every cheap trade is exhausted (the villager must restock at its workstation)
  or the bot has no cheap materials — the controller can re-invoke later.

## Opening the trade window

The first human session of the campaign (04/10/2026) traded live — baked potatoes
and 24 paper for emeralds with a villager, water bottles with a wandering trader —
and settled what the window needs: a **plain right click at close range**, with no
sneak and nothing to "use" in hand. That is the same discriminator as mounting a
horse (see [companions](companions.md)), so `_openTradeWithEntity` now calls
`_freeHands('trade')` before each attempt (`stop_sneak`, then an empty hotbar
slot) and reports `hand` in `trade_not_opened` — a reach problem and a
hand/sneak problem are no longer the same error. The live round with the bot is
still pending (the single NetherNet port was occupied by the human session).

## Verification status

`open_trade`, offer parsing, the `trade_<index>` wire shape and the leveling loop
are covered by unit tests and packet serialization tests against protocol
1.26.51. **Live verification on the real BDS is pending**, in particular:

- the exact client→server transaction that finalises a trade (the implemented
  flow is the vanilla one: place the inputs, then take the result);
- the level-up detection via `trade_tier`/`max_trade_tier` metadata.

**Live rounds (02-03/10, packet capture)**: `open_trade` still does not open the
trade window on BDS 1.26.52. The capture (`PACKET_DEBUG=1` on the harness plus
`GET /debug/packet-debug?ms=…`, which arms the clientbound dump *before* the
interaction) shows that a `villager_v2` at 3.1-3.6 blocks receives the
interaction and the server replies with **only** a player-inventory resync
(`inventory_content`, 36 empty slots, `container_id` that prismarine labels
`anvil_input`) — never `container_open`, never `update_trade`. The three
`interact` attempts produce exactly three of those resyncs and nothing else.

Hypotheses tested live and **ruled out**:

- packet shape — `item_use_on_entity` with `action_type: interact` serializes
  cleanly against the 1.26.51 schema and is byte-identical to the live-verified
  `attack_<mob>` path except for the extra `animate swing_arm`;
- `legacy_request_id: 0` vs a non-zero request id;
- the vanilla client packet `interact { action_id: 'npc_open' }` (now sent first,
  with `item_use_on_entity` as fallback on the later attempts);
- the `item_interact` input flag (bit 34) in `player_auth_input`, sent in the
  same frame as the entity interaction;
- a sleeping villager — same failure at `night: true` and `night: false`
  (waited from ticks 23308 → 23804);
- a behaviour pack disabling trading — the server loads vanilla packs only
  (`/opt/minecraft/behavior_packs`, `vanilla_1.26.52` …).

Next diagnostics: capture the same interaction from a **real client** on this
server and compare byte by byte, test a second (freshly spawned) villager, and
check whether a `villager_v2` has offers at all for this player. When the
villager is >5 blocks away the approach `_moveTo` also stalls
(`trade_approach_failed: stuck` → `trader_unreachable`).

See [open-questions](open-questions.md) for the current gaps.

## Fixed defect (timeout)

`_tradeAt (index, { timeoutMs = 20000 })` in `bedrock-adapter.mjs` never
forwarded its `timeoutMs` to `_waitTradeResult (timeoutMs = 5000)`, so a trade
effectively waited **5 s instead of 20 s**. **Fixed (2026-10-03)**: the remaining
budget is threaded through (`await this._waitTradeResult(Math.max(500, started +
timeoutMs - Date.now()))`), covered by a unit test that records the forwarded
budget, and the pi-lens “declared but never used” warning is gone. The live
transaction round is still pending.
