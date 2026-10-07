# Chat replies that lie, and the bot that reports what it sees

Raw source. Four defects the owner found by reading the chat of the live round of
2026-10-07 (public Bedrock server, VM 100 harness container + BDS on CT 108) and
the two features requested in the same conversation: the bot tells the human when
it spots an ore, and «ragiona» in a question asks for a reasoned answer instead
of a catalogue sentence. Everything below is written from the live artefacts — the
controller journal `/opt/data/minecraft-releases/main-1c68a5b/runs/told-chat-main/controller.jsonl`,
the harness ledger `runs/diamond-20261007-1/actions.jsonl`, the harness routes
(`/observe`, `/debug/inventory`, `/memory/where`) — and from the code that was
changed. Nothing here was exercised against a live BDS again after the fix.

## The one rule these four defects break

A chat reply is a **claim about the world**. It must be composed from something
that was measured (a skill verdict, a harness report, a memory record, the
catalogue), never from what the bot *intended*. The four defects below are four
different ways the claim lost its evidence:

| # | The human saw | The world | Where the evidence died |
|---|---|---|---|
| A | «Registrato: mi avevi detto un diamante ma a 29, -4, 208» | a complaint, not a place | the parser read a denial as a declaration |
| B | «baule a 95, 73, 161 … diamanti ×1» and «sono a x 27, y -3, z 207» | a vein was in sight 8 blocks away | the question was answered from the wrong source |
| C | «fatto: … raccolgo un diamante già minato» (227 actions) | no diamond in the inventory, `dropped: []` | the order's own criteria had been emptied by a replan |
| D | «ok: butto via diamanti» then silence | `@? non ho diamanti in inventario` | the refusal had no addressee and was rate-limited away |

## A — a complaint registered as a world fact (M10)

The sentence, 19:55:24:

```
@bot mi avevi detto un diamante a 29 -4 208 ma non è vero
```

The harness wrote a landmark — the journal carries both lines:

```
tell_place {id:'mi_avevi_detto_un_diamante_ma_29_-4_208',
            name:'mi avevi detto un diamante ma', position:{x:29,y:-4,z:208}, kind:'place'}
chat_reply {context:'told', message:"@<human> Registrato: mi avevi detto un diamante ma a 29, -4, 208, Overworld."}
```

Cause: `memory-chat.mjs` decides "declaration" with a position verb plus a
coordinate triple (`POS_VERB` + `coords.kind === 'full'`). The sentence contains
a position verb — the *«è»* of *«non è vero»* — and a triple, so the denial of a
fact became a fact. The name afterwards is the debris of the sentence.

Fix in `memory-chat.mjs`:

- `DENIAL` — a negation whose copula/existence verb follows within 20 characters
  (*non è*, *isn't*, *no es*, *n'est pas*, *ist nicht*) ⇒ `toldIntentFromText`
  returns `null`: the bot has nothing to record.
- `REPORT_OF_SPEECH` — *mi avevi detto / hai detto / you said / me dijiste /
  tu as dit / du hast gesagt* — returns `null` unless a memory verb is present
  (*ricorda*, *dimentica*, *correggi*): a sentence about what the bot once said is
  not an order to remember it now.
- `NAME_VERB` — a name candidate that is itself a verb (*detto*, *said*) is
  refused, so even a rewording cannot leave a verb in a label.
- `NAME`/`LEADING_DANGLING` extended with the speech markers (*guarda*, *senti*,
  *ecco*, *vedi*) that the live sentence fragments leave at the head of a name.

## B — the question answered from the wrong source (M6/M10)

Two human messages, two wrong answers:

```
19:48:01  @giaffa86 ci sono diamanti nelle vicinanze? mi comunichi le coordinate?
19:54:26  @bot mi ripeti dove si trovano i diamanti nelle vicinanze?
19:55:43  @bot dove sono i diamanti da minare?
```

```
chat_reply   {context:'told', message:"@<human> baule a 95, 73, 161, Overworld: diamanti ×1 (visto da me)"}
tell_where_item {item:'diamond', id:'container_95_73_161', source:'observed', count:1, hits:5}
chat_question {intent:'q_position', via:'regex'}
chat_reply   {context:'question', message:"@<human> sono a x 27, y -3, z 207 (overworld)"}
```

Three separate mistakes in one request:

1. `human-questions.mjs` matched the **bare** word `coordinate`/`posizione` in
   `q_position`'s pattern, so *«mi comunichi le coordinate?»* — coordinates *of
   the diamonds* — was answered with the bot's own position.
