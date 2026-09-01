import { randomUUID } from "node:crypto";

import {
  formatSummaryMarkdown,
  prepareSummarySessions,
} from "./summary-service.js";

function abortError() {
  const error = new Error("Summary generation canceled");
  error.name = "AbortError";
  return error;
}

function assertConfirmed(confirmed) {
  if (confirmed !== true) {
    throw new Error("必須確認後才能將逐字稿送至摘要模型");
  }
}

function sourceSessions(sessions) {
  return sessions.map((session) => ({
    id: session.metadata.id,
    timestamps: session.entries.map((entry) => entry.offsetMs ?? entry.atMs),
  }));
}

export class SummaryController {
  #completed = new Map();
  #now;
  #operations = new Map();
  #publish;
  #records;
  #summaryService;
  #meetingIndex;

  constructor({
    records,
    summaryService,
    now = Date.now,
    publish = () => {},
    meetingIndex,
  }) {
    this.#records = records;
    this.#summaryService = summaryService;
    this.#now = now;
    this.#publish = publish;
    this.#meetingIndex = meetingIndex;
  }

  async startSessionSummary({ sessionId, confirmed }) {
    assertConfirmed(confirmed);
    const session = await this.#records.readSession(sessionId);
    return this.#start({ kind: "session", sessions: [session] });
  }

  async startAggregateSummary({ sessionIds, confirmed }) {
    assertConfirmed(confirmed);
    const requestedIds = Array.isArray(sessionIds) ? sessionIds : [];
    const uniqueIds = [...new Set(requestedIds)];
    if (uniqueIds.length < 2) {
      throw new Error("至少選擇 2 場紀錄才能匯整摘要");
    }
    const sessions = await Promise.all(
      uniqueIds.map((sessionId) => this.#records.readSession(sessionId)),
    );
    return this.#start({
      kind: "aggregate",
      sessions: prepareSummarySessions(sessions),
    });
  }

  cancel(requestId) {
    const operation = this.#operations.get(requestId);
    if (!operation) return { requestId, state: "not-found" };
    operation.abortController.abort();
    this.#publish({ type: "summary", requestId, state: "canceling" });
    return { requestId, state: "canceling" };
  }

  wait(requestId) {
    const operation =
      this.#operations.get(requestId) ?? this.#completed.get(requestId);
    if (!operation) throw new Error("找不到摘要請求");
    return operation.promise;
  }

  async dispose() {
    for (const operation of this.#operations.values()) {
      operation.abortController.abort();
    }
    await Promise.allSettled(
      [...this.#operations.values()].map((operation) => operation.promise),
    );
  }

  #start({ kind, sessions }) {
    const requestId = randomUUID();
    const abortController = new AbortController();
    const operation = { abortController, promise: undefined };
    this.#operations.set(requestId, operation);
    this.#publish({ type: "summary", requestId, state: "generating", kind });

    operation.promise = this.#generate({
      abortController,
      kind,
      previousSessionSummary:
        kind === "session" ? sessions[0].summary : undefined,
      requestId,
      sessions: prepareSummarySessions(sessions),
    }).finally(() => {
      this.#operations.delete(requestId);
      this.#completed.set(requestId, operation);
      if (this.#completed.size > 50) {
        this.#completed.delete(this.#completed.keys().next().value);
      }
    });
    // Renderer normally observes lifecycle via publish rather than wait().
    // Keep cancellations/failures from becoming unhandled promise rejections.
    operation.promise.catch(() => {});
    return { requestId, state: "generating", kind };
  }

  async #rollbackPersistedSummary({ kind, previousSessionSummary, summaryId }) {
    if (kind === "aggregate") {
      await this.#records.deleteAggregate(summaryId);
      return;
    }
    if (previousSessionSummary) {
      await this.#records.saveSessionSummary(summaryId, {
        generatedAtMs: previousSessionSummary.metadata.generatedAtMs,
        markdown: previousSessionSummary.markdown,
        sourceSessions: previousSessionSummary.metadata.sourceSessions,
        structured: previousSessionSummary.structured,
      });
      return;
    }
    await this.#records.deleteSessionSummary(summaryId);
  }

  async #generate({
    abortController,
    kind,
    previousSessionSummary,
    requestId,
    sessions,
  }) {
    const sources = sourceSessions(sessions);
    try {
      const structured = await this.#summaryService.generate({
        kind,
        sessions,
        signal: abortController.signal,
      });
      if (abortController.signal.aborted) throw abortError();
      const markdown = formatSummaryMarkdown({
        kind,
        modelOutput: structured,
        sourceSessions: sources,
      });
      const generatedAtMs = this.#now();
      let summaryId;
      if (kind === "session") {
        summaryId = sessions[0].metadata.id;
        await this.#records.saveSessionSummary(summaryId, {
          generatedAtMs,
          markdown,
          sourceSessions: sources,
          structured,
        });
      } else {
        summaryId = randomUUID();
        await this.#records.saveAggregateSummary({
          id: summaryId,
          generatedAtMs,
          markdown,
          sourceSessions: sources,
          structured,
        });
      }
      if (abortController.signal.aborted) {
        await this.#rollbackPersistedSummary({
          kind,
          previousSessionSummary,
          summaryId,
        });
        throw abortError();
      }
      if (kind === "session" && this.#meetingIndex) {
        // Keep the search index's summary tier in sync for assistant Q&A.
        try {
          const record = await this.#records.readSession(summaryId);
          this.#meetingIndex.indexSession({
            metadata: record.metadata,
            entries: record.entries,
            summary: record.summary?.structured,
          });
        } catch {
          // Indexing is a read-side concern; never fail the summary itself.
        }
      }
      const result = { requestId, state: "completed", kind, summaryId };
      this.#publish({ type: "summary", ...result });
      return result;
    } catch (error) {
      if (error?.name === "AbortError" || abortController.signal.aborted) {
        this.#publish({ type: "summary", requestId, state: "canceled", kind });
        throw abortError();
      }
      this.#publish({ type: "summary", requestId, state: "failed", kind });
      throw new Error("無法產生摘要");
    }
  }
}
