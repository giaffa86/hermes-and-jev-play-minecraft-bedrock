import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { BedrockAdapter } from '../bedrock-adapter.mjs';
import {
  bestFood, isHostileType, entityHeight, normalizeEntityType,
  LAST_RESORT_FOODS,
  estimatedTimeOfDay, isNightTime, timePhase, awayDirection, rotateDirection,
  isFarmAnimalType, animalFeed, cropForSeed, isCropBlock, isFarmlandBlock,
  isTameableType, isRideTameableType, isCompanionType, tameFeed,
  PLANTABLE_ITEMS,
  ANIMAL_FEED_MAP, TAME_FEED_MAP, SEED_TO_CROP_MAP, CROP_MAX_GROWTH_MAP,
  BUCKET_INGREDIENTS, SHIELD_INGREDIENTS, FOODS,
} from '../bedrock-survival.mjs';

// ---- regole pure --------------------------------------------------------------------

test('hostile classification ignores the minecraft prefix', () => {
  assert.equal(isHostileType('minecraft:zombie'), true);
  assert.equal(isHostileType('ZOMBIE'), true);
  assert.equal(isHostileType('skeleton'), true);
  assert.equal(isHostileType('creeper'), true);
  assert.equal(isHostileType('ender_dragon'), true);
  assert.equal(isHostileType('cow'), false);
  assert.equal(isHostileType('player'), false);
  assert.equal(normalizeEntityType(undefined), '');
});

test('entity heights fall back to a humanoid default', () => {
  assert.equal(entityHeight('zombie'), 1.95);
  assert.equal(entityHeight('minecraft:spider'), 0.9);
  assert.equal(entityHeight('cow'), 1.4);
  assert.equal(entityHeight('blaze'), 1.8); // non mappato → default umanoide
});

test('farm animal classification and feed/crop maps', () => {
  assert.equal(isFarmAnimalType('cow'), true);
  assert.equal(isFarmAnimalType('minecraft:PIG'), true);
  assert.equal(isFarmAnimalType('villager'), false);
  assert.equal(isFarmAnimalType('wolf'), false); // domestico, taming a parte
  assert.equal(isFarmAnimalType('zombie'), false);
  assert.equal(animalFeed('chicken'), 'wheat_seeds');
  assert.equal(animalFeed('cow'), 'wheat');
  assert.equal(animalFeed('pig'), 'carrot');
  assert.equal(animalFeed('villager'), null);
  assert.equal(cropForSeed('wheat_seeds'), 'wheat');
  assert.equal(cropForSeed('minecraft:carrot'), 'carrots');
  assert.equal(cropForSeed('bone'), null);
  assert.equal(isCropBlock('wheat'), true);
  assert.equal(isCropBlock('carrots'), true);
  assert.equal(isCropBlock('stone'), false);
  assert.equal(isFarmlandBlock('farmland'), true);
  assert.equal(isFarmlandBlock('minecraft:farmland'), true);
  assert.equal(isFarmlandBlock('dirt'), false);
  assert.ok(PLANTABLE_ITEMS.includes('wheat_seeds'));
  assert.ok(PLANTABLE_ITEMS.includes('potato'));
});

test('companion classification: food-tame, ride-tame, axolotl/nautilus', () => {
  assert.deepEqual(tameFeed('wolf'), ['bone']);
  // Nomi **server** (Bedrock): `cod`/`salmon`, non i `raw_cod`/`raw_salmon` di Java.
  // Live 03/10: con i nomi Java `tame_cat` rispondeva `missing_feed` avendo 9 salmoni.
  assert.deepEqual(tameFeed('cat'), ['cod', 'salmon']);
  assert.deepEqual(tameFeed('parrot'), ['wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds']);
  assert.deepEqual(tameFeed('horse'), []); // cavalcabile: nessun cibo
  assert.equal(isTameableType('parrot'), true);
  assert.equal(isTameableType('wolf'), true);
  assert.equal(isRideTameableType('horse'), true);
  assert.equal(isRideTameableType('nautilus'), true);
  assert.equal(isRideTameableType('wolf'), false);
  assert.equal(isCompanionType('axolotl'), true);
  assert.equal(isCompanionType('nautilus'), true);
  assert.equal(isCompanionType('parrot'), true);
  assert.equal(isCompanionType('cow'), false);
  assert.equal(isCompanionType('zombie'), false);
});

// Ogni nome nelle tabelle di gioco deve esistere nel registry del server.
// Classe di difetto trovata live il 03/10 (taming impossibile perché la tabella
// usava `raw_cod`/`raw_salmon`, nomi di Java) e offline (`beetroots` invece di
// `beetroot` per la coltura): il registry è l'unica autorità sui nomi.
test('every item and crop-block name in the gameplay tables exists in the Bedrock registry', () => {
  const require = createRequire(import.meta.url);
  const registry = require('prismarine-registry')('bedrock_1.26.51');
  assert.ok(registry, 'registry bedrock_1.26.51 non disponibile');
  const items = new Set([
    ...Object.values(TAME_FEED_MAP).flat(),
    ...Object.values(ANIMAL_FEED_MAP),
    ...FOODS,
    ...LAST_RESORT_FOODS,   // commestibili di ultima istanza: stessi nomi, stessa autorità (il registry)
    ...PLANTABLE_ITEMS,
    ...Object.keys(BUCKET_INGREDIENTS),
    ...Object.keys(SHIELD_INGREDIENTS),
  ]);
  const missingItems = [...items].filter((name) => !registry.itemsByName[name]);
  assert.deepEqual(missingItems, [], `item inesistenti in Bedrock: ${missingItems.join(', ')}`);
  const blocks = new Set([...Object.values(SEED_TO_CROP_MAP), ...Object.keys(CROP_MAX_GROWTH_MAP)]);
  const missingBlocks = [...blocks].filter((name) => !registry.blocksByName[name]);
  assert.deepEqual(missingBlocks, [], `blocchi inesistenti in Bedrock: ${missingBlocks.join(', ')}`);
  assert.equal(items.has('raw_cod'), false, 'raw_cod è un nome Java: in Bedrock è cod');
  assert.equal(blocks.has('beetroots'), false, 'beetroots è un nome Java: in Bedrock è beetroot');
});

