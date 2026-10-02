import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  professionName, normalizeProfession, professionMatches,
  tradeInputCost, offerInputCost, offerUsesLeft, offerRequirementsMet, pickBestTrade,
} from '../bedrock-trading.mjs';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

// ---- regole pure di economia ---------------------------------------------------------

test('profession mapping and normalization', () => {
  assert.equal(professionName(5), 'cartographer');
  assert.equal(professionName(0), 'farmer');
  assert.equal(professionName(13), 'nitwit');
  assert.equal(professionName(999), null);
  assert.equal(professionName(undefined), null);
  assert.equal(normalizeProfession('Cartographer'), 'cartographer');
  assert.equal(normalizeProfession('Stone Mason'), 'stonemason');
  assert.equal(professionMatches('Cartographer', 'cartographer'), true);
  assert.equal(professionMatches('Farmer', 'cartographer'), false);
});

test('input cost classifies precious, emerald, cheap and neutral items', () => {
  assert.equal(tradeInputCost('diamond'), Infinity);
  assert.equal(tradeInputCost('iron_ingot'), Infinity);
  assert.equal(tradeInputCost('emerald'), 2);
  assert.equal(tradeInputCost('paper'), 0);
  assert.equal(tradeInputCost('glass_pane'), 0);
  assert.equal(tradeInputCost('oak_planks'), 0);
  assert.equal(tradeInputCost('wheat_seeds'), 0);
  assert.equal(tradeInputCost('redstone'), 1);
  assert.equal(tradeInputCost('sculk'), 1);
  assert.equal(tradeInputCost(null), 0);
});

test('offer cost is the highest per-item input cost (not the total)', () => {
  assert.equal(offerInputCost({ buyA: { item: 'paper', count: 24 }, buyB: null }), 0);
  assert.equal(offerInputCost({ buyA: { item: 'emerald', count: 1 }, buyB: { item: 'book', count: 1 } }), 2);
  assert.equal(offerInputCost({ buyA: { item: 'diamond', count: 1 }, buyB: null }), Infinity);
  assert.equal(offerInputCost({ buyA: { item: 'redstone', count: 2 }, buyB: null }), 1);
});

test('requirements and uses-left', () => {
  assert.equal(offerRequirementsMet({ buyA: { item: 'paper', count: 24 }, buyB: null }, { paper: 24 }), true);
  assert.equal(offerRequirementsMet({ buyA: { item: 'paper', count: 24 }, buyB: null }, { paper: 23 }), false);
  assert.equal(
    offerRequirementsMet({ buyA: { item: 'emerald', count: 1 }, buyB: { item: 'book', count: 1 } }, { emerald: 1, book: 1 }),
    true,
  );
  assert.equal(
    offerRequirementsMet({ buyA: { item: 'emerald', count: 1 }, buyB: { item: 'book', count: 1 } }, { emerald: 1 }),
    false,
  );
  assert.equal(offerUsesLeft({ maxUses: 12, uses: 3 }), 9);
  assert.equal(offerUsesLeft({ maxUses: 0 }), Infinity);
  assert.equal(offerUsesLeft({ maxUses: 12, uses: 12 }), 0);
});

test('pickBestTrade avoids precious and emerald inputs and prefers cheap over neutral', () => {
  const inv = { paper: 48, glass_pane: 22, emerald: 5, redstone: 64, diamond: 1 };
  const offers = [
    { buyA: { item: 'diamond', count: 1 }, sell: { item: 'emerald', count: 1 }, uses: 0, maxUses: 12, tier: 0 }, // precious
    { buyA: { item: 'emerald', count: 1 }, sell: { item: 'map', count: 1 }, uses: 0, maxUses: 12, tier: 0 }, // emerald
    { buyA: { item: 'redstone', count: 2 }, sell: { item: 'emerald', count: 1 }, uses: 0, maxUses: 12, tier: 0 }, // neutral
    { buyA: { item: 'glass_pane', count: 11 }, sell: { item: 'emerald', count: 1 }, uses: 0, maxUses: 12, tier: 0 }, // cheap
    { buyA: { item: 'paper', count: 24 }, sell: { item: 'emerald', count: 1 }, uses: 0, maxUses: 12, tier: 0 }, // cheap
  ];
  assert.equal(pickBestTrade(offers, inv).buyA.item, 'glass_pane');

  offers[3].uses = 12; // glass esaurito
  assert.equal(pickBestTrade(offers, inv).buyA.item, 'paper');

  offers[4].uses = 12; // anche paper esaurito -> resta il neutro (redstone)
  assert.equal(pickBestTrade(offers, inv).buyA.item, 'redstone');

  assert.equal(pickBestTrade(offers, { ...inv, redstone: 0 }), null, 'senza materiali economici non offre nulla');
});

