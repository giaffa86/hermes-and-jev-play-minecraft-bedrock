import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BedrockAdapter } from '../bedrock-adapter.mjs';
import { createWorldMemory } from '../world-memory.mjs';
import { STORAGE_RUNG, STORAGE_STEP } from '../storage-ladder.mjs';

// V1+V2: la ricerca del baule parte dal *registro* (cosa il bot ha già visto e
// letto) e solo dopo guarda il mondo. Il fixture è minimale di proposito: nessun
// modello di raggiungibilità (filtri spenti, fail-open) e nessuna finestra vera,
// così ogni asserzione riguarda la decisione, non il pathfinding.
function adapterWithMemory () {
  const dir = mkdtempSync(join(tmpdir(), 'storage-memory-'));
  const memory = createWorldMemory({ dir, backend: 'json', logger: { warn () {} } });
  const adapter = new BedrockAdapter({ logger: { log () {} }, memory });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.position = { x: 0, y: 64, z: 0 };
  adapter._feet = { x: 0, y: 64, z: 0 };
  adapter._reachabilityUsable = () => false; // nessun modello: fail-open
  adapter.inventorySlots = [];
  adapter.inventory = {};
  adapter.drops = [];
  adapter.nearbyBlocks = {};
  adapter.client = { write: () => {} };
  adapter.world.findBlocks = () => [];
  adapter._closeContainer = async () => {
    adapter._openContainer = null;
    adapter._openContainerBlock = null;
    adapter._openContainerSlots = [];
  };
  return { adapter, memory, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function seedCache (adapter, { x = 2, y = 64, z = 0, type = 'chest', contents = {} } = {}) {
  adapter.containers.set(`${x},${y},${z}`, { type, position: { x, y, z }, readAt: Date.now(), contents });
}

test('a remembered chest that already holds the item wins over a nearer empty one', () => {
  const { adapter, memory, cleanup } = adapterWithMemory();
  try {
    // Il riavvio: la cache runtime è vuota, il registro sa dov'è il ferro.
    memory.rememberContainer({ position: { x: 10, y: 64, z: 0 }, type: 'chest', contents: { iron_ingot: 5 } });
    seedCache(adapter, { x: 2, contents: {} });
    const target = adapter._depositTargetFor('iron_ingot');
    assert.equal(target.position.x, 10, 'vince il baule che contiene già l\'item, non il più vicino');
    assert.equal(target.remembered, true, 'il bersaglio viene dal registro');
    assert.equal(target.rung, STORAGE_RUNG.KNOWN_ITEM);
    assert.equal(target.step, STORAGE_STEP.TAKE);
    assert.equal(target.verify, false, 'una lettura fresca non va ri-verificata');
    assert.equal(target.contents.iron_ingot, 5, 'il contenuto ricordato accompagna il bersaglio');
    assert.equal(target.ladder.length, 4, 'la scala intera è dichiarata');
  } finally { cleanup(); }
});

test('a stale inspection is still the target, but only as a candidate to re-read', () => {
  const { adapter, memory, cleanup } = adapterWithMemory();
  try {
    const observedAt = Date.now() - 6 * 60 * 1000; // oltre CONTAINER_INSPECTED_STALE_MS (5 min)
    memory.rememberContainer({ position: { x: 10, y: 64, z: 0 }, type: 'chest', contents: { iron_ingot: 5 }, observedAt });
    const target = adapter._depositTargetFor('iron_ingot');
    assert.equal(target.remembered, true);
    assert.equal(target.rung, STORAGE_RUNG.KNOWN_ITEM);
    assert.equal(target.stale, true, 'la riga è vecchia');
    assert.equal(target.verify, true, 'e va riletta prima di dichiarare il deposito');
  } finally { cleanup(); }
});

test('a discovered container nobody opened is the second rung, not a scan', () => {
  const { adapter, memory, cleanup } = adapterWithMemory();
  try {
    memory.rememberContainer({ position: { x: 6, y: 64, z: 0 }, type: 'barrel', contentsKnown: false, source: 'discovered' });
    const target = adapter._depositTargetFor('iron_ingot');
    assert.equal(target.position.x, 6);
    assert.equal(target.rung, STORAGE_RUNG.INSPECT);
    assert.equal(target.step, STORAGE_STEP.INSPECT);
    assert.equal(target.remembered, true);
    assert.deepEqual(target.contents, {}, 'il contenuto è ignoto, non vuoto');
  } finally { cleanup(); }
});

test('with an empty register the live scan finds the block and remembers the discovery', () => {
  const { adapter, memory, cleanup } = adapterWithMemory();
  try {
    adapter.world.findBlocks = name => (name === 'chest' ? [{ name: 'chest', position: { x: 4, y: 64, z: 0 }, distance: 4 }] : []);
    const target = adapter._depositTargetFor('iron_ingot');
    assert.equal(target.position.x, 4);
    assert.equal(target.rung, STORAGE_RUNG.LOCAL, 'nessuna riga di registro: si guarda il mondo');
    assert.equal(target.step, STORAGE_STEP.REMEMBER);
    assert.equal(target.remembered, false, 'una scansione viva non è una riga ricordata');
    const toInspect = memory.containersToInspect();
    assert.equal(toInspect.length, 1, 'il baule visto adesso è una scoperta, non un contenuto');
    assert.equal(toInspect[0].contentsKnown, false);
    // Il registro ha imparato: la prossima volta il baule è il gradino 2, senza
    // toccare il mondo.
    adapter.world.findBlocks = () => [];
    const second = adapter._depositTargetFor('iron_ingot');
    assert.equal(second.position.x, 4);
    assert.equal(second.rung, STORAGE_RUNG.INSPECT);
  } finally { cleanup(); }
});

test('a remembered target that the bot cannot reach is blocked, and the reachable one wins', () => {
  const { adapter, memory, cleanup } = adapterWithMemory();
  try {
    memory.rememberContainer({ position: { x: 60, y: 64, z: 0 }, type: 'chest', contents: { iron_ingot: 5 } });
    memory.rememberContainer({ position: { x: 5, y: 64, z: 0 }, type: 'chest', contents: { iron_ingot: 5 } });
    adapter._reachabilityUsable = () => true;
    adapter.approachReachable = position => position.x < 50;
    const plan = adapter._storageSearchPlan('iron_ingot');
    assert.equal(plan.target.position.x, 5, 'si sceglie per distanza raggiungibile');
    assert.equal(plan.blocked.length, 1);
    assert.equal(plan.blocked[0].position.x, 60);
    assert.equal(plan.blocked[0].reason, 'unreachable');
  } finally { cleanup(); }
});

test('the discovery census skips what is not storage, and writes nothing', () => {
  const { adapter, memory, cleanup } = adapterWithMemory();
  try {
    const written = adapter._rememberStorageDiscovery({ name: 'ender_chest', position: { x: 3, y: 64, z: 0 } });
    assert.equal(written, false);
    assert.equal(memory.containersToInspect().length, 0, 'un blocco non-storage non entra nel registro');
  } finally { cleanup(); }
});

test('the survey writes discoveries once, throttles, and shows up in observe().storage', () => {
  const { adapter, memory, cleanup } = adapterWithMemory();
  try {
    adapter.world.findBlocks = name => (name === 'chest' ? [{ name: 'chest', position: { x: 8, y: 64, z: 0 }, distance: 8 }] : []);
    const first = adapter._surveyStorage();
    assert.equal(first.scanned, 1);
    assert.equal(first.discovered, 1);
    assert.equal(memory.containersToInspect().length, 1);
    // Throttled: entro STORAGE_DISCOVERY_RESCAN_MS non si ri-scansiona...
    adapter.world.findBlocks = name => (name === 'barrel' ? [{ name: 'barrel', position: { x: 9, y: 64, z: 0 }, distance: 9 }] : []);
    assert.equal(adapter._surveyStorage().discovered, 1);
    assert.equal(memory.containersToInspect().length, 1);
    // ...ma un censimento esplicito sì.
    assert.equal(adapter._surveyStorage({ force: true }).discovered, 1);
    assert.equal(memory.containersToInspect().length, 2);
    const view = adapter.observe().storage;
    assert.equal(view.checked, true);
    assert.equal(view.toInspect.length, 2);
    assert.equal(view.known.length, 0);
    assert.equal(view.survey.scanned, 1);
  } finally { cleanup(); }
});

test('a failed re-read of a remembered target falls back to the live container, once', async () => {
  const { adapter, memory, cleanup } = adapterWithMemory();
  try {
    memory.rememberContainer({ position: { x: 10, y: 64, z: 0 }, type: 'chest', contents: { iron_ingot: 5 } });
    seedCache(adapter, { x: 2, contents: {} });
    const calls = [];
    adapter._depositStackInto = async (target, itemName, options) => {
      calls.push({ target, options });
      return calls.length === 1 ? { ok: false, error: 'storage_unreachable' } : { ok: true, item: itemName, count: 1 };
    };
    const target = adapter._depositTargetFor('iron_ingot');
    const result = await adapter._depositStackWithFallback(target, 'iron_ingot');
    assert.equal(result.ok, true);
    assert.equal(result.retriedAfterStale, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].target.remembered, true);
    assert.equal(calls[1].target.remembered, false, 'il ripiego non ripassa dal registro');
    assert.equal(calls[1].options.base, null, 'il contenuto accumulato era del vecchio baule');
  } finally { cleanup(); }
});

test('a missing item is never retried: the target was right, the item was not there', async () => {
  const { adapter, memory, cleanup } = adapterWithMemory();
  try {
    memory.rememberContainer({ position: { x: 10, y: 64, z: 0 }, type: 'chest', contents: { iron_ingot: 5 } });
    seedCache(adapter, { x: 2, contents: {} });
    const calls = [];
    adapter._depositStackInto = async (target, itemName) => {
      calls.push(target);
      return { ok: false, error: 'missing_item' };
    };
    const target = adapter._depositTargetFor('iron_ingot');
    const result = await adapter._depositStackWithFallback(target, 'iron_ingot');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'missing_item');
    assert.equal(calls.length, 1, 'nessun ripiego: il baule era quello giusto');
  } finally { cleanup(); }
});

test('observe().deposit declares the rung and the remembered flag without walking', () => {
  const { adapter, memory, cleanup } = adapterWithMemory();
  try {
    memory.rememberContainer({ position: { x: 10, y: 64, z: 0 }, type: 'chest', contents: { cobblestone: 12 } });
    adapter.inventory = { cobblestone: 64, iron_pickaxe: 1 };
    const state = adapter.observe().deposit;
    assert.deepEqual(state.items, [{ item: 'cobblestone', count: 64 }]);
    assert.equal(state.target.remembered, true);
    assert.equal(state.target.rung, STORAGE_RUNG.KNOWN_ITEM);
    assert.equal(state.target.position.x, 10);
    assert.equal(state.ladder.length, 4);
  } finally { cleanup(); }
});
