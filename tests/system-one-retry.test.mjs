// Unit test della politica di retry di System One: un guasto *transitorio* del
// provider (il `529 system_overloaded` che il 07/10/2026 uccideva il run a ogni
// decisione) deve costare qualche secondo, non l'agente. Il trasporto è stub —
// niente rete, niente chiave — e l'orologio è finto: l'attesa fa parte del
// contratto, quindi va misurata senza aspettarla davvero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRANSIENT_STATUS, systemOneDecide, systemOneDecideWithRetry, systemOneRetryDelay, systemOneRetryPolicy,
} from '../system-one.mjs';

const URL = 'http://system-one.test/v1/systemone';
const KEY = 'test-key';
const QUESTION = { action: { type: 'choice', instructions: ['pick'], criteria: { a0: 'uno', a1: 'due' } } };
const ANSWER = { action: { choice: 'a0', probabilities: { a0: 0.7 } } };

function stubFetch (responder) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return responder(calls.length, init);
  };
  return { fetchImpl, calls };
}

const ok = (answers = ANSWER) => ({ ok: true, status: 200, json: async () => ({ model: 'jev-test', answers }) });
const fail = (status, detail = { error_type: 'system_overloaded' }) => ({ ok: false, status, json: async () => ({ detail }) });

// Orologio finto condiviso da `now` e `sleepImpl`: il tempo passa solo quando
// il codice decide di aspettare, e i millisecondi chiesti restano ispezionabili.
function fakeClock () {
  let clock = 0;
  const sleeps = [];
  return {
    sleeps,
    now: () => clock,
    sleepImpl: async (ms) => { sleeps.push(ms); clock += ms; },
    advance: (ms) => { clock += ms; },
  };
}

const decide = (fetchImpl, { policy = {}, ...options } = {}) => systemOneDecideWithRetry({
  url: URL, key: KEY, state: { message: 'ciao' }, questions: QUESTION, fetchImpl, retry: { jitterMs: 0, ...policy }, ...options,
});

test('un 529 poi un 200: due tentativi, e la decisione arriva', async () => {
  const { fetchImpl, calls } = stubFetch(n => (n === 1 ? fail(529) : ok()));
  const clock = fakeClock();
  const result = await decide(fetchImpl, { policy: { baseMs: 1000 }, ...clock });
  assert.equal(calls.length, 2, 'il 529 è stato ritentato una volta');
  assert.equal(result.answers.action.choice, 'a0');
  assert.equal(result.attempts, 2);
  assert.equal(result.retries, 1);
  assert.equal(result.ms, 1000, 'ms è il tempo totale della chiamata, attesa inclusa');
  assert.deepEqual(clock.sleeps, [1000], 'primo backoff = baseMs');
});

test('un errore di rete è transitorio: `fetch failed` si ritenta', async () => {
  const { fetchImpl, calls } = stubFetch(n => {
    if (n === 1) throw new TypeError('fetch failed');
    return ok();
  });
  const clock = fakeClock();
  const result = await decide(fetchImpl, { policy: { baseMs: 10 }, ...clock });
  assert.equal(calls.length, 2);
  assert.equal(result.retries, 1);
});

test('una risposta definitiva non si ritenta (400, 200-con-errore, 200-senza-answers)', async () => {
  const bad400 = stubFetch(() => fail(400, { error_type: 'api_usage_error', message: 'Unknown model: jev' }));
  await assert.rejects(
    () => decide(bad400.fetchImpl, { policy: { baseMs: 10 }, ...fakeClock() }),
    error => {
      assert.equal(error.code, 'http');
      assert.equal(error.status, 400);
      assert.equal(error.attempts, 1, 'un 400 non è transitorio');
      assert.equal(error.retries, 0);
      assert.match(error.message, /System One HTTP 400/);
      return true;
    },
  );
  assert.equal(bad400.calls.length, 1);

  const apiError = stubFetch(() => ({ ok: true, status: 200, json: async () => ({ error: { message: 'overloaded' } }) }));
  await assert.rejects(() => decide(apiError.fetchImpl, { policy: { baseMs: 10 }, ...fakeClock() }), /System One error/);
  assert.equal(apiError.calls.length, 1, 'una decisione presa (con errore) non si ripete');

  const unparsable = stubFetch(() => ok(null));
  await assert.rejects(() => decide(unparsable.fetchImpl, { policy: { baseMs: 10 }, ...fakeClock() }), /without 'answers'/);
  assert.equal(unparsable.calls.length, 1);
});

