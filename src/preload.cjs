const { contextBridge, ipcRenderer } = require("electron");

// Sandboxed Electron preloads may only require Electron's whitelisted module.
// Validate the bounded binary handoff here before any renderer request crosses
// IPC; main repeats the same check at its trust boundary.
const MAX_RECORDING_IPC_BYTES = 64 * 1024 * 1024;
function validateVoiceTrainingStopRequest(request) {
  const bytes = request?.recording?.bytes;
  if (
    typeof request?.id !== "string" ||
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_RECORDING_IPC_BYTES
  ) {
    throw new Error("VOICE_TRAINING_IPC_INVALID_RECORDING");
  }
  return { id: request.id, recording: { bytes } };
}

contextBridge.exposeInMainWorld("translive", {
  accountStatus: () => ipcRenderer.invoke("translive:account-status"),
  accountLogin: () => ipcRenderer.invoke("translive:account-login"),
  accountLogout: () => ipcRenderer.invoke("translive:account-logout"),
  accountLoginCancel: () =>
    ipcRenderer.invoke("translive:account-login-cancel"),
  audioDefaultsStatus: () =>
    ipcRenderer.invoke("translive:audio-defaults-status"),
  voiceMeeterRoutingStatus: () =>
    ipcRenderer.invoke("translive:voicemeeter-routing-status"),
  voiceConversionStatus: () =>
    ipcRenderer.invoke("translive:voice-conversion-status"),
  voiceConversionSetEnabled: (request) =>
    ipcRenderer.invoke("translive:voice-conversion-set-enabled", request),
  voiceProfileImport: (request) =>
    ipcRenderer.invoke("translive:voice-profile-import", request),
  voiceProfileDelete: (request) =>
    ipcRenderer.invoke("translive:voice-profile-delete", request),
  voiceTrainingStatus: () =>
    ipcRenderer.invoke("translive:voice-training-status"),
  voiceTrainingStartRecording: (request) =>
    ipcRenderer.invoke("translive:voice-training-start-recording", request),
  voiceTrainingPauseRecording: (id) =>
    ipcRenderer.invoke("translive:voice-training-pause-recording", id),
  voiceTrainingResumeRecording: (id) =>
    ipcRenderer.invoke("translive:voice-training-resume-recording", id),
  voiceTrainingStopRecording: (request) =>
    ipcRenderer.invoke(
      "translive:voice-training-stop-recording",
      validateVoiceTrainingStopRequest(request),
    ),
  voiceTrainingStart: (request) =>
    ipcRenderer.invoke("translive:voice-training-start", request),
  voiceTrainingCancel: () =>
    ipcRenderer.invoke("translive:voice-training-cancel"),
  voiceTrainingDelete: (request) =>
    ipcRenderer.invoke("translive:voice-training-delete", request),
  miniCaptionShow: (snapshot) =>
    ipcRenderer.invoke("translive:mini-caption-show", snapshot),
  miniCaptionUpdate: (snapshot) =>
    ipcRenderer.send("translive:mini-caption-update", snapshot),
  preflight: (config) => ipcRenderer.invoke("translive:preflight", config),
  start: (config) => ipcRenderer.invoke("translive:start", config),
  answerApplied: (direction) =>
    ipcRenderer.invoke("translive:answer-applied", direction),
  stop: () => ipcRenderer.invoke("translive:stop"),
  cancelStart: () => ipcRenderer.invoke("translive:cancel-start"),
  setMuted: (direction, muted) =>
    ipcRenderer.invoke("translive:set-muted", direction, muted),
  meetingSetupApply: (setup) =>
    ipcRenderer.invoke("translive:meeting-setup-apply", setup),
  meetingSetupRestore: () =>
    ipcRenderer.invoke("translive:meeting-setup-restore"),
  meetingSetupOpenSettings: (appName) =>
    ipcRenderer.invoke("translive:meeting-setup-open-settings", appName),
  diagnosticsExport: () => ipcRenderer.invoke("translive:diagnostics-export"),
  recordsConsentStatus: () =>
    ipcRenderer.invoke("translive:records-consent-status"),
  recordsRetentionStatus: () =>
    ipcRenderer.invoke("translive:records-retention-status"),
  recordsConsentGrant: (request) =>
    ipcRenderer.invoke("translive:records-consent-grant", request),
  recordsList: () => ipcRenderer.invoke("translive:records-list"),
  recordsRead: (id) => ipcRenderer.invoke("translive:records-read", id),
  recordsDelete: (id) => ipcRenderer.invoke("translive:records-delete", id),
  recordsDeleteAll: (request) =>
    ipcRenderer.invoke("translive:records-delete-all", request),
  recordsOpenFolder: (id) =>
    ipcRenderer.invoke("translive:records-open-folder", id),
  recordsExport: (id) => ipcRenderer.invoke("translive:records-export", id),
  aggregatesList: () => ipcRenderer.invoke("translive:aggregates-list"),
  aggregatesRead: (id) => ipcRenderer.invoke("translive:aggregates-read", id),
  aggregatesDelete: (id) =>
    ipcRenderer.invoke("translive:aggregates-delete", id),
  aggregatesExport: (id) =>
    ipcRenderer.invoke("translive:aggregates-export", id),
  aggregatesOpenFolder: (id) =>
    ipcRenderer.invoke("translive:aggregates-open-folder", id),
  summarySessionStart: (request) =>
    ipcRenderer.invoke("translive:summary-session-start", request),
  summaryAggregateStart: (request) =>
    ipcRenderer.invoke("translive:summary-aggregate-start", request),
  summaryCancel: (requestId) =>
    ipcRenderer.invoke("translive:summary-cancel", requestId),
  assistantStart: (config) =>
    ipcRenderer.invoke("translive:assistant-start", config),
  assistantStop: () => ipcRenderer.invoke("translive:assistant-stop"),
  assistantPending: () => ipcRenderer.invoke("translive:assistant-pending"),
  assistantApprove: (id) =>
    ipcRenderer.invoke("translive:assistant-approve", id),
  assistantReject: (id) => ipcRenderer.invoke("translive:assistant-reject", id),
  assistantSpeakConclusions: () =>
    ipcRenderer.invoke("translive:assistant-speak-conclusions"),
  assistantSetWakeArmed: (armed) =>
    ipcRenderer.invoke("translive:assistant-set-wake-armed", armed),
  assistantPreferencesLoad: () =>
    ipcRenderer.invoke("translive:assistant-preferences-load"),
  assistantPreferencesSave: (request) =>
    ipcRenderer.invoke("translive:assistant-preferences-save", request),
  trayStatus: () => ipcRenderer.invoke("translive:tray-status"),
  traySetCloseBehavior: (behavior) =>
    ipcRenderer.invoke("translive:tray-set-close-behavior", behavior),
  trayShow: () => ipcRenderer.invoke("translive:tray-show"),
  recordMetric: (metric) => ipcRenderer.send("translive:metric", metric),
  rendererError: (direction, message) =>
    ipcRenderer.send("translive:renderer-error", { direction, message }),
  rendererBlocked: (config, reason) =>
    ipcRenderer.send("translive:renderer-blocked", { config, reason }),
  rendererControlAck: (acknowledgement) =>
    ipcRenderer.send("translive:renderer-control-ack", acknowledgement),
  onEvent: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("translive:event", handler);
    return () => ipcRenderer.removeListener("translive:event", handler);
  },
});
