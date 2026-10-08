// Endgame nell'adapter (N7 di docs/wiki/nether.md): telai del portale dell'End,
// craft degli occhi, lancio e triangolazione, riempimento del portale, ingresso
// nell'End e verdetto sul drago dal ciclo della barra del boss.
// Nessun server: il mondo è una mappa di celle e i pacchetti si contano.

import test from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

// Mondo minimo con pavimento, celle dichiarabili e blocchi mutabili: qui lo
// stato dei telai deve poter *cambiare* (un occhio che entra) e la census deve
// rileggerlo, altrimenti il test non prova nulla.
function endAdapter ({ cells = {}, items = {}, feet = { x: 0.5, y: 71, z: 0.5 }, dimension = 'overworld', recipes = null, inventorySlots = null } = {}) {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.client = { entityId: 1, write () {} };
  adapter._feet = { ...feet };
  adapter.position = { x: feet.x, y: feet.y + 1.62, z: feet.z };
  adapter.dimension = dimension;
  adapter._lastYaw = 0;
  adapter._lastPitch = 0;
  adapter.nearbyBlocks = {};
  adapter.inventory = { ...items };
  adapter.inventorySlots = inventorySlots ?? [];
  adapter.pickups = {};
  adapter.standingOn = 'stone';
  adapter.entities = new Map();
  adapter._moves = [];
  adapter._inputs = [];
  adapter.drops = [];
  adapter.recipes = recipes ?? new Map();
  adapter.world.loaded = new Map([['0,0', {}]]);
  const blocks = new Map();
  const put = (x, y, z, def) => {
    const { name, properties = {}, boundingBox = name === 'air' || name === 'cave_air' ? 'empty' : 'block' } = typeof def === 'string' ? { name: def } : def;
    const stored = { name, boundingBox, position: { x, y, z }, properties, getProperties: () => stored.properties };
    blocks.set(`${x},${y},${z}`, stored);
    return stored;
  };
  for (let x = -6; x <= 12; x++) {
    for (let z = -6; z <= 12; z++) {
      if (x === 0 && z === 0) continue;
      put(x, feet.y - 1, z, 'stone');
    }
  }
  for (const [key, def] of Object.entries(cells)) {
    const [x, y, z] = key.split(',').map(Number);
    put(x, y, z, def);
  }
  adapter.world.blockAt = ({ x, y, z }) => blocks.get(`${x},${y},${z}`) ?? null;
  adapter.world.runtimeIdAt = () => 7;
  adapter.world.findBlocks = (name, _position, _radius, limit) => {
    const hits = [];
    for (const block of blocks.values()) {
      if (block.name === name || block.name.endsWith(`_${name}`)) hits.push({ ...block, distance: 1 });
    }
    return hits.slice(0, limit ?? 64);
  };
  adapter.world.registry = { items: {}, blocksByName: {} };
  // Il pathfinder non esiste in fixture: la raggiungibilità è spenta (fail-open)
  // e `_moveTo` teletrasporta, registrando la meta.
  adapter._reachabilityUsable = () => false;
  adapter._moveTo = async (target) => {
    adapter._moves.push({ ...target });
    if (adapter._moveThrows) throw new Error('path_failed');
    adapter._feet = { x: target.x, y: target.y, z: target.z };
    adapter.position = { x: target.x, y: target.y + 1.62, z: target.z };
    return { ok: true };
  };
  adapter._moveSlotToHotbar = async index => index;
  adapter._queueAuthInput = async payload => {
    adapter._inputs.push(payload);
    if (adapter._onAuthInput) adapter._onAuthInput(payload);
  };
  adapter._airUseTransaction = () => ({ data: { action_type: 'click_air' }, legacy: {}, actions: [] });
  adapter.events = { logs: [] };
  adapter.log = (type, data) => { adapter.events.logs.push({ type, data }); };
  return { adapter, blocks, put };
}

const frame = (_x, _z, eye = 0) => ({ name: 'end_portal_frame', properties: { end_portal_eye_bit: { type: 'byte', value: eye }, 'minecraft:cardinal_direction': { type: 'string', value: 'south' } } });

