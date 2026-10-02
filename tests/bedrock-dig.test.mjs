import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

const solid = (name, extra = {}) => ({ name, boundingBox: 'block', diggable: true, hardness: 0.5, ...extra });
const air = { name: 'air', boundingBox: 'empty', diggable: false, hardness: 0 };

// Bot a (92.5, piedi 72, 148.5) rivolto a sud (+z): un gradino scavabile in avanti.
function digAdapter (cells = {}) {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter._feet = { x: 92.5, y: 72, z: 148.5 };
  adapter.position = { x: 92.5, y: 73.62, z: 148.5 };
  adapter._lastYaw = 0;
  const blocks = {
    '92,73,149': air,
    '92,72,149': solid('dirt', { material: 'mineable/shovel' }),
    '92,71,149': solid('grass_block', { material: 'mineable/shovel', hardness: 0.6 }),
    '92,70,149': solid('dirt', { material: 'mineable/shovel' }),
    ...cells,
  };
  adapter.world.blockAt = ({ x, y, z }) => blocks[`${x},${y},${z}`] ?? null;
  adapter.world.findBlocks = () => [];
  return { adapter, blocks };
}

test('a pickaxe already in the hotbar is selected without a swap', async () => {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.inventorySlots[3] = { network_id: 341, name: 'wooden_pickaxe', count: 1, stack_id: 5 };
  const written = [];
  adapter.client = { write: (name, params) => written.push({ name, params }) };
  const tool = await adapter._selectToolFor({ name: 'stone', material: 'mineable/pickaxe' });
  assert.equal(tool, 'wooden_pickaxe');
  assert.equal(adapter.selectedHotbar, 3);
  assert.equal(written[0].name, 'mob_equipment');
  assert.equal(written[0].params.selected_slot, 3);
});

test('a pickaxe in the main inventory is moved into a free hotbar slot via cursor', async () => {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.inventorySlots[10] = { network_id: 341, name: 'wooden_pickaxe', count: 1, stack_id: 8 };
  adapter.client = { write: () => {} };
  adapter._ensureInventoryOpen = async () => {};
  const sent = [];
  adapter._sendStackRequest = async actions => { sent.push(actions); return { status: 'ok', containers: [] }; };
  const tool = await adapter._selectToolFor({ name: 'stone', material: 'mineable/pickaxe' });
  assert.equal(tool, 'wooden_pickaxe');
  assert.equal(adapter.selectedHotbar, 0);
  assert.equal(sent.length, 2);
  assert.equal(sent[0][0].type_id, 'take');
  assert.deepEqual(sent[0][0].source, { slot_type: { container_id: 'hotbar_and_inventory' }, slot: 10, stack_id: 8 });
  assert.equal(sent[1][0].type_id, 'place');
  assert.deepEqual(sent[1][0].destination, { slot_type: { container_id: 'hotbar_and_inventory' }, slot: 0, stack_id: 0 });
});

test('the best tier pickaxe wins and blocks without a tool need stay untouched', async () => {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.inventorySlots[0] = { network_id: 341, name: 'wooden_pickaxe', count: 1, stack_id: 1 };
  adapter.inventorySlots[1] = { network_id: 345, name: 'stone_pickaxe', count: 1, stack_id: 2 };
  adapter.client = { write: () => {} };
  assert.equal(await adapter._selectToolFor({ name: 'stone', material: 'mineable/pickaxe' }), 'stone_pickaxe');
  assert.equal(adapter.selectedHotbar, 1);
  assert.equal(await adapter._selectToolFor({ name: 'dirt', material: 'mineable/shovel' }), null);
  assert.equal(await adapter._selectToolFor({ name: 'potatoes', material: 'plant' }), null);
});

