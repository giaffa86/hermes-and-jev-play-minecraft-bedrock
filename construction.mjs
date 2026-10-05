// Pure construction geometry and verification. Models select data, never code.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { forbiddenBlock } from './circuits.mjs';

export const CONSTRUCTION_VERSION = 1;
export const MAX_CONSTRUCTION_CELLS = 4096;
export const FACINGS = ['south', 'east', 'north', 'west'];
export const PHASES = ['floor', 'access', 'walls', 'roof', 'fittings', 'verify', 'cleanup'];
export const keyOf = p => `${p.x},${p.y},${p.z}`;
export const isAir = block => ['air', 'cave_air', 'void_air'].includes(block?.name);
export const known = block => !!block?.name && block.name !== 'unknown';
export const safeSolid = block => known(block) && block.boundingBox === 'block' &&
  !/water|lava|magma|fire|cactus|campfire|powder_snow/.test(block.name);
export const usableSupport = block => safeSolid(block) &&
  !/(chest|barrel|shulker|hopper|furnace|_table|door|bed|anvil|lever|button|composter)/.test(block.name);
export const naturalTerrain = block => safeSolid(block) && /^(stone|deepslate|granite|diorite|andesite|dirt|grass|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium|mud|clay|sand|red_sand|gravel|netherrack|end_stone|moss_block)$/.test(block.name);

export function rotate (p, facing) {
  const [x, y, z] = p;
  return { south: [x, y, z], east: [z, y, -x], north: [-x, y, -z], west: [-z, y, x] }[facing];
}

export function worldCell (origin, offset, facing = 'south') {
  const [x, y, z] = rotate(offset, facing);
  return { x: origin.x + x, y: origin.y + y, z: origin.z + z };
}

const FULL_BLOCKS = /^(cobblestone|cobbled_deepslate|stone|blackstone|bricks|stone_bricks|deepslate_bricks|sandstone|smooth_sandstone|glass|[a-z_]+_planks|[a-z_]+_log)$/;
const names = value => typeof value === 'string' && /^[a-z][a-z0-9_]*$/.test(value);
const offsetOK = p => Array.isArray(p) && p.length === 3 && p.every(Number.isSafeInteger) && p.every(v => Math.abs(v) <= 128);

export function loadStructures (dir = new URL('./structures/', import.meta.url)) {
  const out = new Map();
  for (const file of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    const def = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
    if (!names(def.id) || out.has(def.id) || def.version !== CONSTRUCTION_VERSION ||
        !['platform', 'house', 'bridge', 'tower', 'warehouse'].includes(def.kind)) {
      throw new Error(`Invalid structure definition: ${file}`);
    }
    // Exercise the generator and validator at load, not during the first run.
    createBlueprint(def);
    out.set(def.id, def);
  }
  return out;
}

