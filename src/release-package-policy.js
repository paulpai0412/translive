export async function assertPackagePolicy({
  assertWindowsCodexBundle,
  platform,
  policy,
  root,
}) {
  if (platform === "win32") {
    await assertWindowsCodexBundle({ appPath: root });
    return { policy: "release" };
  }
  if (policy !== "dev") {
    throw new Error("Non-Windows package builds require --policy=dev");
  }
  return { policy: "dev" };
}
