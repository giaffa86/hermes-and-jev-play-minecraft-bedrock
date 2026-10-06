// V4 — l'onestà e la protezione della ricognizione.
//
// Il censimento è un registro, non una narrazione: questi test fissano le quattro
// proprietà che lo tengono tale.
//   1. un payload che riporta un dato non può dire di non aver guardato, e un
//      contatore non può dire di aver letto meno di ciò che riporta;
//   2. un fatto porta `confidence`, `evidence` e `missing`: la confidenza è la
//      quota *letta*, mai una stima;
//   3. "sotto soglia" e "senza posizione" finiscono in `ignored`, così non si
//      confondono con "non guardato";
//   4. la ricognizione e la catena di fattoria non emettono chiavi distruttive, e
//      i blocchi costruiti del sito (letti, farmland, recinti) restano protetti.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BedrockAdapter } from '../bedrock-adapter.mjs';
import { surveyVillage } from '../village-survey.mjs';
import { planStorageSearch, STORAGE_RUNG } from '../storage-ladder.mjs';
import { farmOptionKeys } from '../bedrock-survival.mjs';

const cells = rows => rows.map(row => ({
  position: { x: row.x, y: row.y ?? 64, z: row.z },
  ...(row.mature == null ? {} : { mature: row.mature }),
  ...(row.occupied == null ? {} : { occupied: row.occupied }),
}));

const village = (spec = {}, extra = {}) => surveyVillage({
  nearby: Object.fromEntries(Object.entries(spec).map(([name, rows]) => [name, cells(rows)])),
  ...extra,
});

// ---- 1. guardato / non guardato ------------------------------------------------

test('a payload that reports data is never "not looked at"', () => {
  const census = village({
    carrots: [{ x: 0, z: 0, mature: true }, { x: 1, z: 0, mature: true }, { x: 2, z: 0, mature: true }, { x: 3, z: 0, mature: false }],
  }, { scanned: 0 });

  assert.equal(census.checked, true, 'un dato riportato implica che si è guardato');
  assert.equal(census.survey.cells, 4);
  assert.ok(census.survey.scanned >= census.survey.cells, 'il contatore non può dire di aver letto meno di ciò che riporta');
});

test('an observation nobody looked at claims nothing', () => {
  const census = surveyVillage({});

  assert.equal(census.checked, false);
  assert.equal(census.detection.state, null);
  assert.equal(census.detection.confidence, 0);
  assert.deepEqual(census.detection.evidence, []);
  assert.deepEqual(census.detection.missing, []);
  assert.deepEqual(census.ignored, { plots: 0, animals: 0, containers: 0 });
  assert.deepEqual([census.houses, census.plots, census.pens, census.storage], [[], [], [], []]);
});

test('looked and empty names every rule below its minimum', () => {
  const census = village({ grass: [{ x: 0, z: 0 }] }, { scanned: 40 });

  assert.equal(census.checked, true);
  assert.equal(census.detection.state, 'NOT_FOUND');
  assert.equal(census.detection.confidence, 0);
  assert.deepEqual(census.detection.evidence, []);
  assert.deepEqual(census.detection.matched, []);
  assert.deepEqual(census.detection.missing, ['bell (0/1)', 'beds (0/2)', 'workstations (0/1)', 'villagers (0/2)']);
  for (const line of census.detection.missing) {
    assert.match(line, /^\w+ \(\d+\/\d+\)$/, `una regola sotto il suo minimo si nomina: ${line}`);
  }
});

// ---- 2. confidenza = quota letta ----------------------------------------------

test('confidence is the share of the fact that was read, never an estimate', () => {
  const partial = village({
    carrots: [{ x: 0, z: 0, mature: true }, { x: 1, z: 0, mature: true }, { x: 2, z: 0, mature: false }, { x: 3, z: 0 }],
  });
  assert.equal(partial.plots[0].confidence, 0.75, 'una maturità su quattro non è stata letta');
  assert.deepEqual(partial.plots[0].missing, ['ripeness']);
  assert.equal(partial.plots[0].evidence.unknown, 1);

  const full = village({
    potatoes: [{ x: 0, z: 0, mature: true }, { x: 1, z: 0, mature: false }, { x: 2, z: 0, mature: true }, { x: 3, z: 0, mature: false }],
  });
  assert.equal(full.plots[0].confidence, 1);
  assert.deepEqual(full.plots[0].missing, []);
});

test('a house with unread beds cannot claim a free bed', () => {
  const census = village({ bed: [{ x: 0, z: 0, occupied: true }, { x: 1, z: 0 }] });
  const house = census.houses[0];

  assert.equal(house.confidence, 0.5, 'un letto su due ha l\'occupazione letta');
  assert.ok(house.missing.includes('occupancy'));
  assert.ok(house.missing.includes('door'));
  assert.ok(house.missing.includes('container'));

  const whole = village({ bed: [{ x: 0, z: 0, occupied: false }], oak_door: [{ x: 0, z: 1 }] }, {
    containers: [{ position: { x: 0, y: 64, z: 2 }, type: 'chest', contents: {} }],
  });
  assert.equal(whole.houses[0].confidence, 1);
  assert.deepEqual(whole.houses[0].missing, []);
});

