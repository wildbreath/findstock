/**
 * 条件选股: 选择策略、直接调参 → 在日历上选交易日 → 筛选与导出。
 *
 * 共用工具在 shared.js, 条件渲染在 conditions.js, K 线弹窗在 chart.js。
 */

const state = {
  coverage: null,
  calendarDays: new Set(),
  calendarError: null,
  calendarToken: 0,
  viewMonth: null,
  selectedDate: null,
  result: null,
  //: 整月扫描结果 (与单日结果互斥)。
  scan: null,
  //: 用户手动改过扫描月份后, 不再被日历选择覆盖。
  scanMonthPinned: false,
  //: 自选股代码集合 (用于表格里的 ☆ 状态)。
  watched: new Set(),
  //: 已保存的策略列表与本次筛选的临时条件。
  strategies: [],
  strategy: null,
  conditions: [],
  //: 上一次筛选实际用的条件, 用来提示 "参数已改, 需要重新筛选"。
  appliedConditions: null,
  busy: false,
  stopSyncWatch: null,
};

const ELEMENT_IDS = [
  "alert-area",
  "sync-banner",
  "sync-banner-text",
  "screen-button",
  "export-button",
  "scan-month",
  "scan-button",
  "scan-summary",
  "calendar-prev",
  "calendar-next",
  "calendar-year",
  "calendar-month",
  "calendar-grid",
  "calendar-hint",
  "selected-date-label",
  "criteria-status",
  "condition-list",
  "criteria-fields",
  "criteria-reset",
  "criteria-save",
  "criteria-dirty",
  "criteria-error",
  "strategy-list",
  "strategy-search",
  "strategy-count",
  "active-strategy-name",
  "active-strategy-summary",
  "edit-strategy",
  "results-panel",
  "results-title",
  "results-count",
  "results-body",
  "warnings",
];

/** 缺少这些元素说明页面与脚本版本不匹配, 直接给出可见提示。 */
const REQUIRED_IDS = [
  "alert-area",
  "screen-button",
  "export-button",
  "calendar-grid",
  "calendar-year",
  "calendar-month",
  "selected-date-label",
  "condition-list",
  "criteria-fields",
  "criteria-reset",
  "criteria-save",
  "criteria-dirty",
  "criteria-error",
  "strategy-list",
  "strategy-search",
  "scan-month",
  "scan-button",
  "scan-summary",
];

/* ------------------------------------------------------------------ 工具 */

function formatPct(value) {
  if (value === null || value === undefined) return "—";
  return `${value.toFixed(2)}%`;
}

function pctClass(value) {
  if (value === null || value === undefined || value === 0) return "flat";
  return value > 0 ? "up" : "down";
}

function formatRatio(value) {
  if (value === null || value === undefined) return "—";
  return `${value.toFixed(2)}×`;
}

function setBusy(busy) {
  state.busy = busy;
  el.screenButton.disabled = busy;
  el.scanButton.disabled = busy;
  el.screenButton.textContent = busy ? "筛选中…" : "开始筛选";
  updateCriteriaUI();
}

/* ------------------------------------------------------------ 选股策略 */

async function loadStrategies() {
  state.strategies = (await api("/api/strategies")) || [];
  const wanted = requestedStrategyId();
  state.strategy = state.strategies.find((item) => item.id === wanted) || state.strategies[0] || null;
  resetToStrategy();
}

function selectStrategy(strategyId) {
  if (el.criteriaFields.disabled) return;
  const chosen = state.strategies.find((item) => item.id === strategyId);
  if (!chosen || chosen.id === state.strategy?.id) return;
  state.strategy = chosen;
  resetToStrategy();
}

function resetToStrategy() {
  state.conditions = state.strategy ? state.strategy.conditions.map((item) => ({kind: item.kind, params: {...item.params}})) : [];
  if (state.strategy) rememberStrategy(state.strategy.id);
  renderStrategyLibrary();
  el.conditionList.innerHTML = state.conditions.map((condition, index) => conditionEditorHtml(condition, index)).join("") ||
    `<p class="condition-empty">无条件限制，将返回全部候选股票。</p>`;
  updateCriteriaUI();
}

