import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  MAX_RECORDING_IPC_BYTES,
  validateVoiceTrainingStopRequest,
} = require("./voice-training-ipc.cjs");

test("sandbox preload validates raw recording requests without loading a local module", async () => {
  const preload = await readFile(
    new URL("./preload.cjs", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(preload, /require\("\.\/voice-training-ipc\.cjs"\)/);
  assert.match(preload, /MAX_RECORDING_IPC_BYTES/);
  assert.match(preload, /bytes\.byteLength > MAX_RECORDING_IPC_BYTES/);
});

test("caps and reduces a renderer recording request before it crosses IPC", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  assert.deepEqual(
    validateVoiceTrainingStopRequest({
      id: "vt_owned",
      recording: {
        bytes,
        durationMs: 9 * 60_000,
        level: { peak: 1 },
        mimeType: "audio/webm;codecs=opus",
      },
    }),
    { id: "vt_owned", recording: { bytes } },
  );

  for (const request of [
    undefined,
    { id: "vt_owned", recording: { bytes: new ArrayBuffer(2) } },
    { id: "vt_owned", recording: { bytes: "not-bytes" } },
    {
      id: "vt_owned",
      recording: { bytes: new Uint8Array(MAX_RECORDING_IPC_BYTES + 1) },
    },
  ]) {
    assert.throws(
      () => validateVoiceTrainingStopRequest(request),
      /VOICE_TRAINING_IPC_INVALID_RECORDING/,
    );
  }
});
