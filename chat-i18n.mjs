// Chat internationalisation (M8): every message the bot writes in chat comes
// from a catalogue here, one entry per language. `CHAT_LANG` picks the default
// language — the one the bot speaks on its own (greeting, unrouted question,
// lifecycle templates, answers to questions) — and unknown values fall back to
// `DEFAULT_LANG` instead of leaving the channel in a language nobody chose.
//
// Pure module: no I/O, no clock, no model, no knowledge of the transport. The
// controller resolves the language once (`chatLangConfig`) and passes it down;
// the renderers (`human-replies.mjs`, `human-questions.mjs`, `human-greeting.mjs`)
// only look the strings up.
//
// Why the *default* language and not the sender's: a chat message carries no
// reliable language tag, and the deterministic path must never guess a fact.
// What is certain is the server's language, which the owner configures once.
// The model path (M7) is the one that follows the sender turn by turn, and it
// is already told to do so (`chat-llm.mjs`).
//
// Translations are deliberately plain and short: they are one-line chat
// messages, not prose. A key missing in a language falls back to the default
// language and then to the key itself, so a half-translated catalogue degrades
// instead of crashing.

export const LANGS = Object.freeze(['it', 'en', 'fr', 'es', 'de']);

// The language the bot speaks when nothing says otherwise. Italian is the
// historic behaviour of this server, so existing deployments do not change.
export const DEFAULT_LANG = 'it';

// Names used inside a *prompt* (the planner writes in English).
export const LANG_NAMES = Object.freeze({ it: 'Italian', en: 'English', fr: 'French', es: 'Spanish', de: 'German' });

// Names a human would use in their own language, for prompts that must be
// language-agnostic (`chat-llm.mjs` tells the model "if the language of the
// message is unclear, answer in <own language name>").
export const LANG_NATIVE_NAMES = Object.freeze({
  it: 'italiano', en: 'English', fr: 'français', es: 'español', de: 'Deutsch',
});

