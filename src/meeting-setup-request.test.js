import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeMeetingSetupRequest } from "./meeting-setup-request.js";

test("keeps only display names when accepting renderer quick-setup data", () => {
  const setup = sanitizeMeetingSetupRequest({
    app: "teams",
    endpoints: {
      microphone: {
        id: "browser-media-device-id-must-not-cross-to-native-code",
        name: "Voicemeeter Out B2",
      },
      speaker: {
        id: "browser-render-device-id-must-not-cross-to-native-code",
        name: "Voicemeeter Input",
      },
    },
    restoreOnStop: true,
  });

  assert.deepEqual(setup, {
    app: "teams",
    endpoints: {
      microphone: { name: "Voicemeeter Out B2" },
      speaker: { name: "Voicemeeter Input" },
    },
    restoreOnStop: true,
  });
  assert.equal(JSON.stringify(setup).includes("browser-"), false);
});
