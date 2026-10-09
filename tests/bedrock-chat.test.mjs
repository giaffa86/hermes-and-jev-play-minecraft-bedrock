import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

// Chat (M5) vista dall'adapter: il server rimanda al mittente i propri messaggi
// con il gamertag reale, che *non* è `BEDROCK_USERNAME` (nome di autenticazione).
// Questi test fissano il riconoscimento dell'eco: senza, il bot può scambiare la
// propria voce per un ordine di un umano fidato (osservato live sul BDS).
const LOGIN_NAME = 'hermes-bot';
const REAL_GAMERTAG = 'SomePlayer';

function chatAdapter () {
  const events = [];
  const sent = [];
  const adapter = new BedrockAdapter({ logger: { log () {} }, onLog: entry => events.push(entry) });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.client = { queue: (name, packet) => { sent.push({ name, packet }); } };
  adapter.inventory = {};
  adapter.nearbyBlocks = {};
  adapter.position = { x: 0.5, y: 72.62, z: 0.5 };
  adapter._feet = { x: 0.5, y: 71, z: 0.5 };
  return { adapter, events, sent };
}

const types = events => events.map(e => e.type);

test('un messaggio del bot che torna indietro è un eco: non entra nell inbox', () => {
  const { adapter, events, sent } = chatAdapter();
  assert.deepEqual(adapter.sendChat('@Ale ok: prendi la terra'), { ok: true, message: '@Ale ok: prendi la terra' });
  assert.equal(sent[0].name, 'text');
  assert.equal(sent[0].packet.message, '@Ale ok: prendi la terra');

  adapter._onChat({ type: 'chat', source_name: REAL_GAMERTAG, message: '@Ale ok: prendi la terra', xuid: 42n });
  assert.deepEqual(adapter.chatInbox, [], 'la propria voce non è un comando');
  assert.ok(types(events).includes('chat_echo'), 'l eco è loggata come tale');
  assert.equal(types(events).includes('chat'), false);
});

test("l'eco insegna il gamertag reale, poi il bot si riconosce anche a testo diverso", () => {
  const { adapter, events } = chatAdapter();
  assert.equal(adapter.selfName, null);
  adapter.sendChat('hello world');
  adapter._onChat({ type: 'chat', source_name: REAL_GAMERTAG, message: 'hello world', xuid: 42n });
  assert.equal(adapter.selfName, REAL_GAMERTAG, 'il nome attribuito dal server viene imparato');
  assert.deepEqual(types(events).filter(t => t === 'self_name_learned'), ['self_name_learned']);
  assert.equal(adapter.isSelfName(REAL_GAMERTAG), true);
  assert.equal(adapter.isSelfName(REAL_GAMERTAG.toLowerCase()), true, 'confronto case-insensitive');

  // Da qui in avanti anche un messaggio non identico ma del bot stesso è scartato.
  adapter._onChat({ type: 'chat', source_name: REAL_GAMERTAG, message: 'qualcosa che non ho appena detto', xuid: 42n });
  assert.deepEqual(adapter.chatInbox, []);
});

test('la chat di un altro giocatore entra nell inbox con mittente, xuid e tipo', () => {
  const { adapter, events } = chatAdapter();
  adapter._onChat({ type: 'chat', source_name: REAL_GAMERTAG, message: 'prima che il bot parli', xuid: 42n });
  assert.equal(adapter.chatInbox.length, 1);
  assert.equal(adapter.chatInbox[0].from, REAL_GAMERTAG);
  assert.equal(adapter.chatInbox[0].xuid, '42');
  assert.equal(adapter.chatInbox[0].type, 'chat');
  assert.ok(types(events).includes('chat'));

  adapter._onChat({ type: 'whisper', source_name: 'Other', message: 'ciao', xuid: 7n });
  assert.equal(adapter.chatInbox.length, 2);
  assert.equal(adapter.chatInbox[1].type, 'whisper');
});

test('tipi di testo non-chat (raw/system) non sono ordini, ma si conservano per la diagnosi', () => {
  const { adapter, events } = chatAdapter();
  adapter._onChat({ type: 'raw', source_name: REAL_GAMERTAG, message: 'benvenuto nel server' });
  adapter._onChat({ type: 'system', source_name: null, message: 'server restart' });
  assert.deepEqual(adapter.chatInbox, [], 'un testo di sistema non è un comando di un umano');
  // M13 (08/10/2026): il server spiega lì i suoi rifiuti («N giocatori devono
  // dormire», gamerule, «non puoi dormire adesso»): scartarli rendeva il sonno
  // un falso allarme. Non entrano nell'inbox, ma restano leggibili.
  assert.deepEqual(types(events), ['server_text', 'server_text']);
  assert.deepEqual(adapter.serverText.map(row => row.text), ['benvenuto nel server', 'server restart']);
});

test('un messaggio identico ma vecchio non è un eco (finestra scaduta)', () => {
  const { adapter } = chatAdapter();
  adapter.sendChat('repeat me');
  adapter._sentChat = adapter._sentChat.map(entry => ({ ...entry, at: Date.now() - 60000 }));
  adapter._onChat({ type: 'chat', source_name: 'Other', message: 'repeat me', xuid: 1n });
  assert.equal(adapter.chatInbox.length, 1, 'fuori finestra vale come voce umana');
});

