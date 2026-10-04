// Fluid awareness (M0): classificazione di acqua/lava, censimento, verdetto di
// pericolo, fuga dalla lava e rischio di scavo. Modulo puro, nessun server.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isWaterBlock, isLavaBlock, isFluidBlock, fluidKind, normalizeFluidName,
  summarizeFluids, fluidCells, fluidHazard, rankEscapeCells, digFluidRisk,
  swimInputFlags, deepWaterColumns,
  AIR_CRITICAL, LAVA_NEAR_RANGE,
} from '../bedrock-fluids.mjs';

const at = (x, y, z) => ({ x, y, z });

test('swimInputFlags: lo stato di nuoto dichiarato al server (M1)', () => {
  // La testa entra in acqua: la transizione si annuncia una volta sola.
  assert.deepEqual(swimInputFlags({ headInWater: true }), ['start_swimming']);
  // Già in nuoto: sneak = discesa rapida, salto = risalita (regole della sessione umana).
  assert.deepEqual(swimInputFlags({ headInWater: true, swimming: true, wantDown: true }), ['want_down', 'down']);
  assert.deepEqual(swimInputFlags({ headInWater: true, swimming: true, wantUp: true }), ['want_up', 'jumping']);
  // La testa esce: fine del nuoto.
  assert.deepEqual(swimInputFlags({ inWater: true, swimming: true }), ['stop_swimming']);
  // Guado con il salto premuto: è la risalita sui blocchi della riva.
  assert.deepEqual(swimInputFlags({ inWater: true, wantUp: true }), ['auto_jumping_in_water', 'jumping']);
  // A secco non si dichiara nulla: nessun flag inventato.
  assert.deepEqual(swimInputFlags({}), []);
  assert.deepEqual(swimInputFlags({ wantUp: true, wantDown: true }), []);
});

test('fluidKind classifies water, lava and everything else', () => {
  assert.equal(fluidKind('water'), 'water');
  assert.equal(fluidKind('flowing_water'), 'water');
  assert.equal(fluidKind('still_water'), 'water');
  assert.equal(fluidKind('minecraft:water'), 'water');
  assert.equal(fluidKind('lava'), 'lava');
  assert.equal(fluidKind('flowing_lava'), 'lava');
  assert.equal(fluidKind('minecraft:flowing_lava'), 'lava');
  assert.equal(fluidKind('stone'), null);
  assert.equal(fluidKind('air'), null);
  // Un hash non risolto non è un fluido: la fisica locale lo tratta come solido.
  assert.equal(fluidKind('unknown'), null);
  assert.equal(fluidKind(null), null);
  assert.equal(normalizeFluidName('MineCraft:LAVA'), 'lava');
});

test('isWaterBlock/isLavaBlock/isFluidBlock agree with fluidKind', () => {
  assert.equal(isWaterBlock('flowing_water'), true);
  assert.equal(isLavaBlock('flowing_water'), false);
  assert.equal(isLavaBlock('lava'), true);
  assert.equal(isWaterBlock('lava'), false);
  assert.equal(isFluidBlock('water'), true);
  assert.equal(isFluidBlock('lava'), true);
  assert.equal(isFluidBlock('dirt'), false);
});

test('summarizeFluids counts cells and finds the nearest per kind', () => {
  const fluids = summarizeFluids([
    { name: 'water', position: at(5, 62, 0) },
    { name: 'flowing_water', position: at(2, 62, 0) },
    { name: 'lava', position: at(0, 60, 9) },
    { name: 'lava', position: at(0, 60, 3) },
    { name: 'stone', position: at(1, 60, 1) },
    { name: 'water', position: null },
  ], at(0, 64, 0));
  assert.equal(fluids.water.count, 2);
  assert.equal(fluids.lava.count, 2);
  assert.deepEqual(fluids.water.nearest.position, at(2, 62, 0));
  assert.equal(fluids.water.nearest.distance, 2.8);
  assert.deepEqual(fluids.lava.nearest.position, at(0, 60, 3));
  assert.equal(fluids.lavaDistance, 5);
  assert.equal(summarizeFluids([], at(0, 64, 0)).lavaDistance, null);
});

test('fluidCells splits positions by kind', () => {
  const cells = fluidCells([
    { name: 'water', position: at(1, 2, 3) },
    { name: 'lava', position: at(4, 5, 6) },
    { name: 'unknown', position: at(7, 8, 9) },
  ]);
  assert.deepEqual(cells.water, [at(1, 2, 3)]);
  assert.deepEqual(cells.lava, [at(4, 5, 6)]);
});

