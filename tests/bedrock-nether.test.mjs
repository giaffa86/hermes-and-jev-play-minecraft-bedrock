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
  planPortalFrame, checkPortalFrame, portalSiteBlocked, portalFrameCandidates,
  maxFallDepth, OVERWORLD_MAX_FALL, NETHER_LIKE_MAX_FALL,
  landingHazard, safeLanding, isFlammableBlock, pickHubBlock, shellCells, netherHubPlan,
  projectileVelocity, perpendicularDirs, lateralOffset, breaksLine, dodgeCandidates, DODGE_DISTANCE,
  isPiglinType, isBarterPayment, isGoldArmorPiece, goldArmorWorn, piglinNeutral,
  isBarterReward, barterTarget, BARTER_INGOT, PIGLIN_TYPES,
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

// --- N1: geometria del portale ---------------------------------------------

const flatWorld = (cells, { name = 'obsidian' } = {}) => {
  const map = new Map(Object.entries(cells));
  return (position) => map.get(`${position.x},${position.y},${position.z}`) ?? name;
};

test('planPortalFrame builds the classic 4x5 ring and the ignition cell', () => {
  const plan = planPortalFrame({ origin: at(10, 71, 20) });
  assert.equal(plan.ok, true);
  assert.equal(plan.axis, 'x');
  assert.equal(plan.frame.length, 14);
  assert.equal(plan.interior.length, 6);
  assert.deepEqual(plan.needs, { obsidian: 14 });
  // Gli angoli sono 4 e i lati 10; l'interno è 2×3 a partire dall'origine.
  assert.equal(plan.frame.filter(cell => cell.corner).length, 4);
  assert.deepEqual(plan.interior.map(c => `${c.x},${c.y},${c.z}`).sort(), [
    '10,71,20', '10,72,20', '10,73,20',
    '11,71,20', '11,72,20', '11,73,20',
  ]);
  // La riga in basso sta sotto l'interno, la riga in alto 3 blocchi sopra.
  assert.equal(plan.frame.some(c => c.position.y === 70 && c.position.x === 10), true);
  assert.equal(plan.frame.some(c => c.position.y === 74 && c.position.x === 11), true);
  assert.deepEqual(plan.ignition, { position: at(10, 70, 20), face: 1, cell: at(10, 71, 20) });
  assert.deepEqual(plan.entry, at(10, 71, 20));
  // Le celle del piano sono cornice + interno, ognuna una volta sola.
  assert.equal(plan.cells.length, 20);
  assert.equal(new Set(plan.cells.map(c => `${c.x},${c.y},${c.z}`)).size, 20);
});

test('planPortalFrame supports the z axis, the minimal frame and rejects bad input', () => {
  const plan = planPortalFrame({ origin: at(10, 71, 20), axis: 'z' });
  assert.equal(plan.ok, true);
  assert.equal(plan.frame.length, 14);
  // Con l'asse z l'interno si allarga lungo z e la cornice resta sullo stesso x.
  assert.equal(plan.interior.every(cell => cell.x === 10), true);
  assert.deepEqual(plan.interior.map(c => c.z).sort(), [20, 20, 20, 21, 21, 21]);
  const minimal = planPortalFrame({ origin: at(0, 64, 0), withCorners: false });
  assert.equal(minimal.ok, true);
  assert.equal(minimal.frame.length, 10);
  assert.deepEqual(minimal.needs, { obsidian: 10 });
  assert.equal(minimal.frame.every(cell => !cell.corner), true);
  assert.equal(planPortalFrame({}).error, 'missing_origin');
  assert.equal(planPortalFrame({ origin: at(0, 64, 0), axis: 'y' }).error, 'unknown_axis: y');
  assert.equal(planPortalFrame({ origin: at(0, 64, 0), interiorHeight: 2 }).error, 'interior_too_small');
});

