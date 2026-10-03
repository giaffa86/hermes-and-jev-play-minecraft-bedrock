// Redstone (R1 di docs/wiki/redstone.md): piazzamento orientato con verifica
// dello stato (place → read → correct), ritardo del ripetitore, opzioni.
// Mondo finto: nessun socket, nessuna attesa reale.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

const props = (values) => ({ getProperties: () => values });
const key = (p) => `${p.x},${p.y},${p.z}`;
// Modello del server: la direzione del blocco piazzato segue lo yaw del giocatore.
const YAW_FACING = { 0: 2, 90: 5, 180: 3, 270: 4 }; // north, east, south, west

function orientedAdapter ({ cells = {}, inventory = {}, loaded = 4, feet = { x: 0.5, y: 71, z: 0.5 } } = {}) {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.dead = false;
  adapter.sleeping = false;
  adapter.client = {};
  adapter._feet = { ...feet };
  adapter.position = { x: feet.x, y: feet.y + 1.62, z: feet.z };
  adapter.nearbyBlocks = {};
  adapter.inventory = { ...inventory };
  adapter.plan = null;
  const blocks = new Map(Object.entries(cells));
  const world = {
    loaded: new Map(Array.from({ length: loaded }, (_, i) => [`${i},0`, {}])),
    blockAt: ({ x, y, z }) => blocks.get(`${x},${y},${z}`) ?? null,
    findBlocks: () => [],
    registry: { items: {} },
  };
  adapter.world = world;
  adapter._yawTo = () => 0;
  adapter._lookAt = () => ({ yaw: 0, pitch: 0 });
  adapter._airAt = (x, y, z) => (world.blockAt({ x, y, z })?.name ?? 'air') === 'air';
  adapter._redstoneCensus = () => ({ components: [] });
  adapter._blockUseTransaction = (position) => ({ data: { action_type: 'click_block', block_position: position } });
  const events = { places: [], mines: [], input: [], logs: [] };
  adapter.log = (type, data) => events.logs.push({ type, data });
  adapter._queueAuthInput = async (frame) => {
    events.input.push(frame);
    // Modello del click sul ripetitore: il ritardo avanza di uno.
    const pos = frame?.transaction?.data?.block_position;
    const block = pos ? world.blockAt(pos) : null;
    // Modello del click: avanza solo se lo stato è leggibile (altrimenti il
    // click non produce nulla di osservabile, come un ripetitore senza stato).
    if (block?.name?.endsWith('repeater') && block.getProperties?.().repeater_delay != null) {
      const delay = Number(block.getProperties().repeater_delay);
      blocks.set(key(pos), { ...block, ...props({ ...block.getProperties(), repeater_delay: (delay + 1) % 4 }) });
    }
  };
  return { adapter, blocks, world, events };
}

// Un piazzamento finto che scrive nel mondo un blocco con la direzione derivata
// dallo yaw, e restituisce l'esito come il vero `_placeAtCell`.
function stubPlacement (adapter, blocks, { spot = { target: { x: 1, y: 71, z: 0 }, support: { x: 1, y: 70, z: 0 }, face: 1, clickPos: { x: 0.5, y: 1, z: 0.5 }, blockName: 'lever' }, onMine = null } = {}) {
  const events = [];
  adapter._findPlacementTarget = (blockName) => ({ ...spot, blockName });
  adapter._placeAtCell = async (itemName, blockName, target, _support, _face, _clickPos, opts = {}) => {
    const yaw = ((Math.round(opts.yaw ?? 0) % 360) + 360) % 360;
    events.push({ itemName, blockName, yaw });
    const facing = YAW_FACING[yaw] ?? YAW_FACING[0];
    blocks.set(key(target), { name: blockName, position: { ...target }, ...props({ facing_direction: facing, repeater_delay: 0 }) });
    return { ok: true, block: blockName, position: { ...target } };
  };
  adapter._mineBlock = async (block) => {
    events.push({ mine: block?.name, position: block?.position });
    if (onMine) return onMine(block);
    blocks.delete(key(block.position));
    return { ok: true, block: block.name, position: block.position };
  };
  return events;
}

test('_placeOriented senza direzione voluta piazza una volta e riporta lo stato', async () => {
  const { adapter, blocks } = orientedAdapter();
  const events = stubPlacement(adapter, blocks);
  const res = await adapter._placeOriented('lever', 'lever');
  assert.equal(res.ok, true);
  assert.equal(res.block, 'lever');
  assert.equal(res.facing, 'north');
  assert.equal(res.wanted, null);
  assert.equal(res.attempts, 1);
  assert.equal(res.corrected, false);
  assert.equal(events.length, 1, 'un solo piazzamento, nessuna rimozione');
  assert.deepEqual(events[0], { itemName: 'lever', blockName: 'lever', yaw: 0 });
});