test('fluidHazard grades lava, water and drowning without inventing alarms', () => {
  assert.equal(fluidHazard({}).level, 'none');
  assert.deepEqual(fluidHazard({ inLava: true }), { level: 'critical', reasons: ['in_lava'] });
  assert.deepEqual(fluidHazard({ lavaDistance: 1.5 }), { level: 'critical', reasons: ['lava_adjacent'] });
  assert.deepEqual(fluidHazard({ lavaDistance: LAVA_NEAR_RANGE }), { level: 'high', reasons: ['lava_near'] });
  assert.deepEqual(fluidHazard({ lavaDistance: 8 }), { level: 'medium', reasons: ['lava_in_range'] });
  assert.deepEqual(fluidHazard({ inWater: true }), { level: 'low', reasons: ['in_water'] });

  // L'aria è ignota in M0: nessun allarme di annegamento dichiarato per finta.
  assert.deepEqual(fluidHazard({ headInWater: true }), { level: 'low', reasons: ['head_underwater'] });
  // Quando il budget d'aria esiste (M2) la regola diventa letale.
  assert.deepEqual(fluidHazard({ headInWater: true, air: AIR_CRITICAL }), { level: 'critical', reasons: ['drowning'] });
  assert.equal(fluidHazard({ headInWater: true, air: AIR_CRITICAL + 1 }).level, 'low');

  // La lava vince sull'acqua.
  assert.equal(fluidHazard({ inWater: true, inLava: true }).level, 'critical');
});

test('rankEscapeCells prefers the cell gaining the most distance from lava', () => {
  const from = at(0, 64, 0);
  const hazards = [at(10, 64, 0)];
  // Il bot è a 0, la lava a 10: fuggire significa andare in -x.
  const ranked = rankEscapeCells([at(-12, 64, 0), at(-5, 64, 0)], { from, hazards });
  assert.deepEqual(ranked.map(r => r.cell), [at(-12, 64, 0), at(-5, 64, 0)]);
  assert.equal(ranked[0].gain, 12);
  assert.equal(ranked[0].hazardDistance, 22);
  assert.equal(ranked[0].distance, 12);

  // Verso la lava il guadagno è negativo: non è una fuga.
  assert.deepEqual(rankEscapeCells([at(11, 64, 0), at(8, 64, 0)], { from, hazards }), []);
  // Sotto il guadagno minimo (default 1.5) una cella non conta come fuga…
  assert.deepEqual(rankEscapeCells([at(9, 64, 0)], { from, hazards }), []);
  // …ma con la soglia abbassata entra, restando dietro a chi guadagna di più.
  const relaxed = rankEscapeCells([at(-4, 64, 0), at(-6, 64, 0), at(9, 64, 0)], { from, hazards, minGain: 0.5 });
  assert.deepEqual(relaxed.map(r => r.cell), [at(-6, 64, 0), at(-4, 64, 0)]);
});

test('rankEscapeCells uses the nearest of several hazards and respects the limit', () => {
  const from = at(0, 64, 0);
  const hazards = [at(10, 64, 0), at(0, 64, 10)];
  const ranked = rankEscapeCells([at(-12, 64, 0), at(0, 64, -12), at(-12, 64, -12)], { from, hazards });
  assert.equal(ranked.length, 3);
  // La distanza dal pericolo più vicino decide: le due diagonali vincono.
  assert.deepEqual(ranked.map(r => r.cell), [at(-12, 64, -12), at(-12, 64, 0), at(0, 64, -12)]);
  assert.equal(ranked[0].gain, 15.06);
  assert.deepEqual(rankEscapeCells([at(-12, 64, 0)], { from, hazards, limit: 1 }).length, 1);
  assert.deepEqual(rankEscapeCells([at(-12, 64, 0)], { from, hazards: [] }), []);
  assert.deepEqual(rankEscapeCells([], { from, hazards }), []);
  assert.deepEqual(rankEscapeCells([{ x: 1 }], { from, hazards }), []);
});

test('digFluidRisk refuses a dig that would open into lava (or water when asked)', () => {
  const stone = { name: 'stone', position: at(1, 64, 0) };
  const water = { name: 'water', position: at(1, 64, 0) };
  const lava = { name: 'flowing_lava', position: at(1, 64, 0) };

  assert.deepEqual(digFluidRisk({ neighbors: [stone, stone] }), { unsafe: false, reason: null, block: null, position: null });
  assert.deepEqual(digFluidRisk({ neighbors: [stone, lava] }), {
    unsafe: true, reason: 'lava_adjacent', block: 'flowing_lava', position: at(1, 64, 0),
  });
  // L'acqua è ammessa di default (una pozza accanto non brucia)…
  assert.equal(digFluidRisk({ neighbors: [water] }).unsafe, false);
  // …ma rifiutata quando lo scavo è una scala/discesa (allagherebbe il buco).
  assert.deepEqual(digFluidRisk({ neighbors: [water], avoidWater: true }), {
    unsafe: true, reason: 'water_adjacent', block: 'water', position: at(1, 64, 0),
  });
  // La lava ha la precedenza sull'acqua.
  assert.equal(digFluidRisk({ neighbors: [water, lava], avoidWater: true }).reason, 'lava_adjacent');
  assert.equal(digFluidRisk({}).unsafe, false);
});

