import { execFile as defaultExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve, win32 } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(defaultExecFile);

export function codexLaunchOptions({ platform = process.platform } = {}) {
  // Codex CLI configuration is operator-controlled. npm exposes its Windows CLI as a .cmd shim.
  return { shell: platform === "win32", windowsHide: true };
}

function isAbsoluteForPlatform(path, platform) {
  return platform === "win32"
    ? win32.isAbsolute(path) || isAbsolute(path)
    : isAbsolute(path);
}

async function firstAccessible(candidates) {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return realpath(candidate);
    } catch {
      // Try the next PATH candidate.
    }
  }
  return undefined;
}

export async function resolveCodexExecutable(
  executable,
  { platform = process.platform, env = process.env } = {},
) {
  const value = String(executable);
  if (isAbsoluteForPlatform(value, platform) || /[\\/]/.test(value)) {
    return firstAccessible([value, resolve(value)]);
  }

  const pathValue = env.PATH ?? env.Path ?? "";
  const directories = pathValue
    .split(platform === "win32" ? ";" : delimiter)
    .filter(Boolean);
  const extensions =
    platform === "win32" && !/\.(?:cmd|exe|bat)$/i.test(value)
      ? ["", ".cmd", ".exe", ".bat"]
      : [""];
  return firstAccessible(
    directories.flatMap((directory) =>
      extensions.map((extension) => join(directory, `${value}${extension}`)),
    ),
  );
}

async function checksumFile(file) {
  return new Promise((resolveChecksum, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolveChecksum(hash.digest("hex")));
  });
}

export async function inspectCodexRuntime({
  executable,
  cwd,
  platform = process.platform,
  runCommand = execFile,
  includeChecksum = true,
} = {}) {
  const options = { cwd, timeout: 5_000, ...codexLaunchOptions({ platform }) };
  const versionResult = await runCommand(executable, ["--version"], options);
  const loginResult = await runCommand(
    executable,
    ["login", "status"],
    options,
  );
  const version = String(versionResult.stdout).trim();
  const semanticVersion = version.match(/(\d+\.\d+\.\d+)/)?.[1];
  const resolvedExecutable = includeChecksum
    ? await resolveCodexExecutable(executable, { platform })
    : undefined;
  const checksum = resolvedExecutable
    ? await checksumFile(resolvedExecutable)
    : undefined;

  const loginStatus = `${loginResult.stdout ?? ""}\n${loginResult.stderr ?? ""}`;
  const runtime = {
    executable: String(executable),
    version,
    semanticVersion,
    loggedIn:
      /^logged in(?:\s|$)/im.test(loginStatus) &&
      !/^not logged in(?:\s|$)/im.test(loginStatus),
  };
  if (checksum) runtime.checksum = checksum;
  return runtime;
}
