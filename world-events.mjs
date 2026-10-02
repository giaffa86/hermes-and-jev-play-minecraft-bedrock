// World events — transitions in the harness observation that deserve attention.
//
// Pure module: no I/O. It compares two observations (the previous step and the
// current one) and emits typed events. The controller turns a subset of them
// into *emergency goals* (see emergency-goals.mjs); the others are handled by
// the Survival Governor inside the running goal.
//
// Detection is transition-based (or "already true at goal start") and every
// event carries a `dedupKey`, so a condition that persists across steps produces
// one event, not one per step.

import { perceive } from './survival/perception.mjs';
import { oreValue, oreDrop, ORE_EVENT_MIN_VALUE } from './ore-value.mjs';

export const WORLD_EVENTS = Object.freeze({
  PLAYER_DIED: 'PLAYER_DIED',
  LOW_HEALTH: 'LOW_HEALTH',
  HOSTILE_AMBUSH: 'HOSTILE_AMBUSH',
  VALUABLE_ORE_SEEN: 'VALUABLE_ORE_SEEN',
});

const LOW_HEALTH_THRESHOLD = 6;
// Only ores close enough to be taken without a trip of their own. The adapter
// scans the same radius, so anything reported here is also a mine_* option.
const ORE_INTEREST_RANGE = 24;

function oreSightingKey (ore) {
  const p = ore?.position;
  if (!ore?.name || !p) return null;
  return `${ore.name}@${Math.round(p.x ?? 0)},${Math.round(p.y ?? 0)},${Math.round(p.z ?? 0)}`;
}

function siteKey (deathSite) {
  const p = deathSite?.position;
  if (!p) return null;
  return `${Math.round(p.x ?? 0)},${Math.round(p.y ?? 0)},${Math.round(p.z ?? 0)}`;
}

// `prev` may be null (first observation of a goal): a condition that is already
// true is reported once, which is what a resumed/started goal needs.
export function detectEvents (prev = null, curr = {}, { now = Date.now() } = {}) {
  const events = [];
  if (!curr || typeof curr !== 'object') return events;
  const wasDead = prev?.dead === true;
  const isDead = curr.dead === true;
  const site = siteKey(curr.deathSite);
  const prevSite = siteKey(prev?.deathSite);

  // Death: the flag flips, or a death site appears/changes (a poll can miss the
  // `dead:true` frame because the harness respawns the bot).
  const died = (!wasDead && isDead) || (!isDead && site != null && site !== prevSite);
  if (died) {
    events.push({
      type: WORLD_EVENTS.PLAYER_DIED,
      severity: 'critical',
      dedupKey: `death:${site ?? 'unknown'}`,
      data: { deathSite: curr.deathSite ?? null, position: curr.position ?? null },
      at: now,
    });
  }

  const health = Number.isFinite(curr.health) ? curr.health : null;
  const prevHealth = Number.isFinite(prev?.health) ? prev.health : null;
  if (!isDead && health != null && health <= LOW_HEALTH_THRESHOLD && (prevHealth == null || prevHealth > LOW_HEALTH_THRESHOLD)) {
    events.push({
      type: WORLD_EVENTS.LOW_HEALTH,
      severity: 'critical',
      dedupKey: `health:${health}`,
      data: { health },
      at: now,
    });
  }

  // Hostile ambush: a hostile enters the critical distance band. Kept at the
  // governor for the instant reaction; detected here so a producer *may* promote
  // it to a goal later.
  const threat = perceive(curr).nearestThreat;
  const prevThreat = prev ? perceive(prev).nearestThreat : null;
  if (!isDead && threat?.severity === 'critical' && prevThreat?.severity !== 'critical') {
    events.push({
      type: WORLD_EVENTS.HOSTILE_AMBUSH,
      severity: 'critical',
      dedupKey: `ambush:${threat.type}`,
      data: { threat },
      at: now,
    });
  }

  // Valuable ore sighting: a new vein entered view. Not an emergency — it is an
  // *opportunity*: a producer (opportunity-goals.mjs) decides whether it is
  // worth suspending the current goal, and the world memory already stores the
  // site either way. Reported once per block position (`dedupKey`).
  const seenOres = new Set((prev?.ores ?? []).map(oreSightingKey).filter(Boolean));
  for (const ore of curr.ores ?? []) {
    const key = oreSightingKey(ore);
    if (!key || seenOres.has(key)) continue;
    const value = oreValue(ore.name);
    if (value < ORE_EVENT_MIN_VALUE) continue;
    if (Number.isFinite(ore.distance) && ore.distance > ORE_INTEREST_RANGE) continue;
    events.push({
      type: WORLD_EVENTS.VALUABLE_ORE_SEEN,
      severity: 'notice',
      dedupKey: `ore:${key}`,
      data: {
        ore: ore.name,
        value,
        drop: oreDrop(ore.name),
        position: ore.position ?? null,
        distance: Number.isFinite(ore.distance) ? ore.distance : null,
        harvestable: ore.harvestable !== false,
      },
      at: now,
    });
  }

  return events;
}
