// Shared by the actual harness and the offline HTTP acceptance fixture.
export async function constructionResponse (adapter, method, path, body = {}) {
  if (method === 'GET' && (path === '/construction' || path === '/observe.construction')) return [200, adapter.construction.view()];
  if (method === 'GET' && path === '/construction/projects') return [200, { projects: adapter.memory.constructions().map(p => ({ projectId: p.id, type: p.type, state: p.state, dimension: p.dimension, origin: p.plan.origin })) }];
  if (method === 'POST' && path === '/construction/preview') {
    const report = adapter.construction.preview(body);
    return [200, { ok: report.ok, hash: report.plan.hash, bounds: report.plan.bounds,
      parameters: report.plan.blueprint.parameters, materials: report.materials, missing: report.missing,
      phases: [...new Set(report.plan.cells.map(c => c.phase))], issues: report.survey.issues.slice(0, 30),
      functionalChecks: report.plan.routes.length, temporaryBlocks: report.plan.cells.filter(c => c.temporary).length }];
  }
  if (method === 'POST' && path === '/construction/start') {
    adapter.setPlan({ objective: `Build ${body.type ?? body.projectId}`, targets: {}, construction: body });
    return [200, { ok: true, plan: adapter.plan, construction: adapter.construction.view() }];
  }
  if (method === 'POST' && path === '/construction/control') {
    if (!body.projectId || body.projectId !== adapter.construction.project?.id) return [400, { ok: false, error: 'construction_project_mismatch' }];
    return [200, adapter.construction.control(body.command)];
  }
  return null;
}
