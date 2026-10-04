import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { BedrockAdapter } from '../bedrock-adapter.mjs';
import { isTraderType, entityHeight } from '../bedrock-survival.mjs';

const require = createRequire(import.meta.url);
const { createSerializer } = require('bedrock-protocol/src/transforms/serializer');
const serializer = createSerializer('1.26.51');

// ---- regole pure --------------------------------------------------------------------

test('trader classification covers villagers and wandering traders, never hostile', () => {
  assert.equal(isTraderType('minecraft:villager'), true);
  assert.equal(isTraderType('villager_v2'), true);
  assert.equal(isTraderType('minecraft:wandering_trader'), true);
  assert.equal(isTraderType('trader_llama'), true);
  assert.equal(isTraderType('zombie'), false);
  assert.equal(isTraderType('cow'), false);
  assert.equal(isTraderType('player'), false);
  assert.equal(entityHeight('villager'), 1.95);
  assert.equal(entityHeight('wandering_trader'), 1.95);
});

// ---- adapter: helper di costruzione --------------------------------------------------

function spawnedAdapter () {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.client = new EventEmitter();
  adapter.client.entityId = 7n;
  adapter.client.write = () => {};
  adapter.position = { x: 0, y: 64.62, z: 0 };
  adapter._feet = { x: 0, y: 63, z: 0 };
  return adapter;
}

function capture (adapter) {
  const packets = [];
  adapter.client.write = (name, params) => packets.push({ name, params });
  return packets;
}

function serializeAll (packets) {
  for (const packet of packets) {
    assert.doesNotThrow(() => serializer.createPacketBuffer({ name: packet.name, params: packet.params }),
      `serialize ${packet.name}`);
  }
}

function offersTag () {
  // Ricostruisce il NBT di update_trade come lo parsa prismarine-nbt (tag completi).
  const compound = (obj) => ({ type: 'compound', name: '', value: obj });
  const item = (id, count) => compound({ id: { type: 'string', value: id }, Count: { type: 'byte', value: count } });
  const recipes = [
    // 1 smeraldo -> 6 pane (scambio "compra pane")
    compound({
      buyA: item('minecraft:emerald', 1),
      buyB: item('minecraft:air', 0),
      sell: item('minecraft:bread', 6),
      maxUses: { type: 'int', value: 12 },
      uses: { type: 'int', value: 3 },
      rewardExp: { type: 'byte', value: 1 },
      tier: { type: 'int', value: 0 },
    }),
    // 20 grano + 1 smeraldo -> 1 smeraldo? no: 20 grano -> 1 smeraldo (vendita)
    compound({
      buyA: item('minecraft:wheat', 20),
      buyB: item('minecraft:air', 0),
      sell: item('minecraft:emerald', 1),
      maxUses: { type: 'int', value: 16 },
      uses: { type: 'int', value: 0 },
      rewardExp: { type: 'byte', value: 1 },
      tier: { type: 'int', value: 1 },
    }),
    // 1 smeraldo + 1 libro -> 1 scaffale (doppio input)
    compound({
      buyA: item('minecraft:emerald', 1),
      buyB: item('minecraft:book', 1),
      sell: item('minecraft:bookshelf', 1),
      maxUses: { type: 'int', value: 8 },
      uses: { type: 'int', value: 0 },
      rewardExp: { type: 'byte', value: 0 },
      tier: { type: 'int', value: 2 },
    }),
  ];
  return compound({
    Recipes: { type: 'list', name: '', value: { type: 'compound', value: recipes } },
  });
}

// ---- parsing offerte -----------------------------------------------------------------

test('update_trade NBT offers are parsed into readable trades', () => {
  const adapter = spawnedAdapter();
  adapter._onUpdateTrade({
    window_id: 1,
    window_type: 'trading',
    size: 3,
    trade_tier: 0,
    villager_unique_id: 900n,
    entity_unique_id: 7n,
    display_name: 'Farmer',
    new_trading_ui: true,
    economic_trades: false,
    offers: offersTag(),
  });
  assert.equal(adapter.tradeOffers.length, 3);
  assert.equal(adapter.tradeDisplayName, 'Farmer');
  assert.equal(adapter.tradeNewUI, true);
  assert.deepEqual(adapter.tradeOffers[0].buyA, { item: 'emerald', count: 1 });
  assert.equal(adapter.tradeOffers[0].buyB, null, 'air second input collapses to null');
  assert.deepEqual(adapter.tradeOffers[0].sell, { item: 'bread', count: 6 });
  assert.equal(adapter.tradeOffers[0].uses, 3);
  assert.equal(adapter.tradeOffers[0].maxUses, 12);
  assert.equal(adapter.tradeOffers[1].sell.item, 'emerald');
  assert.deepEqual(adapter.tradeOffers[2].buyB, { item: 'book', count: 1 });
});

