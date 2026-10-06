import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter, ESCORT_MAX_GAP, ESCORT_RESUME_GAP } from '../bedrock-adapter.mjs';
import { escortFulfilled, isEscortOrder } from '../controller-decisions.mjs';
import { optionIntents } from '../survival/intents.mjs';

// «Guidami fino al filone», «accompagnami», «portami là»: nel 06/10 l'utente ha
// chiesto di essere accompagnato e il bot ha risposto di sì, ma `follow_player`
// è il bot che *segue* l'umano e la scorta non esisteva. `escort_to` è il
// gemello: il bot decide la strada e aspetta chi resta indietro, e l'esito lo
// misura l'harness (quanto ha aspettato, perché si è fermato). Qui l'azione,
// l'opzione, la vista e il verdetto di fine ordine, senza rete.
const SENDER = 'TestPlayer';
const UNIQUE_ID = 77;
const DESTINATION = { x: 109, y: 20, z: 232 };

function escortAdapter ({ position = { x: 100.5, y: 71, z: 230.5 }, destination = DESTINATION, plan = null } = {}) {
  const events = [];
  const adapter = new BedrockAdapter({ logger: { log () {} }, onLog: entry => events.push(entry) });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.client = { queue () {} };
  adapter.inventory = {};
  adapter.nearbyBlocks = {};
  adapter.position = position;
  adapter._feet = { x: position.x, y: position.y - 1.62, z: position.z };
  adapter.plan = plan ?? { ...(adapter.plan || {}), escort: { from: SENDER, to: destination } };
  return { adapter, events };
}

function track (adapter, position) {
  adapter._trackEntity({ runtime_id: 7, unique_id: UNIQUE_ID, username: SENDER, position }, 'player');
}

// Cammina per davvero: teletrasporta il bot sulla meta, così il ciclo di scorta
// arriva subito alla condizione di arrivo.
function stubbedMove (adapter) {
  const calls = [];
  adapter._moveTo = async (target, stopDistance) => {
    calls.push({ target: { ...target }, stopDistance });
    adapter.position = { x: target.x, y: target.y, z: target.z };
    adapter._feet = { x: target.x, y: target.y - 1.62, z: target.z };
    return { distance: 0 };
  };
  return calls;
}

test('la scorta e un viaggio registrato, non un inseguimento', () => {
  assert.deepEqual(optionIntents('escort_to'), ['travel']);
  assert.notDeepEqual(optionIntents('escort_to'), ['unknown'], 'la scorta e un viaggio dichiarato, non una chiave sconosciuta');
});

test('observe().escort dice meta, distanza dell umano e limiti dichiarati', () => {
  const { adapter } = escortAdapter();
  track(adapter, { x: 96.5, y: 71, z: 230.5 }); // 4 blocchi dietro
  const escort = adapter.observe().escort;
  assert.equal(escort.name, SENDER);
  assert.deepEqual(escort.target, { x: 109, y: 20, z: 232, source: 'escort.to' });
  assert.equal(escort.tracked, true);
  assert.equal(escort.gap, 4);
  assert.equal(escort.waiting, false, 'dentro il margine si cammina');
  assert.equal(escort.ready, true);
  assert.deepEqual(escort.limits, {
    maxGap: ESCORT_MAX_GAP,
    resumeGap: ESCORT_RESUME_GAP,
    waitMs: 60000,
    lostMs: 20000,
    timeoutMs: 150000,
    arriveDistance: 2,
  });
});

test('il waypoint del piano e la rotta di replay valgono come meta', () => {
  const { adapter } = escortAdapter({ plan: { escort: { from: SENDER }, waypoint: { x: 40, z: 12 } } });
  assert.deepEqual(adapter._escortTarget(), { x: 40, y: 71, z: 12, source: 'plan.waypoint' });

  adapter.plan = { escort: { from: SENDER } };
  adapter.replayRoute = { destination: { x: 7, y: 64, z: 9 } };
  assert.deepEqual(adapter._escortTarget(), { x: 7, y: 64, z: 9, source: 'replay_route' });

  adapter.plan = { escort: { from: SENDER } };
  adapter.replayRoute = null;
  assert.equal(adapter._escortTarget(), null, 'senza meta non si guida nessuno');
});

