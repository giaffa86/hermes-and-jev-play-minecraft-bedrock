// M4 — Lava: evitare (e attraversare più avanti).
//
// Modulo puro, nessuna I/O. Tre decisioni, tutte verificabili offline:
//
//  1. **Un colpo di lava distrugge il loot**: quando il bot muore dentro (o a un
//     blocco da) un lago di lava, il sito di morte non è più recuperabile. Qui si
//     calcola il verdetto *prima* che il percorso `recover_loot` parta.
//  2. **La fuga sceglie una sponda, preferibilmente d'acqua**: l'acqua spegne il
//     fuoco, quindi una cella adiacente all'acqua vale più di una cella solo
//     lontana dalla lava.
//  3. **Attraversare si può solo se attrezzati**: resistenza al fuoco e un ponte
//     (o acqua → ossidiana, che però nel Nether non si può piazzare). Il gate è
//     reale; la costruzione del ponte arriva con M5/M6, quindi il chiamante
//     riceve un rifiuto tipizzato e mai un falso successo.

import { normalizeEffectName } from './bedrock-dive.mjs';

// Il loot che cade in lava viene distrutto; a un blocco dal bordo finisce dentro.
export const LAVA_DEATH_RADIUS = 2;
// Camminare sul bordo di un lago a un blocco di distanza è già una scommessa.
export const SAFE_SHORE_MIN_GAP = 2;
// Oltre quattro celle di lava un salto non basta: serve un ponte vero.
export const LAVA_CROSS_GAP_LIMIT = 4;
export const FIRE_RESISTANCE_EFFECT = 'fire_resistance';
export const WATER_BUCKET_ITEM = 'water_bucket';
// Acqua piazzata su lava: sorgente → ossidiana, lava che scorre → pietra.
export const EXTINGUISH_RESULTS = new Set(['obsidian', 'cobblestone', 'stone', 'smooth_stone']);

export function cellKey (position) {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
}

export function lavaCellKeys (cells = []) {
  return new Set((cells || []).filter(Boolean).map(cellKey));
}

export function inLava (position, keys) {
  return !!position && !!keys && keys.has(cellKey(position));
}

function distance3d (a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

// Distanza minima dalla lava: `null` se il censimento non conosce celle.
export function lavaDistance (position, cells = []) {
  if (!position || !cells?.length) return null;
  let best = null;
  for (const cell of cells) {
    const d = distance3d(position, cell);
    if (best == null || d < best) best = d;
  }
  return best == null ? null : +best.toFixed(2);
}

// Il verdetto sul sito di morte: `recoverable: false` significa "non tornare a
// cercare il loot, la lava lo ha distrutto" (e le celle vicine non sono una
// destinazione valida per recuperarlo).
export function deathVerdict ({ position = null, lava = [], radius = LAVA_DEATH_RADIUS } = {}) {
  if (!position) return { known: false, position: null, inLava: false, nearest: null, recoverable: null, reason: 'unknown_site' };
  const keys = lavaCellKeys(lava);
  const inside = inLava(position, keys);
  const nearest = lavaDistance(position, lava);
  if (inside) {
    return { known: true, position, inLava: true, nearest, recoverable: false, reason: 'in_lava' };
  }
  if (nearest != null && nearest <= radius) {
    return { known: true, position, inLava: false, nearest, recoverable: false, reason: 'lava_near' };
  }
  return { known: true, position, inLava: false, nearest, recoverable: true, reason: 'safe' };
}

// I drop che giacciono in lava: non si recuperano e non si inseguono.
export function lostDrops (drops = [], lava = []) {
  const keys = lavaCellKeys(lava);
  if (!keys.size) return [];
  return (drops || [])
    .filter(drop => drop?.position && keys.has(cellKey(drop.position)))
    .map(drop => ({ id: drop.id ?? null, item: drop.item ?? null, position: drop.position }));
}

// Le sponde dove fuggire: raggiungibili, almeno `minGap` dalla lava, e — se
// possibile — con l'acqua accanto, perché entrare in acqua spegne il fuoco.
export function safeShorePlan ({ from = null, candidates = [], hazards = [], water = [], minGain = 1.5, minGap = SAFE_SHORE_MIN_GAP, limit = 4 } = {}) {
  if (!from) return [];
  const fromDistance = lavaDistance(from, hazards) ?? Infinity;
  const waterKeys = lavaCellKeys(water);
  const adjacentToWater = (cell) => {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (waterKeys.has(`${Math.floor(cell.x + dx)},${Math.floor(cell.y)},${Math.floor(cell.z + dz)}`)) return true;
    }
    return false;
  };
  const ranked = [];
  for (const cell of candidates || []) {
    if (!cell) continue;
    const distance = lavaDistance(cell, hazards);
    if (distance == null) continue;
    if (distance < minGap) continue;
    const gain = distance - fromDistance;
    if (!(gain >= minGain)) continue;
    const shore = adjacentToWater(cell);
    ranked.push({
      cell,
      gain: +gain.toFixed(2),
      lavaDistance: distance,
      waterAdjacent: shore,
      score: +(gain + (shore ? 2 : 0)).toFixed(2),
    });
  }
  ranked.sort((a, b) => (b.score - a.score) || (b.gain - a.gain) || (a.lavaDistance - b.lavaDistance));
  return ranked.slice(0, limit);
}

