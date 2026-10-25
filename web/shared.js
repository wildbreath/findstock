/**
 * 两个页面 (选股 / 数据) 共用的工具。
 *
 * 只放与具体页面无关的内容: 接口调用、格式化、提示条、元素收集、启动兜底,
 * 以及数据同步任务的启动与状态轮询。
 */

/** 按 id 收集到的元素, 供各页面脚本使用 (例如 el.screenButton)。 */
const el = {};

function $(id) {
  return document.getElementById(id);
}

/** 统一的接口调用: 失败时抛出带 status / code / details 的 Error。 */
async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      payload = null;
    }
  }
  if (!response.ok) {
    const detail = (payload && payload.error) || {};
    const error = new Error(
      detail.message || `请求失败 (HTTP ${response.status})`
    );
    error.status = response.status;
    error.code = detail.code || "http_error";
    error.details = detail.details || {};
    throw error;
  }
  return payload;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

/** 收藏时一次选好分类; 取消返回 null，保存失败保留选择供重试。 */
function addWatchWithCategories(item) {
  if (document.getElementById("watch-add-dialog")) return Promise.resolve(null);
  const dialog = document.createElement("dialog");
  dialog.id = "watch-add-dialog";
  dialog.className = "watch-add-dialog";
  dialog.setAttribute("aria-labelledby", "watch-add-title");
  dialog.innerHTML =
    `<form><h2 id="watch-add-title">加入自选股</h2>` +
    `<p class="watch-add-stock">${escapeHtml(item.name || item.code)} <span>${escapeHtml(item.code)}</span></p>` +
    `<fieldset disabled><legend>选择分类 <span>（可多选）</span></legend>` +
    `<div class="pick-options" data-role="options"><span class="chip-empty">正在读取分类…</span></div>` +
    `<div class="pick-create"><input data-role="new-category" type="text" maxlength="20" ` +
    `aria-label="新分类名称" placeholder="填写新分类名，加入时自动创建">` +
    `<button class="btn" type="button" data-action="create">创建并勾选</button></div>` +
    `<p class="picker-hint">填写名称后可直接加入自选，自动创建并勾选该分类。</p></fieldset>` +
    `<p class="picker-error" data-role="error" role="alert" hidden></p>` +
    `<button class="btn" type="button" data-action="retry" hidden>重新读取分类</button>` +
    `<div class="pick-actions"><span data-role="selection">不选择分类则加入「未分类」</span>` +
    `<button class="btn" type="button" data-action="cancel">取消</button>` +
    `<button class="btn btn-primary" type="submit" disabled>加入自选</button></div></form>`;
  const form = dialog.querySelector("form");
  const fieldset = dialog.querySelector("fieldset");
  const options = dialog.querySelector("[data-role='options']");
  const feedback = dialog.querySelector("[data-role='error']");
  const retry = dialog.querySelector("[data-action='retry']");
  const submit = dialog.querySelector("[type='submit']");
  const input = dialog.querySelector("[data-role='new-category']");
  let busy = false;
  let result = null;
  const selectedIds = () => [...options.querySelectorAll("input:checked")].map((node) => Number(node.value));
  const updateSelection = () => {
    const count = selectedIds().length;
    dialog.querySelector("[data-role='selection']").textContent = count ? `已选 ${count} 个分类` : "不选择分类则加入「未分类」";
  };
  const showError = (message) => {
    feedback.textContent = message;
    feedback.hidden = false;
  };
  const option = (category) => `<label class="pick-item"><input type="checkbox" value="${category.id}">` +
    `<span>${escapeHtml(category.name)}</span></label>`;
  async function loadCategories() {
    retry.disabled = true;
    feedback.hidden = true;
    try {
      const categories = await api("/api/watchlist/categories");
      if (!dialog.open) return;
      options.innerHTML = categories.length ? categories.map(option).join("") :
        `<span class="chip-empty">还没有分类，可在下方创建，或直接加入自选。</span>`;
      fieldset.disabled = false;
      submit.disabled = false;
      retry.hidden = true;
    } catch (error) {
      showError(`分类读取失败：${error.message}。请重试。`);
      retry.hidden = false;
    } finally {
      retry.disabled = false;
    }
  }
  async function create() {
    if (busy) return;
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    busy = true;
    fieldset.disabled = submit.disabled = true;
    feedback.hidden = true;
    try {
      const category = await api("/api/watchlist/categories", {
        method: "POST", body: JSON.stringify({name}),
      });
      const existing = options.querySelector(`input[value="${category.id}"]`);
      if (existing) existing.checked = true;
      else {
        options.querySelector(".chip-empty")?.remove();
        options.insertAdjacentHTML("beforeend", option(category));
        options.lastElementChild.querySelector("input").checked = true;
      }
      input.value = "";
      updateSelection();
      return true;
    } catch (error) {
      showError(`新建分类失败：${error.message}`);
      return false;
    } finally {
      busy = false;
      fieldset.disabled = submit.disabled = false;
      input.focus();
    }
  }
  options.addEventListener("change", updateSelection);
  retry.addEventListener("click", loadCategories);
  dialog.querySelector("[data-action='create']").addEventListener("click", create);
  dialog.querySelector("[data-action='cancel']").addEventListener("click", () => {
    if (!busy) dialog.close();
  });
  // 阻止分类框的 Esc / 方向键传到下层 K 线快捷键。
  dialog.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.target === input && event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      create();
    }
  });
  dialog.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || submit.disabled) return;
    if (input.value.trim() && !await create()) return;
    busy = true;
    fieldset.disabled = submit.disabled = true;
    submit.textContent = "加入中…";
    feedback.hidden = true;
    try {
      result = await api("/api/watchlist", {
        method: "POST", body: JSON.stringify({...item, category_ids: selectedIds()}),
      });
      dialog.close();
    } catch (error) {
      showError(`加入失败：${error.message}。选择已保留，请重试。`);
    } finally {
      busy = false;
      fieldset.disabled = submit.disabled = false;
      submit.textContent = "加入自选";
    }
  });
  document.body.appendChild(dialog);
  document.body.classList.add("watch-add-open");
  const completed = new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      dialog.remove();
      document.body.classList.remove("watch-add-open");
      resolve(result);
    }, {once: true});
  });
  dialog.showModal();
  loadCategories();
  return completed;
}

