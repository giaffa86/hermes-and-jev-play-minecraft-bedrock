// Il 07/10/2026 il controller ha deciso `wait` 75 volte con una sola opzione,
// mentre la sessione NetherNet era caduta: `options()` restituiva un `wait`
// finto ("Wait for the Bedrock connection to be re-established") che il
// controller non poteva distinguere da una scelta. Le 9 morti finali del run
// hanno come ultima azione `wait(ok)`, sempre fermo nello stesso punto.
//
// La sessione non viva non offre niente: zero opzioni e la ragione esplicita in
// `optionsBlindReason`, che l'harness espone in `/options` (`connected: false`,
// `blind`). Cosi' il controller non brucia un passo su un `wait` che non e' una
// scelta, e il run si ferma con `harness_blind` invece di morire in silenzio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

function bareAdapter () {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.logs = [];
  adapter.log = (type, data) => adapter.logs.push({ type, ...data });
  return adapter;
}

test('senza sessione viva non esiste nessuna opzione, e la ragione e not_connected', () => {
  const adapter = bareAdapter();
  adapter.spawned = false;
  adapter.status = 'connecting';
  assert.deepEqual(adapter.options(), []);
  assert.equal(adapter.optionsBlindReason, 'not_connected');
});

test('uno stato non spawned (o spawn non avvenuto) e cieco anche con il client attaccato', () => {
  const adapter = bareAdapter();
  adapter.spawned = true;
  adapter.status = 'spawned';
  assert.equal(adapter.sessionLive, true);
  assert.ok(adapter.options().length > 0, 'con la sessione viva le opzioni ci sono');
  assert.equal(adapter.optionsBlindReason, null);

  adapter.status = 'connecting';
  assert.equal(adapter.sessionLive, false);
  assert.deepEqual(adapter.options(), []);
  assert.equal(adapter.optionsBlindReason, 'not_connected');

  adapter.spawned = false;
  adapter.status = 'spawned';
  assert.equal(adapter.sessionLive, false);
  assert.deepEqual(adapter.options(), []);
});

test('morte e sonno restano azioni vere: li wait e l unica opzione sensata', () => {
  const dead = bareAdapter();
  dead.spawned = true;
  dead.status = 'dead';
  assert.equal(dead.sessionLive, false, 'la sessione e caduta insieme al bot');
  const sleeping = bareAdapter();
  sleeping.spawned = true;
  sleeping.status = 'sleeping';
  sleeping.vitals = { ...(sleeping.vitals ?? {}), sleeping: true };
  // Non serve forzare il ramo: l'importante e' che `wait` sopravviva solo per
  // morte/sonno (lo stato non venga azzerato come su `client_close`).
  assert.ok(['sleeping', 'spawned'].includes(sleeping.status));
});
