// Unit test for the natural-chat layer (M7, wiki/human-command.md): config
// gating, the compact facts handed to the model, the bounded conversational
// memory and every failure mode of `composeChatReply`. No network: `fetchImpl`
// is a stub, so the deterministic path stays the one the other tests exercise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chatLlmConfig, chatLlmKey, compactChatFacts, composeChatReply, buildChatMessages, createChatMemory,
  DEFAULT_CHAT_LLM_MODEL, DEFAULT_CHAT_LLM_URL, reasonRequest,
} from '../chat-llm.mjs';
import { looksLikeSmallTalk } from '../human-questions.mjs';

const OBS = {
  self: { username: 'bot_acct', name: 'Hermes' },
  position: { x: 118.42, y: 70.24, z: -180.61 },
  health: 18.5, food: 12.2, dimension: 'overworld',
  inventory: { dirt: 64, iron_ingot: 2, stick: 1, sand: 0 },
  plan: { objective: 'mine 4 dirt', targets: { dirt: 4 }, follow: null },
  time: { phase: 'day', night: false },
  humans: [{ username: 'Ale', distance: 3.21 }],
  farmAnimals: [{ type: 'cow', distance: 6.4, baby: false }],
  entities: [{ type: 'zombie', hostile: true, distance: 9.1 }, { type: 'cow', hostile: false, distance: 6.4 }],
};

function fetchOk (content, extra = {}) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ model: 'stub-model', choices: [{ message: { content } }], usage: { cost: 0.0001 }, ...extra }),
  });
}

// --- configuration gate -----------------------------------------------------

test('no key means the deterministic path', () => {
  assert.equal(chatLlmKey({}), null);
  const config = chatLlmConfig({ env: {} });
  assert.equal(config.enabled, false);
  assert.equal(config.key, null);
  assert.equal(config.model, DEFAULT_CHAT_LLM_MODEL);
  assert.equal(config.url, DEFAULT_CHAT_LLM_URL);
});

test('a DeepSeek key enables the engine; CHAT_LLM=off still disables it', () => {
  assert.equal(chatLlmConfig({ env: { DEEPSEEK_API_KEY: 'sk-x' } }).enabled, true);
  assert.equal(chatLlmConfig({ env: { DEEPSEEK_API_KEY: 'sk-x', CHAT_LLM: 'off' } }).enabled, false);
  assert.equal(chatLlmConfig({ env: { CHAT_LLM: 'on' } }).enabled, false, 'on without a key stays deterministic');
  assert.equal(chatLlmKey({ CHAT_LLM_API_KEY: 'a', DEEPSEEK_API_KEY: 'b' }), 'a', 'CHAT_LLM_API_KEY wins');
});

test('CHAT_LLM_MODEL / CHAT_LLM_URL / CHAT_PERSONA override the defaults', () => {
  const config = chatLlmConfig({ env: { DEEPSEEK_API_KEY: 'k', CHAT_LLM_MODEL: 'deepseek-reasoner', CHAT_LLM_URL: 'http://local/v1/chat/completions', CHAT_PERSONA: 'Jev', CHAT_LLM_TIMEOUT_MS: '1234' } });
  assert.equal(config.model, 'deepseek-reasoner');
  assert.equal(config.url, 'http://local/v1/chat/completions');
  assert.equal(config.persona, 'Jev');
  assert.equal(config.timeoutMs, 1234);
});

// --- facts ------------------------------------------------------------------

test('compactChatFacts keeps the useful numbers and drops the noise', () => {
  const facts = compactChatFacts(OBS);
  assert.equal(facts.self.name, 'Hermes');
  assert.deepEqual(facts.position, { x: 118.4, y: 70.2, z: -180.6 });
  assert.equal(facts.health, 18.5);
  assert.deepEqual(facts.inventory, { dirt: 64, iron_ingot: 2, stick: 1 }, 'zero-count items are dropped');
  assert.deepEqual(facts.players, [{ name: 'Ale', distance: 3.2 }]);
  assert.deepEqual(facts.animals, [{ type: 'cow', distance: 6.4, baby: false }]);
  assert.deepEqual(facts.hostiles, [{ type: 'zombie', distance: 9.1 }], 'only hostiles survive the entity filter');
  assert.equal(facts.goal.objective, 'mine 4 dirt');
});

