// Pure helpers for the controller loop: option ranking/capping, anti-loop
// detection and decision diagnostics. No I/O and no model calls live here, so
// the behaviour is unit-testable; controller.mjs owns the actual loop.
//
// The harness remains the only owner of action validity: these helpers may
// only reorder, cap or temporarily hide keys the harness already offered, and
// they never invent a key.

import { keyMatchesIntents } from './survival/intents.mjs';
import { oreValue, ORE_OPTION_PRIORITY_MIN_VALUE } from './ore-value.mjs';

export const DEFAULT_MAX_OPTIONS = 12;
export const DEFAULT_ANTI_LOOP_THRESHOLD = 3;

const SURVIVAL_KEYS = new Set(['flee', 'sleep', 'eat', 'recover_loot']);

// Distance in blocks parsed from an option description ("... (12.3 blocks away)"),
// used as tie-breaker inside the same relevance tier. Null when absent.
export function parseDistance (description) {
  const m = /([0-9]+(?:\.[0-9]+)?) blocks? away/.exec(description || '');
  return m ? +m[1] : null;
}

// Lower = more relevant when the option set has to be capped.
// 0 survival | 1 recover loot | 2 drop pickup | 3 skill intent | 4 target hit |
// 4.5 valuable ore (opportunity) | 5 progression crafts/places |
// 6 travel and digging | 7 generic mining | 10 wait.
//
// The 4.5 tier is the option-level half of the opportunity layer: a diamond or
// gold vein is worth taking even when the plan aims elsewhere, because the
// window is short (ORE_INTEREST_RANGE) while a craft can be done later. It stays
// below the plan target: the goal decides, the option only does not starve it.
export function optionPriority (option, { targets = {}, preferredIntents = [] } = {}) {
  const key = option?.key || '';
  if (SURVIVAL_KEYS.has(key) || key.startsWith('attack_')) return 0;
  if (key === 'collect_drop') return 1;
  if (key === 'follow_player') return 2; // ordine umano "seguimi"
  if (key === 'construction_step' || key === 'construction_supply') return 3;
  if (preferredIntents.length && keyMatchesIntents(key, preferredIntents)) return 3;
  for (const target of Object.keys(targets)) {
    const normalized = target.replace(/_/g, '');
    if (target === 'honey_bottle' && key === 'harvest_honey') return 4;
    if (key === `mine_${target}` || key === `craft_${target}` || key === `smelt_${target}` ||
        key.includes(target) || key.replace(/_/g, '').includes(normalized)) {
      return 4;
    }
  }
  if (key.startsWith('mine_') && oreValue(key.slice('mine_'.length)) >= ORE_OPTION_PRIORITY_MIN_VALUE) return 4.5;
  if (key.startsWith('craft_') || key.startsWith('place_') || key.startsWith('smelt_')) return 5;
  if (key === 'goto_waypoint' || key.startsWith('dig_')) return 6;
  if (key.startsWith('mine_')) return 7;
  if (key === 'wait') return 10;
  return 8;
}

// Stable relevance order: tier, then parsed distance, then original position.
export function rankOptions (options, context = {}) {
  return options
    .map((option, index) => ({ option, index }))
    .sort((a, b) => {
      const pa = optionPriority(a.option, context);
      const pb = optionPriority(b.option, context);
      if (pa !== pb) return pa - pb;
      const da = parseDistance(a.option.description) ?? Infinity;
      const db = parseDistance(b.option.description) ?? Infinity;
      if (da !== db) return da - db;
      return a.index - b.index;
    })
    .map(({ option }) => option);
}

// Keep at most `max` options (0 or negative disables the cap), selecting the
// most relevant ones but preserving the original order among the survivors so
// the criteria numbering stays stable for the model.
export function capOptions (options, { max = DEFAULT_MAX_OPTIONS, ...context } = {}) {
  if (!(max > 0) || options.length <= max) return { options, dropped: [] };
  const keep = new Set(rankOptions(options, context).slice(0, max).map(o => o.key));
  return {
    options: options.filter(o => keep.has(o.key)),
    dropped: options.filter(o => !keep.has(o.key)),
  };
}

// Choice criteria for the decision model: index -> "[key] description".
export function buildCriteria (options) {
  return Object.fromEntries(options.map((o, i) => [`a${i}`, `[${o.key}] ${o.description}`]));
}

