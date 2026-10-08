// R2 — la porta della chiarificazione (`human-clarify.mjs`). Vedi
// `docs/raw/ROADMAP_refactoring_reasoning.md` (R2) e `docs/wiki/human-command.md`.
//
// La porta risponde a una domanda sola: «questo ordine è eseguibile così com'è?».
// Se non lo è — manca la meta, e nessuno può risolverla — il bot **chiede** la
// cosa che solo l'umano può decidere, invece di indovinare. Il valore di questo
// file è soprattutto nei casi negativi: ogni riga «non chiede» è una domanda
// stupida che il bot non farà a un giocatore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  orderGaps, mergeClarifyAnswer, restatesOrder, planHasDestination, planIsOtherOrder,
  renderClarifyRefusal, CLARIFY_READY, CLARIFY_NEEDS_INPUT, CLARIFY_FIELD, CLARIFY_REASON,
} from '../human-clarify.mjs';
import { t, LANGS } from '../chat-i18n.mjs';

const OBS = { inventory: { dirt: 3, bread: 2 }, drops: [{ item: 'wheat' }] };

// La memoria è una porta iniettata: qui un finto che conosce i nomi passati.
const memoryOf = (...names) => ({ places: async () => ({ places: names.map(name => ({ name })) }) });
const BROKEN = { places: async () => { throw new Error('connection refused'); } };
const ERRORED = { places: async () => ({ error: 'memory_unavailable' }) };

const gap = (text, plan = {}, { memory = null, obs = OBS } = {}) => orderGaps(text, plan, obs, { memory, lang: 'it' });

test('un ordine di movimento senza meta chiede la meta, con la domanda del catalogo', async () => {
  for (const text of ['vai', 'andiamo', 'muoviti', 'vai al', 'guidami fino a']) {
    const out = await gap(text);
    assert.equal(out.status, CLARIFY_NEEDS_INPUT, `«${text}» chiede`);
    assert.deepEqual(out.missing, [{ field: CLARIFY_FIELD.DESTINATION, reason: CLARIFY_REASON.NO_DESTINATION }]);
    assert.equal(out.question, t('it', 'clarify_destination'));
  }
});

test('un posto che il bot non conosce chiede dove sia, e la domanda nomina il posto', async () => {
  const out = await gap('vai al villaggio', {}, { memory: memoryOf() });
  assert.equal(out.status, CLARIFY_NEEDS_INPUT);
  assert.equal(out.missing[0].field, CLARIFY_FIELD.PLACE);
  assert.equal(out.missing[0].reason, CLARIFY_REASON.UNKNOWN_PLACE);
  assert.equal(out.missing[0].name, 'villaggio');
  assert.equal(out.question, t('it', 'clarify_unknown_place', { name: 'villaggio' }));
  assert.match(out.question, /villaggio/);
});

test('un posto che la memoria conosce non si chiede', async () => {
  assert.equal((await gap('vai al rifugio', {}, { memory: memoryOf('rifugio') })).status, CLARIFY_READY);
  assert.equal((await gap('vai al rifugio', {}, { memory: memoryOf('rifugio', 'casa') })).status, CLARIFY_READY);
});

test('una memoria rotta non trasforma ogni ordine in un interrogatorio (fail-open)', async () => {
  for (const memory of [BROKEN, ERRORED, null, {}, { places: 'non è una funzione' }]) {
    assert.equal((await gap('vai al villaggio', {}, { memory })).status, CLARIFY_READY, `${JSON.stringify(Object.keys(memory ?? {}))} non chiede`);
  }
});

test('«portami del cibo», «prendi della legna», «vai a prendere la spada» sono oggetti, non posti', async () => {
  const memory = memoryOf();
  for (const text of [
    'portami del cibo', 'portami della legna', 'dammi un po di pane', 'bring me some food',
    'apporte-moi du pain', 'portami la spada', 'vai a prendere la spada',
  ]) {
    assert.equal((await gap(text, {}, { memory })).status, CLARIFY_READY, `«${text}» non chiede`);
  }
});

test('un verbo di attività non è un posto («vai a dormire», «vai a minare il ferro»)', async () => {
  const memory = memoryOf();
  for (const text of ['vai a dormire', 'vai a minare il ferro', 'vai a raccogliere', 'come on, go to sleep']) {
    assert.equal((await gap(text, {}, { memory })).status, CLARIFY_READY, `«${text}» non chiede`);
  }
});

