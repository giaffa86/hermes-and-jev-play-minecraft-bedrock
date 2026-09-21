---
name: minecraft-bounded-agent
description: Use when asked to play or test Minecraft through the hermes-and-jev-play-minecraft harness. Hermes plans in JSON; every action is one key chosen from the harness's current valid-option list.
---

# Minecraft bounded agent (Hermes planner, Jev or Hermes controller)

The harness (`harness.mjs`) runs a pure-Node Minecraft 1.16.5 server and one Mineflayer bot and exposes:

| Call | Meaning |
|---|---|
| `GET /observe` | compact state: position, health, food, inventory, nearby block distances, dropped items, current plan, last 8 actions |
| `GET /options` | the actions that are **valid right now** (`key` + `description`). Nothing else is executable. |
| `POST /act {"key"}` | execute exactly one action; returns `{ok, ...}` |
| `POST /plan {"objective","targets","waypoint"}` | record the plan; the harness uses `targets`/`waypoint` to decide which options to offer |

## Loop

1. `GET /observe`, then `POST /plan` with one actionable objective, `targets` (`{item: minCount}`) and a `waypoint` (`{x, z}`) or null.
2. Each step: `GET /options`, pick **one** key (never invent one), `POST /act`, read the result.
3. Re-plan only at milestones: targets satisfied, waypoint reached, two consecutive failures, or every ~8 actions.
4. Stop when the goal is met or the step budget is spent. Report the harness's returned facts only; do not infer state the harness did not report.

## Rules that came out of testing

- Validity lives in the harness, not the prompt. If the controller keeps making a useless choice, remove or filter the option in `harness.mjs` instead of writing a longer instruction.
- `wait` is offered only when nothing else is valid.
- Mining options disappear once `plan.targets` are satisfied; keep `targets` accurate so the harness can do this.
- Prefer `collect_drop` whenever a drop is listed; drops expire.
- Use `Connection: close` on harness requests; long actions (pathfinding) outlive keep-alive sockets otherwise.

## Controller choice

- `CONTROLLER=jev` (default in `controller.mjs`): Jev picks the key via OpenRouter's decisions endpoint (~0.2 s, ~$0.00004 per decision). Needs `OPENROUTER_API_KEY`.
- `CONTROLLER=hermes`: Hermes picks the key through `hermes chat -Q --oneshot` (slower, costlier, no extra key).