test('compactChatFacts uses the explicit plan and never throws on a bare observation', () => {
  const facts = compactChatFacts(OBS, { objective: 'ordine umano', targets: { cobblestone: 8 }, follow: 'Ale' });
  assert.equal(facts.goal.objective, 'ordine umano');
  assert.deepEqual(facts.goal.targets, { cobblestone: 8 });
  assert.equal(facts.goal.follow, 'Ale');
  assert.equal(compactChatFacts(null), null);
  assert.deepEqual(compactChatFacts({}), {
    position: null, health: null, food: null, dimension: null,
  });
});

// --- memory -----------------------------------------------------------------

test('createChatMemory keeps a bounded per-sender history', () => {
  const memory = createChatMemory({ maxTurns: 2, maxSenders: 2 });
  memory.remember('Ale', 'primo', 'risposta 1');
  memory.remember('Ale', 'secondo', 'risposta 2');
  memory.remember('Ale', 'terzo', 'risposta 3');
  assert.deepEqual(memory.history('ale').map(t => t.content), ['secondo', 'risposta 2', 'terzo', 'risposta 3']);
  memory.remember('Bob', 'x', 'y');
  memory.remember('Carla', 'x', 'y');
  assert.equal(memory.history('ale').length, 0, 'oldest sender is evicted');
  assert.equal(memory.history('Bob').length, 2);
  memory.clear();
  assert.equal(memory.history('Bob').length, 0);
});

// --- prompt -----------------------------------------------------------------

test('the prompt carries the facts, the grounding and the trigger warning', () => {
  const messages = buildChatMessages({
    message: 'quanti dirt hai?', from: 'Ale', facts: { inventory: { dirt: 64 } },
    grounding: '@Ale ho 64 dirt', history: [{ role: 'assistant', content: 'ciao' }],
    persona: 'Hermes', prefixes: ['@bot', '@hermes'], maxLength: 180,
  });
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /stessa lingua/);
  assert.match(messages[0].content, /"@bot", "@hermes"/);
  assert.equal(messages[1].content, 'ciao');
  const last = messages.at(-1);
  assert.equal(last.role, 'user');
  assert.match(last.content, /"dirt":64/);
  assert.match(last.content, /@Ale ho 64 dirt/);
  assert.match(last.content, /quanti dirt hai\?/);
});

// --- composeChatReply -------------------------------------------------------

test('a good reply is flattened to one line, clamped and returned with its model', async () => {
  const long = `  Ecco:\n\n${'x'.repeat(300)}  `;
  const reply = await composeChatReply({ message: 'ciao', from: 'Ale', key: 'k', fetchImpl: fetchOk(long) });
  assert.equal(reply.model, 'stub-model');
  assert.ok(reply.text.length <= 180);
  assert.ok(!reply.text.includes('\n'));
  assert.ok(reply.text.startsWith('Ecco:'));
  assert.equal(reply.cost, 0.0001);
});

test('composeChatReply refuses a reply that would trigger the bot', async () => {
  await assert.rejects(
    composeChatReply({ message: 'ciao', key: 'k', prefixes: ['@bot'], fetchImpl: fetchOk('@bot ciao') }),
    (error) => error.code === 'self_trigger',
  );
});

test('every failure mode is an error with a code, never a silent empty reply', async () => {
  await assert.rejects(composeChatReply({ message: 'ciao', fetchImpl: fetchOk('ciao') }), error => error.code === 'no_key');
  await assert.rejects(
    composeChatReply({ message: 'ciao', key: 'k', fetchImpl: fetchOk('   \n  ') }),
    error => error.code === 'empty',
  );
  await assert.rejects(
    composeChatReply({ message: 'ciao', key: 'k', fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'boom' }) }),
    error => error.code === 'http_500',
  );
  await assert.rejects(
    composeChatReply({ message: 'ciao', key: 'k', fetchImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); } }),
    error => error.code === 'timeout',
  );
  await assert.rejects(
    composeChatReply({ message: 'ciao', key: 'k', fetchImpl: async () => { throw new Error('dns'); } }),
    error => error.code === 'transport',
  );
});

// --- small talk -------------------------------------------------------------

test('looksLikeSmallTalk matches greetings exactly and never swallows an order', () => {
  for (const text of ['ciao', 'Ciao!', 'come stai?', 'grazie mille', 'hello', 'how are you']) {
    assert.equal(looksLikeSmallTalk(text), true, `${text} is small talk`);
  }
  for (const text of ['grazie prendi la legna', 'ciao seguimi', 'prendi 4 dirt', 'vai a ovest', '']) {
    assert.equal(looksLikeSmallTalk(text), false, `${text} stays an order`);
  }
});

