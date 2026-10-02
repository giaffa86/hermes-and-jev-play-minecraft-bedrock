# Opportunity goals (a better vein in sight)

Topic: what happens when the bot is halfway through a goal and **notices
something better** — a valuable vein within reach. This is the "curiosity"
counterpart of the [emergency](emergency.md) system: the current plan is still
fine, so the goal is *suspended* rather than preempted, the chance is taken, and
the parent resumes.

Sources: `world-events.mjs`, `opportunity-goals.mjs`, `ore-value.mjs`,
`bedrock-adapter.mjs`, `controller-decisions.mjs`, `goal-manager.mjs`,
[`docs/raw/AI_PLAYER_ROADMAP.md`](../raw/AI_PLAYER_ROADMAP.md) §10 (Curiosity
System).

## The question

Two shapes of the same problem:

- **The vein *is* a better version of the current goal.** "Mine 10 copper
  nuggets", and the bot walks past an iron vein. Copper and iron are both ores,
  the goal is already a mining goal — the bot should take the iron and then go
  back to the copper.
- **The vein is unrelated to the goal.** "Collect 8 logs", and a diamond ore is
  exposed two blocks away. The goal has nothing to do with mining, but the
  chance is worth 15 seconds.

Both are *better opportunities*, not *higher-level goals*: nothing about the
running objective became invalid, which is exactly what separates them from
[emergency goals](emergency.md). The roadmap's curiosity rule (§10) allows the
interruption "solo se" the current goal priority allows it, the danger is
acceptable and the distance is reasonable — the same three conditions are the
gate implemented here.

## Not the emergency system

| Aspect | Emergency | Opportunity |
| --- | --- | --- |
| Trigger | the plan is **no longer viable** (death, ambush) | the plan is fine, **something better is in reach** |
| What is at stake | safety (lose the bot, lose the loot) | value (lose a chance) |
| Action level | governor reacts in sub-seconds *inside* the current goal | governor does **not** react; the adapter/`detectEvents` only observe |
| Goal level | preempt: parent → `SUSPENDED`, emergency goal `RUNNING` | suspend: parent → `SUSPENDED`, opportunity goal `RUNNING`, parent resumes |
| Typed source | `emergency`, priority **100** | `opportunity`, priority **55** |
| May interrupt | anything except another emergency | only `curriculum` and `autonomous` (never a `chat` order) |
| Cooldown / dedup | `dedupKey` + 60 s | `dedupKey` + 120 s |
| Nesting | one level (no emergency inside an emergency) | one level (no opportunity inside an opportunity) |
| Producer | [`emergency-goals.mjs`](../../emergency-goals.mjs) | [`opportunity-goals.mjs`](../../opportunity-goals.mjs) |

The `Source priority` table lives in [`goal-manager.mjs`](../../goal-manager.mjs):
`EMERGENCY 100`, `CHAT 80`, `WORLD_EVENT 60`, **`OPPORTUNITY 55`**,
`PLAYER_BEHAVIOR 50`, `CURRICULUM 40`, `AUTONOMOUS 20`. Between a human order and
the curriculum is exactly where a chance should sit: above what the bot chose for
itself, below what a person asked for.

## The gate: value relative to the current goal

An **absolute** threshold alone gets the interesting case wrong. With a fixed
floor at "gold and above", the copper-goal-plus-iron-vein scenario would never
fire, because iron is cheap in absolute terms — yet it is *strictly better than
what the bot is already mining*. So the gate is relative first:

| Sighting | Current goal target | Verdict | Reason |
| --- | --- | --- | --- |
| iron (15) | `{raw_copper: 10}` (8) | **eligible** | better than the target |
| diamond (100) | `{oak_log: 8}` (3) | **eligible** | absolute (≥ 40) and far above the target |
| diamond (100) | `{raw_iron: 4}` (15) | **eligible** | absolute |
| coal (5) | `{dirt: 4}` (0) | **eligible** | better than the target, and fewer than 16 coal held |
| coal (5) | `{raw_copper: 6}` (8) | not eligible | `too_cheap` — copper is worth more than the coal goal |
| gold (40) | `{diamond: 1}` (100) | not eligible | `too_cheap` — the goal is already richer than the detour |
| coal (5) | anything, 16+ coal held | not eligible | `stocked_up` — a stocked ore is no longer scarce |

Rules (defaults in [`ore-value.mjs`](../../ore-value.mjs) and
[`opportunity-goals.mjs`](../../opportunity-goals.mjs)):

- **Absolute path** — `value >= OPPORTUNITY_MIN_VALUE` (40): gold, emerald,
  diamond (and the deepslate variants) are always worth a detour, whatever the
  goal and whatever the backpack holds.
- **Relative path** — the sighting must be strictly more valuable than the best
  item the plan targets (`value > targetValue + OPPORTUNITY_VALUE_MARGIN - 1`,
  with `value >= OPPORTUNITY_MIN_RELATIVE_VALUE` = 5) **and** the drop must still
  be scarce (`held < OPPORTUNITY_STOCK_CAP` = 16). "Scarce" is deliberately
  separate from "expensive": coal and copper are cheap and early-game critical,
  so a dirt or wood goal does seize them, while the same vein is ignored once a
  chest already holds a stack.
