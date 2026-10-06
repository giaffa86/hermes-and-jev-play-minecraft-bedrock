# Deep Dark stealth: sculk sensors, shriekers and the Warden

Roadmap for making the bot able to **cross a Deep Dark / Ancient City sculk
field without waking the Warden**: move at sneak speed along a route that keeps
every step outside the sculk sensors' hearing, never trigger a shrieker, and — if
the Warden is summoned anyway — leave crouched along a stored return route
instead of running or fighting.

Status: **spec, not implemented** (no vibration model, no stealth movement, no
Warden logic). Nothing in this page is collaudato live. Full raw source:
[`docs/raw/DEEP_DARK_ROADMAP.md`](../raw/DEEP_DARK_ROADMAP.md).

Sources: `bedrock-adapter.mjs` (movement, sneak input, `DIG_PROTECTED`, effects
map), `bedrock-world.mjs` (`findBlocks`/`findBlocksByState`),
`bedrock-survival.mjs` (`HOSTILE_TYPES`, flee), `structures.mjs` (the
`ancient_city` marker rule), `exploration.mjs` (the `deep_dark` biome alias),
`circuits.mjs` (`DANGEROUS_ITEMS`/`FORBIDDEN_BLOCKS`), `bedrock-redstone.mjs`
(`sculk_sensor_phase`), [exploration](exploration.md),
[ai-player-roadmap](ai-player-roadmap.md), [fluids](fluids.md) (water in a
tunnel), [redstone](redstone.md) (the sensor primitive).

## Current state (from the code)

- **The marker rule exists, has never fired live.** `structures.mjs:86-96` marks
  `ancient_city` from the sculk family (`sculk` ≥ 8 score 3, `sculk_shrieker` ≥ 1
  score 3, `sculk_catalyst` ≥ 1 score 2, `minScore: 6`). No run has ever seen
  one (`found: 0`).
- **`deep_dark` is only a vocabulary entry.** `exploration.mjs:19` aliases the
  biome, but there is no `find_deep_dark` action anywhere.
- **Breaking sculk is already refused, being heard is not.** `DIG_PROTECTED`
  (`bedrock-adapter.mjs:85`) already matches `sculk_sensor$` and
  `sculk_shrieker$`, and `circuits.mjs:79,87` keeps `sculk_shrieker` out of
  `DANGEROUS_ITEMS`/`FORBIDDEN_BLOCKS`. But *any* break is itself a vibration:
  protection from breaking is not protection from being heard.
- **Sneak is a construction input, not a movement mode.** `_moveTo` clears the
  flag (`bedrock-adapter.mjs:10203-10204`); the only sneaks are the construction
  edge placement (`:10188-10204`, input at `:9039-9042`) and the dismount/free-hand
  path (`:12405`, `:7331`). Every normal step therefore vibrates.
- **The Warden is a generic hostile.** `bedrock-survival.mjs:17`, height `2.9`
  at `:37`, and the generic `awayDirection` flee at `:44-46` — the opposite of
  the correct tactic (do not run).
- **Darkness is invisible.** `this.effects` (`bedrock-adapter.mjs:1526`) is
  consulted only for water breathing.
- **The sensor primitive already exists.** `bedrock-redstone.mjs:171` reads
  `sculk_sensor_phase`, and `:56-57` lists the sensor among the sensed
  components — what is missing is a model of *what it hears*.
- **No underground navigation.** The A* is surface-oriented; the Deep Dark needs
  the 3D navigation of [ai-player-roadmap](ai-player-roadmap.md), as stated in
  [exploration](exploration.md). The survey is a histogram of the ~48 loaded
  blocks, not a map.

## The mechanics the model must encode

Re-verification needed against the deployed Bedrock build; the current reference:

- **Sculk Sensor** — hears vibrations in a **sphere of 8 blocks**. A vibration
  caused by a *player* also activates nearby **shriekers**. **Sneaking prevents
  movement vibrations**; **wool occludes**.
