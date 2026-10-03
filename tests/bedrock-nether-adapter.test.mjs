// Nether/End awareness (N0 di docs/wiki/nether.md) nell'adapter: censimento di
// portali/pericoli con TTL, proiettili in arrivo, sguardo verso un enderman e
// rifiuto di dormire dove il letto esplode. Mondo finto, nessun socket.

import test from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';
import { planPortalFrame } from '../bedrock-nether.mjs';

// Mondo finto: quattro celle d'aria sopra un pavimento di pietre, più le celle
// passate esplicitamente. `findBlocks` filtra per nome (o suffisso `_<nome>`,
// come fanno i letti: `red_bed` è un blocco, `bed` è la ricerca).
function netherAdapter (cells = {}, { feet = { x: 0.5, y: 71, z: 0.5 }, dimension = 'overworld', loaded = 1, standingOn = 'stone' } = {}) {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter._feet = { ...feet };
  adapter.position = { x: feet.x, y: feet.y + 1.62, z: feet.z };
  adapter.dimension = dimension;
  adapter._lastYaw = 0;
  adapter._lastPitch = 0;
  adapter.nearbyBlocks = {};
  adapter.inventory = {};
  adapter.standingOn = standingOn;
  adapter.entities = new Map();
  adapter.world.loaded = new Map(loaded ? [['0,0', {}]] : []);
  const blocks = new Map();
  const put = (x, y, z, def) => {
    const { name, properties = {}, boundingBox = name === 'air' || name === 'cave_air' ? 'empty' : 'block' } = typeof def === 'string' ? { name: def } : def;
    blocks.set(`${x},${y},${z}`, {
      name,
      // Come in produzione: `findBlocks` restituisce il blocco con la cella
      // intera (`blockAt` prismarine), non il centro, e un blocco solido ha un
      // boundingBox pieno (`_standable` lo pretende per l'appoggio).
      boundingBox,
      position: { x, y, z },
      getProperties: () => properties,
    });
  };
  for (let x = -4; x <= 4; x++) {
    for (let z = -4; z <= 8; z++) {
      if (x === 0 && z === 0) continue;
      put(x, feet.y - 1, z, 'stone');
    }
  }
  for (const [key, def] of Object.entries(cells)) {
    const [x, y, z] = key.split(',').map(Number);
    put(x, y, z, def);
  }
  adapter.world.blockAt = ({ x, y, z }) => blocks.get(`${x},${y},${z}`) ?? null;
  let scans = 0;
  adapter.world.findBlocks = (name, _position, _radius, limit) => {
    scans++;
    const hits = [];
    for (const block of blocks.values()) {
      if (block.name === name || block.name.endsWith(`_${name}`)) hits.push({ ...block, distance: 1 });
    }
    return hits.slice(0, limit ?? 64);
  };
  adapter._scans = () => scans;
  return adapter;
}

test('_netherView is inert in a quiet overworld and reports the dimension rules', () => {
  const adapter = netherAdapter();
  const view = adapter._netherView();
  assert.equal(view.dimension, 'overworld');
  assert.equal(view.isNether, false);
  assert.equal(view.isEnd, false);
  assert.equal(view.waterEvaporates, false);
  assert.equal(view.bedsExplode, false);
  assert.equal(view.inFire, false);
  assert.equal(view.fireDistance, null);
  assert.equal(view.portals.nether.count, 0);
  assert.equal(view.projectile, null);
  assert.equal(view.enderman, null);
  assert.deepEqual(view.hazard, { level: 'none', reasons: [] });
  assert.equal(view.ready, true);
});

test('_netherView sees portals, fire and spawners around the bot', () => {
  const adapter = netherAdapter({
    '2,71,0': 'fire',
    '4,71,0': 'magma',
    '6,71,0': 'mob_spawner',
    '8,71,0': 'portal',
  });
  const view = adapter._netherView({ cells: true });
  // Distanze da celle intere (come in produzione): il fuoco a (2,71,0) sta a
  // 1,6 blocchi dai piedi del bot a (0.5,71,0.5), non a 2.
  assert.equal(view.fireDistance, 1.6);
  assert.equal(view.magmaDistance, 3.5);
  assert.equal(view.spawnerDistance, 5.5);
  assert.equal(view.portalDistance, 7.5);
  assert.equal(view.portals.nether.count, 1);
  assert.equal(view.hazard.level, 'critical');
  assert.equal(view.cells.length, 4);
  // I pericoli sono nella vista senza `cells`, solo l'elenco delle celle è extra.
  const compact = adapter._netherView();
  assert.equal(compact.cells, undefined);
  assert.equal(compact.fireDistance, 1.6);
});

