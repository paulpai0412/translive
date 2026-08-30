import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MINI_CAPTION_LIMITS,
  MiniCaptionWindowController,
  normalizeMiniCaptionSnapshot,
} from "./mini-caption-window.js";

class FakeWindow extends EventEmitter {
  destroyed = false;
  hidden = false;
  shown = 0;
  focused = 0;
  loaded = [];
  destroyRequested = false;
  sent = [];
  webContents = {
    send: (channel, payload) => this.sent.push({ channel, payload }),
  };

  loadFile(path) {
    this.loaded.push(path);
  }

  showInactive() {
    this.shown += 1;
    this.hidden = false;
  }

  hide() {
    this.hidden = true;
  }

  show() {
    this.shown += 1;
    this.hidden = false;
  }

  focus() {
    this.focused += 1;
  }

  isDestroyed() {
    return this.destroyed;
  }

  destroy() {
    this.destroyRequested = true;
    queueMicrotask(() => {
      let prevented = false;
      this.emit("close", { preventDefault: () => (prevented = true) });
      if (prevented) return;
      this.destroyed = true;
      this.emit("closed");
    });
  }
}

function fixture() {
  const created = [];
  const main = new FakeWindow();
  const controller = new MiniCaptionWindowController({
    createWindow: (options) => {
      const child = new FakeWindow();
      created.push({ child, options });
      return child;
    },
    getMainWindow: () => main,
    getWorkArea: () => ({ height: 900, width: 1600, x: 20, y: 10 }),
    pagePath: "/app/src/mini-caption.html",
  });
  return { controller, created, main };
}

test("opens a compact movable non-modal caption window at the bottom center without blocking main controls", () => {
  const { controller, created } = fixture();

  const result = controller.show({
    mode: "媒體翻譯",
    primary: "第一句繁中字幕",
    secondary: "",
    status: "翻譯中",
  });

  assert.deepEqual(result, { shown: true });
  assert.equal(created.length, 1);
  const { child, options } = created[0];
  child.emit("ready-to-show");
  assert.deepEqual(
    {
      alwaysOnTop: options.alwaysOnTop,
      frame: options.frame,
      height: options.height,
      modal: options.modal,
      movable: options.movable,
      resizable: options.resizable,
      skipTaskbar: options.skipTaskbar,
      width: options.width,
      x: options.x,
      y: options.y,
    },
    {
      alwaysOnTop: true,
      frame: false,
      height: MINI_CAPTION_LIMITS.height,
      modal: false,
      movable: true,
      resizable: true,
      skipTaskbar: true,
      width: MINI_CAPTION_LIMITS.width,
      x: 20 + Math.floor((1600 - MINI_CAPTION_LIMITS.width) / 2),
      y:
        10 + 900 - MINI_CAPTION_LIMITS.height - MINI_CAPTION_LIMITS.bottomInset,
    },
  );
  assert.deepEqual(child.loaded, ["/app/src/mini-caption.html"]);
  assert.equal(child.shown, 1);
  assert.deepEqual(child.sent, [
    {
      channel: "translive:mini-caption",
      payload: {
        mode: "媒體翻譯",
        primary: "第一句繁中字幕",
        secondary: "",
        status: "翻譯中",
      },
    },
  ]);
});

test("hides only mini captions and returns focus to the main window on close or return", () => {
  const { controller, created, main } = fixture();
  controller.show({ primary: "字幕" });
  const child = created[0].child;
  child.emit("ready-to-show");
  let prevented = false;
  child.emit("close", { preventDefault: () => (prevented = true) });

  assert.equal(prevented, true);
  assert.equal(child.hidden, true);
  assert.equal(main.shown, 1);
  assert.equal(main.focused, 1);

  controller.show({ primary: "下一句" });
  controller.hideAndFocusMain();
  assert.equal(child.hidden, true);
  assert.equal(main.focused, 2);
});

test("dispose destroys a hidden mini window even when close events are asynchronous", async () => {
  const { controller, created } = fixture();
  controller.show({ primary: "字幕" });
  const child = created[0].child;
  child.emit("ready-to-show");

  controller.dispose();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(child.destroyRequested, true);
  assert.equal(child.destroyed, true);
});

test("mini caption assets keep an isolated CSP and only expose return/caption IPC", async () => {
  const [html, preload, renderer] = await Promise.all([
    readFile(new URL("./mini-caption.html", import.meta.url), "utf8"),
    readFile(new URL("./mini-caption-preload.cjs", import.meta.url), "utf8"),
    readFile(new URL("./mini-caption-renderer.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /script-src 'self'/);
  assert.match(html, /src="\.\/mini-caption-renderer\.js"/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i);
  assert.match(preload, /returnToMain/);
  assert.match(preload, /onCaption/);
  assert.doesNotMatch(preload, /token|diagnostic|nodeIntegration/i);
  assert.match(renderer, /\.textContent =/);
});

test("sends only bounded caption/status fields to the isolated mini renderer", () => {
  const tooLong = "繁".repeat(MINI_CAPTION_LIMITS.primaryCharacters + 20);
  const snapshot = normalizeMiniCaptionSnapshot({
    diagnostics: "must-not-cross-ipc",
    mode: "媒體翻譯",
    primary: tooLong,
    secondary: "第二句",
    status: "翻譯中",
    token: "secret",
  });

  assert.deepEqual(Object.keys(snapshot).sort(), [
    "mode",
    "primary",
    "secondary",
    "status",
  ]);
  assert.equal(
    Array.from(snapshot.primary).length,
    MINI_CAPTION_LIMITS.primaryCharacters,
  );
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|diagnostics/);
});