test('mining selects the pickaxe before breaking stone', async () => {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.serverAuthBlockBreaking = true;
  adapter.position = { x: 92.5, y: 73.62, z: 148.5 };
  adapter._feet = { x: 92.5, y: 72, z: 148.5 };
  adapter.inventorySlots[3] = { network_id: 341, name: 'wooden_pickaxe', count: 1, stack_id: 5, metadata: 0 };
  const packets = [];
  const client = adapter.client = new EventEmitter();
  client.entityId = 1;
  client.queue = () => {};
  client.write = (name, params) => packets.push({ name, params });
  const block = { name: 'stone', position: { x: 92, y: 71, z: 148 }, diggable: true, hardness: 1.5, material: 'mineable/pickaxe' };
  let remaining = block;
  adapter.world.blockAt = () => remaining;
  adapter.world.runtimeIdAt = () => 0xf1234567;
  adapter.world.refreshSection = () => { remaining = { name: 'air' }; };
  adapter.world.registry = { items: { 341: { name: 'wooden_pickaxe', maxDurability: 59 } } };
  adapter._refreshNearby = () => {};
  const result = await adapter._mineBlock(block, 10000);
  assert.equal(result.ok, true);
  assert.equal(result.tool, 'wooden_pickaxe');
  assert.equal(adapter.selectedHotbar, 3);
  assert.equal(packets[0].name, 'mob_equipment');
});

test('dig targets are the head, front and step cells of a staircase', () => {
  const { adapter } = digAdapter();
  const plan = adapter._digTargets();
  assert.equal(plan.error, undefined);
  assert.deepEqual(plan.targets.map(t => t.label), ['front', 'step']);
  assert.deepEqual(plan.targets.map(t => t.block.name), ['dirt', 'grass_block']);
  assert.deepEqual(plan.step, { x: 92, y: 71, z: 149 });
  assert.deepEqual(plan.support, { x: 92, y: 70, z: 149 });
});

test('dig targets refuse missing support and fluids, and treat unknown blocks as raw targets', () => {
  const noSupport = digAdapter({ '92,70,149': air });
  assert.equal(noSupport.adapter._digTargets().error, 'no_support_ahead');
  const water = digAdapter({ '92,71,149': { name: 'water', boundingBox: 'empty', diggable: false, hardness: 0 } });
  assert.equal(water.adapter._digTargets().error, 'unsafe_block_step');
  const unknown = digAdapter({ '92,73,149': { name: 'unknown', diggable: false, hardness: null, runtimeId: 42 } });
  const plan = unknown.adapter._digTargets();
  assert.equal(plan.error, undefined);
  assert.equal(plan.targets[0].label, 'head');
  assert.equal(plan.targets[0].raw, true);
});

test('dig_down mines head/front/step in order then descends the stair', async () => {
  const { adapter } = digAdapter();
  const mined = [];
  adapter._mineBlock = async block => { mined.push(block.name); return { ok: true, block: block.name, tool: null }; };
  adapter._descendStair = async () => true;
  const result = await adapter._digDown(1000);
  assert.equal(result.ok, true);
  assert.deepEqual(mined, ['dirt', 'grass_block']);
  assert.equal(result.moved, true);
  assert.deepEqual(result.dug.map(d => d.label), ['front', 'step']);
});

test('dig_down with an already open step skips mining and only descends', async () => {
  const { adapter } = digAdapter({ '92,73,149': air, '92,72,149': air, '92,71,149': air });
  adapter._mineBlock = async () => { throw new Error('nothing should be mined'); };
  adapter._descendStair = async () => true;
  const result = await adapter._digDown(1000);
  assert.equal(result.ok, true);
  assert.deepEqual(result.dug, []);
  assert.equal(result.moved, true);
});

test('descend stair stops pushing as soon as the feet drop one block', async () => {
  const { adapter } = digAdapter();
  adapter._startNode = () => ({ x: 92, y: 72, z: 148 });
  adapter._startMotion = async () => { adapter._feet.y -= 1; return 'goal'; };
  const moved = await adapter._descendStair({ step: { x: 92, y: 71, z: 149 }, direction: { dx: 0, dz: 1 } }, { moveMs: 500, settleMs: 150 });
  assert.equal(moved, true);
});

test('descend stair reports a stall when the bot never leaves the ledge', async () => {
  const { adapter } = digAdapter();
  adapter._startNode = () => ({ x: 92, y: 72, z: 148 });
  adapter._startMotion = async () => 'stuck';
  const moved = await adapter._descendStair({ step: { x: 92, y: 71, z: 149 }, direction: { dx: 0, dz: 1 } }, { moveMs: 150, settleMs: 150 });
  assert.equal(moved, false);
});

