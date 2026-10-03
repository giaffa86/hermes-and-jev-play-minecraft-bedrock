// Nether/End awareness (N0 di docs/wiki/nether.md) nell'adapter: censimento di
// portali/pericoli con TTL, proiettili in arrivo, sguardo verso un enderman e
// rifiuto di dormire dove il letto esplode. Mondo finto, nessun socket.

import test from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

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
    const { name, properties = {} } = typeof def === 'string' ? { name: def } : def;
    blocks.set(`${x},${y},${z}`, {
      name,
      position: { x: x + 0.5, y, z: z + 0.5 },
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
  assert.equal(view.fireDistance, 2);
  assert.equal(view.magmaDistance, 4);
  assert.equal(view.spawnerDistance, 6);
  assert.equal(view.portalDistance, 8);
  assert.equal(view.portals.nether.count, 1);
  assert.equal(view.hazard.level, 'critical');
  assert.equal(view.cells.length, 4);
  // I pericoli sono nella vista senza `cells`, solo l'elenco delle celle è extra.
  const compact = adapter._netherView();
  assert.equal(compact.cells, undefined);
  assert.equal(compact.fireDistance, 2);
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
