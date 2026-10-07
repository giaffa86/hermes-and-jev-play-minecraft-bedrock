// Fatti dettati in chat — il riconoscimento, non l'esecuzione.
//
// «ricordati che il ferro sta nel baule a 120, 64, -230», «il punto dove mi trovo
// adesso è il campo di patate», «dov'è il campo di patate?», «l'ingresso della
// miniera ora è a 130, 62, -240», «dimentica il vecchio deposito», «vai al campo
// di patate».
//
// Questo modulo è **puro**: traduce il testo di un umano in un intento
// (`toldIntentFromText`). Non parla con l'harness, non tocca la memoria, non
// conosce il piano: chi esegue è `controller.mjs` (rotte `/memory/tell/*`), e la
// *disambiguazione* resta sua — qui si dice solo che un nome è stato nominato,
// mai quale dei due omonimi sia quello giusto.
//
// Tre regole che vengono da lì:
//  - le coordinate si leggono **solo** con un marcatore esplicito (la parola
//    "coordinate", gli assi `x= y= z=`, una terna separata da virgole, o una
//    terna preceduta da una preposizione di luogo). Tre numeri in mezzo a una
//    frase non sono una posizione: sono un ordine incompleto, e si chiede.
//  - un ordine riconosciuto ma incompleto **non scrive niente** (`CLARIFY`).
//  - «qui / dove mi trovo» non è una posizione: è un rinvio al mittente, che il
//    controller risolve dall'osservazione (e se non lo vede, chiede).

import { matchItemWordText, looksLikeQuestion } from './human-questions.mjs';

