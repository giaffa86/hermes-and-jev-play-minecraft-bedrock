// System One — typed, closed-set decisions from Jev (TypeSafe, or the
// Jev-compatible decisions endpoint on OpenRouter).
//
// The split this repo follows (controller.mjs header):
//   System Two (Hermes, an LLM) plans and *reasons* about which action to take;
//   System One (Jev) only *picks* from the options it is handed. It never writes
//   prose, and it cannot invent a capability that was not offered to it.
// Action selection (`controller.mjs` jevDecide) and chat intent routing
// (`chat-intent.mjs`) are the same primitive: one `choice` question over a
// closed `criteria` map, answered with per-option probabilities.
//
// Transport only: no logging, no retry, no clock beyond the request duration.
// The caller owns all three.

export function systemOneConfig ({ model, url, key, timeoutMs } = {}) {
  const typesafeKey = process.env.TYPESAFE_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const apiKey = key ?? typesafeKey ?? openrouterKey;
  if (!apiKey) throw new Error('TYPESAFE_API_KEY or OPENROUTER_API_KEY is required for System One decisions');
  return {
    key: apiKey,
    provider: typesafeKey && apiKey === typesafeKey ? 'typesafe' : 'openrouter',
    // TypeSafe's own endpoint is used when its key is the one in play; the same
    // decisions API is also served by OpenRouter (alpha).
    url: url ?? (typesafeKey ? 'https://api.typesafe.ai/v1/systemone' : 'https://openrouter.ai/api/alpha/decisions'),
    model: model ?? (process.env.JEV_MODEL || (typesafeKey ? 'jev-latest' : 'typesafe/jev-1.13')),
    timeoutMs: timeoutMs ?? null,
  };
}

// One decisions request. `state` may be a string or any JSON value (it is
// serialized here). Returns `{ answers, model, usage, ms }`; the caller indexes
// `answers[questionId]`.
//
// `timeoutMs` is opt-in: action selection has no deadline of its own (the
// harness action timeout is the real bound), while a chat reply must not hang
// the loop on a slow model.
export async function systemOneDecide ({ state, questions, model, url, key, timeoutMs, fetchImpl = fetch } = {}) {
  const config = systemOneConfig({ model, url, key, timeoutMs });
  const init = {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      state: typeof state === 'string' ? state : JSON.stringify(state),
      questions,
    }),
  };
  if (config.timeoutMs) init.signal = AbortSignal.timeout(config.timeoutMs);
  const started = Date.now();
  const response = await fetchImpl(config.url, init);
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`System One HTTP ${response.status}: ${JSON.stringify(data?.error ?? data)}`);
  if (data?.error) throw new Error(`System One error: ${JSON.stringify(data.error)}`);
  if (!data?.answers) throw new Error(`System One answered without 'answers': ${JSON.stringify(data).slice(0, 200)}`);
  return {
    answers: data.answers,
    model: data.model ?? config.model,
    provider: config.provider,
    usage: data.usage ?? null,
    ms: Date.now() - started,
  };
}

// Probability of the picked option, from either answer shape (a map keyed by
// choice, or an array indexed by it). `null` when the model did not report one.
export function choiceProbability (answer, choice = answer?.choice) {
  const probabilities = answer?.probabilities;
  if (!probabilities || choice == null) return null;
  if (Array.isArray(probabilities)) {
    const index = Number(String(choice).replace(/^a/i, ''));
    return Number.isFinite(index) ? probabilities[index] ?? null : null;
  }
  return probabilities[choice] ?? null;
}
