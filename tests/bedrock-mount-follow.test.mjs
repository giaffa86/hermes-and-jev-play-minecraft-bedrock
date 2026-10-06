import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BedrockAdapter } from '../bedrock-adapter.mjs';
import { mountCapacity, seatInfo } from '../bedrock-survival.mjs';
import { MOUNT_FOLLOW_STATES, MOUNT_JOIN_ATTEMPTS, mountFollowTransition, mountFollowWaiting } from '../bedrock-mount-follow.mjs';
import { optionPriority, rankOptions } from '../controller-decisions.mjs';

// La missione «segui l'umano che si imbarca» ha due parti con due proprietari
// diversi, e i test tengono separate le prove:
//  - la decisione (macchina a stati pura + priorità): unit test, nessun server;
//  - il rilevamento (link del server, flag `riding`, posto libero): adapter;
//  - l'azione di mount: dietro flag, quindi qui si prova il *rifiuto* e il
//    routing (mai un `mount_*` generico), non l'aggancio al sedile — che il
//    server non conferma ancora (`set_entity_link` assente, vedi companions.md).

function spawnedAdapter () {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.client = new EventEmitter();
  adapter.client.entityId = 7n;
  adapter.client.write = () => {};
  adapter.position = { x: 0, y: 64.62, z: 0 };
  adapter._feet = { x: 0, y: 63, z: 0 };
  adapter.nearbyBlocks = {};
  adapter.drops = [];
  return adapter;
}

// L'umano in barca, con il link che lo conferma. Il mezzo sta a 3 blocchi (raggio
// d'interazione), così il percorso di join non passa dal pathfinding.
function humanOnBoat (adapter, { riders = 1 } = {}) {
  adapter.plan = { objective: 'Follow Alex', targets: {}, follow: 'Alex' };
  adapter._trackEntity({ runtime_id: 100n, unique_id: 1000n, entity_type: 'minecraft:player', username: 'Alex', position: { x: 2, y: 63, z: 0 } }, 'player');
  adapter._trackEntity({ runtime_id: 200n, unique_id: 2000n, entity_type: 'minecraft:oak_boat', position: { x: 3, y: 63, z: 0 } }, 'mob');
  adapter._onEntityLink({ link: { rider_entity_id: 100n, ridden_entity_id: 200n, type: 1 } });
  // Un secondo rider *senza* entità tracciata: il link resta l'unica fonte.
  if (riders > 1) adapter._onEntityLink({ link: { rider_entity_id: 101n, ridden_entity_id: 200n, type: 2 } });
  return adapter;
}

// ---- posti a sedere -----------------------------------------------------------------

test('mountCapacity and seatInfo: only two-seaters can take the bot with the human', () => {
  assert.equal(mountCapacity('boat'), 2);
  assert.equal(mountCapacity('minecraft:oak_chest_boat'), 2);
  assert.equal(mountCapacity({ type: 'bamboo_raft' }), 2);
  assert.equal(mountCapacity('camel'), 2);
  assert.equal(mountCapacity('horse'), 1);
  assert.equal(mountCapacity('chest_minecart'), 1);
  assert.equal(mountCapacity('cow'), 0); // non è un mezzo: nessun posto
  assert.deepEqual(seatInfo('oak_boat'), { type: 'oak_boat', seats: 2, riders: 0, free: 2, joinable: true, reason: null });
  // L'umano occupa già un posto della barca: ne resta esattamente uno.
  assert.equal(seatInfo('oak_boat', { riders: 1 }).free, 1);
  assert.deepEqual(seatInfo('oak_boat', { riders: 1 }), { type: 'oak_boat', seats: 2, riders: 1, free: 1, joinable: true, reason: null });
  // I due rifiuti sono diversi e chi decide li distingue: pieno vs non joinable.
  assert.equal(seatInfo('oak_boat', { riders: 2 }).reason, 'full');
  assert.equal(seatInfo('oak_boat', { riders: 2 }).joinable, false);
  assert.equal(seatInfo('horse').reason, 'unsupported');
  assert.equal(seatInfo('horse').joinable, false);
  assert.equal(seatInfo('cow').reason, 'unsupported');
});

