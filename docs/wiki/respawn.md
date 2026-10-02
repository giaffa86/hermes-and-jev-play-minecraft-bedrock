# Death and respawn

Topic: what happens when the bot dies on the live BDS, why respawn can get
**stuck** (BDS 1.26.52 over NetherNet), the current mitigation, its limits, and
the refinement path.

Sources: `bedrock-adapter.mjs` (`_onOwnHealth`, `_onRespawnPacket`,
`_survivalTick`, the respawn watchdog), [open-questions](open-questions.md),
[verification](verification.md) row 12.

## The flow

1. The server sets the player's health to 0 → `_onOwnHealth` marks `this.dead`,
   increments `deaths`, records `deathSite` (the loot stays where the bot died)
   and starts retrying.
2. `_survivalTick` (every 2.5 s) sends `player_action { action: 'respawn' }`.
3. The server is expected to run the respawn handshake: `respawn` packet
   `SERVER_SEARCHING` (0) → client `CLIENT_READY` (2) → server `SERVER_READY`
   (1) with the spawn position → the client gets `health > 0`.
4. `_onRespawnPacket` replies `state: 2` and, on state 1, `_finishRespawn`
   teleports the client and clears `dead`.

## Problem: stuck after death

On the live BDS the bot stays `dead` (`health: 0`); `/options` degrades to
`wait` (`Dead; respawning automatically`). It only recovered with a BDS restart
at zero players (fresh login).

## Findings (live packet capture, 2026-10-02)

Captured with the `PACKET_DEBUG=1` diagnostic (logs clientbound packet names for
25 s after a death):

- The connection **stays fully alive** (thousands of `move_entity_delta` /
  `set_entity_data` / `set_entity_motion` packets).
- The BDS **ignores** `player_action { action: 'respawn' }`: 13 requests, **0**
  `respawn` packets in response.
- A client `respawn` packet (`state: 2`, CLIENT_READY) *does* trigger the
  handshake (`SERVER_SEARCHING` 0 → `SERVER_READY` 1, with the spawn position)
  and the client teleports to spawn — but the server **never restores health**,
  so the player stays dead. Subsequent requests are ignored.

This is consistent with a **server-side** respawn bug, but it has **not** been
confirmed with a vanilla client (see below), so it could equally be our client
library sending the wrong packet.

## State: mitigated (live-verified)

`bedrock-adapter.mjs` runs a **respawn watchdog**: if the bot is still `dead`
`RESPAWN_RECONNECT_MS` (default 25 s) after dying, it closes the client; the
harness reconnects (fresh login) and the player spawns alive.

```
[death] → respawn_reconnect { deadMs: 25026 } → bedrock harness connected → health: 20
```

Verified live twice, **without a BDS restart**.

## Limits

- **Time gap**: ~25 s dead + a reconnect (~10-15 s) ≈ **25-40 s** before the bot
  is back; not a clean in-place respawn.
- **Fresh session**: the bot leaves and re-joins (re-auth); the inventory is
  dropped anyway (`keep-inventory=false`), so `recover_loot` still matters.
- **Depends on the harness reconnect**: if that hits `connecterror:9`, a BDS
  restart at zero players may still be needed.
- The watchdog does **not** fix the protocol; it only works around the server.
- Death must still be detected: a poll slightly after the death is enough
  (the death site persists).

## Refinement path

Order matters — settle *whose bug it is* before touching more client code.

- **Already tried and failed (2026-10-02)**: reading the self player's health
  from `set_entity_data` metadata (the adapter previously used only `set_health`
  / `update_attributes`). The server does not send it there either: the bot
  stayed `dead` and the watchdog fired. So after the handshake the server
  **genuinely does not restore health** — it is not a missing client parse.

1. **Reproduce with a vanilla Bedrock client** on the same BDS/version/network:
   - If a vanilla client dies and respawns normally → it is a **client-library**
     issue (`bedrock-protocol` / NetherNet), not the server.
   - If a vanilla client also gets stuck → it is a **server** bug.
   - Capture the vanilla client's respawn packets with the `bedrock-protocol`
     **relay/proxy** (`node_modules/bedrock-protocol/src/relay.js`) to mirror the
     exact sequence.
2. **Client-side experiments** (once the expected sequence is known), in order:
   - After `SERVER_READY` (state 1), send a `player_auth_input` with the spawn
     position (server-authoritative ack) instead of just `_finishRespawn`.
   - Try `player_action { action: 'handled_teleport' }` (action 30) after the
     respawn teleport.
   - Try echoing the server's `respawn` packet `state` semantics exactly as the
     vanilla client does (e.g. reply `CLIENT_READY` only to `SERVER_SEARCHING`,
     nothing to `SERVER_READY`).
   - Keep `PACKET_DEBUG=1` on and diff our sequence against the vanilla capture.
3. **Only then** reduce `RESPAWN_RECONNECT_MS` / remove the watchdog if a clean
   in-place respawn is confirmed.

## Reporting upstream

- **Mojira** (`bugs.mojang.com`): only worth filing if step 1 shows a **vanilla
  client** stuck on a stock BDS — Mojira rejects reports from unsupported
  third-party clients. A useful report needs: BDS version/platform (1.26.52,
  Linux), exact steps (die → respawn), expected vs actual, server logs, and
  **no personal data** (use a throwaway account; no gamertag/xuid).
- If step 1 shows the vanilla client is fine, file it **upstream against
  `bedrock-protocol`** (PrismarineJS) with the minimal packet diff instead.

## Related pages

- [open-questions](open-questions.md) — current blocker text.
- [verification](verification.md) — row 12 (death + respawn + loot).
- [headless-client](headless-client.md) — how the bot perceives/acts.
