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

## Verification status

`open_trade`, offer parsing, the `trade_<index>` wire shape and the leveling loop
are covered by unit tests and packet serialization tests against protocol
1.26.51. **Live verification on the real BDS is pending**, in particular:

- the exact client→server transaction that finalises a trade (the implemented
  flow is the vanilla one: place the inputs, then take the result);
- the level-up detection via `trade_tier`/`max_trade_tier` metadata.

**First live attempt (2026-10-02)**: `open_trade` does not open the trade window
on BDS 1.26.52. With a `villager_v2` at ~1.9 blocks the `interact`
(`item_use_on_entity`, `action_type: interact`) was sent 3× (confirmed in the
container log), but the server sent **no** `update_trade` and **no**
`container_open(trading)` back (only routine player `inventory_content`).
Result: `trade_not_opened`. When the villager is >5 blocks the approach
`_moveTo` also stalls (`trade_approach_failed: stuck` → `trader_unreachable`).
Root cause not isolated — candidates: an empty-hand `held_item` the server
ignores, a villager-state requirement (moving/panic), or a trading-UI flow
difference in BDS 1.26.52 vs the bedrockflayer reference. Needs protocol-level
capture (compare against a real client or gophertunnel).

See [open-questions](open-questions.md) for the current gaps.

## Known defect (timeout)

`_tradeAt (index, { timeoutMs = 20000 })` in `bedrock-adapter.mjs` never forwards
its `timeoutMs` to `_waitTradeResult (timeoutMs = 5000)`, so a trade effectively
waits **5 s instead of 20 s**. Left unfixed on purpose: it changes the timing of
an area whose live handshake is still unverified, and the fix should be threaded
through during that live round and observed. Tracked in
[open-questions](open-questions.md#known-code-defects-not-fixed).
