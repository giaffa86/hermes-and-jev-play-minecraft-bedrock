// R2 — la porta della chiarificazione: «cosa manca perché questo ordine sia
// eseguibile?»
//
// Un ordine che *chiede una meta* e non ne porta una non è un ordine: è una
// domanda che l'umano ha dimenticato di fare. Il bot non deve indovinare (oggi
// ripiega su «seguo chi mi ha scritto», che è una risposta giusta a
// un'altra domanda). Deve **chiedere**, una volta sola, la cosa che solo l'umano
// può decidere — e la risposta non è un ordine nuovo, è la fine di quello
// vecchio.
//
// Questo modulo è **puro**: nessun I/O proprio, nessun modello, nessun clock.
// Tutto ciò che sa del mondo entra dai parametri — il piano che il planner ha
// prodotto (`plan`), l'osservazione (`obs`) e la memoria, che è una **porta**
// (`memory.places(name)`, iniettabile: nei test è un finto, in produzione è la
// rotta `/memory/places` dell'harness).
//
// Cosa NON fa, ed è la parte importante (la scala «resolve before asking»):
//  - non chiede quando il piano ha **già** una meta in XZ (`waypoint`,
//    `escort.to`): qualcuno l'ha risolta;
//  - non chiede quando l'ordine è un **follow** («seguimi», «resta qui», «vieni
//    da me»): lì la meta *è* il mittente, per costruzione;
//  - non chiede quando la frase nomina un **item** («portami del cibo», «vai a
//    prendere la spada»): è un ordine di raccolta, non un movimento verso un
//    posto. Questa lettura vince su quella di luogo, perché le stesse parole
//    («campo di patate») possono essere un oggetto: nel dubbio non si chiede;
//  - non chiede quando la memoria **conosce** il nome: quella meta è risolvibile
//    (il percorso dei fatti dettati la risolve prima di qui);
//  - non chiede quando la memoria **non risponde**: un guasto non deve
//    trasformare ogni ordine in un interrogatorio (fail-open);
//  - non chiede quando l'ordine è un'attività («vai a dormire», «vai a minare»):
//    non è una destinazione.

import { t, DEFAULT_LANG } from './chat-i18n.mjs';
import { matchItemWordText } from './human-questions.mjs';
import { foldText, coordsFromText, extractGoToName } from './memory-chat.mjs';

// Gli esiti. `ready` = l'ordine è eseguibile così com'è (il caso normale: questa
// porta non cambia niente), `needs_input` = manca una scelta dell'umano.
export const CLARIFY_READY = 'ready';
export const CLARIFY_NEEDS_INPUT = 'needs_input';

// Che cosa manca. `destination` = la meta non c'è proprio; `place` = il nome c'è
// ma il bot non sa dove sia.
export const CLARIFY_FIELD = Object.freeze({ DESTINATION: 'destination', PLACE: 'place' });

// Perché manca. I motivi sono una lista chiusa: finiscono nel log e nel
// messaggio, quindi si aggiungono qui, mai con una stringa inventata altrove.
export const CLARIFY_REASON = Object.freeze({
  NO_DESTINATION: 'no_destination', // «vai» / «andiamo»: nessuna meta
  UNKNOWN_PLACE: 'unknown_place',   // «vai al rifugio»: la memoria non lo conosce
});

// Una frase-ordine è breve (stessa soglia di `memory-chat.mjs`): oltre, è un
// discorso, e un falso positivo qui chiederebbe a vuoto.
const MAX_MESSAGE = 240;

