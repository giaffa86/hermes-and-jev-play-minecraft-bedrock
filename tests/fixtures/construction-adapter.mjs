// Protocol-only simulation. Geometry, collision, A*, support selection,
// server-confirmation primitive, project persistence and verification are real.
import { BedrockAdapter } from '../../bedrock-adapter.mjs';
import { createWorldMemory } from '../../world-memory.mjs';
import { keyOf, isAir, safeSolid } from '../../construction.mjs';

export function constructionAdapter ({ inventory = {}, memory = null, refuse = null, bridge = false } = {}) {
  const a = new BedrockAdapter({ memory: memory ?? createWorldMemory({ dir: null, backend: 'json', logger: null }), logger: { log () {} } });
  a.spawned = true; a.status = 'spawned'; a.client = { write () {} }; a.dead = false;
  a._feet = { x: 2.5, y: 64, z: -1.5 }; a.position = { ...a._feet, y: 65.62 };
  a._lastYaw = 0; a.selectedHotbar = 0;
  a.inventory = { ...inventory }; a.inventorySlots = [];
  for (const [name, amount] of Object.entries(inventory)) {
    for (let left = amount; left > 0; left -= 64) a.inventorySlots.push({ name, network_id: a.inventorySlots.length + 1, count: Math.min(64, left) });
  }
  const blocks = new Map();
  const events = { placed: [], mined: [], moves: [], opened: [], logs: [] };
  const put = (position, name, properties = {}) => {
    blocks.set(keyOf(position), { name, position: { ...position }, boundingBox: /air$|torch$|door$/.test(name) ? 'empty' : 'block', diggable: true, hardness: 1, getProperties: () => properties });
  };
  a.world.blockAt = position => {
    const row = blocks.get(keyOf(position));
    if (row) return row;
    if (Math.abs(position.x) > 18 || Math.abs(position.z) > 30 || position.y < 62 || position.y > 85) return null;
    const name = position.y < 64 ? (bridge && position.z > 0 && position.z < 8 ? 'water' : 'stone') : 'air';
    return { name, position: { ...position }, boundingBox: name === 'stone' ? 'block' : 'empty', diggable: true, hardness: 1, getProperties: () => ({}) };
  };
  a.world.runtimeIdAt = () => 1;
  a.world.findBlocks = () => [];
  a._slotItemName = slot => slot?.name ?? '';
  a._selectHotbarSlot = i => { a.selectedHotbar = i; };
  a._moveSlotToHotbar = async i => { [a.inventorySlots[0], a.inventorySlots[i]] = [a.inventorySlots[i], a.inventorySlots[0]]; return 0; };
  a._refreshNearby = () => { a._reachCache = null; BedrockAdapter.prototype._refreshNearby.call(a); };
  a._airTick = () => {};
  a._maybeRememberDiscoveries = () => {};
  const realEdge = a._constructionEdge.bind(a);
  a._constructionEdge = async (...args) => {
    // Run the actual collision/gravity/precise-motion loop, accelerated ticks.
    a._onGround = true; a._velocity = { x: 0, y: 0, z: 0 }; a._lastSimTick = null;
    a._authTickInterval = setInterval(() => a._driveMotion(a._advanceTick()), 1);
    try { return await realEdge(...args); }
    finally { clearInterval(a._authTickInterval); a._authTickInterval = null; }
  };
  a.log = (type, data) => events.logs.push({ type, data });
  a._moveTo = async (target, stopDistance, timeoutMs, { signal } = {}) => {
    if (signal?.aborted) throw new Error('action_cancelled');
    const goal = { x: Math.floor(target.x), y: Math.round(target.y), z: Math.floor(target.z) };
    const path = a._findPath(a._startNode(), goal);
    if (!path?.length || keyOf(path.at(-1)) !== keyOf(goal)) throw new Error(`fixture_path_failed:${keyOf(goal)}`);
    for (const node of path) {
      if (!a._standable(node.x, node.y, node.z)) throw new Error('fixture_path_not_standable');
    }
    events.moves.push(path);
    a._feet = { x: target.x, y: target.y, z: target.z };
    a.position = { ...a._feet, y: a._feet.y + 1.62 };
    a._reachCache = null;
    return { ok: true, pathNodes: path.length };
  };
  // The real _queueAuthInput reaches this simulated server. It rejects distant
  // clicks, missing inventory and occupied destinations exactly at the boundary.
  a._sendAuthInput = ({ transaction, yaw = 0 }) => {
    if (!transaction) return;
    const data = transaction.data;
    if (data.action_type !== 'click_block') throw new Error('fixture_unsupported_packet');
    const support = data.block_position;
    const delta = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]][data.face];
    const position = { x: support.x + delta[0], y: support.y + delta[1], z: support.z + delta[2] };
    const name = data.held_item.name;
    if (refuse?.(name, position)) throw new Error('server_refused');
    if (!safeSolid(a.world.blockAt(support)) || !isAir(a.world.blockAt(position))) throw new Error('fixture_invalid_support_or_target');
    if (Math.hypot(a.position.x - support.x - 0.5, a.position.y - support.y - 0.5, a.position.z - support.z - 0.5) > 4.6) throw new Error('fixture_out_of_reach');
    if (!(a.inventory[name] > 0) || !(data.held_item.count > 0)) throw new Error('fixture_missing_material');
    if (/door$/.test(name) && !isAir(a.world.blockAt({ ...position, y: position.y + 1 }))) throw new Error('fixture_door_upper_occupied');
    let bedHead = null;
    if (name === 'bed') {
      const direction = { south: [0, 1], east: [1, 0], north: [0, -1], west: [-1, 0] }[a._facingFromYaw(yaw)];
      bedHead = { x: position.x + direction[0], y: position.y, z: position.z + direction[1] };
      if (!isAir(a.world.blockAt(bedHead)) || !safeSolid(a.world.blockAt({ ...bedHead, y: bedHead.y - 1 }))) throw new Error('fixture_bed_head_invalid');
    }
    put(position, name, /door$/.test(name) ? { upper_block_bit: false } : {});
    if (/door$/.test(name)) put({ ...position, y: position.y + 1 }, name, { upper_block_bit: true });
    if (bedHead) put(bedHead, 'bed');
    a.inventory[name]--; data.held_item.count--;
    events.placed.push({ name, position, support }); a._reachCache = null;
  };
  a._mineBlock = async block => {
    const p = block.position;
    if (Math.hypot(a.position.x - p.x - 0.5, a.position.y - p.y - 0.5, a.position.z - p.z - 0.5) > 4.6) throw new Error('fixture_mine_out_of_reach');
    if (Math.floor(a._feet.x) === p.x && Math.floor(a._feet.z) === p.z && Math.floor(a._feet.y) === p.y + 1) throw new Error('fixture_mining_own_support');
    put(p, 'air'); events.mined.push(p); a._reachCache = null;
    return { ok: true };
  };
  a._openStorageWindow = async target => {
    const reachable = a.approachReachable(target.position, { range: 3.5, dy: 2 });
    if (!reachable || !isAir(a.world.blockAt({ ...target.position, y: target.position.y + 1 }))) throw new Error('fixture_chest_inaccessible');
    a._openContainer = { id: 1, type: 'container' }; a._openContainerBlock = target;
    events.opened.push(target.position);
  };
  a._closeContainer = async () => { a._openContainer = null; a._openContainerBlock = null; };
  return { adapter: a, blocks, events, put };
}
