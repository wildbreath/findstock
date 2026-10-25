/**
 * K 线弹窗 (总览 / 条件选股 / 天梯 / 自选股共用)。
 *
 * 从 shared.js 拆出来，供需要图表的页面加载。
 * 依赖 shared.js 提供的 api() / escapeHtml() / formatVolume() 等工具。
 */

/** 均线颜色 (与图例一致)。 */
const MA_COLORS = { 5: "#f59e0b", 10: "#2563eb", 20: "#9333ea", 60: "#0d9488" };
const CANDLE_UP = "#d92b2b";
const CANDLE_DOWN = "#159c5b";

/**
 * 蜡烛 / 量柱的涨跌方向: **只看开盘价与收盘价**。
 *
 * 收盘价 > 开盘价 → 红 (阳线); 收盘价 < 开盘价 → 绿 (阴线);
 * 与前一天收盘价无关。开收相等 (十字星) 时用前收盘定向, 再不行才退回涨跌幅。
 */
function isRisingBar(bar) {
  const open = bar.open ?? bar.preclose;
  const close = bar.close;
  if (open !== null && open !== undefined && close !== null && close !== undefined) {
    if (close !== open) return close > open;
    const preclose = bar.preclose;
    if (preclose !== null && preclose !== undefined && preclose !== close) {
      return close > preclose;
    }
    return true;
  }
  return (bar.pct_chg ?? 0) >= 0;
}

//: 绘图区尺寸 (SVG 用户坐标)。
const CHART_LAYOUT = {
  height: 520,
  padLeft: 6,
  padRight: 74,
  priceTop: 18,
  priceBottom: 348,
  volumeTop: 372,
  volumeBottom: 452,
  axisY: 478,
};

//: 一次向服务端要多少根 (服务端上限 400), 缩放/平移都在这个数据集里进行。
const CHART_LOAD_BARS = 400;
//: 缩放范围: 最少显示 20 根, 预设按钮 (60/120/250) 只是把默认窗口调大。
const CHART_MIN_BARS = 20;
const CHART_ZOOM_STEP = 1.18;
// shortcut: 沿用多股同列的 12 只上限, 更多股票需要分组查看。
const CHART_COMPARE_LIMIT = 12;

let chartState = null;

function nm(value, digits = 2) {
  return value === null || value === undefined || Number.isNaN(value)
    ? "—"
    : Number(value).toFixed(digits);
}

function chartRoot() {
  let root = document.getElementById("stock-modal");
  if (root) return root;

  root = document.createElement("div");
  root.id = "stock-modal";
  root.className = "modal-backdrop";
  root.hidden = true;
  root.innerHTML =
    `<div class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="chart-title">` +
    `<div class="modal-head">` +
    `<div><h3 id="chart-title">—</h3>` +
    `<p class="modal-sub" id="chart-sub">—</p>` +
    `<p class="chart-screen-date" id="chart-screen-date" hidden></p></div>` +
    `<div class="modal-tools">` +
    `<button id="chart-prev" class="btn btn-mini" type="button" title="上一个股票 (←)">◀</button>` +
    `<span id="chart-position" class="chart-position">1 / 1</span>` +
    `<button id="chart-next" class="btn btn-mini" type="button" title="下一个股票 (→)">▶</button>` +
    `<select id="chart-limit" class="cal-select" aria-label="K线根数">` +
    `<option value="60">近 60 根</option>` +
    `<option value="120" selected>近 120 根</option>` +
    `<option value="250">近 250 根</option>` +
    `</select>` +
    `<button id="chart-compare-toggle" class="btn" type="button" aria-expanded="false" aria-controls="chart-compare-picker">叠加个股</button>` +
    `<button id="chart-star" class="btn" type="button">☆ 加入自选</button>` +
    `<button id="chart-close" class="btn" type="button">关闭</button>` +
    `</div></div>` +
    `<section id="chart-compare-picker" class="chart-compare-picker" aria-label="选择叠加个股" hidden>` +
    `<label for="chart-compare-search">搜索个股</label>` +
    `<input id="chart-compare-search" type="search" maxlength="80" placeholder="输入名称或代码，可勾选多只" autocomplete="off" aria-controls="chart-compare-options">` +
    `<p id="chart-compare-status" role="status"></p>` +
    `<div id="chart-compare-options" class="chart-compare-options"></div>` +
    `<div class="chart-compare-actions"><span id="chart-compare-selection"></span>` +
    `<button id="chart-compare-add" class="btn btn-primary" type="button" disabled>添加所选</button></div></section>` +
    `<div class="chart-legend" id="chart-legend"></div>` +
    `<p class="chart-hint">滚轮缩放 · 按住鼠标拖动平移时间轴 · ← / → 切换股票 · 双击复位</p>` +
    `<div id="chart-compare-controls" class="chart-compare-controls" hidden>` +
    `<div class="chart-compare-scale" role="group" aria-label="叠加图纵轴">` +
    `<button type="button" data-compare-scale="independent" aria-pressed="true">独立缩放</button>` +
    `<button type="button" data-compare-scale="shared" aria-pressed="false">统一刻度</button></div>` +
    `<span id="chart-compare-scale-note"></span></div>` +
    `<div id="chart-comparisons"></div>` +
    `<div class="chart-stage" id="chart-stage">` +
    `<div id="chart-canvas" class="chart-canvas"></div>` +
    `<div class="chart-tip" id="chart-tip" hidden></div>` +
    `</div>` +
    `<p class="chart-note" id="chart-note"></p>` +
    `</div>`;
  document.body.appendChild(root);

  root.addEventListener("click", (event) => {
    if (event.target === root) closeStockChart();
  });
  root.querySelector("#chart-close").addEventListener("click", closeStockChart);
  root.querySelector("#chart-limit").addEventListener("change", (event) => {
    if (!chartState) return;
    // 预设按钮 = 设置默认缩放并复位到最新一根
    chartState.preset = Number(event.target.value) || 120;
    applyDefaultView();
    redrawChart();
  });
  root.querySelector("#chart-star").addEventListener("click", toggleChartWatch);
  root.querySelector("#chart-prev").addEventListener("click", () => stepStock(-1));
  root.querySelector("#chart-next").addEventListener("click", () => stepStock(1));
  root.querySelector("#chart-compare-toggle").addEventListener("click", toggleChartComparePicker);
  root.querySelector("#chart-compare-search").addEventListener("input", searchChartComparisons);
  root.querySelector("#chart-compare-options").addEventListener("change", (event) => {
    const item = chartState?.compareOptions.find(item => item.code === event.target.value);
    if (!item) return;
    if (event.target.checked) chartState.compareDraft.set(item.code, item);
    else chartState.compareDraft.delete(item.code);
    updateChartCompareSelection();
  });
  root.querySelector("#chart-compare-add").addEventListener("click", addChartComparisons);
  root.querySelector("#chart-compare-controls").addEventListener("click", (event) => {
    const button = event.target.closest("[data-compare-scale]");
    if (!chartState || !button) return;
    chartState.compareScale = button.dataset.compareScale;
    chartState.hoverIndex = null;
    root.querySelector("#chart-tip").hidden = true;
    redrawChart();
  });
  root.querySelector("#chart-comparisons").addEventListener("click", (event) => {
    const remove = event.target.closest("[data-compare-remove]"), retry = event.target.closest("[data-compare-retry]");
    if (!chartState) return;
    if (remove) {
      chartState.comparisons.delete(remove.dataset.compareRemove);
      syncChartTimeline(); redrawChart();
    }
    if (retry) {
      const entry = chartState.comparisons.get(retry.dataset.compareRetry);
      if (entry) { entry.error = ""; entry.retry = true; loadChartComparisons(); }
    }
  });
  window.addEventListener("resize", () => { if (chartState) redrawChart(); });

  const stage = root.querySelector("#chart-stage");
  stage.addEventListener("scroll", updateChartCompareAxis);
  stage.addEventListener("mousemove", onChartMouseMove);
  stage.addEventListener("mousedown", onChartMouseDown);
  stage.addEventListener("wheel", onChartWheel, { passive: false });
  stage.addEventListener("dblclick", (event) => {
    if (!chartState || !event.target.closest(".chart-svg")) return;
    applyDefaultView();
    redrawChart();
  });
  window.addEventListener("mousemove", onChartMouseMove);
  window.addEventListener("mouseup", onChartMouseUp);
  stage.addEventListener("mouseleave", () => {
    if (!chartState || chartState.drag) return;
    chartState.hoverIndex = null;
    updateCrosshair();
    renderLegend();
    const tip = root.querySelector("#chart-tip");
    if (tip) tip.hidden = true;
  });
  return root;
}

