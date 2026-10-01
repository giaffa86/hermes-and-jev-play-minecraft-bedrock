import { setTimeout as delay } from 'node:timers/promises';

// Capture the peer before NetherNet clears it, including failed negotiations.
export function trackNethernetClient (client) {
  const install = () => {
    const transport = client.connection?.nethernet;
    if (!transport || transport._lifecycleTracked) return;
    transport._lifecycleTracked = true;
    const original = transport.handleConnectionClosed;
    transport.handleConnectionClosed = function (connection, reason) {
      client._lifecycleRTC = connection.rtcConnection;
      client._lifecycleCloseReason = reason;
      return original.call(this, connection, reason);
    };
  };
  install();
  client.once('connect_allowed', install);
  return client;
}

export function closeBedrockClient (client, reason = 'client shutdown') {
  if (!client) return Promise.resolve();
  if (client._lifecycleClosing) return client._lifecycleClosing;
  const rtc = client.connection?.nethernet?.rtcConnection || client._lifecycleRTC;
  client._lifecycleClosing = Promise.resolve().then(async () => {
    try {
      if (!client._closed && client.startGameData?.player_position) {
        client.write('disconnect', { hide_disconnect_screen: false, message: reason, filtered_message: '' });
        // Allow the game disconnect to leave SCTP before closing the channels.
        await delay(250);
      }
    } finally {
      client.close();
      const results = await Promise.allSettled([rtc?.close(), client._nethernetCleanup]);
      await delay(150); // discovery socket closes after 100 ms
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    }
  });
  return client._lifecycleClosing;
}
