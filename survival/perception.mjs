// Perception: normalizza l'osservazione del harness in uno stato di
// sopravvivenza strutturato, adatto a regole e scoring deterministici.
//
// Modulo puro: nessun accesso a socket, mondo o tempo reale. Riusa il
// vocabolario di bedrock-survival.mjs (ostili, cibo, fasi del giorno) e i tag
// item condivisi con le skill.

import { bestFood, isHostileType, normalizeEntityType } from '../bedrock-survival.mjs';
import { tagCount } from './item-tags.mjs';

export const MAX_HEALTH = 20;
export const MAX_FOOD = 20;

// Profili di pericolosità per distanza (blocchi) e tipo di mob.
// I creeper esplodono: già a 5 blocchi sono critici. I mob ranged colpiscono da
// lontano. Il default è il melee umanoide.
const THREAT_PROFILES = {
  creeper: { critical: 5, high: 10, medium: 16 },
  ranged: { critical: 4, high: 9, medium: 16 },
  default: { critical: 3, high: 8, medium: 16 },
};

const RANGED_TYPES = new Set([
  'skeleton', 'stray', 'bogged', 'wither_skeleton', 'witch', 'blaze',
  'piglin', 'pillager', 'guardian', 'elder_guardian', 'shulker', 'phantom',
]);

export function threatSeverity (type, distance) {
  const name = normalizeEntityType(type);
  const profile = THREAT_PROFILES[name] || (RANGED_TYPES.has(name) ? THREAT_PROFILES.ranged : THREAT_PROFILES.default);
  if (distance <= profile.critical) return 'critical';
  if (distance <= profile.high) return 'high';
  if (distance <= profile.medium) return 'medium';
  return 'low';
}

// Le entità di /observe hanno già `hostile`, ma la perception non se ne fida
// ciecamente: ricalcola il tipo con la stessa classificazione dell'adapter.
export function perceiveFluids (fluids = null) {
  // Un'osservazione senza `fluids` (harness vecchio, fixture) non dichiara
  // allarmi: `known: false` e nessun pericolo inventato.
  if (!fluids || typeof fluids !== 'object') {
    return {
      known: false, inWater: false, headInWater: false, inLava: false,
      lavaDistance: null, lavaWithin: null, waterDistance: null, waterWithin: null,
      lavaCount: 0, waterCount: 0, air: null,
    };
  }
  const num = (value) => (Number.isFinite(value) ? value : null);
  const lavaDistance = num(fluids.lavaDistance);
  const waterDistance = num(fluids.waterDistance);
  return {
    known: true,
    inWater: fluids.inWater === true,
    headInWater: fluids.headInWater === true,
    inLava: fluids.inLava === true,
    lavaDistance,
    // Alias usato dalle regole dichiarative ("lava entro N blocchi").
    lavaWithin: lavaDistance,
    waterDistance,
    waterWithin: waterDistance,
    lavaCount: num(fluids.lava?.count) ?? num(fluids.lavaCount) ?? 0,
    waterCount: num(fluids.water?.count) ?? num(fluids.waterCount) ?? 0,
    air: num(fluids.air),
  };
}

// Nether/End (N0): fuoco, magma, spawner, portali, proiettili in arrivo e
// sguardo verso un enderman. Come per i fluidi, un'osservazione senza `nether`
// (harness vecchio, fixture) non dichiara allarmi: `known: false`.
export function perceiveNether (nether = null) {
  if (!nether || typeof nether !== 'object') {
    return {
      known: false, dimension: null, isNether: false, isEnd: false,
      waterEvaporates: false, bedsExplode: false,
      inFire: false, headInFire: false, standingOnFire: false,
      fireDistance: null, fireWithin: null, magmaDistance: null, magmaWithin: null,
      spawnerDistance: null, spawnerWithin: null, portalDistance: null,
      endPortalDistance: null, endFrameDistance: null, portalCount: 0,
      projectile: null, projectileIncoming: false, projectileDistance: null,
      enderman: null, gazeKnown: false, hazard: null, ready: false,
    };
  }
  const num = (value) => (Number.isFinite(value) ? value : null);
  const shot = nether.projectile && typeof nether.projectile === 'object'
    ? {
      type: nether.projectile.type ?? null,
      distance: num(nether.projectile.distance),
      missDistance: num(nether.projectile.missDistance),
      timeToImpactMs: num(nether.projectile.timeToImpactMs),
      speed: num(nether.projectile.speed),
    }
    : null;
  const enderman = nether.enderman && typeof nether.enderman === 'object'
    ? {
      type: nether.enderman.type ?? null,
      distance: num(nether.enderman.distance),
      angleDeg: num(nether.enderman.angleDeg),
      gazed: nether.enderman.gazed === true,
    }
    : null;
  const fireDistance = num(nether.fireDistance);
  const magmaDistance = num(nether.magmaDistance);
  return {
    known: true,
    dimension: nether.dimension ?? null,
    isNether: nether.isNether === true,
    isEnd: nether.isEnd === true,
    waterEvaporates: nether.waterEvaporates === true,
    bedsExplode: nether.bedsExplode === true,
    inFire: nether.inFire === true || nether.headInFire === true || nether.standingOnFire === true,
    headInFire: nether.headInFire === true,
    standingOnFire: nether.standingOnFire === true,
    fireDistance,
    fireWithin: fireDistance,
    magmaDistance,
    magmaWithin: magmaDistance,
    spawnerDistance: num(nether.spawnerDistance),
    spawnerWithin: num(nether.spawnerDistance),
    portalDistance: num(nether.portalDistance),
    endPortalDistance: num(nether.endPortalDistance),
    endFrameDistance: num(nether.endFrameDistance),
    portalCount: num(nether.portals?.nether?.count) ?? 0,
    projectile: shot,
    projectileIncoming: shot != null,
    projectileDistance: shot?.distance ?? null,
    enderman,
    gazeKnown: enderman != null && typeof nether.enderman?.gazed === 'boolean',
    hazard: nether.hazard ?? null,
    ready: nether.ready !== false,
  };
}

