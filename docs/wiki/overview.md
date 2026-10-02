# Overview

A minimal reproduction of the `rmalde/minecraft-agent` planner/controller split,
ported to Minecraft Bedrock Edition: **Hermes** plans milestones, **Jev** (or
Hermes) picks one bounded action at a time, and a **harness** executes it in the
real world. No screenshots, no keypresses, no generated code from any model.

## The split

| Layer | Component | Role |
|---|---|---|
| Planner ("System Two") | Hermes (`hermes chat -Q --oneshot`) | Sets `{objective, targets, waypoint}`; runs only at milestones, never per step. |
| Controller ("System One") | Jev (TypeSafe via OpenRouter `/api/alpha/decisions`) or Hermes | Picks ONE action per step from the list the harness offers, with probabilities + confidence. |
| Harness | `bedrock-harness.mjs` + `bedrock-adapter.mjs` | Owns **validity**: offers only executable, currently-useful actions and executes the chosen one. |

The split mirrors the one that beat the Ender Dragon in 8:43 from a fresh Survival
world (see [reproduction](reproduction.md)).

## The two client variants

| File | What | Use |
|---|---|---|
| `harness.mjs` | Pure-Node Minecraft 1.16.5 server (`flying-squid`) + one `mineflayer` bot + bounded-action HTTP API. Also headless. | Local demo, no external server. |
| `bedrock-harness.mjs` + `bedrock-adapter.mjs` | The real target: an authenticated Bedrock bot that joins a real BDS 1.26.x and acts in the real world. | Docker deployment against server CT 108. |

Both expose the same interface (`observe()`, `options()`, `executeAction()`,
`connect()`, `disconnect()`): the controller does not know which edition it runs on.

## Entry points

| File | Run it |
|---|---|
| `bedrock-harness.mjs` | `RUN_ID=demo node bedrock-harness.mjs` (API on :3077) |
| `controller.mjs` | `OPENROUTER_API_KEY=... RUN_ID=demo WAYPOINT='{"x":380,"z":16}' TARGETS='{"dirt":4}' node controller.mjs` |
| `harness.mjs` | `RUN_ID=demo node harness.mjs` (Java Edition toy) |

## Key concepts

- **Headless client** — the bot "sees" and "acts" via the network protocol only;
  see [headless-client](headless-client.md).
- **Survival Intelligence Layer** — a deterministic layer between the goal and the
  bounded actions; see [survival-intelligence](survival-intelligence.md).
- **Validity owned by the harness** — the model chooses only keys returned by
  `GET /options`; bad behaviour is fixed in the harness, not the prompt.
- **Human chat command channel** — a planned input channel that lets a human
  order the bot in natural language via in-game chat; see
  [human-command](human-command.md).

## Sources

- `README.md` (root), `AGENTS.md` (root), `BEDROCK.md` (root).
