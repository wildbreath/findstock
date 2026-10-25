/* 多股同列：复用行情接口与 SVG 绘图，选择仅保存在当前浏览器。 */
const MULTI_STORAGE_KEY = "findstock.multi-chart.v1";
// shortcut: 同屏最多 12 只，更多股票需要分页而非继续压缩图表。
const MULTI_LIMIT = 12;
const MULTI_GEOMETRY = {
  height: 260, padLeft: 4, padRight: 60, priceTop: 12, priceBottom: 155,
  volumeTop: 178, volumeBottom: 220, axisY: 246,
};
const multiState = {
  selected: [], draft: new Map(), cache: new Map(), dates: [], end: null,
  metaError: "", metaBusy: false, generation: 0, controller: null,
  source: "watchlist", sourceItems: [], sourceToken: 0, sourceLoading: false,
  views: new Map(), markers: {},
};

function normalizeMultiStocks(items) {
  const unique = new Map();
  if (!Array.isArray(items)) return [];
  for (const item of items) {
    if (!item || typeof item.code !== "string" || !/^(sh|sz)\.\d{6}$/.test(item.code)) continue;
    if (unique.has(item.code)) continue;
    unique.set(item.code, {
      code: item.code, name: typeof item.name === "string" ? item.name.slice(0, 60) : item.code,
      date: typeof item.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.date) ? item.date : null,
    });
    if (unique.size === MULTI_LIMIT) break;
  }
  return [...unique.values()];
}

function alignMultiBars(bars, dates) {
  const byDate = new Map(bars.map((bar) => [bar.trade_date, bar]));
  return dates.map((trade_date) => byDate.get(trade_date) || {
    trade_date, open: null, high: null, low: null, close: null, volume: null, ma: {},
  });
}

function saveMultiSelection(items) {
  multiState.selected = normalizeMultiStocks(items);
  try {
    localStorage.setItem(MULTI_STORAGE_KEY, JSON.stringify(multiState.selected));
  } catch (error) {
    showAlert("warn", "浏览器未允许保存选择，本次仍可使用，刷新后需重新选择。");
  }
}

function multiVisibleDates() {
  return multiState.dates.slice(-Number($("multi-period").value));
}

function updateMultiRange() {
  const dates = multiVisibleDates();
  $("multi-count").textContent = `${multiState.selected.length} / ${MULTI_LIMIT}`;
  $("multi-range").textContent = multiState.metaBusy ? "正在读取本地交易日…" :
    multiState.metaError || (dates.length ?
      `默认 ${dates[0]} 至 ${dates.at(-1)} · 每张图可独立缩放、查看日期与标记` : "本地交易日历为空，请先更新数据。");
}

function updateMultiLoading() {
  const ready = multiState.selected.filter((item) => multiState.cache.has(item.code));
  const failed = ready.filter((item) => multiState.cache.get(item.code).error);
  $("multi-loading").textContent = !multiState.selected.length || multiState.metaError ? "" :
    `已读取 ${ready.length} / ${multiState.selected.length} 只` +
    (failed.length ? ` · ${failed.length} 只读取失败，可在图内重试` : "");
}

function renderMultiGrid() {
  updateMultiRange();
  $("multi-empty").hidden = multiState.selected.length > 0;
  $("multi-grid").innerHTML = multiState.selected.map((item) =>
    `<article class="multi-card" data-code="${item.code}">` +
    `<div class="multi-card-head"><div><h2 class="multi-card-name">${escapeHtml(item.name)}</h2>` +
    `<p class="multi-card-code">${item.code}</p></div><div class="multi-card-tools">` +
    `<button class="btn btn-mini" type="button" data-action="chart" aria-label="打开${escapeHtml(item.name)}的 K 线详情">详情</button>` +
    `<button class="btn btn-mini" type="button" data-action="remove" aria-label="移除${escapeHtml(item.name)}的同列图">移除</button>` +
    `</div></div><div class="multi-quote"></div>${multiChartControls(item)}` +
    `<div class="multi-readout" aria-live="polite" aria-atomic="true"></div><div class="multi-chart-body" tabindex="0" role="group" ` +
    `aria-label="${escapeHtml(item.name)}交互 K 线：方向键查看日期，加减号缩放，Enter 固定光标或标记节点"></div>` +
    `<div class="multi-node-list" aria-label="${escapeHtml(item.name)}的日期节点"></div>` +
    `<p class="multi-view-range" role="status"></p></article>`
  ).join("");
  multiState.selected.forEach((item) => paintMultiCard(item.code));
  updateMultiLoading();
}

