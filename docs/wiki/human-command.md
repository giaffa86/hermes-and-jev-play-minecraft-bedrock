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
- **M6.4 — the copper tier, not bronze** ✅ "armatura in bronzo" now has an
  answer: bronze does not exist in vanilla Minecraft (no `bronze_*` item or
  recipe, only mods), the tier between stone and iron added by The Copper Age is
  **copper** — so `bronzo`/`bronze` are read as copper, a question that names a
  material ("una spada di rame?") is answered about *that* material, and the bot
  offers to craft the copper gear it can carry (`craft_copper_<tool|armor>`).
- **M7 — the reply sounds like a player** ✅ an LLM (`chat-llm.mjs`, DeepSeek by
  default) rephrases the deterministic ack/outcome/answer in the sender's
  language and in the first person, so the bot stops echoing the English planner
  objective; a greeting/small talk is answered conversationally instead of
  becoming a goal. The model never decides anything and every failure falls back
  to the template.
- **M9 — inventory orders** ✅ "getta i diamanti" throws the named item out of
  the inventory, "cattura i diamanti" / "cattura spada" picks the dropped item
  back up: both are planned **deterministically** (no Hermes call), executed with
  the `drop` action of the `item_stack_request` and by hunting the matching drop,
  and closed by a criterion the harness can verify (`dropFulfilled` /
  `collectFulfilled`). When the item is missing the bot says so
  (`item_not_in_inventory`, `no_matching_drop`) instead of mining it or
  wandering off.

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
  without any model call — `q_activity` is `@bot che fai?` /
  `@bot cosa stai facendo?` / `@bot what are you doing?`, in all five languages
  and with or without the `?`.
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
  answered and creates no goal — including `@bot che fai?`, answered from the
  active `observe().plan`, and the idle case answered
  `non ho un obiettivo: sono in attesa di ordini` instead of a made-up objective;
  a free-form question is routed by System One and still answered from the
  facts).

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

### M6.4 — the copper tier, not bronze

The family ordered *"equipaggiati con armatura in bronzo"* and then pushed back:
*"in minecraft esiste l'armatura di bronzo da qualche versione, anche le armi
come spada e gli attrezzi come zappa, piccone, ascia"*. The bot was right and the
phrase was not: bronze is **not** in Minecraft. No Java or Bedrock version ships a
`bronze_*` item or a recipe for one (the only "Bronze" in the game files is the
dye colour `Bronze Olive`; bronze exists only as a mod, e.g. tin + copper, and as
feedback-site proposals). What the update brought — *The Copper Age*, Bedrock
1.21.111 / Java 1.21.9, 30/09/2025 — is the **copper** tier between stone and
iron: armour (helmet, chestplate, leggings, boots), the tools (axe, hoe, pickaxe,
shovel) and a sword. M6.4 makes the bot agree with the game instead of the
phrase:

- **`bronzo`/`bronze` mean copper** (`ITEM_WORDS`, `MATERIAL_WORDS` in
  `human-questions.mjs`, with the reason in the code): `hai una spada di bronzo?`
  answers about the `copper_sword`. The alias is what makes the family's phrasing
  work, and it stays correct if a bronze addon is ever installed — the string is
  recognised, and the answer is "what is actually in the inventory".
- **A material is part of the question**: `matchMaterial` reads `legno/wooden`,
  `pietra/stone`, `rame/copper/bronzo`, `ferro/iron`, `oro/gold`, `chainmail`,
  `diamante`, `netherite`, `cuoio/leather` and narrows the answer to the items
  whose name starts with that material — but only for tool/armour kinds
  (`MATERIAL_KINDS`), so `hai della pietra?` stays the question about `stone` and
  `cobblestone`. A material the bot lacks is no longer a flat refusal: `hai una
  spada di diamante?` → `no, non ne ho; ho: wooden_sword, copper_sword` (the list
  is what makes the chat useful).
- **The bot can craft copper gear** (`options()` in `bedrock-adapter.mjs`):
  `craft_copper_pickaxe|sword|axe|hoe|shovel` and
  `craft_copper_helmet|chestplate|leggings|boots`. An option is offered only when
  the recipe is known *and* the materials are there (`_craftable`: `_hasMaterials`
  over the inventory slots, or over the aggregate `inventory` — a pickup updates
  the aggregate before the slots, and `_craftItem` re-syncs) *and* the craft is an
  upgrade: no tool of that kind at harvest rank ≥ copper (`TOOL_HARVEST_RANK.copper`
  = 2, the same as stone) and no piece already worn or carried. Mining with copper
  tools already worked (`TOOL_TIER_SPEED.copper` = 6, `TOOL_HARVEST_RANK.copper` =
  2) and so did `raw_copper → copper_ingot` smelting (`SMELT_RECIPES`); M6.4 adds
  the crafting step, so `craft_copper_*` joins the hardcoded wooden/stone crafts.
  Iron and diamond gear are deliberately still not offered.