// ---- macchina a stati ---------------------------------------------------------------

const joinable = { type: 'oak_boat', seats: 2, riders: 1, free: 1, joinable: true, reason: null };

test('mountFollowTransition walks FOLLOWING -> JOINING -> RIDING -> FOLLOWING', () => {
  const base = { following: true, mount: joinable, reachable: true, joinEnabled: true };
  assert.deepEqual(
    mountFollowTransition({ ...base, state: MOUNT_FOLLOW_STATES.FOLLOWING }),
    { state: MOUNT_FOLLOW_STATES.JOINING_HUMAN_MOUNT, action: 'join', reason: 'human_mount_joinable' });
  // Già in salita, la ragione non si riscrive: il tentativo è in corso.
  assert.equal(mountFollowTransition({ ...base, state: MOUNT_FOLLOW_STATES.JOINING_HUMAN_MOUNT }).reason, 'joining');
  assert.deepEqual(
    mountFollowTransition({ ...base, state: MOUNT_FOLLOW_STATES.JOINING_HUMAN_MOUNT, botRiding: true, ridingHumanMount: true }),
    { state: MOUNT_FOLLOW_STATES.RIDING_WITH_HUMAN, action: 'ride', reason: 'riding_with_human' });
  // Smontato: la missione si riapre (e al prossimo detect si richiude).
  assert.deepEqual(
    mountFollowTransition({ ...base, state: MOUNT_FOLLOW_STATES.RIDING_WITH_HUMAN }),
    { state: MOUNT_FOLLOW_STATES.FOLLOWING, action: 'follow', reason: 'dismounted' });
  // A piedi non c'è niente da salire.
  assert.deepEqual(
    mountFollowTransition({ following: true, state: MOUNT_FOLLOW_STATES.FOLLOWING, mount: null }),
    { state: MOUNT_FOLLOW_STATES.FOLLOWING, action: 'follow', reason: 'human_on_foot' });
  // Senza ordine di follow la missione non esiste, non è "in attesa".
  assert.deepEqual(mountFollowTransition({ following: false }), { state: MOUNT_FOLLOW_STATES.IDLE, action: 'none', reason: 'no_follow_order' });
});

test('mountFollowTransition distinguishes riding the human mount from riding another one', () => {
  const other = mountFollowTransition({ following: true, botRiding: true, ridingHumanMount: false, mount: joinable, reachable: true, joinEnabled: true });
  assert.deepEqual(other, { state: MOUNT_FOLLOW_STATES.RIDING_WITH_HUMAN, action: 'ride', reason: 'riding_other_mount' });
  const same = mountFollowTransition({ following: true, botRiding: true, ridingHumanMount: true, mount: joinable });
  assert.equal(same.reason, 'riding_with_human');
});

test('mountFollowTransition stops at the shore with a typed reason', () => {
  const base = { state: MOUNT_FOLLOW_STATES.FOLLOWING, following: true, reachable: true, joinEnabled: true };
  const full = mountFollowTransition({ ...base, mount: { ...joinable, riders: 2, free: 0, joinable: false, reason: 'full' } });
  assert.deepEqual(full, { state: MOUNT_FOLLOW_STATES.WAITING_AT_SHORE, action: 'wait', reason: 'human_mount_full' });
  const unsupported = mountFollowTransition({ ...base, mount: { type: 'horse', seats: 1, riders: 1, free: 0, joinable: false, reason: 'unsupported' } });
  assert.deepEqual(unsupported, { state: MOUNT_FOLLOW_STATES.WAITING_AT_SHORE, action: 'wait', reason: 'human_mount_unsupported' });
  // Pieno e non joinable restano due errori diversi: "aspetta che si liberi" non
  // è "su questo non ci salirò mai".
  assert.notEqual(full.reason, unsupported.reason);
  assert.equal(mountFollowTransition({ ...base, mount: joinable, joinEnabled: false }).reason, 'join_disabled');
  assert.equal(mountFollowTransition({ ...base, mount: joinable, reachable: false }).reason, 'human_mount_unreachable');
  // Il join fallito porta a riva con la *sua* ragione, non con una generica.
  assert.deepEqual(
    mountFollowTransition({ ...base, mount: joinable, joinAttempted: true, joinError: 'mount_not_confirmed' }),
    { state: MOUNT_FOLLOW_STATES.WAITING_AT_SHORE, action: 'wait', reason: 'mount_not_confirmed' });
  assert.equal(mountFollowTransition({ ...base, mount: joinable, attempts: MOUNT_JOIN_ATTEMPTS }).reason, 'human_mount_attempts_exhausted');
  // Un tentativo fallito non blocca per sempre: senza errore pendente e con il
  // posto libero la missione riprova (è il caso "l'umano ha liberato il posto").
  assert.equal(mountFollowTransition({ ...base, state: MOUNT_FOLLOW_STATES.WAITING_AT_SHORE, mount: joinable, attempts: 1 }).action, 'join');
});