function formatVolume(shares) {
  if (shares === null || shares === undefined) return "—";
  const lots = shares / 100;
  if (lots >= 1e8) return `${(lots / 1e8).toFixed(2)}亿手`;
  if (lots >= 1e4) return `${(lots / 1e4).toFixed(2)}万手`;
  return `${Math.round(lots).toLocaleString("zh-CN")}手`;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function phaseLabel(phase) {
  return (
    {
      starting: "启动中",
      preparing: "准备中",
      calendar: "更新交易日历",
      stock_basics: "下载股票基础信息",
      universe: "获取股票列表",
      ladder: "补充连板天梯",
      bars: "下载日线行情",
      retry: "重试失败项",
      verifying: "校验数据完整性",
      finalizing: "整理数据",
      succeeded: "已完成",
      failed: "失败",
      cancelled: "已取消",
    }[phase] || phase
  );
}

/* ------------------------------------------------------------------ 提示 */

function clearAlerts() {
  el.alertArea.innerHTML = "";
}

//: 顶部提示条自动消失的时长 (毫秒), 以及淡出动画时长。
const ALERT_TTL_MS = 7000;
const ALERT_FADE_MS = 300;

/** 让提示条在 TTL 后自动消失; 鼠标停在上面时暂停计时 (方便点操作按钮)。 */
function scheduleAlertDismiss(alert) {
  let timer = null;
  const dismiss = () => {
    if (!alert.isConnected) return;
    alert.classList.add("alert-leaving");
    window.setTimeout(() => alert.remove(), ALERT_FADE_MS);
  };
  const arm = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(dismiss, ALERT_TTL_MS);
  };
  const disarm = () => window.clearTimeout(timer);
  alert.addEventListener("mouseenter", disarm);
  alert.addEventListener("mouseleave", arm);
  arm();
}

