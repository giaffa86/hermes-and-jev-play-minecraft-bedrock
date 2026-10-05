// Answers to questions asked in chat — the *facts* half of the question path,
// with no model and no network.
//
// `chat-intent.mjs` decides *which* question a message asks (regex fast path,
// then System One / Jev); this module owns the catalogue. One entry per intent
// carries both the description handed to Jev and the function that renders the
// answer from harness facts, so the model can only ever choose an intent the
// bot is able to answer — and the text of the answer can never be invented by
// the model, because it is composed here from `observe()`.
//
// Pure module: no I/O, no clock, no model.
//
// Used by the controller right before the order path: a question is answered
// from what the harness already knows and *no goal is created*, so a running
// goal keeps running.

import { DEFAULT_CHAT_PREFIX, DEFAULT_REPLY_MAX_LENGTH, clampMessage, renderReply } from './human-replies.mjs';
import { formatPrefixes } from './human-greeting.mjs';
import { DEFAULT_LANG, MESSAGES, hasMessage, listAnd, t } from './chat-i18n.mjs';

export const DEFAULT_ANSWER_TEMPLATE = t(DEFAULT_LANG, 'answer_template');

// Sentinel chosen by the model when the message is not a question about the
// bot's own state (an order, a greeting, small talk). It deliberately carries
// no answer: `q_none` can only ever mean "leave this to the order path".
export const NO_INTENT = 'q_none';

const round = value => Math.round(Number(value));

function positionAnswer (obs, { lang = DEFAULT_LANG } = {}) {
  const p = obs?.position;
  if (!p || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.z))) {
    return t(lang, 'pos_unknown');
  }
  const y = Number.isFinite(Number(p.y)) ? t(lang, 'pos_y', { y: round(p.y) }) : '';
  const where = obs?.dimension ? t(lang, 'pos_dim', { dimension: obs.dimension }) : '';
  return t(lang, 'pos', { x: round(p.x), y, z: round(p.z), where });
}

function healthAnswer (obs, { lang = DEFAULT_LANG } = {}) {
  if (obs?.dead) return t(lang, 'health_dead');
  const parts = [];
  // Bedrock conta la vita in mezzi-cuori (0-20): 20 punti = 10 cuori. La
  // domanda del giocatore è quasi sempre "quanti cuori hai?", quindi si dà
  // prima il numero di cuori e poi i punti, senza inventare nulla.
  if (Number.isFinite(Number(obs?.health))) {
    const health = Number(obs.health);
    parts.push(t(lang, 'health_hearts', { hearts: round(health / 2), points: round(health) }));
  }
  if (Number.isFinite(Number(obs?.food))) parts.push(t(lang, 'health_food', { food: round(obs.food) }));
  if (!parts.length) return t(lang, 'health_unknown');
  return t(lang, 'health', { parts: listAnd(parts, lang) });
}

// I goal strutturati (chore del villaggio, bisogni di sopravvivenza) vivono
// nella knowledge base con un `objective` tecnico in inglese: leggerlo in chat
// sarebbe la risposta sbagliata. Le etichette stanno nel catalogo `chat-i18n`
// (`chore.*` / `need.*`), una per lingua: qui si espongono solo le mappe della
// lingua di default (compatibilita' con i chiamanti esistenti) e le funzioni
// che rispondono nella lingua configurata. La copertura delle etichette e'
// verificata dai test contro `VILLAGE_CHORES` e `NEED_PRIORITY`.
function labelsFromCatalogue (prefix, lang = DEFAULT_LANG) {
  return Object.freeze(Object.fromEntries(
    Object.entries(MESSAGES[lang])
      .filter(([key]) => key.startsWith(`${prefix}.`))
      .map(([key, value]) => [key.slice(prefix.length + 1), value])
  ));
}

export const CHORE_LABELS = labelsFromCatalogue('chore');
export const NEED_LABELS = labelsFromCatalogue('need');

