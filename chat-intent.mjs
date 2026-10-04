// Which question is a chat message asking? Regex first (free, offline), then
// System One (Jev) over a closed option list when the message matched nothing.
//
// The model is a router, not an author: it returns an intent id (or `q_none`),
// and `human-questions.mjs` composes the answer from the harness facts. So the
// worst case of a bad decision is a question answered with the wrong *fact* —
// never an invented one — and an order that stays an order.
//
// Failure policy (M6.1): the message is only treated as an order when the model
// *says* so (`q_none`) or when it never looked like a question in the first
// place. No key, disabled router, model down, timeout, unparsable answer, low
// probability — a question-shaped message is never silently turned into a goal.

import { intentCriteria, intentFromChoice, looksLikeQuestion, matchQuestionIntent } from './human-questions.mjs';
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

// Why the router could not answer: the model itself (`q_none` is a verdict, not
// a failure — that one goes to the order path) versus every way the router can
// be unavailable. Surfaced as `chat_unrouted.reason` so M7 can be driven by
// data instead of impressions.
function failureReason (error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
  if (error?.code === 'no_key') return 'no_key';
  if (error?.code === 'unparsable') return 'unparsable';
  return 'error';
}

const NO_ROUTING = { probability: null, model: null, ms: 0, cost: null, matched: null };

// The question router used by the controller. Never throws; the returned object
// carries an `action` for the caller:
//   'answer'   -> reply with `id` (composed from harness facts by the caller);
//   'order'    -> leave the message to the order path (no goal decided here);
//   'unrouted' -> it looked like a question and we could not decide: say so,
//                 create no goal.
//
// Order of decisions:
//   1. regex fast path: free, offline, wins over the model;
//   2. not question-shaped: the order path, *without asking Jev* — the
//      pre-filter, because otherwise every single order paid one Jev call and
//      up to 4 s of latency before its ack;
//   3. question-shaped with the router off: unrouted (`disabled` / `no_key`);
//   4. question-shaped: ask Jev — an intent above threshold answers, `q_none` is
//      a decision ("this is an order"), anything else is unrouted.
export async function resolveQuestionIntent (message, { from = null, enabled = true, disabledReason = null, ...options } = {}) {
  const fast = matchQuestionIntent(message);
  if (fast) return { action: 'answer', id: fast.id, via: fast.via, reason: 'regex', matched: fast.id, ...NO_ROUTING };
  if (!looksLikeQuestion(message)) return { action: 'order', id: null, via: 'none', reason: 'not_question_like', ...NO_ROUTING };
  if (!enabled) return { action: 'unrouted', id: null, via: 'none', reason: disabledReason ?? 'disabled', ...NO_ROUTING };
  try {
    const decision = await classifyQuestionIntent(message, { from, ...options });
    const fields = { matched: decision.matched, probability: decision.probability, model: decision.model, ms: decision.ms, cost: decision.cost };
    if (decision.reason === 'ok') return { action: 'answer', id: decision.intent, via: 'jev', reason: 'ok', ...fields };
    // A working model said "that is not a question": it is an order, as before.
    if (decision.reason === 'not_a_question') return { action: 'order', id: null, via: 'jev', reason: 'not_a_question', ...fields };
    // `low_probability`: a question we could not decide.
    return { action: 'unrouted', id: null, via: 'jev', reason: decision.reason, ...fields };
  } catch (error) {
    return { action: 'unrouted', id: null, via: 'jev', reason: failureReason(error), ...NO_ROUTING, ms: null, error: error.message };
  }
}
