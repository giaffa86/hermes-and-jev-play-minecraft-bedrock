import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { BedrockAdapter } from '../bedrock-adapter.mjs';
import {
  planGreetings, renderGreeting,
  DEFAULT_GREETING_TEMPLATE, DEFAULT_GREET_RANGE, DEFAULT_GREET_COOLDOWN_MS,
} from '../human-greeting.mjs';

const require = createRequire(import.meta.url);
const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer');
const serializer = createSerializer('1.26.51');
const parser = createDeserializer('1.26.51');

const BOT = process.env.BEDROCK_USERNAME || 'hermes-bot';

// ---- policy pura (human-greeting.mjs) --------------------------------------

test('renderGreeting sostituisce nome e prefisso nel template', () => {
  assert.equal(renderGreeting('Ciao {name}: scrivi {prefix} aiuto', { username: 'Tester', prefix: '@bot' }),
    'Ciao Tester: scrivi @bot aiuto');
  assert.equal(renderGreeting(null, { username: 'Tester' }), '');
});

test('un umano fidato vicino riceve il saluto con la sintassi del prefisso', () => {
  const allowlist = new Set(['tester']);
  const out = planGreetings({
    humans: [{ username: 'Tester', distance: 4.5 }],
    allowlist,
    prefix: '@bot',
    now: 1000,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].username, 'Tester');
  assert.equal(out[0].distance, 4.5);
  assert.match(out[0].message, /Tester/);
  assert.ok(out[0].message.includes('@bot <ordine>'), 'deve indicare la sintassi esatta col prefisso');
  assert.equal(out[0].message, renderGreeting(DEFAULT_GREETING_TEMPLATE, { username: 'Tester', prefix: '@bot' }));
});

test('nessun saluto senza allowlist, a sconosciuti o fuori raggio', () => {
  const humans = [
    { username: 'Tester', distance: 5 },
    { username: 'Sconosciuto', distance: 5 },
    { username: 'Lontano', distance: DEFAULT_GREET_RANGE + 10 },
  ];
  assert.deepEqual(planGreetings({ humans, allowlist: new Set(['tester']), now: 0 }).map(g => g.username), ['Tester']);
  assert.deepEqual(planGreetings({ humans, allowlist: new Set(), now: 0 }), []);
  assert.deepEqual(planGreetings({ humans, allowlist: null, now: 0 }), []);
  // Il match è case-insensitive in entrambe le direzioni.
  assert.deepEqual(planGreetings({ humans: [{ username: 'TESTER', distance: 5 }], allowlist: new Set(['tester']), now: 0 })
    .map(g => g.username), ['TESTER']);
});

test('lo stesso umano non viene salutato due volte entro il cooldown', () => {
  const allowlist = new Set(['tester']);
  const humans = [{ username: 'Tester', distance: 5 }];
  const greeted = new Map();
  const first = planGreetings({ humans, allowlist, greeted, now: 1000, cooldownMs: 60000 });
  assert.equal(first.length, 1);
  greeted.set('tester', 1000);
  assert.equal(planGreetings({ humans, allowlist, greeted, now: 30000, cooldownMs: 60000 }).length, 0);
  assert.equal(planGreetings({ humans, allowlist, greeted, now: 1000 + 60000, cooldownMs: 60000 }).length, 1);
  // cooldown 0 = una volta per sessione.
  assert.equal(planGreetings({ humans, allowlist, greeted, now: 9e12, cooldownMs: 0 }).length, 0);
  assert.ok(DEFAULT_GREET_COOLDOWN_MS > 0);
});

test('gli umani malformati vengono ignorati senza rompere il piano', () => {
  const allowlist = new Set(['tester']);
  const out = planGreetings({
    humans: [null, {}, { username: '' }, { distance: 3 }, { username: 'Tester', distance: null }],
    allowlist,
    now: 0,
  });
  assert.deepEqual(out.map(g => g.username), ['Tester']);
  assert.equal(out[0].distance, null);
});

// ---- adapter: observe().humans e M5 (il bot parla) --------------------------

function humanEntity (username, x, z) {
  return { runtimeId: username, uniqueId: null, type: 'player', kind: 'player', username, position: { x, y: 64, z }, health: 20, lastAt: Date.now(), seenAt: Date.now() };
}

function adapterAtOrigin () {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.position = { x: 0, y: 64, z: 0 };
  return adapter;
}

test('observe().humans elenca i giocatori umani vicini ma non il bot stesso', () => {
  const adapter = adapterAtOrigin();
  adapter.entities.set('tester', humanEntity('Tester', 5, 0));
  adapter.entities.set('bot', humanEntity(BOT, 1, 0));
  adapter.entities.set('far', humanEntity('Lontano', 200, 0));
  adapter.entities.set('zombie', { runtimeId: 'zombie', type: 'zombie', kind: 'mob', position: { x: 2, y: 64, z: 0 }, health: 20, lastAt: Date.now() });

  const humans = adapter.observe().humans;
  assert.equal(humans.length, 1);
  assert.equal(humans[0].username, 'Tester');
  assert.equal(humans[0].position.x, 5);
  assert.ok(humans[0].distance < DEFAULT_GREET_RANGE);
});

test('sendChat mette un pacchetto text di tipo chat sul filo', () => {
  const adapter = adapterAtOrigin();
  adapter.spawned = true;
  adapter.status = 'spawned';
  const packets = [];
  adapter.client = {
    queue (name, params) {
      packets.push(parser.parsePacketBuffer(serializer.createPacketBuffer({ name, params })).data.params);
    },
    write () { throw new Error('sendChat deve usare queue, non write'); },
  };

  const result = adapter.sendChat('Ciao Tester! Scrivi @bot <ordine>');
  assert.equal(result.ok, true);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].type, 'chat');
  assert.equal(packets[0].message, 'Ciao Tester! Scrivi @bot <ordine>');
  assert.equal(packets[0].source_name, BOT);
  assert.equal(packets[0].needs_translation, false);
  assert.equal(packets[0].category, 'authored');
  assert.equal(packets[0].has_filtered_message, false);
});

test('sendChat normalizza i ritorni a capo e rifiuta a bot non spawnato, vuoto, troppo lungo o troppo ravvicinato', () => {
  const adapter = adapterAtOrigin();
  adapter.status = 'spawned';
  const packets = [];
  adapter.client = { queue (name, params) { packets.push(params); } };

  assert.equal(adapter.sendChat('ciao').ok, false, 'non spawnato');
  assert.equal(adapter.sendChat('ciao').error, 'not_spawned');

  adapter.spawned = true;
  assert.equal(adapter.sendChat('   ').error, 'empty_message');
  assert.equal(adapter.sendChat('x'.repeat(300)).error, 'message_too_long');
  assert.equal(packets.length, 0);

  assert.equal(adapter.sendChat('prima\nseconda').ok, true);
  assert.equal(packets.at(-1).message, 'prima seconda');

  const limited = adapter.sendChat('subito dopo');
  assert.equal(limited.ok, false);
  assert.equal(limited.error, 'rate_limited');
  assert.ok(limited.retryInMs > 0);
});
