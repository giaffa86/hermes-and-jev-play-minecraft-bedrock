// Redstone (R2 di docs/wiki/redstone.md): criteri del verifier per un circuito.
// `blockPoweredAt` legge una cella esatta, `circuitActive` riassume il circuito:
// entrambi falliscono rumorosamente quando lo stato non è leggibile, come i
// criteri dei fluidi (un dato mancante non è un successo).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCriteria, validateCriteria, CRITERIA_KEYS } from '../survival/verify.mjs';

const observation = (redstone = null) => ({ inventory: {}, position: { x: 0, y: 71, z: 0 }, redstone });

test('blockPoweredAt legge la potenza di una cella esatta', () => {
  const obs = observation({
    components: [
      { name: 'lever', position: { x: 2, y: 71, z: 0 }, power: 15 },
      { name: 'redstone_lamp', position: { x: 3, y: 71, z: 0 }, power: 0 },
    ],
    power: [{ name: 'lever', position: { x: 2, y: 71, z: 0 }, signal: 15 }],
  });
  const powered = evaluateCriteria({ blockPoweredAt: { x: 2, y: 71, z: 0 } }, obs);
  assert.equal(powered.ok, true);
  assert.deepEqual(powered.evidence.redstoneAt, { name: 'lever', power: 15 });

  const unpowered = evaluateCriteria({ blockPoweredAt: { x: 3, y: 71, z: 0 } }, obs);
  assert.equal(unpowered.ok, false);
  assert.match(unpowered.reason, /power 0 < 1/);

  const atLeast = evaluateCriteria({ blockPoweredAt: { x: 2, y: 71, z: 0, atLeast: 15 } }, obs);
  assert.equal(atLeast.ok, true);
  const tooMuch = evaluateCriteria({ blockPoweredAt: { x: 2, y: 71, z: 0, atLeast: 16 } }, obs);
  assert.equal(tooMuch.ok, false);

  // Cella vuota: il criterio dice cosa manca, non passa per assenza.
  const missing = evaluateCriteria({ blockPoweredAt: { x: 9, y: 71, z: 0 } }, obs);
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /no redstone component at 9,71,0/);
});

test('blockPoweredAt non dichiara successo su una potenza illeggibile', () => {
  const obs = observation({ components: [{ name: 'redstone_wire', position: { x: 2, y: 71, z: 0 }, power: null }] });
  const result = evaluateCriteria({ blockPoweredAt: { x: 2, y: 71, z: 0 } }, obs);
  assert.equal(result.ok, false);
  assert.match(result.reason, /power unknown/);
});

test('circuitActive passa con un output acceso o con un segnale, fallisce senza dati', () => {
  const lampOn = observation({
    components: [{ name: 'lit_redstone_lamp', position: { x: 3, y: 71, z: 0 }, power: 15 }],
    power: [{ name: 'lever', position: { x: 2, y: 71, z: 0 }, signal: 15 }],
    activeOutputs: [{ name: 'lit_redstone_lamp', position: { x: 3, y: 71, z: 0 }, power: 15 }],
  });
  const active = evaluateCriteria({ circuitActive: true }, lampOn);
  assert.equal(active.ok, true);
  assert.deepEqual(active.evidence.redstoneActiveOutputs, ['lit_redstone_lamp']);
  assert.equal(active.evidence.redstoneMaxPower, 15);

  // Solo un segnale, nessun output acceso: il circuito è attivo lo stesso (il
  // criterio chiede "c'è tensione", non "c'è una lampada").
  const wireOnly = observation({ components: [], power: [{ name: 'redstone_wire', position: { x: 1, y: 71, z: 0 }, signal: 7 }] });
  const signal = evaluateCriteria({ circuitActive: true }, wireOnly);
  assert.equal(signal.ok, true);
  const higher = evaluateCriteria({ circuitActive: { atLeast: 8 } }, wireOnly);
  assert.equal(higher.ok, false);
  assert.match(higher.reason, /max power 7 < 8/);

  // Inverso: serve che il circuito sia spento.
  const off = observation({ components: [], power: [], activeOutputs: [] });
  assert.equal(evaluateCriteria({ circuitActive: false }, off).ok, true);
  assert.equal(evaluateCriteria({ circuitActive: false }, lampOn).ok, false);

  // Nessun dato redstone nell'osservazione: mai successo.
  const blind = evaluateCriteria({ circuitActive: true }, observation(null));
  assert.equal(blind.ok, false);
  assert.match(blind.reason, /redstone state unknown/);
  const dark = observation({ components: [], power: [], activeOutputs: [] });
  const noSignal = evaluateCriteria({ circuitActive: true }, dark);
  assert.equal(noSignal.ok, false);
  assert.match(noSignal.reason, /no readable redstone signal/);
});

test('i criteri redstone sono parte del vocabolario validato', () => {
  assert.equal(CRITERIA_KEYS.includes('blockPoweredAt'), true);
  assert.equal(CRITERIA_KEYS.includes('circuitActive'), true);
  assert.deepEqual(validateCriteria({ blockPoweredAt: { x: 1, y: 2, z: 3 } }), []);
  assert.deepEqual(validateCriteria({ circuitActive: { atLeast: 1 } }), []);
  assert.deepEqual(validateCriteria({ blockPoweredAt: true }), [], 'la forma la controlla la valutazione, non il refuso del nome');
  assert.deepEqual(validateCriteria({ circutActive: true }), ['criteria: unknown criterion "circutActive"']);
});
