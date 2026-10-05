// Hermes owns the architecture. This compiler only expands explicit geometry
// and checks executable contracts; it never selects a style, layout or palette.
import { CONSTRUCTION_VERSION, MAX_CONSTRUCTION_CELLS, FACINGS, PHASES, validateBlueprint } from './construction.mjs';

export const DESIGN_VERSION = 1;
export const DESIGN_FULL_BLOCKS = /^(cobblestone|cobbled_deepslate|stone|blackstone|bricks|stone_bricks|deepslate_bricks|sandstone|smooth_sandstone|glass|[a-z_]+_planks|[a-z_]+_log)$/;
const FITTINGS = new Set(['wooden_door', 'torch', 'chest', 'bed', 'crafting_table', 'furnace', 'campfire']);
const forward = { south: [0, 0, 1], east: [1, 0, 0], north: [0, 0, -1], west: [-1, 0, 0] };
const ident = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(value);
const offset = value => Array.isArray(value) && value.length === 3 && value.every(Number.isSafeInteger) && value.every(n => Math.abs(n) <= 128);
const fail = reason => { throw new Error(`invalid_construction_design:${reason}`); };
const MAX_SURVEY_CELLS = 20000;

function expandRegions (regions, field) {
  if (!Array.isArray(regions)) fail(field);
  const points = new Map(); let expanded = 0;
  const add = point => { if (++expanded > MAX_SURVEY_CELLS) fail(`${field}_budget`); points.set(point.join(','), point); };
  for (const region of regions) {
    if (offset(region)) { add([...region]); continue; }
    if (!region || !offset(region.from) || !offset(region.to) || region.from.some((n, i) => n > region.to[i])) fail(`${field}_region`);
    const size = region.from.reduce((n, low, i) => n * (region.to[i] - low + 1), 1);
    if (expanded + size > MAX_SURVEY_CELLS) fail(`${field}_budget`);
    for (let y = region.from[1]; y <= region.to[1]; y++) for (let z = region.from[2]; z <= region.to[2]; z++) for (let x = region.from[0]; x <= region.to[0]; x++) add([x, y, z]);
  }
  return [...points.values()];
}

export function designCapabilities () {
  return { version: DESIGN_VERSION, geometry: ['cuboids', 'cells'], maxCells: MAX_CONSTRUCTION_CELLS,
    maxOffset: 128, maxStages: 32, maxSurveyCells: MAX_SURVEY_CELLS, fittings: [...FITTINGS],
    structuralMaterials: DESIGN_FULL_BLOCKS.source, stairs: 'explicit supported full-block steps',
    routes: ['walk', 'container', 'approach'], designer: 'Hermes',
    unsupported: ['arbitrary executable code', 'unverified stairs/slab orientation'] };
}

