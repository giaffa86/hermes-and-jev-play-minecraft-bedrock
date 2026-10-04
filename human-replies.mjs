// Chat replies for a human order (wiki/human-command.md M5): the bot ack-
// nowledges the order it accepted and reports the outcome when the goal closes.
//
// The channel is the same one used by the proactive greeting
// (`human-greeting.mjs` -> `POST /say`), so the messages are short, single
// line, rate-limited by the adapter (`sendChat`). This module is pure: no I/O,
// no clock, no transport. The controller renders the text and decides when to
// send it.
//
// Safety rules encoded here:
//   * a reply is addressed to the sender (`@{name} ...`) and never starts with
//     any order trigger (`CHAT_PREFIXES`/`CHAT_PREFIX`, default `@bot`), so the
//     bot can never trigger itself or another bot;
//   * the text is clamped to a bounded length and stripped of newlines (the
//     chat packet is one line and an over-long message is rejected by the
//     adapter);
//   * nothing about the allowlist or internal state is leaked: only the
//     objective (as understood by the planner), the step count and the failure
//     reason the controller itself logged.

export const DEFAULT_REPLY_MAX_LENGTH = 180;

export const DEFAULT_CHAT_PREFIX = '@bot';

// The triggers that start an order. One bot can answer to more than one (e.g.
// `@bot` plus its own name): `CHAT_PREFIXES` is a comma/space separated list,
// while the legacy single `CHAT_PREFIX` keeps working. Configuration order is
// preserved (it is the display order in the greeting), duplicates and empty
// entries are dropped, and `fallback` is used only when nothing is configured.
// NOTE: two bots on the same server must use *distinct* prefixes, otherwise a
// shared trigger makes both of them act on the same message.
export function normalizePrefixes (value, { fallback = DEFAULT_CHAT_PREFIX } = {}) {
  const raw = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of raw) {
    for (const part of String(item ?? '').split(/[\s,]+/)) {
      const prefix = part.trim().toLowerCase();
      if (prefix && !out.includes(prefix)) out.push(prefix);
    }
  }
  if (out.length) return out;
  return fallback ? normalizePrefixes(fallback, { fallback: null }) : [];
}

// I trigger che identificano il bot stesso: il nome di autenticazione
// (`BEDROCK_USERNAME`, esposto da `observe().self.username`) e, appena il server
// lo attribuisce, il gamertag reale imparato dall'eco (`observe().self.name` —
// può differire dal primo, osservato live). Serve a farsi chiamare per nome: con
// più bot sullo stesso server ognuno risponde al proprio. `enabled: false`
// (`CHAT_SELF_NAME=off`) li spegne e lascia solo `CHAT_PREFIXES`.
export function selfPrefixes (self, { enabled = true } = {}) {
  if (!enabled) return [];
  const out = [];
  for (const name of [self?.username, self?.name]) {
    const clean = String(name ?? '').trim().replace(/^@+/, '');
    if (!clean) continue;
    const prefix = `@${clean.toLowerCase()}`;
    if (!out.includes(prefix)) out.push(prefix);
  }
  return out;
}

// Which configured trigger (if any) starts this chat line, and what is left
// after it. Longest prefix wins, so `@bot1` is not mistaken for `@bot`.
// Returns `{ prefix, rest }` or null.
export function matchChatPrefix (message, prefixes = DEFAULT_CHAT_PREFIX) {
  const text = String(message ?? '').trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const prefix of [...normalizePrefixes(prefixes)].sort((a, b) => b.length - a.length)) {
    if (lower.startsWith(prefix)) return { prefix, rest: text.slice(prefix.length).trim() };
  }
  return null;
}

// `{name}` is the sender, `{objective}` the plan objective, `{steps}` the action
// count, `{reason}` the failure/cancel reason.
export const DEFAULT_ACK_TEMPLATE = '@{name} ok: {objective}';
export const DEFAULT_DONE_TEMPLATE = '@{name} fatto: {objective} ({steps} azioni)';
export const DEFAULT_FAILED_TEMPLATE = "@{name} non ce l'ho fatta: {reason}";
export const DEFAULT_STOPPED_TEMPLATE = '@{name} mi fermo qui: {reason}';

// One chat line: no newlines, collapsed spaces, bounded length. Truncation
// happens on the rendered text (after placeholders), so a long objective can
// never push the message over the packet limit.
export function clampMessage (text, maxLength = DEFAULT_REPLY_MAX_LENGTH) {
  const flat = String(text ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const limit = Number.isFinite(maxLength) && maxLength > 0 ? Math.floor(maxLength) : DEFAULT_REPLY_MAX_LENGTH;
  if (flat.length <= limit) return flat;
  // Keep one character for the ellipsis so the result never exceeds the limit.
  return `${flat.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function renderReply (template, vars = {}, maxLength = DEFAULT_REPLY_MAX_LENGTH) {
  const rendered = String(template ?? '').replace(/\{(\w+)\}/g, (match, key) => {
    const value = vars[key];
    return value == null ? '' : String(value);
  });
  return clampMessage(rendered, maxLength);
}

// The bot accepted the order: confirm what it understood (M5 "ack a specific
// order"). `plan.follow` is worth naming because an escort order is open-ended
// and the human wants to know the bot is coming.
export function orderAck ({ from, plan, template = DEFAULT_ACK_TEMPLATE, maxLength = DEFAULT_REPLY_MAX_LENGTH } = {}) {
  const objective = plan?.objective ?? plan?.notes ?? 'ordine ricevuto';
  const follow = plan?.follow ? ` — arrivo da ${plan.follow}` : '';
  return renderReply(template, { name: from ?? '?', objective: `${objective}${follow}`, follow: plan?.follow ?? '' }, maxLength);
}

// The goal that carried the order ended. `status` is the controller outcome:
// `success` | `failed` | anything else (exhausted/cancelled => "stopped").
export function orderOutcome ({
  from, status, objective, steps, reason,
  templates = {}, maxLength = DEFAULT_REPLY_MAX_LENGTH,
} = {}) {
  const t = {
    done: templates.done ?? DEFAULT_DONE_TEMPLATE,
    failed: templates.failed ?? DEFAULT_FAILED_TEMPLATE,
    stopped: templates.stopped ?? DEFAULT_STOPPED_TEMPLATE,
  };
  const name = from ?? '?';
  if (status === 'success') {
    return renderReply(t.done, { name, objective: objective ?? 'ordine', steps: steps == null ? '?' : steps }, maxLength);
  }
  const why = reason ?? (status === 'failed' ? 'fallito' : 'budget di azioni esaurito');
  return renderReply(status === 'failed' ? t.failed : t.stopped, { name, objective: objective ?? 'ordine', steps: steps ?? '', reason: why }, maxLength);
}

// The reply must never look like an order to the bot itself (or to another bot
// reading the same channel): `<trigger> ...` at the start is refused, for every
// configured trigger (`prefix` may be a string or a list).
export function isSelfTriggering (message, prefixes = DEFAULT_CHAT_PREFIX) {
  return matchChatPrefix(message, prefixes) != null;
}