test('offers NBT parsing survives an already-unwrapped plain object', () => {
  const adapter = spawnedAdapter();
  const offers = adapter._parseTradeOffers({
    Recipes: [
      { buyA: { id: 'minecraft:stick', Count: 2 }, sell: { id: 'minecraft:emerald', Count: 1 }, uses: 0, maxUses: 4 },
    ],
  });
  assert.equal(offers.length, 1);
  assert.deepEqual(offers[0].buyA, { item: 'stick', count: 2 });
  assert.equal(offers[0].buyB, null);
  assert.deepEqual(offers[0].sell, { item: 'emerald', count: 1 });
});

// ---- requisiti e descrizioni ---------------------------------------------------------

test('trade requirements check both inputs against inventory', () => {
  const adapter = spawnedAdapter();
  adapter.inventory = { emerald: 2, wheat: 20 };
  const bread = { buyA: { item: 'emerald', count: 1 }, buyB: null, sell: { item: 'bread', count: 6 } };
  const bookshelf = { buyA: { item: 'emerald', count: 1 }, buyB: { item: 'book', count: 1 }, sell: { item: 'bookshelf', count: 1 } };
  assert.equal(adapter._offerRequirementsMet(bread), true);
  assert.equal(adapter._offerRequirementsMet(bookshelf), false, 'missing book');
  adapter.inventory.book = 1;
  assert.equal(adapter._offerRequirementsMet(bookshelf), true);
});

test('offer description includes cost, output, uses and trader context', () => {
  const adapter = spawnedAdapter();
  adapter.tradeTarget = { type: 'wandering_trader', distance: 3.2 };
  const offer = { buyA: { item: 'emerald', count: 1 }, buyB: null, sell: { item: 'bread', count: 6 }, uses: 2, maxUses: 12 };
  const desc = adapter._offerDescription(offer, 0);
  assert.match(desc, /1 emerald/);
  assert.match(desc, /6 bread/);
  assert.match(desc, /10 uses left/);
  assert.match(desc, /wandering_trader/);
  assert.match(desc, /despawns soon/);
});

// ---- slot di trading e specchio locale -----------------------------------------------

test('trading slot containers follow new vs old trade UI', () => {
  const adapter = spawnedAdapter();
  adapter.tradeNewUI = true;
  assert.deepEqual(adapter._tradeSlotContainers(), {
    ingredient1: 'trade2_ingredient1', ingredient2: 'trade2_ingredient2', result: 'trade2_result',
  });
  adapter.tradeNewUI = false;
  assert.deepEqual(adapter._tradeSlotContainers(), {
    ingredient1: 'trade_ingredient1', ingredient2: 'trade_ingredient2', result: 'trade_result',
  });
});

test('inventory_slot for a trade container updates the local mirror', () => {
  const adapter = spawnedAdapter();
  adapter.tradeNewUI = true;
  adapter._openContainer = { id: 5, type: 'trading' };
  const tracked = adapter._trackTradeSlot('trade2_result', 0, { network_id: 12, name: 'bread', count: 6, stack_id: 77 });
  assert.equal(tracked, true);
  assert.equal(adapter._tradeSlots.result.name, 'bread');
  assert.equal(adapter._tradeSlots.result.count, 6);
  // Container sconosciuto o slot diverso da 0: non è uno slot di trading.
  assert.equal(adapter._trackTradeSlot('hotbar', 0, { network_id: 1, count: 1 }), false);
});

// ---- opzioni -------------------------------------------------------------------------

test('options offer open_trade for a nearby trader and gate trade_<index> by inventory', () => {
  const adapter = spawnedAdapter();
  adapter._trackEntity({ runtime_id: 42n, unique_id: 900n, entity_type: 'minecraft:villager', position: { x: 3, y: 63, z: 0 } }, 'mob');
  adapter.inventory = { emerald: 2, book: 1 };
  adapter.inventorySlots = [{ network_id: 1, name: 'emerald', count: 2, stack_id: 1 }];
  adapter._openContainer = null;
  let keys = adapter.options().map(o => o.key);
  assert.ok(keys.includes('open_trade'), 'open_trade offered when a trader is near');

  // Finestra aperta: niente open_trade, ma close_trade + scambi eseguibili.
  adapter._openContainer = { id: 5, type: 'trading' };
  adapter.tradeOffers = [
    { buyA: { item: 'emerald', count: 1 }, buyB: null, sell: { item: 'bread', count: 6 } },
    { buyA: { item: 'emerald', count: 1 }, buyB: { item: 'book', count: 1 }, sell: { item: 'bookshelf', count: 1 } },
    { buyA: { item: 'diamond', count: 1 }, buyB: null, sell: { item: 'emerald', count: 1 } },
  ];
  keys = adapter.options().map(o => o.key);
  assert.ok(keys.includes('close_trade'));
  assert.ok(keys.includes('trade_0'));
  assert.ok(keys.includes('trade_1'), 'second trade offered with book in inventory');
  assert.ok(!keys.includes('trade_2'), 'trade requiring diamonds is not offered');
});

