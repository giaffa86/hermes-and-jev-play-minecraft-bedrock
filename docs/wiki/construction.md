# Construction

The construction extension preserves the [bounded controller loop](control-flow.md).
Hermes chooses a structure and parameters, Jev selects an offered action, and the
local executor handles geometry, materials, working positions and confirmation.
Implementation is covered by offline tests; real BDS construction is pending.

## Catalogue

| Type | Default | Supported parameters |
|---|---|---|
| `platform` | 5 × 5 cobblestone floor | width 3–15, length 3–24 |
| `house` | 7 × 7 wooden house, wall height 3 | width 5–11, length 5–15 |
| `bridge` | 5 × 9 level cobblestone span with rails | total width 3–7, length 3–24 |
| `tower` | 9 × 9 stone tower, wall height 8 | width/length 9–11, height 4–8 |
| `warehouse` | 7 × 9 wooden building, 4 chests | width 7–11, length 7–15, 1–12 chests subject to space |

Houses and warehouses have doors, lighting and complete roofs. Towers have
permanent internal steps, an observation deck and a hatch. Warehouse chests are
separate and have clear lids and approaches. Full blocks form the stairs and rails.
Temporary exterior access is included in material demand and removed after
functional verification. Four cardinal orientations rotate the entire blueprint.

## Requests

Use a trusted chat order such as `@bot Costruisci una casa 7x7`,
`@bot Costruisci un magazzino con 4 casse`, or `@bot Metti in pausa il cantiere`.
The [human command channel](human-command.md) must already be enabled. Hermes
interprets the request; a deterministic fallback recognizes basic building orders.

An explicit controller request, against an already running harness:

```bash
CONSTRUCTION='{"type":"house","parameters":{"width":7,"length":7}}' \
GOAL='Build a house' TARGETS='{}' MAX_STEPS=300 RUN_ID=construction-demo node controller.mjs
```

When `origin` is omitted the harness checks a bounded set of nearby sites.
An explicit origin is the first floor block, one block above natural ground.
`facing` is `south`, `east`, `north` or `west`. A bridge may specify level,
axis-aligned `from` and `to` ground approach coordinates instead of origin/facing;
its floor raises the walkway one block above those approach feet positions,
and its length excludes the approaches.
Sloped or diagonal spans are refused.

| API | Purpose |
|---|---|
| `POST /construction/preview` | Read-only survey, bounds, material demand, missing items and issues |
| `POST /construction/start` | Validate and persist a new request, or attach an existing project |
| `GET /construction` / `GET /observe.construction` | Current phase, progress, failures and verification |
| `GET /construction/projects` | Persisted project summaries |
| `POST /construction/control` | Exact `projectId` with `command: pause`, `resume` or `cancel` |
| `POST /plan` | Existing contract, extended with a `construction` object |
| `POST /act` | Existing contract; choose `construction_step` or `construction_supply` from `/options` |

The start response returns an immutable instance id. Resume through
`{"construction":{"projectId":"<project-id>","command":"resume"}}` in `/plan`.
Replanning retains this instance; inventory targets cannot close a construction goal.
Each placement action confirms at most four blocks, within a 20-second budget.
Supply, traversal, container verification and cleanup are bounded separate actions.

## Materials and protection

The executor recursively resolves actual server recipes, gathers supported natural
wood/stone/coal, bootstraps a pickaxe when needed and uses the existing crafting and
pickup primitives. Its shared [resource-site provider](../../remembered-resource-sites.mjs)
consults compatible remembered sites after storage and crafting, before the local
census. Site visits navigate only: the next supply action re-observes and executes
an offered gather key. Invalid or failed sites fall back locally; no source keeps
the explicit missing-material evidence. See [crafting](crafting.md) for the full
order and protections. A crafting table may be placed outside the reserved building
area. An unavailable ingredient or unreachable target stops progress with evidence.
The bot never treats a future blueprint block as current placement support.

Container access requires an explicit `authorizedContainers` list of integer
`{x,y,z}` coordinates in the construction request. Both taking and surplus
storage are restricted to those containers. Tools, food and reserved construction
materials are retained. Procurement choices remain subject to survival policy.

For separate food or tool preparation, `POST /act` accepts a targeted withdrawal:
`{"key":"take_bread","position":{"x":10,"y":64,"z":10},"maxCount":12}`.
Coordinates must be integers and the quantity must be between 1 and 64. The
specified container must be known to hold the item; an unavailable target fails
without falling back to another chest. Item-only actions retain their existing
nearest-container behavior, so use the explicit position when permission is
limited to particular chests.

