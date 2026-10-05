# Human chat command channel (roadmap)

Topic: let a human player on the same BDS command the bot **live via in-game
chat**, in natural language, as if talking to Hermes — e.g. *"@bot seguimi,
andiamo a cercare ferro"* or *"@bot aiutami a liberare la miniera dai mob"*.

Status: **M1–M5 implemented and verified live with a real human sender**
(2026-10-04: the human's `@bot …` order moved the bot, ack and outcome landed in
chat). The met contract of an order with an empty plan was fixed on 2026-10-05
(see *The met contract of a chat order* below). The live containers carry the
branch `wip-live-20261005` at `f3c8d46`.

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
| Reply/ack in chat | **Implemented + live-verified (M5)** | `sendChat()` in `bedrock-adapter.mjs` queues a `text`/`chat` packet (rate-limited, sanitised); exposed as `POST /say`. The controller acks an accepted order (`@<name> ok: <obiettivo>`) and reports the outcome when the goal closes (`@<name> fatto: … (N azioni)` / `non ce l'ho fatta: …` / `mi fermo qui: …`). |
| Proactive greeting / syntax hint | **Implemented** | `maybeGreetHumans()` in `controller.mjs`: a trusted human within `CHAT_GREET_RANGE` (default 24 blocks) gets one greeting naming the exact syntax (`CHAT_PREFIXES`, rendered as `@bot o @hermes <ordine>` when several triggers are configured), with a per-gamertag cooldown. Suppressed when the allowlist is empty (never advertise a closed channel). |

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
- **M5 — stretch** ✅ the bot speaks (`sendChat()` + `POST /say`) and now uses it
  for the order lifecycle: proactive greeting, **ack of an accepted order**, and
  the **outcome** when the goal closes (`human-replies.mjs`).
- **M6 — questions** ✅ a `@bot <domanda>` message that asks about the bot is
  answered from `observe()` instead of being turned into a goal: regex fast path,
  then System One (Jev) over a closed intent list (`human-questions.mjs`,
  `chat-intent.mjs`, `system-one.mjs`).
- **M6.1 — a router failure is not an order** ✅ the question guard
  (`looksLikeQuestion`) and the Jev pre-filter: an order never pays a model call
  before its ack, and a question-shaped message the router cannot decide is
  refused instead of becoming `follow <sender>`.
- **M6.2 — call the bot by name** ✅ the bot also answers to its own name:
  `@<BEDROCK_USERNAME>` and the gamertag the server attributes to it
  (`observe().self`, learned from the chat echo), composed per observation by
  `chatPrefixes(obs)`; `CHAT_SELF_NAME=off` disables them.
- **M6.3 — worn armor is a fact, equipping is an order** ✅ questions about
  *what the bot is wearing* (`q_armor`) are answered from `observe().armor` —
  worn, not carried — a question that names an item is answered about that item,
  and an equip order (`equipaggiati con l'elmetto`, `mettiti l'armatura in
  bronzo`) is planned **deterministically** (`need: 'wear_armor'`, no Hermes
  call) and closed by the `equip_armor` intents; with nothing to wear the bot
  says so and the goal fails with `no_armor_in_inventory` instead of wandering
  off.

## Live evidence (2026-10-03, BDS 1.26.52 via CT 108, VM 100 container)

Chain observed end to end with `SESSION=1`, `CHAT_ALLOWLIST=<bot account>`:

1. `POST /say {"message":"@bot fermati e resta qui"}` → `{ok:true}`; the message
   travels to the real server and comes back as a chat packet.
2. `controller.jsonl`: `chat_command {from, xuid, message:"fermati e resta qui"}`
   → `plan_fallback` (Hermes is not installed in the container, so the static
   fallback `follow <sender>` is used; `ms: 6`).
3. `chat_reply {context:"ack", ok:true}` — the ack `@<name> ok: Follow <name> and
   obey their last order: "fermati e resta qui" — arrivo da <name>` re-appeared in
   `GET /observe.chat` as a **new** entry (`at` 1790984628387), i.e. the reply was
   really delivered to the server and broadcast back.
