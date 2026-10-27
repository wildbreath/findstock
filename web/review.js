/* 按日收录行情, 人工描述和标记始终保留。 */
let reviewDraftKey = "findstock.review-sheet.draft.v1";
try {
  const tab = sessionStorage.getItem("findstock.review-tab") || crypto.randomUUID();
  sessionStorage.setItem("findstock.review-tab", tab);
  reviewDraftKey += `.${tab}`;
} catch {}
const reviewKinds = {
  theme: {kind: "theme", background: "#dbeafe", color: "#1f2937", bold: true},
  stock: {kind: "stock", background: "#2563a6", color: "#ffffff", bold: true},
};
const reviewThemeColors = new Map();

function reviewThemeColor(theme) {
  if (!theme) return "";
  if (!reviewThemeColors.has(theme)) {
    reviewThemeColors.set(theme, `hsl(${(210 + reviewThemeColors.size * 137.508) % 360} 65% 88%)`);
  }
  return reviewThemeColors.get(theme);
}
let reviewSheet, reviewDays = [], reviewAnchor = {r: 0, c: 0}, reviewEnd = {r: 0, c: 0};
let reviewDirty = false, reviewSaving = false, reviewConflict = false, reviewLoaded = false;
let reviewTimer, reviewSequence = 0, reviewEditing = null;
let reviewEditor = null, reviewDrag = null;
let reviewCollecting = false;
let reviewThemeDrag = "";
let reviewStockRowId = "", reviewStockSearch = 0;
const reviewCheckedRows = new Set(), reviewAddStocks = new Map();
let reviewAddStockResults = [], reviewAddStockSearch = 0;
let reviewAddSource = "watchlist", reviewAddSourceItems = [];
const reviewUndo = [], reviewRedo = [];
const reviewZoomKey = "findstock.review-sheet.zoom.v1";

function reviewZoom() {
  return document.body.classList.contains("review-overview-mode") ? 1 : Number($("review-zoom").value);
}

function reviewApplyZoom(value, save = true) {
  const select = $("review-zoom"), scroll = $("review-scroll");
  if (![...select.options].some(option => option.value === String(value))) value = "1";
  const latest = scroll.scrollWidth - scroll.clientWidth - scroll.scrollLeft <= 1;
  const previous = reviewZoom(), offset = scroll.scrollLeft;
  select.value = String(value);
  document.body.style.setProperty("--review-zoom", value);
  if (save) {
    try { localStorage.setItem(reviewZoomKey, value); }
    catch { reviewNotice("浏览器无法记住缩放比例，本次调整仍然有效。"); }
  }
  scroll.scrollLeft = latest ? scroll.scrollWidth : offset * reviewZoom() / previous;
  if (reviewLoaded) { reviewFitOverview(); reviewRefreshHeader(); reviewScrollDock(); }
}

function reviewToday() {
  return new Intl.DateTimeFormat("sv-SE", {timeZone: "Asia/Shanghai"}).format(new Date());
}

function reviewStatus(message, state = "") {
  $("review-status").textContent = message;
  $("review-status").dataset.state = state;
  $("review-view-status").textContent = message;
  $("review-view-status").dataset.state = state;
  $("review-theme-save-state").textContent = message;
  $("review-theme-save-state").dataset.state = state;
}

function reviewNotice(message = "") {
  $("review-notice").textContent = message;
  $("review-notice").hidden = !message;
}

function reviewBody() {
  return JSON.stringify({dates: reviewSheet.dates, hidden_dates: reviewSheet.hidden_dates, rows: reviewSheet.rows,
    collected_dates: reviewSheet.collected_dates || []});
}

function reviewCheckpoint() {
  const snapshot = reviewBody();
  if (reviewUndo.at(-1) !== snapshot) reviewUndo.push(snapshot);
  if (reviewUndo.length > 30) reviewUndo.shift();
  reviewRedo.length = 0;
  reviewEditing = null;
  reviewHistoryButtons();
}

function reviewHistoryButtons() {
  $("review-undo").disabled = !reviewUndo.length;
  $("review-redo").disabled = !reviewRedo.length;
  $("review-theme-undo").disabled = !reviewUndo.length;
  $("review-theme-redo").disabled = !reviewRedo.length;
}

function reviewDraft() {
  try { localStorage.setItem(reviewDraftKey, JSON.stringify(reviewSheet)); }
  catch { reviewNotice("浏览器无法保留临时草稿，请确认保存成功后再关闭页面。"); }
}

function reviewChanged() {
  reviewDirty = true;
  reviewSequence++;
  reviewDraft();
  clearTimeout(reviewTimer);
  if (!reviewConflict) {
    reviewStatus("未保存…");
    reviewTimer = setTimeout(reviewSave, 700);
  }
}

async function reviewSave(commitEditor = false) {
  if (commitEditor && !reviewFinishEdit()) return;
  clearTimeout(reviewTimer);
  if (!reviewLoaded || reviewSaving || !reviewDirty || reviewConflict) return;
  reviewSaving = true;
  const sequence = reviewSequence;
  reviewStatus("正在保存…");
  try {
    const saved = await api("/api/review-sheet", {method: "PUT", body: JSON.stringify(reviewSheet)});
    reviewSheet.revision = saved.revision;
    if (sequence === reviewSequence) {
      reviewDirty = false;
      try { localStorage.removeItem(reviewDraftKey); } catch {}
      reviewStatus("已自动保存", "saved");
      reviewNotice();
    } else {
      reviewDraft();
      reviewTimer = setTimeout(reviewSave, 100);
    }
  } catch (error) {
    reviewConflict = error.code === "review_conflict";
    reviewStatus(reviewConflict ? "版本冲突 · 编辑已保留" : "保存失败 · 请重试", "error");
    reviewNotice(`${reviewSaveError(error)} 当前内容仍在本页，可先导出备份。`);
  } finally { reviewSaving = false; }
}

function reviewSaveError(error) {
  const errors = error.details?.errors || [];
  if (error.status !== 422 || !errors.length) return error.message;
  if (errors.some(item => ["theme", "stock_code"].includes(item.loc?.at(-1)) &&
    /Extra inputs are not permitted/.test(item.msg))) {
    return "服务仍在运行旧版本，无法保存人工题材或股票关联。请关闭旧服务并重新启动，然后在本页再次点击保存。";
  }
  const item = errors[0], location = item.loc || [], index = location.indexOf("rows");
  const row = index >= 0 && Number.isInteger(location[index + 1]) ? `第 ${location[index + 1] + 1} 行` : "复盘表";
  const date = location.indexOf("cells"), day = date >= 0 ? ` ${location[date + 1]}` : "";
  return `${row}${day}未通过保存校验：${item.msg || error.message}`;
}

function reviewNewRow() { return {id: crypto.randomUUID(), cells: {}}; }

function reviewBounds() {
  return {r1: Math.min(reviewAnchor.r, reviewEnd.r), r2: Math.max(reviewAnchor.r, reviewEnd.r),
    c1: Math.min(reviewAnchor.c, reviewEnd.c), c2: Math.max(reviewAnchor.c, reviewEnd.c)};
}

function reviewTargetIndices() {
  if (reviewCheckedRows.size) return reviewSheet.rows.flatMap((row, r) => reviewCheckedRows.has(row.id) ? [r] : []);
  const {r1, r2} = reviewBounds();
  return reviewSheet.rows.flatMap((_, r) => r >= r1 && r <= r2 ? [r] : []);
}

function reviewTargetRows() { return reviewTargetIndices().map(r => reviewSheet.rows[r]); }

function reviewCurrentTheme() {
  const row = reviewSheet.rows[reviewAnchor.r];
  return row && (reviewRowInfo(row).theme || reviewThemeGroups().find(group => group.indices.includes(reviewAnchor.r))?.theme) || "未分类";
}

function reviewCheckRows(indices, checked) {
  if (!reviewFinishEdit()) return;
  indices.forEach(r => {
    const row = reviewSheet.rows[r];
    if (row) checked ? reviewCheckedRows.add(row.id) : reviewCheckedRows.delete(row.id);
  });
  if (checked && indices.length) reviewAnchor = reviewEnd = {r: indices[0], c: reviewAnchor.c};
  reviewSelection();
}

function reviewEachSelected(callback) {
  const bounds = reviewBounds(), c1 = reviewCheckedRows.size ? 0 : bounds.c1, c2 = reviewCheckedRows.size ? reviewDays.length - 1 : bounds.c2;
  for (const r of reviewTargetIndices()) for (let c = c1; c <= c2; c++) {
    if (reviewSheet.rows[r] && reviewDays[c]) callback(r, c);
  }
}

function reviewCell(r, c) { return reviewSheet.rows[r]?.cells[reviewDays[c]] || {}; }

function reviewSetCell(r, c, value) {
  const row = reviewSheet.rows[r], old = reviewCell(r, c);
  if (row.stock_code && old.kind === "stock" && value.text !== old.text) {
    delete row.stock_code; delete row.tracking;
  }
  if (value.text || value.background || value.color || value.bold || value.kind || value.highlight || value.auto_text) reviewSheet.rows[r].cells[reviewDays[c]] = value;
  else delete reviewSheet.rows[r].cells[reviewDays[c]];
  if (value.kind === "theme" && value.text?.trim() && !reviewIsMarketCell(value) &&
    (old.kind !== "theme" || old.text !== value.text)) reviewAssignTheme(row, value.text.trim());
}

function reviewIsMarketCell(value) {
  return /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)\s*%?$|^\d+板/.test((value.auto_text || value.text || "").trim());
}

function reviewStyle(value, leader = false, theme = "") {
  const color = key => /^#[0-9a-f]{6}$/i.test(value[key] || "") ? value[key] : "";
  const isTheme = !reviewIsMarketCell(value) && (value.kind === "theme" || theme && value.text === theme &&
    ["#7e22a8", "#dbeafe"].includes(color("background").toLowerCase()));
  const fill = color("background");
  const background = leader ? "#7e22a8" : isTheme && value.text ? reviewThemeColor(value.text) :
    ({"#fee2e2": "#efb7b2", "#f6dedb": "#efb7b2", "#dcfce7": "#b8d8c4", "#dcebe3": "#b8d8c4"}[fill.toLowerCase()] || fill);
  const highlighted = value.highlight || value.color?.toLowerCase() === "#fff176";
  const foreground = highlighted ? "#fff176" : leader ? "#ffffff" : isTheme ? "#1f2937" : color("color") ||
    (["#dc2626", "#237b3b"].includes(background.toLowerCase()) ? "#ffffff" : "");
  return `background-color:${background};color:${foreground};font-weight:${value.bold ? 700 : 400}`;
}

function reviewRowInfo(row) {
  const cells = reviewSheet.dates.map(day => row.cells[day]).filter(cell => cell?.text && !reviewIsMarketCell(cell));
  const stock = cells.find(cell => cell.kind === "stock") || cells.find(cell => cell.background?.toLowerCase() === "#2563a6");
  const theme = cells.find(cell => cell.kind === "theme");
  const legacyTheme = cells.find(cell => ["#7e22a8", "#dbeafe"].includes(cell.background?.toLowerCase()));
  return {stock: stock?.text || row.stock_code || row.tracking?.code || "",
    theme: (row.theme?.trim() || theme?.text || row.tracking?.theme || legacyTheme?.text || "").trim()};
}

function reviewRowOccupied(row) {
  return row.tracking || row.theme || row.stock_code || row.leader || Object.values(row.cells).some(cell =>
    cell.text || cell.background || cell.color || cell.bold || cell.kind || cell.highlight || cell.auto_text);
}