export function createBlueprint (def, parameters = {}) {
  if (!def || def.version !== CONSTRUCTION_VERSION) throw new Error('unsupported_blueprint_version');
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error('invalid_parameters');
  for (const k of Object.keys(parameters)) if (!['width', 'length', 'height', 'chests', 'palette'].includes(k)) throw new Error(`unknown_parameter:${k}`);
  const p = { ...def.defaults, ...parameters, palette: { ...def.palette, ...parameters.palette } };
  for (const [name, limits] of Object.entries(def.limits ?? {})) {
    if (!Number.isInteger(p[name]) || p[name] < limits[0] || p[name] > limits[1]) throw new Error(`invalid_${name}`);
  }
  for (const role of Object.keys(p.palette)) {
    if (!['floor', 'wall', 'roof', 'access', 'door', 'light', 'storage'].includes(role)) throw new Error(`unknown_palette_role:${role}`);
    const item = p.palette[role];
    if (!names(item) || forbiddenBlock(item) ||
        (['floor', 'wall', 'roof', 'access'].includes(role) && !FULL_BLOCKS.test(item)) ||
        (role === 'door' && item !== 'wooden_door') ||
        (role === 'light' && item !== 'torch') ||
        (role === 'storage' && item !== 'chest')) throw new Error(`unsupported_material:${role}`);
  }
  const { width: w, length: l, height: h = 0 } = p;
  const mid = Math.floor(w / 2);
  const cells = new Map();
  const clear = new Map();
  const terrain = new Map();
  const routes = [];
  const add = (x, y, z, role, phase, extra = {}) => {
    const offset = [x, y, z];
    const k = offset.join(',');
    const row = { offset, item: p.palette[role], block: p.palette[role], phase, ...extra };
    if (cells.has(k)) {
      const previous = cells.get(k);
      if (previous.block !== row.block) throw new Error(`duplicate_cell:${k}`);
      return;
    }
    cells.set(k, row);
  };
  const air = (x, y, z) => clear.set([x, y, z].join(','), [x, y, z]);
  const ground = (x, y, z) => terrain.set([x, y, z].join(','), [x, y, z]);
  for (let z = 0; z < l; z++) for (let x = 0; x < w; x++) {
    add(x, 0, z, 'floor', 'floor');
    if (def.kind !== 'bridge' || z === 0 || z === l - 1) ground(x, -1, z);
  }
  if (def.kind === 'platform' || def.kind === 'bridge') {
    for (let z = 0; z < l; z++) for (let x = 0; x < w; x++) {
      if (def.kind === 'bridge' && (x === 0 || x === w - 1)) add(x, 1, z, 'wall', 'walls');
      else { air(x, 1, z); air(x, 2, z); }
    }
    for (const z of [-1, l]) { ground(mid, -1, z); air(mid, 0, z); air(mid, 1, z); air(mid, 2, z); }
    routes.push({ type: 'walk', points: [[mid, 0, -1], [mid, 1, 0], [mid, 1, l - 1], [mid, 0, l]] });
  } else {
    // Interior full-block staircase for a tower: one lap, two tread cells per
    // elevation. Columns below the treads are genuine support, not flying blocks.
    const stairs = new Map();
    if (def.kind === 'tower') {
      const ring = [];
      for (let x = mid; x <= w - 2; x++) ring.push([x, 1]);
      for (let z = 2; z <= l - 2; z++) ring.push([w - 2, z]);
      for (let x = w - 3; x >= 1; x--) ring.push([x, l - 2]);
      for (let z = l - 3; z >= 1; z--) ring.push([1, z]);
      for (let x = 2; x < mid; x++) ring.push([x, 1]);
      if (ring.length < (h + 1) * 2) throw new Error('tower_staircase_too_short');
      const walk = [];
      for (let i = 0; i < (h + 1) * 2; i++) {
        const [x, z] = ring[i];
        const top = Math.floor(i / 2) + 1;
        stairs.set(`${x},${z}`, top);
        for (let y = 1; y <= top; y++) add(x, y, z, 'access', 'access');
        walk.push([x, top + 1, z]);
      }
      routes.push({ type: 'walk', points: [[mid, 0, -1], ...walk] });
    }
    for (let y = 1; y <= h; y++) for (let z = 0; z < l; z++) for (let x = 0; x < w; x++) {
      const boundary = x === 0 || x === w - 1 || z === 0 || z === l - 1;
      const door = z === 0 && x === mid && y <= 2;
      if (boundary && !door) add(x, y, z, 'wall', 'walls');
      else if (!door && y > (stairs.get(`${x},${z}`) ?? 0)) air(x, y, z);
    }
    add(mid, 1, 0, 'door', 'fittings', { properties: { upper_block_bit: false }, secondary: [{ offset: [mid, 2, 0], block: p.palette.door, properties: { upper_block_bit: true } }] });
    const roofY = h + 1;
    for (let z = 0; z < l; z++) for (let x = 0; x < w; x++) {
      const top = stairs.get(`${x},${z}`) ?? 0;
      if (top >= roofY - 2) { if (top < roofY) air(x, roofY, z); continue; }
      add(x, roofY, z, 'roof', 'roof');
    }
    // Tower observation deck rail and headroom. The permanent staircase reaches
    // the deck through the hatch, and the temporary external stair is removed.
    if (def.kind === 'tower') {
      for (let z = 0; z < l; z++) for (let x = 0; x < w; x++) {
        if (x === 0 || z === 0 || x === w - 1 || z === l - 1) add(x, roofY + 1, z, 'wall', 'fittings');
        else if (!stairs.has(`${x},${z}`)) { air(x, roofY + 1, z); air(x, roofY + 2, z); }
      }
    }
    for (let z = 1; z < l - 1; z += 3) if (!stairs.has(`${mid},${z}`)) add(mid, 1, z, 'light', 'fittings');
    // Clear the center aisle; storage has independent lids and no double chests.
    if (def.kind === 'warehouse') {
      const positions = [];
      for (let z = 2; z < l - 2; z += 2) for (const x of [1, w - 2]) positions.push([x, 1, z]);
      if (positions.length < p.chests) throw new Error('warehouse_storage_does_not_fit');
      for (const [x, y, z] of positions.slice(0, p.chests)) {
        add(x, y, z, 'storage', 'fittings');
        routes.push({ type: 'container', offset: [x, y, z] });
      }
    }
    ground(mid, -1, -1); air(mid, 0, -1); air(mid, 1, -1); air(mid, 2, -1);
    if (def.kind !== 'tower') routes.push({ type: 'walk', points: [[mid, 0, -1], [mid, 1, 1], [mid, 1, l - 2], [mid, 0, -1]] });
    // Budgeted temporary stairs and an exterior working ring. This makes tall
    // walls reachable without unsupported placement or unsafe pillar drops.
    {
      const top = roofY;
      for (let step = 0; step <= top; step++) {
        const z = step - 3;
        ground(-2, -1, z);
        for (let y = 0; y <= step; y++) add(-2, y, z, 'access', 'access', { temporary: true });
        air(-2, step + 1, z); air(-2, step + 2, z);
      }
      ground(-2, -1, -4); air(-2, 0, -4); air(-2, 1, -4); air(-2, 2, -4);
      for (let z = -1; z <= l; z++) for (let x = -1; x <= w; x++) {
        if (x !== -1 && x !== w && z !== -1 && z !== l) continue;
        add(x, top, z, 'access', 'access', { temporary: true });
        air(x, top + 1, z); air(x, top + 2, z);
      }
    }
  }
  // Explicit geometry is the persistent source of truth. A template update
  // cannot silently change an existing project after restart.
  const rows = [...cells.values()].sort((a, b) => a.offset[1] - b.offset[1] ||
    PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase) || a.offset[2] - b.offset[2] || a.offset[0] - b.offset[0]);
  const occupied = new Set(rows.flatMap(c => [c.offset, ...(c.secondary ?? []).map(s => s.offset)]).map(p => p.join(',')));
  const blueprint = { version: CONSTRUCTION_VERSION, id: def.id, kind: def.kind, parameters: p,
    cells: rows, clearance: [...clear.values()].filter(p => !occupied.has(p.join(','))), terrain: [...terrain.values()], routes };
  const errors = validateBlueprint(blueprint);
  if (errors.length) throw new Error(`invalid_blueprint:${errors.join(';')}`);
  return blueprint;
}

