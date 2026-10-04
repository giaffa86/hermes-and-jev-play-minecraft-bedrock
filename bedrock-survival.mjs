// Logica di sopravvivenza per l'adapter Bedrock: classificazione entità ostili,
// scelta del cibo, ora del giorno e direzioni di fuga.
//
// Questo modulo è puro (nessun accesso a socket/mondo) così le regole restano
// testabili senza server e l'adapter contiene solo l'orchestrazione.

// Identificatori Bedrock (senza prefisso minecraft:) delle entità ostili.
const HOSTILE_TYPES = new Set([
  'zombie', 'husk', 'drowned', 'zombie_villager', 'zombie_villager_v2',
  'zombified_piglin', 'zombie_pigman',
  'skeleton', 'stray', 'bogged', 'wither_skeleton',
  'creeper', 'spider', 'cave_spider', 'silverfish', 'endermite',
  'enderman', 'witch', 'slime', 'magma_cube',
  'phantom', 'guardian', 'elder_guardian', 'shulker',
  'blaze', 'ghast', 'piglin', 'piglin_brute', 'hoglin', 'zoglin',
  'pillager', 'vindicator', 'evocation_illager', 'ravager', 'vex',
  'warden', 'breeze', 'wither', 'ender_dragon',
]);

// Entità con cui si può commerciare: villager (vecchio e nuovo id) e mercante
// itinerante, più i lama che lo seguono (contesto, non commerciabili).
const TRADER_TYPES = new Set([
  'villager', 'villager_v2', 'wandering_trader', 'trader_llama',
]);

// Altezze approssimative per mirare al centro del corpo (il registry non le espone).
const ENTITY_HEIGHTS = {
  villager: 1.95, villager_v2: 1.95, wandering_trader: 1.95, trader_llama: 1.87,
  zombie: 1.95, husk: 1.95, drowned: 1.95, zombified_piglin: 1.95, zombie_pigman: 1.95,
  zombie_villager: 1.95, zombie_villager_v2: 1.95, piglin: 1.95, piglin_brute: 1.95,
  skeleton: 1.99, stray: 1.99, bogged: 1.99, wither_skeleton: 2.4,
  creeper: 1.7, spider: 0.9, cave_spider: 0.5, silverfish: 0.3, endermite: 0.3,
  enderman: 2.9, witch: 1.95, slime: 1.0, magma_cube: 1.0,
  phantom: 0.5, guardian: 0.85, elder_guardian: 2.0, shulker: 1.0,
  blaze: 1.8, ghast: 4.0, hoglin: 1.4, zoglin: 1.4,
  pillager: 1.95, vindicator: 1.95, evocation_illager: 1.95, ravager: 2.2, vex: 0.8,
  warden: 2.9, breeze: 1.77, wither: 3.5, ender_dragon: 8.0,
  player: 1.8,
  cow: 1.4, mooshroom: 1.4, sheep: 1.3, pig: 0.9, chicken: 0.7, rabbit: 0.5,
  wolf: 0.85, cat: 0.7, ocelot: 0.7, horse: 1.6, donkey: 1.5, mule: 1.6,
  llama: 1.87, goat: 1.3, fox: 0.6, panda: 1.25, turtle: 0.4, parrot: 0.9,
  axolotl: 0.42, nautilus: 0.6, bee: 0.6,
};

// Cibi usabili per mangiare, in ordine di preferenza. Restano fuori gli item
// con effetti negativi (carne cruda di pollo, patata cruda/velenosa, occhio di
// ragno, pesce palla, carne putrefatta) e le golden apple, conservate per dopo.
const FOOD_PRIORITY = [
  'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_rabbit',
  'cooked_cod', 'cooked_salmon',
  'bread', 'baked_potato', 'carrot', 'apple', 'melon_slice', 'sweet_berries',
  'beef', 'porkchop', 'mutton', 'cod', 'salmon',
  'dried_kelp', 'cookie',
];

export function normalizeEntityType (type) {
  return String(type || '').replace(/^minecraft:/, '').toLowerCase();
}

export function isHostileType (type) {
  return HOSTILE_TYPES.has(normalizeEntityType(type));
}

export function isTraderType (type) {
  return TRADER_TYPES.has(normalizeEntityType(type));
}

export function entityHeight (type) {
  return ENTITY_HEIGHTS[normalizeEntityType(type)] ?? 1.8;
}

// Restituisce il nome del cibo preferito disponibile in inventario, o null.
export function bestFood (inventory = {}) {
  for (const name of FOOD_PRIORITY) {
    if ((inventory[name] || 0) > 0) return name;
  }
  return null;
}

export function foodRank (name) {
  const index = FOOD_PRIORITY.indexOf(name);
  return index < 0 ? null : index;
}

// Stima l'ora del giorno dal valore di set_time e dal tempo reale trascorso
// (20 tick di gioco al secondo, ciclo di 24000 tick).
export function estimatedTimeOfDay (baseTicks, baseAt, now = Date.now()) {
  const elapsed = Math.floor((now - baseAt) / 50);
  return (((baseTicks + elapsed) % 24000) + 24000) % 24000;
}

