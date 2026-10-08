import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BedrockAdapter, renderServerText } from '../bedrock-adapter.mjs';

// M13 — «il bot dice is sleeping ma non è vero», «dice others two players need to
// sleep ma siamo solo io e lui». L'08/10/2026 il server *stava* spiegando il
// motivo per cui la notte non saltava (`playersSleepingPercentage=100` con due
// giocatori), e l'adapter buttava via il messaggio: `_onChat` accettava solo
// `chat`/`whisper`/`json_whisper`. Il testo del server ora si conserva reso (i
// `%s` riempiti dai `parameters`), non entra nell'inbox (non è un ordine) e
// distingue `sleep_pending_players` da un letto rifiutato.

function spawnedAdapter () {
  const events = [];
  const adapter = new BedrockAdapter({ logger: { log () {} }, onLog: entry => events.push(entry) });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.client = new EventEmitter();
  adapter.client.entityId = 7n;
  adapter.client.write = () => {};
  adapter.position = { x: 0, y: 64.62, z: 0 };
  adapter._feet = { x: 0, y: 63, z: 0 };
  return { adapter, events };
}

function bed (position, distance, occupied = false) {
  return {
    name: 'bed',
    position,
    distance,
    getProperties: () => ({ occupied_bit: occupied, head_piece_bit: false }),
  };
}

function stubBeds (adapter, beds) {
  adapter._bedCache = null;
  adapter.world.findBlocks = (name) => (name === 'bed' ? beds : []);
  adapter.world.blockAt = ({ x, y, z }) => {
    const found = beds.find(b => b.position.x === x && b.position.y === y && b.position.z === z);
    if (found) return { ...found, boundingBox: 'empty', shapes: [[0, 0, 0, 1, 0.5625, 1]] };
    return y === 62 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' };
  };
}

test('renderServerText fills the translation parameters instead of leaving the placeholders', () => {
  assert.equal(
    renderServerText({ type: 'translation', message: '%s more players need to sleep', parameters: [1] }),
    '1 more players need to sleep',
  );
  assert.equal(
    renderServerText({ type: 'raw', message: '%2$s and %1$s must sleep', parameters: ['A', 'B'] }),
    'B and A must sleep',
  );
  assert.equal(
    renderServerText({ type: 'raw', message: '§eYou can sleep only at night or during a thunderstorm' }),
    'You can sleep only at night or during a thunderstorm',
  );
  assert.equal(renderServerText({ type: 'raw', message: '   ' }), null);
  assert.equal(renderServerText({}), null);
  assert.equal(renderServerText(null), null);
});

test('a server text is kept for diagnosis but never becomes a chat order', () => {
  const { adapter, events } = spawnedAdapter();
  adapter._onChat({ type: 'translation', needs_translation: true, message: '%s more players need to sleep', parameters: [1] });
  adapter._onChat({ type: 'chat', message: '@bot seguimi', source_name: 'TrustedPlayer', xuid: '5' });
  assert.equal(adapter.chatInbox.length, 1, 'solo la chat di un giocatore entra nell inbox');
  assert.equal(adapter.chatInbox[0].message, '@bot seguimi');
  assert.equal(adapter.serverText.length, 1);
  assert.equal(adapter.serverText[0].text, '1 more players need to sleep');
  assert.equal(adapter.serverText[0].type, 'translation');
  const logged = events.filter(entry => entry.type === 'server_text');
  assert.equal(logged.length, 1, 'il testo del server finisce nel ledger');
  assert.equal(logged[0].translation, '%s more players need to sleep');
});

test('serverText is a bounded window and observe() exposes it', () => {
  const { adapter } = spawnedAdapter();
  for (let i = 0; i < 20; i++) adapter._onChat({ type: 'raw', message: `messaggio ${i}` });
  assert.equal(adapter.serverText.length, 12, 'la finestra è un tetto, non una crescita illimitata');
  assert.equal(adapter.serverText.at(-1).text, 'messaggio 19');
  assert.deepEqual(adapter.observe().serverText.map(row => row.text).at(-1), 'messaggio 19');
});

