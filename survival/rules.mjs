// Regole di sopravvivenza: piccolo valutatore esplicito per
// knowledge/survival-rules.json.
//
// Il vocabolario delle condizioni è chiuso e validato al caricamento: un refuso
// nel JSON fallisce subito con un errore chiaro invece di valutare `false` in
// silenzio. Non è un motore di regole generico e non esegue codice.

const SEVERITY_RANK = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

export const CONDITION_KEYS = [
  'healthMax', 'healthBelow', 'foodMax', 'foodBelow',
  'phase', 'night', 'timeKnown',
  'bedAvailable', 'hasFood', 'weaponInInventory', 'pickaxeInInventory',
  'sleeping', 'dead', 'lootNearby',
  'hostileWithin', 'hostileSeverityAtLeast', 'hostileTypeWithin',
  // Fluidi (M0 di docs/wiki/fluids.md).
  'inWater', 'headInWater', 'inLava', 'lavaWithin', 'airBelow',
  // Nether/End (N0 di docs/wiki/nether.md).
  'inFire', 'fireWithin', 'magmaWithin', 'projectileIncoming', 'gazedAtEnderman',
  'inNether', 'inEnd', 'spawnerWithin',
];

const BOOLEAN_KEYS = new Set([
  'night', 'timeKnown', 'bedAvailable', 'hasFood', 'weaponInInventory',
  'pickaxeInInventory', 'sleeping', 'dead', 'lootNearby',
  'inWater', 'headInWater', 'inLava',
  // Nether/End (N0).
  'inFire', 'projectileIncoming', 'gazedAtEnderman', 'inNether', 'inEnd',
]);
const NUMBER_KEYS = new Set(['healthMax', 'healthBelow', 'foodMax', 'foodBelow', 'hostileWithin', 'lavaWithin', 'airBelow', 'fireWithin', 'magmaWithin', 'spawnerWithin']);
const PHASES = ['day', 'dusk', 'night', 'dawn'];

export function validateRule (rule, index = 0) {
  const errors = [];
  const where = `rule[${index}]${rule?.id ? ` (${rule.id})` : ''}`;
  if (!rule || typeof rule !== 'object') return [`${where}: not an object`];
  if (typeof rule.id !== 'string' || !rule.id) errors.push(`${where}: missing id`);
  if (typeof rule.priority !== 'number' || rule.priority < 0 || rule.priority > 100) errors.push(`${where}: priority must be a number 0..100`);
  if (rule.when != null && (typeof rule.when !== 'object' || Array.isArray(rule.when))) errors.push(`${where}: when must be an object`);
  for (const [key, value] of Object.entries(rule.when || {})) {
    if (!CONDITION_KEYS.includes(key)) { errors.push(`${where}: unknown condition "${key}"`); continue; }
    if (BOOLEAN_KEYS.has(key) && typeof value !== 'boolean') errors.push(`${where}: "${key}" must be a boolean`);
    if (NUMBER_KEYS.has(key) && (typeof value !== 'number' || value < 0)) errors.push(`${where}: "${key}" must be a non-negative number`);
    if (key === 'phase' && !PHASES.includes(value)) errors.push(`${where}: phase must be one of ${PHASES.join(', ')}`);
    if (key === 'hostileSeverityAtLeast' && !(value in SEVERITY_RANK)) errors.push(`${where}: invalid severity "${value}"`);
    if (key === 'hostileTypeWithin') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) errors.push(`${where}: hostileTypeWithin must be an object {type: distance}`);
      else for (const [type, distance] of Object.entries(value)) {
        if (typeof distance !== 'number' || distance < 0) errors.push(`${where}: hostileTypeWithin.${type} must be a non-negative number`);
      }
    }
  }
  if (rule.intent != null && typeof rule.intent !== 'string') errors.push(`${where}: intent must be a string`);
  if (rule.intents != null && (!Array.isArray(rule.intents) || rule.intents.some(i => typeof i !== 'string'))) errors.push(`${where}: intents must be an array of strings`);
  if (rule.objective != null && typeof rule.objective !== 'string') errors.push(`${where}: objective must be a string`);
  if (rule.preferredSkills != null && (!Array.isArray(rule.preferredSkills) || rule.preferredSkills.some(s => typeof s !== 'string'))) errors.push(`${where}: preferredSkills must be an array of strings`);
  return errors;
}

export function validateRules (rules) {
  const errors = [];
  if (!Array.isArray(rules)) return ['rules must be an array'];
  rules.forEach((rule, index) => errors.push(...validateRule(rule, index)));
  const ids = new Set();
  for (const rule of rules) {
    if (rule?.id && ids.has(rule.id)) errors.push(`duplicate rule id "${rule.id}"`);
    if (rule?.id) ids.add(rule.id);
  }
  return errors;
}

