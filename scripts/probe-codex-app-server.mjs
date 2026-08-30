import { CodexAppServer } from "../src/codex-app-server.js";
import { inspectCodexRuntime } from "../src/codex-runtime.js";

const executable = process.env.TRANSLIVE_CODEX_BIN || "codex";
const runtime = await inspectCodexRuntime({ executable, cwd: process.cwd() });
const pinnedVersion = process.env.TRANSLIVE_CODEX_VERSION || "0.145.0";
if (runtime.semanticVersion !== pinnedVersion) {
  throw new Error(
    `Pinned Codex ${pinnedVersion} is required; found ${runtime.semanticVersion ?? "unknown"}`,
  );
}
if (!runtime.loggedIn)
  throw new Error("Codex login status is not authenticated");
const client = new CodexAppServer({ executable, cwd: process.cwd() });

try {
  await client.start();
  const thread = await client.startEphemeralThread();
  process.stdout.write(
    `${JSON.stringify({
      probe: "passed",
      codexVersion: runtime.version,
      ephemeralThreadCreated: Boolean(thread.id),
    })}\n`,
  );
} finally {
  await client.close();
}
