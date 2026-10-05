import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveIdleGoals, nextIdleGoal, isNeedResolved,
  DEFAULT_AUTONOMY_COOLDOWN_MS,
} from '../idle-goals.mjs';

const base = (over = {}) => ({
  position: { x: 0, y: 64, z: 0 },
  spawned: true,
  dead: false,
  health: 20,
  food: 20,
  inventory: {},
  entities: [],
  time: { ticks: 1000, night: false },
  ...over,
});

test('no candidates without world state or while dead', () => {
  assert.deepEqual(deriveIdleGoals({}), []);
  assert.deepEqual(deriveIdleGoals(base({ dead: true, health: 0 })), []);
});

test('low food with food in inventory produces the eat goal', () => {
  const goals = deriveIdleGoals(base({ food: 10, inventory: { bread: 2 } }));
  const eat = goals.find(g => g.need === 'eat');
  assert.ok(eat, 'eat candidate missing');
  assert.match(eat.objective, /Eat food/);
  assert.equal(eat.source, 'autonomous');
  assert.equal(eat.priority, 20);
});

test('night without a bed produces the shelter goal', () => {
  const goals = deriveIdleGoals(base({ time: { ticks: 13000, night: true } }));
  assert.ok(goals.some(g => g.need === 'shelter'));
  assert.ok(!goals.some(g => g.need === 'sleep'));
});

test('a nearby creeper at low health is an EMERGENCY escape goal ranked first', () => {
  const threats = [{ type: 'creeper', distance: 4, hostile: true, position: { x: 4, y: 64, z: 0 } }];
  const goals = deriveIdleGoals(base({ health: 8, entities: threats }));
  assert.equal(goals[0].need, 'escape');
  assert.equal(goals[0].source, 'emergency');
  assert.equal(goals[0].priority, 100);
});

test('continue_progression is never produced (no resolvable state)', () => {
  const goals = deriveIdleGoals(base());
  assert.ok(!goals.some(g => g.need === 'continue_progression'));
});

test('nextIdleGoal honours the per-need cooldown', () => {
  const obs = base({ time: { ticks: 13000, night: true } });
  const now = 1_000_000;
  const attempts = new Map([['shelter', now - 1000]]);
  assert.equal(nextIdleGoal(obs, { attempts, now, cooldownMs: DEFAULT_AUTONOMY_COOLDOWN_MS }), null);
  const later = nextIdleGoal(obs, { attempts, now, cooldownMs: 500 });
  assert.equal(later.need, 'shelter');
});

test('isNeedResolved: wear_armor is about what is worn, not what is carried', () => {
  // Un ordine "equipaggiati" ha come criterio l'armatura *addosso*: un elmo in
  // inventario non basta a chiudere il goal.
  assert.equal(isNeedResolved('wear_armor', base({ inventory: { iron_helmet: 1 } })), false);
  assert.equal(isNeedResolved('wear_armor', base({ armor: { helmet: null, chestplate: null, leggings: null, boots: null } })), false);
  assert.equal(isNeedResolved('wear_armor', base({ inventory: { iron_helmet: 1 }, armor: { helmet: 'iron_helmet', chestplate: null, leggings: null, boots: null } })), true);
});

test('isNeedResolved: eat, sleep, obtain_food, escape, replace_tool', () => {
  assert.equal(isNeedResolved('eat', base({ food: 10, inventory: { bread: 1 } })), false);
  assert.equal(isNeedResolved('eat', base({ food: 18, inventory: { bread: 1 } })), true);

  assert.equal(isNeedResolved('sleep', base({ time: { ticks: 13000, night: true } })), false);
  assert.equal(isNeedResolved('sleep', base()), true);

  assert.equal(isNeedResolved('obtain_food', base({ food: 10, inventory: {} })), false);
  assert.equal(isNeedResolved('obtain_food', base({ food: 10, inventory: { bread: 1 } })), true);

  const threat = { type: 'zombie', distance: 6, hostile: true, position: { x: 6, y: 64, z: 0 } };
  assert.equal(isNeedResolved('escape', base({ entities: [threat] })), false);
  assert.equal(isNeedResolved('escape', base()), true);

  assert.equal(isNeedResolved('replace_tool', base({ heldDurability: { damage: 58, max: 59 } })), false);
  assert.equal(isNeedResolved('replace_tool', base({ heldDurability: { damage: 1, max: 59 } })), true);
});