4. `human_order {via:"idle"}` → `goal_start {source:"chat", priority:80}` →
   `goal_end {status:"completed"}` → `chat_reply {context:"outcome", message:
   "@<name> fatto: … (0 azioni)"}` (that one `rate_limited`: see below).

### Two defects found by the live round

- **Self-echo.** The server sends the sender's own chat back with the *real
gamertag*, which is **not** `BEDROCK_USERNAME` (that is the authentication name:
live they differed, 10 vs 8 characters). The old filter compared names, so the
bot heard itself; with its gamertag in `CHAT_ALLOWLIST` it ordered *itself*
(observed live: goals `g2`, `g3`, `g4` from its own messages). Fixed in
`bedrock-adapter.mjs`: `_isOwnChatEcho()` matches the text of the last messages
sent within `CHAT_ECHO_WINDOW_MS` (default 15000), logs `chat_echo`, and learns
the server-reported name (`selfName`, event `self_name_learned`) so that
`isSelfName()` also protects chat and the human-player list. Verified live after
the fix: `POST /say` → harness log `chat_echo: 1`, `[chat]: 0`, `chatInbox` size
0, and **no** `chat_command`/`chat_reply` in the controller log.
- **Stale orders replayed after a restart.** The harness inbox keeps the last 32
messages, so a restarted controller re-executed orders it had already served
(observed live: the same message produced three distinct goals). Fixed in
`controller.mjs` with `CHAT_MAX_AGE_MS` (default 300000, fail-open when `at` is
missing) and a `chat_stale` event; the rejection telemetry is also emitted once
per message instead of once per poll (live: 122 identical `chat_ignored` events
in 25 s → now 1).

### The met contract of a chat order (2026-10-05)

An order whose plan declares **no terminal criterion** — no `targets`, no
`waypoint`, no `follow`, no `need`, no `skill` — used to be "met" at step 0: the
order *"eat the potatoes you have"* (`g21`) closed with
`GOAL MET after 0 actions`, the bot never ate and the human still got the
`fatto:` line. `goalMet` treats an empty target map as vacuously satisfied
(`Object.entries({}).every(...)`), which is right for a plan that has some other
criterion and wrong for a plan that has none.

The met check in `controller.mjs` now refuses to close a **human order** built on
an empty plan until at least one action has **succeeded**
(`(!humanOrder || !openPlan || hasWorked) && goalMet(...)`); an order that never
succeeds ends on the step budget (`budget_exhausted`) instead of a fake success.
Covered by `tests/controller-chat-open-plan.test.mjs` (order taken from IDLE and
mid-goal).

### Limits

- `POST /say` is rate-limited by the adapter (`CHAT_MIN_INTERVAL_MS`, default
  1000): back-to-back orders can produce `chat_reply {ok:false,
  error:rate_limited}`. The ack/outcome is best-effort and never blocks the goal.
- A **human** sender is still untested: no human player connects to the BDS
  during autonomous runs (open question), so the live run used a real client
  account as sender.
- Replies are one-line and truncated to `CHAT_REPLY_MAX_LENGTH` (default 180).

### Implemented wiring (M1–M3)

- `bedrock-adapter.mjs`: `_onChat` + `chatInbox`; `chat` in `observe()`;
  `username` in `_trackEntity`/`_nearbyEntities`; `_playerByName`; `follow_player`
  option and `_followPlayer` action.
- `controller.mjs`: `CHAT_ALLOWLIST` (gamertag/xuid, comma-separated),
  `CHAT_PREFIXES` (comma/space-separated list of triggers, e.g.
  `@bot,@hermes`) plus the legacy single `CHAT_PREFIX` (default `@bot`; the two
  are summed), `CHAT_CONTROL` (default `on` when allowlist is
  set), `CHAT_REPLY` (default: on when the channel is open),
  `CHAT_REPLY_MAX_LENGTH` (180), `CHAT_MAX_AGE_MS` (300000) ;
  `maybeHumanCommand`/`humanCommandPlan`/`isAllowedSender`/`replyChat`; follow
  plans are open-ended (`goalMet` returns false when `plan.follow` is set).
- `human-replies.mjs`: pure rendering of the ack/outcome lines (`orderAck`,
  `orderOutcome`, `renderReply`, `clampMessage`, `isSelfTriggering`) plus the
  trigger matching (`normalizePrefixes`, `matchChatPrefix`,
  `DEFAULT_CHAT_PREFIX = '@bot'`).