// Esistenza dell'id controllata sul catalogo di default (gli id non dipendono
// dalla lingua): un id sconosciuto resta null e non produce una frase a meta'.
export const choreLabel = (id, lang = DEFAULT_LANG) => (hasMessage(DEFAULT_LANG, `chore.${id}`) ? t(lang, `chore.${id}`) : null);
export const needLabel = (id, lang = DEFAULT_LANG) => (hasMessage(DEFAULT_LANG, `need.${id}`) ? t(lang, `need.${id}`) : null);

// Frase per il goal in corso, o null quando il plan non dice abbastanza: in
// quel caso si usa il suo objective (un ordine umano arriva gia' nella lingua
// di chi lo ha scritto).
export function planPhrase (plan, { lang = DEFAULT_LANG } = {}) {
  if (!plan || typeof plan !== 'object') return null;
  if (plan.equip) return t(lang, 'phrase.equip');
  // Ordine "getta <oggetto>" / "cattura <oggetto>": la parola dell'umano
  // (`word`) rende la frase riconoscibile in chat, il token Minecraft no.
  if (plan.drop) return t(lang, 'phrase.drop', { word: plan.drop.word ?? plan.drop.token ?? '' });
  if (plan.collect) return t(lang, 'phrase.collect', { word: plan.collect.word ?? plan.collect.token ?? '' });
  if (plan.recover) return t(lang, 'phrase.recover');
  if (plan.chore && hasMessage(DEFAULT_LANG, `chore.${plan.chore}`)) return t(lang, `chore.${plan.chore}`);
  if (plan.need && hasMessage(DEFAULT_LANG, `need.${plan.need}`)) return t(lang, `need.${plan.need}`);
  if (plan.construction) return t(lang, 'phrase.construction');
  if (String(plan.notes ?? '').startsWith('opportunity:')) return t(lang, 'phrase.opportunity');
  if (String(plan.notes ?? '').startsWith('curriculum:')) return t(lang, 'phrase.curriculum');
  return null;
}

function activityAnswer (obs, { lang = DEFAULT_LANG } = {}) {
  const plan = obs?.plan;
  const phrase = planPhrase(plan, { lang }) ?? plan?.objective;
  if (!phrase) return t(lang, 'activity_none');
  return t(lang, 'activity', { phrase });
}

// Parole italiane (e inglesi) con cui la famiglia chiede un oggetto preciso:
// il token è la parte del nome Minecraft che deve comparire in inventario.
// `armor` e `food` sono gruppi, risolti dai pattern qui sotto.
const ITEM_WORDS = [
  [/\b(spad(a|e|ina|ine|ino|ini)|sword|epees?|espadas?|schwert(er)?)\b/, 'sword'],
  [/\b(piccon(e|i|etto|etti)|pick(axe)?|pioches?|picos?|spitzhacke(n)?)\b/, 'pickaxe'],
  [/\b(asci(a|e)|axe|haches?|hachas?|axt(e)?|beil(e)?)\b/, 'axe'],
  [/\b(pal(a|e)|shovel|pelles?|palas?|schaufel(n)?)\b/, 'shovel'],
  [/\b(zapp(a|e)|hoe|houes?|azadas?|hacke(n)?)\b/, 'hoe'],
  [/\b(elm(o|etto|etti|i)|casco|helmet|casques?|helm(e)?)\b/, 'helmet'],
  [/\b(corazz(a|e)|pettoral(e|i)|chestplate|plastrons?|petos?|brustplatte(n)?|brustpanzer)\b/, 'chestplate'],
  [/\b(gambal(e|i)|leggings|jambieres?|grebas?|beinschutz)\b/, 'leggings'],
  [/\b(stival(e|i)|boots|bottes?|botas?|stiefel)\b/, 'boots'],
  [/\b(armatur(a|e)|armor|armour|armures?|armaduras?|rustung(en)?)\b/, 'armor'],
  [/\b(scud(o|i)|shield|boucliers?|escudos?|schild(er)?)\b/, 'shield'],
  [/\b(pagnott(a|e)|pane|bread|pains?|pan(es)?|brot(e)?)\b/, 'bread'],
  [/\b(patat[ae]\s+(cott[ae]|al\s+forno)|baked\s+potato(?:es)?|baked_potato)\b/, 'baked_potato'],
  [/\b(patat[ae]|potato(?:es)?)\b/, 'potato'],
  [/\b(mel(a|e)|apple|pommes?|manzanas?|apfel)\b/, 'apple'],
  [/\b(terr(a|e)|dirt|terres?|tierras?|erde(n)?)\b/, 'dirt'],
  [/\b(pietr(a|e)|stone|pierres?|piedras?|stein(e)?)\b/, 'stone'],
  [/\b(legn(o|a|e)|planks?|planches?|tablones?|brett(er)?|planken)\b/, 'planks'],
  [/\b(ferr(o|i)|iron|fers?|hierro|eisen)\b/, 'iron'],
  // "bronzo" non esiste in Minecraft vanilla: si legge come il tier rame.
  [/\b(ram(e|i)|copper|bronz(o|i)|bronze|cuivre|cobre|kupfer)\b/, 'copper'],
  [/\b(or(o|i)?|gold(en)?|oro)\b/, 'gold'],
  [/\b(carbon(e|i)|coal|charbon|kohle)\b/, 'coal'],
  [/\b(diamant(e|i)|diamond|diamante|diamant)\b/, 'diamond'],
  [/\b(torci(a|e)|torch(es)?|torches?|antorchas?|fackel(n)?)\b/, 'torch'],
  [/\b(lett(o|i)|bed|lits?|camas?|bett(en)?)\b/, 'bed'],
  [/\b(zucca|zucche|pumpkin|citrouilles?|calabazas?|kurbis(se)?)\b/, 'pumpkin'],
];