// --- M11: «ragiona» ---------------------------------------------------------

test('reasonRequest finds the marker in the five languages and strips it', () => {
  const cases = [
    ['ragiona: perché non stai minando?', 'perché non stai minando?'],
    ['perché non stai minando? ragiona', 'perché non stai minando?'],
    ['ragiona perché non stai minando', 'perché non stai minando'],
    ['think: why are you not mining?', 'why are you not mining?'],
    ['why are you not mining? think', 'why are you not mining?'],
    ['réfléchis: pourquoi tu ne mines pas ?', 'pourquoi tu ne mines pas ?'],
    ['reflechis pourquoi tu ne mines pas', 'pourquoi tu ne mines pas'],
    ['piensa: ¿por qué no estás minando?', '¿por qué no estás minando?'],
    ['ragiona, perché non stai minando?', 'perché non stai minando?'],
    ['perché non stai minando? ragiona.', 'perché non stai minando?'],
    ['non capisco, ragiona: che cosa ti serve?', 'non capisco, che cosa ti serve?'],
    ['überlege: warum baust du nicht ab?', 'warum baust du nicht ab?'],
    ['uberlege warum baust du nicht ab', 'warum baust du nicht ab'],
    // Il marcatore è una parola: «ragionamento» non lo è.
    ['spiegami il tuo ragionamento', null],
    ['', null],
  ];
  for (const [text, expected] of cases) {
    const out = reasonRequest(text);
    if (expected == null) {
      assert.equal(out.reason, false, `${JSON.stringify(text)} is not a reasoning request`);
      assert.equal(out.message, text, 'a message without the marker is returned untouched');
    } else {
      assert.equal(out.reason, true, `${JSON.stringify(text)} asks for reasoning`);
      assert.equal(out.message, expected, `${JSON.stringify(text)} loses only the marker`);
    }
  }
});

test('reasonRequest accepts an explicit marker list and removes every occurrence', () => {
  const out = reasonRequest('dai su, analizza: analizza il baule', { markers: ['analizza'] });
  assert.equal(out.reason, true);
  assert.equal(out.message, 'dai su, il baule');
  assert.equal(reasonRequest('ragiona: perché?', { markers: ['analizza'] }).reason, false, 'the default markers can be replaced');
});

test('a reasoned request tells the model to answer, and gets more room', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ model: 'stub-model', choices: [{ message: { content: 'sto scavando' } }] }) };
  };
  await composeChatReply({ message: 'perché non stai minando?', from: 'Ale', facts: {position: {x: 1, y: 2, z: 3}}, key: 'k', reasoned: true, fetchImpl });
  const asked = calls.at(-1);
  assert.match(asked.messages[0].content, /ti ha chiesto di ragionare/, 'the system asks for a reasoned answer');
  assert.equal(asked.max_tokens, 220, 'a reasoned answer gets room to explain');
  assert.deepEqual(asked.messages, buildChatMessages({message: 'perché non stai minando?', from: 'Ale', facts: {position: {x: 1, y: 2, z: 3}}, reasoned: true}));

  await composeChatReply({ message: 'perché non stai minando?', from: 'Ale', key: 'k', fetchImpl });
  assert.equal(calls.at(-1).max_tokens, 120, 'a normal answer keeps the short budget');
  assert.equal(/ti ha chiesto di ragionare/.test(calls.at(-1).messages[0].content), false, 'the instruction is only for a reasoned answer');
});

test('compactChatFacts merges the extra facts the controller can explain with', () => {
  const facts = compactChatFacts(OBS, null, {
    recentActions: [{action: 'mine_oak_log', stagnant: true}],
    lastResult: {action: 'mine_oak_log', ok: false, error: 'movement timeout'},
    oresNearby: [{name: 'diamond_ore', position: {x: 4, y: 60, z: 0}, distance: 4.1}],
    nothing: null,
  });
  assert.deepEqual(facts.recentActions, [{action: 'mine_oak_log', stagnant: true}]);
  assert.equal(facts.lastResult.error, 'movement timeout');
  assert.equal(facts.oresNearby[0].name, 'diamond_ore');
  assert.equal('nothing' in facts, false, 'null facts are dropped');
  assert.equal(compactChatFacts(OBS).recentActions, undefined, 'without extra nothing is added');
});
