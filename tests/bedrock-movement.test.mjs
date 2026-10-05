import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

const SOLID = { name: 'stone', boundingBox: 'block' };
const AIR = { name: 'air', boundingBox: 'empty' };
const GROUND_Y = 63; // il primo blocco solido del pavimento; i piedi stanno a 64.

function fakeWorld (solid = []) {
  const blocks = new Set(solid.map(([x, y, z]) => `${x},${y},${z}`));
  const floor = (x, z) => [[x, GROUND_Y, z]];
  const fillFloor = (x0, x1, z0, z1) => {
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) floor(x, z).forEach(([bx, by, bz]) => blocks.add(`${bx},${by},${bz}`));
  };
  return {
    blocks,
    fillFloor,
    blockAt: ({ x, y, z }) => blocks.has(`${x},${y},${z}`) ? SOLID : AIR,
  };
}

function physicsAdapter (world) {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.world = world;
  return adapter;
}

function place (adapter, x, y, z) {
  adapter._feet = { x, y, z };
  adapter._velocity = { x: 0, y: 0, z: 0 };
  adapter._onGround = true;
  adapter._syncPositionFromFeet();
}

function motion (overrides = {}) {
  return { active: true, forward: true, yaw: 0, jumpQueued: false, jumpHeldTicks: 0, jumpStart: false, ...overrides };
}

test('goto_waypoint preserves an explicit elevation instead of targeting a cave at the current height', async () => {
  const adapter = physicsAdapter(fakeWorld());
  adapter.position = { x: 0, y: 63.62, z: 0 };
  const targets = [];
  adapter._moveTo = async target => { targets.push(target); return { ok: true }; };
  adapter.plan = { waypoint: { x: 155, y: 80, z: 261 } };
  await adapter._runAction('goto_waypoint');
  assert.deepEqual(targets[0], { x: 155, y: 80, z: 261 });
  adapter.plan = { waypoint: { x: 155, z: 261 } };
  await adapter._runAction('goto_waypoint');
  assert.deepEqual(targets[1], { x: 155, y: 63.62, z: 261 });
});

test('an explicit waypoint height refuses a cave destination outside the requested elevation', async () => {
  const world = fakeWorld(); world.fillFloor(-2, 12, -2, 12);
  const adapter = physicsAdapter(world);
  place(adapter, 0.5, GROUND_Y + 1, 0.5);
  adapter.client = { write () {} };
  adapter._authTickInterval = true;
  adapter._startMotion = async () => assert.fail('must not enter a cave when the surface was requested');
  await assert.rejects(adapter._moveTo({ x: 6, y: GROUND_Y + 12, z: 6 }, 2, 1000, { verticalTolerance: 1 }), /target_not_found/);
});

test('arrival at a partial path frontier replans instead of reporting destination reached', async () => {
  const adapter = physicsAdapter(fakeWorld());
  place(adapter, 0.5, 64, 0.5);
  adapter.client = { write () {} };
  adapter._authTickInterval = true;
  const goal = { x: 6, y: 64, z: 0 };
  adapter._findGoalNodes = () => [goal];
  let paths = 0;
  adapter._findPath = start => [start, ++paths === 1 ? { x: 3, y: 64, z: 0 } : goal];
  adapter._startMotion = async path => {
    const end = path.at(-1);
    place(adapter, end.x + 0.5, end.y, end.z + 0.5);
    return 'goal';
  };
  const result = await adapter._moveTo({ x: 6.5, y: 64, z: 0.5 }, 0.4, 1000);
  assert.equal(result.ok, true);
  assert.equal(paths, 2);
  assert.equal(result.distance, 1.62);
  assert.deepEqual(adapter._startNode(), goal);
});

test('walking on flat ground advances at walk speed and stays grounded', () => {
  const world = fakeWorld(); world.fillFloor(-5, 5, -5, 5);
  const adapter = physicsAdapter(world);
  place(adapter, 0.5, GROUND_Y + 1, 0.5);
  adapter._motion = motion();
  const steps = 20;
  for (let i = 0; i < steps; i++) adapter._physicsStep();
  assert.ok(Math.abs(adapter._feet.z - (0.5 + steps * 0.2158)) < 1e-6, 'avanza di un passo di camminata per tick');
  assert.ok(Math.abs(adapter._feet.y - (GROUND_Y + 1)) < 1e-6, 'resta sul pavimento');
  assert.equal(adapter._onGround, true);
  assert.ok(Math.abs(adapter.position.y - (GROUND_Y + 1 + 1.62)) < 1e-6, 'la posizione pubblica è agli occhi');
});

