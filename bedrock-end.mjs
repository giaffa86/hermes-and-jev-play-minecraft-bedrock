// Endgame (milestone N7 di docs/wiki/nether.md): dagli occhi di ender al
// portale dell'End.
//
// Modulo puro, senza I/O: come bedrock-nether.mjs il vocabolario è chiuso e
// ogni grandezza non misurabile resta `null` invece di essere indovinata. Un
// telaio di cui non si legge lo stato dell'occhio non è un telaio vuoto; un
// occhio di cui non si vede la traiettoria non è una direzione; due lanci quasi
// paralleli non sono una triangolazione.
//
// La verifica del drago è l'unico giudizio sul mondo che questo file esprime, e
// poggia su un segnale del server (`packet_boss_event`): barra del boss comparsa
// e poi scomparsa. Non è una deduzione dall'assenza di un'entità (un chunk non
// caricato non è un drago morto).

export const END_DIMENSION = 'the_end';
export const END_PORTAL_FRAME = 'end_portal_frame';
export const END_PORTAL = 'end_portal';
export const END_GATEWAY = 'end_gateway';
export const EYE_OF_ENDER = 'ender_eye';
export const BLAZE_POWDER = 'blaze_powder';
export const BLAZE_ROD_ITEM = 'blaze_rod';

// Un occhio per telaio, dodici telai (il portale è 3×3 con gli angoli tagliati).
export const ENDER_EYE_FRAME_TOTAL = 12;
export const POWDER_PER_ROD = 2;

// Raggio entro cui la milestone `find_stronghold` è soddisfatta (progression.json).
export const STRONGHOLD_RADIUS = 24;

// Due lanci più vicini di così danno un incrocio dominato dall'errore di lettura:
// l'occhio vola per decine di blocchi, ma la *direzione* la stimiamo dai primi
// metri di volo.
export const EYE_READING_MIN_SPAN = 16;
// Sotto questo angolo fra i due raggi l'intersezione è mal condizionata: la
// distanza stimata esplode e il numero non dice più nulla.
export const EYE_PARALLEL_DEG = 12;
// Un'entità-occhio vecchia non descrive più dove sta andando l'occhio appena
// lanciato: le letture scadono.
export const EYE_READING_MAX_AGE_MS = 10 * 60 * 1000;
export const EYE_READINGS_MAX = 6;

// L'entità che il server fa volare quando si lancia un occhio di ender.
export const EYE_SIGNAL_ENTITY = 'eye_of_ender_signal';
const EYE_SIGNAL_TYPES = new Set([EYE_SIGNAL_ENTITY, 'eye_of_ender']);

export function isEyeSignalType (name) {
  return EYE_SIGNAL_TYPES.has(String(name ?? '').replace(/^minecraft:/, '').toLowerCase());
}

// Lo stato `end_portal_eye_bit` dice se il telaio ha già l'occhio; il blocco
// arriva dalla palette del server, quindi la proprietà può mancare. `null` non
// è `false`: un telaio che non si legge non è un telaio da riempire.
export function frameHasEye (block) {
  const props = block?.getProperties?.() ?? block?.properties ?? block?._properties ?? block?.states ?? null;
  if (!props) return null;
  const raw = props.end_portal_eye_bit ?? props.eye_bit ?? props.has_eye;
  if (raw == null) return null;
  if (typeof raw === 'boolean') return raw;
  const num = Number(raw?.value ?? raw);
  return Number.isNaN(num) ? null : num !== 0;
}

// Stato del telaio del portale: quanti occhi ci sono, quanti ne mancano e quale
// telaio è il più vicino. `unknown` conta i telai illeggibili: non si sommano
// silenziosamente ai vuoti, altrimenti si dichiarerebbe "mancano 8 occhi" su una
// struttura che non si è saputa leggere.
export function frameStatus ({ frames = [], from = null } = {}) {
  const rows = [];
  let filled = 0;
  let empty = 0;
  let unknown = 0;
  for (const frame of frames) {
    if (!frame?.position) continue;
    const hasEye = frame.hasEye !== undefined ? frame.hasEye : frameHasEye(frame);
    if (hasEye === true) filled++;
    else if (hasEye === false) empty++;
    else unknown++;
    rows.push({
      position: { x: frame.position.x, y: frame.position.y, z: frame.position.z },
      hasEye: hasEye ?? null,
      label: frame.label ?? null,
      distance: from ? +Math.hypot(frame.position.x - from.x, frame.position.z - from.z).toFixed(1) : null,
    });
  }
  rows.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
  return {
    total: rows.length,
    filled,
    empty,
    unknown,
    // Solo i telai *vuoti e leggibili* chiedono un occhio.
    missing: empty,
    complete: rows.length > 0 && empty === 0 && unknown === 0,
    nearest: rows[0] ?? null,
    rows,
  };
}

