import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { BedrockAdapter } from '../bedrock-adapter.mjs';
import { campfireLit, honeyLevel, hiveVerdict, beeFlower, isBeeProtected } from '../bedrock-bees.mjs';
import { optionIntents } from '../survival/intents.mjs';
import { optionPriority } from '../controller-decisions.mjs';

const hivePosition = { x: 2, y: 64, z: 0 };
const key = p => `${p.x},${p.y},${p.z}`;

function fixture (tool = 'shears') {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.client = new EventEmitter();
  adapter.client.entityId = 7n;
  adapter.client.write = () => {};
  adapter.position = { x: 0, y: 64.62, z: 0 };
  adapter._feet = { x: 0, y: 63, z: 0 };
  adapter.inventory = { [tool]: 1 };
  adapter.inventorySlots = [{ name: tool, network_id: 10, count: 1, stack_id: 1 }];
  adapter._selectHotbarSlot = slot => { adapter.selectedHotbar = slot; };
  const hive = { name: 'bee_nest', position: { ...hivePosition }, states: { honey_level: 5 } };
  const fire = { name: 'campfire', states: { extinguished: 0 } };
  const cells = new Map([[key(hivePosition), hive], ['2,63,0', fire]]);
  adapter.world.blockAt = p => cells.get(key(p)) ?? { name: 'air', boundingBox: 'empty' };
  adapter.world.findBlocks = names => (Array.isArray(names) ? names : [names]).includes(hive.name) ? [hive] : [];
  adapter.world.runtimeIdAt = () => 42;
  const clicks = [];
  adapter._queueAuthInput = async packet => { if (packet.transaction) clicks.push(packet.transaction); };
  return { adapter, hive, fire, cells, clicks };
}

function addBee (adapter, id = '300', extra = {}) {
  adapter.entities.set(id, { runtimeId: id, type: 'bee', kind: 'mob',
    position: { x: 1, y: 64, z: 1 }, baby: false, angry: false, inlove: false, ...extra });
}

test('hive state parsing rejects missing, malformed and out-of-range honey', () => {
  for (const value of [null, undefined, true, '5', -1, 6, 1.5, NaN]) {
    assert.equal(honeyLevel({ name: 'beehive', states: { honey_level: value } }), null);
  }
  assert.equal(honeyLevel({ name: 'minecraft:beehive', getProperties: () => ({ honey_level: 5 }) }), 5);
  assert.equal(honeyLevel({ name: 'bee_nest', states: { honey_level: { value: 3 } } }), 3);
  assert.equal(honeyLevel({ name: 'stone', states: { honey_level: 5 } }), null);
});

test('real Bedrock registry hive and campfire states drive the safety gate', () => {
  const require = createRequire(import.meta.url);
  const registry = require('prismarine-registry')('bedrock_1.26.51');
  const Block = require('prismarine-block')(registry);
  for (const name of ['beehive', 'bee_nest', 'campfire', 'soul_campfire']) {
    const data = registry.blocksByName[name];
    let full = 0; let lit = 0; let unlit = 0;
    for (let stateId = data.minStateId; stateId <= data.maxStateId; stateId++) {
      const block = Block.fromStateId(stateId, 0);
      block.position = hivePosition;
      if (name.includes('campfire')) {
        assert.equal(typeof campfireLit(block), 'boolean');
        campfireLit(block) ? lit++ : unlit++;
      } else {
        assert.equal(typeof honeyLevel(block), 'number');
        if (honeyLevel(block) === 5) {
          full++;
          assert.equal(hiveVerdict(block, () => Block.fromStateId(registry.blocksByName.campfire.minStateId, 0)).safe, true);
        }
      }
    }
    if (name.includes('campfire')) assert.ok(lit > 0 && unlit > 0);
    else assert.ok(full > 0);
  }
});

test('smoke requires a known lit campfire and only air in the supported gap', () => {
  const { hive } = fixture();
  const fire = { name: 'soul_campfire', states: { extinguished: false } };
  assert.equal(hiveVerdict(hive, p => p.y === 63 ? { name: 'air' } : fire).safe, true);
  for (const name of ['stone', 'glass', 'oak_trapdoor', 'white_carpet', 'water', 'unknown']) {
    assert.equal(hiveVerdict(hive, p => p.y === 63 ? { name } : fire).safe, false, name);
  }
  assert.equal(hiveVerdict(hive, () => null).reason, 'smoke_unknown');
  assert.equal(hiveVerdict(hive, () => ({ name: 'campfire', states: { lit: true } })).reason, 'smoke_unknown');
  assert.equal(hiveVerdict(hive, () => ({ name: 'campfire', states: { extinguished: 1 } })).reason, 'campfire_unlit');
  assert.equal(hiveVerdict(hive, () => ({ name: 'air' })).reason, 'no_safe_campfire');
  hive.states.honey_level = 4;
  assert.equal(hiveVerdict(hive, () => fire).reason, 'hive_not_full');
});