test('mountFollowWaiting marks only the shore state', () => {
  assert.equal(mountFollowWaiting(MOUNT_FOLLOW_STATES.WAITING_AT_SHORE), true);
  assert.equal(mountFollowWaiting(MOUNT_FOLLOW_STATES.JOINING_HUMAN_MOUNT), false);
  assert.equal(mountFollowWaiting(MOUNT_FOLLOW_STATES.FOLLOWING), false);
});

// ---- priorità: l'ordine che l'utente ha chiesto di testare ---------------------------

test('join_human_mount outranks the follow, the generic mounts and the locomotion fallbacks', () => {
  const join = optionPriority({ key: 'join_human_mount' });
  assert.equal(join, 1.5);
  // Sotto l'inseguimento (2) nel valore = più rilevante: salire è l'unico modo
  // di restare con l'umano che sta salpando.
  for (const key of ['follow_player', 'escort_to', 'goto_waypoint', 'seek_player', 'mount_boat', 'mount_donkey', 'mount_minecart', 'mine_stone', 'place_water', 'craft_boat', 'wait']) {
    assert.ok(join < optionPriority({ key }), `join_human_mount deve precedere ${key}`);
  }
  // I soli che restano davanti sono sopravvivenza e raccolta del drop fresco.
  assert.ok(join > optionPriority({ key: 'collect_drop' }));
  assert.ok(join > optionPriority({ key: 'eat' }));
  // In una lista reale (barca dell'umano + barca qualunque + inseguimento) il
  // primo non-survival è il join, non `mount_boat`: è la regressione di M5.
  const ranked = rankOptions([
    { key: 'mount_boat', description: 'Board the nearest boat (2.0 blocks away)' },
    { key: 'follow_player', description: 'Follow Alex (4.0 blocks away)' },
    { key: 'join_human_mount', description: "Board Alex's oak_boat (1 free seat(s) of 2, 3.0 blocks away)" },
    { key: 'wait', description: 'Wait for something to happen' },
  ]);
  assert.deepEqual(ranked.map(o => o.key), ['join_human_mount', 'follow_player', 'mount_boat', 'wait']);
});

// ---- rilevamento nell'adapter -------------------------------------------------------

test('a non-self link is kept: the human mount comes from the server link', () => {
  const adapter = humanOnBoat(spawnedAdapter());
  const link = adapter.entityLinks.get('100');
  assert.ok(link, 'il link dell\'umano non è più solo diagnostica');
  assert.equal(link.ridden, '200');
  assert.equal(link.type, 1);
  assert.equal(adapter._ridersOf('200').length, 1);
  const mount = adapter._humanMountView();
  assert.equal(mount.type, 'oak_boat');
  assert.equal(mount.source, 'link');
  assert.equal(mount.seats, 2);
  assert.equal(mount.riders, 1);
  assert.equal(mount.free, 1);
  assert.equal(mount.joinable, true);
  assert.equal(mount.human, 'Alex');
  assert.ok(mount.distance > 0 && mount.distance <= 4.5, `a portata di interact: nessun pathfinding (${mount.distance})`);
});

