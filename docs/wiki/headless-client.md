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
   and intent flags, staying inside the server's rewind window (40 ticks);
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
   occupies can never freeze the model;
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

### 4.4 Interactions — `click_block`, `item_use`, `item_use_on_entity`

- Doors, beds, furnaces, chests, crafting tables → `click_block` / `item_interact`;
- eating → `item_use` (`click_air`);
- attacking a mob → `item_use_on_entity` (`action_type: attack`) + `animate swing_arm`.

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
