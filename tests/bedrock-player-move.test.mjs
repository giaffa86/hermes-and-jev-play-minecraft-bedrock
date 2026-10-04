// Regression test for patch 8: the BDS relays *other* players' movement with the
// `move_player` packet (0x13, ~20 packets/s) — `move_entity`/`move_entity_delta`
// are for mobs only. The adapter already had a `move_player` handler, but it
// returned early for every packet that was not the bot itself, so a human's
// position stayed frozen at their first `add_player`: `follow_player` then
// "succeeded" forever 2.9 blocks away from a ghost while the human walked away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EYE_HEIGHT = 1.62;

// Same minimal adapter used by the other chat tests: no world, no client.
function moveAdapter () {
  const events = [];
  const adapter = new BedrockAdapter({ logger: { log () {} }, onLog: entry => events.push(entry) });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.client = { queue () {} };
  adapter.inventory = {};
  adapter.nearbyBlocks = {};
  adapter.position = { x: 0.5, y: 72.62, z: 0.5 };
  adapter._feet = { x: 0.5, y: 71, z: 0.5 };
  adapter._trackEntity({ runtime_id: 7, unique_id: 11, username: 'Ale', position: { x: 4, y: 73.62, z: 0 } }, 'player');
  adapter.plan = { ...adapter.plan, follow: 'Ale' };
  return { adapter, events };
}

test('move_player moves another player the entity map already knows', () => {
  const { adapter } = moveAdapter();
  const entity = adapter.entities.get('7');
  assert.equal(entity.username, 'Ale');
  assert.equal(entity.position.x, 4, 'add_player put the player at x=4');
  assert.equal(entity.position.y, 73.62 - EYE_HEIGHT, 'players are stored at eye height minus EYE_HEIGHT');

  adapter._onPlayerMove({ runtime_id: 7, position: { x: 12, y: 73.62, z: 8 } });

  assert.equal(entity.position.x, 12, 'the position follows the packet');
  assert.equal(entity.position.z, 8);
  assert.equal(entity.position.y, 73.62 - EYE_HEIGHT, 'the y keeps the feet convention');
  assert.equal(adapter._playerByName('Ale'), entity, 'the name still resolves to the same entity');
});

test('every move_player packet is applied, so the distance is always fresh', () => {
  const { adapter } = moveAdapter();
  const distances = [];
  for (const x of [6, 10, 14, 18]) {
    adapter._onPlayerMove({ runtime_id: 7, position: { x, y: 73.62, z: 0 } });
    distances.push(adapter._entityDistance(adapter.entities.get('7')));
  }
  assert.equal(distances.every((d, i) => i === 0 || d > distances[i - 1]), true, `the distance grows with the human (${JSON.stringify(distances)})`);
  assert.equal(adapter.entities.get('7').position.x, 18, 'the last packet wins');

  // Il difetto live: l'entita' seguibile restava a 2.9 blocchi per sempre.
  const view = adapter._followView();
  assert.equal(view.tracked, true);
  assert.equal(view.lastSeen.x, 18, 'the last known position is the live one');
  assert.equal(view.lastSeenAgeMs < 1000, true);
  assert.equal(view.searchable, false, 'a tracked player does not need a search');
});

test('the memory of the last seen position follows move_player too', () => {
  const { adapter } = moveAdapter();
  adapter._onPlayerMove({ runtime_id: 7, position: { x: 40, y: 73.62, z: -12 } });
  const target = adapter._seekTarget('Ale');
  assert.equal(target.position.x, 40, 'the seek target is the updated position, not the add_player one');
  assert.equal(target.position.z, -12);
  assert.equal(target.live, true, 'the target is live, not a memory');
});

test('move_player for an unknown entity is ignored and creates no ghost', () => {
  const { adapter } = moveAdapter();
  const before = adapter.entities.size;
  adapter._onPlayerMove({ runtime_id: 999, position: { x: 1, y: 70, z: 1 } });
  assert.equal(adapter.entities.size, before, 'no entity is created by a movement packet');
  adapter._onPlayerMove({ runtime_id: 7 });
  assert.equal(adapter.entities.get('7').position.x, 4, 'a packet without position changes nothing');
});

test("the client wiring forwards other players' move_player to _onPlayerMove", () => {
  // La causa radice era nel wiring, non nella matematica: l'handler esisteva ma
  // scartava tutto cio' che non era il bot. Questo test blinda il ramo.
  const source = readFileSync(join(ROOT, 'bedrock-adapter.mjs'), 'utf8');
  const start = source.indexOf("this.client.on('move_player'");
  assert.notEqual(start, -1, 'the move_player handler exists');
  const handler = source.slice(start, start + 700);
  assert.match(handler, /String\(packet\.runtime_id\) !== String\(client\.entityId\)/, 'the handler still tells the bot apart from the others');
  assert.match(handler, /this\._onPlayerMove\(packet\);/, 'other players are forwarded to _onPlayerMove');
  assert.equal(source.match(/client\.on\('move_player'/g).length, 1, 'exactly one move_player handler is registered');
});
