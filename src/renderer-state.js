export function latestTranscriptPersistenceEvent(current, incoming) {
  return incoming?.state ? incoming : current;
}

export function transcriptPersistencePresentation({
  consentGranted,
  event,
  skipForCurrentRun,
}) {
  if (event?.state === "saved") {
    return {
      live: "逐字稿已保存",
      stopped: "逐字稿已保存至本機紀錄。",
      pathDetail: typeof event.path === "string" ? event.path : undefined,
      summary: true,
    };
  }
  if (event?.state === "failed") {
    return {
      live: "逐字稿保存失敗",
      stopped: "逐字稿保存失敗，請開啟診斷查看詳情。",
      summary: false,
    };
  }
  if (consentGranted && !skipForCurrentRun) {
    return {
      live: "逐字稿保存中",
      stopped: "逐字稿正在保存，請稍候。",
      summary: false,
    };
  }
  return {
    live: "逐字稿未保存",
    stopped: "本次翻譯未保存逐字稿。",
    summary: false,
  };
}
