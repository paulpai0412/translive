import { DatabaseSync } from "node:sqlite";

const SUMMARY_TIER = "summary";
const TRANSCRIPT_TIER = "transcript";
const DEFAULT_LIMIT = 6;

// FTS5 trigram requires queries of at least 3 characters; shorter CJK terms
// (e.g. 延後) silently match nothing, so they go through a LIKE scan instead.
// ponytail: LIKE scans the whole corpus — fine at MB scale, revisit if the
// records store grows into hundreds of MB.
function queryTerms(query) {
  return String(query ?? "")
    .split(/\s+/)
    .map((term) => term.replaceAll('"', "").trim())
    .filter((term) => term.length > 0);
}

function escapeLike(term) {
  return term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export class MeetingIndex {
  #db;

  constructor({ databaseFile = ":memory:" } = {}) {
    this.#db = new DatabaseSync(databaseFile);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS sessions_meta (
        session_id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        mode TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
        session_id UNINDEXED,
        tier UNINDEXED,
        direction UNINDEXED,
        side UNINDEXED,
        heading,
        body,
        offset_ms UNINDEXED,
        tokenize = 'trigram'
      );
    `);
  }

  indexSession({ metadata, entries = [], summary } = {}) {
    const sessionId = assertSessionId(metadata?.id);
    const startedAtMs = Number(metadata.startedAtMs);
    if (!Number.isFinite(startedAtMs)) {
      throw new Error("Session startedAtMs is required for indexing");
    }
    this.removeSession(sessionId);
    this.#db
      .prepare(
        "INSERT INTO sessions_meta (session_id, started_at, mode) VALUES (?, ?, ?)",
      )
      .run(sessionId, Math.round(startedAtMs), String(metadata.mode ?? ""));
    const insert = this.#db.prepare(
      `INSERT INTO chunks (session_id, tier, direction, side, heading, body, offset_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const entry of entries) {
      if (typeof entry?.text !== "string" || entry.text.trim().length === 0) {
        continue;
      }
      insert.run(
        sessionId,
        TRANSCRIPT_TIER,
        String(entry.direction ?? ""),
        String(entry.side ?? ""),
        "",
        entry.text,
        Math.max(0, Math.round(Number(entry.offsetMs) || 0)),
      );
    }
    const sections = summary?.sections ?? {};
    for (const [heading, items] of Object.entries(sections)) {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (typeof item?.text !== "string" || item.text.trim().length === 0) {
          continue;
        }
        insert.run(
          sessionId,
          SUMMARY_TIER,
          "",
          "",
          String(heading),
          item.text,
          Math.max(0, Math.round(Number(item.citations?.[0]?.offsetMs) || 0)),
        );
      }
    }
  }

  removeSession(sessionId) {
    const id = assertSessionId(sessionId);
    this.#db.prepare("DELETE FROM chunks WHERE session_id = ?").run(id);
    this.#db
      .prepare("DELETE FROM sessions_meta WHERE session_id = ?")
      .run(id);
  }

  rebuild(sessions = []) {
    this.#db.exec("DELETE FROM chunks; DELETE FROM sessions_meta;");
    for (const session of sessions) {
      this.indexSession(session);
    }
  }

  search(query, { dateFrom, dateTo, limit = DEFAULT_LIMIT } = {}) {
    const terms = queryTerms(query);
    if (terms.length === 0) return [];
    const { clause, params } = this.#dateClause(dateFrom, dateTo);
    const hits = terms.every((term) => term.length >= 3)
      ? this.#ftsSearch(terms, clause, params, limit)
      : this.#likeSearch(terms, clause, params, limit);
    return hits.slice(0, Math.max(1, limit));
  }

  #ftsSearch(terms, clause, params, limit) {
    const match = terms.map((term) => `"${term}"`).join(" OR ");
    return this.#db
      .prepare(
        `SELECT c.session_id AS sessionId, c.tier, c.direction, c.side,
                c.heading, c.body AS text, c.offset_ms AS offsetMs,
                bm25(chunks) AS score
         FROM chunks c JOIN sessions_meta m ON m.session_id = c.session_id
         WHERE chunks MATCH ?${clause}
         ORDER BY (c.tier = '${SUMMARY_TIER}') DESC, score
         LIMIT ?`,
      )
      .all(match, ...params, Math.max(1, limit) * 2);
  }

  #likeSearch(terms, clause, params, limit) {
    const likes = terms
      .map(() => "c.body LIKE ? ESCAPE '\\'")
      .join(" AND ");
    return this.#db
      .prepare(
        `SELECT c.session_id AS sessionId, c.tier, c.direction, c.side,
                c.heading, c.body AS text, c.offset_ms AS offsetMs, 0 AS score
         FROM chunks c JOIN sessions_meta m ON m.session_id = c.session_id
         WHERE ${likes}${clause}
         ORDER BY (c.tier = '${SUMMARY_TIER}') DESC, m.started_at DESC
         LIMIT ?`,
      )
      .all(
        ...terms.map((term) => `%${escapeLike(term)}%`),
        ...params,
        Math.max(1, limit),
      );
  }

  #dateClause(dateFrom, dateTo) {
    const parts = [];
    const params = [];
    if (Number.isFinite(dateFrom)) {
      parts.push("m.started_at >= ?");
      params.push(Math.round(dateFrom));
    }
    if (Number.isFinite(dateTo)) {
      parts.push("m.started_at <= ?");
      params.push(Math.round(dateTo));
    }
    return {
      clause: parts.length > 0 ? ` AND ${parts.join(" AND ")}` : "",
      params,
    };
  }

  close() {
    this.#db.close();
  }
}

function assertSessionId(value) {
  const id = String(value ?? "").trim();
  if (id.length === 0) throw new Error("Session id is required for indexing");
  return id;
}
