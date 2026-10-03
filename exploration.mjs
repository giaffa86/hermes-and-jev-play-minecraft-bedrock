// Autonomous exploration M1 — deterministic planner (pure, no I/O, no LLM).
//
// Tre livelli (come da spec): LLM → questo planner deterministico → Jev →
// bounded action. Qui vive solo la parte deterministica: risolvere il target in
// un id Minecraft, generare la spirale quadrata sui chunk inesplorati, capire se
// il bioma è raggiunto, e produrre il report strutturato.
//
// La priorità è comportamento *deterministico, osservabile, riproducibile*, non
// un percorso ottimale.

export const MC_PREFIX = 'minecraft:';

// Alias naturali → id interno. Il target è SEMPRE un id Minecraft, mai testo.
const BIOME_ALIASES = {
  cherry_grove: ['cherry_grove', 'cherry grove', 'cherry biome', 'cherry blossom', 'bioma dei ciliegi', 'foresta di ciliegi', 'ciliegi'],
  pale_garden: ['pale_garden', 'pale garden', 'giardino pallido'],
  badlands: ['badlands', 'mesa', 'calanchi'],
  mushroom_fields: ['mushroom_fields', 'mushroom island', 'isola di funghi', 'funghi'],
  deep_dark: ['deep_dark', 'deep dark'],
  meadow: ['meadow', 'prato', 'prateria'],
};

export const SUPPORTED_BIOMES = Object.freeze(Object.keys(BIOME_ALIASES).map(id => `${MC_PREFIX}${id}`));

// 'minecraft:cherry_grove' / 'Cherry Grove' / 'cherry_grove' → 'cherry_grove'
export function normalizeBiome (name) {
  if (!name) return null;
  return String(name).replace(/^minecraft:/i, '').trim().toLowerCase();
}

// Testo naturale → 'minecraft:<id>' (o null se non riconosciuto).
export function resolveBiomeTarget (text) {
  if (!text) return null;
  const t = String(text).trim().toLowerCase();
  for (const [id, aliases] of Object.entries(BIOME_ALIASES)) {
    if (id === t || t === `${MC_PREFIX}${id}`) return `${MC_PREFIX}${id}`;
    if (aliases.some(a => t === a || t.includes(a))) return `${MC_PREFIX}${id}`;
  }
  return null;
}

export function biomeReached (currentBiome, targetBiome) {
  if (!currentBiome || !targetBiome) return false;
  return normalizeBiome(currentBiome) === normalizeBiome(targetBiome);
}

export function chunkKey (x, z) {
  return `${Math.floor(x / 16)},${Math.floor(z / 16)}`;
}

// Spirale quadrata deterministica: centro, poi anelli sempre più larghi
// (alto → destra → basso → sinistra). Offsets in unità di `spacing`.
export function spiralOffsets (maxRadius) {
  const out = [{ dx: 0, dz: 0 }];
  for (let ring = 1; ring <= maxRadius; ring++) {
    for (let x = -ring; x <= ring; x++) out.push({ dx: x, dz: -ring });
    for (let z = -ring + 1; z <= ring; z++) out.push({ dx: ring, dz: z });
    for (let x = ring - 1; x >= -ring; x--) out.push({ dx: x, dz: ring });
    for (let z = ring - 1; z >= -ring + 1; z--) out.push({ dx: -ring, dz: z });
  }
  return out;
}

// Prossimo waypoint: il PRIMO punto della spirale il cui chunk non è visitato.
// Segue l'ordine della spirale (sweep deterministico verso l'esterno); non
// ordina per distanza, altrimenti il percorso non sarebbe riproducibile.
// Null se la spirale è esaurita.
export function nextExplorationWaypoint ({ origin, visited = [], spacing = 96, maxRadius = 24 } = {}) {
  if (!origin) return null;
  const visitedSet = visited instanceof Set ? visited : new Set(visited);
  for (const o of spiralOffsets(maxRadius)) {
    const point = { x: Math.round(origin.x + o.dx * spacing), z: Math.round(origin.z + o.dz * spacing) };
    if (!visitedSet.has(chunkKey(point.x, point.z))) return point;
  }
  return null;
}

// Report strutturato M1 (Hermes lo trasforma in linguaggio naturale).
export function buildExplorationReport ({ mission = null, checkpoints = [], currentPosition = null, biome = null, now = Date.now() } = {}) {
  const origin = mission?.origin ?? null;
  const target = mission?.targetPosition ?? currentPosition ?? null;
  const distanceFromOrigin = origin && target
    ? +Math.hypot(target.x - origin.x, target.z - origin.z).toFixed(1)
    : null;
  const points = (origin ? [origin] : []).concat(checkpoints.map(c => c.position));
  let distanceTravelled = 0;
  for (let i = 1; i < points.length; i++) {
    distanceTravelled += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  }
  return {
    missionId: mission?.id ?? null,
    target: mission?.target ?? null,
    status: mission?.state ?? null,
    biome: normalizeBiome(biome),
    origin,
    targetPosition: target,
    distanceFromOrigin,
    distanceTravelled: +distanceTravelled.toFixed(1),
    chunksVisited: checkpoints.length,
    durationSeconds: mission?.startedAt ? Math.round((now - mission.startedAt) / 1000) : null,
  };
}

