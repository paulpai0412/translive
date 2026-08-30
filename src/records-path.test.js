import assert from "node:assert/strict";
import test from "node:test";

import { recordsDirectory } from "./records-path.js";

test("uses LOCALAPPDATA TransLive meetings on Windows", () => {
  assert.equal(
    recordsDirectory({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" },
      fallback: "C:\\fallback",
    }),
    "C:\\Users\\Ada\\AppData\\Local\\TransLive\\meetings",
  );
});

test("uses the app user-data fallback outside Windows", () => {
  assert.equal(
    recordsDirectory({
      platform: "linux",
      env: {},
      fallback: "/tmp/translive" }),
    "/tmp/translive/meetings",
  );
});