function showAlert(kind, html, actions = []) {
  const alert = document.createElement("div");
  alert.className = `alert alert-${kind}`;
  const text = document.createElement("div");
  text.innerHTML = html;
  alert.appendChild(text);
  const group = document.createElement("div");
  group.className = "chips";
  actions.forEach((action) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `btn ${action.primary ? "btn-primary" : ""}`;
    button.textContent = action.label;
    button.addEventListener("click", action.onClick);
    group.appendChild(button);
  });
  const close = document.createElement("button");
  close.type = "button";
  close.className = "alert-close";
  close.title = "关闭";
  close.setAttribute("aria-label", "关闭提示");
  close.textContent = "×";
  close.addEventListener("click", () => alert.remove());
  group.appendChild(close);
  alert.appendChild(group);
  el.alertArea.appendChild(alert);
  // 带操作按钮的提示要留给用户处理, 不自动消失; 普通提示 7 秒后自动收起。
  if (actions.length) return;
  scheduleAlertDismiss(alert);
}

/* -------------------------------------------------------------- 启动兜底 */

/** 按 id 列表收集元素; 返回缺失的 "必需" 元素 id。 */
function bindElements(ids, requiredIds) {
  ids.forEach((id) => {
    const node = $(id);
    if (node) {
      el[id.replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = node;
    }
  });
  return requiredIds.filter((id) => !$(id));
}

/** 初始化阶段的致命错误要显示出来, 否则页面只会 "没反应"。 */
function reportFatal(message) {
  const area = $("alert-area");
  if (!area) {
    window.alert(message);
    return;
  }
  area.innerHTML = `<div class="alert alert-error">${escapeHtml(message)}</div>`;
}

/**
 * 启动页面: 标记脚本已运行 (供页面里的兜底检测判断)、接住未捕获错误,
 * 并在 DOM 就绪后执行 init。init 抛错时给出可见提示而不是静默空白。
 */
function boot(init) {
  window.__findstockBooted = true;

  window.addEventListener("error", (event) => {
    const detail = event && event.message ? `: ${event.message}` : "";
    reportFatal(`页面脚本出错${detail}。请强刷新页面 (Ctrl+F5) 后重试。`);
  });

  document.addEventListener("DOMContentLoaded", () => {
    Promise.resolve()
      .then(init)
      .catch((error) => {
        reportFatal(
          `页面初始化失败: ${error.message}。请强刷新页面 (Ctrl+F5) 后重试。`
        );
        throw error;
      });
  });
}

/* ------------------------------------------------------------ 数据同步任务 */

/** 启动同步任务 (mode: full / incremental / targeted)。 */
function startSyncTask(mode, dates = []) {
  return api("/api/data/sync", {
    method: "POST",
    body: JSON.stringify({ mode, dates }),
  });
}

function cancelSyncTask() {
  return api("/api/data/sync/cancel", { method: "POST" });
}

/** 读取同步任务状态; 取不到 (例如还没有任务记录) 时返回 null。 */
async function fetchSyncStatus() {
  try {
    return await api("/api/data/sync/status");
  } catch (error) {
    return null;
  }
}

/**
 * 轮询同步任务: 每次取到状态调用 onProgress, 任务结束 (或状态消失) 时
 * 调用 onFinish 并停止轮询。返回停止函数。
 */
function watchSync(onProgress, onFinish, intervalMs = 1500) {
  const timer = setInterval(async () => {
    const progress = await fetchSyncStatus();
    if (!progress) {
      clearInterval(timer);
      onFinish(null);
      return;
    }
    onProgress(progress);
    if (!progress.is_running) {
      clearInterval(timer);
      onFinish(progress);
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

