import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startDualChannelRun } from "./dual-channel-run.js";
import { RunEvidence } from "./evidence.js";

function validConfig(overrides = {}) {
  const { tx: txOverrides = {}, rx: rxOverrides = {}, ...rest } = overrides;
  return {
    platform: "teams",
    routeProfile: "vb-cable",
    headphonesConfirmed: true,
    ...rest,
    tx: {
      sourceEndpointId: "physical-mic",
      sourceEndpointName: "Physical Microphone",
      sourceEndpointKind: "audioinput",
      sinkEndpointId: "cable-a",
      sinkEndpointName: "Cable-A Input",
      sinkEndpointKind: "audiooutput",
      ...txOverrides,
    },
    rx: {
      sourceEndpointId: "cable-b",
      sourceEndpointName: "Cable-B Output",
      sourceEndpointKind: "audioinput",
      sinkEndpointId: "headphones",
      sinkEndpointName: "USB Headphones",
      sinkEndpointKind: "audiooutput",
      ...rxOverrides,
    },
  };
}

async function startedRun(options = {}) {
  return startDualChannelRun(validConfig(options.config), {
    openChannel: async () => ({ stop: async () => {} }),
    ...options,
  });
}

test("starts independent TX and RX channels but waits for each WebRTC answer", async () => {
  const opened = [];
  const run = await startDualChannelRun(validConfig(), {
    openChannel: async (channel) => {
      opened.push(channel);
      return { stop: async () => {} };
    },
  });

  assert.deepEqual(run.status(), { tx: "connecting", rx: "connecting" });
  assert.deepEqual(
    opened.map(({ direction, sourceEndpointId, sinkEndpointId }) => ({
      direction,
      sourceEndpointId,
      sinkEndpointId,
    })),
    [
      {
        direction: "tx",
        sourceEndpointId: "physical-mic",
        sinkEndpointId: "cable-a",
      },
      {
        direction: "rx",
        sourceEndpointId: "cable-b",
        sinkEndpointId: "headphones",
      },
    ],
  );
  assert.notEqual(opened[0].threadId, opened[1].threadId);

  run.answerApplied("tx");
  assert.deepEqual(run.status(), { tx: "live", rx: "connecting" });
  run.answerApplied("rx");
  assert.deepEqual(run.status(), { tx: "live", rx: "live" });
});

test("keeps a healthy channel connecting when its peer fails to start", async () => {
  let txStopped = false;
  const run = await startDualChannelRun(validConfig(), {
    openChannel: async ({ direction }) => {
      if (direction === "rx") throw new Error("RX entitlement denied");
      return {
        stop: async () => {
          txStopped = true;
        },
      };
    },
  });

  assert.deepEqual(run.status(), { tx: "connecting", rx: "failed" });
  assert.equal(run.aggregateStatus(), "degraded");
  run.answerApplied("tx");
  assert.deepEqual(run.status(), { tx: "live", rx: "failed" });
  await run.stop();
  assert.equal(txStopped, true);
});

test("reports a no-go when both realtime starts fail", async () => {
  const evidence = new RunEvidence({
    appVersion: "test",
    codex: {},
    endpoints: [],
  });
  const run = await startDualChannelRun(validConfig(), {
    evidence,
    openChannel: async ({ direction }) => {
      throw new Error(`${direction} start failed`);
    },
  });

  assert.deepEqual(run.status(), { tx: "failed", rx: "failed" });
  assert.equal(run.aggregateStatus(), "blocked");
  assert.equal(run.allFailed(), true);
  assert.equal(evidence.snapshot().errors.length, 2);
});

