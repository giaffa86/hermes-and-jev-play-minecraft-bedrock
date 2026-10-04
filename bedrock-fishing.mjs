// Regole pure per la pesca: classificazione dei pesci, rilevamento dei blocchi
// d'acqua, geometria della riva e finestra del morso. Nessun accesso a
// socket/mondo: testabile da solo (come bedrock-trading.mjs).
//
// L'adapter usa questo modulo per offrire craft_fishing_rod / cast_rod /
// reel_in / fish: la riva candidata, il rilevamento del morso e il delta
// inventario sono deterministici, mai delegati a un modello.

// Blocchi d'acqua Bedrock (senza prefisso minecraft:): sorgente e corrente.
const WATER_BLOCKS = new Set(['water', 'flowing_water', 'still_water']);

// Pesci pescabili (item Bedrock senza prefisso).
export const FISH_ITEMS = new Set(['cod', 'salmon', 'pufferfish', 'tropical_fish']);

// Pesci commestibili: gli stessi già in FOOD_PRIORITY (bedrock-survival.mjs).
export const EDIBLE_FISH = new Set(['cod', 'salmon']);

// Ricetta canna da pesca: 3 bastoni + 2 corda (griglia 3×3, tavolo da lavoro).
export const FISHING_ROD_INGREDIENTS = { stick: 3, string: 2 };

// Finestra del morso vanilla: 5–30 s (100–600 tick di gioco), ridotta con la
// pioggia o con l'incanto Lure. Il recupero va eseguito entro ~1 s dal morso.
export const BITE_MS_MIN = 5000;
export const BITE_MS_MAX = 30000;
export const REEL_GRACE_MS = 1000;

// Portata di lancio della canna (in blocchi, approssimazione prudente).
export const CAST_RANGE = 10;

export function normalizeItemName (name) {
  return String(name ?? '').replace(/^minecraft:/, '').toLowerCase();
}

export function isWaterBlock (name) {
  return WATER_BLOCKS.has(normalizeItemName(name));
}

export function isFishItem (name) {
  return FISH_ITEMS.has(normalizeItemName(name));
}

export function isEdibleFish (name) {
  return EDIBLE_FISH.has(normalizeItemName(name));
}

// Conteggio aggregato dei pesci in inventario (per delta e verifica).
export function fishCount (inventory = {}) {
  let total = 0;
  for (const [name, count] of Object.entries(inventory)) {
    if ((count || 0) <= 0) continue;
    if (isFishItem(name)) total += count;
  }
  return total;
}

// Nomi dei pesci presenti, normalizzati (per evidence e descrizioni).
export function fishItems (inventory = {}) {
  const names = new Set();
  for (const name of Object.keys(inventory)) {
    if ((inventory[name] || 0) > 0 && isFishItem(name)) names.add(normalizeItemName(name));
  }
  return [...names].sort();
}

// Dato un elenco di blocchi noti ({ name, position }), restituisce le celle di
// riva: blocchi non liquidi adiacenti in orizzontale a un blocco d'acqua, entro
// `castRange` dal bot (`from`). Ogni voce riporta `waterAt` (la cella d'acqua
// da mirare) e `distance`.
export function shoreCandidates (blocks, from, { castRange = CAST_RANGE } = {}) {
  const water = new Set();
  const ground = new Map();
  for (const block of blocks || []) {
    const p = block?.position;
    if (!p) continue;
    const key = `${p.x},${p.y},${p.z}`;
    if (isWaterBlock(block.name)) water.add(key);
    else if (!ground.has(key)) ground.set(key, { ...block, position: { ...p } });
  }
  const out = [];
  const seen = new Set();
  for (const key of water) {
    const [x, y, z] = key.split(',').map(Number);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const gk = `${x + dx},${y},${z + dz}`;
      if (seen.has(gk)) continue;
      seen.add(gk);
      const groundBlock = ground.get(gk);
      if (!groundBlock) continue;
      const distance = from
        ? Math.hypot(groundBlock.position.x - from.x, groundBlock.position.y - from.y, groundBlock.position.z - from.z)
        : 0;
      if (distance > castRange) continue;
      out.push({ ...groundBlock, distance: +distance.toFixed(1), waterAt: { x, y, z } });
    }
  }
  return out.sort((a, b) => a.distance - b.distance);
}

// Ritardo del morso per la fallback temporale: random uniforme nella finestra.
export function nextBiteDelay (random = Math.random) {
  return BITE_MS_MIN + random() * (BITE_MS_MAX - BITE_MS_MIN);
}

// Dove è finito il bobber, e se lì un morso **può** arrivare.
//
// Un `fishing_hook` che atterra sulla terraferma non prenderà mai nulla: aspettare
// la finestra vanilla (5-30 s) sarebbe tempo perso e un `no_bite` direbbe la cosa
// sbagliata («il server non manda il morso» invece di «il gancio è sul prato»).
// Il bobber galleggia **sopra** la cella d'acqua (la sua `y` arrotonda alla cella
// d'aria sovrastante), quindi vale come «in acqua» anche la cella sotto.
//
// `covered` non è un verdetto: è il dato che serve alla diagnosi live (una
// superficie d'acqua con un coperchio sopra è il pozzo del villaggio). `unknown`
// (nessun `blockAt`, o cella non caricata) è **fail-open**: non si dichiara
// «fuori dall'acqua» un mondo che non si sa leggere.
export function bobberVerdict ({ bobber, blockAt } = {}) {
  const p = bobber?.position;
  if (!p) return { ok: false, reason: 'no_bobber', unknown: false };
  if (typeof blockAt !== 'function') return { ok: true, reason: 'unknown', unknown: true };
  const cell = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  const at = blockAt(cell) ?? null;
  const below = blockAt({ x: cell.x, y: cell.y - 1, z: cell.z }) ?? null;
  const inAt = isWaterBlock(at?.name);
  const inBelow = isWaterBlock(below?.name);
  if (!inAt && !inBelow) {
    return {
      ok: false,
      reason: 'not_in_water',
      unknown: at == null && below == null,
      cell,
      at: at?.name ?? null,
      below: below?.name ?? null,
      waterCell: null,
      covered: false,
    };
  }
  const waterCell = inAt ? cell : { x: cell.x, y: cell.y - 1, z: cell.z };
  // La cella sopra la superficie d'acqua: se è solida l'acqua è coperta.
  const aboveSurface = blockAt({ x: waterCell.x, y: waterCell.y + 1, z: waterCell.z }) ?? null;
  const covered = aboveSurface != null && aboveSurface.name !== 'air' && aboveSurface.name !== 'unknown' && !isWaterBlock(aboveSurface.name);
  return {
    ok: true,
    reason: inAt ? 'in_water' : 'on_surface',
    unknown: false,
    cell,
    at: at?.name ?? null,
    below: below?.name ?? null,
    waterCell,
    covered,
    above: aboveSurface?.name ?? null,
  };
}