test('bestFood prefers cooked food and skips unsafe or precious items', () => {
  assert.equal(bestFood({ cooked_beef: 1, bread: 3 }), 'cooked_beef');
  assert.equal(bestFood({ bread: 1, carrot: 9 }), 'bread');
  assert.equal(bestFood({ carrot: 1, cookie: 2 }), 'carrot');
  assert.equal(bestFood({ rotten_flesh: 5, spider_eye: 1, golden_apple: 1 }), null);
  assert.equal(bestFood({}), null);
  // La patata cruda e' l'ultimo dei cibi SICURI (fame 1, nessun effetto: le
  // fonti di Veleno elencano solo la patata velenosa), quindi batte sempre i
  // commestibili che fanno male.
  assert.equal(bestFood({ potato: 1 }), 'potato');
  assert.equal(bestFood({ potato: 1, carrot: 1 }), 'carrot');
  assert.equal(bestFood({ potato: 2, rotten_flesh: 5 }, { allowLastResort: true }), 'potato',
    "non si rischia la Fame finche' c'e' una patata normale in inventario");
  // Con la fame critica (`allowLastResort`) i commestibili con un effetto
  // collaterale contano, in ordine di «sfama di più, fa meno male»: una fame a
  // zero fa morire, quindi quasi tutto è meglio del nulla.
  assert.equal(bestFood({ rotten_flesh: 1, poisonous_potato: 1 }, { allowLastResort: true }), 'rotten_flesh');
  assert.equal(bestFood({ chicken: 1, spider_eye: 1 }, { allowLastResort: true }), 'chicken');
  assert.equal(bestFood({ poisonous_potato: 1, spider_eye: 1 }, { allowLastResort: true }), 'poisonous_potato');
  // Il pesce palla resta fuori: il suo veleno può uccidere da solo.
  assert.equal(bestFood({ pufferfish: 3 }, { allowLastResort: true }), null);
  assert.equal(bestFood({ spider_eye: 1 }), null, 'un veleno non è mai un pasto normale');
  // E il cibo normale batte comunque l'ultima istanza.
  assert.equal(bestFood({ rotten_flesh: 5, bread: 1 }, { allowLastResort: true }), 'bread');
});

test('time of day estimation advances with real time and detects night', () => {
  const now = 1_000_000;
  assert.equal(estimatedTimeOfDay(13999, now, now), 13999);
  assert.equal(estimatedTimeOfDay(13999, now, now + 50), 14000);
  assert.equal(estimatedTimeOfDay(23999, now, now + 50), 0);
  assert.equal(estimatedTimeOfDay(23000, now - 25 * 1000, now), 23500);
  assert.equal(isNightTime(13000), true);
  assert.equal(isNightTime(18000), true);
  assert.equal(isNightTime(23000), true);
  assert.equal(isNightTime(1000), false);
  assert.equal(isNightTime(6000), false);
  assert.equal(timePhase(13000), 'dusk');
  assert.equal(timePhase(18000), 'night');
  assert.equal(timePhase(23000), 'dawn');
  assert.equal(timePhase(6000), 'day');
});

test('away and rotate directions point opposite the threat', () => {
  const away = awayDirection({ x: 0, z: 0 }, { x: 10, z: 0 });
  assert.ok(Math.abs(away.x + 1) < 1e-9 && Math.abs(away.z) < 1e-9);
  const rotated = rotateDirection({ x: 0, z: 1 }, 90);
  assert.ok(Math.abs(rotated.x + 1) < 1e-9 && Math.abs(rotated.z) < 1e-9);
  const same = awayDirection({ x: 5, z: 5 }, { x: 5, z: 5 });
  assert.equal(Math.hypot(same.x, same.z), 1);
});

// ---- adapter: tracking entità --------------------------------------------------------

function spawnedAdapter () {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.client = new EventEmitter();
  adapter.client.entityId = 7n;
  adapter.client.write = () => {};
  adapter.position = { x: 0, y: 64.62, z: 0 };
  adapter._feet = { x: 0, y: 63, z: 0 };
  // I take/place verso il cursore valgono solo con la finestra del giocatore
  // aperta (`_takeToCursor`), quindi qui la si stubba.
  adapter.openedWindows = 0;
  adapter._ensureInventoryOpen = async () => { adapter.openedWindows++; };
  return adapter;
}

test('add_entity tracks mobs, positions and hostile distance', () => {
  const adapter = spawnedAdapter();
  adapter._trackEntity({ runtime_id: 42n, unique_id: 900n, entity_type: 'minecraft:zombie', position: { x: 3, y: 63, z: 0 } }, 'mob');
  adapter._trackEntity({ runtime_id: 43n, unique_id: 901n, entity_type: 'minecraft:cow', position: { x: 5, y: 63, z: 0 } }, 'mob');
  const nearby = adapter._nearbyEntities(8);
  assert.equal(nearby.length, 2);
  assert.equal(nearby[0].type, 'zombie');
  assert.equal(nearby[0].hostile, true);
  assert.equal(nearby[1].hostile, false);
  const hostiles = adapter._hostiles();
  assert.equal(hostiles.length, 1);
  assert.equal(hostiles[0].type, 'zombie');
  assert.ok(hostiles[0].distance > 2.9 && hostiles[0].distance < 3.2);
});

test('move_entity_delta applies absolute coordinates and removal works by unique id', () => {
  const adapter = spawnedAdapter();
  adapter._trackEntity({ runtime_id: 42n, unique_id: 900n, entity_type: 'zombie', position: { x: 1, y: 63, z: 0 } }, 'mob');
  adapter._onEntityMove({ runtime_entity_id: 42n, x: 4, y: 63, z: 1 });
  assert.deepEqual(adapter.entities.get('42').position, { x: 4, y: 63, z: 1 });
  adapter._onEntityRemove({ entity_id_self: 900n });
  assert.equal(adapter.entities.size, 0);
});

test('entity metadata updates mob health and own sleeping flag', () => {
  const adapter = spawnedAdapter();
  adapter._trackEntity({ runtime_id: 42n, unique_id: 900n, entity_type: 'zombie', position: { x: 3, y: 63, z: 0 } }, 'mob');
  adapter._applyEntityMetadata({ runtime_entity_id: 42n, metadata: [{ key: 'health', value: 12 }] });
  assert.equal(adapter.entities.get('42').health, 12);
  adapter._applyEntityMetadata({ runtime_entity_id: 7n, metadata: [{ key: 'flags', value: { resting: true, sneaking: false } }] });
  assert.equal(adapter.sleeping, true);
  adapter._applyEntityMetadata({ runtime_entity_id: 7n, metadata: [{ key: 'flags', value: { resting: false } }] });
  assert.equal(adapter.sleeping, false);
});

