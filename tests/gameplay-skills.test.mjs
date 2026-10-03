// Unit test della libreria gameplay: schema, loader, resolver, verifica
// deterministica e statistiche di esperienza. Nessun server richiesto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadGameplaySkills, validateSkill, validateCriteria,
  filterOptionsForGovernor, resolveActiveSkill, skillApplicable, skillPreferredIntents,
  optionIntents, keyMatchesIntents,
  verifySkill, evaluateCriteria,
  buildSkillRecord, appendSkillRecord,
} from '../survival/index.mjs';

const skills = loadGameplaySkills();

test('the shipped gameplay skill library loads and validates', () => {
  for (const id of [
    'acquire_wood', 'acquire_crafting_table', 'stone_age', 'obtain_food',
    'eat_available_food', 'escape_hostile', 'emergency_shelter', 'first_night',
    'acquire_iron', 'acquire_diamonds', 'enter_nether',
    'nether_portal', 'nether_survival', 'piglin_barter', 'obtain_blaze_rods',
    'obtain_ender_pearls', 'craft_eyes_of_ender', 'find_stronghold', 'enter_end',
    'beat_the_dragon',
    'redstone_basics', 'craft_redstone_part', 'build_lamp_switch',
    'build_auto_lamp', 'build_auto_harvest', 'build_hopper_chain',
  ]) {
    assert.ok(skills.has(id), `skill ${id}`);
  }
  assert.equal(loadGameplaySkills().size, skills.size);
});

test('the redstone skills declare the circuit they build instead of trusting a step count', () => {
  for (const [id, circuit] of [
    ['build_lamp_switch', 'lamp_switch'],
    ['build_auto_lamp', 'auto_lamp'],
    ['build_auto_harvest', 'auto_harvest'],
    ['build_hopper_chain', 'hopper_chain'],
  ]) {
    const def = skills.get(id);
    assert.deepEqual(def.success, { circuitBuilt: { id: circuit } }, `${id} success`);
    assert.ok(def.intents.includes('build'), `${id} intents`);
  }
  // Le skill dei blueprint bloccati lo dicono nel proprio notes: chi legge la
  // libreria non deve dedurre la raggiungibilità dal solo nome.
  assert.match(skills.get('build_auto_harvest').notes, /NON raggiungibile/);
  assert.match(skills.get('build_hopper_chain').notes, /NON raggiungibile/);
});

test('validateSkill rejects unknown intents, unknown tags and missing fields', () => {
  assert.ok(validateSkill({ description: 'no id' }).some(error => error.includes('missing id')));
  assert.ok(validateSkill({ id: 'x' }).some(error => error.includes('missing description')));
  assert.ok(validateSkill({ id: 'x', description: 'x', intents: ['teleport'] }).some(error => error.includes('unknown intent')));
  assert.ok(validateSkill({ id: 'x', description: 'x', success: { inventoryTagGte: { unicorns: 1 } } })
    .some(error => error.includes('unknown item tag')));
  assert.ok(validateSkill({ id: 'x', description: 'x', success: { nonsense: true } })
    .some(error => error.includes('unknown criterion')));
});

test('validateCriteria accepts nested allOf/anyOf', () => {
  assert.deepEqual(validateCriteria({ anyOf: [{ inventoryGte: { oak_log: 1 } }, { allOf: [{ phaseIn: ['day'] }] }] }), []);
});

// ---- intenti -------------------------------------------------------------------------

