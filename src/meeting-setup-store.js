import { JsonFileStore } from "./json-file-store.js";

function normalize(value) {
  if (
    !["teams", "zoom"].includes(value?.app) ||
    typeof value?.snapshot?.captureId !== "string" ||
    typeof value?.snapshot?.renderId !== "string"
  ) {
    return undefined;
  }
  return {
    app: value.app,
    snapshot: {
      captureId: value.snapshot.captureId,
      renderId: value.snapshot.renderId,
    },
  };
}

export class MeetingSetupStore extends JsonFileStore {
  constructor(options) {
    super({
      ...options,
      fileName: "meeting-device-restore.json",
      normalize,
      validationMessage: "Invalid meeting device restore snapshot",
    });
  }
}
