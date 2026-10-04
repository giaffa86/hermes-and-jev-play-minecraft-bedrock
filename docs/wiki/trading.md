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
hand/sneak problem are no longer the same error. The live round with the bot did
run on 04/10 (the human session had ended): the packet the bot sends is now
**proven accepted** on this server (a pig takes damage from the same
transaction), but the villager window still does not open — the full list of what
is ruled out is in §"Verification status".

## Verification status

`open_trade`, offer parsing, the `trade_<index>` wire shape and the leveling loop
are covered by unit tests and packet serialization tests against protocol
1.26.51. **Live verification on the real BDS is pending**, in particular:

- the exact client→server transaction that finalises a trade (the implemented
  flow is the vanilla one: place the inputs, then take the result);
- the level-up detection via `trade_tier`/`max_trade_tier` metadata.

**Live rounds (02-04/10, on the real BDS)**: the trade window does not open. The
campaign's first reading — "the server rejects every entity transaction" — was
**wrong**, and the 04/10 probe falsified it:

- `POST /debug/probe-interact` with `action:"attack"` against a pig reports
  `healthBefore:10 → healthAfter:9`, **`damage:1`** (an empty-handed punch), at
  4.0 blocks with `sightline:["air","air","air"]` and a successful
  `approach (12.41 -> 4.0)`. The standalone
  `inventory_transaction {transaction_type:'item_use_on_entity'}` **is accepted
  and applies damage**;
- the `inventory_content` resync is therefore **not** a refusal signal: the
  accepted attack produced 8, a refused villager interaction 0, and the `none`
  baseline (no packet at all) 0;
- the same transaction with `action:"interact"` on an unobstructed adult farmer
  (`sightline:["air","air","air"]`, day, no sneak, free hand) produces **no
  `update_trade` and no `container_open`** at 1.6, 2.1, 2.8 and 4.0 blocks.

Hypotheses tested live and **ruled out**: the packet shape (41 bytes, identical
to the working attack but for `action_type`); `legacy_request_id: 0` vs non-zero;
`legacy` present/absent/empty list; `hotbar_slot` and the selected slot (the
`oak_planks` in slot 0 matches the server, proven with `craft_oak_planks`);
`held_item` empty vs an item in hand; `player_pos` (it already is the eye
position — `_lookAt` documents that `this.position` is at eye height);
`item_interact` (bit 34) before/after the frame; `animate swing_arm`;
`interact {mouse_over_entity}` before the transaction; the sleeping-villager
theory (same failure in day and night, ticks 10851 and 18695); behaviour packs
(vanilla only); the vanilla `npc_open` packet; **baby villagers** (every nearby
farmer reports `baby:false`).

The reference implementation `mineflayer-for-bedrock` is **not** a valid
comparison here: it sends `transaction_type: 3` (numeric), which the 1.26.51
protodef `switch` cannot resolve — it serializes to 5 bytes instead of 41 and
disconnects the client.

**What the bot does get right (and did not before 04/10)**: `_entityVisible`
samples the eye→aim line and refuses a villager **inside a building** with
`trade_target_blocked { blockedBy: 'oak_planks' | 'cobblestone' | 'wooden_door',
distance }` instead of burning three attempts; a villager that escapes past 5
blocks is `trader_moved_away`; and every attempt re-checks reach and sight
because villagers **walk** (in one round the nearest trader changed identity
three times and its distance went 2.1 → 5.1 blocks during the 12 s of the three
attempts).

**Blocker**: the missing piece is the packet/state a **real client** uses to open
the window on this build. The game channel is DTLS, so the packet capture of the
human session (`/tmp/mc-client2.pcap` on CT 108) carries only sizes and timing,
no game packets; `POST /debug/probe-interact` stays available for a capture made
with `PACKET_DEBUG=1`.

See [open-questions](open-questions.md) for the current gaps.

## Fixed defect (timeout)

`_tradeAt (index, { timeoutMs = 20000 })` in `bedrock-adapter.mjs` never
forwarded its `timeoutMs` to `_waitTradeResult (timeoutMs = 5000)`, so a trade
effectively waited **5 s instead of 20 s**. **Fixed (2026-10-03)**: the remaining
budget is threaded through (`await this._waitTradeResult(Math.max(500, started +
timeoutMs - Date.now()))`), covered by a unit test that records the forwarded
budget, and the pi-lens “declared but never used” warning is gone. The live
transaction round is still pending.