async function saveCurrentParameters() {
  if (el.criteriaFields.disabled || !state.strategy || firstConditionError()) return;
  clearAlerts();
  el.criteriaFields.disabled = true;
  el.criteriaSave.textContent = "保存中…";
  try {
    const saved = await api(`/api/strategies/${state.strategy.id}`, {
      method: "PUT",
      body: JSON.stringify({name: state.strategy.name, conditions: state.conditions}),
    });
    state.strategy = saved;
    state.strategies = state.strategies.map((item) => item.id === saved.id ? saved : item);
    renderStrategyLibrary();
  } catch (error) {
    showAlert("error", `保存参数失败：${escapeHtml(error.message)}`);
  } finally {
    el.criteriaFields.disabled = false;
    el.criteriaSave.textContent = "保存参数";
    updateCriteriaUI();
  }
}

function firstConditionError() {
  if (!state.strategy) return "请先在策略设计页保存一套策略。";
  for (const condition of state.conditions) {
    const error = validateConditionParams(condition.kind, condition.params);
    if (error) return error;
  }
  return null;
}

function updateCriteriaUI() {
  const error = firstConditionError();
  el.criteriaError.hidden = !error;
  el.criteriaError.textContent = error || "";
  el.activeStrategyName.textContent = state.strategy?.name || "尚未选择策略";
  el.activeStrategySummary.textContent = `${state.conditions.length} 条 · 全部满足`;
  const dirty = Boolean(state.strategy) && !conditionsEqual(state.strategy.conditions, state.conditions);
  el.criteriaDirty.textContent = dirty ? "临时参数 · 未保存" : "已保存";
  el.criteriaReset.disabled = !dirty;
  el.criteriaSave.disabled = !dirty || Boolean(error);
  el.editStrategy.href = state.strategy ? `/screen/strategies?strategy=${state.strategy.id}` : "/screen/strategies";
  const stale = state.appliedConditions !== null && !conditionsEqual(state.appliedConditions, state.conditions);
  el.criteriaStatus.hidden = !stale;
  el.criteriaStatus.textContent = stale ? "参数已变化，请重新筛选" : "";
  el.exportButton.disabled = state.busy || !(state.result || state.scan) || stale || Boolean(error);
}