test('_endView is inert in a quiet overworld: no frames, no eyes, no boss', () => {
  const { adapter } = endAdapter();
  const view = adapter._endView();
  assert.equal(view.dimension, 'overworld');
  assert.equal(view.inEnd, false);
  assert.equal(view.frames.total, 0);
  assert.equal(view.frames.missing, 0);
  assert.equal(view.frames.complete, false);
  assert.equal(view.craft.craftable, 0);
  assert.equal(view.readings.length, 0);
  assert.equal(view.stronghold, null);
  assert.equal(view.boss.defeated, false);
  assert.equal(view.boss.reason, 'no_boss_bar');
  assert.equal(view.portal, null);
  // La proiezione compatta è quella che finisce in /observe.
  assert.deepEqual(adapter._netherView().end.frames, { total: 0, filled: 0, missing: 0, unknown: 0 });
});

test('_endFrames reads the eye bit of each frame and never calls an unreadable frame empty', () => {
  const { adapter } = endAdapter({
    cells: {
      '4,71,0': frame(4, 0, 1),
      '6,71,0': frame(6, 0, 0),
      '8,71,0': { name: 'end_portal_frame' },
    },
  });
  const status = adapter._endFrames({ force: true });
  assert.equal(status.total, 3);
  assert.equal(status.filled, 1);
  assert.equal(status.empty, 1);
  assert.equal(status.unknown, 1);
  assert.equal(status.missing, 1);
  assert.equal(status.complete, false);
  assert.deepEqual(status.nearest.position, { x: 4, y: 71, z: 0 });
});

test('the boss bar cycle is what makes the dragon defeated, and it is visible in /observe', () => {
  const { adapter } = endAdapter();
  adapter._onBossEvent({ type: 'show_bar', target_entity_id: 12n, title: 'Ender Dragon', progress: 1 });
  adapter._onBossEvent({ type: 'set_bar_progress', progress: 0.4 });
  assert.equal(adapter._endView().boss.reason, 'boss_bar_visible');
  assert.equal(adapter._netherView().end.boss.defeated, false);
  assert.equal(adapter._bossBar.progress, 0.4);
  adapter._onBossEvent({ type: 'hide_bar' });
  const view = adapter._endView();
  assert.equal(view.boss.defeated, true);
  assert.equal(view.boss.reason, 'bar_shown_then_hidden');
  assert.equal(view.bossBar.events, 3);
  assert.equal(adapter._netherView().end.boss.defeated, true);
  // Un evento che non è né comparsa né scomparsa non cambia il verdetto.
  adapter._onBossEvent({ type: 'query' });
  assert.equal(adapter._bossBarEvents, 3);
});

test('the endgame options appear only when their materials are really in hand', () => {
  const recipes = new Map([['blaze_powder', []], ['ender_eye', []]]);
  const bare = endAdapter({ recipes }).adapter;
  let keys = bare.options().map(o => o.key);
  assert.equal(keys.includes('craft_blaze_powder'), false);
  assert.equal(keys.includes('craft_ender_eye'), false);
  assert.equal(keys.includes('throw_eye_of_ender'), false);
  assert.equal(keys.includes('fill_end_portal'), false);
  assert.equal(keys.includes('find_stronghold'), false);
  assert.equal(keys.includes('enter_end_portal'), false);

  const rich = endAdapter({
    recipes,
    items: { blaze_rod: 3, blaze_powder: 1, ender_pearl: 1, ender_eye: 2 },
    // Le perle si contano dagli slot (in produzione l'inventario aggregato può
    // essere indietro rispetto a una transazione in corso).
    inventorySlots: [{ network_id: 8, name: 'ender_pearl', count: 1 }, { network_id: 5, name: 'ender_eye', count: 2 }],
    cells: {
      '4,71,0': frame(4, 0, 0),
      // A portata del braccio (PORTAL_APPROACH_RANGE): entrare nel portale è una
      // opzione solo quando il portale è lì.
      '2,71,1': { name: 'end_portal' },
    },
  }).adapter;
  keys = rich.options().map(o => o.key);
  assert.ok(keys.includes('craft_blaze_powder'), `keys: ${keys.join(',')}`);
  assert.ok(keys.includes('craft_ender_eye'));
  assert.ok(keys.includes('throw_eye_of_ender'));
  assert.ok(keys.includes('fill_end_portal'), `keys: ${keys.join(',')}`);
  assert.ok(keys.includes('enter_end_portal'));
  // Una stronghold già trovata non chiede di triangolare, e un portale completo
  // non chiede occhi: le opzioni seguono i fatti, non lo script.
  const found = endAdapter({ recipes, items: { ender_eye: 2 }, cells: { '4,71,0': frame(4, 0, 1) } }).adapter;
  const foundKeys = found.options().map(o => o.key);
  assert.equal(foundKeys.includes('fill_end_portal'), false);
  assert.equal(foundKeys.includes('enter_end_portal'), false);
});

