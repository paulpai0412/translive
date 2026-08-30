const CREDENTIAL_PATTERNS = [
  [
    /["']?(authorization)["']?\s*[:=]\s*["']?(?:bearer\s+)?[^\s,;"']+["']?/gi,
    "$1: [已遮罩]",
  ],
  [
    /["']?(access_token|refresh_token|id_token|api[_-]?key|session[_-]?token|client_secret)["']?\s*[:=]\s*["']?[^\s,;"']+["']?/gi,
    "$1: [已遮罩]",
  ],
  [
    /\b(?:sk(?:-proj)?-[A-Za-z0-9_-]+|(?:gho|ghp|ghu|ghs)_[A-Za-z0-9_-]+)\b/gi,
    "[已遮罩]",
  ],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[已遮罩]"],
  [/\baccount(?:[ _-])?id\s*[:=]\s*["']?[^\s,;"']+/gi, "accountId: [已遮罩]"],
];

const SDP_LIKE_PATTERN =
  /(?:^|\n)\s*(?:SDP(?:\s+(?:offer|answer))?\s*[:=]\s*)?(?:v=0\b|o=[^\n]*\bIN\s+IP|s=-\b|t=\d|c=IN\s+IP(?:4|6)\b|m=(?:audio|video|application)\b|a=(?:candidate|ice-|fingerprint|rtpmap|fmtp|setup|mid):)/im;

export function sanitizeText(value, { maxLength = 100_000 } = {}) {
  const text = String(value ?? "");
  if (SDP_LIKE_PATTERN.test(text)) return "[已遮罩的協定內容]";
  const redacted = CREDENTIAL_PATTERNS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    text,
  );
  return redacted.slice(0, maxLength);
}