function paintMultiCard(code) {
  const card = $("multi-grid").querySelector(`[data-code="${code}"]`);
  if (!card) return;
  const body = card.querySelector(".multi-chart-body");
  const quote = card.querySelector(".multi-quote");
  const result = multiState.cache.get(code);
  const problem = multiState.metaError || result?.error;
  if (problem || !result?.payload) {
    const view = multiState.views.get(code);
    if (view) view.layout = null;
    card.querySelector(".multi-readout").textContent = "";
  }
  if (problem) {
    body.innerHTML = `<div class="multi-chart-message"><p>${escapeHtml(problem)}</p>` +
      (multiState.metaError ? `<a href="/data">查看本地数据</a>` :
        `<button class="btn" type="button" data-action="retry">重试行情</button>`) + `</div>`;
    quote.textContent = "";
    return;
  }
  if (!result?.payload) {
    body.innerHTML = `<div class="multi-chart-message"><span class="loading"></span>正在读取本地行情…</div>`;
    return;
  }
  const payload = result.payload;
  card.querySelector(".multi-card-name").textContent = payload.name;
  const latest = payload.bars.at(-1);
  const pct = latest?.pct_chg;
  quote.innerHTML = `<span class="multi-price">${nm(latest?.close)}</span>` +
    `<span class="${pct > 0 ? "up" : pct < 0 ? "down" : "flat"}">${pct == null ? "—" : `${pct > 0 ? "+" : ""}${nm(pct)}%`}</span>` +
    `<small>${latest ? `行情 ${escapeHtml(latest.trade_date)}` : "暂无本地行情"}</small>`;
  const view = multiChartView(code);
  clampMultiView(view);
  const dates = multiState.dates.slice(view.start, view.start + view.count);
  const bars = alignMultiBars(payload.bars, dates);
  if (!bars.length) return;
  const layout = buildLayout(Math.max(260, body.clientWidth), bars, MULTI_GEOMETRY);
  view.layout = layout;
  body.innerHTML = renderChartSvg(bars, payload.ma_windows || [], layout, payload.name)
    .replace("</svg>", `${renderMultiMarkers(code, layout)}<g class="multi-crosshair chart-crosshair"></g></svg>`);
  updateMultiControls(code, card, dates);
  paintMultiFocus(code);
}

async function loadMultiCharts() {
  multiState.controller?.abort();
  const generation = ++multiState.generation;
  const controller = new AbortController();
  multiState.controller = controller;
  renderMultiGrid();
  if (multiState.metaBusy || multiState.metaError || !multiState.dates.length) return;
  const pending = multiState.selected.filter((item) => !multiState.cache.has(item.code));
  await Promise.all(Array.from({length: Math.min(3, pending.length)}, async () => {
    while (pending.length && generation === multiState.generation) {
      const item = pending.shift();
      try {
        const payload = await fetchMultiHistory(item.code, controller.signal);
        if (generation !== multiState.generation) return;
        multiState.cache.set(item.code, {payload});
      } catch (error) {
        if (generation !== multiState.generation || controller.signal.aborted) return;
        multiState.cache.set(item.code, {error: error.message});
      }
      paintMultiCard(item.code);
      updateMultiLoading();
    }
  }));
}

async function refreshMultiCharts() {
  if (multiState.metaBusy) return;
  multiState.metaBusy = true;
  multiState.controller?.abort();
  ++multiState.generation;
  $("multi-refresh").disabled = true;
  $("multi-refresh").textContent = "读取中…";
  multiState.metaError = "";
  multiState.cache.clear();
  updateMultiRange();
  try {
    const coverage = await api("/api/data/coverage");
    if (!coverage.bar_end) throw new Error("本地还没有日线行情，请先下载数据。");
    const start = coverage.bar_start || shiftIsoDate(coverage.bar_end, -600);
    const calendar = await api(`/api/calendar?start=${start}&end=${coverage.bar_end}&recent=0`);
    multiState.end = coverage.bar_end;
    multiState.dates = [...new Set(calendar.days.filter((day) => day.is_open).map((day) => day.trade_date))].sort();
    if (!multiState.dates.length) throw new Error("本地交易日历为空，请先更新数据。");
  } catch (error) {
    multiState.metaError = `日期区间读取失败：${error.message}`;
    multiState.dates = [];
  } finally {
    multiState.metaBusy = false;
    $("multi-refresh").disabled = false;
    $("multi-refresh").textContent = "刷新行情";
  }
  await loadMultiCharts();
}

