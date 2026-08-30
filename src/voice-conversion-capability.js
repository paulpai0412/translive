import { execFile as defaultExecFile } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(defaultExecFile);

const VOICE_CONVERSION_CAPABILITY_TIMEOUT_MS = 5_000;

function boundedText(value, maxLength = 160) {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\r\n\t]/g, " ").trim();
  return text.length > 0 ? text.slice(0, maxLength) : undefined;
}

function finiteMemory(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function supportedRuntime(value) {
  return value?.available === true;
}

function safeHardware(value) {
  const hardware = {
    cpuName: boundedText(value?.cpuName),
    gpuDriver: boundedText(value?.gpuDriver),
    gpuName: boundedText(value?.gpuName),
    memoryBytes: finiteMemory(value?.memoryBytes),
  };
  return Object.fromEntries(
    Object.entries(hardware).filter(([, item]) => item !== undefined),
  );
}

/**
 * Select an honest local RVC execution candidate. A provider is only available
 * once the caller has verified a local RVC runtime that promises weights-only
 * loading; device branding alone never proves realtime conversion capability.
 */
export function selectVoiceConversionCapability(receipt = {}) {
  const runtime = receipt?.runtime ?? {};
  const localRuntimeReady =
    receipt?.platform === "win32" &&
    supportedRuntime(runtime.python) &&
    supportedRuntime(runtime.ffmpeg) &&
    supportedRuntime(runtime.torch) &&
    supportedRuntime(runtime.rvc) &&
    runtime.rvc.weightsOnlyLoader === true;
  let provider = "unavailable";
  if (localRuntimeReady) {
    provider = supportedRuntime(runtime.directml)
      ? "directml-candidate"
      : "cpu-baseline";
  }
  return {
    hardware: safeHardware(receipt?.hardware),
    provider,
    state: provider === "unavailable" ? "unavailable" : "available",
  };
}

/**
 * Fixed, read-only Windows capability probe adapter. It deliberately forwards
 * no environment, model path, profile, or audio data to the renderer.
 */
export class VoiceConversionCapabilityProbe {
  #platform;
  #run;
  #scriptPath;
  #timeoutMs;

  constructor({
    platform = process.platform,
    run = execFile,
    scriptPath,
    timeoutMs = VOICE_CONVERSION_CAPABILITY_TIMEOUT_MS,
  } = {}) {
    this.#platform = platform;
    this.#run = run;
    this.#scriptPath = scriptPath;
    this.#timeoutMs =
      Number.isSafeInteger(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : VOICE_CONVERSION_CAPABILITY_TIMEOUT_MS;
  }

  async probe() {
    if (this.#platform !== "win32" || !this.#scriptPath) {
      return selectVoiceConversionCapability();
    }
    let timer;
    try {
      const result = await Promise.race([
        this.#run(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            this.#scriptPath,
          ],
          { timeout: this.#timeoutMs, windowsHide: true },
        ),
        new Promise((resolve) => {
          timer = setTimeout(resolve, this.#timeoutMs);
        }),
      ]);
      if (!result) return selectVoiceConversionCapability();
      return selectVoiceConversionCapability(
        JSON.parse(String(result.stdout).trim()),
      );
    } catch {
      return selectVoiceConversionCapability();
    } finally {
      clearTimeout(timer);
    }
  }
}
