// Model-owned design and bounded review. No deterministic aesthetic fallback.
import { constructionDesignInstructions } from './construction-design.mjs';
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);

function parsePlan (output) {
  if (output && typeof output === 'object') return output;
  if (typeof output !== 'string') return null;
  try { return JSON.parse(output.match(/\{[\s\S]*\}/)?.[0] ?? 'null'); } catch { return null; }
}

// JSON data edits are restricted to the unpublished design. They cannot alter
// a site, storage permissions or an existing persisted construction project.
export function applyConstructionDesignPatch (design, operations) {
  if (!Array.isArray(operations) || !operations.length || operations.length > 128) throw new Error('invalid_construction_design_patch:operations');
  const result = structuredClone(design);
  for (const operation of operations) {
    if (!operation || !['add', 'replace', 'remove'].includes(operation.op) || typeof operation.path !== 'string' || !operation.path.startsWith('/') || operation.path.length > 512) throw new Error('invalid_construction_design_patch:operation');
    const keys = operation.path.slice(1).split('/').map(key => {
      if (/~(?![01])/.test(key)) throw new Error('invalid_construction_design_patch:pointer');
      return key.replaceAll('~1', '/').replaceAll('~0', '~');
    });
    if (keys.length > 16 || keys.some(key => !key || ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error('invalid_construction_design_patch:pointer');
    let parent = result;
    for (const key of keys.slice(0, -1)) {
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw new Error('invalid_construction_design_patch:parent');
      parent = parent[key];
    }
    if (!parent || typeof parent !== 'object') throw new Error('invalid_construction_design_patch:parent');
    const key = keys.at(-1);
    if (operation.op !== 'remove' && !Object.hasOwn(operation, 'value')) throw new Error('invalid_construction_design_patch:value');
    if (Array.isArray(parent)) {
      const index = key === '-' && operation.op === 'add' ? parent.length : /^(0|[1-9]\d*)$/.test(key) ? Number(key) : NaN;
      if (!Number.isSafeInteger(index) || index < 0 || index > parent.length || (operation.op !== 'add' && index === parent.length)) throw new Error('invalid_construction_design_patch:index');
      if (operation.op === 'add') parent.splice(index, 0, structuredClone(operation.value));
      if (operation.op === 'replace') parent[index] = structuredClone(operation.value);
      if (operation.op === 'remove') parent.splice(index, 1);
    } else {
      if (operation.op !== 'add' && !Object.hasOwn(parent, key)) throw new Error('invalid_construction_design_patch:target');
      if (operation.op === 'remove') delete parent[key];
      else parent[key] = structuredClone(operation.value);
    }
  }
  return result;
}

export async function prepareConstructionPlan (plan, { brief, observation, explicitTemplate = false, authorizedContainers = [], ask, preview, maxRepairs = 2 } = {}) {
  if (!plan?.construction || plan.construction.projectId || (explicitTemplate && !plan.construction.design)) return plan;
  const original = structuredClone(plan);
  const request = brief ?? plan.construction.brief ?? plan.objective;
  let candidate = structuredClone(plan);
  let feedback = { error: 'construction_design_required' };
  let patchError = null;
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const patchable = object(candidate.construction?.design);
    if (patchable) {
      // Keep the actual user brief even if a planner paraphrases or omits it.
      if (!object(candidate.construction.design.intent)) candidate.construction.design.intent = {};
      candidate.construction.design.intent.request = request;
      const dimensions = original.construction.parameters;
      if (dimensions?.width != null && dimensions?.length != null) candidate.construction.design.intent.footprint = { width: dimensions.width, length: dimensions.length };
      delete candidate.construction.parameters;
      delete candidate.construction.designRequired;
      candidate.construction.authorizedContainers = structuredClone(authorizedContainers);
      feedback = await preview(candidate.construction);
      if (patchError) { feedback = { ok: false, error: patchError, validation: feedback }; patchError = null; }
      if (feedback?.ok) return candidate;
    } else if (candidate.construction?.design) feedback = { error: 'invalid_construction_design:identity' };
    if (attempt === maxRepairs || typeof ask !== 'function') break;
    const response = await ask([
      'Design or repair this Minecraft construction. Return ONLY a complete JSON plan with objective, targets:{}, and construction.design.',
      constructionDesignInstructions(), `Exact user brief: ${request}`,
      `Observed world: ${JSON.stringify(observation ?? {})}`,
      `Rejected candidate: ${JSON.stringify(candidate.construction)}`,
      `Harness feedback: ${JSON.stringify(feedback)}`,
      patchable ? 'For a small correction, prefer {"construction":{"designPatch":[{"op":"add|replace|remove","path":"/routes/-","value":...}]}} instead of re-emitting the entire plan. Paths are relative to design, never construction. At most 128 edits; add uses an array index or /- to append. Omit value for remove. Preserve unaffected geometry. A complete construction.design is also accepted.' : '',
      'Preserve all user requirements. Address the reported geometry/state issues yourself; never replace the request with a prefab.',
    ].join('\n'));
    const parsed = parsePlan(response);
    if (parsed?.construction?.designPatch && patchable) {
      try { candidate.construction.design = applyConstructionDesignPatch(candidate.construction.design, parsed.construction.designPatch); }
      catch (error) { patchError = error.message; }
      continue;
    }
    if (!parsed?.construction?.design) { feedback = { error: 'construction_designer_unavailable' }; break; }
    // New model output may change architecture, but cannot grant new storage
    // permissions or silently move a site already explicitly supplied.
    candidate = { ...original, ...parsed, targets: {}, construction: { ...parsed.construction,
      ...(original.construction.origin ? { origin: original.construction.origin } : {}),
      authorizedContainers: structuredClone(authorizedContainers) } };
  }
  const error = new Error(`construction_design_rejected:${feedback?.error ?? 'site_or_geometry_invalid'}`);
  error.feedback = feedback;
  throw error;
}
