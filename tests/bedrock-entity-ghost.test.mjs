// Un runtime id e' valido solo per la sessione che lo ha assegnato. Due strade
// lo lasciavano in mappa dopo che il server non lo conosceva piu': un login
// nuovo (`_onStartGame` azzerava inventario e pickup ma non il censimento
// entita') e un `add_entity` con lo stesso `unique_id` e un id nuovo. Il
// risultato era un fantasma che il censimento leggeva come mob vivo: live
// demo-r2 del 06/10 lo scheletro in casa e' stato attaccato 25 volte sul suo
// runtime id vecchio (`50`) mentre l'`entity_add` diceva `508`, con la vita del
// bersaglio ferma a 12 (`attack_skeleton` → `{ok:false,
// error:'died_in_combat', hits:25}`) — e venticinque colpi di spada di ferro
// non hanno scalfito nessuno.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

function ghostAdapter ({ logs = [] } = {}) {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.client = new EventEmitter();
  adapter.client.entityId = 7n;
  adapter.client.write = () => {};
  adapter.position = { x: 0, y: 64.62, z: 0 };
  adapter._feet = { x: 0, y: 63, z: 0 };
  adapter.inventorySlots = [];
  adapter.selectedHotbar = 0;
  adapter.log = (type, data) => logs.push({ type, ...(data || {}) });
  return adapter;
}

const skeleton = (runtimeId, x, health = 12) => ({
  runtime_id: BigInt(runtimeId),
  unique_id: 900n,
  entity_type: 'minecraft:skeleton',
  position: { x, y: 63, z: 0 },
  attributes: [{ name: 'minecraft:health', current: health }],
});

test('a re-add under a new runtime id does not leave a ghost', () => {
  const logs = [];
  const adapter = ghostAdapter({ logs });
  adapter._trackEntity(skeleton(50, 1), 'mob');
  adapter._trackEntity(skeleton(508, 3), 'mob');

  assert.equal(adapter.entities.has('50'), false, 'il runtime id vecchio non esiste piu\' lato server');
  assert.equal(adapter.entities.size, 1);
  assert.equal(adapter._entitiesByUnique.get('900'), '508');
  assert.equal(adapter._entityOfType('skeleton').runtimeId, '508');
  assert.equal(adapter._hostiles().length, 1, 'un solo scheletro nel censimento, non due');
  const readded = logs.find(l => l.type === 'entity_readded');
  assert.deepEqual([readded.from, readded.to, readded.uniqueId], ['50', '508', '900']);
});

test('a fresh login clears the entity census', () => {
  const adapter = ghostAdapter();
  adapter._trackEntity(skeleton(50, 1), 'mob');
  adapter._playersByName.set('somebody', '50');
  adapter.world.start = () => {};

  adapter._onStartGame({ player_position: { x: 10, y: 70.62, z: 10 }, dimension: 'overworld', current_tick: 5 });

  assert.equal(adapter.entities.size, 0);
  assert.equal(adapter._entitiesByUnique.size, 0);
  assert.equal(adapter._playersByName.size, 0);
  assert.deepEqual(adapter.position, { x: 10, y: 70.62, z: 10 });
});

test('combat re-locks the target when the hits do not move its health', async () => {
  const logs = [];
  const adapter = ghostAdapter({ logs });
  const ghost = { runtimeId: '50', type: 'skeleton', kind: 'mob', position: { x: 1, y: 63, z: 0 }, health: 12, lastAt: Date.now() };
  const real = { runtimeId: '508', type: 'skeleton', kind: 'mob', position: { x: 1.5, y: 63, z: 0 }, health: 12, lastAt: Date.now() };
  adapter.entities.set('50', ghost);
  adapter.entities.set('508', real);
  let resolutions = 0;
  adapter._entityOfType = () => (resolutions++ === 0 ? ghost : real);
  adapter._selectWeapon = async () => 'iron_sword';
  adapter._lookAt = () => ({ yaw: 0, pitch: 0 });
  adapter._queueAuthInput = async () => {};
  let attacks = 0;
  adapter._attackEntity = entity => {
    attacks++;
    if (String(entity.runtimeId) === '508') real.health = 0;
    return true;
  };

  const result = await adapter._combat('skeleton', 15000);

  assert.equal(attacks, 5, 'quattro colpi sul fantasma, il quinto sul bersaglio vero');
  const silent = logs.find(l => l.type === 'attack_no_damage');
  assert.ok(silent, 'il colpo senza danno e\' registrato');
  assert.equal(silent.runtimeId, '50');
  assert.equal(silent.reappeared, '508');
  assert.equal(silent.health, 12);
  assert.equal(result.ok, true);
  assert.equal(result.confirmedBy, 'health');
});
