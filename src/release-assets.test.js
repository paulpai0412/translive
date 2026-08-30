import assert from "node:assert/strict";
import test from "node:test";

import { createIcoFromPng } from "./release-assets.js";

test("wraps a logo-derived PNG as a valid Windows ICO payload", () => {
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x40,
    0x00, 0x00, 0x00, 0x40,
  ]);
  const ico = createIcoFromPng(png);

  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 1);
  assert.equal(ico[6], 64);
  assert.equal(ico[7], 64);
  assert.equal(ico.readUInt32LE(14), png.length);
  assert.deepEqual(ico.subarray(22), png);
});

test("rejects PNG files without a valid signature and dimensions", () => {
  assert.throws(() => createIcoFromPng(Buffer.from("not-an-image")), /PNG/i);
});
