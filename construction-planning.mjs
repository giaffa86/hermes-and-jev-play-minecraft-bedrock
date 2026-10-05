// Model-owned design and bounded review. No deterministic aesthetic fallback.
import { constructionDesignInstructions } from './construction-design.mjs';

function parsePlan (output) {
  if (output && typeof output === 'object') return output;
  if (typeof output !== 'string') return null;
  try { return JSON.parse(output.match(/\{[\s\S]*\}/)?.[0] ?? 'null'); } catch { return null; }
}

export async function prepareConstructionPlan (plan, { brief, observation, explicitTemplate = false, authorizedContainers = [], ask, preview, maxRepairs = 2 } = {}) {
  if (!plan?.construction || plan.construction.projectId || (explicitTemplate && !plan.construction.design)) return plan;
  const original = structuredClone(plan);
  const request = brief ?? plan.construction.brief ?? plan.objective;
  let candidate = structuredClone(plan);
  let feedback = { error: 'construction_design_required' };
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    if (candidate.construction?.design) {
      // Keep the actual user brief even if a planner paraphrases or omits it.
      candidate.construction.design.intent ??= {};
      candidate.construction.design.intent.request = request;
      const dimensions = original.construction.parameters;
      if (dimensions?.width != null && dimensions?.length != null) candidate.construction.design.intent.footprint = { width: dimensions.width, length: dimensions.length };
      delete candidate.construction.parameters;
      delete candidate.construction.designRequired;
      candidate.construction.authorizedContainers = structuredClone(authorizedContainers);
      feedback = await preview(candidate.construction);
      if (feedback?.ok) return candidate;
    }
    if (attempt === maxRepairs || typeof ask !== 'function') break;
    const response = await ask([
      'Design or repair this Minecraft construction. Return ONLY a complete JSON plan with objective, targets:{}, and construction.design.',
      constructionDesignInstructions(), `Exact user brief: ${request}`,
      `Observed world: ${JSON.stringify(observation ?? {})}`,
      `Rejected candidate: ${JSON.stringify(candidate.construction)}`,
      `Harness feedback: ${JSON.stringify(feedback)}`,
      'Preserve all user requirements. Address the reported geometry/state issues yourself; never replace the request with a prefab.',
    ].join('\n'));
    const parsed = parsePlan(response);
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
