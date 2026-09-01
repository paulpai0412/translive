import { DirectionalAudioOutput } from "./directional-audio-output.js";
import {
  SLOT_LABELS,
  decideDeviceChangeReaction,
} from "./device-change-controller.js";
import {
  emptyDevicePreferences,
  isVirtualDevice,
  loadDevicePreferences,
  recommendModeDevices,
  rememberDeviceLabel,
  saveDevicePreferences,
} from "./device-recommendations.js";
import {
  createRendererControlHandler,
  releaseRendererResources as releaseResources,
} from "./renderer-control.js";
import { createOutputTester } from "./output-tester.js";
import { createStartupSession } from "./startup-session.js";
import { VOICE_TRAINING_POLICY } from "./voice-training-policy.js";
import { verifyVoiceMeeterRoute } from "./voicemeeter-route-health.js";
import {
  latestTranscriptPersistenceEvent,
  transcriptPersistencePresentation,
} from "./renderer-state.js";
import {
  channelStateLabel,
  diagnosticEventLabel,
  diagnosticsPresentation,
  modeLabel,
  runStatePresentation,
  stoppedStatePresentation,
  voiceEmptyStateVisible,
} from "./view-state.js";

const DIRECTIONS_BY_MODE = Object.freeze({
  meeting: ["tx", "rx"],
  media: ["rx"],
  microphone: ["tx"],
  assistant: ["tx", "rx"],
});

const elements = Object.fromEntries(
  [
    "account-button",
    "account-login-button",
    "account-login-cancel",
    "account-status",
    "auth-status",
    "assertive-error",
    "blocked-action",
    "blocked-copy",
    "blocked-detail",
    "blocked-title",
    "cancel-connect-button",
    "cable-a-sink",
    "consent-modal",
    "consent-checkbox",
    "consent-confirm",
    "consent-decline",
    "connect-account-step",
    "connect-route-step",
    "connect-runtime-step",
    "connect-session-step",
    "quick-setup-button",
    "quick-setup-modal",
    "quick-setup-title",
    "quick-setup-note",
    "quick-detect-step",
    "quick-microphone-step",
    "quick-speaker-step",
    "quick-verify-step",
    "quick-restore-option",
    "apply-quick-setup",
    "quick-open-settings",
    "close-quick-setup",
    "tray-close-behavior",
    "close-diagnostics",
    "copy-diagnostics",
    "diagnostics-button",
    "diagnostics-button-live",
    "diagnostics-drawer",
    "diag-account",
    "diag-codex",
    "diag-event-detail",
    "diag-last-event",
    "diag-mode",
    "diag-route",
    "diag-rx",
    "diag-tx",
    "degraded-copy",
    "degraded-title",
    "delete-confirm-modal",
    "delete-confirm-input",
    "delete-confirm-action",
    "delete-confirm-cancel",
    "drawer-scrim",
    "headphones",
    "headphones-confirmed",
    "audio-role-info",
    "caption-size-down",
    "caption-size-up",
    "role-note",
    "status-open-diagnostics",
    "health-account",
    "health-devices",
    "health-runtime",
    "global-audio-status",
    "voicemeeter-routing-status",
    "live-mode-label",
    "live-route-summary",
    "live-save-status",
    "live-status",
    "mini-overlay-button",
    "meeting-platform",
    "physical-mic",
    "ready-message",
    "refresh-devices",
    "restart-button",
    "records-list",
    "records-selection",
    "records-refresh",
    "records-delete-all",
    "records-status",
    "record-detail",
    "aggregate-summary-button",
    "assistant-answer-delivery",
    "assistant-wake-armed",
    "assistant-wake-phrase",
    "qa-hint",
    "qa-answer",
    "qa-approve",
    "qa-card",
    "qa-citations",
    "qa-question",
    "qa-reject",
    "speak-conclusions-button",
    "stopped-open-records",
    "summary-confirm-modal",
    "summary-confirm-title",
    "summary-confirm-copy",
    "summary-confirm-action",
    "summary-confirm-cancel",
    "route-profile",
    "settings-account-button",
    "settings-account-status",
    "settings-logout-button",
    "settings-runtime-button",
    "settings-runtime-status",
    "settings-retention-button",
    "settings-retention-status",
    "voice-conversion-toggle",
    "voice-empty-state",
    "voice-conversion-status",
    "voice-profile-consent",
    "voice-profile-import",
    "voice-profile-name",
    "voice-profile-select",
    "voice-profile-delete-confirm",
    "voice-profile-delete",
    "voice-training-microphone",
    "voice-training-consent",
    "voice-training-start",
    "voice-training-pause",
    "voice-training-resume",
    "voice-training-stop",
    "voice-training-final-consent",
    "voice-training-train",
    "voice-training-cancel",
    "voice-training-delete-confirm",
    "voice-training-delete",
    "voice-training-status",
    "voice-training-elapsed",
    "voice-training-progress",
    "voice-training-level",
    "voice-training-clip",
    "voice-training-silence",
    "rx-source",
    "rx-source-caption",
    "rx-target-language",
    "rx-state",
    "rx-target-caption",
    "single-channel-id",
    "single-channel-label",
    "single-channel-state",
    "single-mute-button",
    "single-source-caption",
    "single-source-label",
    "single-target-caption",
    "single-target-label",
    "start-button",
    "stop-button",
    "stopped-generate-summary",
    "stopped-copy",
    "stopped-restore-status",
    "test-tx-sink",
    "test-headphones",
    "theme-button",
    "theme-label",
    "tx-sink",
    "tx-source-caption",
    "tx-source-language",
    "tx-target-language",
    "tx-state",
    "tx-target-caption",
  ].map((id) => [id, document.querySelector(`#${id}`)]),
);

const ui = {
  account: "checking",
  active: {},
  consent: { granted: false, skipForCurrentRun: false },
  lastSavedRecord: undefined,
  persistenceEvent: undefined,
  app: "checking",
  channels: { tx: "disabled", rx: "disabled" },
  startup: undefined,
  captions: {
    tx: { source: "", target: "" },
    rx: { source: "", target: "" },
  },
  mode: "meeting",
  muted: { tx: false, rx: false },
  passthrough: undefined,
  passthroughStream: undefined,
  pendingAnswerId: undefined,
  audioDefaultsState: undefined,
  routingState: undefined,
  records: {
    aggregates: [],
    current: undefined,
    selected: new Set(),
    sessions: [],
    summaryRequest: undefined,
    tab: "transcript",
  },
  quickApp: "teams",
  devices: { inputs: [], outputs: [] },
  devicePreferences: emptyDevicePreferences(),
  missingRecommendedDevices: [],
  selectedHeadphonesId: "",
  voiceConversion: {
    enabled: false,
    profiles: [],
    provider: "unavailable",
    state: "checking",
  },
  voiceTraining: {
    generation: 0,
    media: undefined,
    microphoneId: "",
    runtime: { available: false, provider: "unavailable" },
    status: { state: "idle" },
  },
  runtime: "尚未檢查",
};
const focusOrigins = new WeakMap();