test('la meta è il mittente: follow, «qui», «vieni da me» e le coordinate non si chiedono', async () => {
  for (const text of [
    'seguimi', 'vieni da me', 'resta qui', 'vieni qui', 'follow me', 'come here',
    'vai a coordinate 120 64 -230', 'vai a 120 64 -230', 'vai qui',
  ]) {
    assert.equal((await gap(text)).status, CLARIFY_READY, `«${text}» non chiede`);
  }
});

test('un piano che ha già una meta non si chiede (waypoint o escort)', async () => {
  assert.equal((await gap('vai', { waypoint: { x: 12, z: -4 } })).status, CLARIFY_READY);
  assert.equal((await gap('guidami', { escort: { to: { x: 12, z: -4 } } })).status, CLARIFY_READY);
  // `follow` da solo **non** è una meta: è il nome di una persona, e il fallback
  // del planner lo mette anche quando non ha capito niente.
  assert.equal((await gap('vai', { follow: 'Ale' })).status, CLARIFY_NEEDS_INPUT);
  assert.equal(planHasDestination({ follow: 'Ale' }), false);
  assert.equal(planHasDestination({ waypoint: { x: 0, z: 0 } }), true);
  assert.equal(planHasDestination({ waypoint: { x: 0 } }), false, 'mezzo waypoint non è una meta');
  assert.equal(planHasDestination(null), false);
});

test('un ordine che non è un movimento non passa dalla porta', async () => {
  const plan = { targets: { oak_log: 4 } };
  assert.equal(planIsOtherOrder(plan), true);
  for (const key of ['construction', 'collect', 'farm', 'drop', 'equip', 'need', 'escort']) {
    assert.equal(planIsOtherOrder({ [key]: {} }), true, `${key} è un altro ordine`);
  }
  assert.equal(planIsOtherOrder({ targets: {} }), false, 'targets vuoti non contano');
  assert.equal((await gap('coltiva le carote', { farm: { crop: 'carrots' } })).status, CLARIFY_READY);
  assert.equal((await gap('ehi, scavami una stanza', { construction: { type: 'room' } })).status, CLARIFY_READY);
  // Nessun verbo di meta: la porta non si apre mai, qualunque cosa dica il testo.
  for (const text of ['ciao', 'ciao, come stai', 'cosa stai facendo?', 'raccogli il grano e rimpiantalo']) {
    assert.equal((await gap(text)).status, CLARIFY_READY, `«${text}» non è un ordine di movimento`);
  }
});

test('un discorso lungo non è una frase-ordine: la porta non si apre', async () => {
  const long = `vai ${'molto '.repeat(60)}lontano`;
  assert.ok(long.length > 240);
  assert.equal((await gap(long)).status, CLARIFY_READY);
});

test('mergeClarifyAnswer unisce ordine e risposta, senza duplicare la stessa frase', () => {
  assert.equal(mergeClarifyAnswer('vai al rifugio', 'coordinate 120 64 -230'), 'vai al rifugio coordinate 120 64 -230');
  assert.equal(mergeClarifyAnswer('vai al rifugio', ''), 'vai al rifugio');
  assert.equal(mergeClarifyAnswer('', 'vai al rifugio'), 'vai al rifugio');
  assert.equal(mergeClarifyAnswer('vai', 'vai'), 'vai');
  assert.equal(mergeClarifyAnswer(null, '  vai  '), 'vai');
});

test('restatesOrder distingue una risposta che completa da una che sostituisce', () => {
  assert.equal(restatesOrder('coordinate 120 64 -230'), false, 'le coordinate da sole completano');
  assert.equal(restatesOrder('il rifugio è a coordinate 120 64 -230'), false);
  assert.equal(restatesOrder('vai al mulino'), true, 'un nuovo movimento sostituisce');
  assert.equal(restatesOrder('portami al mulino'), true);
  assert.equal(restatesOrder('vieni da me'), true, 'follow: la meta è il mittente');
  assert.equal(restatesOrder('seguimi'), true);
  assert.equal(restatesOrder(''), false);
});

test('le domande e il rifiuto vengono dai cataloghi, senza segnaposto residui', () => {
  for (const lang of LANGS) {
    for (const [key, vars] of [['clarify_destination', {}], ['clarify_unknown_place', { name: 'X' }], ['clarify_refusal', {}]]) {
      const text = t(lang, key, vars);
      assert.ok(text && text !== key, `${lang}.${key} esiste`);
      assert.equal(text.includes('{'), false, `${lang}.${key} non lascia segnaposto: ${text}`);
      assert.equal(text.includes('undefined'), false, `${lang}.${key} non ha buchi`);
    }
  }
  assert.equal(renderClarifyRefusal({ lang: 'it' }), t('it', 'clarify_refusal'));
});
