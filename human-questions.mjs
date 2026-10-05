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

export const DEFAULT_ANSWER_TEMPLATE = '@{name} {answer}';

// Sentinel chosen by the model when the message is not a question about the
// bot's own state (an order, a greeting, small talk). It deliberately carries
// no answer: `q_none` can only ever mean "leave this to the order path".
export const NO_INTENT = 'q_none';

const round = value => Math.round(Number(value));

function positionAnswer (obs) {
  const p = obs?.position;
  if (!p || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.z))) {
    return 'non lo so: non ho ancora una posizione dal server';
  }
  const y = Number.isFinite(Number(p.y)) ? `, y ${round(p.y)}` : '';
  const where = obs?.dimension ? ` (${obs.dimension})` : '';
  return `sono a x ${round(p.x)}${y}, z ${round(p.z)}${where}`;
}

function healthAnswer (obs) {
  if (obs?.dead) return 'sono morto, sto rinascendo';
  const parts = [];
  // Bedrock conta la vita in mezzi-cuori (0-20): 20 punti = 10 cuori. La
  // domanda del giocatore è quasi sempre "quanti cuori hai?", quindi si dà
  // prima il numero di cuori e poi i punti, senza inventare nulla.
  if (Number.isFinite(Number(obs?.health))) {
    const health = Number(obs.health);
    parts.push(`${round(health / 2)} cuori (${round(health)}/20 di vita)`);
  }
  if (Number.isFinite(Number(obs?.food))) parts.push(`${round(obs.food)}/20 di cibo`);
  if (!parts.length) return 'non lo so: non ho letto la mia vita';
  return `ho ${parts.join(' e ')}`;
}

function activityAnswer (obs) {
  const objective = obs?.plan?.objective;
  if (!objective) return 'non ho un obiettivo: sono in attesa di ordini';
  return `sto facendo: ${objective}`;
}

// Parole italiane (e inglesi) con cui la famiglia chiede un oggetto preciso:
// il token è la parte del nome Minecraft che deve comparire in inventario.
// `armor` e `food` sono gruppi, risolti dai pattern qui sotto.
const ITEM_WORDS = [
  [/\bspad(a|e|ina|ine|ino|ini)\b|\bsword\b/, 'sword'],
  [/\bpiccon(e|i|etto|etti)\b|\bpick(axe)?\b/, 'pickaxe'],
  [/\basci(a|e)\b|\baxe\b/, 'axe'],
  [/\bpal(a|e)\b|\bshovel\b/, 'shovel'],
  [/\bzapp(a|e)\b|\bhoe\b/, 'hoe'],
  [/\belm(o|etto|etti|i)\b|\bcasco\b|\bhelmet\b/, 'helmet'],
  [/\bcorazz(a|e)\b|\bpettoral(e|i)\b|\bchestplate\b/, 'chestplate'],
  [/\bgambal(e|i)\b|\bleggings\b/, 'leggings'],
  [/\bstival(e|i)\b|\bboots\b/, 'boots'],
  [/\barmatur(a|e)\b|\barmor\b/, 'armor'],
  [/\bscud(o|i)\b|\bshield\b/, 'shield'],
  [/\bpagnott(a|e)\b|\bpane\b|\bbread\b/, 'bread'],
  [/\bmel(a|e)\b|\bapple\b/, 'apple'],
  [/\bterr(a|e)\b|\bdirt\b/, 'dirt'],
  [/\bpietr(a|e)\b|\bstone\b/, 'stone'],
  [/\blegn(o|a|e)\b|\bplanks?\b/, 'planks'],
  [/\bferr(o|i)\b|\biron\b/, 'iron'],
  // "bronzo" non esiste in Minecraft vanilla: si legge come il tier rame.
  [/\bram(e|i)\b|\bcopper\b|\bbronz(o|i)\b|\bbronze\b/, 'copper'],
  [/\bor(o|i)\b|\bgold(en)?\b/, 'gold'],
  [/\bcarbon(e|i)\b|\bcoal\b/, 'coal'],
  [/\bdiamant(e|i)\b|\bdiamond\b/, 'diamond'],
  [/\btorci(a|e)\b|\btorch(es)?\b/, 'torch'],
  [/\blett(o|i)\b|\bbed\b/, 'bed'],
  [/\bzucca\b|\bzucche\b|\bpumpkin\b/, 'pumpkin'],
];

