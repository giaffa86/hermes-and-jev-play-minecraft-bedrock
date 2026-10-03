// Needs: bisogni ricavati deterministicamente da perception e risk.
//
// I bisogni sono un vocabolario chiuso e ordinato per priorità. Le regole di
// sopravvivenza (knowledge/survival-rules.json) possono poi aggiungere intenti
// specifici; qui resta la valutazione meccanica di base.
//
// Modulo puro: nessun I/O, testabile con osservazioni finte.

export const NEEDS = [
  'survive', 'escape', 'surface', 'eat', 'heal', 'sleep', 'shelter',
  'obtain_food', 'obtain_weapon', 'obtain_armor', 'replace_tool', 'continue_progression',
];

export function deriveNeeds (perception = {}, risk = {}) {
  const needs = [];
  const add = (need) => { if (!needs.includes(need)) needs.push(need); };
  const health = perception.health;
  const food = perception.food;
  const nearest = perception.nearestThreat;
  const riskLevel = risk.level || 'none';
  const highRisk = riskLevel === 'critical' || riskLevel === 'high';
  const hurt = health != null && health <= 12;
  const badlyHurt = health != null && health <= 6;

  if (perception.dead || badlyHurt) add('survive');
  if (nearest && (hurt || highRisk || nearest.severity === 'critical' || nearest.severity === 'high')) {
    add('escape');
  }
  // Sott'acqua con l'aria agli sgoccioli: prima si risale. In M0 il budget d'aria
  // non è ancora noto (`air` null) e il bisogno non scatta: nessun allarme finto.
  // Con il respiro attivo (M2: elmo di tartaruga o effetto) non c'è nulla da
  // risalire a fare in fretta.
  if (perception.fluids?.headInWater === true && perception.fluids?.waterBreathing !== true &&
      Number.isFinite(perception.fluids?.air) && perception.fluids.air <= 8) {
    add('surface');
  }
  // Contatto con la lava: fuga immediata, è più urgente di ogni altra cura.
  if (perception.fluids?.inLava === true) add('escape');
  // Fuoco addosso, magma sotto i piedi o proiettile in arrivo (N0): come la
  // lava, sono pericoli meccanici e la prima cura è uscirne.
  if (perception.nether?.inFire === true) add('escape');
  if (Number.isFinite(perception.nether?.magmaWithin) && perception.nether.magmaWithin <= 1.5) add('escape');
  if (perception.nether?.projectileIncoming === true) add('escape');
  if (food != null && food <= 14 && perception.hasFood) add('eat');
  if (hurt) add('heal');
  if (perception.night && perception.bedAvailable) add('sleep');
  if (perception.night && !perception.bedAvailable) add('shelter');
  if (food != null && food <= 14 && !perception.hasFood) add('obtain_food');
  if (nearest && !perception.weapon && nearest.distance <= 12) add('obtain_weapon');
  if (badlyHurt && !perception.armorCount) add('obtain_armor');
  const held = perception.heldDurability;
  if (held && held.max > 0 && held.max - held.damage <= 5) add('replace_tool');
  if (!highRisk) add('continue_progression');
  return needs;
}

// Priorità numerica di un bisogno: i valori più alti vincono quando il
// controller/governor deve scegliere una direzione.
export const NEED_PRIORITY = Object.fromEntries(NEEDS.map((need, index) => [need, NEEDS.length - index]));