function onDocumentKeydown(event) {
  if (!chartState) return;
  if (event.target.closest?.("input, textarea, select, [contenteditable=true]")) return;
  if (event.key === "Escape") {
    closeStockChart();
    return;
  }
  // ← / → 在当前列表里切换到上一个 / 下一个股票
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    stepStock(-1);
    return;
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    stepStock(1);
  }
}

/**
 * 打开某只股票的 K 线图。
 *
 * options.list 给出"可切换的股票列表" (例如本次筛选结果 / 自选股清单),
 * ← / → 就在这个列表里前后切换。
 */
async function openStockChart(code, options = {}) {
  clearTimeout(chartState?.compareSearchTimer);
  const root = chartRoot();
  const limitSelect = root.querySelector("#chart-limit");
  const list = (options.list || []).filter((entry) => entry && entry.code);
  if (!list.some((entry) => entry.code === code)) {
    list.unshift({ code, name: options.name || "" });
  }
  const datedIndex = list.findIndex((entry) => entry.code === code && entry.date === options.sourceDate);
  chartState = {
    code,
    name: options.name || "",
    list,
    index: datedIndex >= 0 ? datedIndex : list.findIndex((entry) => entry.code === code),
    preset: Number(limitSelect.value) || 120,
    //: 这只股票的"选出日" (来自选股结果/自选股记录, 随来源变化)。
    screenDate:
      options.sourceDate ||
      ((list.find((entry) => entry.code === code) || {}).date ?? null),
    bars: [],
    visible: [],
    view: { start: 0, count: 120 },
    hasMore: false,
    loadingMore: false,
    drag: null,
    payload: null,
    layout: null,
    hoverIndex: null,
    watched: null,
    //: 从筛选结果打开时, 记录来源交易日 (收藏时一并存下)。
    sourceDate: options.sourceDate || null,
    highlightScreenDate: options.highlightScreenDate === true,
    onWatchChange: options.onWatchChange || null,
    comparisons: new Map(), compareDraft: new Map(), compareOptions: [], compareSearchToken: 0,
    compareScale: "independent",
    timeline: null, watchItems: [],
  };
  root.hidden = false;
  root.classList.remove("is-comparing");
  root.querySelector(".modal-panel").scrollTop = 0;
  document.body.classList.add("modal-open");
  document.addEventListener("keydown", onDocumentKeydown);
  root.querySelector("#chart-canvas").innerHTML =
    `<p class="chart-loading"><span class="loading"></span>正在读取 ${escapeHtml(code)} 的本地日线…</p>`;
  root.querySelector("#chart-tip").hidden = true;
  root.querySelector("#chart-comparisons").innerHTML = "";
  root.querySelector("#chart-compare-controls").hidden = true;
  root.querySelector("#chart-stage").scrollTop = 0;
  root.querySelector("#chart-compare-picker").hidden = true;
  root.querySelector("#chart-compare-toggle").setAttribute("aria-expanded", "false");
  root.querySelector("#chart-compare-toggle").textContent = "叠加个股";
  await Promise.all([loadChartData({ resetView: true }), refreshChartWatch()]);
  updateChartPosition();
  updateChartScreenDate();
}

function closeStockChart() {
  clearTimeout(chartState?.compareSearchTimer);
  const root = document.getElementById("stock-modal");
  if (root) root.hidden = true;
  document.body.classList.remove("modal-open");
  document.removeEventListener("keydown", onDocumentKeydown);
  chartState = null;
}

async function loadChartData(options = {}) {
  if (!chartState) return;
  const current = chartState;
  const { code } = chartState;
  const root = chartRoot();
  try {
    // 始终取本地最新的一段日线 (不做任何截止日截断)
    const payload = await api(
      `/api/stocks/${encodeURIComponent(code)}/chart?limit=${CHART_LOAD_BARS}`
    );
    if (chartState !== current || current.code !== code) return;
    chartState.payload = payload;
    chartState.bars = payload.bars || [];
    if (chartState.comparisons.size) syncChartTimeline();
    // 服务端返回的根数少于请求上限, 说明本地已经没有更早的数据了
    chartState.hasMore = chartState.bars.length >= CHART_LOAD_BARS;
    while (current.highlightScreenDate && current.screenDate && current.hasMore &&
      current.bars[0].trade_date > current.screenDate) {
      await loadOlderBars();
      if (chartState !== current || current.code !== code) return;
    }
    chartState.hoverIndex = null;
    if (options.resetView !== false || !chartState.visible.length) {
      applyDefaultView(options.count);
    } else {
      clampView();
    }
    root.querySelector("#chart-title").textContent = `${payload.name} (${payload.code})`;
    redrawChart();
  } catch (error) {
    if (chartState !== current) return;
    root.querySelector("#chart-canvas").innerHTML =
      `<p class="chart-error">无法读取 K 线: ${escapeHtml(error.message)}</p>`;
  }
}

/** 复位视图: 筛选结果定位选出日, 其他入口右端对齐最新一根。 */
function applyDefaultView(count) {
  const dates = chartDates(), total = dates.length;
  const desired = count || chartState.preset || 120;
  const size = Math.max(CHART_MIN_BARS, Math.min(desired, total || desired));
  chartState.view = { start: Math.max(0, total - size), count: size };
  const match = chartState.highlightScreenDate
    ? dates.indexOf(chartState.screenDate) : -1;
  if (match >= 0) chartState.view.start = Math.min(chartState.view.start, Math.max(0, match - Math.floor(size / 2)));
  chartState.hoverIndex = null;
}

function clampView() {
  const total = chartDates().length;
  const count = Math.max(CHART_MIN_BARS, Math.min(chartState.view.count, total || CHART_MIN_BARS));
  const start = Math.min(Math.max(chartState.view.start, 0), Math.max(0, total - count));
  chartState.view = { start, count };
}

