// Reuse Prismarine's Bedrock v9 decoder with the current registry. Unreceived
// sections and unknown runtime hashes must never be reported as vanilla blocks.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const registryLoader = require('prismarine-registry');
const chunkLoader = require('prismarine-chunk/src/bedrock/1.18/chunk');
const SubChunk = require('prismarine-chunk/src/bedrock/1.18/SubChunk');
const Stream = require('prismarine-chunk/src/bedrock/common/Stream');
const PalettedStorage = require('prismarine-chunk/src/bedrock/common/PalettedStorage');
const { StorageType } = require('prismarine-chunk/src/bedrock/common/constants');

class NetworkSection extends SubChunk {
  entry (runtimeId) {
    const block = this.registry.blocksByRuntimeId[runtimeId];
    return { ...block, stateId: block?.stateId ?? -1, runtimeId, count: 0 };
  }

  loadRuntimePalette (layer, stream, size) {
    this.palette[layer] = Array.from({ length: size }, () => this.entry(stream.readZigZagVarInt()));
  }

  loadPalettedBlocks (layer, stream, bits, format) {
    if (format === StorageType.Runtime && bits === 0) {
      this.blocks[layer] = new PalettedStorage(1);
      this.palette[layer] = [this.entry(stream.readZigZagVarInt())];
      return;
    }
    super.loadPalettedBlocks(layer, stream, bits, format);
  }

  decode (format, stream) {
    super.decode(format, stream);
    if (this.subChunkVersion === 9 && this.y >= 128) this.y -= 256;
  }
}

export class BedrockWorld {
  constructor ({ version = '1.26.51', onError = () => {} } = {}) {
    this.version = version;
    this.onError = onError;
    this.columns = new Map();
    this.loaded = new Set();
    this.pending = new Set();
    this.unknownRuntimeIds = new Set();
    this.errors = 0;
    this.dimension = 0;
  }

  start (packet) {
    this.registry = registryLoader(`bedrock_${this.version}`);
    if (!this.registry) throw new Error(`Missing Bedrock registry ${this.version}`);
    // Recent versions send the item palette later in item_registry. Preserve
    // the bundled item properties until those runtime IDs arrive.
    this.registry.handleStartGame({ ...packet,
      itemstates: packet.itemstates?.length ? packet.itemstates : this.registry.writeItemStates() });
    this.Chunk = chunkLoader(this.registry);
    this.Block = require('prismarine-block')(this.registry);
    this.dimension = typeof packet.dimension === 'number' ? packet.dimension : ({ overworld: 0, nether: 1, end: 2 }[packet.dimension] ?? 0);
    this.columns.clear();
    this.loaded.clear();
    this.pending.clear();
    this.unknownRuntimeIds.clear();
    this.errors = 0;
  }

  column (x, z) {
    const key = `${x},${z}`;
    if (!this.columns.has(key)) this.columns.set(key, new this.Chunk({ x, z }));
    return this.columns.get(key);
  }

  decodeSection (column, y, payload) {
    const section = new NetworkSection(this.registry, this.Block, { y, subChunkVersion: 9 });
    section.decode(StorageType.Runtime, new Stream(payload));
    if (section.y !== y) throw new Error(`Subchunk index mismatch: ${y} != ${section.y}`);
    column.setSection(y, section);
    this.loaded.add(`${column.x},${y},${column.z}`);
    for (const palette of section.palette) for (const entry of palette || []) {
      if (entry.stateId === -1) this.unknownRuntimeIds.add(entry.runtimeId);
    }
  }

  levelChunk (packet) {
    if (!this.registry || packet.dimension !== this.dimension) return;
    try {
      if (packet.cache_enabled) throw new Error('Cached chunks are not enabled by this client');
      const column = this.column(packet.x, packet.z);
      const stream = new Stream(packet.payload);
      const count = packet.sub_chunk_count | 0;
      // 1.26 sends zero sections plus highest_subchunk_count in request mode.
      if (packet.highest_subchunk_count == null && count > 0) {
        for (let i = 0; i < count; i++) {
          const start = stream.readOffset;
          const section = new NetworkSection(this.registry, this.Block, { y: i - 4, subChunkVersion: 9 });
          section.decode(StorageType.Runtime, stream);
          this.decodeSection(column, section.y, packet.payload.subarray(start, stream.readOffset));
        }
      }
      column.loadBiomes(stream, StorageType.Runtime);
    } catch (error) { this.failed(error); }
  }

