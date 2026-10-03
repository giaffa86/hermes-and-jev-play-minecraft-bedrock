// Cascate e colonne di bolle (M3 dei fluidi): riconoscere una discesa/risalita
// sicura in acqua e decidere se usarla.
//
// Modulo **puro**: nessuna I/O, nessuna nozione di percorso. Riceve le celle
// fluide del censimento (`{name, position}`), un eventuale lettore di blocchi
// (`blockAt`) per guardare sotto la colonna, e l'aria residua; restituisce
// candidati e un verdetto tipizzato. La fisica del nuoto non è modellata qui:
// `waterfallTactic` dichiara esplicitamente `swimming_unavailable` finché il
// movimento in acqua (M1) non esiste — meglio un rifiuto onesto che una
// discesa immaginaria.
import { isWaterBlock } from './bedrock-fluids.mjs';
import { divePlan } from './bedrock-dive.mjs';

export const SOUL_SAND_BLOCK = 'soul_sand';
export const MAGMA_BLOCK = 'magma';
export const WATERFALL_MIN_HEIGHT = 3;
export const BUBBLE_MIN_HEIGHT = 2;
export const COLUMN_LIMIT = 4;
export const WATERFALL_MAX_DISTANCE = 16;

// Atterraggi che non si scelgono mai: la lava brucia, il magma blocca il respiro
// (colonna di bolle verso il basso), il cactus e le bacche pungono, la punta di
// stalattite fa male. L'aria sotto la colonna significa che la cascata non
// atterra da nessuna parte: non è una discesa, è un salto nel vuoto.
const UNSAFE_LANDING = /(lava|magma|campfire|fire|cactus|sweet_berry_bush|pointed_dripstone)/;

function cellKey (position) {
  return `${position.x},${position.z}`;
}

function key3 (position) {
  return `${position.x},${position.y},${position.z}`;
}

function blockName (block) {
  return block?.name ?? null;
}

function isAirName (name) {
  return name === 'air' || name === 'cave_air' || name === 'void_air';
}

// Verdetto sull'atterraggio di una colonna: `safe` è null quando non sappiamo
// (né mappa né `blockAt`), perché un atterraggio ignoto non è un atterraggio
// sicuro.
export function landingVerdict (block) {
  const name = blockName(block);
  if (name == null) return { safe: null, kind: 'unknown', name: null };
  if (isWaterBlock(name)) return { safe: true, kind: 'water', name };
  if (UNSAFE_LANDING.test(name)) return { safe: false, kind: 'hazard', name };
  if (isAirName(name)) return { safe: false, kind: 'air', name };
  return { safe: true, kind: 'solid', name };
}

function findIn (blocks, position) {
  const wanted = key3(position);
  for (const block of blocks) {
    if (block?.position && key3(block.position) === wanted) return block;
  }
  return null;
}

function runsOf (ys, minHeight) {
  const runs = [];
  let start = null;
  for (let i = 0; i < ys.length; i++) {
    const y = ys[i];
    if (start == null) { start = y; continue; }
    if (y === ys[i - 1] - 1) continue;
    if (start - ys[i - 1] + 1 >= minHeight) runs.push({ top: start, bottom: ys[i - 1] });
    start = y;
  }
  if (start != null && start - ys[ys.length - 1] + 1 >= minHeight) {
    runs.push({ top: start, bottom: ys[ys.length - 1] });
  }
  return runs;
}

function landingOf ({ blocks, blockAt, x, z, bottomY }) {
  const position = { x, y: bottomY - 1, z };
  const block = findIn(blocks, position) ?? (blockAt ? blockAt(position) : null);
  const verdict = landingVerdict(block);
  return { position, name: verdict.name, safe: verdict.safe, kind: verdict.kind };
}

function sortCandidates (candidates, from, limit) {
  const withDistance = candidates.map(entry => ({
    ...entry,
    distance: from
      ? +Math.hypot(entry.top.x - from.x, entry.top.y - from.y, entry.top.z - from.z).toFixed(1)
      : null,
  }));
  withDistance.sort((a, b) => {
    if (a.distance != null && b.distance != null && a.distance !== b.distance) return a.distance - b.distance;
    if (a.height !== b.height) return b.height - a.height;
    return key3(a.top).localeCompare(key3(b.top));
  });
  return withDistance.slice(0, limit);
}

// Cascate: colonne d'acqua verticali alte almeno `minHeight`, con l'atterraggio
// noto e non pericoloso. Una cascata "vera" ha la sorgente in cima e l'acqua che
// scorre sotto: qui basta la colonna d'acqua, perché `flowing_water` e `water`
// finiscono entrambi in `isWaterBlock` e il nome del blocco in cima viene
// riportato per chi vuole distinguerli.
export function findWaterfalls (blocks = [], {
  from = null,
  minHeight = WATERFALL_MIN_HEIGHT,
  limit = COLUMN_LIMIT,
  includeUnsafe = false,
  blockAt = null,
} = {}) {
  const byColumn = new Map();
  for (const block of blocks) {
    if (!block?.position || !isWaterBlock(block.name)) continue;
    const key = cellKey(block.position);
    if (!byColumn.has(key)) byColumn.set(key, []);
    byColumn.get(key).push(block);
  }
  const candidates = [];
  for (const [, cells] of byColumn) {
    const ys = [...new Set(cells.map(cell => cell.position.y))].sort((a, b) => b - a);
    const { x, z } = cells[0].position;
    for (const run of runsOf(ys, minHeight)) {
      const landing = landingOf({ blocks, blockAt, x, z, bottomY: run.bottom });
      if (!includeUnsafe && landing.safe !== true) continue;
      const topCell = findIn(blocks, { x, y: run.top, z });
      candidates.push({
        x,
        z,
        top: { x, y: run.top, z },
        bottom: { x, y: run.bottom, z },
        height: run.top - run.bottom + 1,
        source: blockName(topCell),
        landing,
      });
    }
  }
  return sortCandidates(candidates, from, limit);
}