test('options and census follow fresh honey/fire state with cached discovery', () => {
  const { adapter, hive, fire } = fixture();
  adapter.inventory.glass_bottle = 1;
  const keys = () => adapter.options().map(o => o.key);
  assert.ok(keys().includes('harvest_honeycomb'));
  assert.ok(keys().includes('harvest_honey'));
  assert.equal(adapter.observe().bees.hives[0].honeyLevel, 5);
  hive.states.honey_level = 4;
  assert.ok(!keys().includes('harvest_honeycomb'));
  hive.states.honey_level = 5;
  fire.states.extinguished = 1;
  assert.ok(!keys().includes('harvest_honey'));
  fire.states.extinguished = 0;
  addBee(adapter, '300', { angry: true });
  assert.ok(!keys().includes('harvest_honeycomb'));
});

test('explicit harvest refuses absent tools, unknown product and unsafe hives without packets', async () => {
  const { adapter, hive, clicks } = fixture();
  assert.equal((await adapter._harvestHoney('wax')).error, 'unknown_hive_product');
  assert.equal((await adapter._harvestHoney('honey_bottle')).error, 'missing_hive_tool');
  hive.states = {};
  assert.equal((await adapter.executeAction('harvest_honeycomb')).error, 'no_safe_hive');
  assert.equal(clicks.length, 0);
});

test('harvest rechecks an extinguished fire after equip and sends no transaction', async () => {
  const { adapter, fire, clicks } = fixture();
  const equip = adapter._equipItemInHotbar.bind(adapter);
  adapter._equipItemInHotbar = async (item, opts) => {
    assert.equal(opts.resync, false);
    const result = await equip(item, opts);
    fire.states.extinguished = 1;
    return result;
  };
  assert.equal((await adapter._harvestHoney('honeycomb')).error, 'campfire_unlit');
  assert.equal(clicks.length, 0);
});

test('harvest cannot click a hive behind a wall or an unreadable ray', async () => {
  for (const block of [{ name: 'stone', boundingBox: 'block' }, null]) {
    const { adapter, clicks } = fixture();
    const read = adapter.world.blockAt;
    adapter.world.blockAt = p => p.x === 1 && p.y === 64 ? block : read(p);
    assert.ok(!adapter.options().some(o => o.key === 'harvest_honeycomb'));
    assert.equal((await adapter._harvestHoney('honeycomb')).error, 'no_safe_hive');
    assert.equal(clicks.length, 0);
  }
});

test('honeycomb harvest uses one main-hand click_block and confirms reset plus inventory', async () => {
  const { adapter, hive, clicks } = fixture();
  const queue = adapter._queueAuthInput;
  adapter._queueAuthInput = async packet => {
    await queue(packet);
    if (packet.transaction) { hive.states.honey_level = 0; adapter.inventory.honeycomb = 3; }
  };
  const result = await adapter.executeAction('harvest_honeycomb');
  assert.equal(result.ok, true);
  assert.equal(result.collected, 3);
  assert.equal(result.confirmedBy, 'hive_reset_and_inventory');
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].data.action_type, 'click_block');
  assert.equal(clicks[0].data.hand, 'main_hand');
  assert.deepEqual(clicks[0].data.block_position, hivePosition);
  assert.equal(clicks[0].data.held_item.name, 'shears');
});

test('honeycomb drop evidence reports harvest separately from pickup', async () => {
  const { adapter, hive } = fixture();
  adapter._queueAuthInput = async packet => {
    if (packet.transaction) {
      hive.states.honey_level = 0;
      adapter.drops.push({ id: 'new', item: 'honeycomb', count: 3, position: hivePosition });
    }
  };
  const result = await adapter._harvestHoney('honeycomb');
  assert.equal(result.ok, true);
  assert.equal(result.collected, 0);
  assert.equal(result.dropped, 3);
  assert.equal(result.nextAction, 'collect_drop');
});

test('reset alone, an old drop, a distant new drop and an unrelated inventory gain do not prove harvest', async () => {
  for (const evidence of ['reset', 'old', 'distant', 'inventory']) {
    const { adapter, hive, clicks } = fixture();
    const drop = { id: 'old', item: 'honeycomb', count: 3, position: hivePosition };
    if (evidence === 'old') adapter.drops.push(drop);
    const queue = adapter._queueAuthInput;
    adapter._queueAuthInput = async packet => {
      await queue(packet);
      if (!packet.transaction) return;
      if (evidence !== 'inventory') hive.states.honey_level = 0;
      else adapter.inventory.honeycomb = 3;
      if (evidence === 'distant') adapter.drops.push({ ...drop, id: 'new', position: { x: 15, y: 64, z: 0 } });
    };
    assert.equal((await adapter._harvestHoney('honeycomb', 50)).error, 'hive_harvest_not_confirmed', evidence);
    assert.equal(clicks.length, 1);
  }
});

