// Deep Dark / stealth (W2 di docs/raw/DEEP_DARK_ROADMAP.md): il pianificatore
// silenzioso provato sul modulo puro. Il mondo qui è una griglia di celle
// calpestabili: si prova il *piano* (costi, divieti, rotta di ritorno), non la
// fisica del server, che è già coperta dai test di movimento.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SENSOR_CELL_COST, stealthCellCost, astarStealth, planStealthRoute, summarizeStealthPlan } from '../bedrock-vibration.mjs';

const key = cell => `${cell.x},${cell.y},${cell.z}`;

// Vicini in griglia: quattro lati, un gradino su e una caduta di un blocco (la
// stessa forma di `_neighbors`, ridotta all'osso). Le mosse vietate si passano
// come `from->to`: una caduta si fa in un senso solo, e il piano deve saperlo.
function grid ({ standable = [], banned = [] } = {}) {
  const cells = new Set(standable.map(key));
  const forbidden = new Set(banned);
  return node => {
    const out = [];
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
      const to = { x: node.x + dx, y: node.y + dy, z: node.z + dz };
      if (!cells.has(key(to))) continue;
      if (forbidden.has(`${key(node)}->${key(to)}`)) continue;
      out.push({ ...to, cost: dy > 0 ? 1.4 : 1 });
    }
    return out;
  };
}

// Il costo delle celle con il raggio passato a mano: una sfera di due blocchi
// tiene i test leggibili (la sfera vera è `VIBRATION_RADIUS`, provata in
// tests/vibration.test.mjs).
const costWith = (sensors, { radius = 2, shriekers = [] } = {}) =>
  cell => stealthCellCost({ cell, sensors, radius, shriekers });

const lane = (x0, x1, y, z) => {
  const cells = [];
  for (let x = x0; x <= x1; x++) cells.push({ x, y, z });
  return cells;
};

test('stealthCellCost: un sensore dentro il raggio costa, appena fuori no', () => {
  const sensors = [{ position: { x: 5, y: 0, z: 0 } }];
  const onSensor = stealthCellCost({ cell: { x: 5, y: 0, z: 0 }, sensors, radius: 2 });
  assert.equal(onSensor.blocked, false);
  assert.equal(onSensor.risk, 1);
  assert.equal(onSensor.cost, 1 + SENSOR_CELL_COST, 'una cella rumorosa costa come SENSOR_CELL_COST celle sicure');
  const edge = stealthCellCost({ cell: { x: 5, y: 0, z: 2 }, sensors, radius: 2 });
  assert.equal(edge.risk, 1, 'a due blocchi esatti la sfera arriva ancora');
  const outside = stealthCellCost({ cell: { x: 5, y: 0, z: 3 }, sensors, radius: 2 });
  assert.equal(outside.risk, 0);
  assert.equal(outside.cost, 1);
});

test('stealthCellCost: una cella che porta uno shrieker e vietata, non solo cara', () => {
  const shriekers = [{ position: { x: 5, y: 0, z: 0 } }];
  const verdict = stealthCellCost({ cell: { x: 5, y: 1, z: 0 }, shriekers });
  assert.equal(verdict.blocked, true);
  assert.equal(verdict.reason, 'standing_on_shrieker');
  assert.equal(verdict.cost, null, 'non è un costo alto: è un divieto');
});

test('astarStealth: trova la rotta piu corta e ne riporta costo e rischio', () => {
  const neighbors = grid({ standable: lane(0, 4, 0, 0) });
  const route = astarStealth({ start: { x: 0, y: 0, z: 0 }, goal: { x: 4, y: 0, z: 0 }, neighbors, cellCost: () => ({ blocked: false, cost: 1, risk: 0 }) });
  assert.ok(route);
  assert.equal(route.path.length, 5);
  assert.equal(route.path[0].x, 0);
  assert.equal(route.path.at(-1).x, 4);
  assert.equal(route.maxRisk, 0);
  assert.equal(route.cost, 5);
});

test('astarStealth: una cella vietata non si attraversa, la rotta la aggira o non esiste', () => {
  const neighbors = grid({ standable: lane(0, 4, 0, 0) });
  const blocked = cell => ({ blocked: cell.x === 2, cost: 1, risk: 0 });
  assert.equal(astarStealth({ start: { x: 0, y: 0, z: 0 }, goal: { x: 4, y: 0, z: 0 }, neighbors, cellCost: blocked }), null);
});