test('pickBestTrade can be relaxed to allow emerald when explicitly requested', () => {
  const inv = { emerald: 5 };
  const offers = [{ buyA: { item: 'emerald', count: 1 }, sell: { item: 'map', count: 1 }, uses: 0, maxUses: 12, tier: 0 }];
  assert.equal(pickBestTrade(offers, inv), null, 'default maxCost=1 excludes emerald');
  assert.equal(pickBestTrade(offers, inv, { maxCost: 2 }).buyA.item, 'emerald');
});

// ---- adapter: livellamento -----------------------------------------------------------

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

test('_levelCurrentTrader reports maxed immediately when tier is already at max', async () => {
  const adapter = spawnedAdapter();
  adapter._openContainer = { id: 5, type: 'trading' };
  adapter.tradeOffers = [{ buyA: { item: 'paper', count: 24 }, sell: { item: 'emerald', count: 1 }, uses: 0, maxUses: 12 }];
  adapter.inventory = { paper: 48 };
  adapter.tradeTarget = { runtimeId: '42' };
  adapter.tradeTier = 4;
  const result = await adapter._levelCurrentTrader({ maxTrades: 5, deadline: Date.now() + 5000 });
  assert.equal(result.ok, true);
  assert.equal(result.maxed, true);
  assert.equal(result.trades, 0);
});

test('_levelCurrentTrader loops cheap trades until they are exhausted', async () => {
  const adapter = spawnedAdapter();
  adapter._openContainer = { id: 5, type: 'trading' };
  adapter.tradeOffers = [{ buyA: { item: 'paper', count: 24 }, sell: { item: 'emerald', count: 1 }, uses: 0, maxUses: 2 }];
  adapter.inventory = { paper: 48 };
  adapter.tradeTarget = { runtimeId: '42' };
  adapter.tradeTier = 0;
  let calls = 0;
  adapter._tradeAt = async () => { calls++; return { ok: true, received: 1 }; };
  const result = await adapter._levelCurrentTrader({ maxTrades: 10, deadline: Date.now() + 5000 });
  assert.equal(calls, 2, 'two uses then the offer is exhausted');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no_economical_trade');
});

test('_levelTrader targets the matching profession and excludes wandering traders', async () => {
  const adapter = spawnedAdapter();
  adapter._trackEntity({ runtime_id: 40n, unique_id: 900n, entity_type: 'minecraft:villager', position: { x: 3, y: 63, z: 0 } }, 'mob');
  adapter._trackEntity({ runtime_id: 41n, unique_id: 901n, entity_type: 'minecraft:villager', position: { x: 5, y: 63, z: 0 } }, 'mob');
  adapter._trackEntity({ runtime_id: 42n, unique_id: 902n, entity_type: 'minecraft:wandering_trader', position: { x: 1, y: 63, z: 0 } }, 'mob');
  adapter.entities.get('40').professionName = 'Farmer';
  adapter.entities.get('41').professionName = 'Cartographer';
  const opened = [];
  adapter._openTradeWithEntity = async (entity) => {
    opened.push(entity.runtimeId);
    adapter.tradeDisplayName = adapter.entities.get(entity.runtimeId).professionName;
    adapter.tradeOffers = [{ buyA: { item: 'paper', count: 24 }, sell: { item: 'emerald', count: 1 }, uses: 0, maxUses: 1 }];
    adapter.tradeTarget = { runtimeId: entity.runtimeId };
    return { ok: true };
  };
  adapter._levelCurrentTrader = async () => ({ ok: true, maxed: false, tier: 1, trades: 1 });
  adapter.inventory = { paper: 48 };
  const result = await adapter._levelTrader({ profession: 'cartographer' });
  assert.equal(result.ok, true);
  assert.deepEqual(opened, ['41'], 'only the cartographer is opened, not the farmer nor the wandering trader');
});

test('options offer level_<profession> and skip traders already at max tier', () => {
  const adapter = spawnedAdapter();
  adapter._trackEntity({ runtime_id: 40n, unique_id: 900n, entity_type: 'minecraft:villager', position: { x: 3, y: 63, z: 0 } }, 'mob');
  const entity = adapter.entities.get('40');
  entity.professionName = 'Cartographer';
  entity.tradeTier = 1;
  entity.maxTradeTier = 4;
  let keys = adapter.options().map(o => o.key);
  assert.ok(keys.includes('level_cartographer'), 'offered when below max tier');

  entity.tradeTier = 4;
  keys = adapter.options().map(o => o.key);
  assert.ok(!keys.includes('level_cartographer'), 'not offered when already maxed');
});

test('options offer a generic level_trader when profession is unknown', () => {
  const adapter = spawnedAdapter();
  adapter._trackEntity({ runtime_id: 40n, unique_id: 900n, entity_type: 'minecraft:villager', position: { x: 3, y: 63, z: 0 } }, 'mob');
  const keys = adapter.options().map(o => o.key);
  assert.ok(keys.includes('level_trader'));
  assert.ok(!keys.some(k => k.startsWith('level_') && k !== 'level_trader'));
});
