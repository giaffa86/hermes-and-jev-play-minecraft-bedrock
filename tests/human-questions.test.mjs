// Unit test for the deterministic chat answers (M6, wiki/human-command.md):
// the intent catalogue, the regex fast path and the rendering from harness
// facts. No model, no network, no server — the router that *chooses* an intent
// lives in chat-intent.mjs and is tested separately.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHORE_LABELS, NEED_LABELS, NO_INTENT, QUESTION_INTENTS, answerIntent, clockFromTicks, intentCriteria,
  intentFromChoice, looksLikeQuestion, matchQuestionIntent, normalizeForMatching, planPhrase, renderAnswer,
  renderNoArmor, renderUnrouted,
} from '../human-questions.mjs';
import { isSelfTriggering } from '../human-replies.mjs';
import { VILLAGE_CHORES } from '../village-labor.mjs';
import { NEED_PRIORITY } from '../survival/needs.mjs';

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
    ['quanta vita hai?', 'q_health'],
    ['quanti cuori hai?', 'q_health'],
    ['quanta fame hai?', 'q_health'],
    ['che armatura hai?', 'q_armor'],
    ['cosa indossi?', 'q_armor'],
    ['che fai?', 'q_activity'],
    ['che fai, non ti muovi?', 'q_activity'],
    ['what are you doing', 'q_activity'],
    ['cosa hai?', 'q_inventory'],
    ['hai una spada?', 'q_inventory'],
    ['quanta terra hai?', 'q_inventory'],
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
    'equipaggiati con l\'elmetto',
    'equipaggiati con armatura in bronzo',
    'mettiti l\'armatura',
    'wear your helmet',
    'mettiti a lavorare',
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
  assert.equal(answerIntent('q_health', OBS), 'ho 10 cuori (20/20 di vita) e 12/20 di cibo');
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
  assert.match(answerIntent('q_armor', {}), /^non lo so/);
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
  assert.deepEqual(keys, ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']);
  for (const intent of QUESTION_INTENTS) {
    assert.ok(keys.some(key => criteria[key].includes(`[${intent.id}]`)), `${intent.id} è offerto al modello`);
  }
  assert.match(criteria.a7, new RegExp(`^\\[${NO_INTENT}\\]`), 'q_none è l\'ultima opzione');
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
  // Il mittente può chiamarsi come un trigger: è il guardiano di `replyChat`
  // (`isSelfTriggering`) a rifiutare la riga, non questo modulo.
  assert.equal(isSelfTriggering(renderAnswer({ from: 'bot', answer }), '@bot'), true);
  assert.equal(isSelfTriggering(renderAnswer({ from: 'Ale', answer }), '@bot'), false);
});

// Il router risponde "sì/no" sull'oggetto nominato invece di scaricare la lista
// intera: la domanda della famiglia è "hai una spada?", non "cosa hai?".
test('a question that names an item is answered about that item', () => {
  const obs = { inventory: { wooden_sword: 1, dirt: 64, iron_helmet: 1, iron_boots: 2, bread: 3 } };
  assert.equal(answerIntent('q_inventory', obs, { message: 'hai una spada?' }), 'sì: wooden_sword');
  assert.equal(answerIntent('q_inventory', obs, { message: 'hai un elmo?' }), 'sì: iron_helmet');
  assert.equal(answerIntent('q_inventory', obs, { message: 'quanta terra hai?' }), 'sì: dirt x64');
  assert.equal(answerIntent('q_inventory', obs, { message: 'hai del diamante?' }), 'no, non ne ho');
  // Nessun oggetto nominato (o oggetto fuori catalogo): resta la lista, ordinata
  // per quantità e limitata.
  assert.equal(answerIntent('q_inventory', obs), 'ho: dirt x64, bread x3, iron_boots x2, wooden_sword (+1 altri)');
  assert.equal(answerIntent('q_inventory', obs, { message: 'cosa hai?' }), 'ho: dirt x64, bread x3, iron_boots x2, wooden_sword (+1 altri)');
});

