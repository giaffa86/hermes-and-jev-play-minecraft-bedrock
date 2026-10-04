import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

// Il BDS firma i nomi con i codici di formattazione (`§r`, `§7`, …): in chat il
// gamertag arriva come `Nome§r`, nei pacchetti entità invece pulito. Senza
// normalizzazione la stessa persona è due stringhe diverse e ogni confronto
// esatto salta: l'allowlist del controller (`entry.from`), il lookup dell'entità
// da seguire (`_playerByName`) e il saluto per gamertag. Questi test fissano la
// normalizzazione alla fonte (osservato live sul BDS il 03/10/2026).
const SENDER = 'TestPlayer';
const SENDER_SIGNED = `${SENDER}\u00a7r`;

function chatAdapter () {
  const events = [];
  const adapter = new BedrockAdapter({ logger: { log () {} }, onLog: entry => events.push(entry) });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.client = { queue () {} };
  adapter.inventory = {};
  adapter.nearbyBlocks = {};
  adapter.position = { x: 0.5, y: 72.62, z: 0.5 };
  adapter._feet = { x: 0.5, y: 71, z: 0.5 };
  return { adapter, events };
}

test('il codice §r del mittente non entra nell inbox di chat', () => {
  const { adapter, events } = chatAdapter();
  adapter._onChat({ type: 'chat', source_name: SENDER_SIGNED, message: '@bot seguimi', xuid: 7n });
  assert.equal(adapter.chatInbox.length, 1);
  assert.equal(adapter.chatInbox[0].from, SENDER, 'il gamertag pulito fa passare l allowlist per nome');
  assert.equal(adapter.chatInbox[0].message, '@bot seguimi');
  assert.equal(adapter.chatInbox[0].xuid, '7');
  const chat = events.filter(entry => entry.type === 'chat').at(-1);
  assert.equal(chat.from, SENDER, 'anche il log porta il nome pulito');
});

test('tutti i codici di formattazione vengono tolti dal mittente', () => {
  const { adapter } = chatAdapter();
  adapter._onChat({ type: 'chat', source_name: `${SENDER}\u00a77\u00a7l`, message: 'uno', xuid: 1n });
  adapter._onChat({ type: 'whisper', source_name: `${SENDER}\u00a7`, message: 'due', xuid: 2n });
  assert.deepEqual(adapter.chatInbox.map(entry => entry.from), [SENDER, SENDER]);
});

test('l eco impara il gamertag pulito e il bot si riconosce anche firmato', () => {
  const { adapter } = chatAdapter();
  adapter.sendChat('hello');
  adapter._onChat({ type: 'chat', source_name: SENDER_SIGNED, message: 'hello', xuid: 1n });
  assert.deepEqual(adapter.chatInbox, [], 'la propria voce non è un comando');
  assert.equal(adapter.selfName, SENDER);
  assert.equal(adapter.isSelfName(SENDER), true);
  assert.equal(adapter.isSelfName(SENDER_SIGNED), true, 'il nome firmato è ancora il bot');
  assert.equal(adapter.isSelfName(`${SENDER}\u00a7r\u00a7b`), true);
  assert.equal(adapter.isSelfName('Visitor'), false);
});

test('_playerByName trova l entità anche quando un lato porta i codici', () => {
  const { adapter } = chatAdapter();
  adapter._trackEntity({ runtime_id: 7, username: SENDER_SIGNED, position: { x: 1.5, y: 71, z: 1.5 } }, 'player');
  assert.equal(adapter.entities.get('7').username, SENDER, 'l entità è tracciata col nome pulito');
  const clean = adapter._playerByName(SENDER);
  const signed = adapter._playerByName(SENDER_SIGNED);
  assert.equal(clean?.runtimeId, '7');
  assert.equal(signed?.runtimeId, '7', 'il gamertag arrivato dalla chat trova la stessa entità');
  assert.equal(adapter._playerByName('Nessuno'), null);
  assert.equal(adapter._playerByName(null), null);
});

test('l ordine "@bot seguimi" offre follow_player anche col nome firmato', () => {
  const { adapter } = chatAdapter();
  adapter._trackEntity({ runtime_id: 7, username: SENDER, position: { x: 1.5, y: 71, z: 1.5 } }, 'player');
  adapter.plan = { ...(adapter.plan || {}), follow: SENDER_SIGNED };
  const follow = adapter.options().find(option => option.key === 'follow_player');
  assert.ok(follow, 'follow_player deve comparire tra le opzioni valide');
});
