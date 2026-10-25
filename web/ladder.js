/* 按日期列、连板高度行对齐, 复用单日股池接口。 */
let ladderData = null;
let ladderDays = [];
let ladderBusy = false;
let ladderCount = 5;
let ladderZoom = 1;
let ladderVisible = new Map();
let ladderViewportKey = "";
let ladderRenderWindow = null;
let ladderRenderedFilter = "";
const ladderRenderedStates = new Map();
const ladderHeaderCache = new Map();
const ladderCache = new Map();
let ladderScrollTimer;
let ladderThemeCandidates = null;
let ladderThemeLoading = false;
let ladderThemeDate = "";
let ladderThemeRequest = 0;
let ladderThemeNotice = "";
let ladderThemeError = "";
let ladderThemeStatus = null;
let ladderThemePoll;
let ladderThemeAction = false;
let ladderThemeReloadPending = false;
const ladderChartCache = new Map();
const ladderChartQueue = [];
let ladderChartActive = 0;
let ladderChartObserver;
const ladderChartObserved = new Set();
const ladderChartVisible = new Set();

function ladderMiniChart(bars, day) {
  return renderMiniChart(bars, day);
}

function paintLadderCharts(code, day) {
  const selector = code == null ? ".ladder-mini-chart"
    : `.ladder-mini-chart[data-code=${JSON.stringify(code)}][data-date=${JSON.stringify(day)}]`;
  $("ladder-groups").querySelectorAll(selector).forEach((node) => {
    const state = ladderChartCache.get(`${node.dataset.date}:${node.dataset.code}`);
    const markup = state?.markup || (state?.error ? "日K未就绪" : "日K加载中");
    if (node.ladderChartMarkup !== markup) {
      node.innerHTML = markup;
      node.ladderChartMarkup = markup;
    }
    const title = state?.error || "最近20根日K，截至该列日期；点击查看完整K线";
    if (node.title !== title) node.title = title;
    if (state?.markup || state?.error) {
      ladderChartObserver?.unobserve(node);
      ladderChartObserved.delete(node);
      ladderChartVisible.delete(node);
    }
  });
}

function queueLadderChart(code, day) {
  const key = `${day}:${code}`;
  if (ladderChartCache.has(key)) return;
  const state = {};
  ladderChartCache.set(key, state);
  ladderChartQueue.push({code, day, state});
  drainLadderCharts();
}

function drainLadderCharts() {
  while (ladderChartActive < 3 && ladderChartQueue.length) {
    const {code, day, state} = ladderChartQueue.shift();
    const key = `${day}:${code}`;
    if (ladderChartCache.get(key) !== state) continue;
    if (ladderChartObserver && !Array.from(ladderChartVisible).some((node) =>
      node.isConnected && node.dataset.code === code && node.dataset.date === day)) {
      ladderChartCache.delete(key);
      continue;
    }
    ladderChartActive++;
    api(`/api/stocks/${encodeURIComponent(code)}/chart?limit=20&end=${encodeURIComponent(day)}`)
      .then((payload) => { state.markup = ladderMiniChart(payload.bars, day); })
      .catch((error) => { state.error = error.message; })
      .finally(() => {
        ladderChartActive--;
        try {
          if (ladderChartCache.get(key) === state) paintLadderCharts(code, day);
        } finally {
          drainLadderCharts();
        }
      });
  }
}

function observeLadderCharts() {
  paintLadderCharts();
  if (typeof IntersectionObserver === "undefined") return;
  if (!ladderChartObserver) ladderChartObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting || !entry.target.isConnected) {
        ladderChartVisible.delete(entry.target);
        return;
      }
      const state = ladderChartCache.get(`${entry.target.dataset.date}:${entry.target.dataset.code}`);
      if (state?.markup || state?.error) return;
      ladderChartVisible.add(entry.target);
      queueLadderChart(entry.target.dataset.code, entry.target.dataset.date);
    });
    drainLadderCharts();
  });
  ladderChartObserved.forEach((node) => {
    if (node.isConnected) return;
    ladderChartObserver.unobserve(node);
    ladderChartObserved.delete(node);
    ladderChartVisible.delete(node);
  });
  $("ladder-groups").querySelectorAll(".ladder-mini-chart").forEach((node) => {
    const state = ladderChartCache.get(`${node.dataset.date}:${node.dataset.code}`);
    if (state?.markup || state?.error) return;
    if (!ladderChartObserved.has(node)) {
      ladderChartObserved.add(node);
      ladderChartObserver.observe(node);
    }
    if (ladderChartVisible.has(node)) queueLadderChart(node.dataset.code, node.dataset.date);
  });
  drainLadderCharts();
}

function ladderMarketDate() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

function ladderRealtimeAllowed(now = new Date()) {
  const market = new Date(now.getTime() + 8 * 3600000);
  const weekday = market.getUTCDay(), minute = market.getUTCHours() * 60 + market.getUTCMinutes();
  return weekday > 0 && weekday < 6 && (minute >= 555 && minute < 690 || minute >= 780 && minute < 900);
}

function ladderMissingTheme(day, now = new Date()) {
  const market = new Date(now.getTime() + 8 * 3600000);
  return day === market.toISOString().slice(0, 10) && market.getUTCHours() * 60 + market.getUTCMinutes() < 930
    ? "题材待收盘下载" : "题材未获取";
}