export function eyesNeeded ({ filled = 0, total = ENDER_EYE_FRAME_TOTAL } = {}) {
  return Math.max(0, Number(total) - Number(filled));
}

// Piano di craft: un occhio costa un'unità di blaze powder e una perla; una
// bacchetta si scompone in due polveri (crafting, non fornace). Il piano dice
// anche *cosa manca*, altrimenti il chiamante non sa se deve andare a cacciare
// blaze o enderman.
export function eyeCraftPlan ({ powder = 0, pearls = 0, rods = 0, wanted = ENDER_EYE_FRAME_TOTAL } = {}) {
  const have = Math.max(0, Number(powder) || 0);
  const want = Math.max(0, Number(wanted) || 0);
  const pearlCount = Math.max(0, Number(pearls) || 0);
  const rodCount = Math.max(0, Number(rods) || 0);
  const craftable = Math.min(have, pearlCount, want);
  // Polveri che mancano per arrivare a `wanted` e quante ne possono uscire
  // dalle bacchette già in inventario (uno scomposto per volta).
  const powderShort = Math.max(0, want - have);
  const powderFromRods = rodCount * POWDER_PER_ROD;
  return {
    wanted: want,
    powder: have,
    pearls: pearlCount,
    rods: rodCount,
    craftable,
    powderShort,
    powderFromRods,
    rodsNeeded: Math.ceil(powderShort / POWDER_PER_ROD),
    missingPowder: Math.max(0, powderShort - powderFromRods),
    missingPearls: Math.max(0, want - pearlCount),
    done: craftable >= want,
  };
}

// Lettura di un lancio: dove ha origine il lancio e dove si trova l'occhio
// qualche istante dopo. Se il campione coincide con l'origine non c'è direzione
// (un occhio che si rompe subito non indica nulla).
export function eyeReading ({ origin = null, sample = null, at = null } = {}) {
  if (!origin || !sample) return null;
  const dx = sample.x - origin.x;
  const dz = sample.z - origin.z;
  const length = Math.hypot(dx, dz);
  if (!Number.isFinite(length) || length < 0.5) return null;
  return {
    origin: { x: +origin.x.toFixed(3), y: +origin.y.toFixed(3), z: +origin.z.toFixed(3) },
    direction: { x: +(dx / length).toFixed(6), z: +(dz / length).toFixed(6) },
    // Convenzione del client Bedrock: yaw 0 guarda +z, cresce verso -x.
    yaw: +(-Math.atan2(dx, dz) * 180 / Math.PI).toFixed(1),
    sample: { x: +sample.x.toFixed(3), y: Number.isFinite(sample.y) ? +sample.y.toFixed(3) : null, z: +sample.z.toFixed(3) },
    at: Number.isFinite(at) ? at : null,
  };
}

export function readingAge (reading, now = Date.now()) {
  if (!reading || !Number.isFinite(reading.at)) return null;
  return now - reading.at;
}

