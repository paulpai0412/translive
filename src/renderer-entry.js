import { createStartupSession } from "./startup-session.js";
import {
  latestTranscriptPersistenceEvent,
  transcriptPersistencePresentation,
} from "./renderer-state.js";
import {
  channelStateLabel,
  diagnosticEventLabel,
  modeLabel,
  runStatePresentation,
} from "./view-state.js";

const DIRECTIONS_BY_MODE = Object.freeze({
  meeting: ["tx", "rx"],
  media: ["rx"],
  microphone: ["tx"],
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
    "close-mini",
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
    "health-account",
    "health-devices",
    "health-runtime",
    "live-mode-label",
    "live-route-summary",
    "live-save-status",
    "live-status",
    "mini-overlay",
    "mini-primary",
    "mini-secondary",
    "mini-status",
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
  runtime: "尚未檢查",
};

function directionsForMode(mode = ui.mode) {
  return DIRECTIONS_BY_MODE[mode];
}

function setAppState(state) {
  ui.app = state;
  document.body.dataset.appState = state;
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
    button.setAttribute("aria-selected", String(selected));
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
  } else {
    elements["live-route-summary"].textContent = "VoiceMeeter · Cove";
  }
  elements["single-mute-button"].dataset.direction = singleDirection;
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

function focusModal(modal, selector) {
  window.requestAnimationFrame(() => {
    modal.querySelector(selector)?.focus();
  });
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
  elements["diagnostics-drawer"].classList.toggle("is-open", open);
  elements["diagnostics-drawer"].setAttribute("aria-hidden", String(!open));
  setScrim();
}

function setQuickSetup(open) {
  elements["quick-setup-modal"].classList.toggle("is-open", open);
  elements["quick-setup-modal"].setAttribute("aria-hidden", String(!open));
  setScrim();
}

function setSummaryConfirm(open) {
  elements["summary-confirm-modal"].classList.toggle("is-open", open);
  elements["summary-confirm-modal"].setAttribute("aria-hidden", String(!open));
  setScrim();
  if (open)
    focusModal(elements["summary-confirm-modal"], "#summary-confirm-action");
}

function setConsentModal(open) {
  elements["consent-modal"].classList.toggle("is-open", open);
  elements["consent-modal"].setAttribute("aria-hidden", String(!open));
  setScrim();
  if (open) focusModal(elements["consent-modal"], "#consent-checkbox");
}

function setDeleteConfirm(open) {
  elements["delete-confirm-modal"].classList.toggle("is-open", open);
  elements["delete-confirm-modal"].setAttribute("aria-hidden", String(!open));
  if (!open) elements["delete-confirm-input"].value = "";
  elements["delete-confirm-action"].disabled = true;
  setScrim();
  if (open)
    focusModal(elements["delete-confirm-modal"], "#delete-confirm-input");
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
  } catch (error) {
    elements["quick-setup-note"].textContent =
      `快速設定無法完成：${error.message}`;
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
    elements["health-devices"].className = "ok";
    updateReadyMessage();
  } catch (error) {
    elements["health-devices"].className = "warn";
    elements["ready-message"].textContent = `無法列出裝置：${error.message}`;
  }
}

function updateReadyMessage() {
  const description = {
    meeting: "會同時建立 TX 與 RX 翻譯連線。",
    media: "只建立 RX 翻譯連線，不使用麥克風。",
    microphone: "只建立 TX 翻譯連線，不使用耳機或 RX 來源。",
  }[ui.mode];
  elements["ready-message"].textContent = description;
}