function ladderMoney(value) {
  if (value == null) return "—";
  if (value >= 1e8) return `${(value / 1e8).toFixed(2)}亿`;
  return `${(value / 1e4).toFixed(0)}万`;
}

function ladderNumber(value, suffix = "") {
  return value == null ? "—" : `${value.toFixed(2)}${suffix}`;
}

function ladderColumnWidth(width, count) {
  return Math.max(180, (width - 56) / count) * ladderZoom;
}

function ladderViewportRange(left, width, count, total) {
  const column = ladderColumnWidth(width, count);
  // 浏览器会把亚像素滚动位置取整, 边界留 1px 避免多算一列。
  return {first: Math.max(0, Math.min(total - 1, Math.floor((left + 1) / column))),
    end: Math.min(total, Math.ceil((left + width - 56 * ladderZoom - 1) / column))};
}

function ladderViewportDays() {
  const root = $("ladder-groups");
  const range = ladderViewportRange(root.scrollLeft, root.clientWidth, ladderCount, ladderDays.length);
  return ladderDays.slice(range.first, range.end);
}

function updateLadderViewport(dates) {
  const range = ladderViewportRange($("ladder-groups").scrollLeft, $("ladder-groups").clientWidth, ladderCount, ladderDays.length);
  if (ladderData && (!ladderRenderWindow || range.first < ladderRenderWindow.first || range.end > ladderRenderWindow.end)) {
    renderLadderRows();
  }
  const compact = $("ladder-compact").checked;
  const key = `${compact}:${dates.map((entry) => entry.trade_date).join(",")}`;
  if (key === ladderViewportKey) return;
  ladderViewportKey = key;
  const viewport = new Set(dates.map((entry) => entry.trade_date));
  const heights = new Set(dates.flatMap((entry) => ladderVisible.get(entry.trade_date) || [])
    .map((item) => item.consecutive));
  const rows = $("ladder-groups").querySelectorAll("tbody tr");
  let top = true;
  // 拖动时只切换显隐，保留卡片、日K和板块展开状态。
  rows.forEach((row) => {
    const height = Number(row.dataset.height);
    const empty = !heights.has(height);
    row.hidden = compact ? (height ? empty : heights.size > 0) : !height && rows.length > 1;
    row.classList.toggle("is-empty-rank", empty);
    row.dataset.top = String(!row.hidden && top);
    if (!row.hidden) top = false;
    row.querySelectorAll("td[data-date]").forEach((cell) => {
      cell.classList.toggle("is-outside-viewport", compact && !viewport.has(cell.dataset.date));
    });
  });
}

function syncLadderScroll(source = $("ladder-groups")) {
  const root = $("ladder-groups");
  if (source === $("ladder-sticky-head") && source.hidden) return;
  if (source !== root && Math.abs(root.scrollLeft - source.scrollLeft) > 1) root.scrollLeft = source.scrollLeft;
  [$("ladder-scrollbar"), $("ladder-sticky-head")].forEach((target) => {
    if (Math.abs(target.scrollLeft - root.scrollLeft) > 1) target.scrollLeft = root.scrollLeft;
  });
  const dates = ladderViewportDays();
  if (!dates.length) return;
  updateLadderViewport(dates);
  positionLadderHeader();
  $("ladder-scroll-hint").textContent = `${dates[0].trade_date} 至 ${dates.at(-1).trade_date} · 拖动浏览 ${ladderDays.length} 个交易日`;
  $("ladder-date").value = dates[0].trade_date;
  history.replaceState(null, "", `/stock-ladder?date=${encodeURIComponent(dates[0].trade_date)}&days=${ladderCount}&zoom=${Math.round(ladderZoom * 100)}`);
  ladderDateButtons();
}

function positionLadderHeader() {
  const root = $("ladder-groups"), floating = $("ladder-sticky-head");
  const header = root.querySelector("thead");
  if (!header) { floating.hidden = true; return; }
  const bounds = root.getBoundingClientRect(), height = header.getBoundingClientRect().height;
  floating.hidden = bounds.top >= 0 || bounds.bottom <= 0;
  if (floating.hidden) return;
  floating.style.left = `${bounds.left}px`;
  floating.style.width = `${bounds.width}px`;
  floating.style.top = `${Math.min(0, bounds.bottom - height)}px`;
  floating.scrollLeft = root.scrollLeft;
}

function layoutLadderScroll() {
  const root = $("ladder-groups"), bar = $("ladder-scrollbar");
  [root, $("ladder-sticky-head")].forEach((node) => {
    node.style.setProperty("--ladder-zoom", ladderZoom);
    node.style.setProperty("--ladder-day-width", `${ladderColumnWidth(root.clientWidth, ladderCount) / ladderZoom}px`);
  });
  $("ladder-scroll-dock").hidden = !ladderData;
  $("ladder-scrollbar-space").style.width = `${root.scrollWidth - root.clientWidth + bar.clientWidth}px`;
  syncLadderScroll();
}

function seekLadderDay(day) {
  const index = ladderDays.findIndex((entry) => entry.trade_date === day);
  if (index < 0) return;
  const root = $("ladder-groups");
  root.scrollLeft = index * ladderColumnWidth(root.clientWidth, ladderCount);
  syncLadderScroll();
  return loadLadderViewport();
}