test("rejects duplicate routes and swapped endpoint kinds before opening channels", async () => {
  let openCount = 0;
  const openChannel = async () => {
    openCount += 1;
    return { stop: async () => {} };
  };

  await assert.rejects(
    startDualChannelRun(validConfig({ rx: { sourceEndpointId: "cable-a" } }), {
      openChannel,
    }),
    /audio endpoints must be unique/i,
  );
  await assert.rejects(
    startDualChannelRun(
      validConfig({
        tx: {
          sourceEndpointKind: "audiooutput",
          sinkEndpointKind: "audioinput",
        },
      }),
      { openChannel },
    ),
    /TX source must be an audioinput/i,
  );
  await assert.rejects(
    startDualChannelRun(validConfig({ headphonesConfirmed: false }), {
      openChannel,
    }),
    /Headphones must be explicitly confirmed/i,
  );
  await assert.rejects(
    startDualChannelRun(
      validConfig({ tx: { sinkEndpointName: "Built-in Speakers" } }),
      { openChannel },
    ),
    /Cable-A Input/i,
  );
  await assert.rejects(
    startDualChannelRun(
      validConfig({ rx: { sourceEndpointName: "Cable-A Output" } }),
      { openChannel },
    ),
    /Cable-B Output/i,
  );
  await assert.rejects(
    startDualChannelRun(
      validConfig({ tx: { sourceEndpointName: "Cable-A Output" } }),
      { openChannel },
    ),
    /physical microphone/i,
  );
  await assert.rejects(
    startDualChannelRun(
      validConfig({ rx: { sinkEndpointName: "Cable-B Input" } }),
      { openChannel },
    ),
    /physical headphones/i,
  );
  assert.equal(openCount, 0);
});

test("accepts the isolated VoiceMeeter VAIO and AUX route profile", async () => {
  let openCount = 0;
  const config = validConfig({
    routeProfile: "voicemeeter",
    tx: {
      sinkEndpointId: "voicemeeter-aux-input",
      sinkEndpointName: "Voicemeeter AUX Input (VB-Audio Voicemeeter VAIO)",
    },
    rx: {
      sourceEndpointId: "voicemeeter-out-b1",
      sourceEndpointName: "Voicemeeter Out B1 (VB-Audio Voicemeeter VAIO)",
    },
  });

  const run = await startDualChannelRun(config, {
    openChannel: async () => {
      openCount += 1;
      return { stop: async () => {} };
    },
  });

  assert.equal(openCount, 2);
  assert.equal(run.aggregateStatus(), "connecting");
  await assert.rejects(
    startDualChannelRun(
      {
        ...config,
        rx: { ...config.rx, sourceEndpointName: "Voicemeeter Out B2" },
      },
      { openChannel: async () => ({ stop: async () => {} }) },
    ),
    /Voicemeeter Out B1/i,
  );
});

test("stops each successful channel only once even if one stop request fails", async () => {
  const stops = { tx: 0, rx: 0 };
  const evidence = new RunEvidence({
    appVersion: "test",
    codex: {},
    endpoints: [],
  });
  const run = await startDualChannelRun(validConfig(), {
    evidence,
    openChannel: async ({ direction }) => ({
      stop: async () => {
        stops[direction] += 1;
        if (direction === "tx") throw new Error("stop transport failed");
      },
    }),
  });

  await run.stop();
  await run.stop();

  assert.deepEqual(stops, { tx: 1, rx: 1 });
  assert.deepEqual(run.status(), { tx: "stopped", rx: "stopped" });
  assert.match(evidence.snapshot().errors[0].message, /stop transport failed/);
});

test("fails a closed channel and never revives it on unmute", async () => {
  const run = await startedRun();
  run.answerApplied("tx");
  run.setMuted("tx", true);
  run.handleRealtimeEvent("tx", {
    method: "thread/realtime/closed",
    params: { reason: "network lost" },
  });
  run.setMuted("tx", false);

  assert.deepEqual(run.status(), { tx: "failed", rx: "connecting" });
});

test("does not turn a stopping channel into failed when a close notification arrives", async () => {
  let releaseTx;
  const run = await startDualChannelRun(validConfig(), {
    openChannel: async ({ direction }) => ({
      stop: () =>
        direction === "tx"
          ? new Promise((resolve) => {
              releaseTx = resolve;
            })
          : Promise.resolve(),
    }),
  });
  run.answerApplied("tx");
  const stopping = run.stop();
  run.handleRealtimeEvent("tx", {
    method: "thread/realtime/closed",
    params: { reason: "local stop" },
  });
  assert.equal(run.status().tx, "stopping");
  releaseTx();
  await stopping;
  assert.equal(run.status().tx, "stopped");
});

