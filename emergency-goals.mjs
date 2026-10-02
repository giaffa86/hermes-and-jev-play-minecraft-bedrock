// Emergency goals — map world events to first-class, preempting goals.
//
// AI-player roadmap milestone 2 ("Emergency system"): a world event can suspend
// the running goal and start a higher-priority goal (source EMERGENCY, priority
// 100). Multi-step recovery (recover the loot after a death) becomes a real goal
// with a parent to resume, instead of an invisible per-step override.
//
// Not every event becomes a goal: sub-second reactions (dodge, flee from a
// creeper, eat) stay with the Survival Governor *inside* the running goal. Only
// the ones that deserve their own record/queue slot are mapped here.
//
// Pure module: no I/O; the caller owns the dedup map and the clock.

import { WORLD_EVENTS } from './world-events.mjs';
import { GOAL_SOURCE, SOURCE_PRIORITY } from './goal-manager.mjs';

export const DEFAULT_EMERGENCY_COOLDOWN_MS = 60000;

export const RECOVER_LOOT_OBJECTIVE = 'Recover the dropped items and XP at the death site, then resume the previous objective.';

// Loot priority (roadmap): what to value first when recovering. Informational
// for now (the harness `recover_loot` collects everything nearby) but carried on
// the goal so a future executor can honour it.
export const DEFAULT_LOOT_PRIORITY = ['netherite', 'diamond', 'enchanted', 'elytra', 'iron', 'tools', 'any'];

const BUILDERS = {
  [WORLD_EVENTS.PLAYER_DIED]: (event) => ({
    type: 'recover_loot',
    objective: RECOVER_LOOT_OBJECTIVE,
    priority: SOURCE_PRIORITY[GOAL_SOURCE.EMERGENCY],
    plan: {
      objective: RECOVER_LOOT_OBJECTIVE,
      targets: {},
      waypoint: null,
      recover: true, // success = the death site is cleared (goalMet)
      priority: 'emergency',
      notes: 'emergency:recover_loot',
    },
    parameters: {
      emergency: 'player_died',
      deathSite: event.data?.deathSite ?? null,
      lootPriority: DEFAULT_LOOT_PRIORITY,
    },
  }),
};

// The emergency goal for `event`, or null when the event is not a goal (or is
// within its cooldown). `attempts` is a Map<dedupKey, timestamp> owned by the
// caller, so a failed emergency is not retried in a tight loop.
export function emergencyGoalFor (event, {
  parentGoal = null,
  attempts = new Map(),
  cooldownMs = DEFAULT_EMERGENCY_COOLDOWN_MS,
  now = Date.now(),
} = {}) {
  if (!event?.type) return null;
  const build = BUILDERS[event.type];
  if (!build) return null;
  const dedupKey = event.dedupKey ?? event.type;
  const last = attempts.get(dedupKey);
  if (last != null && now - last < cooldownMs) return null;
  return {
    source: GOAL_SOURCE.EMERGENCY,
    parentGoal,
    dedupKey,
    eventType: event.type,
    ...build(event),
  };
}
