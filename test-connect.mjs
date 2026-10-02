// Connectivity smoke test: entra nel server Bedrock come vero player.
// Requisiti:
//   - BEDROCK_USERNAME (gamertag o email Microsoft) deve essere nell'allowlist del server Bedrock.
//   - Se BEDROCK_USERNAME non è impostato, usa offline:true (verrà kickato da BDS online-mode=true,
//     ma utile per verificare che il codice non crashi).
// Usa bedrock-protocol@3.60.1 in modalità NetherNet con backend jsp-raknet per evitare
// il binding nativo raknet-native.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const bedrock = require('bedrock-protocol');
const { NethernetClient } = require('bedrock-protocol/src/nethernet');

const host = process.env.BEDROCK_HOST || '127.0.0.1';
const port = +(process.env.BEDROCK_PORT || 19132);
const username = process.env.BEDROCK_USERNAME || 'hermes-bot-test';
const authTitleName = process.env.BEDROCK_AUTH_TITLE || 'MinecraftNintendoSwitch';
const profilesDir = process.env.BEDROCK_PROFILES_DIR || undefined;
const offline = !process.env.BEDROCK_USERNAME;

async function nethernetPing() {
  const client = new NethernetClient({ host, port });
  try {
    return await client.ping(10000);
  } finally {
    client.close();
  }
}

async function main() {
  console.log(`[discovery] ${host}:${port} over nethernet`);
  const ad = await nethernetPing();
  console.log('[discovery] advertisement', JSON.stringify(ad, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));

  const networkId = ad.networkId ? String(ad.networkId) : undefined;
  if (!networkId) throw new Error('networkId missing from discovery advertisement');

  console.log(`[connect] networkId=${networkId}, transport=nethernet, username=${username || '<offline>'}`);

  const clientOptions = {
    host,
    port,
    username,
    offline,
    version: '1.26.51', // bedrock-protocol 3.60.1 supporta fino a 1.26.51; il server 1.26.52 usa lo stesso protocollo 2193
    transport: 'nethernet',
    nethernet: { networkId },
    raknetBackend: 'jsp-raknet',
    skipPing: true,
    profilesFolder: profilesDir,
    connectTimeout: 30000,
  };
  if (!offline) {
    clientOptions.authTitle = bedrock.title[authTitleName];
    if (!clientOptions.authTitle) {
      console.warn(`[warn] unknown BEDROCK_AUTH_TITLE=${authTitleName}, falling back to MinecraftNintendoSwitch`);
      clientOptions.authTitle = bedrock.title.MinecraftNintendoSwitch;
    }
    clientOptions.flow = 'live';
    clientOptions.onMsaCode = (data) => {
      console.log('[msa] Authenticate the bot account at', data.verification_uri, 'with code', data.user_code);
    };
  }
  const client = bedrock.createClient(clientOptions);

  const timeout = setTimeout(() => {
    console.error('[timeout] spawn/close not received within 300s');
    client.close();
    process.exitCode = 1;
  }, 300000);

  client.on('error', (err) => {
    console.error('[client error]', err.message || err);
  });

  client.on('kick', (packet) => {
    console.error('[kicked]', JSON.stringify(packet));
    clearTimeout(timeout);
    process.exitCode = 1;
  });

  client.on('close', () => {
    console.log('[client close]');
    clearTimeout(timeout);
  });

  client.on('spawn', () => {
    console.log('[spawn] OK', {
      entityId: client.entityId,
      username: client.username,
      position: client.startGameData?.player_position,
    });
    // Rimani connesso 10 secondi per verificare stabilità
    setTimeout(async () => {
      console.log('[spawn] stable, disconnecting');
      const rtc = client.connection?.nethernet?.rtcConnection;
      client.disconnect('smoke test complete');
      await Promise.all([rtc?.close(), client._nethernetCleanup]);
    }, 10000);
  });

  client.on('login', () => {
    console.log('[login] authenticated, waiting spawn...');
  });
}

main().catch((e) => {
  console.error('[main error]', e.message, e.stack);
  process.exitCode = 1;
});
