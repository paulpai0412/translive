import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import { formatSummaryMarkdown } from "./summary-service.js";
import { sanitizeText } from "./text-sanitizer.js";

// Shared post-meeting job: generate the structured summary in the background,
// persist it, and refresh the search index. Stopping a meeting must never
// block on this — the summary appears in the records page when done.
export function summarizeSessionInBackground({
  records,
  summaryService,
  meetingIndex,
  publish = () => {},
  sessionId,
  now = Date.now,
}) {
  const fail = (error) => {
    const message = sanitizeText(error?.message ?? error, { maxLength: 500 });
    // Background failures must leave a trace — the publish event is transient
    // and the run's evidence file is already written by then.
    const line = `${new Date().toISOString()} session=${sessionId} ${message}\n`;
    void appendFile(
      join(records.directory(), "summary-failures.log"),
      line,
      "utf8",
    ).catch(() => {});
    publish({
      type: "summary",
      state: "failed",
      sessionId,
      background: true,
      message,
    });
  };
  publish({
    type: "summary",
    state: "generating",
    sessionId,
    background: true,
  });
  const run = async () => {
    const saved = await records.readSession(sessionId);
    const sessions = [{ metadata: saved.metadata, entries: saved.entries }];
    const structured = await summaryService.generate({
      kind: "session",
      sessions,
    });
    const sourceSessions = [
      {
        id: sessionId,
        timestamps: saved.entries.map((entry) => entry.offsetMs),
      },
    ];
    const markdown = formatSummaryMarkdown({
      kind: "session",
      modelOutput: structured,
      sourceSessions,
    });
    await records.saveSessionSummary(sessionId, {
      generatedAtMs: now(),
      markdown,
      sourceSessions,
      structured,
    });
    meetingIndex?.indexSession({
      metadata: saved.metadata,
      entries: saved.entries,
      summary: structured,
    });
    publish({ type: "summary", state: "saved", sessionId, background: true });
  };
  void run().catch(fail);
}