test('numeric metadata flags fall back to the resting bit', () => {
  const adapter = spawnedAdapter();
  const resting = 1n << 23n;
  adapter._applyEntityMetadata({ runtime_entity_id: 7n, metadata: [{ key: 0, value: resting }] });
  assert.equal(adapter.sleeping, true);
  adapter._applyEntityMetadata({ runtime_entity_id: 7n, metadata: [{ key: 0, value: 0n }] });
  assert.equal(adapter.sleeping, false);
});

test('own attributes use the current field for health and hunger', () => {
  const adapter = spawnedAdapter();
  adapter._applyOwnAttributes({ runtime_entity_id: 7n, attributes: [
    { name: 'minecraft:health', current: 15, value: 0 },
    { name: 'minecraft:player.hunger', current: 11, value: 0 },
  ] });
  assert.equal(adapter.health, 15);
  assert.equal(adapter.food, 11);
  // Pacchetto di un'altra entità: ignorato.
  adapter._applyOwnAttributes({ runtime_entity_id: 42n, attributes: [{ name: 'minecraft:player.hunger', current: 3 }] });
  assert.equal(adapter.food, 11);
});

test('bed positions do not mark the bot as sleeping (only the resting flag does)', () => {
  const adapter = spawnedAdapter();
  adapter._applyEntityMetadata({ runtime_entity_id: 7n, metadata: [{ key: 'player_bed_position', value: { x: 92, y: 73, z: 162 } }] });
  assert.equal(adapter.sleeping, false);
  adapter._applyEntityMetadata({ runtime_entity_id: 7n, metadata: [{ key: 'flags', value: { resting: true } }] });
  assert.equal(adapter.sleeping, true);
});

test('death and respawn flip the survival state', () => {
  const adapter = spawnedAdapter();
  adapter.health = 0;
  adapter._onOwnHealth();
  assert.equal(adapter.dead, true);
  assert.equal(adapter.deaths, 1);
  adapter._onRespawnPacket({ state: 1, position: { x: 10, y: 70.62, z: 10 } });
  assert.equal(adapter.dead, false);
  assert.deepEqual(adapter.position, { x: 10, y: 70.62, z: 10 });
  assert.equal(adapter._feet.y, 70.62 - 1.62);
});

test('set_time enables the night estimate in observe', () => {
  const adapter = spawnedAdapter();
  adapter._recordTime(18000);
  const info = adapter._timeInfo();
  assert.equal(info.phase, 'night');
  assert.equal(info.night, true);
  assert.equal(adapter._isNight(), true);
});

test('sync_world_clocks picks the overworld clock and follows sync_state', () => {
  const adapter = spawnedAdapter();
  adapter._onWorldClocks({
    payload_type: 'initialize_registry',
    clocks: [
      { id: 1n, name: 'minecraft:other', time: 1000, paused: false },
      { id: 2n, name: 'minecraft:overworld', time: 8000, paused: false },
    ],
  });
  assert.equal(adapter._worldClockId, '2');
  assert.equal(adapter._timeInfo().phase, 'day');
  adapter._onWorldClocks({ payload_type: 'sync_state', sync_states: [{ clock_id: 2n, time: 14000, paused: false }] });
  assert.equal(adapter._timeInfo().ticks, 14000);
  assert.equal(adapter._isNight(), true);
  // Un sync_state di un altro clock non deve toccare l'ora scelta.
  adapter._onWorldClocks({ payload_type: 'sync_state', sync_states: [{ clock_id: 1n, time: 6000, paused: false }] });
  assert.equal(adapter._timeInfo().ticks, 14000);
});

test('a server respawn packet while dead completes with client_ready and revives', () => {
  const adapter = spawnedAdapter();
  const packets = [];
  adapter.client.write = (name, params) => packets.push({ name, params });
  adapter.health = 0;
  adapter._onOwnHealth();
  assert.equal(adapter.dead, true);
  // state 0 (searching): si risponde client_ready ma non si risorge sulla posizione di morte.
  adapter._onRespawnPacket({ state: 0, position: { x: 83, y: 75, z: 176 } });
  assert.equal(adapter.dead, true, 'state 0 non chiude il respawn');
  assert.equal(packets[0].name, 'respawn');
  assert.equal(packets[0].params.state, 2);
  // state 1 (server ready): posizione finale e stato vivo.
  adapter._onRespawnPacket({ state: 1, position: { x: 90, y: 74.62, z: 150 } });
  assert.equal(adapter.dead, false);
  assert.equal(adapter.position.y, 74.62);
  assert.equal(adapter._feet.y, 74.62 - 1.62);
});

test('respawn fallback closes the death state when state 1 never arrives', () => {
  const adapter = spawnedAdapter();
  adapter.client.write = () => {};
  adapter.health = 0;
  adapter._onOwnHealth();
  adapter._onRespawnPacket({ state: 0, position: { x: 83, y: 75, z: 176 } });
  assert.equal(adapter.dead, true);
  adapter._pendingRespawn.at = Date.now() - 5000;
  adapter._survivalTick();
  assert.equal(adapter.dead, false);
});

test('limbo after a respawn fallback is re-opened until health returns', () => {
  const adapter = spawnedAdapter();
  adapter.client.write = () => {};
  adapter.health = 0;
  adapter._onOwnHealth();
  adapter._onRespawnPacket({ state: 0, position: { x: 83, y: 75, z: 176 } });
  adapter._pendingRespawn.at = Date.now() - 5000;
  adapter._survivalTick();
  assert.equal(adapter.dead, false);
  // Il server non ha mai riportato la vita: dopo 5 s il flusso riparte.
  adapter._limboSince = Date.now() - 6000;
  adapter._survivalTick();
  assert.equal(adapter.dead, true);
  assert.ok(adapter._respawnAt > Date.now(), 'riprogramma il respawn');
  // Quando la vita torna, il limbo si chiude.
  adapter.health = 20;
  adapter._survivalTick();
  assert.equal(adapter._limboSince, null);
});

