// M2 di docs/wiki/fluids.md: respirare e gestire una discesa controllata.
//
// Il budget d'aria vive in `bedrock-air.mjs` (contatore simulato: 300 tick con
// la testa sott'acqua). Qui si decide **se** una discesa e' affrontabile e
// quanto lavoro si puo' fare prima di risalire: il livello decisionale di M2.
// Modulo puro e deterministico — nessun socket, nessun timer, nessun danno: la
// salute resta del server, l'aria serve solo a rifiutare un lavoro che
// finirebbe annegando.
//
// Perche' un modulo separato: la *fisica* del nuoto (M1) e' bloccata da una
// cattura pacchetti mancante, ma il conto "quanto tempo ho" e' verificabile
// adesso e deve essere lo stesso numero usato dal percorso di scavo, dalla
// raccolta dei drop e dal governor.

export const WATER_BREATHING_EFFECT = 'water_breathing';
export const TURTLE_HELMET = 'turtle_helmet';
export const CONDUIT_BLOCK = 'conduit';
export const CONDUIT_RANGE = 16;

// Stime prudenti: la risalita e' piu' lenta della discesa (si risale a nuoto,
// si scende anche in caduta) e la riserva copre assestamenti e imprevisti.
export const DIVE_DESCENT_SECONDS_PER_BLOCK = 0.6;
export const DIVE_ASCENT_SECONDS_PER_BLOCK = 0.7;
export const DIVE_RESERVE_SECONDS = 3;
export const MIN_WORK_SECONDS = 0.5;

