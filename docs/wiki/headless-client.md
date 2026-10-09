# How the bot sees and acts in the world (headless client)

Recurring questions, answered in one place:

- Is the bot **headless** or graphical?
- How does a process with no game window complete tasks inside the server?
- How does "blind"/fuzzy exploration work (e.g. "get me some iron")?
- Does it **see through walls** like x-ray?
- Does it have the **same render distance** as a human player on a graphical client?
- Is the bot **visible to other players**, or is it a ghost?

Short answer: the bot is **fully headless** — no window, no rendering, no
screenshots, no simulated keypresses. It is a Node.js process that speaks the
server's **network protocol** directly. The model never sees pixels and never
emits raw input; it picks **one action from a menu** and a harness executes it in
the real world. Its "vision" is **short-range x-ray**, not a camera: it sees
specific block types through walls but only within a few tens of blocks, and it
has no real exploration strategy.

---

## 1. Headless vs graphical

| Aspect | Graphical client (vanilla) | This project |
|---|---|---|
| World rendering | Yes (GPU, drawn chunks) | No |
| Input | Keyboard + mouse | None; protocol packets |
| Perception | Eyes on the screen | State rebuilt from server packets |
| Screenshots as a channel | Yes | **Never** ("no screenshots, no keypresses, no generated code") |
| Executor | A human player | `bedrock-adapter.mjs` (Node.js) |

The bot exists on the server exactly like a real player: it has an authenticated
Xbox/Microsoft account, is on the BDS allowlist, and the server assigns it
position, inventory, health and hunger like anyone else. The only difference is
that on the client side there is no human at a screen, but a process reading and
writing packets.

### 1.1 Visible to other players — not a ghost

"Headless" describes the bot's **own** side (no window, no rendering); it says
nothing about how others see it. To the server, and therefore to every human
player, the bot is a **normal, fully visible player**:

- it appears in the **player list** (an explicit Phase-3 acceptance criterion:
  *"appear in the server player list"*);
- it is **rendered in the world** with a body — not as an NPC, fake entity or
  command-block automation (those are explicitly forbidden by the goal);
- it wears the **default skin** (Steve/Alex): `bedrock-protocol` sends
  `minecraft-data`'s `defaultSkin` in the login handshake
  (`node_modules/bedrock-protocol/src/handshake/login.js`); no custom skin is
  configured, but the body is there and visible;
- it **moves like a player**: server-authoritative movement (`player_auth_input`)
  with walking, jumping, digging and the arm-swing animation — no teleporting,
  no entity that "glides".

| | How the bot appears to *others* | How the bot perceives the world |
|---|---|---|
| In the player list | Yes (its `BEDROCK_USERNAME`) | n/a |
| Rendered in the world | Yes, default skin | n/a (no rendering at all) |
| Entities | — | 24 blocks (`/observe`), 32 (hostiles) |
| Blocks | — | ~±40 blocks, x-ray (see §6) |

The asymmetry is only in **perception**: a human sees the bot up to the full
render distance, while the bot "sees" entities only at 24–32 blocks. The bot is
no more invisible to you than you are to it.

---

## 2. Architecture: three layers

```
controller.mjs                      planning / decision making
  │  (Hermes plans, Jev picks one action)
  │  HTTP: GET /observe, GET /options, POST /act, POST /plan, GET /survival
  ▼
bedrock-harness.mjs                 owner of VALIDITY (API :3077)
  │  offers only the actions that are executable right now
  ▼
bedrock-adapter.mjs                 Bedrock protocol client (~174 KB)
  │  network packets over NetherNet
  ▼
BDS 1.26.x                          the real Bedrock server (CT 108)
```

The contract is strict: **validity belongs to the harness**. The controller only
chooses one key among those returned by `GET /options`; it cannot invent actions,
coordinates or sequences. When the model "misbehaves", what gets fixed is what
`/options` offers — not the prompt.

---

## 3. Perception without a screen

The world is never drawn; it is **rebuilt** from what the server sends.

