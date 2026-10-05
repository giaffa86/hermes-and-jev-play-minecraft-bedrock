import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileConstructionDesign, constructionDesignInstructions } from '../construction-design.mjs';
import { planStructure, keyOf } from '../construction.mjs';
import { prepareConstructionPlan, applyConstructionDesignPatch } from '../construction-planning.mjs';
import { constructionAdapter } from './fixtures/construction-adapter.mjs';

const sample = () => JSON.parse(readFileSync(new URL('./fixtures/llm-house-design.json', import.meta.url)));
const origin = { x: 0, y: 64, z: 0 };

test('the architect supplies two floors, rooms, custom window, chimney, bed and workbench without a house template', () => {
  const design = sample(), blueprint = compileConstructionDesign(design, 'house');
  const plan = planStructure(blueprint, { origin, facing: 'east' });
  assert.equal(blueprint.designer, 'Hermes');
  assert.equal(blueprint.cells.length, 380);
  assert.equal(blueprint.rooms.length, 2);
  assert.deepEqual(blueprint.stages, design.stages);
  assert.deepEqual([...new Set(blueprint.cells.filter(c => c.role === 'floor').map(c => c.offset[1]))], [0, 4]);
  assert.equal(plan.required.bed, 1, 'the head is not another bed material');
  assert.equal(plan.required.crafting_table, 1);
  assert.equal(plan.required.glass, 3);
  assert.equal(plan.required.bricks, 3);
  const bed = plan.cells.find(c => c.item === 'bed');
  assert.equal(bed.facing, 'west');
  assert.equal(bed.yaw, 90);
  assert.deepEqual(bed.secondary[0].position, { x: bed.position.x - 1, y: bed.position.y, z: bed.position.z });
});

for (const [name, mutate, error] of [
  ['stage dependency', d => { d.stages.reverse(); }, /stage_support_missing/],
  ['missing requirement', d => { d.coverage.pop(); }, /uncovered_requirement/],
  ['missing room access', d => { d.rooms[1].from = [20, 5, 20]; d.rooms[1].to = [22, 7, 22]; }, /room_route_missing/],
  ['unsupported bed half', d => { d.cells.find(c => c.item === 'bed').offset = [1, 5, 4]; d.clearance = d.clearance.filter(p => !(p[0] === 1 && p[1] === 5 && [3,4].includes(p[2]))); }, /unsupported_bed_half/],
  ['bed facing', d => { delete d.cells.find(c => c.item === 'bed').facing; }, /bed_facing_required/],
  ['oversized geometry', d => { d.cuboids[0].to = [128, 128, 128]; }, /cell_budget/],
  ['declared footprint mismatch', d => { d.intent.footprint = {width:8,length:7}; }, /footprint_geometry_mismatch/],
  ['declared storeys mismatch', d => { d.intent.storeys = 3; }, /storey_geometry_mismatch/],
  ['blocked stairwell', d => { d.cuboids.push({ id: 'blocked_hole', stage: 'upper_floor', role: 'floor', item: 'spruce_planks', phase: 'floor', from: [1,4,2], to: [1,4,2] }); }, /walk_route_blocked|clearance_collision/],
  ['explosive material', d => { d.cells[0].item = 'tnt'; }, /unsupported_item/],
]) test(`designer receives an explicit rejection for ${name}`, () => {
  const design = sample(); mutate(design);
  assert.throws(() => compileConstructionDesign(design, 'house'), error);
});

test('a fireplace needs a stone hearth and verified separation from wooden geometry', () => {
  const d = { version:1,id:'hearth',kind:'platform',intent:{request:'A working fireplace on a stone platform',requirements:['fireplace']},
    stages:[{id:'base',objective:'Build hearth'},{id:'fire',objective:'Install campfire'}],
    cuboids:[{id:'stone_base',stage:'base',role:'floor',phase:'floor',item:'stone',from:[0,0,0],to:[2,0,2]}],
    cells:[{id:'campfire',stage:'fire',role:'fireplace',phase:'fittings',item:'campfire',offset:[1,1,1]}],
    terrain:Array.from({length:9},(_,i)=>[i%3,-1,Math.floor(i/3)]).concat([[0,-1,-1]]),clearance:[[0,0,-1],[0,1,-1],[0,1,1],[0,2,1]],
    routes:[{type:'walk',points:[[0,0,-1],[0,1,1]]},{type:'approach',offset:[1,1,1]}],coverage:[{requirement:'fireplace',parts:['campfire']}] };
  assert.equal(compileConstructionDesign(d,'platform').cells.filter(c=>c.block==='campfire').length,1);
  const woodenHearth=structuredClone(d);woodenHearth.cuboids[0].item='spruce_planks';
  assert.throws(()=>compileConstructionDesign(woodenHearth,'platform'),/nonflammable_hearth_required/);
  d.cells.push({id:'flammable_trim',stage:'fire',role:'trim',phase:'fittings',item:'spruce_planks',offset:[2,1,2]});
  assert.throws(()=>compileConstructionDesign(d,'platform'),/fireplace_too_close_to_wood/);
});

