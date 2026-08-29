import { CodexAppServer, DEFAULT_CODEX_APP_SERVER_ARGS } from "./codex-app-server.js";

function accountState(account) {
  return account?.type === "chatgpt" ? "connected" : "logged-out";
}

export class AccountController {
  #createClient;
  #login;
  #loginCanceled = false;
  #loginPromise;
  #pendingClient;
  #publish;

  constructor({
    codexExecutable = process.env.TRANSLIVE_CODEX_BIN || "codex",
    codexArgs = DEFAULT_CODEX_APP_SERVER_ARGS,
    cwd = process.cwd(),
    createClient = () =>
      new CodexAppServer({
        executable: codexExecutable,
        args: codexArgs,
        cwd,
      }),
    publish = () => {},
  } = {}) {
    this.#createClient = createClient;
    this.#publish = publish;
  }

  async status() {
    const client = this.#createClient();
    try {
      await client.start();
      const result = await client.request("account/read", { refreshToken: true });
      return { state: accountState(result.account) };
    } finally {
      await client.close();
    }
  }

  async startLogin() {
    if (this.#login) return this.#login.result;
    if (this.#loginPromise) return this.#loginPromise;

    this.#loginCanceled = false;
    const promise = this.#beginLogin();
    this.#loginPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.#loginPromise === promise) this.#loginPromise = undefined;
    }
  }

  async #beginLogin() {
    const client = this.#createClient();
    this.#pendingClient = client;
    let retained = false;
    try {
      await client.start();
      const result = await client.request("account/login/start", {
        type: "chatgpt",
        codexStreamlinedLogin: true,
      });
      if (
        this.#loginCanceled ||
        this.#pendingClient !== client ||
        result.type !== "chatgpt" ||
        !result.loginId ||
        !result.authUrl
      ) {
        throw new Error("ChatGPT login was canceled or invalid");
      }

      const login = {
        client,
        loginId: result.loginId,
        result: { loginId: result.loginId, authUrl: result.authUrl },
      };
      this.#login = login;
      retained = true;
      client.on("notification", (notification) =>
        void this.#handleNotification(login, notification),
      );
      this.#publish({ type: "account", state: "waiting" });
      return login.result;
    } catch (error) {
      if (!retained) await client.close();
      throw error;
    } finally {
      if (this.#pendingClient === client) this.#pendingClient = undefined;
    }
  }

  async cancelLogin() {
    const login = this.#login;
    const pendingClient = this.#pendingClient;
    this.#loginCanceled = true;
    this.#login = undefined;
    this.#pendingClient = undefined;
    if (!login && !pendingClient) return;
    try {
      if (login) {
        await login.client.request("account/login/cancel", {
          loginId: login.loginId,
        });
      }
    } finally {
      await (login?.client ?? pendingClient).close();
      this.#publish({ type: "account", state: "logged-out" });
    }
  }

  async logout() {
    const client = this.#createClient();
    try {
      await client.start();
      await client.request("account/logout", {});
      this.#publish({ type: "account", state: "logged-out" });
    } finally {
      await client.close();
    }
  }

  async dispose() {
    await this.cancelLogin();
  }

  async #handleNotification(login, notification) {
    if (
      this.#login !== login ||
      notification.method !== "account/login/completed" ||
      notification.params?.loginId !== login.loginId
    ) {
      return;
    }
    this.#login = undefined;
    this.#publish({
      type: "account",
      state: notification.params.success ? "connected" : "failed",
    });
    await login.client.close();
  }
}
