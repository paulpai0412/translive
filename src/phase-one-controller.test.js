import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { PhaseOneController } from "./phase-one-controller.js";

const fixture = fileURLToPath(
  new URL("../fixtures/fake-codex-app-server.mjs", import.meta.url),
);

function validConfig(overrides = {}) {
  const { tx: txOverrides = {}, rx: rxOverrides = {}, ...rest } = overrides;
  return {
    platform: "teams",
    routeProfile: "vb-cable",
    headphonesConfirmed: true,
    ...rest,
    tx: {
      sourceEndpointId: "mic",
      sourceEndpointName: "Physical Microphone",
      sourceEndpointKind: "audioinput",
      sinkEndpointId: "cable-a",
      sinkEndpointName: "Cable-A Input",
      sinkEndpointKind: "audiooutput",
      sdp: "v=0\r\nfixture-offer",
      ...txOverrides,
    },
    rx: {
      sourceEndpointId: "cable-b",
      sourceEndpointName: "Cable-B Output",
      sourceEndpointKind: "audioinput",
      sinkEndpointId: "headphones",
      sinkEndpointName: "USB Headphones",
      sinkEndpointKind: "audiooutput",
      sdp: "v=0\r\nfixture-offer",
      ...rxOverrides,
    },
  };
}

function readyRuntime() {
  return async () => ({
    executable: process.execPath,
    version: `node ${process.versions.node}`,
    semanticVersion: process.versions.node,
    loggedIn: true,
    checksum: "fixture-checksum",
  });
}

function controllerFor({
  evidenceDirectory,
  publish = () => {},
  inspectRuntime = readyRuntime(),
  codexArgs = [fixture],
} = {}) {
  return new PhaseOneController({
    appVersion: "0.0.0-test",
    codexExecutable: process.execPath,
    codexArgs,
    codexVersion: process.versions.node,
    cwd: process.cwd(),
    evidenceDirectory,
    publish,
    inspectRuntime,
  });
}

test("returns VoiceMeeter meeting endpoint instructions for the free route profile", async () => {
  const evidenceDirectory = await mkdtemp(
    join(tmpdir(), "translive-controller-voicemeeter-"),
  );
  const controller = controllerFor({ evidenceDirectory });
  const result = await controller.preflight(
    validConfig({
      routeProfile: "voicemeeter",
      tx: {
        sinkEndpointId: "voicemeeter-aux-input",
        sinkEndpointName: "Voicemeeter AUX Input",
      },
      rx: {
        sourceEndpointId: "voicemeeter-out-b1",
        sourceEndpointName: "Voicemeeter Out B1",
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.match(result.instructions.microphone, /Voicemeeter Out B2/i);
  assert.match(result.instructions.speaker, /Voicemeeter Input/i);
});

test("keeps channels connecting until the renderer confirms both SDP answers", async () => {
  const evidenceDirectory = await mkdtemp(
    join(tmpdir(), "translive-controller-evidence-"),
  );
  const events = [];
  const controller = controllerFor({
    evidenceDirectory,
    publish: (event) => events.push(event),
  });

  const result = await controller.start(validConfig());
  assert.deepEqual(result.status, { tx: "connecting", rx: "connecting" });
  assert.equal(result.aggregate, "connecting");

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(events.filter((event) => event.type === "sdp").length, 2);
  assert.deepEqual(
    events
      .filter((event) => event.type === "speech-fallback")
      .map(({ direction, characters }) => ({ direction, characters })),
    [
      { direction: "rx", characters: 8 },
      { direction: "rx", characters: 1 },
    ],
  );
  await controller.answerApplied("tx");
  assert.deepEqual(controller.status(), { tx: "live", rx: "connecting" });
  await controller.answerApplied("rx");
  assert.deepEqual(controller.status(), { tx: "live", rx: "live" });

  await controller.stop("user-stop");
  const [file] = await readdir(evidenceDirectory);
  const evidence = JSON.parse(
    await readFile(join(evidenceDirectory, file), "utf8"),
  );
  assert.equal(evidence.sessions.tx.threadId, "fixture-thread-1");
  assert.equal(evidence.sessions.rx.threadId, "fixture-thread-2");
  assert.notEqual(
    evidence.sessions.tx.realtimeSessionId,
    evidence.sessions.rx.realtimeSessionId,
  );
  assert.equal(evidence.termination.outcome, "stopped");
  assert.doesNotMatch(
    JSON.stringify(evidence),
    /fixture-offer|fixture translation/,
  );
});

test("rejects a re-entrant start without creating a second app-server run", async () => {
  const evidenceDirectory = await mkdtemp(
    join(tmpdir(), "translive-controller-reentrant-"),
  );
  const controller = controllerFor({ evidenceDirectory });
  const first = controller.start(validConfig());

  await assert.rejects(
    controller.start(validConfig()),
    /already starting or active/i,
  );
  await first;
  await controller.stop("user-stop");
});

test("writes blocked evidence when login preflight fails and when renderer setup blocks", async () => {
  const evidenceDirectory = await mkdtemp(
    join(tmpdir(), "translive-controller-blocked-"),
  );
  const blocked = controllerFor({
    evidenceDirectory,
    inspectRuntime: async () => ({
      executable: "codex",
      version: "codex-cli 0.145.0",
      semanticVersion: "0.145.0",
      loggedIn: false,
    }),
  });

  const preflight = await blocked.preflight(validConfig());
  assert.equal(preflight.ok, false);
  await blocked.recordRendererBlockedAttempt(validConfig(), "setSinkId failed");

  const files = await readdir(evidenceDirectory);
  assert.equal(files.length, 2);
  const snapshots = await Promise.all(
    files.map(async (file) =>
      JSON.parse(await readFile(join(evidenceDirectory, file), "utf8")),
    ),
  );
  assert.equal(
    snapshots.every((snapshot) => snapshot.termination.outcome === "blocked"),
    true,
  );
  assert.equal(
    snapshots.flatMap((snapshot) => snapshot.blockedAttempts).length,
    2,
  );
  assert.equal(
    snapshots.find(
      (snapshot) =>
        snapshot.blockedAttempts[0].surface === "controller-preflight",
    ).codex.version,
    "codex-cli 0.145.0",
  );
});

test("closes the app-server even when evidence writing fails", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "translive-controller-close-"),
  );
  const evidencePath = join(directory, "evidence-file");
  const exitMarker = join(directory, "client-closed");
  await writeFile(evidencePath, "not a directory", "utf8");
  const controller = controllerFor({
    evidenceDirectory: evidencePath,
    codexArgs: [fixture, exitMarker],
  });

  await controller.start(validConfig());
  await assert.rejects(controller.stop("write-failure"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await readFile(exitMarker, "utf8"), "closed");
});

test("finalizes a no-go evidence file when both realtime starts are rejected", async () => {
  const evidenceDirectory = await mkdtemp(
    join(tmpdir(), "translive-controller-no-go-"),
  );
  const controller = controllerFor({ evidenceDirectory });

  await assert.rejects(
    controller.start(
      validConfig({
        tx: { sdp: "fixture-reject" },
        rx: { sdp: "fixture-reject" },
      }),
    ),
    /both GPT-Live sessions failed/i,
  );

  const [file] = await readdir(evidenceDirectory);
  const evidence = JSON.parse(
    await readFile(join(evidenceDirectory, file), "utf8"),
  );
  assert.deepEqual(controller.status(), { tx: "stopped", rx: "stopped" });
  assert.equal(evidence.termination.outcome, "no-go");
  assert.equal(evidence.blockedAttempts[0].surface, "controller-start");
  assert.equal(evidence.gate.result, "fail");
});