test('deepWaterColumns: la cella più vicina non è dove si può nuotare (M1)', () => {
  // Colonna profonda in (0,68..71,z=0), pozza di una cella in (5,70,0),
  // e una colonna che il mondo non ha caricato oltre (2,70,0).
  const world = new Map([
    ['0,68,0', 'water'], ['0,69,0', 'water'], ['0,70,0', 'water'], ['0,71,0', 'water'],
    ['0,72,0', 'air'], ['0,67,0', 'stone'],
    ['5,70,0', 'water'], ['5,71,0', 'air'], ['5,69,0', 'stone'],
    ['2,70,0', 'water'],
  ]);
  const blockAt = ({ x, y, z }) => {
    const name = world.get(`${x},${y},${z}`);
    return name ? { name } : null;
  };
  const cells = [{ x: 0, y: 70, z: 0 }, { x: 5, y: 70, z: 0 }, { x: 2, y: 70, z: 0 }];
  const deep = deepWaterColumns(cells, { blockAt, minDepth: 2, limit: 4 });
  assert.equal(deep.length, 1, 'solo la colonna di 4 celle è profonda');
  assert.equal(deep[0].depth, 4);
  assert.deepEqual(deep[0].position, at(0, 68, 0), 'la posizione è il fondo della colonna');
  assert.equal(deep[0].top, 71);
  // La pozza di una cella e la colonna non caricata non si dichiarano profonde.
  assert.equal(deepWaterColumns([{ x: 5, y: 70, z: 0 }], { blockAt }).length, 0);
  assert.equal(deepWaterColumns([{ x: 2, y: 70, z: 0 }], { blockAt }).length, 0);
  // Senza mondo (nessun `blockAt`) non si inventa nulla: la cella vale per sé,
  // quindi con la soglia di default non è "profonda" e non viene dichiarata tale.
  assert.deepEqual(deepWaterColumns([{ x: 5, y: 70, z: 0 }], {}), []);
  assert.deepEqual(deepWaterColumns([{ x: 5, y: 70, z: 0 }], { minDepth: 1 }), [{
    position: at(5, 70, 0), top: 70, bottom: 70, depth: 1,
  }]);
});

test('deepWaterColumns: ordina per profondità e limita il numero di colonne (M1)', () => {
  const world = new Map([
    ['0,68,0', 'water'], ['0,69,0', 'water'], ['0,70,0', 'water'],
    ['1,70,0', 'water'], ['1,71,0', 'water'], ['1,72,0', 'water'], ['1,73,0', 'water'],
    ['2,69,0', 'water'], ['2,70,0', 'water'],
  ]);
  const blockAt = ({ x, y, z }) => {
    const name = world.get(`${x},${y},${z}`);
    return name ? { name } : null;
  };
  const cells = [
    { x: 0, y: 70, z: 0 }, { x: 0, y: 68, z: 0 },
    { x: 1, y: 72, z: 0 }, { x: 2, y: 70, z: 0 },
  ];
  const deep = deepWaterColumns(cells, { blockAt, limit: 2 });
  assert.deepEqual(deep.map(c => [c.position.x, c.depth]), [[1, 4], [0, 3]], 'una voce per colonna, la più profonda prima');
  // Una cella non valida (senza coordinate) non fa esplodere la misura.
  assert.deepEqual(deepWaterColumns([null, {}, { x: 1, y: 72, z: 0 }], { blockAt, limit: 1 }).length, 1);
});

test('deepWaterColumns: con un punto di riferimento conta la vicinanza, non la profondità (M1)', () => {
  // Il caso live del 04/10: il bot sull'argine dello stagno aveva accanto colonne
  // di **due** celle, mentre le colonne profonde del censimento erano a venti
  // blocchi (il pozzo allagato). Ordinando per profondità e troncando con `limit`
  // lo stagno spariva dalla lista — e `enterWater` rispondeva `no_deep_water` con
  // l'acqua a due blocchi.
  const world = new Map([
    ['0,73,0', 'water'], ['0,74,0', 'water'],
    ['20,42,0', 'water'], ['20,43,0', 'water'], ['20,44,0', 'water'], ['20,45,0', 'water'],
    ['20,46,0', 'water'], ['20,47,0', 'water'], ['20,48,0', 'water'],
  ]);
  const blockAt = ({ x, y, z }) => {
    const name = world.get(`${x},${y},${z}`);
    return name ? { name } : { name: 'stone' };
  };
  const cells = [{ x: 0, y: 74, z: 0 }, { x: 20, y: 45, z: 0 }];
  const byDepth = deepWaterColumns(cells, { blockAt, minDepth: 2, limit: 1 });
  assert.deepEqual(byDepth.map(c => [c.position.x, c.depth]), [[20, 7]], 'senza riferimento vince la più profonda');

  const from = { x: 0.5, y: 76, z: 0.5 };
  const near = deepWaterColumns(cells, { blockAt, minDepth: 2, limit: 1, from, maxDistance: 6 });
  assert.deepEqual(near.map(c => [c.position.x, c.depth, c.distance]), [[0, 2, 0]], 'col riferimento vince la più vicina');
  assert.equal(near[0].top, 74, 'la cella d\'ingresso è la superficie');
  // Fuori portata non si promette nulla: nessuna colonna entra nella lista.
  assert.deepEqual(deepWaterColumns(cells, { blockAt, minDepth: 2, from: { x: 100.5, z: 100.5 }, maxDistance: 4 }), []);
});
