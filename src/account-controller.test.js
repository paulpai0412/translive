import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { AccountController } from "./account-controller.js";

class FakeAccountClient extends EventEmitter {
  constructor(account = null) {
    super();
    this.account = account;
    this.closed = false;
    this.requests = [];
  }

  async start() {}

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === "account/read") {
      return { account: this.account };
    }
    if (method === "account/login/start") {
      return {
        type: "chatgpt",
        loginId: "login-1",
        authUrl: "https://chatgpt.example.test/authorize",
      };
    }
    if (method === "account/login/cancel") return { status: "cancelled" };
    if (method === "account/logout") return {};
    throw new Error(`Unexpected request: ${method}`);
  }

  async close() {
    this.closed = true;
  }
}

test("reports account status without exposing account identity", async () => {
  const client = new FakeAccountClient({
    type: "chatgpt",
    email: "private@example.test",
    planType: "plus",
  });
  const controller = new AccountController({ createClient: () => client });

  const result = await controller.status();

  assert.deepEqual(result, { state: "connected" });
  assert.equal(client.closed, true);
  assert.equal(client.requests[0].method, "account/read");
  assert.doesNotMatch(JSON.stringify(result), /private@example\.test/);
});

test("starts official ChatGPT login and publishes only opaque completion state", async () => {
  const client = new FakeAccountClient();
  const events = [];
  const controller = new AccountController({
    createClient: () => client,
    publish: (event) => events.push(event),
  });

  const result = await controller.startLogin();

  assert.deepEqual(result, {
    loginId: "login-1",
    authUrl: "https://chatgpt.example.test/authorize",
  });
  assert.deepEqual(events, [{ type: "account", state: "waiting" }]);

  client.emit("notification", {
    method: "account/login/completed",
    params: { loginId: "login-1", success: true, error: null },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events.at(-1), { type: "account", state: "connected" });
  assert.equal(client.closed, true);
  assert.doesNotMatch(JSON.stringify(events), /token|email|private/i);
});

test("shares one pending browser login instead of orphaning a second app-server", async () => {
  let createCalls = 0;
  let resolveLogin;
  const client = new FakeAccountClient();
  client.request = async (method, params) => {
    client.requests.push({ method, params });
    if (method === "account/login/start") {
      return new Promise((resolve) => {
        resolveLogin = resolve;
      });
    }
    if (method === "account/login/cancel") return { status: "cancelled" };
    throw new Error(`Unexpected request: ${method}`);
  };
  const controller = new AccountController({
    createClient: () => {
      createCalls++;
      return client;
    },
  });

  const first = controller.startLogin();
  const second = controller.startLogin();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(createCalls, 1);
  resolveLogin({
    type: "chatgpt",
    loginId: "login-1",
    authUrl: "https://chatgpt.example.test/authorize",
  });

  assert.deepEqual(await first, await second);
  await controller.cancelLogin();
});

test("cancels a pending browser login without keeping the app-server alive", async () => {
  const client = new FakeAccountClient();
  const events = [];
  const controller = new AccountController({
    createClient: () => client,
    publish: (event) => events.push(event),
  });

  await controller.startLogin();
  await controller.cancelLogin();
  client.emit("notification", {
    method: "account/login/completed",
    params: { loginId: "login-1", success: true },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(client.closed, true);
  assert.deepEqual(client.requests.at(-1), {
    method: "account/login/cancel",
    params: { loginId: "login-1" },
  });
  assert.deepEqual(events.at(-1), { type: "account", state: "logged-out" });
});

test("closes a client when official login startup fails", async () => {
  const client = new FakeAccountClient();
  client.request = async (method) => {
    client.requests.push({ method });
    if (method === "account/login/start") {
      throw new Error("upstream login startup failed");
    }
    throw new Error(`Unexpected request: ${method}`);
  };
  const controller = new AccountController({ createClient: () => client });

  await assert.rejects(
    controller.startLogin(),
    /upstream login startup failed/,
  );
  assert.equal(client.closed, true);
});

test("logout cancels a pending browser login and ignores a late OAuth success", async () => {
  const pendingLoginClient = new FakeAccountClient();
  const logoutClient = new FakeAccountClient();
  const events = [];
  const clients = [pendingLoginClient, logoutClient];
  const controller = new AccountController({
    createClient: () => clients.shift(),
    publish: (event) => events.push(event),
  });

  await controller.startLogin();
  assert.deepEqual(await controller.logout(), { state: "logged-out" });
  pendingLoginClient.emit("notification", {
    method: "account/login/completed",
    params: { loginId: "login-1", success: true },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(pendingLoginClient.requests, [
    {
      method: "account/login/start",
      params: { type: "chatgpt", codexStreamlinedLogin: true },
    },
    { method: "account/login/cancel", params: { loginId: "login-1" } },
  ]);
  assert.deepEqual(logoutClient.requests, [
    { method: "account/logout", params: {} },
  ]);
  assert.equal(pendingLoginClient.closed, true);
  assert.equal(logoutClient.closed, true);
  assert.deepEqual(events.at(-1), { type: "account", state: "logged-out" });
  assert.equal(
    events.some((event) => event.state === "connected"),
    false,
  );
});

test("reports an official login failure without forwarding its detail", async () => {
  const client = new FakeAccountClient();
  const events = [];
  const controller = new AccountController({
    createClient: () => client,
    publish: (event) => events.push(event),
  });

  await controller.startLogin();
  client.emit("notification", {
    method: "account/login/completed",
    params: {
      loginId: "login-1",
      success: false,
      error: "private upstream detail",
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events.at(-1), { type: "account", state: "failed" });
  assert.equal(client.closed, true);
  assert.doesNotMatch(JSON.stringify(events), /private upstream detail/);
});