/** 按当前条件导出 CSV (POST 后手动触发下载)。 */
async function downloadExport(day) {
  // 当前显示的是整月扫描时, 导出扫描结果; 否则导出单日结果
  const scanning = Boolean(state.scan);
  const url = scanning ? "/api/screen/scan/export" : "/api/screen/export";
  const body = scanning
    ? { month: state.scan.month, conditions: state.appliedConditions }
    : { date: day, conditions: state.appliedConditions };
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const blobUrl = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = scanning ? `screen_scan_${state.scan.month}.csv` : `screen_${day}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(blobUrl);
  } catch (error) {
    showAlert("error", `导出失败: ${escapeHtml(error.message)}`);
  }
}

/* -------------------------------------------------------------- 日期工具 */

const CALENDAR_CELLS = 42; // 每次按 6 周跨度取数, 足够覆盖整月网格

function pad2(value) {
  return String(value).padStart(2, "0");
}

function toISO(dateObj) {
  return (
    `${dateObj.getFullYear()}-` +
    `${pad2(dateObj.getMonth() + 1)}-${pad2(dateObj.getDate())}`
  );
}

function fromISO(value) {
  const [year, month, day] = String(value)
    .slice(0, 10)
    .split("-")
    .map(Number);
  return new Date(year, month - 1, day);
}

function addDays(dateObj, days) {
  return new Date(
    dateObj.getFullYear(),
    dateObj.getMonth(),
    dateObj.getDate() + days
  );
}

function monthStartOf(dateObj) {
  return new Date(dateObj.getFullYear(), dateObj.getMonth(), 1);
}

function shiftMonth(dateObj, months) {
  return new Date(dateObj.getFullYear(), dateObj.getMonth() + months, 1);
}

/** 周一为一周的第一天。 */
function gridStartOf(monthStart) {
  return addDays(monthStart, -((monthStart.getDay() + 6) % 7));
}

/* ------------------------------------------------------------- 数据状态 */

/** 读取本地数据覆盖情况 (日历的可选范围由它决定)。 */
async function loadCoverage() {
  try {
    state.coverage = await api("/api/data/coverage");
  } catch (error) {
    state.coverage = null;
    showAlert("error", `无法读取本地数据状态: ${escapeHtml(error.message)}`);
  }
  return state.coverage;
}

async function ensureCalendar() {
  if (state.coverage && state.coverage.trading_days > 0) return;
  try {
    await api("/api/data/calendar", {
      method: "POST",
      body: JSON.stringify({
        years: (state.coverage && state.coverage.history_years) || 2,
      }),
    });
    await loadCoverage();
  } catch (error) {
    showAlert(
      "error",
      `交易日历下载失败: ${escapeHtml(error.message)}。请检查网络后重试, ` +
        `也可以到 <a href="/data">数据页面</a> 手动初始化。`
    );
  }
}

/* ------------------------------------------------------------- 交易日历 */

function calendarBounds() {
  const coverage = state.coverage || {};
  return {
    start: coverage.calendar_start || null,
    end: coverage.calendar_end || null,
    covered: coverage.bar_end || null,
  };
}

/** 首次进入或数据更新后刷新日历。 */
async function refreshCalendar() {
  if (!state.selectedDate) {
    const coverage = state.coverage || {};
    const fallback =
      coverage.bar_end || coverage.calendar_end || toISO(new Date());
    state.selectedDate = fallback;
  }
  if (!state.viewMonth) {
    state.viewMonth = monthStartOf(fromISO(state.selectedDate));
  }
  renderCalendar();
  await loadMonthDays();
}

/** 拉取当前视图月份(含首尾补白)的交易日。 */
async function loadMonthDays() {
  if (!state.viewMonth) return;
  const monthStart = state.viewMonth;
  const gridStart = gridStartOf(monthStart);
  const start = toISO(gridStart);
  const end = toISO(addDays(gridStart, CALENDAR_CELLS - 1));
  const token = (state.calendarToken += 1);

  let days = new Set();
  let failure = null;
  try {
    const payload = await api(`/api/calendar?start=${start}&end=${end}`);
    days = new Set(
      (payload.days || [])
        .filter((item) => item.is_open)
        .map((item) => item.trade_date)
    );
  } catch (error) {
    failure = error;
  }
  if (token !== state.calendarToken) return; // 用户已翻到别的月份

  state.calendarDays = days;
  state.calendarError = failure;
  renderCalendar();
}

function renderCalendar() {
  if (!state.viewMonth) return;
  const monthStart = state.viewMonth;
  const month = monthStart.getMonth();
  syncCalendarSelectors(monthStart);

  const bounds = calendarBounds();
  const today = toISO(new Date());
  const gridStart = gridStartOf(monthStart);
  const daysInMonth = new Date(
    monthStart.getFullYear(),
    month + 1,
    0
  ).getDate();
  const offset = (monthStart.getDay() + 6) % 7;
  const cellsInMonth = Math.ceil((offset + daysInMonth) / 7) * 7;
  const cells = [];

  for (let index = 0; index < cellsInMonth; index += 1) {
    const day = addDays(gridStart, index);
    const iso = toISO(day);
    const inMonth = day.getMonth() === month;
    const isTrading = state.calendarDays.has(iso);
    const outOfRange =
      (bounds.start && iso < bounds.start) ||
      (bounds.end && iso > bounds.end);
    const pending =
      isTrading && bounds.covered !== null && iso > bounds.covered;

    const classes = ["cal-day"];
    if (iso === today) classes.push("today");
    if (iso === state.selectedDate) classes.push("selected");
    if (!inMonth) classes.push("outside");

    if (isTrading) classes.push(pending ? "trading pending" : "trading");
    else classes.push("closed");

    const label = day.getDate();
    if (inMonth && isTrading && !outOfRange) {
      const title = pending
        ? `${iso} 交易日, 本地暂无该日行情`
        : `${iso} 交易日`;
      cells.push(
        `<button type="button" class="${classes.join(" ")}" data-date="${iso}" ` +
          `title="${title}">${label}</button>`
      );
    } else {
      let title = "非交易日";
      if (!inMonth) title = "";
      else if (outOfRange) title = "超出本地交易日历范围";
      cells.push(
        `<span class="${classes.join(" ")}"` +
          `${title ? ` title="${iso} ${title}"` : ""}>${label}</span>`
      );
    }
  }

  el.calendarGrid.innerHTML = cells.join("");
  updateCalendarNav();
  updateCalendarHint();
  updateSelectedDateLabel();
}

function updateSelectedDateLabel() {
  el.selectedDateLabel.textContent = state.selectedDate || "未选择";
}

function updateCalendarNav() {
  const bounds = calendarBounds();
  const key = toISO(state.viewMonth);
  const min = bounds.start ? toISO(monthStartOf(fromISO(bounds.start))) : null;
  const max = bounds.end ? toISO(monthStartOf(fromISO(bounds.end))) : null;
  el.calendarPrev.disabled = min !== null && key <= min;
  el.calendarNext.disabled = max !== null && key >= max;
}

/** 本地交易日历覆盖的年份范围 (下拉框只列出范围内的年份)。 */
function calendarYearRange() {
  const bounds = calendarBounds();
  const fallbackYear = state.selectedDate
    ? fromISO(state.selectedDate).getFullYear()
    : new Date().getFullYear();
  return {
    min: bounds.start ? fromISO(bounds.start).getFullYear() : fallbackYear - 5,
    max: bounds.end ? fromISO(bounds.end).getFullYear() : fallbackYear + 5,
  };
}

/** 同步年月下拉框: 只列出可选范围, 越界的月份置灰。 */
function syncCalendarSelectors(monthStart) {
  const range = calendarYearRange();
  const expectedYears = range.max - range.min + 1;
  const yearsStale =
    el.calendarYear.options.length !== expectedYears ||
    Number(el.calendarYear.options[0].value) !== range.min;
  if (yearsStale) {
    el.calendarYear.innerHTML = "";
    for (let year = range.min; year <= range.max; year += 1) {
      el.calendarYear.add(new Option(`${year} 年`, String(year)));
    }
  }
  if (el.calendarMonth.options.length !== 12) {
    el.calendarMonth.innerHTML = "";
    for (let month = 1; month <= 12; month += 1) {
      el.calendarMonth.add(new Option(`${month} 月`, String(month)));
    }
  }

  const year = monthStart.getFullYear();
  const month = monthStart.getMonth() + 1;
  const bounds = calendarBounds();
  const min = bounds.start ? toISO(monthStartOf(fromISO(bounds.start))) : null;
  const max = bounds.end ? toISO(monthStartOf(fromISO(bounds.end))) : null;

  Array.from(el.calendarMonth.options).forEach((option) => {
    const key = `${year}-${pad2(Number(option.value))}-01`;
    option.disabled =
      (min !== null && key < min) || (max !== null && key > max);
  });

  el.calendarYear.value = String(year);
  el.calendarMonth.value = String(month);
}

/**
 * 把视图切到指定年月 (与翻页箭头一致: 只切视图, 不改变已选日期)。
 * 超出本地交易日历范围时, 就近吸附到范围内最接近的月份, 而不是把选择弹回去。
 */
async function goToMonth(year, month) {
  const range = calendarYearRange();
  const bounds = calendarBounds();
  const firstMonth = bounds.start ? monthStartOf(fromISO(bounds.start)) : null;
  const lastMonth = bounds.end ? monthStartOf(fromISO(bounds.end)) : null;

  let target = new Date(
    Math.min(Math.max(year, range.min), range.max),
    month - 1,
    1
  );
  if (firstMonth && target.getTime() < firstMonth.getTime()) target = firstMonth;
  if (lastMonth && target.getTime() > lastMonth.getTime()) target = lastMonth;

  if (state.viewMonth && target.getTime() === state.viewMonth.getTime()) {
    renderCalendar(); // 已经把下拉框改成当前月份, 只刷新显示
    return;
  }

  state.viewMonth = target;
  state.calendarDays = new Set();
  renderCalendar();
  await loadMonthDays();
}

/** 用户改动年份或月份下拉框。 */
function jumpToSelectedMonth() {
  const year = Number(el.calendarYear.value);
  const month = Number(el.calendarMonth.value);
  if (!year || !month) return;
  goToMonth(year, month);
}

function updateCalendarHint() {
  const coverage = state.coverage || {};
  if (state.calendarError) {
    el.calendarHint.textContent = "交易日历读取失败, 请刷新页面重试";
  } else if (!coverage.trading_days) {
    el.calendarHint.textContent = "本地交易日历尚未初始化";
  } else if (coverage.bar_end) {
    el.calendarHint.textContent = `本地行情已覆盖至 ${coverage.bar_end}`;
  } else {
    el.calendarHint.textContent = "本地尚无行情数据";
  }
}

async function changeMonth(offset) {
  if (!state.viewMonth) return;
  const next = shiftMonth(state.viewMonth, offset);
  await goToMonth(next.getFullYear(), next.getMonth() + 1);
}

/** 选中某个交易日(必要时翻到对应月份)。 */
function selectDate(iso) {
  if (!iso) return;
  state.selectedDate = iso;
  if (!state.scanMonthPinned) el.scanMonth.value = iso.slice(0, 7);

  const target = monthStartOf(fromISO(iso));
  const changedMonth =
    !state.viewMonth || state.viewMonth.getTime() !== target.getTime();
  if (changedMonth) {
    state.viewMonth = target;
    state.calendarDays = new Set();
    renderCalendar();
    loadMonthDays();
    return;
  }
  renderCalendar();
}

/* ----------------------------------------------------------------- 筛选 */

async function runScreen(day) {
  if (state.busy) return;
  const invalid = firstConditionError();
  if (invalid) {
    showAlert("warn", `${escapeHtml(invalid)} 请修正选股条件后重试。`);
    return;
  }
  setBusy(true);
  const conditions = state.conditions.map((item) => ({kind: item.kind, params: {...item.params}}));
  clearAlerts();
  // 单日筛选会覆盖扫描结果, 这里先清掉, 免得导出/换股票仍用旧扫描数据
  state.scan = null;
  try {
    const result = await api("/api/screen", {
      method: "POST",
      body: JSON.stringify({ date: day, conditions }),
    });
    state.result = result;
    state.appliedConditions = conditions;
    renderResult(result);
    el.exportButton.disabled = false;
    updateCriteriaUI();
  } catch (error) {
    handleScreenError(error, day);
  } finally {
    setBusy(false);
  }
}

function handleScreenError(error, day) {
  state.result = null;
  state.scan = null;
  el.exportButton.disabled = true;
  el.resultsPanel.hidden = true;

  if (error.code === "not_a_trading_day") {
    const suggested = error.details.suggested_date;
    const actions = suggested
      ? [
          {
            label: `改用 ${suggested}`,
            primary: true,
            onClick: () => {
              selectDate(suggested);
              runScreen(suggested);
            },
          },
        ]
      : [];
    showAlert("warn", escapeHtml(error.message), actions);
    return;
  }

  if (error.code === "data_not_available") {
    // required_dates 覆盖 "行情已下载但 D2 简称快照缺失" 的情况,
    // 只提示 missing_dates 会让补数请求缺少日期而失败。
    const missing =
      error.details.required_dates || error.details.missing_dates || [];
    const actions = [
      {
        label: "下载该日期数据",
        primary: true,
        onClick: () => startDateSync(missing, day),
      },
    ];
    const suggested = error.details.suggested_date;
    if (suggested && suggested !== day) {
      actions.push({
        label: `改用基准日 ${suggested}`,
        onClick: () => {
          selectDate(suggested);
          runScreen(suggested);
        },
      });
    }
    showAlert("warn", escapeHtml(error.message), actions);
    return;
  }

  if (error.code === "calendar_not_initialized") {
    showAlert("warn", escapeHtml(error.message), [
      {
        label: "去数据页面初始化",
        primary: true,
        onClick: () => {
          window.location.href = "/data";
        },
      },
    ]);
    return;
  }

  showAlert("error", `筛选失败: ${escapeHtml(error.message)}`);
}

/* ----------------------------------------------------------------- 渲染 */

function renderResult(result) {
  // 只要最终结果: 符合条件的股票列表 (过程汇总/漏斗不展示)
  el.resultsPanel.hidden = false;
  // 先渲染提示再渲染表格: 表格在"没有命中"时会往同一区域补一段说明
  renderWarnings(result);
  renderTable(result);
}

function renderWarnings(result) {
  el.warnings.innerHTML = (result.warnings || [])
    .map((text) => `<div class="alert alert-warn">${escapeHtml(text)}</div>`)
    .join("");
}

function renderTable(result) {
  el.resultsTitle.textContent = `符合条件的股票 (基准日 T0 = ${result.window.d2})`;
  el.resultsCount.textContent = `${result.hit_count} 只`;
  el.scanSummary.hidden = true;
  el.scanSummary.textContent = "";

  if (result.hit_count === 0) {
    el.resultsBody.innerHTML = "";
    // 没有命中时给一行主要原因, 便于判断是"条件太严"还是"数据没更新"
    const reasons = Object.entries(result.rejection_counts || {})
      .sort((left, right) => right[1] - left[1])
      .slice(0, 4)
      .map(([label, count]) => `${escapeHtml(label)} ${count}`)
      .join(" · ");
    el.warnings.insertAdjacentHTML(
      "beforeend",
      `<div class="empty-state"><strong>没有符合条件的股票</strong>` +
        `${escapeHtml(result.message || "该交易日没有股票同时满足全部筛选条件。")}` +
        (reasons ? `<br>主要未通过原因: ${reasons}` : "") +
        `<br>可以放宽策略条件或更换基准日重试。</div>`
    );
    return;
  }

  el.resultsBody.innerHTML = result.hits
    .map((hit) => hitRow(hit, hit.d2.trade_date))
    .join("");
}

/** 结果表只有 5 列: 自选 / 代码 / 简称 / 板块 / 选出日。 */
function hitRow(hit, screenDate) {
  return (
    `<tr class="hit-row" data-code="${escapeHtml(hit.code)}" ` +
    `data-name="${escapeHtml(hit.name)}" data-date="${escapeHtml(screenDate || "")}">` +
    `<td class="cell-star">${starButton(hit.code, hit.name)}</td>` +
    `<td class="cell-code">${escapeHtml(hit.code)}</td>` +
    `<td>${escapeHtml(hit.name)}</td>` +
    `<td class="board-cell">${escapeHtml(hit.board_label)}</td>` +
    `<td class="date-cell">${escapeHtml(screenDate || "—")}</td>` +
    `</tr>`
  );
}

/* ------------------------------------------------------------- 整月扫描 */

/** 一键扫描: 用基准日 T0 遍历一个月, 汇总所有命中的股票。 */
async function runMonthScan() {
  if (state.busy) return;
  const month = el.scanMonth.value;
  if (!month) {
    showAlert("warn", "请先选择要扫描的月份。");
    return;
  }
  const invalid = firstConditionError();
  if (invalid) {
    showAlert("warn", `${escapeHtml(invalid)} 请修正选股条件后重试。`);
    return;
  }
  setBusy(true);
  const conditions = state.conditions.map((item) => ({kind: item.kind, params: {...item.params}}));
  el.scanButton.textContent = "扫描中…";
  clearAlerts();
  try {
    const payload = await api("/api/screen/scan", {
      method: "POST",
      body: JSON.stringify({ month, conditions }),
    });
    state.scan = payload;
    state.result = null;
    state.appliedConditions = conditions;
    renderScanResult(payload);
    el.exportButton.disabled = false;
  } catch (error) {
    showAlert("error", `整月扫描失败: ${escapeHtml(error.message)}`);
  } finally {
    setBusy(false);
    el.scanButton.textContent = "扫描整月";
  }
}

function renderScanResult(payload) {
  el.resultsPanel.hidden = false;
  el.resultsTitle.textContent = `符合条件的股票 (${payload.month})`;
  el.resultsCount.textContent = `${payload.hit_count} 只`;
  el.warnings.innerHTML = "";
  el.scanSummary.hidden = false;
  el.scanSummary.textContent =
    `扫描 ${payload.scanned_days} 个交易日` +
    (payload.skipped_days ? `, 跳过 ${payload.skipped_days} 天 (数据未下载完)` : "") +
    ` · 命中 ${payload.hit_count} 只`;

  if (!payload.hit_count) {
    el.resultsBody.innerHTML = "";
    el.warnings.insertAdjacentHTML(
      "beforeend",
      `<div class="empty-state"><strong>本月没有符合条件的股票</strong>` +
        `可以放宽策略条件后重新扫描。</div>`
    );
    return;
  }
  el.resultsBody.innerHTML = payload.hits
    .map((hit) => hitRow(hit, hit.screen_date))
    .join("");
}

/* -------------------------------------------------------------- 自选与K线 */

function starButton(code, name) {
  const watched = state.watched.has(code);
  return (
    `<button type="button" class="star-btn${watched ? " is-on" : ""}" ` +
    `data-code="${escapeHtml(code)}" data-name="${escapeHtml(name)}" ` +
    `title="${watched ? "移出自选股" : "加入自选股"}" ` +
    `aria-label="${watched ? "移出自选股" : "加入自选股"}">${watched ? "★" : "☆"}</button>`
  );
}

/** 刷新表头里所有 ☆ 的状态 (收藏状态变化后调用)。 */
function refreshStarButtons() {
  el.resultsBody.querySelectorAll(".star-btn").forEach((button) => {
    const watched = state.watched.has(button.dataset.code);
    button.classList.toggle("is-on", watched);
    button.textContent = watched ? "★" : "☆";
    button.title = watched ? "移出自选股" : "加入自选股";
    button.setAttribute("aria-label", button.title);
  });
}

async function onResultsClick(event) {
  const star = event.target.closest(".star-btn");
  if (star) {
    event.stopPropagation();
    await toggleWatch(star.dataset.code, star.dataset.name, star.closest("tr").dataset.date || state.selectedDate);
    return;
  }
  const row = event.target.closest("tr[data-code]");
  if (row) {
    const screenDate = row.dataset.date || state.selectedDate;
    const rows = state.scan
      ? (state.scan.hits || []).map((hit) => ({
          code: hit.code,
          name: hit.name,
          date: hit.screen_date,
        }))
      : (state.result ? state.result.hits : []).map((hit) => ({
          code: hit.code,
          name: hit.name,
          date: row.dataset.date || hit.d2.trade_date,
        }));
    openStockChart(row.dataset.code, {
      name: row.dataset.name,
      sourceDate: screenDate,
      highlightScreenDate: true,
      // K 线始终画到本地最新日期 (不因为它是哪天选出来的就截断)
      // ← / → 在当前结果列表里切换股票
      list: rows,
      // 弹窗里收藏/取消后, 同步表格里的 ☆ 状态
      onWatchChange: (code, watched) => {
        if (watched) state.watched.add(code);
        else state.watched.delete(code);
        refreshStarButtons();
      },
    });
  }
}

async function toggleWatch(code, name, sourceDate = state.selectedDate) {
  const watched = state.watched.has(code);
  try {
    if (watched) {
      await api(`/api/watchlist/${encodeURIComponent(code)}`, { method: "DELETE" });
      state.watched.delete(code);
    } else {
      const added = await addWatchWithCategories({code, name, source_date: sourceDate});
      if (!added) return;
      state.watched.add(code);
    }
    refreshStarButtons();
    showAlert(
      "ok",
      watched
        ? `${escapeHtml(name)} 已移出自选股。`
        : `${escapeHtml(name)} 已加入 <a href="/watchlist">自选股</a>。`
    );
  } catch (error) {
    showAlert("error", `收藏操作失败: ${escapeHtml(error.message)}`);
  }
}

/** 拉取自选股列表 (用于标记表格里的 ☆)。 */
async function loadWatchedCodes() {
  try {
    const payload = await api("/api/watchlist");
    state.watched = new Set(payload.codes || []);
  } catch (error) {
    state.watched = new Set();
  }
  refreshStarButtons();
}

/* ---------------------------------------------------------- 后台数据任务 */

/**
 * 数据页面可能正在下载行情, 这里只提示进度并给个入口;
 * 完成后自动刷新日历, 让用户能直接筛选新交易日。
 */
function showSyncBanner(progress) {
  el.syncBanner.hidden = false;
  const parts = [
    progress.mode_label,
    phaseLabel(progress.phase),
    `${progress.percent}%`,
    progress.total_stocks > 0
      ? `股票 ${progress.done_stocks}/${progress.total_stocks}`
      : "",
    progress.total_days > 0
      ? `交易日 ${progress.done_days}/${progress.total_days}`
      : "",
  ].filter(Boolean);
  el.syncBannerText.textContent = `本地数据正在更新 · ${parts.join(" · ")}`;
}

function hideSyncBanner() {
  el.syncBanner.hidden = true;
}

function stopSyncWatch() {
  if (state.stopSyncWatch) {
    state.stopSyncWatch();
    state.stopSyncWatch = null;
  }
}

/** 就地为某个交易日补数据 (筛选发现缺数据时使用), 成功后自动重新筛选。 */
async function startDateSync(dates, retryScreenDate) {
  clearAlerts();
  stopSyncWatch(); // 先停掉可能还在跑的旧轮询
  try {
    const progress = await startSyncTask("targeted", dates);
    showSyncBanner(progress);
    state.stopSyncWatch = watchSync(showSyncBanner, async (final) => {
      state.stopSyncWatch = null;
      hideSyncBanner();
      await loadCoverage();
      await refreshCalendar();
      if (final && final.status === "succeeded") {
        showAlert(final.error ? "warn" : "ok", `数据更新完成: ${escapeHtml(final.message || "")}`);
        if (retryScreenDate) runScreen(retryScreenDate);
      } else if (final && final.status === "failed") {
        showAlert(
          "error",
          `数据更新失败: ${escapeHtml(final.error || "未知错误")}, 详情见 logs 目录。`
        );
      }
    });
  } catch (error) {
    showAlert("error", `启动同步任务失败: ${escapeHtml(error.message)}`);
  }
}

/** 进入页面时, 若后台(数据页面)正在同步, 先提示进度。 */
async function resumeBackgroundSync() {
  const progress = await fetchSyncStatus();
  if (!progress || !progress.is_running) return;
  showSyncBanner(progress);
  state.stopSyncWatch = watchSync(showSyncBanner, async (final) => {
    state.stopSyncWatch = null;
    hideSyncBanner();
    await loadCoverage();
    await refreshCalendar();
    if (final && final.status === "succeeded") {
      showAlert(final.error ? "warn" : "ok", escapeHtml(final.message || "本地数据已更新完成, 可以重新筛选。"));
    }
  }, 3000);
}

/* ---------------------------------------------------------------- 初始化 */

function bindEvents() {
  el.screenButton.addEventListener("click", () => {
    const day = state.selectedDate;
    if (!day) {
      showAlert("warn", "请先在日历上选择一个交易日。");
      return;
    }
    runScreen(day);
  });

  el.exportButton.addEventListener("click", () => {
    if (!state.result && !state.scan) return;
    // 导出用同一套条件 (POST), 保证 CSV 与页面结果一致。
    downloadExport(state.result?.window.d2);
  });

  el.strategySearch.addEventListener("input", renderStrategyLibrary);
  el.strategyList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-strategy-id]");
    if (button) selectStrategy(Number(button.dataset.strategyId));
  });
  for (const type of ["input", "change", "click"]) {
    el.conditionList.addEventListener(type, (event) => {
      if (updateConditionParams(event, state.conditions)) updateCriteriaUI();
    });
  }
  el.criteriaReset.addEventListener("click", resetToStrategy);
  el.criteriaSave.addEventListener("click", saveCurrentParameters);
  el.scanButton.addEventListener("click", runMonthScan);
  el.scanMonth.addEventListener("change", () => {
    // 手动改月份时保留, 不被日历选择覆盖
    state.scanMonthPinned = true;
  });

  el.calendarPrev.addEventListener("click", () => changeMonth(-1));
  el.calendarNext.addEventListener("click", () => changeMonth(1));
  el.calendarYear.addEventListener("change", jumpToSelectedMonth);
  el.calendarMonth.addEventListener("change", jumpToSelectedMonth);
  el.calendarGrid.addEventListener("click", (event) => {
    const cell = event.target.closest("button[data-date]");
    if (cell) selectDate(cell.dataset.date);
  });

  el.resultsBody.addEventListener("click", onResultsClick);
}

async function initScreen() {
  const missing = bindElements(ELEMENT_IDS, REQUIRED_IDS);
  if (missing.length) {
    reportFatal(
      `页面与脚本版本不一致 (缺少 ${missing.join(", ")})。` +
        "请强刷新页面 (Ctrl+F5, 或 Ctrl+Shift+R) 重新加载。"
    );
    return;
  }

  bindEvents();
  await loadConditionCatalog();
  await loadStrategies();
  await loadCoverage();
  await ensureCalendar();
  await refreshCalendar();
  if (state.selectedDate) el.scanMonth.value = state.selectedDate.slice(0, 7);
  await loadWatchedCodes();
  await resumeBackgroundSync();
}

boot(initScreen);