export function validateBlueprint (b) {
  const errors = [];
  if (b?.version !== CONSTRUCTION_VERSION || !names(b?.id)) return ['invalid_identity'];
  if (!b.parameters?.palette || typeof b.parameters.palette !== 'object' || Array.isArray(b.parameters.palette)) errors.push('invalid_palette');
  if (!Array.isArray(b.cells) || !b.cells.length || b.cells.length > MAX_CONSTRUCTION_CELLS) return ['invalid_cell_count'];
  const occupied = new Set();
  for (const c of b.cells) {
    if (!c || typeof c !== 'object') { errors.push('invalid_cell'); continue; }
    if (!names(c.item) || !names(c.block) || forbiddenBlock(c.item) || forbiddenBlock(c.block)) errors.push('invalid_material');
    if (!PHASES.includes(c.phase)) errors.push('invalid_phase');
    if (c.secondary != null && !Array.isArray(c.secondary)) { errors.push('invalid_secondary'); continue; }
    for (const row of [c, ...(c.secondary ?? [])]) {
      if (!row || !names(row.block) || forbiddenBlock(row.block)) { errors.push('invalid_secondary_material'); continue; }
      if (!offsetOK(row.offset)) { errors.push('invalid_offset'); continue; }
      const k = row.offset.join(',');
      if (occupied.has(k)) errors.push(`duplicate:${k}`);
      occupied.add(k);
      if (row.properties && (typeof row.properties !== 'object' || Array.isArray(row.properties))) errors.push('invalid_properties');
    }
  }
  for (const field of ['clearance', 'terrain']) {
    if (!Array.isArray(b[field])) { errors.push(`invalid_${field}`); continue; }
    for (const p of b[field]) {
      if (!offsetOK(p)) errors.push(`invalid_${field}_offset`);
      if (field === 'clearance' && offsetOK(p) && occupied.has(p.join(','))) errors.push(`clearance_collision:${p.join(',')}`);
    }
  }
  if (!Array.isArray(b.routes) || !b.routes.length) errors.push('no_functional_checks');
  else for (const route of b.routes) {
    if (!route || typeof route !== 'object') { errors.push('invalid_functional_check'); continue; }
    if (route.type === 'walk') {
      if (!Array.isArray(route.points) || route.points.length < 2 || !route.points.every(offsetOK)) errors.push('invalid_walk');
    } else if (!['container', 'approach'].includes(route.type) || !offsetOK(route.offset)) errors.push('invalid_functional_check');
  }
  // A valid plan needs a chain of genuine supports rooted in declared terrain.
  // Interactive fittings cannot support other placements. The executor still
  // proves the actual support in the world before each individual click.
  if (!errors.length) {
    const supported = new Set(b.terrain.map(p => p.join(',')));
    let remaining = [...b.cells];
    while (remaining.length) {
      const before = remaining.length;
      remaining = remaining.filter(c => {
        const [x, y, z] = c.offset;
        const neighbors = [[x, y - 1, z]];
        if (FULL_BLOCKS.test(c.block)) neighbors.push([x - 1, y, z], [x + 1, y, z], [x, y, z - 1], [x, y, z + 1]);
        if (!neighbors.some(p => supported.has(p.join(',')))) return true;
        if (FULL_BLOCKS.test(c.block)) supported.add(c.offset.join(','));
        return false;
      });
      if (remaining.length === before) { errors.push('unsupported_component'); break; }
    }
  }
  return errors;
}