function setChannelState(direction, state) {
  ui.channels[direction] = state;
  const element = elements[`${direction}-state`];
  if (element) element.textContent = channelStateLabel(state);
  const singleDirection = activeSingleDirection();
  if (direction === singleDirection) {
    elements["single-channel-state"].textContent = channelStateLabel(state);
  }
  const button = document.querySelector(
    `.mute-button[data-direction="${direction}"]`,
  );
  if (button) {
    button.disabled = !["live", "muted"].includes(state);
    button.textContent = ui.muted[direction] ? "取消靜音" : "靜音";
  }
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
  const targetText = captions.target || captions.source || "等待翻譯字幕…";
  elements["mini-primary"].textContent = targetText;
  elements["mini-secondary"].textContent =
    ui.mode === "meeting" ? ui.captions.tx.target || "" : "";
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

async function createRealtimePeer({ direction, source, sink }) {
  let stream;
  let peerConnection;
  let eventChannel;
  let audio;
  let stopInputProbe = () => {};
  let statsTimer;
  let cleaned = false;

  const cleanup = () => {
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
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      audio.remove();
    }
  };

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: source.id },
        autoGainControl: false,
        echoCancellation: false,
        noiseSuppression: false,
      },
      video: false,
    });
    peerConnection = new RTCPeerConnection();
    for (const track of stream.getAudioTracks()) {
      peerConnection.addTrack(track, stream);
    }
    eventChannel = peerConnection.createDataChannel("oai-events");
    audio = document.createElement("audio");
    audio.autoplay = true;
    audio.playsInline = true;
    audio.hidden = true;
    document.body.append(audio);

    peerConnection.addEventListener("connectionstatechange", () => {
      if (["failed", "disconnected"].includes(peerConnection.connectionState)) {
        window.translive.rendererError(
          direction,
          `WebRTC connection ${peerConnection.connectionState}`,
        );
      }
    });
    peerConnection.addEventListener("track", async (event) => {
      try {
        audio.srcObject = event.streams[0] || new MediaStream([event.track]);
        if (typeof audio.setSinkId !== "function") {
          throw new Error("此 Electron 版本不支援指定音訊輸出裝置");
        }
        await audio.setSinkId(sink.id);
        event.track.addEventListener(
          "unmute",
          () => recordMetric(direction, "output-audio", {}),
          { once: true },
        );
        audio.addEventListener(
          "playing",
          () => recordMetric(direction, "output-audio", {}),
          { once: true },
        );
        await audio.play();
      } catch (error) {
        window.translive.rendererError(
          direction,
          `無法播放翻譯音訊：${error.message}`,
        );
      }
    });

    stopInputProbe = createInputProbe(stream, direction);
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
      setMuted(muted) {
        if (direction === "tx") {
          for (const track of stream.getAudioTracks()) {
            track.enabled = !muted;
          }
        } else {
          audio.muted = muted;
        }
      },
      async applyAnswer(sdp) {
        await peerConnection.setRemoteDescription({ type: "answer", sdp });
      },
      stop: cleanup,
    };
  } catch (error) {
    cleanup();
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
    directions: directionsForMode(),
    createPeer: async ({ direction, channel }) =>
      createRealtimePeer({
        direction,
        source: { id: channel.sourceEndpointId },
        sink: { id: channel.sinkEndpointId },
      }),
    onPeerCreated: (direction, peer) => {
      ui.active[direction] = peer;
    },
    startRuntime: (runtimeConfig) => window.translive.start(runtimeConfig),
    cancelRuntime: () => window.translive.cancelStart(),
  });
  ui.startup = startup;
  try {
    config = routeConfig();
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
    if (canceled) {
      setAppState("ready");
      updateReadyMessage();
      return;
    }
    for (const peer of Object.values(ui.active)) peer.stop();
    ui.active = {};
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
  ui.active = {};
  setAppState("ready");
  updateReadyMessage();
}

