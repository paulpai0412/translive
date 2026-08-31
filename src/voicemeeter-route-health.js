import { attachAudioToSink } from "./audio-output.js";

const MIN_EXPECTED_DB = -58;
const MIN_ISOLATION_DB = 12;
const ROUTES_BY_MODE = Object.freeze({
  meeting: ["tx", "rx"],
  media: ["rx"],
  microphone: ["tx"],
});

export function assessToneRoute({ expectedDb, leakageDb }) {
  if (!Number.isFinite(expectedDb) || expectedDb < MIN_EXPECTED_DB) {
    return { ok: false, reason: "expected-bus-silent" };
  }
  if (
    Number.isFinite(leakageDb) &&
    leakageDb > expectedDb - MIN_ISOLATION_DB
  ) {
    return { ok: false, reason: "reverse-bus-leakage" };
  }
  return { ok: true };
}

function findDevice(devices, kind, pattern) {
  return devices[kind].find((device) => pattern.test(device.label ?? ""));
}

function routeDevices(devices) {
  return {
    aux: findDevice(devices, "outputs", /^Voicemeeter AUX Input\b/i),
    b1: findDevice(devices, "inputs", /^Voicemeeter Out B1\b/i),
    b2: findDevice(devices, "inputs", /^Voicemeeter Out B2\b/i),
    vaio: findDevice(
      devices,
      "outputs",
      /^Voicemeeter Input\s*\(VB-Audio Voicemeeter VAIO\)/i,
    ),
  };
}

export async function probeToneRoute({
  expectedInputId,
  leakageInputId,
  sinkId,
  audioContext = new AudioContext(),
  createAudio = () => document.createElement("audio"),
  mediaDevices = navigator.mediaDevices,
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  const constraints = (deviceId) => ({
    audio: {
      autoGainControl: false,
      channelCount: 1,
      deviceId: { exact: deviceId },
      echoCancellation: false,
      noiseSuppression: false,
    },
    video: false,
  });
  const streams = [];
  const audio = createAudio();
  const frequency = 997;
  let oscillator;
  try {
    await audioContext.resume();
    streams.push(await mediaDevices.getUserMedia(constraints(expectedInputId)));
    streams.push(await mediaDevices.getUserMedia(constraints(leakageInputId)));
    const analysers = streams.map((stream) => {
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 4096;
      analyser.smoothingTimeConstant = 0;
      audioContext.createMediaStreamSource(stream).connect(analyser);
      return analyser;
    });
    const destination = audioContext.createMediaStreamDestination();
    const gain = audioContext.createGain();
    gain.gain.value = 0.04;
    oscillator = audioContext.createOscillator();
    oscillator.frequency.value = frequency;
    oscillator.connect(gain).connect(destination);
    audio.hidden = true;
    audio.playsInline = true;
    await attachAudioToSink({ audio, sinkId, stream: destination.stream });
    oscillator.start();
    await sleep(120);

    const peaks = [-Infinity, -Infinity];
    for (let sample = 0; sample < 20; sample += 1) {
      for (let index = 0; index < analysers.length; index += 1) {
        const analyser = analysers[index];
        const values = new Float32Array(analyser.frequencyBinCount);
        analyser.getFloatFrequencyData(values);
        const bin = Math.round(
          (frequency * analyser.fftSize) / audioContext.sampleRate,
        );
        peaks[index] = Math.max(peaks[index], values[bin] ?? -Infinity);
      }
      await sleep(20);
    }
    return { expectedDb: peaks[0], leakageDb: peaks[1] };
  } finally {
    try { oscillator?.stop(); } catch {}
    audio.pause?.();
    audio.srcObject = null;
    audio.remove?.();
    for (const stream of streams) {
      for (const track of stream.getTracks()) track.stop();
    }
    await audioContext.close();
  }
}

export async function verifyVoiceMeeterRoute({
  devices,
  mode,
  probe = probeToneRoute,
}) {
  const selected = routeDevices(devices);
  if (!selected.aux || !selected.b1 || !selected.b2 || !selected.vaio) {
    throw new Error("VOICEMEETER_ROUTE_HEALTH_DEVICES_MISSING");
  }
  const routes = {
    tx: {
      expectedInputId: selected.b2.deviceId,
      leakageInputId: selected.b1.deviceId,
      sinkId: selected.aux.deviceId,
    },
    rx: {
      expectedInputId: selected.b1.deviceId,
      leakageInputId: selected.b2.deviceId,
      sinkId: selected.vaio.deviceId,
    },
  };
  const required = ROUTES_BY_MODE[mode];
  if (!required) throw new Error("VOICEMEETER_ROUTE_HEALTH_MODE_UNSUPPORTED");

  for (const direction of required) {
    const assessment = assessToneRoute(await probe(routes[direction]));
    if (!assessment.ok) {
      return { ok: false, reason: `${direction}-${assessment.reason}` };
    }
  }
  return { ok: true, routes: required };
}