test('a full wall blocks movement and forces a jump attempt', () => {
  const world = fakeWorld([[0, GROUND_Y + 1, 2], [0, GROUND_Y + 2, 2]]); world.fillFloor(-2, 2, -2, 5);
  const adapter = physicsAdapter(world);
  place(adapter, 0.5, GROUND_Y + 1, 0.5);
  adapter._motion = motion();
  for (let i = 0; i < 40; i++) adapter._physicsStep();
  assert.ok(adapter._feet.z < 2, 'non attraversa il muro');
  assert.ok(adapter._collidedHorizontally, 'registra la collisione orizzontale');
  assert.equal(adapter._collides(adapter._feet.x, adapter._feet.y, adapter._feet.z), false, 'non finisce mai dentro un blocco');
});

test('a one-block step is climbed by the automatic jump', () => {
  const world = fakeWorld([[0, GROUND_Y + 1, 1]]); world.fillFloor(-2, 2, -2, 5);
  const adapter = physicsAdapter(world);
  place(adapter, 0.5, GROUND_Y + 1, 0.5);
  adapter._motion = motion();
  let maxY = adapter._feet.y;
  for (let i = 0; i < 30; i++) {
    adapter._physicsStep();
    maxY = Math.max(maxY, adapter._feet.y);
  }
  assert.ok(maxY >= GROUND_Y + 2, 'sale sul gradino');
  assert.ok(adapter._feet.z > 1, 'supera il gradino');
});

test('gravity lands the bot on the floor', () => {
  const world = fakeWorld(); world.fillFloor(-2, 2, -2, 2);
  const adapter = physicsAdapter(world);
  place(adapter, 0.5, GROUND_Y + 8, 0.5);
  adapter._onGround = false;
  adapter._motion = motion({ forward: false });
  for (let i = 0; i < 60; i++) adapter._physicsStep();
  assert.equal(adapter._onGround, true);
  assert.ok(Math.abs(adapter._feet.y - (GROUND_Y + 1)) < 1e-6, 'atterra sul pavimento');
});

test('pathfinding walks around an L-shaped wall', () => {
  const world = fakeWorld(); world.fillFloor(0, 8, 0, 8);
  // Muro verticale in x=3 con passaggio in z>=5.
  for (let z = 0; z <= 4; z++) for (let y = GROUND_Y + 1; y <= GROUND_Y + 2; y++) world.blocks.add(`3,${y},${z}`);
  const adapter = physicsAdapter(world);
  place(adapter, 0.5, GROUND_Y + 1, 0.5);
  const path = adapter._findPath(adapter._startNode(), { x: 6, y: GROUND_Y + 1, z: 0 });
  assert.ok(path && path.length > 1, 'trova un percorso');
  assert.deepEqual(path.at(-1), { x: 6, y: GROUND_Y + 1, z: 0 });
  for (const node of path) assert.equal(adapter._collides(node.x + 0.5, node.y, node.z + 0.5), false, 'nessun nodo dentro un blocco');
});

test('pathfinding returns a partial frontier while the goal is walled off', () => {
  const world = fakeWorld(); world.fillFloor(0, 8, 0, 8);
  // Camera chiusa con pareti di 2 blocchi intorno al bersaglio.
  for (let x = 5; x <= 7; x++) for (let y = GROUND_Y + 1; y <= GROUND_Y + 2; y++) {
    for (const z of [5, 7]) world.blocks.add(`${x},${y},${z}`);
    if (x === 5 || x === 7) world.blocks.add(`${x},${y},6`);
  }
  const adapter = physicsAdapter(world);
  place(adapter, 0.5, GROUND_Y + 1, 0.5);
  const path = adapter._findPath(adapter._startNode(), { x: 6, y: GROUND_Y + 1, z: 6 });
  assert.ok(path && path.length > 1, 'percorre fino alla frontiera');
  assert.notDeepEqual(path.at(-1), { x: 6, y: GROUND_Y + 1, z: 6 }, 'non raggiunge il bersaglio chiuso');
});