test('_netherView detects fire under the feet and in the head cell', () => {
  const standing = netherAdapter({}, { standingOn: 'fire' });
  assert.equal(standing._netherView().standingOnFire, true);
  assert.equal(standing._netherView().inFire, true);

  const head = netherAdapter({ '0,72,0': 'soul_fire' });
  const view = head._netherView();
  assert.equal(view.headInFire, true);
  assert.equal(view.feetInFire, false);
  // `inFire` è il verdetto combinato: fuoco ai piedi, in testa o sotto i piedi.
  assert.equal(view.inFire, true);
  assert.equal(view.hazard.reasons[0], 'in_fire');
});

test('_netherCensus caches by TTL and refetches when forced', () => {
  const adapter = netherAdapter({ '2,71,0': 'fire' });
  adapter._netherView();
  const first = adapter._scans();
  assert.ok(first > 0, 'the first call must scan');
  adapter._netherView();
  assert.equal(adapter._scans(), first);
  adapter._netherView({ force: true });
  assert.ok(adapter._scans() > first, 'force must rescan');
});

test('_netherCensus does not cache a world without loaded chunks', () => {
  const adapter = netherAdapter({ '2,71,0': 'fire' }, { loaded: 0 });
  const view = adapter._netherView();
  assert.equal(view.ready, false);
  const scans = adapter._scans();
  adapter._netherView();
  assert.ok(adapter._scans() > scans, 'an unloaded world must not be cached as "no portals"');
});

test('_netherView reports an inbound projectile and ignores the harmless ones', () => {
  const adapter = netherAdapter();
  // Un proiettile che si avvicina: due campioni danno la velocità stimata.
  adapter.entities.set('9', {
    runtimeId: '9',
    type: 'minecraft:fireball',
    kind: 'mob',
    position: { x: 0.5, y: 72, z: 11.5 },
    prev: { position: { x: 0.5, y: 72, z: 21.5 }, at: Date.now() - 1000 },
    lastAt: Date.now() - 500,
  });
  // Un secondo proiettile che si allontana: non deve rubare il posto.
  adapter.entities.set('10', {
    runtimeId: '10',
    type: 'minecraft:arrow',
    kind: 'mob',
    position: { x: 20.5, y: 72, z: 3.5 },
    lastAt: Date.now(),
  });
  const view = adapter._netherView();
  assert.ok(view.projectile, 'expected an inbound projectile');
  assert.equal(view.projectile.type, 'minecraft:fireball');
  assert.equal(view.projectile.source, 'samples');
  assert.ok(view.projectile.timeToImpactMs <= 4000, `eta ${view.projectile.timeToImpactMs}`);
  assert.equal(view.projectile.missDistance, 1);
  assert.equal(view.projectiles.length, 2);
});

test('_onEntityMove keeps the previous position for projectiles only', () => {
  const adapter = netherAdapter();
  const shot = { runtimeId: '9', type: 'minecraft:small_fireball', kind: 'mob', position: { x: 0.5, y: 72, z: 20.5 }, lastAt: 1000 };
  const cow = { runtimeId: '7', type: 'minecraft:cow', kind: 'mob', position: { x: 2.5, y: 71, z: 2.5 }, lastAt: 1000 };
  adapter.entities.set('9', shot);
  adapter.entities.set('7', cow);
  adapter._onEntityMove({ runtime_entity_id: '9', position: { x: 0.5, y: 72, z: 15.5 } });
  adapter._onEntityMove({ runtime_entity_id: '7', position: { x: 3.5, y: 71, z: 2.5 } });
  assert.deepEqual(shot.prev, { position: { x: 0.5, y: 72, z: 20.5 }, at: 1000 });
  assert.equal(shot.position.z, 15.5);
  assert.equal(cow.prev, undefined);
});

test('_netherView reports the enderman the bot is looking at', () => {
  const adapter = netherAdapter({}, { dimension: 'the_end' });
  // Enderman a sud, occhi alla stessa quota dello sguardo (yaw 0 = +z).
  adapter.entities.set('11', {
    runtimeId: '11',
    type: 'minecraft:enderman',
    kind: 'mob',
    position: { x: 0.5, y: 71 - 2.55 + 1.62, z: 6.5 },
    lastAt: Date.now(),
  });
  const looking = adapter._netherView();
  assert.equal(looking.enderman.type, 'minecraft:enderman');
  assert.equal(looking.enderman.gazed, true);
  assert.equal(looking.isEnd, true);
  assert.equal(looking.bedsExplode, true);
  adapter._lastYaw = 180;
  assert.equal(adapter._netherView({ force: true }).enderman.gazed, false);
});

test('sleep is refused in the nether and not offered in the options', () => {
  const adapter = netherAdapter({ '1,71,1': 'red_bed' }, { dimension: 'nether' });
  adapter._isNight = () => true;
  assert.equal(adapter._findBed()?.name, 'red_bed');
  const keys = adapter.options().map(option => option.key);
  assert.equal(keys.includes('sleep'), false);
  return adapter._sleepInBed().then(result => {
    assert.equal(result.ok, false);
    assert.equal(result.error, 'beds_explode_here');
    assert.equal(result.dimension, 'nether');
  });
});

