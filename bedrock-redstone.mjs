// Consapevolezza redstone (R0): classificazione e lettura di stato dei
// componenti, senza I/O. Come gli altri moduli puri (bedrock-fluids,
// bedrock-fishing) il vocabolario è chiuso e ogni valore ignoto resta `null`
// invece di essere indovinato: un componente di cui non si legge lo stato non
// deve mai sembrare "spento".
//
// Perché serve: `DIG_PROTECTED` non copriva la redstone (una torcia/repeater
// poteva finire sotto `dig_down`) e la percezione non vedeva né i minerali di
// redstone né i componenti, quindi il bot era cieco su un'intera classe di
// blocchi funzionali — quelli che una base non vuole vedersi scavare.

// Minerale di redstone: le varianti `lit_*` sono blocchi distinti in Bedrock,
// non uno stato dello stesso blocco.
export const REDSTONE_ORES = [
  'redstone_ore',
  'deepslate_redstone_ore',
  'lit_redstone_ore',
  'lit_deepslate_redstone_ore',
];

// Componenti e blocchi funzionali della redstone (nomi Bedrock, senza namespace).
export const REDSTONE_COMPONENTS = new Set([
  'redstone_wire',
  'redstone_torch',
  'unlit_redstone_torch',
  'redstone_block',
  'redstone_lamp',
  'lit_redstone_lamp',
  'repeater',
  'unpowered_repeater',
  'powered_repeater',
  'comparator',
  'unpowered_comparator',
  'powered_comparator',
  'observer',
  'piston',
  'sticky_piston',
  'piston_arm_collision',
  'sticky_piston_arm_collision',
  'dispenser',
  'dropper',
  'hopper',
  'lever',
  'stone_button',
  'wooden_button',
  'polished_blackstone_button',
  'stone_pressure_plate',
  'light_weighted_pressure_plate',
  'heavy_weighted_pressure_plate',
  'wooden_pressure_plate',
  'polished_blackstone_pressure_plate',
  'daylight_detector',
  'daylight_detector_inverted',
  'tripwire_hook',
  'target',
  'sculk_sensor',
  'calibrated_sculk_sensor',
  'crafter',
  'redstone_ore',
  'deepslate_redstone_ore',
  'lit_redstone_ore',
  'lit_deepslate_redstone_ore',
]);

// Sorgenti: quello che *genera* segnale (leva, pulsante, piastra, torcia,
// blocco, osservatore, sensore, tripwire). Gli output sono ciò che il segnale
// aziona: la verifica di un circuito si fa sull'output, non sul filo.
export const REDSTONE_SOURCES = new Set([
  'redstone_torch',
  'redstone_block',
  'lever',
  'stone_button',
  'wooden_button',
  'polished_blackstone_button',
  'stone_pressure_plate',
  'light_weighted_pressure_plate',
  'heavy_weighted_pressure_plate',
  'wooden_pressure_plate',
  'polished_blackstone_pressure_plate',
  'daylight_detector',
  'daylight_detector_inverted',
  'tripwire_hook',
  'observer',
  'target',
  'sculk_sensor',
  'calibrated_sculk_sensor',
]);

export const REDSTONE_OUTPUTS = new Set([
  'redstone_lamp',
  'lit_redstone_lamp',
  'piston',
  'sticky_piston',
  'dispenser',
  'dropper',
  'hopper',
  'crafter',
  'door',
  'iron_door',
  'iron_trapdoor',
  'tnt',
]);

// Pericoli assoluti: la TNT non si piazza e non si aziona mai (l'esplosione
// distrugge i drop e quello che c'è intorno).
export const REDSTONE_HAZARDS = new Set(['tnt']);

export const REDSTONE_SCAN_RADIUS = 16;
export const REDSTONE_SCAN_LIMIT = 24;

export function normalizeName (name) {
  return String(name ?? '').replace(/^minecraft:/i, '').toLowerCase();
}

export function isRedstoneOre (name) {
  return REDSTONE_ORES.includes(normalizeName(name));
}

export function isRedstoneComponent (name) {
  return REDSTONE_COMPONENTS.has(normalizeName(name));
}

export function isHazard (block) {
  const name = normalizeName(block?.name);
  return REDSTONE_HAZARDS.has(name) || blockProperties(block)?.explode_bit === true;
}

// Accessore tollerante: un blocco pris marine ha `getProperties()`, ma una copia
// spalmata conserva solo `_properties` e alcuni path usano `states`.
export function blockProperties (block) {
  if (typeof block?.getProperties === 'function') {
    try {
      const props = block.getProperties();
      if (props && typeof props === 'object') return props;
    } catch { /* fall through */ }
  }
  const base = block?.properties || block?._properties || block?.states;
  const computed = block?.computedStates;
  if (!base && !computed) return null;
  return { ...(base || {}), ...(computed || {}) };
}