// Materiale dell'oggetto nominato: "una spada di rame" è una domanda diversa da
// "una spada". Il bronzo non esiste in Minecraft vanilla — nessun item
// `bronze_*`, nessuna ricetta, solo mod e proposte — e dal Copper Age (Bedrock
// 1.21.111, Java 1.21.9, 30/09/2025) il materiale fra pietra e ferro è il rame:
// "bronzo"/"bronze" si leggono come rame invece di ignorare la domanda.
const MATERIAL_WORDS = [
  [/\b(legn(o|i)|wooden|wood|bois|madera|holz)\b/, 'wooden'],
  [/\b(pietr(a|e)|stone|pierre|piedra|stein)\b/, 'stone'],
  [/\b(ram(e|i)|copper|bronz(o|i)|bronze|cuivre|cobre|kupfer)\b/, 'copper'],
  [/\b(ferr(o|i)|iron|fer|hierro|eisen)\b/, 'iron'],
  [/\b(or(o|i)?|gold(en)?|oro)\b/, 'gold'],
  [/\b(chainmail|maglia|mailles|malla|kettenhemd)\b/, 'chainmail'],
  [/\b(diamant(e|i)|diamond|diamante|diamant)\b/, 'diamond'],
  [/\bnetherite\b|\bnetherita\b|\bnetherit\b/, 'netherite'],
  [/\b(cuoio|leather|cuir|cuero|leder)\b/, 'leather'],
];

// Il materiale restringe solo gli oggetti "di tipo" (armi, attrezzi, armatura):
// "hai della pietra?" resta la domanda su `stone` e `cobblestone`.
const MATERIAL_KINDS = new Set(['sword', 'pickaxe', 'axe', 'shovel', 'hoe', 'helmet', 'chestplate', 'leggings', 'boots', 'armor', 'shield']);

function matchMaterial (message) {
  const text = normalizeForMatching(message);
  if (!text) return null;
  for (const [pattern, material] of MATERIAL_WORDS) {
    if (pattern.test(text)) return material;
  }
  return null;
}

const ARMOR_SUFFIX = /_(helmet|chestplate|leggings|boots)$/;

