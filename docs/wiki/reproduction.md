# Reproduction (synthesis)

Reproduction of `rmalde/minecraft-agent` — the planner/controller split that beats
Minecraft Java 1.16.5 from spawn to dragon kill with two models and zero
screenshots or keypresses.

Full report: [`docs/raw/REPRODUCTION-REPORT.md`](../raw/REPRODUCTION-REPORT.md).

## Verdict

✅ **Reproduced with the author's exact models.** Fresh Survival/Peaceful world on
his seed, empty inventory, his harness unmodified, GPT-6 Astra planning and JEV
1.13 choosing actions → Ender Dragon killed with **6 bed explosions** → exit
portal, **0 deaths, final health 20**, no restarts, **7 min 45 s** — 58 s faster
than his published 8:43.

❌ Not reproduced: the **video** (his recorder is a macOS-only native client).

## Results

| Metric | Author | Repro (exact models) |
|---|---|---|
| First decision → exit portal | 8:43 | **7:45** |
| Controller decisions | 131 | **119** |
| Planner calls | 35 | **35** |
| Bed blasts to kill | 6 | **6** |
| Deaths | 0 | **0** |
| Controller median latency | ~0.2 s | **227 ms** |
| Cost | $0.97 | **$0.963** ($0.953 Astra + $0.010 JEV) |

## Why it matters here

The Bedrock fork reuses the same split and the same lessons:

- **Harness-owned validity** — the model chooses from a filtered list, never invents.
- **Milestone-gated async planning** — Hermes plans at milestones, not per tick.
- **Verifier that refuses success without independent evidence** — `verify-run.mjs`
  demanded dragon-death + exit-portal evidence, not the model's word.

## Sources

- `docs/raw/REPRODUCTION-REPORT.md`, `docs/raw/evidence/`.
