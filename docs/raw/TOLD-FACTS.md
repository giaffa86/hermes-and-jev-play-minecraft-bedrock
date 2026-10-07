# Roadmap — Told facts (facts dictated by a human)

> Raw source (spec + reference). The readable synthesis lives in
> [`wiki/memory.md`](../wiki/memory.md) § *Told facts* and
> [`wiki/human-command.md`](../wiki/human-command.md) § *Told facts (M10)*.
> Status: **implemented and unit-tested (2026-10-07)**; not yet exercised against
> a live BDS.
> Code references: `memory-chat.mjs`, `world-memory.mjs`, `memory-store.mjs`,
> `sqlite-memory.mjs`, `bedrock-harness.mjs`, `controller.mjs`,
> `human-questions.mjs`, `human-replies.mjs`, `chat-i18n.mjs`,
> `chat-lang/{it,en,fr,es,de}.mjs`, `tests/memory-chat.test.mjs`,
> `tests/memory-told.test.mjs`, `tests/controller-told-facts.test.mjs`.

## Objective

Let a human *teach* the bot facts about the world that the bot cannot measure —
or would take too long to measure — and have those facts drive behaviour later:

> «Ricordati che il ferro sta nel baule a 120, 64, -230»
> «Segnati che l'ingresso primario della miniera sta a 130, 62, -240»
> «Il punto dove mi trovo adesso è il campo di patate, registra l'informazione»
> «Dov'è il campo di patate?»
> «L'ingresso principale della miniera ora è a…»
> «Dimentica il vecchio deposito»
> «Vai al campo di patate»

Four operations — **remember, consult, correct, forget** — plus one consequence:
a named place must be usable as a *destination* without repeating its
coordinates.

## The one rule that shapes everything

**A fact that was said is not a fact that was seen.** The memory already had a
`source` field (its producers were the bot's own sensors: `_observe`, the
structure detector, the container reader, the village sweep). Told facts reuse
it with `source: 'told'` and add the teller: `toldBy`, `toldAt`, and
`permanent: true` for a named place.

- **Provenance is never collapsed.** `toldFor(record)` returns what was said,
  by whom, when, and the place's correction history; an answer built on it can
  say *"(me l'hai detto tu)"* instead of pretending the bot saw it.
