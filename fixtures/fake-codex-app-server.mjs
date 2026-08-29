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
    setTimeout(
      () =>
        send({
          method: "thread/realtime/transcript/delta",
          params: { threadId, role: "assistant", delta: "fixture translation" },
        }),
      15,
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
