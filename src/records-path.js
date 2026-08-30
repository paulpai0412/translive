import { posix, win32 } from "node:path";

export function recordsDirectory({
  platform = process.platform,
  env = process.env,
  fallback,
} = {}) {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    if (typeof localAppData === "string" && localAppData.length > 0) {
      return win32.join(localAppData, "TransLive", "meetings");
    }
  }
  return posix.join(fallback, "meetings");
}
