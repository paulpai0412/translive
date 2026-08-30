import { sanitizeText } from "./text-sanitizer.js";

const CHANNEL_STATES = new Set([
  "connecting",
  "disabled",
  "failed",
  "live",
  "muted",
  "stopped",
  "stopping",
]);
const DIRECTIONS = new Set(["tx", "rx", "system"]);
const MAX_ERRORS = 20;

function safeText(value, maxLength = 256) {
  return sanitizeText(value ?? "", { maxLength }).trim() || "未提供";
}

function safeNumber(value) {
  return Number.isFinite(value) ? value : undefined;
}

function safeMetrics(value) {
  if (!value || typeof value !== "object") return {};
  const output = {};
  for (const [key, metric] of Object.entries(value)) {
    if (!metric || typeof metric !== "object") continue;
    const values = Object.fromEntries(
      Object.entries(metric).filter(
        ([, item]) => safeNumber(item) !== undefined,
      ),
    );
    if (Object.keys(values).length > 0) output[key] = values;
  }
  return output;
}

function safeChannelStates(status) {
  return Object.fromEntries(
    ["tx", "rx"].map((direction) => [
      direction,
      CHANNEL_STATES.has(status?.[direction]) ? status[direction] : "stopped",
    ]),
  );
}

function safeEndpoints(endpoints) {
  if (!Array.isArray(endpoints)) return [];
  return endpoints.slice(0, 8).flatMap((endpoint) => {
    if (
      typeof endpoint?.role !== "string" ||
      typeof endpoint?.kind !== "string" ||
      typeof endpoint?.idHash !== "string"
    ) {
      return [];
    }
    return [
      {
        idHash: endpoint.idHash,
        kind: endpoint.kind,
        role: endpoint.role,
      },
    ];
  });
}

function safeErrors(errors) {
  if (!Array.isArray(errors)) return [];
  return errors.slice(-MAX_ERRORS).flatMap((error) => {
    if (!DIRECTIONS.has(error?.direction)) return [];
    const message = safeText(error.message, 500);
    return [
      {
        direction: error.direction,
        message: message.includes("[已遮罩]") ? "[已遮罩的敏感內容]" : message,
      },
    ];
  });
}

export function buildDiagnostics({
  accountState,
  appVersion,
  evidence,
  status,
} = {}) {
  const route = evidence?.route ?? {};
  return {
    accountState: safeText(accountState),
    appVersion: safeText(appVersion),
    channelStates: safeChannelStates(status),
    codex: {
      checksum: safeText(evidence?.codex?.checksum),
      version: safeText(evidence?.codex?.version),
    },
    endpoints: safeEndpoints(evidence?.endpoints),
    errors: safeErrors(evidence?.errors),
    metrics: safeMetrics(evidence?.metrics),
    pacing: safeMetrics(evidence?.pacing),
    route: {
      mode: safeText(route.mode),
      platform: safeText(route.platform),
      profile: safeText(route.routeProfile),
    },
    schemaVersion: 1,
    termination: {
      outcome: safeText(evidence?.termination?.outcome),
      reason: safeText(evidence?.termination?.reason, 500),
    },
  };
}

export function diagnosticMarkdown(bundle) {
  const lines = [
    "# TransLive 遮罩診斷包",
    "",
    `App：${bundle.appVersion}`,
    `帳戶：${bundle.accountState}`,
    `模式：${bundle.route.mode}`,
    `平台：${bundle.route.platform}`,
    `路由：${bundle.route.profile}`,
    `TX：${bundle.channelStates.tx}`,
    `RX：${bundle.channelStates.rx}`,
    `Codex：${bundle.codex.version}`,
  ];
  if (bundle.errors.length > 0) {
    lines.push("", "## 錯誤");
    for (const error of bundle.errors) {
      lines.push(`- ${error.direction.toUpperCase()}：${error.message}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
