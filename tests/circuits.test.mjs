// Circuiti redstone (R3 di docs/wiki/redstone.md): validazione dei blueprint
// dichiarativi, rotazione delle celle, piano assoluto, sito libero e confronto
// delle proprietà attese con quello che il mondo riporta.
// Nessun server, nessun adapter: qui vive solo la parte pura.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CIRCUIT_FACINGS, FORWARD, addOffset, circuitAnchor, circuitSiteBlocked, checkCircuitSuccess,
  expectedDelayTicks, loadCircuits, placedAs, planCircuit, rotateOffset, validateCircuit, EMPTY_BLOCKS,
} from '../circuits.mjs';
import { facingMatches, normalizeFacing } from '../bedrock-redstone.mjs';

const block = (name, properties = {}) => ({ name, getProperties: () => properties });
const world = (cells) => (cell) => cells[`${cell.x},${cell.y},${cell.z}`] ?? null;

test('il catalogo caricato valida tutti i blueprint e dichiara cosa è costruibile', () => {
  const circuits = loadCircuits();
  assert.deepEqual([...circuits.keys()].sort(),
    ['auto_dispense', 'auto_door', 'auto_harvest', 'auto_lamp', 'crafter_pulse', 'delay_line', 'hopper_chain', 'lamp_switch']);
  const buildable = [...circuits.values()].filter(d => d.buildable).map(d => d.id).sort();
  assert.deepEqual(buildable, ['auto_door', 'auto_lamp', 'delay_line', 'lamp_switch']);
  for (const def of circuits.values()) {
    assert.equal(validateCircuit(def, def.id).length, 0, `${def.id} deve essere valido`);
    if (!def.buildable) {
      assert.equal(typeof def.blocked, 'string', `${def.id} dichiara perché non è costruibile`);
      assert.ok(def.blocked.length > 10);
    }
  }
});

test('validateCircuit elenca ogni problema strutturale con il passo che lo contiene', () => {
  const base = () => ({
    schemaVersion: 1,
    id: 'demo',
    description: 'demo circuit',
    requires: { lever: 1, redstone_lamp: 1 },
    steps: [
      { item: 'redstone_lamp', offset: [0, 0, 0] },
      { item: 'lever', offset: [0, 1, 0], supportOffset: [0, 0, 0] },
    ],
    trigger: { offset: [0, 1, 0] },
    success: [{ offset: [0, 0, 0], property: 'name', expected: 'lit_redstone_lamp' }],
  });
  const errors = (mutate) => {
    const def = base();
    mutate(def);
    return validateCircuit(def, 'demo').join('\n');
  };

  assert.equal(validateCircuit(base(), 'demo').length, 0);
  assert.match(errors(d => { delete d.id; }), /missing or invalid id/);
  assert.match(errors(d => { d.description = ''; }), /missing description/);
  assert.match(errors(d => { d.steps = []; }), /steps must be a non-empty array/);
  assert.match(errors(d => { d.steps[0].offset = [0, 1]; }), /offset must be \[x, y, z\] integers/);
  assert.match(errors(d => { d.steps[1].offset = [0, 0, 0]; }), /duplicate cell \[0,0,0\]/);
  assert.match(errors(d => { d.requires = { lever: 1 }; }), /steps need redstone_lamp but requires does not declare it/);
  assert.match(errors(d => { d.requires = { lever: 1, redstone_lamp: 1, cobblestone: 0 }; }), /requires.cobblestone: must be a positive integer/);
  assert.match(errors(d => { d.steps[0].item = 'tnt'; d.requires = { lever: 1, tnt: 1 }; }), /dangerous item "tnt"/);
  assert.match(errors(d => { d.trigger = { offset: [3, 3, 3] }; }), /no step places \[3,3,3\]/);
  assert.match(errors(d => { d.success[0].offset = [2, 0, 0]; }), /success\[0\]: no step places \[2,0,0\]/);
  assert.match(errors(d => { d.post = [{ action: 'explode', offset: [0, 0, 0] }]; }), /post\[0\]: unknown action "explode"/);
  assert.match(errors(d => { d.post = [{ action: 'set_repeater_delay', offset: [0, 0, 0], delay: 9 }]; }), /post\[0\]: \[0,0,0\] is redstone_lamp, not a repeater/);
});

test('un supporto piazzato dopo il passo che lo usa è un piano impossibile', () => {
  const def = {
    id: 'order',
    description: 'wrong order',
    requires: { stone: 1, lever: 1 },
    steps: [
      { item: 'lever', offset: [0, 1, 0], supportOffset: [0, 0, 0] },
      { item: 'stone', offset: [0, 0, 0] },
    ],
  };
  const errors = validateCircuit(def, 'order');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /steps\[0\]: support \[0,0,0\] must be placed before this step \(order 1\)/);
});