- `bedrock-adapter.mjs`: `sendChat`, `_isOwnChatEcho` / `isSelfName`
  (`CHAT_ECHO_WINDOW_MS`, default 15000).
- `controller-decisions.mjs`: `follow_player` ranked at tier 2 (just below drop
  pickup).
- Tests: `node --test tests/*.test.mjs` green; added a `follow_player` priority
  case in `tests/controller-decisions.test.mjs`.
- **Live verification pending**: the inbound path with a **human** sender is not
yet run on the BDS (no human player connects during autonomous runs); the M5
reply lifecycle *is* live-verified, see *Live evidence* above.

## Several triggers per bot (multi-trigger)

One bot may answer to more than one trigger: the generic `@bot` **plus** its own
name (e.g. `@hermes`). This is the prerequisite for running several bots on the
same server — each bot then needs its **own distinct** trigger, otherwise two
bots accept the same order.

- **Config**: `CHAT_PREFIXES` (comma or space separated, e.g.
  `@bot,@hermes`); the legacy single `CHAT_PREFIX` is still read and summed
  into the list, and `@bot` is the default when nothing is set.
- **Matching (pure)**: `human-replies.mjs` — `normalizePrefixes(value,
  {fallback})` (trim + lowercase + dedupe, order preserved) and
  `matchChatPrefix(message, prefixes)` → `{prefix, rest}` or `null`. The
  **longest** trigger wins, so `@bot1` is not `@bot`; a message starting with an
  unconfigured prefix is not an order; the rest of the message is the order text
  (an empty rest is not an order either).
- **Safety**: the bot's own replies are checked against **all** configured
  triggers (`isSelfTriggering(message, CHAT_PREFIXES)`), so a reply can never
  trigger itself or another bot — as important with a list as it was with one
  prefix.
- **Telemetry**: the `chat_command` event carries `{from, xuid, prefix, message}`
  (the matched trigger included) and `chat_greet` carries `prefixes`, so the run
  log shows which trigger fired.
- **Greeting**: the syntax hint lists every trigger: with
  `CHAT_PREFIXES=@bot,@hermes` the message reads `@bot o @hermes <ordine>`
  (`{prefixes}` in `CHAT_GREET_TEMPLATE`; `formatPrefixes` joins with ` o `).
  Note: `renderGreeting` re-parses the value, so pass an array or a CSV list —
  never a string already joined by `formatPrefixes`.
- **Tests**: `tests/human-replies.test.mjs` (normalisation, longest-wins,
  multi-trigger `isSelfTriggering`), `tests/human-greeting.test.mjs` (rendered
  syntax list) and `tests/controller-chat-ack.test.mjs` (an order sent with the
  second trigger is acked and the prefix is stripped; a message with an
  unconfigured prefix is ignored, no reply and no `chat_command`).

### Calling the bot by name (M6.2)

`CHAT_PREFIXES` is **static** (it comes from the environment), but the most
natural way to address a bot is its **name** — and with several bots on one
server the name is the only trigger that cannot collide by configuration. The
harness now says who the bot is: `observe().self` carries `username`
(`BEDROCK_USERNAME`, known at startup) and `name` (the gamertag the server
attributes to the bot, learned from the chat echo in `selfName` — live it
differed from the username, 8 vs 10 characters, so both are kept).

- **Composition**: `chatPrefixes(obs)` in `controller.mjs` = `CHAT_PREFIXES`
  **plus** `selfPrefixes(observe().self)` (`human-replies.mjs`: `@` + lowercased
  name, stripped of any leading `@`, deduped). Nothing to configure: the list is
  rebuilt on every observation, so the learned gamertag starts working as soon as
  the server reveals it.
- **Everywhere the triggers are used**: order matching (`matchChatPrefix`), the
  question path (`answerIntent`), the refusal (`renderUnrouted`), the reply
  guard (`isSelfTriggering`) and the greeting syntax hint (`{prefixes}`) all take
  the same composed list, so a reply can never trigger the bot through its own
  name either.
