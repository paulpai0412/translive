import { randomUUID } from "node:crypto";

const DIRECTIONS = ["tx", "rx"];
const MODE_DIRECTIONS = Object.freeze({
  meeting: DIRECTIONS,
  media: ["rx"],
  microphone: ["tx"],
});
const SOURCE_KIND = "audioinput";
const SINK_KIND = "audiooutput";

function normalizedEndpointName(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function matchesCableRole(name, bus, side) {
  const normalized = normalizedEndpointName(name);
  return (
    normalized.includes(`cable${bus}${side}`) ||
    normalized.includes(`${side}cable${bus}`)
  );
}

function isVirtualEndpoint(name) {
  const normalized = normalizedEndpointName(name);
  return (
    normalized.includes("voicemeeter") ||
    (normalized.includes("cable") &&
      (normalized.includes("input") || normalized.includes("output")))
  );
}

function matchesVoiceMeeterRole(name, role) {
  const normalized = normalizedEndpointName(name);
  return role === "tx-sink"
    ? normalized.includes("voicemeeterauxinput")
    : normalized.includes("voicemeeteroutb1");
}

function assertEndpoint(channel, direction) {
  if (
    typeof channel?.sourceEndpointId !== "string" ||
    channel.sourceEndpointId.length === 0
  ) {
    throw new Error(`${direction.toUpperCase()} source requires an endpoint`);
  }
  if (
    typeof channel?.sinkEndpointId !== "string" ||
    channel.sinkEndpointId.length === 0
  ) {
    throw new Error(`${direction.toUpperCase()} sink requires an endpoint`);
  }
  if (channel.sourceEndpointKind !== SOURCE_KIND) {
    throw new Error(`${direction.toUpperCase()} source must be an audioinput`);
  }
  if (channel.sinkEndpointKind !== SINK_KIND) {
    throw new Error(`${direction.toUpperCase()} sink must be an audiooutput`);
  }
}

export function directionsForMode(mode = "meeting") {
  const directions = MODE_DIRECTIONS[mode];
  if (!directions) throw new Error(`Unsupported translation mode: ${mode}`);
  return directions;
}

// Assistant mode discards model audio, so the translation-only playout
// constraints (physical headphones, explicit headphone confirmation) do not
// apply. What still matters: a real microphone in, the meeting mix from
// Cable-B, and answers egressing via Cable-A.
export function validateAssistantConfig(config) {
  for (const direction of ["tx", "rx"]) {
    assertEndpoint(config?.[direction], direction);
  }
  const endpoints = [
    config.tx.sourceEndpointId,
    config.tx.sinkEndpointId,
    config.rx.sourceEndpointId,
    config.rx.sinkEndpointId,
  ];
  if (new Set(endpoints).size !== endpoints.length) {
    throw new Error("Audio endpoints must be unique");
  }
  if (isVirtualEndpoint(config.tx.sourceEndpointName)) {
    throw new Error(
      "TX source must be a physical microphone, not a virtual endpoint",
    );
  }
  const profile = config.routeProfile ?? "vb-cable";
  if (profile === "vb-cable") {
    if (!matchesCableRole(config.tx.sinkEndpointName, "a", "input")) {
      throw new Error("TX sink must be the Cable-A Input playback endpoint");
    }
    if (!matchesCableRole(config.rx.sourceEndpointName, "b", "output")) {
      throw new Error(
        "RX source must be the Cable-B Output recording endpoint",
      );
    }
    return;
  }
  if (profile === "voicemeeter") {
    if (!matchesVoiceMeeterRole(config.tx.sinkEndpointName, "tx-sink")) {
      throw new Error("TX sink must be the Voicemeeter AUX Input endpoint");
    }
    if (!matchesVoiceMeeterRole(config.rx.sourceEndpointName, "rx-source")) {
      throw new Error("RX source must be the Voicemeeter Out B1 endpoint");
    }
    return;
  }
  throw new Error(`Unsupported route profile: ${profile}`);
}

export function validateDualChannelConfig(config) {
  const directions = directionsForMode(config.mode);
  directions.forEach((direction) =>
    assertEndpoint(config?.[direction], direction),
  );
  const endpoints = directions.flatMap((direction) => [
    config[direction].sourceEndpointId,
    config[direction].sinkEndpointId,
  ]);
  if (new Set(endpoints).size !== endpoints.length) {
    throw new Error("Audio endpoints must be unique");
  }
  if (directions.includes("rx") && config.headphonesConfirmed !== true) {
    throw new Error("Headphones must be explicitly confirmed");
  }
  if (
    directions.includes("tx") &&
    isVirtualEndpoint(config.tx.sourceEndpointName)
  ) {
    throw new Error(
      "TX source must be a physical microphone, not a virtual endpoint",
    );
  }
  if (
    directions.includes("rx") &&
    isVirtualEndpoint(config.rx.sinkEndpointName)
  ) {
    throw new Error(
      "RX sink must be physical headphones, not a virtual endpoint",
    );
  }

  const profile = config.routeProfile ?? "vb-cable";
  if (profile === "vb-cable") {
    if (
      directions.includes("tx") &&
      !matchesCableRole(config.tx.sinkEndpointName, "a", "input")
    ) {
      throw new Error("TX sink must be the Cable-A Input playback endpoint");
    }
    if (
      directions.includes("rx") &&
      !matchesCableRole(config.rx.sourceEndpointName, "b", "output")
    ) {
      throw new Error(
        "RX source must be the Cable-B Output recording endpoint",
      );
    }
    return;
  }
  if (profile === "voicemeeter") {
    if (
      directions.includes("tx") &&
      !matchesVoiceMeeterRole(config.tx.sinkEndpointName, "tx-sink")
    ) {
      throw new Error("TX sink must be the Voicemeeter AUX Input endpoint");
    }
    if (
      directions.includes("rx") &&
      !matchesVoiceMeeterRole(config.rx.sourceEndpointName, "rx-source")
    ) {
      throw new Error("RX source must be the Voicemeeter Out B1 endpoint");
    }
    return;
  }
  throw new Error(`Unsupported route profile: ${profile}`);
}

function aggregateStatus(states) {
  const values = Object.values(states).filter((state) => state !== "disabled");
  if (values.every((state) => state === "failed")) return "blocked";
  if (values.includes("failed")) return "degraded";
  if (values.every((state) => state === "live" || state === "muted"))
    return "live";
  if (values.every((state) => state === "stopped")) return "stopped";
  return "connecting";
}

export async function startDualChannelRun(
  config,
  {
    openChannel,
    evidence,
    onStateChange = () => {},
    now = Date.now,
    validate = validateDualChannelConfig,
  },
) {
  validate(config);
  const activeDirections = directionsForMode(config.mode);

  const states = Object.fromEntries(
    DIRECTIONS.map((direction) => [
      direction,
      activeDirections.includes(direction) ? "connecting" : "disabled",
    ]),
  );
  let stopping = false;
  const transition = (direction, state, detail) => {
    if (states[direction] === "stopped") return;
    states[direction] = state;
    const atMs = now();
    evidence?.recordState(direction, state, atMs, detail);
    onStateChange({
      direction,
      state,
      atMs,
      aggregate: aggregateStatus(states),
    });
  };

  activeDirections.forEach((direction) => transition(direction, "connecting"));
  const outcomes = await Promise.allSettled(
    activeDirections.map((direction) => {
      const correlationId = `translive-${direction}-${randomUUID()}`;
      return openChannel({
        direction,
        correlationId,
        // A correlation ID is distinct from the actual app-server thread ID.
        threadId: correlationId,
        ...config[direction],
      });
    }),
  );

  outcomes.forEach((outcome, index) => {
    if (outcome.status === "rejected") {
      const direction = activeDirections[index];
      evidence?.recordError(direction, outcome.reason, { atMs: now() });
      transition(direction, "failed", outcome.reason?.message);
    }
  });

  let stopPromise;
  const liveChannels = outcomes
    .map((outcome, index) => ({
      outcome,
      direction: activeDirections[index],
    }))
    .filter(({ outcome }) => outcome.status === "fulfilled");
  const stopChannel = async ({ outcome, direction }) => {
    try {
      await outcome.value.stop();
    } catch (error) {
      evidence?.recordError(direction, error, { atMs: now() });
    }
    transition(direction, "stopped");
  };

  return {
    status: () => ({ ...states }),
    aggregateStatus: () => aggregateStatus(states),
    allFailed: () =>
      activeDirections.every((direction) => states[direction] === "failed"),
    answerApplied: (direction) => {
      if (!DIRECTIONS.includes(direction) || states[direction] !== "connecting")
        return false;
      transition(direction, "live");
      return true;
    },
    setMuted: (direction, muted) => {
      if (
        !DIRECTIONS.includes(direction) ||
        states[direction] === "failed" ||
        states[direction] === "stopping" ||
        states[direction] === "stopped"
      )
        return false;
      if (muted && states[direction] === "live") {
        transition(direction, "muted");
        return true;
      }
      if (!muted && states[direction] === "muted") {
        transition(direction, "live");
        return true;
      }
      return false;
    },
    recordInputAudio: (direction, atMs) =>
      evidence?.recordInputAudio(direction, atMs),
    recordOutputAudio: (direction, atMs) =>
      evidence?.recordOutputAudio(direction, atMs),
    recordWebRtcStats: (direction, stats, atMs) =>
      evidence?.recordWebRtcStats(direction, stats, atMs),
    recordTranscriptTimestamp: (direction, role, atMs) =>
      evidence?.recordTranscriptTimestamp(direction, role, atMs),
    handleRealtimeEvent: (direction, { method, params = {}, atMs = now() }) => {
      if (!DIRECTIONS.includes(direction) || states[direction] === "stopped")
        return;
      if (method === "thread/realtime/outputAudio/delta") {
        evidence?.recordOutputAudio(direction, atMs);
      }
      if (
        method === "thread/realtime/transcript/delta" ||
        method === "thread/realtime/transcript/done"
      ) {
        evidence?.recordTranscriptTimestamp(direction, params.role, atMs);
      }
      if (method === "thread/realtime/error") {
        evidence?.recordError(direction, params.message, {
          requestId: params.requestId,
          atMs,
        });
        transition(direction, "failed", params.message);
      }
      if (
        method === "thread/realtime/closed" &&
        !stopping &&
        states[direction] !== "stopping"
      ) {
        transition(direction, "failed", params.reason);
      }
    },
    stop: () => {
      if (stopPromise) return stopPromise;
      stopping = true;
      liveChannels.forEach(({ direction }) => {
        if (states[direction] !== "failed") transition(direction, "stopping");
      });
      stopPromise = Promise.all(liveChannels.map(stopChannel)).then(() =>
        evidence?.finish(now()),
      );
      return stopPromise;
    },
  };
}