test('options offer dig_down to dig a step or to finish an already open one', () => {
  const { adapter } = digAdapter();
  adapter.drops = [];
  adapter.nearbyBlocks = {};
  assert.equal(adapter.options().some(o => o.key === 'dig_down'), true);
  // Celle davanti già aperte con appoggio sotto: resta la discesa nel gradino.
  const open = digAdapter({
    '92,73,149': air, '92,72,149': air, '92,71,149': air,
  });
  open.adapter.drops = [];
  open.adapter.nearbyBlocks = {};
  assert.equal(open.adapter.options().some(o => o.key === 'dig_down'), true);
  // Nessun appoggio: non c'è un gradino sicuro da scendere.
  const ledge = digAdapter({
    '92,73,149': air, '92,72,149': air, '92,71,149': air, '92,70,149': air,
  });
  ledge.adapter.drops = [];
  ledge.adapter.nearbyBlocks = {};
  assert.equal(ledge.adapter.options().some(o => o.key === 'dig_down'), false);
});

test('options skip mine_<block> when the block is buried and offer it when exposed', () => {
  const { adapter, blocks } = digAdapter();
  adapter.drops = [];
  adapter.inventory = { wooden_pickaxe: 1 };
  adapter.nearbyBlocks = { stone: [{ name: 'stone', position: { x: 92, y: 67, z: 148 }, distance: 6.7, diggable: true }] };
  for (const key of ['92,67,148', '93,67,148', '91,67,148', '92,68,148', '92,66,148', '92,67,149', '92,67,147']) {
    blocks[key] = solid('dirt', { material: 'mineable/shovel' });
  }
  assert.equal(adapter.options().some(o => o.key === 'mine_stone'), false, 'stone sepolta: nessuna opzione');
  blocks['92,68,148'] = air;
  assert.equal(adapter.options().some(o => o.key === 'mine_stone'), true, 'stone esposta: opzione presente');
});

test('options do not offer stone mining without a pickaxe (no drops)', () => {
  const { adapter, blocks } = digAdapter();
  adapter.drops = [];
  adapter.inventory = {};
  adapter.nearbyBlocks = { stone: [{ name: 'stone', position: { x: 92, y: 67, z: 148 }, distance: 3, diggable: true }] };
  blocks['92,67,148'] = solid('stone', { material: 'mineable/pickaxe', hardness: 1.5, harvestTools: { 941: true, 956: true, 946: true, 951: true, 961: true, 966: true, 971: true } });
  blocks['92,68,148'] = air;
  assert.equal(adapter.options().some(o => o.key === 'mine_stone'), false);
  adapter.inventorySlots = [{ network_id: 345, name: 'stone_pickaxe' }];
  assert.equal(adapter.options().some(o => o.key === 'mine_stone'), true);
});

test('dig targets refuse to dig through functional blocks', () => {
  const table = digAdapter({ '92,72,149': { name: 'crafting_table', boundingBox: 'block', diggable: true, hardness: 2.5, material: 'mineable/axe' } });
  const plan = table.adapter._digTargets();
  assert.equal(plan.error, 'protected_front');
  assert.equal(plan.block, 'crafting_table');
  const chest = digAdapter({ '92,71,149': { name: 'chest', boundingBox: 'block', diggable: true, hardness: 2.5, material: 'mineable/axe' } });
  assert.equal(chest.adapter._digTargets().error, 'protected_step');
});

test('a rejected move resyncs the inventory and retries with fresh stack ids', async () => {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.inventorySlots[10] = { network_id: 341, name: 'wooden_pickaxe', count: 1, stack_id: 8 };
  adapter.client = { write: () => {} };
  adapter._ensureInventoryOpen = async () => {};
  let attempts = 0;
  const sent = [];
  adapter._sendStackRequest = async actions => {
    attempts++;
    sent.push(actions);
    return attempts === 1 ? { status: 49, containers: [] } : { status: 'ok', containers: [] };
  };
  adapter._resyncByReconnect = async () => {
    adapter.inventorySlots[10] = { network_id: 341, name: 'wooden_pickaxe', count: 1, stack_id: 99 };
  };
  const hotbar = await adapter._moveSlotToHotbar(10);
  assert.equal(hotbar, 0);
  assert.equal(attempts, 3, 'take fallito, poi take+place con stack id freschi');
  assert.equal(sent[0][0].source.stack_id, 8);
  assert.equal(sent[1][0].source.stack_id, 99);
  assert.equal(sent[2][0].type_id, 'place');
});