| Information | Packets / path | Ends up in |
|---|---|---|
| Blocks and chunks | `level_chunk` + `subchunk_request`/`subchunk` (Prismarine v9 decoder, 1.26 registry) | `adapter.world` → `blockAt()` |
| Bot position | simulated input + `correct_player_move_prediction` | `_feet`, `position` |
| Entities (mobs/players) | `add_entity`, `add_player`, `move_entity`, `move_entity_delta`, `set_entity_data` | `adapter.entities` (type, position, distance, health) |
| Health / hunger / XP | `update_attributes` (`current` field) | `health`, `food`, `experience` |
| Time of day | `sync_world_clocks` (`% 24000`), fallback `set_time` | `time` (day/night) |
| Inventory | `inventory_content` + `item_stack_response` | `inventory`, `inventorySlots` |
| Death / respawn | health ≤ 0 + `Respawn` flow (`state = 2`) | `dead`, `deaths`, `deathSite` |

All of this is normalized into a compact state exposed by `GET /observe` (plus the
compact Survival Governor verdict). It is the only "view" the model has of the
world: structured numbers, never images.

---

## 4. Acting without a keyboard

Every action is a sequence of **protocol packets**, not physical input.

### 4.1 Movement — `player_auth_input` (server-authoritative)

BDS 1.26 uses **server-authoritative** movement: the client cannot teleport by
sending arbitrary coordinates (`move_player` is discarded / rewound).

The adapter instead:

1. **simulates physics locally** — walk at `0.2158` blocks/tick (≈ 4.317 m/s),
   gravity `0.08` blocks/tick², jump `0.42`, collisions, steps, falls. Low
   surfaces a real client auto-steps onto (`*_carpet`, `*_path`, `moss_carpet`,
   ≈ 0.06–0.19 blocks high) count as **floor** in the feet cell (`_lowProfile`):
   a rug is not a wall. The head cell stays strict, and slabs/stairs/beds (0.5–0.56)
   stay solid on purpose — they need a real step-up the model does not simulate;
2. sends a `player_auth_input` each tick with the simulated position, `move_vector`
   and intent flags, staying inside the server's rewind window (40 ticks). The
   intent declared is the one **simulated in that tick**, not the residue the
   simulation left behind: `_authTick` takes a snapshot (`_motionIntent`) *before*
   driving the physics, because a walk whose local simulation finishes inside the
   same tick used to declare nothing (`move_vector {x:0,z:0}`, no `up`) and the
   server then never moved the bot — 9448 `auth_input` rows with no movement while
   the local feet advanced, every one answered by a correction (live 09/10/2026,
   row 47.83 of [verification](verification.md));
3. **plans with A\*** over the loaded world (support, ±1 steps, falls up to
   4 blocks) toward the nearest walkable node to the target — and **arrival is
   measured on the cell the path actually reaches**, among the complete
   candidates the one closest to the target: the planner's `y` is frozen from the
   starting position (`goto_waypoint`), so a 4+ block climb or drop used to make
   the arrival check unsatisfiable and burn three attempts into `path_failed`
   (live 03/10, cave floor → village). The result carries `goal`, the cell that
   was reached, next to `distance` to the requested coordinates;
4. opens closed doors encountered along the way (`click_block` / `item_interact`),
   **including the door cell the bot is standing in** — a villager can close a
   door on the bot and the server then refuses every step out of that cell
   (03/10); the body's own cells are also exempt from the collision test
   (`_collides(..., { ignoreSelf: true })`), so a solid block in the cell the bot
   occupies can never freeze the model. The openable family is **door, fence gate
   and trapdoor** (`_isDoorBlock`), not only `*_door` — a closed gate was not
   traversable for the A\*, was never clicked and `DIG_PROTECTED` (`_fence_gate$`)
   forbids breaking it, so a pen with a closed gate was a cage (08/10, the human
   had to open it by hand). The blocks to open are looked for in the bot's own
   cell, in the cell the yaw points at **and in the path nodes the route is about
   to cross**: leaving a house the next node is the door while the yaw points at
   the player outside, often diagonally, and the yaw-only search walked into it.
   A door the **world already reports open** (`_isOpenAt`, read from the block's
   own `open_bit`) is registered as open instead of clicked, because a click on an
   open door toggles it shut on the bot. Since 08/10 the **wait for that click is
   not a stall**: the waypoint stall defers while the click is inside its 3 s
   grace, and when the grace expires the move ends with
   `door_blocked {position, waitedMs, from}` instead of a bare `stuck` — a closed
   door that stops a walk has to be readable in the ledger, and until then three
   anonymous `stuck` rows were all it said;