test('a full mount is detected as full, not as unreachable', () => {
  const adapter = humanOnBoat(spawnedAdapter(), { riders: 2 });
  const mount = adapter._humanMountView();
  assert.equal(mount.riders, 2);
  assert.equal(mount.free, 0);
  assert.equal(mount.reason, 'full');
  adapter.joinHumanMountEnabled = true;
  const view = adapter._mountFollowView();
  assert.equal(view.state, 'WAITING_AT_SHORE');
  assert.equal(view.reason, 'human_mount_full');
  assert.equal(view.action, 'wait');
});

test('dismounting clears the link and the human is back on foot', () => {
  const adapter = humanOnBoat(spawnedAdapter());
  adapter._onEntityLink({ link: { rider_entity_id: 100n, ridden_entity_id: 200n, type: 0 } });
  assert.equal(adapter.entityLinks.has('100'), false);
  assert.equal(adapter._humanMountView(), null);
  assert.equal(adapter._mountFollowView().reason, 'human_on_foot');
});

test('the riding metadata flag is read for other entities (fallback before the link)', () => {
  const adapter = spawnedAdapter();
  adapter.plan = { objective: 'Follow Alex', targets: {}, follow: 'Alex' };
  adapter._trackEntity({ runtime_id: 100n, unique_id: 1000n, entity_type: 'minecraft:player', username: 'Alex', position: { x: 2, y: 63, z: 0 } }, 'player');
  // Nessun link: solo il flag `riding` (bit 2) del giocatore.
  adapter._applyEntityMetadata({ runtime_entity_id: 100n, metadata: [{ key: 0, value: 1n << 2n }] });
  assert.equal(adapter.entities.get('100').riding, true);
  // Il cammello a due posti accanto all'umano è la sorgente `proximity`: il flag
  // dice *che* è a bordo, non *su cosa*, e la vista lo dichiara.
  adapter._trackEntity({ runtime_id: 300n, unique_id: 3000n, entity_type: 'minecraft:camel', position: { x: 3, y: 63, z: 1 } }, 'mob');
  const mount = adapter._humanMountView();
  assert.equal(mount.type, 'camel');
  assert.equal(mount.source, 'proximity');
  assert.equal(mount.seats, 2);
});

// ---- opzione e dispatch -------------------------------------------------------------