export function perceiveThreats (entities = []) {
  const threats = [];
  for (const entity of entities) {
    if (!entity || !entity.position) continue;
    if (entity.hostile === false) continue;
    if (!isHostileType(entity.type)) continue;
    const distance = Number.isFinite(entity.distance) ? entity.distance : Infinity;
    threats.push({
      type: normalizeEntityType(entity.type),
      distance: +distance.toFixed(1),
      severity: threatSeverity(entity.type, distance),
      health: entity.health ?? null,
      position: entity.position,
    });
  }
  threats.sort((a, b) => a.distance - b.distance);
  return threats;
}

function bestTool (inventory, pattern) {
  const names = Object.keys(inventory || {})
    .filter(name => (inventory[name] || 0) > 0 && pattern.test(name));
  // Ordine di materiale decrescente, poi nome stabile.
  const rank = { netherite: 5, diamond: 4, iron: 3, stone: 2, copper: 2, golden: 1, wooden: 1 };
  names.sort((a, b) => {
    const ra = rank[a.split('_')[0]] ?? 0;
    const rb = rank[b.split('_')[0]] ?? 0;
    if (ra !== rb) return rb - ra;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return names[0] ?? null;
}

export function perceive (observation = {}) {
  const inventory = observation.inventory || {};
  const time = observation.time || null;
  const threats = perceiveThreats(observation.entities || []);
  const nearestThreat = threats[0] || null;
  const food = Number.isFinite(observation.food) ? observation.food : null;
  const health = Number.isFinite(observation.health) ? observation.health : null;
  const bestFoodItem = bestFood(inventory);
  const bed = observation.bed || null;
  return {
    hasState: !!observation.position || observation.spawned === true,
    spawned: observation.spawned === true,
    status: observation.status ?? null,
    dead: observation.dead === true,
    sleeping: observation.sleeping === true,
    position: observation.position || null,
    dimension: observation.dimension ?? null,
    health,
    food,
    maxHealth: MAX_HEALTH,
    maxFood: MAX_FOOD,
    phase: time?.phase ?? null,
    night: time?.night === true,
    timeKnown: !!time,
    threats,
    nearestThreat,
    bestFood: bestFoodItem,
    hasFood: !!bestFoodItem,
    foodCount: bestFoodItem ? (inventory[bestFoodItem] || 0) : 0,
    held: observation.held ?? null,
    heldDurability: observation.heldDurability ?? null,
    weapon: bestTool(inventory, /_(sword|axe)$/),
    pickaxe: bestTool(inventory, /_pickaxe$/),
    armorCount: Object.keys(inventory)
      .filter(name => /_(helmet|chestplate|leggings|boots)$/.test(name))
      .reduce((sum, name) => sum + (inventory[name] || 0), 0),
    bedAvailable: !!bed,
    bedDistance: bed?.distance ?? null,
    lootNearby: Array.isArray(observation.drops) && observation.drops.length > 0,
    dropCount: Array.isArray(observation.drops) ? observation.drops.length : 0,
    fluids: perceiveFluids(observation.fluids),
    nether: perceiveNether(observation.nether),
    inventorySummary: {
      logs: tagCount(inventory, 'logs'),
      planks: tagCount(inventory, 'planks'),
      cobblestone: tagCount(inventory, 'cobblestone'),
      coal: tagCount(inventory, 'coal'),
      ironIngots: tagCount(inventory, 'iron_ingots'),
      diamonds: tagCount(inventory, 'diamonds'),
      stoneTools: tagCount(inventory, 'stone_tools'),
      ironTools: tagCount(inventory, 'iron_tools'),
      food: tagCount(inventory, 'food'),
    },
    inventory,
  };
}
