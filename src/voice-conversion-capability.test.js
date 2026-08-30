import assert from "node:assert/strict";
import test from "node:test";

import {
  VoiceConversionCapabilityProbe,
  selectVoiceConversionCapability,
} from "./voice-conversion-capability.js";

const readyRuntime = {
  directml: { available: true, version: "0.2.5" },
  ffmpeg: { available: true, version: "7.0" },
  python: { available: true, version: "3.12.8" },
  rvc: { available: true, weightsOnlyLoader: true },
  torch: { available: true, version: "2.6.0" },
};

const targetHardware = {
  cpuName: "Intel(R) Core(TM) Ultra X7 358H",
  gpuDriver: "32.0.101.8359",
  gpuName: "Intel(R) Arc(TM) B390 GPU",
  memoryBytes: 33_873_752_064,
  nvidiaPresent: false,
};

test("selects DirectML only when the verified local RVC runtime is safe to load", () => {
  assert.deepEqual(
    selectVoiceConversionCapability({
      hardware: targetHardware,
      platform: "win32",
      runtime: readyRuntime,
    }),
    {
      hardware: {
        cpuName: "Intel(R) Core(TM) Ultra X7 358H",
        gpuDriver: "32.0.101.8359",
        gpuName: "Intel(R) Arc(TM) B390 GPU",
        memoryBytes: 33_873_752_064,
      },
      provider: "directml-candidate",
      state: "available",
    },
  );
});

test("falls back to a CPU baseline or reports unavailable without leaking paths", () => {
  assert.deepEqual(
    selectVoiceConversionCapability({
      hardware: targetHardware,
      platform: "win32",
      runtime: { ...readyRuntime, directml: { available: false } },
    }),
    {
      hardware: {
        cpuName: "Intel(R) Core(TM) Ultra X7 358H",
        gpuDriver: "32.0.101.8359",
        gpuName: "Intel(R) Arc(TM) B390 GPU",
        memoryBytes: 33_873_752_064,
      },
      provider: "cpu-baseline",
      state: "available",
    },
  );
  const unavailable = selectVoiceConversionCapability({
    hardware: { ...targetHardware, userPath: "C:\\secret\\rvc" },
    platform: "win32",
    runtime: {
      ...readyRuntime,
      python: { available: false, path: "C:\\secret\\python.exe" },
    },
  });
  assert.deepEqual(unavailable, {
    hardware: {
      cpuName: "Intel(R) Core(TM) Ultra X7 358H",
      gpuDriver: "32.0.101.8359",
      gpuName: "Intel(R) Arc(TM) B390 GPU",
      memoryBytes: 33_873_752_064,
    },
    provider: "unavailable",
    state: "unavailable",
  });
  assert.doesNotMatch(JSON.stringify(unavailable), /secret|path/i);
});

test("runs the Windows read-only probe through a fixed script and returns redacted facts", async () => {
  const calls = [];
  const probe = new VoiceConversionCapabilityProbe({
    platform: "win32",
    run: async (command, arguments_, options) => {
      calls.push({ command, arguments_, options });
      return {
        stdout: JSON.stringify({
          hardware: { ...targetHardware, machinePath: "C:\\private" },
          platform: "win32",
          runtime: readyRuntime,
        }),
      };
    },
    scriptPath: "C:\\app\\scripts\\probe-rvc-capability.ps1",
    timeoutMs: 17,
  });

  assert.deepEqual(await probe.probe(), {
    hardware: {
      cpuName: "Intel(R) Core(TM) Ultra X7 358H",
      gpuDriver: "32.0.101.8359",
      gpuName: "Intel(R) Arc(TM) B390 GPU",
      memoryBytes: 33_873_752_064,
    },
    provider: "directml-candidate",
    state: "available",
  });
  assert.deepEqual(calls, [
    {
      arguments_: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "C:\\app\\scripts\\probe-rvc-capability.ps1",
      ],
      command: "powershell.exe",
      options: { timeout: 17, windowsHide: true },
    },
  ]);
});

test("bounds a hung PowerShell capability probe and reports raw-only unavailable", async () => {
  const probe = new VoiceConversionCapabilityProbe({
    platform: "win32",
    run: async () => new Promise(() => {}),
    scriptPath: "C:\\app\\scripts\\probe-rvc-capability.ps1",
    timeoutMs: 1,
  });

  assert.deepEqual(await probe.probe(), {
    hardware: {},
    provider: "unavailable",
    state: "unavailable",
  });
});

test("does not claim a non-Windows or malformed probe has a conversion provider", async () => {
  const probe = new VoiceConversionCapabilityProbe({
    platform: "linux",
    scriptPath: "/not-run.ps1",
  });
  assert.deepEqual(await probe.probe(), {
    hardware: {},
    provider: "unavailable",
    state: "unavailable",
  });
});
