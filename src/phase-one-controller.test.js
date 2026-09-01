import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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
  createClient,
  records,
  meetingIndex,
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
    createClient,
    records,
    meetingIndex,
  });
}

class PacingClient extends EventEmitter {
  appendRequests = [];
  closed = false;
  thread = { id: "pacing-rx-thread" };

  async start() {}

  async startEphemeralThread() {
    return this.thread;
  }

  async startRealtime() {}

  async stopRealtime() {}

  async appendSpeech(threadId, text) {
    this.appendRequests.push({ atMs: Date.now(), text, threadId });
  }

  async close() {
    this.closed = true;
  }

  assistant(delta, { final = false } = {}) {
    this.emit("notification", {
      method: final
        ? "thread/realtime/transcript/done"
        : "thread/realtime/transcript/delta",
      params: {
        threadId: this.thread.id,
        role: "assistant",
        ...(final ? { text: delta } : { delta }),
      },
    });
  }

  itemStarted(id, role = "assistant", threadId = this.thread.id) {
    this.emit("notification", {
      method: "thread/realtime/item/started",
      params: {
        threadId,
        item: {
          id,
          realtimeSessionId: "test-session",
          type: "transcriptSegment",
          role,
          text: "",
        },
      },
    });
  }

  itemDelta(id, delta, threadId = this.thread.id) {
    this.emit("notification", {
      method: "thread/realtime/item/transcript/delta",
      params: { threadId, itemId: id, delta },
    });
  }

  itemCompleted(id, role, text, threadId = this.thread.id) {
    this.emit("notification", {
      method: "thread/realtime/item/completed",
      params: {
        threadId,
        item: {
          id,
          realtimeSessionId: "test-session",
          type: "transcriptSegment",
          role,
          text,
        },
      },
    });
  }
}

class PromptClient extends EventEmitter {
  realtimeStarts = [];
  threadNumber = 0;

  async start() {}

  async startEphemeralThread() {
    this.threadNumber += 1;
    return { id: `prompt-thread-${this.threadNumber}` };
  }

  async startRealtime(request) {
    this.realtimeStarts.push(request);
  }

  async stopRealtime() {}
  async close() {}
}

test("GPT-Live initialization permits translation only and sends complete short utterances", async () => {
  const evidenceDirectory = await mkdtemp(
    join(tmpdir(), "translive-controller-prompt-"),
  );
  const client = new PromptClient();
  const controller = controllerFor({
    evidenceDirectory,
    createClient: () => client,
  });

  await controller.start(validConfig());
  assert.equal(client.realtimeStarts.length, 2);
  for (const { prompt } of client.realtimeStarts) {
    assert.match(
      prompt,
      /Translate questions as questions; never answer them\./,
    );
    assert.match(prompt, /Translate each completed utterance exactly once/);
    assert.match(
      prompt,
      /Immediately translate and speak complete short utterances/,
    );
    assert.match(
      prompt,
      /Start speaking the first translation as soon as the first stable phrase is understandable/,
    );
  }
  const rxStart = client.realtimeStarts.find(({ prompt }) =>
    prompt.includes("one fixed target language"),
  );
  assert.match(
    rxStart.prompt,
    /Speak every interpretation aloud to the very end of the utterance, including any short trailing words; never leave the final part unspoken\./,
  );
  await controller.stop("user-stop");
});

class PendingStartClient extends EventEmitter {
  closed = false;
  #rejectStart;

  start() {
    return new Promise((_, reject) => {
      this.#rejectStart = reject;
    });
  }

  async close() {
    this.closed = true;
    this.#rejectStart?.(new Error("client closed"));
  }
}

test("Stop and Restart create fresh GPT-Live clients and threads", async () => {
  const evidenceDirectory = await mkdtemp(
    join(tmpdir(), "translive-controller-restart-"),
  );
  const clients = [];
  const controller = controllerFor({
    evidenceDirectory,
    createClient: () => {
      const client = new PromptClient();
      clients.push(client);
      return client;
    },
  });

  for (let cycle = 0; cycle < 5; cycle += 1) {
    await controller.start(validConfig());
    await controller.stop("user-stop");
  }

  assert.equal(clients.length, 5);
  for (const client of clients) {
    assert.equal(client.realtimeStarts.length, 2);
    assert.equal(client.threadNumber, 2);
  }
});

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
  assert.match(result.instructions.note, /完全結束.*還原/i);
});