export function constructionDesignInstructions () {
  return [
    'For a new natural-language construction request, YOU are the architect. Produce construction.design, not a stock template selected by code.',
    'Preserve the requested style, storeys, materials, rooms, roof, fireplace and furniture. Use the observed biome and surroundings; when the biome is unknown, say so rather than inventing it. Do not substitute a smaller/default building when a requirement is difficult.',
    'Return construction:{type,origin?,facing?,design:{version:1,id,kind,intent:{request,style,biome,storeys,footprint:{width,length},requirements:[...]},rooms:[{id,purpose,from:[x,y,z],to:[x,y,z]}],stages:[{id,objective}],cuboids:[{id,stage,role,from:[x,y,z],to:[x,y,z],item,phase,temporary?}],cells:[{id,stage,role,offset:[x,y,z],item,phase,facing?}],clearance:[[x,y,z],...],terrain:[[x,y,z],...],routes:[{type:"walk",points:[[x,y,z],...]},{type:"container"|"approach",offset:[x,y,z]}],coverage:[{requirement,parts:[id,...]}]}}.',
    'All coordinates in design are integer offsets relative to origin, before facing rotation. Cuboid endpoints are inclusive. You choose every part, material, position, roof shape and stage order. The compiler never fills missing walls, stairs, roofs, windows or furnishings for you.',
    'All design, stage, part and room ids must be lowercase snake_case: start with a letter and use only lowercase letters, digits and underscores (at most 80 characters); no hyphens or spaces.',
    'To keep the design concise, clearance and terrain also accept explicit inclusive regions {from:[x,y,z],to:[x,y,z]} mixed with individual points. Declare whole room air volumes and foundation terrain as regions; the compiler expands exactly your bounds, at most 20000 points per list.',
    'Each part belongs to a declared ordered stage. Use phase floor/access/walls/roof/fittings. Keep the total at most 4096 material placements and offsets within +/-128. Place genuine supports before dependent parts. Supply temporary access/scaffolding explicitly and mark it temporary:true.',
    'Plan reachable working positions before high walls and roofs: clicks require an unobstructed supporting face within 4.4 blocks of the eyes (feet plus 1.62), and a top-face click requires eyes above that face. Structural support alone does not prove working access. Put your chosen stairs/scaffolding in an earlier stage than the placements that need them.',
    'Use role:"floor" for the main floor geometry on each storey. A walk point on each floor must have feet at floor y+1. Include named room bounds and an actual walk point inside every declared room.',
    'Supported structure materials: stone/cobblestone/cobbled_deepslate/blackstone/bricks/stone_bricks/deepslate_bricks/sandstone/smooth_sandstone/glass and wood planks/logs. Furnishings: wooden_door,torch,chest,bed,crafting_table,furnace,campfire. Beds require facing and two supported cells: the compiler expands only their mechanical head half. Doors likewise expand their upper half. All other geometry stays exactly yours.',
    'Include walk routes from an outside retreat point into every storey and requested room. Declare terrain support and all required headroom/aisles as clearance; never flatten terrain or adopt existing player builds. Include container checks for chests and approach checks for beds/workstations/campfires.',
    'Clearance means cells that must remain AIR. Exclude every planned primary/secondary block, including door halves and bed halves, from clearance regions. A walk route may pass through a door; that does not make its cells air clearance.',
    'A lit campfire needs a nonflammable hearth and no planned wood or bed within two blocks. No lava/fire blocks, no explosive or command blocks. A decorative chimney is distinct from a working fireplace: record which you designed.',
    'Explain coverage of every user requirement using existing part ids. Code validates support, collisions, material counts and reachability; it does not make aesthetic decisions. If preview rejects the design, revise the geometry using its errors while preserving the brief. Never declare success before server verification.',
    'Each coverage.requirement must be copied EXACTLY from intent.requirements, with one coverage entry for every listed requirement. List physical/user design requirements there; keep procedural notes such as offline testing in the request or plan notes.',
    'An active project is immutable: resume its projectId. Do not replace its design during a replan. Explicit structured template requests remain supported for compatibility.',
  ].join('\n');
}