test('option keys map to the shared intent vocabulary', () => {
  assert.deepEqual(optionIntents('flee'), ['escape']);
  assert.deepEqual(optionIntents('eat'), ['eat', 'heal']);
  assert.deepEqual(optionIntents('mine_oak_log'), ['mine']);
  assert.deepEqual(optionIntents('attack_zombie'), ['fight']);
  // Nether (N1): camminare verso un portale — e attraversarlo — è viaggio,
  // costruirlo e accenderlo è costruzione.
  assert.deepEqual(optionIntents('goto_portal'), ['travel']);
  assert.deepEqual(optionIntents('enter_portal'), ['travel']);
  assert.deepEqual(optionIntents('build_portal'), ['build']);
  assert.deepEqual(optionIntents('light_portal'), ['build']);
  // Nether (N2): un hub è un rifugio e un punto di rientro.
  assert.deepEqual(optionIntents('build_nether_hub'), ['build', 'shelter']);
  assert.deepEqual(optionIntents('dodge_projectile'), ['escape', 'travel']);
  assert.deepEqual(optionIntents('barter_piglin'), ['barter', 'collect']);
  assert.deepEqual(optionIntents('avoid_enderman_gaze'), ['escape', 'shelter']);
  assert.deepEqual(optionIntents('equip_pumpkin'), ['heal', 'shelter']);
  assert.deepEqual(optionIntents('place_crafting_table'), ['build']);
  assert.deepEqual(optionIntents('goto_waypoint'), ['travel']);
  assert.deepEqual(optionIntents('wait'), ['wait']);
  // Difesa: le nuove azioni entrano nel vocabolario condiviso.
  assert.deepEqual(optionIntents('go_home'), ['escape', 'shelter']);
  assert.deepEqual(optionIntents('retreat'), ['escape', 'shelter']);
  assert.deepEqual(optionIntents('close_door'), ['shelter']);
  assert.deepEqual(optionIntents('barricade'), ['shelter']);
  assert.deepEqual(optionIntents('equip_armor'), ['heal']);
  assert.deepEqual(optionIntents('place_torch'), ['build', 'shelter']);
  assert.ok(keyMatchesIntents('mine_stone', ['mine', 'travel']));
  assert.ok(!keyMatchesIntents('craft_stick', ['mine']));
});

test('a creeper emergency keeps escape/shelter defence and drops the melee attack', () => {
  const offered = [
    { key: 'attack_creeper', description: 'Attack the creeper' },
    { key: 'flee', description: 'Run away' },
    { key: 'go_home', description: 'Return home' },
    { key: 'retreat', description: 'Retreat home' },
    { key: 'barricade', description: 'Seal the opening' },
    { key: 'close_door', description: 'Close the door' },
    { key: 'mine_stone', description: 'Mine stone' },
  ];
  const { options } = filterOptionsForGovernor(offered, { mode: 'emergency', allowedIntents: ['escape', 'shelter'] });
  const keys = options.map(o => o.key);
  assert.ok(keys.includes('flee'));
  assert.ok(keys.includes('go_home'));
  assert.ok(keys.includes('retreat'));
  assert.ok(keys.includes('barricade'));
  assert.ok(keys.includes('close_door'));
  assert.ok(!keys.includes('attack_creeper'), 'nessun melee contro il creeper');
  assert.ok(!keys.includes('mine_stone'));
});

// ---- resolver: filtro in emergenza ----------------------------------------------------

const OFFERED = [
  { key: 'mine_oak_log', description: 'Mine oak_log' },
  { key: 'craft_oak_planks', description: 'Craft planks' },
  { key: 'collect_drop', description: 'Collect drop' },
  { key: 'flee', description: 'Run away' },
  { key: 'eat', description: 'Eat bread' },
  { key: 'wait', description: 'Wait' },
];

test('the governor filter keeps only allowed intents from offered keys', () => {
  const { options, filtered, removed } = filterOptionsForGovernor(OFFERED, { mode: 'emergency', allowedIntents: ['escape', 'eat', 'heal'] });
  assert.equal(filtered, true);
  assert.deepEqual(options.map(o => o.key), ['flee', 'eat']);
  assert.deepEqual(removed.map(entry => entry.key).sort(), ['collect_drop', 'craft_oak_planks', 'mine_oak_log', 'wait']);
});

test('the governor filter leaves options untouched outside emergencies', () => {
  const result = filterOptionsForGovernor(OFFERED, { mode: 'caution', allowedIntents: ['eat'] });
  assert.equal(result.filtered, false);
  assert.equal(result.options, OFFERED);
});

test('the governor filter never empties the option set', () => {
  const onlyMining = [{ key: 'mine_stone' }, { key: 'wait' }];
  const result = filterOptionsForGovernor(onlyMining, { mode: 'emergency', allowedIntents: ['sleep'] });
  assert.equal(result.filtered, false);
  assert.equal(result.reason, 'no_allowed_option');
  assert.deepEqual(result.options.map(o => o.key), ['mine_stone', 'wait']);
});

