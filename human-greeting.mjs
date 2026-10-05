// Proactive human greeting — the bot tells a nearby human how to give it an order.
//
// AI-player roadmap section 6 ("Attention System"): when Hermes perceives a
// human player nearby it should make itself known and explain how to command
// it. The actual order syntax belongs to the controller (`CHAT_PREFIXES` /
// `CHAT_PREFIX`, default `@bot`), so the greeting is rendered here from a
// template and handed to the harness `/say` route (the bot speaking is the M5
// capability of wiki/human-command.md).
//
// Pure module: no I/O, no clock except the caller-supplied `now`, no knowledge
// of the transport. `planGreetings` maps nearby humans + the allowlist +
// already-greeted state to the messages to send *this step*.

import {DEFAULT_CHAT_PREFIX, normalizePrefixes} from './human-replies.mjs';
import {DEFAULT_LANG, t} from './chat-i18n.mjs';

// The default (Italian) greeting, kept exported for compatibility; the language
// is `CHAT_LANG` and the controller picks `t(lang, 'greet')`.
export const DEFAULT_GREETING_TEMPLATE = t(DEFAULT_LANG, 'greet');

// A human within this radius of the bot counts as "perceived" (the adapter
// tracks players up to 64 blocks, but a greeting only makes sense up close).
export const DEFAULT_GREET_RANGE = 24;
// Re-greet the same human only after this long (milliseconds); 0 = greet once
// per session and never again.
export const DEFAULT_GREET_COOLDOWN_MS = 600000;

// Replace the template placeholders. Kept separate so the rendered text is
// trivially unit-testable and the caller can supply any template. `{prefix}`
// and `{prefixes}` are aliases for the same thing: the exact syntax the
// controller accepts, i.e. every configured trigger joined by `separator`
// (`@bot o @hermes`).
export function renderGreeting (template, { username, prefix, prefixes, separator = null, lang = DEFAULT_LANG } = {}) {
  const label = formatPrefixes(prefixes ?? prefix, { separator: separator ?? t(lang, 'list_or') }) || formatPrefixes(prefix, { separator: separator ?? t(lang, 'list_or') });
  return String(template ?? '')
    .replaceAll('{name}', username ?? '')
    .replaceAll('{prefixes}', label)
    .replaceAll('{prefix}', label);
}

// Human-readable list of the configured triggers, in configuration order.
export function formatPrefixes (value, { separator = ' o ' } = {}) {
  return normalizePrefixes(value, { fallback: null }).join(separator);
}

// Which humans deserve a greeting right now.
//   humans     : [{ username, distance }] from the harness observation
//   allowlist  : Set of gamertags/xuids allowed to command the bot (lowercase).
//                Empty/absent = nobody: greeting would advertise a channel that
//                is not actually open, so it is suppressed.
//   greeted    : Map username(lowercase) -> last greeting timestamp
//   cooldownMs : minimum age before re-greeting; <= 0 = once per session.
// Returns [{ username, message, distance }] (possibly empty).
export function planGreetings ({
  humans = [],
  allowlist = null,
  prefix = DEFAULT_CHAT_PREFIX,
  prefixes = null,
  greeted = null,
  now = Date.now(),
  cooldownMs = DEFAULT_GREET_COOLDOWN_MS,
  range = DEFAULT_GREET_RANGE,
  template = null,
  separator = null,
  lang = DEFAULT_LANG,
} = {}) {
  const greetingTemplate = template ?? t(lang, 'greet');
  if (!allowlist || !allowlist.size) return [];
  const out = [];
  const seen = new Set();
  for (const human of humans) {
    const username = human?.username ? String(human.username) : null;
    if (!username) continue;
    const key = username.toLowerCase();
    if (seen.has(key)) continue;              // one greeting per human per step
    seen.add(key);
    const distance = human.distance;
    if (distance != null && Number.isFinite(distance) && distance > range) continue;
    if (!allowlist.has(key)) continue;        // only trusted humans are informed
    const last = typeof greeted?.get === 'function' ? greeted.get(key) : null;
    if (last != null && (cooldownMs <= 0 || now - last < cooldownMs)) continue;
    out.push({
      username,
      distance: distance ?? null,
      message: renderGreeting(greetingTemplate, { username, prefixes: prefixes ?? prefix, separator, lang }),
    });
  }
  return out;
}
