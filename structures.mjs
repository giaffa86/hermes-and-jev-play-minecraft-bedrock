// Riconoscimento euristico di strutture e ambienti (spec esplorazione M5/M6).
//
// Deterministico e puro: la stessa osservazione produce lo stesso risultato, con
// l'evidenza che lo sostiene (`blocks`/`entities` contati, `matched`, `score`).
// Nessuna "scoperta" senza marker: un tipo con punteggio sotto la soglia non
// esiste nell'output, così una stanza costruita a mano con un muro di letti non
// diventa un villaggio.
//
// L'ancora (dove mettere il nodo di memoria) è il marker più specifico che ha
// combaciato, non il centro geometrico dell'area caricata.

const matchesName = (name, matcher) => (matcher instanceof RegExp ? matcher.test(name) : name === matcher);

const countOf = (rows, matcher) => {
  let count = 0;
  const keys = [];
  for (const [name, row] of rows) {
    if (!matchesName(name, matcher)) continue;
    count += row.count;
    keys.push(name);
  }
  return { count, keys };
};

const positionOf = (rows, matcher) => {
  for (const [name, row] of rows) if (matchesName(name, matcher) && row.first) return { ...row.first };
  return null;
};

// Ogni regola: `blocks`/`entities` elencano i marker con `min` (soglia di
// presenza), `score` (peso) e `label`; `anchors` è l'ordine di preferenza per
// l'ancora. `minScore` è la soglia perché il tipo esista.
export const STRUCTURE_DEFS = [
  {
    type: 'village',
    label: 'Village',
    dimension: 'overworld',
    blocks: [
      { matcher: 'bell', min: 1, score: 3, label: 'bell' },
      // Bedrock chiama il letto `bed` (senza colore nel nome): `/_bed$/` non
      // combaciava e dal vivo 30 letti non bastavano. `/bed$/` copre anche
      // `white_bed`/`oak_bed` di altri palettes.
      { matcher: /bed$/, min: 2, score: 2, label: 'beds' },
      { matcher: /^(composter|lectern|stonecutter|stonecutter_block|loom|barrel|grindstone|cartography_table|fletching_table|smithing_table|blast_furnace|smoker|cauldron|beehive|grass_path)$/, min: 1, score: 1, label: 'workstations' },
    ],
    entities: [{ matcher: /^(villager_v2|villager)$/, min: 2, score: 3, label: 'villagers' }],
    anchors: ['bell', /bed$/, 'composter'],
    minScore: 5,
  },
  {
    type: 'mineshaft',
    label: 'Mineshaft',
    dimension: 'overworld',
    blocks: [
      { matcher: /rail$/, min: 1, score: 2, label: 'rails' },
      { matcher: 'cobweb', min: 1, score: 2, label: 'cobwebs' },
      { matcher: /_planks$/, min: 4, score: 2, label: 'planks' },
      { matcher: /_fence$/, min: 1, score: 1, label: 'fences' },
    ],
    entities: [],
    anchors: [/rail$/, 'cobweb', /_planks$/],
    minScore: 6,
  },
  {
    type: 'ancient_city',
    label: 'Ancient City',
    dimension: 'overworld',
    blocks: [
      { matcher: 'sculk', min: 8, score: 3, label: 'sculk' },
      { matcher: 'sculk_shrieker', min: 1, score: 3, label: 'shriekers' },
      { matcher: 'sculk_catalyst', min: 1, score: 2, label: 'catalysts' },
    ],
    entities: [],
    anchors: ['sculk_shrieker', 'sculk_catalyst', 'sculk'],
    minScore: 6,
  },
  {
    type: 'trial_chamber',
    label: 'Trial Chamber',
    dimension: 'overworld',
    blocks: [
      { matcher: 'trial_spawner', min: 1, score: 4, label: 'trial spawners' },
      { matcher: 'vault', min: 1, score: 3, label: 'vaults' },
    ],
    entities: [],
    anchors: ['trial_spawner', 'vault'],
    minScore: 4,
  },
  {
    type: 'spawner',
    label: 'Spawner',
    dimension: 'overworld',
    blocks: [{ matcher: /^(mob_spawner|monster_spawner)$/, min: 1, score: 4, label: 'spawners' }],
    entities: [],
    anchors: [/^(mob_spawner|monster_spawner)$/],
    minScore: 4,
  },
  {
    type: 'amethyst_geode',
    label: 'Amethyst geode',
    dimension: 'overworld',
    blocks: [
      { matcher: 'budding_amethyst', min: 1, score: 3, label: 'budding amethyst' },
      { matcher: 'amethyst_block', min: 4, score: 2, label: 'amethyst blocks' },
      { matcher: 'amethyst_cluster', min: 1, score: 2, label: 'clusters' },
    ],
    entities: [],
    anchors: ['budding_amethyst', 'amethyst_cluster', 'amethyst_block'],
    minScore: 5,
  },
  {
    type: 'cave',
    label: 'Open cave',
    dimension: 'overworld',
    // `cave_air` non esiste nella palette Bedrock osservata dal vivo; lì la
    // cavità si vede dall'*aria sotto i piedi* (`air_below`, bucket sintetico di
    // `surveyBlocks`). Entrambe le misure dicono la stessa cosa: c'è un vuoto
    // sotto il bot.
    blocks: [
      { matcher: 'cave_air', min: 32, score: 3, label: 'cave air' },
      { matcher: 'air_below', min: 48, score: 3, label: 'air below' },
    ],
    entities: [],
    anchors: ['cave_air', 'air_below'],
    minScore: 3,
  },
];

