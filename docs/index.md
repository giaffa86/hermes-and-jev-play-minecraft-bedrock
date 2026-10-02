# Index

Catalog of the wiki pages and their raw sources. Read this first when answering a
question about the project.

## Wiki pages (`wiki/`)

| Page | Summary | Main sources |
|---|---|---|
| [overview.md](wiki/overview.md) | What the project is, the Hermes/Jev/harness split, and the repo layout. | `README.md`, `AGENTS.md`, `BEDROCK.md` |
| [headless-client.md](wiki/headless-client.md) | How the bot sees and acts in the world with no graphics: protocol-level perception and actions, the bounded-action loop, short-range x-ray vision, the absence of real exploration, and why its "render distance" is not comparable to a human's. | `bedrock-adapter.mjs`, `bedrock-world.mjs`, `BEDROCK.md` |
| [survival-intelligence.md](wiki/survival-intelligence.md) | Synthesis of the deterministic Survival Intelligence Layer: governor, declarative skills, resolver, verification, progression. | `docs/raw/SURVIVAL-INTELLIGENCE.md` |
| [reproduction.md](wiki/reproduction.md) | Summary of the Ender Dragon reproduction of `rmalde/minecraft-agent` (7:45, exact models). | `docs/raw/REPRODUCTION-REPORT.md` |
| [open-questions.md](wiki/open-questions.md) | Known issues, blockers, and verification gaps. | `BEDROCK.md` (Known issues), `SURVIVAL-INTELLIGENCE.md` (status) |

## Raw sources (`raw/`)

| Source | What it is |
|---|---|
| [BEDROCK.md](../BEDROCK.md) | The operational runbook for the Bedrock port: components, env vars, deploy, action status, survival, crafting, movement, known issues. |
| [SURVIVAL-INTELLIGENCE.md](raw/SURVIVAL-INTELLIGENCE.md) | Full reference for the Survival Intelligence Layer. |
| [REPRODUCTION-REPORT.md](raw/REPRODUCTION-REPORT.md) | Full report of reproducing the original Ender Dragon run. |
| [evidence/](raw/evidence/) | JSONL evidence from early harness runs (`hermes-01`, `jev-03`). |

## Meta files

| File | Purpose |
|---|---|
| [llm-wiki.md](llm-wiki.md) | The manifest (schema): layers, conventions, workflows. |
| [sources.md](sources.md) | Full catalog of sources, including those outside `docs/`. |
| [log.md](log.md) | Chronological log of ingests, queries and lints. |