- **Equipping stays material-agnostic**: `equip_armor` matches the
  `_helmet`/`_chestplate`/`_leggings`/`_boots` suffixes, so an equip order wears
  whatever armour pieces are in the inventory — copper included. A *per-material*
  equip order ("wear the copper helmet, not the iron one") is not implemented:
  the intent has no material parameter.
- **Tests**: `tests/human-questions.test.mjs` (material narrowing, the bronze
  alias, the informative fallback, `quanto rame hai?` staying a question about the
  ingot) and `tests/bedrock-dig.test.mjs` (`craft_copper_pickaxe`/`copper_sword`
  offered with the ingots, suppressed once a stone pickaxe is carried — same
  harvest rank — the chestplate only with 8 ingots and only while not worn or
  carried, and nothing of the tier offered without ingots).
- **Not verified live**: the containers still run the pre-M6 chat build, so this
  is a unit-level claim about `options()` and the answer functions.

## Natural chat (M7): the model rephrases, it never decides

The M1–M6 replies were deterministic **and quoted the plan verbatim**. The
planner prompt is English and writes the objective as a third-person infinitive
(`Follow Ale and stay close`), so a live ack read
`@<name> ok: Follow <name> and stay close — arrivo da <name>` and an outcome read
`@<name> fatto: Stay put and wait for the next order (6 azioni)`: the scaffold was
Italian, but the bot still sounded like a status line.

M7 inserts an LLM between the composed reply and `POST /say`. `chat-llm.mjs` is
an OpenAI-compatible `/chat/completions` client (DeepSeek default) whose only job
is to rephrase:

- **Two inputs, one rule.** The model gets a compact `facts` object built from
  `observe()` (`compactChatFacts`: self, position, health/food, dimension, top
  inventory, time, goals, nearby players/animals/hostiles) plus, whenever a
  deterministic reply exists, a `grounding` string carrying the **real** numbers.
  The system prompt says the facts are the only allowed source; if a fact is
  missing, the bot says it does not know. Inventing a number is a bug, not a
  feature.
- **Never decides, never creates a goal.** The order path
  (`humanCommandPlan` + `/options`) is untouched: no order key, no allowlist
  check and no question router moves into the model.
- **Same-language, first-person, one line.** The system prompt asks for the
  sender's language, first person, a single short line, no markdown; the result is
  flattened and clamped with the same `clampMessage` used by the templates.
- **Failure is always the template.** No key, `CHAT_LLM=off`, timeout, HTTP
  error, empty reply or a reply that would start with a trigger
  (`isSelfTriggering`) all fall back to the deterministic text. `replyChat` is
  the only caller of `POST /say`, so the channel is never silent and still never
  self-triggers.
- **Small talk is not an order.** `looksLikeSmallTalk` matches an **exact**
  closed list (`ciao`, `come stai`, `grazie mille`, `hello`, …) on the
  prefix-stripped message, so `grazie prendi la legna` stays an order. A
  greeting is answered and creates no goal (`chat_smalltalk`); its fallback is
  `CHAT_SMALLTALK_TEMPLATE`.
- **Conversational memory.** `createChatMemory` keeps the last ~6 turns (12
  messages) per sender for up to 8 senders, in RAM only (a restart forgets: no
  chat log is persisted).

Wiring in `controller.mjs`: one helper, `saySmart(context, {...})`, is the new
entry point for every conversational reply — `question`, `unrouted`,
`smalltalk`, `ack` and `outcome` — and logs one `chat_llm` line per attempt
(`{ok, via:'llm'|'fallback', model, ms, cost, code}`). The proactive greeting
stays deterministic on purpose: it exists to teach the order syntax, and the
model could garble `{prefixes}`.

| Env | Default | Meaning |
|---|---|---|
| `DEEPSEEK_API_KEY` / `CHAT_LLM_API_KEY` | unset | the gate: without a key M7 is off and the deterministic path runs |
| `CHAT_LLM` | on with a key | `off` disables the engine even with a key |
| `CHAT_LLM_MODEL` | `deepseek-chat` | model id sent to the endpoint |
| `CHAT_LLM_URL` | `https://api.deepseek.com/chat/completions` | any OpenAI-compatible endpoint |
| `CHAT_LLM_TIMEOUT_MS` | `8000` | per-reply ceiling; on expiry the template is sent |
| `CHAT_PERSONA` | village bot | persona sentence spliced into the system prompt |
| `CHAT_SMALLTALK_TEMPLATE` | `@{name} ciao! dimmi pure.` | deterministic fallback for a greeting |

Tests: `tests/chat-llm.test.mjs` — config gating, `compactChatFacts`, bounded
memory, prompt contents and every failure mode (stubbed `fetchImpl`, no
network); `looksLikeSmallTalk` is covered there too. The existing
`tests/human-questions.test.mjs` and `tests/human-replies.test.mjs` still assert
the deterministic text, which is now the fallback.

