// Hermes Bedrock harness: un bot Bedrock reale + bounded-action HTTP API.
//   GET  /observe  -> stato normalizzato del bot
//   GET  /options  -> azioni valide in questo momento
//   POST /act {key} -> esegue un'azione
//   POST /plan {objective, waypoint, targets} -> registra il piano corrente
//   POST /say {message, type?} -> il bot scrive in chat (pacchetto `text`)
//   GET  /memory/hints?resource=<item>&limit=N -> località provate (episodico → semantico)
//   POST /memory/consolidate {limit,since} -> backfill idempotente dei consolidamenti
// Il controller sceglie solo chiavi restituite da /options; la validità è qui.
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import { BedrockAdapter } from './bedrock-adapter.mjs';
import { createWorldMemory } from './world-memory.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import {
  evaluateSurvival, summarizeSurvival, loadSurvivalRules,
  filterOptionsForGovernor, loadGameplaySkills, loadProgression, resolveMilestone, resolveActiveSkill,
} from './survival/index.mjs';
import { resolveBiomeTarget, planExplorationStep, chunkKey, SUPPORTED_BIOMES, replayRouteFromMission, replayRouteFromPlace, planReplayStep, buildReplayReport } from './exploration.mjs';

console.log('BEDROCK HARNESS VERSION 2');
const API_PORT = +(process.env.API_PORT || 3077);
const API_HOST = process.env.API_HOST || '127.0.0.1';
const RUN = process.env.RUN_ID || 'run';

// Survival Intelligence Layer: regole, skill e grafo di progressione caricati
// una sola volta e validati subito (un file rotto deve fallire all'avvio).
const survivalRules = await loadSurvivalRules(new URL('./knowledge/survival-rules.json', import.meta.url));
const gameplaySkills = loadGameplaySkills();
const progressionGraph = await loadProgression(new URL('./knowledge/progression.json', import.meta.url));
const PROGRESSION_GOAL = process.env.PROGRESSION_GOAL || null;
console.log(`survival layer ready: rules=${survivalRules.length} skills=${gameplaySkills.size} milestones=${Object.keys(progressionGraph.milestones).length}`);

mkdirSync(`runs/${RUN}`, { recursive: true });
// Il nome dell'evento resta in `type`: il payload può portare un `type` (tipo
// dell'entità, canale chat) che altrimenti lo sovrascriverebbe.
const eventLog = (type, data) => appendFileSync(`runs/${RUN}/events.jsonl`, JSON.stringify({ t: Date.now(), ...data, type }) + '\n');

let server;
let shuttingDown = false;
const shutdownSignal = new AbortController();
let connectionWorker = null;

const MEMORY_DIR = process.env.MEMORY_DIR || 'runs/memory';
const worldMemory = createWorldMemory({ dir: MEMORY_DIR });
worldMemory.hydrate();
console.log(`world memory ready: ${JSON.stringify(worldMemory.summary())} (${MEMORY_DIR})`);
// Flush periodico: la memoria sopravvive anche a un crash (flushed ogni 30 s a dirty).
setInterval(() => { try { worldMemory.flush(); } catch (error) { console.error('[memory] flush failed:', error.message); } }, 30000).unref();

const adapter = new BedrockAdapter({
  memory: worldMemory,
  onLog: process.env.BEDROCK_EVENT_LOG ? (entry) => eventLog(entry.type, entry) : undefined,
  onDisconnect: () => {
    console.warn('[adapter] disconnected; will reconnect');
    startConnectionWorker(10000);
  },
});

function startConnectionWorker (initialDelay = 0) {
  if (connectionWorker || shuttingDown) return;
  connectionWorker = connectLoop(initialDelay).catch(error => {
    if (!shuttingDown) console.error('[connectLoop]', error.message);
  }).finally(() => {
    connectionWorker = null;
    if (!shuttingDown && !adapter.spawned) startConnectionWorker(10000);
  });
}

