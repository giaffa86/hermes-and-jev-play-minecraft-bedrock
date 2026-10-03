// Vocabolario condiviso degli intenti.
//
// Un intento descrive *perché* serve un'azione, non come eseguirla. Le opzioni
// del harness (key + description) vengono mappate su intenti senza conoscere i
// dettagli Bedrock; le skill dichiarative e le regole di sopravvivenza usano
// gli stessi nomi. Il mapping non inventa mai una key: classifica solo quelle
// già offerte dal harness.

// Intenti riconosciuti (documentati in docs/SURVIVAL-INTELLIGENCE.md).
// `swim`/`surface`/`descend`/`ascend`/`fluid` sono il vocabolario dei fluidi
// (M0 di docs/wiki/fluids.md): le azioni che li usano arrivano nelle milestone
// successive, qui restano dichiarati e validati.
export const INTENTS = [
  'escape', 'fight', 'eat', 'heal', 'sleep', 'shelter', 'recover', 'collect',
  'travel', 'mine', 'craft', 'smelt', 'build', 'wait',
  'swim', 'surface', 'descend', 'ascend', 'fluid',
  // Redstone (R2): `toggle` aziona un input, `sense` legge lo stato di un
  // circuito, `redstone` marca il dominio (piazzamento e costruzione).
  'redstone', 'toggle', 'sense',
];

const KEY_INTENTS = {
  wait: ['wait'],
  flee: ['escape'],
  go_home: ['escape', 'shelter'],
  retreat: ['escape', 'shelter'],
  close_door: ['shelter'],
  barricade: ['shelter'],
  equip_armor: ['heal'],
  place_torch: ['build', 'shelter'],
  eat: ['eat', 'heal'],
  sleep: ['sleep', 'heal'],
  recover_loot: ['recover'],
  collect_drop: ['collect'],
  goto_waypoint: ['travel'],
  dig_down: ['mine', 'travel'],
  dig_up: ['mine', 'travel'],
  // Fluidi: allontanarsi dalla lava è una fuga, non un semplice spostamento.
  avoid_lava: ['escape', 'travel'],
  surface: ['surface', 'swim'],
  swim_to: ['swim', 'travel'],
  dive: ['descend', 'swim'],
  // Redstone (R2): azionare un input e leggere lo stato di un circuito.
  use_redstone: ['toggle', 'redstone'],
  sense_redstone: ['sense', 'redstone'],
  set_repeater_delay: ['toggle', 'redstone'],
  teardown_circuit: ['build', 'redstone'],
};

const PREFIX_INTENTS = [
  [/^attack_/, ['fight']],
  [/^mine_/, ['mine']],
  [/^craft_/, ['craft']],
  [/^smelt_/, ['smelt']],
  [/^place_/, ['build']],
  [/^set_repeater_delay_/, ['toggle', 'redstone']],
  [/^teardown_circuit_/, ['build', 'redstone']],
];

// Intenti associati a una key offerta da /options. Una key sconosciuta
// appartiene a `unknown` (usato solo per diagnostica, mai per filtrare).
export function optionIntents (key) {
  const name = String(key || '');
  if (KEY_INTENTS[name]) return [...KEY_INTENTS[name]];
  for (const [pattern, intents] of PREFIX_INTENTS) {
    if (pattern.test(name)) return [...intents];
  }
  return ['unknown'];
}

export function intentMatchesKey (intent, key) {
  return optionIntents(key).includes(intent);
}

// True se la key è coerente con almeno uno degli intenti preferiti.
export function keyMatchesIntents (key, intents) {
  if (!intents || !intents.length) return false;
  return optionIntents(key).some(intent => intents.includes(intent));
}
