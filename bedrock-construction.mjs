// Bounded, persistent executor. This module uses existing adapter primitives;
// there is no protocol client, secondary controller or secondary memory store.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { evaluateSurvival, summarizeSurvival } from './survival/governor.mjs';
import { loadSurvivalRules } from './survival/rules.mjs';
import { compileConstructionDesign, constructionDesignInstructions, designCapabilities } from './construction-design.mjs';
import { campfireLit } from './bedrock-bees.mjs';
import {
  loadStructures, createBlueprint, planStructure, inspectSite, missingMaterials,
  keyOf, isAir, known, usableSupport, safeSolid, placementSupports, matchesCell,
  stateSignature, validateBlueprint,
  bridgeRequest,
} from './construction.mjs';

export const CONSTRUCTION_BLOCK_BUDGET = 4;
export const CONSTRUCTION_TIME_MS = 20000;
const catalogue = loadStructures();
const survivalRules = await loadSurvivalRules(new URL('./knowledge/survival-rules.json', import.meta.url));
const clock = () => Date.now();
const parseKey = s => Object.fromEntries(['x', 'y', 'z'].map((k, i) => [k, Number(s.split(',')[i])]));
const CLICK_POS = { 1: { x: 0.5, y: 1, z: 0.5 }, 2: { x: 0.5, y: 0.5, z: 0 }, 3: { x: 0.5, y: 0.5, z: 1 }, 4: { x: 0, y: 0.5, z: 0.5 }, 5: { x: 1, y: 0.5, z: 0.5 } };

export function constructionPlannerInstructions () {
  return constructionDesignInstructions() + '\nLegacy explicit templates use construction:{type,parameters,origin?,facing?}. Pause/resume uses {projectId,command:"pause|resume"}. Do not invent world coordinates or authorized containers.';
}

export function constructionFromText (message, observation = {}) {
  const text = String(message ?? '').toLowerCase();
  const active = observation.construction?.projectId;
  if (/\b(pausa|pause|ferma|stop)\b/.test(text) && /cantiere|costruz|build|construction/.test(text)) return active ? { projectId: active, command: 'pause' } : null;
  if (/\b(riprendi|resume)\b/.test(text) && /cantiere|costruz|build|construction/.test(text)) return active ? { projectId: active, command: 'resume' } : null;
  if (!/costru|build|erect/.test(text)) return null;
  const type = /magazzin|warehouse|storehouse/.test(text) ? 'warehouse'
    : /pont[ei]|bridge/.test(text) ? 'bridge' : /torr[ei]|tower/.test(text) ? 'tower'
      : /cas[ae]|house/.test(text) ? 'house' : /piattaform|platform/.test(text) ? 'platform' : null;
  if (!type) return null;
  const parameters = {};
  const size = /(\d+)\s*[x×]\s*(\d+)/.exec(text);
  if (size) { parameters.width = Number(size[1]); parameters.length = Number(size[2]); }
  const boxes = /(\d+)\s*(?:cass[ae]|chests?)/.exec(text);
  if (boxes && type === 'warehouse') parameters.chests = Number(boxes[1]);
  const height = /(?:alt[ao]|height|high)\s*(\d+)/.exec(text);
  if (height) parameters.height = Number(height[1]);
  const facing = /\b(north|south|east|west)\b/.exec(text)?.[1];
  // Coordinates and bridge endpoints require structured interpretation; this
  // fallback deliberately leaves them to the survey rather than guessing.
  if (/lava/.test(text)) parameters.palette = { floor: 'cobblestone', wall: 'cobblestone' };
  return { type, parameters, ...(facing ? { facing } : {}) };
}

export class ConstructionEngine {
  constructor (adapter) { this.a = adapter; this.project = null; this.session = null; }
  get memory () { return this.a.memory; }
  read = p => this.a.world.blockAt(p);

  preview (request = {}) {
    if (request.designPatch) throw new Error('unapplied_construction_design_patch');
    request = bridgeRequest(request);
    if (request.designRequired && !request.design) throw new Error('construction_design_required');
    const def = catalogue.get(request.type);
    if (!def) throw new Error('unknown_structure');
    if (request.design && request.parameters) throw new Error('ambiguous_construction_design');
    const blueprint = request.design ? compileConstructionDesign(request.design, request.type) : createBlueprint(def, request.parameters ?? {});
    const facing = request.facing ?? this.a._facingFromYaw();
    const dimension = request.dimension ?? this.a.dimension;
    if (dimension !== this.a.dimension) throw new Error('wrong_dimension');
    if (!this.a._feet && !request.origin) throw new Error('no_position');
    const feet = this.a._feet;
    const sites = request.origin ? [request.origin] : [];
    if (!request.origin) {
      // Keep candidate count and survey distance bounded. Rotate the entire
      // footprint about each candidate; no hidden edits or terrain flattening.
      for (const radius of [3, 6, 9, 12]) for (const [dx, dz] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
        sites.push({ x: Math.floor(feet.x) + dx * radius, y: Math.floor(feet.y), z: Math.floor(feet.z) + dz * radius });
      }
    }
    let best = null;
    for (const origin of sites) {
      const plan = planStructure(blueprint, { origin, facing, dimension });
      const survey = inspectSite(plan, this.read);
      const entry = plan.routes.find(r => r.type === 'walk')?.points[0];
      const start = this.a._startNode();
      const access = entry && start && this.a._findPath(start, entry);
      if (!access || access.partial || !access.length) survey.issues.push({ reason: 'entry_unreachable', position: entry });
      survey.ok = !survey.issues.length;
      const report = { ok: survey.ok, plan, survey, missing: missingMaterials(plan, {}, this.a.inventory), materials: plan.required };
      if (!best || survey.issues.length < best.survey.issues.length) best = report;
      if (report.ok) return report;
    }
    return best;
  }