- `OR_EVENT_MIN_VALUE`/`ORE_EVENT_MIN_VALUE` (5) is the *reporting* floor in the
  event detector: every ore in the table is worth observing, and the producer
  above decides whether it is worth a goal. Cheap ores must not be filtered out
  before that decision.

Also required, from the roadmap's curiosity conditions:

- `harvestable !== false` — the adapter only reports a sighting the current
  pickaxe can actually harvest, so no goal is created for a vein the bot cannot
  take (`unharvestable`).
- `distance <= 24` (`out_of_range`), `danger === false` (`danger`, from the
  Survival Governor verdict), `progress < 0.9` (`goal_almost_done`: never lose a
  nearly-finished goal for a detour), the interrupting goal must be
  `curriculum`/`autonomous` (`not_interruptible`), and no opportunity inside an
  opportunity (`nested_opportunity`).
- The dedup key is the ore **and its position** (`ore:diamond_ore@12,12,12`):
  mining the same vein twice does not re-fire, but the next vein does. Within
  `DEFAULT_OPPORTUNITY_COOLDOWN_MS` (120 s) the same key is refused.

## Three layers, and where the option priority fits

1. **Detection** — [`bedrock-adapter.mjs`](../../bedrock-adapter.mjs) scans the
   valuable ore names within `ORE_INTEREST_RANGE` (24) every `ORE_SCAN_TTL_MS`
   (5 s, skipped while the bot has not moved more than 8 blocks) and exposes
   `observe().ores` as `{name, position, distance, value, harvestable}`.
   [`world-events.mjs`](../../world-events.mjs) turns a *newly seen* ore into a
   `VALUABLE_ORE_SEEN` world event (`severity: 'notice'`,
   `dedupKey: ore:<name>@<x>,<y>,<z>`, `data: {ore, value, drop, position,
   distance, harvestable}`), transition-based like every other event, so a vein
   already in view when the goal starts does not fire one.
2. **Decision** — [`opportunity-goals.mjs`](../../opportunity-goals.mjs) is pure:
   `evaluateOpportunity(event, {...})` returns `{eligible, reason, spec}` with a
   diagnostic reason (useful in `controller.jsonl`), and
   `opportunityGoalFor(event, {...})` adds dedup/cooldown and returns the goal
   spec (`source: opportunity`, `parentGoal`, `type: 'mine_opportunity'`,
   `plan.targets = {<drop>: held + 1}`, `plan.waypoint` at the vein,
   `plan.opportunity = true`). Success is an **inventory delta of one drop** — a
   detour, not a mining session — checked by the existing `goalMet`, never by
   the model.
3. **Visibility** — a goal can only be executed if the action is in `/options`.
   The adapter adds `mine_<ore>` for a harvestable valuable ore outside the fixed
   mining list, and
   [`controller-decisions.mjs`](../../controller-decisions.mjs) ranks it in a new
   tier **4.5** ("valuable ore") when its value is ≥ 40 (gold and above): after
   the plan target (4) and before craft (5), so it never overrides the goal but
   is not buried under generic mining (7) or dropped by the `MAX_OPTIONS` cap.

The option tier alone cannot express the copper→iron case: `mine_copper_ore`
(plan target, tier 4) beats `mine_iron_ore` (generic, tier 7), and both iron and
copper sit below the tier-4.5 value floor. What makes the bot take the iron is
the **goal-level** gate: the opportunity goal rewrites the *plan targets* to the
iron, so `mine_iron_ore` becomes the target match in the next step, and the
copper goal resumes afterwards. Tiers are for the action that is already
sanctioned; the producer is for the change of mind.

## Status

- **Implemented, unit-tested, not wired into the controller yet.** The detection
  (`ores` in the observation, `VALUABLE_ORE_SEEN`), the decision
  (`opportunity-goals.mjs`) and the visibility (option + tier 4.5) are complete
  and covered by tests: `tests/opportunity-goals.test.mjs` (value table, every
  refusal reason, the copper→iron case, coal, stock cap, cooldown),
  `tests/adapter-opportunity.test.mjs` (observation, option, unharvestable,
  dedup against the fixed list, scan TTL) and four ore cases in
  `tests/world-events.test.mjs`.
- **Not wired**: the preempt/suspend block in `controller.mjs` (the emergency
  path) has no opportunity sibling yet, so today an in-flight goal is still never
  interrupted by a vein. There is also no `OPPORTUNITY`/`OPPORTUNITY_COOLDOWN_MS`
  environment switch yet — the module defaults apply.
- **Live verification pending** (no BDS round run).
- **Sighting memory already exists**: a seen ore is written to world memory by
  `_rememberDiscoveries` (`rememberResourceSite`) independently of this layer, so
  the vein is remembered even when no goal is created.
- **Related gap**: the adapter can now *mine* redstone/lapis ore through the
  opportunity option (they are in the value table), but there is still no
  redstone awareness (state, oriented placement) — see
  [redstone](redstone.md) and [open-questions](open-questions.md).

## Related pages

- [emergency](emergency.md) — the preempting counterpart and the boundary rules.
- [ai-player-roadmap](ai-player-roadmap.md) — milestone 5 (world awareness) and
  milestone 8 (personality: curiosity as a *modulator*); the curiosity system of
  `raw/AI_PLAYER_ROADMAP.md` §10.
- [memory](memory.md) — where the sighting is stored.
- [control-flow](control-flow.md) — where the decision sits in the loop.
- [roadmap](roadmap.md) — consolidated status.