test('_placeOriented corregge la direzione: mina il blocco sbagliato e ritenta con lo yaw successivo', async () => {
  const { adapter, blocks } = orientedAdapter();
  const events = stubPlacement(adapter, blocks);
  const res = await adapter._placeOriented('lever', 'lever', { facing: 'east' });
  assert.equal(res.ok, true);
  assert.equal(res.facing, 'east');
  assert.equal(res.wanted, 'east');
  assert.equal(res.attempts, 2);
  assert.equal(res.corrected, true);
  assert.deepEqual(res.tried, ['north', 'east']);
  assert.deepEqual(events, [
    { itemName: 'lever', blockName: 'lever', yaw: 0 },
    { mine: 'lever', position: { x: 1, y: 71, z: 0 } },
    { itemName: 'lever', blockName: 'lever', yaw: 90 },
  ]);
});

test('_placeOriented si ferma dopo tutti i candidati con orientation_not_confirmed', async () => {
  const { adapter, blocks } = orientedAdapter();
  const events = stubPlacement(adapter, blocks);
  const res = await adapter._placeOriented('lever', 'lever', { facing: 'up' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'orientation_not_confirmed');
  assert.equal(res.wanted, 'up');
  assert.equal(res.facing, 'west');
  assert.equal(res.attempts, 4);
  assert.deepEqual(res.tried, ['north', 'east', 'south', 'west']);
  assert.deepEqual(events.filter(e => e.mine), [
    { mine: 'lever', position: { x: 1, y: 71, z: 0 } },
    { mine: 'lever', position: { x: 1, y: 71, z: 0 } },
    { mine: 'lever', position: { x: 1, y: 71, z: 0 } },
  ]);
});

test('_placeOriented non ritenta se non riesce a rimuovere il blocco sbagliato', async () => {
  const { adapter, blocks, events } = orientedAdapter();
  stubPlacement(adapter, blocks, { onMine: () => ({ ok: false, error: 'block_still_present' }) });
  const res = await adapter._placeOriented('lever', 'lever', { facing: 'east' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'orientation_not_confirmed');
  assert.equal(res.facing, 'north');
  assert.equal(res.attempts, 1);
  assert.ok(res.tried.length === 1);
  // Un blocco rimasto a terra va segnalato, non nascosto: da fuori si vede solo il log.
  const stuck = events.logs.find(e => e.type === 'oriented_place_stuck');
  assert.ok(stuck, 'evento oriented_place_stuck assente');
  assert.deepEqual(stuck.data, { block: 'lever', position: { x: 1, y: 71, z: 0 }, facing: 'north', wanted: 'east', error: 'block_still_present' });
});

test('_placeOriented propaga l_errore di piazzamento con i tentativi fatti', async () => {
  const { adapter, blocks } = orientedAdapter();
  stubPlacement(adapter, blocks);
  adapter._placeAtCell = async () => ({ ok: false, error: 'place_not_confirmed' });
  const res = await adapter._placeOriented('lever', 'lever', { facing: 'east' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'place_not_confirmed');
  assert.equal(res.attempts, 1);
  assert.deepEqual(res.tried, []);
});

test('_placeOriented senza cella libera ritorna no_place_spot', async () => {
  const { adapter, blocks } = orientedAdapter();
  stubPlacement(adapter, blocks);
  adapter._findPlacementTarget = () => null;
  const res = await adapter._placeOriented('lever', 'lever');
  assert.deepEqual(res, { ok: false, error: 'no_place_spot', block: 'lever' });
});

test('executeAction instrada i componenti redstone sul piazzamento orientato', async () => {
  const { adapter, blocks } = orientedAdapter({ inventory: { lever: 1, dirt: 2, redstone: 1 } });
  stubPlacement(adapter, blocks);
  const oriented = [];
  const plain = [];
  const realOriented = adapter._placeOriented.bind(adapter);
  adapter._placeOriented = async (...args) => { oriented.push(args); return realOriented(...args); };
  const realPlain = adapter._placeBlock;
  adapter._placeBlock = async (...args) => { plain.push(args); return { ok: true, block: args[1], position: { x: 1, y: 71, z: 0 } }; };

  const lever = await adapter.executeAction('place_lever');
  assert.equal(lever.ok, true);
  assert.equal(lever.facing, 'north');
  assert.deepEqual(oriented.map(a => a.slice(0, 2)), [['lever', 'lever']]);

  const dust = await adapter.executeAction('place_redstone');
  assert.equal(dust.ok, true);
  assert.deepEqual(oriented.at(-1).slice(0, 2), ['redstone', 'redstone_wire'], 'la polvere si piazza come redstone_wire');

  const dirt = await adapter.executeAction('place_dirt');
  assert.equal(dirt.ok, true);
  assert.deepEqual(plain, [['dirt', 'dirt']]);
  assert.equal(oriented.length, 2, 'i blocchi non redstone non passano dal percorso orientato');
  assert.ok(realPlain);
});

test('_setRepeaterDelay avanza, imposta un valore esplicito e riconosce il no-op', async () => {
  const { adapter } = orientedAdapter({ cells: { '1,71,0': { name: 'unpowered_repeater', ...props({ repeater_delay: 0 }) } } });
  const cell = { x: 1, y: 71, z: 0 };
  assert.equal(adapter._pickRepeaterTarget(), null, 'senza censimento non c_e un ripetitore');

  const next = await adapter._setRepeaterDelay(null, { position: cell });
  assert.equal(next.ok, true);
  assert.equal(next.before, 0);
  assert.equal(next.delay, 1);
  assert.equal(next.clicks, 1);
  assert.equal(adapter.world.blockAt(cell).getProperties().repeater_delay, 1);

  const explicit = await adapter._setRepeaterDelay(3, { position: cell });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.before, 1);
  assert.equal(explicit.delay, 3);
  assert.equal(explicit.clicks, 2);

  const already = await adapter._setRepeaterDelay(3, { position: cell });
  assert.deepEqual(already, { ok: true, already: true, position: cell, delay: 3 });
});

test('_setRepeaterDelay wrappa 3 → 0 e tipizza gli errori', async () => {
  const { adapter } = orientedAdapter({ cells: { '1,71,0': { name: 'powered_repeater', ...props({ repeater_delay: 3 }) } } });
  const cell = { x: 1, y: 71, z: 0 };
  const wrapped = await adapter._setRepeaterDelay(null, { position: cell });
  assert.equal(wrapped.ok, true);
  assert.equal(wrapped.before, 3);
  assert.equal(wrapped.delay, 0);
  assert.equal(wrapped.clicks, 1);

  assert.deepEqual(await adapter._setRepeaterDelay(2), { ok: false, error: 'no_repeater_nearby' });

  const { adapter: clean } = orientedAdapter();
  assert.deepEqual(await clean._cycleRepeater({ x: 4, y: 71, z: 0 }), { ok: false, error: 'not_a_repeater', position: { x: 4, y: 71, z: 0 }, block: null });

  const { adapter: lamp } = orientedAdapter({ cells: { '4,71,0': { name: 'redstone_lamp' } } });
  assert.equal((await lamp._cycleRepeater({ x: 4, y: 71, z: 0 })).error, 'not_a_repeater');

  const { adapter: unset } = orientedAdapter({ cells: { '1,71,0': { name: 'unpowered_repeater', ...props({}) } } });
  assert.equal((await unset._cycleRepeater(cell)).error, 'repeater_state_unreadable');
  assert.equal((await unset._setRepeaterDelay(2, { position: cell })).error, 'repeater_state_unreadable');

  const { adapter: far } = orientedAdapter({ cells: { '1,71,0': { name: 'unpowered_repeater', ...props({ repeater_delay: 0 }) } } });
  far._reachabilityUsable = () => true;
  far.approachReachable = () => false;
  assert.equal((await far._cycleRepeater(cell)).error, 'repeater_unreachable');
});

test('_cycleRepeater non conferma un ritardo che non cambia', async () => {
  const { adapter, blocks } = orientedAdapter({ cells: { '1,71,0': { name: 'unpowered_repeater', ...props({ repeater_delay: 1 }) } } });
  adapter._queueAuthInput = async () => {};
  const res = await adapter._cycleRepeater({ x: 1, y: 71, z: 0 }, { clicks: 1, timeoutMs: 40 });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'repeater_delay_not_confirmed');
  assert.equal(res.before, 1);
  assert.equal(res.delay, 1);
  assert.equal(blocks.get('1,71,0').getProperties().repeater_delay, 1);
});

test('executeAction accetta set_repeater_delay[_n] e rifiuta un valore fuori scala', async () => {
  const { adapter } = orientedAdapter({ cells: { '1,71,0': { name: 'unpowered_repeater', ...props({ repeater_delay: 0 }) } } });
  adapter._redstoneCensus = () => ({ components: [{ name: 'unpowered_repeater', position: { x: 1, y: 71, z: 0 } }] });

  const next = await adapter.executeAction('set_repeater_delay');
  assert.equal(next.ok, true);
  assert.equal(next.delay, 1);
  assert.equal(next.clicks, 1);

  const explicit = await adapter.executeAction('set_repeater_delay_0');
  assert.equal(explicit.ok, true);
  assert.equal(explicit.delay, 0);

  const bad = await adapter.executeAction('set_repeater_delay_9');
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'bad_delay');
  assert.equal(bad.wanted, 9);
});

test('options offre i componenti in inventario e il ritardo del ripetitore', async () => {
  const { adapter } = orientedAdapter({
    inventory: { lever: 1, redstone: 2, redstone_ore: 1, dirt: 3 },
    cells: { '1,71,0': { name: 'unpowered_repeater', ...props({ repeater_delay: 2 }) } },
  });
  adapter._redstoneCensus = () => ({ components: [{ name: 'unpowered_repeater', position: { x: 1, y: 71, z: 0 } }] });
  const keys = adapter.options().map(o => o.key);
  assert.ok(keys.includes('place_lever'), 'la leva in inventario si può piazzare');
  assert.ok(keys.includes('place_redstone'), 'la polvere si piazza come redstone_wire');
  assert.ok(keys.includes('set_repeater_delay'), 'il ripetitore a portata si può ritardare');
  assert.equal(keys.includes('place_redstone_ore'), false, 'il minerale non è un componente da piazzare');
  const delayOption = adapter.options().find(o => o.key === 'set_repeater_delay');
  assert.match(delayOption.description, /now 2/);
});