async function loadLadderThemeCandidates(refresh = true) {
  const day = $("ladder-theme-date").value || ladderData?.trade_date;
  if (!day) return;
  if (day === ladderThemeDate && (ladderThemeLoading || !refresh && (ladderThemeCandidates || ladderThemeError))) return;
  const request = ++ladderThemeRequest;
  if (day !== ladderThemeDate) ladderThemeCandidates = null;
  ladderThemeDate = day;
  ladderThemeNotice = "";
  ladderThemeLoading = true;
  ladderThemeError = "";
  updateLadderThemeFilter();
  try {
    const candidates = await api(`/api/stock-ladder/theme-candidates?date=${encodeURIComponent(day)}`);
    if (request !== ladderThemeRequest) return;
    ladderThemeCandidates = candidates;
    const select = $("ladder-theme");
    if (select.value !== "all" && !candidates.themes.some((theme) => theme.name === select.value)) {
      ladderThemeNotice = `所选日期没有「${select.value}」，已切换为全部题材，请重新选择`;
      select.value = "all";
    }
  } catch (error) {
    if (request !== ladderThemeRequest) return;
    ladderThemeError = error.message;
  } finally {
    if (request === ladderThemeRequest) {
      ladderThemeLoading = false;
      updateLadderThemeFilter();
      renderLadder();
    }
  }
}

function updateLadderThemeFilter() {
  const choices = (ladderThemeCandidates?.themes || []).slice().sort((a, b) =>
    b.stock_count - a.stock_count || a.name.localeCompare(b.name, "zh-CN"));
  const select = $("ladder-theme"), selected = select.value || "all";
  const pending = !ladderThemeCandidates && selected !== "all"
    ? `<option value="${escapeHtml(selected)}">${escapeHtml(selected)}（待核对该日题材）</option>` : "";
  const options = '<option value="all">全部涨停题材</option>' + pending + choices.map((theme) =>
    `<option value="${escapeHtml(theme.name)}">${escapeHtml(theme.name)}（${theme.stock_count}只）</option>`).join("");
  if (select.innerHTML !== options) select.innerHTML = options;
  select.value = selected;
  select.disabled = ladderThemeLoading || !choices.length;
  select.setAttribute("aria-busy", String(ladderThemeLoading));
  const covered = ladderThemeCandidates?.covered_dates || [];
  const classified = ladderThemeCandidates?.classified_dates || [];
  const status = [ladderThemeDate ? `题材取自 ${ladderThemeDate}` : "选择题材日期", "悟道涨停主类 · 选中后筛选所有日期的同题材股票"];
  if (ladderThemeCandidates) {
    if (!covered.includes(ladderThemeDate)) status.push("该日涨停池未存档，请到数据页面补齐");
    else if (!classified.includes(ladderThemeDate)) status.push("该日题材存档未齐，筛选可能不全");
    if (ladderThemeCandidates.unclassified_count) status.push(`${ladderThemeCandidates.unclassified_count} 只股票题材未获取`);
    if (!choices.length) status.push("暂无可选题材，请先下载题材数据");
  }
  if (ladderThemeNotice) status.push(ladderThemeNotice);
  if (ladderThemeError) status.push(`读取失败：${ladderThemeError}${ladderThemeCandidates ? "（沿用该日上次候选）" : "，请重试；已选题材筛选保留"}`);
  else if (ladderThemeLoading || !ladderThemeCandidates) status.push("统计中…");
  $("ladder-theme-status").textContent = status.join(" · ");
  $("ladder-theme-retry").hidden = !ladderThemeError;
  $("ladder-theme-retry").disabled = ladderThemeLoading;
}

function renderLadderThemeStatus() {
  const status = ladderThemeStatus;
  if (!status) return;
  const message = [status.configured ? "密钥已配置" : "尚未配置悟道密钥",
    `本地题材 ${status.completed_days}/${status.total_days} 日，待补 ${status.pending_days} 日`,
    `本机今日已调用 ${status.calls_today}/${status.daily_limit} 次`];
  if (status.message) message.push(status.message);
  if (status.error && status.error !== status.message) message.push(status.error);
  if (status.download_allowed === false) message.push(status.download_block_reason || "悟道题材仅在收盘后下载，北京时间15:30后可准备下载。");
  $("ladder-theme-download-status").textContent = message.join(" · ");
  $("ladder-theme-download-status").setAttribute("aria-busy", String(status.running));
  $("ladder-theme-download").disabled = !status.configured || status.running || ladderThemeAction || status.calls_today >= status.daily_limit || status.download_allowed === false;
  $("ladder-theme-download").textContent = status.running ? "正在批量下载…" : "下载全部缺失题材";
  $("ladder-theme-save").disabled = status.running || ladderThemeAction;
  $("ladder-theme-budget").disabled = status.running || ladderThemeAction;
}

function scheduleLadderThemeStatus() {
  clearTimeout(ladderThemePoll);
  if (ladderThemeStatus?.running) ladderThemePoll = setTimeout(() => loadLadderThemeStatus(), 3000);
}

async function reloadLadderLocalThemes() {
  if (ladderBusy) { ladderThemeReloadPending = true; return; }
  ladderThemeReloadPending = false;
  ladderCache.clear();
  ladderDays.forEach((entry) => { entry.snapshot = null; entry.error = ""; });
  await loadLadderThemeCandidates();
  await loadLadderViewport();
}

