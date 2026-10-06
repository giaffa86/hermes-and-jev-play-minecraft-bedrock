import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BedrockAdapter } from '../bedrock-adapter.mjs';
import { createWorldMemory } from '../world-memory.mjs';

// V0 — il censimento del sito è **puro** (`village-survey.mjs`): l'adapter
// raccoglie i fatti e non decide nulla. Questi test riguardano perciò la
// raccolta: che le celle vengano dal mondo e non dal campione `observe().nearby`
// (che si ferma a 4 celle per nome), che l'evidenza di entità sia quella del
// detector (villager inclusi) e non il bestiame, che la vista sia memoizzata e
// che il registro dei contenitori arrivi con i suoi due stati.

const block = (name, x, y, z, props = {}) => ({
  name,
  position: { x, y, z },
  getProperties: () => props,
});

// Un sito completo: campana, tre letti, quattro carote (tre mature), un composter,
// due staccionate — e, per il detector, due villager.
const siteBlocks = () => ({
  bell: [block('bell', 0, 66, 4)],
  bed: [block('bed', 1, 64, 4), block('bed', 2, 64, 4), block('bed', 3, 64, 4)],
  carrots: [
    block('carrots', 0, 64, 0, { growth: 7 }),
    block('carrots', 1, 64, 0, { growth: 7 }),
    block('carrots', 2, 64, 0, { growth: 3 }),
    block('carrots', 3, 64, 0, { growth: 7 }),
  ],
  composter: [block('composter', 2, 64, 5)],
  oak_fence: [block('oak_fence', 1, 64, 8), block('oak_fence', 2, 64, 8)],
});

const siteEntities = () => [
  { type: 'villager_v2', position: { x: 1, y: 64, z: 5 } },
  { type: 'villager_v2', position: { x: 2, y: 64, z: 5 } },
  { type: 'cow', position: { x: 1, y: 64, z: 9 }, baby: false },
];

function site ({ blocks = {}, entities = [], memory = null } = {}) {
  const adapter = new BedrockAdapter({ logger: { log () {} }, memory });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.position = { x: 0, y: 64, z: 0 };
  adapter._feet = { x: 0, y: 64, z: 0 };
  adapter.dimension = 'overworld';
  adapter._reachabilityUsable = () => false;
  adapter.inventorySlots = [];
  adapter.inventory = {};
  adapter.drops = [];
  adapter.nearbyBlocks = {};
  adapter.client = { write: () => {} };
  adapter.world.findBlocks = (name, _point, _radius, cap) => (blocks[name] || []).slice(0, cap ?? 64);
  adapter.world.surveyBlocks = () => ({
    scanned: 4000,
    distinct: Object.keys(blocks).length,
    truncated: false,
    names: new Map(Object.entries(blocks).map(([name, cells]) => [name, { count: cells.length, first: cells[0]?.position }])),
  });
  for (const entity of entities) {
    adapter.entities.set(entity.runtimeId ?? adapter.entities.size + 1, { kind: 'mob', lastAt: Date.now(), ...entity });
  }
  return adapter;
}

test('the view censuses the site from the world, not from observe().nearby', () => {
  const adapter = site({ blocks: siteBlocks(), entities: siteEntities() });
  // Il campione dell'osservazione non contiene il villaggio: 4 celle per nome al
  // massimo, e qui è vuoto di proposito. Il censimento non lo legge.
  assert.deepEqual(adapter.nearbyBlocks, {});
  const view = adapter._villageView({ force: true });
  assert.equal(view.checked, true);
  assert.equal(view.detection.state, 'CONFIRMED');
  assert.deepEqual(view.detection.evidence, ['bell 1', 'beds 3', 'workstations 1', 'villagers 2']);
  assert.deepEqual(view.anchor, { x: 0, y: 66, z: 4 }, 'ancora sulla campana, come il detector');
  assert.equal(view.counts.beds, 3);
  assert.equal(view.counts.crops, 4);
  assert.equal(view.houses.length, 1);
  assert.equal(view.plots.length, 1);
  assert.equal(view.plots[0].crop, 'carrots');
  assert.equal(view.plots[0].seed, 'carrot', 'la ricrescita è dichiarata: carota');
  assert.deepEqual([view.plots[0].ready, view.plots[0].immature], [3, 1]);
  assert.equal(view.pens.length, 1, 'una mucca è un recinto');
  assert.equal(view.pens[0].fenced, true, 'le due staccionate sono vicine alla mucca');
  assert.equal(view.counts.animals, 1, 'due villager non sono bestiame');
  assert.equal(view.blocks.capped, false);
  assert.deepEqual(view.origin, { x: 0, y: 64, z: 0 });
  assert.ok(Number.isFinite(view.at), 'quando è stata letta è un fatto della vista');
});

test('the view is memoized, and force re-reads the world', () => {
  const adapter = site({ blocks: siteBlocks(), entities: siteEntities() });
  const inner = adapter.world.findBlocks.bind(adapter.world);
  let calls = 0;
  adapter.world.findBlocks = (...args) => { calls++; return inner(...args); };
  const first = adapter._villageView({ force: true });
  const afterFirst = calls;
  assert.ok(afterFirst > 0);
  assert.equal(adapter._villageView(), first, 'senza force si riusa la vista');
  assert.equal(calls, afterFirst, 'e non si rilegge il mondo a ogni passo');
  adapter._villageView({ force: true });
  assert.ok(calls > afterFirst, 'force rilegge');
});

test('a name at the cell cap says the count is a lower bound', () => {
  const beds = [...Array(70)].map((_, i) => block('bed', i % 10, 64, Math.floor(i / 10)));
  const adapter = site({ blocks: { ...siteBlocks(), bed: beds } });
  const view = adapter._villageView({ force: true });
  assert.equal(view.blocks.capped, true);
  assert.deepEqual(view.blocks.cappedNames, ['bed']);
  assert.equal(view.counts.beds, 64, 'il tetto è per nome, e la vista lo dichiara invece di tacerlo');
});

test('the register brings both states: known contents and merely discovered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'village-view-'));
  try {
    const memory = createWorldMemory({ dir, backend: 'json', logger: { warn () {} } });
    memory.rememberContainer({ position: { x: 4, y: 64, z: 4 }, type: 'chest', contents: { carrot: 12 } });
    memory.rememberContainer({ position: { x: 6, y: 64, z: 4 }, type: 'barrel' });
    const adapter = site({ blocks: siteBlocks(), entities: siteEntities(), memory });
    const view = adapter._villageView({ force: true });
    const chest = view.storage.find(row => row.type === 'chest');
    const barrel = view.storage.find(row => row.type === 'barrel');
    assert.deepEqual(chest.contains, { carrot: 12 });
    assert.equal(barrel.contains, null, 'scoperto non è ispezionato: il contenuto resta ignoto');
    assert.equal(view.storage[0].type, 'chest', 'ordinati dall\'ancora: il baule è più vicino');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a view with nothing to read says it did not look', () => {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  const view = adapter._villageView({ force: true });
  assert.equal(view.checked, false);
  assert.equal(view.detection.state, null, '"non guardato" non è "guardato e vuoto"');
  assert.deepEqual([view.houses, view.plots, view.pens, view.storage], [[], [], [], []]);
  assert.equal(adapter.observe().village.checked, false, 'e l\'osservazione la porta con sé');
});

test('the observation carries the census', () => {
  const adapter = site({ blocks: siteBlocks(), entities: siteEntities() });
  const village = adapter.observe().village;
  assert.equal(village.detection.state, 'CONFIRMED');
  assert.equal(village.counts.beds, 3);
});
