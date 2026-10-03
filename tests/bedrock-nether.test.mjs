// Nether/End awareness (N0 di docs/wiki/nether.md): classificazione di portali e
// pericoli, censimento, proiettili in arrivo, sguardo verso un enderman e verdetto
// sui pericoli. Modulo puro, nessun server.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  portalKind, hazardKind, isFireBlock, isSpawnerBlock, isProjectileType,
  isEndermanType, normalizeDimension, isNetherDimension, isEndDimension,
  isNetherLike, waterEvaporates, bedsExplode,
  summarizePortals, summarizeHazards, projectileThreat, projectileIncoming,
  gazeVector, gazeAngle, gazedAtEnderman, netherHazard,
  PROJECTILE_TYPES, ENDERMAN_GAZE_TOLERANCE_DEG,
} from '../bedrock-nether.mjs';

const at = (x, y, z) => ({ x, y, z });

test('portalKind and hazardKind classify the blocks the census cares about', () => {
  assert.equal(portalKind('portal'), 'nether');
  // Su Bedrock il blocco del portale del Nether si chiama `portal`; `nether_portal`
  // è il nome della versione Java e non esiste nelle palette di questo server.
  assert.equal(portalKind('minecraft:portal'), 'nether');
  assert.equal(portalKind('end_portal'), 'end');
  assert.equal(portalKind('end_gateway'), 'end');
  assert.equal(portalKind('end_portal_frame'), 'frame');
  assert.equal(portalKind('stone'), null);
  assert.equal(hazardKind('fire'), 'fire');
  assert.equal(hazardKind('soul_fire'), 'fire');
  assert.equal(hazardKind('magma'), 'magma');
  assert.equal(hazardKind('minecraft:magma_block'), 'magma');
  assert.equal(hazardKind('lava'), 'lava');
  assert.equal(hazardKind('dirt'), null);
});

test('block predicates accept namespaced and bare names', () => {
  assert.equal(isFireBlock('minecraft:soul_fire'), true);
  assert.equal(isFireBlock('fire'), true);
  assert.equal(isFireBlock('campfire'), false);
  assert.equal(isSpawnerBlock('mob_spawner'), true);
  assert.equal(isSpawnerBlock('monster_spawner'), true);
  assert.equal(isSpawnerBlock('spawner'), true);
  assert.equal(isSpawnerBlock('chest'), false);
});

test('projectile and enderman type recognition covers the dangerous ones', () => {
  assert.equal(PROJECTILE_TYPES.has('fireball'), true);
  assert.equal(PROJECTILE_TYPES.has('arrow'), true);
  assert.equal(PROJECTILE_TYPES.has('thrown_trident'), true);
  assert.equal(isProjectileType('small_fireball'), true);
  assert.equal(isProjectileType('minecraft:arrow'), true);
  assert.equal(isProjectileType('Arrow'), true);
  assert.equal(isProjectileType('cow'), false);
  assert.equal(isEndermanType('enderman'), true);
  assert.equal(isEndermanType('minecraft:enderman'), true);
  assert.equal(isEndermanType('zombie'), false);
});

test('dimension helpers tell the Overworld apart from the Nether and the End', () => {
  assert.equal(normalizeDimension('minecraft:nether'), 'nether');
  assert.equal(normalizeDimension('the_end'), 'the_end');
  assert.equal(isNetherDimension('nether'), true);
  assert.equal(isNetherDimension('overworld'), false);
  assert.equal(isEndDimension('the_end'), true);
  assert.equal(isEndDimension('the nether'), false);
  assert.equal(isNetherLike('nether'), true);
  assert.equal(isNetherLike('overworld'), false);
  // Acqua e letti: le due regole del gioco che cambiano fuori dall'Overworld.
  assert.equal(waterEvaporates('nether'), true);
  assert.equal(waterEvaporates('overworld'), false);
  assert.equal(bedsExplode('nether'), true);
  assert.equal(bedsExplode('the_end'), true);
  assert.equal(bedsExplode('overworld'), false);
});