test('_craftPowderFromRods grinds one rod at a time and _craftEyesOfEnder stops without pearls', async () => {
  const { adapter } = endAdapter({ items: { blaze_rod: 2, ender_pearl: 2 }, inventorySlots: [{ network_id: 8, name: 'ender_pearl', count: 2 }] });
  const crafted = [];
  adapter._craftItem = async (item) => {
    crafted.push(item);
    if (item === 'blaze_powder') {
      adapter.inventory.blaze_rod = (adapter.inventory.blaze_rod || 0) - 1;
      adapter.inventory.blaze_powder = (adapter.inventory.blaze_powder || 0) + 2;
      return { ok: true, crafted: item, count: 2 };
    }
    if ((adapter.inventory.blaze_powder || 0) < 1 || (adapter.inventory.ender_pearl || 0) < 1) {
      return { ok: false, error: 'missing_ingredients' };
    }
    adapter.inventory.blaze_powder -= 1;
    adapter.inventory.ender_pearl -= 1;
    adapter.inventorySlots[0].count -= 1;
    adapter.inventory.ender_eye = (adapter.inventory.ender_eye || 0) + 1;
    return { ok: true, crafted: item, count: 1 };
  };
  const powder = await adapter._craftPowderFromRods({});
  assert.equal(powder.ok, true);
  assert.equal(powder.gained, 4);
  assert.equal(adapter.inventory.blaze_powder, 4);
  assert.equal(adapter.inventory.blaze_rod, 0);

  const eyes = await adapter._craftEyesOfEnder({});
  assert.equal(eyes.ok, true);
  assert.equal(eyes.gained, 2);
  assert.equal(adapter.inventory.ender_eye, 2);
  assert.equal(adapter.inventory.ender_pearl, 0);
  assert.equal(adapter.inventorySlots[0].count, 0);

  // Senza perle il rifiuto è tipizzato e non consuma polvere.
  const empty = endAdapter({ items: { blaze_powder: 4 } }).adapter;
  empty._craftItem = async () => ({ ok: false, error: 'missing_ingredients' });
  const refused = await empty._craftEyesOfEnder({});
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'missing_ender_pearl');
  assert.equal(empty.inventory.blaze_powder, 4);
});

test('craft_blaze_powder e craft_ender_eye arrivano ai loro passi, non a _craftItem', async () => {
  // Le due chiavi attraversano il prefisso `craft_<item>`: senza lo spostamento
  // dei rami specifici prima del prefisso finirebbero in
  // `_craftItem('blaze_powder')` / `_craftItem('ender_eye')`, che chiedono al
  // server una ricetta con quel nome (`craft_recipe_missing`). Qui i due passi
  // veri sono sostituiti da spie: l'oggetto del test è l'instradamento.
  const { adapter } = endAdapter({ items: { blaze_rod: 1, blaze_powder: 1, ender_pearl: 1 } });
  const reached = [];
  adapter._craftPowderFromRods = async () => { reached.push('powder'); return { ok: true, via: 'powder' }; };
  adapter._craftEyesOfEnder = async () => { reached.push('eyes'); return { ok: true, via: 'eyes' }; };
  adapter._craftItem = async (item) => ({ ok: false, error: 'craft_recipe_missing', item });

  const powder = await adapter.executeAction('craft_blaze_powder');
  const eyes = await adapter.executeAction('craft_ender_eye');
  assert.deepEqual(reached, ['powder', 'eyes']);
  assert.deepEqual([powder.via, eyes.via], ['powder', 'eyes']);
});

