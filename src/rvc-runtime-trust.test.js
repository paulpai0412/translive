import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { RVC_RUNTIME_TRUST } from "./rvc-runtime-trust.js";

test("anchors the local runtime receipt to packaged runner bytes and a complete pinned source set", async () => {
  const runner = await readFile(
    new URL("../scripts/rvc-training-runtime.py", import.meta.url),
  );
  assert.equal(
    createHash("sha256").update(runner).digest("hex"),
    RVC_RUNTIME_TRUST.runner.sha256,
  );
  assert.equal(RVC_RUNTIME_TRUST.source.files.length >= 200, true);
  assert.equal(RVC_RUNTIME_TRUST.assets.files.length >= 8, true);
  assert.equal(
    new Set(RVC_RUNTIME_TRUST.source.files.map((entry) => entry.path)).size,
    RVC_RUNTIME_TRUST.source.files.length,
  );
  assert.equal(
    RVC_RUNTIME_TRUST.source.hfRevision,
    "e6d0c1a17da07c33557852f9dfa2bd44cc75737d",
  );
  assert.match(RVC_RUNTIME_TRUST.source.treeSha256, /^[a-f0-9]{64}$/);
  assert.equal(RVC_RUNTIME_TRUST.pythonEnvironment.records.length >= 20, true);
  assert.match(RVC_RUNTIME_TRUST.pythonEnvironment.treeSha256, /^[a-f0-9]{64}$/);
  assert.equal(RVC_RUNTIME_TRUST.pythonEnvironment.importTree.fileCount, 28_476);
  assert.match(
    RVC_RUNTIME_TRUST.pythonEnvironment.importTree.sha256,
    /^[a-f0-9]{64}$/,
  );
});