test('options avoid redundant stick and table crafts', () => {
  const { adapter } = digAdapter();
  adapter.drops = [];
  adapter.nearbyBlocks = {};
  adapter.inventorySlots = [];
  adapter.recipes = new Map([['oak_planks', []], ['stick', []], ['crafting_table', []], ['stone_pickaxe', []]]);
  adapter.craftingData = { shaped_recipes: [], shapeless_recipes: [] };
  adapter.world.findBlocks = () => [];
  adapter.inventory = { oak_planks: 4, stick: 4, crafting_table: 1 };
  let keys = adapter.options().map(o => o.key);
  assert.equal(keys.includes('craft_stick'), false);
  assert.equal(keys.includes('craft_crafting_table'), false);
  adapter.inventory = { oak_planks: 4, stick: 0 };
  keys = adapter.options().map(o => o.key);
  assert.equal(keys.includes('craft_stick'), true);
  assert.equal(keys.includes('craft_crafting_table'), true, 'senza tavolo né item va craftato');
});

test('goal node search prefers the target level (drop below the bot)', () => {
  const { adapter } = digAdapter({
    '92,72,148': air, '92,73,148': air, '92,71,148': solid('dirt'),
    '92,67,147': air, '92,68,147': air, '92,66,147': solid('stone'),
  });
  const nodes = adapter._findGoalNodes({ x: 92.65, y: 67.125, z: 147.53 });
  assert.equal(nodes[0].y, 67, 'il nodo al livello del drop vince sul nodo corrente');
});

test('harvest rank rules: coal by wooden, iron by stone, gold by iron', () => {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  const mk = (name, tools) => ({ name, diggable: true, hardness: 3, material: 'mineable/pickaxe', harvestTools: tools });
  const woodenPlus = { 941: true, 956: true, 946: true, 951: true, 961: true, 966: true, 971: true };
  const stonePlus = { 946: true, 951: true, 961: true, 966: true, 971: true };
  const ironPlus = { 961: true, 966: true, 971: true };
  const coal = mk('coal_ore', woodenPlus);
  const iron = mk('iron_ore', stonePlus);
  const gold = mk('gold_ore', ironPlus);
  assert.equal(adapter._blockHarvestable(coal, 'wooden_pickaxe'), true);
  assert.equal(adapter._blockHarvestable(coal, 'golden_pickaxe'), true);
  assert.equal(adapter._blockHarvestable(coal, null), false, 'a mano niente drop');
  assert.equal(adapter._blockHarvestable(iron, 'wooden_pickaxe'), false);
  assert.equal(adapter._blockHarvestable(iron, 'stone_pickaxe'), true);
  assert.equal(adapter._blockHarvestable(iron, 'copper_pickaxe'), true);
  assert.equal(adapter._blockHarvestable(gold, 'stone_pickaxe'), false);
  assert.equal(adapter._blockHarvestable(gold, 'iron_pickaxe'), true);
  assert.equal(adapter._blockHarvestable(mk('stone', woodenPlus), null), false);
  assert.equal(adapter._blockHarvestable({ name: 'dirt', diggable: true, hardness: 0.5 }, null), true);
});

test('options require the right pickaxe tier for ore drops', () => {
  const { adapter, blocks } = digAdapter();
  adapter.drops = [];
  adapter.nearbyBlocks = { iron_ore: [{ name: 'iron_ore', position: { x: 92, y: 67, z: 148 }, distance: 6, diggable: true }] };
  blocks['92,67,148'] = solid('iron_ore', { material: 'incorrect_for_wooden_tool', hardness: 3, harvestTools: { 946: true, 951: true, 961: true, 966: true, 971: true } });
  blocks['92,68,148'] = air;
  adapter.inventorySlots = [{ network_id: 341, name: 'wooden_pickaxe' }];
  assert.equal(adapter.options().some(o => o.key === 'mine_iron_ore'), false, 'col piccone di legno niente drop');
  adapter.inventorySlots = [{ network_id: 345, name: 'stone_pickaxe' }];
  assert.equal(adapter.options().some(o => o.key === 'mine_iron_ore'), true);
});

test('ores with incorrect_for_wooden_tool material still require a pickaxe', () => {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  const copper = { name: 'copper_ore', diggable: true, hardness: 3, material: 'incorrect_for_wooden_tool', harvestTools: { 946: true, 951: true, 961: true, 966: true, 971: true } };
  assert.equal(adapter._requiredToolKind(copper), 'pickaxe');
  assert.equal(adapter._blockHarvestable(copper, 'stone_pickaxe'), true);
  assert.equal(adapter._blockHarvestable(copper, 'wooden_pickaxe'), false);
});

