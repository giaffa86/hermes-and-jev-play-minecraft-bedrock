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

// ---- Gradino 4: una passata bounded attorno a un anchor -----------------------------
//
// Il planner M1 sa dire qual è il prossimo chunk inesplorato; una *passata* (sweep)
// è la stessa spirale con due cose in più: un limite geometrico **ancorato** e dei
// budget. Fuori da qui restano di proposito il tempo di esecuzione (lo misura chi
// cammina) e la posizione del bot: la causa di stop è funzione di
// (anchor, visited, config), quindi la stessa passata si riproduce dopo un reload.
export const SWEEP_STOP = Object.freeze({
  CELLS: 'cells',         // budget di esplorazione esaurito
  RADIUS: 'radius',       // bordo geometrico raggiunto: c'è ancora lavoro oltre
  EXHAUSTED: 'exhausted', // nessuna cella non visitata: il censimento è completo
});

export function planExplorationSweep ({ anchor = null, visited = [], spacing = 96, maxRadius = 24, cells = null, radius = null } = {}) {
  const config = { spacing, maxRadius, cells, radius };
  if (!anchor) {
    return { ok: false, error: 'no_anchor', anchor: null, config, waypoints: [], next: null, planned: 0, truncated: false, stoppedBy: null, boundary: null, remaining: null, complete: false };
  }
  const seen = visited instanceof Set ? visited : new Set(visited);
  const waypoints = [];
  let pendingBeyond = 0;
  let truncated = false;
  let stoppedBy = SWEEP_STOP.EXHAUSTED;
  for (const o of spiralOffsets(maxRadius)) {
    const point = { x: Math.round(anchor.x + o.dx * spacing), z: Math.round(anchor.z + o.dz * spacing) };
    if (seen.has(chunkKey(point.x, point.z))) continue;
    // Distanza planare dall'anchor: condizione geometrica pura. Mai la posizione
    // del bot, che renderebbe la stessa passata diversa da un riavvio all'altro.
    const distance = Math.hypot(point.x - anchor.x, point.z - anchor.z);
    if (radius !== null && distance > radius) { pendingBeyond++; continue; }
    if (cells !== null && waypoints.length >= cells) { truncated = true; stoppedBy = SWEEP_STOP.CELLS; break; }
    waypoints.push({ ...point, distance: Math.round(distance * 100) / 100 });
  }
  if (!truncated && pendingBeyond > 0) { truncated = true; stoppedBy = SWEEP_STOP.RADIUS; }
  return {
    ok: true,
    anchor: { ...anchor },
    config,
    waypoints,
    next: waypoints[0] ?? null,
    planned: waypoints.length,
    truncated,
    stoppedBy,
    // Il censimento può essere completo *dentro* il raggio e comunque troncato:
    // `pendingBeyond` è il lavoro non visitato che resta fuori dal bordo.
    boundary: radius !== null ? { limit: SWEEP_STOP.RADIUS, maxDistance: radius, pendingBeyond } : null,
    remaining: cells !== null ? Math.max(0, cells - waypoints.length) : null,
    complete: !truncated,
  };
}

// ---- M4: observable targets (blocks / entities) ------------------------------------
//
// Cercare un *oggetto osservabile* è la stessa missione dell'M1 con un target
// diverso: la scansione guarda ciò che il bot vede (i chunk caricati), il
// movimento riusa la spirale, il target resta un id Minecraft. Un blocco/entità
// trovato chiude la missione con un report (EXPLORE → SCAN → MATCH → REPORT).

const SEARCH_ENTITIES = new Set(['cow', 'mooshroom', 'sheep', 'pig', 'chicken', 'horse', 'donkey', 'mule', 'wolf', 'cat', 'ocelot', 'villager', 'wandering_trader', 'bee', 'parrot', 'llama', 'turtle', 'fox', 'rabbit', 'panda', 'polar_bear', 'axolotl', 'dolphin', 'squid', 'glow_squid', 'allay', 'frog', 'camel', 'sniffer', 'armadillo']);

// Alias naturali → id Minecraft. Un target esplicito `block:<name>` /
// `entity:<name>` bypassa la tabella (il bot può cercare qualsiasi cosa).
const SEARCH_ALIASES = {
  brown_mushroom: ['brown mushroom', 'funghi marroni', 'fungo marrone'],
  red_mushroom: ['red mushroom', 'funghi rossi', 'fungo rosso'],
  pumpkin: ['pumpkin', 'zucca', 'zucche'],
  bamboo: ['bamboo', 'bambù'],
  mangrove_log: ['mangrove', 'mangrovia', 'mangrove tree', 'tronco di mangrovia'],
  sugar_cane: ['sugar cane', 'canna da zucchero'],
  sweet_berry_bush: ['sweet berries', 'bacche dolci'],
  melon: ['melon', 'anguria', 'cocomero'],
  cactus: ['cactus', 'cacti'],
  vine: ['vine', 'liane'],
  lily_pad: ['lily pad', 'ninfea'],
  cocoa: ['cocoa', 'cacao'],
  cow: ['cow', 'mucca', 'mucche'],
  sheep: ['sheep', 'pecora', 'pecore'],
  pig: ['pig', 'maiale', 'maiali'],
  chicken: ['chicken', 'gallina', 'galline'],
  horse: ['horse', 'cavallo', 'cavalli'],
  donkey: ['donkey', 'asino', 'asini'],
  villager: ['villager', 'villaggio abitante', 'abitante'],
  wolf: ['wolf', 'lupo', 'lupi'],
  cat: ['cat', 'gatto', 'gatti'],
  bee: ['bee', 'ape', 'api'],
};

