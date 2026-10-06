// La **morte** del bot e' un episodio: comincia quando la vita arriva a 0 e
// finisce quando torna sopra 0. `dead`, invece, si chiude e si riapre dentro
// l'episodio (il respawn client che il fallback completa a 4 s, il limbo del
// BDS che lascia la vita a 0). Contare l'evento `death` su `dead` scriveva una
// morte per ogni ciclo: live demo-r2 del 06/10 il ledger ha 10 eventi `death`
// dove le morti vere erano 7, quattro delle quali (22:24:00 → 22:25:16) alla
// stessa coordinata e senza nessuna azione del driver in mezzo, e ogni ciclo
// riazzerava anche `_deadSince` (la riconnessione, `deadMs: 25023`, ripartiva
// da capo a ogni giro).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

function deathAdapter ({ logs = [] } = {}) {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.client = new EventEmitter();
  adapter.client.entityId = 7n;
  adapter.client.write = () => {};
  adapter.position = { x: 92.5, y: 74.62, z: 163.5 };
  adapter._feet = { x: 92.5, y: 73, z: 163.5 };
  adapter.log = (type, data) => logs.push({ type, ...(data || {}) });
  return adapter;
}

const deaths = logs => logs.filter(l => l.type === 'death');

test('the respawn fallback does not turn one death into two', () => {
  const logs = [];
  const adapter = deathAdapter({ logs });
  adapter.health = 0;
  adapter._onOwnHealth();
  assert.equal(adapter.deaths, 1);
  assert.equal(adapter._deathEpisode, true);
  const site = { ...adapter.deathSite.position };

  // Il respawn si chiude lato client (fallback) ma il server non ha ancora
  // riportato la vita sopra zero: e' il limbo. Il prossimo aggiornamento di
  // vita, ancora 0, non e' una morte nuova.
  adapter._finishRespawn({ x: 92.5, y: 74.62, z: 163.5 });
  assert.equal(adapter.dead, false);
  adapter._onOwnHealth();
  assert.equal(adapter.deaths, 1, 'la morte e\' un episodio, non un ciclo di respawn');
  assert.equal(deaths(logs).length, 1);
  assert.deepEqual(adapter.deathSite.position, site, 'il sito di morte resta quello vero');
});

test('the life that comes back closes the episode, even after the fallback cleared dead', () => {
  const logs = [];
  const adapter = deathAdapter({ logs });
  adapter.health = 0;
  adapter._onOwnHealth();
  adapter._finishRespawn({ x: 92.5, y: 74.62, z: 163.5 });
  adapter.health = 6;
  adapter._onOwnHealth();

  assert.equal(adapter.dead, false);
  assert.equal(adapter._deathEpisode, false);
  assert.equal(logs.filter(l => l.type === 'alive_again').length, 1,
    'alive_again anche quando il fallback aveva gia\' chiuso dead (prima non usciva: il limbo restava muto)');

  // Una morte nuova e' un episodio nuovo.
  adapter.health = 0;
  adapter._onOwnHealth();
  assert.equal(adapter.deaths, 2);
  assert.equal(deaths(logs).length, 2);
});

test('a whole limbo dance writes one death event', () => {
  const logs = [];
  const adapter = deathAdapter({ logs });
  const packets = [];
  adapter.client.write = (name, params) => packets.push({ name, params });
  adapter.health = 0;
  adapter._onOwnHealth();

  for (let i = 0; i < 3; i++) {
    adapter._onRespawnPacket({ state: 0, position: { x: 92.5, y: 74.62, z: 163.5 } });
    adapter._finishRespawn({ x: 92.5, y: 74.62, z: 163.5 });
    adapter._onOwnHealth();
  }

  assert.equal(adapter.deaths, 1);
  assert.equal(deaths(logs).length, 1);
  // `_onRespawnPacket` risponde al server solo mentre `dead` e' aperto: il
  // fallback lo chiude, quindi senza il riarmo di `_survivalTick` (non
  // esercitato qui) il client smette di rispondere. Quello che conta e' che
  // l'andirivieni non scrive altre morti.
  assert.ok(packets.filter(p => p.name === 'respawn').length >= 1);
  assert.equal(packets[0].params.state, 2, 'client_ready_to_spawn');
});