function localDeviceStorage() {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

ui.devicePreferences = loadDevicePreferences(localDeviceStorage());

async function releaseRendererResources() {
  const startup = ui.startup;
  await releaseResources({
    active: () => ui.active,
    cancelStartup: () => startup?.cancel(),
    clearActive: () => {
      ui.active = {};
    },
  });
  if (ui.passthrough) {
    const passthrough = ui.passthrough;
    ui.passthrough = undefined;
    ui.passthroughStream = undefined;
    await passthrough.close().catch(() => {});
  }
  hideQaCard();
}

const handleRendererControl = createRendererControlHandler({
  active: () => ui.active,
  clearActive: () => {
    ui.active = {};
  },
  onStop: async () => {
    const startup = ui.startup;
    if (startup) await startup.cancel();
  },
});

function directionsForMode(mode = ui.mode) {
  return DIRECTIONS_BY_MODE[mode];
}

function renderStoppedRestore() {
  const presentation = stoppedStatePresentation({
    audioDefaultsState: ui.audioDefaultsState,
    routingState: ui.routingState,
  });
  const element = elements["stopped-restore-status"];
  element.textContent = presentation.restoreLine;
  element.dataset.level = presentation.level;
  element.hidden = presentation.level === "none";
}

function setAppState(state) {
  ui.app = state;
  document.body.dataset.appState = state;
  if (state === "stopped") renderStoppedRestore();
  const presentation = runStatePresentation({
    appState: state,
    mode: ui.mode,
    status: ui.channels,
  });
  elements["live-status"].textContent = presentation.title;
  if (state === "degraded" || state === "blocked") {
    elements["degraded-title"].textContent = presentation.title;
    elements["degraded-copy"].textContent = presentation.detail;
  }
  const isLive = state === "live" || state === "degraded";
  updateSavingStatus();
  for (const button of document.querySelectorAll("[data-mode-button]")) {
    button.disabled = state !== "ready";
  }
  for (const field of document.querySelectorAll(
    ".configuration select, .configuration input",
  )) {
    field.disabled = state !== "ready";
  }
  elements["refresh-devices"].disabled = state !== "ready";
  for (const button of document.querySelectorAll(".mute-button")) {
    const direction = button.dataset.direction || activeSingleDirection();
    button.disabled = !isLive || !directionsForMode().includes(direction);
  }
}

function setMode(mode) {
  if (!DIRECTIONS_BY_MODE[mode] || !["ready", "checking"].includes(ui.app)) {
    return;
  }
  ui.mode = mode;
  document.body.dataset.mode = mode;
  elements["live-mode-label"].textContent = modeLabel(mode);
  for (const button of document.querySelectorAll("[data-mode-button]")) {
    const selected = button.dataset.modeButton === mode;
    button.classList.toggle("is-active", selected);
    const stateAttribute =
      button.getAttribute("role") === "tab" ? "aria-selected" : "aria-pressed";
    button.setAttribute(stateAttribute, String(selected));
  }

  const singleDirection = activeSingleDirection();
  if (mode === "media") {
    elements["single-channel-label"].textContent = "媒體 → 我";
    elements["single-channel-id"].textContent = "RX";
    elements["single-source-label"].textContent = "原文 Source";
    elements["single-target-label"].textContent = "繁中 Translation";
    elements["live-route-summary"].textContent = "VoiceMeeter B1 → 耳機 · Cove";
  } else if (mode === "microphone") {
    elements["single-channel-label"].textContent = "我 → 對方";
    elements["single-channel-id"].textContent = "TX";
    elements["single-source-label"].textContent = "我說 Source";
    elements["single-target-label"].textContent = "對方將聽到 Translation";
    elements["live-route-summary"].textContent =
      "麥克風 → VoiceMeeter B2 · Cove";
  } else if (mode === "assistant") {
    elements["live-route-summary"].textContent =
      "麥克風原音直通 · 會議記錄＋問答";
  } else {
    elements["live-route-summary"].textContent = "VoiceMeeter · Cove";
  }
  elements["single-mute-button"].dataset.direction = singleDirection;
  applyModeDeviceRecommendations();
  renderDiagnostics();
  publishMiniCaption();
  updateReadyMessage();
}

function activeSingleDirection() {
  return directionsForMode().at(-1);
}

function setAccountState(state) {
  ui.account = state;
  const text =
    {
      checking: "檢查登入狀態…",
      connected: "ChatGPT 已連線",
      waiting: "等待瀏覽器確認",
      failed: "登入未完成",
      "logged-out": "尚未連線",
    }[state] ?? "尚未連線";
  elements["account-status"].textContent = text;
  elements["auth-status"].textContent = text;
  elements["diag-account"].textContent = text;
  elements["health-account"].className = state === "connected" ? "ok" : "warn";
  elements["settings-account-status"].textContent = text;
}

function showAssertiveError(message) {
  const text = String(message ?? "發生未預期錯誤。");
  elements["assertive-error"].textContent = text;
  elements["assertive-error"].hidden = false;
  window.clearTimeout(showAssertiveError.timeout);
  showAssertiveError.timeout = window.setTimeout(() => {
    elements["assertive-error"].hidden = true;
  }, 8_000);
}

function setModalVisibility(modal, open, selector) {
  if (open) {
    if (document.activeElement instanceof HTMLElement) {
      focusOrigins.set(modal, document.activeElement);
    }
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    window.requestAnimationFrame(() => modal.querySelector(selector)?.focus());
  } else {
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    const origin = focusOrigins.get(modal);
    if (origin?.isConnected) origin.focus();
  }
  setScrim();
}

function setScrim() {
  const open =
    elements["diagnostics-drawer"].classList.contains("is-open") ||
    elements["quick-setup-modal"].classList.contains("is-open") ||
    elements["summary-confirm-modal"].classList.contains("is-open") ||
    elements["consent-modal"].classList.contains("is-open") ||
    elements["delete-confirm-modal"].classList.contains("is-open");
  elements["drawer-scrim"].classList.toggle("is-open", open);
}

function setDrawer(open) {
  setModalVisibility(
    elements["diagnostics-drawer"],
    open,
    "#close-diagnostics",
  );
}

function setQuickSetup(open) {
  setModalVisibility(elements["quick-setup-modal"], open, "#close-quick-setup");
}

function setSummaryConfirm(open) {
  setModalVisibility(
    elements["summary-confirm-modal"],
    open,
    "#summary-confirm-action",
  );
}

function setConsentModal(open) {
  setModalVisibility(elements["consent-modal"], open, "#consent-checkbox");
}

function setDeleteConfirm(open) {
  if (!open) elements["delete-confirm-input"].value = "";
  elements["delete-confirm-action"].disabled = true;
  setModalVisibility(
    elements["delete-confirm-modal"],
    open,
    "#delete-confirm-input",
  );
}

function applyTranscriptPersistence(event) {
  ui.persistenceEvent = latestTranscriptPersistenceEvent(
    ui.persistenceEvent,
    event,
  );
  const presentation = transcriptPersistencePresentation({
    consentGranted: ui.consent.granted,
    event: ui.persistenceEvent,
    skipForCurrentRun: ui.consent.skipForCurrentRun,
  });
  elements["live-save-status"].textContent = presentation.live;
  elements["stopped-copy"].textContent = presentation.stopped;
  elements["stopped-copy"].title = presentation.pathDetail ?? "";
  elements["stopped-generate-summary"].hidden = !presentation.summary;
}

function updateSavingStatus() {
  applyTranscriptPersistence();
}

function selectedDevice(select) {
  const option = select.selectedOptions[0];
  if (!option?.value)
    throw new Error(`請選擇「${select.labels[0].textContent}」`);
  return {
    id: option.value,
    kind: option.dataset.kind,
    name: option.textContent,
  };
}

function quickSetupEndpoints() {
  const profile = elements["route-profile"].value;
  const expected =
    profile === "voicemeeter"
      ? {
          microphone: /Voicemeeter Out B2\b/i,
          speaker: /^Voicemeeter Input\b/i,
        }
      : {
          microphone: /Cable-A Output/i,
          speaker: /Cable-B Input/i,
        };
  const microphone = ui.devices.inputs.find((device) =>
    expected.microphone.test(device.label),
  );
  const speaker = ui.devices.outputs.find((device) =>
    expected.speaker.test(device.label),
  );
  if (!microphone || !speaker) {
    throw new Error(
      "找不到 Teams／Zoom 需要的虛擬裝置，請先檢查 VoiceMeeter 或 VB-CABLE。",
    );
  }
  return {
    microphone: { name: microphone.label },
    speaker: { name: speaker.label },
  };
}

function setQuickStep(id, state, detail) {
  const step = elements[id];
  step.className = state;
  step.querySelector("small").textContent = detail;
}

function setQuickApp(appName) {
  ui.quickApp = appName;
  for (const button of document.querySelectorAll("[data-quick-app]")) {
    button.classList.toggle("is-active", button.dataset.quickApp === appName);
  }
  elements["quick-setup-title"].textContent =
    `快速設定 ${appName === "teams" ? "Microsoft Teams" : "Zoom"}`;
}

async function openQuickManualSettings() {
  try {
    await window.translive.meetingSetupOpenSettings(ui.quickApp);
    elements["quick-setup-note"].textContent =
      "已開啟 Windows 音訊設定。請依上方裝置名稱完成選擇後再驗證。";
  } catch {
    elements["quick-setup-note"].textContent =
      "無法開啟系統設定，請手動前往 Windows 設定 > 系統 > 音效。";
  }
}

async function applyQuickSetup() {
  try {
    const endpoints = quickSetupEndpoints();
    setQuickStep("quick-detect-step", "active", "正在偵測…");
    setQuickStep("quick-microphone-step", "pending", endpoints.microphone.name);
    setQuickStep("quick-speaker-step", "pending", endpoints.speaker.name);
    setQuickStep("quick-verify-step", "pending", "等待套用");
    elements["apply-quick-setup"].disabled = true;
    const result = await window.translive.meetingSetupApply({
      app: ui.quickApp,
      endpoints,
      restoreOnStop: elements["quick-restore-option"].checked,
    });
    if (result.state === "windows-defaults-updated") {
      setQuickStep("quick-detect-step", "done", "已偵測並正在執行");
      setQuickStep("quick-microphone-step", "done", result.microphoneName);
      setQuickStep("quick-speaker-step", "done", result.speakerName);
      setQuickStep("quick-verify-step", "done", "Windows 通訊預設已更新");
      elements["quick-setup-note"].textContent =
        "已更新 Windows 通訊預設；請在 Teams／Zoom 裝置設定確認它實際選取這兩個裝置。停止翻譯後會依選項還原原本裝置。";
      elements["ready-message"].textContent =
        "Windows 通訊預設已更新，請在 Teams／Zoom 確認裝置。";
    } else {
      setQuickStep("quick-detect-step", "pending", "需要人工確認");
      setQuickStep("quick-verify-step", "pending", "未變更目前裝置");
      elements["quick-setup-note"].textContent =
        "TransLive 無法確認會議 App 實際使用的裝置。請開啟其裝置設定，手動選擇上方裝置名稱。";
    }
  } catch {
    elements["quick-setup-note"].textContent =
      "快速設定無法完成。請開啟 Windows 音訊設定，手動確認麥克風與喇叭。";
    showAssertiveError(
      "快速設定無法完成。請手動確認 Teams／Zoom 的麥克風與喇叭。",
    );
    setQuickStep("quick-verify-step", "pending", "需要人工確認");
  } finally {
    elements["apply-quick-setup"].disabled = false;
  }
}

function routeConfig() {
  const config = {
    mode: ui.mode,
    platform: elements["meeting-platform"].value,
    routeProfile: elements["route-profile"].value,
  };
  if (directionsForMode().includes("tx")) {
    const source = selectedDevice(elements["physical-mic"]);
    const sink = selectedDevice(elements["tx-sink"]);
    config.tx = {
      sourceEndpointId: source.id,
      sourceEndpointName: source.name,
      sourceEndpointKind: source.kind,
      sinkEndpointId: sink.id,
      sinkEndpointName: sink.name,
      sinkEndpointKind: sink.kind,
    };
  }
  if (directionsForMode().includes("rx")) {
    const source = selectedDevice(elements["rx-source"]);
    const sink = selectedDevice(elements["headphones"]);
    config.headphonesConfirmed = elements["headphones-confirmed"].checked;
    config.rx = {
      sourceEndpointId: source.id,
      sourceEndpointName: source.name,
      sourceEndpointKind: source.kind,
      sinkEndpointId: sink.id,
      sinkEndpointName: sink.name,
      sinkEndpointKind: sink.kind,
    };
  }
  config.persistTranscript =
    ui.consent.granted && !ui.consent.skipForCurrentRun;
  config.languages = {
    rxTarget: elements["rx-target-language"]?.value ?? "繁體中文（台灣）",
    txSource: elements["tx-source-language"]?.value ?? "未指定",
    txTarget: elements["tx-target-language"]?.value ?? "未指定",
  };
  config.sourceLabels = {
    rx: config.rx?.sourceEndpointName ?? "未指定來源",
    tx: config.tx?.sourceEndpointName ?? "未指定來源",
  };
  return config;
}

function populateSelect(select, devices, previous) {
  select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "選擇裝置";
  select.append(placeholder);
  for (const [index, device] of devices.entries()) {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.dataset.kind = device.kind;
    option.textContent = device.label || `Audio device ${index + 1}`;
    option.selected = device.deviceId === previous;
    select.append(option);
  }
}

const DEVICE_SELECTS = Object.freeze({
  headphones: "headphones",
  physicalMic: "physical-mic",
  rxSource: "rx-source",
  txSink: "tx-sink",
});

function setRecommendedDevice(slot, device) {
  const select = elements[DEVICE_SELECTS[slot]];
  if (!select || !device?.deviceId) return false;
  if (![...select.options].some((option) => option.value === device.deviceId)) {
    return false;
  }
  const changed = select.value !== device.deviceId;
  select.value = device.deviceId;
  if (slot === "headphones") {
    if (changed) elements["headphones-confirmed"].checked = false;
    ui.selectedHeadphonesId = device.deviceId;
  }
  return changed;
}

function applyModeDeviceRecommendations() {
  if (!ui.devices.inputs.length && !ui.devices.outputs.length) {
    ui.missingRecommendedDevices = [];
    return;
  }
  const recommendation = recommendModeDevices({
    devices: ui.devices,
    mode: ui.mode,
    preferences: ui.devicePreferences,
    routeProfile: elements["route-profile"].value,
  });
  ui.missingRecommendedDevices = recommendation.missing;
  for (const [slot, device] of Object.entries(recommendation.selections)) {
    setRecommendedDevice(slot, device);
  }
  syncTestToneButtons();
}

function populateVoiceTrainingMicrophone(inputs) {
  const select = elements["voice-training-microphone"];
  const physical = inputs.filter(
    (device) =>
      !isVirtualDevice(device) &&
      !/^(?:default|communications)\s*-/i.test(String(device.label ?? "")),
  );
  const previous = select.value || elements["physical-mic"].value;
  populateSelect(select, physical, previous);
  const recommendation = recommendModeDevices({
    devices: { inputs, outputs: ui.devices.outputs },
    mode: "microphone",
    preferences: ui.devicePreferences,
    routeProfile: elements["route-profile"].value,
  });
  const recommended = recommendation.selections.physicalMic;
  if (
    recommended?.deviceId &&
    [...select.options].some((option) => option.value === recommended.deviceId)
  ) {
    select.value =
      previous &&
      [...select.options].some((option) => option.value === previous)
        ? previous
        : recommended.deviceId;
  }
  ui.voiceTraining.microphoneId = select.value;
  updateVoiceTrainingControls();
}

function rememberManualPhysicalDevice(slot) {
  const select = elements[DEVICE_SELECTS[slot]];
  const option = select?.selectedOptions[0];
  if (!option?.value) return;
  if (slot === "headphones") {
    if (ui.selectedHeadphonesId !== option.value) {
      elements["headphones-confirmed"].checked = false;
    }
    ui.selectedHeadphonesId = option.value;
  }
  ui.devicePreferences = rememberDeviceLabel(ui.devicePreferences, {
    label: option.textContent,
    mode: ui.mode,
    slot,
  });
  saveDevicePreferences(localDeviceStorage(), ui.devicePreferences);
}

async function refreshDevices() {
  elements["ready-message"].textContent = "正在要求麥克風權限並檢查裝置…";
  try {
    const permissionStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
    for (const track of permissionStream.getTracks()) track.stop();
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((device) => device.kind === "audioinput");
    const outputs = devices.filter((device) => device.kind === "audiooutput");
    ui.devices = { inputs, outputs };
    populateSelect(
      elements["physical-mic"],
      inputs,
      elements["physical-mic"].value,
    );
    populateSelect(elements["rx-source"], inputs, elements["rx-source"].value);
    populateSelect(elements["tx-sink"], outputs, elements["tx-sink"].value);
    populateSelect(
      elements["headphones"],
      outputs,
      elements["headphones"].value,
    );
    applyModeDeviceRecommendations();
    populateVoiceTrainingMicrophone(inputs);
    elements["health-devices"].className = "ok";
    updateReadyMessage();
  } catch {
    elements["health-devices"].className = "warn";
    elements["ready-message"].textContent =
      "無法列出音訊裝置。請確認 Windows 麥克風權限與裝置連線後再試。";
    showAssertiveError(
      "無法列出音訊裝置。請確認 Windows 麥克風權限與裝置連線。",
    );
  }
}

const outputTester = createOutputTester();

function syncTestToneButtons() {
  if (outputTester.state() === "playing") return;
  elements["test-tx-sink"].disabled = !elements["tx-sink"].value;
  elements["test-headphones"].disabled = !elements["headphones"].value;
}

for (const [buttonId, selectId] of [
  ["test-tx-sink", "tx-sink"],
  ["test-headphones", "headphones"],
]) {
  elements[buttonId].addEventListener("click", async () => {
    elements[buttonId].disabled = true;
    await outputTester.play({ sinkId: elements[selectId].value });
    if (outputTester.state() === "error") {
      showAssertiveError("無法在此裝置播放測試音，請確認裝置連線後再試。");
    }
    syncTestToneButtons();
  });
  elements[selectId].addEventListener("change", syncTestToneButtons);
}

function updateReadyMessage() {
  const description = {
    meeting: "會同時建立 TX 與 RX 翻譯連線。",
    media: "只建立 RX 翻譯連線，不使用麥克風。",
    microphone: "只建立 TX 翻譯連線，不使用耳機或 RX 來源。",
    assistant: "記錄雙方談話，不翻譯；停止後自動匯整摘要。",
  }[ui.mode];
  const missing = ui.missingRecommendedDevices
    .map((slot) => SLOT_LABELS[slot])
    .filter(Boolean);
  elements["ready-message"].textContent = missing.length
    ? `找不到${missing.join("、")}，請確認路由裝置後重新檢查。`
    : description;
}

function setChannelState(direction, state) {
  ui.channels[direction] = state;
  const element = elements[`${direction}-state`];
  if (element) element.textContent = channelStateLabel(state, ui.mode);
  const singleDirection = activeSingleDirection();
  if (direction === singleDirection) {
    elements["single-channel-state"].textContent = channelStateLabel(
      state,
      ui.mode,
    );
  }
  const button = document.querySelector(
    `.mute-button[data-direction="${direction}"]`,
  );
  if (button) {
    button.disabled = !["live", "muted"].includes(state);
    button.textContent = ui.muted[direction] ? "取消靜音" : "靜音";
  }
  renderDiagnostics();
  publishMiniCaption();
}

function applyAggregate(aggregate) {
  if (aggregate === "blocked") setAppState("blocked");
  else if (aggregate === "degraded") setAppState("degraded");
  else if (aggregate === "live") setAppState("live");
  else if (aggregate === "connecting") setAppState("connecting");
}

function captionKey(role) {
  return role === "user" ? "source" : "target";
}

function mergeCaption(current, incoming, final) {
  if (!incoming) return current;
  if (final || incoming.startsWith(current)) return incoming;
  return current.endsWith(incoming) ? current : `${current}${incoming}`;
}

function miniCaptionSnapshot() {
  const direction = activeSingleDirection();
  const captions = ui.captions[direction];
  return {
    mode: modeLabel(ui.mode),
    primary: captions.target || captions.source || "等待翻譯字幕…",
    secondary: ui.mode === "meeting" ? ui.captions.tx.target || "" : "",
    status: `${modeLabel(ui.mode)} · ${channelStateLabel(ui.channels[direction])}`,
  };
}

function publishMiniCaption() {
  window.translive.miniCaptionUpdate(miniCaptionSnapshot());
}

function pinCaptionScroll() {
  for (const group of document.querySelectorAll(".caption-group")) {
    if (group.dataset.unpinned !== "1") group.scrollTop = group.scrollHeight;
  }
}

function renderCaptions() {
  for (const direction of ["tx", "rx"]) {
    const captions = ui.captions[direction];
    const source = elements[`${direction}-source-caption`];
    const target = elements[`${direction}-target-caption`];
    if (source) source.textContent = captions.source || "等待輸入音訊…";
    if (target) target.textContent = captions.target || "—";
  }
  const direction = activeSingleDirection();
  const captions = ui.captions[direction];
  elements["single-source-caption"].textContent =
    captions.source || "等待輸入音訊…";
  elements["single-target-caption"].textContent = captions.target || "—";
  pinCaptionScroll();
  publishMiniCaption();
}

function resetLiveDisplay() {
  ui.captions = {
    tx: { source: "", target: "" },
    rx: { source: "", target: "" },
  };
  ui.muted = { tx: false, rx: false };
  for (const direction of ["tx", "rx"]) {
    setChannelState(
      direction,
      directionsForMode().includes(direction) ? "connecting" : "disabled",
    );
  }
  renderCaptions();
}

function recordMetric(direction, type, stats) {
  window.translive.recordMetric({ direction, type, atMs: Date.now(), stats });
}

function createInputProbe(stream, direction) {
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  const source = context.createMediaStreamSource(stream);
  source.connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);
  let closed = false;
  let frame;
  let lastSignalAt = 0;

  const sample = () => {
    if (closed) return;
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const value of samples) {
      const normalized = (value - 128) / 128;
      sum += normalized * normalized;
    }
    const rms = Math.sqrt(sum / samples.length);
    if (rms > 0.015 && Date.now() - lastSignalAt >= 250) {
      lastSignalAt = Date.now();
      recordMetric(direction, "input-audio", { rms });
    }
    frame = requestAnimationFrame(sample);
  };
  context
    .resume()
    .then(sample)
    .catch(() => {});
  return () => {
    closed = true;
    cancelAnimationFrame(frame);
    source.disconnect();
    void context.close();
  };
}

