// Redstone (R0 di docs/wiki/redstone.md) nell'adapter: censimento dei componenti
// vicini con lo stato letto, cache con TTL, lettura delle proprietà di una cella.
// Mondo finto, nessun socket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

const props = (values) => ({ getProperties: () => values });

// Mondo finto: le celle passate esplicitamente, un `findBlocks` che accetta sia
// un nome sia un array di nomi (come il mondo vero dopo R0) e conta le chiamate.
function redstoneAdapter (cells = {}, { loaded = 1, feet = { x: 0.5, y: 71, z: 0.5 } } = {}) {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter._feet = { ...feet };
  adapter.position = { x: feet.x, y: feet.y + 1.62, z: feet.z };
  adapter.nearbyBlocks = {};
  adapter.world.loaded = new Map(Array.from({ length: loaded }, (_, i) => [`${i},0`, {}]));
  const blocks = new Map(Object.entries(cells));
  adapter.world.blockAt = ({ x, y, z }) => blocks.get(`${x},${y},${z}`) ?? null;
  const calls = [];
  adapter.world.findBlocks = (names, position, radius = 32, count = 256) => {
    calls.push({ names, radius, count });
    // Nessuna colonna caricata ⇒ nessun blocco: come il mondo vero.
    if (adapter.world.loaded?.size === 0) return [];
    const wanted = new Set(Array.isArray(names) ? names : [names]);
    const out = [];
    for (const [key, block] of blocks) {
      if (!wanted.has(block?.name)) continue;
      const [x, y, z] = key.split(',').map(Number);
      const distance = Math.hypot(x - position.x, y - position.y, z - position.z);
      if (distance > radius) continue;
      out.push({ ...block, position: { x, y, z }, distance });
      if (out.length >= count) break;
    }
    return out;
  };
  return { adapter, blocks, calls };
}

test('_redstoneView elenca componenti, minerali e TNT con potenza e distanza', () => {
  const { adapter, calls } = redstoneAdapter({
    '2,71,0': { name: 'lever', ...props({ open_bit: true, lever_direction: 'north' }) },
    '4,71,0': { name: 'unpowered_repeater', ...props({ 'minecraft:cardinal_direction': 'east' }) },
    '6,71,0': { name: 'redstone_ore' },
    '8,71,0': { name: 'tnt' },
    '1,71,0': { name: 'stone' },
  });
  const view = adapter._redstoneView();
  assert.equal(view.components.length, 2);
  assert.deepEqual(view.components.map(c => c.name), ['lever', 'unpowered_repeater']);
  assert.equal(view.components[0].power, 15);
  assert.equal(view.components[0].facing, 'north');
  assert.equal(view.components[1].power, 0);
  assert.equal(view.components[1].facing, 'east');
  assert.deepEqual(view.ore.map(o => o.name), ['redstone_ore']);
  assert.equal(view.tntNearby, true);
  assert.deepEqual(view.hazards.map(h => h.name), ['tnt']);
  // La scansione è una sola, per l'intero vocabolario e col raggio dichiarato.
  assert.equal(calls.length, 1);
  assert.equal(Array.isArray(calls[0].names), true);
  assert.equal(calls[0].names.includes('lever'), true);
  assert.equal(calls[0].names.includes('tnt'), true);
  assert.equal(calls[0].names.includes('redstone_ore'), true);
  assert.equal(calls[0].radius, 16);
  assert.equal(view.found, 4);
  assert.equal(view.loaded, 1);
  assert.equal(view.ready, true);
  // La distanza è misurata dai piedi del bot, non dalla posizione della testa.
  assert.equal(view.components[0].distance, 1.6);
});

test('_redstoneView non inventa pericoli su un mondo senza redstone', () => {
  const { adapter } = redstoneAdapter({ '1,71,0': { name: 'stone' } });
  const view = adapter._redstoneView();
  assert.deepEqual(view.components, []);
  assert.deepEqual(view.ore, []);
  assert.deepEqual(view.power, []);
  assert.deepEqual(view.hazards, []);
  assert.equal(view.tntNearby, false);
  assert.equal(view.counts.components, 0);
});

test('il censimento è in cache entro il TTL e `force` lo rifà', () => {
  const { adapter, blocks, calls } = redstoneAdapter({
    '2,71,0': { name: 'lever', ...props({ open_bit: false }) },
  });
  assert.equal(adapter._redstoneView().components.length, 1);
  assert.equal(calls.length, 1);
  // Un blocco nuovo non compare finché la cache è valida.
  blocks.set('5,71,0', { name: 'redstone_lamp', ...props({ powered_bit: true }) });
  assert.equal(adapter._redstoneView().components.length, 1);
  assert.equal(calls.length, 1);
  // `force` rifà la scansione e il nuovo componente appare.
  const forced = adapter._redstoneView({ force: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(forced.components.map(c => c.name), ['lever', 'redstone_lamp']);
});

test('un mondo senza colonne caricate non è un mondo senza redstone', () => {
  const { adapter, blocks, calls } = redstoneAdapter({ '2,71,0': { name: 'lever', ...props({ open_bit: true }) } }, { loaded: 0 });
  const view = adapter._redstoneView();
  assert.equal(view.ready, false);
  assert.equal(view.loaded, 0);
  assert.deepEqual(view.components, []);
  assert.equal(calls.length, 1);
  // Niente cache: appena il mondo è caricato il censimento ritorna il componente.
  adapter.world.loaded = new Map([['0,0', {}], ['1,0', {}]]);
  const after = adapter._redstoneView();
  assert.equal(after.ready, true);
  assert.equal(after.components[0].name, 'lever');
  assert.equal(after.components[0].power, 15);
  assert.equal(blocks.size, 1);
  assert.equal(calls.length, 2);
});

test('_blockProps legge lo stato di una cella e tace quando non è leggibile', () => {
  const { adapter } = redstoneAdapter({
    '3,71,0': { name: 'repeater', ...props({ repeater_delay: 2 }) },
    // Forma spalmata: `getProperties()` è andato perso, resta `_properties`.
    '4,71,0': { name: 'lever', _properties: { open_bit: true } },
  });
  assert.deepEqual(adapter._blockProps({ x: 3, y: 71, z: 0 }), { repeater_delay: 2 });
  assert.deepEqual(adapter._blockProps({ x: 4, y: 71, z: 0 }), { open_bit: true });
  assert.equal(adapter._blockProps({ x: 9, y: 71, z: 0 }), null);
  assert.equal(adapter._blockProps(null), null);
});