5. accepts server corrections beyond `0.75` blocks (`MAX_CORRECTION_DRIFT`) and
   realigns the tick anchor.

### 4.2 Mining — `block_action` with vanilla physics

Real block breaking via `player_auth_input` + `block_action`, with server
confirmation and a destruction event. Before breaking, the adapter selects the
right tool (pickaxe/axe/shovel/hoe, best tier) and break times follow the vanilla
formula. The harvest rank is compared against the block's `harvestTools` set:
without a pickaxe of the right tier, the `mine_*` option is not offered at all.

### 4.3 Inventory and crafting — `item_stack_request`

Item movement, crafting and smelting are `item_stack_request` transactions
(take/place/swap with **stack ids**), valid only with a window open:

- `interact open_inventory` opens the 2×2 grid; `click_block` on a table opens the
  `workbench` window (3×3);
- each ingredient travels through the cursor (take → place), then a `craft_recipe`
  request with consumes and output;
- smelting uses the right station (furnace/blast furnace/smoker) and the
  `furnace_ingredient`/`furnace_fuel`/`furnace_output` slots.
- **A container's contents arrive in a separate `inventory_content` packet** for that
  window, so opening a chest is not enough: reading too early returns the *previous*
  window's slots (or an empty array), and writing that into the cache makes full chests
  look empty. The adapter records which window sent its contents
  (`_openContainerContentWindow`), resets it on every open/close, and waits for *its own*
  window (3 attempts, then the typed `container_content_timeout`).
- **Moving a grid ingredient must not change the window.** `_takeToCursor` opened the
  player inventory by default; with a `workbench` open that closed the 3×3 grid and every
  later `place` was refused with status 55 (`craft_bucket → place_failed_55`). The
  crafting path passes `{ ensureInventory: false }`; the equip paths keep the default,
  because they *need* the player window (`take`/`place` are only valid with a window open).
- Reading is bounded on purpose: `STORAGE_READ_LIMIT` (8) containers per action and a
  time budget (`STORAGE_READ_BUDGET_MS`), because a long read can end with the server
  dropping the session (see [open questions](open-questions.md)).
- **A `take` into a non-empty cursor is refused with 50** (`FailedToValidateDstSlot`), even
  when the stack being taken is the same item as the one on the cursor. The cursor is a
  single slot and the server validates it as the *destination* of every take, so one
  leftover stack paralyses the whole take path (`take_failed_50`). Live A/B on the deployed
  BDS (04/10): with an empty cursor, chest→cursor and cursor→`hotbar_and_inventory` are both
  `ok`; with a stack on the cursor, two different takes both answer `50`. `_takeFromContainer`
  now empties the cursor first (`_returnCursorToInventory`) and refuses with a typed
  `cursor_busy` when it cannot, and `_moveItemViaCursor` no longer clears `_cursor`
  optimistically after a failed place-back: that divergence is what used to make the refusal
  permanent, because every later cleanup is guarded by `this._cursor?.count > 0`.
- **The offhand is slot `1`.** Live A/B with a nautilus shell (an item the offhand accepts)
  on the deployed BDS: `place` → `offhand`/1 = `ok` (the shell lands there, `mob_equipment`
  aside), `place` → `offhand`/0 = `55` (`CannotPlaceItem`); an offhand-illegal item (kelp) is
  refused with `50` on both slots. `_equipShield` targets slot 1 and keeps slot 0 only as a
  fallback (`OFFHAND_SLOT` / `OFFHAND_FALLBACK_SLOT`).
- **A container target can come from the durable memory too.** `options()` merges the
  runtime cache (`_cachedContainers()`, expiring with `CONTAINER_TTL_MS`) with the
  remembered containers that hold items *and* are reachable (`_rememberedStorage()`),
  labelling the latter `(remembered: re-read on arrival)`. `_takeFromContainer` accepts
  either source, walks to a remembered target with `STORAGE_TAKE_WALK_MS` (75 s) instead of
  the 30 s default — a remembered chest can be twenty blocks away, and the live round of
  04/10 spent the whole default on a 21-block walk, timing out three blocks short — then
  opens the container and re-reads it. When the memory declares the item but no remembered
  container is reachable it answers `container_unreachable` with
  `"<n> remembered container(s) hold <item>, none is reachable now"` rather than denying
  the item exists. Live 04/10: after a restart, 8 `take_*` options all `remembered`, and
  `take_bucket` returned `{ok:true, item:'bucket', from:'chest', remembered:true, ms:546}`.