test('death records the site and offers loot recovery after respawn', () => {
  const adapter = spawnedAdapter();
  adapter.client.write = () => {};
  adapter._feet = { x: 83.2, y: 74, z: 176.4 };
  adapter.position = { x: 83.2, y: 75.62, z: 176.4 };
  adapter.health = 0;
  adapter._onOwnHealth();
  assert.deepEqual(adapter.deathSite.position, { x: 83.2, y: 74, z: 176.4 });
  adapter._onRespawnPacket({ state: 1, position: { x: 70.5, y: 76.62, z: 178.5 } });
  assert.equal(adapter.dead, false);
  adapter.nearbyBlocks = {};
  adapter.drops = [];
  adapter.world.findBlocks = () => [];
  const keys = adapter.options().map(o => o.key);
  assert.ok(keys.includes('recover_loot'), 'offerta di recupero');
  assert.deepEqual(adapter.observe().deathSite.position, { x: 83.2, y: 74, z: 176.4 });
});

test('recover_loot walks to the death site, collects drops and clears it', async () => {
  const adapter = spawnedAdapter();
  adapter.deathSite = { position: { x: 83, y: 74, z: 176 }, at: Date.now(), attempts: 0 };
  adapter.drops = [{ id: 1, item: 'stone_pickaxe', count: 1, position: { x: 83.5, y: 74.5, z: 176.5 } }];
  const moves = [];
  adapter._moveTo = async (target) => { moves.push(target); return { ok: true, distance: 0.2, pathNodes: 3 }; };
  let collected = 0;
  adapter._collectDrop = async () => { collected++; adapter.drops = []; return { ok: true, picked: 1, item: 'stone_pickaxe' }; };
  const result = await adapter._recoverLoot();
  assert.equal(result.ok, true);
  assert.deepEqual(moves[0], { x: 83, y: 74, z: 176 });
  assert.equal(collected, 1);
  assert.deepEqual(result.recovered, ['stone_pickaxe']);
  assert.equal(adapter.deathSite, null, 'sito chiuso quando non resta loot');
});

test('recover_loot keeps the site when the path fails or loot is left', async () => {
  const adapter = spawnedAdapter();
  adapter.deathSite = { position: { x: 83, y: 74, z: 176 }, at: Date.now(), attempts: 0 };
  adapter._moveTo = async () => { throw new Error('path_failed'); };
  const failed = await adapter._recoverLoot();
  assert.equal(failed.ok, false);
  assert.equal(adapter.deathSite.attempts, 1);
  // Loot ancora lì: il sito resta per riprovare.
  adapter._moveTo = async () => ({ ok: true });
  adapter._feet = { x: 83, y: 74, z: 176 };
  adapter.drops = [{ id: 2, item: 'raw_iron', count: 1, position: { x: 83.5, y: 74.5, z: 176.5 } }];
  adapter._collectDrop = async () => ({ ok: false, error: 'item_not_collected' });
  const left = await adapter._recoverLoot();
  assert.equal(left.ok, true);
  assert.equal(left.leftNearby, true);
  assert.ok(adapter.deathSite, 'sito mantenuto');
});

test('experience attributes are tracked and exposed', () => {
  const adapter = spawnedAdapter();
  adapter._applyOwnAttributes({ runtime_entity_id: 7n, attributes: [
    { name: 'minecraft:player.level', current: 5 },
    { name: 'minecraft:player.experience', current: 0.5 },
  ] });
  assert.deepEqual(adapter.observe().experience, { level: 5, progress: 0.5 });
});

test('unsolicited respawn packets do not move the bot', () => {
  const adapter = spawnedAdapter();
  adapter._onRespawnPacket({ position: { x: 0, y: 0, z: 0 } });
  assert.deepEqual(adapter.position, { x: 0, y: 64.62, z: 0 });
  assert.equal(adapter.dead, false);
});

// ---- adapter: options e azioni --------------------------------------------------------

test('options offer attack, flee, eat and sleep when the situation requires it', () => {
  const adapter = spawnedAdapter();
  adapter.nearbyBlocks = {};
  adapter.drops = [];
  adapter.inventory = { bread: 2, cooked_beef: 1 };
  adapter.food = 9;
  adapter._trackEntity({ runtime_id: 42n, unique_id: 900n, entity_type: 'minecraft:zombie', position: { x: 4, y: 63, z: 0 } }, 'mob');
  adapter._recordTime(18000);
  adapter.world.findBlocks = (name) => name === 'bed' ? [{ name: 'bed', position: { x: 2, y: 63, z: 2 }, distance: 3 }] : [];
  const keys = adapter.options().map(o => o.key);
  assert.ok(keys.includes('attack_zombie'), 'attack option');
  assert.ok(keys.includes('flee'), 'flee option');
  assert.ok(keys.includes('eat'), 'eat option');
  assert.ok(keys.includes('sleep'), 'sleep option');
});

test('options collapse to wait while dead or sleeping', () => {
  const adapter = spawnedAdapter();
  adapter.dead = true;
  assert.deepEqual(adapter.options().map(o => o.key), ['wait']);
  adapter.dead = false;
  adapter.sleeping = true;
  assert.deepEqual(adapter.options().map(o => o.key), ['wait']);
});

test('executeAction refuses actions while dead or sleeping', async () => {
  const adapter = spawnedAdapter();
  adapter.dead = true;
  const dead = await adapter.executeAction('mine_stone');
  assert.equal(dead.error, 'dead');
  adapter.dead = false;
  adapter.sleeping = true;
  const sleeping = await adapter.executeAction('eat');
  assert.equal(sleeping.error, 'sleeping');
});

test('attack options are deduped by mob type', () => {
  const adapter = spawnedAdapter();
  adapter.nearbyBlocks = {};
  adapter.drops = [];
  adapter.inventory = {};
  adapter._trackEntity({ runtime_id: 1n, unique_id: 11n, entity_type: 'zombie', position: { x: 5, y: 63, z: 0 } }, 'mob');
  adapter._trackEntity({ runtime_id: 2n, unique_id: 12n, entity_type: 'zombie', position: { x: 6, y: 63, z: 0 } }, 'mob');
  adapter._trackEntity({ runtime_id: 3n, unique_id: 13n, entity_type: 'skeleton', position: { x: 7, y: 63, z: 0 } }, 'mob');
  const attackKeys = adapter.options().map(o => o.key).filter(key => key.startsWith('attack_'));
  assert.deepEqual(attackKeys, ['attack_zombie', 'attack_skeleton']);
});

