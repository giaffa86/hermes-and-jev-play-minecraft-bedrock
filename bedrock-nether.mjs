// Consapevolezza Nether/End (milestone N0 di docs/wiki/nether.md): portali,
// pericoli del Nether e due sensi che il bot non aveva — proiettili in arrivo e
// sguardo dell'enderman.
//
// Modulo puro, senza I/O: come bedrock-fluids.mjs e bedrock-redstone.mjs il
// vocabolario è chiuso e ogni grandezza non misurabile resta `null` invece di
// essere indovinata. Un proiettile di cui non si conosce la velocità *non* è un
// proiettile in arrivo; un enderman con yaw/pitch ignoti non è un enderman
// guardato. Mai un allarme inventato.

export const NETHER_DIMENSION = 'nether';
export const END_DIMENSION = 'the_end';

// Blocchi-portale e il loro significato: `portal` è il Nether, `end_portal`
// (e il gateway) portano all'End, `end_portal_frame` è il *telaio* del portale
// dell'End (la struttura da riempire con gli occhi di ender).
const PORTAL_KINDS = {
  portal: 'nether',
  end_portal: 'end',
  end_gateway: 'end',
  end_portal_frame: 'frame',
};

// Celle che nel Nether bruciano o fanno male. La lava è già coperta dai fluidi
// (M0): qui resta elencata per il verdetto di pericolo, non per la fuga.
const HAZARD_KINDS = {
  fire: 'fire',
  soul_fire: 'fire',
  magma: 'magma',
  magma_block: 'magma',
  lava: 'lava',
  flowing_lava: 'lava',
};

const FIRE_BLOCKS = new Set(['fire', 'soul_fire']);
const SPAWNER_BLOCKS = new Set(['mob_spawner', 'monster_spawner', 'spawner']);

// Entità che volano: la loro traiettoria va seguita, non solo la posizione.
export const PROJECTILE_TYPES = new Set([
  'fireball', 'small_fireball', 'dragon_fireball', 'wither_skull',
  'wither_skull_dangerous', 'arrow', 'thrown_trident', 'snowball', 'egg',
  'ender_pearl', 'llama_spit', 'shulker_bullet', 'splash_potion',
  'lingering_potion', 'xp_bottle', 'fishing_hook', 'firework_rocket',
  'wind_charge', 'breeze_wind_charge', 'evoker_fang',
]);

const ENDERMAN_TYPES = new Set(['enderman']);

// Raggio entro cui un proiettile conta come minaccia e orizzonte temporale
// dell'impatto stimato: oltre, non è più "in arrivo" (e non vale una fuga).
export const PROJECTILE_RADIUS = 1.5;
export const PROJECTILE_HORIZON_MS = 4000;
export const PROJECTILE_SAMPLE_MAX_AGE_MS = 2000;

// Raggio e tetto del censimento di portali/pericoli: come per i fluidi, `/observe`
// è una rotta calda e il censimento ha un TTL suo.
export const DEFAULT_NETHER_RADIUS = 32;
export const DEFAULT_NETHER_LIMIT = 64;

// Geometria dello sguardo: gli occhi dell'enderman stanno sopra la testa del
// mob; guardarli (non solo "averlo in vista") è ciò che lo fa arrabbiare.
export const ENDERMAN_EYE_HEIGHT = 2.55;
export const ENDERMAN_GAZE_RANGE = 16;
export const ENDERMAN_GAZE_TOLERANCE_DEG = 8;

export function normalizeNetherName (name) {
  return String(name ?? '').replace(/^minecraft:/i, '').toLowerCase();
}

// 'nether' | 'end' | 'frame' | null
export function portalKind (name) {
  return PORTAL_KINDS[normalizeNetherName(name)] ?? null;
}

// 'fire' | 'magma' | 'lava' | null
export function hazardKind (name) {
  return HAZARD_KINDS[normalizeNetherName(name)] ?? null;
}

export function isFireBlock (name) {
  return FIRE_BLOCKS.has(normalizeNetherName(name));
}

export function isSpawnerBlock (name) {
  return SPAWNER_BLOCKS.has(normalizeNetherName(name));
}

export function isProjectileType (type) {
  // Gli identificatori di entità arrivano namespaced (`minecraft:arrow`): la
  // stessa normalizzazione dei blocchi vale anche qui.
  return PROJECTILE_TYPES.has(normalizeNetherName(type));
}

export function isEndermanType (type) {
  return ENDERMAN_TYPES.has(normalizeNetherName(type));
}

export function normalizeDimension (dimension) {
  return String(dimension ?? '').replace(/^minecraft:/i, '').toLowerCase();
}

export function isNetherDimension (dimension) {
  return normalizeDimension(dimension) === NETHER_DIMENSION;
}

export function isEndDimension (dimension) {
  return normalizeDimension(dimension) === END_DIMENSION;
}

// Nether e End condividono le due regole che cambiano la sopravvivenza: l'acqua
// evapora (niente MLG, niente secchi) e i letti esplodono.
export function isNetherLike (dimension) {
  return isNetherDimension(dimension) || isEndDimension(dimension);
}

export function waterEvaporates (dimension) {
  return isNetherLike(dimension);
}

export function bedsExplode (dimension) {
  return isNetherLike(dimension);
}