// Resistenza al fuoco attiva: `effects` accetta la mappa del bot o un array.
export function fireResistance ({ effects = [] } = {}) {
  const rows = typeof effects?.values === 'function' ? [...effects.values()] : (effects || []);
  for (const effect of rows) {
    const name = normalizeEffectName(effect?.name ?? effect?.id ?? '');
    if (name !== FIRE_RESISTANCE_EFFECT) continue;
    const seconds = effect?.seconds ?? (effect?.duration != null ? effect.duration / 20 : null);
    if (seconds != null && seconds <= 0) continue;
    return { active: true, seconds: seconds == null ? null : +seconds.toFixed(1), name };
  }
  return { active: false, seconds: null, name: FIRE_RESISTANCE_EFFECT };
}

// Quanti blocchi di lava separano il bot dalla sponda opposta, lungo una
// direzione: il primo tratto di lava incontrato, contato a passi di un blocco.
// `truncated` significa che la lava continua oltre `maxSteps`: la sponda opposta
// non è nel raggio di osservazione e non si inventa una larghezza.
export function lavaGap ({ from = null, direction = null, lava = [], lateral = 0, maxSteps = 6, vertical = 2 } = {}) {
  if (!from || !direction) return { gap: null, steps: [], reason: 'missing_inputs' };
  const length = Math.hypot(direction.x ?? 0, direction.z ?? 0);
  if (!length) return { gap: null, steps: [], reason: 'missing_inputs' };
  const ux = (direction.x ?? 0) / length;
  const uz = (direction.z ?? 0) / length;
  if (!lava?.length) return { gap: 0, steps: [], firstStep: null, lastStep: null, truncated: false, reason: 'no_lava' };
  const steps = [];
  let started = false;
  let truncated = false;
  for (let step = 1; step <= maxSteps; step++) {
    const px = from.x + ux * step;
    const pz = from.z + uz * step;
    const hit = lava.some(cell =>
      Math.abs(cell.x - px) <= lateral &&
      Math.abs(cell.z - pz) <= lateral &&
      Math.abs(cell.y - from.y) <= vertical);
    if (!started) {
      if (hit) {
        started = true;
        steps.push(step);
      }
      continue;
    }
    if (hit) {
      steps.push(step);
      if (step === maxSteps) truncated = true;
      continue;
    }
    break;
  }
  return {
    gap: steps.length,
    steps,
    firstStep: steps[0] ?? null,
    lastStep: steps[steps.length - 1] ?? null,
    truncated,
    direction: { x: +ux.toFixed(3), z: +uz.toFixed(3) },
    reason: !steps.length ? 'no_lava' : (truncated ? 'truncated' : 'measured'),
  };
}

// Il gate per attraversare: cosa manca e perché. Un rifiuto è sempre tipizzato e
// porta con sé i requisiti, così l'opzione può spiegare *cosa* raccogliere.
export function lavaCrossingGate ({
  dimension = 'overworld',
  gap = null,
  fireResistance: resistance = false,
  waterBuckets = 0,
  bridgeBlocks = 0,
  bridgeItem = 'cobblestone',
  requireResistanceOver = 1,
} = {}) {
  const waterAllowed = dimension !== 'nether' && dimension !== 'the_end';
  const width = Number.isFinite(gap) ? Math.max(0, Math.ceil(gap)) : null;
  const needs = {};
  if (width == null) {
    return { ok: false, error: 'gap_unknown', dimension, waterAllowed, needs, reason: 'the lava width is unknown, so a bridge cannot be sized' };
  }
  if (width > LAVA_CROSS_GAP_LIMIT) {
    return {
      ok: false,
      error: 'gap_too_wide',
      dimension,
      waterAllowed,
      gap: width,
      limit: LAVA_CROSS_GAP_LIMIT,
      needs: { blocks: width + 1 },
      reason: `the lava is ${width} blocks wide (limit ${LAVA_CROSS_GAP_LIMIT}): a jump or a single placement cannot cross it`,
    };
  }
  const needed = width + 1;
  const bridge = bridgeBlocks >= needed;
  const waterRoute = waterBuckets > 0 && waterAllowed;
  if (waterBuckets > 0 && !waterAllowed) {
    // L'acqua evapora subito nel Nether e nell'End: la via "secchio d'acqua" non
    // esiste, e dirla esistente sarebbe la bugia più costosa di questa milestone.
    return {
      ok: false,
      error: 'water_in_nether',
      dimension,
      waterAllowed,
      gap: width,
      needs: { blocks: needed },
      reason: 'water cannot be placed in the Nether or the End: use a block bridge',
    };
  }
  if (!bridge && !waterRoute) {
    if (width > 0) needs.blocks = needed;
    needs.waterBuckets = width > LAVA_CROSS_GAP_LIMIT ? undefined : 1;
    return {
      ok: false,
      error: 'not_equipped',
      dimension,
      waterAllowed,
      gap: width,
      needs: { blocks: needed, waterBuckets: 1 },
      reason: `a ${width}-block lava gap needs ${needed} ${bridgeItem} (or a water bucket): neither is available`,
    };
  }
  if (width > requireResistanceOver && !resistance) {
    return {
      ok: false,
      error: 'no_fire_resistance',
      dimension,
      waterAllowed,
      gap: width,
      route: bridge ? 'bridge' : 'water',
      needs: { fireResistance: true },
      reason: `crossing ${width} blocks of lava needs fire resistance: a slip costs the run`,
    };
  }
  return {
    ok: true,
    dimension,
    waterAllowed,
    gap: width,
    route: bridge ? (width === 0 ? 'none' : 'bridge') : 'water',
    fireResistance: !!resistance,
    blocks: bridge ? needed : 0,
    reason: width === 0 ? 'no lava to cross' : (bridge ? `bridge of ${needed} ${bridgeItem}` : 'water into obsidian then walk'),
  };
}