test('sleep stays available in the overworld', () => {
  const adapter = netherAdapter({ '1,71,1': 'red_bed' });
  adapter._isNight = () => true;
  const keys = adapter.options().map(option => option.key);
  assert.equal(keys.includes('sleep'), true);
});

// --- N1: azioni sul portale ------------------------------------------------
// Fixture delle azioni: movimento, piazzamento, click e inventario osservabili.
function portalAdapter (cells = {}, { inventory = {}, feet = { x: 0.5, y: 71, z: 0.5 }, dimension = 'overworld' } = {}) {
  const adapter = netherAdapter(cells, { feet, dimension });
  adapter.inventory = { ...inventory };
  adapter.inventorySlots = Object.entries(inventory).map(([name, count]) => ({ name, count }));
  adapter.selectedHotbar = 0;
  adapter._slotItemName = (slot) => slot?.name ?? null;
  adapter._selectHotbarSlot = () => {};
  adapter._moveSlotToHotbar = async (index) => index;
  adapter._reachabilityUsable = () => false;
  adapter._refreshNearby = () => {};
  // In produzione `blockAt` restituisce sempre un blocco (aria compresa): la
  // fixture torna `null` per le celle non definite, quindi si normalizza qui.
  const rawBlockAt = adapter.world.blockAt;
  adapter.world.blockAt = (position) => rawBlockAt(position) ?? { name: 'air', position: { ...position } };
  adapter.events = { moves: [], placed: [], transactions: [] };
  adapter._moveTo = async (target) => { adapter.events.moves.push({ ...target }); return true; };
  adapter._queueAuthInput = async (payload) => { if (payload?.transaction) adapter.events.transactions.push(payload.transaction); };
  adapter._placeAtCell = async (item, block, target, support, face) => {
    adapter.events.placed.push({ item, block, target: { ...target }, support: { ...support }, face });
    adapter.inventory[item] = Math.max(0, (adapter.inventory[item] || 0) - 1);
    return { ok: true };
  };
  return adapter;
}

test('_gotoPortal is typed when no portal is loaded and moves when there is one', async () => {
  const empty = portalAdapter();
  assert.equal(empty._nearestPortal(), null);
  const none = await empty._gotoPortal({});
  assert.equal(none.ok, false);
  assert.equal(none.error, 'no_portal_known');
  assert.equal(empty.events.moves.length, 0);

  const adapter = portalAdapter({ '4,71,0': 'portal' });
  const nearest = adapter._nearestPortal();
  assert.deepEqual(nearest.position, { x: 4, y: 71, z: 0 });
  const result = await adapter._gotoPortal({});
  assert.equal(result.ok, true);
  assert.equal(result.portal.x, 4);
  assert.equal(adapter.events.moves.length, 1);
  // La destinazione è il centro del blocco di portale, non un angolo.
  assert.equal(adapter.events.moves[0].x, 4.5);
});

test('_gotoPortal refuses a portal outside the walkable component', async () => {
  const adapter = portalAdapter({ '4,71,0': 'portal' });
  adapter._reachabilityUsable = () => true;
  adapter.approachReachable = () => false;
  const result = await adapter._gotoPortal({});
  assert.equal(result.ok, false);
  assert.equal(result.error, 'portal_unreachable');
  assert.equal(adapter.events.moves.length, 0);
});

test('_enterPortal waits for the server dimension change, not for a feeling', async () => {
  const adapter = portalAdapter({ '2,71,0': 'portal' });
  adapter._moveTo = async (target) => {
    adapter.events.moves.push({ ...target });
    return true;
  };
  // Nessun cambio di dimensione: il verdetto resta onesto.
  const stuck = await adapter._enterPortal({ timeoutMs: 150 });
  assert.equal(stuck.ok, false);
  assert.equal(stuck.error, 'dimension_unchanged');
  assert.equal(stuck.from, 'overworld');
  assert.equal(stuck.to, 'overworld');

  // Il server cambia dimensione durante il passo: conferma dal pacchetto.
  const travelling = portalAdapter({ '2,71,0': 'portal' });
  travelling._moveTo = async () => { travelling.dimension = 'nether'; return true; };
  const crossed = await travelling._enterPortal({ timeoutMs: 1500 });
  assert.deepEqual([crossed.ok, crossed.from, crossed.to], [true, 'overworld', 'nether']);

  const noPortal = portalAdapter();
  assert.equal((await noPortal._enterPortal({ timeoutMs: 50 })).error, 'no_portal_known');
});