function multiSourceItems() {
  const query = $("multi-search").value.trim().toLowerCase();
  const category = $("multi-category").value;
  return multiState.sourceItems.filter((item) => {
    if (multiState.source === "watchlist" && category !== "all") {
      const categories = item.categories || [];
      if (category === "uncategorized" ? categories.length : !categories.some((c) => String(c.id) === category)) return false;
    }
    return !query || `${item.name} ${item.code}`.toLowerCase().includes(query);
  });
}

function updateMultiPickedCount() {
  $("multi-picked-count").textContent = `已选 ${multiState.draft.size} / ${MULTI_LIMIT}`;
}

function renderMultiOptions() {
  const items = multiSourceItems();
  $("multi-options").innerHTML = items.map((item) => {
    const detail = multiState.source === "ladder" ? `${item.consecutive}板 · ${item.primary_theme || "题材未获取"}` :
      (item.categories || []).map((c) => c.name).join(" / ") || "未分类";
    return `<label class="multi-option"><input type="checkbox" value="${escapeHtml(item.code)}" ` +
      `${multiState.draft.has(item.code) ? "checked" : ""}><span><strong>${escapeHtml(item.name)}</strong>` +
      `<small>${escapeHtml(item.code)} · ${escapeHtml(detail)}</small></span></label>`;
  }).join("") || (multiState.sourceLoading ? "" : `<p class="table-note">没有符合条件的股票。</p>`);
  $("multi-select-visible").disabled = multiState.sourceLoading || !items.length;
  updateMultiPickedCount();
}

function multiPickerError(message) {
  $("multi-picker-error").textContent = message;
  $("multi-picker-error").hidden = !message;
}

async function loadMultiSource(source, day = "") {
  const token = ++multiState.sourceToken;
  multiState.source = source;
  multiState.sourceLoading = true;
  multiState.sourceItems = [];
  $("multi-search").value = "";
  $("multi-source-status").textContent = "正在读取股票列表…";
  $("multi-source-retry").hidden = true;
  $("multi-category-field").hidden = source !== "watchlist";
  $("multi-date-field").hidden = source !== "ladder";
  $("multi-date").disabled = true;
  multiPickerError("");
  document.querySelectorAll("[data-picker-source]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.pickerSource === source));
  });
  renderMultiOptions();
  try {
    const payload = await api(source === "watchlist" ? "/api/watchlist" :
      `/api/stock-ladder${day ? `?date=${encodeURIComponent(day)}` : ""}`);
    if (token !== multiState.sourceToken || !$("multi-picker").open) return;
    multiState.sourceItems = payload.items || [];
    if (source === "watchlist") {
      $("multi-category").innerHTML = `<option value="all">全部自选</option><option value="uncategorized">未分类</option>` +
        (payload.categories || []).map((category) => `<option value="${category.id}">${escapeHtml(category.name)} (${category.count})</option>`).join("");
    } else {
      multiState.sourceItems.sort((a, b) => b.consecutive - a.consecutive || a.code.localeCompare(b.code));
      $("multi-date").innerHTML = [...payload.trading_days].reverse().map((date) => `<option value="${date}">${date}</option>`).join("");
      $("multi-date").value = payload.trade_date;
      $("multi-date").disabled = false;
    }
    $("multi-source-status").textContent = source === "watchlist" ? `自选股 ${payload.items.length} 只，可按分类或关键词筛选。` :
      `${payload.trade_date} · ${payload.items.length} 只涨停股${payload.stale ? " · 当前为旧快照" : payload.is_final ? " · 收盘快照" : " · 盘中快照"}`;
  } catch (error) {
    if (token !== multiState.sourceToken) return;
    $("multi-source-status").textContent = `读取失败：${error.message}`;
    $("multi-source-retry").hidden = false;
  } finally {
    if (token === multiState.sourceToken) {
      multiState.sourceLoading = false;
      renderMultiOptions();
    }
  }
}

function openMultiPicker(source) {
  multiState.draft = new Map(multiState.selected.map((item) => [item.code, item]));
  $("multi-picker").showModal();
  $("multi-search").focus();
  loadMultiSource(source);
}