test('goal resolution snaps to the standable node nearest to the target', () => {
  const world = fakeWorld(); world.fillFloor(0, 8, 0, 8);
  const adapter = physicsAdapter(world);
  place(adapter, 0.5, GROUND_Y + 1, 0.5);
  assert.deepEqual(adapter._findGoalNode({ x: 4, y: GROUND_Y + 1, z: 3 }), { x: 4, y: GROUND_Y + 1, z: 3 });
  assert.equal(adapter._standable(4, GROUND_Y + 1, 3), true);
  assert.equal(adapter._standable(4, GROUND_Y + 1, 3), true);
});

test('_moveTo sceglie la cella dentro la tolleranza, non la prima per punteggio (fondo del pozzo)', async () => {
  // Live 03/10: il waypoint stava sopra un buco; le celle raggiungibili più
  // vicine per punteggio erano sul bordo a 2,18 blocchi (appena fuori dalla
  // distanza di arresto) mentre la cella esatta era quattro blocchi più in basso
  // a 0,71 blocchi dal bersaglio. Il primo candidato completo non permetteva
  // quindi di soddisfare l'arrivo e l'azione finiva `path_failed` dopo tre
  // tentativi inutili.
  const world = fakeWorld(); world.fillFloor(-2, 10, -4, 4);
  for (let x = 5; x <= 7; x++) for (let z = -1; z <= 1; z++) {
    world.blocks.delete(`${x},${GROUND_Y},${z}`); // il pozzo: via il pavimento
    world.blocks.add(`${x},${GROUND_Y - 4},${z}`); // fondo calpestabile a GROUND_Y - 3
  }
  const adapter = physicsAdapter(world);
  place(adapter, 0.5, GROUND_Y + 1, 0.5);
  adapter.client = { write () {} };
  adapter._authTickInterval = setInterval(() => adapter._authTick(), 5);
  try {
    const target = { x: 6, y: GROUND_Y + 1 + 1.62, z: 0 };
    const result = await adapter._moveTo(target, 1.0, 5000);
    assert.equal(result.ok, true, 'la cella esatta è dentro la tolleranza e va raggiunta');
    assert.deepEqual(result.goal, { x: 6, y: GROUND_Y - 3, z: 0 }, 'il bersaglio scelto è il fondo del pozzo');
    // L'arrivo è accettato con la tolleranza verticale di `_updateMotionState`,
    // quindi il bot può essere ancora a mezz'aria: la discesa si completa nei tick
    // successivi (la fisica continua a girare).
    for (let i = 0; i < 40; i++) adapter._physicsStep();
    assert.equal(adapter._feet.y, GROUND_Y - 3, 'scende nel pozzo invece di fermarsi sul bordo');
  } finally {
    clearInterval(adapter._authTickInterval);
    adapter._authTickInterval = null;
    adapter._motion = null;
  }
});

test('_moveTo accetta un bersaglio con la y sbagliata: conta la cella raggiungibile', async () => {
  // Live 03/10: il bot esce da una grotta (y 65) verso il villaggio (y 72) e
  // `goto_waypoint` — che congela la y dalla posizione di partenza — finiva
  // `path_failed` dopo 28,5 s con il bot già arrivato, perché il controllo
  // verticale di `_updateMotionState` (±3) non poteva più essere soddisfatto.
  const world = fakeWorld(); world.fillFloor(-2, 12, -2, 12);
  const adapter = physicsAdapter(world);
  place(adapter, 0.5, GROUND_Y + 1, 0.5);
  adapter.client = { write () {} };
  adapter._authTickInterval = setInterval(() => adapter._authTick(), 5);
  try {
    const bogus = { x: 6, y: GROUND_Y + 8, z: 0.5 };
    const result = await adapter._moveTo(bogus, 1.0, 5000);
    assert.equal(result.ok, true, 'la y irraggiungibile non deve far fallire l\'azione');
    const reached = Math.hypot(adapter._feet.x - 6, adapter._feet.z - 0.5);
    assert.ok(reached <= 1.05, 'si ferma entro la distanza di arresto dal bersaglio');
  } finally {
    clearInterval(adapter._authTickInterval);
    adapter._authTickInterval = null;
    adapter._motion = null;
  }
});