test('_buildPortal needs the obsidian, picks a free site and reports a half frame', async () => {
  const poor = portalAdapter({}, { inventory: { obsidian: 4 } });
  const missing = await poor._buildPortal({});
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'missing_materials');
  assert.deepEqual(missing.missing, [{ item: 'obsidian', need: 14, have: 4 }]);
  assert.equal(poor.events.placed.length, 0);

  const rich = portalAdapter({}, { inventory: { obsidian: 20 } });
  const built = await rich._buildPortal({});
  assert.equal(built.ok, true);
  assert.equal(built.placed, 14);
  // Una cornice completa piazzata dal basso verso l'alto, sul terreno del
  // fixture (stone a y=70) e mai dentro il bot.
  assert.equal(rich.events.placed.length, 14);
  assert.equal(rich.events.placed[0].target.y, rich.events.placed.at(-1).target.y - 4);
  assert.equal(rich.events.placed.some(cell => cell.target.x === 0 && cell.target.z === 0), false);
  assert.equal(rich.events.placed.every(cell => cell.support.y === cell.target.y - 1), true);
  assert.equal(rich.inventory.obsidian, 6);
  assert.equal(rich._lastPortalFrame.placed, 14);
  assert.equal(rich._netherView().portalFrame.placed, 14);
  // Un piazzamento che non viene confermato ferma il cantiere invece di
  // lasciare una cornice a metà nel mondo.
  const flaky = portalAdapter({}, { inventory: { obsidian: 20 } });
  let count = 0;
  flaky._placeAtCell = async (item, block, target) => {
    count++;
    flaky.events.placed.push({ item, block, target: { ...target } });
    return count === 3 ? { ok: false, error: 'place_not_confirmed' } : { ok: true };
  };
  const broken = await flaky._buildPortal({});
  assert.equal(broken.ok, false);
  assert.equal(broken.error, 'portal_frame_incomplete');
  assert.equal(broken.placed, 2);
  assert.equal(broken.failed.length, 1);
  assert.equal(flaky.events.placed.length, 3);
});

test('_buildPortal refuses a site that is not free', async () => {
  // Tutte le celle intorno al bot occupate da pietra: nessun cantiere.
  const cells = {};
  for (let x = -3; x <= 3; x++) {
    for (let z = -3; z <= 3; z++) {
      for (let y = 71; y <= 75; y++) {
        if (x === 0 && z === 0 && y <= 72) continue;
        cells[`${x},${y},${z}`] = 'stone';
      }
    }
  }
  const adapter = portalAdapter(cells, { inventory: { obsidian: 20 } });
  const result = await adapter._buildPortal({});
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no_portal_site');
  assert.equal(adapter.events.placed.length, 0);
});

test('_lightPortal needs the igniter, finds the frame and confirms the lit portal', async () => {
  const plan = planPortalFrame({ origin: { x: 2, y: 71, z: 0 } });
  const frameCells = {};
  for (const cell of plan.frame) frameCells[`${cell.position.x},${cell.position.y},${cell.position.z}`] = 'obsidian';
  for (const cell of plan.interior) frameCells[`${cell.x},${cell.y},${cell.z}`] = 'air';

  const noFlint = portalAdapter(frameCells);
  assert.equal((await noFlint._lightPortal({})).error, 'missing_flint_and_steel');

  const noFrame = portalAdapter({}, { inventory: { flint_and_steel: 1 } });
  assert.equal((await noFrame._lightPortal({})).error, 'no_portal_frame');

  const adapter = portalAdapter(frameCells, { inventory: { flint_and_steel: 1 } });
  // Il click del finto server accende il portale: le celle interne diventano
  // `portal` solo dopo la transazione (altrimenti il verdetto resta onesto).
  let lit = false;
  const rawBlockAt = adapter.world.blockAt;
  const interiorKey = new Set(plan.interior.map(cell => `${cell.x},${cell.y},${cell.z}`));
  adapter.world.blockAt = (position) => {
    if (lit && interiorKey.has(`${position.x},${position.y},${position.z}`)) return { name: 'portal', position: { ...position } };
    return rawBlockAt(position);
  };
  const rawQueue = adapter._queueAuthInput;
  adapter._queueAuthInput = async (payload) => { await rawQueue(payload); if (payload?.transaction) lit = true; };
  const result = await adapter._lightPortal({ timeoutMs: 500 });
  assert.equal(result.ok, true);
  assert.equal(result.ignition.x, 2);
  assert.equal(result.ignition.y, 70);
  // Un click, su un blocco vero e con l'accendino in mano: nessuna scorciatoia.
  assert.equal(adapter.events.transactions.length, 1);
  assert.equal(adapter.events.transactions[0].data.action_type, 'click_block');
  assert.equal(adapter.events.transactions[0].data.block_position.x, 2);
  assert.equal(adapter.events.transactions[0].data.block_position.y, 70);
  assert.equal(adapter.events.transactions[0].data.held_item.name, 'flint_and_steel');

  // Una cornice già accesa non si riaccende.
  const already = portalAdapter({ ...frameCells, '2,71,0': 'portal' }, { inventory: { flint_and_steel: 1 } });
  const second = await already._lightPortal({ timeoutMs: 200 });
  assert.deepEqual([second.ok, second.lit, second.already], [true, true, true]);
  assert.equal(already.events.transactions.length, 0);
});

