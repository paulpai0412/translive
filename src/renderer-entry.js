import { createStartupSession } from "./startup-session.js";
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
    "blocked-action",
    "blocked-copy",
    "blocked-detail",
    "blocked-title",
    "cancel-connect-button",
    "cable-a-sink",
    "connect-account-step",
    "connect-route-step",
    "connect-runtime-step",
    "connect-session-step",
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
    "drawer-scrim",
    "headphones",
    "headphones-confirmed",
    "health-account",
    "health-devices",
    "health-runtime",
    "live-mode-label",
    "live-route-summary",
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
    "route-profile",
    "settings-account-button",
    "settings-account-status",
    "settings-logout-button",
    "settings-runtime-button",
    "settings-runtime-status",
    "rx-source",
    "rx-source-caption",
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
    "theme-button",
    "theme-label",
    "tx-sink",
    "tx-source-caption",
    "tx-state",
    "tx-target-caption",
  ].map((id) => [id, document.querySelector(`#${id}`)]),
);

const ui = {
  account: "checking",
  active: {},
  app: "checking",
  channels: { tx: "disabled", rx: "disabled" },
  startup: undefined,
  captions: {
    tx: { source: "", target: "" },
    rx: { source: "", target: "" },
  },
  mode: "meeting",
  muted: { tx: false, rx: false },
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
  for (const button of document.querySelectorAll("[data-mode-button]")) {
    button.disabled = state !== "ready";
  }
  for (const field of document.querySelectorAll(".configuration select, .configuration input")) {
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
    elements["live-route-summary"].textContent = "麥克風 → VoiceMeeter B2 · Cove";
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
  const text = {
    checking: "檢查登入狀態…",
    connected: "ChatGPT 已連線",
    waiting: "等待瀏覽器確認",
    failed: "登入未完成",
    "logged-out": "尚未連線",
  }[state] ?? "尚未連線";
  elements["account-status"].textContent = text;
  elements["auth-status"].textContent = text;
  elements["diag-account"].textContent = text;
  elements["health-account"].className =
    state === "connected" ? "ok" : "warn";
  elements["settings-account-status"].textContent = text;
}

function setDrawer(open) {
  elements["diagnostics-drawer"].classList.toggle("is-open", open);
  elements["diagnostics-drawer"].setAttribute("aria-hidden", String(!open));
  elements["drawer-scrim"].classList.toggle("is-open", open);
}

function selectedDevice(select) {
  const option = select.selectedOptions[0];
  if (!option?.value) throw new Error(`請選擇「${select.labels[0].textContent}」`);
  return { id: option.value, kind: option.dataset.kind, name: option.textContent };
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
    populateSelect(elements["physical-mic"], inputs, elements["physical-mic"].value);
    populateSelect(elements["rx-source"], inputs, elements["rx-source"].value);
    populateSelect(elements["tx-sink"], outputs, elements["tx-sink"].value);
    populateSelect(elements["headphones"], outputs, elements["headphones"].value);
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
  const button = document.querySelector(`.mute-button[data-direction="${direction}"]`);
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
  elements["single-source-caption"].textContent = captions.source || "等待輸入音訊…";
  elements["single-target-caption"].textContent = captions.target || "—";
  const targetText = captions.target || captions.source || "等待翻譯字幕…";
  elements["mini-primary"].textContent = targetText;
  elements["mini-secondary"].textContent =
    ui.mode === "meeting"
      ? ui.captions.tx.target || ""
      : "";
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
  context.resume().then(sample).catch(() => {});
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
      if (Number.isFinite(report.jitter)) stats.jitterMs = report.jitter * 1_000;
      if (Number.isFinite(report.packetsLost)) stats.packetsLost = report.packetsLost;
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
        window.translive.rendererError(direction, `WebRTC connection ${peerConnection.connectionState}`);
      }
    });
    peerConnection.addEventListener("track", async (event) => {
      try {
        audio.srcObject = event.streams[0] || new MediaStream([event.track]);
        if (typeof audio.setSinkId !== "function") {
          throw new Error("此 Electron 版本不支援指定音訊輸出裝置");
        }
        await audio.setSinkId(sink.id);
        event.track.addEventListener("unmute", () => recordMetric(direction, "output-audio", {}), { once: true });
        audio.addEventListener("playing", () => recordMetric(direction, "output-audio", {}), { once: true });
        await audio.play();
      } catch (error) {
        window.translive.rendererError(direction, `無法播放翻譯音訊：${error.message}`);
      }
    });

    stopInputProbe = createInputProbe(stream, direction);
    statsTimer = setInterval(async () => {
      try {
        if (!cleaned) recordMetric(direction, "webrtc", await summarizeStats(peerConnection));
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
  if (ui.startup || Object.keys(ui.active).length > 0 || ui.app === "connecting") return;
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
    setAppState("connecting");
    resetLiveDisplay();
    setConnectionStep("connect-account-step", "done", "ChatGPT 已連線");
    setConnectionStep("connect-runtime-step", "active", "正在檢查 Codex runtime");
    setConnectionStep("connect-session-step", "pending", "等待路由預檢");
    setConnectionStep("connect-route-step", "pending", "等待路由預檢");

    const preflight = await window.translive.preflight(config);
    if (!preflight.ok) throw new Error(preflight.error);
    if (startup.isCanceled()) return;

    ui.runtime = preflight.codexVersion;
    setConnectionStep("connect-runtime-step", "done", "Codex runtime 已驗證");
    elements["diag-codex"].textContent = preflight.codexVersion;
    elements["settings-runtime-status"].textContent = preflight.codexVersion;
    elements["diag-route"].textContent = `${config.platform} · ${config.routeProfile} · ${ui.mode}`;
    setConnectionStep("connect-route-step", "done", "音訊路由已驗證");
    setConnectionStep("connect-session-step", "active", "正在建立 GPT‑Live session");

    const { result } = await startup.start(config);
    if (startup.isCanceled()) return;
    setConnectionStep("connect-session-step", "done", "GPT‑Live session 已建立");
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
    await window.translive.stop();
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
  elements["blocked-copy"].textContent = "請檢查登入、音訊裝置和路由設定。音訊尚未繼續傳送。";
  elements["blocked-detail"].textContent = detail || "NO_DETAILS";
  elements["blocked-action"].textContent =
    ui.account === "connected" ? "返回設定" : "重新連接 ChatGPT";
  setAppState("blocked");
}

function appendTranscript({ direction, role, text, final = false }) {
  const key = captionKey(role);
  ui.captions[direction][key] = mergeCaption(ui.captions[direction][key], text, final);
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

function setView(view) {
  document.body.dataset.view = view;
  for (const button of document.querySelectorAll("[data-view-button]")) {
    button.classList.toggle("is-active", button.dataset.viewButton === view);
  }
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
elements["blocked-action"].addEventListener("click", () => {
  if (ui.account === "connected") setAppState("ready");
  else void startAccountLogin();
});
elements["start-button"].addEventListener("click", startTranslation);
elements["cancel-connect-button"].addEventListener("click", () =>
  void cancelTranslationStartup(),
);
elements["stop-button"].addEventListener("click", stopTranslation);
elements["restart-button"].addEventListener("click", () => setAppState("ready"));
for (const button of document.querySelectorAll(".mute-button")) {
  button.addEventListener("click", () =>
    toggleMute(button.dataset.direction || activeSingleDirection()),
  );
}
elements["diagnostics-button"].addEventListener("click", () => setDrawer(true));
elements["diagnostics-button-live"].addEventListener("click", () => setDrawer(true));
elements["close-diagnostics"].addEventListener("click", () => setDrawer(false));
elements["drawer-scrim"].addEventListener("click", () => setDrawer(false));
elements["mini-overlay-button"].addEventListener("click", () => {
  elements["mini-overlay"].classList.add("is-open");
  elements["mini-overlay"].setAttribute("aria-hidden", "false");
});
elements["close-mini"].addEventListener("click", () => {
  elements["mini-overlay"].classList.remove("is-open");
  elements["mini-overlay"].setAttribute("aria-hidden", "true");
});
elements["account-button"].addEventListener("click", () => setView("settings"));
elements["settings-account-button"].addEventListener("click", startAccountLogin);
elements["settings-logout-button"].addEventListener("click", async () => {
  await window.translive.accountLogout();
  setAccountState("logged-out");
  setView("translate");
  setAppState("logged-out");
});
elements["theme-button"].addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  elements["theme-label"].textContent = next === "dark" ? "深色" : "淺色";
});
elements["settings-runtime-button"].addEventListener("click", () => setDrawer(true));
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
  if (event.key === "Escape") setDrawer(false);
});
window.addEventListener("pagehide", () => {
  void cancelTranslationStartup();
  for (const peer of Object.values(ui.active)) peer.stop();
});

window.translive.onEvent(async (event) => {
  updateDiagnostics(event);
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
      window.translive.rendererError(event.direction, "無法套用 GPT‑Live WebRTC 回應。");
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
initializeAccount();