async function loadLadderThemeStatus() {
  const wasRunning = ladderThemeStatus?.running;
  try {
    ladderThemeStatus = await api("/api/stock-ladder/themes/status");
    renderLadderThemeStatus();
    scheduleLadderThemeStatus();
    if (wasRunning && !ladderThemeStatus.running) await reloadLadderLocalThemes();
  } catch (error) {
    $("ladder-theme-download-status").textContent = `状态读取失败：${error.message}，请点击「检查进度」重试。`;
  }
}

async function saveLadderThemeConfig(event) {
  event.preventDefault();
  if (ladderThemeAction) return;
  const input = $("ladder-theme-key"), apiKey = input.value.trim();
  if (!apiKey) { input.focus(); return; }
  ladderThemeAction = true;
  renderLadderThemeStatus();
  $("ladder-theme-download-status").textContent = "正在保存密钥…";
  try {
    ladderThemeStatus = await api("/api/stock-ladder/themes/config", {method: "POST", body: JSON.stringify({api_key: apiKey})});
    input.value = "";
  } catch (error) {
    showAlert("error", escapeHtml(error.message));
  } finally {
    ladderThemeAction = false;
    renderLadderThemeStatus();
  }
}

async function downloadLadderThemes() {
  if (ladderThemeAction || !ladderThemeStatus?.configured || ladderThemeStatus.running) return;
  if (ladderThemeStatus.download_allowed === false) {
    showAlert("error", escapeHtml(ladderThemeStatus.download_block_reason || "悟道题材仅在收盘后下载，请在北京时间15:30后重试。"));
    return;
  }
  const maxCalls = Number($("ladder-theme-budget").value);
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 50) {
    showAlert("error", "每次下载的调用上限需要为 1 至 50 的整数。");
    return;
  }
  ladderThemeAction = true;
  renderLadderThemeStatus();
  $("ladder-theme-download-status").textContent = "正在启动题材下载…";
  try {
    ladderThemeStatus = await api("/api/stock-ladder/themes/sync", {method: "POST", body: JSON.stringify({max_calls: maxCalls})});
    scheduleLadderThemeStatus();
    if (!ladderThemeStatus.running) await reloadLadderLocalThemes();
  } catch (error) {
    showAlert("error", escapeHtml(error.message));
  } finally {
    ladderThemeAction = false;
    renderLadderThemeStatus();
  }
}

function ladderFiltered(items) {
  const query = $("ladder-search").value.trim().toLowerCase();
  const board = $("ladder-board").value;
  const theme = $("ladder-theme").value;
  return items.filter((item) => {
    if ($("ladder-exclude-st").checked && item.is_st) return false;
    if ($("ladder-multi").checked && item.consecutive < 2) return false;
    if (board === "main" && !["main_sh", "main_sz"].includes(item.board)) return false;
    if (!["all", "main"].includes(board) && item.board !== board) return false;
    if (theme && theme !== "all" && item.primary_theme !== theme) return false;
    return !query || `${item.name} ${item.code} ${item.primary_theme || ""}`.toLowerCase().includes(query);
  }).sort((a, b) => {
    if (a.consecutive !== b.consecutive) return b.consecutive - a.consecutive;
    const sort = $("ladder-sort").value;
    if (sort === "funds" || sort === "turnover") {
      const key = sort === "funds" ? "seal_funds" : "turnover";
      const diff = (b[key] ?? -1) - (a[key] ?? -1);
      if (diff) return diff;
    }
    return (a.first_seal || "99").localeCompare(b.first_seal || "99") || a.code.localeCompare(b.code);
  });
}

function ladderCard(item, day) {
  const theme = item.primary_theme || ladderMissingTheme(day);
  return `<div class="ladder-stock"><button type="button" class="ladder-card" data-code="${escapeHtml(item.code)}" data-date="${escapeHtml(day)}" title="${escapeHtml(item.code)} · ${escapeHtml(item.board_label || "")} · 点击看 K 线" aria-label="查看 ${escapeHtml(day)} ${escapeHtml(item.name)} ${escapeHtml(item.code)} 的 K 线，当日涨停题材：${escapeHtml(theme)}">
    <span class="ladder-card-head"><strong>${escapeHtml(item.name)}</strong><span class="ladder-gain">${ladderNumber(item.pct_chg, "%")}</span></span>
    <span class="ladder-card-foot"><span class="ladder-theme-tag${item.primary_theme ? "" : " is-missing"}" title="${escapeHtml(day)} · ${escapeHtml(item.primary_theme ? `悟道涨停主类：${item.primary_theme}` : theme)}">${escapeHtml(theme)}</span><span>额 ${ladderMoney(item.amount)}</span></span>
    <span class="ladder-mini-chart" data-code="${escapeHtml(item.code)}" data-date="${escapeHtml(day)}">日K加载中</span>
  </button></div>`;
}

