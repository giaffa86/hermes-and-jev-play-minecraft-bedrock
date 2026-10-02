# Index

Catalog of the wiki pages and their raw sources. Read this first when answering a
question about the project.

## Wiki pages (`wiki/`)

| Page | Summary | Main sources |
|---|---|---|
| [overview.md](wiki/overview.md) | What the project is, the Hermes/Jev/harness split, and the repo layout. | `README.md`, `AGENTS.md`, `BEDROCK.md` |
| [control-flow.md](wiki/control-flow.md) | How a goal travels down to one bounded action: progression → System Two (Hermes) → Skill Resolver → harness `/options` → System One (Jev), with the Survival Governor cross-cutting. | `controller.mjs`, `survival/*`, `bedrock-harness.mjs` |
| [architecture-evolution.md](wiki/architecture-evolution.md) | Design thesis: the four-way split, Hermes as *strategic replanner* (not hierarchical planner), and two proposed evolutions — first-class `subgoal`/receding-horizon planning, multi-branch progression graph. | `controller.mjs`, `survival/progression.mjs`, `knowledge/progression.json` |
| [headless-client.md](wiki/headless-client.md) | How the bot sees and acts in the world with no graphics: protocol-level perception and actions, the bounded-action loop, short-range x-ray vision, the absence of real exploration, why its "render distance" is not comparable to a human's, and why it is nevertheless a real, visible player (not a ghost). | `bedrock-adapter.mjs`, `bedrock-world.mjs`, `BEDROCK.md` |
| [survival-intelligence.md](wiki/survival-intelligence.md) | Synthesis of the deterministic Survival Intelligence Layer: governor, declarative skills, resolver, verification, progression. | `docs/raw/SURVIVAL-INTELLIGENCE.md` |
| [reproduction.md](wiki/reproduction.md) | Summary of the Ender Dragon reproduction of `rmalde/minecraft-agent` (7:45, exact models). | `docs/raw/REPRODUCTION-REPORT.md` |
| [human-command.md](wiki/human-command.md) | Roadmap for a human-in-chat natural-language command channel (follow, combat assist, guided mining). | `bedrock-adapter.mjs`, `bedrock-harness.mjs`, `controller.mjs` |
| [trading.md](wiki/trading.md) | Trading with villagers/wandering traders and autonomous levelling ("maxxing") with a cheap-only economy. | `bedrock-adapter.mjs`, `bedrock-trading.mjs`, `BEDROCK.md`, `.private/TRADING-TASK.md` |
| [companions.md](wiki/companions.md) | Companion animals: taming (food- and ride-based), census, and what is missing (riding as transport, saddle, axolotl/nautilus specifics). | `bedrock-survival.mjs`, `bedrock-adapter.mjs`, `BEDROCK.md` |
| [verification.md](wiki/verification.md) | Consolidated collaudo checklist: every capability with its status (live-verified / unit-tested / pending live / not implemented) and how to trigger each live round. | `BEDROCK.md`, `docs/wiki/*`, `tests/*` |
| [fishing.md](wiki/fishing.md) | Fishing (rod crafting, cast/bite/reel, water/shore detection, food integration) — implemented, live verification pending. | `bedrock-adapter.mjs`, `bedrock-fishing.mjs`, `BEDROCK.md` |
| [roadmap.md](wiki/roadmap.md) | Consolidated roadmap and implementation status: done/verified-live vs implemented-pending-live vs not-implemented, across all `.private/` task notes. | `.private/ROADMAP.md`, `.private/GOAL.md`, `.private/*-TASK.md`, `BEDROCK.md` |
| [open-questions.md](wiki/open-questions.md) | Known issues, blockers, and verification gaps. | `BEDROCK.md` (Known issues), `SURVIVAL-INTELLIGENCE.md` (status) |
| [ai-player-roadmap.md](wiki/ai-player-roadmap.md) | Synthesis of the persistent-AI-player roadmap (Goal Manager, emergency, autonomy, navigation, personality) and the milestone-0 lifecycle audit: the bot stays connected after a goal ends, but the controller exits and there is no explicit IDLE state yet. | `docs/raw/AI_PLAYER_ROADMAP.md`, `controller.mjs`, `bedrock-harness.mjs` |
| [exploration.md](wiki/exploration.md) | Autonomous-exploration spec (find biome/block/structure, deterministic spiral planner, checkpoints, route replay, escort) — spec only, not implemented. | `docs/raw/GOAL_EXPLORATION.md` |
| [fluids.md](wiki/fluids.md) | Fluids roadmap: swimming, drowning/breathing, waterfalls (descent/ascent), lava avoidance, plus buckets/boats/bubble columns/potions — spec only, not implemented. | `docs/raw/FLUIDS_ROADMAP.md`, `bedrock-adapter.mjs`, `bedrock-fishing.mjs` |

## Raw sources (`raw/`)

| Source | What it is |
|---|---|
| [BEDROCK.md](../BEDROCK.md) | The operational runbook for the Bedrock port: components, env vars, deploy, action status, survival, crafting, movement, known issues. |
| [SURVIVAL-INTELLIGENCE.md](raw/SURVIVAL-INTELLIGENCE.md) | Full reference for the Survival Intelligence Layer. |
| [REPRODUCTION-REPORT.md](raw/REPRODUCTION-REPORT.md) | Full report of reproducing the original Ender Dragon run. |
| [AI_PLAYER_ROADMAP.md](raw/AI_PLAYER_ROADMAP.md) | Evolutionary roadmap from chat-controllable bot to persistent autonomous agent (Goal Manager, suspend/resume, emergency, autonomy, home, navigation, personality). |
| [GOAL_EXPLORATION.md](raw/GOAL_EXPLORATION.md) | Autonomous Exploration v1 spec: find-biome MVP, mission model, deterministic planner, checkpoints, route replay, escort, search blocks/structures. |
| [FLUIDS_ROADMAP.md](raw/FLUIDS_ROADMAP.md) | Fluids roadmap (Italian): swimming physics, drowning/breathing, waterfalls and bubble columns, lava avoidance, buckets/boats/potions, Survival Intelligence integration (M0–M6). |
| [evidence/](raw/evidence/) | JSONL evidence from early harness runs (`hermes-01`, `jev-03`). |

## Meta files

| File | Purpose |
|---|---|
| [llm-wiki.md](llm-wiki.md) | The manifest (schema): layers, conventions, workflows. |
| [sources.md](sources.md) | Full catalog of sources, including those outside `docs/`. |
| [log.md](log.md) | Chronological log of ingests, queries and lints. |