function waitForIceGatheringComplete(peerConnection) {
  if (peerConnection.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, 3_000);
    function done() {
      clearTimeout(timeout);
      peerConnection.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }
    function onChange() {
      if (peerConnection.iceGatheringState === "complete") done();
    }
    peerConnection.addEventListener("icegatheringstatechange", onChange);
  });
}

async function summarizeStats(peerConnection) {
  const stats = {};
  const reports = await peerConnection.getStats();
  for (const report of reports.values()) {
    if (
      report.type === "candidate-pair" &&
      report.state === "succeeded" &&
      (report.nominated || report.selected) &&
      Number.isFinite(report.currentRoundTripTime)
    ) {
      stats.rttMs = report.currentRoundTripTime * 1_000;
    }
    if (
      report.type === "inbound-rtp" &&
      (report.kind === "audio" || report.mediaType === "audio")
    ) {
      if (Number.isFinite(report.jitter))
        stats.jitterMs = report.jitter * 1_000;
      if (Number.isFinite(report.packetsLost))
        stats.packetsLost = report.packetsLost;
    }
  }
  return stats;
}

async function createRealtimePeer({
  direction,
  source,
  sink,
  playRemote = true,
}) {
  let stream;
  let peerConnection;
  let eventChannel;
  let stopInputProbe = () => {};
  let statsTimer;
  let cleaned = false;
  // Assistant-mode transcribe peers discard model audio (playRemote false);
  // the qa voice peer has no local input (source null) and only receives.
  const audioOutput = playRemote
    ? new DirectionalAudioOutput({ sinkId: sink.id })
    : undefined;
  // Monitor path lets the local user hear what the assistant sends into the
  // meeting — sending into silence reads as "no response".
  const monitorOutput = monitorSink
    ? new DirectionalAudioOutput({ sinkId: monitorSink.id })
    : undefined;

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(statsTimer);
    stopInputProbe();
    try {
      eventChannel?.close();
    } catch {}
    for (const track of stream?.getTracks() ?? []) track.stop();
    try {
      peerConnection?.close();
    } catch {}
    await audioOutput?.close();
    await monitorOutput?.close();
  };

  try {
    await audioOutput?.prepare();
    await monitorOutput?.prepare();
    peerConnection = new RTCPeerConnection();
    if (source) {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: source.id },
          autoGainControl: false,
          echoCancellation: false,
          noiseSuppression: false,
        },
        video: false,
      });
      for (const track of stream.getAudioTracks()) {
        peerConnection.addTrack(track, stream);
      }
    } else {
      // QA voice: codex only emits standalone speech when the session has a
      // real uplink track. A bare recvonly/trackless offer negotiates fine but
      // appendSpeech then produces zero audio (probed on Windows 2026-09-01).
      // Send a silent oscillator track instead.
      const silentContext = new AudioContext();
      const oscillator = silentContext.createOscillator();
      const silentGain = silentContext.createGain();
      silentGain.gain.value = 0;
      const silentDestination = silentContext.createMediaStreamDestination();
      oscillator.connect(silentGain);
      silentGain.connect(silentDestination);
      oscillator.start();
      stream = silentDestination.stream;
      peerConnection.addTrack(stream.getAudioTracks()[0], stream);
    }
    eventChannel = peerConnection.createDataChannel("oai-events");

    peerConnection.addEventListener("connectionstatechange", () => {
      if (["failed", "disconnected"].includes(peerConnection.connectionState)) {
        window.translive.rendererError(
          direction,
          `WebRTC connection ${peerConnection.connectionState}`,
        );
      }
    });
    if (audioOutput)
      peerConnection.addEventListener("track", async (event) => {
        try {
          const remoteStream =
            event.streams[0] || new MediaStream([event.track]);
          event.track.addEventListener(
            "unmute",
            () => recordMetric(direction, "output-audio", {}),
            { once: true },
          );
          await audioOutput.attach(remoteStream);
          recordMetric(direction, "output-audio", {});
        } catch (error) {
          window.translive.rendererError(
            direction,
            `無法播放翻譯音訊：${error.message}`,
          );
        }
      });

    if (stream) stopInputProbe = createInputProbe(stream, direction);
    if (direction !== "qa")
      statsTimer = setInterval(async () => {
        try {
          if (!cleaned)
            recordMetric(
              direction,
              "webrtc",
              await summarizeStats(peerConnection),
            );
        } catch {}
      }, 1_000);

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    await waitForIceGatheringComplete(peerConnection);

    return {
      sdp: peerConnection.localDescription.sdp,
      stream,
      setMuted(muted) {
        if (direction === "tx") {
          for (const track of stream?.getAudioTracks() ?? []) {
            track.enabled = !muted;
          }
        } else {
          audioOutput?.setMuted(muted);
        }
      },
      async applyAnswer(sdp) {
        await peerConnection.setRemoteDescription({ type: "answer", sdp });
      },
      stop: cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function setConnectionStep(id, state, detail) {
  const step = elements[id];
  if (!step) return;
  step.className = state;
  if (detail) step.textContent = detail;
}

async function startTranslation() {
  if (ui.mode === "assistant") return startAssistant();
  if (!ui.consent.granted && !ui.consent.skipForCurrentRun) {
    setConsentModal(true);
    return;
  }
  if (
    ui.startup ||
    Object.keys(ui.active).length > 0 ||
    ui.app === "connecting"
  )
    return;
  let config;
  const startup = createStartupSession({
    directions:
      ui.mode === "meeting" ? [...directionsForMode(), "qa"] : directionsForMode(),
    createPeer: async ({ direction, channel }) =>
      direction === "qa"
        ? createRealtimePeer({
            direction: "qa",
            source: null,
            sink: { id: channel.sinkEndpointId },
            monitorSink: { id: channel.monitorSinkEndpointId },
          })
        : createRealtimePeer({
            direction,
            source: { id: channel.sourceEndpointId },
            sink: { id: channel.sinkEndpointId },
          }),
    onPeerCreated: (direction, peer) => {
      ui.active[direction] = peer;
    },
    startRuntime: (runtimeConfig) =>
      window.translive.start({
        ...runtimeConfig,
        qaSdp: runtimeConfig.qa?.sdp,
      }),
    cancelRuntime: () => window.translive.cancelStart(),
  });
  ui.startup = startup;
  try {
    config = routeConfig();
    if (ui.mode === "meeting") {
      config.qa = {
        sinkEndpointId: config.tx.sinkEndpointId,
        monitorSinkEndpointId: config.rx.sinkEndpointId,
      };
    }
    ui.persistenceEvent = undefined;
    setAppState("connecting");
    resetLiveDisplay();
    setConnectionStep("connect-account-step", "done", "ChatGPT 已連線");
    setConnectionStep(
      "connect-runtime-step",
      "active",
      "正在檢查 Codex runtime",
    );
    setConnectionStep("connect-session-step", "pending", "等待路由預檢");
    setConnectionStep("connect-route-step", "pending", "等待路由預檢");

    const preflight = await window.translive.preflight(config);
    if (!preflight.ok) throw new Error(preflight.error);
    if (startup.isCanceled()) return;
    if (config.routeProfile === "voicemeeter") {
      setConnectionStep(
        "connect-route-step",
        "active",
        "正在測試 VoiceMeeter B1／B2 隔離",
      );
      const routeHealth = await verifyVoiceMeeterRoute({
        devices: ui.devices,
        mode: ui.mode,
      });
      if (!routeHealth.ok) {
        throw new Error("VoiceMeeter 音訊 Bus 隔離驗證失敗");
      }
    }
    if (startup.isCanceled()) return;

    ui.runtime = preflight.codexVersion;
    setConnectionStep("connect-runtime-step", "done", "Codex runtime 已驗證");
    elements["diag-codex"].textContent = preflight.codexVersion;
    elements["settings-runtime-status"].textContent = preflight.codexVersion;
    elements["diag-route"].textContent =
      `${config.platform} · ${config.routeProfile} · ${ui.mode}`;
    setConnectionStep("connect-route-step", "done", "音訊路由已驗證");
    setConnectionStep(
      "connect-session-step",
      "active",
      "正在建立 GPT‑Live session",
    );

    const { result } = await startup.start(config);
    if (startup.isCanceled()) return;
    setConnectionStep(
      "connect-session-step",
      "done",
      "GPT‑Live session 已建立",
    );
    applyAggregate(result.aggregate);
  } catch (error) {
    const canceled = error?.name === "AbortError" || startup.isCanceled();
    await releaseRendererResources();
    try {
      await window.translive.cancelStart();
    } catch {
      // Main-side route recovery is retried at the next startup.
    }
    if (canceled) {
      setAppState("ready");
      updateReadyMessage();
      return;
    }
    if (config) window.translive.rendererBlocked(config, error.message);
    showAssertiveError("無法建立翻譯連線，請檢查設定後再試。");
    showBlocked("無法建立翻譯連線", error.message);
  } finally {
    if (ui.startup === startup) ui.startup = undefined;
  }
}

async function cancelTranslationStartup() {
  const startup = ui.startup;
  if (!startup) return;
  await startup.cancel();
  await releaseRendererResources();
  setAppState("ready");
  updateReadyMessage();
}

// Assistant mode: Teams hears the raw microphone (passthrough into the same
// virtual cable the QA voice uses); both codex sessions are transcribe-only
// and their model audio is discarded (playRemote: false).
async function startAssistant() {
  if (!ui.consent.granted && !ui.consent.skipForCurrentRun) {
    setConsentModal(true);
    return;
  }
  if (
    ui.startup ||
    Object.keys(ui.active).length > 0 ||
    ui.app === "connecting"
  )
    return;
  let config;
  const startup = createStartupSession({
    directions: ["tx", "rx", "qa"],
    createPeer: async ({ direction, channel }) => {
      if (direction === "qa") {
        return createRealtimePeer({
          direction: "qa",
          source: null,
          sink: { id: channel.sinkEndpointId },
          monitorSink: { id: channel.monitorSinkEndpointId },
        });
      }
      return createRealtimePeer({
        direction,
        source: { id: channel.sourceEndpointId },
        sink: { id: channel.sinkEndpointId },
        playRemote: false,
      });
    },
    onPeerCreated: (direction, peer) => {
      ui.active[direction] = peer;
    },
    startRuntime: (runtimeConfig) =>
      window.translive.assistantStart({
        ...runtimeConfig,
        qaSdp: runtimeConfig.qa?.sdp,
      }),
    cancelRuntime: () => window.translive.assistantStop(),
  });
  ui.startup = startup;
  try {
    config = routeConfig();
    config.qa = {
      sinkEndpointId: config.tx.sinkEndpointId,
      monitorSinkEndpointId: config.rx.sinkEndpointId,
    };
    ui.persistenceEvent = undefined;
    hideQaCard();
    setAppState("connecting");
    resetLiveDisplay();
    const { result } = await startup.start(config);
    if (startup.isCanceled()) return;
    // Single mic open: BT/HFP headsets often deliver silence to a second
    // getUserMedia on the same device, so the passthrough shares the tx
    // peer's stream instead of opening the mic again.
    ui.passthroughStream = ui.active.tx?.stream;
    if (!ui.passthroughStream) {
      throw new Error("TX microphone stream is unavailable for passthrough");
    }
    ui.passthrough = new DirectionalAudioOutput({
      sinkId: config.tx.sinkEndpointId,
    });
    await ui.passthrough.prepare();
    await ui.passthrough.attach(ui.passthroughStream);
    applyAggregate(result.aggregate);
  } catch (error) {
    const canceled = error?.name === "AbortError" || startup.isCanceled();
    await releaseRendererResources();
    try {
      await window.translive.assistantStop();
    } catch {
      // Main-side cleanup is retried on the next stop.
    }
    if (canceled) {
      setAppState("ready");
      updateReadyMessage();
      return;
    }
    showAssertiveError("無法建立會議助手連線，請檢查設定後再試。");
    showBlocked("無法建立會議助手連線", error?.message);
  } finally {
    if (ui.startup === startup) ui.startup = undefined;
  }
}

let qaNoticeTimer;
function showQaNotice(message) {
  const hint = elements["qa-hint"];
  if (!hint) return;
  clearTimeout(qaNoticeTimer);
  const base = hint.dataset.base ?? hint.textContent;
  hint.dataset.base = base;
  hint.textContent = message;
  qaNoticeTimer = setTimeout(() => {
    hint.textContent = hint.dataset.base;
  }, 8_000);
}

function setQaBusy(busy) {
  const button = elements["speak-conclusions-button"];
  if (!button) return;
  button.disabled = busy || ["live", "degraded"].includes(ui.app) === false;
  button.textContent = busy ? "執行中…" : "口播結論";
}

function showQaCard(answer) {
  ui.pendingAnswerId = answer.id ?? undefined;
  elements["qa-question"].textContent = answer.question ?? "會議助手";
  elements["qa-answer"].textContent = answer.text;
  elements["qa-citations"].textContent = (answer.citations ?? [])
    .map(
      (citation) =>
        `來源 ${citation.sessionId} @ ${recordOffset(citation.offsetMs)}`,
    )
    .join(" · ");
  const actionable = Boolean(answer.id);
  elements["qa-approve"].disabled = !actionable;
  elements["qa-reject"].disabled = !actionable;
  elements["qa-card"].hidden = false;
}

function hideQaCard() {
  ui.pendingAnswerId = undefined;
  elements["qa-card"].hidden = true;
}

async function stopTranslation() {
  await cancelTranslationStartup();
  await releaseRendererResources();
  try {
    const result =
      ui.mode === "assistant"
        ? await window.translive.assistantStop()
        : await window.translive.stop();
    if (result.meetingRestore?.reason) {
      elements["stopped-copy"].textContent =
        "翻譯已停止，但 Windows 通訊裝置尚未還原。TransLive 會在下次啟動時重試；你也可以在設定中手動確認。";
    } else {
      elements["stopped-copy"].textContent =
        "音訊連線已釋放。逐字稿與摘要將於下一階段提供。";
    }
  } catch {
    showAssertiveError("無法完成停止或保存逐字稿，請開啟診斷查看詳情。");
  } finally {
    setAppState("stopped");
  }
}

async function toggleMute(direction) {
  const peer = ui.active[direction];
  if (!peer) return;
  const muted = !ui.muted[direction];
  peer.setMuted(muted);
  ui.muted[direction] = muted;
  if (direction === "tx") ui.passthrough?.setMuted(muted);
  if (ui.mode !== "assistant")
    await window.translive.setMuted(direction, muted);
  setChannelState(direction, muted ? "muted" : "live");
}

function showBlocked(title, detail) {
  elements["blocked-title"].textContent = title;
  elements["blocked-copy"].textContent =
    "請檢查登入、音訊裝置和路由設定。音訊尚未繼續傳送。";
  const safeDetail = detail
    ? "已遮罩技術資訊，請匯出診斷包查看。"
    : "無額外技術資訊";
  elements["blocked-detail"].textContent = safeDetail;
  elements["blocked-action"].textContent =
    ui.account === "connected" ? "返回設定" : "重新連接 ChatGPT";
  setAppState("blocked");
}

function appendTranscript({ direction, role, text, final = false }) {
  const key = captionKey(role);
  ui.captions[direction][key] = mergeCaption(
    ui.captions[direction][key],
    text,
    final,
  );
  renderCaptions();
}

function renderDiagnostics(status = ui.channels) {
  const presentation = diagnosticsPresentation({
    mode: ui.mode,
    status,
  });
  elements["diag-mode"].textContent = presentation.mode;
  elements["diag-tx"].textContent = presentation.tx;
  elements["diag-rx"].textContent = presentation.rx;
}

function updateDiagnostics(event) {
  const status =
    event.type === "state" && event.direction
      ? { ...ui.channels, [event.direction]: event.state }
      : ui.channels;
  renderDiagnostics(status);
  elements["diag-last-event"].textContent = diagnosticEventLabel(event.type);
  elements["diag-event-detail"].textContent = event.direction
    ? `${event.type} · ${event.direction.toUpperCase()}`
    : event.type;
}

function applyGlobalAudioStatus({ state } = {}) {
  ui.audioDefaultsState = state;
  renderStoppedRestore();
  elements["global-audio-status"].dataset.level = [
    "prepared",
    "active",
    "restored",
  ].includes(state)
    ? "ok"
    : "warn";
  elements["global-audio-status"].textContent =
    {
      prepared:
        "Windows 原始音訊設定已保存；開始翻譯時只套用目前模式需要的路由。",
      active: "目前模式的 Windows 音訊路由已套用；停止翻譯後會自動還原。",
      restored: "Windows 原始音訊設定已還原。",
      "target-unavailable":
        "找不到 VoiceMeeter 虛擬裝置。Windows 音訊設定未變更；請啟動 VoiceMeeter Banana 後重新開啟 TransLive。",
      "snapshot-failed":
        "無法保存目前 Windows 音訊設定。Windows 音訊設定未變更；請稍後重新開啟 TransLive。",
      "apply-failed":
        "無法套用 VoiceMeeter 系統音訊設定。Windows 音訊設定已還原；請確認 VoiceMeeter 後重新開啟 TransLive。",
      "restore-failed":
        "前次 Windows 音訊設定無法還原。為避免覆蓋原設定，本次未變更裝置；請開啟 Windows 音效設定後重新啟動。",
      "legacy-recovery-needed":
        "前次 Teams／Zoom 通訊裝置尚未還原。為避免覆蓋原設定，本次未變更 Windows 預設音訊；請先在 Windows 音效設定確認裝置後重新啟動。",
      "recovery-needed":
        "偵測到 Windows 音訊設定已被變更。為避免覆蓋目前設定，本次未變更裝置；請確認 Windows 音效設定後重新啟動。",
      "checkpoint-clear-failed":
        "Windows 音訊已還原，但本機復原記錄尚未清除。為避免覆蓋後續設定，本次未變更裝置；請確認 Windows 音效設定後重新啟動。",
      unsupported: "全域 Windows 音訊切換僅支援 Windows。",
    }[state] ?? "Windows 系統音訊狀態尚未確認。";
}

async function initializeGlobalAudioDefaults() {
  try {
    applyGlobalAudioStatus(await window.translive.audioDefaultsStatus());
  } catch {
    applyGlobalAudioStatus({ state: "snapshot-failed" });
  }
}

function applyVoiceMeeterRoutingStatus({ state } = {}) {
  ui.routingState = state;
  renderStoppedRestore();
  elements["voicemeeter-routing-status"].dataset.level = [
    "active",
    "restored",
  ].includes(state)
    ? "ok"
    : "warn";
  elements["voicemeeter-routing-status"].textContent =
    {
      checking: "正在自動設定 VoiceMeeter 內部路由…",
      active:
        "VoiceMeeter 已自動設定：VAIO → B1、AUX → B2；完全結束 TransLive 後會還原。",
      restored: "VoiceMeeter 內部路由已還原。",
      unavailable:
        "無法自動設定 VoiceMeeter。請確認 VoiceMeeter Banana 已安裝後重新開啟 TransLive。",
      "restore-failed":
        "前次 VoiceMeeter 路由無法還原；本次不會開始翻譯，請先檢查 VoiceMeeter。",
      "recovery-needed":
        "VoiceMeeter 路由已由其他程式變更；為避免覆蓋，本次不會自動設定。",
      unsupported: "VoiceMeeter 自動路由僅支援 Windows。",
    }[state] ?? "VoiceMeeter 內部路由狀態尚未確認。";
}

async function initializeVoiceMeeterRouting() {
  try {
    applyVoiceMeeterRoutingStatus(
      await window.translive.voiceMeeterRoutingStatus(),
    );
  } catch {
    applyVoiceMeeterRoutingStatus({ state: "unavailable" });
  }
}

function voiceConversionPresentation(status = {}) {
  const state = status.state ?? "unavailable";
  const detail =
    {
      checking: "正在檢查本機 RVC 與硬體能力…",
      off: "已關閉，正在播放原 GPT 音色。",
      ready: "本機自訂音色已就緒；尚未改變目前 GPT‑Live 音訊路徑。",
      converting: "正在使用本機自訂音色。",
      "raw-fallback": "自訂音色暫停，正在播放原 GPT 音色。",
      unavailable:
        "需要已驗證的本機 RVC runtime 與本人已授權模型；目前使用原 GPT 音色。",
    }[state] ?? "本機自訂音色狀態尚未確認。";
  return { detail, state };
}

function updateVoiceProfileImportButton() {
  elements["voice-profile-import"].disabled = !(
    elements["voice-profile-consent"].checked &&
    elements["voice-profile-name"].value.trim()
  );
}

function updateVoiceProfileDeleteButton() {
  elements["voice-profile-delete"].disabled = !(
    elements["voice-profile-delete-confirm"].checked &&
    elements["voice-profile-select"].value
  );
}

function renderVoiceConversion(status = {}) {
  const profiles = Array.isArray(status.profiles) ? status.profiles : [];
  const select = elements["voice-profile-select"];
  const selected = status.profile?.id ?? select.value;
  select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "尚未選擇本人音色";
  select.append(placeholder);
  for (const profile of profiles) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.displayName;
    select.append(option);
  }
  if ([...select.options].some((option) => option.value === selected)) {
    select.value = selected;
  }
  ui.voiceConversion = {
    enabled: status.enabled === true,
    profiles,
    provider: status.provider ?? "unavailable",
    state: status.state ?? "unavailable",
  };
  elements["voice-conversion-toggle"].checked = ui.voiceConversion.enabled;
  elements["voice-conversion-toggle"].setAttribute(
    "aria-checked",
    String(ui.voiceConversion.enabled),
  );
  const presentation = voiceConversionPresentation(status);
  elements["voice-conversion-status"].textContent = presentation.detail;
  elements["voice-conversion-status"].dataset.state = presentation.state;
  elements["voice-empty-state"].hidden = !voiceEmptyStateVisible(
    profiles.length,
  );
  updateVoiceProfileImportButton();
  updateVoiceProfileDeleteButton();
}