// Verbi che *nominano una meta*: «vai al …», «portami …», «guidami fino a …».
// «vieni» e «segui» non stanno qui: la loro meta è il mittente (vedi FOLLOW).
const GO_VERB = /(?:\b(?:vai|va'|va|andiamo|raggiungi|dirigiti|muoviti|torna|ritorna|riportami|portami|guidami|accompagnami|scortami)\b|\b(?:go to|go|head to|walk to|travel to|take me|lead me|bring me)\b|\b(?:vas-y|va|rejoins|rends-toi|amene-moi|allons)\b|\b(?:ve a|vete a|vamos|llevame|guiame|dirigete|dirigete)\b|\b(?:geh|geh zu|bring mich|fuhre mich|lauf zu|fahr zu|gehen wir)\b)/;

// Verbi in cui la meta **è la persona che scrive**: «seguimi», «resta qui»,
// «vieni da me». Non sono un buco: sono una risposta.
const FOLLOW_VERB = /(?:\b(?:segui|seguimi|seguite|resta|rimani|rimanete|stai|state|stammi vicino|stai vicino|vieni|vieni qui|vieni da me|vieni con me|vienimi dietro)\b|\b(?:follow|follow me|stay|stay here|stay with me|come|come here|come with me)\b|\b(?:suis-moi|suivez-moi|reste|reste ici|viens|viens avec moi)\b|\b(?:sigueme|sigueme|quedate|ven|ven aqui|ven conmigo)\b|\b(?:folge|folge mir|bleib|bleib hier|komm|komm her|komm mit)\b)/;

// «qui», «dove mi trovo»: come sopra, la posizione è del mittente. Il controller
// la risolve dall'osservazione, e se non lo vede lo dice lui (`no_sender_position`).
const HERE = /(?:\b(?:qui|qua|questo posto|questo punto|dove mi trovo|dove sono)\b|\b(?:here|this spot|right here|where i am)\b|\b(?:ici|ce point|ou je suis)\b|\b(?:aqui|este punto|donde estoy)\b|\b(?:hier|dieser punkt|wo ich bin)\b)/;

// Un verbo di *attività*, non un posto: «vai a dormire», «vai a minare», «vai a
// vedere». Senza questo elenco «vai a dormire» diventerebbe «non conosco
// "dormire": dov'è?» — una domanda stupida su una frase che non nominava un
// posto. È una lista chiusa e curata: i verbi di gioco sono pochi e stabili.
const ACTIVITY = /^(?:dormire|dormi|mangiare|mangia|mangià|minare|mina|minà|scavare|scava|costruire|costruisci|piantare|pianta|raccogliere|raccogli|coltivare|coltiva|combattere|combatti|esplorare|esplora|lavorare|lavora|riposare|riposa|aspettare|aspetta|nuotare|nuota|pescare|pesca|vedere|vedi|controllare|controlla|prendere|prendi|portare|consegnare|tagliare|taglia|uccidere|ammazzare|bruciare|cucinare|riempire|svuotare|mettere|metti|aprire|apri|chiudere|chiudi|sistemare|sistema|riparare|ripara|cercare|cerca|trovare|trova|sleep|eat|mine|dig|build|plant|harvest|farm|fight|explore|work|rest|wait|swim|fish|see|check|take|bring|deliver|cut|kill|burn|cook|fill|empty|put|open|close|fix|repair|search|find|dormir|manger|miner|creuser|construire|planter|recolter|cultiver|combattre|explorer|travailler|reposer|attendre|nager|pecher|voir|verifier|prednre|prendre|apporter|couper|tuer|bruler|cuisiner|remplir|vider|mettre|ouvrir|fermer|reparer|chercher|trouver|dormir|comer|minar|cavar|construir|plantar|recolectar|cultivar|combatir|explorar|trabajar|descansar|esperar|nadar|pescar|ver|comprobar|tomar|traer|entregar|cortar|matar|quemar|cocinar|llenar|vaciar|poner|abrir|cerrar|arreglar|buscar|encontrar|schlafen|essen|graben|bauen|pflanzen|ernten|kampfen|erkunden|arbeiten|ausruhen|warten|schwimmen|fischen|sehen|prufen|nehmen|bringen|liefern|schneiden|toten|verbrennen|kochen|fullen|leeren|setzen|offnen|schliessen|reparieren|suchen|finden)$/;

// La risposta a una domanda non è un ordine nuovo: è **la fine di quello
// vecchio**. Le due parti si uniscono perché il planner veda una frase sola
// («vai al rifugio» + «coordinate 120 64 -230»).
export function mergeClarifyAnswer (originalText, answer) {
  const first = String(originalText ?? '').trim();
  const second = String(answer ?? '').trim();
  if (!first) return second;
  if (!second) return first;
  if (first === second) return first;
  return `${first} ${second}`;
}

function hasXZ (value) {
  return Number.isFinite(value?.x) && Number.isFinite(value?.z);
}

// Il piano ha già una meta in XZ? `waypoint` (movimento) o `escort.to` (scorta).
// `follow` da solo **non** conta: è il nome di una persona, non una posizione — e
// il fallback del planner lo mette sempre, anche quando non ha capito niente.
export function planHasDestination (plan) {
  if (!plan || typeof plan !== 'object') return false;
  if (hasXZ(plan.waypoint)) return true;
  if (hasXZ(plan.escort?.to)) return true;
  return false;
}

// Un ordine che *non è* un movimento: costruzione, raccolta, fattoria, gettare,
// equipaggiamento, o un target da minare. Per tutti questi la meta non serve (o
// è già un'altra cosa), quindi la porta non si apre.
export function planIsOtherOrder (plan) {
  if (!plan || typeof plan !== 'object') return false;
  if (plan.construction) return true;
  if (plan.collect) return true;
  if (plan.farm) return true;
  if (plan.drop) return true;
  if (plan.equip) return true;
  if (plan.need) return true;
  if (plan.escort) return true;
  if (plan.targets && typeof plan.targets === 'object' && Object.keys(plan.targets).length) return true;
  return false;
}

// Un *partitivo* davanti al nome è la prova che il nome è un **oggetto**, non un
// posto: «portami del cibo», «prendi della legna», «dammi un po' di pane»,
// «bring me some food». La lingua lo dice con la preposizione, e il bot la
// ascolta: senza questo, «portami del cibo» diventerebbe «non conosco "cibo":
// dov'è?», che è la domanda sbagliata su una frase che non parlava di un posto.
// (`extractGoToName` *rimuove* la preposizione dal nome, quindi il partitivo si
// cerca nel testo, non nel nome — ma il nome può anche *iniziare* con esso,
// come in «some food`.)
const PARTITIVE_HEAD = /^(?:del|dello|della|dei|degli|delle|du|des|some|any|etwas|algo de|un poco de|un po di)\b/;
const PARTITIVE_BEFORE = /\b(?:del|dello|della|dei|degli|delle|du|des|some|any|etwas|algo de|un poco de|un po di)\s+$/;

function escapeRegExp (value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// La memoria è una porta: `{ places(name) -> {places:[...]} }`. `null` quando la
// porta manca o non risponde — e allora non si chiede (fail-open).
async function lookupPlaces (memory, name) {
  if (!memory || typeof memory.places !== 'function') return null;
  try {
    const out = await memory.places(name, { limit: 5 });
    if (out?.error) return null;
    return Array.isArray(out?.places) ? out.places : null;
  } catch {
    return null;
  }
}

// La porta. Ritorna sempre un oggetto: `{status, missing, question, options}`.
// `missing` è una lista (oggi al massimo un elemento) perché il formato non
// cambi quando i vuoti saranno due.
export async function orderGaps (text, plan, obs, { memory = null, lang = DEFAULT_LANG, names = null } = {}) {
  const ready = { status: CLARIFY_READY, missing: [], question: null, options: [] };
  const raw = String(text ?? '').trim();
  if (!raw || raw.length > MAX_MESSAGE) return ready;
  const folded = foldText(raw);
  // 1. Non chiede una meta: non è questa porta.
  if (!GO_VERB.test(folded)) return ready;
  // 2. La meta c'è già, oppure l'ordine è di un altro tipo.
  if (planHasDestination(plan) || planIsOtherOrder(plan)) return ready;
  // 3. La meta è il mittente: follow, «qui», o coordinate già scritte.
  const coords = coordsFromText(folded);
  if (FOLLOW_VERB.test(folded) || HERE.test(folded) || coords?.kind === 'full') return ready;
  const itemNames = Array.isArray(names)
    ? names
    : [...Object.keys(obs?.inventory ?? {}), ...(Array.isArray(obs?.drops) ? obs.drops.map(d => d?.item).filter(Boolean) : [])];
  // 4. Un nome di meta c'è.
  const name = extractGoToName(raw);
  if (name) {
    // 4a. È un'attività, non un posto («vai a dormire»).
    const head = foldText(name).split(' ')[0];
    if (ACTIVITY.test(head)) return ready;
    // 4b. Un partitivo: è un oggetto, non un posto («portami del cibo»).
    const foldedName = foldText(name);
    if (PARTITIVE_HEAD.test(foldedName)) return ready;
    // Il partitivo può stare *prima* del nome, e `extractGoToName` lo ha già
    // tolto: lo si cerca nel testo, subito prima di dove il nome compare.
    const before = new RegExp(`${PARTITIVE_BEFORE.source.replace(/\$$/, '')}${escapeRegExp(foldedName)}\\b`);
    if (before.test(folded)) return ready;
    // 4c. La memoria lo conosce: la meta è risolvibile (e i fatti dettati la
    //     risolvono prima di arrivare qui).
    const places = await lookupPlaces(memory, name);
    if (places === null) return ready;
    if (places.length > 0) return ready;
    // 4d. Il nome contiene un item: è un oggetto, non un posto («vai a prendere
    //     la spada»). Nel dubbio non si chiede.
    if (matchItemWordText(name, { names: itemNames })) return ready;
    // 4e. Un nome che il bot non ha mai sentito: dove sta? Glielo dice l'umano.
    return {
      status: CLARIFY_NEEDS_INPUT,
      missing: [{ field: CLARIFY_FIELD.PLACE, reason: CLARIFY_REASON.UNKNOWN_PLACE, name }],
      question: t(lang, 'clarify_unknown_place', { name }),
      options: [],
    };
  }
  // 5. Nessun nome, nessun item: manca la meta. È il buco vero.
  if (matchItemWordText(raw, { names: itemNames })) return ready;
  return {
    status: CLARIFY_NEEDS_INPUT,
    missing: [{ field: CLARIFY_FIELD.DESTINATION, reason: CLARIFY_REASON.NO_DESTINATION }],
    question: t(lang, 'clarify_destination'),
    options: [],
  };
}

// Una risposta allude all'ordine trattenuto, o è un ordine a sé? «coordinate 120
// 64 -230» e «dove sono adesso» **completano** l'ordine; «vai al mulino» e
// «vieni da me» lo **sostituiscono** (l'umano ha cambiato idea, e non c'è più
// niente da completare). Le coordinate da sole non bastano a fare un ordine: da
// sole non nominano una meta, quindi si uniscono.
export function restatesOrder (text) {
  const folded = foldText(String(text ?? '').trim());
  if (!folded || folded.length > MAX_MESSAGE) return false;
  return GO_VERB.test(folded) || FOLLOW_VERB.test(folded);
}

// Il rifiuto: si chiede **una volta sola** per ordine. Se anche la risposta non
// basta, non si apre un secondo giro — si dice che non si è capito e l'ordine
// muore lì (una domanda che si ripete è un bot che non ascolta).
export function renderClarifyRefusal ({ lang = DEFAULT_LANG } = {}) {
  return t(lang, 'clarify_refusal');
}
