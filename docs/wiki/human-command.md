# Human chat command channel (roadmap)

Topic: let a human player on the same BDS command the bot **live via in-game
chat**, in natural language, as if talking to Hermes — e.g. *"@bot seguimi,
andiamo a cercare ferro"* or *"@bot aiutami a liberare la miniera dai mob"*.

Status: **design / roadmap** — not implemented yet. This page records the plan so
a future agent can build it without re-deriving the analysis.

## Why this fits the existing architecture

The controller already converts a natural-language goal into a plan through
Hermes (`hermes chat -Q --oneshot -q <prompt>`, see
[overview](overview.md) and `controller.mjs`). The current `GOAL` env var is
natural language today. A chat message is therefore **not a new decision
mechanism, only a new input channel to the same planner**:

```
human chat message
  → capture + allowlist + sender position
  → Hermes prompt (message + current /observe state + human position)
  → plan { objective, follow:<xuid>, waypoint, targets }
  → POST /plan (same route that exists today)
  → Jev picks bounded actions via /options + /act (unchanged)
```

## Current state

| Capability | Status | Notes |
|---|---|---|
| Receive chat | **Exists, unused** | The bot receives packet `text` (id 9) with `source_name`, `type` (`chat`/`whisper`/`system`/…), `message` and **`xuid`**. No handler consumes it: only the generic logger behind `BEDROCK_PACKET_LOG` (`bedrock-adapter.mjs`, the `client.on('packet', …)` guard). |
| Link chat sender → entity | **Missing** | `add_player` carries `username`, but `_trackEntity` keeps only `uniqueId`/uuid; the gamertag is dropped. Needed to answer "who is speaking" and "where are they". |
| Follow a human | **Missing** | Player positions are already tracked (`add_player` → `_trackEntity(packet,'player')`, `move_entity`/`move_entity_delta` → `_onEntityMove`, exposed in `_nearbyEntities`). There is only a static `goto_waypoint` (via `_moveTo`); no dynamic follow action. |
| Combat assist ("help me fight mobs") | **Mostly ready** | `_hostiles()` detection, `attack_<type>` options, `_selectWeapon()`, `flee`, health/hunger awareness already exist. The human order only needs to *bias* the objective toward "stay near the human and fight". |
| Mine iron the bot can see | **Ready** | `mine_iron_ore` / `mine_deepslate_iron_ore` options and the "obtain iron" progression skill already exist. |
| Autonomous exploration ("go find iron alone") | **Missing / hard** | No real exploration: see [headless-client](headless-client.md#8-render-distance-not-comparable) and [open-questions](open-questions.md). "Follow me and mine the iron you see" is realistic; "go find iron by yourself" is out of reach for now. |
| Reply/ack in chat | **Missing** | The bot never writes a `text` packet (or `command_request`, id 77). Optional, not required to obey. |

## Target flow

1. `client.on('text', …)` in `bedrock-adapter.mjs` → filter out own/system
   messages, keep `chat`/`whisper`, append to a bounded `chatInbox`
   (`{from, message, type, xuid, at}`).
2. Expose `chat` in `observe()` (and optionally a `GET /chat` route in
   `bedrock-harness.mjs`).
3. In `controller.mjs`, before the normal decision step, check the newest
   human message. If it matches the trigger and the sender's `xuid` is in the
   allowlist, build a Hermes prompt (message + compact state + sender's live
   position) and `POST /plan` with **priority over the autonomous plan** until
   completed or superseded.
4. Jev executes exactly as today: bounded keys from `/options`, executed by
   `/act`.

## Safety

- **Allowlist by `xuid` is mandatory**: otherwise any player on the server can
  telecommand the bot. `xuid` is stable across gamertag changes and is already
  present in the `text` packet.
- Route human orders through the **same bounded-action API**. Validity stays
  owned by the harness (`options()`), so existing protections remain active:
  a human cannot order the bot to break a protected block (`DIG_PROTECTED`),
  attack a villager, or do anything not offered as a valid key. NL commands add
  *intent*, never raw capability.
- Trigger syntax must be defined (see open questions below) to avoid reacting to
  ordinary conversation.

## Milestones

- **M1 — capture & identify**: `text` listener + `chatInbox` + `chat` in
  `observe()` + allowlist (`BEDROCK_CHAT_ALLOWLIST` or `.env`) + capture
  `username` from `add_player`/`player_list` into the entity record.
- **M2 — follow**: a `follow_player` action that re-reads the target player's
  live position each cycle and calls `_moveTo` in a loop (distance/timeout to be
  defined).
- **M3 — NL orders**: controller reads a `@bot` message → Hermes → `/plan`.
  First working commands: *"seguimi"* and *"aiutami coi mob"* (combat is already
  ready).
- **M4 — assist mining**: *"seguimi e mina il ferro che vedi"* — follow + mine
  iron the bot detects along the way (realistic given the short-range radar).
- **M5 — stretch**: ack/reply in chat (`client.write('text', …)`); autonomous
  exploration heuristic (out of scope for now).

## Open questions to settle before/while implementing

- **Trigger**: mention `@bot`, prefix `!bot`, or both? Public chat, whisper, or
  both? (Whisper is cleaner for targeted orders.)
- **Follow semantics**: follow distance, timeout, and when the bot gives up
  (lost sight, too far, target left).
- **Priority vs autonomous plan**: how a human order overrides, and how/when the
  bot returns to its autonomous goal.
- **Acknowledgement**: with no chat reply, how does the human know the order was
  received and accepted (e.g. a `/plan` log entry vs an in-game reply).

## Sources

- `bedrock-adapter.mjs` — `text` packet (id 9) reachable via
  `client.on('text', …)`; `_trackEntity`/`_onEntityMove`/`_nearbyEntities`
  (player tracking); `_hostiles`/`_selectWeapon`/`attack_*` (combat);
  `_moveTo`/`goto_waypoint` (movement primitive); `DIG_PROTECTED`.
- `bedrock-harness.mjs` — `/observe`, `/options`, `/act`, `/plan` routes.
- `controller.mjs` — Hermes natural-language planning (`runHermes`).
- `minecraft-data` `bedrock/1.26.51/protocol.json` — `packet_text` fields
  (`source_name`, `type`, `message`, `xuid`, …); `packet_add_player` (`username`).
- Related wiki: [overview](overview.md), [headless-client](headless-client.md),
  [open-questions](open-questions.md).
