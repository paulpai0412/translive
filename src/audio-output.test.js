import assert from "node:assert/strict";
import test from "node:test";

import { attachAudioToSink } from "./audio-output.js";

test("binds the requested sink before attaching or playing a remote stream", async () => {
  const calls = [];
  const stream = { id: "remote" };
  const audio = {
    autoplay: true,
    set srcObject(value) {
      calls.push(["srcObject", value]);
    },
    async setSinkId(id) {
      calls.push(["sink", id]);
    },
    async play() {
      calls.push(["play"]);
    },
  };

  await attachAudioToSink({ audio, sinkId: "voicemeeter-aux", stream });

  assert.equal(audio.autoplay, false);
  assert.deepEqual(calls, [
    ["sink", "voicemeeter-aux"],
    ["srcObject", stream],
    ["play"],
  ]);
});

test("does not attach the remote stream when sink binding fails", async () => {
  let attached = false;
  const audio = {
    set srcObject(_value) {
      attached = true;
    },
    async setSinkId() {
      throw new Error("sink unavailable");
    },
    async play() {},
  };

  await assert.rejects(
    attachAudioToSink({ audio, sinkId: "missing", stream: {} }),
    /sink unavailable/,
  );
  assert.equal(attached, false);
});
