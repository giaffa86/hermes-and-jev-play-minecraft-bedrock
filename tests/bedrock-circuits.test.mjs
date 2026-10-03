// Redstone (R3 di docs/wiki/redstone.md): costruzione di un circuito
// dichiarativo — piano, sito libero, piazzamento in ordine, ritardo dei
// repeater, trigger, verifica delle proprietà e ripristino del trigger.
// Mondo finto: nessun socket, nessun pathfinder, nessuna attesa reale.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

const key = (p) => `${p.x},${p.y},${p.z}`;
const YAW = { south: 0, west: 90, north: 180, east: 270 };

// Il fixture modella il server in tre punti: il piazzamento (consuma
// l'inventario e scrive il blocco, con la direzione che il server decide), il
// ritardo dei repeater (proprietà) e il trigger (leva che inverte `open_bit` e
// comanda le celle in `link`). Il catalogo è quello vero, letto da circuits/.
function circuitAdapter ({
  cells = {}, inventory = {}, feet = { x: 0.5, y: 71, z: 0.5 }, facing = 'south',
  link = [], floor = true, refuse = null, serverFacing = () => 'south',
} = {}) {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.dead = false;
  adapter.client = {};
  adapter._feet = { ...feet };
  adapter.position = { x: feet.x, y: feet.y + 1.62, z: feet.z };
  adapter._lastYaw = YAW[facing] ?? 0;
  adapter.inventory = { ...inventory };
  adapter.nearbyBlocks = {};
  adapter.inventorySlots = [];
  adapter.selectedHotbar = 0;
  adapter.plan = null;

  const blocks = new Map();
  const put = (position, name, properties = {}) => blocks.set(key(position), { name, position: { ...position }, getProperties: () => properties });
  if (floor) {
    for (let x = -3; x <= 3; x++) {
      for (let z = -3; z <= 8; z++) put({ x, y: feet.y - 1, z }, 'stone');
    }
  }
  for (const [cellKey, value] of Object.entries(cells)) {
    const [x, y, z] = cellKey.split(',').map(Number);
    put({ x, y, z }, value.name, value.properties ?? {});
  }

  const events = { placed: [], logs: [], delays: [], triggers: [] };
  adapter.world.loaded = new Map([['0,0', {}]]);
  adapter.world.blockAt = ({ x, y, z }) => blocks.get(`${x},${y},${z}`) ?? null;
  adapter.world.runtimeIdAt = () => 1;
  adapter.world.findBlocks = () => [];
  adapter._yawTo = () => 0;
  adapter._lookAt = () => ({ yaw: 0, pitch: 0 });
  adapter.log = (type, data) => events.logs.push({ type, data });
  // La reachability resta fuori: il fixture non ha un pathfinder e il builder
  // non deve muoversi per piazzare celle che ha già a un passo dal bot.
  adapter._reachabilityUsable = () => false;
  adapter._placeAtCell = async (item, block, target, support, face, clickPos, opts) => {
    events.placed.push({ item, block, target: { ...target }, support: { ...support }, face, yaw: opts?.yaw ?? null });
    if (refuse && refuse(block, target)) return { ok: false, error: 'place_not_confirmed', block, position: target };
    if ((adapter.inventory[item] ?? 0) < 1) return { ok: false, error: 'missing_item' };
    adapter.inventory[item] -= 1;
    const facingProp = serverFacing(block, target);
    put(target, block, facingProp ? { facing_direction: facingProp } : {});
    return { ok: true, block, position: target };
  };
  adapter._setRepeaterDelay = async (wanted, { position } = {}) => {
    events.delays.push({ position: { ...position }, wanted });
    const cell = blocks.get(key(position));
    if (cell) {
      const next = { ...cell.getProperties?.(), repeater_delay: wanted };
      put(position, cell.name, next);
    }
    return { ok: true, position, delay: wanted };
  };
  adapter._useRedstone = async ({ position, restore = true } = {}) => {
    events.triggers.push({ position: { ...position }, restore });
    const cell = blocks.get(key(position));
    const before = cell?.getProperties?.().open_bit === true;
    const after = !before;
    if (cell) put(position, cell.name, { ...cell.getProperties?.(), open_bit: after });
    const effects = [];
    for (const [from, to] of link) {
      if (from !== key(position)) continue;
      const target = blocks.get(to);
      if (!target) continue;
      if (target.name === 'fence_gate') put(target.position, 'fence_gate', { ...target.getProperties?.(), open_bit: after });
      else put(target.position, after ? 'lit_redstone_lamp' : 'redstone_lamp', {});
      effects.push(blocks.get(to).name);
    }
    return { ok: true, name: 'lever', position, before, after, effects, restored: restore ? false : null };
  };
  return { adapter, blocks, events };
}

