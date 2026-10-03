// Il lock `busy` di `executeAction`: un'azione che non ritorna (la morte del bot
// a metà di una lettura di contenitori lascia l'attesa appesa) non deve rendere
// l'API inutilizzabile. Finding live 03/10/2026.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

function lockAdapter () {
  const logs = [];
  // Gli eventi si leggono da `onLog` (la firma di `logger.log` è `(messaggio, data)`).
  const adapter = new BedrockAdapter({ logger: { log () {}, warn () {} }, onLog: entry => logs.push(entry) });
  adapter.client = {};
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.position = { x: 10, y: 70, z: 10 };
  return { adapter, logs };
}

test('an action that never settles releases the lock with a typed timeout', async () => {
  process.env.HARNESS_ACTION_TIMEOUT_MS = '60';
  const { adapter, logs } = lockAdapter();
  adapter._runAction = () => new Promise(() => {});
  const result = await adapter.executeAction('read_container');
  assert.deepEqual([result.ok, result.error, result.action, result.timeoutMs], [false, 'action_timeout', 'read_container', 60]);
  assert.equal(adapter.busy, false, 'il lock è stato liberato');
  assert.equal(logs.filter(l => l.type === 'action_timeout').length, 1);
  // L'azione zombie non blocca la successiva: il secondo tentativo entra.
  adapter._runAction = async () => ({ ok: true, read: 1 });
  assert.deepEqual(await adapter.executeAction('read_container'), { ok: true, read: 1 });
  assert.equal(adapter.busy, false);
  delete process.env.HARNESS_ACTION_TIMEOUT_MS;
});

test('a normal action settles through the watchdog without noise', async () => {
  process.env.HARNESS_ACTION_TIMEOUT_MS = '500';
  const { adapter, logs } = lockAdapter();
  adapter._runAction = async key => ({ ok: true, action: key });
  assert.deepEqual(await adapter.executeAction('wait'), { ok: true, action: 'wait' });
  assert.equal(logs.filter(l => l.type === 'action_timeout').length, 0);
  assert.equal(logs.filter(l => l.type === 'action').length, 1, 'un solo evento action');
  // Un errore del corpo diventa un errore tipizzato, senza timeout.
  adapter._runAction = async () => { throw new Error('movement timeout'); };
  assert.deepEqual(await adapter.executeAction('read_container'), { ok: false, error: 'movement timeout' });
  assert.equal(adapter.busy, false);
  delete process.env.HARNESS_ACTION_TIMEOUT_MS;
});

test('actions whose precondition is missing answer with a typed reason, not "unknown"', async () => {
  const { adapter } = lockAdapter();
  const ride = await adapter.executeAction('ride');
  assert.deepEqual([ride.ok, ride.error], [false, 'not_riding'], 'da smontati `ride` dice perché');
  adapter.riding = { riddenEntityId: '7', at: Date.now() };
  assert.equal((await adapter.executeAction('ride')).error, 'no_ride_destination', 'da montati manca solo la destinazione');
  assert.equal((await adapter.executeAction('follow_player')).error, 'no_player_target');
  assert.equal((await adapter.executeAction('teleport_home')).error, 'unknown_action', 'le chiavi davvero inesistenti restano unknown_action');
});