function ladderDayNote(entry) {
  if (entry.loading) return '<span class="loading"></span> 读取中…';
  if (entry.error) return `${escapeHtml(entry.error)}<br>请到<a href="/data">数据页面</a>补齐存档，再刷新本地数据`;
  if (!entry.snapshot) return "横向拖动到该日期后加载";
  if (!entry.snapshot?.items.length) return '本地未存档，请到<a href="/data">数据页面</a>下载涨停池';
  if ($("ladder-theme").value !== "all" && entry.snapshot.items.some((item) => !item.primary_theme)) return "部分股票的当日题材未获取，题材筛选可能不全；请在「悟道题材数据」补充下载";
  return "没有符合筛选条件的股票";
}

function ladderStorageLabel(snapshot) {
  if (!snapshot?.items.length) return "未存档";
  const label = snapshot.data_source === "local" ? "本地存档" : ["eastmoney", "ths"].includes(snapshot.data_source) ? "已存本地" : "";
  return label ? `${label}${snapshot.origin === "ths" ? " · 同花顺" : ""}${snapshot.is_final ? "" : " · 盘中快照"}${snapshot.stale ? " · 更新未成功" : ""}` : "";
}

function ladderCurrentFilter() {
  return JSON.stringify([$("ladder-search").value, $("ladder-board").value, $("ladder-theme").value,
    $("ladder-sort").value, $("ladder-exclude-st").checked, $("ladder-multi").checked]);
}

function renderLadderRows() {
  const root = $("ladder-groups");
  const range = ladderViewportRange(root.scrollLeft, root.clientWidth, ladderCount, ladderDays.length);
  const window = {first: Math.max(0, range.first - 2), end: Math.min(ladderDays.length, range.end + 2)};
  const days = ladderDays.slice(window.first, window.end);
  const filter = ladderCurrentFilter();
  const heights = [...new Set([...ladderVisible.values()].flat().map((item) => item.consecutive))].sort((a, b) => b - a);
  const signature = `${window.first}:${window.end}:${heights.join(",")}:${$("ladder-compact").checked}`;
  const body = root.querySelector("tbody");
  const unchanged = (entry) => {
    const state = ladderRenderedStates.get(entry.trade_date);
    const items = ladderVisible.get(entry.trade_date) || [];
    return state && state.snapshot === entry.snapshot && state.loading === entry.loading && state.error === entry.error &&
      state.note === ladderDayNote(entry) && state.items.length === items.length && state.items.every((item, index) => item === items[index]);
  };
  if (body && signature === ladderRenderWindow?.signature && filter === ladderRenderedFilter && days.every(unchanged)) return;
  const focused = root.contains?.(document.activeElement) ? document.activeElement : null;
  const focusCard = focused?.closest(".ladder-stock")?.querySelector(".ladder-card");
  const oldCells = new Map(Array.from(root.querySelectorAll("td[data-date]"), (cell) =>
    [`${cell.parentElement.dataset.height}:${cell.dataset.date}`, cell]));
  const reused = new Map();
  const compact = $("ladder-compact").checked;
  const viewport = new Set(ladderViewportDays().map((entry) => entry.trade_date));
  const viewportHeights = new Set(ladderViewportDays().flatMap((entry) => ladderVisible.get(entry.trade_date) || []).map((item) => item.consecutive));
  const topHeight = compact ? heights.find((height) => viewportHeights.has(height)) ?? null : heights[0] ?? null;
  const spacer = (count) => count ? `<td colspan="${count}" class="ladder-spacer" aria-hidden="true"></td>` : "";
  const rows = [...heights, null].map((height) => {
    const empty = !viewportHeights.has(height);
    const hidden = compact ? (height !== null ? empty : viewportHeights.size > 0) : height === null && heights.length > 0;
    const cells = days.map((entry) => {
      const key = `${height ?? ""}:${entry.trade_date}`;
      if (oldCells.has(key) && filter === ladderRenderedFilter && unchanged(entry)) {
        reused.set(key, oldCells.get(key));
        return `<td data-reuse="${key}"></td>`;
      }
      const items = (ladderVisible.get(entry.trade_date) || []).filter((item) => item.consecutive === height);
      const note = !entry.snapshot || !ladderVisible.get(entry.trade_date)?.length;
      return `<td data-date="${entry.trade_date}"${compact && !viewport.has(entry.trade_date) ? ' class="is-outside-viewport"' : ""}>${items.map((item) => ladderCard(item, entry.trade_date)).join("") ||
        (note ? `<p class="ladder-cell-note">${ladderDayNote(entry)}</p>` : '<span class="ladder-cell-dash">—</span>')}</td>`;
    }).join("");
    return `<tr${empty ? ' class="is-empty-rank"' : ""} data-height="${height ?? ""}" data-top="${height === topHeight}"${hidden ? " hidden" : ""}><th scope="row" class="ladder-rank"><span class="${height >= 5 ? "is-high" : ""}">${height == null ? "—" : height === 1 ? "首板" : `${height}板`}</span></th>${spacer(window.first)}${cells}${spacer(ladderDays.length - window.end)}</tr>`;
  }).join("");
  if (body) {
    const next = document.createElement("tbody");
    next.innerHTML = rows;
    const oldRows = new Map(Array.from(body.children, (row) => [row.dataset.height, row]));
    let cursor = body.firstElementChild;
    Array.from(next.children).forEach((template) => {
      const row = oldRows.get(template.dataset.height) || template;
      if (row !== template) {
        row.hidden = template.hidden;
        row.className = template.className;
        row.dataset.top = template.dataset.top;
        const cells = [row.firstElementChild, ...Array.from(template.children).slice(1)
          .map((cell) => reused.get(cell.dataset.reuse) || cell)];
        const keep = new Set(cells);
        Array.from(row.children).forEach((cell) => { if (!keep.has(cell)) cell.remove(); });
        let position = row.firstElementChild;
        cells.forEach((cell) => {
          if (cell === position) position = position.nextElementSibling;
          else row.insertBefore(cell, position);
        });
      }
      if (row === cursor) cursor = cursor.nextElementSibling;
      else body.insertBefore(row, cursor);
      oldRows.delete(template.dataset.height);
    });
    oldRows.forEach((row) => row.remove());
  } else {
    root.innerHTML = `${ladderTableHead()}<tbody>${rows}</tbody></table>`;
  }
  ladderRenderWindow = {...window, signature};
  ladderRenderedFilter = filter;
  ladderRenderedStates.clear();
  days.forEach((entry) => ladderRenderedStates.set(entry.trade_date, {snapshot: entry.snapshot, loading: entry.loading,
    error: entry.error, items: ladderVisible.get(entry.trade_date) || [], note: ladderDayNote(entry)}));
  ladderViewportKey = "";
  if (focused?.isConnected) focused.focus({preventScroll: true});
  else if (focusCard) root.querySelector(`.ladder-card[data-code="${focusCard.dataset.code}"][data-date="${focusCard.dataset.date}"]`)
    ?.focus({preventScroll: true});
  observeLadderCharts();
}

