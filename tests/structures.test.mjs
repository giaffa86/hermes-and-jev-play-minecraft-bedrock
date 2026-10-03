import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectStructures, STRUCTURE_TYPES } from '../structures.mjs';

// Un istogramma come lo produce `BedrockWorld.surveyBlocks`: Map(nome → {count, first}).
const survey = (rows) => new Map(Object.entries(rows).map(([name, row]) => [name, { count: row.count, first: row.first ?? null }]));
const at = (x, y = 64, z = 10) => ({ first: { x, y, z } });

test('a village needs matching markers, not just beds', () => {
  const bedsOnly = detectStructures({ survey: survey({ oak_bed: { count: 6, ...at(10) } }) });
  assert.deepEqual(bedsOnly, [], 'un muro di letti non è un villaggio');

  // Bedrock scrive il letto come `bed` (senza colore): il caso live.
  const bedrockBeds = detectStructures({ survey: survey({ bed: { count: 30, ...at(10) }, grass_path: { count: 12, ...at(11) } }) });
  assert.deepEqual(bedrockBeds, [], 'letti e sentieri senza abitanti non bastano (3 < 5)');
  const bedrockVillage = detectStructures({
    survey: survey({ bed: { count: 30, ...at(10) }, grass_path: { count: 12, ...at(11) } }),
    entities: [{ type: 'villager_v2', position: { x: 9, y: 64, z: 9 } }, { type: 'villager_v2' }],
  });
  assert.deepEqual(bedrockVillage.map(s => s.type), ['village'], 'letti + sentiero + due abitanti sono un villaggio');
  assert.deepEqual(bedrockVillage[0].position, { x: 10, y: 64, z: 10 });

  const withBell = detectStructures({ survey: survey({ oak_bed: { count: 6, ...at(10) }, bell: { count: 1, ...at(12, 65, 14) } }) });
  assert.equal(withBell.length, 1);
  assert.equal(withBell[0].id, 'structure:village');
  assert.deepEqual(withBell[0].position, { x: 12, y: 65, z: 14 }, 'l\'ancora è il marker più specifico (la campana)');
  assert.ok(withBell[0].confidence > 0 && withBell[0].confidence <= 1);
  assert.deepEqual(withBell[0].evidence.matched, ['bell', 'beds']);
  assert.equal(withBell[0].evidence.blocks.beds, 6);

  const villagersOnly = detectStructures({ entities: [{ type: 'villager_v2', position: { x: 1, y: 64, z: 1 } }, { type: 'villager_v2' }] });
  assert.deepEqual(villagersOnly, [], 'senza blocchi di villaggio non basta il passaggio di due abitanti');
});

test('the evidence says what matched and what was missing', () => {
  const [village] = detectStructures({
    survey: survey({ oak_bed: { count: 2, ...at(4) }, composter: { count: 1, ...at(5) } }),
    entities: [{ type: 'villager', position: { x: 4, y: 64, z: 8 } }, { type: 'villager' }, { type: 'cat' }],
  });
  assert.equal(village.type, 'village');
  assert.equal(village.evidence.score, 6, 'beds 2 + workstations 1 + villagers 3');
  assert.deepEqual(village.evidence.matched, ['beds', 'workstations', 'villagers']);
  assert.deepEqual(village.evidence.missing, ['bell (0/1)']);
  assert.equal(village.evidence.entities.villagers, 2, 'la lista entità è contata per tipo, non per somiglianza');
  assert.deepEqual(village.position, { x: 4, y: 64, z: 10 }, 'senza campana l\'ancora scende ai letti');
});

test('underground markers resolve to the M6 targets', () => {
  const mineshaft = detectStructures({ survey: survey({ rail: { count: 4, ...at(20, 30, 20) }, cobweb: { count: 3, ...at(21, 30, 20) }, oak_planks: { count: 9, ...at(22, 30, 20) } }) });
  assert.deepEqual(mineshaft.map(s => s.type), ['mineshaft']);
  assert.deepEqual(mineshaft[0].position, { x: 20, y: 30, z: 20 });

  const city = detectStructures({ survey: survey({ sculk: { count: 40, ...at(0, -40, 0) }, sculk_shrieker: { count: 2, ...at(1, -40, 0) }, sculk_catalyst: { count: 1, ...at(2, -40, 0) } }) });
  assert.deepEqual(city.map(s => s.type), ['ancient_city']);

  const spawner = detectStructures({ survey: survey({ mob_spawner: { count: 1, ...at(7, 20, 7) } }) });
  assert.deepEqual(spawner.map(s => s.type), ['spawner'], 'uno spawner è già inequivocabile');

  const trial = detectStructures({ survey: survey({ trial_spawner: { count: 1, ...at(3, 0, 3) } }) });
  assert.deepEqual(trial.map(s => s.type), ['trial_chamber']);

  const geode = detectStructures({ survey: survey({ budding_amethyst: { count: 2, ...at(9, 10, 9) }, amethyst_cluster: { count: 3, ...at(9, 11, 9) } }) });
  assert.deepEqual(geode.map(s => s.type), ['amethyst_geode']);

  const cave = detectStructures({ survey: survey({ cave_air: { count: 64, ...at(5, 12, 5) } }) });
  assert.deepEqual(cave.map(s => s.type), ['cave'], 'cave_air per le palette che lo hanno');

  const cavity = detectStructures({ survey: survey({ air_below: { count: 120, ...at(5, 71, 5) } }) });
  assert.deepEqual(cavity.map(s => s.type), ['cave'], 'la cavità sotto i piedi è il caso Bedrock');
  assert.deepEqual(cavity[0].position, { x: 5, y: 71, z: 5 });
  assert.deepEqual(detectStructures({ survey: survey({ air_below: { count: 20, ...at(5, 71, 5) } }) }), [], 'poca aria sotto non è una cavità');
});