**Open**: the reply is the persona's language by default, so an English order
is answered in English only if the model follows the instruction (not asserted
live); the memory is per-process; and the M7 path has not been exercised against
the deployed BDS (unit tests only).

## Deterministic replies speak the sender's language (M7.1)

M7 gave the reply a voice, but the **switch for the language was the key**: with
no key (or `CHAT_LLM=off`) the deterministic path still pasted `plan.objective`,
and the objective is the *technical* description of the goal — `Stay put and wait
for the next order`, `Equip the armor pieces carried in the inventory …`,
`Harvest the ripe crops in the village plots …`. Those strings live in the
knowledge base (`idle-goals.mjs`, `village-labor.mjs`,
`knowledge/progression.json`) and are English on purpose; chat is not the place
they belong to.

The user's rule is explicit: *"la risposta deterministica dovrebbe essere in
italiano se la domanda è in italiano, per questo chiedevo di introdurre llm e
farlo sembrare naturale"*. So M7.1 makes the deterministic path Italian on its
own, and the LLM stays what it was meant to be: naturalness, not the language
switch.

- **The planner writes the objective for the human.** The `humanCommandPlan`
  prompt now asks for `objective` in the same language as the human message and
  in the first person (`sto andando da <gamertag>`, `mi metto l'armatura`),
  because that text is exactly what the ack and the outcome send back.
- **The deterministic fallbacks are Italian too** (they run when Hermes is down
  or returns garbage): `resto fermo in attesa del prossimo ordine` for a stop
  order, `seguo <name> ed eseguo il suo ultimo ordine: "…"` for everything else,
  and the equip order (which never reaches the planner) carries `mi metto
  l'armatura che ho in inventario (elmo, corazza, gambali, stivali)`.
- **`planPhrase` translates the structured goals.** `human-questions.mjs` owns
  `CHORE_LABELS` (the 11 village chores) and `NEED_LABELS` (the survival needs
  plus `wear_armor`) and turns a plan into an Italian sentence; `activityAnswer`
  ("cosa stai facendo?") uses it, and falls back to `plan.objective` only when
  the plan has no structured kind — an order, whose objective is already in the
  human's language. `targets` are deliberately not used, for the same reason.
- **Drift is a test failure.** `tests/human-questions.test.mjs` asserts that
  every `VILLAGE_CHORES[].id` and every `NEED_PRIORITY` need has a label, so a
  new chore cannot ship without its Italian phrase.

Tests: `tests/human-questions.test.mjs` (label coverage, `planPhrase` and the
activity answer per goal kind) and `tests/controller-follow-order.test.mjs` (the
stop-order fallback now asserts the Italian outcome).

**Open**: the *opportunity* and *curriculum* objectives still reach chat in
English when the plan carries no structured hint (`planPhrase` returns null and
the objective is used verbatim) — the `opportunity:`/`curriculum:` notes prefixes
cover today's producers, but a new goal family must add a label (or stay out of
chat); and the same-language rule for the planner is an instruction, not an
assertion (a model that ignores it leaves an English objective inside an Italian
scaffold).

## One catalogue, five languages (M7.2)

M7.1 made the deterministic path Italian; the user then asked for the general
case: *"facciamo una bella cosa, i18n per i messaggi con una proprietà env con la
lingua default, potremmo fare italiano, inglese, francese, spagnolo, tedesco per
iniziare"*. The risk of a translation layer in a chat path is drift — one string
updated in Italian and forgotten in German — so the rule is stricter than "add a
lookup": **a user-facing sentence exists only in the catalogue**.

- **One file per language.** The catalogue is five dedicated modules —
  `chat-lang/it.mjs`, `chat-lang/en.mjs`, `chat-lang/fr.mjs`,
  `chat-lang/es.mjs`, `chat-lang/de.mjs`, each `export default Object.freeze({…})`
  — and **`chat-i18n.mjs` is only the API**: it imports the five tables into
  `MESSAGES`, and owns `t(lang, key, vars)`, `hasMessage`, `messageKeys`,
  `listAnd` and the `CHAT_LANG` resolution (`chatLangConfig`, `normalizeLang`,
  `isSupportedLang`). The four non-default files carry the keys and nothing
  else; `chat-lang/it.mjs` is the reference and the only one with the section
  comments (which group of keys belongs to which renderer). Languages: `it`
  (default — it is the historical behaviour of this server), `en`, `fr`, `es`,
  `de`. `LANG_NAMES` (English names) feeds the prompts, `LANG_NATIVE_NAMES`
  (`italiano`, `English`, `français`, `español`, `Deutsch`) is what the model is
  told to use when the message does not make the language clear.
- **The templates are data, the renderers still fill them.** `t()` without
  `vars` returns the template with its placeholders intact, because
  `human-replies.mjs`/`human-greeting.mjs` interpolate afterwards
  (`renderReply`, `renderGreeting`). Getting this wrong emptied every ack — the
  first run produced `'@ ok:'` — so a placeholder with no value stays visible
  instead of vanishing: an incomplete template is a bug you can read.