const LAMP_SWITCH = { redstone_lamp: 1, lever: 1 };
const DELAY_LINE = { cobblestone: 1, lever: 1, repeater: 3, redstone_lamp: 1 };

test('build_circuit_lamp_switch costruisce, aziona, verifica e ripristina il trigger', async () => {
  const { adapter, blocks, events } = circuitAdapter({
    inventory: { ...LAMP_SWITCH },
    link: [['0,72,1', '0,71,1']],
  });
  const result = await adapter.executeAction('build_circuit_lamp_switch');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.id, 'lamp_switch');
  assert.deepEqual(result.origin, { x: 0, y: 71, z: 1 });
  assert.equal(result.facing, 'south');
  assert.equal(result.steps, 2);
  assert.deepEqual(result.placed.map(p => [p.label, p.cell]), [
    ['lamp', { x: 0, y: 71, z: 1 }],
    ['lever', { x: 0, y: 72, z: 1 }],
  ]);
  assert.deepEqual(events.placed.map(p => p.item), ['redstone_lamp', 'lever']);
  assert.deepEqual(events.placed[0].support, { x: 0, y: 70, z: 1 }, 'la lampada poggia sul terreno');
  assert.deepEqual(events.placed[1].support, { x: 0, y: 71, z: 1 }, 'la leva poggia sulla lampada appena piazzata');
  // La verifica si fa con il trigger acceso: due toggle (on, poi ripristino).
  assert.equal(events.triggers.length, 2);
  assert.deepEqual(events.triggers.map(t => t.position), [{ x: 0, y: 72, z: 1 }, { x: 0, y: 72, z: 1 }]);
  assert.equal(result.trigger.before, false);
  assert.equal(result.trigger.after, true);
  assert.equal(result.trigger.restored, false, 'la leva è tornata a riposo');
  assert.equal(result.success.ok, true);
  assert.deepEqual(result.success.checks.map(c => c.ok), [true, true]);
  assert.equal(blocks.get('0,71,1').name, 'redstone_lamp', 'niente clock lasciato acceso');
  assert.equal(blocks.get('0,72,1').getProperties().open_bit, false);
  assert.deepEqual(adapter.inventory, { redstone_lamp: 0, lever: 0 });
  assert.equal(adapter._circuitLast.ok, true);
  assert.ok(events.logs.some(l => l.type === 'circuit_built'));
});

test('un circuito sconosciuto o dichiarato non costruibile fallisce subito e in modo tipizzato', async () => {
  const { adapter, events } = circuitAdapter({ inventory: { ...LAMP_SWITCH } });
  const unknown = await adapter.executeAction('build_circuit_mega_lamp');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, 'unknown_circuit');
  assert.equal(unknown.known.length, 8);
  assert.ok(unknown.known.includes('lamp_switch'));

  const declared = await adapter.executeAction('build_circuit_auto_harvest');
  assert.equal(declared.error, 'circuit_not_buildable');
  assert.match(declared.reason, /M1 fluid milestone/);
  assert.equal(events.placed.length, 0, 'un blueprint non costruibile non tocca il mondo');
});

test('senza materiali o con il sito occupato il cantiere non inizia', async () => {
  const poor = circuitAdapter({ inventory: { lever: 4 } });
  const missing = await poor.adapter.executeAction('build_circuit_lamp_switch');
  assert.equal(missing.error, 'missing_materials');
  assert.deepEqual(missing.missing, [{ item: 'redstone_lamp', need: 1, have: 0 }]);
  assert.equal(poor.events.placed.length, 0);

  const occupied = circuitAdapter({ inventory: { ...LAMP_SWITCH }, cells: { '0,71,1': { name: 'oak_planks' } } });
  const blocked = await occupied.adapter.executeAction('build_circuit_lamp_switch');
  assert.equal(blocked.error, 'circuit_site_blocked');
  assert.deepEqual(blocked.blocked.map(b => b.reason), ['occupied']);
  assert.equal(occupied.events.placed.length, 0);

  // Un baule è un supporto che il piazzamento non può cliccare (lo aprirebbe).
  const usable = circuitAdapter({ inventory: { ...LAMP_SWITCH }, floor: false, cells: { '0,70,1': { name: 'chest' }, '0,70,2': { name: 'stone' } } });
  const refused = await usable.adapter.executeAction('build_circuit_lamp_switch');
  assert.equal(refused.error, 'circuit_site_blocked');
  assert.deepEqual(refused.blocked.map(b => `${b.reason}:${b.name}`), ['usable_block:chest']);
});

