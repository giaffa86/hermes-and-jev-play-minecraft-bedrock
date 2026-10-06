// Village census — the register of a site, computed from what was observed.
//
// Pure and deterministic (no I/O, no clock): the same observation produces the
// same census, and whoever looked decides *when* to look. It consumes two things
// that already exist:
//   - the structure detector (`structures.mjs`), which says whether this is a
//     village at all, with which evidence and which anchor, and
//   - the observation shape the adapter already produces (`observe().nearby`
//     cells with `mature`, `observe().farmAnimals`, `observe().bed`, and the
//     storage register),
// and adds what the detector cannot say: *pertinenze*. Houses (bed clusters with
// their containers and doors), plots (crop clusters with ripe/immature cells and
// the seed to replant), pens (animal clusters, fenced or not), and the storage
// list with what is known about each container.
//
// Two rules keep it honest:
//   - `checked` answers "did we look?" and `detection.state` answers "what did
//     we find?": NOT_FOUND is *looked and empty*, never *not looked* (that is
//     `checked: false, state: null`). CANDIDATE is a partial match, recorded as
//     a lead; CONFIRMED is the detector's rule over threshold. Nothing here can
//     come from a world query — `/locate` is out of scope on purpose.
//   - the census never guesses: a crop whose maturity the observer could not
//     read stays `unknown`, and a field the input does not carry stays `null`.

import { isCropBlock, seedForCrop, isFarmAnimalType, CROP_BLOCKS } from './bedrock-survival.mjs';
import { detectStructures, scoreStructures } from './structures.mjs';

// Le famiglie che il censimento sa cercare *per nome*: `findBlocks` vuole un nome
// esatto, quindi la lista dei recinti non è una whitelist scritta qui (11 legni,
// il muro di mattoni del Nether, le cancellate) ma i nomi che la survey ha già
// visto, filtrati per famiglia. Letti e colture sono invece nomi di gioco.
const VILLAGE_FENCE = /fence|_wall$/;

export function isVillageFenceName (name) {
  return VILLAGE_FENCE.test(nameOf(name));
}

// Names the census has to scan for cells, given the names a `surveyBlocks` pass
// saw in the area. Sorted and de-duplicated so the scan order is deterministic.
export function villageCensusNames (surveyed = []) {
  const names = ['bed', ...CROP_BLOCKS];
  for (const name of surveyed || []) if (isVillageFenceName(name)) names.push(nameOf(name));
  return [...new Set(names)].sort();
}

export const VILLAGE_HOUSE_RADIUS = 8;
export const VILLAGE_PLOT_RADIUS = 4;
export const VILLAGE_PEN_RADIUS = 12;
export const VILLAGE_MAX_CELLS = 20000;

export const VILLAGE_DETECTION_STATE = Object.freeze({
  NOT_FOUND: 'NOT_FOUND',
  CANDIDATE: 'CANDIDATE',
  CONFIRMED: 'CONFIRMED',
});

// Un villaggio è largo una manciata di celle, non una regione: lo sweep che lo
// censice usa la stessa spirale dell'esplorazione, con passo fine e bordo
// ancorato. Questi due numeri descrivono *un villaggio*, non l'esplorazione.
export const VILLAGE_SURVEY_SPACING = 24;
export const VILLAGE_SURVEY_RADIUS = 48;

// `survey_village` non è un secondo motore di sweep: è **questa configurazione**
// del planner generale (`planExplorationSweep` in `exploration.mjs`). Tutto ciò
// che il planner riceve è derivato dall'anchor e da questi due numeri — nessuna
// posizione del bot, nessun orologio — quindi la stessa `(anchor, visited,
// config)` riproduce lo stesso piano dopo un riavvio. `cells` resta `null` di
// proposito: il budget di *waypoint* è la spirale stessa, mentre
// `VILLAGE_SURVEY_CELLS` conta i *blocchi* censiti dentro ogni waypoint — due
// grandezze diverse, che non vanno confuse. `visited` esce come array (non
// `Set`) perché la configurazione deve sopravvivere a un `JSON.stringify`.
export function villageSweepConfig ({ anchor = null, radius = VILLAGE_SURVEY_RADIUS, spacing = VILLAGE_SURVEY_SPACING, visited = [] } = {}) {
  const step = Number.isFinite(spacing) && spacing > 0 ? spacing : VILLAGE_SURVEY_SPACING;
  const bound = Number.isFinite(radius) && radius > 0 ? radius : VILLAGE_SURVEY_RADIUS;
  return {
    anchor: pos(anchor),
    visited: [...(visited ?? [])],
    spacing: step,
    // Gli anelli che stanno **dentro** il bordo: `spiralOffsets(r)` arriva a
    // `r * step * √2` sulle diagonali, quindi un numero di anelli derivato dal
    // raggio garantisce che nessun waypoint cada fuori. Conseguenza voluta: lo
    // sweep dell'area assegnata è completo (`stoppedBy: 'exhausted'`) invece di
    // restare troncato per costruzione a ogni passata.
    maxRadius: Math.max(0, Math.floor(bound / (step * Math.SQRT2))),
    radius: bound,
    cells: null,
  };
}