test('weapon selection prefers sword, then axe, then pickaxe', async () => {
  const adapter = spawnedAdapter();
  adapter.inventorySlots[0] = { network_id: 1, name: 'stone_pickaxe', count: 1, stack_id: 1 };
  adapter.inventorySlots[1] = { network_id: 2, name: 'iron_axe', count: 1, stack_id: 2 };
  adapter.client.write = () => {};
  assert.equal(await adapter._selectWeapon(), 'iron_axe');
  adapter.inventorySlots[2] = { network_id: 3, name: 'wooden_sword', count: 1, stack_id: 3 };
  assert.equal(await adapter._selectWeapon(), 'wooden_sword');
});

test('attack uses an item_use_on_entity transaction with swing animation', () => {
  const adapter = spawnedAdapter();
  const packets = [];
  adapter.client.write = (name, params) => packets.push({ name, params });
  adapter.inventorySlots[0] = { network_id: 10, name: 'wooden_sword', count: 1, stack_id: 3 };
  adapter.selectedHotbar = 0;
  adapter._attackEntity({ type: 'zombie', runtimeId: '42', position: { x: 3, y: 63, z: 0 } });
  const attack = packets.find(p => p.name === 'inventory_transaction');
  assert.equal(attack.params.transaction.transaction_type, 'item_use_on_entity');
  assert.equal(attack.params.transaction.transaction_data.action_type, 'attack');
  assert.equal(attack.params.transaction.transaction_data.entity_runtime_id, 42n);
  assert.equal(attack.params.transaction.transaction_data.click_pos.y, 63 + 1.95 / 2);
  assert.equal(packets.some(p => p.name === 'animate' && p.params.action_id === 'swing_arm'), true);
});

test('combat chases and returns success when the mob dies', async () => {
  const adapter = spawnedAdapter();
  adapter._queueAuthInput = async () => {};
  adapter._selectWeapon = async () => null;
  adapter._moveTo = async () => ({ ok: true });
  let hits = 0;
  adapter._attackEntity = () => {
    hits++;
    if (hits >= 2) {
      const tracked = adapter.entities.get('42');
      tracked.health = 0;
      tracked.deadAt = Date.now();
    }
    return true;
  };
  adapter._trackEntity({ runtime_id: 42n, unique_id: 900n, entity_type: 'zombie', position: { x: 2, y: 63, z: 0 } }, 'mob');
  const result = await adapter._combat('zombie', 3000);
  assert.equal(result.ok, true);
  assert.equal(result.killed, true);
  assert.equal(hits, 2);
});

// Evidenza live 03/10: `attack_chicken` -> `combat_timeout` dopo 33-35 fendenti,
// con i log `attack` che mostravano runtimeId diversi (685 con health 1, poi 679
// con 3, poi 677 con 4): il bersaglio veniva ri-risolto al più vicino a ogni
// fendente, quindi i colpi si spalmavano su più galline e nessuna moriva.
test('combat locks one chicken instead of spreading hits on its neighbours', async () => {
  const adapter = spawnedAdapter();
  adapter._queueAuthInput = async () => {};
  let weaponScans = 0;
  adapter._selectWeapon = async () => { weaponScans++; return null; };
  adapter._moveTo = async () => ({ ok: true });
  adapter._trackEntity({ runtime_id: 679n, unique_id: 901n, entity_type: 'chicken', position: { x: 2, y: 63, z: 0 } }, 'mob');
  adapter._trackEntity({ runtime_id: 685n, unique_id: 902n, entity_type: 'chicken', position: { x: 2.4, y: 63, z: 0.2 } }, 'mob');
  const hitIds = [];
  const neighbourHealth = adapter.entities.get('685').health;
  adapter._attackEntity = (entity) => {
    hitIds.push(String(entity.runtimeId));
    const tracked = adapter.entities.get(String(entity.runtimeId));
    tracked.health = (tracked.health ?? 4) - 1;
    // Il vicino si avvicina: senza il lock diventerebbe il bersaglio successivo.
    adapter.entities.get('679').position = { x: 1.4, y: 63, z: 0 };
    return true;
  };
  const result = await adapter._combat('chicken', 3000);
  assert.equal(result.ok, true);
  assert.equal(result.killed, true);
  assert.equal(result.confirmedBy, 'health');
  assert.deepEqual([...new Set(hitIds)], ['679'], 'stessa gallina per tutti i fendenti');
  assert.equal(hitIds.length, 4, 'una gallina da 4 cuori a mani nude');
  assert.equal(adapter.entities.get('679').health, 0);
  assert.equal(adapter.entities.get('685').health, neighbourHealth, 'il vicino resta illeso');
  assert.equal(weaponScans, 1, 'inventario scandito una volta per scontro');
});

test('combat accepts an entity removal right after a hit as a kill', async () => {
  const adapter = spawnedAdapter();
  adapter._queueAuthInput = async () => {};
  adapter._selectWeapon = async () => null;
  adapter._moveTo = async () => ({ ok: true });
  adapter._trackEntity({ runtime_id: 7n, unique_id: 77n, entity_type: 'chicken', position: { x: 2, y: 63, z: 0 } }, 'mob');
  adapter._attackEntity = () => {
    adapter.entities.delete('7');
    return true;
  };
  const result = await adapter._combat('chicken', 3000);
  assert.equal(result.ok, true);
  assert.equal(result.killed, true);
  assert.equal(result.confirmedBy, 'entity_removed');
  assert.equal(result.hits, 1);
});