- **`CHAT_SELF_NAME=off`** disables the name triggers and leaves only
  `CHAT_PREFIXES` (useful when a name is also a common word, or when a human
  named like the bot is in the allowlist).
- **Caveat with several bots**: matching is `startsWith` with the **longest**
  trigger first, so triggers must not be prefixes of each other — a bot called
  `@hermes` would also accept `@hermes2 ...`. Prefer clearly distinct names (or
  distinct `CHAT_PREFIXES`).
- **Tests**: `tests/human-replies.test.mjs` (`selfPrefixes`: username + learned
  name, dedupe, doubled `@` not doubled, blank entries, `enabled: false`) and
  `tests/controller-chat-ack.test.mjs` (an order with `@<BEDROCK_USERNAME>` or
  with the learned gamertag is acked and `chat_command.prefix` is the name, not
  `@bot`; `CHAT_SELF_NAME=off` leaves the message an ordinary chat line).

## Chat questions (M6): a router picks the intent, the facts write the answer

A human will ask *"dove sei?"*, not only give orders. Such a message is not an
order, and answering it with `follow <sender>` (the old fallback) was worse than
answering nothing. M6 inserts a question path **before** the order path:

- **Fast path (free, offline)**: `human-questions.mjs` holds a catalogue of
  seven intents (`q_position`, `q_health`, `q_activity`, `q_inventory`, `q_time`,
  `q_identity`, `q_armor`), each with a regex. A message that matches is answered
  without any model call.
- **Router (System One = Jev)**: a message that matches nothing is classified by
  the decisions endpoint over a **closed option list** — the seven intents plus
  the sentinel `q_none`. The model picks an option; it never writes the answer.
  `chat-intent.mjs` asks, `system-one.mjs` is the transport shared with the
  action decision (`jevDecide`).
- **The answer is composed from `observe()`** by `answerIntent(...)`: position,
  health/food, the current objective, the inventory, the clock
  (`clockFromTicks`, Bedrock tick 0 = 06:00), the accepted triggers. A missing
  fact is *admitted* ("non lo so: …"), never invented.
- **`q_none` means "not a question"**: an order, a greeting or small talk keeps
  today's behaviour (ack + goal). A router *failure*, though, is not a verdict:
  M6.1 (below) made it a refusal, never a goal.
- **No goal is created** by a question, and the reply is the same one-line
  `POST /say` path (`context: 'question'`), rendered from
  `DEFAULT_ANSWER_TEMPLATE = '@{name} {answer}'`.
- **Config**: `CHAT_INTENT` (default `on` when `TYPESAFE_API_KEY` or
  `OPENROUTER_API_KEY` is set, else `off`), `CHAT_INTENT_MODEL`,
  `CHAT_INTENT_URL` (e.g. a local Jev-compatible endpoint),
  `CHAT_INTENT_TIMEOUT_MS` (4000) and `CHAT_INTENT_MIN_P` (0.4; probabilities are
  uncalibrated — they rank options, they do not measure confidence).
- **Telemetry**: `chat_intent` (every Jev decision: `intent`, `chosen`,
  `probability`, `model`, `ms`, `cost`, `reason`, `error`) and `chat_question`
  (the answer actually served: `intent`, `via` = `regex`|`jev`, `probability`).
- **Tests**: `tests/human-questions.test.mjs` (regex catalogue, answer bodies and
  the missing-fact policy, `intentFromChoice`), `tests/chat-intent.test.mjs`
  (routing over a stubbed endpoint: threshold, `q_none`, out-of-range choice,
  transport errors) and `tests/controller-chat-ack.test.mjs` (a regex question is
  answered and creates no goal; a free-form question is routed by System One and
  still answered from the facts).

### M6.1 — a router failure is not an order

M6 failed **open**: with `@bot quanti cuori hai?` and an unreachable Jev the
message fell through to the order path and became the static `follow <sender>`
fallback — a failure moving the bot (that phrase is answered offline by the
`q_health` fast path since M6.3, so the live probe uses a question no regex
covers, e.g. `chi mi sta guardando?`). M6.1 closes that boundary:

