import assert from "node:assert/strict";
import test from "node:test";

import { FakeVoiceConversionSidecar } from "../fixtures/fake-voice-conversion-sidecar.mjs";
import { createVoiceConversionFrame } from "./voice-conversion-protocol.js";

function frame({ direction, seq, streamId }) {
  return createVoiceConversionFrame({
    direction,
    payload: Buffer.from(new Float32Array([0.25, -0.25]).buffer),
    sampleRate: 48_000,
    seq,
    streamId,
    timestampUs: seq * 1_000,
  });
}

test("test-only fake sidecars prove warm health frame stop and TX/RX state isolation", async () => {
  const tx = new FakeVoiceConversionSidecar({ direction: "tx" });
  const rx = new FakeVoiceConversionSidecar({ direction: "rx" });

  assert.deepEqual(
    await tx.warm({ profileId: "vp_owned", provider: "cpu-baseline" }),
    {
      ready: true,
    },
  );
  assert.deepEqual(
    await rx.warm({ profileId: "vp_owned", provider: "cpu-baseline" }),
    {
      ready: true,
    },
  );
  assert.deepEqual(await tx.health(), { ready: true });
  assert.deepEqual(
    await tx.frame(frame({ direction: "tx", seq: 0, streamId: "vc_tx_001" })),
    frame({ direction: "tx", seq: 0, streamId: "vc_tx_001" }),
  );
  assert.deepEqual(
    await rx.frame(frame({ direction: "rx", seq: 0, streamId: "vc_rx_001" })),
    frame({ direction: "rx", seq: 0, streamId: "vc_rx_001" }),
  );
  assert.deepEqual(await tx.stop(), { stopped: true });
  assert.deepEqual(await rx.health(), { ready: true });
  await assert.rejects(
    tx.frame(frame({ direction: "tx", seq: 0, streamId: "vc_tx_001" })),
    /FAKE_VOICE_SIDECAR_STOPPED/,
  );
  assert.deepEqual(
    tx.calls.map((call) => call.action),
    ["warm", "health", "frame", "stop"],
  );
  assert.deepEqual(
    rx.calls.map((call) => call.action),
    ["warm", "frame", "health"],
  );
});