function ladderDayHeader(entry) {
  const items = ladderVisible.get(entry.trade_date) || [];
  const incomplete = entry.snapshot && !entry.snapshot.theme_complete;
  const key = `${items.length}:${incomplete}:${entry.loading}:${entry.error}`;
  const cached = ladderHeaderCache.get(entry.trade_date);
  if (cached && cached.snapshot === entry.snapshot && cached.key === key) return cached.markup;
  const weekday = new Date(`${entry.trade_date}T12:00:00+08:00`).toLocaleDateString("zh-CN", {weekday: "short", timeZone: "Asia/Shanghai"});
  const themePending = entry.snapshot && !entry.snapshot.theme_is_final &&
    (entry.snapshot.theme_fetched_at || ladderMissingTheme(entry.trade_date) === "题材待收盘下载");
  const count = entry.snapshot ? `${items.length} 家${themePending ? " · 题材待收盘下载" : incomplete ? " · 题材未齐" : ""}` : "—";
  let fetched = entry.snapshot ? `涨停池获取时间 ${new Date(entry.snapshot.fetched_at).toLocaleString("zh-CN", {timeZone: "Asia/Shanghai", hour12: false})}` : "";
  if (entry.snapshot?.theme_fetched_at && entry.snapshot.theme_is_final) fetched += `；悟道题材获取时间 ${new Date(entry.snapshot.theme_fetched_at).toLocaleString("zh-CN", {timeZone: "Asia/Shanghai", hour12: false})}`;
  else if (themePending) fetched += "；题材待收盘下载";
  if (entry.snapshot?.theme_error) fetched += `；${entry.snapshot.theme_error}`;
  const markup = `<th scope="col" class="ladder-day-head" data-date="${entry.trade_date}" title="${escapeHtml(fetched)}"><span>${escapeHtml(entry.trade_date.slice(5))} <small>${escapeHtml(weekday)}</small></span><span class="ladder-day-count">${count}${entry.error ? (entry.snapshot ? " · 更新失败，旧数据" : " · 更新失败") : entry.loading ? " · 读取中" : ""}</span>${entry.snapshot ? `<span class="ladder-day-storage">${ladderStorageLabel(entry.snapshot)}</span>` : ""}</th>`;
  ladderHeaderCache.set(entry.trade_date, {snapshot: entry.snapshot, key, markup});
  return markup;
}

function ladderTableHead() {
  return `<table class="ladder-table${$("ladder-compact").checked ? " is-compact" : ""}" style="--ladder-columns:${ladderDays.length}" aria-label="按连板高度对齐的多日涨停股池"><colgroup><col style="width:56px"><col span="${ladderDays.length}" style="width:var(--ladder-day-width, 180px)"></colgroup><thead><tr><th scope="col" class="ladder-corner">层级</th>${ladderDays.map(ladderDayHeader).join("")}</tr></thead>`;
}

function renderLadder() {
  if (!ladderData) return;
  updateLadderThemeFilter();
  ladderVisible = new Map(ladderDays.map((entry) => [entry.trade_date, ladderFiltered(entry.snapshot?.items || [])]));
  const ready = ladderDays.filter((entry) => entry.snapshot).length;
  const failures = ladderDays.filter((entry) => entry.error).length;
  $("ladder-status").textContent = `${ladderDays.at(-1).trade_date} 至 ${ladderDays[0].trade_date} · ${ladderDays.length} 个交易日 · 已读取 ${ready} 日${ladderBusy ? "，读取中…" : ""}${failures ? ` · ${failures} 日更新失败` : ""}`;
  renderLadderRows();
  [$("ladder-groups"), $("ladder-sticky-head")].forEach((root) => {
    if (!root.querySelector("thead")) root.innerHTML = `${ladderTableHead()}</table>`;
    root.querySelectorAll(".ladder-table").forEach((table) => table.classList.toggle("is-compact", $("ladder-compact").checked));
    root.querySelectorAll(".ladder-day-head").forEach((node) => {
      const entry = ladderDays.find((day) => day.trade_date === node.dataset.date);
      const markup = ladderDayHeader(entry);
      if (node.outerHTML !== markup) node.outerHTML = markup;
    });
  });
  layoutLadderScroll();
}

