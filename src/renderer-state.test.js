import assert from "node:assert/strict";
import test from "node:test";

import {
  latestTranscriptPersistenceEvent,
  transcriptPersistencePresentation,
} from "./renderer-state.js";

test("keeps live persistence status honest before and after a save result", () => {
  assert.deepEqual(
    transcriptPersistencePresentation({
      consentGranted: false,
      event: undefined,
      skipForCurrentRun: false,
    }),
    { live: "逐字稿未保存", stopped: "本次翻譯未保存逐字稿。", summary: false },
  );
  assert.deepEqual(
    transcriptPersistencePresentation({
      consentGranted: true,
      event: {
        path: "C:\\Users\\Ada\\AppData\\Local\\TransLive\\meetings\\session",
        state: "saved",
      },
      skipForCurrentRun: false,
    }),
    {
      live: "逐字稿已保存",
      stopped: "逐字稿已保存至本機紀錄。",
      pathDetail:
        "C:\\Users\\Ada\\AppData\\Local\\TransLive\\meetings\\session",
      summary: true,
    },
  );
});

test("keeps a long Windows record path out of the stopped message while retaining it for assistive detail", () => {
  const path =
    "C:\\Users\\TimmyPai\\AppData\\Local\\TransLive\\meetings\\sessions\\53f3c44d-81cb-4839-814f-3203743a9888";
  const presentation = transcriptPersistencePresentation({
    consentGranted: true,
    event: { path, state: "saved" },
    skipForCurrentRun: false,
  });

  assert.deepEqual(presentation, {
    live: "逐字稿已保存",
    stopped: "逐字稿已保存至本機紀錄。",
    pathDetail: path,
    summary: true,
  });
  assert.equal(presentation.stopped.includes(path), false);
});

test("surfaces a save failure without offering a summary CTA", () => {
  assert.deepEqual(
    transcriptPersistencePresentation({
      consentGranted: true,
      event: { state: "failed" },
      skipForCurrentRun: false,
    }),
    {
      live: "逐字稿保存失敗",
      stopped: "逐字稿保存失敗，請開啟診斷查看詳情。",
      summary: false,
    },
  );
});

test("keeps the latest failed persistence result across a later stopped screen transition", () => {
  const failed = { state: "failed" };
  const latest = latestTranscriptPersistenceEvent(failed, undefined);

  assert.deepEqual(latest, failed);
  assert.equal(
    transcriptPersistencePresentation({
      consentGranted: true,
      event: latest,
      skipForCurrentRun: false,
    }).live,
    "逐字稿保存失敗",
  );
});