- **A remembered container that does not open stops being offered for a while.** The
  durable memory can be wrong about a cell: the live round of 04/10 offered `take_egg`
  from a chest remembered at (93,72,160) while the world has it one block higher, so every
  attempt paid `container_open_timeout` after ~10-18 s. `_ensureStorageOpen` now records
  the failure (`storage_open_failure`, `STORAGE_OPEN_FAILURE_MS` = 10 min) and the option
  disappears from `/options` until the cooldown expires; an **explicit** `/act` still tries
  it (the memory is a hint, not a veto), but it prefers a remembered container that has not
  just failed (log `container_take_retrying` when none is left). Live 04/10: 4 `take_egg`
  options before the failure, 3 after it, and the next `take_egg` took **16 eggs** from the
  healthy chest at (72,71,153) with `remembered:true`.
- **A read skips the containers that just failed to open.** `_readContainers` drops every
  cell in the open-failure cooldown (`_inOpenFailureCooldown`, log `container_read_skipped`)
  before spending the read budget: a chest that answers `container_open_timeout` cannot start
  working again inside the cooldown, and the live read of 04/10 spent 121 s to collect two
  readable chests because the budget went to hopeless cells. Offline: a read opens two
  containers with no failure recorded and only the healthy one after one
  (`tests/bedrock-storage.test.mjs`). The live proof is still pending — both attempts ended
  with the server dropping the session at ~34 s (`container_read_failed` → `not_connected`),
  the transport failure of [row 47.34](verification.md), not a fault of the filter.
- **The click that opens a container is prepared, escalated and declared** (08/10/2026, from
  [row 47.75](verification.md)). The live expedition stood 1.1–3.4 blocks from a chest for
  70 minutes with every attempt ending `container_open_timeout`, and the artifact said only
  that. Four holes closed: the block about to be clicked is **verified to be known to the
  client** first (`_ensureBlockKnown` refreshes the chunk section and waits, because an
  unloaded section makes `runtimeIdAt()` answer `null` → `block_runtime_id: 0`, which a
  server validating the declared block reads as «no block» and discards in silence — the
  same preparation the break confirmation does); the approach walks to **radius 2** (not 3)
  and closes to 1.5 when the sampled **sightline** is obstructed; an empty hand is filled
  from the second attempt; and every attempt is logged with distance, feet, face, runtime
  id, `blockAt`, held item and sightline (`container_open_attempt`, `container_open_failed`,
  `container_unknown_block`, `container_hand_selected`), with the same payload reaching
  `/act` and `storage_open_failure` through `error.details.attempts`. The read's own walk
  budget now obeys the action budget (`min(STORAGE_READ_WALK_MS, time left)`), so the four
  extra seconds per chest cannot push a read past `STORAGE_READ_BUDGET_MS`.
- **The prepared click is verified live** (08/10/2026, [row 47.76](verification.md)). The rebuilt
  harness read **8 of 8 containers in 18.4 s** on the first hand-driven `read_container`, against
  1507.8 s for 11 successful reads in the expedition of the same day, and the probe exposed three
  further holes that are now closed: the sampled sightline called the **target block itself** an
  obstruction (`["air","chest!","chest!"]` on a chest 1.8 blocks away), so
  `_sightlineTo(point, target)` names the target without the `!`; the read's walk ceiling rose from
  15 s to 30 s, because three of six attempts died `movement timeout` with `progressed: true` on
  21–23-node paths (still closed by `min(ceiling, time left)` and the 90 s budget); and a failed
  **walk** no longer sends the container into the ten-minute cooldown that hides it from
  `/options` — it logs `storage_approach_failure` instead, while a click that fails still cools
  down. The read budget now counts attempts rather than successes, so a read where nothing opens
  stops on time. The probe's four reads came back 8/8 each from 0 to 35 blocks away, with no
  `storage_open_failure`, no `container_read_failed` and no `container_read_skipped`.
