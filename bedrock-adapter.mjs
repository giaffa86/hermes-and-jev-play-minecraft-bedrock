// BedrockAdapter: sostituisce il layer Mineflayer+flying-squid per Minecraft Bedrock Edition.
// Implementa la stessa interfaccia semantica del vecchio harness:
//   observe(), getAvailableActions(), executeAction(), connect(), disconnect()
// Il controller Hermes/Jev non deve sapere che siamo su Bedrock.
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { BedrockWorld } from './bedrock-world.mjs';
import { trackNethernetClient, closeBedrockClient } from './bedrock-lifecycle.mjs';
import { bestFood, isHostileType, isTraderType, isFarmAnimalType, isTameableType, isRideTameableType, isCompanionType, isVehicleType, isRideableType, animalFeed, tameFeed, cropForSeed, isCropBlock, isFarmlandBlock, entityHeight, normalizeEntityType, estimatedTimeOfDay, isNightTime, timePhase, awayDirection, rotateDirection, PLANTABLE_ITEMS } from './bedrock-survival.mjs';
import { professionName, normalizeProfession, professionMatches, pickBestTrade } from './bedrock-trading.mjs';
import { isWaterBlock, fishCount, fishItems, shoreCandidates, nextBiteDelay, FISHING_ROD_INGREDIENTS, CAST_RANGE } from './bedrock-fishing.mjs';
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
const GRAVITY = 0.08;           // blocchi per tick^2
const JUMP_VELOCITY = 0.42;     // impulso verticale di un salto
const MAX_SIM_STEPS = 8;        // tick di fisica massimi per singolo invio
const PLAYER_HALF_WIDTH = 0.3;
const PLAYER_HEIGHT = 1.8;
const PATH_MAX_NODES = 5000;    // tetti di ricerca A*
const MAX_CORRECTION_DRIFT = 0.75; // oltre questa distanza la correzione è autoritativa su X/Z
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
const DIG_PROTECTED = /(_table$|chest$|furnace$|smoker$|barrel$|shulker_box$|hopper$|anvil$|brewing_stand$|beacon$|loom$|stonecutter$|grindstone$|lectern$|composter$|cauldron$|bell$|_bed$|_sign$|_banner$|_skull$|_head$|flower_pot$|_pot$|respawn_anchor$|torch$|lantern$|_planks$|_slab$|_stairs$|_wool$|glass$|bricks$|_concrete$|terracotta$|carpet$|farmland$|_fence$|_fence_gate$|wheat$|carrots$|potatoes$|beetroots$|melon_stem$|pumpkin_stem$|sweet_berry_bush$|nether_wart$)/;
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
};
// Contenitori di stoccaggio: bauli, bauli-trappola, botti e shulker (opzionale).
// La window_type Bedrock per baule/botte è 'container'; lo slot nelle richieste
// stack usa ContainerSlotType 7 ('container') per i bauli e 58 ('barrel') per le botti.
const STORAGE_BLOCKS = ['chest', 'trapped_chest', 'barrel', 'shulker_box'];
// TTL della cache contenitori: altri giocatori possono cambiare le scorte.
const CONTAINER_TTL_MS = 5 * 60 * 1000;
// Slot esposti da un baule/botte singolo (i bauli doppi ne espongono 54).
const CONTAINER_SLOT_COUNT = 27;

const STORAGE_CONTAINER_SLOT = {
  chest: 'container',
  trapped_chest: 'container',
  barrel: 'barrel',
  shulker_box: 'shulker',
};

export class BedrockAdapter {
  constructor ({ logger = console, onLog, onDisconnect } = {}) {
    this.logger = logger;
    this.onLog = onLog;
    this.onDisconnect = onDisconnect;
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
    this.nearbyBlocks = {};
    this.dimension = 'overworld';
    this.standingOn = null;
    this.plan = null;
    this.chatInbox = [];             // messaggi chat recenti { from, message, type, xuid, at }
    this._playersByName = new Map(); // gamertag minuscolo -> runtimeId (chat -> entità da seguire)
    this.busy = false;
    this.recent = [];
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
    this.riding = null;                // { riddenEntityId, at } quando il bot è montato
    this._ridingForward = false;       // vettore avanti continuo mentre cavalca
    this._ridingYaw = 0;               // yaw verso cui cavalcare
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
    this.containers = new Map();       // "<x,y,z>" -> { type, readAt, contents: { item: count } }
    this._containerWaiters = [];
    this._craftingGrid = new Map();    // gridSlot -> { network_id, count, stack_id }
    this._cursor = null;               // { network_id, count, stack_id }
    // Commercio: offerte del villager/mercante aperto, finestra e slot di trading.
    this.tradeOffers = [];             // offerte parse da update_trade
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
    this.dead = false;
    this.deaths = 0;
    this._respawnAt = 0;
    this._limboSince = null;           // health <= 0 senza stato dead (respawn a metà)
    this.deathSite = null;             // { position, at, attempts } per il recupero post-morte
    this.experienceLevel = null;       // livello EXP dal server (attributi)
    this.experienceProgress = null;
    this._bedCache = null;             // { at, bed } scansione letti con TTL
    this.world = new BedrockWorld({ version: VERSION, onError: error => this.log('world_error', { message: error.message }) });
  }