async function initializeVoiceConversion() {
  try {
    renderVoiceConversion(await window.translive.voiceConversionStatus());
  } catch {
    renderVoiceConversion({ state: "unavailable" });
  }
}

function voiceConversionFailureMessage(reason) {
  return (
    {
      "profile-required": "請先選擇本人已授權的音色設定檔。",
      "capability-unavailable":
        "需要已驗證的本機 RVC runtime，已維持原 GPT 音色。",
      "runtime-unavailable":
        "需要已驗證的本機 RVC runtime，已維持原 GPT 音色。",
      "profile-unavailable":
        "選取的本人音色設定檔無法使用，已維持原 GPT 音色。",
      "profile-unverified": "匯入的模型尚待本機安全驗證，已維持原 GPT 音色。",
      "unsafe-model": "模型尚未通過安全載入驗證，已維持原 GPT 音色。",
    }[reason] ?? "無法啟用本機自訂音色，已維持原 GPT 音色。"
  );
}

function formatVoiceTrainingDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.floor(Number(durationMs) / 1_000));
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(
    totalSeconds % 60,
  ).padStart(2, "0")}`;
}

function voiceTrainingPresentation(status = {}) {
  const state = status.state ?? "idle";
  const detail =
    {
      idle: "選擇實體麥克風並確認本人聲音後，即可開始本機錄製。",
      recording: "正在本機錄製。請以自然語速朗讀，避免背景音樂與他人說話。",
      paused: "錄製已暫停；可繼續或取消並刪除本機工作。",
      inspecting: "正在以固定本機工具檢查錄音格式、時長與訊號品質…",
      normalizing: "正在本機正規化單聲道訓練音訊…",
      "ready-to-train": "錄音已檢查完成。CPU 訓練可能需要較長時間。",
      training: "正在本機 CPU 訓練。可以取消；取消會刪除未完成音訊與輸出。",
      verified:
        "本人音色模型已通過本機 weights-only 驗證，可在 RVC 設定檔中啟用。",
      failed: "本機錄製或訓練未完成；未建立可用音色模型。",
      canceled: "本機錄製或訓練已取消，敏感工作檔已刪除。",
    }[state] ?? "本機本人音色狀態尚未確認。";
  return { detail, state };
}

function currentVoiceTrainingDuration() {
  const media = ui.voiceTraining.media;
  if (!media) return ui.voiceTraining.status.elapsedDurationMs ?? 0;
  return Math.min(
    VOICE_TRAINING_POLICY.maximumDurationMs,
    media.elapsedBeforePause +
      (media.paused ? 0 : Math.max(0, Date.now() - media.segmentStartedAt)),
  );
}

function updateVoiceTrainingReadout() {
  const media = ui.voiceTraining.media;
  const durationMs = currentVoiceTrainingDuration();
  const targetDurationMs =
    ui.voiceTraining.status.targetDurationMs ??
    VOICE_TRAINING_POLICY.targetDurationMs;
  const progress =
    ui.voiceTraining.status.state === "training"
      ? (ui.voiceTraining.status.progress ?? 0)
      : Math.min(100, Math.round((durationMs / targetDurationMs) * 100));
  elements["voice-training-elapsed"].textContent =
    `${formatVoiceTrainingDuration(
      durationMs,
    )} / ${formatVoiceTrainingDuration(targetDurationMs)}`;
  elements["voice-training-progress"].value = progress;
  if (!media) return;
  const sampled = Math.max(1, media.level.sampledFrames);
  elements["voice-training-level"].textContent = `輸入電平：${Math.round(
    media.level.peak * 100,
  )}%`;
  elements["voice-training-clip"].textContent =
    `削波：${media.level.clippedFrames}`;
  elements["voice-training-silence"].textContent = `靜音：${Math.round(
    (media.level.silentFrames / sampled) * 100,
  )}%`;
}

function updateVoiceTrainingControls() {
  const status = ui.voiceTraining.status;
  const state = status.state ?? "idle";
  const runtimeAvailable = ui.voiceTraining.runtime?.available === true;
  const hasMic = Boolean(elements["voice-training-microphone"].value);
  const consent = elements["voice-training-consent"].checked;
  const name = elements["voice-profile-name"].value.trim();
  const recording = ui.voiceTraining.media;
  const finalConsent = elements["voice-training-final-consent"].checked;
  elements["voice-training-start"].disabled = !(
    ["idle", "canceled", "failed"].includes(state) &&
    runtimeAvailable &&
    hasMic &&
    consent &&
    name
  );
  elements["voice-training-pause"].disabled = !(
    state === "recording" && recording
  );
  elements["voice-training-resume"].disabled = !(
    state === "paused" && recording
  );
  elements["voice-training-stop"].disabled = !(
    ["recording", "paused"].includes(state) && recording
  );
  elements["voice-training-train"].disabled = !(
    state === "ready-to-train" &&
    runtimeAvailable &&
    finalConsent
  );
  elements["voice-training-cancel"].disabled = ![
    "recording",
    "paused",
    "inspecting",
    "normalizing",
    "training",
  ].includes(state);
  elements["voice-training-delete"].disabled = !(
    Boolean(status.id) && elements["voice-training-delete-confirm"].checked
  );
}

function renderVoiceTraining(status = {}) {
  const runtime = status.runtime ?? ui.voiceTraining.runtime;
  ui.voiceTraining.runtime = {
    available: runtime?.available === true,
    provider: runtime?.provider ?? "unavailable",
  };
  ui.voiceTraining.status = {
    ...ui.voiceTraining.status,
    ...status,
  };
  const presentation = voiceTrainingPresentation(ui.voiceTraining.status);
  const provider = ui.voiceTraining.runtime.provider;
  elements["voice-training-status"].textContent =
    provider === "unavailable"
      ? "需要固定且驗證通過的本機 RVC runtime；不會保留本人錄音。"
      : `${presentation.detail} 訓練提供者：CPU；DirectML：推論候選。`;
  elements["voice-training-status"].dataset.state = presentation.state;
  updateVoiceTrainingReadout();
  updateVoiceTrainingControls();
}

function updateVoiceTrainingLevel() {
  const media = ui.voiceTraining.media;
  if (!media || media.paused) return;
  media.analyser.getByteTimeDomainData(media.samples);
  let peak = 0;
  for (const sample of media.samples) {
    peak = Math.max(peak, Math.abs(sample - 128) / 128);
  }
  media.level.sampledFrames += 1;
  media.level.peak = Math.max(media.level.peak, peak);
  if (peak >= 0.98) media.level.clippedFrames += 1;
  if (peak <= 0.015) media.level.silentFrames += 1;
  updateVoiceTrainingReadout();
}

function releaseVoiceTrainingMedia({ discard = false, media } = {}) {
  const active = media ?? ui.voiceTraining.media;
  if (!active) return;
  active.discard ||= discard;
  window.clearInterval(active.levelTimer);
  window.clearInterval(active.elapsedTimer);
  active.audioContext.close().catch(() => {});
  for (const track of active.stream.getTracks()) track.stop();
  if (ui.voiceTraining.media === active) ui.voiceTraining.media = undefined;
}

async function uploadVoiceTrainingRecording(media) {
  if (media.generation !== ui.voiceTraining.generation || media.discard) return;
  const blob = new Blob(media.chunks, { type: media.mimeType });
  if (blob.size === 0 || blob.size > VOICE_TRAINING_POLICY.maxRecordingBytes) {
    throw new Error("VOICE_TRAINING_RECORDING_BYTES_INVALID");
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const status = await window.translive.voiceTrainingStopRecording({
    id: media.id,
    recording: { bytes },
  });
  if (media.generation !== ui.voiceTraining.generation || media.discard) return;
  releaseVoiceTrainingMedia();
  renderVoiceTraining(status);
}

async function startVoiceTrainingRecording() {
  const microphone = elements["voice-training-microphone"];
  const option = microphone.selectedOptions[0];
  try {
    const status = await window.translive.voiceTrainingStartRecording({
      confirmedOwnAuthorizedVoice:
        elements["voice-training-consent"].checked === true,
      displayName: elements["voice-profile-name"].value,
      microphoneLabel: option?.textContent ?? "",
    });
    renderVoiceTraining(status);
    if (
      window.MediaRecorder === undefined ||
      !MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ) {
      throw new Error("VOICE_TRAINING_RECORDER_UNAVAILABLE");
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: false,
        deviceId: { exact: microphone.value },
        echoCancellation: false,
        noiseSuppression: false,
      },
      video: false,
    });
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    const recorder = new MediaRecorder(stream, {
      mimeType: "audio/webm;codecs=opus",
    });
    const media = {
      analyser,
      audioContext,
      chunks: [],
      discard: false,
      elapsedBeforePause: 0,
      generation: ++ui.voiceTraining.generation,
      id: status.id,
      level: { clippedFrames: 0, peak: 0, sampledFrames: 0, silentFrames: 0 },
      levelTimer: undefined,
      mimeType: recorder.mimeType.toLowerCase(),
      paused: false,
      recorder,
      samples: new Uint8Array(analyser.fftSize),
      segmentStartedAt: Date.now(),
      stream,
      elapsedTimer: undefined,
    };
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) media.chunks.push(event.data);
    });
    recorder.addEventListener("stop", () => {
      if (media.discard || media.generation !== ui.voiceTraining.generation) {
        releaseVoiceTrainingMedia({ discard: true, media });
        return;
      }
      void uploadVoiceTrainingRecording(media).catch(async () => {
        releaseVoiceTrainingMedia({ discard: true, media });
        if (media.generation !== ui.voiceTraining.generation) return;
        await window.translive.voiceTrainingCancel();
        renderVoiceTraining({ state: "failed" });
        showAssertiveError("無法保存本機本人音色錄音，敏感工作檔已取消。");
      });
    });
    recorder.start(1_000);
    media.levelTimer = window.setInterval(updateVoiceTrainingLevel, 100);
    media.elapsedTimer = window.setInterval(() => {
      if (
        currentVoiceTrainingDuration() >=
        VOICE_TRAINING_POLICY.maximumDurationMs
      ) {
        void stopVoiceTrainingRecording();
        return;
      }
      updateVoiceTrainingReadout();
    }, 250);
    ui.voiceTraining.media = media;
    renderVoiceTraining({ ...status, state: "recording" });
  } catch {
    releaseVoiceTrainingMedia({ discard: true });
    await window.translive.voiceTrainingCancel().catch(() => {});
    renderVoiceTraining({ state: "idle" });
    showAssertiveError(
      "無法開始本人音色錄製。請確認實體麥克風、同意與固定本機 RVC runtime。",
    );
  }
}

async function pauseVoiceTrainingRecording() {
  const media = ui.voiceTraining.media;
  if (!media || media.recorder.state !== "recording") return;
  try {
    const status = await window.translive.voiceTrainingPauseRecording(media.id);
    media.elapsedBeforePause += Math.max(
      0,
      Date.now() - media.segmentStartedAt,
    );
    media.paused = true;
    media.recorder.pause();
    renderVoiceTraining(status);
  } catch {
    showAssertiveError("無法暫停本人音色錄製。");
  }
}

async function resumeVoiceTrainingRecording() {
  const media = ui.voiceTraining.media;
  if (!media || media.recorder.state !== "paused") return;
  try {
    const status = await window.translive.voiceTrainingResumeRecording(
      media.id,
    );
    media.segmentStartedAt = Date.now();
    media.paused = false;
    media.recorder.resume();
    renderVoiceTraining(status);
  } catch {
    showAssertiveError("無法繼續本人音色錄製。");
  }
}

async function stopVoiceTrainingRecording() {
  const media = ui.voiceTraining.media;
  if (!media || media.recorder.state === "inactive") return;
  if (!media.paused) {
    media.elapsedBeforePause += Math.max(
      0,
      Date.now() - media.segmentStartedAt,
    );
    media.paused = true;
  }
  media.recorder.stop();
  updateVoiceTrainingControls();
}

async function cancelVoiceTraining() {
  ui.voiceTraining.generation += 1;
  const media = ui.voiceTraining.media;
  if (media) {
    media.discard = true;
    if (media.recorder.state !== "inactive") media.recorder.stop();
    releaseVoiceTrainingMedia({ discard: true });
  }
  try {
    renderVoiceTraining(await window.translive.voiceTrainingCancel());
  } catch {
    showAssertiveError("無法取消本人音色工作，請完全退出 TransLive 後再試。");
  }
}

async function startVoiceTraining() {
  try {
    renderVoiceTraining(
      await window.translive.voiceTrainingStart({
        confirmedOwnAuthorizedVoice:
          elements["voice-training-final-consent"].checked === true,
        consentVersion: VOICE_TRAINING_POLICY.version,
        id: ui.voiceTraining.status.id,
      }),
    );
    elements["voice-training-final-consent"].checked = false;
  } catch {
    showAssertiveError("無法開始本機 CPU 訓練，已保留可刪除的本機錄音工作。");
  }
}

async function deleteVoiceTraining() {
  ui.voiceTraining.generation += 1;
  try {
    await window.translive.voiceTrainingDelete({
      confirmedDeleteTraining:
        elements["voice-training-delete-confirm"].checked === true,
      id: ui.voiceTraining.status.id,
    });
    elements["voice-training-delete-confirm"].checked = false;
    renderVoiceTraining(await window.translive.voiceTrainingStatus());
  } catch {
    showAssertiveError("無法刪除本人音色工作，請稍後再試。");
  }
}

async function initializeVoiceTraining() {
  try {
    renderVoiceTraining(await window.translive.voiceTrainingStatus());
  } catch {
    renderVoiceTraining({ state: "idle" });
  }
}

async function initializeTray() {
  try {
    const tray = await window.translive.trayStatus();
    elements["tray-close-behavior"].value = tray.closeBehavior;
    elements["tray-close-behavior"].disabled = !tray.supported;
    if (!tray.supported) {
      elements["tray-close-behavior"].title = "系統匣僅支援 Windows";
    }
  } catch {
    elements["tray-close-behavior"].disabled = true;
  }
}

async function initializeConsent() {
  try {
    const result = await window.translive.recordsConsentStatus();
    ui.consent.granted = result.granted === true;
  } catch {
    ui.consent.granted = false;
  }
  updateSavingStatus();
}

async function initializeRetention() {
  try {
    const status = await window.translive.recordsRetentionStatus();
    elements["settings-retention-status"].textContent =
      `${status.sessionCount}/${status.maxSessions} 場 · ${formatBytes(status.bytes)}/${formatBytes(status.maxBytes)}`;
  } catch {
    elements["settings-retention-status"].textContent = "無法取得保存狀態";
  }
}

async function initializeAccount() {
  setAccountState("checking");
  try {
    const result = await window.translive.accountStatus();
    setAccountState(result.state);
    setAppState(result.state === "connected" ? "ready" : "logged-out");
    if (result.state === "connected") await refreshDevices();
  } catch {
    setAccountState("failed");
    setAppState("logged-out");
    elements["auth-status"].textContent = "無法確認登入狀態，請重新連接。";
  }
}

async function startAccountLogin() {
  try {
    setAccountState("waiting");
    setAppState("auth-waiting");
    await window.translive.accountLogin();
  } catch {
    setAccountState("failed");
    setAppState("logged-out");
    elements["auth-status"].textContent = "無法開啟登入流程，請稍後再試。";
  }
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function recordTime(value) {
  return Number.isFinite(value)
    ? new Date(value).toLocaleString("zh-TW", {
        hour: "2-digit",
        minute: "2-digit",
        month: "2-digit",
        day: "2-digit",
      })
    : "未提供時間";
}

function recordOffset(value) {
  const milliseconds = Math.max(0, Math.round(value ?? 0));
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const remainder = milliseconds % 1_000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(remainder).padStart(3, "0")}`;
}