- **The eight `take_*` slots are ranked by what the trip kit is missing too.** A plan whose
  targets fill the list (`take_diamond ×2`, `take_copper_ingot ×2`, `take_golden_leggings
  ×2`, …) used to hide `take_torch`/`take_coal` completely, so a chest could be open with
  the gear in it and the kit still impossible to complete (`_tripKitView().missing`, food
  excluded on purpose).
- **Refreshing the mirror must not cost the session.** Fresh stack ids used to come
  only from a reconnect (`disconnect` + `connect`), which against a BDS that has not
  released the previous NetherNet session fails with `connecterror:9` (negotiation
  `InactivityTimeout`) and gets worse with every retry. A player-window refresh is
  enough: `interact open_inventory` makes the server send `inventory_content` with
  the 36 slots. `_resyncByReconnect` tries that first (`_refreshInventoryFromServer`,
  logged `inventory_refresh`, then `inventory_resync_done {via:'refresh'}`),
  reconnects only as a fallback — after `INVENTORY_RESYNC_SETTLE_MS`, at most once per
  `INVENTORY_RESYNC_COOLDOWN_MS` (`inventory_resync_throttled`, 30 s) — and reports
  `inventory_resync_wedged` when the reconnect does not spawn. The in-place path
  refuses to close a window an action is using: a chest, a non-empty crafting grid or
  a stack on the cursor (`_canRefreshInventoryInPlace`).
- `POST /debug/isr` (BEDROCK_DEBUG) drives one stack request by hand
  (`type_id`/`count`/`source`/`destination`/…), can open a container first (`container`) and,
  with `apply`, records the answer in the local model — the same bookkeeping a real action
  performs.

### 4.4 Interactions — `click_block`, `item_use`, `item_use_on_entity`

- Doors, beds, furnaces, chests, crafting tables → `click_block` / `item_interact`;
- eating → `item_use` (`click_air`);
- attacking a mob → `item_use_on_entity` (`action_type: attack`) + `animate swing_arm`;
- trading/shearing/feeding/mounting a mob → `item_use_on_entity`
  (`action_type: interact`) with a free hand and no sneak, preceded by
  `interact { action_id: 'npc_open' }` for traders.

**Line of sight is part of "in range".** `_entityVisible (entity, { ratio = 0.5,
samples = 3 })` samples the eye→aim segment against the local block model and
names what blocks it (`{ visible: false, blockedBy: 'oak_planks', blockedAt, t }`);
it is **fail-open** on unloaded chunks (`unknown: true`). `_mountEntity` and the
trade loop call it before writing any packet, because the server silently ignores
an interaction with a target behind a wall — and villagers/traders **walk**, so the
trade loop re-checks reach and sight at every attempt (`trade_target_blocked`,
`trader_moved_away`).

### 4.5 Diagnosing an interaction: `POST /debug/probe-interact`

Gated by `BEDROCK_DEBUG=1`. Body:
`{ "type": "pig", "runtime_id": "716", "action": "attack"|"interact",
"variant": "<see PROBE_VARIANTS>", "observe_ms": 3000, "approach": true,
"interaction_model": "touch"|"crosshair"|"classic", "interact_rotation": {"x":0,"z":0} }`.
`approach` walks into reach first (the distance is re-measured afterwards, and a
failed approach lands in `sequence` as `approach_failed:<error>`);
`interaction_model` overrides the model declared in the auth frames (the default is
`touch`, which is what a phone client sends and what our transport used until now).
It looks at the target, samples the sightline, optionally walks into reach, sends
the chosen packet shape and reports
`{ sequence, sightline, distance, hand, heldName, selectedHotbar, healthBefore,
healthAfter, damage, resyncs, rxNames, containerBefore/After, offersBefore/After }`.
`variant: "none"` sends **no packet at all** — the baseline that proves whether the
`inventory_content` resyncs that follow are a reaction to our transaction (they
are) or a periodic synchronisation (they are not). `PROBE_VARIANTS` includes
`current`, `legacy_minus1`, `legacy_empty_list`, `numeric_type`, `animate_first`,
`eyes`, `flag_before`, `flag_after`, `hotbar`, `item_in_hand`, `legacy_seq`,
`click_low`, `mouse_over`. `_invResyncCount` and `_rxLog` (filled only with
`PACKET_DEBUG=1`) are the two counters behind the report.