// Una cornice completa con l'interno d'aria: da qui parte ogni caso di
// verifica, cambiando solo la cella che interessa.
const aFrameWorld = (overrides = {}) => flatWorld({
  '-1,70,0': 'obsidian', '0,70,0': 'obsidian', '1,70,0': 'obsidian', '2,70,0': 'obsidian',
  '-1,74,0': 'obsidian', '0,74,0': 'obsidian', '1,74,0': 'obsidian', '2,74,0': 'obsidian',
  '-1,71,0': 'obsidian', '-1,72,0': 'obsidian', '-1,73,0': 'obsidian',
  '2,71,0': 'obsidian', '2,72,0': 'obsidian', '2,73,0': 'obsidian',
  '0,71,0': 'air', '1,71,0': 'air', '0,72,0': 'air', '1,72,0': 'air', '0,73,0': 'air', '1,73,0': 'air',
  ...overrides,
}, { name: 'air' });

test('checkPortalFrame wants obsidian around and air inside, and reports what is lit', () => {
  const plan = planPortalFrame({ origin: at(0, 71, 0) });
  const check = checkPortalFrame(plan, aFrameWorld());
  assert.equal(check.ok, true);
  assert.equal(check.lit, false);
  assert.deepEqual(check.frame.missing, []);
  assert.deepEqual(check.interior.blocked, []);
  // Un buco nella cornice: `ok: false` e la cella colpevole nominata.
  const broken = checkPortalFrame(plan, aFrameWorld({ '-1,72,0': 'air' }));
  assert.equal(broken.ok, false);
  assert.equal(broken.frame.ok, false);
  assert.deepEqual(broken.frame.missing, [{ position: at(-1, 72, 0), name: 'air' }]);
  // Un interno occupato blocca l'accensione (e non è "un buco nella cornice").
  const blocked = checkPortalFrame(plan, aFrameWorld({ '1,71,0': 'stone' }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.frame.ok, true);
  assert.deepEqual(blocked.interior.blocked, [{ position: at(1, 71, 0), name: 'stone' }]);
  // Un portale già acceso è valido e dichiarato.
  const lit = checkPortalFrame(plan, aFrameWorld({ '0,71,0': 'portal' }));
  assert.equal(lit.ok, true);
  assert.equal(lit.lit, true);
});

test('portalSiteBlocked refuses cells that are taken or unsupported', () => {
  const plan = planPortalFrame({ origin: at(0, 71, 0) });
  // Il terreno sta sotto la riga in basso (y=69); la cornice si piazza in aria.
  const supported = (position) => (position.y === 69 ? 'stone' : 'air');
  assert.deepEqual(portalSiteBlocked(plan, supported), []);
  // Senza terreno sotto la riga in basso restano quattro celle di appoggio
  // mancanti (le colonne poggiano su celle del piano, piazzate prima).
  const noSupport = portalSiteBlocked(plan, flatWorld({}, { name: 'air' }));
  assert.equal(noSupport.every(entry => entry.reason === 'no_support'), true);
  assert.equal(noSupport.length, 4);
  const occupied = portalSiteBlocked(plan, (position) => (position.y === 69 || position.x === 1 && position.y === 71 ? 'stone' : 'air'));
  assert.equal(occupied.some(entry => entry.reason === 'occupied' && entry.position.x === 1), true);
  assert.equal(portalSiteBlocked({ ok: false, error: 'missing_origin' }, supported)[0].reason, 'invalid_plan');
});

test('portalFrameCandidates derives candidate frames from obsidian blocks', () => {
  const blocks = [{ name: 'obsidian', position: at(10, 70, 20) }];
  const plans = portalFrameCandidates(blocks);
  // Il blocco può essere la prima colonna della riga in basso (shift 0), quella
  // accanto (1) o l'angolo sinistro (-1), su due assi.
  assert.equal(plans.length, 6);
  assert.equal(plans.every(plan => plan.ok), true);
  const exact = plans.filter(plan => plan.origin.x === 10 && plan.origin.y === 71 && plan.origin.z === 20);
  assert.equal(exact.length, 2);
  assert.deepEqual(exact.map(plan => plan.axis).sort(), ['x', 'z']);
  // Un blocco senza posizione non genera geometria inventata.
  assert.deepEqual(portalFrameCandidates([{ name: 'obsidian' }]), []);
});

// --- N2: sopravvivenza nel Nether ------------------------------------------

test('maxFallDepth accorcia la caduta dove l\'acqua evapora', () => {
  assert.equal(maxFallDepth('overworld'), OVERWORLD_MAX_FALL);
  assert.equal(maxFallDepth('nether'), NETHER_LIKE_MAX_FALL);
  assert.equal(maxFallDepth('the_end'), NETHER_LIKE_MAX_FALL);
  assert.equal(maxFallDepth(undefined), OVERWORLD_MAX_FALL, 'dimensione ignota: la regola prudente è quella normale');
  assert.ok(NETHER_LIKE_MAX_FALL < OVERWORLD_MAX_FALL);
});

test('landingHazard riconosce gli appoggi che fanno danno', () => {
  assert.equal(landingHazard('lava'), 'lava');
  assert.equal(landingHazard('flowing_lava'), 'lava');
  assert.equal(landingHazard('minecraft:magma'), 'magma');
  assert.equal(landingHazard('magma_block'), null, 'solo il nome reale, non qualunque cosa lo contenga');
  assert.equal(landingHazard('fire'), 'fire');
  assert.equal(landingHazard('soul_fire'), 'fire');
  assert.equal(landingHazard('cactus'), 'cactus');
  assert.equal(landingHazard('stone'), null);
  assert.equal(landingHazard(''), null);
  assert.equal(landingHazard(null), null);
  assert.equal(safeLanding('magma'), false);
  assert.equal(safeLanding('cobblestone'), true);
});

test('isFlammableBlock distingue il legno dalla pietra', () => {
  for (const name of ['oak_planks', 'spruce_log', 'stripped_oak_log', 'white_wool', 'bamboo',
    'crimson_stem', 'warped_hyphae', 'oak_fence', 'oak_fence_gate', 'oak_slab', 'oak_stairs',
    'oak_door', 'oak_trapdoor', 'oak_leaves', 'oak_sign', 'bookshelf', 'ladder', 'chest', 'target']) {
    assert.equal(isFlammableBlock(name), true, `${name} brucia`);
  }
  for (const name of ['cobblestone', 'stone', 'netherrack', 'obsidian', 'blackstone', 'basalt',
    'dirt', 'glass', 'iron_block', 'andesite', 'deepslate']) {
    assert.equal(isFlammableBlock(name), false, `${name} non brucia`);
  }
  assert.equal(isFlammableBlock(''), false);
});

test('pickHubBlock sceglie il materiale più abbondante che non brucia', () => {
  const owned = [
    { name: 'oak_planks', count: 40 },
    { name: 'netherrack', count: 12 },
    { name: 'cobblestone', count: 20 },
    { name: 'glass', count: 0 },
  ];
  assert.equal(pickHubBlock(owned), 'cobblestone');
  assert.equal(pickHubBlock([{ name: 'oak_log', count: 64 }]), null, 'solo legna: nessun materiale da hub');
  assert.equal(pickHubBlock([]), null);
  assert.equal(pickHubBlock(), null);
  assert.equal(pickHubBlock([null, { name: '', count: 3 }]), null);
});

test('shellCells descrive pareti e tetto intorno al bot', () => {
  const cells = shellCells({ x: 10.5, y: 64, z: -3.5 });
  assert.equal(cells.length, 12);
  assert.deepEqual(cells[0], { label: 'wall_feet', position: at(11, 64, -4), support: at(11, 63, -4) });
  assert.deepEqual(cells[4], { label: 'wall_head', position: at(11, 65, -4), support: at(11, 64, -4) });
  assert.deepEqual(cells[8], { label: 'roof', position: at(11, 66, -4), support: at(11, 65, -4) });
  assert.equal(cells.some(c => c.position.x === 10 && c.position.z === -4), false, 'mai sopra la testa del bot');
  assert.equal(shellCells({ x: 10.5, y: 64, z: -3.5 }, { roofCenter: true }).length, 13);
  assert.deepEqual(shellCells(null), []);
  assert.deepEqual(shellCells({}), []);
});

test('netherHubPlan è la stessa forma del rifugio, col materiale dichiarato', () => {
  const plan = netherHubPlan({ feet: { x: 4.5, y: 70, z: 4.5 }, block: 'cobblestone' });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.origin, at(4, 70, 4));
  assert.equal(plan.cells.length, 12);
  assert.deepEqual(plan.needs, { cobblestone: 12 });
  assert.deepEqual(netherHubPlan({}), { ok: false, error: 'missing_feet' });
});

