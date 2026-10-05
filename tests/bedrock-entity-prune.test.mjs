import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

// Potatura delle entita' (M5) vista dall'adapter.
//
// Un giocatore fermo non produce pacchetti di movimento, quindi non deve
// "invecchiare" come un mob: se la sua entita' sparisce, il server non la rimanda
// (`add_player` arriva solo quando un giocatore *entra* nel campo visivo del
// client), `follow_player` non viene piu' offerto e l'ordine "seguimi" di un umano
// immobile resta senza effetto per sempre. Osservato live sul BDS: l'entita' del
// giocatore era tracciata a 10,9 blocchi e dopo 60 s non c'era piu'.
//
// Per i giocatori l'unica fonte di verita' e' quindi il `remove_entity` del server.

function bareAdapter () {
  const adapter = new BedrockAdapter({ logger: { log () {} }, onLog: () => {} });
  adapter.position = { x: 0, y: 64, z: 0 };
  adapter.entities = new Map();
  adapter._entitiesByUnique = new Map();
  adapter._playersByName = new Map();
  return adapter;
}

// La posizione di un giocatore e' agli occhi: si passa y + EYE_HEIGHT e i piedi
// finiscono a `position.y`, come nei pacchetti reali.
function trackPlayer (adapter, { username = 'Human', lastAt = Date.now(), position = { x: 2, y: 64, z: 0 } } = {}) {
  adapter._trackEntity({
    runtime_id: `p:${username}`,
    unique_id: `u:${username}`,
    username,
    position: { x: position.x, y: position.y + 1.62, z: position.z },
  }, 'player');
  const entity = adapter.entities.get(`p:${username}`);
  entity.lastAt = lastAt;
  return entity;
}

function trackMob (adapter, { type = 'cow', lastAt = Date.now(), position = { x: 3, y: 64, z: 0 } } = {}) {
  adapter._trackEntity({
    runtime_id: `m:${type}`,
    unique_id: `u:${type}`,
    entity_type: type,
    position,
  }, 'mob');
  const entity = adapter.entities.get(`m:${type}`);
  entity.lastAt = lastAt;
  return entity;
}

test('un giocatore fermo da dieci minuti resta tracciato e seguibile', () => {
  const adapter = bareAdapter();
  trackPlayer(adapter, { lastAt: Date.now() - 10 * 60 * 1000 });
  adapter._pruneEntities();
  assert.ok(adapter.entities.has('p:Human'), "l'entita' del giocatore non va potata per inattivita'");
  assert.equal(adapter._playerByName('Human')?.username, 'Human');
  assert.deepEqual(adapter._nearbyHumanPlayers().map(h => h.username), ['Human']);
});

test('un giocatore lontano resta tracciato: la potatura spetta al server', () => {
  const adapter = bareAdapter();
  trackPlayer(adapter, { position: { x: 300, y: 64, z: 0 } });
  adapter._pruneEntities();
  assert.ok(adapter.entities.has('p:Human'), 'nessuna potatura per distanza sui giocatori');
  assert.deepEqual(adapter._nearbyHumanPlayers(), [], 'fuori HUMAN_RANGE non compare in `humans`');
  assert.equal(adapter._playerByName('Human')?.username, 'Human', 'il nome resta risolvibile');
});

test('i mob inattivi o lontani vengono potati come prima', () => {
  const adapter = bareAdapter();
  trackMob(adapter, { lastAt: Date.now() - 5 * 60 * 1000 });
  trackMob(adapter, { type: 'sheep', position: { x: 200, y: 64, z: 0 } });
  trackMob(adapter, { type: 'pig' });
  adapter._pruneEntities();
  assert.equal(adapter.entities.has('m:cow'), false, 'mob fermo da 5 minuti potato');
  assert.equal(adapter.entities.has('m:sheep'), false, 'mob oltre 64 blocchi potato');
  assert.equal(adapter.entities.has('m:pig'), true, 'mob vicino e fresco resta');
});

test('remove_entity del server e\' la via di uscita del giocatore e libera il nome', () => {
  const adapter = bareAdapter();
  trackPlayer(adapter);
  adapter._onEntityRemove({ entity_id_self: 'u:Human' });
  assert.equal(adapter.entities.has('p:Human'), false);
  assert.equal(adapter._playersByName.has('human'), false, 'il nome non punta a un runtime id riciclato');
  assert.equal(adapter._playerByName('Human'), null);
});

test('la potatura di un giocatore libera anche la mappa dei nomi', () => {
  const adapter = bareAdapter();
  trackPlayer(adapter, { lastAt: Date.now() - 1000 });
  // Potatura coi criteri dei mob: il giocatore resta, quindi la mappa e' intatta.
  adapter._pruneEntities();
  assert.equal(adapter._playersByName.get('human'), 'p:Human');
});