test('bottling requires honey bottle gain and glass bottle consumption', async () => {
  for (const conversion of [false, true]) {
    const { adapter } = fixture('glass_bottle');
    adapter._queueAuthInput = async packet => {
      if (packet.transaction) {
        adapter.inventory.honey_bottle = 1;
        if (conversion) adapter.inventory.glass_bottle = 0;
      }
    };
    const result = await adapter._harvestHoney('honey_bottle', 50);
    assert.equal(result.ok, conversion);
    if (conversion) assert.equal(result.confirmedBy, 'bottle_conversion');
  }
});

test('a disconnected session is never treated as a confirmed harvest', async () => {
  const { adapter, hive } = fixture();
  adapter._queueAuthInput = async packet => {
    if (packet.transaction) {
      hive.states.honey_level = 0;
      adapter.inventory.honeycomb = 3;
      adapter.status = 'disconnected';
    }
  };
  const result = await adapter._harvestHoney('honeycomb');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'not_connected');
  assert.equal(result.interactionSent, true);
});

test('a hive emptied during approach is not harvested using stale options', async () => {
  const { adapter, hive, cells, clicks } = fixture();
  cells.delete(key(hivePosition)); cells.delete('2,63,0');
  hive.position = { x: 10, y: 64, z: 0 };
  cells.set(key(hive.position), hive);
  cells.set('10,63,0', { name: 'campfire', states: { extinguished: 0 } });
  adapter._moveTo = async () => { adapter.position.x = 8; hive.states.honey_level = 0; };
  assert.equal((await adapter._harvestHoney('honeycomb')).error, 'hive_not_full');
  assert.equal(clicks.length, 0);
});

test('hives and campfires stay protected through explicit mining as well as options', async () => {
  const { adapter, clicks } = fixture();
  for (const name of ['beehive', 'bee_nest', 'campfire', 'soul_campfire']) {
    assert.equal(isBeeProtected(name), true);
    const block = { name, position: hivePosition, distance: 2 };
    adapter.world.blockAt = () => block;
    adapter.world.findBlocks = () => [block];
    adapter.nearbyBlocks = { [name]: [block] };
    assert.ok(!adapter.options().some(o => o.key === `mine_${name}`));
    assert.equal((await adapter.executeAction(`mine_${name}`)).error, 'bee_block_protected');
    assert.equal((await adapter._mineBlock(block)).error, 'bee_block_protected');
  }
  assert.equal(clicks.length, 0);
});

test('bee feeding accepts supported flowers and confirms a single consumed flower', async () => {
  const { adapter } = fixture('dandelion');
  addBee(adapter);
  assert.equal(beeFlower({ wither_rose: 2, wheat: 3 }), null);
  assert.ok(adapter.options().some(o => o.key === 'feed_bee'));
  let interactions = 0;
  adapter._interactEntity = () => { interactions++; adapter.inventory.dandelion--; };
  const result = await adapter.executeAction('feed_bee');
  assert.equal(result.ok, true);
  assert.equal(result.confirmedBy, 'flower_consumed');
  assert.equal(interactions, 1);
});

test('feeding refuses angry, already in love, distant and occluded bees', async () => {
  for (const state of ['angry', 'inlove', 'distant', 'wall']) {
    const { adapter, cells } = fixture('poppy');
    addBee(adapter);
    const bee = adapter.entities.get('300');
    if (state === 'angry' || state === 'inlove') bee[state] = true;
    if (state === 'distant') bee.position.x = 12;
    if (state === 'wall') cells.set('0,64,0', { name: 'stone', boundingBox: 'block' });
    let interactions = 0;
    adapter._interactEntity = () => { interactions++; };
    assert.equal((await adapter._feedBee()).ok, false, state);
    assert.equal(interactions, 0);
  }
});

test('feeding rechecks bee anger after the look tick', async () => {
  const { adapter } = fixture('poppy');
  addBee(adapter);
  adapter._queueAuthInput = async () => { adapter.entities.get('300').angry = true; };
  let interactions = 0;
  adapter._interactEntity = () => { interactions++; };
  assert.equal((await adapter._feedBee()).error, 'bee_angry');
  assert.equal(interactions, 0);
});