function addMultiDraft(items) {
  const next = new Map(multiState.draft);
  for (const item of items) {
    if (!next.has(item.code)) next.set(item.code, {
      code: item.code, name: item.name,
      date: multiState.source === "ladder" ? $("multi-date").value : item.source_date,
    });
  }
  if (next.size > MULTI_LIMIT) {
    multiPickerError(`最多选择 ${MULTI_LIMIT} 只，请先缩小列表范围或移除部分选择。`);
    return false;
  }
  multiState.draft = next;
  multiPickerError("");
  updateMultiPickedCount();
  return true;
}

function bindMultiEvents() {
  document.querySelectorAll("[data-source]").forEach((button) => {
    button.addEventListener("click", () => openMultiPicker(button.dataset.source));
  });
  document.querySelectorAll("[data-picker-source]").forEach((button) => {
    button.addEventListener("click", () => loadMultiSource(button.dataset.pickerSource));
  });
  $("multi-picker").querySelector("[data-picker-cancel]").addEventListener("click", () => $("multi-picker").close());
  $("multi-picker").addEventListener("close", () => { ++multiState.sourceToken; });
  $("multi-picker").addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter" && event.target === $("multi-search")) event.preventDefault();
  });
  $("multi-category").addEventListener("change", renderMultiOptions);
  $("multi-search").addEventListener("input", renderMultiOptions);
  $("multi-date").addEventListener("change", () => loadMultiSource("ladder", $("multi-date").value));
  $("multi-source-retry").addEventListener("click", () => loadMultiSource(multiState.source, $("multi-date").value));
  $("multi-select-visible").addEventListener("click", () => { if (addMultiDraft(multiSourceItems())) renderMultiOptions(); });
  $("multi-clear-draft").addEventListener("click", () => {
    multiState.draft.clear(); multiPickerError(""); renderMultiOptions();
  });
  $("multi-options").addEventListener("change", (event) => {
    const checkbox = event.target.closest("input[type='checkbox']");
    if (!checkbox) return;
    if (checkbox.checked) {
      const item = multiState.sourceItems.find((entry) => entry.code === checkbox.value);
      if (!addMultiDraft([item])) checkbox.checked = false;
    } else {
      multiState.draft.delete(checkbox.value); multiPickerError(""); updateMultiPickedCount();
    }
  });
  $("multi-picker-form").addEventListener("submit", (event) => {
    event.preventDefault();
    saveMultiSelection([...multiState.draft.values()]);
    $("multi-picker").close();
    loadMultiCharts();
  });
  $("multi-period").addEventListener("change", () => {
    multiState.views.clear();
    updateMultiRange(); multiState.selected.forEach((item) => paintMultiCard(item.code));
  });
  $("multi-columns").addEventListener("change", () => {
    $("multi-grid").style.setProperty("--multi-columns", $("multi-columns").value);
    requestAnimationFrame(() => multiState.selected.forEach((item) => paintMultiCard(item.code)));
  });
  $("multi-refresh").addEventListener("click", refreshMultiCharts);
  $("multi-grid").addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]");
    const card = event.target.closest(".multi-card");
    if (!action || !card) return;
    const code = card.dataset.code;
    if (action.dataset.action === "remove") {
      saveMultiSelection(multiState.selected.filter((item) => item.code !== code));
      loadMultiCharts();
      ($("multi-grid").querySelector("[data-action='remove']") || $("multi-refresh")).focus();
    } else if (action.dataset.action === "retry") {
      multiState.cache.delete(code); loadMultiCharts();
    } else if (action.dataset.action === "chart") {
      const item = multiState.selected.find((entry) => entry.code === code);
      openStockChart(code, {name: item.name, sourceDate: item.date, list: multiState.selected});
    }
  });
  bindMultiChartInteractions();
  let width = 0;
  let frame = 0;
  new ResizeObserver(() => {
    const next = $("multi-grid").clientWidth;
    if (next === width) return;
    width = next;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      multiState.selected.forEach((item) => paintMultiCard(item.code));
    });
  }).observe($("multi-grid"));
}

async function initMultiChart() {
  el.alertArea = $("alert-area");
  try {
    multiState.selected = normalizeMultiStocks(JSON.parse(localStorage.getItem(MULTI_STORAGE_KEY) || "[]"));
  } catch (error) {
    showAlert("warn", "未能读取上次的同列选择，请重新选股。");
  }
  bindMultiEvents();
  restoreMultiMarkers();
  renderMultiGrid();
  await refreshMultiCharts();
  const source = new URLSearchParams(location.search).get("source");
  if (["watchlist", "ladder"].includes(source)) {
    history.replaceState(null, "", "/multi-chart");
    openMultiPicker(source);
  }
}

boot(initMultiChart);