`GET /debug/packet-debug?ms=5000&hex=inventory_slot,set_entity_link` (also gated by
`BEDROCK_DEBUG`) additionally logs the raw bytes of the named inbound packets as
`[rx_hex] { name, bytes }` (400 hex chars), which is how the `link`/`links` bug in
the mount confirmation and the `window_id: 2` saddle window were read off the wire.

### 4.6 Measuring swimming: `POST /debug/swim-measure`

Gated by `BEDROCK_DEBUG=1`. Body:
`{ "mode": "none"|"up"|"down", "ms": 3000, "sample_ms": 100, "enter": true,
"depth": 2, "max_distance": 6 }`.

The vertical intention is forced through `_swimProbe` (so the frame carries
`want_up`, `want_down` or neither) while the adapter samples **`this.position`**,
which the server owns (`move_player`) — the report is a measurement of the server,
not of our simulation: `{ mode, ms, sampleMs, headInWater, air, airSource, from, to,
deltaY, seconds, ratePerSecond, samples }`. Typed refusals: `unknown_mode`,
`riding`, `not_spawned`, `not_in_water`. The probe is cleared in a `finally`, so a
disconnect mid-measurement leaves no lingering flag.

`enter: true` walks the bot into water first (`enterWater`, one deliberate step,
no A*, because deep water is a wall for the planner) and merges its verdict into
the same report: `no_deep_water`, `water_covered` (a lid over the surface),
`no_water_at_level` (a column more than four blocks below the feet is a ravine,
not a step), `water_not_reached` (with `attempts`). Every refusal lists the
columns it considered.

### 4.7 A probe that can speak: `POST /debug/chat`