test('la rotazione è rigida: avanti e destra seguono la direzione', () => {
  for (const facing of CIRCUIT_FACINGS) {
    const forward = addOffset({ x: 0, y: 0, z: 0 }, [0, 0, 1], facing);
    assert.deepEqual({ x: forward.x, z: forward.z }, FORWARD[facing], `avanti di ${facing}`);
    const right = addOffset({ x: 0, y: 0, z: 0 }, [1, 0, 0], facing);
    const f = FORWARD[facing];
    assert.deepEqual({ x: right.x, z: right.z }, { x: f.z, z: f.x }, `destra di ${facing} (nessuno specchio)`);
    assert.equal(addOffset({ x: 0, y: 0, z: 0 }, [0, 5, 0], facing).y, 5, 'la quota non ruota');
  }
  assert.deepEqual(rotateOffset([2, 1, 3], 'north'), [-2, 1, -3]);
  assert.equal(rotateOffset([1, 0, 0], 'diagonal'), null);
  // La direzione dichiarata nei blueprint è normalizzata come quella letta dal
  // mondo: il confronto usa la stessa funzione di R1.
  assert.equal(facingMatches(normalizeFacing('south'), 'south'), true);
});

test('circuitAnchor punta la cella davanti ai piedi', () => {
  assert.deepEqual(circuitAnchor({ x: 10.5, y: 64, z: 10.5 }, 'south'), { x: 10, y: 64, z: 11 });
  assert.deepEqual(circuitAnchor({ x: 10.5, y: 64, z: 10.5 }, 'north'), { x: 10, y: 64, z: 9 });
  assert.deepEqual(circuitAnchor({ x: 10.5, y: 64.9, z: 10.5 }, 'east'), { x: 11, y: 64, z: 10 });
  assert.deepEqual(circuitAnchor(undefined, 'south'), { x: 0, y: 0, z: 1 });
});

test('planCircuit porta le celle relative in celle assolute, con supporti e trigger', () => {
  const circuits = loadCircuits();
  const lamp = circuits.get('lamp_switch');
  const plan = planCircuit(lamp, { origin: { x: 10, y: 64, z: 20 }, facing: 'east', available: { redstone_lamp: 1, lever: 1 } });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.missing, []);
  assert.deepEqual(plan.steps.map(s => s.cell), [{ x: 10, y: 64, z: 20 }, { x: 10, y: 65, z: 20 }]);
  assert.deepEqual(plan.steps.map(s => s.support), [{ x: 10, y: 63, z: 20 }, { x: 10, y: 64, z: 20 }]);
  assert.deepEqual(plan.trigger, { cell: { x: 10, y: 65, z: 20 }, item: 'lever', label: 'lever' });
  assert.deepEqual(plan.success.map(s => s.cell), [{ x: 10, y: 65, z: 20 }, { x: 10, y: 64, z: 20 }]);

  const poor = planCircuit(lamp, { origin: { x: 0, y: 64, z: 0 }, facing: 'south', available: { lever: 2 } });
  assert.equal(poor.ok, false);
  assert.deepEqual(poor.missing, [{ item: 'redstone_lamp', need: 1, have: 0 }]);
  assert.equal(poor.need.lever, 1);

  const delay = planCircuit(circuits.get('delay_line'), { origin: { x: 0, y: 64, z: 0 }, facing: 'south', available: { cobblestone: 1, lever: 1, repeater: 3, redstone_lamp: 1 } });
  assert.equal(delay.post.length, 3);
  assert.deepEqual(delay.steps.map(s => s.cell.z), [0, 0, 1, 2, 3, 4]);
  assert.equal(delay.steps[2].block, 'unpowered_repeater', 'il repeater si piazza con il nome del blocco, non dell\'oggetto');
  assert.equal(delay.steps[2].facing, 'south');
  assert.equal(placedAs('repeater'), 'unpowered_repeater');
  assert.equal(placedAs('lever'), 'lever');
  assert.equal(planCircuit(null).error, 'unknown_circuit');
  assert.equal(planCircuit(lamp, { facing: 'up' }).error, 'unknown_facing');
});

