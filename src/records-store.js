import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { sanitizeText } from "./text-sanitizer.js";

const CONSENT_VERSION = 1;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MODES = new Set(["meeting", "media", "microphone", "meeting-assistant"]);
const PLATFORMS = new Set(["teams", "zoom", "custom"]);
const PACKAGE_SCHEMA_VERSION = 1;
const PACKAGE_OVERHEAD_BYTES = 1_024;
const DEFAULT_RETENTION_LIMITS = Object.freeze({
  maxBytes: 250 * 1024 * 1024,
  maxSessions: 100,
});

function normalizedRetentionLimits(limits = {}) {
  const maxBytes = Number.isSafeInteger(limits.maxBytes)
    ? limits.maxBytes
    : DEFAULT_RETENTION_LIMITS.maxBytes;
  const maxSessions = Number.isSafeInteger(limits.maxSessions)
    ? limits.maxSessions
    : DEFAULT_RETENTION_LIMITS.maxSessions;
  if (maxBytes <= 0 || maxSessions <= 0) {
    throw new Error("Retention limits must be positive");
  }
  return { maxBytes, maxSessions };
}

function packageBytes(files) {
  return (
    PACKAGE_OVERHEAD_BYTES +
    Object.values(files).reduce(
      (total, content) => total + Buffer.byteLength(content, "utf8"),
      0,
    )
  );
}