test('thresholds stay above noise and results are ordered by score', () => {
  assert.deepEqual(detectStructures({}), []);
  assert.deepEqual(detectStructures({ survey: new Map() }), []);
  assert.deepEqual(detectStructures({ survey: survey({ cobweb: { count: 1, ...at(0) } }) }), [], 'un solo cobweb non è una miniera');

  const both = detectStructures({ survey: survey({ bell: { count: 1, ...at(1) }, oak_bed: { count: 4, ...at(2) }, mob_spawner: { count: 1, ...at(3) } }) });
  assert.equal(both[0].type, 'village');
  assert.ok(both[0].evidence.score >= both[1].evidence.score);
  assert.deepEqual(STRUCTURE_TYPES.includes('village'), true);
});

test('a non-overworld dimension produces no overworld structures', () => {
  assert.deepEqual(detectStructures({ survey: survey({ mob_spawner: { count: 1, ...at(0) } }), dimension: 'nether' }), []);
  assert.equal(detectStructures({ survey: survey({ mob_spawner: { count: 1, ...at(0) } }), dimension: 'overworld' }).length, 1);
});

test('a nether fortress is read from nether bricks and needs more than one marker', () => {
  // Solo mattoni: 3 punti, sotto la soglia di 6. Un ponte di mattoni non è una
  // fortezza (e le fortezze vere hanno fioriere, spawner e blaze).
  const bricksOnly = detectStructures({
    survey: survey({ nether_brick: { count: 40, ...at(8) } }),
    dimension: 'nether',
  });
  assert.deepEqual(bricksOnly, [], 'i mattoni da soli non bastano (3 < 6)');

  const fortress = detectStructures({
    survey: survey({
      nether_brick: { count: 40, ...at(8) },
      nether_brick_fence: { count: 6, ...at(9) },
      mob_spawner: { count: 1, ...at(8, 70, 12) },
    }),
    entities: [{ type: 'blaze', position: { x: 8, y: 70, z: 14 } }],
    dimension: 'nether',
  });
  assert.deepEqual(fortress.map(s => s.type), ['nether_fortress']);
  assert.equal(fortress[0].id, 'structure:nether_fortress');
  assert.deepEqual(fortress[0].position, { x: 8, y: 70, z: 14 }, 'l\'ancora più specifica è il blaze');
  assert.ok(fortress[0].evidence.matched.includes('blazes'));
  assert.ok(fortress[0].evidence.matched.includes('nether bricks'));

  // `chiseled_nether_bricks` e le scale contano come finiture: da soli con i
  // mattoni restano a 5 punti, sotto la soglia; con la verruca del Nether si
  // supera (una fortezza viva ha anche le fioriere).
  const trimmed = detectStructures({
    survey: survey({
      nether_brick: { count: 20, ...at(1) },
      chiseled_nether_bricks: { count: 4, ...at(2) },
      nether_brick_stairs: { count: 2, ...at(3) },
    }),
    dimension: 'nether',
  });
  assert.deepEqual(trimmed, [], 'mattoni + finiture senza altri marker restano sotto la soglia (5 < 6)');
  const withWart = detectStructures({
    survey: survey({
      nether_brick: { count: 20, ...at(1) },
      chiseled_nether_bricks: { count: 4, ...at(2) },
      nether_brick_stairs: { count: 2, ...at(3) },
      nether_wart: { count: 3, ...at(2, 65, 12) },
    }),
    dimension: 'nether',
  });
  assert.deepEqual(withWart.map(s => s.type), ['nether_fortress'], 'mattoni + finiture + verruca raggiungono la soglia');
  assert.deepEqual(withWart[0].position, { x: 1, y: 64, z: 10 }, 'senza blaze/spawner l\'ancora è il primo marker di mattoni');

  // La stessa survey in Overworld non produce nulla: il def è del Nether.
  const overworld = detectStructures({
    survey: survey({ nether_brick: { count: 40, ...at(8) }, nether_brick_fence: { count: 6, ...at(9) } }),
    entities: [{ type: 'blaze', position: { x: 8, y: 70, z: 14 } }],
    dimension: 'overworld',
  });
  assert.deepEqual(overworld, []);
});