test('si arrende dopo la politica e conserva l\'ultimo errore, con i suoi conti', async () => {
  const { fetchImpl, calls } = stubFetch(() => fail(529));
  const clock = fakeClock();
  await assert.rejects(
    () => decide(fetchImpl, { policy: { retries: 2, baseMs: 100, maxMs: 1000 }, ...clock }),
    error => {
      assert.equal(error.code, 'http');
      assert.equal(error.status, 529);
      assert.equal(error.attempts, 3);
      assert.equal(error.retries, 2);
      assert.equal(error.elapsedMs, 300);
      assert.match(error.message, /System One HTTP 529/);
      assert.match(error.message, /system_overloaded/, 'il messaggio del provider resta leggibile');
      return true;
    },
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(clock.sleeps, [100, 200], 'backoff esponenziale');
});

test('il backoff cresce e si ferma al tetto', async () => {
  const { fetchImpl, calls } = stubFetch(() => fail(503));
  const clock = fakeClock();
  await assert.rejects(() => decide(fetchImpl, { policy: { retries: 4, baseMs: 100, maxMs: 300 }, ...clock }));
  assert.equal(calls.length, 5);
  assert.deepEqual(clock.sleeps, [100, 200, 300, 300]);
});

test('con retries a 0 il retry è spento: un solo tentativo', async () => {
  const { fetchImpl, calls } = stubFetch(() => fail(529));
  await assert.rejects(() => decide(fetchImpl, { policy: { retries: 0 } }), /System One HTTP 529/);
  assert.equal(calls.length, 1, 'interruttore di sicurezza: politica disattivabile');
});

test('`timeoutMs` è il budget totale: ogni tentativo riceve solo il tempo che resta', async () => {
  const { fetchImpl, calls } = stubFetch(() => fail(529));
  const clock = fakeClock();
  // Il primo tentativo si mangia 400 ms del budget da 1500 ms: il retry parte
  // (1000 < 1500), poi il secondo backoff (2000) non ci sta più e la chiamata
  // si arrende invece di sforare.
  const firstFails = async (n, init) => fail(529);
  const fetchImpl2 = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) clock.advance(400);
    return firstFails(calls.length, init);
  };
  await assert.rejects(
    () => systemOneDecideWithRetry({
      url: URL, key: KEY, state: {}, questions: QUESTION, fetchImpl: fetchImpl2,
      timeoutMs: 1500, retry: { retries: 4, baseMs: 1000, maxMs: 8000, jitterMs: 0 }, ...clock,
    }),
    error => { assert.equal(error.attempts, 2); assert.equal(error.retries, 1); return true; },
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(clock.sleeps, [1000]);
  assert.ok(calls.every(call => call.init.signal), 'ogni tentativo ha il suo AbortSignal');

  // Con budget piccolo il primo tentativo lo consuma tutto: nessun retry, come
  // si comportava il codice prima della politica.
  const tight = stubFetch(() => fail(529));
  const tightClock = fakeClock();
  await assert.rejects(
    () => systemOneDecideWithRetry({
      url: URL, key: KEY, state: {}, questions: QUESTION, fetchImpl: tight.fetchImpl,
      timeoutMs: 500, retry: { retries: 4, baseMs: 1000, jitterMs: 0 }, ...tightClock,
    }),
    error => { assert.equal(error.attempts, 1); assert.equal(error.retries, 0); return true; },
  );
  assert.deepEqual(tightClock.sleeps, [], 'un retry che sforerebbe il budget non parte');
});

test('senza `timeoutMs` la selezione delle azioni resta senza scadenza propria', async () => {
  const { fetchImpl, calls } = stubFetch(() => ok());
  const result = await systemOneDecideWithRetry({ url: URL, key: KEY, state: {}, questions: QUESTION, fetchImpl, ...fakeClock() });
  assert.equal(result.attempts, undefined, 'un solo tentativo: nessun campo in più');
  assert.equal(calls[0].init.signal, undefined, 'nessun AbortSignal quando non c\'è un budget');
});

test('il trasporto resta a un tentativo: `systemOneDecide` non ritenta per conto suo', async () => {
  const { fetchImpl, calls } = stubFetch(() => fail(529));
  await assert.rejects(() => systemOneDecide({ url: URL, key: KEY, state: {}, questions: QUESTION, fetchImpl }), /System One HTTP 529/);
  assert.equal(calls.length, 1);
});

test('la politica legge l\'ambiente, e un valore assurdo torna al default', () => {
  const previous = {
    retries: process.env.SYSTEM_ONE_RETRY_ATTEMPTS,
    base: process.env.SYSTEM_ONE_RETRY_BASE_MS,
    jitter: process.env.SYSTEM_ONE_RETRY_JITTER_MS,
  };
  try {
    process.env.SYSTEM_ONE_RETRY_ATTEMPTS = '2';
    process.env.SYSTEM_ONE_RETRY_BASE_MS = '250';
    process.env.SYSTEM_ONE_RETRY_JITTER_MS = '0';
    assert.deepEqual(systemOneRetryPolicy(), { retries: 2, baseMs: 250, maxMs: 8000, jitterMs: 0 });
    process.env.SYSTEM_ONE_RETRY_ATTEMPTS = 'molti';
    process.env.SYSTEM_ONE_RETRY_BASE_MS = '-5';
    assert.deepEqual(systemOneRetryPolicy().retries, 4);
    assert.deepEqual(systemOneRetryPolicy().baseMs, 1000);
  } finally {
    const restore = (name, value) => (value === undefined ? delete process.env[name] : (process.env[name] = value));
    restore('SYSTEM_ONE_RETRY_ATTEMPTS', previous.retries);
    restore('SYSTEM_ONE_RETRY_BASE_MS', previous.base);
    restore('SYSTEM_ONE_RETRY_JITTER_MS', previous.jitter);
  }
});

test('l\'attesa è esponenziale, tagliata, con jitter pieno', () => {
  const policy = { retries: 4, baseMs: 100, maxMs: 300, jitterMs: 250 };
  assert.equal(systemOneRetryDelay(policy, 0, () => 0), 100);
  assert.equal(systemOneRetryDelay(policy, 3, () => 0), 300);
  assert.equal(systemOneRetryDelay(policy, 0, () => 0.5), 225);
  assert.ok(TRANSIENT_STATUS.has(529) && TRANSIENT_STATUS.has(504) && !TRANSIENT_STATUS.has(401));
});