- **`permanent` is the TTL exemption, not a priority.** A named place
  («l'ingresso della miniera») has no automatic expiry: nobody would ever
  re-visit it by accident, so a time-based stale would demote it for the only
  reason that time passed. `markStaleBefore({keepPermanent: true})` — the call
  `refreshStatuses` makes for every non-container record — skips them. A
  *container* named by a human is **not** permanent: its position ages like any
  other chest; only the *content* has a different semantics.
- **Forgetting is invalidating, never deleting.** `forgetPlace` writes
  `status: 'invalid'` plus `invalidReason`/`invalidatedBy`/`invalidatedAt`. An
  invalid record is excluded from search, answers and navigation by default
  (`includeInvalid: false` everywhere) and remains readable in history — the
  memory is historical, and "what the bot used to believe" is part of it.
- **Correcting keeps identity and history.** `correctToldPlace` reuses the same
  `id`, appends the previous position to `history[]`, and *keeps the original
  provenance*: a human correcting a place the bot had discovered does not turn
  that observation into a told fact (`source` stays `discovered`, `permanent`
  stays false, but `toldBy`/`history` record who moved it).

## A claim about a chest is partial — it is not an inventory

«Nel baule di casa c'è del ferro» is weaker than opening the chest, and the
model keeps the difference:

- The written fact is a **discovery** of the chest (position, `label`, `type`,
  `source: 'told'`, `toldBy`/`toldAt`) with `contentsKnown: false` — it never
  writes `contents` and never sets `contentsKnown: true`.
- The *claim* lives in the observation log as
  `predicate: 'claimed_contains'`, `data: {count, toldBy, partial: true}`.
  Observations are history; a claim is one line of it.
- `claimsFor(containerId)` computes the **verdict from the reading**, not from
  the claim itself: `unverified` (never re-read after the claim), `confirmed` (a
  later read found it), `contradicted` (re-read and it was not there — a read
  *before* the claim says nothing about it), and `stale` past
  `toldClaimStaleMs` (default 7 days, constructor option).
- Consequences the code enforces: a later *discovery* of the same chest cannot
  erase an observed inventory (that was the V0 property of
  `world-memory-container-facts.test.mjs`); `whereToFind` ranks an observed
  reading above a claim and never offers a contradicted one; a claim is never
  presented as "all there is".
- Naming a chest an already-known chest does not create a second record: the
  container *is* its position (`containerId(position)`), and the label is
  written onto that record through the same discovery path (`contentsKnown:
  false`), leaving the observed contents untouched.

## Reading the sentence (`memory-chat.mjs`)

A pure module — no network, no model, no imports from the memory layer — that
turns a chat line into an intent, in the five catalogue languages.

- `toldIntentFromText(text, {sender, names})` → an intent or `null`. `null`
  means *"not a memory order"* and sends the message back to the ordinary chat
  flow, so the detector can be inserted **before** the question router without
  stealing anything.
- Branch order: `FORGET` → `CORRECT` → `REMEMBER` → `GOTO` → `CONSULT`. The
  order matters: "dimentica che il baule è a…" must not be read as a remember.
- **Coordinates only with an explicit marker** (`COORD_INTRO`, `x= y= z=`, a
  triple/colon form, a triple after a place preposition, …). A bare run of
  numbers inside a sentence is not a position: «ricorda che ne ho 120» must not
  become a waypoint. A recognised command whose numbers *look* like coordinates
  but carry no marker is answered with `no_marker` and writes nothing.
- `isWorldPosition` bounds: integers, |x|,|z| ≤ 30 000 000, y ∈ [-64, 320].
- **Token-level rewriting.** The text is split into tokens (raw + folded, 1:1)
  and `drop(pattern)` marks tokens whose *start* falls inside a match — this is
  what stops the final "a" of "ricorda" from being read as a preposition, and
  what lets the accented letters (`à`, `è`, `ù`) survive. `extractPlaceName`
  strips the coordinate clause, the memory/correction verbs, dangling
  connectors and leading prepositions, then keeps the side of the copula the
  deictic points at: «questo **è** il campo di patate» → *campo di patate*.
- **Deictics and the sender.** «questo», «qui», «il punto dove mi trovo» need a
  position. The parser receives the sender, and when it cannot see one it
  returns `{kind: 'clarify', reason: 'no_sender_position'}` — the caller asks
  for coordinates instead of guessing.
- `CONSULT` carries *both* a possible name and a possible resource, because
  «dov'è il campo di patate?» contains the word *patate*: which of the two the
  human meant is decided by the caller (the place first, then the resource),
  never by the parser. `countFromText` runs **after** the coordinate clause is
  gone, otherwise the "120" of the position would become the quantity.

## HTTP surface (`bedrock-harness.mjs`)

Behind `TOLD_FACTS` (`on` by default; `off` answers 403
`{error:'told_facts_disabled'}` on writes). A write is an order a human gives,
so it passes the same gate as the orders: if `CHAT_ALLOWLIST` is set in the
harness environment too, a fact attributed to a sender outside it is refused
with 403 `{error:'told_sender_not_allowed', toldBy}` — a write with no `toldBy`
is not a human order (local console, maintenance) and stays possible.

| Route | Meaning |
|---|---|
| `GET /memory/places?name=&limit=&toldOnly=1&includeInvalid=1` | named places (all of them without `name`); a name may match several — never auto-resolved |
| `GET /memory/where?item=&limit=` | where an item is, with `source: observed\|told\|discovered` and the claim verdict |
| `GET /memory/claims?containerId=&item=` | the claims on a container, each with its verdict |
| `POST /memory/tell/place` | remember/correct a named place (`{name, label, type, position, dimension, id, requireExisting, toldBy}`) → `{action: created\|corrected\|unchanged\|ambiguous\|unknown}` |
| `POST /memory/tell/container` | name a chest (discovery only — no content) |
| `POST /memory/tell/contents` | a partial claim (`{position, item, count, label, type, toldBy}`) |
| `POST /memory/tell/forget` | invalidate by `{name}` or `{id}` |

Writes go through `tellPlace`/`rememberContainer`/`claimToldContents`/
`forgetPlace` — the routes are a thin shell, so the rules live in one place and
the future console can call the same operations.

`created` means the name was new; `corrected` means the place was already known
and moved (identity and history kept); `unchanged` means the phrase repeated the
place exactly as it is (same position, dimension and name) and **nothing was
written** — the most common case, since the human does not know they already said
it. The id is an identity, not a location: it keeps the slug of the first time
(`campo_di_patate_120_64_-230` still after a move), which is why the position must
always be read from the record.

## Chat flow (`controller.mjs`)

`handleToldFact(obs, entry, {message, prefixes})` is called inside
`maybeHumanCommand` **after the dedup and before `resolveQuestion`** and returns:

- `true` — the message was answered (a write, an answer, a clarification);
  `maybeHumanCommand` continues to the next message and **no goal is created**:
  remembering/consulting/correcting/forgetting never interrupt the running goal;
- a **plan** — only for `GOTO_PLACE`: `{objective, targets:{}, waypoint:{x,z},
  follow:null, notes}` logged as `deterministic: 'told_goto'`. A movement order
  is an order like the others: normal preemption and resume apply, and no model
  is called. If the name is not in memory the function returns `null` and the
  message goes back to the ordinary flow (Hermes and the semantic recall may
  still know something); if the order was an *escort* («accompagnami al campo di
  patate») it also returns `null`, because a guided walk is not a waypoint;
- `null` — not a memory order.

Details that matter:

- **Every reply is addressed and comes from the catalogue** (`toldSay` → `t` +
  `renderReply` + `clampMessage`), never from the model: a confirmation must
  state exactly what was written, and *numbers are the information*. The 22
  `told_*` keys live in all five language files.
- **The sender's live position** is read by `senderPlace` from `obs.humans` then
  `obs.entities` (kind `player`), rounded, with `obs.dimension`; not found →
  `no_sender_position`.
- **Ambiguity is asked, never resolved by distance**: two places with the same
  name produce `told_ambiguous` with the options listed, and nothing is written.
- **An incomplete but recognised command writes nothing** and asks (`no_name`,
  `no_position`, `no_marker`, `no_sender_position`).
- A memory route that is down produces `told_memory_unavailable` with the reason
  instead of an invented answer.
- Events: `tell_place`, `tell_container`, `tell_contents`, `tell_correct`,
  `tell_forget`, `tell_where_place`, `tell_where_item`, `tell_where_none`,
  `tell_unknown_place`, `tell_ambiguous`, `tell_clarify`,
  `tell_memory_unavailable` (all with `from`/`xuid`).

## Test matrix

| Property the owner asked for | Where it is pinned |
|---|---|
| Persistence across a restart | `tests/memory-told.test.mjs` (both backends, place + label + claim) |
| The sender's position, and its absence | `tests/controller-told-facts.test.mjs` (write with the sender's position; clarify with none) + `memory-chat.test.mjs` |
| A partial claim cannot erase an observed inventory | `memory-told.test.mjs` (contents stay `{coal:3}`, `contentsKnown` stays true) |
| Ambiguity asks, never the nearest | `memory-told.test.mjs` (`ambiguous`, nothing written) + `controller-told-facts.test.mjs` |
| Correction keeps identity and history | `memory-told.test.mjs` (same id, `history[0]`, provenance preserved for a discovered place) |
| Forget invalidates | `memory-told.test.mjs` (gone from search/answers/navigation, present with `includeInvalid`) |
| Differentiated TTL | `memory-told.test.mjs` (told place stays `known`, observed landmark goes `stale`, claim ages into `stale`) |
| Navigation by name | `memory-told.test.mjs` + `controller-told-facts.test.mjs` (`told_goto` waypoint) |
| The sentence in five languages | `memory-chat.test.mjs` (the three original phrases, negatives, bounds, formatting) |

