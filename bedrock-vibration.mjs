// Deep Dark / stealth (W0 di docs/raw/DEEP_DARK_ROADMAP.md): modello delle
// vibrazioni sculk e del silenzio dei passi. Modulo puro, nessun I/O: come
// bedrock-redstone e bedrock-fluids il vocabolario e' chiuso e ogni valore che
// il registry non espone resta `null` invece di essere indovinato — un sensore
// di cui non si legge la fase non deve mai sembrare "spento".
//
// Perche' serve: `DIG_PROTECTED` copriva solo `sculk_sensor`/`sculk_shrieker`
// mentre scavare *qualsiasi* blocco della famiglia sculk (e in generale scavare
// dentro il raggio di un sensore) e' gia' una vibrazione: il bot poteva
// svegliare il Warden senza toccare nulla di protetto. E lo sneak esisteva solo
// come input di costruzione, quindi ogni spostamento era rumoroso.

// Raggio della sfera di rilevamento di uno sculk sensor (blocchi). Un giocatore
// che vibra dentro questo raggio attiva il sensore, che a sua volta fa
// shriekare gli shrieker vicini (`can_summon`): e' il relay che evoca il Warden.
export const VIBRATION_RADIUS = 8;

// Numero di shriek che evoca il Warden. Java ne chiede 4, Bedrock ne dichiara 3
// ("three times or more", minecraft.wiki). Si tiene il numero piu' basso — un
// avviso in anticipo e' l'errore sicuro — e la verifica live resta aperta
// (rischio 1 e 4 di docs/raw/DEEP_DARK_ROADMAP.md).
export const SHRIEK_SUMMON_LEVEL = 3;

// Finestra in cui gli shriek si sommano (10 minuti in Java: 12000 tick). Oltre
// la finestra il livello di allarme decade.
export const SHRIEK_WINDOW_MS = 600000;

// Famiglia sculk completa: nominarla serve sia per la protezione dello scavo sia
// per il censimento. `sculk` da solo e' il blocco di riempimento.
export const SCULK_FAMILY = ['sculk', 'sculk_vein', 'sculk_catalyst', 'sculk_sensor', 'calibrated_sculk_sensor', 'sculk_shrieker'];
export const SCULK_SENSORS = ['sculk_sensor', 'calibrated_sculk_sensor'];
export const SCULK_SHRIEKERS = ['sculk_shrieker'];

// Lo sneak vale il 30% della velocita' di cammino (Java/Bedrock): 1,3 m/s
// contro 4,317. Il tetto per il verdetto sta in mezzo, con un margine largo
// cosi' che il rumore dei pacchetti `move_player` non scambi un passo accovacciato
// per una camminata; il valore vero si misura live (W1).
export const SNEAK_SPEED_FACTOR = 0.3;
export const SNEAK_SPEED_CEILING_MPS = 2.6;

// Azioni del bot e vibrazione che producono. Non e' una tabella di frequenze
// (che serve solo a leggere la potenza di un sensore, gia' coperta dalla R0 di
// bedrock-redstone.mjs): qui interessa il booleano, cioe' se l'azione fa rumore.
export const ACTION_VIBRATIONS = {
  idle: false,
  sneak: false,
  step: true,
  jump: true,
  land: true,
  swim: true,
  break_block: true,
  place_block: true,
  hit_block: true,
  open_container: true,
  close_container: true,
  interact: true,
  attack: true,
  shoot_projectile: true,
  eat: true,
  drink: true,
  pickup_item: false,
};

// `vibrationProfile('unknown')` -> `{ vibrates: null }`: un'azione non censita
// non e' dichiarata silenziosa per sbaglio.
export function vibrationProfile (action) {
  if (typeof action !== 'string' || !(action in ACTION_VIBRATIONS)) return { action: action ?? null, vibrates: null };
  return { action, vibrates: ACTION_VIBRATIONS[action] };
}

export function isSculkFamily (name) {
  return SCULK_FAMILY.includes(String(name ?? ''));
}

export function isSculkSensor (name) {
  return SCULK_SENSORS.includes(String(name ?? ''));
}

// Proprieta' del blocco -> stato del sensore. `sculk_sensor_phase` e' 0
// inattivo, 1 attivo, 2 in cooldown; proprieta' assente (registry incompleto) ->
// `null`, mai "inattivo".
export function sensorPhase (properties) {
  const raw = properties?.sculk_sensor_phase;
  const phase = raw == null ? null : Number(raw);
  if (phase == null || !Number.isFinite(phase)) return { phase: null, active: null };
  return { phase, active: phase === 1 };
}