test('the portal actions only show up in /options when the ingredients exist', () => {
  const bare = portalAdapter();
  const bareKeys = bare.options().map(option => option.key);
  assert.equal(bareKeys.includes('goto_portal'), false);
  assert.equal(bareKeys.includes('enter_portal'), false);
  assert.equal(bareKeys.includes('build_portal'), false);
  assert.equal(bareKeys.includes('light_portal'), false);

  const withPortal = portalAdapter({ '2,71,0': 'portal' });
  const portalKeys = withPortal.options().map(option => option.key);
  assert.equal(portalKeys.includes('goto_portal'), true);
  assert.equal(portalKeys.includes('enter_portal'), true);

  const builder = portalAdapter({}, { inventory: { obsidian: 14 } });
  assert.equal(builder.options().map(option => option.key).includes('build_portal'), true);

  const plan = planPortalFrame({ origin: { x: 2, y: 71, z: 0 } });
  const frameCells = {};
  for (const cell of plan.frame) frameCells[`${cell.position.x},${cell.position.y},${cell.position.z}`] = 'obsidian';
  for (const cell of plan.interior) frameCells[`${cell.x},${cell.y},${cell.z}`] = 'air';
  const lighter = portalAdapter(frameCells, { inventory: { flint_and_steel: 1 } });
  assert.equal(lighter.options().map(option => option.key).includes('light_portal'), true);
});

// --- N2: sopravvivenza nel Nether (hub, materiali che non bruciano) -------

function hubAdapter ({ inventory = {}, dimension = 'nether' } = {}) {
  const adapter = portalAdapter({}, { inventory, dimension });
  adapter.memory = { landmarks: [], rememberLandmark (landmark) { this.landmarks.push(landmark); } };
  return adapter;
}

test('_netherHub rifiuta di costruire fuori dal Nether/End', async () => {
  const overworld = hubAdapter({ inventory: { cobblestone: 20 }, dimension: 'overworld' });
  const result = await overworld._netherHub({});
  assert.equal(result.error, 'wrong_dimension');
  assert.equal(result.dimension, 'overworld');
  assert.equal(overworld.events.placed.length, 0);
});

test('_netherHub senza materiale non infiammabile dice cosa ha rifiutato', async () => {
  const adapter = hubAdapter({ inventory: { oak_planks: 40, oak_log: 10 } });
  const result = await adapter._netherHub({});
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no_hub_materials');
  assert.deepEqual(result.flammable.sort(), ['oak_log', 'oak_planks']);
  assert.equal(adapter.events.placed.length, 0);
});

test('_netherHub costruisce la casetta col materiale non infiammabile e la ricorda come home', async () => {
  const adapter = hubAdapter({ inventory: { oak_planks: 40, cobblestone: 20 } });
  const result = await adapter._netherHub({});
  assert.equal(result.ok, true);
  assert.equal(result.block, 'cobblestone');
  assert.equal(result.placed.length, 12);
  assert.equal(result.failed.length, 0);
  assert.equal(result.covered, 12);
  assert.deepEqual(result.hub, { x: 0, y: 71, z: 0 });
  assert.ok(adapter.events.placed.every(p => p.block === 'cobblestone'));
  assert.equal(adapter.inventory.cobblestone, 8);
  assert.equal(adapter.inventory.oak_planks, 40, 'la legna non viene toccata');
  assert.equal(adapter._netherHubLast.sealed, true);
  assert.equal(adapter._netherView().hub.sealed, true);
  assert.equal(adapter.memory.landmarks.length, 1);
  assert.equal(adapter.memory.landmarks[0].id, 'nether_hub');
  assert.equal(adapter.memory.landmarks[0].kind, 'home');
  assert.equal(adapter.memory.landmarks[0].dimension, 'nether');
});

test('_netherHub resta incompleto e non si ricorda come home se un muro non si piazza', async () => {
  const adapter = hubAdapter({ inventory: { cobblestone: 20 } });
  let calls = 0;
  adapter._placeAtCell = async (item, block, target, support, face) => {
    calls++;
    adapter.events.placed.push({ item, block, target: { ...target }, support: { ...support }, face });
    if (calls === 3) return { ok: false, error: 'place_not_confirmed' };
    return { ok: true };
  };
  const result = await adapter._netherHub({});
  assert.equal(result.ok, false);
  assert.equal(result.error, 'hub_incomplete');
  assert.equal(result.placed.length, 11);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].error, 'place_not_confirmed');
  assert.equal(adapter.memory.landmarks.length, 0);
  assert.equal(adapter._netherHubLast.sealed, false);
});

