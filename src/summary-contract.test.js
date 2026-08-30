import assert from "node:assert/strict";
import test from "node:test";

import { formatSummaryMarkdown } from "./summary-service.js";

test("formats semantic summary lists with validated per-item citations and exact 未指定 task fields", () => {
  const markdown = formatSummaryMarkdown({
    kind: "session",
    modelOutput: {
      sections: {
        重點: [
          {
            citations: [{ offsetMs: 1_250, sessionId: "session-001" }],
            text: "確認生產時程",
          },
        ],
        決策: [],
        待辦: [
          {
            citations: [{ offsetMs: 2_500, sessionId: "session-001" }],
            date: "未指定",
            owner: "未指定",
            text: "確認驗證時程",
          },
        ],
        未決問題: [],
      },
    },
    sourceSessions: [
      { id: "session-001", timestamps: [1_250, 2_500] },
    ],
  });

  assert.match(markdown, /^# 單場摘要/m);
  assert.match(markdown, /## 重點\n- 確認生產時程【session-001 @ 00:01\.250】/);
  assert.match(
    markdown,
    /- 確認驗證時程；負責人：未指定；日期：未指定【session-001 @ 00:02\.500】/,
  );
  assert.match(markdown, /## 決策\n- 未提供/);
});

test("rejects summary items with citations that do not exist in the selected transcript", () => {
  assert.throws(
    () =>
      formatSummaryMarkdown({
        kind: "session",
        modelOutput: {
          sections: {
            重點: [
              {
                citations: [{ offsetMs: 99, sessionId: "session-001" }],
                text: "不可信內容",
              },
            ],
            決策: [],
            待辦: [],
            未決問題: [],
          },
        },
        sourceSessions: [{ id: "session-001", timestamps: [1] }],
      }),
    /citation/i,
  );
});