- **`CHAT_LANG` does not depend on the LLM.** `chatLangConfig(process.env)` is
  resolved once at startup; `orderAck`, `orderOutcome`, `lostNotice`,
  `renderAnswer`, `renderUnrouted`, `renderNoArmor`, `planPhrase`,
  `planGreetings` and the three planner fallbacks (`fallback.stop`,
  `fallback.follow`, `fallback.equip`) all take `lang: CHAT_LANG`. A region code
  is tolerated (`en-US` → `en`); an unknown value is not fatal — the bot uses the
  default and logs one `CHAT_LANG="pt" non supportata …` line at startup.
- **Labels are derived, not duplicated.** `CHORE_LABELS`/`NEED_LABELS` are no
  longer hand-written Italian maps: `labelsFromCatalogue` builds them from the
  `chore.*`/`need.*` keys, and `choreLabel(id, lang)`/`needLabel(id, lang)`
  answer in any language. The Italian exports stay for compatibility (and keep
  the existing tests meaningful).
- **The intent patterns cover the five languages too.** A question is answered
  without a model call in French, Spanish and German as well: `ITEM_WORDS`,
  `MATERIAL_WORDS`, `QUESTION_OPENERS`, `SMALL_TALK` and the seven
  `QUESTION_INTENTS` patterns were extended (`ou es-tu`, `donde estas`, `wo bist
  du`, `que fais-tu`, `quelle heure`, `quien eres`, `was kannst du`, …).
  `normalizeForMatching` now folds accents (`Kürbis` → `kurbis`, `¿dónde` →
  `donde`) because a `\b` before an accented letter never matches; the pattern is
  additive, so the Italian and English behaviour is untouched.
- **The LLM follows the message, `CHAT_LANG` covers the ambiguity.**
  `buildChatMessages` says "rispondi nella stessa lingua del messaggio; se dal
  messaggio la lingua non è chiara, rispondi in `LANG_NATIVE_NAMES[CHAT_LANG]`
  (`italiano`, `English`, `français`, `español`, `Deutsch`)". A clear message
  always wins.
- **Drift is a test failure.** `tests/chat-i18n.test.mjs` asserts that every
  language defines every key of the default catalogue, that the placeholders of a
  key are identical in the five versions, that the strings actually differ, that
  each `VILLAGE_CHORES` id and each `NEED_PRIORITY` need has a label in all five
  languages, and that the deterministic ack/outcome/refusal/greeting are
  addressed and translated. The French/Spanish/German questions are asserted
  against `matchQuestionIntent` with no key and no server.

So the language chain is now: the human's own words (an order keeps its
objective, M7.1) → `CHAT_LANG` for everything the bot composes → the LLM, which
may rephrase but not change the language of a clear message.

**Open**: `CHAT_LANG` is the *bot's* language, not a per-message detector: an
order written in French gets a French objective (M7.1, the planner follows the
sender) inside an Italian ack template, so the line can read `@Jean ok: je
viens …`. Detecting the message language to pick the ack template as well would
make the two mechanisms fight (the planner already answers in the sender's
language), so the split is deliberate — but it is visible in the log and worth a
second look. Also open: the catalogue is flat and small on purpose, but a sixth
language is a new file in `chat-lang/` (keys and placeholders copied from
`it.mjs`), its code in `LANGS`/`LANG_NAMES`/`LANG_NATIVE_NAMES`, and a pass over
the intent patterns — the tests enforce the *shape*, so the risk of drift is in
the content only; the `chat.*` keys are English-named while most of the values
were born Italian, so the `it` file is the reference one; and the German
*"wie gehts"* is both small
talk and a health question — the question-shape pre-filter wins, which is
deliberate (the bot answers with its hearts) but it is the kind of overlap that
a new language can reintroduce.

## The bot says what it is doing (M8)

The authorised plan was *"annuncio una volta a inizio goal, solo
autonomous/village, saySmart, range 24, throttle 5 min. Nessun annuncio
finale"* — and, at its core, one rule: the sentence is composed
**deterministically** first, and only then handed to the optional LLM. The point
is not decoration: a human standing next to a bot that suddenly walks away has
no way to know whether it is working or leaving, and a bot that narrates its own
goals is also easier to audit.

- **`chat-narration.mjs`** (new, pure) holds the whole composition:
  `narrateGoal(plan, {lang})` picks the frame (a `plan.chore` first, then a
  `plan.need`; `null` when there is nothing to say), `narrateChore`/
  `narrateNeed` build the sentence from the catalogue, and `targetWord(target)`
  turns the chore's `target` into words. A need carries its own frame
  (`narrate_need` + `need.<id>`), so it is *not* wrapped a second time in
  `autonomy_narration` — the first version produced *"In autonomia: In autonomia
  devo …"*.
