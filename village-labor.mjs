// Village labor — deterministic "earn your keep" chores for the IDLE state.
//
// The bot is not furniture: while it has no goal it looks for honest work in
// the village — harvest and sow the plots, shear the sheep, milk the cows,
// breed the animals, keep the bees, fish, cut wood, gather stone and ore, and
// put the produce into the chest.
//
// Design mirrors idle-goals.mjs: a pure module (no I/O, no clock except the
// caller-supplied `now`), deterministic, never an LLM. The controller enqueues
// the best chore as an AUTONOMOUS goal and `isChoreResolved` is that goal's
// success criterion, checked against harness state every step.
//
// Two rules keep this honest:
//   - a chore only asks for work the harness already offers. `offered` (the
//     keys of GET /options) is the authority: a chore whose driving intent is
//     not currently valid is never created, so the bot cannot "decide" to mine
//     a vein it cannot reach or shear a sheep it cannot find.
//   - success is a *state delta* (items gained, seeds spent, a calf born),
//     never the model's opinion and never an absolute inventory count.

import { animalFeed, cropForSeed } from './bedrock-survival.mjs';
import { GOAL_SOURCE, SOURCE_PRIORITY } from './goal-manager.mjs';

export const DEFAULT_VILLAGE_COOLDOWN_MS = 120000;
export const DEFAULT_VILLAGE_MAX_CHORES = 12;
export const DEFAULT_STORE_THRESHOLD = 8;

// What a ripe crop block actually leaves in the backpack.
const CROP_DROPS = Object.freeze({
  wheat: 'wheat',
  carrots: 'carrot',
  potatoes: 'potato',
  beetroot: 'beetroot',
  melon_stem: 'melon_slice',
  pumpkin_stem: 'pumpkin',
  sweet_berry_bush: 'sweet_berries',
  nether_wart: 'nether_wart',
});

const ORE_DROPS = Object.freeze({
  coal_ore: 'coal',
  deepslate_coal_ore: 'coal',
  iron_ore: 'raw_iron',
  deepslate_iron_ore: 'raw_iron',
  copper_ore: 'raw_copper',
  deepslate_copper_ore: 'raw_copper',
  gold_ore: 'raw_gold',
  deepslate_gold_ore: 'raw_gold',
  redstone_ore: 'redstone',
  deepslate_redstone_ore: 'redstone',
  lapis_ore: 'lapis_lazuli',
  deepslate_lapis_ore: 'lapis_lazuli',
  diamond_ore: 'diamond',
  deepslate_diamond_ore: 'diamond',
  emerald_ore: 'emerald',
  deepslate_emerald_ore: 'emerald',
});

const ORE_DROP_ITEMS = [...new Set(Object.values(ORE_DROPS))];
const CROP_DROP_ITEMS = [...new Set(Object.values(CROP_DROPS))];

// Item families: the backpack does not say which colour a wool is, and a chore
// should not care either.
const FAMILY = Object.freeze({
  wool: /(^|_)wool$/,
  log: /(_log|_stem|bamboo_block)$/,
  stone: /^(stone|cobblestone|deepslate|andesite|diorite|granite|tuff|blackstone|basalt)$/,
  fish: /^(cod|salmon|tropical_fish|pufferfish)$/,
  crop: /^(wheat|carrot|potato|beetroot|sweet_berries|melon_slice|pumpkin|nether_wart)$/,
  ore: /^(coal|raw_iron|raw_copper|raw_gold|redstone|lapis_lazuli|diamond|emerald)$/,
});

