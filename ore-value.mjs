// Ore value — the deterministic answer to "is this vein worth a detour?".
//
// Pure data + pure helpers, no I/O. Two consumers:
//   - world-events.mjs: whether an ore sighting deserves a VALUABLE_ORE_SEEN
//     event at all (`ORE_EVENT_MIN_VALUE`);
//   - opportunity-goals.mjs: the utility gate behind an OPPORTUNITY goal —
//     an absolute floor for a non-resource goal, and a *relative* rule
//     ("better than what you are already mining") for a mining goal.
//
// Harvestability is deliberately NOT here: whether the bot can actually take
// the drop depends on the Bedrock block data (`harvestTools`) and on the best
// pickaxe in the inventory, so it stays in the adapter (`_blockHarvestable`).
// Values are relative judgements, not prices: diamond 100, emerald 60,
// gold 40, lapis 30, redstone 25, iron 15, copper 8.

export const ORE_VALUES = Object.freeze({
  diamond_ore: { value: 100, drop: 'diamond' },
  deepslate_diamond_ore: { value: 100, drop: 'diamond' },
  emerald_ore: { value: 60, drop: 'emerald' },
  deepslate_emerald_ore: { value: 60, drop: 'emerald' },
  gold_ore: { value: 40, drop: 'raw_gold' },
  deepslate_gold_ore: { value: 40, drop: 'raw_gold' },
  lapis_ore: { value: 30, drop: 'lapis_lazuli' },
  deepslate_lapis_ore: { value: 30, drop: 'lapis_lazuli' },
  redstone_ore: { value: 25, drop: 'redstone' },
  deepslate_redstone_ore: { value: 25, drop: 'redstone' },
  iron_ore: { value: 15, drop: 'raw_iron' },
  deepslate_iron_ore: { value: 15, drop: 'raw_iron' },
  copper_ore: { value: 8, drop: 'raw_copper' },
  deepslate_copper_ore: { value: 8, drop: 'raw_copper' },
  // Coal is the cheapest entry but the one the early game misses most (torches,
  // fuel): it belongs in the table precisely because "scarce" ≠ "expensive".
  coal_ore: { value: 5, drop: 'coal' },
  deepslate_coal_ore: { value: 5, drop: 'coal' },
});

// Same scale, indexed by the *item* a plan target names (`{raw_iron: 4}`), so a
// mining goal can be compared with a sighting. Ingots sit at their ore's value;
// wood is the cheap baseline of the early game.
export const ITEM_VALUES = Object.freeze({
  diamond: 100,
  diamond_block: 900,
  emerald: 60,
  raw_gold: 40,
  gold_ingot: 40,
  lapis_lazuli: 30,
  redstone: 25,
  raw_iron: 15,
  iron_ingot: 15,
  raw_copper: 8,
  copper_ingot: 8,
  coal: 5,
  charcoal: 5,
});

export const WOOD_VALUE = 3;
// Any ore in the table is worth *reporting* (an event); the producer decides
// whether it is worth a detour. Coal/copper are cheap but scarce early, which is
// exactly why the event must not be filtered by value here.
export const ORE_EVENT_MIN_VALUE = 5;
// Only gold and above get the option-priority lift: a rich vein is worth taking
// even if the planner aimed elsewhere, while coal/iron stay ordinary mining
// unless a goal targets them.
export const ORE_OPTION_PRIORITY_MIN_VALUE = 40;
export const OPPORTUNITY_MIN_VALUE = 40;            // absolute floor for a goal that is not mining
// Coal: the cheapest ore in the table. "Better than the current target" with a
// small margin — copper(8) beats a coal target(5), coal(5) does not beat copper.
export const OPPORTUNITY_MIN_RELATIVE_VALUE = 5;
// Scarcity: once the backpack already holds this many of an ore's drop, the
// relative path stops firing (the ore is no longer scarce). The absolute path
// (gold and above) ignores it: a diamond is always worth taking.
export const OPPORTUNITY_STOCK_CAP = 16;
export const OPPORTUNITY_VALUE_MARGIN = 0;          // strict: the sighting must be worth *more*

export const VALUABLE_ORE_NAMES = Object.freeze(Object.keys(ORE_VALUES));

export function oreValue (name) {
  return ORE_VALUES[name]?.value ?? 0;
}

export function oreDrop (name) {
  return ORE_VALUES[name]?.drop ?? null;
}

export function isValuableOre (name) {
  return oreValue(name) > 0;
}

// Value of a *held/planned* item name: strict table, plus the wood baseline
// (`oak_log`, `birch_planks`, …) so "collect wood" is comparable with an ore.
export function itemValue (name) {
  if (!name) return 0;
  const known = ITEM_VALUES[name];
  if (known != null) return known;
  if (/(_log|_stem|_hyphae|_planks|_wood)$/.test(name)) return WOOD_VALUE;
  return 0;
}

// Best value among a plan's targets (`{dirt: 4, raw_iron: 2}` → 15).
export function bestTargetValue (targets = {}) {
  return Object.keys(targets ?? {}).reduce((best, name) => Math.max(best, itemValue(name)), 0);
}