function recordModeLabel(mode) {
  return modeLabel(mode ?? "meeting");
}

function summaryStateText() {
  const request = ui.records.summaryRequest;
  if (!request) return "";
  return request.state === "generating" || request.state === "canceling"
    ? "正在產生摘要…"
    : "";
}

function updateRecordsSelection() {
  const count = ui.records.selected.size;
  elements["records-selection"].textContent =
    count >= 2 ? `已選 ${count} 場紀錄` : "選擇 2 場以上紀錄即可匯整摘要";
  elements["aggregate-summary-button"].disabled = count < 2;
}

function recordTitle(session) {
  const platform =
    { teams: "Teams", zoom: "Zoom", custom: "其他來源" }[session.platform] ??
    "TransLive";
  return `${recordTime(session.startedAtMs)} · ${platform}`;
}

function createRecordRow(session) {
  const row = document.createElement("div");
  row.className = "record-row";
  row.classList.toggle(
    "is-active",
    ui.records.current?.kind === "session" &&
      ui.records.current.id === session.id,
  );
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = ui.records.selected.has(session.id);
  checkbox.setAttribute("aria-label", `選擇 ${recordTitle(session)}`);
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) ui.records.selected.add(session.id);
    else ui.records.selected.delete(session.id);
    updateRecordsSelection();
  });
  const button = document.createElement("button");
  button.type = "button";
  const title = document.createElement("strong");
  title.textContent = recordTitle(session);
  const detail = document.createElement("small");
  detail.textContent = `${recordModeLabel(session.mode)} · ${session.entryCount} 段 · ${session.hasSummary ? "已摘要" : "未摘要"}`;
  button.append(title, detail);
  button.addEventListener("click", () => void selectSession(session.id));
  row.append(checkbox, button);
  return row;
}