// Materiale dell'oggetto nominato: "una spada di rame" è una domanda diversa da
// "una spada". Il bronzo non esiste in Minecraft vanilla — nessun item
// `bronze_*`, nessuna ricetta, solo mod e proposte — e dal Copper Age (Bedrock
// 1.21.111, Java 1.21.9, 30/09/2025) il materiale fra pietra e ferro è il rame:
// "bronzo"/"bronze" si leggono come rame invece di ignorare la domanda.
const MATERIAL_WORDS = [
  [/\b(legn(o|i)|wooden|wood)\b/, 'wooden'],
  [/\b(pietr(a|e)|stone)\b/, 'stone'],
  [/\b(ram(e|i)|copper|bronz(o|i)|bronze)\b/, 'copper'],
  [/\b(ferr(o|i)|iron)\b/, 'iron'],
  [/\b(or(o|i)|gold(en)?)\b/, 'gold'],
  [/\b(chainmail|maglia)\b/, 'chainmail'],
  [/\b(diamant(e|i)|diamond)\b/, 'diamond'],
  [/\bnetherite\b/, 'netherite'],
  [/\b(cuoio|leather)\b/, 'leather'],
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

function matchItemWord (message) {
  const text = normalizeForMatching(message);
  if (!text) return null;
  for (const [pattern, token] of ITEM_WORDS) {
    if (pattern.test(text)) return token;
  }
  return null;
}

function inventoryAnswer (obs, { message = null, limit = 4 } = {}) {
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
      if (material && ofKind.length) return `no, non ne ho; ho: ${ofKind.join(', ')}`;
      return 'no, non ne ho';
    }
    const shown = names.map(name => (Number(inventory[name]) > 1 ? `${name} x${inventory[name]}` : name));
    return `sì: ${shown.join(', ')}`;
  }
  const rows = Object.entries(inventory)
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  if (!rows.length) return 'non ho niente in inventario';
  const shown = rows.slice(0, limit).map(([item, count]) => (Number(count) > 1 ? `${item} x${count}` : item));
  const more = rows.length > limit ? ` (+${rows.length - limit} altri)` : '';
  return `ho: ${shown.join(', ')}${more}`;
}