// ---- forma pacchetti -----------------------------------------------------------------

test('interact transaction serializes against protocol 1.26.51', () => {
  const adapter = spawnedAdapter();
  adapter.inventorySlots[0] = { network_id: 10, name: 'emerald', count: 1, stack_id: 1 };
  adapter.selectedHotbar = 0;
  const packets = capture(adapter);
  const ok = adapter._interactEntity({ type: 'villager', runtimeId: '42', position: { x: 1, y: 63, z: 1 } });
  assert.equal(ok, true);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].name, 'inventory_transaction');
  assert.equal(packets[0].params.transaction.transaction_type, 'item_use_on_entity');
  assert.equal(packets[0].params.transaction.transaction_data.action_type, 'interact');
  serializeAll(packets);
});

test('trade stack request actions use trade2 containers and serialize', () => {
  const adapter = spawnedAdapter();
  adapter.tradeNewUI = true;
  adapter._openContainer = { id: 5, type: 'trading' };
  const packet = {
    name: 'item_stack_request',
    params: {
      requests: [{
        request_id: -863,
        custom_names: [],
        cause: 'chat_public',
        actions: [
          {
            type_id: 'take', legacy_type_id: 0, count: 1,
            source: adapter._slotInfo('hotbar', 0, 10),
            destination: adapter._slotInfo('cursor', 0, 0),
          },
          {
            type_id: 'place', legacy_type_id: 1, count: 1,
            source: adapter._slotInfo('cursor', 0, 0),
            destination: adapter._slotInfo('trade2_ingredient1', 0, 0),
          },
        ],
      }],
    },
  };
  assert.equal(packet.params.requests[0].actions[1].destination.slot_type.container_id, 'trade2_ingredient1');
  const { createDeserializer } = require('bedrock-protocol/src/transforms/serializer');
  const parser = createDeserializer('1.26.51');
  const decoded = parser.parsePacketBuffer(serializer.createPacketBuffer(packet)).data.params;
  assert.equal(decoded.requests[0].actions[1].destination.slot_type.container_id, 'trade2_ingredient1');
  assert.equal(decoded.requests[0].actions[1].destination.slot, 0);
});

// ---- budget e diagnosi ----------------------------------------------------------------

test('a trade waits on the caller budget instead of a fixed 5 s', async () => {
  const adapter = spawnedAdapter();
  adapter._openContainer = { id: 5, type: 'trading' };
  adapter.tradeOffers = [{ buyA: { item: 'emerald', count: 1 }, buyB: null, sell: { item: 'bread', count: 6 } }];
  adapter.inventory = { emerald: 1 };
  const budgets = [];
  adapter._putInTradeSlot = async () => {};
  adapter._refreshInventory = () => {};
  adapter._waitTradeResult = async (ms) => { budgets.push(ms); return null; };

  const wide = await adapter._tradeAt(0, { timeoutMs: 20000 });
  assert.equal(wide.error, 'trade_result_timeout');
  assert.ok(budgets[0] > 5000, `il budget del chiamante è inoltrato (${budgets[0]} ms), non il vecchio 5 s fisso`);

  const tight = await adapter._tradeAt(0, { timeoutMs: 800 });
  assert.equal(tight.error, 'trade_result_timeout');
  assert.ok(budgets[1] <= 800, 'un budget stretto non viene allungato');
  assert.ok(budgets[1] >= 500, 'l\'attesa mantiene un minimo di 500 ms');
});

