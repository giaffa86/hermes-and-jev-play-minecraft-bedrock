// Circuiti redstone primitivi dichiarativi (R3 di docs/wiki/redstone.md).
//
// Un blueprint sotto circuits/ descrive *cosa* costruire — materiali, celle
// relative a un'ancora, direzione dei componenti — e *cosa* verificare dopo
// aver azionato il trigger. Qui vive la parte pura: validazione dei blueprint
// (un file rotto deve fallire all'avvio, come per le gameplay skill), rotazione
// delle celle rispetto alla direzione scelta, piano ordinato (cosa piazzare,
// con quale supporto, in quale ordine) e confronto delle proprietà attese con
// quello che il mondo riporta. Nessuna I/O di rete e nessun accesso al server:
// la costruzione è compito dell'adapter, che consuma il piano.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isRedstoneComponent, normalizeFacing } from './bedrock-redstone.mjs';

export const CIRCUIT_SCHEMA_VERSION = 1;
export const CIRCUIT_FACINGS = ['south', 'north', 'east', 'west'];
export const CIRCUIT_ID_RE = /^[a-z][a-z0-9_]*$/;
export const BLOCK_NAME_RE = /^[a-z][a-z0-9_]*$/;
export const MAX_CIRCUIT_STEPS = 48;
export const MAX_REPEATER_DELAY = 3;

// Un oggetto del blueprint non sempre si piazza come un blocco con lo stesso
// nome (il repeater diventa `unpowered_repeater`, il comparatore
// `unpowered_comparator`): la differenza sta qui, non nei blueprint.
export const PLACED_AS = { repeater: 'unpowered_repeater', comparator: 'unpowered_comparator' };

export function placedAs (item) {
  return PLACED_AS[item] ?? item;
}

// Il blueprint è scritto con +z "in avanti": `facing` dice dove punta quel +z
// nel mondo (e quindi anche la destra del blueprint, perché la rotazione è
// rigida). `east`/`west` sono le rotazioni di 90°, non specchi.
const ROTATIONS = {
  south: ([x, y, z]) => [x, y, z],
  north: ([x, y, z]) => [-x, y, -z],
  east: ([x, y, z]) => [z, y, x],
  west: ([x, y, z]) => [-z, y, -x],
};

export const FORWARD = {
  south: { x: 0, z: 1 },
  north: { x: 0, z: -1 },
  east: { x: 1, z: 0 },
  west: { x: -1, z: 0 },
};

export function rotateOffset (offset, facing = 'south') {
  const rot = ROTATIONS[facing];
  if (!rot || !Array.isArray(offset)) return null;
  return rot(offset);
}

export function addOffset (origin, offset, facing = 'south') {
  const [dx, dy, dz] = rotateOffset(offset, facing) ?? [NaN, NaN, NaN];
  return { x: Math.round(origin.x + dx), y: Math.round(origin.y + dy), z: Math.round(origin.z + dz) };
}

// Cella del terreno + passo in avanti: dove inizia il cantiere rispetto al bot.
// Il piano del blueprint (y = 0) è alla quota dei piedi, quindi un blocco di
// supporto è sempre la cella sotto.
export function circuitAnchor (feet, facing = 'south') {
  const base = { x: Math.floor(feet?.x ?? 0), y: Math.floor(feet?.y ?? 0), z: Math.floor(feet?.z ?? 0) };
  const fwd = FORWARD[facing] ?? FORWARD.south;
  return { x: base.x + fwd.x, y: base.y, z: base.z + fwd.z };
}

function isOffset (value) {
  return Array.isArray(value) && value.length === 3 && value.every(n => Number.isInteger(n));
}

function cellKey (cell) {
  return `${cell.x},${cell.y},${cell.z}`;
}

// I blocchi che una blueprint non può chiedere: un circuito con TNT o trappole
// non è "pericoloso da costruire", è un circuito che non si costruisce.
const DANGEROUS_ITEMS = new Set(['tnt', 'trapped_chest', 'tripwire_hook', 'tripwire', 'sculk_shrieker', 'respawn_anchor']);