function createAggregateRow(aggregate) {
  const row = document.createElement("div");
  row.className = "record-row aggregate-row";
  row.classList.toggle(
    "is-active",
    ui.records.current?.kind === "aggregate" &&
      ui.records.current.id === aggregate.id,
  );
  const marker = document.createElement("span");
  marker.textContent = "匯";
  marker.setAttribute("aria-hidden", "true");
  const button = document.createElement("button");
  button.type = "button";
  const title = document.createElement("strong");
  title.textContent = `跨場摘要 · ${recordTime(aggregate.generatedAtMs)}`;
  const detail = document.createElement("small");
  detail.textContent = `${aggregate.sourceSessions.length} 場來源紀錄`;
  button.append(title, detail);
  button.addEventListener("click", () => void selectAggregate(aggregate.id));
  row.append(marker, button);
  return row;
}

function renderRecordsList() {
  elements["records-list"].replaceChildren();
  if (ui.records.sessions.length === 0 && ui.records.aggregates.length === 0) {
    const empty = document.createElement("p");
    empty.className = "placeholder-copy";
    empty.textContent = "尚無已保存的逐字稿。完成一次翻譯後會顯示在這裡。";
    elements["records-list"].append(empty);
    return;
  }
  for (const session of ui.records.sessions) {
    elements["records-list"].append(createRecordRow(session));
  }
  if (ui.records.aggregates.length > 0) {
    const heading = document.createElement("p");
    heading.className = "records-group-label";
    heading.textContent = "跨場摘要匯整";
    elements["records-list"].append(heading);
    for (const aggregate of ui.records.aggregates) {
      elements["records-list"].append(createAggregateRow(aggregate));
    }
  }
}