// Chores, best-effort ordered by utility. `detect` returns how many chances are
// visible right now (0 = nothing to do); `gain` lists what success looks like;
// `spend` is the inverse (the chore consumes an item instead of producing one);
// `babies` marks a chore verified by a new baby animal instead of items.
export const VILLAGE_CHORES = Object.freeze([
  {
    id: 'harvest_crops',
    objective: 'Harvest the ripe crops in the village plots and replant them, then put the produce away.',
    intents: [/^harvest_/],
    utility: 70,
    goal: 2,
    detect: obs => readyCrops(obs).length,
    // The drop list is fixed, not read from the current census: once the crop is
    // harvested it is no longer visible, and the delta must still be measurable.
    gain: () => CROP_DROP_ITEMS.map(item => ({ item })),
    reason: obs => `${readyCrops(obs).length} ripe crop(s)`,
  },
  {
    id: 'store_harvest',
    objective: 'Put the gathered village produce into the nearby chest so it is not lost on death.',
    intents: [/^deposit_/],
    utility: 65,
    detect: (obs, ctx) => (storableStack(obs, ctx.storeThreshold, ctx.offered) ? 1 : 0),
    spend: (obs, ctx) => storableStack(obs, ctx.storeThreshold, ctx.offered),
    reason: (obs, ctx) => `holding ${storableStack(obs, ctx.storeThreshold, ctx.offered)?.count ?? 0} to store`,
  },
  {
    id: 'shear_sheep',
    objective: 'Shear the village sheep for wool and bring the wool back.',
    intents: [/^shear_sheep$/],
    utility: 60,
    goal: 1,
    detect: obs => (inv(obs).shears || 0) > 0
      ? animalRows(obs).filter(a => !a.baby && !a.sheared && /sheep/.test(String(a.type))).length
      : 0,
    gain: () => [{ family: 'wool' }],
    reason: () => 'an unsheared sheep is close',
  },
  {
    id: 'milk_cows',
    objective: 'Milk the village cows into empty buckets and bring the milk back.',
    intents: [/^milk_/],
    utility: 58,
    goal: 1,
    detect: obs => (inv(obs).bucket || 0) > 0
      ? animalRows(obs).filter(a => !a.baby && /(^|_)(cow|mooshroom)$/.test(String(a.type))).length
      : 0,
    gain: () => [{ item: 'milk_bucket' }],
    reason: () => 'a cow and a bucket',
  },
  {
    id: 'collect_honey',
    objective: 'Harvest honey from the village hives with the shears or the empty bottles.',
    intents: [/^harvest_honey/],
    utility: 56,
    goal: 1,
    detect: obs => fullHives(obs).length,
    gain: () => [{ item: 'honeycomb' }, { item: 'honey_bottle' }],
    reason: obs => `${fullHives(obs).length} full hive(s)`,
  },
  {
    id: 'tend_animals',
    objective: 'Feed two adult village animals so they breed — the herd should grow.',
    intents: [/^(feed|breed)_/],
    utility: 54,
    babies: true,
    detect: obs => breedingPairs(obs).length,
    reason: obs => `${breedingPairs(obs).length} pair(s) ready to breed`,
  },
  {
    id: 'plant_crops',
    objective: 'Sow the seeds in the empty village farmland so the next harvest is already growing.',
    intents: [/^plant_/],
    utility: 52,
    detect: (obs, ctx) => (offeredMatches(ctx.offered, [/^plant_/]) ? plantableSeeds(obs).length : 0),
    spend: obs => {
      const seed = plantableSeeds(obs)[0];
      return seed ? { item: seed, count: 1 } : null;
    },
    reason: obs => `sowing ${plantableSeeds(obs)[0] ?? 'nothing'}`,
  },
  {
    id: 'go_fishing',
    objective: 'Fish from the nearby shore and bring the catch back to the village.',
    intents: [/^fish$/, /^cast_rod$/, /^reel_in$/],
    utility: 50,
    goal: 2,
    detect: obs => {
      const fishing = obs.fishing;
      if (!fishing?.available && !fishing?.bobberOut) return 0;
      return fishing.rod || fishing.bobberOut ? 1 : 0;
    },
    gain: () => [{ family: 'fish' }],
    reason: () => 'water and a fishing rod',
  },
  {
    id: 'chop_wood',
    objective: 'Cut the logs the village needs for building and crafting.',
    intents: [/^mine_/],
    utility: 46,
    goal: 4,
    detect: obs => nearbyMatching(obs, FAMILY.log),
    gain: () => [{ family: 'log' }],
    reason: obs => `${nearbyMatching(obs, FAMILY.log)} log(s) nearby`,
  },
  {
    id: 'gather_stone',
    objective: 'Gather stone for the village builds, from what is already exposed.',
    intents: [/^mine_/],
    utility: 42,
    goal: 4,
    detect: obs => nearbyMatching(obs, FAMILY.stone),
    gain: () => [{ family: 'stone' }],
    reason: obs => `${nearbyMatching(obs, FAMILY.stone)} stone block(s) nearby`,
  },
  {
    id: 'mine_ore',
    objective: 'Mine the ore the village can see and bring it back for tools.',
    intents: [/^mine_/],
    utility: 40,
    goal: 2,
    detect: obs => nearbyOre(obs).length,
    gain: () => ORE_DROP_ITEMS.map(item => ({ item })),
    reason: obs => `${nearbyOre(obs).length} ore block(s) nearby`,
  },
]);