// --- N3: schivare un proiettile ------------------------------------------

test('projectileVelocity measures the speed from samples, never invents it', () => {
  const now = 10_000;
  // Velocità dichiarata: vince sui campioni.
  assert.deepEqual(
    projectileVelocity({ position: at(0, 70, 0), velocity: at(0, 0, -4), previous: { position: at(0, 70, 4), at: now - 1000 }, now }),
    { velocity: { x: 0, y: 0, z: -4 }, source: 'velocity' }
  );
  // Due campioni a 1 s: 10 blocchi in 1 s verso il bot.
  assert.deepEqual(
    projectileVelocity({ position: at(0.5, 72, 11.5), previous: { position: at(0.5, 72, 21.5), at: now - 1000 }, now }),
    { velocity: { x: 0, y: 0, z: -10 }, source: 'samples' }
  );
  // Campione vecchio (oltre la finestra) o assente: nessuna velocità.
  assert.deepEqual(projectileVelocity({ position: at(0, 70, 0), previous: { position: at(0, 70, 5), at: now - 5000 }, now }), { velocity: null, source: null });
  assert.deepEqual(projectileVelocity({ position: at(0, 70, 0), now }), { velocity: null, source: null });
});

test('perpendicularDirs uses the flight direction, or the line towards the bot', () => {
  const from = at(0.5, 71, 0.5);
  // Verso sud (z+): i due lati sono est e ovest.
  assert.deepEqual(
    perpendicularDirs({ from, projectile: { position: at(0.5, 72, -10), velocity: at(0, 0, 1) } }),
    [{ x: -1, z: 0 }, { x: 1, z: 0 }]
  );
  // Velocità ignota: la direzione è la congiungente proiettile→bot (qui nord, z-).
  const unknown = perpendicularDirs({ from, projectile: { position: at(0.5, 72, 20.5) } });
  assert.deepEqual(unknown, [{ x: 1, z: 0 }, { x: -1, z: 0 }]);
  // Niente proiettile e niente posizione: nessuna direzione inventata.
  assert.deepEqual(perpendicularDirs({ from: null, projectile: null }), []);
  assert.deepEqual(perpendicularDirs({ from: at(0.5, 71, 0.5), projectile: { position: null, velocity: at(0, 0, 0) } }), []);
});