// Notte "dormibile": dalla finestra vanilla di sonno (12541..23458) con un
// margine, così l'opzione sleep non viene offerta in pieno giorno.
export function isNightTime (ticks) {
  return ticks >= 12500 && ticks <= 23500;
}

export function timePhase (ticks) {
  if (ticks >= 12500 && ticks < 13500) return 'dusk';
  if (ticks >= 13500 && ticks <= 22500) return 'night';
  if (ticks > 22500 && ticks <= 23500) return 'dawn';
  return 'day';
}

// Vettore unitario che allontana da `threat` rispetto a `from`.
export function awayDirection (from, threat) {
  let dx = (from.x - threat.x), dz = (from.z - threat.z);
  const length = Math.hypot(dx, dz);
  if (length < 1e-6) return { x: 1, z: 0 };
  return { x: dx / length, z: dz / length };
}

// Ruota una direzione XZ di `degrees` (senso orario vista dall'alto).
export function rotateDirection (dir, degrees) {
  const rad = degrees * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return { x: dir.x * cos - dir.z * sin, z: dir.x * sin + dir.z * cos };
}

// Animali da fattoria (passivi) che il bot può allevare/cacciare. I villager
// restano fuori (sono trader), così come i domestici (lupo/gatto: taming a parte).
const FARM_ANIMAL_TYPES = new Set([
  'cow', 'mooshroom', 'sheep', 'pig', 'chicken', 'rabbit',
]);

// Animali mungibili con un secchio vuoto. In Bedrock il munge `bucket` ->
// `milk_bucket`; il mooshroom dà lo stesso latte (la zuppa di funghi richiede
// una ciotola e non è implementata).
const MILKABLE_TYPES = new Set(['cow', 'mooshroom']);

// Cibo per nutrire/riprodurre ogni specie (item Bedrock senza prefisso).
const ANIMAL_FEED = {
  chicken: 'wheat_seeds',
  cow: 'wheat',
  mooshroom: 'wheat',
  sheep: 'wheat',
  pig: 'carrot',
  rabbit: 'carrot',
};

// Animali addomesticabili con cibo, e i relativi item (lista, con alternative).
// Non sono animali da allevamento: il flag `tamed` (lupo/gatto/pappagallo) o
// `trusting` (ocelot) + `owner_eid` ne segna l'esito.
const TAMEABLE_TYPES = new Set(['wolf', 'cat', 'ocelot', 'parrot']);
const TAME_FEED = {
  wolf: ['bone'],
  cat: ['cod', 'salmon'],
  ocelot: ['cod', 'salmon'],
  parrot: ['wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds'],
};

// Cavalcabili da domare montandoli ripetutamente (nessun cibo): il flag `tamed`
// compare quando smettono di disarcionare. Include il nautilus (compagno
// acquatico aggiunto da poco, con armatura dedicata come i cavalli).
const RIDE_TAMEABLE_TYPES = new Set(['horse', 'donkey', 'mule', 'llama', 'trader_llama', 'nautilus']);

// Animali da compagnia in senso lato, incluso l'axolotl che segue (tenendo in
// mano un secchio di pesci tropicali) ma non ha flag `tamed`/`trusting`.
const COMPANION_TYPES = new Set([...TAMEABLE_TYPES, ...RIDE_TAMEABLE_TYPES, 'axolotl']);

// Da item piantabile (seme od ortaggio) alla coltura che appare sul terreno.
const SEED_TO_CROP = {
  wheat_seeds: 'wheat',
  beetroot_seeds: 'beetroot',
  carrot: 'carrots',
  potato: 'potatoes',
  melon_seeds: 'melon_stem',
  pumpkin_seeds: 'pumpkin_stem',
  sweet_berries: 'sweet_berry_bush',
  nether_wart: 'nether_wart',
};

const CROP_BLOCKS = new Set(Object.values(SEED_TO_CROP));

export function isFarmAnimalType (type) {
  return FARM_ANIMAL_TYPES.has(normalizeEntityType(type));
}

export function isMilkableType (type) {
  return MILKABLE_TYPES.has(normalizeEntityType(type));
}

export function isTameableType (type) {
  return TAMEABLE_TYPES.has(normalizeEntityType(type));
}

export function isRideTameableType (type) {
  return RIDE_TAMEABLE_TYPES.has(normalizeEntityType(type));
}

export function isCompanionType (type) {
  return COMPANION_TYPES.has(normalizeEntityType(type));
}

export function animalFeed (type) {
  return ANIMAL_FEED[normalizeEntityType(type)] || null;
}

export function tameFeed (type) {
  return (TAME_FEED[normalizeEntityType(type)] || []).slice();
}