/** 当前可见的 K 线切片 (均线值已经挂在每根 K 线上)。 */
function visibleBars() {
  if (!chartState) return [];
  const { start, count } = chartState.view;
  return chartState.timeline ? alignChartBars(chartState.bars, chartState.timeline.slice(start, start + count)) :
    chartState.bars.slice(start, start + count);
}

/** 向左拖到头时补齐更早的历史 (本地最多 2 年, 所以可能没有更多)。 */
async function loadOlderBars() {
  if (!chartState || chartState.loadingMore || !chartState.hasMore) return;
  const current = chartState;
  const { code } = chartState;
  const oldest = chartState.bars[0];
  if (!oldest) return;
  chartState.loadingMore = true;
  try {
    const end = shiftIsoDate(oldest.trade_date, -1);
    const payload = await api(
      `/api/stocks/${encodeURIComponent(code)}/chart?limit=${CHART_LOAD_BARS}&end=${end}`
    );
    if (chartState !== current || current.code !== code) return;
    const older = (payload.bars || []).filter(
      (bar) => bar.trade_date < oldest.trade_date
    );
    if (!older.length) {
      chartState.hasMore = false;
      return;
    }
    chartState.bars = older.concat(chartState.bars);
    chartState.hasMore = (payload.bars || []).length >= CHART_LOAD_BARS;
    // 数据接在前面, 视图与拖动基准都要跟着右移, 画面才不会跳
    if (chartState.timeline) syncChartTimeline();
    else {
      chartState.view.start += older.length;
      if (chartState.drag) chartState.drag.viewStart += older.length;
    }
    redrawChart();
  } catch (error) {
    if (chartState === current) current.hasMore = false;
  } finally {
    current.loadingMore = false;
  }
}

function shiftIsoDate(iso, days) {
  const [year, month, day] = String(iso).slice(0, 10).split("-").map(Number);
  const date = new Date(year, month - 1, day + days);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function refreshChartWatch() {
  if (!chartState) return;
  const current = chartState;
  try {
    const payload = await api("/api/watchlist");
    if (chartState !== current) return;
    chartState.watchItems = payload.items || [];
    chartState.watched = (payload.codes || []).includes(chartState.code);
    updateChartStar();
  } catch (error) {
    /* 自选股读取失败不影响看图 */
  }
}

function updateChartStar() {
  const button = chartRoot().querySelector("#chart-star");
  if (!chartState) return;
  button.textContent = chartState.watched ? "★ 已收藏" : "☆ 加入自选";
  button.classList.toggle("is-on", Boolean(chartState.watched));
}

async function toggleChartWatch() {
  if (!chartState) return;
  const current = chartState;
  const { code, name, watched, sourceDate, onWatchChange } = chartState;
  try {
    if (watched) {
      await api(`/api/watchlist/${encodeURIComponent(code)}`, { method: "DELETE" });
    } else {
      const added = await addWatchWithCategories({
        code,
        name: name || undefined,
        source_date: current.screenDate || sourceDate || undefined,
      });
      if (!added) return;
    }
    if (chartState === current && chartState.code === code) {
      chartState.watched = !watched;
      updateChartStar();
    }
    if (onWatchChange) onWatchChange(code, !watched);
  } catch (error) {
    chartRoot().querySelector("#chart-note").textContent =
      `收藏操作失败: ${error.message}`;
  }
}

function chartDates() {
  return chartState.timeline || chartState.bars.map(bar => bar.trade_date);
}

function alignChartBars(bars, dates) {
  const byDate = new Map(bars.map(bar => [bar.trade_date, bar]));
  return dates.map(trade_date => byDate.get(trade_date) || {
    trade_date, open: null, high: null, low: null, close: null, volume: null, pct_chg: null, ma: {},
  });
}

function syncChartTimeline() {
  const previous = chartDates(), startDate = previous[chartState.view.start];
  const atEnd = chartState.view.start + chartState.view.count >= previous.length;
  const oldStart = chartState.view.start;
  const dates = chartState.comparisons.size ? [...new Set([
    ...chartState.bars.map(bar => bar.trade_date),
    ...[...chartState.comparisons.values()].flatMap(entry => (entry.payload?.bars || []).map(bar => bar.trade_date)),
  ])].sort() : chartState.bars.map(bar => bar.trade_date);
  chartState.timeline = chartState.comparisons.size ? dates : null;
  chartState.view.start = atEnd ? Math.max(0, dates.length - chartState.view.count) :
    Math.max(0, dates.findIndex(day => day >= startDate));
  clampView();
  if (chartState.drag) chartState.drag.viewStart += chartState.view.start - oldStart;
}

function toggleChartComparePicker() {
  const root = chartRoot(), picker = root.querySelector("#chart-compare-picker");
  picker.hidden = !picker.hidden;
  root.querySelector("#chart-compare-toggle").setAttribute("aria-expanded", String(!picker.hidden));
  if (!picker.hidden) {
    root.querySelector("#chart-compare-search").value = "";
    searchChartComparisons();
    root.querySelector("#chart-compare-search").focus();
  }
  if (chartState?.comparisons.size) redrawChart();
}

function renderChartCompareOptions(items) {
  const unique = new Map();
  items.forEach(item => { if (item && /^(sh|sz)\.\d{6}$/.test(item.code)) unique.set(item.code, item); });
  chartState.compareOptions = [...unique.values()].filter(item => item.code !== chartState.code);
  chartRoot().querySelector("#chart-compare-options").innerHTML = chartState.compareOptions.map(item => {
    const added = chartState.comparisons.has(item.code);
    return `<label><input type="checkbox" value="${item.code}" ${added ? "disabled checked" : chartState.compareDraft.has(item.code) ? "checked" : ""}>` +
      `<span>${escapeHtml(item.name || item.code)} <small>${item.code}${added ? " · 已叠加" : ""}</small></span></label>`;
  }).join("");
  updateChartCompareSelection();
}

function updateChartCompareSelection() {
  const selected = [...chartState.compareDraft.values()];
  chartRoot().querySelector("#chart-compare-selection").textContent = selected.length ?
    `已选 ${selected.length} 只：${selected.map(item => item.name || item.code).join("、")}` : "可选择多只，添加后上下排列";
  chartRoot().querySelector("#chart-compare-add").disabled = !selected.length;
}

function searchChartComparisons() {
  if (!chartState) return;
  const current = chartState, token = ++current.compareSearchToken;
  const query = chartRoot().querySelector("#chart-compare-search").value.trim();
  const status = chartRoot().querySelector("#chart-compare-status");
  clearTimeout(current.compareSearchTimer);
  if (!query) {
    status.textContent = "从当前列表、自选股中勾选，或输入名称 / 代码搜索全市场。";
    renderChartCompareOptions([...(current.list || []), ...current.watchItems]);
    return;
  }
  status.textContent = "正在搜索…";
  renderChartCompareOptions([]);
  current.compareSearchTimer = setTimeout(async () => {
    try {
      const items = await api(`/api/stocks/search?q=${encodeURIComponent(query)}&limit=50`);
      if (chartState !== current || token !== current.compareSearchToken) return;
      renderChartCompareOptions(items);
      status.textContent = current.compareOptions.length ? "勾选后点击「添加所选」。" : "没有找到其他个股，请换个名称或代码。";
    } catch (error) {
      if (chartState === current && token === current.compareSearchToken) status.textContent = `搜索失败：${error.message}，请重新输入重试。`;
    }
  }, 250);
}

function addChartComparisons() {
  if (!chartState) return;
  const added = [...chartState.compareDraft.values()].filter(item => item.code !== chartState.code && !chartState.comparisons.has(item.code));
  if (chartState.comparisons.size + added.length >= CHART_COMPARE_LIMIT) {
    chartRoot().querySelector("#chart-compare-status").textContent = `含主图最多 ${CHART_COMPARE_LIMIT} 只，请减少选择。`;
    return;
  }
  added.forEach(item => chartState.comparisons.set(item.code, {...item, payload: null, loading: false, hasMore: true, error: "", layout: null}));
  chartState.compareDraft.clear();
  chartRoot().querySelector("#chart-compare-picker").hidden = true;
  chartRoot().querySelector("#chart-compare-toggle").setAttribute("aria-expanded", "false");
  syncChartTimeline();
  redrawChart();
}

function loadChartComparisons(before) {
  if (!chartState || !chartState.payload) return;
  const entries = [...chartState.comparisons.values()];
  const target = before || chartState.visible[0]?.trade_date;
  const slots = Math.max(0, 3 - entries.filter(entry => entry.loading).length);
  entries.filter(entry => !entry.loading && !entry.error && (entry.retry || !entry.payload ||
    entry.hasMore && entry.payload.bars[0]?.trade_date > target)).slice(0, slots)
    .forEach(entry => loadChartComparison(entry, chartState.comparisons, entry.retry ? entry.target : target));
}

async function loadChartComparison(entry, collection, target) {
  entry.loading = true;
  entry.retry = false;
  entry.target = target;
  try {
    do {
      const oldest = entry.payload?.bars[0]?.trade_date;
      const payload = await api(`/api/stocks/${entry.code}/chart?limit=${CHART_LOAD_BARS}${oldest ? `&end=${shiftIsoDate(oldest, -1)}` : ""}`);
      if (chartState?.comparisons !== collection || collection.get(entry.code) !== entry) return;
      const batch = (payload.bars || []).filter(bar => !oldest || bar.trade_date < oldest);
      entry.hasMore = batch.length > 0 && (payload.bars || []).length >= CHART_LOAD_BARS;
      const bars = new Map([...(entry.payload?.bars || []), ...batch].map(bar => [bar.trade_date, bar]));
      entry.payload = {...payload, bars: [...bars.values()].sort((a, b) => a.trade_date.localeCompare(b.trade_date))};
      if (!entry.payload.bars.length) throw new Error("本地暂无该个股行情，请到数据页面下载。");
    } while (entry.hasMore && entry.payload.bars[0].trade_date > target);
  } catch (error) {
    if (entry.payload?.bars.length && error.code === "stock_not_found") entry.hasMore = false;
    else entry.error = error.message;
  } finally {
    entry.loading = false;
    if (chartState?.comparisons === collection && collection.get(entry.code) === entry) {
      syncChartTimeline(); redrawChart();
    }
  }
}

function chartCompareReadout(bar, layout) {
  return bar?.close == null ? `${bar?.trade_date || ""} 暂无行情` :
    `${bar.trade_date.slice(5)} · 区间 ${nm((bar.close / layout.baseClose - 1) * 100)}%`;
}

function renderChartComparisons() {
  const root = chartRoot();
  root.querySelector("#chart-compare-controls").hidden = !chartState.comparisons.size;
  root.querySelectorAll("[data-compare-scale]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.compareScale === chartState.compareScale));
  });
  root.querySelector("#chart-compare-scale-note").textContent = chartState.compareScale === "shared" ?
    "相同高度代表相同涨幅，适合比较涨跌幅度" : "各股独立纵轴，放大 K 线细节，适合比较走势";
  root.querySelector("#chart-compare-toggle").textContent = chartState.comparisons.size ? `叠加个股（${chartState.comparisons.size}）` : "叠加个股";
  root.querySelector("#chart-comparisons").innerHTML = [...chartState.comparisons.values()].map(entry => {
    return `<span class="chart-compare-item" data-compare-code="${entry.code}"><span>${escapeHtml(entry.payload?.name || entry.name)}</span>` +
      (entry.error ? `<span class="chart-compare-error" title="${escapeHtml(entry.error)}" role="alert">${escapeHtml(entry.error)}</span> <button class="btn btn-mini" type="button" data-compare-retry="${entry.code}">重试</button>` :
        entry.loading || !entry.payload ? '<small>读取中…</small>' : "") +
      `<button class="btn btn-mini" type="button" data-compare-remove="${entry.code}" aria-label="移除${escapeHtml(entry.name)}的叠加图">×</button></span>`;
  }).join("");
}

