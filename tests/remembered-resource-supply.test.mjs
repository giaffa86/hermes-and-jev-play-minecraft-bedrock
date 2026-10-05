import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constructionAdapter } from './fixtures/construction-adapter.mjs';
import { naturalGatherCandidates } from '../remembered-resource-sites.mjs';

const PLANKS = { descriptor_type: 'item_tag', tag: 'planks' };
const origin = { x: 0, y: 64, z: 0 };
function setup () {
  const fixture = constructionAdapter();
  const a = fixture.adapter;
  a.setPlan({ targets: {}, construction: { type: 'platform', origin, parameters: { width: 3, length: 3, palette: { floor: 'oak_planks' } } } });
  a.recipes = new Map([['oak_planks', [{ network_id: 1 }]]]);
  a.craftingData = { shapeless_recipes: [{ network_id: 1, width: 1, height: 1,
    input: [{ type: 'valid', descriptor_type: 'name', name: 'minecraft:oak_log', count: 1 }] }] };
  return fixture;
}
function remember (a, id = 'resource_site_-1_0', position = { x: -7, y: 64, z: 0 }, observations = ['oak_log']) {
  return a.memory.rememberResourceSite({ id, position, dimension: a.dimension, observations });
}
function tree (fixture, { available = () => true, position = { x: -8, y: 64, z: 0 }, name = 'oak_log' } = {}) {
  fixture.put(position, name);
  fixture.adapter.world.findBlocks = queried => queried === name && available()
    && fixture.adapter.world.blockAt(position)?.name === name
    ? [{ name, position, distance: Math.hypot(position.x - fixture.adapter.position.x, position.z - fixture.adapter.position.z), diggable: true, hardness: 1 }] : [];
}

test('valid remembered site: waypoint, re-observe, then a live offered gather action', async () => {
  const f = setup(), a = f.adapter;
  remember(a);
  tree(f, { available: () => a.position.x < -5 });
  const choice = a.construction.supplyChoice('oak_planks');
  assert.equal(choice.type, 'remembered_resource_site');
  assert.equal(choice.key, 'goto_waypoint');
  assert.equal(a.options({ localGatherOnly: true }).some(o => o.key === 'mine_oak_log'), false);
  let observations = 0;
  const observe = a.observe.bind(a);
  a.observe = () => { observations++; return observe(); };
  const visited = await a.executeAction('construction_supply');
  assert.equal(visited.ok, true);
  assert.equal(visited.result.reobserved, true);
  assert.ok(observations > 0);
  assert.equal(f.events.mined.length, 0, 'navigation never mines a remembered cell');
  assert.ok(a.options({ localGatherOnly: true }).some(o => o.key === 'mine_oak_log'));
  assert.equal(a.construction.supplyChoice('oak_planks').key, 'mine_oak_log');
  const gathered = await a.executeAction('construction_supply');
  assert.equal(gathered.ok, true, JSON.stringify(gathered));
  assert.deepEqual(f.events.mined, [{ x: -8, y: 64, z: 0 }], 'the live tree differs from the historical waypoint');
});

test('stale empty site falls back to live census without revisiting or mining history', async () => {
  const f = setup(), a = f.adapter;
  const site = remember(a);
  a.memory.repo.upsert({ ...site, status: 'stale', lastSeenAt: Date.now() - 86400000 });
  const step = a._gatherStepFor(PLANKS, new Set(['mine_spruce_log']));
  assert.equal(step.key, 'goto_waypoint', 'memory precedes local gathering');
  assert.equal((await a.resourceSites.navigate(step)).reobserved, true);
  assert.equal(a._gatherStepFor(PLANKS, new Set(['mine_spruce_log'])).key, 'mine_spruce_log');
  assert.equal(a._gatherStepFor(PLANKS, new Set()), null);
  assert.equal(f.events.mined.length, 0);
});