test('summarizePortals separates nether portals, end portals and frames', () => {
  const blocks = [
    { name: 'portal', position: at(10, 60, 0) },
    { name: 'portal', position: at(30, 60, 0) },
    { name: 'end_portal_frame', position: at(5, 60, 5) },
    { name: 'end_portal', position: at(5, 61, 5) },
    { name: 'stone', position: at(1, 1, 1) },
  ];
  const summary = summarizePortals(blocks, at(0, 60, 0));
  assert.equal(summary.nether.count, 2);
  assert.equal(summary.end.count, 1);
  assert.equal(summary.frames.count, 1);
  assert.equal(summary.portalDistance, 10);
  assert.equal(summary.endPortalDistance, Math.round(Math.hypot(5, 1, 5) * 10) / 10);
  assert.equal(summary.endFrameDistance, Math.round(Math.hypot(5, 0, 5) * 10) / 10);
  assert.deepEqual(summary.nether.nearest, { position: at(10, 60, 0), distance: 10 });
});

test('summarizeHazards measures fire, magma and spawners independently', () => {
  const blocks = [
    { name: 'fire', position: at(0, 60, 0) },
    { name: 'soul_fire', position: at(4, 60, 0) },
    { name: 'magma', position: at(0, 59, 3) },
    { name: 'mob_spawner', position: at(9, 60, 0) },
  ];
  const summary = summarizeHazards(blocks, at(0, 60, 0));
  assert.equal(summary.fire.count, 2);
  assert.equal(summary.magma.count, 1);
  assert.equal(summary.spawners.count, 1);
  assert.equal(summary.fireDistance, 0);
  assert.equal(summary.magmaDistance, 3.2);
  assert.equal(summary.spawnerDistance, 9);
});

test('projectileThreat answers "is this going to hit me" from velocity or samples', () => {
  const from = at(0, 64, 0);
  // Arriva dritto addosso a 10 blocchi/s: 1 s al contatto, miss 0.
  const hit = projectileThreat({
    from, position: at(0, 64, 10), velocity: at(0, 0, -10), now: 1000,
  });
  assert.equal(hit.known, true);
  assert.equal(hit.incoming, true);
  assert.equal(hit.source, 'velocity');
  assert.equal(hit.timeToImpactMs, 1000);
  assert.equal(hit.missDistance, 0);

  // Passa a 5 blocchi di lato: noto, ma non in arrivo.
  const miss = projectileThreat({
    from, position: at(5, 64, 10), velocity: at(0, 0, -10), now: 1000,
  });
  assert.equal(miss.known, true);
  assert.equal(miss.incoming, false);
  assert.equal(miss.missDistance, 5);

  // Si allontana.
  const away = projectileThreat({
    from, position: at(0, 64, 10), velocity: at(0, 0, 10), now: 1000,
  });
  assert.equal(away.incoming, false);
  assert.equal(away.timeToImpactMs, null);

  // Senza velocità ma con due campioni recenti: la stima arriva dai campioni.
  const sampled = projectileThreat({
    from,
    position: at(0, 64, 10),
    previous: { position: at(0, 64, 20), at: 1000 },
    now: 2000,
  });
  assert.equal(sampled.known, true);
  assert.equal(sampled.source, 'samples');
  assert.equal(sampled.incoming, true);
  assert.equal(sampled.speed, 10);

  // Campioni troppo vecchi (o nessuna velocità): non si inventa nulla.
  const stale = projectileThreat({
    from,
    position: at(0, 64, 10),
    previous: { position: at(0, 64, 20), at: 0 },
    now: 9000,
  });
  assert.equal(stale.known, false);
  assert.equal(stale.incoming, null);
  assert.equal(projectileThreat({ from, position: at(0, 64, 10) }).known, false);

  // Oltre l'orizzonte temporale non è più una minaccia da schivare adesso.
  const far = projectileThreat({
    from, position: at(0, 64, 100), velocity: at(0, 0, -1), now: 1000,
  });
  assert.equal(far.known, true);
  assert.equal(far.incoming, false);
  assert.equal(far.timeToImpactMs, 100000);
});

test('projectileIncoming returns the most urgent shot, or null', () => {
  const from = at(0, 64, 0);
  const now = 1000;
  assert.equal(projectileIncoming({ projectiles: [], from, now }), null);
  const urgent = projectileIncoming({
    from,
    now,
    projectiles: [
      { type: 'arrow', position: at(0, 64, 20), velocity: at(0, 0, -10) },
      { type: 'fireball', position: at(0, 64, 5), velocity: at(0, 0, -10) },
    ],
  });
  assert.equal(urgent.type, 'fireball');
  assert.equal(urgent.timeToImpactMs, 500);
  // Un proiettile senza posizione viene ignorato, non fa esplodere la funzione.
  assert.equal(projectileIncoming({ projectiles: [{ type: 'arrow' }], from, now }), null);
});

