// The knowledge ladder for "find me item X in a container".
//
// The ladder is not a search order invented here: it is the order of the facts
// the bot can *already* have, cheapest first.
//
//   1. KNOWN_ITEM  — a remembered container whose contents include the item.
//                    Cost: a walk. (`verify: true` when the memory of the
//                    contents is stale: arriving must re-read before trusting.)
//   2. INSPECT     — a discovered container never opened, or opened so long ago
//                    that the measure expired. Cost: a walk plus one open.
//   3. LOCAL       — a storage block visible right now that the register does
//                    not know: discover it, then open it.
//   4. SWEEP       — nothing local and nothing remembered: a reconnaissance
//                    sweep is the only honest answer.
//
// Rungs 1-2 come from the register (memory), rung 3 from the live world, rung 4
// from the absence of both. Note what the ladder is *not*: it is not "open every
// chest". A caller that jumps to rung 4 while 1 or 2 could have answered is
// spending a reconnaissance pass to avoid a walk.
//
// Pure by design: rows come from `WorldMemory` (`containersWithItem`,
// `containersToInspect`) or from the live world, but this module never touches
// the world, the memory or the network — so the decision can be tested offline.

export const STORAGE_RUNG = Object.freeze({
  NONE: 0,
  KNOWN_ITEM: 1,
  INSPECT: 2,
  LOCAL: 3,
  SWEEP: 4,
});

export const STORAGE_STEP = Object.freeze({
  TAKE: 'take',
  INSPECT: 'inspect',
  REMEMBER: 'remember',
  SWEEP: 'sweep',
  NONE: 'none',
});

const distanceOf = (row, from) => {
  if (!from || !row?.position) return row?.distance ?? Infinity;
  const d = Math.hypot(
    (row.position.x ?? 0) - (from.x ?? 0),
    (row.position.y ?? 0) - (from.y ?? 0),
    (row.position.z ?? 0) - (from.z ?? 0),
  );
  return Number.isFinite(row.distance) ? Math.min(row.distance, d) : d;
};

const positionOf = (row) => {
  const p = row?.position;
  if (!p || typeof p.x !== 'number') return null;
  return { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
};

// `reachable === false` is the only thing that disqualifies a candidate, and it
// is the caller's job to know it (the memory does not do pathfinding).
const isUsable = (row) => row?.reachable !== false && positionOf(row) !== null;

const entry = (rung, step, row, { item = null, verify = false, count = null } = {}) => ({
  rung,
  step,
  item,
  id: row?.id ?? null,
  type: row?.type ?? null,
  position: positionOf(row),
  count,
  verify,
  stale: row?.contentsStale === true || row?.inspectionStale === true,
  discoveryStale: row?.discoveryStale === true,
  distance: Number.isFinite(row?.distance) ? row.distance : Infinity,
});

const byCost = (a, b) => {
  if (a.stale !== b.stale) return a.stale ? 1 : -1;   // fresh first
  if (a.distance !== b.distance) return a.distance - b.distance;
  return String(a.id ?? '').localeCompare(String(b.id ?? ''));
};

/**
 * Decide the next step of a container search.
 *
 * @param {object} input
 * @param {string} input.item            the item being searched for
 * @param {Array}  [input.known]         rows from `containersWithItem(item)`
 * @param {Array}  [input.toInspect]     rows from `containersToInspect()` (rung 2)
 * @param {Array}  [input.local]         storage blocks visible right now, unknown to the register
 * @param {boolean}[input.canSweep=true] whether a reconnaissance sweep is available at all
 * @param {boolean}[input.verifyStale=true] treat a stale *contents* memory as rung 1 with re-verification
 * @param {object} [input.from]          position the cost is measured from
 */
export function planStorageSearch ({
  item,
  known = [],
  toInspect = [],
  local = [],
  canSweep = true,
  verifyStale = true,
  from = null,
} = {}) {
  const blocked = [];

  const partition = (rows, build) => {
    const usable = [];
    for (const row of rows) {
      const built = build(row);
      if (!built) continue;
      if (isUsable(row)) usable.push({ ...built, distance: distanceOf(row, from) });
      else blocked.push({ ...built, distance: Infinity, reason: 'unreachable' });
    }
    return usable.sort(byCost);
  };

  // Rung 1 — the item is already believed to be somewhere. Fresh knowledge beats
  // stale knowledge; a stale row is still cheaper than opening an unknown chest,
  // but only if the caller is willing to verify on arrival.
  const knownRows = known.filter((row) => (row?.contents?.[item] ?? 0) > 0);
  const freshKnown = partition(knownRows.filter((row) => row.contentsStale !== true && row.inspectionStale !== true), (row) => entry(STORAGE_RUNG.KNOWN_ITEM, STORAGE_STEP.TAKE, row, { item, count: row.contents[item], verify: false }));
  const staleKnown = verifyStale
    ? partition(knownRows.filter((row) => row.contentsStale === true || row.inspectionStale === true), (row) => entry(STORAGE_RUNG.KNOWN_ITEM, STORAGE_STEP.TAKE, row, { item, count: row.contents[item], verify: true }))
    : [];

  // Rung 2 — the item may be behind a door that was never opened. A row with no
  // explicit `needsInspection` is still a candidate if its contents are unknown.
  const inspectRows = toInspect.filter((row) => row?.needsInspection !== false || row?.contentsKnown === false);
  const inspect = partition(inspectRows, (row) => entry(STORAGE_RUNG.INSPECT, STORAGE_STEP.INSPECT, row, { item, count: null }));

  // Rung 3 — a container is right here and the register does not know it.
  const localRows = local.filter((row) => row?.known !== true && row?.contentsKnown !== true);
  const nearby = partition(localRows, (row) => entry(STORAGE_RUNG.LOCAL, STORAGE_STEP.REMEMBER, row, { item, count: null }));

  const rung1 = [...freshKnown, ...staleKnown];
  const chosen = rung1[0] ?? inspect[0] ?? nearby[0] ?? null;
  const sweep = chosen
    ? null
    : (canSweep ? { rung: STORAGE_RUNG.SWEEP, step: STORAGE_STEP.SWEEP, item, position: null, verify: false, count: null, id: null, type: null, distance: Infinity } : null);

  const reason = chosen
    ? (chosen.rung === STORAGE_RUNG.KNOWN_ITEM
        ? (chosen.verify ? 'known_item_stale' : 'known_item')
        : chosen.rung === STORAGE_RUNG.INSPECT ? 'discovered_not_inspected' : 'local_scan')
    : sweep ? 'nothing_known_locally' : (blocked.length ? 'all_unreachable' : 'nothing_known');

  return {
    item,
    rung: (chosen ?? sweep)?.rung ?? STORAGE_RUNG.NONE,
    step: (chosen ?? sweep)?.step ?? STORAGE_STEP.NONE,
    target: chosen ?? null,
    // Every rung that was non-empty, so a caller (or a test) can see whether the
    // chosen rung was really the cheapest available.
    ladder: [
      { rung: STORAGE_RUNG.KNOWN_ITEM, available: rung1.length, step: STORAGE_STEP.TAKE },
      { rung: STORAGE_RUNG.INSPECT, available: inspect.length, step: STORAGE_STEP.INSPECT },
      { rung: STORAGE_RUNG.LOCAL, available: nearby.length, step: STORAGE_STEP.REMEMBER },
      { rung: STORAGE_RUNG.SWEEP, available: canSweep ? 1 : 0, step: STORAGE_STEP.SWEEP },
    ],
    blocked,
    reason,
  };
}