// Stato di uno shrieker. In Bedrock le proprieta' sono `active` (sta shriekando)
// e `can_summon` (generato naturalmente: puo' evocare il Warden). Uno shrieker
// piazzato dal bot o cresciuto da un catalyst ha `can_summon = 0` ed e' inerte.
export function shriekerState (properties) {
  const canSummon = properties?.can_summon == null ? null : Number(properties.can_summon) === 1;
  const active = properties?.active == null ? null : Number(properties.active) === 1;
  return { canSummon, active };
}

// Distanza di un punto da un segmento (per un tragitto a piedi la posizione
// conta lungo tutto il percorso, non solo all'arrivo).
export function pointSegmentDistance (point, from, to) {
  if (!point || !from || !to) return null;
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const lengthSq = dx * dx + dy * dy + dz * dz;
  if (!(lengthSq > 0)) return Math.hypot(point.x - from.x, point.y - from.y, point.z - from.z);
  let t = ((point.x - from.x) * dx + (point.y - from.y) * dy + (point.z - from.z) * dz) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point.x - (from.x + t * dx), point.y - (from.y + t * dy), point.z - (from.z + t * dz));
}

// Vibrazione causata in `point`: quanti sensori la sentono e a che distanza.
// `count === 0` significa silenzio *rispetto ai sensori noti*: un censimento non
// ancora pronto resta `ready: null` lato adapter, non "silenzioso".
export function vibrationRisk (point, sensors, { radius = VIBRATION_RADIUS } = {}) {
  if (!point) return { count: null, nearest: null, radius, sensors: [] };
  const heard = [];
  for (const sensor of sensors || []) {
    const position = sensor?.position ?? sensor;
    if (!position) continue;
    const distance = +Math.hypot(position.x - point.x, position.y - point.y, position.z - point.z).toFixed(2);
    if (distance <= radius) heard.push({ position, name: sensor?.name ?? null, distance });
  }
  heard.sort((a, b) => a.distance - b.distance);
  return { count: heard.length, nearest: heard[0] ?? null, radius, sensors: heard };
}

// Il bot sta sopra uno shrieker: lo shrieker shrieka *anche* accovacciato, quindi
// la cella va abbandonata prima di ogni altra cosa.
export function shriekerVerdict (feetCell, shriekers) {
  if (!feetCell) return { blocked: null, shrieker: null, reason: null };
  for (const row of shriekers || []) {
    const position = row?.position ?? row;
    if (!position) continue;
    if (position.x === feetCell.x && position.z === feetCell.z && position.y === feetCell.y - 1) {
      return { blocked: true, shrieker: row, reason: 'standing_on_shrieker' };
    }
  }
  return { blocked: false, shrieker: null, reason: null };
}

// Livello di allarme: quanti shriek valgono il Warden. `clear` senza shriek,
// `warning` da 1, `summoned` alla soglia.
export function wardenWarning (level, { threshold = SHRIEK_SUMMON_LEVEL } = {}) {
  const count = Number.isFinite(level) ? level : null;
  if (count == null) return { level: null, threshold, verdict: null, maySummon: null };
  if (count <= 0) return { level: count, threshold, verdict: 'clear', maySummon: false };
  if (count < threshold) return { level: count, threshold, verdict: 'warning', maySummon: false };
  return { level: count, threshold, verdict: 'summoned', maySummon: true };
}

// Il server puo' muovere il bot a velocita' di cammino anche se il client
// dichiara `sneaking` (e' autorevole lui): il silenzio si *misura*, non si
// presume. Velocita' sopra il tetto -> `ok: false` con l'errore tipizzato che
// l'azione riporta.
export function classifySneakSpeed ({ distanceM, seconds, ceiling = SNEAK_SPEED_CEILING_MPS } = {}) {
  // Un tratto percorso *zero* non è un verdetto di silenzio: senza un passo reale
  // (teletrasporto scartato, movimento mai iniziato) non si sa se il server abbia
  // accettato lo sneak, e l'onestà è `no_measurement`.
  if (!Number.isFinite(distanceM) || distanceM <= 0 || !Number.isFinite(seconds) || seconds <= 0) {
    return { ok: null, error: 'no_measurement', mps: null, ceiling, distanceM: null, seconds: null };
  }
  const mps = +(distanceM / seconds).toFixed(3);
  return { ok: mps <= ceiling, error: mps <= ceiling ? null : 'not_sneaking', mps, ceiling, distanceM: +distanceM.toFixed(2), seconds: +seconds.toFixed(2) };
}

