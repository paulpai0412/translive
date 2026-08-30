function mergeStreamingText(current, incoming, final) {
  const previous = String(current ?? "");
  const next = String(incoming ?? "");
  if (!next) return previous;
  if (next.startsWith(previous)) return next;
  if (previous.endsWith(next)) return previous;
  if (final && previous.startsWith(next)) return previous;
  const overlapLimit = Math.min(previous.length, next.length);
  for (let overlap = overlapLimit; overlap > 0; overlap -= 1) {
    if (previous.endsWith(next.slice(0, overlap))) {
      return `${previous}${next.slice(overlap)}`;
    }
  }
  return `${previous}${next}`;
}

/**
 * Keep target transcript text private to renderer state until its matching
 * speech segment is dispatched. Already spoken captions are never rewritten.
 */
export function bufferPacedTargetCaption(current, text, final = false) {
  const visible = String(current?.visible ?? "");
  const complete = `${visible}${String(current?.pending ?? "")}`;
  const merged = mergeStreamingText(complete, text, final);
  if (merged.startsWith(visible)) {
    return { pending: merged.slice(visible.length), visible };
  }
  return {
    pending: mergeStreamingText(current?.pending, text, final),
    visible,
  };
}

export function advancePacedTargetCaption(current, characters) {
  const visible = String(current?.visible ?? "");
  const pending = Array.from(String(current?.pending ?? ""));
  const count = Math.max(0, Math.floor(Number(characters) || 0));
  const spoken = pending.slice(0, count).join("");
  return {
    pending: pending.slice(count).join(""),
    visible: `${visible}${spoken}`,
  };
}

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