test('_moveTo drives the tick loop to a distant target on open ground', async () => {
  const world = fakeWorld(); world.fillFloor(-2, 12, -2, 12);
  const adapter = physicsAdapter(world);
  place(adapter, 0.5, GROUND_Y + 1, 0.5);
  adapter.client = { write () {} };
  adapter._authTickInterval = setInterval(() => adapter._authTick(), 5);
  try {
    const result = await adapter._moveTo({ x: 6, y: GROUND_Y + 1 + 1.62, z: 0.5 }, 1.0, 5000);
    assert.equal(result.ok, true);
    const reached = Math.hypot(adapter._feet.x - 6, adapter._feet.z - 0.5);
    assert.ok(reached <= 1.05, 'si ferma entro la distanza di arresto dal bersaglio');
    assert.ok(adapter._feet.x > 4.5, 'ha percorso il tragitto');
  } finally {
    clearInterval(adapter._authTickInterval);
    adapter._authTickInterval = null;
    adapter._motion = null;
  }
});

test('a lower-door update opens both halves even when the upper runtime id is unchanged', () => {
  const blocks = new Map();
  const door = properties => ({ name: 'wooden_door', boundingBox: 'block', getProperties: () => properties });
  blocks.set('1,64,0', door({ upper_block_bit: false, open_bit: true }));
  blocks.set('1,65,0', door({ upper_block_bit: true, open_bit: false }));
  const adapter = physicsAdapter({ blockAt: p => blocks.get(`${p.x},${p.y},${p.z}`) ?? AIR });
  adapter._noteRedstoneUpdate = () => {};
  adapter._doorWatchers.set('1,64,0', 10);
  adapter._doorWatchers.set('1,65,0', 20);
  adapter._onBlockUpdate({ x: 1, y: 64, z: 0 }, 11);
  assert.equal(adapter._solidAt(1, 64, 0), false);
  assert.equal(adapter._solidAt(1, 65, 0), false);
  assert.equal(adapter._doorWatchers.size, 0);
  adapter._feet = { x: 0.5, y: 64, z: 0.5 };
  adapter._motion = motion({ yaw: -90 });
  assert.equal(adapter._doorAhead(), null, 'do not click the unchanged upper half and close the door');
  blocks.set('1,64,0', door({ upper_block_bit: false, open_bit: false }));
  adapter._onBlockUpdate({ x: 1, y: 65, z: 0 }, 20);
  assert.equal(adapter._solidAt(1, 64, 0), true);
  assert.equal(adapter._solidAt(1, 65, 0), true);
  assert.deepEqual(adapter._doorAhead(), { x: 1, y: 64, z: 0 }, 'an external closure must be opened again');
});

test('a bed uses its registry collision height for spawn, support, falling and walking off', () => {
  const bed = { name: 'bed', boundingBox: 'block', shapes: [[0, 0, 0, 1, 0.5625, 1]] };
  const adapter = physicsAdapter({ blockAt: ({x,y,z}) => y === 63 ? SOLID : x === 0 && y === 64 && z === 0 ? bed : AIR });
  assert.equal(adapter._feetFromServerY({ x: 0.5, y: 64.3 + 1.62, z: 0.5 }), 64.5625);
  assert.equal(adapter._feetFromServerY({ x: 0.5, y: 64.75 + 1.62, z: 0.5 }), 64.75);
  place(adapter, 0.5, 64.75, 0.5);
  adapter._motion = null;
  for (let i = 0; i < 10; i++) adapter._physicsStep();
  assert.equal(adapter._feet.y, 64.5625);
  assert.equal(adapter._supportedAt(0.5, 64.5625, 0.5), true);
  assert.equal(adapter._collides(0.5, 64.5625, 0.5), false);
  adapter._lastSimTick = null;
  adapter._driveMotion(1n);
  assert.equal(adapter._feet.y, 64.5625, 'unstick must not lift a supported player to a full cube');
  adapter._motion = motion();
  for (let i = 0; i < 15; i++) adapter._physicsStep();
  assert.ok(adapter._feet.z > 2);
  assert.equal(adapter._feet.y, 64, 'walk off onto the lower room floor');
});

