// M8 — the bot says out loud what it is about to do on its own.
//
// When a goal starts without a human asking for it (village chore or a survival
// need the governor decided), a plain "I am busy" is not enough: a real player
// working nearby would say *what* they are doing. This module builds that one
// sentence, deterministically and in the configured language, from the goal plan
// and the concrete target the chore saw ("sto raccogliendo le patate").
//
// It is pure by design: the controller hands the sentence to `saySmart`, so the
// model may rephrase it, but the language and the facts are decided here — the
// same invariant as every other chat path (the model never sources truth).

import { DEFAULT_LANG, hasMessage, t } from './chat-i18n.mjs';

// How long the bot stays quiet after one announcement (controller default: it
// may announce a job at most every five minutes, however many jobs it starts).
export const DEFAULT_NARRATE_COOLDOWN_MS = 300000;

// The concrete target of a chore, as `{kind, item}` (see `village-labor.mjs`).
// The item wins only when the catalogue knows its name; otherwise the family
// word is used, so a sentence never shows a raw id.
export function targetWord (target, lang = DEFAULT_LANG) {
  const item = target?.item;
  if (item && hasMessage(lang, `item.${item}`)) return t(lang, `item.${item}`);
  const kind = target?.kind;
  if (kind && hasMessage(lang, `kind.${kind}`)) return t(lang, `kind.${kind}`);
  return t(lang, 'kind.goods');
}

// "sto raccogliendo le patate" — null when the catalogue has no progressive
// form for that chore (then the goal is not announced at all).
export function narrateChore (choreId, target = null, { lang = DEFAULT_LANG } = {}) {
  if (!choreId || !hasMessage(lang, `narrate.${choreId}`)) return null;
  return t(lang, `narrate.${choreId}`, { target: targetWord(target, lang) });
}

// "In autonomia devo andare a dormire" — a whole sentence on purpose: a need
// reads better with its own frame than inside the generic one. The labels are
// already translated (`need.*`), so this only adds the frame.
export function narrateNeed (need, { lang = DEFAULT_LANG } = {}) {
  if (!need || !hasMessage(lang, `need.${need}`)) return null;
  return t(lang, 'narrate_need', { phrase: t(lang, `need.${need}`) });
}

// The line to send for a goal, or null when there is nothing worth saying: the
// caller stays silent instead of emitting a generic filler.
export function narrateGoal (plan, { lang = DEFAULT_LANG } = {}) {
  if (!plan) return null;
  if (plan.chore) {
    const phrase = narrateChore(plan.chore, plan.choreTarget ?? null, { lang });
    return phrase ? t(lang, 'autonomy_narration', { phrase }) : null;
  }
  if (plan.need) return narrateNeed(plan.need, { lang });
  return null;
}