function relativeChartBars(bars) {
  const base = bars.find(bar => Number.isFinite(bar.close) && bar.close > 0);
  const relative = value => base && Number.isFinite(value) ? (value / base.close - 1) * 100 : null;
  return {baseClose: base?.close ?? null, baseDate: base?.trade_date ?? null,
    bars: bars.map(bar => ({...bar, open: relative(bar.open), high: relative(bar.high), low: relative(bar.low),
      close: relative(bar.close), preclose: relative(bar.preclose),
      ma: Object.fromEntries(Object.entries(bar.ma || {}).map(([window, value]) => [window, relative(value)])),
    }))};
}

function chartCompareRange(bars) {
  let low = 0, high = 0;
  bars.forEach(bar => {
    // 纵轴以 K 线为准，区间外的长期均线不再压缩蜡烛。
    [bar.low, bar.high].forEach(value => {
      if (Number.isFinite(value)) { low = Math.min(low, value); high = Math.max(high, value); }
    });
  });
  const padding = Math.max(.5, (high - low) * .06);
  return {low: low - padding, high: high + padding};
}

function renderRelativeChart(width, height) {
  const dates = chartState.visible.map(bar => bar.trade_date);
  const entries = [{code: chartState.code, name: chartState.payload.name, payload: chartState.payload}, ...chartState.comparisons.values()];
  const lanes = entries.map((entry, index) => {
    const bars = index ? alignChartBars(entry.payload?.bars || [], dates) : chartState.visible;
    return {entry, raw: bars, ...relativeChartBars(bars)};
  });
  const sharedRange = chartState.compareScale === "shared" ? chartCompareRange(lanes.flatMap(lane => lane.bars)) : null;
  const columns = width >= 900 ? 2 : 1;
  const laneWidth = (width - (columns - 1) * 16) / columns;
  const laneHeight = (height - 28) / Math.ceil(lanes.length / columns);
  const parts = [`<svg class="chart-svg chart-relative-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${lanes.length}只股票共用时间轴的相对涨跌幅 K 线图">`];
  lanes.forEach((lane, index) => {
    const top = Math.floor(index / columns) * laneHeight;
    const left = index % columns * (laneWidth + 16);
    const range = sharedRange || chartCompareRange(lane.bars);
    const geometry = {...CHART_LAYOUT, height, padLeft: left + 6, padRight: width - left - laneWidth + 74, priceTop: top + 30,
      priceBottom: top + laneHeight - 14, volumeBottom: height - 28, axisY: height - 8};
    const layout = buildLayout(width, lane.bars, geometry, range);
    lane.layout = layout;
    Object.assign(layout, {bars: lane.raw, relativeBars: lane.bars, baseClose: lane.baseClose, baseDate: lane.baseDate});
    if (index) lane.entry.layout = layout;
    else chartState.layout = layout;
    const clip = `chart-compare-clip-${index}`;
    parts.push(`<g class="chart-compare-lane" data-chart-code="${lane.entry.code}">` +
      `<title>${escapeHtml(lane.entry.name)} · 基准 ${lane.baseDate || "无有效行情"} · 首个有效收盘为 0%</title>` +
      `<rect class="chart-lane-background" x="${left}" y="${top}" width="${laneWidth}" height="${laneHeight}" fill="${Math.floor(index / columns) % 2 ? "#f8fafc" : "#ffffff"}"/>` +
      `<text class="chart-relative-name" x="${left + 6}" y="${top + 19}">${escapeHtml(lane.entry.name)}${laneWidth >= 600 ? ` <tspan>${lane.entry.code}</tspan>` : ""}</text>` +
      `<text class="chart-relative-readout" x="${layout.plotRight}" y="${top + 19}" text-anchor="end">${escapeHtml(lane.baseClose ? chartCompareReadout(lane.raw.at(-1), layout) : lane.entry.error ? "行情读取失败" : lane.entry.loading || !lane.entry.payload ? "读取中…" : "区间无行情")}</text>`);
    for (const value of [range.high, 0, range.low]) {
      const y = layout.yOf(value);
      parts.push(`<line x1="${layout.plotLeft}" x2="${layout.plotRight}" y1="${y}" y2="${y}" class="${value === 0 ? "chart-relative-zero" : "chart-grid"}"/>`);
      if (value !== 0 || Math.min(y - geometry.priceTop, geometry.priceBottom - y) > 12) {
        parts.push(`<text x="${layout.plotRight + 6}" y="${Math.max(geometry.priceTop + 9, Math.min(y + 3, geometry.priceBottom))}" class="chart-axis-label">${nm(value, 1)}%</text>`);
      }
    }
    parts.push(`<clipPath id="${clip}"><rect x="${layout.plotLeft}" y="${geometry.priceTop}" width="${layout.plotRight - layout.plotLeft}" height="${geometry.priceBottom - geometry.priceTop}"/></clipPath>` +
      `<g clip-path="url(#${clip})"><g class="chart-compare-ma">${renderMaLines(lane.bars, lane.entry.payload?.ma_windows || [], layout)}</g>` +
      `<g class="chart-compare-candles">${renderCandles(lane.bars, layout)}</g></g>` +
      `${renderCrosshair(index ? `chart-crosshair-${index}` : "chart-crosshair")}</g>`);
  });
  if (chartState.highlightScreenDate) lanes.slice(0, columns).forEach(lane => {
    parts.push(renderScreenDateMarker(chartState.visible,
      {...lane.layout, geometry: {...lane.layout.geometry, priceTop: 0}}, chartState.screenDate));
  });
  parts.push(`<g class="chart-shared-axis"><rect x="0" y="${height - 28}" width="${width}" height="28" fill="white"/>` +
    `<line class="chart-grid" x1="0" x2="${width}" y1="${height - 28}" y2="${height - 28}"/>` +
    `${lanes.slice(0, columns).map(lane => renderXAxis(chartState.visible, lane.layout)).join("")}</g></svg>`);
  return parts.join("");
}