test('combat does not claim a kill when the mob disappears long after the last hit', async () => {
  const adapter = spawnedAdapter();
  adapter._queueAuthInput = async () => {};
  adapter._selectWeapon = async () => null;
  adapter._trackEntity({ runtime_id: 42n, unique_id: 900n, entity_type: 'zombie', position: { x: 2, y: 63, z: 0 } }, 'mob');
  adapter._attackEntity = (entity) => {
    // Il mob fugge oltre il raggio di osservazione senza morire.
    adapter.entities.get(String(entity.runtimeId)).position = { x: 9, y: 63, z: 0 };
    return true;
  };
  let chases = 0;
  adapter._moveTo = async () => {
    chases++;
    if (chases === 3) adapter.entities.delete('42');
    await new Promise(resolve => setTimeout(resolve, 1000));
    return { ok: true };
  };
  const result = await adapter._combat('zombie', 20000);
  assert.equal(result.killed, undefined, 'nessuna uccisione dichiarata');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'target_lost');
  assert.equal(result.hits, 1);
  assert.equal(chases, 3);
});

test('combat reports target_gone when nothing of that type is tracked', async () => {
  const adapter = spawnedAdapter();
  const result = await adapter._combat('chicken', 500);
  assert.deepEqual(result, { ok: false, error: 'target_gone', hits: 0 });
});

test('eat uses a click_air item use transaction and confirms on hunger rise', async () => {
  const adapter = spawnedAdapter();
  adapter.food = 12;
  adapter.inventory = { cooked_beef: 2 };
  adapter.inventorySlots[0] = { network_id: 10, name: 'cooked_beef', count: 2, stack_id: 3 };
  const transactions = [];
  adapter._queueAuthInput = async (input) => {
    transactions.push(input);
    adapter.food = 18; // il server conferma subito
  };
  const result = await adapter._eat(1000);
  assert.equal(result.ok, true);
  assert.equal(result.item, 'cooked_beef');
  assert.equal(transactions[0].transaction.data.action_type, 'click_air');
  assert.equal(transactions[0].transaction.data.face, 255);
});

test('eat reports missing food without touching the client', async () => {
  const adapter = spawnedAdapter();
  const result = await adapter._eat(1000);
  assert.deepEqual(result, { ok: false, error: 'no_food' });
});

test('flee picks a standable point away from the threat and walks there', async () => {
  const adapter = spawnedAdapter();
  adapter._trackEntity({ runtime_id: 42n, unique_id: 900n, entity_type: 'zombie', position: { x: -4, y: 63, z: 0 } }, 'mob');
  adapter._standableNear = point => ({ x: point.x, y: adapter._feet.y, z: point.z });
  let target = null;
  adapter._moveTo = async (point) => { target = point; return { ok: true }; };
  const result = await adapter._flee(5000);
  assert.equal(result.ok, true);
  assert.equal(result.from, 'zombie');
  assert.ok(target.x > adapter._feet.x, 'si allontana dal mob a ovest');
});

test('flee counts a timeout as success when it still gains distance', async () => {
  const adapter = spawnedAdapter();
  adapter._trackEntity({ runtime_id: 42n, unique_id: 900n, entity_type: 'zombie', position: { x: -4, y: 63, z: 0 } }, 'mob');
  adapter._standableNear = point => ({ x: point.x, y: adapter._feet.y, z: point.z });
  adapter._moveTo = async () => {
    adapter._feet.x += 10;
    adapter._syncPositionFromFeet();
    throw new Error('movement timeout');
  };
  const result = await adapter._flee(5000);
  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
});

function loadedSleepBed (adapter) {
  const bed = { name: 'bed', position: { x: 0, y: 63, z: 2 }, distance: 2, boundingBox: 'empty' };
  adapter.world.findBlocks = name => name === 'bed' ? [bed] : [];
  adapter.world.blockAt = ({ x, y, z }) => x === 0 && y === 63 && z === 2 ? bed
    : y === 62 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' };
}

test('sleepInBed reports success when the night is skipped (fast-forward)', async () => {
  const adapter = spawnedAdapter();
  adapter._recordTime(18000);
  loadedSleepBed(adapter);
  let inputs = 0;
  adapter._queueAuthInput = async () => {
    inputs++;
    if (inputs >= 2) adapter._recordTime(200); // il server salta la notte al click
  };
  const result = await adapter._sleepInBed({ confirmMs: 300 });
  assert.equal(result.ok, true);
  assert.equal(result.slept, 'night_skipped');
});

