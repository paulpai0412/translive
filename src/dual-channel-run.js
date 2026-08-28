import { randomUUID } from "node:crypto";

export async function startDualChannelRun(config, { openChannel }) {
  const endpoints = [
    config.tx.sourceEndpointId,
    config.tx.sinkEndpointId,
    config.rx.sourceEndpointId,
    config.rx.sinkEndpointId,
  ];
  if (new Set(endpoints).size !== endpoints.length) {
    throw new Error("Audio endpoints must be unique");
  }

  const directions = ["tx", "rx"];
  const outcomes = await Promise.allSettled(
    directions.map((direction) =>
      openChannel({
        direction,
        threadId: `translive-${direction}-${randomUUID()}`,
        ...config[direction],
      }),
    ),
  );
  const states = Object.fromEntries(
    directions.map((direction, index) => [
      direction,
      outcomes[index].status === "fulfilled" ? "live" : "failed",
    ]),
  );

  let stopPromise;

  return {
    status: () => ({ ...states }),
    stop: () => {
      stopPromise ??= Promise.all(
        outcomes
          .filter((outcome) => outcome.status === "fulfilled")
          .map(({ value }) => value.stop()),
      ).then(() => {
        directions.forEach((direction, index) => {
          if (outcomes[index].status === "fulfilled") states[direction] = "stopped";
        });
      });
      return stopPromise;
    },
  };
}
