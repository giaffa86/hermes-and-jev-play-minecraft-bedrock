// Opportunity goals — map "a better chance appeared" events to bounded goals.
//
// This is the *opportunity* counterpart of emergency-goals.mjs, and the line
// between the two matters:
//
//   emergency  : the current plan is no longer viable (death, danger) — the goal
//                is preempted because continuing is harmful.
//   opportunity: the current plan is still fine, but something better is in
//                reach (a valuable vein) — the goal is *suspended*, the chance
//                taken, then the parent resumes. Losing the chance costs value,
//                not safety.
//
// Policy (the roadmap's curiosity rule, "solo se: current goal priority allows
// interruption / danger acceptable / distance reasonable"):
//   - only sources that may be interrupted at all (curriculum, autonomous);
//   - only when the governor is not in emergency (danger = false);
//   - only when the current goal is not almost finished (progress < 0.9);
//   - only one level deep: an opportunity never interrupts an opportunity;
//   - only ores harvestable with the tools in the backpack;
//   - only within OPPORTUNITY_MAX_DISTANCE;
//   - only if the ore is worth it: value >= 40 (gold and above — always worth a
//     detour), or "better than what you are already mining": when the goal is
//     about a resource, the sighting must be strictly more valuable (copper
//     target + iron vein => take the iron, then resume copper; coal target +
//     copper => take the copper). Scarce matters more than cheap: the relative
//     path stays open while the backpack holds fewer than
//     OPPORTUNITY_STOCK_CAP of that drop, so an early-game coal or iron vein is
//     seized and a chest-deep stock is not chased.
//
// Pure module: no I/O; the caller owns the dedup map and the clock.

import { WORLD_EVENTS } from './world-events.mjs';
import { GOAL_SOURCE, SOURCE_PRIORITY } from './goal-manager.mjs';
import {
  oreValue,
  oreDrop,
  bestTargetValue,
  OPPORTUNITY_MIN_VALUE,
  OPPORTUNITY_MIN_RELATIVE_VALUE,
  OPPORTUNITY_STOCK_CAP,
  OPPORTUNITY_VALUE_MARGIN,
} from './ore-value.mjs';

export const DEFAULT_OPPORTUNITY_COOLDOWN_MS = 120000;
export const DEFAULT_OPPORTUNITY_MAX_DISTANCE = 24;
export const DEFAULT_MAX_GOAL_PROGRESS = 0.9;

// An opportunity may suspend work that was *chosen* (curriculum, idle needs). It
// must not suspend a human order (chat), a world-event goal, another opportunity
// or an emergency: those are either about people or about not losing the bot.
export const INTERRUPTIBLE_SOURCES = Object.freeze([
  GOAL_SOURCE.CURRICULUM,
  GOAL_SOURCE.AUTONOMOUS,
]);

// Informational, mirrors DEFAULT_LOOT_PRIORITY: what is worth carrying home.
export const DEFAULT_OPPORTUNITY_PRIORITY = ['diamond', 'emerald', 'gold', 'lapis', 'redstone', 'iron', 'copper'];

const BUILDERS = {
  [WORLD_EVENTS.VALUABLE_ORE_SEEN]: (event, { held = 0 } = {}) => {
    const ore = event.data?.ore ?? null;
    const drop = event.data?.drop ?? oreDrop(ore);
    const value = event.data?.value ?? oreValue(ore);
    const position = event.data?.position ?? null;
    const where = position ? ` at ${JSON.stringify(position)}` : '';
    const objective = `Mine the ${ore}${where} and take the ${drop ?? 'drop'}, then resume the previous objective.`;
    return {
      type: 'mine_opportunity',
      objective,
      priority: SOURCE_PRIORITY[GOAL_SOURCE.OPPORTUNITY],
      plan: {
        objective,
        // Success = one more drop than the one held now: the vein is a detour,
        // not a mining session. `goalMet` in the controller compares inventory.
        targets: drop ? { [drop]: held + 1 } : {},
        waypoint: position ? { x: position.x, z: position.z } : null,
        opportunity: true,
        priority: 'opportunity',
        notes: `opportunity:${WORLD_EVENTS.VALUABLE_ORE_SEEN}`,
      },
      parameters: {
        opportunity: 'valuable_ore_seen',
        ore,
        drop,
        value,
        position,
        distance: event.data?.distance ?? null,
        heldBefore: held,
        lootPriority: DEFAULT_OPPORTUNITY_PRIORITY,
      },
    };
  },
};

