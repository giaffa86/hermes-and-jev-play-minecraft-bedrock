# Human chat command channel (roadmap)

Topic: let a human player on the same BDS command the bot **live via in-game
chat**, in natural language, as if talking to Hermes — e.g. *"@bot seguimi,
andiamo a cercare ferro"* or *"@bot aiutami a liberare la miniera dai mob"*.

Status: **M1–M3 implemented, not verified live**. M4 works indirectly (follow +
existing `mine_*`). M5 is now half-done: the bot can speak (`POST /say`) and uses
it to **greet a nearby human proactively**, telling them the exact order syntax
(the deterministic slice of §6 *Attention System* in the AI-player roadmap).
This page records both the plan and what has been wired so far.

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
| Reply/ack in chat | **Implemented (M5, not wired to orders)** | `sendChat()` in `bedrock-adapter.mjs` queues a `text`/`chat` packet (rate-limited, sanitised); exposed as `POST /say`. Used today for the proactive greeting, not yet to ack a specific order. |
| Proactive greeting / syntax hint | **Implemented** | `maybeGreetHumans()` in `controller.mjs`: a trusted human within `CHAT_GREET_RANGE` (default 24 blocks) gets one greeting naming the exact syntax `CHAT_PREFIX <ordine>`, with a per-gamertag cooldown. Suppressed when the allowlist is empty (never advertise a closed channel). |

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
- **M5 — stretch** ◑ the bot can speak: `sendChat()` (`client.queue('text', …)`)
  + `POST /say`, used for the proactive greeting. Acking a specific order and the
  autonomous exploration heuristic are still open.

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

## Proactive greeting (§6 Attention System)

A human should not have to guess how to command the bot. When the bot perceives a
nearby human it says hello and spells out the syntax:

```text
Ciao <nome>! Sono Hermes, il bot di casa. Assegnami un task scrivendo in chat:
@bot <ordine> — per esempio "@bot seguimi" oppure "@bot mina ferro".
```

- **Perception**: `observe().humans` — human players within `HUMAN_RANGE`
  (default 32 blocks), bot excluded, distance-sorted. It is a **separate** list
  from `entities` because that one is capped at 8 rows: with a mob crowd around
  the bot a nearby human would drop out and never be greeted.
- **Policy (pure)**: `human-greeting.mjs` — `planGreetings()` maps
  `humans` + allowlist + already-greeted state to the messages to send *this
  step*. Only allowlisted gamertags qualify, so the greeting is never sent to a
  stranger; an empty allowlist yields no greeting at all.
- **Speech**: `sendChat()` queues a `text`/`chat` packet (`client.queue`), used
  by `POST /say {message, type?}`. Guards: requires `status === 'spawned'`,
  strips newlines, rejects empty/oversized messages (256 chars) and enforces a
  1 s minimum interval between bot messages.
- **Loop**: `controller.mjs` calls `maybeGreetHumans(obs)` both in the goal loop
  and in the `IDLE` loop, before the human-command check. It only attempts a
  greeting when `obs.spawned` is true, and marks the attempt immediately, so a
  transient failure waits for the cooldown instead of spamming.
- **Env**: `CHAT_GREET` (default: on when `CHAT_CONTROL` is not `off` and the
  allowlist is set), `CHAT_GREET_RANGE` (24), `CHAT_GREET_COOLDOWN_MS`
  (600000; `0` = once per session), `CHAT_GREET_TEMPLATE` (placeholders `{name}`,
  `{prefix}`).
- Tests: `tests/human-greeting.test.mjs` — policy (`renderGreeting`,
  allowlist/range/cooldown filters, malformed humans) plus the adapter wire
  (`observe().humans`, the serialised `text` packet, the `sendChat` guards).

**Note**: the wire format was validated against protocol 1.26.51; the greeting is
sent on the public `chat` channel, and `type` can be overridden to `whisper` if a
quieter hello is preferred (still an open question).

## Open questions

- **Trigger**: settled to `CHAT_PREFIX` (default `@bot`), matched on both public
  chat and whisper. Still open: require whisper only?
- **Follow semantics**: settled to stop distance 3, 45 s window, ~64-block
  tracking range. Still open: long escort and behaviour on player disconnect.
- **Priority vs autonomous plan**: settled to "human order overrides until
  superseded or budget end". Still open: an explicit "resume autonomy" command.
- **Acknowledgement**: partially addressed — the bot can now speak (`POST /say`)
  and greets a nearby human with the order syntax, but it still does **not** ack a
  specific order ("received, on my way"). Still open.
- **Greeting vs order**: open — should the greeting be a whisper (`type: whisper`)
  instead of public chat, and should it be skipped while the bot is in
  `emergency` (being attacked) to avoid noise?

## Sources

- `bedrock-adapter.mjs` — `text` packet (id 9) reachable via
  `client.on('text', …)`; `_trackEntity`/`_onEntityMove`/`_nearbyEntities`
  (player tracking); `_hostiles`/`_selectWeapon`/`attack_*` (combat);
  `_moveTo`/`goto_waypoint` (movement primitive); `DIG_PROTECTED`.
- `bedrock-harness.mjs` — `/observe`, `/options`, `/act`, `/plan`, `/say` routes.
- `human-greeting.mjs` — pure greeting policy (`planGreetings`, `renderGreeting`).
- `controller.mjs` — Hermes natural-language planning (`runHermes`);
  `maybeGreetHumans` (proactive greeting).
- `minecraft-data` `bedrock/1.26.51/protocol.json` — `packet_text` fields
  (`source_name`, `type`, `message`, `xuid`, …); `packet_add_player` (`username`).
- Related wiki: [overview](overview.md), [headless-client](headless-client.md),
  [open-questions](open-questions.md).
