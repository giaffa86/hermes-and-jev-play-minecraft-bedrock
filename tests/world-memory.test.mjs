import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorldMemory, MEMORY_STATUS, distance3d } from '../world-memory.mjs';

const quiet = { warn () {} };
const BACKENDS = ['json', 'sqlite'];

const withMemory = (backend, fn) => {
  const dir = mkdtempSync(join(tmpdir(), `wm-${backend}-`));
  try {
    const wm = createWorldMemory({ dir, backend, logger: quiet });
    return fn(wm, dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

for (const backend of BACKENDS) {
  test(`[${backend}] landmarks are remembered, searched by type and nearest`, () => withMemory(backend, (wm) => {
    wm.rememberLandmark({ type: 'sheep_farm', label: 'stalla delle pecore', position: { x: 123, y: 64, z: -87 } });
    wm.rememberLandmark({ type: 'village', position: { x: 500, y: 70, z: -300 } });
    assert.equal(wm.hasLandmark('sheep_farm_123_64_-87'), true);
    assert.equal(wm.findLandmarks({ type: 'village' }).length, 1);
    const near = wm.nearestLandmark({ from: { x: 130, y: 64, z: -80 } });
    assert.equal(near.type, 'sheep_farm');
    assert.equal(near.status, MEMORY_STATUS.KNOWN);
  }));

  test(`[${backend}] re-remembering a landmark preserves discoveredAt and upserts`, () => withMemory(backend, (wm) => {
    const first = wm.rememberLandmark({ type: 'home', id: 'home', position: { x: 1, y: 2, z: 3 } });
    const again = wm.rememberLandmark({ type: 'home', id: 'home', position: { x: 1, y: 2, z: 3 } });
    assert.equal(again.discoveredAt, first.discoveredAt);
    assert.equal(wm.findLandmarks({ type: 'home' }).length, 1, 'upsert, non duplicato');
  }));

  test(`[${backend}] containers record contents and are found by item`, () => withMemory(backend, (wm) => {
    wm.rememberContainer({ type: 'chest', position: { x: 128, y: 64, z: -91 }, contents: { white_wool: 42, oak_log: 17 } });
    wm.rememberContainer({ type: 'barrel', position: { x: 10, y: 64, z: 10 }, contents: { carrot: 3 } });
    const wool = wm.containersWithItem('white_wool');
    assert.equal(wool.length, 1);
    assert.equal(wool[0].id, 'container_128_64_-91');
    assert.equal(wool[0].contents.white_wool, 42);
    assert.equal(wm.containersWithItem('diamond').length, 0);
  }));

  test(`[${backend}] a container read again updates the same record`, () => withMemory(backend, (wm) => {
    wm.rememberContainer({ position: { x: 5, y: 6, z: 7 }, contents: { coal: 1 } });
    wm.rememberContainer({ position: { x: 5, y: 6, z: 7 }, contents: { coal: 9 } });
    assert.equal(wm.findContainers().length, 1);
    assert.equal(wm.findContainers()[0].contents.coal, 9);
  }));

  test(`[${backend}] old observations become STALE, not INVALID`, () => withMemory(backend, (wm) => {
    wm.rememberContainer({ position: { x: 1, y: 2, z: 3 }, contents: { dirt: 1 } });
    wm.rememberLandmark({ type: 'home', id: 'home', position: { x: 0, y: 0, z: 0 } });
    wm.refreshStatuses(Date.now() + 10 * 60 * 60 * 1000);
    assert.equal(wm.findContainers({ includeStale: true })[0].status, MEMORY_STATUS.STALE);
    assert.equal(wm.findLandmarks({ type: 'home' })[0].status, MEMORY_STATUS.STALE);
    assert.equal(wm.containersWithItem('dirt').length, 1, 'lo stale resta ricercabile');
  }));

  test(`[${backend}] observeView exposes landmarks and containers`, () => withMemory(backend, (wm) => {
    wm.rememberLandmark({ type: 'sheep_farm', position: { x: 1, y: 2, z: 3 } });
    wm.rememberContainer({ position: { x: 1, y: 2, z: 4 }, contents: { white_wool: 5 } });
    const view = wm.observeView();
    assert.equal(view.landmarks[0].type, 'sheep_farm');
    assert.equal(view.containers[0].contents.white_wool, 5);
    assert.deepEqual(wm.summary(), { records: 2, landmarks: 1, containers: 1, chunks: 0 });
  }));

  test(`[${backend}] resource sites, portals and entities are remembered and queried`, () => withMemory(backend, (wm) => {
    wm.rememberResourceSite({ id: 'resource_site_0_0', kind: 'cave', position: { x: 8, y: 40, z: 8 }, observations: ['diamond_ore', 'iron_ore'] });
    const diamonds = wm.findResources({ contains: 'diamond_ore' });
    assert.equal(diamonds.length, 1);
    assert.equal(diamonds[0].type, 'cave');
    assert.deepEqual(diamonds[0].observations.sort(), ['diamond_ore', 'iron_ore']);
    assert.equal(wm.findResources({ contains: 'emerald_ore' }).length, 0);

    wm.rememberPortal({ position: { x: 100, y: 65, z: 100 }, portalType: 'nether' });
    wm.rememberPortal({ position: { x: 100, y: 65, z: 100 }, portalType: 'nether', nether: { x: 12, y: 70, z: 12 }, verified: true });
    const portals = wm.findPortals();
    assert.equal(portals.length, 1, 'stesso portale, aggiornato non duplicato');
    assert.deepEqual(portals[0].nether, { x: 12, y: 70, z: 12 });
    assert.equal(portals[0].verified, true);

    wm.rememberEntity({ id: 'entity_42', type: 'horse', position: { x: 5, y: 64, z: 5 }, state: { leashed: true } });
    assert.deepEqual(wm.findEntities({ type: 'horse' })[0].state, { leashed: true });

    const view = wm.observeView();
    assert.equal(view.portals.length, 1);
    assert.equal(view.counts.resource_site, 1);
    assert.equal(view.counts.portal, 1);
    assert.equal(view.counts.entity, 1);
    // I luoghi restano separati da risorse/portali/entità.
    assert.equal(wm.findLandmarks().length, 0);
  }));

  test(`[${backend}] explored chunks: mark, visited, biome, frontier (batched)`, () => withMemory(backend, (wm) => {
    wm.markChunkVisited({ x: 0, z: 0, biome: 'plains' });
    wm.markChunkVisited({ x: 1, z: 0, biome: 'cherry_grove' });
    wm.markChunkVisited({ x: 0, z: 0 }); // rivisita
    assert.equal(wm.isChunkVisited({ x: 0, z: 0 }), true);
    assert.equal(wm.isChunkVisited({ x: 9, z: 9 }), false);
    const visited = wm.visitedChunks();
    assert.equal(visited.length, 2);
    assert.equal(visited.find(r => r.id === 'chunk_overworld_0_0').visits, 2);
    assert.equal(wm.chunksWithBiome('cherry_grove').length, 1);
    const frontier = wm.unexploredFrontier();
    assert.equal(frontier.length, 10, 'frontiera = vicini non visitati');
    assert.ok(frontier.every(f => !(f.x === 0 && f.z === 0) && !(f.x === 1 && f.z === 0)));
    assert.ok(frontier.some(f => f.x === 0 && f.z === -1));
  }));

  test(`[${backend}] memory persists across a new service instance`, () => {
    const dir = mkdtempSync(join(tmpdir(), `wm-${backend}-persist-`));
    try {
      const a = createWorldMemory({ dir, backend, logger: quiet });
      a.rememberLandmark({ type: 'sheep_farm', id: 'sheep_farm', position: { x: 1, y: 2, z: 3 } });
      a.rememberContainer({ position: { x: 4, y: 5, z: 6 }, contents: { white_wool: 7 } });
      a.close();
      const b = createWorldMemory({ dir, backend, logger: quiet });
      assert.equal(b.hasLandmark('sheep_farm'), true);
      assert.equal(b.containersWithItem('white_wool')[0].contents.white_wool, 7);
      b.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('distance3d ranks candidates', () => {
  assert.equal(distance3d({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 }), 5);
});