- **The concrete thing, not the category.** M8 gave every chore in
  `village-labor.mjs` a `target` (`targetOf`: `{kind:'crop', item:'potato'}`,
  `{kind:'log'}`, `{kind:'ore'}`, …), the controller copies it into
  `plan.choreTarget`, and `targetWord` prefers the item key (`item.potato` →
  *le patate*, *the potatoes*, *les pommes de terre*…) over the family
  (`kind.crop`). An id like `harvest_crops` never reaches the chat.
- **One line, once, and only if someone is listening.** `maybeNarrateGoal(goal)`
  runs in `main()` right before `runGoal(goal)` and gates on: `CHAT_NARRATE`
  (default: follow `CHAT_REPLY`), `goal.type` in `village`/`autonomous` (a human
  order is never narrated back), something to say, the
  `CHAT_NARRATE_COOLDOWN_MS` throttle (default 300000) and at least one human
  within `CHAT_GREET_RANGE` (`nearbyHumans`). The goal is marked in
  `narratedGoals` **only when the message is actually sent**, so a goal started
  in solitude keeps its chance to speak later. There is no end-of-goal
  announcement on purpose.
- **The model never decides the fact.** The composed sentence goes to `saySmart`
  as both the text and the `grounding`, exactly like a question answer: with a
  DeepSeek key an LLM may rephrase it in the sender's language, without a key the
  same sentence is sent verbatim. It cannot invent a fact, pick the language or
  announce a goal of its own. The log carries `autonomy_narration`
  (`goalId`/`type`/`chore`/`need`/`humans`/message) and stdout gets
  `NARRATE [gN] …`.
- **Evidence.** `tests/chat-narration.test.mjs` walks every `VILLAGE_CHORES` id
  and every `NEED_PRIORITY` need in the five languages, checks the concrete crop
  name, the family fallbacks, the one-line clamp and the `null` cases; the
  integration case in `tests/controller-session.test.mjs` asserts that *"In
  autonomia: sto raccogliendo il grano"* actually reaches `POST /say` with an
  allowlisted human at distance 5.

*Numbering*: the label follows the wording of the request that authorised it
(M8); it is a slice of milestone 3/4 — autonomy plus social behaviour — not the
`M8 Character` row of `ai-player-roadmap.md`.

## Inventory orders (M9): getta / cattura

Two orders the bot must get right without a model, because both are about its
**own inventory** — the one state it can verify exactly:

| Order | Meaning | Action | Success criterion |
|---|---|---|---|
| `@bot getta i diamanti` | empty the named item out of the inventory | `drop_item` (one `drop` action per stack) | `dropFulfilled` |
| `@bot cattura i diamanti` | go and pick the named dropped item back up | `collect_drop` (filtered by token) | `collectFulfilled` |

The two are not symmetric, and that asymmetry is the design: **dropping** is an
accounting problem (what left the inventory), **catching** is a search problem
(what is on the ground).

- **Reading the order is deterministic.** `orderItem(message)` reuses the same
  item vocabulary as the questions (`ITEM_WORDS` in `human-questions.mjs`, five
  languages): `getta i diamanti` → token `diamond`, word *diamanti*. A *verb*
  decides the direction (`DROP_VERB`: getta/butta via/droppa/scarica/lascia a
  terra/toss/drop/throw; `COLLECT_VERB`: cattura/raccogli/preleva/take/pick
  up…), and a verb with no item from the catalogue is *not* an inventory order —
  "seguimi" stays a follow order. `@bot raccogli 4 terra` deliberately stays a
  **planner gather quota** (verb + number = go and get four), so the old meaning
  is not stolen.
