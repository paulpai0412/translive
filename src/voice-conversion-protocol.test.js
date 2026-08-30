import assert from "node:assert/strict";
import test from "node:test";

import {
  VOICE_CONVERSION_PROTOCOL_VERSION,
  VoiceConversionProtocolValidator,
  createVoiceConversionControl,
  createVoiceConversionFrame,
} from "./voice-conversion-protocol.js";

function frame(overrides = {}) {
  return {
    channels: 1,
    direction: "rx",
    frameBytes: 16,
    payload: Buffer.alloc(16),
    sampleRate: 48_000,
    seq: 0,
    streamId: "vc_rx_001",
    timestampUs: 1_000,
    transport: "stdio",
    type: "frame",
    version: VOICE_CONVERSION_PROTOCOL_VERSION,
    ...overrides,
  };
}

test("accepts versioned local Float32 frames in one monotonic direction stream", () => {
  const validator = new VoiceConversionProtocolValidator();

  assert.deepEqual(validator.validate(frame()), frame());
  assert.deepEqual(
    validator.validate(frame({ seq: 1, timestampUs: 1_333 })),
    frame({ seq: 1, timestampUs: 1_333 }),
  );
  assert.deepEqual(
    createVoiceConversionControl({
      direction: "rx",
      streamId: "vc_rx_001",
      type: "health",
    }),
    {
      direction: "rx",
      streamId: "vc_rx_001",
      transport: "stdio",
      type: "health",
      version: VOICE_CONVERSION_PROTOCOL_VERSION,
    },
  );
});

test("rejects TCP, frame-size, rate, channel, sequence, and timeline violations", () => {
  const validator = new VoiceConversionProtocolValidator();
  validator.validate(frame());

  for (const invalid of [
    frame({ transport: "tcp" }),
    frame({ frameBytes: 12, payload: Buffer.alloc(16) }),
    frame({ frameBytes: 18, payload: Buffer.alloc(18) }),
    frame({ sampleRate: 2_000 }),
    frame({ channels: 3 }),
    frame({ seq: 2, timestampUs: 1_333 }),
    frame({ seq: 1, timestampUs: 1_000 }),
    frame({ seq: 1, streamId: "../../rx", timestampUs: 1_333 }),
  ]) {
    assert.throws(
      () => validator.validate(invalid),
      (error) => {
        assert.match(error.message, /^VOICE_CONVERSION_PROTOCOL_/);
        return true;
      },
    );
  }
});

test("creates frames only with exact Float32 payload byte lengths and local transports", () => {
  assert.deepEqual(
    createVoiceConversionFrame({
      channels: 2,
      direction: "tx",
      payload: Buffer.alloc(32),
      sampleRate: 48_000,
      seq: 0,
      streamId: "vc_tx_001",
      timestampUs: 4,
    }),
    {
      channels: 2,
      direction: "tx",
      frameBytes: 32,
      payload: Buffer.alloc(32),
      sampleRate: 48_000,
      seq: 0,
      streamId: "vc_tx_001",
      timestampUs: 4,
      transport: "stdio",
      type: "frame",
      version: VOICE_CONVERSION_PROTOCOL_VERSION,
    },
  );
  assert.throws(
    () =>
      createVoiceConversionFrame({
        direction: "tx",
        payload: Buffer.alloc(4),
        sampleRate: 48_000,
        seq: 0,
        streamId: "vc_tx_001",
        timestampUs: 4,
        transport: "lan",
      }),
    (error) => {
      assert.match(error.message, /^VOICE_CONVERSION_PROTOCOL_/);
      return true;
    },
  );
});
