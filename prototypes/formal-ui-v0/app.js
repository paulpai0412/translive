const body = document.body;
const root = document.documentElement;
const diagnosticsDrawer = document.querySelector("#diagnostics-drawer");
const quickSetupModal = document.querySelector("#quick-setup-modal");
const drawerScrim = document.querySelector("#drawer-scrim");
const tweaksPanel = document.querySelector("#tweaks-panel");
const trayMenu = document.querySelector("#tray-menu");
const miniOverlay = document.querySelector("#mini-overlay");
const accountLabel = document.querySelector(".account-label");

body.dataset.currentView = "translate";

function setState(state) {
  body.dataset.appState = state;
  document.querySelector("#state-select").value = state;
  const connected = !["logged-out", "auth-waiting"].includes(state);
  accountLabel.textContent = connected ? "ChatGPT 已連線" : "尚未連線";
  if (state !== "live" && state !== "degraded")
    miniOverlay.classList.remove("is-open");
}

function setMode(mode) {
  body.dataset.mode = mode;
  document.querySelector("#mode-select").value = mode;
  document.querySelectorAll(".mode-option").forEach((button) => {
    const selected = button.dataset.mode === mode;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-selected", String(selected));
  });

  const title = document.querySelector(".mode-live-title");
  const source = document.querySelector(".single-source-label");
  const target = document.querySelector(".single-target-label");
  const summary = document.querySelector(".mode-summary");
  if (mode === "media") {
    title.textContent = "媒體翻譯";
    source.textContent = "原文 Source";
    target.textContent = "繁中 Translation";
    summary.textContent = "VoiceMeeter B1 → Poly BT600 · Cove";
  } else if (mode === "microphone") {
    title.textContent = "麥克風翻譯";
    source.textContent = "我說 Source";
    target.textContent = "對方將聽到 Translation";
    summary.textContent = "Poly BT600 → VoiceMeeter B2 · Cove";
  } else {
    summary.textContent = "VoiceMeeter · Cove";
  }
}

function setView(view) {
  body.dataset.currentView = view;
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("is-active", item.dataset.view === view);
  });
}

function updateScrim() {
  const open =
    diagnosticsDrawer.classList.contains("is-open") ||
    quickSetupModal.classList.contains("is-open");
  drawerScrim.classList.toggle("is-open", open);
}

function setDrawer(open) {
  diagnosticsDrawer.classList.toggle("is-open", open);
  diagnosticsDrawer.setAttribute("aria-hidden", String(!open));
  updateScrim();
}

function setQuickSetup(open) {
  quickSetupModal.classList.toggle("is-open", open);
  quickSetupModal.setAttribute("aria-hidden", String(!open));
  updateScrim();
}

function setTweaks(open) {
  tweaksPanel.classList.toggle("is-open", open);
  tweaksPanel.setAttribute("aria-hidden", String(!open));
}

function setTray(open) {
  trayMenu.classList.toggle("is-open", open);
  trayMenu.setAttribute("aria-hidden", String(!open));
}

function showAggregateSummary() {
  document.querySelector("#history-detail").innerHTML = `
    <div class="detail-tabs">
      <button>逐字稿</button><button>單場摘要</button><button class="is-active">匯整摘要</button>
    </div>
    <p class="section-kicker">v0 示意 · 2 場紀錄</p>
    <h2>跨場摘要匯整</h2>
    <div class="summary-outline">
      <section><strong>共同主題</strong><p>[依選取逐字稿產生的共同主題]</p></section>
      <section><strong>決策演變</strong><p>[按場次與時間戳排列]</p></section>
      <section><strong>未完成待辦</strong><p>[未指定負責人或期限時明確標示]</p></section>
      <section><strong>衝突與未決問題</strong><p>[只列來源中存在的差異]</p></section>
    </div>
    <div class="stopped-actions"><button class="secondary-button">匯出 Markdown</button><button class="text-button">重新產生</button><button class="text-button danger-text">刪除</button></div>`;
}