test('circuitSiteBlocked distingue cella occupata, supporto assente e blocco usabile', () => {
  const circuits = loadCircuits();
  const lamp = circuits.get('lamp_switch');
  const plan = planCircuit(lamp, { origin: { x: 0, y: 64, z: 0 }, facing: 'south', available: { redstone_lamp: 1, lever: 1 } });
  const floor = { '0,63,0': block('stone'), '0,63,1': block('stone') };

  assert.deepEqual(circuitSiteBlocked(plan, world(floor)), []);
  const occupied = circuitSiteBlocked(plan, world({ ...floor, '0,64,0': block('oak_planks') }));
  assert.equal(occupied.length, 1);
  assert.deepEqual({ reason: occupied[0].reason, cell: occupied[0].cell, name: occupied[0].name },
    { reason: 'occupied', cell: { x: 0, y: 64, z: 0 }, name: 'oak_planks' });

  const noSupport = circuitSiteBlocked(plan, world({ '0,63,1': block('stone') }));
  assert.deepEqual(noSupport.map(b => b.reason), ['no_support']);
  assert.equal(noSupport[0].cell.y, 63, 'manca il terreno sotto la lampada');
  assert.equal(noSupport[0].label, 'lamp');

  const usable = circuitSiteBlocked(plan, world({ '0,63,0': block('chest'), '0,63,1': block('stone') }));
  assert.deepEqual(usable.map(b => b.reason), ['usable_block']);
  assert.equal(usable[0].name, 'chest', 'cliccare un baule lo apre invece di piazzarci sopra');
  assert.equal(EMPTY_BLOCKS.has('cave_air'), true);
});

test('checkCircuitSuccess legge il mondo e non passa mai su un dato mancante', () => {
  const circuits = loadCircuits();
  const lamp = circuits.get('lamp_switch');
  const origin = { x: 0, y: 64, z: 0 };
  const lit = world({
    '0,64,0': block('lit_redstone_lamp'),
    '0,65,0': block('lever', { open_bit: true }),
  });
  const ok = checkCircuitSuccess(lamp, { origin, facing: 'south', read: lit });
  assert.equal(ok.ok, true);
  assert.equal(ok.empty, false);
  assert.deepEqual(ok.checks.map(c => c.ok), [true, true]);

  const unlit = world({ '0,64,0': block('redstone_lamp'), '0,65,0': block('lever', { open_bit: false }) });
  const bad = checkCircuitSuccess(lamp, { origin, facing: 'south', read: unlit });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.checks.map(c => c.error), ['value_mismatch', 'value_mismatch']);
  assert.deepEqual(bad.checks.map(c => c.actual), [false, 'redstone_lamp']);

  const missing = checkCircuitSuccess(lamp, { origin, facing: 'south', read: () => null });
  assert.deepEqual(missing.checks.map(c => c.error), ['no_block', 'no_block']);
  assert.equal(missing.ok, false);

  const unreadable = checkCircuitSuccess(lamp, {
    origin, facing: 'south',
    read: world({ '0,64,0': block('redstone_lamp'), '0,65,0': { name: 'lever' } }),
  });
  assert.equal(unreadable.checks[0].error, 'property_unreadable', 'senza stato leggibile non si dichiara il successo');
  assert.equal(unreadable.checks[1].error, 'value_mismatch');

  // Un circuito dichiarato senza check non è "verificato": lo dice il campo.
  const auto = checkCircuitSuccess(circuits.get('auto_lamp'), { origin, facing: 'south', read: lit });
  assert.equal(auto.empty, true);
  assert.equal(auto.ok, false, 'empty non è un successo');
});

test('expectedDelayTicks somma i ritardi dichiarati', () => {
  const delay = loadCircuits().get('delay_line');
  assert.equal(expectedDelayTicks(delay), 6);
  assert.equal(expectedDelayTicks({ post: [] }), null);
  assert.equal(expectedDelayTicks({ post: [{ delay: 0 }], measure: { expectedTicks: 11 } }), 11);
});

test('loadCircuits fallisce al load con il motivo di un blueprint rotto', () => {
  const dir = mkdtempSync(join(tmpdir(), 'circuits-'));
  writeFileSync(join(dir, 'broken.json'), JSON.stringify({ id: 'broken', description: 'x', requires: {}, steps: [] }));
  const error = (() => { try { loadCircuits(dir); return null; } catch (e) { return e; } })();
  assert.ok(error, 'un blueprint rotto deve fallire all\'avvio');
  assert.match(error.message, /invalid circuits:/);
  assert.match(error.message, /broken: missing requires|broken: steps must be a non-empty array/);

  const twin = mkdtempSync(join(tmpdir(), 'circuits-'));
  const def = { id: 'twin', description: 'dup', requires: { lever: 1 }, steps: [{ item: 'lever', offset: [0, 0, 0] }] };
  writeFileSync(join(twin, 'a.json'), JSON.stringify(def));
  writeFileSync(join(twin, 'b.json'), JSON.stringify(def));
  const dup = (() => { try { loadCircuits(twin); return null; } catch (e) { return e; } })();
  assert.match(dup.message, /duplicate circuit id "twin"/);
});