export function planStructure (blueprint, { origin, facing = 'south', dimension = 'overworld' }) {
  const errors = validateBlueprint(blueprint);
  if (errors.length) throw new Error(`invalid_blueprint:${errors.join(';')}`);
  if (!origin || !['x', 'y', 'z'].every(k => Number.isSafeInteger(origin[k])) ||
      Math.abs(origin.x) > 30000000 || Math.abs(origin.z) > 30000000 || origin.y < -64 || origin.y > 300 ||
      !FACINGS.includes(facing) || !['overworld', 'nether', 'the_end'].includes(dimension)) throw new Error('invalid_site');
  if (dimension !== 'overworld' && Object.values(blueprint.parameters.palette).some(n => /_planks$|wooden_door/.test(n))) throw new Error('flammable_dimension_palette');
  const at = p => worldCell(origin, p, facing);
  const cells = blueprint.cells.map(c => ({ ...c, position: at(c.offset), secondary: (c.secondary ?? []).map(s => ({ ...s, position: at(s.offset) })) }));
  for (const c of cells) if (c.facing) {
    c.facing = FACINGS[(FACINGS.indexOf(c.facing) + FACINGS.indexOf(facing)) % 4];
    c.yaw = { south: 0, east: 270, north: 180, west: 90 }[c.facing];
  }
  if (cells.some(c => c.position.y > 319 || c.position.y < -64)) throw new Error('outside_world_height');
  const required = {};
  for (const c of cells) required[c.item] = (required[c.item] ?? 0) + 1;
  const points = cells.map(c => c.position);
  const bounds = Object.fromEntries(['x', 'y', 'z'].map(k => [k, [Math.min(...points.map(p => p[k])), Math.max(...points.map(p => p[k]))]]));
  const hash = createHash('sha256').update(JSON.stringify({ blueprint, origin, facing, dimension })).digest('hex');
  return { hash, blueprint, origin, facing, dimension, cells, required, bounds,
    clearance: blueprint.clearance.map(at), terrain: blueprint.terrain.map(at),
    routes: blueprint.routes.map(r => ({ ...r, points: r.points?.map(at), position: r.offset ? at(r.offset) : undefined })) };
}

export function propertiesOf (block) { return block?.getProperties?.() ?? block?.properties ?? {}; }
export function matchesCell (block, cell) {
  return known(block) && block.name === cell.block && Object.entries(cell.properties ?? {}).every(([k, v]) => propertiesOf(block)[k] === v);
}
export function stateSignature (block) {
  return JSON.stringify([block?.name, Object.entries(propertiesOf(block)).filter(([k]) => !['open_bit', 'powered_bit'].includes(k)).sort(([a], [b]) => a.localeCompare(b))]);
}

