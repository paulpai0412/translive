import {
  CodexAppServer,
  DEFAULT_CODEX_APP_SERVER_ARGS,
} from "./codex-app-server.js";

// Minimal single-turn text completion over the Codex app-server transport:
// one ephemeral thread, one turn, accumulate agent deltas until completion.
// Used by meeting assistant Q&A where the heavy summary machinery (sections,
// citation validation) does not apply.
export class CodexTextTurn {
  #createClient;

  constructor({
    codexExecutable = process.env.TRANSLIVE_CODEX_BIN || "codex",
    codexArgs = DEFAULT_CODEX_APP_SERVER_ARGS,
    cwd = process.cwd(),
    createClient = () =>
      new CodexAppServer({ executable: codexExecutable, args: codexArgs, cwd }),
  } = {}) {
    this.#createClient = createClient;
  }

  async run(prompt) {
    const client = this.#createClient();
    let threadId;
    let removeListener = () => {};
    try {
      await client.start();
      const threadResult = await client.request("thread/start", {
        approvalPolicy: "never",
        ephemeral: true,
        sandbox: "read-only",
      });
      threadId = threadResult?.thread?.id;
      if (!threadId) throw new Error("Codex did not return a thread");

      const completion = new Promise((resolve, reject) => {
        let output = "";
        let turnId;
        const onNotification = (notification) => {
          const params = notification.params ?? {};
          if (params.threadId !== threadId) return;
          if (notification.method === "item/agentMessage/delta") {
            output += params.delta ?? "";
          }
          if (notification.method === "turn/completed") {
            if (params.turn?.status !== "completed") {
              reject(new Error("Codex text turn did not complete"));
              return;
            }
            resolve(output);
          }
        };
        client.on("notification", onNotification);
        removeListener = () => client.off("notification", onNotification);
      });

      await client.request("turn/start", {
        approvalPolicy: "never",
        input: [{ type: "text", text: prompt, text_elements: [] }],
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        threadId,
      });
      return await completion;
    } finally {
      removeListener();
      await client.close();
    }
  }
}
