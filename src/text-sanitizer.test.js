import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeText } from "./text-sanitizer.js";

test("replaces an entire SDP-like payload instead of preserving its surrounding lines", () => {
  const payload = [
    "normal-looking heading",
    "v=0",
    "o=- 123 456 IN IP4 127.0.0.1",
    "a=candidate:secret-candidate",
  ].join("\n");

  assert.equal(sanitizeText(payload), "[已遮罩的協定內容]");
});

test("redacts credentials while preserving ordinary transcript text", () => {
  assert.equal(
    sanitizeText("請確認 Authorization: Bearer sk-secret-value 的設定"),
    "請確認 Authorization: [已遮罩] 的設定",
  );
  assert.equal(
    sanitizeText('"access_token": "short-token" refresh_token=refresh'),
    "access_token: [已遮罩] refresh_token: [已遮罩]",
  );
  assert.equal(sanitizeText("正常的逐字稿內容。"), "正常的逐字稿內容。");
});

test("replaces raw SDP field lines including connection and data-channel fields", () => {
  for (const field of [
    "c=IN IP4 203.0.113.7",
    "a=setup:actpass",
    "a=mid:audio-0",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "SDP: c=IN IP6 2001:db8::1",
  ]) {
    assert.equal(sanitizeText(field), "[已遮罩的協定內容]");
  }
});
