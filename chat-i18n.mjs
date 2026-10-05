// Chat internationalisation (M8): every message the bot writes in chat comes
// from the catalogue in `chat-lang/` — one module per language — and is looked
// up through this API only. `CHAT_LANG` picks the default
// language — the one the bot speaks on its own (greeting, unrouted question,
// lifecycle templates, answers to questions) — and unknown values fall back to
// `DEFAULT_LANG` instead of leaving the channel in a language nobody chose.
//
// Pure module: no I/O, no clock, no model, no knowledge of the transport. The
// controller resolves the language once (`chatLangConfig`) and passes it down;
// the renderers (`human-replies.mjs`, `human-questions.mjs`, `human-greeting.mjs`)
// only look the strings up.
//
// Why the *default* language and not the sender's: a chat message carries no
// reliable language tag, and the deterministic path must never guess a fact.
// What is certain is the server's language, which the owner configures once.
// The model path (M7) is the one that follows the sender turn by turn, and it
// is already told to do so (`chat-llm.mjs`).
//
// Translations are deliberately plain and short: they are one-line chat
// messages, not prose. A key missing in a language falls back to the default
// language and then to the key itself, so a half-translated catalogue degrades
// instead of crashing.

export const LANGS = Object.freeze(['it', 'en', 'fr', 'es', 'de']);

// The language the bot speaks when nothing says otherwise. Italian is the
// historic behaviour of this server, so existing deployments do not change.
export const DEFAULT_LANG = 'it';

// Names used inside a *prompt* (the planner writes in English).
export const LANG_NAMES = Object.freeze({ it: 'Italian', en: 'English', fr: 'French', es: 'Spanish', de: 'German' });

// Names a human would use in their own language, for prompts that must be
// language-agnostic (`chat-llm.mjs` tells the model "if the language of the
// message is unclear, answer in <own language name>").
export const LANG_NATIVE_NAMES = Object.freeze({
  it: 'italiano', en: 'English', fr: 'français', es: 'español', de: 'Deutsch',
});

import it from './chat-lang/it.mjs';
import en from './chat-lang/en.mjs';
import fr from './chat-lang/fr.mjs';
import es from './chat-lang/es.mjs';
import de from './chat-lang/de.mjs';

// The catalogue, one frozen table per language file. Keys are flat and dotted;
// `{name}` placeholders are filled by `t()` and a missing value renders as the
// key itself (same rule as `renderReply` in `human-replies.mjs`). Adding a
// language means adding a file here and its code to `LANGS`/`LANG_NAMES`/
// `LANG_NATIVE_NAMES` — the tables are assembled by code, so the five files
// can never drift in *shape* (the tests check the *content* parity).
const CATALOGUES = { it, en, fr, es, de };
export const MESSAGES = Object.freeze(CATALOGUES);

export function isSupportedLang (value) {
  return LANGS.includes(String(value ?? '').trim().toLowerCase());
}

// `CHAT_LANG=EN`, `CHAT_LANG=en-US`, `chat_lang=De` all resolve to a supported
// code. Anything else is not a language mistake to crash on: it falls back to
// `fallback` (the default language) and the caller can log `supported: false`.
export function normalizeLang (value, { fallback = DEFAULT_LANG } = {}) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  // `en-US` / `pt-BR`: the region is not used by the catalogue.
  const base = raw.split(/[-_]/)[0];
  if (LANGS.includes(base)) return base;
  if (LANGS.includes(raw)) return raw;
  return fallback;
}

// Resolve `CHAT_LANG` once, at startup. `requested` is what the owner wrote,
// `lang` is what the catalogue will actually use, `supported` says whether the
// two differ (a typo is worth a log line, not a crash).
export function chatLangConfig (env = {}, { fallback = DEFAULT_LANG, varName = 'CHAT_LANG' } = {}) {
  const requested = env?.[varName];
  const configured = String(requested ?? '').trim();
  // `en-US`/`DE` sono accettate: conta il codice base, la regione la ignora il
  // catalogo. Solo una lingua davvero assente ripiega sul default.
  const base = configured.toLowerCase().split(/[-_]/)[0];
  const supported = LANGS.includes(base);
  return {
    lang: supported ? base : fallback,
    fallback,
    varName,
    requested: configured || null,
    configured: Boolean(configured) && supported,
    supported,
  };
}

// The human-readable name of a language: `native` gives the name a speaker
// would use in that language ("italiano"), the default the English name
// ("Italian") for prompts.
export function languageName (lang, { native = false } = {}) {
  const code = normalizeLang(lang);
  return (native ? LANG_NATIVE_NAMES : LANG_NAMES)[code];
}

// Look up a message and fill `{placeholders}`. A key missing in the requested
// language falls back to the default language, and a key missing everywhere
// renders as the key itself: a visible bug, never a silent empty line.
export function t (lang, key, vars = null, { fallback = DEFAULT_LANG } = {}) {
  const code = normalizeLang(lang, { fallback });
  const text = MESSAGES[code]?.[key] ?? MESSAGES[normalizeLang(fallback)]?.[key] ?? String(key ?? '');
  // `vars` assente = si vuole il *template* (gli argomenti arrivano dopo, a
  // `renderReply`/`renderGreeting`): interpolare qui con un oggetto vuoto
  // cancellerebbe i segnaposto e il messaggio uscirebbe vuoto.
  return vars ? interpolate(text, vars) : text;
}

export function hasMessage (lang, key) {
  if (!isSupportedLang(lang)) return false;
  return MESSAGES[normalizeLang(lang)]?.[key] != null;
}

// Every key of the default catalogue: the tests use it to prove the five
// languages cover the same ground.
export function messageKeys (lang = DEFAULT_LANG) {
  return Object.keys(MESSAGES[normalizeLang(lang)] ?? {}).sort();
}

// "a, b e c" / "a, b and c" / "a, b y c": the conjunction belongs to the
// language too, and it is used for the facts (inventory, armor, health).
export function listAnd (items, lang = DEFAULT_LANG) {
  const list = (Array.isArray(items) ? items : [items]).map(item => String(item ?? '')).filter(Boolean);
  if (list.length <= 1) return list.join('');
  const and = t(lang, 'list_and');
  return `${list.slice(0, -1).join(', ')}${and}${list.at(-1)}`;
}

// Un segnaposto senza valore resta visibile: un template incompleto e' un bug
// che si vede subito, non una frase muta a meta'.
function interpolate (text, vars = {}) {
  return String(text ?? '').replace(/\{(\w+)\}/g, (match, key) => {
    const value = vars?.[key];
    return value == null ? match : String(value);
  });
}
