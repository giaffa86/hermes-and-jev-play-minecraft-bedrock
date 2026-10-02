import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';
import { detectEvents, WORLD_EVENTS } from '../world-events.mjs';

// harvestTools usa gli id del data Bedrock (non i network id): 961 = piccone di
// ferro (rank 3), 966 = diamante (4), 971 = netherite (5).
const oreBlock = (name, extra = {}) => ({
  name,
  position: { x: 12, y: 12, z: 12 },
  distance: 4.2,
  diggable: true,
  hardness: 3,
  material: 'mineable/pickaxe',
  harvestTools: { 961: true, 966: true, 971: true },
  ...extra,
});

const AIR_NEIGHBOURS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

// Atlante di celle: la vena con aria intorno, così anche la lista fissa la vede
// esposta e il test della dedup non passa per il motivo sbagliato.
function openVeinAtlas (name) {
  const vein = oreBlock(name);
  const atlas = { [`${vein.position.x},${vein.position.y},${vein.position.z}`]: vein };
  for (const [dx, dy, dz] of AIR_NEIGHBOURS) {
    atlas[`${vein.position.x + dx},${vein.position.y + dy},${vein.position.z + dz}`] = { name: 'air', boundingBox: 'empty', diggable: false, hardness: 0 };
  }
  return atlas;
}

function oreAdapter (atlas = {}) {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter._feet = { x: 8, y: 11, z: 8 };
  adapter.position = { x: 8, y: 12.62, z: 8 };
  adapter.world.findBlocks = name => Object.values(atlas).filter(block => block.name === name);
  adapter.world.blockAt = ({ x, y, z }) => atlas[`${x},${y},${z}`] ??
    { name: 'stone', material: 'mineable/pickaxe', diggable: true, hardness: 1.5 };
  return adapter;
}

test('a valuable vein in range becomes an observation, an option and an event', () => {
  const adapter = oreAdapter(openVeinAtlas('diamond_ore'));
  adapter.inventorySlots[0] = { network_id: 941, name: 'iron_pickaxe', count: 1 };
  adapter._refreshNearby();

  const ores = adapter.observe().ores;
  assert.equal(ores.length, 1);
  assert.equal(ores[0].name, 'diamond_ore');
  assert.equal(ores[0].value, 100);
  assert.equal(ores[0].harvestable, true);

  const option = adapter.options().find(o => o.key === 'mine_diamond_ore');
  assert.ok(option, 'mine_diamond_ore è offerto fuori dal piano');
  assert.match(option.description, /opportunity/);

  const event = detectEvents(null, adapter.observe()).find(e => e.type === WORLD_EVENTS.VALUABLE_ORE_SEEN);
  assert.equal(event.data.ore, 'diamond_ore');
  assert.equal(event.data.harvestable, true);
  assert.equal(event.data.drop, 'diamond');
});

test('a vein the pickaxe cannot harvest is remembered but not offered', () => {
  const adapter = oreAdapter(openVeinAtlas('diamond_ore'));
  adapter.inventorySlots[0] = { network_id: 341, name: 'wooden_pickaxe', count: 1 };
  adapter._refreshNearby();

  assert.equal(adapter.observe().ores[0].harvestable, false, 'la vena resta in memoria');
  assert.ok(!adapter.options().some(o => o.key === 'mine_diamond_ore'), 'senza utensile giusto non è un’azione valida');
  const event = detectEvents(null, adapter.observe())[0];
  assert.equal(event.data.harvestable, false, 'il produttore di goal può così rifiutarla');
});

test('an ore already offered by the fixed mining list is not duplicated', () => {
  const adapter = oreAdapter(openVeinAtlas('coal_ore'));
  adapter.inventorySlots[0] = { network_id: 941, name: 'iron_pickaxe', count: 1 };
  adapter._refreshNearby();

  const coal = adapter.options().filter(o => o.key === 'mine_coal_ore');
  assert.equal(coal.length, 1);
  assert.doesNotMatch(coal[0].description, /opportunity/, 'vince l’opzione della lista fissa, non il duplicato');
});

test('the ore scan is cached, and refreshes after moving', () => {
  const adapter = oreAdapter(openVeinAtlas('diamond_ore'));
  adapter.inventorySlots[0] = { network_id: 941, name: 'iron_pickaxe', count: 1 };
  adapter._refreshNearby();
  assert.equal(adapter.valuableOres.length, 1);

  adapter.world.findBlocks = () => [];
  adapter._refreshNearby();
  assert.equal(adapter.valuableOres.length, 1, 'entro il TTL e senza spostarsi la lista è riusata');

  adapter.position = { x: 40, y: 12.62, z: 8 };
  adapter._refreshNearby();
  assert.equal(adapter.valuableOres.length, 0, 'dopo > 8 blocchi la scansione riparte');
});

test('an adapter with no world yet does not crash', () => {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  assert.deepEqual(adapter._scanValuableOres(), []);
  assert.deepEqual(adapter.observe().ores, []);
});
