import { randomUUID } from "node:crypto";

export class RendererControlBridge {
  #nextId;
  #pending = new Map();
  #send;
  #timeoutMs;

  constructor({
    send,
    timeoutMs = 2_000,
    nextId = () => randomUUID(),
  }) {
    this.#send = send;
    this.#timeoutMs = timeoutMs;
    this.#nextId = nextId;
  }

  request(control) {
    const controlId = this.#nextId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(controlId);
        reject(new Error("Renderer control acknowledgement timed out"));
      }, this.#timeoutMs);
      this.#pending.set(controlId, { resolve, reject, timer });
      try {
        this.#send({ type: "renderer-control", controlId, ...control });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(controlId);
        reject(error);
      }
    });
  }

  acknowledge({ controlId, state }) {
    const pending = this.#pending.get(controlId);
    if (!pending) return false;
    this.#pending.delete(controlId);
    clearTimeout(pending.timer);
    if (state === "applied") {
      pending.resolve({ controlId, state });
    } else {
      pending.reject(new Error("Renderer cleanup failed"));
    }
    return true;
  }

  dispose() {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Renderer control bridge disposed"));
    }
    this.#pending.clear();
  }
}
