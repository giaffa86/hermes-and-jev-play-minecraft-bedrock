// Historical sites supply destinations only. Gather keys always come from the
// adapter's current options, never from remembered block coordinates.
const strip = value => String(value ?? '').replace(/^minecraft:/, '');
const LOGS = ['oak_log', 'spruce_log', 'cherry_log', 'birch_log'];

export function naturalGatherCandidates (ingredient) {
  const name = strip(typeof ingredient === 'string' ? ingredient : ingredient.name ?? ingredient.tag);
  const blocks = {
    planks: LOGS, logs: LOGS, log: LOGS, wooden_logs: LOGS, stick: LOGS,
    cobblestone: ['stone', 'cobblestone'], stone: ['stone'],
    stone_tool_materials: ['stone', 'cobblestone'], stone_crafting_materials: ['stone', 'cobblestone'],
    coal: ['coal_ore', 'deepslate_coal_ore'], coals: ['coal_ore', 'deepslate_coal_ore'],
    iron_ingot: ['iron_ore', 'deepslate_iron_ore'], copper_ingot: ['copper_ore', 'deepslate_copper_ore'],
    dirt: ['dirt', 'grass_block'],
  };
  const crops = { potato: 'potatoes', carrot: 'carrots', wheat: 'wheat', beetroot: 'beetroot' };
  if (crops[name]) return [{ key: `harvest_${crops[name]}`, item: name, resource: crops[name] }];
  const names = blocks[name] ?? (LOGS.includes(name) ? [name]
    : LOGS.includes(name.replace(/_planks$/, '_log')) ? [name.replace(/_planks$/, '_log')]
    : /^(coal|iron|copper)_ore$|^deepslate_(coal|iron|copper)_ore$/.test(name) ? [name] : []);
  return names.map(resource => ({ key: `mine_${resource}`, item: resource, resource }));
}

export class RememberedResourceSites {
  constructor (adapter) {
    this.adapter = adapter;
    this.visits = new Map();
    this.pending = null;
  }

  signature (candidates) { return `${this.adapter.dimension}:${candidates.map(c => c.key).join('|')}`; }

  reach (position) {
    const a = this.adapter;
    const reach = a.placeReach(position);
    if (reach.reason !== 'reachability_unknown') return reach;
    // A truncated component cannot prove absence. A complete loaded path can
    // still prove this particular destination without changing planner recall.
    const goals = a._findGoalNodes(position, { limit: 16 }).filter(goal =>
      Math.hypot(goal.x + 0.5 - position.x, goal.z + 0.5 - position.z) <= 3 && Math.abs(goal.y - position.y) <= 3);
    for (const goal of goals) {
      const path = a._findPath(a._startNode(), goal);
      const end = path?.at(-1);
      if (end && ['x', 'y', 'z'].every(k => end[k] === goal[k])) return { ...reach, reachable: true, reason: 'resource_site_path' };
    }
    return reach;
  }

  ranked (candidates) {
    const a = this.adapter;
    let sites;
    try { sites = a.memory?.findResources?.({ limit: null }) ?? []; }
    catch (error) { a.log('memory_error', { message: error.message }); return []; }
    const now = Date.now(), signature = this.signature(candidates);
    return sites.flatMap(site => {
      if (site.kind !== 'resource_site' || site.status === 'invalid' || site.dimension !== a.dimension) return [];
      if (!site.position || !['x', 'y', 'z'].every(k => Number.isFinite(site.position[k]))) return [];
      const visit = this.visits.get(`${signature}:${site.id}`);
      if (visit && now - visit.at < 300000) return [];
      const observations = (site.observations ?? []).map(strip), tags = (site.tags ?? []).map(strip);
      const yieldItem = resource => ({ stone: 'cobblestone', coal_ore: 'coal', deepslate_coal_ore: 'coal',
        iron_ore: 'raw_iron', deepslate_iron_ore: 'raw_iron', copper_ore: 'raw_copper', deepslate_copper_ore: 'raw_copper' })[resource] ?? resource;
      const compatibility = Math.max(0, ...candidates.map(c => observations.includes(c.resource) ? 3
        : (site.productivity?.[c.resource]?.found > 0 || site.productivity?.[c.item]?.found > 0 || site.productivity?.[yieldItem(c.resource)]?.found > 0) ? 2
        : tags.includes(c.resource) ? 1 : 0));
      if (!compatibility) return [];
      const reachability = this.reach(site.position);
      if (!reachability.reachable || reachability.reason === 'reachability_unknown') return [];
      const distance = Math.hypot(site.position.x - a.position.x, site.position.y - a.position.y, site.position.z - a.position.z);
      const age = Math.max(0, now - (site.lastSeenAt ?? 0));
      const score = compatibility * 100 - distance - Math.min(40, age / 3600000) - (site.status === 'stale' ? 20 : 0);
      return [{ site, reachability, distance, score, signature }];
    }).sort((a, b) => b.score - a.score || b.site.lastSeenAt - a.site.lastSeenAt || a.site.id.localeCompare(b.site.id));
  }

  step (candidates, offered) {
    if (!candidates.length || !offered) return null;
    const signature = this.signature(candidates);
    const visited = [...this.visits.values()].some(v => v.signature === signature && Date.now() - v.at < 300000);
    const live = candidates.find(c => offered.has(c.key));
    if (visited) return live ? { ...live, source: 'gather' } : null;
    const candidate = this.ranked(candidates)[0];
    if (candidate) return {
      key: 'goto_waypoint', source: 'remembered_resource_site', item: candidates[0].item,
      site: candidate.site.id, waypoint: { ...candidate.site.position }, signature,
      reason: 'revalidate_resource_site',
    };
    return live ? { ...live, source: 'gather' } : null;
  }

  async navigate (step, { signal, timeoutMs = 45000 } = {}) {
    const a = this.adapter;
    // Suppress repeats even when the route fails or the historical site is empty.
    const visit = { signature: step.signature, at: Date.now(), arrived: false };
    this.visits.set(`${step.signature}:${step.site}`, visit);
    this.pending = null;
    let result;
    try {
      const site = a.memory?.findResources?.({ limit: null }).find(site => site.id === step.site
        && site.status !== 'invalid' && site.dimension === a.dimension);
      const reach = site ? this.reach(step.waypoint) : null;
      if (!site) result = { ok: false, error: 'resource_site_invalid' };
      else if (!reach.reachable || reach.reason === 'reachability_unknown') result = { ok: false, error: 'resource_site_unreachable' };
      else result = await a._moveTo(step.waypoint, 2, timeoutMs, { signal });
      visit.arrived = result?.ok !== false && Math.hypot(a.position.x - step.waypoint.x, a.position.z - step.waypoint.z) <= 3;
      if (!visit.arrived && result?.ok !== false) result = { ok: false, error: 'resource_site_not_reached' };
    } catch (error) { result = { ok: false, error: error.message }; }
    // Force a new census even after a partial/failed walk; it may have moved us.
    a._reachCache = null;
    a._lastOreScanAt = null;
    a._refreshNearby();
    a.observe();
    return { ...result, resourceSite: step.site, reobserved: true };
  }
}
