// Integration gate: repeated real-player spawns against the configured BDS.
// Run: node --env-file=.env test-reconnect.mjs
import { BedrockAdapter } from './bedrock-adapter.mjs';
import { setTimeout as delay } from 'node:timers/promises';

if (!process.env.BEDROCK_USERNAME) throw new Error('BEDROCK_USERNAME is required');
const cycles = Number(process.env.RECONNECT_CYCLES || 3);
if (!Number.isInteger(cycles) || cycles < 2) throw new Error('RECONNECT_CYCLES must be an integer >= 2');
const adapter = new BedrockAdapter();
try {
  for (let cycle = 1; cycle <= cycles; cycle++) {
    // Concurrent callers must share one connection attempt.
    await Promise.all([adapter.connect(), adapter.connect()]);
    if (!adapter.spawned) throw new Error(`Cycle ${cycle}: spawn missing`);
    await delay(3000);
    if (!adapter.spawned) throw new Error(`Cycle ${cycle}: connection lost`);
    const observation = adapter.observe();
    for (const name of ['dirt', 'stone', 'oak_log']) {
      if (!observation.nearby[name]?.length) throw new Error(`Cycle ${cycle}: missing decoded ${name}`);
    }
    if (observation.world.decodeErrors) throw new Error(`Cycle ${cycle}: world decoding failed`);
    console.log('WORLD', JSON.stringify({ standingOn: observation.standingOn, nearby: observation.nearby, world: observation.world }));
    await adapter.disconnect(`reconnect test ${cycle}/${cycles}`);
    console.log(`PASS reconnect cycle ${cycle}/${cycles}`);
    await delay(500);
  }
} finally {
  await adapter.disconnect('reconnect test cleanup');
}