test('an ignored bee feed times out after one interaction without declaring success', async () => {
  const { adapter } = fixture('poppy');
  addBee(adapter);
  let interactions = 0;
  adapter._interactEntity = () => { interactions++; };
  assert.equal((await adapter._feedBee(null, 50)).error, 'bee_feed_not_confirmed');
  assert.equal(interactions, 1);
});

test('breeding refuses insufficient flowers, one adult and a separated pair', async () => {
  const { adapter } = fixture('poppy');
  addBee(adapter);
  assert.equal((await adapter._breedBees()).error, 'need_2_bee_flowers');
  adapter.inventory.poppy = 2;
  assert.equal((await adapter._breedBees()).error, 'need_2_adult_bees');
  addBee(adapter, '301', { position: { x: -3, y: 64, z: -1 } });
  assert.equal((await adapter._breedBees()).error, 'need_2_adult_bees');
  assert.ok(!adapter.options().some(o => o.key === 'breed_bee'));
});

test('breeding stops when the session changes after the first feed', async () => {
  const { adapter } = fixture('poppy');
  adapter.inventory.poppy = 2;
  addBee(adapter, '300'); addBee(adapter, '301');
  let fed = 0;
  adapter._feedBee = async () => { fed++; adapter.client = new EventEmitter(); return { ok: true, fed: 'bee' }; };
  assert.equal((await adapter._breedBees()).error, 'not_connected');
  assert.equal(fed, 1);
});

test('breeding supports mixed flowers and requires a newly observed nearby baby', async () => {
  const { adapter } = fixture('poppy');
  adapter.inventory.dandelion = 1;
  adapter.inventorySlots.push({ name: 'dandelion', network_id: 11, count: 1 });
  addBee(adapter, '300');
  addBee(adapter, '301', { position: { x: 1.5, y: 64, z: 1 } });
  addBee(adapter, 'old_baby', { baby: true });
  let interactions = 0;
  adapter._interactEntity = bee => {
    interactions++;
    bee.inlove = true;
    adapter.inventory[adapter.inventorySlots[adapter.selectedHotbar].name]--;
    if (interactions === 2) addBee(adapter, 'new_baby', { baby: true });
  };
  assert.ok(adapter.options().some(o => o.key === 'breed_bee'));
  const result = await adapter.executeAction('breed_bee');
  assert.equal(result.ok, true);
  assert.equal(result.baby.runtimeId, 'new_baby');
  assert.equal(interactions, 2);
});

test('two fed adults and an existing baby do not count as successful breeding', async () => {
  const { adapter } = fixture('poppy');
  adapter.inventory.poppy = 2;
  addBee(adapter, '300'); addBee(adapter, '301'); addBee(adapter, 'old_baby', { baby: true });
  adapter._interactEntity = bee => { bee.inlove = true; adapter.inventory.poppy--; };
  const result = await adapter._breedBees(50);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'baby_not_observed');
  assert.equal(result.fed.length, 2);
});

test('bee crafts follow server recipes, exact materials and table requirements', () => {
  const { adapter } = fixture();
  const ingredient = name => ({ type: 'valid', descriptor_type: 'name', name });
  adapter.recipes = new Map([['honeycomb_block', [{ network_id: 1 }]], ['beehive', [{ network_id: 2 }]]]);
  adapter.craftingData = { shaped_recipes: [
    { network_id: 1, width: 2, height: 2, input: Array(4).fill(ingredient('honeycomb')) },
    { network_id: 2, width: 3, height: 3, input: [...Array(3).fill(ingredient('oak_planks')),
      ...Array(3).fill(ingredient('honeycomb')), ...Array(3).fill(ingredient('oak_planks'))] },
  ] };
  adapter.inventory = { honeycomb: 3, oak_planks: 6 };
  const crafts = () => adapter._beeOptions().filter(o => o.key.startsWith('craft_')).map(o => o.key);
  assert.deepEqual(crafts(), []);
  adapter.inventory.honeycomb = 4;
  assert.deepEqual(crafts(), ['craft_honeycomb_block']);
  const scan = adapter.world.findBlocks;
  adapter.world.findBlocks = names => names === 'crafting_table' ? [{ name: 'crafting_table', position: { x: 3, y: 64, z: 0 } }] : scan(names);
  assert.deepEqual(crafts(), ['craft_beehive', 'craft_honeycomb_block']);
  assert.ok(!crafts().includes('craft_candle'), 'no candle recipe, no option');
});

test('hive actions use collect intent and bottle harvesting ranks for a honey_bottle goal', () => {
  for (const action of ['harvest_honeycomb', 'harvest_honey', 'feed_bee', 'breed_bee']) assert.deepEqual(optionIntents(action), ['collect']);
  assert.equal(optionPriority({ key: 'harvest_honey' }, { targets: { honey_bottle: 1 } }), 4);
});
