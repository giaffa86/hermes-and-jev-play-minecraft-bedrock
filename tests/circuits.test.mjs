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
  measureCircuitDelay, TICK_MS, DEFAULT_DELAY_TOLERANCE_MS,
  FORBIDDEN_BLOCKS, MAX_CIRCUIT_COMPONENTS, MIN_CLOCK_TICKS, botCells, circuitSafety, forbiddenBlock, pistonPath,
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

test('measureCircuitDelay misura dagli aggiornamenti del server e non inventa nulla', () => {
  const output = { x: 0, y: 71, z: 5 };
  const expectedTicks = 6;
  const triggeredAt = 10_000;
  const quiet = measureCircuitDelay({ trace: [], cell: output, triggeredAt, expectedTicks });
  assert.equal(quiet.measuredMs, null);
  assert.equal(quiet.ok, null, 'senza campioni non è un successo');
  assert.equal(quiet.expectedMs, expectedTicks * TICK_MS);
  assert.equal(quiet.toleranceMs, DEFAULT_DELAY_TOLERANCE_MS);

  const onTime = measureCircuitDelay({
    trace: [
      { position: { x: 2, y: 71, z: 2 }, name: 'lit_redstone_lamp', at: 10_010 },
      { position: { ...output }, name: 'lit_redstone_lamp', at: triggeredAt + 300 },
    ],
    cell: output,
    triggeredAt,
    expectedTicks,
  });
  assert.equal(onTime.measuredMs, 300);
  assert.equal(onTime.measuredTicks, 6);
  assert.equal(onTime.ok, true);
  assert.equal(onTime.samples, 1, 'altre celle non contano come campioni');

  const late = measureCircuitDelay({
    trace: [{ position: { ...output }, name: 'lit_redstone_lamp', at: triggeredAt + 900 }],
    cell: output,
    triggeredAt,
    expectedTicks,
  });
  assert.equal(late.ok, false);
  assert.equal(late.measuredMs, 900);

  const before = measureCircuitDelay({
    trace: [{ position: { ...output }, name: 'lit_redstone_lamp', at: triggeredAt - 5 }],
    cell: output,
    triggeredAt,
    expectedTicks,
  });
  assert.equal(before.measuredMs, null, 'un cambio precedente al trigger non è la risposta del circuito');
  assert.equal(before.samples, 0);
});