test('breaksLine grows the lateral distance: along the trajectory is not a dodge', () => {
  const from = at(0.5, 71, 0.5);
  const shot = { position: at(0.5, 72, 11.5), velocity: at(0, 0, -1) };
  // Il bot è sulla linea (laterale 0).
  assert.equal(lateralOffset({ point: from, from, projectile: shot }), 0);
  // Un punto sulla traiettoria resta sulla linea: spostarsi lungo non serve.
  assert.equal(breaksLine({ from, candidate: at(0, 71, -4), projectile: shot }), false);
  // Uscire di lato sì (l'origine è a z=11.5, quindi una cella a x=3 ha laterale 2.5).
  assert.equal(lateralOffset({ point: at(3, 71, 0), from, projectile: shot }), 2.5);
  assert.equal(breaksLine({ from, candidate: at(3, 71, 0), projectile: shot }), true);
  assert.equal(breaksLine({ from, candidate: at(-3, 71, 0), projectile: shot }), true);
});

test('dodgeCandidates picks both sides at the feet cell, never the bot column', () => {
  const from = at(0.5, 71, 0.5);
  const shot = { position: at(0.5, 72, 11.5), velocity: at(0, 0, -1) };
  const cells = dodgeCandidates({ from, projectile: shot });
  assert.equal(cells.length, 2);
  assert.deepEqual(cells.map(c => [c.x, c.y, c.z]), [[-3, 71, 0], [3, 71, 0]]);
  assert.deepEqual(cells.map(c => c.distance), [DODGE_DISTANCE, DODGE_DISTANCE]);
  // Ordinati per distanza laterale decrescente: il primo è la schivata migliore.
  assert.ok(cells[0].lateral >= cells[1].lateral, `${cells[0].lateral} >= ${cells[1].lateral}`);
  // Distanze multiple e colonna del bot mai candidata.
  const far = dodgeCandidates({ from, projectile: shot, distances: [2, 4] });
  assert.equal(far.length, 4);
  assert.ok(far.every(c => !(c.x === 0 && c.z === 0)));
  assert.deepEqual(dodgeCandidates({ from: null, projectile: shot }), []);
});