// ---- observation helpers (pure) ---------------------------------------------------------------

const inv = observation => observation?.inventory || {};
const animalRows = observation => observation?.farmAnimals || [];

function readyCrops (observation) {
  const rows = [];
  for (const [name, cells] of Object.entries(observation?.nearby || {})) {
    if (!CROP_DROPS[name]) continue;
    for (const cell of cells || []) if (cell?.mature === true) rows.push(name);
  }
  return rows;
}

function nearbyMatching (observation, family) {
  let count = 0;
  for (const [name, cells] of Object.entries(observation?.nearby || {})) {
    if (!family.test(String(name))) continue;
    count += (cells || []).length;
  }
  return count;
}

function nearbyOre (observation) {
  const names = [];
  for (const [name, cells] of Object.entries(observation?.nearby || {})) {
    if (ORE_DROPS[name] && (cells || []).length) names.push(name);
  }
  return names;
}

// A hive is worth a trip only when it is full and the bot has the tool for
// either product (`_beesView` reports the honey level as 0..5).
function fullHives (observation) {
  const light = inv(observation);
  if (!(light.shears || light.glass_bottle)) return [];
  return (observation?.bees?.hives || []).filter(hive => (hive?.honeyLevel ?? 0) > 0);
}

function plantableSeeds (observation) {
  const inventory = inv(observation);
  return Object.keys(inventory).filter(item => inventory[item] > 0 && cropForSeed(item));
}

// Two adults of the same species, and enough feed in the backpack to love both.
function breedingPairs (observation) {
  const inventory = inv(observation);
  const byType = new Map();
  for (const animal of animalRows(observation)) {
    if (animal.baby) continue;
    const type = String(animal.type).replace(/^minecraft:/, '');
    byType.set(type, (byType.get(type) || 0) + 1);
  }
  const pairs = [];
  for (const [type, adults] of byType) {
    if (adults < 2) continue;
    const feed = animalFeed(type);
    if (!feed || (inventory[feed] || 0) < 2) continue;
    pairs.push({ type, adults, feed });
  }
  return pairs;
}

// The biggest village resource in the backpack, when it is worth a trip. When
// the harness option list is known, only an item it currently offers to deposit
// counts: storing is work only if the chest is reachable.
function storableStack (observation, threshold = DEFAULT_STORE_THRESHOLD, offered = null) {
  const inventory = inv(observation);
  const names = Object.keys(inventory)
    .filter(name => FAMILY.crop.test(name) || FAMILY.wool.test(name) || FAMILY.log.test(name) ||
      FAMILY.ore.test(name) || FAMILY.fish.test(name) || name === 'milk_bucket' || name === 'honeycomb' || name === 'honey_bottle')
    .filter(name => !offered || offeredHas(offered, `deposit_${name}`))
    .sort((a, b) => (inventory[b] || 0) - (inventory[a] || 0));
  const top = names[0];
  return top && inventory[top] >= threshold ? { item: top, count: threshold } : null;
}

// Did the harness offer this exact option key?
export function offeredHas (offered, key) {
  if (!offered) return false;
  return offered instanceof Set ? offered.has(key) : offered.includes(key);
}

// Did any offered option key match one of the patterns?
export function offeredMatches (offered, patterns) {
  if (!offered) return false;
  const keys = offered instanceof Set ? [...offered] : offered;
  return keys.some(key => patterns.some(pattern => pattern.test(key)));
}