export function inspectSite (plan, read, claims = {}, { cleaned = false } = {}) {
  const issues = [];
  let confirmed = 0;
  const pending = [];
  for (const c of plan.cells) {
    if (cleaned && c.temporary) continue;
    let complete = true;
    for (const row of [c, ...c.secondary]) {
      const block = read(row.position);
      const claim = claims[keyOf(row.position)];
      if (!known(block)) { issues.push({ reason: 'unknown', position: row.position }); complete = false; }
      else if (claim) {
        if (!matchesCell(block, row) || claim.signature !== stateSignature(block)) issues.push({ reason: 'changed', position: row.position });
      } else {
        complete = false;
        if (!isAir(block)) issues.push({ reason: 'occupied', position: row.position, block: block.name });
      }
    }
    if (complete) confirmed++;
    else pending.push(c);
  }
  for (const p of plan.clearance) if (!isAir(read(p))) issues.push({ reason: known(read(p)) ? 'clearance_blocked' : 'unknown', position: p });
  for (const p of plan.terrain) if (!naturalTerrain(read(p))) issues.push({ reason: 'unsafe_terrain', position: p });
  if (plan.blueprint.kind === 'bridge' && /_planks$/.test(plan.blueprint.parameters.palette.floor)) {
    for (const c of plan.cells.filter(c => c.phase === 'floor')) if (/lava/.test(read({ ...c.position, y: c.position.y - 1 })?.name ?? '')) issues.push({ reason: 'flammable_lava_bridge', position: c.position });
  }
  return { ok: !issues.length, issues, confirmed, pending, total: plan.cells.filter(c => !cleaned || !c.temporary).length };
}

export function bridgeRequest (request) {
  if (!request.from && !request.to) return request;
  if (request.type !== 'bridge' || request.origin || request.facing || !request.from || !request.to) throw new Error('invalid_bridge_endpoints');
  const { from, to } = request;
  if (![from, to].every(p => ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]))) || from.y !== to.y) throw new Error('bridge_endpoints_must_be_level');
  const dx = to.x - from.x, dz = to.z - from.z;
  if ((!dx && !dz) || (dx && dz)) throw new Error('bridge_endpoints_must_be_axis_aligned');
  const facing = dx > 0 ? 'east' : dx < 0 ? 'west' : dz > 0 ? 'south' : 'north';
  const length = Math.abs(dx || dz) - 1;
  const width = request.parameters?.width ?? 5;
  if (request.parameters?.length != null && request.parameters.length !== length) throw new Error('bridge_length_endpoint_mismatch');
  const offset = rotate([-Math.floor(width / 2), 0, 1], facing);
  return { ...request, facing, origin: { x: from.x + offset[0], y: from.y, z: from.z + offset[2] }, parameters: { ...request.parameters, width, length } };
}

export function missingMaterials (plan, claims = {}, inventory = {}, { cleaned = false } = {}) {
  const demand = {};
  for (const c of plan.cells) if (!(cleaned && c.temporary) && !claims[keyOf(c.position)]) demand[c.item] = (demand[c.item] ?? 0) + 1;
  return Object.entries(demand).filter(([item, need]) => (inventory[item] ?? 0) < need)
    .map(([item, need]) => ({ item, need, have: inventory[item] ?? 0, missing: need - (inventory[item] ?? 0) }));
}

// Support can be below or at any side. It must exist now: future blueprint
// cells are not proof of support. Interactive blocks are never clicked as a
// support. Doors and torches require a floor support in this catalogue.
export function placementSupport (cell, read) {
  return placementSupports(cell, read)[0] ?? null;
}

export function placementSupports (cell, read) {
  const { x, y, z } = cell.position;
  const sides = [[{ x, y: y - 1, z }, 1], [{ x: x - 1, y, z }, 5], [{ x: x + 1, y, z }, 4],
    [{ x, y, z: z - 1 }, 3], [{ x, y, z: z + 1 }, 2]];
  const candidates = /door$|torch$|chest$|^bed$|campfire$|^crafting_table$|^furnace$/.test(cell.block) ? sides.slice(0, 1) : sides;
  return candidates.filter(([position]) => usableSupport(read(position))).map(([position, face]) => ({ position, face }));
}

export function constructionGoalMet (observation, request) {
  const c = observation?.construction;
  return !!request?.projectId && c?.projectId === request.projectId && c.state === 'complete' &&
    c.verification?.ok === true && c.placed > 0;
}
