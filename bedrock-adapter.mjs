// BedrockAdapter: sostituisce il layer Mineflayer+flying-squid per Minecraft Bedrock Edition.
// Implementa la stessa interfaccia semantica del vecchio harness:
//   observe(), getAvailableActions(), executeAction(), connect(), disconnect()
// Il controller Hermes/Jev non deve sapere che siamo su Bedrock.
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { RememberedResourceSites, naturalGatherCandidates } from './remembered-resource-sites.mjs';
import { ConstructionEngine } from './bedrock-construction.mjs';
import { stateSignature } from './construction.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { BedrockWorld } from './bedrock-world.mjs';
import { HIVE_BLOCKS, BEE_CRAFT_ITEMS, BEE_SCAN_RADIUS, BEE_SCAN_LIMIT, isBeeProtected, hiveVerdict, honeyLevel, beeFlower, beeFlowerCount } from './bedrock-bees.mjs';
import { trackNethernetClient, closeBedrockClient } from './bedrock-lifecycle.mjs';
import { tagCount, itemMatchesTag } from './survival/item-tags.mjs';
import { bestFood, isHostileType, isTraderType, isFarmAnimalType, isMilkableType, isTameableType, isRideTameableType, isCompanionType, isRideableType, animalFeed, tameFeed, cropForSeed, cropMaturity, seedForCrop, isCropBlock, mountCapacity, seatInfo, entityHeight, normalizeEntityType, estimatedTimeOfDay, isNightTime, timePhase, awayDirection, rotateDirection, PLANTABLE_ITEMS, FOODS, LAST_RESORT_FOODS, BUCKET_INGREDIENTS, SHIELD_INGREDIENTS, STARVING_FOOD } from './bedrock-survival.mjs';
// Missione «segui l'umano che si imbarca»: la decisione è pura, l'adapter
// raccoglie solo i fatti (link, flag `riding`, raggiungibilità).
import { MOUNT_FOLLOW_STATES, MOUNT_JOIN_ATTEMPTS, mountFollowTransition } from './bedrock-mount-follow.mjs';
import { professionName, normalizeProfession, professionMatches, pickBestTrade } from './bedrock-trading.mjs';
import { isWaterBlock, fishCount, fishItems, shoreCandidates, nextBiteDelay, bobberVerdict, FISHING_ROD_INGREDIENTS, CAST_RANGE } from './bedrock-fishing.mjs';
import { VALUABLE_ORE_NAMES, oreValue } from './ore-value.mjs';
// Il vocabolario degli oggetti nominati in chat ("diamanti" -> `diamond`) vive
// in `human-questions.mjs`, con i pattern di tutte e cinque le lingue: l'ordine
// umano "cattura <oggetto>" deve filtrare i drop con lo stesso vocabolario con
// cui il controller ha capito l'ordine.
import { matchesItemToken } from './human-questions.mjs';
import { detectStructures } from './structures.mjs';
// Il censimento del sito è una funzione pura (`village-survey.mjs`): l'adapter
// raccoglie i fatti (celle, letti, contenitori, entità) e non decide nulla.
import { surveyVillage, villageCensusNames, villageSweepConfig, VILLAGE_SURVEY_RADIUS, VILLAGE_PLOT_MIN_CELLS } from './village-survey.mjs';
// V1 — la passata riusa il planner d'esplorazione ancorato (`planExplorationSweep`)
// invece di avere una geometria propria: il piano è funzione di
// `(anchor, visited, config)`, quindi la stessa area dà sempre la stessa spirale.
import { planExplorationSweep, chunkKey } from './exploration.mjs';
import { planStorageSearch, STORAGE_RUNG, STORAGE_STEP } from './storage-ladder.mjs';
import { storageBlockNames, isStorageBlock } from './storage-blocks.mjs';
import { summarizeFluids, fluidCells, fluidHazard, fluidKind, rankEscapeCells, digFluidRisk, swimInputFlags, deepWaterColumns, DEFAULT_FLUID_RADIUS, DEFAULT_FLUID_LIMIT, LAVA_CONTACT_RANGE } from './bedrock-fluids.mjs';
import { AirMeter, MAX_AIR, airSeconds } from './bedrock-air.mjs';
import { normalizeEffectName, waterBreathingSources, divePlan, underwaterWork, CONDUIT_BLOCK, CONDUIT_RANGE } from './bedrock-dive.mjs';
import { findWaterfalls, findBubbleColumns, columnTactic, summarizeColumn, withinColumn } from './bedrock-waterfall.mjs';
import { deathVerdict, lostDrops, safeShorePlan, fireResistance, lavaGap, lavaCrossingGate, LAVA_CROSS_GAP_LIMIT } from './bedrock-lava.mjs';
import { bucketSourceVerdict, placeBucketVerdict, bucketDelta, boatVerdict, brewPlan, isBoatItem, BUCKET_ITEM, WATER_BUCKET_ITEM, LAVA_BUCKET_ITEM, MILK_BUCKET_ITEM, POWDER_SNOW_BUCKET_ITEM, GLASS_BOTTLE_ITEM, WATER_BOTTLE_ITEM, BOAT_INGREDIENTS, BREW_FUEL, BREW_BASE, BREW_EFFECTS } from './bedrock-bucket.mjs';
import { loadCircuits, planCircuit, circuitSiteBlocked, circuitSafety, forbiddenBlock, checkCircuitSuccess, circuitAnchor, expectedDelayTicks, measureCircuitDelay, TICK_MS, MAX_CIRCUIT_STEPS, MAX_CIRCUIT_COMPONENTS, MIN_CLOCK_TICKS } from './circuits.mjs';
import { REDSTONE_ORES, REDSTONE_COMPONENTS, REDSTONE_HAZARDS, REDSTONE_SCAN_RADIUS, REDSTONE_SCAN_LIMIT, blockProperties, redstoneView, isRedstoneComponent, isRedstoneOre, isRedstoneInput, inputOn, componentAt, activeOutputs, summarizeRedstone, isRepeater, facingOf, facingMatches, normalizeFacing, repeaterDelay, PLACEMENT_YAW_STEPS } from './bedrock-redstone.mjs';
import { isFireBlock, summarizePortals, summarizeHazards, projectileIncoming, gazedAtEnderman, netherHazard, isProjectileType, isEndermanType, waterEvaporates, bedsExplode, isNetherDimension, isEndDimension, isNetherLike, landingHazard, maxFallDepth, isFlammableBlock, pickHubBlock, shellCells, netherHubPlan, DEFAULT_NETHER_RADIUS, DEFAULT_NETHER_LIMIT, planPortalFrame, checkPortalFrame, portalSiteBlocked, portalFrameCandidates, projectileVelocity, dodgeCandidates, breaksLine, isPiglinType, goldArmorWorn, piglinNeutral, barterTarget, isBarterReward, BARTER_INGOT, BARTER_RANGE, PORTAL_BLOCK, PORTAL_FRAME_BLOCK, PORTAL_IGNITER, PORTAL_FRAME_NEEDS_FULL, PORTAL_FRAME_NEEDS_MINIMAL, portalBlockName, endermanAimPoint, isPumpkinMask, pumpkinMaskWorn, isEnderPearl, ENDERMAN_GAZE_TOLERANCE_DEG, isBlazeType, coverCandidates, blazeTactics, blazeRodProgress, BLAZE_RANGE, BLAZE_RETREAT_HEALTH, BLAZE_ROD, COVER_RADIUS } from './bedrock-nether.mjs';
import { END_DIMENSION, END_PORTAL, END_PORTAL_FRAME, EYE_OF_ENDER, BLAZE_POWDER, BLAZE_ROD_ITEM, ENDER_EYE_FRAME_TOTAL, STRONGHOLD_RADIUS, EYE_READINGS_MAX, POWDER_PER_ROD, isEyeSignalType, frameHasEye, frameStatus, eyeCraftPlan, eyeReading, triangulateStronghold, bossVerdict, endSummary } from './bedrock-end.mjs';
import { VIBRATION_RADIUS, SHRIEK_WINDOW_MS, SNEAK_SPEED_FACTOR, SCULK_FAMILY, SCULK_SENSORS, SCULK_SHRIEKERS, isSculkFamily, sensorPhase, shriekerState, vibrationRisk, shriekerVerdict, wardenWarning, classifySneakSpeed, summarizeSculk, stealthCellCost, planStealthRoute, summarizeStealthPlan } from './bedrock-vibration.mjs';
const require = createRequire(import.meta.url);
const bedrock = require('bedrock-protocol');
const { NethernetClient } = require('bedrock-protocol/src/nethernet');

const HOST = process.env.BEDROCK_HOST || '127.0.0.1';
const PORT = +(process.env.BEDROCK_PORT || 19132);
const USERNAME = process.env.BEDROCK_USERNAME || 'hermes-bot';
const AUTH_TITLE_NAME = process.env.BEDROCK_AUTH_TITLE || 'MinecraftNintendoSwitch';
const PROFILES_DIR = process.env.BEDROCK_PROFILES_DIR || undefined;
const VERSION = process.env.BEDROCK_VERSION || '1.26.51'; // 3.60.1 supporta fino a 1.26.51; BDS 1.26.52 usa protocollo 2193
const CONNECT_TIMEOUT = +(process.env.BEDROCK_CONNECT_TIMEOUT || 30000);

// Movimento: il client Bedrock riporta posizione simulata e intento in ogni
// player_auth_input; il tick deve restare nella finestra di rewind del server.
const EYE_HEIGHT = 1.62;        // gli occhi stanno 1,62 sopra i piedi
const WALK_SPEED = 0.2158;      // blocchi per tick (4,317 m/s / 20 tick)
// In acqua bassa il server muove il giocatore più lentamente: la fisica locale
// cammina piano per non farsi correggere dal server (rubber-band) a ogni tick.
const WADE_SPEED_FACTOR = +(process.env.WADE_SPEED_FACTOR || 0.5);
// Il commercio si apre solo a distanza di braccio: a 4.3 blocchi il server non
// apre la finestra (live 04/10/2026, `trade_not_opened` con mano vuota e niente
// sneak, mentre un umano attaccato al villager commercia senza problemi).
const MINE_REACH = 5.1;          // portata di scavo misurata dagli occhi (l'unico numero: opzioni ed esecutore)
const MINE_APPROACH_RANGE = 2.5; // quanto vicino deve esistere una cella raggiungibile perché valga la pena avvicinarsi
const TRADE_APPROACH_RANGE = 2.5;
const GRAVITY = 0.08;           // blocchi per tick^2
const JUMP_VELOCITY = 0.42;     // impulso verticale di un salto
const MAX_SIM_STEPS = 8;        // tick di fisica massimi per singolo invio
const PLAYER_HALF_WIDTH = 0.3;
const PLAYER_HEIGHT = 1.8;
const PATH_MAX_NODES = 5000;    // tetti di ricerca A*
// M13 (08/10/2026): il server parla anche fuori dalla chat (`raw`, `system`,
// `translation`). Il motivo di un rifiuto — «altri N giocatori devono dormire» —
// viaggia lì: buttarlo via lasciava `sleep_rejected` senza spiegazione (ore di
// diagnosi il 08/10/2026 alla ricerca di mostri e letti occupati che non c'erano).
// Si conservano gli ultimi testi non-chat per la diagnosi; il canale degli
// *ordini* resta la chat, e quei testi non entrano mai nell'inbox.
const SERVER_TEXT_MAX = +(process.env.SERVER_TEXT_MAX || 12);
const SERVER_TEXT_LENGTH = 160;
// Quanti letti prova `_sleepInBed` e quanto tempo complessivo può spendere: il
// tetto per tentativo esisteva già, quello complessivo no, quindi "tutti i letti"
// poteva diventare un'azione più lunga del timeout dell'harness.
const SLEEP_MAX_BEDS = +(process.env.SLEEP_MAX_BEDS || 8);
const SLEEP_MAX_TOTAL_MS = +(process.env.SLEEP_MAX_TOTAL_MS || 150000);
const SLEEP_MIN_ATTEMPT_MS = +(process.env.SLEEP_MIN_ATTEMPT_MS || 2500);
// Quante *posizioni* di appoggio si provano per lo stesso letto e quanto vale un
// ripiego. Il primo cammino ha il budget pieno del tentativo; i successivi sono
// brevi, perché un appoggio che si incastra lo fa in pochi secondi (una porta che
// non si apre) e il budget totale resta quello di `_sleepInBed`. L'08/10/2026 il
// letto "irraggiungibile" aveva una seconda cella buona dall'altro lato: non
// veniva mai tentata, perché si camminava solo verso il cammino più corto.
const SLEEP_SPOT_MAX = +(process.env.SLEEP_SPOT_MAX || 4);
const SLEEP_SPOT_RETRY_MS = +(process.env.SLEEP_SPOT_RETRY_MS || 8000);
// Le parole con cui il server dice che il sonno è *accettato* ma la notte non
// può saltare (requisito multiplayer `playersSleepingPercentage`). Il BDS è
// localizzato: si cercano più lingue, e in ogni caso il testo grezzo resta nel
// registro. Un falso positivo cambia solo l'etichetta dell'esito, mai l'azione.
const SLEEP_PENDING_PATTERNS = [
  /players? need to sleep/i, /need to sleep/i, /must sleep/i, /more players/i,
  /devono dormire/i, /deve dormire/i, /giocator\w*[^.]{0,24}dorm/i,
  /doivent dormir/i, /joueurs?[^.]{0,24}dorm/i,
  /m[üu]ssen schlafen/i, /spieler[^.]{0,24}schlaf/i,
  /deben dormir/i, /jugadores?[^.]{0,24}dorm/i,
];
// Le chiavi con cui il BDS dice *perché* ha rifiutato un letto: stesso metodo dei
// pattern qui sopra, ma qui il vocabolario è chiuso e la frase è un fatto, non
// un'ipotesi. Il 08/10/2026 il vivo ha mostrato `tile.bed.noSleep` a 12674 tick
// (nostro `dusk`) e il letto successivo accettato ~4 s dopo: il server stava
// dicendo «non è ancora ora per me», mentre l'ipotesi in coda all'errore accusava
// in blocco letto, mostri e orologio. Una chiave sconosciuta non produce alcun
// verdetto: resta `sleep_rejected`.
const SLEEP_REFUSAL_KEYS = [
  {
    pattern: /tile\.bed\.noSleep/i,
    error: 'sleep_not_allowed',
    hint: 'the server refused the bed because its own clock is not night yet: the world clock we extrapolate opened the sleep window before the server did',
  },
  {
    pattern: /tile\.bed\.notValid/i,
    error: 'sleep_bed_missing',
    hint: 'the server refused the bed because on its side the bed is missing or obstructed',
  },
  {
    pattern: /tile\.bed\.occupied/i,
    error: 'sleep_bed_occupied',
    hint: 'the server refused the bed because another player is already sleeping in it',
  },
  {
    pattern: /tile\.bed\.notSafe/i,
    error: 'sleep_unsafe',
    hint: 'the server refused the bed because a monster is nearby',
  },
  {
    pattern: /tile\.bed\.tooFarAway/i,
    error: 'sleep_too_far',
    hint: 'the server refused the bed because the bot clicked from too far away',
  },
];
// R4: quanti cambi redstone tenere in traccia per misurare un ritardo.
const REDSTONE_TRACE_LIMIT = +(process.env.REDSTONE_TRACE_LIMIT || 32);
// R6: intervallo minimo fra due azionamenti dello stesso input. Serve a non
// costruire un clock "a mano" e a non tempestare il server di blocchi update.
const REDSTONE_TOGGLE_MIN_INTERVAL_MS = +(process.env.REDSTONE_TOGGLE_MIN_INTERVAL_MS || 500);
const MAX_CORRECTION_DRIFT = 0.75; // oltre questa distanza la correzione è autoritativa su X/Z
// BDS 1.26.52: se il respawn non si completa entro questo tempo, si riconnette
// (nuovo login = unico recovery noto dalla morte bloccata). Vedi _survivalTick.
const RESPAWN_RECONNECT_MS = +(process.env.RESPAWN_RECONNECT_MS || 25000);
// Un fendente che non muove la vita del bersaglio e' un fendente che il server
// non ha applicato: il runtime id e' stantio (l'entita' e' rinata con un id
// nuovo). Dopo N colpi muti `_combat` ri-risolve il bersaglio invece di
// continuare a colpire un fantasma (live demo-r2 del 06/10: 25 colpi su
// `runtimeId 50` mentre l'`entity_add` diceva 508, vita ferma a 12).
const ATTACK_SILENT_HITS = +(process.env.ATTACK_SILENT_HITS || 3);
// Rinfrescare lo specchio degli slot riconnettendosi è l'ultima spiaggia: il
// BDS che non ha ancora rilasciato la sessione NetherNet risponde
// `connecterror:9` (= `ErrorCode.InactivityTimeout` della negoziazione,
// nethernet/src/signalling.js:18) e ogni tentativo in più peggiora la
// situazione (live demo-r2: `[connect] attempt 5/6/8 failed` fino al restart
// del container). Prima si chiede l'inventario alla finestra del giocatore,
// che non tocca la sessione; fra disconnect e connect si lascia al server il
// tempo di rilasciare; e due riconnessioni ravvicinate si rifiutano.
const INVENTORY_RESYNC_SETTLE_MS = +(process.env.INVENTORY_RESYNC_SETTLE_MS || 1500);
const INVENTORY_RESYNC_COOLDOWN_MS = +(process.env.INVENTORY_RESYNC_COOLDOWN_MS || 30000);
const INVENTORY_REFRESH_TIMEOUT_MS = +(process.env.INVENTORY_REFRESH_TIMEOUT_MS || 4000);
// Velocità degli utensili per materiale (vanilla, secondi-blocco/tick): il
// registry Bedrock usa id diversi da quelli di rete, quindi la corrispondenza
// utensile/materiale va dedotta dal nome.
const TOOL_TIER_SPEED = { wooden: 2, golden: 12, stone: 4, copper: 6, iron: 6, diamond: 8, netherite: 9 };
const TOOL_MATERIAL = { 'mineable/pickaxe': 'pickaxe', 'mineable/axe': 'axe', 'mineable/shovel': 'shovel', 'mineable/hoe': 'hoe' };
// Livello di raccolta per utensile (per i drop serve il tier giusto).
const TOOL_HARVEST_RANK = { wooden: 1, golden: 1, stone: 2, copper: 2, iron: 3, diamond: 4, netherite: 5 };
// Chiavi di harvestTools nel data Bedrock (id del data, non network id). Mappate
// per rango confrontando gli insiemi di stone/iron/gold ore nel registry 1.26.
const HARVEST_TOOL_RANK = { 941: 1, 956: 1, 946: 2, 951: 2, 961: 3, 966: 4, 971: 5 };
// Blocchi funzionali o costruiti che dig_down non deve mai scavare per errore
// (tavoli, contenitori, stazioni): il passo verrebbe rifiutato invece che distruggerli.
const DIG_PROTECTED = /(_table$|chest$|furnace$|smoker$|barrel$|shulker_box$|hopper$|anvil$|brewing_stand$|beacon$|loom$|stonecutter$|grindstone$|lectern$|composter$|cauldron$|bell$|(^|_)bed$|_sign$|_banner$|_skull$|_head$|flower_pot$|_pot$|respawn_anchor$|torch$|lantern$|_planks$|_slab$|_stairs$|_wool$|glass$|bricks$|_concrete$|terracotta$|carpet$|farmland$|_fence$|_fence_gate$|wheat$|carrots$|potatoes$|beetroot$|melon_stem$|pumpkin_stem$|sweet_berry_bush$|nether_wart$|redstone_wire$|redstone_block$|lever$|_button$|pressure_plate$|_repeater$|_comparator$|observer$|piston$|dispenser$|dropper$|lamp$|daylight_detector$|tripwire_hook$|tripwire$|target$|crafter$|sculk$|sculk_vein$|sculk_catalyst$|sculk_sensor$|sculk_shrieker$|command_block$|structure_block$|structure_void$|jigsaw$|barrier$|bedrock$|end_crystal$|fire$|soul_fire$|beehive$|bee_nest$|campfire$)/;
// Redstone (R0): un circuito non è un ostacolo da scavare ma un impianto della
// base. I minerali di redstone restano **fuori** da DIG_PROTECTED (si estraggono
// con `mine_redstone_ore`), i componenti no.
const REDSTONE_RESCAN_MS = +(process.env.REDSTONE_RESCAN_MS || 5000);
// Deep Dark (W0 di docs/raw/DEEP_DARK_ROADMAP.md): il censimento di sensori e
// shrieker è throttled come quello della redstone. In `DIG_PROTECTED` la
// famiglia sculk è completa: scavare *qualsiasi* blocco sculk è già una
// vibrazione, non solo rompere il sensore.
const SCULK_RESCAN_MS = +(process.env.SCULK_RESCAN_MS || 5000);
const SCULK_SCAN_RADIUS = 48;
const SCULK_SCAN_LIMIT = 24;
const REDSTONE_NEARBY_NAMES = [...new Set([...REDSTONE_ORES, ...REDSTONE_COMPONENTS, ...REDSTONE_HAZARDS])];
// Il nome dell'item non è sempre il nome del blocco: la polvere di redstone si
// piazza come `redstone_wire`.
const REDSTONE_ITEM_BLOCKS = { redstone: 'redstone_wire' };
// Bit dei MetadataFlags (key 0) delle entità: servono per baby/tempted/inlove
// degli animali e per il flag resting del bot stesso.
// Bit dei MetadataFlags1 (protocol.json, bedrock 1.26.51): l'ordine esatto è
// onfire..inlove, saddled(8), powered(9), ignited(10), baby(11), ..., resting(23),
// tamed(28), sheared(31).
const METADATA_FLAG_BITS = { onfire: 0, sneaking: 1, riding: 2, sprinting: 3, action: 4, invisible: 5, tempted: 6, inlove: 7, saddled: 8, powered: 9, ignited: 10, baby: 11, resting: 23, sitting: 24, angry: 25, tamed: 28, orphaned: 29, leashed: 30, sheared: 31 };
// MetadataFlags2 (key 92): bit per `trusting` (ocelot) e simili.
const METADATA_FLAGS2_BITS = { sneezing: 0, trusting: 1 };
// Fornace: slot del container Bedrock e priorità dei combustibili (fusione).
const FURNACE_SLOTS = { ingredient: 0, fuel: 1, output: 2 };
const FURNACE_BY_CONTAINER = {
  furnace_ingredient: 'ingredient', blast_furnace_ingredient: 'ingredient', smoker_ingredient: 'ingredient',
  furnace_fuel: 'fuel', furnace_output: 'output',
};
// Stazioni di fusione: tipo di blocco → container dell'ingrediente e window_type.
const SMELT_STATIONS = {
  furnace: { ingredient: 'furnace_ingredient', window: 'furnace' },
  blast_furnace: { ingredient: 'blast_furnace_ingredient', window: 'blast_furnace' },
  smoker: { ingredient: 'smoker_ingredient', window: 'smoker' },
};
// Il protocollo 1.26 non manda le furnace_recipes nel crafting_data: la mappa
// statica copre la progressione (minerali e cibi comuni). Le ricette del
// pacchetto, se un giorno arrivassero, hanno priorità.
const SMELT_RECIPES = {
  raw_iron: 'iron_ingot',
  raw_copper: 'copper_ingot',
  raw_gold: 'gold_ingot',
  iron_ore: 'iron_ingot',
  copper_ore: 'copper_ingot',
  gold_ore: 'gold_ingot',
  sand: 'glass',
  cobblestone: 'stone',
  potato: 'baked_potato',
  beef: 'cooked_beef',
  chicken: 'cooked_chicken',
  porkchop: 'cooked_porkchop',
  mutton: 'cooked_mutton',
  cod: 'cooked_cod',
  salmon: 'cooked_salmon',
  oak_log: 'charcoal',
  spruce_log: 'charcoal',
  birch_log: 'charcoal',
  jungle_log: 'charcoal',
  acacia_log: 'charcoal',
  dark_oak_log: 'charcoal',
  mangrove_log: 'charcoal',
  cherry_log: 'charcoal',
  pale_oak_log: 'charcoal',
};
// Contenitori di stoccaggio: bauli, bauli-trappola, botti e shulker (opzionale).
// La window_type Bedrock per baule/botte è 'container'; lo slot nelle richieste
// stack usa ContainerSlotType 7 ('container') per i bauli e 58 ('barrel') per le botti.
// L'elenco *non* è una whitelist scritta qui: vive in `storage-blocks.mjs`, che
// conosce la famiglia degli shulker tinti (una lista di nomi esatti li rendeva
// invisibili al censimento) e resta estendibile senza toccare la scoperta.
const STORAGE_BLOCKS = storageBlockNames();
// `world.findBlocks` si ferma a N blocchi per nome: con una parete di scrigni il
// sesto più vicino nascondeva gli altri (live 03/10: la cassa del ferro a
// (90,73,160) non compariva stando a due blocchi, e il take rispondeva
// `item_not_in_container` su una cache piena).
const STORAGE_SCAN_PER_NAME = 24;
// V1 — la *scoperta* di un contenitore ("qui c'è un baule", non "dentro c'è
// questo") è un fatto a sé: ha il suo throttle e il suo raggio. Vive dentro
// `_rememberDiscoveries()`, già throttled per chunk, e costa una lettura in
// memoria dei chunk caricati.
const STORAGE_DISCOVERY_RESCAN_MS = +(process.env.STORAGE_DISCOVERY_RESCAN_MS || 60000);
const STORAGE_DISCOVERY_RADIUS = +(process.env.STORAGE_DISCOVERY_RADIUS || 32);
// Le letture sono un'azione sola: si leggono i N più vicini, non tutti. Il
// limite tiene il costo dell'azione sotto il minuto: live 03/10 con 16
// contenitori la lettura è durata 142 s e il server ha chiuso la sessione
// (poi `connecterror:9` fino al restart del BDS).
const STORAGE_READ_LIMIT = 8;
// Ogni contenitore può costare i suoi tentativi (apertura + attesa del
// contenuto): un tetto di tempo rende l'azione prevedibile invece di sfiorare
// il timeout dell'harness.
const STORAGE_READ_BUDGET_MS = 90000;
// Il cammino verso un contenitore è la voce che pesa di più in una lettura: un
// blocco irraggiungibile costa il suo timeout intero. Nella lettura il budget è
// per-blocco più stretto (live 03/10: con 30 s per blocco una lettura ha toccato
// il watchdog dei 180 s e il BDS ha chiuso la sessione), mentre un `take_*`
// esplicito tiene il timeout generoso.
// Live 08/10/2026: 8 s non bastavano a coprire 1-2 blocchi in un villaggio con
// portici e animali, e la lettura non riusciva nemmeno a *vedere* i bauli. Il
// tetto per blocco sale a 30 s — il probe dal vivo ha poi mostrato tre cammini da
// 5,8-10,8 blocchi (21-23 nodi) scadere a 15 s *mentre avanzavano* — ma la somma
// resta chiusa dal budget della lettura (`_readContainers` passa `min(tetto,
// tempo rimasto)`), quindi il watchdog dei 180 s resta fuori portata.
const STORAGE_READ_WALK_MS = 30000;
// Un `take_*` su un contenitore *ricordato* può essere a venti e più blocchi: il
// cammino verso la cassa del raccolto a (92,73,165) è durato 31 s per 21 blocchi
// (live 04/10/2026, il bot è arrivato a tre blocchi dal baule quando il default di
// 30 s è scaduto) e il tentativo successivo è riuscito in 546 ms. Il budget resta
// dentro l'`HARNESS_ACTION_TIMEOUT_MS`, che è la rete di sicurezza dell'azione.
const STORAGE_TAKE_WALK_MS = 75000;
// Watchdog di progresso della camminata (07/10/2026): `_updateMotionState` chiude
// un movimento come `no_progress` quando la **distanza dal bersaglio** non scende
// di 25 cm per otto secondi di fila. Il rilevatore per-waypoint non bastava: un
// nuovo minimo di pochi centimetri verso il prossimo nodo azzera `lastProgressAt`,
// quindi il verdetto `stuck` non arrivava mai e un `take_*` da memoria è finito
// `movement timeout` dopo 75 s di budget avendo percorso 1,5 blocchi netti, a 6,8
// blocchi dal baule (live 07/10/2026, `runs/demo-r3/events.jsonl` riga 6918).
const MOVE_STALL_MS = 8000;
// TTL della cache contenitori: altri giocatori possono cambiare le scorte.
const CONTAINER_TTL_MS = 5 * 60 * 1000;
// V0 — il censimento del sito è un fatto da *sito*, non da istante: si legge una
// volta e si riusa. Celle bounded (un tetto per nome: un campo di grano da 300
// celle non deve mangiare il budget del censimento) e vista memoizzata, perché
// `observe()` la legge a ogni passo del controller.
const VILLAGE_RESCAN_MS = +(process.env.VILLAGE_RESCAN_MS || 60000);
const VILLAGE_CELL_CAP = +(process.env.VILLAGE_CELL_CAP || 64);
// Sotto questa soglia un grappolo di colture non è un appezzamento: il default
// vive nel modulo puro (`village-survey.mjs`), così la regola e chi la applica
// non possono divergere.
const VILLAGE_PLOT_MIN = +(process.env.VILLAGE_PLOT_MIN_CELLS || VILLAGE_PLOT_MIN_CELLS);
// V1 — i tre limiti della passata, indipendenti: il primo raggiunto vince.
//   * VILLAGE_SURVEY_MS    = cooldown fra due passate (non un tetto a una passata);
//   * VILLAGE_SURVEY_CELLS = budget di *esplorazione*: quante celle la passata può
//     censire in totale prima di dichiararsi troncata;
//   * VILLAGE_SURVEY_MAX_MS = budget di *esecuzione*: quanto a lungo può camminare.
// Un rifiuto (`village_too_far`, `survey_cooldown`) non è un troncamento: dice che
// la missione non è partita. Il troncamento dice che il censimento è incompleto.
const VILLAGE_SURVEY_MS = +(process.env.VILLAGE_SURVEY_MS || 600000);
const VILLAGE_SURVEY_CELLS = +(process.env.VILLAGE_SURVEY_CELLS || 4096);
const VILLAGE_SURVEY_MAX_MS = +(process.env.VILLAGE_SURVEY_MAX_MS || 120000);
// Oltre questa distanza la passata si rifiuta: raggiungere il sito è un viaggio,
// non una ricognizione, e chi chiama deve deciderlo esplicitamente.
const VILLAGE_SURVEY_MAX_DISTANCE = +(process.env.VILLAGE_SURVEY_MAX_DISTANCE || 256);
// Raggio entro cui un record di censimento appartiene *a questo* sito: due
// villaggi a poche decine di blocchi non si scambiano le celle censite.
const VILLAGE_MEMORY_RADIUS = 8;
// M3c — cosa non finisce mai nello scrigno: gli strumenti e l'equipaggiamento con
// cui il bot lavora, torce e stazioni portatili, le sementi, e una riserva di
// cibo. `_depositableItems()` è la politica unica, letta sia da `dump_inventory`
// sia da `observe().deposit`, così il controller non duplica l'elenco.
const DEPOSIT_KEEP_PATTERNS = [
  /(_pickaxe|_axe|_shovel|_hoe|_sword|_helmet|_chestplate|_leggings|_boots)$/,
  /^(shield|bow|crossbow|trident|arrow|spectral_arrow|fishing_rod|shears|flint_and_steel|fire_charge|lead|name_tag|spyglass|clock|compass)$/,
  /_bucket$/,
  /_seeds$|^(torchflower_seeds|pitcher_pod)$/,
  /^(torch|soul_torch|lantern|soul_lantern|campfire|crafting_table|furnace|blast_furnace|smoker|anvil|stonecutter|grindstone|loom|composter)$/,
  /_bed$/,
];
// Quanto resta in zaino di un item «da tenere» (cibo, torce, sementi): il
// surplus è raccolto e va in baule lo stesso.
const DEPOSIT_KEEP_RESERVE = 16;
// Quanti stack una singola `dump_inventory` sposta: il tetto tiene l'azione
// dentro il timeout e lascia al controller la possibilità di ripeterla.
const DEPOSIT_MAX_STACKS = 8;
const DEPOSIT_FOOD_ITEMS = new Set([...FOODS, ...LAST_RESORT_FOODS]);
// Kit di partenza di una spedizione in grotta. I numeri stanno qui e la skill
// `prep_cave_trip` dichiara gli stessi: un test li tiene allineati. Serve perché
// il 06/10/2026 in chat il bot promise «porterei letto, torce e piccone di
// riserva» mentre in zaino non c'era niente di tutto ciò: una promessa va
// verificata sullo stato, non ripetuta a memoria.
const TRIP_KIT_REQUIREMENTS = Object.freeze({ beds: 1, torches: 8, pickaxes: 2, food: 1 });
// Scorta a piedi (ordine umano «guidami/accompagnami»): il bot *guida* un umano
// verso una destinazione, invece di seguirlo. Oltre `ESCORT_MAX_GAP` blocchi di
// distacco si ferma e aspetta; riparte quando l'umano rientra in
// `ESCORT_RESUME_GAP`, chiude con `escort_left_behind` se non torna entro
// `ESCORT_WAIT_MS`, con `escort_lost` se sparisce per `ESCORT_LOST_MS` e con
// `escort_timeout` oltre il tetto dell'azione. I numeri sono dichiarati in
// `observe().escort.limits`: il controller non li indovina, e la scorta non
// resta appesa in silenzio (live 04/10/2026: un follow immobile dichiarava
// `ok: true` per tre minuti).
const ESCORT_MAX_GAP = +(process.env.ESCORT_MAX_GAP || 12);
const ESCORT_RESUME_GAP = +(process.env.ESCORT_RESUME_GAP || 5);
const ESCORT_WAIT_MS = +(process.env.ESCORT_WAIT_MS || 60000);
const ESCORT_LOST_MS = +(process.env.ESCORT_LOST_MS || 20000);
const ESCORT_TIMEOUT_MS = +(process.env.ESCORT_TIMEOUT_MS || 150000);
const ESCORT_ARRIVE_DISTANCE = +(process.env.ESCORT_ARRIVE_DISTANCE || 2);
export { TRIP_KIT_REQUIREMENTS, ESCORT_MAX_GAP, ESCORT_RESUME_GAP, ESCORT_WAIT_MS, ESCORT_LOST_MS, ESCORT_TIMEOUT_MS, ESCORT_ARRIVE_DISTANCE, isUseItemName };
// TTL del «non si è aperto adesso»: un contenitore che non si apre costa fino a ~18 s
// di tentativi (live 04/10/2026: la cassa ricordata a (93,72,160) non esiste più — in
// quel punto il mondo ha il baule un blocco più in alto — e `take_egg` finiva in
// `container_open_timeout`). Fallito, esce dalle opzioni per un po' invece di essere
// riproposto a ogni passo; resta in memoria e torna offribile da solo.
const STORAGE_OPEN_FAILURE_MS = 10 * 60 * 1000;

// Quando non si apre piu' **nessuna** finestra, il colpevole non e' il singolo
// baule: il server ha smesso di rispondere alle aperture per quel giocatore.
// Live 09-10/10/2026 (run `diamond-20261010-1`): dopo un `place` rifiutato con
// status 50 (`FailedToValidateDstSlot`) l'inventario rimandava
// `inventory_content` ogni ~700 ms ma nessuna finestra si apriva piu' — non il
// baule, non l'inventario porta-scudo, non dopo un reconnect del client, non
// dopo un riavvio del processo harness: da li' in poi ogni `take_*`/`equip_*`
// costava i suoi 3 s di timeout e la spedizione non usciva piu' dalla base.
// Contate le aperture fallite di fila (azzerate dalla prima che riesce) la
// sessione si dichiara **bloccata** con un errore tipizzato invece di bruciare
// il budget di ogni contenitore: il rimedio e' riavviare il server Bedrock.
const CONTAINER_OPEN_LOCK_FAILURES = +(process.env.CONTAINER_OPEN_LOCK_FAILURES || 3);

// Oggetti il cui click su un blocco è *usa l'oggetto*, non «apri/interagisci»:
// con uno di questi in mano il contenitore non si apre mai e il click non
// produce nessun errore — solo il silenzio di `container_open_timeout`.
// Live 08-09/10/2026, spedizione diamanti: quaranta aperture fallite su quaranta
// con `held: "egg"` e due letture riuscite su due appena la mano ha tenuto
// qualcos'altro (il bot raccoglie le uova deposte nel villaggio, quindi la pila
// in mano non si svuota da sola).
const USE_ITEM_NAMES = new Set([
  'egg', 'snowball', 'ender_pearl', 'experience_bottle',
  'splash_potion', 'lingering_potion', 'potion',
  'bow', 'crossbow', 'trident', 'fishing_rod', 'spyglass', 'goat_horn',
  'flint_and_steel', 'fire_charge', 'wind_charge', 'bucket',
]);
const USE_ITEM_SUFFIXES = ['_bucket', '_boat', '_raft', '_minecart', '_spawn_egg', '_charge'];
const isUseItemName = name => {
  if (!name) return false;
  if (USE_ITEM_NAMES.has(name)) return true;
  return USE_ITEM_SUFFIXES.some(suffix => name.endsWith(suffix));
};
const DISCOVERY_RESCAN_MS = 15000;   // ri-scansione scoperte nella stessa chunk (mondo appena caricato)
// Ricognizione di strutture/ambienti (spec esplorazione M5/M6): una passata
// sull'area caricata non è gratis, quindi si ripete al massimo ogni minuto.
const STRUCTURE_RESCAN_MS = +(process.env.STRUCTURE_RESCAN_MS || 60000);
const STRUCTURE_RADIUS = +(process.env.STRUCTURE_RADIUS || 48);
const STRUCTURE_SURVEY_LIMIT = +(process.env.STRUCTURE_SURVEY_LIMIT || 20000);
// Fluidi (M0 di docs/wiki/fluids.md): il censimento di acqua/lava nell'area caricata
// ha lo stesso costo di una ricognizione di strutture, quindi ha un TTL suo.
const FLUID_RESCAN_MS = +(process.env.FLUID_RESCAN_MS || 5000);
const FLUID_SCAN_RADIUS = +(process.env.FLUID_SCAN_RADIUS || DEFAULT_FLUID_RADIUS);
const FLUID_SCAN_LIMIT = +(process.env.FLUID_SCAN_LIMIT || DEFAULT_FLUID_LIMIT);
// Distanza oltre la quale la lava non è più un motivo per offrire `avoid_lava`.
const LAVA_AVOID_RANGE = +(process.env.LAVA_AVOID_RANGE || 8);
// Nether/End (N0 di docs/wiki/nether.md): portali, fuoco, magma e spawner sono
// un censimento a parte (TTL proprio), non righe di `nearby` che il controller
// paga a ogni osservazione.
const NETHER_RESCAN_MS = +(process.env.NETHER_RESCAN_MS || 10000);
const NETHER_SCAN_RADIUS = +(process.env.NETHER_SCAN_RADIUS || DEFAULT_NETHER_RADIUS);
const NETHER_SCAN_LIMIT = +(process.env.NETHER_SCAN_LIMIT || DEFAULT_NETHER_LIMIT);
// N4: bartering. Il piglin prende il lingotto e getta il pegno dopo qualche
// secondo: la finestra è il tempo che si concede al *drop* di comparire, non al
// pacchetto di partire.
const BARTER_WAIT_MS = +(process.env.BARTER_WAIT_MS || 15000);
// N1: azioni sul portale. Entrare in un portale è un movimento, non un
// teletrasporto: si cammina dentro la colonna e si aspetta che sia il server a
// cambiare dimensione (la conferma è `this.dimension`, mai una sensazione).
const PORTAL_APPROACH_RANGE = +(process.env.PORTAL_APPROACH_RANGE || 2.5);
const PORTAL_ENTER_TIMEOUT_MS = +(process.env.PORTAL_ENTER_TIMEOUT_MS || 15000);
const PORTAL_FRAME_RADIUS = +(process.env.PORTAL_FRAME_RADIUS || 6);
// Occasioni: raggio della scansione delle ore di valore. Deve combaciare con
// ORE_INTEREST_RANGE di world-events.mjs: tutto ciò che genera un evento
// VALUABLE_ORE_SEEN è anche un'opzione mine_<ore>.
const ORE_INTEREST_RANGE = 24;
const ORE_SCAN_TTL_MS = 5000;        // la percezione gira molte volte al secondo
const ORE_SCAN_MOVE_TOLERANCE = 8;   // ...e comunque non riusare una lista di 8 blocchi fa
// M11 — avviso in chat quando una vena *nuova* entra in vista (`ORE_ALERT`,
// default `diamond`; `off` lo spegne). Nato dalla richiesta dell'utente del
// 07/10/2026: «appena vedi un diamante comunicami la posizione», poi «seguimi e
// comunicami se vedi dei diamanti durante il cammino». Il testo non si compone
// qui: il renderer lo inietta chi possiede il catalogo (`oreAlertText`, 5 lingue),
// così l'adapter resta senza i18n e il messaggio resta traducibile.
// L'interruttore `off`/vuoto vive dentro `oreAlertCores`, che è anche quello che i
// test possono chiamare con un valore esplicito: qui non serve una seconda copia
// della stessa regola (era dichiarata e mai letta).
// Il nome può arrivare come `diamond`, `diamond_ore` o `deepslate_diamond_ore`:
// si confronta il nucleo (`oreCore`), così una voce copre tutte le varianti.
const ORE_ALERT_CORES = oreAlertCores();
const ORE_ALERT_RANGE = +(process.env.ORE_ALERT_RANGE || 32);
const ORE_ALERT_COOLDOWN_MS = +(process.env.ORE_ALERT_COOLDOWN_MS || 5000);
const ORE_ALERT_SPOT_RADIUS = 6;      // blocchi della *stessa* vena: un solo avviso
const ORE_ALERT_SEEN_MAX = 4000;      // tetto della memoria degli avvisi (FIFO)
// Nucleo del nome di una vena: `deepslate_diamond_ore` → `diamond`,
// `lapis_lazuli` → `lapis` (blocco e item non usano lo stesso nome).
function oreCore (name) {
  return String(name ?? '').toLowerCase().replace(/^deepslate_/, '').replace(/_ore$/, '').split('_')[0];
}

// Le vene da annunciare, lette da `ORE_ALERT` (`off`/vuoto = nessuna). Esportata
// perché l'interruttore si prova senza riavviare il processo.
export function oreAlertCores (setting = process.env.ORE_ALERT ?? 'diamond') {
  const value = String(setting ?? '').trim().toLowerCase();
  if (value === '' || /^(off|no|none|0|false)$/.test(value)) return new Set();
  return new Set(value.split(/[\s,]+/).filter(Boolean).map(oreCore));
}
const CHECKPOINT_MIN_DISTANCE = 48;   // checkpoint sparsi: ogni ~48 blocchi di viaggio
// Raggio entro cui alzare lo scudo ha senso (il blocco vale per gli attacchi
// che arrivano davanti al bot).
const SHIELD_THREAT_RANGE = +(process.env.SHIELD_THREAT_RANGE || 8);
// Indirizzo dell'offhand nelle `item_stack_request`. L'offhand non è lo slot 0
// del container `offhand` (34): la mappa ufficiale dello slot del giocatore
// mette l'offhand all'indice 45 e la conversione del POC di riferimento
// (mc-zuri/node-mineflayer, `lib/bedrock/item-stack-actions.mts`, citato
// nell'issue PrismarineJS/bedrock-protocol#685) lo indirizza come
// `{container_id: 'offhand', slot: 1}`. Con `0` il server risponde **50**, che
// nell'enum `ItemStackResponse.result` è `FailedToValidateDstSlot` — la
// destinazione non esiste; è il rifiuto osservato live il 03/10. L'armatura usa
// invece gli slot 0-3 (elmo 0 = indice giocatore 36), già corretta.
const OFFHAND_SLOT = 1;
// Un solo ripiego, bounded e documentato: se anche lo slot 1 viene rifiutato la
// risposta va riportata così com'è, senza scavare oltre a tentativi ciechi.
const OFFHAND_FALLBACK_SLOT = 0;
// M2: il conteggio della discesa vale per ogni lavoro sott'acqua (un blocco di
// scavo a mani nude). I conduit si censisono in cache: un blocco non si sposta.
const DIVE_WORK_SECONDS = +(process.env.DIVE_WORK_SECONDS || 3);
const CONDUIT_RESCAN_MS = +(process.env.CONDUIT_RESCAN_MS || 60000);

// Chat in uscita (M5): il bot scrive nel canale `chat` con un pacchetto `text`.
// Tetto di lunghezza e intervallo minimo per non floodare il server.
const CHAT_MAX_LENGTH = +(process.env.CHAT_MAX_LENGTH || 256);
const CHAT_MIN_INTERVAL_MS = +(process.env.CHAT_MIN_INTERVAL_MS || 1000);
// Il server rimanda al mittente anche i propri messaggi: se il bot sente se
// stesso può scambiare la propria voce per un ordine. Il nome di login non basta
// a riconoscerli (il server riscrive `source_name` con il gamertag reale, che
// può differire da `BEDROCK_USERNAME`), quindi si confronta il testo appena
// inviato entro questa finestra.
const CHAT_ECHO_WINDOW_MS = +(process.env.CHAT_ECHO_WINDOW_MS || 15000);
const CHAT_ECHO_MEMORY = 8;
// R2: quanto a lungo una domanda in attesa resta valida. È la stessa finestra con
// cui il controller scarta un ordine vecchio (`CHAT_MAX_AGE_MS`): una risposta
// arrivata dopo non sta più rispondendo a quella domanda, e una domanda senza
// risposta non deve accumularsi per sempre.
const CHAT_ASK_TTL_MS = +(process.env.CHAT_ASK_TTL_MS || 300000);
// La chiave di un mittente nella chat: gamertag (o xuid) senza differenze di
// maiuscole. È la stessa normalizzazione con cui il controller riconosce i
// mittenti autorizzati, così «Steve» e «steve» sono la stessa persona.
const chatKey = (value) => String(value ?? '').trim().toLowerCase();
// Raggio entro cui un giocatore umano è "percepito" (gli saluta e gli spiega
// come dare un ordine). Separato dal tracking entità (64 blocchi).
const HUMAN_RANGE = +(process.env.HUMAN_RANGE || 32);
// event_id di level_event che parlano di sonno (players_sleeping/sleeping_players):
// l'annuncio del server "qualcuno dorme", usato come conferma del sonno.
const SLEEP_LEVEL_EVENTS = new Set([9800, 9801]);
// Meteo: il server annuncia inizio/fine della pioggia e del temporale con i
// level_event 3001..3004 (`event` arriva già come nome dal mapper di
// bedrock-protocol, `event_id` come numero nei pacchetti generici). In vanilla
// un temporale implica la pioggia e la fine della pioggia chiude anche il
// temporale: i due flag si aggiornano insieme, così un evento perso non lascia
// il temporale acceso per sempre. La finestra di sonno diventa "notte oppure
// temporale, a qualunque ora" (https://minecraft.wiki/w/Bed).
const WEATHER_LEVEL_EVENTS = new Map([
  [3001, { rain: true }],
  ['start_rain', { rain: true }],
  [3002, { rain: true, thunder: true }],
  ['start_thunder', { rain: true, thunder: true }],
  [3003, { rain: false, thunder: false }],
  ['stop_rain', { rain: false, thunder: false }],
  [3004, { thunder: false }],
  ['stop_thunder', { thunder: false }],
]);
// Recupero dell'umano perso ("wolf recovery"): oltre questa distanza l'ultima
// posizione nota non e' piu' una traccia utile, e oltre questa eta' non lo e'
// nemmeno un ricordo vecchio (il mondo cambia: il giocatore quasi certamente
// non e' piu' la'). `seek_player` viene offerto solo dentro entrambi i limiti.
const SEEK_MAX_DISTANCE = +(process.env.SEEK_MAX_DISTANCE || 128);
const SEEK_MAX_AGE_MS = +(process.env.SEEK_MAX_AGE_MS || 600000);
// Respiro (M2): con la testa sott'acqua l'aria scende di un tick per tick e
// l'unica cura e' uscire dall'acqua. L'opzione `surface` compare con questo
// anticipo (150 tick = 7,5 s di aria) perche' raggiungere una riva costa tempo;
// la regola JSON `drowning` scatta a 60 tick (3 s) e in emergenza ammette
// l'intento `surface`, cosi' la scala di sopravvivenza ha un'azione da fare
// *prima* che i cuori scendano.
const SURFACE_AIR_ALERT = +(process.env.SURFACE_AIR_ALERT || 150);

// Il BDS firma i nomi con i codici di formattazione (`§r`, `§7`, …): in chat il
// gamertag arriva come `Nome§r`, nei pacchetti `add_player`/`player_list` invece
// pulito. Senza normalizzazione la stessa persona è due stringhe diverse, e ogni
// confronto esatto si rompe: l'allowlist del controller (`entry.from`), il lookup
// dell'entità da seguire (`_playerByName`) e il saluto per gamertag. Si toglie
// alla fonte, così chat, mappa dei nomi, entità e descrizioni delle opzioni
// portano sempre lo stesso nome.
function stripFormatting (text) {
  if (text == null) return null;
  return String(text).replace(/\u00a7./g, '').replace(/\u00a7/g, '').trim();
}

// M13: rende leggibile un pacchetto `text` che non è chat (raw/system/translation).
// Il BDS manda `needs_translation` con `message` = stringa di formato e
// `parameters` = sostituzioni: senza riempire i `%s` la frase resta un segnaposto
// inutile («%s more players need to sleep»), che è esattamente il testo che spiega
// perché la notte non salta. Esportata perché i test la provino senza un server.
//
// Il 08/10/2026 alle 20:52 la prima cattura viva ha mostrato che il BDS usa
// *due* forme: quella con `parameters` e quella — più frequente — in cui
// `message` è un **rawtext JSON** con chiavi di traduzione, arrivato nel ledger
// come `{"rawtext":[{"text":""},{"translate":"tile.bed.respawnSet"}]}`.
// Lasciarlo così significa conservare escape invece di una frase: il testo del
// server perde la sua unica qualità, essere leggibile. `flattenServerRawText`
// appiattisce `{"rawtext":[…]}` in testo (unendo le parti `text` e riempiendo i
// `%s` dei `translate` con il loro `with`); se non è JSON, torna invariato.
function rawTextChunks (value, out = []) {
  if (value == null) return out;
  if (typeof value === 'string') { out.push(value); return out; }
  if (Array.isArray(value)) { for (const item of value) rawTextChunks(item, out); return out; }
  if (typeof value !== 'object') { out.push(String(value)); return out; }
  if (Array.isArray(value.rawtext)) return rawTextChunks(value.rawtext, out);
  const withValues = Array.isArray(value.with)
    ? value.with.map(item => (item && typeof item === 'object' ? (item.text ?? item.translate ?? '') : item))
    : [];
  if (typeof value.translate === 'string') {
    let next = 0;
    out.push(value.translate.replace(/%\d+\$s|%s/g, (match) => {
      const positional = /^%(\d+)\$s$/.exec(match);
      const replacement = withValues[positional ? Number(positional[1]) - 1 : next++];
      return replacement == null ? match : String(replacement);
    }));
    return out;
  }
  if (typeof value.text === 'string') out.push(value.text);
  return out;
}

function flattenServerRawText (text) {
  if (typeof text !== 'string' || !text.trim().startsWith('{')) return text;
  let data;
  try { data = JSON.parse(text); } catch { return text; }
  if (!data || typeof data !== 'object') return text;
  const flat = rawTextChunks(data, []).join('').trim();
  return flat || text;
}

// L'esportazione serve ai test; `flattenServerRawText` è privata di proposito:
// l'unico modo di vedere una frase del server è questa funzione.
export function renderServerText (packet) {
  const raw = packet?.message;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const params = Array.isArray(packet?.parameters) ? packet.parameters : [];
  let text = flattenServerRawText(raw);
  if (params.length) {
    let next = 0;
    text = text.replace(/%\d+\$s|%s/g, (match) => {
      const positional = /^%(\d+)\$s$/.exec(match);
      const value = params[positional ? Number(positional[1]) - 1 : next++];
      return value == null ? match : String(value);
    });
  }
  const clean = stripFormatting(text);
  return clean || null;
}

const STORAGE_CONTAINER_SLOT = {
  chest: 'container',
  trapped_chest: 'container',
  barrel: 'barrel',
  shulker_box: 'shulker',
};

export class BedrockAdapter {
  constructor ({ logger = console, onLog, onDisconnect, memory = null } = {}) {
    this.logger = logger;
    this.onLog = onLog;
    this.onDisconnect = onDisconnect;
    this.memory = memory;
    this.construction = new ConstructionEngine(this);
    this.resourceSites = new RememberedResourceSites(this);
    this._actionScope = new AsyncLocalStorage();
    this.missionId = null;             // missione di esplorazione attiva (checkpoint)
    this._lastDiscoveryChunk = null;   // dedup: scoperte scansionate una volta per chunk
    this._lastDiscoveryAt = 0;
    this._lastOreScanAt = 0;          // TTL della scansione ore di valore
    this._lastOreScanPos = null;
    this.client = null;
    this.status = 'disconnected';
    this.position = null;
    this.spawned = false;
    this.health = 20;
    this.food = 20;
    this.inventory = {};
    this.inventorySlots = [];
    this.pickups = {};             // conteggi raccolti dai drop (non ancora negli slot server)
    this.selectedHotbar = 0;
    this._authInputQueue = [];
    this._tickAnchor = null;
    this.drops = [];
    this._reachCache = null;         // componente calpestabile raggiungibile (cache breve)
    this._pathOverrides = null;      // celle trattate come vuote in un BFS (mondo ipotetico)
    this._fishBiteAt = 0;            // ultimo evento `fish_hook_hook` (morso confermato dal server)
    this._fishTeaseAt = 0;           // ultimo evento `fish_hook_tease` (pesce che si avvicina ma non morde)
    this.nearbyBlocks = {};
    this.valuableOres = [];        // ore di valore in vista (occasioni, vedi _scanValuableOres)
    this.oreAlertSeen = new Set();   // vene già annunciate in chat (chiave nome+posizione)
    this.oreAlertCores = ORE_ALERT_CORES; // vene da annunciare (ORE_ALERT, default diamond)
    this._lastOreAlertAt = 0;        // cooldown fra due avvisi
    this.lastOreAlert = null;        // ultimo avviso (per /observe e per i test)
    this.oreAlertText = null;        // renderer iniettato da chi ha il catalogo (M11)
    this.structures = [];          // strutture rilevate nell'ultima ricognizione (M5/M6)
    this._structureSurvey = null;  // riassunto dell'ultima ricognizione (per /observe)
    this._structureSurveyAt = 0;
    this._villageCache = null;     // ultima vista del sito (V0): memoizzata, vedi _villageView()
    this._villageSweep = null;     // ultima passata (V1): cooldown + celle censite in RAM
    this._fluidScan = null;        // censimento acqua/lava nell'area caricata (M0)
    this._fluidScanAt = 0;
    // W0: censimento sculk (sensori, shrieker, celle della famiglia) e livello di
    // allarme. Gli shriek osservati si sommano in una finestra: è l'unico segnale
    // del livello di allarme visibile al client (il warning level vive nel server).
    this._sculkScan = null;
    this._sculkScanAt = 0;
    this._sculkShrieks = [];
    // Aria (M1): il server non espone l'attributo, quindi il budget è *simulato*
    // tick per tick (`airSource: 'simulated'`). Se un giorno arrivasse, la verità
    // del server vince e la sorgente diventa 'server'.
    this._airMeter = new AirMeter();
    this._serverAir = null;
    this.airSource = 'simulated';
    this.air = MAX_AIR;
    // M2: gli effetti attivi arrivano dal pacchetto `mob_effect`. Servono a una
    // sola decisione — se respirare sott'acqua è gratis — quindi si tiene solo
    // l'ultimo stato per nome dell'effetto, non uno storico.
    this.effects = new Map();
    this._conduitScan = null;
    this._conduitScanAt = 0;
    this._diveLast = null;
    // M3: cascate e colonne di bolle. `swimSupported` è la dichiarazione onesta
    // del limite di M1 (il movimento in acqua non esiste): tutte le azioni di
    // colonna passano da `columnTactic`, che senza nuoto risponde
    // `swimming_unavailable` invece di provare una fisica che non c'è.
    this.swimSupported = false;
    // M1 (04/10/2026): stato di nuoto dichiarato al server con i flag
    // `start_swimming`/`stop_swimming` (transizioni a fronte) e `want_up`/`want_down`.
    this._swimming = false;
    // M1 (04/10/2026): sonda di misura. `_swimProbe` forza per pochi secondi
    // l'intenzione verticale (`mode: 'up'|'down'|'none'`) mentre `swimMeasure`
    // campiona la quota che il **server** conferma: i ratei del nuoto si misurano,
    // non si indovinano (il client reale li sente, noi no).
    this._swimProbe = null;
    this._waterfallLast = null;
    this._lavaLast = null;
    this._bucketLast = null;
    this._redstoneScan = null;
    this._redstoneScanAt = 0;
    // R2: i blocchi dell'ultima scansione e l'ultimo cambio osservato, così un
    // `update_block` aggiorna la cache senza rifare la scansione.
    this._redstoneBlocks = null;
    this._redstoneChange = null;
    // R3: i blueprint dei circuiti si caricano una volta sola (un file rotto
    // resta visibile in `/observe.circuits.invalid` invece di far esplodere il
    // bot) e l'ultimo cantiere resta leggibile da fuori.
    this._circuits = null;
    this._circuitError = null;
    this._circuitLast = null;
    // Ultimo hub del Nether costruito (N2): posizione, materiale, se chiuso.
    // Il campo non può chiamarsi `_netherHub`: ombreggerebbe il metodo.
    this._netherHubLast = null;
    this._blazeLast = null;
    // N7: lanci di occhi di ender (posizione del lancio + direzione stimata dal
    // volo), l'ultimo cantiere del portale dell'End e lo stato della barra del
    // boss. `_eyeReadings` è limitato: le letture vecchie non descrivono più
    // dove sta andando un occhio appena lanciato.
    this._eyeReadings = [];
    this._eyeLast = null;
    this._frameLast = null;
    this._bossBar = { shown: false, hidden: false, shownAt: null, hiddenAt: null, entityId: null, progress: null };
    this._bossBarEvents = 0;
    // Ultimo bartering (N4): il campo non può chiamarsi `_barter`, che è un
    // verbo già usato per il metodo.
    this._barterLast = null;
    // R4: registro dei blocchi che il bot ha piazzato lui (chiave "x,y,z"),
    // con la sorgente e, per i cantieri, l'id del circuito. Serve al teardown
    // per non toccare mai un blocco che non è suo.
    this._placedBlocks = new Map();
    // La cella dell'ultimo toggle redstone: un clock "fatto a mano" che aziona
    // la stessa leva due volte in pochi ms è lag, e R6 lo vieta.
    this._lastRedstoneToggleAt = new Map();
    // R4: traccia degli ultimi cambi redstone osservati ({position, name, power,
    // at}), base della misura del ritardo di un circuito.
    this._redstoneTrace = [];
    // R4: la misura del ritardo confronta l'istante del trigger con quello
    // dell'aggiornamento di blocco. L'orologio è iniettabile perché i test del
    // builder non hanno un server vero che timbra gli update: con `Date.now()`
    // la misura dipenderebbe dal carico della macchina (test intermittente).
    this._now = () => Date.now();
    this.dimension = 'overworld';
    this.standingOn = null;
    this.plan = null;
    this.home = null;              // waypoint casa per go_home/retreat (default: spawn)
    if (process.env.HOME_WAYPOINT) {
      try { this.home = JSON.parse(process.env.HOME_WAYPOINT); } catch { /* ignora JSON malformato */ }
    }
    this.armor = { helmet: null, chestplate: null, leggings: null, boots: null }; // pezzi indossati
    // Slot grezzi della finestra 'armor' (WindowID 120) come li manda il server:
    // la rispedisce a ogni ingresso e a ogni cambio di pezzo. Si tengono grezzi
    // perché i nomi degli oggetti dipendono dalla palette, che arriva dopo
    // (`start_game`/`item_registry`): la risoluzione sta in `_refreshArmorMirror()`.
    this._armorWindow = [null, null, null, null];
    this.chatInbox = [];             // messaggi chat recenti { from, message, type, xuid, at }
    // R2: la domanda in attesa di risposta, per mittente. Vive **qui** e non nel
    // controller perché è il ciclo di vita della chat («a chi ho appena chiesto
    // qualcosa?»), e perché così sopravvive a un riavvio del controller: l'umano
    // risponde quando vuole, anche a bot già ripartito.
    this.chatPending = new Map();    // chiave: gamertag/xuid minuscolo -> { orderId, from, originalText, question, field, reason, askedAt, keys }
    this._lastChatAt = 0;            // ultimo invio chat (rate limit del bot che parla)
    this._sentChat = [];             // testo dei messaggi inviati { text, at } (riconoscere l'eco)
    this.selfName = null;            // gamertag che il server attribuisce al bot (imparato dall'eco)
    this._playersByName = new Map(); // gamertag minuscolo -> runtimeId (chat -> entità da seguire)
    this._sleepLevelEventAt = 0;     // ultimo level_event di sonno ricevuto
    this._weather = { rain: false, thunder: false, at: 0 }; // meteo dal level_event (3001..3004)
    this._playerBedPosition = null;  // player_bed_position dei metadata (letto di respawn)
    this._playerLastSeen = new Map(); // gamertag minuscolo -> { position, at } (ultima posizione nota)
    this.busy = false;
    this.recent = [];
    this.serverText = [];           // M13: ultimi testi non-chat del server (diagnosi)
    this.connectError = null;
    this.tick = 0n;
    this.movementAuthority = null;
    this.rewindHistorySize = null;
    this._feet = null;              // posizione piedi, usata dalla fisica
    this._velocity = { x: 0, y: 0, z: 0 };
    this._onGround = true;
    this._collidedHorizontally = false;
    this._lastSimTick = null;
    this._lastYaw = 0;
    this._lastPitch = 0;
    this._motion = null;
    this._motionTrack = null;       // misura di velocità del movimento in corso (W1)
    // Salto fuori dal pathfinder (pillar-up): `_motion` è di proprietà del
    // pathfinder e `_updateMotionState` ne dereferenzia `target`/`path`, quindi
    // un salto a comando usa un canale dedicato invece di sovrascriverlo.
    this._freeJump = null;
    this.riding = null;                // { riddenEntityId, at } quando il bot è montato
    // Missione «l'umano si imbarca»: i link rider→veicolo di *tutti* i rider
    // (non solo del bot) sono la verità su chi sta su cosa, e lo stato della
    // macchina a stati. Il rilevamento è in produzione; il join vero è dietro
    // `BEDROCK_JOIN_HUMAN_MOUNT=1` perché il server non conferma il nostro
    // interact (nessun `set_entity_link`: vedi docs/wiki/companions.md).
    this.entityLinks = new Map();      // riderRuntimeId -> { ridden, type, at }
    this.joinHumanMountEnabled = process.env.BEDROCK_JOIN_HUMAN_MOUNT === '1';
    this._mountFollow = { state: MOUNT_FOLLOW_STATES.IDLE, action: 'none', reason: null, attempts: 0, lastError: null, mountKey: null };
    this._sneaking = false;            // sneak dichiarato al server (mount/dismount/trade)
    this._sneakDeclared = false;       // ultimo `sneaking` mandato nei player_auth_input
    this._stealthSneaking = false;     // sneak di navigazione silenziosa (W1)
    this._lastSneak = null;            // ultima misura di velocità sneak (verdetto dal server)
    this._stealthRoute = null;         // ultima rotta silenziosa pianificata + rotta di ritorno (W2)
    this.offhand = null;               // { name, count } dell'offhand (scudo), conferma dal server
    this.shieldUp = false;             // l'ultimo frame auth dichiarava l'uso dell'item
    this._ridingForward = false;       // vettore avanti continuo mentre cavalca
    this._ridingYaw = 0;               // yaw verso cui cavalcare
    this.ridingDistance = 0;           // R8: metri percorsi a bordo di una barca (monotono)
    this._openDoors = new Set();       // celle di porte aperte (fisica passabile)
    this._doorWatchers = new Map();    // key -> runtime id della porta chiusa
    this.recipes = null;               // output -> ricette da crafting_data
    this.craftingData = null;
    this.furnaceRecipes = null;        // ricette di fusione da crafting_data
    this._furnaceSlots = {};           // ingredient/fuel/output del container fornace aperto
    this._stackRequestId = -861;       // id dispari negativi come il client vanilla
    this._openContainer = null;        // { id, type } del container UI aperto
    this._openContainerBlock = null;   // { name, position } del blocco storage aperto
    this._openContainerSlots = [];     // slot grezzi dell'inventory_content del container storage
    this._openContainerContentAt = 0;  // quando è arrivato il contenuto della finestra aperta
    this._openContainerContentWindow = null; // finestra a cui quel contenuto appartiene
    this._containerContentWaiters = [];
    this.containers = new Map();       // "<x,y,z>" -> { type, readAt, contents: { item: count } }
    this._storageOpenFailures = new Map();   // "<x,y,z>" -> { at, error } (contenitori che non si sono aperti)
    this._containerWaiters = [];
    this._craftingGrid = new Map();    // gridSlot -> { network_id, count, stack_id }
    this._cursor = null;               // { network_id, count, stack_id }
    // Commercio: offerte del villager/mercante aperto, finestra e slot di trading.
    this.tradeOffers = [];             // offerte parse da update_trade
    // Diagnostica interazioni entità (04/10/2026): ogni `item_use_on_entity`
    // standalone è seguita da un resync dell'inventario, che è il segnale con cui
    // il server rifiuta la transazione. Il contatore misura quel rifiuto.
    this._invResyncCount = 0;
    // Snapshot dell'inventario del giocatore accettati: sono il segnale con cui
    // un refresh in-place (`_refreshInventoryFromServer`) sa di aver ricevuto
    // gli slot freschi senza essersi riconnesso.
    this._playerSnapshotCount = 0;
    this._playerSnapshotWaiters = [];
    this._lastInventoryReconnectAt = 0;   // limite di frequenza delle riconnessioni da resync
    this._rxLog = [];                // anello dei nomi di pacchetto ricevuti (diagnostica)
    this.tradeTarget = null;           // { type, runtimeId, uniqueId, position, distance, profession? }
    this.tradeDisplayName = null;      // professione/descrizione mostrata nella UI di trading
    this.tradeTier = null;             // tier corrente del villager aperto
    this.tradeNewUI = true;            // new_trading_ui da update_trade (slot trade2_*)
    this.tradeOpenedAt = 0;            // timestamp apertura commercio (per TTL)
    this._tradeSlots = { ingredient1: null, ingredient2: null, result: null };
    // Sopravvivenza: entità note (mob/giocatori), ora del giorno, sonno e morte.
    this.entities = new Map();         // runtimeId -> { type, kind, position, health, lastAt }
    this._entitiesByUnique = new Map(); // uniqueId -> runtimeId
    this._timeBase = null;             // { ticks, at } dell'ultimo set_time
    this.sleeping = false;
    this._playerSleepKnown = false;
    this.dead = false;
    this.deaths = 0;
    // Una *morte* e' un episodio: da quando la vita arriva a 0 a quando torna
    // sopra 0. `dead` invece si chiude e si riapre dentro l'episodio (il
    // respawn client, il limbo del BDS), e contare su di lui faceva scrivere un
    // evento `death` a ogni ciclo (live demo-r2: 10 `death` a ledger contro 7
    // morti vere, tutte nella stessa casa, 4 delle quali senza nessuna azione
    // del driver in mezzo).
    this._deathEpisode = false;
    this._respawnAt = 0;
    this._limboSince = null;           // health <= 0 senza stato dead (respawn a metà)
    this._deadSince = null;            // morte in corso: base per il watchdog di riconnessione
    this._respawnReconnecting = false; // riconnessione già innescata per respawn bloccato
    this.deathSite = null;             // { position, at, attempts } per il recupero post-morte
    this.experienceLevel = null;       // livello EXP dal server (attributi)
    this.experienceProgress = null;
    this._bedCache = null;             // { at, bed } scansione letti con TTL
    this.world = new BedrockWorld({ version: VERSION, onError: error => this.log('world_error', { message: error.message }) });
  }

  log (type, data) {
    // Il nome dell'evento vince sempre: `data` può portare un campo `type`
    // (tipo dell'entità, canale della chat) che altrimenti lo sovrascriverebbe,
    // facendo sparire l'evento dal log (es. `entity_death` → `chicken`).
    const entry = { t: Date.now(), ...data, type };
    if (this.onLog) this.onLog(entry);
    this.logger.log(`[${type}]`, data);
  }

  async _nethernetPing () {
    const c = new NethernetClient({ host: HOST, port: PORT });
    try {
      const ad = await c.ping(10000);
      this.log('discovery', { host: HOST, port: PORT, protocol: ad.protocol, version: ad.gameVersion, levelName: ad.levelName, networkId: String(ad.networkId) });
      return ad;
    } finally {
      c.close();
    }
  }

  connect () {
    if (this._connecting) return this._connecting;
    this._connectAbort = new AbortController();
    const signal = this._connectAbort.signal;
    const cleanup = this._disconnecting;
    this._connecting = Promise.resolve().then(async () => {
      await cleanup;
      signal.throwIfAborted();
      if (this.spawned && this.client) return;
      await this._connect(signal);
    }).finally(() => { this._connecting = null; });
    return this._connecting;
  }

  async _connect (signal) {
    this.status = 'discovering';
    this.connectError = null;
    let attemptClient;
    try {
      const ad = await this._nethernetPing();
      signal.throwIfAborted();
      const networkId = ad.networkId ? String(ad.networkId) : undefined;
      if (!networkId) throw new Error('networkId missing from discovery advertisement');

      const options = {
        host: HOST,
        port: PORT,
        username: USERNAME,
        version: VERSION,
        transport: 'nethernet',
        nethernet: { networkId },
        raknetBackend: 'jsp-raknet',
        skipPing: true,
        profilesFolder: PROFILES_DIR,
        connectTimeout: CONNECT_TIMEOUT,
      };

      const hasRealAccount = !!process.env.BEDROCK_USERNAME;
      if (hasRealAccount) {
        options.authTitle = bedrock.title[AUTH_TITLE_NAME] || bedrock.title.MinecraftNintendoSwitch;
        if (!options.authTitle) throw new Error(`unknown auth title ${AUTH_TITLE_NAME}`);
        options.flow = 'live';
        options.onMsaCode = (data) => {
          this.log('msa', { verification_uri: data.verification_uri, user_code: data.user_code });
          this.logger.warn(`[msa] Authenticate ${USERNAME} at ${data.verification_uri} with code ${data.user_code}`);
        };
      } else {
        options.offline = true;
      }

      this.status = 'connecting';
      const client = this.client = trackNethernetClient(bedrock.createClient(options));
      attemptClient = client;
      if (process.env.BEDROCK_PACKET_LOG) {
        client.on('packet', des => this.log('packet', { name: des.data.name }));
      }
      // Chat dei giocatori (pubblico + whisper): canale di comando umano (M1).
      this.client.on('text', (packet) => this._onChat(packet));
      const cancel = () => client.close();
      signal.addEventListener('abort', cancel, { once: true });

      this.client.on('error', (err) => {
        this.connectError = err;
        this.log('client_error', { message: err.message || String(err) });
      });

      // Il server invia l'elenco ricette subito dopo start_game, prima dello spawn.
      this.client.on('crafting_data', (packet) => this._indexRecipes(packet));

      this.client.on('item_stack_response', (packet) => {
        this.lastStackResponse = packet;
        const responses = packet.responses || [];
        const failed = responses.filter(r => String(r.status) !== 'ok' && r.status !== 0);
        this.log('item_stack_response', failed.length
          ? { failed: JSON.stringify(failed).slice(0, 600) }
          : { statuses: responses.map(r => r.status) });
      });

      client.on('container_open', (packet) => {
        this._openContainer = { id: packet.window_id, type: packet.window_type };
        this._openContainerBlock = null;
        this._openContainerSlots = [];
        this._openContainerContentAt = 0;      // il contenuto della finestra precedente non vale
        this._openContainerContentWindow = null;
        if (packet.window_type === 'trading' || packet.window_type === 15) {
          // La finestra di trading viene aperta dal server in risposta all'interact
          // sul villager; il contenuto delle tre slot arriva con inventory_content.
          this._tradeSlots = { ingredient1: null, ingredient2: null, result: null };
          if (!this.tradeOpenedAt) this.tradeOpenedAt = Date.now();
        }
        this.log('container_open', { windowId: packet.window_id, windowType: packet.window_type });
        this._noteContainerOpened();
        for (const waiter of this._containerWaiters.splice(0)) {
          if (waiter.predicate(packet)) waiter.resolve(packet);
          else this._containerWaiters.push(waiter);
        }
      });

      // Il server invia le offerte dopo l'interact sul villager (o quando una
      // finestra di trading già aperta cambia, es. tier sbloccato).
      this.client.on('update_trade', (packet) => this._onUpdateTrade(packet));

      // Se il server chiude la finestra di trading (villager allontanato o
      // despawnato), le offerte non sono più valide e vanno scartate.
      this.client.on('container_close', (packet) => {
        const open = this._openContainer;
        if (!open) return;
        if (packet.window_id !== open.id) return;
        const wasTrading = open.type === 'trading' || open.type === 15;
        this.log('container_closed', { windowId: packet.window_id, byServer: !!packet.server, windowType: packet.window_type });
        this._openContainer = null;
        this._openContainerBlock = null;
        this._openContainerSlots = [];
        this._openContainerContentAt = 0;
        this._openContainerContentWindow = null;
        if (wasTrading) {
          this.tradeOffers = [];
          this.tradeOpenedAt = 0;
          this.tradeTarget = null;
          this._tradeSlots = { ingredient1: null, ingredient2: null, result: null };
        }
      });

      this.client.on('kick', (packet) => {
        this.log('kicked', packet);
        this.status = 'kicked';
      });

      this.client.on('close', () => {
        signal.removeEventListener('abort', cancel);
        if (this._authTickInterval) { clearInterval(this._authTickInterval); this._authTickInterval = null; }
        for (const pending of this._authInputQueue.splice(0)) pending.reject(new Error('connection_lost'));
        if (this.client !== client) return;
        const wasSpawned = this.spawned;
        // Un movimento in corso non ricevera' piu' tick (l'intervallo di auth e' appena
        // stato spento): senza abortirlo la promise di `_startMotion` resta appesa e
        // l'azione tiene il lock dell'harness fino all'action_timeout di 180 s, con il
        // bot immobile (live 04/10: `client_close` a meta' di `follow_player`).
        if (this._motion?.active) this._finishMotion('disconnected');
        this.log('client_close', { reason: client._lifecycleCloseReason || this.connectError?.message || 'closed' });
        this.status = 'disconnected';
        this.spawned = false;
        this.client = null;
        if (wasSpawned && !this._disconnecting) {
          const cleanup = closeBedrockClient(client);
          this._disconnecting = cleanup;
          cleanup.catch(error => this.log('cleanup_error', { message: error.message })).finally(() => {
            if (this._disconnecting === cleanup) this._disconnecting = null;
            if (this.onDisconnect && !signal.aborted) this.onDisconnect();
          });
        }
      });

      this.client.on('spawn', () => {
        this.spawned = true;
        this.status = 'spawned';
        this._deadSince = null;
        this._respawnReconnecting = false;
        this.position = client.startGameData?.player_position;
        this.dimension = client.startGameData?.dimension || 'overworld';
        if (!this.home) this.home = { x: this.position.x, y: this.position.y, z: this.position.z };
        if (this.memory) {
          if (this.home && !this.memory.hasLandmark('home')) {
            this.memory.rememberLandmark({ id: 'home', type: 'home', label: 'home', position: this.home, source: 'spawn' });
          }
          this.memory.hydrate();
        }
        // R4: il registro dei propri piazzamenti sopravvive ai restart.
        this._hydratePlacements();
        this.drops = [];
        this._syncFeetFromPosition();
        this._velocity = { x: 0, y: 0, z: 0 };
        this._onGround = true;
        this._lastSimTick = null;
        this._motion = null;
        this.riding = null;
        this._ridingForward = false;
        this._lastYaw = 0;
        this._lastPitch = 0;
        client.queue('serverbound_loading_screen', { type: 1 });
        client.queue('client_camera_aim_assist', { preset_id: '', action: 'clear', allow_aim_assist: false });
        client.queue('serverbound_loading_screen', { type: 2 });
        this.log('spawn', { entityId: String(client.entityId), position: this.position, dimension: this.dimension });
        this.world.requestAround(client, this.position);
        if (!this._authTickInterval) {
          this._authTickInterval = setInterval(() => {
            if (this.client && this.spawned) this._authTick();
          }, 50);
        }
      });

      this.client.on('tick_sync', (packet) => {
        const serverTick = BigInt(packet.response_time || 0);
        if (serverTick > this.tick) this.tick = serverTick;
      });

      this.client.on('start_game', packet => this._onStartGame(packet));

      client.on('set_movement_authority', (packet) => {
        this.movementAuthority = packet.movement_authority;
        this.log('set_movement_authority', { movementAuthority: packet.movement_authority });
      });

      client.on('level_chunk', packet => this.world.levelChunk(packet));
      this.client.on('update_block', (packet) => {
        this.world.setBlock(packet.position, packet.block_runtime_id, packet.layer);
        this._onBlockUpdate(packet.position, packet.block_runtime_id);
        this._refreshNearby();
      });
      client.on('update_subchunk_blocks', packet => {
        for (const update of packet.blocks || []) {
          this.world.setBlock(update.position, update.runtime_id, 0);
          this._onBlockUpdate(update.position, update.runtime_id);
        }
        for (const update of packet.extra || []) this.world.setBlock(update.position, update.runtime_id, 1);
        this._refreshNearby();
      });
      client.on('item_registry', packet => {
        this.world.registry.handleStartGame({ ...client.startGameData, itemstates: packet.itemstates });
        this._refreshInventory();
        // La finestra 'armor' arriva *prima* della palette: i nomi si risolvono ora.
        this._refreshArmorMirror();
      });
      client.on('subchunk', packet => {
        this.world.subchunk(packet);
        this._refreshNearby();
      });

      this.client.on('move_player', (packet) => {
        if (String(packet.runtime_id) !== String(client.entityId)) {
          // Il BDS inoltra il movimento degli *altri giocatori* con `move_player`
          // (id 0x13, ~20 pacchetti/s): `move_entity`/`move_entity_delta` arrivano
          // solo per i mob. Senza questo ramo la posizione di un umano restava
          // ferma a quella di `add_player` (bug live 04/10).
          this._onPlayerMove(packet);
          return;
        }
        if (process.env.MOVE_DEBUG) {
          this.log('self_move_player', {
            position: { x: +packet.position.x.toFixed(2), y: +packet.position.y.toFixed(2), z: +packet.position.z.toFixed(2) },
            feet: this._feet ? { x: +this._feet.x.toFixed(2), y: +this._feet.y.toFixed(2), z: +this._feet.z.toFixed(2) } : null,
            onGround: packet.on_ground ?? null,
          });
        }
        this._trackRidingDistance(this.position, packet.position);
        this.position = packet.position;
        this.world.requestAround(client, this.position);
      });
      client.on('correct_player_move_prediction', packet => {
        // `player` corregge il bot a piedi; `vehicle` corregge il veicolo su cui
        // il bot è montato (la posizione del bot è quella del veicolo).
        if (packet.prediction_type !== 'player' && packet.prediction_type !== 'vehicle') return;
        // La correzione è la posizione autorevole del server (agli occhi).
        // L'ancora di tick viene riallineata per restare nella finestra di rewind.
        if (packet.tick != null) this._tickAnchor = { tick: BigInt(packet.tick), time: Date.now() };
        if (!this._feet) this._syncFeetFromPosition(packet.position);
        const drift = Math.hypot(packet.position.x - this._feet.x, packet.position.z - this._feet.z);
        if (drift > MAX_CORRECTION_DRIFT || packet.prediction_type === 'vehicle') {
          // Divergenza reale (spinta, disallineamento, veicolo): accetta X/Z del server.
          this._feet.x = packet.position.x;
          this._feet.z = packet.position.z;
          this._velocity.x = 0;
          this._velocity.z = 0;
        }
        // Il server puo' tenere il bot sospeso (quota di spawn mai aggiornata,
        // quarantena anti-cheat, sonno appena accettato): adottare quella quota a
        // ogni correzione lo inchioda in aria e la fisica locale riparte a cadere,
        // per sempre. `_serverFeetY` accetta solo quote sostenibili, teletrasporti
        // e spinte verso il basso.
        const verifiedFeetY = this._feetFromServerY(packet.position);
        const acceptedFeetY = this._serverFeetY(packet.position);
        if (acceptedFeetY != null && Math.abs(acceptedFeetY - this._feet.y) > 0.05) {
          if (process.env.MOVE_DEBUG) this.log('feet_clamped', { from: +this._feet.y.toFixed(2), to: +acceptedFeetY.toFixed(2), position: packet.position });
        }
        if (acceptedFeetY != null) this._feet.y = acceptedFeetY;
        else if (process.env.MOVE_DEBUG && verifiedFeetY != null) this.log('feet_suspended', { server: +verifiedFeetY.toFixed(2), local: +this._feet.y.toFixed(2), position: packet.position });
        if (packet.on_ground != null) {
          this._onGround = packet.on_ground;
          if (packet.on_ground) this._velocity.y = 0;
        }
        if (process.env.MOVE_DEBUG) {
          this.log('predict_correction', {
            position: { x: +packet.position.x.toFixed(2), y: +packet.position.y.toFixed(2), z: +packet.position.z.toFixed(2) },
            feetAfter: +this._feet.y.toFixed(2),
            drift,
            onGround: this._onGround,
            clientTick: Number(this.tick),
            serverTick: packet.tick != null ? Number(packet.tick) : null,
            tickLag: packet.tick != null ? Number(this.tick) - Number(packet.tick) : null,
          });
        }
        this._syncPositionFromFeet();
        this.world.requestAround(client, this.position);
        this._refreshNearby();
      });

      // Collegamento cavaliere→veicolo: il server conferma montata/smontata.
      client.on('set_entity_link', (packet) => this._onEntityLink(packet));

      this.client.on('set_health', (packet) => {
        this.health = packet.health;
        this._onOwnHealth();
      });

      this.client.on('update_attributes', (packet) => this._applyOwnAttributes(packet));

      this.client.on('inventory_content', (packet) => {
        const containerId = packet.container?.container_id;
        this._invResyncCount++;
        // Contenuto completo della finestra 'armor' (se il server la manda tutta
        // insieme invece che slot per slot).
        if ((packet.window_id === 'armor' || containerId === 'armor') && Array.isArray(packet.input)) {
          packet.input.forEach((item, slot) => this._applyArmorWindowSlot(slot, item));
          this.log('armor_content', { window_id: packet.window_id, container: containerId ?? null, worn: this._wornArmor().join(' ') || null });
        }
        if (packet.window_id === 'inventory' || packet.window_id === 0 || packet.inventory_id === 0) {
          this.log('inventory_content', {
            window_id: packet.window_id,
            container: containerId ?? null,
            slots: (packet.input || packet.contents || []).length,
            stackIds: (packet.input || []).filter(s => s?.network_id)
              .map(s => `${s.name || this.world.registry?.items[s.network_id]?.name || s.network_id}:${s.stack_id ?? 'none'}`).join(' ').slice(0, 400),
            raw: JSON.stringify({ ...packet, input: packet.input?.slice(0, 2) }).slice(0, 400),
          });
          // La griglia di crafting arriva come contenuto separato (container
          // crafting_input): non è l'inventario del giocatore e non va copiato.
          this._applyPlayerInventorySnapshot(packet.input || packet.contents || [], { containerId });
        }
        // Il contenuto del container aperto è la verità sulla griglia di crafting.
        if (this._openContainer && packet.window_id === this._openContainer.id && Array.isArray(packet.input)) {
          if (this._openContainer.type === 'inventory' || this._openContainer.type === 'workbench') {
            const gridSlots = this._openContainer.type === 'workbench'
              ? [32, 33, 34, 35, 36, 37, 38, 39, 40]
              : [28, 29, 30, 31];
            for (const slot of gridSlots) {
              const item = packet.input[slot];
              if (item?.network_id) this._craftingGrid.set(slot, { network_id: item.network_id, count: item.count, stack_id: item.stack_id });
              else this._craftingGrid.delete(slot);
            }
          }
          // Finestra fornace (base, altoforno o affumicatore): tre slot container.
          if (SMELT_STATIONS[this._openContainer.type]) {
            this._trackFurnaceSlots(packet.input);
            this.log('furnace_content', {
              station: this._openContainer.type,
              slots: [FURNACE_SLOTS.ingredient, FURNACE_SLOTS.fuel, FURNACE_SLOTS.output].map(slot => {
                const item = packet.input[slot];
                return item?.network_id ? `${this._slotItemName(item)}:${item.count}:${item.stack_id ?? 'none'}` : '-';
              }),
            });
          }
          // Finestra di trading: le tre slot (ingrediente 1, ingrediente 2,
          // risultato) arrivano come inventory_content della finestra trading.
          if (this._openContainer.type === 'trading') {
            this._trackTradeSlots(packet.input);
          }
          // Contenitore di stoccaggio (baule/botte/shulker): la window_type è
          // 'container'; il contenuto è l'elenco completo delle slot 0..26 (54 se doppio).
          if (this._openContainer.type === 'container' && this._openContainerBlock) {
            this._openContainerSlots = packet.input;
            this._openContainerContentAt = Date.now();
            this._openContainerContentWindow = this._openContainer.id;
            for (const waiter of this._containerContentWaiters.filter(w => w.windowId === this._openContainer.id)) waiter.resolve(true);
            this.log('container_content', {
              block: this._openContainerBlock.name,
              containerId: containerId ?? null,
              slots: packet.input.length,
              items: packet.input.filter(s => s?.network_id).map(s => `${this._slotItemName(s)}:${s.count}`).join(' ').slice(0, 400),
            });
          }
        }
      });
      client.on('inventory_slot', packet => {
        const containerId = packet.container?.container_id;
        this.log('inventory_slot', {
          window_id: packet.window_id, container: containerId ?? null, slot: packet.slot,
          item: packet.item ? `${packet.item.name || this.world.registry?.items[packet.item.network_id]?.name || packet.item.network_id}:${packet.item.count}:${packet.item.stack_id ?? 'none'}` : null,
        });
        // La finestra 'armor' non è la finestra del giocatore: `_playerSlotIndex`
        // la scarterebbe, quindi va letta prima (e prima di ogni prefisso).
        if (packet.window_id === 'armor' || containerId === 'armor') {
          this._applyArmorWindowSlot(packet.slot, packet.item);
          return;
        }
        if (this._trackFurnaceSlot(containerId, packet.item)) return; // non è uno slot del giocatore
        if (this._trackTradeSlot(containerId, packet.slot, packet.item)) return; // slot della finestra di trading
        const index = this._playerSlotIndex(containerId, packet.window_id, packet.slot);
        if (index == null || index < 0 || index > 35) return;
        this.inventorySlots[index] = packet.item;
        this._refreshInventory();
      });
      client.on('mob_equipment', packet => {
        if (String(packet.runtime_entity_id) !== String(client.entityId)) return;
        this._onMobEquipment(packet);
      });
      // N7: la barra del boss è il segnale del server sul drago. `show_bar` e
      // `hide_bar` sono gli unici due eventi che contano: il verdetto è
      // "comparsa e poi scomparsa", non l'assenza di un'entità.
      client.on('boss_event', packet => this._onBossEvent(packet));
      // M2: effetti del giocatore (elmo di tartaruga a parte, che è equipaggiamento).
      client.on('mob_effect', packet => this._onMobEffect(packet));

      this.client.on('add_item_entity', (packet) => {
        // Traccia drop nelle vicinanze
        if (!this.position) return;
        const p = packet.position || packet;
        const dist = Math.hypot(p.x - this.position.x, p.y - this.position.y, p.z - this.position.z);
        if (dist < 24) {
          const item = packet.item;
          this.drops.push({ id: packet.entity_id_self, runtime_id: packet.runtime_entity_id,
            item: item?.name || this.world.registry?.items[item?.network_id]?.name || 'unknown',
            count: item?.count || 1, position: p, distance: +dist.toFixed(1), spawnedAt: Date.now() });
        }
      });

      const findDrop = packet => this._findDropPacket(packet);
      this.client.on('move_entity', (packet) => {
        const drop = findDrop(packet);
        if (drop && packet.position) drop.position = packet.position;
      });
      this.client.on('move_entity_delta', (packet) => {
        const drop = findDrop(packet);
        if (!drop) return;
        // I campi presenti sono coordinate assolute (solo quelle cambiate), non delta.
        drop.position = {
          x: packet.x ?? drop.position.x,
          y: packet.y ?? drop.position.y,
          z: packet.z ?? drop.position.z,
        };
      });
      this.client.on('take_item_entity', packet => this._onTakeItemEntity(packet));

      this.client.on('remove_entity', (packet) => {
        this.drops = this.drops.filter(d => d.id !== packet.entity_id_self);
      });

      // --- sopravvivenza: entità, ora del giorno, sonno, morte ---------------------
      this.client.on('add_entity', (packet) => this._trackEntity(packet, 'mob'));
      this.client.on('add_player', (packet) => this._trackEntity(packet, 'player'));
      this.client.on('set_entity_data', (packet) => this._applyEntityMetadata(packet));
      this.client.on('update_attributes', (packet) => this._applyEntityAttributes(packet));
      this.client.on('entity_event', (packet) => this._onEntityEvent(packet));
      this.client.on('set_time', (packet) => this._recordTime(packet.time));
      // Il sonno viene annunciato anche con un level_event: conferma
      // indipendente dal flag resting, che il server non sempre aggiorna.
      this.client.on('level_event', (packet) => this._onLevelEvent(packet));
      this.client.on('sync_world_clocks', (packet) => this._onWorldClocks(packet));
      this.client.on('respawn', (packet) => this._onRespawnPacket(packet));
      // Diagnostica opzionale (PACKET_DEBUG=1): logga i nomi dei pacchetti
      // ricevuti subito dopo una morte, per capire cosa manda (o non manda) il
      // server. Spenta di default: nessun costo a runtime.
      if (process.env.PACKET_DEBUG) {
        this.client.on('packet', (des) => {
          if (this._packetDebugUntil && Date.now() < this._packetDebugUntil) {
            this.log('rx_packet', { name: des?.data?.name });
            if (this._packetDebugHex?.includes(des?.data?.name)) {
              this.log('rx_hex', { name: des.data.name, bytes: (des.buffer || des.fullBuffer)?.toString('hex').slice(0, 400) });
            }
          }
          // Anche la sonda delle interazioni entità vuole i nomi dei pacchetti
          // del suo turno: `_rxLog` è un anello corto, letto e svuotato dalla sonda.
          if (this._rxLog && des?.data?.name) {
            this._rxLog.push({ name: des.data.name, at: Date.now() });
            if (this._rxLog.length > 200) this._rxLog.shift();
          }
        });
      }
      this.client.on('move_entity', (packet) => this._onEntityMove(packet));
      this.client.on('move_entity_delta', (packet) => this._onEntityMove(packet));
      this.client.on('remove_entity', (packet) => this._onEntityRemove(packet));

      await new Promise((resolve, reject) => {
        const finish = error => {
          clearTimeout(to);
          client.off('spawn', onSpawn);
          client.off('close', onClose);
          client.off('error', onError);
          if (error) reject(error); else resolve();
        };
        const onSpawn = () => finish();
        const onClose = () => finish(new Error(client._lifecycleCloseReason || this.connectError?.message || 'connection closed before spawn'));
        const onError = error => finish(error);
        const to = setTimeout(() => finish(new Error('spawn timeout')), Math.max(CONNECT_TIMEOUT, 45000));
        client.once('spawn', onSpawn);
        client.once('close', onClose);
        client.once('error', onError);
        if (this.spawned) finish();
      });
    } catch (e) {
      await closeBedrockClient(attemptClient, 'failed connection cleanup');
      this.status = 'error';
      this.connectError = e;
      throw e;
    }
  }

  async disconnect (reason = 'adapter disconnect') {
    if (this._disconnecting) return this._disconnecting;
    const client = this.client;
    const connecting = this._connecting;
    if (this._authTickInterval) { clearInterval(this._authTickInterval); this._authTickInterval = null; }
    for (const pending of this._authInputQueue.splice(0)) pending.reject(new Error('connection_lost'));
    // Mark shutdown before abort/close emits callbacks.
    this._disconnecting = Promise.resolve().then(async () => {
      await closeBedrockClient(client, reason);
      this._connectAbort?.abort(new Error('Connection cancelled by shutdown'));
      await connecting?.catch(() => {});
    });
    try {
      await this._disconnecting;
    } finally {
      this._disconnecting = null;
    }
  }

  _refreshNearby () {
    if (!this.position) return;
    this.nearbyBlocks = {};
    for (const name of ['dirt', 'grass_block', 'stone', 'cobblestone', 'coal_ore', 'deepslate_coal_ore', 'iron_ore', 'deepslate_iron_ore', 'copper_ore', 'oak_log', 'spruce_log', 'cherry_log', 'potatoes', 'carrots', 'wheat', 'beetroot']) {
      // Per le colture lo stato di crescita entra nell'osservazione: matura/acerba
      // è ciò che decide se l'azione di raccolta è lecita, e senza numero non si
      // distingue "maturità ignota" da "acerba"
      const crop = isCropBlock(name);
      this.nearbyBlocks[name] = this.world.findBlocks(name, this.position, 96, 4).map(block => {
        const row = { name: block.name, position: block.position, distance: +block.distance.toFixed(1), diggable: block.diggable, hardness: block.hardness };
        const maturity = crop ? cropMaturity(block) : null;
        if (maturity) {
          row.growth = maturity.growth;
          row.maxGrowth = maturity.max;
          row.mature = maturity.mature;
        }
        return row;
      });
    }
    // Bedrock player_position is at eye height (1.62 blocks above the feet).
    this.standingOn = this.world.blockAt({ ...this.position, y: this.position.y - 1.63 })?.name ?? null;
    this._pruneEntities();
    // La vista redstone segue la percezione (ha un TTL proprio, quindi durante il
    // pathfinding non costa nulla).
    this._redstoneCensus();
    // Portali, fuoco, magma e spawner: censimento a TTL, non righe di `nearby`.
    this._netherCensus();
    this._scanValuableOres();
    this._maybeRememberDiscoveries();
  }

  // Ore di valore in vista (diamond, emerald, gold, …): alimenta l'evento
  // VALUABLE_ORE_SEEN e le opzioni mine_<ore> fuori piano. `harvestable` è
  // calcolato qui perché dipende dai dati del blocco (harvestTools) e dal
  // miglior piccone in inventario: il produttore di goal non deve saperlo.
  _scanValuableOres () {
    const now = Date.now();
    const moved = this._lastOreScanPos
      ? Math.hypot(this.position.x - this._lastOreScanPos.x, this.position.z - this._lastOreScanPos.z)
      : Infinity;
    if (this._lastOreScanAt != null && now - this._lastOreScanAt < ORE_SCAN_TTL_MS && moved < ORE_SCAN_MOVE_TOLERANCE) {
      return this.valuableOres ?? [];
    }
    this._lastOreScanAt = now;
    this._lastOreScanPos = { ...this.position };
    if (!this.world || typeof this.world.findBlocks !== 'function') return (this.valuableOres = []);
    const found = [];
    try {
      const pickaxe = this._bestInventoryTool('pickaxe')?.name ?? null;
      for (const name of VALUABLE_ORE_NAMES) {
        for (const block of this.world.findBlocks(name, this.position, ORE_INTEREST_RANGE, 2)) {
          const probe = this.world.blockAt(block.position) ?? block;
          const oreName = probe.name ?? name;
          found.push({
            name: oreName,
            position: block.position,
            distance: +block.distance.toFixed(1),
            value: oreValue(oreName),
            harvestable: this._blockHarvestable(probe, pickaxe),
          });
        }
      }
    } catch (error) {
      this.logger?.log?.(`ore scan failed: ${error?.message ?? error}`);
      return (this.valuableOres = []);
    }
    // Prima il valore, poi la distanza: con MAX_OPTIONS piccolo vince la vena
    // che vale di più, non quella che capita davanti.
    found.sort((a, b) => (b.value - a.value) || (a.distance - b.distance));
    this.valuableOres = found;
    this._alertNewOres(found, now);
    return found;
  }

  // M11: una vena nuova entra in vista → il bot lo dice in chat. Una volta per
  // posizione, un solo avviso per vena (i blocchi adiacenti sono la stessa
  // vena), un cooldown fra due avvisi, e solo se il chiamante ha iniettato il
  // renderer del catalogo. Non annunciate ≠ perdute: restano in attesa e
  // parlano al giro dopo, quando il cooldown è passato.
  _alertNewOres (found = [], now = Date.now()) {
    if (!this.oreAlertCores.size || typeof this.oreAlertText !== 'function') return null;
    const fresh = found.filter(ore => ore?.position
      && this.oreAlertCores.has(oreCore(ore.name))
      && (ore.distance ?? Infinity) <= ORE_ALERT_RANGE
      && !this.oreAlertSeen.has(`${oreCore(ore.name)}@${ore.position.x},${ore.position.y},${ore.position.z}`));
    if (!fresh.length) return null;
    if (this._lastOreAlertAt && now - this._lastOreAlertAt < ORE_ALERT_COOLDOWN_MS) return null;
    const nearest = fresh.slice().sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity))[0];
    const message = this.oreAlertText({ ...nearest });
    if (!message) return null;
    for (const ore of fresh) {
      const near = Math.hypot(
        ore.position.x - nearest.position.x,
        ore.position.y - nearest.position.y,
        ore.position.z - nearest.position.z,
      );
      if (ore === nearest || near <= ORE_ALERT_SPOT_RADIUS) this._rememberOreAlert(ore);
    }
    this._lastOreAlertAt = now;
    this.lastOreAlert = { at: now, name: nearest.name, position: nearest.position, distance: nearest.distance ?? null };
    this.logger?.log?.(`ore_alert ${JSON.stringify(this.lastOreAlert)}`);
    try {
      this.sendChat(message);
    } catch (error) {
      this.logger?.log?.(`ore_alert failed: ${error?.message ?? error}`);
    }
    return nearest;
  }

  _rememberOreAlert (ore) {
    this.oreAlertSeen.add(`${oreCore(ore.name)}@${ore.position.x},${ore.position.y},${ore.position.z}`);
    while (this.oreAlertSeen.size > ORE_ALERT_SEEN_MAX) {
      this.oreAlertSeen.delete(this.oreAlertSeen.values().next().value);
    }
  }

  // Producer di memoria: registra scoperte dal mondo (portali, siti di risorse,
  // entità notevoli). Ri-scansiona al cambio di chunk, e comunque non più spesso
  // di ogni DISCOVERY_RESCAN_MS: la prima scansione di un chunk può girare a
  // mondo non ancora caricato, quindi il dedup puramente per-chunk non basta.
  _maybeRememberDiscoveries () {
    if (!this.memory || !this.position) return;
    const key = `${Math.floor(this.position.x / 16)},${Math.floor(this.position.z / 16)}`;
    const now = Date.now();
    if (this._lastDiscoveryChunk === key && now - this._lastDiscoveryAt < DISCOVERY_RESCAN_MS) return;
    this._lastDiscoveryChunk = key;
    this._lastDiscoveryAt = now;
    this._rememberDiscoveries();
  }

  _rememberDiscoveries () {
    const pos = this.position;
    try {
      // Portale Nether (blocco 'portal'): il landmark serve al viaggio fra i due lati.
      const portal = this.world.findBlocks('portal', pos, 32, 1)[0];
      if (portal) this.memory.rememberPortal({ position: portal.position, portalType: 'nether', source: 'observed' });
      // Sito di risorse: ore osservate, dedup per chunk. Scansione autonoma (non
      // dipende da nearbyBlocks, che durante il pathfinding può essere stantio).
      const ores = new Set();
      let nearest = null;
      for (const name of ['coal_ore', 'deepslate_coal_ore', 'iron_ore', 'deepslate_iron_ore',
        'copper_ore', 'deepslate_copper_ore', 'gold_ore', 'deepslate_gold_ore',
        'redstone_ore', 'deepslate_redstone_ore', 'lapis_ore', 'deepslate_lapis_ore',
        'diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'deepslate_emerald_ore']) {
        const found = this.world.findBlocks(name, pos, 32, 1)[0];
        if (!found) continue;
        ores.add(name.replace(/^deepslate_/, ''));
        if (!found.position) continue; // visto in palette ma il blocco non è leggibile
        // Il sito ricorda il *blocco* di minerale più vicino, non il centro del
        // chunk: il centro sta a 8 blocchi di distanza e un `goto_waypoint` dalla
        // memoria portava lì invece che sul filone (finding 06/10/2026: filone a
        // z=232, memoria a z=231). Il centro resta solo come ripiego.
        const distance = found.distance ?? Math.hypot(
          found.position.x - pos.x, found.position.y - pos.y, found.position.z - pos.z,
        );
        if (!nearest || distance < nearest.distance) nearest = { ...found.position, distance };
      }
      if (ores.size) {
        const cx = Math.floor(pos.x / 16), cz = Math.floor(pos.z / 16);
        this.memory.rememberResourceSite({
          id: `resource_site_${cx}_${cz}`,
          kind: pos.y < 62 ? 'cave' : 'surface_ores',
          position: nearest
            ? { x: nearest.x, y: nearest.y, z: nearest.z }
            : { x: cx * 16 + 8, y: pos.y, z: cz * 16 + 8 },
          observations: [...ores],
          source: 'observed',
        });
      }
      // Entità notevoli (cavalcabili: cavallo/asino/mulo/…).
      for (const entity of this.entities.values()) {
        if (entity.uniqueId == null || !entity.position) continue;
        if (!isRideableType(entity.type)) continue;
        this.memory.rememberEntity({ id: `entity_${entity.uniqueId}`, type: entity.type, position: entity.position, state: {}, source: 'observed' });
      }
      // Chunk visitato (con bioma): alimenta la chunk memory e la frontiera.
      const biome = typeof this.world.biomeAt === 'function' ? this.world.biomeAt(pos) : null;
      this.memory.markChunkVisited({
        x: Math.floor(pos.x / 16),
        z: Math.floor(pos.z / 16),
        dimension: this.dimension,
        biome,
        y: pos.y,
      });
      // Checkpoint di missione: sparsi (non a ogni movimento), per ricostruire la rotta.
      if (this.missionId && this.memory.getMission(this.missionId)) {
        const last = this.memory.lastCheckpoint(this.missionId);
        const moved = last ? Math.hypot(last.position.x - pos.x, last.position.z - pos.z) : Infinity;
        if (moved >= CHECKPOINT_MIN_DISTANCE) this.memory.addCheckpoint(this.missionId, pos, { biome });
      }
      // Contenitori visibili: registrati come *scoperte* (dove sono, non cosa
      // contengono) — è la sorgente del gradino 2 della scala del deposito.
      this._surveyStorage();
      // Strutture/ambienti nell'area caricata (throttled a livello di metodo).
      this._surveyStructures();
    } catch (error) {
      this.log('memory_discovery_error', { message: error.message });
    }
  }

  // Ricognizione di strutture e ambienti (spec M5/M6): istogramma dei blocchi
  // caricati + entità percepite → detector deterministico (`structures.mjs`) →
  // landmark `kind: structure` in memoria. Un tipo senza marker non compare:
  // vedi la soglia `minScore` per tipo (un muro di letti non è un villaggio).
  _surveyStructures ({ radius = STRUCTURE_RADIUS, limit = STRUCTURE_SURVEY_LIMIT, force = false } = {}) {
    const now = Date.now();
    if (!force && now - this._structureSurveyAt < STRUCTURE_RESCAN_MS) return this.structures;
    if (!this.spawned || !this.position || typeof this.world?.surveyBlocks !== 'function') return this.structures;
    this._structureSurveyAt = now;
    try {
      const survey = this.world.surveyBlocks(this.position, radius, { limit });
      const found = detectStructures({
        survey: survey.names,
        entities: this._nearbyEntities(24),
        position: this.position,
        dimension: this.dimension,
      });
      this.structures = found.slice(0, 8);
      this._structureSurvey = {
        at: now,
        radius,
        scanned: survey.scanned,
        distinct: survey.distinct,
        truncated: survey.truncated,
        found: this.structures.map(s => s.id),
        // I nomi visti nell'area (i più frequenti): senza di loro una detection
        // vuota non è diagnosticabile ("perché nessun villaggio?" → manca il
        // marker o manca l'area?).
        names: [...survey.names.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 12).map(([name, row]) => ({ name, count: row.count })),
      };
      for (const structure of this.structures) {
        this.memory?.rememberStructure({
          type: structure.type,
          label: structure.label,
          dimension: structure.dimension,
          position: structure.position,
          confidence: structure.confidence,
          evidence: structure.evidence,
          source: 'detected',
        });
        this.log('structure_detected', {
          type: structure.type,
          position: structure.position,
          confidence: structure.confidence,
          evidence: structure.evidence,
        });
      }
    } catch (error) {
      this.log('structure_survey_failed', { message: error.message });
    }
    return this.structures;
  }

  // Le celle che il censimento sa leggere: letti, colture e recinti. La survey
  // dice *quali nomi esistono* nell'area (i recinti sono una famiglia, non un
  // nome) e `findBlocks` ne prende le posizioni, con un tetto per nome. Quando un
  // nome tocca il tetto il conteggio è un minimo, non un fatto: la vista lo dice
  // (`blocks.capped`), invece di far sembrare il mondo più piccolo di com'è.
  _villageCells ({ point = null, radius = STRUCTURE_RADIUS, limit = STRUCTURE_SURVEY_LIMIT } = {}) {
    const center = point ?? this.position;
    if (!center || !this.world?.findBlocks) return { cells: {}, histogram: null, stats: null };
    let stats = null;
    let histogram = null;
    let names = villageCensusNames([]);
    if (typeof this.world?.surveyBlocks === 'function') {
      try {
        const survey = this.world.surveyBlocks(center, radius, { limit });
        if (typeof survey?.names?.keys === 'function') histogram = survey.names;
        if (histogram) names = villageCensusNames([...histogram.keys()]);
        stats = { scanned: survey?.scanned ?? 0, distinct: survey?.distinct ?? 0, truncated: survey?.truncated === true };
      } catch (error) {
        this.log('village_survey_failed', { message: error.message });
      }
    }
    const cells = {};
    const capped = [];
    for (const name of names) {
      let found = [];
      try { found = this.world.findBlocks(name, center, radius, VILLAGE_CELL_CAP) || []; } catch { found = []; }
      if (!found.length) continue;
      if (found.length >= VILLAGE_CELL_CAP) capped.push(name);
      cells[name] = found.map(block => ({
        name,
        position: block.position,
        mature: isCropBlock(name) ? this._cropMature(block) : null,
      }));
    }
    return { cells, histogram, stats: stats ? { ...stats, capped } : null };
  }

  // Maturità di una cella di coltura. `cropMaturity` può non sapere (blocco non
  // ancora materializzato): allora si rilegge la colonna viva, e se nemmeno
  // quella risponde la cella resta `unknown` — mai indovinata.
  _cropMature (block) {
    const read = candidate => {
      try { return cropMaturity(candidate); } catch { return null; }
    };
    let state = read(block);
    if ((!state || typeof state.mature !== 'boolean') && block?.position && typeof this.world?.blockAt === 'function') {
      try { state = read(this.world.blockAt(block.position)); } catch { state = null; }
    }
    return state && typeof state.mature === 'boolean' ? state.mature : null;
  }

  // V0 — la vista del sito: un censimento *puro* (`village-survey.mjs`) alimentato
  // da fatti raccolti qui (celle, letti con occupazione, contenitori del registro,
  // entità). `entities` è l'evidenza del detector (villager inclusi) e resta
  // distinta da `farmAnimals`, che vive nei recinti. È memoizzata perché
  // `observe()` la legge a ogni passo: `force` rifà subito lo scan (diagnostica).
  _villageView ({ force = false, limits = {} } = {}) {
    const now = Date.now();
    if (!force && this._villageCache && now - this._villageCache.at < VILLAGE_RESCAN_MS) return this._villageCache.payload;
    this._surveyStructures({ force });
    const { cells, histogram, stats } = this._villageCells({});
    const storage = this._storageView();
    const payload = {
      ...surveyVillage({
        nearby: cells,
        farmAnimals: this._nearbyFarmAnimals(24),
        entities: this._nearbyEntities(24),
        beds: this._findBeds(),
        containers: [
          ...storage.known.map(row => ({ ...row, contentsKnown: true })),
          ...storage.toInspect.map(row => ({ position: row.position, type: row.type, contains: null, contentsKnown: false, status: row.status })),
        ],
        anchor: this.structures?.find(found => found.type === 'village')?.position ?? null,
        survey: histogram,
        dimension: this.dimension,
        scanned: stats?.scanned ?? null,
        limits: { plotMinCells: VILLAGE_PLOT_MIN, ...limits },
      }),
      at: now,
      origin: this.position ? { x: this.position.x, y: this.position.y, z: this.position.z } : null,
      blocks: stats ? { distinct: stats.distinct, truncated: stats.truncated, capped: stats.capped.length > 0, cappedNames: stats.capped } : null,
      // I limiti del *sensore*, separati dalle soglie del censimento
      // (`thresholds` nel payload puro): il raggio caricato e il tetto per nome
      // sono la forma del fatto, non una regola di clustering.
      limits: {
        radius: STRUCTURE_RADIUS,
        cellCap: VILLAGE_CELL_CAP,
        rescanMs: VILLAGE_RESCAN_MS,
        surveyRadius: VILLAGE_SURVEY_RADIUS,
        maxDistance: VILLAGE_SURVEY_MAX_DISTANCE,
      },
    };
    this._villageCache = { at: now, payload };
    return payload;
  }

  // ── V1: la passata sul villaggio ───────────────────────────────────────────
  //
  // `survey_village` non è un secondo motore d'esplorazione: la geometria la
  // decide `planExplorationSweep` con la configurazione di `villageSweepConfig`,
  // quindi il piano è funzione di `(anchor, visited, config)` e sopravvive alla
  // serializzazione. Qui restano le tre cose che un planner puro non può
  // conoscere — l'orologio, il mondo caricato e gli inciampi del pathfinding —
  // più i rifiuti tipizzati.

  // L'ancora del sito: la struttura rilevata, o (se la ricognizione strutture non
  // è ancora passata) la vista censimento. Mai la posizione del bot: inventare un
  // centro quando il villaggio non è identificato sarebbe esplorare, non censire.
  _villageAnchor () {
    let detected = this.structures?.find(found => found.type === 'village');
    if (!detected && this.spawned && this.position) {
      detected = this._surveyStructures()?.find(found => found.type === 'village');
    }
    return detected?.position ?? this._villageCache?.payload?.anchor ?? null;
  }

  _villageSweepRemaining () {
    if (!this._villageSweep) return 0;
    return Math.max(0, VILLAGE_SURVEY_MS - (Date.now() - this._villageSweep.at));
  }

  // Le celle già censite per *questo* sito: dal registro (sopravvive al riavvio) e,
  // se la passata in RAM riguarda la stessa ancora, anche da lì. Sono chiavi di
  // chunk, la forma che il planner riceve in `visited`.
  _villageVisited (anchor) {
    const keys = new Set();
    const recorded = this.memory?.villageSurvey?.({ near: anchor, radius: VILLAGE_MEMORY_RADIUS, dimension: this.dimension }) ?? null;
    if (recorded && Math.hypot(recorded.position.x - anchor.x, recorded.position.z - anchor.z) <= VILLAGE_MEMORY_RADIUS) {
      for (const key of recorded.cells ?? []) keys.add(key);
    }
    const last = this._villageSweep;
    if (last?.anchor && Math.hypot(last.anchor.x - anchor.x, last.anchor.z - anchor.z) <= VILLAGE_MEMORY_RADIUS) {
      for (const key of last.cells ?? []) keys.add(key);
    }
    return [...keys];
  }

  // `limits` è una presa di prova (come `_villageView`): l'azione nelle mani di un
  // client usa sempre i tre limiti dalle costanti, i test devono poter
  // raggiungere un tetto senza camminare per migliaia di celle.
  async _surveyVillage ({ signal = null, limits: overrides = {} } = {}) {
    const started = Date.now();
    const cooldownMs = overrides.cooldownMs ?? VILLAGE_SURVEY_MS;
    const cellsBudget = overrides.cells ?? VILLAGE_SURVEY_CELLS;
    const maxMs = overrides.maxMs ?? VILLAGE_SURVEY_MAX_MS;
    const maxDistance = overrides.maxDistance ?? VILLAGE_SURVEY_MAX_DISTANCE;
    const limits = { cooldownMs, cells: cellsBudget, maxMs, maxDistance };
    const view = this._villageView({ force: true });
    const anchor = view.anchor ?? this._villageAnchor();
    if (!anchor) {
      return { ok: false, error: 'village_unknown', action: 'survey_village', hint: 'nessun villaggio identificato: la passata non inventa un centro' };
    }
    const distance = this.position ? Math.hypot(anchor.x - this.position.x, anchor.z - this.position.z) : Infinity;
    if (distance > maxDistance) {
      return { ok: false, error: 'village_too_far', action: 'survey_village', anchor, distance: Math.round(distance), maxDistance, hint: 'la missione non è partita: raggiungere il sito è un viaggio, non una ricognizione' };
    }
    const remainingMs = this._villageSweepRemaining();
    if (remainingMs > 0) {
      return { ok: false, error: 'survey_cooldown', action: 'survey_village', anchor, remainingMs, cooldownMs, hint: 'una passata è già stata fatta da poco: il cooldown è un rifiuto, non un troncamento' };
    }
    const visited = this._villageVisited(anchor);
    const plan = planExplorationSweep(villageSweepConfig({ anchor, visited }));
    if (!plan.ok) return { ok: false, error: plan.error ?? 'no_anchor', action: 'survey_village', anchor };

    const cells = new Set(visited);
    // Il censimento è una scansione di raggio `VILLAGE_SURVEY_RADIUS` intorno al
    // bot: il chunk dove si trova *all'inizio della passata* è già stato guardato,
    // ma solo se si trova dentro l'area assegnata.
    if (this.position && Math.hypot(this.position.x - anchor.x, this.position.z - anchor.z) <= VILLAGE_SURVEY_RADIUS) {
      cells.add(chunkKey(this.position.x, this.position.z));
    }
    const steps = [];
    const censuses = [];
    let budget = cellsBudget;
    let stoppedBy = plan.stoppedBy;
    let truncated = plan.truncated;
    let blocked = false;
    let lastView = view;

    for (const waypoint of plan.waypoints) {
      const spent = Date.now() - started;
      if (spent >= maxMs) { stoppedBy = 'time'; truncated = true; break; }
      if (budget <= 0) { stoppedBy = 'cells'; truncated = true; break; }
      const target = { x: waypoint.x, y: this.position?.y ?? 70, z: waypoint.z };
      let reached = true;
      let error = null;
      try {
        await this._moveTo(target, 2, Math.max(1000, maxMs - spent), { signal });
      } catch (caught) {
        reached = false;
        error = caught?.message ?? String(caught);
      }
      // Solo un waypoint *raggiunto* è una cella censita: il censimento avviene
      // dove il bot si trova, quindi segnare la cella di un waypoint fallito
      // farebbe saltare per sempre un'area che nessuno ha guardato.
      if (reached) cells.add(chunkKey(waypoint.x, waypoint.z));
      this.memory?.markChunkVisited?.({
        x: Math.floor(waypoint.x / 16),
        z: Math.floor(waypoint.z / 16),
        dimension: this.dimension,
        biome: typeof this.world?.biomeAt === 'function' ? this.world.biomeAt(this.position) : null,
        y: this.position?.y ?? 64,
      });
      steps.push({ x: waypoint.x, z: waypoint.z, distance: waypoint.distance, ok: reached, error, ms: Date.now() - started - spent });
      const census = this._villageView({ force: true, limits: { maxCells: budget } });
      lastView = census;
      const scanned = census.survey?.cells ?? 0;
      budget -= scanned;
      censuses.push({
        x: waypoint.x,
        z: waypoint.z,
        cells: scanned,
        dropped: census.survey?.dropped ?? 0,
        truncated: census.survey?.truncated === true,
        detection: census.detection?.state ?? null,
        counts: census.counts ?? null,
      });
      if (census.survey?.truncated) { stoppedBy = 'cells'; truncated = true; break; }
      if (error) { blocked = true; break; }
    }

    // Il registro contiene solo le celle *effettivamente* censite — quelle
    // raggiunte — quindi resta vero anche quando la passata è troncata: il giro
    // successivo riparte da dove questo si è fermato. Una passata interrotta da un
    // waypoint non raggiungibile non ha guardato il resto del piano, ma quello che
    // ha guardato lo ha guardato davvero.
    const record = this.memory?.rememberVillageSurvey?.({
      position: anchor,
      dimension: this.dimension,
      cells: [...cells],
      radius: VILLAGE_SURVEY_RADIUS,
      source: 'survey_village',
    }) ?? null;
    this._villageSweep = { at: Date.now(), anchor, cells: [...cells], stoppedBy, truncated, blocked };

    return {
      ok: true,
      action: 'survey_village',
      anchor,
      config: plan.config,
      planned: plan.planned,
      walked: steps.length,
      blocked,
      visited: cells.size,
      stoppedBy,
      truncated,
      complete: !truncated && !blocked,
      boundary: plan.boundary,
      budget: { cells: cellsBudget, remaining: Math.max(0, budget) },
      limits,
      steps,
      censuses,
      survey: record ? { id: record.id, censuses: record.censuses, cells: record.cells.length } : null,
      view: lastView ? { checked: lastView.checked, anchor: lastView.anchor, detection: lastView.detection, counts: lastView.counts, survey: lastView.survey, blocks: lastView.blocks } : null,
      ms: Date.now() - started,
    };
  }

  _refreshInventory () {
    this.inventory = { ...this.pickups };
    for (const item of this.inventorySlots) {
      if (!item?.network_id) continue;
      // Uno slot a zero è uno slot vuoto: il `|| 1` copre i pacchetti che
      // omettono il count, non le pile esaurite (altrimenti un drop fino a zero
      // resterebbe contato come 1 e l'ordine "getta <oggetto>" non si chiuderebbe).
      const amount = item.count == null ? 1 : item.count;
      if (amount <= 0) continue;
      const name = item.name || this.world.registry?.items[item.network_id]?.name || `item_${item.network_id}`;
      this.inventory[name] = (this.inventory[name] || 0) + amount;
    }
  }

  // Conferma del pickup di un item entity: BDS con inventario server-authoritative
  // non invia un aggiornamento di slot al pickup, quindi la stima `pickups` si
  // aggiorna qui. Il drop raccolto esce dalla lista in ogni caso (l'entità non
  // esiste più), quindi un pacchetto ripetuto non conta due volte.
  _onTakeItemEntity (packet) {
    const drop = this._findDropPacket(packet);
    const target = packet.target ?? packet.runtime_entity_id;
    const mine = !!drop && String(target) === String(this.client?.entityId);
    if (mine) {
      const name = drop.item;
      this.pickups[name] = (this.pickups[name] || 0) + (drop.count || 1);
      this._refreshInventory();
    }
    this.drops = this.drops.filter(d => String(d.runtime_id) !== String(packet.runtime_entity_id) && String(d.id) !== String(packet.runtime_entity_id));
    return drop
      ? { ok: true, taken: mine, item: drop.item, count: drop.count || 1, inventory: this.inventory }
      : { ok: false, error: 'unknown_drop', inventory: this.inventory };
  }

  _findDropPacket (packet) {
    return this.drops.find(d => String(d.runtime_id) === String(packet.runtime_entity_id) || String(d.id) === String(packet.runtime_entity_id));
  }

  // Alla morte il server fa cadere tutto l'inventario del giocatore: lo specchio
  // locale va svuotato subito, altrimenti i drop raccolti al sito di morte si
  // sommano a un inventario che il server ha già svuotato e il conteggio
  // raddoppia. Visto live il 06/10 sulla missione diamanti: `iron_ingot` 64→128,
  // `coal` 64→128, `diamond` 3→5 — e da lì il deposito in loop con
  // `take_failed_49`, perché l'aggregato gonfiato chiedeva al cursore uno stack
  // che il server non aveva.
  _forgetDroppedInventory (reason = 'death') {
    const forgotten = { ...this.inventory };
    this.pickups = {};
    this.inventorySlots = [];
    this._refreshInventory();
    this.log('inventory_mirror_reset', {
      reason,
      forgotten: Object.entries(forgotten)
        .filter(([, count]) => count > 0)
        .map(([item, count]) => `${item}:${count}`)
        .join(' ') || null,
    });
    return forgotten;
  }

  // La stima `pickups` è superata da uno snapshot completo dell'inventario del
  // giocatore: sommarla allo snapshot è l'altra faccia dello stesso doppio
  // conteggio (slot: `diamond 2`, pickups: `diamond 3` → aggregato 5). Uno
  // snapshot *vuoto* non assorbe nulla: può essere un sync stantio e non deve
  // azzerare un pickup appena fatto.
  _absorbPickups (reason = 'inventory_snapshot') {
    const absorbed = Object.entries(this.pickups).filter(([, count]) => count > 0);
    if (!absorbed.length) return null;
    this.pickups = {};
    this.log('pickups_absorbed', {
      reason,
      absorbed: absorbed.map(([item, count]) => `${item}:${count}`).join(' '),
    });
    return Object.fromEntries(absorbed);
  }

  // Contenuto della finestra del giocatore in `inventory_content`: è la verità sugli
  // slot e arriva come risposta del server a una nostra richiesta (`open_inventory`
  // o un resync), quindi è più fresco della stima `pickups`.
  _applyPlayerInventorySnapshot (slotList, { containerId = null } = {}) {
    const isPlayerContainer = containerId == null || containerId === 'hotbar' || containerId === 'inventory' || containerId === 'hotbar_and_inventory';
    // Alcuni sync etichettano il contenuto del giocatore con un container
    // inatteso ma 36 slot pieni: accettali; gli stessi pacchetti vuoti
    // vanno applicati solo se non c'è nulla da perdere (altrimenti wipe).
    const isFullPlayerInventory = slotList.length === 36 && slotList.some(s => s?.network_id);
    const clearWhenEmpty = slotList.length === 36 && !this.inventorySlots.some(s => s?.network_id);
    if (containerId === 'crafting_input') return false;
    // Un contenuto *corto* non è mai uno snapshot dell'inventario: applicarlo
    // azzera gli slot che non porta (live 06/10 dopo una riconnessione: uno
    // `inventory_content` senza slot lasciò lo specchio a 0 e ogni `take_*`
    // rispose `take_failed_49`). I cambi di un singolo slot arrivano da
    // `inventory_slot`, quindi qui si accettano solo i 36 slot pieni; un
    // contenuto corto viene ignorato e loggato invece di svuotare lo specchio.
    if (slotList.length !== 36) {
      this.log('inventory_snapshot_ignored', {
        container: containerId ?? null,
        slots: slotList.length,
        mirror: this.inventorySlots.filter(s => s?.network_id).length,
      });
      return false;
    }
    if (!(isPlayerContainer || isFullPlayerInventory || clearWhenEmpty)) return false;
    this.inventorySlots = slotList;
    if (isFullPlayerInventory) this._absorbPickups('inventory_snapshot');
    this._refreshInventory();
    this._playerSnapshotCount++;
    for (const waiter of this._playerSnapshotWaiters.splice(0)) waiter(this._playerSnapshotCount);
    return true;
  }

  // ---- ricette -----------------------------------------------------------------------

  _indexRecipes (packet) {
    const byOutput = new Map();
    const add = (kind, recipe) => {
      for (const out of recipe.output || []) {
        const name = out.name || this.world.registry?.items[out.network_id]?.name;
        if (!name) continue;
        const list = byOutput.get(name) || [];
        list.push({ kind, recipe_id: recipe.recipe_id, network_id: recipe.network_id, output: out.count || 1 });
        byOutput.set(name, list);
      }
    };
    for (const recipe of packet.shaped_recipes || []) add('shaped', recipe);
    for (const recipe of packet.shapeless_recipes || []) add('shapeless', recipe);
    this.craftingData = packet;
    this.recipes = byOutput;
    // Le ricette di fusione arrivano nello stesso pacchetto: input_id (network id)
    // + output; i nomi si risolvono quando serve, dopo item_registry.
    this.furnaceRecipes = packet.furnace_recipes || [];
    const counts = { shaped: packet.shaped_recipes?.length || 0, shapeless: packet.shapeless_recipes?.length || 0, multi: packet.multi_recipes?.length || 0, furnace: this.furnaceRecipes.length };
    this.log('crafting_data', { ...counts, indexedOutputs: byOutput.size });
    // Campione di ricette di progressione: i descrittori live decidono la scelta variante.
    for (const sample of ['wooden_pickaxe', 'stone_pickaxe']) {
      const entries = (byOutput.get(sample) || []).map(entry => {
        const body = this._recipeBody(entry);
        return {
          network_id: entry.network_id, kind: entry.kind,
          width: body?.width, height: body?.height,
          input: (body?.input || []).map(ingredient => ingredient.type !== 'valid' ? null
            : (ingredient.descriptor_type === 'item_tag' ? `tag:${ingredient.tag}` : `name:${ingredient.name}`)),
        };
      });
      this.log('recipe_sample', { item: sample, entries: JSON.stringify(entries) });
    }
  }

  // Sessione viva: spawn avvenuto e stato `spawned`. Non dice nulla su morte o
  // sonno — un bot morto o addormentato e' connesso, e in quei due casi `wait` e'
  // davvero l'unica azione (respawn e sveglia automatici). Su `client_close`
  // l'adapter azzera spawn/stato: e' la stessa condizione che durante il wedge del
  // 07/10/2026 faceva credere al controller di avere una sola azione valida.
  get sessionLive () {
    return this.spawned === true && this.status === 'spawned';
  }

  pos () {
    if (!this.position) return null;
    // Posizione esatta (2 decimali): il vecchio harness riportava interi, ma con
    // gli interi la distanza dal waypoint balla di ~1 blocco e il controller
    // continua a scegliere goto anche quando è arrivato.
    return {
      x: +this.position.x.toFixed(2),
      y: +this.position.y.toFixed(2),
      z: +this.position.z.toFixed(2),
    };
  }

  // ---- fluidi (M0 di docs/wiki/fluids.md) --------------------------------------------
  //
  // Il bot non nuota ancora (M1) e non respira (M2): qui impara a *vedere* acqua e
  // lava, a trattare la lava come pericolo assoluto e a rifiutare gli scavi che
  // aprirebbero un varco verso un fluido.

  _fluidKindAt (x, y, z) {
    return fluidKind(this.world.blockAt({ x, y, z })?.name);
  }

  // Le sei celle attorno a un blocco che sta per essere rimosso.
  _fluidNeighbors (cell) {
    const out = [];
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
      const position = { x: cell.x + dx, y: cell.y + dy, z: cell.z + dz };
      out.push({ name: this.world.blockAt(position)?.name, position });
    }
    return out;
  }

  // Censimento di acqua/lava nell'area caricata, con TTL: `findBlocks` su quattro
  // nomi non è gratis e `/observe` viene interrogata di continuo. Un mondo senza
  // `findBlocks` (fixture dei test) semplicemente non produce censimento.
  _fluidCensus ({ force = false } = {}) {
    const now = Date.now();
    if (!force && this._fluidScan && now - this._fluidScanAt < FLUID_RESCAN_MS) return this._fluidScan;
    const found = [];
    if (this.position && typeof this.world?.findBlocks === 'function') {
      for (const name of ['water', 'flowing_water', 'lava', 'flowing_lava']) {
        for (const block of this.world.findBlocks(name, this.position, FLUID_SCAN_RADIUS, FLUID_SCAN_LIMIT)) {
          found.push({ name, position: block?.position ?? block });
        }
      }
    }
    const summary = summarizeFluids(found, this._feet ?? this.position);
    // M3: cascate e colonne di bolle nascono dalle stesse celle d'acqua. Il
    // verdetto sull'atterraggio guarda il mondo *sotto* la colonna: se il chunk
    // non è caricato l'atterraggio resta ignoto e la colonna non si usa.
    const from = this._feet ?? this.position;
    const blockAt = typeof this.world?.blockAt === 'function' ? (position => this.world.blockAt(position) ?? null) : null;
    const waterfalls = findWaterfalls(found, { from, blockAt });
    const bubbles = findBubbleColumns(found, { from, blockAt });
    // Appena connessi il mondo può non avere ancora nessuna colonna caricata: un
    // censimento vuoto in quel momento direbbe "nessuna lava" per un mondo che non
    // abbiamo ancora guardato. Non si mette in cache e si dichiara `ready: false`,
    // così la consapevolezza si recupera al primo tick con i chunk caricati.
    const loaded = this.world?.loaded?.size ?? null;
    const ready = loaded !== 0;
    const census = { ...summary, cells: fluidCells(found), waterfalls, bubbles, scanned: found.length, loaded, ready, at: now };
    if (!ready) return census;
    this._fluidScan = census;
    this._fluidScanAt = now;
    this._lavaCells = new Set(census.cells.lava.map(p => `${p.x},${p.y},${p.z}`));
    return this._fluidScan;
  }

  // Vista compatta per /observe: stato delle celle del bot (letto ogni volta) +
  // censimento (in cache) + verdetto di pericolo.
  _fluidsView ({ force = false, cells = false } = {}) {
    const feet = this._feet
      ? { x: Math.floor(this._feet.x), y: Math.floor(this._feet.y + 0.1), z: Math.floor(this._feet.z) }
      : null;
    const head = feet ? { x: feet.x, y: feet.y + 1, z: feet.z } : null;
    const inWater = feet ? this._fluidKindAt(feet.x, feet.y, feet.z) === 'water' : false;
    const headInWater = head ? this._fluidKindAt(head.x, head.y, head.z) === 'water' : false;
    const inLava = feet ? this._fluidKindAt(feet.x, feet.y, feet.z) === 'lava' : false;
    const census = this._fluidCensus({ force });
    const air = Number.isFinite(this.air) ? this.air : null;
    const view = {
      inWater,
      headInWater,
      inLava,
      wading: this._wading(),
      air,
      airSource: this.airSource,
      airSeconds: airSeconds(air),
      waterBreathing: this._waterBreathing(),
      water: census.water,
      // M1: dove l'acqua è abbastanza profonda da immergere la testa. La cella
      // più vicina non basta: per misurare i ratei del nuoto (e per pianificare
      // una discesa) serve una colonna, non un punto.
      deepestWater: deepWaterColumns(census.cells?.water ?? [], {
        blockAt: typeof this.world?.blockAt === 'function' ? (p => this.world.blockAt(p) ?? null) : null,
        minDepth: 2,
        limit: 3,
      }),
      lava: census.lava,
      waterDistance: census.waterDistance,
      lavaDistance: census.lavaDistance,
      // M3: cascata e colonna di bolle più vicine (forma compatta) e se il bot è
      // già dentro una cascata (`onWaterfall`, condizione del governor).
      waterfall: summarizeColumn(census.waterfalls?.[0] ?? null, this._feet ?? null),
      bubbleColumn: summarizeColumn(census.bubbles?.[0] ?? null, this._feet ?? null),
      onWaterfall: withinColumn(census.waterfalls?.[0] ?? null, this._feet ?? null),
      hazard: fluidHazard({ inWater, headInWater, inLava, lavaDistance: census.lavaDistance, air }),
      scanned: census.scanned,
      ready: census.ready !== false,
      at: census.at,
    };
    // Le celle servono solo alla diagnostica (`/observe.fluids`): tenerle fuori
    // da /observe evita di gonfiare la percezione del controller.
    if (cells) view.cells = census.cells;
    return view;
  }

  // ---- Deep Dark (W0 di docs/raw/DEEP_DARK_ROADMAP.md) ------------------------
  // Sensori, shrieker e celle sculk nell'area caricata. Il censimento è throttled
  // come quello dei fluidi e, come quello, **non** si mette in cache appena
  // connessi: un mondo non ancora caricato non è un Deep Dark silenzioso
  // (`ready: false`), quindi la consapevolezza si recupera al primo tick pieno.
  _sculkCensus ({ force = false } = {}) {
    const now = Date.now();
    if (!force && this._sculkScan && now - this._sculkScanAt < SCULK_RESCAN_MS) return this._sculkScan;
    const point = this.position ?? this._feet ?? null;
    const sensors = [], shriekers = [], blocks = [];
    const find = typeof this.world?.findBlocks === 'function' ? this.world.findBlocks.bind(this.world) : null;
    const propertiesAt = position => {
      const block = this.world?.blockAt?.(position) ?? null;
      try { return block?.getProperties?.() ?? null; } catch { return null; }
    };
    if (find && point) {
      for (const name of SCULK_SENSORS) {
        for (const row of find(name, point, SCULK_SCAN_RADIUS, SCULK_SCAN_LIMIT)) {
          const position = row?.position ?? row;
          sensors.push({ name, position, distance: +(row?.distance ?? 0).toFixed(2), ...sensorPhase(propertiesAt(position)) });
        }
      }
      for (const name of SCULK_SHRIEKERS) {
        for (const row of find(name, point, SCULK_SCAN_RADIUS, SCULK_SCAN_LIMIT)) {
          const position = row?.position ?? row;
          shriekers.push({ name, position, distance: +(row?.distance ?? 0).toFixed(2), ...shriekerState(propertiesAt(position)) });
        }
      }
      for (const name of SCULK_FAMILY) for (const row of find(name, point, SCULK_SCAN_RADIUS, SCULK_SCAN_LIMIT)) blocks.push({ name, position: row?.position ?? row });
    }
    // Ogni shrieker che *sta* shriekando è un allarme in corso; quando smette, il
    // suo shriek è consumato (il conteggio vero del server non è osservabile) e
    // gli restano solo le voci dentro la finestra.
    const activeKeys = new Set(shriekers.filter(row => row.active === true).map(row => `${row.position.x},${row.position.y},${row.position.z}`));
    const known = new Set(this._sculkShrieks.map(entry => `${entry.position.x},${entry.position.y},${entry.position.z}`));
    for (const key of activeKeys) if (!known.has(key)) {
      const row = shriekers.find(candidate => `${candidate.position.x},${candidate.position.y},${candidate.position.z}` === key);
      this._sculkShrieks.push({ position: row.position, at: now });
    }
    this._sculkShrieks = this._sculkShrieks.filter(entry => activeKeys.has(`${entry.position.x},${entry.position.y},${entry.position.z}`) || now - entry.at <= SHRIEK_WINDOW_MS);
    const feet = this._feet ? { x: Math.floor(this._feet.x), y: Math.floor(this._feet.y + 0.1), z: Math.floor(this._feet.z) } : null;
    const loaded = this.world?.loaded?.size ?? null;
    const ready = loaded !== 0;
    // Senza censimento pronto il rischio non si calcola: un `count: 0` da un
    // mondo non ancora guardato sarebbe una rassicurazione falsa, e il consumo
    // coerente (`_vibrationRiskAt`) rifiuta solo quando il censimento è pronto.
    const summary = summarizeSculk({ sensors, shriekers, blocks, point: ready ? feet : null });
    const census = {
      ...summary,
      level: this._sculkShrieks.length,
      windowMs: SHRIEK_WINDOW_MS,
      warning: wardenWarning(this._sculkShrieks.length),
      darkness: this.effects?.has?.('darkness') ?? null,
      warden: this._wardenView(),
      shriekerAtBot: shriekerVerdict(feet, shriekers),
      family: SCULK_FAMILY,
      // Le righe complete (`sensorRows`) servono al calcolo del rischio; in testa
      // restano i *conteggi* di `summarizeSculk`, che è il contratto del modulo
      // puro (stessa forma di `summarizeFluids`/`summarizeRedstone`).
      sensorRows: sensors,
      shriekerRows: shriekers,
      scanned: sensors.length + shriekers.length + blocks.length,
      loaded, ready, at: now,
    };
    if (!ready) return census;
    this._sculkScan = census;
    this._sculkScanAt = now;
    return this._sculkScan;
  }

  // Il Warden è cieco e segue vibrazioni e odore: la sua presenza cambia la
  // tattica (fermarsi, non scappare di corsa) e viene dalla stessa mappa di
  // entità del resto della percezione.
  _wardenView () {
    const from = this.position ?? this._feet ?? null;
    for (const entity of this.entities?.values?.() ?? []) {
      if (entity?.type !== 'warden' || !entity.position) continue;
      const distance = from ? +Math.hypot(entity.position.x - from.x, entity.position.y - from.y, entity.position.z - from.z).toFixed(2) : null;
      return { present: true, position: entity.position, distance, health: entity.health ?? null, lastAt: entity.lastAt ?? null };
    }
    return { present: false, position: null, distance: null, health: null, lastAt: null };
  }

  // Vista per /observe.sculk: censimento (in cache) + rischio nella cella del bot.
  _sculkView ({ force = false } = {}) {
    return { ...this._sculkCensus({ force }), sneak: this._sneakView() };
  }

  _sneakView () {
    return { active: !!this._stealthSneaking, declared: !!this._sneakDeclared, last: this._lastSneak, route: this._stealthRouteView() };
  }

  // Rischio di vibrazione in una cella: `null` se il censimento non è pronto o non
  // ci sono sensori noti — nessun rifiuto inventato su un mondo non guardato.
  _vibrationRiskAt (cell) {
    if (!cell) return null;
    const census = this._sculkCensus();
    if (!census.ready || !census.sensorRows?.length) return null;
    const risk = vibrationRisk(cell, census.sensorRows, { radius: VIBRATION_RADIUS });
    return risk.count > 0 ? risk : null;
  }

  // ---- Deep Dark (W2 di docs/raw/DEEP_DARK_ROADMAP.md) ------------------------
  // Pianificatore silenzioso: lo stesso A* della camminata, ma con il costo delle
  // vibrazioni al posto di quello uniforme. La rotta e' fatta di sole celle
  // percorribili a piedi (nessuno scavo, nessun piazzamento: la rotta *e'* il
  // silenzio) e non si promette su un mondo che non si e' ancora guardato:
  // senza censimento pronto l'errore tipizzato e' `sculk_unknown`.
  _stealthPlanner () {
    const census = this._sculkCensus();
    if (!census.ready) return { ok: false, error: 'sculk_unknown', ready: false };
    const sensors = census.sensorRows ?? [];
    const shriekers = census.shriekerRows ?? [];
    return {
      ok: true,
      ready: true,
      sensors: sensors.length,
      shriekers: shriekers.length,
      cellCost: cell => stealthCellCost({ cell, sensors, shriekers }),
      neighbors: node => this._neighbors(node),
    };
  }

  // La cella dei piedi del bot: e' anche la destinazione del ritorno ("torna da
  // dove sei venuto"). Il ritorno si **ripianifica** invece di essere l'andata al
  // contrario: una caduta si fa in un senso solo, e una rotta che scende non e'
  // una rotta che risale.
  _stealthStartCell () {
    const feet = this._feet ?? this.position;
    if (!feet) return null;
    return { x: Math.floor(feet.x), y: Math.floor(feet.y + 0.1), z: Math.floor(feet.z) };
  }

  _planStealthRoute (start, goal, { exit = null, maxRisk = 0 } = {}) {
    const planner = this._stealthPlanner();
    if (!planner.ok) return { ok: false, error: planner.error, from: start, to: goal, exit: null };
    const plan = planStealthRoute({ start, goal, exit, neighbors: planner.neighbors, cellCost: planner.cellCost, maxRisk });
    return { ...plan, sensors: planner.sensors, shriekers: planner.shriekers };
  }

  // Il piano accettato resta come memoria della missione: e' la rotta di ritorno
  // che W3 (`escape_deep_dark`) dovra' ripercorrere restando accovacciato.
  _rememberStealthRoute (plan, goal) {
    this._stealthRoute = plan?.ok
      ? { cells: plan.cells, maxRisk: plan.maxRisk, exit: plan.exit, goal, at: Date.now() }
      : null;
    return this._stealthRoute;
  }

  _stealthRouteView () {
    const route = this._stealthRoute;
    if (!route) return null;
    return {
      cells: route.cells?.length ?? 0,
      maxRisk: route.maxRisk ?? null,
      goal: route.goal ?? null,
      at: route.at ?? null,
      ageMs: route.at ? Date.now() - route.at : null,
      exit: route.exit
        ? { cells: route.exit.cells?.length ?? 0, maxRisk: route.exit.maxRisk ?? null, target: route.exit.target ?? null }
        : null,
    };
  }

  // ---- M2: respirare e gestire una discesa -----------------------------------
  // Da dove viene il respiro. L'elmo di tartaruga e l'effetto `water_breathing`
  // sono fonti *reali*; i conduit restano un indizio: la loro attivazione
  // dipende da un prisma d'acqua validato dal server che non verifichiamo, e
  // dichiararli attivi sarebbe una sicurezza inventata.
  _waterBreathing () {
    return waterBreathingSources({
      armor: this.armor,
      effects: this._activeEffects(),
      conduits: this._conduitsNear(),
    });
  }

  _conduitsNear () {
    const now = Date.now();
    if (this._conduitScan && now - this._conduitScanAt < CONDUIT_RESCAN_MS) return this._conduitScan;
    if (!this.position || typeof this.world?.findBlocks !== 'function') return [];
    const found = this.world.findBlocks(CONDUIT_BLOCK, this.position, CONDUIT_RANGE, 8)
      .map(block => block?.position ?? block)
      .filter(Boolean);
    this._conduitScan = found;
    this._conduitScanAt = now;
    return found;
  }

  // Quanti blocchi d'acqua sopra la testa: la superficie è il primo tetto che
  // non è acqua. Oltre il limite non serve contare, il budget non cambia.
  _diveDepth (limit = 8) {
    const feet = this._feet;
    if (!feet) return 0;
    const x = Math.floor(feet.x);
    const z = Math.floor(feet.z);
    const start = Math.floor(feet.y + 1);
    let depth = 0;
    for (let y = start; y < start + limit; y++) {
      if (this._fluidKindAt(x, y, z) !== 'water') break;
      depth++;
    }
    return depth;
  }

  // Il nome dell'effetto dal registry Bedrock (`WaterBreathing` -> `water_breathing`).
  _effectName (id) {
    const entry = this.world?.registry?.effects?.[id];
    const raw = entry?.name ?? entry?.displayName ?? null;
    return raw ? normalizeEffectName(raw) : null;
  }

  // `mob_effect` arriva anche per i mob: si tiene solo il giocatore.
  _onMobEffect (packet) {
    if (!packet) return;
    const runtimeId = packet.runtime_entity_id;
    const self = this.client?.entityId;
    if (runtimeId != null && self != null && String(runtimeId) !== String(self)) return;
    const event = String(packet.event_id ?? '');
    const id = Number(packet.effect_id);
    const key = this._effectName(id) ?? `effect_${id}`;
    if (event === 'remove') {
      this.effects.delete(key);
    } else {
      const duration = Number(packet.duration);
      this.effects.set(key, {
        id,
        name: key,
        amplifier: Number(packet.amplifier) || 0,
        duration: Number.isFinite(duration) ? duration : null,
        // La durata è in tick (50 ms): serve una scadenza, perché il server non
        // manda sempre un `remove` quando l'effetto finisce.
        expiresAt: Number.isFinite(duration) && duration > 0 ? Date.now() + duration * 50 : null,
        at: Date.now(),
      });
    }
    this.log('mob_effect', { event, effect: key, id, duration: Number.isFinite(Number(packet.duration)) ? Number(packet.duration) : null });
  }

  // Gli effetti ancora vivi, con i secondi che restano. Un effetto scaduto si
  // butta via qui: il server non manda sempre un `remove` alla fine.
  _activeEffects () {
    const now = Date.now();
    const out = [];
    for (const [key, effect] of this.effects) {
      if (effect.expiresAt != null && effect.expiresAt <= now) {
        this.effects.delete(key);
        continue;
      }
      out.push(effect.expiresAt == null ? effect : { ...effect, seconds: Math.round((effect.expiresAt - now) / 100) / 10 });
    }
    return out;
  }

  // Vista M2: profondità, fonti di respiro e ultimo verdetto di discesa.
  _diveView ({ fluids = null, workSeconds = DIVE_WORK_SECONDS } = {}) {
    const view = fluids ?? this._fluidsView();
    const waterBreathing = view.waterBreathing ?? this._waterBreathing();
    const depth = view.headInWater ? this._diveDepth() : 0;
    const plan = view.headInWater
      ? divePlan({ air: this.air, depth, workSeconds, waterBreathing: waterBreathing.active })
      : null;
    return { depth, workSeconds, waterBreathing, plan, last: this._diveLast };
  }

  // Il cancello che ogni lavoro sott'acqua attraversa. Con la testa fuori
  // dall'acqua costa una lettura e ritorna subito.
  _underwaterWorkAllowed (workSeconds = DIVE_WORK_SECONDS) {
    const fluids = this._fluidsView();
    if (!fluids.headInWater) return { allowed: true, reason: 'head_above_water', plan: null };
    const waterBreathing = this._waterBreathing();
    const depth = this._diveDepth();
    const verdict = underwaterWork({
      inWater: fluids.inWater,
      headInWater: fluids.headInWater,
      depth,
      air: this.air,
      workSeconds,
      waterBreathing: waterBreathing.active,
    });
    verdict.depth = depth;
    verdict.workSeconds = workSeconds;
    verdict.waterBreathing = waterBreathing.active;
    if (verdict.allowed) {
      this._diveLast = { at: Date.now(), reason: verdict.reason, depth, air: this.air, workSeconds };
    } else {
      this.log('underwater_work_refused', { reason: verdict.reason, depth, air: this.air, workSeconds });
    }
    return verdict;
  }

  // ---- M3: cascate e colonne di bolle ----------------------------------------
  // Una cascata trasforma un dirupo in una discesa sicura; una colonna di bolle
  // è un ascensore. Nessuna delle due si improvvisa: la decisione è di
  // `columnTactic` (budget d'aria di M2 incluso) e l'esito si *verifica* — non
  // si simula l'acqua, si guarda se i piedi sono davvero cambiati di quota.
  _swimSupported () {
    return this.swimSupported === true;
  }

  _waterfalls ({ force = false } = {}) {
    return this._fluidCensus({ force }).waterfalls ?? [];
  }

  _bubbles ({ force = false } = {}) {
    return this._fluidCensus({ force }).bubbles ?? [];
  }

  _nearestColumn (kind = 'descend') {
    return (kind === 'bubble' ? this._bubbles() : this._waterfalls())[0] ?? null;
  }

  _columnTactic (kind = 'descend', { column = null, distance = null } = {}) {
    const target = column ?? this._nearestColumn(kind);
    const verdict = columnTactic({
      kind,
      column: target,
      feet: this._feet ?? null,
      air: Number.isFinite(this.air) ? this.air : null,
      waterBreathing: this._waterBreathing().active,
      swimSupported: this._swimSupported(),
      distance,
    });
    if (target) verdict.summary = summarizeColumn(target, this._feet ?? null);
    return verdict;
  }

  // Diagnostica compatta per `/observe.waterfall`: cosa vede il bot e cosa
  // risponderebbe ciascuna delle tre azioni (senza eseguirle).
  _columnView ({ force = false } = {}) {
    this._fluidCensus({ force });
    const feet = this._feet ?? null;
    const waterfall = this._waterfalls()[0] ?? null;
    const bubble = this._bubbles()[0] ?? null;
    return {
      swimSupported: this._swimSupported(),
      onWaterfall: withinColumn(waterfall, feet),
      waterfall: summarizeColumn(waterfall, feet),
      bubbleColumn: summarizeColumn(bubble, feet),
      waterfallCount: this._waterfalls().length,
      bubbleCount: this._bubbles().length,
      descend: this._columnTactic('descend', { column: waterfall }),
      climb: this._columnTactic('climb', { column: waterfall }),
      bubble: this._columnTactic('bubble', { column: bubble }),
      last: this._waterfallLast,
    };
  }

  // L'azione di colonna: verdetto, avvicinamento all'ingresso, verifica della
  // traversata. Il percorso `ok` esiste solo quando il nuoto c'è; il rifiuto
  // tipizzato (`swimming_unavailable`, `too_far`, `unsafe_landing`, …) è il
  // percorso che si può collaudare oggi.
  async _useColumn (kind = 'descend', { timeoutMs = 20000, approachMs = 15000 } = {}) {
    const tactic = this._columnTactic(kind);
    const column = tactic.column ?? null;
    const summary = tactic.summary ?? summarizeColumn(column, this._feet ?? null);
    if (!tactic.ok) {
      this.log('column_refused', { kind, error: tactic.error, column: summary });
      return {
        ok: false,
        error: tactic.error,
        kind,
        column: summary,
        distance: tactic.distance ?? null,
        landing: summary?.landing ?? null,
      };
    }
    const from = this._feet ? { ...this._feet } : null;
    if (tactic.reason === 'already_inside') {
      this._waterfallLast = { at: Date.now(), kind, reason: 'already_inside', column: summary };
      return { ok: true, kind, column: summary, entered: false, from, to: this.pos(), deltaY: 0 };
    }
    const entry = { x: column.top.x + 0.5, y: column.top.y, z: column.top.z + 0.5 };
    try {
      if (this._feet && Math.hypot(this._feet.x - entry.x, this._feet.z - entry.z) > 1.5) {
        await this._moveTo(entry, 1.0, approachMs);
      }
    } catch (error) {
      this.log('column_approach_failed', { kind, error: error.message, column: summary });
      return { ok: false, error: `column_approach_failed: ${error.message}`, kind, column: summary };
    }
    const traversal = await this._waitColumnTraversal(kind, column, { timeoutMs, fromY: from?.y ?? null });
    const report = {
      ok: traversal.ok,
      kind,
      column: summary,
      from,
      to: this.pos(),
      deltaY: traversal.deltaY ?? null,
      ...(traversal.ok ? {} : { error: traversal.error }),
    };
    this._waterfallLast = { at: Date.now(), kind, reason: traversal.ok ? 'traversed' : traversal.error, column: summary };
    if (traversal.ok) this.log('column_used', { kind, column: summary, to: report.to, deltaY: report.deltaY });
    else this.log('column_not_traversed', { kind, column: summary, deltaY: report.deltaY });
    return report;
  }

  // La fisica dell'acqua non è modellata: si aspetta che *il server* porti i
  // piedi alla quota giusta (atterraggio in discesa, cima in salita/bolle).
  async _waitColumnTraversal (kind, column, { timeoutMs = 20000, pollMs = 250, fromY = null } = {}) {
    const startY = fromY ?? this._feet?.y ?? null;
    const upwards = kind === 'climb' || (kind === 'bubble' && column.direction === 'up');
    const targetY = upwards ? column.top.y + 1 : column.landing.position.y;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const feet = this._feet;
      if (feet) {
        const reached = upwards ? feet.y >= targetY - 0.1 : feet.y <= targetY + 0.1;
        if (reached) {
          return { ok: true, deltaY: startY == null ? null : +(feet.y - startY).toFixed(2) };
        }
      }
      await delay(pollMs);
    }
    const feet = this._feet;
    return {
      ok: false,
      error: 'column_not_traversed',
      deltaY: startY == null || !feet ? null : +(feet.y - startY).toFixed(2),
    };
  }

  // ---- Nether/End: portali, pericoli, proiettili e sguardo (N0) ---------------
  // Censimento portali/pericoli con TTL proprio (come fluidi e redstone): un mondo
  // appena connesso senza colonne caricate non è un mondo senza portali, quindi in
  // quel caso non si mette in cache e si dichiara `ready: false`.
  _netherCensus ({ force = false } = {}) {
    const now = Date.now();
    if (!force && this._netherScan && now - this._netherScanAt < NETHER_RESCAN_MS) return this._netherScan;
    const rows = [];
    if (this.position && typeof this.world?.findBlocks === 'function') {
      for (const name of ['portal', 'end_portal', 'end_gateway', 'end_portal_frame', 'fire', 'soul_fire', 'magma', 'mob_spawner']) {
        for (const block of this.world.findBlocks(name, this.position, NETHER_SCAN_RADIUS, NETHER_SCAN_LIMIT)) {
          // N7: il telaio dell'End porta il suo stato (l'occhio c'è o no) e la
          // census è l'unico punto in cui il blocco è ancora in mano: se lo
          // stato si perde qui, più tardi non c'è modo di rileggerlo.
          const properties = typeof block?.getProperties === 'function'
            ? block.getProperties()
            : (block?._properties ?? block?.properties ?? null);
          rows.push({ name, position: block?.position ?? block, properties });
        }
      }
    }
    const from = this._feet ?? this.position;
    const loaded = this.world?.loaded?.size ?? null;
    const ready = loaded !== 0;
    const census = {
      portals: summarizePortals(rows, from),
      hazards: summarizeHazards(rows, from),
      rows,
      scanned: rows.length,
      loaded,
      ready,
      at: now,
    };
    if (!ready) return census;
    this._netherScan = census;
    this._netherScanAt = now;
    return this._netherScan;
  }

  // Proiettili percepiti (palla di fuoco del ghast, frecce, perle…). La velocità
  // non arriva da `move_entity`: si stima dalle due ultime posizioni osservate,
  // quindi `prev` viene tenuto solo per questi tipi.
  _projectileRows (range = 24) {
    const rows = [];
    for (const entity of this.entities.values()) {
      if (!entity.position || !isProjectileType(entity.type)) continue;
      const distance = this._entityDistance(entity);
      if (distance > range) continue;
      rows.push({
        type: entity.type,
        position: { ...entity.position },
        previous: entity.prev ? { position: { ...entity.prev.position }, at: entity.prev.at } : null,
        distance: +distance.toFixed(1),
      });
    }
    rows.sort((a, b) => a.distance - b.distance);
    return rows;
  }

  // Vista compatta per /observe: dove sono i portali, quanto è vicino il fuoco,
  // cosa sta arrivando e se il bot sta guardando un enderman.
  _netherView ({ force = false, cells = false } = {}) {
    const feet = this._feet
      ? { x: Math.floor(this._feet.x), y: Math.floor(this._feet.y + 0.1), z: Math.floor(this._feet.z) }
      : null;
    const head = feet ? { x: feet.x, y: feet.y + 1, z: feet.z } : null;
    const nameAt = cell => (cell ? this.world?.blockAt?.(cell)?.name ?? null : null);
    const standingOnFire = isFireBlock(this.standingOn);
    const inFire = isFireBlock(nameAt(feet));
    const headInFire = isFireBlock(nameAt(head));
    const census = this._netherCensus({ force });
    const from = this._feet ?? this.position;
    const projectiles = this._projectileRows();
    const threat = projectileIncoming({ projectiles, from, now: Date.now() });
    const endermans = [];
    for (const entity of this.entities.values()) {
      if (!entity.position || !isEndermanType(entity.type)) continue;
      if (this._entityDistance(entity) > 24) continue;
      endermans.push({ type: entity.type, position: { ...entity.position } });
    }
    const dimension = this.dimension;
    const view = {
      dimension,
      isNether: isNetherDimension(dimension),
      isEnd: isEndDimension(dimension),
      waterEvaporates: waterEvaporates(dimension),
      bedsExplode: bedsExplode(dimension),
      inFire: inFire || headInFire || standingOnFire,
      feetInFire: inFire,
      headInFire,
      standingOnFire,
      fireDistance: census.hazards.fireDistance,
      magmaDistance: census.hazards.magmaDistance,
      spawnerDistance: census.hazards.spawnerDistance,
      portals: census.portals,
      portalDistance: census.portals.portalDistance,
      endPortalDistance: census.portals.endPortalDistance,
      endFrameDistance: census.portals.endFrameDistance,
      projectiles: projectiles.slice(0, 4).map(p => ({ type: p.type, distance: p.distance, position: p.position })),
      projectile: threat
        ? {
          type: threat.type,
          distance: threat.distance,
          missDistance: threat.missDistance,
          timeToImpactMs: threat.timeToImpactMs,
          speed: threat.speed,
          source: threat.source,
        }
        : null,
      // N5: la zucca in testa non cambia dove punta lo sguardo, ma impedisce
      // all'enderman di accorgersene — la vista riporta i due fatti separati.
      enderman: gazedAtEnderman({ from: this.position ?? from, yaw: this._lastYaw, pitch: this._lastPitch, endermans, protected: pumpkinMaskWorn(this.armor) }),
      hazard: netherHazard({
        dimension,
        inFire: inFire || headInFire || standingOnFire,        fireDistance: census.hazards.fireDistance,
        magmaDistance: census.hazards.magmaDistance,
        inLava: feet ? this._fluidKindAt(feet.x, feet.y, feet.z) === 'lava' : false,
      }),
      // N2: senza acqua la caduta permessa è più corta, e l'atterraggio su
      // magma/fuoco non è mai una destinazione (vedi `_neighbors`/`_standable`).
      maxFall: maxFallDepth(dimension),
      hub: this._netherHubLast ?? null,
      piglin: this._barterPiglinView(),
      goldArmor: (() => { const worn = this._wornArmor(); return { worn: goldArmorWorn(worn), neutral: piglinNeutral({ worn }) }; })(),
      barter: this._barterLast ?? null,
      // N5: `pearls` è il bottino che conta nel Nether, `pumpkin` lo stato della
      // maschera. Il conteggio delle perle viene dagli slot (l'inventario può
      // essere riallineato a metà transazione), non dalla mappa di comodo.
      pearls: this._pearlsHeld(),
      pumpkin: isPumpkinMask(this.armor?.helmet),
      // N6: il blaze più vicino e i rod in inventario. Qui *senza* il conteggio
      // delle coperture: quella è una domanda dell'azione (una scansione di 13×13
      // celle), non della percezione che gira a ogni passo.
      blaze: this._blazeRows()[0] ?? null,
      rods: this.inventory[BLAZE_ROD] || 0,
      hunt: this._blazeLast ?? null,
      // N7: la proiezione compatta dell'endgame (telai, occhi, letture, drago).
      // La vista completa resta in `_endView()`, che è diagnostica e non gira a
      // ogni passo del controller.
      end: endSummary({
        frames: this._endFrames({ census }),
        craft: eyeCraftPlan({
          powder: this.inventory[BLAZE_POWDER] || 0,
          pearls: this._pearlsHeld(),
          rods: this.inventory[BLAZE_ROD_ITEM] || 0,
        }),
        readings: this._endReadings().length,
        stronghold: (() => {
          const readings = this._endReadings();
          return readings.length >= 2
            ? triangulateStronghold({ first: readings[readings.length - 2], second: readings[readings.length - 1] })
            : null;
        })(),
        boss: bossVerdict({ ...this._bossBar }),
      }),
      scanned: census.scanned,
      ready: census.ready !== false,
      at: census.at,
    };
    // Le celle servono solo alla diagnostica (`/observe.portals`): tenerle fuori
    // da /observe evita di gonfiare la percezione del controller.
    if (cells) view.cells = census.rows;
    // Ultimo cantiere di portale (N1): diagnostica per il round live e per
    // `/observe` senza dover rileggere il mondo.
    view.portalFrame = this._lastPortalFrame ?? null;
    return view;
  }

  // --- N5: disciplina dello sguardo e maschera di zucca ----------------------
  // Le perle dagli slot: la mappa `this.inventory` è un comodo riassunto che
  // può restare indietro rispetto a una transazione in corso, e qui si conta
  // una cosa che vale la pena contare bene.
  _pearlsHeld () {
    let total = 0;
    for (const slot of this.inventorySlots) {
      if ((slot?.count ?? 0) > 0 && isEnderPearl(this._slotItemName(slot))) total += slot.count;
    }
    return total;
  }

  _pumpkinInInventory () {
    for (let index = 0; index < this.inventorySlots.length; index++) {
      const slot = this.inventorySlots[index];
      const name = this._slotItemName(slot);
      if ((slot?.count ?? 0) > 0 && isPumpkinMask(name)) return { index, name };
    }
    return null;
  }

  // Candidati di fuga dello sguardo: due lati e il dietro, tutti col pitch
  // verso il basso, ordinati per quanto lasciano gli occhi fuori dall'asse di
  // visione. Non è una direzione di movimento ma solo di testa — muoversi
  // mentre si è visti sarebbe il modo peggiore di risolvere il problema.
  _gazeEscapeCandidates (enderman) {
    const from = this.position ?? null;
    const position = enderman?.position;
    if (!from || !position) return [];
    const torso = endermanAimPoint(position);
    if (!torso) return [];
    const base = this._lookAt({ x: torso.x, y: torso.y, z: torso.z });
    const angles = [base.yaw + 120, base.yaw - 120, base.yaw + 180];
    return angles
      .map(yaw => ({ yaw, pitch: Math.max(base.pitch, 15) }))
      .map(candidate => ({
        ...candidate,
        angle: gazedAtEnderman({ from, yaw: candidate.yaw, pitch: candidate.pitch, endermans: [enderman] })?.angleDeg ?? null,
      }))
      .filter(candidate => candidate.angle == null || candidate.angle > ENDERMAN_GAZE_TOLERANCE_DEG)
      .sort((a, b) => (b.angle ?? 0) - (a.angle ?? 0));
  }

  // Smettere di fissare gli occhi: non basta volgere lo sguardo, si verifica
  // dalla percezione che l'angolo sia uscito dalla tolleranza (con la zucca in
  // testa invece non c'è nulla da evitare).
  async _avoidGaze ({ timeoutMs = 3000 } = {}) {
    if (!this.spawned) return { ok: false, error: 'not_ready' };
    const deadline = Date.now() + timeoutMs;
    const current = () => this._netherView({ force: true }).enderman ?? null;
    const start = current();
    if (!start) return { ok: false, error: 'no_enderman' };
    if (start.protected) return { ok: true, already: false, protected: true, enderman: start };
    if (start.aimingAtEyes !== true) return { ok: true, already: true, enderman: start };
    const candidates = this._gazeEscapeCandidates(start);
    if (!candidates.length) return { ok: false, error: 'no_gaze_escape', enderman: start };
    const tried = [];
    for (const candidate of candidates) {
      if (Date.now() > deadline) break;
      await this._queueAuthInput({ yaw: candidate.yaw, pitch: candidate.pitch });
      await delay(150);
      const after = current();
      tried.push({ yaw: +candidate.yaw.toFixed(1), pitch: +candidate.pitch.toFixed(1), gazed: after?.gazed ?? null });
      if (!after || after.gazed !== true) {
        this.log('gaze_avoided', { yaw: +candidate.yaw.toFixed(1), pitch: +candidate.pitch.toFixed(1), tried });
        return { ok: true, already: false, enderman: after, tried };
      }
    }
    this.log('gaze_not_cleared', { tried });
    return { ok: false, error: 'gaze_not_cleared', enderman: current(), tried };
  }

  // La zucca in testa è l'unica difesa dallo sguardo dell'enderman. Si equipaggia
  // come un elmo, ma con un metodo suo perché `_armorSlotFor` non riconosce
  // `carved_pumpkin` (nessun suffisso `_helmet`): senza questo la zucca
  // resterebbe in inventario per sempre.
  async _equipPumpkin () {
    if (isPumpkinMask(this.armor?.helmet)) return { ok: true, already: true, item: this.armor.helmet };
    const held = this._pumpkinInInventory();
    if (!held) return { ok: false, error: 'missing_pumpkin' };
    const slot = this.inventorySlots[held.index];
    const info = this._invSlotAsSource(held.index);
    const take = await this._sendStackRequest([{
      type_id: 'take', legacy_type_id: 0, count: 1,
      source: this._slotInfo(info.container, info.slot, slot.stack_id || 0),
      destination: this._slotInfo('cursor', 0, 0),
    }]).catch(() => null);
    if (!take || (String(take.status) !== 'ok' && take.status !== 0)) return { ok: false, error: 'pumpkin_equip_failed' };
    this._applyStackResponse(take);
    const cursorStack = this._responseSlotStack(take, 'cursor', 0) ?? 0;
    const place = await this._sendStackRequest([{
      type_id: 'place', legacy_type_id: 1, count: 1,
      source: this._slotInfo('cursor', 0, cursorStack),
      destination: this._slotInfo('armor', 0, 0),
    }]).catch(() => null);
    if (!place || (String(place.status) !== 'ok' && place.status !== 0)) {
      await this._returnCursorToInventory().catch(() => {});
      return { ok: false, error: 'pumpkin_equip_failed' };
    }
    this._applyStackResponse(place, { networkId: slot.network_id });
    this._cursor = null;
    this.armor.helmet = slot.name;
    this._armorWindow[0] = this._armorWindowItem(slot) ?? { name: slot.name, network_id: slot.network_id ?? null, count: 1, stack_id: slot.stack_id ?? null, metadata: 0, extra: null };
    this._refreshInventory();
    this.log('pumpkin_equipped', { item: slot.name, status: place.status });
    return { ok: true, already: false, item: slot.name };
  }

  // --- N6: caccia al blaze (copertura prima, poi mischia) --------------------
  // Il blaze spara: la differenza fra un combattimento e una morte è la linea di
  // tiro. `_blazeRows` è solo percezione, `_coverFrom` è la geometria pura di
  // `coverCandidates`, `_huntBlaze` mette in fila tattica, copertura e mischia.
  _blazeRows ({ range = BLAZE_RANGE } = {}) {
    const rows = [];
    for (const entity of this.entities.values()) {
      if (!entity.position || !isBlazeType(entity.type)) continue;
      const distance = this._entityDistance(entity);
      if (!(distance <= range)) continue;
      rows.push({ type: entity.type, runtimeId: entity.runtimeId, position: { ...entity.position }, distance: +distance.toFixed(2) });
    }
    rows.sort((a, b) => a.distance - b.distance);
    return rows;
  }

  // Coperture raggiungibili *adesso* contro quel blaze: celle vicine da cui il
  // bot non vede il blaze (la linea passa in un blocco solido), già filtrate per
  // raggiungibilità e lava. La geometria vera è in `bedrock-nether.mjs`.
  _coverFrom (entity, { radius = COVER_RADIUS } = {}) {
    if (!entity?.position || !this._feet) return [];
    const cells = [];
    const seen = new Set();
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (dx === 0 && dz === 0) continue;
        const point = this._standableNear({ x: this._feet.x + dx, z: this._feet.z + dz });
        if (!point) continue;
        const cell = { x: Math.floor(point.x), y: Math.floor(point.y), z: Math.floor(point.z) };
        const key = `${cell.x},${cell.y},${cell.z}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (this._reachabilityUsable() && !this.cellReachable(cell)) continue;
        if (this._lavaAdjacent(cell.x, cell.y, cell.z)) continue;
        cells.push(cell);
      }
    }
    return coverCandidates({
      from: this._feet,
      target: entity.position,
      cells,
      // Una cella *ignota* non è copertura: sotto il tiro di un blaze un chunk
      // non caricato non ferma nulla, e fingersi al riparo è la cosa peggiore
      // che un bot possa credere.
      solid: (cell) => (this.world.blockAt(cell) ? this._solidAt(cell.x, cell.y, cell.z) : false),
      radius,
    });
  }

  _inFire () {
    try { return this._netherView().inFire === true; } catch { return false; }
  }

  // Un blaze alla volta, con una regola sola: prima si spezza la linea, poi si
  // chiude. Se si è già troppo feriti o in fiamme senza copertura si indietreggia
  // e lo si dice — un "ok" qui significherebbe un bot che muore per un rod.
  async _huntBlaze ({ timeoutMs = 45000 } = {}) {
    if (!this.spawned || !this._feet) return { ok: false, error: 'not_ready' };
    const rows = this._blazeRows();
    if (!rows.length) return { ok: false, error: 'no_blaze_nearby', range: BLAZE_RANGE };
    const health = typeof this.health === 'number' ? this.health : null;
    if (health != null && health <= BLAZE_RETREAT_HEALTH) {
      return { ok: false, error: 'too_hurt', health, retreatHealth: BLAZE_RETREAT_HEALTH };
    }
    const started = Date.now();
    const before = this.inventory[BLAZE_ROD] || 0;
    const actions = [];
    const assess = () => {
      const target = this._blazeRows()[0] ?? rows[0];
      const cover = this._coverFrom(target);
      const tactics = blazeTactics({
        distance: target.distance,
        health: this.health,
        cover: cover.length,
        onFire: this._inFire(),
      });
      return { target, cover, tactics };
    };
    let { target, cover, tactics } = assess();
    const summary = () => ({
      blaze: { type: target.type, distance: target.distance, position: target.position },
      cover: cover.length,
      health: this.health ?? null,
      rods: (this.inventory[BLAZE_ROD] || 0) - before,
    });
    if (tactics.action === 'retreat') {
      const spot = cover[0]?.cell ?? null;
      if (spot) {
        try {
          await this._moveTo({ x: spot.x + 0.5, y: spot.y, z: spot.z + 0.5 }, 0.8, Math.min(8000, Math.max(1500, timeoutMs)));
          actions.push('retreat_to_cover');
        } catch (error) {
          this.log('blaze_retreat_failed', { error: error.message, ...summary() });
          return { ok: false, error: 'retreat_failed', reason: tactics.reason, message: error.message, actions, ...summary() };
        }
      }
      this.log('blaze_retreated', { reason: tactics.reason, ...summary() });
      return { ok: false, error: 'blaze_retreat', reason: tactics.reason, retreated: !!spot, actions, ...summary() };
    }
    if (tactics.action === 'take_cover') {
      const spot = cover[0].cell;
      try {
        await this._moveTo({ x: spot.x + 0.5, y: spot.y, z: spot.z + 0.5 }, 0.8, Math.min(8000, Math.max(1500, timeoutMs)));
        actions.push('take_cover');
      } catch (error) {
        // La copertura è un mezzo, non un requisito: se non ci si arriva si prova
        // comunque la mischia, ma il fallimento resta nel resoconto.
        this.log('blaze_cover_failed', { error: error.message, cell: spot, ...summary() });
        actions.push('cover_failed');
      }
      ({ target, cover, tactics } = assess());
    }
    actions.push('fight');
    const combat = await this._combat('blaze', Math.max(6000, timeoutMs - (Date.now() - started)));
    let collected = null;
    if (combat.ok) {
      try {
        const drop = await this._collectDrop(5000);
        collected = { ok: drop?.ok === true, picked: drop?.picked ?? null, error: drop?.ok ? undefined : drop?.error };
      } catch (error) {
        collected = { ok: false, error: error.message };
      }
      actions.push('collect');
    }
    const after = this.inventory[BLAZE_ROD] || 0;
    const report = {
      ...summary(),
      ok: combat.ok === true,
      ...(combat.ok ? {} : { error: combat.error }),
      hits: combat.hits ?? 0,
      killed: combat.killed === true,
      confirmedBy: combat.confirmedBy ?? null,
      weapon: combat.weapon ?? null,
      tactics: tactics.action,
      reason: tactics.reason,
      rods: after - before,
      total: after,
      collected,
      actions,
    };
    this._blazeLast = { ...report, at: Date.now() };
    if (report.ok) this.log('blaze_hunted', report);
    else this.log('blaze_failed', report);
    return report;
  }

  // --- N7: occhi di ender e portale dell'End --------------------------------
  // La barra del boss è l'unico segnale che il server dà sul drago: `show_bar`
  // seguito da `hide_bar`. L'assenza dell'entità non è una prova (il chunk può
  // non essere caricato), quindi il verdetto poggia su questo ciclo.
  _onBossEvent (packet) {
    const type = String(packet?.type ?? '');
    if (type !== 'show_bar' && type !== 'hide_bar' && type !== 'set_bar_progress') return;
    this._bossBarEvents++;
    const at = Date.now();
    if (type === 'show_bar') {
      this._bossBar.shown = true;
      this._bossBar.shownAt = at;
      this._bossBar.entityId = packet?.target_entity_id != null ? String(packet.target_entity_id) : null;
      this._bossBar.title = packet?.title ?? null;
      this.log('boss_bar', { type, entityId: this._bossBar.entityId, title: this._bossBar.title });
    } else if (type === 'hide_bar') {
      this._bossBar.hidden = true;
      this._bossBar.hiddenAt = at;
      this.log('boss_bar', { type, shownForMs: Number.isFinite(this._bossBar.shownAt) ? at - this._bossBar.shownAt : null });
    } else if (Number.isFinite(packet?.progress)) {
      // La barra si aggiorna in continuazione: qui non si logga nulla.
      this._bossBar.progress = packet.progress;
    }
  }

  // Il telaio del portale è l'unico blocco il cui stato serve *prima* di agire:
  // quanti occhi mancano decide se vale la pena avvicinarsi. Lo stato arriva
  // dalla palette del server, quindi un telaio illeggibile resta `null`.
  _endFrames ({ force = false, census = null } = {}) {
    const scan = census ?? this._netherCensus({ force });
    const from = this._feet ?? this.position;
    const rows = [];
    for (const row of scan.rows ?? []) {
      if (row.name !== END_PORTAL_FRAME) continue;
      rows.push({ position: row.position, hasEye: frameHasEye(row) });
    }
    return frameStatus({ frames: rows, from });
  }

  // Gli occhi lanciati che il server ha fatto comparire come entità: la
  // posizione è quella dell'occhio, non l'origine del lancio.
  _eyeRows () {
    const rows = [];
    for (const entity of this.entities.values()) {
      if (!entity.position || !isEyeSignalType(entity.type)) continue;
      rows.push({ runtimeId: entity.runtimeId, type: entity.type, position: { ...entity.position }, seenAt: entity.seenAt ?? null });
    }
    return rows;
  }

  _endReadings ({ now = Date.now() } = {}) {
    return this._eyeReadings.filter(reading => reading && (reading.at == null || now - reading.at <= 10 * 60 * 1000));
  }

  _endView ({ force = false, census = null } = {}) {
    const frames = this._endFrames({ force, census });
    const craft = eyeCraftPlan({
      powder: this.inventory[BLAZE_POWDER] || 0,
      pearls: this._pearlsHeld(),
      rods: this.inventory[BLAZE_ROD_ITEM] || 0,
    });
    const readings = this._endReadings();
    const stronghold = readings.length >= 2
      ? triangulateStronghold({ first: readings[readings.length - 2], second: readings[readings.length - 1] })
      : null;
    const boss = bossVerdict({ ...this._bossBar });
    return {
      dimension: this.dimension,
      inEnd: this.dimension === END_DIMENSION,
      frames,
      craft,
      readings,
      stronghold,
      boss,
      bossBar: { ...this._bossBar, events: this._bossBarEvents },
      portal: (census ?? this._netherCensus({ force })).portals?.end?.nearest ?? null,
      lastThrow: this._eyeLast ?? null,
      lastFill: this._frameLast ?? null,
    };
  }

  // Un oggetto in mano prima di usarlo: trova lo slot, lo porta in hotbar e lo
  // seleziona. È lo stesso gesto del ripianto dei semi e dell'accensione del
  // portale, quindi vive una volta sola.
  async _equipForUse (itemName) {
    let slotIndex = this.inventorySlots.findIndex(s => this._slotItemName(s) === itemName && s.count > 0);
    if (slotIndex < 0) return { ok: false, error: `missing_${itemName}` };
    if (slotIndex > 8) {
      try { slotIndex = await this._moveSlotToHotbar(slotIndex); }
      catch (error) { return { ok: false, error: `equip_failed: ${error.message}` }; }
    }
    this._selectHotbarSlot(slotIndex);
    return { ok: true, slotIndex };
  }

  // Le bacchette del blaze diventano polvere con un craft senza forma (non una
  // fornace): una bacchetta per volta, perché ogni scomposizione consuma uno
  // slot e il conteggio che interessa è quello che cresce.
  async _craftPowderFromRods ({ maxCrafts = ENDER_EYE_FRAME_TOTAL } = {}) {
    const before = this.inventory[BLAZE_POWDER] || 0;
    const rods = this.inventory[BLAZE_ROD_ITEM] || 0;
    if (rods < 1) return { ok: false, error: 'missing_blaze_rod' };
    const crafted = [];
    const failed = [];
    for (let i = 0; i < Math.min(maxCrafts, rods); i++) {
      if ((this.inventory[BLAZE_ROD_ITEM] || 0) < 1) break;
      const result = await this._craftItem(BLAZE_POWDER);
      if (result?.ok) crafted.push({ item: BLAZE_POWDER, count: result.count ?? POWDER_PER_ROD });
      else { failed.push({ item: BLAZE_POWDER, error: result?.error ?? 'unknown' }); break; }
    }
    const after = this.inventory[BLAZE_POWDER] || 0;
    const report = {
      ok: after > before,
      error: after > before ? undefined : (failed[0]?.error ?? 'powder_not_crafted'),
      powder: after,
      gained: after - before,
      rods: this.inventory[BLAZE_ROD_ITEM] || 0,
      crafted,
      failed,
    };
    this.log(report.ok ? 'blaze_powder_crafted' : 'blaze_powder_failed', report);
    return report;
  }

  // Gli occhi sono il pezzo che manca più spesso: si craftano finché ci sono
  // polvere e perle, e il conteggio finale è quello letto dall'inventario.
  async _craftEyesOfEnder ({ maxCrafts = ENDER_EYE_FRAME_TOTAL } = {}) {
    const before = this.inventory[EYE_OF_ENDER] || 0;
    const plan = eyeCraftPlan({
      powder: this.inventory[BLAZE_POWDER] || 0,
      pearls: this._pearlsHeld(),
      rods: this.inventory[BLAZE_ROD_ITEM] || 0,
    });
    if (plan.missingPowder > 0 && (this.inventory[BLAZE_ROD_ITEM] || 0) > 0) await this._craftPowderFromRods({});
    const craftable = eyeCraftPlan({
      powder: this.inventory[BLAZE_POWDER] || 0,
      pearls: this._pearlsHeld(),
      rods: 0,
    }).craftable;
    if (craftable < 1) {
      const report = { ok: false, error: plan.missingPearls > 0 ? 'missing_ender_pearl' : 'missing_blaze_powder', plan, crafted: 0 };
      this.log('ender_eye_failed', report);
      return report;
    }
    const crafted = [];
    const failed = [];
    for (let i = 0; i < Math.min(maxCrafts, craftable); i++) {
      if ((this.inventory[BLAZE_POWDER] || 0) < 1 || this._pearlsHeld() < 1) break;
      const result = await this._craftItem(EYE_OF_ENDER);
      if (result?.ok) crafted.push({ item: EYE_OF_ENDER, count: result.count ?? 1 });
      else { failed.push({ error: result?.error ?? 'unknown' }); break; }
    }
    const after = this.inventory[EYE_OF_ENDER] || 0;
    const report = {
      ok: after > before,
      error: after > before ? undefined : (failed[0]?.error ?? 'eye_not_crafted'),
      eyes: after,
      gained: after - before,
      powder: this.inventory[BLAZE_POWDER] || 0,
      pearls: this._pearlsHeld(),
      crafted,
      failed,
    };
    this.log(report.ok ? 'ender_eyes_crafted' : 'ender_eye_failed', report);
    return report;
  }

  // Un occhio di ender lanciato vola verso la stronghold: la direzione la stima  // il volo dell'entità che il server fa comparire, non lo sguardo del bot
  // (l'occhio ignora dove guardi). Se l'entità non compare — l'occhio può
  // rompersi — non c'è nessuna direzione da leggere.
  async _throwEyeOfEnder ({ timeoutMs = 5000, sampleDelayMs = 250 } = {}) {
    if ((this.inventory[EYE_OF_ENDER] || 0) < 1) return { ok: false, error: 'missing_eye_of_ender' };
    const equipped = await this._equipForUse(EYE_OF_ENDER);
    if (!equipped.ok) return equipped;
    const origin = this._feet ? { ...this._feet } : (this.position ? { ...this.position } : null);
    if (!origin) return { ok: false, error: 'not_ready' };
    const known = new Set(this._eyeRows().map(row => row.runtimeId));
    const before = this.inventory[EYE_OF_ENDER] || 0;
    await this._queueAuthInput({ yaw: this._lastYaw ?? 0, pitch: 0, transaction: this._airUseTransaction() });
    let sample = null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !sample) {
      const fresh = this._eyeRows().find(row => !known.has(row.runtimeId));
      if (fresh) {
        await delay(sampleDelayMs);
        const moved = this._eyeRows().find(row => row.runtimeId === fresh.runtimeId) ?? fresh;
        sample = moved.position;
      } else {
        await delay(100);
      }
    }
    if (!sample) {
      const report = { ok: false, error: 'eye_not_spawned', held: before, inventory: this.inventory[EYE_OF_ENDER] || 0 };
      this._eyeLast = report;
      this.log('eye_throw_failed', report);
      return report;
    }
    const reading = eyeReading({ origin, sample, at: Date.now() });
    if (!reading) {
      const report = { ok: false, error: 'eye_direction_unknown', sample };
      this._eyeLast = report;
      this.log('eye_throw_failed', report);
      return report;
    }
    this._eyeReadings.push(reading);
    while (this._eyeReadings.length > EYE_READINGS_MAX) this._eyeReadings.shift();
    const readings = this._endReadings();
    const stronghold = readings.length >= 2
      ? triangulateStronghold({ first: readings[readings.length - 2], second: readings[readings.length - 1] })
      : null;
    const report = {
      ok: true,
      reading,
      readings: readings.length,
      stronghold,
      consumed: before - (this.inventory[EYE_OF_ENDER] || 0),
      remaining: this.inventory[EYE_OF_ENDER] || 0,
    };
    this._eyeLast = report;
    this.log('eye_thrown', { yaw: reading.yaw, readings: readings.length, stronghold: stronghold?.ok ? stronghold.position : stronghold?.error ?? null });
    return report;
  }

  // La milestone `find_stronghold` è soddisfatta da un telaio entro 24 blocchi:
  // prima di camminare, si guarda se ci si è già arrivati.
  async _findStronghold ({ timeoutMs = 20000 } = {}) {
    const frames = this._endFrames({ force: true });
    if (frames.total > 0 && frames.nearest && frames.nearest.distance <= STRONGHOLD_RADIUS) {
      return { ok: true, already: true, frames: frames.total, distance: frames.nearest.distance, position: frames.nearest.position };
    }
    const readings = this._endReadings();
    if (readings.length < 2) return { ok: false, error: 'needs_second_throw', readings: readings.length, frames: frames.total };
    const estimate = triangulateStronghold({ first: readings[readings.length - 2], second: readings[readings.length - 1] });
    if (!estimate.ok) return { ok: false, error: estimate.error, readings: readings.length, ...estimate };
    const target = { x: estimate.position.x, y: (this._feet ?? this.position).y, z: estimate.position.z };
    try {
      await this._moveTo(target, 3.0, timeoutMs);
      const after = this._endFrames({ force: true });
      return { ok: true, estimate, moved: true, frames: after.total, distance: after.nearest?.distance ?? null };
    } catch (error) {
      return {
        ok: false,
        error: 'stronghold_out_of_range',
        estimate,
        distance: estimate.distance,
        detail: error.message,
        hint: 'il pathfinder è locale: una stronghold a centinaia di blocchi richiede il viaggio a lungo raggio (esplorazione M1)',
      };
    }
  }

  async _awaitFrameEye (position, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (frameHasEye(this.world.blockAt(position)) === true) return true;
      await delay(100);
    }
    return false;
  }

  // Riempire il portale è un click per telaio vuoto, con la conferma presa dal
  // mondo: il telaio legge `end_portal_eye_bit` dal blocco, non dal nostro
  // ottimismo. Gli occhi mancanti fermano il lavoro senza consumarne altri.
  async _fillEndPortal ({ timeoutMs = 20000, frameTimeoutMs = 2000 } = {}) {
    const frames = this._endFrames({ force: true });
    if (frames.total === 0) return { ok: false, error: 'no_frame_known' };
    if (frames.missing === 0) return { ok: true, already: true, total: frames.total, filled: frames.filled, complete: frames.complete };
    if ((this.inventory[EYE_OF_ENDER] || 0) < 1) return { ok: false, error: 'missing_eye_of_ender', empty: frames.missing, total: frames.total };
    const placed = [];
    const failed = [];
    const deadline = Date.now() + timeoutMs;
    for (const row of frames.rows) {
      if (row.hasEye !== false) continue;
      if ((this.inventory[EYE_OF_ENDER] || 0) < 1) break;
      if (Date.now() >= deadline) break;
      const center = { x: row.position.x + 0.5, y: row.position.y, z: row.position.z + 0.5 };
      if (this._pointDistance(center) > 4.5) {
        try { await this._moveTo(center, 2.0, 8000); } catch (error) { this.log('end_frame_approach_failed', { message: error.message }); }
      }
      if (this._pointDistance(center) > 5.0) { failed.push({ position: row.position, error: 'frame_unreachable' }); continue; }
      const equipped = await this._equipForUse(EYE_OF_ENDER);
      if (!equipped.ok) { failed.push({ position: row.position, error: equipped.error }); break; }
      const look = this._lookAt({ x: center.x, y: center.y + 0.5, z: center.z });
      await this._queueAuthInput({ yaw: look.yaw, pitch: look.pitch });
      await delay(120);
      const held = this.inventorySlots[this.selectedHotbar];
      await this._queueAuthInput({
        yaw: look.yaw,
        pitch: look.pitch,
        transaction: this._itemUseOnBlockTransaction(held, row.position, 1),
      });
      if (await this._awaitFrameEye(row.position, frameTimeoutMs)) placed.push({ ...row.position });
      else failed.push({ position: row.position, error: 'eye_not_placed' });
    }
    const after = this._endFrames({ force: true });
    const report = {
      ok: placed.length > 0,
      filled: placed.length,
      placed,
      failed,
      total: after.total,
      empty: after.missing,
      complete: after.complete,
      frames: { total: after.total, filled: after.filled, missing: after.missing, unknown: after.unknown },
    };
    this._frameLast = report;
    this._refreshNearby();
    this.log(report.ok ? 'end_frames_filled' : 'end_frames_failed', report);
    return report;
  }

  // Muoversi verso una cella che non è un portale (l'ingresso dell'End): se la
  // raggiungibilità conferma che è fuori dal componente camminabile, il rifiuto
  // è immediato invece di un timeout di pathfinding.
  async _approachCell (center, { range = PORTAL_APPROACH_RANGE, timeoutMs = 20000 } = {}) {
    const cell = { x: Math.floor(center.x), y: Math.floor(center.y), z: Math.floor(center.z) };
    if (this._reachabilityUsable() && !this.approachReachable(cell, { range, dy: 2 })) {
      return { ok: false, error: 'portal_unreachable', portal: cell };
    }
    try { await this._moveTo(center, range, timeoutMs); }
    catch (error) { return { ok: false, error: 'move_failed', portal: cell, message: error.message }; }
    return { ok: true, portal: cell, distance: this._pointDistance(center) };
  }

  // --- N1: azioni sul portale -------------------------------------------------
  // Il portale più vicino fra quelli visti dal censimento N0 (posizione in
  // blocchi): senza un portale caricato non c'è nulla da raggiungere.
  _nearestPortal (kind = 'nether') {
    return this._netherView().portals?.[kind]?.nearest ?? null;
  }

  // Aprire un inventario o accendere un portale sono lo stesso gesto: un click
  // su una faccia di un blocco con l'oggetto in mano. La transazione è identica
  // a quella del ripianto dei semi, quindi vive qui una volta sola.
  _itemUseOnBlockTransaction (held, position, face = 1, clickPos = { x: 0.5, y: 1, z: 0.5 }) {
    return {
      legacy: { legacy_request_id: 0 },
      actions: [],
      data: {
        action_type: 'click_block',
        trigger_type: 'player_input',
        block_position: position,
        face,
        hotbar_slot: this.selectedHotbar,
        hand: 'main_hand',
        held_item: held,
        player_pos: { ...this.position },
        click_pos: clickPos,
        block_runtime_id: this.world.runtimeIdAt(position) >>> 0,
        client_prediction: 'success',
        client_cooldown_state: 'off',
      },
    };
  }

  // Una cornice già in piedi attorno al bot (ossidiana intorno, interno d'aria
  // o già acceso): i candidati nascono dai blocchi di ossidiana visti e solo
  // `checkPortalFrame` decide, contro il mondo vero.
  _findPortalFrame ({ radius = PORTAL_FRAME_RADIUS, limit = 24 } = {}) {
    if (typeof this.world?.findBlocks !== 'function' || !this.position) return null;
    const obsidian = this.world.findBlocks(PORTAL_FRAME_BLOCK, this.position, radius, limit);
    if (!obsidian?.length) return null;
    const blockAt = (position) => this.world.blockAt(position)?.name ?? null;
    for (const plan of portalFrameCandidates(obsidian)) {
      const check = checkPortalFrame(plan, blockAt);
      if (check.ok) return { plan, check, obsidian: obsidian.length };
    }
    return null;
  }

  // Dove può stare una cornice: davanti al bot, mai addosso. I candidati sono
  // ordinati per distanza e il primo sito libero vince (deterministico).
  _portalBuildSite ({ withCorners = true } = {}) {
    const feet = this._feet;
    if (!feet || typeof this.world?.blockAt !== 'function') return null;
    const base = { x: Math.floor(feet.x), y: Math.floor(feet.y), z: Math.floor(feet.z) };
    const occupied = new Set([`${base.x},${base.y},${base.z}`, `${base.x},${base.y + 1},${base.z}`]);
    const blockAt = (position) => this.world.blockAt(position)?.name ?? null;
    const candidates = [];
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        if (dx === 0 && dz === 0) continue;
        for (const axis of ['x', 'z']) {
          // La cornice nasce un blocco sopra i piedi: la riga in basso poggia sul
          // terreno e il primo blocco di `portal` sta all'altezza della testa,
          // cioè dove il bot entra con un passo (comportamento vanilla: si entra
          // camminando, non scavando).
          candidates.push({ axis, distance: Math.abs(dx) + Math.abs(dz), origin: { x: base.x + dx, y: base.y + 1, z: base.z + dz } });
        }
      }
    }
    candidates.sort((a, b) => a.distance - b.distance || (a.axis === 'x' ? -1 : 1));
    for (const candidate of candidates) {
      const plan = planPortalFrame({ origin: candidate.origin, axis: candidate.axis, withCorners });
      if (!plan.ok) continue;
      // La sicurezza del bot prima di tutto: la cornice non deve contenere le
      // celle che il bot occupa (né lo spazio per la testa).
      if (plan.cells.some(cell => occupied.has(`${cell.x},${cell.y},${cell.z}`))) continue;
      if (portalSiteBlocked(plan, blockAt).length) continue;
      return plan;
    }
    return null;
  }

  async _gotoPortal ({ timeoutMs = 45000, kind = 'nether' } = {}) {
    const portal = this._nearestPortal(kind);
    if (!portal?.position) return { ok: false, error: 'no_portal_known', hint: `nessun blocco \`${kind === 'end' ? END_PORTAL : PORTAL_BLOCK}\` nel raggio del censimento` };
    const center = { x: portal.position.x + 0.5, y: portal.position.y, z: portal.position.z + 0.5 };
    if (this._reachabilityUsable() && !this.approachReachable(portal.position, { range: PORTAL_APPROACH_RANGE, dy: 2 })) {
      return { ok: false, error: 'portal_unreachable', portal: { ...portal.position }, distance: portal.distance };
    }
    if (this._pointDistance(center) > PORTAL_APPROACH_RANGE) {
      try { await this._moveTo(center, PORTAL_APPROACH_RANGE, timeoutMs); }
      catch (error) {
        this.log('portal_approach_failed', { message: error.message });
        return { ok: false, error: 'move_failed', portal: { ...portal.position }, message: error.message };
      }
    }
    return { ok: true, portal: { ...portal.position }, distance: this._pointDistance(center) };
  }

  // Entrare è camminare dentro la colonna del portale e aspettare che il server
  // cambi dimensione: la conferma è `this.dimension` (packet `change_dimension`).
  // Vale per il Nether (`portal`) e per l'End (`end_portal`): cambia solo il
  // blocco che il censimento cerca e il nome dell'errore che si vuole leggere.
  async _enterPortal ({ timeoutMs = PORTAL_ENTER_TIMEOUT_MS, kind = 'nether' } = {}) {
    const portal = this._nearestPortal(kind);
    if (!portal?.position) return { ok: false, error: kind === 'nether' ? 'no_portal_known' : 'no_end_portal_known' };
    const before = this.dimension;
    const center = { x: portal.position.x + 0.5, y: portal.position.y, z: portal.position.z + 0.5 };
    if (this._pointDistance(center) > PORTAL_APPROACH_RANGE) {
      const approach = kind === 'nether' ? await this._gotoPortal({}) : await this._approachCell(center);
      if (!approach.ok) return { ...approach, stage: 'approach' };
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.dimension !== before) return { ok: true, from: before, to: this.dimension, portal: { ...portal.position } };
      try { await this._moveTo(center, 0.6, 2500); } catch (error) { this.log('portal_step_failed', { message: error.message }); }
      await delay(200);
    }
    return { ok: false, error: 'dimension_unchanged', from: before, to: this.dimension, portal: { ...portal.position } };
  }

  async _buildPortal ({ withCorners = true, axis = null } = {}) {
    const needs = withCorners ? PORTAL_FRAME_NEEDS_FULL : PORTAL_FRAME_NEEDS_MINIMAL;
    const have = this.inventory[PORTAL_FRAME_BLOCK] || 0;
    if (have < needs.obsidian) {
      return { ok: false, error: 'missing_materials', missing: [{ item: PORTAL_FRAME_BLOCK, need: needs.obsidian, have }] };
    }
    let plan = null;
    if (axis === 'x' || axis === 'z') {
      const site = this._portalBuildSite({ withCorners });
      plan = site && site.axis === axis ? site : null;
    } else {
      plan = this._portalBuildSite({ withCorners });
    }
    if (!plan) return { ok: false, error: 'no_portal_site', axis: axis ?? null };
    const placed = [];
    const failed = [];
    // Dal basso verso l'alto: ogni blocco poggia su una cornice già piazzata
    // (o sul terreno), così il server ha sempre un supporto valido.
    const order = [...plan.frame].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x || a.position.z - b.position.z);
    for (const cell of order) {
      const support = { x: cell.position.x, y: cell.position.y - 1, z: cell.position.z };
      const result = await this._placeAtCell(PORTAL_FRAME_BLOCK, PORTAL_FRAME_BLOCK, cell.position, support, 1);
      if (result?.ok) placed.push({ ...cell.position });
      else failed.push({ position: { ...cell.position }, error: result?.error ?? 'unknown' });
      // Una cornice a metà non si lascia dietro: si ferma e si riporta.
      if (failed.length) break;
    }
    this._lastPortalFrame = { ok: failed.length === 0, axis: plan.axis, origin: plan.origin, placed: placed.length, failed: failed.length, at: Date.now() };
    if (failed.length) {
      return { ok: false, error: 'portal_frame_incomplete', axis: plan.axis, origin: plan.origin, placed: placed.length, failed };
    }
    return { ok: true, axis: plan.axis, origin: plan.origin, placed: placed.length, needs, ignition: plan.ignition, entry: plan.entry };
  }

  async _lightPortal ({ timeoutMs = 8000, radius = PORTAL_FRAME_RADIUS } = {}) {
    if ((this.inventory[PORTAL_IGNITER] || 0) < 1) return { ok: false, error: 'missing_flint_and_steel', item: PORTAL_IGNITER };
    const found = this._findPortalFrame({ radius });
    if (!found) return { ok: false, error: 'no_portal_frame', radius };
    if (found.check.lit) return { ok: true, lit: true, already: true, origin: found.plan.origin, axis: found.plan.axis };
    let slotIndex = this.inventorySlots.findIndex(s => this._slotItemName(s) === PORTAL_IGNITER && s.count > 0);
    if (slotIndex < 0) return { ok: false, error: 'missing_flint_and_steel', item: PORTAL_IGNITER };
    if (slotIndex > 8) {
      try { slotIndex = await this._moveSlotToHotbar(slotIndex); }
      catch (error) { return { ok: false, error: `igniter_equip_failed: ${error.message}` }; }
    }
    this._selectHotbarSlot(slotIndex);
    const held = this.inventorySlots[this.selectedHotbar];
    const ignition = found.plan.ignition;
    const look = this._lookAt({ x: ignition.position.x + 0.5, y: ignition.position.y + 0.5, z: ignition.position.z + 0.5 });
    await this._queueAuthInput({ yaw: look.yaw, pitch: look.pitch });
    await delay(120);
    await this._queueAuthInput({
      yaw: look.yaw,
      pitch: look.pitch,
      transaction: this._itemUseOnBlockTransaction(held, ignition.position, ignition.face),
    });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const lit = found.plan.interior.some(cell => portalBlockName(this.world.blockAt(cell)?.name) === PORTAL_BLOCK);
      if (lit) {
        this._refreshNearby();
        return { ok: true, lit: true, origin: found.plan.origin, axis: found.plan.axis, ignition: { ...ignition.position } };
      }
      await delay(100);
    }
    return { ok: false, error: 'portal_not_lit', origin: found.plan.origin, ignition: { ...ignition.position } };
  }

  // Proprietà di stato di un blocco in una posizione (leva aperta, repeater
  // alimentato, delay, facing…): `null` quando il blocco o lo stato non sono
  // leggibili, così un valore ignoto non viene mai scambiato per "spento".
  _blockProps (position) {
    if (!position || typeof this.world?.blockAt !== 'function') return null;
    return blockProperties(this.world.blockAt(position));
  }

  // Censimento redstone (R0): una sola scansione per l'intero vocabolario
  // (minerali + componenti + TNT) invece di una per nome, con lo stesso
  // accorgimento dei fluidi: un mondo senza colonne caricate non è un mondo senza
  // redstone, quindi non si mette in cache e si dichiara `ready: false`.
  _redstoneCensus ({ force = false } = {}) {
    const now = Date.now();
    if (!force && this._redstoneScan && now - this._redstoneScanAt < REDSTONE_RESCAN_MS) return this._redstoneScan;
    let blocks = [];
    if (this.position && typeof this.world?.findBlocks === 'function') {
      blocks = this.world.findBlocks(REDSTONE_NEARBY_NAMES, this.position, REDSTONE_SCAN_RADIUS, REDSTONE_SCAN_LIMIT) ?? [];
    }
    const census = this._buildRedstoneView(blocks);
    if (!census.ready) {
      this._redstoneBlocks = null;
      return census;
    }
    this._redstoneBlocks = blocks;
    this._redstoneScan = census;
    this._redstoneScanAt = now;
    return this._redstoneScan;
  }

  // Assemblaggio puro della vista dai blocchi trovati: usato dalla scansione e
  // dalle patch di `update_block` (che riusano la stessa funzione, quindi non
  // possono divergere dalla vista "vera").
  _buildRedstoneView (blocks) {
    const loaded = this.world?.loaded?.size ?? null;
    const view = redstoneView(blocks, { from: this._feet ?? this.position, limit: REDSTONE_SCAN_LIMIT });
    return { ...view, found: blocks.length, loaded, ready: loaded !== 0, at: Date.now() };
  }

  // R2 — sensing continuo. Il server manda `update_block` a ogni cambio (leva
  // azionata, pistone esteso, lampada accesa): se la cella è redstone la cache
  // del censimento viene aggiornata **in place** (niente nuova scansione, che
  // costerebbe un findBlocks per ogni blocco scavato) e il cambio resta in
  // `_redstoneChange` per la diagnostica. Una cella non redstone non tocca nulla.
  _noteRedstoneUpdate (position, at = this._now()) {
    if (!position) return;
    const cell = { x: position.x, y: position.y, z: position.z };
    const before = componentAt(this._redstoneScan, cell);
    const block = this.world?.blockAt?.(cell);
    const name = String(block?.name ?? '').replace(/^minecraft:/i, '').toLowerCase();
    const relevant = REDSTONE_COMPONENTS.has(name) || REDSTONE_HAZARDS.has(name) || isRedstoneOre(name);
    if (!before && !relevant) return;
    const state = relevant ? this._buildRedstoneView([block]) : null;
    const row = state ? (state.components[0] ?? state.hazards[0] ?? state.ore[0] ?? null) : null;
    this._redstoneChange = {
      position: cell,
      name: name || before?.name || null,
      previous: before?.power ?? null,
      power: row?.power ?? null,
      powerKnown: row != null ? row.power != null : null,
      at,
    };
    // Il timestamp è un parametro (con default `Date.now()`) per potersi
    // misurare un ritardo dichiarato dal server: la traccia è ordinata e
    // limitata, così non cresce senza controllo durante una sessione lunga.
    this._redstoneTrace.push({ position: cell, name: this._redstoneChange.name, power: row?.power ?? null, at });
    if (this._redstoneTrace.length > REDSTONE_TRACE_LIMIT) {
      this._redstoneTrace.splice(0, this._redstoneTrace.length - REDSTONE_TRACE_LIMIT);
    }
    if (this._redstoneBlocks) {
      const index = this._redstoneBlocks.findIndex(b => b?.position
        && b.position.x === cell.x && b.position.y === cell.y && b.position.z === cell.z);
      if (index >= 0) this._redstoneBlocks.splice(index, 1);
      if (relevant) this._redstoneBlocks.push(block);
      this._redstoneScan = this._buildRedstoneView(this._redstoneBlocks);
      this._redstoneScanAt = Date.now();
    }
  }

  _redstoneView ({ force = false } = {}) {
    const census = this._redstoneCensus({ force });
    return { ...census, ...summarizeRedstone(census), lastChange: this._redstoneChange };
  }

  // R2: leva o pulsante più vicino (fra i componenti a portata). Gli input sono
  // gli unici che un click può azionare: una torcia o una piastra si leggono ma
  // non si comandano.
  _pickRedstoneInput () {
    const rows = (this._redstoneCensus()?.components ?? []).filter(row => isRedstoneInput(row));
    const usable = this._reachabilityUsable();
    return rows.find(row => !usable || this.approachReachable(row.position, { range: 3.5, dy: 2 })) ?? null;
  }

  // La lava entro `LAVA_AVOID_RANGE`: la cella più vicina (motivo per `avoid_lava`).
  _lavaThreat () {
    const census = this._fluidCensus();
    if (!census.lava?.nearest) return null;
    if (census.lavaDistance != null && census.lavaDistance > LAVA_AVOID_RANGE) return null;
    return { position: census.lava.nearest.position, distance: census.lava.nearest.distance ?? null };
  }

  // Una cella con lava in orizzontale ai piedi non è una destinazione: brucia.
  // Il censimento è in cache, quindi qui si tratta solo di una lookup su Set.
  _lavaAdjacent (x, y, z) {
    if (!this._lavaCells) this._fluidCensus();
    if (!this._lavaCells?.size) return false;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (this._lavaCells.has(`${x + dx},${y},${z + dz}`)) return true;
    }
    return false;
  }

  // Allontana il bot dalla lava: fra le celle d'appoggio raggiungibili che
  // guadagnano distanza, sceglie quella che guadagna di più (rankEscapeCells).
  async _avoidLava (timeoutMs = 15000) {
    if (!this._feet) return { ok: false, error: 'no_position' };
    const threat = this._lavaThreat();
    if (!threat) return { ok: true, moved: false, reason: 'no_lava_nearby' };
    const hazards = this._fluidCensus().cells.lava;
    const from = { x: this._feet.x, y: this._feet.y, z: this._feet.z };
    const candidates = [];
    for (const radius of [12, 8, 16]) {
      for (let i = 0; i < 16; i++) {
        const angle = (i / 16) * Math.PI * 2;
        const point = { x: from.x + Math.cos(angle) * radius, z: from.z + Math.sin(angle) * radius };
        const cell = this._standableNear(point);
        if (!cell) continue;
        if (this._reachabilityUsable() && !this.cellReachable(cell)) continue;
        candidates.push(cell);
      }
    }
    const ranked = rankEscapeCells(candidates, { from, hazards, minGain: 1.5, limit: 4 });
    if (!ranked.length) {
      this.log('avoid_lava_no_cell', { position: from, lava: threat.position });
      return { ok: false, error: 'no_safe_cell', lava: threat.position, distance: threat.distance };
    }
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    for (const entry of ranked) {
      if (Date.now() >= deadline) break;
      try {
        await this._moveTo(entry.cell, 0.8, Math.min(8000, Math.max(2000, deadline - Date.now())));
        const after = this._fluidCensus({ force: true });
        return {
          ok: true,
          moved: true,
          lava: threat.position,
          fromDistance: threat.distance,
          gain: entry.gain,
          lavaDistance: after.lavaDistance,
          position: this.pos(),
        };
      } catch (error) {
        lastError = error.message;
      }
    }
    return { ok: false, error: `avoid_lava_failed${lastError ? `: ${lastError}` : ''}`, lava: threat.position };
  }

  // M4 — Quanti blocchi di lava separano il bot dalla sponda opposta, lungo i
  // quattro versi: il tratto più corto. La lava non è mai una scorciatoia, quindi
  // la misura serve solo a decidere *se* si può attraversare (e con cosa).
  _lavaGapAhead ({ maxSteps = LAVA_CROSS_GAP_LIMIT + 2 } = {}) {
    const feet = this._feet ?? this.position;
    const lava = this._fluidCensus()?.cells?.lava ?? [];
    if (!feet || !lava.length) return { gap: 0, steps: [], reason: 'no_lava' };
    // `lavaGap` misura a passi di un blocco partendo da una *cella*: con le
    // coordinate frazionarie dei piedi (0.5) nessuna cella intera verrebbe
    // riconosciuta, quindi si parte dalla cella occupata.
    const from = { x: Math.floor(feet.x), y: Math.floor(feet.y + 0.1), z: Math.floor(feet.z) };
    let best = null;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const measured = lavaGap({ from, direction: { x: dx, z: dz }, lava, maxSteps });
      if (!measured.gap) continue;
      if (!best || measured.gap < best.gap) best = measured;
    }
    return best ? { ...best, from } : { gap: 0, steps: [], reason: 'no_lava' };
  }

  // M4 — Il verdetto sul sito di morte, ricalcolato dal censimento: in lava (o
  // a un blocco dal bordo) il loot è distrutto, e `recover_loot` non si offre.
  _deathVerdict () {
    if (!this.deathSite) return null;
    return deathVerdict({ position: this.deathSite.position, lava: this._fluidCensus()?.cells?.lava ?? [] });
  }

  _waterBucketsHeld () {
    return (this.inventory?.water_bucket || 0);
  }

  _bridgeBlocksHeld () {
    const item = this._placeableBlock({ richest: true });
    return item ? (this.inventory?.[item] || 0) : 0;
  }

  // M4 — Vista della lava: dove è, quanto è larga, cosa manca per attraversarla e
  // quali drop ha già distrutto. La morte in lava è un fatto del sito di morte,
  // non un'opinione: il verdetto arriva da `deathVerdict` sul censimento vero.
  _lavaView ({ force = false } = {}) {
    const census = this._fluidCensus({ force });
    const lava = census?.cells?.lava ?? [];
    const from = this._feet ?? this.position;
    const death = this.deathSite
      ? deathVerdict({ position: this.deathSite.position, lava })
      : null;
    const resistance = fireResistance({ effects: this.effects });
    const gap = this._lavaGapAhead();
    const gate = lavaCrossingGate({
      dimension: this.dimension ?? 'overworld',
      gap: gap.truncated ? null : gap.gap,
      fireResistance: resistance.active,
      waterBuckets: this._waterBucketsHeld(),
      bridgeBlocks: this._bridgeBlocksHeld(),
    });
    return {
      dimension: this.dimension ?? 'overworld',
      // Come in `_fluidsView`: i piedi sono frazionari, la cella è quella arrotondata.
      inLava: from ? this._fluidKindAt(Math.floor(from.x), Math.floor(from.y + 0.1), Math.floor(from.z)) === 'lava' : false,
      lavaDistance: census?.lavaDistance ?? null,
      nearest: census?.lava?.nearest?.position ?? null,
      cells: lava.length,
      fireResistance: resistance,
      gap,
      gate,
      lostDrops: lostDrops(this.drops, lava),
      death,
      last: this._lavaLast,
    };
  }

  // M4 — Fuga dalla lava: una sponda sicura, preferibilmente con l'acqua accanto
  // (entrare in acqua spegne il fuoco). `avoid_lava` allontana dalla lava vicina;
  // `move_to_safe` serve quando la lava è *addosso*.
  async _moveToSafe ({ timeoutMs = 15000 } = {}) {
    if (!this._feet) return { ok: false, error: 'no_position' };
    const before = this._lavaView();
    if (!before.inLava && !(before.lavaDistance != null && before.lavaDistance <= LAVA_CONTACT_RANGE)) {
      return { ok: false, error: 'not_in_danger', inLava: before.inLava, lavaDistance: before.lavaDistance };
    }
    const census = this._fluidCensus();
    const from = { x: this._feet.x, y: this._feet.y, z: this._feet.z };
    const candidates = [];
    for (const radius of [4, 8, 12]) {
      for (let i = 0; i < 12; i++) {
        const angle = (i / 12) * Math.PI * 2;
        const cell = this._standableNear({ x: from.x + Math.cos(angle) * radius, z: from.z + Math.sin(angle) * radius });
        if (!cell) continue;
        if (this._reachabilityUsable() && !this.cellReachable(cell)) continue;
        candidates.push(cell);
      }
    }
    const ranked = safeShorePlan({
      from,
      candidates,
      hazards: census?.cells?.lava ?? [],
      water: census?.cells?.water ?? [],
    });
    if (!ranked.length) {
      this.log('move_to_safe_no_cell', { position: from, lava: before.nearest });
      return { ok: false, error: 'no_safe_cell', inLava: before.inLava, lavaDistance: before.lavaDistance };
    }
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    for (const entry of ranked) {
      if (Date.now() >= deadline) break;
      try {
        await this._moveTo(entry.cell, 0.8, Math.min(8000, Math.max(2000, deadline - Date.now())));
        const after = this._lavaView({ force: true });
        const report = {
          ok: true,
          moved: true,
          from: { inLava: before.inLava, lavaDistance: before.lavaDistance },
          to: { inLava: after.inLava, lavaDistance: after.lavaDistance },
          waterAdjacent: entry.waterAdjacent,
          gain: entry.gain,
          position: this.pos(),
        };
        this._lavaLast = report;
        this.log('move_to_safe', report);
        return report;
      } catch (error) {
        lastError = error.message;
      }
    }
    this.log('move_to_safe_failed', { position: from, error: lastError });
    return { ok: false, error: `move_to_safe_failed${lastError ? `: ${lastError}` : ''}`, lava: before.nearest };
  }

  // M2 — la cella asciutta piu' vicina: dove la testa non e' piu' sott'acqua. La
  // ricerca e' a raggiera (16 direzioni, raggi crescenti) e si ferma al primo
  // anello che ne trova una: non serve la piu' vicina in assoluto, serve una
  // riva raggiungibile adesso, mentre l'aria scende.
  _shoreCell () {
    if (!this._feet) return null;
    const from = { x: this._feet.x, y: this._feet.y, z: this._feet.z };
    let best = null;
    for (const radius of [3, 5, 8, 12, 16]) {
      for (let i = 0; i < 16; i++) {
        const angle = (i / 16) * Math.PI * 2;
        const cell = this._standableNear({ x: from.x + Math.cos(angle) * radius, z: from.z + Math.sin(angle) * radius });
        if (!cell) continue;
        if (this._fluidKindAt(Math.floor(cell.x), cell.y + 1, Math.floor(cell.z)) === 'water') continue; // testa ancora in acqua
        const d = Math.hypot(cell.x - from.x, cell.z - from.z);
        if (best && d >= best.distance) continue;
        if (this._reachabilityUsable() && !this.cellReachable(cell)) continue;
        best = { x: cell.x, y: cell.y, z: cell.z, distance: +d.toFixed(2) };
      }
      if (best) break;
    }
    return best;
  }

  // M2 — "respirare": cammina fino alla riva piu' vicina e verifica col server
  // che la testa sia davvero fuori dall'acqua. Un rifiuto e' tipizzato
  // (`no_shore` = nessuna cella asciutta nel raggio, `still_underwater` = ci sono
  // arrivato ma la testa e' ancora sotto), cosi' il controller puo' decidere
  // invece di credere a un successo.
  async _surfaceFromWater ({ timeoutMs = 15000 } = {}) {
    if (!this._feet) return { ok: false, error: 'no_position' };
    const airBefore = Number.isFinite(this.air) ? this.air : null;
    if (!this._headInWater()) return { ok: true, surfaced: true, reason: 'head_above_water', air: airBefore };
    const shore = this._shoreCell();
    if (!shore) {
      this.log('surface_no_shore', { position: this._feet, air: airBefore });
      return { ok: false, error: 'no_shore', air: airBefore };
    }
    try {
      await this._moveTo(shore, 0.7, Math.min(timeoutMs, 8000));
    } catch (error) {
      const failed = { ok: false, error: 'surface_failed: ' + error.message, shore, airBefore, air: Number.isFinite(this.air) ? this.air : null };
      this.log('surface_failed', failed);
      return failed;
    }
    const surfaced = !this._headInWater();
    const report = {
      ok: surfaced,
      surfaced,
      shore,
      airBefore,
      air: Number.isFinite(this.air) ? this.air : null,
      position: this.pos(),
    };
    if (!surfaced) report.error = 'still_underwater';
    this._surfaceLast = report;
    this.log('surface', report);
    return report;
  }

  // M4 — Attraversare la lava: solo col gate aperto (resistenza al fuoco + ponte,
  // o acqua → ossidiana dove l'acqua si può piazzare). Costruire il ponte è M5/M6:
  // qui si rifiuta con il piano in mano invece di fingere un attraversamento.
  async _crossLava () {
    const view = this._lavaView();
    if (view.inLava) return { ok: false, error: 'in_lava', hint: 'use move_to_safe first', position: this.pos() };
    if (!view.gap?.gap) return { ok: false, error: 'no_lava_ahead', lavaDistance: view.lavaDistance };
    if (view.gap.truncated) {
      return { ok: false, error: 'gap_unknown', hint: 'the far shore is beyond the scan radius, so the bridge cannot be sized' };
    }
    if (!view.gate?.ok) {
      return { ok: false, error: view.gate?.error ?? 'not_equipped', gate: view.gate };
    }
    const plan = {
      route: view.gate.route,
      blocks: view.gate.blocks,
      gap: view.gap.gap,
      firstStep: view.gap.firstStep,
      direction: view.gap.direction,
    };
    if (view.gate.route === 'none') return { ok: false, error: 'no_gap_to_bridge', plan, hint: 'nothing to bridge' };
    this.log('cross_lava_started', { plan });
    return this._bridgeLava();
  }

  // M5: il ponte sulla lava. Il gate di M4 dice *se* si può (resistenza al fuoco
  // per i tratti lunghi, materiali contati); qui si posa una cella per volta —
  // acqua sulla lava (che diventa ossidiana) se c'è, altrimenti blocchi — e si
  // avanza solo su una cella confermata dal mondo. Se qualcosa si inceppa a metà,
  // il bot resta in piedi su una cella sicura e lo dichiara: mai una traversata
  // immaginaria.
  async _bridgeLava ({ timeoutMs = 90000 } = {}) {
    const view = this._lavaView();
    if (view.inLava) return { ok: false, error: 'in_lava', hint: 'use move_to_safe first' };
    const gap = view.gap;
    if (!gap?.gap) return { ok: false, error: 'no_lava_ahead', lavaDistance: view.lavaDistance };
    if (gap.truncated) return { ok: false, error: 'gap_unknown', hint: 'the far shore is beyond the scan radius, so the bridge cannot be sized' };
    if (!view.gate?.ok) return { ok: false, error: view.gate?.error ?? 'not_equipped', gate: view.gate };
    if (view.gate.route === 'none') return { ok: false, error: 'no_gap_to_bridge' };
    const base = gap.from;
    if (!base) return { ok: false, error: 'gap_unknown', hint: 'no base cell for the measured gap' };
    // La faccia da cliccare è quella del blocco d'appoggio rivolta alla cella
    // nuova: la direzione del tratto la decide.
    const face = gap.direction.x === 1 ? 5 : gap.direction.x === -1 ? 4 : gap.direction.z === 1 ? 3 : 2;
    const deadline = Date.now() + timeoutMs;
    const placed = [];
    let support = base;
    for (let step = gap.firstStep; step <= gap.lastStep; step++) {
      if (Date.now() > deadline) return { ok: false, error: 'bridge_timeout', placed, at: { ...support }, remaining: gap.lastStep - step + 1 };
      const cell = { x: base.x + gap.direction.x * step, y: base.y, z: base.z + gap.direction.z * step };
      const before = this.world.blockAt(cell);
      const solidAlready = !!before?.name && !/lava/.test(before.name) && !/^(air|cave_air|void_air|unknown)$/.test(before.name);
      if (!solidAlready) {
        let laid = null;
        if ((this.inventory[WATER_BUCKET_ITEM] || 0) > 0) laid = await this._emptyBucket({ item: WATER_BUCKET_ITEM, target: cell });
        if (!laid?.ok) {
          const item = this._placeableBlock({ richest: true });
          if (!item) return { ok: false, error: 'bridge_out_of_materials', placed, at: cell };
          laid = await this._placeAtCell(item, item, cell, support, face);
        }
        if (!laid?.ok) return { ok: false, error: 'bridge_stalled', placed, at: cell, last: laid };
        placed.push({ cell, via: laid.poured ? 'water' : 'block', world: laid.world ?? laid.block ?? null });
      }
      try {
        await this._moveTo({ x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }, 0.7, 8000);
      } catch (error) {
        return { ok: false, error: `bridge_step_failed: ${error.message}`, placed, at: cell };
      }
      support = cell;
    }
    const report = { ok: true, crossed: true, route: view.gate.route, placed, blocks: placed.length, from: base };
    this.log('lava_bridged', report);
    return report;
  }

  // --- M5: secchi, barche e pozioni ---------------------------------------
  // Il secchio è l'unico modo di *spostare* un fluido: riempirlo richiede una
  // sorgente vera (l'acqua che scorre non si raccoglie) e svuotarlo sulla lava
  // cambia il mondo (ossidiana o cobblestone) invece di allagare. La conferma
  // viene sempre dal server: delta di inventario per il riempimento, blocco nel
  // mondo per lo svuotamento.

  _bucketsHeld () {
    return {
      empty: this.inventory[BUCKET_ITEM] || 0,
      water: this.inventory[WATER_BUCKET_ITEM] || 0,
      lava: this.inventory[LAVA_BUCKET_ITEM] || 0,
      milk: this.inventory[MILK_BUCKET_ITEM] || 0,
      powderSnow: this.inventory[POWDER_SNOW_BUCKET_ITEM] || 0,
      glassBottles: this.inventory[GLASS_BOTTLE_ITEM] || 0,
      waterBottles: this.inventory[WATER_BOTTLE_ITEM] || 0,
    };
  }

  _plankCount () {
    return Object.keys(this.inventory).filter(name => /_planks$/.test(name)).reduce((sum, name) => sum + (this.inventory[name] || 0), 0);
  }

  // La cella davanti al bot: `_digDirection` è la stessa bussola degli scavi,
  // quindi "davanti" vuol dire la stessa cosa ovunque.
  _frontCell ({ dy = 0 } = {}) {
    if (!this._feet) return null;
    const d = this._digDirection();
    return { x: Math.floor(this._feet.x) + d.dx, y: Math.floor(this._feet.y + 0.1) + dy, z: Math.floor(this._feet.z) + d.dz };
  }

  /**
   * Sorgenti raccoglibili entro `radius`. Il nome del blocco viene letto dal
   * mondo: il censimento sa *dove* è l'acqua, non se scorre (e un secchio
   * raccoglie solo la sorgente).
   */
  _bucketSources ({ radius = 16, limit = 4 } = {}) {
    const census = this._fluidCensus();
    const out = [];
    for (const kind of ['water', 'lava', 'powder_snow']) {
      for (const cell of census?.cells?.[kind] ?? []) {
        const verdict = bucketSourceVerdict({ block: this.world.blockAt(cell) });
        if (!verdict.fillable) continue;
        const distance = this._pointDistance({ x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 });
        if (!(distance <= radius)) continue;
        out.push({ kind, position: cell, item: verdict.item, block: verdict.name, reason: verdict.reason, distance: +distance.toFixed(2) });
      }
    }
    out.sort((a, b) => a.distance - b.distance);
    return out.slice(0, limit);
  }

  // Riempie il secchio (o la fiala) alla prima sorgente accettata. La conferma è
  // il delta di inventario: il mondo che cambia è una seconda conferma, non il
  // criterio.
  async _useOnSource ({ item, accept = [WATER_BUCKET_ITEM], produced = null, timeoutMs = 6000 } = {}) {
    if ((this.inventory[item] || 0) < 1) return { ok: false, error: `missing_${item}` };
    const source = this._bucketSources().find(s => accept.includes(s.item));
    if (!source) return { ok: false, error: 'no_source_nearby', water: this._fluidCensus()?.water?.count ?? 0 };
    const equipped = await this._equipForUse(item);
    if (!equipped.ok) return equipped;
    const center = { x: source.position.x + 0.5, y: source.position.y + 0.5, z: source.position.z + 0.5 };
    if (this._pointDistance(center) > 4.5) {
      try { await this._moveTo(center, 2.5, 20000); } catch (error) { this.log('source_approach_failed', { message: error.message }); }
    }
    if (this._pointDistance(center) > 5.5) {
      return { ok: false, error: 'source_unreachable', position: source.position, distance: +this._pointDistance(center).toFixed(2) };
    }
    const before = { ...this.inventory };
    const wanted = produced ?? source.item;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const held = this.inventorySlots[this.selectedHotbar];
      const look = this._lookAt(center);
      await this._queueAuthInput({ yaw: look.yaw, pitch: look.pitch });
      await delay(120);
      await this._queueAuthInput({ yaw: look.yaw, pitch: look.pitch, transaction: this._itemUseOnBlockTransaction(held, source.position, 1) });
      const waitUntil = Math.min(deadline, Date.now() + 2000);
      while (Date.now() < waitUntil) {
        const delta = bucketDelta({ before, after: this.inventory, item: wanted, spentItem: item });
        if (delta.ok) {
          const report = { ok: true, filled: wanted, source: source.position, block: source.block, reason: source.reason, delta: delta.delta, confirmedBy: 'inventory_delta' };
          this._bucketLast = report;
          this.log('bucket_filled', report);
          return report;
        }
        await delay(100);
      }
    }
    this.log('bucket_fill_failed', { position: source.position, item: wanted });
    return { ok: false, error: 'fill_not_confirmed', position: source.position, item: wanted };
  }

  _fillBucket () {
    return this._useOnSource({ item: BUCKET_ITEM, accept: [WATER_BUCKET_ITEM, LAVA_BUCKET_ITEM, POWDER_SNOW_BUCKET_ITEM] });
  }

  _fillBottle () {
    return this._useOnSource({ item: GLASS_BOTTLE_ITEM, accept: [WATER_BUCKET_ITEM], produced: WATER_BOTTLE_ITEM });
  }

  // Svuota il secchio dove il verdetto puro lo permette: sulla lava più vicina
  // (se porta acqua) o nella cella davanti al bot.
  async _emptyBucket ({ item = WATER_BUCKET_ITEM, target = null, face = 1, timeoutMs = 5000 } = {}) {
    if ((this.inventory[item] || 0) < 1) return { ok: false, error: `missing_${item}` };
    let cell = target;
    if (!cell) {
      const lava = item === WATER_BUCKET_ITEM ? this._lavaView().nearest : null;
      cell = lava ? { x: Math.round(lava.x), y: Math.round(lava.y), z: Math.round(lava.z) } : this._frontCell();
    }
    if (!cell) return { ok: false, error: 'no_target_cell' };
    const block = this.world.blockAt(cell);
    const verdict = placeBucketVerdict({ held: item, block, dimension: this.dimension });
    if (!verdict.ok) return { ...verdict, position: cell, block: block?.name ?? null };
    const equipped = await this._equipForUse(item);
    if (!equipped.ok) return equipped;
    const center = { x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 };
    if (this._pointDistance(center) > 4.5) {
      try { await this._moveTo(center, 2.5, 20000); } catch (error) { this.log('bucket_target_approach_failed', { message: error.message }); }
    }
    const above = { x: cell.x, y: cell.y + 1, z: cell.z };
    const before = { ...this.inventory };
    const beforeName = block?.name ?? null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const held = this.inventorySlots[this.selectedHotbar];
      const look = this._lookAt(center);
      await this._queueAuthInput({ yaw: look.yaw, pitch: look.pitch });
      await delay(120);
      await this._queueAuthInput({ yaw: look.yaw, pitch: look.pitch, transaction: this._itemUseOnBlockTransaction(held, cell, face) });
      const waitUntil = Math.min(deadline, Date.now() + 2000);
      while (Date.now() < waitUntil) {
        const here = this.world.blockAt(cell);
        const spilled = this.world.blockAt(above);
        const changed = (here?.name ?? null) !== beforeName || fluidKind(spilled?.name) === 'water';
        const delta = bucketDelta({ before, after: this.inventory, item });
        if (changed || delta.spent > 0) {
          const report = { ok: true, poured: item, expected: verdict.result, reason: verdict.reason, position: cell, world: here?.name ?? null, above: spilled?.name ?? null, confirmedBy: changed ? 'server_world' : 'inventory_delta' };
          this._bucketLast = report;
          this.log('bucket_emptied', report);
          return report;
        }
        await delay(100);
      }
    }
    this.log('bucket_empty_failed', { position: cell, expected: verdict.result });
    return { ok: false, error: 'empty_not_confirmed', position: cell, expected: verdict.result };
  }

  _boatCount () {
    return Object.keys(this.inventory).filter(name => isBoatItem(name)).reduce((sum, name) => sum + (this.inventory[name] || 0), 0);
  }

  // R8: il bot è a bordo di una barca? `this.riding` dice solo che è montato su
  // qualcosa: il tipo dell'entità cavalcata lo distingue da cavallo, maiale o
  // minecart.
  _ridingBoat () {
    if (!this.riding) return false;
    // L'id è numerico nel pacchetto e stringa nella mappa delle entità (dipende
    // dal percorso che ha confermato il montaggio): si provano entrambe le chiavi.
    const id = this.riding.riddenEntityId;
    const entity = this.entities.get(id) ?? this.entities.get(String(id)) ?? null;
    return !!entity && isBoatItem(normalizeEntityType(entity.type));
  }

  // R8: odometro a bordo. La posizione autorevole arriva ~20 volte al secondo
  // (`move_player`): mentre il bot è su una barca il tratto percorso è
  // l'evidenza che `boat_travel` usa al posto di «la posizione è cambiata». Un
  // contatore monotono, mai azzerato: i segmenti lo leggono come differenza fra
  // inizio e fine, quindi un respawn o una nuova sessione non inventano metri.
  _trackRidingDistance (from, to) {
    if (!from || !to || !this._ridingBoat()) return;
    const step = Math.hypot(to.x - from.x, to.z - from.z);
    if (Number.isFinite(step)) this.ridingDistance += step;
  }

  _nearestBoat (limit = 8) {
    const rows = [];
    for (const entity of this.entities.values()) {
      if (!entity.position || !isBoatItem(normalizeEntityType(entity.type))) continue;
      const distance = this._entityDistance(entity);
      if (distance > 32) continue;
      rows.push({ type: entity.type, runtimeId: entity.runtimeId, position: entity.position, distance: +distance.toFixed(1) });
    }
    rows.sort((a, b) => a.distance - b.distance);
    return rows.slice(0, limit);
  }

  async _craftBoat () {
    const recipe = this.recipes ? [...this.recipes.keys()].find(name => isBoatItem(name)) : null;
    if (!recipe) return { ok: false, error: 'craft_recipe_missing', item: 'boat' };
    const planks = this._plankCount();
    if (planks < BOAT_INGREDIENTS.planks) {
      return { ok: false, error: 'missing_ingredients', item: recipe, missing: { planks: BOAT_INGREDIENTS.planks - planks } };
    }
    const result = await this._craftItem(recipe);
    if (result.ok) this.log('boat_crafted', { item: recipe });
    return result;
  }

  // Una barca è un'entità come un cavallo: si sale con lo stesso `interact`, ma
  // il gate è l'acqua aperta (e la barca in inventario).
  async _mountBoat ({ timeoutMs = 20000 } = {}) {
    const census = this._fluidCensus();
    const verdict = boatVerdict({ boats: this._boatCount(), water: census?.water ?? null, waterDistance: census?.waterDistance ?? null, riding: !!this.riding });
    if (!verdict.ok) return verdict;
    const target = this._nearestBoat()[0] ?? null;
    if (!target) return { ok: false, error: 'no_boat_nearby', hint: 'place the boat on the water first' };
    const empty = this.inventorySlots.findIndex((s, i) => i < 9 && !s?.network_id);
    if (empty >= 0) this._selectHotbarSlot(empty);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !this.riding) {
      const live = this.entities.get(String(target.runtimeId));
      if (!live) return { ok: false, error: 'boat_gone' };
      if (this._entityDistance(live) > 4.5) {
        try { await this._moveTo(live.position, 2.0, Math.min(15000, deadline - Date.now())); } catch (error) { this.log('boat_approach_failed', { message: error.message }); }
      }
      const current = this.entities.get(String(target.runtimeId));
      if (!current) return { ok: false, error: 'boat_gone' };
      if (this._entityDistance(current) > 5) return { ok: false, error: 'boat_unreachable' };
      const look = this._lookAt({ x: current.position.x, y: current.position.y + 0.5, z: current.position.z });
      await this._queueAuthInput({ yaw: look.yaw, pitch: look.pitch });
      await delay(120);
      this._interactEntity(current);
      const waitUntil = Math.min(deadline, Date.now() + 2000);
      while (Date.now() < waitUntil && !this.riding) await delay(100);
    }
    if (!this.riding) return { ok: false, error: 'mount_not_confirmed', type: 'boat' };
    const report = { ok: true, mounted: 'boat', ridden: this.riding.riddenEntityId, water: verdict.waterCount };
    this.log('boat_mounted', report);
    return report;
  }

  // M5: la pozione si *decide* qui, non si improvvisa. L'interazione col
  // brewing_stand (combustibile + fiala + ingrediente nel container, più il
  // timer di 400 tick) è il residuo dichiarato di M5: meglio un rifiuto
  // tipizzato con il piano in mano che una pozione immaginaria.
  _brewStand () {
    try { return this.world.findBlocks('brewing_stand', this.position, 8, 1).length > 0; } catch { return false; }
  }

  _brewPlan (effect) {
    return brewPlan({
      effect,
      stand: this._brewStand(),
      fuel: this.inventory[BREW_FUEL] || 0,
      waterBottles: this.inventory[WATER_BOTTLE_ITEM] || 0,
      netherWart: this.inventory[BREW_BASE] || 0,
      ingredients: this.inventory,
    });
  }

  async _brew (effect) {
    const plan = this._brewPlan(effect);
    if (!plan.ok) {
      this.log('brew_refused', { effect, error: plan.error, missing: plan.missing });
      return { ok: false, error: plan.error, missing: plan.missing, plan };
    }
    this.log('brew_blocked', { effect, plan });
    return { ok: false, error: 'brew_not_implemented', plan, hint: 'the stand interaction is the residual of M5' };
  }

  _bucketView ({ force = false } = {}) {
    const census = this._fluidCensus({ force });
    const sources = this._bucketSources();
    const boat = this._nearestBoat()[0] ?? null;
    return {
      held: this._bucketsHeld(),
      sources: sources.map(s => ({ kind: s.kind, position: s.position, block: s.block, item: s.item, reason: s.reason, distance: s.distance })),
      water: { count: census?.water?.count ?? 0, nearest: census?.water?.nearest ?? null, distance: census?.waterDistance ?? null },
      lava: { count: census?.lava?.count ?? 0, distance: census?.lavaDistance ?? null },
      boat: {
        inInventory: this._boatCount(),
        nearby: boat ? { type: boat.type, position: boat.position, distance: boat.distance } : null,
        verdict: boatVerdict({ boats: this._boatCount(), water: census?.water ?? null, waterDistance: census?.waterDistance ?? null, riding: !!this.riding }),
      },
      brew: {
        stand: this._brewStand(),
        fuel: this.inventory[BREW_FUEL] || 0,
        waterBottles: this.inventory[WATER_BOTTLE_ITEM] || 0,
        netherWart: this.inventory[BREW_BASE] || 0,
        effects: Object.fromEntries(BREW_EFFECTS.map(effect => [effect, this._brewPlan(effect).error])),
      },
      last: this._bucketLast,
    };
  }

  // N3: il proiettile che *sta arrivando*, con la traiettoria misurata. La
  // vista Nether espone solo il riassunto (distanza, tempo all'impatto): per
  // schivare serve la velocità, e la riga di `_projectileRows` ha i campioni.
  _incomingThreat () {
    const from = this._feet ?? this.position;
    if (!from) return null;
    const now = Date.now();
    const projectiles = this._projectileRows();
    const threat = projectileIncoming({ projectiles, from, now });
    if (!threat) return null;
    const row = projectiles.find(p => p.position && p.distance === threat.distance && (!threat.type || p.type === threat.type)) ?? null;
    const measured = row ? projectileVelocity({ position: row.position, previous: row.previous, now }) : { velocity: null };
    return { ...threat, velocity: measured.velocity };
  }

  // Le celle dove la schivata può portare: fuori dalla linea di tiro, dentro il
  // componente raggiungibile, con un appoggio calpestabile e senza lava accanto
  // (scappare da un ghast dentro la lava è il modo più comune di morire).
  _dodgeCandidates (projectile = null) {
    const threat = projectile ?? this._incomingThreat();
    if (!threat || !this._feet) return { threat: null, from: null, cells: [] };
    const from = { x: this._feet.x, y: this._feet.y, z: this._feet.z };
    const usable = this._reachabilityUsable();
    const cells = dodgeCandidates({ from, projectile: threat })
      .filter(cell => breaksLine({ from, candidate: cell, projectile: threat }))
      .filter(cell => !usable || this.cellReachable(cell))
      .filter(cell => this._standable(cell.x, cell.y, cell.z))
      .filter(cell => !this._lavaAdjacent(cell.x, cell.y, cell.z));
    return { threat, from, cells };
  }

  // Uscire dalla linea di tiro, non "correre via": il proiettile viaggia più
  // veloce del bot, quindi conta solo la componente laterale dello spostamento.
  // La schivata è verificata dall'osservazione (non c'è più niente in arrivo),
  // non dal fatto che il bot si sia mosso.
  async _dodgeProjectile ({ timeoutMs = 8000 } = {}) {
    if (!this.spawned || !this._feet) return { ok: false, error: 'not_ready' };
    const { threat, from, cells } = this._dodgeCandidates();
    if (!threat) return { ok: false, error: 'no_projectile_incoming' };
    const summary = { type: threat.type ?? null, distance: threat.distance, timeToImpactMs: threat.timeToImpactMs, source: threat.source };
    if (!cells.length) {
      this.log('dodge_no_spot', { from, threat: summary, candidates: dodgeCandidates({ from, projectile: threat }).length });
      return { ok: false, error: 'no_dodge_spot', threat: summary };
    }
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    for (const cell of cells) {
      if (Date.now() >= deadline) break;
      try {
        await this._moveTo(cell, 0.8, Math.max(1200, Math.min(4000, deadline - Date.now())));
        if (!this._incomingThreat()) {
          this.log('dodge_projectile', { from, to: cell, lateral: cell.lateral, threat: summary });
          return { ok: true, dodged: true, from, to: { x: cell.x + 0.5, y: this._feet.y, z: cell.z + 0.5 }, lateral: cell.lateral, threat: summary };
        }
        lastError = 'still_incoming';
      } catch (error) {
        lastError = error.message;
      }
    }
    this.log('dodge_failed', { from, threat: summary, reason: lastError ?? 'timeout' });
    return { ok: false, error: 'dodge_failed', reason: lastError ?? 'timeout', from, threat: summary };
  }

  // I piglin vicini, nella forma che serve alla selezione pura.
  _piglinRows ({ range = BARTER_RANGE } = {}) {
    const from = this._feet ?? this.position;
    if (!from || !this.spawned) return [];
    const rows = [];
    for (const entity of this.entities.values()) {
      if (!entity?.position || !isPiglinType(entity.type)) continue;
      const distance = this._entityDistance(entity);
      if (distance > range) continue;
      rows.push({ type: entity.type, position: entity.position, baby: !!entity.baby, distance, runtimeId: entity.runtimeId });
    }
    return rows;
  }

  _barterPiglinNearby ({ range = BARTER_RANGE } = {}) {
    const from = this._feet ?? this.position;
    return barterTarget({ piglins: this._piglinRows({ range }), from, range });
  }

  _barterPiglinView () {
    const { target, nearest } = this._barterPiglinNearby();
    const row = target ?? nearest;
    if (!row) return null;
    return {
      type: row.type,
      distance: row.distance,
      baby: row.baby,
      brute: row.brute,
      barterable: !!target,
      position: { x: +row.position.x.toFixed(1), y: +row.position.y.toFixed(1), z: +row.position.z.toFixed(1) },
    };
  }

  // N4: bartering. Il piglin prende il lingotto *dalla mano* (`item_use_on_entity`
  // con `interact`, mai un colpo: un `attack` lo rende ostile per sempre) e dopo
  // qualche secondo getta a terra il suo pegno. La conferma è osservativa: un
  // drop nuovo comparso vicino al piglin (poi raccolto con la primitiva di
  // raccolta già esistente) — non il fatto che il pacchetto sia partito.
  async _barterPiglin ({ timeoutMs = BARTER_WAIT_MS } = {}) {
    if (!this.spawned || !this._feet) return { ok: false, error: 'not_ready' };
    const { target, nearest } = this._barterPiglinNearby();
    if (!target) {
      if (!nearest) return { ok: false, error: 'no_piglin_nearby', range: BARTER_RANGE };
      return { ok: false, error: nearest.brute ? 'piglin_brute_not_barterable' : 'piglin_baby_not_barterable', piglin: { type: nearest.type, position: nearest.position, distance: nearest.distance } };
    }
    if ((this.inventory[BARTER_INGOT] || 0) < 1) {
      return { ok: false, error: 'missing_gold_ingot', item: BARTER_INGOT, piglin: { type: target.type, position: target.position, distance: target.distance } };
    }
    // La riga porta il runtime id: nessun match per distanza (che sarebbe fragile
    // appena il piglin si muove).
    const entity = target.runtimeId != null ? this.entities.get(String(target.runtimeId)) : null;
    if (!entity) return { ok: false, error: 'piglin_gone' };
    if (!this.entityApproachable(entity, { range: 3.5, dy: 2 })) {
      return { ok: false, error: 'piglin_unreachable', piglin: { type: target.type, position: target.position, distance: target.distance } };
    }
    const equipped = await this._equipItemInHotbar(BARTER_INGOT);
    if (!equipped.ok) return { ok: false, error: `barter_equip_failed: ${equipped.error.replace(/^equip_failed: /, '')}`, item: BARTER_INGOT };
    if (this._entityDistance(entity) > 4.5) {
      try { await this._moveTo(entity.position, 2.0, 25000); } catch (error) { this.log('piglin_approach_failed', { message: error.message }); }
    }
    const before = {
      ingots: this.inventory[BARTER_INGOT] || 0,
      drops: new Set(this.drops.map(d => `${d.item}|${Math.round(d.position.x)}|${Math.round(d.position.y)}|${Math.round(d.position.z)}`)),
    };
    const neutral = piglinNeutral({ worn: this._wornArmor() });
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      const live = this.entities.get(String(entity.runtimeId));
      if (!live) return { ok: false, error: 'piglin_gone', bartered: false };
      if (this._entityDistance(live) > 6) return { ok: false, error: 'piglin_unreachable', bartered: false };
      const look = this._lookAt({ x: live.position.x, y: live.position.y + entityHeight(live.type) * 0.5, z: live.position.z });
      await this._queueAuthInput({ yaw: look.yaw, pitch: look.pitch });
      await delay(120);
      this._interactEntity(live);
      last = { at: Date.now(), distance: +this._entityDistance(live).toFixed(2) };
      const gave = (this.inventory[BARTER_INGOT] || 0) < before.ingots;
      const fresh = this.drops.filter(d => {
        const key = `${d.item}|${Math.round(d.position.x)}|${Math.round(d.position.y)}|${Math.round(d.position.z)}`;
        return !before.drops.has(key) && Math.hypot(d.position.x - live.position.x, d.position.z - live.position.z) <= 8;
      });
      if (fresh.length) {
        const collected = [];
        for (const drop of fresh) {
          const pickup = await this._collectDrop();
          collected.push({ item: drop.item, ok: !!pickup?.ok, picked: pickup?.picked ?? null });
        }
        const rewards = fresh.map(d => d.item).filter(isBarterReward);
        const report = { ok: true, bartered: true, piglin: { type: target.type, position: target.position, distance: target.distance }, gave: BARTER_INGOT, gaveIngot: gave, neutral, drops: fresh.map(d => d.item), rewards, collected, lastInteract: last };
        this._barterLast = { ...report, at: Date.now() };
        this.log('barter_piglin', { piglin: report.piglin, drops: report.drops, rewards, gave, neutral });
        return report;
      }
      await delay(900);
    }
    const gaveIngot = (this.inventory[BARTER_INGOT] || 0) < before.ingots;
    this._barterLast = { ok: false, error: 'barter_not_confirmed', piglin: { type: target.type, position: target.position, distance: target.distance }, neutral, gaveIngot, at: Date.now() };
    this.log('barter_not_confirmed', { piglin: target.position, distance: target.distance, neutral, last });
    return { ok: false, error: 'barter_not_confirmed', bartered: false, gaveIngot, piglin: { type: target.type, position: target.position, distance: target.distance }, neutral, lastInteract: last };
  }

  _beeRows () {
    return [...this.entities.values()]
      .filter(e => normalizeEntityType(e.type) === 'bee' && e.position && this._entityDistance(e) <= BEE_SCAN_RADIUS)
      .map(e => ({ runtimeId: String(e.runtimeId), position: { ...e.position },
        distance: this._entityDistance(e), baby: !!e.baby, inlove: !!e.inlove, angry: !!e.angry }))
      .sort((a, b) => a.distance - b.distance);
  }

  _hiveVisible (position) {
    if (!this.position) return false;
    const aim = { x: position.x + 0.5, y: position.y + 0.5, z: position.z + 0.5 };
    const steps = Math.ceil(Math.hypot(aim.x - this.position.x, aim.y - this.position.y, aim.z - this.position.z) * 4);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const cell = { x: Math.floor(this.position.x + (aim.x - this.position.x) * t),
        y: Math.floor(this.position.y + (aim.y - this.position.y) * t),
        z: Math.floor(this.position.z + (aim.z - this.position.z) * t) };
      if (cell.x === position.x && cell.y === position.y && cell.z === position.z) continue;
      const block = this.world.blockAt(cell);
      if (!block || block.name === 'unknown' || !this._passable(block)) return false;
    }
    return true;
  }

  _beesView ({ force = false } = {}) {
    if (!this.position) return { hives: [], bees: [], flower: beeFlower(this.inventory), scanRadius: BEE_SCAN_RADIUS, scanLimit: BEE_SCAN_LIMIT };
    // Cache only discovery positions; safety properties are reread every time.
    const scanKey = `${this.dimension}:${Math.floor(this.position.x)}:${Math.floor(this.position.y)}:${Math.floor(this.position.z)}`;
    if (force || this._beeHiveScan?.key !== scanKey || Date.now() - this._beeHiveScan.at > 3000) {
      this._beeHiveScan = { key: scanKey, at: Date.now(),
        positions: this.world.findBlocks(HIVE_BLOCKS, this.position, BEE_SCAN_RADIUS, BEE_SCAN_LIMIT)
          .filter(b => b.position).map(b => ({ ...b.position })) };
    }
    const hives = this._beeHiveScan.positions.map(position => {
      const block = this.world.blockAt(position);
      if (!HIVE_BLOCKS.includes(block?.name)) return null;
      const verdict = hiveVerdict(block, p => this.world.blockAt(p));
      const reachable = !this._reachabilityUsable() || this.approachReachable(position, { range: 2.5, dy: 2 });
      return { type: block.name, position, distance: this._pointDistance(position), reachable, ...verdict };
    }).filter(Boolean).sort((a, b) => a.distance - b.distance);
    return { hives, bees: this._beeRows(), flower: beeFlower(this.inventory), scanRadius: BEE_SCAN_RADIUS, scanLimit: BEE_SCAN_LIMIT };
  }

  _beeFeedable (row) {
    const entity = this.entities.get(row.runtimeId);
    if (!entity || row.angry || row.inlove || row.distance > 4.5) return false;
    const visibility = this._entityVisible(entity);
    return visibility.visible && !visibility.unknown && this.entityApproachable(entity, { range: 3, dy: 2 });
  }

  _beePair (rows) {
    const adults = rows.filter(row => !row.baby && this._beeFeedable(row));
    for (let i = 0; i < adults.length; i++) {
      const a = adults[i];
      const b = adults.slice(i + 1).find(b => Math.hypot(a.position.x - b.position.x,
        a.position.y - b.position.y, a.position.z - b.position.z) <= 4);
      if (b) return [a, b];
    }
    return null;
  }

  _beeOptions () {
    const view = this._beesView();
    const options = [];
    if (!view.bees.some(b => b.angry)) {
      const hive = view.hives.find(h => h.safe && h.reachable && (h.distance > 4.5 || this._hiveVisible(h.position)));
      if (hive && (this.inventory.shears || 0) > 0) options.push({ key: 'harvest_honeycomb',
        description: `Shear the full smoked ${hive.type} at ${JSON.stringify(hive.position)} (${hive.distance.toFixed(1)} blocks away); collect its honeycomb drops next` });
      if (hive && (this.inventory.glass_bottle || 0) > 0) options.push({ key: 'harvest_honey',
        description: `Bottle honey from the full smoked ${hive.type} at ${JSON.stringify(hive.position)} (${hive.distance.toFixed(1)} blocks away)` });
      if (view.flower && view.bees.some(b => this._beeFeedable(b))) options.push({ key: 'feed_bee',
        description: `Feed a nearby calm bee ${view.flower}; confirm flower consumption or love state` });
      if (beeFlowerCount(this.inventory) >= 2 && this._beePair(view.bees)) options.push({ key: 'breed_bee',
        description: 'Feed two nearby calm adult bees flowers and wait for a newly observed baby bee' });
    }
    for (const item of BEE_CRAFT_ITEMS) {
      if (this._craftableNow(item)) options.push({ key: `craft_${item}`, description: `Craft ${item} using an available server recipe` });
    }
    return options;
  }

  async _harvestHoney (product, timeoutMs = 5000) {
    if (!['honeycomb', 'honey_bottle'].includes(product)) return { ok: false, error: 'unknown_hive_product' };
    const tool = product === 'honeycomb' ? 'shears' : 'glass_bottle';
    if ((this.inventory[tool] || 0) < 1) return { ok: false, error: 'missing_hive_tool', tool };
    const view = this._beesView({ force: true });
    if (view.bees.some(b => b.angry)) return { ok: false, error: 'bee_angry' };
    if (!view.hives.length) return { ok: false, error: 'no_hive_nearby' };
    const hive = view.hives.find(h => h.safe && h.reachable && (h.distance > 4.5 || this._hiveVisible(h.position)));
    if (!hive) return { ok: false, error: 'no_safe_hive', hives: view.hives };
    const client = this.client;
    const connected = () => this.client === client && this.spawned && this.status === 'spawned' && !this.dead;
    const center = { x: hive.position.x + 0.5, y: hive.position.y + 0.5, z: hive.position.z + 0.5 };
    if (hive.distance > 4.5) {
      try { await this._moveTo(center, 2.5, 8000); }
      catch { return { ok: false, error: 'hive_unreachable', position: hive.position }; }
    }
    if (!connected()) return { ok: false, error: 'not_connected' };
    const equipped = await this._equipItemInHotbar(tool, { resync: false });
    if (!equipped.ok) return equipped;
    const look = this._lookAt(center);
    await this._queueAuthInput(look);
    await delay(120);
    // Recheck after movement/equip/look: neither stale options nor a stale scan
    // can authorize an unsafe click. Send exactly one harvesting interaction.
    if (!connected()) return { ok: false, error: 'not_connected' };
    if (this._beeRows().some(b => b.angry)) return { ok: false, error: 'bee_angry' };
    const verdict = hiveVerdict(this.world.blockAt(hive.position), p => this.world.blockAt(p));
    if (!verdict.safe) return { ok: false, error: verdict.reason, position: hive.position };
    if (this._pointDistance(hive.position) > 4.5 || !this._hiveVisible(hive.position)) return { ok: false, error: 'hive_unreachable', position: hive.position };
    const held = this.inventorySlots[this.selectedHotbar];
    if (this._slotItemName(held) !== tool || !held?.count) return { ok: false, error: 'missing_hive_tool', tool };
    const before = this.inventory[product] || 0;
    const bottlesBefore = this.inventory.glass_bottle || 0;
    const dropsBefore = new Set(this.drops.map(d => String(d.id)));
    const face = this._faceForBlock(hive.position, this.position);
    const click = { x: 0.5, y: 0.5, z: 0.5 };
    if (face < 2) click.y = face;
    else if (face < 4) click.z = face === 2 ? 0 : 1;
    else click.x = face === 4 ? 0 : 1;
    await this._queueAuthInput({ ...look, transaction: this._itemUseOnBlockTransaction(held, hive.position, face, click) });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!connected()) return { ok: false, error: 'not_connected', interactionSent: true, position: hive.position };
      const gained = Math.max(0, (this.inventory[product] || 0) - before);
      const reset = honeyLevel(this.world.blockAt(hive.position)) === 0;
      const bottleSpent = (this.inventory.glass_bottle || 0) < bottlesBefore;
      if (gained > 0 && (product === 'honeycomb' ? reset : bottleSpent)) {
        return { ok: true, product, gained, collected: gained, position: hive.position,
          confirmedBy: product === 'honeycomb' ? 'hive_reset_and_inventory' : 'bottle_conversion' };
      }
      const drops = product === 'honeycomb' ? this.drops.filter(d => d.item === 'honeycomb' && d.position &&
        !dropsBefore.has(String(d.id)) && Math.hypot(d.position.x - center.x, d.position.y - center.y, d.position.z - center.z) <= 3) : [];
      if (reset && drops.length) return { ok: true, product, gained: 0, collected: 0,
        dropped: drops.reduce((sum, d) => sum + (d.count || 1), 0), position: hive.position, confirmedBy: 'hive_reset_and_new_drop', nextAction: 'collect_drop' };
      await delay(100);
    }
    return { ok: false, error: 'hive_harvest_not_confirmed', product, position: hive.position, interactionSent: true };
  }

  async _feedBee (runtimeId = null, timeoutMs = 3000) {
    const flower = beeFlower(this.inventory);
    if (!flower) return { ok: false, error: 'missing_bee_flower' };
    const rows = this._beeRows();
    if (rows.some(b => b.angry)) return { ok: false, error: 'bee_angry' };
    const bee = rows.find(b => (!runtimeId || b.runtimeId === String(runtimeId)) && this._beeFeedable(b));
    if (!bee) return { ok: false, error: 'no_feedable_bee' };
    const client = this.client;
    const equipped = await this._equipItemInHotbar(flower, { resync: false });
    if (!equipped.ok) return equipped;
    const live = this.entities.get(bee.runtimeId);
    if (!live) return { ok: false, error: 'bee_gone' };
    const look = this._lookAt({ ...live.position, y: live.position.y + entityHeight('bee') * 0.5 });
    await this._queueAuthInput(look);
    await delay(120);
    if (this.client !== client || !this.spawned || this.status !== 'spawned' || this.dead) return { ok: false, error: 'not_connected' };
    const current = this._beeRows().find(b => b.runtimeId === bee.runtimeId);
    if (this._beeRows().some(b => b.angry)) return { ok: false, error: 'bee_angry' };
    if (!current || !this._beeFeedable(current)) return { ok: false, error: 'no_feedable_bee' };
    const held = this.inventorySlots[this.selectedHotbar];
    if (this._slotItemName(held) !== flower || !held?.count) return { ok: false, error: 'missing_bee_flower' };
    const before = this.inventory[flower] || 0;
    this._interactEntity(this.entities.get(bee.runtimeId));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.client !== client || !this.spawned || this.status !== 'spawned' || this.dead) return { ok: false, error: 'not_connected', interactionSent: true };
      const watched = this.entities.get(bee.runtimeId);
      if (watched?.inlove || (this.inventory[flower] || 0) < before) return { ok: true, fed: 'bee', flower,
        runtimeId: bee.runtimeId, confirmedBy: watched?.inlove ? 'inlove' : 'flower_consumed' };
      await delay(100);
    }
    return { ok: false, error: 'bee_feed_not_confirmed', interactionSent: true };
  }

  async _breedBees (timeoutMs = 8000) {
    if (beeFlowerCount(this.inventory) < 2) return { ok: false, error: 'need_2_bee_flowers' };
    const rows = this._beeRows();
    if (rows.some(b => b.angry)) return { ok: false, error: 'bee_angry' };
    const pair = this._beePair(rows);
    if (!pair) return { ok: false, error: 'need_2_adult_bees' };
    const known = new Set(this.entities.keys());
    const client = this.client;
    const fed = [];
    for (const bee of pair) {
      if (this.client !== client || !this.spawned || this.status !== 'spawned' || this.dead) return { ok: false, error: 'not_connected', fed };
      const result = await this._feedBee(bee.runtimeId);
      if (!result.ok) return { ...result, fed };
      fed.push(result);
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.client !== client || !this.spawned || this.status !== 'spawned' || this.dead) return { ok: false, error: 'not_connected', fed };
      const baby = this._beeRows().find(b => b.baby && !known.has(b.runtimeId) && pair.some(a =>
        Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z) <= 3));
      if (baby) return { ok: true, bred: 'bee', baby, fed, confirmedBy: 'new_baby_entity' };
      await delay(100);
    }
    return { ok: false, error: 'baby_not_observed', type: 'bee', fed };
  }

  // Stato reale del kit da spedizione, non il piano: letto, luce, un piccone di
  // riserva e cibo. `missing` dice cosa manca e di quanto, così la risposta in
  // chat può elencare ciò che c'è e ciò che non c'è senza ricostruirlo a memoria.
  _tripKitView () {
    const inventory = this.inventory ?? {};
    const have = {};
    for (const tag of Object.keys(TRIP_KIT_REQUIREMENTS)) have[tag] = tagCount(inventory, tag);
    const missing = Object.entries(TRIP_KIT_REQUIREMENTS)
      .filter(([tag, min]) => have[tag] < min)
      .map(([tag, min]) => ({ tag, have: have[tag], need: min }));
    // Un piccone di riserva è il secondo, non il primo: il conteggio del tag è
    // «quanti ne ho», quindi il numero utile è quello meno l'arnese in mano.
    return { ...have, sparePickaxe: Math.max(0, have.pickaxes - 1), missing, ready: missing.length === 0 };
  }

  observe () {
    const heldSlot = this.inventorySlots[this.selectedHotbar];
    const heldInfo = heldSlot?.network_id ? this.world.registry?.items[heldSlot.network_id] : null;
    const armorSlots = this._armorSlots();
    const bed = this._findBed();
    // La vista dei fluidi serve due volte (stato + discesa): calcolarla una volta
    // sola evita di ripetere le letture delle celle.
    const fluids = this._fluidsView();
    return {
      step: this.recent.length,
      // M6.2: chi è il bot. `username` è il nome di autenticazione
      // (`BEDROCK_USERNAME`); `name` è il gamertag che il server attribuisce al
      // bot, imparato dall'eco (può differire dal primo). Il controller li usa
      // come trigger chat: il bot risponde anche se lo si chiama per nome.
      self: {username: USERNAME, name: this.selfName ?? null},
      position: this.pos(),
      biome: this.position && typeof this.world.biomeAt === 'function' ? this.world.biomeAt(this.position) : null,
      health: this.health,
      food: this.food,
      dimension: this.dimension,
      standingOn: this.standingOn,
      inventory: this.inventory,
      held: this._slotItemName(heldSlot),
      // `slots`/`unresolved` sono additivi: dicono cosa c'è addosso anche quando
      // il nome non si sa (pezzo indossato prima della palette), e quanto è
      // consumato. `points` resta la somma dei pezzi nominabili.
      armor: {
        ...this.armor,
        points: this._armorPoints(),
        slots: armorSlots,
        unresolved: armorSlots.filter(piece => piece && !piece.name).length,
      },
      travel: this._travelReadiness(),
      placement: this._lastPlacement ?? null,
      headroom: this._headroom(),
      memory: this.memory ? this.memory.observeView() : null,
      heldDurability: heldInfo?.maxDurability
        ? { damage: this._itemDamage(heldSlot), max: heldInfo.maxDurability }
        : null,
      // R8: odometro a bordo, per il criterio `ridingDistanceAtLeast`.
      riding: {
        mounted: !!this.riding,
        entityId: this.riding?.riddenEntityId ?? null,
        boat: this._ridingBoat(),
        distance: Math.round(this.ridingDistance * 100) / 100,
      },
      drops: this.drops.slice(0, 8).map(d => ({ ...d, reachable: this.dropReachable(d.position) })),
      containers: this._cachedContainers().map(c => ({
        position: c.position,
        type: c.type,
        readAt: c.readAt,
        contents: c.contents,
      })),
      // V1: il registro dei contenitori (scoperte e ispezioni) e la scala del
      // deposito. `checked: false` significa "non ho mai guardato".
      storage: this._storageView(),
      // M3c: cosa il bot è disposto a mettere via e dove andrebbe. È la stessa
      // politica di `dump_inventory`, così controller e chore non la duplicano.
      deposit: this._depositState(),
      plan: this.plan,
      follow: this._followView(),
      escort: this._escortView(),
      // Missione «l'umano si è imbarcato»: stato, motivo, azione e vista del
      // mezzo. Il controller la usa per dire dove aspetta invece di tacere.
      mountFollow: this._mountFollowView(),
      craft: this._craftNeeds({ liveGather: true }),
      chat: this.chatInbox.slice(-10),
      // R2: le domande in attesa di risposta (una voce per domanda viva).
      chatPending: this._chatPendingView(),
      nearby: this.nearbyBlocks,
      structures: this.structures.slice(0, 8),
      structureSurvey: this._structureSurvey,
      village: this._villageView(),
      fluids,
      dive: this._diveView({ fluids }),
      lava: this._lavaView(),
      bucket: this._bucketView(),
      nether: this._netherView(),
      redstone: this._redstoneView(),
      sculk: this._sculkView(),
      sneak: this._sneakView(),
      circuits: this._circuitsView(),
      construction: this.construction.view(),
      ores: (this.valuableOres ?? []).slice(0, 8),
      oreAlert: this.lastOreAlert ?? null,
      recent: this.recent.slice(-8),
      status: this.status,
      spawned: this.spawned,
      time: this._timeInfo(),
      bed: bed ? { position: bed.position, distance: bed.distance } : null,
      serverText: this.serverText.slice(-SERVER_TEXT_MAX),
      kit: this._tripKitView(),
      sleeping: this.sleeping,
      dead: this.dead,
      deaths: this.deaths,
      deathSite: this.deathSite ? { position: this.deathSite.position, at: this.deathSite.at } : null,
      experience: this.experienceLevel != null ? { level: this.experienceLevel, progress: this.experienceProgress } : null,
      entities: this._nearbyEntities(8),
      humans: this._nearbyHumanPlayers(),
      farmAnimals: this._nearbyFarmAnimals(8),
      companions: this._nearbyCompanion(8),
      fishing: this._fishingContext(),
      bees: this._beesView(),
      traders: this._nearbyTraders(8),
      trade: this.tradeOffers.length ? {
        open: this._tradeWindowOpen(),
        target: this.tradeTarget,
        displayName: this.tradeDisplayName,
        tier: this.tradeTier,
        newUI: this.tradeNewUI,
        offers: this.tradeOffers,
      } : null,
      world: this.world.summary(),
    };
  }

  options ({ localGatherOnly = false } = {}) {
    // Senza sessione viva `wait` non e' una scelta: e' un bot immobile che i mob
    // uccidono. Il 07/10/2026 il controller ha deciso `wait` 75 volte con una
    // sola opzione, con la ragione gia' nota (`not_connected`), e le ultime 9
    // morti del run hanno come ultima azione `wait(ok)`: la sessione NetherNet
    // era caduta e il harness fingeva un'azione valida. Le opzioni calcolate sul
    // mondo vecchio fallirebbero comunque, quindi la risposta e' il vuoto con la
    // ragione in `optionsBlindReason`, che l'harness espone in `/options`
    // (`connected: false` + `blind`). Il controller, che la legge, non brucia
    // passi su un `wait` che non e' una scelta.
    if (!this.sessionLive) {
      this.optionsBlindReason = 'not_connected';
      return [];
    }
    this.optionsBlindReason = null;
    if (this.dead) {
      return [{ key: 'wait', description: 'Dead; respawning automatically' }];
    }
    if (this.sleeping) {
      return [{ key: 'wait', description: 'Sleeping in bed until morning' }];
    }
    const o = [];
    const p = this.pos();
    const waypointUnmet = this.plan?.waypoint && p && (
      Math.hypot(this.plan.waypoint.x - p.x, this.plan.waypoint.z - p.z) > 2 ||
      (Number.isFinite(this.plan.waypoint.y) && Math.abs(this.plan.waypoint.y - (this._feet?.y ?? p.y - 1.62)) > 1));
    // Solo drop raggiungibili: un item finito in una tasca sotto il pavimento
    // brucerebbe il budget di movimento senza poter essere raccolto.
    // Un ordine umano "cattura <oggetto>" restringe l'insieme all'oggetto
    // nominato: senza filtro si raccoglierebbe il primo drop qualunque, e la
    // verifica (delta di inventario) non si chiuderebbe mai.
    const drop = this._nearestDrop({ reachableOnly: true, names: this._plannedCollectNames() });
    // Ordine umano "getta <oggetto>": l'azione e' deterministica lato
    // controller, che la sceglie quando la vede offerta. Qui l'opzione esiste
    // solo se l'oggetto del piano e' ancora in inventario.
    const plannedDrop = this._plannedDrop();
    if (plannedDrop) {
      o.push({ key: 'drop_item', description: `Drop ${plannedDrop.names.join(', ')} from the inventory${plannedDrop.count ? ` (${plannedDrop.count})` : ''}` });
    }
    // Un drop fresco e vicino va raccolto subito: lo si mette prima del waypoint
    // e lo si segnala nella descrizione.
    const fresh = drop && drop.spawnedAt && Date.now() - drop.spawnedAt < 15000 && drop.distance <= 8;
    if (drop && fresh) {
      o.push({ key: 'collect_drop', description: `Pick up the item just dropped (${drop.item} ×${drop.count || 1}, ${drop.distance.toFixed(1)} blocks away)` });
    }
    if (waypointUnmet) {
      o.push({ key: 'goto_waypoint', description: `Pathfind to planner waypoint ${JSON.stringify(this.plan.waypoint)}` });
      // W1: la variante silenziosa. Il governor può togliere `goto_waypoint`
      // quando un warden è nei paraggi, non aggiungerla: qui viene offerta
      // accanto all'originale e il rifiuto `not_sneaking` arriva dall'esito.
      o.push({ key: 'sneak_to', description: `Sneak-walk to planner waypoint ${JSON.stringify(this.plan.waypoint)} (silent step; refused as \`not_sneaking\` if the server still moves at walk speed)` });
      o.push({ key: 'walk_stealthy', description: `Alias of sneak_to: crouch along a route whose every cell stays outside every sculk sensor sphere (refused as \`no_stealth_route\`/\`no_exit_route\`/\`sculk_unknown\` when it cannot be promised)` });
    }
    // Comando umano "seguimi": plan.follow = gamertag del giocatore da seguire.
    const follow = this._playerByName(this.plan?.follow);
    if (follow && follow.position && this.entityApproachable(follow, { range: 3, dy: 2 })) {
      const d = this._entityDistance(follow);
      o.push({ key: 'follow_player', description: `Follow ${follow.username || this.plan.follow} (${d.toFixed(1)} blocks away)` });
    } else if (this.plan?.follow) {
      // L'umano e' uscito dal raggio di vista (o e' irraggiungibile): prima di
      // chiedere in chat si va a cercarlo dove e' stato visto l'ultima volta.
      const seek = this._seekTarget(this.plan.follow);
      if (seek) {
        o.push({
          key: 'seek_player',
          description: `Search for ${this.plan.follow} near their last known position (${seek.distance.toFixed(1)} blocks away)`,
        });
      }
    }
    // L'umano si è imbarcato e c'è un posto per il bot: si sale *su quel mezzo*.
    // L'opzione sta qui — prima di ogni fallback di locomozione e dei `mount_*`
    // generici — perché inseguire una barca in acqua profonda non è una via per
    // raggiungerla: è il difetto che questa missione chiude.
    const mountFollow = this._mountFollowView();
    if (mountFollow.action === 'join' && mountFollow.mount) {
      const m = mountFollow.mount;
      o.push({
        key: 'join_human_mount',
        description: `Board ${mountFollow.human}'s ${m.type} (${m.free} free seat(s) of ${m.seats}, ${m.distance.toFixed(1)} blocks away, ${m.source === 'link' ? 'confirmed by the server link' : 'detected next to them'})`,
      });
    }
    // Ordine umano «guidami/accompagnami fino a <posto>»: `plan.escort.from` e'
    // l'umano da guidare, la meta e' `plan.escort.to` o il waypoint del piano.
    // E' il gemello di `follow_player`: la' il bot segue la persona, qui decide
    // la strada e aspetta chi resta indietro. L'opzione esiste solo se la
    // destinazione e' nota e l'umano e' tracciato: senza meta sarebbe un
    // inseguimento travestito.
    const escort = this._escortView();
    if (escort?.ready) {
      const destination = `${Math.round(escort.target.x)}, ${Math.round(escort.target.z)}`;
      o.push({
        key: 'escort_to',
        description: escort.waiting
          ? `Escort ${escort.name} to ${destination} (waiting for them: ${escort.gap} blocks behind)`
          : `Walk ${escort.name} to ${destination} (${escort.gap} blocks apart)`,
      });
    }
    if (drop && !fresh) {
      o.push({ key: 'collect_drop', description: `Walk onto the nearest dropped item (${drop.distance.toFixed(1)} blocks away)` });
    }
    // Sopravvivenza: mob ostili, cibo e letto. Le descrizioni portano il contesto
    // (distanza, vita, fame) e la scelta resta al controller.
    const threats = this._hostiles();
    const attackTypes = new Set();
    for (const threat of threats) {
      if (attackTypes.has(threat.type)) continue;
      if (!this.entityApproachable(threat, { range: 3.5, dy: 2 })) continue;
      // N4: un piglin non è mai un bersaglio. Colpirlo lo rende ostile per
      // sempre e chiude il bartering: la neutralità (o la fuga) è l'unica
      // risposta, e il vocabolario delle opzioni non deve nemmeno offrirla.
      if (isPiglinType(threat.type)) continue;
      attackTypes.add(threat.type);
      o.push({ key: `attack_${threat.type}`, description: `Attack the ${threat.type} (${threat.distance.toFixed(1)} blocks away, ${threat.health != null ? `health ${threat.health}` : 'health unknown'})` });
      if (attackTypes.size >= 3) break;
    }
    if (threats.length && threats[0].distance <= 16) {
      o.push({ key: 'flee', description: `Run away from the nearest ${threats[0].type} (${threats[0].distance.toFixed(1)} blocks away)` });
    }
    // N6: un blaze non si affronta in linea retta. `hunt_blaze` è la stessa
    // mischia con la differenza che conta (copertura prima, ritirata se si è già
    // troppo feriti) e resta un'opzione *in più* rispetto ad `attack_blaze`: il
    // vocabolario non nasconde la mischia semplice, le affianca la versione che
    // tiene conto della linea di tiro e dei rod che mancano.
    const blazeTarget = this._blazeRows()[0];
    if (blazeTarget && !(typeof this.health === 'number' && this.health <= BLAZE_RETREAT_HEALTH)) {
      const covers = this._coverFrom(blazeTarget).length;
      const rods = blazeRodProgress({ inventory: this.inventory });
      o.push({
        key: 'hunt_blaze',
        description: `Hunt the blaze at ${JSON.stringify({ x: Math.round(blazeTarget.position.x), y: Math.round(blazeTarget.position.y), z: Math.round(blazeTarget.position.z) })} (${blazeTarget.distance} blocks away, ${covers} cover spot${covers === 1 ? '' : 's'} in reach) — ${rods.have}/${rods.need} blaze rods`,
      });
    }
    // Lava: pericolo assoluto (M0). L'opzione esiste solo se la lava è davvero
    // vicina e se c'è una cella d'appoggio che aumenta la distanza.
    const lavaThreat = this._lavaThreat();
    const lavaNow = this._lavaView();
    if (lavaThreat) {
      o.push({ key: 'avoid_lava', description: `Move away from the lava at ${JSON.stringify({ x: Math.round(lavaThreat.position.x), y: Math.round(lavaThreat.position.y), z: Math.round(lavaThreat.position.z) })} (${lavaThreat.distance} blocks away)` });
    }
    // M4: quando la lava è addosso serve una *sponda*, non solo allontanarsi
    // (l'acqua accanto vale doppio: spegne il fuoco).
    if (lavaNow.inLava || (lavaNow.lavaDistance != null && lavaNow.lavaDistance <= LAVA_CONTACT_RANGE)) {
      o.push({ key: 'move_to_safe', description: `Get out of the lava now (${lavaNow.inLava ? 'standing in it' : `${lavaNow.lavaDistance} blocks away`}): reach a safe shore, water if possible` });
    }
    // M2 — respirare: con la testa sott'acqua l'unica cura e' uscirne. Il bot non
    // nuota, quindi "risalire" vuol dire camminare sul fondo o sulla riva dove la
    // testa esce dall'acqua. L'opzione esiste solo se una cella cosi' esiste.
    const breath = this._waterBreathing();
    if (this._headInWater() && !breath.active && (this.air == null || this.air <= SURFACE_AIR_ALERT)) {
      const shore = this._shoreCell();
      const airLeft = this.air == null ? 'air unknown' : airSeconds(this.air) + 's of air left';
      o.push({ key: 'surface', description: 'Surface for air (' + airLeft + (shore ? ', nearest dry cell ' + JSON.stringify({ x: Math.round(shore.x), y: shore.y, z: Math.round(shore.z) }) + ' (' + shore.distance + ' blocks)' : ', no dry cell in reach') + ')' });
    }
    // M4: attraversare si può solo col gate aperto (resistenza al fuoco + ponte).
    if (!lavaNow.inLava && lavaNow.gap?.gap > 0 && !lavaNow.gap.truncated && lavaNow.gate?.ok) {
      o.push({ key: 'cross_lava', description: `Cross the ${lavaNow.gap.gap}-block lava gap ahead (${lavaNow.gate.route}: ${lavaNow.gate.reason})` });
    }
    // M5: secchi, barche, pozioni. Come per le cascate, l'opzione compare solo
    // quando l'azione non verrebbe rifiutata dal verdetto puro.
    const buckets = this._bucketsHeld();
    const bucketSource = this._bucketSources()[0] ?? null;
    if (buckets.empty > 0 && bucketSource) {
      o.push({ key: 'fill_bucket', description: `Fill a bucket with ${bucketSource.block} at ${JSON.stringify(bucketSource.position)} (${bucketSource.distance} blocks away)` });
    }
    if (buckets.water > 0) {
      const lavaCell = lavaNow.nearest ? { x: Math.round(lavaNow.nearest.x), y: Math.round(lavaNow.nearest.y), z: Math.round(lavaNow.nearest.z) } : null;
      const cell = lavaCell ?? this._frontCell();
      const verdict = cell ? placeBucketVerdict({ held: WATER_BUCKET_ITEM, block: this.world.blockAt(cell), dimension: this.dimension }) : null;
      if (verdict?.ok) {
        const extra = verdict.reason === 'water_on_lava_source' ? ' — it will turn the lava into obsidian' : '';
        o.push({ key: 'place_water', description: `Pour water at ${JSON.stringify(cell)} (${verdict.result}${extra})` });
      }
    }
    if (buckets.glassBottles > 0 && bucketSource?.item === WATER_BUCKET_ITEM) {
      o.push({ key: 'fill_bottle', description: `Fill a glass bottle at the water source ${JSON.stringify(bucketSource.position)} (${bucketSource.distance} blocks away)` });
    }
    const boatRecipe = this.recipes ? [...this.recipes.keys()].find(name => isBoatItem(name)) : null;
    if (boatRecipe && this._plankCount() >= BOAT_INGREDIENTS.planks && this.world.findBlocks('crafting_table', this.position, 32, 1).length) {
      o.push({ key: 'craft_boat', description: `Craft a boat from ${BOAT_INGREDIENTS.planks} planks (takes the bot across the water)` });
    }
    const boatNow = boatVerdict({ boats: this._boatCount(), water: this._fluidCensus()?.water ?? null, waterDistance: this._fluidCensus()?.waterDistance ?? null, riding: !!this.riding });
    const nearestBoat = this._nearestBoat()[0] ?? null;
    if (boatNow.ok && nearestBoat) {
      o.push({ key: 'mount_boat', description: `Board the boat at ${JSON.stringify(nearestBoat.position)} (${nearestBoat.distance} blocks away)` });
    }
    // M3: cascate e colonne di bolle. L'opzione compare solo quando l'azione
    // corrispondente non verrebbe rifiutata (stesso verdetto di `columnTactic`),
    // così non si offre mai una discesa senza il movimento in acqua.
    const waterfall = this._waterfalls()[0] ?? null;
    if (waterfall) {
      const at = JSON.stringify({ x: waterfall.top.x, y: waterfall.top.y, z: waterfall.top.z });
      if (this._columnTactic('descend', { column: waterfall }).ok) {
        o.push({ key: 'descend_waterfall', description: `Ride the waterfall at ${at} down ${waterfall.height} blocks to the landing at ${JSON.stringify(waterfall.landing.position)}` });
      }
      if (this._columnTactic('climb', { column: waterfall }).ok) {
        o.push({ key: 'climb_waterfall', description: `Climb the water column at ${at} (${waterfall.height} blocks up)` });
      }
    }
    const bubble = this._bubbles()[0] ?? null;
    if (bubble && this._columnTactic('bubble', { column: bubble }).ok) {
      o.push({ key: 'use_bubble_column', description: `Ride the ${bubble.direction} bubble column at ${JSON.stringify({ x: bubble.x, y: bubble.bottom.y, z: bubble.z })} (${bubble.height} blocks, ${bubble.source})` });
    }
    // N3: un proiettile in arrivo si evita *uscendo dalla linea di tiro* (la
    // perpendicolare della traiettoria), non correndo via — e solo verso una
    // cella raggiungibile e lontana dalla lava.
    const dodge = this._dodgeCandidates();
    if (dodge.threat && dodge.cells.length) {
      const cell = dodge.cells[0];
      const eta = Number.isFinite(dodge.threat.timeToImpactMs) ? `, impact in ${Math.round(dodge.threat.timeToImpactMs)} ms` : '';
      o.push({ key: 'dodge_projectile', description: `Step out of the line of the ${dodge.threat.type ?? 'projectile'} at ${JSON.stringify({ x: Math.round(dodge.threat.position.x), y: Math.round(dodge.threat.position.y), z: Math.round(dodge.threat.position.z) })} (${dodge.threat.distance} blocks away${eta}) towards ${JSON.stringify({ x: cell.x, y: cell.y, z: cell.z })}` });
    }
    // N5: uno sguardo fisso sugli occhi si stacca dalla linea, non si ignora.
    const gaze = this._netherView().enderman;
    if (gaze?.aimingAtEyes === true && gaze.protected !== true) {
      o.push({ key: 'avoid_enderman_gaze', description: `Stop looking at the ${gaze.type} at ${JSON.stringify({ x: Math.round(gaze.position.x), y: Math.round(gaze.position.y), z: Math.round(gaze.position.z) })} (${gaze.distance} blocks away, ${gaze.angleDeg}° off the eyes)` });
    }
    // N5: la zucca in testa è la difesa passiva dallo sguardo.
    const pumpkin = this._pumpkinInInventory();
    if (pumpkin && !isPumpkinMask(this.armor?.helmet)) {
      o.push({ key: 'equip_pumpkin', description: `Wear the ${pumpkin.name} from inventory as a mask (endermen ignore a masked gaze)` });
    }
    // Rifugio: rientra a casa (spawn o HOME_WAYPOINT) quando è lontana o in pericolo.
    if (this.home && this.position) {
      const homeDist = Math.hypot(this.home.x - this.position.x, this.home.z - this.position.z);
      if (homeDist > 6) {
        const atRisk = threats.length ? ` (${threats[0].type} nearby)` : '';
        o.push({ key: 'go_home', description: `Return home to ${JSON.stringify({ x: Math.round(this.home.x), y: Math.round(this.home.y), z: Math.round(this.home.z) })} (${homeDist.toFixed(0)} blocks away${atRisk})` });
      }
    }
    // Armatura: equipaggia i pezzi dall'inventario negli slot armor.
    if (Object.keys(this.inventory).some(name => this._armorSlotFor(name) >= 0)) {
      o.push({ key: 'equip_armor', description: 'Equip armor pieces from inventory (helmet/chestplate/leggings/boots)' });
    }
    // Riarmo completo: armatura **e** scudo in un colpo solo (lo scudo sempre
    // nell'offhand, mai in zaino). È lo stesso passo che `recover_loot` fa da
    // solo, offerto come azione per quando il loot è già in zaino.
    if (this._needsRearm()) {
      o.push({ key: 'rearm_gear', description: 'Put the carried armor pieces and the shield back on (the shield always in the offhand)' });
    }
    // Porte: chiudi quelle aperte dal bot per sigillare il rifugio.
    if (this._closeDoorTarget()) {
      o.push({ key: 'close_door', description: 'Close the open door(s) behind you to keep mobs out' });
    }
    // Barricata: sigilla il varco davanti con 2 blocchi (piedi+testa).
    if (this._placeableBlock() && this._barricadeGap()) {
      o.push({ key: 'barricade', description: 'Seal the opening ahead with 2 blocks (feet + head) to block mobs' });
    }
    // Kit di viaggio: prepara il prossimo pezzo mancante e craftabile adesso
    // (assi → bastoni → tavolo → torce → letto). Idempotente.
    const kitNext = this._nextKitCraft();
    if (kitNext) {
      o.push({ key: 'travel_kit', description: `Prepare the travel kit for a multi-day expedition (next craftable step: ${kitNext})` });
    }
    // Pillar-up: un blocco sotto i piedi + salto (terza strategia notturna della
    // spec: funziona contro i mob terrestri, non contro quelli volanti).
    if (this._placeableBlock() && this._onGround && !this.riding) {
      o.push({ key: 'pillar_up', description: 'Place a block under your feet and climb onto it (escape a ground mob or start a shelter)' });
    }
    // Rifugio provvisorio: muri + tetto con i blocchi disponibili, quando serve
    // davvero (notte o ostili a tiro).
    if (this._placeableBlock() && (this._isNight() || this._hostiles().some(h => this._entityDistance(h) <= 16))) {
      o.push({ key: 'build_hut', description: 'Seal a temporary hut around you with blocks (walls + roof) to survive the night' });
    }
    // N2: nel Nether la casetta deve essere di materiale che non brucia e vale
    // come punto di rientro (`home`) — lì non esiste la notte, quindi il gate
    // non è "è tardi" ma "siamo nel Nether".
    if (isNetherLike(this.dimension) && pickHubBlock(Object.entries(this.inventory).map(([name, count]) => ({ name, count })))) {
      o.push({ key: 'build_nether_hub', description: 'Seal a nether hub around you with non-flammable blocks (walls + roof, remembered as a place to come back to)' });
    }
    // N4: bartering. L'oro in mano e un piglin adulto a tiro sono entrambi
    // necessari, e un bruto non è un candidato: l'opzione esiste solo quando una
    // trattativa è davvero possibile.
    const barter = this._barterPiglinNearby();
    if (barter.target && (this.inventory[BARTER_INGOT] || 0) > 0) {
      const neutral = piglinNeutral({ worn: this._wornArmor() });
      o.push({ key: 'barter_piglin', description: `Barter with the piglin at ${JSON.stringify({ x: Math.round(barter.target.position.x), y: Math.round(barter.target.position.y), z: Math.round(barter.target.position.z) })} (${barter.target.distance} blocks away) handing it a ${BARTER_INGOT}${neutral ? '' : ' (no gold armour worn: it may turn hostile)'}` });
    }
    const food = this._bestFoodItem({ allowLastResort: this.food <= STARVING_FOOD });
    if (food && (this.food < 18 || (this.health < 20 && this.food < 20))) {
      o.push({ key: 'eat', description: `Eat ${food} to restore hunger (hunger ${this.food}/20, health ${this.health}/20)` });
    }
    // Sonno: offerto di notte e durante un temporale (anche di giorno, come il
    // vanilla: https://minecraft.wiki/w/Bed).
    if (this._isSleepTime()) {
      const bed = this._findBed();
      // Nel Nether e nell'End il letto esplode: l'opzione non va offerta affatto,
      // altrimenti il planner sceglie un'azione che si autodistrugge.
      if (bed && !bedsExplode(this.dimension)) {
        const why = this._isNight() ? 'before the night is dangerous' : 'to wait out the thunderstorm';
        o.push({ key: 'sleep', description: `Sleep in the bed at ${JSON.stringify(bed.position)} (${bed.distance} blocks away) ${why}` });
      }
    }
    // N1: portale. Camminare verso un portale ha senso solo se il censimento ne
    // ha visto uno (e la raggiungibilità lo conferma); costruire e accendere
    // richiedono le mani nell'inventario, non la speranza.
    const portal = this._nearestPortal();
    if (portal?.position) {
      const reachable = !this._reachabilityUsable() || this.approachReachable(portal.position, { range: PORTAL_APPROACH_RANGE, dy: 2 });
      if (reachable) {
        o.push({ key: 'goto_portal', description: `Walk to the nether portal at ${JSON.stringify(portal.position)} (${portal.distance} blocks away)` });
        if (portal.distance != null && portal.distance <= PORTAL_APPROACH_RANGE + 1) {
          o.push({ key: 'enter_portal', description: 'Step into the portal and wait for the dimension change' });
        }
      }
    }
    if ((this.inventory[PORTAL_FRAME_BLOCK] || 0) >= PORTAL_FRAME_NEEDS_FULL.obsidian) {
      o.push({ key: 'build_portal', description: `Build a nether portal frame from ${this.inventory[PORTAL_FRAME_BLOCK]} obsidian (light it afterwards with flint and steel)` });
    }
    if ((this.inventory[PORTAL_IGNITER] || 0) >= 1) {
      const frame = this._findPortalFrame({ radius: PORTAL_FRAME_RADIUS });
      if (frame && !frame.check.lit) o.push({ key: 'light_portal', description: `Light the nether portal frame at ${JSON.stringify(frame.plan.origin)}` });
    }
    // N7: endgame. Le opzioni nascono dai fatti: quanti occhi si possono
    // craftare, se un occhio è in mano per lanciarlo, quanti telai vuoti sono
    // stati letti, e se il portale dell'End è già lì. Un portale completo non
    // chiede occhi: chiede di essere attraversato.
    if (this.recipes?.has(BLAZE_POWDER) && (this.inventory[BLAZE_ROD_ITEM] || 0) > 0 && (this.inventory[BLAZE_POWDER] || 0) < ENDER_EYE_FRAME_TOTAL) {
      o.push({ key: 'craft_blaze_powder', description: `Grind ${this.inventory[BLAZE_ROD_ITEM]} blaze rod(s) into blaze powder (${POWDER_PER_ROD} per rod), one at a time, to make eyes of ender` });
    }
    if (this.recipes?.has(EYE_OF_ENDER) && (this.inventory[BLAZE_POWDER] || 0) >= 1 && this._pearlsHeld() >= 1) {
      o.push({ key: 'craft_ender_eye', description: `Craft eyes of ender from ${this.inventory[BLAZE_POWDER]} blaze powder and ${this._pearlsHeld()} ender pearl(s)` });
    }
    const endFrames = this._endFrames();
    const endPortal = this._nearestPortal('end');
    if ((this.inventory[EYE_OF_ENDER] || 0) >= 1) {
      o.push({ key: 'throw_eye_of_ender', description: `Throw an eye of ender (${this.inventory[EYE_OF_ENDER]} left): it flies toward the stronghold, two throws from different spots triangulate it` });
    }
    if (this._endReadings().length >= 2 && !(endFrames.total > 0 && endFrames.nearest?.distance <= STRONGHOLD_RADIUS)) {
      o.push({ key: 'find_stronghold', description: `Walk toward the triangulated stronghold position ${JSON.stringify(this._endView().stronghold?.position ?? null)}` });
    }
    if (endFrames.total > 0 && endFrames.missing > 0 && (this.inventory[EYE_OF_ENDER] || 0) >= 1) {
      o.push({ key: 'fill_end_portal', description: `Place an eye of ender into the empty End portal frames at ${JSON.stringify(endFrames.nearest?.position ?? null)} (${endFrames.missing} missing of ${endFrames.total})` });
    }
    if (endPortal?.position) {
      const reachable = !this._reachabilityUsable() || this.approachReachable(endPortal.position, { range: PORTAL_APPROACH_RANGE, dy: 2 });
      if (reachable && endPortal.distance != null && endPortal.distance <= PORTAL_APPROACH_RANGE + 1) {
        o.push({ key: 'enter_end_portal', description: 'Step into the End portal and wait for the dimension change' });
      }
    }
    // Recupero post-morte: il loot e gli orb EXP sono rimasti dov'è morto. In
    // lava il loot è distrutto (M4): l'opzione non si offre nemmeno.
    if (this.deathSite && this.position && this._deathVerdict()?.recoverable !== false) {
      const p = this.deathSite.position;
      const d = Math.hypot(p.x - this.position.x, p.z - this.position.z);
      o.push({ key: 'recover_loot', description: `Walk back to the death site at ${JSON.stringify(p)} (${d.toFixed(1)} blocks) to recover the dropped items and XP orbs` });
    }
    // V1: passata di ricognizione sul villaggio. Si offre solo con un'ancora
    // identificata (senza, la passata si rifiuta) e fuori dal cooldown: una passata
    // è costosa, e scegliere fra due passate ravvicinate non è una decisione di chi
    // chiama — mentre *quale* area percorrere lo è, e resta a chi legge l'offerta.
    const villageAnchor = this._villageAnchor();
    if (villageAnchor && this._villageSweepRemaining() <= 0) {
      const reach = this.position ? Math.round(Math.hypot(villageAnchor.x - this.position.x, villageAnchor.z - this.position.z)) : null;
      o.push({ key: 'survey_village', description: `Walk the village around ${JSON.stringify(villageAnchor)}${reach != null ? ` (${reach} blocks away)` : ''} and census its houses, beds, plots, pens and chests (read-only, bounded)` });
    }
    // Commercio: apri la finestra su un trader vicino, oppure offri ogni scambio
    // eseguibile con l'inventario corrente. La scelta economica resta a Jev.
    const trader = this._nearestTrader();
    if (trader && !this._tradeWindowOpen() && this.entityApproachable(trader, { range: 3.5, dy: 2 })) {
      const urgency = trader.type === 'wandering_trader' ? ' (wandering trader, despawns soon!)' : '';
      o.push({ key: 'open_trade', description: `Open trade with the ${trader.type}${trader.profession != null ? ` (profession ${trader.profession})` : ''} ${trader.distance} blocks away${urgency}` });
    }
    if (this._tradeWindowOpen()) {
      o.push({ key: 'close_trade', description: 'Close the trading window' });
      this.tradeOffers.forEach((offer, index) => {
        if (!this._offerRequirementsMet(offer)) return;
        o.push({ key: `trade_${index}`, description: this._offerDescription(offer, index) });
      });
    }
    // Livellamento (maxxing): un'opzione per professione distinta tra i trader
    // vicini non ancora al massimo, più una generica se la professione è ignota.
    // Il loop usa solo scambi economici (mai smeraldi o risorse preziose).
    {
      const levelable = this._nearbyTraders(12).filter(t => t.type !== 'wandering_trader' && this.entityApproachable(t, { range: 3.5, dy: 2 }));
      const known = new Set();
      for (const t of levelable) {
        const maxTier = t.maxTradeTier ?? 4;
        if ((t.tradeTier ?? 0) >= maxTier) continue;
        const prof = t.profession ? normalizeProfession(t.profession) : null;
        if (prof && !known.has(prof)) {
          known.add(prof);
          o.push({ key: `level_${prof}`, description: `Level up the ${t.profession} to master (tier ${t.tradeTier ?? '?'}/${maxTier}) using only cheap, non-precious trades` });
        }
      }
      if (levelable.some(t => (t.tradeTier ?? 0) < (t.maxTradeTier ?? 4)) && !known.size) {
        o.push({ key: 'level_trader', description: 'Level up the nearest villager to master using only cheap, non-precious trades' });
      }
    }
    // Mining: offri un'opzione per ogni tipo di blocco scavabile nelle vicinanze.
    // Se il blocco più vicino è sepolto (nessuna faccia raggiungibile) non va offerto:
    // per raggiungerlo serve prima dig_down. Se l'inventario non ha l'utensile col
    // rango giusto, il blocco non lascerebbe drop: non va offerto.
    // Le colture si offrono solo da mature e come `harvest_<coltura>` (mieti e
    // ripianta): un raccolto acerbo distrugge la pianta senza dare semi, e senza
    // ripiantare la fattoria si esaurisce. Maturità ignota = come prima.
    for (const [blockName, blocks] of Object.entries(this.nearbyBlocks || {})) {
      if (isBeeProtected(blockName)) continue;
      const crop = isCropBlock(blockName);
      const { ready, immature } = crop ? this._harvestableCrops(blocks) : { ready: blocks, immature: 0 };
      const target = this._pickMineTarget(ready);
      if (!target) continue;
      const probe = this.world.blockAt(target.position);
      if (probe) {
        const kind = this._requiredToolKind(probe);
        const tool = kind ? this._bestInventoryTool(kind)?.name : null;
        if (!this._blockHarvestable(probe, tool)) continue;
      }
      // Il drop atterra nella cella del blocco scavato: se il bot non potrà
      // raggiungerla (cava sotto un pavimento, cunicolo chiuso) l'item è perso.
      if (this._reachabilityUsable() && !this.mineDropReachable(target.position)) continue;
      const away = `(${target.distance} blocks away)`;
      const skip = immature ? `, ${immature} immature left to grow` : '';
      const seed = crop ? seedForCrop(blockName) : null;
      o.push(crop
        ? { key: `harvest_${blockName}`, description: `Harvest the mature ${blockName} at ${JSON.stringify(target.position)} ${away} and replant ${seed || 'it'}${skip}` }
        : { key: `mine_${blockName}`, description: `Mine ${blockName} at ${JSON.stringify(target.position)} ${away}` });
    }
    // Occasioni: oltre alla lista fissa, le ore di valore osservate entrano come
    // opzioni mine_<ore> se il piccone in inventario le rende raccoglibili. Il
    // raggio è ORE_INTEREST_RANGE, quindi la finestra è breve: il controller può
    // coglierla (vedi controller-decisions.mjs) o ignorarla, ma il goal
    // VALUABLE_ORE_SEEN la rende comunque una scelta esplicita.
    const offeredKeys = new Set(o.map(option => option.key));
    for (const ore of this.valuableOres ?? []) {
      const key = `mine_${ore.name}`;
      if (offeredKeys.has(key) || !ore.harvestable || this._gatherProtected(ore)) continue;
      offeredKeys.add(key);
      o.push({ key, description: `Mine ${ore.name} at ${JSON.stringify(ore.position)} (${ore.distance} blocks away, opportunity)` });
    }
    if (localGatherOnly) return o.filter(option => /^(mine_|harvest_)/.test(option.key));
    // R4: il bot può anche *disfare* una propria posa (`mine_owned`): è l'unica
    // azione che toglie un blocco «protetto» (`crafting_table`, `_planks`, …)
    // senza allentare `DIG_PROTECTED`, perché il registro dice che la cella è sua.
    const recoverable = this._ownedRecoverable();
    if (recoverable.length) {
      const first = recoverable[0];
      o.push({
        key: 'mine_owned',
        description: `Mine the ${first.block} the bot placed itself at ${JSON.stringify(first.cell)} (${first.distance} blocks away)${first.circuit ? `, part of circuit ${first.circuit}` : ''}`,
      });
    }
    // Discesa: scavare un gradino verso il basso (testa, fronte e cella sotto il
    // fronte), poi avanzare di un blocco e scendere. Serve a raggiungere lo stone
    // quando è coperto; i gradini restano percorribili per tornare su.
    const dig = this._digTargets();
    if (!dig.error) {
      const description = dig.targets.length
        ? `Dig one step down through ${[...new Set(dig.targets.map(t => t.block.name))].join(', ')} to reach deeper layers`
        : 'Step down into the opening ahead';
      o.push({ key: 'dig_down', description });
    }
    // Risalita: apre i due blocchi sopra il gradino davanti e ci sale (serve a
    // uscire da buche o pozzi scavati in precedenza).
    const up = this._upTargets();
    if (!up.error) {
      const description = up.targets.length
        ? `Dig one step up through ${[...new Set(up.targets.map(t => t.block.name))].join(', ')} to climb out`
        : 'Step up into the opening ahead';
      o.push({ key: 'dig_up', description });
    }
    // Crafting: solo le ricette utili alla progressione, con materiali disponibili.
    if (this.recipes && this.craftingData) {
      const logs = Object.keys(this.inventory).filter(name => /(_log|_stem|_hyphae)$/.test(name));
      for (const log of logs) {
        const planks = `${log.replace(/(_log|_stem|_hyphae)$/, '')}_planks`;
        if (this.recipes.has(planks)) o.push({ key: `craft_${planks}`, description: `Craft ${planks} from ${log}` });
      }
      const planksHeld = Object.keys(this.inventory).find(name => /_planks$/.test(name));
      if (planksHeld) {
        if ((this.inventory.stick || 0) < 2) o.push({ key: 'craft_stick', description: 'Craft sticks from planks' });
        if (!(this.inventory.crafting_table > 0) && !this.world.findBlocks('crafting_table', this.position, 8, 1).length) {
          o.push({ key: 'craft_crafting_table', description: 'Craft a crafting table from 4 planks' });
        }
      }
      if (planksHeld && (this.inventory.stick || 0) >= 2 && (this.inventory[planksHeld] || 0) >= 3) {
        o.push({ key: 'craft_wooden_pickaxe', description: 'Craft a wooden pickaxe (uses a crafting table)' });
      }
      if (this.recipes.has('stone_pickaxe') && (this.inventory.cobblestone || 0) >= 3 && (this.inventory.stick || 0) >= 2 &&
          this.world.findBlocks('crafting_table', this.position, 32, 1).length) {
        o.push({ key: 'craft_stone_pickaxe', description: 'Craft a stone pickaxe at the crafting table (3 cobblestone + 2 sticks)' });
      }
      if (this.recipes.has('iron_pickaxe') && (this.inventory.iron_ingot || 0) >= 3 && (this.inventory.stick || 0) >= 2 &&
          this.world.findBlocks('crafting_table', this.position, 32, 1).length &&
          !Object.entries(this.inventory).some(([name, count]) => count > 0 && /^(iron|diamond|netherite)_pickaxe$/.test(name))) {
        o.push({ key: 'craft_iron_pickaxe', description: 'Craft an iron pickaxe at the crafting table (3 iron ingots + 2 sticks)' });
      }
      if (this.recipes.has('wooden_sword') && planksHeld && (this.inventory[planksHeld] || 0) >= 2 && (this.inventory.stick || 0) >= 1 &&
          this.world.findBlocks('crafting_table', this.position, 32, 1).length) {
        o.push({ key: 'craft_wooden_sword', description: 'Craft a wooden sword at the crafting table (2 planks + 1 stick)' });
      }
      if (this.recipes.has('stone_sword') && (this.inventory.cobblestone || 0) >= 2 && (this.inventory.stick || 0) >= 1 &&
          this.world.findBlocks('crafting_table', this.position, 32, 1).length) {
        o.push({ key: 'craft_stone_sword', description: 'Craft a stone sword at the crafting table (2 cobblestone + 1 stick)' });
      }
      if (this.recipes.has('torch') && ((this.inventory.coal || 0) + (this.inventory.charcoal || 0)) >= 1 && (this.inventory.stick || 0) >= 1) {
        o.push({ key: 'craft_torch', description: 'Craft torches from coal or charcoal and sticks' });
      }
      if (this.recipes.has('furnace') && (this.inventory.cobblestone || 0) >= 8 &&
          this.world.findBlocks('crafting_table', this.position, 32, 1).length) {
        o.push({ key: 'craft_furnace', description: 'Craft a furnace from 8 cobblestone (uses a crafting table)' });
      }
      if (this.recipes.has('shears') && (this.inventory.iron_ingot || 0) >= 2 &&
          this.world.findBlocks('crafting_table', this.position, 32, 1).length) {
        o.push({ key: 'craft_shears', description: 'Craft shears from 2 iron ingots (uses a crafting table)' });
      }
      // Secchio: 3 lingotti di ferro. Serve per mungere (e, più avanti, per i fluidi).
      if (this.recipes.has('bucket') && (this.inventory.iron_ingot || 0) >= BUCKET_INGREDIENTS.iron_ingot &&
          this.world.findBlocks('crafting_table', this.position, 32, 1).length) {
        o.push({ key: 'craft_bucket', description: `Craft a bucket from ${BUCKET_INGREDIENTS.iron_ingot} iron ingots (uses a crafting table)` });
      }
      // Scudo: 1 lingotto di ferro + 6 assi (legno qualsiasi).
      const planksForShield = Object.keys(this.inventory).filter(n => /_planks$/.test(n)).reduce((s, n) => s + this.inventory[n], 0);
      if (this.recipes.has('shield') && (this.inventory.iron_ingot || 0) >= SHIELD_INGREDIENTS.iron_ingot &&
          planksForShield >= SHIELD_INGREDIENTS.planks &&
          this.world.findBlocks('crafting_table', this.position, 32, 1).length) {
        o.push({ key: 'craft_shield', description: `Craft a shield from ${SHIELD_INGREDIENTS.iron_ingot} iron ingot and ${SHIELD_INGREDIENTS.planks} planks (uses a crafting table)` });
      }
      if (this.recipes.has('fishing_rod') && (this.inventory.stick || 0) >= FISHING_ROD_INGREDIENTS.stick &&
          (this.inventory.string || 0) >= FISHING_ROD_INGREDIENTS.string &&
          this.world.findBlocks('crafting_table', this.position, 32, 1).length) {
        o.push({ key: 'craft_fishing_rod', description: 'Craft a fishing rod from 3 sticks and 2 string (uses a crafting table)' });
      }
      // Letto: 3 lana (qualsiasi colore) + 3 assi. Per saltare la notte in viaggio.
      const woolTotal = Object.keys(this.inventory).filter(n => /_wool$/.test(n)).reduce((s, n) => s + this.inventory[n], 0);
      const plankTotal = Object.keys(this.inventory).filter(n => /_planks$/.test(n)).reduce((s, n) => s + this.inventory[n], 0);
      if (this.recipes.has('bed') && woolTotal >= 3 && plankTotal >= 3 &&
          this.world.findBlocks('crafting_table', this.position, 32, 1).length) {
        o.push({ key: 'craft_bed', description: 'Craft a bed (3 wool + 3 planks) to skip the night on a trip (uses a crafting table)' });
      }
      // Rame (The Copper Age: Bedrock 1.21.111+/Java 1.21.9): spada, utensili e
      // armatura. Il bronzo non esiste in vanilla (nessun item `bronze_*`,
      // nessuna ricetta): il materiale fra pietra e ferro è il rame, ed è quello
      // che si può davvero forgiare. Un'opzione si offre solo se serve: nessun
      // attrezzo dello stesso tipo, o solo di rango inferiore, e nessun pezzo di
      // armatura già addosso o in inventario.
      const copperRank = TOOL_HARVEST_RANK.copper;
      if (this.world.findBlocks('crafting_table', this.position, 32, 1).length) {
        for (const kind of ['pickaxe', 'sword', 'axe', 'hoe', 'shovel']) {
          const name = `copper_${kind}`;
          if (!this.recipes.has(name) || !this._craftable(name)) continue;
          const best = Object.entries(this.inventory)
            .filter(([item, count]) => Number(count) > 0 && item.endsWith(`_${kind}`))
            .reduce((top, [item]) => Math.max(top, TOOL_HARVEST_RANK[String(item).split('_')[0]] || 0), 0);
          if (best >= copperRank) continue;
          o.push({ key: `craft_${name}`, description: `Craft a copper ${kind} at the crafting table (same harvesting tier as stone)` });
        }
        for (const piece of ['helmet', 'chestplate', 'leggings', 'boots']) {
          const name = `copper_${piece}`;
          if (!this.recipes.has(name) || !this._craftable(name)) continue;
          if (this.armor?.[piece]) continue;
          if (Object.entries(this.inventory).some(([item, count]) => Number(count) > 0 && item.endsWith(`_${piece}`))) continue;
          o.push({ key: `craft_${name}`, description: `Craft a copper ${piece} at the crafting table (armor is worn, not just carried)` });
        }
      }
    }
    // Piazzamento: solo ciò che serve alla progressione.
    if ((this.inventory.crafting_table || 0) > 0 && !this.world.findBlocks('crafting_table', this.position, 8, 1).length) {
      o.push({ key: 'place_crafting_table', description: 'Place a crafting table next to the bot' });
    }
    const furnaceNear = this.world.findBlocks('furnace', this.position, 8, 1).length > 0;
    if ((this.inventory.furnace || 0) > 0 && !furnaceNear) {
      o.push({ key: 'place_furnace', description: 'Place a furnace next to the bot' });
    }
    if ((this.inventory.torch || 0) > 0) {
      o.push({ key: 'place_torch', description: 'Place a torch to light up the area (ward off mobs)' });
    }
    if ((this.inventory.bed || 0) > 0 && !this.world.findBlocks('bed', this.position, 8, 1).length) {
      o.push({ key: 'place_bed', description: 'Place a bed to sleep and set the respawn point' });
    }
    // Redstone (R1): i componenti in inventario si piazzano e lo stato (direzione,
    // potenza) si legge dal mondo dopo il piazzamento; un ripetitore a portata si
    // può ritardare. Il minerale non è un componente da piazzare.
    for (const [itemName, count] of Object.entries(this.inventory || {})) {
      if (!count) continue;
      const blockName = REDSTONE_ITEM_BLOCKS[itemName] ?? itemName;
      if (isRedstoneOre(blockName) || !isRedstoneComponent(blockName)) continue;
      o.push({ key: `place_${itemName}`, description: `Place ${blockName.replace(/_/g, ' ')} next to the bot and read its state back` });
    }
    {
      const repeater = this._pickRepeaterTarget();
      if (repeater) {
        const delay = repeaterDelay(this.world.blockAt(repeater));
        o.push({ key: 'set_repeater_delay', description: `Advance the repeater at ${JSON.stringify(repeater)} to the next delay${delay == null ? '' : ` (now ${delay})`}` });
      }
    }
    // Redstone (R2): azionare un input a portata e leggere l'effetto a valle.
    // `sense_redstone` è diagnostica, quindi si offre solo se c'è qualcosa da
    // leggere (un censimento vuoto non merita un turno).
    {
      const input = this._pickRedstoneInput();
      if (input) {
        o.push({ key: 'use_redstone', description: `Toggle the ${input.name.replace(/_/g, ' ')} at ${JSON.stringify(input.position)}${input.distance == null ? '' : ` (${input.distance} blocks away)`} and read the effect back` });
      }
      const census = this._redstoneCensus();
      if (census.ready && census.found > 0) {
        o.push({ key: 'sense_redstone', description: `Read the ${census.counts.components} redstone component(s) and ${census.power.length} signal(s) in range` });
      }
    }
    // Redstone (R3): un circuito si costruisce solo se il catalogo lo dichiara
    // costruibile, i materiali ci sono e il sito davanti al bot è libero. Le
    // altre opzioni non compaiono: meglio un'azione in meno che una che fallisce.
    o.push(...this._circuitOptions());
    // Fusione: stazione adatta (altoforno per i minerali, affumicatore per il
    // cibo, altrimenti fornace) + materiale + combustibile.
    {
      const fuel = this._pickFuel();
      for (const target of this._smeltTargets()) {
        if ((this.inventory[target.input] || 0) < 1 || !fuel) continue;
        const station = this._findSmeltingStation(this._smeltStationFor(target.input));
        if (!station) continue;
        o.push({ key: `smelt_${target.input}`, description: `Smelt 1 ${target.input} into ${target.output} in the nearby ${station.name.replace('_', ' ')} (uses 1 ${fuel.name})` });
      }
    }
    // Contenitori di stoccaggio: censimento, prelievo e deposito.
    const storageBlocks = this._findNearbyStorageBlocks();
    const cached = this._cachedContainers();
    // Un contenitore fuori dal componente calpestabile non è apribile: offrirlo
    // costa 30 s di pathfinding fallito per ogni blocco.
    const reachableStorage = this._reachabilityUsable()
      ? storageBlocks.filter(b => this.approachReachable(b.position))
      : storageBlocks;
    if (reachableStorage.length) {
      const freshKeys = new Set(cached.map(c => c.key));
      const stale = reachableStorage.filter(b => !freshKeys.has(this._containerCacheKey(b.position)));
      if (stale.length) {
        const names = [...new Set(reachableStorage.map(b => b.name))].join(', ');
        o.push({ key: 'read_container', description: `Open and inventory ${reachableStorage.length} nearby storage container(s) (${names})` });
      }
    }
    // Prelievo: solo item presenti in un contenitore noto e non scaduto. I posti
    // (8) si assegnano a rotazione fra i contenitori (ordine per posizione
    // dell'item dentro il contenitore), non riempiendo il primo: con il
    // riempimento per contenitore uno scrigno ricco (2216 patate) saturava la
    // lista e il pesce crudo dello scrigno piu lontano non veniva mai proposto,
    // quindi il planner non poteva chiederlo (round compagni, 03/10). Gli item
    // nominati in `plan.targets` passano comunque per primi.
    // Regola dei materiali (05/10): un obiettivo di *costruzione* guarda prima
    // l'inventario, poi i bauli noti, e solo alla fine raccoglie in natura. Gli
    // item che servono al craft passano per primi nella lista dei prelievi, cosi'
    // il tetto di 8 posti non li scarta.
    const craft = this._craftNeeds({ offerKeys: o.map(option => option.key) });
    this.resourceSites.pending = craft?.next?.source === 'remembered_resource_site' ? craft.next : null;
    this.resourceSites.gatherKey = craft?.next?.source === 'gather' ? craft.next.key : null;
    const wantedTargets = new Set(Object.entries(this.plan?.targets || {})
      .filter(([item, count]) => (this.inventory[item] || 0) < count).map(([item]) => item));
    const wantedItems = new Set(Object.keys(this.plan?.targets || {}));
    for (const need of craft?.needs ?? []) {
      for (const miss of need.missing) {
        for (const src of miss.sources) wantedItems.add(src.item);
        for (const item of this._craftableCandidatesFor(miss.ingredient)) wantedItems.add(item);
      }
    }
    const takeEntries = [];
    const seenContainers = new Set();
    for (const c of cached) {
      seenContainers.add(this._containerCacheKey(c.position));
      let index = 0;
      for (const [item, count] of Object.entries(c.contents)) {
        if (!count) continue;
        takeEntries.push({ c, item, count, index: index++ });
      }
    }
    // La cache runtime nasce da una lettura e scade; la memoria durevole invece
    // sopravvive ai riavvii (una ventina di bauli in questo mondo). Un contenitore
    // ricordato *raggiungibile* è un bersaglio legittimo: `_takeFromContainer` ci
    // cammina e lo apre. La descrizione lo dichiara, così l'esito non sorprende, e
    // la raggiungibilità gates l'offerta (mai un cammino che il pathfinding non regge).
    for (const c of this._rememberedStorage()) {
      const key = this._containerCacheKey(c.position);
      if (seenContainers.has(key)) continue;
      seenContainers.add(key);
      let index = 0;
      for (const [item, count] of Object.entries(c.contents)) {
        if (!count) continue;
        takeEntries.push({ c, item, count, index: index++, remembered: true });
      }
    }
    // Il kit da spedizione incompleto pesa come un bisogno di craft: senza questo
    // boost un tetto di 8 posti riempito dai primi item del baule più ricco non
    // offre mai `take_torch`/`take_coal`/cibo, e un obiettivo che chiede il kit
    // resta irraggiungibile *anche con il baule aperto* (live 08/10/2026: la lista
    // offrì take_diamond ×2, take_copper_ingot ×2, take_golden_leggings ×2 e mai
    // una torcia o un carbone).
    // Solo l'attrezzatura: il cibo lo offre in blocco qualunque contenitore del
    // villaggio e promuoverlo riempirebbe la lista da solo (`food` resta fuori).
    const kitMissingTags = this._tripKitView().missing.map(entry => entry.tag).filter(tag => tag !== 'food');
    const kitWanted = item => kitMissingTags.some(tag => itemMatchesTag(item, tag));
    takeEntries.sort((a, b) =>
      (Number(wantedTargets.has(b.item)) - Number(wantedTargets.has(a.item))) ||
      (Number(wantedItems.has(b.item) || kitWanted(b.item)) - Number(wantedItems.has(a.item) || kitWanted(a.item))) || (a.index - b.index));
    for (const e of takeEntries.slice(0, 8)) {
      const from = e.remembered
        ? `the ${e.c.type} at ${JSON.stringify(e.c.position)} (remembered: re-read on arrival)`
        : `the ${e.c.type} at ${JSON.stringify(e.c.position)} (container has ${e.count})`;
      o.push({ key: `take_${e.item}`, description: `Take ${e.count} ${e.item} from ${from}` });
    }
    // Il passo di approvvigionamento scelto dalla regola: se e' un prelievo da
    // baulo, la descrizione dell'opzione gia' offerta si arricchisce; se e' un
    // craft da inventario o una raccolta naturale, l'opzione nasce qui.
    if (craft?.next) {
      const step = craft.next;
      const note = step.reason === 'craft_target_ready'
        ? `Craft ${step.target} now: every material is already in the inventory`
        : step.source === 'chest'
        ? `Take ${step.short} ${step.item} from the ${step.chest.type} at ${JSON.stringify(step.chest.position)} to build ${step.target} (inventory first, then the chests; nothing is taken from buildings)`
        : step.source === 'inventory'
        ? `Craft ${step.item} from what the bot already holds to build ${step.target} (inventory first, then the chests)`
        : step.source === 'remembered_resource_site'
        ? `Go to remembered resource site ${step.site} and re-observe before gathering ${step.item}`
        : `Gather ${step.item} in the wild to build ${step.target} (natural blocks only: nothing is taken from buildings)`;
      const existing = o.find(option => option.key === step.key);
      if (existing) existing.description = `${existing.description} — ${note}`;
      else o.push({ key: step.key, description: note });
    }
    // Deposito: gli oggetti di valore verso lo scrigno noto (o vicino) più
    // prossimo, e — da M3c — una sola azione che scarica tutto il raccolto
    // (`dump_inventory`) nello scrigno giusto per quell'item.
    // Un ordine di fattoria chiede di mettere via *il raccolto*: la riserva di
    // cibo non lo trattiene (altrimenti il bot mieterebbe e il deposito non
    // sarebbe nemmeno offerto) e il deposito mirato vale anche per un raccolto
    // che non è "prezioso" (`_isValuable` guarda lingotti, minerali e gemme).
    const farmCrop = this.plan?.farm?.crop ?? null;
    const depositable = this._depositableItems();
    const depositTarget = cached.find(c => !this._reachabilityUsable() || this.approachReachable(c.position)) || reachableStorage[0];
    if (depositTarget && depositable.length) {
      const names = depositable.slice(0, 3).map(entry => entry.item).join(', ');
      o.push({
        key: 'dump_inventory',
        description: `Store the village work: ${depositable.length} item type(s) (${names}${depositable.length > 3 ? ', …' : ''}) into nearby storage, preferring a container that already holds the same item`,
      });
    }
    if (depositTarget) {
      let depositOffered = 0;
      const wanted = [...new Set([...(farmCrop ? [farmCrop] : []), ...Object.keys(this.inventory)])]
        .filter(item => item === farmCrop || this._isValuable(item));
      for (const item of wanted) {
        if (!(this.inventory[item] > 0)) continue;
        o.push({ key: `deposit_${item}`, description: `Deposit ${this.inventory[item]} ${item} into the ${depositTarget.type} at ${JSON.stringify(depositTarget.position)}` });
        if (++depositOffered >= 6) break;
      }
    }
    // Fattoria: piantare su farmland libero, nutrire e (se serve carne) cacciare
    // gli animali della base. Mai villager né domestici (isFarmAnimalType).
    {
      const freeFarmland = this._unplantedFarmland();
      for (const item of PLANTABLE_ITEMS) {
        if (!(this.inventory[item] > 0)) continue;
        if (!freeFarmland.length) break;
        const target = freeFarmland[0];
        const crop = cropForSeed(item);
        o.push({ key: `plant_${item}`, description: `Plant ${item} on the farmland at ${JSON.stringify(target.position)} (${target.distance} blocks away) to grow ${crop}` });
      }
      const farmAnimals = this._nearbyFarmAnimals(12);
      const offered = new Set();
      for (const animal of farmAnimals) {
        if (offered.has(animal.type)) continue;
        if (!this.entityApproachable(animal, { range: 3, dy: 2 })) continue;
        offered.add(animal.type);
        o.push({ key: `attack_${animal.type}`, description: `Hunt the ${animal.type} for food (${animal.distance.toFixed(1)} blocks away${animal.baby ? ', baby' : ''})` });
        const feed = animalFeed(animal.type);
        if (feed && (this.inventory[feed] || 0) > 0) {
          o.push({ key: `feed_${animal.type}`, description: `Feed the ${animal.type} ${feed} to make it breed (${animal.distance.toFixed(1)} blocks away)` });
        }
        // Mungitura: serve un secchio vuoto e una mucca (o mooshroom) a tiro.
        if ((this.inventory.bucket || 0) > 0 && isMilkableType(animal.type)) {
          o.push({ key: `milk_${animal.type}`, description: `Milk the ${animal.type} with a bucket (${animal.distance.toFixed(1)} blocks away)` });
        }
        if (offered.size >= 4) break;
      }
      // Stretch: uova, riproduzione, taming e tosatura.
      if ((this.inventory.egg || 0) > 0) {
        o.push({ key: 'throw_egg', description: 'Throw an egg (1/8 chance of a chick)' });
      }
      const allFarm = this._nearbyFarmAnimals(32);
      const breedable = new Set();
      for (const animal of allFarm) {
        if (animal.baby || animal.inlove || breedable.has(animal.type)) continue;
        const feed = animalFeed(animal.type);
        if (!feed || (this.inventory[feed] || 0) < 2) continue;
        const adults = allFarm.filter(e => e.type === animal.type && !e.baby && !e.inlove);
        if (adults.length >= 2) {
          breedable.add(animal.type);
          o.push({ key: `breed_${animal.type}`, description: `Breed two ${animal.type}s with ${feed} to get a baby (${adults.length} adults nearby)` });
        }
      }
      // Addomesticamento: cibo (wolf/cat/ocelot/parrot) o monta (cavalcabili).
      const selfId = String(this.client?.entityId ?? '');
      for (const companion of this._nearbyCompanion(12)) {
        if (this._isCompanionTamed(companion, selfId)) continue;
        if (!this.entityApproachable(companion, { range: 3, dy: 2 })) continue;
        if (isRideTameableType(companion.type)) {
          o.push({ key: `tame_${companion.type}`, description: `Tame the ${companion.type} by mounting it (${companion.distance.toFixed(1)} blocks away)` });
        } else {
          const feeds = tameFeed(companion.type);
          const feed = feeds.find(f => (this.inventory[f] || 0) > 0);
          if (!feed) continue;
          o.push({ key: `tame_${companion.type}`, description: `Tame the ${companion.type} with ${feed} (${companion.distance.toFixed(1)} blocks away)` });
        }
      }
      if ((this.inventory.shears || 0) > 0) {
        const sheep = allFarm.find(e => e.type === 'sheep' && !e.sheared && !e.baby && this.entityApproachable(e, { range: 3, dy: 2 }));
        if (sheep) o.push({ key: 'shear_sheep', description: `Shear the sheep at ${sheep.distance.toFixed(1)} blocks for wool` });
      }
    }
    // Cavalcare/veicoli: montare un mezzo vicino (barca, carrello, cavallo,
    // nautilus...) oppure smontare. Con un waypoint attivo goto_waypoint cavalca.
    if (this.riding) {
      o.push({ key: 'dismount', description: 'Dismount the current vehicle/mount' });
    } else {
      const rideable = this._nearbyRideable(12);
      const seen = new Set();
      for (const r of rideable) {
        if (seen.has(r.type)) continue;
        if (!this.entityApproachable(r, { range: 3, dy: 2 })) continue;
        seen.add(r.type);
        o.push({ key: `mount_${r.type}`, description: `Mount the ${r.type} (${r.distance.toFixed(1)} blocks away)` });
        if (seen.size >= 4) break;
      }
    }
    // Scudo: indossalo nell'offhand e alzalo quando un ostile è a tiro. Alzarlo
    // ha senso solo con il lato server che riduce il danno, quindi l'opzione
    // compare solo con uno scudo equipaggiato e un ostile raggiungibile.
    if (this._offhandItem() === 'shield') {
      if (this.shieldUp) {
        o.push({ key: 'lower_shield', description: 'Lower the shield' });
      } else {
        const threat = this._hostiles().find(e => this._entityDistance(e) <= SHIELD_THREAT_RANGE);
        if (threat) {
          o.push({ key: 'raise_shield', description: `Raise the shield against the ${threat.type} (${this._entityDistance(threat).toFixed(1)} blocks away)` });
        }
      }
    } else if ((this.inventory.shield || 0) > 0) {
      o.push({ key: 'equip_shield', description: 'Equip the shield in the offhand' });
    }
    // Pesca: canna in mano e acqua raggiungibile dalla riva.
    if ((this.inventory.fishing_rod || 0) > 0) {
      const spot = this._findFishingSpot();
      const bobber = this._findBobber();
      if (spot && !bobber) {
        o.push({ key: 'fish', description: `Fish at the shore ${spot.distance} blocks away (cast, wait for the bite, reel in)` });
        o.push({ key: 'cast_rod', description: `Cast the fishing rod into the water at ${JSON.stringify(spot.waterAt)} (${spot.distance} blocks away)` });
      }
      if (bobber) {
        o.push({ key: 'reel_in', description: 'Reel the fishing line in (bobber is out)' });
      }
    }
    o.push(...this._beeOptions());
    // Construction owns its procurement choices: unrelated takes, deposits,
    // mining and teardown must not consume materials or edit another build.
    if (this.plan?.construction) {
      const survival = new Set(['eat', 'flee', 'sleep', 'go_home', 'retreat', 'recover_loot', 'rearm_gear', 'equip_armor', 'equip_shield', 'raise_shield', 'lower_shield', 'avoid_lava', 'move_to_safe', 'dodge_projectile']);
      const kept = o.filter(option => survival.has(option.key) || option.key.startsWith('attack_') || option.key === 'collect_drop');
      kept.push(...this.construction.options());
      return kept.length ? kept : [{ key: 'wait', description: 'Construction paused or blocked; inspect construction.lastError and resume after resolving it' }];
    }
    // Fallback
    if (!o.length) o.push({ key: 'wait', description: 'Wait 2 seconds for fresh observations' });
    return o;
  }

  async executeAction (key, parameters = {}) {
    // A caller can bind a withdrawal to one known chest instead of letting an
    // item-only key choose another chest holding the same item.
    if (key?.startsWith('take_')) {
      if (parameters.position !== undefined && (!parameters.position ||
          !['x', 'y', 'z'].every(axis => Number.isSafeInteger(parameters.position[axis])))) {
        return { ok: false, error: 'invalid_container_position' };
      }
      if (parameters.maxCount !== undefined && (!Number.isInteger(parameters.maxCount) || parameters.maxCount < 1 || parameters.maxCount > 64)) {
        return { ok: false, error: 'invalid_take_count' };
      }
    }
    if (this.busy) return { ok: false, error: 'busy' };
    // 'wait' resta eseguibile durante una riconnessione; le altre azioni no.
    if (key !== 'wait' && (!this.client || !this.spawned || this.status !== 'spawned')) {
      return { ok: false, error: 'not_connected' };
    }
    if (this.dead && key !== 'wait') return { ok: false, error: 'dead' };
    if (this.sleeping && key !== 'wait') return { ok: false, error: 'sleeping' };
    this.busy = true;
    const started = Date.now();
    const actionController = new AbortController();
    const actionContext = { signal: actionController.signal, construction: key.startsWith('construction_'), take: parameters };
    let result;
    let watchdog = null;
    // Un'azione che non ritorna — la morte del bot a metà di una lettura di
    // contenitori lascia l'attesa appesa — terrebbe il lock `busy` per sempre e
    // renderebbe l'API inutilizzabile (finding live 03/10/2026). Il watchdog
    // risponde con un errore tipizzato e libera il lock: il pezzo di azione
    // rimasto in volo resta un zombie dichiarato, non un blocco dell'API.
    try {
      result = await Promise.race([
        this._actionScope.run(actionContext, () => this._runAction(key, actionContext)),
        new Promise(resolve => {
          watchdog = setTimeout(() => {
            actionController.abort();
            if (actionContext.construction) { this._finishMotion('timeout'); this._stopMotion(); }
            resolve({
            ok: false,
            error: 'action_timeout',
            action: key,
            timeoutMs: +(process.env.HARNESS_ACTION_TIMEOUT_MS || 180000),
            });
          }, +(process.env.HARNESS_ACTION_TIMEOUT_MS || 180000));
        }),
      ]);
      if (result?.error === 'action_timeout') this.log('action_timeout', { action: key, ms: Date.now() - started });
    } catch (error) {
      // Una rejection non gestita dentro il corpo non deve uscire dalla rotta:
      // diventa lo stesso errore tipizzato di un'eccezione catturata.
      result = { ok: false, error: error?.message ?? String(error) };
    } finally {
      if (watchdog) clearTimeout(watchdog);
      actionController.abort();
      this.busy = false;
    }
    const entry = { action: key, result, position: this.pos(), ms: Date.now() - started };
    this.recent.push(entry);
    if (this.recent.length > 8) this.recent.shift();
    this.log('action', entry);
    return result;
  }

  // Il corpo dell'azione, separato dal lock e dal watchdog: `result` è locale e
  // un'eccezione diventa un errore tipizzato.
  async _runAction (key, context = {}) {
    let result;
    try {
      if (key === this.resourceSites.gatherKey) {
        this._refreshNearby();
        if (!this.options({ localGatherOnly: true }).some(option => option.key === key)) {
          return { ok: false, error: 'gather_not_offered', action: key };
        }
      }
      if (key === 'construction_step' || key === 'construction_supply') {
        result = await this.construction.run(key === 'construction_supply' ? 'supply' : 'step', context);
      } else if (key === 'wait') {
        await new Promise(r => setTimeout(r, 2000));
        result = { ok: true };
      } else if (key === 'goto_waypoint' && this.resourceSites.pending) {
        result = await this.resourceSites.navigate(this.resourceSites.pending, context);
      } else if ((key === 'sneak_to' || key === 'walk_stealthy') && this.plan?.waypoint) {
        // W1: come `goto_waypoint` ma accovacciato. Il silenzio si verifica sul
        // movimento vero: se il server muove comunque a velocità di cammino lo
        // sneak non è stato accettato e il passo è rumoroso, quindi il risultato
        // è un rifiuto tipizzato e non un successo presunto.
        // W2: e la rotta stessa deve essere silenziosa (nessuna cella dentro la
        // sfera di un sensore, ritorno pianificato): se non lo è l'azione si
        // rifiuta invece di camminarci.
        const w = this.plan.waypoint;
        const target = { x: w.x, y: Number.isFinite(w.y) ? w.y : (this.position?.y ?? 70), z: w.z };
        if (this.riding) {
          result = { ok: false, error: 'riding', hint: 'dismount before sneaking' };
        } else {
          const moveResult = await this._moveTo(target, 2, 45000, { sneak: true, stealth: true, verticalTolerance: Number.isFinite(w.y) ? 1 : null });
          const measured = this._lastSneak;
          result = measured?.ok === false
            ? { ok: false, error: 'not_sneaking', measured, path: moveResult }
            : { ok: true, ...moveResult, sneak: measured };
        }
      } else if (key === 'goto_waypoint' && this.plan?.waypoint) {
        const w = this.plan.waypoint;
        const target = { x: w.x, y: Number.isFinite(w.y) ? w.y : (this.position?.y ?? 70), z: w.z };
        if (this.riding) {
          result = await this._rideToward(target, 3, 45000);
        } else {
          const moveResult = await this._moveTo(target, 2, 45000, { verticalTolerance: Number.isFinite(w.y) ? 1 : null });
          result = { ok: true, ...moveResult };
        }
      } else if (key === 'escort_to' && this.plan?.escort) {
        result = await this._escortTo();
      } else if (key === 'follow_player' && this.plan?.follow) {
        result = await this._followPlayer(this.plan.follow);
      } else if (key === 'seek_player' && this.plan?.follow) {
        result = await this._seekPlayer(this.plan.follow);
      } else if (key === 'collect_drop') {
        result = await this._collectDrop(20000, { names: this._plannedCollectNames() });
      } else if (key === 'drop_item') {
        result = await this._dropItems({ ...(this._plannedDrop() ?? {}), leaveDrop: true, recipient: this.plan?.drop?.recipient });
      } else if (key === 'dig_down') {
        result = await this._digDown();
      } else if (key === 'dig_up') {
        result = await this._digUp();
      } else if (key === 'mine_owned') {
        // R4: sta *prima* del prefisso `mine_<blocco>` — `mine_owned` non è un
        // blocco (stessa trappola di `place_water`/`mount_boat` in M5).
        result = await this._mineOwned();
      } else if (key.startsWith('mine_')) {
        const blockName = key.slice('mine_'.length);
        if (isBeeProtected(blockName)) return { ok: false, error: 'bee_block_protected', block: blockName };
        const found = this.world.findBlocks(blockName, this.position, 96, 8);
        // Le colture acerbe non si toccano nemmeno se il nome dell'azione le
        // chiede: lo stesso filtro delle opzioni, applicato al bersaglio vero.
        const { ready } = isCropBlock(blockName) ? this._harvestableCrops(found) : { ready: found };
        const target = this._pickMineTarget(ready);
        if (!target) {
          const noisy = this._vibrationBlockedTarget(ready);
          if (noisy) throw new Error(`vibration_risk_mine: ${blockName} at ${noisy.position.x},${noisy.position.y},${noisy.position.z} (${noisy.sensors} sculk sensor(s) in range)`);
          throw new Error(isCropBlock(blockName) && found.length
            ? `crop_not_mature: ${blockName}`
            : `no reachable ${blockName} found nearby`);
        }
        result = await this._mineBlock(target);
      } else if (key === 'harvest_honeycomb' || key === 'harvest_honey') {
        result = await this._harvestHoney(key === 'harvest_honeycomb' ? 'honeycomb' : 'honey_bottle');
      } else if (key === 'feed_bee') {
        result = await this._feedBee();
      } else if (key === 'breed_bee') {
        result = await this._breedBees();
      } else if (key.startsWith('harvest_')) {
        result = await this._harvestCrop(key.slice('harvest_'.length));
      // Questi rami stanno *prima* del prefisso `craft_<item>`: le loro chiavi lo
      // attraversano, e `_craftItem` chiede al server una ricetta con un nome che
      // non esiste — la barca è per *tipo* (`oak_boat`, `bamboo_raft`), non il
      // `boat` legacy, e la polvere di blaze e l'occhio di ender hanno un passo
      // loro. Live 08/10/2026 (curriculum `water_travel`): `/options` offriva
      // `craft_boat` e ogni tentativo rispondeva `craft_recipe_missing` prima di
      // arrivare a `_craftBoat` (stessa trappola di `mine_owned` e `place_water`).
      } else if (key === 'craft_boat') {
        result = await this._craftBoat();
      } else if (key === 'craft_blaze_powder') {
        result = await this._craftPowderFromRods();
      } else if (key === 'craft_ender_eye') {
        result = await this._craftEyesOfEnder();
      } else if (key.startsWith('craft_')) {
        result = await this._craftItem(key.slice('craft_'.length));
      } else if (key.startsWith('smelt_')) {
        result = await this._smeltItem(key.slice('smelt_'.length));
      } else if (key.startsWith('plant_')) {
        result = await this._plantSeed(key.slice('plant_'.length));
      } else if (key.startsWith('feed_')) {
        result = await this._feedAnimal(key.slice('feed_'.length));
      } else if (key.startsWith('milk_')) {
        result = await this._milkAnimal(key.slice('milk_'.length));
      } else if (key === 'throw_egg') {
        result = await this._throwEgg();
      } else if (key.startsWith('breed_')) {
        result = await this._breedAnimals(key.slice('breed_'.length));
      } else if (key.startsWith('tame_')) {
        result = await this._tameAnimal(key.slice('tame_'.length));
      // M5: questi rami stanno *prima* dei prefissi generici (`mount_<tipo>`,
      // `place_<blocco>`, `fill_*`), altrimenti `place_water` verrebbe scambiato
      // per il piazzamento del blocco `water` e `mount_boat` per la cavalcatura
      // di un'entità `boat` — difetto visto live il 03/10/2026.
      } else if (key === 'fill_bucket') {
        result = await this._fillBucket();
      } else if (key === 'place_water' || key === 'empty_bucket') {
        result = await this._emptyBucket({ item: WATER_BUCKET_ITEM });
      } else if (key === 'place_lava') {
        result = await this._emptyBucket({ item: LAVA_BUCKET_ITEM });
      } else if (key === 'fill_bottle') {
        result = await this._fillBottle();
      } else if (key === 'join_human_mount') {
        // Prima di `mount_boat`/`mount_<tipo>` e di ogni fallback di locomozione
        // (stessa trappola di M5): il bersaglio è il mezzo dell'umano, non "il
        // più vicino del tipo".
        result = await this._joinHumanMount();
      } else if (key === 'mount_boat') {
        result = await this._mountBoat();
      } else if (key.startsWith('brew_')) {
        result = await this._brew(key.slice('brew_'.length));
      } else if (key.startsWith('mount_')) {
        result = await this._mountVehicle(key.slice('mount_'.length));
      } else if (key === 'dismount') {
        result = await this._dismount();
      } else if (key === 'shear_sheep') {
        result = await this._shearSheep();
      } else if (key === 'equip_shield') {
        result = await this._equipShield();
      } else if (key === 'raise_shield') {
        result = await this._raiseShield();
      } else if (key === 'lower_shield') {
        result = await this._lowerShield();
      } else if (key === 'read_container') {
        result = await this._readContainers();
      } else if (key.startsWith('take_')) {
        result = await this._takeFromContainer(key.slice('take_'.length), context.take);
      } else if (key === 'dump_inventory') {
        result = await this._dumpInventory();
      } else if (key.startsWith('deposit_')) {
        result = await this._depositItem(key.slice('deposit_'.length));
      } else if (key.startsWith('place_')) {
        const itemName = key.slice('place_'.length);
        // R1: di un componente redstone fa parte dell'esito anche lo stato
        // (direzione/potenza), quindi si legge dal mondo dopo il piazzamento.
        const blockName = REDSTONE_ITEM_BLOCKS[itemName] ?? itemName;
        result = isRedstoneComponent(blockName)
          ? await this._placeOriented(itemName, blockName)
          : await this._placeBlock(itemName, itemName);
      } else if (key === 'set_repeater_delay' || key.startsWith('set_repeater_delay_')) {
        const suffix = key.slice('set_repeater_delay'.length).replace(/^_/, '');
        const wanted = suffix === '' ? null : Number(suffix);
        result = wanted === null || (Number.isFinite(wanted) && wanted >= 0 && wanted <= 3)
          ? await this._setRepeaterDelay(wanted)
          : { ok: false, error: 'bad_delay', key, wanted };
      } else if (key === 'use_redstone') {
        result = await this._useRedstone();
      } else if (key === 'sense_redstone') {
        // Diagnostica pura: legge e riporta, non può fallire se il mondo è noto.
        const view = this._redstoneView({ force: true });
        result = view.ready
          ? { ok: true, power: view.power, maxPower: view.maxPower, active: view.active, activeOutputs: view.activeOutputs, counts: view.counts, found: view.found, lastChange: view.lastChange }
          : { ok: false, error: 'redstone_unknown' };
      } else if (key === 'open_trade') {
        result = await this._openTrade();
      } else if (key === 'close_trade') {
        await this._closeContainer();
        result = { ok: true, closed: true };
      } else if (key.startsWith('trade_')) {
        const index = Number(key.slice('trade_'.length));
        result = await this._tradeAt(index);
      } else if (key === 'level_trader') {
        result = await this._levelTrader({});
      } else if (key.startsWith('level_')) {
        result = await this._levelTrader({ profession: key.slice('level_'.length) });
      } else if (key === 'eat') {
        result = await this._eat();
      } else if (key === 'flee') {
        result = await this._flee();
      } else if (key === 'dodge_projectile') {
        result = await this._dodgeProjectile({});
      } else if (key === 'hunt_blaze') {
        result = await this._huntBlaze({});
      } else if (key === 'avoid_enderman_gaze') {
        result = await this._avoidGaze({});
      } else if (key === 'equip_pumpkin') {
        result = await this._equipPumpkin();
      } else if (key === 'throw_eye_of_ender') {
        result = await this._throwEyeOfEnder({});
      } else if (key === 'find_stronghold') {
        result = await this._findStronghold({});
      } else if (key === 'fill_end_portal') {
        result = await this._fillEndPortal({});
      } else if (key === 'enter_end_portal') {
        result = await this._enterPortal({ kind: 'end' });
      } else if (key === 'avoid_lava') {
        result = await this._avoidLava();
      } else if (key === 'move_to_safe') {
        result = await this._moveToSafe();
      } else if (key === 'surface') {
        result = await this._surfaceFromWater();
      } else if (key === 'cross_lava') {
        result = await this._crossLava();
      } else if (key === 'descend_waterfall' || key === 'climb_waterfall') {
        result = await this._useColumn(key === 'climb_waterfall' ? 'climb' : 'descend');
      } else if (key === 'use_bubble_column') {
        result = await this._useColumn('bubble');
      } else if (key === 'goto_portal') {
        result = await this._gotoPortal({});
      } else if (key === 'enter_portal') {
        result = await this._enterPortal({});
      } else if (key === 'build_portal') {
        result = await this._buildPortal({});
      } else if (key === 'light_portal') {
        result = await this._lightPortal({});
      } else if (key === 'go_home' || key === 'retreat') {
        result = await this._goHome();
      } else if (key === 'rearm_gear') {
        result = await this._rearmGear();
      } else if (key === 'equip_armor') {
        result = await this._equipArmor();
      } else if (key === 'close_door') {
        result = await this._closeDoor();
      } else if (key === 'barricade') {
        result = await this._barricade();
      } else if (key === 'travel_kit') {
        result = await this._travelKit();
      } else if (key === 'pillar_up') {
        result = await this._pillarUp({});
      } else if (key === 'build_hut') {
        result = await this._buildHut({});
      } else if (key === 'build_nether_hub') {
        result = await this._netherHub({});
      } else if (key === 'barter_piglin') {
        result = await this._barterPiglin({});
      } else if (key === 'sleep') {
        result = await this._sleepInBed();
      } else if (key === 'recover_loot') {
        result = await this._recoverLoot();
      } else if (key.startsWith('attack_')) {
        result = await this._combat(key.slice('attack_'.length));
      } else if (key.startsWith('build_circuit_')) {
        result = await this._buildCircuit(key.slice('build_circuit_'.length));
      } else if (key === 'teardown_circuit' || key.startsWith('teardown_circuit_')) {
        const id = key === 'teardown_circuit' ? null : key.slice('teardown_circuit_'.length);
        result = await this._teardownCircuit(id);
      } else if (key === 'survey_village') {
        result = await this._surveyVillage({ signal: context.signal });
      } else if (key === 'cast_rod') {
        result = await this._castRod();
      } else if (key === 'reel_in') {
        result = await this._reelIn();
      } else if (key === 'fish') {
        result = await this._fish();
      } else if (key === 'ride') {
        // `ride` non è una chiave a sé: da montati si guida con `goto_waypoint`
        // (che passa a `_rideToward`). Un errore tipizzato lo dice, invece di
        // far sembrare l'azione inesistente.
        result = { ok: false, error: this.riding ? 'no_ride_destination' : 'not_riding', hint: 'while mounted, steer with goto_waypoint' };
      } else if (key === 'escort_to') {
        result = { ok: false, error: 'no_escort_target', hint: 'escort_to needs plan.escort.from (the human being guided) and a destination (plan.escort.to or plan.waypoint)' };
      } else if (key === 'follow_player') {
        result = { ok: false, error: 'no_player_target', hint: 'follow_player is offered only when a nearby player has been named' };
      } else if (key === 'seek_player') {
        result = { ok: false, error: 'no_player_target', hint: 'seek_player is offered only while a lost player has a recent last-known position' };
      } else if (key === 'surface') {
        result = { ok: false, error: 'not_underwater', hint: 'surface is offered only with the head under water and the air running out' };
      } else {
        result = { ok: false, error: 'unknown_action', reason: `unknown or invalid action ${key}` };
      }
    } catch (e) {
      // `details` (calcolato da `_moveTo`: `from`, `position`, `pathNodes`,
      // `reachedWaypoints`, `progressed`) viaggia con il risultato: un `/act`
      // rifiutato dice *dove* si è fermato, non solo come si chiama l'errore.
      result = { ok: false, error: e.message, ...(e.details ? { details: e.details } : {}) };
    }
    return result;
  }

  setPlan (plan) {
    if (plan?.construction) {
      const configured = this.construction.configure(plan.construction);
      if (configured.ok === false) throw new Error(`${configured.error}: ${JSON.stringify(configured.issues ?? [])}`);
      plan = { ...plan, construction: { ...configured } };
    } else if (this.plan?.construction && this.construction.project && !['complete', 'cancelled'].includes(this.construction.project.state)) {
      this.construction.control('pause');
    }
    this.plan = plan;
    this.resourceSites.pending = null;
    this.resourceSites.gatherKey = null;
    this.log('plan', { plan });
  }

  // ---- raccolta drop -----------------------------------------------------------------

  _dropDistance (drop) {
    if (!this.position) return Infinity;
    return Math.hypot(drop.position.x - this.position.x, drop.position.y - this.position.y, drop.position.z - this.position.z);
  }

  // M4 — Un drop che giace in lava è già distrutto: non si insegue (e `recover_loot`
  // non deve tornare a cercarlo per venti secondi).
  _dropInLava (position) {
    if (!position) return false;
    if (!this._lavaCells) this._fluidCensus();
    if (!this._lavaCells?.size) return false;
    return this._lavaCells.has(`${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`);
  }

  _nearestDrop ({ reachableOnly = false, names = null } = {}) {
    const filterReach = reachableOnly && this._reachabilityUsable();
    // `names` restringe la ricerca agli item di un ordine umano "cattura
    // <oggetto>" (un array vuoto significa "nessun drop di quell'oggetto adesso").
    const wanted = names ? new Set(names) : null;
    return this.drops
      .filter(drop => !drop.failedAt || Date.now() - drop.failedAt > 10000)
      .filter(drop => !this._dropInLava(drop.position))
      .filter(drop => !wanted || wanted.has(drop.item))
      .filter(drop => !filterReach || this.dropReachable(drop.position))
      .map(drop => ({ ...drop, distance: this._dropDistance(drop) }))
      .sort((a, b) => a.distance - b.distance)[0] || null;
  }

  // Drop più vicino a un punto (usato dal recupero del loot al sito di morte).
  _nearestDropNear (position, radius) {
    return this.drops
      .filter(drop => !drop.failedAt || Date.now() - drop.failedAt > 30000)
      .filter(drop => Math.hypot(drop.position.x - position.x, drop.position.y - position.y, drop.position.z - position.z) <= radius)
      .map(drop => ({ ...drop, distance: this._dropDistance(drop) }))
      .sort((a, b) => a.distance - b.distance)[0] || null;
  }

  // Torna al punto di morte, raccoglie i drop e (camminandoci sopra) gli orb EXP.
  async _recoverLoot ({ moveTimeoutMs = 60000, collectRounds = 8 } = {}) {
    if (this.dead) return { ok: false, error: 'dead' };
    const site = this.deathSite;
    if (!site) return { ok: false, error: 'no_death_site' };
    // M4: se il sito è nella lava (o a un blocco dal bordo) il loot non esiste
    // più. Tornarci significa solo rischiare una seconda morte.
    const death = this._deathVerdict() ?? deathVerdict({ position: site.position, lava: [] });
    site.lava = { inLava: death.inLava, nearest: death.nearest, recoverable: death.recoverable, reason: death.reason };
    if (death.recoverable === false) {
      this.log('recover_loot_skipped', { site: site.position, reason: death.reason, nearest: death.nearest });
      return { ok: false, error: 'drops_lost_in_lava', reason: death.reason, site: site.position, nearest: death.nearest };
    }
    const target = { x: site.position.x, y: site.position.y, z: site.position.z };
    const levelBefore = this.experienceLevel;
    const nearSite = () => this._feet &&
      Math.hypot(this._feet.x - target.x, this._feet.z - target.z) <= 1.6 &&
      Math.abs(this._feet.y - target.y) <= 3.5;
    let moved = false;
    try {
      if (!nearSite()) {
        await this._moveTo(target, 1.2, moveTimeoutMs);
        moved = true;
      }
    } catch (error) {
      site.attempts = (site.attempts || 0) + 1;
      return { ok: false, error: `recovery_move_failed: ${error.message}`, site: target, attempts: site.attempts };
    }
    const recovered = [];
    // Dopo l'avvicinamento gli item entity possono arrivare con qualche tick di
    // ritardo (il server li trasmette quando entrano nel raggio): attendi prima
    // di concludere che non c'è più nulla.
    let pending = this._nearestDropNear(site.position, 12);
    for (let i = 0; i < 12 && !pending; i++) {
      await delay(250);
      pending = this._nearestDropNear(site.position, 12);
    }
    for (let round = 0; round < collectRounds; round++) {
      const drop = this._nearestDropNear(site.position, 12);
      if (!drop) break;
      let result;
      try { result = await this._collectDrop(15000); } catch (error) { result = { ok: false, error: error.message }; }
      if (result?.ok && result.item) recovered.push(result.item);
      if (!result?.ok) break;
      await delay(150);
    }
    // Un momento sul posto: gli orb EXP volano al giocatore da soli.
    await delay(1200);
    const left = this._nearestDropNear(site.position, 12);
    if (!left) this.deathSite = null;
    // Loot recuperato e **non rimesso addosso**: chi torna dal sito di morte si
    // ritrova in zaino l'armatura e lo scudo che aveva, ma niente indosso — cioè
    // nudo davanti ai mob che l'hanno appena ucciso. Il riarmo è parte del
    // recupero, non un secondo ordine da dare al bot.
    const rearm = await this._rearmGear();
    this.log('recover_loot', { site: target, moved, recovered, left: !!left, rearm });
    const expGained = this.experienceLevel != null && levelBefore != null
      ? Math.max(0, this.experienceLevel - levelBefore) : null;
    return { ok: true, site: target, moved, recovered, leftNearby: !!left, rearm, expLevel: this.experienceLevel ?? null, expGained };
  }

  // Addosso quello che il loot ha restituito: i pezzi d'armatura e lo scudo che
  // dopo una morte restano nello zaino. Lo scudo vive **solo** nell'offhand (la
  // mano sinistra, container 34): se è in zaino va spostato, mai lasciato lì.
  // Best effort: se un pezzo non entra, il recupero del loot resta comunque
  // riuscito e il fallimento finisce in `failures` (log `recover_loot_rearm`).
  async _rearmGear () {
    const rearm = { armor: [], shield: null, failures: [] };
    // Chiamato da `_recoverLoot` dopo il recupero: se nel frattempo il bot è
    // morto di nuovo non c'è niente da rimettere addosso (e nessun fallimento).
    if (this.dead) return { ok: true, skipped: 'dead', ...rearm };
    try {
      const armor = await this._equipArmor();
      if (armor?.ok) rearm.armor = armor.equipped ?? [];
      else if (armor?.error !== 'no_armor_in_inventory') rearm.failures.push({ stage: 'armor', error: armor?.error ?? 'armor_equip_failed', carried: armor?.carried ?? null });
    } catch (error) {
      rearm.failures.push({ stage: 'armor', error: error.message });
    }
    if ((this.inventory?.shield || 0) > 0 || this._offhandItem() === 'shield') {
      try {
        const shield = await this._equipShield();
        if (shield?.ok) rearm.shield = 'offhand';
        else rearm.failures.push({ stage: 'shield', error: shield?.error ?? 'shield_equip_failed' });
      } catch (error) {
        rearm.failures.push({ stage: 'shield', error: error.message });
      }
    }
    if (rearm.armor.length || rearm.shield || rearm.failures.length) this.log('recover_loot_rearm', rearm);
    // `ok:false` solo quando c'era qualcosa da indossare e **niente** è entrato:
    // un riarmo parziale è riuscito, e non avere nulla da indossare non è un
    // fallimento (`rearm_gear` resta un'azione lecita da chiamare).
    const worn = rearm.armor.length > 0 || Boolean(rearm.shield);
    return worn || !rearm.failures.length ? { ok: true, ...rearm } : { ok: false, error: 'rearm_failed', ...rearm };
  }

  // C'è qualcosa da rimettere addosso? Qui contano gli **slot**, non l'aggregato:
  // `equip_armor` è già offerto dall'aggregato (`Object.keys(this.inventory)`),
  // `rearm_gear` serve per il pezzo che uno slot mostra e che gli slot armor non
  // hanno (o per lo scudo ancora in zaino).
  _needsRearm () {
    const worn = new Set(this._wornArmor());
    const unworn = this._armorPiecesInSlots().some(piece => !worn.has(piece.name));
    const shieldInPack = (this.inventory?.shield || 0) > 0 && this._offhandItem() !== 'shield';
    return unworn || shieldInPack;
  }

  _dropStillThere (drop) {
    return this.drops.some(d => String(d.id) === String(drop.id) || (drop.runtime_id != null && String(d.runtime_id) === String(drop.runtime_id)));
  }

  // Auto-raccolta dei drop vicini, usata subito dopo mining/scavi: il drop cade
  // entro il raggio d'azione ma il pickup richiede di camminarci sopra.
  async _pickupNearby ({ maxDistance = 3.5, limit = 2, budgetMs = 6000 } = {}) {
    const deadline = Date.now() + Math.max(1500, budgetMs);
    const filterReach = this._reachabilityUsable();
    const picked = [];
    // I drop vicini, dal più vicino: riletti a ogni giro perché il pickup li
    // rimuove dalla lista quando il server conferma la raccolta.
    const candidates = () => this.drops
      .map(entry => ({ ...entry, distance: this._dropDistance(entry) }))
      .filter(entry => entry.distance <= maxDistance && (!entry.failedAt || Date.now() - entry.failedAt > 10000))
      .sort((a, b) => a.distance - b.distance);
    for (let i = 0; i < limit && Date.now() < deadline; i++) {
      const near = candidates();
      if (!near.length) break;
      const drop = near.find(entry => !filterReach || this.dropReachable(entry.position));
      if (!drop) {
        // Solo drop in tasche irraggiungibili (sotto il pavimento, dietro un muro):
        // non spendere budget di movimento, marchiali e dì perché non si raccoglie.
        for (const entry of near) {
          const tracked = this.drops.find(d => String(d.id) === String(entry.id));
          if (tracked) tracked.failedAt = Date.now();
        }
        this.log('pickup_skipped', { item: near[0].item, count: near[0].count || 1, reason: 'unreachable', skipped: near.length });
        break;
      }
      try {
        await this._moveTo(drop.position, 0.6, Math.min(3000, Math.max(800, deadline - Date.now())));
      } catch (error) {
        this.log('pickup_move_failed', { item: drop.item, error: error.message });
        const entry = this.drops.find(d => String(d.id) === String(drop.id));
        if (entry) entry.failedAt = Date.now();
        continue;
      }
      // Il pickup può avvenire un tick dopo l'avvicinamento.
      const waitUntil = Math.min(Date.now() + 1200, deadline);
      while (Date.now() < waitUntil && this._dropStillThere(drop)) await delay(100);
      if (!this._dropStillThere(drop)) {
        picked.push({ item: drop.item, count: drop.count || 1 });
        this.log('pickup', { item: drop.item, count: drop.count || 1 });
      } else {
        const entry = this.drops.find(d => String(d.id) === String(drop.id));
        if (entry) entry.failedAt = Date.now();
      }
    }
    return picked;
  }

  // Gli oggetti nominati da un ordine umano "cattura <oggetto>": si filtra per
  // token (non per l'elenco congelato al momento del piano), cosi' un drop
  // arrivato a terra dopo il piano viene comunque raccolto. `null` = nessun
  // ordine di raccolta, quindi nessun filtro sui drop.
  _plannedCollectNames () {
    const spec = this.plan?.collect;
    if (!spec) return null;
    if (spec.token) return this.drops.filter(drop => matchesItemToken(drop.item, spec.token)).map(drop => drop.item);
    return Array.isArray(spec.items) && spec.items.length ? spec.items : [];
  }

  // L'oggetto di un ordine umano "getta <oggetto>": le voci sono gia' risolte
  // dal controller (`plan.drop.items`), qui si controlla solo che siano ancora
  // in inventario. `null` = non c'e' niente da buttare, e l'opzione `drop_item`
  // non viene nemmeno offerta (il controller lo legge come "non ce l'ho").
  _plannedDrop () {
    const spec = this.plan?.drop;
    if (!spec) return null;
    const listed = Array.isArray(spec.items) ? spec.items : [];
    const names = listed.filter(name => (this.inventory[name] || 0) > 0);
    if (!names.length) return null;
    return {
      names,
      count: Number.isFinite(spec.count) && spec.count > 0 ? Math.floor(spec.count) : null,
      token: spec.token ?? null,
    };
  }

  // Ordine umano "getta <oggetto>" (M9): l'azione `drop` dell'item_stack_request
  // sposta una pila dall'inventario al mondo, senza passare dal cursore (a
  // differenza di `take`+`place`). Serve una finestra inventario aperta, come
  // per ogni stack request. `count` null = tutto quello che c'e' dell'oggetto.
  _dropEscapeSpot (yaw) {
    if (!this._feet) return null;
    const start = this._startNode();
    const angle = yaw * Math.PI / 180;
    const forward = { x: -Math.sin(angle), z: Math.cos(angle) };
    const candidates = [];
    for (const [dx,dz] of [[3,0],[-3,0],[0,3],[0,-3],[2,2],[2,-2],[-2,2],[-2,-2]]) {
      const spot = {x:start.x+dx+0.5,y:start.y,z:start.z+dz+0.5};
      if (!this._bedStandSpotFree(spot)) continue;
      const distance = Math.hypot(spot.x-this._feet.x,spot.z-this._feet.z);
      if (distance < 2.5) continue;
      const goal = {x:Math.floor(spot.x),y:spot.y,z:Math.floor(spot.z)};
      const path = this._findPath(start,goal,{maxNodes:128});
      const end = path?.at(-1);
      if (!end || end.x!==goal.x || end.y!==goal.y || end.z!==goal.z || path.length>7) continue;
      if (path.some(node=>node.y!==start.y || !this._bedStandSpotFree(node))) continue;
      candidates.push({spot,score:(dx*forward.x+dz*forward.z)+path.length*0.1});
    }
    candidates.sort((a,b)=>a.score-b.score);
    return candidates[0]?.spot ?? null;
  }

  async _dropItems ({ names = [], count = null, leaveDrop = false, recipient = null } = {}) {
    const wanted = (Array.isArray(names) ? names : []).filter(name => (this.inventory[name] || 0) > 0);
    if (!wanted.length) return { ok: false, error: 'nothing_to_drop', inventory: this.inventory };
    const beforeInventory = {...this.inventory};
    const human = recipient ? [...this.entities.values()].find(entity=>entity.kind==='player' && entity.username?.toLowerCase()===recipient.toLowerCase()) : null;
    const yaw = human?.position ? this._yawTo(this.position,human.position) : this._lastYaw ?? 0;
    const escape = leaveDrop ? this._dropEscapeSpot(yaw) : null;
    if (leaveDrop && !escape) return {ok:false,error:'drop_clearance_unavailable',inventory:this.inventory};
    let remaining = Number.isFinite(count) && count > 0 ? Math.floor(count) : null;
    const dropped = [];
    try {
      await this._ensureInventoryOpen();
      if (leaveDrop) {
        // Bed use leaves the camera pointing down. Toss horizontally, then
        // leave the pickup radius using a short, fully observed level path.
        this._lastYaw=yaw;
        this._lastPitch=0;
        await this._queueAuthInput({yaw,pitch:0});
      }
      for (const name of wanted) {
        while (remaining == null || remaining > 0) {
          // Lo slot si rilegge a ogni giro: `_applyStackResponse` aggiorna il
          // mirror e una pila puo' esaurirsi o cambiare indice.
          const index = this.inventorySlots.findIndex(slot => this._slotItemName(slot) === name && (slot.count || 0) > 0);
          if (index < 0) break;
          const slot = this.inventorySlots[index];
          const before = slot.count || 0;
          const chunk = Math.min(before, remaining ?? Infinity, 255);
          const info = this._invSlotAsSource(index);
          let response;
          try {
            response = await this._sendStackRequest([{
              type_id: 'drop', legacy_type_id: 3, count: chunk,
              source: this._slotInfo(info.container, info.slot, slot.stack_id || 0),
              randomly: false,
            }]);
          } catch (error) {
            response = { status: error.message };
          }
          if (String(response.status) !== 'ok' && response.status !== 0) {
            this.log('drop_item_failed', { item: name, slot: index, count: chunk, status: response.status });
            if (!dropped.length) return { ok: false, error: `drop_failed_${response.status}`, item: name, inventory: this.inventory };
            return { ok: true, dropped, count: dropped.reduce((sum, entry) => sum + entry.count, 0), partial: true, inventory: this.inventory };
          }
          this._applyStackResponse(response, { networkId: slot.network_id });
          const after = this.inventorySlots[index]?.count || 0;
          if (after >= before) {
            // Il server ha risposto ok ma il mirror non si e' mosso: fermarsi
            // invece di insistere sullo stesso slot per sempre.
            this.log('drop_item_no_progress', { item: name, slot: index, count: chunk });
            if (!dropped.length) return { ok: false, error: 'drop_no_progress', item: name, inventory: this.inventory };
            return { ok: true, dropped, count: dropped.reduce((sum, entry) => sum + entry.count, 0), partial: true, inventory: this.inventory };
          }
          dropped.push({ item: name, count: chunk });
          if (remaining != null) remaining -= chunk;
        }
      }
    } finally {
      if (escape && dropped.length) {
        try { await this._moveTo(escape,0.15,4000,{preciseArrival:true,arrivalVerticalTolerance:0.15}); }
        catch (error) { this.log('drop_clearance_failed',{message:error.message}); }
        await delay(300);
      }
      this._refreshInventory();
    }
    if (!dropped.length) return { ok: false, error: 'nothing_to_drop', inventory: this.inventory };
    const total = dropped.reduce((sum, entry) => sum + entry.count, 0);
    const lost = wanted.reduce((sum,name)=>sum+Math.max(0,(beforeInventory[name]||0)-(this.inventory[name]||0)),0);
    if (leaveDrop && lost < total) return {ok:false,error:'drop_recollected',dropped,count:total,inventory:this.inventory};
    this.log('drop_item', { items: dropped, count: total });
    return { ok: true, dropped, count: total, inventory: this.inventory };
  }

  async _collectDrop (timeoutMs = 20000, { names = null } = {}) {
    // Guardia di respiro (M2): recuperare un drop sott'acqua costa una discesa.
    const breath = this._underwaterWorkAllowed();
    if (!breath.allowed) {
      return { ok: false, error: breath.reason, depth: breath.depth ?? null, air: Number.isFinite(this.air) ? this.air : null };
    }
    const tracked = this._nearestDrop({ names });
    if (tracked && this._reachabilityUsable() && !this.dropReachable(tracked.position)) {
      // Drop in una tasca irraggiungibile (sotto il pavimento, dietro un muro):
      // fallisci subito e marchia il drop, invece di bruciare il budget di move.
      const entry = this.drops.find(d => String(d.id) === String(tracked.id));
      if (entry) entry.failedAt = Date.now();
      this.log('collect_unreachable', { item: tracked.item, position: tracked.position });
      return { ok: false, error: 'drop_unreachable', item: tracked.item, position: tracked.position, inventory: this.inventory };
    }
    const deadline = Date.now() + Math.max(4000, timeoutMs);
    const inventoryBefore = { ...this.inventory };
    let moved = false;
    while (Date.now() < deadline) {
      const drop = this._nearestDrop({ names });
      if (!drop) {
        if (!moved) return { ok: false, error: 'no_drop_nearby' };
        return { ok: true, picked: 1, inventory: this.inventory };
      }
      try {
        await this._moveTo(drop.position, 0.6, Math.max(2500, deadline - Date.now()));
      } catch (error) {
        this.log('collect_move_failed', { item: drop.item, position: drop.position, error: error.message });
        if (!/movement timeout|target_not_found|path_failed|stuck/.test(error.message)) throw error;
      }
      moved = true;
      // Il pickup può avvenire un tick dopo l'avvicinamento: attendi la sparizione.
      const waitUntil = Math.min(Date.now() + 1500, deadline);
      while (Date.now() < waitUntil && this._dropStillThere(drop)) {
        await delay(100);
      }
      if (!this._dropStillThere(drop)) {
        return { ok: true, picked: drop.count || 1, item: drop.item, inventory: this.inventory };
      }
    }
    const gained = Object.entries(this.inventory).some(([name, count]) => count > (inventoryBefore[name] || 0));
    if (gained) return { ok: true, picked: 1, inventory: this.inventory };
    // Non insistere su un drop irraggiungibile (es. su una chioma): verrà ritentato più tardi.
    const failed = this._nearestDrop({ names });
    if (failed) {
      const entry = this.drops.find(d => String(d.id) === String(failed.id));
      if (entry) entry.failedAt = Date.now();
    }
    return { ok: false, error: 'item_not_collected', inventory: this.inventory };
  }

  // ---- crafting e piazzamento --------------------------------------------------------

  _nextStackRequest () {
    this._stackRequestId -= 2;
    return this._stackRequestId;
  }

  _slotInfo (container, slot, stack = 0) {
    // dynamic_container_id va omesso: con il campo presente BDS considera il
    // container come dinamico e rifiuta lo slot (status 49).
    return { slot_type: { container_id: container }, slot, stack_id: stack };
  }

  // Destinazione di una mossa verso uno slot giocatore: BDS accetta
  // 'hotbar_and_inventory' con l'indice assoluto 0..35 (il container 'inventory'
  // viene rifiutato con status 50 in destinazione).
  _invSlotToSlotInfo (index) {
    return { container: 'hotbar_and_inventory', slot: index };
  }

  // Sorgente di un take da uno slot giocatore: la hotbar usa 'hotbar'/0..8,
  // la main inventory 'hotbar_and_inventory'/indice assoluto (verificato live
  // il 02/10/2026; 'inventory' come sorgente dà status 49).
  _invSlotAsSource (index) {
    return index < 9
      ? { container: 'hotbar', slot: index }
      : { container: 'hotbar_and_inventory', slot: index };
  }

  // Mappa (container, slot) della finestra giocatore verso l'indice 0..35 usato
  // internamente. I label possono arrivare come nome o come window id storico.
  _playerSlotIndex (containerId, windowId, slot) {
    if (containerId === 'hotbar') return slot;
    if (containerId === 'inventory') return slot + 9;
    if (containerId === 'hotbar_and_inventory') return slot;
    if (containerId == null) {
      // BDS can reuse numeric window 2 for a chest/workbench and omit the container
      // label. Its slot updates must not become phantom player inventory.
      if (this._openContainer && this._openContainer.type !== 'inventory' && windowId === this._openContainer.id) return null;
      if (windowId === 'hotbar') return slot;
      if (windowId === 'inventory' || windowId === 0 || windowId === 2) return slot;
    }
    return null;
  }

  _sendStackRequest (actions, { outputs = false, timeoutMs = 4000 } = {}) {
    const signal = this._actionScope?.getStore()?.signal;
    if (signal?.aborted) return Promise.reject(new Error('action_cancelled'));
    if (!this.client) return Promise.reject(new Error('connection_lost'));
    const requestId = this._nextStackRequest();
    const prepared = actions.map(action => {
      if (outputs && action.source?.slot_type?.container_id === 'creative_output') {
        return { ...action, source: { ...action.source, stack_id: requestId } };
      }
      return action;
    });
    return new Promise((resolve, reject) => {
      const finish = (error, response) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.client?.off('item_stack_response', onResponse);
        if (error) reject(error); else resolve(response);
      };
      const onResponse = packet => {
        const response = packet.responses?.find(r => r.request_id === requestId);
        if (response) finish(null, response);
      };
      const onAbort = () => finish(new Error('action_cancelled'));
      const timer = setTimeout(() => finish(new Error('stack_request_timeout')), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.client.on('item_stack_response', onResponse);
      this.client.write('item_stack_request', { requests: [{ request_id: requestId, actions: prepared, custom_names: [], cause: 'chat_public' }] });
    });
  }

  _responseSlotStack (response, container, slot) {
    return response?.containers
      ?.find(c => c.slot_type?.container_id === container)
      ?.slots?.find(s => s.slot === slot)?.item_stack_id;
  }

  _applyStackResponse (response, { networkId = null } = {}) {
    for (const container of response.containers || []) {
      const cid = container.slot_type?.container_id;
      for (const slot of container.slots || []) {
        if (cid === 'cursor') {
          if (slot.count === 0) this._cursor = null;
          else this._cursor = {
            network_id: this._cursor?.network_id ?? networkId ?? 0,
            count: slot.count,
            stack_id: slot.item_stack_id,
          };
          continue;
        }
        if (cid === 'crafting_input') {
          if (slot.count === 0) this._craftingGrid.delete(slot.slot);
          else this._craftingGrid.set(slot.slot, {
            network_id: this._craftingGrid.get(slot.slot)?.network_id ?? networkId ?? 0,
            count: slot.count,
            stack_id: slot.item_stack_id,
          });
          continue;
        }
        if (cid === 'offhand') {
          // Lo specchio dell'offhand si aggiorna solo da qui (e dal
          // `mob_equipment`): senza questo ramo la risposta di un `place`
          // riuscito spariva, `_offhandItem()` restava `null` e il passo di
          // scambio di M16 usava una stack id falsa (live 09/10/2026: due
          // scudi in zaino e `equip_shield` che rispondeva `already: true`
          // mentre l'offhand era vuoto).
          if (slot.count === 0) this.offhand = null;
          else this.offhand = {
            name: this.offhand?.name ?? null,
            count: slot.count,
            network_id: this.offhand?.network_id ?? networkId ?? null,
            stack_id: slot.item_stack_id ?? null,
          };
          continue;
        }
        let index = null;
        if (cid === 'hotbar') index = slot.slot;
        else if (cid === 'inventory') index = slot.slot + 9;
        else if (cid === 'hotbar_and_inventory') index = slot.slot;
        if (index == null || index < 0 || index > 35) continue;
        if (slot.count === 0) {
          this.inventorySlots[index] = undefined;
          continue;
        }
        const existing = this.inventorySlots[index] || {};
        this.inventorySlots[index] = {
          ...existing,
          network_id: existing.network_id || networkId || 0,
          count: slot.count,
          stack_id: slot.item_stack_id,
          has_stack_id: true,
        };
      }
    }
    this._refreshInventory();
  }

  // Una finestra si e' aperta: la serie di aperture fallite e' finita (il
  // contatore serve solo a riconoscere la sessione bloccata, non a contare).
  _noteContainerOpened () {
    this._containerOpenFailures = 0;
    this._containerOpenFailureSince = null;
  }

  _waitForContainerOpen (predicate, timeoutMs = 3000) {
    const pending = new Promise((resolve, reject) => {
      const waiter = { predicate, resolve: packet => { clearTimeout(timer); resolve(packet); } };
      const timer = setTimeout(() => {
        this._containerWaiters = this._containerWaiters.filter(w => w !== waiter);
        this._containerOpenFailures = (this._containerOpenFailures ?? 0) + 1;
        if (this._containerOpenFailureSince == null) this._containerOpenFailureSince = Date.now();
        if (this._containerOpenFailures >= CONTAINER_OPEN_LOCK_FAILURES) {
          const locked = new Error('container_ui_locked');
          locked.details = {
            failures: this._containerOpenFailures,
            since: this._containerOpenFailureSince,
            hint: 'nessuna finestra si apre piu\' per questo giocatore: riavviare il server Bedrock',
          };
          this.log('container_locked_suspected', locked.details);
          reject(locked);
          return;
        }
        reject(new Error('container_open_timeout'));
      }, timeoutMs);
      this._containerWaiters.push(waiter);
    });
    // Una `wait` abbandonata (un altro tentativo ha gia' aperto la finestra, o
    // l'await e' saltato da un'eccezione) rifiutava senza handler: Node emetteva
    // `unhandledRejection` e la sessione NetherNet cadeva su `connecterror:9`,
    // lasciando il bot immobile e uccidibile. Il catch qui non cambia l'esito
    // per chi fa `await` (la promise restituita e' la stessa): toglie solo il
    // rifiuto non gestito.
    pending.catch(() => {});
    return pending;
  }

  // Il contenuto di un container storage arriva in un pacchetto separato
  // (`inventory_content` con il window id della finestra aperta), spesso
  // centinaia di ms dopo `container_open`. Chi legge `_openContainerSlots`
  // senza aspettarlo vede le slot della finestra **precedente** (o un array
  // vuoto) e decide su dati sbagliati: live 03/10 `take_iron_ingot` rispondeva
  // `item_not_in_container` 300 ms dopo l'apertura del baule, con la cache che
  // diceva ancora 795 lingotti. Attesa limitata ed esplicita.
  _waitForContainerContent (windowId, timeoutMs = 2000) {
    if (this._openContainerContentAt > 0 && this._openContainerContentWindow === windowId) return Promise.resolve(true);
    return new Promise(resolve => {
      const waiter = {
        windowId,
        resolve: value => {
          clearTimeout(timer);
          this._containerContentWaiters = this._containerContentWaiters.filter(w => w !== waiter);
          resolve(value);
        },
      };
      const timer = setTimeout(() => waiter.resolve(false), timeoutMs);
      this._containerContentWaiters.push(waiter);
    });
  }

  async _ensureInventoryOpen () {
    if (this._openContainer?.type === 'inventory') return;
    if (this._openContainer) await this._closeContainer();
    if (this._actionScope?.getStore()?.signal.aborted) throw new Error('action_cancelled');
    const wait = this._waitForContainerOpen(p => p.window_type === 'inventory', 3000);
    this.client.write('interact', { action_id: 'open_inventory', target_entity_id: this.client.entityId, has_position: false });
    await wait;
    await delay(200); // lascia arrivare inventory_content con lo stato della griglia
  }

  async _closeContainer () {
    if (this._actionScope?.getStore()?.signal.aborted) return;
    const open = this._openContainer;
    if (!open || !this.client) return;
    const wasTrading = open.type === 'trading' || open.type === 15;
    this.client.write('container_close', { window_id: open.id, window_type: 'none', server: false });
    this._openContainer = null;
    this._openContainerBlock = null;
    this._openContainerSlots = [];
    this._openContainerContentAt = 0;
    this._openContainerContentWindow = null;
    // Il server restituisce o fa cadere gli item rimasti nella griglia: lo stato locale non è più valido.
    if (this._craftingGrid.size) this.log('grid_leftovers_discarded', { slots: [...this._craftingGrid.keys()] });
    this._craftingGrid.clear();
    if (wasTrading) {
      this.tradeOffers = [];
      this.tradeOpenedAt = 0;
      this.tradeTarget = null;
      this._tradeSlots = { ingredient1: null, ingredient2: null, result: null };
    }
    await delay(80);
  }

  async _returnCursorToInventory () {
    let guard = 0;
    while (this._cursor?.count > 0 && guard++ < 5) {
      const networkId = this._cursor.network_id;
      const dest = this._findOutputSlot(networkId);
      if (dest < 0) return false;
      const info = this._invSlotToSlotInfo(dest);
      const response = await this._sendStackRequest([{
        type_id: 'place', legacy_type_id: 1, count: this._cursor.count,
        source: this._slotInfo('cursor', 0, this._cursor.stack_id),
        destination: this._slotInfo(info.container, info.slot,
          this.inventorySlots[dest]?.network_id === networkId ? this.inventorySlots[dest].stack_id || 0 : 0),
      }], { timeoutMs: 2500 });
      if (String(response.status) !== 'ok' && response.status !== 0) return false;
      this._applyStackResponse(response, { networkId });
    }
    return this._cursor == null;
  }

  // ---- ricette: selezione e piazzamento nella griglia ---------------------------------

  _recipeBody (entry) {
    return this.craftingData?.shaped_recipes?.find(r => r.network_id === entry.network_id)
      || this.craftingData?.shapeless_recipes?.find(r => r.network_id === entry.network_id);
  }

  _slotItemName (slot) {
    if (!slot?.network_id) return null;
    return slot.name || this.world.registry?.items[slot.network_id]?.name || null;
  }

  _ingredientMatches (ingredient, name) {
    if (!name || ingredient.type !== 'valid') return false;
    if (ingredient.descriptor_type === 'name') {
      return name === String(ingredient.name).replace(/^minecraft:/, '');
    }
    if (ingredient.descriptor_type === 'item_tag') {
      const tag = String(ingredient.tag).replace(/^minecraft:/, '');
      if (tag === 'planks') return /_planks$/.test(name);
      if (tag === 'logs' || tag === 'log' || tag === 'wooden_logs') return /(_log|_stem|_hyphae)$/.test(name);
      // Il tag degli utensili di pietra è quello che usa la ricetta vanilla del piccone.
      if (tag === 'stone_tool_materials' || tag === 'stone_crafting_materials') {
        return /^(cobblestone|cobbled_deepslate|blackstone)$/.test(name);
      }
      // Torce e fornaci da carbone: il tag è "coals" (carbone + carbonella).
      if (tag === 'coals' || tag === 'coal') return /^(coal|charcoal)$/.test(name);
      // Letto: 3 lana (qualsiasi colore) + 3 assi.
      if (tag === 'wool' || tag === 'wools') return /_wool$/.test(name);
      return true; // tag non mappato: lascia decidere al server
    }
    return false;
  }

  _gridSlotFor (recipe, inputIndex, table) {
    const width = recipe.width || 1;
    const x = inputIndex % width;
    const y = Math.floor(inputIndex / width);
    const tableYOffset = table && (recipe.height || 1) < 3 ? 1 : 0;
    const proto = (y + tableYOffset) * (table ? 3 : 2) + x;
    return table ? 32 + proto : [30, 31, 28, 29][proto] ?? 30 + proto;
  }

  _planGrid (recipe, table) {
    const slots = [];
    const inputs = recipe.input || [];
    for (let i = 0; i < inputs.length; i++) {
      const ingredient = inputs[i];
      if (ingredient.type !== 'valid') continue;
      slots.push({ gridSlot: this._gridSlotFor(recipe, i, table), ingredient });
    }
    return slots;
  }

  // `items` (l'aggregato `inventory`) serve solo a decidere se *offrire* una
  // ricetta: i pickup aggiornano l'aggregato prima che gli slot rispecchino lo
  // stack id, e la verifica vera (quella che apre la griglia) resta sugli slot.
  _hasMaterials (recipe, { items = null } = {}) {
    if (!recipe.output?.length) return false;
    const grid = this._planGrid(recipe, (recipe.width || 1) > 2 || (recipe.height || 1) > 2);
    const available = items
      ? Object.entries(items).filter(([, count]) => Number(count) > 0).map(([name, count]) => ({ name, count: Number(count) }))
      : this.inventorySlots.map(s => s ? { name: this._slotItemName(s), count: s.count } : null);
    for (const { ingredient } of grid) {
      let remaining = ingredient.count || 1;
      for (let i = 0; i < available.length && remaining > 0; i++) {
        const slot = available[i];
        if (!slot || slot.count <= 0) continue;
        if (!this._ingredientMatches(ingredient, slot.name)) continue;
        const used = Math.min(slot.count, remaining);
        slot.count -= used;
        remaining -= used;
      }
      if (remaining > 0) return false;
    }
    return true;
  }

  // Una ricetta è offribile se la forma è nota e i materiali ci sono, sugli slot
  // o almeno nell'aggregato (slot in ritardo dopo un pickup: `_craftItem` fa il
  // resync). Evita di offrire un craft che fallirebbe con `missing_ingredients`.
  _craftable (name) {
    const candidates = (this.recipes && this.recipes.get(name)) || [];
    return candidates.some(entry => {
      const recipe = this._recipeBody(entry);
      if (!recipe) return false;
      return this._hasMaterials(recipe) || this._hasMaterials(recipe, { items: this.inventory });
    });
  }

  _findSourceSlot (ingredient) {
    for (let i = 0; i < this.inventorySlots.length; i++) {
      const slot = this.inventorySlots[i];
      if (!slot?.network_id || !slot.count) continue;
      if (this._ingredientMatches(ingredient, this._slotItemName(slot))) return i;
    }
    return -1;
  }

  _itemStackSize (networkId) {
    const item = this.world.registry?.items?.[networkId];
    if (!item) return 64;
    if ((item.maxDurability || 0) > 0) return 1;
    return item.stackSize || item.maxStackSize || 64;
  }

  _findOutputSlot (networkId, count = 1) {
    const stackSize = this._itemStackSize(networkId);
    for (let i = 0; i < 9; i++) {
      const slot = this.inventorySlots[i];
      if (slot?.network_id === networkId && (slot.count || 0) + count <= stackSize) return i;
    }
    for (let i = 0; i < 9; i++) if (!this.inventorySlots[i]?.network_id) return i;
    for (let i = 9; i < 36; i++) {
      const slot = this.inventorySlots[i];
      if (slot?.network_id === networkId && (slot.count || 0) + count <= stackSize) return i;
    }
    for (let i = 9; i < 36; i++) if (!this.inventorySlots[i]?.network_id) return i;
    return -1;
  }

  // Preleva dall'inventario e mette sul cursore. Due cause note rendono il
  // `take` fragile, entrambe documentate in BEDROCK.md §"Container mapping for
  // take/place":
  // 1. senza una finestra aperta il server risponde 49/50 (le richieste
  //    `item_stack_request` valgono solo con un container aperto): è il motivo
  //    per cui `_moveItemViaCursor` chiama `_ensureInventoryOpen()` prima di
  //    ogni take. Era la causa live di `equip_shield` →
  //    `shield_take_failed_50` (03/10, hotbar/2, stack_id 762);
  // 2. un `place` fallito lascia l'item **sul cursore** lato server, e da lì
  //    ogni take verso il cursore viene rifiutato con 50 finché non lo si
  //    rimette in uno slot: rimedio documentato, rimetterlo e ritentare una
  //    volta sola.
  // 3. la finestra deve restare quella del craft in corso: con un banco da
  //    lavoro aperto `_ensureInventoryOpen()` lo **chiude** e apre l'inventario
  //    del giocatore, dove le celle della griglia 3x3 non esistono più. Live
  //    03/10: `craft_bucket` finiva in `place_failed_55` esattamente per questo
  //    (il `place` nella griglia veniva rifiutato dopo che il banco era stato
  //    sostituito dall'inventario). Il percorso della griglia passa
  //    `ensureInventory: false` perché la finestra l'ha già aperta `_craftAttempt`.
  async _takeToCursor (slotIndex, count, { attempts = 2, ensureInventory = true } = {}) {
    if (ensureInventory) await this._ensureInventoryOpen();
    const item = this.inventorySlots[slotIndex];
    if (!item?.network_id) throw new Error('missing_ingredients');
    const info = this._invSlotAsSource(slotIndex);
    this.log('take_request', { slotIndex, name: this._slotItemName(item), count, stack_id: item.stack_id ?? null, has_stack_id: item.has_stack_id ?? null });
    let response = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      response = await this._sendStackRequest([{
        type_id: 'take', legacy_type_id: 0, count,
        source: this._slotInfo(info.container, info.slot, this.inventorySlots[slotIndex]?.stack_id || 0),
        destination: this._slotInfo('cursor', 0, 0),
      }]).catch(() => null);
      if (response && (String(response.status) === 'ok' || response.status === 0)) break;
      const status = response?.status ?? 'timeout';
      this.log('cursor_take_failed', { slotIndex, name: this._slotItemName(item), container: info.container, slot: info.slot, stack_id: item.stack_id ?? null, status, attempt });
      if (status !== 49 && status !== 50) throw new Error(`take_failed_${status}`);
      await this._returnCursorToInventory().catch(() => {});
    }
    if (!response || (String(response.status) !== 'ok' && response.status !== 0)) {
      throw new Error(`take_failed_${response?.status ?? 'timeout'}`);
    }
    this._applyStackResponse(response);
    this._cursor = { network_id: item.network_id, count, stack_id: this._responseSlotStack(response, 'cursor', 0) ?? 0 };
    return this._cursor.stack_id;
  }

  async _placeFromCursor (gridSlot, count, cursorStack, networkId = null) {
    const response = await this._sendStackRequest([{
      type_id: 'place', legacy_type_id: 1, count,
      source: this._slotInfo('cursor', 0, cursorStack),
      destination: this._slotInfo('crafting_input', gridSlot, this._craftingGrid.get(gridSlot)?.stack_id || 0),
    }]);
    if (String(response.status) !== 'ok' && response.status !== 0) throw new Error(`place_failed_${response.status}`);
    // `networkId` è l'item appena posato: senza, il modello della griglia resta
    // `network_id: 0` (`name: 0` nei log) perché lo slot è appena stato svuotato
    // da `_clearCraftingGrid` e la risposta di `place` può non nominare l'item
    // (live 06/10: `craft_failed_detail` con `grid: [{slot:30,name:0},
    // {slot:28,name:0}]` mentre l'adapter sapeva benissimo cosa aveva posato).
    this._applyStackResponse(response, { networkId });
    if (networkId && !this._craftingGrid.get(gridSlot)?.network_id) {
      this._craftingGrid.set(gridSlot, {
        network_id: networkId,
        count,
        stack_id: this._responseSlotStack(response, 'crafting_input', gridSlot) ?? 0,
      });
    }
    const stackId = this._responseSlotStack(response, 'crafting_input', gridSlot);
    // La griglia è la parte della finestra che il server non sempre rimanda:
    // se non torna, il `consume` partirà con stack id 0 e la request verrà
    // rifiutata. Questo log è la prova che serve al prossimo giro live.
    this.log('craft_grid_place', {
      gridSlot, item: this._slotItemName({ network_id: networkId }), count,
      stackId: stackId ?? 0, echoed: stackId != null,
      containers: (response.containers || []).map(c => c.slot_type?.container_id).filter(Boolean),
    });
    return stackId ?? 0;
  }

  async _clearCraftingGrid () {
    if (!this._craftingGrid.size) return true;
    for (const [slot, entry] of [...this._craftingGrid]) {
      if (!entry?.count) { this._craftingGrid.delete(slot); continue; }
      const takeResp = await this._sendStackRequest([{
        type_id: 'take', legacy_type_id: 0, count: entry.count,
        source: this._slotInfo('crafting_input', slot, entry.stack_id),
        destination: this._slotInfo('cursor', 0, 0),
      }], { timeoutMs: 2000 }).catch(() => null);
      if (!takeResp || (String(takeResp.status) !== 'ok' && takeResp.status !== 0)) {
        this._craftingGrid.clear();
        return false;
      }
      this._applyStackResponse(takeResp, { networkId: entry.network_id });
      this._cursor = { network_id: entry.network_id, count: entry.count, stack_id: this._responseSlotStack(takeResp, 'cursor', 0) ?? 0 };
    }
    return this._returnCursorToInventory();
  }

  async _placeGridIngredients (recipe, table) {
    const gridStackIds = new Map();
    for (const { gridSlot, ingredient } of this._planGrid(recipe, table)) {
      const count = ingredient.count || 1;
      for (let unit = 0; unit < count; unit++) {
        const source = this._findSourceSlot(ingredient);
        if (source < 0) throw new Error('missing_ingredients');
        // L'id dell'item va letto *prima* del take: una pila da 1 sparisce dallo
        // slot e con lei il `network_id` che serve per etichettare la cella.
        const sourceNetworkId = this.inventorySlots[source]?.network_id ?? null;
        // Mai riaprire l'inventario qui: chiuderebbe il banco da lavoro e la
        // griglia 3x3 sparirebbe dalla finestra corrente (status 55 live 03/10).
        const cursorStack = await this._takeToCursor(source, 1, { ensureInventory: false });
        gridStackIds.set(gridSlot, await this._placeFromCursor(gridSlot, 1, cursorStack, sourceNetworkId));
      }
    }
    return gridStackIds;
  }

  _craftActions (recipe, gridStackIds) {
    const result = recipe.output[0];
    const name = `minecraft:${this.world.registry?.items[result.network_id]?.name || 'item'}`;
    const descriptor = {
      type: 'name', legacy_type: 1, name,
      metadata: 0, count: result.count || 1,
      block_runtime_id: result.block_runtime_id || 0,
      extra: { has_nbt: 0, can_place_on: [], can_destroy: [] },
    };
    const destinationIndex = this._findOutputSlot(result.network_id);
    if (destinationIndex < 0) throw new Error('inventory_full');
    const destination = this._invSlotToSlotInfo(destinationIndex);
    const destinationItem = this.inventorySlots[destinationIndex];
    const destinationStack = destinationItem?.network_id === result.network_id ? destinationItem.stack_id || 0 : 0;
    const actions = [
      { type_id: 'craft_recipe', legacy_type_id: 12, recipe_network_id: recipe.network_id, times_crafted: 1 },
      { type_id: 'results_deprecated', legacy_type_id: 19, result_items: [descriptor], times_crafted: 1 },
    ];
    for (const [gridSlot, stackId] of gridStackIds) {
      actions.push({
        type_id: 'consume', legacy_type_id: 5, count: 1,
        source: this._slotInfo('crafting_input', gridSlot, stackId),
      });
    }
    actions.push({
      type_id: 'place', legacy_type_id: 1, count: result.count || 1,
      source: this._slotInfo('creative_output', 50, 0),
      destination: this._slotInfo(destination.container, destination.slot, destinationStack),
    });
    return { actions, result };
  }

  async _ensureCraftingTableOpen ({ position = null } = {}) {
    if (this._openContainer?.type === 'workbench' && !position) return;
    if (this._openContainer) await this._closeContainer();
    const table = position ? { ...this.world.blockAt(position), position,
      distance: Math.hypot(this.position.x - position.x - 0.5, this.position.y - position.y - 0.5, this.position.z - position.z - 0.5) }
      : this.world.findBlocks('crafting_table', this.position, 32, 1)[0];
    if (!table || table.name !== 'crafting_table') throw new Error('crafting_table_not_found');
    if (table.distance > 3.5) {
      // Bersaglio a quota tavolo: i piedi accanto al tavolo stanno alla stessa
      // quota del blocco (il tavolo è appoggiato al terreno).
      await this._moveTo({ x: table.position.x + 0.5, y: table.position.y, z: table.position.z + 0.5 }, 3, 30000);
    }
    await delay(100);
    let lastError = null;
    for (let attempt = 1; attempt <= 3 && this._openContainer?.type !== 'workbench'; attempt++) {
      const wait = this._waitForContainerOpen(p => p.window_type === 'workbench', 2500);
      const yaw = this._yawTo(this._feet, { x: table.position.x + 0.5, z: table.position.z + 0.5 });
      const pitch = this._lookAt({ x: table.position.x + 0.5, y: table.position.y + 0.5, z: table.position.z + 0.5 }).pitch;
      await this._queueAuthInput({ yaw, pitch, transaction: this._blockUseTransaction(table.position) });
      try {
        await wait;
      } catch (error) {
        lastError = error;
        if (this._openContainer?.type === 'workbench') break;
        await delay(300);
      }
    }
    if (this._openContainer?.type !== 'workbench') throw lastError || new Error('crafting_table_not_opened');
    this._openContainerBlock = table;
    await delay(200); // lascia arrivare inventory_content con lo stato della griglia
  }

  // ---- fusione in fornace ------------------------------------------------------------

  _trackFurnaceSlot (containerId, item) {
    const key = FURNACE_BY_CONTAINER[containerId];
    if (!key) return false;
    this._furnaceSlots[key] = item?.network_id ? item : null;
    return true;
  }

  _trackFurnaceSlots (input) {
    this._furnaceSlots.ingredient = input[FURNACE_SLOTS.ingredient]?.network_id ? input[FURNACE_SLOTS.ingredient] : null;
    this._furnaceSlots.fuel = input[FURNACE_SLOTS.fuel]?.network_id ? input[FURNACE_SLOTS.fuel] : null;
    this._furnaceSlots.output = input[FURNACE_SLOTS.output]?.network_id ? input[FURNACE_SLOTS.output] : null;
  }

  // input -> output: furnace_recipes del server (se presenti) + mappa statica.
  _smeltTargets () {
    const targets = [];
    const seen = new Set();
    const add = (input, output, count = 1) => {
      const key = `${input}->${output}`;
      if (seen.has(key)) return;
      seen.add(key);
      targets.push({ input, output, count });
    };
    for (const recipe of this.furnaceRecipes || []) {
      if (recipe.block && !SMELT_STATIONS[recipe.block]) continue;
      const input = this.world.registry?.items?.[recipe.input_id]?.name;
      const output = recipe.output?.name || this.world.registry?.items?.[recipe.output?.network_id]?.name;
      if (input && output) add(input, output, recipe.output?.count || 1);
    }
    for (const [input, output] of Object.entries(SMELT_RECIPES)) add(input, output);
    return targets;
  }

  _pickFuel () {
    let best = null;
    for (let i = 0; i < this.inventorySlots.length; i++) {
      const slot = this.inventorySlots[i];
      const name = this._slotItemName(slot);
      if (!name || !(slot?.count > 0)) continue;
      const priority = /^(coal|charcoal)$/.test(name) ? 3 : (/(_planks|_log|_stem|_hyphae)$/.test(name) ? 2 : 0);
      if (priority && (!best || priority > best.priority)) best = { name, priority };
    }
    return best;
  }

  // Stazione preferita per una ricetta: minerali → altoforno, cibo → affumicatore,
  // tutto il resto → fornace base (che può fare qualsiasi cosa).
  _smeltStationFor (inputName) {
    if (/^(potato|beef|chicken|porkchop|mutton|cod|salmon|rabbit|kelp)$/.test(inputName)) return 'smoker';
    if (/^(raw_|.*_ore$)/.test(inputName)) return 'blast_furnace';
    return 'furnace';
  }

  // Cerca la stazione preferita; se non c'è, ripiega sulla fornace base.
  _findSmeltingStation (preferred) {
    const names = preferred && preferred !== 'furnace' ? [preferred, 'furnace'] : ['furnace'];
    for (const name of names) {
      const found = this.world.findBlocks(name, this.position, 32, 1)[0];
      if (found) return { name, position: found.position, distance: +(found.distance ?? 0).toFixed(1) };
    }
    return null;
  }

  async _ensureFurnaceOpen (station) {
    const windowType = SMELT_STATIONS[station.name].window;
    if (this._openContainer?.type === windowType) return;
    if (this._openContainer) await this._closeContainer();
    if (station.distance > 3.5) {
      await this._moveTo({ x: station.position.x + 0.5, y: station.position.y, z: station.position.z + 0.5 }, 3, 30000);
    }
    await delay(100);
    let lastError = null;
    for (let attempt = 1; attempt <= 3 && this._openContainer?.type !== windowType; attempt++) {
      const wait = this._waitForContainerOpen(p => p.window_type === windowType, 2500);
      const yaw = this._yawTo(this._feet, { x: station.position.x + 0.5, z: station.position.z + 0.5 });
      const pitch = this._lookAt({ x: station.position.x + 0.5, y: station.position.y + 0.5, z: station.position.z + 0.5 }).pitch;
      await this._queueAuthInput({ yaw, pitch, transaction: this._blockUseTransaction(station.position) });
      try {
        await wait;
      } catch (error) {
        lastError = error;
        if (this._openContainer?.type === windowType) break;
        await delay(300);
      }
    }
    if (this._openContainer?.type !== windowType) throw lastError || new Error(`${station.name}_not_opened`);
    await delay(200); // lascia arrivare inventory_content della stazione
  }

  // Prende count item dall'inventario al cursore e li mette nello slot della stazione.
  async _putInFurnace (slotKey, itemName, count, station) {
    const index = this.inventorySlots.findIndex(s => this._slotItemName(s) === itemName && (s.count || 0) >= count);
    if (index < 0) throw new Error('missing_ingredients');
    const container = slotKey === 'ingredient'
      ? SMELT_STATIONS[station?.name || 'furnace'].ingredient
      : `furnace_${slotKey}`;
    const item = this.inventorySlots[index];
    const info = this._invSlotToSlotInfo(index);
    const take = await this._sendStackRequest([{
      type_id: 'take', legacy_type_id: 0, count,
      source: this._slotInfo(info.container, info.slot, item.stack_id || 0),
      destination: this._slotInfo('cursor', 0, 0),
    }]);
    if (String(take.status) !== 'ok' && take.status !== 0) throw new Error(`take_failed_${take.status}`);
    this._applyStackResponse(take);
    const cursorStack = this._responseSlotStack(take, 'cursor', 0) ?? 0;
    const current = this._furnaceSlots?.[slotKey];
    const place = await this._sendStackRequest([{
      type_id: 'place', legacy_type_id: 1, count,
      source: this._slotInfo('cursor', 0, cursorStack),
      destination: this._slotInfo(container, FURNACE_SLOTS[slotKey], current?.stack_id || 0),
    }]);
    if (String(place.status) !== 'ok' && place.status !== 0) throw new Error(`place_failed_${place.status}`);
    this._applyStackResponse(place, { networkId: item.network_id });
    this._cursor = null;
    this._furnaceSlots[slotKey] = {
      network_id: item.network_id, count,
      stack_id: this._responseSlotStack(place, container, FURNACE_SLOTS[slotKey]) ?? current?.stack_id ?? 0,
    };
    this.log('furnace_put', { station: station?.name || 'furnace', slot: slotKey, container, item: itemName, count, status: place.status });
  }

  // Ritira l'output pronto (se c'è) e lo mette in inventario.
  async _takeFurnaceOutput () {
    const output = this._furnaceSlots?.output;
    if (!output?.network_id) return null;
    const count = output.count || 1;
    const take = await this._sendStackRequest([{
      type_id: 'take', legacy_type_id: 0, count,
      source: this._slotInfo('furnace_output', FURNACE_SLOTS.output, output.stack_id || 0),
      destination: this._slotInfo('cursor', 0, 0),
    }]);
    if (String(take.status) !== 'ok' && take.status !== 0) throw new Error(`take_failed_${take.status}`);
    this._applyStackResponse(take, { networkId: output.network_id });
    this._cursor = { network_id: output.network_id, count, stack_id: this._responseSlotStack(take, 'cursor', 0) ?? output.stack_id ?? 0 };
    const returned = await this._returnCursorToInventory();
    if (!returned) throw new Error('output_return_failed');
    this._furnaceSlots.output = null;
    return { ...output, count };
  }

  async _waitFurnaceOutput (timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this._furnaceSlots?.output?.network_id) return { ...this._furnaceSlots.output };
      await delay(250);
    }
    return null;
  }

  async _smeltItem (inputName) {
    const target = this._smeltTargets().find(t => t.input === inputName);
    if (!target) return { ok: false, error: 'smelt_recipe_missing' };
    if (!this._pickFuel()) return { ok: false, error: 'no_fuel' };
    if (!this.inventorySlots.some(s => this._slotItemName(s) === inputName && (s.count || 0) >= 1)) {
      return { ok: false, error: 'missing_ingredients' };
    }
    const station = this._findSmeltingStation(this._smeltStationFor(inputName));
    if (!station) return { ok: false, error: 'furnace_not_found' };
    const started = Date.now();
    try {
      await this._ensureFurnaceOpen(station);
      await this._takeFurnaceOutput(); // residui di fusioni precedenti
      await this._putInFurnace('ingredient', inputName, 1, station);
      const fuel = this._pickFuel();
      if (!fuel) throw new Error('no_fuel');
      await this._putInFurnace('fuel', fuel.name, 1, station);
      this.log('smelt_started', { station: station.name, input: inputName, output: target.output, fuel: fuel.name });
      let output = await this._waitFurnaceOutput();
      if (!output) {
        // Se il server non ha spinto l'aggiornamento dello slot, riapri la
        // stazione per rileggere inventory_content e ricontrolla.
        await this._closeContainer();
        await this._ensureFurnaceOpen(station);
        output = await this._waitFurnaceOutput(3000);
      }
      if (!output) return { ok: false, error: 'smelt_timeout', input: inputName };
      const taken = await this._takeFurnaceOutput();
      return { ok: true, station: station.name, smelted: inputName, output: target.output, count: taken?.count || output.count || 1, ms: Date.now() - started };
    } catch (error) {
      return { ok: false, error: error.message };
    } finally {
      await this._returnCursorToInventory().catch(() => {});
      await this._closeContainer().catch(() => {});
      this._refreshInventory();
    }
  }

  // ---- commercio con villager e mercanti itineranti ---------------------------------

  // I mercanti itineranti despawnano: il loro commercio scade prima di quello
  // dei villager (che restano).
  _tradeTTLMs () {
    return this.tradeTarget?.type === 'wandering_trader' ? 3 * 60 * 1000 : 10 * 60 * 1000;
  }

  _tradeWindowOpen () {
    return !!this._openContainer && (this._openContainer.type === 'trading' || this._openContainer.type === 15);
  }

  // Slot container (FullContainerName) delle tre finestre di trading. La UI nuova
  // (1.11+, quindi anche BDS 1.26) usa i nomi trade2_*; quella vecchia trade_*.
  _tradeSlotContainers () {
    if (this.tradeNewUI) {
      return { ingredient1: 'trade2_ingredient1', ingredient2: 'trade2_ingredient2', result: 'trade2_result' };
    }
    return { ingredient1: 'trade_ingredient1', ingredient2: 'trade_ingredient2', result: 'trade_result' };
  }

  // Converte un tag prismarine-nbt (o un valore già sciolto) in JS puro:
  // compound -> oggetto, list -> array, scalari -> number/string.
  _nbtToJs (tag) {
    if (tag == null) return null;
    if (Array.isArray(tag)) return tag.map(t => this._nbtToJs(t));
    if (typeof tag !== 'object') return tag;
    if ('type' in tag && 'value' in tag) {
      const type = tag.type;
      if (type === 'list') {
        const inner = tag.value;
        const arr = Array.isArray(inner) ? inner : (Array.isArray(inner?.value) ? inner.value : []);
        return arr.map(item => this._nbtToJs(item));
      }
      if (type === 'compound') {
        const out = {};
        const val = tag.value;
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          for (const [k, v] of Object.entries(val)) out[k] = this._nbtToJs(v);
        }
        return out;
      }
      return typeof tag.value === 'bigint' ? Number(tag.value) : tag.value;
    }
    const out = {};
    for (const [k, v] of Object.entries(tag)) out[k] = this._nbtToJs(v);
    return out;
  }

  // Parsa le offerte NBT di update_trade in un array leggibile:
  // { buyA: {item, count}, buyB: {...}|null, sell: {item, count}, uses, maxUses, tier, rewardExp }.
  _parseTradeOffers (offers) {
    const root = this._nbtToJs(offers) || {};
    const recipes = Array.isArray(root.Recipes) ? root.Recipes : [];
    const out = [];
    for (const recipe of recipes) {
      const cleanItem = raw => {
        if (!raw || typeof raw !== 'object') return null;
        const name = String(raw.id || raw.ID || raw.item || '').replace(/^minecraft:/, '');
        const count = Number(raw.Count ?? raw.count ?? raw.CountV1 ?? 1) || 1;
        if (!name || name === 'air' || count <= 0) return null;
        return { item: name, count };
      };
      const buyA = cleanItem(recipe.buyA);
      const buyB = cleanItem(recipe.buyB);
      const sell = cleanItem(recipe.sell);
      if (!buyA || !sell) continue; // offerta senza costo o senza output non è commerciabile
      out.push({
        buyA,
        buyB: buyB && buyB.count > 0 ? buyB : null,
        sell,
        uses: Number(recipe.uses ?? 0) || 0,
        maxUses: Number(recipe.maxUses ?? 0) || 0,
        tier: Number(recipe.tier ?? 0) || 0,
        rewardExp: !!recipe.rewardExp,
        // Prezzo reale (economia vanilla: il prezzo sale con la domanda).
        priceMultiplierA: Number(recipe.priceMultiplierA ?? recipe.priceMultiplierA1 ?? 0) || 0,
      });
    }
    return out;
  }

  _onUpdateTrade (packet) {
    this.tradeOpenedAt = Date.now();
    this.tradeDisplayName = packet.display_name || null;
    this.tradeTier = packet.trade_tier ?? null;
    this.tradeNewUI = packet.new_trading_ui !== false;
    this.tradeOffers = this._parseTradeOffers(packet.offers);
    const uniqueId = packet.villager_unique_id != null ? String(packet.villager_unique_id) : null;
    if (uniqueId && this._entitiesByUnique.has(uniqueId)) {
      const runtimeId = this._entitiesByUnique.get(uniqueId);
      const entity = this.entities.get(runtimeId);
      if (entity && this.tradeDisplayName) entity.professionName = this.tradeDisplayName;
      this.tradeTarget = entity ? {
        type: entity.type,
        runtimeId: entity.runtimeId,
        uniqueId: entity.uniqueId,
        position: entity.position,
        distance: entity.position ? +this._entityDistance(entity).toFixed(1) : null,
      } : this.tradeTarget;
    }
    this.log('update_trade', {
      displayName: this.tradeDisplayName,
      tier: this.tradeTier,
      newUI: this.tradeNewUI,
      offers: this.tradeOffers.length,
      target: this.tradeTarget ? { type: this.tradeTarget.type, distance: this.tradeTarget.distance } : null,
    });
  }

  // Aggiorna lo specchio locale delle tre slot di trading da inventory_content.
  _trackTradeSlots (input) {
    const read = slot => {
      const item = input?.[slot];
      return item?.network_id ? {
        network_id: item.network_id,
        name: this._slotItemName(item),
        count: item.count,
        stack_id: item.stack_id ?? null,
      } : null;
    };
    this._tradeSlots = { ingredient1: read(0), ingredient2: read(1), result: read(2) };
    this.log('trade_content', {
      ingredient1: this._tradeSlots.ingredient1 ? `${this._tradeSlots.ingredient1.name}:${this._tradeSlots.ingredient1.count}` : '-',
      ingredient2: this._tradeSlots.ingredient2 ? `${this._tradeSlots.ingredient2.name}:${this._tradeSlots.ingredient2.count}` : '-',
      result: this._tradeSlots.result ? `${this._tradeSlots.result.name}:${this._tradeSlots.result.count}` : '-',
    });
  }

  // Aggiorna lo specchio locale da un inventory_slot della finestra di trading.
  _trackTradeSlot (containerId, slot, item) {
    if (!this._tradeWindowOpen()) return false;
    const containers = this._tradeSlotContainers();
    const key = containerId === containers.ingredient1 ? 'ingredient1'
      : containerId === containers.ingredient2 ? 'ingredient2'
      : containerId === containers.result ? 'result'
      : null;
    if (!key || slot !== 0) return false;
    this._tradeSlots[key] = item?.network_id ? {
      network_id: item.network_id,
      name: this._slotItemName(item),
      count: item.count,
      stack_id: item.stack_id ?? null,
    } : null;
    return true;
  }

  // Professione leggibile di un'entità trader: il display_name cacheato (fonte
  // autorevole) oppure la mappa best-effort su trading_career/mark_variant.
  _professionFor (entity) {
    if (!entity) return null;
    if (entity.professionName) return entity.professionName;
    for (const raw of [entity.career, entity.markVariant]) {
      const name = professionName(raw);
      if (name) return name;
    }
    return null;
  }

  // Entità commerciabili note, entro `limit` blocchi.
  _nearbyTraders (limit = 8) {
    const rows = [];
    for (const entity of this.entities.values()) {
      if (entity.kind !== 'mob' || !entity.position || !isTraderType(entity.type)) continue;
      const distance = this._entityDistance(entity);
      if (distance > 32) continue;
      rows.push({
        type: entity.type,
        runtimeId: entity.runtimeId,
        wandering: entity.type === 'wandering_trader',
        distance: +distance.toFixed(1),
        position: {
          x: +entity.position.x.toFixed(1),
          y: +entity.position.y.toFixed(1),
          z: +entity.position.z.toFixed(1),
        },
        tradeTier: entity.tradeTier ?? null,
        maxTradeTier: entity.maxTradeTier ?? null,
        profession: this._professionFor(entity),
        // Un villager cucciolo non apre il commercio: senza il flag non si
        // distingue "rifiuto" da "bersaglio sbagliato" (indagine 04/10/2026).
        baby: entity.baby ?? null,
        seenAt: entity.seenAt ?? null,
      });
    }
    rows.sort((a, b) => a.distance - b.distance);
    return rows.slice(0, limit);
  }

  _nearestTrader () {
    return this._nearbyTraders(1)[0] || null;
  }

  // Offerta soddisfacibile con l'inventario corrente (input 1 e, se presente, 2).
  _offerRequirementsMet (offer) {
    if (!offer) return false;
    if ((this.inventory[offer.buyA.item] || 0) < offer.buyA.count) return false;
    if (offer.buyB && (this.inventory[offer.buyB.item] || 0) < offer.buyB.count) return false;
    return true;
  }

  _offerDescription (offer, _index) {
    const cost = offer.buyB
      ? `${offer.buyA.count} ${offer.buyA.item} + ${offer.buyB.count} ${offer.buyB.item}`
      : `${offer.buyA.count} ${offer.buyA.item}`;
    const uses = offer.maxUses ? `, ${offer.maxUses - offer.uses} uses left` : '';
    const where = this.tradeTarget
      ? ` (${this.tradeTarget.type} ${this.tradeTarget.distance != null ? `${this.tradeTarget.distance} blocks away` : ''})`
      : '';
    const urgency = this.tradeTarget?.type === 'wandering_trader' ? ' — despawns soon!' : '';
    return `Trade ${cost} for ${offer.sell.count} ${offer.sell.item}${uses}${where}${urgency}`;
  }

  // `interact` con action_id 'npc_open': è il pacchetto con cui un client vanilla
  // apre la finestra di commercio di un villager. La cattura live su BDS 1.26.52
  // mostra che item_use_on_entity (action_type interact) da solo non la apre:
  // il server risponde con un resync dell'inventario, mai con container_open.
  _npcOpen (entity) {
    let target;
    try { target = BigInt(entity.runtimeId); } catch { return false; }
    this.client.write('interact', {
      action_id: 'npc_open',
      target_entity_id: target,
      has_position: false,
    });
    this.log('npc_open', { target: entity.type, runtimeId: entity.runtimeId, distance: +this._entityDistance(entity).toFixed(2) });
    return true;
  }

  // Transazione click_air vuota: serve solo ad alzare il flag item_interact
  // nel frame player_auth_input, senza usare nulla (mano vuota).
  _airUseTransaction () {
    return {
      legacy: { legacy_request_id: 0 },
      actions: [],
      data: {
        action_type: 'click_air',
        trigger_type: 'player_input',
        block_position: { x: 0, y: 0, z: 0 },
        face: 0,
        hotbar_slot: this.selectedHotbar,
        hand: 'main_hand',
        held_item: this.inventorySlots[this.selectedHotbar] || { network_id: 0 },
        player_pos: { ...this.position },
        click_pos: { x: 0.5, y: 0.5, z: 0.5 },
        block_runtime_id: 0,
        client_prediction: 'success',
        client_cooldown_state: 'off',
      },
    };
  }

  // item_use_on_entity con action_type interact: apre il commercio (mai attack).
  _interactEntity (entity) {
    const held = this.inventorySlots[this.selectedHotbar] || { network_id: 0 };
    let runtimeId;
    try { runtimeId = BigInt(entity.runtimeId); } catch { return false; }
    const centerY = entity.position.y + entityHeight(entity.type) * 0.5;
    this.client.write('inventory_transaction', {
      transaction: {
        legacy: { legacy_request_id: 0 },
        transaction_type: 'item_use_on_entity',
        actions: [],
        transaction_data: {
          entity_runtime_id: runtimeId,
          action_type: 'interact',
          hotbar_slot: this.selectedHotbar,
          held_item: held,
          player_pos: { ...this.position },
          click_pos: { x: entity.position.x, y: centerY, z: entity.position.z },
        },
      },
    });
    this.log('interact', { target: entity.type, runtimeId: entity.runtimeId, distance: +this._entityDistance(entity).toFixed(2) });
    return true;
  }

  // ---- sonda diagnostica delle interazioni entità (04/10/2026) ---------------
  // Misura live: il server risponde a ogni `item_use_on_entity` standalone
  // (attacco e interact) con un resync di `inventory_content` e con **nessun**
  // effetto nel mondo (9 colpi su un pig senza un punto di danno, nessuna
  // `container_open`/`update_trade` dal villager). La distanza, il runtime id e
  // il nome del campo di `interact` sono già esclusi. Questa sonda prova in
  // sequenza le forme candidate e riporta l'esito **osservabile**: per un mob il
  // delta di vita, per un villager l'apertura della finestra; il discriminante
  // del rifiuto è il contatore dei resync (`resyncs > 0` ⇒ transazione rifiutata).
  // `legacy` è **obbligatorio** nello schema 1.26.51 (`TransactionLegacy` non è
  // dietro un `option`): ometterlo non è nemmeno serializzabile (`SizeOf error
  // for undefined : reading 'legacy_request_id'`), quindi la variante che il
  // riferimento ometteva non esiste in questa versione — si prova invece la
  // lista legacy esplicitamente vuota, che cambia i byte (0x01 0x00 contro 0x00).
  static PROBE_VARIANTS = ['none', 'current', 'legacy_minus1', 'legacy_empty_list', 'numeric_type', 'animate_first', 'eyes', 'flag_before', 'flag_after', 'hotbar', 'item_in_hand', 'legacy_seq', 'click_low', 'mouse_over'];

  _entityTransactionPayload (entity, action, variant) {
    const held = this.inventorySlots[this.selectedHotbar] || { network_id: 0 };
    const runtimeId = BigInt(entity.runtimeId);
    const centerY = isEndermanType(entity.type)
      ? endermanAimPoint(entity.position).y
      : entity.position.y + entityHeight(entity.type) * 0.5;
    const eyes = this.position || { x: 0, y: 0, z: 0 };
    const feet = this._feet || { ...eyes, y: eyes.y - EYE_HEIGHT };
    // `eyes`: il client vanilla manda la posizione degli occhi (`player_pos`),
    // non i piedi (riferimento `mineflayer-for-bedrock/lib/plugins/vehicles.js`).
    const playerPos = variant === 'eyes' ? { ...eyes } : { ...feet };
    const payload = {
      transaction_type: variant === 'numeric_type' ? 3 : 'item_use_on_entity',
      actions: [],
      transaction_data: {
        entity_runtime_id: runtimeId,
        action_type: action,
        hotbar_slot: this.selectedHotbar,
        held_item: held,
        player_pos: playerPos,
        click_pos: { x: entity.position.x, y: centerY, z: entity.position.z },
      },
    };
    if (variant === 'legacy_empty_list') payload.legacy = { legacy_request_id: 0, legacy_transactions: [] };
    // `legacy_seq`: il client vanilla manda un `legacy_request_id` che **cresce**
    // a ogni transazione e il server lo usa per accoppiare transazione e
    // correzione; un id sempre a 0 può far scartare la transazione come duplicato
    // (l'ipotesi dietro il resync d'inventario che osserviamo a ogni interact).
    else if (variant === 'legacy_seq') payload.legacy = { legacy_request_id: (this._legacySeq = (this._legacySeq ?? 0) + 1) };
    else payload.legacy = { legacy_request_id: variant === 'legacy_minus1' ? -1 : 0 };
    // `click_low`: punto di click sul bacino invece del centro del corpo — serve a
    // escludere che il server scarti l'interazione perché il click cade fuori
    // dall'hitbox (se le posizioni entità fossero salvate a un'altezza diversa).
    if (variant === 'click_low') payload.transaction_data.click_pos.y = entity.position.y + 0.3;
    return { payload, runtimeId };
  }

  // Bersaglio della sonda: qui NON si usa `_entityOfType` (che copre solo ostili
  // e animali da fattoria) perché la sonda serve soprattutto sui villager, che
  // non sono né l'uno né l'altro. Si può indicare il runtime id esatto (il
  // villager visto in `/observe.traders`) oppure il tipo, scegliendo il più vicino.
  _probeTarget ({ type = null, runtimeId = null } = {}) {
    if (runtimeId != null) return this.entities.get(String(runtimeId)) || null;
    if (!type) return null;
    const wanted = normalizeEntityType(type);
    const rows = [];
    for (const entity of this.entities.values()) {
      if (!entity?.position || typeof entity.type !== 'string') continue;
      if (normalizeEntityType(entity.type) !== wanted) continue;
      rows.push(entity);
    }
    rows.sort((a, b) => this._entityDistance(a) - this._entityDistance(b));
    return rows[0] || null;
  }

  async probeInteract ({ type = 'pig', action = 'interact', variant = 'current', runtimeId = null, observeMs = 2500, approach = false, interactionModel = null, interactRotation = null } = {}) {
    if (!this.client) return { ok: false, error: 'connection_lost' };
    if (!BedrockAdapter.PROBE_VARIANTS.includes(variant)) return { ok: false, error: 'unknown_variant', variants: BedrockAdapter.PROBE_VARIANTS };
    const entity = this._probeTarget({ type, runtimeId });
    if (!entity) return { ok: false, error: 'no_entity', type, runtimeId };
    const before = {
      health: entity.health ?? null,
      resyncs: this._invResyncCount,
      container: this._openContainer ? `${this._openContainer.type}:${this._openContainer.id}` : null,
      offers: this.tradeOffers.length,
      distance: +this._entityDistance(entity).toFixed(2),
    };
    const probeClient = this.client;
    const rxNames = {};
    const capturePacket = (des) => {
      const name = des?.data?.name;
      if (name) rxNames[name] = (rxNames[name] || 0) + 1;
    };
    probeClient.on('packet', capturePacket);
    try {
      const sequence = [];
      // `approach`: un bersaglio a più di 3 blocchi non è una prova valida (la
      // portata dell'interazione è ~4-5 blocchi, e una linea di vista ostruita fa
      // scartare l'interazione): la sonda cammina a 2 blocchi prima di provare.
      if (approach && before.distance > 3) {
        try {
          await this._moveTo(entity.position, 2.0, 12000);
          sequence.push(`approach (${before.distance} -> ${this._entityDistance(this.entities.get(String(entity.runtimeId)) || entity).toFixed(1)})`);
        } catch (error) {
          sequence.push(`approach_failed:${error.message}`);
        }
      }
      // Il client vanilla guarda sempre il bersaglio prima di usarlo: senza questa
      // rotazione il server può scartare l'interazione (l'ultima posizione nota
      // della testa era un'altra). Si registra anche la linea di vista, campionata
      // sui blocchi, per distinguere "il bersaglio non è visibile" da "la
      // transazione è sbagliata".
      const after = this.entities.get(String(entity.runtimeId)) || entity;
      const look = this._lookAt({ x: after.position.x, y: after.position.y + entityHeight(after.type) * 0.5, z: after.position.z });
      // `interactionModel`: il bot dichiara `touch` (il valore storico), ma un
      // client PC manda `crosshair`/`classic`. Se è quel campo a decidere se un
      // "uso" apre un contenitore o monta l'animale, questa opzione lo dimostra.
      const frame = { yaw: look.yaw, pitch: look.pitch };
      if (interactionModel) frame.interactionModel = interactionModel;
      if (interactRotation) frame.interactRotation = interactRotation;
      await this._queueAuthInput(frame);
      await delay(120);
      if (interactionModel) sequence.push(`interaction_model ${interactionModel}`);
      sequence.push('player_auth_input (yaw/pitch sul bersaglio)');
      const eye = this.position;
      const aimPoint = { x: after.position.x, y: after.position.y + entityHeight(after.type) * 0.5, z: after.position.z };
      const sightline = [];
      for (let i = 1; i <= 3; i++) {
        const t = i / 4;
        const b = this.world.blockAt({
          x: Math.floor(eye.x + (aimPoint.x - eye.x) * t),
          y: Math.floor(eye.y + (aimPoint.y - eye.y) * t),
          z: Math.floor(eye.z + (aimPoint.z - eye.z) * t),
        });
        sightline.push(b ? `${b.name}${this._passable(b) ? '' : '!'}` : 'null');
      }
      if (variant === 'hotbar') {
        this._selectHotbarSlot(0, { allowEmpty: true });
        sequence.push('mob_equipment slot 0');
      }
      if (variant === 'item_in_hand') {
        // Il 03/10 l'unico interact riuscito live (`milk_cow`) era fatto **con un
        // oggetto in mano** (il secchio). Questa variante mette in mano il primo
        // oggetto della hotbar: se `held_item` vuoto è ciò che il server rifiuta,
        // qui il resync deve sparire.
        const slot = this.inventorySlots.findIndex((s, i) => i < 9 && s?.network_id);
        if (slot >= 0 && this._selectHotbarSlot(slot)) sequence.push(`mob_equipment slot ${slot} (${this._slotItemName(this.inventorySlots[slot])})`);
        else sequence.push('nessun oggetto in hotbar');
      }
      if (variant === 'mouse_over') {
        // Il client tiene aggiornato il bersaglio sotto il mirino con
        // `interact {mouse_over_entity}`: se il server accetta l'apertura solo per
        // l'entità che il client dichiara di guardare, questa variante la prepara.
        this.client.write('interact', {
          action_id: 'mouse_over_entity',
          target_entity_id: BigInt(entity.runtimeId),
          has_position: false,
        });
        sequence.push('interact mouse_over_entity');
      }
      if (variant === 'animate_first') {
        this.client.write('animate', { action_id: 'swing_arm', runtime_entity_id: this.client.entityId, data: 0, has_swing_source: false });
        sequence.push('animate swing_arm');
      }
      if (variant === 'flag_before') {
        await this._queueAuthInput({ yaw: this._lastYaw ?? 0, pitch: look.pitch, itemInteract: true });
        sequence.push('player_auth_input item_interact');
      }
      const entity2 = this.entities.get(String(entity.runtimeId)) || entity;
      const { payload } = this._entityTransactionPayload(entity2, action, variant);
      // `none` non spedisce nulla: è la misura di riferimento per capire se i
      // `inventory_content` che seguono sono davvero una reazione alla transazione
      // o un sincronismo periodico del server.
      if (variant !== 'none') {
        this.client.write('inventory_transaction', { transaction: payload });
        sequence.push(`inventory_transaction ${variant}`);
      } else {
        sequence.push('niente (misura di riferimento)');
      }
      if (variant === 'flag_after') {
        await this._queueAuthInput({ yaw: this._lastYaw ?? 0, pitch: look.pitch, itemInteract: true });
        sequence.push('player_auth_input item_interact (dopo)');
      }
      await delay(observeMs);
      const later = this.entities.get(String(entity.runtimeId));
      const healthAfter = later?.health ?? null;
      return {
        ok: true,
        type: entity.type,
        runtimeId: entity.runtimeId,
        look: { yaw: +look.yaw.toFixed(1), pitch: +look.pitch.toFixed(1) },
        sightline,
        action,      variant,
        sequence,
        observeMs,
        distance: before.distance,
        hand: this.inventorySlots[this.selectedHotbar]?.network_id ? 'item' : 'empty',
        heldName: this.inventorySlots[this.selectedHotbar]?.network_id ? this._slotItemName(this.inventorySlots[this.selectedHotbar]) : null,
        selectedHotbar: this.selectedHotbar,
        healthBefore: before.health,
        healthAfter,
        damage: before.health != null && healthAfter != null ? before.health - healthAfter : null,
        resyncs: this._invResyncCount - before.resyncs,
        rxNames,
        containerBefore: before.container,
        containerAfter: this._openContainer ? `${this._openContainer.type}:${this._openContainer.id}` : null,
        offersBefore: before.offers,
        offersAfter: this.tradeOffers.length,
        interactionModel: interactionModel || 'touch',
        variantCount: BedrockAdapter.PROBE_VARIANTS.length,
      };
    } finally {
      probeClient.removeListener('packet', capturePacket);
    }
  }

  // Si avvicina al trader più vicino e apre il commercio; attende le offerte.
  async _openTrade (opts) {
    const trader = this._nearestTrader();
    if (!trader) return { ok: false, error: 'no_trader_nearby' };
    if (this.tradeOpenedAt && Date.now() - this.tradeOpenedAt < this._tradeTTLMs() && this._tradeWindowOpen() && this.tradeOffers.length) {
      return { ok: true, alreadyOpen: true, offers: this.tradeOffers.length, trader: trader.type };
    }
    const entity = this.entities.get(trader.runtimeId);
    if (!entity) return { ok: false, error: 'trader_gone' };
    return this._openTradeWithEntity(entity, opts);
  }

  // Apre il commercio con un'entità trader specifica (usata anche dal livellamento
  // per scegliere il commerciante giusto, non solo il più vicino).
  async _openTradeWithEntity (entity, { approachTimeoutMs = 25000, confirmMs = 4000 } = {}) {
    // Con PACKET_DEBUG=1 la cattura parte prima dell'interact: così si vede se
    // il server risponde con container_open/update_trade o con un rifiuto.
    this._armPacketDebug(20000);
    // Chiudi un commercio/container precedente prima di aprirne un altro.
    if (this._openContainer) await this._closeContainer().catch(() => {});
    this.tradeOffers = [];
    this.tradeOpenedAt = 0;
    this.tradeTarget = { type: entity.type, runtimeId: entity.runtimeId, position: entity.position };
    if (this._entityDistance({ ...entity, type: entity.type }) > TRADE_APPROACH_RANGE) {
      try {
        await this._moveTo(entity.position, 2.0, approachTimeoutMs);
      } catch (error) {
        this.log('trade_approach_failed', { message: error.message, trader: entity.type });
      }
    }
    const live = this.entities.get(entity.runtimeId);
    if (!live) return { ok: false, error: 'trader_gone' };
    const distance = this._entityDistance(live);
    if (distance > 5) return { ok: false, error: 'trader_unreachable', distance: +distance.toFixed(1) };
    this.tradeTarget = { type: live.type, runtimeId: live.runtimeId, position: live.position, distance: +distance.toFixed(1) };
    let hand = null;
    for (let attempt = 1; attempt <= 3 && !this.tradeOffers.length; attempt++) {
      // Il villager cammina mentre si tenta: portata e linea di vista vanno
      // riverificate a ogni tentativo, altrimenti i tre tentativi colpiscono un
      // bersaglio già lontano (evidenza live 04/10/2026: il villager è passato da
      // 2,1 a 5,1 blocchi durante i 12 s dei tentativi).
      let current = this.entities.get(String(entity.runtimeId));
      if (!current) return { ok: false, error: 'trader_gone', trader: entity.type };
      if (this._entityDistance(current) > TRADE_APPROACH_RANGE) {
        try { await this._moveTo(current.position, 2.0, Math.min(approachTimeoutMs, 8000)); } catch (error) { this.log('trade_approach_failed', { message: error.message, trader: current.type, attempt }); }
        const moved = this.entities.get(String(entity.runtimeId));
        if (!moved) return { ok: false, error: 'trader_gone', trader: entity.type };
        if (this._entityDistance(moved) > 5) {
          return { ok: false, error: 'trader_moved_away', trader: moved.type, distance: +this._entityDistance(moved).toFixed(1), attempts: attempt };
        }
        current = moved;
      }
      const tradeVisibility = this._entityVisible(current);
      if (!tradeVisibility.visible) {
        this.log('trade_target_blocked', { trader: current.type, distance: +this._entityDistance(current).toFixed(1), blockedBy: tradeVisibility.blockedBy, at: tradeVisibility.blockedAt, attempt });
        return {
          ok: false,
          error: 'trade_target_blocked',
          hint: 'the line of sight to the villager is blocked',
          trader: current.type,
          blockedBy: tradeVisibility.blockedBy,
          distance: +this._entityDistance(current).toFixed(1),
        };
      }
      // Mano libera e niente sneak: come per il mount, attrezzo in mano o sneak
      // cambiano ramo dell'interazione (evidenza live 04/10/2026). Solo **dopo**
      // il gate: un villager dietro un muro non deve ricevere nemmeno un
      // cambiamento di mano (test 04/10/2026).
      hand = this._freeHands('trade');
      const look = this._lookAt({ x: current.position.x, y: current.position.y + entityHeight(current.type) * 0.5, z: current.position.z });
      await this._queueAuthInput({ yaw: look.yaw, pitch: look.pitch });
      await delay(120);
      const after = this.entities.get(String(entity.runtimeId));
      if (!after) continue;
      current = after;
      // Primo tentativo col pacchetto del client vanilla (`npc_open`); i
      // tentativi successivi aggiungono item_use_on_entity come fallback.
      this._npcOpen(current);
      // In modalità server-autoritativa il server prende in carico l'interazione
      // con l'entità solo se un frame player_auth_input alza il flag item_interact
      // (input_data 34): un click_air è il modo minimo per farlo (mano vuota,
      // nessun effetto sul mondo).
      if (attempt > 1) await this._queueAuthInput({ yaw: look.yaw, pitch: look.pitch, transaction: this._airUseTransaction() });
      if (attempt > 1) this._interactEntity(current);
      const waitUntil = Date.now() + confirmMs;
      while (Date.now() < waitUntil && !this.tradeOffers.length) await delay(100);
    }
    if (!this.tradeOffers.length) {
      // Diagnosi: con PACKET_DEBUG=1 registra i pacchetti che il server manda
      // nei secondi successivi all'interact, così si distingue "il server non
      // apre la finestra" da "il client non riconosce il pacchetto di apertura".
      if (this._armPacketDebug(15000)) this.log('packet_debug_armed', { reason: 'trade_not_opened', trader: live.type, distance: +distance.toFixed(1) });
      return { ok: false, error: 'trade_not_opened', hint: 'villager busy, obstructed or not a trader', attempts: 3, distance: +distance.toFixed(1), hand };
    }
    return { ok: true, opened: true, offers: this.tradeOffers.length, trader: live.type, displayName: this.tradeDisplayName };
  }

  // Sposta `count` item `itemName` dall'inventario nella slot di input di trading.
  async _putInTradeSlot (slotKey, itemName, count) {
    const containers = this._tradeSlotContainers();
    const container = containers[slotKey];
    const index = this.inventorySlots.findIndex(s => this._slotItemName(s) === itemName && (s.count || 0) >= count);
    if (index < 0) throw new Error('missing_ingredients');
    const item = this.inventorySlots[index];
    const info = this._invSlotAsSource(index);
    const take = await this._sendStackRequest([{
      type_id: 'take', legacy_type_id: 0, count,
      source: this._slotInfo(info.container, info.slot, item.stack_id || 0),
      destination: this._slotInfo('cursor', 0, 0),
    }]);
    if (String(take.status) !== 'ok' && take.status !== 0) throw new Error(`take_failed_${take.status}`);
    this._applyStackResponse(take);
    const cursorStack = this._responseSlotStack(take, 'cursor', 0) ?? 0;
    const current = this._tradeSlots[slotKey];
    const place = await this._sendStackRequest([{
      type_id: 'place', legacy_type_id: 1, count,
      source: this._slotInfo('cursor', 0, cursorStack),
      destination: this._slotInfo(container, 0, current?.stack_id || 0),
    }]);
    if (String(place.status) !== 'ok' && place.status !== 0) throw new Error(`place_failed_${place.status}`);
    this._applyStackResponse(place, { networkId: item.network_id });
    this._cursor = null;
    this._tradeSlots[slotKey] = {
      network_id: item.network_id, name: itemName, count,
      stack_id: this._responseSlotStack(place, container, 0) ?? current?.stack_id ?? 0,
    };
    this.log('trade_put', { slot: slotKey, container, item: itemName, count, status: place.status });
  }

  // Preleva il risultato (se presente) e lo porta in inventario.
  async _takeTradeResult () {
    const containers = this._tradeSlotContainers();
    const result = this._tradeSlots.result;
    if (!result?.network_id) return null;
    const count = result.count || 1;
    const take = await this._sendStackRequest([{
      type_id: 'take', legacy_type_id: 0, count,
      source: this._slotInfo(containers.result, 0, result.stack_id || 0),
      destination: this._slotInfo('cursor', 0, 0),
    }]);
    if (String(take.status) !== 'ok' && take.status !== 0) throw new Error(`take_failed_${take.status}`);
    this._applyStackResponse(take, { networkId: result.network_id });
    this._cursor = { network_id: result.network_id, name: result.name, count, stack_id: this._responseSlotStack(take, 'cursor', 0) ?? result.stack_id ?? 0 };
    const returned = await this._returnCursorToInventory();
    if (!returned) throw new Error('output_return_failed');
    this._tradeSlots.result = null;
    return { name: result.name, count };
  }

  // Attende che il server popoli la slot risultato dopo aver piazzato gli input.
  async _waitTradeResult (timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this._tradeSlots.result?.network_id) return { ...this._tradeSlots.result };
      await delay(250);
    }
    return null;
  }

  // Esegue lo scambio `index` (0-based) con l'offerta esposta in /observe.
  async _tradeAt (index, { timeoutMs = 20000 } = {}) {
    const offer = this.tradeOffers[index];
    if (!offer) return { ok: false, error: 'no_trade_offer', index };
    if (!this._tradeWindowOpen()) return { ok: false, error: 'trade_not_open' };
    if (!this._offerRequirementsMet(offer)) return { ok: false, error: 'missing_ingredients' };
    const before = { ...this.inventory };
    const started = Date.now();
    try {
      // Residui di uno scambio precedente rimasti nella finestra.
      if (this._tradeSlots.result?.network_id) await this._takeTradeResult();
      await this._putInTradeSlot('ingredient1', offer.buyA.item, offer.buyA.count);
      if (offer.buyB) await this._putInTradeSlot('ingredient2', offer.buyB.item, offer.buyB.count);
      // Il budget dello scambio è quello del chiamante: il tempo residuo
      // (non un 5 s fisso) è quanto si aspetta la slot risultato dal server.
      const remaining = Math.max(500, started + timeoutMs - Date.now());
      let result = await this._waitTradeResult(remaining);
      if (!result) return { ok: false, error: 'trade_result_timeout', offer, hint: 'server did not report the trade result slot' };
      const taken = await this._takeTradeResult();
      // Gli input sono stati consumati dal server: lo specchio locale va azzerato
      // per non riusare stack_id stantii nello scambio successivo.
      this._tradeSlots.ingredient1 = null;
      this._tradeSlots.ingredient2 = null;
      await delay(150);
      this._refreshInventory();
      const consumedA = (before[offer.buyA.item] || 0) - (this.inventory[offer.buyA.item] || 0);
      const consumedB = offer.buyB ? (before[offer.buyB.item] || 0) - (this.inventory[offer.buyB.item] || 0) : 0;
      const gained = (this.inventory[offer.sell.item] || 0) - (before[offer.sell.item] || 0);
      return {
        ok: true,
        trade: `${offer.buyA.count} ${offer.buyA.item}${offer.buyB ? ` + ${offer.buyB.count} ${offer.buyB.item}` : ''} → ${offer.sell.count} ${offer.sell.item}`,
        received: taken?.count ?? result.count ?? offer.sell.count,
        consumedA, consumedB, gained,
        ms: Date.now() - started,
      };
    } catch (error) {
      return { ok: false, error: error.message, offer };
    } finally {
      await this._returnCursorToInventory().catch(() => {});
      this._refreshInventory();
    }
  }

  // ---- livellamento di un commerciante (maxxing) -----------------------------------

  _currentTraderTier () {
    const entity = this.tradeTarget ? this.entities.get(this.tradeTarget.runtimeId) : null;
    const tier = this.tradeTier ?? entity?.tradeTier ?? 0;
    return Number.isInteger(Number(tier)) ? Number(tier) : 0;
  }

  _traderMaxTier () {
    const entity = this.tradeTarget ? this.entities.get(this.tradeTarget.runtimeId) : null;
    const maxTier = entity?.maxTradeTier ?? 4; // master è il massimo vanilla
    return Number.isInteger(Number(maxTier)) ? Number(maxTier) : 4;
  }

  // Loop deterministico sul commerciante aperto: ripete l'offerta più economica
  // disponibile finché il tier non raggiunge il massimo o scade il budget.
  async _levelCurrentTrader ({ maxTrades, deadline }) {
    const started = Date.now();
    const maxTier = this._traderMaxTier();
    let trades = 0;
    while (trades < maxTrades && Date.now() < deadline) {
      const tier = this._currentTraderTier();
      if (tier >= maxTier) {
        return { ok: true, maxed: true, tier, maxTier, trades, ms: Date.now() - started };
      }
      // Solo offerte economiche (mai smeraldi né risorse preziose come input):
      // la scelta ponderata resta qui, nel harness, non delegata al modello.
      const offer = pickBestTrade(this.tradeOffers, this.inventory);
      if (!offer) {
        return {
          ok: false,
          error: 'no_economical_trade',
          tier,
          maxTier,
          trades,
          ms: Date.now() - started,
          hint: 'all cheap trades used up (restock at workstation needed) or no cheap materials in inventory',
        };
      }
      const index = this.tradeOffers.indexOf(offer);
      const res = await this._tradeAt(index);
      if (!res.ok) {
        return { ok: false, error: res.error, tier, maxTier, trades, ms: Date.now() - started };
      }
      trades++;
      if (offer.maxUses) offer.uses = (offer.uses || 0) + 1; // aggiorna lo specchio locale
      await delay(150);
    }
    const tier = this._currentTraderTier();
    return {
      ok: true,
      maxed: tier >= maxTier,
      tier,
      maxTier,
      trades,
      ms: Date.now() - started,
      budgetExhausted: trades >= maxTrades,
    };
  }

  // Livella un commerciante (per professione o il più vicino) fino al tier massimo.
  // Il mercante itinerante non ha livelli: viene escluso.
  async _levelTrader ({ profession = null, maxTrades = 30, maxTimeMs = 180000 } = {}) {
    const wanted = profession ? normalizeProfession(profession) : null;
    const reachableOnly = this._reachabilityUsable();
    const all = this._nearbyTraders(12).filter(t => t.type !== 'wandering_trader');
    const candidates = reachableOnly ? all.filter(t => this.entityApproachable(t, { range: 3.5, dy: 2 })) : all;
    if (!candidates.length) return { ok: false, error: all.length ? 'trader_unreachable' : 'no_trader_nearby', profession: wanted };
    if (wanted) {
      // Ordina: prima i candidati la cui professione (cache o mappa) corrisponde,
      // poi quelli a professione ignota, poi gli altri; a parità, il più vicino.
      candidates.sort((a, b) => {
        const am = professionMatches(a.profession, wanted) ? 0 : (a.profession == null ? 1 : 2);
        const bm = professionMatches(b.profession, wanted) ? 0 : (b.profession == null ? 1 : 2);
        return am - bm || a.distance - b.distance;
      });
    }
    const deadline = Date.now() + maxTimeMs;
    for (const candidate of candidates) {
      if (Date.now() >= deadline) break;
      const entity = this.entities.get(candidate.runtimeId);
      if (!entity) continue;
      const opened = await this._openTradeWithEntity(entity);
      if (!opened.ok) continue;
      if (wanted && !professionMatches(this.tradeDisplayName, wanted)) {
        // La mappa metadata era inesatta: questo non è il commerciante cercato.
        await this._closeContainer().catch(() => {});
        continue;
      }
      const result = await this._levelCurrentTrader({ maxTrades, deadline });
      result.profession = this.tradeDisplayName || candidate.profession || null;
      result.trader = candidate.type;
      await this._closeContainer().catch(() => {});
      return result;
    }
    return { ok: false, error: 'no_matching_trader', profession: wanted };
  }

  // ---- bauli / botti / shulker -----------------------------------------------------

  _containerCacheKey (position) {
    return `${position.x},${position.y},${position.z}`;
  }

  _storageContainerSlotType (blockName) {
    return STORAGE_CONTAINER_SLOT[blockName] || 'container';
  }

  _isValuable (itemName) {
    return /(_ingot$|diamond$|emerald$|_ore$|^raw_|netherite|golden_|ender_pearl$|^experience)/.test(itemName);
  }

  // Un item che il bot tiene con sé mentre lavora: strumenti, equipaggiamento,
  // torce, sementi, stazioni portatili e cibo (fino alla riserva).
  _isKeptItem (itemName) {
    const name = String(itemName || '');
    if (!name) return false;
    if (DEPOSIT_KEEP_PATTERNS.some(pattern => pattern.test(name))) return true;
    return DEPOSIT_FOOD_ITEMS.has(name);
  }

  // Cosa è disposto a mettere via adesso: tutto ciò che non è nell'elenco di
  // rispetto, o che ne supera la riserva. Il raccolto di un ordine di fattoria
  // (`plan.farm.crop`) è esente dalla riserva: l'umano ha chiesto di metterlo
  // via, quindi né la politica del deposito né l'azione che la esegue possono
  // trattenerlo (altrimenti l'opzione `dump_inventory` verrebbe offerta e poi
  // rifiutata con `nothing_to_deposit`). L'esenzione si può passare a mano
  // (`exempt`) per i test. Nessun I/O e nessun pathfinding: la raggiungibilità
  // dello scrigno la decide chi offre l'azione.
  _depositableItems ({ reserve = DEPOSIT_KEEP_RESERVE, exempt = undefined } = {}) {
    const farmCrop = this.plan?.farm?.crop ?? null;
    const free = exempt === undefined
      ? new Set(farmCrop ? [farmCrop] : [])
      : new Set(exempt || []);
    const out = [];
    for (const [item, count] of Object.entries(this.inventory || {})) {
      const held = Number(count) || 0;
      if (held <= 0) continue;
      const kept = this._isKeptItem(item) && !free.has(item);
      if (kept && held <= reserve) continue;
      out.push({ item, count: kept ? held - reserve : held });
    }
    out.sort((a, b) => b.count - a.count);
    return out;
  }

  _samePosition (a, b) {
    if (!a || !b) return false;
    return Math.round(a.x) === Math.round(b.x)
      && Math.round(a.y) === Math.round(b.y)
      && Math.round(a.z) === Math.round(b.z);
  }

  // V1 — la *scoperta* di un contenitore: "qui c'è un baule", mai "dentro c'è
  // questo". `contentsKnown: false` non tocca gli archi `contains` né
  // `inspectedAt`, quindi un censimento non può cancellare quello che una
  // lettura precedente aveva imparato (V0, `rememberContainer`). Senza questo
  // scrittore il gradino 2 della scala (`containersToInspect`) restava vuoto:
  // l'unico writer era l'apertura (`_setContainerContents`).
  _rememberStorageDiscovery (block) {
    if (!this.memory || !block?.position || !block?.name) return false;
    if (!isStorageBlock(block.name)) return false;
    try {
      this.memory.rememberContainer({
        type: block.name,
        position: block.position,
        contentsKnown: false,
        source: 'discovered',
      });
      return true;
    } catch (error) {
      this.log('memory_error', { message: error.message });
      return false;
    }
  }

  // Censimento dei contenitori visibili: una passata sui blocchi di stoccaggio
  // nell'area caricata, ognuno registrato come *scoperta*. Throttled: camminare
  // non deve costare una riga per blocco (una scoperta vale 6 h, un minuto di
  // ri-scansione è abbondante).
  _surveyStorage ({ radius = STORAGE_DISCOVERY_RADIUS, force = false } = {}) {
    const now = Date.now();
    if (!force && now - (this._storageSurveyAt ?? 0) < STORAGE_DISCOVERY_RESCAN_MS) return this._storageSurvey;
    if (!this.spawned || !this.position || !this.memory) return this._storageSurvey;
    this._storageSurveyAt = now;
    const blocks = this._findNearbyStorageBlocks(radius);
    let discovered = 0;
    for (const block of blocks) if (this._rememberStorageDiscovery(block)) discovered += 1;
    this._storageSurvey = {
      at: now,
      radius,
      scanned: blocks.length,
      discovered,
      // Bounded: serve a `observe().storage`, non è un inventario.
      positions: blocks.slice(0, 8).map(b => ({ type: b.name, position: b.position })),
    };
    if (discovered) this.log('storage_discovered', { scanned: blocks.length, discovered, radius });
    return this._storageSurvey;
  }

  // La scala del deposito (V2) sui fatti del registro: il primo gradino è un
  // contenitore che *contiene già* l'item (accorpare una risorsa dove vive), il
  // secondo uno scoperto e mai aperto (un'apertura costa meno di un cammino
  // verso un posto ignoto). È una decisione, non una scansione: nessun accesso
  // al mondo e nessun pathfinding oltre il filtro di raggiungibilità; il
  // ripiego locale lo sceglie chi chiama.
  _storageSearchPlan (itemName, { position = null, memory = true, from = null } = {}) {
    const usable = this._reachabilityUsable();
    const here = from ?? this.position ?? null;
    const admissible = row => Boolean(row?.position)
      && (!position || this._samePosition(row.position, position))
      && !this._inOpenFailureCooldown(row.position);
    const decorate = row => ({
      ...row,
      distance: this._pointDistance(row.position),
      reachable: !usable || this.approachReachable(row.position),
    });
    let known = [];
    let toInspect = [];
    if (memory && this.memory) {
      try {
        known = this.memory.containersWithItem(itemName, { from: here, includeStale: true });
        toInspect = this.memory.containersToInspect({ from: here, limit: 16 });
      } catch (error) {
        this.log('memory_error', { message: error.message });
      }
    }
    return planStorageSearch({
      item: itemName,
      known: known.filter(admissible).map(decorate),
      toInspect: toInspect.filter(admissible).map(decorate),
      // Il ripiego locale non è una riga di registro: `_depositTargetFor` lo
      // sceglie dopo, e nessuna ricognizione parte da un deposito.
      local: [],
      canSweep: false,
      verifyStale: true,
      from: here,
    });
  }

  // Il baule giusto per un item, risalendo la scala del registro prima di
  // guardare il mondo: (1) un contenitore *ricordato* che contiene già l'item,
  // (2) uno *scoperto e mai aperto*, (3) la cache runtime (letto negli ultimi
  // 5 minuti) e un blocco visibile adesso — quest'ultimo viene anche *scoperto*,
  // così il registro impara dove sono i bauli mentre il bot lavora.
  // Un bersaglio con `verify: true` è memoria stantia: l'apertura rilegge il
  // contenuto reale prima di dichiarare il deposito.
  _depositTargetFor (itemName = null, { position = null, cachedOnly = false, memory = true } = {}) {
    const wanted = c => !position || this._samePosition(c.position, position);
    const reachable = c => !this._reachabilityUsable() || this.approachReachable(c.position);
    const plan = this._storageSearchPlan(itemName, { position, memory });
    const chosen = plan.target;
    if (chosen) {
      const remembered = chosen.rung === STORAGE_RUNG.KNOWN_ITEM || chosen.rung === STORAGE_RUNG.INSPECT;
      const fromMemory = remembered
        ? this._rememberedStorage({ reachableOnly: false }).find(c => this._samePosition(c.position, chosen.position))
        : null;
      const fromCache = this._cachedContainers().find(c => this._samePosition(c.position, chosen.position));
      return {
        key: this._containerCacheKey(chosen.position),
        type: chosen.type || fromMemory?.type || fromCache?.type || 'chest',
        position: chosen.position,
        contents: { ...(fromMemory?.contents ?? fromCache?.contents ?? {}) },
        distance: chosen.distance ?? this._pointDistance(chosen.position),
        remembered,
        rung: chosen.rung,
        step: chosen.step,
        verify: chosen.verify === true,
        stale: chosen.stale === true,
        ladder: plan.ladder,
        reason: plan.reason,
      };
    }
    // Gradino 3 — la cache runtime (letta da poco) prima della scansione viva:
    // nessun I/O, ed è la stessa fonte che il deposito usava prima di V2. Un
    // contenitore appena fallito non si riprova per primo, ma resta l'ultima
    // spiaggia (stessa regola di `_rememberedStorage`).
    const cachedRows = this._cachedContainers().filter(c => wanted(c) && reachable(c));
    const freshRows = cachedRows.filter(c => !this._inOpenFailureCooldown(c.position));
    const cached = freshRows.length ? freshRows : cachedRows;
    if (cached.length) {
      const score = c => ((itemName && (c.contents?.[itemName] || 0) > 0) ? 100000 : 0) - (c.distance ?? 0);
      const best = [...cached].sort((a, b) => score(b) - score(a))[0];
      return { ...best, remembered: false, rung: STORAGE_RUNG.LOCAL, step: STORAGE_STEP.NONE, verify: false, stale: false, ladder: plan.ladder, reason: plan.reason };
    }
    if (cachedOnly) return null;
    const block = this._findNearbyStorageBlocks().filter(b => wanted(b) && reachable(b))[0];
    if (!block) return null;
    // Il baule che sto per aprire entra nel registro come *scoperta*: il
    // contenuto lo scriverà l'apertura (`_setContainerContents`).
    this._rememberStorageDiscovery(block);
    return {
      key: this._containerCacheKey(block.position),
      type: block.name,
      position: block.position,
      contents: {},
      distance: block.distance ?? this._pointDistance(block.position),
      remembered: false,
      rung: STORAGE_RUNG.LOCAL,
      step: STORAGE_STEP.REMEMBER,
      verify: false,
      stale: false,
      ladder: plan.ladder,
      reason: plan.reason,
    };
  }

  // Stato del deposito per observe(): quali item sono pronti e dove andrebbero.
  // Nessuna scansione del mondo (la raggiungibilità la verifica l'opzione): la
  // scala invece *sì*, perché il registro è memoria, non I/O — l'operatore deve
  // poter vedere se il bersaglio è ricordato o soltanto indovinato.
  _depositState () {
    const items = this._depositableItems();
    const target = items.length ? this._depositTargetFor(items[0].item, { cachedOnly: true }) : null;
    return {
      items,
      total: items.reduce((sum, entry) => sum + entry.count, 0),
      target: target
        ? {
            type: target.type,
            position: target.position,
            distance: target.distance ?? this._pointDistance(target.position),
            remembered: target.remembered === true,
            rung: target.rung ?? null,
            step: target.step ?? null,
            verify: target.verify === true,
            stale: target.stale === true,
          }
        : null,
      // Ogni gradino non vuoto della scala: "non c'è" va *provato* da una scala
      // vuota, non dedotto da un bersaglio mancante.
      ladder: target?.ladder ?? null,
      reason: target?.reason ?? null,
      at: Date.now(),
    };
  }

  // Il registro dei contenitori come lo vede l'operatore: `checked: false`
  // significa "non ho mai guardato" (diverso da "non c'è"), e la scala dice
  // quale gradino potrebbe rispondere. Solo memoria: nessuna scansione.
  _storageView () {
    let known = [];
    let toInspect = [];
    if (this.memory) {
      try {
        known = this.memory.findContainers({ contentsKnown: true, limit: 16 });
        toInspect = this.memory.containersToInspect({ limit: 16 });
      } catch (error) {
        this.log('memory_error', { message: error.message });
      }
    }
    return {
      checked: Boolean(this._storageSurveyAt),
      survey: this._storageSurvey ?? null,
      known: known.map(c => ({
        position: c.position,
        type: c.type,
        contains: { ...(c.contents ?? {}) },
        inspectedAt: c.inspectedAt ?? null,
        status: c.status,
      })),
      toInspect: toInspect.map(c => ({
        position: c.position,
        type: c.type,
        discoveredAt: c.discoveredAt ?? null,
        discoveryStale: c.discoveryStale === true,
        status: c.status,
      })),
    };
  }

  _findNearbyStorageBlocks (radius = 32) {
    if (!this.position || !this.world?.findBlocks) return [];
    const found = [];
    for (const name of STORAGE_BLOCKS) {
      found.push(...this.world.findBlocks(name, this.position, radius, STORAGE_SCAN_PER_NAME));
    }
    found.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
    return found;
  }

  // Contenitori noti, non scaduti, ordinati per distanza. La cache scade dopo
  // CONTAINER_TTL_MS perché altri giocatori possono cambiare le scorte.
  _cachedContainers () {
    const now = Date.now();
    const out = [];
    for (const [key, entry] of this.containers) {
      if (now - entry.readAt >= CONTAINER_TTL_MS) { this.containers.delete(key); continue; }
      out.push({ key, ...entry, distance: this._pointDistance(entry.position) });
    }
    out.sort((a, b) => a.distance - b.distance);
    return out;
  }

  _setContainerContents (entry, contents) {
    this.containers.set(entry.key, { type: entry.type, position: entry.position, readAt: Date.now(), contents });
    // Persisti l'osservazione nel WorldMemory: la cache runtime scade, la
    // memoria è storica (lastSeenAt/status) e sopravvive ai riavvii.
    if (this.memory) {
      try { this.memory.rememberContainer({ type: entry.type, position: entry.position, contents }); }
      catch (error) { this.log('memory_error', { message: error.message }); }
    }
  }

  _storageContentsFromSlots (slots) {
    const contents = {};
    for (const slot of slots || []) {
      if (!slot?.network_id) continue;
      const name = this._slotItemName(slot);
      if (!name) continue;
      contents[name] = (contents[name] || 0) + (slot.count || 0);
    }
    return contents;
  }

  // Un contenitore che non si è aperto poco fa costa fino a ~18 s ogni volta che lo si
  // riprova (cammino + tre tentativi di finestra): la lettura batch lo salta finché dura
  // il cooldown, come fa l'elenco delle opzioni.
  _inOpenFailureCooldown (position) {
    const failure = this._storageOpenFailures.get(this._containerCacheKey(position));
    return Boolean(failure) && Date.now() - failure.at < STORAGE_OPEN_FAILURE_MS;
  }

  // Il libro dei fallimenti di apertura: la finestra che non si apre è la voce più
  // cara di un `take_*` da memoria, e va ricordata (vedi `STORAGE_OPEN_FAILURE_MS`).
  async _ensureStorageOpen (target, options = {}) {
    const key = this._containerCacheKey(target.position);
    try {
      const result = await this._openStorageWindow(target, options);
      this._storageOpenFailures.delete(key);
      return result;
    } catch (error) {
      // Un cammino fallito non dice nulla del contenitore: il cooldown da dieci
      // minuti esiste perché una *memoria sbagliata* (il baule non è più lì)
      // smetta di costare un tentativo a ogni lettura. Live 08/10/2026 un
      // `movement timeout` verso i bauli della missione li nascondeva per dieci
      // minuti (`container_read_skipped` 17 volte) e li toglieva dalle opzioni,
      // mentre il cammino del tentativo dopo poteva riuscire.
      const approachFailure = /^(movement timeout|path_failed|stuck|no_progress|storage_unreachable)$|^no reachable /.test(error.message);
      if (approachFailure) {
        this.log('storage_approach_failure', {
          block: target.name, position: target.position, error: error.message,
          distance: Math.round(this._pointDistance(target.position) * 10) / 10,
          ...(error.details ? { details: error.details } : {}),
        });
      } else {
        this._storageOpenFailures.set(key, { at: Date.now(), error: error.message });
        this.log('storage_open_failure', {
          block: target.name, position: target.position, error: error.message,
          distance: Math.round(this._pointDistance(target.position) * 10) / 10,
          // Il dettaglio del fallimento di camminata (`from`, `position`, `pathNodes`,
          // `reachedWaypoints`, `progressed`) è già calcolato da `_moveTo`: senza
          // questo campo l'artefatto dice "movement timeout" e non *dove*.
          ...(error.details ? { details: error.details } : {}),
        });
      }
      throw error;
    }
  }

  // Il blocco che stiamo per cliccare deve essere noto al client: `blockAt` null
  // (sezione non caricata) fa scrivere `block_runtime_id: 0` — un blocco che il
  // server non ha — e un click su un blocco inesistente non produce nessun
  // errore, solo silenzio. Il pattern è quello del mining: si richiede la sezione
  // e si aspetta che torni (vedi la conferma del break in `_mineBlock`).
  async _ensureBlockKnown (position, name, { timeoutMs = 3000 } = {}) {
    const check = () => {
      const block = this.world?.blockAt?.(position) ?? null;
      if (!block) return { ok: false, error: 'block_unknown', block: null };
      if (name && block.name !== name) return { ok: false, error: 'block_mismatch', block };
      if (this.world.runtimeIdAt(position) == null) return { ok: false, error: 'block_unknown', block };
      return { ok: true, block };
    };
    let state = check();
    if (state.ok || !this.client?.queue) return state;
    const refreshed = state.error;
    this.world.refreshSection(this.client, position);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await delay(50);
      state = check();
      if (state.ok) break;
    }
    return { ...state, refreshed };
  }

  // Linea di vista campionata sui blocchi (come la sonda delle entità): dice se
  // il click è stato scartato perché c'era un muro in mezzo e non perché la
  // transazione era sbagliata.
  _sightlineTo (point, target = null) {
    const eye = this.position;
    if (!eye || !point) return [];
    const out = [];
    for (let i = 1; i <= 3; i++) {
      const t = i / 4;
      const cell = {
        x: Math.floor(eye.x + (point.x - eye.x) * t),
        y: Math.floor(eye.y + (point.y - eye.y) * t),
        z: Math.floor(eye.z + (point.z - eye.z) * t),
      };
      const block = this.world.blockAt(cell);
      // Il blocco bersaglio è solido: marcarlo come ostruzione direbbe che la
      // linea di vista è *sempre* bloccata (live 08/10/2026 il payload diceva
      // `sightline: ["air","chest!","chest!"]` su un baule a 1,8 blocchi, e la
      // lettura si ri-avvicinava a 1,5 per un muro che non c'era).
      const isTarget = !!target && cell.x === target.x && cell.y === target.y && cell.z === target.z;
      out.push(block ? `${block.name}${isTarget || this._passable(block) ? '' : '!'}` : 'null');
    }
    return out;
  }

  async _openStorageWindow (target, { contentTimeoutMs = 2000, walkTimeoutMs = 30000 } = {}) {
    const alreadyOpen = this._openContainer?.type === 'container' && this._openContainerBlock
      && this._openContainerBlock.position.x === target.position.x
      && this._openContainerBlock.position.y === target.position.y
      && this._openContainerBlock.position.z === target.position.z;
    if (alreadyOpen) return;
    if (this._openContainer) await this._closeContainer();
    // Un contenitore fuori dal componente calpestabile non si apre: il
    // pathfinding fallirebbe dopo 30 s. Meglio un errore tipizzato e subito.
    if (this._reachabilityUsable() && !this.approachReachable(target.position)) {
      throw new Error('storage_unreachable');
    }
    const centre = { x: target.position.x + 0.5, y: target.position.y + 0.5, z: target.position.z + 0.5 };
    const approach = stop => this._moveTo({ x: centre.x, y: target.position.y, z: centre.z }, stop, walkTimeoutMs);
    if ((target.distance ?? this._pointDistance(target.position)) > 3.5) {
      // Si cammina finché il contenitore non è *addosso*: le aperture che
      // falliscono stanno tutte fra 3,5 e 4,7 blocchi (live 08/10/2026), dove la
      // mano del bot non arriva più al blocco.
      await approach(2);
    }
    await delay(100);
    let lastError = null;
    const attempts = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      // Il blocco che stiamo per cliccare deve essere *noto* al client: con
      // `blockAt` null (sezione non caricata) il click dichiara
      // `block_runtime_id: 0`, e un click su un blocco che il server non ha non
      // produce nessun errore — solo silenzio e `container_open_timeout`.
      const known = await this._ensureBlockKnown(target.position, target.name);
      const runtimeId = this.world.runtimeIdAt(target.position);
      const detail = {
        attempt,
        position: target.position,
        distance: Math.round(this._pointDistance(target.position) * 10) / 10,
        feet: this._feet ? { x: Math.round(this._feet.x * 100) / 100, y: Math.round(this._feet.y * 100) / 100, z: Math.round(this._feet.z * 100) / 100 } : null,
        face: this._faceForBlock(target.position, this.position),
        runtimeId: runtimeId ?? null,
        blockAt: this.world.blockAt(target.position)?.name ?? null,
        held: this._slotItemName((this.inventorySlots ?? [])[this.selectedHotbar]) ?? null,
        sightline: this._sightlineTo(centre, target.position),
        openContainer: this._openContainer?.id ?? null,
      };
      if (!known.ok) {
        // Il blocco non è (ancora) noto al client: il click parte lo stesso — chi
        // decide è il server — ma il tentativo lo *dichiara*, perché un
        // `block_runtime_id` nullo/0 è una causa possibile di rifiuto silenzioso.
        this.log('container_unknown_block', { ...detail, error: known.error, refreshed: known.refreshed ?? null });
      }
      const unknown = known.ok ? null : { block: known.error, refreshed: known.refreshed ?? null };
      // La mano sbagliata è la prima causa di `container_open_timeout`:
      // - mano *vuota*: il client vanilla interagirebbe a mani nude, ma in questo
      //   harness l'unico interact riuscito live era *con un oggetto in mano* e il
      //   server risponde con un resync d'inventario quando `held_item` è vuoto
      //   (variante `item_in_hand` della sonda entità). Dal secondo tentativo la
      //   mano si riempie: così il log dice se è quello il rifiuto, invece di
      //   ripetere tre volte la stessa transazione.
      // - mano con un oggetto *usabile*: il click diventa «usa l'oggetto» e il
      //   contenitore non si apre mai. Live 08-09/10/2026: quaranta
      //   `container_open_timeout` su quaranta tentativi con `held: "egg"` e due
      //   letture riuscite su due appena la mano ha tenuto altro. Qui la mano si
      //   cambia *subito*, al primo tentativo.
      const slots = this.inventorySlots ?? [];
      const hand = slots[this.selectedHotbar];
      const heldBefore = this._slotItemName(hand) ?? null;
      const useItem = hand?.network_id ? isUseItemName(heldBefore) : false;
      if (useItem || (attempt > 1 && !hand?.network_id)) {
        // Prima uno slot con un oggetto *non* usabile, poi — se non c'è — uno
        // slot libero: la mano vuota è il ripiego, non la scelta.
        const usable = slots.findIndex((s, i) => i < 9 && s?.network_id && !isUseItemName(this._slotItemName(s)));
        const slot = usable >= 0 ? usable : slots.findIndex((s, i) => i < 9 && !s?.network_id);
        try {
          if (slot >= 0 && this._selectHotbarSlot(slot)) {
            detail.held = this._slotItemName(slots[slot]) ?? null;
            this.log('container_hand_selected', { slot, item: detail.held, why: useItem ? `use_item:${heldBefore}` : 'hand_empty' });
          }
        } catch (error) { this.log('container_hand_failed', { error: error.message }); }
      }
      const wait = this._waitForContainerOpen(p => p.window_type === 'container', 2500);
      const yaw = this._yawTo(this._feet, { x: centre.x, z: centre.z });
      const pitch = this._lookAt(centre).pitch;
      try {
        await this._queueAuthInput({ yaw, pitch, transaction: this._blockUseTransaction(target.position) });
        await wait;
      } catch (error) {
        lastError = error;
        this.log('container_open_attempt', { ...detail, error: error.message });
        attempts.push({ ...detail, error: error.message, ...(unknown || {}) });
        // Un click scartato con la vista ostruita si ritenta da più vicino: 1,5
        // blocchi è il passo che l'approccio a 2 lascia fuori.
        if (detail.sightline.some(entry => entry.endsWith('!'))) await approach(1.5).catch(() => {});
        await delay(300);
        continue;
      }
      this._openContainerBlock = { name: target.name, position: target.position };
      // La finestra è aperta ma il contenuto può arrivare dopo: senza attesa il
      // take legge slot vecchie e dichiara `item_not_in_container` su una cache
      // ancora piena. Se il contenuto non arriva si ritenta l'apertura.
      if (await this._waitForContainerContent(this._openContainer.id, contentTimeoutMs)) return;
      lastError = new Error('container_content_timeout');
      this.log('container_open_attempt', { ...detail, error: 'container_content_timeout' });
      attempts.push({ ...detail, error: 'container_content_timeout', ...(unknown || {}) });
      await this._closeContainer().catch(() => {});
      await delay(300);
    }
    const finalError = lastError || new Error(`${target.name}_not_opened`);
    // Il fallimento porta con sé *tentativo per tentativo* cosa il client credeva
    // di cliccare: senza questo l'artefatto dice «container_open_timeout» e non
    // perché il server non ha risposto.
    finalError.details = { ...(finalError.details || {}), block: target.name, position: target.position, attempts };
    this.log('container_open_failed', { block: target.name, position: target.position, error: finalError.message, attempts });
    throw finalError;
  }

  async _readContainers ({ budgetMs = STORAGE_READ_BUDGET_MS } = {}) {
    const all = this._findNearbyStorageBlocks();
    if (!all.length) return { ok: false, error: 'container_not_found' };
    // Salta i contenitori che il bot non può raggiungere (fuori dal componente
    // calpestabile): senza il filtro ogni blocco costa 30 s di move fallito.
    const usable = this._reachabilityUsable();
    const skipped = all.filter(b => this._inOpenFailureCooldown(b.position));
    const candidates = all.filter(b => !this._inOpenFailureCooldown(b.position));
    if (skipped.length) this.log('container_read_skipped', { blocks: skipped.map(b => ({ name: b.name, position: b.position })) });
    const blocks = usable ? candidates.filter(b => this.approachReachable(b.position)) : candidates;
    if (!blocks.length) {
      this.log('container_unreachable', { blocks: all.map(b => ({ name: b.name, position: b.position })) });
      return { ok: false, error: 'container_unreachable', containers: all.map(b => ({ type: b.name, position: b.position })) };
    }
    const started = Date.now();
    const considered = blocks.length;
    const batch = blocks.slice(0, STORAGE_READ_LIMIT);
    const read = [];
    let budgetExceeded = false;
    let attempted = 0;
    for (const block of batch) {
      // Il budget della lettura vale anche per il cammino: prima il tetto per
      // blocco si sommava agli altri, quindi otto bauli potevano superare di molto
      // il budget e sfiorare il watchdog dei 180 s. Almeno un contenitore viene
      // *tentato* — anche un fallimento costa un cammino — e poi il budget decide:
      // con la guardia su `read.length` una lettura in cui nessun baule si apriva
      // proseguiva oltre il budget, un blocco alla volta.
      const remaining = budgetMs - (Date.now() - started);
      if (attempted > 0 && remaining <= 0) { budgetExceeded = true; break; }
      attempted++;
      try {
        await this._ensureStorageOpen(block, { walkTimeoutMs: Math.max(1000, Math.min(STORAGE_READ_WALK_MS, remaining)) });
        const contents = this._storageContentsFromSlots(this._openContainerSlots);
        const key = this._containerCacheKey(block.position);
        this._setContainerContents({ key, type: block.name, position: block.position }, contents);
        read.push({ position: block.position, type: block.name, contents });
      } catch (error) {
        this.log('container_read_failed', { block: block.name, position: block.position, error: error.message });
      } finally {
        await this._closeContainer().catch(() => {});
      }
    }
    if (!read.length) return { ok: false, error: 'container_read_failed' };
    return { ok: true, read: read.length, containers: read, considered, truncated: considered > batch.length, budgetExceeded, ms: Date.now() - started };
  }

  // La cache runtime nasce da una lettura e scade con `CONTAINER_TTL_MS`; la memoria
  // dei contenitori invece sopravvive ai riavvii (una ventina di bauli in questo
  // mondo). `take_*` attinge a entrambe, e questo helper è il lato memoria: un
  // contenitore ricordato è un bersaglio solo se è raggiungibile (quando il modello
  // di raggiungibilità è utilizzabile), e l'azione poi lo rilegge sul posto.
  _rememberedStorage ({ limit = 64, reachableOnly = true } = {}) {
    let remembered = [];
    try { remembered = this.memory?.findContainers?.({ limit }) || []; }
    catch (error) { this.log('memory_error', { message: error.message }); return []; }
    const containers = remembered
      .filter(c => c?.position && Object.values(c.contents || {}).some(count => count > 0))
      .map(c => ({
        key: this._containerCacheKey(c.position),
        name: c.type || 'chest',
        type: c.type || 'chest',
        position: c.position,
        contents: { ...c.contents },
        distance: this._pointDistance(c.position),
        rememberedAt: c.lastSeenAt ?? null,
        remembered: true,
      }))
      .sort((a, b) => a.distance - b.distance);
    // La richiesta esplicita (un `/act`) accetta anche un contenitore appena fallito:
    // l'offerta no. Stessa regola di `_readContainers` per la raggiungibilità: il
    // filtro vale solo con un modello utilizzabile, altrimenti si è fail-open.
    if (!reachableOnly) return containers;
    const usable = this._reachabilityUsable();
    return containers.filter(c => {
      if (this._inOpenFailureCooldown(c.position)) return false;
      return !usable || this.approachReachable(c.position);
    });
  }

  _rememberedContainerFor (itemName, options = {}) {
    const declared = this._rememberedStorage({ ...options, reachableOnly: false })
      .filter(c => (c.contents[itemName] || 0) > 0);
    if (!declared.length) return null;
    const usable = this._reachabilityUsable();
    // Un contenitore che non si è aperto poco fa non si ritenta per primo, ma resta
    // l'ultima spiaggia: la richiesta esplicita non viene mai rifiutata a priori.
    const fresh = declared.filter(c => !this._inOpenFailureCooldown(c.position));
    const known = fresh.length ? fresh : declared;
    const entry = usable ? known.find(c => this.approachReachable(c.position)) || null : known[0];
    return { entry, known: declared.length, retrying: fresh.length === 0 };
  }

  async _takeFromContainer (itemName, { position = null, maxCount = 64 } = {}) {
    // Live 04/10/2026: l'opzione può essere stata generata da un contenitore in
    // memoria mentre la cache runtime non lo ha (riavvio, o TTL scaduto fra
    // l'offerta e l'esecuzione) — e viceversa la cache può essere stantia. Qui si
    // accetta entrambe le sorgenti e si rilegge sempre il contenitore sul posto.
    const allowed = c => !position || (c.position.x === position.x && c.position.y === position.y && c.position.z === position.z);
    let entry = this._cachedContainers().find(c => allowed(c) && (c.contents[itemName] || 0) > 0);
    let remembered = false;
    if (!entry) {
      const specified = position ? this._rememberedStorage({ reachableOnly: false }).find(c => allowed(c) && (c.contents[itemName] || 0) > 0) : null;
      const fromMemory = position ? (specified ? { entry: specified, known: 1, retrying: false } : null) : this._rememberedContainerFor(itemName);
      if (!fromMemory) return { ok: false, error: 'item_not_in_container' };
      // La memoria lo sa ma nessuno di quei bauli è raggiungibile ora: dirlo, invece
      // di negare che l'oggetto esista (la distinzione conta per chi legge l'esito).
      if (!fromMemory.entry) {
        return { ok: false, error: 'container_unreachable', hint: `${fromMemory.known} remembered container(s) hold ${itemName}, none is reachable now` };
      }
      entry = fromMemory.entry;
      remembered = true;
      if (fromMemory.retrying) this.log('container_take_retrying', { item: itemName, position: entry.position });
      this.log('container_take_remembered', {
        item: itemName, block: entry.type, position: entry.position,
        distance: Math.round(entry.distance * 10) / 10, rememberedAt: entry.rememberedAt,
      });
    }
    const before = this.inventory[itemName] || 0;
    const started = Date.now();
    try {
      await this._ensureStorageOpen(entry, remembered ? { walkTimeoutMs: STORAGE_TAKE_WALK_MS } : {});
      const slots = this._openContainerSlots || [];
      const slotIndex = slots.findIndex(s => this._slotItemName(s) === itemName && (s.count || 0) > 0);
      if (slotIndex < 0) {
        // La cache diceva di averlo ma il contenuto reale è cambiato: riallinea.
        this._setContainerContents(entry, this._storageContentsFromSlots(slots));
        return { ok: false, error: 'item_not_in_container' };
      }
      const slot = slots[slotIndex];
      const count = Math.max(1, Math.min(slot.count || 1, maxCount));
      const slotType = this._storageContainerSlotType(entry.type);
      // Il cursore deve essere vuoto *prima* del take: BDS rifiuta con status 50
      // (FailedToValidateDstSlot) un take verso un cursore che contiene già uno
      // stack, anche con lo stesso item (riprodotto live il 04/10/2026). Un place
      // fallito lascia il cursore sporco: qui si svuota o si fallisce tipizzato,
      // invece di incolpare il contenitore con un `take_failed_50` opaco.
      if (this._cursor?.count > 0 && !(await this._returnCursorToInventory())) throw new Error('cursor_busy');
      const take = await this._sendStackRequest([{
        type_id: 'take', legacy_type_id: 0, count,
        source: this._slotInfo(slotType, slotIndex, slot.stack_id || 0),
        destination: this._slotInfo('cursor', 0, 0),
      }]);
      if (String(take.status) !== 'ok' && take.status !== 0) throw new Error(`take_failed_${take.status}`);
      this._applyStackResponse(take, { networkId: slot.network_id });
      const returned = await this._returnCursorToInventory();
      if (!returned) throw new Error('take_return_failed');
      const contents = { ...entry.contents };
      contents[itemName] = (contents[itemName] || 0) - count;
      if (contents[itemName] <= 0) delete contents[itemName];
      this._setContainerContents(entry, contents);
      const after = this.inventory[itemName] || 0;
      this.log('container_take', { block: entry.type, position: entry.position, item: itemName, count, inventoryDelta: after - before });
      return { ok: true, item: itemName, count, from: entry.type, position: entry.position, inventoryDelta: after - before, ms: Date.now() - started, ...(remembered ? { remembered: true } : {}) };
    } catch (error) {
      return { ok: false, error: error.message };
    } finally {
      await this._returnCursorToInventory().catch(() => {});
      await this._closeContainer().catch(() => {});
      this._refreshInventory();
    }
  }

  // Quanto di un item gli slot del *server* dichiarano in mano al bot: è la
  // verità del deposito, non `this.inventory` (che somma anche la stima dei
  // pickup e può essere gonfiato — live 06/10: aggregato 5 diamanti, slot 2).
  _heldCount (itemName) {
    return this._slotsItemCount(this.inventorySlots, itemName);
  }

  _slotsItemCount (slots, itemName) {
    let count = 0;
    for (const slot of slots || []) {
      if (!slot?.network_id) continue;
      if (this._slotItemName(slot) === itemName) count += slot.count || 0;
    }
    return count;
  }

  // Conteggio di uno slot del contenitore *dal pacchetto di risposta* del server:
  // `_applyStackResponse` ignora i contenitori non-giocatore, quindi la finestra
  // aperta non si aggiorna da sola. Serve solo come indizio nel log: la prova del
  // deposito è la rilettura del baule, perché uno stack può dividersi su più slot
  // (un `place` di 64 su una pila da 4 riempie due slot) e il pacchetto non porta
  // il nome dell'item.
  _responseContainerSlotCounts (response) {
    const counts = [];
    for (const container of response?.containers || []) {
      const cid = container.slot_type?.container_id;
      if (!cid || cid === 'cursor' || cid === 'crafting_input') continue;
      if (cid === 'hotbar' || cid === 'inventory' || cid === 'hotbar_and_inventory') continue;
      for (const slot of container.slots || []) counts.push({ slot: Number(slot.slot), count: slot.count || 0 });
    }
    return counts;
  }

  // Rilettura del baule dopo il `place`: si riapre la finestra (l'`inventory_content`
  // è la fotografia fresca del mondo) e si conta l'item. È la prova del deposito:
  // `null` = non verificabile, e allora il deposito non si dichiara riuscito.
  async _storageItemCountAfter (target, itemName) {
    try {
      await this._closeContainer();
      await this._ensureStorageOpen(target);
      const stored = this._slotsItemCount(this._openContainerSlots || [], itemName);
      this.log('container_reread', { block: target.type, position: target.position, item: itemName, stored });
      return stored;
    } catch (error) {
      this.log('container_reread_failed', { block: target.type, position: target.position, item: itemName, message: error.message });
      return null;
    }
  }

  // Un bersaglio *ricordato* che non si apre non deve far fallire il deposito:
  // una sola rilettura dal mondo vivo, poi si riferisce l'errore vero della
  // destinazione scelta. L'apertura è la verifica della memoria stantia, quindi
  // "la verifica è fallita" e "non si è aperto" sono lo stesso caso.
  async _depositStackWithFallback (target, itemName, options = {}) {
    const result = await this._depositStackInto(target, itemName, options);
    if (result.ok) return result;
    // Uno stack id stantio (un pickup si è fuso con lo stack, o lo specchio è
    // vecchio dopo una riconnessione) fa rifiutare il take/place con 49/50 — e
    // con lo specchio vuoto l'item sembra sparito. La riconnessione riporta
    // l'`inventory_content` completo: un solo retry, poi l'errore vero.
    if (/^(missing_item|take_failed_(49|50)|place_failed_(49|50))$/.test(String(result.error))) {
      try {
        await this._resyncByReconnect();
      } catch (error) {
        this.log('inventory_resync_failed', { message: error.message });
        return result;
      }
      const retried = await this._depositStackInto(target, itemName, { ...options, base: null });
      if (retried.ok) return { ...retried, retriedAfterResync: true };
      return retried;
    }
    if (target.remembered !== true) return result;
    const fallback = this._depositTargetFor(itemName, { memory: false });
    if (!fallback || this._samePosition(fallback.position, target.position)) return result;
    // Il contenuto accumulato vale per il baule di prima: sul nuovo si riparte
    // dalla lettura reale degli slot.
    const retry = await this._depositStackInto(fallback, itemName, { ...options, base: null });
    return retry.ok ? { ...retry, retriedAfterStale: true } : result;
  }

  async _depositItem (itemName, { position = null } = {}) {
    const target = this._depositTargetFor(itemName, { position });
    if (!target) return { ok: false, error: 'container_not_found' };
    const result = await this._depositStackWithFallback(target, itemName);
    delete result.contents; // stato interno del baule: non serve all'azione
    return result;
  }

  // Una sola azione per svuotare lo zaino dei prodotti del lavoro (M3c): lo
  // scrigno si sceglie una volta (il più adatto all'item più grosso), poi si
  // scaricano gli stack a gruppi, ognuno verificato sul delta reale.
  async _dumpInventory ({ maxStacks = DEPOSIT_MAX_STACKS } = {}) {
    const planned = this._depositableItems();
    if (!planned.length) return { ok: false, error: 'nothing_to_deposit' };
    const target = this._depositTargetFor(planned[0].item);
    if (!target) return { ok: false, error: 'container_not_found' };
    const moved = [];
    let stacks = 0;
    // Il mirror della finestra è una fotografia di quando il baule si è aperto:
    // ricomporre il contenuto da lì a ogni stack perderebbe i precedenti. Il
    // contenuto accumulato viaggia quindi fra gli stack, e la cache lo riceve
    // coerente alla fine.
    let contents = null;
    for (const entry of planned) {
      while (stacks < maxStacks) {
        const held = this.inventory[entry.item] || 0;
        const keep = this._isKeptItem(entry.item) ? DEPOSIT_KEEP_RESERVE : 0;
        if (held <= keep) break;
        const result = await this._depositStackWithFallback(target, entry.item, {maxCount: held - keep, base: contents});
        if (!result.ok) {
          if (!moved.length) return result;
          this.log('container_dump_partial', { item: entry.item, error: result.error, moved: moved.length });
          break;
        }
        contents = result.contents;
        moved.push({ item: result.item, count: result.count });
        stacks += 1;
        // Nessun progresso sull'inventario: fermarsi invece di girare a vuoto.
        if ((this.inventory[entry.item] || 0) >= held) break;
      }
      if (stacks >= maxStacks) break;
    }
    if (!moved.length) return { ok: false, error: 'nothing_to_deposit' };
    const count = moved.reduce((sum, entry) => sum + entry.count, 0);
    this.log('container_dump', { block: target.type, position: target.position, stacks, items: moved, count });
    return { ok: true, into: target.type, position: target.position, items: moved, stacks, count };
  }

  // Uno stack: il cuore del deposito, condiviso da `deposit_<item>` e dal dump.
  // `maxCount` limita quanto sposta un singolo stack (la riserva personale),
  // `base` è il contenuto del baule già accertato (il dump accumula fra stack).
  async _depositStackInto (target, itemName, {maxCount = null, base = null} = {}) {
    const index = this.inventorySlots.findIndex(s => this._slotItemName(s) === itemName && (s.count || 0) > 0);
    if (index < 0) return { ok: false, error: 'missing_item' };
    const before = this.inventory[itemName] || 0;
    const beforeHeld = this._heldCount(itemName);
    const started = Date.now();
    try {
      await this._ensureStorageOpen(target);
      const slots = this._openContainerSlots || [];
      const beforeStored = this._slotsItemCount(slots, itemName);
      const slotType = this._storageContainerSlotType(target.type);
      const stackSize = this._itemStackSize(this.inventorySlots[index].network_id);
      // Destinazione: uno slot già occupato dallo stesso item (se c'è spazio) oppure il primo vuoto.
      let destSlot = slots.findIndex(s => this._slotItemName(s) === itemName && (s.count || 0) < stackSize);
      if (destSlot < 0) destSlot = slots.findIndex(s => !s?.network_id);
      if (destSlot < 0) throw new Error('container_full');
      const source = this.inventorySlots[index];
      const count = Math.min(source.count || 0, stackSize, maxCount ?? Infinity);
      const info = this._invSlotAsSource(index);
      const take = await this._sendStackRequest([{
        type_id: 'take', legacy_type_id: 0, count,
        source: this._slotInfo(info.container, info.slot, source.stack_id || 0),
        destination: this._slotInfo('cursor', 0, 0),
      }]);
      if (String(take.status) !== 'ok' && take.status !== 0) throw new Error(`take_failed_${take.status}`);
      this._applyStackResponse(take, { networkId: source.network_id });
      const cursorStack = this._responseSlotStack(take, 'cursor', 0) ?? 0;
      const existing = slots[destSlot];
      const place = await this._sendStackRequest([{
        type_id: 'place', legacy_type_id: 1, count,
        source: this._slotInfo('cursor', 0, cursorStack),
        destination: this._slotInfo(slotType, destSlot, existing?.stack_id || 0),
      }]);
      if (String(place.status) !== 'ok' && place.status !== 0) throw new Error(`place_failed_${place.status}`);
      this._applyStackResponse(place, { networkId: source.network_id });
      this._cursor = null;
      // Postcondizione sul mondo, non sulla previsione (M4): lo status `ok` delle
      // due richieste non basta. Live 06/10 il deposito fu dichiarato su un
      // contenuto previsto, con lo specchio gonfiato dai pickup e il baule mai
      // riletto — e la missione non aveva un prima/dopo da confrontare.
      const afterHeld = this._heldCount(itemName);
      const afterStored = await this._storageItemCountAfter(target, itemName);
      // Il baule è la prova del deposito e il calo degli slot del giocatore la
      // conferma quando il server li riporta (altrimenti il pacchetto del take
      // non ha parlato dell'inventario: lo specchio non fa testo).
      const playerReported = (take.containers || []).some(container => {
        const cid = container.slot_type?.container_id;
        return cid === 'hotbar' || cid === 'inventory' || cid === 'hotbar_and_inventory';
      });
      const heldOk = afterHeld <= beforeHeld - count || (!playerReported && afterHeld === beforeHeld);
      const storedOk = afterStored != null && afterStored >= beforeStored + count;
      if (!heldOk || !storedOk) {
        this.log('container_deposit_unverified', {
          block: target.type, position: target.position, item: itemName, count,
          before: { held: beforeHeld, stored: beforeStored },
          after: { held: afterHeld, stored: afterStored },
          expected: { held: beforeHeld - count, stored: beforeStored + count },
          takeStatus: take.status, placeStatus: place.status, playerReported,
          placeSlots: this._responseContainerSlotCounts(place),
        });
        return {
          ok: false, error: 'deposit_unverified', item: itemName, count, into: target.type, position: target.position,
          before: { held: beforeHeld, stored: beforeStored },
          after: { held: afterHeld, stored: afterStored },
          takeStatus: take.status, placeStatus: place.status,
          hint: 'the server accepted the stack requests, but the chest read-back does not show the deposit',
        };
      }
      // Contenuto del baule dal registro del server appena riletto (non dalla cache,
      // che può essere stantia).
      const contents = base ? {...base} : this._storageContentsFromSlots(this._openContainerSlots);
      contents[itemName] = afterStored;
      this._setContainerContents(target, contents);
      const after = this.inventory[itemName] || 0;
      this.log('container_deposit', {
        block: target.type, position: target.position, item: itemName, count,
        inventoryDelta: after - before, verified: true, heldDelta: afterHeld - beforeHeld, storedDelta: afterStored - beforeStored,
        before: { held: beforeHeld, stored: beforeStored }, after: { held: afterHeld, stored: afterStored },
      });
      return {
        ok: true, verified: true, item: itemName, count, into: target.type, position: target.position,
        inventoryDelta: after - before, heldDelta: afterHeld - beforeHeld, storedDelta: afterStored - beforeStored,
        before: { held: beforeHeld, stored: beforeStored }, after: { held: afterHeld, stored: afterStored },
        ms: Date.now() - started, contents,
      };
    } catch (error) {
      return { ok: false, error: error.message };
    } finally {
      await this._returnCursorToInventory().catch(() => {});
      await this._closeContainer().catch(() => {});
      this._refreshInventory();
    }
  }

  async _craftItem (itemName) {
    if (!this.recipes || !this.craftingData) return { ok: false, error: 'recipes_unavailable' };
    const candidates = this.recipes.get(itemName) || [];
    if (!candidates.length) return { ok: false, error: 'craft_recipe_missing' };
    const first = await this._craftAttempt(itemName, candidates);
    if (first.ok) return first;
    // Un pickup (anche auto) può fondersi con uno stack e cambiargli stack id:
    // take/place falliscono con 49/50 oppure i materiali mancano dagli slot.
    // Un `craft_failed` (status 35) ha la stessa firma quando la griglia è
    // tracciata male: il `finally` di `_craftAttempt` ha già rimesso gli
    // ingredienti nello zaino, quindi il retry li riposa leggendo stack id
    // freschi. Una riconnessione riporta l'inventory_content completo.
    const syncable = /^(missing_ingredients|craft_failed|take_failed_(49|50)|place_failed_(49|50))$/.test(String(first.error));
    if (!syncable) return first;
    if (first.error === 'missing_ingredients' && !this._candidatesLookUntracked(candidates)) return first;
    try {
      await this._resyncByReconnect();
    } catch (error) {
      this.log('inventory_resync_failed', { message: error.message });
      return first;
    }
    return this._craftAttempt(itemName, candidates);
  }

  _slotsLookStaleFor (recipe) {
    // Confronta i materiali dell'aggregato (aggiornato dai pickup) con quelli degli
    // slot: un eccesso nell'aggregato indica stack id locali mancanti/inattuali.
    for (const { ingredient } of this._planGrid(recipe, true)) {
      let aggregate = 0;
      for (const [name, count] of Object.entries(this.inventory)) {
        if (this._ingredientMatches(ingredient, name)) aggregate += count;
      }
      let tracked = 0;
      for (const slot of this.inventorySlots) {
        const name = this._slotItemName(slot);
        if (name && this._ingredientMatches(ingredient, name)) tracked += slot.count || 0;
      }
      if (aggregate > tracked) return true;
    }
    return false;
  }

  _candidatesLookUntracked (candidates) {
    return candidates.some(entry => {
      const recipe = this._recipeBody(entry);
      return recipe && this._slotsLookStaleFor(recipe);
    });
  }

  _waitForPlayerSnapshot (since, timeoutMs = INVENTORY_REFRESH_TIMEOUT_MS) {
    if (this._playerSnapshotCount > since) return Promise.resolve(this._playerSnapshotCount);
    return new Promise(resolve => {
      const waiter = value => { clearTimeout(timer); resolve(value); };
      const timer = setTimeout(() => {
        this._playerSnapshotWaiters = this._playerSnapshotWaiters.filter(w => w !== waiter);
        resolve(0);
      }, timeoutMs);
      this._playerSnapshotWaiters.push(waiter);
    });
  }

  // Il resync in-place è lecito solo dove riaprire la finestra non distrugge
  // lavoro in corso: un baule aperto si chiuderebbe, e una griglia di crafting
  // con ingredienti dentro o uno stack sul cursore andrebbero persi.
  _canRefreshInventoryInPlace () {
    if (!this._openContainer) return true;
    if (this._openContainer.type !== 'inventory') return false;
    return !this._cursor && this._craftingGrid.size === 0;
  }

  // Rinfresca `inventorySlots` **senza** toccare la sessione: aprire la finestra
  // del giocatore fa rispondere al server un `inventory_content` a 36 slot con
  // stack id freschi, e la finestra si richiude subito dopo. Ritorna true solo
  // quando lo snapshot è arrivato e stato accettato.
  async _refreshInventoryFromServer ({ timeoutMs = INVENTORY_REFRESH_TIMEOUT_MS } = {}) {
    if (!this.client || !this.spawned) return false;
    if (!this._canRefreshInventoryInPlace()) return false;
    const before = this._playerSnapshotCount;
    const wait = this._waitForPlayerSnapshot(before, timeoutMs);
    try {
      if (this._openContainer) await this._closeContainer();
      await this._ensureInventoryOpen();
    } catch (error) {
      this.log('inventory_refresh_failed', { message: error.message });
      await this._closeContainer().catch(() => {});
      return false;
    }
    const got = await wait;
    await this._closeContainer().catch(() => {});
    this.log('inventory_refresh', { ok: !!got, slots: this.inventorySlots.filter(s => s?.network_id).length });
    return !!got;
  }

  async _resyncByReconnect () {
    const signal = this._actionScope?.getStore()?.signal;
    if (signal?.aborted) throw new Error('action_cancelled');
    if (!this.client || !this.spawned) throw new Error('not_connected');
    this.log('inventory_resync', { reason: 'slot ids stale after pickups; reconnecting for fresh inventory_content' });
    // 1) la strada che non tocca la sessione NetherNet: chiedere l'inventario.
    const refreshed = await this._refreshInventoryFromServer({ timeoutMs: this._inventoryRefreshTimeoutMs ?? INVENTORY_REFRESH_TIMEOUT_MS });
    if (refreshed) {
      this.log('inventory_resync_done', { via: 'refresh', trackedSlots: this.inventorySlots.filter(s => s?.network_id).length });
      return;
    }
    if (signal?.aborted) throw new Error('action_cancelled');
    // 2) riconnessione, con un limite di frequenza: contro un BDS che non ha
    //    rilasciato la sessione è l'unica via che resta, ma ripeterla la rompe.
    const sinceLast = Date.now() - this._lastInventoryReconnectAt;
    if (this._lastInventoryReconnectAt && sinceLast < INVENTORY_RESYNC_COOLDOWN_MS) {
      this.log('inventory_resync_throttled', { sinceLastMs: sinceLast, cooldownMs: INVENTORY_RESYNC_COOLDOWN_MS });
      throw new Error('inventory_resync_throttled');
    }
    this._lastInventoryReconnectAt = Date.now();
    await this.disconnect('inventory resync');
    if (signal?.aborted) throw new Error('action_cancelled');
    await delay(this._resyncSettleMs ?? INVENTORY_RESYNC_SETTLE_MS);
    try {
      await this.connect();
    } catch (error) {
      this.log('inventory_resync_wedged', { message: error.message, connectError: this.connectError?.message ?? null });
      throw new Error(`inventory_resync_wedged: ${error.message}`);
    }
    // Un `connect()` che risolve senza spawn lascia il bot senza inventario e
    // senza poter agire: meglio dirlo che far credere al chiamante di avere
    // stack id freschi.
    if (!this.spawned || !this.client) {
      this.log('inventory_resync_wedged', { message: 'no spawn after reconnect', connectError: this.connectError?.message ?? null });
      throw new Error(`inventory_resync_wedged: ${this.connectError?.message || 'no spawn'}`);
    }
    this.log('inventory_resync_done', { via: 'reconnect', trackedSlots: this.inventorySlots.filter(s => s?.network_id).length });
  }

  async _craftAttempt (itemName, candidates) {
    let failure = null;
    for (const entry of candidates) {
      const recipe = this._recipeBody(entry);
      if (!recipe || !this._hasMaterials(recipe)) continue;
      const table = (recipe.width || 1) > 2 || (recipe.height || 1) > 2;
      try {
        if (table) await this._ensureCraftingTableOpen();
        else await this._ensureInventoryOpen();
        await this._clearCraftingGrid();
        const gridStackIds = await this._placeGridIngredients(recipe, table);
        const { actions, result } = this._craftActions(recipe, gridStackIds);
        const response = await this._sendStackRequest(actions, { outputs: true });
        const status = response.status;
        if (String(status) !== 'ok' && status !== 0) {
          const consumeStackIds = [...gridStackIds].map(([gridSlot, stackId]) => ({ gridSlot, stackId }));
          this.log('craft_failed_detail', { detail: JSON.stringify({
            item: itemName, network_id: recipe.network_id, width: recipe.width, height: recipe.height,
            input: (recipe.input || []).map(i => i.type === 'valid' ? (i.descriptor_type === 'item_tag' ? `tag:${i.tag}` : `name:${i.name}`) : null),
            grid: [...this._craftingGrid.entries()].map(([slot, entry]) => ({ slot, name: this.world.registry?.items[entry.network_id]?.name || entry.network_id, count: entry.count, stack_id: entry.stack_id ?? null })),
            consumeStackIds,
            status,
          }) });
          // Lo stesso item può avere più varianti (`tag:coals` e
          // `name:charcoal`, come per le assi): il rifiuto di una variante non
          // deve fermare la ricerca dell'altra. Il primo fallimento resta quello
          // da riferire se nessuna passa.
          failure ??= { ok: false, error: 'craft_failed', status };
          continue;
        }
        this._applyStackResponse(response, { networkId: result.network_id });
        return { ok: true, crafted: itemName, count: result.count || 1 };
      } catch (error) {
        failure ??= { ok: false, error: error.message };
        continue;
      } finally {
        await this._clearCraftingGrid().catch(() => {});
        await this._returnCursorToInventory().catch(() => {});
        await this._closeContainer().catch(() => {});
      }
    }
    return failure || { ok: false, error: 'missing_ingredients' };
  }

  // ---- piazzamento blocchi -----------------------------------------------------------

  // `allowEmpty` serve a *liberare* la mano (item `{network_id: 0}`): senza
  // l'opzione una slot vuota non è selezionabile (`return false`) e il bot resta
  // con l'oggetto precedente in mano.
  _selectHotbarSlot (index, { allowEmpty = false } = {}) {
    if (this._actionScope?.getStore()?.signal.aborted) throw new Error('action_cancelled');
    const item = this.inventorySlots[index];
    if (!item?.network_id && !allowEmpty) return false;
    this.client.write('mob_equipment', {
      runtime_entity_id: this.client.entityId,
      item: item?.network_id ? item : { network_id: 0 },
      slot: index, selected_slot: index, window_id: 'inventory',
    });
    this.selectedHotbar = index;
    return true;
  }

  // `player_action` vuole anche una posizione: senza `position`/`result_position`/
  // `face` il serializer del client lancia (`SizeOf error for undefined … reading
  // 'x'`), quindi lo `start_sneak` dello smontaggio non sarebbe mai partito (bug
  // latente trovato dal test del 04/10/2026). Un solo punto di costruzione.
  _sendPlayerAction (action) {
    if (!this.client) return false;
    const feet = this._feet || this.position || { x: 0, y: 0, z: 0 };
    this.client.write('player_action', {
      runtime_entity_id: this.client.entityId,
      action,
      position: { x: Math.floor(feet.x), y: Math.floor(feet.y), z: Math.floor(feet.z) },
      result_position: { x: 0, y: 0, z: 0 },
      face: 0,
    });
    return true;
  }

  // Prepara un'interazione "mano libera e non in sneak": è la combinazione con
  // cui un client vanilla monta un cavalcabile o apre il commercio di un villager.
  // Regola verificata con l'utente il 04/10/2026: con **sneak** attivo (o con un
  // attrezzo in mano) il tasto destro su un animale apre il suo inventario invece
  // di montarlo. Due difetti veri dietro il `mount_not_confirmed` del 03/10/2026
  // (sintomo: il server rispondeva `inventory_slot {window_id:2, slot:0,
  // item:'saddle'}` invece del link di mount): `_selectHotbarSlot` rifiutava gli
  // slot vuoti (la "mano vuota" non era quindi mai ottenuta) e lo `start_sneak`
  // dello smontaggio non veniva mai annullato, quindi il server vedeva il bot in
  // sneak. Ritorna come è stata lasciata la mano, per la diagnosi.
  _freeHands (reason = 'interact') {
    // Lo sneak è un comando, non uno stato di cui fidarsi: il server può
    // considerare il bot in sneak anche se questa sessione non l'ha mai chiesto
    // (stato del giocatore salvato dal server dopo uno smontaggio interrotto —
    // `start_sneak` senza `stop_sneak`). Con sneak attivo il tasto destro su un
    // cavalcabile apre il suo inventario invece di montarlo (regola dell'utente,
    // 04/10/2026), quindi il `stop_sneak` è incondizionato: è un comando
    // idempotente e costa un pacchetto per interazione.
    this._sendPlayerAction('stop_sneak');
    if (this._sneaking) this.log('sneak_off', { reason, wasDeclared: true });
    this._sneaking = false;
    const selected = this.selectedHotbar < 9 ? this.inventorySlots[this.selectedHotbar] : null;
    if (!selected?.network_id) return 'empty';   // mano già libera: nessun pacchetto
    const empty = this.inventorySlots.findIndex((s, i) => i < 9 && !s?.network_id);
    if (empty >= 0) {
      this._selectHotbarSlot(empty, { allowEmpty: true });
      return 'empty';
    }
    // Hotbar piena: resta in mano un blocco (non un attrezzo da usare
    // sull'entità) e lo si dichiara nella diagnosi.
    this.log('hand_not_empty', { reason, slot: this.selectedHotbar });
    return 'full_hotbar';
  }

  // Cella dove piazzare un blocco: il vicino libero più vicino con un supporto
  // solido sotto. Cerca ad anello (raggio 1 poi 2, alla quota dei piedi e a
  // quella appena sopra) perché in una stanza arredata il primo anello può essere
  // tutto occupato: il piazzamento resta entro la portata del braccio (~5 blocchi).
  // Supporti su cui non conviene piazzare: blocchi "usabili" (contenitori, tavoli,
  // fornaci, letti, porte…) intercettano il click e il server non piazza nulla
  // (esito osservato live: `place_not_confirmed` con la cella bersaglio vuota).
  _badSupport (name) {
    return /(chest|_table$|furnace|smoker|barrel|shulker_box|hopper|anvil|brewing_stand|beacon|loom|stonecutter|grindstone|lectern|composter|cauldron|bell|_bed$|_sign$|_banner$|_door$|_fence_gate$|_pot$|torch|lantern)/.test(name || '');
  }

  _findPlacementTarget (blockName) {
    const feet = this._feet;
    const bx = Math.floor(feet.x), by = Math.floor(feet.y + 0.1), bz = Math.floor(feet.z);
    const ring = (r) => {
      const cells = [];
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          cells.push([dx, dz]);
        }
      }
      return cells.sort((a, b) => (Math.abs(a[0]) + Math.abs(a[1])) - (Math.abs(b[0]) + Math.abs(b[1])));
    };
    for (const r of [1, 2]) {
      for (const dy of [0, 1]) {
        for (const [dx, dz] of ring(r)) {
          if (dx === 0 && dz === 0) continue; // la cella del bot (piedi o testa)
          const target = { x: bx + dx, y: by + dy, z: bz + dz };
          const support = { x: target.x, y: target.y - 1, z: target.z };
          if (!this._airAt(target.x, target.y, target.z)) continue;
          const under = this.world.blockAt(support);
          if (!under || !this._solidAt(support.x, support.y, support.z)) continue;
          if (this._badSupport(under.name)) continue;
          return { target, support, face: 1, clickPos: { x: 0.5, y: 1, z: 0.5 }, blockName };
        }
      }
    }
    return null;
  }

  // Piazza `itemName` (blocco `blockName`) nella cella `target`, cliccando la faccia
  // `face` del blocco `support`. Generalizzazione di `_placeBlock` per barricade.
  // `opts.yaw`/`opts.pitch` forzano l'orientamento (piazzamento orientato di R1).
  async _placeAtCell (itemName, blockName, target, support, face, clickPos = { x: 0.5, y: 1, z: 0.5 }, opts = {}) {
    const guard = () => {
      if (opts.signal?.aborted) throw new Error('construction_interrupted');
      opts.guard?.();
    };
    guard();
    // W2: piazzare è una vibrazione come scavare. Dentro la sfera di un sensore
    // sculk il piazzamento si rifiuta: la promessa di silenzio vale più del muro.
    // `opts.allowVibrationRisk` esiste per i piazzamenti che *devono* avvenire
    // comunque (barricata difensiva, uscita dall'acqua) e lo dichiarano.
    if (!opts.allowVibrationRisk) {
      const noise = this._vibrationRiskAt(target);
      if (noise) {
        this.log('vibration_risk_place', { item: itemName, block: blockName, position: { ...target }, sensors: noise.count });
        return { ok: false, error: 'vibration_risk_place', block: blockName, position: { ...target }, sensors: noise.count, nearest: noise.nearest };
      }
    }
    // R6: alcuni blocchi non si piazzano mai, qualunque sia il chiamante — TNT e
    // trappole trasformano un cantiere in un incidente, i blocchi di comando non
    // sono nemmeno parte del gioco sulla base (`allow-cheats=false`).
    const forbidden = forbiddenBlock(blockName) ?? forbiddenBlock(itemName);
    if (forbidden) {
      this.log('forbidden_place', { item: itemName, block: blockName, target: { ...target } });
      return { ok: false, error: 'forbidden_block', block: forbidden, position: { ...target } };
    }
    let slotIndex = this.inventorySlots.findIndex(s => this._slotItemName(s) === itemName && s.count > 0);
    if (slotIndex < 0) {
      if (opts.projectId) return { ok: false, error: 'construction_inventory_stale' };
      try { await this._resyncByReconnect(); } catch (error) { this.log('inventory_resync_failed', { message: error.message }); }
      slotIndex = this.inventorySlots.findIndex(s => this._slotItemName(s) === itemName && s.count > 0);
      if (slotIndex < 0) return { ok: false, error: 'missing_item' };
    }
    if (slotIndex > 8) {
      try { slotIndex = await this._moveSlotToHotbar(slotIndex); }
      catch (error) { return { ok: false, error: error.message }; }
    }
    guard();
    if (this._openContainer) await this._closeContainer();
    guard();
    this._selectHotbarSlot(slotIndex);
    const held = this.inventorySlots[slotIndex];
    const runtimeId = this.world.runtimeIdAt(support);
    const yaw = opts.yaw ?? this._yawTo(this._feet, { x: target.x + 0.5, z: target.z + 0.5 });
    const pitch = opts.pitch ?? this._lookAt({ x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 }).pitch;
    // Diagnostica: l'esito di un piazzamento è altrimenti invisibile da fuori
    // (il server può ignorare la transazione senza rispondere nulla).
    const before = this.world.blockAt(target)?.name ?? null;
    this._lastPlacement = {
      item: itemName, block: blockName, target: { ...target }, support: { ...support }, face,
      slot: slotIndex, hotbar: this.selectedHotbar, held: this._slotItemName(held) || null, yaw, pitch,
      before, at: Date.now(), error: null,
    };
    guard();
    await this._queueAuthInput({
      yaw,
      pitch,
      transaction: {
        legacy: { legacy_request_id: 0 },
        actions: [],
        data: {
          action_type: 'click_block',
          trigger_type: 'player_input',
          block_position: support,
          face,
          hotbar_slot: this.selectedHotbar,
          hand: 'main_hand',
          held_item: held,
          player_pos: { ...this.position },
          click_pos: clickPos,
          block_runtime_id: runtimeId >>> 0,
          client_prediction: 'success',
          client_cooldown_state: 'off',
        },
      },
    });
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      const placed = this.world.blockAt(target);
      if (placed && placed.name === blockName) {
        this._refreshNearby();
        this._lastPlacement.after = blockName;
        // R4: il bot ricorda cosa ha piazzato lui, per poterlo rimuovere senza
        // toccare il resto del mondo. Il registro è anche *persistente*
        // (`memory.rememberPlacement`): un restart non deve far perdere il titolo.
        this._rememberPlacement({ position: target, block: blockName, item: itemName, source: opts.source ?? 'place', projectId: opts.projectId ?? null, signature: stateSignature(placed) });
        for (const secondary of opts.secondary ?? []) {
          const actual = this.world.blockAt(secondary.position);
          if (actual?.name === secondary.block) this._rememberPlacement({ position: secondary.position, block: secondary.block, item: itemName, source: opts.source ?? 'place', projectId: opts.projectId ?? null, signature: stateSignature(actual) });
        }
        return { ok: true, block: blockName, position: target };
      }
      guard();
      if (placed && placed.name !== 'air' && placed.name !== 'unknown') {
        this._lastPlacement.after = placed.name;
        return { ok: false, error: `unexpected_block_${placed.name}` };
      }
      await delay(100);
    }
    this._lastPlacement.after = this.world.blockAt(target)?.name ?? null;
    return { ok: false, error: 'place_not_confirmed' };
  }

  async _placeBlock (itemName, blockName) {
    const spot = this._findPlacementTarget(blockName);
    if (!spot) return { ok: false, error: 'no_place_spot' };
    return this._placeAtCell(itemName, blockName, spot.target, spot.support, spot.face, spot.clickPos);
  }

  // ---- redstone: piazzamento orientato e ritardo del ripetitore (R1) -----------------

  // Piazzamento orientato con verifica dello stato: place → read → correct.
  // Su Bedrock la direzione di un blocco direzionale la deriva il server dallo
  // yaw del giocatore (più la faccia cliccata e il click_pos), e la regola non è
  // documentata per famiglia: invece di indovinarla si prova, si rilegge lo
  // stato dal mondo e, se non è quello voluto, si rimuove il blocco appena messo
  // e si ritenta con lo yaw successivo. La verifica è quindi sullo stato reale,
  // non sulla forma del pacchetto.
  async _placeOriented (itemName, blockName, { facing = null, face = 1, tries = PLACEMENT_YAW_STEPS.length, timeoutMs = 8000 } = {}) {
    const spot = this._findPlacementTarget(blockName);
    if (!spot) return { ok: false, error: 'no_place_spot', block: blockName };
    const baseYaw = this._yawTo(this._feet, { x: spot.target.x + 0.5, z: spot.target.z + 0.5 });
    const pitch = this._lookAt({ x: spot.target.x + 0.5, y: spot.target.y + 0.5, z: spot.target.z + 0.5 }).pitch;
    const tried = [];
    for (let i = 0; i < Math.max(1, tries); i++) {
      const yaw = (((baseYaw + PLACEMENT_YAW_STEPS[i % PLACEMENT_YAW_STEPS.length]) % 360) + 360) % 360;
      const res = await this._placeAtCell(itemName, blockName, spot.target, spot.support, face, spot.clickPos, { yaw, pitch });
      if (!res.ok) return { ...res, attempts: tried.length + 1, tried };
      const block = this.world.blockAt(spot.target);
      const actual = normalizeFacing(facingOf(block));
      tried.push(actual);
      if (!facing || facingMatches(actual, facing)) {
        this.log('oriented_place', { block: blockName, position: spot.target, facing: actual, wanted: facing ?? null, attempts: tried.length });
        return { ok: true, block: blockName, position: spot.target, face, facing: actual, wanted: facing ?? null, attempts: tried.length, corrected: tried.length > 1, tried };
      }
      if (i === Math.max(1, tries) - 1) break;
      const removed = await this._mineBlock(block, timeoutMs);
      if (!removed?.ok) {
        this.log('oriented_place_stuck', { block: blockName, position: spot.target, facing: actual, wanted: facing, error: removed?.error ?? null });
        return { ok: false, error: 'orientation_not_confirmed', block: blockName, position: spot.target, facing: actual, wanted: facing, attempts: tried.length, tried };
      }
      await delay(150);
    }
    const actual = normalizeFacing(facingOf(this.world.blockAt(spot.target)));
    this.log('oriented_place_failed', { block: blockName, position: spot.target, facing: actual, wanted: facing, tried });
    return { ok: false, error: 'orientation_not_confirmed', block: blockName, position: spot.target, facing: actual, wanted: facing, attempts: tried.length, tried };
  }

  _pickRepeaterTarget () {
    const scans = this._redstoneCensus()?.components ?? [];
    return scans.find(c => isRepeater(c.name))?.position ?? null;
  }

  // Il ritardo di un ripetitore si cambia con un click (cicla 0→1→2→3→0): dopo
  // ogni click lo stato si rilegge dal mondo, quindi "cambiato" è un fatto
  // osservato e non una speranza.
  async _cycleRepeater (position, { clicks = 1, timeoutMs = 2500 } = {}) {
    const cell = position ?? this._pickRepeaterTarget();
    if (!cell) return { ok: false, error: 'no_repeater_nearby' };
    const block = this.world.blockAt(cell);
    if (!block || !isRepeater(block.name)) return { ok: false, error: 'not_a_repeater', position: cell, block: block?.name ?? null };
    if (this._reachabilityUsable() && !this.approachReachable(cell)) return { ok: false, error: 'repeater_unreachable', position: cell };
    const before = repeaterDelay(block);
    // `delay` è la funzione importata da node:timers/promises: il valore corrente
    // del ritardo ha bisogno di un nome proprio, altrimenti lo shadowing la rende
    // non chiamabile.
    let current = before;
    const total = Math.max(1, clicks);
    for (let i = 0; i < total; i++) {
      const yaw = this._yawTo(this._feet, { x: cell.x + 0.5, z: cell.z + 0.5 });
      const pitch = this._lookAt({ x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 }).pitch;
      await this._queueAuthInput({ yaw, pitch, transaction: this._blockUseTransaction(cell) });
      const deadline = Date.now() + timeoutMs;
      let next = current;
      while (Date.now() < deadline) {
        next = repeaterDelay(this.world.blockAt(cell));
        if (next != null && next !== current) break;
        await delay(80);
      }
      if (next == null) return { ok: false, error: 'repeater_state_unreadable', position: cell, before, delay: current };
      if (next === current) return { ok: false, error: 'repeater_delay_not_confirmed', position: cell, before, delay: current, clicks: i + 1 };
      current = next;
    }
    this._redstoneCensus({ force: true });
    this.log('repeater_delay', { position: cell, before, delay: current, clicks: total });
    return { ok: true, position: cell, before, delay: current, clicks: total };
  }

  // `wanted` null ⇒ valore successivo (0→1→2→3→0).
  async _setRepeaterDelay (wanted = null, { position = null } = {}) {
    const cell = position ?? this._pickRepeaterTarget();
    if (!cell) return { ok: false, error: 'no_repeater_nearby' };
    const current = repeaterDelay(this.world.blockAt(cell));
    if (current == null) return { ok: false, error: 'repeater_state_unreadable', position: cell };
    const target = wanted == null ? (current + 1) % 4 : Math.max(0, Math.min(3, Math.round(wanted)));
    if (target === current) return { ok: true, already: true, position: cell, delay: current };
    const res = await this._cycleRepeater(cell, { clicks: (target - current + 4) % 4 });
    if (!res.ok) return res;
    if (res.delay !== target) return { ok: false, error: 'repeater_delay_not_confirmed', position: cell, before: current, delay: res.delay, wanted: target };
    return { ok: true, position: cell, before: current, delay: res.delay, clicks: res.clicks, wanted: target };
  }

  // ------------------------------------------------------------------- R3
  // Un circuito è un blueprint dichiarativo (circuits/*.json) che diventa un
  // piano di celle assolute, si costruisce in ordine, si aziona e si verifica
  // sulle proprietà che il mondo riporta. Il catalogo si carica una volta sola:
  // un blueprint invalido non impedisce al bot di giocare, resta visibile in
  // `/observe.circuits.invalid` (e nessuna opzione `build_circuit_*` compare).
  _circuitCatalogue () {
    if (!this._circuits) {
      try {
        this._circuits = loadCircuits();
        this._circuitError = null;
      } catch (error) {
        this._circuits = new Map();
        this._circuitError = error.message;
        this.log('circuits_invalid', { message: error.message });
      }
    }
    return this._circuits;
  }

  _circuitsView () {
    const all = [...this._circuitCatalogue().values()];
    return {
      count: all.length,
      buildable: all.filter(d => d.buildable).map(d => d.id),
      declared: all.filter(d => !d.buildable).map(d => ({ id: d.id, blocked: d.blocked ?? null })),
      invalid: this._circuitError,
      last: this._circuitLast,
      owned: this._ownedCircuitCells().length,
      // R6: i limiti sono una proprietà osservabile, non una nota in un file.
      limits: {
        maxSteps: MAX_CIRCUIT_STEPS,
        maxComponents: MAX_CIRCUIT_COMPONENTS,
        minClockTicks: MIN_CLOCK_TICKS,
        toggleMinIntervalMs: REDSTONE_TOGGLE_MIN_INTERVAL_MS,
      },
    };
  }

  // La direzione del cantiere è quella verso cui guarda il bot: il blueprint è
  // scritto con +z in avanti.
  _facingFromYaw (yaw = this._lastYaw) {
    const angle = ((Number(yaw) || 0) % 360 + 360) % 360;
    if (angle < 45 || angle >= 315) return 'south';
    if (angle < 135) return 'west';
    if (angle < 225) return 'north';
    return 'east';
  }

  _circuitPlan (def, { facing = null } = {}) {
    const dir = facing ?? this._facingFromYaw();
    return planCircuit(def, { origin: circuitAnchor(this._feet, dir), facing: dir, available: this.inventory ?? {} });
  }

  // R5: le ricette arrivano dal crafting_data del server, quindi un blueprint
  // nuovo non richiede un ramo nuovo qui: se un materiale mancante ha una
  // ricetta e gli ingredienti sono in inventario, il passo successivo compare.
  _recipeIngredientCounts (recipe, table) {
    const counts = new Map();
    for (const { ingredient } of this._planGrid(recipe, table)) {
      const key = `${ingredient.descriptor_type}:${ingredient.name ?? ingredient.tag ?? ''}`;
      const entry = counts.get(key);
      if (entry) entry.count++;
      else counts.set(key, { ingredient, count: 1 });
    }
    return [...counts.values()];
  }

  _heldMatching (ingredient) {
    let total = 0;
    for (const [name, count] of Object.entries(this.inventory)) {
      if ((count || 0) > 0 && this._ingredientMatches(ingredient, name)) total += count;
    }
    return total;
  }

  // ---- sorgenti dei materiali: inventario -> bauli -> natura (mai costruzioni) ----
  //
  // Regola chiesta dall'utente (05/10): per costruire qualcosa il bot guarda
  // prima cosa ha addosso, poi cosa c'e' nei bauli vicini (letti o ricordati) e
  // solo alla fine raccoglie in natura. Non smonta mai una costruzione: il
  // censimento dei blocchi minabili e' una whitelist di blocchi naturali (vedi
  // `_refreshNearby`) e `DIG_PROTECTED` copre i percorsi di scavo, quindi una
  // casa non e' nemmeno una sorgente possibile. Le descrizioni lo dichiarano.

  // Gli item dell'obiettivo che hanno una ricetta e non sono ancora in inventario.
  _craftTargets () {
    const wanted = new Map(Object.entries(this.plan?.targets || {}));
    const declared = this.plan?.craft;
    for (const item of Array.isArray(declared) ? declared : (declared ? [declared] : [])) {
      if (!wanted.has(item)) wanted.set(item, 1);
    }
    const out = [];
    for (const [item, need] of wanted) {
      if (!this.recipes?.get(item)?.length) continue;
      const have = this.inventory[item] || 0;
      if (have >= need) continue;
      out.push({ item, need, have });
    }
    return out;
  }

  // La ricetta di un target ridotta a cosa manca e dove si puo' prendere: cosa
  // c'e' nei bauli noti (letti adesso o ricordati) per ogni ingrediente corto.
  _craftNeedFor (target) {
    const entry = (this.recipes?.get(target.item) || [])[0];
    const recipe = entry ? this._recipeBody(entry) : null;
    if (!recipe) return null;
    const copies = Math.max(1, target.need - target.have);
    const missing = [];
    for (const { ingredient, count } of this._recipeIngredientCounts(recipe, true)) {
      const need = count * copies;
      const have = this._heldMatching(ingredient);
      if (have >= need) continue;
      const sources = [];
      for (const c of [...this._cachedContainers(), ...this._rememberedStorage()]) {
        for (const [item, n] of Object.entries(c.contents || {})) {
          if (!n || !this._ingredientMatches(ingredient, item)) continue;
          sources.push({
            item, count: n, type: c.type || 'chest', position: c.position,
            distance: +(c.distance ?? 0).toFixed(1), remembered: c.remembered === true,
          });
        }
      }
      sources.sort((a, b) => (b.count - a.count) || (a.distance - b.distance));
      missing.push({
        ingredient: ingredient.descriptor_type === 'name' ? ingredient.name : `#${ingredient.tag}`,
        ref: ingredient,
        need, have, short: need - have,
        sources: sources.slice(0, 4),
      });
    }
    return { target: target.item, need: target.need, have: target.have, missing };
  }

  // Cosa si puo' fabbricare *adesso* e soddisfa un ingrediente (planks, stick,
  // cobblestone...): e' il lato "inventario" della regola.
  _craftableCandidatesFor (ingredient) {
    const names = [];
    if (ingredient.descriptor_type === 'name') {
      names.push(String(ingredient.name).replace(/^minecraft:/, ''));
    } else if (ingredient.tag) {
      for (const name of this.recipes?.keys?.() ?? []) {
        if (name.endsWith(`_${ingredient.tag}`) || name === ingredient.tag) names.push(name);
      }
    }
    return names.filter(name => this._craftableNow(name));
  }

  // La memoria suggerisce solo un waypoint da rivalidare. Una gather action
  // viene dal census live e deve essere presente in `offered`.
  _gatherStepFor (ingredient, offered) {
    return this.resourceSites.step(naturalGatherCandidates(ingredient), offered);
  }

  // Inventario -> storage -> craft -> sito ricordato -> census locale.
  // `offered` limita la raccolta alle azioni live dell'adapter.
  _craftSourceStep (needs, offered) {
    for (const need of needs) {
      if (!need.missing.length && this._craftableNow(need.target)) {
        return { key: `craft_${need.target}`, source: 'inventory', item: need.target, target: need.target, reason: 'craft_target_ready' };
      }
      for (const miss of need.missing) {
        const ingredient = miss.ref ?? miss.ingredient;
        if (miss.sources.length) {
          const src = miss.sources[0];
          return {
            key: `take_${src.item}`, source: 'chest', item: src.item, ingredient: miss.ingredient,
            target: need.target, short: miss.short,
            chest: { type: src.type, position: src.position, distance: src.distance, remembered: src.remembered },
            reason: 'take_from_chest',
          };
        }
        for (const item of this._craftableCandidatesFor(ingredient)) {
          return { key: `craft_${item}`, source: 'inventory', item, ingredient: miss.ingredient, target: need.target, short: miss.short, reason: 'craft_from_inventory' };
        }
        const gather = offered ? this._gatherStepFor(ingredient, offered) : null;
        if (gather) return { ...gather, target: need.target, short: miss.short, reason: gather.reason ?? `gather_${gather.item}` };
      }
    }
    return null;
  }

  // Vista completa dei bisogni di materiale: obiettivi, cosa manca e il passo
  // scelto (o `null`). In `observe()` non ci sono opzioni offerte, quindi il
  // ripiego "raccogli in natura" resta fuori e si vede solo nei casi in cui la
  // sorgente e' certa (inventario o baulo).
  _craftNeeds ({ offerKeys = null, liveGather = false } = {}) {
    const targets = this._craftTargets();
    if (!targets.length) return null;
    if (liveGather && !offerKeys) offerKeys = this.options({ localGatherOnly: true });
    const offered = offerKeys ? new Set([...offerKeys].map(key => (typeof key === 'string' ? key : key.key))) : null;
    const needs = targets.map(t => this._craftNeedFor(t)).filter(Boolean);
    return {
      rule: 'inventory_first_then_chests_never_buildings',
      targets: targets.map(t => ({ item: t.item, need: t.need, have: t.have })),
      needs,
      next: this._craftSourceStep(needs, offered),
    };
  }

  // Un item che il bot può fabbricare adesso: ricetta nota, ingredienti in
  // inventario e, per le ricette 3x3, un tavolo da lavoro a portata.
  _craftableNow (item) {
    for (const entry of this.recipes?.get(item) ?? []) {
      const recipe = this._recipeBody(entry);
      if (!recipe) continue;
      if ((recipe.width || 1) > 2 || (recipe.height || 1) > 2) {
        if (!this.world.findBlocks('crafting_table', this.position, 32, 1).length) continue;
      }
      const needs = this._recipeIngredientCounts(recipe, true);
      if (!needs.length) continue;
      if (needs.every(({ ingredient, count }) => this._heldMatching(ingredient) >= count)) return true;
    }
    return false;
  }

  // R5: il ponte fra un blueprint e i suoi materiali. Un circuito con i
  // materiali mancanti non offre il cantiere (resterebbe un'azione che non può
  // riuscire), ma se quei materiali sono fabbricabili offre **quelli**, che è il
  // passo che manca davvero.
  _circuitOptionFor (def) {
    const plan = this._circuitPlan(def);
    if (!plan.ok) {
      const craftable = plan.missing.filter(need => this._craftableNow(need.item));
      if (!craftable.length) return null;
      const first = craftable[0];
      const list = craftable.map(need => `${need.need - need.have} ${need.item}`).join(', ');
      return {
        key: `craft_${first.item}`,
        description: `Craft ${first.item} for the ${def.id} circuit (missing ${list})`,
      };
    }
    if (circuitSiteBlocked(plan, cell => this.world.blockAt(cell)).length) return null;
    const needs = Object.entries(def.requires).map(([item, qty]) => `${qty} ${item}`).join(', ');
    return {
      key: `build_circuit_${def.id}`,
      description: `Build the ${def.id} circuit at ${JSON.stringify(plan.anchor)} (needs ${needs}): ${def.description}`,
    };
  }

  _circuitOptions () {
    const out = [];
    const seen = new Set();
    for (const def of this._circuitCatalogue().values()) {
      if (!def.buildable) continue;
      const option = this._circuitOptionFor(def);
      if (!option || seen.has(option.key)) continue;
      seen.add(option.key);
      out.push(option);
    }
    // R4: si smonta solo quello che il bot ha costruito lui.
    const owned = this._ownedCircuitCells();
    if (owned.length) {
      out.push({
        key: 'teardown_circuit',
        description: `Remove the ${owned.length} circuit block(s) the bot placed itself (nothing else is touched)`,
      });
    }
    return out;
  }

  // Avvicinamento: se la cella non è a portata si cerca una cella camminabile
  // vicina che non sia essa stessa un passo del circuito (non si calpesta il
  // cantiere mentre lo si costruisce).
  async _approachFor (cell, occupied = new Set()) {
    if (!this._reachabilityUsable()) return null;
    if (this.approachReachable(cell, { range: 3.5, dy: 2 })) return null;
    const from = this._feet;
    const candidates = this._neighbors(cell)
      .filter(n => !occupied.has(`${n.x},${n.y},${n.z}`))
      .filter(n => this.cellReachable(n))
      .sort((a, b) => (Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z)));
    if (!candidates.length) return { error: 'circuit_unreachable' };
    const move = await this._moveTo({ x: candidates[0].x + 0.5, y: candidates[0].y, z: candidates[0].z + 0.5 }, 2, 12000);
    if (move && move.ok === false) return { error: move.error ?? 'move_failed' };
    return null;
  }

  async _placeCircuitStep (step) {
    const yaw = this._yawTo(this._feet, { x: step.cell.x + 0.5, z: step.cell.z + 0.5 });
    const pitch = this._lookAt({ x: step.cell.x + 0.5, y: step.cell.y + 0.5, z: step.cell.z + 0.5 }).pitch;
    const res = await this._placeAtCell(step.item, step.block, step.cell, step.support, step.face, step.clickPos, { yaw, pitch });
    if (!res.ok) return res;
    if (!step.facing) return { ...res, facing: null };
    const actual = normalizeFacing(facingOf(this.world.blockAt(step.cell)));
    if (facingMatches(actual, step.facing)) {
      this.log('circuit_placed', { block: step.block, position: step.cell, facing: actual, wanted: step.facing });
      return { ...res, facing: actual };
    }
    // Girato male e già piazzato: non si ritenta. La protezione dallo scavo
    // rifiuta di rompere un componente redstone, quindi un secondo tentativo
    // non potrebbe che fallire più tardi e in modo più confuso.
    this.log('circuit_orientation_failed', { block: step.block, position: step.cell, facing: actual, wanted: step.facing });
    return { ok: false, error: 'orientation_not_confirmed', block: step.block, position: step.cell, facing: actual, wanted: step.facing };
  }

  // R4: le celle che il bot ha piazzato per un circuito. Il registro tiene
  // anche i blocchi generici (torce, rifugi), ma il teardown tocca solo questi.
  _ownedCircuitCells (id = null) {
    const out = [];
    for (const [key, entry] of this._placedBlocks) {
      if (!entry?.circuit) continue;
      if (id && entry.circuit !== id) continue;
      const [x, y, z] = key.split(',').map(Number);
      out.push({ cell: { x, y, z }, block: entry.block, item: entry.item, circuit: entry.circuit, at: entry.at, key });
    }
    return out.sort((a, b) => a.at - b.at);
  }

  // R4: la `Map` in memoria è una cache del registro persistente (`kind:
  // placement` nella memoria del mondo). Si scrive passando da qui, così le due
  // copie non divergono mai e un restart le ricompone (`_hydratePlacements`).
  _rememberPlacement ({ position, block, item = null, circuitId = null, projectId = null, signature = null, source = 'place', placedAt = null }) {
    const key = `${position.x},${position.y},${position.z}`;
    const name = String(block).replace(/^minecraft:/i, '').toLowerCase();
    const at = placedAt ?? Date.now();
    this._placedBlocks.set(key, { block: name, item: item ?? null, at, source, circuit: circuitId ?? null, projectId, signature });
    try {
      this.memory?.rememberPlacement({ position, block: name, item: item ?? null, circuitId, projectId, signature, dimension: this.dimension, source, placedAt: at });
      if (projectId) this.memory?.repo.flush();
    } catch (error) {
      this.log('placement_persist_failed', { position, block: name, error: String(error?.message ?? error) });
    }
    return { key, block: name, at };
  }

  // R4: il titolo se ne va insieme al blocco (rimosso dal bot, o cambiato da
  // qualcun altro): il registro non conserva celle che non sono più sue.
  _forgetPlacement (position) {
    const key = `${position.x},${position.y},${position.z}`;
    const had = this._placedBlocks.delete(key);
    try {
      this.memory?.forgetPlacement(position, this.dimension);
    } catch (error) {
      this.log('placement_forget_failed', { position, error: String(error?.message ?? error) });
    }
    return had;
  }

  // R4: il cantiere impara *dopo* il piazzamento che quella cella è di un circuito.
  _setPlacementCircuit (position, circuitId) {
    const entry = this._placedBlocks.get(`${position.x},${position.y},${position.z}`);
    if (entry) entry.circuit = circuitId;
    try {
      this.memory?.setPlacementCircuit?.(position, circuitId);
    } catch (error) {
      this.log('placement_persist_failed', { position, circuit: circuitId, error: String(error?.message ?? error) });
    }
    return entry ?? null;
  }

  // R4: ricompone il registro all'avvio. Il mondo non viene interrogato qui:
  // chi rimuove (`_teardownCells`, `_mineOwned`) verifica comunque che il blocco
  // sia ancora quello piazzato dal bot, e una cella che qualcun altro ha
  // cambiato finisce nei `skipped` con motivo `changed`.
  _hydratePlacements () {
    if (!this.memory || typeof this.memory.placements !== 'function') return { hydrated: 0 };
    let hydrated = 0;
    try {
      for (const record of this.memory.placements({ limit: null })) {
        if ((record.dimension ?? 'overworld') !== this.dimension) continue;
        if (!record?.position || !record.type) continue;
        const key = `${record.position.x},${record.position.y},${record.position.z}`;
        if (this._placedBlocks.has(key)) continue;
        this._placedBlocks.set(key, {
          block: String(record.type).replace(/^minecraft:/i, '').toLowerCase(),
          item: record.item ?? null,
          at: record.placedAt ?? record.lastSeenAt ?? Date.now(),
          source: record.source ?? 'restored',
          circuit: record.circuitId ?? null,
        });
        hydrated += 1;
      }
    } catch (error) {
      this.log('placement_hydrate_failed', { error: String(error?.message ?? error) });
    }
    if (hydrated) this.log('placements_hydrated', { count: hydrated, owned: this._placedBlocks.size });
    return { hydrated };
  }

  // R4: tutte le celle del registro (torce, rifugi, cantieri), non solo i circuiti.
  _ownedCells (id = null) {
    const out = [];
    for (const [key, entry] of this._placedBlocks) {
      if (!entry) continue;
      if (id && entry.circuit !== id) continue;
      const [x, y, z] = key.split(',').map(Number);
      out.push({ cell: { x, y, z }, block: entry.block, item: entry.item ?? null, circuit: entry.circuit ?? null, at: entry.at, key });
    }
    return out.sort((a, b) => a.at - b.at);
  }

  // R4: le celle del registro che il bot può togliersi di torno *adesso*: il
  // mondo mostra ancora il blocco che ha piazzato lui e la cella è a portata.
  // Una cella che qualcun altro ha cambiato non è più sua (non compare).
  _ownedRecoverable ({ range = 5.1 } = {}) {
    if (!this.position) return [];
    const out = [];
    for (const entry of this._ownedCells()) {
      const block = this.world.blockAt(entry.cell);
      const name = String(block?.name ?? '').replace(/^minecraft:/i, '').toLowerCase();
      if (!name || name !== entry.block) continue;
      if (isBeeProtected(name)) continue;
      if (block && block.diggable === false) continue;
      const distance = Math.round(Math.hypot(
        entry.cell.x + 0.5 - this.position.x,
        entry.cell.y + 0.5 - this.position.y,
        entry.cell.z + 0.5 - this.position.z,
      ) * 10) / 10;
      // Si offre solo ciò che è a portata di braccio: per *andare* a prendere un
      // proprio blocco lontano c'è `goto_waypoint`, e offrire un'azione che
      // richiede un percorso che non esiste è la stessa famiglia di difetto dei
      // filtri di raggiungibilità (P2).
      if (distance > range) continue;
      if (this._reachabilityUsable() && !this.mineDropReachable(entry.cell)) continue;
      out.push({ ...entry, distance });
    }
    return out.sort((a, b) => a.distance - b.distance);
  }

  // R4: una cella il cui blocco non è più quello che il bot ha piazzato non è
  // più sua: il titolo si butta, altrimenti un blocco messo da altri nella
  // stessa cella potrebbe essere rimosso al posto suo. I chunk non caricati non
  // si giudicano (`blockAt` nullo o `unknown`): lì la verifica la fa chi rimuove.
  _reconcilePlacements () {
    const dropped = [];
    for (const entry of this._ownedCells()) {
      const block = this.world.blockAt(entry.cell);
      const name = String(block?.name ?? '').replace(/^minecraft:/i, '').toLowerCase();
      if (!name || name === 'unknown' || name === entry.block) continue;
      this._forgetPlacement(entry.cell);
      dropped.push({ ...entry, found: name });
    }
    if (dropped.length) this.log('placement_claims_dropped', { count: dropped.length, cells: dropped.map(d => d.cell) });
    return dropped;
  }

  // R4: `mine_owned` è l'unico modo che il bot ha di disfare una *propria*
  // posa — la leva per liberarsi di un blocco che ha messo lui e che ora gli
  // impedisce di muoversi. Il registro dice che la cella è sua, il mondo deve
  // ancora mostrare quel blocco: se qualcuno l'ha cambiato il blocco non gli
  // appartiene più e la cella non viene toccata. `DIG_PROTECTED` non entra qui:
  // quella guardia serve a non aprire buchi nella base scavando gradini
  // (`dig_down`/`dig_up`), non a impedire di riprendersi un proprio piazzamento.
  async _mineOwned ({ timeoutMs = 30000, maxAttempts = 3 } = {}) {
    const dropped = this._reconcilePlacements();
    const candidates = this._ownedRecoverable();
    if (!candidates.length) {
      return {
        ok: false,
        error: 'nothing_owned_nearby',
        owned: this._placedBlocks.size,
        dropped: dropped.length,
        hint: 'no placement of mine is both in reach and still standing where I left it',
      };
    }
    const failed = [];
    for (const candidate of candidates.slice(0, Math.max(1, maxAttempts))) {
      const block = this.world.blockAt(candidate.cell);
      if (!block) { failed.push({ ...candidate, error: 'world_not_loaded' }); continue; }
      const res = await this._mineBlock(block, timeoutMs);
      if (res?.ok) {
        this._forgetPlacement(candidate.cell);
        this.log('placement_recovered', { position: candidate.cell, block: candidate.block, item: candidate.item, circuit: candidate.circuit });
        return {
          ok: true,
          block: candidate.block,
          item: candidate.item,
          position: candidate.cell,
          circuit: candidate.circuit,
          dropped: res.dropped ?? null,
          owned: this._placedBlocks.size,
        };
      }
      failed.push({ ...candidate, error: res?.error ?? 'mine_failed' });
    }
    return {
      ok: false,
      error: failed[0]?.error ?? 'mine_failed',
      position: failed[0]?.cell ?? null,
      block: failed[0]?.block ?? null,
      attempts: failed.length,
      failed,
    };
  }

  // Smonta le celle indicate **solo** se il bot le ha piazzate lui e se il mondo
  // mostra ancora quel blocco: se qualcun altro l'ha cambiato non si tocca.
  async _teardownCells (cells, { timeoutMs = 30000 } = {}) {
    const removed = [];
    const skipped = [];
    const failed = [];
    for (const entry of cells) {
      const key = entry.key ?? `${entry.cell.x},${entry.cell.y},${entry.cell.z}`;
      const [kx, ky, kz] = key.split(',').map(Number);
      const cell = entry.cell ?? { x: kx, y: ky, z: kz };
      const owned = this._placedBlocks.get(key) ?? null;
      if (!owned) { skipped.push({ ...entry, reason: 'not_owned' }); continue; }
      const block = this.world.blockAt(cell);
      const name = String(block?.name ?? '').replace(/^minecraft:/i, '').toLowerCase();
      if (name !== owned.block) {
        skipped.push({ ...entry, reason: 'changed', expected: owned.block, found: name || null });
        continue;
      }
      const res = await this._mineBlock(block, timeoutMs);
      if (res?.ok) {
        this._forgetPlacement(cell);
        removed.push({ ...entry, block: owned.block });
      } else {
        failed.push({ ...entry, error: res?.error ?? 'mine_failed' });
      }
    }
    return { removed, skipped, failed };
  }

  // R4: `teardown_circuit` (o `teardown_circuit_<id>`) rimuove solo i blocchi
  // che il bot ha piazzato per un circuito: nessuna modifica redstone fuori da
  // ciò che ha costruito lui.
  async _teardownCircuit (id = null, { timeoutMs = 30000 } = {}) {
    const cells = this._ownedCircuitCells(id);
    if (!cells.length) {
      return { ok: false, error: id ? 'no_circuit_built' : 'nothing_to_tear_down', id, owned: this._ownedCircuitCells().length };
    }
    const { removed, skipped, failed } = await this._teardownCells(cells, { timeoutMs });
    const report = {
      ok: failed.length === 0,
      error: failed.length ? 'teardown_incomplete' : null,
      id,
      removed,
      skipped,
      failed,
      remaining: this._ownedCircuitCells(id).length,
    };
    this.log(report.ok ? 'circuit_torn_down' : 'circuit_teardown_failed', { id, removed: removed.length, skipped: skipped.length, failed: failed.length });
    return report;
  }

  async _buildCircuit (id, { facing = null, timeoutMs = 2500, rollback = true } = {}) {
    const def = this._circuitCatalogue().get(id) ?? null;
    if (!def) return { ok: false, error: 'unknown_circuit', id, known: [...this._circuitCatalogue().keys()] };
    if (!def.buildable) return { ok: false, error: 'circuit_not_buildable', id, reason: def.blocked ?? 'declared only' };
    const dir = facing ?? this._facingFromYaw();
    const plan = this._circuitPlan(def, { facing: dir });
    if (plan.missing.length) return { ok: false, error: 'missing_materials', id, missing: plan.missing, requires: def.requires };
    const blocked = circuitSiteBlocked(plan, cell => this.world.blockAt(cell));
    if (blocked.length) return { ok: false, error: 'circuit_site_blocked', id, blocked: blocked.slice(0, 8) };
    // R6 (sicurezza del bot): il cantiere non può contenere le celle che il bot
    // occupa e il bot non deve stare nel percorso di un pistone: il trigger
    // viene azionato davvero.
    const unsafe = circuitSafety(plan, { feet: this._feet });
    if (unsafe.length) return { ok: false, error: 'circuit_unsafe_for_bot', id, unsafe: unsafe.slice(0, 8) };

    const occupied = new Set(plan.steps.map(s => `${s.cell.x},${s.cell.y},${s.cell.z}`));
    const placed = [];
    const failed = [];
    for (const step of plan.steps) {
      const move = await this._approachFor(step.cell, occupied);
      if (move?.error) { failed.push({ label: step.label, item: step.item, cell: step.cell, error: move.error }); break; }
      const res = await this._placeCircuitStep(step);
      if (!res.ok) {
        failed.push({ label: step.label, item: step.item, cell: step.cell, error: res.error, facing: res.facing ?? null });
        break;
      }
      placed.push({ label: step.label, item: step.item, block: step.block, cell: step.cell, facing: res.facing ?? null });
      // R4: il registro impara che quella cella è di questo circuito.
      this._setPlacementCircuit(step.cell, id);
    }
    if (failed.length) {
      // R4: un cantiere a metà non resta in piedi. Il rollback è best effort e
      // il report conserva comunque quello che era stato piazzato.
      const back = rollback
        ? await this._teardownCells(placed.map(p => ({ cell: p.cell, label: p.label })), { timeoutMs: 30000 })
        : null;
      const report = {
        ok: false,
        error: 'circuit_incomplete',
        id,
        at: Date.now(),
        origin: plan.origin,
        facing: dir,
        placed,
        failed,
        post: [],
        trigger: null,
        success: null,
        verifyNote: null,
        delay: null,
        rollback: back ? { removed: back.removed.length, skipped: back.skipped, failed: back.failed.length } : null,
      };
      this._circuitLast = report;
      this.log('circuit_incomplete', { id, origin: plan.origin, placed: placed.length, error: failed[0].error, rolledBack: back?.removed.length ?? null });
      return { ...report, circuit: report };
    }

    // Il ritardo dei repeater è una proprietà, non un piazzamento (R1).
    const post = [];
    for (const entry of plan.post) {
      const res = await this._setRepeaterDelay(entry.delay, { position: entry.cell });
      post.push({ cell: entry.cell, delay: entry.delay, ok: res.ok === true, error: res.ok ? null : (res.error ?? null), actual: res.delay ?? null });
    }

    // Il censimento potrebbe precedere il cantiere: il trigger appena piazzato
    // deve comparire, quindi si forza la lettura prima di azionarlo.
    if (plan.trigger) this._redstoneCensus({ force: true });
    let trigger = null;
    let success = null;
    let delay = plan.measure
      ? {
        expectedTicks: plan.measure.expectedTicks,
        expectedMs: plan.measure.expectedTicks == null ? null : plan.measure.expectedTicks * TICK_MS,
        toleranceMs: plan.measure.toleranceMs,
        required: plan.measure.required,
        output: plan.measure.output,
        measuredMs: null,
        measuredTicks: null,
        ok: null,
        samples: 0,
      }
      : null;
    if (plan.trigger) {
      const triggeredAt = this._now();
      const on = await this._useRedstone({ position: plan.trigger.cell, restore: false, timeoutMs, guard: false });
      // La verifica si fa con il trigger ancora attivo: è quello lo stato che il
      // blueprint descrive. Il ripristino viene dopo e viene letto anche lui.
      if (on.ok) success = checkCircuitSuccess(def, { origin: plan.origin, facing: dir, read: cell => this.world.blockAt(cell) });
      // R4: il ritardo si *misura* dagli aggiornamenti di blocco arrivati dopo il
      // trigger, non si deduce dal blueprint.
      if (plan.measure?.output) {
        delay = {
          ...measureCircuitDelay({
            trace: this._redstoneTrace,
            cell: plan.measure.output,
            triggeredAt,
            expectedTicks: plan.measure.expectedTicks,
            toleranceMs: plan.measure.toleranceMs,
          }),
          required: plan.measure.required,
          output: plan.measure.output,
        };
      }
      const off = on.ok ? await this._useRedstone({ position: plan.trigger.cell, restore: false, timeoutMs, guard: false }) : null;
      trigger = {
        cell: plan.trigger.cell,
        item: plan.trigger.item,
        before: on.before ?? null,
        after: on.after ?? null,
        ok: on.ok === true,
        error: on.ok ? null : (on.error ?? null),
        restored: off?.ok ? (off.after ?? null) : null,
      };
    } else {
      success = checkCircuitSuccess(def, { origin: plan.origin, facing: dir, read: cell => this.world.blockAt(cell) });
    }

    const postFailed = post.filter(p => !p.ok);
    const verified = success && !success.empty ? success.ok : null;
    const delayUnmeasured = delay && delay.required && delay.measuredMs == null;
    const delayMismatch = delay && delay.measuredMs != null && delay.ok === false;
    const error = postFailed.length
      ? 'circuit_delay_not_confirmed'
      : (trigger && !trigger.ok ? (trigger.error ?? 'trigger_failed') : (verified === false ? 'circuit_verify_failed' : (delayUnmeasured ? 'circuit_delay_unmeasured' : (delayMismatch ? 'circuit_delay_mismatch' : null))));
    const report = {
      ok: error == null,
      error,
      id,
      // Il timestamp permette a un criterio di skill (`circuitBuilt`) di
      // distinguere un cantiere fatto *durante* la skill da uno che c'era già.
      at: Date.now(),
      origin: plan.origin,
      facing: dir,
      steps: placed.length,
      placed,
      post,
      trigger,
      success: success && !success.empty ? success : null,
      verifyNote: success && success.empty ? (def.verifyNote ?? null) : null,
      expectedDelayTicks: expectedDelayTicks(def),
      delay,
      rollback: null,
    };
    this._circuitLast = report;
    this.log(report.ok ? 'circuit_built' : 'circuit_failed', { id, facing: dir, origin: plan.origin, steps: placed.length, error, measuredMs: delay?.measuredMs ?? null });
    return { ...report, circuit: report };
  }

  // R2: aziona la leva/pulsante più vicino (o una cella data) e **verifica** il
  // cambio di stato sullo stato del mondo, non sul pacchetto inviato. Dopo il
  // click rilegge il censimento (forzato) per riportare quali output si sono
  // accesi: un input che non muove nulla resta un successo, ma si vede che gli
  // effetti sono vuoti.
  async _useRedstone ({ position = null, restore = true, timeoutMs = 2500, guard = true } = {}) {
    const census = this._redstoneCensus();
    if (!census.ready) return { ok: false, error: 'redstone_unknown' };
    const row = position ? componentAt(census, position) : this._pickRedstoneInput();
    if (!row) return { ok: false, error: 'no_redstone_input', position: position ?? null };
    if (!isRedstoneInput(row)) return { ok: false, error: 'not_an_input', name: row.name, position: row.position };
    // R6 (lag): lo stesso input non si aziona due volte in pochi millisecondi.
    // Un clock a 1 tick satura il BDS, e un "clock" costruito a colpi di
    // `use_redstone` è esattamente questo. Il cantiere è esente (`guard: false`)
    // perché il suo trigger e il ripristino sono due click voluti e contigui.
    if (guard) {
      const key = `${row.position.x},${row.position.y},${row.position.z}`;
      const last = this._lastRedstoneToggleAt.get(key) ?? 0;
      const waitMs = REDSTONE_TOGGLE_MIN_INTERVAL_MS - (Date.now() - last);
      if (waitMs > 0) {
        return { ok: false, error: 'redstone_toggle_too_soon', name: row.name, position: row.position, waitMs };
      }
      this._lastRedstoneToggleAt.set(key, Date.now());
    }
    if (this._reachabilityUsable() && !this.approachReachable(row.position, { range: 3.5, dy: 2 })) {
      return { ok: false, error: 'input_unreachable', name: row.name, position: row.position, distance: row.distance };
    }
    const before = inputOn(this.world.blockAt(row.position));
    // Senza stato leggibile non si aziona: "cambiato" non sarebbe verificabile.
    if (before == null) return { ok: false, error: 'redstone_state_unreadable', name: row.name, position: row.position };
    const flipped = await this._clickRedstoneInput(row.position, !before, { timeoutMs });
    if (!flipped.ok) return { ...flipped, name: row.name, before };
    const effects = activeOutputs(this._redstoneView({ force: true }));
    let restored = null;
    if (restore) {
      const back = await this._clickRedstoneInput(row.position, before, { timeoutMs });
      restored = back.ok === true;
      if (restored) this._redstoneView({ force: true });
    }
    this.log('use_redstone', {
      name: row.name, position: row.position, before, after: !before,
      effects: effects.map(e => e.name), restored,
    });
    return {
      ok: true, name: row.name, position: row.position, before, after: !before,
      effects, active: effects.length > 0, restored,
    };
  }

  // Un click su una cella, poi attesa che lo stato letto dal mondo sia quello
  // voluto: `redstone_not_toggled` è un fallimento tipizzato, non un timeout muto.
  async _clickRedstoneInput (cell, wanted, { timeoutMs = 2500 } = {}) {
    const before = inputOn(this.world.blockAt(cell));
    const yaw = this._yawTo(this._feet, { x: cell.x + 0.5, z: cell.z + 0.5 });
    const pitch = this._lookAt({ x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 }).pitch;
    await this._queueAuthInput({ yaw, pitch, transaction: this._blockUseTransaction(cell) });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = inputOn(this.world.blockAt(cell));
      if (state === wanted) return { ok: true, state };
      await delay(80);
    }
    const state = inputOn(this.world.blockAt(cell));
    return {
      ok: false,
      error: state == null ? 'redstone_state_unreadable' : 'redstone_not_toggled',
      position: cell, state, wanted, before,
    };
  }

  // ---- mining ------------------------------------------------------------------------

  // ---- scelta dell'utensile e del bersaglio di scavo ---------------------------------

  _blockInReach (candidate) {
    if (!this.position || !candidate?.position) return false;
    const p = candidate.position;
    return Math.hypot(this.position.x - (p.x + 0.5), this.position.y - (p.y + 0.5), this.position.z - (p.z + 0.5)) <= MINE_REACH;
  }

  _blockExposed (candidate) {
    const p = candidate?.position;
    if (!p) return false;
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const neighbor = this.world.blockAt({ x: p.x + dx, y: p.y + dy, z: p.z + dz });
      if (neighbor && this._passableForPath(neighbor)) return true;
    }
    return false;
  }

  // Predicato unico del bersaglio di scavo: il blocco è rompibile *adesso* (a
  // portata dagli occhi, `MINE_REACH`) oppure *dopo essersi avvicinati*, se
  // esiste una cella raggiungibile entro `MINE_APPROACH_RANGE`. `options()` e
  // l'esecutore scelgono il bersaglio con lo stesso `_pickMineTarget`, quindi il
  // verdetto è uno solo: ciò che non è minabile non viene nemmeno offerto.
  // Fail-open quando la componente raggiungibile non è affidabile (posizione
  // ignota, componente troncata): filtreremmo su una stima, non su un fatto.
  mineTargetReachable (candidate) {
    if (!candidate?.position) return false;
    if (this._blockInReach(candidate)) return true;
    if (!this._reachabilityUsable()) return true;
    return this.approachReachable(candidate.position, { range: MINE_APPROACH_RANGE, dy: 2 });
  }

  _gatherProtected (block) {
    if (!block?.position) return true;
    const pos = block.position, key = `${pos.x},${pos.y},${pos.z}`;
    if (DIG_PROTECTED.test(block.name ?? '') && !isCropBlock(block.name)) return true;
    // W0: la famiglia sculk è protetta per intero — scavarla è gia' una vibrazione.
    if (isSculkFamily(block.name)) return true;
    if (this._placedBlocks?.has(key) || this.memory?.placementAt?.(pos, this.dimension)) return true;
    const project = this.construction?.project;
    return project?.dimension === this.dimension && project.plan.cells.some(cell =>
      [cell, ...(cell.secondary ?? [])].some(row => `${row.position.x},${row.position.y},${row.position.z}` === key));
  }

  _pickMineTarget (blocks) {
    const candidates = (blocks || []).filter(b => b?.diggable && !this._gatherProtected(b));
    if (!candidates.length) return null;
    // W2: scavare dentro la sfera di un sensore sculk è una vibrazione, quindi si
    // sceglie un bersaglio silenzioso quando esiste. Se non esiste, il chiamante
    // usa `_vibrationBlockedTarget` per dire *perché* ("c'era ma era rumoroso" non
    // è "non c'era").
    const quiet = candidates.filter(b => !this._vibrationRiskAt(b.position));
    // Solo bersagli minabili: già a portata, altrimenti con una faccia scoperta e
    // raggiungibile a piedi. Il secondo ripiego era «qualunque faccia scoperta»,
    // anche a 10 blocchi dietro un muro: l'opzione veniva offerta e ogni
    // tentativo tornava `block_still_present`. Un blocco sepolto resta escluso
    // (per raggiungerlo serve prima `dig_down`), come prima di questa modifica.
    const usable = quiet.filter(b => this.mineTargetReachable(b));
    return usable.find(b => this._blockInReach(b))
      || usable.find(b => this._blockExposed(b))
      || null;
  }

  // Primo bersaglio di scavo rifiutato *solo* per il rischio di vibrazione.
  _vibrationBlockedTarget (blocks) {
    for (const b of blocks || []) {
      if (!b?.diggable || this._gatherProtected(b)) continue;
      const noise = this._vibrationRiskAt(b.position);
      if (noise) return { block: b.name ?? null, position: b.position, sensors: noise.count, nearest: noise.nearest };
    }
    return null;
  }

  // Una coltura acerba non si raccoglie: distruggerla non dà semi né raccolto
  // pieno. Maturità **ignota** (blocco finto, stato non leggibile) non blocca:
  // senza informazione ci si comporta come prima.
  _cropHarvestable (block) {
    const state = cropMaturity(block);
    return !state || state.mature !== false;
  }

  // Filtra le righe di `nearbyBlocks`/`findBlocks` tenendo solo le colture
  // raccoglibili; `immature` conta quelle lasciate crescere (per la diagnosi).
  _harvestableCrops (blocks) {
    const list = blocks || [];
    const ready = list.filter(b => this._cropHarvestable(this.world.blockAt(b.position)));
    return { ready, immature: list.length - ready.length };
  }

  _requiredToolKind (block) {
    const material = String(block?.material || '');
    for (const [needle, kind] of Object.entries(TOOL_MATERIAL)) {
      if (material.includes(needle)) return kind;
    }
    // Materiali come "incorrect_for_wooden_tool" non nominano il tipo: le chiavi
    // dei picconi dentro harvestTools lo implicano.
    if (block?.harvestTools && Object.keys(block.harvestTools).some(key => key in HARVEST_TOOL_RANK)) return 'pickaxe';
    return null;
  }

  _itemDamage (item) {
    // In Bedrock la durabilità consumata sta nell'NBT Damage; metadata resta 0.
    const nbtDamage = item?.extra?.nbt?.nbt?.value?.Damage?.value;
    if (typeof nbtDamage === 'number') return nbtDamage;
    return item?.metadata || 0;
  }

  _harvestRank (toolName) {
    return TOOL_HARVEST_RANK[String(toolName || '').split('_')[0]] || 0;
  }

  // Rank minimo che il data Bedrock associa al blocco (0 = a mano).
  _requiredHarvestRank (block) {
    if (!block?.harvestTools) return 0;
    let min = Infinity;
    for (const key of Object.keys(block.harvestTools)) {
      const rank = HARVEST_TOOL_RANK[key];
      if (rank != null) min = Math.min(min, rank);
    }
    return Number.isFinite(min) ? min : 1;
  }

  // True se il blocco lascia il drop con l'utensile dato (o a mano).
  _blockHarvestable (block, toolName) {
    if (!block?.harvestTools) return true;
    const kind = this._requiredToolKind(block);
    if (kind && toolName && toolName.endsWith(`_${kind}`)) {
      return this._harvestRank(toolName) >= this._requiredHarvestRank(block);
    }
    return false;
  }

  _bestInventoryTool (kind) {
    let best = null;
    for (const slot of this.inventorySlots) {
      const name = this._slotItemName(slot);
      if (!name || !name.endsWith(`_${kind}`)) continue;
      const rank = this._harvestRank(name);
      if (!best || rank > best.rank) best = { name, rank };
    }
    return best;
  }

  _toolRank (name) {
    return TOOL_TIER_SPEED[String(name).split('_')[0]] || 1;
  }

  // Valore di permanenza in hotbar: più basso = più sacrificabile. Serve a
  // liberare uno slot quando la hotbar è piena di materiali.
  _hotbarKeepScore (name) {
    if (!name) return -1;
    if (/^(dirt|sand|gravel|rotten_flesh|egg|.*_seeds|.*_sapling|.*_leaves|clay_ball)$/.test(name)) return 0;
    if (/(_pickaxe|_axe|_shovel|_hoe|_sword|^torch$|^crafting_table$|^furnace$|^(coal|charcoal|stick)$|_planks$|_log$|_stem$|_hyphae$)/.test(name)) return 100;
    return 10;
  }

  // Scambio diretto fra due slot del giocatore in UNA richiesta (type_id
  // 'swap', legacy 2: source+destination, nessun count). Serve quando
  // l'inventario e' pieno: take+place verso uno slot occupato da un item
  // diverso viene rifiutato con status 50, mentre 'swap' e' l'azione che BDS
  // si aspetta. Vedi schema in minecraft-data bedrock/1.26.51 protocol.json.
  async _swapSlots (srcIndex, dstIndex) {
    const item = this.inventorySlots[srcIndex];
    if (!item?.network_id) return { ok: false, error: 'missing_item' };
    await this._ensureInventoryOpen();
    const src = this._invSlotAsSource(srcIndex);
    const dst = this._invSlotToSlotInfo(dstIndex);
    const dstItem = this.inventorySlots[dstIndex];
    const response = await this._sendStackRequest([{
      type_id: 'swap', legacy_type_id: 2,
      source: this._slotInfo(src.container, src.slot, item.stack_id || 0),
      destination: this._slotInfo(dst.container, dst.slot, dstItem?.stack_id || 0),
    }]);
    if (String(response.status) !== 'ok' && response.status !== 0) {
      this.log('swap_failed', {
        status: response.status, srcIndex, dstIndex,
        item: this._slotItemName(item), src, dst,
        stack_id: item.stack_id ?? null, dst_stack_id: dstItem?.stack_id ?? null,
      });
      return { ok: false, error: `swap_failed_${response.status}` };
    }
    this._applyStackResponse(response);
    return { ok: true };
  }

  _hotbarSlotToEvict () {
    let best = 8;
    let bestScore = Infinity;
    for (let i = 0; i < 9; i++) {
      const score = this._hotbarKeepScore(this._slotItemName(this.inventorySlots[i]));
      if (score < bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  // Sposta un item tra slot del giocatore passando dal cursore (take+place).
  // I take/place valgono solo con una finestra aperta: senza container il
  // server risponde 49/50 (gli swap diretti cross-container non sono accettati).
  async _moveItemViaCursor (srcIndex, dstIndex) {
    const item = this.inventorySlots[srcIndex];
    if (!item?.network_id) return { ok: false, error: 'missing_item' };
    await this._ensureInventoryOpen();
    const src = this._invSlotAsSource(srcIndex);
    const dst = this._invSlotToSlotInfo(dstIndex);
    const count = item.count || 1;
    let response = await this._sendStackRequest([{
      type_id: 'take', legacy_type_id: 0, count,
      source: this._slotInfo(src.container, src.slot, item.stack_id || 0),
      destination: this._slotInfo('cursor', 0, 0),
    }]);
    if (String(response.status) !== 'ok' && response.status !== 0) {
      this.log('move_take_failed', {
        status: response.status, srcIndex, dstIndex, count,
        item: this._slotItemName(item), stack_id: item.stack_id ?? null, has_stack_id: item.has_stack_id ?? null,
        src, dst, cursor: this._cursor,
      });
      return { ok: false, error: `take_failed_${response.status}` };
    }
    this._applyStackResponse(response);
    const cursorStack = this._responseSlotStack(response, 'cursor', 0) ?? 0;
    response = await this._sendStackRequest([{
      type_id: 'place', legacy_type_id: 1, count,
      source: this._slotInfo('cursor', 0, cursorStack),
      destination: this._slotInfo(dst.container, dst.slot, 0),
    }]);
    if (String(response.status) !== 'ok' && response.status !== 0) {
      this.log('move_place_failed', {
        status: response.status, srcIndex, dstIndex, count,
        item: this._slotItemName(item), stack_id: item.stack_id ?? null,
        cursorStack, src, dst, cursor: this._cursor,
      });
      // Il cursore server-side conserva l'item: se resta sporco, ogni take
      // successivo fallirebbe con 50. Riprova a rimetterlo nella sorgente e
      // allinea il modello locale all'esito reale: un `_cursor = null`
      // ottimista qui nasconderebbe lo stack rimasto sul server, e nessuna
      // pulizia successiva (tutte guardate da `_cursor?.count > 0`) lo
      // svuoterebbe più.
      const undo = await this._sendStackRequest([{
        type_id: 'place', legacy_type_id: 1, count,
        source: this._slotInfo('cursor', 0, cursorStack),
        destination: this._slotInfo('hotbar_and_inventory', srcIndex, 0),
      }]).catch(() => null);
      if (undo && (String(undo.status) === 'ok' || undo.status === 0)) this._applyStackResponse(undo, { networkId: item.network_id });
      return { ok: false, error: `place_failed_${response.status}` };
    }
    this._applyStackResponse(response, { networkId: item.network_id });
    this._cursor = null;
    if (!response.containers?.length) {
      this.inventorySlots[dstIndex] = item;
      this.inventorySlots[srcIndex] = undefined;
    }
    return { ok: true };
  }

  // Sposta l'item meno prezioso della hotbar in un buco dell'inventario e
  // restituisce lo slot liberato. Con status 49/50 la copia locale è stantia:
  // resync e ritenta su un buco fresco.
  async _evictHotbarSlot () {
    for (let attempt = 0; attempt < 2; attempt++) {
      const evict = this._hotbarSlotToEvict();
      const item = this.inventorySlots[evict];
      if (!item?.network_id) return evict; // già vuoto
      const target = this.inventorySlots.findIndex((s, i) => i > 8 && !s?.network_id);
      if (target < 0) return -1;
      const moved = await this._moveItemViaCursor(evict, target);
      if (moved.ok) {
        this.log('hotbar_evict', { slot: evict, item: this._slotItemName(item), movedTo: target });
        return evict;
      }
      this.log('hotbar_evict_retry', { slot: evict, item: this._slotItemName(item), error: moved.error });
      this.log('hotbar_snapshot', {
        hotbar: this.inventorySlots.slice(0, 9).map(s => s ? `${this._slotItemName(s)}:${s.count}:${s.stack_id ?? 'none'}` : '-'),
        cursor: this._cursor,
      });
      try { await this._resyncByReconnect(); } catch (error) {
        this.log('inventory_resync_failed', { message: error.message });
        return -1;
      }
    }
    return -1;
  }

  async _moveSlotToHotbar (slotIndex) {
    const name = this._slotItemName(this.inventorySlots[slotIndex]);
    if (!name) throw new Error('missing_item');
    for (let attempt = 0; attempt < 2; attempt++) {
      if (slotIndex <= 8) return slotIndex;
      let free = this.inventorySlots.findIndex((s, i) => i < 9 && !s?.network_id);
      if (free < 0) free = await this._evictHotbarSlot();
      if (free < 0) {
        // Inventario completo (36/36): non esiste un buco dove evacuare lo slot
        // hotbar, ma la hotbar *piena* si puo' comunque scambiare. Senza questo
        // ramo l'inventario pieno rende impossibile selezionare qualsiasi
        // attrezzo (hotbar_full su dig/mine/place/eat) e il bot resta bloccato.
        const hot = this._hotbarSlotToEvict();
        const swapped = await this._swapSlots(slotIndex, hot);
        if (swapped.ok) {
          this.log('hotbar_swap_full', { name, slot: slotIndex, hot });
          return hot;
        }
        this.log('hotbar_swap_full_failed', { name, slot: slotIndex, hot, error: swapped.error });
        try { await this._resyncByReconnect(); } catch (error) { this.log('inventory_resync_failed', { message: error.message }); }
        throw new Error('hotbar_full');
      }
      const item = this.inventorySlots[slotIndex];
      this.log('swap_request', { name, slot: slotIndex, stack_id: item.stack_id ?? null, free });
      const moved = await this._moveItemViaCursor(slotIndex, free);
      if (moved.ok) return free;
      // Stack id locale stantio (tipico dopo un pickup): rileggi l'inventario
      // riconnettendosi, il login porta sempre l'inventory_content completo.
      this.log('swap_retry', { name, slot: slotIndex, stack_id: item.stack_id ?? null, error: moved.error });
      try { await this._resyncByReconnect(); } catch (error) { this.log('inventory_resync_failed', { message: error.message }); }
      slotIndex = this.inventorySlots.findIndex(s => this._slotItemName(s) === name && s.count > 0);
      if (slotIndex < 0) throw new Error('missing_item');
    }
    throw new Error('swap_failed');
  }

  // Porta in mano l'utensile giusto (miglior tier disponibile) per il blocco:
  // senza la scelta corretta BDS non fa cadere i drop (es. stone -> cobblestone).
  async _selectToolFor (block) {
    const kind = this._requiredToolKind(block);
    if (!kind) return null;
    let best = null;         // più veloce tra quelli che lasciano il drop
    let fallback = null;     // più veloce in assoluto, se nessuno può raccogliere
    for (let i = 0; i < Math.min(this.inventorySlots.length, 36); i++) {
      const slot = this.inventorySlots[i];
      if (!slot?.network_id) continue;
      const name = this._slotItemName(slot);
      if (!name || !name.endsWith(`_${kind}`)) continue;
      const rank = this._toolRank(name);
      const candidate = { index: i, name, rank };
      if (!fallback || rank > fallback.rank) fallback = candidate;
      if (!this._blockHarvestable(block, name)) continue;
      if (!best || rank > best.rank) best = candidate;
    }
    if (!best) best = fallback;
    if (!best) return null;
    if (best.index > 8) best.index = await this._moveSlotToHotbar(best.index);
    this._selectHotbarSlot(best.index);
    this.log('tool_selected', { tool: best.name, hotbar: best.index, block: block.name });
    return best.name;
  }

  _sendBlockAction (action, blockPos, face, { yaw, pitch }) {
    const actionMap = { start_break: 0, stop_break: 2, abort_break: 1, crack_break: 18, predict_break: 26, continue_break: 27 };
    const actionId = typeof action === 'string' ? (actionMap[action] ?? action) : action;
    const blockAction = action != null ? [{ action: actionId, position: { x: blockPos.x, y: blockPos.y, z: blockPos.z }, face }] : null;
    this._sendAuthInput({ yaw, pitch, blockAction });
  }

  _digTime (block) {
    if (!block || !block.diggable) return Infinity;
    const hardness = block.hardness;
    if (hardness < 0) return Infinity;
    if (hardness === 0) return 0;
    // Tempi vanilla: durezza * moltiplicatore / velocità dell'utensile giusto,
    // più un margine per la validazione server (predict mai troppo presto).
    const held = this.inventorySlots[this.selectedHotbar];
    const toolName = held ? this._slotItemName(held) : null;
    const kind = this._requiredToolKind(block);
    const hasCorrectTool = !!kind && !!toolName && toolName.endsWith(`_${kind}`);
    const canHarvest = this._blockHarvestable(block, toolName);
    const blockSpeed = hasCorrectTool ? this._toolRank(toolName) : 1;
    const ticks = Math.ceil(hardness * (canHarvest ? 30 : 100) / blockSpeed);
    return (Math.max(1, ticks) + 3) * 50;
  }

  _lookAt (target) {
    if (!this.position) return { yaw: 0, pitch: 0 };
    const dx = target.x - this.position.x;
    const dy = target.y - this.position.y; // Stored Bedrock position is at eye height.
    const dz = target.z - this.position.z;
    const yaw = -Math.atan2(dx, dz) * 180 / Math.PI;
    const dist = Math.hypot(dx, dz);
    const pitch = -Math.atan2(dy, dist) * 180 / Math.PI;
    return { yaw, pitch };
  }

  // Traverse every cell on the eye-to-target segment and intersect its
  // state-specific collision shapes. Unloaded cells remain fail-open.
  _entityVisible (entity, { ratio = 0.5 } = {}) {
    if (!entity?.position || !this.position) return { visible: true, unknown: true, blockedBy: null };
    const eye = this.position;
    const aim = { x: entity.position.x, y: entity.position.y + entityHeight(entity.type) * ratio, z: entity.position.z };
    return this._segmentVisible(eye, aim);
  }

  _segmentVisible (eye, aim, { targetCell = null, requireLoaded = false } = {}) {
    const axes = ['x', 'y', 'z'];
    const delta = Object.fromEntries(axes.map(axis => [axis, aim[axis] - eye[axis]]));
    const cell = Object.fromEntries(axes.map(axis => [axis, Math.floor(eye[axis])]));
    const next = Object.fromEntries(axes.map(axis => [axis, delta[axis] === 0 ? Infinity
      : ((cell[axis] + (delta[axis] > 0 ? 1 : 0)) - eye[axis]) / delta[axis]]));
    let readable = 0;
    let entry = 0;
    while (entry < 1) {
      const block = this.world.blockAt(cell);
      if (requireLoaded && (!block || block.name === 'unknown')) return { visible: false, unknown: true, blockedBy: null, blockedAt: { ...cell } };
      const atTarget = targetCell && ['x', 'y', 'z'].every(axis => cell[axis] === targetCell[axis]);
      if (block && !atTarget) {
        readable++;
        const shapes = Array.isArray(block.shapes) ? block.shapes
          : this._passable(block) ? [] : [[0, 0, 0, 1, 1, 1]];
        let hit = Infinity;
        for (const shape of shapes) {
          let low = 0, high = 1;
          for (let i = 0; i < axes.length; i++) {
            const axis = axes[i];
            const min = cell[axis] + shape[i], max = cell[axis] + shape[i + 3];
            if (delta[axis] === 0) {
              if (eye[axis] < min || eye[axis] > max) { high = -1; break; }
            } else {
              const a = (min - eye[axis]) / delta[axis], b = (max - eye[axis]) / delta[axis];
              low = Math.max(low, Math.min(a, b));
              high = Math.min(high, Math.max(a, b));
            }
          }
          if (low <= high && high > 0 && low < 1) hit = Math.min(hit, low);
        }
        if (hit !== Infinity) return { visible: false, blockedBy: block.name, blockedAt: { ...cell }, t: +hit.toFixed(2), unknown: false };
      }
      entry = Math.min(...Object.values(next));
      if (entry >= 1) break;
      for (const axis of axes) {
        if (next[axis] === entry) {
          cell[axis] += Math.sign(delta[axis]);
          next[axis] += 1 / Math.abs(delta[axis]);
        }
      }
    }
    return { visible: true, blockedBy: null, unknown: readable === 0 };
  }

  _faceForBlock (blockPos, fromPos) {
    // Determine which face of the block we are looking at based on relative position.
    const dx = fromPos.x - (blockPos.x + 0.5);
    const dy = fromPos.y - (blockPos.y + 0.5);
    const dz = fromPos.z - (blockPos.z + 0.5);
    const abs = { x: Math.abs(dx), y: Math.abs(dy), z: Math.abs(dz) };
    if (abs.y >= abs.x && abs.y >= abs.z) return dy > 0 ? 1 : 0; // top / bottom
    if (abs.x >= abs.z) return dx > 0 ? 5 : 4; // east / west
    return dz > 0 ? 3 : 2; // south / north
  }

  async _mineBlock (block, timeoutMs = 30000) {
    if (!this.client || !block?.position) throw new Error('no client or block');
    const pos = block.position;
    const blockData = this.world.blockAt(pos);
    if (!blockData || blockData.name !== block.name) throw new Error(`block ${block.name} not found at ${JSON.stringify(pos)}`);
    if (isBeeProtected(blockData.name)) return { ok: false, error: 'bee_block_protected', block: blockData.name, position: pos };
    // Guardia di maturità: ogni percorso di scavo passa da qui, quindi il filtro
    // delle opzioni non basta. Maturità ignota non blocca (fail-open).
    const cropState = cropMaturity(blockData);
    if (cropState && cropState.mature === false) {
      this.log('crop_not_mature', { crop: cropState.name, position: pos, growth: cropState.growth, maxGrowth: cropState.max });
      return { ok: false, error: 'crop_not_mature', crop: cropState.name, position: pos, growth: cropState.growth, maxGrowth: cropState.max };
    }
    // Guardia di respiro (M2): scavare con la testa sott'acqua ha un budget, e
    // ogni percorso di scavo passa da qui. Fuori dall'acqua non costa nulla.
    const breath = this._underwaterWorkAllowed();
    if (!breath.allowed) {
      return { ok: false, error: breath.reason, position: pos, block: blockData.name, depth: breath.depth ?? null, air: Number.isFinite(this.air) ? this.air : null };
    }
    // Utensile giusto in mano: senza il piccone la pietra non lascia cadere cobblestone.
    await this._selectToolFor(blockData);


    // Approach only outside survival mining reach, measured from the eyes.
    const dist = Math.hypot(this.position.x - (pos.x + 0.5),
      this.position.y - (pos.y + 0.5), this.position.z - (pos.z + 0.5));
    if (dist > MINE_REACH) {
      const dx = this.position.x - pos.x;
      const dz = this.position.z - pos.z;
      const approach = { x: this.position.x, y: this.position.y, z: this.position.z };
      if (Math.abs(dx) > Math.abs(dz)) {
        approach.x = pos.x + (dx > 0 ? 1.3 : -0.3);
        approach.z = pos.z + 0.5;
      } else {
        approach.x = pos.x + 0.5;
        approach.z = pos.z + (dz > 0 ? 1.3 : -0.3);
      }
      const arrived = await this._moveTo(approach, 0.4, timeoutMs);
      // `_moveTo` può fallire in silenzio (cava sotto un pavimento, muro in mezzo):
      // senza questa guardia la rottura partiva da fuori portata e ogni tentativo
      // tornava `block_still_present` senza mai dire *perché*. Stesso metro di
      // `_blockInReach`: un blocco non minabile non si rompe, si dichiara.
      const afterApproach = Math.hypot(this.position.x - (pos.x + 0.5),
        this.position.y - (pos.y + 0.5), this.position.z - (pos.z + 0.5));
      if (afterApproach > MINE_REACH) {
        const detail = { block: blockData.name, position: pos, distance: +afterApproach.toFixed(2), arrived: !!arrived };
        this.log('mine_target_unreachable', detail);
        return { ok: false, error: 'mine_target_unreachable', ...detail };
      }
    }
    if (!this.client) throw new Error('disconnected during approach');

    const neighbor = { x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 };
    const { yaw, pitch } = this._lookAt(neighbor);
    if (!this.client) throw new Error('disconnected while looking at block');

    const client = this.client;
    const face = this._faceForBlock(pos, this.position);
    const started = Date.now();
    const breakTimeMs = this._digTime(blockData);
    if (!Number.isFinite(breakTimeMs) || breakTimeMs > timeoutMs) return { ok: false, error: 'mining_timeout' };
    const runtimeId = this.world.runtimeIdAt(pos);
    if (runtimeId == null) return { ok: false, error: 'block_runtime_id_unknown' };
    const held = this.inventorySlots[this.selectedHotbar] || { network_id: 0 };
    let destroyedEvent = false;
    const onEvent = packet => {
      const p = packet.position;
      if (p && (packet.event === 'particle_destroy' || packet.event === 2001) &&
          Math.floor(p.x) === pos.x && Math.floor(p.y) === pos.y && Math.floor(p.z) === pos.z) destroyedEvent = true;
    };
    client.on('level_event', onEvent);
    const action = name => [{ action: name, position: pos, face }];
    const send = input => this._queueAuthInput({ yaw, pitch, ...input });
    const tool = this.world.registry?.items[held.network_id];
    const damage = blockData.hardness > 0 ? (tool?.name.endsWith('_sword') ? 2 : 1) : 0;
    // The wire variant is 9, but its compatibility action ID remains 11.
    // Container-only actions 7 and 8 are absent from the variant table.
    const itemStackRequest = this.serverAuthBlockBreaking && tool?.maxDurability && damage > 0 ? {
      request_id: this._nextStackRequest(),
      actions: [{ type_id: 'mine_block', legacy_type_id: 11,
        hotbar_slot: this.selectedHotbar, predicted_durability: this._itemDamage(held) + damage,
        network_id: held.stack_id || 0 }],
      custom_names: [], cause: 'chat_public',
    } : null;
    try {
      // Exactly one simulation input per 50 ms, sharing the idle heartbeat.
      const ticks = Math.max(1, Math.ceil(breakTimeMs / 50));
      if (this.serverAuthBlockBreaking && breakTimeMs === 0) {
        // Crops break during startDestroyBlock; prediction belongs to this tick.
        await send({ blockAction: [...action('start_break'), ...action('predict_break')], itemStackRequest });
      } else {
        await send({ blockAction: action('start_break') });
        for (let i = 1; i < ticks; i++) {
          if (Date.now() - started >= timeoutMs) throw new Error('mining_timeout');
          await send({ blockAction: action('continue_break') });
        }
        const finalAction = action('continue_break');
        if (this.serverAuthBlockBreaking) {
          await send({ blockAction: [...finalAction, ...action('predict_break')], itemStackRequest });
        } else {
          // Legacy use-item transaction is embedded to preserve tick ordering.
          await send({ blockAction: finalAction, transaction: {
            legacy: { legacy_request_id: 0 }, actions: [],
            data: { action_type: 'break_block', trigger_type: 'player_input', block_position: pos,
              face, hotbar_slot: this.selectedHotbar, hand: 'main_hand', held_item: held,
              player_pos: { ...this.position }, click_pos: { x: 0.5, y: 0.5, z: 0.5 },
              block_runtime_id: runtimeId >>> 0, client_prediction: 'success', client_cooldown_state: 'off' },
          } });
        }
      }
      // Correctly predicted breaks need not send update_block. Re-read the
      // authoritative section rather than trusting cached or predicted air.
      await delay(200);
      this.world.refreshSection(client, pos);
      const deadline = Math.min(started + timeoutMs, Date.now() + 3000);
      while (Date.now() < deadline) {
        if (this.client !== client) throw new Error('connection_lost');
        const remaining = this.world.blockAt(pos);
        if (remaining && remaining.name !== 'unknown' && remaining.name !== block.name) {
          await send({ blockAction: action('stop_break') });
          const picked = await this._pickupNearby();
          this._refreshNearby();
          const result = { ok: true, block: block.name, position: pos, confirmedBy: 'server_world',
            destroyedEvent, tool: this.world.registry?.items[held.network_id]?.name || null, ms: Date.now() - started, picked };
          if (cropState?.mature === true) {
            result.crop = { name: cropState.name, growth: cropState.growth, maxGrowth: cropState.max };
          }
          return result;
        }
        await delay(50);
      }
      await send({ blockAction: action('abort_break') });
      return { ok: false, error: this.world.blockAt(pos) ? 'block_still_present' : 'block_confirmation_timeout',
        block: block.name, position: pos, destroyedEvent };
    } finally {
      client.off('level_event', onEvent);
    }
  }

  // ---- discesa a gradini -------------------------------------------------------------

  _digDirection () {
    // Direzione cardinale della direzione in cui il bot guarda; i gradini
    // consecutivi restano sulla stessa linea e la risalita usa gli stessi nodi.
    // Se il planner ha fissato un waypoint, la scalinata scava verso di esso:
    // senza steering la direzione deriva con l'ultimo yaw (e il pozzo manca il
    // bersaglio).
    const w = this.plan?.waypoint;
    if (w && this._feet && Number.isFinite(w.x) && Number.isFinite(w.z)) {
      const dx = w.x - this._feet.x, dz = w.z - this._feet.z;
      if (Math.hypot(dx, dz) > 1.5) {
        return Math.abs(dx) >= Math.abs(dz)
          ? { dx: Math.sign(dx) || 1, dz: 0 }
          : { dx: 0, dz: Math.sign(dz) || 1 };
      }
    }
    const yaw = Number.isFinite(this._lastYaw) ? this._lastYaw : 0;
    const rad = yaw * Math.PI / 180;
    const dx = -Math.sin(rad), dz = Math.cos(rad);
    return Math.abs(dx) >= Math.abs(dz)
      ? { dx: Math.sign(dx) || 1, dz: 0 }
      : { dx: 0, dz: Math.sign(dz) || 1 };
  }

  // Celle di un gradino discendente: testa e piedi davanti al bot, più la cella
  // sotto il fronte che diventa il gradino. Scavarle tutte lascia un profilo a
  // scalini percorribile anche in salita (a differenza di un pozzo verticale).
  _digTargets () {
    if (!this.position || !this._feet) return { error: 'no_position' };
    const feet = this._feet;
    const fy = Math.floor(feet.y + 0.1);
    const fx = Math.floor(feet.x), fz = Math.floor(feet.z);
    const d = this._digDirection();
    const front = { x: fx + d.dx, y: fy, z: fz + d.dz };
    const head = { x: front.x, y: fy + 1, z: front.z };
    const step = { x: front.x, y: fy - 1, z: front.z };
    const support = { x: front.x, y: fy - 2, z: front.z };
    const targets = [];
    for (const [cell, label] of [[head, 'head'], [front, 'front'], [step, 'step']]) {
      const block = this.world.blockAt(cell);
      if (!block) return { error: 'world_not_loaded' };
      if (block.name === 'unknown') { targets.push({ cell, block, label, raw: true }); continue; }
      if (this._passableForPath(block)) continue;
      if (/water|lava/.test(block.name)) return { error: `unsafe_block_${label}` };
      if (DIG_PROTECTED.test(block.name)) return { error: `protected_${label}`, block: block.name };
      // W0: scavare dentro il raggio di un sensore sculk è già una vibrazione,
      // anche se il blocco non è della famiglia sculk.
      const noise = this._vibrationRiskAt(cell);
      if (noise) return { error: `vibration_risk_${label}`, block: block.name, position: cell, sensors: noise.count, nearest: noise.nearest };
      if (!block.diggable || !(block.hardness >= 0)) return { error: `not_diggable_${label}` };
      targets.push({ cell, block, label });
    }
    // Secondo passaggio: un fluido *adiacente* a una cella da scavare aprirebbe un
    // varco verso l'acqua (una scala che pesca in un lago si allaga) o verso la
    // lava. Il controllo viene dopo quello sul fluido nella cella stessa, così il
    // motivo riportato è quello più specifico.
    for (const target of targets) {
      if (target.raw) continue;
      const fluidRisk = digFluidRisk({ neighbors: this._fluidNeighbors(target.cell), avoidWater: true });
      if (fluidRisk.unsafe) return { error: `unsafe_${fluidRisk.reason}_${target.label}`, block: fluidRisk.block, position: fluidRisk.position };
    }
    // Nessun blocco da scavare (gradino già aperto: discesa interrotta o scalino
    // naturale): resta valida la sola discesa, con lo stesso controllo di appoggio.
    const supportBlock = this.world.blockAt(support);
    if (!supportBlock || !this._solidAt(support.x, support.y, support.z)) return { error: 'no_support_ahead' };
    return { direction: d, front, head, step, support, targets };
  }

  async _digDown (timeoutMs = 30000) {
    // M3: se una cascata utilizzabile è a portata, scendere da lì costa meno che
    // scavarsi una scala e non buca il terreno. Il verdetto è lo stesso di
    // `descend_waterfall`: senza il movimento in acqua (M1) non si usa, e lo
    // scavo resta identico a prima — che è l'accettazione "dig_* invariato
    // senza acqua".
    const fall = this._columnTactic('descend');
    if (fall.ok && fall.column) {
      const used = await this._useColumn('descend', { timeoutMs });
      if (used.ok) return { ok: true, via: 'waterfall', dug: [], moved: used.to, position: this.pos(), column: used.column };
    }
    const plan = this._digTargets();
    if (plan.error) return { ok: false, error: plan.error };
    const dug = [];
    for (const target of plan.targets) {
      const { cell, block, label } = target;
      const result = await this._mineTarget(target, timeoutMs);
      if (!result.ok) return { ...result, dug };
      dug.push({ label, block: block.name, position: cell, tool: result.tool ?? null });
    }
    try {
      const moved = await this._descendStair(plan);
      return { ok: true, dug, moved, position: this.pos() };
    } catch (error) {
      return { ok: false, error: `step_move_failed: ${error.message}`, dug, position: this.pos() };
    }
  }

  // Un semplice _moveTo verso il centro del gradino si ferma sul bordo (metà del
  // corpo resta sopra la cella ancora solida). Qui la spinta continua oltre il
  // centro finché i piedi non scendono di un blocco, poi si aspetta l'atterraggio.
  async _descendStair (plan, { moveMs = 8000, settleMs = 2000 } = {}) {
    const startY = this._feet.y;
    const stepCenter = { x: plan.step.x + 0.5, y: plan.step.y, z: plan.step.z + 0.5 };
    const beyond = { x: plan.step.x + plan.direction.dx * 2, y: plan.step.y, z: plan.step.z + plan.direction.dz * 2 };
    const path = [this._startNode(), plan.step, beyond];
    const motion = this._startMotion(path, beyond, stepCenter, 0.2, Date.now() + moveMs);
    const timedOut = await Promise.race([motion.then(() => false), delay(moveMs).then(() => true)]);
    if (timedOut) this._finishMotion('timeout');
    await motion;
    this._stopMotion();
    const settleUntil = Date.now() + settleMs;
    while (Date.now() < settleUntil && this._feet.y > startY - 0.9) await delay(50);
    return this._feet.y <= startY - 0.9;
  }

  // ---- low-level movement / auth input -----------------------------------------------
  //
  // BDS 1.26 usa il movimento server-authoritative: ogni tick il client invia un
  // player_auth_input con posizione simulata, move_vector e flag di intento; il tick
  // deve restare nella finestra di rewind (start_game.rewind_history_size) e viene
  // riallineato da correct_player_move_prediction. Il bot simula localmente camminata,
  // gravità, collisioni e gradini, e accetta le correzioni del server.

  _advanceTick () {
    this.tick++;
    if (this._tickAnchor) {
      const anchored = this._tickAnchor.tick + BigInt(Math.max(0, Math.round((Date.now() - this._tickAnchor.time) / 50)));
      if (anchored > this.tick) this.tick = anchored;
    }
    return this.tick;
  }

  _authTick () {
    const pending = this._authInputQueue.shift();
    if (pending) {
      if (pending.signal?.aborted) { pending.reject(new Error('action_cancelled')); return; }
      const tick = this._advanceTick();
      try {
        this._sendAuthInput({ ...pending.input, tick });
        pending.resolve();
      } catch (error) {
        pending.reject(error);
      }
      return;
    }
    const tick = this._advanceTick();
    // L'intento di cammino si fotografa **prima** della simulazione: `_driveMotion`
    // consuma il tick (fisica + `_updateMotionState`) e, quando il percorso finisce
    // dentro quel tick, spegne `motion.active`. Leggendo lo stato dopo la
    // simulazione il server riceveva `move {0,0}` — nessuna richiesta di muoversi —
    // mentre i piedi locali avanzavano e `correct_player_move_prediction` riportava
    // il bot indietro: misurato l'08/10/2026 su 9448 righe `auth_input`, **zero**
    // con moto attivo (e zero con `move.z` non nullo).
    const intent = this._motionIntent();
    this._driveMotion(tick);
    const use = this._motion?.active ? this._motion.useRequest : null;
    let yaw = intent ? intent.yaw : this._lastYaw;
    if (this.riding && this._ridingForward) yaw = this._ridingYaw;
    let pitch = this._lastPitch;
    let transaction = null;
    if (use && !use.sent && !this._openDoors.has(use.key)) {
      // Si rilegge il blocco prima di cliccare. Se il mondo lo dice già aperto la
      // credenza era vecchia e il click lo **richiuderebbe** addosso al bot (il
      // 08/10/2026 il bot è rimasto 28 s a un blocco dalla cella della porta
      // senza mai registrare un `door_state`): si registra e si passa.
      if (this._isOpenAt(use.pos)) {
        for (const part of this._doorParts(use.pos)) this._openDoors.add(this._doorKey(part));
        use.sent = true;
        use.at = Date.now();
      } else {
        const look = this._lookAt({ x: use.pos.x + 0.5, y: use.pos.y + 0.5, z: use.pos.z + 0.5 });
        yaw = look.yaw;
        pitch = look.pitch;
        this._lastYaw = yaw;
        this._lastPitch = pitch;
        transaction = this._blockUseTransaction(use.pos);
        use.sent = true;
        use.at = Date.now();
        // Il server risponde con update_block sulla cella della porta: osserva il cambio.
        for (const part of this._doorParts(use.pos)) {
          const key = this._doorKey(part);
          const runtimeId = this.world.runtimeIdAt(part);
          if (runtimeId != null && !this._doorWatchers.has(key)) this._doorWatchers.set(key, runtimeId);
        }
      }
    }
    try {
      this._sendAuthInput({ yaw, pitch, tick, transaction, intent });
    } catch (error) {
      this.log('auth_input_error', { message: error.message });
    }
    this._survivalTick();
  }

  // Fotografia dell'intento di cammino del tick: quello che il server deve
  // applicare in *questo* tick (direzione, salto, collisione), non quello che
  // resta dopo che la simulazione locale l'ha consumato. `null` quando il bot non
  // sta camminando o guida un veicolo (lì il moto lo applica il server).
  _motionIntent () {
    const motion = this._motion;
    if (!motion?.active || this.riding) return null;
    return {
      yaw: motion.yaw,
      forward: !!motion.forward,
      jumpHeldTicks: motion.jumpHeldTicks ?? 0,
      jumpStart: !!motion.jumpStart,
      collided: !!this._collidedHorizontally,
      onGround: !!this._onGround,
    };
  }

  _blockUseTransaction (pos) {
    const held = this.inventorySlots[this.selectedHotbar] || { network_id: 0 };
    return {
      legacy: { legacy_request_id: 0 },
      actions: [],
      data: {
        action_type: 'click_block',
        trigger_type: 'player_input',
        block_position: pos,
        face: this._faceForBlock(pos, this.position),
        hotbar_slot: this.selectedHotbar,
        hand: 'main_hand',
        held_item: held,
        player_pos: { ...this.position },
        click_pos: { x: 0.5, y: 0.5, z: 0.5 },
        block_runtime_id: this.world.runtimeIdAt(pos) >>> 0,
        client_prediction: 'success',
        client_cooldown_state: 'off',
      },
    };
  }

  _queueAuthInput (input) {
    const context = this._actionScope?.getStore();
    if (context?.signal.aborted) return Promise.reject(new Error('action_cancelled'));
    if (!this.client) return Promise.reject(new Error('connection_lost'));
    if (!this._authTickInterval) { this._sendAuthInput(input); return Promise.resolve(); }
    return new Promise((resolve, reject) => this._authInputQueue.push({ input, resolve, reject, signal: context?.signal }));
  }

  _sendAuthInput ({ yaw = 0, pitch = 0, moveVector = null, blockAction = null,
    transaction = null, itemStackRequest = null, tick = null, useItem = false,
    itemInteract = false, interactionModel = 'touch', interactRotation = null,
    intent = null } = {}) {
    if (!this.client) return;
    this.tick = tick != null ? tick : this._advanceTick();
    const position = { ...this.position };
    const inputData = ['block_breaking_delay_enabled'];
    // W1: lo sneak di navigazione (`_stealthSneaking`) si somma a quello di
    // costruzione; al server interessa un solo stato, con le transizioni a fronte
    // (`start_sneaking`/`stop_sneaking` solo quando cambia).
    const sneaking = !!(this._constructionSneaking || this._stealthSneaking);
    if (sneaking) inputData.push('sneaking');
    if (sneaking && !this._sneakDeclared) inputData.push('start_sneaking');
    if (!sneaking && this._sneakDeclared) inputData.push('stop_sneaking');
    this._sneakDeclared = sneaking;
    let move = moveVector || { x: 0, z: 0 };
    const motion = this._motion;
    if (this.riding) {
      // Veicolo montato: niente fisica locale, il server muove il mezzo.
      // client_predicted_vehicle (45) segnala la predizione del moto del veicolo.
      inputData.push('client_predicted_vehicle');
      if (!moveVector && this._ridingForward) {
        move = { x: 0, z: 1 };
        inputData.push('up');
      }
    } else if (!moveVector) {
      // Il moto dichiarato è quello **simulato in questo tick**: `intent` è la
      // fotografia presa prima di `_driveMotion` e resta valida anche quando la
      // simulazione l'ha appena concluso (altrimenti il server non saprebbe mai
      // che il bot ha camminato). Senza `intent` (input accodato fuori dal tick,
      // sonde) si legge lo stato corrente, come prima.
      const driving = intent ?? (motion?.active
        ? { forward: !!motion.forward, jumpHeldTicks: motion.jumpHeldTicks ?? 0, jumpStart: !!motion.jumpStart,
          collided: !!this._collidedHorizontally, onGround: !!this._onGround }
        : null);
      if (driving) {
        if (driving.forward) { move = { x: 0, z: 1 }; inputData.push('up'); }
        if (driving.jumpHeldTicks > 0) {
          inputData.push('jumping', 'want_up');
          if (driving.jumpStart) {
            inputData.push('start_jumping');
            if (motion) motion.jumpStart = false;
          }
        }
        if (driving.collided) inputData.push('horizontal_collision');
        if (driving.onGround) inputData.push('vertical_collision');
      }
    }
    if (this._freeJump?.heldTicks > 0) {
      inputData.push('jumping', 'want_up');
      if (this._freeJump.start) { inputData.push('start_jumping'); this._freeJump.start = false; }
    }
    // M1: nuoto. In acqua il client dichiara lo stato (start/stop_swimming, a
    // fronte) e l'intenzione verticale (want_up con il salto, want_down con lo
    // sneak). Senza input il bot affonda piano: è la gravità locale di sempre.
    // La sonda `swimMeasure` può forzare l'intenzione per misurare i ratei.
    const inWater = !this.riding && this._inWater();
    const headInWater = !this.riding && this._headInWater();
    const probeMode = this._swimProbe?.mode;
    const wantUp = probeMode === 'up' || (this._freeJump?.heldTicks > 0) || (motion?.jumpHeldTicks > 0);
    const wantDown = probeMode === 'down' || this._sneaking;
    const swimFlags = swimInputFlags({ inWater, headInWater, swimming: this._swimming, wantUp, wantDown });
    for (const flag of swimFlags) if (!inputData.includes(flag)) inputData.push(flag);
    if (headInWater !== this._swimming) this._swimming = headInWater;
    if (swimFlags.length) this.logger?.log?.('swim_input', { inWater, headInWater, wantUp, wantDown, flags: swimFlags });
    if (blockAction?.length) inputData.push('block_action');
    // `itemInteract` senza transazione serve alla sonda delle interazioni entità
    // (probeInteract): il flag è l'unico modo per dichiarare "uso un item" in un
    // frame in cui non c'è nulla da usare.
    if (transaction || itemInteract) inputData.push('item_interact');
    if (itemStackRequest) inputData.push('item_stack_request');
    // Scudo (e altri item "use"): il binario 53 è il modo con cui il client
    // dichiara di tenere premuto l'uso; il server da lì applica il blocco.
    if (useItem) inputData.push('start_using_item');
    const yawRad = yaw * Math.PI / 180, pitchRad = pitch * Math.PI / 180;
    // Diagnostica del movimento (MOVE_DEBUG): il tick dichiarato, l'intento e la
    // posizione locale che il server deve convalidare. Serve a distinguere «il
    // server corregge» da «il client non chiede di muoversi».
    if (process.env.MOVE_DEBUG) {
      this.log('auth_input', {
        tick: Number(this.tick),
        tickLag: this._tickAnchor ? Number(this.tick) - Number(this._tickAnchor.tick) : null,
        move: { x: +move.x.toFixed(3), z: +move.z.toFixed(3) },
        flags: inputData.filter(f => f === 'up' || f === 'jumping' || f === 'start_jumping' || f === 'sneaking' || f === 'want_up' || f === 'horizontal_collision'),
        feet: { x: +this._feet.x.toFixed(3), y: +this._feet.y.toFixed(3), z: +this._feet.z.toFixed(3) },
        onGround: this._onGround,
        motion: motion?.active ? { index: motion.index, len: motion.path?.length ?? null, forward: motion.forward, jumpHeldTicks: motion.jumpHeldTicks ?? 0 } : null,
        declared: !!intent,
      });
    }
    this.client.write('player_auth_input', {
      pitch,
      yaw,
      position,
      move_vector: move,
      head_yaw: yaw,
      input_data: inputData,
      input_mode: 'mouse',
      play_mode: 'screen',
      interaction_model: interactionModel,
      interact_rotation: interactRotation || { x: pitch, z: yaw },
      tick: this.tick,
      delta: { x: this._velocity.x, y: this._velocity.y, z: this._velocity.z },
      transaction,
      item_stack_request: itemStackRequest,
      block_action: blockAction?.length ? blockAction : null,
      analogue_move_vector: { x: 0, z: 0 },
      camera_orientation: { x: -Math.sin(yawRad) * Math.cos(pitchRad), y: -Math.sin(pitchRad), z: Math.cos(yawRad) * Math.cos(pitchRad) },
      raw_move_vector: move,
    });
  }

  // La quota del server è quella degli occhi: sottrarre EYE_HEIGHT va bene in
  // piedi, ma quando il server mette il giocatore a letto (o lo corregge) la
  // quota riportata può essere più bassa e infilare i piedi DENTRO il blocco del
  // pavimento. Lì la previsione locale blocca ogni passo (il blocco sotto esiste
  // anche nella cella accanto) e il bot resta congelato: live 04/10 il bot era
  // immobile sulla cella del letto, `goto_waypoint` -> `stuck` e ogni `sleep`
  // respinto. Se la cella dei piedi contiene un blocco solido *noto*, la quota
  // valida è il bordo superiore di quel blocco.
  _feetFromServerY (position) {
    if (!position) return null;
    const raw = position.y - EYE_HEIGHT;
    try {
      const bx = Math.floor(position.x), bz = Math.floor(position.z);
      const cell = Math.floor(raw + 1e-9);
      const block = this.world.blockAt({ x: bx, y: cell, z: bz });
      const top = cell + this._collisionHeight(block);
      if (block && block.name && block.name !== 'unknown' && this._solidAt(bx, cell, bz) && raw < top - 0.001) return top;
    } catch { /* mondo non caricato: si tiene la quota del server */ }
    return raw;
  }

  // Quota dei piedi da adottare da una correzione del server: `null` quando la
  // quota e' insostenibile per il mondo locale (bot tenuto sospeso in aria) e
  // non e' ne' un teletrasporto ne' una spinta verso il basso. In quel caso la
  // fisica locale resta padrona della caduta e la correzione non la rimette su.
  _serverFeetY (position) {
    const verified = this._feetFromServerY(position);
    if (verified == null) return null;
    if (this._supportedAt(position.x, verified, position.z)) return verified;
    if (this._feet && Math.abs(verified - this._feet.y) > 3) return verified;
    if (this._feet && verified < this._feet.y - 0.05) return verified;
    return null;
  }

  // C'e' un appoggio solido appena sotto la quota indicata? Usa la stessa
  // sonda del movimento (6 cm sotto i piedi): un blocco sconosciuto conta come
  // solido, quindi un mondo non caricato non fa rifiutare la quota del server.
  _supportedAt (x, feetY, z) {
    return this._collides(x, feetY - 0.06, z);
  }

  _syncFeetFromPosition (position = this.position) {
    if (!position) return;
    this._feet = { x: position.x, y: this._feetFromServerY(position), z: position.z };
  }

  _syncPositionFromFeet () {
    if (!this._feet) return;
    this.position = { x: this._feet.x, y: this._feet.y + EYE_HEIGHT, z: this._feet.z };
  }

  // ---- fisica locale ---------------------------------------------------------------

  // Blocchi che il bot può **aprire** con un `click_block` e che per il
  // pathfinding valgono come percorribili anche da chiusi: porta, cancelletto e
  // botola. Fino all'08/10/2026 questa famiglia conteneva solo `*_door`: un
  // cancelletto chiuso non era né percorribile (A* lo scavalcava o falliva) né
  // cliccabile, e `DIG_PROTECTED` vieta di romperlo, quindi un passaggio con un
  // cancelletto diventava una gabbia. La botola è inclusa perché `_doorAhead`
  // guarda solo le celle dei piedi e della testa: il portello **sotto** i piedi
  // non viene mai aperto, quindi non si sprofonda nella botola su cui si cammina.
  _isDoorBlock (block) {
    if (!block || typeof block.name !== 'string') return false;
    const name = block.name;
    return name.endsWith('_door') || name.endsWith('_fence_gate') || name.endsWith('_trapdoor');
  }

  // Celle occupate da un blocco apribile: la porta ne occupa due (metà inferiore
  // e superiore, l'open bit sta solo in basso), cancelletto e botola una sola.
  // `position` può essere una delle due metà della porta: si normalizza sulla base.
  _doorParts (position, block = this.world.blockAt(position)) {
    if (!this._isDoorBlock(block)) return [position];
    const properties = block.getProperties?.() ?? {};
    const base = properties.upper_block_bit === true || properties.upper_block_bit === 1
      ? { ...position, y: position.y - 1 } : position;
    return block.name.endsWith('_door')
      ? [base, { ...base, y: base.y + 1 }]
      : [base];
  }

  // Il mondo dice che è già aperto? Serve a non richiudere la porta creduta
  // chiusa: un click su una porta aperta la toggla, cioè la sbatte addosso al bot.
  _isOpenAt (position) {
    const parts = this._doorParts(position);
    const open = this.world.blockAt(parts[0])?.getProperties?.()?.open_bit;
    return open === true || open === 1;
  }

  _doorKey (position) {
    return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
  }

  // La porta che sta *addosso* al bot (metà inferiore o superiore): con un
  // `candidate` dice se è proprio quella cella. Serve a due cose: non richiudere
  // mai una porta sulla cella che il bot occupa — il server non gli lascia più
  // fare un passo e il vano diventa una gabbia (live 08/10/2026, tentativo 16: il
  // bot si chiuse dentro la porta di casa e i 40 minuti seguenti finirono in
  // `movement timeout`) — e non tenere `forward`+`jumping` dentro un vano porta,
  // dove la fisica locale perdona la cella occupata e il server no.
  _doorInOwnCell (candidate = null) {
    const feet = this._feet;
    if (!feet || !this.world) return null;
    const cx = Math.floor(feet.x), cz = Math.floor(feet.z), cy = Math.floor(feet.y + 1e-3);
    if (candidate && (Math.floor(candidate.x) !== cx || Math.floor(candidate.z) !== cz ||
      (candidate.y !== cy && candidate.y !== cy + 1))) return null;
    for (let dy = 0; dy <= 1; dy++) {
      const cell = { x: cx, y: cy + dy, z: cz };
      const block = this.world.blockAt(cell);
      if (this._isDoorBlock(block)) return { position: cell, parts: this._doorParts(cell, block), open: this._isOpenAt(cell) };
    }
    return null;
  }

  // Equipaggiamento rimandato dal server per il bot: serve il selected_slot
  // (hotbar) e, per l'offhand, la conferma autorevole di cosa c'è nello slot
  // della mano secondaria (vedi _equipShield).
  _onMobEquipment (packet) {
    this.selectedHotbar = packet.selected_slot;
    if (packet.window_id !== 'offhand') return;
    const name = packet.item?.name || (packet.item?.network_id != null ? this.world.registry?.items[packet.item.network_id]?.name : null);
    this.offhand = packet.item?.count
      ? { name: name || null, count: packet.item.count, network_id: packet.item.network_id ?? null, stack_id: packet.item.stack_id ?? null }
      : null;
    this._offhandConfirmedAt = Date.now();
  }

  _onBlockUpdate (position, runtimeId) {
    if (runtimeId == null) return;
    const key = this._doorKey(position);
    const closed = this._doorWatchers.get(key);
    const door = this.world.blockAt(position);
    const properties = door?.getProperties?.() ?? {};
    const base = properties.upper_block_bit === true || properties.upper_block_bit === 1
      ? { ...position, y: position.y - 1 } : position;
    const lower = this._isDoorBlock(door) ? this.world.blockAt(base) : null;
    const open = lower?.getProperties?.()?.open_bit;
    if (this._isDoorBlock(lower) && (typeof open === 'boolean' || open === 0 || open === 1)) {
      // Only the lower half carries the open bit. BDS can leave the upper
      // runtime id unchanged, and a villager can close either half again.
      for (const part of this._doorParts(base, lower)) {
        if (!this._isDoorBlock(this.world.blockAt(part))) continue;
        const partKey = this._doorKey(part);
        if (open) this._openDoors.add(partKey);
        else this._openDoors.delete(partKey);
        this._doorWatchers.delete(partKey);
      }
      this.log('door_state', { position: base, open: Boolean(open) });
    } else if (closed != null && runtimeId !== closed) {
      this._openDoors.add(key);
      this._doorWatchers.delete(key);
      this.log('door_opened', { key });
    }
    this._noteRedstoneUpdate(position);
  }

  _solidAt (x, y, z) {
    if (this._openDoors.has(`${x},${y},${z}`)) return false;
    const block = this.world.blockAt({ x, y, z });
    if (!block || block.name === 'unknown') return true; // non caricato o ignoto: conservativo
    // Una superficie da 1/16 non ferma il giocatore (auto-step): la trattiamo
    // come attraversabile anche nella fisica locale, altrimenti la previsione
    // di movimento rifiuta il passo e il bot non entra mai nel corridoio.
    if (this._lowProfile(block)) return false;
    return block.boundingBox === 'block';
  }

  // Cella libera *per un piazzamento*: deve contenere aria, non basta che non sia
  // solida. Una torcia o un cespuglio non sono solidi ma occupano la cella, e il
  // server rifiuta il piazzamento lasciando il blocco precedente (errore
  // `unexpected_block_*`). `unknown`/non caricato vale come occupato.
  _airAt (x, y, z) {
    const name = this.world.blockAt({ x, y, z })?.name;
    return name === 'air' || name === 'cave_air' || name === 'void_air';
  }

  // La cella della testa contiene acqua: alimenta il contatore d'aria (simulato).
  _headInWater () {
    const feet = this._feet;
    if (!feet) return false;
    const x = Math.floor(feet.x), y = Math.floor(feet.y + 0.1) + 1, z = Math.floor(feet.z);
    return this._fluidKindAt(x, y, z) === 'water';
  }

  // Un passo deliberato verso una cella, **senza** A*: serve dove il pathfinder non
  // deve passare (l'ingresso in acqua profonda, M1). Il percorso è di un solo nodo,
  // quindi `_standable` — e la sua regola "l'acqua profonda è un muro" — non entra
  // in gioco: la scelta è dell'azione, non del pianificatore.
  _stepToward (cell, { timeoutMs = 12000, stopDistance = 0.6 } = {}) {
    const node = { x: Math.floor(cell.x), y: Math.floor(cell.y), z: Math.floor(cell.z) };
    const target = { x: node.x + 0.5, y: node.y, z: node.z + 0.5 };
    return this._startMotion([node], node, target, stopDistance, Date.now() + timeoutMs);
  }

  // M1 (04/10/2026): **entrare** in acqua. Il pathfinder non attraversa l'acqua
  // profonda (M3: una discesa in un pozzo allagato da cui non si esce è una
  // trappola), ma per nuotare — e per misurare i ratei — bisogna poterci entrare.
  // La cella la sceglie il censimento (`deepWaterColumns`: una colonna, non un
  // punto) e il passo è deliberato.
  async enterWater ({ maxDistance = 6, depth = 2, timeoutMs = 12000 } = {}) {
    if (this.riding) return { ok: false, error: 'riding' };
    if (!this.spawned || !this._feet || !this.position) return { ok: false, error: 'not_spawned' };
    if (this._inWater()) {
      return { ok: true, already: true, position: this.pos(), headInWater: this._headInWater(), depth: null };
    }
    const census = this._fluidCensus();
    const feet = this._feet;
    // La scelta è per **vicinanza** (`from`/`maxDistance`): con un `limit` per
    // profondità lo stagno di due celle accanto al bot verrebbe scartato a favore
    // di un pozzo profondo a venti blocchi (live 04/10).
    const ranked = deepWaterColumns(census.cells?.water ?? [], {
      blockAt: typeof this.world?.blockAt === 'function' ? (p => this.world.blockAt(p) ?? null) : null,
      minDepth: depth,
      limit: 6,
      from: feet,
      maxDistance,
    });
    if (!ranked.length) {
      // Nessuna colonna profonda abbastanza vicina: non si tenta una nuotata che
      // non si può misurare, si dichiara il motivo.
      return { ok: false, error: 'no_deep_water', maxDistance, depth, water: census.water };
    }
    // Una colonna a tredici blocchi **sotto** i piedi non si entra con un passo:
    // camminarci verso vuol dire buttarsi in un dirupo, o arrampicarsi se è sopra.
    // Live 04/10: l'unica acqua profonda del mondo intorno al bot è un anfiteatro
    // allagato sotto la superficie, e `_stepToward` verso di lui avrebbe fatto
    // cadere il bot nel vuoto; la misura si fa dove si entra **camminando**.
    const LEVEL_ABOVE = 3;
    const LEVEL_DROP = 4;
    const level = ranked.filter(column => column.top <= feet.y + LEVEL_ABOVE && column.top >= feet.y - LEVEL_DROP);
    if (!level.length) {
      return { ok: false, error: 'no_water_at_level', maxDistance, depth, columns: ranked.map(c => c.position) };
    }
    // Una colonna **coperta** non si entra camminandoci: il passo arriva sul
    // coperchio e si ferma lì (`|Δy| < 3` fa dichiarare raggiunto il bersaglio),
    // quindi si scarta invece di fingere un ingresso. Live 04/10: lo stagno del
    // villaggio (il pozzo, coperto) ha l'acqua a y=73-74 e il bot in piedi a y=76.
    const open = level.filter(column => {
      const above = typeof this.world?.blockAt === 'function'
        ? this.world.blockAt({ x: column.position.x, y: column.top + 1, z: column.position.z })
        : null;
      if (!above) return true;
      if (above.boundingBox === 'empty') return true;
      return fluidKind(above.name) === 'water';
    });
    if (!open.length) {
      return { ok: false, error: 'water_covered', maxDistance, depth, columns: level.map(c => c.position) };
    }
    const attempts = [];
    for (const column of open.slice(0, 3)) {
      const cell = { x: column.position.x, y: column.top, z: column.position.z };
      const reason = await this._stepToward(cell, { timeoutMs });
      const entered = this._inWater();
      attempts.push({ cell, depth: column.depth, reason, entered });
      if (entered) {
        const report = {
          ok: true,
          entered: true,
          cell,
          depth: column.depth,
          headInWater: this._headInWater(),
          position: this.pos(),
        };
        this._waterEnterLast = report;
        this.log('enter_water', report);
        return report;
      }
    }
    this.log('enter_water_failed', { attempts });
    return { ok: false, error: 'water_not_reached', attempts };
  }

  // Un tick del budget d'aria. Fuori dall'acqua si recupera, con la testa
  // sott'acqua si consuma: nessun danno viene simulato (la salute è del server),
  // il contatore serve solo alle decisioni di sopravvivenza.
  _airTick () {
    this._airMeter.update({ headInWater: this._headInWater(), ticks: 1 });
    this.air = this._serverAir == null ? this._airMeter.air : this._serverAir;
  }

  _passable (block) {
    if (!block) return false;
    // Un hash non risolto (server più recente del registro) è conservativo:
    // la fisica locale lo tratta come solido, quindi anche il pathfinding deve
    // evitarlo, altrimenti pianifica percorsi attraverso muri invisibili.
    if (block.name === 'unknown') return false;
    if (block.name === 'air') return true;
    if (/water|lava/.test(block.name)) return false; // il bot non nuota
    return block.boundingBox === 'empty';
  }

  // Superfici basse che si calcano senza saltare: il tappeto (1/16) e i
  // sentieri (15/16) sono pavimento, non muri, ma il registry li riporta come
  // `boundingBox: 'block'` e il modello di movimento non ha l'auto-step che li
  // supera (~0.6). Senza questa eccezione il bot resta chiuso dietro due
  // `green_carpet` (visto dal vivo il 03/10: corridoio verso la porta rifiutato
  // dal pathfinding). Restano fuori letto, lastre e scalini: sono alti 0.5-0.56
  // e richiedono un salto, che il movimento non modella.
  _lowProfile (block) {
    const name = block?.name;
    if (typeof name !== 'string') return false;
    return /(_carpet|_path)$/.test(name) || name === 'moss_carpet';
  }

  // Acqua di guado: la cella contiene acqua, quindi `_passable` la rifiuta (il
  // bot non nuota), ma se la cella sopra è libera il bot cammina sul fondo con
  // la testa fuori — nessun nuoto e nessun flag di protocollo da indovinare.
  _wadeable (block) {
    return fluidKind(block?.name) === 'water';
  }

  // Il bot sta guadando adesso: piedi in acqua e testa fuori.
  _wading () {
    const feet = this._feet;
    if (!feet) return false;
    const x = Math.floor(feet.x), y = Math.floor(feet.y + 0.1), z = Math.floor(feet.z);
    if (this._fluidKindAt(x, y, z) !== 'water') return false;
    return this._fluidKindAt(x, y + 1, z) !== 'water';
  }

  // M1: acqua ai piedi (guado o nuoto) e acqua sulla testa (nuoto vero e proprio).
  _inWater () {
    const feet = this._feet;
    if (!feet) return false;
    return this._fluidKindAt(Math.floor(feet.x), Math.floor(feet.y + 0.1), Math.floor(feet.z)) === 'water';
  }

  // M1 (04/10/2026): i ratei del nuoto non si indovinano. Questa sonda tiene
  // un'intenzione verticale per qualche secondo e campiona la quota che il
  // **server** conferma (`this.position` arriva dai `move_player`), cosi' il
  // modello locale puo' usare numeri misurati invece di una stima. La semantica
  // viene dalla sessione umana: `down` = sneak (discesa rapida), `none` = nessun
  // input (discesa lenta), `up` = spacebar (risalita).
  async swimMeasure ({ mode = 'none', ms = 3000, sampleMs = 100 } = {}) {
    const wanted = ['none', 'up', 'down'].includes(mode) ? mode : null;
    if (!wanted) return { ok: false, error: 'unknown_mode', mode, modes: ['none', 'up', 'down'] };
    if (this.riding) return { ok: false, error: 'riding' };
    if (!this.spawned || !this.position) return { ok: false, error: 'not_spawned' };
    if (!this._inWater()) return { ok: false, error: 'not_in_water', position: { ...this.position } };
    const headInWater = this._headInWater();
    const duration = Math.max(200, Math.min(Number(ms) || 0, 20000));
    const step = Math.max(20, Math.min(Number(sampleMs) || 0, 1000));
    const t0 = Date.now();
    const y0 = this.position.y;
    const samples = [{ t: 0, y: +y0.toFixed(3), feet: +(this._feet?.y ?? y0).toFixed(3) }];
    this._swimProbe = { mode: wanted, until: t0 + duration };
    try {
      while (Date.now() < t0 + duration) {
        await delay(step);
        if (!this.position) break;
        samples.push({ t: Date.now() - t0, y: +this.position.y.toFixed(3), feet: +(this._feet?.y ?? this.position.y).toFixed(3) });
      }
    } finally {
      // La sonda deve spegnersi **sempre** (anche su disconnessione a meta'
      // misura): un'intenzione verticale lasciata accesa falserebbe l'azione dopo.
      this._swimProbe = null;
    }
    const last = samples[samples.length - 1];
    const seconds = (last.t || 1) / 1000;
    const deltaY = +(last.y - y0).toFixed(3);
    return {
      ok: true,
      mode: wanted,
      ms: duration,
      sampleMs: step,
      headInWater,
      air: this.air,
      airSource: this.airSource,
      from: +y0.toFixed(3),
      to: last.y,
      deltaY,
      seconds: +seconds.toFixed(2),
      ratePerSecond: +(deltaY / seconds).toFixed(3),
      samples,
    };
  }

  _headInWater () {
    const feet = this._feet;
    if (!feet) return false;
    return this._fluidKindAt(Math.floor(feet.x), Math.floor(feet.y + 1.1), Math.floor(feet.z)) === 'water';
  }

  // Per il pathfinding una porta chiusa è percorribile: il movimento la apre
  // con un'interazione click_block quando la incontra.
  _passableForPath (block) {
    return this._passable(block) || this._isDoorBlock(block);
  }

  // Blocco visto dal pathfinding: una cella può essere forzata a vuoto quando si
  // valuta un mondo ipotetico (es. il blocco che il bot sta per scavare).
  _blockForPath (x, y, z) {
    if (this._pathOverrides?.has(`${x},${y},${z}`)) return { name: 'air', boundingBox: 'empty' };
    return this.world.blockAt({ x, y, z });
  }

  _standable (x, y, z) {
    const feet = this._blockForPath(x, y, z);
    const head = this._blockForPath(x, y + 1, z);
    // Un guado è calpestabile, il nuoto no: la cella dei piedi può contenere
    // acqua *solo* se quella della testa è libera (acqua profonda resta un muro,
    // M1 la renderà percorribile col nuoto).
    if (!this._passableForPath(feet) && !this._wadeable(feet) && !this._lowProfile(feet)) return false;
    if (!this._passableForPath(head)) return false;
    // Una cella con lava in orizzontale ai piedi non è una destinazione: il bot
    // non è equipaggiato per attraversarla (M4 la renderà una scelta gated).
    if (this._lavaAdjacent(x, y, z)) return false;
    const below = this._blockForPath(x, y - 1, z);
    // N2: un appoggio che fa danno (magma, fuoco, cactus) non è un appoggio,
    // in nessuna dimensione: ci si sta sopra una volta sola.
    if (below && landingHazard(below.name)) return false;
    // Anche un hash non risolto sotto i piedi vale come piano d'appoggio.
    return !!below && (below.boundingBox === 'block' || below.name === 'unknown');
  }

  // Perché una cella non è calpestabile. Non è nel percorso caldo: serve a
  // diagnosticare un componente di **una sola cella** (bot sigillato) senza
  // leggere il mondo a mano. Rispecchia l'ordine dei controlli di `_standable`.
  _standableWhy (x, y, z) {
    const feet = this._blockForPath(x, y, z);
    const head = this._blockForPath(x, y + 1, z);
    const below = this._blockForPath(x, y - 1, z);
    const names = { feet: feet?.name ?? null, head: head?.name ?? null, below: below?.name ?? null };
    const cell = { x, y, z };
    if (!this._passableForPath(feet) && !this._wadeable(feet) && !this._lowProfile(feet)) return { ok: false, reason: 'feet', cell, ...names };
    if (!this._passableForPath(head)) return { ok: false, reason: 'head', cell, ...names };
    if (this._lavaAdjacent(x, y, z)) return { ok: false, reason: 'lava_adjacent', cell, ...names };
    if (below && landingHazard(below.name)) return { ok: false, reason: 'landing_hazard', cell, ...names };
    if (!below || (below.boundingBox !== 'block' && below.name !== 'unknown')) return { ok: false, reason: 'no_floor', cell, ...names };
    return { ok: true, reason: 'ok', cell, ...names };
  }

  // Celle occupate *adesso* dal corpo del bot (piedi e testa, con larghezza e
  // altezza del giocatore). La posizione è autorevole dal server: se la cella in
  // cui il bot si trova fosse davvero un muro, il server non ce l'avrebbe
  // lasciato. Senza questa eccezione il modello può *congelare* il bot dove sta:
  // il 03/10 in un villaggio una porta chiusa addosso al bot (piedi e testa nella
  // cella `wooden_door`) rendeva solidi i due blocchi del suo stesso corpo, ogni
  // passo collideva e il bot non usciva più, senza alcun errore da leggere.
  _selfCells () {
    const feet = this._feet;
    if (!feet) return null;
    const eps = 1e-9;
    const cells = new Set();
    for (let bx = Math.floor(feet.x - PLAYER_HALF_WIDTH + eps); bx <= Math.floor(feet.x + PLAYER_HALF_WIDTH - eps); bx++) {
      for (let by = Math.floor(feet.y + eps); by <= Math.floor(feet.y + PLAYER_HEIGHT - eps); by++) {
        for (let bz = Math.floor(feet.z - PLAYER_HALF_WIDTH + eps); bz <= Math.floor(feet.z + PLAYER_HALF_WIDTH - eps); bz++) {
          cells.add(`${bx},${by},${bz}`);
        }
      }
    }
    return cells;
  }

  _collides (x, y, z, { ignoreSelf = false } = {}) {
    const eps = 1e-9;
    const self = ignoreSelf ? this._selfCells() : null;
    const minX = Math.floor(x - PLAYER_HALF_WIDTH + eps), maxX = Math.floor(x + PLAYER_HALF_WIDTH - eps);
    const minY = Math.floor(y + eps), maxY = Math.floor(y + PLAYER_HEIGHT - eps);
    const minZ = Math.floor(z - PLAYER_HALF_WIDTH + eps), maxZ = Math.floor(z + PLAYER_HALF_WIDTH - eps);
    for (let bx = minX; bx <= maxX; bx++) {
      for (let by = minY; by <= maxY; by++) {
        for (let bz = minZ; bz <= maxZ; bz++) {
          if (self?.has(`${bx},${by},${bz}`)) continue;
          if (this._solidAt(bx, by, bz) && y < by + this._collisionHeight(this.world.blockAt({ x: bx, y: by, z: bz })) - eps) return true;
        }
      }
    }
    return false;
  }

  _collisionHeight (block) {
    // Sleeping spawn/corrections can leave the player on a bed. Using a full
    // cube lifts the prediction into the doorway lintel and causes rewinds.
    if (block?.name === 'bed' && block.shapes?.length) {
      const top = Math.max(...block.shapes.map(shape => shape[4]));
      if (Number.isFinite(top) && top > 0 && top <= 1) return top;
    }
    return 1;
  }

  // Diagnostica movimento: quale cella solida blocca il passo?
  _firstSolid (x, y, z) {
    const self = this._selfCells();
    const eps = 1e-9;
    const minX = Math.floor(x - PLAYER_HALF_WIDTH + eps), maxX = Math.floor(x + PLAYER_HALF_WIDTH - eps);
    const minY = Math.floor(y + eps), maxY = Math.floor(y + PLAYER_HEIGHT - eps);
    const minZ = Math.floor(z - PLAYER_HALF_WIDTH + eps), maxZ = Math.floor(z + PLAYER_HALF_WIDTH - eps);
    for (let bx = minX; bx <= maxX; bx++) {
      for (let by = minY; by <= maxY; by++) {
        for (let bz = minZ; bz <= maxZ; bz++) {
          if (self?.has(bx + ',' + by + ',' + bz)) continue;
          if (this._solidAt(bx, by, bz)) {
            const b = this.world.blockAt({ x: bx, y: by, z: bz });
            return { x: bx, y: by, z: bz, block: b && b.name ? b.name : '?' };
          }
        }
      }
    }
    return null;
  }

  _moveDiag (nx, y, nz, ax, az) {
    if (!process.env.MOVE_DEBUG) return;
    this._moveDiagCount = (this._moveDiagCount || 0) + 1;
    if (this._moveDiagCount > 60) return;
    this.log('move_blocked', {
      from: { x: +this._feet.x.toFixed(2), y: +this._feet.y.toFixed(2), z: +this._feet.z.toFixed(2) },
      to: { x: +nx.toFixed(2), y: +y.toFixed(2), z: +nz.toFixed(2) },
      step: { ax: +ax.toFixed(3), az: +az.toFixed(3) },
      solid: this._firstSolid(nx, y, nz),
      onGround: this._onGround,
    });
  }

  _physDiag () {
    if (!process.env.MOVE_DEBUG) return;
    const now = Date.now();
    if (this._lastPhysDiagAt && now - this._lastPhysDiagAt < 1500) return;
    this._lastPhysDiagAt = now;
    const feet = this._feet;
    if (!feet) return;
    const fx = Math.floor(feet.x), fy = Math.floor(feet.y + 1e-9), fz = Math.floor(feet.z);
    const cell = (x, y, z) => { const b = this.world.blockAt({ x, y, z }); return b && b.name ? b.name : "?"; };
    this.log('phys_probe', {
      feet: { x: +feet.x.toFixed(2), y: +feet.y.toFixed(2), z: +feet.z.toFixed(2) },
      position: this.position ? { x: +this.position.x.toFixed(2), y: +this.position.y.toFixed(2), z: +this.position.z.toFixed(2) } : null,
      onGround: this._onGround,
      feetCell: cell(fx, fy, fz),
      belowCell: cell(fx, fy - 1, fz),
      blockedStep: this._firstSolid(feet.x + 0.25, feet.y, feet.z),
      standable: this._standable(fx, fy, fz),
      reachableUsable: this._reachabilityUsable(),
      motion: this._motion?.active ? { index: this._motion.index, len: this._motion.path.length, forward: this._motion.forward, stuckTries: this._motion.stuckTries } : null,
    });
  }

  _moveHorizontal (dx, dz) {
    const feet = this._feet;
    const motion = this._motion;
    this._collidedHorizontally = false;
    for (const [ax, az] of [[dx, 0], [0, dz]]) {
      if (!ax && !az) continue;
      const nx = feet.x + ax, nz = feet.z + az;
      if (!this._collides(nx, feet.y, nz, { ignoreSelf: true })) {
        feet.x = nx;
        feet.z = nz;
        continue;
      }
      this._collidedHorizontally = true;
      this._moveDiag(nx, feet.y, nz, ax, az);
      // Gradino di un blocco: prepara un salto se lo spazio sopra è libero.
      if (this._onGround && !this._collides(nx, feet.y + 1, nz, { ignoreSelf: true }) && motion?.active && motion.jumpHeldTicks <= 0 && !this._doorInOwnCell()) {
        motion.jumpQueued = true;
        motion.jumpHeldTicks = 6;
        motion.jumpStart = true;
      }
    }
  }

  _moveVertical (vy) {
    const feet = this._feet;
    const ny = feet.y + vy;
    if (vy <= 0) {
      if (this._collides(feet.x, ny, feet.z)) {
        const by = Math.floor(ny);
        const tops = [];
        for (let bx = Math.floor(feet.x - PLAYER_HALF_WIDTH + 1e-9); bx <= Math.floor(feet.x + PLAYER_HALF_WIDTH - 1e-9); bx++) {
          for (let bz = Math.floor(feet.z - PLAYER_HALF_WIDTH + 1e-9); bz <= Math.floor(feet.z + PLAYER_HALF_WIDTH - 1e-9); bz++) {
            if (this._solidAt(bx, by, bz)) tops.push(by + this._collisionHeight(this.world.blockAt({ x: bx, y: by, z: bz })));
          }
        }
        const floorTop = tops.length ? Math.max(...tops) : by + 1;
        feet.y = Math.min(floorTop, feet.y);
        this._onGround = true;
        this._velocity.y = 0;
      } else {
        feet.y = ny;
        this._onGround = false;
      }
    } else if (this._collides(feet.x, ny, feet.z)) {
      this._velocity.y = 0;
    } else {
      feet.y = ny;
      this._onGround = false;
    }
  }

  _physicsStep () {
    if (!this._feet) return;
    this._airTick();
    const motion = this._motion;
    if (this._freeJump?.heldTicks > 0) this._freeJump.heldTicks--;
    // `jumpHeldTicks` è un impulso, non uno stato: senza il decremento il bot
    // teneva `want_up`/`jumping` per tutta la camminata (live 08/10/2026,
    // tentativo 16: `jumpHeldTicks: 6` costante per 40 s sotto il tetto di casa,
    // `horizontal_collision` a ogni tick, 0,6 blocchi netti in 45 s).
    if (motion?.jumpHeldTicks > 0) motion.jumpHeldTicks--;
    const freeJump = !!this._freeJump?.queued;
    if ((motion?.active && motion.jumpQueued || freeJump) && this._onGround) {
      // La gravità viene applicata nello stesso tick: compensa l'impulso così
      // che il primo spostamento verticale sia il salto pieno (apice ~1.3 blocchi).
      this._velocity.y = JUMP_VELOCITY + GRAVITY;
      this._onGround = false;
      if (motion?.active) motion.jumpQueued = false;
      if (this._freeJump) this._freeJump.queued = false;
    }
    const beforeX = this._feet.x, beforeZ = this._feet.z;
    if (motion?.active && motion.forward) {
      const yawRad = motion.yaw * Math.PI / 180;
      let speed = this._wading() ? WALK_SPEED * WADE_SPEED_FACTOR : WALK_SPEED;
      // W1: accovacciato si cammina al 30% della velocità. Se la previsione locale
      // resta *sotto* quella del server si viene corretti meno (e la velocità vera
      // la misura comunque `_lastSneak` sui pacchetti `move_player`).
      if (motion.sneak) speed *= SNEAK_SPEED_FACTOR;
      if (motion.preciseEdge) speed = Math.min(speed * 0.3, Math.hypot(motion.target.x - this._feet.x, motion.target.z - this._feet.z));
      const waypoint = motion.path?.[motion.index];
      if (waypoint && !motion.preciseEdge) speed = Math.min(speed, Math.hypot(waypoint.x + 0.5 - this._feet.x, waypoint.z + 0.5 - this._feet.z));
      this._moveHorizontal(-Math.sin(yawRad) * speed, Math.cos(yawRad) * speed);
    }
    this._velocity.x = this._feet.x - beforeX;
    this._velocity.z = this._feet.z - beforeZ;
    this._velocity.y = Math.max(this._velocity.y - GRAVITY, -1.2);
    this._moveVertical(this._velocity.y);
    this._syncPositionFromFeet();
  }

  _driveMotion (tick) {
    if (this.sleeping) {
      this._lastSimTick = tick;
      this._velocity = { x: 0, y: 0, z: 0 };
      return;
    }
    let steps = this._lastSimTick == null ? 1 : Number(tick - this._lastSimTick);
    if (!(steps >= 0)) steps = 0;
    if (steps > MAX_SIM_STEPS) steps = MAX_SIM_STEPS;
    for (let i = 0; i < steps; i++) this._physicsStep();
    this._lastSimTick = tick;
    this._physDiag();
    // Piedi dentro un blocco solido *noto*: la previsione locale blocca ogni passo
    // (il fondo esiste anche nella cella accanto) e il bot resta congelato. La
    // posizione e' comunque quella del server, quindi qui non si inventa nulla:
    // si riallinea il modello al bordo superiore del blocco in cui e' infilato.
    if (this._feet && this._onGround) {
      const fx = Math.floor(this._feet.x), fy = Math.floor(this._feet.y + 1e-9), fz = Math.floor(this._feet.z);
      const here = this.world.blockAt({ x: fx, y: fy, z: fz });
      const top = fy + this._collisionHeight(here);
      if (here && here.name && here.name !== 'unknown' && this._solidAt(fx, fy, fz) && this._feet.y < top - 0.001) {
        this.log('phys_unstick', { from: +this._feet.y.toFixed(2), to: top, block: here.name, cell: { x: fx, y: fy, z: fz } });
        this._feet.y = top;
        this._velocity.y = 0;
        this._syncPositionFromFeet();
      }
    }
    if (this._motion?.active) this._updateMotionState();
    this._sampleMotionTrack();
  }

  // ---- percorso e stato del movimento ------------------------------------------------

  _startMotion (path, goalNode, target, stopDistance, deadline, { arrivalVerticalTolerance = 3, sneak = false } = {}) {
    return new Promise(resolve => {
      // Un movimento ancora pendente verrebbe sovrascritto e la sua promise non
      // sarebbe piu' risolvibile (nessuno la risolve): la si chiude esplicitamente.
      if (this._motion?.active) this._finishMotion('superseded');
      this._motion = {
        active: true, path, index: Math.min(1, path.length - 1), goalNode,
        target, stopDistance, deadline, resolve, arrivalVerticalTolerance, sneak: !!sneak, track: this._motionTrack ?? null,
        yaw: this._yawTo(this._feet, { x: goalNode.x + 0.5, z: goalNode.z + 0.5 }),
        forward: true, jumpQueued: false, jumpHeldTicks: 0, jumpStart: false,
        bestWaypointDist: Infinity, lastProgressAt: Date.now(), stuckTries: 0,
        bestTargetDist: Infinity, lastTargetProgressAt: Date.now(), lastIndexProgressAt: Date.now(),
        useRequest: null, guard: null,
      };
      // `_updateMotionState` gira solo sui tick del client: se la connessione cade (o
      // il mondo smette di tickare) la promise non verrebbe mai risolta e l'await
      // resterebbe appeso. Il timer la chiude comunque entro la deadline.
      const guardMs = Math.max(250, (Number.isFinite(deadline) ? deadline - Date.now() : 0) + 500);
      this._motion.guard = setTimeout(() => {
        if (this._motion && this._motion.active && this._motion.resolve === resolve) this._finishMotion('timeout');
      }, guardMs);
    });
  }

  _stopMotion () {
    if (this._motion?.track) { this._endMotionTrack(this._motion.track); this._motion.track = null; }
    this._motion = null;
  }

  // ---- W1: velocità misurata (lo sneak si verifica, non si presume) -----------
  // La posizione che conta è quella del **server** (`this.position` arriva dai
  // pacchetti `move_player`): il flag `sneaking` è solo una richiesta, il server
  // può muovere il bot a velocità di cammino lo stesso.
  _beginMotionTrack ({ sneak = false } = {}) {
    this._stealthSneaking = !!sneak;
    const track = { sneak: !!sneak, at: Date.now(), distanceM: 0, samples: 0, skipped: 0, closed: false, last: null };
    this._motionTrack = track;
    return track;
  }

  _sampleMotionTrack () {
    const track = this._motionTrack;
    if (!track || track.closed || !this.position) return;
    const x = this.position.x, z = this.position.z;
    if (track.last) {
      const step = Math.hypot(x - track.last.x, z - track.last.z);
      // Un salto grande non è un passo ma una correzione/teletrasporto: contarlo
      // gonfierebbe la velocità misurata e farebbe fallire uno sneak vero.
      if (step <= 1) track.distanceM += step;
      else track.skipped++;
    }
    track.last = { x, z };
    track.samples++;
  }

  _endMotionTrack (track = this._motionTrack) {
    if (this._motionTrack === track) this._motionTrack = null;
    if (this._stealthSneaking) this._stealthSneaking = false;
    if (!track || track.closed) return null;
    track.closed = true;
    const seconds = (Date.now() - track.at) / 1000;
    const verdict = classifySneakSpeed({ distanceM: track.distanceM, seconds });
    this._lastSneak = { ...verdict, sneak: track.sneak, samples: track.samples, skipped: track.skipped };
    return this._lastSneak;
  }

  _finishMotion (reason) {
    const motion = this._motion;
    if (!motion) return;
    if (motion.guard) { clearTimeout(motion.guard); motion.guard = null; }
    // W1: il movimento è finito, la misura di velocità si chiude adesso (anche su
    // `stuck`/`timeout`): un verdetto di silenzio vale solo sul tratto percorso.
    if (motion.track) { this._endMotionTrack(motion.track); motion.track = null; }
    motion.active = false;
    motion.forward = false;
    const resolve = motion.resolve;
    motion.resolve = null;
    if (resolve) resolve(reason);
    // Movimento concluso: è il momento giusto per registrare le scoperte e i
    // checkpoint (durante il pathfinding _refreshNearby non gira). Dedup in
    // _maybeRememberDiscoveries (chunk + cooldown), quindi non è per-tick.
    this._maybeRememberDiscoveries();
  }

  _updateMotionState () {
    const motion = this._motion;
    if (!motion?.active) return;
    if (Date.now() > motion.deadline) return this._finishMotion('timeout');
    const feet = this._feet;
    if (motion.preciseEdge) {
      if (Math.hypot(feet.x - motion.target.x, feet.z - motion.target.z) < 0.025 && Math.abs(feet.y - motion.target.y) < 0.15) return this._finishMotion('goal');
      // The player bounding box must retain a known support and stay within
      // the small approved overhang. No jump or forward tick can extend it.
      const base = motion.edgeBase;
      if (Math.abs(feet.x - base.x - 0.5) > 0.6 || Math.abs(feet.z - base.z - 0.5) > 0.6 || Math.abs(feet.y - base.y) > 0.2) return this._finishMotion('unsafe_edge');
      motion.yaw = this._yawTo(feet, motion.target); motion.forward = true;
      return;
    }

    // Bersaglio richiesto raggiunto (in orizzontale, con tolleranza verticale).
    if (Math.hypot(feet.x - motion.target.x, feet.z - motion.target.z) <= motion.stopDistance &&
        Math.abs(feet.y - motion.target.y) < (motion.arrivalVerticalTolerance ?? 3)) {
      return this._finishMotion('goal');
    }

    // Nessun progresso *verso il bersaglio*: la distanza dal punto d'arrivo è
    // l'unica misura che non si può migliorare restando fermi o girando in tondo,
    // mentre il minimo per-waypoint sì (un nuovo minimo verso il prossimo nodo
    // azzera `lastProgressAt` anche se il bot non si sta avvicinando a nulla).
    const targetHoriz = Math.hypot(feet.x - motion.target.x, feet.z - motion.target.z);
    if (targetHoriz < (motion.bestTargetDist ?? Infinity) - 0.25) {
      motion.bestTargetDist = targetHoriz;
      motion.lastTargetProgressAt = Date.now();
    } else if (Date.now() - Math.max(motion.lastTargetProgressAt ?? motion.lastProgressAt ?? 0, motion.lastIndexProgressAt ?? 0) > MOVE_STALL_MS) {
      // Anche il **nodo di percorso** superato è progresso: uscendo da una casa il
      // tratto che porta alla porta si allontana dal bersaglio, e senza questo
      // termine una deviazione corretta veniva chiusa come `no_progress` dopo 8 s
      // (live 08/10/2026: `follow_player` fermo a un blocco dalla porta per 28 s).
      return this._finishMotion('no_progress');
    }

    let waypoint = motion.path[motion.index];
    if (!waypoint) return this._finishMotion('path_end');
    let wpHoriz = Math.hypot(feet.x - (waypoint.x + 0.5), feet.z - (waypoint.z + 0.5));
    const next = motion.path[motion.index + 1];
    const doorNode = node => node && [node.y, node.y + 1].some(y => this._isDoorBlock(this.world.blockAt({ x: node.x, y, z: node.z })));
    // Centre the approach before entering a one-block doorway. A 0.4-block
    // shortcut can leave the player's body touching the open door panel.
    const waypointTolerance = Math.min(next ? 0.4 : motion.stopDistance, doorNode(waypoint) || doorNode(next) ? 0.08 : 0.4);
    if (wpHoriz < waypointTolerance && Math.abs(feet.y - waypoint.y) < (next ? 1.05 : Math.min(1.05, motion.arrivalVerticalTolerance ?? 3))) {
      motion.index++;
      motion.bestWaypointDist = Infinity;
      motion.lastProgressAt = Date.now();
      motion.lastIndexProgressAt = Date.now();
      motion.stuckTries = 0;
      waypoint = motion.path[motion.index];
      if (!waypoint) return this._finishMotion('path_end');
      wpHoriz = Math.hypot(feet.x - (waypoint.x + 0.5), feet.z - (waypoint.z + 0.5));
    } else if (wpHoriz < motion.bestWaypointDist - 0.02) {
      motion.bestWaypointDist = wpHoriz;
      motion.lastProgressAt = Date.now();
    } else if (Date.now() - motion.lastProgressAt > 2500) {
      // Fermarsi davanti a una porta chiusa è **voluto**: il click è partito e il
      // server ha 3 s per aprirla. Questa attesa non è uno stallo e, se scade,
      // l'arresto ha un nome (`door_blocked`); senza la guardia lo stall da 2,5 s
      // dichiarava `stuck` (o faceva saltare) e la diagnosi non arrivava mai
      // (live 08/10/2026: tre `stuck` davanti a una porta chiusa, zero righe utili).
      const waitingDoor = motion.useRequest && !this._openDoors.has(motion.useRequest.key);
      if (waitingDoor && Date.now() - motion.useRequest.at > 3000) return this._doorBlockedVerdict(motion, feet);
      if (waitingDoor) {
        motion.lastProgressAt = Date.now();
      } else if (motion.stuckTries < 1) {
        // Dentro il vano di una porta il salto non tira fuori il bot: la fisica
        // locale perdona la cella che occupa, il server no. Invece di tenere
        // `forward`+`jumping` per tutto il budget si chiude con un verdetto
        // tipizzato, così il controller ripianifica invece di aspettare 45 s
        // (live 08/10/2026, tentativo 16: quaranta minuti dentro la casa della scala).
        const ownDoor = this._doorInOwnCell();
        if (ownDoor) {
          this.log('doorway_stuck', {
            door: ownDoor.parts[0], open: ownDoor.open, stuckTries: motion.stuckTries,
            from: feet ? { x: +feet.x.toFixed(2), y: +feet.y.toFixed(2), z: +feet.z.toFixed(2) } : null,
          });
          return this._finishMotion('stuck_in_doorway');
        }
        motion.stuckTries++;
        motion.jumpQueued = true;
        motion.jumpHeldTicks = 6;
        motion.jumpStart = true;
        motion.lastProgressAt = Date.now();
      } else {
        return this._finishMotion('stuck');
      }
    }

    motion.yaw = this._yawTo(feet, { x: waypoint.x + 0.5, z: waypoint.z + 0.5 });
    this._lastYaw = motion.yaw;
    motion.forward = true;
    // Porta chiusa davanti: apila con un click_block, resta fermo finché il server non l'apre.
    const door = this._doorAhead();
    if (door && !motion.useRequest) {
      motion.useRequest = { pos: door, key: `${door.x},${door.y},${door.z}`, sent: false, at: Date.now() };
      motion.lastProgressAt = Date.now();
    } else if (!door && motion.useRequest && this._openDoors.has(motion.useRequest.key)) {
      motion.useRequest = null;
    }
    if (motion.useRequest && Date.now() - motion.useRequest.at > 3000 && !this._openDoors.has(motion.useRequest.key)) {
      return this._doorBlockedVerdict(motion, feet);
    }
    // Salto preparatorio per i gradini in salita.
    if (this._onGround && waypoint.y > feet.y + 0.5 && wpHoriz < 2.4 && motion.jumpHeldTicks <= 0 && !this._doorInOwnCell()) {
      motion.jumpQueued = true;
      motion.jumpHeldTicks = 6;
      motion.jumpStart = true;
    }
  }

  // Una porta che non si apre dopo il click è la ragione vera di uno `stuck` che
  // altrimenti resta muto: l'08/10/2026 il letto "irraggiungibile" era un vano
  // porta chiuso e nessuna riga del ledger lo nominava (solo `stuck`).
  _doorBlockedVerdict (motion, feet) {
    this.log('door_blocked', {
      position: { ...motion.useRequest.pos },
      waitedMs: Date.now() - motion.useRequest.at,
      from: feet ? { x: +feet.x.toFixed(2), y: +feet.y.toFixed(2), z: +feet.z.toFixed(2) } : null,
    });
    return this._finishMotion('stuck');
  }

  _doorAhead () {
    const motion = this._motion;
    if (!motion?.active) return null;
    const feet = this._feet;
    const yawRad = motion.yaw * Math.PI / 180;
    const dx = -Math.sin(yawRad), dz = Math.cos(yawRad);
    const stepX = Math.abs(dx) >= Math.abs(dz) ? Math.sign(dx) : 0;
    const stepZ = stepX === 0 ? Math.sign(dz) : 0;
    const cx = Math.floor(feet.x) + stepX;
    const cz = Math.floor(feet.z) + stepZ;
    const cy = Math.floor(feet.y + 0.1);
    // Prima la porta *addosso* al bot: se una porta si chiude sulla sua cella
    // (un villager nel villaggio, 03/10) il server non gli lascia fare alcun
    // passo — la fisica locale può anche perdonare la cella che occupa, ma il
    // movimento lo rifiuta il server. Va aperta come quella davanti, con lo
    // stesso click_block e la stessa conferma dal cambio di runtime id.
    const fx = Math.floor(feet.x), fz = Math.floor(feet.z);
    // Oltre alla cella addosso e a quella davanti (yaw) si guarda il **nodo di
    // percorso** che il bot sta attraversando: è il blocco apribile che gli
    // serve davvero. Uscendo da una casa il nodo davanti è la porta, mentre lo
    // yaw punta al giocatore fuori, spesso in diagonale: la porta restava
    // invisibile e il bot si fermava contro di essa (live 08/10/2026).
    const cells = [{ x: fx, z: fz }, { x: cx, z: cz }];
    for (const node of [motion.path?.[motion.index], motion.path?.[motion.index + 1]]) {
      if (!node) continue;
      if (Math.hypot(node.x + 0.5 - feet.x, node.z + 0.5 - feet.z) > 2.5) continue;
      if (!cells.some(cell => cell.x === node.x && cell.z === node.z)) cells.push({ x: node.x, z: node.z });
    }
    for (const cell of cells) {
      for (const y of [cy, cy + 1]) {
        const key = `${cell.x},${y},${cell.z}`;
        if (this._openDoors.has(key)) continue;
        if (this._isDoorBlock(this.world.blockAt({ x: cell.x, y, z: cell.z }))) return { x: cell.x, y, z: cell.z };
      }
    }
    return null;
  }

  // ---- pathfinding A* sul mondo caricato ---------------------------------------------

  _startNode () {
    // Senza una posizione nota (piedi non ancora risolti, es. subito dopo lo
    // spawn o nei test con adapter parziale) non c'è nodo di partenza.
    if (!this._feet) return null;
    const x = Math.floor(this._feet.x), z = Math.floor(this._feet.z);
    const y = Math.floor(this._feet.y + 1e-3);
    if (this._standable(x, y, z)) return { x, y, z };
    // A fractional bed top occupies the feet voxel. Anchor the graph in the
    // same column before considering a neighbouring cell through a doorway.
    if (this._feet.y > y + 0.001 && this._supportedAt(this._feet.x, this._feet.y, this._feet.z) && this._standable(x, y + 1, z)) return { x, y: y + 1, z };
    for (let r = 1; r <= 2; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          for (const dy of [0, -1, 1, -2, 2]) {
            if (this._standable(x + dx, y + dy, z + dz)) return { x: x + dx, y: y + dy, z: z + dz };
          }
        }
      }
    }
    return { x, y, z };
  }

  // ---- raggiungibilità ---------------------------------------------------------------

  // Un componente di una sola cella significa modello del mondo incompleto (o
  // bot davvero incastrato): i filtri di raggiungibilità sarebbero ciechi e
  // bloccherebbero ogni azione, quindi si disattivano (fail-open).
  _reachabilityUsable () {
    if (!this._feet) return false; // posizione ignota: filtri spenti (fail-open)
    const reach = this.reachableCells();
    // Un componente troncato (mondo grande) non è una verità completa: i
    // filtri vanno spenti anche lì, non solo sul componente degenere.
    return reach.cells.size > 1 && !reach.truncated;
  }

  // Celle calpestabili raggiungibili dai piedi con i movimenti consentiti
  // (`_neighbors`). `overrides` è l'insieme di celle da trattare come vuote:
  // serve a valutare un mondo ipotetico senza mutare il modello reale. La cache
  // vale solo per il nodo di partenza corrente e per poco tempo: il bot si
  // sposta e ogni scavo/piazzamento cambia il mondo.
  reachableCells ({ limit = 1200, ttlMs = 1000, overrides = null } = {}) {
    const start = this._startNode();
    if (!start) return { start: null, cells: new Set(), truncated: false };
    const startKey = `${start.x},${start.y},${start.z}`;
    if (!overrides) {
      const cached = this._reachCache;
      if (cached && cached.startKey === startKey && Date.now() - cached.at < ttlMs) return cached.value;
    }
    const cells = new Set([startKey]);
    const queue = [start];
    let truncated = false;
    const previous = this._pathOverrides;
    this._pathOverrides = overrides || null;
    try {
      while (queue.length && !truncated) {
        const node = queue.shift();
        for (const next of this._neighbors(node)) {
          const key = `${next.x},${next.y},${next.z}`;
          if (cells.has(key)) continue;
          if (cells.size >= limit) { truncated = true; break; }
          cells.add(key);
          queue.push({ x: next.x, y: next.y, z: next.z });
        }
      }
    } finally {
      this._pathOverrides = previous;
    }
    const value = { start, cells, truncated };
    if (!overrides) this._reachCache = { startKey, at: Date.now(), value };
    return value;
  }

  cellReachable (cell) {
    if (!cell) return false;
    const key = `${Math.floor(cell.x)},${Math.floor(cell.y)},${Math.floor(cell.z)}`;
    return this.reachableCells().cells.has(key);
  }

  // C'è una cella calpestabile raggiungibile abbastanza vicina? `dy` limita il
  // dislivello: un item due blocchi sotto il pavimento non è raccoglibile anche
  // se la sua colonna è vicina. Stesso predicato per i contenitori (raggio di
  // interazione) e per i drop (1.6 blocchi, un solo blocco di dislivello).
  approachReachable (position, { range = 3.5, dy = 2 } = {}) {
    if (!position) return false;
    const baseY = Math.floor(position.y);
    for (const key of this.reachableCells().cells) {
      const [x, y, z] = key.split(',').map(Number);
      if (Math.abs(y - baseY) > dy) continue;
      if (Math.hypot(x + 0.5 - position.x, z + 0.5 - position.z) <= range) return true;
    }
    return false;
  }

  // Un drop è raccoglibile se il bot può stare nella sua cella o avvicinarsi
  // abbastanza da prenderlo.
  dropReachable (position) {
    if (!position) return false;
    if (this.cellReachable(position)) return true;
    return this.approachReachable(position, { range: 1.6, dy: 1 });
  }

  // Le azioni su entità (caccia, commercio, doma, tosatura, monta, segui)
  // richiedono di avvicinarsi: se nessuna cella raggiungibile è a tiro,
  // l'opzione brucerebbe solo il budget in move falliti. Posizione ignota o
  // mondo non affidabile ⇒ non filtrare (fail-open).
  entityApproachable (entity, { range = 3, dy = 2 } = {}) {
    if (!entity?.position) return true;
    if (!this._reachabilityUsable()) return true;
    return this.approachReachable(entity.position, { range, dy });
  }

  // Un luogo suggerito dalla memoria (un hit dell'indice vettoriale) diventa una
  // destinazione solo se il bot può arrivarci: stesso verdetto delle azioni, con
  // fail-open quando il componente non è affidabile (il limite di `reachableCells`
  // è una stima, non una prova di irraggiungibilità).
  placeReach (position) {
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) {
      return { reachable: false, reason: 'no_position', distance: null };
    }
    const distance = this.position
      ? Math.round(Math.hypot(position.x - this.position.x, position.z - this.position.z) * 10) / 10
      : null;
    if (!this._reachabilityUsable()) {
      const reach = this.reachableCells();
      // Fail-open, ma con il motivo: un componente degenere o troncato è una
      // stima, e senza questo dettaglio il verdetto non si diagnostica. Con una
      // sola cella si riporta anche perché i quattro vicini non lo sono: è il
      // caso del bot sigillato, e leggerlo dal vivo non deve richiedere una
      // sessione di debug.
      const detail = { feet: !!this._feet, cells: reach.cells.size, truncated: reach.truncated };
      if (reach.cells.size <= 1 && reach.start) {
        const { x, y, z } = reach.start;
        detail.start = reach.start;
        detail.neighbors = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => this._standableWhy(x + dx, y, z + dz));
      }
      return { reachable: true, reason: 'reachability_unknown', distance, detail };
    }
    if (this.cellReachable(position)) return { reachable: true, reason: 'cell', distance };
    if (this.approachReachable(position, { range: 3, dy: 2 })) return { reachable: true, reason: 'approach', distance };
    return { reachable: false, reason: 'unreachable', distance };
  }

  // Sceglie il primo luogo della memoria che il mondo **conferma** camminabile.
  // Qui si è severi: una reachability sconosciuta non è una conferma, e mandare
  // il bot verso un posto non verificato brucia budget in `path_failed`. I filtri
  // sulle azioni restano fail-open (non togliere un'opzione su un mondo
  // inaffidabile); questa è la creazione di una **nuova destinazione**.
  placeCandidate (hits) {
    const annotated = (hits ?? []).map(hit => ({...hit, reachability: this.placeReach(hit.position)}));
    const candidate = annotated.find(hit => hit.reachability.reachable === true && hit.reachability.reason !== 'reachability_unknown') ?? null;
    let reason = null;
    if (!candidate) {
      if (!annotated.length) reason = 'no_hits';
      else if (annotated.every(hit => hit.reachability.reason === 'unreachable' || hit.reachability.reason === 'no_position')) reason = 'all_unreachable';
      else reason = 'reachability_unknown';
    }
    return { hits: annotated, candidate, reason };
  }

  // Il drop di un blocco scavato atterra nella cella del blocco, che dopo lo
  // scavo è vuota: valuta la raggiungibilità con il blocco già rimosso. Lo scavo
  // può solo aggiungere percorsi, quindi l'override non falsa il verdetto.
  mineDropReachable (blockPosition) {
    if (!blockPosition) return false;
    const key = `${blockPosition.x},${blockPosition.y},${blockPosition.z}`;
    return this.reachableCells({ overrides: new Set([key]) }).cells.has(key);
  }

  // Componente raggiungibile attorno al bot, per diagnosi (GET /debug/reach).
  reachReport ({ limit = 1200, maxCells = 200 } = {}) {
    const { start, cells, truncated } = this.reachableCells({ limit });
    const list = [...cells].map(key => {
      const [x, y, z] = key.split(',').map(Number);
      return { x, y, z };
    });
    list.sort((a, b) => (a.y - b.y) || (a.x - b.x) || (a.z - b.z));
    const feet = this._feet;
    return {
      start,
      feet: feet ? { x: feet.x, y: feet.y, z: feet.z } : null,
      count: list.length,
      truncated,
      bounds: list.length
        ? {
            min: { x: Math.min(...list.map(c => c.x)), y: Math.min(...list.map(c => c.y)), z: Math.min(...list.map(c => c.z)) },
            max: { x: Math.max(...list.map(c => c.x)), y: Math.max(...list.map(c => c.y)), z: Math.max(...list.map(c => c.z)) },
          }
        : null,
      cells: list.slice(0, maxCells),
    };
  }

  _findGoalNodes (target, { limit = 8 } = {}) {
    const gx = Math.floor(target.x), gz = Math.floor(target.z);
    // La quota di riferimento è quella del bersaglio: con quella dei piedi un
    // drop sotto il bot verrebbe "raggiunto" senza scendere.
    const baseY = Math.floor((Number.isFinite(target.y) ? target.y : this._feet.y) + 1e-3);
    const candidates = [];
    for (let r = 0; r <= 3; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          for (let dy = -10; dy <= 10; dy++) {
            const x = gx + dx, y = baseY + dy, z = gz + dz;
            if (!this._standable(x, y, z)) continue;
            const score = Math.hypot(x + 0.5 - target.x, z + 0.5 - target.z) + Math.abs(dy) * 0.5;
            candidates.push({ x, y, z, score });
          }
        }
      }
      if (candidates.length && r >= 1) break;
    }
    candidates.sort((a, b) => a.score - b.score);
    return candidates.slice(0, limit).map(({ x, y, z }) => ({ x, y, z }));
  }

  _findGoalNode (target) {
    return this._findGoalNodes(target)[0] ?? null;
  }

  *_neighbors ({ x, y, z }) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (this._standable(nx, y, nz)) yield { x: nx, y, z: nz, cost: 1 };
      if (this._standable(nx, y + 1, nz)) yield { x: nx, y: y + 1, z: nz, cost: 1.4 };
      const bedDeparture = this._blockForPath(x, y - 1, z)?.name === 'bed';
      if (this._standable(nx, y - 1, nz) && (!bedDeparture || this._passableForPath(this._blockForPath(nx, y + 1, nz)))) yield { x: nx, y: y - 1, z: nz, cost: 1.2 };
      // Caduta oltre un gradino: quattro blocchi in Overworld, due nel
      // Nether/End (`maxFallDepth`) perché là non c'è acqua per attutire la
      // caduta — e l'atterraggio su magma o fuoco non è mai un atterraggio.
      if (y > 1 && this._passable(this._blockForPath(nx, y, nz)) &&
          this._passable(this._blockForPath(nx, y + 1, nz))) {
        const maxFall = maxFallDepth(this.dimension);
        for (let ny = y - 2; ny >= y - maxFall - 1; ny--) {
          if (!this._passable(this._blockForPath(nx, ny + 1, nz))) break;
          const landing = this._blockForPath(nx, ny - 1, nz);
          if (landing && landingHazard(landing.name)) break;
          if (this._standable(nx, ny, nz)) { yield { x: nx, y: ny, z: nz, cost: 1 + (y - ny) * 0.5 }; break; }
        }
      }
    }
  }

  _reconstructPath (cameFrom, node, startKey) {
    const path = [{ x: node.x, y: node.y, z: node.z }];
    let key = `${node.x},${node.y},${node.z}`;
    while (key !== startKey) {
      const prev = cameFrom.get(key);
      if (!prev) break;
      path.push({ x: prev.x, y: prev.y, z: prev.z });
      key = `${prev.x},${prev.y},${prev.z}`;
    }
    return path.reverse();
  }

  _findPath (start, goal, { maxNodes = PATH_MAX_NODES } = {}) {
    const key = n => `${n.x},${n.y},${n.z}`;
    const startKey = key(start), goalKey = key(goal);
    const heuristic = n => Math.abs(n.x - goal.x) + Math.abs(n.z - goal.z) + 0.4 * Math.abs(n.y - goal.y);
    const open = [];
    const push = (node, f) => {
      open.push({ node, f });
      let i = open.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (open[p].f <= open[i].f) break;
        [open[p], open[i]] = [open[i], open[p]];
        i = p;
      }
    };
    const pop = () => {
      const top = open[0];
      const last = open.pop();
      if (open.length) {
        open[0] = last;
        let i = 0;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= open.length) break;
          if (c + 1 < open.length && open[c + 1].f < open[c].f) c++;
          if (open[i].f <= open[c].f) break;
          [open[i], open[c]] = [open[c], open[i]];
          i = c;
        }
      }
      return top.node;
    };
    const gScore = new Map([[startKey, 0]]);
    const cameFrom = new Map();
    const closed = new Set();
    push(start, heuristic(start));
    let expanded = 0;
    let bestNode = start, bestH = heuristic(start);
    while (open.length && expanded < maxNodes) {
      const current = pop();
      const currentKey = key(current);
      if (closed.has(currentKey)) continue;
      closed.add(currentKey);
      expanded++;
      const h = heuristic(current);
      if (h < bestH) { bestH = h; bestNode = current; }
      if (currentKey === goalKey) return this._reconstructPath(cameFrom, current, startKey);
      for (const nb of this._neighbors(current)) {
        const nbKey = key(nb);
        if (closed.has(nbKey)) continue;
        const tentative = (gScore.get(currentKey) ?? Infinity) + nb.cost;
        if (tentative < (gScore.get(nbKey) ?? Infinity)) {
          gScore.set(nbKey, tentative);
          cameFrom.set(nbKey, current);
          push(nb, tentative + heuristic(nb));
        }
      }
    }
    // Bersaglio non raggiungibile con le sezioni caricate: percorso parziale
    // verso il nodo esplorato più promettente; _moveTo riproverà dopo il caricamento.
    if (bestNode.x !== start.x || bestNode.y !== start.y || bestNode.z !== start.z) {
      return this._reconstructPath(cameFrom, bestNode, startKey);
    }
    return null;
  }

  _yawTo (from, to) {
    return -Math.atan2(to.x - from.x, to.z - from.z) * 180 / Math.PI;
  }

  async _constructionEdge (stand, { signal, timeoutMs = 2500 } = {}) {
    if (!stand.edge || !this._authTickInterval || signal?.aborted) throw new Error('construction_edge_unavailable');
    const below = this.world.blockAt({ x: stand.x, y: stand.y - 1, z: stand.z });
    if (!below || below.name === 'unknown' || below.boundingBox !== 'block') throw new Error('construction_edge_no_support');
    if (Math.hypot(this._feet.x - stand.x - 0.5, this._feet.y - stand.y, this._feet.z - stand.z - 0.5) > 0.45) throw new Error('construction_edge_not_at_start');
    const target = { x: stand.x + 0.5 + stand.edge.x, y: stand.y, z: stand.z + 0.5 + stand.edge.z };
    if (this._collides(target.x, target.y, target.z)) throw new Error('construction_edge_blocked');
    this._constructionSneaking = true;
    const motion = this._startMotion([stand], stand, target, 0.025, Date.now() + timeoutMs);
    this._motion.preciseEdge = true; this._motion.edgeBase = stand;
    this._motion.yaw = this._yawTo(this._feet, target);
    const abort = () => this._finishMotion('timeout');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      const outcome = await motion;
      if (signal?.aborted || outcome !== 'goal') throw new Error(`construction_edge_${outcome}`);
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); this._stopMotion();
    }
  }

  async _moveTo (target, stopDistance = 1.5, timeoutMs = 30000, { signal = null, verticalTolerance = null, arrivalVerticalTolerance = 3, preciseArrival = false, sneak = false, stealth = false } = {}) {
    this._constructionSneaking = false;
    signal ??= this._actionScope?.getStore()?.signal;
    if (signal?.aborted) throw new Error('action_cancelled');
    if (!this.position || !this._feet) throw new Error('no position');
    if (!this._authTickInterval) throw new Error('movement unavailable before spawn');
    const deadline = Date.now() + timeoutMs;
    const stop = Math.max(preciseArrival ? 0.025 : 0.35, stopDistance);
    let attempts = 0;
    let lastFeet = null;
    let bestTargetDistance = Infinity;
    while (Date.now() < deadline) {
      // I tick del client guidano `_updateMotionState`: senza client connesso il
      // movimento non puo' avanzare ne' scadere, quindi si esce subito (il close
      // azzera `client`, quindi la guardia copre la disconnessione reale).
      if (!this.client) throw new Error('connection_lost');
      if (signal?.aborted) throw new Error('action_cancelled');
      const start = this._startNode();
      // Il limite più alto del default (8) serve a non perdere la cella esatta
      // quando sta più in basso: la penalità verticale del punteggio la spinge
      // fuori dai primi otto posti (live 03/10, il fondo del pozzo).
      const candidates = this._findGoalNodes(target, { limit: 16 })
        .filter(goal => (verticalTolerance == null || Math.abs(goal.y - target.y) <= verticalTolerance) &&
          (!preciseArrival || (goal.x === Math.floor(target.x) && goal.z === Math.floor(target.z))));
      if (!candidates.length) throw new Error('target_not_found');
      // Fra i percorsi completi vince la cella che finisce più vicino alla
      // destinazione chiesta: il primo candidato per punteggio può stare appena
      // fuori dalla distanza di arresto (live 03/10: le celle vicine al bot erano a
      // 2,18 blocchi dal waypoint mentre quella esatta era quattro blocchi più in
      // basso, quindi l'arrivo non era mai soddisfacibile e l'azione finiva
      // `path_failed` dopo tre tentativi inutili).
      const skipDistance = node => Math.hypot(node.x + 0.5 - target.x, node.z + 0.5 - target.z);
      let chosen = null;
      let bestPartial = null;
      if (stealth) {
        // W2: la rotta silenziosa si pianifica, non si spera. Il piano si rifiuta
        // per intero (`no_stealth_route`, `no_exit_route`, `sculk_unknown`) se una
        // cella sta dentro la sfera di un sensore o se manca il ritorno: mai una
        // scorciatoia rumorosa presa perché "più corta".
        const exit = this._stealthStartCell();
        const ordered = candidates.slice().sort((a, b) => skipDistance(a) - skipDistance(b));
        let refusal = null;
        for (const goal of ordered) {
          const plan = this._planStealthRoute(start, goal, { exit });
          if (!plan.ok) { refusal ??= plan; continue; }
          chosen = { goal, path: plan.cells, plan };
          break;
        }
        if (!chosen) throw new Error(refusal?.error ?? 'no_stealth_route');
      } else {
        for (const goal of candidates) {
          const path = this._findPath(start, goal);
          if (!path || !path.length) continue;
          const end = path.at(-1);
          if (end.x !== goal.x || end.y !== goal.y || end.z !== goal.z) {
            // Percorso parziale: conserva il più lungo come ripiego (sezioni non ancora caricate).
            if (!bestPartial || path.length > bestPartial.path.length) bestPartial = { goal, path };
            continue;
          }
          if (chosen && skipDistance(goal) >= skipDistance(chosen.goal)) continue;
          chosen = { goal, path };
        }
        if (!chosen) chosen = bestPartial;
        if (!chosen) throw new Error('path_failed');
      }
      const { goal, path } = chosen;
      // La rotta (e la sua via di ritorno) si ricorda appena accettata: se il
      // Warden arrivasse a metà strada, la fuga deve avere qualcosa da ripercorrere.
      if (chosen.plan) this._rememberStealthRoute(chosen.plan, goal);
      // L'arrivo si misura sulla cella che il percorso raggiunge davvero, non sulla
      // y chiesta dal planner: `goto_waypoint` la congela dalla posizione di
      // partenza, quindi un dislivello > 3 blocchi — uscire da una grotta verso il
      // villaggio — rendeva il controllo verticale insoddisfacibile (live 03/10:
      // il bot è arrivato a destinazione e l'azione ha finito `path_failed` in 28,5 s).
      const endNode = path.at(-1);
      const motionStart = { ...this._feet };
      this._beginMotionTrack({ sneak });
      const outcome = await this._startMotion(path, goal, { x: endNode.x + 0.5, y: endNode.y, z: endNode.z + 0.5 }, stop, deadline, { arrivalVerticalTolerance, sneak });
      if (signal?.aborted) throw new Error('action_cancelled');
      const reachedWaypoints = Math.max(0, (this._motion?.index ?? 1) - Math.min(1, path.length - 1));
      this._stopMotion();
      if (outcome === 'goal' && chosen !== bestPartial) {
        const distance = Math.hypot(this.position.x - target.x, this.position.y - target.y, this.position.z - target.z);
        return {
          ok: true,
          distance: +distance.toFixed(2),
          pathNodes: path.length,
          goal: { x: goal.x, y: goal.y, z: goal.z },
          // W2: cosa è stato camminato, in forma leggibile (celle, rischio massimo,
          // rotta di ritorno): l'operatore vede il piano, non solo l'arrivo.
          ...(chosen.plan ? { stealth: true, plan: summarizeStealthPlan(chosen.plan), route: this._stealthRouteView() } : {}),
        };
      }
      if (outcome === 'timeout') {
        const position = { ...this._feet };
        const distance = p => Math.hypot(p.x - target.x, p.y - target.y, p.z - target.z);
        const displacement = Math.hypot(position.x - motionStart.x, position.y - motionStart.y, position.z - motionStart.z);
        const error = new Error('movement timeout');
        error.details = { target: { ...target }, from: motionStart, position, pathNodes: path.length, reachedWaypoints,
          progressed: displacement >= 0.3 && (reachedWaypoints > 0 || distance(motionStart) - distance(position) >= 0.3) };
        throw error;
      }
      const feet = this._feet;
      const moved = lastFeet ? Math.hypot(feet.x - lastFeet.x, feet.z - lastFeet.z) : Infinity;
      // `no_progress` (watchdog sul bersaglio) e `moved < 0.3` (il tratto non ha
      // spostato il bot) sono lo stesso verdetto visto da due lati: tre di fila
      // chiudono la corsa invece di consumare tutto il budget. Live 07/10/2026:
      // 75 s per 1,5 blocchi netti con il verdetto per-waypoint sempre zittito.
      // Un tratto che *avanza verso il bersaglio* azzera il contatore; uno che si
      // limita a spostare il bot (anche di più di 0,3 blocchi, in tondo o contro un
      // muro) no: senza il termine sul bersaglio un'oscillazione che rigirava su se
      // stessa azzerava `attempts` a ogni giro e bruciava i 45 s in `movement
      // timeout` (live 08/10/2026, tentativo 16: 0,6 blocchi netti in 45 s,
      // `progressed: false`, nessun verdetto interno).
      const targetDistance = Math.hypot(feet.x - target.x, feet.z - target.z);
      const improved = targetDistance < bestTargetDistance - 0.25;
      if (improved) bestTargetDistance = targetDistance;
      if (outcome === 'no_progress' || moved < 0.3 || !improved) {
        attempts++;
        if (attempts >= 3) {
          const stalled = new Error(outcome === 'no_progress' || outcome === 'stuck' ? 'stuck'
            : (outcome === 'stuck_in_doorway' ? 'stuck_in_doorway' : 'path_failed'));
          stalled.details = { target: { ...target }, from: motionStart, position: { ...this._feet },
            pathNodes: path.length, reachedWaypoints, outcome, stalled: true };
          throw stalled;
        }
      } else {
        attempts = 0;
      }
      lastFeet = { x: feet.x, y: feet.y, z: feet.z };
      await delay(50);
    }
    throw new Error('movement timeout');
  }

  // Segue un giocatore (by gamertag) rileggendo la sua posizione viva a ogni
  // tratto, finché non è vicino o scade il budget. Usato dal comando umano
  // "seguimi" (plan.follow = gamertag).
  // Ultima posizione nota di un giocatore (memoria del "lupo"): il server non
  // manda piu' nulla di un giocatore che esce dal raggio di vista, quindi
  // `lastAt` sull'entita' non basta — quando l'entita' sparisce serve un posto
  // dove andare a cercarlo.
  _rememberPlayerSeen (name, position) {
    const key = stripFormatting(name)?.toLowerCase();
    if (!key || !position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) return;
    const prev = this._playerLastSeen.get(key);
    if (prev && prev.position && prev.position.x === position.x && prev.position.y === position.y && prev.position.z === position.z) {
      prev.at = Date.now();
      return;
    }
    this._playerLastSeen.set(key, {
      position: { x: position.x, y: position.y, z: position.z },
      at: Date.now(),
    });
  }

  // Bersaglio del recupero: l'ultima posizione nota, se l'entita' non e' piu'
  // tracciata, altrimenti la sua posizione attuale (l'entita' viva e' la
  // verita': non serve cercare dove *era*). Ritorna null quando la memoria e'
  // troppo vecchia o troppo lontana per valere un viaggio.
  _seekTarget (name) {
    const key = stripFormatting(name)?.toLowerCase();
    if (!key || !this.position) return null;
    const live = this._playerByName(key);
    const record = live?.position ? { position: live.position, at: Date.now() } : this._playerLastSeen.get(key);
    if (!record?.position) return null;
    const age = Date.now() - (record.at || 0);
    if (age > SEEK_MAX_AGE_MS) return null;
    const distance = Math.hypot(record.position.x - this.position.x, record.position.z - this.position.z);
    if (distance > SEEK_MAX_DISTANCE) return null;
    if (distance < 2) return null; // ci siamo gia': non e' una ricerca
    return { position: record.position, distance, ageMs: age, live: !!live };
  }

  // Recupero dell'umano perso ("wolf recovery"): va all'ultima posizione nota
  // e guarda intorno. Non e' un inseguimento: se il giocatore e' tornato
  // visibile lo riporta (`found: true`), altrimenti dichiara il fallimento e
  // lascia al controller la decisione (un'altra ricerca o un messaggio in chat).
  async _seekPlayer (name, { arriveDistance = 1.5, timeoutMs = 45000 } = {}) {
    const target = this._seekTarget(name);
    if (!target) return { ok: false, error: 'no_seek_target', target: name };
    this.log('seek_start', { target: name, position: target.position, distance: +target.distance.toFixed(1), ageMs: target.ageMs, live: target.live });
    try {
      const result = await this._moveTo(target.position, arriveDistance, timeoutMs);
      const found = this._playerByName(name);
      if (found?.position) {
        const d = this._entityDistance(found);
        this.log('seek_found', { target: name, distance: +d.toFixed(1) });
        return { ok: true, found: true, target: name, distance: +d.toFixed(1), walked: result?.distance ?? null };
      }
      this.log('seek_failed', { target: name, position: target.position, walked: result?.distance ?? null });
      return { ok: false, found: false, error: 'player_not_found', target: name, searched: target.position, walked: result?.distance ?? null };
    } catch (error) {
      this.log('seek_failed', { target: name, error: error?.message ?? String(error) });
      return { ok: false, found: false, error: `seek_failed: ${error?.message ?? String(error)}`, target: name, searched: target.position };
    }
  }

  // Vista compatta per l'osservazione: al controller serve sapere se il
  // bersaglio del follow e' tracciato e quanto e' vecchia la traccia.
  _followView () {
    const name = this.plan?.follow || null;
    if (!name) return null;
    const key = stripFormatting(name)?.toLowerCase();
    const live = this._playerByName(key);
    // `searchable` deve dire se `seek_player` è *offerto* — cioè quando
    // `follow_player` non lo è — non se il bersaglio è lontano più di due
    // blocchi: sono due domande diverse e solo la prima interessa al controller.
    const approachable = !!(live?.position && this.entityApproachable(live, { range: 3, dy: 2 }));
    const record = live?.position ? { position: live.position, at: Date.now() } : this._playerLastSeen.get(key) || null;
    const lastSeen = record?.position
      ? { x: +record.position.x.toFixed(1), y: +record.position.y.toFixed(1), z: +record.position.z.toFixed(1) }
      : null;
    const lastSeenAgeMs = record ? Date.now() - (record.at || 0) : null;
    const seek = approachable ? null : this._seekTarget(name);
    return {
      name,
      tracked: !!live?.position,
      approachable,
      distance: live?.position ? +this._entityDistance(live).toFixed(1) : null,
      lastSeen,
      lastSeenAgeMs,
      searchable: !!seek,
    };
  }

  async _followPlayer (name, { distance = 3, timeoutMs = 45000 } = {}) {
    const started = Date.now();
    let last = null;
    let stalls = 0;
    while (Date.now() - started < timeoutMs) {
      const entity = this._playerByName(name);
      if (!entity || !entity.position) {
        await delay(250);
        if (++stalls >= 8) return { ok: false, error: 'target_not_found', target: name };
        continue;
      }
      last = entity.position;
      const d = Math.hypot(last.x - this.position.x, last.z - this.position.z);
      if (d <= distance) return { ok: true, followed: name, distance: +d.toFixed(1) };
      try {
        await this._moveTo({ x: last.x, y: last.y, z: last.z }, distance, Math.min(12000, Math.max(3000, d * 600)));
        // Solo un tratto davvero percorso azzera i fallimenti consecutivi: con
        // l'azzeramento a ogni giro il contatore non arrivava mai a 4 e un follow
        // bloccato restava 45 s a girare a vuoto, per giunta riportando `ok: true`
        // (live 04/10: tre minuti di bot immobile visti dall'utente).
        stalls = 0;
      } catch (error) {
        if (++stalls >= 4) return { ok: false, error: `follow_failed: ${error.message}`, target: name };
      }
    }
    return { ok: true, followed: name, distance: last ? +Math.hypot(last.x - this.position.x, last.z - this.position.z).toFixed(1) : null, note: 'follow window elapsed' };
  }

  // Destinazione della scorta: `plan.escort.to`, altrimenti il waypoint del
  // piano, altrimenti la destinazione di una rotta di replay attiva (M2: la
  // rotta di rientro registrata). Senza destinazione l'azione non e' offribile.
  _escortTarget () {
    const explicit = this.plan?.escort?.to ?? null;
    const waypoint = this.plan?.waypoint ?? null;
    const replay = this.replayRoute?.destination ?? null;
    const raw = explicit ?? waypoint ?? replay;
    if (!raw || !Number.isFinite(raw.x) || !Number.isFinite(raw.z)) return null;
    return {
      x: raw.x,
      y: Number.isFinite(raw.y) ? raw.y : (this.position?.y ?? 70),
      z: raw.z,
      source: raw === explicit ? 'escort.to' : (raw === waypoint ? 'plan.waypoint' : 'replay_route'),
    };
  }

  // Vista della scorta: chi si accompagna, dove si va, quanto dista l'umano e se
  // l'azione e' offribile adesso. `waiting` e' il gate: l'umano e' oltre il
  // margine e il bot, se agisse, aspetterebbe. La distanza e' orizzontale, come
  // nel follow: un dislivello non e' "rimasto indietro".
  _escortView () {
    const name = this.plan?.escort?.from ?? this.plan?.escort?.name ?? null;
    if (!name) return null;
    const target = this._escortTarget();
    const human = this._playerByName(name);
    const position = this.position ?? { x: 0, y: 0, z: 0 };
    const gap = human?.position
      ? +Math.hypot(human.position.x - position.x, human.position.z - position.z).toFixed(1)
      : null;
    return {
      name,
      target: target
        ? { x: +target.x.toFixed(1), y: +target.y.toFixed(1), z: +target.z.toFixed(1), source: target.source }
        : null,
      tracked: !!human?.position,
      gap,
      waiting: gap != null && gap > ESCORT_MAX_GAP,
      ready: !!target && !!human?.position,
      limits: {
        maxGap: ESCORT_MAX_GAP,
        resumeGap: ESCORT_RESUME_GAP,
        waitMs: ESCORT_WAIT_MS,
        lostMs: ESCORT_LOST_MS,
        timeoutMs: ESCORT_TIMEOUT_MS,
        arriveDistance: ESCORT_ARRIVE_DISTANCE,
      },
    };
  }

  // Scorta: cammina verso la destinazione a segmenti e a ogni giro guarda dove
  // sta l'umano. La differenza con `_followPlayer` non e' la camminata ma chi
  // decide la meta: qui la decide il bot, e l'umano e' quello che puo' restare
  // indietro. `waits` racconta ogni sosta, cosi' il collaudo live puo' dire
  // quante volte e per quanto il bot si e' fermato ad aspettare.
  async _escortTo (name = this.plan?.escort?.from ?? this.plan?.escort?.name, target = this._escortTarget(), {
    arriveDistance = ESCORT_ARRIVE_DISTANCE,
    maxGap = ESCORT_MAX_GAP,
    resumeGap = ESCORT_RESUME_GAP,
    waitMs = ESCORT_WAIT_MS,
    lostMs = ESCORT_LOST_MS,
    timeoutMs = ESCORT_TIMEOUT_MS,
  } = {}) {
    if (!name) return { ok: false, error: 'no_escort_target', hint: 'no human named: set plan.escort.from (an escort order names the person being guided)' };
    if (!target) return { ok: false, error: 'no_escort_target', hint: 'no destination: set plan.escort.to or plan.waypoint' };
    const started = Date.now();
    const position = () => this.position ?? { x: 0, y: 0, z: 0 };
    const gapTo = (entity) => Math.hypot(entity.position.x - position().x, entity.position.z - position().z);
    const waits = [];
    let waitedMs = 0;
    let absentSince = null;
    let failedMoves = 0;
    while (Date.now() - started < timeoutMs) {
      const human = this._playerByName(name);
      if (!human?.position) {
        // Fuori dal raggio di tracking: si aspetta, ma non per sempre. Meglio un
        // motivo che due minuti di silenzio con un `ok: true` in fondo.
        absentSince ??= Date.now();
        if (Date.now() - absentSince > lostMs) {
          this.log('escort_lost', { target: name, waitedMs, elapsedMs: Date.now() - started });
          return { ok: false, error: 'escort_lost', target: name, waitedMs, waits };
        }
        await delay(500);
        continue;
      }
      absentSince = null;
      const gap = gapTo(human);
      if (gap > maxGap) {
        // Una attesa per volta: il tetto non si cumula fra due soste.
        const waitStart = Date.now();
        let resumed = false;
        while (Date.now() - waitStart < waitMs && Date.now() - started < timeoutMs) {
          const current = this._playerByName(name);
          if (!current?.position) break; // perso: torna al gate principale
          if (gapTo(current) <= resumeGap) {
            resumed = true;
            break;
          }
          await delay(250);
        }
        const ms = Date.now() - waitStart;
        waitedMs += ms;
        waits.push({ gap: +gap.toFixed(1), ms, resumed });
        if (!resumed) {
          const error = this._playerByName(name)?.position ? 'escort_left_behind' : 'escort_lost';
          this.log('escort_wait_over', { target: name, gap: +gap.toFixed(1), ms, error });
          return { ok: false, error, gap: +gap.toFixed(1), resumeGap, waitedMs, waits };
        }
        continue;
      }
      const distance = Math.hypot(target.x - position().x, target.z - position().z);
      if (distance <= arriveDistance) {
        this.log('escort_arrived', { target: name, distance: +distance.toFixed(1), waitedMs, waits: waits.length });
        return { ok: true, escorted: name, arrived: true, distance: +distance.toFixed(1), waitedMs, waits };
      }
      try {
        await this._moveTo(target, arriveDistance, Math.min(12000, Math.max(3000, distance * 600)));
        failedMoves = 0;
      } catch (error) {
        if (++failedMoves >= 3) {
          this.log('escort_failed', { target: name, error: error?.message ?? String(error), waitedMs });
          return { ok: false, error: `escort_failed: ${error?.message ?? String(error)}`, waitedMs, waits };
        }
      }
    }
    this.log('escort_timeout', { target: name, waitedMs, waits: waits.length });
    return { ok: false, error: 'escort_timeout', target: name, waitedMs, waits };
  }

  // ---- sopravvivenza ------------------------------------------------------------------
  // Entità, ora del giorno, combattimento, fuga, cibo e letto. Le regole pure
  // (classificazione ostili, cibo, tempo) stanno in bedrock-survival.mjs.

  // Riceve un pacchetto `text` (id 9) e conserva solo la chat scritta da giocatori
  // (pubblico `chat` e whisper `whisper`/`json_whisper`), escludendo i messaggi
  // propri e quelli di sistema. L'allowlist/trigger vengono applicati dal controller.
  _onChat (packet) {
    const type = packet?.type;
    const message = packet?.message;
    if (!message || typeof message !== 'string') return;
    // M13: tutto ciò che non è chat non è un ordine e non entra nell'inbox, ma
    // non è nemmeno rumore: il server spiega lì i suoi rifiuti (sonno, gamerule).
    if (type !== 'chat' && type !== 'whisper' && type !== 'json_whisper') return this._noteServerText(packet);
    const rawFrom = stripFormatting(packet.source_name) || null;
    // Un messaggio simulato (`simulateChat`, rotta `POST /debug/chat`) serve a
    // provare il canale senza un giocatore in gioco, e **non può impersonare un
    // umano**: il mittente è sempre `sim:<nome>` e la riga resta marcata. Chi
    // risponde lo decide l'allowlist del controller, come per chiunque altro.
    const simulated = packet.simulated === true;
    const from = simulated && rawFrom && !rawFrom.startsWith('sim:') ? `sim:${rawFrom}` : rawFrom;
    // Eco dei propri messaggi: il server li rimanda indietro con il gamertag
    // vero, non con il nome di login. Lasciarli entrare in `chatInbox` fa
    // credere al controller che un umano fidato abbia parlato (e il bot può
    // ordinare a se stesso). L'eco però rivela il gamertag: si impara e si usa
    // per riconoscersi anche in futuro.
    if (this._isOwnChatEcho(message)) {
      if (from && !this.selfName && !this.isSelfName(from)) {
        this.selfName = from;
        this.log('self_name_learned', { name: from });
      }
      this.log('chat_echo', { from, chatType: type, message: message.slice(0, 160) });
      return;
    }
    if (this.isSelfName(from)) return;
    const entry = { from, message, type, xuid: packet.xuid != null ? String(packet.xuid) : null, at: Date.now(), ...(simulated ? { simulated: true } : {}) };
    // R2: se a questo mittente è stata appena fatta una domanda, il suo primo
    // messaggio successivo è la *risposta* a quella domanda — non un ordine
    // nuovo. L'inbox lo dice (una volta sola) e il controller rilancia l'ordine
    // originale con la risposta attaccata. La decorazione è un suggerimento: il
    // controller resta padrone di scartarla (un ordine di stop, per esempio).
    const pending = this._chatPendingTake(entry);
    if (pending) {
      entry.clarifies = { orderId: pending.orderId, originalText: pending.originalText, question: pending.question };
      this.log('chat_clarify_reply', { from, orderId: pending.orderId, askedMsAgo: entry.at - pending.askedAt, message: message.slice(0, 160) });
    }
    this.chatInbox.push(entry);
    if (this.chatInbox.length > 32) this.chatInbox.shift();
    this.log(simulated ? 'chat_simulated' : 'chat', { from, chatType: type, xuid: entry.xuid, message: message.slice(0, 160) });
  }

  // Un messaggio che nessun giocatore ha scritto: la via per provare il canale
  // chat (una domanda come `che armatura hai?`, un ordine) senza un umano in
  // gioco. Passa dallo **stesso** `_onChat`, quindi valgono le stesse regole
  // (eco, chiarimenti, inbox, log) e nessuno può scavalcarle; il mittente resta
  // `sim:<nome>` e l'entry porta `simulated: true`, così nel ledger non si
  // confonde con una persona. L'esito dice se il messaggio è *entrato in inbox*:
  // un messaggio scartato (eco, nome del bot) non finge di essere passato.
  simulateChat ({ from, message, type = 'chat' } = {}) {
    if (!from || typeof from !== 'string' || !message || typeof message !== 'string') {
      return { ok: false, error: 'chat_simulate_requires_sender_and_message' };
    }
    const name = from.startsWith('sim:') ? from : `sim:${from}`;
    this._onChat({ type, message, source_name: name, simulated: true });
    const entry = this.chatInbox.at(-1) ?? null;
    const accepted = !!entry && entry.message === message && entry.from === name;
    return { ok: true, simulated: true, from: name, accepted, entry: accepted ? entry : null };
  }

  // M13 — il server parla anche fuori dalla chat. Un pacchetto `raw`/`system`/
  // `translation` non è un ordine (nessun mittente fidato, nessun trigger) ma è
  // spesso l'**unica spiegazione** di un rifiuto: «N giocatori devono dormire». Si
  // conserva reso (i `%s` sostituiti dai `parameters`) e si registra una volta,
  // con il testo grezzo, così la diagnosi non deve indovinare.
  _noteServerText (packet) {
    const rendered = renderServerText(packet);
    if (!rendered) return;
    const entry = {
      at: Date.now(),
      type: typeof packet?.type === 'string' ? packet.type : null,
      text: rendered.slice(0, SERVER_TEXT_LENGTH),
    };
    this.serverText.push(entry);
    if (this.serverText.length > SERVER_TEXT_MAX) this.serverText.shift();
    // Il payload originale resta nel ledger quando la resa lo cambia: il rawtext
    // JSON è la prova grezza, `text` è la frase che un umano può leggere.
    const raw = typeof packet?.message === 'string' ? packet.message.slice(0, SERVER_TEXT_LENGTH) : null;
    this.log('server_text', {
      ...entry,
      ...(raw && raw !== entry.text ? { raw } : {}),
      translation: packet?.needs_translation === true ? packet?.message ?? null : null,
    });
  }

  // Gli ultimi testi non-chat del server che dicono che il sonno è accettato ma la
  // notte non salta. Serve a `_trySleepInBed`: senza questa riga l'esito era
  // `sleep_rejected`, che accusa il letto invece della gamerule.
  _serverSaidSleepPending ({ since = 0 } = {}) {
    return this.serverText
      .filter(row => row.at >= since && SLEEP_PENDING_PATTERNS.some(pattern => pattern.test(row.text)))
      .map(row => row.text);
  }

  // R2 — la domanda in attesa. Il bot ha chiesto qualcosa a un umano e la
  // risposta arriverà in un messaggio successivo, che l'inbox espone come un
  // messaggio qualunque: senza questo legame «a chi ho chiesto che cosa» il
  // controller non saprebbe che quella frase non è un ordine nuovo. Si conserva
  // l'**ordine originale** perché `observe()` porta solo gli ultimi 10 messaggi.
  // Chiama solo il controller, che ha già applicato il gate del canale.
  askChat ({ from, xuid = null, orderId, originalText = '', question, field = null, reason = null } = {}) {
    const who = String(from ?? '').trim();
    const text = String(question ?? '').trim();
    if (!who || !text) return { ok: false, error: 'ask_requires_sender_and_question' };
    const keys = [...new Set([chatKey(who), chatKey(xuid)].filter(Boolean))];
    const record = {
      orderId: String(orderId ?? ''),
      from: who,
      originalText: String(originalText ?? '').slice(0, CHAT_MAX_LENGTH),
      question: text.slice(0, CHAT_MAX_LENGTH),
      field,
      reason,
      askedAt: Date.now(),
      keys,
    };
    for (const key of keys) this.chatPending.set(key, record);
    this.log('chat_ask', { to: who, orderId: record.orderId, field, reason, question: record.question.slice(0, 160) });
    return { ok: true, pending: this._chatPendingView(record) };
  }

  // La risposta consuma la domanda: **una volta sola**. Il record si toglie
  // sempre (anche se è scaduto), altrimenti una domanda vecchia resterebbe lì a
  // decorare i messaggi di domani.
  _chatPendingTake (entry) {
    const now = Date.now();
    for (const key of [...new Set([chatKey(entry?.from), chatKey(entry?.xuid)].filter(Boolean))]) {
      const record = this.chatPending.get(key);
      if (!record) continue;
      for (const other of record.keys) this.chatPending.delete(other);
      if (now - record.askedAt > CHAT_ASK_TTL_MS) {
        this.log('chat_ask_stale', { to: entry?.from, orderId: record.orderId, ageMs: now - record.askedAt });
        return null;
      }
      return record;
    }
    return null;
  }

  // Vista (una riga per domanda viva, non una per chiave) per `/observe` e per la
  // rotta di lettura: serve a un umano o a un agente per sapere che cosa il bot
  // sta aspettando di sapere.
  _chatPendingView (only = null) {
    const seen = new Set();
    const out = [];
    for (const record of only ? [only] : this.chatPending.values()) {
      if (seen.has(record.orderId)) continue;
      seen.add(record.orderId);
      out.push({ orderId: record.orderId, from: record.from, field: record.field, reason: record.reason, question: record.question, askedAt: record.askedAt });
    }
    return out;
  }

  // Testo identico a un messaggio appena inviato dal bot (entro la finestra): è
  // l'eco del server, non una voce umana.
  _isOwnChatEcho (message) {
    const text = String(message ?? '').trim();
    if (!text) return false;
    const cutoff = Date.now() - CHAT_ECHO_WINDOW_MS;
    this._sentChat = this._sentChat.filter(entry => entry.at >= cutoff);
    return this._sentChat.some(entry => entry.text === text);
  }

  // Il bot si riconosce per nome di login oppure per il gamertag imparato
  // dall'eco (sono diversi: `BEDROCK_USERNAME` è il nome di autenticazione).
  isSelfName (name) {
    const wanted = stripFormatting(name)?.toLowerCase();
    if (!wanted) return false;
    if (USERNAME && wanted === stripFormatting(USERNAME).toLowerCase()) return true;
    return !!this.selfName && wanted === stripFormatting(this.selfName).toLowerCase();
  }

  // Il bot scrive in chat (M5). Un pacchetto `text` tipo `chat` è ciò che manda
  // un client vanilla quando premi invio: il server lo inoltra agli altri
  // giocatori. Richiede lo spawn, altrimenti il pacchetto viene scartato.
  // Ritorna { ok, error? } e non lancia mai: il chiamante logga l'esito.
  sendChat (message, { type = 'chat' } = {}) {
    if (!this.client || !this.spawned || this.status !== 'spawned') return { ok: false, error: 'not_spawned' };
    const text = String(message ?? '').replace(/[\r\n]+/g, ' ').trim();
    if (!text) return { ok: false, error: 'empty_message' };
    if (text.length > CHAT_MAX_LENGTH) return { ok: false, error: 'message_too_long', max: CHAT_MAX_LENGTH };
    const now = Date.now();
    const wait = CHAT_MIN_INTERVAL_MS - (now - this._lastChatAt);
    if (wait > 0) return { ok: false, error: 'rate_limited', retryInMs: wait };
    try {
      // `category`/`has_filtered_message` sono obbligatori dallo schema 1.26.x;
      // xuid vuoto come nel client vanilla (il server lo riempie).
      this.client.queue('text', {
        type,
        needs_translation: false,
        category: 'authored',
        source_name: USERNAME,
        message: text,
        xuid: '',
        platform_chat_id: '',
        has_filtered_message: false,
      });
      this._lastChatAt = now;
      this._sentChat.push({ text, at: now });
      if (this._sentChat.length > CHAT_ECHO_MEMORY) this._sentChat.shift();
      this.log('chat_out', { chatType: type, message: text });
      return { ok: true, message: text };
    } catch (error) {
      this.log('chat_out_error', { chatType: type, message: text, error: error.message });
      return { ok: false, error: error.message };
    }
  }

  // Registra un'entità da add_entity/add_player. Per i mob `position` è ai piedi;
  // per i giocatori è agli occhi (1,62 sopra i piedi).
  _trackEntity (packet, kind) {
    const runtimeId = String(packet.runtime_id ?? packet.runtime_entity_id ?? '');
    if (!runtimeId) return;
    const type = normalizeEntityType(packet.entity_type || (kind === 'player' ? 'player' : `unknown_${runtimeId}`));
    let entity = this.entities.get(runtimeId);
    if (!entity) {
      entity = { runtimeId, uniqueId: null, type, kind, position: null, health: null, lastAt: 0, seenAt: Date.now() };
      this.entities.set(runtimeId, entity);
    }
    entity.type = type;
    entity.kind = kind;
    entity.lastAt = Date.now();
    if (!entity.seenAt) entity.seenAt = Date.now();
    if (kind === 'player' && packet.username) {
      const username = stripFormatting(packet.username);
      entity.username = username;
      this._playersByName.set(username.toLowerCase(), runtimeId);
    }
    if (packet.unique_id != null) {
      entity.uniqueId = String(packet.unique_id);
      // Lo stesso unique_id con un runtime id nuovo e' la stessa entita' che
      // rinasce (rejoin, o il server che la ricrea): il vecchio id non e' piu'
      // valido lato server, e lasciarlo in mappa significa offrire al combat un
      // bersaglio fantasma. Il campo `unique_id` e' l'unica cosa che lo dice.
      const previous = this._entitiesByUnique.get(entity.uniqueId);
      if (previous && previous !== runtimeId && this.entities.has(previous)) {
        const ghost = this.entities.get(previous);
        this.entities.delete(previous);
        if (ghost?.username && ghost.username !== entity.username) {
          this._playersByName.delete(ghost.username.toLowerCase());
        }
        this.log('entity_readded', { uniqueId: entity.uniqueId, from: previous, to: runtimeId, entityType: type, kind });
      }
      this._entitiesByUnique.set(entity.uniqueId, runtimeId);
    }
    if (packet.position) {
      const y = kind === 'player' ? packet.position.y - EYE_HEIGHT : packet.position.y;
      entity.position = { x: packet.position.x, y, z: packet.position.z };
      if (kind === 'player' && entity.username) this._rememberPlayerSeen(entity.username, entity.position);
    }
    if (Array.isArray(packet.attributes)) {
      for (const attr of packet.attributes) {
        if (attr.name === 'minecraft:health') entity.health = attr.current ?? attr.value;
      }
    }
    if (kind === 'player' || isHostileType(type)) {
      this.log('entity_add', { runtimeId, entityType: type, kind, position: entity.position });
    }
  }

  // Movimento di un *altro* giocatore: `move_player` ha `runtime_id` (non
  // `runtime_entity_id`) e la posizione degli occhi, quindi si riusa
  // `_onEntityMove` con la stessa convenzione di `_trackEntity` (piedi).
  _onPlayerMove (packet) {
    if (!packet?.position) return;
    this._onEntityMove({
      runtime_entity_id: String(packet.runtime_id ?? ''),
      position: { x: packet.position.x, y: packet.position.y - EYE_HEIGHT, z: packet.position.z },
    });
  }

  _onEntityMove (packet) {
    const runtimeId = String(packet.runtime_entity_id ?? packet.runtime_id ?? '');
    const entity = this.entities.get(runtimeId);
    if (!entity || !entity.position) return;
    // Solo per i proiettili: la posizione precedente è la sorgente della velocità
    // stimata (N0), quindi va conservata prima di sovrascriverla.
    if (isProjectileType(entity.type)) {
      entity.prev = { position: { ...entity.position }, at: entity.lastAt || Date.now() };
    }
    if (packet.position) {
      entity.position = { x: packet.position.x, y: packet.position.y, z: packet.position.z };
    } else if (packet.flags && typeof packet.flags === 'object') {
      if (packet.flags.has_x && packet.x != null) entity.position.x = packet.x;
      if (packet.flags.has_y && packet.y != null) entity.position.y = packet.y;
      if (packet.flags.has_z && packet.z != null) entity.position.z = packet.z;
    } else if (packet.x != null || packet.y != null || packet.z != null) {
      // In 1.26 i campi opzionali sono coordinate assolute (non delta).
      entity.position = {
        x: packet.x ?? entity.position.x,
        y: packet.y ?? entity.position.y,
        z: packet.z ?? entity.position.z,
      };
    }
    // Traccia dell'ultimo avvistamento: `add_player` arriva solo quando un
    // giocatore *entra* nel campo visivo, quindi quando il server manda
    // `remove_entity` questa e' l'unica memoria di *dove* l'abbiamo visto.
    if (entity.kind === 'player' && entity.username) this._rememberPlayerSeen(entity.username, entity.position);
    entity.lastAt = Date.now();
  }

  _onEntityRemove (packet) {
    const id = String(packet.entity_id_self ?? '');
    const runtimeId = this._entitiesByUnique.get(id) || (this.entities.has(id) ? id : null);
    if (!runtimeId) return;
    const entity = this.entities.get(runtimeId);
    if (entity?.uniqueId) this._entitiesByUnique.delete(entity.uniqueId);
    // Per i giocatori questa e' l'unica via di uscita (non si potano mai da soli):
    // se il nome restasse mappato, un runtime id riciclato dal server farebbe
    // puntare `follow_player` a un'entita' diversa.
    if (entity?.username) this._playersByName.delete(entity.username.toLowerCase());
    this.entities.delete(runtimeId);
  }

  _onLevelEvent (packet) {
    const raw = packet?.event_id ?? packet?.event;
    const id = Number(raw);
    const name = typeof packet?.event === 'string' ? packet.event : null;
    const weather = WEATHER_LEVEL_EVENTS.get(id) || (name ? WEATHER_LEVEL_EVENTS.get(name) : null);
    if (weather) {
      this._setWeather(weather, { id: Number.isFinite(id) ? id : null, event: name });
      return;
    }
    if (!SLEEP_LEVEL_EVENTS.has(id) && name !== 'players_sleeping' && name !== 'sleeping_players') return;
    this._sleepLevelEventAt = Date.now();
    this.log('sleep_level_event', { id: Number.isFinite(id) ? id : null, event: name, sleeping: this.sleeping });
  }

  _applyEntityMetadata (packet) {
    const runtimeId = String(packet.runtime_entity_id ?? '');
    const isSelf = this.client && String(this.client.entityId) === runtimeId;
    const entity = this.entities.get(runtimeId);
    if (!isSelf && !entity) return;
    // Player sleep is byte metadata 26, bit 1. Read it before generic flags:
    // resting describes other actors and can be false in the same packet.
    if (isSelf) {
      for (const entry of packet.metadata || []) {
        if (entry.key !== 'player_flags' && entry.key !== 26) continue;
        const sleeping = this._metadataFlag(entry.value, 'sleep', { sleep: 1 });
        if (sleeping == null) continue;
        this._playerSleepKnown = true;
        if (sleeping !== this.sleeping) this.log('sleep_signal', { source: 'player_flags', sleeping, raw: entry.value });
        this._setSleeping(sleeping);
      }
    }
    for (const entry of packet.metadata || []) {
      const key = typeof entry.key === 'string'
        ? entry.key
        : (entry.key === 0 ? 'flags' : entry.key === 1 ? 'health' : entry.key === 2 ? 'variant' : entry.key === 5 ? 'owner_eid' : entry.key === 28 ? 'player_bed_position' : entry.key === 43 ? 'mark_variant' : entry.key === 69 ? 'trading_career' : entry.key === 92 ? 'flags_extended' : entry.key === 101 ? 'trade_tier' : entry.key === 102 ? 'max_trade_tier' : null);
      if (key === 'health' && entry.value != null && entity) {
        const value = Number(entry.value);
        if (Number.isFinite(value)) entity.health = value;
      }
      // `variant` è la pelle/bioma, NON la professione: per i villager la
      // professione è `trading_career`/`mark_variant` (best-effort) e la fonte
      // autorevole è il display_name di update_trade (entity.professionName).
      if (key === 'variant' && entity) entity.variant = Number(entry.value);
      if (key === 'mark_variant' && entity) entity.markVariant = Number(entry.value);
      if (key === 'trading_career' && entity) entity.career = Number(entry.value);
      if (key === 'trade_tier' && entity) {
        entity.tradeTier = Number(entry.value);
      }
      if (key === 'max_trade_tier' && entity) {
        entity.maxTradeTier = Number(entry.value);
      }
      if (key === 'flags' && isSelf && !this._playerSleepKnown) {
        const resting = this._metadataFlag(entry.value, 'resting');
        if (resting != null && resting !== this.sleeping) this.log('sleep_signal', { source: 'flags', resting, raw: entry.value?._value != null ? String(entry.value._value) : entry.value });
        if (resting != null) this._setSleeping(resting);
      }
      // Flags degli animali: baby/tempted/inlove guidano riproduzione e
      // allevamento; tamed (28) e sheared (31) servono per taming e tosatura.
      // `entity` qui è il mob (non il bot).
      if (key === 'flags' && entity && !isSelf) {
        const baby = this._metadataFlag(entry.value, 'baby');
        if (baby != null) entity.baby = baby;
        const inlove = this._metadataFlag(entry.value, 'inlove');
        if (inlove != null) entity.inlove = inlove;
        const tempted = this._metadataFlag(entry.value, 'tempted');
        if (tempted != null) entity.tempted = tempted;
        const tamed = this._metadataFlag(entry.value, 'tamed');
        if (tamed != null) entity.tamed = tamed;
        const sheared = this._metadataFlag(entry.value, 'sheared');
        if (sheared != null) entity.sheared = sheared;
        // `riding` (bit 2) dice che *quell'entità* è a bordo di qualcosa: è il
        // fallback del link per capire che l'umano si è imbarcato, prima che il
        // `set_entity_link` arrivi (o quando il server non lo manda affatto).
        const riding = this._metadataFlag(entry.value, 'riding');
        if (riding != null) entity.riding = riding;
      }
      // flags_extended (chiave 92): `trusting` è il segnale dell'ocelot
      // (l'ocelot non si "doma", si fida).
      if (key === 'flags_extended' && entity && !isSelf) {
        const trusting = this._metadataFlag(entry.value, 'trusting', METADATA_FLAGS2_BITS);
        if (trusting != null) entity.trusting = trusting;
      }
      // owner_eid (chiave 5) per gli animali domati: il runtime id del padrone.
      if (key === 'owner_eid' && entity) {
        entity.ownerEid = String(entry.value?._value ?? entry.value ?? '');
      }
      if (isSelf && process.env.BEDROCK_META_LOG) this.log('self_metadata', { key, value: entry.value?._value != null ? String(entry.value._value) : entry.value });
      // player_bed_position è il letto di respawn (presente anche da svegli):
      // un CAMBIO durante il tentativo di dormire è però il segno che il server
      // ha accettato il sonno (lo stato sonno in sé resta sul flag resting).
      if (isSelf && key === 'player_bed_position' && entry.value && typeof entry.value === 'object') {
        const v = entry.value;
        const pos = { x: Number(v.x ?? NaN), y: Number(v.y ?? NaN), z: Number(v.z ?? NaN) };
        const prev = this._playerBedPosition;
        if (Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z) &&
            (!prev || prev.x !== pos.x || prev.y !== pos.y || prev.z !== pos.z)) {
          this._playerBedPosition = pos;
          this.log('sleep_bed_position', { position: pos });
        }
      }
    }
    if (entity) entity.lastAt = Date.now();
  }

  _metadataFlag (value, name, bits = METADATA_FLAG_BITS) {
    if (value && typeof value === 'object') {
      if (typeof value[name] === 'boolean') return value[name];
      if (value[name] != null) return !!value[name];
      return null;
    }
    // Fallback numerico: MetadataFlags (bitfield).
    if (typeof value === 'number' || typeof value === 'bigint') {
      const bit = bits[name];
      if (bit != null) return ((BigInt(value) >> BigInt(bit)) & 1n) === 1n;
    }
    return null;
  }

  // PlayerAttributes usa `current`; `value` resta per compatibilità col formato
  // EntityAttributes delle versioni precedenti.
  _applyOwnAttributes (packet) {
    if (packet.runtime_entity_id != null && String(packet.runtime_entity_id) !== String(this.client?.entityId)) return;
    for (const attr of packet.attributes || []) {
      const value = attr.current ?? attr.value;
      if (!Number.isFinite(value)) continue;
      if (attr.name === 'minecraft:health') {
        this.health = value;
        this._onOwnHealth();
      }
      if (attr.name === 'minecraft:player.hunger') this.food = value;
      if (attr.name === 'minecraft:player.level') this.experienceLevel = value;
      if (attr.name === 'minecraft:player.experience') this.experienceProgress = value;
      // Il budget d'aria non è ancora stato osservato in live su BDS 1.26: se il
      // server lo mandasse, la sua verità vincerebbe sul contatore simulato
      // (`airSource: 'server'`) e il contatore resterebbe allineato.
      if (/air$/.test(attr.name)) {
        this.air = value;
        this._serverAir = value;
        this.airSource = 'server';
        this._airMeter.set(value);
      }
    }
  }

  _applyEntityAttributes (packet) {
    const runtimeId = String(packet.runtime_entity_id ?? '');
    const entity = this.entities.get(runtimeId);
    if (!entity) return;
    for (const attr of packet.attributes || []) {
      if (attr.name === 'minecraft:health') entity.health = attr.current ?? attr.value;
    }
    entity.lastAt = Date.now();
  }

  // Collegamento cavaliere→veicolo: il server conferma montata/smontata.
  // Il pacchetto porta **un** `link` (schema 1.26.51:
  // `packet_set_entity_link` -> campo `link`, non `links`): leggere `links`
  // lasciava il gestore muto e ogni mount finiva in `mount_not_confirmed`
  // benché il server mandasse il link — l'evidenza live del 04/10/2026 è la
  // riga `[packet] { name: 'set_entity_link' }` nel dump dei pacchetti in
  // arrivo durante un `mount_donkey`, con `riding` rimasto `null`.
  _onEntityLink (packet = {}) {
    const links = packet.link
      ? [packet.link]
      : (Array.isArray(packet.links) ? packet.links : []);
    const self = String(this.client?.entityId ?? '');
    const seen = [];
    for (const link of links) {
      const rider = String(link?.rider_entity_id ?? '');
      const ridden = String(link?.ridden_entity_id ?? '');
      seen.push({ rider, ridden, type: link?.type ?? null });
      // Chi sta su cosa, per *tutti* i rider e non solo per il bot: è il segnale
      // autorevole per sapere che l'umano è salito sul veicolo X e quanti posti
      // di X sono occupati. Prima questo link finiva solo nel log diagnostico
      // `entity_link_other`. `type === 0` è lo smontaggio: il link si cancella.
      if (rider) {
        if (link.type === 0) this.entityLinks.delete(rider);
        else this.entityLinks.set(rider, { ridden, type: link.type ?? null, at: Date.now() });
      }
      if (rider !== self) {
        // Diagnostica: un link che non è nostro spiega un `riding` rimasto nullo
        // quando il server l'ha comunque mandato (raro: pochi eventi per sessione).
        this.log('entity_link_other', { rider, ridden, type: link?.type ?? null, self });
        continue;
      }
      if (link.type === 0) {
        this.riding = null;
        this._ridingForward = false;
        this.log('dismount', { ridden });
      } else {
        this.riding = { riddenEntityId: ridden, at: Date.now() };
        this.log('mount', { ridden, entityType: link.type });
      }
    }
    return seen;
  }

  _onEntityEvent (packet) {
    const runtimeId = String(packet.runtime_entity_id ?? '');
    const entity = this.entities.get(runtimeId);
    // Diagnostica pesca (03/10): live il server non ha mai mandato `fish_hook_hook`
    // (13) né `fish_hook_tease` (14) in otto minuti di lanci, quindi serve sapere se
    // manda **qualcosa** sull'amo: ogni evento dell'amo o con un id della pesca
    // (`fish_hook_bubble`/`fish_hook_position`, 11/12) viene registrato con il
    // payload. Misura del 03/10 (90 s di lancio continuo): solo eventi generici di
    // altri oggetti (`item_entity_merge`, `eat_grass_animation`), **zero** id
    // 11/12/13/14.
    const fishingId = packet.event_id === 11 || packet.event_id === 12 ||
      packet.event_id === 'fish_hook_bubble' || packet.event_id === 'fish_hook_position';
    const hookEvent = entity?.type === 'fishing_hook';
    if (fishingId || hookEvent) {
      this.log('hook_event', {
        runtimeId, hook: entity?.type ?? null, event: packet.event_id,
        data: packet.data ?? null, at: packet.fire_at_position ?? null,
      });
    }
    // Morso della pesca: il server manda `fish_hook_hook` (13) sul bobber quando
    // un pesce ha abboccato, e `fish_hook_tease` (14) quando si avvicina senza
    // abboccare. È il segnale esatto: l'affondo del bobber resta un fallback.
    // Va gestito **prima** della risoluzione dell'entità: live 03/10 quattro
    // `fish` di fila sono finiti `no_bite` e nel log non c'era nessun
    // `fish_bite`, perché l'id del bobber non era nella mappa delle entità e la
    // guardia scartava l'evento prima di registrarlo.
    if (packet.event_id === 'fish_hook_hook' || packet.event_id === 13) {
      this._fishBiteAt = Date.now();
      this.log('fish_bite', { runtimeId, entityType: entity?.type ?? null });
      return;
    }
    if (packet.event_id === 'fish_hook_tease' || packet.event_id === 14) {
      this._fishTeaseAt = Date.now();
      this.log('fish_tease', { runtimeId, entityType: entity?.type ?? null });
      return;
    }
    if (!entity) return;
    if (packet.event_id === 'death_animation' || packet.event_id === 3) {
      entity.health = 0;
      entity.deadAt = Date.now();
      this.log('entity_death', { entityType: entity.type, runtimeId });
      return;
    }
  }

  // Arma la finestra di logging dei pacchetti in arrivo (solo con PACKET_DEBUG=1).
  // `hex`: nomi di pacchetto di cui registrare anche i byte grezzi (`rx_hex`),
  // serve a decodificare a mano una risposta che il decoder non spiega
  // (es. `inventory_slot` con `container: null` durante il mount).
  _armPacketDebug (ms = 25000, hex = null) {
    if (!process.env.PACKET_DEBUG) return false;
    this._packetDebugUntil = Date.now() + ms;
    this._packetDebugHex = Array.isArray(hex) && hex.length ? hex.map(String) : null;
    return true;
  }

  // Login nuovo (primo o dopo un reconnect): tutto cio' che e' legato a un id
  // del server va buttato, perche' i runtime id sono **per sessione**. Tenere
  // la mappa delle entita' lasciava dei fantasmi che il censimento leggeva come
  // mob vivi — e il combat li inseguiva: live demo-r2 del 06/10, 25 fendenti a
  // uno scheletro sul suo runtime id vecchio (50) mentre l'`entity_add` diceva
  // 508, vita del bersaglio ferma a 12 (vedi `_trackEntity`, che toglie il
  // fantasma anche quando il re-add arriva senza un login nuovo).
  _onStartGame (packet) {
    this.position = packet.player_position;
    this.dimension = packet.dimension || 'overworld';
    this.movementAuthority = packet.movement_authority ?? null;
    this.rewindHistorySize = packet.rewind_history_size ?? null;
    this.serverAuthBlockBreaking = packet.server_authoritative_block_breaking ?? false;
    this.inventorySlots = [];
    this.inventory = {};
    this.pickups = {};
    this.entities.clear();
    this._entitiesByUnique.clear();
    this._playersByName.clear();
    this.selectedHotbar = 0;
    this._furnaceSlots = {};
    this.tick = BigInt(packet.current_tick || 0);
    this._tickAnchor = { tick: this.tick, time: Date.now() };
    this._lastSimTick = null;
    this.log('start_game', { serverAuthBlockBreaking: this.serverAuthBlockBreaking, movementAuthority: this.movementAuthority, rewindHistorySize: this.rewindHistorySize });
    this.world.start(packet);
  }

  _onOwnHealth () {
    if (this.health <= 0 && !this._deathEpisode) {
      this._deathEpisode = true;
      this.dead = true;
      this.deaths++;
      this._respawnAt = Date.now() + 1500;
      this._deadSince = Date.now();
      this._armPacketDebug(25000);
      this._motion = null;
      this._velocity = { x: 0, y: 0, z: 0 };
      this._setSleeping(false);
      // Il loot (e gli orb EXP) resta dove si muore: il sito serve al recupero.
      const feet = this._feet || this.position;
      if (feet) {
        this.deathSite = {
          position: { x: +feet.x.toFixed(2), y: +feet.y.toFixed(2), z: +feet.z.toFixed(2) },
          at: Date.now(),
          attempts: 0,
        };
      }
      // Il server ha appena fatto cadere l'intero inventario: lo specchio locale
      // deve svuotarsi qui, non quando il pickup lo ritrova (altrimenti il
      // conteggio raddoppia: vedi `_forgetDroppedInventory`).
      this._forgetDroppedInventory('death');
      this.log('death', { deaths: this.deaths, position: this.pos(), site: this.deathSite?.position ?? null });
    } else if (this.health > 0 && (this.dead || this._deathEpisode)) {
      this.dead = false;
      this._deathEpisode = false;
      this._respawnAt = 0;
      this._deadSince = null;
      this._respawnReconnecting = false;
      this.log('alive_again', { health: this.health });
    }
  }

  _onRespawnPacket (packet) {
    this.log('respawn_packet', { state: packet.state, position: packet.position, dead: this.dead });
    // Il server manda anche respawn "di login" (state di setup): applicali solo
    // quando il bot è davvero morto, altrimenti azzererebbero la posizione.
    if (!this.dead) return;
    // Flusso Bedrock: il client risponde con lo stesso pacchetto e
    // state = 2 (client_ready_to_spawn) per completare il respawn.
    try {
      this.client.write('respawn', {
        position: packet.position ?? { x: 0, y: 0, z: 0 },
        state: 2,
        runtime_entity_id: this.client.entityId,
      });
      this.log('respawn_ready', { state: packet.state });
    } catch (error) {
      this.log('respawn_ready_error', { message: error.message });
    }
    // La posizione di morte arriva nello state 0: si applica solo lo state 1
    // (server pronto), altrimenti si risorgerebbe nel punto in cui si è morti.
    this._pendingRespawn = { position: packet.position ?? null, state: packet.state, at: Date.now() };
    if (packet.state === 1) this._finishRespawn(packet.position);
  }

  _finishRespawn (position) {
    if (position && position.x != null) {
      this.position = { ...position };
      this._syncFeetFromPosition(this.position);
    }
    this._pendingRespawn = null;
    this.dead = false;
    this._respawnAt = 0;
    this._velocity = { x: 0, y: 0, z: 0 };
    this._motion = null;
    this.log('respawn', { position: this.pos() });
    if (this.client && this.position) this.world.requestAround(this.client, this.position);
  }

  // Chiamata dall'heartbeat: respawn automatico e sveglia di sicurezza all'alba.
  _survivalTick () {
    if (!this.client) return;
    if (this.dead && Date.now() >= this._respawnAt) {
      this._respawnAt = Date.now() + 2500;
      try {
        this.client.write('player_action', {
          runtime_entity_id: this.client.entityId,
          action: 'respawn',
          position: { x: 0, y: 0, z: 0 },
          result_position: { x: 0, y: 0, z: 0 },
          face: 0,
        });
        this.log('respawn_request', { deaths: this.deaths });
      } catch (error) {
        this.log('respawn_error', { message: error.message });
      }
    }
    // Fallback: se il server ha risposto al respawn ma non ha mandato lo state 1.
    if (this.dead && this._pendingRespawn && Date.now() - this._pendingRespawn.at > 4000) {
      this._finishRespawn(this._pendingRespawn.position);
    }
    // Limbo post-respawn: il fallback ha chiuso il respawn lato client ma il
    // server non ha ancora riportato la vita sopra zero (input ignorati).
    // Si riapre il flusso di respawn finché la vita non torna.
    if (!this.dead && this.health <= 0) {
      this._limboSince = this._limboSince || Date.now();
      if (Date.now() - this._limboSince > 5000) {
        this.dead = true;
        this._respawnAt = Date.now() + 500;
        this._limboSince = null;
        this.log('respawn_limbo_recover', { health: this.health, deaths: this.deaths });
      }
    } else {
      this._limboSince = null;
    }
    // Workaround BDS 1.26.52 (vedi docs/wiki/open-questions.md, riga 12):
    // dopo una morte il server ignora `player_action respawn` e, pur rispondendo
    // al pacchetto `respawn` (state 0 -> 1) col punto di spawn, NON ripristina la
    // vita: il player resta a 0. L'unico recovery noto e' un login nuovo (un
    // reconnect), quindi se il respawn non si completa entro N secondi si chiude
    // il client: il harness riconnette (nuovo login) e il player risorge sano.
    if (this.dead && this._deadSince && !this._respawnReconnecting &&
        Date.now() - this._deadSince > RESPAWN_RECONNECT_MS) {
      this._respawnReconnecting = true;
      this.log('respawn_reconnect', { deadMs: Date.now() - this._deadSince, deaths: this.deaths });
      closeBedrockClient(this.client, 'respawn-stuck').catch(error =>
        this.log('respawn_reconnect_error', { message: error.message }));
      return;
    }
    if (this.sleeping && this._timeBase && !this._isNight()) {
      this._daySince = this._daySince || Date.now();
      if (Date.now() - this._daySince > 5000) { this._wake(); this._daySince = null; }
    } else if (!this.sleeping) {
      this._daySince = null;
    }
  }

  _recordTime (ticks) {
    if (!Number.isFinite(ticks)) return;
    this._timeBase = { ticks, at: Date.now() };
  }

  // BDS 1.26 non manda set_time: l'ora del giorno arriva dal world clock
  // (initialize_registry all'ingresso, sync_state periodico).
  _onWorldClocks (packet) {
    if (packet.payload_type === 'initialize_registry') {
      const clocks = packet.clocks || [];
      const chosen = clocks.find(clock => /overworld|daylight|day/i.test(clock.name || '')) || clocks[0];
      if (chosen) {
        this._worldClockId = String(chosen.id);
        this._recordTime(chosen.time);
        this.log('world_clock', { name: chosen.name, id: String(chosen.id), time: chosen.time, paused: chosen.paused });
      }
      return;
    }
    if (packet.payload_type === 'sync_state') {
      const states = packet.sync_states || [];
      const chosen = this._worldClockId
        ? states.find(state => String(state.clock_id) === this._worldClockId)
        : states[0];
      if (chosen) {
        if (!this._worldClockId) this._worldClockId = String(chosen.clock_id);
        this._recordTime(chosen.time);
      }
    }
  }

  _timeInfo () {
    if (!this._timeBase) return null;
    const ticks = Math.round(estimatedTimeOfDay(this._timeBase.ticks, this._timeBase.at));
    return { ticks, phase: timePhase(ticks), night: isNightTime(ticks), rain: this._weather.rain, thunder: this._weather.thunder };
  }

  _isNight () {
    return !!this._timeInfo()?.night;
  }

  _isThundering () {
    return this._weather?.thunder === true;
  }

  // Finestra di sonno vanilla: notte oppure temporale, a qualunque ora del
  // giorno. La sola pioggia allarga la finestra notturna, non la apre di giorno.
  _isSleepTime () {
    return this._isNight() || this._isThundering();
  }

  // Meteo dal level_event: pioggia e temporale sono due flag indipendenti ma
  // coerenti (un temporale asciutto non esiste), quindi start_thunder accende
  // anche la pioggia e stop_rain chiude anche il temporale.
  _setWeather (patch, { id = null, event = null } = {}) {
    const rain = patch.rain ?? this._weather.rain;
    const thunder = patch.thunder ?? this._weather.thunder;
    if (rain === this._weather.rain && thunder === this._weather.thunder) return;
    this._weather = { rain, thunder, at: Date.now() };
    this.log('weather_change', { id, event, rain, thunder });
  }

  _setSleeping (sleeping) {
    if (this.sleeping === sleeping) return;
    this.sleeping = sleeping;
    if (sleeping) {
      if (this._motion?.active) this._finishMotion('sleeping');
      this._freeJump = null;
      this._velocity = { x: 0, y: 0, z: 0 };
    }
    this._daySince = null;
    this.log(sleeping ? 'sleep_start' : 'sleep_end', { position: this.pos() });
  }

  _wake () {
    if (!this.sleeping || !this.client) return;
    const bed = this._bedCache?.bed;
    this.client.write('player_action', {
      runtime_entity_id: this.client.entityId,
      action: 'stop_sleeping',
      position: bed ? { x: bed.position.x, y: bed.position.y, z: bed.position.z } : { x: 0, y: 0, z: 0 },
      result_position: { x: 0, y: 0, z: 0 },
      face: 0,
    });
  }

  _entityDistance (entity) {
    if (!this.position || !entity?.position) return Infinity;
    const centerY = entity.position.y + entityHeight(entity.type) * 0.5;
    return Math.hypot(entity.position.x - this.position.x, centerY - this.position.y, entity.position.z - this.position.z);
  }

  _pointDistance (point) {
    if (!this.position || !point) return Infinity;
    return Math.hypot(point.x - this.position.x, point.y + 0.5 - this.position.y, point.z - this.position.z);
  }

  // Risolve un gamertag (case-insensitive) nell'entità giocatore tracciata.
  _playerByName (name) {
    const key = stripFormatting(name)?.toLowerCase();
    if (!key) return null;
    const runtimeId = this._playersByName.get(key);
    return runtimeId ? (this.entities.get(runtimeId) || null) : null;
  }

  _pruneEntities () {
    if (!this.entities.size) return;
    const now = Date.now();
    for (const [runtimeId, entity] of this.entities) {
      // I giocatori non si potano mai per inattivita' o distanza: un umano fermo
      // non produce pacchetti di movimento, e il server manda `add_player` solo
      // quando un giocatore *entra* nel campo visivo (non lo ripete per chi e' gia'
      // in vista). Con la vecchia regola dei 60 s l'entita' spariva e non tornava
      // piu': `follow_player` non veniva piu' offerto e un ordine "seguimi" di un
      // umano immobile restava senza effetto per sempre (osservato live sul BDS).
      // Per loro l'unica fonte di verita' e' il `remove_entity` del server: e' lui
      // a cullare le entita' quando escono dal campo visivo del client.
      const stale = entity.kind !== 'player' && now - entity.lastAt > 60000;
      const far = entity.kind !== 'player' && entity.position && this.position && this._entityDistance(entity) > 64;
      if (stale || far) {
        this.entities.delete(runtimeId);
        if (entity.uniqueId) this._entitiesByUnique.delete(entity.uniqueId);
        if (entity.username) this._playersByName.delete(entity.username.toLowerCase());
      }
    }
  }

  _nearbyEntities (limit = 8) {
    const rows = [];
    for (const entity of this.entities.values()) {
      if (!entity.position) continue;
      const distance = this._entityDistance(entity);
      if (distance > 24) continue;
      rows.push({
        type: entity.type,
        kind: entity.kind,
        username: entity.username ?? null,
        hostile: entity.kind === 'mob' && isHostileType(entity.type),
        distance: +distance.toFixed(1),
        position: {
          x: +entity.position.x.toFixed(1),
          y: +entity.position.y.toFixed(1),
          z: +entity.position.z.toFixed(1),
        },
        health: entity.health ?? null,
      });
    }
    rows.sort((a, b) => a.distance - b.distance);
    return rows.slice(0, limit);
  }

  // Giocatori umani percepiti entro `range` blocchi (il bot stesso escluso).
  // Separato da `_nearbyEntities` perché quello è limitato a 8 righe totali:
  // con otto mob addosso un umano vicino sparirebbe dalla lista e non verrebbe
  // mai salutato. Esposto in `observe().humans`.
  _nearbyHumanPlayers ({ range = HUMAN_RANGE, limit = 8 } = {}) {
    const rows = [];
    for (const entity of this.entities.values()) {
      if (entity.kind !== 'player' || !entity.username || !entity.position) continue;
      if (this.isSelfName(entity.username)) continue;
      const distance = this._entityDistance(entity);
      if (distance > range) continue;
      rows.push({
        username: entity.username,
        distance: +distance.toFixed(1),
        position: {
          x: +entity.position.x.toFixed(1),
          y: +entity.position.y.toFixed(1),
          z: +entity.position.z.toFixed(1),
        },
      });
    }
    rows.sort((a, b) => a.distance - b.distance);
    return rows.slice(0, limit);
  }

  // Animali da fattoria vivi entro 32 blocchi, con stato baby/inlove/tempted e
  // owner (per non toccare i domestici). Mai i villager (isFarmAnimalType li esclude).
  _nearbyFarmAnimals (limit = 12) {
    const rows = [];
    for (const entity of this.entities.values()) {
      if (entity.kind !== 'mob' || !entity.position || !isFarmAnimalType(entity.type)) continue;
      if (entity.health != null && entity.health <= 0 && entity.deadAt) continue;
      const distance = this._entityDistance(entity);
      if (distance > 32) continue;
      rows.push({
        type: entity.type,
        runtimeId: entity.runtimeId,
        position: entity.position,
        distance: +distance.toFixed(1),
        health: entity.health ?? null,
        baby: !!entity.baby,
        inlove: !!entity.inlove,
        tempted: !!entity.tempted,
        sheared: !!entity.sheared,
        ownerEid: entity.ownerEid ?? null,
      });
    }
    rows.sort((a, b) => a.distance - b.distance);
    return rows.slice(0, limit);
  }

  // Animali da compagnia (domabili con cibo, cavalcabili, axolotl/nautilus) con
  // stato tamed/trusting/owner. Mai i villager.
  _nearbyCompanion (limit = 12) {
    const rows = [];
    for (const entity of this.entities.values()) {
      if (entity.kind !== 'mob' || !entity.position || !isCompanionType(entity.type)) continue;
      if (entity.health != null && entity.health <= 0 && entity.deadAt) continue;
      const distance = this._entityDistance(entity);
      if (distance > 32) continue;
      rows.push({
        type: entity.type,
        runtimeId: entity.runtimeId,
        position: entity.position,
        distance: +distance.toFixed(1),
        health: entity.health ?? null,
        tamed: !!entity.tamed,
        trusting: !!entity.trusting,
        baby: !!entity.baby,
        ownerEid: entity.ownerEid ?? null,
      });
    }
    rows.sort((a, b) => a.distance - b.distance);
    return rows.slice(0, limit);
  }

  // Alias retrocompatibile (tests): i compagni domabili con cibo sono un
  // sottoinsieme di _nearbyCompanion.
  _nearbyTameable (limit = 12) {
    return this._nearbyCompanion(limit).filter(e => isTameableType(e.type));
  }

  _farmAnimalOfType (type) {
    const wanted = normalizeEntityType(type);
    return this._nearbyFarmAnimals(64).find(e => e.type === wanted) || null;
  }

  // Bersaglio di attacco: ostile se presente, altrimenti animale da fattoria
  // (l'azione attack_<tipo> copre entrambi).
  _entityOfType (type) {
    const wanted = normalizeEntityType(type);
    // Le righe di `_hostiles`/`_farmAnimalOfType` portano il tipo come arriva
    // dal server, che su Bedrock può essere nudo (`zombie`) o con namespace
    // (`minecraft:enderman`): confrontare i nomi grezzi rendeva un
    // `attack_enderman` impossibile contro un server che manda il namespace.
    const matches = entity => normalizeEntityType(entity.type) === wanted;
    const hostile = this._hostiles().find(matches);
    if (hostile) return hostile;
    return this._farmAnimalOfType(wanted) || null;
  }

  // Ostili vivi entro 32 blocchi, ordinati per distanza.
  _hostiles () {
    const rows = [];
    for (const entity of this.entities.values()) {
      if (entity.kind !== 'mob' || !entity.position || !isHostileType(entity.type)) continue;
      if (entity.health != null && entity.health <= 0 && entity.deadAt) continue;
      const distance = this._entityDistance(entity);
      if (distance > 32) continue;
      rows.push({
        type: entity.type,
        runtimeId: entity.runtimeId,
        position: entity.position,
        health: entity.health ?? null,
        distance,
      });
    }
    rows.sort((a, b) => a.distance - b.distance);
    return rows;
  }

  _hostileOfType (type) {
    const wanted = normalizeEntityType(type);
    return this._hostiles().find(entity => entity.type === wanted) || null;
  }

  async _selectWeapon () {
    // Il danno a mani nude è minimo: preferisci spada, poi ascia, poi piccone.
    let best = null;
    for (const kind of ['sword', 'axe', 'pickaxe']) {
      const candidate = this._bestInventoryTool(kind);
      if (candidate) { best = candidate; break; }
    }
    if (!best) return null;
    const index = this.inventorySlots.findIndex(s => this._slotItemName(s) === best.name && s.count > 0);
    if (index < 0) return null;
    try {
      const hotbar = index > 8 ? await this._moveSlotToHotbar(index) : index;
      if (!this._selectHotbarSlot(hotbar)) return null;
      return best.name;
    } catch (error) {
      this.log('weapon_equip_failed', { weapon: best.name, message: error.message });
      return null;
    }
  }

  _attackEntity (entity) {
    const held = this.inventorySlots[this.selectedHotbar] || { network_id: 0 };
    let runtimeId;
    try { runtimeId = BigInt(entity.runtimeId); } catch { return false; }
    // N5: di un enderman si colpisce il torso, mai gli occhi — è la stessa
    // disciplina della mira in `_combat`, applicata al punto di click.
    const centerY = isEndermanType(entity.type)
      ? endermanAimPoint(entity.position).y
      : entity.position.y + entityHeight(entity.type) * 0.5;
    this.client.write('inventory_transaction', {
      transaction: {
        legacy: { legacy_request_id: 0 },
        transaction_type: 'item_use_on_entity',
        actions: [],
        transaction_data: {
          entity_runtime_id: runtimeId,
          action_type: 'attack',
          hotbar_slot: this.selectedHotbar,
          held_item: held,
          player_pos: { ...this.position },
          click_pos: { x: entity.position.x, y: centerY, z: entity.position.z },
        },
      },
    });
    this.client.write('animate', { action_id: 'swing_arm', runtime_entity_id: this.client.entityId, data: 0, has_swing_source: false });
    this.log('attack', { target: entity.type, runtimeId: entity.runtimeId, distance: +this._entityDistance(entity).toFixed(2), targetHealth: entity.health ?? null });
    return true;
  }

  // Stato del bersaglio bloccato per identità (runtime id): `dead` solo con un
  // segnale di morte osservato (health a 0 dall'evento death o dai metadata),
  // `gone` quando il server lo ha rimosso (o è uscito dal raggio di tracking).
  _lockedTargetState (runtimeId) {
    const entity = this.entities.get(String(runtimeId));
    if (!entity) return { entity: null, state: 'gone' };
    if (entity.health != null && entity.health <= 0) return { entity, state: 'dead' };
    return { entity, state: 'alive' };
  }

  // Insegue e colpisce UN bersaglio (scelto una volta per runtime id) finché non
  // muore o scade il tempo: un'azione del controller copre l'intero scontro.
  // Il bersaglio non viene ri-risolto a ogni fendente: con più esemplari vicini
  // ri-risolvere il più prossimo spalmava i colpi su mob diversi e nessuno
  // moriva (evidenza live 03/10: `attack_chicken` → 35 fendenti su almeno tre
  // galline, `targetHealth` che non scendeva mai a 0, `combat_timeout`).
  async _combat (type, timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    let hits = 0;
    let weapon = null;
    let approachFailures = 0;
    let lockedId = null;
    let lockedHealth = null;
    let silentHits = 0;
    let lastHitAt = 0;
    let weaponChecked = false;
    // Nessun successo inventato: `killed` solo con un segnale di morte, oppure
    // con l'entità rimossa subito dopo un fendente (il vicino che se ne va non
    // conta come uccisione).
    const killResult = (confirmedBy) => ({ ok: true, killed: true, hits, weapon, confirmedBy });
    const lostResult = () => (hits > 0 ? { ok: false, error: 'target_lost', hits, weapon } : { ok: false, error: 'target_gone', hits });
    while (Date.now() < deadline) {
      if (this.dead) return { ok: false, error: 'died_in_combat', hits };
      if (!lockedId) {
        const acquired = this._entityOfType(type);
        if (!acquired) return lostResult();
        lockedId = String(acquired.runtimeId);
      }
      const { entity, state } = this._lockedTargetState(lockedId);
      if (state === 'dead') return killResult('health');
      if (state === 'gone') {
        if (hits > 0 && Date.now() - lastHitAt <= 2000) return killResult('entity_removed');
        lockedId = null;
        continue;
      }
      const distance = this._entityDistance(entity);
      if (distance > 3.4) {
        try {
          await this._moveTo(entity.position, 2.0, Math.min(8000, Math.max(1000, deadline - Date.now())));
        } catch (error) {
          approachFailures++;
          const now = this._lockedTargetState(lockedId);
          if (now.state === 'dead') return killResult('health');
          if (now.state === 'gone') {
            lockedId = null;
            if (hits > 0) return lostResult();
            continue;
          }
          if (approachFailures >= 3) return { ok: false, error: `cannot_reach_target: ${error.message}`, hits };
        }
        continue;
      }
      if (!weapon && !weaponChecked) { weapon = await this._selectWeapon(); weaponChecked = true; }
      // N5: di un enderman si mira il torso, mai gli occhi — è la mira a
      // decidere se lo scontro inizia con un teletrasporto addosso.
      const aimY = isEndermanType(type)
        ? endermanAimPoint(entity.position).y
        : entity.position.y + entityHeight(entity.type) * 0.5;
      const aim = this._lookAt({ x: entity.position.x, y: aimY, z: entity.position.z });
      await this._queueAuthInput({ yaw: aim.yaw, pitch: aim.pitch });
      await delay(120);
      const pre = this._lockedTargetState(lockedId);
      if (pre.state === 'dead') return killResult('health');
      if (pre.state === 'gone') {
        lockedId = null;
        if (hits > 0) return lostResult();
        continue;
      }
      this._attackEntity(pre.entity);
      hits++;
      lastHitAt = Date.now();
      // Il server conferma un fendente solo con la vita del bersaglio che
      // scende: se resta identica il colpo non e' arrivato a nessuno (runtime id
      // stantio, l'entita' e' rinata con un id nuovo e il vecchio non esiste piu'
      // lato server). Dopo `ATTACK_SILENT_HITS` colpi muti si ri-risolve il
      // bersaglio invece di continuare a colpire un fantasma per tutto il
      // timeout: e' quello che e' successo live il 06/10 (`attack_skeleton`
      // `{ok:false, error:'died_in_combat', hits:25}` con la vita ferma a 12).
      const health = pre.entity.health;
      if (health != null && lockedHealth != null && health === lockedHealth) silentHits++;
      else silentHits = 0;
      if (health != null) lockedHealth = health;
      if (silentHits >= ATTACK_SILENT_HITS) {
        const fresh = this._entityOfType(type);
        this.log('attack_no_damage', {
          target: type,
          runtimeId: lockedId,
          hits,
          health,
          silentHits,
          reappeared: fresh ? String(fresh.runtimeId) : null,
        });
        silentHits = 0;
        if (fresh && String(fresh.runtimeId) !== String(lockedId)) {
          lockedId = String(fresh.runtimeId);
          lockedHealth = null;
        }
      }
      const waitUntil = Math.min(deadline, Date.now() + 550);
      while (Date.now() < waitUntil) {
        const watched = this._lockedTargetState(lockedId);
        if (watched.state === 'dead') return killResult('health');
        if (watched.state === 'gone') return killResult('entity_removed');
        if (this._entityDistance(watched.entity) > 4.5) break;
        await delay(50);
      }
    }
    return { ok: false, error: 'combat_timeout', hits, weapon };
  }

  // Punto camminabile più vicino alla cella indicata, cercando in verticale.
  _standableNear (point) {
    if (!this._feet) return null;
    const x = Math.floor(point.x), z = Math.floor(point.z);
    const baseY = Math.floor(this._feet.y + 1e-3);
    for (let dy = 2; dy >= -4; dy--) {
      const y = baseY + dy;
      if (this._standable(x, y, z)) return { x: x + 0.5, y, z: z + 0.5 };
    }
    return null;
  }

  // Allontana il bot dal mob ostile più vicino provando Direzioni e distanze
  // diverse (un percorso può essere bloccato in una direzione ma non in un'altra).
  async _flee (timeoutMs = 15000) {
    if (!this._feet) return { ok: false, error: 'no_position' };
    const threats = this._hostiles();
    if (!threats.length) return { ok: true, fled: false, reason: 'no_threat' };
    const threat = threats[0];
    const away = awayDirection(this._feet, threat.position);
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    for (const offset of [0, 30, -30, 60, -60, 90, -90, 180]) {
      const dir = rotateDirection(away, offset);
      for (const distance of [12, 16, 9]) {
        if (Date.now() >= deadline) break;
        const candidate = this._standableNear({ x: this._feet.x + dir.x * distance, z: this._feet.z + dir.z * distance });
        if (!candidate) continue;
        // Allontanarsi conta solo se la destinazione è davvero raggiungibile:
        // altrimenti si brucia il timeout in path_failed (bot rinchiuso).
        if (this._reachabilityUsable() && !this.cellReachable(candidate)) continue;
        try {
          await this._moveTo(candidate, 0.8, Math.min(7000, Math.max(1500, deadline - Date.now())));
          const nearest = this._hostiles()[0];
          return {
            ok: true,
            from: threat.type,
            fromDistance: +threat.distance.toFixed(1),
            position: this.pos(),
            nearestThreat: nearest ? { type: nearest.type, distance: +nearest.distance.toFixed(1) } : null,
          };
        } catch (error) {
          lastError = error.message;
          // Un timeout può comunque aver allontanato il bot: se il distacco è
          // reale l'azione è riuscita, anche se il percorso non è arrivato a meta.
          const nearest = this._hostiles().find(h => h.type === threat.type);
          if (nearest && nearest.distance > threat.distance + 3) {
            return {
              ok: true,
              partial: true,
              from: threat.type,
              fromDistance: +threat.distance.toFixed(1),
              position: this.pos(),
              nearestThreat: { type: nearest.type, distance: +nearest.distance.toFixed(1) },
            };
          }
        }
      }
    }
    return { ok: false, error: `flee_failed${lastError ? `: ${lastError}` : ''}` };
  }

  // Rientra verso casa (spawn o HOME_WAYPOINT). `retreat` è un alias di `go_home`
  // per i momenti di pericolo: la scelta tra flee e retreat resta al controller.
  async _goHome (timeoutMs = 45000) {
    if (!this.home) return { ok: false, error: 'no_home' };
    if (!this.position) return { ok: false, error: 'no_position' };
    const home = this.home;
    const dist = Math.hypot(home.x - this.position.x, home.z - this.position.z);
    if (dist <= 2) return { ok: true, arrived: true, home, distance: +dist.toFixed(1) };
    const startedAt = Date.now();
    const budgetLeft = () => Math.max(0, timeoutMs - (Date.now() - startedAt));
    let directError = null;
    try {
      const moveResult = await this._moveTo(home, 2, Math.max(5000, Math.round(timeoutMs * 0.6)));
      const remaining = Math.hypot(home.x - (this.position?.x ?? 0), home.z - (this.position?.z ?? 0));
      if (remaining <= 2) return { ok: true, home, ...moveResult, distance: +remaining.toFixed(1), via: 'direct' };
      directError = `arrived ${remaining.toFixed(1)} blocks away`;
    } catch (error) {
      directError = error.message;
    }
    // Il percorso diretto non esiste: pozzo profondo, A* che esaurisce i 5000 nodi
    // o nessuna rotta completa dentro le celle raggiungibili esplorate. Live il
    // 06/10 `go_home` rispondeva `path_failed` otto volte dal fondo miniera e
    // l'unico ritorno che ha funzionato sono state tappe di waypoint decise a
    // mano; qui le tappe le sceglie il harness (docs/wiki/open-questions.md).
    const budget = budgetLeft();
    if (budget < 3000) return { ok: false, error: `go_home_failed: ${directError}` };
    let hops = null;
    try {
      hops = await this._homeHops(home, { timeoutMs: budget });
    } catch (error) {
      hops = { ok: false, error: `hop_error: ${error.message}`, hops: 0, trail: [] };
    }
    if (hops.ok) {
      const remaining = Math.hypot(home.x - (this.position?.x ?? 0), home.z - (this.position?.z ?? 0));
      return {
        ok: true,
        partial: remaining > 2,
        home,
        via: 'hops',
        hops: hops.hops,
        trail: hops.trail,
        distance: +remaining.toFixed(1),
      };
    }
    return {
      ok: false,
      error: `go_home_failed: ${directError}`,
      via: 'hops',
      hops: hops.hops,
      hopError: hops.error,
      trail: hops.trail,
    };
  }

  // Ritorno a tappe: cammina verso le celle *raggiungibili* che si avvicinano a
  // casa, un pezzo corto alla volta (`hopRange` blocchi), invece di chiedere al
  // pathfinder una rotta unica da 50-60 blocchi di dislivello che non trova.
  // Ogni tappa resta dentro `hopTimeMs`, così il budget A* non si esaurisce, e la
  // tappa deve far guadagnare almeno un blocco di distanza: senza progresso si
  // ferma con `no_progress` invece di girare a vuoto.
  async _homeHops (home, { timeoutMs = 20000, hopTimeMs = 12000, maxHops = 12, hopRange = 24 } = {}) {
    const deadline = Date.now() + timeoutMs;
    const trail = [];
    const cellOf = () => {
      const start = this._startNode ? this._startNode() : null;
      return start ? { x: start.x, y: start.y, z: start.z } : null;
    };
    const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    for (let hop = 0; hop < maxHops && Date.now() < deadline; hop++) {
      const here = cellOf();
      if (!here) return { ok: false, error: 'no_position', hops: trail.length, trail };
      const hereDistance = d3(here, home);
      if (hereDistance <= 2) return { ok: true, arrived: true, hops: trail.length, trail, distance: hereDistance };
      const reach = this.reachableCells({ limit: 4000 });
      let next = null;
      let best = hereDistance - 1;
      for (const key of reach?.cells ?? []) {
        const [x, y, z] = String(key).split(',').map(Number);
        if (![x, y, z].every(Number.isFinite)) continue;
        const candidate = { x, y, z };
        const distance = d3(candidate, home);
        if (distance >= best) continue;
        if (d3(candidate, here) > hopRange) continue;
        best = distance;
        next = candidate;
      }
      if (!next) return { ok: false, error: 'no_progress', hops: trail.length, trail, distance: hereDistance };
      const goal = { x: next.x + 0.5, y: next.y, z: next.z + 0.5 };
      try {
        await this._moveTo(goal, 1.5, Math.min(hopTimeMs, Math.max(2000, deadline - Date.now())));
      } catch (error) {
        trail.push({ hop, from: here, goal: next, got: cellOf(), error: error.message });
        return { ok: false, error: `hop_failed: ${error.message}`, hops: trail.length, trail };
      }
      trail.push({ hop, from: here, goal: next, distance: +best.toFixed(1) });
    }
    const last = cellOf();
    const distance = last ? d3(last, home) : null;
    if (distance !== null && distance <= 2) return { ok: true, arrived: true, hops: trail.length, trail, distance };
    return { ok: false, error: 'hop_budget_exhausted', hops: trail.length, trail, distance };
  }

  // ---- armatura e porte (difesa) -------------------------------------------------------

  // La verità sull'armatura indossata è la **finestra `armor` del server**
  // (WindowID 120, slot 0..3 = elmo, pettorale, gambali, stivali), che il server
  // rispedisce a ogni ingresso e a ogni cambio di pezzo. Il commento precedente
  // diceva che l'armatura «è già tracciata da `mob_equipment`»: falso, perché
  // `_onMobEquipment` legge solo la mano selezionata e l'offhand, e `_playerSlotIndex`
  // non conosce la finestra 'armor'. Senza questa via un pezzo indossato prima di
  // una riconnessione spariva da `observe().armor` (live 09/10/2026: slot 0..3
  // pieni a ogni ingresso e `armor` tutto null).
  _applyArmorWindowSlot (slot, item) {
    const index = Number(slot);
    if (!Number.isInteger(index) || index < 0 || index > 3) return false;
    this._armorWindow[index] = this._armorWindowItem(item);
    this._refreshArmorMirror();
    const wear = this._armorSlots()[index];
    this.log('armor_slot', {
      slot: index,
      item: this._armorWindow[index] ? `${this._slotItemName(this._armorWindow[index]) ?? this._armorWindow[index].network_id}:${this._armorWindow[index].count}` : null,
      damage: wear?.damage ?? null,
      max: wear?.max ?? null,
      worn: this._wornArmor().join(' ') || null,
    });
    return true;
  }

  // Lo slot grezzo dell'armatura con tutto ciò che serve a nominarlo *e* a
  // misurarlo: `metadata`/`extra` portano l'NBT Damage che `_itemDamage()` legge,
  // e scartarli era il motivo per cui la durabilità dell'armatura non esisteva.
  _armorWindowItem (item) {
    if (!item || !item.count) return null;
    return {
      name: item.name ?? null,
      network_id: item.network_id ?? null,
      count: item.count,
      stack_id: item.stack_id ?? null,
      metadata: item.metadata ?? 0,
      extra: item.extra ?? null,
    };
  }

  // I nomi si ricavano dagli slot grezzi ogni volta: la finestra può arrivare
  // prima della palette (che arriva con `start_game`/`item_registry`), quindi non
  // si congela nulla al momento del pacchetto.
  _refreshArmorMirror () {
    const pieces = ['helmet', 'chestplate', 'leggings', 'boots'];
    for (let i = 0; i < pieces.length; i++) {
      const item = this._armorWindow[i];
      this.armor[pieces[i]] = item ? this._slotItemName(item) : null;
    }
    return { ...this.armor };
  }

  // Cosa indossa, pezzo per pezzo, con la durabilità che il server conosce. Un
  // pezzo che la palette non sa ancora nominare resta un pezzo addosso (`name:
  // null`, ma `network_id` c'è): contare i nomi lo faceva leggere come pelle
  // nuda, ed è la stessa cecità che teneva `wear_armor` impossibile. La
  // durabilità arriva dall'NBT Damage e dal `maxDurability` del registro (che è
  // per *nome*, quindi affidabile: gli id inclusi no, vedi la nota in testa al
  // file) — `remaining`/`low` restano null quando il massimo è ignoto.
  _armorSlots () {
    const order = ['helmet', 'chestplate', 'leggings', 'boots'];
    return order.map((piece, i) => {
      const slot = this._armorWindow?.[i];
      if (!slot || (!slot.network_id && !slot.name)) return null;
      const info = this.world?.registry?.items?.[slot.network_id] ?? null;
      const max = Number.isFinite(info?.maxDurability) && info.maxDurability > 0 ? info.maxDurability : null;
      const damage = this._itemDamage(slot);
      const remaining = max != null ? Math.max(0, max - damage) : null;
      return {
        piece,
        name: this._slotItemName(slot),
        network_id: slot.network_id ?? null,
        count: slot.count ?? 1,
        damage,
        max,
        remaining,
        low: remaining != null ? remaining / max <= 0.1 : null,
      };
    });
  }

  // I pezzi d'armatura addosso, nella forma che serve alla neutralità dei piglin
  // (N4): si legge il riflesso della finestra 'armor' del server.
  _wornArmor () {
    return Object.values(this.armor ?? {}).filter(Boolean);
  }

  _armorSlotFor (name) {
    if (!name) return -1;
    if (name === 'turtle_helmet' || /_helmet$/.test(name)) return 0;
    if (name === 'elytra' || /_chestplate$/.test(name)) return 1;
    if (/_leggings$/.test(name)) return 2;
    if (/_boots$/.test(name)) return 3;
    return -1;
  }

  // Punti armatura vanilla (elmo/pettorale/gambali/stivali) per materiale.
  _armorPoints () {
    const byMaterial = {
      leather: [1, 3, 2, 1], golden: [2, 5, 3, 1], chainmail: [2, 5, 4, 1],
      iron: [2, 6, 5, 2], diamond: [3, 8, 6, 3], netherite: [3, 8, 6, 3],
    };
    const order = ['helmet', 'chestplate', 'leggings', 'boots'];
    let total = 0;
    for (let i = 0; i < order.length; i++) {
      const name = this.armor[order[i]];
      if (!name) continue;
      const material = Object.keys(byMaterial).find(m => name.startsWith(m));
      if (material) total += byMaterial[material][i];
    }
    return total;
  }

  // Pezzi d'armatura che uno **slot** dell'inventario mostra davvero. `_equipArmor`
  // parte da qui, non dall'aggregato: l'aggregato somma anche i pickup.
  _armorPiecesInSlots () {
    const pieces = [];
    for (let index = 0; index < this.inventorySlots.length; index++) {
      const slot = this.inventorySlots[index];
      const name = this._slotItemName(slot);
      const armorSlot = this._armorSlotFor(name);
      if (armorSlot < 0 || !slot?.count) continue;
      pieces.push({ index, name, armorSlot, stack_id: slot.stack_id || 0, network_id: slot.network_id });
    }
    return pieces;
  }

  // Un pezzo che l'aggregato conosce ma che nessuno slot mostra (specchio stantio,
  // tipicamente appena raccolto o dopo una morte).
  _carriedArmorPiece () {
    return Object.keys(this.inventory).find(name => this._armorSlotFor(name) >= 0) || null;
  }

  // L'armatura si indossa con la stessa primitiva dello scudo (take sul cursore +
  // place nella container 'armor') e con le stesse due lezioni di campo: un `place`
  // rifiutato non e' un successo dichiarato, e un pezzo che l'aggregato dice di
  // avere ma che nessuno slot mostra e' uno specchio stantio, non "nessuna
  // armatura". L'errore e' tipizzato come `shield_place_failed_<status>`
  // (`armor_place_failed_<status>`) con gli esiti di ogni tentativo: il 06/10 il
  // run 1 ha fallito un equip di golden_leggings con un `armor_place_failed`
  // contato dall'harness ma **senza status** nel payload, perche' qui ogni
  // fallimento collassava in `armor_equip_failed` (lo status viveva solo nel log
  // del container).
  async _equipArmor () {
    if (this._openContainer) await this._closeContainer();
    let pieces = this._armorPiecesInSlots();
    if (!pieces.length) {
      const carried = this._carriedArmorPiece();
      if (!carried) return { ok: false, error: 'no_armor_in_inventory' };
      // Lo specchio e' stantio: si risincronizza una volta (refresh in place, non
      // per forza una riconnessione) e si rilegge, invece di dichiarare che
      // l'armatura non c'e' mentre `observe().inventory` la mostra.
      this.log('armor_resync', { item: carried });
      try { await this._resyncByReconnect(); } catch (error) { this.log('inventory_resync_failed', { message: error.message }); }
      pieces = this._armorPiecesInSlots();
      if (!pieces.length) return { ok: false, error: 'no_armor_in_inventory', carried };
    }
    const equipped = [];
    const failures = [];
    for (const piece of pieces) {
      let cursorStack = 0;
      try {
        cursorStack = await this._takeToCursor(piece.index, 1);
      } catch (error) {
        // Stessa primitiva dello scudo: un cursore sporco non deve far saltare
        // silenziosamente l'armatura (il caso "place fallito" è documentato).
        this.log('armor_take_failed', { item: piece.name, error: error.message });
        failures.push({ item: piece.name, slot: piece.armorSlot, stage: 'take', error: error.message });
        continue;
      }
      // La finestra aperta al momento del `place` e' la variabile che conta (uno
      // status 50 = FailedToValidateDstSlot): la si registra invece di dedurla
      // per timestamp dagli eventi `container_open`.
      const openAtPlace = this._openContainer ? { id: this._openContainer.id, type: this._openContainer.type } : null;
      let place = null;
      const attempts = [];
      // Un solo ripiego con il cursore ancora carico: un place rifiutato non
      // cambia nulla lato server, quindi la stessa stack id e' ancora valida
      // (e' il ripiego che `_equipShield` fa sull'altro slot dell'offhand).
      for (let attempt = 1; attempt <= 2; attempt++) {
        place = await this._sendStackRequest([{
          type_id: 'place', legacy_type_id: 1, count: 1,
          source: this._slotInfo('cursor', 0, cursorStack),
          destination: this._slotInfo('armor', piece.armorSlot, 0),
        }]).catch(() => null);
        const status = place?.status ?? 'timeout';
        attempts.push({ attempt, destination: `armor/${piece.armorSlot}`, status });
        if (place && (String(status) === 'ok' || status === 0)) break;
        this.log('armor_place_failed', {
          item: piece.name,
          slot: piece.armorSlot,
          status,
          attempt,
          cursor_stack_id: this._cursor?.stack_id ?? null,
          cursorStack,
          openContainer: openAtPlace,
        });
      }
      if (!place || (String(place.status) !== 'ok' && place.status !== 0)) {
        await this._returnCursorToInventory().catch(() => {});
        failures.push({
          item: piece.name,
          slot: piece.armorSlot,
          stage: 'place',
          status: attempts[attempts.length - 1]?.status ?? 'timeout',
          attempts,
          openContainer: openAtPlace,
        });
        continue;
      }
      this._applyStackResponse(place, { networkId: piece.network_id });
      this._cursor = null;
      this.armor[['helmet', 'chestplate', 'leggings', 'boots'][piece.armorSlot]] = piece.name;
      if (piece.armorSlot >= 0 && piece.armorSlot <= 3) {
        this._armorWindow[piece.armorSlot] = this._armorWindowItem(piece) ?? { name: piece.name, network_id: piece.network_id ?? null, count: 1, stack_id: piece.stack_id ?? null, metadata: 0, extra: null };
      }
      equipped.push({ item: piece.name, slot: piece.armorSlot });
      this.log('armor_equip', { item: piece.name, slot: piece.armorSlot, status: place.status });
    }
    this._refreshInventory();
    if (!equipped.length) {
      const last = failures[failures.length - 1];
      const error = last?.stage === 'place' ? `armor_place_failed_${last.status}` : 'armor_equip_failed';
      return { ok: false, error, failures };
    }
    return { ok: true, equipped, failures };
  }

  _closeDoorTarget () {
    if (!this._feet) return null;
    const candidates = [];
    for (const key of this._openDoors) {
      const parts = key.split(',').map(Number);
      if (parts.length !== 3) continue;
      const [x, y, z] = parts;
      // Una porta non si richiude *sulla* cella che il bot occupa: da lì non riesce
      // più a muoversi (live 08/10/2026, tentativo 16). Si sceglie un'altra porta.
      if (this._doorInOwnCell({ x, y, z })) continue;
      const dist = Math.hypot(this._feet.x - (x + 0.5), this._feet.z - (z + 0.5));
      if (dist <= 8) candidates.push({ x, y, z, distance: dist });
    }
    candidates.sort((a, b) => a.distance - b.distance);
    return candidates[0] || null;
  }

  async _closeDoor () {
    const target = this._closeDoorTarget();
    if (!target) return { ok: false, error: 'no_open_door' };
    if (target.distance > 4) {
      try { await this._moveTo({ x: target.x + 0.5, y: target.y, z: target.z + 0.5 }, 2, 20000); } catch { /* resta dove è e prova comunque */ }
    }
    const before = this.world.runtimeIdAt(target);
    const look = this._lookAt({ x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 });
    await this._queueAuthInput({ yaw: look.yaw, pitch: look.pitch, transaction: this._blockUseTransaction(target) });
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      await delay(100);
      const after = this.world.runtimeIdAt(target);
      if (before != null && after != null && after !== before) {
        this._openDoors.delete(`${target.x},${target.y},${target.z}`);
        this.log('door_closed', { position: target });
        return { ok: true, closed: true, position: target };
      }
    }
    this._openDoors.delete(`${target.x},${target.y},${target.z}`);
    return { ok: true, closed: true, unconfirmed: true, position: target };
  }

  // Blocco piazzabile più comune in inventario (per barricare un varco). Con
  // `richest` sceglie quello di cui c'è più copia: un rifugio consuma molti
  // blocchi, quindi conviene spendere lo stack più grosso invece del primo nome
  // in lista (che può essere un singolo pezzo).
  _placeableBlock ({ richest = false, filter = null } = {}) {
    const preferred = ['cobblestone', 'dirt', 'oak_planks', 'spruce_planks', 'cherry_planks', 'birch_planks',
      'stone', 'oak_log', 'spruce_log', 'cherry_log', 'birch_log', 'sand', 'gravel'];
    let owned = preferred.filter(b => (this.inventory[b] || 0) > 0);
    if (typeof filter === 'function') owned = owned.filter(filter);
    if (!richest) return owned[0] ?? null;
    return owned.sort((a, b) => (this.inventory[b] || 0) - (this.inventory[a] || 0))[0] ?? null;
  }

  // Cerca un varco 1×2 aperto (piedi+testa liberi, pavimento e fianchi solidi) nei
  // quattro versi orizzontali: è il candidato a barricata.
  _barricadeGap () {
    const feet = this._feet;
    if (!feet) return null;
    const bx = Math.floor(feet.x), bz = Math.floor(feet.z), by = Math.floor(feet.y + 0.1);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const fx = bx + dx, fz = bz + dz;
      const gap = { feet: { x: fx, y: by, z: fz }, head: { x: fx, y: by + 1, z: fz }, support: { x: fx, y: by - 1, z: fz } };
      if (!this._airAt(gap.feet.x, gap.feet.y, gap.feet.z)) continue;
      if (!this._airAt(gap.head.x, gap.head.y, gap.head.z)) continue;
      if (!this._solidAt(gap.support.x, gap.support.y, gap.support.z)) continue;
      const sx = -dz, sz = dx; // perpendicolare alla direzione del varco
      if (this._solidAt(fx + sx, by, fz + sz) && this._solidAt(fx - sx, by, fz - sz)) return gap;
    }
    return null;
  }

  async _barricade () {
    const block = this._placeableBlock();
    if (!block) return { ok: false, error: 'no_placeable_block' };
    const gap = this._barricadeGap();
    if (!gap) return { ok: false, error: 'no_gap' };
    const placed = [];
    const feetRes = await this._placeAtCell(block, block, gap.feet, gap.support, 1);
    placed.push({ level: 'feet', ...feetRes });
    if (feetRes.ok) {
      const headRes = await this._placeAtCell(block, block, gap.head, gap.feet, 1);
      placed.push({ level: 'head', ...headRes });
    }
    this._refreshNearby();
    const sealed = placed.length === 2 && placed.every(p => p.ok);
    return { ok: sealed, block, placed, ...(sealed ? {} : { error: 'barricade_incomplete' }) };
  }

  // ---- Kit di viaggio (P5): loadout, pillar-up, rifugio provvisorio ----------

  // Salto "a comando" fuori dal pathfinder: se un percorso è già attivo chiede il
  // salto a quello, altrimenti arma un salto libero (`_freeJump`). In entrambi i
  // casi attende che i piedi lascino il suolo. Budget breve: il chiamante ha già
  // un timeout.
  async _jumpOnce (timeoutMs = 1500) {
    if (!this.spawned || !this._feet) return false;
    const motion = this._motion;
    const free = !motion?.active;
    if (free) this._freeJump = { queued: true, heldTicks: 6, start: true };
    else { motion.jumpQueued = true; motion.jumpHeldTicks = 6; motion.jumpStart = true; }
    const started = Date.now();
    try {
      while (Date.now() - started < timeoutMs) {
        await delay(50);
        if (!this._onGround) return true;
      }
      return false;
    } finally {
      if (free) this._freeJump = null;
    }
  }

  // Pillar-up: piazza un blocco nella cella dei piedi mentre è in aria e vi
  // atterra sopra, `blocks` volte. Terza strategia notturna della spec: utile
  // contro i mob terrestri, inutile contro quelli volanti.
  // Celle libere sopra la cella dei piedi (tetto compreso): serve al pillar-up,
  // che per piazzare sotto di sé deve poter alzare i piedi fuori dalla cella.
  _headroom (limit = 6) {
    if (!this._feet) return 0;
    const x = Math.floor(this._feet.x), z = Math.floor(this._feet.z);
    const by = Math.floor(this._feet.y + 0.1);
    let free = 0;
    for (let i = 1; i <= limit; i++) {
      if (!this._airAt(x, by + i, z)) break;
      free++;
    }
    return free;
  }

  async _pillarUp ({ blocks = 1, timeoutMs = 20000 } = {}) {
    if (!this.spawned || !this._feet) return { ok: false, error: 'not_ready' };
    const block = this._placeableBlock({ richest: true });
    if (!block) return { ok: false, error: 'no_placeable_block' };
    // Servono due celle libere sopra i piedi: una per il corpo che sale, una per
    // il salto. In una stanza alta due blocchi il pillar-up è impossibile.
    if (this._headroom() < 2) return { ok: false, error: 'no_headroom', block, headroom: this._headroom() };
    const want = Math.max(1, Math.min(6, Number(blocks) || 1));
    const startY = this._feet.y;
    const steps = [];
    const deadline = Date.now() + Math.max(2000, Number(timeoutMs) || 20000);
    const stop = (error, cell) => {
      steps.push({ ok: false, error, position: cell });
      return { ok: false, error, block, steps, startY, y: this._feet?.y ?? startY };
    };
    while (steps.filter(s => s.ok).length < want) {
      const feet = this._feet;
      if (!feet) return stop('not_ready');
      const cell = { x: Math.floor(feet.x), y: Math.floor(feet.y + 0.1), z: Math.floor(feet.z) };
      const support = { x: cell.x, y: cell.y - 1, z: cell.z };
      if (Date.now() > deadline) return stop('pillar_timeout', cell);
      if (!(this.inventory[block] > 0)) return stop('out_of_blocks', cell);
      if (!this._solidAt(support.x, support.y, support.z)) return stop('no_support', cell);
      if (this._solidAt(cell.x, cell.y, cell.z)) return stop('cell_occupied', cell);
      if (!this._airAt(cell.x, cell.y, cell.z)) return stop('cell_occupied', cell);
      if (!await this._jumpOnce()) return stop('jump_failed', cell);
      // Il blocco va piazzato mentre il corpo ha già lasciato la cella: nella
      // prima parte del salto il server rifiuta un blocco dentro il giocatore
      // (evidenza live: `place_not_confirmed` con i piedi ancora nella cella).
      const clearDeadline = Date.now() + 1200;
      while (Date.now() < clearDeadline) {
        if (this._feet && this._feet.y >= cell.y + 1.02) break;
        await delay(20);
      }
      if (!this._feet || this._feet.y < cell.y + 1.02) return stop('jump_failed', cell);
      const res = await this._placeAtCell(block, block, cell, support, 1);
      steps.push({ ...res, position: cell });
      if (!res.ok) return { ok: false, error: res.error ?? 'place_failed', block, steps, startY, y: this._feet?.y ?? startY };
      // Il server è autoritativo: aspettiamo di essere atterrati *sopra* il
      // blocco appena piazzato prima di ripetere il ciclo.
      const landDeadline = Date.now() + 2500;
      while (Date.now() < landDeadline) {
        await delay(50);
        if (this._onGround && this._feet && this._feet.y >= cell.y + 1) break;
      }
    }
    this._refreshNearby();
    const y = this._feet?.y ?? startY;
    return { ok: true, block, blocks: want, climbed: y - startY, startY, y, steps };
  }

  // Rifugio provvisorio: muri a piedi e testa nei quattro lati + tetto sopra i
  // muri (supporto = il muro a testa, faccia alta). Le celle già solide si
  // saltano, quindi funziona anche in una stanza chiusa a metà. Limiti
  // dichiarati: nessuna porta, il centro sopra il bot resta aperto e non
  // protegge dai mob volanti.
  async _buildHut ({ timeoutMs = 90000 } = {}) {
    if (!this.spawned || !this._feet) return { ok: false, error: 'not_ready' };
    const block = this._placeableBlock({ richest: true });
    if (!block) return { ok: false, error: 'no_placeable_block' };
    const { placed, failed, skipped, covered } = await this._shellAround(shellCells(this._feet), block, { timeoutMs });
    this._refreshNearby();
    const already = placed.length === 0 && failed.length === 0;
    const sealed = failed.length === 0 && covered >= 12;
    return { ok: sealed, block, placed, failed, skipped, already, covered, ...(sealed ? {} : { error: 'hut_incomplete' }) };
  }

  // Costruisce una "casetta" attorno al bot (quattro pareti di due blocchi + la
  // corona del tetto) date le celle. La geometria sta in `shellCells`
  // (`bedrock-nether.mjs`): un rifugio è un rifugio, cambia il materiale, non la
  // forma. Una cella già solida viene saltata (l'ambiente fa metà del lavoro) e
  // il tempo è un budget, non un'attesa: oltre la scadenza il resto è `failed`,
  // mai un blocco piazzato a metà senza dirlo.
  async _shellAround (cells, block, { timeoutMs = 90000 } = {}) {
    const placed = [];
    const failed = [];
    let skipped = 0;
    const deadline = Date.now() + Math.max(5000, Number(timeoutMs) || 90000);
    for (const cell of cells) {
      const target = cell.position;
      if (this._solidAt(target.x, target.y, target.z)) { skipped++; continue; }
      if (Date.now() > deadline) { failed.push({ label: cell.label, position: target, error: 'shell_timeout' }); continue; }
      const res = await this._placeAtCell(block, block, target, cell.support, 1);
      if (res.ok) placed.push({ label: cell.label, position: target });
      else failed.push({ label: cell.label, position: target, error: res.error ?? 'place_failed' });
    }
    return { placed, failed, skipped, covered: placed.length + skipped, block };
  }

  // Un hub nel Nether (N2): la stessa casetta del rifugio notturno, ma con
  // materiale che non prende fuoco (assi e tronchi nel Nether sono legna da
  // ardere) e con il punto ricordato in memoria come `home`, così il bot ha un
  // posto dove rientrare dopo un'esplorazione. Fuori dal Nether/End rifiuta: là
  // il rifugio è `build_hut` e un hub non significa niente.
  async _netherHub ({ timeoutMs = 90000 } = {}) {
    if (!this.spawned || !this._feet) return { ok: false, error: 'not_ready' };
    if (!isNetherLike(this.dimension)) {
      return { ok: false, error: 'wrong_dimension', dimension: this.dimension };
    }
    const owned = Object.entries(this.inventory).map(([name, count]) => ({ name, count }));
    const block = pickHubBlock(owned);
    if (!block) {
      return {
        ok: false,
        error: 'no_hub_materials',
        dimension: this.dimension,
        flammable: owned.filter(e => isFlammableBlock(e.name)).map(e => e.name),
      };
    }
    const plan = netherHubPlan({ feet: this._feet, block });
    if (!plan.ok) return { ok: false, error: plan.error, dimension: this.dimension };
    const { placed, failed, skipped, covered } = await this._shellAround(plan.cells, block, { timeoutMs });
    this._refreshNearby();
    const sealed = failed.length === 0 && covered >= 12;
    this._netherHubLast = { position: plan.origin, block, sealed, covered, at: Date.now() };
    if (sealed) {
      this.memory?.rememberLandmark({
        id: 'nether_hub', type: 'nether_hub', kind: 'home', label: 'nether hub',
        dimension: 'nether', position: plan.origin, source: 'built'
      });
      this.log('nether_hub_built', { position: plan.origin, block, covered });
    }
    return {
      ok: sealed, block, placed, failed, skipped, covered,
      hub: plan.origin, dimension: this.dimension,
      ...(sealed ? {} : { error: 'hub_incomplete' })
    };
  }

  // Prossimo pezzo del kit craftabile *adesso* che manca, in ordine di
  // dipendenza (assi → bastoni → tavolo → torce → letto). Null se non c'è più
  // nulla da fare: è anche il gate dell'opzione `travel_kit`.
  _nextKitCraft () {
    const inv = this.inventory;
    const total = (re) => Object.entries(inv).reduce((s, [n, c]) => s + (re.test(n) ? c : 0), 0);
    const logs = Object.keys(inv).filter(n => /_log$/.test(n) && inv[n] > 0);
    const planks = total(/_planks$/);
    const wool = total(/_wool$/);
    const coal = (inv.coal || 0) + (inv.charcoal || 0);
    if (planks < 3 && logs.length) return logs[0].replace(/_log$/, '_planks');
    if ((inv.stick || 0) < 1 && planks >= 2) return 'stick';
    // La spada del kit: 2 assi + 1 bastone, la prima arma utile in viaggio.
    if (!Object.keys(inv).some(n => /_sword$/.test(n) && inv[n] > 0) && planks >= 2 && (inv.stick || 0) >= 1) return 'wooden_sword';
    if (!(inv.crafting_table > 0) && planks >= 4) return 'crafting_table';
    if (!(inv.torch > 0) && coal >= 1 && (inv.stick || 0) >= 1) return 'torch';
    if (!(inv.bed > 0) && wool >= 3 && planks >= 3) return 'bed';
    return null;
  }

  // Un craft 3×3 (spada, letto, armature) richiede un tavolo *nel mondo*: se non
  // ce n'è uno a portata e ne portiamo uno in inventario, lo piazziamo qui. Così
  // il kit di viaggio basta a se stesso anche lontano dalla base.
  async _ensureCraftingTable () {
    const nearby = this.world.findBlocks?.('crafting_table', this.position, 8, 1) || [];
    if (nearby.length && (this.approachReachable(nearby[0].position) || !this._reachabilityUsable())) {
      return { ok: true, nearby: true, position: nearby[0].position };
    }
    if (!(this.inventory.crafting_table > 0)) return { ok: false, error: 'no_crafting_table' };
    const res = await this._placeBlock('crafting_table', 'crafting_table');
    if (!res.ok) return { ok: false, error: res.error ?? 'table_place_failed' };
    this.log('crafting_table_placed', { position: res.position });
    return { ok: true, placed: true, position: res.position };
  }

  // Ricette del kit che richiedono il tavolo da lavoro (3×3).
  _needsTable (item) {
    return /(_sword|_pickaxe|_axe|_shovel|_hoe|_helmet|_chestplate|_leggings|_boots)$/.test(item) || item === 'bed';
  }

  // Loadout di partenza: crafta in sequenza i pezzi mancanti del kit finché ne
  // resta qualcuno craftabile con l'inventario corrente. Non prende nulla dai
  // container e non tocca il letto/le torce già presenti.
  async _travelKit () {
    const before = this._travelReadiness();
    const crafted = [];
    const failed = [];
    const attempted = new Set();
    for (let i = 0; i < 8; i++) {
      const next = this._nextKitCraft();
      if (!next || attempted.has(next)) break;
      attempted.add(next);
      let res;
      try {
        if (this._needsTable(next)) {
          const table = await this._ensureCraftingTable();
          if (!table.ok) {
            failed.push({ item: next, error: table.error ?? 'no_crafting_table' });
            break;
          }
        }
        res = await this._craftItem(next);
      } catch (error) {
        res = { ok: false, error: error?.message ?? 'craft_failed' };
      }
      if (res.ok) crafted.push({ item: next });
      else { failed.push({ item: next, error: res.error ?? 'craft_failed' }); break; }
    }
    const after = this._travelReadiness();
    return { ok: after.ready, before, after, crafted, failed };
  }

  _bestFoodItem ({ allowLastResort = this.food <= STARVING_FOOD } = {}) {
    return bestFood(this.inventory, { allowLastResort });
  }

  // Kit di viaggio: cosa manca per una spedizione multi-giorno (solo informativo:
  // la scelta resta al planner). `night` è soddisfatto da un letto O dalla lana
  // per craftarlo; `armor` è opzionale (spesso assente a inizio partita).
  _travelReadiness () {
    const inv = this.inventory;
    const total = (re) => Object.entries(inv).reduce((s, [n, c]) => s + (re.test(n) ? c : 0), 0);
    const items = {
      food: !!this._bestFoodItem({ allowLastResort: this.food <= STARVING_FOOD }),
      sword: total(/_sword$/) > 0,
      armor: Object.values(this.armor).some(Boolean),
      blocks: total(/(cobblestone|dirt|_planks$|_log$|^stone$)/) > 0,
      light: (inv.torch || 0) > 0 || ((inv.coal || 0) + (inv.charcoal || 0) >= 1 && (inv.stick || 0) >= 1),
      night: (inv.bed || 0) > 0 || total(/_wool$/) >= 3,
      craftingTable: (inv.crafting_table || 0) > 0,
      space: this.inventorySlots.filter(s => !s?.network_id).length > 4,
    };
    const missing = Object.entries(items).filter(([, ok]) => !ok).map(([k]) => k);
    return { ready: missing.length === 0, items, missing };
  }

  // Transazione item_use click_air (cibo/pozioni) nella forma attesa da
  // player_auth_input: lì il campo transaction è sempre un UseItem.
  _useItemTransaction (held, actionType) {
    return {
      legacy: { legacy_request_id: 0 },
      actions: [],
      data: {
        action_type: actionType,
        trigger_type: 'player_input',
        block_position: { x: 0, y: 0, z: 0 },
        face: 255,
        hotbar_slot: this.selectedHotbar,
        hand: 'main_hand',
        held_item: held,
        player_pos: { ...this.position },
        click_pos: { x: 0, y: 0, z: 0 },
        block_runtime_id: 0,
        client_prediction: 'success',
        client_cooldown_state: 'off',
      },
    };
  }

  async _eat (timeoutMs = 8000) {
    const itemName = this._bestFoodItem({ allowLastResort: this.food <= STARVING_FOOD });
    if (!itemName) return { ok: false, error: 'no_food' };
    if (this.food >= 20) return { ok: true, skipped: 'not_hungry' };
    const index = this.inventorySlots.findIndex(s => this._slotItemName(s) === itemName && s.count > 0);
    if (index < 0) return { ok: false, error: 'no_food' };
    if (this._openContainer) await this._closeContainer();
    let hotbar = index;
    if (hotbar > 8) {
      try { hotbar = await this._moveSlotToHotbar(index); } catch (error) { return { ok: false, error: `food_equip_failed: ${error.message}` }; }
    }
    if (!this._selectHotbarSlot(hotbar)) return { ok: false, error: 'food_equip_failed' };
    const beforeFood = this.food;
    const beforeCount = this.inventory[itemName] || 0;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const held = this.inventorySlots[this.selectedHotbar] || { network_id: 0 };
      await this._queueAuthInput({
        yaw: this._lastYaw,
        pitch: this._lastPitch,
        transaction: this._useItemTransaction(held, 'click_air'),
      });
      // Attende la conferma: fame salita o item consumato.
      const waitUntil = Math.min(deadline, Date.now() + 2200);
      while (Date.now() < waitUntil) {
        if (this.food > beforeFood || (this.inventory[itemName] || 0) < beforeCount) {
          return { ok: true, item: itemName, food: this.food, health: this.health };
        }
        await delay(100);
      }
    }
    return { ok: false, error: 'eat_not_confirmed', item: itemName };
  }

  // ---- fattoria ----------------------------------------------------------------------

  // Farmland libera (cella sopra vuota) entro `radius`, ordinata per distanza.
  _unplantedFarmland (radius = 24) {
    if (!this.position) return [];
    const farmland = this.world.findBlocks('farmland', this.position, radius, 16);
    const rows = [];
    for (const b of farmland) {
      const above = this.world.blockAt({ x: b.position.x, y: b.position.y + 1, z: b.position.z });
      if (above && above.name === 'air') {
        rows.push({ ...b, distance: +(b.distance ?? 0).toFixed(1) });
      }
    }
    return rows.sort((a, b) => a.distance - b.distance);
  }

  // Pianta un seme/ortaggio su una farmland libera e conferma dal mondo la
  // comparsa della coltura (cella sopra la farmland).
  async _plantSeed (itemName) {
    const crop = cropForSeed(itemName);
    if (!crop) return { ok: false, error: 'unknown_seed', item: itemName };
    if ((this.inventory[itemName] || 0) < 1) return { ok: false, error: 'missing_seed' };
    const target = this._unplantedFarmland()[0];
    if (!target) return { ok: false, error: 'no_free_farmland' };
    let slotIndex = this.inventorySlots.findIndex(s => this._slotItemName(s) === itemName && s.count > 0);
    if (slotIndex < 0) {
      try { await this._resyncByReconnect(); } catch (error) { this.log('inventory_resync_failed', { message: error.message }); }
      slotIndex = this.inventorySlots.findIndex(s => this._slotItemName(s) === itemName && s.count > 0);
      if (slotIndex < 0) return { ok: false, error: 'missing_seed' };
    }
    if (slotIndex > 8) {
      try { slotIndex = await this._moveSlotToHotbar(slotIndex); }
      catch (error) { return { ok: false, error: `seed_equip_failed: ${error.message}` }; }
    }
    this._selectHotbarSlot(slotIndex);
    const farmCenter = { x: target.position.x + 0.5, y: target.position.y + 1, z: target.position.z + 0.5 };
    if (this._pointDistance(farmCenter) > 4.5) {
      try { await this._moveTo(farmCenter, 2.0, 25000); } catch (error) { this.log('farmland_approach_failed', { message: error.message }); }
    }
    if (this._pointDistance(farmCenter) > 5.5) return { ok: false, error: 'farmland_unreachable' };
    const held = this.inventorySlots[this.selectedHotbar];
    const look = this._lookAt({ x: target.position.x + 0.5, y: target.position.y + 0.5, z: target.position.z + 0.5 });
    await this._queueAuthInput({ yaw: look.yaw, pitch: look.pitch });
    await delay(120);
    await this._queueAuthInput({
      yaw: look.yaw,
      pitch: look.pitch,
      transaction: {
        legacy: { legacy_request_id: 0 },
        actions: [],
        data: {
          action_type: 'click_block',
          trigger_type: 'player_input',
          block_position: target.position,
          face: 1,
          hotbar_slot: this.selectedHotbar,
          hand: 'main_hand',
          held_item: held,
          player_pos: { ...this.position },
          click_pos: { x: 0.5, y: 1, z: 0.5 },
          block_runtime_id: this.world.runtimeIdAt(target.position) >>> 0,
          client_prediction: 'success',
          client_cooldown_state: 'off',
        },
      },
    });
    const cropPos = { x: target.position.x, y: target.position.y + 1, z: target.position.z };
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const planted = this.world.blockAt(cropPos);
      if (planted && planted.name === crop) {
        this._refreshNearby();
        return { ok: true, item: itemName, crop, position: cropPos, confirmedBy: 'server_world' };
      }
      if (planted && planted.name !== 'air' && planted.name !== 'unknown') {
        return { ok: false, error: `unexpected_crop_${planted.name}`, position: cropPos };
      }
      await delay(100);
    }
    return { ok: false, error: 'plant_not_confirmed', item: itemName };
  }

  // Mietitura con ripianto: raccoglie una coltura matura e rimette il seme
  // ricavato (o già in inventario) sulla stessa farmland, così la fattoria
  // continua a produrre invece di esaurirsi. Il ripianto è best-effort: se
  // fallisce la mietitura resta valida e il motivo è nel risultato.
  async _harvestCrop (cropName) {
    const name = String(cropName).replace(/^minecraft:/, '');
    if (!isCropBlock(name)) return { ok: false, error: 'not_a_crop', crop: name };
    const seed = seedForCrop(name);
    const found = this.world.findBlocks(name, this.position, 96, 8);
    const { ready, immature } = this._harvestableCrops(found);
    const target = this._pickMineTarget(ready);
    if (!target) {
      return { ok: false, error: found.length ? 'crop_not_mature' : 'no_crop_found', crop: name, immature };
    }
    if (this._reachabilityUsable() && !this.mineDropReachable(target.position)) {
      return { ok: false, error: 'drop_unreachable', crop: name, position: target.position };
    }
    const harvest = await this._mineBlock(target);
    if (!harvest.ok) return { ...harvest, crop: name, immature };
    let replanted = null;
    if (seed && (this.inventory[seed] || 0) > 0) replanted = await this._plantSeed(seed);
    return { ok: true, crop: name, position: target.position, growth: harvest.crop?.growth ?? null,
      harvest, replanted, immature };
  }

  // Nutre l'animale da fattoria più vicino del tipo richiesto (wrapper di
  // _feedEntity). Conferma dallo stato `inlove` (riproduzione) o dal consumo.
  async _feedAnimal (type) {
    const wanted = normalizeEntityType(type);
    const feed = animalFeed(wanted);
    if (!feed) return { ok: false, error: 'no_feed_for_type', type: wanted };
    if ((this.inventory[feed] || 0) < 1) return { ok: false, error: 'missing_feed', feed };
    const animal = this._farmAnimalOfType(wanted);
    if (!animal) return { ok: false, error: 'no_animal_nearby', type: wanted };
    const result = await this._feedEntity(animal.runtimeId, feed);
    return result.ok ? { ...result, type: wanted } : result;
  }

  // Nutre un'entità specifica (per runtime id): equipaggia il cibo, si avvicina
  // e invia item_use_on_entity `interact`. Conferma dallo stato `inlove`/`tamed`
  // o dal consumo dell'item. Base comune di feed/breed/tame.
  // Porta un item nella hotbar e lo seleziona (con un resync una volta sola se
  // lo slot non si trova): è il preambolo comune di ogni interazione "con la
  // cosa in mano" — nutrire, addomesticare, barattare. Chiudere un container
  // aperto fa parte del preambolo: con l'inventario aperto il pacchetto di
  // interazione non parte.
  async _equipItemInHotbar (name, { resync = true } = {}) {
    let slotIndex = this.inventorySlots.findIndex(s => this._slotItemName(s) === name && s.count > 0);
    if (slotIndex < 0 && resync) {
      try { await this._resyncByReconnect(); } catch (error) { this.log('inventory_resync_failed', { message: error.message }); }
      slotIndex = this.inventorySlots.findIndex(s => this._slotItemName(s) === name && s.count > 0);
    }
    if (slotIndex < 0) return { ok: false, error: 'missing_item', item: name };
    if (slotIndex > 8) {
      try { slotIndex = await this._moveSlotToHotbar(slotIndex); }
      catch (error) { return { ok: false, error: `equip_failed: ${error.message}`, item: name }; }
    }
    this._selectHotbarSlot(slotIndex);
    if (this._openContainer) await this._closeContainer();
    return { ok: true, slot: slotIndex };
  }

  async _feedEntity (runtimeId, feed, timeoutMs = 8000) {
    if ((this.inventory[feed] || 0) < 1) return { ok: false, error: 'missing_feed', feed };
    const equipped = await this._equipItemInHotbar(feed);
    if (!equipped.ok) {
      if (equipped.error === 'missing_item') return { ok: false, error: 'missing_feed', feed };
      return { ok: false, error: `feed_equip_failed: ${equipped.error.replace(/^equip_failed: /, '')}` };
    }
    const entity = this.entities.get(String(runtimeId));
    if (!entity) return { ok: false, error: 'animal_gone' };
    if (this._entityDistance(entity) > 4.5) {
      try { await this._moveTo(entity.position, 2.0, 25000); } catch (error) { this.log('animal_approach_failed', { message: error.message }); }
    }
    const beforeCount = this.inventory[feed] || 0;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const live = this.entities.get(String(runtimeId));
      if (!live) return { ok: false, error: 'animal_gone' };
      if (this._entityDistance(live) > 5) return { ok: false, error: 'animal_unreachable' };
      const look = this._lookAt({ x: live.position.x, y: live.position.y + entityHeight(live.type) * 0.5, z: live.position.z });
      await this._queueAuthInput({ yaw: look.yaw, pitch: look.pitch });
      await delay(120);
      this._interactEntity(live);
      const waitUntil = Math.min(deadline, Date.now() + 2500);
      while (Date.now() < waitUntil) {
        const watched = this.entities.get(String(runtimeId));
        if (watched?.tamed) return { ok: true, fed: feed, type: watched.type, state: 'tamed' };
        if (watched?.inlove) return { ok: true, fed: feed, type: watched.type, state: 'inlove' };
        if ((this.inventory[feed] || 0) < beforeCount) return { ok: true, fed: feed, type: watched?.type, state: 'consumed' };
        await delay(100);
      }
    }
    return { ok: false, error: 'feed_not_confirmed', feed };
  }

  // Riproduce due adulti dello stesso tipo: li nutre entrambi e attende un
  // cucciolo (nuova entità con flag `baby`). Cooldown di coppia gestito a monte
  // (due adulti non-inlove disponibili).
  async _breedAnimals (type) {
    const wanted = normalizeEntityType(type);
    const feed = animalFeed(wanted);
    if (!feed) return { ok: false, error: 'no_feed_for_type', type: wanted };
    if ((this.inventory[feed] || 0) < 2) return { ok: false, error: 'need_2_feed', feed };
    const adults = this._nearbyFarmAnimals(64).filter(e => e.type === wanted && !e.baby && !e.inlove);
    if (adults.length < 2) return { ok: false, error: 'need_2_adults', type: wanted, adults: adults.length };
    const babiesBefore = this._nearbyFarmAnimals(64).filter(e => e.type === wanted && e.baby).length;
    const fedA = await this._feedEntity(adults[0].runtimeId, feed);
    if (!fedA.ok) return fedA;
    const fedB = await this._feedEntity(adults[1].runtimeId, feed);
    if (!fedB.ok) return fedB;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const babiesNow = this._nearbyFarmAnimals(64).filter(e => e.type === wanted && e.baby).length;
      if (babiesNow > babiesBefore) return { ok: true, bred: wanted, babies: babiesNow - babiesBefore, feed };
      await delay(250);
    }
    return { ok: false, error: 'baby_not_observed', type: wanted };
  }

  // Addomestica un compagno. Due strade:
  // - cibo (wolf/cat/ocelot/parrot): ripete item_use_on_entity `interact` col
  //   cibo giusto finché `tamed`/`trusting`/`owner_eid` non compare;
  // - cavalcabile (horse/donkey/mule/llama/nautilus): monta ripetutamente finché
  //   smette di disarcionare (flag `tamed`).
  async _tameAnimal (type, timeoutMs = 30000) {
    const wanted = normalizeEntityType(type);
    const feeds = tameFeed(wanted);
    const ride = isRideTameableType(wanted);
    if (!feeds.length && !ride) return { ok: false, error: 'no_tame_feed', type: wanted };
    if (feeds.length) {
      const available = feeds.find(f => (this.inventory[f] || 0) > 0);
      if (!available) return { ok: false, error: 'missing_feed', feed: feeds.join('/') };
    }
    const selfId = String(this.client?.entityId ?? '');
    const animal = this._nearbyCompanion(64).find(e => e.type === wanted && !this._isCompanionTamed(e, selfId));
    if (!animal) return { ok: false, error: 'no_tameable_nearby', type: wanted };
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;
    while (Date.now() < deadline) {
      const live = this.entities.get(String(animal.runtimeId));
      if (!live) return { ok: false, error: 'animal_gone' };
      if (this._isCompanionTamed(live, selfId)) return { ok: true, tamed: wanted, attempts };
      if (ride) {
        await this._mountEntity(live, deadline);
      } else {
        const feed = feeds.find(f => (this.inventory[f] || 0) > 0) || feeds[0];
        const fed = await this._feedEntity(live.runtimeId, feed, Math.min(8000, deadline - Date.now()));
        if (!fed.ok) return fed;
      }
      attempts++;
      const waitUntil = Math.min(deadline, Date.now() + 1500);
      while (Date.now() < waitUntil) {
        const watched = this.entities.get(String(animal.runtimeId));
        if (this._isCompanionTamed(watched, selfId)) return { ok: true, tamed: wanted, attempts };
        await delay(100);
      }
    }
    return { ok: false, error: 'tame_not_confirmed', type: wanted, attempts };
  }

  // True se il compagno è già domato/fiducioso o appartiene al bot.
  _isCompanionTamed (entity, selfId) {
    if (!entity) return false;
    if (entity.tamed) return true;
    if (entity.trusting) return true;
    if (entity.ownerEid && selfId && entity.ownerEid === selfId) return true;
    return false;
  }

  // Monta un cavalcabile (horse/donkey/mule/llama/nautilus): mano vuota per non
  // dargli cibo, poi item_use_on_entity `interact`. Il server disarciona finché
  // non è domato: si ripete finché il flag `tamed` non compare.
  async _mountEntity (entity, deadline) {
    // Mano vuota e niente sneak: con del cibo in mano il click darebbe cibo e con
    // lo sneak attivo il server aprirebbe l'inventario del cavalcabile.
    const hand = this._freeHands('mount');
    const live = this.entities.get(String(entity.runtimeId));
    if (!live) return;
    if (this._entityDistance(live) > 4.5) {
      try { await this._moveTo(live.position, 2.0, Math.min(20000, deadline - Date.now())); } catch (error) { this.log('mount_approach_failed', { message: error.message }); }
    }
    const current = this.entities.get(String(entity.runtimeId));
    if (!current) return;
    if (this._entityDistance(current) > 5) return;
    // Un bersaglio dietro un muro non si monta: meglio un rifiuto tipizzato che
    // sei `interact` a vuoto (evidenza live 04/10/2026: `mount_donkey` ha
    // martellato sei volte su un donkey 4,6 blocchi sotto, non in vista).
    const mountVisibility = this._entityVisible(current);
    if (!mountVisibility.visible) {
      this.log('mount_target_blocked', { target: current.type, distance: +this._entityDistance(current).toFixed(2), blockedBy: mountVisibility.blockedBy, at: mountVisibility.blockedAt });
      return;
    }
    const look = this._lookAt({ x: current.position.x, y: current.position.y + entityHeight(current.type) * 0.5, z: current.position.z });
    await this._queueAuthInput({ yaw: look.yaw, pitch: look.pitch });
    await delay(120);
    this._interactEntity(current);
    this.log('mount_interact', { target: current.type, hand, distance: +this._entityDistance(current).toFixed(2) });
  }

  // ---- cavalcare/veicoli -------------------------------------------------------------

  // Veicoli e cavalcabili vicini (entità montabili), con distanza e tipo.
  _nearbyRideable (limit = 12) {
    const rows = [];
    for (const entity of this.entities.values()) {
      if (entity.kind !== 'mob' || !entity.position || !isRideableType(entity.type)) continue;
      if (entity.health != null && entity.health <= 0 && entity.deadAt) continue;
      const distance = this._entityDistance(entity);
      if (distance > 32) continue;
      rows.push({
        type: entity.type,
        runtimeId: entity.runtimeId,
        position: entity.position,
        distance: +distance.toFixed(1),
      });
    }
    rows.sort((a, b) => a.distance - b.distance);
    return rows.slice(0, limit);
  }

  // Chi è a bordo di un mezzo (runtime id). I link del server sono la verità; il
  // flag `riding` di un'entità non dice *quale* mezzo, quindi da solo non basta a
  // contare i posti occupati.
  _ridersOf (runtimeId) {
    const id = String(runtimeId ?? '');
    if (!id) return [];
    const riders = [];
    for (const [rider, link] of this.entityLinks) {
      if (String(link.ridden) === id && !riders.includes(rider)) riders.push(rider);
    }
    return riders;
  }

  // Il mezzo su cui sta l'umano da seguire. Fonte autorevole: il link del server
  // (rider=umano → ridden=mezzo). Prima del link si ripiega sul flag `riding`
  // dell'umano più la prossimità, dichiarando la sorgente `proximity` perché non
  // è una prova: accanto alla sua barca può essercene un'altra.
  _humanMountView () {
    const name = this.plan?.follow;
    if (!name) return null;
    const human = this._playerByName(name);
    if (!human?.position) return null;
    const linked = this.entityLinks.get(String(human.runtimeId));
    let mount = linked ? this.entities.get(String(linked.ridden)) : null;
    let source = mount ? 'link' : null;
    if (!mount && human.riding === true) {
      // Candidati: i mezzi che possono *portare anche il bot*, non tutti i
      // cavalcabili. Un cavallo è a un posto e quindi non è un candidato a
      // prescindere: qui la capacità decide, non la classificazione del censimento.
      let best = null;
      for (const entity of this.entities.values()) {
        if (entity === human || entity.kind !== 'mob' || !entity.position) continue;
        if (mountCapacity(entity) < 2) continue;
        const d = Math.hypot(entity.position.x - human.position.x, entity.position.z - human.position.z);
        if (d > 6) continue;
        if (!best || d < best.d) best = { entity, d };
      }
      if (best) { mount = best.entity; source = 'proximity'; }
    }
    if (!mount?.position) return null;
    const info = seatInfo(mount, { riders: this._ridersOf(mount.runtimeId).length });
    return {
      human: human.username || name,
      runtimeId: String(mount.runtimeId),
      type: info.type,
      source,
      seats: info.seats,
      riders: info.riders,
      free: info.free,
      joinable: info.joinable,
      reason: info.reason,
      position: { ...mount.position },
      distance: +this._entityDistance(mount).toFixed(1),
    };
  }

  // Vista della missione «l'umano si è imbarcato». Qui si raccolgono i fatti
  // (link, flag, raggiungibilità) e si conservano tentativi ed esito dell'ultimo
  // join: la decisione è della macchina a stati pura (`bedrock-mount-follow.mjs`).
  // I tentativi sopravvivono all'osservazione perché senza di quelli il bot
  // riproverebbe in loop un interact che il server ha già rifiutato.
  _mountFollowView () {
    const following = !!this.plan?.follow;
    const mount = following ? this._humanMountView() : null;
    const botRiding = !!this.riding;
    // Mezzo diverso (o umano tornato a piedi): la missione riparte da zero. I
    // tentativi appartengono a *quel* mezzo, non alla persona.
    if (mount?.runtimeId !== this._mountFollow.mountKey) {
      this._mountFollow.mountKey = mount?.runtimeId ?? null;
      this._mountFollow.attempts = 0;
      this._mountFollow.lastError = null;
    }
    let reachable = false;
    if (mount) {
      const entity = this.entities.get(mount.runtimeId);
      reachable = !!entity && this.entityApproachable(entity, { range: 4, dy: 3 });
    }
    const next = mountFollowTransition({
      state: this._mountFollow.state,
      following,
      botRiding,
      ridingHumanMount: botRiding && !!mount && String(this.riding?.riddenEntityId ?? '') === mount.runtimeId,
      mount,
      reachable,
      joinEnabled: this.joinHumanMountEnabled,
      joinAttempted: this._mountFollow.attempts > 0 && !!this._mountFollow.lastError,
      joinError: this._mountFollow.lastError,
      attempts: this._mountFollow.attempts,
    });
    if (next.state !== this._mountFollow.state) {
      this.log('mount_follow_state', {
        from: this._mountFollow.state,
        to: next.state,
        action: next.action,
        reason: next.reason,
        human: mount?.human ?? this.plan?.follow ?? null,
        mount: mount
          ? { type: mount.type, runtimeId: mount.runtimeId, seats: mount.seats, riders: mount.riders, free: mount.free, source: mount.source, distance: mount.distance }
          : null,
        flags: { joinEnabled: this.joinHumanMountEnabled, reachable, attempts: this._mountFollow.attempts },
      });
    }
    this._mountFollow.state = next.state;
    this._mountFollow.action = next.action;
    this._mountFollow.reason = next.reason;
    return {
      ...next,
      human: mount?.human ?? this.plan?.follow ?? null,
      attempts: this._mountFollow.attempts,
      attemptLimit: MOUNT_JOIN_ATTEMPTS,
      joinEnabled: this.joinHumanMountEnabled,
      mount,
    };
  }

  // Sale sul mezzo *dell'umano*: bersaglio il suo runtime id, non "il più vicino
  // del tipo" (accanto alla sua barca può essercene un'altra). Dietro feature
  // flag: senza `BEDROCK_JOIN_HUMAN_MOUNT=1` non parte un solo pacchetto e il
  // rifiuto è tipizzato (`join_human_mount_disabled`).
  async _joinHumanMount (mountOrId = null, timeoutMs = 20000) {
    if (!this.joinHumanMountEnabled) return { ok: false, error: 'join_human_mount_disabled' };
    if (this.riding) return { ok: false, error: 'already_riding', ridden: this.riding.riddenEntityId };
    const mount = mountOrId && typeof mountOrId === 'object' ? mountOrId : this._humanMountView();
    if (!mount) return { ok: false, error: 'human_mount_unknown' };
    // Il tentativo appartiene a *questo* mezzo: senza fissarlo qui, la vista
    // successiva lo leggerebbe come un mezzo nuovo e azzererebbe l'errore,
    // rimettendo il bot a riprovare in loop ciò che il server ha già rifiutato.
    this._mountFollow.mountKey = mount.runtimeId;
    if (mount.seats < 2 || mount.reason === 'unsupported') {
      return { ok: false, error: 'human_mount_unsupported', type: mount.type, seats: mount.seats };
    }
    if (mount.free <= 0) {
      return { ok: false, error: 'human_mount_full', type: mount.type, seats: mount.seats, riders: mount.riders };
    }
    const hand = this._freeHands('mount');
    const entity = this.entities.get(mount.runtimeId);
    if (!entity) return { ok: false, error: 'human_mount_gone' };
    if (this._entityDistance(entity) > 4.5) {
      try { await this._moveTo(entity.position, 2.0, Math.min(15000, timeoutMs)); } catch (error) { this.log('join_human_mount_approach_failed', { message: error.message, mount: mount.type }); }
    }
    this._mountFollow.attempts += 1;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !this.riding) {
      const live = this.entities.get(mount.runtimeId);
      if (!live) { this._mountFollow.lastError = 'human_mount_gone'; return { ok: false, error: 'human_mount_gone' }; }
      const distance = this._entityDistance(live);
      if (distance > 5) {
        this._mountFollow.lastError = 'human_mount_unreachable';
        return { ok: false, error: 'human_mount_unreachable', type: mount.type, distance: +distance.toFixed(1) };
      }
      const look = this._lookAt({ x: live.position.x, y: live.position.y + entityHeight(live.type) * 0.5, z: live.position.z });
      await this._queueAuthInput({ yaw: look.yaw, pitch: look.pitch });
      await delay(120);
      this._interactEntity(live);
      const waitUntil = Math.min(deadline, Date.now() + 2000);
      while (Date.now() < waitUntil && !this.riding) await delay(100);
    }
    if (!this.riding) {
      this._mountFollow.lastError = 'mount_not_confirmed';
      this.log('join_human_mount_unconfirmed', { mount: mount.type, runtimeId: mount.runtimeId, attempts: this._mountFollow.attempts, hand, source: mount.source });
      return { ok: false, error: 'mount_not_confirmed', type: mount.type, hand, attempts: this._mountFollow.attempts };
    }
    this._mountFollow.lastError = null;
    this.log('join_human_mount', { mount: mount.type, runtimeId: mount.runtimeId, attempts: this._mountFollow.attempts, source: mount.source });
    return { ok: true, mounted: mount.type, ridden: this.riding.riddenEntityId, source: mount.source };
  }

  // Monta il veicolo/cavalcabile più vicino del tipo richiesto: mano vuota e
  // item_use_on_entity `interact`; conferma dal link rider→veicolo (set_entity_link).
  async _mountVehicle (type, timeoutMs = 20000) {
    if (this.riding) return { ok: false, error: 'already_riding', ridden: this.riding.riddenEntityId };
    const wanted = normalizeEntityType(type);
    const target = this._nearbyRideable(64).find(e => e.type === wanted);
    if (!target) return { ok: false, error: 'no_rideable_nearby', type: wanted };
    const hand = this._freeHands('mount');
    const entity = this.entities.get(String(target.runtimeId));
    if (!entity) return { ok: false, error: 'vehicle_gone' };
    if (this._entityDistance(entity) > 4.5) {
      try { await this._moveTo(entity.position, 2.0, Math.min(15000, timeoutMs)); } catch (error) { this.log('mount_approach_failed', { message: error.message }); }
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !this.riding) {
      const live = this.entities.get(String(target.runtimeId));
      if (!live) return { ok: false, error: 'vehicle_gone' };
      if (this._entityDistance(live) > 5) return { ok: false, error: 'vehicle_unreachable' };
      const look = this._lookAt({ x: live.position.x, y: live.position.y + entityHeight(live.type) * 0.5, z: live.position.z });
      await this._queueAuthInput({ yaw: look.yaw, pitch: look.pitch });
      await delay(120);
      this._interactEntity(live);
      const waitUntil = Math.min(deadline, Date.now() + 2000);
      while (Date.now() < waitUntil && !this.riding) await delay(100);
    }
    if (!this.riding) return { ok: false, error: 'mount_not_confirmed', type: wanted, hand };
    return { ok: true, mounted: wanted, ridden: this.riding.riddenEntityId };
  }

  // Smonta: player_action start_sneak; il server risponde col link di rimozione.
  async _dismount (timeoutMs = 8000) {
    if (!this.riding) return { ok: true, alreadyDismounted: true };
    this._ridingForward = false;
    const deadline = Date.now() + timeoutMs;
    this._sendPlayerAction('start_sneak');
    this._sneaking = true;
    while (Date.now() < deadline && this.riding) await delay(100);
    if (this.riding) return { ok: false, error: 'dismount_not_confirmed' };
    // Lo sneak dello smontaggio è un comando, non uno stato da lasciare addosso:
    // con sneak attivo il prossimo `interact` su un cavalcabile aprirebbe il suo
    // inventario invece di montarlo (evidenza live 04/10/2026).
    this._sendPlayerAction('stop_sneak');
    this._sneaking = false;
    return { ok: true, dismounted: true };
  }

  // Cavalca verso un punto: invia vettore avanti continuo + flag veicolo; il
  // server muove il mezzo e corregge la posizione (correct_player_move_prediction
  // con prediction_type `vehicle`). Nessun pathfinding né fisica locale.
  async _rideToward (target, stopDistance = 3, timeoutMs = 30000) {
    if (!this.riding) return { ok: false, error: 'not_riding' };
    const deadline = Date.now() + timeoutMs;
    this._ridingForward = true;
    try {
      while (Date.now() < deadline) {
        if (!this.riding) return { ok: false, error: 'dismounted' };
        const d = Math.hypot(target.x - this.position.x, target.z - this.position.z);
        if (d <= stopDistance) return { ok: true, distance: +d.toFixed(2) };
        this._ridingYaw = this._yawTo(this.position, target);
        await delay(100);
      }
      return { ok: false, error: 'ride_timeout' };
    } finally {
      this._ridingForward = false;
    }
  }

  // Lancia un uovo (use_item click_air): 1/8 di probabilità di un pulcino.
  // Conferma dal consumo dell'uovo; il pulcino è rilevato tra le entità.
  async _throwEgg (timeoutMs = 8000) {
    const itemName = 'egg';
    if ((this.inventory[itemName] || 0) < 1) return { ok: false, error: 'missing_egg' };
    let slotIndex = this.inventorySlots.findIndex(s => this._slotItemName(s) === itemName && s.count > 0);
    if (slotIndex < 0) {
      try { await this._resyncByReconnect(); } catch (error) { this.log('inventory_resync_failed', { message: error.message }); }
      slotIndex = this.inventorySlots.findIndex(s => this._slotItemName(s) === itemName && s.count > 0);
      if (slotIndex < 0) return { ok: false, error: 'missing_egg' };
    }
    if (slotIndex > 8) {
      try { slotIndex = await this._moveSlotToHotbar(slotIndex); }
      catch (error) { return { ok: false, error: `egg_equip_failed: ${error.message}` }; }
    }
    this._selectHotbarSlot(slotIndex);
    const beforeCount = this.inventory[itemName] || 0;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const held = this.inventorySlots[this.selectedHotbar] || { network_id: 0 };
      await this._queueAuthInput({ yaw: this._lastYaw, pitch: this._lastPitch, transaction: this._useItemTransaction(held, 'click_air') });
      const waitUntil = Math.min(deadline, Date.now() + 2200);
      while (Date.now() < waitUntil) {
        if ((this.inventory[itemName] || 0) < beforeCount) {
          await delay(500);
          const chicks = this._nearbyFarmAnimals(64).filter(e => e.type === 'chicken' && e.baby).length;
          return { ok: true, thrown: itemName, chick: chicks > 0 ? 'observed' : 'none' };
        }
        await delay(100);
      }
    }
    return { ok: false, error: 'throw_not_confirmed', item: itemName };
  }

  // Tosa una pecora adulta non ancora tosata: equipaggia le cesoie e invia
  // item_use_on_entity `interact`; conferma dal flag `sheared`.
  async _shearSheep (timeoutMs = 20000) {
    if ((this.inventory.shears || 0) < 1) return { ok: false, error: 'missing_shears' };
    const sheep = this._nearbyFarmAnimals(64).find(e => e.type === 'sheep' && !e.sheared && !e.baby);
    if (!sheep) return { ok: false, error: 'no_shearable_sheep' };
    let slotIndex = this.inventorySlots.findIndex(s => this._slotItemName(s) === 'shears' && s.count > 0);
    if (slotIndex < 0) {
      try { await this._resyncByReconnect(); } catch (error) { this.log('inventory_resync_failed', { message: error.message }); }
      slotIndex = this.inventorySlots.findIndex(s => this._slotItemName(s) === 'shears' && s.count > 0);
      if (slotIndex < 0) return { ok: false, error: 'missing_shears' };
    }
    if (slotIndex > 8) {
      try { slotIndex = await this._moveSlotToHotbar(slotIndex); }
      catch (error) { return { ok: false, error: `shears_equip_failed: ${error.message}` }; }
    }
    this._selectHotbarSlot(slotIndex);
    if (this._openContainer) await this._closeContainer();
    const entity = this.entities.get(String(sheep.runtimeId));
    if (!entity) return { ok: false, error: 'sheep_gone' };
    if (this._entityDistance(entity) > 4.5) {
      try { await this._moveTo(entity.position, 2.0, 25000); } catch (error) { this.log('sheep_approach_failed', { message: error.message }); }
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const live = this.entities.get(String(sheep.runtimeId));
      if (!live) return { ok: false, error: 'sheep_gone' };
      if (this._entityDistance(live) > 5) return { ok: false, error: 'sheep_unreachable' };
      const look = this._lookAt({ x: live.position.x, y: live.position.y + entityHeight(live.type) * 0.5, z: live.position.z });
      await this._queueAuthInput({ yaw: look.yaw, pitch: look.pitch });
      await delay(120);
      this._interactEntity(live);
      const waitUntil = Math.min(deadline, Date.now() + 2500);
      while (Date.now() < waitUntil) {
        const watched = this.entities.get(String(sheep.runtimeId));
        if (watched?.sheared) return { ok: true, sheared: true, type: 'sheep' };
        await delay(100);
      }
    }
    return { ok: false, error: 'shear_not_confirmed' };
  }

  // Munge una mucca/mooshroom: equipaggia il secchio vuoto e ripete
  // item_use_on_entity `interact`, come feed/shear. Il server non manda un
  // evento dedicato per il latte: la conferma è il delta d'inventario
  // (`bucket` -1, `milk_bucket` +1).
  async _milkAnimal (type, timeoutMs = 15000) {
    const wanted = normalizeEntityType(type);
    if (!isMilkableType(wanted)) return { ok: false, error: 'not_milkable', type: wanted };
    if ((this.inventory.bucket || 0) < 1) return { ok: false, error: 'missing_bucket' };
    const animal = this._nearbyFarmAnimals(64).find(e => e.type === wanted);
    if (!animal) return { ok: false, error: 'no_milkable_nearby', type: wanted };
    let slotIndex = this.inventorySlots.findIndex(s => this._slotItemName(s) === 'bucket' && s.count > 0);
    if (slotIndex < 0) {
      try { await this._resyncByReconnect(); } catch (error) { this.log('inventory_resync_failed', { message: error.message }); }
      slotIndex = this.inventorySlots.findIndex(s => this._slotItemName(s) === 'bucket' && s.count > 0);
      if (slotIndex < 0) return { ok: false, error: 'missing_bucket' };
    }
    if (slotIndex > 8) {
      try { slotIndex = await this._moveSlotToHotbar(slotIndex); }
      catch (error) { return { ok: false, error: `bucket_equip_failed: ${error.message}` }; }
    }
    this._selectHotbarSlot(slotIndex);
    if (this._openContainer) await this._closeContainer();
    const entity = this.entities.get(String(animal.runtimeId));
    if (!entity) return { ok: false, error: 'animal_gone' };
    if (this._entityDistance(entity) > 4.5) {
      try { await this._moveTo(entity.position, 2.0, 25000); } catch (error) { this.log('animal_approach_failed', { message: error.message }); }
    }
    const bucketsBefore = this.inventory.bucket || 0;
    const milkBefore = this.inventory.milk_bucket || 0;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const live = this.entities.get(String(animal.runtimeId));
      if (!live) return { ok: false, error: 'animal_gone' };
      if (this._entityDistance(live) > 5) return { ok: false, error: 'animal_unreachable' };
      const look = this._lookAt({ x: live.position.x, y: live.position.y + entityHeight(live.type) * 0.5, z: live.position.z });
      await this._queueAuthInput({ yaw: look.yaw, pitch: look.pitch });
      await delay(120);
      this._interactEntity(live);
      const waitUntil = Math.min(deadline, Date.now() + 2500);
      while (Date.now() < waitUntil) {
        const milkNow = this.inventory.milk_bucket || 0;
        if (milkNow > milkBefore) {
          return { ok: true, milked: live.type, milk: milkNow - milkBefore, bucketLeft: this.inventory.bucket || 0, confirmedBy: 'milk_bucket' };
        }
        if ((this.inventory.bucket || 0) < bucketsBefore) {
          // Il server ha consumato il secchio ma l'item di ritorno non è ancora
          // nella cache: vale come conferma (l'inventario si riallinea da sé).
          return { ok: true, milked: live.type, milk: 1, bucketLeft: this.inventory.bucket || 0, confirmedBy: 'bucket_consumed' };
        }
        await delay(100);
      }
    }
    return { ok: false, error: 'milk_not_confirmed', type: wanted };
  }

  // ---- scudo -------------------------------------------------------------------------

  // Cosa c'è nella mano secondaria. Lo stato è locale finché il server non
  // rimanda un `mob_equipment` per l'offhand (che lo riallinea).
  _offhandItem () {
    return this.offhand?.name || null;
  }

  // Indossa lo scudo nell'offhand: `take` sul cursor + `place` su 'offhand'
  // (container_id 34), la stessa forma di _equipArmor. Lo slot dell'offhand è
  // **1** (vedi OFFHAND_SLOT): con `0` il server risponde 50, cioè
  // `FailedToValidateDstSlot`. Se lo slot 1 viene rifiutato si fa un solo
  // ripiego sullo slot 0 e poi si riporta l'errore tipizzato con entrambi gli
  // esiti, senza scavare oltre. Il server rimanda un
  // `mob_equipment` per la mano secondaria: se arriva, la conferma è
  // autorevole (`confirmedBy: mob_equipment`); altrimenti vale la risposta
  // degli stack request (`confirmedBy: stack_response`), e il `take`/`place`
  // non ok è un errore tipizzato — mai un successo dichiarato.
  async _equipShield (timeoutMs = 1500) {
    if (this._offhandItem() === 'shield') return { ok: true, equipped: 'shield', already: true };
    if ((this.inventory.shield || 0) < 1) return { ok: false, error: 'missing_shield' };
    let index = this.inventorySlots.findIndex(s => this._slotItemName(s) === 'shield' && s.count > 0);
    if (index < 0) {
      try { await this._resyncByReconnect(); } catch (error) { this.log('inventory_resync_failed', { message: error.message }); }
      index = this.inventorySlots.findIndex(s => this._slotItemName(s) === 'shield' && s.count > 0);
      if (index < 0) return { ok: false, error: 'missing_shield' };
    }
    if (this._openContainer) await this._closeContainer();
    this._offhandConfirmedAt = 0;
    let cursorStack = 0;
    try {
      cursorStack = await this._takeToCursor(index, 1);
    } catch (error) {
      const reason = String(error.message);
      if (reason === 'missing_ingredients') return { ok: false, error: 'missing_shield' };
      return { ok: false, error: `shield_take_failed_${reason.replace(/^take_failed_/, '')}` };
    }
    const openAtPlace = this._openContainer ? { id: this._openContainer.id, type: this._openContainer.type } : null;
    const attempts = [];
    let place = null;
    // Tre passi, in quest'ordine: `place` sullo slot 1 (OFFHAND_SLOT, la forma
    // che il server accetta con l'offhand vuoto), un solo ripiego `place` sullo
    // slot 0, e — se **anche** quello e' rifiutato con 50
    // (`FailedToValidateDstSlot`: lo slot di destinazione non e' vuoto, cioe'
    // nell'offhand c'e' gia' un item diverso) — lo `swap` fra cursore e offhand,
    // che e' l'azione che BDS si aspetta quando il cursore e la destinazione
    // sono entrambi occupati (vedi `_swapSlots`). Live 09-10/10/2026 lo scudo
    // restava in zaino dopo 8 `shield_place_failed` 50 su entrambi gli slot.
    const dstStackId = this.offhand?.stack_id ?? 0;
    const steps = [
      { mode: 'place', slot: OFFHAND_SLOT },
      { mode: 'place', slot: OFFHAND_FALLBACK_SLOT },
      { mode: 'swap', slot: OFFHAND_SLOT },
    ];
    const sendStep = async ({ mode, slot }) => this._sendStackRequest([mode === 'swap'
      ? {
        type_id: 'swap', legacy_type_id: 2,
        source: this._slotInfo('cursor', 0, cursorStack),
        destination: this._slotInfo('offhand', slot, dstStackId),
      }
      : {
        type_id: 'place', legacy_type_id: 1, count: 1,
        source: this._slotInfo('cursor', 0, cursorStack),
        destination: this._slotInfo('offhand', slot, 0),
      }]).catch(() => null);
    let refreshed = false;
    for (const step of steps) {
      const { mode, slot } = step;
      place = await sendStep(step);
      const status = place?.status ?? 'timeout';
      attempts.push({ mode, slot, status });
      if (place && (String(status) === 'ok' || status === 0)) break;
      // Live 09/10/2026: con la finestra d'inventario **stantia** che il server
      // teneva da prima (windowId 2) ogni `place` verso l'offhand rispondeva
      // 50/55 e lo scudo restava in zaino; con una finestra fresca (windowId 3)
      // lo stesso `place` passava al primo colpo. Il rimedio e' chiudere la
      // finestra, riaprirla e ritentare **una volta sola** la forma appena
      // rifiutata: un rifiuto per forma non si trasforma in un ciclo.
      if (!refreshed && (Number(status) === 50 || Number(status) === 55)) {
        refreshed = true;
        const stale = this._openContainer ? this._openContainer.id : null;
        await this._closeContainer().catch(() => {});
        try { await this._ensureInventoryOpen(); } catch (error) { this.log('shield_window_refresh_failed', { message: error.message }); }
        this.log('shield_window_refresh', { stale, fresh: this._openContainer ? this._openContainer.id : null, mode, slot, status });
        const retry = await sendStep(step);
        const retryStatus = retry?.status ?? 'timeout';
        attempts.push({ mode, slot, status: retryStatus, retry: true });
        if (retry && (String(retryStatus) === 'ok' || retryStatus === 0)) { place = retry; break; }
      }
      // Un place rifiutato non cambia nulla lato server: il cursore è ancora
      // carico con la stessa stack id, quindi il passo successivo la riusa (un
      // solo ripiego per forma, non un ciclo).
      this.log('shield_place_failed', {
        status,
        mode,
        destination: `offhand/${slot}`,
        cursor_stack_id: this._cursor?.stack_id ?? null,
        cursorStack,
        offhand: this.offhand?.name ?? null,
        openContainer: openAtPlace,
      });
    }
    if (!place || (String(place.status) !== 'ok' && place.status !== 0)) {
      await this._returnCursorToInventory().catch(() => {});
      const last = attempts[attempts.length - 1] ?? { status: 'timeout' };
      return { ok: false, error: `shield_place_failed_${last.status}`, attempts, openContainer: openAtPlace };
    }
    const viaSwap = attempts[attempts.length - 1]?.mode === 'swap';
    this._applyStackResponse(place);
    if (viaSwap) {
      // Lo `swap` e' simmetrico: l'item che stava nell'offhand e' finito sul
      // cursore e va rimesso in inventario, altrimenti il cursore resta sporco
      // (e un cursore sporco fa fallire i `take` successivi con status 50).
      await this._returnCursorToInventory().catch(() => {});
    }
    this._cursor = null;
    this.offhand = { name: 'shield', count: 1, network_id: null, stack_id: this.offhand?.stack_id ?? null };
    this._refreshInventory();
    const confirmed = await this._waitOffhandConfirm(timeoutMs);
    this.log('shield_equip', { status: place.status, confirmedBy: confirmed ? 'mob_equipment' : 'stack_response' });
    return { ok: true, equipped: 'shield', confirmedBy: confirmed ? 'mob_equipment' : 'stack_response' };
  }

  async _waitOffhandConfirm (timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.offhand?.name === 'shield' && this._offhandConfirmedAt) return true;
      await delay(100);
    }
    return false;
  }

  // Alza lo scudo: il frame auth dichiara l'uso dell'item con il binario
  // `start_using_item`. Il server non manda un ack dedicato, quindi la
  // conferma osservabile è il pacchetto inviato (log `shield_up`) più, in
  // combattimento, il danno ridotto; qui non si inventa un flag di stato.
  async _raiseShield () {
    if (this._offhandItem() !== 'shield') return { ok: false, error: 'shield_not_equipped' };
    if (this.shieldUp) return { ok: true, raised: true, already: true };
    const threat = this._hostiles().find(e => this._entityDistance(e) <= SHIELD_THREAT_RANGE);
    let yaw = this.yaw ?? 0;
    let pitch = this.pitch ?? 0;
    if (threat?.position) {
      const look = this._lookAt({ x: threat.position.x, y: threat.position.y + entityHeight(threat.type) * 0.5, z: threat.position.z });
      yaw = look.yaw;
      pitch = look.pitch;
    }
    await this._queueAuthInput({ yaw, pitch, useItem: true });
    this.shieldUp = true;
    this.log('shield_up', { item: 'shield', target: threat?.type ?? null });
    return { ok: true, raised: true, target: threat?.type ?? null };
  }

  async _lowerShield () {
    if (!this.shieldUp) return { ok: true, raised: false, already: true };
    await this._queueAuthInput({ yaw: this.yaw ?? 0, pitch: this.pitch ?? 0 });
    this.shieldUp = false;
    this.log('shield_down', { item: this._offhandItem() });
    return { ok: true, raised: false };
  }

  // ---- pesca --------------------------------------------------------------------------

  // Riva più vicina per pescare: blocchi d'acqua adiacenti a un blocco solido
  // su cui il bot può stare, entro CAST_RANGE. Restituisce null se non c'è.
  _findFishingSpot () {
    if (!this.position) return null;
    const radius = CAST_RANGE + 1;
    const water = [
      ...this.world.findBlocks('water', this.position, radius, 64),
      ...this.world.findBlocks('flowing_water', this.position, radius, 64),
    ];
    if (!water.length) return null;
    const ground = [];
    const seen = new Set();
    for (const w of water) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const key = `${w.position.x + dx},${w.position.y},${w.position.z + dz}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const g = this.world.blockAt({ x: w.position.x + dx, y: w.position.y, z: w.position.z + dz });
        if (g && g.name !== 'air' && g.name !== 'unknown' && !isWaterBlock(g.name)) {
          ground.push({ name: g.name, position: { x: w.position.x + dx, y: w.position.y, z: w.position.z + dz } });
        }
      }
    }
    const candidates = shoreCandidates(
      [...water.map(w => ({ name: w.name, position: w.position })), ...ground],
      this.position,
    );
    return candidates[0] || null;
  }

  // Bobber (fishing_hook) attualmente in acqua, se tracciato.
  _findBobber () {
    for (const entity of this.entities.values()) {
      if (entity.type === 'fishing_hook') return entity;
    }
    return null;
  }

  // Dove è finito il bobber e se lì un morso può arrivare (diagnosi + cancello).
  _bobberVerdict (bobber = this._findBobber()) {
    const blockAt = typeof this.world?.blockAt === 'function' ? (p => this.world.blockAt(p) ?? null) : null;
    return bobberVerdict({ bobber, blockAt });
  }

  // Bobber: dove galleggia e se lì un morso può arrivare.
  _fishingContext () {
    if (!this.position) return null;
    const spot = this._findFishingSpot();
    const bobber = this._findBobber();
    const verdict = bobber ? this._bobberVerdict(bobber) : null;
    return {
      available: !!spot,
      spot: spot ? { position: spot.position, waterAt: spot.waterAt, distance: spot.distance } : null,
      rod: (this.inventory.fishing_rod || 0) > 0,
      string: (this.inventory.string || 0) > 0,
      bobberOut: !!bobber,
      bobber: bobber?.position
        ? { x: +bobber.position.x.toFixed(1), y: +bobber.position.y.toFixed(1), z: +bobber.position.z.toFixed(1), ...verdict }
        : null,
      fish: fishCount(this.inventory),
    };
  }

  // Lancia la canna verso la riva più vicina: equipaggia la canna, guarda
  // l'acqua e invia use_item click_air. Conferma: il bobber (fishing_hook)
  // appare tra le entità.
  async _castRod ({ timeoutMs = 8000 } = {}) {
    if ((this.inventory.fishing_rod || 0) < 1) return { ok: false, error: 'missing_fishing_rod' };
    const spot = this._findFishingSpot();
    if (!spot) return { ok: false, error: 'no_water_nearby' };
    let slotIndex = this.inventorySlots.findIndex(s => this._slotItemName(s) === 'fishing_rod' && s.count > 0);
    if (slotIndex < 0) {
      try { await this._resyncByReconnect(); } catch (error) { this.log('inventory_resync_failed', { message: error.message }); }
      slotIndex = this.inventorySlots.findIndex(s => this._slotItemName(s) === 'fishing_rod' && s.count > 0);
      if (slotIndex < 0) return { ok: false, error: 'missing_fishing_rod' };
    }
    if (slotIndex > 8) {
      try { slotIndex = await this._moveSlotToHotbar(slotIndex); }
      catch (error) { return { ok: false, error: `rod_equip_failed: ${error.message}` }; }
    }
    this._selectHotbarSlot(slotIndex);
    if (this._openContainer) await this._closeContainer();
    const shoreCenter = { x: spot.position.x + 0.5, y: spot.position.y + 1, z: spot.position.z + 0.5 };
    if (this._pointDistance(shoreCenter) > 4.5) {
      try { await this._moveTo(shoreCenter, 2.0, 25000); } catch (error) { this.log('fishing_shore_approach_failed', { message: error.message }); }
    }
    const look = this._lookAt({ x: spot.waterAt.x + 0.5, y: spot.waterAt.y + 0.5, z: spot.waterAt.z + 0.5 });
    await this._queueAuthInput({ yaw: look.yaw, pitch: look.pitch });
    await delay(120);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const held = this.inventorySlots[this.selectedHotbar] || { network_id: 0 };
      await this._queueAuthInput({ yaw: this._lastYaw, pitch: this._lastPitch, transaction: this._useItemTransaction(held, 'click_air') });
      const waitUntil = Math.min(deadline, Date.now() + 2200);
      while (Date.now() < waitUntil) {
        const bobber = this._findBobber();
        if (bobber?.position) {
          const verdict = this._bobberVerdict(bobber);
          const where = { x: +bobber.position.x.toFixed(1), y: +bobber.position.y.toFixed(1), z: +bobber.position.z.toFixed(1) };
          // Un gancio sulla terraferma non prenderà mai nulla: si recupera la
          // lenza e si dichiara il motivo, invece di aspettare la finestra del
          // morso per riportare `no_bite` (che accuserebbe il server a torto).
          if (!verdict.ok && !verdict.unknown) {
            this.log('bobber_not_in_water', { bobber: where, ...verdict });
            try { await this._reelIn({ timeoutMs: 1500 }); } catch (error) { this.log('reel_failed', { message: error.message }); }
            return { ok: false, error: 'bobber_not_in_water', bobber: where, verdict, waterAt: spot.waterAt };
          }
          if (verdict.covered) this.log('bobber_water_covered', { bobber: where, waterCell: verdict.waterCell, above: verdict.above });
          return { ok: true, bobber: where, verdict, waterAt: spot.waterAt };
        }
        await delay(100);
      }
    }
    return { ok: false, error: 'cast_not_confirmed', waterAt: spot.waterAt };
  }

  // Recupera la lenza: secondo use_item click_air. Conferma dal delta inventario
  // (un pesce in più). Restituisce caught=[] se il morso è mancato.
  async _reelIn ({ timeoutMs = 4000 } = {}) {
    if ((this.inventory.fishing_rod || 0) < 1) return { ok: false, error: 'missing_fishing_rod' };
    const before = fishCount(this.inventory);
    const held = this.inventorySlots[this.selectedHotbar] || { network_id: 0 };
    await this._queueAuthInput({ yaw: this._lastYaw, pitch: this._lastPitch, transaction: this._useItemTransaction(held, 'click_air') });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const after = fishCount(this.inventory);
      if (after > before) {
        return { ok: true, caught: fishItems(this.inventory), gained: after - before };
      }
      await delay(100);
    }
    return { ok: true, caught: [], gained: 0, note: 'no_bite' };
  }

  // Pesca completa: lancia, aspetta che il bobber si posi, attende il morso e
  // recupera. Un solo ciclo per invocazione.
  // Il morso è riconosciuto prima dall'evento di protocollo `fish_hook_hook`
  // (segnale esatto del server) e solo in fallback dall'affondo del bobber
  // rispetto alla quota di riposo: il calo del lancio non è un morso.
  async _fish ({
    castTimeoutMs = 8000, reelTimeoutMs = 4000, biteWindowMs = nextBiteDelay(),
    settleTimeoutMs = 4000, settleTolerance = 0.05, settleSamples = 3, biteDepth = 0.2,
  } = {}) {
    const castAt = Date.now();
    const cast = await this._castRod({ timeoutMs: castTimeoutMs });
    if (!cast.ok) return cast;
    // 1) Attesa che il bobber si posi: la y deve restare stabile per
    //    `settleSamples` campioni. Senza questo passo la caduta del lancio
    //    supera subito la soglia e verrebbe letta come morso (falso positivo).
    let startY = null;
    let lastY = null;
    let stable = 0;
    const settleDeadline = Date.now() + settleTimeoutMs;
    while (Date.now() < settleDeadline) {
      const b = this._findBobber();
      if (!b) break;
      const y = b.position?.y ?? null;
      if (y != null) {
        if (lastY != null && Math.abs(y - lastY) <= settleTolerance) {
          stable++;
          if (stable >= settleSamples) { startY = y; break; }
        } else {
          stable = 0;
        }
        lastY = y;
      }
      await delay(100);
    }
    if (startY == null) {
      const bobber = this._findBobber();
      if (!bobber) return { ok: false, error: 'bobber_lost', biteDetected: false };
      startY = bobber.position?.y ?? null; // nessuna quota stabile: resta il solo segnale di protocollo
    }
    // 2) Attesa del morso entro la finestra vanilla.
    const deadline = Date.now() + biteWindowMs;
    let biteDetected = false;
    let biteSource = null;
    let below = 0;
    while (Date.now() < deadline) {
      if (this._fishBiteAt >= castAt) {
        biteDetected = true;
        biteSource = 'event';
        break;
      }
      const b = this._findBobber();
      if (!b) break; // bobber sparito: la lenza è rientrata da sola
      const y = b.position?.y;
      if (startY != null && y != null && startY - y >= biteDepth) {
        // Fallback prudente: servono due campioni consecutivi sotto soglia.
        below++;
        if (below >= 2) {
          biteDetected = true;
          biteSource = 'dip';
          this.log('fish_bite_detected', { source: 'dip', startY: +startY.toFixed(2), y: +y.toFixed(2) });
          break;
        }
      } else {
        below = 0;
      }
      await delay(100);
    }
    const reel = await this._reelIn({ timeoutMs: reelTimeoutMs });
    return { ...reel, biteDetected, biteSource, bobber: cast.bobber, verdict: cast.verdict };
  }

  // Letti vicini nel mondo caricato (scansione con TTL di 30 s). Restituisce
  // *tutti* i candidati: il più vicino può essere irraggiungibile (villaggio su
  // più piani, porta chiusa da un villager) e un letto occupato non accetta il
  // sonno, quindi chi chiama deve poter passare al successivo.
  _findBeds () {
    if (!this.position) return [];
    const now = Date.now();
    if (this._bedCache && now - this._bedCache.at < 30000) return this._bedCache.beds;
    const found = this.world.findBlocks('bed', this.position, 48, 12) || [];
    const seen = new Set();
    const beds = [];
    for (const block of found) {
      if (!block?.position) continue;
      const key = block.position.x + ',' + block.position.y + ',' + block.position.z;
      if (seen.has(key)) continue;
      seen.add(key);
      beds.push({
        name: block.name,
        position: block.position,
        distance: +(block.distance ?? 0).toFixed(1),
        occupied: this._bedOccupied(block),
      });
    }
    // Prima i letti liberi (un letto occupato fa fallire il click), poi i più vicini.
    beds.sort((a, b) => (a.occupied === b.occupied ? a.distance - b.distance : (a.occupied ? 1 : -1)));
    this._bedCache = { at: now, beds, bed: beds.find(candidate => !candidate.occupied) || beds[0] || null };
    return beds;
  }

  // Rilegge lo stato del letto dalla colonna viva (blockAt): il server aggiorna
  // occupied_bit quando qualcuno ci dorme, quindi è una conferma server-side.
  _bedOccupiedAt (position) {
    try {
      const block = this.world?.blockAt?.(position);
      if (block) return this._bedOccupied(block);
    } catch { /* mondo non pronto: nessuna informazione */ }
    return null;
  }

  _bedOccupied (block) {
    try {
      return block?.getProperties?.()?.occupied_bit === true;
    } catch {
      return false;
    }
  }

  // Letto più vicino usabile adesso: una sola voce per chi ne vuole uno
  // (opzione sleep e _wake()).
  _findBed () {
    this._findBeds();
    return this._bedCache?.bed || null;
  }

  // Si avvicina al letto e ci clicca sopra finché il server non conferma il
  // sonno (flag resting nei metadata). Fallisce se non è né notte né temporale,
  // o se ci sono mostri.
  async _sleepInBed ({ approachTimeoutMs = 30000, retryTimeoutMs = 18000, confirmMs = 3000, maxBeds = SLEEP_MAX_BEDS, maxTotalMs = SLEEP_MAX_TOTAL_MS } = {}) {
    if (this.sleeping) return { ok: true, alreadySleeping: true };
    // Nel Nether e nell'End un letto esplode: non è un'azione vietata per
    // prudenza, è un'esplosione garantita. Il rifiuto è tipizzato e immediato.
    if (bedsExplode(this.dimension)) return { ok: false, error: 'beds_explode_here', dimension: this.dimension };
    if (!this._isSleepTime()) return { ok: false, error: 'not_night' };
    const beds = this._findBeds();
    // Prima i letti liberi, poi quelli occupati come ultima risorsa: un villager
    // può essersi alzato nel frattempo e un click costa poco. Si provano **tutti**
    // i letti del censimento (fino a `maxBeds`), non solo i primi tre: l'08/10/2026
    // i tre più vicini erano uno rifiutato e due irraggiungibili, mentre i letti a
    // piano terra delle case vicine non venivano mai tentati.
    const candidates = [
      ...beds.filter(candidate => !candidate.occupied),
      ...beds.filter(candidate => candidate.occupied),
    ].slice(0, maxBeds);
    if (!candidates.length) return { ok: false, error: 'no_bed' };
    const deadline = Date.now() + maxTotalMs;
    const tried = [];
    let lastError = 'bed_unreachable';
    let lastDistance = null;
    let serverSaid = [];
    for (let i = 0; i < candidates.length; i++) {
      const bed = candidates[i];
      const remaining = deadline - Date.now();
      // Il tetto e' complessivo: l'azione deve restare dentro il timeout
      // dell'harness, ma finche' c'e' budget si prova il letto successivo invece
      // di fermarsi. Un tentativo troppo corto non e' un tentativo: si annota.
      if (i > 0 && remaining < SLEEP_MIN_ATTEMPT_MS) {
        tried.push({ bed: bed.position, ok: false, error: 'budget_exhausted', distance: null });
        break;
      }
      const attempt = await this._trySleepInBed(bed, {
        approachTimeoutMs: Math.max(SLEEP_MIN_ATTEMPT_MS, Math.min(i === 0 ? approachTimeoutMs : retryTimeoutMs, remaining)),
        confirmMs,
      });
      // Il verdetto della singola riga: la mappa finale parla solo quando **tutti**
      // i letti falliscono, ma il caso normale è il primo letto rifiutato dal server
      // e il secondo accettato ~4 s dopo (ogni tramonto fra l'08 e il 09/10/2026),
      // e lì la ragione del rifiuto spariva dal ledger. La chiave del server la
      // nomina: la notte che aspetta altri giocatori resta un fatto della notte,
      // non di un letto, quindi non entra qui.
      const said = attempt.serverSaid || [];
      const verdict = attempt.ok || said.some(text => SLEEP_PENDING_PATTERNS.some(pattern => pattern.test(text)))
        ? null
        : (SLEEP_REFUSAL_KEYS.find(entry => said.some(text => entry.pattern.test(text)))?.error ?? null);
      tried.push({
        bed: bed.position,
        ok: !!attempt.ok,
        error: attempt.error || null,
        distance: attempt.distance ?? null,
        ...(verdict ? { verdict } : {}),
      });
      if (attempt.ok) return { ...attempt, tried };
      if (attempt.serverSaid?.length) serverSaid = [...new Set([...serverSaid, ...attempt.serverSaid])];
      lastError = attempt.error || lastError;
      lastDistance = attempt.distance ?? lastDistance;
      if (lastError === 'not_night') break;
    }
    // Il server ha detto con le sue parole che aspetta altri giocatori: il letto
    // non c'entra, e chiamarlo `sleep_rejected` mandava la diagnosi a caccia di
    // mostri e letti occupati che non esistevano (08/10/2026).
    const pending = serverSaid.filter(text => SLEEP_PENDING_PATTERNS.some(pattern => pattern.test(text)));
    const refusal = serverSaid
      .map(text => SLEEP_REFUSAL_KEYS.find(entry => entry.pattern.test(text)))
      .find(Boolean);
    const error = lastError !== 'sleep_rejected'
      ? lastError
      : pending.length
        ? 'sleep_pending_players'
        : (refusal ? refusal.error : 'sleep_rejected');
    return {
      ok: false,
      error,
      distance: lastDistance,
      tried,
      ...(serverSaid.length ? { serverSaid } : {}),
      hint: error === 'sleep_pending_players'
        ? 'the server accepted the click but the night cannot skip: other players must sleep too (playersSleepingPercentage)'
        : (refusal && lastError === 'sleep_rejected'
            ? refusal.hint
            : 'every nearby bed failed: unreachable, occupied, monsters nearby or the server says it is neither night nor a thunderstorm'),
    };
  }

  // Un singolo letto: ci si mette ACCANTO (fuori dal footprint: dentro il letto
  // la previsione locale blocca i passi e il server non accetta il sonno) e si
  // chiede il sonno come lo chiede un client vero: click sul blocco *e*
  // `player_action start_sleeping`. Il solo click lascia il server in una via di
  // mezzo — sposta il giocatore sul letto ma la notte non salta (live 04/10).
  async _trySleepInBed (bed, { approachTimeoutMs = 30000, confirmMs = 4000 } = {}) {
    const reach = 3.2;
    const bedCenter = { x: bed.position.x + 0.5, y: bed.position.y, z: bed.position.z + 0.5 };
    let distance = this._pointDistance(bedCenter);
    const horizontal = () => (this._feet ? Math.hypot(this._feet.x - bedCenter.x, this._feet.z - bedCenter.z) : Infinity);
    // Distance alone accepts a bed behind a wall. Approach a loaded, walkable
    // cell with a clear click path and arrive at that cell's actual elevation.
    if (distance > reach || horizontal() < 0.9 || !this._bedVisible(bed)) {
      // Tutte le posizioni di appoggio, non solo quella del cammino più corto: un
      // solo appoggio che si incastra (porta chiusa, cella occupata) faceva
      // dichiarare il letto irraggiungibile mentre un'altra cella era buona.
      const spots = this._bedStandSpots(bed).slice(0, SLEEP_SPOT_MAX);
      if (!spots.length) return { ok: false, error: 'bed_access_unavailable', bed: bed.position, distance: +distance.toFixed(2) };
      const approaches = [];
      for (let i = 0; i < spots.length; i++) {
        const spot = spots[i];
        const budget = i === 0 ? approachTimeoutMs : Math.min(SLEEP_SPOT_RETRY_MS, approachTimeoutMs);
        try {
          await this._moveTo(spot, 0.08, budget, { preciseArrival: true, verticalTolerance: 0.15, arrivalVerticalTolerance: 0.15 });
        } catch (error) {
          approaches.push({ spot, error: error.message });
          this.log('bed_approach_failed', { message: error.message, bed: bed.position, distance: +this._pointDistance(bedCenter).toFixed(2),
            spot, spotIndex: i, spots: spots.length, ...(error.details?.from ? { from: error.details.from } : {}) });
          continue;
        }
        distance = this._pointDistance(bedCenter);
        if (distance <= reach && this._bedVisible(bed)) break;
        approaches.push({ spot, error: distance > reach ? 'bed_unreachable' : 'bed_click_obstructed', distance: +distance.toFixed(2) });
      }
      distance = this._pointDistance(bedCenter);
      if (distance > reach) return { ok: false, error: 'bed_unreachable', bed: bed.position, distance: +distance.toFixed(2), ...(approaches.length ? { approaches } : {}) };
      if (!this._bedVisible(bed)) return { ok: false, error: 'bed_click_obstructed', bed: bed.position, distance: +distance.toFixed(2), ...(approaches.length ? { approaches } : {}) };
    }
    const beforeTicks = this._timeInfo()?.ticks ?? null;
    const occupiedBefore = this._bedOccupiedAt(bed.position);
    const levelEventBefore = this._sleepLevelEventAt;
    const bedPositionBefore = this._playerBedPosition
      ? this._playerBedPosition.x + ',' + this._playerBedPosition.y + ',' + this._playerBedPosition.z : null;
    const look = this._lookAt({ x: bedCenter.x, y: bed.position.y + 0.5, z: bedCenter.z });
    // M13: da qui in poi il server può rispondere a parole. Si guarda la finestra
    // esatta del click, non tutto lo storico.
    const clickWindowStart = Date.now();
    await this._queueAuthInput({ yaw: look.yaw, pitch: look.pitch });
    await delay(120);
    await this._queueAuthInput({ yaw: look.yaw, pitch: look.pitch, transaction: this._blockUseTransaction(bed.position) });
    this._sendSleepAction('start_sleeping', bed.position);
    const waitUntil = Date.now() + confirmMs;
    while (Date.now() < waitUntil) {
      const confirmed = this._sleepConfirmed(beforeTicks);
      if (this.sleeping || confirmed) return { ok: true, slept: confirmed ? 'night_skipped' : this._playerSleepKnown ? 'player_sleep_flag' : 'resting_flag', bed: bed.position };
      await delay(100);
    }
    // Nessuna conferma: il server può aver comunque spostato il giocatore a letto
    // (stato ibrido) — si esce esplicitamente prima di riportare il fallimento.
    const slept = this._sleepConfirmed(beforeTicks) || this.sleeping;
    if (this.sleeping) return { ok: true, slept: slept ? 'night_skipped' : 'resting_flag', bed: bed.position };
    this._sendSleepAction('stop_sleeping', bed.position);
    // M13: le parole del server in questa finestra. Con `playersSleepingPercentage`
    // a 100 il BDS risponde «altri N giocatori devono dormire» e nessuno dei tre
    // segnali di conferma arriva: senza questo testo l'esito sembra un letto
    // rifiutato.
    const serverSaid = this.serverText.filter(row => row.at >= clickWindowStart).map(row => row.text);
    // Diagnostica: quali segnali sono arrivati dopo la richiesta di sonno.
    this.log('sleep_probe', {
      bed: bed.position,
      sleeping: this.sleeping,
      ticks: this._timeInfo()?.ticks ?? null,
      beforeTicks,
      occupiedBefore,
      occupiedAfter: this._bedOccupiedAt(bed.position),
      levelEvent: this._sleepLevelEventAt > levelEventBefore ? 'new' : 'none',
      bedPositionBefore,
      bedPositionNow: this._playerBedPosition
        ? this._playerBedPosition.x + ',' + this._playerBedPosition.y + ',' + this._playerBedPosition.z : null,
      positionNow: this.position ? { x: +this.position.x.toFixed(2), y: +this.position.y.toFixed(2), z: +this.position.z.toFixed(2) } : null,
      serverSaid,
    });
    return {
      ok: false,
      error: 'sleep_rejected',
      bed: bed.position,
      distance: +distance.toFixed(2),
      ...(serverSaid.length ? { serverSaid } : {}),
      hint: 'bed occupied, monsters nearby or the server says it is neither night nor a thunderstorm',
    };
  }

  // Conferma del sonno: l'orologio che salta (con un solo giocatore il server
  // salta la notte appena accetta), il level event `players_sleeping` o il flag
  // `resting` (via `_setSleeping`).
  _sleepConfirmed (beforeTicks) {
    const ticks = this._timeInfo()?.ticks;
    if (beforeTicks != null && ticks != null && ticks < beforeTicks && (beforeTicks - ticks) > 3000) return true;
    if (this._sleepLevelEventAt && Date.now() - this._sleepLevelEventAt < 8000) return true;
    return false;
  }

  _sendSleepAction (action, position) {
    if (!this.client || this.client.entityId == null) return false;
    try {
      this.client.write('player_action', {
        runtime_entity_id: this.client.entityId,
        action,
        position,
        result_position: { x: 0, y: 0, z: 0 },
        face: 0,
      });
      this.log('sleep_action', { action, position });
      return true;
    } catch (error) {
      this.log('sleep_action_failed', { action, message: error.message });
      return false;
    }
  }

  // Punto di sosta per cliccare il letto: FUORI dal footprint, nella direzione da
  // cui il bot arriva (fallback ai quattro assi), con la cella dei piedi libera e
  // un piano d'appoggio sotto.
  // Tutte le posizioni di appoggio di un letto, dalla più corta da camminare.
  // Il letto occupa **due** celle: il giro guarda le celle attorno a entrambe le
  // metà (assi e diagonali), perché il lato verso il bot può essere chiuso mentre
  // l'altra metà ha una cella libera con linea di click. Ogni candidata deve
  // passare tre prove: cella calpestabile e libera sopra, letto visibile da lì,
  // cammino completo fino a quella cella.
  _bedStandSpots (bed) {
    if (!bed?.position || !this._feet) return [];
    const center = { x: bed.position.x + 0.5, y: bed.position.y, z: bed.position.z + 0.5 };
    const dx = this._feet.x - center.x, dz = this._feet.z - center.z;
    const len = Math.hypot(dx, dz);
    const halves = [{ x: bed.position.x, z: bed.position.z }];
    const head = this._bedHalfAway(bed);
    if (head) halves.push(head);
    const seen = new Set();
    const candidates = [];
    const push = (x, z) => {
      const key = `${x},${z}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({ x: x + 0.5, y: bed.position.y, z: z + 0.5 });
    };
    if (len > 0.3) push(Math.floor(center.x + (dx / len) * 1.9), Math.floor(center.z + (dz / len) * 1.9));
    for (const half of halves) {
      for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) push(half.x + ox, half.z + oz);
    }
    const spots = [];
    for (const spot of candidates) {
      if (!this._bedStandSpotFree(spot) || !this._bedVisible(bed, { x: spot.x, y: spot.y + EYE_HEIGHT, z: spot.z })) continue;
      const goal = { x: Math.floor(spot.x), y: spot.y, z: Math.floor(spot.z) };
      const path = this._findPath(this._startNode(), goal, { maxNodes: 512 });
      const end = path?.at(-1);
      if (!end || !['x', 'y', 'z'].every(axis => end[axis] === goal[axis])) continue;
      spots.push({ ...spot, length: path.length });
    }
    spots.sort((a, b) => a.length - b.length);
    return spots;
  }

  // L'altra metà del letto, se il mondo la conosce: si cerca il blocco letto
  // accanto, senza fidarsi della convenzione del campo `direction`.
  _bedHalfAway (bed) {
    if (!bed?.position) return null;
    for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = bed.position.x + ox, z = bed.position.z + oz;
      const block = this.world.blockAt({ x, y: bed.position.y, z });
      if (typeof block?.name === 'string' && block.name.endsWith('_bed')) return { x, z };
    }
    return null;
  }

  _bedStandSpot (bed) {
    const spot = this._bedStandSpots(bed)[0];
    return spot ? { x: spot.x, y: spot.y, z: spot.z } : null;
  }

  _bedVisible (bed, eye = this.position) {
    if (!bed?.position || !eye) return false;
    const aim = { x: bed.position.x + 0.5, y: bed.position.y + 0.5, z: bed.position.z + 0.5 };
    const verdict = this._segmentVisible(eye, aim, { targetCell: bed.position, requireLoaded: true });
    return verdict.visible && !verdict.unknown;
  }

  _bedStandSpotFree (spot) {
    try {
      const bx = Math.floor(spot.x), by = Math.floor(spot.y), bz = Math.floor(spot.z);
      const feet = this.world.blockAt({ x: bx, y: by, z: bz });
      const head = this.world.blockAt({ x: bx, y: by + 1, z: bz });
      const below = this.world.blockAt({ x: bx, y: by - 1, z: bz });
      const free = block => !!block && block.name !== 'unknown' && block.name !== 'bed' && !block.name.endsWith('_bed') && this._passable(block);
      const floor = block => !!block && block.name !== 'unknown' && block.boundingBox === 'block';
      return free(feet) && free(head) && floor(below);
    } catch { return false; }
  }

  // ---- risalita a gradini (uscita da buche/pozzi) ------------------------------------

  // Specchio di _digTargets: il blocco davanti ai piedi è il gradino, le due celle
  // sopra (piedi e testa) vanno aperte per poterci salire; se la volta sopra il
  // bot è chiusa va aperta prima, altrimenti il salto non parte.
  // Il gradino si cerca nella direzione in cui il bot guarda (o imposta dal
  // waypoint), ma una scalinata sale anche di lato o alle spalle: se la direzione
  // primaria non ha un gradino (`no_step_ahead`, il caso che ha incastrato il bot
  // due volte nel tunnel che aveva appena scavato, a ~y 29.6 e ~y 48.6) si provano
  // le altre tre. L'errore riportato resta quello della direzione primaria e
  // `tried` elenca le direzioni provate; la primaria vince sempre quando è valida,
  // così la scalinata resta dritta.
  _upTargets () {
    if (!this.position || !this._feet) return { error: 'no_position' };
    const primary = this._digDirection();
    const dirs = [{ dx: 1, dz: 0 }, { dx: 0, dz: 1 }, { dx: -1, dz: 0 }, { dx: 0, dz: -1 }]
      .filter(c => c.dx !== primary.dx || c.dz !== primary.dz);
    dirs.unshift(primary);
    let firstError = null;
    const tried = [];
    for (const d of dirs) {
      const plan = this._upTargetsFor(d);
      if (!plan.error) return plan;
      tried.push({ direction: { dx: d.dx, dz: d.dz }, error: plan.error });
      if (!firstError) firstError = plan;
    }
    return { ...firstError, tried };
  }

  // Il piano di risalita per una direzione cardinale: è il corpo di _upTargets.
  _upTargetsFor (d) {
    if (!this.position || !this._feet) return { error: 'no_position' };
    const feet = this._feet;
    const fy = Math.floor(feet.y + 0.1);
    const fx = Math.floor(feet.x), fz = Math.floor(feet.z);
    const front = { x: fx + d.dx, y: fy, z: fz + d.dz };
    const step = { x: front.x, y: fy + 1, z: front.z };
    const head = { x: front.x, y: fy + 2, z: front.z };
    const targets = [];
    // Volta sopra la testa del bot: serve spazio verticale per il salto.
    const ownCeiling = { x: fx, y: fy + 2, z: fz };
    const ceilingBlock = this.world.blockAt(ownCeiling);
    if (ceilingBlock && ceilingBlock.name === 'unknown') {
      targets.push({ cell: ownCeiling, block: ceilingBlock, label: 'ceiling', raw: true });
    } else if (ceilingBlock && !this._passableForPath(ceilingBlock)) {
      if (/water|lava/.test(ceilingBlock.name)) return { error: 'unsafe_block_ceiling' };
      if (!ceilingBlock.diggable || !(ceilingBlock.hardness >= 0)) return { error: 'not_diggable_ceiling' };
      targets.push({ cell: ownCeiling, block: ceilingBlock, label: 'ceiling' });
    }
    for (const [cell, label] of [[step, 'step'], [head, 'head']]) {
      const block = this.world.blockAt(cell);
      if (!block) return { error: 'world_not_loaded' };
      if (block.name === 'unknown') { targets.push({ cell, block, label, raw: true }); continue; }
      if (this._passableForPath(block)) continue;
      if (/water|lava/.test(block.name)) return { error: `unsafe_block_${label}` };
      if (DIG_PROTECTED.test(block.name)) return { error: `protected_${label}`, block: block.name };
      // W0: come in _digTargets, scavare dentro il raggio di un sensore vibra.
      const noise = this._vibrationRiskAt(cell);
      if (noise) return { error: `vibration_risk_${label}`, block: block.name, position: cell, sensors: noise.count, nearest: noise.nearest };
      if (!block.diggable || !(block.hardness >= 0)) return { error: `not_diggable_${label}` };
      targets.push({ cell, block, label });
    }
    // Come in _digTargets: i fluidi adiacenti si controllano dopo, così vince il
    // motivo più specifico (fluido nella cella da scavare).
    for (const target of targets) {
      if (target.raw) continue;
      const fluidRisk = digFluidRisk({ neighbors: this._fluidNeighbors(target.cell), avoidWater: true });
      if (fluidRisk.unsafe) return { error: `unsafe_${fluidRisk.reason}_${target.label}`, block: fluidRisk.block, position: fluidRisk.position };
    }
    // Il gradino vero e proprio (davanti ai piedi) deve essere solido.
    if (!this._solidAt(front.x, front.y, front.z)) return { error: 'no_step_ahead' };
    return { direction: d, front, step, head, targets };
  }

  async _ascendStair (plan, { moveMs = 8000, settleMs = 2000 } = {}) {
    const startY = this._feet.y;
    const stepCenter = { x: plan.step.x + 0.5, y: plan.step.y, z: plan.step.z + 0.5 };
    const beyond = { x: plan.step.x + plan.direction.dx, y: plan.step.y, z: plan.step.z + plan.direction.dz };
    const path = [this._startNode(), plan.step, beyond];
    const motion = this._startMotion(path, beyond, stepCenter, 0.4, Date.now() + moveMs);
    const timedOut = await Promise.race([motion.then(() => false), delay(moveMs).then(() => true)]);
    if (timedOut) this._finishMotion('timeout');
    await motion;
    this._stopMotion();
    const settleUntil = Date.now() + settleMs;
    while (Date.now() < settleUntil && this._feet.y < startY + 0.9) await delay(50);
    return this._feet.y >= startY + 0.9;
  }

  async _digUp (timeoutMs = 30000) {
    const plan = this._upTargets();
    if (plan.error) return { ok: false, error: plan.error };
    const dug = [];
    for (const target of plan.targets) {
      const { cell, block, label } = target;
      const result = await this._mineTarget(target, timeoutMs);
      if (!result.ok) return { ...result, dug };
      dug.push({ label, block: block.name, position: cell, tool: result.tool ?? null });
    }
    try {
      const moved = await this._ascendStair(plan);
      return { ok: true, dug, moved, position: this.pos() };
    } catch (error) {
      return { ok: false, error: `step_move_failed: ${error.message}`, dug, position: this.pos() };
    }
  }

  // Scava un bersaglio: per gli hash non risolti ("unknown") usa una rottura
  // grezza col runtime id del server, senza previsioni di utensile.
  async _mineTarget (target, timeoutMs) {
    if (target?.raw || target?.block?.name === 'unknown') return this._mineRawCell(target.cell, timeoutMs);
    return this._mineBlock(target.block, timeoutMs);
  }

  async _mineRawCell (position, timeoutMs = 4000) {
    if (!this.client) throw new Error('no client');
    const runtimeId = this.world.runtimeIdAt(position);
    if (runtimeId == null) return { ok: false, error: 'block_runtime_id_unknown' };
    const original = this.world.blockAt(position);
    if (!original || original.name !== 'unknown') return { ok: false, error: 'not_unknown' };
    const look = this._lookAt({ x: position.x + 0.5, y: position.y + 0.5, z: position.z + 0.5 });
    const face = this._faceForBlock(position, this.position);
    const action = name => [{ action: name, position: { x: position.x, y: position.y, z: position.z }, face }];
    const started = Date.now();
    const deadline = started + Math.max(1200, timeoutMs);
    await this._queueAuthInput({ yaw: look.yaw, pitch: look.pitch, blockAction: action('start_break') });
    while (Date.now() < deadline) {
      await this._queueAuthInput({ yaw: look.yaw, pitch: look.pitch, blockAction: action('continue_break') });
      const current = this.world.blockAt(position);
      if (!current || current.name !== 'unknown' || current.runtimeId !== runtimeId) {
        await this._queueAuthInput({ yaw: look.yaw, pitch: look.pitch, blockAction: action('stop_break') });
        const picked = await this._pickupNearby();
        this.world.refreshSection(this.client, position);
        this._refreshNearby();
        this.log('raw_mined', { position, ms: Date.now() - started });
        return { ok: true, block: 'unknown', position, ms: Date.now() - started, picked };
      }
      await delay(50);
    }
    await this._queueAuthInput({ yaw: look.yaw, pitch: look.pitch, blockAction: action('stop_break') });
    return { ok: false, error: 'raw_break_timeout', position };
  }
}