const nameOf = value => String(value ?? '').replace(/^minecraft:/, '').toLowerCase();

const pos = value => {
  if (!value) return null;
  const { x, y, z } = value;
  if (![x, y, z].every(Number.isFinite)) return null;
  return { x: Math.round(x), y: Math.round(y), z: Math.round(z) };
};

// Planar: a house is a chain of beds, not a sphere — two beds on different
// floors of the same building are the same house.
const planar = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

// Deterministic order: an input order must never change the census.
const byPosition = (a, b) => (a.position.z - b.position.z) || (a.position.x - b.position.x) || (a.position.y - b.position.y);
const cellKey = position => `${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`;
// Una cella riporta un booleano solo quando l'osservazione lo sa: `null` è
// "non lo so", un fatto diverso da `false`.
const triState = value => {
  if (value === true) return true;
  if (value === false) return false;
  return null;
};

// Greedy chaining: a row joins the first group of the same key with a member
// within `radius`. Deterministic given a sorted input, and it follows the shape
// of a building instead of imposing a circle on it.
function cluster (rows, radius, key = row => row.name) {
  const groups = [];
  for (const row of rows) {
    const wanted = key(row);
    let joined = null;
    for (const group of groups) {
      if (group.key !== wanted) continue;
      if (group.rows.some(other => planar(other.position, row.position) <= radius)) { joined = group; break; }
    }
    if (joined) joined.rows.push(row);
    else groups.push({ key: wanted, rows: [row] });
  }
  return groups;
}

function nearbyCells (nearby) {
  const rows = [];
  for (const [block, cells] of Object.entries(nearby || {})) {
    const name = nameOf(block);
    for (const cell of cells || []) {
      const position = pos(cell?.position);
      if (!position) continue;
      rows.push({
        name,
        position,
        mature: triState(cell?.mature),
        occupied: triState(cell?.occupied),
      });
    }
  }
  return rows.sort(byPosition);
}

// `observe().bed` knows whether a bed is occupied; when it is available it
// *enriches* the bed cells seen in `nearby`. Enrich, never replace: the list may
// be capped by whoever read it (the adapter asks the world for N beds), and a
// capped list must never shrink a census taken over the whole radius.
function withBeds (cells, beds) {
  if (!Array.isArray(beds) || !beds.length) return cells;
  const rows = beds
    .map(bed => ({ position: pos(bed?.position), occupied: triState(bed?.occupied) }))
    .filter(bed => bed.position)
    .map(bed => ({ name: 'bed', position: bed.position, mature: null, occupied: bed.occupied }));
  const index = new Map(rows.map(row => [cellKey(row.position), row]));
  const placed = new Set();
  const out = [];
  for (const cell of cells) {
    const key = cellKey(cell.position);
    const row = /bed$/.test(cell.name) ? index.get(key) : null;
    if (row) { out.push(row); placed.add(key); continue; }
    out.push(cell);
  }
  for (const row of rows) {
    const key = cellKey(row.position);
    if (placed.has(key)) continue;
    placed.add(key);
    out.push(row);
  }
  return out.sort(byPosition);
}

// The detector wants the histogram shape `surveyBlocks` produces; the census has
// cell lists, so it builds it here instead of asking the caller for both. A
// world survey, when the executor has one, is *merged in*: its counts are the
// whole radius's, while the cell lists are bounded (capped per name), and the
// verdict must not get smaller because the census could not read every cell.
function histogramOf (cells) {
  const survey = new Map();
  for (const cell of cells) {
    const row = survey.get(cell.name);
    if (row) row.count++;
    else survey.set(cell.name, { count: 1, first: { ...cell.position } });
  }
  return survey;
}

function entriesOf (survey) {
  if (survey instanceof Map) return survey.entries();
  return Object.entries(survey ?? {});
}