test('a planner repair preserves the exact brief, site and independently authorized supply chests', async () => {
  const invalid = sample(); invalid.stages.reverse();
  const plan = { objective: 'Build the requested house', construction: { type: 'house', origin, parameters: { width: 7, length: 7 }, design: invalid } };
  const authorized = [{ x: 1, y: 64, z: -8 }];
  let calls = 0;
  const result = await prepareConstructionPlan(plan, { brief: 'Two storeys, bed and crafting table', authorizedContainers: authorized,
    ask: async prompt => { calls++; assert.match(prompt, /Two storeys, bed and crafting table/); assert.match(prompt, /stage_support_missing/); return { construction: { type: 'house', origin: { x: 999, y: 64, z: 999 }, authorizedContainers: [{ x: 9,y: 9,z: 9 }], design: sample() } }; },
    preview: async request => { try { compileConstructionDesign(request.design, request.type); return { ok: true }; } catch (e) { return {ok:false,error:e.message}; } } });
  assert.equal(calls, 1);
  assert.deepEqual(result.construction.origin, origin);
  assert.deepEqual(result.construction.authorizedContainers, authorized);
  assert.equal(result.construction.design.intent.request, 'Two storeys, bed and crafting table');
  assert.equal(plan.construction.parameters.width, 7, 'the caller plan is not mutated');
});

test('an unavailable architect cannot silently replace a styled house with the stock prefab', async () => {
  const plan = { objective: 'A two-storey taiga house with beds', construction: { type: 'house', parameters: { width: 7 } } };
  let previews = 0;
  await assert.rejects(prepareConstructionPlan(plan, { ask: async () => null, preview: async () => { previews++; return { ok: true }; } }), /construction_designer_unavailable/);
  assert.equal(previews, 0);
  assert.match(constructionDesignInstructions(), /never replace the request|Do not substitute/);
});

test('an existing project is resumed without an LLM redesign or geometry rewrite', async () => {
  const plan = { construction: { projectId: 'existing', command: 'resume' } };
  assert.equal(await prepareConstructionPlan(plan, { ask: () => assert.fail('immutable project needs no design call') }), plan);
});