// Un nome di item (dell'inventario o di un drop a terra) corrisponde al token
// dell'ordine? `armor` e' un gruppo — nessun item si chiama "armor" — quindi
// vale per i quattro pezzi elmo/corazza/gambali/stivali. Serve agli ordini
// "getta/cattura <oggetto>", dove si cerca il nome reale dell'item (la risposta
// in chat, invece, parla la lingua dell'umano).
export function matchesItemToken (name, token) {
  const value = String(name || '').toLowerCase();
  const needle = String(token || '').toLowerCase();
  if (!value || !needle) return false;
  if (needle === 'armor') return ARMOR_SUFFIX.test(value);
  return value.includes(needle);
}

// La parola con cui l'umano ha nominato l'oggetto, accanto al token Minecraft:
// "getta i diamanti" -> `{token: 'diamond', word: 'diamanti'}`. Serve agli
// ordini di gettare/raccogliere, che devono *parlare* la lingua dell'umano
// (`word`) ma *cercare* il nome dell'item (`token`).
export function matchItemWordText (message, { names = [] } = {}) {
  const text = normalizeForMatching(message);
  if (!text) return null;
  // Resolve names actually observed in inventory/on the ground before aliases.
  // In "raccogli spruce log da terra", spruce log is the item, not "terra".
  for (const token of [...new Set(names)].sort((a,b)=>b.length-a.length)) {
    if (!/^[a-z0-9_]+$/.test(token)) continue;
    const pattern = new RegExp(`\\b${token.replaceAll('_','[ _]+')}\\b`);
    const hit = pattern.exec(text);
    if (hit) return {token, word:hit[0]};
  }
  for (const [pattern, token] of ITEM_WORDS) {
    const hit = pattern.exec(text);
    if (hit) return { token, word: hit[0].trim() };
  }
  return null;
}

export const matchItemWord = (message) => matchItemWordText(message)?.token ?? null;

function inventoryAnswer (obs, { message = null, limit = 4, lang = DEFAULT_LANG } = {}) {
  const inventory = obs?.inventory && typeof obs.inventory === 'object' ? obs.inventory : {};
  // "hai una spada?" si risponde sull'oggetto chiesto, non con la lista intera:
  // se la domanda nomina qualcosa che il catalogo conosce, si dice sì o no.
  const token = matchItemWord(message);
  if (token) {
    const held = Object.keys(inventory).filter(name => Number(inventory[name]) > 0);
    const ofKind = held.filter(name => (token === 'armor' ? ARMOR_SUFFIX.test(name) : name.includes(token)));
    // Con un materiale nominato ("una spada di rame") conta quel materiale; se
    // non c'è, si dice cosa c'è dello stesso tipo invece di un "no" secco.
    const material = MATERIAL_KINDS.has(token) ? matchMaterial(message) : null;
    const names = material ? ofKind.filter(name => name.startsWith(material)) : ofKind;
    if (!names.length) {
      if (material && ofKind.length) return t(lang, 'inv_no_material', { items: ofKind.join(', ') });
      return t(lang, 'inv_no');
    }
    const shown = names.map(name => (Number(inventory[name]) > 1 ? `${name} x${inventory[name]}` : name));
    return t(lang, 'inv_yes', { items: shown.join(', ') });
  }
  const rows = Object.entries(inventory)
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  if (!rows.length) return t(lang, 'inv_empty');
  const shown = rows.slice(0, limit).map(([item, count]) => (Number(count) > 1 ? `${item} x${count}` : item));
  const more = rows.length > limit ? t(lang, 'inv_more', { n: rows.length - limit }) : '';
  return t(lang, 'inv_list', { items: shown.join(', '), more });
}

// Cosa indossa, non cosa possiede: `observe().armor` è lo stato degli slot
// addosso (elmo/pettorale/gambali/stivali) più i punti armatura vanilla.
function armorAnswer (obs, { lang = DEFAULT_LANG } = {}) {
  const armor = obs?.armor && typeof obs.armor === 'object' ? obs.armor : null;
  if (!armor) return t(lang, 'armor_unknown');
  const worn = ['helmet', 'chestplate', 'leggings', 'boots'].map(slot => armor[slot]).filter(Boolean);
  if (!worn.length) return t(lang, 'armor_none');
  const points = Number.isFinite(Number(armor.points)) ? t(lang, 'armor_points', { points: round(armor.points) }) : '';
  return t(lang, 'armor_worn', { items: worn.join(', '), points });
}