test('_serverSaidSleepPending recognises the multiplayer sleep notice in several languages', () => {
  const { adapter } = spawnedAdapter();
  adapter._onChat({ type: 'raw', message: 'foobar unrelated' });
  adapter._onChat({ type: 'translation', message: '%s more players need to sleep', parameters: [1] });
  assert.deepEqual(adapter._serverSaidSleepPending(), ['1 more players need to sleep']);
  assert.deepEqual(adapter._serverSaidSleepPending({ since: Date.now() + 1000 }), [], 'il filtro temporale vale');
  const italian = spawnedAdapter();
  italian.adapter._onChat({ type: 'raw', message: '1 giocatore deve dormire' });
  assert.equal(italian.adapter._serverSaidSleepPending().length, 1);
});

test('sleepInBed reports sleep_pending_players when the server asks for other players', async () => {
  const { adapter } = spawnedAdapter();
  adapter._recordTime(18000);
  stubBeds(adapter, [bed({ x: 0, y: 63, z: 2 }, 2.8, false)]);
  adapter._queueAuthInput = async () => {
    adapter._onChat({ type: 'translation', message: '%s more players need to sleep', parameters: [1] });
  };
  const result = await adapter._sleepInBed({ confirmMs: 10 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'sleep_pending_players', 'il letto non c entra: la notte aspetta gli altri');
  assert.deepEqual(result.serverSaid, ['1 more players need to sleep']);
  assert.match(result.hint, /playersSleepingPercentage/);
});

test('sleepInBed still reports sleep_rejected when the server says nothing', async () => {
  const { adapter } = spawnedAdapter();
  adapter._recordTime(18000);
  stubBeds(adapter, [bed({ x: 0, y: 63, z: 2 }, 2.8, false)]);
  adapter._queueAuthInput = async () => {};
  const result = await adapter._sleepInBed({ confirmMs: 10 });
  assert.equal(result.error, 'sleep_rejected');
  assert.equal(result.serverSaid, undefined, 'nessun testo del server: nessun campo inventato');
});

test('sleepInBed tries every bed of the census, occupied ones last, within the total budget', async () => {
  const { adapter } = spawnedAdapter();
  adapter._recordTime(18000);
  // Dieci letti: tre occupati e vicini, sette liberi e lontani. L'08/10/2026 il
  // `.slice(0, 3)` tagliava il censimento e i letti a piano terra delle case
  // vicine non venivano mai tentati.
  const beds = [];
  for (let i = 0; i < 3; i++) beds.push(bed({ x: 0, y: 63, z: 2 + i }, 2 + i, true));
  for (let i = 0; i < 7; i++) beds.push(bed({ x: 0, y: 63, z: 12 + i }, 12 + i, false));
  stubBeds(adapter, beds);
  adapter._moveTo = async () => { throw new Error('movement timeout'); };
  adapter._queueAuthInput = async () => {};
  const result = await adapter._sleepInBed({ confirmMs: 10, approachTimeoutMs: 500, retryTimeoutMs: 400 });
  assert.equal(result.ok, false);
  // L'ultimo candidato è il letto occupato ma vicino: lì il click parte e il
  // server lo rifiuta, quindi l'errore finale è `sleep_rejected`.
  assert.equal(result.error, 'sleep_rejected');
  assert.equal(result.tried.length, 8, 'maxBeds: si prova l intero censimento, non i primi tre');
  assert.deepEqual(result.tried.map(entry => entry.bed.z), [12, 13, 14, 15, 16, 17, 18, 2], 'liberi prima, occupati in coda');
});

test('sleepInBed stops trying once the total budget is exhausted', async () => {
  const { adapter } = spawnedAdapter();
  adapter._recordTime(18000);
  const beds = [];
  for (let i = 0; i < 8; i++) beds.push(bed({ x: 0, y: 63, z: 12 + i }, 12 + i, false));
  stubBeds(adapter, beds);
  adapter._moveTo = async () => { throw new Error('movement timeout'); };
  adapter._queueAuthInput = async () => {};
  // Budget già scaduto: entra solo il primo tentativo (il minimo non si nega) e
  // i restanti si annotano come `budget_exhausted`, non come letti irraggiungibili.
  const result = await adapter._sleepInBed({ confirmMs: 10, approachTimeoutMs: 500, maxTotalMs: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.tried.length, 2);
  assert.equal(result.tried[0].error, 'bed_unreachable');
  assert.equal(result.tried[1].error, 'budget_exhausted');
  assert.equal(result.tried[1].distance, null);
});