// Merge a world survey (`surveyBlocks().names`) into the census histogram. The
// counts are the whole radius's, the cell lists are bounded per name: the verdict
// must not shrink just because the census could not read every cell, and the
// detector must see the same numbers `GET /observe.structures` saw.
function mergeHistogram (histogram, survey) {
  if (!survey) return histogram;
  for (const [name, row] of entriesOf(survey)) {
    const key = nameOf(name);
    const count = Number.isFinite(row?.count) ? row.count : null;
    const first = pos(row?.first);
    const existing = histogram.get(key);
    if (!existing) {
      histogram.set(key, { count: count ?? 1, first });
      continue;
    }
    if (count != null) existing.count = Math.max(existing.count, count);
    if (!existing.first) existing.first = first;
  }
  return histogram;
}

function countFor (verdict, label) {
  if (verdict.blocks?.[label] != null) return verdict.blocks[label];
  if (verdict.entities?.[label] != null) return verdict.entities[label];
  return null;
}

function evidenceOf (verdict) {
  if (!verdict) return [];
  return verdict.matched.map(label => {
    const count = countFor(verdict, label);
    return count == null ? label : `${label} ${count}`;
  });
}

function containersOf (rows) {
  return (rows || [])
    .map(row => {
      const position = pos(row?.position);
      if (!position) return null;
      const contents = row?.contains ?? row?.contents ?? null;
      const contentsKnown = row?.contentsKnown === false ? false : (row?.contentsKnown === true ? true : contents != null);
      return {
        position,
        type: nameOf(row?.type) || null,
        contains: contentsKnown ? (contents ?? {}) : null,
        contentsKnown,
        status: row?.status ?? null,
        rememberedAt: row?.rememberedAt ?? row?.inspectedAt ?? row?.lastSeenAt ?? null,
      };
    })
    .filter(Boolean);
}

function housesOf (cells, containers, radius) {
  const beds = cells.filter(cell => /bed$/.test(cell.name));
  const doors = cells.filter(cell => /_door$/.test(cell.name));
  return cluster(beds, radius).map(group => {
    const anchor = group.rows[0].position;
    const own = containers.filter(container => group.rows.some(cell => planar(cell.position, container.position) <= radius));
    const near = cells.filter(cell => /_door$/.test(cell.name) && group.rows.some(bed => planar(bed.position, cell.position) <= radius));
    return {
      anchor,
      beds: group.rows.map(row => ({ position: row.position, occupied: row.occupied })),
      containers: own.map(row => ({ position: row.position, type: row.type })),
      evidence: { beds: group.rows.length, doors: near.length || doors.length * 0, containers: own.length },
    };
  });
}

function plotsOf (cells, radius) {
  const crops = cells.filter(cell => isCropBlock(cell.name));
  return cluster(crops, radius).map(group => {
    const rows = group.rows;
    const ready = rows.filter(row => row.mature === true).length;
    const immature = rows.filter(row => row.mature === false).length;
    const unknown = rows.length - ready - immature;
    const center = pos({
      x: rows.reduce((sum, row) => sum + row.position.x, 0) / rows.length,
      y: rows.reduce((sum, row) => sum + row.position.y, 0) / rows.length,
      z: rows.reduce((sum, row) => sum + row.position.z, 0) / rows.length,
    });
    return {
      crop: group.key,
      seed: seedForCrop(group.key),
      cells: rows.length,
      ready,
      immature,
      unknown,
      center,
    };
  });
}

function pensOf (entities, cells, radius) {
  const animals = entities
    .filter(entity => isFarmAnimalType(entity?.type))
    .map(entity => ({
      type: nameOf(entity.type),
      position: pos(entity.position),
      baby: entity.baby === true,
    }))
    .filter(animal => animal.position)
    .sort(byPosition);
  const fences = cells.filter(cell => /(^|_)fence(_gate)?$/.test(cell.name));
  return cluster(animals, radius, () => 'animal').map(group => {
    const anchor = group.rows[0].position;
    const byType = new Map();
    for (const animal of group.rows) {
      const row = byType.get(animal.type) || { type: animal.type, adults: 0, babies: 0 };
      if (animal.baby) row.babies++;
      else row.adults++;
      byType.set(animal.type, row);
    }
    return {
      anchor,
      fenced: fences.some(fence => planar(fence.position, anchor) <= radius),
      animals: [...byType.values()],
    };
  });
}