test('tool damage is read from the Bedrock NBT Damage field', () => {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  const withNbt = { network_id: 341, metadata: 0, extra: { nbt: { nbt: { value: { Damage: { value: 52 } } } } } };
  assert.equal(adapter._itemDamage(withNbt), 52);
  assert.equal(adapter._itemDamage({ network_id: 341, metadata: 3 }), 3);
  assert.equal(adapter._itemDamage(undefined), 0);
});

test('observe exposes the held tool durability', () => {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.position = { x: 0, y: 0, z: 0 };
  adapter.world.registry = { items: { 341: { name: 'wooden_pickaxe', maxDurability: 59 } } };
  adapter.inventorySlots = [{ network_id: 341, metadata: 7, count: 1 }];
  adapter.selectedHotbar = 0;
  const obs = adapter.observe();
  assert.equal(obs.held, 'wooden_pickaxe');
  assert.deepEqual(obs.heldDurability, { damage: 7, max: 59 });
});

test('options offer torch and furnace crafts when materials are held', () => {
  const { adapter } = digAdapter();
  adapter.drops = [];
  adapter.nearbyBlocks = {};
  adapter.inventorySlots = [];
  adapter.recipes = new Map([['torch', []], ['furnace', []]]);
  adapter.craftingData = { shaped_recipes: [], shapeless_recipes: [] };
  adapter.world.findBlocks = () => [];
  adapter.inventory = { coal: 1, stick: 2, cobblestone: 8 };
  let keys = adapter.options().map(o => o.key);
  assert.equal(keys.includes('craft_torch'), true);
  assert.equal(keys.includes('craft_furnace'), false, 'senza tavolo la fornace non è craftabile');
  adapter.world.findBlocks = name => name === 'crafting_table' ? [{ position: { x: 1, y: 1, z: 1 } }] : [];
  keys = adapter.options().map(o => o.key);
  assert.equal(keys.includes('craft_furnace'), true);
  adapter.inventory = { charcoal: 1, stick: 2 };
  assert.equal(adapter.options().some(o => o.key === 'craft_torch'), true, 'la carbonella vale come il carbone');
});

test('tool selection prefers a harvest-capable pickaxe over a faster golden one', async () => {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.client = { write: () => {} };
  adapter.inventorySlots[0] = { network_id: 356, name: 'golden_pickaxe', count: 1, stack_id: 1 };
  adapter.inventorySlots[1] = { network_id: 345, name: 'stone_pickaxe', count: 1, stack_id: 2 };
  const iron = { name: 'iron_ore', diggable: true, hardness: 3, material: 'incorrect_for_wooden_tool', harvestTools: { 946: true, 951: true, 961: true, 966: true, 971: true } };
  const coal = { name: 'coal_ore', diggable: true, hardness: 3, material: 'mineable/pickaxe', harvestTools: { 941: true, 956: true, 946: true, 951: true, 961: true, 966: true, 971: true } };
  assert.equal(await adapter._selectToolFor(iron), 'stone_pickaxe', 'il piccone d\'oro è più veloce ma non raccoglie il ferro');
  assert.equal(await adapter._selectToolFor(coal), 'golden_pickaxe', 'sul carbone vince il più veloce');
});

test('coals item tag matches coal and charcoal only', () => {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  const tag = { type: 'valid', descriptor_type: 'item_tag', tag: 'minecraft:coals' };
  assert.equal(adapter._ingredientMatches(tag, 'coal'), true);
  assert.equal(adapter._ingredientMatches(tag, 'charcoal'), true);
  assert.equal(adapter._ingredientMatches(tag, 'stick'), false);
  assert.equal(adapter._ingredientMatches(tag, 'oak_planks'), false);
});

test('options collapse to wait while the Bedrock connection is being re-established', async () => {
  const { adapter } = digAdapter();
  adapter.spawned = false;
  adapter.status = 'discovering';
  assert.deepEqual(adapter.options().map(o => o.key), ['wait']);
  assert.deepEqual(await adapter.executeAction('dig_down'), { ok: false, error: 'not_connected' });
});