test('the governor filter never invents keys', () => {
  const { options } = filterOptionsForGovernor(OFFERED, { mode: 'emergency', allowedIntents: ['escape'] });
  for (const option of options) assert.ok(OFFERED.includes(option));
});

// ---- resolver: skill attiva -----------------------------------------------------------

test('resolveActiveSkill prefers the governor skill in an emergency over the plan', () => {
  const active = resolveActiveSkill({
    skills,
    plan: { skill: 'acquire_wood' },
    governor: { mode: 'emergency', preferredSkills: ['escape_hostile'] },
    observation: { inventory: {} },
  });
  assert.equal(active.skill.id, 'escape_hostile');
  assert.equal(active.source, 'governor');
});

test('resolveActiveSkill follows the plan skill when conditions are normal', () => {
  const active = resolveActiveSkill({
    skills,
    plan: { skill: 'acquire_wood' },
    governor: { mode: 'normal', preferredSkills: [] },
    milestone: { skill: 'stone_age' },
    observation: { inventory: {} },
  });
  assert.equal(active.skill.id, 'acquire_wood');
  assert.equal(active.source, 'plan');
});

test('resolveActiveSkill falls back to the progression milestone', () => {
  const active = resolveActiveSkill({
    skills,
    plan: {},
    governor: { mode: 'normal', preferredSkills: ['not_a_skill'] },
    milestone: { skill: 'stone_age' },
    observation: { inventory: {} },
  });
  assert.equal(active.skill.id, 'stone_age');
  assert.equal(active.source, 'progression');
});

test('resolveActiveSkill skips skills whose preconditions are not met', () => {
  const active = resolveActiveSkill({
    skills,
    plan: { skill: 'acquire_wood' },
    governor: { mode: 'emergency', preferredSkills: ['eat_available_food'] },
    observation: { inventory: {} },
  });
  assert.equal(active.skill.id, 'acquire_wood', 'eat non applicabile senza cibo');
  assert.equal(active.source, 'plan');
  assert.equal(skillApplicable(skills.get('eat_available_food'), { inventory: { bread: 1 } }), true);
  assert.equal(skillApplicable(skills.get('eat_available_food'), { inventory: {} }), false);
});

test('skillPreferredIntents exposes the declarative intents for ranking', () => {
  assert.deepEqual(skillPreferredIntents(skills.get('acquire_wood')), ['mine', 'collect', 'travel']);
  assert.deepEqual(skillPreferredIntents(null), []);
});

// ---- verifier ------------------------------------------------------------------------

const WOOD = skills.get('acquire_wood');
const EAT = skills.get('eat_available_food');
const ESCAPE = skills.get('escape_hostile');
const FIRST_NIGHT = skills.get('first_night');
const IRON = skills.get('acquire_iron');

test('acquire_wood succeeds only with enough logs, aggregated over species', () => {
  const running = verifySkill(WOOD, {}, { inventory: { oak_log: 3 } });
  assert.equal(running.status, 'running');
  assert.equal(running.evidence['inventory.logs'], 3);
  const success = verifySkill(WOOD, {}, { inventory: { oak_log: 5, spruce_log: 3 } });
  assert.equal(success.status, 'success');
  assert.equal(success.evidence['inventory.logs'], 8);
});

test('verification fails when the bot died', () => {
  const result = verifySkill(WOOD, {}, { inventory: { oak_log: 10 }, dead: true });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'died');
});

test('eat success comes from a food increase or an already healthy food bar', () => {
  assert.equal(verifySkill(EAT, { food: 10 }, { food: 10 }).status, 'running');
  assert.equal(verifySkill(EAT, { food: 10 }, { food: 16 }).status, 'success');
  assert.equal(verifySkill(EAT, { food: 17 }, { food: 17 }).status, 'success');
});

test('escape success comes from distance gained or no hostiles left', () => {
  const before = { entities: [{ type: 'zombie', hostile: true, distance: 4 }] };
  assert.equal(verifySkill(ESCAPE, before, { entities: [{ type: 'zombie', hostile: true, distance: 13 }] }).status, 'success');
  assert.equal(verifySkill(ESCAPE, before, { entities: [] }).status, 'success');
  assert.equal(verifySkill(ESCAPE, before, { entities: [{ type: 'zombie', hostile: true, distance: 6 }] }).status, 'running');
});

