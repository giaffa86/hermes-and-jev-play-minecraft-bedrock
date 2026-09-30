// Ping diretto via NetherNet, bypassando il caricamento di raknet-native in bedrock-protocol/src/createClient.js.
// Questo test non richiede autenticazione Xbox Live.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { NethernetClient } = require('bedrock-protocol/src/nethernet');

const host = process.env.BEDROCK_HOST || '<ip-server-bedrock>';
const port = +(process.env.BEDROCK_PORT || 19132);

(async () => {
  const client = new NethernetClient({ host, port });
  try {
    const ad = await client.ping(10000);
    console.log('PING OK', JSON.stringify(ad, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
  } catch (e) {
    console.error('PING FAILED', e.message, e.stack);
    process.exitCode = 1;
  } finally {
    client.close();
  }
})();
