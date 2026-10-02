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

// Altezze approssimative per mirare al centro del corpo (il registry non le espone).
const ENTITY_HEIGHTS = {
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

export const HOSTILE_TYPE_COUNT = HOSTILE_TYPES.size;
export const FOODS = [...FOOD_PRIORITY];