test('first_night needs an observed night and a new day', () => {
  const before = { time: { phase: 'night' }, health: 20 };
  const dawn = { time: { phase: 'day' }, health: 20 };
  assert.equal(verifySkill(FIRST_NIGHT, before, dawn).status, 'success');
  assert.equal(verifySkill(FIRST_NIGHT, { time: { phase: 'day' }, health: 20 }, dawn).status, 'running');
  assert.equal(verifySkill(FIRST_NIGHT, { time: { phase: 'day' }, health: 20 }, dawn, { context: { sawNight: true } }).status, 'success');
});

test('iron skill accepts either ingots or crafted iron tools', () => {
  assert.equal(verifySkill(IRON, {}, { inventory: { raw_iron: 4 } }).status, 'running');
  assert.equal(verifySkill(IRON, {}, { inventory: { iron_ingot: 3 } }).status, 'success');
  assert.equal(verifySkill(IRON, {}, { inventory: { iron_pickaxe: 1 } }).status, 'success');
});

test('nearbyBlock criterion is satisfied by a placed crafting table', () => {
  const table = skills.get('acquire_crafting_table');
  assert.equal(verifySkill(table, {}, { inventory: {}, nearby: {} }).status, 'running');
  assert.equal(verifySkill(table, {}, { inventory: { crafting_table: 1 } }).status, 'success');
  assert.equal(verifySkill(table, {}, { inventory: {}, nearby: { crafting_table: [{ distance: 3 }] } }).status, 'success');
});

test('evaluateCriteria exposes before/after evidence for dynamic predicates', () => {
  const result = evaluateCriteria({ foodIncreased: true }, { food: 15 }, { before: { food: 9 } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.evidence, { foodBefore: 9, foodAfter: 15 });
});

// ---- experience ----------------------------------------------------------------------

test('buildSkillRecord produces plain JSONL-ready statistics', () => {
  const record = buildSkillRecord({
    skill: 'acquire_wood', status: 'success', actions: 7,
    startedAt: 1000, endedAt: 19432, context: { milestone: 'wood' },
  });
  assert.equal(record.skill, 'acquire_wood');
  assert.equal(record.success, true);
  assert.equal(record.actions, 7);
  assert.equal(record.elapsedMs, 18432);
  assert.equal(record.failureReason, null);
});

test('appendSkillRecord writes one JSON line per skill run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'));
  const file = join(dir, 'skills.jsonl');
  await appendSkillRecord(file, buildSkillRecord({ skill: 'first_night', status: 'failed', actions: 12, startedAt: 0, endedAt: 5, failureReason: 'died' }));
  await appendSkillRecord(file, buildSkillRecord({ skill: 'acquire_wood', status: 'success', actions: 3, startedAt: 0, endedAt: 5 }));
  const lines = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].failureReason, 'died');
  assert.equal(lines[1].success, true);
});

// ---- fluidi (M6) ---------------------------------------------------------------------

const FLUID_IDS = [
  'cross_water', 'survive_drowning', 'escape_lava', 'descend_waterfall',
  'climb_waterfall', 'craft_bucket', 'bucket_and_place_water', 'boat_travel',
  'brew_water_breathing',
];

test('the fluid skills load and declare their own blockers instead of hiding them', () => {
  for (const id of FLUID_IDS) assert.ok(skills.has(id), `skill ${id}`);
  // Le skill che dipendono dal nuoto o dal tavolo di alchimia dicono *perché*
  // non sono eseguibili: chi legge la libreria non deve dedurlo dal nome.
  for (const id of ['cross_water', 'survive_drowning', 'descend_waterfall', 'climb_waterfall', 'brew_water_breathing']) {
    assert.equal(typeof skills.get(id).blocked, 'string', `${id} blocked`);
    assert.ok(skills.get(id).blocked.length > 20, `${id} blocked reason`);
  }
  // `escape_lava`, `craft_bucket` e `bucket_and_place_water` sono eseguibili oggi.
  for (const id of ['escape_lava', 'craft_bucket', 'bucket_and_place_water', 'boat_travel']) {
    assert.equal(skills.get(id).blocked, undefined, `${id} non è bloccata`);
  }
  assert.ok(validateSkill({ id: 'x', description: 'x', blocked: '' }).some(error => error.includes('blocked must be a non-empty string')));
  assert.deepEqual(validateSkill({ id: 'x', description: 'x', blocked: 'perché serve il nuoto' }), []);
});

