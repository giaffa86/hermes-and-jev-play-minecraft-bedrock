// Regole pure per l'economia del commercio: classificazione del valore degli
// item e scelta del trade più conveniente per livellare un villager senza
// spendere risorse preziose. Nessun accesso a socket/mondo: testabile da solo.
//
// L'adapter usa questo modulo per la strategia di "maxxing" di un commerciante:
// il loop ripete l'offerta più economica disponibile finché il tier non sale,
// evitando smeraldi e risorse preziose come pagamento.

// Professioni dei villager Bedrock (id -> nome). Mappa BEST-EFFORT basata
// sull'ordinamento vanilla di VillagerProfession; la fonte autorevole è il
// `display_name` di update_trade (es. "Cartographer"), che l'adapter verifica
// quando apre il commercio. La mappa serve solo a ordinare i candidati.
export const VILLAGER_PROFESSIONS = [
  'farmer', 'fisherman', 'shepherd', 'fletcher', 'librarian',
  'cartographer', 'cleric', 'armorer', 'weaponsmith', 'toolsmith',
  'butcher', 'leatherworker', 'stonemason', 'nitwit', 'unemployed',
];

export function professionName (id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 0) return null;
  return VILLAGER_PROFESSIONS[n] ?? null;
}

export function normalizeProfession (name) {
  return String(name || '').toLowerCase().replace(/[^a-z]/g, '');
}

export function professionMatches (candidate, target) {
  if (!candidate || !target) return false;
  return normalizeProfession(candidate) === normalizeProfession(target);
}

// Risorse mai usate come pagamento per livellare un commerciante (preziose).
const PRECIOUS_ITEMS = new Set([
  'diamond', 'diamond_block', 'diamond_ore', 'deepslate_diamond_ore',
  'netherite_ingot', 'netherite_scrap', 'netherite_block', 'ancient_debris',
  'emerald_block',
  'gold_ingot', 'gold_block', 'golden_apple', 'golden_carrot',
  'golden_helmet', 'golden_chestplate', 'golden_leggings', 'golden_boots',
  'golden_sword', 'golden_pickaxe', 'golden_axe', 'golden_shovel', 'golden_hoe',
  'iron_ingot', 'iron_block', 'lapis_lazuli', 'lapis_block',
  'ender_pearl', 'ender_eye', 'blaze_rod', 'blaze_powder', 'nether_star',
  'elytra', 'shulker_shell', 'trident', 'totem_of_undying', 'experience_bottle',
  'heart_of_the_sea', 'nautilus_shell', 'conduit', 'beacon', 'enchanting_table',
]);

// Item economici/rinnovabili preferiti per livellare (i più convenienti).
const CHEAP_ITEMS = new Set([
  'paper', 'glass', 'glass_pane', 'sugar', 'sugarcane',
  'wheat', 'wheat_seeds', 'potato', 'carrot', 'beetroot', 'beetroot_seeds',
  'bread', 'melon_slice', 'melon', 'pumpkin', 'pumpkin_seeds', 'apple', 'sweet_berries',
  'cactus', 'bamboo', 'kelp', 'dried_kelp', 'stick', 'flint', 'string', 'feather',
  'leather', 'rabbit_hide', 'wool', 'egg',
  'chicken', 'porkchop', 'beef', 'mutton', 'rabbit', 'cod', 'salmon',
  'coal', 'charcoal', 'clay_ball', 'brick', 'sand', 'gravel',
  'cobblestone', 'stone', 'dirt', 'grass_block',
]);

const CHEAP_SUFFIX = /(_planks|_log|_stem|_seeds|_sapling|_wool|_leaves|_hyphae)$/;

// Costo di un singolo input per la strategia di livellamento:
//   0        -> economico/rinnovabile (preferito)
//   1        -> neutro (redstone, sculk, rame, ...)
//   2        -> smeraldi (valuta: da evitare, ma non proibito in assoluto)
//   Infinity -> risorsa preziosa (mai spesa dal loop automatico)
export function tradeInputCost (name) {
  if (!name) return 0;
  if (PRECIOUS_ITEMS.has(name)) return Infinity;
  if (name === 'emerald') return 2;
  if (CHEAP_ITEMS.has(name) || CHEAP_SUFFIX.test(name)) return 0;
  return 1;
}

// Costo dell'offerta come il più alto costo per-item tra gli input (la quantità
// non conta per la classe: serve solo a escludere smeraldi/risorse preziose).
export function offerInputCost (offer) {
  let cost = tradeInputCost(offer?.buyA?.item);
  if (offer?.buyB) cost = Math.max(cost, tradeInputCost(offer.buyB.item));
  return cost;
}

export function offerUsesLeft (offer) {
  if (!offer?.maxUses) return Infinity; // sconosciuto: assumi disponibile
  return Math.max(0, offer.maxUses - (offer.uses || 0));
}

export function offerRequirementsMet (offer, inventory) {
  if (!offer) return false;
  if ((inventory[offer.buyA?.item] || 0) < (offer.buyA?.count || 0)) return false;
  if (offer.buyB && (inventory[offer.buyB.item] || 0) < (offer.buyB.count || 0)) return false;
  return true;
}

// Sceglie l'offerta migliore per livellare: costo minimo (mai sopra maxCost,
// default 1 => niente smeraldi né risorse preziose), poi più usi rimanenti,
// poi tier più basso (usare prima le offerte del tier corrente).
export function pickBestTrade (offers, inventory, { maxCost = 1 } = {}) {
  let best = null;
  for (const offer of offers || []) {
    if (!offerRequirementsMet(offer, inventory)) continue;
    if (offerUsesLeft(offer) <= 0) continue;
    const cost = offerInputCost(offer);
    if (cost > maxCost || cost === Infinity) continue;
    if (!best) { best = offer; continue; }
    const bestCost = offerInputCost(best);
    if (cost < bestCost) { best = offer; continue; }
    if (cost > bestCost) continue;
    const ua = offerUsesLeft(offer);
    const ub = offerUsesLeft(best);
    if (ua > ub) { best = offer; continue; }
    if (ua < ub) continue;
    if ((offer.tier || 0) < (best.tier || 0)) best = offer;
  }
  return best;
}

export const PRECIOUS_COUNT = PRECIOUS_ITEMS.size;
export const CHEAP_COUNT = CHEAP_ITEMS.size;
