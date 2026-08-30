import { JsonFileStore } from "./json-file-store.js";

const ROLE_FIELDS = ["consoleId", "multimediaId", "communicationsId"];
const PHASES = new Set(["applying", "active"]);

function endpointId(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function endpointRoles(value) {
  const roles = Object.fromEntries(
    ROLE_FIELDS.map((field) => [field, endpointId(value?.[field])]),
  );
  return Object.values(roles).every(Boolean) ? roles : undefined;
}

function target(value) {
  const captureId = endpointId(value?.captureId);
  const renderId = endpointId(value?.renderId);
  return captureId && renderId ? { captureId, renderId } : undefined;
}

function normalize(value) {
  const snapshot = {
    capture: endpointRoles(value?.snapshot?.capture),
    render: endpointRoles(value?.snapshot?.render),
  };
  const routingTarget = target(value?.target);
  if (
    !snapshot.capture ||
    !snapshot.render ||
    !routingTarget ||
    !PHASES.has(value?.phase)
  ) {
    return undefined;
  }
  return { phase: value.phase, snapshot, target: routingTarget };
}

export class WindowsAudioDefaultsStore extends JsonFileStore {
  constructor(options) {
    super({
      ...options,
      fileName: "windows-audio-defaults-restore.json",
      invalidResult: { invalid: true },
      normalize,
      validationMessage:
        "Invalid phase-aware all-role Windows audio checkpoint",
    });
  }
}
