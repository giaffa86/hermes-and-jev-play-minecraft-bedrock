// Unit test for the deterministic chat answers (M6, wiki/human-command.md):
// the intent catalogue, the regex fast path and the rendering from harness
// facts. No model, no network, no server — the router that *chooses* an intent
// lives in chat-intent.mjs and is tested separately.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_INTENT, QUESTION_INTENTS, answerIntent, clockFromTicks, intentCriteria, intentFromChoice,
  matchQuestionIntent, normalizeForMatching, renderAnswer,
} from '../human-questions.mjs';
import { isSelfTriggering } from '../human-replies.mjs';

const OBS = {
  position: { x: 118.4, y: 70.2, z: -180.6 },
  dimension: 'overworld',
  health: 20,
  food: 12,
  inventory: { dirt: 64, iron_ingot: 2, stick: 1 },
  plan: { objective: 'mine 4 dirt' },
  time: { ticks: 6000, night: false, phase: 'day' },
};

test('the catalogue is well formed: unique ids, a description and an answer each', () => {
  const ids = QUESTION_INTENTS.map(intent => intent.id);
  assert.equal(new Set(ids).size, ids.length, 'gli id degli intenti sono unici');
  for (const intent of QUESTION_INTENTS) {
    assert.match(intent.id, /^q_[a-z]+$/, `${intent.id} è un id di intento`);
    assert.ok(intent.description.length > 20, `${intent.id} ha una descrizione per il modello`);
    assert.equal(typeof intent.answer, 'function', `${intent.id} ha una funzione di risposta`);
    assert.ok(Array.isArray(intent.patterns) && intent.patterns.length, `${intent.id} ha una regex`);
  }
});

test('the fast path recognises the phrasings the family actually uses', () => {
  const cases = [
    ['dove sei?', 'q_position'],
    ['HEI DOVE SEI?', 'q_position'],
    ['hei, dove sei??', 'q_position'],
    ['non ti vedo', 'q_position'],
    ['where are you', 'q_position'],
    ['come stai?', 'q_health'],
    ['hai fame', 'q_health'],
    ['che fai?', 'q_activity'],
    ['che fai, non ti muovi?', 'q_activity'],
    ['what are you doing', 'q_activity'],
    ['cosa hai?', 'q_inventory'],
    ['inventario', 'q_inventory'],
    ['che ore sono?', 'q_time'],
    ['chi sei', 'q_identity'],
    ['aiuto', 'q_identity'],
  ];
  for (const [message, expected] of cases) {
    assert.equal(matchQuestionIntent(message)?.id, expected, `"${message}" → ${expected}`);
  }
});

test('an order is never swallowed by the fast path', () => {
  const orders = [
    'prendi la terra',
    'seguimi',
    'vieni qui',
    'svuota le chest',
    'mina 4 dirt',
    'cosa hai fatto ieri',
    'aiutami con gli zombie',
    'fermati',
    'porta la pietra alla base',
  ];
  for (const message of orders) {
    assert.equal(matchQuestionIntent(message), null, `"${message}" resta un ordine`);
  }
});

test('normalisation makes case and punctuation irrelevant', () => {
  assert.equal(normalizeForMatching('  HEI, DOVE   SEI?! '), 'hei dove sei');
  assert.equal(matchQuestionIntent('DOVE SEI?')?.id, 'q_position');
});

test('answers come from the observation, one fact per intent', () => {
  assert.equal(answerIntent('q_position', OBS), 'sono a x 118, y 70, z -181 (overworld)');
  assert.equal(answerIntent('q_health', OBS), 'ho 20/20 di vita e 12/20 di cibo');
  assert.equal(answerIntent('q_activity', OBS), 'sto facendo: mine 4 dirt');
  assert.equal(answerIntent('q_inventory', OBS), 'ho: dirt x64, iron_ingot x2, stick');
  assert.equal(answerIntent('q_time', OBS), 'sono le 12:00 (giorno)');
  assert.match(answerIntent('q_identity', OBS), /sono Hermes, il bot di casa\. Scrivimi "@bot <ordine>"/);
});

