// BedrockAdapter: sostituisce il layer Mineflayer+flying-squid per Minecraft Bedrock Edition.
// Implementa la stessa interfaccia semantica del vecchio harness:
//   observe(), getAvailableActions(), executeAction(), connect(), disconnect()
// Il controller Hermes/Jev non deve sapere che siamo su Bedrock.
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { BedrockWorld } from './bedrock-world.mjs';
import { trackNethernetClient, closeBedrockClient } from './bedrock-lifecycle.mjs';
const require = createRequire(import.meta.url);
const bedrock = require('bedrock-protocol');
const { NethernetClient } = require('bedrock-protocol/src/nethernet');

const HOST = process.env.BEDROCK_HOST || '<ip-server-bedrock>';
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
    this.selectedHotbar = 0;
    this._authInputQueue = [];
    this._tickAnchor = null;
    this._nextStackRequestId = -1;
    this.drops = [];
    this.nearbyBlocks = {};
    this.dimension = 'overworld';
    this.standingOn = null;
    this.plan = null;
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
    this._motion = null;
    this._openDoors = new Set();       // celle di porte aperte (fisica passabile)
    this._doorWatchers = new Map();    // key -> runtime id della porta chiusa
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
      const cancel = () => client.close();
      signal.addEventListener('abort', cancel, { once: true });

      this.client.on('error', (err) => {
        this.connectError = err;
        this.log('client_error', { message: err.message || String(err) });
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
        this._syncFeetFromPosition();
        this._velocity = { x: 0, y: 0, z: 0 };
        this._onGround = true;
        this._lastSimTick = null;
        this._motion = null;
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
        this.selectedHotbar = 0;
        this._nextStackRequestId = -1;
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
        if (packet.prediction_type !== 'player') return;
        // La correzione è la posizione autorevole del server (agli occhi).
        // L'ancora di tick viene riallineata per restare nella finestra di rewind.
        if (packet.tick != null) this._tickAnchor = { tick: BigInt(packet.tick), time: Date.now() };
        if (!this._feet) this._syncFeetFromPosition(packet.position);
        const drift = Math.hypot(packet.position.x - this._feet.x, packet.position.z - this._feet.z);
        if (drift > MAX_CORRECTION_DRIFT) {
          // Divergenza reale (spinta, disallineamento): accetta X/Z del server.
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

      this.client.on('set_health', (packet) => {
        this.health = packet.health;
      });

      this.client.on('update_attributes', (packet) => {
        for (const attr of packet.attributes || []) {
          if (attr.name === 'minecraft:health') this.health = attr.value;
          if (attr.name === 'minecraft:player.hunger') this.food = attr.value;
        }
      });

      this.client.on('inventory_content', (packet) => {
        if (packet.window_id === 'inventory' || packet.window_id === 0 || packet.inventory_id === 0) {
          this.inventorySlots = packet.input || packet.contents || [];
          this._refreshInventory();
        }
      });
      client.on('inventory_slot', packet => {
        if (packet.window_id !== 'inventory' && packet.window_id !== 0) return;
        this.inventorySlots[packet.slot] = packet.item;
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
            count: item?.count || 1, position: p, distance: +dist.toFixed(1) });
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
          this.inventory[name] = (this.inventory[name] || 0) + (drop.count || 1);
        }
        this.drops = this.drops.filter(d => String(d.runtime_id) !== String(packet.runtime_entity_id) && String(d.id) !== String(packet.runtime_entity_id));
      });

      this.client.on('remove_entity', (packet) => {
        this.drops = this.drops.filter(d => d.id !== packet.entity_id_self);
      });

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
    for (const name of ['dirt', 'grass_block', 'stone', 'oak_log', 'spruce_log', 'cherry_log', 'potatoes', 'carrots', 'wheat', 'beetroots']) {
      this.nearbyBlocks[name] = this.world.findBlocks(name, this.position, 96, 4).map(block => ({ name: block.name, position: block.position, distance: +block.distance.toFixed(1), diggable: block.diggable, hardness: block.hardness }));
    }
    // Bedrock player_position is at eye height (1.62 blocks above the feet).
    this.standingOn = this.world.blockAt({ ...this.position, y: this.position.y - 1.63 })?.name ?? null;
  }

  _refreshInventory () {
    this.inventory = {};
    for (const item of this.inventorySlots) {
      if (!item?.network_id) continue;
      const name = item.name || this.world.registry?.items[item.network_id]?.name || `item_${item.network_id}`;
      this.inventory[name] = (this.inventory[name] || 0) + (item.count || 1);
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
    return {
      step: this.recent.length,
      position: this.pos(),
      health: this.health,
      food: this.food,
      dimension: this.dimension,
      standingOn: this.standingOn,
      inventory: this.inventory,
      drops: this.drops.slice(0, 8),
      plan: this.plan,
      nearby: this.nearbyBlocks,
      recent: this.recent.slice(-8),
      status: this.status,
      spawned: this.spawned,
      world: this.world.summary(),
    };
  }

  options () {
    const o = [];
    const p = this.pos();
    if (this.plan?.waypoint && p && Math.hypot(this.plan.waypoint.x - p.x, this.plan.waypoint.z - p.z) > 2) {
      o.push({ key: 'goto_waypoint', description: `Pathfind to planner waypoint ${JSON.stringify(this.plan.waypoint)}` });
    }
    const drop = this._nearestDrop();
    if (drop) {
      o.push({ key: 'collect_drop', description: `Walk onto the nearest dropped item (${drop.distance.toFixed(1)} blocks away)` });
    }
    // Mining: offri un'opzione per ogni tipo di blocco scavabile nelle vicinanze
    for (const [blockName, blocks] of Object.entries(this.nearbyBlocks || {})) {
      const nearest = blocks?.[0];
      if (nearest && nearest.diggable) {
        o.push({ key: `mine_${blockName}`, description: `Mine ${blockName} at ${JSON.stringify(nearest.position)} (${nearest.distance} blocks away)` });
      }
    }
    // Fallback
    if (!o.length) o.push({ key: 'wait', description: 'Wait 2 seconds for fresh observations' });
    return o;
  }

  async executeAction (key) {
    if (!this.client || this.status === 'disconnected') return { ok: false, error: 'not_connected' };
    if (this.busy) return { ok: false, error: 'busy' };
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
        const moveResult = await this._moveTo(target, 2, 45000);
        result = { ok: true, ...moveResult };
      } else if (key === 'collect_drop') {
        result = await this._collectDrop();
      } else if (key.startsWith('mine_')) {
        const blockName = key.slice('mine_'.length);
        const candidates = this.world.findBlocks(blockName, this.position, 48, 8);
        if (!candidates.length) throw new Error(`no ${blockName} found nearby`);
        const target = candidates[0];
        result = await this._mineBlock(target);
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
      .filter(drop => !drop.failedAt || Date.now() - drop.failedAt > 30000)
      .map(drop => ({ ...drop, distance: this._dropDistance(drop) }))
      .sort((a, b) => a.distance - b.distance)[0] || null;
  }

  _dropStillThere (drop) {
    return this.drops.some(d => String(d.id) === String(drop.id) || (drop.runtime_id != null && String(d.runtime_id) === String(drop.runtime_id)));
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

  // ---- mining ------------------------------------------------------------------------

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
    const held = this.inventorySlots[this.selectedHotbar];
    if (typeof block.digTime === 'function') return block.digTime(held?.network_id ?? null, false, false, false);
    const damage = 1 / hardness / (block.harvestTools ? 100 : 30);
    const ticks = Math.ceil(1 / damage);
    return ticks * 50;
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
      request_id: this._nextStackRequestId--,
      actions: [{ type_id: 'mine_block', legacy_type_id: 11,
        hotbar_slot: this.selectedHotbar, predicted_durability: (held.metadata || 0) + damage,
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
          this._refreshNearby();
          return { ok: true, block: block.name, position: pos, confirmedBy: 'server_world',
            destroyedEvent, ms: Date.now() - started };
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
    if (!moveVector && motion?.active) {
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
    // Un hash non risolto (server più recente del registro) viene trattato come
    // attraversabile per la pianificazione; la fisica resta conservativa.
    if (block.name === 'unknown') return true;
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
    const baseY = Math.floor(this._feet.y + 1e-3);
    const candidates = [];
    for (let r = 0; r <= 3; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          for (let dy = -6; dy <= 6; dy++) {
            const x = gx + dx, y = baseY + dy, z = gz + dz;
            if (!this._standable(x, y, z)) continue;
            const score = Math.hypot(x + 0.5 - target.x, z + 0.5 - target.z) + Math.abs(dy) * 0.25;
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
}
