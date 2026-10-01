// Real BDS gate: reach a far target with A* pathfinding + physical movement.
// Run: node --env-file=.env test-movement.mjs            (auto: un tronco lontano)
//      node --env-file=.env test-movement.mjs [x] [z] [timeoutMs]
import { BedrockAdapter } from './bedrock-adapter.mjs';
import { setTimeout as delay } from 'node:timers/promises';

if (!process.env.BEDROCK_USERNAME) throw new Error('BEDROCK_USERNAME is required');

const adapter = new BedrockAdapter();
try {
  await adapter.connect();
  // Attende i chunk attorno allo spawn e le correzioni iniziali.
  await delay(5000);

  let target;
  if (process.argv[2] != null && process.argv[3] != null) {
    target = { x: Number(process.argv[2]), y: adapter.position.y, z: Number(process.argv[3]) };
  } else {
    // Bersaglio automatico: un blocco di tronco a più di 12 blocchi, così il percorso è reale.
    const logs = adapter.world.findBlocks(['oak_log', 'spruce_log', 'cherry_log'], adapter.position, 48, 24);
    const far = logs.find(log => log.distance > 12) || logs[0];
    if (!far) throw new Error('no tree logs within 48 blocks to walk to');
    target = { x: far.position.x + 0.5, y: adapter.position.y, z: far.position.z + 0.5 };
    console.log('MOVEMENT_AUTO_TARGET', JSON.stringify({ block: far.name, position: far.position, distance: +far.distance.toFixed(1) }));
  }
  const timeoutMs = Number(process.argv[4] ?? 90000);
  console.log('MOVEMENT_START', JSON.stringify({ target, feet: adapter._feet, position: adapter.pos() }));
  const start = { ...adapter._feet };
  const result = await adapter._moveTo(target, 2.5, timeoutMs);
  const traveled = Math.hypot(adapter._feet.x - start.x, adapter._feet.z - start.z);
  console.log('MOVEMENT_RESULT', JSON.stringify({ ...result, traveled: +traveled.toFixed(1), feet: adapter._feet, server: adapter.position }));
  if (!result.ok) throw new Error('movement failed');
} finally {
  await adapter.disconnect('movement test cleanup');
}
