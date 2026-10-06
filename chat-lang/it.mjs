// Chat catalogue — Italiano
// One file per language: `chat-i18n.mjs` imports the five and exposes the
// `MESSAGES` table plus `t`/`hasMessage`/`messageKeys`. Keys must be identical
// across languages and so must the `{placeholders}` of each key —
// `tests/chat-i18n.test.mjs` fails otherwise.
//
// This file is the reference: it carries the section comments that explain what
// each group of keys is for. Translations stay plain and short — they are
// one-line chat messages, not prose.

export default Object.freeze({
  // --- lifecycle of a human order (human-replies.mjs) ---
  ack: '@{name} ok: {objective}',
  done: '@{name} fatto: {objective} ({steps} azioni)',
  failed: "@{name} non ce l'ho fatta: {reason}",
  stopped: '@{name} mi fermo qui: {reason}',
  lost: '@{name} non ti vedo piu\': ti aspetto qui. Se ti allontani troppo scrivimi "{prefix} seguimi".',
  escort_waiting: '@{name} ti aspetto qui: sono a x {x}, y {y}, z {z}.',
  follow_suffix: ' — arrivo da {from}',
  objective_received: 'ordine ricevuto',
  objective_default: 'ordine',
  reason_failed: 'fallito',
  reason_stopped: 'budget di azioni esaurito',
  smalltalk: '@{name} ciao! dimmi pure.',

  // --- answers to questions (human-questions.mjs) ---
  answer_template: '@{name} {answer}',
  pos_unknown: 'non lo so: non ho ancora una posizione dal server',
  pos: 'sono a x {x}{y}, z {z}{where}',
  pos_y: ', y {y}',
  pos_dim: ' ({dimension})',
  health_dead: 'sono morto, sto rinascendo',
  health_hearts: '{hearts} cuori ({points}/20 di vita)',
  health_food: '{food}/20 di cibo',
  health: 'ho {parts}',
  health_unknown: 'non lo so: non ho letto la mia vita',
  list_and: ' e ',
  activity: 'sto facendo: {phrase}',
  activity_none: 'non ho un obiettivo: sono in attesa di ordini',
  inv_no_material: 'no, non ne ho; ho: {items}',
  inv_no: 'no, non ne ho',
  inv_yes: 'sì: {items}',
  inv_empty: 'non ho niente in inventario',
  inv_list: 'ho: {items}{more}',
  inv_more: ' (+{n} altri)',
  armor_unknown: 'non lo so: non ho letto la mia armatura',
  armor_none: 'non indosso armatura',
  armor_worn: 'indosso: {items}{points}',
  armor_points: ' ({points} punti armatura)',
  time: 'sono le {clock}{phase}',
  time_phase: ' ({phase})',
  time_only_phase: 'è {phase}',
  time_unknown: 'non lo so che ore siano',
  phase_night: 'notte',
  phase_day: 'giorno',
  identity: 'sono Hermes, il bot di casa. Scrivimi "{prefixes} <ordine>", per esempio "{prefixes} seguimi" o "{prefixes} mina ferro".',
  unrouted: 'non ho capito la domanda. Se era un ordine, scrivi "{prefixes} <ordine>".',
  no_armor: 'non ho armatura in inventario, non posso equipaggiarmi',
  no_item: 'non ho {word} in inventario, non posso gettarlo',
  no_drop: 'non vedo {word} a terra, non posso raccoglierlo',
  list_or: ' o ',

  // --- proactive greeting (human-greeting.mjs) ---
  greet: 'Ciao {name}! Sono Hermes, il bot di casa. Assegnami un task scrivendo in chat: ' +
    '{prefix} <ordine> — per esempio "{prefix} seguimi" oppure "{prefix} mina ferro".',

  // --- deterministic objectives written by the controller (human orders) ---
  'fallback.stop': 'resto fermo in attesa del prossimo ordine',
  'fallback.follow': 'seguo {from} ed eseguo il suo ultimo ordine: "{message}"',
  'fallback.equip': "mi metto l'armatura che ho in inventario (elmo, corazza, gambali, stivali)",
  'fallback.drop': "butto via {word} dall'inventario",
  'fallback.collect': 'raccolgo {word} da terra',

  // --- the goal in progress, described to a human ---
  'phrase.equip': "indossare l'armatura",
  'phrase.drop': 'buttare via {word}',
  'phrase.collect': 'raccogliere {word} da terra',
  'phrase.recover': 'recuperare quello che ho perso morendo',
  'phrase.construction': 'costruire',
  'phrase.opportunity': 'raccogliere quello che ho visto qui vicino',
  'phrase.curriculum': 'portare avanti la missione',

  // --- village chores (village-labor.mjs ids) ---
  'chore.harvest_crops': 'raccogliere il raccolto maturo',
  'chore.store_harvest': 'mettere da parte il raccolto',
  'chore.shear_sheep': 'tosare le pecore',
  'chore.milk_cows': 'mungere le mucche',
  'chore.collect_honey': 'raccogliere il miele',
  'chore.tend_animals': 'far crescere il gregge',
  'chore.plant_crops': 'seminare gli orti',
  'chore.go_fishing': 'pescare',
  'chore.chop_wood': 'tagliare legna',
  'chore.gather_stone': 'raccogliere pietra',
  'chore.mine_ore': 'cercare minerali',

  // --- survival needs (survival/needs.mjs ids) ---
  'need.survive': 'mettermi in salvo',
  'need.escape': 'scappare dal pericolo',
  'need.eat': 'mangiare qualcosa',
  'need.heal': 'curarmi',
  'need.sleep': 'andare a dormire',
  'need.shelter': 'trovarmi un riparo',
  'need.obtain_food': 'procurarmi del cibo',
  'need.obtain_weapon': "procurarmi un'arma",
  'need.obtain_armor': "procurarmi un'armatura",
  'need.replace_tool': "cambiare l'attrezzo rotto",
  'need.wear_armor': "indossare l'armatura",
  'need.surface': 'risalire in superficie',
  'need.continue_progression': 'portare avanti la progressione',

  // --- M8: what the bot announces when it starts a job on its own. `{phrase}`
  // is a first-person progressive built from `narrate.*`; `{target}` is the
  // concrete thing, from `item.*` when we know it, otherwise `kind.*`. ---
  'autonomy_narration': 'In autonomia: {phrase}',
  'narrate_need': 'In autonomia devo {phrase}',
  'narrate.harvest_crops': 'sto raccogliendo {target}',
  'narrate.store_harvest': 'sto mettendo via {target}',
  'narrate.shear_sheep': 'sto tosando le pecore',
  'narrate.milk_cows': 'sto mungendo le mucche',
  'narrate.collect_honey': 'sto raccogliendo il miele',
  'narrate.tend_animals': 'sto facendo crescere il gregge',
  'narrate.plant_crops': 'sto seminando {target}',
  'narrate.go_fishing': 'sto pescando',
  'narrate.chop_wood': 'sto tagliando {target}',
  'narrate.gather_stone': 'sto raccogliendo {target}',
  'narrate.mine_ore': 'sto estraendo {target}',
  'item.potato': 'le patate',
  'item.wheat': 'il grano',
  'item.carrot': 'le carote',
  'item.beetroot': 'le barbabietole',
  'item.sweet_berries': 'le bacche dolci',
  'item.melon_slice': 'le fette di anguria',
  'item.pumpkin': 'le zucche',
  'item.nether_wart': 'il nether wart',
  'kind.crop': 'le colture',
  'kind.log': 'la legna',
  'kind.stone': 'la pietra',
  'kind.ore': 'i minerali',
  'kind.fish': 'il pesce',
  'kind.animal': 'gli animali',
  'kind.wool': 'la lana',
  'kind.milk': 'il latte',
  'kind.honey': 'il miele',
  'kind.goods': 'la roba raccolta',
});