function distance3d (a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function nearestOf (rows, from) {
  let best = null;
  for (const row of rows) {
    const distance = from ? distance3d(row.position, from) : null;
    if (!best || (distance != null && (best.distance == null || distance < best.distance))) {
      best = { position: row.position, distance: distance == null ? null : +distance.toFixed(1) };
    }
  }
  return best;
}

// Censimento portali: quanti per tipo e qual è il più vicino. Un portale senza
// posizione non entra nel conteggio (nessuna geometria inventata).
export function summarizePortals (blocks = [], from = null) {
  const nether = [];
  const end = [];
  const frames = [];
  for (const block of blocks) {
    if (!block?.position) continue;
    const kind = portalKind(block.name);
    if (kind === 'nether') nether.push(block);
    else if (kind === 'end') end.push(block);
    else if (kind === 'frame') frames.push(block);
  }
  const netherNearest = nearestOf(nether, from);
  const endNearest = nearestOf(end, from);
  const frameNearest = nearestOf(frames, from);
  return {
    nether: { count: nether.length, nearest: netherNearest },
    end: { count: end.length, nearest: endNearest },
    frames: { count: frames.length, nearest: frameNearest },
    portalDistance: netherNearest?.distance ?? null,
    endPortalDistance: endNearest?.distance ?? null,
    endFrameDistance: frameNearest?.distance ?? null,
  };
}

// Censimento pericoli e spawner del Nether (fuoco, magma, spawner).
export function summarizeHazards (blocks = [], from = null) {
  const fire = [];
  const magma = [];
  const spawners = [];
  for (const block of blocks) {
    if (!block?.position) continue;
    const kind = hazardKind(block.name);
    if (kind === 'fire') fire.push(block);
    else if (kind === 'magma') magma.push(block);
    else if (isSpawnerBlock(block.name)) spawners.push(block);
  }
  const fireNearest = nearestOf(fire, from);
  const magmaNearest = nearestOf(magma, from);
  const spawnerNearest = nearestOf(spawners, from);
  return {
    fire: { count: fire.length, nearest: fireNearest },
    magma: { count: magma.length, nearest: magmaNearest },
    spawners: { count: spawners.length, nearest: spawnerNearest },
    fireDistance: fireNearest?.distance ?? null,
    magmaDistance: magmaNearest?.distance ?? null,
    spawnerDistance: spawnerNearest?.distance ?? null,
  };
}

function subtract (a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function magnitude (v) {
  return Math.hypot(v.x, v.y, v.z);
}

function dot (a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

// Minaccia di un singolo proiettile vista dal bot. La velocità arriva dal
// pacchetto se c'è, altrimenti si stima da due posizioni osservate; con una sola
// posizione la risposta onesta è `known: false` (nessuna traiettoria inventata).
// La velocità del proiettile: quella dichiarata se c'è, altrimenti stimata dai
// due campioni (posizione attuale + campione precedente). `null` quando non c'è
// modo di misurarla — una traiettoria ignota non si indovina.
export function projectileVelocity ({ position = null, velocity = null, previous = null, now = null } = {}) {
  if (velocity && Number.isFinite(velocity.x) && Number.isFinite(velocity.y) && Number.isFinite(velocity.z)) {
    return { velocity: { x: velocity.x, y: velocity.y, z: velocity.z }, source: 'velocity' };
  }
  if (!position || !previous?.position || !Number.isFinite(previous.at) || !Number.isFinite(now) || now <= previous.at) {
    return { velocity: null, source: null };
  }
  const dt = (now - previous.at) / 1000;
  if (dt <= 0 || dt > PROJECTILE_SAMPLE_MAX_AGE_MS / 1000) return { velocity: null, source: null };
  return {
    velocity: {
      x: (position.x - previous.position.x) / dt,
      y: (position.y - previous.position.y) / dt,
      z: (position.z - previous.position.z) / dt,
    },
    source: 'samples',
  };
}

export function projectileThreat ({
  from = null,
  position = null,
  velocity = null,
  previous = null,
  now = null,
  radius = PROJECTILE_RADIUS,
  horizonMs = PROJECTILE_HORIZON_MS,
} = {}) {
  const unknown = { known: false, incoming: null, missDistance: null, timeToImpactMs: null, speed: null, source: null };
  if (!from || !position) return unknown;
  const measured = projectileVelocity({ position, velocity, previous, now });
  const vel = measured.velocity;
  const source = measured.source;
  if (!vel) return unknown;

  const speed = magnitude(vel);
  const rel = subtract(from, position);
  const vv = dot(vel, vel);
  const base = {
    known: true,
    position: { ...position },
    distance: +magnitude(rel).toFixed(2),
    speed: +speed.toFixed(2),
    source,
  };
  if (vv <= 1e-6) {
    // Fermo: non sta arrivando addosso a nessuno.
    return { ...base, incoming: false, missDistance: +magnitude(rel).toFixed(2), timeToImpactMs: null };
  }
  const t = dot(rel, vel) / vv; // secondi al punto di massimo avvicinamento
  const closest = subtract(rel, { x: vel.x * t, y: vel.y * t, z: vel.z * t });
  const miss = magnitude(closest);
  const timeToImpactMs = t >= 0 ? Math.round(t * 1000) : null;
  const incoming = t >= 0 && miss <= radius && timeToImpactMs != null && timeToImpactMs <= horizonMs;
  return { ...base, incoming, missDistance: +miss.toFixed(2), timeToImpactMs };
}

// Il proiettile più urgente fra quelli percepiti: vince chi arriva prima.
export function projectileIncoming ({ projectiles = [], from = null, now = null, radius, horizonMs } = {}) {
  const threats = [];
  for (const projectile of projectiles) {
    if (!projectile?.position) continue;
    const threat = projectileThreat({
      from,
      position: projectile.position,
      velocity: projectile.velocity ?? null,
      previous: projectile.previous ?? null,
      now,
      radius,
      horizonMs,
    });
    if (threat.incoming) threats.push({ ...threat, type: projectile.type ?? null });
  }
  if (!threats.length) return null;
  threats.sort((a, b) => (a.timeToImpactMs - b.timeToImpactMs) || (a.missDistance - b.missDistance));
  return threats[0];
}

// Vettore di sguardo dal yaw/pitch Bedrock (yaw 0 = +z sud, 90 = -x ovest;
// pitch negativo verso l'alto), la stessa convenzione di `_lookAt` nell'adapter.
export function gazeVector ({ yaw = 0, pitch = 0 } = {}) {
  const y = (Number.isFinite(yaw) ? yaw : 0) * Math.PI / 180;
  const p = (Number.isFinite(pitch) ? pitch : 0) * Math.PI / 180;
  return { x: -Math.sin(y), y: -Math.sin(p), z: Math.cos(y) };
}

// Angolo (gradi) fra lo sguardo del bot e la direzione verso gli occhi di un
// bersaglio: `null` se la posizione o l'orientamento non sono noti.
export function gazeAngle ({ from = null, yaw = null, pitch = null, target = null, targetEyeHeight = 0 } = {}) {
  if (!from || !target || !Number.isFinite(yaw) || !Number.isFinite(pitch)) return null;
  const eyes = { x: target.x, y: target.y + targetEyeHeight, z: target.z };
  const to = subtract(eyes, from);
  const length = magnitude(to);
  if (length === 0) return 0;
  const dir = { x: to.x / length, y: to.y / length, z: to.z / length };
  const look = gazeVector({ yaw, pitch });
  const cos = Math.max(-1, Math.min(1, dot(look, dir)));
  return +(Math.acos(cos) * 180 / Math.PI).toFixed(2);
}

// Sta il bot guardando *gli occhi* di un enderman? Ritorna l'esemplare più vicino
// entro il raggio, con `gazed` true/false (o `null` se l'orientamento non è
// leggibile: in quel caso non si accusa nessuno).
export function gazedAtEnderman ({
  from = null,
  yaw = null,
  pitch = null,
  endermans = [],
  range = ENDERMAN_GAZE_RANGE,
  toleranceDeg = ENDERMAN_GAZE_TOLERANCE_DEG,
  targetEyeHeight = ENDERMAN_EYE_HEIGHT,
  protected: masked = false,
} = {}) {
  let best = null;
  for (const entity of endermans) {
    if (!entity?.position) continue;
    if (!isEndermanType(entity.type)) continue;
    const distance = distance3d(entity.position, from);
    if (!(distance <= range)) continue;
    const angleDeg = gazeAngle({ from, yaw, pitch, target: entity.position, targetEyeHeight });
    const aimingAtEyes = angleDeg == null ? null : angleDeg <= toleranceDeg;
    const row = {
      type: entity.type,
      position: { ...entity.position },
      distance: +distance.toFixed(1),
      angleDeg,
      // `aimingAtEyes` dice dove punta lo sguardo, `gazed` se l'enderman se ne
      // accorge: con una zucca in testa punta gli occhi ma non lo sveglia, e
      // sono due fatti diversi che il planner deve poter distinguere.
      aimingAtEyes,
      protected: !!masked,
      gazed: aimingAtEyes == null ? null : (aimingAtEyes && !masked),
    };
    if (!best || row.distance < best.distance) best = row;
  }
  // Un enderman più vicino ma con sguardo ignoto resta più rilevante di uno
  // lontano che si vede di striscio: si ordina per distanza, non per `gazed`.
  return best;
}

// --- N5: disciplina dello sguardo e maschera di zucca ------------------------
// Gli occhi dell'enderman stanno a 2.55 dal suolo; il corpo sta sotto. Colpire
// il corpo è l'unico modo di non incrociare lo sguardo per sbaglio, quindi la
// mira per un enderman non è "il centro della bounding box" ma un punto del
// torso scelto per stare sotto gli occhi.
export const ENDERMAN_TORSO_HEIGHT = 1.45;
export const ENDERMAN_AIM_TOLERANCE = 0.35;
export const PUMPKIN_MASKS = new Set(['carved_pumpkin', 'pumpkin']);
export const ENDER_PEARL = 'ender_pearl';

export function endermanAimPoint (position, targetHeight = ENDERMAN_TORSO_HEIGHT) {
  if (!position) return null;
  return { x: position.x, y: position.y + targetHeight, z: position.z };
}

// La mira è all'altezza degli occhi? `null` quando non si sa (nessuno dei due
// dati): in quel caso non si accusa nulla, come per `gazedAtEnderman`.
export function aimsAtEndermanEyes ({
  aimY = null,
  position = null,
  eyeHeight = ENDERMAN_EYE_HEIGHT,
  tolerance = ENDERMAN_AIM_TOLERANCE,
} = {}) {
  if (aimY == null || !position) return null;
  return Math.abs(aimY - (position.y + eyeHeight)) <= tolerance;
}

export function isPumpkinMask (name) {
  return PUMPKIN_MASKS.has(normalizeNetherName(name));
}

// La zucca in testa è l'unico modo di guardare un enderman restando ignorati:
// vale solo per l'elmo (il resto dell'armatura non conta).
export function pumpkinMaskWorn (armor = {}) {
  return isPumpkinMask(armor?.helmet);
}

export function isEnderPearl (name) {
  return normalizeNetherName(name) === ENDER_PEARL;
}

// Verdetto compatto sui pericoli propri del Nether. La lava resta nei fluidi:
// qui entra solo per completezza del censimento.
export function netherHazard ({
  dimension = null,
  inFire = false,
  fireDistance = null,
  magmaDistance = null,
  inLava = false,
} = {}) {
  if (isNetherLike(dimension) && inFire) return { level: 'critical', reasons: ['in_fire'] };
  if (inFire) return { level: 'critical', reasons: ['in_fire'] };
  if (fireDistance != null && fireDistance <= 2) return { level: 'critical', reasons: ['fire_adjacent'] };
  if (inLava) return { level: 'critical', reasons: ['in_lava'] };
  if (magmaDistance != null && magmaDistance <= 1.5) return { level: 'high', reasons: ['on_magma'] };
  if (fireDistance != null && fireDistance <= 5) return { level: 'high', reasons: ['fire_near'] };
  if (magmaDistance != null && magmaDistance <= 4) return { level: 'medium', reasons: ['magma_near'] };

  const reasons = [];
  if (fireDistance != null && fireDistance <= 10) reasons.push('fire_in_range');
  if (magmaDistance != null && magmaDistance <= 8) reasons.push('magma_in_range');
  if (!reasons.length) return { level: 'none', reasons: [] };
  return { level: 'low', reasons };
}

// --- N1: geometria del portale -------------------------------------------
// Un portale non è un blocco magico da trovare: è una cornice di ossidiana con
// un'interno d'aria che si accende con l'accendino. Qui c'è solo la geometria
// (pura): dove stanno le 14 celle della cornice, dove sta la cella da accendere
// e cosa manca perché il portale sia valido.
export const PORTAL_BLOCK = 'portal';
export const PORTAL_FRAME_BLOCK = 'obsidian';
export const PORTAL_IGNITER = 'flint_and_steel';
export const PORTAL_INTERIOR_WIDTH = 2;
export const PORTAL_INTERIOR_HEIGHT = 3;
// Gli angoli della cornice non servono al gioco: 14 = cornice completa,
// 10 = la stessa cornice senza i quattro angoli (entrambe valide).
export const PORTAL_FRAME_NEEDS_FULL = { obsidian: 14 };
export const PORTAL_FRAME_NEEDS_MINIMAL = { obsidian: 10 };
const PORTAL_REPLACEABLE = new Set(['air', 'cave_air', 'void_air', 'unknown']);

export function portalBlockName (name) {
  return normalizeNetherName(name);
}

// Cornice completa per un interno `interiorWidth` × `interiorHeight` il cui
// angolo in basso a sinistra (la cella interna dove il bot entra) è `origin`.
export function planPortalFrame ({
  origin = null,
  axis = 'x',
  withCorners = true,
  interiorWidth = PORTAL_INTERIOR_WIDTH,
  interiorHeight = PORTAL_INTERIOR_HEIGHT,
} = {}) {
  if (!origin || origin.x == null || origin.y == null || origin.z == null) return { ok: false, error: 'missing_origin' };
  if (axis !== 'x' && axis !== 'z') return { ok: false, error: `unknown_axis: ${axis}` };
  if (!(interiorWidth >= 2) || !(interiorHeight >= 3)) return { ok: false, error: 'interior_too_small' };
  const step = axis === 'x' ? { x: 1, z: 0 } : { x: 0, z: 1 };
  const interior = [];
  for (let dy = 0; dy < interiorHeight; dy++) {
    for (let d = 0; d < interiorWidth; d++) {
      interior.push({ x: origin.x + step.x * d, y: origin.y + dy, z: origin.z + step.z * d });
    }
  }
  const bottomY = origin.y - 1;
  const topY = origin.y + interiorHeight;
  const frame = [];
  const seen = new Set();
  const push = (position, corner = false) => {
    const key = `${position.x},${position.y},${position.z}`;
    if (seen.has(key)) return;
    seen.add(key);
    frame.push({ position, corner });
  };
  // Riga in basso e riga in alto: dall'angolo sinistro all'angolo destro.
  for (let d = -1; d <= interiorWidth; d++) {
    const corner = d === -1 || d === interiorWidth;
    push({ x: origin.x + step.x * d, y: bottomY, z: origin.z + step.z * d }, corner);
    push({ x: origin.x + step.x * d, y: topY, z: origin.z + step.z * d }, corner);
  }
  // Le due colonne laterali, interno escluso (le righe coprono gli angoli).
  for (let dy = 0; dy < interiorHeight; dy++) {
    push({ x: origin.x - step.x, y: origin.y + dy, z: origin.z - step.z });
    push({ x: origin.x + step.x * interiorWidth, y: origin.y + dy, z: origin.z + step.z * interiorWidth });
  }
  const kept = withCorners ? frame : frame.filter(cell => !cell.corner);
  const needs = withCorners ? PORTAL_FRAME_NEEDS_FULL : PORTAL_FRAME_NEEDS_MINIMAL;
  return {
    ok: true,
    axis,
    origin,
    withCorners,
    width: interiorWidth + 2,
    height: interiorHeight + 2,
    interior,
    frame: kept,
    // Per accendere si clicca la faccia superiore della cornice sotto la prima
    // colonna interna: è da lì che parte il blocco `portal`.
    ignition: { position: { x: origin.x, y: bottomY, z: origin.z }, face: 1, cell: { ...origin } },
    // La cella su cui il bot cammina per entrare: quella interna in basso.
    entry: { ...origin },
    needs: { ...needs },
    cells: [...kept.map(cell => cell.position), ...interior],
  };
}

// La cornice è valida? Ossidiana intorno, interno d'aria (o già accesa). Il
// verdetto su una cella illeggibile è "manca", non "va bene".
export function checkPortalFrame ({ frame = [], interior = [] } = {}, blockAt = () => null) {
  const nameOf = (position) => {
    const name = blockAt(position);
    return portalBlockName(name);
  };
  const missing = [];
  for (const cell of frame) {
    const name = nameOf(cell.position);
    if (name !== PORTAL_FRAME_BLOCK && name !== 'crying_obsidian') missing.push({ position: cell.position, name });
  }
  const blocked = [];
  let lit = false;
  for (const cell of interior) {
    const name = nameOf(cell);
    if (name === PORTAL_BLOCK) { lit = true; continue; }
    if (!PORTAL_REPLACEABLE.has(name)) blocked.push({ position: cell, name });
  }
  return {
    ok: missing.length === 0 && blocked.length === 0,
    lit,
    frame: { ok: missing.length === 0, missing },
    interior: { ok: blocked.length === 0, blocked },
  };
}

// Un cantiere libero per quella cornice? Le celle della cornice devono essere
// aria e le celle in basso devono avere un supporto solido sotto.
export function portalSiteBlocked (plan, blockAt = () => null) {
  if (!plan?.ok) return [{ reason: 'invalid_plan', name: plan?.error ?? null }];
  const blocked = [];
  const nameOf = (position) => portalBlockName(blockAt(position));
  // Una cella di appoggio che è essa stessa un passo del piano non è "senza
  // supporto": la si piazza prima (dal basso verso l'alto) e diventa il supporto.
  const planned = new Set(plan.frame.map(cell => `${cell.position.x},${cell.position.y},${cell.position.z}`));
  const bottomY = plan.origin.y - 1;
  for (const cell of plan.frame) {
    const name = nameOf(cell.position);
    if (!PORTAL_REPLACEABLE.has(name)) blocked.push({ position: cell.position, name, reason: 'occupied' });
    // Solo la riga in basso poggia sul terreno: le colonne poggiano sulla riga
    // in basso e la riga in alto è sostenuta dalle colonne (nessun blocco
    // fluttuante, nessun supporto inventato per l'interno).
    if (cell.position.y !== bottomY) continue;
    const base = { x: cell.position.x, y: cell.position.y - 1, z: cell.position.z };
    if (planned.has(`${base.x},${base.y},${base.z}`)) continue;
    const below = nameOf(base);
    if (PORTAL_REPLACEABLE.has(below)) blocked.push({ position: base, name: below, reason: 'no_support', for: cell.position });
  }
  for (const cell of plan.interior) {
    const name = nameOf(cell);
    if (!PORTAL_REPLACEABLE.has(name)) blocked.push({ position: cell, name, reason: 'occupied' });
  }
  return blocked;
}

// Un blocco di ossidiana visto nel mondo può essere l'inizio di *questa*
// cornice: da qui nascono i candidati, che vanno poi verificati con
// `checkPortalFrame` contro il mondo vero (nessuna geometria inventata).
export function portalFrameCandidates (blocks = [], {
  withCorners = true,
  interiorWidth = PORTAL_INTERIOR_WIDTH,
  interiorHeight = PORTAL_INTERIOR_HEIGHT,
} = {}) {
  const plans = [];
  const seen = new Set();
  for (const block of blocks) {
    const position = block?.position ?? block;
    if (!position || position.x == null) continue;
    for (const axis of ['x', 'z']) {
      for (const shift of [-1, 0, 1]) {
        const origin = axis === 'x'
          ? { x: position.x - shift, y: position.y + 1, z: position.z }
          : { x: position.x, y: position.y + 1, z: position.z - shift };
        const plan = planPortalFrame({ origin, axis, withCorners, interiorWidth, interiorHeight });
        if (!plan.ok) continue;
        const key = `${axis}|${origin.x},${origin.y},${origin.z}|${withCorners}`;
        if (seen.has(key)) continue;
        seen.add(key);
        plans.push(plan);
      }
    }
  }
  return plans;
}

// --- N2: sopravvivenza nel Nether ----------------------------------------
// Nel Nether cadono tre certezze dell'Overworld: l'acqua evapora (niente MLG,
// niente doccia salvavita dopo una caduta), il pavimento può essere magma o
// fuoco (atterrare fa danno anche se la cella è "calpestabile"), e i blocchi
// infiammabili che usiamo per il rifugio notturno diventano legna da ardere.
// Questi primitivi sono puri: il pathfinder e il builder li interrogano, ma la
// politica resta fuori dalla fisica.
export const LANDING_HAZARDS = {
  lava: 'lava',
  flowing_lava: 'lava',
  magma: 'magma',
  fire: 'fire',
  soul_fire: 'fire',
  cactus: 'cactus'
};
// Un atterraggio su una di queste celle è un danno certo (o peggio): non è mai
// una destinazione del pathfinding.
export function landingHazard (name) {
  const key = normalizeNetherName(name);
  if (!key) return null;
  return LANDING_HAZARDS[key] ?? null;
}
export function safeLanding (name) {
  return landingHazard(name) === null;
}

// Senza acqua per attutire, una caduta lunga è una condanna: nel Nether/End il
// pathfinder scende al massimo di due blocchi invece dei quattro dell'Overworld.
export const OVERWORLD_MAX_FALL = 4;
export const NETHER_LIKE_MAX_FALL = 2;
export function maxFallDepth (dimension) {
  return isNetherLike(dimension) ? NETHER_LIKE_MAX_FALL : OVERWORLD_MAX_FALL;
}

// Materiali da costruzione: nel Nether assi, tronchi e lana bruciano (e i ghast
// non aspettano). Il rifugio dev'essere di pietra, ciottoli, netherrack, ecc.
const FLAMMABLE_BLOCKS = new Set([
  'bamboo', 'bamboo_block', 'bamboo_planks', 'bamboo_mosaic', 'book_shelf', 'bookshelf',
  'crimson_stem', 'warped_stem', 'crimson_hyphae', 'warped_hyphae',
  'dead_bush', 'hay_block', 'scaffolding', 'target', 'vine', 'cave_vines',
  'wool', 'carpet', 'coal_block', 'dried_kelp_block', 'ladder', 'chest', 'trapped_chest',
  'bamboo_sapling', 'campfire', 'soul_campfire', 'torchflower', 'spore_blossom'
]);
export function isFlammableBlock (name) {
  const key = normalizeNetherName(name);
  if (!key) return false;
  if (FLAMMABLE_BLOCKS.has(key)) return true;
  return /_planks$|_log$|_wood$|_stem$|_hyphae$|_wool$|_sign$|_door$|_fence$|_fence_gate$|_slab$|_stairs$|_trapdoor$|_leaves$|_banner$|_carpet$|_button$|_pressure_plate$/.test(key);
}

// Il blocco da costruzione più abbondante che non prende fuoco. `owned` è una
// lista `{name, count}` (la forma dell'inventario appiattita): la scelta non
// guarda il tipo di materiale, guarda che non sia infiammabile.
export function pickHubBlock (owned = []) {
  const usable = (owned || [])
    .filter(entry => entry && entry.name && (entry.count || 0) > 0)
    .filter(entry => !isFlammableBlock(entry.name))
    .sort((a, b) => (b.count || 0) - (a.count || 0));
  return usable.length ? usable[0].name : null;
}

// Geometria del rifugio: quattro pareti di due blocchi intorno al bot più la
// corona del tetto. È la stessa forma del `build_hut` dell'Overworld — un
// rifugio è un rifugio, cambia solo il materiale — e sta qui perché il Nether
// deve poterla ispezionare senza toccare l'adapter.
export function shellCells (feet, { roofCenter = false } = {}) {
  const cells = [];
  if (!feet || feet.x == null || feet.y == null || feet.z == null) return cells;
  const bx = Math.floor(feet.x), bz = Math.floor(feet.z), by = Math.floor(feet.y + 0.1);
  const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dz] of sides) {
    const x = bx + dx, z = bz + dz;
    cells.push({ label: 'wall_feet', position: { x, y: by, z }, support: { x, y: by - 1, z } });
  }
  for (const [dx, dz] of sides) {
    const x = bx + dx, z = bz + dz;
    cells.push({ label: 'wall_head', position: { x, y: by + 1, z }, support: { x, y: by, z } });
  }
  for (const [dx, dz] of sides) {
    const x = bx + dx, z = bz + dz;
    cells.push({ label: 'roof', position: { x, y: by + 2, z }, support: { x, y: by + 1, z } });
  }
  if (roofCenter) {
    cells.push({ label: 'roof_center', position: { x: bx, y: by + 2, z: bz }, support: null });
  }
  return cells;
}

// Un hub nel Nether è il rifugio sopra il punto in cui siamo arrivati: pareti e
// tetto chiusi (un ghast spara dall'alto) e una cella d'appoggio ricordata in
// memoria come `home`, così il bot ha un posto dove rientrare.
export function netherHubPlan ({ feet = null, roofCenter = false, block = null } = {}) {
  const cells = shellCells(feet, { roofCenter });
  if (!cells.length) return { ok: false, error: 'missing_feet' };
  return {
    ok: true,
    origin: { x: Math.floor(feet.x), y: Math.floor(feet.y + 0.1), z: Math.floor(feet.z) },
    block,
    roofCenter,
    cells,
    needs: block ? { [block]: cells.length } : {}
  };
}

// --- N3: la schivata -------------------------------------------------------
// Un fireball non si evita correndo "via": si evita uscendo dalla linea di
// tiro. Il vettore utile è quindi la *perpendicolare* alla traiettoria, non
// l'opposto del proiettile — e la destinazione deve restare un posto dove si
// può stare (mai dentro o a ridosso della lava, che per un ghast è il modo più
// comune di morire scappando).

export const DODGE_DISTANCE = 3;
export const DODGE_LINE_MARGIN = 0.5;

// La retta di tiro in pianta: la velocità quando è nota, altrimenti la
// congiungente proiettile→bot. Senza nessuna delle due non c'è una direzione da
// cui uscire e `perpendicularDirs` non inventa niente.
function trajectory ({ from = null, projectile = null } = {}) {
  const origin = projectile?.position ?? from ?? null;
  let dx = projectile?.velocity?.x ?? 0;
  let dz = projectile?.velocity?.z ?? 0;
  if (Math.abs(dx) < 1e-3 && Math.abs(dz) < 1e-3) {
    if (!origin || !from) return null;
    dx = from.x - origin.x;
    dz = from.z - origin.z;
  }
  const length = Math.hypot(dx, dz);
  if (!length) return null;
  return { origin, dir: { x: dx / length, z: dz / length } };
}

// Le due perpendicolari orizzontali (lati opposti) della traiettoria: i due
// modi sensati di uscire dalla linea di tiro.
export function perpendicularDirs ({ from = null, projectile = null } = {}) {
  const line = trajectory({ from, projectile });
  if (!line) return [];
  // `|| 0` evita lo zero negativo (`-0`), che è un valore diverso in un confronto
  // stretto senza essere un'informazione diversa.
  return [{ x: -line.dir.z || 0, z: line.dir.x || 0 }, { x: line.dir.z || 0, z: -line.dir.x || 0 }];
}

// Quanto un punto sta *di lato* rispetto alla linea di tiro (distanza della
// retta, in pianta): è la grandezza che dice se la schivata serve a qualcosa.
export function lateralOffset ({ point = null, from = null, projectile = null } = {}) {
  const line = trajectory({ from, projectile });
  if (!line || !point) return 0;
  return Math.abs((point.x - line.origin.x) * line.dir.z - (point.z - line.origin.z) * line.dir.x);
}

// Uscire dalla linea significa aumentare la distanza laterale: uno spostamento
// *lungo* la traiettoria (incontro o inseguimento) non cambia niente.
export function breaksLine ({ from = null, candidate = null, projectile = null, margin = DODGE_LINE_MARGIN } = {}) {
  if (!candidate) return false;
  return lateralOffset({ point: candidate, from, projectile }) >
    lateralOffset({ point: from, from, projectile }) + margin;
}

// Le celle candidate: entrambi i lati, alle distanze richieste, alla quota dei
// piedi, ordinate per distanza laterale decrescente (la più "fuori linea" per
// prima). La colonna del bot non è una candidata: non è una schivata.
export function dodgeCandidates ({ from = null, projectile = null, distances = [DODGE_DISTANCE] } = {}) {
  if (!from || !Number.isFinite(from.x) || !Number.isFinite(from.y) || !Number.isFinite(from.z)) return [];
  const here = { x: Math.floor(from.x), z: Math.floor(from.z) };
  const seen = new Set();
  const cells = [];
  for (const dir of perpendicularDirs({ from, projectile })) {
    for (const distance of distances) {
      const cell = {
        x: Math.floor(from.x + dir.x * distance),
        y: Math.floor(from.y + 0.1),
        z: Math.floor(from.z + dir.z * distance),
      };
      const key = `${cell.x},${cell.y},${cell.z}`;
      if (seen.has(key) || (cell.x === here.x && cell.z === here.z)) continue;
      seen.add(key);
      cells.push({ ...cell, distance, lateral: +lateralOffset({ point: cell, from, projectile }).toFixed(2) });
    }
  }
  return cells.sort((a, b) => b.lateral - a.lateral);
}

// --- N4: i piglin ----------------------------------------------------------
// Il bartering è l'unico modo ragionevole di ottenere perle e blaze rod senza
// combattere, e ha due regole non negoziabili: si paga con un lingotto d'oro
// (in mano, mai un colpo) e con un piglin **adulto**; un bruto non baratta, e
// un colpo a un piglin lo rende ostile per sempre.

export const PIGLIN_TYPES = new Set(['piglin', 'piglin_brute']);
export const PIGLIN_BRUTE = 'piglin_brute';
export const PIGLIN_BARTER_TYPE = 'piglin';
export const BARTER_INGOT = 'gold_ingot';
export const BARTER_RANGE = 16;

// Qualsiasi pezzo d'oro addosso rende i piglin neutrali (Bedrock): è la ragione
// per cui `barter_piglin` non richiede l'armatura, ma la *riporta*.
export const GOLD_ARMOR_PIECES = ['golden_helmet', 'golden_chestplate', 'golden_leggings', 'golden_boots'];

export function isPiglinType (type) {
  const name = normalizeNetherName(type);
  return name != null && PIGLIN_TYPES.has(name);
}

export function isBarterPayment (name) {
  return normalizeNetherName(name) === BARTER_INGOT;
}

export function isGoldArmorPiece (name) {
  const normalized = normalizeNetherName(name);
  return normalized != null && GOLD_ARMOR_PIECES.includes(normalized);
}

export function goldArmorWorn (worn = []) {
  return (worn ?? []).filter(isGoldArmorPiece);
}

// Con un pezzo d'oro addosso un piglin è neutrale; senza, resta un estraneo
// armato (non attacca da solo, ma non lo si vuole provocare).
export function piglinNeutral ({ worn = [] } = {}) {
  return goldArmorWorn(worn).length > 0;
}

// Il bottino del bartering (loot table Bedrock), tenuto come *riferimento per il
// resoconto*: la conferma di un bartering è "un drop nuovo vicino al piglin",
// non l'appartenenza a questa lista — così una versione futura del gioco non
// trasforma la verifica in un falso negativo.
export const BARTER_REWARDS = new Set([
  'ender_pearl', 'string', 'fire_charge', 'gravel', 'leather', 'soul_sand',
  'nether_brick', 'obsidian', 'crying_obsidian', 'arrow', 'spectral_arrow',
  'book', 'enchanted_book', 'iron_boots', 'potion', 'splash_potion', 'pufferfish',
]);

export function isBarterReward (name) {
  const normalized = normalizeNetherName(name);
  return normalized != null && BARTER_REWARDS.has(normalized);
}

// Il piglin giusto per un bartering: il più vicino fra gli adulti **non bruti**
// entro il raggio, più il piglin più vicino in assoluto (per poter dire *perché*
// non si baratta: un bruto o un cucciolo non scambiano mai).
export function barterTarget ({ piglins = [], from = null, range = BARTER_RANGE } = {}) {
  if (!from) return { target: null, nearest: null };
  let target = null;
  let nearest = null;
  for (const piglin of piglins) {
    if (!piglin?.position) continue;
    // Il nome resta quello di arrivo (per il resoconto), la classificazione usa
    // la forma normalizzata; i campi extra della riga (per esempio il runtime id
    // con cui l'adapter ritrova l'entità) viaggiano con essa.
    const type = piglin.type;
    if (!isPiglinType(type)) continue;
    const distance = Math.hypot(piglin.position.x - from.x, piglin.position.y - from.y, piglin.position.z - from.z);
    if (distance > range) continue;
    const row = { ...piglin, type, position: { ...piglin.position }, baby: !!piglin.baby, brute: normalizeNetherName(type) === PIGLIN_BRUTE, distance: +distance.toFixed(2) };
    if (!nearest || row.distance < nearest.distance) nearest = row;
    if (row.brute || row.baby) continue;
    if (!target || row.distance < target.distance) target = row;
  }
  return { target, nearest };
}

// --- N6: fortezza e blaze ---------------------------------------------------
//
// Il blaze è l'ostile del Nether che spara: la linea retta è la cosa che fa più
// male, quindi la tattica è *spezzare la linea, poi chiudere*. La geometria sta
// qui perché il giudizio ("ho copertura?") deve essere verificabile in un test
// senza server.

export const BLAZE_TYPES = new Set(['blaze']);
export const BLAZE_RANGE = 16;
export const BLAZE_REACH = 3.4;
export const BLAZE_RETREAT_HEALTH = 6;
export const BLAZE_RODS_NEEDED = 7;
export const BLAZE_ROD = 'blaze_rod';
export const COVER_SAMPLE_STEP = 0.5;
export const COVER_MAX_CELLS = 12;
export const COVER_RADIUS = 6;

export function isBlazeType (name) {
  const normalized = normalizeNetherName(name);
  return normalized != null && BLAZE_TYPES.has(normalized);
}

export function isBlazeRod (name) {
  return normalizeNetherName(name) === BLAZE_ROD;
}

// Un blocco solido sulla congiungente fra i due punti: campiona il segmento a
// passi piccoli e si ferma al primo campione pieno. Il primo campione è la cella
// del bot (`skip`), l'ultimo è il bersaglio: né l'uno né l'altro sono copertura.
export function lineBlocked ({ from, to, solid, step = COVER_SAMPLE_STEP, skip = 1 } = {}) {
  if (!from || !to || typeof solid !== 'function') return { blocked: false, at: null, samples: 0 };
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const distance = Math.hypot(dx, dy, dz);
  if (distance < 1) return { blocked: false, at: null, samples: 0 };
  const total = Math.max(2, Math.ceil(distance / step));
  let samples = 0;
  for (let i = skip + 1; i < total; i++) {
    if (i <= 0) continue;
    const t = i / total;
    const cell = {
      x: Math.floor(from.x + dx * t),
      y: Math.floor(from.y + dy * t),
      z: Math.floor(from.z + dz * t),
    };
    samples++;
    if (solid(cell)) return { blocked: true, at: cell, samples };
  }
  return { blocked: false, at: null, samples };
}

// Celle da cui lo sparo del bersaglio è intercettato da un blocco: la mira del
// bot sta all'altezza degli occhi (1.62), quella del bersaglio al petto (0.9).
// Ordinate per vicinanza: la copertura utile è quella che si raggiunge adesso.
export function coverCandidates ({ from, target, cells = [], solid, radius = COVER_RADIUS, limit = COVER_MAX_CELLS } = {}) {
  if (!from || !target || typeof solid !== 'function') return [];
  const shot = { x: target.x + 0.5, y: target.y + 0.9, z: target.z + 0.5 };
  const rows = [];
  for (const cell of cells) {
    if (!cell) continue;
    const distance = Math.hypot(cell.x - from.x, cell.y - from.y, cell.z - from.z);
    if (distance > radius) continue;
    const eye = { x: cell.x + 0.5, y: cell.y + 1.62, z: cell.z + 0.5 };
    const line = lineBlocked({ from: eye, to: shot, solid });
    if (!line.blocked) continue;
    rows.push({ cell: { x: cell.x, y: cell.y, z: cell.z }, distance: +distance.toFixed(2), cover: line.at });
  }
  rows.sort((a, b) => a.distance - b.distance);
  return rows.slice(0, limit);
}

// La tattica della mischia: un giudizio puro su cosa fare *adesso*.
// - `retreat`: salute sotto la soglia, oppure in fiamme senza copertura (nessun
//   modo di interrompere il danno: restare lì è solo perdere);
// - `take_cover`: c'è una copertura raggiungibile e il blaze è fuori portata;
// - `fight`: in mischia, o nessuna copertura disponibile (combattere resta
//   l'unica cosa da fare).
export function blazeTactics ({ distance, health = null, cover = 0, onFire = false, retreatHealth = BLAZE_RETREAT_HEALTH, reach = BLAZE_REACH, range = BLAZE_RANGE } = {}) {
  if (health != null && health <= retreatHealth) return { action: 'retreat', reason: 'low_health' };
  // In fiamme si smette di combattere: la copertura è solo la destinazione
  // della fuga, non un motivo per restare a sparare.
  if (onFire) return { action: 'retreat', reason: cover > 0 ? 'on_fire_with_cover' : 'on_fire_without_cover' };
  if (!(distance > 0)) return { action: 'approach', reason: 'unknown_distance' };
  if (distance > range) return { action: 'approach', reason: 'out_of_range' };
  if (cover > 0 && distance > reach) return { action: 'take_cover', reason: 'no_line_of_sight' };
  return { action: 'fight', reason: distance <= reach ? 'in_reach' : 'no_cover_available' };
}

// Quanti rod mancano all'obiettivo (uno per blaze ucciso è la stima ottimista:
// il drop non è garantito, quindi il conteggio vero resta l'inventario).
export function blazeRodProgress ({ inventory = {}, need = BLAZE_RODS_NEEDED } = {}) {
  let have = 0;
  for (const [name, count] of Object.entries(inventory ?? {})) {
    if (isBlazeRod(name)) have += Number(count) || 0;
  }
  return { have, need, remaining: Math.max(0, need - have), done: have >= need };
}