// `WaterBreathing` (registry Bedrock) -> `water_breathing` (vocabolario).
export function normalizeEffectName (name) {
  return String(name ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function effectSeconds (effect) {
  if (Number.isFinite(effect?.seconds)) return effect.seconds;
  // Il pacchetto `mob_effect` conta in tick (20 tick = 1 s); -1 = infinito.
  if (Number.isFinite(effect?.duration)) {
    if (effect.duration < 0) return Infinity;
    return effect.duration / 20;
  }
  return null;
}

// Da dove viene il respiro: elmo di tartaruga, effetto `water_breathing`.
//
// I conduit *non* sono una fonte di `active`: per respirare serve un conduit
// attivo (prisma d'acqua 3x3 + struttura validata dal server) e non abbiamo
// modo di verificarlo. Restano nella vista come indizio, perche' dichiararli
// attivi sarebbe una sicurezza inventata.
export function waterBreathingSources ({ armor = null, effects = [], conduits = [] } = {}) {
  const sources = [];
  const helmet = typeof armor === 'string' ? armor : (armor?.helmet ?? null);
  if (helmet && String(helmet).includes(TURTLE_HELMET)) {
    sources.push({ kind: 'armor', name: TURTLE_HELMET });
  }
  const list = Array.isArray(effects) ? effects : [];
  for (const effect of list) {
    const name = normalizeEffectName(effect?.name ?? effect?.effect ?? '');
    if (name !== WATER_BREATHING_EFFECT) continue;
    const seconds = effectSeconds(effect);
    if (seconds != null && seconds <= 0) continue; // scaduto: non protegge
    sources.push({
      kind: 'effect',
      name,
      seconds: seconds == null ? null : (Number.isFinite(seconds) ? Math.round(seconds * 100) / 100 : 'infinite'),
      amplifier: Number.isFinite(effect?.amplifier) ? effect.amplifier : null,
    });
  }
  return {
    active: sources.length > 0,
    sources,
    conduitsNear: Array.isArray(conduits) ? conduits.length : 0,
  };
}

// Quanto costa una discesa a questa profondita': discesa + lavoro + risalita,
// con una riserva che non si tocca.
export function divePlan ({
  air = null,
  depth = 0,
  workSeconds = 0,
  waterBreathing = false,
  reserveSeconds = DIVE_RESERVE_SECONDS,
} = {}) {
  const d = Number(depth);
  const work = Number.isFinite(workSeconds) && workSeconds > 0 ? workSeconds : 0;
  const reserve = Number.isFinite(reserveSeconds) && reserveSeconds >= 0 ? reserveSeconds : DIVE_RESERVE_SECONDS;
  const descentSeconds = Number.isFinite(d) && d > 0 ? Math.round(d * DIVE_DESCENT_SECONDS_PER_BLOCK * 100) / 100 : 0;
  const ascentSeconds = Number.isFinite(d) && d > 0 ? Math.round(d * DIVE_ASCENT_SECONDS_PER_BLOCK * 100) / 100 : 0;
  const base = { depth: Number.isFinite(d) ? d : null, workSeconds: work, descentSeconds, ascentSeconds, reserveSeconds: reserve };

  if (!(Number.isFinite(d) && d > 0)) {
    return { ok: false, error: 'no_water', depth: base.depth, descentSeconds, ascentSeconds, reserveSeconds: reserve };
  }
  if (waterBreathing) {
    return {
      ...base,
      ok: true,
      held: true,
      reason: 'water_breathing',
      airSeconds: Number.isFinite(air) ? Math.round((air / 20) * 100) / 100 : null,
      totalSeconds: Math.round((descentSeconds + work + ascentSeconds) * 100) / 100,
      budgetSeconds: null,
      maxWorkSeconds: null,
      abortAtSeconds: null,
    };
  }
  if (!Number.isFinite(air)) {
    return { ...base, ok: false, error: 'unknown_air' };
  }
  const airSeconds = Math.round((air / 20) * 100) / 100;
  const budgetSeconds = Math.round((airSeconds - reserve) * 100) / 100;
  const roundTrip = Math.round((descentSeconds + ascentSeconds) * 100) / 100;
  const totalSeconds = Math.round((roundTrip + work) * 100) / 100;
  const shared = { ...base, airSeconds, budgetSeconds, totalSeconds };
  if (budgetSeconds <= roundTrip) {
    // Nemmeno andare e tornare sta nel budget: non si scende, e non c'è un
    // punto di "inizia a risalire" da indicare.
    return { ...shared, ok: false, error: 'air_too_low', maxWorkSeconds: 0, abortAtSeconds: null };
  }
  const maxWorkSeconds = Math.round((budgetSeconds - roundTrip) * 100) / 100;
  // `abortAtSeconds` è l'istante in cui la risalita deve iniziare: budget meno
  // il costo della risalita. Vale sia per il rifiuto sia per il piano accettato.
  const abortAtSeconds = Math.round((budgetSeconds - ascentSeconds) * 100) / 100;
  if (work > maxWorkSeconds) {
    return { ...shared, ok: false, error: 'work_too_long', maxWorkSeconds, abortAtSeconds };
  }
  return {
    ...shared,
    ok: true,
    held: false,
    error: null,
    maxWorkSeconds,
    abortAtSeconds,
  };
}

// Il verdetto che il percorso di scavo e la raccolta usano prima di toccare
// qualcosa sott'acqua: con la testa fuori dall'acqua non c'e' nulla da decidere.
export function underwaterWork ({
  inWater = false,
  headInWater = false,
  depth = 0,
  air = null,
  workSeconds = MIN_WORK_SECONDS,
  waterBreathing = false,
  reserveSeconds = DIVE_RESERVE_SECONDS,
} = {}) {
  if (!headInWater) return { allowed: true, reason: 'head_above_water', plan: null };
  if (!inWater) return { allowed: true, reason: 'head_in_water_only', plan: null };
  const plan = divePlan({ air, depth, workSeconds, waterBreathing, reserveSeconds });
  if (plan.ok) {
    return { allowed: true, reason: plan.held ? 'water_breathing' : 'budget_ok', plan };
  }
  return { allowed: false, reason: plan.error, plan };
}