// Un passo della missione, puro: dato lo stato corrente, cosa fare dopo.
// Ritorna { action: 'move', waypoint } | { action: 'found', report } | { action: 'hold' } | { action: 'exhausted' }.
export function planExplorationStep ({ mission, currentPosition, currentBiome, visited = [], spacing, maxRadius } = {}) {
  if (!mission) return { action: 'hold', reason: 'no_mission' };
  if (biomeReached(currentBiome, mission.target)) {
    // `found: true` esplicito: chiudere una missione è un atto che dichiara
    // successo, quindi il report deve portare la prova, non lasciarla implicita.
    return { action: 'found', report: { ...buildExplorationReport({ mission, currentPosition, biome: currentBiome }), found: true } };
  }
  if (mission.state !== 'running') return { action: 'hold', reason: mission.state };
  const waypoint = nextExplorationWaypoint({ origin: mission.origin, visited, spacing, maxRadius });
  if (!waypoint) return { action: 'exhausted' };
  return { action: 'move', waypoint };
}

// ---- M2: route replay -------------------------------------------------------------
//
// "Torna al <posto già scoperto>": si rigioca una rotta *registrata* (i
// checkpoint di una missione) oppure si punta a un posto del world graph
// (landmark, home, resource site). Le tappe sono **guide**, non un percorso
// obbligato: il pathfinding locale rifà il tragitto tra una tappa e l'altra e
// può trovarne uno migliore. Le funzioni qui sotto sono pure: dato il percorso
// e la posizione corrente, qual è il prossimo passo.

const round2 = (p) => ({ x: Math.round(p.x * 10) / 10, y: p.y == null ? p.y : Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 });
const distance2d = (a, b) => +Math.hypot(a.x - b.x, a.z - b.z).toFixed(1);

// Rotta registrata di una missione: destinazione = dove è stata trovata la cosa
// (targetPosition), altrimenti l'ultima tappa, altrimenti la posizione iniziale.
// Le tappe coincidenti con la destinazione non servono come guida e vengono tolte.
export function replayRouteFromMission (mission, checkpoints = []) {
  if (!mission) return null;
  const ordered = (checkpoints ?? [])
    .filter(c => c?.position)
    .slice()
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const last = ordered[ordered.length - 1] ?? null;
  const destination = mission.targetPosition ?? last?.position ?? mission.position ?? mission.origin ?? null;
  if (!destination) return null;
  return {
    source: 'mission',
    missionId: mission.id,
    label: mission.target ?? mission.intent ?? mission.id,
    destination: round2(destination),
    checkpoints: ordered.filter(c => distance2d(c.position, destination) > 1).map(c => ({ id: c.id, seq: c.seq ?? 0, position: round2(c.position) })),
  };
}

// Rotta verso un posto del world graph (landmark/home/resource site/container).
export function replayRouteFromPlace (record) {
  if (!record?.position) return null;
  return {
    source: 'place',
    id: record.id,
    label: record.label ?? record.type ?? record.id,
    destination: round2(record.position),
    checkpoints: [],
  };
}

// Un passo del replay: 'move' (verso la prossima tappa utile o la destinazione)
// oppure 'arrived' entro `arrivedRadius`. Una tappa è "utile" solo se ci avvicina
// alla destinazione (le tappe alle spalle, cioè più lontane di noi, si saltano).
export function planReplayStep ({ route, currentPosition, arrivedRadius = 6, viaRadius = 4 } = {}) {
  if (!route?.destination) return { action: 'hold', reason: 'no_destination' };
  if (!currentPosition) return { action: 'hold', reason: 'no_position' };
  const remaining = distance2d(currentPosition, route.destination);
  if (remaining <= arrivedRadius) return { action: 'arrived', destination: route.destination, remaining };
  const legs = (route.checkpoints ?? []).filter(c => c?.position);
  const ahead = legs.filter(c => distance2d(c.position, route.destination) <= remaining - viaRadius);
  const leg = ahead[0] ?? null;
  const target = leg ? leg.position : route.destination;
  return {
    action: 'move',
    waypoint: { x: target.x, z: target.z },
    via: leg?.id ?? null,
    remaining,
    legs: legs.length,
    legsAhead: ahead.length,
  };
}

// Report strutturato del replay arrivato (il gemello di buildExplorationReport).
export function buildReplayReport ({ route = null, mission = null, currentPosition = null, now = Date.now() } = {}) {
  const origin = mission?.origin ?? null;
  const destination = route?.destination ?? null;
  return {
    missionId: mission?.id ?? null,
    arrived: true,
    replayOf: route?.missionId ?? route?.id ?? null,
    label: route?.label ?? null,
    destination,
    origin,
    distanceFromOrigin: origin && destination ? distance2d(origin, destination) : null,
    stopPosition: currentPosition ? round2(currentPosition) : null,
    durationSeconds: mission?.startedAt ? Math.round((now - mission.startedAt) / 1000) : null,
  };
}
