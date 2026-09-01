import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CodexAppServer } from "./codex-app-server.js";
import { CodexTextTurn } from "./codex-text-turn.js";
import { MeetingAssistantController } from "./meeting-assistant-controller.js";
import { MeetingIndex } from "./meeting-index.js";
import { RecordsStore } from "./records-store.js";
import { CodexSummaryService } from "./summary-service.js";

const fixture = fileURLToPath(
  new URL("../fixtures/fake-codex-app-server.mjs", import.meta.url),
);

function rendererConfig() {
  // Exactly what the renderer sends for assistant mode.
  return {
    platform: "teams",
    routeProfile: "vb-cable",
    mode: "assistant",
    headphonesConfirmed: false,
    persistTranscript: true,
    autoSummary: true,
    wakePhrase: "小泥小泥",
    qaSdp: "v=0\r\nfixture-qa",
    tx: {
      sourceEndpointId: "mic",
      sourceEndpointName: "Physical Microphone",
      sourceEndpointKind: "audioinput",
      sinkEndpointId: "cable-a",
      sinkEndpointName: "Cable-A Input",
      sinkEndpointKind: "audiooutput",
      sdp: "fixture-assistant-wake",
    },
    rx: {
      sourceEndpointId: "cable-b",
      sourceEndpointName: "Cable-B Output",
      sourceEndpointKind: "audioinput",
      sinkEndpointId: "unused",
      sinkEndpointName: "Unused Output",
      sinkEndpointKind: "audiooutput",
      sdp: "v=0\r\nfixture-offer",
    },
  };
}

async function waitForEvent(published, type, timeoutMs = 10_000) {
  const started = Date.now();
  for (;;) {
    const event = published.find((entry) => entry.type === type);
    if (event) return event;
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `Timed out waiting for ${type}; saw ${published.map((entry) => entry.type).join(",")}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("assistant mode end-to-end over the real app-server transport", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-e2e-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const records = new RecordsStore({ directory: join(directory, "records") });
  await records.grantPlaintextConsent({ confirmed: true });
  const meetingIndex = new MeetingIndex();
  meetingIndex.indexSession({
    metadata: {
      id: "past-1",
      mode: "meeting-assistant",
      startedAtMs: Date.parse("2026-08-30T09:00:00+08:00"),
    },
    entries: [
      {
        offsetMs: 1_000,
        direction: "tx",
        side: "source",
        text: "Q3 預算多少錢?答案是十萬元。",
      },
    ],
  });

  const createClient = () =>
    new CodexAppServer({
      executable: process.execPath,
      args: [fixture],
      cwd: directory,
    });
  const published = [];
  const controller = new MeetingAssistantController({
    appVersion: "e2e-test",
    answer: (prompt) => new CodexTextTurn({ createClient }).run(prompt),
    codexExecutable: process.execPath,
    codexArgs: [fixture],
    cwd: directory,
    evidenceDirectory: join(directory, "evidence"),
    inspectRuntime: async () => ({
      executable: process.execPath,
      version: "fixture",
      semanticVersion: "0.145.0",
      loggedIn: true,
    }),
    meetingIndex,
    publish: (event) => published.push(event),
    records,
    summaryService: new CodexSummaryService({ createClient }),
  });

  await controller.start(rendererConfig());
  assert.equal(controller.isActive(), true);

  // Renderer applies every SDP answer, then reports each channel.
  for (const _direction of ["tx", "rx", "qa"]) {
    await waitForEvent(published, "sdp");
  }
  const txApplied = await controller.answerApplied("tx");
  const rxApplied = await controller.answerApplied("rx");
  assert.ok(txApplied.aggregate);
  assert.ok(rxApplied.aggregate);

  // The fixture injects a wake phrase on tx; the pipeline should retrieve the
  // seeded past meeting, produce a spoken-style answer, and hold for review.
  const pending = await waitForEvent(published, "qa-pending");
  assert.equal(pending.answer.text, "預算是十萬元。");

  await controller.approveAnswer(pending.answer.id);
  await waitForEvent(published, "qa-sent");

  await controller.stop("user-stop");
  // summary runs in the background; wait for the terminal event
  const startedWait = Date.now();
  while (
    !published.some(
      (entry) => entry.type === "summary" && ["saved", "failed"].includes(entry.state),
    ) &&
    Date.now() - startedWait < 10_000
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const sessions = await records.listSessions();
  assert.equal(sessions.length, 1);
  const record = await records.readSession(sessions[0].id);
  assert.equal(record.metadata.mode, "meeting-assistant");
  assert.equal(record.metadata.hasSummary, true);
  assert.ok(
    record.entries.some(
      (entry) => entry.direction === "tx" && entry.text.includes("小泥小泥"),
    ),
  );

  // Both the seeded past meeting and the new summary tier are searchable.
  const hits = meetingIndex.search("預算多少");
  assert.ok(hits.some((hit) => hit.sessionId === "past-1"));
  const summaryHits = meetingIndex.search("預算核定");
  assert.ok(
    summaryHits.some(
      (hit) => hit.tier === "summary" && hit.sessionId === sessions[0].id,
    ),
  );

  const evidenceFiles = await readdir(join(directory, "evidence"));
  assert.ok(evidenceFiles.some((name) => name.endsWith(".json")));
});