export function compileConstructionDesign (design, kind) {
  if (!design || typeof design !== 'object' || Array.isArray(design) || design.version !== DESIGN_VERSION || !ident(design.id)) fail('identity');
  if (!['house', 'platform', 'bridge', 'warehouse', 'tower'].includes(kind) || design.kind !== kind) fail('kind');
  if (!design.intent || typeof design.intent.request !== 'string' || !design.intent.request.trim()) fail('brief_required');
  if (!Array.isArray(design.intent.requirements) || !design.intent.requirements.length || design.intent.requirements.some(s => typeof s !== 'string' || !s.trim())) fail('requirements');
  if (!Array.isArray(design.stages) || !design.stages.length || design.stages.length > 32) fail('stages');
  const stageIds = new Map();
  for (const [index, stage] of design.stages.entries()) {
    if (!stage || !ident(stage.id) || stageIds.has(stage.id) || typeof stage.objective !== 'string' || !stage.objective.trim()) fail('stage_identity');
    stageIds.set(stage.id, index);
  }
  const parts = new Map(), cells = new Map();
  let expanded = 0;
  const register = part => {
    if (!part || !ident(part.id) || parts.has(part.id) || !stageIds.has(part.stage)) fail('part_identity');
    if (!PHASES.includes(part.phase) || ['verify', 'cleanup'].includes(part.phase)) fail('part_phase');
    if (typeof part.role !== 'string' || !part.role.trim() || part.role.length > 80) fail('part_role');
    if (!DESIGN_FULL_BLOCKS.test(part.item) && !FITTINGS.has(part.item)) fail(`unsupported_item:${part.item}`);
    if (part.facing != null && !FACINGS.includes(part.facing)) fail('part_facing');
    if (part.temporary != null && typeof part.temporary !== 'boolean') fail('temporary');
    if (part.properties != null && (!part.properties || typeof part.properties !== 'object' || Array.isArray(part.properties) || Object.values(part.properties).some(v => !['string', 'number', 'boolean'].includes(typeof v)))) fail('properties');
    parts.set(part.id, part);
  };
  const add = (part, at) => {
    if (++expanded > MAX_CONSTRUCTION_CELLS) fail('cell_budget');
    if (!offset(at)) fail('offset');
    const key = at.join(',');
    const row = { offset: at, item: part.item, block: part.item, phase: part.phase,
      stage: stageIds.get(part.stage), part: part.id, role: part.role, secondary: [],
      ...(part.properties ? { properties: structuredClone(part.properties) } : {}),
      ...(part.temporary ? { temporary: true } : {}), ...(part.facing ? { facing: part.facing } : {}) };
    if (part.item === 'bed') {
      if (!part.facing) fail('bed_facing_required');
      row.secondary = [{ offset: at.map((n, i) => n + forward[part.facing][i]), block: 'bed' }];
    }
    if (part.item === 'wooden_door') {
      row.properties = { upper_block_bit: false };
      row.secondary = [{ offset: [at[0], at[1] + 1, at[2]], block: 'wooden_door', properties: { upper_block_bit: true } }];
    }
    if (cells.has(key)) fail(`overlapping_parts:${key}`);
    cells.set(key, row);
  };
  for (const field of ['cuboids', 'cells']) if (design[field] != null && !Array.isArray(design[field])) fail(field);
  for (const part of design.cuboids ?? []) {
    register(part);
    if (!offset(part.from) || !offset(part.to) || part.from.some((n, i) => n > part.to[i])) fail('cuboid_bounds');
    if (!DESIGN_FULL_BLOCKS.test(part.item)) fail('fitting_requires_single_cell');
    const count = part.from.reduce((n, low, i) => n * (part.to[i] - low + 1), 1);
    if (count + expanded > MAX_CONSTRUCTION_CELLS) fail('cell_budget');
    for (let y = part.from[1]; y <= part.to[1]; y++) for (let z = part.from[2]; z <= part.to[2]; z++) for (let x = part.from[0]; x <= part.to[0]; x++) add(part, [x, y, z]);
  }
  for (const part of design.cells ?? []) { register(part); add(part, part.offset); }
  if (!cells.size) fail('empty');
  if (!Array.isArray(design.coverage)) fail('coverage');
  for (const requirement of design.intent.requirements) {
    const row = design.coverage.find(c => c?.requirement === requirement);
    if (!row || !Array.isArray(row.parts) || !row.parts.length || row.parts.some(id => !parts.has(id))) fail(`uncovered_requirement:${requirement}`);
  }
  const rows = [...cells.values()].sort((a, b) => a.stage - b.stage || a.offset[1] - b.offset[1]);
  const palette = Object.fromEntries(rows.map(c => [c.role, c.item]));
  const blueprint = { version: CONSTRUCTION_VERSION, id: design.id, kind, parameters: { palette },
    designer: 'Hermes', intent: structuredClone(design.intent), stages: structuredClone(design.stages),
    coverage: structuredClone(design.coverage), cells: rows,
    clearance: expandRegions(design.clearance, 'clearance'), terrain: expandRegions(design.terrain, 'terrain'), routes: structuredClone(design.routes) };
  const errors = validateBlueprint(blueprint);
  if (errors.length) fail(errors.join(';'));
  if (!blueprint.routes.some(r => r.type === 'walk')) fail('walk_route_required');
  if (design.intent.footprint != null) {
    const { width, length } = design.intent.footprint;
    if (![width, length].every(n => Number.isSafeInteger(n) && n > 0 && n <= 257)) fail('footprint');
    const floors = rows.filter(c => !c.temporary && c.role === 'floor');
    const baseY = Math.min(...floors.map(c => c.offset[1]));
    const base = floors.filter(c => c.offset[1] === baseY);
    const extent = axis => Math.max(...base.map(c => c.offset[axis])) - Math.min(...base.map(c => c.offset[axis])) + 1;
    if (!base.length || extent(0) !== width || extent(2) !== length) fail('footprint_geometry_mismatch');
  }
  // Prove support in the designer's order, rather than reordering its stages.
  const stagedSupport = new Set(blueprint.terrain.map(p => p.join(',')));
  for (let stage = 0; stage < design.stages.length; stage++) {
    let remaining = rows.filter(c => c.stage === stage);
    while (remaining.length) {
      const before = remaining.length;
      remaining = remaining.filter(c => {
        const [x, y, z] = c.offset;
        const neighbors = [[x, y - 1, z]];
        if (DESIGN_FULL_BLOCKS.test(c.block)) neighbors.push([x - 1, y, z], [x + 1, y, z], [x, y, z - 1], [x, y, z + 1]);
        if (!neighbors.some(p => stagedSupport.has(p.join(',')))) return true;
        if (DESIGN_FULL_BLOCKS.test(c.block)) stagedSupport.add(c.offset.join(','));
        return false;
      });
      if (remaining.length === before) fail(`stage_support_missing:${design.stages[stage].id}`);
    }
  }
  // Composite furniture must have support under both actual server blocks.
  const support = new Set([...blueprint.terrain, ...rows.filter(c => DESIGN_FULL_BLOCKS.test(c.block)).map(c => c.offset)].map(p => p.join(',')));
  for (const row of rows.filter(c => c.block === 'bed')) for (const at of [row.offset, row.secondary[0].offset]) {
    if (!support.has([at[0], at[1] - 1, at[2]].join(','))) fail('unsupported_bed_half');
  }
  for (const fire of rows.filter(c => c.block === 'campfire')) {
    const under = cells.get([fire.offset[0], fire.offset[1] - 1, fire.offset[2]].join(','));
    if (!under || !DESIGN_FULL_BLOCKS.test(under.block) || /_planks$|_log$/.test(under.block)) fail('nonflammable_hearth_required');
    if (rows.flatMap(c => [c, ...c.secondary]).some(c => /_planks$|_log$|^bed$|^wooden_door$|^chest$|^crafting_table$/.test(c.block) && c.offset.every((n, i) => Math.abs(n - fire.offset[i]) <= 2))) fail('fireplace_too_close_to_wood');
  }
  if (design.intent.storeys != null) {
    if (!Number.isSafeInteger(design.intent.storeys) || design.intent.storeys < 1 || design.intent.storeys > 8) fail('storeys');
    const floors = new Set(rows.filter(c => !c.temporary && c.role === 'floor').map(c => c.offset[1]));
    if (floors.size !== design.intent.storeys) fail('storey_geometry_mismatch');
    for (const y of floors) if (!blueprint.routes.some(r => r.type === 'walk' && r.points.some(p => p[1] === y + 1))) fail('storey_route_missing');
  }
  const occupied = new Map(rows.flatMap(c => [c, ...c.secondary]).map(c => [c.offset.join(','), c.block]));
  for (const route of blueprint.routes.filter(r => r.type === 'walk')) for (const [x, y, z] of route.points) {
    for (const at of [[x, y, z], [x, y + 1, z]]) {
      const name = occupied.get(at.join(','));
      if (name && !/door$|torch$/.test(name)) fail('walk_route_blocked');
    }
    if (!support.has([x, y - 1, z].join(','))) fail('walk_route_unsupported');
  }
  for (const c of rows.filter(c => !c.temporary && ['chest', 'bed', 'crafting_table', 'furnace', 'campfire'].includes(c.block))) {
    const type = c.block === 'chest' ? 'container' : 'approach';
    if (!blueprint.routes.some(r => r.type === type && r.offset.join(',') === c.offset.join(','))) fail(`functional_check_missing:${c.part}`);
  }
  if (design.rooms != null) {
    if (!Array.isArray(design.rooms) || design.rooms.length > 64) fail('rooms');
    const roomIds = new Set();
    for (const room of design.rooms) {
      if (!room || !ident(room.id) || roomIds.has(room.id) || typeof room.purpose !== 'string' || !offset(room.from) || !offset(room.to) || room.from.some((n, i) => n > room.to[i])) fail('room_bounds');
      roomIds.add(room.id);
      if (!blueprint.routes.some(r => r.type === 'walk' && r.points.some(p => p.every((n, i) => n >= room.from[i] && n <= room.to[i])))) fail(`room_route_missing:${room.id}`);
    }
    blueprint.rooms = structuredClone(design.rooms);
  }
  return blueprint;
}