test('a missing fact is admitted, never invented', () => {
  assert.match(answerIntent('q_position', {}), /^non lo so/);
  assert.match(answerIntent('q_health', {}), /^non lo so/);
  assert.equal(answerIntent('q_activity', {}), 'non ho un obiettivo: sono in attesa di ordini');
  assert.equal(answerIntent('q_inventory', {}), 'non ho niente in inventario');
  assert.match(answerIntent('q_time', {}), /^non lo so/);
  assert.equal(answerIntent('q_health', { dead: true }), 'sono morto, sto rinascendo');
});

test('the identity answer lists every configured trigger', () => {
  const answer = answerIntent('q_identity', {}, { prefixes: ['@bot', '@hermes'] });
  assert.match(answer, /"@bot o @hermes <ordine>"/);
  assert.match(answer, /"@bot o @hermes seguimi"/);
});

test('an unknown intent and the q_none sentinel have no answer', () => {
  assert.equal(answerIntent('q_whatever', OBS), null);
  assert.equal(answerIntent(NO_INTENT, OBS), null);
  assert.equal(answerIntent(undefined, OBS), null);
});

test('a very long objective is clamped to the chat line limit', () => {
  const answer = answerIntent('q_activity', { plan: { objective: 'x'.repeat(400) } }, { maxLength: 60 });
  assert.equal(answer.length, 60);
  assert.match(answer, /…$/);
});

test('the option list offered to Jev is closed and ends with q_none', () => {
  const criteria = intentCriteria();
  const keys = Object.keys(criteria);
  assert.deepEqual(keys, ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
  for (const intent of QUESTION_INTENTS) {
    assert.ok(keys.some(key => criteria[key].includes(`[${intent.id}]`)), `${intent.id} è offerto al modello`);
  }
  assert.match(criteria.a6, new RegExp(`^\\[${NO_INTENT}\\]`), 'q_none è l\'ultima opzione');
});

test('the model choice maps back to a catalogue id, q_none included', () => {
  const ids = QUESTION_INTENTS.map(intent => intent.id);
  assert.equal(intentFromChoice('a0'), ids[0]);
  assert.equal(intentFromChoice('a3'), ids[3]);
  assert.equal(intentFromChoice(`a${ids.length}`), null, 'q_none non è un intento');
  assert.equal(intentFromChoice('a99'), null, 'fuori intervallo non è un intento');
  assert.equal(intentFromChoice(undefined), null);
  assert.equal(intentFromChoice('bogus'), null);
});

test('clockFromTicks follows the Bedrock day (tick 0 = 06:00)', () => {
  assert.equal(clockFromTicks(0), '06:00');
  assert.equal(clockFromTicks(6000), '12:00');
  assert.equal(clockFromTicks(12000), '18:00');
  assert.equal(clockFromTicks(18000), '00:00');
  assert.equal(clockFromTicks(24000), '06:00', 'il giorno si ripete');
  assert.equal(clockFromTicks('nonsense'), null);
});

test('a reply is addressed to the sender and never looks like an order to the bot', () => {
  assert.equal(renderAnswer({ from: 'Ale', answer: 'sono a x 0, z 0' }), '@Ale sono a x 0, z 0');
  const answer = answerIntent('q_position', OBS);
  // Il mittente pu\u00f2 chiamarsi come un trigger: \u00e8 il guardiano di `replyChat`
  // (`isSelfTriggering`) a rifiutare la riga, non questo modulo.
  assert.equal(isSelfTriggering(renderAnswer({ from: 'bot', answer }), '@bot'), true);
  assert.equal(isSelfTriggering(renderAnswer({ from: 'Ale', answer }), '@bot'), false);
});