test('escort_to si offre solo con una meta e l umano in vista', () => {
  const { adapter } = escortAdapter();
  track(adapter, { x: 96.5, y: 71, z: 230.5 });
  const option = adapter.options().find(entry => entry.key === 'escort_to');
  assert.ok(option, 'la scorta deve comparire fra le opzioni');
  assert.match(option.description, /Walk TestPlayer to 109, 232/);
  assert.match(option.description, /4 blocks apart/);

  const waiting = escortAdapter();
  track(waiting.adapter, { x: 60.5, y: 71, z: 230.5 }); // 40 blocchi dietro: oltre il margine
  const waitingOption = waiting.adapter.options().find(entry => entry.key === 'escort_to');
  assert.match(waitingOption.description, /waiting for them: 40 blocks behind/);
  assert.equal(waiting.adapter.observe().escort.waiting, true);

  const noDestination = escortAdapter({ plan: { escort: { from: SENDER } } });
  track(noDestination.adapter, { x: 100.5, y: 71, z: 230.5 });
  assert.equal(noDestination.adapter.options().some(entry => entry.key === 'escort_to'), false, 'una scorta senza meta non e un ordine eseguibile');
  const noHuman = escortAdapter();
  assert.equal(noHuman.adapter.options().some(entry => entry.key === 'escort_to'), false, 'non si guida un umano che non si vede');
});

test('una chiamata diretta senza piano riceve un errore tipizzato', async () => {
  const { adapter } = escortAdapter({ plan: { escort: null } });
  const refused = await adapter.executeAction('escort_to');
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'no_escort_target');
  assert.match(refused.hint, /plan\.escort\.from/);

  assert.equal((await adapter._escortTo(null, null)).error, 'no_escort_target');
  assert.match((await adapter._escortTo(SENDER, null)).hint, /no destination/);
});

test('la scorta aspetta chi resta indietro e poi arriva', async () => {
  const { adapter, events } = escortAdapter();
  track(adapter, { x: 80.5, y: 71, z: 230.5 }); // 20 blocchi dietro: si aspetta
  const moves = stubbedMove(adapter);
  const promise = adapter._escortTo();
  setTimeout(() => track(adapter, { x: 100.5, y: 71, z: 230.5 }), 350); // l'umano raggiunge
  const result = await promise;
  assert.equal(result.ok, true);
  assert.equal(result.arrived, true);
  assert.equal(result.escorted, SENDER);
  assert.equal(result.distance, 0);
  assert.ok(result.waitedMs >= 250, `ha aspettato (${result.waitedMs} ms)`);
  assert.equal(result.waits.length, 1);
  assert.equal(result.waits[0].resumed, true);
  assert.equal(moves.length, 1, 'prima aspetta, poi cammina una volta sola');
  assert.ok(events.some(entry => entry.type === 'escort_arrived'), 'la scorta lascia una traccia nei log');
});

test('se l umano non torna la scorta si chiude con un motivo', async () => {
  const { adapter, events } = escortAdapter();
  track(adapter, { x: 40.5, y: 71, z: 230.5 }); // 60 blocchi dietro, mai piu vicino
  const result = await adapter._escortTo(SENDER, DESTINATION, { maxGap: 5, waitMs: 300, timeoutMs: 5000 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'escort_left_behind');
  assert.equal(result.gap, 60);
  assert.equal(result.resumeGap, 5);
  assert.ok(result.waitedMs >= 300);
  assert.ok(events.some(entry => entry.type === 'escort_wait_over'), 'il motivo finisce nei log');
});

test('un umano che sparisce non lascia il bot a camminare da solo', async () => {
  const { adapter } = escortAdapter();
  const result = await adapter._escortTo(SENDER, DESTINATION, { lostMs: 200, timeoutMs: 5000 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'escort_lost');
  assert.equal(result.target, SENDER);
});

test('una scorta e chiusa quando sono arrivati entrambi', () => {
  const order = { from: SENDER, to: DESTINATION };
  const arrived = { position: { x: 109, y: 20, z: 232 }, escort: { gap: 3, limits: { maxGap: 12 } } };
  assert.equal(escortFulfilled(order, arrived), true);
  assert.equal(escortFulfilled(order, { ...arrived, escort: { gap: 30, limits: { maxGap: 12 } } }), false, 'l umano e rimasto indietro');
  assert.equal(escortFulfilled(order, { ...arrived, escort: { gap: null, limits: { maxGap: 12 } } }), false, 'senza traccia non si dichiara arrivata');
  assert.equal(escortFulfilled(order, { position: { x: 90, y: 20, z: 232 }, escort: { gap: 1, limits: { maxGap: 12 } } }), false, 'il bot non e alla meta');
  assert.equal(escortFulfilled(null, { ...arrived, plan: { waypoint: DESTINATION } }), true, 'la meta del piano vale come quella dell ordine');
});

test('solo «guidami/accompagnami» e un ordine di scorta', () => {
  for (const message of ['@bot guidami fino al filone', 'accompagnami al tunnel', 'portami là', 'fammi strada', 'lead me to the vein', 'walk me to the base']) {
    assert.equal(isEscortOrder(message), true, message);
  }
  for (const message of ['seguimi', 'vieni qui', 'fermati', 'aspettami', 'scava 4 terra', 'vai a dormire', 'mi hai guidato bene']) {
    assert.equal(isEscortOrder(message), false, message);
  }
});
