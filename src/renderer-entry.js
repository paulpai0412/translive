const elements = Object.fromEntries(
  [
    "meeting-platform",
    "physical-mic",
    "cable-a-sink",
    "cable-b-source",
    "headphones",
    "headphones-confirmed",
    "refresh-devices",
    "preflight",
    "test-headphones",
    "start",
    "stop",
    "tx-mute",
    "rx-mute",
    "tx-level",
    "tx-state",
    "rx-state",
    "tx-ttfa",
    "rx-ttfa",
    "tx-rtt",
    "rx-rtt",
    "tx-timing",
    "rx-timing",
    "webrtc-summary",
    "last-event",
    "run-status",
    "route-result",
    "meeting-instructions",
    "transcripts",
    "clear-transcript",
  ].map((id) => [id, document.querySelector(`#${id}`)]),
);

let active;
let starting = false;
let controlsRunning = false;
const timings = { tx: {}, rx: {} };
const transcriptLines = [];

function formatMilliseconds(value) {
  return Number.isFinite(value) ? `${Math.round(value)} ms` : "—";
}

function setRunStatus(text, state = "ready") {
  elements["run-status"].textContent = text;
  elements["run-status"].className = `status ${state}`;
}

function setChannelState(direction, state) {
  const element = elements[`${direction}-state`];
  element.textContent = state;
  element.className = `status ${state}`;
  elements[`${direction}-mute`].disabled =
    !controlsRunning || !["live", "muted"].includes(state);
}

function setControls(isRunning) {
  controlsRunning = isRunning;
  const locked = isRunning || starting;
  elements.start.disabled = locked;
  elements.stop.disabled = !isRunning;
  for (const direction of ["tx", "rx"]) {
    const state = elements[`${direction}-state`].textContent.toLowerCase();
    elements[`${direction}-mute`].disabled =
      !isRunning || !["live", "muted"].includes(state);
  }
  elements["test-headphones"].disabled = locked;
  for (const id of ["meeting-platform", "physical-mic", "cable-a-sink", "cable-b-source", "headphones"]) {
    elements[id].disabled = locked;
  }
}

function selectDevice(select) {
  const option = select.selectedOptions[0];
  if (!option?.value) throw new Error(`Select ${select.labels[0].textContent}`);
  return { id: option.value, name: option.textContent, kind: option.dataset.kind };
}

function routeConfig() {
  const physicalMic = selectDevice(elements["physical-mic"]);
  const cableASink = selectDevice(elements["cable-a-sink"]);
  const cableBSource = selectDevice(elements["cable-b-source"]);
  const headphones = selectDevice(elements.headphones);
  return {
    platform: elements["meeting-platform"].value,
    headphonesConfirmed: elements["headphones-confirmed"].checked,
    tx: {
      sourceEndpointId: physicalMic.id,
      sourceEndpointName: physicalMic.name,
      sourceEndpointKind: physicalMic.kind,
      sinkEndpointId: cableASink.id,
      sinkEndpointName: cableASink.name,
      sinkEndpointKind: cableASink.kind,
    },
    rx: {
      sourceEndpointId: cableBSource.id,
      sourceEndpointName: cableBSource.name,
      sourceEndpointKind: cableBSource.kind,
      sinkEndpointId: headphones.id,
      sinkEndpointName: headphones.name,
      sinkEndpointKind: headphones.kind,
    },
  };
}

function populateSelect(select, devices, previousValue) {
  select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select a device";
  select.append(placeholder);
  devices.forEach((device, index) => {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.dataset.kind = device.kind;
    option.textContent = device.label || `Audio device ${index + 1}`;
    if (device.deviceId === previousValue) option.selected = true;
    select.append(option);
  });
}

async function refreshDevices() {
  elements["route-result"].textContent = "Requesting microphone permission to list device labels…";
  try {
    const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    permissionStream.getTracks().forEach((track) => track.stop());
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((device) => device.kind === "audioinput");
    const outputs = devices.filter((device) => device.kind === "audiooutput");
    populateSelect(elements["physical-mic"], inputs, elements["physical-mic"].value);
    populateSelect(elements["cable-b-source"], inputs, elements["cable-b-source"].value);
    populateSelect(elements["cable-a-sink"], outputs, elements["cable-a-sink"].value);
    populateSelect(elements.headphones, outputs, elements.headphones.value);
    elements["route-result"].textContent = `Found ${inputs.length} inputs and ${outputs.length} outputs. Select four distinct endpoints.`;
  } catch (error) {
    elements["route-result"].textContent = `Cannot enumerate audio devices: ${error.message}`;
  }
}

