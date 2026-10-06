import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BedrockAdapter } from '../bedrock-adapter.mjs';
import { createWorldMemory } from '../world-memory.mjs';
import { planExplorationSweep, chunkKey } from '../exploration.mjs';
import { villageSweepConfig } from '../village-survey.mjs';

// V1 — `survey_village` non ha una geometria propria: cammina il piano di
// `planExplorationSweep` con la configurazione di `villageSweepConfig`. Questi
// test riguardano perciò ciò che resta all'azione: i tre limiti (il primo
// raggiunto vince), i rifiuti tipizzati (la missione non è partita) distinti dal
// troncamento (il censimento è incompleto), e l'idempotenza che viene dal
// registro — non dalla RAM, che un riavvio cancella.

const block = (name, x, y, z, props = {}) => ({
  name,
  position: { x, y, z },
  getProperties: () => props,
});

const siteBlocks = () => ({
  bell: [block('bell', 0, 66, 4)],
  bed: [block('bed', 1, 64, 4), block('bed', 2, 64, 4), block('bed', 3, 64, 4)],
  carrots: [
    block('carrots', 0, 64, 0, { growth: 7 }),
    block('carrots', 1, 64, 0, { growth: 7 }),
    block('carrots', 2, 64, 0, { growth: 3 }),
  ],
  composter: [block('composter', 2, 64, 5)],
  oak_fence: [block('oak_fence', 1, 64, 8), block('oak_fence', 2, 64, 8)],
});

const siteEntities = () => [
  { type: 'villager_v2', position: { x: 1, y: 64, z: 5 } },
  { type: 'villager_v2', position: { x: 2, y: 64, z: 5 } },
  { type: 'cow', position: { x: 1, y: 64, z: 9 }, baby: false },
];

function site ({ blocks = siteBlocks(), entities = siteEntities(), memory = null, at = { x: 0, y: 64, z: 0 } } = {}) {
  const adapter = new BedrockAdapter({ logger: { log () {} }, memory });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.position = { ...at };
  adapter._feet = { ...at };
  adapter.dimension = 'overworld';
  adapter._reachabilityUsable = () => false;
  adapter.inventorySlots = [];
  adapter.inventory = {};
  adapter.drops = [];
  adapter.nearbyBlocks = {};
  adapter.client = { write: () => {} };
  adapter.world.findBlocks = (name, _point, _radius, cap) => (blocks[name] || []).slice(0, cap ?? 64);
  adapter.world.surveyBlocks = () => ({
    scanned: 4000,
    distinct: Object.keys(blocks).length,
    truncated: false,
    names: new Map(Object.entries(blocks).map(([name, cells]) => [name, { count: cells.length, first: cells[0]?.position }])),
  });
  for (const entity of entities) {
    adapter.entities.set(entity.runtimeId ?? adapter.entities.size + 1, { kind: 'mob', lastAt: Date.now(), ...entity });
  }
  return adapter;
}

// Nessun pathfinding: i waypoint si registrano soltanto. Il costo (in ms finti,
// quando serve) lo decide il test, così il budget di tempo non dipende
// dall'orologio reale.
function walkLog (adapter, { cost = 0, failAt = null, onTick = null } = {}) {
  const targets = [];
  adapter._moveTo = async (target) => {
    targets.push({ ...target });
    if (onTick) onTick(cost);
    if (failAt != null && targets.length === failAt) throw new Error('path_blocked');
    return { ok: true };
  };
  return targets;
}

function tempMemory () {
  const dir = mkdtempSync(join(tmpdir(), 'village-sweep-'));
  const memory = createWorldMemory({ dir, backend: 'json', logger: { warn () {} } });
  return { dir, memory, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a completed sweep walks the planner plan and writes the register', async () => {
  const { memory, cleanup } = tempMemory();
  const adapter = site({ memory });
  const targets = walkLog(adapter);
  const result = await adapter.executeAction('survey_village');

  assert.equal(result.ok, true);
  assert.equal(result.action, 'survey_village');
  assert.deepEqual(result.anchor, { x: 0, y: 66, z: 4 }, 'ancora dal detector, come la vista');
  assert.equal(result.planned, 9, 'centro + un anello a 24 blocchi');
  assert.equal(result.walked, 9);
  assert.equal(result.blocked, false);
  assert.equal(result.stoppedBy, 'exhausted');
  assert.equal(result.truncated, false);
  assert.equal(result.complete, true);
  assert.equal(result.budget.remaining, 4096 - 9 * 8);
  assert.equal(result.view.detection.state, 'CONFIRMED');
  assert.equal(result.survey.censuses, 1);
  assert.equal(result.survey.cells, 9);
  assert.equal(result.visited, 9, 'una cella censita per waypoint, tutte distinte');

  // Il primo waypoint è l'ancora: la spirale parte dal centro del sito.
  assert.deepEqual({ x: targets[0].x, z: targets[0].z }, { x: 0, z: 4 });
  assert.equal(targets.length, 9);

  // Il registro sopravvive al processo: nove celle, una per chunk visitato.
  const record = memory.villageSurvey({ near: { x: 0, y: 66, z: 4 }, dimension: 'overworld' });
  assert.ok(record);
  assert.equal(record.kind, 'village_survey');
  assert.equal(record.censuses, 1);
  assert.equal(record.cells.length, 9);
  // Il giro è anche un viaggio: l'indice dei chunk lo registra (e resta distinto:
  // registra il passaggio, non la guardata).
  assert.ok(memory.visitedChunks({ dimension: 'overworld' }).length >= 9);
  // Il lock è tornato libero: un'azione incastrata bloccherebbe l'API.
  assert.equal(adapter.busy, false);
  cleanup();
});