// The catalogue. Keys are flat and dotted; `{name}` placeholders are filled by
// `t()` and a missing value renders as an empty string (same rule as
// `renderReply` in `human-replies.mjs`).
export const MESSAGES = Object.freeze({
  it: Object.freeze({
    // --- lifecycle of a human order (human-replies.mjs) ---
    ack: '@{name} ok: {objective}',
    done: '@{name} fatto: {objective} ({steps} azioni)',
    failed: "@{name} non ce l'ho fatta: {reason}",
    stopped: '@{name} mi fermo qui: {reason}',
    lost: '@{name} non ti vedo piu\': ti aspetto qui. Se ti allontani troppo scrivimi "{prefix} seguimi".',
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
    list_or: ' o ',

    // --- proactive greeting (human-greeting.mjs) ---
    greet: 'Ciao {name}! Sono Hermes, il bot di casa. Assegnami un task scrivendo in chat: ' +
      '{prefix} <ordine> — per esempio "{prefix} seguimi" oppure "{prefix} mina ferro".',

    // --- deterministic objectives written by the controller (human orders) ---
    'fallback.stop': 'resto fermo in attesa del prossimo ordine',
    'fallback.follow': 'seguo {from} ed eseguo il suo ultimo ordine: "{message}"',
    'fallback.equip': "mi metto l'armatura che ho in inventario (elmo, corazza, gambali, stivali)",

    // --- the goal in progress, described to a human ---
    'phrase.equip': "indossare l'armatura",
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
  }),

  en: Object.freeze({
    ack: '@{name} ok: {objective}',
    done: '@{name} done: {objective} ({steps} actions)',
    failed: "@{name} I couldn't do it: {reason}",
    stopped: "@{name} I'm stopping here: {reason}",
    lost: '@{name} I don\'t see you anymore: I will wait here. If you go too far, text me "{prefix} follow me".',
    follow_suffix: ' — coming to {from}',
    objective_received: 'order received',
    objective_default: 'order',
    reason_failed: 'it failed',
    reason_stopped: 'out of action budget',
    smalltalk: '@{name} hi! just tell me.',

    answer_template: '@{name} {answer}',
    pos_unknown: "I don't know yet: no position from the server",
    pos: "I'm at x {x}{y}, z {z}{where}",
    pos_y: ', y {y}',
    pos_dim: ' ({dimension})',
    health_dead: "I'm dead, respawning",
    health_hearts: '{hearts} hearts ({points}/20 health)',
    health_food: '{food}/20 food',
    health: 'I have {parts}',
    health_unknown: "I don't know: I didn't read my health",
    list_and: ' and ',
    activity: "I'm doing: {phrase}",
    activity_none: "I have no goal: I'm waiting for orders",
    inv_no_material: "no, I don't have one; I have: {items}",
    inv_no: "no, I don't have one",
    inv_yes: 'yes: {items}',
    inv_empty: 'I have nothing in my inventory',
    inv_list: 'I have: {items}{more}',
    inv_more: ' (+{n} more)',
    armor_unknown: "I don't know: I didn't read my armor",
    armor_none: "I'm not wearing armor",
    armor_worn: "I'm wearing: {items}{points}",
    armor_points: ' ({points} armor points)',
    time: "it's {clock}{phase}",
    time_phase: ' ({phase})',
    time_only_phase: "it's {phase}",
    time_unknown: "I don't know what time it is",
    phase_night: 'night',
    phase_day: 'day',
    identity: 'I am Hermes, the house bot. Text me "{prefixes} <order>", for example "{prefixes} follow me" or "{prefixes} mine iron".',
    unrouted: 'I did not understand the question. If it was an order, write "{prefixes} <order>".',
    no_armor: "I have no armor in my inventory, I can't equip myself",
    list_or: ' or ',

    greet: 'Hi {name}! I am Hermes, the house bot. Give me a task by writing in chat: ' +
      '{prefix} <order> — for example "{prefix} follow me" or "{prefix} mine iron".',

    'fallback.stop': 'I stay put and wait for the next order',
    'fallback.follow': 'I follow {from} and do their last order: "{message}"',
    'fallback.equip': 'I put on the armor I have in my inventory (helmet, chestplate, leggings, boots)',

    'phrase.equip': 'putting on the armor',
    'phrase.recover': 'recovering what I lost when I died',
    'phrase.construction': 'building',
    'phrase.opportunity': 'picking up what I spotted nearby',
    'phrase.curriculum': 'carrying on with the mission',

    'chore.harvest_crops': 'harvesting the ripe crops',
    'chore.store_harvest': 'putting the harvest away',
    'chore.shear_sheep': 'shearing the sheep',
    'chore.milk_cows': 'milking the cows',
    'chore.collect_honey': 'collecting the honey',
    'chore.tend_animals': 'growing the herd',
    'chore.plant_crops': 'planting the garden',
    'chore.go_fishing': 'fishing',
    'chore.chop_wood': 'chopping wood',
    'chore.gather_stone': 'gathering stone',
    'chore.mine_ore': 'looking for ore',

    'need.survive': 'getting to safety',
    'need.escape': 'running from danger',
    'need.eat': 'eating something',
    'need.heal': 'healing myself',
    'need.sleep': 'going to sleep',
    'need.shelter': 'finding shelter',
    'need.obtain_food': 'getting myself some food',
    'need.obtain_weapon': 'getting myself a weapon',
    'need.obtain_armor': 'getting myself some armor',
    'need.replace_tool': 'replacing my broken tool',
    'need.wear_armor': 'putting on the armor',
    'need.surface': 'coming back up to the surface',
    'need.continue_progression': 'carrying on with the progression',

    'autonomy_narration': 'On my own: {phrase}',
    'narrate_need': 'On my own I am {phrase}',
    'narrate.harvest_crops': "I'm harvesting {target}",
    'narrate.store_harvest': "I'm putting {target} away",
    'narrate.shear_sheep': "I'm shearing the sheep",
    'narrate.milk_cows': "I'm milking the cows",
    'narrate.collect_honey': "I'm collecting the honey",
    'narrate.tend_animals': "I'm growing the herd",
    'narrate.plant_crops': "I'm planting {target}",
    'narrate.go_fishing': "I'm fishing",
    'narrate.chop_wood': "I'm chopping {target}",
    'narrate.gather_stone': "I'm gathering {target}",
    'narrate.mine_ore': "I'm mining {target}",
    'item.potato': 'the potatoes',
    'item.wheat': 'the wheat',
    'item.carrot': 'the carrots',
    'item.beetroot': 'the beetroot',
    'item.sweet_berries': 'the sweet berries',
    'item.melon_slice': 'the melon slices',
    'item.pumpkin': 'the pumpkins',
    'item.nether_wart': 'the nether wart',
    'kind.crop': 'the crops',
    'kind.log': 'wood',
    'kind.stone': 'stone',
    'kind.ore': 'ore',
    'kind.fish': 'fish',
    'kind.animal': 'the animals',
    'kind.wool': 'wool',
    'kind.milk': 'milk',
    'kind.honey': 'honey',
    'kind.goods': 'the stuff I gathered',
  }),

  fr: Object.freeze({
    ack: '@{name} ok, {objective}',
    done: "@{name} c'est fait, {objective} ({steps} actions)",
    failed: "@{name} je n'ai pas réussi, {reason}",
    stopped: "@{name} je m'arrête là, {reason}",
    lost: '@{name} je ne te vois plus, je t\'attends ici. Si tu t\'éloignes trop, écris-moi "{prefix} suis-moi".',
    follow_suffix: " — j'arrive vers {from}",
    objective_received: 'ordre reçu',
    objective_default: 'ordre',
    reason_failed: 'échec',
    reason_stopped: "budget d'actions épuisé",
    smalltalk: '@{name} salut ! dis-moi.',

    answer_template: '@{name} {answer}',
    pos_unknown: "je ne sais pas encore, je n'ai pas de position du serveur",
    pos: 'je suis à x {x}{y}, z {z}{where}',
    pos_y: ', y {y}',
    pos_dim: ' ({dimension})',
    health_dead: 'je suis mort, je réapparais',
    health_hearts: '{hearts} cœurs ({points}/20 de vie)',
    health_food: '{food}/20 de nourriture',
    health: "j'ai {parts}",
    health_unknown: "je ne sais pas, je n'ai pas lu ma vie",
    list_and: ' et ',
    activity: 'je fais : {phrase}',
    activity_none: "je n'ai pas d'objectif, j'attends des ordres",
    inv_no_material: "non, je n'en ai pas ; j'ai : {items}",
    inv_no: "non, je n'en ai pas",
    inv_yes: 'oui : {items}',
    inv_empty: "je n'ai rien dans mon inventaire",
    inv_list: "j'ai : {items}{more}",
    inv_more: ' (+{n} autres)',
    armor_unknown: "je ne sais pas, je n'ai pas lu mon armure",
    armor_none: "je ne porte pas d'armure",
    armor_worn: 'je porte : {items}{points}',
    armor_points: " ({points} points d'armure)",
    time: 'il est {clock}{phase}',
    time_phase: ' ({phase})',
    time_only_phase: "c'est {phase}",
    time_unknown: "je ne sais pas quelle heure il est",
    phase_night: 'nuit',
    phase_day: 'jour',
    identity: 'je suis Hermes, le bot de la maison. Écris-moi "{prefixes} <ordre>", par exemple "{prefixes} suis-moi" ou "{prefixes} mine du fer".',
    unrouted: 'je n\'ai pas compris la question. Si c\'était un ordre, écris "{prefixes} <ordre>".',
    no_armor: "je n'ai pas d'armure dans mon inventaire, je ne peux pas m'équiper",
    list_or: ' ou ',

    greet: 'Salut {name} ! Je suis Hermes, le bot de la maison. Donne-moi une tâche en écrivant ' +
      'dans le chat : {prefix} <ordre> — par exemple "{prefix} suis-moi" ou "{prefix} mine du fer".',

    'fallback.stop': "je reste ici et j'attends le prochain ordre",
    'fallback.follow': 'je suis {from} et j\'exécute son dernier ordre : "{message}"',
    'fallback.equip': "je mets l'armure que j'ai dans mon inventaire (casque, plastron, jambières, bottes)",

    'phrase.equip': "mettre l'armure",
    'phrase.recover': "récupérer ce que j'ai perdu en mourant",
    'phrase.construction': 'construire',
    'phrase.opportunity': "ramasser ce que j'ai repéré tout près",
    'phrase.curriculum': 'avancer dans la mission',

    'chore.harvest_crops': 'récolter les cultures mûres',
    'chore.store_harvest': 'ranger la récolte',
    'chore.shear_sheep': 'tondre les moutons',
    'chore.milk_cows': 'traire les vaches',
    'chore.collect_honey': 'récolter le miel',
    'chore.tend_animals': 'faire grandir le troupeau',
    'chore.plant_crops': 'semer le potager',
    'chore.go_fishing': 'pêcher',
    'chore.chop_wood': 'couper du bois',
    'chore.gather_stone': 'ramasser de la pierre',
    'chore.mine_ore': 'chercher du minerai',

    'need.survive': "me mettre à l'abri",
    'need.escape': 'fuir le danger',
    'need.eat': 'manger quelque chose',
    'need.heal': 'me soigner',
    'need.sleep': 'aller dormir',
    'need.shelter': 'me trouver un abri',
    'need.obtain_food': 'me procurer de la nourriture',
    'need.obtain_weapon': 'me procurer une arme',
    'need.obtain_armor': 'me procurer une armure',
    'need.replace_tool': 'remplacer mon outil cassé',
    'need.wear_armor': "mettre l'armure",
    'need.surface': 'remonter à la surface',
    'need.continue_progression': 'continuer la progression',

    'autonomy_narration': 'En autonomie : {phrase}',
    'narrate_need': 'En autonomie, je suis en train de {phrase}',
    'narrate.harvest_crops': 'je récolte {target}',
    'narrate.store_harvest': 'je range {target}',
    'narrate.shear_sheep': 'je tonds les moutons',
    'narrate.milk_cows': 'je trais les vaches',
    'narrate.collect_honey': 'je récolte le miel',
    'narrate.tend_animals': 'je fais grandir le troupeau',
    'narrate.plant_crops': 'je sème {target}',
    'narrate.go_fishing': 'je pêche',
    'narrate.chop_wood': 'je coupe {target}',
    'narrate.gather_stone': 'je ramasse {target}',
    'narrate.mine_ore': "j'extrais {target}",
    'item.potato': 'les pommes de terre',
    'item.wheat': 'le blé',
    'item.carrot': 'les carottes',
    'item.beetroot': 'les betteraves',
    'item.sweet_berries': 'les baies sucrées',
    'item.melon_slice': "les tranches de pastèque",
    'item.pumpkin': 'les citrouilles',
    'item.nether_wart': 'la verrue du Nether',
    'kind.crop': 'les cultures',
    'kind.log': 'du bois',
    'kind.stone': 'de la pierre',
    'kind.ore': 'du minerai',
    'kind.fish': 'du poisson',
    'kind.animal': 'les animaux',
    'kind.wool': 'de la laine',
    'kind.milk': 'du lait',
    'kind.honey': 'du miel',
    'kind.goods': "ce que j'ai ramassé",
  }),

  es: Object.freeze({
    ack: '@{name} ok: {objective}',
    done: '@{name} hecho: {objective} ({steps} acciones)',
    failed: '@{name} no lo he conseguido: {reason}',
    stopped: '@{name} me paro aquí: {reason}',
    lost: '@{name} ya no te veo: te espero aquí. Si te alejas demasiado, escríbeme "{prefix} sígueme".',
    follow_suffix: ' — voy hacia {from}',
    objective_received: 'orden recibida',
    objective_default: 'orden',
    reason_failed: 'ha fallado',
    reason_stopped: 'presupuesto de acciones agotado',
    smalltalk: '@{name} ¡hola! dime.',

    answer_template: '@{name} {answer}',
    pos_unknown: 'no lo sé todavía: no tengo posición del servidor',
    pos: 'estoy en x {x}{y}, z {z}{where}',
    pos_y: ', y {y}',
    pos_dim: ' ({dimension})',
    health_dead: 'estoy muerto, estoy reapareciendo',
    health_hearts: '{hearts} corazones ({points}/20 de vida)',
    health_food: '{food}/20 de comida',
    health: 'tengo {parts}',
    health_unknown: 'no lo sé: no he leído mi vida',
    list_and: ' y ',
    activity: 'estoy haciendo: {phrase}',
    activity_none: 'no tengo objetivo: estoy esperando órdenes',
    inv_no_material: 'no, no tengo; tengo: {items}',
    inv_no: 'no, no tengo',
    inv_yes: 'sí: {items}',
    inv_empty: 'no tengo nada en el inventario',
    inv_list: 'tengo: {items}{more}',
    inv_more: ' (+{n} más)',
    armor_unknown: 'no lo sé: no he leído mi armadura',
    armor_none: 'no llevo armadura',
    armor_worn: 'llevo: {items}{points}',
    armor_points: ' ({points} puntos de armadura)',
    time: 'son las {clock}{phase}',
    time_phase: ' ({phase})',
    time_only_phase: 'es de {phase}',
    time_unknown: 'no sé qué hora es',
    phase_night: 'noche',
    phase_day: 'día',
    identity: 'soy Hermes, el bot de la casa. Escríbeme "{prefixes} <orden>", por ejemplo "{prefixes} sígueme" o "{prefixes} mina hierro".',
    unrouted: 'no he entendido la pregunta. Si era una orden, escribe "{prefixes} <orden>".',
    no_armor: 'no tengo armadura en el inventario, no puedo equiparme',
    list_or: ' o ',

    greet: '¡Hola {name}! Soy Hermes, el bot de la casa. Dame una tarea escribiendo en el chat: ' +
      '{prefix} <orden> — por ejemplo "{prefix} sígueme" o "{prefix} mina hierro".',

    'fallback.stop': 'me quedo quieto esperando la próxima orden',
    'fallback.follow': 'sigo a {from} y hago su última orden: "{message}"',
    'fallback.equip': 'me pongo la armadura que tengo en el inventario (casco, peto, grebas, botas)',

    'phrase.equip': 'ponerme la armadura',
    'phrase.recover': 'recuperar lo que perdí al morir',
    'phrase.construction': 'construir',
    'phrase.opportunity': 'recoger lo que he visto aquí cerca',
    'phrase.curriculum': 'seguir con la misión',

    'chore.harvest_crops': 'recoger la cosecha madura',
    'chore.store_harvest': 'guardar la cosecha',
    'chore.shear_sheep': 'esquilar las ovejas',
    'chore.milk_cows': 'ordeñar las vacas',
    'chore.collect_honey': 'recoger la miel',
    'chore.tend_animals': 'hacer crecer el rebaño',
    'chore.plant_crops': 'sembrar el huerto',
    'chore.go_fishing': 'pescar',
    'chore.chop_wood': 'cortar leña',
    'chore.gather_stone': 'recoger piedra',
    'chore.mine_ore': 'buscar mineral',

    'need.survive': 'ponerme a salvo',
    'need.escape': 'escapar del peligro',
    'need.eat': 'comer algo',
    'need.heal': 'curarme',
    'need.sleep': 'ir a dormir',
    'need.shelter': 'buscarme un refugio',
    'need.obtain_food': 'conseguir comida',
    'need.obtain_weapon': 'conseguir un arma',
    'need.obtain_armor': 'conseguir una armadura',
    'need.replace_tool': 'cambiar mi herramienta rota',
    'need.wear_armor': 'ponerme la armadura',
    'need.surface': 'subir a la superficie',
    'need.continue_progression': 'seguir con la progresión',

    'autonomy_narration': 'En autonomía: {phrase}',
    'narrate_need': 'En autonomía voy a {phrase}',
    'narrate.harvest_crops': 'estoy cosechando {target}',
    'narrate.store_harvest': 'estoy guardando {target}',
    'narrate.shear_sheep': 'estoy esquilando las ovejas',
    'narrate.milk_cows': 'estoy ordeñando las vacas',
    'narrate.collect_honey': 'estoy recogiendo la miel',
    'narrate.tend_animals': 'estoy criando el rebaño',
    'narrate.plant_crops': 'estoy sembrando {target}',
    'narrate.go_fishing': 'estoy pescando',
    'narrate.chop_wood': 'estoy cortando {target}',
    'narrate.gather_stone': 'estoy recogiendo {target}',
    'narrate.mine_ore': 'estoy minando {target}',
    'item.potato': 'las patatas',
    'item.wheat': 'el trigo',
    'item.carrot': 'las zanahorias',
    'item.beetroot': 'las remolachas',
    'item.sweet_berries': 'las bayas dulces',
    'item.melon_slice': 'las rodajas de sandía',
    'item.pumpkin': 'las calabazas',
    'item.nether_wart': 'la verruga del Nether',
    'kind.crop': 'los cultivos',
    'kind.log': 'madera',
    'kind.stone': 'piedra',
    'kind.ore': 'mineral',
    'kind.fish': 'pescado',
    'kind.animal': 'los animales',
    'kind.wool': 'lana',
    'kind.milk': 'leche',
    'kind.honey': 'miel',
    'kind.goods': 'lo que he recogido',
  }),

  de: Object.freeze({
    ack: '@{name} ok: {objective}',
    done: '@{name} erledigt: {objective} ({steps} Aktionen)',
    failed: '@{name} das habe ich nicht geschafft: {reason}',
    stopped: '@{name} ich höre hier auf: {reason}',
    lost: '@{name} ich sehe dich nicht mehr: ich warte hier. Wenn du zu weit weggehst, schreib mir "{prefix} folge mir".',
    follow_suffix: ' — ich komme zu {from}',
    objective_received: 'Auftrag erhalten',
    objective_default: 'Auftrag',
    reason_failed: 'fehlgeschlagen',
    reason_stopped: 'Aktionsbudget aufgebraucht',
    smalltalk: '@{name} hallo! sag einfach.',

    answer_template: '@{name} {answer}',
    pos_unknown: 'weiß ich noch nicht: keine Position vom Server',
    pos: 'ich bin bei x {x}{y}, z {z}{where}',
    pos_y: ', y {y}',
    pos_dim: ' ({dimension})',
    health_dead: 'ich bin tot und respawne',
    health_hearts: '{hearts} Herzen ({points}/20 Leben)',
    health_food: '{food}/20 Essen',
    health: 'ich habe {parts}',
    health_unknown: 'weiß ich nicht: ich habe mein Leben nicht gelesen',
    list_and: ' und ',
    activity: 'ich mache gerade: {phrase}',
    activity_none: 'ich habe kein Ziel: ich warte auf Aufträge',
    inv_no_material: 'nein, habe ich nicht; ich habe: {items}',
    inv_no: 'nein, habe ich nicht',
    inv_yes: 'ja: {items}',
    inv_empty: 'ich habe nichts im Inventar',
    inv_list: 'ich habe: {items}{more}',
    inv_more: ' (+{n} weitere)',
    armor_unknown: 'weiß ich nicht: ich habe meine Rüstung nicht gelesen',
    armor_none: 'ich trage keine Rüstung',
    armor_worn: 'ich trage: {items}{points}',
    armor_points: ' ({points} Rüstungspunkte)',
    time: 'es ist {clock}{phase}',
    time_phase: ' ({phase})',
    time_only_phase: 'es ist {phase}',
    time_unknown: 'ich weiß nicht, wie spät es ist',
    phase_night: 'Nacht',
    phase_day: 'Tag',
    identity: 'ich bin Hermes, der Haus-Bot. Schreib mir "{prefixes} <Auftrag>", zum Beispiel "{prefixes} folge mir" oder "{prefixes} baue Eisen ab".',
    unrouted: 'ich habe die Frage nicht verstanden. Wenn es ein Auftrag war, schreib "{prefixes} <Auftrag>".',
    no_armor: 'ich habe keine Rüstung im Inventar, ich kann mich nicht ausrüsten',
    list_or: ' oder ',

    greet: 'Hallo {name}! Ich bin Hermes, der Haus-Bot. Gib mir eine Aufgabe im Chat: ' +
      '{prefix} <Auftrag> — zum Beispiel "{prefix} folge mir" oder "{prefix} baue Eisen ab".',

    'fallback.stop': 'ich bleibe stehen und warte auf den nächsten Auftrag',
    'fallback.follow': 'ich folge {from} und mache den letzten Auftrag: "{message}"',
    'fallback.equip': 'ich ziehe die Rüstung aus meinem Inventar an (Helm, Brustplatte, Beinschutz, Stiefel)',

    'phrase.equip': 'die Rüstung anziehen',
    'phrase.recover': 'holen, was ich beim Tod verloren habe',
    'phrase.construction': 'bauen',
    'phrase.opportunity': 'einsammeln, was ich hier in der Nähe gesehen habe',
    'phrase.curriculum': 'die Mission weiterführen',

    'chore.harvest_crops': 'die reifen Feldfrüchte ernten',
    'chore.store_harvest': 'die Ernte einlagern',
    'chore.shear_sheep': 'die Schafe scheren',
    'chore.milk_cows': 'die Kühe melken',
    'chore.collect_honey': 'den Honig sammeln',
    'chore.tend_animals': 'die Herde vergrößern',
    'chore.plant_crops': 'den Garten besäen',
    'chore.go_fishing': 'fischen',
    'chore.chop_wood': 'Holz hacken',
    'chore.gather_stone': 'Stein sammeln',
    'chore.mine_ore': 'nach Erz suchen',

    'need.survive': 'mich in Sicherheit bringen',
    'need.escape': 'vor der Gefahr fliehen',
    'need.eat': 'etwas essen',
    'need.heal': 'mich heilen',
    'need.sleep': 'schlafen gehen',
    'need.shelter': 'einen Unterschlupf finden',
    'need.obtain_food': 'mir Essen besorgen',
    'need.obtain_weapon': 'mir eine Waffe besorgen',
    'need.obtain_armor': 'mir eine Rüstung besorgen',
    'need.replace_tool': 'mein kaputtes Werkzeug ersetzen',
    'need.wear_armor': 'die Rüstung anziehen',
    'need.surface': 'wieder an die Oberfläche kommen',
    'need.continue_progression': 'mit dem Fortschritt weitermachen',

    'autonomy_narration': 'Selbstständig: {phrase}',
    'narrate_need': 'Selbstständig muss ich {phrase}',
    'narrate.harvest_crops': 'ich ernte {target}',
    'narrate.store_harvest': 'ich räume {target} weg',
    'narrate.shear_sheep': 'ich schere die Schafe',
    'narrate.milk_cows': 'ich melke die Kühe',
    'narrate.collect_honey': 'ich sammle den Honig',
    'narrate.tend_animals': 'ich vergrößere die Herde',
    'narrate.plant_crops': 'ich säe {target}',
    'narrate.go_fishing': 'ich angle',
    'narrate.chop_wood': 'ich hacke {target}',
    'narrate.gather_stone': 'ich sammle {target}',
    'narrate.mine_ore': 'ich baue {target} ab',
    'item.potato': 'die Kartoffeln',
    'item.wheat': 'den Weizen',
    'item.carrot': 'die Karotten',
    'item.beetroot': 'die Rüben',
    'item.sweet_berries': 'die Süßbeeren',
    'item.melon_slice': 'die Melonenscheiben',
    'item.pumpkin': 'die Kürbisse',
    'item.nether_wart': 'den Netherwarzen',
    'kind.crop': 'die Feldfrüchte',
    'kind.log': 'Holz',
    'kind.stone': 'Stein',
    'kind.ore': 'Erz',
    'kind.fish': 'Fisch',
    'kind.animal': 'die Tiere',
    'kind.wool': 'Wolle',
    'kind.milk': 'Milch',
    'kind.honey': 'Honig',
    'kind.goods': 'das Gesammelte',
  }),
});

