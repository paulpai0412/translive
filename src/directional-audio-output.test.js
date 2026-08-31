import assert from "node:assert/strict";
import test from "node:test";

import { DirectionalAudioOutput } from "./directional-audio-output.js";

function fixture({ reportedSinkId } = {}) {
  const calls = [];
  const track = { stop: () => calls.push("track:stop") };
  const stream = { getAudioTracks: () => [track] };
  const gain = {
    gain: { value: 1 },
    connect(destination) {
      calls.push(`gain:connect:${destination}`);
      return destination;
    },
    disconnect() {
      calls.push("gain:disconnect");
    },
  };
  const source = {
    connect(node) {
      calls.push("source:connect");
      return node;
    },
    disconnect() {
      calls.push("source:disconnect");
    },
  };
  const context = {
    destination: "destination",
    sinkId: "",
    async setSinkId(id) {
      calls.push(`sink:${id}`);
      this.sinkId = reportedSinkId ?? id;
    },
    async resume() {
      calls.push("resume");
    },
    createGain() {
      calls.push("gain:create");
      return gain;
    },
    createMediaStreamSource(value) {
      assert.equal(value, stream);
      calls.push("source:create");
      return source;
    },
    async close() {
      calls.push("context:close");
    },
  };
  return { calls, context, gain, stream };
}

test("binds the direction sink before connecting a remote WebRTC stream", async () => {
  const { calls, context, stream } = fixture();
  const output = new DirectionalAudioOutput({
    createAudioContext: () => context,
    sinkId: "poly-headphones",
  });

  await output.prepare();
  await output.attach(stream);

  assert.deepEqual(calls, [
    "sink:poly-headphones",
    "gain:create",
    "source:create",
    "source:connect",
    "gain:connect:destination",
    "resume",
  ]);
});

test("fails closed when AudioContext cannot prove the requested sink", async () => {
  const { calls, context, stream } = fixture({ reportedSinkId: "wrong-sink" });
  const output = new DirectionalAudioOutput({
    createAudioContext: () => context,
    sinkId: "poly-headphones",
  });

  await assert.rejects(output.prepare(), /AUDIO_OUTPUT_SINK_MISMATCH/);
  await assert.rejects(output.attach(stream), /AUDIO_OUTPUT_NOT_PREPARED/);
  assert.deepEqual(calls, ["sink:poly-headphones", "context:close"]);
});

test("mutes through a GainNode and closes tracks and graph idempotently", async () => {
  const { calls, context, gain, stream } = fixture();
  const output = new DirectionalAudioOutput({
    createAudioContext: () => context,
    sinkId: "voicemeeter-aux",
  });
  await output.prepare();
  await output.attach(stream);

  output.setMuted(true);
  assert.equal(gain.gain.value, 0);
  output.setMuted(false);
  assert.equal(gain.gain.value, 1);
  await output.close();
  await output.close();

  assert.equal(calls.filter((call) => call === "context:close").length, 1);
  assert.equal(calls.filter((call) => call === "track:stop").length, 1);
  assert.ok(calls.includes("source:disconnect"));
  assert.ok(calls.includes("gain:disconnect"));
});