// Veicoli (barche e carrelli): entità su cui il bot può salire e viaggiare.
// Le barche hanno una variante per legno (…_boat) e con baule (…_chest_boat) più
// il bamboo_raft; i carrelli hanno le varianti con baule/tramoggia/TNT/comando.
export function isVehicleType (type) {
  const name = normalizeEntityType(type);
  if (name === 'boat' || name.endsWith('_boat') || name.endsWith('_chest_boat') || name.endsWith('_raft')) return true;
  if (name === 'minecart' || name.endsWith('_minecart')) return true;
  return false;
}

// Tutto ciò che si può montare/cavalcare: veicoli + cavalcabili domabili.
export function isRideableType (type) {
  return isVehicleType(type) || isRideTameableType(type);
}

export function cropForSeed (item) {
  return SEED_TO_CROP[String(item).replace(/^minecraft:/, '')] || null;
}

export function isCropBlock (name) {
  return CROP_BLOCKS.has(String(name).replace(/^minecraft:/, ''));
}

export function isFarmlandBlock (name) {
  return String(name).replace(/^minecraft:/, '') === 'farmland';
}

// Crescita delle colture in Bedrock: lo stato `growth` va da 0 a 7 e solo
// all'ultimo valore la pianta è matura (raccolto pieno + semi); il nether_wart
// usa invece `age` 0-3. Qui c'è solo la tabella: la politica resta al chiamante,
// perché `mature: null` (stato non leggibile) non significa "acerba".
const CROP_MAX_GROWTH = {
  wheat: 7,
  carrots: 7,
  potatoes: 7,
  beetroot: 7,
  melon_stem: 7,
  pumpkin_stem: 7,
  sweet_berry_bush: 7,
  nether_wart: 3,
};

const SEED_FOR_CROP = Object.fromEntries(
  Object.entries(SEED_TO_CROP).map(([seed, crop]) => [crop, seed]));

// Il seme che ripianta una coltura (per carote e patate il seme è il raccolto).
export function seedForCrop (crop) {
  return SEED_FOR_CROP[String(crop).replace(/^minecraft:/, '')] || null;
}

export function cropMaxGrowth (name) {
  return CROP_MAX_GROWTH[String(name).replace(/^minecraft:/, '')] ?? null;
}

function blockProperties (block) {
  if (typeof block?.getProperties === 'function') {
    try { return block.getProperties(); } catch { return null; }
  }
  // Un Block prismarine "spalmato" (es. il risultato di `findBlocks`) perde i
  // metodi ma conserva lo stato in `_properties`; `computedStates` porta i
  // default calcolati. Senza questo ramo la maturità risulterebbe ignota in
  // produzione (fail-open) mentre nei test, che passano istanze vere, funziona.
  const base = block?.properties || block?._properties || block?.states;
  const computed = block?.computedStates;
  if (!base && !computed) return null;
  return { ...(base || {}), ...(computed || {}) };
}

// `null` se il blocco non è una coltura nota; altrimenti `{ name, growth, max,
// mature }`, con `growth`/`mature` a `null` quando lo stato non è leggibile
// (blocco finto, registry senza stati, sezione non decodificata).
export function cropMaturity (block) {
  const name = String(block?.name ?? '').replace(/^minecraft:/, '');
  const max = CROP_MAX_GROWTH[name];
  if (!max) return null;
  const props = blockProperties(block);
  const raw = props?.growth ?? props?.age;
  const growth = raw == null || Number.isNaN(Number(raw)) ? null : Number(raw);
  return { name, growth, max, mature: growth == null ? null : growth >= max };
}

export const HOSTILE_TYPE_COUNT = HOSTILE_TYPES.size;
export const TRADER_TYPE_COUNT = TRADER_TYPES.size;
export const FARM_ANIMAL_TYPE_COUNT = FARM_ANIMAL_TYPES.size;
export const MILKABLE_TYPE_COUNT = MILKABLE_TYPES.size;
// Materiali per craftare un secchio vuoto (Bedrock: 3 lingotti di ferro).
export const BUCKET_INGREDIENTS = { iron_ingot: 3 };
// Materiali per lo scudo (Bedrock: 1 lingotto di ferro + 6 assi, legno qualsiasi).
export const SHIELD_INGREDIENTS = { iron_ingot: 1, planks: 6 };
export const FOODS = [...FOOD_PRIORITY];
export const PLANTABLE_ITEMS = Object.keys(SEED_TO_CROP);
export const ANIMAL_FEED_MAP = { ...ANIMAL_FEED };
export const SEED_TO_CROP_MAP = { ...SEED_TO_CROP };
export const CROP_MAX_GROWTH_MAP = { ...CROP_MAX_GROWTH };
export const TAME_FEED_MAP = { ...TAME_FEED };
export const TAMEABLE_TYPE_COUNT = TAMEABLE_TYPES.size;
export const RIDE_TAMEABLE_TYPE_COUNT = RIDE_TAMEABLE_TYPES.size;
export const COMPANION_TYPE_COUNT = COMPANION_TYPES.size;
