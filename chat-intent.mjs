// Which question is a chat message asking? Regex first (free, offline), then
// System One (Jev) over a closed option list when the message matched nothing.
//
// The model is a router, not an author: it returns an intent id (or `q_none`),
// and `human-questions.mjs` composes the answer from the harness facts. So the
// worst case of a bad decision is a question answered with the wrong *fact* —
// never an invented one — and an order that stays an order.
//
// Failure policy: no key, model down, timeout, unparsable answer, low
// probability — all mean "not a question", i.e. the message keeps today's
// behaviour and goes down the order path.

import { intentCriteria, intentFromChoice, matchQuestionIntent } from './human-questions.mjs';
import { choiceProbability, systemOneDecide } from './system-one.mjs';

// A chat reply must not hang the loop on a slow model, but the human is waiting:
// four seconds is the ceiling before the message is treated as an order.
export const DEFAULT_INTENT_TIMEOUT_MS = 4000;
// Probabilities are uncalibrated (they rank options, they do not measure
// confidence): the threshold only exists to keep a hesitant model from
// swallowing an order. `CHAT_INTENT_MIN_P=0` accepts the argmax.
export const DEFAULT_INTENT_MIN_P = 0.4;

export const INTENT_INSTRUCTIONS = [
  'A trusted human player wrote a chat message to a Minecraft bot.',
  'Decide which question about the bot\'s own state the message asks.',
  'Choose the last option when the message asks the bot to do something (an order), greets it, or is small talk.',
  'Judge only the message itself.',
].join(' ');

// One System One call. Returns `{intent, reason, probability, model, ms, cost}`
// where `intent` is null unless the model picked a question intent above the
// probability threshold. Throws only on transport/API errors (the caller
// decides what an unreachable router means).
export async function classifyQuestionIntent (message, {
  from = null, model, url, key, fetchImpl, timeoutMs = DEFAULT_INTENT_TIMEOUT_MS,
  minProbability = DEFAULT_INTENT_MIN_P,
} = {}) {
  const result = await systemOneDecide({
    model, url, key, fetchImpl, timeoutMs,
    state: { message: String(message ?? ''), from: from ?? null },
    questions: { intent: { type: 'choice', instructions: INTENT_INSTRUCTIONS, criteria: intentCriteria() } },
  });
  // `intent` is the question id in our request; `action` is accepted because
  // the decisions API echoes whatever id the caller used.
  const answer = result.answers?.intent ?? result.answers?.action;
  const matched = intentFromChoice(answer?.choice);
  const probability = choiceProbability(answer);
  const confident = probability == null || probability >= minProbability;
  const reason = !matched ? 'not_a_question' : confident ? 'ok' : 'low_probability';
  return {
    intent: reason === 'ok' ? matched : null,
    matched,
    reason,
    probability,
    model: result.model,
    ms: result.ms,
    cost: result.usage?.cost ?? null,
  };
}

// The question router used by the controller: regex fast path, then System One,
// then "not a question". Never throws, and returns null only when there is
// nothing to report (fast path disabled and no pattern matched).
export async function resolveQuestionIntent (message, { from = null, enabled = true, ...options } = {}) {
  const fast = matchQuestionIntent(message);
  if (fast) return { id: fast.id, via: fast.via, reason: 'regex', matched: fast.id, probability: null, model: null, ms: 0, cost: null };
  if (!enabled) return null;
  try {
    const decision = await classifyQuestionIntent(message, { from, ...options });
    return { id: decision.intent, via: 'jev', reason: decision.reason, matched: decision.matched, probability: decision.probability, model: decision.model, ms: decision.ms, cost: decision.cost };
  } catch (error) {
    return { id: null, via: 'jev', reason: 'error', matched: null, probability: null, model: null, ms: null, cost: null, error: error.message };
  }
}
