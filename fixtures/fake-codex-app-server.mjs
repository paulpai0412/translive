import { writeFileSync } from "node:fs";
import readline from "node:readline";

const exitMarker = process.argv[2];
const scenario = process.argv[3];
const appendMarker = process.argv[4];
let appendCount = 0;

function markClosed() {
  if (exitMarker) writeFileSync(exitMarker, "closed", "utf8");
}
process.on("exit", markClosed);
process.on("SIGTERM", () => process.exit(0));

let initialized = false;
let threadCount = 0;
const realtimeThreads = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ id, result });
}

function reject(id, message) {
  send({ id, error: { code: -32602, message } });
}

function recordAppend() {
  appendCount += 1;
  if (appendMarker) writeFileSync(appendMarker, String(appendCount), "utf8");
}

function scheduleTranscript(threadId, role, deltas, startAt) {
  deltas.forEach((delta, index) =>
    setTimeout(
      () =>
        send({
          method: "thread/realtime/transcript/delta",
          params: { threadId, role, delta },
        }),
      startAt + index * 5,
    ),
  );
  setTimeout(
    () =>
      send({
        method: "thread/realtime/transcript/done",
        params: { threadId, role, text: deltas.join("") },
      }),
    startAt + deltas.length * 5 + 5,
  );
}

function directionFor(params) {
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
    /spoken English/.test(params.prompt) &&
    /Traditional Chinese interpretation/.test(params.prompt) &&
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
    const sourceScenario = request.params.transport.sdp;
    if (direction === "rx" && sourceScenario === "fixture-language-sequence") {
      scheduleTranscript(threadId, "user", ["Hello ", "world."], 15);
      scheduleTranscript(threadId, "assistant", ["這是一段", "即時中文。"], 40);
      scheduleTranscript(threadId, "user", ["這是", "中文。"], 70);
      scheduleTranscript(threadId, "assistant", ["模型", "回覆。"], 95);
      scheduleTranscript(threadId, "user", ["42"], 120);
      scheduleTranscript(threadId, "assistant", ["未知", "回覆。"], 140);
      return;
    }
    if (direction === "rx" && sourceScenario === "fixture-delayed-queue") {
      scheduleTranscript(threadId, "user", ["Hello ", "world."], 15);
      scheduleTranscript(threadId, "assistant", ["第一段。"], 40);
      scheduleTranscript(threadId, "assistant", ["第二段。"], 55);
      scheduleTranscript(threadId, "user", ["這是", "中文。"], 70);
      return;
    }
    if (direction === "rx" && sourceScenario === "fixture-delayed-stop") {
      scheduleTranscript(threadId, "user", ["Hello ", "world."], 15);
      scheduleTranscript(threadId, "assistant", ["第一段。"], 40);
      return;
    }

    const chineseSource =
      direction === "rx" && sourceScenario === "fixture-chinese";
    const mixedSource =
      direction === "rx" && sourceScenario === "fixture-mixed";
    let sourceDeltas = [];
    if (direction === "rx") {
      if (chineseSource) sourceDeltas = ["這是", "中文。"];
      else if (mixedSource) sourceDeltas = ["Hello ", "world 中文。"];
      else sourceDeltas = ["Hello ", "world."];
    }
    if (sourceDeltas.length > 0) {
      scheduleTranscript(threadId, "user", sourceDeltas, 15);
    }
    let deltas = ["fixture ", "translation."];
    if (direction === "rx") {
      deltas = chineseSource ? ["模型", "回覆。"] : ["這是一段", "即時中文。"];
    }
    scheduleTranscript(threadId, "assistant", deltas, 40);
    return;
  }
  if (request.method === "thread/realtime/appendSpeech") {
    const direction = realtimeThreads.get(request.params?.threadId);
    const expectedText =
      scenario === "delayed-queue" || scenario === "delayed-stop"
        ? ["第一段。", "第二段。"]
        : ["這是一段即時中文。"];
    if (direction !== "rx" || !expectedText.includes(request.params?.text)) {
      reject(request.id, "Unexpected RX speech fallback text");
      return;
    }
    recordAppend();
    const { threadId, text } = request.params;
    const delay =
      scenario === "delayed-queue" || scenario === "delayed-stop" ? 350 : 0;
    setTimeout(() => respond(request.id, {}), delay);
    if (delay === 0) {
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
    }
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
    setTimeout(
      () =>
        send({
          method: "thread/realtime/closed",
          params: { threadId, reason: "stopped" },
        }),
      1,
    );
    return;
  }
  reject(request.id, `Unexpected method ${request.method}`);
});