Gated by `BEDROCK_DEBUG=1`. Body
`{ "from": "Probe", "message": "che armatura hai?", "type": "chat" }`. A question
or an order could only ever be tested with a human in game, and the harness is
shared, so a probe cannot borrow the real chat: the message is pushed through the
**same** `_onChat` a packet uses (echo suppression, a pending clarification, the
inbox cap of 32, the ledger row), but two things are deliberately different. The
sender is rewritten to `sim:<from>` — a prefix no gamertag can carry — and the
entry carries `simulated: true`, so the row is logged as `chat_simulated` and
never as `chat`: **a probe cannot impersonate a player**, and the controller
still answers only if its `CHAT_ALLOWLIST` names that sender. The answer is
`{ ok, simulated, from, accepted, entry }`, where `accepted` is true only when
the last inbox entry is this message from this sender — a message the adapter
drops (an echo of the bot's own words, its own name) reports `accepted: false`
instead of a silent success. A malformed body is a `400`: a probe route must not
be able to take the bot down.

---

## 5. The bounded-action loop

The cycle is not "a model playing"; it is a loop of discrete, verifiable steps:

1. `GET /observe` → normalized bot state (+ Survival Governor);
2. `GET /options` → menu of valid actions right now (e.g. `mine_stone`,
   `goto_waypoint`, `sleep`, `craft_furnace`, `attack_zombie`, ...);
3. the controller picks **one key** and calls `POST /act {key}`;
4. the harness executes the action in the real world and returns the outcome;
5. repeat until the goal is met or the budget (`MAX_STEPS`) is exhausted.

The full trail lands in `runs/<run>/controller.jsonl` (plans and decisions) and
`runs/<run>/events.jsonl` (harness-side actions and results).

---

## 6. The perception model: short-range x-ray, not a camera

Because perception is the server's **block grid** and not light, the bot's
"vision" behaves very differently from a human's.

### 6.1 The "radar": `_refreshNearby()`

`bedrock-adapter.mjs:582` — on every position update the bot scans a **fixed
list** of block types:

```js
for (const name of ['dirt', 'grass_block', 'stone', 'cobblestone',
  'coal_ore', 'deepslate_coal_ore', 'iron_ore', 'deepslate_iron_ore',
  'copper_ore', 'oak_log', 'spruce_log', 'cherry_log', 'potatoes',
  'carrots', 'wheat', 'beetroots']) {
  this.nearbyBlocks[name] = this.world.findBlocks(name, this.position, 96, 4)
}
```

`findBlocks` (`bedrock-world.mjs:200`) iterates **only over loaded sections**,
within a **96-block sphere** (3D Euclidean), and returns **at most 4** nearest
blocks per type.

It returns the **block object itself** (a prismarine `Block`, with `distance`
attached), not a spread copy: spreading a Block drops its methods, and with them
`getProperties()`, so every block **state** read through `findBlocks` came back
unknown. That was a real production bug (2026-10-03): crop growth read as
`null` on the live server, which silently disabled the maturity gate. `blockAt()`
was never affected (it always returned the instance).

### 6.2 It sees through walls — within limits

There is **no occlusion or line-of-sight filter**. An `iron_ore` behind 20 blocks
of solid stone is reported with its exact `{x,y,z}` exactly like one in the open.
This is not a cheat: it is the same block data any Bedrock client receives to
render the world; a graphical client draws only visible faces, the bot reads the
data as x-ray.

But the x-ray is *bounded*:

| Limit | Value | Reference |
|---|---|---|
| Radius | sphere of **96 blocks** (theoretical cap) | `findBlocks(name, pos, 96, 4)` |
| Types seen | only the **fixed ~17-type list** | `bedrock-adapter.mjs:585` |
| Quantity | **max 4** per type (nearest) | `count=4` |
| Area | only **loaded chunks**, not the whole world | `bedrock-world.mjs:200` |

So: x-ray for specific types at short range, but **blind to everything else** (no
shapes, no colors, no distant terrain, no caves, no lava beyond the list).

### 6.3 Seeing ≠ mining

Perception is x-ray, but *action* is constrained. The `mine_<block>` option is
offered only when the block is:

- within reach (≤ 5.1 blocks) **or** has at least one **exposed face** (adjacent
  to air), and
- breakable with a pickaxe of the right rank.

`_pickMineTarget` (`bedrock-adapter.mjs:2024`):
`candidates.find(_blockInReach) || candidates.find(_blockExposed)`. A fully buried
ore is **visible in `/observe`** but **not directly mineable**: you must first
`dig_down` to reach and expose it.

---

## 7. "Blind"/fuzzy exploration: there is none

There is **no exploration strategy** in the code — no random walk, no strip
mining, no cave exploration, no prospecting (a grep for `explor|scan|wander` over
the source returns only the bed scan). What exists is a short-range radar plus one
digging action.

### 7.1 How "get me some iron" actually works

1. The free-text goal (`GOAL`) goes to the Hermes planner, which returns JSON
   `{objective, targets, waypoint, skill}`. For iron the targets are typically
   `{raw_iron: N}` (or `iron_ingot`), skill `acquire_iron`. In `CURRICULUM` mode
   the milestone graph `knowledge/progression.json` drives it (`iron_age` requires
   `stone_tools`, skill `acquire_iron`, satisfied by 3 ingots or an iron tool).
2. At each step the harness offers `mine_iron_ore` / `mine_deepslate_iron_ore`
   **only if** iron is inside the radar (loaded chunk, ≤ 96 blocks, nearest ≤ 4)
   and harvestable with a stone-or-better pickaxe.
3. The decision model picks it — the semantic link `iron_ore → raw_iron → smelt →
   iron_ingot` is **the model's** world knowledge, not code. The deterministic
   layer only provides coarse tiers (`controller-decisions.mjs:optionPriority`:
   generic `mine_*` is tier 7, `smelt_*`/`craft_*` matching a target are tier 4),
   anti-loop and the Survival Governor.
4. If **no iron is in range**, no mining option appears. The only indirect levers
   to bring iron into the radar are:
   - **`dig_down`** (`_digTargets`, `bedrock-adapter.mjs:2421`): digs **one step**
     of a staircase down and advances. Descending (a) reaches the Y levels where
     iron is more common and (b) loads new columns, so `_refreshNearby()` re-runs
     the radar after every step. Direction is steered toward the plan's `waypoint`
     if set, otherwise along the cardinal of the last yaw (`_digDirection`) — i.e.
     it digs a straight staircase in the direction it faces.
   - **`goto_waypoint`**: pathfinds to a waypoint (only if the planner set one),
     loading new chunks along the way.

There is no branching, no marking of veins, no "try another area" beyond a new
plan. The iron found in the live run `e2e-iron3` entered the radar while the bot
descended/moved; it was never actively prospected.

---

## 8. Render distance: not comparable

The bot has **no client render distance at all**. There is no
`request_chunk_radius` and no view/render-distance setting anywhere in the code.
It loads the world in two ways, both bounded:

1. `level_chunk` pushed by the server (spawn + movement) — passive;
2. `subchunk_request` the bot issues actively with `requestAround(client, pos,
   radius = 2)` (`bedrock-world.mjs:172`).

`radius = 2` requests subchunks from `-2..+2` on X/Z and `-2..+2` on Y around the
bot's own subchunk = a **5×5×5 box of subchunks ≈ 80×80×80 blocks**, i.e. roughly
**±40 blocks** around the bot.

The 96-block radar cap is therefore theoretical: `findBlocks` only iterates
`this.loaded`, so the effective horizon is `min(96, loaded area)` — in practice
~±40 blocks. `world.summary()` in `/observe` exposes the actual counters
(`columns`, `sections`).

Entities are even shorter-sighted:

| What | Radius | Reference |
|---|---|---|
| Entities in `/observe` | **24 blocks** (max 8) | `_nearbyEntities(8)` |
| Hostiles for attack/flee | **32 blocks** | `_hostiles()` |
| Entity pruning | beyond **64 blocks** or 60 s | `_pruneEntities()` |

A human sees players/mobs up to the full render distance (tens/hundreds of
blocks); the bot only "sees" them at 24-32 blocks.

Runtime ids are **per session**, and the census has to say so. Two paths used to
keep stale ones: a login (`start_game`) cleared the inventory mirror and not
`this.entities`, and an `add_entity` carrying an `unique_id` already known under
another runtime id added a second entry, leaving the old one with its type and
health until `_pruneEntities` dropped it 60 s later. Live in run 2 the bot
attacked the skeleton of its previous session: 25 `attack` packets whose target
health never moved from 12 (`attack_skeleton` → `died_in_combat`, `hits: 25`),
because `_combat` locks its target by runtime id on purpose (03/10: re-resolving
the nearest mob every swing spread the hits). Now `_trackEntity` drops the
previous runtime id when the same `unique_id` reappears (`entity_readded`),
`_onStartGame` clears the census, and a hit that does not move the target's
health counts as a miss — after `ATTACK_SILENT_HITS` (default 3) `_combat` logs
`attack_no_damage` and re-locks the nearest entity of that type.

### Human vs bot

| | Human (graphical client) | Bot |
|---|---|---|
| Render distance | Yes, negotiated (typically 8-32 chunks = 128-512 blocks) | **None**; no `request_chunk_radius` |
| Blocks visible | Up to render distance, but **surfaces only** | ~±40 blocks active, but **all of them** (x-ray) |
| Entities | Up to render distance | 24 blocks (`/observe`), 32 (hostiles) |
| Radar max horizontal | — | 96 (theoretical, never reached) |

The correct asymmetry: **human = long-range opaque telephoto; bot = short-range
x-ray.**

---

## 9. The two client variants

| File | What | Use |
|---|---|---|
| `harness.mjs` | "Toy" Java Edition reproduction: a pure-Node Minecraft 1.16.5 server (`flying-squid`) + a `mineflayer` bot. Also headless. | Local demo, no external server required |
| `bedrock-harness.mjs` + `bedrock-adapter.mjs` | The **real target**: an authenticated Bedrock bot that joins a real BDS 1.26.x and acts in the real world. | Docker deployment, server CT 108 |

The semantic interface is identical (`observe()`, `options()`, `executeAction()`,
`connect()`, `disconnect()`): the Hermes/Jev controller does not know — and must
not know — which edition it runs on.

---

## 10. Why headless matters

- **No visual channel**: the model does not learn from screenshots, so there is no
  OCR, resolution or rendering problem; state is already symbolic and precise.
- **Determinism**: action validity is computed by code (the harness), never judged
  by the model. The Survival Governor and skill verification check real state,
  never the model's opinion.
- **Reproducibility**: every decision and action is logged as JSONL; reports
  (e.g. `REPRODUCTION-REPORT.md`) derive from logs, not memory.
- **Cost**: the Jev controller answers a "choice" question in ~0.2 s; no rendering
  or vision cost.
