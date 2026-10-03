import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { BedrockWorld } from '../bedrock-world.mjs';
const require = createRequire(import.meta.url);
const Stream = require('prismarine-chunk/src/bedrock/common/Stream');

test('late item_registry keeps tool properties while remapping runtime IDs', () => {
  const world = new BedrockWorld();
  const packet = { dimension: 0, block_network_ids_are_hashes: true, itemstates: [] };
  world.start(packet);
  world.registry.handleStartGame({ ...packet,
    itemstates: [{ name: 'minecraft:iron_sword', runtime_id: 701 }] });
  assert.equal(world.registry.items[701].name, 'iron_sword');
  assert.equal(world.registry.items[701].maxDurability, 250);
});

test('real BDS 1.26.52 terrain contains vanilla blocks, not the first block_properties entry', () => {
  const world = new BedrockWorld();
  world.start({ dimension: 'overworld', block_network_ids_are_hashes: true, block_properties: [{ name: 'minecraft:black_concrete_double_slab' }] });
  const packet = JSON.parse(readFileSync(new URL('./fixtures/bedrock-terrain.json', import.meta.url)));
  for (const entry of packet.entries) entry.payload = Buffer.from(entry.payload, 'base64');
  world.subchunk(packet);
  assert.equal(world.summary().decodeErrors, 0);
  for (const [position, name, hardness] of [
    [{ x: 92, y: 72, z: 163 }, 'oak_planks', 2],
    [{ x: 91, y: 74, z: 161 }, 'oak_log', 2],
    [{ x: 92, y: 71, z: 163 }, 'dirt', 0.5],
    [{ x: 90, y: 68, z: 166 }, 'stone', 1.5],
    [{ x: 92, y: 71, z: 160 }, 'grass_block', 0.6]
  ]) {
    const block = world.blockAt(position);
    assert.equal(block.name, name);
    assert.equal(block.hardness, hardness);
    assert.equal(block.diggable, true);
  }
  assert.equal(world.blockAt({ x: 0, y: 70, z: 0 }), null);
  assert.ok(world.summary().unknownRuntimeIds > 0);
  assert.equal(world.findBlocks('oak_log', { x: 92, y: 74, z: 163 }, 8, 1).length, 1);

  // Istogramma dei blocchi caricati: la base dei detector di strutture (M5/M6).
  const survey = world.surveyBlocks({ x: 92, y: 72, z: 163 }, 16);
  assert.ok(survey.scanned > 0 && survey.truncated === false);
  assert.ok(survey.names.get('oak_planks').count >= 1);
  assert.equal(world.blockAt(survey.names.get('oak_log').first).name, 'oak_log', 'la posizione `first` è davvero quel blocco');
  assert.equal(survey.names.has('stone'), false, 'la pietra è rumore per un detector');
  assert.equal(survey.names.has('air'), false);
  assert.equal(survey.names.has('dirt'), false);

  const limited = world.surveyBlocks({ x: 92, y: 72, z: 163 }, 16, { limit: 5 });
  assert.equal(limited.scanned, 5, 'il budget di celle visitate si rispetta');
  assert.equal(limited.truncated, true);
  assert.equal(world.surveyBlocks({ x: 92, y: 72, z: 163 }, 16, { maxDistinct: 0 }).distinct, 0);
  assert.deepEqual(world.surveyBlocks(null, 16).names.size, 0, 'senza punto non si scansiona nulla');

  // Aria sotto i piedi: misurata a parte (bucket sintetico `air_below`), perché
  // l'aria è ignorata come rumore e serve invece a vedere una cavità (target M6).
  assert.equal(survey.names.has('air_below'), false, 'qui il punto è al livello del suolo: nessuna cavità sotto');
  const below = world.surveyBlocks({ x: 92, y: 72, z: 163 }, 16, { airBelow: 0 });
  assert.ok(below.names.get('air_below').count > 0);
  assert.equal(world.blockAt(below.names.get('air_below').first).name, 'air', 'il bucket punta a una cella d\'aria');
});