async function stopTranslation() {
  await cancelTranslationStartup();
  const peers = ui.active;
  ui.active = {};
  for (const peer of Object.values(peers)) peer.stop();
  try {
    const result = await window.translive.stop();
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
  await window.translive.setMuted(direction, muted);
  setChannelState(direction, muted ? "muted" : "live");
}

function showBlocked(title, detail) {
  elements["blocked-title"].textContent = title;
  elements["blocked-copy"].textContent =
    "請檢查登入、音訊裝置和路由設定。音訊尚未繼續傳送。";
  elements["blocked-detail"].textContent = detail || "NO_DETAILS";
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

function updateDiagnostics(event) {
  elements["diag-last-event"].textContent = diagnosticEventLabel(event.type);
  elements["diag-event-detail"].textContent = event.direction
    ? `${event.type} · ${event.direction.toUpperCase()}`
    : event.type;
  if (event.type === "state") {
    elements[`diag-${event.direction}`].textContent = event.state;
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

async function initializeAccount() {
  setAccountState("checking");
  try {
    const result = await window.translive.accountStatus();
    setAccountState(result.state);
    setAppState(result.state === "connected" ? "ready" : "logged-out");
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
  await window.translive.recordsDelete(id);
  ui.records.selected.delete(id);
  ui.records.current = undefined;
  await loadRecords();
}

async function deleteAggregate(id) {
  if (!window.confirm("刪除這份跨場摘要？此操作無法復原。")) return;
  await window.translive.aggregatesDelete(id);
  ui.records.current = undefined;
  await loadRecords();
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
    elements["records-status"].textContent = "無法產生摘要，請稍後再試。";
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
for (const button of document.querySelectorAll("[data-view-button]")) {
  button.addEventListener("click", () => setView(button.dataset.viewButton));
}
elements["refresh-devices"].addEventListener("click", refreshDevices);
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
elements["cancel-connect-button"].addEventListener(
  "click",
  () => void cancelTranslationStartup(),
);
elements["stop-button"].addEventListener("click", stopTranslation);
elements["restart-button"].addEventListener("click", () =>
  setAppState("ready"),
);
for (const button of document.querySelectorAll(".mute-button")) {
  button.addEventListener("click", () =>
    toggleMute(button.dataset.direction || activeSingleDirection()),
  );
}
elements["diagnostics-button"].addEventListener("click", () => setDrawer(true));
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
  if (ui.mode !== "meeting") return;
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
elements["mini-overlay-button"].addEventListener("click", () => {
  elements["mini-overlay"].classList.add("is-open");
  elements["mini-overlay"].setAttribute("aria-hidden", "false");
});
elements["close-mini"].addEventListener("click", () => {
  elements["mini-overlay"].classList.remove("is-open");
  elements["mini-overlay"].setAttribute("aria-hidden", "true");
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
elements["tray-close-behavior"].addEventListener("change", async (event) => {
  const result = await window.translive.traySetCloseBehavior(
    event.target.value,
  );
  event.target.value = result.closeBehavior;
});
elements["copy-diagnostics"].addEventListener("click", async () => {
  const detail = `mode=${ui.mode}\naccount=${ui.account}\nruntime=${ui.runtime}`;
  try {
    await navigator.clipboard.writeText(detail);
    elements["copy-diagnostics"].textContent = "已複製";
  } catch {
    elements["copy-diagnostics"].textContent = "請手動複製";
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
  void cancelTranslationStartup();
  for (const peer of Object.values(ui.active)) peer.stop();
});

window.translive.onEvent(async (event) => {
  updateDiagnostics(event);
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
  if (event.type === "tray") {
    if (event.action === "diagnostics") setDrawer(true);
    if (event.action === "stopped") setAppState("stopped");
    return;
  }
  if (event.type === "account") {
    setAccountState(event.state);
    if (event.state === "connected") setAppState("ready");
    else if (event.state === "waiting") setAppState("auth-waiting");
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
      const result = await window.translive.answerApplied(event.direction);
      applyAggregate(result.aggregate);
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
    for (const peer of Object.values(ui.active)) peer.stop();
    ui.active = {};
    showBlocked("無法建立翻譯連線", event.message);
    return;
  }
  if (event.type === "stopped") {
    ui.active = {};
    setAppState("stopped");
  }
});

setMode("meeting");
setView("translate");
initializeTray();
initializeConsent();
initializeAccount();