## Live deploy (07/10/2026, VM 100)

The runtime was deployed on the production harness `hermes-jev-bedrock` (VM 100)
as a **targeted deploy** of the eleven changed files on top of `main` (`3c6122e`,
which the container matched file for file — md5 comparison), commit `c70acc5`,
with `node --check` and md5 verification on all eleven in the container and in
the VM source tree, and backups (`/tmp/hermes-jev-bedrock-pre-c70acc5.tar.gz`,
`/tmp/app-pre-c70acc5.tar.gz`) before anything was replaced. The bot needed the
documented `systemctl restart minecraft-bedrock` on CT 108 to get in; with it in
the world, the round was driven live over HTTP against the **real** world
memory:

| Step | Live result |
|---|---|
| `tell/place` «campo di patate» at 92/74/169 | `created`, `source: 'told'`, `permanent: true`, `historyCount: 0`; found by `GET /memory/places?name=` |
| the same phrase again | `unchanged`, `historyCount: 0` (a repeated fact writes nothing) |
| the same name at 130/70/-240 | `corrected`, **same id**, `historyCount: 1`, `previous` with the old position |
| container restart | place (with history) and claim still there — persistence |
| `tell/contents` 5 iron on the chest at 91/73/160 (411 iron already **read**) | container keeps `source: 'discovered'`/`permanent: false`, gains the label «baule di casa» and a separate `unverified` claim; `GET /memory/where?item=iron_ingot` still answers the **observed** 411 |
| `tell/forget` | `status: 'invalid'` + `previous`; out of `GET /memory/places`, present with `includeInvalid=1` |
| `GET /options` / `GET /survival` | 25 keys / `normal` — the harness paths survived the deploy |

Left in the production memory, disclosed rather than hidden: the invalidated
test landmark and the label «baule di casa» plus the unverified iron claim on
that chest (the next real reading confirms or contradicts it). On the container
`CHAT_ALLOWLIST` is not set, so the sender gate on the writes is inert there.
The **in-game chat** round is not covered by this: it needs a controller with
`CHAT_ALLOWLIST` running and a human typing the sentence.

## Open points

- **Not typed in chat yet.** The live round above went over HTTP; no sentence in
  this list has been typed into a live BDS, so the chat *reply* path is still the
  one every other milestone has also only unit-tested (`replyChat`/`saySmart`
  with a scripted harness).
- **The console is a separate branch** (`feat/companion-webconsole`): the routes
  were designed to be callable by it, but nothing here imports it, and no code
  in this feature depends on it.
- **`GOTO` does not yet mark the goal as reached-by-memory**: the plan carries
  `notes: human:<from> told_place:<id>`, but the success criterion is the plain
  waypoint. A future slice could verify arrival against the remembered position
  (and say so).
- **Place names are matched by exact name** when deciding whether a sentence
  corrects an existing place. Two deliberately different names for one place
  ("il campo" vs "campo di patate") therefore create two records; the ambiguity
  reply is the safety net, not a fix.
