// Idle goal producer — needs-driven autonomy for the IDLE state.
//
// AI-player roadmap milestone 3 ("Autonomy"): while the agent has no goal it
// derives candidate goals from its *needs* deterministically (state + rules +
// utility score), never from an LLM. This module is the pure decision half: it
// maps an observation to a ranked list of candidate goals and to the predicate
// that says when the triggering need is satisfied.
//
// The controller enqueues the top candidate as an AUTONOMOUS/EMERGENCY goal and
// uses `isNeedResolved` as the goal's success criterion (checked against harness
// state every step, like a skill verifier).
//
// Pure module: no I/O, no clock except the caller-supplied `now`.

import { evaluateSurvival } from './survival/governor.mjs';
import { perceive } from './survival/perception.mjs';
import { NEED_PRIORITY } from './survival/needs.mjs';
import { GOAL_SOURCE, SOURCE_PRIORITY } from './goal-manager.mjs';

export const DEFAULT_AUTONOMY_COOLDOWN_MS = 120000;
export const DEFAULT_MAX_AUTONOMOUS_GOALS = 25;

// Needs the producer can turn into an actionable goal. `continue_progression`
// is intentionally excluded: it has no "resolved" state and is already handled
// by the progression/CURRICULUM machinery.
const NEED_GOALS = Object.freeze({
  survive: { objective: 'Get back to a survivable state (health/death) before doing anything else.', emergency: true },
  escape: { objective: 'Escape the nearby threat and reach a safe spot before resuming.', emergency: true },
  eat: { objective: 'Eat food from the inventory to restore hunger.', emergency: false },
  heal: { objective: 'Recover health (eat or rest in a safe place) before resuming.', emergency: true },
  sleep: { objective: 'Reach the bed and sleep through the night.', emergency: false },
  shelter: { objective: 'Find or build a shelter and survive the night.', emergency: false },
  obtain_food: { objective: 'Obtain food (harvest, hunt, fish or trade) to restore hunger.', emergency: false },
  obtain_weapon: { objective: 'Craft or find a weapon before resuming.', emergency: false },
  obtain_armor: { objective: 'Obtain armor to reduce incoming damage.', emergency: false },
  replace_tool: { objective: 'Replace the nearly broken tool held in hand.', emergency: false },
});

// Candidate goals for the current observation, best first. Empty when the bot
// has no state, is dead (the harness only offers `wait`), or has no actionable
// need.
export function deriveIdleGoals (observation = {}, { rules = [] } = {}) {
  const perception = perceive(observation);
  if (!perception.hasState || perception.dead) return [];
  const governor = evaluateSurvival(observation, { rules });
  const emergency = governor.mode === 'emergency';

  const candidates = [];
  for (const need of governor.needs) {
    const spec = NEED_GOALS[need];
    if (!spec) continue;
    const isEmergency = emergency && spec.emergency;
    candidates.push({
      need,
      objective: spec.objective,
      source: isEmergency ? GOAL_SOURCE.EMERGENCY : GOAL_SOURCE.AUTONOMOUS,
      priority: isEmergency ? SOURCE_PRIORITY[GOAL_SOURCE.EMERGENCY] : SOURCE_PRIORITY[GOAL_SOURCE.AUTONOMOUS],
      utility: NEED_PRIORITY[need] + (isEmergency ? 1000 : 0),
      mode: governor.mode,
      reason: governor.rule ?? governor.reasons[0] ?? need,
    });
  }
  candidates.sort((a, b) => b.utility - a.utility);
  return candidates;
}

// The next autonomous goal to enqueue, skipping needs attempted within the
// cooldown (anti-loop: a need that just failed must not be retried forever).
export function nextIdleGoal (observation, {
  rules = [],
  attempts = new Map(),
  cooldownMs = DEFAULT_AUTONOMY_COOLDOWN_MS,
  now = Date.now(),
  allow = () => true,
} = {}) {
  for (const candidate of deriveIdleGoals(observation, { rules })) {
    // `allow` sceglie quali candidati sono ammessi (il controller lo usa per
    // distinguere i bisogni che il governor dichiara *adesso* dall'autonomia
    // generale); il cooldown resta l'anti-loop.
    if (!allow(candidate)) continue;
    const last = attempts.get(candidate.need);
    if (last != null && now - last < cooldownMs) continue;
    return candidate;
  }
  return null;
}

// Deterministic success predicate: has the need that created the goal gone?
// Checked against harness state, never the model's opinion.
export function isNeedResolved (need, observation = {}, { rules = [] } = {}) {
  const perception = perceive(observation);
  if (perception.dead) return false;
  const governor = evaluateSurvival(observation, { rules });
  switch (need) {
    case 'survive': return perception.health != null && perception.health > 6;
    case 'escape': return !perception.nearestThreat || perception.nearestThreat.severity === 'low';
    case 'eat': return perception.food != null && perception.food > 14;
    case 'heal': return perception.health != null && perception.health > 12;
    case 'sleep': return !perception.night;
    case 'shelter': return !perception.night;
    case 'obtain_food': return perception.hasFood;
    case 'obtain_weapon': return !!perception.weapon;
    case 'obtain_armor': return perception.armorCount > 0;
    case 'replace_tool': {
      const held = perception.heldDurability;
      return !(held && held.max > 0 && held.max - held.damage <= 5);
    }
    default: return !governor.needs.includes(need);
  }
}
