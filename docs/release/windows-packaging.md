# Windows packaging and signing

## Build a directory package

```powershell
npm ci
npm test
npm run check
node scripts/generate-codex-manifest.mjs --input <approved-codex.exe> --signature <approved-codex.exe.sig> --version <x.y.z>
npm run package:dir -- --platform=win32 --arch=x64
npm run package:smoke -- --platform=win32 --arch=x64
```

For a Linux smoke package in CI or development:

```bash
npm run package:verify
```

Linux packaging is an explicit `dev` policy used only for packaging smoke tests. A packaged production app may not fall back to PATH or `TRANSLIVE_CODEX_BIN` unless the release operator explicitly opts into the external packaged test policy.

The package directory is written under `release/` and is intentionally ignored by Git.

## Packaged contents

The package allowlist includes only:

- `package.json` with `productName: TransLive`, version, and `translive.appId`;
- production `src/` JavaScript (never `*.test.*`);
- `assets/translive-brand/` including the logo-derived Windows ICO;
- `scripts/windows-meeting-devices.ps1` required for meeting quick setup;
- `assets/codex/manifest.json`, `assets/codex/win32/codex.exe`, and its detached signing input when producing a Windows package.

It excludes `node_modules/` (including `.cache/jiti`), tests, fixtures, docs, research, `.pi`, `.scratch`, `release`, `.translive-evidence`, `.env*`, and source-control files. The smoke script fails if excluded paths or `/home/<user>/.pi/` harness paths appear below the packaged app directory.

## App identity and icons

- Product name: `TransLive`
- Windows AppUserModelID: `com.paulpai.translive`
- Source mark: `assets/translive-brand/translive-mark.svg`
- Tray raster: `assets/translive-brand/translive-tray.png`
- Windows package icon: `assets/translive-brand/translive.ico`

`npm run package:dir` regenerates the ICO from the committed tray PNG before packaging. The ICO contains the logo-derived 64px PNG payload and is suitable for the current beta directory package.

## Bundled Codex integrity

Windows packaging fails before Electron packaging when the bundled Codex manifest, `codex.exe`, detached signing input, version, or SHA-256 checksum is missing or invalid. The app verifies the copied executable checksum before launching it in a packaged Windows build. It never silently falls back to an environment variable or PATH executable in that production path.

`generate-codex-manifest.mjs` copies an approved signed binary and signing input into `assets/codex/win32/`, then writes the manifest checksum. This is a release-operator operation: do not run it with an unverified executable and do not commit or distribute a binary until its license and OpenAI product permission have been approved.

## Code signing

Code signing is an external release credential operation. Do **not** put certificate files, passwords, Azure Key Vault credentials, or signing tokens in this repository, `.env`, diagnostics, or Electron renderer state.

A release operator supplies the certificate from a secure CI secret or hardware-backed signing system, then signs the generated Windows executable after the package directory is built. A typical external step is:

```powershell
signtool sign /fd SHA256 /tr <approved-timestamp-url> /td SHA256 /f <secure-certificate-path> /p <secret> <packaged-exe>
signtool verify /pa /v <packaged-exe>
```

The exact certificate provider, timestamp URL, and release approval are deployment decisions outside this codebase. Unsigned directory packages are valid for development and internal testing only.