- **The plan carries the baseline, not just the intent.**
  `humanCommandPlan` resolves the token against `obs.inventory` at plan time and
  stores `drop: {token, word, count, items, before}` (`before` = the count of
  each matching stack) and `collect: {token, word, items, beforeTotal}`. This is
  what makes success verifiable *by the harness later*, instead of by the
  model's opinion: `dropFulfilled` asks that the count actually fell (all of it
  when no number was given, exactly `count` pieces otherwise), `collectFulfilled`
  that the total of that token *grew*. Because the collect plan is anchored to
  the **token**, a drop that lands on the ground after the plan (a second order,
  another player, the bot's own `drop_item`) still counts.
- **A tuple of items, not a name.** `inventoryMatchingToken` decides what
  "diamanti"/"ferro" means in the current inventory: the exact item name wins
  (`diamond`), otherwise the non-tool/armor entries (`iron_ingot`, `raw_iron` for
  "ferro" — a *sword* is not what you throw away), otherwise everything matching
  (`oak_planks`, `spruce_planks`). `matchesItemToken` is the same rule for a
  single name and is shared with the adapter, so the bot's option and the
  controller's expectation can never disagree about what "armor" is.
- **The action is the protocol's own `drop`.** `_dropItems` opens the inventory
  window (the same guard all stack requests need) and sends one
  `item_stack_request` per stack with `{type_id: 'drop', legacy_type_id: 3,
  count, source: {slot_type: {container_id}, slot, stack_id}, randomly: false}` —
  no cursor, no fake `place` into the world. After each response the local mirror
  is updated and re-read, so a stack that empties or an index that moves cannot
  desync the loop; if the server says `ok` but nothing changed locally, the action
  stops with `drop_no_progress` instead of spinning on the same slot. A
  quota (`getta 5 diamanti`) is split across stacks and stops exactly at the
  requested count.
- **Collecting filters the search, it does not widen it.**
  `_nearestDrop({names})` only considers drops of the named token (an empty list
  means *no drop*), and `options()` passes `_plannedCollectNames()` — so a coal
  drop lying next to the diamond is not picked up "while we're there", and
  `collect_drop` is simply not offered when nothing matches.
- **Refusal instead of a hopeless goal.** The controller only chooses the action
  if the harness offers it (`canDrop`/`canCollect`); otherwise the order is
  closed immediately with `drop_order {error:'item_not_in_inventory'}` /
  `collect_order {error:'no_matching_drop'}`, the human is told (`no_item`,
  `no_drop`) and the run ends with the same reason — no mining detour, no
  exhausted budget, no "maybe it worked".
- **A named crop is not an inventory order.** Before the collect branch,
  `humanCommandPlan` asks `farmOrderFromText` (see
  [village-recon](village-recon.md)) whether the order names a *crop* with a
  farm verb ("raccogli le carote", "mieti il grano e rimpiantalo"): that is a
  `plan.farm` chain (`harvest_*` → `plant_*` → `deposit_*`) closing on a state
  delta, not a pickup. The collect branch still wins whenever a drop of that
  crop is really on the ground — the wording is identical, the evidence is not —
  so `no_drop` can no longer be the answer to a field standing right there. A
  quoted number ("raccogli 4 carote") still means gathering a quota, and stays
  with the planner.
- **An open human order survives the emergency filter.** `drop_item` and
  `collect_drop` are protected keys alongside the follower of "seguimi", via
  `humanOrderProtectedKeys(plan)` in `survival/resolver.mjs` — the policy lives
  in one place, so the harness route and the filter cannot drift apart.
- **Evidence.** `tests/controller-drop-order.test.mjs` (vocabulary, verbs, the
  `raccogli 4 terra` non-case, quotas, exact-name/tool preferences, both success
  criteria), `tests/bedrock-drop.test.mjs` (the request shape of `drop`, quota
  and multi-stack drops, the failure/no-progress/empty paths, `_plannedDrop`,
  `_plannedCollectNames`, the filtered `collect_drop`) and four integration cases
  in `tests/controller-chat-ack.test.mjs` (drop success/refusal, collect
  success/refusal, each asserting no Hermes call and the exact action list).
  The `drop` action is not exercised against a live BDS yet.

*Numbering*: M9 is the slice of milestone 3/4 the owner asked for after M8; the
label is about the *inventory* orders, not the `M9` row of another roadmap.

## Told facts (M10): the human teaches, the bot remembers

The channel so far answered *questions* about the bot and executed *orders*.
M10 adds the missing direction: the human can **dictate a fact about the world**
the bot cannot measure, and the bot must be able both to give it back and to use
it as a destination.

| The human says | The bot does |
|---|---|
| «Ricorda che questo è il campo di patate» | writes a `landmark` named *campo di patate* at the **sender's live position**, `source: 'told'`, `permanent: true` |
| «Segnati che l'ingresso della miniera sta a 130, 62, -240» | writes the named place at the coordinates in the sentence |
| «Nel baule di casa c'è del ferro» | names the chest (position, label) and records a **partial claim** on its content — it does not become an inventory |
| «Dov'è il campo di patate?» / «Dove posso trovare ferro?» | answers from the catalogue with the exact stored value and its provenance: *«(me l'hai detto tu)»* vs *«(visto da me)»* |
| «L'ingresso principale della miniera ora è a…» | **corrects** the place: same identity, the old position in its history, the provenance kept |
| «Dimentica il vecchio deposito» | **invalidates** it (`status: 'invalid'`) — never deletes: out of search, answers and navigation, still in history |
| «Vai al campo di patate» | a normal **movement order** to the remembered position (`told_goto`), with the usual preemption/resume, no model call |