test('invalid, wrong-dimension and unreachable sites are excluded; local gather remains available', () => {
  const f = setup(), a = f.adapter;
  const site = remember(a);
  a.memory.repo.upsert({ ...site, status: 'invalid' });
  assert.equal(a._gatherStepFor(PLANKS, new Set(['mine_oak_log'])).key, 'mine_oak_log');
  a.memory.repo.upsert({ ...site, dimension: 'nether' });
  assert.equal(a._gatherStepFor(PLANKS, new Set()), null);
  a.memory.repo.upsert(site);
  a.placeReach = () => ({ reachable: false, reason: 'unreachable' });
  assert.equal(a._gatherStepFor(PLANKS, new Set(['mine_oak_log'])).source, 'gather');
  a.placeReach = () => ({ reachable: true, reason: 'reachability_unknown' });
  a._findPath = () => null;
  assert.equal(a._gatherStepFor(PLANKS, new Set()), null);
});

test('route failure falls back locally and never repeatedly offers the failed site', async () => {
  const f = setup(), a = f.adapter;
  remember(a);
  const step = a._gatherStepFor(PLANKS, new Set());
  a._moveTo = async () => { throw new Error('path_failed'); };
  const result = await a.resourceSites.navigate(step);
  assert.equal(result.error, 'path_failed');
  assert.equal(result.reobserved, true);
  assert.equal(a._gatherStepFor(PLANKS, new Set(['mine_oak_log'])).key, 'mine_oak_log');
  assert.equal(a._gatherStepFor(PLANKS, new Set()), null);
});

test('multiple compatible sites rank by compatibility, distance and freshness with live reachability', () => {
  const { adapter: a } = setup();
  const stale = remember(a, 'resource_site_old', { x: -6, y: 64, z: 0 });
  a.memory.repo.upsert({ ...stale, status: 'stale', lastSeenAt: Date.now() - 86400000 });
  remember(a, 'resource_site_fresh_far', { x: -15, y: 64, z: 0 });
  remember(a, 'resource_site_fresh_near', { x: -7, y: 64, z: 0 });
  const weak = remember(a, 'resource_site_tag', { x: 1, y: 64, z: 0 }, []);
  a.memory.repo.upsert({ ...weak, tags: ['oak_log'] });
  const ranked = a.resourceSites.ranked(naturalGatherCandidates(PLANKS));
  assert.equal(ranked[0].site.id, 'resource_site_fresh_near');
  assert.ok(ranked.findIndex(r => r.site.id === 'resource_site_fresh_far') < ranked.findIndex(r => r.site.id === 'resource_site_old'));
  assert.equal(ranked.at(-1).site.id, 'resource_site_tag');
});

test('no remembered site: construction uses only a live local option', () => {
  const f = setup();
  tree(f, { position: { x: -2, y: 64, z: 0 } });
  assert.equal(f.adapter.construction.supplyChoice('oak_planks').key, 'mine_oak_log');
  f.adapter.options = () => [];
  assert.equal(f.adapter.construction.supplyChoice('oak_planks'), null, 'a live block alone does not authorize gathering');
});

test('no source, including an empty remembered site: explicit missingMaterials evidence', async () => {
  for (const withMemory of [false, true]) {
    const f = setup(), a = f.adapter;
    if (withMemory) {
      remember(a);
      assert.equal((await a.executeAction('construction_supply')).ok, true);
    }
    const result = await a.executeAction('construction_supply');
    assert.equal(result.error, 'construction_materials_unavailable');
    assert.ok(a.construction.project.lastError.details.some(row => row.item === 'oak_planks' && row.missing > 0));
    assert.equal(f.events.mined.length, 0);
  }
});

test('project cells, persistent placements, owned blocks and DIG_PROTECTED never become gather targets', () => {
  const f = setup(), a = f.adapter;
  const block = position => ({ name: 'oak_log', position, diggable: true });
  assert.equal(a._pickMineTarget([block(origin)]), null);
  const pos = { x: -2, y: 64, z: 0 };
  a.memory.rememberPlacement({ position: pos, block: 'oak_log' });
  assert.equal(a._pickMineTarget([block(pos)]), null);
  const owned = { x: -3, y: 64, z: 0 };
  a._placedBlocks.set('-3,64,0', { block: 'oak_log' });
  assert.equal(a._pickMineTarget([block(owned)]), null);
  assert.equal(a._pickMineTarget([{ ...block({ x: -4, y: 64, z: 0 }), name: 'chest' }]), null);
});