// Why an event is (not) an opportunity goal. Pure and side-effect free so a
// caller can log the reason; `opportunityGoalFor` adds dedup/cooldown on top.
export function evaluateOpportunity (event, {
  currentGoal = null,
  progress = null,
  danger = false,
  held = 0,
  holdings = {},
  minValue = OPPORTUNITY_MIN_VALUE,
  minRelativeValue = OPPORTUNITY_MIN_RELATIVE_VALUE,
  stockCap = OPPORTUNITY_STOCK_CAP,
  margin = OPPORTUNITY_VALUE_MARGIN,
  maxDistance = DEFAULT_OPPORTUNITY_MAX_DISTANCE,
  maxProgress = DEFAULT_MAX_GOAL_PROGRESS,
  interruptibleSources = INTERRUPTIBLE_SOURCES,
  now = Date.now(),
} = {}) {
  if (!event?.type) return { eligible: false, reason: 'not_an_event', spec: null };
  const build = BUILDERS[event.type];
  if (!build) return { eligible: false, reason: 'unsupported_event', spec: null };
  if (event.data?.harvestable === false) return { eligible: false, reason: 'unharvestable', spec: null };

  const value = event.data?.value ?? oreValue(event.data?.ore);
  const drop = event.data?.drop ?? oreDrop(event.data?.ore);
  const targetValue = bestTargetValue(currentGoal?.plan?.targets);
  const heldNow = drop && Number.isFinite(holdings?.[drop]) ? holdings[drop] : held;
  const absolute = value >= minValue;
  // "Better than what I am already mining": strict, with a low floor so the cheap
  // but scarce ores (coal, copper) count too. A non-resource goal (dirt, wood,
  // travel) has targetValue 0 and only has to clear the floor.
  const betterThanTarget = value > targetValue + margin - 1 && value > 0;
  const relative = !absolute && value >= minRelativeValue && betterThanTarget && heldNow < stockCap;
  if (!absolute && !relative) {
    const reason = value >= minRelativeValue && betterThanTarget ? 'stocked_up' : 'too_cheap';
    return { eligible: false, reason, spec: null, value, targetValue, held: heldNow };
  }

  const distance = event.data?.distance;
  if (Number.isFinite(distance) && distance > maxDistance) {
    return { eligible: false, reason: 'out_of_range', spec: null, value, targetValue, distance };
  }
  if (danger) return { eligible: false, reason: 'danger', spec: null, value, targetValue };
  if (currentGoal?.plan?.opportunity === true || currentGoal?.parameters?.opportunity) {
    return { eligible: false, reason: 'nested_opportunity', spec: null, value, targetValue };
  }
  const source = currentGoal?.source ?? null;
  if (source != null && !interruptibleSources.includes(source)) {
    return { eligible: false, reason: 'not_interruptible', spec: null, source, value, targetValue };
  }
  if (Number.isFinite(progress) && progress >= maxProgress) {
    return { eligible: false, reason: 'goal_almost_done', spec: null, progress, value, targetValue };
  }

  return { eligible: true, reason: null, spec: build(event, { held: heldNow, now }), value, targetValue };
}

// The opportunity goal for `event`, or null when it is not worth one (or is
// within its cooldown). `attempts` is a Map<dedupKey, timestamp> owned by the
// caller — same contract as emergencyGoalFor.
export function opportunityGoalFor (event, {
  parentGoal = null,
  attempts = new Map(),
  cooldownMs = DEFAULT_OPPORTUNITY_COOLDOWN_MS,
  now = Date.now(),
  ...options
} = {}) {
  const { eligible, spec } = evaluateOpportunity(event, { ...options, now });
  if (!eligible || !spec) return null;
  const dedupKey = event.dedupKey ?? event.type;
  const last = attempts.get(dedupKey);
  if (last != null && now - last < cooldownMs) return null;
  return {
    source: GOAL_SOURCE.OPPORTUNITY,
    parentGoal,
    dedupKey,
    eventType: event.type,
    ...spec,
  };
}