test('build_nether_hub è offerto solo nel Nether e solo con materiale che non brucia', () => {
  const netherReady = hubAdapter({ inventory: { cobblestone: 20 } });
  assert.equal(netherReady.options().map(o => o.key).includes('build_nether_hub'), true);
  const netherWood = hubAdapter({ inventory: { oak_planks: 20 } });
  assert.equal(netherWood.options().map(o => o.key).includes('build_nether_hub'), false, 'solo legna: niente hub');
  const overworld = hubAdapter({ inventory: { cobblestone: 20 }, dimension: 'overworld' });
  assert.equal(overworld.options().map(o => o.key).includes('build_nether_hub'), false, 'in Overworld il rifugio è build_hut');
});

// Un fireball che arriva da sud verso il bot, con due campioni: la traiettoria
// è misurata (source 'samples'), quindi la schivata sa da quale linea uscire.
function inboundFireball (adapter, { z = 11.5, from = 21.5 } = {}) {
  const now = Date.now();
  adapter.entities.set('9', {
    runtimeId: '9',
    type: 'minecraft:fireball',
    kind: 'mob',
    position: { x: 0.5, y: 72, z },
    prev: { position: { x: 0.5, y: 72, z: from }, at: now - 1000 },
    lastAt: now - 500,
  });
  return adapter.entities.get('9');
}

// Le due celle candidate (x -3 e +3 alla quota dei piedi) libere e calpestabili.
function dodgeCells () {
  return {
    '-3,71,0': 'air', '-3,72,0': 'air',
    '3,71,0': 'air', '3,72,0': 'air',
  };
}

test('_dodgeProjectile steps out of the line and verifies the threat cleared', async () => {
  const adapter = netherAdapter(dodgeCells());
  inboundFireball(adapter);
  const moved = [];
  adapter._moveTo = async (cell, tolerance, timeoutMs) => {
    moved.push({ cell, tolerance, timeoutMs });
    adapter.entities.clear(); // il proiettile è passato: la linea è libera
  };
  const result = await adapter._dodgeProjectile({ timeoutMs: 3000 });
  assert.equal(result.ok, true);
  assert.equal(result.dodged, true);
  assert.equal(moved.length, 1);
  assert.equal(result.threat.type, 'minecraft:fireball');
  assert.equal(result.threat.source, 'samples');
  // Una delle due celle laterali, mai la colonna del bot.
  assert.ok(['-3', '3'].includes(String(moved[0].cell.x)), `x=${moved[0].cell.x}`);
  assert.equal(moved[0].cell.z, 0);
  assert.equal(moved[0].cell.y, 71);
  assert.ok(result.lateral > 0);
});

test('_dodgeProjectile refuses when nothing is inbound', async () => {
  const adapter = netherAdapter(dodgeCells());
  let moves = 0;
  adapter._moveTo = async () => { moves++; };
  assert.deepEqual(await adapter._dodgeProjectile({}), { ok: false, error: 'no_projectile_incoming' });
  assert.equal(moves, 0, 'refusing must not burn a pathfinding attempt');
});

test('_dodgeProjectile fails fast when every candidate is unsafe or blocked', async () => {
  // Le due celle laterali murate: nessuna schivata possibile.
  const blocked = netherAdapter({ '-3,71,0': 'stone', '-3,72,0': 'stone', '3,71,0': 'stone', '3,72,0': 'stone' });
  inboundFireball(blocked);
  let moves = 0;
  blocked._moveTo = async () => { moves++; };
  const result = await blocked._dodgeProjectile({});
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no_dodge_spot');
  assert.equal(result.threat.type, 'minecraft:fireball');
  assert.equal(moves, 0);

  // Lava accanto a una candidata: quella candidata non è una destinazione.
  const lava = netherAdapter({ ...dodgeCells(), '-2,71,0': 'lava' });
  inboundFireball(lava);
  const cells = lava._dodgeCandidates().cells.map(c => c.x);
  assert.ok(!cells.includes(-3), `la cella accanto alla lava non è candidata: ${JSON.stringify(cells)}`);
  assert.deepEqual(cells, [3]);
});

test('the dodge option appears only with an inbound projectile and a safe cell', () => {
  const quiet = netherAdapter(dodgeCells());
  assert.ok(!quiet.options().some(o => o.key === 'dodge_projectile'));
  const threatened = netherAdapter(dodgeCells());
  inboundFireball(threatened);
  const option = threatened.options().find(o => o.key === 'dodge_projectile');
  assert.ok(option, 'expected the dodge option');
  assert.match(option.description, /Step out of the line of the minecraft:fireball/);
  assert.match(option.description, /impact in \d+ ms/);
  // Con le celle laterali murate non c'è nessuna opzione: meglio niente che una
  // schivata impossibile.
  const walled = netherAdapter({ '-3,71,0': 'stone', '-3,72,0': 'stone', '3,71,0': 'stone', '3,72,0': 'stone' });
  inboundFireball(walled);
  assert.ok(!walled.options().some(o => o.key === 'dodge_projectile'));
});

