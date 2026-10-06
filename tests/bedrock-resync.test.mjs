// Il resync dell'inventario nasce per rinfrescare gli stack id stantii dopo un
// pickup, e lo faceva riconnettendosi: `disconnect` + `connect`. Quando il BDS
// non ha ancora rilasciato la sessione NetherNet la riconnessione fallisce con
// `connecterror:9` (= `ErrorCode.InactivityTimeout` della negoziazione) e
// ripeterla la peggiora (live demo-r2: `[connect] attempt 5/6/8 failed`, fino al
// restart del container). Questi test tengono ferme le tre regole del rimedio:
// prima si chiede l'inventario alla finestra del giocatore (nessuna sessione
// nuova), fra disconnect e connect si lascia respiro al server, e due
// riconnessioni ravvicinate si rifiutano invece di tempestare il server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

function resyncAdapter ({ logs = [], snapshot = false, connectError = null, spawnOnConnect = true } = {}) {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.log = (type, data) => logs.push({ type, ...data });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.client = new EventEmitter();
  adapter.client.entityId = 7n;
  adapter.client.write = () => {};
  adapter._resyncSettleMs = 0;                 // nessuna attesa reale nei test
  adapter._inventoryRefreshTimeoutMs = 25;
  adapter.calls = { open: 0, close: 0, disconnect: 0, connect: 0 };
  // L'apertura della finestra del giocatore: il server risponde con un
  // `inventory_content` a 36 slot solo se il test lo prevede.
  adapter._ensureInventoryOpen = async () => {
    adapter.calls.open++;
    adapter._openContainer = { id: 'inventory', type: 'inventory' };
    if (snapshot) {
      const slots = Array.from({ length: 36 }, () => null);
      slots[3] = { network_id: 50, name: 'torch', count: 2, stack_id: 91 };
      adapter._applyPlayerInventorySnapshot(slots, { containerId: 'inventory' });
    }
  };
  adapter._closeContainer = async () => { adapter.calls.close++; adapter._openContainer = null; };
  adapter.disconnect = async () => {
    adapter.calls.disconnect++;
    adapter.spawned = false;
    adapter.client = null;
  };
  adapter.connect = async () => {
    adapter.calls.connect++;
    if (connectError) {
      adapter.connectError = new Error(connectError);
      throw adapter.connectError;
    }
    adapter.client = new EventEmitter();
    adapter.client.entityId = 7n;
    adapter.client.write = () => {};
    adapter.spawned = spawnOnConnect;
  };
  return adapter;
}

test('a resync refreshes the slots from the player window without reconnecting', async () => {
  const logs = [];
  const adapter = resyncAdapter({ logs, snapshot: true });
  adapter.inventorySlots = [{ network_id: 50, name: 'torch', count: 7, stack_id: 12 }];
  adapter._refreshInventory();

  await adapter._resyncByReconnect();

  assert.deepEqual(adapter.calls, { open: 1, close: 1, disconnect: 0, connect: 0 },
    'la sessione NetherNet non viene toccata quando il server risponde');
  assert.equal(adapter.inventorySlots[3].stack_id, 91, 'lo stack id arriva dallo snapshot');
  assert.equal(adapter.inventory.torch, 2, 'gli slot vecchi sono sostituiti, non sommati');
  const done = logs.find(l => l.type === 'inventory_resync_done');
  assert.equal(done.via, 'refresh');
  assert.equal(adapter._lastInventoryReconnectAt, 0, 'nessuna riconnessione, nessun cooldown consumato');
});

test('a resync falls back to the reconnect when the server does not answer the window', async () => {
  const logs = [];
  const adapter = resyncAdapter({ logs, snapshot: false });

  await adapter._resyncByReconnect();

  assert.equal(adapter.calls.open, 1, 'il tentativo in-place viene comunque fatto');
  assert.deepEqual([adapter.calls.disconnect, adapter.calls.connect], [1, 1], 'e ripiega sulla riconnessione');
  assert.equal(adapter.spawned, true);
  const done = logs.find(l => l.type === 'inventory_resync_done');
  assert.equal(done.via, 'reconnect');
  assert.ok(adapter._lastInventoryReconnectAt > 0, 'il timestamp arma il cooldown');
  assert.equal(logs.find(l => l.type === 'inventory_refresh').ok, false, 'il refresh mancato è visibile');
});

test('a second reconnect resync inside the cooldown is refused instead of hammering the server', async () => {
  const logs = [];
  const adapter = resyncAdapter({ logs, snapshot: false });

  await adapter._resyncByReconnect();
  const firstReconnects = adapter.calls.connect;
  await assert.rejects(() => adapter._resyncByReconnect(), /inventory_resync_throttled/);

  assert.equal(adapter.calls.connect, firstReconnects, 'il server non riceve una seconda sessione');
  const throttled = logs.find(l => l.type === 'inventory_resync_throttled');
  assert.ok(throttled, 'il rifiuto finisce nel log del run');
  assert.equal(throttled.cooldownMs, 30000);
  assert.ok(throttled.sinceLastMs >= 0);
});

test('a reconnect that fails reports the wedge instead of pretending the slots are fresh', async () => {
  const logs = [];
  const adapter = resyncAdapter({ logs, snapshot: false, connectError: 'connecterror:9' });

  await assert.rejects(() => adapter._resyncByReconnect(), /inventory_resync_wedged: connecterror:9/);

  const wedged = logs.find(l => l.type === 'inventory_resync_wedged');
  assert.equal(wedged.message, 'connecterror:9');
  assert.equal(wedged.connectError, 'connecterror:9');
});

test('a reconnect that resolves without spawn is a wedge, not a refresh', async () => {
  const logs = [];
  const adapter = resyncAdapter({ logs, snapshot: false, spawnOnConnect: false });

  await assert.rejects(() => adapter._resyncByReconnect(), /inventory_resync_wedged: no spawn/);
  assert.equal(adapter.spawned, false);
});

test('a resync never closes a container the running action has open', async () => {
  const logs = [];
  const adapter = resyncAdapter({ logs, snapshot: true });
  adapter._openContainer = { id: 5, type: 'container' };   // baule aperto
  adapter._openContainerBlock = { name: 'chest', position: { x: 91, y: 73, z: 160 } };

  await adapter._resyncByReconnect();

  assert.equal(adapter.calls.open, 0, 'il baule resta aperto: il refresh si salta');
  assert.deepEqual([adapter.calls.disconnect, adapter.calls.connect], [1, 1], 'e si usa la riconnessione');
  assert.equal(logs.find(l => l.type === 'inventory_refresh'), undefined, 'nessun refresh in-place tentato');
});

test('a resync while disconnected is still refused up front', async () => {
  const adapter = resyncAdapter({ logs: [], snapshot: true });
  adapter.spawned = false;
  adapter.client = null;
  await assert.rejects(() => adapter._resyncByReconnect(), /not_connected/);
});

test('a crafted item on the cursor is not dropped by a refresh in place', async () => {
  const adapter = resyncAdapter({ logs: [], snapshot: true });
  adapter._openContainer = { id: 'inventory', type: 'inventory' };
  adapter._cursor = { network_id: 50, count: 1, stack_id: 5 };
  await adapter._resyncByReconnect();
  assert.equal(adapter.calls.open, 0, 'col cursore pieno il refresh in-place si salta');
  assert.equal(adapter.calls.connect, 1);
});