// Bedrock keeps time in ticks: 0 ticks is 06:00, one full day is 24000 ticks.
export function clockFromTicks (ticks) {
  const value = Number(ticks);
  if (!Number.isFinite(value)) return null;
  const day = ((value % 24000) + 24000) % 24000;
  const minutes = (day / 1000 + 6) * 60;
  const hh = Math.floor(minutes / 60) % 24;
  const mm = Math.floor(minutes % 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function timeAnswer (obs, { lang = DEFAULT_LANG } = {}) {
  const info = obs?.time;
  const clock = clockFromTicks(info?.ticks);
  const phase = info?.night === true ? t(lang, 'phase_night') : info?.night === false ? t(lang, 'phase_day') : null;
  if (clock && phase) return t(lang, 'time', { clock, phase: t(lang, 'time_phase', { phase }) });
  if (clock) return t(lang, 'time', { clock, phase: '' });
  if (phase) return t(lang, 'time_only_phase', { phase });
  return t(lang, 'time_unknown');
}

function identityAnswer (_obs, { prefixes = DEFAULT_CHAT_PREFIX, lang = DEFAULT_LANG } = {}) {
  const list = formatPrefixes(prefixes, { separator: t(lang, 'list_or') }) || DEFAULT_CHAT_PREFIX;
  return t(lang, 'identity', { prefixes: list });
}

// The catalogue: `patterns` is the regex fast path (answered without any model
// call), `description` is what Jev reads to route a message that matched none.
// Order matters only for the fast path (first match wins).
export const QUESTION_INTENTS = [
  {
    id: 'q_position',
    description: 'The human asks where the bot is right now: its position, its coordinates or its dimension (e.g. "dove sei", "where are you", "non ti vedo").',
    patterns: [/\b(dove (sei|ti trovi|siete)|posizione|coordinate|non ti vedo|where are you|your (position|coordinates)|ou (es|est)[- ]?tu|donde estas|wo (bist|seid) du|deine position|tu posicion)\b/],
    answer: positionAnswer,
  },
  {
    id: 'q_health',
    description: 'The human asks how the bot is doing: its health, its food/hunger, or whether it is hurt or dead (e.g. "come stai", "how are you", "hai fame", "sei vivo").',
    patterns: [/\b(come stai|come ti senti|quanta vita|quanti cuori|quante cuori|quanto cuore|quanta fame|quanto cibo|quanta cibo|hai fame|hai vita|sei vivo|how are you|how much health|how many hearts|your health|comment (vas|va)-tu|ca va|combien de (coeurs|vie)|como estas|cuanta vida|cuantos corazones|wie geht es dir|wie gehts|wie viel leben|wie viele herzen)\b/],
    answer: healthAnswer,
  },
  {
    id: 'q_armor',
    description: 'The human asks which armor or equipment the bot is *wearing* right now (e.g. "che armatura hai", "cosa indossi", "sei equipaggiato", "what armor are you wearing"). Not the inventory: a piece held in the inventory but not equipped is not worn yet.',
    patterns: [/\b(che armatura|quale armatura|armatura (hai|indossi|addosso)|hai (l |la |una |un )?armatura|cosa indossi|cosa hai addosso|cosa hai in testa|sei equipaggiat|what armor|what are you wearing|are you wearing|quelle armure|que armadura|llevas armadura|welche rustung|was tragst du)\b/],
    answer: armorAnswer,
  },
  {
    id: 'q_activity',
    description: 'The human asks what the bot is doing right now, or why it is not moving (e.g. "che fai", "cosa stai facendo", "non ti vedo che fai", "what are you doing").',
    patterns: [/\b(che fai|che stai facendo|cosa stai facendo|che cosa fai|what are you doing|what'?s your plan|que fais-tu|qu est ce que tu fais|que haces|was machst du|was tust du)\b/],
    answer: activityAnswer,
  },
  {
    id: 'q_inventory',
    description: 'The human asks which items the bot carries, or whether it has a specific item (e.g. "cosa hai", "che oggetti hai", "hai della pietra", "what do you have").',
    patterns: [/\b(cosa hai\b(?!\s+(fatto|detto|visto|trovato|imparato))|cosa porti|cosa possiedi|che oggetti|inventario|inventory|what do you have|do you have|have you got|hai (un|uno|una|del|dello|della|dei|degli|delle|qualche|qualcosa)|quanto \w+ (hai|possiedi)|quant[oaie] \w+ (hai|possiedi)|quanti \w+ (hai|possiedi)|qu as tu|tu as quoi|que tienes|was hast du)\b/],
    answer: inventoryAnswer,
  },
  {
    id: 'q_time',
    description: 'The human asks the in-game time, or whether it is day or night (e.g. "che ore sono", "is it night").',
    patterns: [/\b(che ora|che ore|what time is it|is it night|fa buio|quelle heure|que hora|wie spat|wie viel uhr)\b/],
    answer: timeAnswer,
  },
  {
    id: 'q_identity',
    description: 'The human asks who the bot is, what it can do, or how to give it orders (e.g. "chi sei", "aiuto", "who are you", "what can you do").',
    patterns: [/\b(chi sei|cosa sai fare|aiuto|who are you|what can you do|qui es-tu|quien eres|wer bist du|was kannst du)\b/],
    answer: identityAnswer,
  },
];

// Lowercase, punctuation flattened to spaces: "HEI DOVE SEI?" and "hei, dove
// sei?" must be the same message for the fast path.
export function normalizeForMatching (message) {
  return String(message ?? '')
    .toLowerCase()
    // Gli accenti si tolgono prima del match: "épée" / "café" / "Kürbis" devono
    // cadere sulle stesse parole ASCII dei pattern, che restano leggibili.
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[?!.,;:"'“”¡¿()[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Regex fast path: the intent a message matches with no model call, or null.
export function matchQuestionIntent (message) {
  const text = normalizeForMatching(message);
  if (!text) return null;
  for (const intent of QUESTION_INTENTS) {
    if (intent.patterns.some(pattern => pattern.test(text))) return { id: intent.id, via: 'regex' };
  }
  return null;
}

// Does the *raw* message look like a question? (M6.1)
//
// Called on the text as the human wrote it, before `normalizeForMatching`: that
// one deletes `?` and `¿`, so the strongest signal would already be gone.
//
// Deliberately conservative — only two markers count: an explicit question mark
// anywhere, or an interrogative *first* word. A miss costs nothing (the message
// keeps the order path exactly as before M6.1), while a false positive refuses a
// real order, so bare verbs are absent on purpose:
//   "stai qui"         -> order (first word `stai` is not an opener)
//   "sei un cretino"   -> order
//   "quanti cuori hai?" -> question (mark and opener)
//   "prendi la terra e dimmi cosa fai" -> order (the opener is not first)
//   "prendi la terra, cosa fai dopo?" -> question (the mark counts, even in an order)
export const QUESTION_OPENERS = [
  'chi', 'che', 'cosa', 'come', 'dove', 'quando',
  'quanto', 'quanta', 'quanti', 'quante',
  'perché', 'perche', 'quale', 'quali',
  'what', 'where', 'when', 'why', 'how', 'who', 'which', 'whose',
  // Francese (folded: `où` -> `ou`, `qu'est-ce` -> `qu est ce`)
  'qui', 'que', 'quoi', 'ou', 'quand', 'comment', 'combien', 'pourquoi',
  'quel', 'quelle', 'quels', 'quelles', 'est', "qu'est-ce",
  // Spagnolo
  'quién', 'quien', 'qué', 'qué', 'dónde', 'donde', 'cuándo', 'cuando',
  'cómo', 'como', 'cuánto', 'cuanto', 'cuánta', 'cuanta', 'cuántos', 'cuantos',
  'cuántas', 'cuantas', 'cuál', 'cual', 'cuales',
  // Tedesco (folded: `wann` resta `wann`, `wie` resta `wie`)
  'wer', 'was', 'wo', 'wann', 'warum', 'wieso', 'weshalb', 'wie',
  'welche', 'welcher', 'welches', 'wohin', 'woher',
];

export function looksLikeQuestion (message) {
  const raw = String(message ?? '');
  if (/[?¿]/.test(raw)) return true;
  // Leading punctuation/emoji is dropped, then only the first token is looked
  // at, so an interrogative word in the middle does not make an order a question.
  const first = raw.trim().toLowerCase().replace(/^[^\p{L}\p{N}]+/u, '').split(/[\s,.;:!]+/)[0] ?? '';
  return QUESTION_OPENERS.includes(first);
}

// M7: saluto o convenevole puro. Lista chiusa e match *esatto* sul messaggio
// normalizzato: un ordine reale non viene mai scambiato per small talk (a
// differenza di un prefisso, `"grazie"` da solo non cattura `"grazie prendi la
// legna"`). Chi decide è il controller: qui si risponde solo alla domanda "è un
// convenevole?", mai a "cosa vuole?".
export const SMALL_TALK = [
  'ciao', 'hey', 'ehi', 'ei', 'salve', 'buongiorno', 'buonasera', 'buon pomeriggio', 'buondì',
  'come stai', 'come va', 'tutto bene', 'tutto ok', 'come te la passi', 'che si dice',
  'grazie', 'grazie mille', 'ti ringrazio', 'bravo', 'bella', 'bello', 'grande', 'sei forte', 'forte',
  'a dopo', 'ci vediamo', 'ci sono', 'presente', 'perfetto', 'ottimo', 'va bene', 'bene grazie',
  'hi', 'hello', 'how are you', 'thanks', 'thank you', 'nice', 'good job', 'well done', 'goodbye', 'bye',
  // Français (folded)
  'salut', 'bonjour', 'bonsoir', 'coucou', 'merci', 'merci beaucoup', 'au revoir', 'a plus',
  'a bientot', 'ca va', 'comment ca va', 'bien', 'tres bien', 'super', 'parfait', 'd accord',
  // Español
  'hola', 'buenos dias', 'buenas', 'buenas tardes', 'gracias', 'muchas gracias', 'adios',
  'hasta luego', 'que tal', 'como estas', 'muy bien', 'perfecto', 'genial', 'buen trabajo',
  // Deutsch
  'hallo', 'guten tag', 'guten morgen', 'guten abend', 'danke', 'danke schon', 'tschuss',
  'auf wiedersehen', 'wie gehts', 'wie geht es dir', 'alles klar', 'sehr gut', 'gut gemacht',
  'bis spater', 'bis bald',
];

export function looksLikeSmallTalk (message) {
  const text = normalizeForMatching(message);
  return text.length > 0 && SMALL_TALK.includes(text);
}

// The closed option list handed to Jev, in the `criteria` shape the decisions
// API uses (`{a0: '[id] description', ...}`). The `q_none` sentinel is always
// last, so abstaining costs nothing and an order is never swallowed silently.
export function intentCriteria ({ none = NO_INTENT } = {}) {
  const rows = [
    ...QUESTION_INTENTS.map(intent => ({ id: intent.id, description: intent.description })),
    {
      id: none,
      description: 'The message does not ask about the bot\'s own state: it is an order (something to do), a greeting, or small talk. Choose this whenever the human asks the bot to act.',
    },
  ];
  return Object.fromEntries(rows.map((row, index) => [`a${index}`, `[${row.id}] ${row.description}`]));
}

// Map the model's choice back to an intent id. `a<length>` is the `q_none`
// sentinel (and so is anything out of range): both mean "no question here", so
// the caller falls through to the order path as before.
export function intentFromChoice (choice) {
  const text = String(choice ?? '').trim().replace(/^a/i, '');
  const index = Number(text);
  // An empty or blank choice (`undefined`, `''`, `'a'`) is not option a0.
  if (!text || !Number.isInteger(index) || index < 0 || index >= QUESTION_INTENTS.length) return null;
  return QUESTION_INTENTS[index].id;
}

// Render the answer for an intent from harness facts. Returns null when the id
// is unknown or is the `q_none` sentinel (both mean "no answer to give").
export function answerIntent (id, obs = {}, { prefixes = DEFAULT_CHAT_PREFIX, maxLength = DEFAULT_REPLY_MAX_LENGTH, message = null, lang = DEFAULT_LANG } = {}) {
  const intent = QUESTION_INTENTS.find(candidate => candidate.id === id);
  if (!intent) return null;
  // `message` arriva all'answer: una domanda come "hai una spada?" nomina
  // l'oggetto, e l'inventario deve rispondere su quello. Il testo resta
  // un'indicazione, i fatti restano quelli di `observe()`.
  const answer = intent.answer(obs ?? {}, { prefixes, message, lang });
  return answer ? clampMessage(answer, maxLength) : null;
}

// One addressed chat line: `@<sender> <answer>` — never the trigger itself, so
// `replyChat`'s self-trigger guard has nothing to refuse.
export function renderAnswer ({ from, answer, lang = DEFAULT_LANG, template = t(lang, 'answer_template'), maxLength = DEFAULT_REPLY_MAX_LENGTH } = {}) {
  return renderReply(template, { name: from ?? '?', answer: answer ?? '' }, maxLength);
}

// The message looked like a question but no intent could be determined: the
// router is off (no key / disabled), it did not answer in time, its choice was
// under the probability threshold, or its answer was unparsable. Turning such a
// message into an order would move the bot on the strength of a failure (with
// `@bot quanti cuori hai?` and a dead router the old code sent it `follow
// <sender>`), so the bot says it did not understand instead — and shows the way
// back to the order path, because the human's message may well have been an
// order expressed as a question ("riesci a raggiungermi?").
export const UNROUTED_TEMPLATE = t(DEFAULT_LANG, 'unrouted');

export function renderUnrouted ({ from, prefixes = DEFAULT_CHAT_PREFIX, lang = DEFAULT_LANG, template = t(lang, 'unrouted'), maxLength = DEFAULT_REPLY_MAX_LENGTH } = {}) {
  const answer = renderReply(template, { prefixes: formatPrefixes(prefixes, { separator: t(lang, 'list_or') }) || DEFAULT_CHAT_PREFIX });
  return renderAnswer({ from, answer, lang, maxLength });
}

// Un ordine di equipaggiamento non si puo' eseguire perche' non c'e' nulla da
// indossare: si dice all'umano, non si lascia il goal aperto su un'azione che
// l'harness non offre (`equip_armor` compare solo se l'inventario ha pezzi).
export const NO_ARMOR_TEMPLATE = t(DEFAULT_LANG, 'no_armor');

export function renderNoArmor ({ from, lang = DEFAULT_LANG, template = t(lang, 'no_armor'), maxLength = DEFAULT_REPLY_MAX_LENGTH } = {}) {
  return renderAnswer({ from, answer: template, lang, maxLength });
}

// Un ordine "getta <oggetto>" che nomina un oggetto che il bot non ha: si dice
// all'umano e il goal finisce, invece di lasciare il modello libero dentro un
// ordine impossibile (stessa regola dell'equipaggiamento senza armatura).
export const NO_ITEM_TEMPLATE = t(DEFAULT_LANG, 'no_item');

export function renderNoItem ({ from, item = '', lang = DEFAULT_LANG, template = t(lang, 'no_item'), maxLength = DEFAULT_REPLY_MAX_LENGTH } = {}) {
  const answer = renderReply(template, { word: item });
  return renderAnswer({ from, answer, lang, maxLength });
}

// Un ordine "cattura <oggetto>" senza quell'oggetto a terra (fuori dal raggio in
// cui il bot vede i drop): non si mina al posto suo, si dice che non si vede.
export const NO_DROP_TEMPLATE = t(DEFAULT_LANG, 'no_drop');

export function renderNoDrop ({ from, item = '', lang = DEFAULT_LANG, template = t(lang, 'no_drop'), maxLength = DEFAULT_REPLY_MAX_LENGTH } = {}) {
  const answer = renderReply(template, { word: item });
  return renderAnswer({ from, answer, lang, maxLength });
}