// ---- counting and scoring ---------------------------------------------------------------------

// How many of the chore's drops did the bot gain since `before` was taken?
export function choreGain (chore, observation, before = null) {
  const inventory = inv(observation);
  const start = before?.inventory || {};
  return (chore.gain ? chore.gain(observation) : []).reduce((sum, drop) => {
    if (drop.family) {
      const family = FAMILY[drop.family];
      const names = new Set([...Object.keys(inventory), ...Object.keys(start)]);
      for (const name of names) if (family.test(name)) sum += (inventory[name] || 0) - (start[name] || 0);
      return sum;
    }
    return sum + (inventory[drop.item] || 0) - (start[drop.item] || 0);
  }, 0);
}

export function babyCount (observation) {
  return animalRows(observation).filter(animal => animal.baby).length;
}

// Snapshot taken when the goal is created: success is measured against it, so an
// absolute inventory count is never mistaken for progress.
export function villageSnapshot (observation, { spend = null } = {}) {
  return { inventory: { ...inv(observation) }, babies: babyCount(observation), spend: spend ? { ...spend } : null, at: Date.now() };
}

// Candidate chores for the current observation, best first. `offered` is the
// list of option keys the harness is currently offering (a Set or an array).
export function deriveVillageChores (observation = {}, {
  offered = null,
  storeThreshold = DEFAULT_STORE_THRESHOLD,
} = {}) {
  const ctx = { offered, storeThreshold };
  const candidates = [];
  for (const chore of VILLAGE_CHORES) {
    if (!chore.detect) continue;
    const count = chore.detect(observation, ctx) || 0;
    if (count <= 0) continue;
    // The harness is the only arbiter of what is valid: a chore whose driving
    // intent is not offered right now is not work, it is a wish.
    if (offered && !offeredMatches(offered, chore.intents)) continue;
    candidates.push({
      id: chore.id,
      objective: chore.objective,
      priority: SOURCE_PRIORITY[GOAL_SOURCE.AUTONOMOUS],
      utility: chore.utility + Math.min(count, 5) * 2,
      count,
      gain: chore.gain ? chore.gain(observation) : null,
      spend: chore.spend ? chore.spend(observation, ctx) : null,
      babies: !!chore.babies,
      reason: chore.reason ? chore.reason(observation, ctx) : `${count}`,
    });
  }
  candidates.sort((a, b) => b.utility - a.utility);
  return candidates;
}

// The next chore to enqueue, skipping a chore attempted within the cooldown
// (anti-loop: a chore that just failed must not be retried forever).
export function nextVillageChore (observation, {
  offered = null,
  storeThreshold = DEFAULT_STORE_THRESHOLD,
  attempts = new Map(),
  cooldownMs = DEFAULT_VILLAGE_COOLDOWN_MS,
  now = Date.now(),
  allow = () => true,
} = {}) {
  for (const candidate of deriveVillageChores(observation, { offered, storeThreshold })) {
    if (!allow(candidate)) continue;
    const last = attempts.get(candidate.id);
    if (last != null && now - last < cooldownMs) continue;
    return candidate;
  }
  return null;
}

// Deterministic success predicate for a chore, measured against the snapshot
// taken when the goal started. Unknown ids are never a success: a goal whose
// verifier is missing runs out its budget instead of closing on nothing.
export function isChoreResolved (choreId, observation = {}, { before = null } = {}) {
  const chore = VILLAGE_CHORES.find(entry => entry.id === choreId);
  if (!chore) return false;
  if (chore.babies) {
    if (!before) return false;
    return babyCount(observation) - (before.babies ?? babyCount(observation)) >= 1;
  }
  if (chore.spend) {
    // `before.spend` is the target chosen when the goal was created: recomputing
    // it now could pick a different stack (or none) and never resolve.
    const wanted = before?.spend;
    if (!wanted) return false;
    const inventory = inv(observation);
    const start = before?.inventory?.[wanted.item] ?? inventory[wanted.item] ?? 0;
    return start - (inventory[wanted.item] || 0) >= wanted.count;
  }
  return choreGain(chore, observation, before) >= (chore.goal ?? 1);
}