test('the plan is the planner plan: same anchor and visited give the same waypoints', async () => {
  const { memory, cleanup } = tempMemory();
  const adapter = site({ memory });
  const targets = walkLog(adapter);
  const result = await adapter._surveyVillage();
  const expected = planExplorationSweep(villageSweepConfig({ anchor: result.anchor, visited: [] }));
  assert.deepEqual(targets.map(t => ({ x: t.x, z: t.z })), expected.waypoints.map(w => ({ x: w.x, z: w.z })));
  assert.deepEqual(result.config, expected.config, 'la configurazione è quella del planner, non una copia');
  assert.deepEqual(result.steps.map(s => s.distance), expected.waypoints.map(w => w.distance));
  cleanup();
});

test('the cell budget truncates the pass instead of refusing it', async () => {
  const { memory, cleanup } = tempMemory();
  const adapter = site({ memory });
  const targets = walkLog(adapter);
  // Ogni waypoint censisce 8 celle (3 letti + 3 carote + 2 staccionate).
  const result = await adapter._surveyVillage({ limits: { cells: 10 } });

  assert.equal(result.ok, true, 'un budget esaurito non è un rifiuto: il censimento c\'è, incompleto');
  assert.equal(result.stoppedBy, 'cells');
  assert.equal(result.truncated, true);
  assert.equal(result.complete, false);
  assert.equal(result.planned, 9);
  assert.equal(result.walked, 2);
  assert.equal(result.budget.remaining, 0);
  assert.equal(result.censuses.at(-1).truncated, true, 'l\'ultimo censimento è quello che ha toccato il tetto');
  assert.equal(targets.length, 2);
  assert.equal(result.visited, 2, 'le due celle censite restano registrate: il giro successivo salta quelle');
  assert.equal(result.survey.cells, 2);
  cleanup();
});

test('the execution budget truncates with time while the ring is unfinished', async () => {
  const real = Date.now;
  let now = real();
  Date.now = () => now;
  try {
    const { memory, cleanup } = tempMemory();
    const adapter = site({ memory });
    walkLog(adapter, { cost: 40000, onTick: ms => { now += ms; } });
    const result = await adapter._surveyVillage({ limits: { maxMs: 120000 } });

    assert.equal(result.ok, true);
    assert.equal(result.stoppedBy, 'time');
    assert.equal(result.truncated, true);
    assert.equal(result.walked, 3, 'al quarto waypoint il tempo è finito');
    assert.equal(result.limits.maxMs, 120000);
    assert.equal(result.steps.length, 3);
    cleanup();
  } finally {
    Date.now = real;
  }
});

test('a blocked waypoint stops the pass, and only the reached cells are recorded', async () => {
  const { memory, cleanup } = tempMemory();
  const adapter = site({ memory });
  walkLog(adapter, { failAt: 2 });
  const result = await adapter._surveyVillage();

  assert.equal(result.ok, true);
  assert.equal(result.blocked, true);
  assert.equal(result.complete, false);
  assert.equal(result.walked, 2);
  assert.equal(result.steps[1].ok, false);
  assert.equal(result.steps[1].error, 'path_blocked');
  assert.equal(result.visited, 1, 'la cella del waypoint fallito non è censita');
  // Il registro resta vero: contiene solo ciò che è stato guardato, quindi il giro
  // successivo riparte dal waypoint che non è stato raggiunto.
  const record = memory.villageSurvey({ near: { x: 0, y: 66, z: 4 }, dimension: 'overworld' });
  assert.equal(record.cells.length, 1);
  assert.ok(memory.visitedChunks({ dimension: 'overworld' }).length >= 1, 'il viaggio però è avvenuto');
  cleanup();
});