function reviewThemeGroups() {
  const groups = new Map();
  let previous = "";
  reviewSheet.rows.forEach((row, r) => {
    if (!reviewRowOccupied(row)) { previous = ""; return; }
    const theme = reviewRowInfo(row).theme || previous;
    if (!theme) return;
    if (!groups.has(theme)) groups.set(theme, {theme, indices: []});
    groups.get(theme).indices.push(r);
    previous = theme;
  });
  return [...groups.values()];
}

function reviewFixRowThemes() {
  const themes = new Map();
  reviewThemeGroups().forEach(group => group.indices.forEach(r => themes.set(reviewSheet.rows[r], group.theme)));
  reviewSheet.rows.forEach(row => {
    if (reviewRowOccupied(row) && !reviewRowInfo(row).theme) row.theme = themes.get(row) || "未分类";
  });
}

function reviewArrangeRows(order = [], removeEmpty = false) {
  reviewFixRowThemes();
  const anchor = reviewSheet.rows[reviewAnchor.r]?.id, end = reviewSheet.rows[reviewEnd.r]?.id;
  const groups = reviewThemeGroups(), grouped = new Set(groups.flatMap(group => group.indices));
  const names = [...new Set([...order, ...groups.map(group => group.theme)])];
  const rows = names.flatMap(theme => (groups.find(group => group.theme === theme)?.indices || []).map(r => reviewSheet.rows[r]));
  reviewSheet.rows.forEach((row, r) => {
    if (!grouped.has(r) && (reviewRowOccupied(row) || !removeEmpty)) rows.push(row);
  });
  reviewSheet.rows = rows;
  const position = id => rows.findIndex(row => row.id === id);
  if (position(anchor) >= 0) reviewAnchor.r = position(anchor);
  if (position(end) >= 0) reviewEnd.r = position(end);
}

function reviewAssignTheme(row, theme) {
  const old = reviewRowInfo(row).theme;
  row.theme = theme;
  if (row.tracking) row.tracking.theme = theme;
  for (const cell of Object.values(row.cells)) {
    if (!reviewIsMarketCell(cell) && (cell.kind === "theme" || cell.text === old &&
      ["#7e22a8", "#dbeafe"].includes(cell.background?.toLowerCase()))) {
      cell.text = theme;
      if (cell.auto_text === old) cell.auto_text = theme;
    }
  }
}

function reviewEditTheme() {
  if (!reviewFinishEdit() || !reviewSheet.rows.length || reviewCollecting) return;
  const rows = reviewTargetRows();
  $("review-theme-edit-note").textContent = `修改所选 ${rows.length} 条记录；同题材自动归组，后续新记录沿用人工分类。`;
  const themes = new Set(rows.map(row => reviewRowInfo(row).theme));
  $("review-theme-value").value = themes.size === 1 ? [...themes][0] : "";
  $("review-theme-options").innerHTML = reviewThemeGroups().map(group => `<option value="${escapeHtml(group.theme)}"></option>`).join("");
  $("review-theme-edit-dialog").showModal();
  $("review-theme-value").focus();
}

function reviewApplyTheme(theme) {
  theme = theme.trim();
  if (!theme || theme.length > 2000) return false;
  const order = reviewThemeGroups().map(group => group.theme), rows = reviewTargetRows();
  reviewCheckpoint();
  reviewFixRowThemes();
  rows.forEach(row => reviewAssignTheme(row, theme));
  reviewArrangeRows(order, true);
  reviewRender(true); reviewChanged();
  return true;
}

async function reviewOpenChart(r) {
  const id = reviewSheet.rows[r]?.id;
  if (!reviewFinishEdit() || reviewCollecting) return;
  const row = reviewSheet.rows.find(row => row.id === id);
  if (!row) return;
  const {stock} = reviewRowInfo(row), code = row.tracking?.code || row.stock_code;
  if (code) {
    $("review-grid").querySelector(`[data-chart-row="${reviewSheet.rows.indexOf(row)}"]`)?.focus({preventScroll: true});
    await openStockChart(code, {name: stock, sourceDate: row.tracking?.entry_date});
    return;
  }
  reviewStockRowId = row.id;
  $("review-stock-query").value = stock.slice(0, 80);
  $("review-stock-results").textContent = "搜索并选择股票，关联后可直接查看K线。";
  $("review-stock-dialog").showModal();
  $("review-stock-query").focus();
  if (stock) reviewFindStock();
}

async function reviewFindStock() {
  const query = $("review-stock-query").value.trim(), token = ++reviewStockSearch;
  if (!query) return;
  $("review-stock-results").textContent = "正在搜索…";
  try {
    const items = await api(`/api/stocks/search?q=${encodeURIComponent(query)}&limit=20`);
    if (token !== reviewStockSearch || !$("review-stock-dialog").open) return;
    $("review-stock-results").innerHTML = items.map(item =>
      `<button class="btn" type="button" data-stock-code="${escapeHtml(item.code)}" data-stock-name="${escapeHtml(item.name)}">${escapeHtml(item.name)} · ${escapeHtml(item.code)}</button>`).join("") || "没有找到股票，请尝试代码或其他名称。";
  } catch (error) {
    if (token === reviewStockSearch) $("review-stock-results").textContent = error.message;
  }
}

function reviewFillThemeOptions(id) {
  $(id).innerHTML = reviewThemeGroups().map(group => `<option value="${escapeHtml(group.theme)}"></option>`).join("");
}

function reviewInsertRows(rows, position, day, dates = []) {
  if (!rows.length || reviewSheet.rows.length + rows.length > 1000) {
    reviewNotice("最多支持 1000 行，本次未添加；请减少数量或先整理已有记录。"); return false;
  }
  if (!["after", "before", "theme", "end"].includes(position) || !reviewDays.includes(day)) {
    reviewNotice("请先显示需要填写的日期，再选择有效的插入位置。"); return false;
  }
  const allRows = [...reviewSheet.rows, ...rows];
  if (allRows.reduce((count, row) => count + Object.keys(row.cells).length, 0) > 50000 ||
    allRows.reduce((count, row) => count + Object.values(row.cells).reduce((size, cell) => size + (cell.text || "").length, 0), 0) > 2000000 ||
    new Set([...reviewSheet.dates, ...dates]).size > 1500) {
    reviewNotice("加入后超出复盘表容量，请减少股票数量或先整理记录。本次未添加。"); return false;
  }
  const selected = reviewTargetIndices(), group = reviewThemeGroups().find(group => group.theme === rows[0].theme);
  const index = position === "end" ? reviewSheet.rows.length : position === "theme" ? (group?.indices.at(-1) ?? reviewSheet.rows.length - 1) + 1 :
    position === "before" ? selected[0] ?? 0 : (selected.at(-1) ?? reviewSheet.rows.length - 1) + 1;
  const order = reviewThemeGroups().map(group => group.theme);
  reviewCheckpoint(); reviewFixRowThemes();
  if (dates.length) {
    reviewSheet.dates = [...new Set([...reviewSheet.dates, ...dates])].sort();
    $("review-start").value = reviewSheet.dates[0]; $("review-end").value = reviewSheet.dates.at(-1);
    reviewDays = reviewSheet.dates.filter(value => !reviewSheet.hidden_dates.includes(value));
  }
  reviewSheet.rows.splice(index, 0, ...rows);
  reviewArrangeRows(order);
  reviewCheckedRows.clear();
  reviewAnchor = {r: reviewSheet.rows.indexOf(rows[0]), c: reviewDays.indexOf(day)};
  reviewEnd = {r: reviewSheet.rows.indexOf(rows.at(-1)), c: reviewAnchor.c};
  reviewRender(true); reviewChanged(); reviewFocus();
  return true;
}

function reviewDuplicateRows() {
  if (!reviewFinishEdit() || !reviewLoaded || reviewCollecting || !reviewSheet.rows.length) return;
  const groups = reviewThemeGroups();
  const copies = reviewTargetRows().map(row => {
    const copy = JSON.parse(JSON.stringify(row));
    copy.id = reviewNewRow().id;
    copy.theme = reviewRowInfo(row).theme || groups.find(group => group.indices.includes(reviewSheet.rows.indexOf(row)))?.theme || "未分类";
    if (copy.tracking) copy.stock_code = copy.tracking.code;
    return copy;
  });
  reviewInsertRows(copies, "after", reviewDays[reviewAnchor.c]);
}

function reviewCreateRows(count, position, theme, day = reviewDays[reviewAnchor.c]) {
  if (!reviewFinishEdit() || !reviewLoaded || reviewCollecting) return false;
  theme = theme.trim() || "未分类";
  if (!Number.isInteger(count) || count < 1 || count > 1000 || theme.length > 2000 || reviewSheet.rows.length + count > 1000) {
    reviewNotice("请输入有效的新增行数和题材；表格最多 1000 行，题材最多 2000 字。本次未添加。"); return false;
  }
  const rows = Array.from({length: count}, () => ({...reviewNewRow(), theme,
    cells: {[day]: {text: "", ...reviewKinds.stock}}}));
  return reviewInsertRows(rows, position, day);
}

function reviewOpenNewRows() {
  if (!reviewFinishEdit() || !reviewLoaded || reviewCollecting) return;
  $("review-new-row-count").value = "1";
  $("review-new-row-count").max = Math.max(1, 1000 - reviewSheet.rows.length);
  $("review-new-row-position").value = reviewSheet.rows.length ? "after" : "end";
  $("review-new-row-theme").value = reviewCurrentTheme();
  $("review-new-rows-status").textContent = "";
  reviewFillThemeOptions("review-new-row-themes");
  $("review-new-rows-dialog").showModal();
  $("review-new-row-count").focus();
}

function reviewOpenAddStocks() {
  if (!reviewFinishEdit() || !reviewLoaded || reviewCollecting) return;
  if (!reviewDays.length) { reviewNotice("请先显示需要填写的日期。"); return; }
  reviewAddStocks.clear(); reviewAddStockResults = []; reviewAddStockSearch++;
  $("review-add-stock-query").value = "";
  $("review-add-stock-theme").value = reviewCurrentTheme();
  $("review-add-stock-date").innerHTML = reviewDays.map(day => `<option value="${day}">${day}</option>`).join("");
  $("review-add-stock-date").value = reviewDays[reviewAnchor.c] || reviewDays.at(-1);
  reviewFillThemeOptions("review-add-stock-themes");
  reviewPaintAddStocks();
  $("review-add-stocks-dialog").showModal();
  $("review-add-stock-query").focus();
  reviewLoadAddSource("watchlist");
}

function reviewFilterAddStocks() {
  const query = $("review-add-stock-query").value.trim().toLowerCase(), category = $("review-add-category").value;
  reviewAddStockResults = reviewAddSourceItems.filter(item => {
    const categories = item.categories || [];
    if (reviewAddSource === "watchlist" && category !== "all" &&
      (category === "uncategorized" ? categories.length : !categories.some(value => String(value.id) === category))) return false;
    return !query || `${item.name} ${item.code}`.toLowerCase().includes(query);
  });
  reviewPaintAddStocks();
}