test('the fluid skills verify on real observations, never on a claim', () => {
  const bucket = skills.get('craft_bucket');
  assert.equal(verifySkill(bucket, {}, { inventory: { iron_ingot: 3 } }).status, 'running');
  assert.equal(verifySkill(bucket, {}, { inventory: { iron_ingot: 3, bucket: 1 } }).status, 'success');

  const pour = skills.get('bucket_and_place_water');
  assert.equal(verifySkill(pour, {}, { inventory: { water_bucket: 1 }, nearby: { lava: [{ distance: 3 }] } }).status, 'running');
  assert.equal(verifySkill(pour, {}, { inventory: { bucket: 1 }, nearby: { obsidian: [{ distance: 3 }] } }).status, 'success');

  const lava = skills.get('escape_lava');
  assert.equal(verifySkill(lava, {}, { fluids: { inLava: true }, health: 8 }).status, 'running');
  assert.equal(verifySkill(lava, { health: 8 }, { fluids: { inLava: false }, health: 8 }).status, 'success');
  assert.equal(verifySkill(lava, {}, { health: 20 }).status, 'running', 'senza il dato fluido non si promuove nulla');
});

test('the spatial criteria compare the two observations instead of trusting a story', () => {
  const down = skills.get('descend_waterfall');
  const top = { position: { x: 0, y: 90, z: 0 }, health: 20, fluids: { air: 300 } };
  const bottom = { position: { x: 0, y: 82, z: 0 }, health: 20, fluids: { air: 300 } };
  assert.equal(verifySkill(down, top, bottom).status, 'success');
  assert.equal(verifySkill(down, top, { position: { x: 0, y: 89, z: 0 }, health: 20 }).status, 'running');
  assert.equal(verifySkill(down, top, { health: 20 }).status, 'running', 'senza posizione non si dichiara una discesa');

  const up = skills.get('climb_waterfall');
  assert.equal(verifySkill(up, top, bottom).status, 'running');
  assert.equal(verifySkill(up, bottom, top).status, 'success');

  const boat = skills.get('boat_travel');
  // Lo spostamento si misura fra due osservazioni: senza `before` non c'è nulla
  // da confrontare e la skill resta in corso, anche se la barca è in inventario.
  assert.equal(verifySkill(boat, {}, { position: { x: 30, y: 64, z: 40 }, inventory: { oak_boat: 1 } }).status, 'running');
  assert.equal(verifySkill(boat, { position: { x: 4, y: 64, z: 4 } }, { position: { x: 30, y: 64, z: 40 }, inventory: { oak_boat: 1 } }).status, 'success');
  assert.equal(verifySkill(boat, { position: { x: 30, y: 64, z: 40 } }, { position: { x: 32, y: 64, z: 41 } }).status, 'running');

  // Validazione: i tre criteri vogliono un numero positivo, `waterBreathing` un booleano.
  assert.ok(validateCriteria({ descendedAtLeast: 0 }).some(error => error.includes('must be a positive number')));
  assert.ok(validateCriteria({ movedAtLeast: -1 }).some(error => error.includes('must be a positive number')));
  assert.ok(validateCriteria({ waterBreathing: 'sì' }).some(error => error.includes('must be a boolean')));
  assert.deepEqual(validateCriteria({ allOf: [{ climbedAtLeast: 3 }, { waterBreathing: true }] }), []);
});

test('waterBreathing reads the server effect, in either shape the adapter exposes', () => {
  const brew = skills.get('brew_water_breathing');
  assert.equal(verifySkill(brew, {}, { fluids: { waterBreathing: { active: false } } }).status, 'running');
  assert.equal(verifySkill(brew, {}, { fluids: { waterBreathing: { active: true, sources: [{ kind: 'effect' }] } } }).status, 'success');
  assert.equal(verifySkill(brew, {}, { fluids: { waterBreathing: true } }).status, 'success');
  assert.equal(verifySkill(brew, {}, { fluids: {} }).status, 'running');
});