// ---- N4: bartering con i piglin ------------------------------------------

// Un adapter con piglin, oro in inventario e i pacchetti catturati: la
// `inventory_transaction` vera parte (nessuno stub di `_interactEntity`), così
// il test vede esattamente cosa il bot direbbe al server.
function barterAdapter ({ piglins = [], inventory = {}, armor = {}, cells = {} } = {}) {
  const adapter = netherAdapter(cells);
  adapter.inventory = { ...inventory };
  adapter.inventorySlots = Object.entries(adapter.inventory).map(([name, count], i) => ({ network_id: 100 + i, name, count, stack_id: i }));
  adapter.selectedHotbar = 0;
  adapter.armor = { helmet: null, chestplate: null, leggings: null, boots: null, ...armor };
  adapter.drops = [];
  adapter.writes = [];
  adapter.client = {
    write (name, packet) {
      adapter.writes.push({ name, packet });
      const data = packet?.transaction?.transaction_data;
      if (name === 'inventory_transaction' && data?.action_type === 'interact') {
        // Il piglin prende il lingotto e getta il pegno accanto a sé.
        adapter.inventory.gold_ingot = Math.max(0, (adapter.inventory.gold_ingot || 0) - 1);
        adapter.drops.push({ item: 'ender_pearl', position: { x: 3.5, y: 71, z: 0.5 } });
      }
    },
  };
  piglins.forEach((piglin, i) => {
    adapter.entities.set(String(20 + i), {
      runtimeId: String(20 + i),
      type: piglin.type,
      kind: 'mob',
      position: { ...piglin.position },
      baby: piglin.baby,
      lastAt: Date.now(),
    });
  });
  adapter._lookAt = () => ({ yaw: 0, pitch: 0 });
  adapter._queueAuthInput = async () => {};
  adapter._closeContainer = async () => {};
  adapter.events = { logs: [] };
  adapter.log = (type, data) => { adapter.events.logs.push({ type, data }); };
  return adapter;
}

test('_barterPiglin refuses without a piglin, with a brute or with a baby', async () => {
  const empty = barterAdapter({ inventory: { gold_ingot: 2 } });
  assert.equal((await empty._barterPiglin({})).error, 'no_piglin_nearby');

  const brute = barterAdapter({ piglins: [{ type: 'minecraft:piglin_brute', position: { x: 3, y: 71, z: 0 } }], inventory: { gold_ingot: 2 } });
  const bruteResult = await brute._barterPiglin({});
  assert.equal(bruteResult.error, 'piglin_brute_not_barterable');
  assert.equal(bruteResult.piglin.type, 'minecraft:piglin_brute');
  assert.equal(brute.writes.length, 0, 'nessun pacchetto verso un bruto');

  const baby = barterAdapter({ piglins: [{ type: 'minecraft:piglin', position: { x: 3, y: 71, z: 0 }, baby: true }], inventory: { gold_ingot: 2 } });
  assert.equal((await baby._barterPiglin({})).error, 'piglin_baby_not_barterable');

  const broke = barterAdapter({ piglins: [{ type: 'minecraft:piglin', position: { x: 3, y: 71, z: 0 } }] });
  const brokeResult = await broke._barterPiglin({});
  assert.equal(brokeResult.error, 'missing_gold_ingot');
  assert.equal(brokeResult.item, 'gold_ingot');
  assert.equal(broke.writes.length, 0);
});

