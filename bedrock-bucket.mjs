// Secchi, barche e pozioni (M5 dei fluidi): le decisioni prima dei pacchetti.
//
// Modulo **puro**: nessuna I/O, nessun percorso. Riceve i blocchi osservati e
// l'inventario, e risponde a quattro domande:
//
//   1. quel blocco si può raccogliere con un secchio (e cosa ci finisce dentro);
//   2. cosa diventa il blocco se il secchio viene svuotato lì (acqua su lava →
//      ossidiana, acqua nel Nether → evaporata);
//   3. una barca è utilizzabile (serve acqua aperta e il bot non deve già
//      cavalcare qualcosa);
//   4. cosa manca per una pozione (stazione, combustibile, fiala, verruca,
//      ingrediente).
//
// In Bedrock il **nome** del blocco distingue la sorgente dall'acqua che scorre
// (`water` contro `flowing_water`): un secchio raccoglie solo le sorgenti, e
// questo verdetto si legge dal nome, non da `liquid_depth` — che sui blocchi
// che arrivano dalla rete è spesso illeggibile (lezione dei round M2/M5).
import { isWaterBlock, LAVA_BLOCKS, normalizeFluidName } from './bedrock-fluids.mjs';

export const BUCKET_ITEM = 'bucket';
export const WATER_BUCKET_ITEM = 'water_bucket';
export const LAVA_BUCKET_ITEM = 'lava_bucket';
export const MILK_BUCKET_ITEM = 'milk_bucket';
export const POWDER_SNOW_BUCKET_ITEM = 'powder_snow_bucket';
export const GLASS_BOTTLE_ITEM = 'glass_bottle';
export const WATER_BOTTLE_ITEM = 'potion';
export const POWDER_SNOW_BLOCK = 'powder_snow';
export const OBSIDIAN_BLOCK = 'obsidian';
export const COBBLESTONE_BLOCK = 'cobblestone';
export const STONE_BLOCK = 'stone';
export const BOAT_INGREDIENTS = { planks: 5 };
export const BOAT_MIN_WATER = 3;
export const BOAT_WATER_RANGE = 16;
export const NETHER_DIMENSIONS = new Set(['nether', 'the_nether', 'the_end', 'end']);
export const BREW_FUEL = 'blaze_powder';
export const BREW_BASE = 'nether_wart';
export const BREW_RECIPES = {
  water_breathing: 'pufferfish',
  fire_resistance: 'magma_cream',
  night_vision: 'golden_carrot',
};
export const BREW_EFFECTS = Object.keys(BREW_RECIPES);

const EMPTY_BLOCKS = new Set(['air', 'cave_air', 'void_air']);
// Celle che il secchio può riempire senza distruggere un blocco vero (in
// Bedrock piazzare acqua su erba alta o un cespuglio li sostituisce).
const REPLACEABLE = /(_tallgrass$|_grass$|^grass$|_fern$|^fern$|_flower$|_bush$|^vine$|^snow_layer$|_carpet$|^torch$|_torch$|^seagrass$|^kelp$|^sugar_cane$)/;

export function isBucketItem (name) {
  return name === BUCKET_ITEM || name === WATER_BUCKET_ITEM || name === LAVA_BUCKET_ITEM ||
    name === MILK_BUCKET_ITEM || name === POWDER_SNOW_BUCKET_ITEM;
}

export function isBoatItem (name) {
  if (typeof name !== 'string' || name === '') return false;
  return name === 'boat' || name.endsWith('_boat') || name.endsWith('_raft');
}

/** Cosa un secchio vuoto raccoglie in quella cella. */
export function bucketSourceVerdict ({ block = null } = {}) {
  const name = block?.name ? normalizeFluidName(block.name) : null;
  if (!name) return { fillable: false, item: null, name: null, reason: 'unknown_block' };
  if (isWaterBlock(name)) {
    if (name === 'flowing_water') return { fillable: false, item: null, name, reason: 'flowing_water' };
    return { fillable: true, item: WATER_BUCKET_ITEM, name, reason: 'water_source' };
  }
  if (LAVA_BLOCKS.has(name)) {
    if (name === 'flowing_lava') return { fillable: false, item: null, name, reason: 'flowing_lava' };
    return { fillable: true, item: LAVA_BUCKET_ITEM, name, reason: 'lava_source' };
  }
  if (name === POWDER_SNOW_BLOCK) return { fillable: true, item: POWDER_SNOW_BUCKET_ITEM, name, reason: 'powder_snow' };
  return { fillable: false, item: null, name, reason: 'not_a_source' };
}

/**
 * Cosa succede svuotando `held` sulla cella `target`.
 * Il verdetto dice *cosa diventa il mondo*: acqua su lava sorgente → ossidiana,
 * su lava che scorre → cobblestone; nel Nether/End l'acqua evapora.
 */