  subchunk (packet) {
    if (!this.registry || packet.dimension !== this.dimension) return;
    for (const entry of packet.entries || []) {
      const x = packet.origin.x + entry.dx, y = packet.origin.y + entry.dy, z = packet.origin.z + entry.dz;
      const key = `${x},${y},${z}`;
      this.pending.delete(key);
      try {
        if (entry.result === 'success_all_air') {
          // Explicit all-air replies are known; absent sections are unknown.
          this.column(x, z).sections[4 + y] = null;
          this.loaded.add(key);
        } else if (entry.result === 'success') {
          if (packet.cache_enabled || !entry.payload) throw new Error('Subchunk payload missing or cached');
          this.decodeSection(this.column(x, z), y, entry.payload);
        }
      } catch (error) { this.failed(error); }
    }
  }

  failed (error) {
    this.errors++;
    this.onError(error);
  }

  setBlock (position, runtimeId, layer = 0) {
    if (!this.registry || !position || (layer !== 0 && layer !== 1)) return false;
    const x = Math.floor(position.x), y = Math.floor(position.y), z = Math.floor(position.z);
    const cx = Math.floor(x / 16), cy = Math.floor(y / 16), cz = Math.floor(z / 16);
    // A single update does not establish the contents of an absent section.
    if (!this.loaded.has(`${cx},${cy},${cz}`)) return false;
    const column = this.column(cx, cz);
    let section = column.getSectionAtIndex(cy);
    if (!section) {
      section = new NetworkSection(this.registry, this.Block, { y: cy, subChunkVersion: 9 });
      column.setSection(cy, section);
    }
    if (!section.blocks[layer]) {
      section.blocks[layer] = new PalettedStorage(1);
      section.palette[layer] = [{ ...this.registry.blocksByName.air, stateId: this.registry.blocksByName.air.defaultState, count: 4096 }];
    }
    const block = this.registry.blocksByRuntimeId[runtimeId];
    const entry = { ...block, stateId: block?.stateId ?? -1, runtimeId, count: 0 };
    if (entry.stateId === -1) this.unknownRuntimeIds.add(runtimeId);
    const palette = section.palette[layer];
    let index = palette.findIndex(value => value.runtimeId === runtimeId);
    if (index < 0) { index = palette.length; palette.push(entry); }
    const bits = Math.max(1, Math.ceil(Math.log2(palette.length)));
    if (bits > section.blocks[layer].bitsPerBlock) section.blocks[layer] = section.blocks[layer].resize(bits);
    section.blocks[layer].set(x & 15, y & 15, z & 15, index);
    section.updated = true;
    return true;
  }

  runtimeIdAt (position) {
    const x = Math.floor(position.x), y = Math.floor(position.y), z = Math.floor(position.z);
    if (!this.loaded.has(`${Math.floor(x / 16)},${Math.floor(y / 16)},${Math.floor(z / 16)}`)) return null;
    const section = this.columns.get(`${Math.floor(x / 16)},${Math.floor(z / 16)}`)?.getSectionAtIndex(Math.floor(y / 16));
    const entry = section?.palette[0]?.[section.blocks[0]?.get(x & 15, y & 15, z & 15)];
    return entry?.runtimeId ?? null;
  }

  refreshSection (client, position) {
    const origin = { x: Math.floor(position.x / 16), y: Math.floor(position.y / 16), z: Math.floor(position.z / 16) };
    const key = `${origin.x},${origin.y},${origin.z}`;
    this.loaded.delete(key);
    this.pending.add(key);
    client.queue('subchunk_request', { dimension: this.dimension, origin, requests: [{ x: 0, y: 0, z: 0 }] });
  }

