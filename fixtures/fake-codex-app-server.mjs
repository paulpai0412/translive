import { writeFileSync } from "node:fs";
import readline from "node:readline";

const exitMarker = process.argv[2];
function markClosed() {
  if (exitMarker) writeFileSync(exitMarker, "closed", "utf8");
}
process.on("exit", markClosed);
process.on("SIGTERM", () => process.exit(0));

let initialized = false;
let threadCount = 0;
let turnCount = 0;
const realtimeThreads = new Map();
const tailThreads = new Set();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ id, result });
}

function reject(id, message) {
  send({ id, error: { code: -32602, message } });
}

function directionFor(params) {
  if (
    /verbatim transcription machine for the local speaker/.test(params.prompt)
  ) {
    return "tx";
  }
  if (/verbatim transcription machine for meeting audio/.test(params.prompt)) {
    return "rx";
  }
  if (/voice output channel/.test(params.prompt)) {
    return "qa";
  }
  if (
    params.voice === "cove" &&
    /Traditional Chinese used in Taiwan/.test(params.prompt) &&
    /English interpretation/.test(params.prompt) &&
    /Speak every interpretation aloud/.test(params.prompt) &&
    /Do not wait for sentence completion/.test(params.prompt)
  ) {
    return "tx";
  }
  if (
    params.voice === "cove" &&
    /Detect the source language automatically/.test(params.prompt) &&
    /Always render every spoken utterance in natural Traditional Chinese used in Taiwan/.test(
      params.prompt,
    ) &&
    /If the input is already Traditional Chinese, reproduce it faithfully/.test(
      params.prompt,
    ) &&
    /Speak every interpretation aloud/.test(params.prompt) &&
    /Do not wait for sentence completion/.test(params.prompt)
  ) {
    return "rx";
  }
  return undefined;
}