function updateMeetingInstructions() {
  const app = elements["meeting-platform"].value === "zoom" ? "Zoom" : "Microsoft Teams";
  elements["meeting-instructions"].textContent = `${app}: select the paired Cable-A Output as microphone and Cable-B Input as speaker. TransLive never changes these settings automatically.`;
}

function appendTranscript({ direction, role, text }) {
  if (!text) return;
  transcriptLines.push({ direction, role, text });
  if (transcriptLines.length > 100) transcriptLines.shift();
  elements.transcripts.replaceChildren(
    ...transcriptLines.map((line) => {
      const item = document.createElement("div");
      item.className = `transcript ${line.direction}`;
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `${line.direction.toUpperCase()} · ${line.role || "unknown"}`;
      const content = document.createElement("div");
      content.className = "text";
      content.textContent = line.text;
      item.append(meta, content);
      return item;
    }),
  );
  elements.transcripts.scrollTop = elements.transcripts.scrollHeight;
}

function updateTimings(direction) {
  const timing = timings[direction];
  elements[`${direction}-ttfa`].textContent = formatMilliseconds(timing.ttfa);
  elements[`${direction}-rtt`].textContent = formatMilliseconds(timing.rtt);
  elements[`${direction}-timing`].textContent = `input ${timing.inputAt ? new Date(timing.inputAt).toLocaleTimeString() : "—"} · output ${timing.outputAt ? new Date(timing.outputAt).toLocaleTimeString() : "—"}`;
  elements["webrtc-summary"].textContent = `TX ${formatMilliseconds(timings.tx.rtt)} · RX ${formatMilliseconds(timings.rx.rtt)}`;
}

function recordMetric(direction, type, stats) {
  const atMs = Date.now();
  const timing = timings[direction];
  if (type === "input-audio") timing.inputAt ??= atMs;
  if (type === "output-audio") {
    timing.outputAt ??= atMs;
    if (timing.inputAt && timing.ttfa === undefined) timing.ttfa = atMs - timing.inputAt;
  }
  if (type === "webrtc" && Number.isFinite(stats?.rttMs)) timing.rtt = stats.rttMs;
  updateTimings(direction);
  window.translive.recordMetric({ direction, type, atMs, stats });
}

