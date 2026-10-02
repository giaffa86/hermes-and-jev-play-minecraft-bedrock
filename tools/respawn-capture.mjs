#!/usr/bin/env node
// Respawn capture via a MITM relay (bedrock-protocol `Relay`).
//
// Purpose: record the exact death→respawn packet sequence of a **vanilla**
// Bedrock client, so it can be compared with what our adapter does
// (`docs/wiki/respawn.md`, "Refinement path", step 1).
//
// Usage:
//   # on the Docker host / a LAN machine that the vanilla client can reach
//   CAPTURE_PORT=19133 BEDROCK_HOST=<ip-bds> BEDROCK_PORT=19132 \
//     node tools/respawn-capture.mjs
//   # then in the vanilla client: add a server -> <this-host>:19133, join,
//   # die once (e.g. in lava/mobs), wait for the respawn screen, respawn.
//   # Ctrl+C prints the timeline; raw packets land in runs/ (git-ignored).
//
// Notes / caveats:
// - The relay authenticates to the backend on the client's behalf; on an
//   online-mode BDS it may ask for MSA (see `onMsaCode`). Set `CAPTURE_RELAY_OFFLINE=1`
//   only for offline test servers.
// - The listening side defaults to RakNet (UDP) so a normal client can join;
//   the backend transport is configurable (`CAPTURE_DEST_TRANSPORT=nethernet`).
// - The output is runtime data (may contain the client's gamertag/xuid): it is
//   written under `runs/` (git-ignored). Never commit it.
//
// This is a diagnostic tool, not part of the agent runtime.

import { createRequire } from 'node:module';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
const bedrock = require('bedrock-protocol');

const LISTEN_HOST = process.env.CAPTURE_HOST || '0.0.0.0';
const LISTEN_PORT = +(process.env.CAPTURE_PORT || 19133);
const DEST_HOST = process.env.BEDROCK_HOST || '127.0.0.1';
const DEST_PORT = +(process.env.BEDROCK_PORT || 19132);
const DEST_TRANSPORT = process.env.CAPTURE_DEST_TRANSPORT || 'raknet';
const VERSION = process.env.BEDROCK_VERSION || '1.26.51';
const OUT = process.env.CAPTURE_OUT || 'runs/respawn-capture.jsonl';
const WINDOW_MS = +(process.env.CAPTURE_WINDOW_MS || 6000);
const OFFLINE = /^(1|on|true|yes)$/i.test(process.env.CAPTURE_RELAY_OFFLINE || '');

// Packets that matter for the death→respawn flow. `player_auth_input` is only
// logged inside a short window after a death/respawn packet (it streams 20/s).
const INTERESTING = new Set([
  'respawn', 'player_action', 'set_health', 'update_attributes',
  'move_player', 'play_status', 'change_dimension', 'disconnect',
]);

mkdirSync(dirname(OUT), { recursive: true });
const json = (value) => JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));
const write = (entry) => appendFileSync(OUT, `${json(entry)}\n`);

let windowUntil = 0;
const timeline = [];

function note (dir, name, params) {
  timeline.push({
    dir,
    name,
    state: params?.state ?? null,
    health: params?.health ?? null,
    at: Date.now(),
  });
}

const relay = new bedrock.Relay({
  version: VERSION,
  host: LISTEN_HOST,
  port: LISTEN_PORT,
  offline: OFFLINE,
  destination: { host: DEST_HOST, port: DEST_PORT, transport: DEST_TRANSPORT },
  // The repo does not build the native RakNet binding: use the pure-JS one.
  raknetBackend: 'jsp-raknet',
  profilesFolder: process.env.BEDROCK_PROFILES_DIR || undefined,
  onMsaCode: (code) => console.log('[capture] MSA sign-in required for the backend:\n', code.message),
});

relay.listen();
console.log(`[capture] relay listening on ${LISTEN_HOST}:${LISTEN_PORT} -> ${DEST_HOST}:${DEST_PORT} (${DEST_TRANSPORT}), version ${VERSION}`);
console.log('[capture] connect a VANILLA client to this host/port, die once, wait for respawn, then Ctrl+C');
console.log(`[capture] output: ${OUT} (under runs/, git-ignored — never commit it)`);

relay.on('connect', (player) => {
  console.log('[capture] client connected:', player.connection?.address);
  const observe = (dir) => ({ name, params }) => {
    const now = Date.now();
    if (name === 'respawn' || (name === 'set_health' && Number(params?.health) <= 0)) windowUntil = now + WINDOW_MS;
    const inWindow = now < windowUntil;
    if (!INTERESTING.has(name) && !(inWindow && name === 'player_auth_input')) return;
    const slim = name === 'player_auth_input'
      ? { input_data: params?.input_data, position: params?.position, tick: params?.tick }
      : params;
    write({ t: now, dir, name, params: slim });
    note(dir, name, params);
    const line = name === 'player_auth_input' ? json(slim) : json(slim).slice(0, 220);
    console.log(`[${dir}] ${name} ${line}`);
  };
  player.on('clientbound', observe('S->C'));
  player.on('serverbound', observe('C->S'));
});

process.on('SIGINT', () => {
  console.log('\n[capture] death→respawn timeline:');
  if (!timeline.length) console.log('  (nothing captured — did the client die?)');
  for (const e of timeline) {
    const extra = `${e.state != null ? ` state=${e.state}` : ''}${e.health != null ? ` health=${e.health}` : ''}`;
    console.log(`  ${e.dir} ${e.name}${extra}`);
  }
  console.log(`\n[capture] raw packets: ${OUT}`);
  console.log('[capture] compare this sequence with the adapter logs (respawn_packet / respawn_ready in the harness logs).');
  process.exit(0);
});
