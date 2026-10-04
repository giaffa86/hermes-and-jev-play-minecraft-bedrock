// Bedrock apiculture rules. Unknown hive/fire states never authorize harvest.
import { blockProperties, normalizeName } from './bedrock-redstone.mjs';

export const HIVE_BLOCKS = ['bee_nest', 'beehive'];
export const BEE_CRAFT_ITEMS = ['beehive', 'honeycomb_block', 'honey_block', 'candle'];
export const BEE_SCAN_RADIUS = 24;
export const BEE_SCAN_LIMIT = 16;
// A conservative supported layout: fire immediately below, or one air gap.
// Other smoke geometries are deliberately outside the verified safety gate.
export const BEE_SMOKE_DEPTH = 2;
// Safe flower subset from Mojang's Bedrock bee.json breed_items.
export const BEE_FLOWERS = [
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet',
  'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip',
  'oxeye_daisy', 'cornflower', 'lily_of_the_valley',
  'sunflower', 'lilac', 'rose_bush', 'peony', 'torchflower',
  'pitcher_plant', 'pink_petals', 'wildflowers', 'cactus_flower',
];

function stateValue (value) {
  return value && typeof value === 'object' ? value.value : value;
}

export function isHive (block) {
  return HIVE_BLOCKS.includes(normalizeName(block?.name));
}

export function isBeeProtected (name) {
  return [...HIVE_BLOCKS, 'campfire', 'soul_campfire'].includes(normalizeName(name));
}

export function honeyLevel (block) {
  if (!isHive(block)) return null;
  const value = stateValue(blockProperties(block)?.honey_level);
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 5
    ? value : null;
}

export function campfireLit (block) {
  if (!['campfire', 'soul_campfire'].includes(normalizeName(block?.name))) return null;
  const value = stateValue(blockProperties(block)?.extinguished);
  if (value === 0 || value === false) return true;
  if (value === 1 || value === true) return false;
  return null;
}

export function hiveVerdict (block, blockAt) {
  const level = honeyLevel(block);
  const base = { honeyLevel: level, full: level === 5, smoked: false, campfire: null };
  if (!isHive(block) || !block?.position) return { ...base, safe: false, reason: 'hive_missing' };
  if (level == null) return { ...base, safe: false, reason: 'honey_unknown' };
  for (let depth = 1; depth <= BEE_SMOKE_DEPTH; depth++) {
    const position = { ...block.position, y: block.position.y - depth };
    const below = blockAt(position);
    if (!below || normalizeName(below.name) === 'unknown') {
      return { ...base, safe: false, reason: 'smoke_unknown' };
    }
    const lit = campfireLit(below);
    if (lit === true) {
      return { ...base, smoked: true, campfire: position, safe: level === 5,
        reason: level === 5 ? null : 'hive_not_full' };
    }
    if (['campfire', 'soul_campfire'].includes(normalizeName(below.name))) {
      return { ...base, safe: false, reason: lit === false ? 'campfire_unlit' : 'smoke_unknown' };
    }
    // Even transparent blocks/trapdoors/carpet are not assumed smoke-safe.
    if (!['air', 'cave_air', 'void_air'].includes(normalizeName(below.name))) {
      return { ...base, safe: false, reason: 'smoke_obstructed' };
    }
  }
  return { ...base, safe: false, reason: 'no_safe_campfire' };
}

export function beeFlower (inventory) {
  return BEE_FLOWERS.find(name => (inventory?.[name] || 0) > 0) ?? null;
}

export function beeFlowerCount (inventory) {
  return BEE_FLOWERS.reduce((sum, name) => sum + Math.max(0, inventory?.[name] || 0), 0);
}