test('a bed beside a low doorway plans a step onto the room floor before crossing the lintel', () => {
  const bed = { name: 'bed', boundingBox: 'block', shapes: [[0,0,0,1,0.5625,1]] };
  const door = { name: 'wooden_door', boundingBox: 'block' };
  const adapter = physicsAdapter({ blockAt: ({x,y,z}) => {
    if (y === 63 || (x === -1 && y === 66 && z === 0)) return SOLID;
    if (x === 0 && y === 64 && z === 0) return bed;
    if (x === -1 && (y === 64 || y === 65) && z === 0) return door;
    return AIR;
  }});
  place(adapter, 0.5, 64.5625, 0.5);
  const start = adapter._startNode();
  assert.deepEqual(start, { x: 0, y: 65, z: 0 });
  const path = adapter._findPath(start, { x: -2, y: 64, z: 0 });
  assert.ok(path.length > 3);
  assert.ok(path[1].z !== 0 || path[1].x > 0, 'leave the bed through the room, away from the doorway header');
  assert.ok(![...adapter._neighbors(start)].some(p => p.x === -1 && p.y === 64 && p.z === 0));
});

test('movement centres the room-floor approach before advancing into a doorway', () => {
  const door = { name: 'wooden_door', boundingBox: 'block' };
  const adapter = physicsAdapter({ blockAt: ({x,y,z}) => y === 63 ? SOLID : x === 2 && z === 0 && (y === 64 || y === 65) ? door : AIR });
  adapter._openDoors.add('2,64,0'); adapter._openDoors.add('2,65,0');
  place(adapter, 1.5, 64, 0.7);
  adapter._motion = motion({ index: 0, path: [{x:1,y:64,z:0},{x:2,y:64,z:0},{x:3,y:64,z:0}], target:{x:3.5,y:64,z:0.5}, stopDistance:0.35, deadline:Date.now()+10000, bestWaypointDist:Infinity,lastProgressAt:Date.now(),stuckTries:0 });
  adapter._updateMotionState();
  assert.equal(adapter._motion.index, 0, '0.2 off centre is too far for a doorway approach');
  adapter._physicsStep();
  assert.ok(Math.abs(adapter._feet.z - 0.5) < 1e-9, 'limit the last step to the waypoint instead of overshooting');
  adapter._updateMotionState();
  assert.equal(adapter._motion.index, 1);
});

test('precise work movement waits for the requested floor height before completing', async () => {
  const world = fakeWorld([[0, 64, 1]]); world.fillFloor(-2, 2, -2, 3);
  const adapter = physicsAdapter(world);
  place(adapter, 0.5, 64, 0.5);
  adapter._maybeRememberDiscoveries = () => {};
  const completion = adapter._startMotion([{ x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 1 }],
    { x: 0, y: 65, z: 1 }, { x: 0.5, y: 65, z: 1.5 }, 0.4, Date.now() + 5000, { arrivalVerticalTolerance: 0.15 });
  for (let i = 0; i < 200 && adapter._motion.active; i++) {
    adapter._updateMotionState();
    if (adapter._motion.active) adapter._physicsStep();
  }
  assert.equal(adapter._motion.active, false, 'physics reaches the raised work position');
  assert.equal(await completion, 'goal');
  assert.ok(Math.abs(adapter._feet.y - 65) < 0.15);
  assert.ok(Math.hypot(adapter._feet.x - 0.5, adapter._feet.z - 1.5) <= 0.4);
});

test('being horizontally near a lower work position does not finish while above its floor', () => {
  const adapter = physicsAdapter(fakeWorld());
  place(adapter, 0.5, 65, 0.5);
  let finished = false;
  adapter._finishMotion = () => { finished = true; };
  adapter._motion = motion({ target: { x: 0.5, y: 64, z: 0.5 }, stopDistance: 0.4,
    arrivalVerticalTolerance: 0.15, deadline: Date.now() + 5000,
    path: [{ x: 0, y: 64, z: 0 }], index: 0, bestWaypointDist: Infinity, lastProgressAt: Date.now() });
  adapter._updateMotionState();
  assert.equal(finished, false);
  assert.equal(adapter._motion.index, 0, 'final waypoint remains pending until the descent finishes');
});