async function reviewLoadAddSource(source, day = "") {
  const token = ++reviewAddStockSearch;
  reviewAddSource = source; reviewAddSourceItems = []; reviewAddStockResults = [];
  $("review-add-stock-query").value = "";
  $("review-add-category-field").hidden = source !== "watchlist";
  $("review-add-ladder-field").hidden = source !== "ladder";
  $("review-add-search-submit").hidden = source !== "search";
  $("review-add-source-retry").hidden = true;
  $("review-add-visible").disabled = true;
  document.querySelectorAll("[data-review-source]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.reviewSource === source)));
  $("review-add-source-status").textContent = source === "search" ? "输入名称或代码搜索全部股票。" : "正在读取股票列表…";
  reviewPaintAddStocks();
  if (source === "search") return;
  try {
    const payload = await api(source === "watchlist" ? "/api/watchlist" : `/api/stock-ladder${day ? `?date=${encodeURIComponent(day)}` : ""}`);
    if (token !== reviewAddStockSearch || !$("review-add-stocks-dialog").open) return;
    reviewAddSourceItems = (payload.items || []).filter(item => /^(sh|sz)\.\d{6}$/.test(item.code) && typeof item.name === "string" && item.name.length <= 2000);
    if (source === "watchlist") {
      $("review-add-category").innerHTML = '<option value="all">全部自选</option><option value="uncategorized">未分类</option>' +
        (payload.categories || []).map(value => `<option value="${value.id}">${escapeHtml(value.name)} (${value.count})</option>`).join("");
    } else {
      reviewAddSourceItems.sort((a, b) => b.consecutive - a.consecutive || a.code.localeCompare(b.code));
      $("review-add-ladder-date").innerHTML = (payload.trading_days || []).slice().reverse().map(value => `<option value="${value}">${value}</option>`).join("");
      $("review-add-ladder-date").value = payload.trade_date;
    }
    $("review-add-source-status").textContent = `${source === "watchlist" ? "自选股" : payload.trade_date + " 天梯"} · ${reviewAddSourceItems.length} 只，可按名称或代码筛选。`;
    reviewFilterAddStocks();
  } catch (error) {
    if (token !== reviewAddStockSearch || !$("review-add-stocks-dialog").open) return;
    $("review-add-source-status").textContent = `读取失败：${error.message}`;
    $("review-add-source-retry").hidden = false;
  }
}

function reviewPaintAddStocks(results = true) {
  if (results) $("review-add-stock-results").innerHTML = reviewAddStockResults.map(item =>
    `<label><input type="checkbox" data-add-stock-code="${item.code}" ${reviewAddStocks.has(item.code) ? "checked" : ""}><span>${escapeHtml(item.name)}<small>${item.code}${reviewAddSource === "ladder" ? ` · ${item.consecutive}板 · ${escapeHtml(item.primary_theme || "题材未获取")}` : ""}</small></span></label>`).join("") || "当前没有股票，可切换来源或搜索。";
  $("review-add-visible").disabled = !reviewAddStockResults.length;
  $("review-add-stock-results").querySelectorAll("[data-add-stock-code]").forEach(node => { node.checked = reviewAddStocks.has(node.dataset.addStockCode); });
  $("review-add-stock-selected").innerHTML = [...reviewAddStocks.values()].map(item =>
    `<button class="btn" type="button" data-remove-add-stock="${item.code}" aria-label="移除${escapeHtml(item.name)}">${escapeHtml(item.name)} ×</button>`).join("") || "尚未选择个股";
  $("review-add-stock-status").textContent = `已选择 ${reviewAddStocks.size} 只，加入后可一次撤销。`;
  $("review-add-stock-submit").disabled = !reviewAddStocks.size;
}

async function reviewSearchAddStocks() {
  if (reviewAddSource !== "search") { reviewFilterAddStocks(); return; }
  const query = $("review-add-stock-query").value.trim(), token = ++reviewAddStockSearch;
  if (!query || query.length > 80) return;
  reviewAddStockResults = []; reviewPaintAddStocks();
  $("review-add-stock-status").textContent = "正在搜索…";
  try {
    const items = await api(`/api/stocks/search?q=${encodeURIComponent(query)}&limit=50`);
    if (token !== reviewAddStockSearch || !$("review-add-stocks-dialog").open) return;
    reviewAddStockResults = items.filter(item => /^(sh|sz)\.\d{6}$/.test(item.code) && typeof item.name === "string" && item.name.length <= 2000);
    reviewPaintAddStocks();
    if (!reviewAddStockResults.length) $("review-add-stock-results").textContent = "没有找到股票，请尝试代码或其他名称。";
  } catch (error) {
    if (token === reviewAddStockSearch && $("review-add-stocks-dialog").open) $("review-add-stock-status").textContent = error.message;
  }
}

async function reviewAddSelectedStocks(theme, day) {
  theme = theme.trim() || "未分类";
  if (!reviewFinishEdit() || !reviewLoaded || reviewCollecting || !reviewAddStocks.size || theme.length > 2000) return false;
  const themes = new Map();
  reviewThemeGroups().forEach(group => group.indices.forEach(r => themes.set(r, group.theme)));
  const items = [...reviewAddStocks.values()].filter(item => !reviewSheet.rows.some((row, r) =>
    (themes.get(r) || "未分类") === theme && (row.tracking?.code || row.stock_code) === item.code &&
    (row.tracking ? row.tracking.entry_date === day : row.cells[day]?.kind === "stock" || row.cells[day]?.background?.toLowerCase() === "#2563a6")));
  const skipped = reviewAddStocks.size - items.length;
  if (!items.length) { $("review-add-stock-status").textContent = "所选股票在该题材、该日期已有记录，可更换题材或日期。"; return false; }
  if (reviewSheet.rows.length + items.length > 1000) { $("review-add-stock-status").textContent = "最多支持 1000 行，请减少所选股票或先整理记录。"; return false; }
  reviewCollecting = true;
  $("review-controls").disabled = true; $("review-grid").inert = true;
  $("review-add-stocks-dialog").querySelector(".review-dialog-body").inert = true;
  $("review-add-stock-status").textContent = "正在补齐本地行情…";
  $("review-add-stocks-form").setAttribute("aria-busy", "true");
  try {
    const result = await api("/api/review-sheet/stock-rows", {method: "POST", body: JSON.stringify({
      stocks: items.map(({code, name}) => ({code, name})), theme, trade_date: day,
    })});
    if (!$("review-add-stocks-dialog").open) return false;
    if (!reviewInsertRows(result.rows, "theme", day, result.dates)) {
      $("review-add-stock-status").textContent = $("review-notice").textContent; return false;
    }
    const notes = [];
    if (skipped) notes.push(`跳过 ${skipped} 只同题材同日已有记录的股票`);
    if (result.missing_cells) notes.push(`${result.missing_cells} 格缺少本地有效行情，已留空，请先到数据页面补充本地数据`);
    if (result.unconfirmed_dates?.length) notes.push(`${result.unconfirmed_dates.length} 天缺少收盘天梯，仅填写已有涨跌幅，无法确认涨停和连板`);
    $("review-collect-result").textContent = `已加入 ${result.rows.length} 只 · 行情补齐至 ${result.dates.at(-1)}${result.missing_cells ? ` · ${result.missing_cells} 格缺少行情` : ""}${result.unconfirmed_dates?.length ? ` · ${result.unconfirmed_dates.length} 天连板未确认` : ""}`;
    reviewNotice(notes.join("；"));
    return true;
  } catch (error) {
    $("review-add-stock-status").textContent = `未加入：${error.message}`;
    return false;
  } finally {
    reviewCollecting = false;
    $("review-controls").disabled = false; $("review-grid").inert = false;
    $("review-add-stocks-dialog").querySelector(".review-dialog-body").inert = false;
    $("review-add-stocks-form").removeAttribute("aria-busy");
  }
}

function reviewThemeTools() {
  const groups = reviewThemeGroups(), jump = $("review-theme-jump"), selected = jump.value;
  jump.innerHTML = '<option value="">选择题材</option>' + groups.map(group =>
    `<option value="${escapeHtml(group.theme)}">${escapeHtml(group.theme)} · ${group.indices.length}条</option>`).join("");
  jump.value = selected;
  const collected = (reviewSheet.collected_dates || []).filter(day => reviewDays.includes(day)).length;
  $("review-summary").textContent = `${groups.length} 个题材 · ${reviewSheet.rows.length} 条记录 · ${collected ? `${collected} 个收录日` : `${reviewDays.length} 个日期`}`;
  $("review-theme-sort").disabled = groups.length < 2;
  if ($("review-theme-dialog").open) reviewThemeList();
}

function reviewThemeList() {
  const groups = reviewThemeGroups(), list = $("review-theme-list"), top = list.scrollTop;
  const query = $("review-theme-search").value.trim().toLowerCase();
  const visible = groups.map((group, index) => ({...group, index})).filter(group => group.theme.toLowerCase().includes(query));
  $("review-theme-matches").textContent = `${visible.length} / ${groups.length} 个题材`;
  list.innerHTML = visible.map(group => {
    const theme = escapeHtml(group.theme), index = group.index;
    return `<div class="review-theme-sort-item" data-sort-theme="${theme}" style="--review-theme-color:${reviewThemeColor(group.theme)}">
      <span class="review-theme-drag" draggable="true" title="拖动${theme}排序" aria-label="拖动${theme}排序"><svg width="16" height="20" viewBox="0 0 16 20" fill="currentColor" aria-hidden="true"><circle cx="5" cy="4" r="1.5"/><circle cx="11" cy="4" r="1.5"/><circle cx="5" cy="10" r="1.5"/><circle cx="11" cy="10" r="1.5"/><circle cx="5" cy="16" r="1.5"/><circle cx="11" cy="16" r="1.5"/></svg></span>
      <span class="review-theme-name">${theme}<small>第 ${index + 1} 位 · ${group.indices.length} 条记录</small></span>
      <div class="review-theme-actions">
        <button class="btn" type="button" data-theme-action="up" aria-label="${theme}上移" title="上移一位" ${index ? "" : "disabled"}>↑</button>
        <button class="btn" type="button" data-theme-action="down" aria-label="${theme}下移" title="下移一位" ${index < groups.length - 1 ? "" : "disabled"}>↓</button>
        <button class="btn" type="button" data-theme-action="top" aria-label="${theme}置顶" ${index ? "" : "disabled"}>置顶</button>
        <button class="btn" type="button" data-theme-action="bottom" aria-label="${theme}置底" ${index < groups.length - 1 ? "" : "disabled"}>置底</button>
        <form class="review-theme-position"><label>第 <input type="number" min="1" max="${groups.length}" value="${index + 1}" required aria-label="${theme}目标位置"> 位</label><button class="btn" type="submit" aria-label="移动${theme}到指定位置">移动</button></form>
      </div></div>`;
  }).join("") || '<p class="review-theme-empty">没有找到对应题材</p>';
  list.scrollTop = top;
}

function reviewMoveTheme(theme, position, control = "position") {
  if (!reviewFinishEdit() || reviewCollecting) return;
  const groups = reviewThemeGroups(), index = groups.findIndex(group => group.theme === theme);
  const group = groups[index], neighbor = groups[position];
  if (!group || !neighbor || !Number.isInteger(position) || index === position) return;
  const anchor = reviewSheet.rows[reviewAnchor.r]?.id, end = reviewSheet.rows[reviewEnd.r]?.id;
  const boundary = position < index ? neighbor.indices[0] : neighbor.indices.at(-1) + 1;
  const insertion = boundary - group.indices.filter(r => r < boundary).length;
  reviewCheckpoint();
  reviewFixRowThemes();
  const rows = group.indices.map(r => reviewSheet.rows[r]);
  [...group.indices].reverse().forEach(r => reviewSheet.rows.splice(r, 1));
  reviewSheet.rows.splice(insertion, 0, ...rows);
  reviewAnchor.r = reviewSheet.rows.findIndex(row => row.id === anchor);
  reviewEnd.r = reviewSheet.rows.findIndex(row => row.id === end);
  reviewRender(true); reviewChanged();
  $("review-theme-status").textContent = `${theme}已移到第 ${position + 1} 位`;
  const node = [...$("review-theme-list").querySelectorAll("[data-sort-theme]")].find(node => node.dataset.sortTheme === theme);
  (node?.querySelector(`[data-theme-action="${control}"]:not(:disabled)`) || node?.querySelector("input"))?.focus({preventScroll: true});
  node?.scrollIntoView({block: "nearest"});
}

function reviewThemeDragEnd() {
  reviewThemeDrag = "";
  $("review-theme-list").querySelectorAll("[data-drop], .is-dragging").forEach(node => {
    delete node.dataset.drop;
    node.classList.remove("is-dragging");
  });
}

function reviewThemeDrop(event) {
  event.preventDefault();
  const node = event.target.closest("[data-sort-theme]"), groups = reviewThemeGroups();
  const from = groups.findIndex(group => group.theme === reviewThemeDrag);
  const target = groups.findIndex(group => group.theme === node?.dataset.sortTheme);
  if (from >= 0 && target >= 0 && from !== target) {
    const bounds = node.getBoundingClientRect(), after = event.clientY >= bounds.top + bounds.height / 2;
    reviewMoveTheme(reviewThemeDrag, target + Number(after) - Number(from < target));
  }
  reviewThemeDragEnd();
}

function reviewCloseThemeDialog() {
  $("review-theme-dialog").close();
  reviewSave();
}

function reviewFitOverview() {
  const root = $("review-scroll");
  root.style.setProperty("--review-overview-width", `${Math.max(64, Math.floor((root.clientWidth - 152) / Math.max(1, reviewDays.length)) - 1)}px`);
}

function reviewScrollDock() {
  const root = $("review-scroll"), dock = $("review-scroll-dock"), range = $("review-scroll-range");
  const maximum = Math.max(0, root.scrollWidth - root.clientWidth), bounds = root.getBoundingClientRect();
  dock.style.left = `${bounds.left}px`;
  dock.style.width = `${root.clientWidth}px`;
  document.documentElement.style.setProperty("--review-dock-height", `${Math.ceil(dock.getBoundingClientRect().height) + 8}px`);
  range.max = maximum;
  range.value = root.scrollLeft;
  range.disabled = !maximum;
  dock.querySelectorAll("button").forEach(button => {
    button.disabled = ["first", "left"].includes(button.dataset.reviewScroll) ? root.scrollLeft <= 1 : root.scrollLeft >= maximum - 1;
  });
}

function reviewRowLabel(row, r) {
  const {stock, theme} = reviewRowInfo(row);
  return `<div class="review-row-label"><input class="review-row-check" type="checkbox" data-review-row-check="${r}" aria-label="勾选第 ${r + 1} 行${stock ? ` ${escapeHtml(stock)}` : ""}" ${reviewCheckedRows.has(row.id) ? "checked" : ""}><button type="button" class="review-row-number" data-row="${r}" aria-label="选择第 ${r + 1} 行">${r + 1}${row.leader ? " · 龙头" : ""}</button><button type="button" class="review-row-stock" data-chart-row="${r}" title="查看${escapeHtml(stock || "个股")}K线">${escapeHtml(stock || "关联股票查看K线")}</button><small class="review-row-theme${theme ? " has-theme" : ""}${row.tracking?.stopped ? " review-row-stopped" : ""}" style="--review-theme-color:${reviewThemeColor(theme)}">${escapeHtml(theme || "选名称格后点「个股」")}${row.tracking?.stopped ? " · 已停止" : ""}</small></div>`;
}

function reviewThemeBreaks() {
  let previous = "";
  const breaks = [];
  reviewSheet.rows.forEach((row, r) => {
    if (!reviewRowOccupied(row)) { previous = ""; return; }
    const {theme} = reviewRowInfo(row);
    if (theme && previous && theme !== previous) breaks.push(r);
    if (theme) previous = theme;
  });
  return breaks;
}

function reviewRefreshThemeGaps() {
  const grid = $("review-grid");
  grid.querySelectorAll(".review-theme-gap").forEach(row => row.remove());
  reviewThemeBreaks().forEach(r => grid.querySelector(`tr[data-review-row="${r}"]`)?.insertAdjacentHTML("beforebegin",
    `<tr class="review-theme-gap" aria-hidden="true"><th colspan="${reviewDays.length + 1}"></th></tr>`));
  reviewThemeTools();
}

function reviewPaintRowLabel(r) {
  const label = $("review-grid").querySelector(`tr[data-review-row="${r}"] .review-index`);
  if (label) label.innerHTML = reviewRowLabel(reviewSheet.rows[r], r);
}

function reviewPaintCell(r, c) {
  const node = $("review-grid").querySelector(`[data-r="${r}"][data-c="${c}"]`);
  if (!node) return;
  const value = reviewCell(r, c);
  node.parentElement.style.cssText = reviewStyle(value, reviewSheet.rows[r].leader, reviewRowInfo(reviewSheet.rows[r]).theme);
  if (node.textContent !== (value.text || "")) node.textContent = value.text || "";
  reviewPaintRowLabel(r);
}

function reviewSelection() {
  const ids = new Set(reviewSheet.rows.map(row => row.id));
  for (const id of reviewCheckedRows) if (!ids.has(id)) reviewCheckedRows.delete(id);
  const indices = reviewTargetIndices(), targets = new Set(indices), rows = indices.map(r => reviewSheet.rows[r]);
  if (reviewCheckedRows.size && !targets.has(reviewAnchor.r)) {
    reviewAnchor = {r: indices[0], c: reviewAnchor.c}; reviewEnd = {...reviewAnchor};
  }
  const {r1, r2, c1, c2} = reviewBounds();
  $("review-grid").querySelectorAll("td").forEach(td => {
    const {r, c} = td.firstElementChild.dataset;
    const selected = targets.has(+r) && (reviewCheckedRows.size || c >= c1 && c <= c2);
    td.classList.toggle("is-selected", !!selected);
    td.classList.toggle("is-active", +r === reviewAnchor.r && +c === reviewAnchor.c);
    td.setAttribute("aria-selected", String(!!selected));
    td.firstElementChild.tabIndex = +r === reviewAnchor.r && +c === reviewAnchor.c ? 0 : -1;
  });
  const count = reviewDays.length && reviewSheet.rows.length ? rows.length * (reviewCheckedRows.size ? reviewDays.length : c2 - c1 + 1) : 0;
  $("review-grid").querySelectorAll("[data-review-row-check]").forEach(node => {
    node.checked = reviewCheckedRows.has(reviewSheet.rows[+node.dataset.reviewRowCheck]?.id);
    node.closest("th").classList.toggle("is-row-checked", node.checked);
  });
  [$("review-grid"), $("review-sticky-head")].forEach(grid => grid.querySelectorAll("[data-review-select-all]").forEach(node => {
    node.checked = !!reviewSheet.rows.length && reviewCheckedRows.size === reviewSheet.rows.length;
    node.indeterminate = !!reviewCheckedRows.size && !node.checked;
  }));
  $("review-row-selection").textContent = reviewCheckedRows.size ? `已勾选 ${rows.length} 行` : "勾选左侧可批量操作";
  $("review-clear-row-selection").disabled = !reviewCheckedRows.size;
  $("review-select-theme").disabled = !reviewSheet.rows.length;
  const current = reviewCell(reviewAnchor.r, reviewAnchor.c);
  const info = reviewSheet.rows[reviewAnchor.r] ? reviewRowInfo(reviewSheet.rows[reviewAnchor.r]) : {};
  $("review-address").textContent = count ? `${info.stock || `第 ${reviewAnchor.r + 1} 行`}${info.theme ? ` · ${info.theme}` : ""} · ${reviewDays[reviewAnchor.c]}` : "请选择单元格";
  if (document.activeElement !== $("review-text")) $("review-text").value = current.text || "";
  $("review-text").disabled = !count;
  $("review-bold").setAttribute("aria-pressed", String(!!current.bold));
  const leader = !!count && rows.every(row => row.leader);
  $("review-leader").setAttribute("aria-pressed", String(leader));
  $("review-leader").textContent = leader ? "取消龙头" : "设为龙头";
  $("review-yellow").setAttribute("aria-pressed", String(!!current.highlight || current.color?.toLowerCase() === "#fff176"));
  $("review-row-up").disabled = !count || indices[0] === 0;
  $("review-row-down").disabled = !count || indices.at(-1) === reviewSheet.rows.length - 1;
  const tracking = rows.map(row => row.tracking).filter(Boolean);
  $("review-tracking").disabled = !tracking.length;
  $("review-theme-edit").disabled = !count;
  $("review-theme-edit").textContent = rows.length > 1 ? `批量改题材（${rows.length}）` : "编辑题材";
  $("review-tracking").textContent = tracking.length && tracking.every(value => value.stopped) ? "恢复记录" : "停止记录";
  $("review-count").textContent = `${reviewSheet.rows.length} 行 · 显示 ${reviewDays.length} / ${reviewSheet.dates.length} 个日期${count ? ` · 已选 ${count} 格${reviewCheckedRows.size ? `（${rows.length}行）` : count > 1 ? `（${r1 + 1}–${r2 + 1}行，${reviewDays[c1].slice(5)}–${reviewDays[c2].slice(5)}）` : ""}` : ""}`;
  $("review-hide-date").disabled = !count || reviewDays.length <= 1;
  $("review-restore-dates").disabled = !reviewSheet.hidden_dates.length;
}

function reviewSelect(r, c, extend = false) {
  if (!reviewFinishEdit()) return false;
  reviewCheckedRows.clear();
  if (!extend) reviewAnchor = {r, c};
  reviewEnd = {r, c};
  reviewEditing = null;
  reviewSelection();
  return true;
}

function reviewRender(preserveSelection = false) {
  if (!reviewFinishEdit()) return;
  // shortcut: 按可见日期整表渲染, 数万格出现卡顿时改用虚拟滚动。
  const hidden = new Set(reviewSheet.hidden_dates);
  reviewDays = reviewSheet.dates.filter(day => day >= $("review-start").value && day <= $("review-end").value && !hidden.has(day));
  reviewAnchor = {r: Math.max(0, Math.min(reviewAnchor.r, reviewSheet.rows.length - 1)), c: Math.max(0, Math.min(reviewAnchor.c, reviewDays.length - 1))};
  reviewEnd = preserveSelection ? {r: Math.max(0, Math.min(reviewEnd.r, reviewSheet.rows.length - 1)), c: Math.max(0, Math.min(reviewEnd.c, reviewDays.length - 1))} : {...reviewAnchor};
  const today = reviewToday();
  $("review-grid").innerHTML = `<thead><tr><th class="review-index" scope="col"><label><input type="checkbox" data-review-select-all aria-label="勾选全部行"> 股票 / 题材</label></th>${reviewDays.map((day, c) =>
    `<th class="review-day${day === today ? " review-today" : ""}" scope="col"><button type="button" data-column="${c}" aria-label="选择 ${day} 整列">${day.slice(5).replace("-", "/")}<small>${day.slice(0, 4)} · ${["日", "一", "二", "三", "四", "五", "六"][new Date(`${day}T12:00:00`).getDay()]}</small></button></th>`).join("")}</tr></thead><tbody>${reviewSheet.rows.map((row, r) => {
    const {theme} = reviewRowInfo(row);
    return `<tr data-review-row="${r}"><th class="review-index" scope="row">${reviewRowLabel(row, r)}</th>${reviewDays.map((day, c) => {
      const value = row.cells[day] || {};
      return `<td role="gridcell" style="${reviewStyle(value, row.leader, theme)}"><div class="review-cell" contenteditable="false" role="textbox" aria-multiline="true" aria-label="${day} 第 ${r + 1} 行" data-r="${r}" data-c="${c}" tabindex="-1" spellcheck="false">${escapeHtml(value.text || "")}</div></td>`;
    }).join("")}</tr>`;
  }).join("")}</tbody>`;
  reviewRefreshThemeGaps();
  reviewSelection();
  reviewHistoryButtons();
  reviewRefreshHeader();
  reviewFitOverview();
  reviewScrollDock();
}

function reviewRefreshHeader() {
  const grid = $("review-grid"), header = grid.querySelector("thead"), floating = $("review-sticky-head");
  if (!header) { floating.hidden = true; return; }
  const columns = Array.from(header.rows[0].cells, cell =>
    `<col style="width:${cell.getBoundingClientRect().width / reviewZoom()}px">`).join("");
  floating.innerHTML = `<table class="review-grid" style="width:${grid.getBoundingClientRect().width / reviewZoom()}px"><colgroup>${columns}</colgroup>${header.outerHTML.replaceAll("data-column=", "data-sticky-column=")}</table>`;
  floating.querySelectorAll("button, input").forEach(button => { button.tabIndex = -1; });
  const all = header.querySelector("[data-review-select-all]"), copy = floating.querySelector("[data-review-select-all]");
  if (all && copy) { copy.checked = all.checked; copy.indeterminate = all.indeterminate; }
  reviewPositionHeader();
}

function reviewPositionHeader() {
  const root = $("review-scroll"), floating = $("review-sticky-head"), header = $("review-grid").querySelector("thead");
  if (!header || document.fullscreenElement) { floating.hidden = true; return; }
  const bounds = root.getBoundingClientRect(), height = header.getBoundingClientRect().height;
  const top = Math.max(0, $("review-controls").getBoundingClientRect().bottom);
  floating.hidden = header.getBoundingClientRect().top >= top || bounds.bottom <= top;
  if (floating.hidden) return;
  floating.style.left = `${bounds.left}px`;
  floating.style.width = `${root.clientWidth}px`;
  floating.style.top = `${Math.min(top, bounds.bottom - height)}px`;
  floating.scrollLeft = root.scrollLeft;
}

function reviewShowLatest() {
  if (!reviewDays.length) return;
  reviewSelect(reviewAnchor.r, reviewDays.length - 1);
  $("review-scroll").scrollLeft = $("review-scroll").scrollWidth;
}

function reviewFormat(format, clear = false) {
  if (!reviewDays.length || !reviewSheet.rows.length || !reviewFinishEdit()) return;
  reviewCheckpoint();
  reviewEachSelected((r, c) => {
    const value = {...reviewCell(r, c), ...(clear ? {background: "", color: "", bold: false, highlight: false} : format)};
    reviewSetCell(r, c, value);
    reviewPaintCell(r, c);
  });
  reviewChanged();
  reviewRefreshThemeGaps();
  reviewSelection();
  reviewFocus();
}

function reviewToggleLeader() {
  if (!reviewFinishEdit() || !reviewSheet.rows.length || !reviewDays.length) return;
  const rows = reviewTargetRows(), leader = !rows.every(row => row.leader);
  reviewCheckpoint();
  rows.forEach(row => { row.leader = leader; });
  reviewRender(true);
  reviewChanged();
  reviewFocus();
}

function reviewToggleTracking() {
  if (!reviewFinishEdit()) return;
  const tracking = reviewTargetRows().map(row => row.tracking).filter(Boolean);
  if (!tracking.length) return;
  const codes = new Set(tracking.map(value => value.code)), stopped = !tracking.every(value => value.stopped);
  reviewCheckpoint();
  reviewSheet.rows.forEach(row => {
    if (codes.has(row.tracking?.code)) Object.assign(row.tracking, {stopped,
      stopped_after: stopped ? reviewSheet.collected_dates?.at(-1) || row.tracking.entry_date : null});
  });
  reviewRender(true); reviewChanged(); reviewFocus();
}

async function reviewCollect(event) {
  event.preventDefault();
  if (reviewCollecting || !reviewLoaded || !reviewFinishEdit()) return;
  if (reviewSaving) { reviewNotice("正在保存，请稍后再收录。"); return; }
  const day = $("review-collect-date").value;
  if (!day) return;
  reviewCollecting = true;
  reviewSequence++;
  reviewMenuClose();
  $("review-controls").disabled = true;
  $("review-grid").inert = true;
  $("review-reload").disabled = true;
  $("review-collect").textContent = "正在收录…";
  $("review-collect-form").setAttribute("aria-busy", "true");
  reviewStatus(`正在收录 ${day}…`);
  try {
    await reviewSave();
    if (reviewDirty || reviewConflict) throw new Error("请先保存当前编辑，再收录日期。");
    const result = await api("/api/review-sheet/collect", {method: "POST", body: JSON.stringify({trade_date: day, revision: reviewSheet.revision})});
    reviewCheckpoint();
    reviewSheet = result.sheet;
    reviewDirty = false;
    try { localStorage.removeItem(reviewDraftKey); } catch {}
    $("review-start").value = reviewSheet.dates[0];
    $("review-end").value = reviewSheet.dates.at(-1);
    reviewRender();
    reviewMove(reviewAnchor.r, reviewDays.indexOf(day));
    const message = `${day} · 新增 ${result.added} 只 · 填写 ${result.updated} 格${result.protected ? ` · 保留 ${result.protected} 格人工文字` : ""}${result.stopped ? ` · 跳过 ${result.stopped} 只已停止` : ""}${result.resumed ? ` · 恢复 ${result.resumed} 只` : ""}`;
    $("review-collect-result").textContent = message;
    const warnings = [];
    if (result.missing_codes.length) warnings.push(`${result.missing_codes.length} 只跟踪股缺少当日有效行情，原格保留：${result.missing_codes.join("、")}`);
    if (result.unclassified) warnings.push(`${result.unclassified} 只未匹配悟道主题材，暂归「未分类」`);
    reviewNotice(warnings.join("；"));
    reviewStatus("收录完成 · 已保存", "saved");
  } catch (error) {
    if (error.code === "review_conflict") reviewConflict = true;
    reviewNotice(error.message);
    reviewStatus("未完成收录 · 原记录已保留", "error");
    $("review-collect-result").textContent = "收录失败，请按提示处理后重试";
  } finally {
    reviewCollecting = false;
    $("review-controls").disabled = false;
    $("review-grid").inert = false;
    $("review-reload").disabled = false;
    $("review-collect").textContent = "收录这一天";
    $("review-collect-form").removeAttribute("aria-busy");
  }
}

function reviewToggleYellow() {
  const current = reviewCell(reviewAnchor.r, reviewAnchor.c);
  const highlighted = !!current.highlight || current.color?.toLowerCase() === "#fff176";
  if (!reviewFinishEdit() || !reviewSheet.rows.length || !reviewDays.length) return;
  reviewCheckpoint();
  reviewEachSelected((r, c) => {
    const value = {...reviewCell(r, c), highlight: !highlighted};
    if (highlighted && value.color?.toLowerCase() === "#fff176") value.color = "";
    reviewSetCell(r, c, value); reviewPaintCell(r, c);
  });
  reviewChanged(); reviewSelection(); reviewFocus();
}

function reviewMarkKind(kind) {
  if (!reviewFinishEdit() || !reviewSheet.rows.length || !reviewDays.length) return;
  const {c1, c2} = reviewBounds();
  if (c1 !== c2) { reviewNotice("标记题材或个股名称时，每行请选择一个格子；可以同时选择多行。"); return; }
  const indices = reviewTargetIndices();
  if (indices.some(r => reviewIsMarketCell(reviewSheet.rows[r].cells[reviewDays[c1]] || {}))) {
    reviewNotice("涨跌幅和连板记录不能设为题材或个股名称，请选择名称格。");
    return;
  }
  const order = reviewThemeGroups().map(group => group.theme);
  reviewCheckpoint();
  if (kind === "theme") reviewFixRowThemes();
  for (const r of indices) {
    const row = reviewSheet.rows[r];
    if (kind === "stock" && row.stock_code && reviewRowInfo(row).stock !== reviewCell(r, c1).text) {
      delete row.stock_code; delete row.tracking;
    }
    for (const cell of Object.values(reviewSheet.rows[r].cells)) if (cell.kind === kind) cell.kind = "";
    reviewSetCell(r, c1, {...reviewCell(r, c1), ...reviewKinds[kind]});
  }
  if (kind === "theme") reviewArrangeRows(order);
  reviewRender(true); reviewChanged(); reviewFocus();
}

function reviewEdit(text, key, r, c) {
  if (text.length > 2000) {
    reviewNotice("每格最多填写 2000 个字符，请分到其他格子中。");
    return false;
  }
  if (reviewEditing !== key) { reviewCheckpoint(); reviewEditing = key; }
  if (reviewCell(r, c).kind === "theme") reviewFixRowThemes();
  reviewSetCell(r, c, {...reviewCell(r, c), text});
  reviewChanged();
  return true;
}

function reviewFocus() {
  if ($("review-theme-dialog").open) return;
  $("review-grid").querySelector(`[data-r="${reviewAnchor.r}"][data-c="${reviewAnchor.c}"]`)?.focus({preventScroll: true});
}

function reviewMove(r, c, extend = false) {
  if (!reviewSheet.rows.length || !reviewDays.length) return;
  if (!reviewSelect(Math.max(0, Math.min(r, reviewSheet.rows.length - 1)), Math.max(0, Math.min(c, reviewDays.length - 1)), extend)) return;
  reviewFocus();
  $("review-grid").querySelector(`[data-r="${reviewEnd.r}"][data-c="${reviewEnd.c}"]`)?.scrollIntoView({block: "nearest", inline: "nearest"});
}

function reviewHistory(from, to) {
  if (!reviewFinishEdit()) return;
  if (!from.length) return;
  to.push(reviewBody());
  Object.assign(reviewSheet, JSON.parse(from.pop()));
  reviewEditing = null;
  reviewRender();
  reviewChanged();
  reviewFocus();
}

function reviewStartEdit(node, replace = false, initial = "") {
  if (reviewEditor?.node === node) return;
  if (!reviewFinishEdit()) return;
  const formula = node === $("review-text");
  const r = formula ? reviewAnchor.r : +node.dataset.r, c = formula ? reviewAnchor.c : +node.dataset.c;
  if (!reviewSheet.rows[r] || !reviewDays[c]) return;
  reviewSelect(r, c);
  const original = reviewCell(r, c).text || "";
  reviewEditor = {node, r, c, original, formula};
  clearTimeout(reviewTimer);
  if (formula) node.value = original;
  else {
    node.contentEditable = "plaintext-only";
    node.classList.add("is-editing");
    if (replace) node.textContent = initial;
    node.focus({preventScroll: true});
    const selection = window.getSelection(), range = document.createRange();
    range.selectNodeContents(node); range.collapse(false);
    selection.removeAllRanges(); selection.addRange(range);
  }
  $("review-text").value = formula ? node.value : node.innerText;
  reviewStatus("编辑中 · Enter确认，Esc取消");
}

function reviewFinishEdit(cancel = false) {
  if (!reviewEditor) return true;
  const {node, r, c, original, formula} = reviewEditor;
  const text = cancel ? original : (formula ? node.value : node.innerText).replace(/\r\n/g, "\n");
  if (text.length > 2000) {
    reviewNotice("每格最多填写 2000 个字符，请缩短内容后确认，或按 Esc 取消。");
    node.focus({preventScroll: true});
    return false;
  }
  reviewEditor = null;
  if (!formula) { node.contentEditable = "false"; node.classList.remove("is-editing"); }
  reviewEditing = null;
  if (!cancel && text !== original) {
    const value = reviewCell(r, c), theme = value.kind === "theme" && !reviewIsMarketCell(value) && text.trim();
    const order = theme ? reviewThemeGroups().map(group => group.theme) : [];
    reviewEdit(text, `${r}:${c}`, r, c);
    if (theme) {
      reviewArrangeRows(order);
      reviewRender(true);
      return true;
    }
  }
  reviewPaintCell(r, c);
  reviewRefreshThemeGaps();
  $("review-text").value = reviewCell(r, c).text || "";
  reviewSelection();
  if (reviewDirty && !reviewConflict) { clearTimeout(reviewTimer); reviewTimer = setTimeout(reviewSave, 700); }
  else reviewStatus(reviewConflict ? "版本冲突 · 编辑已保留" : "已保存", reviewConflict ? "error" : "saved");
  return true;
}

function reviewMoveRows(direction) {
  if (!reviewFinishEdit()) return;
  const indices = reviewTargetIndices();
  if (!indices.length || indices[0] + direction < 0 || indices.at(-1) + direction >= reviewSheet.rows.length) return;
  const anchor = reviewSheet.rows[reviewAnchor.r]?.id, end = reviewSheet.rows[reviewEnd.r]?.id;
  reviewCheckpoint();
  reviewFixRowThemes();
  for (const r of direction < 0 ? indices : [...indices].reverse()) {
    [reviewSheet.rows[r], reviewSheet.rows[r + direction]] = [reviewSheet.rows[r + direction], reviewSheet.rows[r]];
  }
  reviewAnchor.r = reviewSheet.rows.findIndex(row => row.id === anchor);
  reviewEnd.r = reviewSheet.rows.findIndex(row => row.id === end);
  reviewRender(true); reviewChanged(); reviewFocus();
}

function reviewDeleteRows() {
  if (!reviewFinishEdit() || !reviewSheet.rows.length) return;
  const rows = reviewTargetRows(), ids = new Set(rows.map(row => row.id));
  if (rows.some(row => Object.keys(row.cells).length) && !confirm(`删除选中的 ${rows.length} 行及其所有日期的内容？删除后可撤销。`)) return;
  reviewCheckpoint(); reviewFixRowThemes();
  reviewSheet.rows = reviewSheet.rows.filter(row => !ids.has(row.id));
  reviewCheckedRows.clear();
  reviewArrangeRows([], true);
  reviewEnd = {...reviewAnchor};
  reviewChanged(); reviewRender(); reviewFocus();
}

function reviewMenuClose(focus = false) {
  $("review-cell-menu").hidden = true;
  if (focus) reviewFocus();
}

function reviewMenuOpen(cell, x, y) {
  if (!reviewFinishEdit()) return;
  const r = +cell.dataset.r, c = +cell.dataset.c, {r1, r2, c1, c2} = reviewBounds();
  if (reviewCheckedRows.size ? !reviewCheckedRows.has(reviewSheet.rows[r]?.id) : r < r1 || r > r2 || c < c1 || c > c2) reviewSelect(r, c);
  else if (reviewCheckedRows.size) { reviewAnchor = {r, c}; reviewEnd = {...reviewAnchor}; reviewSelection(); }
  const menu = $("review-cell-menu");
  menu.querySelector('[data-review-action="leader"]').textContent = $("review-leader").textContent;
  menu.querySelector('[data-review-action="yellow"]').textContent = $("review-yellow").getAttribute("aria-pressed") === "true" ? "恢复字色" : "设为黄字";
  menu.querySelector('[data-review-action="move-up"]').disabled = $("review-row-up").disabled;
  menu.querySelector('[data-review-action="move-down"]').disabled = $("review-row-down").disabled;
  menu.querySelector('[data-review-action="tracking"]').disabled = $("review-tracking").disabled;
  menu.querySelector('[data-review-action="tracking"]').textContent = $("review-tracking").textContent;
  menu.hidden = false;
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
  menu.querySelector("button:not(:disabled)").focus({preventScroll: true});
}

// Excel 的引号、格内换行和连续空格必须保留, 避免粘贴后错行。
function reviewParseTSV(text) {
  const rows = [[]];
  let value = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"' && (quoted || !value)) {
      if (quoted && text[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (char === "\t" || char === "\r" || char === "\n")) {
      rows.at(-1).push(value); value = "";
      if (char !== "\t") {
        if (char === "\r" && text[i + 1] === "\n") i++;
        rows.push([]);
      }
    } else value += char;
  }
  rows.at(-1).push(value);
  if (rows.length > 1 && rows.at(-1).length === 1 && !rows.at(-1)[0]) rows.pop();
  return rows;
}

function reviewPaste(text, copiedCells = null) {
  if (reviewCheckedRows.size) { reviewNotice("粘贴前请先点击一个单元格，确定连续的写入位置；勾选多行可用于批量题材、格式和行操作。"); return; }
  const matrix = reviewParseTSV(text), {r1, c1} = reviewBounds();
  const width = Math.max(...matrix.map(row => row.length));
  if (!reviewDays.length || !reviewSheet.rows.length) return;
  if (r1 + matrix.length > 1000 || c1 + width > reviewDays.length || matrix.some(row => row.some(value => value.length > 2000))) {
    reviewNotice("粘贴范围超出表格或文字过长。请先扩展显示日期；最多 1000 行，每格 2000 字。此次未粘贴。");
    return;
  }
  const order = reviewThemeGroups().map(group => group.theme);
  const regroup = matrix.some((row, r) => row.some((_, c) =>
    (copiedCells?.[r]?.[c] || reviewCell(r1 + r, c1 + c)).kind === "theme"));
  reviewCheckpoint();
  if (regroup) reviewFixRowThemes();
  while (reviewSheet.rows.length < r1 + matrix.length) reviewSheet.rows.push(reviewNewRow());
  matrix.forEach((row, r) => row.forEach((value, c) => reviewSetCell(r1 + r, c1 + c,
    {...(copiedCells?.[r]?.[c] || reviewCell(r1 + r, c1 + c)), text: value})));
  reviewChanged();
  reviewAnchor = {r: r1, c: c1}; reviewEnd = {r: r1 + matrix.length - 1, c: c1 + width - 1};
  if (regroup) reviewArrangeRows(order);
  reviewRender(true);
  reviewFocus();
}

function reviewClipboardCells(raw) {
  try {
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows) || rows.length > 1000) return null;
    return rows.map(row => {
      if (!Array.isArray(row) || row.length > 1500) throw new Error();
      return row.map(cell => {
        if (!cell || typeof cell !== "object" || typeof cell.text !== "string" || cell.text.length > 2000) throw new Error();
        const color = key => /^#[0-9a-f]{6}$/i.test(cell[key] || "") ? cell[key] : "";
        return {text: cell.text, background: color("background"), color: color("color"), bold: cell.bold === true,
          highlight: cell.highlight === true, kind: ["theme", "stock"].includes(cell.kind) ? cell.kind : ""};
      });
    });
  } catch { return null; }
}

