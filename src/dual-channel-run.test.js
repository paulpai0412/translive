import assert from "node:assert/strict";
import test from "node:test";

import { startDualChannelRun } from "./dual-channel-run.js";

test("starts independent TX and RX translation channels", async () => {
  const opened = [];
  const run = await startDualChannelRun(
    {
      tx: { sourceEndpointId: "physical-mic", sinkEndpointId: "cable-a" },
      rx: { sourceEndpointId: "cable-b", sinkEndpointId: "headphones" },
    },
    {
      openChannel: async (channel) => {
        opened.push(channel);
        return { stop: async () => {} };
      },
    },
  );

  assert.deepEqual(run.status(), { tx: "live", rx: "live" });
  assert.deepEqual(
    opened.map(({ direction, sourceEndpointId, sinkEndpointId }) => ({
      direction,
      sourceEndpointId,
      sinkEndpointId,
    })),
    [
      {
        direction: "tx",
        sourceEndpointId: "physical-mic",
        sinkEndpointId: "cable-a",
      },
      {
        direction: "rx",
        sourceEndpointId: "cable-b",
        sinkEndpointId: "headphones",
      },
    ],
  );
  assert.notEqual(opened[0].threadId, opened[1].threadId);
});

test("keeps a healthy channel live when its peer fails to start", async () => {
  let txStopped = false;
  const run = await startDualChannelRun(
    {
      tx: { sourceEndpointId: "physical-mic", sinkEndpointId: "cable-a" },
      rx: { sourceEndpointId: "cable-b", sinkEndpointId: "headphones" },
    },
    {
      openChannel: async ({ direction }) => {
        if (direction === "rx") throw new Error("RX entitlement denied");
        return {
          stop: async () => {
            txStopped = true;
          },
        };
      },
    },
  );

  assert.deepEqual(run.status(), { tx: "live", rx: "failed" });
  await run.stop();
  assert.equal(txStopped, true);
});

test("rejects cyclic endpoint routing before opening a channel", async () => {
  let openCount = 0;

  await assert.rejects(
    startDualChannelRun(
      {
        tx: { sourceEndpointId: "physical-mic", sinkEndpointId: "cable-a" },
        rx: { sourceEndpointId: "cable-a", sinkEndpointId: "headphones" },
      },
      {
        openChannel: async () => {
          openCount += 1;
          return { stop: async () => {} };
        },
      },
    ),
    /audio endpoints must be unique/i,
  );
  assert.equal(openCount, 0);
});

test("stops each live channel only once", async () => {
  const stops = { tx: 0, rx: 0 };
  const run = await startDualChannelRun(
    {
      tx: { sourceEndpointId: "physical-mic", sinkEndpointId: "cable-a" },
      rx: { sourceEndpointId: "cable-b", sinkEndpointId: "headphones" },
    },
    {
      openChannel: async ({ direction }) => ({
        stop: async () => {
          stops[direction] += 1;
        },
      }),
    },
  );

  await run.stop();
  await run.stop();

  assert.deepEqual(stops, { tx: 1, rx: 1 });
  assert.deepEqual(run.status(), { tx: "stopped", rx: "stopped" });
});