test('opening a trade sends the vanilla npc_open interact packet, then the legacy fallback', async () => {
  const adapter = spawnedAdapter();
  adapter._trackEntity({ runtime_id: 42n, entity_type: 'minecraft:villager', position: { x: 3, y: 63, z: 0 } }, 'mob');
  const entity = adapter.entities.get('42');
  const packets = capture(adapter);

  await adapter._openTradeWithEntity(entity, { confirmMs: 1 });

  const npcOpen = packets.filter(p => p.name === 'interact');
  assert.ok(npcOpen.length >= 1, 'il client manda interact (action_id npc_open) come un client vanilla');
  assert.equal(npcOpen[0].params.action_id, 'npc_open');
  assert.equal(npcOpen[0].params.target_entity_id, 42n);
  assert.equal(npcOpen[0].params.has_position, false);
  const legacy = packets.filter(p => p.name === 'inventory_transaction'
    && p.params.transaction.transaction_type === 'item_use_on_entity');
  assert.ok(legacy.length >= 1, 'item_use_on_entity resta come fallback sui tentativi successivi');
  const authWithInteract = packets.filter(p => p.name === 'player_auth_input'
    && p.params.input_data?.includes('item_interact'));
  assert.ok(authWithInteract.length >= 1, 'il frame auth_input alza item_interact prima della transazione');
  const order = packets.map(p => p.name);
  assert.ok(order.indexOf('player_auth_input') < order.indexOf('inventory_transaction'),
    'il flag item_interact precede la transazione sull\'entità');
  serializeAll(packets);
});

test('the packet capture window opens only with PACKET_DEBUG=1', () => {
  const adapter = spawnedAdapter();
  delete process.env.PACKET_DEBUG;
  assert.equal(adapter._armPacketDebug(1000), false);
  assert.ok(!adapter._packetDebugUntil, 'senza PACKET_DEBUG non arma nulla');
  process.env.PACKET_DEBUG = '1';
  try {
    assert.equal(adapter._armPacketDebug(1000), true);
    assert.ok(adapter._packetDebugUntil > Date.now());
  } finally {
    delete process.env.PACKET_DEBUG;
  }
});

test('a failed trade open arms the packet capture window and reports distance', async () => {
  const adapter = spawnedAdapter();
  adapter._trackEntity({ runtime_id: 42n, entity_type: 'minecraft:villager', position: { x: 3, y: 63, z: 0 } }, 'mob');
  const entity = adapter.entities.get('42');
  process.env.PACKET_DEBUG = '1';
  try {
    const res = await adapter._openTradeWithEntity(entity, { confirmMs: 10 });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'trade_not_opened');
    assert.equal(res.attempts, 3);
    assert.ok(res.distance > 2 && res.distance < 4.5, `distanza misurata (${res.distance})`);
    assert.ok(adapter._packetDebugUntil > Date.now(), 'finestra rx_packet armata per la diagnosi');
  } finally {
    delete process.env.PACKET_DEBUG;
  }
});

test('aprire un commercio libera la mano e spegne uno sneak rimasto addosso', async () => {
  const adapter = spawnedAdapter();
  adapter._trackEntity({ runtime_id: 42n, entity_type: 'minecraft:villager', position: { x: 1, y: 63, z: 0 } }, 'mob');
  adapter.inventorySlots = [{ name: 'baked_potato', network_id: 7, count: 4 }, {}, {}, {}, {}, {}, {}, {}, {}];
  adapter.selectedHotbar = 0;
  adapter._sneaking = true;
  const packets = capture(adapter);
  const entity = adapter.entities.get('42');
  const res = await adapter._openTradeWithEntity(entity, { confirmMs: 1 });
  assert.equal(res.error, 'trade_not_opened');
  assert.equal(res.hand, 'empty');
  assert.ok(packets.some(p => p.name === 'player_action' && p.params.action === 'stop_sneak'),
    'lo sneak dello smontaggio non deve restare addosso al bot');
  assert.ok(packets.some(p => p.name === 'mob_equipment' && p.params.item.network_id === 0),
    'slot vuoto selezionato: mano libera come un client reale');
  assert.equal(adapter._sneaking, false);
  serializeAll(packets);
});

// ---- chiusura ------------------------------------------------------------------------

test('closing a trading window clears offers and target', async () => {
  const adapter = spawnedAdapter();
  adapter._openContainer = { id: 5, type: 'trading' };
  adapter.tradeOffers = [{ buyA: { item: 'emerald', count: 1 }, sell: { item: 'bread', count: 6 } }];
  adapter.tradeTarget = { type: 'villager', distance: 2 };
  const packets = capture(adapter);
  await adapter._closeContainer();
  assert.equal(adapter._openContainer, null);
  assert.deepEqual(adapter.tradeOffers, []);
  assert.equal(adapter.tradeTarget, null);
  assert.equal(packets[0].name, 'container_close');
  serializeAll(packets);
});
