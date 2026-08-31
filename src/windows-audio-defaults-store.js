import { JsonFileStore } from "./json-file-store.js";

const ROLE_FIELDS = ["consoleId", "multimediaId", "communicationsId"];
const PHASES = new Set(["applying", "active"]);
const MODES = new Set(["legacy", "meeting", "media", "microphone"]);

function endpointId(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function endpointRoles(value) {
  const roles = Object.fromEntries(
    ROLE_FIELDS.map((field) => [field, endpointId(value?.[field])]),
  );
  return Object.values(roles).every(Boolean) ? roles : undefined;
}

function snapshot(value) {
  const capture = endpointRoles(value?.capture);
  const render = endpointRoles(value?.render);
  return capture && render ? { capture, render } : undefined;
}

function legacyTarget(value) {
  const captureId = endpointId(value?.captureId);
  const renderId = endpointId(value?.renderId);
  return captureId && renderId
    ? {
        capture: Object.fromEntries(
          ROLE_FIELDS.map((field) => [field, captureId]),
        ),
        render: Object.fromEntries(
          ROLE_FIELDS.map((field) => [field, renderId]),
        ),
      }
    : undefined;
}

function normalize(value) {
  const original = snapshot(value?.snapshot);
  const legacy = legacyTarget(value?.target);
  const target = snapshot(value?.target) ?? legacy;
  const mode = value?.mode ?? (legacy ? "legacy" : undefined);
  if (!original || !target || !PHASES.has(value?.phase) || !MODES.has(mode)) {
    return undefined;
  }
  return { mode, phase: value.phase, snapshot: original, target };
}

export class WindowsAudioDefaultsStore extends JsonFileStore {
  constructor(options) {
    super({
      ...options,
      fileName: "windows-audio-defaults-restore.json",
      invalidResult: { invalid: true },
      normalize,
      validationMessage:
        "Invalid mode-scoped all-role Windows audio checkpoint",
    });
  }
}