function ladderDateButtons() {
  const days = ladderData?.trading_days || [];
  const root = $("ladder-groups");
  $("ladder-date").disabled = ladderBusy || !days.length;
  $("ladder-count").disabled = ladderBusy;
  $("ladder-prev").disabled = !days.length || root.scrollLeft >= root.scrollWidth - root.clientWidth - 1;
  $("ladder-next").disabled = !days.length || root.scrollLeft <= 1;
  $("ladder-latest").disabled = ladderBusy || !days.length || root.scrollLeft <= 1;
  $("ladder-refresh").disabled = ladderBusy;
}

async function fetchLadderDay(day, refresh) {
  const cached = ladderCache.get(day);
  if (!refresh && day && day !== ladderMarketDate() && cached?.is_final && !cached.stale) return cached;
  const params = new URLSearchParams();
  if (day) params.set("date", day);
  if (refresh) params.set("refresh", "true");
  const query = params.toString();
  const data = await api(`/api/stock-ladder${query ? `?${query}` : ""}`);
  ladderCache.set(data.trade_date, data);
  return data;
}

async function loadLadder(day = "", refresh = false) {
  if (ladderBusy) return;
  if (ladderData) return refresh ? loadLadderViewport(true) : seekLadderDay(day || ladderDays[0].trade_date);
  ladderBusy = true;
  ladderDateButtons();
  clearAlerts();
  $("ladder-groups").setAttribute("aria-busy", "true");
  $("ladder-status").textContent = "正在读取多日股池，请稍候…";
  $("ladder-refresh").textContent = "读取中…";
  try {
    const data = await fetchLadderDay(day, refresh);
    ladderData = data;
    ladderCount = Number($("ladder-count").value) || 5;
    const dates = data.trading_days.slice().reverse();
    ladderDays = dates.map((date) => ({trade_date: date,
      snapshot: date === data.trade_date ? data : ladderCache.get(date),
      loading: false, error: ""}));
    $("ladder-date").innerHTML = data.trading_days.slice().reverse().map((date) => `<option value="${escapeHtml(date)}">${escapeHtml(date)}</option>`).join("");
    $("ladder-date").value = data.trade_date;
    const themeDate = $("ladder-theme-date"), selectedThemeDate = themeDate.value;
    themeDate.innerHTML = $("ladder-date").innerHTML;
    themeDate.value = data.trading_days.includes(selectedThemeDate) ? selectedThemeDate : data.trade_date;
    themeDate.disabled = false;
    renderLadder();
    seekLadderDay(data.trade_date);
  } catch (error) {
    $("ladder-groups").innerHTML = '<p class="ladder-empty"><strong>暂时无法读取涨停池</strong>请到<a href="/data">数据页面</a>下载或补齐本地存档，再点击「刷新本地数据」。</p>';
    $("ladder-status").textContent = "数据获取失败";
    showAlert("error", escapeHtml(error.message));
  } finally {
    ladderBusy = false;
    if (ladderData && $("ladder-status").textContent.includes("读取中")) renderLadder();
    $("ladder-groups").setAttribute("aria-busy", "false");
    $("ladder-refresh").textContent = "刷新本地数据";
    ladderDateButtons();
  }
  await loadLadderViewport();
}

async function loadLadderViewport(refresh = false) {
  if (ladderBusy || !ladderData) return;
  if (ladderThemeReloadPending) { await reloadLadderLocalThemes(); return; }
  const pending = ladderViewportDays().filter((entry) => refresh || (!entry.snapshot && !entry.error));
  if (!pending.length) {
    syncLadderScroll();
    void loadLadderThemeCandidates(false);
    return;
  }
  ladderBusy = true;
  clearAlerts();
  $("ladder-groups").setAttribute("aria-busy", "true");
  $("ladder-refresh").textContent = "读取中…";
  pending.forEach((entry) => { entry.loading = true; entry.error = ""; });
  renderLadder();
  try {
    // 只加载当前可见日期, 同时最多请求三天。
    while (pending.length) {
      const viewport = new Set(ladderViewportDays());
      const batch = pending.filter((entry) => viewport.has(entry)).slice(0, 3);
      if (!batch.length) break;
      batch.forEach((entry) => pending.splice(pending.indexOf(entry), 1));
      const results = await Promise.allSettled(batch.map((entry) => fetchLadderDay(entry.trade_date, refresh)));
      results.forEach((result, index) => {
        batch[index].loading = false;
        if (result.status === "fulfilled") batch[index].snapshot = result.value;
        else batch[index].error = result.reason.message || "该日读取失败";
      });
      renderLadder();
    }
    void loadLadderThemeCandidates(refresh);
  } finally {
    pending.forEach((entry) => { entry.loading = false; });
    ladderBusy = false;
    $("ladder-groups").setAttribute("aria-busy", "false");
    $("ladder-refresh").textContent = "刷新本地数据";
    renderLadder();
  }
  // 请求期间仍允许拖动, 完成后接着读取用户当前停留的日期。
  await loadLadderViewport();
}