test('options offer craft_stone_pickaxe with materials and a nearby table', () => {
  const { adapter, blocks } = digAdapter();
  blocks['93,72,146'] = { name: 'crafting_table', boundingBox: 'block', diggable: true, hardness: 2.5, material: 'mineable/axe' };
  adapter.world.findBlocks = name => name === 'crafting_table' ? [{ position: { x: 93, y: 72, z: 146 }, distance: 2 }] : [];
  adapter.drops = [];
  adapter.nearbyBlocks = {};
  adapter.inventory = { cobblestone: 3, stick: 2 };
  adapter.inventorySlots = [];
  adapter.recipes = new Map([['stone_pickaxe', [{ kind: 'shaped', network_id: 1729 }]]]);
  adapter.craftingData = { shaped_recipes: [], shapeless_recipes: [] };
  const keys = adapter.options().map(o => o.key);
  assert.equal(keys.includes('craft_stone_pickaxe'), true);
  adapter.inventory.cobblestone = 2;
  assert.equal(adapter.options().some(o => o.key === 'craft_stone_pickaxe'), false);
});

test('dig_down steers the staircase toward the plan waypoint', () => {
  const { adapter } = digAdapter();
  adapter._lastYaw = 90; // guarderebbe a ovest
  adapter.plan = { waypoint: { x: 120, z: 148 } };
  assert.deepEqual(adapter._digDirection(), { dx: 1, dz: 0 }, 'waypoint a est');
  adapter.plan = { waypoint: { x: 92, z: 160 } };
  assert.deepEqual(adapter._digDirection(), { dx: 0, dz: 1 }, 'waypoint a sud');
  adapter.plan = { waypoint: { x: 92.6, z: 148.6 } };
  assert.deepEqual(adapter._digDirection(), { dx: -1, dz: 0 }, 'waypoint addosso: torna allo yaw');
});

test('hotbar eviction prefers junk over tools and fuel', () => {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  for (let i = 0; i < 9; i++) adapter.inventorySlots[i] = { network_id: 3, name: 'dirt', count: 64 };
  adapter.inventorySlots[0] = { network_id: 341, name: 'wooden_pickaxe', count: 1 };
  adapter.inventorySlots[4] = { network_id: 263, name: 'coal', count: 3 };
  assert.equal(adapter._hotbarSlotToEvict(), 1, 'prima la terra, non piccone o carbone');
});

test('a full hotbar frees the least valuable slot to select a tool', async () => {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.client = { write: () => {} };
  adapter._ensureInventoryOpen = async () => {};
  for (let i = 0; i < 9; i++) adapter.inventorySlots[i] = { network_id: 3, name: 'dirt', count: 64, stack_id: 100 + i };
  adapter.inventorySlots[0] = { network_id: 341, name: 'wooden_pickaxe', count: 1, stack_id: 1 };
  adapter.inventorySlots[30] = { network_id: 345, name: 'stone_pickaxe', count: 1, stack_id: 2 };
  const requests = [];
  adapter._sendStackRequest = async actions => {
    const a = actions[0];
    requests.push(a);
    if (a.type_id === 'take') {
      return { status: 'ok', containers: [{ slot_type: { container_id: 'cursor' }, slots: [{ slot: 0, count: a.count, item_stack_id: 900 + requests.length }] }] };
    }
    return { status: 'ok', containers: [] };
  };
  const tool = await adapter._selectToolFor({ name: 'stone', material: 'mineable/pickaxe' });
  assert.equal(tool, 'stone_pickaxe');
  assert.equal(requests.length, 4, 'eviction take+place, poi move take+place');
  assert.equal(requests[0].source.slot_type.container_id, 'hotbar', 'eviction: dalla hotbar al cursore');
  assert.deepEqual(requests[1].destination.slot_type, { container_id: 'hotbar_and_inventory' }, 'eviction: dal cursore a un buco');
  assert.equal(requests[1].destination.slot, 9);
  assert.equal(requests[2].source.slot_type.container_id, 'hotbar_and_inventory', 'move: dal main al cursore');
  assert.equal(requests[2].source.slot, 30);
  assert.equal(requests[3].destination.slot_type.container_id, 'hotbar_and_inventory', 'move: dal cursore alla hotbar');
  const destSlot = requests[3].destination.slot;
  assert.equal(adapter.inventorySlots[destSlot].name, 'stone_pickaxe', 'il piccone va in hotbar');
  assert.equal(adapter.inventorySlots[9].name, 'dirt', 'la terra evitta finisce nel buco');
  assert.equal(adapter.selectedHotbar, destSlot);
});