export function isSupportedLang (value) {
  return LANGS.includes(String(value ?? '').trim().toLowerCase());
}

// `CHAT_LANG=EN`, `CHAT_LANG=en-US`, `chat_lang=De` all resolve to a supported
// code. Anything else is not a language mistake to crash on: it falls back to
// `fallback` (the default language) and the caller can log `supported: false`.
export function normalizeLang (value, { fallback = DEFAULT_LANG } = {}) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  // `en-US` / `pt-BR`: the region is not used by the catalogue.
  const base = raw.split(/[-_]/)[0];
  if (LANGS.includes(base)) return base;
  if (LANGS.includes(raw)) return raw;
  return fallback;
}

// Resolve `CHAT_LANG` once, at startup. `requested` is what the owner wrote,
// `lang` is what the catalogue will actually use, `supported` says whether the
// two differ (a typo is worth a log line, not a crash).
export function chatLangConfig (env = {}, { fallback = DEFAULT_LANG, varName = 'CHAT_LANG' } = {}) {
  const requested = env?.[varName];
  const configured = String(requested ?? '').trim();
  // `en-US`/`DE` sono accettate: conta il codice base, la regione la ignora il
  // catalogo. Solo una lingua davvero assente ripiega sul default.
  const base = configured.toLowerCase().split(/[-_]/)[0];
  const supported = LANGS.includes(base);
  return {
    lang: supported ? base : fallback,
    fallback,
    varName,
    requested: configured || null,
    configured: Boolean(configured) && supported,
    supported,
  };
}