test('a pen says whether it is fenced and what it could not read', () => {
  const census = village({ oak_fence: [{ x: 0, z: 0 }] }, {
    farmAnimals: [
      { type: 'cow', position: { x: 1, y: 64, z: 1 } },
      { type: 'cow' },
      { type: 'villager_v2', position: { x: 1, y: 64, z: 1 } },
    ],
  });
  const pen = census.pens[0];

  assert.equal(pen.fenced, true);
  assert.equal(pen.evidence.fenced, true);
  assert.equal(pen.confidence, 0.5, 'un capo che non si è riusciti a leggere abbassa la confidenza');
  assert.equal(census.ignored.animals, 1);
  assert.equal(census.counts.animals, 2, 'i villager non sono bestiame');

  const loose = village({}, { farmAnimals: [{ type: 'sheep', position: { x: 0, y: 64, z: 0 } }] });
  assert.deepEqual(loose.pens[0].missing, ['fence']);
  assert.equal(loose.pens[0].evidence.fenced, false);
  assert.equal(loose.pens[0].confidence, 1);
});

test('unknown contents is not an empty chest', () => {
  const census = village({ bell: [{ x: 0, z: 0 }] }, {
    anchor: { x: 0, y: 64, z: 0 },
    containers: [
      { position: { x: 2, y: 64, z: 0 }, type: 'barrel', contentsKnown: false },
      { position: { x: 9, y: 64, z: 0 }, type: 'chest', contents: { iron_ingot: 3 }, status: 'known' },
      { type: 'chest' },
    ],
  });
  const [unknown, known] = census.storage;

  assert.equal(unknown.contains, null, 'non ispezionato ≠ vuoto');
  assert.equal(unknown.confidence, 0);
  assert.deepEqual(unknown.missing, ['contents']);
  assert.equal(known.confidence, 1);
  assert.deepEqual(known.missing, []);
  assert.equal(census.ignored.containers, 1, 'una riga senza posizione non è un fatto');
});

// ---- 3. sotto soglia ≠ non guardato -------------------------------------------

test('a crop cluster below the threshold is absent, not guessed', () => {
  const spec = { carrots: [{ x: 0, z: 0, mature: true }, { x: 1, z: 0, mature: true }, { x: 2, z: 0, mature: true }] };
  const census = village(spec);

  assert.deepEqual(census.plots, [], 'sotto soglia non è un appezzamento');
  assert.equal(census.ignored.plots, 1, 'visto e sotto soglia ≠ non guardato');
  assert.equal(census.counts.crops, 3, 'il conteggio delle celle non è un\'affermazione su un appezzamento');

  const small = village(spec, { limits: { plotMinCells: 3 } });
  assert.equal(small.plots.length, 1);
  assert.equal(small.ignored.plots, 0);
});

test('the payload carries the thresholds it used', () => {
  assert.deepEqual(village({}).thresholds, { houseRadius: 8, plotRadius: 4, penRadius: 12, plotMinCells: 4, maxCells: 20000 });
  assert.deepEqual(
    village({}, { limits: { plotMinCells: 2, houseRadius: 3, maxCells: 5 } }).thresholds,
    { houseRadius: 3, plotRadius: 4, penRadius: 12, plotMinCells: 2, maxCells: 5 },
  );
});

// ---- 4. memoria stantia, chiavi distruttive, blocchi costruiti ------------------

test('a stale memory is never used without verification', () => {
  const stale = { id: 'chest:1:64:0', type: 'chest', position: { x: 1, y: 64, z: 0 }, contents: { iron_ingot: 5 }, contentsStale: true };

  const plan = planStorageSearch({ item: 'iron_ingot', known: [stale], from: { x: 0, y: 64, z: 0 } });
  assert.equal(plan.rung, STORAGE_RUNG.KNOWN_ITEM);
  assert.equal(plan.reason, 'known_item_stale');
  assert.equal(plan.target.verify, true, 'arrivare e rileggere: la memoria stantia non si crede');

  const refused = planStorageSearch({ item: 'iron_ingot', known: [stale], verifyStale: false });
  assert.equal(refused.rung, STORAGE_RUNG.SWEEP, 'senza verifica quella memoria non serve a nulla');

  const fresh = planStorageSearch({ item: 'iron_ingot', known: [{ ...stale, contentsStale: false }] });
  assert.equal(fresh.reason, 'known_item');
  assert.equal(fresh.target.verify, false);

  const unopened = planStorageSearch({ item: 'iron_ingot', toInspect: [{ id: 'barrel:2', type: 'barrel', position: { x: 2, y: 64, z: 0 }, needsInspection: true }] });
  assert.equal(unopened.rung, STORAGE_RUNG.INSPECT);
  assert.equal(unopened.reason, 'discovered_not_inspected');
  assert.equal(unopened.target.count, null, 'un baule chiuso non ha conteggi, nemmeno zero');
});