function assertIdentifier(id, label = "Record") {
  if (!ID_PATTERN.test(String(id))) {
    throw new Error(`${label} identifier is invalid`);
  }
  return String(id);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function formatOffset(offsetMs) {
  const totalMilliseconds = Math.max(0, Math.round(offsetMs));
  const minutes = Math.floor(totalMilliseconds / 60_000);
  const seconds = Math.floor((totalMilliseconds % 60_000) / 1_000);
  const milliseconds = totalMilliseconds % 1_000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

function normalizedLabel(value, fallback) {
  const text = sanitizeText(value, { maxLength: 256 }).trim();
  return text || fallback;
}

function safeTime(value, label) {
  if (!Number.isFinite(value)) throw new Error(`${label} must be a timestamp`);
  return Math.round(value);
}

function normalizedLanguages(value) {
  const languages = value && typeof value === "object" ? value : {};
  return {
    rxTarget: normalizedLabel(languages.rxTarget, "繁體中文（台灣）"),
    txSource: normalizedLabel(languages.txSource, "未指定"),
    txTarget: normalizedLabel(languages.txTarget, "未指定"),
  };
}

function normalizedSourceLabels(value) {
  const labels = value && typeof value === "object" ? value : {};
  return {
    rx: normalizedLabel(labels.rx, "未指定來源"),
    tx: normalizedLabel(labels.tx, "未指定來源"),
  };
}

function sessionMetadata(id, metadata, entryCount, hasSummary = false) {
  const startedAtMs = safeTime(metadata?.startedAtMs, "Session startedAtMs");
  const endedAtMs = safeTime(metadata?.endedAtMs, "Session endedAtMs");
  return {
    id: assertIdentifier(id, "Session"),
    mode: MODES.has(metadata?.mode) ? metadata.mode : "meeting",
    platform: PLATFORMS.has(metadata?.platform) ? metadata.platform : "custom",
    startedAtMs,
    endedAtMs,
    durationMs: Math.max(0, endedAtMs - startedAtMs),
    languages: normalizedLanguages(metadata?.languages),
    sourceLabels: normalizedSourceLabels(metadata?.sourceLabels),
    entryCount,
    hasSummary: Boolean(hasSummary),
  };
}

function transcriptEntry(value, startedAtMs) {
  if (
    !Number.isFinite(value?.atMs) ||
    !["tx", "rx"].includes(value?.direction) ||
    !["source", "target"].includes(value?.side) ||
    typeof value?.text !== "string" ||
    value.text.trim().length === 0
  ) {
    throw new Error("Invalid transcript entry");
  }
  return {
    offsetMs: Math.max(0, Math.round(value.atMs) - startedAtMs),
    direction: value.direction,
    side: value.side,
    text: sanitizeText(value.text, { maxLength: 50_000 }),
  };
}

function transcriptMarkdown(metadata, entries) {
  const platform =
    { teams: "Teams", zoom: "Zoom", custom: "TransLive" }[metadata.platform] ??
    "TransLive";
  const lines = [
    `# ${platform} 逐字稿`,
    "",
    `模式：${metadata.mode}`,
    `時長：${formatOffset(metadata.durationMs)}`,
    `來源：TX ${metadata.sourceLabels.tx}；RX ${metadata.sourceLabels.rx}`,
    "",
  ];
  for (const entry of entries) {
    const label = entry.side === "source" ? "來源" : "翻譯";
    lines.push(
      `- [${formatOffset(entry.offsetMs)}] ${entry.direction.toUpperCase()} · ${label}：${entry.text}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function summaryMetadata(metadata) {
  const id = assertIdentifier(metadata?.id, "Summary");
  const sourceInputs = Array.isArray(metadata?.sourceSessions)
    ? metadata.sourceSessions
    : [];
  const sourceSessions = sourceInputs.map((source) => {
    const timestampInputs = Array.isArray(source?.timestamps)
      ? source.timestamps
      : [];
    return {
      id: assertIdentifier(source?.id, "Source session"),
      timestamps: timestampInputs.map((timestamp) =>
        safeTime(timestamp, "Source timestamp"),
      ),
    };
  });
  if (sourceSessions.length === 0) {
    throw new Error("Summary requires source session references");
  }
  return {
    id,
    kind: metadata?.kind === "aggregate" ? "aggregate" : "session",
    generatedAtMs: safeTime(metadata?.generatedAtMs, "Summary generatedAtMs"),
    sourceSessions,
  };
}

async function readJson(
  path,
  message = "Record data is unavailable or invalid",
) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(message);
  }
}

export class RecordsStore {
  #directory;
  #limits;
  #mutationQueue = Promise.resolve();
  #now;

  constructor({ directory, limits, now = Date.now }) {
    this.#directory = directory;
    this.#limits = normalizedRetentionLimits(limits);
    this.#now = now;
  }

  directory() {
    return this.#directory;
  }

  async consentStatus() {
    try {
      const consent = await readJson(this.#consentPath());
      return {
        granted: consent.version === CONSENT_VERSION && consent.grantedAtMs > 0,
      };
    } catch {
      return { granted: false };
    }
  }

  async retentionStatus() {
    const [sessions, bytes] = await Promise.all([
      this.#listPackages(this.#sessionsDirectory(), "session"),
      this.#storageBytes(),
    ]);
    return {
      bytes,
      maxBytes: this.#limits.maxBytes,
      maxSessions: this.#limits.maxSessions,
      sessionCount: sessions.length,
    };
  }

  async grantPlaintextConsent({ confirmed }) {
    if (confirmed !== true) {
      throw new Error("必須明確確認後才能保存明文逐字稿");
    }
    await this.#atomicFile(
      this.#consentPath(),
      `${JSON.stringify(
        { version: CONSENT_VERSION, grantedAtMs: this.#now() },
        null,
        2,
      )}\n`,
    );
    return { granted: true };
  }

  async saveSession({ id, metadata, entries }) {
    const sessionId = assertIdentifier(id, "Session");
    return this.#serialize(`session:${sessionId}`, async () => {
      await this.#assertPlaintextConsent();
      if (!Array.isArray(entries)) {
        throw new Error("Transcript entries are required");
      }
      const startedAtMs = safeTime(
        metadata?.startedAtMs,
        "Session startedAtMs",
      );
      const normalizedEntries = entries.map((entry) =>
        transcriptEntry(entry, startedAtMs),
      );
      const normalizedMetadata = sessionMetadata(
        sessionId,
        metadata,
        normalizedEntries.length,
      );
      const files = {
        "metadata.json": `${JSON.stringify(normalizedMetadata, null, 2)}\n`,
        "transcript.json": `${JSON.stringify(normalizedEntries, null, 2)}\n`,
        "transcript.md": transcriptMarkdown(
          normalizedMetadata,
          normalizedEntries,
        ),
      };
      const contentHash = digest(JSON.stringify(files));
      const existing = await this.#readPackage(
        this.#sessionsDirectory(),
        sessionId,
        "session",
        { optional: true },
      );
      if (existing) {
        if (existing.manifest.contentHash === contentHash) {
          return { ...existing.metadata, path: this.sessionFolder(sessionId) };
        }
        throw new Error(
          "Session already exists with different transcript data",
        );
      }
      await this.#assertRetention({
        additionalBytes: packageBytes(files),
        additionalSessions: 1,
      });
      await this.#writePackage({
        parent: this.#sessionsDirectory(),
        id: sessionId,
        kind: "session",
        files,
        contentHash,
      });
      return { ...normalizedMetadata, path: this.sessionFolder(sessionId) };
    });
  }

  async listSessions() {
    const sessions = await this.#listPackages(
      this.#sessionsDirectory(),
      "session",
    );
    return Promise.all(
      sessions.map(async ({ manifest, metadata }) => {
        const summary = await this.#readPackage(
          this.#summariesDirectory(),
          this.#sessionSummaryPackageId(manifest.id ?? metadata.id),
          "session-summary",
          { optional: true },
        );
        return { ...metadata, hasSummary: Boolean(summary) };
      }),
    );
  }

  async readSession(id) {
    const sessionId = assertIdentifier(id, "Session");
    const packageData = await this.#readPackage(
      this.#sessionsDirectory(),
      sessionId,
      "session",
    );
    const entries = await readJson(join(packageData.folder, "transcript.json"));
    const summary = await this.#readSummaryPackage(
      this.#sessionSummaryPackageId(sessionId),
      "session-summary",
      { optional: true },
    );
    return {
      metadata: { ...packageData.metadata, hasSummary: Boolean(summary) },
      entries,
      summary,
    };
  }

  async saveSessionSummary(
    id,
    { generatedAtMs, markdown, sourceSessions, structured },
  ) {
    const sessionId = assertIdentifier(id, "Session");
    return this.#serialize(`summary:${sessionId}`, async () => {
      await this.#readPackage(this.#sessionsDirectory(), sessionId, "session");
      const summary = summaryMetadata({
        id: sessionId,
        kind: "session",
        generatedAtMs,
        sourceSessions,
      });
      await this.#assertSummarySourcesExist(summary.sourceSessions);
      return this.#saveSummaryPackage({
        packageId: this.#sessionSummaryPackageId(sessionId),
        kind: "session-summary",
        summary,
        markdown,
        structured,
      });
    });
  }

  async saveAggregateSummary({
    id,
    generatedAtMs,
    markdown,
    sourceSessions,
    structured,
  }) {
    const aggregateId = assertIdentifier(id, "Aggregate");
    return this.#serialize(`aggregate:${aggregateId}`, async () => {
      const summary = summaryMetadata({
        id: aggregateId,
        kind: "aggregate",
        generatedAtMs,
        sourceSessions,
      });
      await this.#assertSummarySourcesExist(summary.sourceSessions);
      return this.#saveSummaryPackage({
        packageId: this.#aggregateSummaryPackageId(aggregateId),
        kind: "aggregate-summary",
        summary,
        markdown,
        structured,
      });
    });
  }

  async deleteSessionSummary(id) {
    const sessionId = assertIdentifier(id, "Session");
    await this.#serialize(`summary:${sessionId}`, () =>
      rm(this.#summaryFolder(this.#sessionSummaryPackageId(sessionId)), {
        force: true,
        recursive: true,
      }),
    );
  }

  async listAggregates() {
    const aggregates = await this.#listPackages(
      this.#summariesDirectory(),
      "aggregate-summary",
    );
    return aggregates.map(({ metadata }) => metadata);
  }

  async readAggregate(id) {
    return this.#readSummaryPackage(
      this.#aggregateSummaryPackageId(assertIdentifier(id, "Aggregate")),
      "aggregate-summary",
    );
  }

  async deleteSession(id) {
    const sessionId = assertIdentifier(id, "Session");
    await this.#serialize(`session:${sessionId}`, async () => {
      const aggregates = await this.#listPackages(
        this.#summariesDirectory(),
        "aggregate-summary",
      );
      const dependentAggregates = aggregates.filter(({ metadata }) =>
        metadata.sourceSessions?.some((source) => source.id === sessionId),
      );
      await Promise.all([
        rm(this.sessionFolder(sessionId), { force: true, recursive: true }),
        rm(this.#summaryFolder(this.#sessionSummaryPackageId(sessionId)), {
          force: true,
          recursive: true,
        }),
        ...dependentAggregates.map(({ folder }) =>
          rm(folder, { force: true, recursive: true }),
        ),
      ]);
    });
  }

  async deleteAggregate(id) {
    const aggregateId = assertIdentifier(id, "Aggregate");
    await this.#serialize(`aggregate:${aggregateId}`, () =>
      rm(this.#summaryFolder(this.#aggregateSummaryPackageId(aggregateId)), {
        force: true,
        recursive: true,
      }),
    );
  }

  async deleteAllSessions({ confirmation }) {
    if (confirmation !== "DELETE") {
      throw new Error("請輸入 DELETE 才能刪除全部紀錄");
    }
    await this.#serialize("delete-all", async () => {
      await Promise.all([
        rm(this.#sessionsDirectory(), { force: true, recursive: true }),
        rm(this.#summariesDirectory(), { force: true, recursive: true }),
      ]);
    });
  }

  async exportSession(id) {
    const session = await this.readSession(id);
    return {
      fileName: `translive-${session.metadata.id}.md`,
      markdown: transcriptMarkdown(session.metadata, session.entries),
    };
  }

  async exportAggregate(id) {
    const aggregate = await this.readAggregate(id);
    return {
      fileName: `translive-aggregate-${aggregate.metadata.id}.md`,
      markdown: sanitizeText(aggregate.markdown, { maxLength: 100_000 }),
    };
  }

  sessionFolder(id) {
    return join(this.#sessionsDirectory(), assertIdentifier(id, "Session"));
  }

  aggregateFolder(id) {
    return this.#summaryFolder(
      this.#aggregateSummaryPackageId(assertIdentifier(id, "Aggregate")),
    );
  }

  async #assertSummarySourcesExist(sourceSessions) {
    for (const source of sourceSessions) {
      await this.#readPackage(
        this.#sessionsDirectory(),
        assertIdentifier(source.id, "Source session"),
        "session",
      );
    }
  }

  async #saveSummaryPackage({
    packageId,
    kind,
    summary,
    markdown,
    structured,
  }) {
    const safeMarkdown = sanitizeText(markdown, { maxLength: 100_000 });
    const files = {
      "metadata.json": `${JSON.stringify(summary, null, 2)}\n`,
      "summary.md": safeMarkdown.endsWith("\n")
        ? safeMarkdown
        : `${safeMarkdown}\n`,
      "summary.json": `${JSON.stringify(structured ?? {}, null, 2)}\n`,
    };
    const contentHash = digest(JSON.stringify(files));
    const existing = await this.#readPackage(
      this.#summariesDirectory(),
      packageId,
      kind,
      { optional: true },
    );
    if (existing?.manifest.contentHash === contentHash) {
      return {
        ...summary,
        markdown: files["summary.md"],
        structured: structured ?? {},
      };
    }
    const existingBytes = existing
      ? await this.#packageBytes(existing.folder)
      : 0;
    await this.#assertRetention({
      additionalBytes: packageBytes(files) - existingBytes,
      additionalSessions: 0,
    });
    await this.#writePackage({
      parent: this.#summariesDirectory(),
      id: packageId,
      kind,
      files,
      contentHash,
      replace: true,
    });
    return {
      ...summary,
      markdown: files["summary.md"],
      structured: structured ?? {},
    };
  }

  async #readSummaryPackage(packageId, kind, { optional = false } = {}) {
    const packageData = await this.#readPackage(
      this.#summariesDirectory(),
      packageId,
      kind,
      { optional },
    );
    if (!packageData) return undefined;
    return {
      metadata: packageData.metadata,
      markdown: await readFile(join(packageData.folder, "summary.md"), "utf8"),
      structured: await readJson(join(packageData.folder, "summary.json")),
    };
  }

  async #assertPlaintextConsent() {
    const consent = await this.consentStatus();
    if (!consent.granted) {
      throw new Error("必須先同意明文逐字稿保存才能建立紀錄");
    }
  }

  async #writePackage({
    parent,
    id,
    kind,
    files,
    contentHash,
    replace = false,
  }) {
    await mkdir(parent, { recursive: true });
    const folder = join(parent, id);
    const stage = join(parent, `.${id}.${randomUUID()}.stage`);
    const backup = join(parent, `.${id}.${randomUUID()}.backup`);
    let movedExisting = false;
    await mkdir(stage, { recursive: true });
    try {
      for (const [name, content] of Object.entries(files)) {
        await writeFile(join(stage, name), content, "utf8");
      }
      const manifest = {
        schemaVersion: PACKAGE_SCHEMA_VERSION,
        kind,
        id,
        contentHash,
        files: Object.keys(files).sort(),
        completedAtMs: this.#now(),
      };
      await writeFile(
        join(stage, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      );
      if (replace) {
        try {
          await rename(folder, backup);
          movedExisting = true;
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      await rename(stage, folder);
      if (movedExisting) await rm(backup, { force: true, recursive: true });
    } catch (error) {
      await rm(stage, { force: true, recursive: true });
      if (movedExisting) {
        try {
          await rename(backup, folder);
        } catch {
          // The original package remains in the backup directory for recovery.
        }
      }
      throw error;
    }
  }

  async #readPackage(parent, id, kind, { optional = false } = {}) {
    const folder = join(parent, id);
    try {
      const manifest = await readJson(join(folder, "manifest.json"));
      if (
        manifest?.schemaVersion !== PACKAGE_SCHEMA_VERSION ||
        manifest?.kind !== kind ||
        manifest?.id !== id ||
        !Array.isArray(manifest?.files)
      ) {
        throw new Error("invalid manifest");
      }
      for (const file of manifest.files) {
        await readFile(join(folder, file), "utf8");
      }
      const metadata = await readJson(join(folder, "metadata.json"));
      return { folder, manifest, metadata };
    } catch (error) {
      if (optional && (error?.code === "ENOENT" || error?.message))
        return undefined;
      throw new Error("Record data is unavailable or incomplete");
    }
  }

  async #listPackages(parent, kind) {
    try {
      const entries = await readdir(parent, { withFileTypes: true });
      const packages = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
          .map((entry) =>
            this.#readPackage(parent, entry.name, kind, { optional: true }),
          ),
      );
      return packages
        .filter(Boolean)
        .sort(
          (left, right) =>
            Number(
              right.metadata.endedAtMs ?? right.metadata.generatedAtMs ?? 0,
            ) -
            Number(left.metadata.endedAtMs ?? left.metadata.generatedAtMs ?? 0),
        );
    } catch {
      return [];
    }
  }

  async #assertRetention({ additionalBytes, additionalSessions }) {
    const status = await this.retentionStatus();
    if (status.sessionCount + additionalSessions > status.maxSessions) {
      throw new Error("已達本機逐字稿保存上限，請刪除舊紀錄後再試");
    }
    if (status.bytes + Math.max(0, additionalBytes) > status.maxBytes) {
      throw new Error("已達本機保存容量上限，請刪除舊紀錄後再試");
    }
  }

  async #storageBytes() {
    const folders = [this.#sessionsDirectory(), this.#summariesDirectory()];
    const sizes = await Promise.all(
      folders.map((folder) => this.#folderBytes(folder)),
    );
    return sizes.reduce((total, bytes) => total + bytes, 0);
  }

  async #packageBytes(folder) {
    return this.#folderBytes(folder);
  }

  async #folderBytes(folder) {
    try {
      const entries = await readdir(folder, { withFileTypes: true });
      const sizes = await Promise.all(
        entries.map(async (entry) => {
          const path = join(folder, entry.name);
          if (entry.isDirectory()) return this.#folderBytes(path);
          const info = await stat(path);
          return info.size;
        }),
      );
      return sizes.reduce((total, bytes) => total + bytes, 0);
    } catch {
      return 0;
    }
  }

  async #atomicFile(path, content) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, "utf8");
    await rename(temporary, path);
  }

  async #serialize(_key, work) {
    const previous = this.#mutationQueue;
    const current = previous.catch(() => {}).then(work);
    this.#mutationQueue = current;
    try {
      return await current;
    } finally {
      if (this.#mutationQueue === current) {
        this.#mutationQueue = Promise.resolve();
      }
    }
  }

  #consentPath() {
    return join(this.#directory, "consent.json");
  }

  #sessionsDirectory() {
    return join(this.#directory, "sessions");
  }

  #summariesDirectory() {
    return join(this.#directory, "summaries");
  }

  #summaryFolder(id) {
    return join(this.#summariesDirectory(), id);
  }

  #sessionSummaryPackageId(id) {
    return `session-${id}`;
  }

  #aggregateSummaryPackageId(id) {
    return `aggregate-${id}`;
  }
}