/**
 * Census of a village site.
 *
 * @param {object}   input
 * @param {object}   input.nearby       `observe().nearby`: block name → cells `{position, mature}`
 * @param {Array}    input.farmAnimals  `observe().farmAnimals`: `[{type, position, baby}]`
 * @param {Array}    [input.entities]   `observe().entities`: the detector's entity evidence (villagers
 *   included). It is a *different* list from `farmAnimals`: the pens read the livestock, the detector
 *   reads villagers. Defaults to `farmAnimals` so a caller with one list does not have to invent two.
 * @param {Array}    [input.beds]       `observe().bed`: `[{position, occupied}]` (richer than `nearby`)
 * @param {Array}    [input.containers] storage register rows (`position`, `type`, contents)
 * @param {object}   [input.anchor]     known village anchor (`{x,y,z}`), e.g. from world memory
 * @param {Map|object} [input.survey]   `surveyBlocks().names`: the executor's histogram. Its
 *   counts are the whole radius's, while the cell lists are bounded per name: merging the two
 *   keeps the verdict (and the anchor's `first` position) identical to `GET /observe.structures`.
 * @param {string}   [input.dimension]  default `overworld`
 * @param {number}   [input.scanned]    how many cells the executor looked at
 * @param {object}   [input.limits]     `{houseRadius, plotRadius, penRadius, maxCells}`
 * @returns {object} the census payload (without the executor's `stoppedBy`/`elapsedMs`/`at`)
 */
export function surveyVillage ({
  nearby = {},
  farmAnimals = [],
  entities = null,
  beds = null,
  containers = [],
  anchor = null,
  survey = null,
  dimension = 'overworld',
  scanned = null,
  limits = {},
} = {}) {
  const houseRadius = Number.isFinite(limits.houseRadius) ? limits.houseRadius : VILLAGE_HOUSE_RADIUS;
  const plotRadius = Number.isFinite(limits.plotRadius) ? limits.plotRadius : VILLAGE_PLOT_RADIUS;
  const penRadius = Number.isFinite(limits.penRadius) ? limits.penRadius : VILLAGE_PEN_RADIUS;
  const maxCells = Number.isFinite(limits.maxCells) && limits.maxCells >= 0 ? limits.maxCells : VILLAGE_MAX_CELLS;

  const all = withBeds(nearbyCells(nearby), beds);
  const cells = all.slice(0, maxCells);
  const dropped = all.length - cells.length;

  const storage = containersOf(containers);
  const animals = farmAnimals.filter(entity => isFarmAnimalType(entity?.type));
  const known = anchor ? pos(anchor) : null;

  const histogram = mergeHistogram(histogramOf(cells), survey);
  // The detector's entity evidence (villagers) is not the livestock list: a village
  // confirms on villagers even when every animal in sight belongs to a pen.
  const entityRows = entities ?? farmAnimals;
  const detected = detectStructures({ survey: histogram, entities: entityRows, position: known, dimension })
    .find(found => found.type === 'village') ?? null;
  const verdict = scoreStructures({ survey: histogram, entities: entityRows, dimension })
    .find(score => score.type === 'village') ?? null;

  const houses = housesOf(cells, storage, houseRadius);
  const plots = plotsOf(cells, plotRadius);
  const pens = pensOf(animals, cells, penRadius);

  const checked = scanned == null ? (cells.length > 0 || animals.length > 0 || storage.length > 0) : scanned > 0;
  let state = null;
  if (checked) {
    if (detected) state = VILLAGE_DETECTION_STATE.CONFIRMED;
    else if (verdict?.matched.length) state = VILLAGE_DETECTION_STATE.CANDIDATE;
    else state = VILLAGE_DETECTION_STATE.NOT_FOUND;
  }

  const site = known ?? detected?.position ?? houses[0]?.anchor ?? null;
  const ordered = site
    ? [...storage].sort((a, b) => planar(a.position, site) - planar(b.position, site))
    : [...storage].sort((a, b) => byPosition(a, b));

  return {
    checked,
    dimension,
    anchor: site,
    houses,
    plots,
    pens,
    storage: ordered,
    missing: verdict?.missing ?? [],
    detection: {
      state,
      evidence: evidenceOf(verdict),
      score: verdict?.score ?? 0,
      minScore: verdict?.minScore ?? null,
      matched: verdict?.matched ?? [],
      missing: verdict?.missing ?? [],
    },
    counts: {
      houses: houses.length,
      plots: plots.length,
      pens: pens.length,
      storage: ordered.length,
      beds: cells.filter(cell => /bed$/.test(cell.name)).length,
      animals: animals.length,
      crops: cells.filter(cell => isCropBlock(cell.name)).length,
    },
    survey: {
      scanned: scanned == null ? cells.length : scanned,
      cells: cells.length,
      dropped,
      truncated: dropped > 0,
    },
  };
}
