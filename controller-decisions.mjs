// Pure helpers for the controller loop: option ranking/capping, anti-loop
// detection and decision diagnostics. No I/O and no model calls live here, so
// the behaviour is unit-testable; controller.mjs owns the actual loop.
//
// The harness remains the only owner of action validity: these helpers may
// only reorder, cap or temporarily hide keys the harness already offered, and
// they never invent a key.

import { keyMatchesIntents } from './survival/intents.mjs';
import { oreValue, ORE_OPTION_PRIORITY_MIN_VALUE } from './ore-value.mjs';
import { matchItemWordText, matchesItemToken, normalizeForMatching } from './human-questions.mjs';
import { cropBlockForItem, seedForCrop } from './bedrock-survival.mjs';

export const DEFAULT_MAX_OPTIONS = 12;
export const DEFAULT_ANTI_LOOP_THRESHOLD = 3;

const SURVIVAL_KEYS = new Set(['flee', 'sleep', 'eat', 'recover_loot']);

// Distance in blocks parsed from an option description ("... (12.3 blocks away)"),
// used as tie-breaker inside the same relevance tier. Null when absent.
export function parseDistance (description) {
  const m = /([0-9]+(?:\.[0-9]+)?) blocks? away/.exec(description || '');
  return m ? +m[1] : null;
}

// Lower = more relevant when the option set has to be capped.
// 0 survival | 1 drop pickup | 1.5 boarding the human's mount | 2 following the
// human | 3 skill intent | 4 target hit | 4.5 valuable ore (opportunity) |
// 5 progression crafts/places | 6 travel and digging | 7 generic mining |
// 10 wait.
//
// The 1.5 tier is the boat: while the human is under way, following on foot
// cannot work, so boarding their spare seat outranks the follow order itself,
// every generic `mount_*` (which boards *some* nearby vehicle, not theirs) and
// every locomotion fallback (seek/swim/goto), which would chase the boat
// instead of reaching it.
//
// The 4.5 tier is the option-level half of the opportunity layer: a diamond or
// gold vein is worth taking even when the plan aims elsewhere, because the
// window is short (ORE_INTEREST_RANGE) while a craft can be done later. It stays
// below the plan target: the goal decides, the option only does not starve it.
export function optionPriority (option, { targets = {}, preferredIntents = [] } = {}) {
  const key = option?.key || '';
  if (SURVIVAL_KEYS.has(key) || key.startsWith('attack_')) return 0;
  if (key === 'collect_drop') return 1;
  if (key === 'join_human_mount') return 1.5; // l'umano sta salpando senza di noi
  if (key === 'follow_player') return 2; // ordine umano "seguimi"
  if (key === 'construction_step' || key === 'construction_supply') return 3;
  if (preferredIntents.length && keyMatchesIntents(key, preferredIntents)) return 3;
  for (const target of Object.keys(targets)) {
    const normalized = target.replace(/_/g, '');
    if (target === 'honey_bottle' && key === 'harvest_honey') return 4;
    if (key === `mine_${target}` || key === `craft_${target}` || key === `smelt_${target}` ||
        key.includes(target) || key.replace(/_/g, '').includes(normalized)) {
      return 4;
    }
  }
  if (key.startsWith('mine_') && oreValue(key.slice('mine_'.length)) >= ORE_OPTION_PRIORITY_MIN_VALUE) return 4.5;
  if (key.startsWith('craft_') || key.startsWith('place_') || key.startsWith('smelt_')) return 5;
  if (key === 'goto_waypoint' || key.startsWith('dig_')) return 6;
  if (key.startsWith('mine_')) return 7;
  if (key === 'wait') return 10;
  return 8;
}

// Stable relevance order: tier, then parsed distance, then original position.
export function rankOptions (options, context = {}) {
  return options
    .map((option, index) => ({ option, index }))
    .sort((a, b) => {
      const pa = optionPriority(a.option, context);
      const pb = optionPriority(b.option, context);
      if (pa !== pb) return pa - pb;
      const da = parseDistance(a.option.description) ?? Infinity;
      const db = parseDistance(b.option.description) ?? Infinity;
      if (da !== db) return da - db;
      return a.index - b.index;
    })
    .map(({ option }) => option);
}