test('the boarding option is offered only when the human mount has a free seat', () => {
  const adapter = humanOnBoat(spawnedAdapter());
  adapter.entityApproachable = () => true; // la raggiungibilità ha i suoi test
  adapter.joinHumanMountEnabled = true;
  const option = adapter.options().find(o => o.key === 'join_human_mount');
  assert.ok(option, `opzione attesa fra: ${adapter.options().map(o => o.key).join(', ')}`);
  assert.match(option.description, /Alex's oak_boat/);
  assert.match(option.description, /1 free seat/);
  // `observe()` la espone anche a chi non chiama `options()` (il controller).
  const view = adapter.observe().mountFollow;
  assert.equal(view.state, 'JOINING_HUMAN_MOUNT');
  assert.equal(view.action, 'join');
  assert.equal(view.joinEnabled, true);
  // Mezzo irraggiungibile: niente opzione, e la ragione è tipizzata.
  adapter.entityApproachable = () => false;
  assert.equal(adapter.options().some(o => o.key === 'join_human_mount'), false);
  assert.equal(adapter._mountFollowView().reason, 'human_mount_unreachable');
});

test('without the flag the join is a typed refusal and no packet leaves the bot', async () => {
  const adapter = humanOnBoat(spawnedAdapter());
  adapter.entityApproachable = () => true;
  adapter.joinHumanMountEnabled = false;
  const written = [];
  adapter.client.write = packet => written.push(packet);
  const generic = [];
  adapter._mountVehicle = async type => { generic.push(type); return { ok: true }; };
  // Il rilevamento c'è già (vista completa), ma il join no.
  const view = adapter._mountFollowView();
  assert.equal(view.joinEnabled, false);
  assert.equal(view.state, 'WAITING_AT_SHORE');
  assert.equal(view.reason, 'join_disabled');
  assert.equal(view.action, 'wait');
  assert.equal(view.mount.type, 'oak_boat');
  // Nessuna opzione: il controller non può nemmeno chiederla.
  assert.equal(adapter.options().some(o => o.key === 'join_human_mount'), false);
  const result = await adapter._runAction('join_human_mount');
  assert.deepEqual(result, { ok: false, error: 'join_human_mount_disabled' });
  assert.deepEqual(generic, [], 'l\'assenza del flag non deve far ripiegare su un mount generico');
  assert.deepEqual(written, [], 'senza flag non parte un solo pacchetto');
});

test('the dispatch routes join_human_mount to the human mount, never to a generic mount', async () => {
  const adapter = humanOnBoat(spawnedAdapter());
  adapter.entityApproachable = () => true;
  adapter.joinHumanMountEnabled = true;
  const joined = [];
  const generic = [];
  adapter._joinHumanMount = async () => { joined.push('join'); return { ok: true, mounted: 'oak_boat' }; };
  adapter._mountVehicle = async type => { generic.push(type); return { ok: true }; };
  const result = await adapter._runAction('join_human_mount');
  assert.equal(joined.length, 1);
  assert.deepEqual(generic, []);
  assert.equal(result.ok, true);
});

test('the real join attempt on a non-confirming server ends with a typed refusal', async () => {
  const adapter = humanOnBoat(spawnedAdapter());
  adapter.entityApproachable = () => true;
  adapter.joinHumanMountEnabled = true;
  adapter.inventorySlots = [{}, {}, {}, {}, {}, {}, {}, {}, {}];
  adapter._selectHotbarSlot = () => true;
  adapter._moveTo = async () => ({ ok: true });
  const interacted = [];
  adapter._interactEntity = entity => { interacted.push(entity.type); return true; };
  // Finestra corta: il server non manda il link, quindi il ciclo termina con il
  // rifiuto tipizzato invece di aspettare i 20 s di produzione.
  const result = await adapter._joinHumanMount(null, 150);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'mount_not_confirmed');
  assert.deepEqual(interacted, ['oak_boat'], 'interact sul mezzo dell\'umano, con mano libera');
  assert.equal(adapter._mountFollow.attempts, 1);
  // Il fallimento non si dichiara "in salita": la missione va a riva con la
  // ragione del server, e non riprova in loop.
  const view = adapter._mountFollowView();
  assert.equal(view.state, 'WAITING_AT_SHORE');
  assert.equal(view.reason, 'mount_not_confirmed');
  assert.equal(adapter.options().some(o => o.key === 'join_human_mount'), false);
  // Un altro ordine (l'umano scende e risale su un mezzo diverso) riazzera i
  // tentativi: la missione appartiene al mezzo, non alla persona.
  adapter._trackEntity({ runtime_id: 400n, unique_id: 4000n, entity_type: 'minecraft:oak_boat', position: { x: 3, y: 63, z: 1 } }, 'mob');
  adapter._onEntityLink({ link: { rider_entity_id: 100n, ridden_entity_id: 400n, type: 0 } });
  adapter._onEntityLink({ link: { rider_entity_id: 100n, ridden_entity_id: 400n, type: 1 } });
  const fresh = adapter._mountFollowView();
  assert.equal(adapter._mountFollow.attempts, 0);
  assert.equal(fresh.mount.runtimeId, '400');
  assert.equal(fresh.state, 'JOINING_HUMAN_MOUNT');
});

test('the mount join is refused before anything else when there is no such mount', async () => {
  const adapter = spawnedAdapter();
  adapter.joinHumanMountEnabled = true;
  adapter.plan = { objective: 'Follow Alex', targets: {}, follow: 'Alex' };
  adapter._trackEntity({ runtime_id: 100n, unique_id: 1000n, entity_type: 'minecraft:player', username: 'Alex', position: { x: 2, y: 63, z: 0 } }, 'player');
  const result = await adapter._joinHumanMount();
  assert.deepEqual(result, { ok: false, error: 'human_mount_unknown' });
  // Ordinaria amministrazione: il bot che non è montato e non deve nulla.
  assert.equal(adapter._mountFollowView().state, 'FOLLOWING');
});