test('planStealthRoute: un giro largo vince su una scorciatoia dentro la sfera', () => {
  const sensors = [{ position: { x: 5, y: 0, z: 0 } }];
  // Corridoio dritto a z=0 (dentro la sfera a x=5) più una corsia larga a z=3.
  const detour = grid({
    standable: [
      ...lane(0, 10, 0, 0),
      ...lane(0, 10, 0, 3),
      { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 2 },
      { x: 10, y: 0, z: 1 }, { x: 10, y: 0, z: 2 },
    ],
  });
  const plan = planStealthRoute({
    start: { x: 0, y: 0, z: 0 },
    goal: { x: 10, y: 0, z: 0 },
    neighbors: detour,
    cellCost: costWith(sensors),
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.maxRisk, 0, 'il piano accettato non ha nessuna cella nella sfera');
  assert.ok(plan.cells.length > 11, `la scorciatoia rumorosa non è stata presa: ${plan.cells.length} celle`);
  assert.deepEqual(plan.cells[plan.cells.length - 1], { x: 10, y: 0, z: 0 });
  assert.equal(plan.sneak, true);
  for (const cell of plan.cells) {
    assert.equal(costWith(sensors)(cell).risk, 0, `cella ${key(cell)} dentro la sfera`);
  }
});

test('planStealthRoute: se l\'unico passaggio e dentro la sfera il piano si rifiuta', () => {
  const sensors = [{ position: { x: 5, y: 0, z: 0 } }];
  const corridor = grid({ standable: lane(0, 10, 0, 0) });
  const plan = planStealthRoute({
    start: { x: 0, y: 0, z: 0 },
    goal: { x: 10, y: 0, z: 0 },
    neighbors: corridor,
    cellCost: costWith(sensors),
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.error, 'no_stealth_route');
  assert.equal(plan.reason, 'risk');
  assert.equal(plan.maxRisk, 1);
  // Il rischio di ogni cella è "quanti sensori la sentono": qui è 1 dalla prima
  // cella della sfera all'ultima, quindi il rifiuto nomina la *prima* cella non
  // silenziosa, cioè dove il piano smette di essere silenzioso.
  assert.deepEqual(plan.riskCell, { x: 3, y: 0, z: 0 }, 'il rifiuto dice *dove* non è silenzioso');
});

test('planStealthRoute: una cella con shrieker rende la destinazione irraggiungibile', () => {
  // Lo shrieker sta a y=0: a essere vietata è la cella *sopra* di lui, dove il
  // bot starebbe in piedi (shrieka anche accovacciato).
  const shriekers = [{ position: { x: 2, y: 0, z: 0 } }];
  const corridor = grid({ standable: lane(0, 4, 1, 0) });
  const plan = planStealthRoute({
    start: { x: 0, y: 1, z: 0 },
    goal: { x: 4, y: 1, z: 0 },
    neighbors: corridor,
    cellCost: costWith([], { shriekers }),
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.error, 'no_stealth_route');
  assert.equal(plan.reason, 'unreachable', 'la cella con lo shrieker non è "rischiosa": è vietata');
});

test('planStealthRoute: senza destinazione raggiungibile il rifiuto e tipizzato', () => {
  const neighbors = grid({ standable: lane(0, 2, 0, 0) });
  const plan = planStealthRoute({ start: { x: 0, y: 0, z: 0 }, goal: { x: 9, y: 0, z: 0 }, neighbors, cellCost: () => ({ blocked: false, cost: 1, risk: 0 }) });
  assert.equal(plan.ok, false);
  assert.equal(plan.error, 'no_stealth_route');
  assert.equal(plan.reason, 'unreachable');
});

test('planStealthRoute: l\'andata senza ritorno non e un piano (la caduta si fa in un senso solo)', () => {
  const sensors = [];
  const ledge = grid({
    standable: [...lane(0, 4, 0, 0), ...lane(4, 8, -1, 0)],
    banned: ['4,-1,0->4,0,0'],
  });
  const plan = planStealthRoute({
    start: { x: 0, y: 0, z: 0 },
    goal: { x: 8, y: -1, z: 0 },
    exit: { x: 0, y: 0, z: 0 },
    neighbors: ledge,
    cellCost: costWith(sensors),
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.error, 'no_exit_route');
  assert.equal(plan.reason, 'unreachable');
});

test('planStealthRoute: con una via di ritorno il piano porta l\'uscita con se', () => {
  const ramp = grid({ standable: [...lane(0, 8, 0, 0), ...lane(4, 5, -1, 0)] });
  const plan = planStealthRoute({
    start: { x: 0, y: 0, z: 0 },
    goal: { x: 8, y: 0, z: 0 },
    exit: { x: 0, y: 0, z: 0 },
    neighbors: ramp,
    cellCost: () => ({ blocked: false, cost: 1, risk: 0 }),
  });
  assert.equal(plan.ok, true);
  assert.ok(plan.exit, 'ogni piano accettato ha la sua via di ritorno');
  assert.ok(plan.exit.cells.length > 0);
  assert.deepEqual(plan.exit.cells[plan.exit.cells.length - 1], { x: 0, y: 0, z: 0 });
  assert.equal(plan.exit.maxRisk, 0);
  assert.deepEqual(plan.exit.target, { x: 0, y: 0, z: 0 });
});

test('summarizeStealthPlan: la forma compatta non porta dietro l\'intero percorso', () => {
  const neighbors = grid({ standable: lane(0, 3, 0, 0) });
  const plan = planStealthRoute({
    start: { x: 0, y: 0, z: 0 },
    goal: { x: 3, y: 0, z: 0 },
    exit: { x: 0, y: 0, z: 0 },
    neighbors,
    cellCost: () => ({ blocked: false, cost: 1, risk: 0 }),
  });
  const summary = summarizeStealthPlan(plan);
  assert.equal(summary.ok, true);
  assert.equal(summary.cells, 4);
  assert.equal(summary.maxRisk, 0);
  assert.equal(summary.sneak, true);
  assert.deepEqual(summary.to, { x: 3, y: 0, z: 0 });
  assert.equal(summary.exit.cells, 4);
  assert.equal('path' in summary, false);

  const refusal = summarizeStealthPlan({ ok: false, error: 'no_stealth_route', reason: 'risk', maxRisk: 2, riskCell: { x: 1, y: 0, z: 0 } });
  assert.deepEqual(refusal, { ok: false, error: 'no_stealth_route', reason: 'risk', maxRisk: 2, riskCell: { x: 1, y: 0, z: 0 }, cells: null, exit: null });
});
