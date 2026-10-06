// Central, extensible matcher for storage-container block names.
//
// Why this module exists instead of a longer list: the adapter used to carry an
// exact-name whitelist (`['chest', 'trapped_chest', 'barrel', 'shulker_box']`),
// so every *dyed* shulker box (`white_shulker_box`, ...) was invisible to
// discovery — a fragile list, not a definition.
//
// Bedrock block names in this world model carry no tag or block-family field
// (the survey is an histogram of names, see `docs/wiki/exploration.md`), so the
// honest fix is not a bigger list but a *matcher with families* plus an explicit
// extension point: `isStorageBlock(name)` decides membership, and
// `addStorageBlockName` / `addStorageBlockFamily` extend it without editing the
// discovery code.
//
// Two distinct uses, deliberately kept apart:
//  - `isStorageBlock(name)` — "is this name a storage container?" (used on names
//    that come from the world: a census, a palette, a chat message);
//  - `storageBlockNames()` — the *concrete* names to scan for when the only API
//    available is `findBlocks(name, ...)`.

const DYE_COLORS = Object.freeze([
  'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black',
]);

// Exact names that are containers. `chest` is the undyed shulker's sibling, not a
// family; `barrel`/`chest`/`trapped_chest` have no variants in vanilla.
export const STORAGE_BASE_NAMES = Object.freeze(['chest', 'trapped_chest', 'barrel', 'shulker_box']);

// Families: a suffix match, so every dye colour is covered by construction
// instead of by enumeration.
export const STORAGE_FAMILIES = Object.freeze([
  Object.freeze({ id: 'shulker_box', suffix: '_shulker_box' }),
]);

// Concrete scan list: base + every dyed shulker box the family implies.
export const STORAGE_BLOCK_NAMES = Object.freeze([
  ...STORAGE_BASE_NAMES,
  ...DYE_COLORS.map((color) => `${color}_shulker_box`),
]);

// Extension points (never a silent global list: additive and reportable).
const extraNames = new Set();
const extraFamilies = [];

export function addStorageBlockName (name) {
  if (!name || typeof name !== 'string') return false;
  if (isStorageBlock(name)) return false;
  extraNames.add(name);
  return true;
}

export function addStorageBlockFamily ({ id, suffix } = {}) {
  if (!id || !suffix || typeof suffix !== 'string') return false;
  if (extraFamilies.some((f) => f.id === id)) return false;
  extraFamilies.push({ id, suffix });
  return true;
}

// Test-only: the extension points are process-global by design, so a test that
// registers a name must be able to unregister it without touching the lists.
export function resetStorageExtensions () {
  extraNames.clear();
  extraFamilies.length = 0;
}

export function storageFamilies () {
  return [...STORAGE_FAMILIES, ...extraFamilies].map((f) => ({ ...f }));
}

export function isStorageBlock (name) {
  if (!name || typeof name !== 'string') return false;
  const bare = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
  if (STORAGE_BASE_NAMES.includes(bare) || extraNames.has(bare)) return true;
  for (const family of storageFamilies()) if (bare.endsWith(family.suffix)) return true;
  return false;
}

// The concrete names a scan should ask for: the static list plus every added
// name. Families are *not* expanded here — they are matched, not enumerated —
// so a caller that can enumerate loaded names should prefer `isStorageBlock`.
export function storageBlockNames () {
  return [...new Set([...STORAGE_BLOCK_NAMES, ...extraNames])];
}

// Which family a name belongs to (`null` for a base name, the family id for a
// suffix match): used by the register to stay readable when reporting coverage.
export function storageFamilyOf (name) {
  if (!name || typeof name !== 'string') return null;
  const bare = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
  for (const family of storageFamilies()) if (bare.endsWith(family.suffix)) return family.id;
  return null;
}
