// Chat i18n (M7.2): one message catalogue, five languages, one env switch
// (`CHAT_LANG`). No network, no server: these tests are about the catalogue and
// the deterministic path, which must speak the configured language *without*
// any LLM key.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LANGS, DEFAULT_LANG, LANG_NAMES, LANG_NATIVE_NAMES,
  MESSAGES, isSupportedLang, normalizeLang, chatLangConfig, languageName,
  t, hasMessage, messageKeys, listAnd,
} from '../chat-i18n.mjs';
import {orderAck, orderOutcome, lostNotice, renderReply} from '../human-replies.mjs';
import {
  matchQuestionIntent, looksLikeQuestion, looksLikeSmallTalk,
  planPhrase, choreLabel, needLabel, CHORE_LABELS, NEED_LABELS,
  answerIntent, renderAnswer, renderUnrouted, renderNoArmor,
} from '../human-questions.mjs';
import {renderGreeting, planGreetings} from '../human-greeting.mjs';
import {VILLAGE_CHORES} from '../village-labor.mjs';
import {NEED_PRIORITY} from '../survival/needs.mjs';

const reply = (value = {}) => orderAck({from: 'Ale', plan: {objective: 'prendi 4 terra'}, ...value});

test('the five languages are supported and Italian is the default', () => {
  assert.deepEqual([...LANGS], ['it', 'en', 'fr', 'es', 'de']);
  assert.equal(DEFAULT_LANG, 'it');
  for (const lang of LANGS) assert.equal(isSupportedLang(lang), true, lang);
  assert.equal(isSupportedLang('pt'), false);
});

test('every language defines every key of the default catalogue', () => {
  const keys = messageKeys(DEFAULT_LANG);
  assert.ok(keys.length > 40, `catalogue troppo piccolo: ${keys.length}`);
  for (const lang of LANGS) {
    assert.deepEqual(messageKeys(lang), keys, `chiavi mancanti in "${lang}"`);
    for (const key of keys) {
      const value = MESSAGES[lang][key];
      assert.equal(typeof value, 'string', `${lang}/${key} non e' una stringa`);
      assert.ok(value.trim().length > 0, `${lang}/${key} e' vuota`);
    }
  }
});