- **Said is not seen.** The record keeps `toldBy`/`toldAt` next to the bot's own
  observations, and the answer says which one it is answering from. A place a
  human names is `permanent` (no TTL: nobody re-visits a mine entrance by
  accident, and time alone is not evidence it moved); the *content* of a named
  chest is a claim with a 7-day staleness and a verdict derived from the next
  real reading (`unverified`/`confirmed`/`contradicted`). Details and the HTTP
  surface are in [memory](memory.md#told-facts-what-a-human-said).
- **Repeating a fact is not correcting it.** The same sentence said twice
  writes nothing the second time (`action: 'unchanged'`, no history row) and is
  still confirmed in chat; a correction is a place that *moves*, and it keeps the
  identity (same `id`) and the history. The writes pass the same sender gate as
  the orders: with `CHAT_ALLOWLIST` configured in the harness too, a fact
  attributed to a sender outside it is refused (403 `told_sender_not_allowed`).
- **Reading the sentence is deterministic and offline** (`memory-chat.mjs`,
  `toldIntentFromText`): five languages, no network, no model — the intent is
  either unambiguous or the message goes back to the ordinary flow (`null`).
  Branch order FORGET → CORRECT → REMEMBER → GOTO → CONSULT, coordinates only
  with an explicit marker, and a message-shaped check so «dove sei adesso?»
  stays a `q_position` question.
- **An incomplete command writes nothing and asks.** A recognised sentence with
  no name, no position, numbers that look like coordinates but carry no marker,
  or a deictic («questo», «il punto dove mi trovo») with no visible sender is
  answered with the right question (`told_ask_name`, `told_ask_position`,
  `told_ask_marker`, `told_no_sender_position`).
- **Ambiguity is asked, never resolved by distance**: two places with the same
  name produce *«ho 2 posti chiamati …: … e …. Quale intendi?»* and no write —
  not even for a correction or a forget.
- **The confirmation is the information**: it is composed from the catalogue
  (`told_*` keys in `chat-i18n.mjs`), addressed to the sender like every other
  reply, and states the recorded value («Registrato: campo di patate a 120, 64,
  -230, Overworld»). No LLM is involved: `chat-llm.mjs` never sees a told fact,
  so a number cannot be rephrased into a different number.
- **Remembering does not interrupt the goal.** Remember/consult/correct/forget
  are answered and the message loop continues — the running goal is untouched.
  Only «vai al campo di patate» is an order, and therefore behaves like one
  (`human_preempt`/resume). An *escort* phrased with a remembered name
  («accompagnami al campo di patate») is left to the escort flow, and a name the
  memory does not know falls back to the ordinary path (Hermes, semantic
  recall) instead of being invented.
- **Failure is declared**: if the harness route does not answer, the reply is
  *«non riesco a leggere la memoria adesso (…)»* (`tell_memory_unavailable`)
  rather than a guess.
- **Evidence.** `tests/memory-chat.test.mjs` (the sentence in five languages,
  the three original phrases, the negatives and the bounds),
  `tests/memory-told.test.mjs` (24 cases over both storage backends:
  persistence, TTL, claim verdicts, ambiguity, correction, repetition,
  invalidation, navigation by name) and `tests/controller-told-facts.test.mjs`
  (seven chat integration cases against a scripted harness: position of the
  sender, clarify with no sender, consult, ambiguity, an unchanged correction
  that is not mistaken for an unknown place, `told_goto` with no write, memory
  unavailable). Never exercised against a live BDS.

*Numbering*: M10 follows M9 (inventory orders); it is not related to any other
roadmap's `M10`.

## An order arriving mid-goal suspends the running goal

Until 2026-10-06 an order that landed while another goal was running
*reoriented* it: `plan` was replaced in place and the goal kept its old
`objective` and requester, so a second human's order was executed but the
outcome went to the first. Now the order **suspends** the running goal and runs
as a **child goal** (`parentGoal`, source `CHAT`, the order's own
`parameters.from`); when the child closes the parent is revalidated and resumed
(`HUMAN ORDER <from>: suspend <parent> -> run <child>`,
`RESUME <parent> (suspended while <child> ran)`, or
`GOAL <parent> COMPLETED (already satisfied while suspended)`).

Two deliberate exceptions: a **stop** order (`fermati`, `basta`, `stay`, …)
still closes the running follow/escort goal instead of parking it, and an order
from the **same** requester is still a revision of their own goal. Ack and
outcome are rendered from the child's own `from`, so two humans asking in a row
each get their own pair of lines (in their own objective). Rules, the depth cap
(`MAX_GOAL_DEPTH`) and the six verified cases: [goal-stack](goal-stack.md).

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
  tracking range. The companion **escort** order («guidami/accompagnami fino a
  <posto>») is implemented as `escort_to`: the bot leads toward the destination
  the order names (or the plan waypoint / the replay route), waits when the human
  is more than `ESCORT_MAX_GAP` behind, resumes within `ESCORT_RESUME_GAP`,
  closes with `escort_left_behind` after `ESCORT_WAIT_MS` of waiting and
  `escort_lost` after `ESCORT_LOST_MS` without a trace; the controller chooses it
  deterministically while `goal.escort` is open and holds the order (without
  spending budget) when the human is out of view; when the escort stops to wait —
  the human beyond `ESCORT_MAX_GAP`, or out of view — it says so **once per
  episode** in chat, with its own coordinates (`@<gamertag> ti aspetto qui: sono
  a x 108, y 0, z 230.`, cooldown `ESCORT_WAITING_COOLDOWN_MS`), because a human
  who fell behind cannot see where the bot is. The line comes from the catalogue
  of the five languages, filled from `observe()`, never from the model — see
  [exploration](exploration.md) M3 and [verification](verification.md) 47.52,
  47.53. Still open: a real long escort with a human on the BDS, and an
  acknowledgement specific to the order.
- **Priority vs autonomous plan**: settled to "human order overrides until
  superseded or budget end". A mid-goal order now *suspends* the running goal
  and resumes it afterwards ([goal-stack](goal-stack.md)) instead of replacing
  its plan; still open: an explicit "resume autonomy" and a "cancel the
  suspended goal" command.
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
- **Inventory orders (M9)**: open — `getta`/`cattura` are deterministic and
  unit-tested, but the `drop` action of the `item_stack_request` has never been
  sent to a live BDS (the offline check only proves the request shape and the
  local accounting). Also open: a bare material that matches several items by
  design ("getta il ferro" → `iron_ingot` + `raw_iron`, not the sword) and the
  interaction with a chest offer in `_depositState` (an inventory drop is not a
  storage order).

## Sources

- `bedrock-adapter.mjs` — `text` packet (id 9) reachable via
  `client.on('text', …)`; `_trackEntity`/`_onEntityMove`/`_nearbyEntities`
  (player tracking); `_hostiles`/`_selectWeapon`/`attack_*` (combat);
  `_moveTo`/`goto_waypoint` (movement primitive); `DIG_PROTECTED`.
- `bedrock-harness.mjs` — `/observe`, `/options`, `/act`, `/plan`, `/say` routes.
- `human-greeting.mjs` — pure greeting policy (`planGreetings`, `renderGreeting`).
- `human-replies.mjs` / `human-questions.mjs` — trigger matching and the
  ack/outcome templates; the seven question intents, `planPhrase` and the
  refusals. `human-questions.mjs` also owns the item vocabulary
  (`ITEM_WORDS`/`matchItemWordText`/`matchesItemToken`) the inventory orders
  (M9) and the adapter share.
- `controller-decisions.mjs` — the deterministic order detectors (`isDropOrder`,
  `isCollectOrder`, `dropCountFromText`, `farmOrderFromText`) and their success
  criteria (`inventoryMatchingToken`, `tokenInventoryTotal`, `dropFulfilled`,
  `collectFulfilled`, `farmStep`, `farmFulfilled`).
- `survival/resolver.mjs` — `humanOrderProtectedKeys(plan)`: the keys an open
  human order keeps even under the emergency filter (`follow_player`/
  `seek_player`, `drop_item`, `collect_drop`).
- `bedrock-adapter.mjs` — `_dropItems` (the protocol `drop` action),
  `_plannedDrop`/`_plannedCollectNames`, `_nearestDrop({names})` and the
  `drop_item`/`collect_drop` options; `_refreshInventory` counts a zeroed slot as
  empty (M9: a drop that reaches zero must verify).
- `chat-i18n.mjs` — the chat **API** (`MESSAGES`, `t`, `hasMessage`,
  `messageKeys`, `listAnd`, `chatLangConfig`): the only place a chat sentence is
  *looked up* (M7.2, `CHAT_LANG`). The sentences themselves live one file per
  language in `chat-lang/{lang}.mjs`.
- `memory-chat.mjs` / `world-memory.mjs` — the told facts (M10):
  `toldIntentFromText` and the place/coordinate/container parsing, and the
  memory side (`tellPlace`, `correctToldPlace`, `forgetPlace`,
  `claimToldContents`, `claimsFor`, `whereToFind`, `TOLD_SOURCE`).
- `chat-narration.mjs` — the autonomy narration (M8): `narrateGoal`/
  `narrateChore`/`narrateNeed`/`targetWord` compose "In autonomia: sto
  raccogliendo le patate" from the catalogue; `village-labor.mjs` reports the
  chore's `target` and `maybeNarrateGoal` in `controller.mjs` sends it once.
- `controller.mjs` — Hermes natural-language planning (`runHermes`);
  `maybeGreetHumans` (proactive greeting).
- `minecraft-data` `bedrock/1.26.51/protocol.json` — `packet_text` fields
  (`source_name`, `type`, `message`, `xuid`, …); `packet_add_player` (`username`).
- Related wiki: [overview](overview.md), [headless-client](headless-client.md),
  [village-recon](village-recon.md), [memory](memory.md),
  [`docs/raw/TOLD-FACTS.md`](../raw/TOLD-FACTS.md), [open-questions](open-questions.md).

### Exact food quantities and observed names

`getta una patata cotta` selects one `baked_potato`. Minecraft names observed in
inventory or on the ground also accept spaces, such as `raccogli spruce log da terra`.
After dropping, the bot levels its camera and leaves the pickup radius along a
short, loaded, level path. It refuses without safe clearance and reports an
item picked back up as `drop_recollected`. The inventory change must remain
visible before the goal can close successfully.
