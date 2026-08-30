import assert from "node:assert/strict";
import test from "node:test";

import { assertPackagePolicy } from "./release-package-policy.js";

test("Windows release packaging requires the verified bundled Codex asset", async () => {
  let bundleChecks = 0;
  const result = await assertPackagePolicy({
    assertWindowsCodexBundle: async ({ appPath }) => {
      bundleChecks += 1;
      assert.equal(appPath, "/repo");
    },
    platform: "win32",
    policy: "release",
    root: "/repo",
  });

  assert.equal(bundleChecks, 1);
  assert.deepEqual(result, { policy: "release" });
});

test("Linux packaging is allowed only through explicit dev policy", async () => {
  await assert.rejects(
    assertPackagePolicy({
      assertWindowsCodexBundle: async () => {},
      platform: "linux",
      policy: "release",
      root: "/repo",
    }),
    /policy=dev/i,
  );
  assert.deepEqual(
    await assertPackagePolicy({
      assertWindowsCodexBundle: async () => {
        throw new Error("should not verify Windows asset");
      },
      platform: "linux",
      policy: "dev",
      root: "/repo",
    }),
    { policy: "dev" },
  );
});