function stepLadderDay(offset) {
  const root = $("ladder-groups");
  root.scrollLeft -= offset * (root.clientWidth - 56 * ladderZoom);
  syncLadderScroll();
  return loadLadderViewport();
}

function scheduleLadderViewport() {
  clearTimeout(ladderScrollTimer);
  ladderScrollTimer = setTimeout(loadLadderViewport, 120);
}

function ladderScrollKey(event) {
  if (event.target !== event.currentTarget) return;
  const root = $("ladder-groups"), column = ladderColumnWidth(root.clientWidth, ladderCount);
  const page = root.clientWidth - 56 * ladderZoom;
  const offsets = {ArrowLeft: -column, ArrowRight: column, PageUp: -page, PageDown: page};
  if (!(event.key in offsets) && !["Home", "End"].includes(event.key)) return;
  event.preventDefault();
  root.scrollLeft = event.key === "Home" ? 0 : event.key === "End" ? root.scrollWidth - root.clientWidth : root.scrollLeft + offsets[event.key];
  syncLadderScroll();
  scheduleLadderViewport();
}

function openLadderChart(code, day) {
  const list = ladderVisible.get(day) || [];
  const item = list.find((stock) => stock.code === code);
  if (!item) return;
  return openStockChart(code, {name: item.name, sourceDate: day,
    list: list.map((stock) => ({code: stock.code, name: stock.name, date: day}))});
}

async function refreshLadderCurrent() {
  const today = ladderMarketDate();
  const current = ladderViewportDays().find((entry) => entry.trade_date === today);
  if (!$("ladder-auto").checked || document.hidden || ladderBusy || !current || !ladderRealtimeAllowed()) return;
  ladderBusy = true;
  ladderDateButtons();
  try {
    current.snapshot = await fetchLadderDay(today, true);
    current.error = "";
    await loadLadderThemeCandidates();
  } catch (error) {
    current.error = error.message;
  } finally {
    ladderBusy = false;
    renderLadder();
    ladderDateButtons();
  }
}

async function initLadder() {
  el.alertArea = $("alert-area");
  window.addEventListener("scroll", positionLadderHeader, {passive: true});
  [$("ladder-groups"), $("ladder-scrollbar"), $("ladder-sticky-head")].forEach((node) => {
    node.addEventListener("scroll", () => {
      syncLadderScroll(node);
      scheduleLadderViewport();
    }, {passive: true});
    node.addEventListener("keydown", ladderScrollKey);
  });
  let previousWidth = 0;
  new ResizeObserver(() => {
    const width = $("ladder-groups").clientWidth;
    if (width === previousWidth) return;
    previousWidth = width;
    const day = $("ladder-date").value;
    layoutLadderScroll();
    seekLadderDay(day);
  }).observe($("ladder-groups"));
  const params = new URLSearchParams(location.search);
  if (["3", "5", "10"].includes(params.get("days"))) $("ladder-count").value = params.get("days");
  if (["50", "60", "70", "80", "90", "100", "125", "150"].includes(params.get("zoom"))) $("ladder-zoom").value = params.get("zoom");
  ladderZoom = Number($("ladder-zoom").value) / 100;
  $("ladder-date").addEventListener("change", () => loadLadder($("ladder-date").value));
  $("ladder-theme-date").addEventListener("change", () => loadLadderThemeCandidates());
  $("ladder-count").addEventListener("change", () => {
    const day = $("ladder-date").value;
    ladderCount = Number($("ladder-count").value);
    layoutLadderScroll();
    seekLadderDay(day);
  });
  $("ladder-zoom").addEventListener("change", () => {
    const day = $("ladder-date").value;
    ladderZoom = Number($("ladder-zoom").value) / 100;
    layoutLadderScroll();
    seekLadderDay(day);
  });
  $("ladder-prev").addEventListener("click", () => stepLadderDay(-1));
  $("ladder-next").addEventListener("click", () => stepLadderDay(1));
  $("ladder-latest").addEventListener("click", () => loadLadder());
  $("ladder-refresh").addEventListener("click", () => {
    ladderChartCache.clear();
    observeLadderCharts();
    loadLadder(ladderData?.trade_date || "", true);
  });
  ["ladder-board", "ladder-theme", "ladder-sort", "ladder-exclude-st", "ladder-multi", "ladder-compact"].forEach((id) => $(id).addEventListener("change", renderLadder));
  $("ladder-theme-retry").addEventListener("click", () => loadLadderThemeCandidates());
  $("ladder-watch-add").addEventListener("click", openLadderWatchlist);
  $("ladder-theme-config").addEventListener("submit", saveLadderThemeConfig);
  $("ladder-theme-download").addEventListener("click", downloadLadderThemes);
  $("ladder-theme-status-refresh").addEventListener("click", () => loadLadderThemeStatus());
  $("ladder-search").addEventListener("input", renderLadder);
  $("ladder-groups").addEventListener("click", (event) => {
    const card = event.target.closest(".ladder-card");
    if (card) openLadderChart(card.dataset.code, card.dataset.date);
  });
  setInterval(refreshLadderCurrent, 60000);
  void loadLadderThemeStatus();
  await loadLadder(params.get("date") || "");
}

boot(initLadder);