A site must be loaded, empty and accessible, with known natural terrain where
support is required. Existing matching buildings are not adopted as new work.
Unknown blocks, occupied cells, obstructed routes and changed owned cells prevent
construction. Wooden bridge floors directly over lava are refused. No flattening,
base demolition, animal killing, villager interaction or arbitrary code generation
is part of this executor.

Working positions require real local pathfinding, reach, collision and visibility
of the clicked face. Bridge extension uses a bounded sneaking edge movement.
Cancellation guards placement, movement and inventory requests; expired queued
inputs are rejected. Server confirmations precede placement claims.

## Persistence and verification

Projects use the existing [world memory](memory.md) repository (`kind: construction`),
with the expanded immutable blueprint/hash, dimension, material demand, owned block
signatures, phase, progress and failure evidence. JSON and SQLite resume are tested.
The [placement ledger](redstone.md) records project ownership; resumption reconciles
only this project's confirmed cells and detects external edits.

Completion requires matching geometry and clearance, actual route traversal,
opening every warehouse chest, and removal of unchanged owned temporary access.
Cleanup proves a retreat path and never mines the block under the bot. Partial
buildings survive failure or cancellation. There is no automatic demolition.
The `structureBuilt` gameplay criterion requires newly verified construction.

Freeform buildings, sloped bridges, unsupported fitting materials, terrain
levelling and automatic demolition are outside this first catalogue.

## Verification status

Offline acceptance exercises all five templates through the real placement
confirmation primitive, collision/A* logic, precise edge movement, persistence and
functional verifier, with network/server boundaries simulated. Controller tests
use the shared HTTP handler and a model stub. These tests do not prove that the real
server accepts every placement or movement sequence.

On 2026-10-04 the complete offline suite passed **1183/1183** tests.
A subsequent focused check passed **4/4**, including the additional regression
that completed projects no longer demand dismantled temporary access.
`npm run wiki:lint:strict` and `git diff --check` passed.

A further offline procurement-cycle check passed: starting with no building
materials, offered actions gathered three logs, picked up their drops, crafted
planks using server recipe eligibility, placed nine confirmed floor blocks and
completed traversal. Mining, pickup and craft responses were simulated; their
real BDS combination still needs the live round.

A bounded live session on 2026-10-05 confirmed the construction catalogue and
preview/start APIs against the real BDS. The requested 7 × 7 house site passed
the terrain and access survey after rotating the footprint west; a project was
persisted with **zero placed blocks**. The bot approached the site through normal
player movement. Food and building materials were still missing at shutdown,
so neither live placement nor functional completion is proven. The persisted
project was paused after the watchdog stopped the harness. Evidence is retained
in the gitignored `runs/construction-live-house/` directory.

The approach exposed movement defects around beds and doors: a lower-half door
update must apply its open bit to both halves, beds need their registry collision
height, and doorway approaches need precise centring. Regression coverage includes
construction edge movement and scaffold cleanup.

Follow the [bounded live-session policy](final-report.md): the production bot stays
off until a scoped round is authorized. Each round needs an approved site,
materials or approved supply containers, a time/action budget, evidence capture
and shutdown. See [verification](verification.md) and [open questions](open-questions.md).

## Sources

- [Geometry and validation](../../construction.mjs)
- [Persistent executor](../../bedrock-construction.mjs)
- [HTTP routes](../../construction-api.mjs)
- [Bedrock adapter](../../bedrock-adapter.mjs)
- [Controller](../../controller.mjs)
- [Templates](../../structures/house.json)
- [Acceptance tests](../../tests/bedrock-construction.test.mjs)
- [Controller/API tests](../../tests/construction-api.test.mjs)

The 2026-10-05 integration with current crafting and remembered resource-site
supply passed the full offline suite (**1333/1333**) and a final focused check
(**31/31**). This does not upgrade the live-verification status.

The movement fixes from the 2026-10-05 live approach passed the complete offline
suite (**1337/1337**) and strict wiki lint. This still does not prove live house
placement or completion.

Targeted food/material withdrawals on 2026-10-05 were confirmed by the live
server. A follow-up inventory fix prevents unlabelled chest/workbench window
updates from creating phantom player items when the server reuses window 2.

A waypoint may include an explicit `y` coordinate. The Bedrock action preserves
that elevation when selecting its approach, avoiding a nearby cave destination
when the requested construction site is on the surface. Existing `{x,z}`
waypoints retain their previous height inference.

Explicit waypoint elevations also restrict eligible destination nodes to within
one block of that height. A partial path frontier is progress only: movement
replans there and cannot report it as reaching the final destination. The live
house remains unbuilt after a night-time death during its approach; materials
were withdrawn from authorized storage, and the bot was shut down with evidence.

Missing finished supply targets outrank recipe ingredients in the eight-item
withdrawal list. A chest already holding the required planks or tools must remain
selectable even when several ingredient sources would otherwise fill that list.
