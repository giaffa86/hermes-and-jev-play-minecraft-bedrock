// go_home da pozzo profondo (docs/wiki/open-questions.md): quando il percorso
// diretto non esiste il bot torna a tappe verso le celle raggiungibili più vicine
// a casa, invece di rispondere `path_failed` otto volte come live il 06/10.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

// Celle raggiungibili finte: `cells` è la parte raggiungibile del mondo (catena
// di tappe), `start` è dove sta il bot. `move()` sposta davvero il bot, così i
// predicati che leggono `_startNode()`/`position` vedono il progresso.
function homeAdapter ({ start = { x: 100, y: 40, z: 200 }, home = { x: 90, y: 74, z: 163 }, cells = [] } = {}) {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  let feet = { ...start };
  const move = cell => {
    feet = { x: Math.floor(cell.x), y: Math.round(cell.y), z: Math.floor(cell.z) };
    adapter.position = { ...feet };
  };
  move(start);
  adapter.home = home;
  adapter.status = 'spawned';
  adapter._startNode = () => ({ ...feet });
  adapter.reachableCells = () => ({
    start: { ...feet },
    cells: new Set(cells.map(c => `${c.x},${c.y},${c.z}`)),
    truncated: false,
  });
  return { adapter, feet: () => ({ ...feet }), move };
}

// Catena di celle raggiungibili che sale dal fondo miniera a casa, ogni tappa
// ben dentro i 24 blocchi: è la forma che il campo ha mostrato (una scalinata).
const CHAIN = [
  { x: 100, y: 48, z: 200 },
  { x: 100, y: 56, z: 200 },
  { x: 98, y: 64, z: 190 },
  { x: 94, y: 70, z: 178 },
  { x: 90, y: 74, z: 168 },
  { x: 90, y: 74, z: 163 },
];
const HOME = { x: 90, y: 74, z: 163 };

test('go_home returns directly when the direct path works', async () => {
  const { adapter, move } = homeAdapter();
  let hopCalls = 0;
  adapter._homeHops = async () => { hopCalls++; return { ok: false, error: 'not_expected' }; };
  adapter._moveTo = async target => { move(target); return { ok: true, distance: 0.5, pathNodes: 3 }; };
  const result = await adapter._goHome();
  assert.equal(result.ok, true);
  assert.equal(result.via, 'direct');
  assert.equal(result.distance, 0);
  assert.equal(hopCalls, 0, 'il percorso diretto non deve attivare le tappe');
});

test('go_home walks the last stretch in hops when the direct path fails', async () => {
  const { adapter, feet, move } = homeAdapter({ start: CHAIN[0], home: HOME, cells: CHAIN });
  const calls = [];
  adapter._moveTo = async target => {
    calls.push({ target });
    if (calls.length === 1) throw new Error('path_failed');
    move(target);
    return { ok: true, distance: 0, pathNodes: 2 };
  };
  const result = await adapter._goHome();
  assert.equal(result.ok, true);
  assert.equal(result.via, 'hops');
  assert.equal(result.distance, 0);
  assert.ok(result.hops >= 1 && result.hops < CHAIN.length - 1,
    `il greedy salta le celle che stanno nel raggio (tappe: ${result.hops})`);
  assert.equal(calls.length, result.hops + 1, 'un tentativo diretto + una chiamata per tappa');
  assert.deepEqual(feet(), HOME, 'il bot arriva a casa');
  const chainKeys = new Set(CHAIN.map(c => `${c.x},${c.y},${c.z}`));
  for (const step of result.trail) {
    assert.ok(chainKeys.has(`${step.goal.x},${step.goal.y},${step.goal.z}`), 'ogni tappa è una cella raggiungibile');
  }
  // ogni tappa è corta (dentro hopRange) e guadagna distanza
  let previous = Infinity;
  for (const step of result.trail) {
    const travelled = Math.hypot(step.goal.x - step.from.x, step.goal.y - step.from.y, step.goal.z - step.from.z);
    assert.ok(travelled <= 24, `tappa ${step.hop} dentro hopRange (${travelled.toFixed(1)})`);
    assert.ok(step.distance <= previous, `la tappa ${step.hop} avvicina a casa (${step.distance} <= ${previous})`);
    previous = step.distance;
  }
});

test('go_home reports no_progress when no reachable cell gets closer', async () => {
  const { adapter } = homeAdapter({ cells: [{ x: 140, y: 40, z: 240 }] });
  adapter._moveTo = async () => { throw new Error('path_failed'); };
  const result = await adapter._goHome();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'go_home_failed: path_failed');
  assert.equal(result.via, 'hops');
  assert.equal(result.hopError, 'no_progress');
  assert.equal(result.hops, 0);
});

test('a hop never exceeds hopRange even if a farther cell is closer to home', async () => {
  const home = { x: 90, y: 40, z: 163 };
  const cells = [
    { x: 95, y: 40, z: 170 }, // più vicina a casa (33.9) ma a 30.5 dal bot
    { x: 98, y: 40, z: 196 }, // 4.5 dal bot, 34.0 da casa
  ];
  const { adapter, move } = homeAdapter({ start: { x: 100, y: 40, z: 200 }, home, cells });
  const calls = [];
  adapter._moveTo = async target => {
    calls.push(target);
    if (calls.length === 1) throw new Error('path_failed');
    move(target);
    return { ok: true, distance: 0, pathNodes: 2 };
  };
  const result = await adapter._goHome();
  assert.deepEqual(calls[1], { x: 98.5, y: 40, z: 196.5 }, 'scelta la tappa raggiungibile, non quella fuori raggio');
  assert.equal(result.hopError, 'no_progress', 'arrivata lì non c’è più nessuna tappa utile');
  assert.equal(result.hops, 1);
});

test('a failure inside the hops is reported, not thrown', async () => {
  const { adapter } = homeAdapter();
  adapter._moveTo = async () => { throw new Error('path_failed'); };
  adapter.reachableCells = () => { throw new Error('world not loaded'); };
  const result = await adapter._goHome();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'go_home_failed: path_failed');
  assert.match(result.hopError, /hop_error: world not loaded/);
  assert.deepEqual(result.trail, []);
});

test('_homeHops stops at maxHops and says so', async () => {
  const { adapter, move } = homeAdapter({ start: CHAIN[0], home: HOME, cells: CHAIN });
  adapter._moveTo = async target => {
    move(target);
    return { ok: true, distance: 0, pathNodes: 2 };
  };
  const result = await adapter._homeHops(HOME, { maxHops: 2, timeoutMs: 5000 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'hop_budget_exhausted');
  assert.equal(result.hops, 2);
  assert.ok(result.distance > 2, 'due tappe non bastano per 26 blocchi di dislivello');
});