test('sleepInBed clicks the bed and reports the rejection when sleep does not start', async () => {
  const adapter = spawnedAdapter();
  adapter._recordTime(18000);
  loadedSleepBed(adapter);
  adapter._queueAuthInput = async () => {};
  const result = await adapter._sleepInBed({ confirmMs: 10 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'sleep_rejected');
});

// ---- difesa: go_home/retreat, torce e spade -------------------------------------------

test('go_home is offered when home is set and the bot is far away', () => {
  const adapter = spawnedAdapter();
  adapter.nearbyBlocks = {};
  adapter.drops = [];
  adapter.inventory = {};
  adapter.world.findBlocks = () => [];
  adapter.home = { x: 90, y: 74, z: 163 };
  adapter.position = { x: 120, y: 74, z: 200 };
  const keys = adapter.options().map(o => o.key);
  assert.ok(keys.includes('go_home'), 'go_home option');
  adapter.position = { x: 90, y: 74, z: 163 };
  assert.ok(!adapter.options().map(o => o.key).includes('go_home'), 'non offerta se già a casa');
});

test('go_home walks to the home waypoint and reports the distance', async () => {
  const adapter = spawnedAdapter();
  adapter.home = { x: 90, y: 74, z: 163 };
  adapter.position = { x: 100, y: 74, z: 163 };
  const moves = [];
  adapter._moveTo = async (target, radius, timeout) => { moves.push({ target, radius, timeout }); adapter.position = { x: 90, y: 74, z: 163 }; return { ok: true, distance: 0.5, pathNodes: 3 }; };
  const result = await adapter._goHome();
  assert.equal(result.ok, true);
  assert.deepEqual(moves[0].target, { x: 90, y: 74, z: 163 });
  assert.equal(result.distance, 0);
});

test('go_home fails cleanly without a home waypoint', async () => {
  const adapter = spawnedAdapter();
  adapter.home = null;
  const result = await adapter._goHome();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no_home');
});

test('retreat dispatches to _goHome', async () => {
  const adapter = spawnedAdapter();
  adapter.home = { x: 90, y: 74, z: 163 };
  adapter.position = { x: 100, y: 74, z: 163 };
  let called = 0;
  adapter._goHome = async () => { called++; return { ok: true }; };
  const result = await adapter.executeAction('retreat');
  assert.equal(result.ok, true);
  assert.equal(called, 1);
});

test('place_torch is offered when a torch is held', () => {
  const adapter = spawnedAdapter();
  adapter.nearbyBlocks = {};
  adapter.drops = [];
  adapter.inventory = { torch: 4 };
  adapter.world.findBlocks = () => [];
  const keys = adapter.options().map(o => o.key);
  assert.ok(keys.includes('place_torch'), 'place_torch option');
});

test('sword crafting options are offered with materials and a crafting table', () => {
  const adapter = spawnedAdapter();
  adapter.nearbyBlocks = {};
  adapter.drops = [];
  adapter.inventory = { oak_planks: 3, cobblestone: 2, stick: 1 };
  adapter.recipes = new Map([['wooden_sword', [{ kind: 'shaped', network_id: 1 }]], ['stone_sword', [{ kind: 'shaped', network_id: 2 }]]]);
  adapter.craftingData = { shaped_recipes: [], shapeless_recipes: [] };
  adapter.world.findBlocks = (name) => name === 'crafting_table' ? [{ name: 'crafting_table', position: { x: 1, y: 63, z: 1 }, distance: 1 }] : [];
  const keys = adapter.options().map(o => o.key);
  assert.ok(keys.includes('craft_wooden_sword'), 'wooden sword option');
  assert.ok(keys.includes('craft_stone_sword'), 'stone sword option');
});

// ---- difesa: armatura e porte ---------------------------------------------------------

test('armor slot mapping classifies helmet/chest/leggings/boots', () => {
  const adapter = spawnedAdapter();
  assert.equal(adapter._armorSlotFor('iron_helmet'), 0);
  assert.equal(adapter._armorSlotFor('diamond_chestplate'), 1);
  assert.equal(adapter._armorSlotFor('golden_leggings'), 2);
  assert.equal(adapter._armorSlotFor('leather_boots'), 3);
  assert.equal(adapter._armorSlotFor('turtle_helmet'), 0);
  assert.equal(adapter._armorSlotFor('elytra'), 1);
  assert.equal(adapter._armorSlotFor('stone_sword'), -1);
  assert.equal(adapter._armorSlotFor(null), -1);
});

test('equip_armor is offered only when armor pieces are in the inventory', () => {
  const adapter = spawnedAdapter();
  adapter.nearbyBlocks = {};
  adapter.drops = [];
  adapter.inventory = { iron_chestplate: 1, bread: 2 };
  adapter.world.findBlocks = () => [];
  assert.ok(adapter.options().map(o => o.key).includes('equip_armor'), 'equip_armor option');
  adapter.inventory = { bread: 2 };
  assert.ok(!adapter.options().map(o => o.key).includes('equip_armor'), 'non offerta senza armatura');
});

test('close_door is offered only when an open door is nearby', () => {
  const adapter = spawnedAdapter();
  adapter.nearbyBlocks = {};
  adapter.drops = [];
  adapter.inventory = {};
  adapter.world.findBlocks = () => [];
  assert.ok(!adapter.options().map(o => o.key).includes('close_door'), 'non offerta senza porte aperte');
  adapter._openDoors.add('2,63,1');
  assert.ok(adapter.options().map(o => o.key).includes('close_door'), 'close_door option');
});

test('_closeDoorTarget picks the nearest open door within 8 blocks', () => {
  const adapter = spawnedAdapter();
  adapter._openDoors.add('20,63,0');
  adapter._openDoors.add('3,63,0');
  const target = adapter._closeDoorTarget();
  assert.deepEqual([target.x, target.y, target.z], [3, 63, 0]);
  assert.ok(target.distance < 4, 'distanza verso la porta più vicina');
});

test('_equipArmor takes from inventory and places into the armor slot', async () => {
  const adapter = spawnedAdapter();
  adapter.inventorySlots[5] = { network_id: 200, name: 'iron_chestplate', count: 1, stack_id: 7 };
  const actions = [];
  adapter._sendStackRequest = async (acts) => { actions.push(acts); return { status: 'ok', containers: [] }; };
  const result = await adapter._equipArmor();
  assert.equal(result.ok, true);
  assert.deepEqual(result.equipped, [{ item: 'iron_chestplate', slot: 1 }]);
  assert.equal(adapter.openedWindows, 1, 'la finestra del giocatore è aperta prima del take');
  assert.equal(actions.length, 2);
  assert.equal(actions[0][0].destination.slot_type.container_id, 'cursor');
  assert.equal(actions[1][0].destination.slot_type.container_id, 'armor');
  assert.equal(actions[1][0].destination.slot, 1);
});

test('_closeDoor clicks the door and clears it from the open set', async () => {
  const adapter = spawnedAdapter();
  adapter._openDoors.add('2,63,1');
  adapter._moveTo = async () => ({ ok: true });
  adapter.world.runtimeIdAt = () => 5;
  let clicked = null;
  adapter._queueAuthInput = async (input) => { clicked = input; };
  const result = await adapter._closeDoor();
  assert.equal(result.ok, true);
  assert.ok(clicked.transaction, 'click_block inviato');
  assert.equal(adapter._openDoors.size, 0, 'porta rimossa da _openDoors');
});

// ---- difesa: armor points e barricade -------------------------------------------------

test('_armorPoints sums vanilla points per piece', () => {
  const adapter = spawnedAdapter();
  adapter.armor = { helmet: 'iron_helmet', chestplate: 'iron_chestplate', leggings: null, boots: 'iron_boots' };
  assert.equal(adapter._armorPoints(), 2 + 6 + 2);
  adapter.armor = { helmet: 'diamond_helmet', chestplate: 'diamond_chestplate', leggings: 'diamond_leggings', boots: 'diamond_boots' };
  assert.equal(adapter._armorPoints(), 3 + 8 + 6 + 3);
  adapter.armor = { helmet: null, chestplate: null, leggings: null, boots: null };
  assert.equal(adapter._armorPoints(), 0);
});

test('observe exposes the worn armor pieces and points', () => {
  const adapter = spawnedAdapter();
  adapter.armor = { helmet: 'diamond_helmet', chestplate: null, leggings: null, boots: null };
  assert.deepEqual(adapter.observe().armor, { helmet: 'diamond_helmet', chestplate: null, leggings: null, boots: null, points: 3 });
});

test('_equipArmor records the worn piece after a successful place', async () => {
  const adapter = spawnedAdapter();
  adapter.inventorySlots[4] = { network_id: 210, name: 'iron_leggings', count: 1, stack_id: 9 };
  adapter._sendStackRequest = async () => ({ status: 'ok', containers: [] });
  await adapter._equipArmor();
  assert.equal(adapter.armor.leggings, 'iron_leggings');
});

test('_placeableBlock prefers cobblestone then dirt', () => {
  const adapter = spawnedAdapter();
  adapter.inventory = { dirt: 5, cobblestone: 2 };
  assert.equal(adapter._placeableBlock(), 'cobblestone');
  adapter.inventory = { dirt: 5 };
  assert.equal(adapter._placeableBlock(), 'dirt');
  adapter.inventory = { bread: 1 };
  assert.equal(adapter._placeableBlock(), null);
});

test('_barricadeGap finds a 1x2 opening flanked by solid walls', () => {
  const adapter = spawnedAdapter();
  adapter._solidAt = (x, y, z) => {
    if (x === 1 && y === 62 && z === 0) return true; // floor
    if (x === 1 && y === 63 && (z === 1 || z === -1)) return true; // flanking walls
    return false;
  };
  adapter._airAt = (x, y, z) => !adapter._solidAt(x, y, z);
  const gap = adapter._barricadeGap();
  assert.deepEqual(gap.feet, { x: 1, y: 63, z: 0 });
  assert.deepEqual(gap.head, { x: 1, y: 64, z: 0 });
  assert.deepEqual(gap.support, { x: 1, y: 62, z: 0 });
});

test('_barricade places blocks at feet then head', async () => {
  const adapter = spawnedAdapter();
  adapter._placeableBlock = () => 'dirt';
  adapter._barricadeGap = () => ({ feet: { x: 1, y: 63, z: 0 }, head: { x: 1, y: 64, z: 0 }, support: { x: 1, y: 62, z: 0 } });
  const calls = [];
  adapter._placeAtCell = async (_item, block, target, support, face) => { calls.push({ target, support, face }); return { ok: true, block }; };
  const result = await adapter._barricade();
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { target: { x: 1, y: 63, z: 0 }, support: { x: 1, y: 62, z: 0 }, face: 1 });
  assert.deepEqual(calls[1], { target: { x: 1, y: 64, z: 0 }, support: { x: 1, y: 63, z: 0 }, face: 1 });
});