test("media mode creates only the RX realtime session", async () => {
  const evidenceDirectory = await mkdtemp(
    join(tmpdir(), "translive-controller-media-mode-"),
  );
  const { tx: _tx, ...config } = validConfig({ mode: "media" });
  const events = [];
  const controller = controllerFor({
    evidenceDirectory,
    publish: (event) => events.push(event),
  });

  const result = await controller.start(config);
  assert.deepEqual(result.status, { tx: "disabled", rx: "connecting" });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(
    events
      .filter((event) => event.type === "sdp")
      .map((event) => event.direction),
    ["rx"],
  );
  await controller.answerApplied("rx");
  assert.equal(result.aggregate, "connecting");
  assert.deepEqual(controller.status(), { tx: "disabled", rx: "live" });
  await controller.stop("user-stop");
  const [file] = await readdir(evidenceDirectory);
  const evidence = JSON.parse(
    await readFile(join(evidenceDirectory, file), "utf8"),
  );
  assert.deepEqual(
    evidence.endpoints.map((endpoint) => endpoint.role),
    ["cableBRecordingSource", "headphonesSink"],
  );
});

test("microphone mode creates only the TX realtime session", async () => {
  const evidenceDirectory = await mkdtemp(
    join(tmpdir(), "translive-controller-microphone-mode-"),
  );
  const {
    rx: _rx,
    headphonesConfirmed: _headphonesConfirmed,
    ...config
  } = validConfig({ mode: "microphone" });
  const events = [];
  const controller = controllerFor({
    evidenceDirectory,
    publish: (event) => events.push(event),
  });

  const result = await controller.start(config);
  assert.deepEqual(result.status, { tx: "connecting", rx: "disabled" });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(
    events
      .filter((event) => event.type === "sdp")
      .map((event) => event.direction),
    ["tx"],
  );
  await controller.answerApplied("tx");
  assert.deepEqual(controller.status(), { tx: "live", rx: "disabled" });
  await controller.stop("user-stop");
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

  const result = await controller.start(validConfig({ platform: "zoom" }));
  assert.deepEqual(result.status, { tx: "connecting", rx: "connecting" });
  assert.equal(result.aggregate, "connecting");

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(events.filter((event) => event.type === "sdp").length, 2);
  assert.equal(
    events.some((event) => event.type === "speech-fallback"),
    false,
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
  assert.equal(evidence.route.platform, "zoom");
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

test("uses the same target-only RX path when the source is already Chinese", async () => {
  const evidenceDirectory = await mkdtemp(
    join(tmpdir(), "translive-controller-chinese-target-"),
  );
  const events = [];
  const controller = controllerFor({
    evidenceDirectory,
    publish: (event) => events.push(event),
  });

  await controller.start(
    validConfig({ rx: { sdp: "fixture-chinese-target" } }),
  );
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(
    events.some(
      (event) =>
        event.type === "transcript" &&
        event.direction === "rx" &&
        event.role === "user" &&
        event.text === "這是中文輸入。",
    ),
    true,
  );
  assert.equal(
    events.some((event) => event.type === "speech-fallback"),
    false,
  );
  assert.equal(
    events.some((event) => event.type === "rx-language"),
    false,
  );

  await controller.stop("user-stop");
});

test("persists final source and target transcript entries only after audio stop", async () => {
  const evidenceDirectory = await mkdtemp(
    join(tmpdir(), "translive-controller-records-"),
  );
  const saved = [];
  const controller = controllerFor({
    evidenceDirectory,
    records: {
      saveSession: async (record) => saved.push(record),
    },
  });

  await controller.start(
    validConfig({ rx: { sdp: "fixture-chinese-target" } }),
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(saved.length, 0);

  await controller.stop("user-stop");

  assert.equal(saved.length, 1);
  assert.equal(
    saved[0].entries.some((entry) => entry.side === "source"),
    true,
  );
  assert.equal(
    saved[0].entries.some((entry) => entry.side === "target"),
    true,
  );
  assert.equal(saved[0].metadata.mode, "meeting");
  assert.doesNotMatch(JSON.stringify(saved[0]), /fixture-offer|audio|sdp/i);
});

test("drains a final transcript tail before publishing the saved record path", async () => {
  const evidenceDirectory = await mkdtemp(
    join(tmpdir(), "translive-controller-tail-"),
  );
  const saved = [];
  const events = [];
  const controller = controllerFor({
    evidenceDirectory,
    publish: (event) => events.push(event),
    records: {
      async saveSession(record) {
        saved.push(record);
        return {
          ...record.metadata,
          id: record.id,
          path: "/safe/records/session-tail",
        };
      },
    },
  });

  await controller.start(
    validConfig({
      tx: { sdp: "fixture-tail" },
      rx: { sdp: "fixture-tail" },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  await controller.stop("user-stop");

  assert.equal(
    saved[0].entries.some((entry) => entry.text === "尾端逐字稿。"),
    true,
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === "record")
      .map((event) => ({ state: event.state, path: event.path })),
    [{ state: "saved", path: "/safe/records/session-tail" }],
  );
});

test("does not swallow a transcript save failure after a bounded tail drain", async () => {
  const evidenceDirectory = await mkdtemp(
    join(tmpdir(), "translive-controller-record-failure-"),
  );
  const events = [];
  const controller = controllerFor({
    evidenceDirectory,
    publish: (event) => events.push(event),
    records: {
      async saveSession() {
        throw new Error("disk unavailable");
      },
    },
  });

  await controller.start(validConfig());
  await new Promise((resolve) => setTimeout(resolve, 80));
  await assert.rejects(controller.stop("user-stop"), /disk unavailable/);
  assert.equal(
    events.some((event) => event.type === "record" && event.state === "failed"),
    true,
  );
});

test("cancels a main-side startup during runtime preflight without opening an app-server", async () => {
  const evidenceDirectory = await mkdtemp(
    join(tmpdir(), "translive-controller-cancel-preflight-"),
  );
  let resolveRuntime;
  let createClientCalls = 0;
  const controller = controllerFor({
    evidenceDirectory,
    createClient: () => {
      createClientCalls++;
      return new PendingStartClient();
    },
    inspectRuntime: () =>
      new Promise((resolve) => {
        resolveRuntime = resolve;
      }),
  });

  const start = controller.start(validConfig());
  await new Promise((resolve) => setImmediate(resolve));
  await controller.cancelStart();
  resolveRuntime({
    executable: process.execPath,
    version: `node ${process.versions.node}`,
    semanticVersion: process.versions.node,
    loggedIn: true,
  });

  await assert.rejects(start, { name: "AbortError" });
  assert.equal(createClientCalls, 0);
});

test("cancels a main-side startup before a delayed app-server starts", async () => {
  const evidenceDirectory = await mkdtemp(
    join(tmpdir(), "translive-controller-cancel-start-"),
  );
  const client = new PendingStartClient();
  const controller = controllerFor({
    evidenceDirectory,
    createClient: () => client,
  });

  const start = controller.start(validConfig());
  await new Promise((resolve) => setImmediate(resolve));
  const result = await controller.cancelStart();

  assert.deepEqual(result, { canceled: true });
  await assert.rejects(start, { name: "AbortError" });
  assert.equal(client.closed, true);
  assert.deepEqual(controller.status(), { tx: "stopped", rx: "stopped" });
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

test("evidence keeps a content-free ring of the RX realtime stream", async () => {
  const evidenceDirectory = await mkdtemp(
    join(tmpdir(), "translive-controller-notes-"),
  );
  const client = new PacingClient();
  const controller = controllerFor({
    evidenceDirectory,
    createClient: () => client,
  });
  const { tx: _tx, ...media } = validConfig({ mode: "media" });

  await controller.start(media);
  client.itemStarted("translation-1");
  client.itemDelta("translation-1", "第一段完成。");
  client.itemCompleted("translation-1", "assistant", "第一段完成。");
  await controller.stop("user-stop");

  const [file] = await readdir(evidenceDirectory);
  const evidence = JSON.parse(
    await readFile(join(evidenceDirectory, file), "utf8"),
  );
  const notes = evidence.realtimeNotes.rx;
  const kinds = notes.map((note) => note.kind);
  assert.ok(kinds.includes("item/started"));
  assert.ok(kinds.includes("item/transcript/delta"));
  assert.ok(kinds.includes("item/completed"));
  const completed = notes.find((note) => note.kind === "item/completed");
  assert.equal(completed.role, "assistant");
  assert.equal(completed.textLength, 6);
  for (const note of notes) assert.equal("text" in note, false);
});

test("RX speech is native-only: nothing is ever appendSpeech'd, and a cumulative turn echo cannot repeat captions", async () => {
  const evidenceDirectory = await mkdtemp(
    join(tmpdir(), "translive-controller-native-rx-"),
  );
  const client = new PacingClient();
  const controller = controllerFor({
    evidenceDirectory,
    createClient: () => client,
  });
  const { tx: _tx, ...media } = validConfig({ mode: "media" });

  await controller.start(media);
  client.itemStarted("translation-1");
  client.itemDelta("translation-1", "能夠幫我翻譯成英文。");
  client.itemCompleted("translation-1", "assistant", "能夠幫我翻譯成英文。");

  // Captured wire shape: the upstream turn.done re-reports the accumulated
  // assistant text, verbatim and repeatedly, while the source stays silent.
  client.itemStarted("turn-done-1");
  client.itemCompleted("turn-done-1", "assistant", "能夠幫我翻譯成英文。");
  client.itemStarted("turn-done-2");
  client.itemCompleted("turn-done-2", "assistant", "能夠幫我翻譯成英文。");
  await new Promise((resolve) => setImmediate(resolve));

  // Nothing is ever re-injected into the session, so no echo loop can start.
  assert.deepEqual(client.appendRequests, []);
  await controller.stop("user-stop");
});

test("RX target transcripts publish immediately like TX, with no pacing layer", async () => {
  const evidenceDirectory = await mkdtemp(
    join(tmpdir(), "translive-controller-immediate-rx-"),
  );
  const events = [];
  const client = new PacingClient();
  const controller = controllerFor({
    evidenceDirectory,
    createClient: () => client,
    publish: (event) => events.push(event),
  });
  const { tx: _tx, ...media } = validConfig({ mode: "media" });

  await controller.start(media);
  client.itemStarted("translation-1");
  client.itemDelta("translation-1", "第一段");
  client.itemDelta("translation-1", "第一段完成。");
  client.itemCompleted("translation-1", "assistant", "第一段完成。");
  await new Promise((resolve) => setImmediate(resolve));

  const targets = events.filter(
    (event) => event.type === "transcript" && event.role === "assistant",
  );
  assert.ok(targets.length >= 2);
  for (const target of targets) {
    assert.equal(target.deferred ?? false, false);
  }
  assert.equal(
    events.some(
      (event) => event.type === "speech-fallback" || event.type === "pacing",
    ),
    false,
  );
  assert.deepEqual(client.appendRequests, []);
  await controller.stop("user-stop");
});

test("indexes the transcript into the shared meeting index on save", async () => {
  const { MeetingIndex } = await import("./meeting-index.js");
  const evidenceDirectory = await mkdtemp(
    join(tmpdir(), "translive-controller-index-"),
  );
  const meetingIndex = new MeetingIndex();
  const controller = controllerFor({
    evidenceDirectory,
    meetingIndex,
    records: {
      saveSession: async (record) => ({
        ...record.metadata,
        id: record.id,
        path: "/safe/records/x",
      }),
      readSession: async (id) => ({
        metadata: { id, mode: "meeting", startedAtMs: 1_700_000_000_000 },
        entries: [
          {
            offsetMs: 1_000,
            direction: "tx",
            side: "source",
            text: "索引預算會議內容",
          },
        ],
      }),
    },
  });

  await controller.start(
    validConfig({ rx: { sdp: "fixture-chinese-target" } }),
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  await controller.stop("user-stop");

  const hits = meetingIndex.search("索引預算");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].tier, "transcript");
});
