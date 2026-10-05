import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

// Patch 12 — il sonno vero.
// Live 04/10: il bot cliccava il letto da DENTRO la sua cella, i piedi finivano
// infilati nel pavimento (la quota del server è quella degli occhi, ma a letto è
// più bassa di EYE_HEIGHT) e da lì la previsione locale blocca ogni passo: bot
// congelato, `goto_waypoint` -> `stuck`, `sleep` respinto per sempre. Inoltre il
// solo click sul letto non basta: un client vero manda anche `player_action
// start_sleeping`, ed è quello che fa attecchire il sonno.

function spawnedAdapter () {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.client = new EventEmitter();
  adapter.client.entityId = 7n;
  adapter.writes = [];
  adapter.client.write = (name, payload) => { adapter.writes.push({ name, payload }); };
  adapter.position = { x: 0, y: 64.62, z: 0 };
  adapter._feet = { x: 0, y: 63, z: 0 };
  return adapter;
}

function block (name, boundingBox = 'block') {
  return { name, boundingBox };
}

// Mondo finto: `solid` è l'insieme delle celle solide, tutto il resto è aria.
function stubWorld (adapter, solid) {
  const key = (x, y, z) => `${x},${y},${z}`;
  adapter.world.blockAt = ({ x, y, z }) => (solid.has(key(x, y, z)) ? block('oak_planks') : block('air', 'empty'));
}

test('feetFromServerY: i piedi non restano infilati nel blocco del pavimento', () => {
  const adapter = spawnedAdapter();
  // Bot in piedi sul pavimento a y=62: piedi a 63.0, cella libera.
  stubWorld(adapter, new Set(['0,62,0']));
  assert.equal(adapter._feetFromServerY({ x: 0.5, y: 64.62, z: 0.5 }).toFixed(2), '63.00');

  // Quota "da letto": 63.91 - 1.62 = 62.29, cioè dentro il blocco del pavimento.
  assert.equal(adapter._feetFromServerY({ x: 0.5, y: 63.91, z: 0.5 }), 63, 'la quota valida è il bordo superiore del blocco');
  // E un mondo non caricato non tocca la quota del server.
  const blind = spawnedAdapter();
  blind.world.blockAt = () => block('unknown', undefined);
  assert.equal(blind._feetFromServerY({ x: 0.5, y: 63.91, z: 0.5 }), 62.29);
});

test('syncFeetFromPosition usa la quota verificata', () => {
  const adapter = spawnedAdapter();
  stubWorld(adapter, new Set(['0,62,0']));
  adapter._syncFeetFromPosition({ x: 0.5, y: 63.91, z: 0.5 });
  assert.equal(adapter._feet.y, 63);
});

test('bedStandSpot: punto di sosta fuori dal footprint del letto', () => {
  const adapter = spawnedAdapter();
  adapter._feet = { x: 3.5, y: 63, z: 0.5 };
  const solid = new Set(['2,62,0', '3,62,0', '4,62,0', '2,62,1', '3,62,1', '4,62,1']);
  stubWorld(adapter, solid);
  const spot = adapter._bedStandSpot({ position: { x: 2, y: 63, z: 0 } });
  assert.ok(spot, 'un punto di sosta esiste');
  const center = { x: 2.5, z: 0.5 };
  const horizontal = Math.hypot(spot.x - center.x, spot.z - center.z);
  assert.ok(horizontal >= 1 && horizontal < 2.1, `sosta fuori dal letto e nel raggio d'uso (${horizontal.toFixed(2)})`);
  assert.equal(Math.floor(spot.y), 63, 'sosta alla quota del letto');
});

test('sleepInBed chiede il sonno con player_action start_sleeping', async () => {
  const adapter = spawnedAdapter();
  adapter._recordTime(18000);
  adapter._bedCache = null;
  adapter.world.findBlocks = () => [{ name: 'bed', position: { x: 0, y: 63, z: 2 }, distance: 2, getProperties: () => ({ occupied_bit: false }) }];
  stubWorld(adapter, new Set(['0,62,2', '1,62,2']));
  adapter._queueAuthInput = async () => { adapter._recordTime(200); }; // il server salta la notte
  const result = await adapter._sleepInBed({ confirmMs: 200 });
  assert.equal(result.ok, true);
  assert.equal(result.slept, 'night_skipped');
  const actions = adapter.writes.filter(entry => entry.name === 'player_action');
  assert.equal(actions.length, 1, 'una sola richiesta di sonno, nessuna ripetizione');
  assert.equal(actions[0].payload.action, 'start_sleeping');
  assert.deepEqual(actions[0].payload.position, { x: 0, y: 63, z: 2 });
});

test('sleepInBed esce dal letto quando il server non accetta', async () => {
  const adapter = spawnedAdapter();
  adapter._recordTime(18000);
  adapter._bedCache = null;
  adapter.world.findBlocks = () => [{ name: 'bed', position: { x: 0, y: 63, z: 2 }, distance: 2, getProperties: () => ({ occupied_bit: false }) }];
  stubWorld(adapter, new Set(['0,62,2', '1,62,2']));
  adapter._queueAuthInput = async () => {};
  const result = await adapter._sleepInBed({ confirmMs: 50 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'sleep_rejected');
  const actions = adapter.writes.map(entry => entry.payload?.action).filter(Boolean);
  assert.deepEqual(actions, ['start_sleeping', 'stop_sleeping'], 'chiude lo stato ibrido del server');
});
