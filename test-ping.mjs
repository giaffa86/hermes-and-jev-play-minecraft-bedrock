// Ping del server Bedrock via NetherNet.
// bedrock-protocol@3.60.1 carica raknet-native anche quando si richiede transport:'nethernet',
// quindi usiamo direttamente NethernetClient per evitare il binding nativo.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { NethernetClient } = require('bedrock-protocol/src/nethernet');

const host = process.env.BEDROCK_HOST || '127.0.0.1';
const port = +(process.env.BEDROCK_PORT || 19132);

(async () => {
  const client = new NethernetClient({ host, port });
  try {
    const res = await client.ping(10000);
    console.log('PING OK', JSON.stringify(res, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
  } catch (e) {
    console.error('PING FAILED', e.message, e.stack);
    process.exitCode = 1;
  } finally {
    client.close();
  }
})();
