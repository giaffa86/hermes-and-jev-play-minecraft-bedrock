// Natural chat for the bot (M7): an LLM rephrases the deterministic replies the
// controller already computed, so the bot stops sounding like a status line.
//
// Design rules, in the same spirit as `chat-intent.mjs`:
//   * the model is an *author*, never a source of truth: it receives a compact
//     `facts` object built from `observe()` and, whenever a deterministic answer
//     exists, a `grounding` string with the real numbers. It may only rephrase;
//     inventing facts is a bug, not a feature;
//   * the model never chooses an action and never creates a goal: the order path
//     (`humanCommandPlan` + `/options`) is untouched;
//   * every failure (no key, timeout, HTTP error, empty or self-triggering
//     reply) falls back to the deterministic template, so the channel is never
//     silent;
//   * the reply is one line, clamped to `CHAT_REPLY_MAX_LENGTH` and refused when
//     it would start with a trigger (`isSelfTriggering`), exactly like the
//     templates;
//   * this module is pure I/O against an OpenAI-compatible `/chat/completions`
//     endpoint: fetch and clock are injectable, so tests need no network.

import {clampMessage, isSelfTriggering, DEFAULT_REPLY_MAX_LENGTH} from './human-replies.mjs';

// DeepSeek is the default engine (the key is the gate: without it the
// controller stays on the deterministic path). Any OpenAI-compatible endpoint
// works through `CHAT_LLM_URL`.
export const DEFAULT_CHAT_LLM_URL = 'https://api.deepseek.com/chat/completions';
export const DEFAULT_CHAT_LLM_MODEL = 'deepseek-chat';
export const DEFAULT_CHAT_LLM_TIMEOUT_MS = 8000;
export const DEFAULT_CHAT_HISTORY_TURNS = 6;
export const DEFAULT_CHAT_HISTORY_SENDERS = 8;
export const DEFAULT_CHAT_MAX_TOKENS = 120;
export const DEFAULT_REASON_MAX_TOKENS = 220;

// M11 «ragiona»: l'umano può chiedere una risposta *ragionata* invece di una
// frase del catalogo. Il marcatore è una parola sola, dove capita nel messaggio
// («ragiona: perché non stai minando?», «perché non stai minando? ragiona»);
// viene tolto e il resto del messaggio resta quello che era — un ordine resta un
// ordine, una domanda diventa una domanda a cui rispondere dai fatti.
export const DEFAULT_REASON_MARKERS = Object.freeze([
  'ragiona', 'ragionate', 'pensaci', 'pensa', 'rifletti',
  'think', 'reason', 'reflect',
  'reflechis', 'pense',
  'piensa', 'razona', 'reflexiona',
  'denk', 'denke', 'uberlege',
]);