function updateChartCompareAxis() {
  const root = chartRoot(), stage = root.querySelector("#chart-stage");
  root.querySelector("#chart-tip").hidden = true;
  const axis = stage.querySelector(".chart-shared-axis");
  if (axis && chartState?.layout) {
    axis.setAttribute("transform", `translate(0 ${Math.min(0, stage.scrollTop + stage.clientHeight - chartState.layout.geometry.height)})`);
  }
}

/* --- 绘图 --------------------------------------------------------------- */

function drawChart() {
  redrawChart();
}

function redrawChart() {
  if (!chartState || !chartState.payload) return;
  const root = chartRoot();
  const comparing = chartState.comparisons.size > 0;
  root.classList.toggle("is-comparing", comparing);
  const payload = chartState.payload;
  const bars = visibleBars();
  chartState.visible = bars;
  const canvas = root.querySelector("#chart-canvas");
  if (!bars.length) {
    canvas.innerHTML = `<p class="chart-error">本地没有该股票的日线数据。</p>`;
    return;
  }

  renderChartComparisons();
  updateChartSummary();
  renderLegend();
  const stage = root.querySelector("#chart-stage");
  const width = Math.max(comparing ? 280 : 640, canvas.clientWidth || 960);
  if (comparing) {
    const panel = root.querySelector(".modal-panel");
    const otherHeight = [...panel.children].filter(node => node !== stage && !node.hidden).reduce((sum, node) => {
      const style = getComputedStyle(node);
      return sum + node.getBoundingClientRect().height + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
    }, 0);
    const height = Math.ceil((chartState.comparisons.size + 1) / (width >= 900 ? 2 : 1)) * 240 + 28;
    stage.style.height = `${Math.max(160, Math.min(innerHeight - 48 - otherHeight, height))}px`;
    canvas.innerHTML = renderRelativeChart(width, height);
    updateChartCompareAxis();
  }
  else {
    stage.style.height = "";
    chartState.layout = buildLayout(width, bars);
    canvas.innerHTML = renderChartSvg(bars, payload.ma_windows || [], chartState.layout, payload.name, true,
      chartState.highlightScreenDate ? chartState.screenDate : null);
  }
  updateCrosshair();
  loadChartComparisons();
}

function renderChartSvg(bars, windows, layout, name, crosshair = false, screenDate = null) {
  const {width, geometry} = layout;
  const parts = [
    `<svg class="chart-svg" viewBox="0 0 ${width} ${geometry.height}" ` +
      `width="${width}" height="${geometry.height}" role="img" ` +
      `aria-label="${escapeHtml(name)} K线图">`,
  ];
  parts.push(renderGrid(layout));
  parts.push(renderVolume(bars, layout));
  parts.push(renderCandles(bars, layout));
  parts.push(renderMaLines(bars, windows, layout));
  parts.push(renderXAxis(bars, layout));
  parts.push(renderScreenDateMarker(bars, layout, screenDate));
  if (crosshair) parts.push(renderCrosshair());
  parts.push(`</svg>`);
  return parts.join("");
}

function renderScreenDateMarker(bars, layout, screenDate) {
  const index = bars.findIndex((bar) => bar.trade_date === screenDate);
  if (index < 0) return "";
  const x = layout.xOf(index), {priceTop, volumeBottom} = layout.geometry;
  const labelX = Math.max(layout.plotLeft + 42, Math.min(x, layout.plotRight - 42));
  return `<g class="chart-screen-marker" data-screen-date="${escapeHtml(screenDate)}" ` +
    `role="img" aria-label="本次筛选选出日 T0：${escapeHtml(screenDate)}">` +
    `<title>本次筛选选出日 T0：${escapeHtml(screenDate)}</title>` +
    `<line x1="${x}" x2="${x}" y1="${priceTop}" y2="${volumeBottom}"/>` +
    `<text x="${labelX}" y="${priceTop + 14}" text-anchor="middle">选出日 T0</text></g>`;
}

