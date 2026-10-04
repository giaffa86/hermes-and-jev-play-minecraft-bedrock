import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

// Patch 13 — la quota del server non deve tenere il bot sospeso in aria.
// Live 04/10: il server teneva il bot a 77.62 (piedi 76) sopra un prato con la
// superficie a 72. Ogni correzione rimetteva i piedi a 76, la fisica locale lo
// faceva cadere e la correzione successiva lo rialzava: pendolo infinito, bot
// "bloccato" e, dentro la cella del letto, ogni `sleep` respinto.

function spawnedAdapter (feet) {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.client = { entityId: 7n, write () {}, queue () {} };
  adapter.position = { x: feet.x, y: feet.y + 1.62, z: feet.z };
  adapter._feet = { ...feet };
  adapter._velocity = { x: 0, y: 0, z: 0 };
  return adapter;
}

function block (name, boundingBox) {
  return { name, boundingBox };
}

// Mondo finto: `solid` è l'insieme delle celle solide, il resto è aria.
function stubWorld (adapter, solid) {
  const key = (x, y, z) => `${x},${y},${z}`;
  adapter.world.blockAt = ({ x, y, z }) => (solid.has(key(x, y, z)) ? block('oak_planks', 'block') : block('air', 'empty'));
}

test('serverFeetY: quota sospesa in aria rifiutata, il bot continua a cadere', () => {
  const adapter = spawnedAdapter({ x: 113.5, y: 74.8, z: 191.5 });
  stubWorld(adapter, new Set(['113,71,191'])); // prato con la superficie a 72
  assert.equal(adapter._serverFeetY({ x: 113.5, y: 77.62, z: 191.5 }), null, 'i piedi a 76 non hanno appoggio');
  assert.equal(adapter._serverFeetY({ x: 113.5, y: 73.62, z: 191.5 }), 72, 'la quota con appoggio (cella 71) è accettata');
});

test('serverFeetY: il pavimento sotto i piedi rende la quota accettabile', () => {
  const adapter = spawnedAdapter({ x: 0.5, y: 62.29, z: 0.5 });
  stubWorld(adapter, new Set(['0,62,0']));
  assert.equal(adapter._serverFeetY({ x: 0.5, y: 63.91, z: 0.5 }), 63, 'la cella 62 è piena: la quota valida è 63');
  assert.equal(adapter._serverFeetY({ x: 0.5, y: 64.62, z: 0.5 }).toFixed(2), '63.00', 'in piedi sul bordo: la cella 63 è vuota');
});

test('serverFeetY: teletrasporto e spinta verso il basso passano sempre', () => {
  const adapter = spawnedAdapter({ x: 0.5, y: 74, z: 0.5 });
  stubWorld(adapter, new Set());
  assert.equal(adapter._serverFeetY({ x: 0.5, y: 60, z: 0.5 }), 58.38, 'salto di oltre 3 blocchi: è un teletrasporto');
  const falling = spawnedAdapter({ x: 0.5, y: 80, z: 0.5 });
  stubWorld(falling, new Set());
  assert.equal(falling._serverFeetY({ x: 0.5, y: 75, z: 0.5 }), 73.38, 'il server che tira giù non viene mai rifiutato');
});

test('un mondo non caricato non fa rifiutare la quota del server', () => {
  const adapter = spawnedAdapter({ x: 0.5, y: 70, z: 0.5 });
  adapter.world.blockAt = () => block('unknown', undefined);
  assert.equal(adapter._serverFeetY({ x: 0.5, y: 77.62, z: 0.5 }), 76, 'senza dati la quota del server è l’unica verità');
});

test('dopo la correzione rifiutata la fisica locale porta i piedi a terra', () => {
  const adapter = spawnedAdapter({ x: 113.5, y: 74.8, z: 191.5 });
  stubWorld(adapter, new Set(['113,71,191']));
  const accepted = adapter._serverFeetY({ x: 113.5, y: 77.62, z: 191.5 });
  if (accepted != null) adapter._feet.y = accepted;
  adapter._onGround = true;
  for (let i = 0; i < 200 && adapter._feet.y > 72.001; i++) {
    adapter._velocity.y += -0.08;
    adapter._moveVertical(adapter._velocity.y * 0.05);
  }
  assert.equal(+adapter._feet.y.toFixed(2), 72, 'i piedi si appoggiano sul prato');
});