async function shutdown () {
  if (shuttingDown) return;
  shuttingDown = true;
  shutdownSignal.abort();
  console.log('Disconnecting bot and waiting for NetherNet teardown');
  server?.close();
  server?.closeAllConnections();
  try { worldMemory.close(); console.log('world memory saved'); }
  catch (error) { console.error('world memory close failed:', error.message); }
  try { await adapter.disconnect('harness shutdown'); }
  catch (error) { console.error('Shutdown failed:', error.message); process.exitCode = 1; }
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
  // Non usciamo: in un servizio long-running e' meglio loggare e continuare.
});

async function connectLoop (initialDelay = 0) {
  if (initialDelay) await delay(initialDelay, undefined, { signal: shutdownSignal.signal });
  let attempt = 0;
  while (!shuttingDown) {
    attempt++;
    try {
      await adapter.connect();
      console.log('bedrock harness connected after attempt', attempt);
      return;
    } catch (err) {
      console.error(`[connect] attempt ${attempt} failed:`, err.message || err);
      if (shuttingDown) return;
      const delayMs = Math.min(5000 * 2 ** Math.min(attempt - 1, 4), 60000);
      console.log(`[connect] retrying in ${delayMs}ms...`);
      await delay(delayMs, undefined, { signal: shutdownSignal.signal });
    }
  }
}