test('the refusals are typed, and a refusal starts no mission', async () => {
  const { memory, cleanup } = tempMemory();

  // Nessun villaggio identificato.
  const empty = site({ blocks: { stone: [block('stone', 0, 60, 0)] }, entities: [], memory });
  const unknown = await empty._surveyVillage();
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, 'village_unknown');
  assert.equal(empty._villageSweep, null);

  // Villaggio identificato ma lontano: raggiungerlo è un viaggio.
  const far = site({ memory, at: { x: 400, y: 64, z: 0 } });
  walkLog(far);
  const tooFar = await far._surveyVillage();
  assert.equal(tooFar.ok, false);
  assert.equal(tooFar.error, 'village_too_far');
  assert.equal(tooFar.distance, 400);
  assert.equal(tooFar.maxDistance, 256);
  assert.equal(far._villageSweep, null);

  // Passata già fatta da poco: cooldown, non troncamento.
  const near = site({ memory });
  walkLog(near);
  await near._surveyVillage();
  const again = await near._surveyVillage();
  assert.equal(again.ok, false);
  assert.equal(again.error, 'survey_cooldown');
  assert.ok(again.remainingMs > 0 && again.remainingMs <= again.cooldownMs);
  cleanup();
});

test('a second sweep over a censused ring plans zero movement, and a restart too', async () => {
  const { memory, cleanup } = tempMemory();
  const first = site({ memory });
  const firstTargets = walkLog(first);
  await first._surveyVillage();
  assert.equal(firstTargets.length, 9);

  // Stesso processo, giro successivo: il piano non ha più waypoint. Le celle
  // vengono dal registro e dalla RAM, che qui dicono la stessa cosa.
  const secondTargets = walkLog(first);
  first._villageSweep.at = Date.now() - 3600e3; // cooldown scaduto
  const second = await first._surveyVillage();
  assert.equal(second.ok, true);
  assert.equal(second.planned, 0);
  assert.equal(second.walked, 0);
  assert.equal(second.stoppedBy, 'exhausted');
  assert.equal(second.truncated, false);
  assert.equal(second.survey.censuses, 2, 'la passata si è registrata senza camminare');
  assert.equal(secondTargets.length, 0);

  // Riavvio: RAM nuova, registro vecchio. L'idempotenza non può venire dalla RAM.
  const restarted = site({ memory });
  assert.equal(restarted._villageSweep, null);
  const afterTargets = walkLog(restarted);
  const after = await restarted._surveyVillage();
  assert.equal(after.planned, 0);
  assert.equal(after.walked, 0);
  assert.equal(after.visited, 9, 'le nove celle censite vengono dal registro');
  assert.equal(afterTargets.length, 0);
  cleanup();
});

test('censused cells of another village are never reused', async () => {
  const { memory, cleanup } = tempMemory();
  memory.rememberVillageSurvey({ position: { x: 0, y: 66, z: 4 }, cells: [chunkKey(0, 0)], radius: 48 });
  const adapter = site({ memory });

  const same = adapter._villageVisited({ x: 0, y: 66, z: 4 });
  assert.deepEqual(same, [chunkKey(0, 0)]);
  const other = adapter._villageVisited({ x: 40, y: 66, z: 4 });
  assert.deepEqual(other, [], 'quaranta blocchi più in là è un altro sito');

  // E il giro del secondo sito non salta le celle del primo.
  const targets = walkLog(adapter);
  adapter.structures = [{ type: 'village', position: { x: 40, y: 66, z: 4 } }];
  adapter.world.surveyBlocks = () => ({ scanned: 10, distinct: 1, truncated: false, names: new Map([['bell', { count: 1, first: { x: 40, y: 66, z: 4 } }]]) });
  adapter.world.findBlocks = (name) => (name === 'bell' ? [block('bell', 40, 66, 4)] : []);
  const result = await adapter._surveyVillage();
  assert.equal(result.planned, 9, 'il sito nuovo è tutto da censire');
  assert.equal(targets.length, 9);
  cleanup();
});

test('the option is offered with an anchor and outside the cooldown', async () => {
  const { memory, cleanup } = tempMemory();
  const adapter = site({ memory });
  assert.ok(adapter.options().some(o => o.key === 'survey_village'));

  walkLog(adapter);
  await adapter._surveyVillage();
  assert.ok(!adapter.options().some(o => o.key === 'survey_village'), 'in cooldown non si offre');

  const empty = site({ blocks: { stone: [block('stone', 0, 60, 0)] }, entities: [], memory });
  assert.ok(!empty.options().some(o => o.key === 'survey_village'), 'senza ancora non si offre');
  cleanup();
});
