import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

// Movimento e disconnessione.
//
// `_updateMotionState` gira solo sui tick del client (`_authTick`, un intervallo
// attivo solo con client connesso e spawn avvenuto). Se la connessione cade a
// meta' di un movimento, la promise di `_startMotion` non veniva mai risolta:
// `_moveTo` restava appeso, l'azione teneva il lock dell'harness fino
// all'`action_timeout` di 180 s e il bot sembrava immobile. Osservato live il
// 04/10: `[client_close] { reason: 'disconnected' }` a meta' di `follow_player`
// alle 19:58:26, azione chiusa alle 20:00:49 con `action_timeout`.
//
// Qui si verificano le quattro difese: timer di sicurezza sulla promise del
// movimento, abort sul close, guardia di connessione nel loop di `_moveTo` e
// conteggio vero dei fallimenti consecutivi in `_followPlayer`.

function bareAdapter () {
  const adapter = new BedrockAdapter({ logger: { log () {} }, onLog: () => {} });
  adapter.position = { x: 0, y: 64, z: 0 };
  adapter._feet = { x: 0, y: 64, z: 0 };
  adapter._yawTo = () => 0;
  adapter._maybeRememberDiscoveries = () => {};
  return adapter;
}

function startMotion (adapter, timeoutMs) {
  return adapter._startMotion([{ x: 0, y: 64, z: 0 }], { x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 0 }, 0.5, Date.now() + timeoutMs);
}

test('un movimento senza tick scade da solo entro la deadline', async () => {
  const adapter = bareAdapter();
  const started = Date.now();
  const outcome = await startMotion(adapter, 100);
  assert.equal(outcome, 'timeout', 'il timer di sicurezza deve chiudere la promise anche senza tick');
  assert.ok(Date.now() - started < 2000, 'la chiusura deve arrivare subito dopo la deadline');
  assert.equal(adapter._motion.guard, null, 'il timer va spento quando il movimento si chiude');
});

test('il close del client abortisce il movimento in corso', async () => {
  const adapter = bareAdapter();
  const motion = startMotion(adapter, 60000);
  adapter._finishMotion('disconnected'); // quello che fa il gestore di `close`
  assert.equal(await motion, 'disconnected');
  assert.equal(adapter._motion.active, false);
});

test("_moveTo non aspetta tick quando il client e' andato", async () => {
  const adapter = bareAdapter();
  adapter._authTickInterval = setInterval(() => {}, 1000); // come dopo lo spawn
  adapter.spawned = false;
  adapter.client = null;
  const started = Date.now();
  await assert.rejects(
    () => adapter._moveTo({ x: 4, y: 64, z: 0 }, 1.5, 30000),
    /connection_lost/,
    'senza client il movimento deve fallire subito, non aspettare la deadline'
  );
  assert.ok(Date.now() - started < 1000);
  clearInterval(adapter._authTickInterval);
});

test('follow_player si chiude subito se il movimento perde la connessione', async () => {
  const adapter = bareAdapter();
  adapter._playerByName = () => ({ username: 'Human', position: { x: 20, y: 64, z: 0 } });
  adapter._moveTo = async () => { throw new Error('connection_lost'); };
  const started = Date.now();
  const result = await adapter._followPlayer('Human');
  assert.equal(result.ok, false);
  assert.match(String(result.error), /connection_lost/);
  assert.equal(result.target, 'Human');
  assert.ok(Date.now() - started < 1000, 'quattro fallimenti consecutivi bastano: niente attesa di 45 s');
});

test('un movimento sovrascritto viene chiuso invece di restare appeso', async () => {
  const adapter = bareAdapter();
  const stale = startMotion(adapter, 60000);
  const fresh = startMotion(adapter, 60000);
  assert.equal(await stale, 'superseded', 'il movimento precedente non deve restare pendente per sempre');
  adapter._finishMotion('goal');
  assert.equal(await fresh, 'goal', 'il movimento nuovo resta pilotato dai tick');
});
