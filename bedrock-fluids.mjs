// Fluid awareness: regole pure per acqua e lava. Nessun accesso a socket/mondo:
// testabile da solo (come bedrock-fishing.mjs / bedrock-trading.mjs).
//
// Milestone M0 di docs/wiki/fluids.md: il bot deve *sapere* dove sono i fluidi,
// trattare la lava come pericolo assoluto e non scavare mai un buco che si apra
// dentro un fluido. Il movimento in acqua (M1) e il respiro (M2) si appoggiano a
// questo modulo.
//
// Il rilevamento dell'acqua è definito una volta sola nel modulo della pesca:
// qui viene riesportato, non riscritto.

import { isWaterBlock } from './bedrock-fishing.mjs';

export { isWaterBlock };

export const LAVA_BLOCKS = new Set(['lava', 'flowing_lava', 'still_lava']);

// Raggio e tetto prudenti per la scansione: `/observe` è una rotta calda.
export const DEFAULT_FLUID_RADIUS = 24;
export const DEFAULT_FLUID_LIMIT = 256;

// Soglie di pericolo della lava (blocchi). Il contatto è letale; sotto, la
// distanza decide la gravità.
export const LAVA_CONTACT_RANGE = 2;
export const LAVA_NEAR_RANGE = 5;
export const LAVA_RANGE = 10;

// Soglia di aria insufficiente: finché M2 non espone il budget d'aria reale la
// regola `drowning` resta inerte (`air` null ⇒ nessun pericolo dichiarato).
export const AIR_CRITICAL = 8;

export function normalizeFluidName (name) {
  return String(name ?? '').replace(/^minecraft:/i, '').toLowerCase();
}

export function isLavaBlock (name) {
  return LAVA_BLOCKS.has(normalizeFluidName(name));
}

// 'water' | 'lava' | null. Un blocco `unknown` (hash non risolto) non è un
// fluido: la fisica locale lo tratta come solido, quindi non va promosso.
export function fluidKind (name) {
  const normalized = normalizeFluidName(name);
  if (LAVA_BLOCKS.has(normalized)) return 'lava';
  if (isWaterBlock(normalized)) return 'water';
  return null;
}

export function isFluidBlock (name) {
  return fluidKind(name) !== null;
}

export function distance3d (a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function nearestOf (cells, from) {
  let best = null;
  for (const cell of cells) {
    const distance = from ? distance3d(cell.position, from) : null;
    if (!best || (distance != null && (best.distance == null || distance < best.distance))) {
      best = { position: cell.position, distance: distance == null ? null : +distance.toFixed(1) };
    }
  }
  return best;
}

// Riassume un elenco di blocchi fluidi ({name, position}) in un censimento
// compatto: quanti e qual è il più vicino, per tipo. Il chiamante decide come
// raccoglierli (adapter: findBlocks su una regione limitata).
export function summarizeFluids (blocks = [], from = null) {
  const water = [];
  const lava = [];
  for (const block of blocks) {
    if (!block?.position) continue;
    const kind = fluidKind(block.name);
    if (kind === 'water') water.push(block);
    else if (kind === 'lava') lava.push(block);
  }
  const waterNearest = nearestOf(water, from);
  const lavaNearest = nearestOf(lava, from);
  return {
    water: { count: water.length, nearest: waterNearest },
    lava: { count: lava.length, nearest: lavaNearest },
    waterDistance: waterNearest?.distance ?? null,
    lavaDistance: lavaNearest?.distance ?? null,
  };
}

// Posizioni delle celle fluide, separate per tipo (serve a misure di distanza
// multiple: fuga dalla lava, laterale di sicurezza, futura navigazione).
export function fluidCells (blocks = []) {
  const out = { water: [], lava: [] };
  for (const block of blocks) {
    if (!block?.position) continue;
    const kind = fluidKind(block.name);
    if (kind) out[kind].push({ ...block.position });
  }
  return out;
}

// Verdetto compatto sul pericolo fluido, dal più grave al più lieve. `air` resta
// null finché il budget d'aria non è noto: in quel caso il pericolo di annegamento
// non viene dichiarato (mai un allarme inventato).
export function fluidHazard ({ inWater = false, headInWater = false, inLava = false, lavaDistance = null, air = null, airCritical = AIR_CRITICAL } = {}) {
  if (inLava) return { level: 'critical', reasons: ['in_lava'] };
  if (lavaDistance != null && lavaDistance <= LAVA_CONTACT_RANGE) return { level: 'critical', reasons: ['lava_adjacent'] };
  if (headInWater && air != null && air <= airCritical) return { level: 'critical', reasons: ['drowning'] };
  if (lavaDistance != null && lavaDistance <= LAVA_NEAR_RANGE) return { level: 'high', reasons: ['lava_near'] };

  const reasons = [];
  if (lavaDistance != null && lavaDistance <= LAVA_RANGE) reasons.push('lava_in_range');
  if (headInWater) reasons.push('head_underwater');
  if (inWater) reasons.push('in_water');
  if (!reasons.length) return { level: 'none', reasons: [] };
  // La lava in range resta più grave dell'essere bagnati; l'acqua da sola è un
  // segnale, non un allarme.
  return { level: reasons.includes('lava_in_range') ? 'medium' : 'low', reasons };
}

// Ordina le celle d'appoggio candidate per allontanarsi dalla lava: vince chi
// guadagna più distanza dal pericolo più vicino, a parità chi è più vicino al
// bot. Solo i guadagni reali (>= minGain) entrano in classifica: così `avoid_lava`
// non "fugge" verso una cella che è altrettanto vicina.
export function rankEscapeCells (candidates = [], { from = null, hazards = [], minGain = 1.5, limit = 4 } = {}) {
  const list = (candidates || []).filter(c => c && Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z));
  const threat = (hazards || []).filter(h => h && Number.isFinite(h.x) && Number.isFinite(h.y) && Number.isFinite(h.z));
  if (!list.length || !threat.length) return [];
  const minDistance = (point) => {
    let min = Infinity;
    for (const hazard of threat) {
      const d = distance3d(point, hazard);
      if (d < min) min = d;
    }
    return min;
  };
  const before = from ? minDistance(from) : Infinity;
  const ranked = list.map(cell => {
    const after = minDistance(cell);
    const gain = Number.isFinite(before) ? after - before : 0;
    return {
      cell,
      gain: +gain.toFixed(2),
      hazardDistance: +after.toFixed(1),
      distance: from ? +distance3d(cell, from).toFixed(2) : null,
    };
  });
  return ranked
    .filter(entry => entry.gain >= minGain)
    .sort((a, b) => (b.gain - a.gain) || ((a.distance ?? 0) - (b.distance ?? 0)))
    .slice(0, limit);
}