- **Question guard (pure, on the raw text)**: `looksLikeQuestion` in
  `human-questions.mjs` fires on an explicit `?`/`¿` or on an interrogative
  **first** word (`chi`, `che`, `cosa`, `come`, `dove`, `quando`,
  `quanto`/`quanta`/`quanti`/`quante`, `perché`, `quale`/`quali`, and the English
  set). It is deliberately conservative — bare verbs are excluded, so `stai qui`
  and `sei un cretino` stay orders — and evaluates the *raw* message, because
  `normalizeForMatching` deletes the `?`.
- **Pre-filter**: a message that is not question-shaped never reaches Jev. Before
  M6.1 every order the regex did not catch paid one decisions call and up to
  `CHAT_INTENT_TIMEOUT_MS` of latency **before its ack**; now it pays nothing.
- **Three outcomes** from `resolveQuestionIntent` (`action`): `answer` (regex, or
  Jev above threshold) → reply and no goal; `order` (not question-shaped, or
  `q_none` from a working model) → the order path; `unrouted` (question-shaped
  and the router is off/without key, times out, errors, answers unparsably, or
  lands under `CHAT_INTENT_MIN_P`) → the bot says it did not understand and
  **creates no goal**.
- **Refusal with a way out** (`renderUnrouted`, `UNROUTED_TEMPLATE`):
  `non ho capito la domanda. Se era un ordine, scrivi "@bot <ordine>".` — the
  message may well have been an order phrased as a question
  (`riesci a raggiungermi?`).
- **Telemetry**: `chat_unrouted` records `from`, `xuid`, `message`, `reason`
  (`no_key` | `disabled` | `timeout` | `error` | `unparsable` |
  `low_probability` | `no_fact`), `probability`, `model`, `ms`, `cost`; the
  refusal carries `context: 'unrouted'`.
- **Tests**: `tests/human-questions.test.mjs` (the guard's true/false pairs, the
  refusal line), `tests/chat-intent.test.mjs` (the pre-filter costs no call;
  `q_none` → order; timeout/unparsable/low-p/disabled/no-key → `unrouted`) and
  `tests/controller-chat-ack.test.mjs` (`chi mi sta guardando?` with a dead router is
  refused and never becomes `follow`; `sei un cretino` skips the model;
  `riesci a raggiungermi?` with a model that answers `q_none` stays an order; a
  hanging endpoint is logged as `timeout`).
- **Not done on purpose**: a tie-break through Hermes (System Two) for
  interrogative *orders* — `chat_intent.reason = 'not_a_question'` and
  `chat_unrouted` are the data that will decide whether M7 needs it.

### M6.3 — worn armor is a fact, equipping is an order

M6 could say what the bot *carries* (`q_inventory`) but not what it *wears*, and
an equip order — short, imperative, unmistakable — fell through to the static
`follow <sender>` fallback. M6.3 adds both halves:

- **`q_armor` (the seventh intent)**: `armorAnswer(obs)` reads `observe()`'s
  `armor` (`{helmet, chestplate, leggings, boots, points}`, filled by
  `bedrock-adapter.mjs` from the equipment slots — **worn**, not carried) and
  answers `indosso: iron_helmet, iron_boots (9 punti armatura)`,
  `non indosso armatura`, or `non lo so: non ho letto la mia armatura` when the
  fact is missing. The intent sits right after `q_health` so its phrases win over
  `q_inventory`'s; the closed option list is now `a0..a7` with `q_none` last.
- **A question that names an item is answered about that item**: `inventoryAnswer`
  reads the message (`matchItemWord`, `ITEM_WORDS`, `normalizeForMatching`) and
  answers the count of that one item (`hai una spada?` → `sì: wooden_sword`,
  `quanta terra hai?` → `dirt x64`, or `no, non ne ho`) instead of the ranked
  list. The list is the fallback, not the answer.
- **Hearts first**: `q_health` now covers `quanti cuori hai?`/`quanta fame hai?`
  and `healthAnswer` leads with hearts (`ho 10 cuori (20/20 di vita) e 12/20 di
  cibo`) — Bedrock counts half-hearts 0-20, so `round(health / 2)` is the number
  a human expects.
