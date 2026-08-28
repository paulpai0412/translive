function isLocalOrigin(origin) {
  return typeof origin === "string" && origin.startsWith("file:");
}

export function allowsLocalAudioPermission({
  permission,
  origin,
  details = {},
}) {
  if (!isLocalOrigin(origin)) return false;
  if (permission === "speaker-selection") return true;
  if (permission !== "media") return false;
  let mediaTypes = details.mediaTypes;
  if (!Array.isArray(mediaTypes)) {
    mediaTypes = details.mediaType ? [details.mediaType] : [];
  }
  return mediaTypes.length > 0 && mediaTypes.every((type) => type === "audio");
}
