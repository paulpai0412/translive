export const SLOT_LABELS = Object.freeze({
  headphones: "耳機輸出",
  physicalMic: "實體麥克風",
  rxSource: "虛擬音訊來源",
  txSink: "虛擬麥克風輸出",
});

const MODE_SLOTS = Object.freeze({
  meeting: ["physicalMic", "txSink", "rxSource", "headphones"],
  media: ["rxSource", "headphones"],
  microphone: ["physicalMic", "txSink"],
});

const NONE = Object.freeze({ level: "none", message: "" });

export function decideDeviceChangeReaction({
  appState,
  missingSlots = [],
  mode,
} = {}) {
  if (appState !== "live" && appState !== "degraded") return NONE;
  const activeSlots = MODE_SLOTS[mode] ?? [];
  const missing = missingSlots.filter((slot) => activeSlots.includes(slot));
  if (missing.length === 0) return NONE;
  const labels = missing.map((slot) => SLOT_LABELS[slot] ?? slot);
  return {
    level: "warn",
    message: `音訊裝置已變更：找不到${labels.join("、")}，目前的翻譯可能已中斷。`,
  };
}