test('_throwEyeOfEnder reads the flight direction of the server entity and triangulates a second throw', async () => {
  const { adapter } = endAdapter({ items: { ender_eye: 3 }, inventorySlots: [{ network_id: 5, name: 'ender_eye', count: 3 }] });
  assert.equal((await endAdapter().adapter._throwEyeOfEnder({})).error, 'missing_eye_of_ender');

  // Il server fa comparire l'occhio a due blocchi dal bot, verso +z.
  let spawned = false;
  adapter._onAuthInput = (payload) => {
    if (payload.transaction?.data?.action_type !== 'click_air') return;
    if (spawned) return;
    spawned = true;
    adapter.entities.set('99', { runtimeId: '99', type: 'eye_of_ender_signal', kind: 'mob', position: { x: 0.5, y: 72, z: 2.5 }, seenAt: Date.now() });
  };
  const thrown = await adapter._throwEyeOfEnder({ sampleDelayMs: 1 });
  assert.equal(thrown.ok, true);
  assert.equal(thrown.reading.yaw, 0);
  assert.equal(thrown.readings, 1);
  assert.equal(thrown.stronghold, null);
  assert.equal(adapter._inputs.some(i => i.transaction?.data?.action_type === 'click_air'), true);

  // Secondo lancio da 40 blocchi più a est, stessa meta: i due raggi si incontrano.
  adapter.entities.clear();
  spawned = false;
  adapter._feet = { x: 40.5, y: 71, z: 0.5 };
  adapter.position = { x: 40.5, y: 72.62, z: 0.5 };
  adapter._onAuthInput = (payload) => {
    if (payload.transaction?.data?.action_type !== 'click_air') return;
    adapter.entities.set('100', { runtimeId: '100', type: 'eye_of_ender_signal', kind: 'mob', position: { x: 39.5, y: 72, z: 2.2 }, seenAt: Date.now() });
  };
  const second = await adapter._throwEyeOfEnder({ sampleDelayMs: 1 });
  assert.equal(second.ok, true);
  assert.equal(second.readings, 2);
  assert.equal(second.stronghold.ok, true);
  assert.equal(second.stronghold.angle > 12, true);
});

test('_findStronghold refuses without two readings, already-satisfied near a frame, and types the out-of-range trip', async () => {
  const near = endAdapter({ cells: { '8,71,0': frame(8, 0, 0) } }).adapter;
  const already = await near._findStronghold({});
  assert.equal(already.ok, true);
  assert.equal(already.already, true);
  assert.equal(already.distance, 7.5);

  const { adapter } = endAdapter();
  assert.equal((await adapter._findStronghold({})).error, 'needs_second_throw');

  // Due letture che indicano un punto lontano: il pathfinder locale non arriva.
  adapter._eyeReadings.push(
    { origin: { x: 0, y: 71, z: 0 }, direction: { x: 0, z: 1 }, yaw: 0, at: Date.now(), sample: { x: 0, y: 72, z: 2 } },
    { origin: { x: 40, y: 71, z: 0 }, direction: { x: -0.6, z: 0.8 }, yaw: 37, at: Date.now(), sample: { x: 39, y: 72, z: 1.3 } },
  );
  adapter._moveThrows = true;
  const tooFar = await adapter._findStronghold({});
  assert.equal(tooFar.ok, false);
  assert.equal(tooFar.error, 'stronghold_out_of_range');
  assert.ok(tooFar.estimate.ok);
  assert.equal(tooFar.moved, undefined);
  assert.match(tooFar.hint, /pathfinder/);

  adapter._moveThrows = false;
  const walked = await adapter._findStronghold({});
  assert.equal(walked.ok, true);
  assert.equal(walked.moved, true);
  // Due tentativi di movimento in tutto: il primo (che lancia) e questo.
  assert.equal(adapter._moves.length, 2);
  assert.equal(Math.round(adapter._moves[0].x), Math.round(walked.estimate.position.x));
});