// Keep at most `max` options (0 or negative disables the cap), selecting the
// most relevant ones but preserving the original order among the survivors so
// the criteria numbering stays stable for the model.
export function capOptions (options, { max = DEFAULT_MAX_OPTIONS, ...context } = {}) {
  if (!(max > 0) || options.length <= max) return { options, dropped: [] };
  const keep = new Set(rankOptions(options, context).slice(0, max).map(o => o.key));
  return {
    options: options.filter(o => keep.has(o.key)),
    dropped: options.filter(o => !keep.has(o.key)),
  };
}

// Choice criteria for the decision model: index -> "[key] description".
export function buildCriteria (options) {
  return Object.fromEntries(options.map((o, i) => [`a${i}`, `[${o.key}] ${o.description}`]));
}

// Progress = position, inventory or plan objective changed. Health/drops/entities
// are deliberately excluded: losing health is not progress, and a fresh drop does
// not mean the action worked.
export function progressFingerprint (obs, plan) {
  const p = obs?.position || {};
  const inventory = Object.entries(obs?.inventory || {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify({
    position: [Math.round(p.x ?? 0), Math.round(p.y ?? 0), Math.round(p.z ?? 0)],
    inventory,
    construction: obs?.construction ? [obs.construction.projectId, obs.construction.placed, obs.construction.phase, obs.construction.state, obs.construction.functionalIndex, obs.construction.walkIndex, obs.construction.temporaryRemoved, obs.construction.verification] : null,
    objective: plan?.objective ?? null,
  });
}

// Un ordine "seguimi" e' un impegno aperto: qualunque piano arrivi (replan,
// planner, governor) il goal resta un inseguimento della stessa persona finche'
// non arriva un altro ordine. Il follow e' quindi un attributo del *goal*, non
// del piano che il modello puo' riscrivere a ogni passo.
export function withStickyFollow (plan, follow) {
  if (!follow) return plan;
  if (plan && plan.follow === follow) return plan;
  return { ...(plan || {}), follow };
}

// Come il follow, una scorta e' un impegno aperto: il planner riscrive il piano a
// ogni passo e non conosce l'ordine umano, quindi la persona da guidare e la
// meta vanno riapplicate finche' l'ordine resta aperto (altrimenti l'opzione
// `escort_to` sparirebbe al primo replan e il bot tornerebbe a seguire).
export function withStickyEscort (plan, escort) {
  if (!escort) return plan;
  if (plan && plan.escort === escort) return plan;
  return { ...(plan || {}), escort };
}

// Un ordine di stop ("fermati", "aspetta", "stop") deve chiudere un
// inseguimento aperto: il fallback deterministico del traduttore di ordini
// ("segui chi ti ha scritto") non deve mai trasformarlo in un follow.
export function isStopOrder (message) {
  return /\b(fermati|fermo|stop|basta|aspett\w*|resta|rimani|smettila|non seguirmi|stay|wait|stand still)\b/i.test(String(message || ''));
}

// «Guidami fino al filone», «accompagnami», «portami la'»: non e' un follow. Il
// bot deve camminare per primo e *aspettare* chi resta indietro, quindi l'ordine
// diventa `plan.escort` (opzione `escort_to`) e non `plan.follow`. Il verbo da
// solo non basta: senza una meta nota il controller lo degrada a follow, perche'
// una scorta senza destinazione non ha niente da guidare. «Aspettami» resta un
// ordine di stop (aspettare da fermo), non una scorta.
const ESCORT_VERB = /\b(guidami|guidaci|guidar\w*|portami|portaci|accompagnami|accompagnaci|fammi strada|vieni con me|andiamo|lead me|guide me|take me|walk me|come with me)\b/;
export function isEscortOrder (message) {
  return ESCORT_VERB.test(String(message || '').toLowerCase());
}

// Un ordine di equipaggiamento ("equipaggiati con l'elmo", "mettiti l'armatura",
// "wear your helmet"): e' un ordine di *azione*, non una domanda, ma il
// fallback deterministico del traduttore ("segui chi ti ha scritto") sarebbe un
// fraintendimento, e Hermes non sa esprimere l'equipaggiamento (il suo piano ha
// solo target/waypoint/follow). Riconosce il verbo equipaggiare da solo, oppure
// mettersi/indossare solo quando nomina un capo o un utensile: cosi' "mettiti a
// lavorare" resta un ordine normale.
const EQUIP_NOUN = /\b(armatur\w*|elmo|elmetto|casco|corazz\w*|pettoral\w*|gambal\w*|stival\w*|scudo|zucca|helmet|chestplate|leggings|boots|shield|armor|pumpkin)\b/;
export function isEquipOrder (message) {
  const text = String(message || '').toLowerCase();
  if (/\bequip\w*\b/.test(text)) return true;
  return /\b(mettiti|mettiamoci|indossa|indossare|wear|put on)\b/.test(text) && EQUIP_NOUN.test(text);
}

// Ordini di inventario via chat (M9). "getta <oggetto>" butta via
// dall'inventario, "cattura <oggetto>" raccoglie da terra un drop. Sono ordini
// *deterministici* come l'equipaggiamento: senza di essi il planner tradurrebbe
// "getta i diamanti" in un target e "cattura" in un mining, due
// fraintendimenti. Il verbo da solo non basta: serve un oggetto del catalogo
// `ITEM_WORDS` (`human-questions.mjs`), cosi' "mettiti a lavorare" o "getta
// l'occhio" restano ordini normali.
const DROP_VERB = /\b(getta|gettare|gettali|butta|buttare|buttali|droppa|droppare|scarica|scaricare|toss|drop|throw)\b/;
const COLLECT_VERB = /\b(cattura|catturare|catturali|raccogli|raccogliere|raccoglili|pick up|pickup|collect|grab)\b/;
// "raccogli 4 terra" e' una quota di *raccolta* (il vecchio significato: andare
// a prenderne quattro), non un pickup: il numero lo lascia al planner.
// "cattura 5 diamanti" accetta la quota: catturare e' sempre un pickup da terra.
const COLLECT_GATHER_VERB = /\b(raccogli|raccogliere|raccoglili|collect)\b/;
const ANY_NUMBER = /\b\d+\b/;

// L'oggetto nominato, o null: `{token, word}` dal catalogo.
export function orderItem (message, {inventory = {}, drops = []} = {}) {
  return matchItemWordText(message, {names:[...Object.keys(inventory), ...drops.map(drop=>drop.item).filter(Boolean)]});
}

// Quanti pezzi buttare: il primo numero del messaggio ("getta 5 diamanti"),
// altrimenti null = tutto quello che l'oggetto nomina. Le cifre interne a una
// parola ("@bot123") non contano: `\b` non ha confine fra lettera e cifra.
export function dropCountFromText (message) {
  const hit = /\b(\d{1,3})\b/.exec(String(message || ''));
  if (!hit) return /\b(una?|uno|one)\b|\b(drop|throw|toss)\s+(a|an)\s/i.test(String(message || '')) ? 1 : null;
  const count = Number(hit[1]);
  return count > 0 ? count : null;
}

// Attrezzi e armatura: "getta i diamanti" vuole i diamanti, non il piccone di
// diamante (che invece si nomina: "getta il piccone").
const TOOL_ARMOR_SUFFIX = /_(sword|pickaxe|axe|shovel|hoe|helmet|chestplate|leggings|boots)$/;

// Le voci dell'inventario che l'ordine nomina, con quantita' > 0: il piano
// dichiara *cosa* deve uscire, e la verifica confronta quel solo insieme con lo
// snapshot iniziale (`before`). Il nome esatto vince sul resto ("diamond" >
// "diamond_sword"); per un materiale si preferiscono lingotti e grezzi.
export function inventoryMatchingToken (inventory, token) {
  const names = Object.keys(inventory || {})
    .filter(name => Number(inventory[name]) > 0 && matchesItemToken(name, token))
    .sort();
  if (!names.length) return [];
  const exact = names.filter(name => name === String(token || '').toLowerCase());
  if (exact.length) return exact;
  const plain = names.filter(name => !TOOL_ARMOR_SUFFIX.test(name));
  return plain.length ? plain : names;
}

// Quanti pezzi dell'oggetto nominato ci sono in inventario (token 'armor' ->
// i quattro pezzi). E' la base di un ordine "cattura": si confronta il totale,
// non un singolo nome, cosi' un drop arrivato dopo il piano conta comunque.
export function tokenInventoryTotal (inventory, token) {
  return Object.keys(inventory || {}).reduce((sum, name) => sum + (matchesItemToken(name, token) ? Number(inventory[name]) || 0 : 0), 0);
}

export { matchesItemToken };

export function isDropOrder (message, observation) {
  const text = String(message || '').toLowerCase();
  if (!DROP_VERB.test(text)) return false;
  return orderItem(text, observation) != null;
}

export function isCollectOrder (message, observation) {
  const text = String(message || '').toLowerCase();
  if (!COLLECT_VERB.test(text)) return false;
  if (COLLECT_GATHER_VERB.test(text) && ANY_NUMBER.test(text)) return false;
  return orderItem(text, observation) != null;
}

// Una scorta si chiude quando sono arrivati *entrambi*: il bot alla meta e
// l'umano non rimasto indietro. La meta viene dall'ordine (o dal waypoint), la
// distanza dell'umano dalla vista del harness (`observe().escort.gap`), quindi
// il verdetto non dipende dalla stima del modello. Se l'umano non e' tracciato
// non si puo' dichiarare arrivata una scorta di cui non si sa piu' niente.
export function escortFulfilled (escort, obs) {
  const target = escort?.to ?? obs?.plan?.waypoint ?? null;
  const position = obs?.position;
  if (!target || !position) return false;
  if (Math.hypot(target.x - position.x, target.z - position.z) > (escort?.arriveDistance ?? 2)) return false;
  const gap = obs?.escort?.gap;
  if (gap == null) return false;
  return gap <= (obs?.escort?.limits?.maxGap ?? 12);
}

// Un ordine "getta <oggetto>" e' chiuso quando l'oggetto e' uscito
// dall'inventario. Senza una quantita' esplicita l'ordine e' "butta tutto
// quello che hai di questo oggetto": la verifica e' che non ne resti nessuno.
// Con una quantita' si contano i pezzi persi rispetto allo snapshot iniziale
// (`before`), cosi' un drop parziale non chiude l'ordine.
export function dropFulfilled (drop, obs) {
  const inv = obs?.inventory || {};
  const items = Array.isArray(drop?.items) ? drop.items : [];
  if (!items.length) return false;
  const target = Number.isFinite(drop?.count) && drop.count > 0 ? Math.floor(drop.count) : null;
  if (target == null) return items.every(item => Number(inv[item] || 0) === 0);
  const lost = items.reduce((sum, item) => sum + Math.max(0, Number(drop?.before?.[item] || 0) - Number(inv[item] || 0)), 0);
  return lost >= target;
}

// Un ordine "cattura <oggetto>" e' chiuso quando l'inventario ha guadagnato
// almeno un pezzo dell'oggetto nominato rispetto allo snapshot iniziale: la
// raccolta e' del mondo (`observe().drops`), non un target da minare. Il
// confronto e' sul totale del token, non su un elenco di nomi congelato al
// momento del piano: un drop che atterra dopo si chiama comunque cosi'.
export function collectFulfilled (collect, obs) {
  const token = collect?.token ?? null;
  if (!token) return false;
  return tokenInventoryTotal(obs?.inventory, token) > Number(collect?.beforeTotal || 0);
}

// I verbi di fattoria: raccogliere/mietere una coltura. "cattura" non c'e':
// catturare e' sempre un pickup da terra, mietere no. Gli accenti sono gia'
// tolti da `normalizeForMatching` (`recolte`, `cosecha`).
const FARM_VERB = /\b(raccogli|raccogliere|raccoglili|mieti|mietere|raccatta|harvest|reap|pick|collect|gather|recolte\w*|recoge\w*|cosech\w*|ernte\w*)\b/;
// "metti il raccolto nel baule piu' vicino" vs il baule che gia' contiene il
// raccolto (il default: `_depositTargetFor` preferisce quello).
const FARM_NEAREST = /\b(p[iu]u?\s+vicin[oa]|vicin[oa]|nearest|closest|cercano|mas\s+cercano|n[aä]chste\w*)\b/;
const FARM_NO_STORE = /\b(senza|non|no|without)\b[^.]*\b(mett\w*|deposit\w*|baule|scrigni?o|chest|store)\b/;
const FARM_NO_REPLANT = /\b(senza|non|no|without)\b[^.]*\b(rimpiant\w*|ripiant\w*|replant\w*|resow\w*)\b/;

// Un ordine di fattoria: mietere (e ripiantare, e mettere via) *una coltura
// nominata*. E' il classificatore deterministico che sta accanto a
// `isDropOrder`/`isEquipOrder`: "raccogli le carote" davanti a un campo e' un
// ordine di fattoria, non un pickup da terra, e non deve finire in `no_drop`
// ne' in una chiamata al planner. Restano al planner i casi in cui l'umano
// fissa una quota ("raccogli 4 carote") e tutto cio' che non nomina una
// coltura del gioco (`cropBlockForItem` e' la guardia).
export function farmOrderFromText (message) {
  const text = normalizeForMatching(message);
  if (!text || !FARM_VERB.test(text)) return null;
  if (COLLECT_GATHER_VERB.test(text) && ANY_NUMBER.test(text)) return null;
  const item = matchItemWordText(text, { names: [] });
  const crop = item?.token ?? null;
  const block = cropBlockForItem(crop);
  if (!block) return null;
  const seed = seedForCrop(block);
  let store = 'known';
  if (FARM_NO_STORE.test(text)) store = null;
  else if (FARM_NEAREST.test(text)) store = 'nearest';
  return {
    crop,
    block,
    seed,
    word: item?.word ?? crop,
    replant: !FARM_NO_REPLANT.test(text),
    store,
    field: null,
  };
}

// Quante mietiture al massimo in un ordine: il campo puo' essere grande, ma
// un ordine di chat resta bounded (l'harness continua a offrire
// `harvest_<coltura>` finche' c'e' una pianta matura a tiro).
export const DEFAULT_FARM_MAX_HARVES = 8;

// Quali passi della catena sono possibili *adesso*, secondo l'harness.
// L'ordine e': il drop del raccolto a terra (prima che sparisca), la mietitura
// della coltura matura, la semina di compensazione, il deposito del raccolto.
// Ogni passo esiste solo se `/options` lo offre: il controller non inventa key.
export function farmStep (farm, obs, options = [], { progress = null, maxHarves = DEFAULT_FARM_MAX_HARVES } = {}) {
  if (!farm?.crop) return null;
  let offered = null;
  if (options instanceof Set) offered = options;
  else offered = new Set((options || []).map(option => (typeof option === 'string' ? option : option?.key)).filter(Boolean));
  const crop = farm.crop;
  const block = farm.block ?? cropBlockForItem(crop);
  const seed = farm.seed ?? seedForCrop(block);
  // 1. Il raccolto e' a terra: si raccoglie prima che sparisca (allora l'ordine
  //    e' davvero un pickup, e il passo resta nel vocabolario del drop).
  const ground = (obs?.drops || []).filter(drop => drop?.item && matchesItemToken(drop.item, crop));
  if (ground.length && offered.has('collect_drop')) return { key: 'collect_drop', phase: 'collect' };
  // 2. Mietitura: l'harness offre `harvest_<blocco>` solo con una pianta matura
  //    raggiungibile, quindi la sua presenza *e'* la prova che c'e' da mietere.
  const harvestKey = block ? `harvest_${block}` : null;
  if (harvestKey && offered.has(harvestKey) && (progress?.harvests ?? 0) < maxHarves) {
    return { key: harvestKey, phase: 'harvest' };
  }
  // 3. Semina di compensazione: `harvest_<coltura>` ripianta da se' quando ha un
  //    seme; si semina qui solo quando l'ultima mietitura non c'e' riuscita,
  //    cosi' un ordine non semina il villaggio intero.
  const plantKey = seed ? `plant_${seed}` : null;
  if (farm.replant !== false && plantKey && offered.has(plantKey) && progress?.needsPlant === true) {
    return { key: plantKey, phase: 'plant' };
  }
  // 4. Deposito: solo il raccolto *guadagnato* in questo ordine (il delta
  //    rispetto allo snapshot iniziale), mai le scorte che c'erano gia'.
  const held = Number(obs?.inventory?.[crop] ?? 0);
  const start = Number(farm.before?.inventory?.[crop] ?? 0);
  if (farm.store && held > start) {
    const depositKey = `deposit_${crop}`;
    const preferred = farm.store === 'nearest' ? ['dump_inventory', depositKey] : [depositKey, 'dump_inventory'];
    const found = preferred.find(key => offered.has(key));
    if (found) return { key: found, phase: 'store' };
  }
  return null;
}

// Quanto raccolto di questa coltura risulta *depositato* (delta rispetto allo
// snapshot iniziale). La lettura e' del harness: contenuti noti della cache
// (`observe().containers`) piu' il registro (`observe().storage.known`),
// deduplicati per posizione. Un contenitore ispezionato due volte non conta
// due volte, e un contenuto mai letto non conta affatto.
export function farmStored (farm, obs) {
  const crop = farm?.crop ?? null;
  if (!crop) return 0;
  const rows = [
    ...(obs?.containers || []).filter(row => row?.position && row?.contents),
    ...((obs?.storage?.known) || []).filter(row => row?.position && row?.contains),
  ];
  const seen = new Set();
  let total = 0;
  for (const row of rows) {
    const key = `${row.position.x},${row.position.y},${row.position.z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const contents = row.contents ?? row.contains ?? {};
    total += Number(contents?.[crop] ?? 0);
  }
  return total;
}

// Lo snapshot prima dell'ordine: inventario (delta del raccolto) piu' quanto
// raccolto era gia' nei bauli noti (delta del deposito).
export function farmSnapshot (obs, crop) {
  return {
    inventory: { [crop]: Number(obs?.inventory?.[crop] ?? 0) },
    contained: farmStored({ crop }, obs),
    at: Date.now(),
  };
}

// Un ordine di fattoria e' chiuso quando il raccolto e' finito *nel baule*: il
// contenuto noto e' cresciuto e in zaino non ne resta piu' del necessario (il
// seme di una rimpiantatura e' 1 pezzo). L'evidenza e' un delta di stato, mai
// la parola del modello.
export function farmFulfilled (farm, obs) {
  const crop = farm?.crop ?? null;
  if (!crop) return false;
  const stored = farmStored(farm, obs) - Number(farm.before?.contained ?? 0);
  const held = Number(obs?.inventory?.[crop] ?? 0) - Number(farm.before?.inventory?.[crop] ?? 0);
  return stored > 0 && held <= 0;
}

// L'esito misurato di un ordine di fattoria: quanto raccolto e' entrato negli
// scrigni e quanto e' rimasto in zaino, per l'avviso in chat e per i log.
export function farmOutcome (farm, obs) {
  const crop = farm?.crop ?? null;
  if (!crop) return { crop: null, held: 0, stored: 0, gained: 0 };
  const stored = farmStored(farm, obs) - Number(farm.before?.contained ?? 0);
  const held = Number(obs?.inventory?.[crop] ?? 0);
  const gained = Number(obs?.inventory?.[crop] ?? 0) - Number(farm.before?.inventory?.[crop] ?? 0) + stored;
  return { crop, held, stored, gained };
}

// Le key del vocabolario del harness che un ordine di fattoria puo' usare
// vivono in `farmOptionKeys` (`bedrock-survival.mjs`): le usa la rotta
// `/options` del harness per tenere l'ordine umano al riparo dal filtro di
// emergenza, perche' `plant_*`, `deposit_*` e `dump_inventory` hanno intento
// ignoto.

// Consecutive trailing executions of `key` without progress. A successful
// action (stagnant: false) or a different key resets the streak.
export function detectRepeatedAction (history = [], key, { threshold = DEFAULT_ANTI_LOOP_THRESHOLD } = {}) {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (!entry || entry.key !== key || !entry.stagnant) break;
    count++;
  }
  return { repeated: count >= threshold, count };
}

// What to pass to the model this step. Never returns an empty set and never
// hides a key that is the only remaining option: the harness owns validity.
export function filterOptions (options, history = [], {
  max = DEFAULT_MAX_OPTIONS,
  threshold = DEFAULT_ANTI_LOOP_THRESHOLD,
  targets = {},
  preferredIntents = [],
  excludeKeys = [],
} = {}) {
  const excluded = [];
  let kept = [...options];
  // Explicit exclusions: last failed action, anti-loop cooldowns.
  const explicit = new Map(excludeKeys.map(e => [e.key, e.reason || 'excluded']));
  for (const option of kept) {
    if (explicit.has(option.key)) excluded.push({ key: option.key, reason: explicit.get(option.key) });
  }
  kept = kept.filter(o => !explicit.has(o.key));
  // `wait` is a last resort: hide it whenever something else is available.
  if (kept.length > 1 && kept.some(o => o.key === 'wait')) {
    excluded.push({ key: 'wait', reason: 'wait_not_useful' });
    kept = kept.filter(o => o.key !== 'wait');
  }
  // Anti-loop: hide keys that just ran `threshold` times with no progress,
  // unless they are all that is left.
  const stagnant = [];
  for (const option of kept) {
    const { repeated, count } = detectRepeatedAction(history, option.key, { threshold });
    if (repeated) stagnant.push({ key: option.key, count });
  }
  let note = null;
  if (stagnant.length && stagnant.length < kept.length) {
    excluded.push(...stagnant.map(s => ({ key: s.key, reason: `stagnant_${s.count}` })));
    kept = kept.filter(o => !stagnant.some(s => s.key === o.key));
  } else if (stagnant.length) {
    note = 'all_stagnant';
  }
  const { options: capped, dropped } = capOptions(kept, { max, targets, preferredIntents });
  if (!capped.length) {
    // Never hand an empty set to the model: the harness said these keys are valid.
    const nonWait = options.filter(o => o.key !== 'wait');
    const restored = nonWait.length ? nonWait : options;
    return { options: restored, excluded, dropped: [], note: 'fallback_restored', fallback: { reason: 'filters_left_empty_set' } };
  }
  return { options: capped, excluded, dropped, note, fallback: null };
}

// Why the harness offered only `wait`, derived from the observation.
export function waitOnlyReason (obs) {
  if (!obs?.spawned || (obs.status && obs.status !== 'spawned')) return 'not_connected';
  if (obs.dead) return 'dead';
  if (obs.sleeping) return 'sleeping';
  if (!obs.position) return 'no_position';
  return 'no_useful_options';
}

export function summarizePlan (plan = {}) {
  const parts = [];
  if (plan.objective) parts.push(`Objective: ${plan.objective}`);
  if (plan.skill) parts.push(`Skill: ${plan.skill}`);
  if (plan.targets && Object.keys(plan.targets).length) parts.push(`Targets: ${JSON.stringify(plan.targets)}`);
  if (plan.waypoint) parts.push(`Waypoint: ${JSON.stringify(plan.waypoint)}`);
  if (plan.notes) parts.push(`Notes: ${plan.notes}`);
  return parts.join(' | ') || 'No plan.';
}

// Instructions for the decision model: explicit survival priorities and the
// no-progress rule, which the old prompt did not state.
export function buildDecisionInstructions (plan = {}) {
  return [
    'You control a Minecraft player.',
    summarizePlan(plan),
    'Follow this priority order:',
    '1. Survival: if a hostile mob is close and health is low (or the fight cannot be won), flee; if it is night and a bed is within reach with no immediate threat, sleep; if hunger is low and food is in inventory, eat; attack only when health is high enough to win.',
    '2. Recover: pick up nearby drops before they expire; if a death site is listed, go back and recover the dropped items and XP.',
    '3. Objective: otherwise pick the action that makes the most progress on the objective now.',
    'Never repeat an action that just produced no progress (same position, inventory and objective): choose a different action instead.',
    'Choose wait only when it is the only option offered or when nothing else can help.',
  ].join(' ');
}
