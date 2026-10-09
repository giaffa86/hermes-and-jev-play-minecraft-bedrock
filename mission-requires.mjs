// M14 — il requisito di missione: «minato», non «trovato in un baule».
//
// La spedizione diamanti dell'08-09/10/2026 e' stata chiusa tre volte di fila
// da `GOAL MET` a nove passi dall'inizio, senza che il bot scendesse di un
// blocco. Il meccanismo era tutto dentro il controller e il harness:
//
//   1. il piano dichiara `targets: {diamond: 2}` — e deve, altrimenti il
//      harness non offre `mine_diamond_ore`;
//   2. il harness offre una chiave `take_<item>` per **ogni** target che si
//      trovi in un contenitore vicino (il doppio baule del villaggio ne aveva
//      44);
//   3. `goalMet()` chiude il goal quando `obs.inventory[item] >= n`, che sia
//      minato, comprato o **preso da uno scrigno**.
//
// Il modello piccolo, davanti a `take_diamond` (p=alta, indolore) e a
// `goto_waypoint` (lento, rischioso), ha scelto il furto ogni volta, e il
// guard `TARGETS={"diamond":2}` — messo apposta per non chiudere a vuoto — ha
// chiuso il run con il bottino in tasca. Una regola scritta nel testo del goal
// («never take diamonds from a chest») non e' un meccanismo: la si ignora.
//
// Qui il requisito diventa dichiarativo e verificabile come gli altri:
//
//   MUST_MINE=diamond:2      l'oggetto va **prodotto** in questo run; la sua
//                            chiave `take_<item>` non viene mai offerta e il
//                            goal non chiude finche' non e' stato minato;
//   MUST_DEPOSIT=diamond:2   l'oggetto deve anche essere **uscito** verso un
//                            contenitore, cosi' la spedizione non finisce con
//                            il bottino nello zaino.
//
// Il modulo e' puro: non parla con l'harness, non conosce il piano, non tocca
// il mondo. Riceve l'inventario di prima e di dopo, il risultato di un'azione,
// e dice cosa e' stato guadagnato.

export const MISSION_REQUIREMENTS_VERSION = 1;

// Le chiavi che possono **produrre** un oggetto. `collect_drop` raccoglie il
// drop di un minaggio appena fatto, `harvest_*` raccoglie una pianta matura:
// senza di esse un diamante minato e raccolto al passo successivo non
// conterebbe, e il goal non chiuderebbe mai.
export const PRODUCING_KEY_PREFIXES = Object.freeze(['mine_', 'dig_', 'collect_drop', 'harvest_']);

// `MUST_MINE=diamond:2,iron_ore` -> `{diamond: 2, iron_ore: 1}`. Un `:` senza
// numero vale 1. Un token malformato **non** viene ignorato: un requisito
// sbagliato in silenzio e' il difetto che questo modulo esiste per evitare.
export function parseMissionRequirements (value) {
  const out = {};
  if (value == null) return out;
  const text = String(value).trim();
  if (!text || text === 'off' || text === 'none') return out;
  for (const token of text.split(',')) {
    const part = token.trim();
    if (!part) continue;
    const [rawItem, rawCount, ...rest] = part.split(':');
    const item = rawItem.trim().toLowerCase();
    if (!item || rest.length) throw new Error(`must_mine_invalid:${part}`);
    if (!/^[a-z_]+$/.test(item)) throw new Error(`must_mine_invalid:${part}`);
    const count = rawCount == null || rawCount === '' ? 1 : Number(rawCount);
    if (!Number.isFinite(count) || count <= 0 || !Number.isInteger(count)) throw new Error(`must_mine_invalid:${part}`);
    out[item] = (out[item] ?? 0) + count;
  }
  return out;
}

// Le opzioni che il furto usa: per ogni oggetto da minare, la sua chiave di
// prelievo. Vuoto se il requisito non e' configurato (il comportamento di
// prima, invariato).
export function requirementTakeKeys (requirements = {}) {
  return Object.keys(requirements).map(item => `take_${item}`);
}

// Questa azione poteva produrre l'oggetto? Solo le chiavi che scavano o
// raccolgono: un `take_diamond` riuscito **non** e' un diamante minato.
export function isProducingKey (key) {
  if (typeof key !== 'string') return false;
  return PRODUCING_KEY_PREFIXES.some(prefix => key.startsWith(prefix));
}

// La crescita dell'inventario, limitata agli oggetti richiesti. `before` e
// `after` sono le mappe `inventory` di `observe()`.
export function producedGrowth (before = {}, after = {}, requirements = {}) {
  const out = {};
  for (const item of Object.keys(requirements)) {
    const delta = Math.max(0, (after[item] ?? 0) - (before[item] ?? 0));
    if (delta > 0) out[item] = delta;
  }
  return out;
}

// Cosa e' uscito dallo zaino verso un contenitore. Il deposito ha due forme:
// `deposit_<item>` risponde `{item, count}` e il dump `{items: [{item, count}]}`.
export function depositedStacks (result) {
  if (!result || typeof result !== 'object') return [];
  const rows = Array.isArray(result.items) ? result.items : [result];
  const out = [];
  for (const row of rows) {
    const item = row?.item ?? null;
    const count = Number(row?.count);
    if (typeof item === 'string' && item && Number.isFinite(count) && count > 0) out.push({ item, count });
  }
  return out;
}

// Lo stato leggibile del requisito: una riga per oggetto, con quanto manca.
export function missionRequirementsState (progress = {}, { mustMine = {}, mustDeposit = {} } = {}) {
  const mined = progress.mined ?? {};
  const deposited = progress.deposited ?? {};
  const items = [...new Set([...Object.keys(mustMine), ...Object.keys(mustDeposit)])];
  return items.map(item => {
    const wantMined = mustMine[item] ?? 0;
    const wantDeposited = mustDeposit[item] ?? 0;
    const haveMined = mined[item] ?? 0;
    const haveDeposited = deposited[item] ?? 0;
    return {
      item, wantMined, haveMined, wantDeposited, haveDeposited,
      met: haveMined >= wantMined && haveDeposited >= wantDeposited,
    };
  });
}

export function missionRequirementsMet (progress = {}, requirements = {}) {
  return missionRequirementsState(progress, requirements).every(row => row.met);
}

// Una riga per il ledger: `diamond mined 1/2 deposited 0/2`.
export function renderRequirements (state = []) {
  return state
    .map(row => `${row.item} mined ${row.haveMined}/${row.wantMined} deposited ${row.haveDeposited}/${row.wantDeposited}`)
    .join('; ');
}

// Accumula su una copia (il chiamante tiene il contatore del run).
export function addCounts (counts = {}, growth = {}) {
  const out = { ...counts };
  for (const [item, count] of Object.entries(growth)) out[item] = (out[item] ?? 0) + count;
  return out;
}