// Colonne di bolle: acqua sopra `soul_sand` (spinge in alto e **ripristina
// l'aria**) o sopra `magma` (spinge in basso e fa male se non si è accovacciati).
export function findBubbleColumns (blocks = [], {
  from = null,
  minHeight = BUBBLE_MIN_HEIGHT,
  limit = COLUMN_LIMIT,
  blockAt = null,
} = {}) {
  const byColumn = new Map();
  for (const block of blocks) {
    if (!block?.position || !isWaterBlock(block.name)) continue;
    const key = cellKey(block.position);
    if (!byColumn.has(key)) byColumn.set(key, []);
    byColumn.get(key).push(block);
  }
  const candidates = [];
  for (const [, cells] of byColumn) {
    const ys = [...new Set(cells.map(cell => cell.position.y))].sort((a, b) => b - a);
    const { x, z } = cells[0].position;
    for (const run of runsOf(ys, minHeight)) {
      const base = { x, y: run.bottom - 1, z };
      const block = findIn(blocks, base) ?? (blockAt ? blockAt(base) : null);
      const name = blockName(block);
      if (name !== SOUL_SAND_BLOCK && name !== MAGMA_BLOCK) continue;
      const up = name === SOUL_SAND_BLOCK;
      candidates.push({
        x,
        z,
        direction: up ? 'up' : 'down',
        source: name,
        airRefill: up,
        top: { x, y: run.top, z },
        bottom: { x, y: run.bottom, z },
        height: run.top - run.bottom + 1,
        landing: landingOf({ blocks, blockAt, x, z, bottomY: run.bottom }),
      });
    }
  }
  return sortCandidates(candidates, from, limit);
}

// La cella del bot sta dentro la colonna? Serve alla condizione `onWaterfall` e
// a non offrire una discesa che è già in corso.
export function withinColumn (column, feet) {
  if (!column || !feet) return false;
  const fx = Math.floor(feet.x);
  const fz = Math.floor(feet.z);
  if (fx !== column.x || fz !== column.z) return false;
  const y = Math.floor(feet.y);
  return y >= column.bottom.y && y <= column.top.y;
}

// Verdetto su un'azione in colonna: `kind` è `descend` (cascata), `climb`
// (cascata in salita) o `bubble` (colonna di bolle). Il budget d'aria riusa
// `divePlan` di M2: la colonna costa discesa + lavoro + risalita come
// qualunque immersione, con la sola eccezione della colonna di bolle verso
// l'alto, che ripristina l'aria (`held: 'bubble_column'`).
export function columnTactic ({
  kind = 'descend',
  column = null,
  feet = null,
  air = null,
  waterBreathing = false,
  swimSupported = false,
  maxDistance = WATERFALL_MAX_DISTANCE,
  distance = null,
} = {}) {
  if (!column) return { ok: false, error: 'no_column', kind };
  if (kind === 'descend' && withinColumn(column, feet)) {
    return { ok: true, kind, reason: 'already_inside', column, plan: null, distance };
  }
  const reach = distance ?? (feet
    ? +Math.hypot(column.top.x - feet.x, column.top.y - feet.y, column.top.z - feet.z).toFixed(1)
    : null);
  if (reach != null && reach > maxDistance) {
    return { ok: false, error: 'too_far', kind, column, distance: reach, maxDistance };
  }
  if (kind === 'bubble' && column.direction === 'down') {
    // Il magma fa danno a chi non è accovacciato, e il bot non ha ancora un
    // flag di sneak: il motivo vero del rifiuto è quello, e vale prima del
    // generico atterraggio pericoloso (che qui *è* il magma stesso).
    return { ok: false, error: 'sneak_not_supported', kind, column, landing: column.landing };
  }
  if (column.landing && column.landing.safe === false) {
    return { ok: false, error: 'unsafe_landing', kind, column, landing: column.landing };
  }
  if (column.landing && column.landing.safe === null) {
    return { ok: false, error: 'unknown_landing', kind, column, landing: column.landing };
  }
  if (!swimSupported) {
    return { ok: false, error: 'swimming_unavailable', kind, column, distance: reach, landing: column.landing };
  }
  if (kind === 'bubble' && column.airRefill === true) {
    return { ok: true, kind, reason: 'bubble_column', column, plan: null, distance: reach };
  }
  const plan = divePlan({ air, depth: column.height, workSeconds: 0, waterBreathing });
  if (!plan.ok) {
    return { ok: false, error: plan.error, kind, column, distance: reach, plan };
  }
  return { ok: true, kind, reason: kind === 'climb' ? 'climb_waterfall' : 'descend_waterfall', column, plan, distance: reach };
}

// Riga compatta per `/observe`: un candidato con la sua distanza, senza l'intera
// mappa delle celle.
export function summarizeColumn (column, from = null) {
  if (!column) return null;
  return {
    x: column.x,
    z: column.z,
    top: column.top,
    bottom: column.bottom,
    height: column.height,
    direction: column.direction ?? null,
    source: column.source ?? null,
    landing: column.landing ? { position: column.landing.position, name: column.landing.name, safe: column.landing.safe } : null,
    distance: from
      ? +Math.hypot(column.top.x - from.x, column.top.y - from.y, column.top.z - from.z).toFixed(1)
      : null,
  };
}
