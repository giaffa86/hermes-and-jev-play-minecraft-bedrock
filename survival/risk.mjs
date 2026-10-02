// Risk: punteggio di pericolo deterministico a partire dalla perception.
//
// Il punteggio (0..100) e i motivi (`reasons`) sono calcolati con soglie
// esplicite: niente inferenza del modello su rischi meccanici che il harness
// può misurare da solo. Modulo puro e testabile senza server.

export const RISK_LEVELS = ['none', 'low', 'medium', 'high', 'critical'];

const SEVERITY_SCORE = { critical: 45, high: 28, medium: 12, low: 4 };

export function riskLevelForScore (score) {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  if (score > 0) return 'low';
  return 'none';
}

function push (reasons, reason) {
  if (!reasons.includes(reason)) reasons.push(reason);
}

export function assessRisk (perception = {}) {
  const reasons = [];
  let score = 0;

  if (!perception.hasState) return { level: 'none', score: 0, threats: [], reasons: [] };
  if (perception.dead) {
    return { level: 'critical', score: 100, threats: [], reasons: ['dead'] };
  }
  if (perception.sleeping) {
    // Dormire in un letto è il modo previsto per passare la notte.
    return { level: 'none', score: 0, threats: perception.threats || [], reasons: [] };
  }

  const health = perception.health;
  if (health != null) {
    if (health <= 4) { score += 40; push(reasons, 'critical_health'); }
    else if (health <= 8) { score += 28; push(reasons, 'low_health'); }
    else if (health <= 12) { score += 16; push(reasons, 'wounded'); }
    else if (health <= 16) { score += 6; }
  }

  const food = perception.food;
  if (food != null) {
    if (food <= 0) { score += 30; push(reasons, 'starving'); }
    else if (food <= 6) { score += 18; push(reasons, 'food_low'); }
    else if (food <= 10) { score += 8; push(reasons, 'food_low'); }
  }

  const nearest = perception.nearestThreat;
  if (nearest) {
    score += SEVERITY_SCORE[nearest.severity] ?? 0;
    if (nearest.severity === 'critical') push(reasons, 'hostile_critical');
    else if (nearest.severity === 'high') push(reasons, 'hostile_close');
    else if (nearest.severity === 'medium') push(reasons, 'hostile_nearby');
    // Altri ostili ravvicinati aggravano la situazione.
    const extra = (perception.threats || []).filter(t => t !== nearest && t.distance <= 8).length;
    if (extra > 0) {
      score += Math.min(10, extra * 4);
      push(reasons, 'multiple_hostiles');
    }
  }

  const sleepingPhase = perception.phase === 'night' || perception.phase === 'dusk';
  if (sleepingPhase) {
    score += 4;
    push(reasons, 'night');
    if (!perception.bedAvailable) {
      score += 6;
      push(reasons, 'no_shelter');
    }
  }

  if (health != null && health <= 10 && nearest && nearest.distance <= 8) {
    score += 10;
    push(reasons, 'low_health_near_hostile');
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    level: riskLevelForScore(score),
    score,
    threats: perception.threats || [],
    reasons,
  };
}