test('general crafting exposes and executes the same provider, preserving the planner waypoint', async () => {
  const f = setup(), a = f.adapter;
  const plannerWaypoint = { x: 12, z: 12 };
  a.setPlan({ targets: { oak_planks: 4 }, waypoint: plannerWaypoint });
  remember(a, 'resource_site_general', { x: -7, y: 65.62, z: 0 });
  tree(f, { available: () => a.position.x < -5 });
  // Model eye-height site coordinates produced by the existing memory census.
  // The fixture moves to standable feet coordinates, as real _moveTo does.
  const move = a._moveTo.bind(a);
  a._moveTo = (target, ...args) => move({ ...target, y: 64 }, ...args);
  assert.equal(a.observe().craft.next.source, 'remembered_resource_site');
  assert.ok(a.options().some(option => option.key === 'goto_waypoint'));
  assert.equal((await a.executeAction('goto_waypoint')).ok, true);
  assert.deepEqual(a.plan.waypoint, plannerWaypoint);
  assert.equal(f.events.mined.length, 0);
  assert.equal(a.observe().craft.next.key, 'mine_oak_log');
  a.options();
  const result = await a.executeAction('mine_oak_log');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.events.mined.length, 1);
});

test('general crafting rechecks the offered gather key when the live resource disappears', async () => {
  const f = setup(), a = f.adapter;
  a.setPlan({ targets: { oak_planks: 4 } });
  let available = true;
  tree(f, { position: { x: -2, y: 64, z: 0 }, available: () => available });
  a._refreshNearby();
  assert.ok(a.options().some(option => option.key === 'mine_oak_log'));
  available = false;
  assert.equal((await a.executeAction('mine_oak_log')).error, 'gather_not_offered');
  assert.equal(f.events.mined.length, 0);
});

test('consolidated productivity is a historical location hint, never a gather authorization', () => {
  const { adapter: a } = setup();
  const site = remember(a, 'resource_site_productive', { x: -7, y: 64, z: 0 }, []);
  a.memory.repo.upsert({ ...site, productivity: { coal: { found: 4, successes: 1 } } });
  assert.equal(a._gatherStepFor({ name: 'coal' }, new Set()).site, site.id);
  assert.equal(a._gatherStepFor({ name: 'oak_log' }, new Set()), null);
});

test('a site invalidated after selection is rechecked before navigation', async () => {
  const f = setup(), a = f.adapter;
  const site = remember(a);
  const step = a._gatherStepFor(PLANKS, new Set());
  a.memory.repo.upsert({ ...site, status: 'invalid' });
  assert.equal((await a.resourceSites.navigate(step)).error, 'resource_site_invalid');
  assert.equal(f.events.moves.length, 0);
  assert.equal(a._gatherStepFor(PLANKS, new Set(['mine_spruce_log'])).key, 'mine_spruce_log');
});

test('crop sites choose only a live harvest key; memory never offers mine or harvest by itself', async () => {
  const { adapter: a } = setup();
  remember(a, 'resource_site_crops', { x: -7, y: 64, z: 0 }, ['potatoes']);
  const ingredient = { descriptor_type: 'name', name: 'minecraft:potato' };
  const step = a._gatherStepFor(ingredient, new Set(['mine_potatoes']));
  assert.equal(step.key, 'goto_waypoint');
  await a.resourceSites.navigate(step);
  assert.equal(a._gatherStepFor(ingredient, new Set(['mine_potatoes'])), null);
  assert.equal(a._gatherStepFor(ingredient, new Set(['harvest_potatoes'])).key, 'harvest_potatoes');
});