// Interseca due raggi (origine + direzione unitaria nel piano XZ). Restituisce
// sempre il motivo di un rifiuto: un numero inventato è peggio di nessun numero.
export function triangulateStronghold ({ first = null, second = null, now = null } = {}) {
  const readings = [first, second].filter(Boolean);
  if (readings.length < 2) return { ok: false, error: 'missing_readings', readings: readings.length };
  for (const reading of readings) {
    if (!reading.origin || !reading.direction) return { ok: false, error: 'invalid_reading' };
    const age = readingAge(reading, now ?? Date.now());
    if (age != null && age > EYE_READING_MAX_AGE_MS) return { ok: false, error: 'stale_reading', ageMs: age };
  }
  const [a, b] = readings;
  const span = Math.hypot(b.origin.x - a.origin.x, b.origin.z - a.origin.z);
  if (span < EYE_READING_MIN_SPAN) return { ok: false, error: 'readings_too_close', span: +span.toFixed(2) };
  const den = a.direction.x * b.direction.z - a.direction.z * b.direction.x;
  const angle = Math.abs(Math.asin(Math.max(-1, Math.min(1, den)))) * 180 / Math.PI;
  if (Math.abs(den) < Math.sin(EYE_PARALLEL_DEG * Math.PI / 180)) {
    return { ok: false, error: 'parallel_rays', angle: +angle.toFixed(1), span: +span.toFixed(2) };
  }
  const t = ((b.origin.x - a.origin.x) * b.direction.z - (b.origin.z - a.origin.z) * b.direction.x) / den;
  const s = ((b.origin.x - a.origin.x) * a.direction.z - (b.origin.z - a.origin.z) * a.direction.x) / den;
  if (t <= 0 || s <= 0) return { ok: false, error: 'no_intersection', t: +t.toFixed(2), s: +s.toFixed(2) };
  const position = { x: +(a.origin.x + t * a.direction.x).toFixed(1), y: null, z: +(a.origin.z + t * a.direction.z).toFixed(1) };
  const distance = +Math.hypot(position.x - a.origin.x, position.z - a.origin.z).toFixed(1);
  return {
    ok: true,
    position,
    distance,
    span: +span.toFixed(2),
    angle: +angle.toFixed(1),
    from: { x: a.origin.x, z: a.origin.z },
    // Errore atteso: con un angolo piccolo l'errore angolare si moltiplica per
    // la distanza, quindi il numero va letto insieme a `angle`.
    uncertainty: +(distance * Math.tan(EYE_PARALLEL_DEG * Math.PI / 180) / Math.max(1, angle / EYE_PARALLEL_DEG)).toFixed(1),
  };
}

// Un telaio completo è un portale pronto: si entra, non si riempie ancora.
export function endGate ({ frames = null, dimension = null } = {}) {
  const status = frames && typeof frames === 'object' && 'complete' in frames ? frames : frameStatus({ frames: frames ?? [] });
  return {
    inEnd: dimension === END_DIMENSION,
    ready: status.complete === true,
    missing: status.missing ?? 0,
    total: status.total ?? 0,
  };
}

// Verdetto sul drago a partire dal ciclo della barra del boss (`boss_event`).
// Il caveat è reale: uscire dall'End nasconde la barra, quindi il verdetto vale
// come "il boss è finito", non come "il drago è morto per mano del bot".
export function bossVerdict ({ shown = false, hidden = false, shownAt = null, hiddenAt = null } = {}) {
  if (!shown) return { defeated: false, reason: 'no_boss_bar', shownAt: null, hiddenAt: null };
  if (!hidden) return { defeated: false, reason: 'boss_bar_visible', shownAt, hiddenAt: null };
  if (Number.isFinite(shownAt) && Number.isFinite(hiddenAt) && hiddenAt < shownAt) {
    return { defeated: false, reason: 'hidden_before_shown', shownAt, hiddenAt };
  }
  return { defeated: true, reason: 'bar_shown_then_hidden', shownAt, hiddenAt };
}

function summarizeStronghold (stronghold) {
  if (!stronghold) return null;
  if (!stronghold.ok) return { error: stronghold.error };
  return { position: stronghold.position, distance: stronghold.distance, angle: stronghold.angle };
}

// Un progetto in una riga: serve a `/observe` e ai log, non al giudizio.
export function endSummary ({ frames = null, craft = null, readings = 0, stronghold = null, boss = null } = {}) {
  const status = frames && typeof frames === 'object' && 'missing' in frames ? frames : frameStatus({ frames: frames ?? [] });
  return {
    frames: { total: status.total ?? 0, filled: status.filled ?? 0, missing: status.missing ?? 0, unknown: status.unknown ?? 0 },
    eyes: craft ? { craftable: craft.craftable, powder: craft.powder, pearls: craft.pearls, missingPearls: craft.missingPearls, missingPowder: craft.missingPowder } : null,
    readings: Number(readings) || 0,
    stronghold: summarizeStronghold(stronghold),
    boss: boss ?? null,
  };
}
