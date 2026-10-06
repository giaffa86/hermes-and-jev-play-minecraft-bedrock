import { test } from 'node:test';
import assert from 'node:assert/strict';
import { surveyVillage, VILLAGE_DETECTION_STATE } from '../village-survey.mjs';

// `nearby` come lo produce `observe()`: nome del blocco → celle `{position, mature}`.
const cells = rows => rows.map(row => ({
  position: { x: row.x, y: row.y ?? 64, z: row.z },
  ...(row.mature == null ? {} : { mature: row.mature }),
  ...(row.occupied == null ? {} : { occupied: row.occupied }),
}));

const village = (spec = {}, extra = {}) => surveyVillage({
  nearby: Object.fromEntries(Object.entries(spec).map(([name, rows]) => [name, cells(rows)])),
  ...extra,
});

const villager = (x, z) => ({ type: 'villager_v2', position: { x, y: 64, z } });

test('an empty observation is not a census', () => {
  const census = surveyVillage({});
  assert.equal(census.checked, false);
  assert.equal(census.detection.state, null, '"non guardato" non è "guardato e vuoto"');
  assert.deepEqual(census.detection.evidence, []);
  assert.deepEqual([census.houses, census.plots, census.pens, census.storage], [[], [], [], []]);
  assert.equal(census.counts.houses + census.counts.beds + census.counts.animals, 0);
});

test('looked and empty is NOT_FOUND, with what is missing', () => {
  const census = village({ grass: [{ x: 0, z: 0 }] }, { scanned: 40 });
  assert.equal(census.checked, true);
  assert.equal(census.detection.state, VILLAGE_DETECTION_STATE.NOT_FOUND);
  assert.deepEqual(census.detection.evidence, []);
  assert.deepEqual(census.detection.missing, ['bell (0/1)', 'beds (0/2)', 'workstations (0/1)', 'villagers (0/2)']);
});

test('partial markers are a CANDIDATE lead, never a village', () => {
  const census = village({ bed: [{ x: 0, z: 0 }, { x: 2, z: 0 }] });
  assert.equal(census.checked, true);
  assert.equal(census.detection.state, VILLAGE_DETECTION_STATE.CANDIDATE);
  assert.deepEqual(census.detection.evidence, ['beds 2']);
  assert.equal(census.detection.score, 2);
  assert.ok(census.detection.missing.some(row => row.startsWith('bell')), 'dice anche cosa manca');
  assert.equal(census.houses.length, 1, 'ma la pertinenza esiste già: 2 letti sono una casa');
});

test('a full site is CONFIRMED, anchored on the most specific marker', () => {
  const census = village({
    bell: [{ x: 0, y: 66, z: 4 }],
    bed: [{ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 4, z: 0 }],
    composter: [{ x: 1, z: 2 }],
  }, { farmAnimals: [villager(5, 5), villager(6, 5)] });

  assert.equal(census.detection.state, VILLAGE_DETECTION_STATE.CONFIRMED);
  assert.equal(census.detection.score, 9);
  assert.deepEqual(census.detection.missing, []);
  assert.deepEqual(census.anchor, { x: 0, y: 66, z: 4 }, 'l\'ancora è la campana, non il centro dei letti');
  assert.equal(census.counts.houses, 1);
  assert.equal(census.counts.beds, 3);
  assert.deepEqual(census.detection.evidence, ['bell 1', 'beds 3', 'workstations 1', 'villagers 2']);
});

test('two bed clusters are two houses, and a container belongs to its own', () => {
  const census = village({
    bed: [{ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 4, z: 0 }, { x: 0, z: 20 }, { x: 2, z: 20 }],
  }, {
    containers: [
      { position: { x: 1, y: 64, z: 1 }, type: 'chest' },
      { position: { x: 1, y: 64, z: 21 }, type: 'barrel' },
    ],
  });
  assert.equal(census.houses.length, 2);
  assert.deepEqual(census.houses.map(house => house.evidence.beds), [3, 2]);
  assert.deepEqual(census.houses[0].containers.map(row => row.type), ['chest']);
  assert.deepEqual(census.houses[1].containers.map(row => row.type), ['barrel']);
});

test('observe().bed enriches the beds with occupancy and never doubles them', () => {
  const census = village({ bed: [{ x: 0, z: 0 }, { x: 2, z: 0 }] }, {
    beds: [{ position: { x: 0, y: 64, z: 0 }, occupied: true }, { position: { x: 2, y: 64, z: 0 }, occupied: false }],
  });
  assert.equal(census.counts.beds, 2);
  assert.deepEqual(census.houses[0].beds.map(bed => bed.occupied), [true, false]);
});