// Progress = position, inventory or plan objective changed. Health/drops/entities
// are deliberately excluded: losing health is not progress, and a fresh drop does
// not mean the action worked.
export function progressFingerprint (obs, plan) {
  const p = obs?.position || {};
  const inventory = Object.entries(obs?.inventory || {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify({
    position: [Math.round(p.x ?? 0), Math.round(p.y ?? 0), Math.round(p.z ?? 0)],
    inventory,
    construction: obs?.construction ? [obs.construction.projectId, obs.construction.placed, obs.construction.phase, obs.construction.state, obs.construction.functionalIndex, obs.construction.walkIndex, obs.construction.temporaryRemoved, obs.construction.verification] : null,
    objective: plan?.objective ?? null,
  });
}

// Un ordine "seguimi" e' un impegno aperto: qualunque piano arrivi (replan,
// planner, governor) il goal resta un inseguimento della stessa persona finche'
// non arriva un altro ordine. Il follow e' quindi un attributo del *goal*, non
// del piano che il modello puo' riscrivere a ogni passo.
export function withStickyFollow (plan, follow) {
  if (!follow) return plan;
  if (plan && plan.follow === follow) return plan;
  return { ...(plan || {}), follow };
}

// Un ordine di stop ("fermati", "aspetta", "stop") deve chiudere un
// inseguimento aperto: il fallback deterministico del traduttore di ordini
// ("segui chi ti ha scritto") non deve mai trasformarlo in un follow.
export function isStopOrder (message) {
  return /\b(fermati|fermo|stop|basta|aspett\w*|resta|rimani|smettila|non seguirmi|stay|wait|stand still)\b/i.test(String(message || ''));
}

// Consecutive trailing executions of `key` without progress. A successful
// action (stagnant: false) or a different key resets the streak.
export function detectRepeatedAction (history = [], key, { threshold = DEFAULT_ANTI_LOOP_THRESHOLD } = {}) {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (!entry || entry.key !== key || !entry.stagnant) break;
    count++;
  }
  return { repeated: count >= threshold, count };
}

// What to pass to the model this step. Never returns an empty set and never
// hides a key that is the only remaining option: the harness owns validity.
export function filterOptions (options, history = [], {
  max = DEFAULT_MAX_OPTIONS,
  threshold = DEFAULT_ANTI_LOOP_THRESHOLD,
  targets = {},
  preferredIntents = [],
  excludeKeys = [],
} = {}) {
  const excluded = [];
  let kept = [...options];
  // Explicit exclusions: last failed action, anti-loop cooldowns.
  const explicit = new Map(excludeKeys.map(e => [e.key, e.reason || 'excluded']));
  for (const option of kept) {
    if (explicit.has(option.key)) excluded.push({ key: option.key, reason: explicit.get(option.key) });
  }
  kept = kept.filter(o => !explicit.has(o.key));
  // `wait` is a last resort: hide it whenever something else is available.
  if (kept.length > 1 && kept.some(o => o.key === 'wait')) {
    excluded.push({ key: 'wait', reason: 'wait_not_useful' });
    kept = kept.filter(o => o.key !== 'wait');
  }
  // Anti-loop: hide keys that just ran `threshold` times with no progress,
  // unless they are all that is left.
  const stagnant = [];
  for (const option of kept) {
    const { repeated, count } = detectRepeatedAction(history, option.key, { threshold });
    if (repeated) stagnant.push({ key: option.key, count });
  }
  let note = null;
  if (stagnant.length && stagnant.length < kept.length) {
    excluded.push(...stagnant.map(s => ({ key: s.key, reason: `stagnant_${s.count}` })));
    kept = kept.filter(o => !stagnant.some(s => s.key === o.key));
  } else if (stagnant.length) {
    note = 'all_stagnant';
  }
  const { options: capped, dropped } = capOptions(kept, { max, targets, preferredIntents });
  if (!capped.length) {
    // Never hand an empty set to the model: the harness said these keys are valid.
    const nonWait = options.filter(o => o.key !== 'wait');
    const restored = nonWait.length ? nonWait : options;
    return { options: restored, excluded, dropped: [], note: 'fallback_restored', fallback: { reason: 'filters_left_empty_set' } };
  }
  return { options: capped, excluded, dropped, note, fallback: null };
}

// Why the harness offered only `wait`, derived from the observation.
export function waitOnlyReason (obs) {
  if (!obs?.spawned || (obs.status && obs.status !== 'spawned')) return 'not_connected';
  if (obs.dead) return 'dead';
  if (obs.sleeping) return 'sleeping';
  if (!obs.position) return 'no_position';
  return 'no_useful_options';
}

export function summarizePlan (plan = {}) {
  const parts = [];
  if (plan.objective) parts.push(`Objective: ${plan.objective}`);
  if (plan.skill) parts.push(`Skill: ${plan.skill}`);
  if (plan.targets && Object.keys(plan.targets).length) parts.push(`Targets: ${JSON.stringify(plan.targets)}`);
  if (plan.waypoint) parts.push(`Waypoint: ${JSON.stringify(plan.waypoint)}`);
  if (plan.notes) parts.push(`Notes: ${plan.notes}`);
  return parts.join(' | ') || 'No plan.';
}

// Instructions for the decision model: explicit survival priorities and the
// no-progress rule, which the old prompt did not state.
export function buildDecisionInstructions (plan = {}) {
  return [
    'You control a Minecraft player.',
    summarizePlan(plan),
    'Follow this priority order:',
    '1. Survival: if a hostile mob is close and health is low (or the fight cannot be won), flee; if it is night and a bed is within reach with no immediate threat, sleep; if hunger is low and food is in inventory, eat; attack only when health is high enough to win.',
    '2. Recover: pick up nearby drops before they expire; if a death site is listed, go back and recover the dropped items and XP.',
    '3. Objective: otherwise pick the action that makes the most progress on the objective now.',
    'Never repeat an action that just produced no progress (same position, inventory and objective): choose a different action instead.',
    'Choose wait only when it is the only option offered or when nothing else can help.',
  ].join(' ');
}