function renderMiniChart(bars, day) {
  // 迷你图只画价格，均线不能扩大价格轴，也不能展示指定日期之后的行情。
  const recent = bars.filter((bar) => bar.trade_date <= day &&
    [bar.open, bar.high, bar.low, bar.close].every((value) => typeof value === "number" && Number.isFinite(value)))
    .slice(-20).map((bar) => ({...bar, ma: {}}));
  if (!recent.length) return "暂无日K";
  const layout = buildLayout(80, recent, {padLeft: 2, padRight: 2, priceTop: 2, priceBottom: 38});
  const label = `${recent[0].trade_date} 至 ${recent.at(-1).trade_date}，${recent.length} 根日K`;
  return `<svg viewBox="0 0 80 40" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(label)}"><title>${escapeHtml(label)}</title>${renderCandles(recent, layout)}</svg>`;
}

function buildLayout(width, bars, geometry = CHART_LAYOUT, range = null) {
  const plotLeft = geometry.padLeft;
  const plotRight = width - geometry.padRight;
  const step = (plotRight - plotLeft) / bars.length;

  let low = null;
  let high = null;
  bars.forEach((bar) => {
    [bar.low, bar.high].forEach((value) => {
      if (value === null || value === undefined) return;
      low = low === null ? value : Math.min(low, value);
      high = high === null ? value : Math.max(high, value);
    });
    Object.values(bar.ma || {}).forEach((value) => {
      if (value === null || value === undefined) return;
      low = low === null ? value : Math.min(low, value);
      high = high === null ? value : Math.max(high, value);
    });
  });
  if (range) { low = range.low; high = range.high; }
  if (low === null || high === null) {
    low = 0;
    high = 1;
  }
  if (high === low) {
    high = low + Math.max(1, low * 0.02);
  }

  let maxVolume = 0;
  bars.forEach((bar) => {
    maxVolume = Math.max(maxVolume, bar.volume || 0);
  });

  const xOf = (index) => plotLeft + step * (index + 0.5);
  const yOf = (price) =>
    geometry.priceBottom -
    ((price - low) / (high - low)) *
      (geometry.priceBottom - geometry.priceTop);
  const yOfVolume = (volume) =>
    geometry.volumeBottom -
    (maxVolume > 0 ? volume / maxVolume : 0) *
      (geometry.volumeBottom - geometry.volumeTop);

  return { width, geometry, plotLeft, plotRight, step, low, high, maxVolume, xOf, yOf, yOfVolume, bars };
}

function renderGrid(layout) {
  const parts = [];
  const lines = 5;
  for (let index = 0; index <= lines; index += 1) {
    const price = layout.low + ((layout.high - layout.low) * index) / lines;
    const y = layout.yOf(price);
    parts.push(
      `<line x1="${layout.plotLeft}" y1="${y}" x2="${layout.plotRight}" y2="${y}" class="chart-grid"/>`
    );
    parts.push(
      `<text x="${layout.plotRight + 6}" y="${y + 4}" class="chart-axis-label">${nm(price)}</text>`
    );
  }
  parts.push(
    `<line x1="${layout.plotLeft}" y1="${layout.geometry.volumeBottom}" ` +
      `x2="${layout.plotRight}" y2="${layout.geometry.volumeBottom}" class="chart-grid"/>`
  );
  parts.push(
    `<text x="${layout.plotRight + 6}" y="${layout.geometry.volumeBottom + 4}" ` +
      `class="chart-axis-label">${formatVolume(layout.maxVolume)}</text>`
  );
  return parts.join("");
}

function renderCandles(bars, layout) {
  const bodyWidth = Math.max(1.2, Math.min(14, layout.step * 0.62));
  const parts = [];
  bars.forEach((bar, index) => {
    const open = bar.open ?? bar.close;
    const close = bar.close;
    if (open === null || close === null) return;
    // 红绿只看开盘价与收盘价 (与前一天涨跌幅无关)
    const rising = isRisingBar(bar);
    const color = rising ? CANDLE_UP : CANDLE_DOWN;
    const x = layout.xOf(index);
    const yOpen = layout.yOf(open);
    const yClose = layout.yOf(close);
    const top = Math.min(yOpen, yClose);
    const height = Math.max(1, Math.abs(yClose - yOpen));
    if (bar.high !== null && bar.low !== null) {
      parts.push(
        `<line x1="${x}" y1="${layout.yOf(bar.high)}" x2="${x}" y2="${layout.yOf(bar.low)}" ` +
          `stroke="${color}" stroke-width="1"/>`
      );
    }
    parts.push(
      `<rect x="${x - bodyWidth / 2}" y="${top}" width="${bodyWidth}" height="${height}" ` +
        `fill="${rising ? "#fff" : color}" stroke="${color}" stroke-width="1"/>`
    );
  });
  return parts.join("");
}

function renderVolume(bars, layout) {
  const bodyWidth = Math.max(1.2, Math.min(14, layout.step * 0.62));
  const parts = [];
  bars.forEach((bar, index) => {
    const volume = bar.volume;
    if (!volume) return;
    // 量柱与当天蜡烛同色 (同样按开盘收盘决定)
    const rising = isRisingBar(bar);
    const y = layout.yOfVolume(volume);
    parts.push(
      `<rect x="${layout.xOf(index) - bodyWidth / 2}" y="${y}" width="${bodyWidth}" ` +
        `height="${Math.max(1, layout.geometry.volumeBottom - y)}" ` +
        `fill="${rising ? CANDLE_UP : CANDLE_DOWN}" opacity="0.55"/>`
    );
  });
  return parts.join("");
}

function renderMaLines(bars, windows, layout) {
  const parts = [];
  windows.forEach((window) => {
    const color = MA_COLORS[window] || "#64748b";
    let path = "";
    let drawing = false;
    bars.forEach((bar, index) => {
      const value = (bar.ma || {})[String(window)];
      if (value === null || value === undefined) {
        drawing = false;
        return;
      }
      const point = `${layout.xOf(index)},${layout.yOf(value)}`;
      path += `${drawing ? " L" : "M"}${point}`;
      drawing = true;
    });
    if (path) {
      parts.push(
        `<path d="${path}" fill="none" stroke="${color}" stroke-width="1.6" ` +
          `stroke-linejoin="round" stroke-linecap="round"/>`
      );
    }
  });
  return parts.join("");
}

function renderXAxis(bars, layout) {
  const parts = [];
  const ticks = Math.min(6, bars.length);
  for (let index = 0; index < ticks; index += 1) {
    const position = Math.round((index * (bars.length - 1)) / Math.max(1, ticks - 1));
    const x = layout.xOf(position);
    const anchor = position === 0 ? "start" : position === bars.length - 1 ? "end" : "middle";
    parts.push(
      `<text x="${x}" y="${layout.geometry.axisY}" text-anchor="${anchor}" ` +
        `class="chart-axis-label">${bars[position].trade_date.slice(5)}</text>`
    );
  }
  return parts.join("");
}

