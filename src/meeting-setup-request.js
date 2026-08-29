function endpointName(value) {
  if (
    typeof value?.name !== "string" ||
    value.name.trim().length === 0 ||
    value.name.length > 500
  ) {
    throw new Error("快速設定需要有效的虛擬裝置名稱");
  }
  return { name: value.name.trim() };
}

export function sanitizeMeetingSetupRequest(setup) {
  if (!setup || !["teams", "zoom"].includes(setup.app)) {
    throw new Error("僅支援 Microsoft Teams 或 Zoom 快速設定");
  }
  return {
    app: setup.app,
    endpoints: {
      microphone: endpointName(setup.endpoints?.microphone),
      speaker: endpointName(setup.endpoints?.speaker),
    },
    restoreOnStop: setup.restoreOnStop !== false,
  };
}