test('_fillEndPortal clicks each empty frame with an eye and confirms it from the world', async () => {
  const { adapter, blocks } = endAdapter({
    items: { ender_eye: 2 },
    inventorySlots: [{ network_id: 5, name: 'ender_eye', count: 2 }],
    cells: { '4,71,0': frame(4, 0, 0), '6,71,0': frame(6, 0, 0) },
  });
  // Il gesto del server: l'occhio entra nel telaio e l'inventario cala.
  adapter._onAuthInput = (payload) => {
    if (payload.transaction?.data?.action_type !== 'click_block') return;
    const target = payload.transaction.data.block_position;
    const block = blocks.get(`${target.x},${target.y},${target.z}`);
    if (block) block.properties.end_portal_eye_bit = { type: 'byte', value: 1 };
    adapter.inventory.ender_eye = (adapter.inventory.ender_eye || 0) - 1;
    adapter.inventorySlots[0].count -= 1;
  };
  const report = await adapter._fillEndPortal({});
  assert.equal(report.ok, true);
  assert.equal(report.filled, 2);
  assert.equal(report.complete, true);
  assert.equal(report.published, undefined);
  assert.equal(report.empty, 0);
  assert.deepEqual(report.placed.map(p => p.x).sort(), [4, 6]);
  assert.equal(adapter.inventory.ender_eye, 0);
  // Un portale già completo non consuma occhi.
  const again = await adapter._fillEndPortal({});
  assert.equal(again.already, true);

  // Senza telai il rifiuto è tipizzato; senza occhi non si prova nemmeno.
  const none = endAdapter().adapter;
  assert.equal((await none._fillEndPortal({})).error, 'no_frame_known');
  const noEyes = endAdapter({ cells: { '4,71,0': frame(4, 0, 0) } }).adapter;
  const refused = await noEyes._fillEndPortal({});
  assert.equal(refused.error, 'missing_eye_of_ender');
  assert.equal(refused.empty, 1);
  assert.equal(noEyes._inputs.length, 0);
});

test('a frame that never gets its eye is reported as a failure, not as a success', async () => {
  const { adapter } = endAdapter({
    items: { ender_eye: 1 },
    inventorySlots: [{ network_id: 5, name: 'ender_eye', count: 1 }],
    cells: { '4,71,0': frame(4, 0, 0) },
  });
  // Il server non conferma nulla: l'occhio non entra (telaio ostacolato).
  const report = await adapter._fillEndPortal({ frameTimeoutMs: 120 });
  assert.equal(report.ok, false);
  assert.equal(report.filled, 0);
  assert.equal(report.failed[0].error, 'eye_not_placed');
  assert.equal(report.complete, false);
  assert.equal(report.frames.missing, 1);
});

test('_enterPortal({kind:end}) wants an end_portal, never a nether one', async () => {
  const { adapter } = endAdapter({ cells: { '6,71,0': frame(6, 0, 0) } });
  const refused = await adapter._enterPortal({ kind: 'end', timeoutMs: 50 });
  assert.equal(refused.error, 'no_end_portal_known');

  const nether = endAdapter({ cells: { '6,71,0': { name: 'portal' } } }).adapter;
  assert.equal((await nether._enterPortal({ kind: 'end', timeoutMs: 50 })).error, 'no_end_portal_known');

  // Con il portale a portata, la dimensione non cambia entro il budget: il
  // rifiuto dice esattamente questo.
  const { adapter: atPortal } = endAdapter({ cells: { '6,71,0': { name: 'end_portal' } }, dimension: 'overworld' });
  const stuck = await atPortal._enterPortal({ kind: 'end', timeoutMs: 80 });
  assert.equal(stuck.ok, false);
  assert.equal(stuck.error, 'dimension_unchanged');
  assert.equal(stuck.from, 'overworld');
});

test('_awaitFrameEye and _endReadings expire what is no longer true', async () => {
  const { adapter, blocks } = endAdapter({});
  const put = (x, z, eye) => {
    const block = { name: 'end_portal_frame', position: { x, y: 71, z }, properties: { end_portal_eye_bit: { type: 'byte', value: eye } }, getProperties () { return this.properties; } };
    blocks.set(`${x},71,${z}`, block);
    return block;
  };
  const block = put(9, 9, 0);
  assert.equal(await adapter._awaitFrameEye({ x: 9, y: 71, z: 9 }, 100), false);
  block.properties.end_portal_eye_bit = { type: 'byte', value: 1 };
  assert.equal(await adapter._awaitFrameEye({ x: 9, y: 71, z: 9 }, 500), true);

  const fresh = { origin: { x: 0, y: 71, z: 0 }, direction: { x: 0, z: 1 }, yaw: 0, at: Date.now(), sample: { x: 0, y: 72, z: 2 } };
  adapter._eyeReadings.push(fresh, { ...fresh, at: Date.now() - 11 * 60 * 1000 });
  assert.equal(adapter._endReadings().length, 1);
  assert.equal(adapter._endReadings({ now: fresh.at + 11 * 60 * 1000 }).length, 0);
});