function detailAction(label, handler, className = "text-button") {
  const button = document.createElement("button");
  button.className = className;
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

function renderSummaryPending() {
  const detail = elements["record-detail"];
  detail.replaceChildren();
  const status = document.createElement("div");
  status.className = "summary-state";
  status.textContent = summaryStateText();
  const cancel = detailAction(
    "取消摘要",
    () => {
      void window.translive.summaryCancel(ui.records.summaryRequest.requestId);
    },
    "secondary-button",
  );
  detail.append(status, cancel);
}

function renderStructuredSummary(detail, summary) {
  const sections = summary?.structured?.sections;
  if (!sections || typeof sections !== "object") {
    const markdown = document.createElement("pre");
    markdown.className = "summary-markdown";
    markdown.textContent = summary?.markdown ?? "摘要資料無法讀取。";
    detail.append(markdown);
    return;
  }
  for (const [heading, items] of Object.entries(sections)) {
    const section = document.createElement("section");
    section.className = "semantic-summary-section";
    const title = document.createElement("h3");
    title.textContent = heading;
    const list = document.createElement("ul");
    if (!Array.isArray(items) || items.length === 0) {
      const item = document.createElement("li");
      item.textContent = "未提供";
      list.append(item);
    } else {
      for (const summaryItem of items) {
        const item = document.createElement("li");
        const citations = (summaryItem.citations ?? [])
          .map(
            (citation) =>
              `【${citation.sessionId} @ ${recordOffset(citation.offsetMs)}】`,
          )
          .join("");
        const taskDetails =
          summaryItem.owner === undefined
            ? ""
            : `；負責人：${summaryItem.owner}；日期：${summaryItem.date}`;
        item.textContent = `${summaryItem.text}${taskDetails}${citations}`;
        list.append(item);
      }
    }
    section.append(title, list);
    detail.append(section);
  }
}

async function exportSession(id) {
  try {
    const result = await window.translive.recordsExport(id);
    if (result.exported === false) return;
    elements["records-status"].textContent = "逐字稿已匯出。";
  } catch {
    showAssertiveError("無法匯出逐字稿，請稍後再試。");
  }
}

async function exportAggregate(id) {
  try {
    const result = await window.translive.aggregatesExport(id);
    if (result.exported === false) return;
    elements["records-status"].textContent = "跨場摘要已匯出。";
  } catch {
    showAssertiveError("無法匯出跨場摘要，請稍後再試。");
  }
}

function renderTranscript(session) {
  const detail = elements["record-detail"];
  detail.replaceChildren();
  const title = document.createElement("h2");
  title.textContent = recordTitle(session.metadata);
  const actions = document.createElement("div");
  actions.className = "record-detail-actions";
  actions.append(
    detailAction(session.summary ? "重新產生摘要" : "產生摘要", () =>
      openSummaryConfirm({
        kind: "session",
        sessionIds: [session.metadata.id],
      }),
    ),
    detailAction(
      "匯出 Markdown",
      () => void exportSession(session.metadata.id),
    ),
    detailAction(
      "開啟 Markdown 資料夾",
      () => void window.translive.recordsOpenFolder(session.metadata.id),
    ),
    detailAction(
      "刪除",
      () => void deleteSession(session.metadata.id),
      "text-button danger-text",
    ),
  );
  const tabs = document.createElement("div");
  tabs.className = "record-tabs";
  const transcriptTab = detailAction("逐字稿", () => {
    ui.records.tab = "transcript";
    renderSessionDetail(session);
  });
  transcriptTab.classList.toggle("is-active", ui.records.tab === "transcript");
  const summaryTab = detailAction("單場摘要", () => {
    ui.records.tab = "summary";
    renderSessionDetail(session);
  });
  summaryTab.classList.toggle("is-active", ui.records.tab === "summary");
  tabs.append(transcriptTab, summaryTab);
  actions.append(tabs);
  detail.append(title, actions);

  if (ui.records.tab === "summary") {
    if (!session.summary) {
      const empty = document.createElement("p");
      empty.className = "placeholder-copy";
      empty.textContent = "尚未產生單場摘要。";
      detail.append(empty);
      return;
    }
    const kind = document.createElement("p");
    kind.className = "summary-kind";
    kind.textContent = "單場摘要";
    detail.append(kind);
    renderStructuredSummary(detail, session.summary);
    return;
  }

  for (const entry of session.entries) {
    const row = document.createElement("article");
    row.className = "transcript-entry";
    const meta = document.createElement("div");
    const time = document.createElement("time");
    time.textContent = recordOffset(entry.offsetMs ?? entry.atMs);
    const side = document.createElement("span");
    side.className = "entry-side";
    side.textContent = `${entry.direction.toUpperCase()} · ${entry.side === "source" ? "來源" : "翻譯"}`;
    meta.append(time, side);
    const text = document.createElement("p");
    text.textContent = entry.text;
    row.append(meta, text);
    detail.append(row);
  }
}

function renderSessionDetail(session) {
  if (ui.records.summaryRequest) {
    renderSummaryPending();
    return;
  }
  renderTranscript(session);
}

function renderAggregateDetail(aggregate) {
  const detail = elements["record-detail"];
  detail.replaceChildren();
  const title = document.createElement("h2");
  title.textContent = "跨場摘要匯整";
  const actions = document.createElement("div");
  actions.className = "record-detail-actions";
  actions.append(
    detailAction("重新產生", () =>
      openSummaryConfirm({
        kind: "aggregate",
        sessionIds: aggregate.metadata.sourceSessions.map(
          (source) => source.id,
        ),
      }),
    ),
    detailAction(
      "匯出 Markdown",
      () => void exportAggregate(aggregate.metadata.id),
    ),
    detailAction(
      "開啟 Markdown 資料夾",
      () => void window.translive.aggregatesOpenFolder(aggregate.metadata.id),
    ),
    detailAction(
      "刪除",
      () => void deleteAggregate(aggregate.metadata.id),
      "text-button danger-text",
    ),
  );
  const kind = document.createElement("p");
  kind.className = "summary-kind";
  kind.textContent = `來源 ${aggregate.metadata.sourceSessions.length} 場紀錄`;
  detail.append(title, actions, kind);
  renderStructuredSummary(detail, aggregate);
}

async function selectSession(id) {
  try {
    ui.records.current = { id, kind: "session" };
    ui.records.tab = "transcript";
    const session = await window.translive.recordsRead(id);
    ui.records.current.data = session;
    renderRecordsList();
    renderSessionDetail(session);
  } catch {
    elements["records-status"].textContent = "無法讀取這場紀錄。";
  }
}

async function selectAggregate(id) {
  try {
    ui.records.current = { id, kind: "aggregate" };
    const aggregate = await window.translive.aggregatesRead(id);
    ui.records.current.data = aggregate;
    renderRecordsList();
    renderAggregateDetail(aggregate);
  } catch {
    elements["records-status"].textContent = "無法讀取跨場摘要。";
  }
}

async function deleteSession(id) {
  if (!window.confirm("刪除這場逐字稿與單場摘要？此操作無法復原。")) return;
  try {
    await window.translive.recordsDelete(id);
    ui.records.selected.delete(id);
    ui.records.current = undefined;
    await loadRecords();
  } catch {
    showAssertiveError("無法刪除這場紀錄，請稍後再試。");
  }
}

async function deleteAggregate(id) {
  if (!window.confirm("刪除這份跨場摘要？此操作無法復原。")) return;
  try {
    await window.translive.aggregatesDelete(id);
    ui.records.current = undefined;
    await loadRecords();
  } catch {
    showAssertiveError("無法刪除跨場摘要，請稍後再試。");
  }
}

async function loadRecords() {
  elements["records-status"].textContent = "正在載入本機紀錄…";
  try {
    const [sessions, aggregates] = await Promise.all([
      window.translive.recordsList(),
      window.translive.aggregatesList(),
    ]);
    ui.records.sessions = sessions;
    ui.records.aggregates = aggregates;
    ui.records.selected = new Set(
      [...ui.records.selected].filter((id) =>
        sessions.some((session) => session.id === id),
      ),
    );
    updateRecordsSelection();
    renderRecordsList();
    elements["records-status"].textContent =
      summaryStateText() ||
      `${sessions.length} 場紀錄 · ${aggregates.length} 份跨場摘要`;
    if (!ui.records.current && sessions[0]) await selectSession(sessions[0].id);
  } catch {
    elements["records-status"].textContent = "無法讀取本機紀錄。";
  }
}

function openSummaryConfirm({ kind, sessionIds }) {
  ui.records.pendingSummary = { kind, sessionIds };
  const aggregate = kind === "aggregate";
  elements["summary-confirm-title"].textContent = aggregate
    ? "匯整跨場摘要"
    : "產生單場摘要";
  elements["summary-confirm-copy"].textContent = aggregate
    ? `將 ${sessionIds.length} 場已選逐字稿再次送至 ChatGPT 文字模型，產生共同主題、決策演變、待辦與未決問題。`
    : "將這場逐字稿再次送至 ChatGPT 文字模型，產生重點、決策、待辦與未決問題。";
  setSummaryConfirm(true);
}

async function confirmSummary() {
  const pending = ui.records.pendingSummary;
  if (!pending) return;
  try {
    const started =
      pending.kind === "aggregate"
        ? await window.translive.summaryAggregateStart({
            confirmed: true,
            sessionIds: pending.sessionIds,
          })
        : await window.translive.summarySessionStart({
            confirmed: true,
            sessionId: pending.sessionIds[0],
          });
    ui.records.summaryRequest = started;
    setSummaryConfirm(false);
    renderSummaryPending();
    elements["records-status"].textContent = "正在產生摘要…";
  } catch {
    setSummaryConfirm(false);
    elements["records-status"].textContent = "無法開始摘要，請稍後再試。";
  }
}

function handleSummaryEvent(event) {
  if (event.state === "generating" || event.state === "canceling") return;
  if (ui.records.summaryRequest?.requestId !== event.requestId) return;
  ui.records.summaryRequest = undefined;
  if (event.state === "completed") {
    ui.records.current = {
      id: event.summaryId,
      kind: event.kind === "aggregate" ? "aggregate" : "session",
    };
    void loadRecords().then(() => {
      if (event.kind === "aggregate") void selectAggregate(event.summaryId);
      else void selectSession(event.summaryId);
    });
  } else if (event.state === "canceled") {
    elements["records-status"].textContent = "摘要已取消。";
    if (ui.records.current?.data) renderSessionDetail(ui.records.current.data);
  } else {
    elements["records-status"].textContent =
      "無法產生摘要，請檢查 ChatGPT 登入與網路後再試。";
    showAssertiveError("無法產生摘要，請檢查 ChatGPT 登入與網路後再試。");
  }
}

function setView(view) {
  document.body.dataset.view = view;
  for (const button of document.querySelectorAll("[data-view-button]")) {
    button.classList.toggle("is-active", button.dataset.viewButton === view);
  }
  if (view === "history") void loadRecords();
}

for (const button of document.querySelectorAll("[data-mode-button]")) {
  button.addEventListener("click", () => setMode(button.dataset.modeButton));
}
elements["route-profile"].addEventListener("change", () => {
  applyModeDeviceRecommendations();
  updateReadyMessage();
});
elements["physical-mic"].addEventListener("change", () =>
  rememberManualPhysicalDevice("physicalMic"),
);
elements["headphones"].addEventListener("change", () =>
  rememberManualPhysicalDevice("headphones"),
);
for (const button of document.querySelectorAll("[data-view-button]")) {
  button.addEventListener("click", () => setView(button.dataset.viewButton));
}
elements["refresh-devices"].addEventListener("click", refreshDevices);
navigator.mediaDevices?.addEventListener("devicechange", async () => {
  await refreshDevices();
  const reaction = decideDeviceChangeReaction({
    appState: ui.app,
    missingSlots: ui.missingRecommendedDevices,
    mode: ui.mode,
  });
  if (reaction.level === "warn") showAssertiveError(reaction.message);
});
elements["account-login-button"].addEventListener("click", startAccountLogin);
elements["account-login-cancel"].addEventListener("click", async () => {
  await window.translive.accountLoginCancel();
  setAccountState("logged-out");
  setAppState("logged-out");
  elements["auth-status"].textContent = "登入已取消。";
});
elements["consent-checkbox"].addEventListener("change", (event) => {
  elements["consent-confirm"].disabled = !event.target.checked;
});
elements["consent-confirm"].addEventListener("click", async () => {
  try {
    await window.translive.recordsConsentGrant({ confirmed: true });
    ui.consent.granted = true;
    ui.consent.skipForCurrentRun = false;
    setConsentModal(false);
    await startTranslation();
  } catch {
    showAssertiveError("無法保存逐字稿同意設定，這次不會保存逐字稿。");
    ui.consent.skipForCurrentRun = true;
    setConsentModal(false);
    await startTranslation();
  }
});
elements["consent-decline"].addEventListener("click", async () => {
  ui.consent.skipForCurrentRun = true;
  setConsentModal(false);
  await startTranslation();
});
elements["blocked-action"].addEventListener("click", () => {
  if (ui.account === "connected") setAppState("ready");
  else void startAccountLogin();
});
elements["start-button"].addEventListener("click", startTranslation);
elements["speak-conclusions-button"].addEventListener("click", () => {
  setQaBusy(true);
  window.translive.assistantSpeakConclusions().catch(() => {
    setQaBusy(false);
    showAssertiveError("無法產生口播結論，請稍後再試。");
  });
});
elements["qa-approve"].addEventListener("click", () => {
  if (!ui.pendingAnswerId) return;
  elements["qa-approve"].disabled = true;
  elements["qa-approve"].textContent = "送出中…";
  window.translive
    .assistantApprove(ui.pendingAnswerId)
    .catch(() => showQaNotice("語音送出失敗，請檢查連線後再試"))
    .finally(() => {
      elements["qa-approve"].textContent = "送入會議語音";
      elements["qa-approve"].disabled = false;
    });
});
elements["qa-reject"].addEventListener("click", () => {
  if (!ui.pendingAnswerId) return;
  window.translive.assistantReject(ui.pendingAnswerId).catch(() => {});
});
elements["assistant-wake-phrase"].addEventListener("change", () => {
  updateWakeHint();
  saveAssistantPreferences();
});
elements["assistant-wake-armed"].addEventListener("change", (event) => {
  window.translive.assistantSetWakeArmed(event.target.checked).catch(() => {});
  saveAssistantPreferences();
});
elements["assistant-answer-delivery"].addEventListener("change", () => {
  saveAssistantPreferences();
});

async function saveAssistantPreferences() {
  try {
    await window.translive.assistantPreferencesSave({
      answerDelivery: elements["assistant-answer-delivery"].value,
      wakeArmed: elements["assistant-wake-armed"].checked,
      wakePhrase: elements["assistant-wake-phrase"].value,
    });
    updateWakeHint();
  } catch {
    // Preference persistence is best-effort; the run keeps working.
  }
}

function updateWakeHint() {
  const phrase = elements["assistant-wake-phrase"].value.trim() || "translive";
  elements["qa-hint"].textContent = `說「${phrase},…」即可提問`;
}

async function initializeAssistantPreferences() {
  try {
    const preferences = await window.translive.assistantPreferencesLoad();
    elements["assistant-answer-delivery"].value = preferences.answerDelivery;
    elements["assistant-wake-armed"].checked = preferences.wakeArmed;
    elements["assistant-wake-phrase"].value = preferences.wakePhrase;
    updateWakeHint();
  } catch {
    // Defaults in the markup already match the safe settings.
  }
}
elements["cancel-connect-button"].addEventListener(
  "click",
  () => void cancelTranslationStartup(),
);
elements["stop-button"].addEventListener("click", stopTranslation);
elements["restart-button"].addEventListener("click", startTranslation);
for (const button of document.querySelectorAll(".mute-button")) {
  button.addEventListener("click", () =>
    toggleMute(button.dataset.direction || activeSingleDirection()),
  );
}
elements["diagnostics-button"].addEventListener("click", () => setDrawer(true));
elements["status-open-diagnostics"].addEventListener("click", () =>
  setDrawer(true),
);
elements["audio-role-info"].addEventListener("click", () => {
  const note = elements["role-note"];
  note.hidden = !note.hidden;
  elements["audio-role-info"].setAttribute(
    "aria-expanded",
    String(!note.hidden),
  );
});
elements["diagnostics-button-live"].addEventListener("click", () =>
  setDrawer(true),
);
elements["close-diagnostics"].addEventListener("click", () => setDrawer(false));
elements["drawer-scrim"].addEventListener("click", () => {
  setDrawer(false);
  setQuickSetup(false);
  setSummaryConfirm(false);
});
elements["quick-setup-button"].addEventListener("click", () => {
  if (!["meeting", "assistant"].includes(ui.mode)) return;
  setQuickSetup(true);
});
elements["close-quick-setup"].addEventListener("click", () =>
  setQuickSetup(false),
);
elements["apply-quick-setup"].addEventListener(
  "click",
  () => void applyQuickSetup(),
);
elements["quick-open-settings"].addEventListener(
  "click",
  () => void openQuickManualSettings(),
);
elements["records-refresh"].addEventListener("click", () => void loadRecords());
elements["records-delete-all"].addEventListener("click", () =>
  setDeleteConfirm(true),
);
elements["delete-confirm-input"].addEventListener("input", (event) => {
  elements["delete-confirm-action"].disabled = event.target.value !== "DELETE";
});
elements["delete-confirm-cancel"].addEventListener("click", () =>
  setDeleteConfirm(false),
);
elements["delete-confirm-action"].addEventListener("click", async () => {
  try {
    await window.translive.recordsDeleteAll({ confirmation: "DELETE" });
    ui.records.current = undefined;
    ui.records.selected.clear();
    setDeleteConfirm(false);
    await loadRecords();
  } catch {
    showAssertiveError("無法刪除全部紀錄，請稍後再試。");
  }
});
elements["aggregate-summary-button"].addEventListener("click", () =>
  openSummaryConfirm({
    kind: "aggregate",
    sessionIds: [...ui.records.selected],
  }),
);
elements["summary-confirm-cancel"].addEventListener("click", () =>
  setSummaryConfirm(false),
);
elements["summary-confirm-action"].addEventListener(
  "click",
  () => void confirmSummary(),
);
elements["stopped-open-records"].addEventListener("click", () =>
  setView("history"),
);
elements["stopped-generate-summary"].addEventListener("click", () => {
  if (!ui.lastSavedRecord?.id) return;
  openSummaryConfirm({
    kind: "session",
    sessionIds: [ui.lastSavedRecord.id],
  });
});
for (const button of document.querySelectorAll("[data-quick-app]")) {
  button.addEventListener("click", () => setQuickApp(button.dataset.quickApp));
}
elements["mini-overlay-button"].addEventListener("click", async () => {
  try {
    await window.translive.miniCaptionShow(miniCaptionSnapshot());
  } catch {
    showAssertiveError("無法開啟迷你字幕視窗，請稍後再試。");
  }
});
elements["account-button"].addEventListener("click", () => setView("settings"));
elements["settings-account-button"].addEventListener(
  "click",
  startAccountLogin,
);
elements["settings-logout-button"].addEventListener("click", async () => {
  await window.translive.accountLogout();
  setAccountState("logged-out");
  setView("translate");
  setAppState("logged-out");
});
elements["theme-button"].addEventListener("click", () => {
  const next =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  elements["theme-label"].textContent = next === "dark" ? "深色" : "淺色";
});
elements["settings-runtime-button"].addEventListener("click", () =>
  setDrawer(true),
);
elements["settings-retention-button"].addEventListener("click", () =>
  setView("history"),
);
elements["voice-conversion-toggle"].addEventListener(
  "change",
  async (event) => {
    const enabled = event.target.checked;
    try {
      const status = await window.translive.voiceConversionSetEnabled({
        enabled,
        profileId: elements["voice-profile-select"].value || undefined,
      });
      renderVoiceConversion(status);
      if (enabled && status.enabled !== true) {
        showAssertiveError(voiceConversionFailureMessage(status.reason));
      }
    } catch {
      event.target.checked = false;
      showAssertiveError("無法啟用本機自訂音色，已維持原 GPT 音色。");
    }
  },
);
elements["voice-profile-select"].addEventListener("change", async () => {
  updateVoiceProfileDeleteButton();
  if (!ui.voiceConversion.enabled) return;
  try {
    renderVoiceConversion(
      await window.translive.voiceConversionSetEnabled({ enabled: false }),
    );
  } catch {
    showAssertiveError("無法切換本人音色，已維持原 GPT 音色。");
  }
});
elements["voice-profile-consent"].addEventListener(
  "change",
  updateVoiceProfileImportButton,
);
elements["voice-profile-delete-confirm"].addEventListener(
  "change",
  updateVoiceProfileDeleteButton,
);
elements["voice-profile-name"].addEventListener(
  "input",
  updateVoiceProfileImportButton,
);
elements["voice-profile-import"].addEventListener("click", async () => {
  try {
    const result = await window.translive.voiceProfileImport({
      confirmedOwnAuthorizedVoice:
        elements["voice-profile-consent"].checked === true,
      displayName: elements["voice-profile-name"].value,
    });
    renderVoiceConversion(result.status);
    if (result.imported) {
      elements["voice-profile-name"].value = "";
      elements["voice-profile-consent"].checked = false;
      updateVoiceProfileImportButton();
    }
  } catch {
    showAssertiveError(
      "無法匯入本人音色。請確認同意、模型檔案與本機 RVC 設定。",
    );
  }
});
elements["voice-profile-delete"].addEventListener("click", async () => {
  try {
    const status = await window.translive.voiceProfileDelete({
      confirmedDeleteProfile:
        elements["voice-profile-delete-confirm"].checked === true,
      id: elements["voice-profile-select"].value,
    });
    elements["voice-profile-delete-confirm"].checked = false;
    renderVoiceConversion(status);
  } catch {
    showAssertiveError("無法刪除本人音色。請確認刪除確認並稍後再試。");
  }
});
elements["voice-training-microphone"].addEventListener("change", (event) => {
  ui.voiceTraining.microphoneId = event.target.value;
  updateVoiceTrainingControls();
});
elements["voice-training-consent"].addEventListener(
  "change",
  updateVoiceTrainingControls,
);
elements["voice-training-final-consent"].addEventListener(
  "change",
  updateVoiceTrainingControls,
);
elements["voice-training-delete-confirm"].addEventListener(
  "change",
  updateVoiceTrainingControls,
);
elements["voice-profile-name"].addEventListener(
  "input",
  updateVoiceTrainingControls,
);
elements["voice-training-start"].addEventListener(
  "click",
  () => void startVoiceTrainingRecording(),
);
elements["voice-training-pause"].addEventListener(
  "click",
  () => void pauseVoiceTrainingRecording(),
);
elements["voice-training-resume"].addEventListener(
  "click",
  () => void resumeVoiceTrainingRecording(),
);
elements["voice-training-stop"].addEventListener(
  "click",
  () => void stopVoiceTrainingRecording(),
);
elements["voice-training-train"].addEventListener(
  "click",
  () => void startVoiceTraining(),
);
elements["voice-training-cancel"].addEventListener(
  "click",
  () => void cancelVoiceTraining(),
);
elements["voice-training-delete"].addEventListener(
  "click",
  () => void deleteVoiceTraining(),
);
elements["tray-close-behavior"].addEventListener("change", async (event) => {
  const result = await window.translive.traySetCloseBehavior(
    event.target.value,
  );
  event.target.value = result.closeBehavior;
});
elements["copy-diagnostics"].addEventListener("click", async () => {
  try {
    const result = await window.translive.diagnosticsExport();
    if (result.exported) {
      elements["copy-diagnostics"].textContent = "已匯出遮罩診斷包";
    }
  } catch {
    showAssertiveError("無法匯出遮罩診斷包，請確認儲存位置後再試。");
  }
});

document.addEventListener("keydown", (event) => {
  const openModal = [
    elements["quick-setup-modal"],
    elements["summary-confirm-modal"],
    elements["consent-modal"],
    elements["delete-confirm-modal"],
  ].find((modal) => modal.classList.contains("is-open"));
  if (event.key === "Tab" && openModal) {
    const focusable = [
      ...openModal.querySelectorAll("button, input, select"),
    ].filter((element) => !element.disabled);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
    return;
  }
  if (event.key !== "Escape") return;
  setDrawer(false);
  if (elements["quick-setup-modal"].classList.contains("is-open")) {
    setQuickSetup(false);
  }
  if (elements["summary-confirm-modal"].classList.contains("is-open")) {
    setSummaryConfirm(false);
  }
  if (elements["consent-modal"].classList.contains("is-open")) {
    ui.consent.skipForCurrentRun = true;
    setConsentModal(false);
  }
  if (elements["delete-confirm-modal"].classList.contains("is-open")) {
    setDeleteConfirm(false);
  }
});
window.addEventListener("pagehide", () => {
  const media = ui.voiceTraining.media;
  if (media?.recorder.state !== "inactive") media.recorder.stop();
  releaseVoiceTrainingMedia({ discard: true });
  void releaseRendererResources();
});

window.translive.onEvent(async (event) => {
  if (event.type === "renderer-control") {
    let acknowledgement;
    try {
      acknowledgement = await handleRendererControl(event);
      if (event.action === "mute") {
        ui.muted[event.direction] = Boolean(event.muted);
        setChannelState(event.direction, event.muted ? "muted" : "live");
      }
    } catch {
      acknowledgement = { controlId: event.controlId, state: "failed" };
    }
    window.translive.rendererControlAck(acknowledgement);
    return;
  }
  updateDiagnostics(event);
  if (event.type === "cleanup") {
    if (event.state === "warning") {
      const message = "已登出，但部分本機清理未完成。請開啟診斷確認。";
      elements["stopped-copy"].textContent = message;
      showAssertiveError(message);
    }
    return;
  }
  if (event.type === "summary") {
    handleSummaryEvent(event);
    return;
  }
  if (event.type === "record") {
    if (event.state === "saved") {
      ui.lastSavedRecord = event.record;
      ui.records.current = { id: event.record.id, kind: "session" };
    }
    applyTranscriptPersistence(event);
    if (event.state === "failed") {
      showAssertiveError("逐字稿保存失敗，請開啟診斷查看詳情。");
    }
    return;
  }
  if (event.type === "meeting-setup") {
    if (event.state === "restore-failed") {
      elements["quick-setup-note"].textContent =
        event.message || "Windows 通訊裝置尚未還原，請在設定中手動確認。";
      elements["stopped-copy"].textContent =
        "翻譯已停止，但 Windows 通訊裝置尚未還原。請在設定中手動確認。";
    }
    return;
  }
  if (event.type === "global-audio") {
    applyGlobalAudioStatus(event);
    return;
  }
  if (event.type === "voicemeeter-routing") {
    applyVoiceMeeterRoutingStatus(event);
    return;
  }
  if (event.type === "voice-conversion") {
    renderVoiceConversion(event.status);
    return;
  }
  if (event.type === "voice-training") {
    renderVoiceTraining(event.status);
    return;
  }
  if (event.type === "tray") {
    if (event.action === "diagnostics") setDrawer(true);
    if (event.action === "stopped") setAppState("stopped");
    return;
  }
  if (event.type === "account") {
    setAccountState(event.state);
    if (event.state === "connected") {
      setAppState("ready");
      await refreshDevices();
    } else if (event.state === "waiting") setAppState("auth-waiting");
    else if (["failed", "logged-out"].includes(event.state)) {
      setAppState("logged-out");
    }
    return;
  }
  if (event.type === "state") {
    setChannelState(event.direction, event.state);
    applyAggregate(event.aggregate);
    return;
  }
  if (event.type === "run") {
    applyAggregate(event.aggregate);
    return;
  }
  if (event.type === "sdp" && ui.active[event.direction]) {
    try {
      await ui.active[event.direction].applyAnswer(event.sdp);
      if (event.direction !== "qa") {
        const result = await window.translive.answerApplied(event.direction);
        applyAggregate(result.aggregate);
      }
    } catch {
      window.translive.rendererError(
        event.direction,
        "無法套用 GPT‑Live WebRTC 回應。",
      );
    }
    return;
  }
  if (event.type === "transcript") {
    appendTranscript(event);
    return;
  }
  if (event.type === "qa-pending") {
    showQaCard(event.answer);
    return;
  }
  if (event.type === "qa-sent" || event.type === "qa-rejected") {
    hideQaCard();
    setQaBusy(false);
    return;
  }
  if (event.type === "qa-error") {
    showQaNotice(event.message);
    setQaBusy(false);
    return;
  }
  if (event.type === "qa-pending") {
    setQaBusy(false);
  }
  if (event.type === "error") {
    if (event.direction) ui.active[event.direction]?.stop();
    if (event.aggregate) applyAggregate(event.aggregate);
    const presentation = runStatePresentation({
      appState: ui.app === "degraded" ? "degraded" : "blocked",
      mode: ui.mode,
      status: ui.channels,
    });
    elements["degraded-title"].textContent = presentation.title;
    elements["degraded-copy"].textContent = presentation.detail;
    return;
  }
  if (event.type === "blocked") {
    await releaseRendererResources();
    showBlocked("無法建立翻譯連線", event.message);
    return;
  }
  if (event.type === "stopped") {
    ui.active = {};
    setAppState("stopped");
  }
});

for (const group of document.querySelectorAll(".caption-group")) {
  group.addEventListener("scroll", () => {
    group.dataset.unpinned =
      group.scrollTop + group.clientHeight < group.scrollHeight - 24 ? "1" : "";
  });
}

let captionScale =
  Number(window.localStorage.getItem("translive-caption-scale")) || 1;
function applyCaptionScale() {
  captionScale =
    Math.round(Math.min(1.4, Math.max(0.8, captionScale)) * 10) / 10;
  document
    .querySelector(".live-screen")
    .style.setProperty("--caption-scale", String(captionScale));
  window.localStorage.setItem("translive-caption-scale", String(captionScale));
}
elements["caption-size-down"].addEventListener("click", () => {
  captionScale -= 0.1;
  applyCaptionScale();
});
elements["caption-size-up"].addEventListener("click", () => {
  captionScale += 0.1;
  applyCaptionScale();
});
applyCaptionScale();

setMode("meeting");
setView("translate");
initializeTray();
initializeConsent();
initializeRetention();
initializeAssistantPreferences();
initializeGlobalAudioDefaults();
initializeVoiceMeeterRouting();
initializeVoiceConversion();
initializeVoiceTraining();
initializeAccount();
