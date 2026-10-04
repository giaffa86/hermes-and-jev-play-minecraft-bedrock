// Unit test for the chat question router (M6/M6.1): regex first, then System One
// (Jev) over a closed option list — but only for messages that look like a
// question. The decisions endpoint is stubbed, so no network and no key are
// involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyQuestionIntent, resolveQuestionIntent } from '../chat-intent.mjs';
import { QUESTION_INTENTS, intentCriteria, looksLikeQuestion } from '../human-questions.mjs';

const URL = 'http://system-one.test/v1/systemone';
const KEY = 'test-key';

// The choice key for an intent, resolved from the criteria map: the test does
// not hard-code the catalogue order.
function choiceFor (intentId) {
  const criteria = intentCriteria();
  const key = Object.keys(criteria).find(candidate => criteria[candidate].startsWith(`[${intentId}]`));
  assert.ok(key, `nessuna opzione per ${intentId}`);
  return key;
}

function stubFetch (responder) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const call = { url, init, body: JSON.parse(init.body) };
    calls.push(call);
    return responder(call, calls.length);
  };
  return { fetchImpl, calls };
}

const ok = data => ({ ok: true, status: 200, json: async () => data });
const answers = (choice, probabilities, extra = {}) => ok({ model: 'jev-test', usage: { cost: 0.0001 }, answers: { intent: { choice, probabilities, ...extra } } });

test('a message the regex already understands costs no model call', async () => {
  const { fetchImpl, calls } = stubFetch(() => ok({}));
  const decision = await resolveQuestionIntent('HEI DOVE SEI?', { from: 'Ale', fetchImpl, url: URL, key: KEY });
  assert.equal(decision.action, 'answer');
  assert.equal(decision.id, 'q_position');
  assert.equal(decision.via, 'regex');
  assert.equal(calls.length, 0, 'il fast path non chiama System One');
});

test('a free-form question is routed by System One over the closed option list', async () => {
  const { fetchImpl, calls } = stubFetch(() => answers(choiceFor('q_activity'), { [choiceFor('q_activity')]: 0.82 }));
  const decision = await resolveQuestionIntent('che combini?', { from: 'Ale', fetchImpl, url: URL, key: KEY, model: 'jev-test' });
  assert.equal(decision.id, 'q_activity');
  assert.equal(decision.via, 'jev');
  assert.equal(decision.reason, 'ok');
  assert.equal(decision.probability, 0.82);

  assert.equal(calls.length, 1, 'una sola chiamata');
  const { body, init, url } = calls[0];
  assert.equal(url, URL);
  assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(body.model, 'jev-test');
  // `state` viaggia come stringa JSON: il contratto della decisions API.
  const state = JSON.parse(body.state);
  assert.equal(state.message, 'che combini?');
  assert.equal(state.from, 'Ale');
  assert.equal(body.questions.intent.type, 'choice');
  assert.match(body.questions.intent.instructions, /trusted human player/);
  const keys = Object.keys(body.questions.intent.criteria);
  assert.equal(keys.length, QUESTION_INTENTS.length + 1, 'la lista chiusa offre ogni intento pi\u00f9 q_none');
  assert.ok(keys.some(key => body.questions.intent.criteria[key].startsWith('[q_none]')));
});

test('q_none leaves the message to the order path', async () => {
  const { fetchImpl } = stubFetch(() => answers(choiceFor('q_none'), { [choiceFor('q_none')]: 0.9 }));
  const decision = await resolveQuestionIntent('cosa devo fare con le chest?', { fetchImpl, url: URL, key: KEY });
  assert.equal(decision.action, 'order', 'q_none da un modello funzionante è una decisione, non un guasto');
  assert.equal(decision.id, null);
  assert.equal(decision.via, 'jev');
  assert.equal(decision.reason, 'not_a_question');
});

test('a hesitated question never becomes an order (M6.1)', async () => {
  const choice = choiceFor('q_inventory');
  const { fetchImpl } = stubFetch(() => answers(choice, { [choice]: 0.3 }));
  const decision = await resolveQuestionIntent('quanta pietra hai?', { fetchImpl, url: URL, key: KEY, minProbability: 0.4 });
  assert.equal(decision.action, 'unrouted', 'una domanda incerta non muove il bot');
  assert.equal(decision.id, null);
  assert.equal(decision.reason, 'low_probability');
  assert.equal(decision.matched, 'q_inventory', 'la scelta resta nel log anche se rifiutata');
});

test('a message that is not question-shaped never reaches the model (pre-filter)', async () => {
  const { fetchImpl, calls } = stubFetch(() => ok({}));
  for (const message of ['prendi la terra', 'stai qui', 'sei un cretino']) {
    const decision = await resolveQuestionIntent(message, { fetchImpl, url: URL, key: KEY });
    assert.equal(decision.action, 'order', `${message} resta un ordine`);
    assert.equal(decision.via, 'none');
    assert.equal(decision.reason, 'not_question_like');
  }
  assert.equal(calls.length, 0, 'un ordine non paga una chiamata di rete né 4 s di latenza');
});