function renderCrosshair(id = "chart-crosshair") {
  // 十字光标常驻在 SVG 里, 悬停时只改坐标, 避免每次移动都重绘整张图。
  return (
    `<g class="chart-crosshair" id="${id}" style="display:none">` +
    `<line class="cross-v" x1="0" y1="0" x2="0" y2="0"/>` +
    `<line class="cross-h" x1="0" y1="0" x2="0" y2="0"/>` +
    `<circle class="cross-dot" cx="0" cy="0" r="3"/>` +
    `</g>`
  );
}

/** 按当前 hoverIndex 移动十字光标 (不重绘整个图)。 */
function updateCrosshair() {
  const index = chartState?.hoverIndex;
  const svg = chartRoot().querySelector("#chart-stage .chart-svg");
  if (!svg || !chartState?.layout) return;
  const targets = chartState.comparisons.size ? [...svg.querySelectorAll(".chart-compare-lane")].map(lane => ({
    container: lane, layout: chartState.comparisons.get(lane.dataset.chartCode)?.layout || chartState.layout,
  })) : [{container: svg, layout: chartState.layout}];
  targets.forEach(({container, layout}) => {
    const group = container.querySelector(".chart-crosshair");
    if (layout.baseClose) container.querySelector(".chart-relative-readout").textContent =
      chartCompareReadout(layout.bars[index ?? layout.bars.length - 1], layout);
    if (!group || index == null || !layout.bars[index]) {
      if (group) { group.style.display = "none"; delete group.dataset.tradeDate; }
      return;
    }
    const bar = layout.bars[index];
    const price = layout.baseClose ? (bar.close / layout.baseClose - 1) * 100 : bar.close;
    const x = layout.xOf(index), y = layout.yOf(price ?? layout.low);
    group.style.display = "";
    group.dataset.tradeDate = bar.trade_date;
    const vertical = group.querySelector(".cross-v"), horizontal = group.querySelector(".cross-h"), dot = group.querySelector(".cross-dot");
    vertical.setAttribute("x1", x); vertical.setAttribute("x2", x);
    vertical.setAttribute("y1", layout.geometry.priceTop);
    vertical.setAttribute("y2", chartState.comparisons.size ? layout.geometry.priceBottom : layout.geometry.volumeBottom);
    horizontal.setAttribute("x1", layout.plotLeft); horizontal.setAttribute("x2", layout.plotRight);
    horizontal.setAttribute("y1", y); horizontal.setAttribute("y2", y);
    dot.setAttribute("cx", x); dot.setAttribute("cy", y);
    horizontal.style.display = dot.style.display = bar.close == null ? "none" : "";
  });
}

function renderLegend() {
  const bars = chartState.visible || [];
  if (!bars.length) return;
  const index = chartState.hoverIndex;
  const bar =
    bars[index === null || index === undefined ? bars.length - 1 : index] || bars[bars.length - 1];
  const items = (chartState.payload.ma_windows || []).map((window) => {
    const value = (bar.ma || {})[String(window)];
    return (
      `<span class="legend-ma"><i style="background:${
        MA_COLORS[window] || "#64748b"
      }"></i>MA${window}${chartState.comparisons.size ? "" : ` ${nm(value)}`}</span>`
    );
  });
  chartRoot().querySelector("#chart-legend").innerHTML = items.join("");
}

function updateChartSummary() {
  const payload = chartState.payload;
  const all = chartState.bars || [];
  const bars = chartState.visible || [];
  const last = all[all.length - 1];
  const first = all[0];
  const root = chartRoot();
  if (chartState.comparisons.size) {
    root.querySelector("#chart-sub").textContent = `${chartState.comparisons.size + 1} 只个股 · ${bars[0].trade_date} 至 ${bars.at(-1).trade_date} · ${bars.length} 个交易日 · 首个有效收盘为 0%`;
    root.querySelector("#chart-note").textContent = "各股共用时间轴，鼠标移动时所有光标同步到同一交易日；按区间首个有效收盘价归零，纵轴以可见 K 线为准。" +
      (chartState.compareScale === "shared" ? "统一刻度可比较涨幅大小。" : "独立缩放时，请按百分比刻度比较涨幅大小。") +
      "滚轮缩放时间轴，拖动平移，双击复位；沿右侧滚动条或按住 Shift 滚轮可上下查看。";
    return;
  }
  root.querySelector("#chart-sub").textContent =
    `${payload.board_label} · 本地 ${first.trade_date} ~ ${last.trade_date} 共 ${all.length} 根 · ` +
    `当前显示 ${bars.length} 根 · 最新收盘 ${nm(last.close)} ` +
    `(${last.pct_chg === null ? "—" : `${nm(last.pct_chg)}%`})`;
  root.querySelector("#chart-note").textContent =
    "均线为简单移动平均 (SMA), 与本系统的筛选口径一致; 红色为上涨、绿色为下跌; " +
    "数据来自本地日线缓存。滚轮缩放、拖动平移时间轴、← → 切换股票、双击复位, " +
    "鼠标移到图上可看单日明细。";
}

function onChartHover(event) {
  if (!chartState || !chartState.layout) return;
  const root = chartRoot();
  const svg = event.target.closest?.("#chart-stage .chart-svg");
  if (!svg) return;
  const lane = event.target.closest?.("[data-chart-code]");
  if (chartState.comparisons.size && !lane) return;
  const code = lane?.dataset.chartCode || chartState.code;
  const rect = svg.getBoundingClientRect();
  const layout = chartState.comparisons.get(code)?.layout || chartState.layout;
  const scale = layout.width / rect.width;
  const x = (event.clientX - rect.left) * scale;
  const index = Math.floor((x - layout.plotLeft) / layout.step);
  if (index < 0 || index >= layout.bars.length) return;
  if (chartState.hoverIndex !== index || chartState.hoverCode !== code) {
    chartState.hoverIndex = index;
    chartState.hoverCode = code;
    updateCrosshair();
    renderLegend();
  }
  showChartTip(index, event);
}

function showChartTip(index, event) {
  const root = chartRoot();
  const tip = root.querySelector("#chart-tip");
  const entry = chartState.comparisons.get(chartState.hoverCode);
  const bar = (entry ? entry.layout?.bars : chartState.visible || [])[index];
  if (!bar) return;
  const rows = [
    `<strong>${escapeHtml(entry?.payload?.name || chartState.payload.name)} · ${bar.trade_date}</strong>`,
    `开 ${nm(bar.open)} · 高 ${nm(bar.high)} · 低 ${nm(bar.low)} · 收 ${nm(bar.close)}`,
    `涨跌幅 ${bar.pct_chg === null ? "—" : `${nm(bar.pct_chg)}%`} · 成交量 ${formatVolume(bar.volume)}`,
    Object.entries(bar.ma || {})
      .map(([window, value]) => `MA${window} ${nm(value)}`)
      .join(" · "),
  ];
  if (chartState.comparisons.size) {
    const layout = entry?.layout || chartState.layout;
    rows.push(`基准 ${layout.baseDate || "—"} · 区间相对涨跌幅 ${bar.close == null || !layout.baseClose ? "—" : `${nm((bar.close / layout.baseClose - 1) * 100)}%`}`);
  }
  tip.innerHTML = rows.join("<br>");
  tip.hidden = false;

  const stage = root.querySelector("#chart-stage");
  const stageRect = stage.getBoundingClientRect();
  const left = Math.min(
    Math.max(8, event.clientX - stageRect.left + 16),
    Math.max(8, stageRect.width - tip.offsetWidth - 8)
  );
  const top = Math.min(
    Math.max(8, event.clientY - stageRect.top + 14),
    Math.max(8, stageRect.height - tip.offsetHeight - 8)
  );
  tip.style.left = `${left}px`;
  tip.style.top = `${top + stage.scrollTop}px`;
}