// Strutture riconosciute euristicamente (spec M5/M6): non sono nomi di blocco,
// quindi la ricerca le risolve a `structure:<tipo>` e la scansione interroga il
// detector (`structures.mjs`) e la memoria invece della palette.
const SEARCH_STRUCTURES = {
  village: ['village', 'villages', 'villaggio', 'villaggi'],
  mineshaft: ['mineshaft', 'miniera', 'miniera abbandonata'],
  ancient_city: ['ancient city', 'città antica', 'citta antica', 'deep dark'],
  trial_chamber: ['trial chamber', 'camera delle prove', 'camera dei trial'],
  spawner: ['spawner', 'spawner dei mostri', 'monster spawner'],
  nether_fortress: ['fortress', 'nether fortress', 'fortezza', 'fortezza del nether', 'fortezza nether'],
  amethyst_geode: ['geode', 'geode di ametista', 'amethyst geode'],
  cave: ['cave', 'caverna', 'caverne', 'grotta', 'grotte'],
};

const aliasEntries = Object.entries(SEARCH_ALIASES);
const structureEntries = Object.entries(SEARCH_STRUCTURES);

// Confine di parola, non sottostringa: "canna da zucchero" non deve combaciare
// con l'alias "zucche" di pumpkin.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const matchesAlias = (text, alias) => text === alias || new RegExp(`(^|\\W)${escapeRe(alias)}(\\W|$)`).test(text);

// Testo naturale (o `block:`/`entity:`) → { kind, name, id } oppure null.
export function resolveSearchTarget (text) {
  if (!text) return null;
  const raw = String(text).trim().toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, ' ');
  const explicit = /^(block|entity):(.+)$/.exec(raw);
  if (explicit) {
    const name = explicit[2].trim();
    return name ? { kind: explicit[1], name, id: `${MC_PREFIX}${name}` } : null;
  }
  for (const [name, aliases] of structureEntries) {
    if (name === raw || aliases.some(a => matchesAlias(raw, a))) return { kind: 'structure', name, id: `structure:${name}` };
  }
  for (const [name, aliases] of aliasEntries) {
    if (name === raw || aliases.some(a => matchesAlias(raw, a))) {
      return { kind: SEARCH_ENTITIES.has(name) ? 'entity' : 'block', name, id: `${MC_PREFIX}${name}` };
    }
  }
  return null;
}

export const SUPPORTED_SEARCH_TARGETS = Object.freeze([
  ...aliasEntries.map(([name]) => `${MC_PREFIX}${name}`),
  ...structureEntries.map(([name]) => `structure:${name}`),
]);

// Report di un target trovato: chi ha trovato cosa, dove e (se possibile) quanto
// dista. `matches` è già ordinato per distanza dal chiamante.
// Il tipo del target nel report: la ricerca di strutture non è una ricerca di
// blocchi, e dirlo "block" era un'etichetta sbagliata (visto dal vivo).
const REPORT_KINDS = { find_entity: 'entity', find_structure: 'structure' };

export function buildSearchReport ({ mission = null, matches = [], scannedChunks = null, now = Date.now() } = {}) {
  const origin = mission?.origin ?? null;
  const best = matches[0] ?? null;
  const kind = REPORT_KINDS[mission?.type] ?? 'block';
  return {
    missionId: mission?.id ?? null,
    target: mission?.target ?? null,
    kind,
    found: true,
    count: matches.length,
    best: best ? { name: best.name ?? null, position: best.position ?? null, distance: best.distance ?? null } : null,
    matches: matches.slice(0, 5).map(m => ({ name: m.name ?? null, position: m.position ?? null, distance: m.distance ?? null })),
    origin,
    distanceFromOrigin: origin && best?.position ? distance2d(origin, best.position) : null,
    scannedChunks,
    durationSeconds: mission?.startedAt ? Math.round((now - mission.startedAt) / 1000) : null,
  };
}

// Un passo della ricerca: se la scansione ha già trovato qualcosa si chiude con
// il report, altrimenti si esplora come nell'M1 (stessa spirale, stessa
// determinismo) e si riscansiona al prossimo passo.
export function planSearchStep ({ mission, matches = [], currentPosition, currentBiome = null, visited = [], spacing, maxRadius, scannedChunks = null } = {}) {
  if (!mission) return { action: 'hold', reason: 'no_mission' };
  if (matches.length > 0) return { action: 'report', report: buildSearchReport({ mission, matches, scannedChunks }) };
  return planExplorationStep({ mission, currentPosition, currentBiome, visited, spacing, maxRadius });
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