export function evaluateCondition (key, value, perception = {}) {
  const nearest = perception.nearestThreat || null;
  switch (key) {
    case 'healthMax':
      return perception.health != null && perception.health <= value;
    case 'healthBelow':
      return perception.health != null && perception.health < value;
    case 'foodMax':
      return perception.food != null && perception.food <= value;
    case 'foodBelow':
      return perception.food != null && perception.food < value;
    case 'phase':
      return perception.phase === value;
    case 'night':
      return perception.night === value;
    case 'timeKnown':
      return perception.timeKnown === value;
    case 'bedAvailable':
      return perception.bedAvailable === value;
    case 'hasFood':
      return perception.hasFood === value;
    case 'weaponInInventory':
      return (perception.weapon != null) === value;
    case 'pickaxeInInventory':
      return (perception.pickaxe != null) === value;
    case 'sleeping':
      return perception.sleeping === value;
    case 'dead':
      return perception.dead === value;
    case 'lootNearby':
      return (perception.lootNearby === true) === value;
    case 'hostileWithin':
      return !!nearest && nearest.distance <= value;
    case 'hostileSeverityAtLeast': {
      const wanted = SEVERITY_RANK[value] ?? 0;
      return (perception.threats || []).some(threat => (SEVERITY_RANK[threat.severity] ?? 0) >= wanted);
    }
    case 'hostileTypeWithin': {
      for (const [type, distance] of Object.entries(value || {})) {
        const match = (perception.threats || []).some(threat => threat.type === type && threat.distance <= distance);
        if (!match) return false;
      }
      return true;
    }
    // Nether/End (N0): le condizioni leggono la perception normalizzata, quindi
    // un'osservazione senza `nether` (o con censimento non pronto) non fa scattare
    // nulla. `gazedAtEnderman: true` è vero solo se lo sguardo è stato misurato.
    case 'inFire':
      return perception.nether?.inFire === value;
    case 'inNether':
      return perception.nether?.isNether === value;
    case 'inEnd':
      return perception.nether?.isEnd === value;
    case 'projectileIncoming':
      return perception.nether?.projectileIncoming === value;
    case 'gazedAtEnderman':
      return (perception.nether?.enderman?.gazed === true) === value;
    case 'fireWithin': {
      const distance = perception.nether?.fireWithin;
      return Number.isFinite(distance) && distance <= value;
    }
    case 'magmaWithin': {
      const distance = perception.nether?.magmaWithin;
      return Number.isFinite(distance) && distance <= value;
    }
    case 'spawnerWithin': {
      const distance = perception.nether?.spawnerWithin;
      return Number.isFinite(distance) && distance <= value;
    }
    // Fluidi: le condizioni leggono la perception normalizzata, mai l'osservazione
    // grezza. `lavaWithin`/`airBelow` sono distanze/soglie numeriche; l'aria ignota
    // (null) non fa scattare nulla.
    case 'inWater':
      return perception.fluids?.inWater === value;
    case 'headInWater':
      return perception.fluids?.headInWater === value;
    case 'inLava':
      return perception.fluids?.inLava === value;
    case 'lavaWithin': {
      const distance = perception.fluids?.lavaWithin;
      return Number.isFinite(distance) && distance <= value;
    }
    case 'airBelow': {
      const air = perception.fluids?.air;
      return Number.isFinite(air) && air < value;
    }
    default:
      throw new Error(`unknown survival condition: ${key}`);
  }
}

export function ruleMatches (rule, perception) {
  for (const [key, value] of Object.entries(rule.when || {})) {
    if (!evaluateCondition(key, value, perception)) return false;
  }
  return true;
}

// Regole soddisfatte, in ordine di priorità decrescente e poi di dichiarazione.
export function evaluateRules (rules = [], perception = {}) {
  return rules
    .map((rule, index) => ({ rule, index }))
    .filter(entry => ruleMatches(entry.rule, perception))
    .sort((a, b) => (b.rule.priority - a.rule.priority) || (a.index - b.index))
    .map(entry => entry.rule);
}

// I/O: carica e valida il file JSON delle regole.
export async function loadSurvivalRules (url) {
  const { readFileSync } = await import('node:fs');
  let data;
  try {
    data = JSON.parse(readFileSync(url, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read survival rules from ${url}: ${error.message}`);
  }
  const rules = Array.isArray(data) ? data : data.rules;
  const errors = validateRules(rules);
  if (errors.length) throw new Error(`invalid survival rules:\n${errors.join('\n')}`);
  return rules;
}