function createActivityProbe(stream, direction, type, onLevel = () => {}) {
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  const source = context.createMediaStreamSource(stream);
  source.connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);
  let animationFrame;
  let closed = false;
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
    onLevel(rms);
    if (rms > 0.015 && Date.now() - lastSignalAt >= 250) {
      lastSignalAt = Date.now();
      recordMetric(direction, type, { rms });
    }
    animationFrame = requestAnimationFrame(sample);
  };
  context.resume().then(sample).catch(() => {});
  return () => {
    if (closed) return;
    closed = true;
    cancelAnimationFrame(animationFrame);
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
  const reports = await peerConnection.getStats();
  const stats = {};
  for (const report of reports.values()) {
    if (report.type === "candidate-pair" && report.state === "succeeded" && (report.nominated || report.selected)) {
      if (Number.isFinite(report.currentRoundTripTime)) stats.rttMs = report.currentRoundTripTime * 1_000;
    }
    if (report.type === "inbound-rtp" && (report.kind === "audio" || report.mediaType === "audio")) {
      if (Number.isFinite(report.jitter)) stats.jitterMs = report.jitter * 1_000;
      if (Number.isFinite(report.packetsLost)) stats.packetsLost = report.packetsLost;
    }
    if (report.type === "outbound-rtp" && (report.kind === "audio" || report.mediaType === "audio")) {
      if (Number.isFinite(report.packetsSent)) stats.packetsSent = report.packetsSent;
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
  let stopOutputProbe = () => {};
  let statsTimer;
  let cleaned = false;
  let failureReason;
  let failureReported = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(statsTimer);
    stopInputProbe();
    stopOutputProbe();
    try { eventChannel?.close(); } catch {}
    stream?.getTracks().forEach((track) => track.stop());
    try { peerConnection?.close(); } catch {}
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      audio.remove();
    }
  };
  const fail = (reason) => {
    if (cleaned || failureReported) return;
    failureReported = true;
    failureReason = reason;
    cleanup();
    window.translive.rendererError(direction, reason);
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
    stream.getAudioTracks().forEach((track) => peerConnection.addTrack(track, stream));
    // The source audio track and oai-events data channel are created before the SDP offer.
    eventChannel = peerConnection.createDataChannel("oai-events");
    audio = document.createElement("audio");
    audio.autoplay = true;
    audio.playsInline = true;
    audio.hidden = true;
    document.body.append(audio);

    peerConnection.addEventListener("connectionstatechange", () => {
      if (["failed", "disconnected", "closed"].includes(peerConnection.connectionState)) {
        fail(`WebRTC connection ${peerConnection.connectionState}`);
      }
    });
    peerConnection.addEventListener("track", async (event) => {
      try {
        if (cleaned) return;
        const remoteStream = event.streams[0] || new MediaStream([event.track]);
        audio.srcObject = remoteStream;
        if (typeof audio.setSinkId !== "function") throw new Error("This Electron build does not support output device routing");
        await audio.setSinkId(sink.id);
        if (cleaned) return;
        event.track.addEventListener("ended", () => fail("Remote translated audio track ended"), { once: true });
        event.track.addEventListener("unmute", () => recordMetric(direction, "output-audio"), { once: true });
        audio.addEventListener("playing", () => recordMetric(direction, "output-audio"), { once: true });
        stopOutputProbe();
        try {
          stopOutputProbe = createActivityProbe(remoteStream, direction, "output-audio");
        } catch {
          // Output activity sampling is best-effort; do not drop working translated audio.
        }
        await audio.play();
      } catch (error) {
        fail(`Could not route translated audio: ${error.message}`);
      }
    });

    try {
      stopInputProbe = createActivityProbe(stream, direction, "input-audio", (rms) => {
        if (direction === "tx") elements["tx-level"].value = rms;
      });
    } catch {
      elements["route-result"].textContent = "Audio level sampling is unavailable; translation can still be tested.";
    }
    statsTimer = setInterval(async () => {
      try {
        if (!cleaned) recordMetric(direction, "webrtc", await summarizeStats(peerConnection));
      } catch {
        // Statistics are diagnostic only.
      }
    }, 1_000);
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    await waitForIceGatheringComplete(peerConnection);
    if (failureReason) throw new Error(failureReason);

    return {
      sdp: peerConnection.localDescription.sdp,
      setMuted(muted) {
        if (direction === "tx") stream.getAudioTracks().forEach((track) => { track.enabled = !muted; });
        else audio.muted = muted;
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

async function runPreflight() {
  try {
    const result = await window.translive.preflight(routeConfig());
    elements["route-result"].textContent = result.ok ? `Route preflight passed: ${result.codexVersion}` : result.error;
    if (result.ok) {
      elements["meeting-instructions"].textContent = `${result.instructions.app}: ${result.instructions.microphone} ${result.instructions.speaker} ${result.instructions.note}`;
    }
    return result.ok;
  } catch (error) {
    elements["route-result"].textContent = error.message;
    window.translive.rendererBlocked({}, error.message);
    return false;
  }
}

async function playHeadphoneTestTone() {
  let audio;
  let context;
  try {
    const sink = selectDevice(elements.headphones);
    if (sink.kind !== "audiooutput") throw new Error("Select an audio output for headphones");
    context = new AudioContext();
    await context.resume();
    const destination = context.createMediaStreamDestination();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    gain.gain.value = 0.06;
    oscillator.frequency.value = 660;
    oscillator.connect(gain).connect(destination);
    audio = document.createElement("audio");
    audio.autoplay = true;
    audio.srcObject = destination.stream;
    if (typeof audio.setSinkId !== "function") throw new Error("This Electron build does not support output device routing");
    await audio.setSinkId(sink.id);
    await audio.play();
    oscillator.start();
    setTimeout(() => {
      oscillator.stop();
      audio.pause();
      audio.remove();
      void context.close();
    }, 350);
    elements["route-result"].textContent = "Headphone test tone played on the selected output.";
  } catch (error) {
    audio?.remove();
    void context?.close();
    elements["route-result"].textContent = `Headphone test failed: ${error.message}`;
  }
}

async function start() {
  if (active || starting) return;
  starting = true;
  setControls(false);
  let config;
  let tx;
  let rx;
  try {
    if (!(await runPreflight())) return;
    config = routeConfig();
    setRunStatus("Preparing WebRTC", "connecting");
    tx = await createRealtimePeer({
      direction: "tx",
      source: { id: config.tx.sourceEndpointId, name: config.tx.sourceEndpointName },
      sink: { id: config.tx.sinkEndpointId, name: config.tx.sinkEndpointName },
    });
    rx = await createRealtimePeer({
      direction: "rx",
      source: { id: config.rx.sourceEndpointId, name: config.rx.sourceEndpointName },
      sink: { id: config.rx.sinkEndpointId, name: config.rx.sinkEndpointName },
    });
    config.tx.sdp = tx.sdp;
    config.rx.sdp = rx.sdp;
    // SDP notifications can arrive before the start RPC resolves.
    active = { tx, rx };
    const result = await window.translive.start(config);
    Object.entries(result.status).forEach(([direction, state]) => setChannelState(direction, state));
    setControls(true);
    setRunStatus(result.aggregate === "degraded" ? "Degraded" : "Connecting", result.aggregate === "degraded" ? "failed" : "connecting");
    elements["route-result"].textContent = `Codex ${result.codexVersion}; awaiting each WebRTC answer.`;
  } catch (error) {
    tx?.stop();
    rx?.stop();
    active = undefined;
    if (config) window.translive.rendererBlocked(config, error.message);
    setRunStatus("Blocked", "failed");
    elements["route-result"].textContent = error.message;
  } finally {
    starting = false;
    if (!active) setControls(false);
  }
}

async function stop() {
  const peers = active;
  active = undefined;
  // Local capture/render is released before waiting for app-server shutdown.
  peers?.tx.stop();
  peers?.rx.stop();
  try {
    await window.translive.stop();
  } finally {
    setControls(false);
    setRunStatus("Stopped", "stopped");
  }
}

async function toggleMute(direction) {
  if (!active) return;
  const button = elements[`${direction}-mute`];
  const muted = !button.dataset.muted;
  active[direction].setMuted(muted);
  button.dataset.muted = muted ? "true" : "";
  button.textContent = muted ? `Unmute ${direction.toUpperCase()}` : `Mute ${direction.toUpperCase()}`;
  await window.translive.setMuted(direction, muted);
}

function applyAggregate(aggregate) {
  if (aggregate === "blocked") setRunStatus("Blocked", "failed");
  else if (aggregate === "degraded") setRunStatus("Degraded", "failed");
  else if (aggregate === "live") setRunStatus("Live", "live");
  else if (aggregate === "connecting") setRunStatus("Connecting", "connecting");
}

window.translive.onEvent(async (event) => {
  elements["last-event"].textContent = `${event.type}${event.direction ? ` · ${event.direction.toUpperCase()}` : ""}`;
  if (event.type === "state") {
    setChannelState(event.direction, event.state);
    applyAggregate(event.aggregate);
  }
  if (event.type === "run") applyAggregate(event.aggregate);
  if (event.type === "sdp" && active?.[event.direction]) {
    try {
      await active[event.direction].applyAnswer(event.sdp);
      const result = await window.translive.answerApplied(event.direction);
      applyAggregate(result.aggregate);
    } catch {
      window.translive.rendererError(event.direction, "Could not apply the GPT-Live WebRTC answer.");
    }
  }
  if (event.type === "transcript") appendTranscript(event);
  if (event.type === "error") {
    if (event.direction) active?.[event.direction]?.stop();
    applyAggregate(event.aggregate);
    elements["route-result"].textContent = event.message;
  }
  if (event.type === "blocked") {
    active?.tx.stop();
    active?.rx.stop();
    active = undefined;
    setControls(false);
    setRunStatus("Blocked", "failed");
    elements["route-result"].textContent = event.message;
  }
  if (event.type === "stopped") elements["route-result"].textContent = "Stopped. Redacted evidence was written locally.";
});

elements["refresh-devices"].addEventListener("click", refreshDevices);
elements.preflight.addEventListener("click", runPreflight);
elements["test-headphones"].addEventListener("click", playHeadphoneTestTone);
elements.start.addEventListener("click", start);
elements.stop.addEventListener("click", stop);
elements["tx-mute"].addEventListener("click", () => toggleMute("tx"));
elements["rx-mute"].addEventListener("click", () => toggleMute("rx"));
elements["clear-transcript"].addEventListener("click", () => {
  transcriptLines.length = 0;
  elements.transcripts.replaceChildren();
});
elements["meeting-platform"].addEventListener("change", updateMeetingInstructions);
window.addEventListener("pagehide", () => {
  active?.tx.stop();
  active?.rx.stop();
});

updateMeetingInstructions();
setControls(false);
