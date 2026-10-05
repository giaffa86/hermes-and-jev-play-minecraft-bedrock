# Construction

The construction extension preserves the [bounded controller loop](control-flow.md).
For natural-language requests Hermes owns architecture: geometry, style, materials,
storeys, rooms, roof, furniture and ordered work stages. Jev chooses an offered
bounded action. Local code expands the model data, checks physical constraints,
finds working positions, supplies the selected materials and confirms server state.
Custom designs are offline-tested; complete real BDS construction is still pending.

## Model-owned design

The architect prompt lives in [construction-design.mjs](../../construction-design.mjs).
It requires `construction.design`: a versioned intent and requirement list, named
rooms, ordered stages, explicit inclusive cuboids and individual cells, terrain
support, clearance, walk/approach/container checks, and a coverage map connecting
requirements to part IDs. Coordinates are integer local offsets rotated by the
chosen facing. Clearance and terrain may also use explicit inclusive regions
`{from:[x,y,z],to:[x,y,z]}`, bounded to 20000 surveyed cells per list, so the model
can describe room volumes without enumerating each air cell.
Every material and geometric part comes from Hermes. The compiler
only expands cuboids and the mechanical upper door/head bed halves.

The [planning review](../../construction-planning.mjs) previews the design before
publishing it. Invalid geometry or site issues return to Hermes for at most two
repairs, preserving the original brief, explicit site and independently authorized
containers. Architect repair calls have a separate `CONSTRUCTION_DESIGN_TIMEOUT_MS` budget
(default 300000 ms); ordinary Hermes action calls keep `HERMES_TIMEOUT_MS`.
An unavailable architect yields `construction_design_rejected`; it
cannot silently substitute a standard house. Style/biome and semantic requirement
coverage remain model judgments. The compiler checks declared footprint/storeys
against floors, supports in stage order, bed support, room walk points, route
clearance and functional checks; it does not prove aesthetic fidelity.

Supported parts are full structural blocks (including logs and glass), wooden
doors, torches, chests, beds, crafting tables, furnaces and campfires. Stairs must
be explicit supported full-block steps; oriented stair/slab states are not yet
supported. A working campfire requires a nonflammable hearth and separation from
planned wood/furniture; verification requires observed lit state. A decorative
chimney alone does not prove a working fireplace. Limits are 4096 material cells,
32 stages and offsets within 128 blocks. The model supplies temporary access.
Existing projects retain their immutable geometry and resume by ID.

## Explicit template catalogue

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
interprets the request and produces a custom design. A deterministic fallback
recognizes the construction intent and dimensions only; natural-language requests
still require the architect stage before a plan is published.

An explicit structured template request remains available for compatibility,
against an already running harness:

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

The controller accepts a trusted `CONSTRUCTION_AUTHORIZED_CONTAINERS` JSON list
for natural-language requests. Explicit `CONSTRUCTION.authorizedContainers` takes
precedence. Designer output cannot grant itself new storage permissions.

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
opening every requested chest and the exact designed crafting table, approaching
beds/workstations, observing a lit campfire when included, and removal of unchanged
owned temporary access.
Cleanup proves a retreat path and never mines the block under the bot. Partial
buildings survive failure or cancellation. There is no automatic demolition.
The `structureBuilt` gameplay criterion requires newly verified construction.

Sloped bridges, unsupported fitting materials/states, terrain levelling and
automatic demolition remain outside the supported execution contract.

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

The final integrated full offline suite passed **1385/1385** tests. A subsequent
controller/targeted-workbench check passed **21/21**, and the geometry-repair
feedback regression passed. Strict wiki lint and `git diff --check` passed.

A subsequent offline design acceptance completed a custom 7 × 7 spruce house
with two traversable storeys, an upstairs bed, a ground-floor crafting table,
glass windows and a decorative brick chimney, in the declared stage order. The
server boundary was simulated. A separate controller/HTTP test passed an actual
natural-language planning path with a model stub, preview and a custom platform.
A real Hermes CLI design probe timed out without a usable plan; this is not
evidence of successful model generation or live execution of a custom house.

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
replans there and cannot report it as reaching the final destination. A subsequent daylight approach reached the requested surface site with full
health. The live project has 18 server-confirmed floor blocks and is paused
after unconfirmed placements and a failed night-time attempt. It is not complete.

Missing finished supply targets outrank recipe ingredients in the eight-item
withdrawal list. A chest already holding the required planks or tools must remain
selectable even when several ingredient sources would otherwise fill that list.

The furnace recipe fallback includes Overworld logs to charcoal, so torches can
be prepared from available wood when stored coal or torches cannot be accessed.
Charcoal requires a regular furnace. Elevation-only waypoint progress also keeps
`goto_waypoint` available until the requested height is reached.

Construction movement requires the exact standable elevation and arrival within
0.15 blocks vertically. The final motion waypoint cannot advance while the bot
is still jumping or descending to that floor. A failed work-position guard
records the planned and actual feet, support, target and line-of-sight result.

Precise construction arrival also requires the selected horizontal work cell;
a neighboring reachable cell cannot substitute for it. The executor verifies
that the player body occupies none of the target block cells before clicking.
Placement failure diagnostics retain the planned and actual work positions.

While a construction action is pending, a 100 ms monitor re-evaluates the same
rules in `knowledge/survival-rules.json` against live health, hunger, time,
hostiles, fluids and Nether hazards. A caution or emergency verdict interrupts
movement and pauses the project with `construction_survival_needed`. The
controller can then choose survival actions before explicitly resuming work.
This includes the existing night-preparation rules and uses no prompt policy.