test('isSelfName riconosce il nome di login e non il resto', () => {
  const { adapter } = chatAdapter();
  assert.equal(adapter.isSelfName(LOGIN_NAME), true);
  assert.equal(adapter.isSelfName(LOGIN_NAME.toUpperCase()), true);
  assert.equal(adapter.isSelfName('SomePlayer'), false);
  assert.equal(adapter.isSelfName(null), false);
  assert.equal(adapter.isSelfName(''), false);
});

test('_nearbyHumanPlayers salta il bot anche quando il server usa il gamertag', () => {
  const { adapter } = chatAdapter();
  adapter.sendChat('hello');
  adapter._onChat({ type: 'chat', source_name: REAL_GAMERTAG, message: 'hello', xuid: 42n });
  const position = { x: 0.5, y: 71, z: 0.5 };
  adapter.entities.set(1, { runtimeId: 1, kind: 'player', username: REAL_GAMERTAG, position, positionValid: true });
  adapter.entities.set(2, { runtimeId: 2, kind: 'player', username: 'Visitor', position, positionValid: true });
  const humans = adapter._nearbyHumanPlayers();
  assert.deepEqual(humans.map(h => h.username), ['Visitor']);
});

test('sendChat non registra nulla quando il pacchetto non parte', () => {
  const { adapter } = chatAdapter();
  adapter.spawned = false;
  assert.deepEqual(adapter.sendChat('ciao'), { ok: false, error: 'not_spawned' });
  assert.deepEqual(adapter._sentChat, []);
  adapter.spawned = true;
  assert.deepEqual(adapter.sendChat('   '), { ok: false, error: 'empty_message' });
  assert.deepEqual(adapter._sentChat, []);
});

test('sendChat applica il rate limit e ricorda solo i messaggi inviati', () => {
  const { adapter, sent } = chatAdapter();
  assert.equal(adapter.sendChat('uno').ok, true);
  const second = adapter.sendChat('due');
  assert.equal(second.ok, false);
  assert.equal(second.error, 'rate_limited');
  assert.ok(second.retryInMs > 0);
  assert.equal(sent.length, 1, 'il pacchetto rate-limited non esce');
  assert.deepEqual(adapter._sentChat.map(e => e.text), ['uno']);
});

// Prove del canale chat senza un umano in gioco (`POST /debug/chat`). La regola
// che conta: un messaggio simulato **non può impersonare un umano**. Il mittente
// diventa `sim:<nome>`, l'entry porta `simulated: true` e il log è
// `chat_simulated`, così il ledger non confonde una prova con una persona.
test('un messaggio simulato entra nell inbox come sim:<nome>, marcato', () => {
  const { adapter, events } = chatAdapter();
  const out = adapter.simulateChat({ from: 'Probe', message: 'che armatura hai?' });

  assert.equal(out.ok, true);
  assert.equal(out.from, 'sim:Probe');
  assert.equal(out.accepted, true);
  assert.equal(adapter.chatInbox.length, 1);
  assert.deepEqual(adapter.chatInbox[0], { from: 'sim:Probe', message: 'che armatura hai?', type: 'chat', xuid: null, at: adapter.chatInbox[0].at, simulated: true });
  assert.equal(types(events).includes('chat_simulated'), true);
  assert.equal(types(events).includes('chat'), false, 'non si spaccia per un messaggio vero');
  assert.equal(out.entry.from, 'sim:Probe');
});

test('la rotta di prova rifiuta un messaggio senza mittente o senza testo', () => {
  const { adapter } = chatAdapter();
  assert.deepEqual(adapter.simulateChat({ from: '', message: 'x' }), { ok: false, error: 'chat_simulate_requires_sender_and_message' });
  assert.deepEqual(adapter.simulateChat({ from: 'Probe', message: '   ' }).ok, true, 'uno spazio è testo: il filtro è del controller');
  assert.deepEqual(adapter.simulateChat({}), { ok: false, error: 'chat_simulate_requires_sender_and_message' });
  assert.equal(adapter.simulateChat({ from: 'Probe', message: undefined }).ok, false);
});

test('un mittente simulato non può usare un prefisso umano (il prefisso sim: è forzato una volta sola)', () => {
  const { adapter } = chatAdapter();
  assert.equal(adapter.simulateChat({ from: 'sim:Probe', message: 'ciao' }).from, 'sim:Probe');
  adapter._onChat({ type: 'chat', source_name: 'SomePlayer', message: 'ciao', simulated: true });
  assert.equal(adapter.chatInbox.at(-1).from, 'sim:SomePlayer', 'la marcatura basta a cambiare il mittente');
  assert.equal(adapter.chatInbox.at(-1).simulated, true);
});

test('un messaggio simulato che è la voce del bot non entra nell inbox', () => {
  const { adapter, events } = chatAdapter();
  adapter.sendChat('sono io');
  const out = adapter.simulateChat({ from: 'Probe', message: 'sono io' });
  assert.equal(out.ok, true);
  assert.equal(out.accepted, false, 'l eco è scartata anche per una prova');
  assert.deepEqual(adapter.chatInbox, []);
  assert.ok(types(events).includes('chat_echo'));
});
