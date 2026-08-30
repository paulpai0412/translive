function hasActiveTranslation(status) {
  return Object.values(status ?? {}).some((state) =>
    ["connecting", "live", "muted", "stopping"].includes(state),
  );
}

export class TranslationLifecycle {
  #controller;
  #disposeSummaries;
  #rendererControls;
  #restoreMeetingDevices;
  #publish;

  constructor({
    controller,
    disposeSummaries = async () => {},
    rendererControls,
    restoreMeetingDevices,
    publish = () => {},
  }) {
    this.#controller = controller;
    this.#disposeSummaries = disposeSummaries;
    this.#rendererControls = rendererControls;
    this.#restoreMeetingDevices = restoreMeetingDevices;
    this.#publish = publish;
  }

  async setMuted(direction, muted) {
    await this.#rendererControls.request({ action: "mute", direction, muted });
    return this.#controller.setMuted(direction, muted);
  }

  async stop(
    reason = "user-stop",
    {
      controlAction = "stop",
      forceRendererControl = false,
      rendererControl = true,
    } = {},
  ) {
    const status = this.#controller.status();
    if (
      rendererControl &&
      (forceRendererControl || hasActiveTranslation(status))
    ) {
      try {
        await this.#rendererControls.request({ action: controlAction, reason });
      } catch {
        // A destroyed renderer cannot retain live local peers. Main cleanup continues.
      }
    }

    let result;
    let stopError;
    try {
      result = await this.#controller.stop(reason);
    } catch (error) {
      stopError = error;
    }
    const meetingRestore = await this.#restoreMeetingDevices();
    if (stopError) throw stopError;
    return { ...result, meetingRestore };
  }

  async logout(accountController) {
    let cleanupWarning = false;
    try {
      await accountController.cancelLogin();
    } catch {
      cleanupWarning = true;
    }
    try {
      await this.#disposeSummaries();
    } catch {
      cleanupWarning = true;
    }
    try {
      const stopped = await this.stop("account-logout", {
        controlAction: "logout",
        forceRendererControl: true,
      });
      cleanupWarning ||= Boolean(stopped.meetingRestore?.reason);
    } catch {
      cleanupWarning = true;
    }
    const account = await accountController.logout({
      cancelPendingLogin: false,
    });
    if (cleanupWarning) {
      this.#publish({
        type: "cleanup",
        state: "warning",
        message: "已登出，但部分本機清理未完成。請開啟診斷確認。",
      });
    }
    return { ...account, cleanupWarning };
  }
}
