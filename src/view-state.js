const CHANNEL_LABELS = Object.freeze({
  connecting: "連線中",
  disabled: "未啟用",
  failed: "已中斷",
  live: "翻譯中",
  muted: "已靜音",
  stopped: "已停止",
  stopping: "正在停止",
});

const MODE_LABELS = Object.freeze({
  meeting: "雙向會議",
  media: "媒體翻譯",
  microphone: "麥克風翻譯",
});

export function channelStateLabel(state) {
  return CHANNEL_LABELS[state] ?? "狀態未知";
}

export function diagnosticEventLabel(type) {
  return (
    {
      account: "帳戶狀態更新",
      blocked: "連線受阻",
      "meeting-setup": "會議裝置設定",
      record: "紀錄已保存",
      summary: "摘要狀態更新",
      error: "錯誤",
      run: "翻譯連線已建立",
      sdp: "音訊連線協商",
      state: "通道狀態更新",
      stopped: "翻譯已停止",
      transcript: "字幕更新",
      tray: "系統匣操作",
    }[type] ?? "系統事件"
  );
}

export function modeLabel(mode) {
  return MODE_LABELS[mode] ?? "翻譯";
}

export function runStatePresentation({ appState, mode, status = {} }) {
  if (appState === "degraded") {
    if (mode === "media") {
      return {
        title: "媒體翻譯已中斷",
        detail: "目前媒體音訊不會翻譯至繁中，請重新建立翻譯連線。",
        level: "warning",
      };
    }
    if (mode === "microphone") {
      return {
        title: "麥克風翻譯已中斷",
        detail: "對方暫時不會聽到翻譯語音，請重新建立翻譯連線。",
        level: "warning",
      };
    }
    if (status.rx === "failed") {
      return {
        title: "接收翻譯已中斷",
        detail: "對方仍能聽到你的翻譯，但你暫時聽不到繁中翻譯。",
        level: "warning",
      };
    }
    return {
      title: "送出翻譯已中斷",
      detail: "你仍能聽到繁中翻譯，但對方暫時聽不到你的翻譯。",
      level: "warning",
    };
  }

  if (appState === "blocked") {
    return {
      title: "無法建立翻譯連線",
      detail: "請檢查登入、音訊裝置和路由設定。音訊尚未傳送。",
      level: "danger",
    };
  }

  return {
    title: appState === "live" ? "翻譯中" : modeLabel(mode),
    detail: "",
    level: "neutral",
  };
}