test('the custom two-storey house is built in the model stage order with composite bed ownership and room traversal', { timeout: 120000 }, async () => {
  const design = sample();
  const plan = planStructure(compileConstructionDesign(design, 'house'), { origin });
  const { adapter, events } = constructionAdapter({ inventory: plan.required });
  adapter._ensureCraftingTableOpen = async ({ position }) => {
    const table = adapter.construction.project.plan.cells.find(c => c.block === 'crafting_table');
    assert.deepEqual(position, table.position);
    assert.ok(Math.hypot(adapter.position.x - table.position.x - 0.5, adapter.position.y - table.position.y - 0.5, adapter.position.z - table.position.z - 0.5) <= 4.6);
    adapter._openContainer = { id: 2, type: 'workbench' }; adapter._openContainerBlock = table; events.opened.push(table.position);
  };
  adapter.setPlan({ construction: { type: 'house', origin, design } });
  const id = adapter.construction.project.id;
  for (let i = 0; i < 300 && adapter.construction.project.state !== 'complete'; i++) {
    const result = await adapter.executeAction('construction_step');
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  assert.equal(adapter.construction.project.state, 'complete');
  const stages = events.placed.map(row => plan.cells.find(c => keyOf(c.position) === keyOf(row.position)).stage);
  assert.ok(stages.every((stage, i) => i === 0 || stages[i - 1] <= stage));
  const bed = plan.cells.find(c => c.block === 'bed');
  assert.equal(adapter.memory.placementAt(bed.secondary[0].position, 'overworld').projectId, id);
  assert.equal(events.opened.length, 1, 'the crafting table was actually opened in the simulated server');
  assert.equal(adapter.construction.view().rooms.length, 2);
});

test('designer-declared survey regions expand exactly and are bounded before allocation', () => {
  const d=sample(), original=compileConstructionDesign(d,'house');
  d.terrain=[{from:[0,-1,0],to:[6,-1,6]},...d.terrain.slice(49)];
  const q=d.clearance[0];d.clearance[0]={from:q,to:q};
  const expanded=compileConstructionDesign(d,'house');
  assert.deepEqual(expanded.terrain.map(p=>p.join(',')).sort(),original.terrain.map(p=>p.join(',')).sort());
  assert.deepEqual(expanded.clearance,original.clearance);
  d.terrain=[{from:[-128,-128,-128],to:[128,128,128]}];
  assert.throws(()=>compileConstructionDesign(d,'house'),/terrain_budget/);
});

test('clearance feedback identifies the exact conflicting door halves for architect repair', () => {
  const d=sample();d.clearance.push([3,1,0],[3,2,0]);
  assert.throws(()=>compileConstructionDesign(d,'house'), e=>{
    assert.match(e.message,/clearance_collision:3,1,0/);
    assert.match(e.message,/clearance_collision:3,2,0/);
    return true;
  });
});

test('Hermes can repair a missing workstation check with data edits while preserving architecture and permissions', async () => {
  const design=sample();design.routes=design.routes.filter(r=>r.type!=='approach'||r.offset[1]!==1);
  const original=structuredClone(design), authorized=[{x:10,y:64,z:-10}];
  let calls=0;
  const plan=await prepareConstructionPlan({objective:design.intent.request,construction:{type:'house',origin,design}}, {
    authorizedContainers:authorized,
    preview:async request=>{try{compileConstructionDesign(request.design,'house');return{ok:true};}catch(e){return{ok:false,error:e.message};}},
    ask:async prompt=>{
      calls++;assert.match(prompt,/functional_check_missing:workbench/);assert.match(prompt,/designPatch/);
      return{construction:{origin:{x:999,y:64,z:999},authorizedContainers:[{x:999,y:64,z:999}],designPatch:[{op:'add',path:'/routes/-',value:{type:'approach',offset:[5,1,4]}}]}};
    }
  });
  assert.equal(calls,1);assert.deepEqual(plan.construction.origin,origin);assert.deepEqual(plan.construction.authorizedContainers,authorized);
  assert.deepEqual(plan.construction.design.cuboids,original.cuboids);assert.deepEqual(plan.construction.design.cells,original.cells);
  assert.deepEqual(design,original,'the rejected candidate remains unchanged');assert.equal(plan.construction.designPatch,undefined);
});

test('unpublished design edits reject prototype traversal, invalid indices and missing targets', () => {
  for(const patch of [
    [{op:'add',path:'/__proto__/polluted',value:true}],
    [{op:'remove',path:'/cells/99999'}],
    [{op:'replace',path:'/missing_part',value:{}}],
    [{op:'add',path:'/routes/00',value:{}}],
    [{op:'move',path:'/cells/0',value:{}}],
    Array.from({length:129},()=>({op:'remove',path:'/cells/0'})),
  ]) assert.throws(()=>applyConstructionDesignPatch(sample(),patch),/invalid_construction_design_patch/);
  assert.equal(Object.prototype.polluted,undefined);
});

test('the harness refuses an unapplied design patch instead of silently selecting a template', () => {
  const {adapter}=constructionAdapter();
  assert.throws(()=>adapter.construction.preview({type:'house',origin,designPatch:[{op:'remove',path:'/cells/0'}]}),/unapplied_construction_design_patch/);
});

test('a malformed edit is atomic and its error reaches Hermes before a second repair', async () => {
  const d=sample();d.routes=d.routes.filter(r=>r.type!=='approach'||r.offset[1]!==1);
  const originalStyle=d.intent.style;let calls=0;
  const plan=await prepareConstructionPlan({objective:d.intent.request,construction:{type:'house',origin,design:d}},{
    preview:async r=>{try{compileConstructionDesign(r.design,'house');return{ok:true};}catch(e){return{ok:false,error:e.message};}},
    ask:async prompt=>{
      calls++;
      if(calls===1)return{construction:{designPatch:[{op:'replace',path:'/intent/style',value:'An unintended partial change'},{op:'remove',path:'/cells/99999'}]}};
      assert.match(prompt,/invalid_construction_design_patch:index/);
      return{construction:{designPatch:[{op:'add',path:'/routes/-',value:{type:'approach',offset:[5,1,4]}}]}};
    }
  });
  assert.equal(calls,2);assert.equal(plan.construction.design.intent.style,originalStyle);
});

test('a malformed model design is returned to the architect instead of crashing before preview', async () => {
  let calls=0;
  const plan=await prepareConstructionPlan({objective:'A house',construction:{type:'house',origin,design:'invalid model output'}},{
    preview:async r=>{compileConstructionDesign(r.design,'house');return{ok:true};},
    ask:async prompt=>{calls++;assert.match(prompt,/invalid_construction_design:identity/);return{construction:{type:'house',origin,design:sample()}};}
  });
  assert.equal(calls,1);assert.equal(plan.construction.design.kind,'house');
});
