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

export const WORLD_EVENTS = Object.freeze({
  PLAYER_DIED: 'PLAYER_DIED',
  LOW_HEALTH: 'LOW_HEALTH',
  HOSTILE_AMBUSH: 'HOSTILE_AMBUSH',
});

const LOW_HEALTH_THRESHOLD = 6;

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

  return events;
}