if (!shuttingDown) {
console.log('bedrock harness starting; api on', API_PORT);
server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  console.log('[http]', req.method, req.url, 'body_len', body.length);
  const safeJson = (obj) => JSON.stringify(obj, (_k, v) => typeof v === 'bigint' ? v.toString() : v);
  let response;
  try {
    if (req.method === 'GET' && req.url === '/observe') {
      // La survival compatta viaggia con l'osservazione: chi legge vede subito
      // se la progressione è stata interrotta (mode != normal).
      const obs = adapter.observe();
      obs.survival = summarizeSurvival(evaluateSurvival(obs, { rules: survivalRules }));
      response = [200, obs];
    } else if (req.method === 'GET' && req.url === '/options') {
      // Validity owner resta l'adapter; il governor può solo restringere in
      // emergenza le opzioni già offerte, mai aggiungerne.
      const obs = adapter.observe();
      const survival = evaluateSurvival(obs, { rules: survivalRules });
      const offered = adapter.options();
      const restricted = filterOptionsForGovernor(offered, survival);
      response = [200, {
        options: restricted.options,
        survival: summarizeSurvival(survival),
        filtered: restricted.filtered,
        removed: restricted.removed,
        filterReason: restricted.reason,
      }];
    } else if (req.method === 'GET' && req.url === '/survival') {
      // Diagnostica: governor completo + skill attiva + milestone suggerito
      // (quest'ultimo solo con PROGRESSION_GOAL configurato).
      const obs = adapter.observe();
      const survival = evaluateSurvival(obs, { rules: survivalRules });
      const milestone = PROGRESSION_GOAL
        ? resolveMilestone(progressionGraph, { goal: PROGRESSION_GOAL, observation: obs, completed: new Set() })
        : null;
      const active = resolveActiveSkill({ skills: gameplaySkills, plan: obs.plan, governor: survival, milestone, observation: obs });
      response = [200, { survival, activeSkill: active.skill?.id ?? null, activeSkillSource: active.source, milestone, progressionGoal: PROGRESSION_GOAL }];
    } else if (process.env.BEDROCK_DEBUG && req.method === 'GET' && req.url === '/debug/geom') response = [200, geometryReport(adapter)];
    else if (process.env.BEDROCK_DEBUG && req.method === 'GET' && req.url.startsWith('/debug/reach')) {
      // Componente calpestabile raggiungibile attorno al bot: diagnosi dei
      // blocchi del pathfinding (drop in una tasca, stanze isolate).
      const u = new URL(req.url, 'http://x');
      const limit = Number(u.searchParams.get('limit') || 1200);
      response = [200, adapter.reachReport({ limit: Number.isFinite(limit) && limit > 0 ? limit : 1200 })];
    }
    else if (process.env.BEDROCK_DEBUG && req.method === 'GET' && req.url.startsWith('/debug/packet-debug')) {
      // Arma la cattura dei pacchetti in arrivo (richiede PACKET_DEBUG=1):
      // permette di registrare la risposta del server a un'azione puntuale
      // senza riavviare il container.
      const u = new URL(req.url, 'http://x');
      const ms = Number(u.searchParams.get('ms') || 15000);
      const armed = adapter._armPacketDebug(Number.isFinite(ms) && ms > 0 ? ms : 15000);
      response = [200, { ok: armed, until: adapter._packetDebugUntil ?? 0, hint: armed ? null : 'PACKET_DEBUG non attivo' }];
    }
    else if (process.env.BEDROCK_DEBUG && req.method === 'POST' && req.url === '/debug/mine') {      const { x, y, z } = JSON.parse(body);
      const block = adapter.world.blockAt({ x, y, z });
      if (!block) response = [200, { ok: false, error: 'block_not_loaded' }];
      else response = [200, await adapter._mineTarget({ cell: { x, y, z }, block, raw: block.name === 'unknown' })];
    }
    else if (process.env.BEDROCK_DEBUG && req.method === 'GET' && req.url === '/debug/inventory') {
      response = [200, {
        selectedHotbar: adapter.selectedHotbar,
        cursor: adapter._cursor ?? null,
        slots: adapter.inventorySlots
          .map((s, i) => s ? { i, name: adapter._slotItemName(s), count: s.count, stack_id: s.stack_id ?? null, has_stack_id: s.has_stack_id ?? null } : null)
          .filter(Boolean),
      }];
    }
    else if (process.env.BEDROCK_DEBUG && req.method === 'GET' && req.url.startsWith('/debug/path')) {
      // Diagnostica pathfinding: start, goal e percorso A* verso un punto x,z.
      const u = new URL(req.url, 'http://x');
      const x = +u.searchParams.get('x'), z = +u.searchParams.get('z');
      const start = adapter._startNode();
      const target = { x, y: adapter.position?.y ?? 70, z };
      const goals = adapter._findGoalNodes(target);
      const found = [];
      for (const goal of goals.slice(0, 3)) {
        const path = adapter._findPath(start, goal);
        found.push({ goal, pathLen: path?.length ?? null, end: path?.at(-1) ?? null });
      }
      response = [200, { start, feet: adapter._feet, target, goalCount: goals.length, attempts: found }];
    }
    else if (process.env.BEDROCK_DEBUG && req.method === 'GET' && req.url === '/debug/containers') {
      // Censisce i contenitori di stoccaggio nel mondo caricato (non solo i 32 blocchi).
      const found = [];
      for (const name of ['chest', 'trapped_chest', 'barrel', 'shulker_box']) {
        for (const block of adapter.world.findBlocks(name, adapter.position, 200, 64)) {
          found.push({ name, position: block.position, distance: +(block.distance ?? 0).toFixed(1) });
        }
      }
      found.sort((a, b) => a.distance - b.distance);
      response = [200, { count: found.length, containers: found, position: adapter.pos() }];
    }
    else if (process.env.BEDROCK_DEBUG && req.method === 'POST' && req.url === '/debug/isr') {
      const { type_id, count, source, destination, randomly, open } = JSON.parse(body);
      if (open) await adapter._ensureInventoryOpen();
      const legacy = { take: 0, place: 1, swap: 2, drop: 3, destroy: 4 }[type_id] ?? 0;
      response = [200, await adapter._sendStackRequest([{ type_id, legacy_type_id: legacy, count, source, destination, randomly }], {})];
    }
    else if (req.method === 'POST' && req.url === '/explore') {
      // Risolve il target in un id Minecraft e crea/attiva la missione di esplorazione.
      // Le esplorazioni rimaste `running` da un avvio precedente vengono chiuse come
      // `superseded`: un riavvio del servizio non deve lasciare missioni zombie né
      // far riprendere una ricerca vecchia.
      const payload = body ? JSON.parse(body) : {};
      const target = resolveBiomeTarget(payload.target ?? payload.biome ?? '');
      if (!target) response = [400, { ok: false, error: 'unknown_biome_target', supported: SUPPORTED_BIOMES }];
      else {
        const origin = adapter.position ? { x: adapter.position.x, y: adapter.position.y, z: adapter.position.z } : null;
        const superseded = [];
        for (const prev of adapter.memory.missions({ state: 'running', limit: 20 })) {
          if (prev.type !== 'find_biome') continue;
          adapter.memory.finishMission(prev.id, { outcome: 'superseded', success: false, state: 'cancelled', failureReason: 'superseded_by_new_mission' });
          superseded.push(prev.id);
        }
        const mission = adapter.memory.createMission({ type: 'find_biome', target, origin });
        adapter.missionId = mission.id;
        adapter.explorationMissionId = mission.id;
        adapter.replayRoute = null;
        response = [200, { ok: true, mission, superseded }];
      }
    }
    else if (req.method === 'GET' && req.url === '/explore') {
      // Un passo deterministico: move / found / hold / exhausted.
      // Solo missioni di esplorazione: un run curriculum/autonomo attivo non deve
      // far girare il planner dell'esplorazione su una missione di altro tipo.
      const active = adapter.explorationMissionId ? adapter.memory?.getMission(adapter.explorationMissionId) : null;
      const mission = active ?? adapter.memory?.missions({ state: 'running', limit: 20 }).find(m => m.type === 'find_biome') ?? null;
      if (!mission) response = [200, { action: 'hold', reason: 'no_mission' }];
      else {
        const visited = (adapter.memory.visitedChunks({ limit: 5000 }) || []).map(c => chunkKey(c.position.x, c.position.z));
        const currentBiome = typeof adapter.world?.biomeAt === 'function' ? adapter.world.biomeAt(adapter.position) : null;
        const step = planExplorationStep({ mission, currentPosition: adapter.position, currentBiome, visited });
        if (step.action === 'found') {
          adapter.memory.updateMission(mission.id, { targetPosition: adapter.position });
          adapter.memory.completeMission(mission.id, step.report);
        }
        response = [200, step];
      }
    }
    else if (req.method === 'POST' && req.url === '/explore/replay') {
      // M2: rigioca una rotta registrata verso un posto già scoperto.
      // Sorgenti: i checkpoint di una missione, un posto del world graph, o
      // coordinate esplicite. La destinazione è l'unica cosa obbligatoria: le
      // tappe registrate sono guide, il pathfinding locale rifà i tratti.
      const payload = body ? JSON.parse(body) : {};
      const memory = adapter.memory;
      let route = null;
      if (payload.missionId) {
        const source = memory.getMission(payload.missionId);
        route = replayRouteFromMission(source, source ? memory.missionCheckpoints(source.id) : []);
      } else if (payload.placeId) {
        route = replayRouteFromPlace(memory.getRecord(payload.placeId));
      } else if (Number.isFinite(payload.x) && Number.isFinite(payload.z)) {
        route = { source: 'coordinates', id: null, label: `${payload.x},${payload.z}`, destination: { x: payload.x, y: payload.y ?? adapter.position?.y ?? 0, z: payload.z }, checkpoints: [] };
      }
      if (!route) response = [400, { ok: false, error: 'no_replay_route', hint: 'pass missionId, placeId or x/z' }];
      else {
        // Quanto deve essere preciso l'arrivo: lo decide il chiamante (una stanza
        // piccola richiede una soglia più stretta del default di 6 blocchi).
        if (Number.isFinite(payload.arrivedRadius)) route.arrivedRadius = payload.arrivedRadius;
        if (Number.isFinite(payload.viaRadius)) route.viaRadius = payload.viaRadius;
        // Come per l'esplorazione: un replay rimasto `running` da un avvio
        // precedente non deve restare appeso né essere ripreso per sbaglio.
        const superseded = [];
        for (const prev of memory.missions({ state: 'running', limit: 20 })) {
          if (prev.type !== 'replay') continue;
          memory.finishMission(prev.id, { outcome: 'superseded', success: false, state: 'cancelled', failureReason: 'superseded_by_new_replay' });
          superseded.push(prev.id);
        }
        const origin = adapter.position ? { x: adapter.position.x, y: adapter.position.y, z: adapter.position.z } : null;
        const mission = memory.createMission({ type: 'replay', intent: route.label ?? null, origin, source: 'planner' });
        if (route.missionId) memory.linkMission(mission.id, 'replay_of', route.missionId);
        else if (route.id) memory.linkMission(mission.id, 'replays', route.id);
        adapter.missionId = mission.id;
        adapter.explorationMissionId = null;
        adapter.replayRoute = route;
        response = [200, { ok: true, mission, route, superseded }];
      }
    }
    else if (req.method === 'GET' && req.url === '/explore/replay') {
      // Un passo del replay; su `arrived` la missione si chiude con l'esito reale.
      const mission = adapter.missionId ? adapter.memory?.getMission(adapter.missionId) : null;
      const route = adapter.replayRoute;
      if (!route || mission?.type !== 'replay') response = [200, { action: 'hold', reason: 'no_replay_route' }];
      else {
        const step = planReplayStep({ route, currentPosition: adapter.position, arrivedRadius: route.arrivedRadius, viaRadius: route.viaRadius });
        if (step.action === 'arrived') {
          const report = buildReplayReport({ route, mission, currentPosition: adapter.position });
          adapter.memory.updateMission(mission.id, { targetPosition: adapter.position });
          adapter.memory.finishMission(mission.id, { outcome: 'arrived', success: true, state: 'arrived', result: report });
          response = [200, { ...step, report, missionId: mission.id }];
        } else response = [200, { ...step, missionId: mission.id }];
      }
    }
    else if (req.method === 'GET' && req.url === '/mission') {
      // Rotta della missione attiva (missione + checkpoint + distanza); altrimenti le ultime.
      const route = adapter.missionId ? adapter.memory?.missionRoute(adapter.missionId) : null;
      response = [200, route ?? { mission: null, missions: adapter.memory?.missions({ limit: 10 }) ?? [] }];
    }
    else if (req.method === 'POST' && req.url === '/mission') { const payload = body ? JSON.parse(body) : {}; const record = adapter.memory?.createMission(payload); if (record) adapter.missionId = record.id; response = [200, { ok: !!record, mission: record ?? null }]; }
    else if (req.method === 'POST' && req.url === '/mission/complete') { const payload = body ? JSON.parse(body) : {}; const missionId = payload.missionId ?? adapter.missionId; const record = missionId ? adapter.memory?.completeMission(missionId, payload.result ?? null) : null; response = [200, { ok: !!record, mission: record ?? null }]; }
    // Layer goal/episodico: archi di goal, cronologia azioni e chiusura con esito.
    else if (req.method === 'POST' && req.url === '/mission/link') { const payload = body ? JSON.parse(body) : {}; const id = adapter.memory?.linkMission(payload.missionId, payload.relationType, payload.targetId, { metadata: payload.metadata ?? {} }); response = [200, { ok: !!id, id: id ?? null }]; }
    else if (req.method === 'POST' && req.url === '/mission/action') { const payload = body ? JSON.parse(body) : {}; const id = adapter.memory?.recordAction(payload); response = [200, { ok: !!id, id: id ?? null }]; }
    else if (req.method === 'POST' && req.url === '/mission/finish') { const payload = body ? JSON.parse(body) : {}; const missionId = payload.missionId ?? adapter.missionId; const record = missionId ? adapter.memory?.finishMission(missionId, payload) : null; response = [200, { ok: !!record, mission: record ?? null }]; }
    // Lettura dei suggerimenti consolidati: il planner li usa come preferenza
    // (mai come fatto) e può richiederli per risorsa.
    else if (req.method === 'GET' && req.url.startsWith('/memory/hints')) {
      const params = new URLSearchParams(req.url.split('?')[1] ?? '');
      const resource = params.get('resource');
      const limit = Number(params.get('limit') ?? 10) || 10;
      const hints = resource ? worldMemory.provenLocationsFor(resource, { limit }) : worldMemory.productivityHints({ limit });
      response = [200, { hints, count: hints.length, resource: resource ?? null }];
    }
    // Backfill idempotente: consolida le missioni chiuse prima di questa feature.
    else if (req.method === 'POST' && req.url === '/memory/consolidate') {
      const payload = body ? JSON.parse(body) : {};
      response = [200, worldMemory.consolidatePending({ limit: payload.limit ?? 50, since: payload.since ?? null })];
    }
    else if (req.method === 'POST' && req.url === '/plan') { adapter.setPlan(JSON.parse(body)); response = [200, { ok: true, plan: adapter.plan }]; }
    else if (req.method === 'POST' && req.url === '/say') {
      // Il bot scrive in chat (M5): unico modo per rispondere a un umano o
      // spiegargli la sintassi degli ordini. La validità resta nell'adapter.
      const payload = body ? JSON.parse(body) : {};
      response = [200, adapter.sendChat(payload.message, { type: payload.type })];
    }
    else if (req.method === 'POST' && req.url === '/act') { const { key } = JSON.parse(body); response = [200, await adapter.executeAction(key)]; }
    else response = [404, { error: 'unknown route' }];

    // Solo lettura: griglia camminabile attorno al bot e validità della risalita.
    function geometryReport (a) {
      if (!a._feet) return { error: 'no_position' };
      const feet = a._feet;
      const cx = Math.floor(feet.x), cz = Math.floor(feet.z), cy = Math.floor(feet.y + 1e-3);
      const grid = [];
      for (let dy = 5; dy >= -3; dy--) {
        const cells = [];
        for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
          if (a._standable(cx + dx, cy + dy, cz + dz)) cells.push(`${dx >= 0 ? '+' : ''}${dx},${dz >= 0 ? '+' : ''}${dz}`);
        }
        grid.push({ dy, cells });
      }
      const upTargets = {};
      const savedYaw = a._lastYaw;
      for (const yaw of [0, 90, 180, -90]) { a._lastYaw = yaw; const plan = a._upTargets(); upTargets[yaw] = plan.error || plan.targets.map(t => t.label); }
      a._lastYaw = savedYaw;
      const bed = a._findBed();
      const bedCenter = bed ? { x: bed.position.x + 0.5, y: bed.position.y, z: bed.position.z + 0.5 } : null;
      const blocks = [];
      for (let dy = -1; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          for (let dz = -4; dz <= 4; dz++) {
            const b = a.world.blockAt({ x: cx + dx, y: cy + dy, z: cz + dz });
            if (b && b.name === 'air') continue;
            blocks.push(`${dx >= 0 ? '+' : ''}${dx},${dy >= 0 ? '+' : ''}${dy},${dz >= 0 ? '+' : ''}${dz}=${b ? `${b.name}${b.diggable ? 'D' : '-'}` : 'NULL'}`);
          }
        }
      }
      return {
        feet, position: a.pos(), startNode: a._startNode(), grid, upTargets, bed, blocks,
        bedGoals: bed ? a._findGoalNodes(bedCenter).map(goal => ({ goal, hasPath: !!a._findPath(a._startNode(), goal) })) : null,
        standingOn: a.standingOn,
      };
    }
  } catch (e) {
    console.error('[http] error handling', req.method, req.url, e);
    response = [500, { error: e.message }];
  }
  try {
    if (!res.headersSent && !res.writableEnded) {
      res.writeHead(response[0], { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(safeJson(response[1]));
    } else {
      console.error('[http] response already sent/ended', req.method, req.url);
    }
  } catch (e) {
    console.error('[http] failed to write response', req.method, req.url, e.message);
  }
}).listen(API_PORT, API_HOST, () => console.log('harness api on', API_PORT));

startConnectionWorker();
}
