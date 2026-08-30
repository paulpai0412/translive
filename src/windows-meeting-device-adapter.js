import { execFile as defaultExecFile } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(defaultExecFile);

function endpointId(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing ${field}`);
  }
  return value;
}

function endpointName(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing ${field}`);
  }
  return value.trim();
}

function roleSnapshot(value) {
  const capture = value?.capture;
  const render = value?.render;
  return {
    capture: {
      consoleId: endpointId(capture?.consoleId, "capture.consoleId"),
      multimediaId: endpointId(capture?.multimediaId, "capture.multimediaId"),
      communicationsId: endpointId(
        capture?.communicationsId,
        "capture.communicationsId",
      ),
    },
    render: {
      consoleId: endpointId(render?.consoleId, "render.consoleId"),
      multimediaId: endpointId(render?.multimediaId, "render.multimediaId"),
      communicationsId: endpointId(
        render?.communicationsId,
        "render.communicationsId",
      ),
    },
  };
}

export class WindowsMeetingDeviceAdapter {
  #openExternal;
  #platform;
  #run;
  #scriptPath;

  constructor({
    openExternal = async () => {},
    platform = process.platform,
    run = execFile,
    scriptPath,
  }) {
    this.#openExternal = openExternal;
    this.#platform = platform;
    this.#run = run;
    this.#scriptPath = scriptPath;
  }

  async detect(app) {
    if (this.#platform !== "win32") {
      return { installed: false, running: false, supported: false };
    }
    const result = await this.#invoke(["-App", app], "detect");
    return {
      installed: result.installed === true,
      running: result.running === true,
      supported: true,
    };
  }

  async resolve({ captureName, renderName }) {
    this.#requireWindows();
    const result = await this.#invoke(
      [
        "-CaptureName",
        endpointName(captureName, "captureName"),
        "-RenderName",
        endpointName(renderName, "renderName"),
      ],
      "resolve",
    );
    return {
      captureId: endpointId(result.captureId, "captureId"),
      renderId: endpointId(result.renderId, "renderId"),
    };
  }

  async snapshot() {
    this.#requireWindows();
    const result = await this.#invoke([], "snapshot");
    return {
      captureId: endpointId(result.captureId, "captureId"),
      renderId: endpointId(result.renderId, "renderId"),
    };
  }

  async current() {
    return this.snapshot();
  }

  async snapshotAllRoles() {
    this.#requireWindows();
    return roleSnapshot(await this.#invoke([], "snapshot-all-roles"));
  }

  async currentAllRoles() {
    return this.snapshotAllRoles();
  }

  async applyAllRoles({ captureId, renderId }) {
    this.#requireWindows();
    await this.#invoke(
      [
        "-CaptureId",
        endpointId(captureId, "captureId"),
        "-RenderId",
        endpointId(renderId, "renderId"),
      ],
      "apply-all-roles",
    );
  }

  async restoreAllRoles(snapshot) {
    this.#requireWindows();
    const roles = roleSnapshot(snapshot);
    await this.#invoke(
      [
        "-CaptureConsoleId",
        roles.capture.consoleId,
        "-CaptureMultimediaId",
        roles.capture.multimediaId,
        "-CaptureCommunicationsId",
        roles.capture.communicationsId,
        "-RenderConsoleId",
        roles.render.consoleId,
        "-RenderMultimediaId",
        roles.render.multimediaId,
        "-RenderCommunicationsId",
        roles.render.communicationsId,
      ],
      "restore-all-roles",
    );
  }

  async apply({ captureId, renderId }) {
    this.#requireWindows();
    await this.#invoke(
      [
        "-CaptureId",
        endpointId(captureId, "captureId"),
        "-RenderId",
        endpointId(renderId, "renderId"),
      ],
      "apply",
    );
  }

  async restore({ captureId, renderId }) {
    this.#requireWindows();
    await this.#invoke(
      [
        "-CaptureId",
        endpointId(captureId, "captureId"),
        "-RenderId",
        endpointId(renderId, "renderId"),
      ],
      "restore",
    );
  }

  async openSettings() {
    if (this.#platform !== "win32") {
      return { opened: false, reason: "windows-only" };
    }
    await this.#openExternal("ms-settings:sound");
    return { opened: true };
  }

  async #invoke(argumentsAfterAction, action) {
    const { stdout } = await this.#run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        this.#scriptPath,
        "-Action",
        action,
        ...argumentsAfterAction,
      ],
      { windowsHide: true },
    );
    let result;
    try {
      result = JSON.parse(String(stdout).trim());
    } catch {
      throw new Error("WINDOWS_AUDIO_ADAPTER_INVALID_RESPONSE");
    }
    if (result?.ok !== true) {
      throw new Error(result?.code || "WINDOWS_AUDIO_ADAPTER_FAILED");
    }
    return result;
  }

  #requireWindows() {
    if (this.#platform !== "win32") {
      throw new Error("WINDOWS_AUDIO_ADAPTER_UNSUPPORTED_PLATFORM");
    }
  }
}
