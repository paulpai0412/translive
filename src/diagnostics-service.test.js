import assert from "node:assert/strict";
import test from "node:test";

import { buildDiagnostics, diagnosticMarkdown } from "./diagnostics-service.js";

test("exports only redacted trustworthy diagnostics without transcript or raw session data", () => {
  const bundle = buildDiagnostics({
    accountState: "connected",
    appVersion: "0.1.0-beta.1",
    evidence: {
      app: { version: "0.1.0-beta.1" },
      codex: {
        checksum: "abc123",
        executable: "C:\\Users\\Ada\\secret\\codex.exe",
        version: "codex-cli 0.150.0",
      },
      endpoints: [
        {
          idHash: "deadbeef",
          kind: "audiooutput",
          name: "Ada's Headphones",
          role: "headphonesSink",
        },
      ],
      errors: [
        {
          direction: "rx",
          message: "Authorization: Bearer sk-secret-value",
        },
      ],
      metrics: { rx: { rtt: { count: 1, p50Ms: 138 } }, tx: {} },
      pacing: {
        rx: {
          backlogMs: 1_900,
          lagWarningCount: 1,
          transcript: "不得輸出 pacing transcript",
        },
        tx: {},
      },
      route: {
        mode: "meeting",
        platform: "teams",
        routeProfile: "voicemeeter",
      },
      sessions: { rx: { threadId: "secret-thread" } },
      transcriptTimestamps: [{ text: "不得輸出" }],
    },
    status: { rx: "live", tx: "muted" },
  });

  assert.deepEqual(bundle.channelStates, { rx: "live", tx: "muted" });
  assert.deepEqual(bundle.endpoints, [
    { idHash: "deadbeef", kind: "audiooutput", role: "headphonesSink" },
  ]);
  assert.equal(bundle.codex.checksum, "abc123");
  assert.deepEqual(bundle.pacing, {
    rx: { backlogMs: 1_900, lagWarningCount: 1 },
  });
  const serialized = JSON.stringify(bundle);
  assert.doesNotMatch(
    serialized,
    /Ada|secret-thread|sk-secret-value|Authorization|不得輸出|codex\.exe/i,
  );
  assert.match(serialized, /已遮罩的敏感內容/);
  assert.match(diagnosticMarkdown(bundle), /TransLive 遮罩診斷包/);
});
