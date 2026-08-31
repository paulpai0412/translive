import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Windows RVC capability probe is read-only and emits redacted JSON", async () => {
  const script = await readFile(
    new URL("../scripts/probe-rvc-capability.ps1", import.meta.url),
    "utf8",
  );

  assert.match(script, /Get-CimInstance Win32_Processor/);
  assert.match(script, /Get-CimInstance Win32_VideoController/);
  assert.match(script, /rvc-runtime-trust\.json/);
  assert.match(script, /verify-rvc-python\.ps1/);
  assert.doesNotMatch(script, /runtime-manifest\.json/);
  assert.match(script, /TransLive\\rvc-runtime/);
  assert.match(script, /python/);
  assert.match(script, /ffmpeg/);
  assert.match(script, /torch_directml/);
  assert.match(script, /ConvertTo-Json -Compress/);
  assert.doesNotMatch(
    script,
    /Invoke-WebRequest|curl|pip install|winget install|git clone/i,
  );
  assert.doesNotMatch(
    script,
    /Copy-Item|Move-Item|Remove-Item|Set-Content|Out-File|Get-Command/i,
  );
  assert.match(script, /Has-ReparsePoint/);
  assert.match(script, /weightsOnlyLoader/);
  assert.match(
    script,
    /nvidiaPresent = \[bool\]\(\$gpu\.Name -match "NVIDIA"\)/,
  );
});
