import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BedrockAdapter } from '../bedrock-adapter.mjs';
import { createWorldMemory } from '../world-memory.mjs';

test('the adapter persists container observations into the world memory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-mem-'));
  try {
    const memory = createWorldMemory({ dir, logger: { warn () {} } });
    const adapter = new BedrockAdapter({ logger: { log () {} }, memory });
    adapter._setContainerContents(
      { key: '1,2,3', type: 'chest', position: { x: 1, y: 2, z: 3 } },
      { white_wool: 42 },
    );
    // Cache runtime aggiornata...
    assert.equal(adapter.containers.get('1,2,3').contents.white_wool, 42);
    // ...e l'osservazione è finita nel WorldMemory (separata, persisterà).
    const found = memory.containersWithItem('white_wool');
    assert.equal(found.length, 1);
    assert.equal(found[0].contents.white_wool, 42);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an adapter without memory still works (no crash)', () => {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  assert.doesNotThrow(() => adapter._setContainerContents(
    { key: '4,5,6', type: 'barrel', position: { x: 4, y: 5, z: 6 } },
    { coal: 1 },
  ));
  assert.equal(adapter.containers.get('4,5,6').contents.coal, 1);
});

test('the adapter records portals, resource sites and notable entities', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-disc-'));
  try {
    const memory = createWorldMemory({ dir, backend: 'json', logger: { warn () {} } });
    const adapter = new BedrockAdapter({ logger: { log () {} }, memory });
    adapter.position = { x: 8, y: 40, z: 8 };
    adapter._feet = { x: 8, y: 39, z: 8 };
    adapter.nearbyBlocks = { iron_ore: [{ name: 'iron_ore', position: { x: 9, y: 40, z: 8 } }] };
    adapter.world = {
      findBlocks: (name) => {
        if (name === 'portal') return [{ name: 'portal', position: { x: 20, y: 40, z: 20 } }];
        if (name === 'diamond_ore') return [{ name: 'diamond_ore', position: { x: 10, y: 40, z: 8 } }];
        if (name === 'iron_ore') return [{ name: 'iron_ore', position: { x: 9, y: 40, z: 8 } }];
        return [];
      },
      blockAt: () => ({ name: 'stone' }),
    };
    adapter.entities = new Map([
      ['7', { runtimeId: '7', uniqueId: '42', type: 'horse', kind: 'mob', position: { x: 5, y: 40, z: 5 } }],
      ['8', { runtimeId: '8', uniqueId: '43', type: 'pig', kind: 'mob', position: { x: 6, y: 40, z: 6 } }],
    ]);
    adapter._rememberDiscoveries();
    assert.equal(memory.findPortals().length, 1, 'portale registrato');
    assert.ok(memory.findResources({ contains: 'diamond_ore' }).length === 1, 'sito con diamante');
    assert.ok(memory.findResources({ contains: 'iron_ore' })[0].observations.includes('iron_ore'));
    assert.equal(memory.findEntities().length, 1, 'solo il cavallo, non il maiale');
    assert.equal(memory.findEntities({ type: 'horse' })[0].id, 'entity_42');
    memory.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discovery scans run on a new chunk, not on every refresh', () => {
  const adapter = new BedrockAdapter({ logger: { log () {} }, memory: {} });
  let scans = 0;
  adapter._rememberDiscoveries = () => { scans++; };
  adapter.position = { x: 0, y: 64, z: 0 };
  adapter._maybeRememberDiscoveries();
  adapter._maybeRememberDiscoveries(); // stesso chunk, entro il cooldown
  assert.equal(scans, 1, 'una scansione per chunk (entro il cooldown)');
  adapter.position = { x: 40, y: 64, z: 0 }; // chunk nuovo
  adapter._maybeRememberDiscoveries();
  assert.equal(scans, 2);
  adapter._lastDiscoveryAt = 0; // stesso chunk, cooldown scaduto
  adapter._maybeRememberDiscoveries();
  assert.equal(scans, 3, 'ri-scansiona dopo il cooldown');
});

test('the adapter records sparse mission checkpoints while a mission is active', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-mission-'));
  try {
    const memory = createWorldMemory({ dir, backend: 'json', logger: { warn () {} } });
    const adapter = new BedrockAdapter({ logger: { log () {} }, memory });
    adapter.dimension = 'overworld';
    adapter.nearbyBlocks = {};
    adapter.world = { findBlocks: () => [], biomeAt: () => 'plains' };
    const mission = memory.createMission({ type: 'explore', origin: { x: 0, y: 64, z: 0 } });
    adapter.missionId = mission.id;

    adapter.position = { x: 0, y: 64, z: 0 };
    adapter._rememberDiscoveries(); // primo checkpoint
    adapter.position = { x: 10, y: 64, z: 0 };
    adapter._rememberDiscoveries(); // < 48 blocchi → nessun nuovo checkpoint
    adapter.position = { x: 100, y: 64, z: 0 };
    adapter._rememberDiscoveries(); // ≥ 48 → secondo checkpoint
    const cps = memory.missionCheckpoints(mission.id);
    assert.equal(cps.length, 2, 'checkpoint sparsi, non a ogni movimento');
    assert.equal(cps[0].biome, 'plains');
    memory.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