// Il materiale fa parte della domanda: "una spada di rame" non è "una spada".
// Il bronzo non esiste in vanilla (nessun item `bronze_*`, nessuna ricetta), e
// dal Copper Age il tier fra pietra e ferro è il rame: "bronzo" si legge come rame.
test('a question with a material is answered about that material', () => {
  const obs = { inventory: { wooden_sword: 1, copper_sword: 1, copper_pickaxe: 2, raw_copper: 3, iron_ingot: 1 } };
  assert.equal(answerIntent('q_inventory', obs, { message: 'hai una spada di rame?' }), 'sì: copper_sword');
  assert.equal(answerIntent('q_inventory', obs, { message: 'hai una spada di bronzo?' }), 'sì: copper_sword');
  assert.equal(answerIntent('q_inventory', obs, { message: 'hai un piccone di rame?' }), 'sì: copper_pickaxe x2');
  // Il materiale mancante non è un "no" secco: si dice cosa c'è dello stesso tipo.
  assert.equal(answerIntent('q_inventory', obs, { message: 'hai una spada di diamante?' }), 'no, non ne ho; ho: wooden_sword, copper_sword');
  // "rame" da solo resta la domanda sul minerale e sul lingotto, senza restringere.
  assert.equal(answerIntent('q_inventory', obs, { message: 'quanto rame hai?' }), 'sì: copper_sword, copper_pickaxe x2, raw_copper x3');
});

// Il catalogo conosce anche i nomi dei gruppi: "armatura" è un pezzo indossabile
// qualunque, "spada" un utensile.
test('q_armor answers what is worn, not what is carried', () => {
  const obs = {
    inventory: { iron_chestplate: 1 },
    armor: { helmet: 'iron_helmet', chestplate: null, leggings: null, boots: 'iron_boots', points: 9 },
  };
  assert.equal(matchQuestionIntent('che armatura hai?')?.id, 'q_armor');
  assert.equal(answerIntent('q_armor', obs), 'indosso: iron_helmet, iron_boots (9 punti armatura)');
  assert.equal(answerIntent('q_armor', { armor: { helmet: null, chestplate: null, leggings: null, boots: null, points: 0 } }), 'non indosso armatura');
  // Il pettorale è in inventario ma non addosso: non conta.
  assert.doesNotMatch(answerIntent('q_armor', obs), /chestplate/);
  // Un ordine di equipaggiamento non è una domanda sull'armatura.
  assert.equal(matchQuestionIntent('equipaggiati con armatura in bronzo'), null);
  assert.equal(matchQuestionIntent('mettiti l\'elmo'), null);
});

test('an equip order with nothing to wear gets a short refusal', () => {
  const line = renderNoArmor({ from: 'Ale' });
  assert.equal(line, '@Ale non ho armatura in inventario, non posso equipaggiarmi');
  assert.equal(isSelfTriggering(line, '@bot'), false);
});

// M6.1: la guardia che decide se un messaggio può essere instradato a Jev. Deve
// essere *conservativa*: un falso positivo rifiuta un ordine vero, un falso
// negativo lascia solo il comportamento pre-M6.1.
test('the question guard only fires on explicit question markers', () => {
  // Segnali forti: il punto interrogativo (anche spagnolo) o l'apertura
  // interrogativa come prima parola.
  for (const message of ['quanti cuori hai?', '¿dove vas?', 'chi sei', 'CHE FAI', 'cosa hai in mano', 'perche?', 'where are you', 'quanto manca']) {
    assert.equal(looksLikeQuestion(message), true, `${message} deve sembrare una domanda`);
  }
  // Ordini e piccola conversazione: i verbi nudi (`hai`/`sei`/`stai`) sono
  // esclusi apposta, quindi "stai qui" e "sei un cretino" restano ordini.
  for (const message of ['stai qui', 'stai fermo', 'sei un cretino', 'prendi la terra', 'svuota le chest', 'aiuto', '', '  ']) {
    assert.equal(looksLikeQuestion(message), false, `${message} non deve sembrare una domanda`);
  }
  assert.equal(looksLikeQuestion('prendi la terra e dimmi cosa fai'), false, 'l\'apertura interrogativa deve essere la prima parola');
  assert.equal(looksLikeQuestion('prendi la terra, cosa fai dopo?'), true, 'il punto interrogativo conta anche dentro un ordine');
  assert.equal(looksLikeQuestion('@bot dove sei?'), true);
});

