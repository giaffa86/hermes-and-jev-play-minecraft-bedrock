> **Nota Bedrock (WIP)** — Questo repository e' un fork di `teknium1/hermes-and-jev-play-minecraft` per portare l'agente su Minecraft Bedrock. Il goal completo, i dettagli del server e la checklist di lancio sono nel runbook privato locale `.private/GOAL.md` (escluso da git). Continuare il lavoro solo dopo aver letto quel file.

# Agent notes

Compact guidance for working in this repo.

## Privacy rules — never push personal data to GitHub

This repository is **public**. Before any `git push`:

- Never commit or push personal data: real gamertags or account emails, Microsoft/Xbox credentials or token caches (`nmp-cache/`, `auth.json`), API keys (`.env*`), SSH key paths or key files, xuid/account IDs, allowlists, chat logs.
- Use placeholders in examples and docs (`<gamertag_o_email>`, `<chiave-ssh>`, `<api-key>`), never real values.
- `.env`, `.private/`, `runs/`, `nmp-cache/`, `auth.json` are gitignored — never `git add -f` them.
- Audit before pushing: `git log -p origin/main..HEAD` plus a `git grep` for the patterns above. If a value already sits in unpushed commits, rewrite the history (scrub it) instead of pushing it or adding a "remove secret" commit.
- If unsure whether something is personal, ask the user before pushing.

## What this is

A minimal reproduction of the rmalde/minecraft-agent planner/controller split: **Hermes** plans milestones, **Jev** (or Hermes) picks one bounded action at a time, and a **Mineflayer + flying-squid harness** executes it. No screenshots, no keypresses, no generated code.

## Project shape

- ESM Node project; no build, no tests, no CI, no formatter config.
- `package.json` has two convenience scripts: `npm run harness` and `npm run play`.
- `test-ping.mjs` is standalone and unrelated to the main Java loop — it pings a Bedrock server (`<ip-server-bedrock>:19132`, `nethernet` transport).

## Entry points

| File | Role | Run it |
|---|---|---|
| `harness.mjs` | Pure-Node Minecraft 1.16.5 server + one Mineflayer bot + bounded-action HTTP API | `RUN_ID=demo node harness.mjs` |
| `controller.mjs` | Planner/controller loop calling the harness | `OPENROUTER_API_KEY=... RUN_ID=demo node controller.mjs` |
| `skills/minecraft-bounded-agent/SKILL.md` | Hermes skill for driving the harness directly | `hermes skills install https://raw.githubusercontent.com/teknium1/hermes-and-jev-play-minecraft-bedrock/main/skills/minecraft-bounded-agent/SKILL.md` |

## Run the demo

Two terminals required:

```bash
# Terminal 1 — boot the server. First run generates the world, ~25 s.
RUN_ID=demo node harness.mjs
# Wait for: "harness api on 3077"

# Terminal 2 — Hermes plans, Jev acts
export OPENROUTER_API_KEY=sk-or-...
RUN_ID=demo WAYPOINT='{"x":380,"z":16}' TARGETS='{"dirt":4}' MAX_STEPS=14 node controller.mjs
```

Result: `GOAL MET after N actions`. Logs land in `runs/demo/controller.jsonl` and `runs/demo/events.jsonl`.

Use `CONTROLLER=hermes` if you lack an OpenRouter key; it is slower and costlier.

## Important env vars

- `RUN_ID` — output directory under `runs/` (default `run`).
- `HARNESS` — harness URL (default `http://127.0.0.1:3077`).
- `WAYPOINT` — JSON `{"x":N,"z":N}`; omit for no waypoint.
- `TARGETS` — JSON `{"dirt":4}` (default `{dirt:4}`).
- `MAX_STEPS` — action budget (default `20`).
- `REPLAN_EVERY` — replan every N actions (default `8`).
- `CONTROLLER` — `jev` (default) or `hermes`.
- `JEV_MODEL` — default `typesafe/jev-1.13`.
- `MC_PORT` / `API_PORT` — defaults `25599` / `3077`.
- `OPENROUTER_API_KEY` — required for `CONTROLLER=jev`.

## Architecture gotchas

- **Harness owns validity.** The controller chooses only keys returned by `GET /options`. If the controller misbehaves, fix `options()` in `harness.mjs`, not the prompt.
- `mine_*` options disappear once `plan.targets` are satisfied.
- `wait` is offered only when nothing else is valid.
- `collect_drop` is preferred by the controller logic whenever drops exist; drops expire.
- The harness uses `Connection: close` on HTTP responses because long pathfinding actions can outlive keep-alive sockets.
- Pathfinding actions can take up to 45 s; the controller may appear idle while the harness is `busy`.
- The bot join retries for ~30 s; if it fails, the world is likely still generating — just restart `harness.mjs`.

## External prerequisites

- Node.js 18+ (tested on 26).
- Hermes Agent installed and working: `hermes chat -Q --oneshot -q hi` must answer.
- OpenRouter key for the default Jev controller.
- No Java is required; the Minecraft server is pure Node (`flying-squid`).