// Un scavo non deve aprire un varco verso un fluido: lava in una cella adiacente
// brucia e si propaga, l'acqua allaga il buco (e la base). `neighbors` sono i
// blocchi attorno alla cella che sta per essere rimossa; `avoidWater` alza la
// severità verso l'acqua (scavare una scala vicino a un lago la riempie).
export const SWIM_INPUT_FLAGS = {
  start_swimming: 29,
  stop_swimming: 30,
  want_up: 16,
  want_down: 17,
  auto_jumping_in_water: 7
};

// M1 (04/10/2026): i flag che il client dichiara nel pacchetto `player_auth_input`
// quando è in acqua. La **semantica** è quella osservata nella sessione umana:
// sneak = discesa rapida, nessun input = discesa lenta, spacebar (jump) = risalita
// dal fondale e scalata dei blocchi sulla riva; la **codifica** (nomi e bit) viene
// dallo schema Bedrock 1.26.51 (`InputData`: 29 start_swimming, 30 stop_swimming,
// 16 want_up, 17 want_down, 7 auto_jumping_in_water). Le transizioni sono a
// fronte (start/stop una volta sola) come nel client vanilla. La fisica locale non
// simula ancora il galleggiamento, quindi questa funzione prepara i flag ma non
// dichiara che il bot sappia nuotare: `swimSupported` resta false finché non
// misuriamo le velocità reali dal server.
export function swimInputFlags ({
  inWater = false, headInWater = false, swimming = false,
  wantUp = false, wantDown = false
} = {}) {
  const flags = [];
  if (headInWater && !swimming) flags.push('start_swimming');
  if (!headInWater && swimming) flags.push('stop_swimming');
  if (headInWater && wantDown) flags.push('want_down', 'down');
  if (headInWater && wantUp) flags.push('want_up', 'jumping');
  // In acqua con la testa fuori e il salto premuto: è la risalita della riva
  // ("risali anche sui blocchi di superficie adiacenti alla riva").
  if (inWater && !headInWater && wantUp) flags.push('auto_jumping_in_water', 'jumping');
  return flags;
}

export function digFluidRisk ({ neighbors = [], avoidWater = false } = {}) {
  for (const block of neighbors) {
    if (!block) continue;
    if (isLavaBlock(block.name)) {
      return { unsafe: true, reason: 'lava_adjacent', block: block.name, position: block.position ?? null };
    }
  }
  if (avoidWater) {
    for (const block of neighbors) {
      if (!block) continue;
      if (isWaterBlock(block.name)) {
        return { unsafe: true, reason: 'water_adjacent', block: block.name, position: block.position ?? null };
      }
    }
  }
  return { unsafe: false, reason: null, block: null, position: null };
}
