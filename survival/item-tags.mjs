// Tag degli item: il vocabolario condiviso da perception, skill e verifier.
// Un tag è un nome dichiarativo (`logs`, `stone_tools`, ...) che aggrega più
// item Bedrock. I tag stanno qui, in un modulo puro, così le regole JSON non
// duplicano tabelle e i test coprono la corrispondenza senza server.

import { FOODS } from '../bedrock-survival.mjs';

// Ogni tag è un predicato sul nome item (senza prefisso minecraft:).
const TAG_PREDICATES = {
  logs: name => /(_log|_stem|_hyphae)$/.test(name),
  planks: name => /_planks$/.test(name),
  sticks: name => name === 'stick',
  cobblestone: name => name === 'cobblestone' || name === 'cobbled_deepslate' || name === 'blackstone',
  coal: name => name === 'coal' || name === 'charcoal',
  iron_ingots: name => name === 'iron_ingot',
  gold_ingots: name => name === 'gold_ingot',
  raw_iron: name => name === 'raw_iron' || name === 'iron_ore' || name === 'deepslate_iron_ore',
  diamonds: name => name === 'diamond',
  obsidian: name => name === 'obsidian',
  blaze_rods: name => name === 'blaze_rod',
  blaze_powder: name => name === 'blaze_powder',
  ender_pearls: name => name === 'ender_pearl',
  eyes_of_ender: name => name === 'ender_eye',
  beds: name => /_bed$/.test(name),
  // Cibo "sicuro": la stessa lista di priorità usata dall'adapter per `eat`.
  food: name => FOODS.includes(name),
  stone_tools: name => /^stone_(pickaxe|axe|shovel|sword|hoe)$/.test(name),
  iron_tools: name => /^iron_(pickaxe|axe|shovel|sword|hoe)$/.test(name),
  diamond_tools: name => /^diamond_(pickaxe|axe|shovel|sword|hoe)$/.test(name),
  picks: name => /_(pickaxe|axe|shovel|hoe)$/.test(name),
  swords: name => /_sword$/.test(name),
  axes: name => /_axe$/.test(name),
  swords_or_axes: name => /_(sword|axe)$/.test(name),
  armor: name => /_(helmet|chestplate|leggings|boots)$/.test(name),
};

export const ITEM_TAGS = Object.keys(TAG_PREDICATES).sort();

export function isKnownTag (tag) {
  return Object.hasOwn(TAG_PREDICATES, tag);
}

export function itemMatchesTag (item, tag) {
  const predicate = TAG_PREDICATES[tag];
  if (!predicate) throw new Error(`unknown item tag: ${tag}`);
  const name = String(item || '').replace(/^minecraft:/, '').toLowerCase();
  return predicate(name);
}

// Conteggio aggregato degli item in inventario che appartengono al tag.
export function tagCount (inventory = {}, tag) {
  let total = 0;
  for (const [name, count] of Object.entries(inventory)) {
    if ((count || 0) <= 0) continue;
    if (itemMatchesTag(name, tag)) total += count;
  }
  return total;
}

// Nomi degli item presenti che appartengono al tag (per evidence e descrizioni).
export function tagItems (inventory = {}, tag) {
  return Object.keys(inventory)
    .filter(name => (inventory[name] || 0) > 0 && itemMatchesTag(name, tag))
    .sort();
}
