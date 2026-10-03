// Consapevolezza redstone (R0 di docs/wiki/redstone.md): classificazione dei
// componenti, lettura della potenza e della direzione, vista compatta per
// l'osservazione. Modulo puro, nessun server.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REDSTONE_ORES, REDSTONE_COMPONENTS, REDSTONE_HAZARDS, REDSTONE_SCAN_LIMIT,
  normalizeName, isRedstoneOre, isRedstoneComponent, isHazard,
  blockProperties, powerOf, isPowered, facingOf, isSource, isOutput,
  componentState, redstoneView,
} from '../bedrock-redstone.mjs';

const at = (x, y, z) => ({ x, y, z });
const props = (values) => ({ getProperties: () => values });

test('normalizeName e le classificazioni per nome', () => {
  assert.equal(normalizeName('MineCraft:Redstone_Wire'), 'redstone_wire');
  assert.equal(normalizeName(null), '');

  assert.equal(isRedstoneOre('redstone_ore'), true);
  assert.equal(isRedstoneOre('lit_deepslate_redstone_ore'), true);
  assert.equal(isRedstoneOre('iron_ore'), false);
  // Il minerale è anche un componente (la lista dei nomi da censire), ma non
  // entra negli output: servirà al gate del piccone, non alla verifica di un
  // circuito.
  assert.equal(isRedstoneComponent('redstone_ore'), true);
  assert.equal(isRedstoneComponent('repeater'), true);
  assert.equal(isRedstoneComponent('stone'), false);
  assert.equal(isRedstoneComponent(null), false);
  // Le costanti esportate sono coerenti con i predicati.
  assert.equal(REDSTONE_ORES.every(isRedstoneOre), true);
  assert.equal([...REDSTONE_COMPONENTS].every(isRedstoneComponent), true);
});

test('powerOf legge la potenza solo quando lo stato è leggibile', () => {
  // I nomi `lit_*`/`powered_*` sono blocchi distinti: valgono 15 senza proprietà.
  assert.equal(powerOf({ name: 'lit_redstone_lamp' }), 15);
  assert.equal(powerOf({ name: 'powered_repeater' }), 15);
  assert.equal(powerOf({ name: 'unpowered_repeater' }), 0);
  assert.equal(powerOf({ name: 'unlit_redstone_torch' }), 0);

  assert.equal(powerOf({ name: 'redstone_wire', ...props({ redstone_signal: 7 }) }), 7);
  assert.equal(powerOf({ name: 'lever', ...props({ open_bit: true }) }), 15);
  assert.equal(powerOf({ name: 'lever', ...props({ open_bit: false }) }), 0);
  assert.equal(powerOf({ name: 'stone_button', ...props({ button_pressed_bit: true }) }), 15);
  assert.equal(powerOf({ name: 'observer', ...props({ powered_bit: false }) }), 0);
  assert.equal(powerOf({ name: 'tripwire_hook', ...props({ powered_bit: true }) }), 15);
  assert.equal(powerOf({ name: 'dispenser', ...props({ triggered_bit: true }) }), 15);
  assert.equal(powerOf({ name: 'sculk_sensor', ...props({ sculk_sensor_phase: 'active' }) }), 15);
  assert.equal(powerOf({ name: 'sculk_sensor', ...props({ sculk_sensor_phase: 'cooldown' }) }), 0);
  // Una fase sconosciuta non si indovina.
  assert.equal(powerOf({ name: 'sculk_sensor', ...props({ sculk_sensor_phase: 'weird' }) }), null);
  // L'hopper non è alimentato: `toggle_bit` dice se è disabilitato, non la potenza.
  assert.equal(powerOf({ name: 'hopper', ...props({ toggle_bit: true }) }), 0);

  // Stato assente ⇒ `null`: un componente illeggibile non deve sembrare spento.
  assert.equal(powerOf({ name: 'repeater' }), null);
  assert.equal(powerOf({ name: 'redstone_wire' }), null);
  assert.equal(powerOf({ name: 'stone' }), null);
  assert.equal(powerOf(null), null);
});

test('powerOf tollera un blocco spalmato che conserva solo `_properties`', () => {
  // È la forma che si perde con lo spread di un Block prismarine: `getProperties`
  // non c'è più e lo stato vive in `_properties`/`computedStates`.
  assert.equal(powerOf({ name: 'redstone_wire', _properties: { redstone_signal: 3 } }), 3);
  assert.equal(powerOf({ name: 'lever', states: { open_bit: true } }), 15);
  assert.equal(powerOf({ name: 'redstone_wire', computedStates: { redstone_signal: 11 } }), 11);
  assert.equal(blockProperties({ name: 'stone' }), null);
});

test('isPowered è vero solo con potenza nota e positiva', () => {
  assert.equal(isPowered({ name: 'powered_repeater' }), true);
  assert.equal(isPowered({ name: 'unpowered_comparator' }), false);
  assert.equal(isPowered({ name: 'repeater' }), false);
});

