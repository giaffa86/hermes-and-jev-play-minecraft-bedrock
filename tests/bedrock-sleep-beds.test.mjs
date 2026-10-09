import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

// Patch 9 — più letti per il sonno e soglia d'uso reale.
// Live 04/10: `_findBed()` prendeva found[0], `_sleepInBed` aveva 25 s e cliccava
// fino a 4,5 blocchi; il server ignora il click oltre il raggio d'uso, quindi il
// bot restava in `sleep_rejected` a 4,3 blocchi dal letto e la notte non passava.

function spawnedAdapter () {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.client = new EventEmitter();
  adapter.client.entityId = 7n;
  adapter.client.write = () => {};
  adapter.position = { x: 0, y: 64.62, z: 0 };
  adapter._feet = { x: 0, y: 63, z: 0 };
  return adapter;
}

function bed (position, distance, occupied = false) {
  return {
    name: 'bed',
    position,
    distance,
    getProperties: () => ({ occupied_bit: occupied, head_piece_bit: false }),
  };
}

function stubBeds (adapter, beds) {
  adapter._bedCache = null;
  adapter.world.findBlocks = (name) => (name === 'bed' ? beds : []);
  adapter.world.blockAt = ({ x, y, z }) => {
    const found = beds.find(b => b.position.x === x && b.position.y === y && b.position.z === z);
    if (found) return { ...found, boundingBox: 'empty', shapes: [[0, 0, 0, 1, 0.5625, 1]] };
    return y === 62 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' };
  };
}

test('findBeds lists every bed, free ones first and then by distance', () => {
  const adapter = spawnedAdapter();
  stubBeds(adapter, [
    bed({ x: 0, y: 63, z: 4 }, 4, true),   // occupato e vicino
    bed({ x: 0, y: 63, z: 9 }, 9, false),
    bed({ x: 0, y: 63, z: 6 }, 6, false),
  ]);
  const beds = adapter._findBeds();
  assert.equal(beds.length, 3);
  assert.deepEqual(beds.map(candidate => candidate.distance), [6, 9, 4]);
  assert.deepEqual(beds.map(candidate => candidate.occupied), [false, false, true]);
  assert.equal(adapter._findBed().distance, 6, 'il letto libero batte quello occupato più vicino');
  assert.deepEqual(adapter._bedCache.bed.position, { x: 0, y: 63, z: 6 }, 'la cache tiene un letto per _wake()');
});

test('findBeds dedupes the two halves of the same bed and tolerates blocks without states', () => {
  const adapter = spawnedAdapter();
  stubBeds(adapter, [
    bed({ x: 2, y: 63, z: 2 }, 3, false),
    bed({ x: 2, y: 63, z: 2 }, 3.2, true), // metà duplicata
    { name: 'bed', position: { x: 4, y: 63, z: 4 }, distance: 5 }, // senza getProperties()
  ]);
  const beds = adapter._findBeds();
  assert.equal(beds.length, 2);
  assert.equal(beds[0].occupied, false);
  assert.equal(beds[1].occupied, false, 'un blocco senza stati non è occupato');
});

test('sleepInBed falls back to the next bed when the free one cannot be reached', async () => {
  const adapter = spawnedAdapter();
  adapter._recordTime(18000);
  stubBeds(adapter, [
    bed({ x: 0, y: 63, z: 2 }, 2, true),   // vicino ma occupato
    bed({ x: 0, y: 63, z: 20 }, 20, false), // libero ma irraggiungibile: _moveTo scade
  ]);
  let moves = 0;
  adapter._moveTo = async () => { moves++; throw new Error('movement timeout'); };
  let inputs = 0;
  adapter._queueAuthInput = async () => {
    inputs++;
    if (inputs >= 2) adapter._recordTime(200); // il server salta la notte al click
  };
  const result = await adapter._sleepInBed({ confirmMs: 300 });
  assert.equal(result.ok, true);
  assert.equal(result.slept, 'night_skipped');
  assert.deepEqual(result.bed, { x: 0, y: 63, z: 2 }, 'ripiega sul letto occupato ma vicino');
  // 08/10/2026: un letto non si dichiara irraggiungibile dopo **una** cella di
  // appoggio fallita. Il conteggio resta esatto: le celle del solo letto libero.
  const freeSpots = adapter._bedStandSpots({ position: { x: 0, y: 63, z: 20 } }).length;
  assert.equal(moves, Math.min(4, freeSpots), 'ha tentato l\'avvicinamento solo per il letto libero e lontano, una cella per volta');
  assert.equal(result.tried.length, 2, 'tiene traccia del candidato fallito e di quello riuscito');
  assert.equal(result.tried[0].error, 'bed_unreachable');
  assert.equal(result.tried[0].distance > 3.2, true, 'la distanza fallita è riportata');
});

test('sleepInBed tries a second approach when the bot is out of the use range', async () => {
  const adapter = spawnedAdapter();
  adapter._recordTime(18000);
  stubBeds(adapter, [bed({ x: 0, y: 63, z: 4 }, 4.7, false)]);
  let moves = 0;
  adapter._moveTo = async () => {
    moves++;
    adapter.position = { x: 0.5, y: 64.62, z: 3.5 }; // il bot si avvicina al letto
    return { ok: true };
  };
  let inputs = 0;
  adapter._queueAuthInput = async () => {
    inputs++;
    if (inputs >= 2) adapter._recordTime(200);
  };
  const result = await adapter._sleepInBed({ confirmMs: 300 });
  assert.equal(moves, 1, 'a 4,7 blocchi l\'avvicinamento serve');
  assert.equal(result.ok, true);
  assert.equal(result.slept, 'night_skipped');
});

test('sleepInBed reports every failed candidate when no bed is reachable', async () => {
  const adapter = spawnedAdapter();
  adapter._recordTime(18000);
  stubBeds(adapter, [
    bed({ x: 0, y: 63, z: 20 }, 20, false),
    bed({ x: 0, y: 63, z: 26 }, 26, false),
  ]);
  adapter._moveTo = async () => { throw new Error('movement timeout'); };
  adapter._queueAuthInput = async () => {};
  const result = await adapter._sleepInBed({ confirmMs: 10 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'bed_unreachable');
  assert.equal(result.tried.length, 2);
  assert.ok(result.tried.every(entry => entry.error === 'bed_unreachable'));
});

test('sleepInBed reports the click distance when the server does not start the sleep', async () => {
  const adapter = spawnedAdapter();
  adapter._recordTime(18000);
  stubBeds(adapter, [bed({ x: 0, y: 63, z: 2 }, 2.8, false)]);
  adapter._queueAuthInput = async () => {};
  const result = await adapter._sleepInBed({ confirmMs: 10 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'sleep_rejected');
  assert.equal(typeof result.distance, 'number');
  assert.equal(result.distance < 3.2, true);
});