test('_barterPiglin hands over the ingot with interact, collects the drop and never attacks', async () => {
  const adapter = barterAdapter({
    piglins: [{ type: 'minecraft:piglin', position: { x: 3, y: 71, z: 0 } }],
    inventory: { gold_ingot: 2 },
  });
  let collected = 0;
  adapter._collectDrop = async () => {
    collected++;
    adapter.inventory.ender_pearl = (adapter.inventory.ender_pearl || 0) + 1;
    adapter.drops = [];
    return { ok: true, picked: [{ item: 'ender_pearl', count: 1 }] };
  };
  const result = await adapter._barterPiglin({ timeoutMs: 4000 });
  assert.equal(result.ok, true);
  assert.equal(result.bartered, true);
  assert.equal(result.gave, 'gold_ingot');
  assert.equal(result.gaveIngot, true);
  assert.equal(result.neutral, false, 'senza oro addosso il resoconto lo dice');
  assert.deepEqual(result.drops, ['ender_pearl']);
  assert.deepEqual(result.rewards, ['ender_pearl']);
  assert.equal(result.collected[0].item, 'ender_pearl');
  assert.equal(result.collected[0].ok, true);
  assert.equal(adapter.inventory.gold_ingot, 1, 'un lingotto pagato');
  assert.equal(collected, 1);
  // Il pacchetto è `item_use_on_entity` con `interact`: mai `attack`.
  const transactions = adapter.writes.filter(w => w.name === 'inventory_transaction');
  assert.ok(transactions.length >= 1);
  for (const write of transactions) {
    assert.equal(write.packet.transaction.transaction_type, 'item_use_on_entity');
    assert.equal(write.packet.transaction.transaction_data.action_type, 'interact');
  }
  // Nessun pacchetto contiene un'azione di attacco: il bartering è solo `interact`.
  const attackActions = adapter.writes.filter(w => {
    const data = w.packet?.transaction?.transaction_data;
    return data && data.action_type !== 'interact';
  });
  assert.deepEqual(attackActions, []);
  assert.equal(adapter._barterLast.ok, true);
  assert.ok(adapter.events.logs.some(e => e.type === 'barter_piglin'));
});

test('_barterPiglin reports an unconfirmed trade instead of a false success', async () => {
  const adapter = barterAdapter({
    piglins: [{ type: 'minecraft:piglin', position: { x: 3, y: 71, z: 0 } }],
    inventory: { gold_ingot: 1 },
  });
  adapter.client.write = (name, packet) => { adapter.writes.push({ name, packet }); }; // niente pegno
  const result = await adapter._barterPiglin({ timeoutMs: 300 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'barter_not_confirmed');
  assert.equal(result.bartered, false);
  assert.equal(result.gaveIngot, false);
  assert.equal(adapter.inventory.gold_ingot, 1, 'nessun lingotto consumato');
  assert.equal(adapter._barterLast.error, 'barter_not_confirmed');
  assert.ok(adapter.events.logs.some(e => e.type === 'barter_not_confirmed'));
});

test('a piglin is never an attack target and bartering is offered only when it can work', () => {
  const adapter = barterAdapter({
    piglins: [{ type: 'minecraft:piglin', position: { x: 4, y: 71, z: 0 } }],
    inventory: { gold_ingot: 1 },
  });
  const keys = adapter.options().map(o => o.key);
  assert.ok(!keys.some(k => k.startsWith('attack_')), `un piglin non è mai un bersaglio: ${keys.filter(k => k.startsWith('attack_'))}`);
  const option = adapter.options().find(o => o.key === 'barter_piglin');
  assert.ok(option, 'con oro e un piglin a tiro il bartering è offerto');
  assert.match(option.description, /handing it a gold_ingot/);
  assert.match(option.description, /no gold armour worn/);

  // Con l'oro addosso la descrizione non avverte più.
  const armored = barterAdapter({
    piglins: [{ type: 'minecraft:piglin', position: { x: 4, y: 71, z: 0 } }],
    inventory: { gold_ingot: 1 },
    armor: { helmet: 'golden_helmet' },
  });
  assert.ok(!/no gold armour worn/.test(armored.options().find(o => o.key === 'barter_piglin').description));
  assert.equal(armored._netherView().goldArmor.neutral, true);
  assert.deepEqual(armored._netherView().goldArmor.worn, ['golden_helmet']);

  // Senza lingotti l'opzione non esiste.
  const broke = barterAdapter({ piglins: [{ type: 'minecraft:piglin', position: { x: 4, y: 71, z: 0 } }], inventory: {} });
  assert.ok(!broke.options().some(o => o.key === 'barter_piglin'));
  // Un bruto non è un candidato: nessuna offerta di bartering.
  const brute = barterAdapter({ piglins: [{ type: 'minecraft:piglin_brute', position: { x: 4, y: 71, z: 0 } }], inventory: { gold_ingot: 1 } });
  assert.ok(!brute.options().some(o => o.key === 'barter_piglin'));
});

test('_netherView reports the piglin and the last barter', async () => {
  const adapter = barterAdapter({
    piglins: [{ type: 'minecraft:piglin', position: { x: 3, y: 71, z: 0 } }],
    inventory: { gold_ingot: 2 },
  });
  adapter._collectDrop = async () => ({ ok: true, picked: [{ item: 'ender_pearl', count: 1 }] });
  const before = adapter._netherView();
  assert.equal(before.piglin.type, 'minecraft:piglin');
  assert.equal(before.piglin.barterable, true);
  assert.equal(before.piglin.brute, false);
  assert.equal(before.barter, null);
  await adapter._barterPiglin({ timeoutMs: 4000 });
  const after = adapter._netherView();
  assert.equal(after.barter.ok, true);
  assert.deepEqual(after.barter.drops, ['ender_pearl']);
  assert.ok(after.barter.at, 'il resoconto è timbrato');
});
