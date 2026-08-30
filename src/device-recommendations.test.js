import assert from "node:assert/strict";
import test from "node:test";

import {
  DEVICE_PREFERENCE_STORAGE_KEY,
  emptyDevicePreferences,
  isVirtualDevice,
  loadDevicePreferences,
  recommendModeDevices,
  rememberDeviceLabel,
  saveDevicePreferences,
} from "./device-recommendations.js";

const currentWindowsDevices = {
  inputs: [
    {
      deviceId: "poly-mic",
      kind: "audioinput",
      label: "耳机式麦克风 (Poly BT600)",
    },
    {
      deviceId: "realtek-mic",
      kind: "audioinput",
      label: "Microphone Array on SoundWire Device (Realtek Microphone)",
    },
    {
      deviceId: "vm-b1",
      kind: "audioinput",
      label: "Voicemeeter Out B1 (VB-Audio Voicemeeter VAIO)",
    },
    {
      deviceId: "vm-b2",
      kind: "audioinput",
      label: "Voicemeeter Out B2 (VB-Audio Voicemeeter VAIO)",
    },
  ],
  outputs: [
    {
      deviceId: "poly-headphones",
      kind: "audiooutput",
      label: "头戴式耳机 (Poly BT600)",
    },
    {
      deviceId: "realtek-speakers",
      kind: "audiooutput",
      label: "扬声器 (Realtek Speaker)",
    },
    {
      deviceId: "vm-aux",
      kind: "audiooutput",
      label: "Voicemeeter AUX Input (VB-Audio Voicemeeter VAIO)",
    },
    {
      deviceId: "vm-input",
      kind: "audiooutput",
      label: "Voicemeeter Input (VB-Audio Voicemeeter VAIO)",
    },
  ],
};

const genericUsbDevices = {
  inputs: [
    {
      deviceId: "jabra-mic",
      kind: "audioinput",
      label: "Jabra USB Headset Microphone",
    },
    {
      deviceId: "usb-mic",
      kind: "audioinput",
      label: "USB Microphone",
    },
    {
      deviceId: "cable-b-output",
      kind: "audioinput",
      label: "Cable-B Output (VB-Audio Cable B)",
    },
  ],
  outputs: [
    {
      deviceId: "jabra-headphones",
      kind: "audiooutput",
      label: "Jabra USB Headset",
    },
    {
      deviceId: "desk-speakers",
      kind: "audiooutput",
      label: "USB Speaker",
    },
    {
      deviceId: "cable-a-input",
      kind: "audiooutput",
      label: "Cable-A Input (VB-Audio Cable A)",
    },
  ],
};

test("recommends current VoiceMeeter virtual endpoints and physical Poly devices without confusing their roles", () => {
  const recommendation = recommendModeDevices({
    devices: currentWindowsDevices,
    mode: "meeting",
    preferences: emptyDevicePreferences(),
    routeProfile: "voicemeeter",
  });

  assert.deepEqual(
    Object.fromEntries(
      Object.entries(recommendation.selections).map(([slot, device]) => [
        slot,
        device?.deviceId,
      ]),
    ),
    {
      headphones: "poly-headphones",
      physicalMic: "poly-mic",
      rxSource: "vm-b1",
      txSink: "vm-aux",
    },
  );
  assert.deepEqual(recommendation.missing, []);
  assert.equal(isVirtualDevice(currentWindowsDevices.inputs[2]), true);
  assert.equal(isVirtualDevice(currentWindowsDevices.inputs[0]), false);
});

test("uses generic headset and USB terms for VB-CABLE recommendations without vendor-specific rules", () => {
  const recommendation = recommendModeDevices({
    devices: genericUsbDevices,
    mode: "meeting",
    preferences: emptyDevicePreferences(),
    routeProfile: "vb-cable",
  });

  assert.deepEqual(
    Object.fromEntries(
      Object.entries(recommendation.selections).map(([slot, device]) => [
        slot,
        device?.deviceId,
      ]),
    ),
    {
      headphones: "jabra-headphones",
      physicalMic: "jabra-mic",
      rxSource: "cable-b-output",
      txSink: "cable-a-input",
    },
  );
});

test("keeps bounded per-mode manual physical labels across a mode switch", () => {
  let preferences = emptyDevicePreferences();
  preferences = rememberDeviceLabel(preferences, {
    label: "Microphone Array on SoundWire Device (Realtek Microphone)",
    mode: "meeting",
    slot: "physicalMic",
  });
  preferences = rememberDeviceLabel(preferences, {
    label: "扬声器 (Realtek Speaker)",
    mode: "media",
    slot: "headphones",
  });

  const meeting = recommendModeDevices({
    devices: currentWindowsDevices,
    mode: "meeting",
    preferences,
    routeProfile: "voicemeeter",
  });
  const media = recommendModeDevices({
    devices: currentWindowsDevices,
    mode: "media",
    preferences,
    routeProfile: "voicemeeter",
  });

  assert.equal(meeting.selections.physicalMic.deviceId, "realtek-mic");
  assert.equal(media.selections.headphones.deviceId, "realtek-speakers");
  assert.equal(media.selections.rxSource.deviceId, "vm-b1");
  assert.deepEqual(Object.keys(preferences.byMode.meeting), ["physicalMic"]);
  assert.deepEqual(Object.keys(preferences.byMode.media), ["headphones"]);
});

test("falls back when a saved device disappears and reports missing route-valid virtual endpoints", () => {
  const preferences = rememberDeviceLabel(emptyDevicePreferences(), {
    label: "Removed USB Headset",
    mode: "microphone",
    slot: "physicalMic",
  });
  const fallback = recommendModeDevices({
    devices: genericUsbDevices,
    mode: "microphone",
    preferences,
    routeProfile: "vb-cable",
  });
  assert.equal(fallback.selections.physicalMic.deviceId, "jabra-mic");
  assert.equal(fallback.selections.txSink.deviceId, "cable-a-input");

  const missing = recommendModeDevices({
    devices: {
      inputs: genericUsbDevices.inputs.filter(
        (device) => device.deviceId !== "cable-b-output",
      ),
      outputs: genericUsbDevices.outputs.filter(
        (device) => device.deviceId !== "cable-a-input",
      ),
    },
    mode: "meeting",
    preferences: emptyDevicePreferences(),
    routeProfile: "vb-cable",
  });
  assert.deepEqual(missing.missing, ["rxSource", "txSink"]);
  assert.equal(missing.selections.physicalMic.deviceId, "jabra-mic");
  assert.equal(missing.selections.headphones.deviceId, "jabra-headphones");
});

test("stores only bounded labels in local device preferences", () => {
  const storage = new Map();
  const storageLike = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  };
  const longLabel = `USB Headset ${"x".repeat(500)}`;
  const preferences = rememberDeviceLabel(emptyDevicePreferences(), {
    label: longLabel,
    mode: "media",
    slot: "headphones",
  });

  saveDevicePreferences(storageLike, preferences);
  const serialized = storage.get(DEVICE_PREFERENCE_STORAGE_KEY);
  assert.equal(typeof serialized, "string");
  assert.doesNotMatch(serialized, /deviceId|token|secret/i);
  assert.equal(
    loadDevicePreferences(storageLike).byMode.media.headphones.length <
      longLabel.length,
    true,
  );
});