test('facingOf legge la direzione qualunque sia il nome della proprietà', () => {
  assert.equal(facingOf({ name: 'piston', ...props({ facing_direction: 'north' }) }), 'north');
  assert.equal(facingOf({ name: 'repeater', ...props({ 'minecraft:cardinal_direction': 'east' }) }), 'east');
  assert.equal(facingOf({ name: 'observer', ...props({ direction: 'up' }) }), 'up');
  assert.equal(facingOf({ name: 'lever', ...props({ lever_direction: 'west' }) }), 'west');
  assert.equal(facingOf({ name: 'crafter', ...props({ orientation: 'down_east' }) }), 'down_east');
  assert.equal(facingOf({ name: 'stone' }), null);
});

test('isSource, isOutput e il pericolo assoluto della TNT', () => {
  assert.equal(isSource({ name: 'lever' }), true);
  assert.equal(isSource({ name: 'observer' }), true);
  assert.equal(isSource({ name: 'redstone_lamp' }), false);
  assert.equal(isOutput({ name: 'redstone_lamp' }), true);
  assert.equal(isOutput({ name: 'lit_redstone_lamp' }), true);
  assert.equal(isOutput({ name: 'dispenser' }), true);
  assert.equal(isOutput({ name: 'lever' }), false);

  assert.equal(isHazard({ name: 'tnt' }), true);
  // Anche senza nome noto: la proprietà dice che è innescata.
  assert.equal(isHazard({ name: 'weird_block', ...props({ explode_bit: true }) }), true);
  assert.equal(isHazard({ name: 'tnt', ...props({ explode_bit: false }) }), true);
  assert.equal(isHazard({ name: 'stone' }), false);
  assert.equal(REDSTONE_HAZARDS.has('tnt'), true);
});

test('componentState normalizza nome, distanza e proprietà', () => {
  const block = { name: 'MineCraft:Redstone_Wire', position: at(3, 0, 4), ...props({ redstone_signal: 9 }) };
  const row = componentState(block, { from: at(0, 0, 0) });
  assert.equal(row.name, 'redstone_wire');
  assert.deepEqual(row.position, at(3, 0, 4));
  assert.equal(row.distance, 5);
  assert.equal(row.power, 9);
  assert.equal(row.facing, null);
  assert.deepEqual(row.properties, { redstone_signal: 9 });

  // Senza `from` si usa la distanza misurata dalla scansione del mondo.
  assert.equal(componentState({ name: 'lever', distance: 2.457, position: at(1, 0, 1) }).distance, 2.5);
  assert.equal(componentState(null), null);
});

test('redstoneView separa componenti, minerali e TNT, ordinati per distanza', () => {
  const view = redstoneView([
    { name: 'stone', position: at(1, 0, 0) },
    // Nessuna proprietà leggibile: la potenza resta `null`, non 0.
    { name: 'redstone_lamp', position: at(4, 0, 0) },
    { name: 'lever', position: at(2, 0, 0), ...props({ open_bit: true, lever_direction: 'north' }) },
    { name: 'redstone_ore', position: at(3, 0, 0) },
    { name: 'tnt', position: at(5, 0, 0) },
  ], { from: at(0, 0, 0) });

  assert.deepEqual(view.components.map(row => row.name), ['lever', 'redstone_lamp']);
  assert.equal(view.components[0].power, 15);
  assert.equal(view.components[0].facing, 'north');
  assert.equal(view.components[1].power, null);
  assert.deepEqual(view.ore.map(row => row.name), ['redstone_ore']);
  assert.deepEqual(view.hazards.map(row => row.name), ['tnt']);
  assert.equal(view.tntNearby, true);
  assert.deepEqual(view.counts, { components: 2, ore: 1, hazards: 1 });
  // Solo i componenti con potenza nota finiscono in `power`.
  assert.deepEqual(view.power, [{ name: 'lever', position: at(2, 0, 0), distance: 2, signal: 15 }]);
});

test('redstoneView è vuota e senza falso pericolo su un mondo senza redstone', () => {
  const view = redstoneView([{ name: 'air' }, { name: 'dirt' }], { from: at(0, 0, 0) });
  assert.deepEqual(view, {
    components: [], ore: [], power: [], hazards: [], tntNearby: false,
    counts: { components: 0, ore: 0, hazards: 0 },
  });
  assert.deepEqual(redstoneView(undefined, { from: at(0, 0, 0) }).counts, { components: 0, ore: 0, hazards: 0 });
});

test('redstoneView tronca le liste ma conserva i conteggi reali', () => {
  const many = Array.from({ length: REDSTONE_SCAN_LIMIT + 5 }, (_, i) => ({ name: 'lever', position: at(i + 1, 0, 0) }));
  const view = redstoneView(many, { from: at(0, 0, 0) });
  assert.equal(view.components.length, REDSTONE_SCAN_LIMIT);
  assert.equal(view.counts.components, REDSTONE_SCAN_LIMIT + 5);
  // Restano i più vicini.
  assert.equal(view.components[0].distance, 1);
});