function foldReasonWord (word) {
  return String(word ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

// Riconosce il marcatore (accenti ignorati, così `réfléchis` e `überlege`
// funzionano anche scritti senza accenti) e restituisce `{reason, message}`: il
// messaggio senza il marcatore, ripulito della punteggiatura rimasta orfana in
// testa o in coda. Non decide *cosa* fare del messaggio: lo decide il chiamante.
export function reasonRequest (message, {markers = DEFAULT_REASON_MARKERS} = {}) {
  const text = String(message ?? '');
  if (!text) return {reason: false, message: ''};
  const wanted = new Set((markers || []).map(foldReasonWord));
  let reason = false;
  // La punteggiatura che appartiene al marcatore («ragiona:», «ragiona,») se ne va
  // con lui; quella che non è sua resta. Così «ragiona: perché non mino?» perde i
  // due punti ma tiene il punto interrogativo, che è la domanda, e
  // «piensa: ¿por qué?» tiene anche l'inversione spagnola.
  const pieces = text.split(/([^\p{L}\p{N}']+)/u);
  const kept = [];
  pieces.forEach((piece, i) => {
    const isWord = /^[\p{L}\p{N}']+$/u.test(piece);
    const previousRemoved = i > 0 && /^[\p{L}\p{N}']+$/u.test(pieces[i - 1]) && wanted.has(foldReasonWord(pieces[i - 1]));
    if (isWord) {
      if (wanted.has(foldReasonWord(piece))) { reason = true; return; }
      kept.push(piece);
      return;
    }
    kept.push(previousRemoved ? piece.replace(/^[\s:,;\-–—.]+/u, '') : piece);
  });
  if (!reason) return {reason: false, message: text};
  const cleaned = kept.join('').replace(/[^\S\n]{2,}/g, ' ').trim();
  return {reason: true, message: cleaned};
}

export const DEFAULT_CHAT_PERSONA =
  "Hermes, il bot di casa di un server Minecraft Bedrock: vivi nel villaggio come un giocatore, lavori con gli altri (coltivazioni, pastorizia, legname, minerali, pesca) e dai una mano nelle missioni";

// The key may arrive under either name; `CHAT_LLM_API_KEY` wins so the engine
// can be pointed at another provider without touching `DEEPSEEK_API_KEY`.
export function chatLlmKey (env = process.env) {
  const key = env.CHAT_LLM_API_KEY || env.DEEPSEEK_API_KEY;
  return key ? String(key) : null;
}

// Resolved configuration. `CHAT_LLM=off` disables the engine even with a key;
// `CHAT_LLM=on` without a key stays disabled (`enabled: false`), and the
// controller falls back to the deterministic path.
export function chatLlmConfig ({ env = process.env, key, url, model, timeoutMs, persona, maxLength, enabled } = {}) {
  const resolvedKey = key !== undefined ? key : chatLlmKey(env);
  const off = /^(0|off|false|no)$/i.test(String(env.CHAT_LLM ?? ''));
  return {
    key: resolvedKey || null,
    url: url ?? env.CHAT_LLM_URL ?? DEFAULT_CHAT_LLM_URL,
    model: model ?? env.CHAT_LLM_MODEL ?? DEFAULT_CHAT_LLM_MODEL,
    timeoutMs: timeoutMs ?? +(env.CHAT_LLM_TIMEOUT_MS || DEFAULT_CHAT_LLM_TIMEOUT_MS),
    persona: persona ?? env.CHAT_PERSONA ?? DEFAULT_CHAT_PERSONA,
    maxLength: maxLength ?? +(env.CHAT_REPLY_MAX_LENGTH || DEFAULT_REPLY_MAX_LENGTH),
    enabled: enabled !== undefined ? !!enabled : (Boolean(resolvedKey) && !off),
  };
}

import {DEFAULT_LANG, LANG_NATIVE_NAMES, languageName} from './chat-i18n.mjs';

function firstLine (text) {
  return String(text ?? '').replace(/```[a-z]*\n?/gi, '').split(/[\r\n]+/).map(line => line.trim()).filter(Boolean)[0] ?? '';
}

// System + history + one user turn. Exported so a test can assert the two rules
// that matter: facts are the only allowed source, and a reply must not start
// with a trigger.
export function buildChatMessages ({
  message, from = null, facts = null, grounding = null, history = [],
  persona = DEFAULT_CHAT_PERSONA, prefixes = [], maxLength = DEFAULT_REPLY_MAX_LENGTH,
  lang = DEFAULT_LANG, reasoned = false,
} = {}) {
  const triggers = (prefixes || []).map(p => `"${p}"`).join(', ');
  // La lingua configurata (`CHAT_LANG`) non forza la risposta: comanda la lingua
  // del messaggio. Serve però a coprire i casi ambigui ("ok", "grazie", un
  // comando senza parole) — lì il bot risponde nella lingua di casa.
  const native = LANG_NATIVE_NAMES[lang] ?? LANG_NATIVE_NAMES[DEFAULT_LANG];
  const system = [
    `Sei ${persona}.`,
    'Stai giocando in chat su un server Minecraft Bedrock con altri giocatori reali.',
    `Rispondi SEMPRE nella stessa lingua del messaggio che ricevi (messaggio in italiano -> risposta in italiano). Se dal messaggio la lingua non è chiara, rispondi in ${native}.`,
    'Parla di te in prima persona ("sto andando", "ho 3 pane"): mai in terza persona, mai come una descrizione.',
    `Rispondi con UNA sola riga breve (massimo circa ${maxLength} caratteri), tono naturale e colloquiale da giocatore: niente markdown, niente elenchi.`,
    "Usa SOLO i fatti elencati sotto. Se un fatto non c'e', di' che non lo sai: non inventare numeri, oggetti, coordinate, azioni o persone.",
    'Non promettere di fare cose che non risultano tra le tue capacita: se non sai, dillo.',
    // M11: con «ragiona» non c'è una frase da riformulare, c'è una domanda a cui
    // rispondere collegando i fatti (che cosa sto facendo, che cosa è andato
    // storto, che cosa mi manca). Le due regole di sopra restano: solo i fatti,
    // e se il fatto non c'è si dice che manca.
    reasoned ? "L'umano ti ha chiesto di ragionare: rispondi alla sua domanda mettendo insieme i FATTI (che cosa stai facendo, che cosa è andato storto, che cosa ti serve) e, se la risposta non è tra i fatti, di' che cosa ti manca per rispondere." : null,
    triggers ? `Non iniziare mai la risposta con ${triggers}: non devi attivare te stesso.` : null,
  ].filter(Boolean).join(' ');
  const parts = [];
  if (facts) parts.push(`FATTI (unica fonte ammessa): ${JSON.stringify(facts)}`);
  if (grounding) parts.push(`Riformula questa risposta senza cambiarne i fatti: ${grounding}`);
  if (from) parts.push(`Mittente: ${from}`);
  parts.push(`Messaggio ricevuto: ${String(message ?? '')}`);
  const turns = (history || [])
    .filter(turn => turn && (turn.role === 'user' || turn.role === 'assistant') && turn.content)
    .slice(-12)
    .map(turn => ({role: turn.role, content: String(turn.content).slice(0, 400)}));
  return [
    {role: 'system', content: system},
    ...turns,
    {role: 'user', content: parts.join('\n')},
  ];
}

// One `/chat/completions` call. Throws on transport/API/empty/self-triggering
// errors with a short `code` so the caller can log *why* it fell back. Returns
// `{text, model, ms, cost, usage}`.
export async function composeChatReply ({
  message, from = null, facts = null, grounding = null, history = [],
  persona = DEFAULT_CHAT_PERSONA, prefixes = [], model, url, key,
  timeoutMs = DEFAULT_CHAT_LLM_TIMEOUT_MS, maxLength = DEFAULT_REPLY_MAX_LENGTH,
  lang = DEFAULT_LANG, reasoned = false, maxTokens = null,
  fetchImpl = fetch,
} = {}) {
  if (!key) {
    const error = new Error('chat LLM key is not configured');
    error.code = 'no_key';
    throw error;
  }
  const messages = buildChatMessages({message, from, facts, grounding, history, persona, prefixes, maxLength, reasoned});
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  const started = Date.now();
  let response;
  try {
    response = await fetchImpl(url ?? DEFAULT_CHAT_LLM_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${key}`},
      body: JSON.stringify({
        model: model ?? DEFAULT_CHAT_LLM_MODEL,
        messages,
        temperature: 0.7,
        max_tokens: maxTokens ?? (reasoned ? DEFAULT_REASON_MAX_TOKENS : DEFAULT_CHAT_MAX_TOKENS),
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const wrapped = new Error(error?.name === 'AbortError' ? `chat LLM timeout after ${timeoutMs} ms` : error.message);
    wrapped.code = error?.name === 'AbortError' ? 'timeout' : 'transport';
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }
  if (response && response.ok === false) {
    const body = await response.text().catch(() => '');
    const error = new Error(`chat LLM HTTP ${response.status}: ${String(body).slice(0, 160)}`);
    error.code = `http_${response.status}`;
    throw error;
  }
  const data = await response.json().catch(() => null);
  const raw = firstLine(data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '');
  const text = clampMessage(raw, maxLength);
  if (!text) {
    const error = new Error('chat LLM returned an empty reply');
    error.code = 'empty';
    throw error;
  }
  if (isSelfTriggering(text, prefixes)) {
    const error = new Error('chat LLM reply would trigger the bot');
    error.code = 'self_trigger';
    throw error;
  }
  return {
    text,
    model: data?.model ?? model ?? DEFAULT_CHAT_LLM_MODEL,
    ms: Date.now() - started,
    cost: data?.usage?.cost ?? null,
    usage: data?.usage ?? null,
  };
}

// Bounded in-memory conversational memory, one short history per sender. Kept
// here (not in the controller) so the limit is testable without a server.
export function createChatMemory ({ maxTurns = DEFAULT_CHAT_HISTORY_TURNS, maxSenders = DEFAULT_CHAT_HISTORY_SENDERS } = {}) {
  const store = new Map();
  const cap = Math.max(1, maxTurns) * 2;
  return {
    history (from) {
      return store.get(String(from ?? '').toLowerCase()) ?? [];
    },
    remember (from, userMessage, assistantMessage) {
      const key = String(from ?? '').toLowerCase();
      if (!key || !assistantMessage) return;
      const turns = store.get(key) ?? [];
      if (userMessage) turns.push({role: 'user', content: String(userMessage)});
      turns.push({role: 'assistant', content: String(assistantMessage)});
      store.set(key, turns.slice(-cap));
      // Oldest sender first: a busy server must not grow this map forever.
      while (store.size > Math.max(1, maxSenders)) store.delete(store.keys().next().value);
    },
    clear () {
      store.clear();
    },
  };
}

function round (value, digits = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? +number.toFixed(digits) : null;
}

function shortPosition (position) {
  if (!position) return null;
  return {x: round(position.x), y: round(position.y), z: round(position.z)};
}

function topInventory (inventory, limit = 8) {
  if (!inventory || typeof inventory !== 'object') return null;
  const rows = Object.entries(inventory)
    .filter(([name, count]) => name && Number(count) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, limit)
    .map(([name, count]) => [name, Number(count)]);
  return rows.length ? Object.fromEntries(rows) : null;
}

// The only facts the model may use. Defensive by design: `observe()` evolves and
// a missing branch must degrade the prompt, never crash the chat loop.
export function compactChatFacts (obs, plan = null, extra = null) {
  if (!obs || typeof obs !== 'object') return null;
  const facts = {};
  if (obs.self) facts.self = {name: obs.self.name ?? obs.self.username ?? null};
  facts.position = shortPosition(obs.position);
  facts.health = round(obs.health);
  facts.food = round(obs.food);
  facts.dimension = obs.dimension ?? null;
  const inventory = topInventory(obs.inventory);
  if (inventory) facts.inventory = inventory;
  if (obs.time) facts.time = {phase: obs.time.phase ?? null, night: !!obs.time.night};
  const effective = plan ?? obs.plan ?? null;
  if (effective) {
    facts.goal = {
      objective: effective.objective ?? null,
      targets: effective.targets && Object.keys(effective.targets).length ? effective.targets : null,
      waypoint: effective.waypoint ?? null,
      follow: effective.follow ?? factFollow(obs) ?? null,
    };
  } else if (factFollow(obs)) {
    facts.goal = {follow: factFollow(obs)};
  }
  if (Array.isArray(obs.humans) && obs.humans.length) {
    facts.players = obs.humans.slice(0, 4).map(h => ({name: h.username ?? h.name ?? null, distance: round(h.distance)}));
  }
  if (Array.isArray(obs.farmAnimals) && obs.farmAnimals.length) {
    facts.animals = obs.farmAnimals.slice(0, 5).map(a => ({type: a.type, distance: round(a.distance), baby: !!a.baby}));
  }
  if (Array.isArray(obs.entities)) {
    const hostiles = obs.entities.filter(e => e?.hostile).slice(0, 4).map(e => ({type: e.type, distance: round(e.distance)}));
    if (hostiles.length) facts.hostiles = hostiles;
  }
  // M11: i fatti che servono a *spiegare* (le ultime azioni e com'è andata, le
  // vene viste) li aggiunge il controller, che li ha in mano.
  if (extra && typeof extra === 'object') {
    for (const [key, value] of Object.entries(extra)) {
      if (value !== null && value !== undefined) facts[key] = value;
    }
  }
  return facts;
}

function factFollow (obs) {
  const name = obs?.follow?.name ?? obs?.plan?.follow ?? null;
  if (!name) return null;
  return {name, distance: round(obs?.follow?.distance), tracked: obs?.follow?.tracked ?? null};
}
