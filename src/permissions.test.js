import assert from "node:assert/strict";
import test from "node:test";

import { allowsLocalAudioPermission } from "./permissions.js";

test("allows only local audio capture and local speaker selection", () => {
  assert.equal(
    allowsLocalAudioPermission({
      permission: "media",
      origin: "file:///app/index.html",
      details: { mediaTypes: ["audio"] },
    }),
    true,
  );
  assert.equal(
    allowsLocalAudioPermission({
      permission: "media",
      origin: "file:///app/index.html",
      details: { mediaType: "audio" },
    }),
    true,
  );
  assert.equal(
    allowsLocalAudioPermission({
      permission: "speaker-selection",
      origin: "file:///app/index.html",
    }),
    true,
  );
  assert.equal(
    allowsLocalAudioPermission({
      permission: "media",
      origin: "file:///app/index.html",
      details: {},
    }),
    false,
  );
  assert.equal(
    allowsLocalAudioPermission({
      permission: "media",
      origin: "file:///app/index.html",
      details: { mediaTypes: ["video"] },
    }),
    false,
  );
  assert.equal(
    allowsLocalAudioPermission({
      permission: "media",
      origin: "https://example.test",
      details: { mediaTypes: ["audio"] },
    }),
    false,
  );
});
