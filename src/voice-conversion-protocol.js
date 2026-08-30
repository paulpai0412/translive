export const VOICE_CONVERSION_PROTOCOL_VERSION = 1;

const CONTROL_TYPES = new Set(["warm", "health", "stop"]);
const DIRECTIONS = new Set(["tx", "rx"]);
const LOCAL_TRANSPORTS = new Set(["named-pipe", "stdio"]);
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_SAMPLE_RATE = 192_000;
const MIN_SAMPLE_RATE = 8_000;
const STREAM_ID = /^vc_[A-Za-z0-9_-]{3,96}$/;

function fail(code) {
  throw new Error(`VOICE_CONVERSION_PROTOCOL_${code}`);
}

function direction(value) {
  if (!DIRECTIONS.has(value)) fail("INVALID_DIRECTION");
  return value;
}

function streamId(value) {
  if (typeof value !== "string" || !STREAM_ID.test(value)) {
    fail("INVALID_STREAM");
  }
  return value;
}

function transport(value = "stdio") {
  if (!LOCAL_TRANSPORTS.has(value)) fail("NON_LOCAL_TRANSPORT");
  return value;
}

function sequence(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail("INVALID_SEQUENCE");
  return value;
}

function timestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail("INVALID_TIMESTAMP");
  return value;
}

function audioFormat({ channels, sampleRate }) {
  if (
    !Number.isSafeInteger(sampleRate) ||
    sampleRate < MIN_SAMPLE_RATE ||
    sampleRate > MAX_SAMPLE_RATE
  ) {
    fail("INVALID_SAMPLE_RATE");
  }
  if (!Number.isSafeInteger(channels) || channels < 1 || channels > 2) {
    fail("INVALID_CHANNELS");
  }
  return { channels, sampleRate };
}

function framePayload({ channels, frameBytes, payload }) {
  if (!Buffer.isBuffer(payload)) fail("INVALID_PAYLOAD");
  if (
    !Number.isSafeInteger(frameBytes) ||
    frameBytes <= 0 ||
    frameBytes > MAX_FRAME_BYTES ||
    frameBytes !== payload.byteLength ||
    frameBytes % (Float32Array.BYTES_PER_ELEMENT * channels) !== 0
  ) {
    fail("INVALID_FRAME_BYTES");
  }
  return { frameBytes, payload };
}

function envelopeFields(value) {
  if (value?.version !== VOICE_CONVERSION_PROTOCOL_VERSION) {
    fail("UNSUPPORTED_VERSION");
  }
  return {
    direction: direction(value.direction),
    streamId: streamId(value.streamId),
    transport: transport(value.transport),
    version: value.version,
  };
}

export function createVoiceConversionControl({
  direction: requestedDirection,
  streamId: requestedStreamId,
  transport: requestedTransport = "stdio",
  type,
} = {}) {
  if (!CONTROL_TYPES.has(type)) fail("INVALID_CONTROL");
  return {
    direction: direction(requestedDirection),
    streamId: streamId(requestedStreamId),
    transport: transport(requestedTransport),
    type,
    version: VOICE_CONVERSION_PROTOCOL_VERSION,
  };
}

export function createVoiceConversionFrame({
  channels = 1,
  direction: requestedDirection,
  payload,
  sampleRate,
  seq,
  streamId: requestedStreamId,
  timestampUs,
  transport: requestedTransport = "stdio",
} = {}) {
  const envelope = {
    ...audioFormat({ channels, sampleRate }),
    direction: direction(requestedDirection),
    frameBytes: payload?.byteLength,
    payload,
    sampleRate,
    seq: sequence(seq),
    streamId: streamId(requestedStreamId),
    timestampUs: timestamp(timestampUs),
    transport: transport(requestedTransport),
    type: "frame",
    version: VOICE_CONVERSION_PROTOCOL_VERSION,
  };
  framePayload(envelope);
  return envelope;
}

/**
 * Per-sidecar boundary validator. The protocol has no socket address field and
 * permits only stdio or named-pipe transports, never TCP or LAN endpoints.
 */
export class VoiceConversionProtocolValidator {
  #streams = new Map();

  validate(value) {
    if (value?.type !== "frame") fail("INVALID_TYPE");
    const envelope = envelopeFields(value);
    const format = audioFormat(value);
    const payload = framePayload({ ...format, ...value });
    const seq = sequence(value.seq);
    const timestampUs = timestamp(value.timestampUs);
    const previous = this.#streams.get(envelope.streamId);
    if (previous) {
      if (previous.direction !== envelope.direction)
        fail("STREAM_DIRECTION_CHANGED");
      if (seq !== previous.seq + 1) fail("OUT_OF_ORDER_SEQUENCE");
      if (timestampUs <= previous.timestampUs) fail("NON_MONOTONIC_TIMESTAMP");
    }
    this.#streams.set(envelope.streamId, {
      direction: envelope.direction,
      seq,
      timestampUs,
    });
    return {
      ...format,
      ...envelope,
      ...payload,
      seq,
      timestampUs,
      type: "frame",
    };
  }
}
