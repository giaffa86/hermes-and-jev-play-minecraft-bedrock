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
  // Nether (N4): `barter` è lo scambio con un piglin — non è `collect` (il
  // pegno arriva dal mondo) né `craft`, e la sua neutralità non è negoziabile.
  'barter',
];

const KEY_INTENTS = {
  wait: ['wait'],
  flee: ['escape'],
  go_home: ['escape', 'shelter'],
  retreat: ['escape', 'shelter'],
  close_door: ['shelter'],
  barricade: ['shelter'],
  equip_armor: ['heal'],
  // Riarmo completo (armatura + scudo in un colpo): stessa famiglia di
  // `equip_armor`/`equip_shield` — senza la voce la chiave sarebbe `unknown` e
  // il filtro di emergenza la toglierebbe proprio quando l'armatura serve
  // (lo stesso difetto trovato live il 06/10/2026 sullo scudo contro uno
  // scheletro).
  rearm_gear: ['heal', 'shelter'],
  // Difesa passiva: lo scudo ferma le frecce, quindi in emergenza e' una forma di
  // riparo (`shelter`) come una porta chiusa. Senza queste voci le tre key
  // restavano `unknown` e il filtro del governor le toglieva proprio quando
  // arriva la freccia (visto live il 06/10/2026 contro uno scheletro).
  equip_shield: ['shelter', 'heal'],
  raise_shield: ['shelter'],
  lower_shield: ['shelter'],
  place_torch: ['build', 'shelter'],
  eat: ['eat', 'heal'],
  sleep: ['sleep', 'heal'],
  recover_loot: ['recover'],
  collect_drop: ['collect'],
  construction_step: ['build'],
  construction_supply: ['collect', 'craft', 'mine'],
  harvest_honeycomb: ['collect'],
  harvest_honey: ['collect'],
  feed_bee: ['collect'],
  breed_bee: ['collect'],
  goto_waypoint: ['travel'],
  // `follow_player` e' l'ordine umano "seguimi": movimento verso la persona
  // che ha chiamato il bot. Come per `seek_player` conta come `travel`; a
  // differenza sua e' un inseguimento di un bersaglio mobile, quindi il
  // filtro di emergenza lo protegge quando l'ordine e' aperto (resolver.mjs).
  follow_player: ['travel'],
  // `join_human_mount` e' «l'umano si e' imbarcato e c'e' un posto per me»:
  // stessa famiglia di movimento (`travel`), ma il bersaglio non e' la persona,
  // e' il suo mezzo. Resta distinto da `follow_player` perche' l'ordine di
  // dispatch e la priorita' devono tenere la salita *prima* di ogni inseguimento.
  join_human_mount: ['travel'],
  // `seek_player` e' il recupero autonomo dell'umano perso: cammina verso
  // l'ultima posizione nota senza inseguire un bersaglio mobile. Conta come
  // movimento (`travel`), ma resta distinto da `follow_player` perche' puo'
  // fallire con `found: false` invece di dichiarare un inseguimento riuscito.
  seek_player: ['travel'],
  // `escort_to` e' l'ordine umano «guidami/accompagnami fino a <posto>»: il bot
  // guida e aspetta chi resta indietro. E' movimento (`travel`), ma non e' un
  // inseguimento come `follow_player`: la meta la decide il bot e l'umano puo'
  // restare indietro senza che l'azione menta sul suo esito.
  escort_to: ['travel'],
  dig_down: ['mine', 'travel'],
  dig_up: ['mine', 'travel'],
  // Fluidi: allontanarsi dalla lava è una fuga, non un semplice spostamento.
  avoid_lava: ['escape', 'travel'],
  // Fluidi (M4): raggiungere una sponda sicura è una fuga; attraversare la lava è
  // un viaggio che richiede attrezzatura (il gate è esplicito nel verdetto).
  move_to_safe: ['escape', 'travel'],
  cross_lava: ['travel', 'fluid'],
  // Nether (N3): schivare un proiettile è una fuga laterale, non un viaggio.
  dodge_projectile: ['escape', 'travel'],
  surface: ['surface', 'swim'],
  swim_to: ['swim', 'travel'],
  dive: ['descend', 'swim'],
  // Fluidi (M3): scendere da una cascata è una discesa controllata, risalire la
  // colonna d'acqua è una salita, e una colonna di bolle è una manovra fluida.
  descend_waterfall: ['descend', 'travel'],
  climb_waterfall: ['ascend', 'travel'],
  use_bubble_column: ['fluid', 'ascend', 'descend', 'travel'],
  // Fluidi (M5): spostare un fluido col secchio è una raccolta (riempire) o una
  // costruzione (svuotare); la barca è un viaggio sull'acqua e la pozione è
  // sopravvivenza che si prepara.
  fill_bucket: ['collect', 'fluid'],
  empty_bucket: ['build', 'fluid'],
  place_water: ['build', 'fluid'],
  place_lava: ['build', 'fluid'],
  fill_bottle: ['collect', 'fluid'],
  craft_boat: ['craft', 'travel'],
  mount_boat: ['travel', 'fluid'],
  brew_water_breathing: ['survive', 'fluid', 'heal'],
  brew_fire_resistance: ['survive', 'fluid', 'heal'],
  brew_night_vision: ['travel', 'fluid'],
  // Redstone (R2): azionare un input e leggere lo stato di un circuito.
  use_redstone: ['toggle', 'redstone'],
  sense_redstone: ['sense', 'redstone'],
  set_repeater_delay: ['toggle', 'redstone'],
  teardown_circuit: ['build', 'redstone'],
  // Nether (N1): raggiungere un portale è viaggio, costruirlo e accenderlo è
  // costruzione (l'entrata vera e propria è `enter_portal`, che è viaggio).
  goto_portal: ['travel'],
  enter_portal: ['travel'],
  build_portal: ['build'],
  light_portal: ['build'],
  // Nether (N2): un hub e un rifugio *e* un punto di rientro (`home`).
  build_nether_hub: ['build', 'shelter'],
  // Nether (N4): pagare un piglin con l'oro in mano e raccogliere il pegno.
  barter_piglin: ['barter', 'collect'],
  // Nether (N5): staccare gli occhi da un enderman è una fuga (la regola
  // `gazed_at_enderman` chiede `escape`/`shelter`); la zucca è preparazione, e
  // `heal` perché è comunque un pezzo di armatura.
  avoid_enderman_gaze: ['escape', 'shelter'],
  equip_pumpkin: ['heal', 'shelter'],
  // Nether (N6): la caccia al blaze è un combattimento con la copertura come
  // mezzo e i rod come scopo.
  hunt_blaze: ['fight', 'collect'],
};

const PREFIX_INTENTS = [
  [/^attack_/, ['fight']],
  // Raccogliere una coltura matura e' un raccolto e, quando la coltura e'
  // commestibile (carote, patate), anche un modo per procurarsi cibo.
  [/^harvest_/, ['collect', 'mine']],
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

// Vocabolario **dichiarato** delle key di /options: le key note e i prefissi,
// ciascuno con i suoi intenti. Non e' la verita' runtime — `/options` resta
// autoritativo — ma il vocabolario che il mapping conosce, esposto per
// l'inventario delle capability (tools/capability-inventory.mjs, R0).
export function declaredOptionVocabulary () {
  return {
    keys: Object.keys(KEY_INTENTS).sort().map(key => ({ key, intents: optionIntents(key) })),
    patterns: PREFIX_INTENTS.map(([pattern, intents]) => ({ pattern: pattern.source, intents: [...intents] })),
  };
}

export function intentMatchesKey (intent, key) {
  return optionIntents(key).includes(intent);
}

// True se la key è coerente con almeno uno degli intenti preferiti.
export function keyMatchesIntents (key, intents) {
  if (!intents || !intents.length) return false;
  return optionIntents(key).some(intent => intents.includes(intent));
}
