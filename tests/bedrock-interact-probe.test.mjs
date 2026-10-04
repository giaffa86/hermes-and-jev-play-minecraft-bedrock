import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { BedrockAdapter } from '../bedrock-adapter.mjs';
import { entityHeight } from '../bedrock-survival.mjs';

const require = createRequire(import.meta.url);
const { createSerializer } = require('bedrock-protocol/src/transforms/serializer');
const serializer = createSerializer('1.26.51');

// ---- fixture ------------------------------------------------------------------------

function spawnedAdapter () {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.client = new EventEmitter();
  adapter.client.entityId = 7n;
  adapter.client.write = () => {};
  adapter.position = { x: 0, y: 64.62, z: 0 };
  adapter._feet = { x: 0, y: 63, z: 0 };
  adapter._inWater = () => false;
  adapter._headInWater = () => false;
  adapter.entities.set('32', {
    runtimeId: '32',
    type: 'pig',
    kind: 'mob',
    position: { x: 1.5, y: 63, z: 0.5 },
    health: 10,
    seenAt: Date.now(),
  });
  return adapter;
}

function capture (adapter) {
  const packets = [];
  adapter.client.write = (name, params) => packets.push({ name, params });
  return packets;
}

function transactionOf (packets) {
  const write = packets.find(p => p.name === 'inventory_transaction');
  assert.ok(write, 'la sonda deve spedire una inventory_transaction');
  return write.params.transaction;
}

// ---- la sonda -----------------------------------------------------------------------

test('the none variant is the baseline: it sends no packet at all', async () => {
  const adapter = spawnedAdapter();
  const packets = capture(adapter);
  const report = await adapter.probeInteract({ type: 'pig', action: 'attack', variant: 'none', observeMs: 1 });
  assert.equal(report.ok, true);
  // La sonda guarda il bersaglio (come fa il client vanilla) ma non spedisce
  // nessuna transazione: l'unico pacchetto è il frame con la rotazione.
  assert.deepEqual(packets.map(p => p.name), ['player_auth_input']);
  assert.deepEqual(report.rxNames, {});
  assert.deepEqual(report.sequence, ['player_auth_input (yaw/pitch sul bersaglio)', 'niente (misura di riferimento)']);
});

test('every probe variant sends a serializable entity transaction', async () => {
  for (const variant of BedrockAdapter.PROBE_VARIANTS) {
    if (variant === 'none') continue;   // coperto dal test della misura di riferimento
    const adapter = spawnedAdapter();
    const packets = capture(adapter);
    const report = await adapter.probeInteract({ type: 'pig', action: 'attack', variant, observeMs: 1 });
    assert.equal(report.ok, true, `variante ${variant}: ${report.error ?? ''}`);
    assert.equal(report.variant, variant);
    assert.equal(report.distance > 0, true);
    for (const packet of packets) {
      assert.doesNotThrow(() => serializer.createPacketBuffer({ name: packet.name, params: packet.params }),
        `serialize ${packet.name} (${variant})`);
    }
    const transaction = transactionOf(packets);
    assert.equal(transaction.transaction_data.action_type, 'attack');
    assert.equal(transaction.transaction_data.entity_runtime_id, 32n);
  }
});test('the candidate shapes differ where the live failure could hide', () => {
  const adapter = spawnedAdapter();
  const entity = adapter.entities.get('32');
  const current = adapter._entityTransactionPayload(entity, 'interact', 'current').payload;
  assert.equal(current.transaction_type, 'item_use_on_entity');
  assert.deepEqual(current.legacy, { legacy_request_id: 0 });
  assert.deepEqual(current.actions, []);
  assert.equal(current.transaction_data.hotbar_slot, adapter.selectedHotbar);
  assert.equal(current.transaction_data.click_pos.y, 63 + entityHeight('pig') * 0.5);

  const noLegacy = adapter._entityTransactionPayload(entity, 'interact', 'legacy_empty_list').payload;
  assert.deepEqual(noLegacy.legacy, { legacy_request_id: 0, legacy_transactions: [] });

  const minusOne = adapter._entityTransactionPayload(entity, 'interact', 'legacy_minus1').payload;
  assert.equal(minusOne.legacy.legacy_request_id, -1);

  const numeric = adapter._entityTransactionPayload(entity, 'interact', 'numeric_type').payload;
  assert.equal(numeric.transaction_type, 3);

  // Il client vanilla manda la posizione degli occhi, non i piedi.
  const eyes = adapter._entityTransactionPayload(entity, 'interact', 'eyes').payload;
  assert.equal(eyes.transaction_data.player_pos.y, 64.62 + 1.62);
  assert.equal(current.transaction_data.player_pos.y, 64.62);
});

