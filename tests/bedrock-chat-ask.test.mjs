// R2 — la domanda in attesa, vista dall'adapter (`bedrock-adapter.mjs`).
//
// Il ciclo di vita della chat vive qui: «a chi ho appena chiesto qualcosa?». Il
// messaggio successivo di quel mittente è la **risposta**, non un ordine nuovo,
// e l'inbox lo dice al controller decorandolo con `clarifies`. La decorazione è
// una volta sola e non deve mai toccare la voce del bot (l'eco) né un altro
// giocatore; una domanda senza risposta scade da sola.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

function askAdapter () {
  const events = [];
  const adapter = new BedrockAdapter({ logger: { log () {} }, onLog: entry => events.push(entry) });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.client = { queue: () => {} };
  adapter.inventory = {};
  adapter.nearbyBlocks = {};
  adapter.position = { x: 0.5, y: 72.62, z: 0.5 };
  adapter._feet = { x: 0.5, y: 71, z: 0.5 };
  return { adapter, events };
}

const types = events => events.map(e => e.type);

test('askChat registra la domanda e la espone; senza mittente o senza domanda non registra niente', () => {
  const { adapter, events } = askAdapter();
  const out = adapter.askChat({ from: 'Ale', xuid: '123', orderId: 'c1', originalText: 'vai', question: 'dove vuoi che vada?', field: 'destination', reason: 'no_destination' });
  assert.equal(out.ok, true);
  assert.equal(out.pending.length, 1);
  assert.deepEqual(Object.keys(out.pending[0]).sort(), ['askedAt', 'field', 'from', 'orderId', 'question', 'reason']);
  assert.equal(adapter._chatPendingView().length, 1, 'una domanda, due chiavi (gamertag e xuid): una sola riga');
  assert.ok(types(events).includes('chat_ask'));

  assert.deepEqual(adapter.askChat({ from: '', orderId: 'c2', question: 'x' }), { ok: false, error: 'ask_requires_sender_and_question' });
  assert.deepEqual(adapter.askChat({ from: 'Ale', orderId: 'c3', question: '   ' }), { ok: false, error: 'ask_requires_sender_and_question' });
  assert.equal(adapter._chatPendingView().length, 1, 'i rifiuti non sporcano la coda');
});

test('il messaggio successivo dello stesso mittente porta `clarifies`, una volta sola', () => {
  const { adapter, events } = askAdapter();
  adapter.askChat({ from: 'Ale', xuid: '123', orderId: 'c1', originalText: 'vai', question: 'dove vuoi che vada?' });

  adapter._onChat({ type: 'chat', source_name: 'Ale', message: 'coordinate 120 64 -230', xuid: 123n });
  assert.equal(adapter.chatInbox.length, 1);
  assert.deepEqual(adapter.chatInbox[0].clarifies, { orderId: 'c1', originalText: 'vai', question: 'dove vuoi che vada?' });
  assert.equal(adapter._chatPendingView().length, 0, 'la risposta consuma la domanda');
  assert.ok(types(events).includes('chat_clarify_reply'));

  adapter._onChat({ type: 'chat', source_name: 'Ale', message: 'poi vai al mulino', xuid: 123n });
  assert.equal(adapter.chatInbox[1].clarifies, undefined, 'la decorazione è una volta sola');
});

test('il riconoscimento ignora le maiuscole e vale anche per lo xuid', () => {
  const { adapter } = askAdapter();
  adapter.askChat({ from: 'Ale', xuid: '123', orderId: 'c1', originalText: 'vai', question: 'dove?' });
  adapter._onChat({ type: 'chat', source_name: 'ALE', message: 'al rifugio', xuid: 999n });
  assert.equal(adapter.chatInbox[0].clarifies?.orderId, 'c1', 'stesso gamertag, maiuscole diverse');

  adapter.askChat({ from: 'Ale', xuid: '123', orderId: 'c2', originalText: 'vai', question: 'dove?' });
  adapter._onChat({ type: 'chat', source_name: 'Nome Cambiato', message: 'qui', xuid: 123n });
  assert.equal(adapter.chatInbox[1].clarifies?.orderId, 'c2', 'lo xuid basta da solo');
});

test('la voce del bot (eco) e la chat di un altro giocatore non consumano la domanda', () => {
  const { adapter } = askAdapter();
  adapter.askChat({ from: 'Ale', orderId: 'c1', originalText: 'vai', question: 'dove?' });

  adapter.sendChat('@Ale dove?');
  adapter._onChat({ type: 'chat', source_name: 'SomePlayer', message: '@Ale dove?', xuid: 42n });
  assert.equal(adapter.chatInbox.length, 0, 'è l eco del bot');
  adapter._onChat({ type: 'chat', source_name: 'Bob', message: 'ciao a tutti', xuid: 7n });
  assert.equal(adapter.chatInbox[0].clarifies, undefined, 'un altro giocatore non risponde per Ale');
  assert.equal(adapter._chatPendingView().length, 1, 'la domanda è ancora viva');

  adapter._onChat({ type: 'chat', source_name: 'Ale', message: 'vieni da me', xuid: 55n });
  assert.equal(adapter.chatInbox[1].clarifies?.orderId, 'c1', 'e il vero mittente la trova ancora');
});

test('una domanda scaduta non decora più niente, e non resta in coda', () => {
  const { adapter, events } = askAdapter();
  adapter.askChat({ from: 'Ale', xuid: '123', orderId: 'c1', originalText: 'vai', question: 'dove?' });
  // La scadenza è la stessa finestra con cui il controller scarta un ordine
  // vecchio (`CHAT_MAX_AGE_MS`): una risposta più tarda non risponde più a quella
  // domanda. Il record è condiviso dalle due chiavi, quindi ne basta uno.
  adapter.chatPending.get('ale').askedAt = Date.now() - 400000;

  adapter._onChat({ type: 'chat', source_name: 'Ale', message: 'coordinate 1 2 3', xuid: 123n });
  assert.equal(adapter.chatInbox[0].clarifies, undefined);
  assert.equal(adapter._chatPendingView().length, 0, 'la voce scaduta è tolta, non lasciata lì');
  assert.ok(types(events).includes('chat_ask_stale'));
});

test('observe() porta le domande in attesa, una riga per domanda', () => {
  const { adapter } = askAdapter();
  assert.deepEqual(adapter.observe().chatPending, []);
  adapter.askChat({ from: 'Ale', xuid: '1', orderId: 'c1', originalText: 'vai', question: 'dove?', field: 'destination' });
  adapter.askChat({ from: 'Bob', xuid: '2', orderId: 'c2', originalText: 'guidami', question: 'dove ti porto?', field: 'place' });
  const pending = adapter.observe().chatPending;
  assert.equal(pending.length, 2);
  assert.deepEqual(pending.map(p => p.from).sort(), ['Ale', 'Bob']);
  assert.deepEqual(pending.map(p => p.orderId).sort(), ['c1', 'c2']);
});