// --- N4: i piglin ----------------------------------------------------------

test('piglin classification and the gold vocabulary', () => {
  assert.equal(isPiglinType('piglin'), true);
  assert.equal(isPiglinType('minecraft:piglin_brute'), true);
  assert.equal(isPiglinType('zombified_piglin'), false, 'un piglin zombificato non baratta');
  assert.equal(isPiglinType(null), false);
  assert.deepEqual([...PIGLIN_TYPES], ['piglin', 'piglin_brute']);
  assert.equal(isBarterPayment('minecraft:gold_ingot'), true);
  assert.equal(isBarterPayment('gold_nugget'), false);
  assert.equal(isBarterPayment('golden_apple'), false);
  assert.equal(isBarterReward('minecraft:ender_pearl'), true);
  assert.equal(isBarterReward('obsidian'), true);
  assert.equal(isBarterReward('dirt'), false);
});

test('any gold armour piece makes the piglins neutral', () => {
  assert.equal(isGoldArmorPiece('golden_helmet'), true);
  assert.equal(isGoldArmorPiece('minecraft:golden_boots'), true);
  assert.equal(isGoldArmorPiece('iron_boots'), false);
  assert.deepEqual(goldArmorWorn(['iron_boots', 'golden_boots', null]), ['golden_boots']);
  assert.deepEqual(goldArmorWorn([]), []);
  assert.equal(piglinNeutral({ worn: ['golden_leggings'] }), true);
  assert.equal(piglinNeutral({ worn: ['diamond_chestplate'] }), false);
  assert.equal(piglinNeutral({}), false);
});

test('barterTarget picks the nearest adult piglin and reports why it cannot barter', () => {
  const from = at(0, 70, 0);
  const piglins = [
    { type: 'minecraft:piglin', position: at(6, 70, 0) },
    { type: 'minecraft:piglin', position: at(2, 70, 0), baby: true },
    { type: 'minecraft:piglin_brute', position: at(1, 70, 0) },
  ];
  const { target, nearest } = barterTarget({ piglins, from });
  // Il bruto è il più vicino in assoluto ma non baratta: il bersaglio è il
  // primo adulto utile (a 6 blocchi), e `nearest` dice perché non è quello.
  assert.equal(target.type, 'minecraft:piglin', 'il nome resta quello di arrivo');
  assert.equal(target.distance, 6);
  assert.equal(target.baby, false);
  assert.equal(target.brute, false);
  assert.equal(nearest.brute, true);
  assert.equal(nearest.distance, 1);
  // Fuori raggio o assenti: nessun bersaglio, nessun più vicino.
  assert.deepEqual(barterTarget({ piglins: [{ type: 'piglin', position: at(40, 70, 0) }], from }), { target: null, nearest: null });
  assert.deepEqual(barterTarget({ piglins: [{ type: 'cow', position: at(1, 70, 0) }], from }), { target: null, nearest: null });
  assert.deepEqual(barterTarget({ piglins: [], from: null }), { target: null, nearest: null });
  // Riga senza posizione: scartata senza far fallire il resto.
  const mixed = barterTarget({ piglins: [{ type: 'piglin' }, { type: 'piglin', position: at(3, 70, 0), runtimeId: '42' }], from });
  assert.equal(mixed.target.distance, 3);
  assert.equal(mixed.target.runtimeId, '42', 'i campi extra della riga viaggiano con essa');
  assert.equal(BARTER_INGOT, 'gold_ingot');
});