document.querySelectorAll(".mode-option").forEach((button) => {
  button.addEventListener("click", () => setMode(button.dataset.mode));
});

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view));
});

document.querySelector("#oauth-button").addEventListener("click", () => {
  setState("auth-waiting");
  document.querySelector("#auth-status-text").textContent = "等待瀏覽器確認";
  window.setTimeout(() => {
    document.querySelector("#auth-status-text").textContent = "ChatGPT 已連線";
    setState("ready");
  }, 1200);
});

document.querySelector("#start-button").addEventListener("click", () => {
  setState("connecting");
  window.setTimeout(() => setState("live"), 1400);
});

document
  .querySelector("#cancel-connect-button")
  .addEventListener("click", () => setState("ready"));
document
  .querySelector("#stop-button")
  .addEventListener("click", () => setState("stopped"));
document
  .querySelector("#restart-button")
  .addEventListener("click", () => setState("ready"));
document
  .querySelector("#reauth-button")
  .addEventListener("click", () => setState("logged-out"));

document
  .querySelector("#diagnostics-button")
  .addEventListener("click", () => setDrawer(true));
document
  .querySelectorAll(".diagnostics-trigger")
  .forEach((button) => button.addEventListener("click", () => setDrawer(true)));
document
  .querySelector("#close-diagnostics")
  .addEventListener("click", () => setDrawer(false));
drawerScrim.addEventListener("click", () => {
  setDrawer(false);
  setQuickSetup(false);
});

document
  .querySelector("#quick-setup-button")
  .addEventListener("click", () => setQuickSetup(true));
document
  .querySelector("#close-quick-setup")
  .addEventListener("click", () => setQuickSetup(false));
document
  .querySelector("#apply-quick-setup")
  .addEventListener("click", (event) => {
    const button = event.currentTarget;
    const step = document.querySelector("#quick-verify-step");
    step.className = "active";
    step.querySelector("small").textContent = "驗證中…";
    button.disabled = true;
    window.setTimeout(() => {
      step.className = "done";
      step.querySelector("small").textContent = "已套用並驗證";
      button.textContent = "完成";
      button.disabled = false;
    }, 900);
  });
document.querySelectorAll(".quick-app-switch button").forEach((button) => {
  button.addEventListener("click", () => {
    document
      .querySelectorAll(".quick-app-switch button")
      .forEach((item) => item.classList.toggle("is-active", item === button));
    document.querySelector("#quick-setup-title").textContent =
      `快速設定 ${button.textContent}`;
  });
});

document.querySelector("#mini-overlay-button").addEventListener("click", () => {
  miniOverlay.classList.add("is-open");
  miniOverlay.setAttribute("aria-hidden", "false");
});
document.querySelector("#close-mini").addEventListener("click", () => {
  miniOverlay.classList.remove("is-open");
  miniOverlay.setAttribute("aria-hidden", "true");
});

document
  .querySelector("#tray-button")
  .addEventListener("click", () =>
    setTray(!trayMenu.classList.contains("is-open")),
  );
trayMenu
  .querySelector("button")
  .addEventListener("click", () => setTray(false));
trayMenu.querySelectorAll("button")[3].addEventListener("click", () => {
  setState("stopped");
  setTray(false);
});

document
  .querySelector("#aggregate-summary-button")
  .addEventListener("click", showAggregateSummary);

document
  .querySelector("#tweaks-toggle")
  .addEventListener("click", () =>
    setTweaks(!tweaksPanel.classList.contains("is-open")),
  );
document
  .querySelector("#close-tweaks")
  .addEventListener("click", () => setTweaks(false));
document.querySelector("#state-select").addEventListener("change", (event) => {
  setView("translate");
  setState(event.target.value);
});
document
  .querySelector("#mode-select")
  .addEventListener("change", (event) => setMode(event.target.value));
document.querySelector("#theme-select").addEventListener("change", (event) => {
  root.dataset.theme = event.target.value;
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  setDrawer(false);
  setQuickSetup(false);
  setTweaks(false);
  setTray(false);
});

setMode("meeting");
setState("logged-out");