test('un piazzamento che il server non conferma interrompe il cantiere e lo dice', async () => {
  const { adapter, events } = circuitAdapter({
    inventory: { ...LAMP_SWITCH },
    refuse: (block) => block === 'lever',
  });
  const result = await adapter.executeAction('build_circuit_lamp_switch');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'circuit_incomplete');
  assert.equal(result.placed.length, 1);
  assert.deepEqual(result.failed.map(f => [f.label, f.error]), [['lever', 'place_not_confirmed']]);
  assert.equal(result.trigger, null);
  assert.equal(result.success, null);
  assert.equal(events.triggers.length, 0, 'senza tutti i pezzi non si aziona nulla');
  assert.ok(events.logs.some(l => l.type === 'circuit_incomplete'));
});

test('una direzione imposta dal server sbagliata è un errore tipizzato, non un circuito storto', async () => {
  const wrong = circuitAdapter({
    inventory: { ...DELAY_LINE },
    serverFacing: (block) => (block === 'unpowered_repeater' ? 'north' : null),
  });
  const result = await wrong.adapter.executeAction('build_circuit_delay_line');
  assert.equal(result.error, 'circuit_incomplete');
  assert.deepEqual(result.failed.map(f => [f.label, f.error, f.facing]), [['repeater_1', 'orientation_not_confirmed', 'north']]);
  assert.equal(result.placed.length, 2, 'base e leva sono già a posto');
  assert.equal(wrong.events.triggers.length, 0);
  assert.ok(wrong.events.logs.some(l => l.type === 'circuit_orientation_failed'));
});

test('build_circuit_delay_line imposta i ritardi e verifica la lampada accesa', async () => {
  const { adapter, blocks, events } = circuitAdapter({
    inventory: { ...DELAY_LINE },
    link: [['0,72,1', '0,71,5']],
  });
  const result = await adapter.executeAction('build_circuit_delay_line');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.steps, 6);
  assert.deepEqual(events.delays.map(d => [d.position.z, d.wanted]), [[2, 0], [3, 1], [4, 2]]);
  assert.deepEqual(result.post.map(p => p.ok), [true, true, true]);
  assert.equal(result.expectedDelayTicks, 6);
  assert.deepEqual(result.success.checks.map(c => c.ok), [true, true]);
  assert.equal(result.trigger.restored, false);
  assert.equal(blocks.get('0,71,5').name, 'redstone_lamp', 'la lampada è tornata spenta con la leva');
  assert.equal(events.placed.length, 6);
});

test('auto_lamp senza trigger si costruisce ma non si dichiara verificato', async () => {
  const { adapter, events } = circuitAdapter({ inventory: { cobblestone: 1, daylight_detector: 1, redstone_lamp: 1 } });
  const result = await adapter.executeAction('build_circuit_auto_lamp');
  assert.equal(result.ok, true);
  assert.equal(result.trigger, null);
  assert.equal(result.success, null, 'la luce dipende dall\'ora: nessun check inventato');
  assert.match(result.verifyNote, /time of day/);
  assert.equal(events.triggers.length, 0);
  assert.deepEqual(adapter._circuitsView().buildable, ['auto_door', 'auto_lamp', 'delay_line', 'lamp_switch']);
  assert.equal(adapter._circuitsView().invalid, null);
});

test('le opzioni offrono solo i circuiti che si possono davvero costruire', () => {
  const ready = circuitAdapter({ inventory: { ...LAMP_SWITCH, ...DELAY_LINE } });
  const keys = ready.adapter.options().map(o => o.key);
  assert.equal(keys.includes('build_circuit_lamp_switch'), true);
  assert.equal(keys.includes('build_circuit_delay_line'), true);
  assert.equal(keys.includes('build_circuit_auto_lamp'), false, 'senza materiali non si offre');
  assert.equal(keys.includes('build_circuit_auto_harvest'), false, 'dichiarato non costruibile');
  const option = ready.adapter.options().find(o => o.key === 'build_circuit_lamp_switch');
  assert.match(option.description, /needs 1 redstone_lamp, 1 lever/);

  const occupied = circuitAdapter({ inventory: { ...LAMP_SWITCH }, cells: { '0,71,1': { name: 'stone' } } });
  assert.equal(occupied.adapter.options().map(o => o.key).includes('build_circuit_lamp_switch'), false);
});

test('_facingFromYaw legge la direzione del cantiere dallo sguardo', () => {
  const { adapter } = circuitAdapter({});
  for (const [facing, yaw] of Object.entries(YAW)) {
    adapter._lastYaw = yaw;
    assert.equal(adapter._facingFromYaw(), facing);
  }
  adapter._lastYaw = 350;
  assert.equal(adapter._facingFromYaw(), 'south', 'lo yaw si normalizza');
  adapter._lastYaw = undefined;
  assert.equal(adapter._facingFromYaw(), 'south');
});