// Riepilogo compatto del censimento (stessa forma di summarizeFluids/
// summarizeRedstone): conta i blocchi trovati e calcola il rischio nel punto.
export function summarizeSculk ({ sensors = [], shriekers = [], blocks = [], point = null, radius = VIBRATION_RADIUS } = {}) {
  const canSummon = shriekers.filter(row => row?.canSummon === true);
  const active = shriekers.filter(row => row?.active === true);
  const nearestSensor = sensors.reduce((best, row) => (row?.distance != null && (!best || row.distance < best.distance) ? row : best), null);
  return {
    sensors: sensors.length,
    shriekers: shriekers.length,
    shriekersCanSummon: canSummon.length,
    shriekersActive: active.length,
    sculkBlocks: blocks.length,
    nearestSensor,
    radius,
    vibrationRisk: point ? vibrationRisk(point, sensors, { radius }) : null,
  };
}

// ---- W2: pathfinding silenzioso ---------------------------------------------
// Una cella dentro la sfera di un sensore non e' "vietata per decreto" — a
// volte e' l'unico passaggio — ma costa come `SENSOR_CELL_COST` celle sicure:
// un giro largo viene preferito, un passaggio obbligato viene accettato e
// dichiarato (`maxRisk`), invece di essere nascosto. Una cella che porta uno
// shrieker e' invece vietata e basta: lo shrieker shrieka anche accovacciati, e
// non c'e' modo di attraversarla in silenzio. Un salto o una caduta vibrano (W0),
// ma contano solo *dentro* una sfera: ogni cella entrata porta il proprio rischio,
// quindi un movimento rumoroso fra due celle silenziose resta silenzioso — non
// c'e' nessun sensore che possa sentirlo.
export const SENSOR_CELL_COST = 50;
export const STEALTH_MAX_NODES = 4096;

// Costo e ammissibilita' di una cella per il pianificatore silenzioso.
export function stealthCellCost ({ cell, sensors = [], shriekers = [], radius = VIBRATION_RADIUS } = {}) {
  if (!cell) return { blocked: true, reason: 'no_cell', cost: null, risk: null, nearest: null };
  const standing = shriekerVerdict(cell, shriekers);
  if (standing.blocked) return { blocked: true, reason: standing.reason, cost: null, risk: 0, nearest: null, shrieker: standing.shrieker };
  const risk = vibrationRisk(cell, sensors, { radius });
  const count = risk.count ?? 0;
  return { blocked: false, reason: null, cost: 1 + count * SENSOR_CELL_COST, risk: count, nearest: risk.nearest };
}

// A* puro: `neighbors(node)` produce `{x, y, z, cost}` in sola camminata (nessuno
// scavo, nessun piazzamento: la rotta silenziosa non puo' contenere un rumore) e
// `cellCost(cell)` decide costo e ammissibilita' di ogni cella *entrata*.
// Ritorna `null` se la destinazione non e' raggiungibile, altrimenti
// `{path, cost, maxRisk, riskCell}` con il percorso che parte dalla partenza.
export function astarStealth ({ start, goal, neighbors, cellCost, maxNodes = STEALTH_MAX_NODES } = {}) {
  if (!start || !goal || typeof neighbors !== 'function' || typeof cellCost !== 'function') return null;
  const keyOf = cell => `${cell.x},${cell.y},${cell.z}`;
  const heuristic = cell => Math.abs(cell.x - goal.x) + Math.abs(cell.z - goal.z) + 0.4 * Math.abs(cell.y - goal.y);
  const costOf = cell => {
    const verdict = cellCost(cell) ?? {};
    return { blocked: verdict.blocked === true, cost: Number.isFinite(verdict.cost) ? verdict.cost : 1, risk: Number.isFinite(verdict.risk) ? verdict.risk : null };
  };
  const startKey = keyOf(start), goalKey = keyOf(goal);
  const open = [];
  const push = (node, f) => {
    open.push({ node, f });
    let i = open.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (open[p].f <= open[i].f) break;
      [open[p], open[i]] = [open[i], open[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = open[0];
    const last = open.pop();
    if (open.length) {
      open[0] = last;
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= open.length) break;
        if (c + 1 < open.length && open[c + 1].f < open[c].f) c++;
        if (open[i].f <= open[c].f) break;
        [open[i], open[c]] = [open[c], open[i]];
        i = c;
      }
    }
    return top.node;
  };
  const gScore = new Map([[startKey, 0]]);
  const cameFrom = new Map();
  const closed = new Set();
  push(start, heuristic(start));
  let expanded = 0;
  while (open.length && expanded < maxNodes) {
    const current = pop();
    const currentKey = keyOf(current);
    if (closed.has(currentKey)) continue;
    closed.add(currentKey);
    expanded++;
    if (currentKey === goalKey) return buildStealthRoute(cameFrom, current, start, cellCost);
    for (const candidate of neighbors(current) || []) {
      const nbKey = keyOf(candidate);
      if (closed.has(nbKey)) continue;
      const verdict = costOf(candidate);
      if (verdict.blocked) continue;
      const tentative = (gScore.get(currentKey) ?? Infinity) + (Number.isFinite(candidate.cost) ? candidate.cost : 1) + verdict.cost - 1;
      if (tentative < (gScore.get(nbKey) ?? Infinity)) {
        gScore.set(nbKey, tentative);
        cameFrom.set(nbKey, current);
        push(candidate, tentative + heuristic(candidate));
      }
    }
  }
  return null;
}

