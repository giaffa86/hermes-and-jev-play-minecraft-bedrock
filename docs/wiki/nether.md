# Nether and End (survival, ghasts, piglins, endermen, portals)

Roadmap for taking the bot from the first Nether portal to the End while
**surviving the Nether**: locate a nearby portal (reuse the base's), avoid
**ghast** fireballs, **barter gold with piglins**, **never meet an enderman's
gaze**, collect **blaze rods** and **ender pearls**, craft eyes of ender, find the
stronghold, open the End portal, and (stretch) defeat the **Ender Dragon**.

Status: **tracked in the progression graph, capabilities not implemented**.
`knowledge/progression.json` now has the full chain and the
`beat_the_dragon → enter_nether` contradiction is fixed: `beat_the_dragon` is a
real milestone requiring `enter_end`. Full raw source:
[`docs/raw/NETHER_ROADMAP.md`](../raw/NETHER_ROADMAP.md).

Sources: `knowledge/progression.json`, `skills/gameplay/progression/*`,
`bedrock-survival.mjs` (`HOSTILE_TYPES` already includes `ghast`, `blaze`,
`piglin`, `enderman`, `piglbrute`, `hoglin`, `magma_cube`, `ender_dragon`),
`bedrock-adapter.mjs`, [fluids](fluids.md), [goal-achievement](goal-achievement.md).

## Current state

- **`enter_nether` is not implemented**: the skill exists (`success: {dimension:
  nether}`) but there is **no portal action** — no `place_obsidian`, no
  `light_portal`/`flint_and_steel`, no "find a nearby `portal`".
- **No projectile tracking** (ghast fireballs) and **no gaze discipline**
  (`_lookAt` is used for aiming/mining and never avoids an enderman's eyes).
- **No fire/lava hazard** (depends on [fluids](fluids.md) M0/M4).
- **No bartering**: `item_use_on_entity` exists for feeding/taming, but no
  `barter_piglin`; and the survival layer classifies piglins as **hostile**, so an
  emergency rule would treat them as enemies.
- **No fortress/stronghold/End-portal actions**; `_refreshNearby` does not look
  for `portal`, `end_portal_frame`, `nether_wart`, spawners.
- **Bedrock specifics**: water evaporates in the Nether (no water MLG); **beds
  explode** in the Nether/End; the respawn anchor charges with glowstone; piglins
  zombify in the Overworld and are calmed by **any gold armour**; ghast fireballs
  can be deflected by hitting them.

## Progression chain (added)

```
diamonds
  └── nether_portal          (locate or build; nearby `portal` / 10 obsidian)
        └── enter_nether     (dimension: nether)
              └── nether_survival
                    ├── piglin_barter
                    ├── obtain_blaze_rods        (blaze_rods >= 7)
                    └── obtain_ender_pearls      (ender_pearls >= 12)
                          └── craft_eyes_of_ender (eyes_of_ender >= 12)
                                └── find_stronghold (end_portal_frame within 24)
                                      └── enter_end (dimension: the_end)
                                            └── beat_the_dragon
```

`goals.beat_the_dragon` now points to the real `beat_the_dragon` milestone.
New item tags: `gold_ingots`, `obsidian`, `blaze_rods`, `blaze_powder`,
`ender_pearls`, `eyes_of_ender`.

## Milestones

| # | Milestone | Content | Status |
|---|---|---|---|
| N0 | Nether awareness & hazards | `_refreshNearby` (portal, end_portal_frame, magma, spawner, fire); `/observe.portals`; projectile sensing (`projectileIncoming`); gaze sensing (`gazedAtEnderman`); governor rules. | ❌ not implemented |
| N1 | Portal locate/build/light/enter | `goto_portal`, `build_portal`, `light_portal`, `enter_portal`; prefer reusing a nearby portal; verify `portal` block then `dimension: nether`. | ❌ not implemented |
| N2 | Nether survival | fire/lava avoidance (fluids), minimal nether hub, fall handling (no water), never sleep/place water. | ❌ not implemented |
| N3 | Ghast avoidance | track fireballs, dodge perpendicular to the trajectory (or deflect), never flee into lava. | ❌ not implemented |
| N4 | Piglin bartering | wear gold armour for neutrality; `barter_piglin` (gold in hand → `item_use_on_entity` → collect drops); never hit piglins. | ❌ not implemented |
| N5 | Ender gaze & pearls | never aim at enderman eyes; pumpkin option; kill at body/feet; collect pearls. | ❌ not implemented |
| N6 | Fortress & blaze rods | find the fortress (exploration), fight blazes with cover, collect 7 rods. | ❌ not implemented |
| N7 | Endgame | eyes of ender, stronghold via thrown eyes, fill/enter the portal, (stretch) dragon. | ❌ not implemented |

## Dependencies and risks

- **Fluids M0/M4** (lava/fire hazards) and **exploration** (fortress, stronghold)
  are prerequisites.
- **Goal Contract / Goal Manager** ([goal-achievement](goal-achievement.md)) is
  needed for a long persistent Nether run with suspend/resume.
- **Ranged combat** is missing: `_combat` is melee, but blaze and end crystals
  need a bow.
- **Death loses everything** (`keep-inventory=false`) — establish a hub/respawn
  anchor early (N1–N2).
- The ghast dodge geometry must be calibrated to the real projectile speed and
  latency.
- A **`bossDefeated`** verifier criterion does not exist, so `beat_the_dragon`
  cannot be verified today.

## Related pages

- [fluids](fluids.md) — lava/fire hazards and water rules (water is unusable in the Nether).
- [goal-achievement](goal-achievement.md) — Goal Contract, task graph and benchmarks.
- [exploration](exploration.md) — finding the fortress/stronghold.
- [roadmap](roadmap.md) — consolidated implementation status.
- [open-questions](open-questions.md) — blockers and verification gaps.
- [survival-intelligence](survival-intelligence.md) — progression, skills, verifier.
