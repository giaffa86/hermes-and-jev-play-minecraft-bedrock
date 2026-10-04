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
  if (Number.isFinite(Number(obs?.health))) parts.push(`${round(obs.health)}/20 di vita`);
  if (Number.isFinite(Number(obs?.food))) parts.push(`${round(obs.food)}/20 di cibo`);
  if (!parts.length) return 'non lo so: non ho letto la mia vita';
  return `ho ${parts.join(' e ')}`;
}

function activityAnswer (obs) {
  const objective = obs?.plan?.objective;
  if (!objective) return 'non ho un obiettivo: sono in attesa di ordini';
  return `sto facendo: ${objective}`;
}

function inventoryAnswer (obs, { limit = 4 } = {}) {
  const inventory = obs?.inventory && typeof obs.inventory === 'object' ? obs.inventory : {};
  const rows = Object.entries(inventory)
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  if (!rows.length) return 'non ho niente in inventario';
  const shown = rows.slice(0, limit).map(([item, count]) => (Number(count) > 1 ? `${item} x${count}` : item));
  const more = rows.length > limit ? ` (+${rows.length - limit} altri)` : '';
  return `ho: ${shown.join(', ')}${more}`;
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

function identityAnswer (obs, { prefixes = DEFAULT_CHAT_PREFIX } = {}) {
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
    patterns: [/\b(come stai|come ti senti|quanta vita|hai fame|sei vivo|how are you|how much health|your health)\b/],
    answer: healthAnswer,
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
    patterns: [/\b(cosa hai\b(?!\s+(fatto|detto|visto|trovato|imparato))|cosa porti|che oggetti|inventario|inventory|what do you have)\b/],
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
export function answerIntent (id, obs = {}, { prefixes = DEFAULT_CHAT_PREFIX, maxLength = DEFAULT_REPLY_MAX_LENGTH } = {}) {
  const intent = QUESTION_INTENTS.find(candidate => candidate.id === id);
  if (!intent) return null;
  const answer = intent.answer(obs ?? {}, { prefixes });
  return answer ? clampMessage(answer, maxLength) : null;
}

// One addressed chat line: `@<sender> <answer>` — never the trigger itself, so
// `replyChat`'s self-trigger guard has nothing to refuse.
export function renderAnswer ({ from, answer, template = DEFAULT_ANSWER_TEMPLATE, maxLength = DEFAULT_REPLY_MAX_LENGTH } = {}) {
  return renderReply(template, { name: from ?? '?', answer: answer ?? '' }, maxLength);
}
