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

  // Fluidi: la lava è un pericolo meccanico che il harness misura da solo, quindi
  // pesa quanto (o più di) un ostile. L'acqua è solo un segnale, l'annegamento
  // diventa critico quando il budget d'aria è noto e basso.
  const fluids = perception.fluids || {};
  const lavaDistance = Number.isFinite(fluids.lavaWithin) ? fluids.lavaWithin : null;
  if (fluids.inLava === true) {
    score += 60;
    push(reasons, 'in_lava');
  } else if (lavaDistance != null && lavaDistance <= 2) {
    score += 45;
    push(reasons, 'lava_adjacent');
  } else if (lavaDistance != null && lavaDistance <= 5) {
    score += 22;
    push(reasons, 'lava_near');
  } else if (lavaDistance != null && lavaDistance <= 10) {
    score += 8;
    push(reasons, 'lava_in_range');
  }
  if (fluids.headInWater === true) {
    if (Number.isFinite(fluids.air) && fluids.air <= 8) {
      score += 45;
      push(reasons, 'drowning');
    } else {
      push(reasons, 'head_underwater');
    }
  } else if (fluids.inWater === true) {
    push(reasons, 'in_water');
  }

  if (health != null && health <= 10 && nearest && nearest.distance <= 8) {
    score += 10;
    push(reasons, 'low_health_near_hostile');
  }

  // Nether/End (N0): fuoco, magma, proiettili in arrivo e sguardo verso un
  // enderman. Il fuoco addosso è un danno per tick, non un rischio statistico:
  // pesa quasi come un ostile critico, mentre la lava resta il massimo.
  const nether = perception.nether || {};
  if (nether.known === true) {
    if (nether.inFire === true) {
      score += 50;
      push(reasons, 'on_fire');
    } else if (Number.isFinite(nether.fireWithin) && nether.fireWithin <= 2) {
      score += 40;
      push(reasons, 'fire_adjacent');
    } else if (Number.isFinite(nether.fireWithin) && nether.fireWithin <= 5) {
      score += 20;
      push(reasons, 'fire_near');
    } else if (Number.isFinite(nether.fireWithin) && nether.fireWithin <= 10) {
      score += 6;
      push(reasons, 'fire_in_range');
    }
    if (Number.isFinite(nether.magmaWithin)) {
      if (nether.magmaWithin <= 1.5) {
        score += 35;
        push(reasons, 'on_magma');
      } else if (nether.magmaWithin <= 4) {
        score += 18;
        push(reasons, 'magma_near');
      }
    }
    if (nether.projectileIncoming === true) {
      const eta = Number.isFinite(nether.projectile?.timeToImpactMs) ? nether.projectile.timeToImpactMs : null;
      score += eta != null && eta <= 1000 ? 45 : 30;
      push(reasons, 'projectile_incoming');
    }
    if (nether.enderman?.gazed === true) {
      // Inutile nel Overworld (un enderman non si arrabbia se lo guardi lì),
      // decisivo nel Nether e nell'End.
      score += nether.isNether || nether.isEnd ? 12 : 0;
      if (nether.isNether || nether.isEnd) push(reasons, 'gazed_at_enderman');
    }
    if (Number.isFinite(nether.spawnerWithin) && nether.spawnerWithin <= 8) {
      score += 6;
      push(reasons, 'spawner_nearby');
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    level: riskLevelForScore(score),
    score,
    threats: perception.threats || [],
    reasons,
  };
}
