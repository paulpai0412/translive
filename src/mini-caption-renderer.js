const elements = {
  mode: document.querySelector("#mini-mode"),
  primary: document.querySelector("#mini-primary"),
  secondary: document.querySelector("#mini-secondary"),
  status: document.querySelector("#mini-status"),
  returnMain: document.querySelector("#return-main"),
};

function render({ mode, primary, secondary, status } = {}) {
  elements.mode.textContent = mode || "TransLive";
  elements.status.textContent = status || "等待翻譯";
  elements.primary.textContent = primary || "等待翻譯字幕…";
  elements.secondary.textContent = secondary || "";
}

elements.returnMain.addEventListener("click", () => {
  window.transliveMini.returnToMain();
});
window.transliveMini.onCaption(render);
