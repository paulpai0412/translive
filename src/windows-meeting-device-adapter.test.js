import assert from "node:assert/strict";
import test from "node:test";

import { WindowsMeetingDeviceAdapter } from "./windows-meeting-device-adapter.js";

test("uses a fixed PowerShell script with device IDs as argument values", async () => {
  const calls = [];
  const adapter = new WindowsMeetingDeviceAdapter({
    platform: "win32",
    run: async (command, args, options) => {
      calls.push({ args, command, options });
      return { stdout: '{"ok":true,"installed":true,"running":true}' };
    },
    scriptPath: "C:/TransLive/windows-meeting-devices.ps1",
  });

  const detected = await adapter.detect("teams");

  assert.deepEqual(detected, {
    installed: true,
    running: true,
    supported: true,
  });
  assert.deepEqual(calls[0], {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:/TransLive/windows-meeting-devices.ps1",
      "-Action",
      "detect",
      "-App",
      "teams",
    ],
    options: { windowsHide: true },
  });
});

test("resolves native IMMDevice IDs by display name without receiving browser IDs", async () => {
  const calls = [];
  const adapter = new WindowsMeetingDeviceAdapter({
    platform: "win32",
    run: async (_command, args) => {
      calls.push(args);
      return {
        stdout:
          '{"ok":true,"captureId":"{0.0.1}.native-capture","renderId":"{0.0.0}.native-render"}',
      };
    },
    scriptPath: "devices.ps1",
  });

  const resolved = await adapter.resolve({
    captureName: "Voicemeeter Out B2",
    renderName: "Voicemeeter Input",
    browserCaptureId: "browser-id-must-not-be-forwarded",
  });

  assert.deepEqual(resolved, {
    captureId: "{0.0.1}.native-capture",
    renderId: "{0.0.0}.native-render",
  });
  assert.deepEqual(calls, [
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "devices.ps1",
      "-Action",
      "resolve",
      "-CaptureName",
      "Voicemeeter Out B2",
      "-RenderName",
      "Voicemeeter Input",
    ],
  ]);
  assert.equal(
    JSON.stringify(calls).includes("browser-id-must-not-be-forwarded"),
    false,
  );
});

test("applies and reads communication endpoint IDs without shell interpolation", async () => {
  const calls = [];
  const adapter = new WindowsMeetingDeviceAdapter({
    platform: "win32",
    run: async (_command, args) => {
      calls.push(args);
      return {
        stdout: '{"ok":true,"captureId":"mic-id","renderId":"speaker-id"}',
      };
    },
    scriptPath: "devices.ps1",
  });

  assert.deepEqual(await adapter.snapshot(), {
    captureId: "mic-id",
    renderId: "speaker-id",
  });
  await adapter.apply({
    captureId: "virtual-mic",
    renderId: "virtual-speaker",
  });
  await adapter.restore({ captureId: "mic-id", renderId: "speaker-id" });

  assert.deepEqual(calls, [
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "devices.ps1",
      "-Action",
      "snapshot",
    ],
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "devices.ps1",
      "-Action",
      "apply",
      "-CaptureId",
      "virtual-mic",
      "-RenderId",
      "virtual-speaker",
    ],
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "devices.ps1",
      "-Action",
      "restore",
      "-CaptureId",
      "mic-id",
      "-RenderId",
      "speaker-id",
    ],
  ]);
});

test("opens Windows sound settings and never runs device commands off Windows", async () => {
  let calls = 0;
  const opened = [];
  const adapter = new WindowsMeetingDeviceAdapter({
    openExternal: async (url) => opened.push(url),
    platform: "linux",
    run: async () => {
      calls += 1;
      return { stdout: "{}" };
    },
    scriptPath: "devices.ps1",
  });

  assert.deepEqual(await adapter.detect("zoom"), {
    installed: false,
    running: false,
    supported: false,
  });
  assert.deepEqual(await adapter.openSettings("zoom"), {
    opened: false,
    reason: "windows-only",
  });
  assert.equal(calls, 0);
  assert.deepEqual(opened, []);
});

test("does not forward PowerShell error detail to callers", async () => {
  const adapter = new WindowsMeetingDeviceAdapter({
    platform: "win32",
    run: async () => ({
      stdout:
        '{"ok":false,"code":"POLICY_CONFIG_UNAVAILABLE","detail":"private system path"}',
    }),
    scriptPath: "devices.ps1",
  });

  await assert.rejects(adapter.snapshot(), /POLICY_CONFIG_UNAVAILABLE/);
});