test('nothing in the recon path emits a destructive key', () => {
  const source = readFileSync(new URL('../village-survey.mjs', import.meta.url), 'utf8');
  assert.equal(/\b(mine|dig)_\w/.test(source), false, 'il censimento non conosce chiavi di scavo');

  assert.deepEqual(farmOptionKeys({ crop: 'carrot', store: 'known' }), ['harvest_carrots', 'plant_carrot', 'deposit_carrot', 'collect_drop', 'dump_inventory']);
  for (const store of ['known', 'nearest', null]) {
    for (const key of farmOptionKeys({ crop: 'carrot', store })) {
      assert.equal(/^(mine_|dig_)/.test(key), false, `la catena di fattoria non scava: ${key}`);
    }
  }
});

test('the sites the recon walks over are protected from digging', () => {
  const solid = (name, extra = {}) => ({ name, boundingBox: 'block', diggable: true, hardness: 0.5, ...extra });
  const air = { name: 'air', boundingBox: 'empty', diggable: false, hardness: 0 };
  const at = cells => {
    const adapter = new BedrockAdapter({ logger: { log () {} } });
    adapter.spawned = true;
    adapter.status = 'spawned';
    adapter._feet = { x: 92.5, y: 72, z: 148.5 };
    adapter.position = { x: 92.5, y: 73.62, z: 148.5 };
    adapter._lastYaw = 0;
    const blocks = {
      '92,73,149': air,
      '92,72,149': solid('dirt', { material: 'mineable/shovel' }),
      '92,71,149': solid('grass_block', { material: 'mineable/shovel', hardness: 0.6 }),
      '92,70,149': solid('dirt', { material: 'mineable/shovel' }),
      ...cells,
    };
    adapter.world.blockAt = ({ x, y, z }) => blocks[`${x},${y},${z}`] ?? null;
    adapter.world.findBlocks = () => [];
    return adapter;
  };

  assert.equal(at({ '92,71,149': solid('farmland', { hardness: 0.6 }) })._digTargets().error, 'protected_step');
  assert.equal(at({ '92,72,149': solid('bed', { hardness: 0.4 }) })._digTargets().error, 'protected_front');
  assert.equal(at({ '92,73,149': solid('oak_fence', { hardness: 2 }) })._digTargets().error, 'protected_head');
  assert.equal(at({ '92,71,149': solid('carrots', { hardness: 0 }) })._digTargets().error, 'protected_step');
});

function chainAdapter () {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.position = { x: 0, y: 64, z: 0 };
  adapter._feet = { x: 0, y: 64, z: 0 };
  adapter.dimension = 'overworld';
  adapter.inventorySlots = [];
  adapter.inventory = {};
  adapter.drops = [];
  adapter.nearbyBlocks = {};
  adapter._reachabilityUsable = () => false;
  adapter.world.findBlocks = () => [];
  adapter.world.blockAt = () => null;
  return adapter;
}

test('the chain breaks the crop it harvested, never the farmland under it', async () => {
  const adapter = chainAdapter();
  const asked = [];
  adapter.world.findBlocks = name => (name === 'carrots' ? [{ name: 'carrots', position: { x: 1, y: 64, z: 0 }, distance: 1, diggable: true }] : []);
  adapter.world.blockAt = () => ({ name: 'carrots', getProperties: () => ({ growth: 7 }) });
  adapter._mineBlock = async block => { asked.push(block.name); return { ok: true }; };
  adapter._plantSeed = async seed => ({ ok: true, seed });
  adapter.inventory = { carrot: 1 };

  const result = await adapter._harvestCrop('carrots');

  assert.equal(result.ok, true);
  assert.deepEqual(asked, ['carrots'], 'una sola cella toccata: la coltura');
  assert.equal(result.replanted.ok, true);
});

test('the chain cannot damage a crop that still has to grow', async () => {
  const adapter = chainAdapter();
  adapter.world.findBlocks = () => [{ name: 'wheat', position: { x: 1, y: 64, z: 0 }, distance: 1, diggable: true }];
  adapter.world.blockAt = () => ({ name: 'wheat', getProperties: () => ({ growth: 1 }) });
  let mined = 0;
  adapter._mineBlock = async () => { mined++; return { ok: true }; };

  const result = await adapter._harvestCrop('wheat');

  assert.equal(result.ok, false);
  assert.equal(result.error, 'crop_not_mature');
  assert.equal(mined, 0, 'niente scavo su una coltura immatura');
  assert.equal(result.immature, 1);
});