2. The memory answer came first: a container the bot had inspected hours earlier
   (60+ blocks away) was offered as "where the diamonds are", while the vein in
   sight — `deepslate_diamond_ore (61,-6,199)` at 8 blocks — was never mentioned.
   `GET /memory/where?item=diamond_ore` returns `hits: []`: the chest row was the
   only diamond the *memory* knew, and the live sighting was not the memory's job.

Fix:

- `human-questions.mjs`, `q_position`: the position nouns are only a question
  about the bot when no genitive follows —
  `(?:posizione|coordinate|position|coordenadas|koordinaten)(?!\s+(?:di|del|dello|della|dei|degli|delle|de|of|du|des|von|der|el|le))`.
  *«coordinate dei diamanti»* is therefore not a question about the bot
  (`q_none`), while *«quali sono le tue coordinate?»* still is.
- `memory-chat.mjs`: `POSITION_NOUN` (the bare nouns) joined `WHERE` in the
  consult branch, so *«dove sono i diamanti da minare?»* is a consult; `SELF_REF`
  grew to the possessives (*le tue / la tua / i tuoi / il tuo / your / tes / ton /
  ta / deine / dein / tus / tu* followed by a position noun) so a question about
  the bot's own position is never read as a memory consult.
- `controller.mjs`: `nearestLiveOre (obs, intent)` — the **vein in sight** is
  answered before the memory. The ore core is the shared prefix of names
  (`String(name).replace(/^deepslate_/,'').replace(/_ore$/,'').split('_')[0]`)
  compared with the core of the item asked for, nearest first. The reply uses the
  new catalogue key `told_ore_near` and logs `tell_where_ore {from, xuid, item,
  word, ore, position, distance}`. `/memory/where` is still consulted when no
  vein is visible.

The answer is one line with the ore, its position, the dimension, the distance
from the bot and the provenance (*visto da me*), and it writes nothing.

## C — an order reported as done after its criteria were emptied

`actions.jsonl` (run `diamond-20261007-1`) shows the bot really did mine the
diamond three times — and the drops were already taken by the human («ho gia
raccolto i diamanti che hai trovato», 19:45):

```
{"t":1791403233461,"key":"mine_deepslate_diamond_ore","ok":true,"ms":6403}
{"t":1791403302705,"key":"mine_deepslate_diamond_ore","ok":true,"ms":4557}
{"t":1791403328879,"key":"mine_deepslate_diamond_ore","ok":true,"ms":3936}
```

The `goal_met` event (t 1791403571673, 226 steps) carries an inventory whose only
diamond-family key is `cobbled_deepslate: 13` and `dropped: []`. The plan chain
just before it:

```
1791403456605 plan targets={"diamond":1}  waypoint={"x":34,"z":207}
1791403544895 plan targets={}             (key "construction": free an inventory slot)
1791403545323 replan
1791403571673 goal_met
```

Cause, in `controller.mjs`: the final branch of `goalMet` falls back to the
run-wide `TARGETS` when the plan declares none —

```js
const targetMap = plan.targets && Object.keys(plan.targets).length ? plan.targets : TARGETS;
const targets = Object.entries(targetMap).every(([item, n]) => (obs.inventory[item] || 0) >= n);
const w = plan.waypoint || WAYPOINT;
const at = !w || Math.hypot(w.x - obs.position.x, w.z - obs.position.z) <= 2;
```

With `plan.targets = {}` and no `TARGETS` on the command line, `every()` over an
empty map is **vacuously true** and `at` is true without a waypoint: the goal
closed. The existing guard for orders without criteria
(`(!humanOrder || !openPlan || hasWorked)`) was bypassed because `hasWorked` was
true — 226 successful actions are enough to look like work.

Fix: `humanOrderTargets (goal)` returns the non-empty target map recorded **when
the order was born** (`goal.humanOrder.targets`, else `goal.parameters.targets`),
and the met check treats it as the floor of the plan:

```js
const orderFloor = orderTargets && Object.keys(orderTargets).length ? orderTargets : null;
const targetMap = plan.targets && Object.keys(plan.targets).length ? plan.targets : (orderFloor ?? TARGETS);
```

A replan may therefore drop, rewrite or reorder the plan — it cannot cancel the
criterion the human asked for. An order that never meets it ends on
`budget_exhausted`, not on a false `fatto`. `parameters.targets` is now written
at both places where a chat goal is born (`waitForGoal`, and the order that
reorients the running goal).

