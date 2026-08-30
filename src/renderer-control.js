async function stopPeers(active) {
  await Promise.allSettled(
    Object.values(active).map((peer) => Promise.resolve(peer.stop())),
  );
}

export async function releaseRendererResources({
  active,
  cancelStartup = async () => {},
  clearActive,
}) {
  try {
    await cancelStartup();
  } finally {
    const peers = active();
    clearActive();
    await stopPeers(peers);
  }
}

export function createRendererControlHandler({
  active,
  clearActive,
  onStop = async () => {},
}) {
  return async function handle(control) {
    if (control?.action === "mute") {
      const peer = active()[control.direction];
      if (!peer) throw new Error("Renderer peer is unavailable");
      peer.setMuted(Boolean(control.muted));
    } else if (["stop", "logout"].includes(control?.action)) {
      await releaseRendererResources({
        active,
        cancelStartup: onStop,
        clearActive,
      });
    } else {
      throw new Error("Unsupported renderer control action");
    }
    return { controlId: control.controlId, state: "applied" };
  };
}