- **Equip orders are planned deterministically** (`isEquipOrder` +
  `humanCommandPlan`): `equipaggiati …`, `equipaggia tutto`, `mettiti l'armatura`,
  `indossa i gambali`, `wear your helmet`, `put on your boots` (and the shield /
  pumpkin nouns) produce `{need: 'wear_armor', equip: true, follow: null}` with
  **no Hermes call** (`plan` event, `deterministic: 'equip'`) and no model in the
  loop: the controller picks `equip_armor` itself whenever the harness offers it
  (`EQUIP ORDER … deterministico`, `equip_order` event) — the model cannot
  express equipment, and the old fallback would have sent `follow <sender>`.
  `mettiti a lavorare` stays an ordinary order: the verb alone is not enough.
- **Success is state, not opinion**: `isNeedResolved('wear_armor', …)` uses
  `perception.wornArmorCount` (`survival/perception.mjs`, from `observe().armor`),
  so a helmet in the backpack resolves nothing and the goal closes on the
  confirmatory `goalMet`, after exactly one successful action.
- **Nothing to wear is an answer, not a wandering**: when `plan.equip` is set and
  `equip_armor` is *not* offered, the controller refuses
  (`renderNoArmor`: `non ho armatura in inventario, non posso equipaggiarmi`),
  logs `equip_order {key: null, error: 'no_armor_in_inventory'}` and fails the
  goal with that `reason` (so the human gets `non ce l'ho fatta: …` instead of a
  silent timeout).
- **Tests**: `tests/human-questions.test.mjs` (the new fast-path phrases,
  `q_armor` precedence, the item-named answer, hearts-and-food, the missing-fact
  policy), `tests/controller-decisions.test.mjs` (`isEquipOrder` true/false
  pairs), `tests/idle-goals.test.mjs` (`wear_armor` = worn, not carried),
  `tests/chat-intent.test.mjs` (the fast path must not swallow the phrases the
  model path is exercised with) and `tests/controller-chat-ack.test.mjs` (an
  equip order is acked, planned with `deterministic: 'equip'`, ends on
  `equip_armor` alone with the armor **worn** in `observe().armor`, and with an
  empty inventory it is refused and fails — no `/act` at all).

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
  `{prefix}`, `{prefixes}`).- Tests: `tests/human-greeting.test.mjs` — policy (`renderGreeting`,
  allowlist/range/cooldown filters, malformed humans) plus the adapter wire
  (`observe().humans`, the serialised `text` packet, the `sendChat` guards).

**Note**: the wire format was validated against protocol 1.26.51; the greeting is
sent on the public `chat` channel, and `type` can be overridden to `whisper` if a
quieter hello is preferred (still an open question).

## Open questions

- **Trigger**: settled to a **list** of triggers (`CHAT_PREFIXES`, default
  `@bot`; the legacy `CHAT_PREFIX` still works and is summed into the list),
  matched on both public chat and whisper. Several triggers let one bot answer
  to both a generic word and its own name — needed once several bots share the
  server, so each bot must use **distinct** triggers. The longest trigger wins
  (`@bot1` is not `@bot`) and a message that starts with an unconfigured prefix
  is not an order. Still open: require whisper only?
- **Follow semantics**: settled to stop distance 3, 45 s window, ~64-block
  tracking range. Still open: long escort and behaviour on player disconnect.
- **Priority vs autonomous plan**: settled to "human order overrides until
  superseded or budget end". Still open: an explicit "resume autonomy" command.
- **Acknowledgement**: still open — the bot can speak (`POST /say`) and greets a
  nearby human with the order syntax, but it does **not** ack a specific order
  ("received, on my way").
- **Greeting channel**: open — a whisper (`type: whisper`) instead of public
  chat, so the hello does not spam everyone?
- **Greeting during `emergency`**: open — skip it while the bot is being attacked?
  Today the greeting fires regardless of the governor state (it is informational
  only, but it is noise during a fight).
- **Greeted-state persistence**: open — `greetedHumans` lives in memory in
  `controller.mjs`, so a controller restart re-greets the same human
  immediately: the cooldown does not survive the process and is not stored in
  `runs/<RUN_ID>/`.
- **Live round**: open — the greeting and `POST /say` have never been exercised
  against the deployed BDS (unit tests + offline wire-format check only).

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