function hasPhaseOneContract(params) {
  return (
    params.model === "gpt-live-1-codex" &&
    params.version === "v3" &&
    params.outputModality === "audio" &&
    params.includeStartupContext === false &&
    params.clientManagedHandoffs === true &&
    params.delegationAckFiller === false &&
    directionFor(params) &&
    params.transport?.type === "webrtc"
  );
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.method === "initialized") {
    initialized = true;
    return;
  }
  if (request.method === "initialize") {
    if (!request.params?.capabilities?.experimentalApi) {
      reject(request.id, "Expected experimentalApi capability");
      return;
    }
    respond(request.id, {
      userAgent: "fake-codex",
      codexHome: "/tmp",
      platformOs: "linux",
    });
    return;
  }
  if (!initialized) {
    reject(request.id, "Not initialized");
    return;
  }
  if (request.method === "thread/start") {
    if (
      !request.params?.ephemeral ||
      request.params?.approvalPolicy !== "never" ||
      request.params?.sandbox !== "read-only"
    ) {
      reject(request.id, "Expected an ephemeral read-only thread");
      return;
    }
    threadCount += 1;
    respond(request.id, { thread: { id: `fixture-thread-${threadCount}` } });
    return;
  }
  if (request.method === "thread/realtime/start") {
    if (!hasPhaseOneContract(request.params)) {
      reject(request.id, "Missing or reversed Phase 1 realtime contract");
      return;
    }
    if (request.params.transport.sdp === "fixture-reject") {
      reject(request.id, "Fixture requested realtime rejection");
      return;
    }
    if (realtimeThreads.has(request.params.threadId)) {
      reject(request.id, "Duplicate realtime thread ID");
      return;
    }
    const direction = directionFor(request.params);
    realtimeThreads.set(request.params.threadId, direction);
    if (
      direction === "tx" &&
      request.params.transport.sdp === "fixture-assistant-wake"
    ) {
      const { threadId: wakeThreadId } = request.params;
      setTimeout(
        () =>
          send({
            method: "thread/realtime/transcript/done",
            params: {
              threadId: wakeThreadId,
              role: "user",
              text: "小泥小泥,預算多少",
            },
          }),
        40,
      );
    }
    if (request.params.transport.sdp === "fixture-tail") {
      tailThreads.add(request.params.threadId);
    }
    respond(request.id, {});
    const { threadId } = request.params;
    const realtimeSessionId = `fixture-session-${threadId}`;
    setTimeout(
      () =>
        send({
          method: "thread/realtime/started",
          params: { threadId, realtimeSessionId, version: "v3" },
        }),
      5,
    );
    setTimeout(
      () =>
        send({
          method: "thread/realtime/sdp",
          params: { threadId, sdp: "v=0\r\nfixture-answer" },
        }),
      10,
    );
    if (
      direction === "rx" &&
      request.params.transport.sdp === "fixture-chinese-target"
    ) {
      setTimeout(
        () =>
          send({
            method: "thread/realtime/transcript/delta",
            params: { threadId, role: "user", delta: "這是中文輸入。" },
          }),
        12,
      );
      setTimeout(
        () =>
          send({
            method: "thread/realtime/transcript/done",
            params: { threadId, role: "user", text: "這是中文輸入。" },
          }),
        14,
      );
    }
    const deltas =
      direction === "rx"
        ? ["這是一段即時", "中文翻譯內容。"]
        : ["fixture ", "translation."];
    deltas.forEach((delta, index) =>
      setTimeout(
        () =>
          send({
            method: "thread/realtime/transcript/delta",
            params: { threadId, role: "assistant", delta },
          }),
        15 + index * 5,
      ),
    );
    setTimeout(
      () =>
        send({
          method: "thread/realtime/transcript/done",
          params: { threadId, role: "assistant", text: deltas.join("") },
        }),
      30,
    );
    return;
  }
  if (request.method === "thread/realtime/appendSpeech") {
    const direction = realtimeThreads.get(request.params?.threadId);
    const legacyRxFallback =
      direction === "rx" &&
      request.params?.text === "這是一段即時中文翻譯內容。";
    if (direction !== "qa" && !legacyRxFallback) {
      reject(request.id, "Unexpected RX speech fallback text");
      return;
    }
    respond(request.id, {});
    const { threadId, text } = request.params;
    setTimeout(
      () =>
        send({
          method: "thread/realtime/transcript/delta",
          params: { threadId, role: "assistant", delta: text },
        }),
      1,
    );
    setTimeout(
      () =>
        send({
          method: "thread/realtime/transcript/done",
          params: { threadId, role: "assistant", text },
        }),
      2,
    );
    return;
  }
  if (request.method === "turn/start") {
    const threadId = request.params?.threadId;
    const text = request.params?.input?.[0]?.text ?? "";
    turnCount += 1;
    const turnId = `fixture-turn-${turnCount}`;
    respond(request.id, { turn: { id: turnId } });
    let output;
    if (text.includes("<TRANSCRIPT_DATA>")) {
      // The instructions mention the marker before the real payload line, so
      // take the last occurrence (the standalone payload tag).
      const payload = text.slice(text.lastIndexOf("<TRANSCRIPT_DATA>"));
      const sessionId = /"sessionId":\s*"([^"]+)"/.exec(payload)?.[1] ?? "x";
      const offsetMs = Number(/"offsetMs":\s*(\d+)/.exec(payload)?.[1] ?? 0);
      output = JSON.stringify({
        sections: {
          重點: [],
          決策: [
            {
              text: "預算核定十萬元",
              citations: [{ sessionId, offsetMs }],
              owner: "未指定",
              date: "未指定",
            },
          ],
          待辦: [],
          未決問題: [],
        },
      });
    } else {
      output = JSON.stringify({ text: "預算是十萬元。", citations: [] });
    }
    setTimeout(
      () =>
        send({
          method: "item/agentMessage/delta",
          params: { threadId, delta: output },
        }),
      5,
    );
    setTimeout(
      () =>
        send({
          method: "turn/completed",
          params: { threadId, turn: { id: turnId, status: "completed" } },
        }),
      12,
    );
    return;
  }
  if (request.method === "thread/realtime/stop") {
    const direction = realtimeThreads.get(request.params?.threadId);
    if (!direction) {
      reject(request.id, "Stop used an unknown realtime thread ID");
      return;
    }
    respond(request.id, {});
    const { threadId } = request.params;
    if (tailThreads.has(threadId)) {
      setTimeout(
        () =>
          send({
            method: "thread/realtime/transcript/done",
            params: { threadId, role: "assistant", text: "尾端逐字稿。" },
          }),
        20,
      );
    }
    setTimeout(
      () =>
        send({
          method: "thread/realtime/closed",
          params: { threadId, reason: "stopped" },
        }),
      30,
    );
    return;
  }
  reject(request.id, `Unexpected method ${request.method}`);
});