- **Sculk Shrieker** — shrieks when a player stands on top of it (even crouched)
  or when a nearby sensor is triggered by a player. Natural shriekers inflict
  **Darkness** and can summon the Warden; placed/catalyst-grown shriekers are
  inert.
- **Warden** — **3 shrieks** summon it; blind; follows **vibrations and smell**;
  2.9 blocks tall, **500 HP**.

## Plan (W0–W6)

- **W0 — Vibration awareness.** Pure `bedrock-vibration.mjs` (`VIBRATION_RADIUS =
  8`, `vibrationProfile`, `vibrationRisk`, `sensorCoverage` for a *segment*,
  `shriekerVerdict`, `wardenWarning`) plus `GET /observe.sculk` (sensors with
  distance/phase, shriekers with `canSummon`, Darkness, `vibrationRiskAtBot`,
  Warden presence), the whole `SCULK_FAMILY` in `DIG_PROTECTED` and a typed
  `vibration_risk` refusal for any `dig_*` inside a sensor radius.
- **W1 — Sneak-walk as a real mode.** `_moveTo({sneak: true})` keeps the sneak
  flag on every tick and clears it at the end, with the **authoritative** speed
  measured against a sneak ceiling: a speed above it is a typed `not_sneaking`
  failure, because silence must be *verified*, never assumed. `sneak_to` +
  `GET /observe.sneak`.
- **W2 — Stealth pathfinding.** `planStealthRoute(from, to, world)`: high cost
  inside a sensor sphere, shrieker cells forbidden, no digging and no placing
  inside the Deep Dark (both vibrate), and a `no_stealth_route` refusal instead
  of a route through the hearing. A **return route must exist before entering**
  and is stored with the mission.
- **W3 — Shrieker/Warden warning.** `shriekLevel` (shrieking transitions +
  Darkness, lower bound if the server hides the warning level), `wardenWarning`
  verdicts `clear`/`warning`/`summoned`, and the tactic: freeze and leave
  crouched along the return route; never `start_running`; hold when the exit is
  far. The governor must **block** the generic flee for `warden`.
- **W4 — Underground 3D navigation.** Pillar/bridge/tunnel through
  `DIG_PROTECTED` and the [fluids](fluids.md) checks, the same cost hooks as W2,
  and `find_deep_dark` (the M6 target of [exploration](exploration.md)) with a
  descent route and a return route.
- **W5 — Darkness, kit, mission.** Darkness as a warning that the Warden may
  already be near; the Deep Dark kit as a declared state plus an **escape
  budget**; a `reach_deep_dark` progression milestone behind advanced navigation
  + exploration, and a `CURRICULUM=deep_dark`.
- **W6 — Limits and docs.** Observe, never loot; never break or place
  shrieker/sensor/catalyst; **never a Warden in the shared world without consent**;
  no client-side "silence" trick; documentation in `BEDROCK.md` and this page.

## Open risks

- The Bedrock numbers (8-block sphere, player-vibration relay, wool occlusion,
  3-shriek summon) need a live probe before being trusted.
- The shriek warning level may not be observable in the block state, making
  `shriekLevel` a lower bound.
- No loaded Ancient City in this world: the live proof needs an expedition or a
  disposable world copy, and the W3 live round needs explicit consent.
- Bedrock Warden AI (hearing, smell) may differ from the reference.

## Related pages

- [exploration](exploration.md) — the mission model, the M6 underground targets and the current "observe from a safe distance" default.
- [ai-player-roadmap](ai-player-roadmap.md) — world awareness and advanced (3D) navigation.
- [fluids](fluids.md) — water in a tunnel/bridge route.
- [redstone](redstone.md) — the sensor state primitive (`sculk_sensor_phase`).
- [survival-intelligence](survival-intelligence.md) — governor, skills, verifier, progression.
- [verification](verification.md) — collaudo status per capability (nothing here is live yet).
- [open-questions](open-questions.md) — tracked gaps and blockers.
- [roadmap](roadmap.md) — consolidated status.