// R6 — limiti e sicurezza. Gli stessi blocchi non si *piazzano* mai, nemmeno con
// `place_<item>`: un blueprint con una trappola è un errore di progetto, un bot
// che piazza TNT per sbaglio è un incidente. I blocchi di comando non esistono
// nemmeno in inventario (`allow-cheats=false` sulla base), ma il divieto è
// esplicito: non si costruiscono, non si rompono, non si azionano.
export const FORBIDDEN_BLOCKS = new Set([
  'tnt', 'trapped_chest', 'tripwire_hook', 'tripwire', 'sculk_shrieker', 'respawn_anchor', 'end_crystal',
  'command_block', 'chain_command_block', 'repeating_command_block', 'structure_block', 'structure_void',
  'jigsaw', 'barrier', 'light_block', 'bedrock', 'fire', 'soul_fire', 'lava',
]);

const FORBIDDEN_PARTS = new Set([...FORBIDDEN_BLOCKS].map(name => name.replace(/^(chain_|repeating_)/, '')));

// Il nome può arrivare da un oggetto in inventario (`tnt`) o da una cella del
// mondo (`minecraft:tnt`, `lit_tnt`): la normalizzazione è qui, così l'adapter
// non duplica la regola.
export function forbiddenBlock (name) {
  const key = String(name ?? '').replace(/^minecraft:/i, '').toLowerCase();
  if (!key) return null;
  if (FORBIDDEN_BLOCKS.has(key) || FORBIDDEN_PARTS.has(key)) return key;
  return null;
}

// Limite di dimensione del cantiere. `MAX_CIRCUIT_STEPS` limita i passi,
// `MAX_CIRCUIT_COMPONENTS` limita i componenti che *lavorano* (repeater,
// comparator, observer, pistoni, dispenser, hopper): una parete di pietra non è
// un circuito, una fila di 40 repeater è lag. Leva e lampada non contano.
export const MAX_CIRCUIT_COMPONENTS = 24;
const LAG_COMPONENTS = new Set([
  'repeater', 'unpowered_repeater', 'powered_repeater', 'comparator', 'unpowered_comparator', 'powered_comparator',
  'observer', 'piston', 'sticky_piston', 'dispenser', 'dropper', 'hopper', 'crafter',
]);

export function lagComponent (name) {
  const key = String(name ?? '').replace(/^minecraft:/i, '').toLowerCase();
  return LAG_COMPONENTS.has(key) ? key : null;
}

// Un clock dichiarato non può essere più veloce di così: un repeater a 1 tick
// satura il BDS ("lag" nella spec di R6). Otto tick = 400 ms.
export const MIN_CLOCK_TICKS = 8;

// Il bot non deve sostare nel percorso di un pistone, nemmeno per il test.
export const PISTON_SAFETY_DISTANCE = 3;
const PISTON_BLOCKS = new Set(['piston', 'sticky_piston', 'piston_arm_collision', 'sticky_piston_arm_collision']);

// ---------------------------------------------------------------- validazione

