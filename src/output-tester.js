const DEFAULT_TONE_SECONDS = 0.4;
const DEFAULT_TONE_FREQUENCY = 880;

export function createOutputTester({
  contextFactory = () => new AudioContext(),
  toneDurationSeconds = DEFAULT_TONE_SECONDS,
  wait,
} = {}) {
  let state = "idle";
  const delay =
    wait ??
    ((ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }));

  async function play({ sinkId } = {}) {
    if (state === "playing") return;
    state = "playing";
    let context;
    try {
      context = await contextFactory();
      if (typeof context?.setSinkId !== "function") {
        throw new Error("AudioContext.setSinkId is not available");
      }
      await context.setSinkId(sinkId);
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = DEFAULT_TONE_FREQUENCY;
      gain.gain.setValueAtTime(0.2, context.currentTime);
      gain.gain.linearRampToValueAtTime(
        0,
        context.currentTime + toneDurationSeconds,
      );
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      await delay(toneDurationSeconds * 1000);
      oscillator.stop();
      state = "idle";
    } catch {
      state = "error";
    } finally {
      await context?.close?.();
    }
  }

  return {
    play,
    state: () => state,
  };
}
