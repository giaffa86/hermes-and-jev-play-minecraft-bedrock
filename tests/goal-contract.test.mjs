// Unit test del Goal Contract (Slice A): criteri nuovi del verifier
// (deathsAtLeast/itemPreserved), normalizzazione del contratto, stato
// deterministico RUNNING/SUCCESS/FAILED/BLOCKED e scorciatoie d'ambiente.
// Nessun server richiesto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateCriteria, validateCriteria,
  normalizeContract, evaluateContract, contractStop, contractFromEnv, hasContractConfig, CONTRACT_STATUSES,
} from '../survival/index.mjs';

const obs = (overrides = {}) => ({ inventory: {}, deaths: 0, ...overrides });

// ---- nuovi criteri ---------------------------------------------------------------------

test('deathsAtLeast fires when the death counter reaches the threshold', () => {
  assert.equal(evaluateCriteria({ deathsAtLeast: 2 }, obs({ deaths: 1 })).ok, false);
  const hit = evaluateCriteria({ deathsAtLeast: 2 }, obs({ deaths: 2 }));
  assert.equal(hit.ok, true);
  assert.equal(hit.evidence.deaths, 2);
  // unknown/missing deaths never satisfies the criterion
  assert.equal(evaluateCriteria({ deathsAtLeast: 0 }, obs({ deaths: null })).ok, false);
});

test('itemPreserved detects a lost item against the before baseline', () => {
  const before = { inventory: { enchanted_diamond_pickaxe: 1, diamond: 3 } };
  const held = evaluateCriteria({ itemPreserved: ['enchanted_diamond_pickaxe', 'diamond'] }, obs({ inventory: { enchanted_diamond_pickaxe: 1, diamond: 3 } }), { before });
  assert.equal(held.ok, true);
  const lost = evaluateCriteria({ itemPreserved: ['enchanted_diamond_pickaxe'] }, obs({ inventory: { diamond: 3 } }), { before });
  assert.equal(lost.ok, false);
  assert.match(lost.reason, /preserved item lost: enchanted_diamond_pickaxe/);
  // a partial decrease is a loss too
  const decreased = evaluateCriteria({ itemPreserved: ['diamond'] }, obs({ inventory: { diamond: 1 } }), { before });
  assert.equal(decreased.ok, false);
  // if it was not held before, nothing to preserve
  const notHeld = evaluateCriteria({ itemPreserved: ['netherite_ingot'] }, obs({ inventory: {} }), { before });
  assert.equal(notHeld.ok, true);
});

test('validateCriteria rejects malformed new criteria', () => {
  assert.ok(validateCriteria({ deathsAtLeast: -1 }).some(e => e.includes('deathsAtLeast')));
  assert.ok(validateCriteria({ deathsAtLeast: 'x' }).some(e => e.includes('deathsAtLeast')));
  assert.ok(validateCriteria({ itemPreserved: [] }).some(e => e.includes('itemPreserved')));
  assert.ok(validateCriteria({ itemPreserved: ['x', 3] }).some(e => e.includes('itemPreserved')));
  assert.deepEqual(validateCriteria({ deathsAtLeast: 2, itemPreserved: ['diamond'] }), []);
});

// ---- normalizzazione -------------------------------------------------------------------

test('normalizeContract collects errors instead of throwing', () => {
  const errors = normalizeContract({ constraints: { maxDeaths: -1, preserveItems: [] }, success: { nonsense: true } });
  assert.ok(errors.errors.some(e => e.includes('maxDeaths')));
  assert.ok(errors.errors.some(e => e.includes('preserveItems')));
  assert.ok(errors.errors.some(e => e.includes('nonsense')));
});

test('normalizeContract keeps valid constraints', () => {
  const contract = normalizeContract({ goal: 'obtain_diamonds', target: { item: 'diamond', count: 20 }, constraints: { maxDeaths: 2, preserveItems: ['diamond_pickaxe'] }, success: { inventoryTagGte: { diamonds: 20 } } });
  assert.deepEqual(contract.errors, []);
  assert.equal(contract.goal, 'obtain_diamonds');
  assert.equal(contract.constraints.maxDeaths, 2);
  assert.deepEqual(contract.constraints.preserveItems, ['diamond_pickaxe']);
});

// ---- evaluation ------------------------------------------------------------------------

test('evaluateContract reports RUNNING then SUCCESS', () => {
  const contract = normalizeContract({ success: { inventoryGte: { dirt: 4 } } });
  assert.equal(evaluateContract(contract, obs()).status, 'running');
  assert.equal(evaluateContract(contract, obs({ inventory: { dirt: 4 } })).status, 'success');
});

test('evaluateContract ignores a transient failure while running', () => {
  const contract = normalizeContract({ failure: { deathsAtLeast: 3 }, success: { inventoryGte: { dirt: 4 } } });
  assert.equal(evaluateContract(contract, obs({ deaths: 1 })).status, 'running');
  assert.equal(evaluateContract(contract, obs({ deaths: 3 })).status, 'failed');
});

test('success wins over a violated constraint', () => {
  const contract = normalizeContract({ constraints: { maxDeaths: 1 }, success: { inventoryGte: { dirt: 4 } } });
  const status = evaluateContract(contract, obs({ deaths: 5, inventory: { dirt: 4 } }));
  assert.equal(status.status, 'success');
});

test('maxDeaths constraint fails the contract', () => {
  const contract = normalizeContract({ constraints: { maxDeaths: 1 }, success: { inventoryGte: { dirt: 4 } } });
  const status = evaluateContract(contract, obs({ deaths: 2 }));
  assert.equal(status.status, 'failed');
  assert.match(status.reasons[0], /deaths=2 > maxDeaths=1/);
});

