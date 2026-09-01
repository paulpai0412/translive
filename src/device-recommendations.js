const LABEL_LIMIT = 160;
const MODES = new Set(["meeting", "media", "microphone"]);
const PHYSICAL_SLOTS_BY_MODE = Object.freeze({
  meeting: ["physicalMic", "headphones"],
  media: ["headphones"],
  microphone: ["physicalMic"],
});
const VIRTUAL_ENDPOINTS = Object.freeze({
  "vb-cable": {
    rxSource: /\bCable[- ]?B Output\b/i,
    txSink: /\bCable[- ]?A Input\b/i,
  },
  voicemeeter: {
    rxSource: /^Voicemeeter Out B1\b/i,
    txSink: /^Voicemeeter AUX Input\b/i,
  },
});
const VIRTUAL_LABEL =
  /\b(?:voicemeeter|vb-audio|vb-cable|cable[- ]?[ab])\b|虛擬|虚拟/i;
const PSEUDO_DEVICE_ID = /^(?:default|communications)$/i;
const PSEUDO_LABEL = /^(?:default|communications)\s*-/i;
const MICROPHONE_TERMS = /\b(?:microphone|mic)\b|麥克風|麦克风/i;
const HEADSET_TERMS = /\b(?:headset|headphone|earphone)\b|耳機|耳机/i;
const WIRELESS_TERMS = /\b(?:bluetooth|bt\d*)\b/i;
const USB_TERMS = /\busb\b/i;
const SPEAKER_TERMS = /\b(?:speaker|monitor)\b|喇叭|扬声器/i;

export const DEVICE_PREFERENCE_STORAGE_KEY = "translive.device-preferences.v1";

function label(value) {
  return typeof value?.label === "string" ? value.label.trim() : "";
}

function normalized(value) {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase();
}

function boundedLabel(value) {
  return Array.from(String(value ?? "").trim())
    .slice(0, LABEL_LIMIT)
    .join("");
}

function isPseudoDevice(device) {
  return (
    PSEUDO_DEVICE_ID.test(String(device?.deviceId ?? "")) ||
    PSEUDO_LABEL.test(label(device))
  );
}

function isDevice(device) {
  return Boolean(device?.deviceId && label(device));
}

function rankPhysical(device, slot) {
  const value = label(device);
  if (!isDevice(device) || isPseudoDevice(device) || isVirtualDevice(device)) {
    return Number.NEGATIVE_INFINITY;
  }
  const headsetScore = HEADSET_TERMS.test(value) ? 60 : 0;
  const wirelessScore = WIRELESS_TERMS.test(value) ? 25 : 0;
  const usbScore = USB_TERMS.test(value) ? 10 : 0;
  if (slot === "physicalMic") {
    return (
      (MICROPHONE_TERMS.test(value) ? 80 : 1) +
      headsetScore +
      wirelessScore +
      usbScore
    );
  }
  if (slot === "headphones") {
    if (headsetScore) return headsetScore + wirelessScore + usbScore + 80;
    if (SPEAKER_TERMS.test(value)) return 10;
    return 1;
  }
  return Number.NEGATIVE_INFINITY;
}

function bestPhysical(devices, slot, preferredLabel) {
  const preferred = normalized(preferredLabel);
  if (preferred) {
    const saved = devices.find(
      (device) =>
        rankPhysical(device, slot) > Number.NEGATIVE_INFINITY &&
        normalized(label(device)) === preferred,
    );
    if (saved) return { device: saved, source: "saved" };
  }
  const candidates = devices
    .map((device) => ({ device, score: rankPhysical(device, slot) }))
    .filter(({ score }) => score > Number.NEGATIVE_INFINITY)
    .sort(
      (left, right) =>
        right.score - left.score ||
        normalized(label(left.device)).localeCompare(
          normalized(label(right.device)),
        ),
    );
  return candidates[0]
    ? { device: candidates[0].device, source: "recommended" }
    : undefined;
}

function virtualDevice(devices, profile, slot) {
  const pattern = VIRTUAL_ENDPOINTS[profile]?.[slot];
  if (!pattern) return undefined;
  return devices.find(
    (device) => isDevice(device) && pattern.test(label(device)),
  );
}

function normalizeByMode(value) {
  const source = value?.byMode ?? {};
  const byMode = {};
  for (const mode of MODES) {
    const allowed = new Set(PHYSICAL_SLOTS_BY_MODE[mode]);
    const preferences = {};
    for (const [slot, entry] of Object.entries(source[mode] ?? {})) {
      const saved = boundedLabel(entry);
      if (allowed.has(slot) && saved) preferences[slot] = saved;
    }
    byMode[mode] = preferences;
  }
  return { byMode, version: 1 };
}

export function emptyDevicePreferences() {
  return normalizeByMode();
}

export function isVirtualDevice(device) {
  return VIRTUAL_LABEL.test(label(device));
}

export function rememberDeviceLabel(preferences, { label: value, mode, slot }) {
  const next = normalizeByMode(preferences);
  if (!MODES.has(mode) || !PHYSICAL_SLOTS_BY_MODE[mode].includes(slot)) {
    return next;
  }
  const saved = boundedLabel(value);
  if (saved) next.byMode[mode][slot] = saved;
  else delete next.byMode[mode][slot];
  return next;
}

export function loadDevicePreferences(storage) {
  try {
    return normalizeByMode(
      JSON.parse(storage?.getItem?.(DEVICE_PREFERENCE_STORAGE_KEY) ?? ""),
    );
  } catch {
    return emptyDevicePreferences();
  }
}

export function saveDevicePreferences(storage, preferences) {
  const normalizedPreferences = normalizeByMode(preferences);
  storage?.setItem?.(
    DEVICE_PREFERENCE_STORAGE_KEY,
    JSON.stringify(normalizedPreferences),
  );
  return normalizedPreferences;
}

/**
 * Choose only route-valid virtual endpoints and non-virtual physical endpoints.
 * Returned device objects are browser enumeration objects; callers retain only
 * bounded physical labels as local preferences.
 */
export function recommendModeDevices({
  devices = {},
  mode,
  preferences,
  routeProfile,
} = {}) {
  const inputs = Array.isArray(devices.inputs) ? devices.inputs : [];
  const outputs = Array.isArray(devices.outputs) ? devices.outputs : [];
  const saved = normalizeByMode(preferences).byMode[mode] ?? {};
  const selections = {};
  const missing = [];

  if (["meeting", "microphone", "assistant"].includes(mode)) {
    const physicalMic = bestPhysical(inputs, "physicalMic", saved.physicalMic);
    if (physicalMic) selections.physicalMic = physicalMic.device;
    else missing.push("physicalMic");
    const txSink = virtualDevice(outputs, routeProfile, "txSink");
    if (txSink) selections.txSink = txSink;
    else missing.push("txSink");
  }
  if (["meeting", "media", "assistant"].includes(mode)) {
    const rxSource = virtualDevice(inputs, routeProfile, "rxSource");
    if (rxSource) selections.rxSource = rxSource;
    else missing.push("rxSource");
    const headphones = bestPhysical(outputs, "headphones", saved.headphones);
    if (headphones) selections.headphones = headphones.device;
    else missing.push("headphones");
  }

  return { missing: missing.sort(), selections };
}