test('a plot knows its crop, its seed and how much is ripe', () => {
  const census = village({
    carrots: [{ x: 0, z: 0, mature: true }, { x: 1, z: 0, mature: true }, { x: 2, z: 0, mature: true }, { x: 0, z: 1, mature: false }],
  });
  assert.deepEqual(census.plots, [{
    crop: 'carrots',
    seed: 'carrot',
    cells: 4,
    ready: 3,
    immature: 1,
    unknown: 0,
    center: { x: 1, y: 64, z: 0 },
  }]);
  assert.equal(census.counts.crops, 4);
});

test('an unreadable maturity stays unknown, it is never guessed', () => {
  const census = village({ wheat: [{ x: 0, z: 0 }, { x: 1, z: 0 }] });
  assert.deepEqual(census.plots[0], { crop: 'wheat', seed: 'wheat_seeds', cells: 2, ready: 0, immature: 0, unknown: 2, center: { x: 1, y: 64, z: 0 } });
});

test('plots of different crops never merge', () => {
  const census = village({ carrots: [{ x: 0, z: 0 }], wheat: [{ x: 2, z: 0 }] });
  assert.deepEqual(census.plots.map(plot => plot.crop), ['carrots', 'wheat']);
  assert.deepEqual(census.plots.map(plot => plot.cells), [1, 1]);
});

test('a pen is where the animals are, and says whether it is fenced', () => {
  const census = village({ oak_fence: [{ x: 0, z: 0 }, { x: 4, z: 0 }] }, {
    farmAnimals: [
      { type: 'cow', position: { x: 1, y: 64, z: 1 } },
      { type: 'cow', position: { x: 2, y: 64, z: 1 } },
      { type: 'cow', position: { x: 3, y: 64, z: 1 }, baby: true },
      { type: 'sheep', position: { x: 0, y: 64, z: 40 } },
      villager(9, 9),
    ],
  });
  assert.equal(census.pens.length, 2);
  assert.deepEqual(census.pens.map(pen => pen.fenced), [true, false]);
  assert.deepEqual(census.pens[0].animals, [{ type: 'cow', adults: 2, babies: 1 }]);
  assert.deepEqual(census.pens[1].animals, [{ type: 'sheep', adults: 1, babies: 0 }]);
  assert.equal(census.counts.animals, 4, 'i villager non sono animali da cortile');
});

test('storage is ordered from the anchor and keeps what is known', () => {
  const census = village({ bell: [{ x: 0, z: 0 }] }, {
    anchor: { x: 0, y: 64, z: 0 },
    containers: [
      { position: { x: 9, y: 64, z: 0 }, type: 'chest', contents: { iron_ingot: 5 }, status: 'known' },
      { position: { x: 2, y: 64, z: 0 }, type: 'barrel', contentsKnown: false, status: 'known' },
    ],
  });
  assert.deepEqual(census.storage.map(row => row.position.x), [2, 9]);
  assert.equal(census.storage[0].contains, null, 'non ispezionato ≠ vuoto');
  assert.equal(census.storage[0].contentsKnown, false);
  assert.equal(census.storage[1].contains.iron_ingot, 5);
  assert.equal(census.storage[1].contentsKnown, true);
});

test('the cell budget truncates deterministically', () => {
  const census = village({ cobblestone: [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }] }, {
    limits: { maxCells: 3 },
  });
  assert.equal(census.survey.cells, 3);
  assert.equal(census.survey.dropped, 2);
  assert.equal(census.survey.truncated, true);
});

test('the same observation in another order is the same census', () => {
  const forward = village({
    bed: [{ x: 0, z: 0 }, { x: 2, z: 0 }],
    carrots: [{ x: 0, z: 4, mature: true }, { x: 1, z: 4, mature: false }],
  }, { farmAnimals: [villager(5, 5), villager(6, 5)] });

  const shuffled = surveyVillage({
    nearby: {
      carrots: [cells([{ x: 1, z: 4, mature: false }])[0], cells([{ x: 0, z: 4, mature: true }])[0]],
      bed: [cells([{ x: 2, z: 0 }])[0], cells([{ x: 0, z: 0 }])[0]],
    },
    farmAnimals: [villager(6, 5), villager(5, 5)],
  });

  assert.deepEqual(shuffled, forward);
});