// `survey` è la forma di `BedrockWorld.surveyBlocks`: Map(nome → {count, first}).
// `entities` è una lista `[{ type, position }]` (dal registro percepito).
export function detectStructures ({ survey = new Map(), entities = [], position = null, dimension = 'overworld', defs = STRUCTURE_DEFS } = {}) {
  const blockRows = survey instanceof Map ? survey : new Map(Object.entries(survey).map(([name, row]) => [name, { count: row.count ?? row, first: row.first ?? null }]));
  const entityRows = new Map();
  for (const entity of entities) {
    const type = entity?.type;
    if (!type) continue;
    const row = entityRows.get(type);
    if (row) row.count++;
    else entityRows.set(type, { count: 1, first: entity.position ? { x: entity.position.x, y: entity.position.y, z: entity.position.z } : null });
  }

  const found = [];
  for (const def of defs) {
    if (def.dimension && def.dimension !== dimension) continue;
    let score = 0;
    const matched = [], missing = [], blocks = {}, entitiesSeen = {};
    for (const rule of def.blocks) {
      const { count, keys } = countOf(blockRows, rule.matcher);
      blocks[rule.label] = count;
      for (const key of keys) blocks[key] = blockRows.get(key).count;
      if (count >= rule.min) { score += rule.score; matched.push(rule.label); }
      else missing.push(`${rule.label} (${count}/${rule.min})`);
    }
    for (const rule of def.entities) {
      const { count } = countOf(entityRows, rule.matcher);
      entitiesSeen[rule.label] = count;
      if (count >= rule.min) { score += rule.score; matched.push(rule.label); }
      else missing.push(`${rule.label} (${count}/${rule.min})`);
    }
    if (score < def.minScore) continue;

    let anchor = null;
    for (const candidate of def.anchors ?? []) {
      anchor = positionOf(blockRows, candidate) ?? positionOf(entityRows, candidate);
      if (anchor) break;
    }
    found.push({
      id: `structure:${def.type}`,
      type: def.type,
      label: def.label,
      dimension,
      position: anchor ?? (position ? { x: position.x, y: position.y, z: position.z } : null),
      confidence: Math.min(1, +(score / (def.minScore * 2)).toFixed(2)),
      evidence: { score, minScore: def.minScore, matched, missing, blocks, entities: entitiesSeen },
    });
  }
  return found.sort((a, b) => b.evidence.score - a.evidence.score);
}

export const STRUCTURE_TYPES = STRUCTURE_DEFS.map(def => def.type);