const APOSTROPHES = /[\u2018\u2019\u02bc`´]/g;

// Minuscole, apostrofi dritti, accenti tolti: le regex qui sotto lavorano su
// questo testo, così «dov'è», «dove», «DOV'É» e «coordonnées»/«coordonnees»
// sono la stessa cosa. Il *nome* del luogo continua a viaggiare come l'ha
// scritto l'umano.
export function foldText (value) {
  return String(value ?? '')
    .replace(APOSTROPHES, "'")
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeApostrophes (value) {
  return String(value ?? '').replace(APOSTROPHES, "'").replace(/\s+/g, ' ').trim();
}

// Le quattro operazioni, più il movimento per nome (che *usa* la memoria invece
// di scriverla: è un ordine di movimento, non una modifica).
export const TELL = Object.freeze({
  REMEMBER_PLACE: 'remember_place',
  REMEMBER_CONTAINER: 'remember_container',
  REMEMBER_CONTENTS: 'remember_contents',
  CORRECT_PLACE: 'correct_place',
  FORGET_PLACE: 'forget_place',
  CONSULT: 'consult_memory',
  GOTO_PLACE: 'goto_place',
});

// `{kind: CLARIFY, reason}`: la frase è stata riconosciuta come un'operazione di
// memoria, ma manca qualcosa per eseguirla. Motivi: `no_name`, `no_position`,
// `no_marker` (numeri senza marcatore), `no_sender_position` (ha detto "qui" e
// non lo vedo).
export const CLARIFY = 'clarify';

// Una frase dettata è breve. Oltre questa soglia non si prova nemmeno: un
// messaggio lungo è un discorso, e un falso positivo qui scriverebbe in memoria.
const MAX_MESSAGE = 240;

const REMEMBER_VERB = /(?:\b(?:ricordati|ricordate|ricorda|ricordami|ricordamelo|ricordatelo|memorizza|memorizzare|registra|registrare|segnati|segna|annota|appunta|tieni a mente|prendi nota|impara)\b|\b(?:remember|note down|note|register|record|write down|keep in mind|mark)\b|\b(?:rappelle-toi|retiens|souviens-toi|enregistre|memorise|garde en tete)\b|\b(?:recuerda|acuerdate|apunta|anota|registra|memoriza|ten en cuenta)\b|\b(?:merk dir|merke|erinnere dich|notiere|speichere|registriere|denk daran)\b)/;

const FORGET_VERB = /(?:\b(?:dimentica|dimenticati|dimenticate|scorda|scordati|oblia|rimuovi dalla memoria|cancella dalla memoria|togli dalla memoria)\b|\b(?:forget|remove from memory|delete from memory|erase from memory)\b|\b(?:oublie|supprime de la memoire|efface de la memoire)\b|\b(?:olvida|borra de la memoria|elimina de la memoria)\b|\b(?:vergiss|losche aus dem gedachtnis|entferne aus dem gedachtnis)\b)/;

const CORRECT_VERB = /(?:\b(?:correggi|correggere|aggiorna|aggiornare|rettifica|non e'? piu|non sta piu|si e'? spostat[oa]|ho spostat[oa]|ho cambiat[oa]|ora e'? a|adesso e'? a)\b|\b(?:correct|update|it moved|has moved|no longer|is now)\b|\b(?:corrige|mets a jour|n'est plus|est maintenant)\b|\b(?:corrige|actualiza|ya no|ahora esta)\b|\b(?:korrigiere|aktualisiere|nicht mehr|ist jetzt)\b)/;

const TIME_NOW = /\b(?:ora|adesso|now|maintenant|ahora|jetzt)\b/;

// "qui", "questo", "il punto dove mi trovo": il mittente è la posizione.
const HERE = /(?:\b(?:qui|qua|questo|questa|questo punto|il punto dove mi trovo|il punto in cui mi trovo|dove mi trovo|dove sono)\b|\b(?:right here|here|this spot|this|the spot where i am|where i am)\b|\b(?:ici|ce point|ou je suis)\b|\b(?:aqui|este punto|donde estoy)\b|\b(?:hier|dieser punkt|wo ich bin)\b)/;

const WHERE = /(?:\b(?:dove|dov'e|dove sta|dove si trova|in che posto)\b|\b(?:where|where is|where's)\b|\b(?:ou est|ou se trouve)\b|\b(?:donde esta|donde hay|donde se encuentra)\b|\b(?:wo ist|wo finde ich|wo liegt)\b)/;

// "dove sei?", "che cosa stai facendo?": non è una domanda sulla memoria, è una
// domanda sul bot — la risponde il percorso delle domande, non questo.
const SELF_REF = /(?:\b(?:sei|stai|ti trovi|ti sei messo|state|siete)\b|\b(?:are you|do you|you)\b|\b(?:es-tu|tu es)\b|\b(?:estas|te encuentras)\b|\b(?:bist du)\b)/;

const GOTO_VERB = /(?:\b(?:vai|va'|va|andiamo|raggiungi|portami|guidami|accompagnami|dirigiti|muoviti|torna)\b|\b(?:go to|go|head to|walk to|take me|bring me|lead me)\b|\b(?:vas-y|rejoins|rends-toi|amene-moi)\b|\b(?:ve a|vete a|llevame|guiame)\b|\b(?:geh zu|geh|bring mich|fuhre mich|lauf zu)\b)/;

const GOTO_PREP = /\b(?:a|al|allo|alla|ai|agli|alle|da|verso|presso|in|nel|nella|sul|sulla|to|into|towards|at|for|au|aux|a la|chez|vers|dans|en|hacia|zu|zum|zur|nach|bei|auf)\b/;

// Un verbo di posizione: senza verbo e senza coordinate, una frase non è una
// dichiarazione ("il campo di patate" da sola non dice dove sia).
const POS_VERB = /\b(?:e|e'|sta|stanno|si trova|si trovano|sono|sorge|si chiama|is|are|ist|sind|est|es|se trouve|se trouvent|corrisponde|esta|estan|se encuentra|steht|liegt|heisst)\b/;

// «nel baule», «dans le coffre», «in der Truhe». La parola è anche il nome del
// contenitore quando l'umano non gliene dà uno migliore ("baule di casa").
const CONTAINER_WORD = /\b(?:baule|bauli|cassapanca|cassa|casse|forziere|forzieri|deposito|botte|bidone|barile|shulker|chest|crate|barrel|coffre|cofre|baul|truhe|kiste|fass)\b/;

const COORD_WORD = /\b(?:coordinate|coordinata|coordinat[ei]|coord|coords|koordinaten|coordonnees|coordenadas|posizione|position)\b/;

// Il testo che introduce una terna: il marcatore, le preposizioni di luogo, i
// verbi di posizione ridotti a "sta / è / si trova". Fra l'introduzione e i
// numeri può stare un'altra preposizione ("sta **a** 130 62 -240",
// "is **at** coordinates 120 64 -230").
const COORD_INTRO = '(?:coordinate|coordinata|coordinat[ei]|coord|coords|koordinaten|coordonnees|coordenadas|posizione|position|sta|stanno|si trova|si trova|si trovano|sorge|is|are|ist|sind|est|es|esta|estan|se trouve|se trouvent|corrisponde|a|al|allo|alla|ai|agli|alle|da|nel|nella|nello|in|to|at|au|aux|chez|vers|dans|en|zu|zum|zur|nach|bei|auf)';
const COORD_FILLER = '(?:\\s+(?:a|al|allo|alla|ai|agli|alle|da|nel|nella|nello|in|to|at|en|au|aux|zu|zum|zur|nach|vers|hacia|dans|bei|de)){0,2}';
const NUM = '-?\\d{1,9}';
const TRIPLE = `(${NUM})\\s*[,;]?\\s+(${NUM})\\s*[,;]?\\s+(${NUM})(?![\\d])`;
const ANY_TRIPLE = `${NUM}(?:\\s*[,;]\\s*|\\s+)-?\\d{1,9}(?:\\s*[,;]\\s*|\\s+)-?\\d{1,9}`;

// Tutte le terne viste in una frase. Le coordinate *vere* (valide) escono da
// qui; i numeri sciolti no.
function coordMatches (folded) {
  const out = [];
  // 1. assi etichettati: x=120 y=64 z=-230 (bastano x, y e z).
  const axes = {};
  for (const m of folded.matchAll(/(?:^|[^a-z0-9_])([xyz])\s*(?:=|:)?\s*(-?\d+)(?![0-9])/g)) {
    if (axes[m[1]] === undefined) axes[m[1]] = Number(m[2]);
  }
  if (['x', 'y', 'z'].every((k) => axes[k] !== undefined)) {
    out.push({ position: { x: axes.x, y: axes.y, z: axes.z }, via: 'axes' });
  } else if (['x', 'z'].every((k) => axes[k] !== undefined)) {
    out.push({ partial: [axes.x, axes.z], via: 'axes' });
  }
  // 2. un'introduzione seguita da tre numeri.
  const marker = new RegExp(`\\b${COORD_INTRO}\\b${COORD_FILLER}\\s*(?:[:=]\\s*)?${TRIPLE}`).exec(folded);
  if (marker) out.push({ position: { x: Number(marker[1]), y: Number(marker[2]), z: Number(marker[3]) }, via: 'marker' });
  // 3. una terna separata da virgole: la punteggiatura è già un marcatore.
  for (const m of folded.matchAll(new RegExp(`(${NUM})\\s*[,;]\\s*(${NUM})\\s*[,;]\\s*(${NUM})(?![\\d])`, 'g'))) {
    out.push({ position: { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) }, via: 'commas' });
  }
  // 4. tre numeri preceduti da una preposizione di luogo ("a 120 64 -230").
  for (const m of folded.matchAll(new RegExp(`\\b(?:a|al|allo|alla|ai|agli|alle|at|in|en|bei|zu|zum|zur|nach|verso|presso)${COORD_FILLER}\\s+${TRIPLE}`, 'g'))) {
    out.push({ position: { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) }, via: 'prep' });
  }
  // 5. due numeri con il marcatore: coordinate incomplete (manca una quota).
  const pair = new RegExp(`\\b${COORD_WORD.source}\\b${COORD_FILLER}\\s*(?:[:=]\\s*)?(${NUM})\\s*[,;]?\\s+(${NUM})(?![\\d])`).exec(folded);
  if (pair) out.push({ partial: [Number(pair[1]), Number(pair[2])], via: 'marker' });
  return out;
}

// Una posizione ha senso solo dentro il mondo: la terna di una frase qualunque
// no ("ho 3 bauli, 2 forse 1 no").
export function isWorldPosition (position) {
  if (!position) return false;
  const { x, y, z } = position;
  if (![x, y, z].every((v) => Number.isInteger(v))) return false;
  if (Math.abs(x) > 30000000 || Math.abs(z) > 30000000) return false;
  return y >= -64 && y <= 320;
}

// Le coordinate di una frase. `{kind:'full', position}` quando c'è una terna
// valida, `{kind:'partial', numbers}` quando la frase *dichiara* coordinate ma
// non sono tre (o non hanno un marcatore: si chiede, non si inventa), `null`
// quando non ce ne sono affatto.
export function coordsFromText (text) {
  const folded = foldText(text);
  if (!folded) return null;
  const hits = coordMatches(folded);
  for (const hit of hits) {
    if (hit.position && isWorldPosition(hit.position)) return { kind: 'full', position: hit.position, via: hit.via };
  }
  for (const hit of hits) {
    if (hit.partial) return { kind: 'partial', numbers: hit.partial, via: hit.via };
  }
  // Tre numeri senza marcatore: è quasi sempre una posizione scritta male.
  const loose = folded.match(/\b-?\d{1,9}\b[^\d]*-?\d{1,9}\b[^\d]*-?\d{1,9}\b/);
  if (loose) return { kind: 'partial', numbers: loose[0].match(/-?\d{1,9}/g).map(Number), via: 'loose' };
  return null;
}

// In quale dimensione: solo quando la frase lo dice. Altrimenti decide il
// chiamante (la dimensione del mittente, che è l'unica cosa che sa).
export function dimensionFromText (text) {
  const folded = foldText(text);
  if (/\b(?:nether|niederholle|infierno|inferno)\b/.test(folded)) return 'nether';
  if (/\b(?:the end|end dimension|dimensione end|el end|im end|dans l'end)\b/.test(folded)) return 'end';
  if (/\b(?:overworld|oberwelt|superficie|surface)\b/.test(folded)) return 'overworld';
  return null;
}

// Scomposizione in token di un messaggio, con la stessa numerazione fra testo
// grezzo e testo ripiegato (`foldText` non aggiunge né toglie token). Serve a
// togliere pezzi di frase — clausole di coordinate, verbi, articoli — **senza
// toccare gli accenti**: un replace sul testo grezzo non riconoscerebbe "à" e
// lascerebbe detriti nel nome del luogo.
function analyze (raw) {
  const norm = normalizeApostrophes(raw);
  const folded = foldText(norm);
  const rawTokens = norm ? norm.split(' ') : [];
  const foldedTokens = folded ? folded.split(' ') : [];
  const starts = [];
  let pos = 0;
  for (const token of rawTokens) { starts.push(pos); pos += token.length + 1; }
  const dropped = rawTokens.map(() => false);
  const drop = (pattern) => {
    const re = pattern instanceof RegExp ? new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`) : pattern;
    for (const m of folded.matchAll(re)) {
      const from = m.index;
      const to = from + m[0].length;
      // Un token è dentro il match solo se *inizia* dentro: così la "a" in coda a
      // "ricorda" non viene mai scambiata per una preposizione.
      for (let i = 0; i < rawTokens.length; i += 1) if (starts[i] >= from && starts[i] < to) dropped[i] = true;
    }
  };
  const kept = () => rawTokens.filter((_, i) => !dropped[i]);
  const keptFolded = () => rawTokens.map((t, i) => [t, foldedTokens[i] ?? foldText(t)]).filter((_, i) => !dropped[i]).map(([, f]) => f);
  return { norm, folded, rawTokens, foldedTokens, starts, dropped, drop, kept, keptFolded };
}

