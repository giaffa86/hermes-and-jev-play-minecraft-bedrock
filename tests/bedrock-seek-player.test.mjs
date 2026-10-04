import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';
import { optionIntents } from '../survival/intents.mjs';

// "Wolf recovery": quando un ordine "seguimi" è aperto e il giocatore esce dal
// raggio di vista, il BDS manda `remove_entity` e non rimanda più nulla di lui:
// `follow_player` non è più offerto e l'ordine resterebbe senza esecutore. Qui
// l'adapter ricorda *dove* l'ha visto l'ultima volta e offre `seek_player`
// (cammina verso quel ricordo) finché la traccia è recente e vicina. La chat è
// l'ultima risorsa e la decide il controller: l'harness fornisce solo il fatto.
const SENDER = 'TestPlayer';
const UNIQUE_ID = 77;

function adapterFor (position = { x: 0.5, y: 72.62, z: 0.5 }) {
  const events = [];
  const adapter = new BedrockAdapter({ logger: { log () {} }, onLog: entry => events.push(entry) });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.client = { queue () {} };
  adapter.inventory = {};
  adapter.nearbyBlocks = {};
  adapter.position = position;
  adapter._feet = { x: position.x, y: position.y - 1.62, z: position.z };
  adapter.plan = { ...(adapter.plan || {}), follow: SENDER };
  return { adapter, events };
}

function track (adapter, position) {
  adapter._trackEntity({ runtime_id: 7, unique_id: UNIQUE_ID, username: SENDER, position }, 'player');
}

function disappear (adapter) {
  adapter._onEntityRemove({ entity_id_self: UNIQUE_ID });
}

test('l ultima posizione nota di un giocatore viene ricordata e osservata', () => {
  const { adapter } = adapterFor();
  track(adapter, { x: 12.5, y: 72.62, z: 4.5 });
  const seen = adapter._playerLastSeen.get(SENDER.toLowerCase());
  assert.ok(seen, 'la posizione del giocatore tracciato è memorizzata');
  assert.equal(seen.position.x, 12.5);
  const observe = adapter.observe();
  assert.equal(observe.follow.name, SENDER);
  assert.equal(observe.follow.tracked, true, 'entità viva: tracciata');
  assert.equal(observe.follow.approachable, true);
  assert.deepEqual(observe.follow.lastSeen, { x: 12.5, y: 71, z: 4.5 });
  assert.equal(observe.follow.searchable, false, 'finché lo vedo non c è niente da cercare');
});

test('col giocatore tracciato e vicino si offre follow_player, non seek_player', () => {
  const { adapter } = adapterFor();
  track(adapter, { x: 2.5, y: 71, z: 0.5 });
  const keys = adapter.options().map(option => option.key);
  assert.ok(keys.includes('follow_player'));
  assert.ok(!keys.includes('seek_player'), 'nessuna ricerca quando lo si vede');
});

test('quando il giocatore esce dalla vista si offre seek_player sull ultima posizione', () => {
  const { adapter } = adapterFor();
  track(adapter, { x: 20.5, y: 71, z: 0.5 });
  disappear(adapter);
  assert.equal(adapter._playerByName(SENDER), null, 'remove_entity cancella l entità');
  assert.ok(adapter._playerLastSeen.has(SENDER.toLowerCase()), 'ma non il ricordo di dove era');

  const options = adapter.options();
  const seek = options.find(option => option.key === 'seek_player');
  assert.ok(seek, 'seek_player deve comparire quando il bersaglio è perduto');
  assert.match(seek.description, /last known position/);
  assert.match(seek.description, /20\.0 blocks away/);
  assert.ok(!options.some(option => option.key === 'follow_player'), 'non si insegue un entità che non c è');
  const observe = adapter.observe();
  assert.equal(observe.follow.tracked, false);
  assert.equal(observe.follow.searchable, true);
});

test('una traccia troppo vecchia o troppo lontana non vale un viaggio', () => {
  const { adapter } = adapterFor();
  track(adapter, { x: 30.5, y: 71, z: 0.5 });
  disappear(adapter);
  const key = SENDER.toLowerCase();

  adapter._playerLastSeen.set(key, { position: { x: 30.5, y: 71, z: 0.5 }, at: Date.now() - 3600000 });
  assert.equal(adapter._seekTarget(SENDER), null, 'un ricordo di un ora fa è troppo vecchio');
  assert.equal(adapter.options().some(option => option.key === 'seek_player'), false);

  adapter._playerLastSeen.set(key, { position: { x: 900.5, y: 71, z: 0.5 }, at: Date.now() });
  assert.equal(adapter._seekTarget(SENDER), null, '900 blocchi sono fuori portata');
  assert.equal(adapter.options().some(option => option.key === 'seek_player'), false);

  adapter._playerLastSeen.set(key, { position: { x: 1.5, y: 71, z: 0.5 }, at: Date.now() });
  assert.equal(adapter._seekTarget(SENDER), null, 'a un blocco di distanza non è una ricerca');
  assert.equal(adapter.options().some(option => option.key === 'seek_player'), false);
});

test('_seekPlayer cammina verso il ricordo e dichiara se lo ha ritrovato', async () => {
  const { adapter, events } = adapterFor();
  track(adapter, { x: 18.5, y: 72.62, z: 0.5 });
  disappear(adapter);
  const walked = [];
  adapter._moveTo = async (target, stopDistance, timeoutMs) => {
    walked.push({ target, stopDistance, timeoutMs });
    return { ok: true, distance: 18.0, pathNodes: 9, goal: target };
  };

  const missed = await adapter._seekPlayer(SENDER);
  assert.equal(missed.ok, false, 'se non c è nessuno la ricerca non è un successo');
  assert.equal(missed.found, false);
  assert.equal(missed.error, 'player_not_found');
  assert.deepEqual(missed.searched, { x: 18.5, y: 71, z: 0.5 });
  assert.equal(missed.walked, 18.0);
  assert.deepEqual(walked[0].target, { x: 18.5, y: 71, z: 0.5 });
  assert.ok(events.some(entry => entry.type === 'seek_start'), 'la ricerca è registrata');
  assert.ok(events.some(entry => entry.type === 'seek_failed'), 'il fallimento è registrato');

  adapter._moveTo = async (target) => {
    track(adapter, { x: 10.5, y: 71, z: 0.5 });
    return { ok: true, distance: 3.0, pathNodes: 5, goal: target };
  };
  const found = await adapter._seekPlayer(SENDER);
  assert.equal(found.ok, true);
  assert.equal(found.found, true);
  assert.ok(found.distance >= 10 && found.distance < 11, 'la distanza riportata è quella dall entità ritrovata');
  assert.ok(events.some(entry => entry.type === 'seek_found'));
});

test('_seekPlayer senza una traccia nota non inventa un bersaglio', async () => {
  const { adapter } = adapterFor();
  track(adapter, { x: 18.5, y: 71, z: 0.5 });
  disappear(adapter);
  adapter._playerLastSeen.delete(SENDER.toLowerCase());
  const result = await adapter._seekPlayer(SENDER);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no_seek_target');
  assert.equal(adapter._seekTarget(SENDER), null);
});

test('seek_player è un intento di viaggio (non filtrato in emergenza)', () => {
  assert.deepEqual(optionIntents('seek_player'), ['travel']);
});