test('findBlocks returns the block object itself, block states included', () => {
  // Regressione: restituire `{...block, distance}` perdeva `getProperties()`,
  // quindi gli stati (es. `growth` delle colture) non erano leggibili live.
  const world = new BedrockWorld();
  world.start({ dimension: 'overworld', block_network_ids_are_hashes: true, block_properties: [{ name: 'minecraft:black_concrete_double_slab' }] });
  const packet = JSON.parse(readFileSync(new URL('./fixtures/bedrock-terrain.json', import.meta.url)));
  for (const entry of packet.entries) entry.payload = Buffer.from(entry.payload, 'base64');
  world.subchunk(packet);
  const [hit] = world.findBlocks('oak_log', { x: 92, y: 74, z: 163 }, 8, 1);
  assert.ok(hit, 'oak_log found');
  assert.equal(typeof hit.getProperties, 'function', 'the returned block keeps its methods');
  assert.equal(typeof hit.distance, 'number', 'and carries the distance');
  const direct = world.blockAt(hit.position);
  assert.equal(hit.stateId, direct.stateId);
  assert.deepEqual(hit.getProperties(), direct.getProperties());
});

test('singleton palettes resolve runtime hashes and signed underground section indices', () => {
  const world = new BedrockWorld();
  world.start({ dimension: 0, block_network_ids_are_hashes: true });
  const stream = new Stream();
  for (const value of [9, 1, 255, 1]) stream.writeUInt8(value);
  const hash = world.Block.getHash('stone', {});
  // The library writer needs an unsigned varint for hashes with bit 31 set.
  stream.writeVarInt(((hash << 1) ^ (hash >> 31)) >>> 0);
  world.decodeSection(world.column(-1, -1), -1, stream.getBuffer());
  assert.equal(world.blockAt({ x: -1, y: -1, z: -1 }).name, 'stone');
  const unknown = new Stream();
  for (const value of [9, 1, 4, 1]) unknown.writeUInt8(value);
  unknown.writeZigZagVarInt(123456789);
  world.decodeSection(world.column(0, 0), 4, unknown.getBuffer());
  assert.equal(world.blockAt({ x: 0, y: 64, z: 0 }).name, 'unknown');
  assert.equal(world.blockAt({ x: 0, y: 64, z: 0 }).diggable, false);
});

test('server block updates change searches, preserve layers and retain unknown hashes', () => {
  const world = new BedrockWorld();
  world.start({ dimension: 0, block_network_ids_are_hashes: true });
  const packet = JSON.parse(readFileSync(new URL('./fixtures/bedrock-terrain.json', import.meta.url)));
  for (const entry of packet.entries) entry.payload = Buffer.from(entry.payload, 'base64');
  world.subchunk(packet);
  const position = { x: 91, y: 74, z: 161 };
  const air = world.Block.getHash('air', {});
  const water = world.Block.getHash('water', { liquid_depth: { type: 'int', value: 0 } });
  assert.ok(world.runtimeIdAt(position) != null);
  assert.equal(world.setBlock(position, air), true);
  assert.equal(world.blockAt(position).name, 'air');
  assert.equal(world.runtimeIdAt(position), air);
  assert.equal(world.findBlocks('oak_log', position, 0, 1).length, 0);
  world.setBlock(position, water, 1);
  assert.equal(world.blockAt(position).name, 'air');
  world.setBlock(position, 123456789);
  assert.equal(world.blockAt(position).name, 'unknown');
  assert.equal(world.blockAt(position).diggable, false);
  assert.equal(world.setBlock({ x: 0, y: 70, z: 0 }, air), false);
  assert.equal(world.blockAt({ x: 0, y: 70, z: 0 }), null);
});

test('refresh invalidates cached block data until the requested section arrives', () => {
  const world = new BedrockWorld();
  world.start({ dimension: 0, block_network_ids_are_hashes: true });
  const position = { x: -1, y: -1, z: -1 };
  world.subchunk({ dimension: 0, origin: { x: -1, y: -1, z: -1 }, entries: [{ dx: 0, dy: 0, dz: 0, result: 'success_all_air' }] });
  world.setBlock(position, world.Block.getHash('stone', {}));
  assert.equal(world.blockAt(position).name, 'stone');
  const requests = [];
  world.refreshSection({ queue (name, params) { requests.push({ name, params }); } }, position);
  assert.equal(world.blockAt(position), null);
  assert.deepEqual(requests[0].params.origin, { x: -1, y: -1, z: -1 });
  assert.deepEqual(requests[0].params.requests, [{ x: 0, y: 0, z: 0 }]);
});

test('biomeAt reads the biome name from the loaded column', () => {
  const world = new BedrockWorld();
  world.registry = {};
  world.columns = new Map([['0,0', { getBiome: () => ({ name: 'cherry_grove' }) }]]);
  assert.equal(world.biomeAt({ x: 5, y: 64, z: 5 }), 'cherry_grove');
  assert.equal(world.biomeAt({ x: 100, y: 64, z: 5 }), null, 'colonna non caricata');
});