function boolSignal (value) {
  if (value === true) return 15;
  if (value === false) return 0;
  return null;
}

function numericSignal (value) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(15, Math.round(number)));
}

// Livello di potenza 0..15 di un componente, o `null` se lo stato non è
// leggibile. I nomi `lit_*`/`powered_*` sono blocchi distinti e valgono 15.
export function powerOf (block) {
  if (!block || typeof block !== 'object') return null;
  const name = normalizeName(block.name);
  if (!name) return null;
  if (name.startsWith('lit_') || name.startsWith('powered_')) return 15;
  if (name === 'unpowered_repeater' || name === 'unpowered_comparator' || name === 'unlit_redstone_torch') return 0;

  const props = blockProperties(block) || {};
  if (Object.hasOwn(props, 'redstone_signal')) return numericSignal(props.redstone_signal);
  if (name === 'lever') return boolSignal(props.open_bit);
  if (name.endsWith('_button')) return boolSignal(props.button_pressed_bit ?? props.open_bit);
  if (name === 'observer' || name === 'tripwire_hook') return boolSignal(props.powered_bit);
  if (name === 'dispenser' || name === 'dropper') return boolSignal(props.triggered_bit);
  if (name.startsWith('sculk_sensor') || name.startsWith('calibrated_sculk_sensor')) {
    const phase = props.sculk_sensor_phase;
    if (phase === true || phase === 1 || phase === 'active') return 15;
    if (phase === false || phase === 0 || phase === 'inactive' || phase === 'cooldown') return 0;
    return null;
  }
  if (name === 'hopper') return props.toggle_bit === true || props.toggle_bit === false ? 0 : null;
  if (Object.hasOwn(props, 'powered_bit')) return boolSignal(props.powered_bit);
  return null;
}

export function isPowered (block) {
  const power = powerOf(block);
  return power != null && power > 0;
}

// Direzione del componente (per il piazzamento orientato di R1 e per leggere lo
// stato di un circuito): il nome della proprietà cambia per famiglia di blocco.
const FACING_KEYS = ['facing_direction', 'cardinal_direction', 'direction', 'lever_direction', 'minecraft:cardinal_direction', 'minecraft:facing_direction', 'orientation'];

export function facingOf (block) {
  const props = blockProperties(block);
  if (!props) return null;
  for (const key of FACING_KEYS) {
    if (props[key] != null) return props[key];
  }
  return null;
}

export function isSource (block) {
  return REDSTONE_SOURCES.has(normalizeName(block?.name));
}

export function isOutput (block) {
  return REDSTONE_OUTPUTS.has(normalizeName(block?.name));
}

// Righe compatte per l'osservazione: nome, posizione, distanza, potenza e
// direzione. `properties` resta il dizionario grezzo per la diagnostica.
export function componentState (block, { from = null } = {}) {
  if (!block) return null;
  const position = block.position ? { x: block.position.x, y: block.position.y, z: block.position.z } : null;
  const distance = from && position
    ? +Math.hypot(position.x - from.x, position.y - from.y, position.z - from.z).toFixed(1)
    : (typeof block.distance === 'number' ? +block.distance.toFixed(1) : null);
  return {
    name: normalizeName(block.name),
    position,
    distance,
    power: powerOf(block),
    facing: facingOf(block),
    properties: blockProperties(block),
  };
}

function sortByDistance (rows) {
  return rows.sort((a, b) => ((a.distance ?? Infinity) - (b.distance ?? Infinity)) || a.name.localeCompare(b.name));
}

// Vista compatta dei blocchi redstone attorno a un punto: componenti, minerali,
// livelli di potenza letti e TNT. Le celle che non sono redstone sono ignorate,
// così il chiamante può passare una lista già filtrata o mista.
export function redstoneView (blocks = [], { from = null, limit = REDSTONE_SCAN_LIMIT } = {}) {
  const components = [];
  const ore = [];
  const power = [];
  const hazards = [];
  for (const block of blocks) {
    if (!block?.name) continue;
    const name = normalizeName(block.name);
    if (REDSTONE_HAZARDS.has(name)) {
      hazards.push(componentState(block, { from }));
      continue;
    }
    if (isRedstoneOre(name)) {
      ore.push(componentState(block, { from }));
      continue;
    }
    if (!REDSTONE_COMPONENTS.has(name)) continue;
    const state = componentState(block, { from });
    components.push(state);
    if (state.power != null) power.push({ name: state.name, position: state.position, distance: state.distance, signal: state.power });
  }
  sortByDistance(components);
  sortByDistance(ore);
  sortByDistance(power);
  sortByDistance(hazards);
  return {
    components: components.slice(0, limit),
    ore: ore.slice(0, limit),
    power: power.slice(0, limit),
    hazards: hazards.slice(0, limit),
    tntNearby: hazards.length > 0,
    counts: { components: components.length, ore: ore.length, hazards: hazards.length },
  };
}