test('validateCircuit controlla anche il blocco measure', () => {
  const base = {
    id: 'm',
    description: 'misura',
    requires: { lever: 1, redstone_lamp: 1 },
    steps: [{ item: 'lever', offset: [0, 0, 0] }, { item: 'redstone_lamp', offset: [0, 0, 1] }],
  };
  const bad = validateCircuit({ ...base, measure: { expectedTicks: 6, required: true, toleranceMs: -1 } });
  assert.ok(bad.some(e => /measure\.toleranceMs/.test(e)));
  assert.ok(bad.some(e => /measure\.outputOffset/.test(e)), 'required senza outputOffset non si può verificare');

  const outside = validateCircuit({ ...base, measure: { expectedTicks: 6, outputOffset: [0, 0, 7] } });
  assert.ok(outside.some(e => /measure\.outputOffset: no step places \[0,0,7\]/.test(e)));

  const ok = validateCircuit({ ...base, measure: { expectedTicks: 6, outputOffset: [0, 0, 1], required: true, toleranceMs: 60 } });
  assert.deepEqual(ok, []);
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

// --- R6: limiti e sicurezza -------------------------------------------------

test('R6: forbiddenBlock riconosce trappole, blocchi di comando e lava', () => {
  assert.equal(forbiddenBlock('tnt'), 'tnt');
  assert.equal(forbiddenBlock('minecraft:tnt'), 'tnt');
  assert.equal(forbiddenBlock('TNT'), 'tnt');
  assert.equal(forbiddenBlock('command_block'), 'command_block');
  assert.equal(forbiddenBlock('chain_command_block'), 'chain_command_block');
  assert.equal(forbiddenBlock('repeating_command_block'), 'repeating_command_block');
  assert.equal(forbiddenBlock('respawn_anchor'), 'respawn_anchor');
  assert.equal(forbiddenBlock('lava'), 'lava');
  assert.equal(forbiddenBlock('lever'), null);
  assert.equal(forbiddenBlock('redstone_lamp'), null);
  assert.equal(forbiddenBlock('obsidian'), null);
  assert.equal(forbiddenBlock(null), null);
  for (const name of ['tnt', 'trapped_chest', 'command_block', 'barrier', 'bedrock', 'end_crystal']) {
    assert.equal(FORBIDDEN_BLOCKS.has(name), true, `${name} deve essere vietato`);
  }
});

// Un blueprint di prova ben formato: leva su un blocco di cobblestone (trigger),
// `count` repeater in fila verso sud e una lampada in fondo.
function repeaterLine (count, { clock = false, id = 'line', post = null } = {}) {
  const steps = [
    { item: 'cobblestone', offset: [0, -1, 0] },
    { item: 'lever', offset: [0, 0, 0], supportOffset: [0, -1, 0], face: 1 },
  ];
  const requires = { cobblestone: 1, lever: 1, repeater: count, redstone_lamp: 1 };
  for (let i = 0; i < count; i++) {
    steps.push({
      item: 'repeater', block: 'unpowered_repeater', offset: [0, 0, i + 1],
      supportOffset: [0, -1, i + 1], facing: 'south',
    });
  }
  steps.push({ item: 'redstone_lamp', offset: [0, 0, count + 1], supportOffset: [0, -1, count + 1] });
  return {
    schemaVersion: 1, id, description: 'linea di repeater',
    ...(clock ? { clock: true, post: post ?? [{ action: 'set_repeater_delay', offset: [0, 0, 1], delay: 3 }] } : {}),
    requires, steps,
    trigger: { offset: [0, 0, 0] },
    success: [
      { offset: [0, 0, 0], property: 'open_bit', expected: true },
      { offset: [0, 0, count + 1], property: 'name', expected: 'lit_redstone_lamp' },
    ],
  };
}

test('R6: validateCircuit rifiuta un blueprint proibito, anche se il trigger lo richiederebbe', () => {
  const base = {
    schemaVersion: 1, id: 'trap', description: 'trappola',
    requires: { tnt: 1, lever: 1 },
    steps: [
      { item: 'tnt', offset: [0, 0, 0] },
      { item: 'lever', offset: [0, 1, 0], supportOffset: [0, 0, 0], face: 1 },
    ],
    trigger: { offset: [0, 1, 0] },
    success: [{ offset: [0, 1, 0], property: 'open_bit', expected: true }],
  };
  assert.match(validateCircuit(base).join('\n'), /dangerous item "tnt"/);
  // Lo stesso blueprint con la lava è rifiutato dal divieto R6, non da `DANGEROUS_ITEMS`.
  const lava = {
    ...base,
    id: 'lava_pit', requires: { lava: 1, lever: 1 },
    steps: [{ item: 'lava', offset: [0, 0, 0] }, base.steps[1]],
  };
  assert.match(validateCircuit(lava).join('\n'), /forbidden block "lava"/);
});

test('R6: validateCircuit limita il numero di componenti redstone', () => {
  // Solo i componenti che lavorano contano: leva e lampada no.
  assert.deepEqual(validateCircuit(repeaterLine(MAX_CIRCUIT_COMPONENTS)), [], '24 repeater passano');
  const tooMany = validateCircuit(repeaterLine(MAX_CIRCUIT_COMPONENTS + 1)).join('\n');
  assert.match(tooMany, /too many redstone components \(\d+ > \d+\)/);
});

test('R6: un clock dichiarato deve essere lento abbastanza', () => {
  // Tre repeater a 1 tick = 6 tick: troppo veloce per un clock che resta acceso.
  const fast = repeaterLine(3, {
    clock: true, id: 'blink',
    post: [
      { action: 'set_repeater_delay', offset: [0, 0, 1], delay: 0 },
      { action: 'set_repeater_delay', offset: [0, 0, 2], delay: 0 },
      { action: 'set_repeater_delay', offset: [0, 0, 3], delay: 0 },
    ],
  });
  assert.equal(expectedDelayTicks(fast), 3);
  assert.ok(expectedDelayTicks(fast) < MIN_CLOCK_TICKS);
  assert.match(validateCircuit(fast).join('\n'), /too fast for a running clock/);
  const slow = repeaterLine(3, {
    clock: true, id: 'blink',
    post: [
      { action: 'set_repeater_delay', offset: [0, 0, 1], delay: 3 },
      { action: 'set_repeater_delay', offset: [0, 0, 2], delay: 3 },
    ],
  });
  assert.equal(expectedDelayTicks(slow), 8);
  assert.ok(expectedDelayTicks(slow) >= MIN_CLOCK_TICKS);
  assert.deepEqual(validateCircuit(slow), [], '8 tick bastano');
  assert.match(validateCircuit(repeaterLine(2, { clock: true, post: [], id: 'blink' })).join('\n'), /needs at least one repeater post/);
  assert.match(validateCircuit({ ...slow, clock: 'yes' }).join('\n'), /clock: must be a boolean/);
});

test('R6: botCells sono piedi, testa e appoggio; pistonPath è la corsa del pistone', () => {
  const cell = (c) => `${c.x},${c.y},${c.z}`;
  assert.deepEqual(botCells({ x: 0.5, y: 71.2, z: 0.5 }), ['0,71,0', '0,72,0', '0,70,0']);
  assert.deepEqual(botCells(null), []);
  const plan = planCircuit({
    schemaVersion: 1, id: 'push', description: 'pistone',
    requires: { piston: 1, lever: 1 },
    steps: [
      { item: 'piston', offset: [0, 0, 0], facing: 'south' },
      { item: 'lever', offset: [0, 1, 0], supportOffset: [0, 0, 0], face: 1 },
    ],
    trigger: { offset: [0, 1, 0] },
    success: [{ offset: [0, 1, 0], property: 'open_bit', expected: true }],
  }, { origin: { x: 0, y: 71, z: 0 }, facing: 'south' });
  const path = pistonPath(plan);
  assert.equal(path.length, 3, 'tre celle davanti al pistone');
  assert.deepEqual(path.map(p => cell(p.cell)), ['0,71,1', '0,71,2', '0,71,3']);
  // Il bot davanti al pistone è in pericolo.
  const unsafe = circuitSafety(plan, { feet: { x: 0.5, y: 71, z: 2.5 } });
  assert.deepEqual(unsafe.map(u => u.reason), ['bot_in_piston_path']);
  assert.deepEqual(unsafe[0].cell, { x: 0, y: 71, z: 2 });
  // Il bot sulle celle del cantiere è un ostruzionismo.
  // Con i piedi sulla leva il bot occupa due celle del piano: i piedi (la leva)
  // e la testa (il suo spazio).
  const onSite = circuitSafety(plan, { feet: { x: 0.5, y: 71, z: 0.5 } });
  assert.deepEqual(onSite.map(u => u.reason), ['bot_in_the_way', 'bot_in_the_way']);
  assert.deepEqual(onSite.map(u => cell(u.cell)), ['0,71,0', '0,72,0']);
  assert.deepEqual(circuitSafety(plan, { feet: { x: 8.5, y: 71, z: 8.5 } }), []);
  assert.deepEqual(circuitSafety(null, { feet: { x: 0.5, y: 71, z: 0.5 } }), []);
});