test("records redacted aggregate evidence without transcripts, SDP, or tokens", async () => {
  const evidence = new RunEvidence({
    appVersion: "0.0.0-test",
    codex: {
      version: "codex-cli 0.145.0",
      executable: "codex",
      checksum: "abc",
    },
    platform: "teams",
    routeProfile: "vb-cable",
    model: "gpt-live-1-codex",
    voices: { tx: "cove", rx: "cove" },
    endpoints: [
      {
        role: "physicalMicSource",
        id: "mic-secret-id",
        name: "Headset Microphone",
        kind: "audioinput",
      },
      {
        role: "cableAPlaybackSink",
        id: "cable-a",
        name: "CABLE-A Input",
        kind: "audiooutput",
      },
      {
        role: "cableBRecordingSource",
        id: "cable-b",
        name: "CABLE-B Output",
        kind: "audioinput",
      },
      {
        role: "headphonesSink",
        id: "headphones-secret-id",
        name: "USB Headphones",
        kind: "audiooutput",
      },
    ],
  });
  const stateEvents = [];
  const run = await startDualChannelRun(
    validConfig({
      tx: { sourceEndpointId: "mic-secret-id", sinkEndpointId: "cable-a" },
      rx: {
        sourceEndpointId: "cable-b",
        sinkEndpointId: "headphones-secret-id",
      },
    }),
    {
      evidence,
      onStateChange: (event) => stateEvents.push(event),
      openChannel: async () => ({ stop: async () => {} }),
    },
  );

  run.recordInputAudio("tx", 1_000);
  run.recordOutputAudio("tx", 1_800);
  run.recordWebRtcStats("tx", { rttMs: 120 }, 1_850);
  run.handleRealtimeEvent("tx", {
    method: "thread/realtime/transcript/delta",
    params: { role: "assistant", delta: "This transcript stays ephemeral." },
    atMs: 1_860,
  });
  run.handleRealtimeEvent("rx", {
    method: "thread/realtime/error",
    params: {
      message:
        '"access_token": "short-token" refresh_token=refresh id_token=eyJx.eyJy.sig sk-proj-test',
    },
    atMs: 1_900,
  });
  run.handleRealtimeEvent("tx", {
    method: "thread/realtime/error",
    params: { message: "Invalid SDP follows: v=0\r\na=candidate:secret" },
    atMs: 2_000,
  });
  const requestError = new Error("request rejected account id=secret-account");
  requestError.data = { requestId: "req_safe_123" };
  evidence.recordError("system", requestError);

  const directory = await mkdtemp(join(tmpdir(), "translive-evidence-"));
  const file = await evidence.write(directory);
  const serialized = await readFile(file, "utf8");
  const persisted = JSON.parse(serialized);

  assert.equal(persisted.route.routeProfile, "vb-cable");
  assert.equal(persisted.endpoints[0].kind, "audioinput");
  assert.notEqual(persisted.endpoints[0].idHash, "mic-secret-id");
  assert.equal(persisted.metrics.tx.ttfa.count, 1);
  assert.equal(persisted.metrics.tx.ttfa.p50Ms, 800);
  assert.equal(persisted.transcriptTimestamps.length, 1);
  assert.equal(persisted.gate.result, "fail");
  assert.equal(persisted.errors.at(-1).requestId, "req_safe_123");
  assert.doesNotMatch(
    serialized,
    /This transcript|short-token|eyJx\.eyJy\.sig|sk-proj-test|v=0|secret-account/,
  );
  assert.doesNotMatch(JSON.stringify(stateEvents), /short-token|v=0/);
});

test("does not claim an interpretation-lag pass from uncorrelated audio activity", () => {
  const evidence = new RunEvidence({
    appVersion: "test",
    codex: {},
    endpoints: [],
  });

  for (const direction of ["tx", "rx"]) {
    evidence.recordInputAudio(direction, 1_000);
    evidence.recordOutputAudio(direction, 1_500);
    evidence.recordInputAudio(direction, 9_000);
    evidence.recordOutputAudio(direction, 10_000);
  }
  evidence.finish(11_000, { reason: "user-stop", outcome: "stopped" });

  const snapshot = evidence.snapshot();
  assert.equal(snapshot.metrics.tx.activityGap.count, 2);
  assert.equal(snapshot.gate.checks.interpretationLag.status, "insufficient");
  assert.equal(snapshot.gate.result, "insufficient");
});