// Ricostruisce il percorso dalla partenza e calcola il rischio massimo incontrato
// (`riskCell` e' la cella che lo produce: l'operatore vede *dove* il piano non e'
// silenzioso, invece di un verdetto senza indirizzo).
function buildStealthRoute (cameFrom, node, start, cellCost) {
  const path = [{ x: node.x, y: node.y, z: node.z }];
  let key = `${node.x},${node.y},${node.z}`;
  while (key !== `${start.x},${start.y},${start.z}`) {
    const prev = cameFrom.get(key);
    if (!prev) break;
    path.push({ x: prev.x, y: prev.y, z: prev.z });
    key = `${prev.x},${prev.y},${prev.z}`;
  }
  path.reverse();
  let cost = 0, maxRisk = 0, riskCell = null;
  for (const cell of path) {
    const verdict = cellCost(cell) ?? {};
    cost += Number.isFinite(verdict.cost) ? verdict.cost : 1;
    const risk = Number.isFinite(verdict.risk) ? verdict.risk : 0;
    if (risk > maxRisk) { maxRisk = risk; riskCell = { ...cell }; }
  }
  return { path, cost: +cost.toFixed(2), maxRisk, riskCell };
}

// Piano silenzioso: la rotta verso la destinazione e, se richiesta, la rotta di
// ritorno. La seconda non e' il primo percorso al contrario (una caduta si fa in
// un senso solo): si ripianifica verso l'uscita, e se non esiste il piano si
// rifiuta per intero — un'andata senza ritorno non e' un piano, e' una trappola.
export function planStealthRoute ({ start, goal, exit = null, neighbors, cellCost, maxNodes = STEALTH_MAX_NODES, maxRisk = 0 } = {}) {
  const inbound = astarStealth({ start, goal, neighbors, cellCost, maxNodes });
  if (!inbound) return { ok: false, error: 'no_stealth_route', reason: 'unreachable', from: start, to: goal, maxRisk: null, exit: null };
  if (inbound.maxRisk > maxRisk) {
    return { ok: false, error: 'no_stealth_route', reason: 'risk', from: start, to: goal, maxRisk: inbound.maxRisk, riskCell: inbound.riskCell, exit: null };
  }
  if (!exit) return { ok: true, cells: inbound.path, cost: inbound.cost, maxRisk: inbound.maxRisk, riskCell: inbound.riskCell, sneak: true, exit: null };
  const back = astarStealth({ start: inbound.path[inbound.path.length - 1], goal: exit, neighbors, cellCost, maxNodes });
  if (!back) return { ok: false, error: 'no_exit_route', reason: 'unreachable', from: start, to: goal, maxRisk: inbound.maxRisk, exit };
  if (back.maxRisk > maxRisk) {
    return { ok: false, error: 'no_exit_route', reason: 'risk', from: start, to: goal, maxRisk: back.maxRisk, riskCell: back.riskCell, exit };
  }
  return {
    ok: true,
    cells: inbound.path,
    cost: inbound.cost,
    maxRisk: inbound.maxRisk,
    riskCell: inbound.riskCell,
    sneak: true,
    exit: { cells: back.path, cost: back.cost, maxRisk: back.maxRisk, riskCell: back.riskCell, target: exit },
  };
}

// Forma compatta di un piano per la log (la rotta intera resta nel piano, qui si
// dichiarano lunghezza e rischio: quello che l'operatore deve poter leggere).
export function summarizeStealthPlan (plan) {
  if (!plan) return null;
  if (plan.ok === false) {
    return { ok: false, error: plan.error, reason: plan.reason ?? null, maxRisk: plan.maxRisk ?? null, riskCell: plan.riskCell ?? null, cells: null, exit: null };
  }
  return {
    ok: true,
    cells: plan.cells?.length ?? 0,
    cost: plan.cost ?? null,
    maxRisk: plan.maxRisk ?? null,
    sneak: plan.sneak === true,
    from: plan.cells?.[0] ?? null,
    to: plan.cells?.[plan.cells.length - 1] ?? null,
    exit: plan.exit ? { cells: plan.exit.cells?.length ?? 0, cost: plan.exit.cost ?? null, maxRisk: plan.exit.maxRisk ?? null, target: plan.exit.target ?? null } : null,
  };
}