test('the mouse_over variant declares the watched entity before the transaction', async () => {
  const adapter = spawnedAdapter();
  const packets = capture(adapter);

  const report = await adapter.probeInteract({ runtimeId: '32', variant: 'mouse_over', observeMs: 1 });

  assert.equal(report.ok, true);
  const names = packets.map(p => p.name);
  assert.deepEqual(names.filter(n => n === 'interact' || n === 'inventory_transaction'),
    ['interact', 'inventory_transaction'], 'il mirino precede la transazione');
  const hover = packets.find(p => p.name === 'interact');
  assert.equal(hover.params.action_id, 'mouse_over_entity');
  assert.equal(hover.params.target_entity_id, 32n);
  assert.ok(report.sequence.some(line => line.includes('mouse_over_entity')));
  for (const packet of packets) {
    assert.doesNotThrow(() => serializer.createPacketBuffer({ name: packet.name, params: packet.params }),
      `serialize ${packet.name}`);
  }
});

test('the probe reports the refusal signal (inventory resync) and typed errors', async () => {
  // Il resync è il segnale con cui il server rifiuta: la sonda lo conta per
  // differenza, quindi ogni variante è confrontabile sullo stesso numero.
  const adapter = spawnedAdapter();
  adapter.client.write = (name) => { if (name === 'inventory_transaction') adapter._invResyncCount += 1; };
  const refused = await adapter.probeInteract({ type: 'pig', action: 'attack', observeMs: 1 });
  assert.equal(refused.ok, true);
  assert.equal(refused.resyncs, 1);
  assert.equal(refused.healthBefore, 10);
  assert.equal(refused.healthAfter, 10);
  assert.equal(refused.damage, 0);

  const unknown = await adapter.probeInteract({ variant: 'nope' });  assert.deepEqual([unknown.ok, unknown.error], [false, 'unknown_variant']);
  assert.deepEqual(unknown.variants, BedrockAdapter.PROBE_VARIANTS);

  const missing = await adapter.probeInteract({ type: 'cow' });
  assert.deepEqual([missing.ok, missing.error], [false, 'no_entity']);
});

test('flag_before and flag_after raise item_interact in the auth frame', async () => {
  for (const variant of ['flag_before', 'flag_after']) {
    const adapter = spawnedAdapter();
    const packets = capture(adapter);
    await adapter.probeInteract({ type: 'pig', action: 'attack', variant, observeMs: 1 });
    const frames = packets.filter(p => p.name === 'player_auth_input');
    const flagged = frames.find(f => f.params.input_data.includes('item_interact'));
    assert.ok(flagged, `${variant}: un frame player_auth_input deve alzare item_interact`);
    const transaction = transactionOf(packets);
    assert.equal(transaction.transaction_data.action_type, 'attack', `${variant}: la transazione deve restare quella dell'azione`);
  }

  const adapter = spawnedAdapter();
  const packets = capture(adapter);
  adapter._sendAuthInput({ yaw: 0, pitch: 0 });
  assert.equal(packets[0].params.input_data.includes('item_interact'), false);
  adapter._sendAuthInput({ yaw: 0, pitch: 0, itemInteract: true });
  assert.equal(packets[1].params.input_data.includes('item_interact'), true);
});