test('gazeVector follows the adapter yaw convention (-Z north, +X east)', () => {
  const south = gazeVector({ yaw: 0, pitch: 0 });
  assert.equal(Math.round(south.z), 1);
  const east = gazeVector({ yaw: 270, pitch: 0 });
  assert.equal(Math.round(east.x), 1);
  const north = gazeVector({ yaw: 180, pitch: 0 });
  assert.equal(Math.round(north.z), -1);
  const up = gazeVector({ yaw: 0, pitch: -90 });
  assert.equal(Math.round(up.y), 1);
});

test('gazeAngle measures the angle to the eyes of a target', () => {
  const from = at(0, 64, 0);
  // Enderman con gli occhi alla stessa quota dello sguardo: guardando a sud
  // l'angolo è ~0.
  const level = at(0, 64 - 2.55, 10);
  const straight = gazeAngle({ from, yaw: 0, pitch: 0, target: level, targetEyeHeight: 2.55 });
  assert.ok(straight <= 1, `expected ~0, got ${straight}`);
  // Guardando a nord è ~180.
  const opposite = gazeAngle({ from, yaw: 180, pitch: 0, target: level, targetEyeHeight: 2.55 });
  assert.ok(opposite >= 179, `expected ~180, got ${opposite}`);
  // Orientamento o posizione ignoti: null, mai un'accusa inventata.
  assert.equal(gazeAngle({ from: null, yaw: 0, pitch: 0, target: at(0, 64, 10) }), null);
  assert.equal(gazeAngle({ from, yaw: null, pitch: 0, target: at(0, 64, 10) }), null);
});

test('gazedAtEnderman reports the nearest enderman and whether the bot is looking', () => {
  const from = at(0, 64, 0);
  const endermans = [
    { type: 'minecraft:enderman', position: at(0, 63.5, 10) },
    { type: 'minecraft:enderman', position: at(0, 64 - 2.55, 3) },
  ];
  const looking = gazedAtEnderman({ from, yaw: 0, pitch: 0, endermans });
  // La distanza è calcolata dai piedi dell'entità (la convenzione di `_trackEntity`).
  assert.equal(looking.distance, 3.9);
  assert.equal(looking.gazed, true);
  assert.ok(looking.angleDeg <= ENDERMAN_GAZE_TOLERANCE_DEG);

  const away = gazedAtEnderman({ from, yaw: 180, pitch: 0, endermans });
  assert.equal(away.gazed, false);

  // Gli occhi dell'enderman più lontano stanno più in alto: guardare dritto a
  // sud non basta più (l'angolo cresce) e con la tolleranza stretta non è
  // "guardato".
  const high = gazedAtEnderman({
    from, yaw: 0, pitch: 0,
    endermans: [{ type: 'enderman', position: at(0, 63.5, 3) }],
  });
  assert.equal(high.gazed, false);
  assert.ok(high.angleDeg > ENDERMAN_GAZE_TOLERANCE_DEG);

  // Oltre il raggio non si guarda nessuno.
  assert.equal(gazedAtEnderman({ from, yaw: 0, pitch: 0, endermans: [{ type: 'enderman', position: at(0, 63.5, 40) }] }), null);
  // I non-enderman sono ignorati anche se in linea di vista.
  assert.equal(gazedAtEnderman({ from, yaw: 0, pitch: 0, endermans: [{ type: 'zombie', position: at(0, 63.5, 3) }] }), null);
});

test('netherHazard ranks fire above magma and stays inert with no danger', () => {
  assert.equal(netherHazard({ dimension: 'overworld' }).level, 'none');
  assert.equal(netherHazard({ dimension: 'nether', inFire: true }).level, 'critical');
  assert.deepEqual(netherHazard({ inFire: true }).reasons, ['in_fire']);
  assert.equal(netherHazard({ fireDistance: 1 }).level, 'critical');
  assert.equal(netherHazard({ inLava: true }).level, 'critical');
  assert.equal(netherHazard({ magmaDistance: 1 }).level, 'high');
  assert.equal(netherHazard({ fireDistance: 4 }).level, 'high');
  assert.equal(netherHazard({ magmaDistance: 3 }).level, 'medium');
  const far = netherHazard({ fireDistance: 9, magmaDistance: 7 });
  assert.equal(far.level, 'low');
  assert.deepEqual(far.reasons, ['fire_in_range', 'magma_in_range']);
});
