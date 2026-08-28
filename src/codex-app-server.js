import { spawn as defaultSpawn } from "node:child_process";
import { EventEmitter } from "node:events";

import { codexLaunchOptions } from "./codex-runtime.js";

class CodexRpcError extends Error {
  constructor(error) {
    super(error?.message ?? "Codex app-server request failed");
    this.name = "CodexRpcError";
    this.code = error?.code;
    this.data = error?.data;
  }
}

export class CodexAppServer extends EventEmitter {
  #args;
  #child;
  #cwd;
  #executable;
  #nextId = 1;
  #pending = new Map();
  #requestTimeoutMs;
  #spawn;
  #platform;
  #stdoutBuffer = "";
  #started = false;

  constructor({
    executable = process.env.TRANSLIVE_CODEX_BIN || "codex",
    args = ["app-server", "--stdio"],
    cwd = process.cwd(),
    requestTimeoutMs = 15_000,
    spawn = defaultSpawn,
    platform = process.platform,
  } = {}) {
    super();
    this.#args = args;
    this.#cwd = cwd;
    this.#executable = executable;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#spawn = spawn;
    this.#platform = platform;
  }

  async start() {
    if (this.#started) return;

    this.#child = this.#spawn(this.#executable, this.#args, {
      cwd: this.#cwd,
      stdio: ["pipe", "pipe", "pipe"],
      ...codexLaunchOptions({ platform: this.#platform }),
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk) => this.#readStdout(chunk));
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk) =>
      this.emit("stderr", String(chunk)),
    );
    this.#child.once("error", (error) => this.#rejectPending(error));
    this.#child.once("exit", (code, signal) => {
      this.#started = false;
      this.#rejectPending(
        new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})`),
      );
      this.emit("exit", { code, signal });
    });

    await this.request("initialize", {
      clientInfo: {
        name: "translive_phase1_poc",
        title: "TransLive Phase 1 PoC",
        version: "0.0.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
    this.#started = true;
  }

  async startEphemeralThread() {
    const result = await this.request("thread/start", {
      cwd: this.#cwd,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    if (!result?.thread?.id)
      throw new Error("Codex app-server did not return a thread ID");
    return result.thread;
  }

  startRealtime(params) {
    return this.request("thread/realtime/start", params);
  }

  stopRealtime(threadId) {
    return this.request("thread/realtime/stop", { threadId });
  }

  notify(method, params) {
    this.#write({ method, params });
  }

  request(method, params) {
    if (!this.#child?.stdin?.writable) {
      return Promise.reject(new Error("Codex app-server is not running"));
    }

    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timed out waiting for Codex app-server ${method}`));
      }, this.#requestTimeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#write({ method, id, params });
    });
  }

  async close() {
    if (!this.#child) return;
    const child = this.#child;
    this.#child = undefined;
    this.#started = false;
    this.#rejectPending(new Error("Codex app-server closed"));
    if (
      child.killed ||
      (child.exitCode !== null && child.exitCode !== undefined)
    )
      return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 250)),
    ]);
  }

  #write(message) {
    if (!this.#child?.stdin?.writable)
      throw new Error("Codex app-server is not running");
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #readStdout(chunk) {
    this.#stdoutBuffer += chunk;
    let newline;
    while ((newline = this.#stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.#stdoutBuffer.slice(0, newline).trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (line) this.#readMessage(line);
    }
  }

  #readMessage(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit(
        "protocolError",
        new Error("Codex app-server emitted invalid JSON"),
      );
      return;
    }

    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new CodexRpcError(message.error));
      else pending.resolve(message.result);
      return;
    }

    if (typeof message.method === "string") this.emit("notification", message);
  }

  #rejectPending(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
