// Real BDS gate: observe only by default; --mine harvests one nearby crop.
// Run: node --env-file=.env test-mining.mjs --mine
import { BedrockAdapter } from './bedrock-adapter.mjs';
import { setTimeout as delay } from 'node:timers/promises';

if (!process.env.BEDROCK_USERNAME) throw new Error('BEDROCK_USERNAME is required');
const adapter = new BedrockAdapter();
try {
  await adapter.connect();
  const client = adapter.client;
  client.on('packet_violation_warning', packet => console.log('MINING_VIOLATION', JSON.stringify(packet)));
  client.on('item_stack_response', packet => console.log('MINING_STACK_RESPONSE', JSON.stringify(packet)));
  const write = client.write.bind(client);
  client.write = (name, params) => {
    if (name === 'player_auth_input' && (params.block_action?.length || params.transaction || params.item_stack_request)) console.log('MINING_SENT', JSON.stringify(params, (key, value) => typeof value === 'bigint' ? String(value) : value));
    return write(name, params);
  };
  for (const name of ['level_event', 'update_block', 'inventory_slot', 'add_item_entity', 'correct_player_move_prediction']) {
    client.on(name, packet => {
      if (name === 'level_event' && ![2001, 'particle_destroy', 'block_start_break', 'block_stop_break', 'block_break_speed'].includes(packet.event)) return;
      const summary = name === 'add_item_entity' ? { id: packet.runtime_entity_id, item: packet.item, position: packet.position } : packet;
      console.log('MINING_PACKET', name, JSON.stringify(summary, (key, value) => typeof value === 'bigint' ? String(value) : value));
    });
  }
  await delay(5000);
  console.log('MINING_SETTINGS', JSON.stringify({ serverAuth: adapter.serverAuthBlockBreaking,
    inventoryAuth: client.startGameData.server_authoritative_inventory, currentTick: String(client.startGameData.current_tick),
    gameMode: client.startGameData.player_gamemode, permission: client.startGameData.permission_level,
    disabledInteractions: client.startGameData.disable_player_interactions, position: adapter.position, inventory: adapter.inventory }));
  console.log('WORLD', JSON.stringify({ position: adapter.position, standingOn: adapter.standingOn,
    crops: adapter.nearbyBlocks.potatoes, summary: adapter.world.summary() }));
  if (process.argv.includes('--mine')) {
    const crop = process.env.MINING_CROP || 'potatoes';
    if (!['potatoes', 'carrots', 'wheat', 'beetroots'].includes(crop)) throw new Error('Only crops are supported by this integration gate');
    const target = adapter.world.findBlocks(crop, adapter.position, 4, 1)[0];
    if (!target) throw new Error(`No ${crop} within 4 blocks; no mining attempted`);
    const result = await adapter.executeAction(`mine_${crop}`);
    console.log('MINING_RESULT', JSON.stringify(result));
    if (!result.ok) throw new Error(result.error);
    if (adapter.world.blockAt(target.position)?.name !== 'air') throw new Error('Harvested crop did not become known air');
    console.log('OBSERVE_AFTER', JSON.stringify(adapter.observe().nearby[crop]));
    await delay(1000);
    console.log('INVENTORY_AFTER', JSON.stringify(adapter.inventory));
    console.log('DROPS_AFTER', JSON.stringify(adapter.drops, (key, value) => typeof value === 'bigint' ? String(value) : value));
  }
} finally {
  await adapter.disconnect('mining test cleanup');
}