  requestAround (client, position, radius = 2) {
    if (!this.registry || !position) return;
    const origin = { x: Math.floor(position.x / 16), y: Math.floor(position.y / 16), z: Math.floor(position.z / 16) };
    const requests = [];
    for (let x = -radius; x <= radius; x++) for (let z = -radius; z <= radius; z++) for (let y = -2; y <= 2; y++) {
      const key = `${origin.x + x},${origin.y + y},${origin.z + z}`;
      if (this.loaded.has(key) || this.pending.has(key)) continue;
      requests.push({ x, y, z });
      this.pending.add(key);
    }
    if (requests.length) client.queue('subchunk_request', { dimension: this.dimension, origin, requests });
  }

  blockAt (position) {
    if (!this.registry) return null;
    const pos = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
    const cx = Math.floor(pos.x / 16), cy = Math.floor(pos.y / 16), cz = Math.floor(pos.z / 16);
    if (!this.loaded.has(`${cx},${cy},${cz}`)) return null;
    const column = this.columns.get(`${cx},${cz}`);
    const local = { x: pos.x & 15, y: pos.y, z: pos.z & 15, l: 0 };
    const section = column.getSectionAtIndex(cy);
    const entry = section?.palette[0]?.[section.blocks[0]?.get(local.x, pos.y & 15, local.z)];
    if (entry?.stateId === -1) return { name: 'unknown', runtimeId: entry.runtimeId, position: pos, diggable: false, hardness: null };
    const block = column.getBlock(local, false);
    block.position = pos;
    return block;
  }

  // Nome del bioma alla posizione (best-effort). In Bedrock il bioma è per
  // sezione 3D; usiamo la quota y del punto. Il nome è senza prefisso
  // 'minecraft:' (es. 'cherry_grove').
  biomeAt (position) {
    if (!this.registry || !position) return null;
    const pos = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
    const column = this.columns.get(`${Math.floor(pos.x / 16)},${Math.floor(pos.z / 16)}`);
    if (!column || typeof column.getBiome !== 'function') return null;
    try {
      const biome = column.getBiome({ x: pos.x & 15, y: pos.y, z: pos.z & 15 });
      return biome?.name ?? null;
    } catch {
      return null;
    }
  }

  findBlocks (names, point, radius = 48, count = 8) {
    if (!this.registry || !point) return [];
    const wanted = new Set(Array.isArray(names) ? names : [names]);
    const result = [];
    for (const key of this.loaded) {
      const [cx, cy, cz] = key.split(',').map(Number);
      const column = this.columns.get(`${cx},${cz}`), section = column?.getSectionAtIndex(cy);
      if (!section?.palette[0]?.some(entry => wanted.has(entry.name))) continue;
      const minX = Math.max(cx * 16, Math.ceil(point.x - radius)), maxX = Math.min(cx * 16 + 15, Math.floor(point.x + radius));
      const minY = Math.max(cy * 16, Math.ceil(point.y - radius)), maxY = Math.min(cy * 16 + 15, Math.floor(point.y + radius));
      const minZ = Math.max(cz * 16, Math.ceil(point.z - radius)), maxZ = Math.min(cz * 16 + 15, Math.floor(point.z + radius));
      for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) for (let z = minZ; z <= maxZ; z++) {
        const entry = section.palette[0][section.blocks[0].get(x & 15, y & 15, z & 15)];
        if (!wanted.has(entry.name)) continue;
        const distance = Math.hypot(x - point.x, y - point.y, z - point.z);
        if (distance > radius || (result.length === count && distance >= result.at(-1).distance)) continue;
        result.push({ position: { x, y, z }, distance });
        result.sort((a, b) => a.distance - b.distance);
        if (result.length > count) result.pop();
      }
    }
    // Restituisce l'oggetto blocco *intero* (istanza prismarine Block), non una
    // copia spalmata: lo spread perdeva i metodi e con essi `getProperties()`,
    // quindi gli stati di blocco (es. `growth` delle colture) risultavano
    // illeggibili in produzione.
    return result.map(entry => {
      const block = this.blockAt(entry.position) || {};
      block.distance = entry.distance;
      return block;
    });
  }

  summary () {
    return { columns: this.columns.size, sections: this.loaded.size, pending: this.pending.size, unknownRuntimeIds: this.unknownRuntimeIds.size, decodeErrors: this.errors };
  }
}