// The human-readable name of a language: `native` gives the name a speaker
// would use in that language ("italiano"), the default the English name
// ("Italian") for prompts.
export function languageName (lang, { native = false } = {}) {
  const code = normalizeLang(lang);
  return (native ? LANG_NATIVE_NAMES : LANG_NAMES)[code];
}

// Look up a message and fill `{placeholders}`. A key missing in the requested
// language falls back to the default language, and a key missing everywhere
// renders as the key itself: a visible bug, never a silent empty line.
export function t (lang, key, vars = null, { fallback = DEFAULT_LANG } = {}) {
  const code = normalizeLang(lang, { fallback });
  const text = MESSAGES[code]?.[key] ?? MESSAGES[normalizeLang(fallback)]?.[key] ?? String(key ?? '');
  // `vars` assente = si vuole il *template* (gli argomenti arrivano dopo, a
  // `renderReply`/`renderGreeting`): interpolare qui con un oggetto vuoto
  // cancellerebbe i segnaposto e il messaggio uscirebbe vuoto.
  return vars ? interpolate(text, vars) : text;
}

export function hasMessage (lang, key) {
  if (!isSupportedLang(lang)) return false;
  return MESSAGES[normalizeLang(lang)]?.[key] != null;
}

// Every key of the default catalogue: the tests use it to prove the five
// languages cover the same ground.
export function messageKeys (lang = DEFAULT_LANG) {
  return Object.keys(MESSAGES[normalizeLang(lang)] ?? {}).sort();
}

// "a, b e c" / "a, b and c" / "a, b y c": the conjunction belongs to the
// language too, and it is used for the facts (inventory, armor, health).
export function listAnd (items, lang = DEFAULT_LANG) {
  const list = (Array.isArray(items) ? items : [items]).map(item => String(item ?? '')).filter(Boolean);
  if (list.length <= 1) return list.join('');
  const and = t(lang, 'list_and');
  return `${list.slice(0, -1).join(', ')}${and}${list.at(-1)}`;
}

// Un segnaposto senza valore resta visibile: un template incompleto e' un bug
// che si vede subito, non una frase muta a meta'.
function interpolate (text, vars = {}) {
  return String(text ?? '').replace(/\{(\w+)\}/g, (match, key) => {
    const value = vars?.[key];
    return value == null ? match : String(value);
  });
}
