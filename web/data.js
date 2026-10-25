/**
 * 页面 2「数据」: 查看本地数据覆盖情况, 执行初始化 / 增量补充 / 取消任务。
 *
 * 共用工具 (api / showAlert / bindElements / boot / watchSync 等) 在 shared.js。
 */

const state = {
  coverage: null,
  stopSyncWatch: null,
};

const ELEMENT_IDS = [
  "alert-area",
  "coverage-text",
  "init-button",
  "update-button",
  "cancel-button",
  "progress",
  "progress-fill",
  "progress-text",
];

const REQUIRED_IDS = [
  "alert-area",
  "coverage-text",
  "init-button",
  "update-button",
  "cancel-button",
  "progress",
  "progress-fill",
  "progress-text",
];

/* ------------------------------------------------------------- 数据状态 */

async function refreshCoverage() {
  try {
    state.coverage = await api("/api/data/coverage");
  } catch (error) {
    el.coverageText.textContent = `无法读取本地数据状态: ${error.message}`;
    return;
  }

  const coverage = state.coverage;
  if (coverage.trading_days === 0) {
    el.coverageText.innerHTML =
      "本地还没有数据。点击 <strong>初始化 (下载最近两年)</strong> 开始首次下载。" +
      "首次下载需要联网拉取全市场日线行情, 耗时较长, 请保持窗口开启。";
  } else if (coverage.bar_count === 0) {
    el.coverageText.innerHTML =
      `交易日历已就绪 (${coverage.trading_days} 个交易日), 但尚无行情数据, 请执行数据更新。`;
  } else {
    el.coverageText.innerHTML =
      `本地行情覆盖 <strong>${coverage.bar_start} ~ ${coverage.bar_end}</strong>, ` +
      `共 <strong>${coverage.bar_count.toLocaleString("zh-CN")}</strong> 条日线, ` +
      `覆盖 <strong>${coverage.stock_count.toLocaleString("zh-CN")}</strong> 只沪深A股, ` +
      `已完成 <strong>${coverage.complete_days}</strong> 个交易日` +
      (coverage.last_sync_at
        ? ` · 最近更新: ${formatDateTime(coverage.last_sync_at)}`
        : "");
  }
}

/* ------------------------------------------------------------- 同步任务 */

function setSyncButtons(running) {
  el.initButton.disabled = running;
  el.updateButton.disabled = running;
  el.cancelButton.hidden = !running;
}

function showProgress(progress) {
  el.progress.hidden = false;
  el.progressFill.style.width = `${progress.percent}%`;
  const parts = [
    `${progress.mode_label}`,
    `阶段: ${phaseLabel(progress.phase)}`,
    progress.total_stocks > 0
      ? `股票进度 ${progress.done_stocks}/${progress.total_stocks}`
      : "",
    progress.total_days > 0
      ? `交易日 ${progress.done_days}/${progress.total_days}`
      : "",
    progress.message || "",
  ].filter(Boolean);
  el.progressText.textContent = parts.join(" · ");
  setSyncButtons(progress.is_running);
}

function stopWatching() {
  if (state.stopSyncWatch) {
    state.stopSyncWatch();
    state.stopSyncWatch = null;
  }
}

function watch(initialProgress) {
  showProgress(initialProgress);
  stopWatching();
  state.stopSyncWatch = watchSync(showProgress, async (final) => {
    state.stopSyncWatch = null;
    setSyncButtons(false);
    el.progress.hidden = true;
    await refreshCoverage();
    if (!final) return;
    if (final.status === "succeeded") {
      showAlert(
        final.error ? "warn" : "ok",
        `数据更新完成: ${escapeHtml(final.message || "")}`,
        [
          {
            label: "回到条件选股",
            primary: true,
            onClick: () => {
              window.location.href = "/screen";
            },
          },
        ]
      );
    } else if (final.status === "failed") {
      showAlert(
        "error",
        `数据更新失败: ${escapeHtml(final.error || "未知错误")}, 详情见 logs 目录。`
      );
    } else if (final.status === "cancelled") {
      showAlert("info", "数据更新任务已取消。");
    }
  });
}

async function startSync(mode) {
  clearAlerts();
  setSyncButtons(true);
  try {
    const progress = await startSyncTask(mode);
    watch(progress);
  } catch (error) {
    setSyncButtons(false);
    showAlert("error", `启动同步任务失败: ${escapeHtml(error.message)}`);
  }
}

async function cancelSync() {
  try {
    const progress = await cancelSyncTask();
    if (progress) showProgress(progress);
  } catch (error) {
    showAlert("error", `取消失败: ${escapeHtml(error.message)}`);
  }
}

/** 进入页面时, 若已有任务在跑 (例如刚刷新过页面), 直接接着显示进度。 */
async function resumeSyncIfRunning() {
  const progress = await fetchSyncStatus();
  if (progress && progress.is_running) watch(progress);
}

/* ---------------------------------------------------------------- 初始化 */

function bindEvents() {
  el.initButton.addEventListener("click", () => startSync("full"));
  el.updateButton.addEventListener("click", () => startSync("incremental"));
  el.cancelButton.addEventListener("click", cancelSync);
}

async function initData() {
  const missing = bindElements(ELEMENT_IDS, REQUIRED_IDS);
  if (missing.length) {
    reportFatal(
      `页面与脚本版本不一致 (缺少 ${missing.join(", ")})。` +
        "请强刷新页面 (Ctrl+F5, 或 Ctrl+Shift+R) 重新加载。"
    );
    return;
  }

  bindEvents();
  await refreshCoverage();
  await resumeSyncIfRunning();
}

boot(initData);