  configure (request) {
    if (!this.memory?.saveConstruction) throw new Error('construction_memory_unavailable');
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('invalid_construction_request');
    if (request.projectId) {
      if (request.type || request.parameters || request.design || request.origin || request.facing) throw new Error('immutable_construction_project');
      const project = this.memory.getConstruction(request.projectId);
      if (!project) throw new Error('unknown_construction_project');
      if (project.dimension !== this.a.dimension) throw new Error('wrong_dimension');
      if (validateBlueprint(project.plan?.blueprint).length) throw new Error('construction_snapshot_invalid');
      const restoredPlan = planStructure(project.plan.blueprint, project.plan);
      if (restoredPlan.hash !== project.plan.hash) throw new Error('construction_snapshot_invalid');
      project.plan = restoredPlan;
      if (this.session) {
        if (this.project?.id === request.projectId && ['pause', 'cancel'].includes(request.command)) {
          this.control(request.command); return { projectId: request.projectId, command: request.command };
        }
        throw new Error('busy');
      }
      this.project = project;
      this.recoverClaims();
      if (request.command) {
        const result = this.control(request.command);
        if (!result.ok) return result;
      } else if (project.state === 'paused') {
        const result = this.control('resume');
        if (!result.ok) return result;
      }
      return { projectId: project.id, ...(request.command ? {command: request.command} : {}) };
    }
    if (this.project && !['complete', 'cancelled'].includes(this.project.state)) throw new Error('construction_already_active');
    if (this.a.busy) throw new Error('busy');
    const authorized = request.authorizedContainers ?? [];
    if (!Array.isArray(authorized) || !authorized.every(p => p && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k])))) throw new Error('invalid_authorized_containers');
    const report = this.preview(request);
    if (!report.ok) return { ok: false, error: 'construction_site_blocked', issues: report.survey.issues.slice(0, 20) };
    const id = `construction_${randomUUID()}`;
    this.project = { id, kind: 'construction', type: request.type, dimension: this.a.dimension,
      position: report.plan.origin, plan: report.plan, state: 'building', phase: 'floor',
      claims: {}, removed: [], placed: 0, functionalIndex: 0, walkIndex: 0,
      lastError: null, verification: null, startedAt: clock(), lastSeenAt: clock(),
      status: 'known', source: 'planner', authorizedContainers: authorized };
    this.save();
    return { projectId: id };
  }

  save () {
    this.project.lastSeenAt = clock();
    this.memory.saveConstruction(this.project);
  }

  recoverClaims () {
    const p = this.project;
    // A crash can occur after the ledger flush but before the project flush.
    // Recover only entries tagged with this unique project and exact state.
    for (const row of this.memory.placements?.() ?? []) {
      if (row.projectId !== p.id || row.dimension !== p.dimension || !row.signature) continue;
      const k = keyOf(row.position);
      if (!p.claims[k] && stateSignature(this.read(row.position)) === row.signature) p.claims[k] = { signature: row.signature, block: row.type, at: row.placedAt };
    }
    // Composite upper halves are not extra material placements. Removed
    // temporary cells still count as work performed by this project.
    p.placed = p.plan.cells.filter(c => p.claims[keyOf(c.position)] || p.removed.includes(keyOf(c.position))).length;
    this.save();
  }

  control (command) {
    if (!this.project) return { ok: false, error: 'no_construction_project' };
    if (!['pause', 'resume', 'cancel'].includes(command)) throw new Error('invalid_construction_command');
    if (this.project.state === 'complete') return { ok: false, error: 'construction_already_complete' };
    this.session?.abort();
    if (this.session) { this.a._finishMotion('timeout'); this.a._stopMotion(); }
    if (command === 'pause') this.project.state = 'paused';
    if (command === 'cancel') this.project.state = 'cancelled';
    if (command === 'resume') {
      if (this.project.state === 'cancelled') return { ok: false, error: 'construction_cancelled' };
      const check = inspectSite(this.project.plan, this.read, this.project.claims, { cleaned: this.project.phase === 'cleanup' });
      if (!check.ok) return this.fail('construction_site_changed', check.issues.slice(0, 20));
      this.project.state = 'building'; this.project.lastError = null;
      // Movement/container checks must be run again after an interruption.
      this.project.functionalIndex = 0; this.project.walkIndex = 0;
    }
    this.save();
    return { ok: true, projectId: this.project.id, state: this.project.state };
  }

  fail (error, details = null) {
    this.project.lastError = { error, details, at: clock() };
    if (!['paused', 'cancelled'].includes(this.project.state)) this.project.state = 'blocked';
    this.save();
    return { ok: false, error, details, projectId: this.project.id };
  }

  view () {
    const p = this.project;
    if (!p) return { designer: designCapabilities(), catalogue: [...catalogue.values()].map(d => ({ id: d.id, description: d.description, defaults: d.defaults, limits: d.limits })) };
    return { projectId: p.id, type: p.type, dimension: p.dimension, origin: p.plan.origin, facing: p.plan.facing,
      designer: p.plan.blueprint.designer ?? 'template', intent: p.plan.blueprint.intent ?? null,
      stages: p.plan.blueprint.stages ?? null, coverage: p.plan.blueprint.coverage ?? null,
      rooms: p.plan.blueprint.rooms ?? null,
      currentStage: p.plan.cells.filter(c => !p.claims[keyOf(c.position)] && !p.removed.includes(keyOf(c.position))).sort((a, b) => (a.stage ?? 0) - (b.stage ?? 0))[0]?.stage ?? null,
      parameters: p.plan.blueprint.parameters, bounds: p.plan.bounds, state: p.state, phase: p.phase,
      placed: p.placed, total: p.plan.cells.length, missing: missingMaterials(p.plan, p.claims, this.a.inventory, { cleaned: p.phase === 'cleanup' || p.state === 'complete' }),
      lastError: p.lastError, verification: p.verification, functionalIndex: p.functionalIndex, walkIndex: p.walkIndex, temporaryRemoved: p.removed.length,
      siteIssues: inspectSite(p.plan, this.read, p.claims, { cleaned: p.phase === 'cleanup' || p.state === 'complete' }).issues.slice(0, 8) };
  }

  // A line-of-sight proof against loaded world cells; no clicks through walls.
  lineClear (feet, support, cell) {
    const from = { x: feet.x + (feet.actual ? 0 : 0.5) + (feet.edge?.x ?? 0), y: feet.y + 1.62, z: feet.z + (feet.actual ? 0 : 0.5) + (feet.edge?.z ?? 0) };
    const click = CLICK_POS[support.face] ?? { x: 0.5, y: 0.5, z: 0.5 };
    const to = { x: support.position.x + click.x, y: support.position.y + click.y, z: support.position.z + click.z };
    // The clicked face must face the eyes: ignoring the whole support voxel
    // would incorrectly allow clicks through its far side or bottom.
    if ((support.face === 1 && from.y <= to.y) || (support.face === 2 && from.z >= to.z) ||
        (support.face === 3 && from.z <= to.z) || (support.face === 4 && from.x >= to.x) ||
        (support.face === 5 && from.x <= to.x)) return false;
    const steps = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) * 8);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const at = { x: Math.floor(from.x + (to.x - from.x) * t), y: Math.floor(from.y + (to.y - from.y) * t), z: Math.floor(from.z + (to.z - from.z) * t) };
      if (keyOf(at) === keyOf(support.position) || keyOf(at) === keyOf(cell.position)) continue;
      const block = this.read(at);
      if (!known(block) || (!isAir(block) && !/torch$/.test(block.name))) return false;
    }
    return true;
  }

  workPosition (cell, support, reachable, { removing = false } = {}) {
    const a = this.a;
    const all = reachable ?? a.reachableCells({ limit: 5000, ttlMs: 0 }).cells;
    const candidates = [...all].map(parseKey).flatMap(p => {
      const delta = { 2: { x: 0, z: -0.55 }, 3: { x: 0, z: 0.55 }, 4: { x: -0.55, z: 0 }, 5: { x: 0.55, z: 0 } }[support.face];
      if (!removing && delta && p.x === support.position.x && p.z === support.position.z && p.y === support.position.y + 1) return [p, { ...p, edge: delta }];
      return [p];
    }).filter(p => {
      if (Math.abs(p.x - support.position.x) > 5 || Math.abs(p.z - support.position.z) > 5 || Math.abs(p.y - support.position.y) > 6) return false;
      const feet = this.read(p), head = this.read({ ...p, y: p.y + 1 });
      const passable = b => isAir(b) || /torch$|door$/.test(b?.name ?? '');
      if (!passable(feet) || !passable(head) || !safeSolid(this.read({ ...p, y: p.y - 1 }))) return false;
      if (p.edge && a._collides(p.x + 0.5 + p.edge.x, p.y, p.z + 0.5 + p.edge.z)) return false;
      if (removing) {
        if (keyOf({ ...p, y: p.y - 1 }) === keyOf(cell.position)) return false;
      }
      if ([cell, ...cell.secondary].some(c => c.position.x === p.x && c.position.z === p.z && [p.y, p.y + 1].includes(c.position.y))) return false;
      const eye = { x: p.x + 0.5 + (p.edge?.x ?? 0), y: p.y + 1.62, z: p.z + 0.5 + (p.edge?.z ?? 0) };
      return Math.hypot(eye.x - support.position.x - 0.5, eye.y - support.position.y - 0.5, eye.z - support.position.z - 0.5) <= 4.4 && this.lineClear(p, support, cell);
    }).sort((p, q) => Math.hypot(p.x - a._feet.x, p.y - a._feet.y, p.z - a._feet.z) - Math.hypot(q.x - a._feet.x, q.y - a._feet.y, q.z - a._feet.z));
    if (!removing) return candidates[0] ?? null;
    const retreat = this.project.plan.routes.find(r => r.type === 'walk').points[0];
    // Prove an escape path in the post-removal world, not just that the current
    // block underfoot remains. This permits safely dismantling a staircase
    // from its lower treads, while rejecting a stranded scaffold perch.
    for (const candidate of candidates) {
      const previous = a._pathOverrides;
      a._pathOverrides = new Set([keyOf(cell.position)]);
      try {
        const path = a._findPath(candidate, retreat);
        if (path?.length && keyOf(path.at(-1)) === keyOf(retreat)) return candidate;
      } finally { a._pathOverrides = previous; }
    }
    return null;
  }

  nextPlacement (pending) {
    const reachable = this.a.reachableCells({ limit: 5000, ttlMs: 0 }).cells;
    // Complete structural blocks before fittings; never consume the last floor
    // materials crafting decoration while a supported structural step is ready.
    const order = { floor: 0, access: 1, walls: 2, roof: 3, fittings: 4 };
    const stage = Math.min(...pending.map(c => c.stage ?? 0));
    const sorted = pending.filter(c => (c.stage ?? 0) === stage).sort((a, b) => order[a.phase] - order[b.phase] || a.position.y - b.position.y);
    for (const cell of sorted) {
      if (!(this.a.inventory[cell.item] > 0)) continue;
      for (const support of placementSupports(cell, this.read)) {
        const stand = this.workPosition(cell, support, reachable);
        if (stand) return { cell, support, stand };
      }
    }
    return null;
  }

  supplyChoice (item, seen = new Set()) {
    const a = this.a, p = this.project;
    if (seen.has(item) || seen.size > 10) return null;
    seen.add(item);
    if (!this.capacity(item)) return this.surplusDeposit();
    const allowed = pos => p.authorizedContainers.some(c => keyOf(c) === keyOf(pos));
    const containers = [...(a._cachedContainers?.() ?? []), ...(a._rememberedStorage?.() ?? [])];
    const source = containers.find(c => allowed(c.position) && c.contents?.[item] > 0);
    if (source && this.capacity(item) > 0) return { type: 'take', item, position: source.position };
    if (a._craftableNow(item)) return { type: 'craft', item };
    for (const entry of a.recipes?.get(item) ?? []) {
      const recipe = a._recipeBody(entry);
      if (!recipe) continue;
      if (((recipe.width ?? 1) > 2 || (recipe.height ?? 1) > 2) && !a.world.findBlocks('crafting_table', a.position, 32, 1).length) {
        if (a.inventory.crafting_table > 0) return this.stationChoice();
        const table = this.supplyChoice('crafting_table', new Set(seen));
        if (table) return table;
      }
      for (const { ingredient, count } of a._recipeIngredientCounts(recipe, true)) {
        if (a._heldMatching(ingredient) >= count) continue;
        if (ingredient.descriptor_type === 'item_tag' && !/^(planks|logs?|wooden_logs|coals?|wools?|stone_tool_materials|stone_crafting_materials)$/.test(String(ingredient.tag).replace(/^minecraft:/, ''))) continue;
        const candidates = ingredient.name ? [String(ingredient.name).replace(/^minecraft:/, '')] : Object.keys(a.world.registry?.itemsByName ?? {}).filter(n => a._ingredientMatches(ingredient, n));
        for (const material of candidates.sort((x, y) => Number(y === 'oak_planks' || y === 'oak_log' || y === 'coal') - Number(x === 'oak_planks' || x === 'oak_log' || x === 'coal'))) {
          const choice = this.supplyChoice(material, new Set(seen));
          if (choice) return choice;
        }
      }
    }
    const mine = item === 'cobblestone' ? 'stone' : item;
    if (!/^(stone|coal|coal_ore|[a-z_]+_log)$/.test(mine)) return null;
    const name = mine === 'coal' ? 'coal_ore' : mine;
    if (name === 'stone' && !Object.entries(a.inventory).some(([n, count]) => /pickaxe$/.test(n) && count > 0)) return this.supplyChoice('wooden_pickaxe', new Set(seen));
    a._refreshNearby();
    const offered = new Set(a.options({ localGatherOnly: true }).map(option => option.key));
    const step = a._gatherStepFor({ descriptor_type: 'name', name: item }, offered);
    if (!step) return null;
    if (step.source === 'remembered_resource_site') return { ...step, type: 'remembered_resource_site', item };
    const target = a._pickMineTarget(a.world.findBlocks(step.key.slice('mine_'.length), a.position, 96, 12));
    return target ? { type: 'mine', item, key: step.key, target } : null;
  }

  capacity (item) {
    const stackSize = this.a.world.registry?.itemsByName?.[item]?.stackSize ?? 64;
    let room = 0;
    for (let index = 0; index < 36; index++) {
      const slot = this.a.inventorySlots[index];
      if (!(slot?.count > 0)) room += stackSize;
      else if (this.a._slotItemName(slot) === item) room += Math.max(0, stackSize - slot.count);
    }
    return room;
  }

  surplusDeposit () {
    const p = this.project;
    const containers = [...(this.a._cachedContainers?.() ?? []), ...(this.a._rememberedStorage?.() ?? [])];
    const target = containers.find(c => p.authorizedContainers.some(pos => keyOf(pos) === keyOf(c.position)));
    if (!target) return null;
    const reserved = new Set([...Object.keys(p.plan.required), 'stick', 'crafting_table', 'coal', 'charcoal']);
    const item = Object.keys(this.a.inventory).find(n => this.a.inventory[n] > 0 && !reserved.has(n) &&
      !/(_log|_planks|_pickaxe|_axe|_shovel|_hoe|_sword|_helmet|_chestplate|_leggings|_boots)$/.test(n) &&
      !/(shield|bucket|bow|arrow|bread|apple|potato|carrot|beef|porkchop|chicken|mutton|fish|cod|salmon|stew|berry|melon|cookie|pie)/.test(n));
    return item ? { type: 'deposit', item, position: target.position } : null;
  }

  stationChoice () {
    const a = this.a, p = this.project;
    const reserved = new Set([...p.plan.cells.flatMap(c => [c.position, ...c.secondary.map(s => s.position)]), ...p.plan.clearance, ...p.plan.terrain].map(keyOf));
    for (let radius = 1; radius <= 4; radius++) for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
      const target = { x: Math.floor(a._feet.x) + dx, y: Math.floor(a._feet.y), z: Math.floor(a._feet.z) + dz };
      const support = { position: { ...target, y: target.y - 1 }, face: 1 };
      const cell = { item: 'crafting_table', block: 'crafting_table', position: target, secondary: [] };
      if (reserved.has(keyOf(target)) || !isAir(this.read(target)) || !usableSupport(this.read(support.position))) continue;
      const stand = this.workPosition(cell, support);
      if (stand) return { type: 'station', item: 'crafting_table', cell, support, stand };
    }
    return null;
  }

  options () {
    const p = this.project;
    if (!p || !['building', 'verifying'].includes(p.state) || p.dimension !== this.a.dimension) return [];
    const check = inspectSite(p.plan, this.read, p.claims, { cleaned: p.phase === 'cleanup' });
    if (!check.ok) return [];
    if (p.phase === 'cleanup' || !check.pending.length) return [{ key: 'construction_step', description: `Verify or finish the ${p.type} construction (${p.id})` }];
    if (this.nextPlacement(check.pending)) return [{ key: 'construction_step', description: `Place up to ${CONSTRUCTION_BLOCK_BUDGET} confirmed blocks for the ${p.type} (${p.placed}/${p.plan.cells.length})` }];
    const need = missingMaterials(p.plan, p.claims, this.a.inventory);
    for (const row of need) if (this.supplyChoice(row.item)) return [{ key: 'construction_supply', description: `Obtain missing ${row.item} for the ${p.type}; remaining ${row.missing}` }];
    return [];
  }

  survivalVerdict () {
    const a = this.a;
    // Read live state without running observe(), memory searches or crafting.
    return evaluateSurvival({ position: a.position, spawned: a.spawned, status: a.status,
      health: a.health, food: a.food, inventory: a.inventory, dead: a.dead,
      sleeping: a.sleeping, dimension: a.dimension, time: a._timeInfo(),
      entities: a._hostiles(), fluids: a._fluidsView(), nether: a._netherView() }, { rules: survivalRules });
  }

  checkSession (session, signal, deadline) {
    if (session.signal.aborted || signal?.aborted || clock() >= deadline) throw new Error('construction_interrupted');
    if (!this.a.spawned || this.a.dead || this.a.status !== 'spawned') throw new Error('construction_connection_lost');
    if (this.project.dimension !== this.a.dimension) throw new Error('wrong_dimension');
  }

  async run (kind, { signal = null, timeoutMs = CONSTRUCTION_TIME_MS } = {}) {
    if (!this.project) return { ok: false, error: 'no_construction_project' };
    if (!['building', 'verifying'].includes(this.project.state)) return { ok: false, error: `construction_${this.project.state}` };
    const session = new AbortController();
    if (this.session) return { ok: false, error: 'busy' };
    this.session = session;
    const abort = () => { session.abort(); this.a._finishMotion('timeout'); this.a._stopMotion(); };
    signal?.addEventListener('abort', abort, { once: true });
    // Async-local context is inherited by every protocol primitive, including
    // inventory, crafting, mining and container operations used for supply.
    const scope = this.a._actionScope?.getStore();
    if (scope) scope.signal = session.signal;
    const deadline = clock() + Math.min(CONSTRUCTION_TIME_MS, Math.max(1, timeoutMs));
    const timer = setTimeout(abort, Math.max(1, deadline - clock()));
    let survivalStop = null;
    const checkSurvival = () => {
      const verdict = this.survivalVerdict();
      if (verdict.mode !== 'normal') survivalStop = summarizeSurvival(verdict);
      if (survivalStop) throw new Error('construction_survival_needed');
    };
    const guard = () => { this.checkSession(session, signal, deadline); checkSurvival(); };
    // Movement and protocol waits may not call the placement guard themselves.
    // Re-evaluate the same declarative governor while those promises are pending.
    const survivalMonitor = setInterval(() => {
      try { checkSurvival(); } catch { abort(); }
    }, 100);
    try {
      guard();
      const p = this.project;
      const check = inspectSite(p.plan, this.read, p.claims, { cleaned: p.phase === 'cleanup' });
      if (!check.ok) return this.fail('construction_site_changed', check.issues.slice(0, 20));
      if (kind === 'supply') {
        const need = missingMaterials(p.plan, p.claims, this.a.inventory);
        const choice = need.map(n => this.supplyChoice(n.item)).find(Boolean);
        if (!choice) return this.fail('construction_materials_unavailable', need);
        const a = this.a;
        guard();
        let result;
        if (this.capacity(choice.item) === 0 && !['station', 'deposit'].includes(choice.type)) return this.fail('construction_inventory_full', { item: choice.item });
        if (choice.type === 'craft') result = await a._craftItem(choice.item);
        if (choice.type === 'station') {
          const { cell, support, stand } = choice;
          await a._moveTo({ x: stand.x + 0.5, y: stand.y, z: stand.z + 0.5 }, 0.4, Math.min(8000, deadline - clock()), { signal: session.signal }); guard();
          result = await a._placeAtCell(cell.item, cell.block, cell.position, support.position, 1, CLICK_POS[1], { signal: session.signal, guard });
        }
        if (choice.type === 'remembered_resource_site') {
          result = await a.resourceSites.navigate(choice, { signal: session.signal, timeoutMs: Math.min(8000, deadline - clock()) });
          guard();
          // Navigation failure is a sourcing miss; the next bounded supply
          // action falls back to the refreshed local census or missingMaterials.
          return { ok: true, projectId: p.id, supply: { type: choice.type, item: choice.item, key: 'goto_waypoint' }, result };
        }
        if (choice.type === 'mine') {
          a._refreshNearby();
          const offered = a.options({ localGatherOnly: true });
          if (!offered.some(option => option.key === choice.key)) return this.fail('construction_materials_unavailable', missingMaterials(p.plan, p.claims, a.inventory));
          result = await a._runAction(choice.key);
        }
        if (choice.type === 'take') result = await a._takeFromContainer(choice.item, { position: choice.position, maxCount: Math.min(64, this.capacity(choice.item)) });
        if (choice.type === 'deposit') result = await a._depositItem(choice.item, { position: choice.position });
        guard();
        if (!result?.ok) return this.fail('construction_supply_failed', { choice, result });
        p.lastError = null; this.save();
        return { ok: true, projectId: p.id, supply: { type: choice.type, item: choice.item }, result };
      }
      if (p.phase === 'cleanup') return await this.cleanup(guard, session.signal, deadline);
      let placed = 0;
      for (; placed < CONSTRUCTION_BLOCK_BUDGET; placed++) {
        guard();
        const live = inspectSite(p.plan, this.read, p.claims);
        if (!live.ok) return this.fail('construction_site_changed', live.issues.slice(0, 20));
        if (!live.pending.length) return await this.verify(guard, deadline);
        const next = this.nextPlacement(live.pending);
        if (!next) {
          const missing = missingMaterials(p.plan, p.claims, this.a.inventory);
          if (placed) break;
          return this.fail(missing.length ? 'construction_missing_materials' : 'construction_unreachable', missing);
        }
        const { cell, support, stand } = next;
        const a = this.a;
        guard();
        if (Math.hypot(a._feet.x - stand.x - 0.5, a._feet.y - stand.y, a._feet.z - stand.z - 0.5) > (stand.edge ? 0.2 : 0.08) || !this.lineClear({ ...a._feet, actual: true }, support, cell)) {
          const moved = await a._moveTo({ x: stand.x + 0.5, y: stand.y, z: stand.z + 0.5 }, 0.08, Math.min(8000, deadline - clock()), { signal: session.signal, verticalTolerance: 0, arrivalVerticalTolerance: 0.15, preciseArrival: true });
          guard();
          if (moved?.ok === false) return this.fail('construction_move_failed', moved);
        }
        if (stand.edge) { await a._constructionEdge(stand, { signal: session.signal, timeoutMs: Math.min(2500, deadline - clock()) }); guard(); }
        const exact = { ...a._feet, actual: true };
        const occupiedByBot = [cell, ...cell.secondary].some(row => a._selfCells()?.has(keyOf(row.position)));
        if (occupiedByBot || !this.lineClear(exact, support, cell) || !isAir(this.read(cell.position)) ||
            !usableSupport(this.read(support.position))) return this.fail('construction_work_position_changed', { actual: exact, planned: stand, cell: cell.position, support, lineClear: this.lineClear(exact, support, cell), target: this.read(cell.position)?.name, supportBlock: this.read(support.position)?.name, occupiedByBot });
        // Tag the actual placement ledger inside the primitive, before its
        // promise resolves. This closes the placement/project persistence gap.
        let result;
        try {
          result = await a._placeAtCell(cell.item, cell.block, cell.position, support.position, support.face, CLICK_POS[support.face],
            { signal: session.signal, projectId: p.id, source: 'construction', guard, secondary: cell.secondary,
              yaw: cell.yaw ?? a._yawTo(a._feet, { x: support.position.x + CLICK_POS[support.face].x, z: support.position.z + CLICK_POS[support.face].z }),
              pitch: a._lookAt({ x: support.position.x + CLICK_POS[support.face].x, y: support.position.y + CLICK_POS[support.face].y, z: support.position.z + CLICK_POS[support.face].z }).pitch });
        } catch (error) {
          guard();
          return this.fail('construction_place_failed', { cell: cell.position, error: error.message });
        }
        guard();
        if (!result.ok) return this.fail('construction_place_failed', { cell: cell.position, planned: stand, actual: { ...a._feet }, support, placement: a._lastPlacement ?? null, result });
        const confirmationDeadline = Math.min(deadline, clock() + 2500);
        while (![cell, ...cell.secondary].every(row => matchesCell(this.read(row.position), row))) {
          guard();
          if (clock() >= confirmationDeadline) return this.fail('construction_state_not_confirmed', { position: cell.position });
          await delay(50, undefined, { signal: session.signal });
        }
        for (const row of [cell, ...cell.secondary]) {
          const block = this.read(row.position);
          if (!matchesCell(block, row)) return this.fail('construction_state_not_confirmed', { position: row.position });
          const signature = stateSignature(block);
          a._rememberPlacement({ position: row.position, block: row.block, item: cell.item, projectId: p.id, signature, source: 'construction' });
          p.claims[keyOf(row.position)] = { signature, block: row.block, at: clock() };
        }
        p.placed++; p.phase = cell.phase; p.lastError = null;
        a._reachCache = null;
        this.save();
      }
      return { ok: true, projectId: p.id, placed, state: p.state, phase: p.phase };
    } catch (error) {
      if (survivalStop) {
        if (!['paused', 'cancelled'].includes(this.project.state)) this.project.state = 'paused';
        this.project.lastError = { error: 'construction_survival_needed', details: survivalStop, at: clock() };
        this.save();
        return { ok: false, error: 'construction_survival_needed', details: survivalStop, projectId: this.project.id };
      }
      if (session.signal.aborted || signal?.aborted) {
        if (!['paused', 'cancelled'].includes(this.project.state)) this.project.state = 'paused';
        this.project.lastError = { error: 'construction_interrupted', at: clock() };
        this.save();
        return { ok: false, error: 'construction_interrupted', projectId: this.project.id };
      }
      return this.fail(error.message);
    } finally {
      this.a._constructionSneaking = false;
      clearTimeout(timer);
      clearInterval(survivalMonitor);
      signal?.removeEventListener('abort', abort);
      if (this.session === session) this.session = null;
    }
  }

  async verify (guard, deadline) {
    const p = this.project, a = this.a;
    p.state = 'verifying'; p.phase = 'verify'; this.save();
    const route = p.plan.routes[p.functionalIndex];
    if (route) {
      guard();
      if (route.type === 'walk') {
        const target = route.points[p.walkIndex];
        const moved = await a._moveTo({ x: target.x + 0.5, y: target.y, z: target.z + 0.5 }, 0.4, Math.min(8000, deadline - clock()), { signal: this.session.signal });
        guard();
        if (moved?.ok === false || Math.hypot(a._feet.x - target.x - 0.5, a._feet.y - target.y, a._feet.z - target.z - 0.5) > 0.9) return this.fail('construction_traversal_failed', { target, moved });
        p.walkIndex++;
        if (p.walkIndex >= route.points.length) { p.functionalIndex++; p.walkIndex = 0; }
      } else if (route.type === 'approach') {
        const cell = p.plan.cells.find(c => keyOf(c.position) === keyOf(route.position));
        if (!cell || !matchesCell(this.read(cell.position), cell)) return this.fail('construction_fitting_missing', { position: route.position });
        const stand = this.workPosition(cell, { position: cell.position });
        if (!stand) return this.fail('construction_fitting_inaccessible', { position: route.position });
        const moved = await a._moveTo({ x: stand.x + 0.5, y: stand.y, z: stand.z + 0.5 }, 0.08, Math.min(8000, deadline - clock()),
          { signal: this.session.signal, preciseArrival: true, verticalTolerance: 0, arrivalVerticalTolerance: 0.15 });
        guard();
        if (moved?.ok === false || Math.hypot(a._feet.x - stand.x - 0.5, a._feet.z - stand.z - 0.5) > 0.15 || Math.abs(a._feet.y - stand.y) > 0.15) return this.fail('construction_fitting_inaccessible', { position: cell.position, moved });
        if (cell.block === 'campfire' && campfireLit(this.read(cell.position)) !== true) return this.fail('construction_fireplace_unlit', { position: cell.position });
        if (cell.block === 'crafting_table') {
          await a._ensureCraftingTableOpen({ position: cell.position }); guard();
          if (a._openContainer?.type !== 'workbench' || keyOf(a._openContainerBlock?.position ?? {}) !== keyOf(cell.position)) return this.fail('construction_workbench_not_opened');
          await a._closeContainer();
        }
        p.functionalIndex++; p.walkIndex = 0;
      } else {
        await a._openStorageWindow({ name: 'chest', position: route.position }, { walkTimeoutMs: Math.min(8000, deadline - clock()), contentTimeoutMs: 1500 });
        guard();
        if (!a._openContainer || !a._openContainerBlock || keyOf(a._openContainerBlock.position) !== keyOf(route.position)) return this.fail('construction_container_not_opened', { position: route.position });
        await a._closeContainer(); guard(); p.functionalIndex++;
      }
      this.save();
      return { ok: true, projectId: p.id, phase: 'verify', checksCompleted: p.functionalIndex, walkIndex: p.walkIndex };
    }
    guard();
    const check = inspectSite(p.plan, this.read, p.claims);
    if (!check.ok || check.pending.length || !p.placed) return this.fail('construction_verification_failed', check.issues.slice(0, 20));
    p.phase = 'cleanup'; p.state = 'building'; this.save();
    return { ok: true, projectId: p.id, phase: 'cleanup' };
  }

  async cleanup (guard, signal, deadline) {
    const p = this.project, a = this.a;
    const pending = p.plan.cells.filter(c => c.temporary && p.claims[keyOf(c.position)]);
    if (pending.length) {
      // Ground position first. Never dismantle the platform under the bot.
      const retreat = p.plan.routes.find(r => r.type === 'walk').points[0];
      if (Math.hypot(a._feet.x - retreat.x - 0.5, a._feet.y - retreat.y, a._feet.z - retreat.z - 0.5) > 0.9) {
        await a._moveTo({ x: retreat.x + 0.5, y: retreat.y, z: retreat.z + 0.5 }, 0.4, Math.min(8000, deadline - clock()), { signal });
        guard();
      }
      let cell = null, stand = null;
      // A tall scaffold must be dismantled from another verified safe working
      // position; do not pretend distant blocks are in reach.
      // Mining aims at the block being removed, not at a placement support
      // behind it (that support may already have been dismantled).
      const reachable = a.reachableCells({ limit: 5000, ttlMs: 0 }).cells;
      let bestDistance = -1;
      for (const candidate of pending.sort((c, d) => d.position.y - c.position.y)) {
        if (cell && candidate.position.y < cell.position.y) break;
        const candidateStand = this.workPosition(candidate, { position: candidate.position }, reachable, { removing: true });
        if (!candidateStand) continue;
        // Remove the far end of an access platform before its connecting span.
        // Otherwise the bot can retreat safely yet strand the remaining blocks.
        const distance = a._findPath(retreat, candidateStand)?.length ?? 0;
        if (distance > bestDistance) { cell = candidate; stand = candidateStand; bestDistance = distance; }
      }
      if (!cell) return this.fail('construction_scaffold_unreachable', { positions: pending.slice(0, 8).map(c => c.position) });
      await a._moveTo({ x: stand.x + 0.5, y: stand.y, z: stand.z + 0.5 }, 0.4, Math.min(8000, deadline - clock()), { signal }); guard();
      const actual = this.read(cell.position), claim = p.claims[keyOf(cell.position)];
      if (!claim || claim.signature !== stateSignature(actual) || !matchesCell(actual, cell)) return this.fail('construction_scaffold_changed');
      const owned = this.memory.placementAt(cell.position, p.dimension);
      if (owned?.projectId !== p.id) return this.fail('construction_scaffold_not_owned');
      const result = await a._mineBlock({ ...actual, position: cell.position }); guard();
      if (!result.ok || !isAir(this.read(cell.position))) return this.fail('construction_cleanup_failed', result);
      a._forgetPlacement(cell.position); delete p.claims[keyOf(cell.position)]; p.removed.push(keyOf(cell.position));
      a._reachCache = null; this.save();
      return { ok: true, projectId: p.id, removed: cell.position, remaining: pending.length - 1 };
    }
    guard();
    const check = inspectSite(p.plan, this.read, p.claims, { cleaned: true });
    if (!check.ok || check.pending.length) return this.fail('construction_verification_failed', check.issues.slice(0, 20));
    p.verification = { ok: true, at: clock(), hash: p.plan.hash, geometry: check.confirmed,
      functionalChecks: p.functionalIndex, temporaryRemoved: p.removed.length };
    p.state = 'complete'; p.completedAt = clock(); p.lastError = null; this.save();
    this.memory.rememberLandmark({ id: `built_${p.id}`, type: p.type, kind: 'structure', dimension: p.dimension,
      position: p.plan.origin, source: 'construction', tags: ['bot_built'] });
    return { ok: true, projectId: p.id, state: 'complete', verification: p.verification };
  }
}