test('a timeout is reported as unroutable, not as an order', async () => {
  const timeout = async () => {
    const error = new Error('The operation was aborted due to timeout');
    error.name = 'TimeoutError';
    throw error;
  };
  const decision = await resolveQuestionIntent('quanti cuori hai?', { fetchImpl: timeout, url: URL, key: KEY });
  assert.equal(decision.action, 'unrouted');
  assert.equal(decision.reason, 'timeout');
  assert.match(decision.error, /timeout/);
});

test('the threshold accepts a probability equal to it, and 0 accepts the argmax', async () => {
  const choice = choiceFor('q_time');
  const boundary = stubFetch(() => answers(choice, { [choice]: 0.4 }));
  assert.equal((await classifyQuestionIntent('che ora è', { fetchImpl: boundary.fetchImpl, url: URL, key: KEY, minProbability: 0.4 })).intent, 'q_time');
  const any = stubFetch(() => answers(choice, { [choice]: 0.05 }));
  assert.equal((await classifyQuestionIntent('che ora è', { fetchImpl: any.fetchImpl, url: URL, key: KEY, minProbability: 0 })).intent, 'q_time');
});

test('probabilities are read from either answer shape', async () => {
  const choice = choiceFor('q_position');
  const map = stubFetch(() => answers(choice, { [choice]: 0.9 }));
  assert.equal((await classifyQuestionIntent('non ti vedo', { fetchImpl: map.fetchImpl, url: URL, key: KEY })).probability, 0.9);
  // Shape array: le probabilità sono indicizzate come le opzioni.
  const index = +choice.slice(1);
  const array = Array.from({ length: QUESTION_INTENTS.length + 1 }, (_, i) => (i === index ? 0.9 : 0.01));
  const sparse = stubFetch(() => answers(choice, array));
  const decision = await classifyQuestionIntent('non ti vedo', { fetchImpl: sparse.fetchImpl, url: URL, key: KEY });
  assert.equal(decision.intent, 'q_position');
  assert.equal(decision.probability, 0.9);
});

test('an out-of-range choice is not a question', async () => {
  const { fetchImpl } = stubFetch(() => answers('a99', {}));
  const decision = await resolveQuestionIntent('cosa dici?', { fetchImpl, url: URL, key: KEY });
  assert.equal(decision.action, 'order');
  assert.equal(decision.id, null);
  assert.equal(decision.reason, 'not_a_question');
});

test('a broken router reports why, and never turns a question into an order', async () => {
  const failing = stubFetch(() => ({ ok: false, status: 503, json: async () => ({ error: 'upstream down' }) }));
  const broken = await resolveQuestionIntent('che combini?', { fetchImpl: failing.fetchImpl, url: URL, key: KEY });
  assert.equal(broken.action, 'unrouted');
  assert.equal(broken.reason, 'error');
  assert.match(broken.error, /System One HTTP 503/);

  const garbage = stubFetch(() => ({ ok: true, status: 200, json: async () => ({ model: 'x' }) }));
  const unparsable = await resolveQuestionIntent('che combini?', { fetchImpl: garbage.fetchImpl, url: URL, key: KEY });
  assert.equal(unparsable.action, 'unrouted');
  assert.equal(unparsable.reason, 'unparsable');
  assert.match(unparsable.error, /without 'answers'/);

  const throwing = async () => { throw new Error('socket hang up'); };
  const unreachable = await resolveQuestionIntent('che combini?', { fetchImpl: throwing, url: URL, key: KEY });
  assert.equal(unreachable.action, 'unrouted');
  assert.equal(unreachable.reason, 'error');
  assert.match(unreachable.error, /socket hang up/);
});

test('without a key System One is never called, and the router can be disabled', async () => {
  const { fetchImpl, calls } = stubFetch(() => ok({}));
  const disabled = await resolveQuestionIntent('che combini?', { enabled: false, fetchImpl, url: URL, key: KEY });
  assert.equal(disabled.action, 'unrouted');
  assert.equal(disabled.reason, 'disabled');
  assert.equal(calls.length, 0);
  // Nessuna chiave: system-one.mjs solleva, il router lo riporta come `no_key`.
  const previous = { typesafe: process.env.TYPESAFE_API_KEY, openrouter: process.env.OPENROUTER_API_KEY };
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const decision = await resolveQuestionIntent('che combini?', { fetchImpl, url: URL });
    assert.equal(decision.action, 'unrouted');
    assert.equal(decision.reason, 'no_key');
    assert.match(decision.error, /TYPESAFE_API_KEY or OPENROUTER_API_KEY/);
    assert.equal(calls.length, 0, 'senza chiave non si esce in rete');
  } finally {
    if (previous.typesafe != null) process.env.TYPESAFE_API_KEY = previous.typesafe;
    if (previous.openrouter != null) process.env.OPENROUTER_API_KEY = previous.openrouter;
  }
});
