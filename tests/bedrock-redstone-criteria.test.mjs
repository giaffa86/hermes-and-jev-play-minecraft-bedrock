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

test('circuitBuilt legge il report del cantiere e distingue un circuito preesistente', () => {
  const circuits = last => ({ circuits: { count: 8, buildable: [], declared: [], invalid: null, last: last ?? null, owned: 0 } });
  // Nessun report: si dice cosa manca.
  const none = evaluateCriteria({ circuitBuilt: { id: 'lamp_switch' } }, circuits(null));
  assert.equal(none.ok, false);
  assert.match(none.reason, /no circuit report/);

  // Un altro circuito non è quello richiesto.
  const other = evaluateCriteria({ circuitBuilt: { id: 'lamp_switch' } }, circuits({ id: 'delay_line', ok: true, at: 1000 }));
  assert.equal(other.ok, false);
  assert.match(other.reason, /last circuit is delay_line, not lamp_switch/);

  // Cantiere fallito: l'errore del cantiere finisce nel motivo.
  const failed = evaluateCriteria({ circuitBuilt: { id: 'lamp_switch' } }, circuits({ id: 'lamp_switch', ok: false, error: 'circuit_verify_failed', at: 1000 }));
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /circuit lamp_switch reported circuit_verify_failed/);

  // Costruito durante la skill: il report è nuovo rispetto a `before`.
  const before = circuits({ id: 'lamp_switch', ok: true, at: 1000 });
  const after = circuits({ id: 'lamp_switch', ok: true, at: 2000, steps: 2, delay: { measuredMs: 300 } });
  const built = evaluateCriteria({ circuitBuilt: { id: 'lamp_switch' } }, after, { before });
  assert.equal(built.ok, true);
  assert.equal(built.evidence.circuitBuilt, 'lamp_switch');
  assert.equal(built.evidence.circuitAt, 2000);
  assert.equal(built.evidence.circuitSteps, 2);
  assert.equal(built.evidence.circuitDelay, 300);

  // Lo stesso report che c'era già prima della skill non conta: nessun
  // successo per un circuito che qualcun altro (o il bot, prima) ha fatto.
  const stale = evaluateCriteria({ circuitBuilt: { id: 'lamp_switch' } }, before, { before });
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /already built before the skill started/);

  // `true` accetta qualunque circuito verificato; una stringa è l'id.
  assert.equal(evaluateCriteria({ circuitBuilt: true }, after, { before }).ok, true);
  assert.equal(evaluateCriteria({ circuitBuilt: 'lamp_switch' }, after, { before }).ok, true);
  assert.equal(evaluateCriteria({ circuitBuilt: 'delay_line' }, after, { before }).ok, false);
});

test('i criteri redstone sono parte del vocabolario validato', () => {
  assert.equal(CRITERIA_KEYS.includes('blockPoweredAt'), true);
  assert.equal(CRITERIA_KEYS.includes('circuitActive'), true);
  assert.equal(CRITERIA_KEYS.includes('circuitBuilt'), true);
  assert.deepEqual(validateCriteria({ blockPoweredAt: { x: 1, y: 2, z: 3 } }), []);
  assert.deepEqual(validateCriteria({ circuitActive: { atLeast: 1 } }), []);
  assert.deepEqual(validateCriteria({ circuitBuilt: { id: 'lamp_switch' } }), []);
  assert.deepEqual(validateCriteria({ blockPoweredAt: true }), [], 'la forma la controlla la valutazione, non il refuso del nome');
  assert.deepEqual(validateCriteria({ circutActive: true }), ['criteria: unknown criterion "circutActive"']);
});