// Cosa indossa, non cosa possiede: `observe().armor` è lo stato degli slot
// addosso (elmo/pettorale/gambali/stivali) più i punti armatura vanilla.
function armorAnswer (obs) {
  const armor = obs?.armor && typeof obs.armor === 'object' ? obs.armor : null;
  if (!armor) return 'non lo so: non ho letto la mia armatura';
  const worn = ['helmet', 'chestplate', 'leggings', 'boots'].map(slot => armor[slot]).filter(Boolean);
  if (!worn.length) return 'non indosso armatura';
  const points = Number.isFinite(Number(armor.points)) ? ` (${round(armor.points)} punti armatura)` : '';
  return `indosso: ${worn.join(', ')}${points}`;
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

function timeAnswer (obs) {
  const info = obs?.time;
  const clock = clockFromTicks(info?.ticks);
  const phase = info?.night === true ? 'notte' : info?.night === false ? 'giorno' : null;
  if (clock && phase) return `sono le ${clock} (${phase})`;
  if (clock) return `sono le ${clock}`;
  if (phase) return `è ${phase}`;
  return 'non lo so che ore siano';
}

function identityAnswer (_obs, { prefixes = DEFAULT_CHAT_PREFIX } = {}) {
  const list = formatPrefixes(prefixes) || DEFAULT_CHAT_PREFIX;
  return `sono Hermes, il bot di casa. Scrivimi "${list} <ordine>", per esempio "${list} seguimi" o "${list} mina ferro".`;
}

// The catalogue: `patterns` is the regex fast path (answered without any model
// call), `description` is what Jev reads to route a message that matched none.
// Order matters only for the fast path (first match wins).
export const QUESTION_INTENTS = [
  {
    id: 'q_position',
    description: 'The human asks where the bot is right now: its position, its coordinates or its dimension (e.g. "dove sei", "where are you", "non ti vedo").',
    patterns: [/\b(dove (sei|ti trovi|siete)|posizione|coordinate|non ti vedo|where are you|your (position|coordinates))\b/],
    answer: positionAnswer,
  },
  {
    id: 'q_health',
    description: 'The human asks how the bot is doing: its health, its food/hunger, or whether it is hurt or dead (e.g. "come stai", "how are you", "hai fame", "sei vivo").',
    patterns: [/\b(come stai|come ti senti|quanta vita|quanti cuori|quante cuori|quanto cuore|quanta fame|quanto cibo|quanta cibo|hai fame|hai vita|sei vivo|how are you|how much health|how many hearts|your health)\b/],
    answer: healthAnswer,
  },
  {
    id: 'q_armor',
    description: 'The human asks which armor or equipment the bot is *wearing* right now (e.g. "che armatura hai", "cosa indossi", "sei equipaggiato", "what armor are you wearing"). Not the inventory: a piece held in the inventory but not equipped is not worn yet.',
    patterns: [/\b(che armatura|quale armatura|armatura (hai|indossi|addosso)|hai (l |la |una |un )?armatura|cosa indossi|cosa hai addosso|cosa hai in testa|sei equipaggiat|what armor|what are you wearing|are you wearing)\b/],
    answer: armorAnswer,
  },
  {
    id: 'q_activity',
    description: 'The human asks what the bot is doing right now, or why it is not moving (e.g. "che fai", "cosa stai facendo", "non ti vedo che fai", "what are you doing").',
    patterns: [/\b(che fai|che stai facendo|cosa stai facendo|che cosa fai|what are you doing|what'?s your plan)\b/],
    answer: activityAnswer,
  },
  {
    id: 'q_inventory',
    description: 'The human asks which items the bot carries, or whether it has a specific item (e.g. "cosa hai", "che oggetti hai", "hai della pietra", "what do you have").',
    patterns: [/\b(cosa hai\b(?!\s+(fatto|detto|visto|trovato|imparato))|cosa porti|cosa possiedi|che oggetti|inventario|inventory|what do you have|do you have|have you got|hai (un|uno|una|del|dello|della|dei|degli|delle|qualche|qualcosa)|quanto \w+ (hai|possiedi)|quant[oaie] \w+ (hai|possiedi)|quanti \w+ (hai|possiedi))\b/],
    answer: inventoryAnswer,
  },
  {
    id: 'q_time',
    description: 'The human asks the in-game time, or whether it is day or night (e.g. "che ore sono", "is it night").',
    patterns: [/\b(che ora|che ore|what time is it|is it night|fa buio)\b/],
    answer: timeAnswer,
  },
  {
    id: 'q_identity',
    description: 'The human asks who the bot is, what it can do, or how to give it orders (e.g. "chi sei", "aiuto", "who are you", "what can you do").',
    patterns: [/\b(chi sei|cosa sai fare|aiuto|who are you|what can you do)\b/],
    answer: identityAnswer,
  },
];

// Lowercase, punctuation flattened to spaces: "HEI DOVE SEI?" and "hei, dove
// sei?" must be the same message for the fast path.
export function normalizeForMatching (message) {
  return String(message ?? '')
    .toLowerCase()
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
export function answerIntent (id, obs = {}, { prefixes = DEFAULT_CHAT_PREFIX, maxLength = DEFAULT_REPLY_MAX_LENGTH, message = null } = {}) {
  const intent = QUESTION_INTENTS.find(candidate => candidate.id === id);
  if (!intent) return null;
  // `message` arriva all'answer: una domanda come "hai una spada?" nomina
  // l'oggetto, e l'inventario deve rispondere su quello. Il testo resta
  // un'indicazione, i fatti restano quelli di `observe()`.
  const answer = intent.answer(obs ?? {}, { prefixes, message });
  return answer ? clampMessage(answer, maxLength) : null;
}

// One addressed chat line: `@<sender> <answer>` — never the trigger itself, so
// `replyChat`'s self-trigger guard has nothing to refuse.
export function renderAnswer ({ from, answer, template = DEFAULT_ANSWER_TEMPLATE, maxLength = DEFAULT_REPLY_MAX_LENGTH } = {}) {
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
export const UNROUTED_TEMPLATE = 'non ho capito la domanda. Se era un ordine, scrivi "{prefixes} <ordine>".';

export function renderUnrouted ({ from, prefixes = DEFAULT_CHAT_PREFIX, template = UNROUTED_TEMPLATE, maxLength = DEFAULT_REPLY_MAX_LENGTH } = {}) {
  const answer = renderReply(template, { prefixes: formatPrefixes(prefixes) || DEFAULT_CHAT_PREFIX });
  return renderAnswer({ from, answer, maxLength });
}

// Un ordine di equipaggiamento non si puo' eseguire perche' non c'e' nulla da
// indossare: si dice all'umano, non si lascia il goal aperto su un'azione che
// l'harness non offre (`equip_armor` compare solo se l'inventario ha pezzi).
export const NO_ARMOR_TEMPLATE = 'non ho armatura in inventario, non posso equipaggiarmi';

export function renderNoArmor ({ from, template = NO_ARMOR_TEMPLATE, maxLength = DEFAULT_REPLY_MAX_LENGTH } = {}) {
  return renderAnswer({ from, answer: template, maxLength });
}
