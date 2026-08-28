import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    }),
  );
  return nested.flat();
}

const fileGroups = await Promise.all([
  filesUnder("src"),
  filesUnder("scripts"),
  filesUnder("fixtures"),
]);
const javascript = fileGroups
  .flat()
  .filter(
    (file) =>
      file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs"),
  );
for (const file of javascript) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

const packageJson = await readFile("package.json", "utf8");
try {
  JSON.parse(packageJson);
} catch (error) {
  throw new Error(`package.json is not valid JSON: ${error.message}`);
}
const jsConfig = await readFile("jsconfig.json", "utf8");
try {
  JSON.parse(jsConfig);
} catch (error) {
  throw new Error(`jsconfig.json is not valid JSON: ${error.message}`);
}
const html = await readFile("src/index.html", "utf8");
const main = await readFile("src/main.js", "utf8");
if (!main.includes('preload: join(sourceDirectory, "preload.cjs")')) {
  throw new Error("main.js must load the restricted preload bridge");
}
if (!html.includes('src="./renderer-entry.js"')) {
  throw new Error("index.html must load the renderer entrypoint");
}
if (
  !html.includes("Content-Security-Policy") ||
  !html.includes("script-src 'self'")
) {
  throw new Error("index.html must keep a restrictive Content-Security-Policy");
}
if (/<script(?![^>]*\bsrc=)/i.test(html)) {
  throw new Error("index.html must not contain inline scripts");
}
const gitignore = await readFile(".gitignore", "utf8");
if (!gitignore.includes(".translive-evidence/")) {
  throw new Error(".gitignore must exclude local evidence");
}

process.stdout.write(
  `Static check passed for ${javascript.length} JavaScript files, package JSON, Electron entrypoints, HTML CSP, and evidence ignore.\n`,
);