## D — the honest refusal that no one saw

```
1791403622383 chat_reply ack      "@<human> ok: butto via diamanti dall'inventario"
1791403622475 chat_reply {to:null, context:'drop_no_item',
              message:"@? non ho diamanti in inventario, non posso gettarlo",
              ok:false, error:'rate_limited'}
1791403622478 outcome              "@<human> non ce l'ho fatta: item_not_in_inventory", error:'rate_limited'
```

92 ms after the ack, the truth was addressed to `@?` and dropped. Two defects:

1. **The addressee.** The four blocked-reply paths (equip/drop/collect/farm) in
   `runGoal` read `goal.humanOrder?.from ?? null`, which is `null` for a goal born
   in chat, so the text was rendered with an empty name (`renderAnswer` →
   `@?`). The correct fallback existed only in the outcome message. Fix: one
   `const humanSender = goal.humanOrder?.from ?? goal.parameters?.from ?? null;`
   used as **both** `from` (the text) and `to` (the `chat_reply` journal field —
   the journal was also losing the recipient).
2. **The rate limit.** The adapter drops a chat message that arrives inside
   `CHAT_MIN_INTERVAL_MS` (1000 ms, `CHAT_MAX_LENGTH` 256,
   `bedrock-adapter.mjs` `sendChat`) and answers
   `{ok:false, error:'rate_limited', retryInMs}`; `replyChat` ignored `ok`. Fix:
   when the harness says when, wait that long (clamped to
   `CHAT_REPLY_RETRY_MS` 1200 … `CHAT_REPLY_RETRY_MAX_MS` 4000) and send it
   again, logging `chat_reply_retry {to, context, waitMs, ok, error}`.

A reply that cannot be delivered is now either retried or **loud in the log**; it
is no longer silently replaced by the ack.

## The bot reports what it finds (ore alert)

Requested in the same conversation: *«mi piacerebbe anche dirgli seguimi e
comunicami se vedi dei diamanti durante il cammino»*.

The adapter already censuses `valuableOres` on every scan; it now also
*announces*. The split of responsibilities is deliberate:

- the **adapter** detects and sends (`_alertNewOres`, called by `_scanValuableOres`),
  because it owns the census and `sendChat`;
- the **harness** injects the text — `adapter.oreAlertText = (ore) => t(lang,
  'ore_alert', {ore, pos: formatPosition(ore.position), distance})` — so the
  adapter holds no internationalisation and the numbers are formatted by the same
  helper the memory replies use. A coordinate never passes through a model.

Rules:

| Rule | Constant / behaviour |
|---|---|
| which ores | `ORE_ALERT` (default `diamond`; comma/space list; `off`/`none`/`0`/`false`/empty = silence), parsed by the exported `oreAlertCores()` |
| how far | `ORE_ALERT_RANGE` (default 32) |
| once per vein | the nearest sighting marks every fresh sighting within `ORE_ALERT_SPOT_RADIUS` (6) as seen, so five adjacent diamond blocks are one message |
| once per position | `oreAlertSeen` keyed `core@x,y,z`, FIFO-capped at `ORE_ALERT_SEEN_MAX` (4000) |
| not a machine gun | `ORE_ALERT_COOLDOWN_MS` (5000) between two alerts; an ore announced later is not lost |
| what it says | catalogue key `ore_alert` in the five languages: «ho visto {ore} a {pos} — {distance} blocchi da me» |
| visible | `observe().oreAlert` = the last alert (or `null`) |

The alert works **without a controller** (the harness owns it), which is why it
survives the controller being restarted; it is not a goal and does not preempt
anything.

## E — the answer that is reasoned, not recalled (M12)

Requested by the owner on 2026-10-07, after reading the repaired replies: *«se ti
chiedo una qualsiasi domanda e ti scrivo ragiona nel mezzo, tu puoi evitare di
passare da frasi fatte e passare dal system two del suo cervello?»*. Until then
the deterministic channel answered every question with a sentence **looked up**
in the catalogue (M6/M7.2); with the marker the sentence is **composed** from the
facts, by the chat model of M7.

```text
@bot ragiona: perché non stai minando?
  chat_reason {ok:true, via:'llm', model:'deepseek/deepseek-v3.2', ms:812}
  chat_reply  {context:'reason', to:'<human>',
               message:"@<human> sto scavando verso il ferro, ma il piccone di ferro non ce l'ho:
                        l'ultima azione è fallita con movement timeout"}
```