test('the placeholders of a message are the same in every language', () => {
  const placeholders = value => [...String(value).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
  for (const key of messageKeys(DEFAULT_LANG)) {
    const expected = placeholders(MESSAGES[DEFAULT_LANG][key]);
    for (const lang of LANGS) {
      assert.deepEqual(placeholders(MESSAGES[lang][key]), expected, `${lang}/${key}`);
    }
  }
});

test('the messages are actually translated, not copied from English', () => {
  for (const key of ['smalltalk', 'greet', 'no_armor', 'fallback.stop', 'fallback.equip', 'fallback.sleep', 'unrouted']) {
    const values = LANGS.map(lang => t(lang, key));
    assert.equal(new Set(values).size, LANGS.length, `"${key}" ripetuto tra le lingue`);
  }
});

test('normalizeLang accepts case and region and falls back on the default', () => {
  assert.equal(normalizeLang('EN'), 'en');
  assert.equal(normalizeLang('en-US'), 'en');
  assert.equal(normalizeLang('  de-DE  '), 'de');
  assert.equal(normalizeLang('pt'), DEFAULT_LANG);
  assert.equal(normalizeLang(null), DEFAULT_LANG);
  assert.equal(normalizeLang(undefined, {fallback: 'en'}), 'en');
  assert.equal(normalizeLang('it', {fallback: 'de'}), 'it');
});

test('CHAT_LANG configures the language, and an unsupported value only warns', () => {
  const off = chatLangConfig({});
  assert.equal(off.lang, DEFAULT_LANG);
  assert.equal(off.requested, null);
  assert.equal(off.configured, false);

  const en = chatLangConfig({CHAT_LANG: 'en'});
  assert.equal(en.lang, 'en');
  assert.equal(en.requested, 'en');
  assert.equal(en.configured, true);
  assert.equal(en.supported, true);

  const typo = chatLangConfig({CHAT_LANG: 'en-UK'});
  assert.equal(typo.lang, 'en');           // regione ignorata: resta valida
  assert.equal(typo.requested, 'en-UK');
  assert.equal(typo.supported, true);
  assert.equal(typo.configured, true);

  const unknown = chatLangConfig({CHAT_LANG: 'pt'});
  assert.equal(unknown.lang, DEFAULT_LANG);
  assert.equal(unknown.requested, 'pt');
  assert.equal(unknown.configured, false);
  assert.equal(unknown.supported, false);

  const custom = chatLangConfig({LINGUA: 'fr'}, {varName: 'LINGUA'});
  assert.equal(custom.varName, 'LINGUA');
  assert.equal(custom.lang, 'fr');
});

test('t returns a template when no vars are given and interpolates when they are', () => {
  assert.equal(t('it', 'ack'), '@{name} ok: {objective}');
  assert.equal(t('it', 'ack', {name: 'Ale', objective: 'vengo'}), '@Ale ok: vengo');
  // Una chiave assente in una lingua ripiega sulla lingua di default, mai su ''.
  assert.equal(t('de', 'chiave.inesistente'), 'chiave.inesistente');
  assert.equal(t('de', 'ack'), MESSAGES.it.ack);
  // Un segnaposto senza valore resta visibile: il bug si vede, non si nasconde.
  assert.equal(t('en', 'ack', {name: 'Ale'}), '@Ale ok: {objective}');
  assert.equal(hasMessage('fr', 'ack'), true);
  assert.equal(hasMessage('fr', 'nope'), false);
  assert.equal(hasMessage('pt', 'ack'), false);
});

test('listAnd uses the conjunction of the language', () => {
  assert.equal(listAnd(['a', 'b'], 'it'), 'a e b');
  assert.equal(listAnd(['a', 'b'], 'en'), 'a and b');
  assert.equal(listAnd(['a', 'b'], 'es'), 'a y b');
  assert.equal(listAnd(['a'], 'de'), 'a');
  for (const lang of LANGS) assert.equal(listAnd([], lang), '');
});

test('languageName is English-facing or native depending on the caller', () => {
  assert.equal(languageName('it'), LANG_NAMES.it);
  assert.equal(languageName('it', {native: true}), LANG_NATIVE_NAMES.it);
  assert.equal(languageName('de', {native: true}), 'Deutsch');
  assert.equal(languageName('xx', {native: true}), LANG_NATIVE_NAMES[DEFAULT_LANG]);
});

test('the deterministic ack and outcome follow CHAT_LANG', () => {
  assert.equal(reply({lang: 'it'}), '@Ale ok: prendi 4 terra');
  assert.match(reply({lang: 'en'}), /^@Ale ok:/);
  assert.match(reply({lang: 'de'}), /^@Ale /);

  const done = lang => orderOutcome({from: 'Ale', status: 'success', objective: 'x', steps: 6, lang});
  const failed = lang => orderOutcome({from: 'Ale', status: 'failed', objective: 'x', steps: 2, lang});
  for (const lang of LANGS) {
    assert.match(done(lang), /^@Ale /, lang);
    assert.match(failed(lang), /^@Ale /, lang);
    if (lang !== 'it') assert.notEqual(done(lang), done('it'), `esito non tradotto in "${lang}"`);
  }
  // Il motivo ha un default per lingua (mai `undefined` in chat).
  assert.notEqual(done('it'), failed('it'));

  const lost = lostNotice({from: 'Ale', prefix: '@bot', lang: 'en'});
  assert.match(lost, /^@Ale /);
  assert.notEqual(lost, lostNotice({from: 'Ale', prefix: '@bot', lang: 'it'}));
});

test('the deterministic refusals follow CHAT_LANG', () => {
  for (const lang of LANGS) {
    const unrouted = renderUnrouted({from: 'Ale', prefixes: ['@bot', '@hermes'], lang});
    assert.match(unrouted, /^@Ale /, lang);
    assert.match(unrouted, /@bot/, `il trigger non compare in "${lang}"`);
    const noArmor = renderNoArmor({from: 'Ale', lang});
    assert.match(noArmor, /^@Ale /, lang);
  }
  assert.notEqual(renderUnrouted({from: 'Ale', lang: 'it'}), renderUnrouted({from: 'Ale', lang: 'fr'}));
  assert.notEqual(renderNoArmor({from: 'Ale', lang: 'it'}), renderNoArmor({from: 'Ale', lang: 'en'}));
  // Con due trigger la congiunzione e' quella della lingua ("o" / "or" / "ou").
  assert.match(renderUnrouted({from: 'Ale', prefixes: ['@bot', '@hermes'], lang: 'it'}), /@bot o @hermes/);
  assert.match(renderUnrouted({from: 'Ale', prefixes: ['@bot', '@hermes'], lang: 'en'}), /@bot or @hermes/);
  assert.match(renderUnrouted({from: 'Ale', prefixes: ['@bot', '@hermes'], lang: 'fr'}), /@bot ou @hermes/);
  assert.match(renderUnrouted({from: 'Ale', prefixes: ['@bot', '@hermes'], lang: 'de'}), /@bot oder @hermes/);
});

test('every village chore and every survival need has a label in every language', () => {
  const choreIds = VILLAGE_CHORES.map(chore => chore.id);
  assert.ok(choreIds.length >= 10, `chore inattese: ${choreIds.length}`);
  for (const id of choreIds) {
    assert.ok(Object.hasOwn(CHORE_LABELS, id), `etichetta italiana mancante per "${id}"`);
    for (const lang of LANGS) {
      const label = choreLabel(id, lang);
      assert.ok(label && label.length > 1, `chore ${id}/${lang}: "${label}"`);
      assert.doesNotMatch(label, /[{}]/, `chore ${id}/${lang} ha un segnaposto`);
    }
  }
  for (const need of Object.keys(NEED_PRIORITY)) {
    assert.ok(Object.hasOwn(NEED_LABELS, need), `etichetta italiana mancante per "${need}"`);
    for (const lang of LANGS) {
      const label = needLabel(need, lang);
      assert.ok(label && label.length > 1, `need ${need}/${lang}: "${label}"`);
      assert.doesNotMatch(label, /[{}]/, `need ${need}/${lang} ha un segnaposto`);
    }
  }
  // Un id sconosciuto non inventa una frase: nessuna etichetta, nessun goal.
  assert.equal(choreLabel('non_esiste', 'it'), null);
  assert.equal(needLabel('non_esiste', 'it'), null);
});

test('planPhrase speaks the configured language for every shape', () => {
  const plan = {chore: 'harvest_crops'};
  assert.match(planPhrase(plan, {lang: 'en'}), /harvest/i);
  assert.equal(planPhrase(plan, {lang: 'it'}), CHORE_LABELS.harvest_crops);
  assert.equal(planPhrase({need: 'eat'}, {lang: 'de'}), t('de', 'need.eat'));
  assert.equal(planPhrase({need: 'eat'}, {lang: 'it'}), NEED_LABELS.eat);
  assert.equal(planPhrase({equip: true}, {lang: 'it'}), t('it', 'phrase.equip'));
  assert.equal(planPhrase({equip: true}, {lang: 'en'}), t('en', 'phrase.equip'));
  assert.equal(planPhrase({recover: true}, {lang: 'fr'}), t('fr', 'phrase.recover'));
  assert.equal(planPhrase({construction: true}, {lang: 'es'}), t('es', 'phrase.construction'));
  assert.equal(planPhrase({notes: 'opportunity:ore'}, {lang: 'it'}), t('it', 'phrase.opportunity'));
  assert.equal(planPhrase({notes: 'curriculum:first_night'}, {lang: 'de'}), t('de', 'phrase.curriculum'));
  assert.equal(planPhrase({objective: 'x'}, {lang: 'it'}), null);
  assert.equal(planPhrase(null), null);
});

test('a question answer is addressed to the sender in the configured language', () => {
  const obs = {position: {x: 1, y: 64, z: 2}, health: 20, food: 20};
  const position = answerIntent('q_position', obs, {lang: 'fr'});
  assert.ok(position);
  const line = renderAnswer({from: 'Ale', answer: position, lang: 'fr'});
  assert.match(line, /^@Ale /);
  assert.equal(renderAnswer({from: 'Ale', answer: position, lang: 'en'}), line.replace(/.*/, renderAnswer({from: 'Ale', answer: position, lang: 'en'})));
});

test('the greeting is localized and still lists every trigger', () => {
  const it = renderGreeting(t('it', 'greet'), {username: 'Ale', prefixes: ['@bot', '@hermes'], lang: 'it'});
  const en = renderGreeting(t('en', 'greet'), {username: 'Ale', prefixes: ['@bot', '@hermes'], lang: 'en'});
  for (const line of [it, en]) {
    assert.match(line, /Ale/);
    assert.match(line, /@bot/);
    assert.match(line, /@hermes/);
    assert.doesNotMatch(line, /[{}]/);
  }
  assert.notEqual(it, en);
  const planned = planGreetings({
    humans: [{username: 'Ale', distance: 3}],
    allowlist: new Set(['ale']),
    prefixes: ['@bot'],
    greeted: new Map(),
    lang: 'de',
  });
  assert.equal(planned.length, 1);
  assert.match(planned[0].message, /^Hallo Ale!/);
});

test('the questions of the five languages reach the right intent without a model', () => {
  const cases = [
    ['dove sei?', 'q_position'], ['where are you?', 'q_position'],
    ['ou es-tu ?', 'q_position'], ['¿dónde estás?', 'q_position'], ['wo bist du?', 'q_position'],
    ['come stai?', 'q_health'], ['comment vas-tu ?', 'q_health'],
    ['¿cómo estás?', 'q_health'], ['wie geht es dir?', 'q_health'],
    ['che fai?', 'q_activity'], ['what are you doing?', 'q_activity'],
    ['que fais-tu ?', 'q_activity'], ['qué haces?', 'q_activity'], ['was machst du?', 'q_activity'],
    ['quanti dirt hai?', 'q_inventory'], ['what do you have?', 'q_inventory'],
    ['qu as tu ?', 'q_inventory'], ['¿qué tienes?', 'q_inventory'], ['was hast du?', 'q_inventory'],
    ['che ore sono?', 'q_time'], ['what time is it?', 'q_time'],
    ['quelle heure est-il ?', 'q_time'], ['¿qué hora es?', 'q_time'], ['wie spät ist es?', 'q_time'],
    ['chi sei?', 'q_identity'], ['who are you?', 'q_identity'],
    ['qui es-tu ?', 'q_identity'], ['¿quién eres?', 'q_identity'], ['wer bist du?', 'q_identity'],
  ];
  for (const [message, id] of cases) {
    assert.equal(matchQuestionIntent(message)?.id, id, message);
    assert.equal(looksLikeQuestion(message), true, message);
  }
});

test('small talk is recognized in every language and never becomes an order', () => {
  // Un saluto non e' una domanda se non comincia con un interrogativo.
  for (const message of ['ciao', 'hi', 'salut', 'bonjour', 'hola', 'gracias', 'hallo', 'danke']) {
    assert.equal(looksLikeSmallTalk(message), true, message);
    assert.equal(looksLikeQuestion(message), false, message);
  }
  // "wie gehts" e' un saluto *e* una domanda di salute: la forma interrogativa
  // vince (risponde con i suoi cuori), ma resta riconosciuto come small talk.
  assert.equal(looksLikeSmallTalk('wie gehts'), true);
  assert.equal(looksLikeQuestion('wie gehts'), true);
  assert.equal(matchQuestionIntent('wie gehts')?.id, 'q_health');
  // Un ordine vero non e' small talk anche se contiene un saluto: il match e'
  // esatto sull'intera frase.
  assert.equal(looksLikeSmallTalk('ciao, vieni qui'), false);
  // Le domande in francese non sono scambiate per ordini senza '?'.
  assert.equal(looksLikeQuestion('ou es tu'), true);
  assert.equal(matchQuestionIntent('ou es tu')?.id, 'q_position');
});

test('a template keeps its placeholders until the renderer fills them', () => {
  // Regressione M7.2: `t()` senza vars ritorna il template, non una frase muta.
  const line = renderReply(t('it', 'ack'), {name: 'Ale', objective: 'vengo'});
  assert.equal(line, '@Ale ok: vengo');
  const greet = renderGreeting(t('en', 'greet'), {username: 'Ale', prefixes: ['@bot']});
  assert.doesNotMatch(greet, /[{}]/);
});