export function placeBucketVerdict ({ held = null, block = null, dimension = 'overworld' } = {}) {
  const heldName = typeof held === 'string' ? held : held?.name ?? null;
  if (!heldName || !isBucketItem(heldName) || heldName === BUCKET_ITEM) {
    return { ok: false, error: 'nothing_to_empty', held: heldName, result: null };
  }
  const name = block?.name ? normalizeFluidName(block.name) : null;
  const occupied = !!name && !EMPTY_BLOCKS.has(name) && !REPLACEABLE.test(name);
  if (heldName === WATER_BUCKET_ITEM) {
    if (NETHER_DIMENSIONS.has(dimension)) return { ok: false, error: 'water_in_nether', held: heldName, result: null };
    if (name === 'lava') return { ok: true, error: null, held: heldName, result: OBSIDIAN_BLOCK, reason: 'water_on_lava_source' };
    if (name === 'flowing_lava') return { ok: true, error: null, held: heldName, result: COBBLESTONE_BLOCK, reason: 'water_on_flowing_lava' };
    if (occupied) return { ok: false, error: 'blocked', held: heldName, result: null, block: name };
    return { ok: true, error: null, held: heldName, result: 'water', reason: 'water_source' };
  }
  if (heldName === LAVA_BUCKET_ITEM) {
    if (isWaterBlock(name)) return { ok: true, error: null, held: heldName, result: STONE_BLOCK, reason: 'lava_on_water_source' };
    if (occupied) return { ok: false, error: 'blocked', held: heldName, result: null, block: name };
    return { ok: true, error: null, held: heldName, result: 'lava', reason: 'lava_source' };
  }
  if (heldName === POWDER_SNOW_BUCKET_ITEM) {
    if (occupied) return { ok: false, error: 'blocked', held: heldName, result: null, block: name };
    return { ok: true, error: null, held: heldName, result: POWDER_SNOW_BLOCK, reason: 'powder_snow' };
  }
  // Il latte non si svuota in un blocco: `empty_bucket` su un secchio di latte
  // è solo un modo per riempire una fiala (o un errore dell'utente).
  return { ok: false, error: 'not_placeable', held: heldName, result: null };
}

/** Conferma di un riempimento/svuotamento dal delta di inventario. `spentItem`
 * è il recipiente consumato: il secchio per un secchio, la fiala per una fiala. */
export function bucketDelta ({ before = {}, after = {}, item = null, spentItem = BUCKET_ITEM } = {}) {
  const delta = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const change = (after[key] || 0) - (before[key] || 0);
    if (change !== 0) delta[key] = change;
  }
  const got = item ? (delta[item] || 0) : 0;
  const spent = delta[spentItem] || 0;
  return { delta, gained: got > 0 ? got : 0, spent: spent < 0 ? -spent : 0, ok: !!item && got > 0 && spent < 0 };
}

/** Una barca si usa solo su acqua aperta, e solo se non si sta già cavalcando. */
export function boatVerdict ({ boats = 0, water = null, riding = false, waterDistance = null } = {}) {
  if (riding) return { ok: false, error: 'already_riding', reason: 'il bot sta già cavalcando qualcosa' };
  if ((boats || 0) < 1) return { ok: false, error: 'missing_boat', reason: 'nessuna barca in inventario' };
  const count = water?.count ?? 0;
  const near = waterDistance ?? water?.nearest?.distance ?? water?.distance ?? null;
  if (count < BOAT_MIN_WATER) return { ok: false, error: 'no_water_nearby', reason: 'serve acqua aperta', waterCount: count };
  if (near != null && near > BOAT_WATER_RANGE) return { ok: false, error: 'no_water_nearby', reason: 'acqua troppo lontana', waterDistance: near, waterCount: count };
  return { ok: true, error: null, waterCount: count, waterDistance: near, reason: 'open_water' };
}

/**
 * Piano di una pozione: elenca i passi e, se manca qualcosa, il primo rifiuto
 * tipizzato. Non tocca la stazione di alchimia (che è un container con i suoi
 * pacchetti): dice solo se i materiali ci sono.
 */
export function brewPlan ({ effect = null, stand = false, fuel = 0, waterBottles = 0, netherWart = 0, ingredients = {} } = {}) {
  const ingredient = effect ? BREW_RECIPES[effect] ?? null : null;
  const base = { effect, ingredient, fuel: BREW_FUEL, steps: [] };
  if (!ingredient) return { ...base, ok: false, error: 'unknown_recipe', missing: null };
  const missing = [];
  if (!stand) missing.push('brewing_stand');
  if ((fuel || 0) < 1) missing.push(BREW_FUEL);
  if ((waterBottles || 0) < 1) missing.push(WATER_BOTTLE_ITEM);
  if ((netherWart || 0) < 1) missing.push(BREW_BASE);
  if ((ingredients[ingredient] || 0) < 1) missing.push(ingredient);
  const steps = [
    `fill a glass bottle at a water source (${WATER_BOTTLE_ITEM})`,
    `brew ${BREW_BASE} into an awkward potion`,
    `add ${ingredient} for ${effect}`,
  ];
  if (missing.length > 0) return { ...base, ok: false, error: `missing_${missing[0]}`, missing, steps };
  return { ...base, ok: true, error: null, missing: [], steps };
}