export function validateCircuit (def, where = 'circuit') {
  const errors = [];
  if (!def || typeof def !== 'object' || Array.isArray(def)) return [`${where}: not an object`];
  if (def.schemaVersion != null && def.schemaVersion !== CIRCUIT_SCHEMA_VERSION) {
    errors.push(`${where}: unsupported schemaVersion ${def.schemaVersion}`);
  }
  if (typeof def.id !== 'string' || !CIRCUIT_ID_RE.test(def.id)) errors.push(`${where}: missing or invalid id`);
  if (typeof def.description !== 'string' || !def.description.trim()) errors.push(`${where}: missing description`);
  if (def.anchor != null) {
    const anchor = def.anchor;
    if (typeof anchor !== 'object' || Array.isArray(anchor)) errors.push(`${where}.anchor: not an object`);
    else {
      if (anchor.offset != null && !isOffset(anchor.offset)) errors.push(`${where}.anchor.offset: must be [x, y, z] integers`);
      if (anchor.minClear != null && (!Number.isInteger(anchor.minClear) || anchor.minClear < 0)) {
        errors.push(`${where}.anchor.minClear: must be a non-negative integer`);
      }
    }
  }
  if (def.dependsOn != null && (!Array.isArray(def.dependsOn) || def.dependsOn.some(d => typeof d !== 'string'))) {
    errors.push(`${where}.dependsOn: must be an array of strings`);
  }
  if (def.buildable != null && typeof def.buildable !== 'boolean') errors.push(`${where}.buildable: must be a boolean`);

  const need = {};
  if (!def.requires || typeof def.requires !== 'object' || Array.isArray(def.requires)) {
    errors.push(`${where}: missing requires`);
  } else {
    for (const [item, qty] of Object.entries(def.requires)) {
      if (!BLOCK_NAME_RE.test(item)) errors.push(`${where}.requires.${item}: invalid item name`);
      if (!Number.isInteger(qty) || qty < 1) errors.push(`${where}.requires.${item}: must be a positive integer`);
      else need[item] = qty;
    }
  }

  const steps = def.steps;
  const cells = new Map();
  const used = {};
  if (!Array.isArray(steps) || steps.length === 0) {
    errors.push(`${where}: steps must be a non-empty array`);
  } else if (steps.length > MAX_CIRCUIT_STEPS) {
    errors.push(`${where}: too many steps (${steps.length} > ${MAX_CIRCUIT_STEPS})`);
  } else {
    steps.forEach((step, i) => {
      const at = `${where}.steps[${i}]`;
      if (!step || typeof step !== 'object' || Array.isArray(step)) { errors.push(`${at}: not an object`); return; }
      if (typeof step.item !== 'string' || !BLOCK_NAME_RE.test(step.item)) { errors.push(`${at}: missing item`); return; }
      if (step.block != null && (typeof step.block !== 'string' || !BLOCK_NAME_RE.test(step.block))) errors.push(`${at}: invalid block`);
      if (!isOffset(step.offset)) { errors.push(`${at}: offset must be [x, y, z] integers`); return; }
      if (step.supportOffset != null && !isOffset(step.supportOffset)) errors.push(`${at}: supportOffset must be [x, y, z] integers`);
      if (step.face != null && (!Number.isInteger(step.face) || step.face < 0 || step.face > 5)) errors.push(`${at}: face must be 0..5`);
      if (step.facing != null && normalizeFacing(step.facing) == null) errors.push(`${at}: unknown facing "${step.facing}"`);
      if (step.label != null && typeof step.label !== 'string') errors.push(`${at}: label must be a string`);
      if (DANGEROUS_ITEMS.has(step.item)) errors.push(`${at}: dangerous item "${step.item}" (a circuit with traps is never built)`);
      const forbidden = forbiddenBlock(step.item) ?? forbiddenBlock(step.block);
      if (forbidden && !DANGEROUS_ITEMS.has(step.item)) errors.push(`${at}: forbidden block "${forbidden}" (R6: no traps, no command blocks, no lava)`);
      const key = step.offset.join(',');
      if (cells.has(key)) errors.push(`${at}: duplicate cell [${step.offset.join(',')}]`);
      else cells.set(key, i);
      used[step.item] = (used[step.item] ?? 0) + 1;
    });
  }

  // Ordine: il supporto di un passo deve essere il terreno o un blocco piazzato
  // *prima*. Un supporto che arriva dopo è un piano impossibile, non un dettaglio.
  if (Array.isArray(steps)) {
    steps.forEach((step, i) => {
      if (!step || !isOffset(step.offset)) return;
      const support = isOffset(step.supportOffset)
        ? step.supportOffset
        : [step.offset[0], step.offset[1] - 1, step.offset[2]];
      const owner = cells.get(support.join(','));
      if (owner != null && owner >= i) {
        errors.push(`${where}.steps[${i}]: support [${support.join(',')}] must be placed before this step (order ${owner})`);
      }
    });
  }

  for (const [item, count] of Object.entries(used)) {
    if (need[item] == null) errors.push(`${where}: steps need ${item} but requires does not declare it`);
    else if (need[item] < count) errors.push(`${where}.requires.${item}: ${need[item]} < ${count} steps need it`);
  }

  // R6: dimensione e velocità. Il conto è sui componenti che lavorano (un
  // repeater consuma `repeater` ma diventa `unpowered_repeater`).
  if (Array.isArray(steps)) {
    const components = steps.filter(s => s && lagComponent(placedAs(s.block ?? s.item))).length;
    if (components > MAX_CIRCUIT_COMPONENTS) {
      errors.push(`${where}: too many redstone components (${components} > ${MAX_CIRCUIT_COMPONENTS})`);
    }
  }
  if (def.clock === true) {
    if (!Array.isArray(def.post) || def.post.length === 0) {
      errors.push(`${where}.clock: a declared clock needs at least one repeater post`);
    } else {
      const ticks = expectedDelayTicks(def);
      if (ticks != null && ticks < MIN_CLOCK_TICKS) {
        errors.push(`${where}.clock: ${ticks} ticks is too fast for a running clock (min ${MIN_CLOCK_TICKS})`);
      }
    }
  } else if (def.clock != null && typeof def.clock !== 'boolean') {
    errors.push(`${where}.clock: must be a boolean`);
  }

  if (def.trigger != null) {
    if (!isOffset(def.trigger.offset)) errors.push(`${where}.trigger.offset: must be [x, y, z] integers`);
    else {
      const owner = cells.get(def.trigger.offset.join(','));
      if (owner == null) errors.push(`${where}.trigger.offset: no step places [${def.trigger.offset.join(',')}]`);
      else {
        const item = steps[owner].item;
        if (!isRedstoneComponent(item) && item !== 'lever' && item !== 'stone_button' && item !== 'wooden_button' && item !== 'polished_blackstone_button') {
          errors.push(`${where}.trigger: step ${owner} (${item}) is not something a click toggles`);
        }
      }
    }
  }

  if (def.success != null) {
    if (!Array.isArray(def.success)) errors.push(`${where}.success: must be an array`);
    else {
      def.success.forEach((check, i) => {
        const at = `${where}.success[${i}]`;
        if (!check || typeof check !== 'object') { errors.push(`${at}: not an object`); return; }
        if (!isOffset(check.offset)) { errors.push(`${at}: offset must be [x, y, z] integers`); return; }
        if (cells.get(check.offset.join(',')) == null) errors.push(`${at}: no step places [${check.offset.join(',')}]`);
        if (typeof check.property !== 'string' || !check.property.trim()) errors.push(`${at}: missing property`);
        const ok = ['string', 'number', 'boolean'].includes(typeof check.expected);
        if (!ok) errors.push(`${at}: expected must be a string, number or boolean`);
      });
    }
  }

  if (def.post != null) {
    if (!Array.isArray(def.post)) errors.push(`${where}.post: must be an array`);
    else {
      def.post.forEach((entry, i) => {
        const at = `${where}.post[${i}]`;
        if (!entry || typeof entry !== 'object') { errors.push(`${at}: not an object`); return; }
        if (entry.action !== 'set_repeater_delay') { errors.push(`${at}: unknown action "${entry.action}"`); return; }
        if (!isOffset(entry.offset)) { errors.push(`${at}: offset must be [x, y, z] integers`); return; }
        const owner = cells.get(entry.offset.join(','));
        if (owner == null) errors.push(`${at}: no step places [${entry.offset.join(',')}]`);
        else if (steps[owner].item !== 'repeater') errors.push(`${at}: [${entry.offset.join(',')}] is ${steps[owner].item}, not a repeater`);
        if (!Number.isInteger(entry.delay) || entry.delay < 0 || entry.delay > MAX_REPEATER_DELAY) {
          errors.push(`${at}: delay must be 0..${MAX_REPEATER_DELAY}`);
        }
      });
    }
  }

  if (def.measure != null) {
    const m = def.measure;
    if (typeof m !== 'object' || Array.isArray(m)) errors.push(`${where}.measure: not an object`);
    else {
      if (!Number.isInteger(m.expectedTicks) || m.expectedTicks < 0) errors.push(`${where}.measure.expectedTicks: must be a non-negative integer`);
      if (m.toleranceMs != null && (!Number.isInteger(m.toleranceMs) || m.toleranceMs < 0)) errors.push(`${where}.measure.toleranceMs: must be a non-negative integer`);
      if (m.required != null && typeof m.required !== 'boolean') errors.push(`${where}.measure.required: must be a boolean`);
      if (m.required === true && !Array.isArray(m.outputOffset)) errors.push(`${where}.measure.outputOffset: required to verify the timing`);
      if (m.outputOffset != null) {
        if (!Array.isArray(m.outputOffset) || m.outputOffset.length !== 3 || !m.outputOffset.every(n => Number.isInteger(n))) {
          errors.push(`${where}.measure.outputOffset: must be [x, y, z] integers`);
        } else if (cells.get(m.outputOffset.join(',')) == null) {
          errors.push(`${where}.measure.outputOffset: no step places [${m.outputOffset.join(',')}]`);
        }
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------- catalogo

export function collectCircuitFiles (dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) out.push(...collectCircuitFiles(`${dir}/${entry.name}`));
    else if (entry.name.endsWith('.json')) out.push(`${dir}/${entry.name}`);
  }
  return out;
}

export function loadCircuits (root = new URL('./circuits/', import.meta.url)) {
  // `readdirSync` accetta un URL, la concatenazione dei percorsi no: il catalogo
  // di default arriva come URL, quindi si normalizza subito.
  const dir = root instanceof URL ? fileURLToPath(root) : String(root);
  const errors = [];
  const map = new Map();
  for (const file of collectCircuitFiles(dir)) {
    let def = null;
    try {
      def = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      errors.push(`${file}: ${error.message}`);
      continue;
    }
    const where = file.replace(/^.*\//, '').replace(/\.json$/, '');
    const problems = validateCircuit(def, where);
    if (problems.length) { errors.push(...problems); continue; }
    if (map.has(def.id)) { errors.push(`${where}: duplicate circuit id "${def.id}"`); continue; }
    map.set(def.id, { ...def, buildable: def.buildable !== false, source: file });
  }
  if (errors.length) throw new Error(`invalid circuits:\n${errors.join('\n')}`);
  return map;
}

// ---------------------------------------------------------------- piano

export function planCircuit (def, { origin = { x: 0, y: 0, z: 0 }, facing = 'south', available = {} } = {}) {
  if (!def || !def.id) return { ok: false, error: 'unknown_circuit' };
  if (!CIRCUIT_FACINGS.includes(facing)) return { ok: false, error: 'unknown_facing', facing };
  const base = { x: Math.round(origin.x), y: Math.round(origin.y), z: Math.round(origin.z) };
  const steps = def.steps.map((step, index) => {
    const supportOffset = Array.isArray(step.supportOffset)
      ? step.supportOffset
      : [step.offset[0], step.offset[1] - 1, step.offset[2]];
    return {
      index,
      label: step.label ?? `${step.item}_${index}`,
      item: step.item,
      block: step.block ?? placedAs(step.item),
      cell: addOffset(base, step.offset, facing),
      support: addOffset(base, supportOffset, facing),
      face: step.face ?? 1,
      facing: step.facing ?? null,
      clickPos: step.clickPos ?? { x: 0.5, y: 1, z: 0.5 },
    };
  });
  const need = {};
  for (const step of steps) need[step.item] = (need[step.item] ?? 0) + 1;
  const missing = Object.entries(def.requires ?? {})
    .filter(([item, qty]) => (Number(available?.[item]) || 0) < qty)
    .map(([item, qty]) => ({ item, need: qty, have: Number(available?.[item]) || 0 }));
  const triggerStep = def.trigger ? steps.find(s => cellKey(s.cell) === cellKey(addOffset(base, def.trigger.offset, facing))) : null;
  const success = (def.success ?? []).map(check => ({ ...check, cell: addOffset(base, check.offset, facing) }));
  const post = (def.post ?? []).map(entry => ({ ...entry, cell: addOffset(base, entry.offset, facing) }));
  return {
    ok: missing.length === 0,
    id: def.id,
    facing,
    origin: base,
    anchor: def.anchor?.offset ? addOffset(base, def.anchor.offset, facing) : base,
    steps,
    need,
    missing,
    trigger: triggerStep ? { cell: triggerStep.cell, item: triggerStep.item, label: triggerStep.label } : null,
    success,
    post,
    measure: def.measure
      ? {
        expectedTicks: expectedDelayTicks(def),
        toleranceMs: def.measure.toleranceMs ?? DEFAULT_DELAY_TOLERANCE_MS,
        required: def.measure.required === true,
        output: Array.isArray(def.measure.outputOffset)
          ? addOffset(base, def.measure.outputOffset, facing)
          : null,
      }
      : null,
    buildable: def.buildable !== false,
    blocked: def.blocked ?? null,
  };
}

// Cosa impedisce la costruzione *adesso*: una cella dei passi occupata (o un
// supporto assente). Non è "il piano è sbagliato", è "il sito non è libero":
// l'adapter lo riporta e non tocca nulla.
export function circuitSiteBlocked (plan, world) {
  const blocked = [];
  if (!plan?.steps) return blocked;
  const stepCells = new Set(plan.steps.map(s => cellKey(s.cell)));
  for (const step of plan.steps) {
    const at = world(step.cell);
    const name = at?.name ?? null;
    if (name && !EMPTY_BLOCKS.has(name)) blocked.push({ label: step.label, cell: step.cell, name, reason: 'occupied' });
    // Il supporto o è il terreno (va verificato) o è un altro passo del piano:
    // quest'ultimo lo piazza il cantiere, quindi non si chiede al mondo di
    // averlo già — altrimenti ogni circuito con una leva sopra un blocco
    // risulterebbe "senza supporto".
    if (stepCells.has(cellKey(step.support))) continue;
    const under = world(step.support);
    const underName = under?.name ?? null;
    if (!underName || EMPTY_BLOCKS.has(underName) || underName === 'unknown') {
      blocked.push({ label: step.label, cell: step.support, name: underName, reason: 'no_support' });
      continue;
    }
    if (BAD_SUPPORT.test(underName)) blocked.push({ label: step.label, cell: step.support, name: underName, reason: 'usable_block' });
    if (under?.boundingBox === 'empty') blocked.push({ label: step.label, cell: step.support, name: underName, reason: 'no_support' });
  }
  return blocked;
}

// R6 — sicurezza del bot. Due controlli puri, entrambi sulle celle assolute del
// piano: (1) il cantiere non può contenere le celle che il bot occupa (piedi,
// testa e blocco su cui sta) — piazzare un blocco dentro di sé non funziona mai
// e il server lo rifiuta, ma il rifiuto deve arrivare *prima* del primo
// movimento; (2) il bot non deve sostare nel percorso di un pistone del
// circuito, perché il trigger viene azionato davvero e il pistone spinge.
export function botCells (feet) {
  if (!feet || !Number.isFinite(feet.x) || !Number.isFinite(feet.y) || !Number.isFinite(feet.z)) return [];
  const x = Math.floor(feet.x);
  const y = Math.floor(feet.y);
  const z = Math.floor(feet.z);
  return [`${x},${y},${z}`, `${x},${y + 1},${z}`, `${x},${y - 1},${z}`];
}

// Le celle che i pistoni del piano spingerebbero, nella direzione dichiarata.
export function pistonPath (plan) {
  const out = [];
  for (const step of plan?.steps ?? []) {
    const block = placedAs(step.block ?? step.item);
    if (!PISTON_BLOCKS.has(block)) continue;
    const facing = FORWARD[step.facing] ?? FORWARD.south;
    for (let i = 1; i <= PISTON_SAFETY_DISTANCE; i++) {
      out.push({ label: step.label, cell: { x: step.cell.x + facing.x * i, y: step.cell.y, z: step.cell.z + facing.z * i } });
    }
  }
  return out;
}

export function circuitSafety (plan, { feet = null } = {}) {
  const found = [];
  if (!plan?.steps) return found;
  const mine = new Set(botCells(feet));
  for (const step of plan.steps) {
    if (mine.has(cellKey(step.cell))) found.push({ label: step.label, cell: step.cell, reason: 'bot_in_the_way' });
  }
  for (const entry of pistonPath(plan)) {
    if (mine.has(cellKey(entry.cell))) found.push({ label: entry.label, cell: entry.cell, reason: 'bot_in_piston_path' });
  }
  return found;
}

export const EMPTY_BLOCKS = new Set(['air', 'cave_air', 'void_air']);

// Stessa lista dell'adapter (`_badSupport`): cliccare un blocco usabile lo apre
// invece di piazzarci sopra. Le assi non sono in elenco, quindi un pavimento di
// legno resta un supporto valido.
const BAD_SUPPORT = /(chest|_table$|furnace|smoker|barrel|shulker_box|hopper|anvil|brewing_stand|beacon|loom|stonecutter|grindstone|lectern|composter|cauldron|bell|_bed$|_sign$|_banner$|_door$|_fence_gate$|_pot$|torch|lantern)/;

// ---------------------------------------------------------------- verifica

function sameValue (actual, expected) {
  if (actual == null) return false;
  if (typeof expected === 'number') return Number(actual) === expected;
  if (typeof expected === 'boolean') return actual === expected || actual === (expected ? 1 : 0);
  return String(actual).toLowerCase() === String(expected).toLowerCase();
}

// Confronta le proprietà attese con quello che il mondo riporta *adesso*.
// `read(cell)` torna il blocco (o null): un blocco mancante o una proprietà
// illeggibile fanno fallire il check, non lo fanno passare.
export function checkCircuitSuccess (def, { origin = { x: 0, y: 0, z: 0 }, facing = 'south', read } = {}) {
  const checks = [];
  for (const check of def?.success ?? []) {
    const cell = addOffset(origin, check.offset, facing);
    const block = read?.(cell) ?? null;
    const props = block ? (block.getProperties?.() ?? block.properties ?? block._properties ?? null) : null;
    let actual;
    if (check.property === 'name') actual = block?.name ?? null;
    else actual = props ? (props[check.property] ?? null) : null;
    const ok = sameValue(actual, check.expected) && !(actual == null);
    checks.push({
      offset: check.offset,
      cell,
      property: check.property,
      expected: check.expected,
      actual: actual ?? null,
      ok,
      error: ok ? null : (block == null ? 'no_block' : (actual == null ? 'property_unreadable' : 'value_mismatch')),
    });
  }
  return {
    ok: checks.length > 0 && checks.every(c => c.ok),
    empty: checks.length === 0,
    checks,
  };
}

// Ritardo atteso di una delay line: la leva alimenta subito il primo repeater,
// quindi il ritardo totale è la somma dei singoli. In Bedrock la proprietà
// `repeater_delay` vale 0..3 e corrisponde a 1..4 redstone tick, perciò ogni
// repeater contribuisce `delay + 1` (una stima dichiarata: il round live deve
// misurarla, vedi `measure` nel blueprint).
export function expectedDelayTicks (def) {
  if (def?.measure?.expectedTicks != null) return def.measure.expectedTicks;
  const delays = (def?.post ?? []).map(p => p.delay ?? 0).filter(d => typeof d === 'number');
  if (!delays.length) return null;
  return delays.reduce((sum, d) => sum + (d + 1), 0);
}

// Un tick Bedrock dura 50 ms: serve a confrontare il ritardo dichiarato dal
// blueprint con quello osservato dal vivo (dove l'unica unità misurabile è il
// tempo, non il tick).
export const TICK_MS = 50;
export const DEFAULT_DELAY_TOLERANCE_MS = 60;

// Misura il ritardo di un circuito dagli aggiornamenti di blocco osservati
// ([{position, name, power, at}] in ordine cronologico, vedi la traccia
// dell'adapter): prende il primo cambiamento dell'output avvenuto **dopo** il
// trigger e lo confronta con i tick dichiarati. Non inventa mai una misura:
// senza campioni `measuredMs` è null e `ok` resta null (da trattare come
// "non misurato", mai come successo).
export function measureCircuitDelay ({ trace = [], cell = null, triggeredAt = null, expectedTicks = null, toleranceMs = DEFAULT_DELAY_TOLERANCE_MS } = {}) {
  const expectedMs = expectedTicks == null ? null : expectedTicks * TICK_MS;
  const base = { expectedTicks, expectedMs, toleranceMs, measuredMs: null, measuredTicks: null, ok: null, samples: 0 };
  if (!cell || triggeredAt == null) return base;
  const key = cellKey(cell);
  const samples = (trace ?? [])
    .filter(entry => entry?.at != null && entry.at >= triggeredAt && cellKey(entry.position ?? {}) === key)
    .sort((a, b) => a.at - b.at);
  if (!samples.length) return base;
  const first = samples[0];
  const measuredMs = Math.max(0, first.at - triggeredAt);
  const measuredTicks = Math.round(measuredMs / TICK_MS);
  return {
    ...base,
    measuredMs,
    measuredTicks,
    samples: samples.length,
    ok: expectedMs == null ? null : Math.abs(measuredMs - expectedMs) <= toleranceMs,
  };
}