The design decisions, in the order they matter:

1. **The marker is a word, not a substring.** `reasonRequest` splits the message
   into words and separators, compares each word folded (`NFD`, diacritics
   dropped, lowercased — so `réfléchis` and `reflechis` are the same word), and
   removes **every** occurrence. The punctuation that belongs to the marker goes
   with it (`ragiona:` loses the colon), the punctuation that is the question
   stays (`ragiona: perché non mino?` keeps the `?`; `piensa: ¿por qué?` keeps
   the inverted `¿`). `spiegami il tuo ragionamento` is not a marker.
2. **It is stripped before anything else reads the message.** The dedup key, the
   memory parser, the question router and the model all see the sentence without
   it; only the journal keeps the fact that it was asked for.
3. **A reasoned question is still a question.** The branch runs only on
   `reasoned && looksLikeQuestion(message)` — «ragiona: prendi la terra» stays an
   order (and its ack is composed by the model too), and a reasoned statement
   that is not a question goes down the ordinary path instead of silencing the
   human.
4. **Facts, not imagination.** The prompt is the M7 one (only the listed facts,
   say what is missing) plus one line for the requested reasoning, and the facts
   are `compactChatFacts` extended with what a *reason* needs: the last six
   actions with their `stagnant` flag, the last result (action, ok, error) and
   the three nearest ores. `DEFAULT_REASON_MAX_TOKENS` (220) replaces the
   120-token budget so an answer can name what went wrong and what is missing.
5. **Never silent, never a new power.** A cooldown (`CHAT_REASON_COOLDOWN_MS`,
   5000, per sender) or a failed call logs `chat_reason {via:'cooldown'|'fallback'}`
   and falls through to the ordinary path, which answers from the catalogue: the
   human gets a sentence either way. The marker changes the **reply** and nothing
   else — no action, no goal, no memory write — and the reply is addressed by the
   controller (`@<sender>`), never by the model.
6. **Off by default with the engine off.** `CHAT_REASON` defaults to the state of
   M7: no key (or `CHAT_LLM=off`) means no reasoning either.

## Test matrix

| Property | Test |
|---|---|
| a denial / a report of speech writes nothing; the three original phrases still parse | `tests/memory-chat.test.mjs` |
| a bare position noun is not a question about the bot; the genitive forms are `q_none`; the possessives still are `q_position` | `tests/memory-chat.test.mjs` + `tests/human-questions…` |
| the vein in sight is answered before memory, in one line, with no write | `tests/controller-told-facts.test.mjs` (8 cases) |
| a replan that empties the targets does not close the order | `tests/controller-chat-open-plan.test.mjs` (3) |
| the refusal is addressed to the requester, and a `rate_limited` ack is retried | `tests/controller-chat-ack.test.mjs` (26) |
| one alert per vein, honoured cooldown, off = silence, `oreAlertCores` parsing, `_scanValuableOres` integration | `tests/bedrock-ore-alert.test.mjs` (7) |
| «ragiona» is found in five languages and leaves the question intact; without it the catalogue answers; a reasoned order stays an order; the cooldown falls back instead of going quiet | `tests/chat-llm.test.mjs` (4) + `tests/controller-chat-reason.test.mjs` (4) |

Each of the first three controller tests was run **without** its fix and failed
(3/1, 21/1, 26/1), so the test really pins the defect.

## Open

- The four fixes and the alert are covered by `node --test` only: the next live
  round has to confirm the in-game wording and the alert's timing during a
  follow.
- The reasoned answer (M12) has never run against a real provider: the cost of a
  long answer, the wording in German and Spanish and the behaviour of a model
  that ignores the one-line rule are all unmeasured. The word list is a starting
  point, not a translation review.
- M7 was **off** in production (no `DEEPSEEK_API_KEY`, no `CHAT_LLM_*` in the
  controller environment), so the «frasi fatte» the owner complained about are
  the expected behaviour of the deployed configuration, not a defect. Turning it
  on is an env change (`CHAT_LLM_API_KEY`, `CHAT_LLM_URL`, `CHAT_LLM_MODEL`),
  with no code change.
- The alert needs a **harness** restart (adapter + harness changed) while the
  controller fixes need a controller restart; the two are separate deploys.
- `_scanValuableOres` still pays the cost of the old scan shape
  (`docs/raw/` and `docs/wiki/open-questions.md` track the bounded-scan fix).