// La clausola delle coordinate, da togliere di netto: un nome non deve
// contenere "a 120 64 -230".
const COORD_CLAUSE = new RegExp(
  `\\b${COORD_INTRO}\\b${COORD_FILLER}\\s*(?:[:=]\\s*)?${ANY_TRIPLE}`
  + `|${ANY_TRIPLE}`
  + '|\\b[xyz]\\s*(?:=|:)?\\s*-?\\d+(?:\\s*[,;]?\\s*[xyz]\\s*(?:=|:)?\\s*-?\\d+)*'
  + `|\\b${COORD_WORD.source}\\b\\s*(?:[:=])?\\s*-?\\d+(?:\\s*[,;]?\\s*-?\\d+)*`,
  'g',
);

// Il nome di un luogo, ripulito da verbi, articoli, clausole di posizione e
// avverbi. `null` quando non resta niente che somigli a un nome.
// `mode: 'where'` toglie anche l'apertura della domanda ("dov'è", "where is",
// "ed è perché…") — serve alla forma consultiva.
export function extractPlaceName (text, { mode = 'remember' } = {}) {
  const a = analyze(text);
  a.drop(COORD_CLAUSE);
  a.drop(REMEMBER_VERB_SOURCE);
  a.drop(FORGET_VERB_SOURCE);
  a.drop(CORRECT_VERB_SOURCE);
  a.drop(/\b(?:che|that|que|dass)\b/g);
  if (mode === 'where') {
    a.drop(WHERE_SOURCE);
    a.drop(WHERE_AUX_SOURCE);
  }
  let kept = a.kept();
  if (!kept.length) return null;
  // Solo il primo segmento: in "il campo di patate, registra l'informazione" la
  // seconda parte è un'altra frase, non parte del nome.
  const cut = kept.findIndex((token) => token.includes(','));
  if (cut >= 0) {
    const head = kept[cut].split(',')[0].trim();
    kept = head ? [...kept.slice(0, cut), head] : kept.slice(0, cut);
  }
  if (!kept.length) return null;
  // "questo è X" / "il punto dove mi trovo è X": il nome è a destra della
  // copula, perché a sinistra c'è un indizio di posizione, non un nome.
  const joined = foldText(kept.join(' '));
  const copula = COPULA.exec(joined);
  if (copula) {
    const index = tokenIndexAt(kept, joined, copula.index + copula[0].length);
    const before = kept.slice(0, tokenIndexAt(kept, joined, copula.index));
    const after = kept.slice(index);
    const deictic = DEICTIC_CLAUSE.test(foldText(before.join(' '))) || HERE.test(foldText(before.join(' ')));
    if (deictic && after.length) kept = after;
    else if (before.length) kept = before;
  }
  let s = kept.join(' ').replace(/[.,;:!?¡¿"'()\[\]]+$/g, '').replace(/^[\s:,\-–>]+/, '');
  // Articoli, avverbi, coda pendente ("... della miniera è", "... is at").
  for (let i = 0; i < 3; i += 1) {
    s = s.replace(ARTICLE, '').replace(/\s+/g, ' ').trim();
    const words = s.split(' ');
    while (words.length > 1 && DANGLING.has(foldText(words[words.length - 1]))) words.pop();
    // E in testa: «... è a coordinate …» lascia un "a" pendente che non è un nome.
    while (words.length && LEADING_DANGLING.has(foldText(words[0]))) words.shift();
    s = words.join(' ');
  }
  s = s.replace(/[.,;:!?¡¿"'()\[\]]+$/g, '').replace(/^[\s:,\-–>]+/, '').replace(/\s+/g, ' ').trim();
  if (!s || s.length > 60) return null;
  if (NAME_STOPWORDS.has(foldText(s))) return null;
  return s;
}

// L'indice del token il cui *inizio* cade in `at` o dopo.
function tokenIndexAt (tokens, joined, at) {
  let pos = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    if (pos >= at) return i;
    pos += tokens[i].length + 1;
  }
  return tokens.length;
}

const ARTICLE = /^(?:(?:il|lo|la|i|gli|le|un|uno|una|the|les|der|die|das|ein|eine|el|los|las|des|du|dem|dei|degli|delle|del|della)\s+|l['’]\s*|d['’]\s*)/i;
// Preposizioni di luogo: pendenti in testa a un nome sono detriti ("è **a**
// coordinate …" → "a"), non l'inizio di un nome. Quelle che possono aprire un nome
// vero ("di", "del", "the") restano fuori da questo insieme.
const LEADING_DANGLING = new Set(['a', 'ad', 'al', 'allo', 'alla', 'ai', 'agli', 'alle', 'in', 'nel', 'nello', 'nella', 'nei', 'negli', 'nelle', 'at', 'to', 'au', 'aux', 'en', 'im', 'zum', 'zur']);

const DANGLING = new Set(['sta', 'stanno', "e", "e'", 'sono', 'si', 'trova', 'trovano', 'sorge', 'at', 'is', 'are', 'ist', 'sind', 'est', 'es', 'esta', 'estan', 'esta', 'se', 'trouve', 'trouvent', 'correspond', 'corrisponde', 'findet', 'liegt', 'steht', 'in', 'im', 'de', 'du', 'des', 'del', 'della', 'delle', 'dei', 'degli', 'di', 'of', 'the', 'ora', 'adesso', 'now', 'maintenant', 'ahora', 'jetzt', 'piu', 'non']);
const DEICTIC_CLAUSE = /\b(?:questo|questa|qui|qua|il punto dove|il posto dove|this|here|the spot|the place where|ici|ce point|aqui|este punto|hier|dieser punkt)\b/;
const NAME_STOPWORDS = new Set(['informazione', 'information', 'questo', 'questa', 'questo posto', 'qui', 'qua', 'here', 'it', 'this', 'il punto', 'the point', 'l informazione', 'posizione', 'position']);
const COPULA = /\b(?:e'|e|è|sono|si chiama|corrisponde|is|ist|est|es|se trouve)\b/;
const REMEMBER_VERB_SOURCE = /\b(?:ricordati|ricordate|ricorda|ricordami|ricordamelo|ricordatelo|memorizza|memorizzare|registra|registrare|segnati|segna|annota|appunta|impara|note down|remember|register|record|write down|rappelle-toi|retiens|souviens-toi|enregistre|memorise|recuerda|acuerdate|apunta|anota|registra|memoriza|merk dir|merke|erinnere dich|notiere|speichere|registriere)\b/g;
const FORGET_VERB_SOURCE = /\b(?:dimentica|dimenticati|dimenticate|scorda|scordati|oblia|rimuovi|cancella|togli|forget|remove|delete|erase|oublie|supprime|efface|olvida|borra|elimina|vergiss|losche|entferne)\b/g;
const CORRECT_VERB_SOURCE = /\b(?:correggi|correggere|aggiorna|aggiornare|rettifica|spostat[oa]|cambiat[oa]|correct|update|moved|corrige|mets a jour|actualiza|korrigiere|aktualisiere)\b/g;
const WHERE_SOURCE = /\b(?:dove|dov'e|in che posto|where|ou est|ou se trouve|donde|esta|wo ist|wo finde ich|wo liegt)\b/g;
const WHERE_AUX_SOURCE = /\b(?:posso|puoi|potrei|si|trova|trovano|trovo|trovare|trovi|cerco|cercare|sapere|dimmi|sta|stanno|sono|e|e'|c'e|ci|that|the|is|are|hay|se|encuentra|finde|find|know|tell|ich|findet|liegt|steht|est|ou|wo|ist|sind|le|la|les|des|du|der|die|das)\b/g;

// La frase attorno alla parola-baule: "nel baule di casa a 120 64 -230" dà
// "baule di casa". Serve a nominare il contenitore come l'umano lo chiama.
// I connettivi (`di`, `de`, `of`, l'articolo) restano dentro il nome; a fermare
// la corsa sono i verbi, le preposizioni di luogo e le coordinate.
const CONTAINER_STOP = new Set(['a', 'al', 'allo', 'alla', 'ai', 'agli', 'alle', 'at', 'in', 'en', 'bei', 'zu', 'zum', 'zur', 'nach', 'vers', 'to', 'into', 'sur', 'presso', 'verso', 'dans', 'au', 'aux', 'hacia', 'fino', 'fin', 'circa', 'che', 'that', 'que', 'dass']);
const CONTAINER_BREAK = new Set(['c\'e', 'e', "e'", 'sta', 'stanno', 'sono', 'si', 'trova', 'trovano', 'contiene', 'contengono', 'ci', 'ho', 'hai', 'abbiamo', 'is', 'are', 'est', 'es', 'esta', 'estan', 'sind', 'se', 'trouve', 'hay', 'heeft', 'hat', 'liegt', 'steht', 'findet']);
export function containerPhrase (text) {
  const a = analyze(text);
  const index = a.foldedTokens.findIndex((token) => CONTAINER_WORD.test(token));
  if (index < 0) return null;
  const kept = [];
  for (let i = index; i < a.rawTokens.length && kept.length < 4; i += 1) {
    const bare = a.foldedTokens[i].replace(/[^a-z0-9']/g, '');
    if (!bare || /^-?\d+$/.test(bare) || CONTAINER_STOP.has(bare) || CONTAINER_BREAK.has(bare) || COORD_WORD.test(bare)) break;
    kept.push(a.rawTokens[i].replace(/[.,;:!?]+$/, ''));
  }
  while (kept.length > 1 && (DANGLING.has(foldText(kept[kept.length - 1])) || CONTAINER_BREAK.has(foldText(kept[kept.length - 1])))) kept.pop();
  return kept.length ? kept.join(' ') : null;
}

// Il tipo Minecraft del contenitore, dal nome con cui l'umano l'ha chiamato:
// "baule" e "chest" sono lo stesso blocco, "barile"/"cofano" no. Il default è il
// contenitore generico della memoria.
const CONTAINER_TYPES = [
  [/\b(?:shulker|shulkerbox)\b/, 'shulker_box'],
  [/\b(?:barile|barili|botte|botti|bidone|bidoni|fusto|barrel|barrels|tonneau|fass)\b/, 'barrel'],
  [/\b(?:baule|bauli|cassapanca|cassa|casse|forziere|forzieri|chest|chests|crate|coffre|coffres|cofre|cofres|baul|truhe|truhen|kiste|kisten)\b/, 'chest'],
];
export function containerTypeFromPhrase (phrase) {
  const folded = foldText(phrase);
  for (const [pattern, type] of CONTAINER_TYPES) if (pattern.test(folded)) return type;
  return 'container';
}

// Il nome che segue un verbo di movimento: "vai al campo di patate" → "campo di
// patate". Non decide niente: se quel nome non è in memoria, chi chiama
// prosegue per la strada normale (un ordine di movimento qualunque).
export function extractGoToName (text) {
  const raw = normalizeApostrophes(text);
  const folded = foldText(raw);
  const verb = GOTO_VERB.exec(folded);
  if (!verb) return null;
  let rest = raw.slice(verb.index + verb[0].length).trim();
  const prep = GOTO_PREP.exec(foldText(rest));
  if (prep) rest = rest.slice(prep.index + prep[0].length).trim();
  rest = rest.replace(/[.,;:!?]+$/, '').trim();
  return extractPlaceName(rest);
}

// `{x, y, z}` → "120, 64, -230". I numeri come li scrive Minecraft.
export function formatPosition (position) {
  if (!position) return '?';
  return `${Math.round(position.x)}, ${Math.round(position.y)}, ${Math.round(position.z)}`;
}

// Il nome della dimensione per la chat (non i token interni).
export function dimensionLabel (dimension) {
  const key = String(dimension ?? '').toLowerCase();
  if (key === 'nether') return 'Nether';
  if (key === 'end') return 'End';
  if (key === 'overworld') return 'Overworld';
  return dimension ?? '?';
}

// Quanti pezzi, quando l'umano lo dice ("64 di ferro"). Le coordinate sono già
// state tolte prima di chiamare questo: un numero rimasto è una quantità.
export function countFromText (text) {
  const a = analyze(text);
  a.drop(COORD_CLAUSE);
  const folded = a.keptFolded().join(' ');
  const hit = /\b(\d{1,3})\b/.exec(folded);
  if (hit) return Number(hit[1]);
  return /\b(?:un|una|uno|one|ein|eine|un')\b/.test(folded) ? 1 : null;
}

// La frase senza la clausola delle coordinate.
export function stripCoordClause (text) {
  const a = analyze(text);
  a.drop(COORD_CLAUSE);
  return a.kept().join(' ');
}

// La parola con cui l'umano ha nominato la risorsa, più il token Minecraft: come
// per gli ordini di gettare, la chat parla la lingua dell'umano e la memoria
// cerca il nome dell'item. La tabella è la stessa della chat
// (`matchItemWordText`), più i nomi osservati nell'inventario: "nel baule c'è
// netherite scrap" deve riconoscere anche un item che l'umano non ha mai
// nominato in italiano.
function matchToldItem (text, names = []) {
  return matchItemWordText(text, { names });
}

// L'intento, oppure `null` quando la frase non è un fatto dettato (allora la
// chat prosegue con domande e ordini come prima).
export function toldIntentFromText (text, { sender = null, names = [] } = {}) {
  const raw = normalizeApostrophes(text);
  if (!raw) return null;
  const folded = foldText(raw);
  if (folded.length > MAX_MESSAGE) return null;
  const coords = coordsFromText(folded);
  const here = HERE.test(folded);
  const question = looksLikeQuestion(raw);
  const container = containerPhrase(raw);
  const item = (container || WHERE.test(folded)) ? matchToldItem(raw, names) : null;

  // 1. Dimenticare: l'unica operazione che richiede solo un nome.
  if (FORGET_VERB.test(folded)) {
    const name = extractPlaceName(raw);
    return name ? { kind: TELL.FORGET_PLACE, name, via: 'forget' } : { kind: CLARIFY, reason: 'no_name', via: 'forget' };
  }

  // 2. Correggere: un verbo di correzione, oppure "ora è a <coordinate>". Una
  // correzione *dichiara* la posizione: senza, non c'è niente da correggere.
  if (!question && (CORRECT_VERB.test(folded) || (TIME_NOW.test(folded) && coords?.kind === 'full'))) {
    const name = extractPlaceName(raw);
    if (!name) return { kind: CLARIFY, reason: 'no_name', via: 'correct' };
    if (coords?.kind !== 'full') return { kind: CLARIFY, reason: coords ? 'no_marker' : 'no_position', name, via: 'correct', numbers: coords?.numbers ?? null };
    return { kind: TELL.CORRECT_PLACE, name, position: coords.position, dimension: dimensionFromText(raw), via: 'correct' };
  }

  // 3. Ricordare. Il verbo è esplicito, oppure la frase è una dichiarazione di
  //    posizione ("il campo di patate è a 120 64 -230", "questo è l'orto") —
  //    mai una domanda, mai un ordine di movimento.
  const declarative = !question && !GOTO_VERB.test(folded) && POS_VERB.test(folded) && (coords?.kind === 'full' || here);
  if (REMEMBER_VERB.test(folded) || declarative) {
    return rememberIntent(raw, folded, coords, here, sender, names, container, item);
  }

  // 4. Andare in un luogo per nome (non è una scrittura: è un movimento).
  if (!question && GOTO_VERB.test(folded) && !WHERE.test(folded)) {
    const name = extractGoToName(raw);
    if (name) return { kind: TELL.GOTO_PLACE, name, via: 'goto' };
  }

  // 5. Consultare: il nome del luogo e la risorsa viaggiano *insieme* ("dov'è il
  //    campo di patate?" contiene anche "patate", che è un item). Chi risponde
  //    prova prima il luogo, poi la risorsa: qui non si sceglie.
  if (WHERE.test(folded) && !SELF_REF.test(folded)) {
    const name = extractPlaceName(raw, { mode: 'where' });
    const resource = item;
    if (name || resource) {
      return {
        kind: TELL.CONSULT, name: name ?? null,
        item: resource ? resource.token : null, word: resource ? resource.word : null, via: 'where',
      };
    }
  }
  return null;
}

function rememberIntent (raw, folded, coords, here, sender, names, container, item) {
  const name = extractPlaceName(raw);
  const from = coords?.kind === 'full' ? 'coords' : (here ? 'here' : null);
  const where = coords?.kind === 'full' ? { position: coords.position } : {};
  const partial = coords && coords.kind !== 'full' ? { numbers: coords.numbers ?? null } : {};
  const dimension = dimensionFromText(raw);

  // "Il ferro sta nel baule a x,y,z": un *claim* sul contenuto, non un luogo.
  if (container && item) {
    if (!from) return { kind: CLARIFY, reason: coords ? 'no_marker' : 'no_position', name: container, via: 'contents', ...partial };
    if (from === 'here' && !sender) return { kind: CLARIFY, reason: 'no_sender_position', name: container, via: 'contents' };
    return {
      kind: TELL.REMEMBER_CONTENTS, container, containerType: containerTypeFromPhrase(container), item: item.token, word: item.word,
      count: countFromText(raw), ...where, dimension, from, via: 'contents',
    };
  }
  // "Questo baule è a x,y,z", con o senza un nome per chiamarlo: un contenitore
  // nominato, senza claim sul contenuto. La chiave resta la posizione
  // (`containerId` in world-memory), così un claim successivo cade sullo stesso
  // record: mai due record per la stessa cassa.
  if (container) {
    if (!from) return { kind: CLARIFY, reason: coords ? 'no_marker' : 'no_position', name: container, via: 'container', ...partial };
    if (from === 'here' && !sender) return { kind: CLARIFY, reason: 'no_sender_position', name: container, via: 'container' };
    const given = name && !foldText(name).includes(foldText(container)) ? name : container;
    return { kind: TELL.REMEMBER_CONTAINER, container: given, containerType: containerTypeFromPhrase(container), label: given, ...where, dimension, from, via: 'container' };
  }
  if (!name) return { kind: CLARIFY, reason: coords ? 'no_marker' : 'no_name', via: 'place', ...partial };
  if (!from) return { kind: CLARIFY, reason: coords ? 'no_marker' : 'no_position', name, via: 'place', ...partial };
  if (from === 'here' && !sender) return { kind: CLARIFY, reason: 'no_sender_position', name, via: 'place' };
  return { kind: TELL.REMEMBER_PLACE, name, label: name, ...where, dimension, from, via: 'place' };
}