async function reviewDates(start, end) {
  const result = await api(`/api/review-sheet/dates?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
  $("review-calendar-note").textContent = result.provisional ? "部分日期没有本地交易日历，暂时只跳过周末；节假日可选中日期表头后隐藏。" : "日期按本地交易日历排列，已跳过休市日。";
  return result.dates;
}

async function reviewLoad(discard = false) {
  if (reviewCollecting) return;
  if (!reviewFinishEdit()) return;
  if (reviewSaving) { reviewNotice("正在保存，请稍后重新读取。"); return; }
  if (discard && reviewDirty && !confirm("重新读取会放弃本页未保存的编辑，建议先导出备份。确定继续？")) return;
  clearTimeout(reviewTimer);
  const sequence = reviewSequence;
  try {
    const saved = await api("/api/review-sheet");
    if (reviewLoaded && (reviewCollecting || sequence !== reviewSequence || reviewEditor)) {
      reviewNotice("读取期间开始了新的编辑或行情补齐，已保留当前内容。请完成后再重新读取。");
      return;
    }
    let draft;
    try { draft = discard ? null : JSON.parse(localStorage.getItem(reviewDraftKey) || "null"); } catch {}
    if (draft && (!Array.isArray(draft.dates) || !Array.isArray(draft.rows) || !Array.isArray(draft.hidden_dates))) draft = null;
    if (draft && JSON.stringify({...draft, revision: saved.revision}) === JSON.stringify(saved)) draft = null;
    reviewSheet = draft || saved;
    reviewConflict = !!draft && draft.revision !== saved.revision;
    reviewDirty = !!draft;
    reviewEditing = null;
    reviewEditor = null;
    reviewUndo.length = reviewRedo.length = 0;
    reviewCheckedRows.clear();
    if (discard) { try { localStorage.removeItem(reviewDraftKey); } catch {} }
    if (!reviewSheet.dates.length) {
      const end = reviewToday(), start = new Date(`${end}T12:00:00Z`);
      start.setUTCDate(start.getUTCDate() - 27);
      reviewSheet.dates = await reviewDates(start.toISOString().slice(0, 10), end);
      reviewSheet.rows = Array.from({length: 12}, reviewNewRow);
      reviewDirty = true;
    }
    $("review-start").value = reviewSheet.dates[Math.max(0, reviewSheet.dates.length - 30)] || reviewToday();
    $("review-end").value = reviewSheet.dates.at(-1) || reviewToday();
    $("review-controls").disabled = false;
    reviewLoaded = true;
    reviewRender();
    reviewShowLatest();
    reviewNotice(reviewConflict ? "发现未保存草稿，但已保存版本有更新。请先导出备份，再重新读取；当前草稿不会自动覆盖已保存内容。" : draft ? "已恢复上次未保存的草稿。" : "");
    reviewStatus(reviewConflict ? "版本冲突 · 草稿已保留" : "已读取", reviewConflict ? "error" : "saved");
    if (reviewDirty && !reviewConflict) reviewChanged();
  } catch (error) {
    reviewStatus("读取失败", "error");
    reviewNotice(`无法读取复盘表：${error.message}。请点击「重新读取已保存版本」重试。`);
  }
}

$("review-grid").addEventListener("pointerdown", event => {
  if (event.target.closest("[data-chart-row]")) { event.preventDefault(); return; }
  const cell = event.target.closest(".review-cell");
  if (!cell || event.button !== 0 || reviewEditor?.node === cell) return;
  if (event.pointerType !== "touch") event.preventDefault();
  reviewMenuClose();
  if (!reviewSelect(+cell.dataset.r, +cell.dataset.c, event.shiftKey)) return;
  reviewFocus();
  if (event.pointerType !== "touch") reviewDrag = {pointerId: event.pointerId};
});
document.addEventListener("pointermove", event => {
  if (!reviewDrag || event.pointerId !== reviewDrag.pointerId) return;
  const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest("#review-grid .review-cell");
  if (cell && (+cell.dataset.r !== reviewEnd.r || +cell.dataset.c !== reviewEnd.c)) reviewSelect(+cell.dataset.r, +cell.dataset.c, true);
  const scroll = $("review-scroll"), bounds = scroll.getBoundingClientRect();
  if (event.clientX > bounds.right - 24) scroll.scrollLeft += 20;
  else if (event.clientX < bounds.left + 174) scroll.scrollLeft -= 20;
});
document.addEventListener("pointerup", () => { reviewDrag = null; });
document.addEventListener("pointercancel", () => { reviewDrag = null; });
$("review-grid").addEventListener("dblclick", event => {
  const cell = event.target.closest(".review-cell");
  if (cell) reviewStartEdit(cell);
});
$("review-grid").addEventListener("focusin", event => {
  const cell = event.target.closest(".review-cell");
  if (cell && (+cell.dataset.r !== reviewAnchor.r || +cell.dataset.c !== reviewAnchor.c)) reviewSelect(+cell.dataset.r, +cell.dataset.c);
});
function reviewGridClick(event) {
  if (event.target.closest("[data-review-row-check], [data-review-select-all]")) return;
  const chart = event.target.closest("[data-chart-row]");
  if (chart) { reviewOpenChart(+chart.dataset.chartRow); return; }
  const row = event.target.closest("[data-row]"), column = event.target.closest("[data-column], [data-sticky-column]");
  if (row && reviewDays.length) { reviewSelect(+row.dataset.row, reviewAnchor.c, event.shiftKey); reviewAnchor.c = 0; reviewEnd.c = reviewDays.length - 1; reviewSelection(); reviewFocus(); }
  if (column && reviewSheet.rows.length) { reviewSelect(0, +(column.dataset.column ?? column.dataset.stickyColumn)); reviewEnd.r = reviewSheet.rows.length - 1; reviewSelection(); }
}
$("review-grid").addEventListener("click", reviewGridClick);
$("review-sticky-head").addEventListener("click", reviewGridClick);
function reviewRowCheckChange(event) {
  const check = event.target.closest("[data-review-row-check], [data-review-select-all]");
  if (!check) return;
  const indices = check.hasAttribute("data-review-select-all") ? reviewSheet.rows.map((_, r) => r) : [+check.dataset.reviewRowCheck];
  reviewCheckRows(indices, check.checked);
}
$("review-grid").addEventListener("change", reviewRowCheckChange);
$("review-sticky-head").addEventListener("change", reviewRowCheckChange);
$("review-sticky-head").addEventListener("pointerdown", event => { event.preventDefault(); });
$("review-scroll").addEventListener("scroll", () => { reviewPositionHeader(); reviewScrollDock(); reviewMenuClose(); }, {passive: true});
$("review-sticky-head").addEventListener("scroll", () => {
  const floating = $("review-sticky-head"), root = $("review-scroll");
  if (!floating.hidden && Math.abs(root.scrollLeft - floating.scrollLeft) > 1) root.scrollLeft = floating.scrollLeft;
}, {passive: true});
window.addEventListener("scroll", reviewPositionHeader, {passive: true});
$("review-grid").addEventListener("input", event => {
  const cell = event.target.closest(".review-cell");
  if (!cell || reviewEditor?.node !== cell) return;
  $("review-text").value = cell.innerText;
  reviewStatus("编辑中 · Enter确认，Esc取消");
});
$("review-text").addEventListener("focus", () => reviewStartEdit($("review-text")));
$("review-text").addEventListener("input", () => {
  if (reviewEditor?.node !== $("review-text")) return;
  reviewStatus("编辑中 · Enter确认，Esc取消");
});
document.addEventListener("focusout", event => {
  if (reviewEditor?.node === event.target) reviewFinishEdit();
});
function reviewKeydown(event) {
  const cell = event.target.closest(".review-cell"), formula = event.target === $("review-text");
  if (!cell && !formula) return;
  if (event.isComposing) return;
  if (event.keyCode === 229 || event.key === "Process") {
    if (!reviewEditor && cell) reviewStartEdit(cell, true);
    return;
  }
  const editing = !!reviewEditor, {r, c} = reviewAnchor;
  if (event.key === "Escape") {
    event.preventDefault(); reviewFinishEdit(true); reviewFocus(); return;
  }
  if (event.key === "Enter" && !event.altKey) {
    event.preventDefault();
    if (reviewFinishEdit()) reviewMove(reviewAnchor.r + (event.shiftKey ? -1 : 1), reviewAnchor.c);
  } else if (event.key === "Enter" && event.altKey) {
    if (!editing && cell) reviewStartEdit(cell);
    if (!formula) { event.preventDefault(); document.execCommand("insertText", false, "\n"); }
  } else if (event.key === "Tab") {
    event.preventDefault();
    if (!reviewFinishEdit()) return;
    const index = reviewAnchor.r * reviewDays.length + reviewAnchor.c + (event.shiftKey ? -1 : 1);
    if (index >= 0 && index < reviewSheet.rows.length * reviewDays.length) reviewMove(Math.floor(index / reviewDays.length), index % reviewDays.length);
  } else if (!editing && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
    event.preventDefault();
    const origin = event.shiftKey ? reviewEnd : reviewAnchor;
    reviewMove(origin.r + (event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0), origin.c + (event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0), event.shiftKey);
  } else if (!editing && ["Home", "End"].includes(event.key)) {
    event.preventDefault();
    reviewMove(event.ctrlKey || event.metaKey ? (event.key === "Home" ? 0 : reviewSheet.rows.length - 1) : r,
      event.key === "Home" ? 0 : reviewDays.length - 1, event.shiftKey);
  } else if (!editing && (event.key === "Delete" || event.key === "Backspace")) {
    event.preventDefault(); reviewFormat({text: ""});
  } else if (!editing && event.key === "F2" && cell) {
    event.preventDefault(); reviewStartEdit(cell);
  } else if (!editing && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) && cell) {
    event.preventDefault(); const bounds = cell.getBoundingClientRect(); reviewMenuOpen(cell, bounds.left, bounds.bottom);
  } else if (!editing && cell && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault(); reviewStartEdit(cell, true, event.key);
  }
}
$("review-grid").addEventListener("keydown", reviewKeydown);
$("review-text").addEventListener("keydown", reviewKeydown);
$("review-grid").addEventListener("paste", event => {
  event.preventDefault();
  const text = event.clipboardData.getData("text/plain");
  if (reviewEditor?.node === event.target.closest(".review-cell")) {
    document.execCommand("insertText", false, text);
    return;
  }
  reviewPaste(text, reviewClipboardCells(event.clipboardData.getData("application/x-findstock-review-cells")));
});
$("review-grid").addEventListener("copy", event => {
  if (reviewEditor) return;
  const {r1, r2} = reviewBounds(), bounds = reviewBounds();
  const c1 = reviewCheckedRows.size ? 0 : bounds.c1, c2 = reviewCheckedRows.size ? reviewDays.length - 1 : bounds.c2;
  if (!reviewCheckedRows.size && r1 === r2 && c1 === c2 && window.getSelection().toString()) return;
  const quote = value => /[\t\n\r"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const rows = [], cells = [];
  for (const r of reviewTargetIndices()) {
    const values = [];
    const formats = [];
    for (let c = c1; c <= c2; c++) {
      values.push(quote(reviewCell(r, c).text || ""));
      formats.push({...reviewCell(r, c), text: reviewCell(r, c).text || ""});
    }
    rows.push(values.join("\t"));
    cells.push(formats);
  }
  event.clipboardData.setData("application/x-findstock-review-cells", JSON.stringify(cells));
  event.clipboardData.setData("text/plain", rows.join("\r\n")); event.preventDefault();
});
document.querySelectorAll("[data-review-kind]").forEach(button => button.addEventListener("click", () => reviewMarkKind(button.dataset.reviewKind)));
document.querySelectorAll("[data-review-fill]").forEach(button => button.addEventListener("click", () => reviewFormat({background: {up: "#dc2626", down: "#237b3b"}[button.dataset.reviewFill] || ""})));
$("review-leader").addEventListener("click", reviewToggleLeader);
$("review-yellow").addEventListener("click", reviewToggleYellow);
$("review-row-up").addEventListener("click", () => reviewMoveRows(-1));
$("review-row-down").addEventListener("click", () => reviewMoveRows(1));
$("review-duplicate-row").addEventListener("click", reviewDuplicateRows);
$("review-bold").addEventListener("click", () => reviewFormat({bold: !reviewCell(reviewAnchor.r, reviewAnchor.c).bold}));
$("review-clear-format").addEventListener("click", () => reviewFormat({}, true));
$("review-clear").addEventListener("click", () => reviewFormat({text: ""}));
$("review-undo").addEventListener("click", () => reviewHistory(reviewUndo, reviewRedo));
$("review-redo").addEventListener("click", () => reviewHistory(reviewRedo, reviewUndo));
function reviewAddRow(insert) {
  reviewCreateRows(1, insert ? "after" : "end", reviewCurrentTheme());
}
$("review-add-row").addEventListener("click", reviewOpenNewRows);
$("review-insert-above").addEventListener("click", () => reviewCreateRows(1, "before", reviewCurrentTheme()));
$("review-insert-row").addEventListener("click", () => reviewAddRow(true));
$("review-new-rows-form").addEventListener("submit", event => {
  event.preventDefault();
  if (reviewCreateRows(Number($("review-new-row-count").value), $("review-new-row-position").value, $("review-new-row-theme").value)) {
    $("review-new-rows-dialog").close();
    const cell = $("review-grid").querySelector(`.review-cell[data-r="${reviewAnchor.r}"][data-c="${reviewAnchor.c}"]`);
    if (cell) reviewStartEdit(cell);
  } else $("review-new-rows-status").textContent = $("review-notice").textContent;
});
$("review-new-rows-dialog").addEventListener("close", reviewFocus);
$("review-add-stocks").addEventListener("click", reviewOpenAddStocks);
document.querySelectorAll("[data-review-source]").forEach(button => button.addEventListener("click", () => reviewLoadAddSource(button.dataset.reviewSource)));
$("review-add-category").addEventListener("change", reviewFilterAddStocks);
$("review-add-ladder-date").addEventListener("change", () => reviewLoadAddSource("ladder", $("review-add-ladder-date").value));
$("review-add-source-retry").addEventListener("click", () => reviewLoadAddSource(reviewAddSource, reviewAddSource === "ladder" ? $("review-add-ladder-date").value : ""));
$("review-add-stock-query").addEventListener("input", () => { if (reviewAddSource !== "search") reviewFilterAddStocks(); });
$("review-add-visible").addEventListener("click", () => {
  reviewAddStockResults.forEach(item => reviewAddStocks.set(item.code, item)); reviewPaintAddStocks(false);
});
$("review-add-stocks-search").addEventListener("submit", event => { event.preventDefault(); reviewSearchAddStocks(); });
$("review-add-stock-results").addEventListener("change", event => {
  const check = event.target.closest("[data-add-stock-code]");
  const item = check && reviewAddStockResults.find(item => item.code === check.dataset.addStockCode);
  if (!item) return;
  check.checked ? reviewAddStocks.set(item.code, item) : reviewAddStocks.delete(item.code);
  reviewPaintAddStocks(false);
});
$("review-add-stock-selected").addEventListener("click", event => {
  const button = event.target.closest("[data-remove-add-stock]");
  if (button) { reviewAddStocks.delete(button.dataset.removeAddStock); reviewPaintAddStocks(false); }
});
$("review-add-stocks-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (await reviewAddSelectedStocks($("review-add-stock-theme").value, $("review-add-stock-date").value)) $("review-add-stocks-dialog").close();
});
$("review-add-stocks-dialog").addEventListener("close", () => { reviewAddStockSearch++; reviewFocus(); });
$("review-clear-row-selection").addEventListener("click", () => { reviewCheckedRows.clear(); reviewSelection(); });
$("review-select-theme").addEventListener("click", () => {
  if (!reviewFinishEdit()) return;
  const group = reviewThemeGroups().find(group => group.indices.includes(reviewAnchor.r));
  reviewCheckedRows.clear();
  reviewCheckRows(group?.indices || [reviewAnchor.r], true);
});
$("review-delete-row").addEventListener("click", reviewDeleteRows);
$("review-grid").addEventListener("contextmenu", event => {
  const cell = event.target.closest(".review-cell");
  if (!cell || reviewEditor?.node === cell) return;
  event.preventDefault(); reviewMenuOpen(cell, event.clientX, event.clientY);
});
document.addEventListener("pointerdown", event => {
  if (!event.target.closest("#review-cell-menu")) reviewMenuClose();
});
$("review-cell-menu").addEventListener("keydown", event => {
  if (event.key === "Escape") { event.preventDefault(); reviewMenuClose(true); }
  if (["ArrowUp", "ArrowDown"].includes(event.key)) {
    event.preventDefault();
    const buttons = [...$("review-cell-menu").querySelectorAll("button:not(:disabled)")];
    buttons[(buttons.indexOf(document.activeElement) + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length].focus();
  }
});
$("review-cell-menu").addEventListener("click", async event => {
  const button = event.target.closest("[data-review-action]");
  if (!button) return;
  const action = button.dataset.reviewAction;
  reviewMenuClose(true);
  if (action === "edit") reviewStartEdit(document.activeElement);
  if (action === "yellow") reviewToggleYellow();
  if (action === "leader") reviewToggleLeader();
  if (action === "tracking") reviewToggleTracking();
  if (action === "theme") reviewEditTheme();
  if (action === "clear") reviewFormat({text: ""});
  if (action === "insert-row") reviewAddRow(true);
  if (action === "move-up") reviewMoveRows(-1);
  if (action === "move-down") reviewMoveRows(1);
  if (action === "delete-row") reviewDeleteRows();
  if (action === "duplicate-row") reviewDuplicateRows();
  if (action === "copy" && !document.execCommand("copy")) reviewNotice("请使用 Ctrl＋C 复制选区。");
  if (action === "paste") {
    try { reviewPaste(await navigator.clipboard.readText()); }
    catch { reviewNotice("浏览器未允许读取剪贴板，请在格子上按 Ctrl＋V 粘贴。"); }
  }
});
$("review-range").addEventListener("submit", async event => {
  event.preventDefault();
  const start = $("review-start").value, end = $("review-end").value;
  try {
    const dates = await reviewDates(start, end);
    const combined = [...new Set([...reviewSheet.dates, ...dates])].sort();
    if (combined.length > 1500) throw new Error("已达到 1500 个日期的上限。");
    if (JSON.stringify(combined) !== JSON.stringify(reviewSheet.dates)) {
      reviewCheckpoint(); reviewSheet.dates = combined; reviewChanged();
    }
    reviewRender();
    reviewShowLatest();
  } catch (error) { reviewNotice(error.message); }
});
$("review-show-all").addEventListener("click", () => {
  $("review-start").value = reviewSheet.dates[0] || reviewToday();
  $("review-end").value = reviewSheet.dates.at(-1) || reviewToday();
  reviewRender();
  reviewShowLatest();
});
$("review-overview").addEventListener("click", () => {
  if (!reviewFinishEdit()) return;
  const enabled = document.body.classList.toggle("review-overview-mode");
  $("review-overview").setAttribute("aria-pressed", String(enabled));
  $("review-overview").textContent = enabled ? "返回编辑视图" : "整体视图";
  if (enabled) {
    $("review-start").value = reviewSheet.dates[0] || reviewToday();
    $("review-end").value = reviewSheet.dates.at(-1) || reviewToday();
  }
  reviewRender(true);
});
$("review-theme-sort").addEventListener("click", () => {
  if (!reviewFinishEdit()) return;
  $("review-theme-status").textContent = "调整后自动保存，可撤销。";
  $("review-theme-search").value = "";
  reviewThemeList();
  $("review-theme-dialog").showModal();
  document.body.classList.add("review-theme-open");
  $("review-theme-search").focus();
  $("review-theme-list").scrollTop = 0;
});
$("review-theme-list").addEventListener("click", event => {
  const button = event.target.closest("[data-theme-action]"), theme = button?.closest("[data-sort-theme]").dataset.sortTheme;
  if (!button) return;
  const groups = reviewThemeGroups(), index = groups.findIndex(group => group.theme === theme), action = button.dataset.themeAction;
  reviewMoveTheme(theme, {up: index - 1, down: index + 1, top: 0, bottom: groups.length - 1}[action], action);
});
$("review-theme-list").addEventListener("submit", event => {
  const form = event.target.closest(".review-theme-position");
  if (!form) return;
  event.preventDefault();
  const input = form.querySelector("input");
  if (input.reportValidity()) reviewMoveTheme(form.closest("[data-sort-theme]").dataset.sortTheme, input.valueAsNumber - 1);
});
$("review-theme-search").addEventListener("input", reviewThemeList);
$("review-theme-list").addEventListener("dragstart", event => {
  const handle = event.target.closest(".review-theme-drag"), node = handle?.closest("[data-sort-theme]");
  if (!node) { event.preventDefault(); return; }
  reviewThemeDrag = node.dataset.sortTheme;
  event.dataTransfer.setData("text/plain", reviewThemeDrag);
  event.dataTransfer.effectAllowed = "move";
  node.classList.add("is-dragging");
});
$("review-theme-list").addEventListener("dragover", event => {
  if (!reviewThemeDrag) return;
  const node = event.target.closest("[data-sort-theme]"), list = $("review-theme-list");
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  list.querySelectorAll("[data-drop]").forEach(item => { delete item.dataset.drop; });
  if (node && node.dataset.sortTheme !== reviewThemeDrag) {
    const bounds = node.getBoundingClientRect();
    node.dataset.drop = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
  }
  const bounds = list.getBoundingClientRect();
  if (event.clientY < bounds.top + 30) list.scrollTop -= 24;
  if (event.clientY > bounds.bottom - 30) list.scrollTop += 24;
});
$("review-theme-list").addEventListener("drop", reviewThemeDrop);
$("review-theme-list").addEventListener("dragend", reviewThemeDragEnd);
$("review-theme-dialog").addEventListener("cancel", event => {
  event.preventDefault(); reviewCloseThemeDialog();
});
$("review-theme-dialog").addEventListener("click", event => {
  const dialog = $("review-theme-dialog"), bounds = dialog.getBoundingClientRect();
  if (event.target.closest("[data-theme-close]") || event.target === dialog &&
    (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) reviewCloseThemeDialog();
});
$("review-theme-dialog").addEventListener("close", () => {
  reviewThemeDragEnd();
  document.body.classList.remove("review-theme-open");
  $("review-theme-sort").focus();
});
$("review-theme-undo").addEventListener("click", () => {
  reviewHistory(reviewUndo, reviewRedo);
  $("review-theme-status").textContent = "已撤销上一步";
});
$("review-theme-redo").addEventListener("click", () => {
  reviewHistory(reviewRedo, reviewUndo);
  $("review-theme-status").textContent = "已重做上一步";
});
$("review-theme-jump").addEventListener("change", event => {
  const group = reviewThemeGroups().find(group => group.theme === event.target.value);
  if (!group || !reviewSelect(group.indices[0], reviewAnchor.c)) return;
  reviewFocus();
  $("review-grid").querySelector(`[data-row="${group.indices[0]}"]`)?.scrollIntoView({block: "start", inline: "nearest"});
});
$("review-scroll-range").addEventListener("input", event => {
  $("review-scroll").scrollLeft = +event.target.value;
});
$("review-scroll-dock").addEventListener("click", event => {
  const action = event.target.closest("[data-review-scroll]")?.dataset.reviewScroll;
  const root = $("review-scroll");
  if (action === "first") root.scrollLeft = 0;
  if (action === "last") root.scrollLeft = root.scrollWidth;
  if (action === "left" || action === "right") root.scrollLeft += (action === "left" ? -1 : 1) * Math.max(116, root.clientWidth * .7);
  reviewScrollDock();
});
$("review-hide-date").addEventListener("click", () => {
  if (!reviewLoaded || reviewDays.length <= 1) return;
  const {c1, c2} = reviewBounds();
  if (c2 - c1 + 1 >= reviewDays.length) { reviewNotice("请至少保留一个可见日期。"); return; }
  reviewCheckpoint();
  reviewSheet.hidden_dates = [...new Set([...reviewSheet.hidden_dates, ...reviewDays.slice(c1, c2 + 1)])];
  reviewChanged(); reviewRender();
});
$("review-restore-dates").addEventListener("click", () => {
  if (!reviewLoaded) return;
  reviewCheckpoint(); reviewSheet.hidden_dates = []; reviewChanged(); reviewRender();
});
$("review-zoom").addEventListener("change", event => {
  const value = event.target.value;
  event.target.value = document.body.style.getPropertyValue("--review-zoom") || "1";
  reviewApplyZoom(value);
});
$("review-zoom-reset").addEventListener("click", () => reviewApplyZoom("1"));
$("review-theme-edit").addEventListener("click", reviewEditTheme);
$("review-theme-edit-form").addEventListener("submit", event => {
  event.preventDefault();
  const input = $("review-theme-value");
  input.value = input.value.trim();
  if (input.reportValidity() && reviewApplyTheme(input.value)) $("review-theme-edit-dialog").close();
});
$("review-theme-edit-dialog").addEventListener("close", reviewFocus);
$("review-stock-form").addEventListener("submit", event => { event.preventDefault(); reviewFindStock(); });
$("review-stock-dialog").addEventListener("close", () => { reviewStockSearch++; });
$("review-stock-results").addEventListener("click", event => {
  const button = event.target.closest("[data-stock-code]"), row = reviewSheet.rows.find(row => row.id === reviewStockRowId);
  if (!button || !row || !/^(sh|sz)\.\d{6}$/.test(button.dataset.stockCode)) return;
  reviewCheckpoint(); row.stock_code = button.dataset.stockCode;
  reviewChanged(); reviewRender(true);
  $("review-stock-dialog").close();
  $("review-grid").querySelector(`[data-chart-row="${reviewSheet.rows.indexOf(row)}"]`)?.focus({preventScroll: true});
  openStockChart(row.stock_code, {name: button.dataset.stockName});
});
document.querySelectorAll("[data-review-dialog-close]").forEach(button => button.addEventListener("click", () => button.closest("dialog").close()));
$("review-save").addEventListener("click", () => reviewSave(true));
$("review-collect-form").addEventListener("submit", reviewCollect);
$("review-tracking").addEventListener("click", reviewToggleTracking);
$("review-reload").addEventListener("click", () => reviewLoad(true));
$("review-export").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(reviewSheet, null, 2)], {type: "application/json"}));
  const link = document.createElement("a"); link.href = url; link.download = `复盘表-${reviewToday()}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$("review-fullscreen").addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $("review-controls").parentElement.requestFullscreen();
  } catch { reviewNotice("无法开启全屏，请使用浏览器的 F11 全屏。"); }
});
document.addEventListener("fullscreenchange", () => {
  $("review-fullscreen").textContent = document.fullscreenElement ? "退出全屏" : "全屏";
  reviewPositionHeader();
});
document.addEventListener("keydown", event => {
  if (document.querySelector("#stock-modal:not([hidden]), #review-stock-dialog[open], #review-theme-edit-dialog[open], #review-add-stocks-dialog[open], #review-new-rows-dialog[open]")) return;
  if (reviewCollecting) { event.preventDefault(); return; }
  if (!reviewLoaded || event.isComposing || !(event.ctrlKey || event.metaKey)) return;
  if (event.key.toLowerCase() === "s") { event.preventDefault(); reviewSave(true); }
  if (reviewEditor || $("review-theme-dialog").open && event.target.matches("input")) return;
  if (event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? reviewHistory(reviewRedo, reviewUndo) : reviewHistory(reviewUndo, reviewRedo); }
  if (event.key.toLowerCase() === "y") { event.preventDefault(); reviewHistory(reviewRedo, reviewUndo); }
});
window.addEventListener("beforeunload", event => { reviewFinishEdit(); if (reviewDirty) { event.preventDefault(); event.returnValue = ""; } });
const reviewResize = new ResizeObserver(() => {
  reviewFitOverview();
  reviewRefreshHeader();
  reviewScrollDock();
  const headerHeight = $("review-grid").querySelector("thead")?.getBoundingClientRect().height || 0;
  document.documentElement.style.scrollPaddingTop = `${$("review-controls").getBoundingClientRect().height + headerHeight + 8}px`;
  document.documentElement.style.scrollPaddingBottom = "var(--review-dock-height, 76px)";
});
["review-controls", "review-scroll", "review-grid", "review-scroll-dock"].forEach(id => reviewResize.observe($(id)));
try { reviewApplyZoom(localStorage.getItem(reviewZoomKey) || "1", false); } catch {}
reviewLoad();
$("review-collect-date").max = reviewToday();
api("/api/review-sheet/collect-dates").then(result => {
  $("review-collect-date").value = result.dates.at(-1) || reviewToday();
  $("review-collect-dates").innerHTML = result.dates.map(day => `<option value="${escapeHtml(day)}"></option>`).join("");
}).catch(() => { $("review-collect-date").value = reviewToday(); });