test('barricade is offered only with a placeable block and a gap', () => {
  const adapter = spawnedAdapter();
  adapter.nearbyBlocks = {};
  adapter.drops = [];
  adapter.world.findBlocks = () => [];
  adapter._solidAt = (x, y, z) => (x === 1 && y === 62 && z === 0) || (x === 1 && y === 63 && (z === 1 || z === -1));
  adapter._airAt = (x, y, z) => !adapter._solidAt(x, y, z);
  adapter.inventory = { cobblestone: 3 };
  assert.ok(adapter.options().map(o => o.key).includes('barricade'), 'barricade option');
  adapter.inventory = {};
  assert.ok(!adapter.options().map(o => o.key).includes('barricade'), 'non offerta senza blocco piazzabile');
});

// ---- travel kit: letto e readiness ----------------------------------------------------

test('craft_bed and place_bed are offered with the right materials', () => {
  const adapter = spawnedAdapter();
  adapter.nearbyBlocks = {};
  adapter.drops = [];
  adapter.inventory = { white_wool: 3, oak_planks: 3 };
  adapter.recipes = new Map([['bed', [{ kind: 'shaped', network_id: 1 }]]]);
  adapter.craftingData = { shaped_recipes: [], shapeless_recipes: [] };
  adapter.world.findBlocks = (name) => name === 'crafting_table' ? [{ name: 'crafting_table', position: { x: 1, y: 63, z: 1 }, distance: 1 }] : [];
  assert.ok(adapter.options().map(o => o.key).includes('craft_bed'), 'craft_bed option');
  adapter.inventory = { bed: 1 };
  adapter.world.findBlocks = () => [];
  assert.ok(adapter.options().map(o => o.key).includes('place_bed'), 'place_bed option');
});

test('_travelReadiness flags what is missing for a trip', () => {
  const adapter = spawnedAdapter();
  assert.equal(adapter._travelReadiness().ready, false);
  assert.ok(adapter._travelReadiness().missing.includes('food'));
  adapter.inventory = { cooked_beef: 2, wooden_sword: 1, cobblestone: 32, torch: 4, bed: 1, crafting_table: 1 };
  adapter.armor = { helmet: 'iron_helmet', chestplate: null, leggings: null, boots: null };
  adapter.inventorySlots = new Array(36).fill(undefined);
  const ready = adapter._travelReadiness();
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.missing, []);
  // letto assente ma lana a sufficienza → `night` soddisfatto lo stesso
  adapter.inventory = { cooked_beef: 1, stone_sword: 1, dirt: 8, torch: 1, white_wool: 3, crafting_table: 1 };
  assert.ok(adapter._travelReadiness().items.night);
  assert.ok(!adapter._travelReadiness().missing.includes('night'));
});

test('the event name survives a payload `type` (log entries stay greppable)', () => {
  const entries = [];
  const adapter = new BedrockAdapter({ logger: { log () {} }, onLog: (entry) => entries.push(entry) });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.client = new EventEmitter();
  adapter.client.entityId = 7n;
  adapter.client.write = () => {};
  adapter.position = { x: 0, y: 64.62, z: 0 };
  adapter._trackEntity({ runtime_id: 42n, unique_id: 900n, entity_type: 'minecraft:zombie', position: { x: 3, y: 63, z: 0 } }, 'mob');
  adapter._onEntityEvent({ runtime_entity_id: '42', event_id: 'death_animation' });
  const added = entries.find(e => e.type === 'entity_add');
  const died = entries.find(e => e.type === 'entity_death');
  assert.ok(added, 'entity_add resta entity_add');
  assert.equal(added.entityType, 'zombie', 'il tipo dell entità va in entityType');
  assert.ok(died, 'entity_death resta entity_death');
  assert.equal(died.entityType, 'zombie');
  assert.equal(entries.some(e => e.type === 'zombie'), false, 'nessuna voce intitolata al tipo di entità');
});