  log (type, data) {
    const entry = { t: Date.now(), type, ...data };
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
        if (packet.window_type === 'trading' || packet.window_type === 15) {
          // La finestra di trading viene aperta dal server in risposta all'interact
          // sul villager; il contenuto delle tre slot arriva con inventory_content.
          this._tradeSlots = { ingredient1: null, ingredient2: null, result: null };
          if (!this.tradeOpenedAt) this.tradeOpenedAt = Date.now();
        }
        this.log('container_open', { windowId: packet.window_id, windowType: packet.window_type });
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
        this.position = client.startGameData?.player_position;
        this.dimension = client.startGameData?.dimension || 'overworld';
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

      this.client.on('start_game', (packet) => {
        this.position = packet.player_position;
        this.dimension = packet.dimension || 'overworld';
        this.movementAuthority = packet.movement_authority ?? null;
        this.rewindHistorySize = packet.rewind_history_size ?? null;
        this.serverAuthBlockBreaking = packet.server_authoritative_block_breaking ?? false;
        this.inventorySlots = [];
        this.inventory = {};
        this.pickups = {};
        this.selectedHotbar = 0;
        this._furnaceSlots = {};
        this.tick = BigInt(packet.current_tick || 0);
        this._tickAnchor = { tick: this.tick, time: Date.now() };
        this._lastSimTick = null;
        this.log('start_game', { serverAuthBlockBreaking: this.serverAuthBlockBreaking, movementAuthority: this.movementAuthority, rewindHistorySize: this.rewindHistorySize });
        this.world.start(packet);
      });

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
      });
      client.on('subchunk', packet => {
        this.world.subchunk(packet);
        this._refreshNearby();
      });

      this.client.on('move_player', (packet) => {
        if (String(packet.runtime_id) !== String(client.entityId)) return;
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
        this._feet.y = packet.position.y - EYE_HEIGHT;
        if (packet.on_ground != null) {
          this._onGround = packet.on_ground;
          if (packet.on_ground) this._velocity.y = 0;
        }
        this._syncPositionFromFeet();
        this.world.requestAround(client, this.position);
        this._refreshNearby();
      });

      // Collegamento cavaliere→veicolo: il server conferma montata/smontata.
      client.on('set_entity_link', (packet) => {
        const self = String(this.client?.entityId ?? '');
        for (const link of packet.links || []) {
          if (String(link.rider_entity_id) !== self) continue;
          if (link.type === 0) {
            this.riding = null;
            this._ridingForward = false;
            this.log('dismount', { ridden: String(link.ridden_entity_id) });
          } else {
            this.riding = { riddenEntityId: String(link.ridden_entity_id), at: Date.now() };
            this.log('mount', { ridden: String(link.ridden_entity_id), type: link.type });
          }
        }
      });

      this.client.on('set_health', (packet) => {
        this.health = packet.health;
        this._onOwnHealth();
      });

      this.client.on('update_attributes', (packet) => this._applyOwnAttributes(packet));

      this.client.on('inventory_content', (packet) => {
        const containerId = packet.container?.container_id;
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
          const slotList = packet.input || packet.contents || [];
          const isPlayerContainer = containerId == null || containerId === 'hotbar' || containerId === 'inventory' || containerId === 'hotbar_and_inventory';
          // Alcuni sync etichettano il contenuto del giocatore con un container
          // inatteso ma 36 slot pieni: accettali; gli stessi pacchetti vuoti
          // vanno applicati solo se non c'è nulla da perdere (altrimenti wipe).
          const isFullPlayerInventory = slotList.length === 36 && slotList.some(s => s?.network_id);
          const clearWhenEmpty = slotList.length === 36 && !this.inventorySlots.some(s => s?.network_id);
          if (containerId !== 'crafting_input' && (isPlayerContainer || isFullPlayerInventory || clearWhenEmpty)) {
            this.inventorySlots = slotList;
            this._refreshInventory();
          }
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
        if (this._trackFurnaceSlot(containerId, packet.item)) return; // non è uno slot del giocatore
        if (this._trackTradeSlot(containerId, packet.slot, packet.item)) return; // slot della finestra di trading
        const index = this._playerSlotIndex(containerId, packet.window_id, packet.slot);
        if (index == null || index < 0 || index > 35) return;
        this.inventorySlots[index] = packet.item;
        this._refreshInventory();
      });
      client.on('mob_equipment', packet => {
        if (String(packet.runtime_entity_id) !== String(client.entityId)) return;
        this.selectedHotbar = packet.selected_slot;
      });

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

      const findDrop = packet => this.drops.find(d => String(d.runtime_id) === String(packet.runtime_entity_id) || String(d.id) === String(packet.runtime_entity_id));
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
      this.client.on('take_item_entity', (packet) => {
        const drop = findDrop(packet);
        // BDS con inventario server-authoritative non invia un aggiornamento di
        // inventario al pickup: la conferma take_item_entity è la fonte più
        // aggiornata disponibile, quindi il conteggio viene aggiornato subito.
        const target = packet.target ?? packet.runtime_entity_id;
        if (drop && String(target) === String(client.entityId)) {
          const name = drop.item;
          this.pickups[name] = (this.pickups[name] || 0) + (drop.count || 1);
          this._refreshInventory();
        }
        this.drops = this.drops.filter(d => String(d.runtime_id) !== String(packet.runtime_entity_id) && String(d.id) !== String(packet.runtime_entity_id));
      });

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
      this.client.on('sync_world_clocks', (packet) => this._onWorldClocks(packet));
      this.client.on('respawn', (packet) => this._onRespawnPacket(packet));
      this.client.on('move_entity', (packet) => this._onEntityMove(packet));
      this.client.on('move_entity_delta', (packet) => this._onEntityMove(packet));
      this.client.on('remove_entity', (packet) => this._onEntityRemove(packet));

      await new Promise((resolve, reject) => {
        const finish = error => {
          clearTimeout(to);
          client.off('spawn', onSpawn);
          client.off('close', onClose);
          client.off('error', onError);
          error ? reject(error) : resolve();
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
    for (const name of ['dirt', 'grass_block', 'stone', 'cobblestone', 'coal_ore', 'deepslate_coal_ore', 'iron_ore', 'deepslate_iron_ore', 'copper_ore', 'oak_log', 'spruce_log', 'cherry_log', 'potatoes', 'carrots', 'wheat', 'beetroots']) {
      this.nearbyBlocks[name] = this.world.findBlocks(name, this.position, 96, 4).map(block => ({ name: block.name, position: block.position, distance: +block.distance.toFixed(1), diggable: block.diggable, hardness: block.hardness }));
    }
    // Bedrock player_position is at eye height (1.62 blocks above the feet).
    this.standingOn = this.world.blockAt({ ...this.position, y: this.position.y - 1.63 })?.name ?? null;
    this._pruneEntities();
  }

  _refreshInventory () {
    this.inventory = { ...this.pickups };
    for (const item of this.inventorySlots) {
      if (!item?.network_id) continue;
      const name = item.name || this.world.registry?.items[item.network_id]?.name || `item_${item.network_id}`;
      this.inventory[name] = (this.inventory[name] || 0) + (item.count || 1);
    }
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

  observe () {
    const heldSlot = this.inventorySlots[this.selectedHotbar];
    const heldInfo = heldSlot?.network_id ? this.world.registry?.items[heldSlot.network_id] : null;
    const bed = this._findBed();
    return {
      step: this.recent.length,
      position: this.pos(),
      health: this.health,
      food: this.food,
      dimension: this.dimension,
      standingOn: this.standingOn,
      inventory: this.inventory,
      held: this._slotItemName(heldSlot),
      heldDurability: heldInfo?.maxDurability
        ? { damage: this._itemDamage(heldSlot), max: heldInfo.maxDurability }
        : null,
      drops: this.drops.slice(0, 8),
      containers: this._cachedContainers().map(c => ({
        position: c.position,
        type: c.type,
        readAt: c.readAt,
        contents: c.contents,
      })),
      plan: this.plan,
      chat: this.chatInbox.slice(-10),
      nearby: this.nearbyBlocks,
      recent: this.recent.slice(-8),
      status: this.status,
      spawned: this.spawned,
      time: this._timeInfo(),
      bed: bed ? { position: bed.position, distance: bed.distance } : null,
      sleeping: this.sleeping,
      dead: this.dead,
      deaths: this.deaths,
      deathSite: this.deathSite ? { position: this.deathSite.position, at: this.deathSite.at } : null,
      experience: this.experienceLevel != null ? { level: this.experienceLevel, progress: this.experienceProgress } : null,
      entities: this._nearbyEntities(8),
      farmAnimals: this._nearbyFarmAnimals(8),
      companions: this._nearbyCompanion(8),
      fishing: this._fishingContext(),
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

  options () {
    // Durante una riconnessione NetherNet l'unica azione sensata è attendere:
    // le opzioni calcolate sul mondo vecchio fallirebbero comunque.
    if (!this.spawned || this.status !== 'spawned') {
      return [{ key: 'wait', description: 'Wait for the Bedrock connection to be re-established' }];
    }
    if (this.dead) {
      return [{ key: 'wait', description: 'Dead; respawning automatically' }];
    }
    if (this.sleeping) {
      return [{ key: 'wait', description: 'Sleeping in bed until morning' }];
    }
    const o = [];
    const p = this.pos();
    const waypointUnmet = this.plan?.waypoint && p && Math.hypot(this.plan.waypoint.x - p.x, this.plan.waypoint.z - p.z) > 2;
    const drop = this._nearestDrop();
    // Un drop fresco e vicino va raccolto subito: lo si mette prima del waypoint
    // e lo si segnala nella descrizione.
    const fresh = drop && drop.spawnedAt && Date.now() - drop.spawnedAt < 15000 && drop.distance <= 8;
    if (drop && fresh) {
      o.push({ key: 'collect_drop', description: `Pick up the item just dropped (${drop.item} ×${drop.count || 1}, ${drop.distance.toFixed(1)} blocks away)` });
    }
    if (waypointUnmet) {
      o.push({ key: 'goto_waypoint', description: `Pathfind to planner waypoint ${JSON.stringify(this.plan.waypoint)}` });
    }
    // Comando umano "seguimi": plan.follow = gamertag del giocatore da seguire.
    const follow = this._playerByName(this.plan?.follow);
    if (follow && follow.position) {
      const d = this._entityDistance(follow);
      o.push({ key: 'follow_player', description: `Follow ${follow.username || this.plan.follow} (${d.toFixed(1)} blocks away)` });
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
      attackTypes.add(threat.type);
      o.push({ key: `attack_${threat.type}`, description: `Attack the ${threat.type} (${threat.distance.toFixed(1)} blocks away, ${threat.health != null ? `health ${threat.health}` : 'health unknown'})` });
      if (attackTypes.size >= 3) break;
    }
    if (threats.length && threats[0].distance <= 16) {
      o.push({ key: 'flee', description: `Run away from the nearest ${threats[0].type} (${threats[0].distance.toFixed(1)} blocks away)` });
    }
    const food = this._bestFoodItem();
    if (food && (this.food < 18 || (this.health < 20 && this.food < 20))) {
      o.push({ key: 'eat', description: `Eat ${food} to restore hunger (hunger ${this.food}/20, health ${this.health}/20)` });
    }
    if (this._isNight()) {
      const bed = this._findBed();
      if (bed) o.push({ key: 'sleep', description: `Sleep in the bed at ${JSON.stringify(bed.position)} (${bed.distance} blocks away) before the night is dangerous` });
    }
    // Recupero post-morte: il loot e gli orb EXP sono rimasti dov'è morto.
    if (this.deathSite && this.position) {
      const p = this.deathSite.position;
      const d = Math.hypot(p.x - this.position.x, p.z - this.position.z);
      o.push({ key: 'recover_loot', description: `Walk back to the death site at ${JSON.stringify(p)} (${d.toFixed(1)} blocks) to recover the dropped items and XP orbs` });
    }
    // Commercio: apri la finestra su un trader vicino, oppure offri ogni scambio
    // eseguibile con l'inventario corrente. La scelta economica resta a Jev.
    const trader = this._nearestTrader();
    if (trader && !this._tradeWindowOpen()) {
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
      const levelable = this._nearbyTraders(12).filter(t => t.type !== 'wandering_trader');
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
    for (const [blockName, blocks] of Object.entries(this.nearbyBlocks || {})) {
      const target = this._pickMineTarget(blocks);
      if (!target) continue;
      const probe = this.world.blockAt(target.position);
      if (probe) {
        const kind = this._requiredToolKind(probe);
        const tool = kind ? this._bestInventoryTool(kind)?.name : null;
        if (!this._blockHarvestable(probe, tool)) continue;
      }
      o.push({ key: `mine_${blockName}`, description: `Mine ${blockName} at ${JSON.stringify(target.position)} (${target.distance} blocks away)` });
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
      if (this.recipes.has('fishing_rod') && (this.inventory.stick || 0) >= FISHING_ROD_INGREDIENTS.stick &&
          (this.inventory.string || 0) >= FISHING_ROD_INGREDIENTS.string &&
          this.world.findBlocks('crafting_table', this.position, 32, 1).length) {
        o.push({ key: 'craft_fishing_rod', description: 'Craft a fishing rod from 3 sticks and 2 string (uses a crafting table)' });
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
    if (storageBlocks.length) {
      const freshKeys = new Set(cached.map(c => c.key));
      const stale = storageBlocks.filter(b => !freshKeys.has(this._containerCacheKey(b.position)));
      if (stale.length) {
        const names = [...new Set(storageBlocks.map(b => b.name))].join(', ');
        o.push({ key: 'read_container', description: `Open and inventory ${storageBlocks.length} nearby storage container(s) (${names})` });
      }
    }
    // Prelievo: solo item presenti in un contenitore noto e non scaduto.
    let takeOffered = 0;
    for (const c of cached) {
      for (const [item, count] of Object.entries(c.contents)) {
        if (!count) continue;
        o.push({ key: `take_${item}`, description: `Take ${count} ${item} from the ${c.type} at ${JSON.stringify(c.position)} (container has ${count})` });
        if (++takeOffered >= 8) break;
      }
      if (takeOffered >= 8) break;
    }
    // Deposito: oggetti di valore verso il contenitore noto (o vicino) più prossimo.
    const depositTarget = cached[0] || storageBlocks[0];
    if (depositTarget) {
      let depositOffered = 0;
      for (const item of Object.keys(this.inventory)) {
        if (!this._isValuable(item) || !(this.inventory[item] > 0)) continue;
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
        offered.add(animal.type);
        o.push({ key: `attack_${animal.type}`, description: `Hunt the ${animal.type} for food (${animal.distance.toFixed(1)} blocks away${animal.baby ? ', baby' : ''})` });
        const feed = animalFeed(animal.type);
        if (feed && (this.inventory[feed] || 0) > 0) {
          o.push({ key: `feed_${animal.type}`, description: `Feed the ${animal.type} ${feed} to make it breed (${animal.distance.toFixed(1)} blocks away)` });
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
        const sheep = allFarm.find(e => e.type === 'sheep' && !e.sheared && !e.baby);
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
        seen.add(r.type);
        o.push({ key: `mount_${r.type}`, description: `Mount the ${r.type} (${r.distance.toFixed(1)} blocks away)` });
        if (seen.size >= 4) break;
      }
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
    // Fallback
    if (!o.length) o.push({ key: 'wait', description: 'Wait 2 seconds for fresh observations' });
    return o;
  }

  async executeAction (key) {
    if (this.busy) return { ok: false, error: 'busy' };
    // 'wait' resta eseguibile durante una riconnessione; le altre azioni no.
    if (key !== 'wait' && (!this.client || !this.spawned || this.status !== 'spawned')) {
      return { ok: false, error: 'not_connected' };
    }
    if (this.dead && key !== 'wait') return { ok: false, error: 'dead' };
    if (this.sleeping && key !== 'wait') return { ok: false, error: 'sleeping' };
    this.busy = true;
    const started = Date.now();
    let result;
    try {
      if (key === 'wait') {
        await new Promise(r => setTimeout(r, 2000));
        result = { ok: true };
      } else if (key === 'goto_waypoint' && this.plan?.waypoint) {
        const w = this.plan.waypoint;
        const target = { x: w.x, y: this.position?.y ?? 70, z: w.z };
        if (this.riding) {
          result = await this._rideToward(target, 3, 45000);
        } else {
          const moveResult = await this._moveTo(target, 2, 45000);
          result = { ok: true, ...moveResult };
        }
      } else if (key === 'follow_player' && this.plan?.follow) {
        result = await this._followPlayer(this.plan.follow);
      } else if (key === 'collect_drop') {
        result = await this._collectDrop();
      } else if (key === 'dig_down') {
        result = await this._digDown();
      } else if (key === 'dig_up') {
        result = await this._digUp();
      } else if (key.startsWith('mine_')) {
        const blockName = key.slice('mine_'.length);
        const target = this._pickMineTarget(this.world.findBlocks(blockName, this.position, 96, 8));
        if (!target) throw new Error(`no reachable ${blockName} found nearby`);
        result = await this._mineBlock(target);
      } else if (key.startsWith('craft_')) {
        result = await this._craftItem(key.slice('craft_'.length));
      } else if (key.startsWith('smelt_')) {
        result = await this._smeltItem(key.slice('smelt_'.length));
      } else if (key.startsWith('plant_')) {
        result = await this._plantSeed(key.slice('plant_'.length));
      } else if (key.startsWith('feed_')) {
        result = await this._feedAnimal(key.slice('feed_'.length));
      } else if (key === 'throw_egg') {
        result = await this._throwEgg();
      } else if (key.startsWith('breed_')) {
        result = await this._breedAnimals(key.slice('breed_'.length));
      } else if (key.startsWith('tame_')) {
        result = await this._tameAnimal(key.slice('tame_'.length));
      } else if (key.startsWith('mount_')) {
        result = await this._mountVehicle(key.slice('mount_'.length));
      } else if (key === 'dismount') {
        result = await this._dismount();
      } else if (key === 'shear_sheep') {
        result = await this._shearSheep();
      } else if (key === 'read_container') {
        result = await this._readContainers();
      } else if (key.startsWith('take_')) {
        result = await this._takeFromContainer(key.slice('take_'.length));
      } else if (key.startsWith('deposit_')) {
        result = await this._depositItem(key.slice('deposit_'.length));
      } else if (key.startsWith('place_')) {
        const itemName = key.slice('place_'.length);
        result = await this._placeBlock(itemName, itemName);
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
      } else if (key === 'sleep') {
        result = await this._sleepInBed();
      } else if (key === 'recover_loot') {
        result = await this._recoverLoot();
      } else if (key.startsWith('attack_')) {
        result = await this._combat(key.slice('attack_'.length));
      } else if (key === 'cast_rod') {
        result = await this._castRod();
      } else if (key === 'reel_in') {
        result = await this._reelIn();
      } else if (key === 'fish') {
        result = await this._fish();
      } else {
        result = { ok: false, error: 'unknown_action', reason: `unknown or invalid action ${key}` };
      }
    } catch (e) {
      result = { ok: false, error: e.message };
    } finally {
      this.busy = false;
    }
    const entry = { action: key, result, position: this.pos(), ms: Date.now() - started };
    this.recent.push(entry);
    if (this.recent.length > 8) this.recent.shift();
    this.log('action', entry);
    return result;
  }

  setPlan (plan) {
    this.plan = plan;
    this.log('plan', { plan });
  }

  // ---- raccolta drop -----------------------------------------------------------------

  _dropDistance (drop) {
    if (!this.position) return Infinity;
    return Math.hypot(drop.position.x - this.position.x, drop.position.y - this.position.y, drop.position.z - this.position.z);
  }

  _nearestDrop () {
    return this.drops
      .filter(drop => !drop.failedAt || Date.now() - drop.failedAt > 10000)
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
    this.log('recover_loot', { site: target, moved, recovered, left: !!left });
    const expGained = this.experienceLevel != null && levelBefore != null
      ? Math.max(0, this.experienceLevel - levelBefore) : null;
    return { ok: true, site: target, moved, recovered, leftNearby: !!left, expLevel: this.experienceLevel ?? null, expGained };
  }

  _dropStillThere (drop) {
    return this.drops.some(d => String(d.id) === String(drop.id) || (drop.runtime_id != null && String(d.runtime_id) === String(drop.runtime_id)));
  }

  // Auto-raccolta dei drop vicini, usata subito dopo mining/scavi: il drop cade
  // entro il raggio d'azione ma il pickup richiede di camminarci sopra.
  async _pickupNearby ({ maxDistance = 3.5, limit = 2, budgetMs = 6000 } = {}) {
    const deadline = Date.now() + Math.max(1500, budgetMs);
    const picked = [];
    for (let i = 0; i < limit && Date.now() < deadline; i++) {
      const drop = this.drops
        .map(entry => ({ ...entry, distance: this._dropDistance(entry) }))
        .filter(entry => entry.distance <= maxDistance && (!entry.failedAt || Date.now() - entry.failedAt > 10000))
        .sort((a, b) => a.distance - b.distance)[0];
      if (!drop) break;
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

  async _collectDrop (timeoutMs = 20000) {
    const deadline = Date.now() + Math.max(4000, timeoutMs);
    const inventoryBefore = { ...this.inventory };
    let moved = false;
    while (Date.now() < deadline) {
      const drop = this._nearestDrop();
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
    const failed = this._nearestDrop();
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
      if (windowId === 'hotbar') return slot;
      if (windowId === 'inventory' || windowId === 0 || windowId === 2) return slot;
    }
    return null;
  }

  _sendStackRequest (actions, { outputs = false, timeoutMs = 4000 } = {}) {
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
        this.client?.off('item_stack_response', onResponse);
        if (error) reject(error); else resolve(response);
      };
      const onResponse = packet => {
        const response = packet.responses?.find(r => r.request_id === requestId);
        if (response) finish(null, response);
      };
      const timer = setTimeout(() => finish(new Error('stack_request_timeout')), timeoutMs);
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

  _waitForContainerOpen (predicate, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve: packet => { clearTimeout(timer); resolve(packet); } };
      const timer = setTimeout(() => {
        this._containerWaiters = this._containerWaiters.filter(w => w !== waiter);
        reject(new Error('container_open_timeout'));
      }, timeoutMs);
      this._containerWaiters.push(waiter);
    });
  }

  async _ensureInventoryOpen () {
    if (this._openContainer?.type === 'inventory') return;
    if (this._openContainer) await this._closeContainer();
    const wait = this._waitForContainerOpen(p => p.window_type === 'inventory', 3000);
    this.client.write('interact', { action_id: 'open_inventory', target_entity_id: this.client.entityId, has_position: false });
    await wait;
    await delay(200); // lascia arrivare inventory_content con lo stato della griglia
  }

  async _closeContainer () {
    const open = this._openContainer;
    if (!open || !this.client) return;
    const wasTrading = open.type === 'trading' || open.type === 15;
    this.client.write('container_close', { window_id: open.id, window_type: 'none', server: false });
    this._openContainer = null;
    this._openContainerBlock = null;
    this._openContainerSlots = [];
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

  _hasMaterials (recipe) {
    if (!recipe.output?.length) return false;
    const grid = this._planGrid(recipe, (recipe.width || 1) > 2 || (recipe.height || 1) > 2);
    const available = this.inventorySlots.map(s => s ? { name: this._slotItemName(s), count: s.count } : null);
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

  async _takeToCursor (slotIndex, count) {
    const item = this.inventorySlots[slotIndex];
    if (!item?.network_id) throw new Error('missing_ingredients');
    const info = this._invSlotAsSource(slotIndex);
    this.log('take_request', { slotIndex, name: this._slotItemName(item), count, stack_id: item.stack_id ?? null, has_stack_id: item.has_stack_id ?? null });
    const response = await this._sendStackRequest([{
      type_id: 'take', legacy_type_id: 0, count,
      source: this._slotInfo(info.container, info.slot, item.stack_id || 0),
      destination: this._slotInfo('cursor', 0, 0),
    }]);
    if (String(response.status) !== 'ok' && response.status !== 0) throw new Error(`take_failed_${response.status}`);
    this._applyStackResponse(response);
    this._cursor = { network_id: item.network_id, count, stack_id: this._responseSlotStack(response, 'cursor', 0) ?? 0 };
    return this._cursor.stack_id;
  }

  async _placeFromCursor (gridSlot, count, cursorStack) {
    const response = await this._sendStackRequest([{
      type_id: 'place', legacy_type_id: 1, count,
      source: this._slotInfo('cursor', 0, cursorStack),
      destination: this._slotInfo('crafting_input', gridSlot, this._craftingGrid.get(gridSlot)?.stack_id || 0),
    }]);
    if (String(response.status) !== 'ok' && response.status !== 0) throw new Error(`place_failed_${response.status}`);
    this._applyStackResponse(response);
    return this._responseSlotStack(response, 'crafting_input', gridSlot) ?? 0;
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
        const cursorStack = await this._takeToCursor(source, 1);
        gridStackIds.set(gridSlot, await this._placeFromCursor(gridSlot, 1, cursorStack));
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

  async _ensureCraftingTableOpen () {
    if (this._openContainer?.type === 'workbench') return;
    if (this._openContainer) await this._closeContainer();
    const table = this.world.findBlocks('crafting_table', this.position, 32, 1)[0];
    if (!table) throw new Error('crafting_table_not_found');
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

  _offerDescription (offer, index) {
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
    // Chiudi un commercio/container precedente prima di aprirne un altro.
    if (this._openContainer) await this._closeContainer().catch(() => {});
    this.tradeOffers = [];
    this.tradeOpenedAt = 0;
    this.tradeTarget = { type: entity.type, runtimeId: entity.runtimeId, position: entity.position };
    if (this._entityDistance({ ...entity, type: entity.type }) > 4.5) {
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
    for (let attempt = 1; attempt <= 3 && !this.tradeOffers.length; attempt++) {
      const look = this._lookAt({ x: live.position.x, y: live.position.y + entityHeight(live.type) * 0.5, z: live.position.z });
      await this._queueAuthInput({ yaw: look.yaw, pitch: look.pitch });
      await delay(120);
      const current = this.entities.get(entity.runtimeId);
      if (!current) continue;
      this._interactEntity(current);
      const waitUntil = Date.now() + confirmMs;
      while (Date.now() < waitUntil && !this.tradeOffers.length) await delay(100);
    }
    if (!this.tradeOffers.length) return { ok: false, error: 'trade_not_opened', hint: 'villager busy, obstructed or not a trader' };
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
      let result = await this._waitTradeResult();
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
    const candidates = this._nearbyTraders(12).filter(t => t.type !== 'wandering_trader');
    if (!candidates.length) return { ok: false, error: 'no_trader_nearby', profession: wanted };
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

  _findNearbyStorageBlocks (radius = 32) {
    if (!this.position || !this.world?.findBlocks) return [];
    const found = [];
    for (const name of STORAGE_BLOCKS) {
      found.push(...this.world.findBlocks(name, this.position, radius, 6));
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

  async _ensureStorageOpen (target) {
    const alreadyOpen = this._openContainer?.type === 'container' && this._openContainerBlock
      && this._openContainerBlock.position.x === target.position.x
      && this._openContainerBlock.position.y === target.position.y
      && this._openContainerBlock.position.z === target.position.z;
    if (alreadyOpen) return;
    if (this._openContainer) await this._closeContainer();
    if ((target.distance ?? this._pointDistance(target.position)) > 3.5) {
      await this._moveTo({ x: target.position.x + 0.5, y: target.position.y, z: target.position.z + 0.5 }, 3, 30000);
    }
    await delay(100);
    let lastError = null;
    for (let attempt = 1; attempt <= 3 && this._openContainer?.type !== 'container'; attempt++) {
      const wait = this._waitForContainerOpen(p => p.window_type === 'container', 2500);
      const yaw = this._yawTo(this._feet, { x: target.position.x + 0.5, z: target.position.z + 0.5 });
      const pitch = this._lookAt({ x: target.position.x + 0.5, y: target.position.y + 0.5, z: target.position.z + 0.5 }).pitch;
      await this._queueAuthInput({ yaw, pitch, transaction: this._blockUseTransaction(target.position) });
      try {
        await wait;
      } catch (error) {
        lastError = error;
        if (this._openContainer?.type === 'container') break;
        await delay(300);
      }
    }
    if (this._openContainer?.type !== 'container') throw lastError || new Error(`${target.name}_not_opened`);
    this._openContainerBlock = { name: target.name, position: target.position };
    await delay(200); // lascia arrivare inventory_content con le slot del container
  }

  async _readContainers () {
    const blocks = this._findNearbyStorageBlocks();
    if (!blocks.length) return { ok: false, error: 'container_not_found' };
    const started = Date.now();
    const read = [];
    for (const block of blocks) {
      try {
        await this._ensureStorageOpen(block);
        const contents = this._storageContentsFromSlots(this._openContainerSlots);
        const key = this._containerCacheKey(block.position);
        this.containers.set(key, { type: block.name, position: block.position, readAt: Date.now(), contents });
        read.push({ position: block.position, type: block.name, contents });
      } catch (error) {
        this.log('container_read_failed', { block: block.name, position: block.position, error: error.message });
      } finally {
        await this._closeContainer().catch(() => {});
      }
    }
    if (!read.length) return { ok: false, error: 'container_read_failed' };
    return { ok: true, read: read.length, containers: read, ms: Date.now() - started };
  }

  async _takeFromContainer (itemName) {
    const entry = this._cachedContainers().find(c => (c.contents[itemName] || 0) > 0);
    if (!entry) return { ok: false, error: 'item_not_in_container' };
    const before = this.inventory[itemName] || 0;
    const started = Date.now();
    try {
      await this._ensureStorageOpen(entry);
      const slots = this._openContainerSlots || [];
      const slotIndex = slots.findIndex(s => this._slotItemName(s) === itemName && (s.count || 0) > 0);
      if (slotIndex < 0) {
        // La cache diceva di averlo ma il contenuto reale è cambiato: riallinea.
        this._setContainerContents(entry, this._storageContentsFromSlots(slots));
        return { ok: false, error: 'item_not_in_container' };
      }
      const slot = slots[slotIndex];
      const count = slot.count || 1;
      const slotType = this._storageContainerSlotType(entry.type);
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
      return { ok: true, item: itemName, count, from: entry.type, position: entry.position, inventoryDelta: after - before, ms: Date.now() - started };
    } catch (error) {
      return { ok: false, error: error.message };
    } finally {
      await this._returnCursorToInventory().catch(() => {});
      await this._closeContainer().catch(() => {});
      this._refreshInventory();
    }
  }

  async _depositItem (itemName) {
    const cached = this._cachedContainers();
    let target = cached[0];
    if (!target) {
      const block = this._findNearbyStorageBlocks()[0];
      if (!block) return { ok: false, error: 'container_not_found' };
      target = { key: this._containerCacheKey(block.position), type: block.name, position: block.position, contents: {} };
    }
    const index = this.inventorySlots.findIndex(s => this._slotItemName(s) === itemName && (s.count || 0) > 0);
    if (index < 0) return { ok: false, error: 'missing_item' };
    const before = this.inventory[itemName] || 0;
    const started = Date.now();
    try {
      await this._ensureStorageOpen(target);
      const slots = this._openContainerSlots || [];
      const slotType = this._storageContainerSlotType(target.type);
      const stackSize = this._itemStackSize(this.inventorySlots[index].network_id);
      // Destinazione: uno slot già occupato dallo stesso item (se c'è spazio) oppure il primo vuoto.
      let destSlot = slots.findIndex(s => this._slotItemName(s) === itemName && (s.count || 0) < stackSize);
      if (destSlot < 0) destSlot = slots.findIndex(s => !s?.network_id);
      if (destSlot < 0) throw new Error('container_full');
      const source = this.inventorySlots[index];
      const count = Math.min(source.count || 0, stackSize);
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
      // Base sul contenuto reale letto dal server (non sulla cache, che può essere stantia).
      const contents = this._storageContentsFromSlots(this._openContainerSlots);
      contents[itemName] = (contents[itemName] || 0) + count;
      this.containers.set(target.key, { type: target.type, position: target.position, readAt: Date.now(), contents });
      const after = this.inventory[itemName] || 0;
      this.log('container_deposit', { block: target.type, position: target.position, item: itemName, count, inventoryDelta: after - before });
      return { ok: true, item: itemName, count, into: target.type, position: target.position, inventoryDelta: after - before, ms: Date.now() - started };
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
    // Una riconnessione riporta l'inventory_content completo dal server.
    const syncable = /^(missing_ingredients|take_failed_(49|50)|place_failed_(49|50))$/.test(String(first.error));
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

  async _resyncByReconnect () {
    if (!this.client || !this.spawned) throw new Error('not_connected');
    this.log('inventory_resync', { reason: 'slot ids stale after pickups; reconnecting for fresh inventory_content' });
    await this.disconnect('inventory resync');
    await this.connect();
    this.log('inventory_resync_done', { trackedSlots: this.inventorySlots.filter(s => s?.network_id).length });
  }

  async _craftAttempt (itemName, candidates) {
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
          this.log('craft_failed_detail', { detail: JSON.stringify({
            item: itemName, network_id: recipe.network_id, width: recipe.width, height: recipe.height,
            input: (recipe.input || []).map(i => i.type === 'valid' ? (i.descriptor_type === 'item_tag' ? `tag:${i.tag}` : `name:${i.name}`) : null),
            grid: [...this._craftingGrid.entries()].map(([slot, entry]) => ({ slot, name: this.world.registry?.items[entry.network_id]?.name || entry.network_id, count: entry.count })),
            status,
          }) });
          return { ok: false, error: 'craft_failed', status };
        }
        this._applyStackResponse(response, { networkId: result.network_id });
        return { ok: true, crafted: itemName, count: result.count || 1 };
      } catch (error) {
        return { ok: false, error: error.message };
      } finally {
        await this._clearCraftingGrid().catch(() => {});
        await this._returnCursorToInventory().catch(() => {});
        await this._closeContainer().catch(() => {});
      }
    }
    return { ok: false, error: 'missing_ingredients' };
  }

  // ---- piazzamento blocchi -----------------------------------------------------------

  _selectHotbarSlot (index) {
    const item = this.inventorySlots[index];
    if (!item?.network_id) return false;
    this.client.write('mob_equipment', {
      runtime_entity_id: this.client.entityId, item,
      slot: index, selected_slot: index, window_id: 'inventory',
    });
    this.selectedHotbar = index;
    return true;
  }

  _findPlacementTarget (blockName) {
    const feet = this._feet;
    const bx = Math.floor(feet.x), by = Math.floor(feet.y + 0.1), bz = Math.floor(feet.z);
    const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    for (const [dx, dz] of dirs) {
      const target = { x: bx + dx, y: by, z: bz + dz };
      const support = { x: target.x, y: target.y - 1, z: target.z };
      if (this._solidAt(target.x, target.y, target.z)) continue;
      if (!this._solidAt(support.x, support.y, support.z)) continue;
      return { target, support, face: 1, clickPos: { x: 0.5, y: 1, z: 0.5 }, blockName };
    }
    return null;
  }

  async _placeBlock (itemName, blockName) {
    let slotIndex = this.inventorySlots.findIndex(s => this._slotItemName(s) === itemName && s.count > 0);
    if (slotIndex < 0) {
      // Un item appena raccolto può non essere ancora nella copia locale: la
      // riconnessione forza un inventory_content completo dal server.
      try { await this._resyncByReconnect(); } catch (error) { this.log('inventory_resync_failed', { message: error.message }); }
      slotIndex = this.inventorySlots.findIndex(s => this._slotItemName(s) === itemName && s.count > 0);
      if (slotIndex < 0) return { ok: false, error: 'missing_item' };
    }
    if (slotIndex > 8) {
      try { slotIndex = await this._moveSlotToHotbar(slotIndex); }
      catch (error) { return { ok: false, error: error.message }; }
    }

    const spot = this._findPlacementTarget(blockName);
    if (!spot) return { ok: false, error: 'no_place_spot' };
    if (this._openContainer) await this._closeContainer();
    this._selectHotbarSlot(slotIndex);
    const held = this.inventorySlots[slotIndex];
    const runtimeId = this.world.runtimeIdAt(spot.support);
    const yaw = this._yawTo(this._feet, { x: spot.target.x + 0.5, z: spot.target.z + 0.5 });
    await this._queueAuthInput({
      yaw,
      pitch: this._lookAt({ x: spot.target.x + 0.5, y: spot.target.y + 0.5, z: spot.target.z + 0.5 }).pitch,
      transaction: {
        legacy: { legacy_request_id: 0 },
        actions: [],
        data: {
          action_type: 'click_block',
          trigger_type: 'player_input',
          block_position: spot.support,
          face: spot.face,
          hotbar_slot: this.selectedHotbar,
          hand: 'main_hand',
          held_item: held,
          player_pos: { ...this.position },
          click_pos: spot.clickPos,
          block_runtime_id: runtimeId >>> 0,
          client_prediction: 'success',
          client_cooldown_state: 'off',
        },
      },
    });
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      const placed = this.world.blockAt(spot.target);
      if (placed && placed.name === blockName) {
        this._refreshNearby();
        return { ok: true, block: blockName, position: spot.target };
      }
      if (placed && placed.name !== 'air' && placed.name !== 'unknown') {
        return { ok: false, error: `unexpected_block_${placed.name}` };
      }
      await delay(100);
    }
    return { ok: false, error: 'place_not_confirmed' };
  }

  // ---- mining ------------------------------------------------------------------------

  // ---- scelta dell'utensile e del bersaglio di scavo ---------------------------------

  _blockInReach (candidate) {
    if (!this.position || !candidate?.position) return false;
    const p = candidate.position;
    return Math.hypot(this.position.x - (p.x + 0.5), this.position.y - (p.y + 0.5), this.position.z - (p.z + 0.5)) <= 5.1;
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

  // Sceglie il candidato più vicino già a portata oppure, se nessuno lo è, il
  // primo con una faccia scoperta: un blocco sepolto non è minabile senza scavare.
  _pickMineTarget (blocks) {
    const candidates = (blocks || []).filter(b => b?.diggable);
    if (!candidates.length) return null;
    return candidates.find(b => this._blockInReach(b)) || candidates.find(b => this._blockExposed(b)) || null;
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
      // successivo fallirebbe con 50. Riprova a rimetterlo nella sorgente.
      await this._sendStackRequest([{
        type_id: 'place', legacy_type_id: 1, count,
        source: this._slotInfo('cursor', 0, cursorStack),
        destination: this._slotInfo('hotbar_and_inventory', srcIndex, 0),
      }]).catch(() => {});
      this._cursor = null;
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
      if (free < 0) throw new Error('hotbar_full');
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
    // Utensile giusto in mano: senza il piccone la pietra non lascia cadere cobblestone.
    await this._selectToolFor(blockData);


    // Approach only outside survival mining reach, measured from the eyes.
    const dist = Math.hypot(this.position.x - (pos.x + 0.5),
      this.position.y - (pos.y + 0.5), this.position.z - (pos.z + 0.5));
    if (dist > 5.1) {
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
      await this._moveTo(approach, 0.4, timeoutMs);
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
          return { ok: true, block: block.name, position: pos, confirmedBy: 'server_world',
            destroyedEvent, tool: this.world.registry?.items[held.network_id]?.name || null, ms: Date.now() - started, picked };
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
      if (!block.diggable || !(block.hardness >= 0)) return { error: `not_diggable_${label}` };
      targets.push({ cell, block, label });
    }
    // Nessun blocco da scavare (gradino già aperto: discesa interrotta o scalino
    // naturale): resta valida la sola discesa, con lo stesso controllo di appoggio.
    const supportBlock = this.world.blockAt(support);
    if (!supportBlock || !this._solidAt(support.x, support.y, support.z)) return { error: 'no_support_ahead' };
    return { direction: d, front, head, step, support, targets };
  }

  async _digDown (timeoutMs = 30000) {
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
    this._driveMotion(tick);
    const use = this._motion?.active ? this._motion.useRequest : null;
    let yaw = this._motion?.active ? this._motion.yaw : this._lastYaw;
    if (this.riding && this._ridingForward) yaw = this._ridingYaw;
    let pitch = this._lastPitch;
    let transaction = null;
    if (use && !use.sent && !this._openDoors.has(use.key)) {
      const look = this._lookAt({ x: use.pos.x + 0.5, y: use.pos.y + 0.5, z: use.pos.z + 0.5 });
      yaw = look.yaw;
      pitch = look.pitch;
      this._lastYaw = yaw;
      this._lastPitch = pitch;
      transaction = this._blockUseTransaction(use.pos);
      use.sent = true;
      use.at = Date.now();
      // Il server risponde con update_block sulla cella della porta: osserva il cambio.
      for (const y of [use.pos.y, use.pos.y + (this._isDoorBlock(this.world.blockAt({ x: use.pos.x, y: use.pos.y - 1, z: use.pos.z })) ? -1 : 1)]) {
        const key = `${use.pos.x},${y},${use.pos.z}`;
        const runtimeId = this.world.runtimeIdAt({ x: use.pos.x, y, z: use.pos.z });
        if (runtimeId != null && !this._doorWatchers.has(key)) this._doorWatchers.set(key, runtimeId);
      }
    }
    try {
      this._sendAuthInput({ yaw, pitch, tick, transaction });
    } catch (error) {
      this.log('auth_input_error', { message: error.message });
    }
    this._survivalTick();
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
    if (!this.client) return Promise.reject(new Error('connection_lost'));
    if (!this._authTickInterval) { this._sendAuthInput(input); return Promise.resolve(); }
    return new Promise((resolve, reject) => this._authInputQueue.push({ input, resolve, reject }));
  }

  _sendAuthInput ({ yaw = 0, pitch = 0, moveVector = null, blockAction = null,
    transaction = null, itemStackRequest = null, tick = null } = {}) {
    if (!this.client) return;
    this.tick = tick != null ? tick : this._advanceTick();
    const position = { ...this.position };
    const inputData = ['block_breaking_delay_enabled'];
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
    } else if (!moveVector && motion?.active) {
      if (motion.forward) { move = { x: 0, z: 1 }; inputData.push('up'); }
      if (motion.jumpHeldTicks > 0) {
        inputData.push('jumping', 'want_up');
        if (motion.jumpStart) { inputData.push('start_jumping'); motion.jumpStart = false; }
      }
      if (this._collidedHorizontally) inputData.push('horizontal_collision');
      if (this._onGround) inputData.push('vertical_collision');
    }
    if (blockAction?.length) inputData.push('block_action');
    if (transaction) inputData.push('item_interact');
    if (itemStackRequest) inputData.push('item_stack_request');
    const yawRad = yaw * Math.PI / 180, pitchRad = pitch * Math.PI / 180;
    this.client.write('player_auth_input', {
      pitch,
      yaw,
      position,
      move_vector: move,
      head_yaw: yaw,
      input_data: inputData,
      input_mode: 'mouse',
      play_mode: 'screen',
      interaction_model: 'touch',
      interact_rotation: { x: pitch, z: yaw },
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

  _syncFeetFromPosition (position = this.position) {
    if (!position) return;
    this._feet = { x: position.x, y: position.y - EYE_HEIGHT, z: position.z };
  }

  _syncPositionFromFeet () {
    if (!this._feet) return;
    this.position = { x: this._feet.x, y: this._feet.y + EYE_HEIGHT, z: this._feet.z };
  }

  // ---- fisica locale ---------------------------------------------------------------

  _isDoorBlock (block) {
    return !!block && typeof block.name === 'string' && block.name.endsWith('_door');
  }

  _doorKey (position) {
    return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
  }

  _onBlockUpdate (position, runtimeId) {
    if (runtimeId == null) return;
    const key = this._doorKey(position);
    const closed = this._doorWatchers.get(key);
    if (closed != null && runtimeId !== closed) {
      this._openDoors.add(key);
      this._doorWatchers.delete(key);
      this.log('door_opened', { key });
    }
  }

  _solidAt (x, y, z) {
    if (this._openDoors.has(`${x},${y},${z}`)) return false;
    const block = this.world.blockAt({ x, y, z });
    if (!block || block.name === 'unknown') return true; // non caricato o ignoto: conservativo
    return block.boundingBox === 'block';
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

  // Per il pathfinding una porta chiusa è percorribile: il movimento la apre
  // con un'interazione click_block quando la incontra.
  _passableForPath (block) {
    return this._passable(block) || this._isDoorBlock(block);
  }

  _standable (x, y, z) {
    if (!this._passableForPath(this.world.blockAt({ x, y, z }))) return false;
    if (!this._passableForPath(this.world.blockAt({ x, y: y + 1, z }))) return false;
    const below = this.world.blockAt({ x, y: y - 1, z });
    // Anche un hash non risolto sotto i piedi vale come piano d'appoggio.
    return !!below && (below.boundingBox === 'block' || below.name === 'unknown');
  }

  _collides (x, y, z) {
    const eps = 1e-9;
    const minX = Math.floor(x - PLAYER_HALF_WIDTH + eps), maxX = Math.floor(x + PLAYER_HALF_WIDTH - eps);
    const minY = Math.floor(y + eps), maxY = Math.floor(y + PLAYER_HEIGHT - eps);
    const minZ = Math.floor(z - PLAYER_HALF_WIDTH + eps), maxZ = Math.floor(z + PLAYER_HALF_WIDTH - eps);
    for (let bx = minX; bx <= maxX; bx++) {
      for (let by = minY; by <= maxY; by++) {
        for (let bz = minZ; bz <= maxZ; bz++) {
          if (this._solidAt(bx, by, bz)) return true;
        }
      }
    }
    return false;
  }

  _moveHorizontal (dx, dz) {
    const feet = this._feet;
    const motion = this._motion;
    this._collidedHorizontally = false;
    for (const [ax, az] of [[dx, 0], [0, dz]]) {
      if (!ax && !az) continue;
      const nx = feet.x + ax, nz = feet.z + az;
      if (!this._collides(nx, feet.y, nz)) {
        feet.x = nx;
        feet.z = nz;
        continue;
      }
      this._collidedHorizontally = true;
      // Gradino di un blocco: prepara un salto se lo spazio sopra è libero.
      if (this._onGround && !this._collides(nx, feet.y + 1, nz) && motion?.active && motion.jumpHeldTicks <= 0) {
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
        const floorTop = Math.floor(ny) + 1;
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
    const motion = this._motion;
    if (motion?.active && motion.jumpHeldTicks > 0) motion.jumpHeldTicks--;
    if (motion?.active && motion.jumpQueued && this._onGround) {
      // La gravità viene applicata nello stesso tick: compensa l'impulso così
      // che il primo spostamento verticale sia il salto pieno (apice ~1.3 blocchi).
      this._velocity.y = JUMP_VELOCITY + GRAVITY;
      this._onGround = false;
      motion.jumpQueued = false;
    }
    const beforeX = this._feet.x, beforeZ = this._feet.z;
    if (motion?.active && motion.forward) {
      const yawRad = motion.yaw * Math.PI / 180;
      this._moveHorizontal(-Math.sin(yawRad) * WALK_SPEED, Math.cos(yawRad) * WALK_SPEED);
    }
    this._velocity.x = this._feet.x - beforeX;
    this._velocity.z = this._feet.z - beforeZ;
    this._velocity.y = Math.max(this._velocity.y - GRAVITY, -1.2);
    this._moveVertical(this._velocity.y);
    this._syncPositionFromFeet();
  }

  _driveMotion (tick) {
    let steps = this._lastSimTick == null ? 1 : Number(tick - this._lastSimTick);
    if (!(steps >= 0)) steps = 0;
    if (steps > MAX_SIM_STEPS) steps = MAX_SIM_STEPS;
    for (let i = 0; i < steps; i++) this._physicsStep();
    this._lastSimTick = tick;
    if (this._motion?.active) this._updateMotionState();
  }

  // ---- percorso e stato del movimento ------------------------------------------------

  _startMotion (path, goalNode, target, stopDistance, deadline) {
    return new Promise(resolve => {
      this._motion = {
        active: true, path, index: Math.min(1, path.length - 1), goalNode,
        target, stopDistance, deadline, resolve,
        yaw: this._yawTo(this._feet, { x: goalNode.x + 0.5, z: goalNode.z + 0.5 }),
        forward: true, jumpQueued: false, jumpHeldTicks: 0, jumpStart: false,
        bestWaypointDist: Infinity, lastProgressAt: Date.now(), stuckTries: 0,
        useRequest: null,
      };
    });
  }

  _stopMotion () {
    this._motion = null;
  }

  _finishMotion (reason) {
    const motion = this._motion;
    if (!motion) return;
    motion.active = false;
    motion.forward = false;
    const resolve = motion.resolve;
    motion.resolve = null;
    if (resolve) resolve(reason);
  }

  _updateMotionState () {
    const motion = this._motion;
    if (!motion?.active) return;
    if (Date.now() > motion.deadline) return this._finishMotion('timeout');
    const feet = this._feet;

    // Bersaglio richiesto raggiunto (in orizzontale, con tolleranza verticale).
    if (Math.hypot(feet.x - motion.target.x, feet.z - motion.target.z) <= motion.stopDistance &&
        Math.abs(feet.y - motion.target.y) < 3) {
      return this._finishMotion('goal');
    }

    let waypoint = motion.path[motion.index];
    if (!waypoint) return this._finishMotion('path_end');
    let wpHoriz = Math.hypot(feet.x - (waypoint.x + 0.5), feet.z - (waypoint.z + 0.5));
    if (wpHoriz < 0.4 && Math.abs(feet.y - waypoint.y) < 1.05) {
      motion.index++;
      motion.bestWaypointDist = Infinity;
      motion.lastProgressAt = Date.now();
      motion.stuckTries = 0;
      waypoint = motion.path[motion.index];
      if (!waypoint) return this._finishMotion('path_end');
      wpHoriz = Math.hypot(feet.x - (waypoint.x + 0.5), feet.z - (waypoint.z + 0.5));
    } else if (wpHoriz < motion.bestWaypointDist - 0.02) {
      motion.bestWaypointDist = wpHoriz;
      motion.lastProgressAt = Date.now();
    } else if (Date.now() - motion.lastProgressAt > 2500) {
      if (motion.stuckTries < 1) {
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
      return this._finishMotion('stuck');
    }
    // Salto preparatorio per i gradini in salita.
    if (this._onGround && waypoint.y > feet.y + 0.5 && wpHoriz < 2.4 && motion.jumpHeldTicks <= 0) {
      motion.jumpQueued = true;
      motion.jumpHeldTicks = 6;
      motion.jumpStart = true;
    }
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
    for (const y of [cy, cy + 1]) {
      const key = `${cx},${y},${cz}`;
      if (this._openDoors.has(key)) continue;
      if (this._isDoorBlock(this.world.blockAt({ x: cx, y, z: cz }))) return { x: cx, y, z: cz };
    }
    return null;
  }

  // ---- pathfinding A* sul mondo caricato ---------------------------------------------

  _startNode () {
    const x = Math.floor(this._feet.x), z = Math.floor(this._feet.z);
    const y = Math.floor(this._feet.y + 1e-3);
    if (this._standable(x, y, z)) return { x, y, z };
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

  _findGoalNodes (target) {
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
    return candidates.slice(0, 8).map(({ x, y, z }) => ({ x, y, z }));
  }

  _findGoalNode (target) {
    return this._findGoalNodes(target)[0] ?? null;
  }

  *_neighbors ({ x, y, z }) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (this._standable(nx, y, nz)) yield { x: nx, y, z: nz, cost: 1 };
      if (this._standable(nx, y + 1, nz)) yield { x: nx, y: y + 1, z: nz, cost: 1.4 };
      if (this._standable(nx, y - 1, nz)) yield { x: nx, y: y - 1, z: nz, cost: 1.2 };
      // Caduta oltre un gradino, fino a 4 blocchi.
      if (y > 1 && this._passable(this.world.blockAt({ x: nx, y, z: nz })) &&
          this._passable(this.world.blockAt({ x: nx, y: y + 1, z: nz }))) {
        for (let ny = y - 2; ny >= y - 5; ny--) {
          if (!this._passable(this.world.blockAt({ x: nx, y: ny + 1, z: nz }))) break;
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

  _findPath (start, goal) {
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
    while (open.length && expanded < PATH_MAX_NODES) {
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

  async _moveTo (target, stopDistance = 1.5, timeoutMs = 30000) {
    if (!this.position || !this._feet) throw new Error('no position');
    if (!this._authTickInterval) throw new Error('movement unavailable before spawn');
    const deadline = Date.now() + timeoutMs;
    const stop = Math.max(0.35, stopDistance);
    let attempts = 0;
    let lastFeet = null;
    while (Date.now() < deadline) {
      const start = this._startNode();
      const candidates = this._findGoalNodes(target);
      if (!candidates.length) throw new Error('target_not_found');
      let chosen = null;
      let bestPartial = null;
      for (const goal of candidates) {
        const path = this._findPath(start, goal);
        if (!path || !path.length) continue;
        const end = path.at(-1);
        if (end.x === goal.x && end.y === goal.y && end.z === goal.z) { chosen = { goal, path }; break; }
        // Percorso parziale: conserva il più lungo come ripiego (sezioni non ancora caricate).
        if (!bestPartial || path.length > bestPartial.path.length) bestPartial = { goal, path };
      }
      if (!chosen) chosen = bestPartial;
      if (!chosen) throw new Error('path_failed');
      const { goal, path } = chosen;
      const outcome = await this._startMotion(path, goal, { ...target }, stop, deadline);
      this._stopMotion();
      if (outcome === 'goal') {
        const distance = Math.hypot(this.position.x - target.x, this.position.y - target.y, this.position.z - target.z);
        return { ok: true, distance: +distance.toFixed(2), pathNodes: path.length };
      }
      if (outcome === 'timeout') throw new Error('movement timeout');
      const feet = this._feet;
      const moved = lastFeet ? Math.hypot(feet.x - lastFeet.x, feet.z - lastFeet.z) : Infinity;
      if (moved < 0.3) {
        attempts++;
        if (attempts >= 3) throw new Error(outcome === 'stuck' ? 'stuck' : 'path_failed');
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
      stalls = 0;
      last = entity.position;
      const d = Math.hypot(last.x - this.position.x, last.z - this.position.z);
      if (d <= distance) return { ok: true, followed: name, distance: +d.toFixed(1) };
      try {
        await this._moveTo({ x: last.x, y: last.y, z: last.z }, distance, Math.min(12000, Math.max(3000, d * 600)));
      } catch (error) {
        if (++stalls >= 4) return { ok: false, error: `follow_failed: ${error.message}`, target: name };
      }
    }
    return { ok: true, followed: name, distance: last ? +Math.hypot(last.x - this.position.x, last.z - this.position.z).toFixed(1) : null, note: 'follow window elapsed' };
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
    if (type !== 'chat' && type !== 'whisper' && type !== 'json_whisper') return;
    const from = packet.source_name || null;
    if (from && USERNAME && from.toLowerCase() === USERNAME.toLowerCase()) return;
    const entry = { from, message, type, xuid: packet.xuid != null ? String(packet.xuid) : null, at: Date.now() };
    this.chatInbox.push(entry);
    if (this.chatInbox.length > 32) this.chatInbox.shift();
    this.log('chat', { from, type, xuid: entry.xuid, message: message.slice(0, 160) });
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
      entity.username = packet.username;
      this._playersByName.set(String(packet.username).toLowerCase(), runtimeId);
    }
    if (packet.unique_id != null) {
      entity.uniqueId = String(packet.unique_id);
      this._entitiesByUnique.set(entity.uniqueId, runtimeId);
    }
    if (packet.position) {
      const y = kind === 'player' ? packet.position.y - EYE_HEIGHT : packet.position.y;
      entity.position = { x: packet.position.x, y, z: packet.position.z };
    }
    if (Array.isArray(packet.attributes)) {
      for (const attr of packet.attributes) {
        if (attr.name === 'minecraft:health') entity.health = attr.current ?? attr.value;
      }
    }
    if (kind === 'player' || isHostileType(type)) {
      this.log('entity_add', { runtimeId, type, kind, position: entity.position });
    }
  }

  _onEntityMove (packet) {
    const runtimeId = String(packet.runtime_entity_id ?? '');
    const entity = this.entities.get(runtimeId);
    if (!entity || !entity.position) return;
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
    entity.lastAt = Date.now();
  }

  _onEntityRemove (packet) {
    const id = String(packet.entity_id_self ?? '');
    const runtimeId = this._entitiesByUnique.get(id) || (this.entities.has(id) ? id : null);
    if (!runtimeId) return;
    const entity = this.entities.get(runtimeId);
    if (entity?.uniqueId) this._entitiesByUnique.delete(entity.uniqueId);
    this.entities.delete(runtimeId);
  }

  _applyEntityMetadata (packet) {
    const runtimeId = String(packet.runtime_entity_id ?? '');
    const isSelf = this.client && String(this.client.entityId) === runtimeId;
    const entity = this.entities.get(runtimeId);
    if (!isSelf && !entity) return;
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
      if (key === 'flags' && isSelf) {
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
      // non indica lo stato sonno, che resta affidato al flag `resting`.
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

  _onEntityEvent (packet) {
    const runtimeId = String(packet.runtime_entity_id ?? '');
    const entity = this.entities.get(runtimeId);
    if (!entity) return;
    if (packet.event_id === 'death_animation' || packet.event_id === 3) {
      entity.health = 0;
      entity.deadAt = Date.now();
      this.log('entity_death', { type: entity.type, runtimeId });
    }
  }

  _onOwnHealth () {
    if (this.health <= 0 && !this.dead) {
      this.dead = true;
      this.deaths++;
      this._respawnAt = Date.now() + 1500;
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
      this.log('death', { deaths: this.deaths, position: this.pos(), site: this.deathSite?.position ?? null });
    } else if (this.health > 0 && this.dead) {
      this.dead = false;
      this._respawnAt = 0;
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
    return { ticks, phase: timePhase(ticks), night: isNightTime(ticks) };
  }

  _isNight () {
    return !!this._timeInfo()?.night;
  }

  _setSleeping (sleeping) {
    if (this.sleeping === sleeping) return;
    this.sleeping = sleeping;
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
    if (!name) return null;
    const runtimeId = this._playersByName.get(String(name).toLowerCase());
    return runtimeId ? (this.entities.get(runtimeId) || null) : null;
  }

  _pruneEntities () {
    if (!this.entities.size) return;
    const now = Date.now();
    for (const [runtimeId, entity] of this.entities) {
      const stale = now - entity.lastAt > 60000;
      const far = entity.position && this.position && this._entityDistance(entity) > 64;
      if (stale || far) {
        this.entities.delete(runtimeId);
        if (entity.uniqueId) this._entitiesByUnique.delete(entity.uniqueId);
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
    const hostile = this._hostiles().find(e => e.type === wanted);
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
    const centerY = entity.position.y + entityHeight(entity.type) * 0.5;
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

  // Insegue e colpisce il mob più vicino del tipo richiesto finché non muore o
  // scade il tempo. Un'azione del controller può quindi coprire l'intero scontro.
  async _combat (type, timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    let hits = 0;
    let weapon = null;
    let approachFailures = 0;
    while (Date.now() < deadline) {
      if (this.dead) return { ok: false, error: 'died_in_combat', hits };
      const target = this._entityOfType(type);
      if (!target) {
        return hits > 0 ? { ok: true, killed: true, hits, weapon } : { ok: false, error: 'target_gone', hits };
      }
      if (target.health != null && target.health <= 0) return { ok: true, killed: true, hits, weapon };
      if (target.distance > 3.4) {
        try {
          await this._moveTo(target.position, 2.0, Math.min(8000, Math.max(1000, deadline - Date.now())));
        } catch (error) {
          approachFailures++;
          if (!this._entityOfType(type)) return hits > 0 ? { ok: true, killed: false, hits, detail: 'target_lost' } : { ok: false, error: 'target_lost', hits };
          if (approachFailures >= 3) return { ok: false, error: `cannot_reach_target: ${error.message}`, hits };
        }
        continue;
      }
      if (!weapon) weapon = await this._selectWeapon();
      const aim = this._lookAt({
        x: target.position.x,
        y: target.position.y + entityHeight(target.type) * 0.5,
        z: target.position.z,
      });
      await this._queueAuthInput({ yaw: aim.yaw, pitch: aim.pitch });
      await delay(120);
      const current = this._entityOfType(type);
      if (!current) return hits > 0 ? { ok: true, killed: true, hits, weapon } : { ok: false, error: 'target_lost', hits };
      this._attackEntity(current);
      hits++;
      const waitUntil = Math.min(deadline, Date.now() + 550);
      while (Date.now() < waitUntil) {
        const watched = this._entityOfType(type);
        if (!watched || (watched.health != null && watched.health <= 0)) return { ok: true, killed: true, hits, weapon };
        if (watched.distance > 4.5) break;
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

  _bestFoodItem () {
    return bestFood(this.inventory);
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
    const itemName = this._bestFoodItem();
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
  async _feedEntity (runtimeId, feed, timeoutMs = 8000) {
    if ((this.inventory[feed] || 0) < 1) return { ok: false, error: 'missing_feed', feed };
    let slotIndex = this.inventorySlots.findIndex(s => this._slotItemName(s) === feed && s.count > 0);
    if (slotIndex < 0) {
      try { await this._resyncByReconnect(); } catch (error) { this.log('inventory_resync_failed', { message: error.message }); }
      slotIndex = this.inventorySlots.findIndex(s => this._slotItemName(s) === feed && s.count > 0);
      if (slotIndex < 0) return { ok: false, error: 'missing_feed', feed };
    }
    if (slotIndex > 8) {
      try { slotIndex = await this._moveSlotToHotbar(slotIndex); }
      catch (error) { return { ok: false, error: `feed_equip_failed: ${error.message}` }; }
    }
    this._selectHotbarSlot(slotIndex);
    if (this._openContainer) await this._closeContainer();
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
    // Mano vuota: con del cibo in mano il click darebbe cibo, non monterebbe.
    const empty = this.inventorySlots.findIndex((s, i) => i < 9 && !s?.network_id);
    if (empty >= 0) this._selectHotbarSlot(empty);
    const live = this.entities.get(String(entity.runtimeId));
    if (!live) return;
    if (this._entityDistance(live) > 4.5) {
      try { await this._moveTo(live.position, 2.0, Math.min(20000, deadline - Date.now())); } catch (error) { this.log('mount_approach_failed', { message: error.message }); }
    }
    const current = this.entities.get(String(entity.runtimeId));
    if (!current) return;
    if (this._entityDistance(current) > 5) return;
    const look = this._lookAt({ x: current.position.x, y: current.position.y + entityHeight(current.type) * 0.5, z: current.position.z });
    await this._queueAuthInput({ yaw: look.yaw, pitch: look.pitch });
    await delay(120);
    this._interactEntity(current);
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

  // Monta il veicolo/cavalcabile più vicino del tipo richiesto: mano vuota e
  // item_use_on_entity `interact`; conferma dal link rider→veicolo (set_entity_link).
  async _mountVehicle (type, timeoutMs = 20000) {
    if (this.riding) return { ok: false, error: 'already_riding', ridden: this.riding.riddenEntityId };
    const wanted = normalizeEntityType(type);
    const target = this._nearbyRideable(64).find(e => e.type === wanted);
    if (!target) return { ok: false, error: 'no_rideable_nearby', type: wanted };
    const empty = this.inventorySlots.findIndex((s, i) => i < 9 && !s?.network_id);
    if (empty >= 0) this._selectHotbarSlot(empty);
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
    if (!this.riding) return { ok: false, error: 'mount_not_confirmed', type: wanted };
    return { ok: true, mounted: wanted, ridden: this.riding.riddenEntityId };
  }

  // Smonta: player_action start_sneak; il server risponde col link di rimozione.
  async _dismount (timeoutMs = 8000) {
    if (!this.riding) return { ok: true, alreadyDismounted: true };
    this._ridingForward = false;
    const deadline = Date.now() + timeoutMs;
    this.client.write('player_action', { runtime_entity_id: this.client.entityId, action: 'start_sneak' });
    while (Date.now() < deadline && this.riding) await delay(100);
    if (this.riding) return { ok: false, error: 'dismount_not_confirmed' };
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

  // Contesto pesca per /observe.
  _fishingContext () {
    if (!this.position) return null;
    const spot = this._findFishingSpot();
    return {
      available: !!spot,
      spot: spot ? { position: spot.position, waterAt: spot.waterAt, distance: spot.distance } : null,
      rod: (this.inventory.fishing_rod || 0) > 0,
      string: (this.inventory.string || 0) > 0,
      bobberOut: !!this._findBobber(),
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
          return { ok: true, bobber: { x: +bobber.position.x.toFixed(1), y: +bobber.position.y.toFixed(1), z: +bobber.position.z.toFixed(1) }, waterAt: spot.waterAt };
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

  // Pesca completa: lancia, attende il morso (bobber che affonda o finestra
  // temporale) e recupera. Un solo ciclo per invocazione.
  async _fish ({ castTimeoutMs = 8000, reelTimeoutMs = 4000 } = {}) {
    const cast = await this._castRod({ timeoutMs: castTimeoutMs });
    if (!cast.ok) return cast;
    const bobber = this._findBobber();
    const startY = bobber?.position?.y ?? null;
    const deadline = Date.now() + nextBiteDelay();
    let biteDetected = false;
    while (Date.now() < deadline) {
      const b = this._findBobber();
      if (!b) break; // bobber sparito: la lenza è rientrata da sola
      if (startY != null && b.position?.y != null && startY - b.position.y >= 0.2) {
        biteDetected = true;
        break;
      }
      await delay(100);
    }
    const reel = await this._reelIn({ timeoutMs: reelTimeoutMs });
    return { ...reel, biteDetected };
  }

  // Letto più vicino nel mondo caricato (scansione con TTL di 30 s).
  _findBed () {
    if (!this.position) return null;
    const now = Date.now();
    if (this._bedCache && now - this._bedCache.at < 30000) return this._bedCache.bed;
    let bed = null;
    const found = this.world.findBlocks('bed', this.position, 48, 4);
    if (found?.length) {
      const first = found[0];
      bed = { name: first.name, position: first.position, distance: +(first.distance ?? 0).toFixed(1) };
    }
    this._bedCache = { at: now, bed };
    return bed;
  }

  // Si avvicina al letto e ci clicca sopra finché il server non conferma il
  // sonno (flag resting nei metadata). Fallisce se è giorno o se ci sono mostri.
  async _sleepInBed ({ approachTimeoutMs = 25000, confirmMs = 3000 } = {}) {
    if (this.sleeping) return { ok: true, alreadySleeping: true };
    if (!this._isNight()) return { ok: false, error: 'not_night' };
    const bed = this._findBed();
    if (!bed) return { ok: false, error: 'no_bed' };
    const bedCenter = { x: bed.position.x + 0.5, y: bed.position.y, z: bed.position.z + 0.5 };
    if (this._pointDistance(bedCenter) > 4.5) {
      try {
        await this._moveTo(bedCenter, 1.8, approachTimeoutMs);
      } catch (error) {
        this.log('bed_approach_failed', { message: error.message, bed: bed.position });
      }
    }
    if (this._pointDistance(bedCenter) > 5) return { ok: false, error: 'bed_unreachable', bed: bed.position };
    const beforeTicks = this._timeInfo()?.ticks ?? null;
    for (let attempt = 1; attempt <= 3 && !this.sleeping; attempt++) {
      const look = this._lookAt({ x: bedCenter.x, y: bed.position.y + 0.5, z: bedCenter.z });
      await this._queueAuthInput({ yaw: look.yaw, pitch: look.pitch });
      await delay(120);
      await this._queueAuthInput({ yaw: look.yaw, pitch: look.pitch, transaction: this._blockUseTransaction(bed.position) });
      const waitUntil = Date.now() + confirmMs;
      while (Date.now() < waitUntil && !this.sleeping) {
        // Con un solo giocatore il server salta la notte quando il sonno è
        // accettato: un balzo in avanti dell'orologio è una conferma.
        const ticks = this._timeInfo()?.ticks;
        if (beforeTicks != null && ticks != null && ticks < beforeTicks && (beforeTicks - ticks) > 3000) {
          return { ok: true, slept: 'night_skipped', bed: bed.position };
        }
        await delay(100);
      }
    }
    if (this.sleeping) return { ok: true, slept: 'resting_flag', bed: bed.position };
    return { ok: false, error: 'sleep_rejected', bed: bed.position, hint: 'bed occupied, monsters nearby or the server clock says it is not night' };
  }

  // ---- risalita a gradini (uscita da buche/pozzi) ------------------------------------

  // Specchio di _digTargets: il blocco davanti ai piedi è il gradino, le due celle
  // sopra (piedi e testa) vanno aperte per poterci salire; se la volta sopra il
  // bot è chiusa va aperta prima, altrimenti il salto non parte.
  _upTargets () {
    if (!this.position || !this._feet) return { error: 'no_position' };
    const feet = this._feet;
    const fy = Math.floor(feet.y + 0.1);
    const fx = Math.floor(feet.x), fz = Math.floor(feet.z);
    const d = this._digDirection();
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
      if (!block.diggable || !(block.hardness >= 0)) return { error: `not_diggable_${label}` };
      targets.push({ cell, block, label });
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
