import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RecordsStore } from "./records-store.js";

function sessionInput(overrides = {}) {
  return {
    id: "session-contract",
    metadata: {
      endedAtMs: 10_500,
      languages: {
        rxTarget: "繁體中文（台灣）",
        txSource: "繁體中文（台灣）",
        txTarget: "English",
      },
      mode: "meeting",
      platform: "teams",
      sourceLabels: {
        rx: "Microsoft Teams",
        tx: "Poly BT600 Mic",
      },
      startedAtMs: 10_000,
    },
    entries: [
      {
        atMs: 10_125,
        direction: "rx",
        side: "source",
        text: "We expect to begin production.",
      },
      {
        atMs: 10_480,
        direction: "rx",
        side: "target",
        text: "我們預計開始量產。",
      },
    ],
    ...overrides,
  };
}

test("requires durable explicit consent before plaintext transcript persistence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translive-consent-"));
  const store = new RecordsStore({ directory });

  await assert.rejects(store.saveSession(sessionInput()), /同意|consent/i);
  assert.deepEqual(await store.consentStatus(), { granted: false });
  await assert.rejects(
    store.grantPlaintextConsent({ confirmed: false }),
    /確認/i,
  );
  await store.grantPlaintextConsent({ confirmed: true });

  const freshStore = new RecordsStore({ directory });
  assert.deepEqual(await freshStore.consentStatus(), { granted: true });
  const saved = await freshStore.saveSession(sessionInput());
  assert.equal(saved.durationMs, 500);
  assert.deepEqual(saved.languages, sessionInput().metadata.languages);
  assert.deepEqual(saved.sourceLabels, sessionInput().metadata.sourceLabels);

  const session = await freshStore.readSession(saved.id);
  assert.deepEqual(
    session.entries.map(({ offsetMs, text }) => ({ offsetMs, text })),
    [
      { offsetMs: 125, text: "We expect to begin production." },
      { offsetMs: 480, text: "我們預計開始量產。" },
    ],
  );
  assert.doesNotMatch(JSON.stringify(session), /"atMs"/);
});

test("serializes duplicate saves and never lists an incomplete staging package", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translive-record-atomic-"));
  const store = new RecordsStore({ directory });
  await store.grantPlaintextConsent({ confirmed: true });

  await mkdir(join(directory, "sessions", ".session-orphan-stage"), {
    recursive: true,
  });
  await writeFile(
    join(directory, "sessions", ".session-orphan-stage", "metadata.json"),
    "{}",
  );
  const [first, second] = await Promise.all([
    store.saveSession(sessionInput()),
    store.saveSession(sessionInput()),
  ]);

  assert.equal(first.id, second.id);
  assert.deepEqual(
    (await store.listSessions()).map((session) => session.id),
    ["session-contract"],
  );
});

test("requires typed DELETE for destructive session deletion and exports a safe markdown copy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translive-record-delete-"));
  const store = new RecordsStore({ directory });
  await store.grantPlaintextConsent({ confirmed: true });
  await store.saveSession(
    sessionInput({
      entries: [
        {
          atMs: 10_125,
          direction: "rx",
          side: "source",
          text: "normal line\nv=0\na=candidate:secret",
        },
      ],
    }),
  );

  await assert.rejects(
    store.deleteAllSessions({ confirmation: "delete" }),
    /DELETE/,
  );
  const exported = await store.exportSession("session-contract");
  assert.match(exported.fileName, /^translive-session-contract\.md$/);
  assert.match(exported.markdown, /\[已遮罩的協定內容\]/);
  assert.doesNotMatch(exported.markdown, /normal line|candidate:secret/);

  await store.deleteAllSessions({ confirmation: "DELETE" });
  assert.deepEqual(await store.listSessions(), []);
});

test("bounds plaintext retention and reports actionable local storage status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translive-record-retention-"));
  const store = new RecordsStore({
    directory,
    limits: { maxBytes: 1_000_000, maxSessions: 1 },
  });
  await store.grantPlaintextConsent({ confirmed: true });
  await store.saveSession(sessionInput());

  const status = await store.retentionStatus();
  assert.deepEqual(
    {
      maxBytes: status.maxBytes,
      maxSessions: status.maxSessions,
      sessionCount: status.sessionCount,
    },
    { maxBytes: 1_000_000, maxSessions: 1, sessionCount: 1 },
  );
  assert.ok(status.bytes > 0);

  await assert.rejects(
    store.saveSession(sessionInput({ id: "session-over-limit" })),
    /保存上限|retention/i,
  );
});

test("validates aggregate summary source sessions inside the serialized write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "translive-record-source-"));
  const store = new RecordsStore({ directory });
  await store.grantPlaintextConsent({ confirmed: true });
  await store.saveSession(sessionInput());

  await assert.rejects(
    store.saveAggregateSummary({
      id: "aggregate-missing-source",
      generatedAtMs: 11_000,
      markdown: "# 跨場摘要匯整\n",
      sourceSessions: [
        { id: "session-contract", timestamps: [125] },
        { id: "session-deleted", timestamps: [0] },
      ],
      structured: {},
    }),
    /record data|source session/i,
  );
  assert.deepEqual(await store.listAggregates(), []);
});
