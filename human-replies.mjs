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
//     the order trigger (`CHAT_PREFIX`, default `@bot`), so the bot can never
//     trigger itself or another bot;
//   * the text is clamped to a bounded length and stripped of newlines (the
//     chat packet is one line and an over-long message is rejected by the
//     adapter);
//   * nothing about the allowlist or internal state is leaked: only the
//     objective (as understood by the planner), the step count and the failure
//     reason the controller itself logged.

export const DEFAULT_REPLY_MAX_LENGTH = 180;

// `{name}` is the sender, `{objective}` the plan objective, `{steps}` the action
// count, `{reason}` the failure/cancel reason.
export const DEFAULT_ACK_TEMPLATE = '@{name} ok: {objective}';
export const DEFAULT_DONE_TEMPLATE = '@{name} fatto: {objective} ({steps} azioni)';
export const DEFAULT_FAILED_TEMPLATE = "@{name} non ce l'ho fatta: {reason}";
export const DEFAULT_STOPPED_TEMPLATE = '@{name} mi fermo qui: {reason}';

// Ultima risorsa del "wolf recovery": l'harness non offre piu' ne'
// `follow_player` ne' `seek_player`, quindi la ricerca autonoma e' fallita. Il
// messaggio non inizia mai con il trigger (il prefisso e' citato fra
// virgolette) e il controller lo manda una volta per episodio, non a ogni passo.
export const DEFAULT_LOST_TEMPLATE = "@{name} non ti vedo piu': ti aspetto qui. Se ti allontani troppo scrivimi \"{prefix} seguimi\".";

export function lostNotice ({ from, prefix = '@bot', template = DEFAULT_LOST_TEMPLATE, maxLength = DEFAULT_REPLY_MAX_LENGTH } = {}) {
  return renderReply(template, { name: from ?? '?', prefix }, maxLength);
}

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
// reading the same channel): `<trigger> ...` at the start is refused.
export function isSelfTriggering (message, prefix = '@bot') {
  const trig = String(prefix ?? '').toLowerCase();
  if (!trig) return false;
  return String(message ?? '').trim().toLowerCase().startsWith(trig);
}