test('an unroutable question gets a short refusal that shows the way back to orders', () => {
  const line = renderUnrouted({ from: 'Ale', prefixes: ['@bot', '@hermes'] });
  assert.match(line, /^@Ale /);
  assert.match(line, /non ho capito la domanda/);
  assert.match(line, /@bot o @hermes <ordine>/);
  assert.doesNotMatch(line, /[\r\n]/, 'una sola riga');
  assert.equal(isSelfTriggering(line, ['@bot', '@hermes']), false, 'il rifiuto non deve scatenare il bot');
  assert.ok(line.length <= 180);
});

// --- La risposta deterministica parla la lingua di chi scrive (M7.1) ---------
// L'objective di un goal e' la descrizione tecnica della knowledge base, in
// inglese: in chat non ci va mai. Queste etichette sono la traduzione italiana
// dei goal strutturati, e il test di copertura impedisce che una chore o un
// bisogno nuovi restino senza risposta in italiano.

test('ogni chore del villaggio e ogni bisogno hanno un\'etichetta italiana', () => {
  for (const chore of VILLAGE_CHORES) {
    const label = CHORE_LABELS[chore.id];
    assert.equal(typeof label, 'string', `${chore.id} deve avere un'etichetta italiana`);
    assert.doesNotMatch(label, /\b(the|and|then|with|from)\b/i, `${chore.id} non deve contenere inglese (got "${label}")`);
  }
  for (const need of Object.keys(NEED_PRIORITY)) {
    const label = NEED_LABELS[need];
    assert.equal(typeof label, 'string', `${need} deve avere un'etichetta italiana`);
    assert.doesNotMatch(label, /\b(the|and|then|with|from)\b/i, `${need} non deve contenere inglese (got "${label}")`);
  }
});

test('planPhrase racconta in italiano cosa sta facendo il bot', () => {
  assert.equal(planPhrase({ chore: 'harvest_crops' }), 'raccogliere il raccolto maturo');
  assert.equal(planPhrase({ need: 'eat' }), 'mangiare qualcosa');
  assert.equal(planPhrase({ equip: true, need: 'wear_armor' }), "indossare l'armatura");
  assert.equal(planPhrase({ recover: true }), 'recuperare quello che ho perso morendo');
  assert.equal(planPhrase({ construction: {} }), 'costruire');
  assert.equal(planPhrase({ notes: 'opportunity:valuable_ore_seen' }), 'raccogliere quello che ho visto qui vicino');
  assert.equal(planPhrase({ notes: 'curriculum:first_night' }), 'portare avanti la missione');
  // Un ordine di un umano porta un objective gia' nella sua lingua: si usa
  // quello, e un objective inglese senza struttura non viene inventato.
  assert.equal(planPhrase({ objective: 'sto andando da Ale' }), null);
  assert.equal(planPhrase({ chore: 'chore_che_non_esiste' }), null);
  assert.equal(planPhrase(null), null);
  assert.equal(planPhrase('non un plan'), null);
});

test('"cosa stai facendo?" risponde in italiano anche per un goal autonomo', () => {
  const chore = { plan: { chore: 'mine_ore', objective: 'Mine the ore the village can see and bring it back for tools.' } };
  assert.equal(answerIntent('q_activity', chore), 'sto facendo: cercare minerali');
  const need = { plan: { need: 'sleep', objective: 'Reach the bed and sleep through the night.' } };
  assert.equal(answerIntent('q_activity', need), 'sto facendo: andare a dormire');
  const human = { plan: { objective: 'sto andando da Ale' } };
  assert.equal(answerIntent('q_activity', human), 'sto facendo: sto andando da Ale');
  assert.equal(answerIntent('q_activity', {}), 'non ho un obiettivo: sono in attesa di ordini');
});
