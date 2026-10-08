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
// Transport only: no logging. `systemOneDecide` is exactly one attempt — the
// retry policy lives in `systemOneDecideWithRetry`, which retries *only* the
// transient failures (5xx/429/408, network) and never a decision the provider
// actually made. The caller still owns the deadline (`timeoutMs` bounds the
// whole call, retries and waits included) and the logging.

import { setTimeout as sleep } from 'node:timers/promises';

// Ogni fallimento porta un `code` così il chiamante può dire *perché* una
// decisione non era disponibile: il router della chat lo trasforma in
// `chat_unrouted.reason` (M6.1).
//
// Il 07/10/2026 il provider decisionale ha risposto `529 system_overloaded` per
// ~25 minuti (e un `504`): ogni 529 chiudeva il run perché un errore fatale
// esce per progetto. Ma due richieste identiche a 1,5 s di distanza hanno dato
// `200 in 3,9 s` e poi `529`: l'errore era transitorio, non una decisione del
// modello. Un 5xx del provider non è un errore del controller.
function systemOneError (code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Stato transitorio del provider: ritentabile. 529 è quello che ha restituito
// TypeSafe ("system_overloaded"), 504 il gateway. 401/403/404 e i «modello
// sconosciuto» NON sono qui: ritentarli sarebbe solo rumore.
export const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

// Politica di retry: `retries` è il numero di tentativi *dopo* il primo, con
// backoff esponenziale (base, 2·base, 4·base …) tagliato a `maxMs` e jitter
// pieno fino a `jitterMs` per non sincronizzare i client. Con i default: 5
// chiamate al massimo, 1+2+4+8 = 15 s di attesa.
export function systemOneRetryPolicy ({retries, baseMs, maxMs, jitterMs} = {}) {
  const number = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    retries: retries ?? number(process.env.SYSTEM_ONE_RETRY_ATTEMPTS, 4),
    baseMs: baseMs ?? number(process.env.SYSTEM_ONE_RETRY_BASE_MS, 1000),
    maxMs: maxMs ?? number(process.env.SYSTEM_ONE_RETRY_MAX_MS, 8000),
    jitterMs: jitterMs ?? number(process.env.SYSTEM_ONE_RETRY_JITTER_MS, 250),
  };
}

function isTransient (error) {
  if (error?.code === 'http') return TRANSIENT_STATUS.has(Number(error.status));
  // Rete rotta (socket, DNS, ECONNRESET): transitoria per definizione. Un
  // abort del chiamante non arriva qui: `systemOneDecide` lo rilancia intatto.
  return error?.code === 'network';
}

// Attesa del tentativo `attempt` (0 = primo retry). Esportata perché è la parte
// che i test devono poter fissare senza orologio vero.
export function systemOneRetryDelay (policy, attempt, random = Math.random) {
  const backoff = Math.min(policy.maxMs, policy.baseMs * 2 ** attempt);
  const jitter = Math.floor((random() ?? 0) * policy.jitterMs);
  return backoff + jitter;
}

export function systemOneConfig ({ model, url, key, timeoutMs } = {}) {
  const typesafeKey = process.env.TYPESAFE_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const apiKey = key ?? typesafeKey ?? openrouterKey;
  if (!apiKey) throw systemOneError('no_key', 'TYPESAFE_API_KEY or OPENROUTER_API_KEY is required for System One decisions');
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
  return oneAttempt({ state, questions, model, url, key, timeoutMs, fetchImpl });
}

async function oneAttempt ({ state, questions, model, url, key, timeoutMs, fetchImpl }) {
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
  let response;
  try {
    response = await fetchImpl(config.url, init);
  } catch (error) {
    // Un timeout/abort del chiamante è una scadenza, non una rete rotta: resta
    // intatto perché `chat-intent` lo distingue (`timeout` vs `error`).
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw error;
    const failure = systemOneError('network', `System One unreachable: ${error?.message ?? error}`);
    failure.cause = error;
    throw failure;
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = systemOneError('http', `System One HTTP ${response.status}: ${JSON.stringify(data?.error ?? data)}`);
    failure.status = response.status;
    throw failure;
  }
  if (data?.error) throw systemOneError('api', `System One error: ${JSON.stringify(data.error)}`);
  if (!data?.answers) throw systemOneError('unparsable', `System One answered without 'answers': ${JSON.stringify(data).slice(0, 200)}`);
  return {
    answers: data.answers,
    model: data.model ?? config.model,
    provider: config.provider,
    usage: data.usage ?? null,
    ms: Date.now() - started,
  };
}

// Un tentativo, più la politica. Ritenta i soli fallimenti transitori; su un
// fallimento definitivo (401/403, modello sconosciuto, risposta senza
// `answers`) esce subito: ritentare una decisione già presa sarebbe sbagliato.
//
// `timeoutMs` è il budget **totale** (attese e tentativi inclusi) — è quello
// che serve a chi ha un umano in attesa — e ogni tentativo riceve solo il tempo
// che resta: il caso in cui il primo tentativo consuma tutto il budget resta
// identico a prima (nessun retry). Senza `timeoutMs` il budget è la somma dei
// backoff della politica.
//
// Il risultato porta `attempts`/`retries`/`ms` (tempo totale) quando c'è stato
// più di un tentativo; l'errore porta gli stessi campi perché una decisione
// mancata resti una riga di ledger leggibile.
export async function systemOneDecideWithRetry ({
  retry, timeoutMs, fetchImpl = fetch, sleepImpl = sleep, now = Date.now, random = Math.random, ...options
} = {}) {
  const policy = systemOneRetryPolicy(retry);
  const totalMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : null;
  const started = now();
  const deadlineAt = totalMs == null ? null : started + totalMs;
  let calls = 0;
  let lastError = null;
  for (;;) {
    if (calls > 0) {
      const delay = systemOneRetryDelay(policy, calls - 1, random);
      if (deadlineAt != null && now() + delay >= deadlineAt) break;
      await sleepImpl(delay);
    }
    const left = deadlineAt == null ? null : deadlineAt - now();
    if (left != null && left <= 0) break;
    calls += 1;
    try {
      const result = await systemOneDecide({...options, fetchImpl, timeoutMs: left ?? undefined});
      return calls === 1 ? result : {...result, attempts: calls, retries: calls - 1, ms: now() - started};
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || calls > policy.retries) break;
    }
  }
  const failure = lastError ?? systemOneError('timeout', `System One gave no answer within ${totalMs} ms`);
  failure.attempts = calls;
  failure.retries = Math.max(0, calls - 1);
  failure.elapsedMs = now() - started;
  throw failure;
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
