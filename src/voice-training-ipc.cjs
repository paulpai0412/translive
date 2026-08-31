const MAX_RECORDING_IPC_BYTES = 64 * 1024 * 1024;

function invalidRecording() {
  throw new Error("VOICE_TRAINING_IPC_INVALID_RECORDING");
}

function validateVoiceTrainingStopRequest(request) {
  if (!request || typeof request.id !== "string") invalidRecording();
  const bytes = request.recording?.bytes;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    invalidRecording();
  }
  if (bytes.byteLength > MAX_RECORDING_IPC_BYTES) invalidRecording();
  return { id: request.id, recording: { bytes } };
}

module.exports = {
  MAX_RECORDING_IPC_BYTES,
  validateVoiceTrainingStopRequest,
};
