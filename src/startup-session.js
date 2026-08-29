function abortError() {
  const error = new Error("Translation startup canceled");
  error.name = "AbortError";
  return error;
}

export function createStartupSession({
  directions,
  createPeer,
  startRuntime,
  cancelRuntime,
  onPeerCreated = () => {},
}) {
  const peers = {};
  const stoppedPeers = new Set();
  let canceled = false;
  let runtimeRequested = false;

  async function stopPeer(peer) {
    if (!peer || stoppedPeers.has(peer)) return;
    stoppedPeers.add(peer);
    await peer.stop();
  }

  async function cleanup() {
    await Promise.allSettled(Object.values(peers).map(stopPeer));
    if (runtimeRequested) await cancelRuntime();
  }

  async function start(config) {
    try {
      for (const direction of directions) {
        if (canceled) throw abortError();
        const peer = await createPeer({ direction, channel: config[direction] });
        if (canceled) {
          await stopPeer(peer);
          throw abortError();
        }
        peers[direction] = peer;
        onPeerCreated(direction, peer);
        config[direction].sdp = peer.sdp;
      }

      if (canceled) throw abortError();
      runtimeRequested = true;
      const result = await startRuntime(config);
      if (canceled) {
        await cancelRuntime();
        throw abortError();
      }
      return { peers: { ...peers }, result };
    } catch (error) {
      await cleanup();
      if (canceled) throw abortError();
      throw error;
    }
  }

  async function cancel() {
    canceled = true;
    await cleanup();
  }

  return {
    cancel,
    isCanceled: () => canceled,
    start,
  };
}