/* --- 缩放 / 平移 / 切换股票 --------------------------------------------- */

/** 鼠标相对绘图区的位置 (0 = 最左, 1 = 最右)。 */
function chartRatioAt(clientX, layout = chartState.layout) {
  const svg = chartRoot().querySelector(".chart-svg");
  if (!layout || !svg) return 0.5;
  const rect = svg.getBoundingClientRect();
  const scale = layout.width / rect.width;
  const x = (clientX - rect.left) * scale;
  const width = layout.plotRight - layout.plotLeft;
  return Math.min(1, Math.max(0, (x - layout.plotLeft) / width));
}

/**
 * 滚轮缩放: 以鼠标所在的 K 线为锚点改变可见根数。
 * 向上滚 (deltaY < 0) 放大 = 看得更少更细; 向下滚缩小 = 看更长的一段。
 */
function onChartWheel(event) {
  if (!chartState || !chartState.layout) return;
  if (!event.target.closest?.(".chart-svg")) return;
  if (chartState.comparisons.size && event.shiftKey) {
    event.preventDefault();
    chartRoot().querySelector("#chart-stage").scrollTop += event.deltaY || event.deltaX;
    return;
  }
  event.preventDefault();
  const total = chartDates().length;
  if (total <= CHART_MIN_BARS) return;

  const code = event.target.closest?.("[data-chart-code]")?.dataset.chartCode;
  const ratio = chartRatioAt(event.clientX, chartState.comparisons.get(code)?.layout || chartState.layout);
  const { start, count } = chartState.view;
  const anchor = start + ratio * Math.max(1, count - 1);
  const factor = event.deltaY > 0 ? CHART_ZOOM_STEP : 1 / CHART_ZOOM_STEP;
  const nextCount = Math.round(
    Math.min(Math.max(count * factor, CHART_MIN_BARS), total)
  );
  if (nextCount === count) return;

  const nextStart = Math.round(anchor - ratio * Math.max(1, nextCount - 1));
  chartState.view = {
    start: Math.min(Math.max(nextStart, 0), Math.max(0, total - nextCount)),
    count: nextCount,
  };
  chartState.hoverIndex = null;
  redrawChart();
}

function onChartMouseDown(event) {
  if (!chartState || !chartState.layout || event.button !== 0) return;
  const onChart = event.target.closest && event.target.closest(".chart-svg");
  if (!onChart) return;
  chartState.drag = {
    startX: event.clientX,
    viewStart: chartState.view.start,
    moved: false,
  };
  chartRoot().classList.add("is-dragging");
  event.preventDefault();
}

function onChartMouseMove(event) {
  if (!chartState) return;
  if (chartState.drag) {
    dragChart(event);
    return;
  }
  onChartHover(event);
}

function onChartMouseUp() {
  if (!chartState || !chartState.drag) return;
  chartState.drag = null;
  chartRoot().classList.remove("is-dragging");
}

/** 拖动平移时间轴: 向右拖看更早的行情。 */
function dragChart(event) {
  const layout = chartState.layout;
  const svg = chartRoot().querySelector(".chart-svg");
  if (!layout || !svg) return;
  const rect = svg.getBoundingClientRect();
  const scale = layout.width / rect.width;
  const dx = (event.clientX - chartState.drag.startX) * scale;
  const barsMoved = Math.round(dx / layout.step);
  if (barsMoved !== 0) chartState.drag.moved = true;
  moveViewTo(chartState.drag.viewStart - barsMoved);
}

function moveViewTo(desiredStart) {
  const total = chartDates().length;
  const maxStart = Math.max(0, total - chartState.view.count);
  const clamped = Math.min(Math.max(desiredStart, 0), maxStart);
  if (desiredStart < 0 && chartState.hasMore && !chartState.loadingMore) {
    loadOlderBars(); // 拖到最左端时自动补齐更早的历史
  }
  if (desiredStart < 0 && chartState.comparisons.size) loadChartComparisons(shiftIsoDate(chartDates()[0], -1));
  if (clamped !== chartState.view.start) {
    chartState.view.start = clamped;
    chartState.hoverIndex = null;
    redrawChart();
  }
}

/** ← / → (以及弹窗里的 ◀ ▶ 按钮) 切换股票。 */
async function stepStock(delta) {
  if (!chartState || !chartState.list || chartState.list.length < 2) return;
  const size = chartState.list.length;
  const index = ((chartState.index + delta) % size + size) % size;
  // 换股票时保留缩放级别, 按当前入口复位时间轴
  const zoom = chartState.view.count;
  clearTimeout(chartState.compareSearchTimer);
  chartState = {...chartState, index, loadingMore: false, hasMore: false};
  const entry = chartState.list[index];
  chartState.code = entry.code;
  chartState.comparisons.delete(entry.code);
  chartState.timeline = null;
  chartState.layout = null;
  chartState.drag = null;
  chartState.compareDraft = new Map();
  chartRoot().querySelector("#chart-compare-picker").hidden = true;
  chartRoot().querySelector("#chart-compare-toggle").setAttribute("aria-expanded", "false");
  chartRoot().querySelector("#chart-comparisons").innerHTML = "";
  chartState.name = entry.name || "";
  // 每一只股票各自的选出日 (整月扫描时每天不同, 单日筛选时相同)
  chartState.screenDate = entry.date || null;
  chartState.bars = [];
  chartState.visible = [];
  chartState.hoverIndex = null;
  chartState.payload = null;
  chartRoot().querySelector("#chart-canvas").innerHTML =
    `<p class="chart-loading"><span class="loading"></span>正在读取 ${escapeHtml(entry.code)} 的本地日线…</p>`;
  updateChartPosition();
  updateChartScreenDate();
  await Promise.all([
    loadChartData({ resetView: true, count: zoom }),
    refreshChartWatch(),
  ]);
}

function updateChartPosition() {
  if (!chartState) return;
  const root = chartRoot();
  const size = (chartState.list || []).length;
  const position = root.querySelector("#chart-position");
  position.textContent = size > 1 ? `${chartState.index + 1} / ${size}` : "1 / 1";
  root.querySelector("#chart-prev").disabled = size < 2;
  root.querySelector("#chart-next").disabled = size < 2;
  position.title = size > 1 ? "← / → 切换股票" : "当前列表只有这一只股票";
}

/**
 * 显示这只股票的"选出日"(基准日 T0)。
 *
 * 日期来自当前这次筛选: 单日筛选是所选那一天, 整月扫描是它实际被选中的那一天,
 * 自选股则用它收藏时的来源筛选日; 没有来源信息时整行隐藏, 不会瞎猜一个固定日期。
 */
function updateChartScreenDate() {
  const root = chartRoot();
  const node = root.querySelector("#chart-screen-date");
  if (!node) return;
  const value = chartState ? chartState.screenDate : null;
  if (!value) {
    node.hidden = true;
    node.textContent = "";
    return;
  }
  node.hidden = false;
  node.textContent = `选出日 (T0): ${value}`;
}
