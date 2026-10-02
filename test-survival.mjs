// Verifica live sul BDS di tracking entità, ora del giorno, letti e opzioni di
// sopravvivenza. Con --fight / --eat / --sleep esegue anche le azioni relative.
// Prima di eseguire fermare il container di produzione (stesso account bot):
//   sudo docker stop hermes-jev-bedrock   (su host Docker)
// Uso: node --env-file=.env test-survival.mjs [--fight] [--eat] [--sleep]
import { BedrockAdapter } from './bedrock-adapter.mjs';
import { setTimeout as delay } from 'node:timers/promises';

if (!process.env.BEDROCK_USERNAME) throw new Error('BEDROCK_USERNAME is required');
const flags = new Set(process.argv.slice(2));
const safe = value => JSON.stringify(value, (k, v) => typeof v === 'bigint' ? v.toString() : v);

const logged = [];
const adapter = new BedrockAdapter({
  logger: {
    log: (type, data) => {
      if (/^(entity_add|entity_death|sleep_|death|respawn|attack|weapon_equip|world_clock)/.test(type)) logged.push({ type, ...data });
    },
  },
});

try {
  await adapter.connect();
  let rawEntities = 0;
  if (adapter.client) {
    adapter.client.on('set_time', packet => console.log('RAW_SET_TIME', JSON.stringify(packet)));
    adapter.client.on('add_entity', packet => {
      if (rawEntities++ < 10) {
        console.log('RAW_ADD_ENTITY', JSON.stringify({ entity_type: packet.entity_type, runtime_id: String(packet.runtime_id), position: packet.position }));
      }
    });
    adapter.client.on('add_player', packet => console.log('RAW_ADD_PLAYER', JSON.stringify({ username: packet.username, runtime_id: String(packet.runtime_id), position: packet.position })));
    adapter.client.on('set_entity_data', packet => {
      if (String(packet.runtime_entity_id) !== String(adapter.client?.entityId)) return;
      const rows = (packet.metadata || []).map(entry => ({ key: entry.key, type: entry.type, value: typeof entry.value === 'bigint' ? `bigint:${entry.value}` : entry.value }));
      console.log('RAW_SELF_METADATA', safe(rows).slice(0, 700));
    });
  }
  await delay(8000);

  console.log('STATE', JSON.stringify({
    position: adapter.pos(), health: adapter.health, food: adapter.food,
    dead: adapter.dead, sleeping: adapter.sleeping, time: adapter._timeInfo(),
    world: adapter.world.summary(),
  }));
  console.log('ENTITIES', JSON.stringify(adapter._nearbyEntities(12)));
  console.log('HOSTILES', JSON.stringify(adapter._hostiles().map(h => ({ type: h.type, distance: +h.distance.toFixed(1), health: h.health }))));
  const beds = adapter.world.findBlocks('bed', adapter.position, 64, 8)
    .map(b => ({ name: b.name, position: b.position, distance: +b.distance.toFixed(1) }));
  console.log('BEDS', JSON.stringify(beds));
  console.log('OPTIONS', JSON.stringify(adapter.options()));

  if (flags.has('--eat')) {
    console.log('EAT', JSON.stringify(await adapter.executeAction('eat')));
  }
  if (flags.has('--fight')) {
    const target = adapter._hostiles().find(h => h.type !== 'creeper' && h.type !== 'enderman');
    if (!target) console.log('FIGHT skipped: no suitable hostile nearby');
    else console.log('FIGHT', JSON.stringify(await adapter.executeAction(`attack_${target.type}`)));
  }
  if (flags.has('--sleep')) {
    console.log('SLEEP', JSON.stringify(await adapter.executeAction('sleep')));
    await delay(2500);
    console.log('SLEEPING', adapter.sleeping, JSON.stringify(adapter._timeInfo()));
  }
  console.log('LOGGED', safe(logged.slice(0, 40)));
} finally {
  await adapter.disconnect('survival test cleanup');
}