test('preserveItems constraint fails when the item is lost', () => {
  const contract = normalizeContract({ constraints: { preserveItems: ['diamond_pickaxe'] }, success: { inventoryGte: { dirt: 4 } } });
  const before = obs({ inventory: { diamond_pickaxe: 1 } });
  const status = evaluateContract(contract, obs({ inventory: {} }), { before });
  assert.equal(status.status, 'failed');
  assert.match(status.reasons.join(' '), /diamond_pickaxe/);
});

test('a contract with no completion criterion is BLOCKED', () => {
  assert.equal(evaluateContract(normalizeContract({}), obs()).status, 'blocked');
  assert.equal(evaluateContract(normalizeContract({ constraints: { gameMode: 'survival' } }), obs()).status, 'blocked');
});

test('cheats and mismatched gameMode are BLOCKED', () => {
  assert.equal(evaluateContract(normalizeContract({ constraints: { cheats: true }, success: { inventoryGte: { dirt: 1 } } }), obs()).status, 'blocked');
  const status = evaluateContract(normalizeContract({ constraints: { gameMode: 'creative' }, success: { inventoryGte: { dirt: 1 } } }), obs({ gameMode: 'survival' }));
  assert.equal(status.status, 'blocked');
  assert.match(status.reasons[0], /gameMode/);
});

test('invalid contracts are BLOCKED before any telemetry is trusted', () => {
  const bad = normalizeContract({ constraints: { maxDeaths: -1 }, success: { inventoryGte: { dirt: 1 } } });
  assert.equal(evaluateContract(bad, obs({ inventory: { dirt: 1 } })).status, 'blocked');
});

// ---- budget esaurito (contractStop) ----------------------------------------------------

test('contractStop keeps RUNNING while actions are still available', () => {
  const contract = normalizeContract({ success: { inventoryGte: { dirt: 4 } } });
  assert.equal(contractStop(contract, obs(), { stepsUsed: 0, maxSteps: 8 }).status, 'running');
  assert.equal(contractStop(contract, obs(), { stepsUsed: 7, maxSteps: 8 }).status, 'running');
});

test('contractStop turns RUNNING at the budget into EXHAUSTED', () => {
  const contract = normalizeContract({ success: { inventoryGte: { dirt: 4 } } });
  const status = contractStop(contract, obs(), { stepsUsed: 8, maxSteps: 8 });
  assert.equal(status.status, 'exhausted');
  assert.match(status.reasons[0], /step budget exhausted \(8\/8\)/);
  assert.equal(contractStop(contract, obs(), { stepsUsed: 9, maxSteps: 8 }).status, 'exhausted');
});

test('contractStop lets SUCCESS and FAILED win over exhaustion', () => {
  const success = normalizeContract({ success: { inventoryGte: { dirt: 4 } } });
  assert.equal(contractStop(success, obs({ inventory: { dirt: 4 } }), { stepsUsed: 8, maxSteps: 8 }).status, 'success');
  const failed = normalizeContract({ success: { inventoryGte: { dirt: 4 } }, failure: { deathsAtLeast: 1 } });
  assert.equal(contractStop(failed, obs({ deaths: 1 }), { stepsUsed: 8, maxSteps: 8 }).status, 'failed');
});

test('contractStop without a budget never exhausts', () => {
  const contract = normalizeContract({ success: { inventoryGte: { dirt: 4 } } });
  assert.equal(contractStop(contract, obs(), {}).status, 'running');
  assert.equal(contractStop(contract, obs(), { stepsUsed: 99, maxSteps: null }).status, 'running');
});

// ---- env -------------------------------------------------------------------------------

test('contractFromEnv builds constraints from shortcut env vars', () => {
  const contract = contractFromEnv({ MAX_DEATHS: '2', PRESERVE_ITEMS: 'diamond_pickaxe, netherite_ingot' });
  assert.deepEqual(contract.errors, []);
  assert.equal(contract.constraints.maxDeaths, 2);
  assert.deepEqual(contract.constraints.preserveItems, ['diamond_pickaxe', 'netherite_ingot']);
});

test('contractFromEnv merges a JSON GOAL_CONTRACT', () => {
  const contract = contractFromEnv({ GOAL_CONTRACT: JSON.stringify({ goal: 'g', success: { inventoryGte: { dirt: 4 } }, constraints: { maxDeaths: 3 } }), MAX_DEATHS: '1' });
  assert.deepEqual(contract.errors, []);
  assert.equal(contract.goal, 'g');
  assert.equal(contract.constraints.maxDeaths, 1); // env shortcut overrides JSON
});

test('contractFromEnv surfaces invalid JSON as a blocked contract', () => {
  const contract = contractFromEnv({ GOAL_CONTRACT: '{not json' });
  assert.ok(contract.errors.length);
  assert.equal(evaluateContract(contract, obs()).status, 'blocked');
});

test('hasContractConfig is opt-in', () => {
  assert.equal(hasContractConfig({}), false);
  assert.equal(hasContractConfig({ MAX_DEATHS: '0' }), true);
  assert.equal(hasContractConfig({ PRESERVE_ITEMS: 'diamond' }), true);
  assert.equal(hasContractConfig({ GOAL_CONTRACT: '{}' }), true);
});

test('CONTRACT_STATUSES is the closed vocabulary', () => {
  assert.deepEqual(CONTRACT_STATUSES, ['running', 'success', 'failed', 'blocked', 'exhausted']);
});
