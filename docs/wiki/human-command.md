# Human chat command channel (roadmap)

Topic: let a human player on the same BDS command the bot **live via in-game
chat**, in natural language, as if talking to Hermes — e.g. *"@bot seguimi,
andiamo a cercare ferro"* or *"@bot aiutami a liberare la miniera dai mob"*.

Status: **M1–M3 implemented, not verified live**. M4 works indirectly (follow +
existing `mine_*`), M5 not done. This page records both the plan and what has
been wired so far.

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
| Receive chat | **Implemented (M1)** | `_onChat` on `client.on('text')` keeps only `chat`/`whisper`/`json_whisper`, skips own/system messages, appends `{from, message, type, xuid, at}` to a bounded `chatInbox` (cap 32), exposed as `chat` in `observe()`. |
| Link chat sender → entity | **Implemented (M1)** | `_trackEntity` now stores `username` from `add_player` and indexes `_playersByName` (gamertag → runtimeId); `_nearbyEntities` exposes `username`. |
| Follow a human | **Implemented (M2)** | `follow_player` option (offered when `plan.follow` is set and the player is tracked, ~64-block range) + `_followPlayer()` loop over `_moveTo` (stop distance 3, 45 s window). |
| Combat assist ("help me fight mobs") | **Mostly ready** | `_hostiles()` detection, `attack_<type>` options, `_selectWeapon()`, `flee`, health/hunger awareness already exist. The human order only needs to *bias* the objective toward "stay near the human and fight". |
| Mine iron the bot can see | **Ready** | `mine_iron_ore` / `mine_deepslate_iron_ore` options and the "obtain iron" progression skill already exist. |
| Autonomous exploration ("go find iron alone") | **Missing / hard** | No real exploration: see [headless-client](headless-client.md#8-render-distance-not-comparable) and [open-questions](open-questions.md). "Follow me and mine the iron you see" is realistic; "go find iron by yourself" is out of reach for now. |
| Reply/ack in chat | **Missing (M5)** | The bot never writes a `text` packet (or `command_request`, id 77). Optional, not required to obey. |

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

- **M1 — capture & identify** ✅ `text` listener + `chatInbox` + `chat` in
  `observe()` + `username` captured into the entity record.
- **M2 — follow** ✅ `follow_player` action (loop over `_moveTo`).
- **M3 — NL orders** ✅ controller reads a `@bot` message (allowlist-gated) →
  Hermes → `/plan` with priority over the autonomous plan.
- **M4 — assist mining** ◑ works indirectly: *"seguimi e mina il ferro che
  vedi"* = `follow_player` + the existing `mine_iron_ore`/`mine_deepslate_iron_ore`
  options. No dedicated skill yet.
- **M5 — stretch** ❌ ack/reply in chat (`client.write('text', …)`); autonomous
  exploration heuristic (out of scope for now).

### Implemented wiring (M1–M3)

- `bedrock-adapter.mjs`: `_onChat` + `chatInbox`; `chat` in `observe()`;
  `username` in `_trackEntity`/`_nearbyEntities`; `_playerByName`; `follow_player`
  option and `_followPlayer` action.
- `controller.mjs`: `CHAT_ALLOWLIST` (gamertag/xuid, comma-separated),
  `CHAT_PREFIX` (default `@bot`), `CHAT_CONTROL` (default `on` when allowlist is
  set); `maybeHumanCommand`/`humanCommandPlan`/`isAllowedSender`; follow plans are
  open-ended (`goalMet` returns false when `plan.follow` is set).
- `controller-decisions.mjs`: `follow_player` ranked at tier 2 (just below drop
  pickup).
- Tests: `node --test tests/*.test.mjs` green; added a `follow_player` priority
  case in `tests/controller-decisions.test.mjs`.
- **Live verification pending**: the path is syntax-checked and unit-tested but
  not yet run on the BDS with a real human player.

## Open questions

- **Trigger**: settled to `CHAT_PREFIX` (default `@bot`), matched on both public
  chat and whisper. Still open: require whisper only?
- **Follow semantics**: settled to stop distance 3, 45 s window, ~64-block
  tracking range. Still open: long escort and behaviour on player disconnect.
- **Priority vs autonomous plan**: settled to "human order overrides until
  superseded or budget end". Still open: an explicit "resume autonomy" command.
- **Acknowledgement**: still open (M5) — with no chat reply, how does the human
  know the order was received (e.g. a log entry vs an in-game reply).

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
