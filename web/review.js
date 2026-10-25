/* 日期格内自由记录, 不从行情自动生成或覆盖用户的复盘。 */
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
let reviewSheet, reviewDays = [], reviewAnchor = {r: 0, c: 0}, reviewEnd = {r: 0, c: 0};
let reviewDirty = false, reviewSaving = false, reviewConflict = false, reviewLoaded = false;
let reviewTimer, reviewSequence = 0, reviewEditing = null;
let reviewEditor = null, reviewDrag = null;
const reviewUndo = [], reviewRedo = [];

function reviewToday() {
  return new Intl.DateTimeFormat("sv-SE", {timeZone: "Asia/Shanghai"}).format(new Date());
}

function reviewStatus(message, state = "") {
  $("review-status").textContent = message;
  $("review-status").dataset.state = state;
}

function reviewNotice(message = "") {
  $("review-notice").textContent = message;
  $("review-notice").hidden = !message;
}

function reviewBody() {
  return JSON.stringify({dates: reviewSheet.dates, hidden_dates: reviewSheet.hidden_dates, rows: reviewSheet.rows});
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

async function reviewSave() {
  if (!reviewFinishEdit()) return;
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
    reviewNotice(`${error.message} 当前内容仍在本页，可先导出备份。`);
  } finally { reviewSaving = false; }
}

function reviewNewRow() { return {id: crypto.randomUUID(), cells: {}}; }

function reviewBounds() {
  return {r1: Math.min(reviewAnchor.r, reviewEnd.r), r2: Math.max(reviewAnchor.r, reviewEnd.r),
    c1: Math.min(reviewAnchor.c, reviewEnd.c), c2: Math.max(reviewAnchor.c, reviewEnd.c)};
}

function reviewEachSelected(callback) {
  const {r1, r2, c1, c2} = reviewBounds();
  for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
    if (reviewSheet.rows[r] && reviewDays[c]) callback(r, c);
  }
}

function reviewCell(r, c) { return reviewSheet.rows[r]?.cells[reviewDays[c]] || {}; }

function reviewSetCell(r, c, value) {
  if (value.text || value.background || value.color || value.bold || value.kind || value.highlight) reviewSheet.rows[r].cells[reviewDays[c]] = value;
  else delete reviewSheet.rows[r].cells[reviewDays[c]];
}

function reviewStyle(value, leader = false) {
  const color = key => /^#[0-9a-f]{6}$/i.test(value[key] || "") ? value[key] : "";
  const background = leader ? "#7e22a8" : color("background");
  const highlighted = value.highlight || value.color?.toLowerCase() === "#fff176";
  const foreground = highlighted ? "#fff176" : leader ? "#ffffff" : color("color") ||
    (["#dc2626", "#237b3b"].includes(background) ? "#ffffff" : "");
  return `background-color:${background};color:${foreground};font-weight:${value.bold ? 700 : 400}`;
}

function reviewRowInfo(row) {
  const cells = reviewSheet.dates.map(day => row.cells[day]).filter(cell => cell?.text);
  const stock = cells.find(cell => cell.kind === "stock") || cells.find(cell => cell.background?.toLowerCase() === "#2563a6");
  const theme = cells.find(cell => cell.kind === "theme") || cells.find(cell => ["#7e22a8", "#dbeafe"].includes(cell.background?.toLowerCase()));
  return {stock: stock?.text || "", theme: theme?.text || ""};
}

function reviewRowLabel(row, r) {
  const {stock, theme} = reviewRowInfo(row);
  return `<span class="review-row-number">${r + 1}${row.leader ? " · 龙头" : ""}</span><span class="review-row-stock">${escapeHtml(stock || "未标记个股")}</span><small class="review-row-theme">${escapeHtml(theme || "选名称格后点「个股」")}</small>`;
}

function reviewPaintRowLabel(r) {
  const button = $("review-grid").querySelector(`[data-row="${r}"]`);
  if (button) button.innerHTML = reviewRowLabel(reviewSheet.rows[r], r);
}

function reviewPaintCell(r, c) {
  const node = $("review-grid").querySelector(`[data-r="${r}"][data-c="${c}"]`);
  if (!node) return;
  const value = reviewCell(r, c);
  node.parentElement.style.cssText = reviewStyle(value, reviewSheet.rows[r].leader);
  if (node.textContent !== (value.text || "")) node.textContent = value.text || "";
  reviewPaintRowLabel(r);
}

function reviewSelection() {
  const {r1, r2, c1, c2} = reviewBounds();
  $("review-grid").querySelectorAll("td").forEach(td => {
    const {r, c} = td.firstElementChild.dataset;
    td.classList.toggle("is-selected", r >= r1 && r <= r2 && c >= c1 && c <= c2);
    td.classList.toggle("is-active", +r === reviewAnchor.r && +c === reviewAnchor.c);
    td.setAttribute("aria-selected", String(r >= r1 && r <= r2 && c >= c1 && c <= c2));
    td.firstElementChild.tabIndex = +r === reviewAnchor.r && +c === reviewAnchor.c ? 0 : -1;
  });
  const count = reviewDays.length && reviewSheet.rows.length ? (r2 - r1 + 1) * (c2 - c1 + 1) : 0;
  const current = reviewCell(reviewAnchor.r, reviewAnchor.c);
  const info = reviewSheet.rows[reviewAnchor.r] ? reviewRowInfo(reviewSheet.rows[reviewAnchor.r]) : {};
  $("review-address").textContent = count ? `${info.stock || `第 ${reviewAnchor.r + 1} 行`}${info.theme ? ` · ${info.theme}` : ""} · ${reviewDays[reviewAnchor.c]}` : "请选择单元格";
  if (document.activeElement !== $("review-text")) $("review-text").value = current.text || "";
  $("review-text").disabled = !count;
  $("review-bold").setAttribute("aria-pressed", String(!!current.bold));
  const leader = !!count && reviewSheet.rows.slice(r1, r2 + 1).every(row => row.leader);
  $("review-leader").setAttribute("aria-pressed", String(leader));
  $("review-leader").textContent = leader ? "取消龙头" : "设为龙头";
  $("review-yellow").setAttribute("aria-pressed", String(!!current.highlight || current.color?.toLowerCase() === "#fff176"));
  $("review-row-up").disabled = !count || r1 === 0;
  $("review-row-down").disabled = !count || r2 === reviewSheet.rows.length - 1;
  $("review-count").textContent = `${reviewSheet.rows.length} 行 · 显示 ${reviewDays.length} / ${reviewSheet.dates.length} 个日期${count ? ` · 已选 ${count} 格${count > 1 ? `（${r1 + 1}–${r2 + 1}行，${reviewDays[c1].slice(5)}–${reviewDays[c2].slice(5)}）` : ""}` : ""}`;
  $("review-hide-date").disabled = !count || reviewDays.length <= 1;
  $("review-restore-dates").disabled = !reviewSheet.hidden_dates.length;
}

function reviewSelect(r, c, extend = false) {
  if (!reviewFinishEdit()) return false;
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
  $("review-grid").innerHTML = `<thead><tr><th class="review-index" scope="col">股票 / 题材</th>${reviewDays.map((day, c) =>
    `<th class="review-day${day === today ? " review-today" : ""}" scope="col"><button type="button" data-column="${c}" aria-label="选择 ${day} 整列">${day.slice(5).replace("-", "/")}<small>${day.slice(0, 4)} · ${["日", "一", "二", "三", "四", "五", "六"][new Date(`${day}T12:00:00`).getDay()]}</small></button></th>`).join("")}</tr></thead><tbody>${reviewSheet.rows.map((row, r) =>
    `<tr><th class="review-index" scope="row"><button type="button" data-row="${r}" aria-label="选择第 ${r + 1} 行">${reviewRowLabel(row, r)}</button></th>${reviewDays.map((day, c) => {
      const value = row.cells[day] || {};
      return `<td role="gridcell" style="${reviewStyle(value, row.leader)}"><div class="review-cell" contenteditable="false" role="textbox" aria-multiline="true" aria-label="${day} 第 ${r + 1} 行" data-r="${r}" data-c="${c}" tabindex="-1" spellcheck="false">${escapeHtml(value.text || "")}</div></td>`;
    }).join("")}</tr>`).join("")}</tbody>`;
  reviewSelection();
  reviewHistoryButtons();
  reviewRefreshHeader();
}

function reviewRefreshHeader() {
  const grid = $("review-grid"), header = grid.querySelector("thead"), floating = $("review-sticky-head");
  if (!header) { floating.hidden = true; return; }
  const columns = Array.from(header.rows[0].cells, cell =>
    `<col style="width:${cell.getBoundingClientRect().width}px">`).join("");
  floating.innerHTML = `<table class="review-grid" style="width:${grid.getBoundingClientRect().width}px"><colgroup>${columns}</colgroup>${header.outerHTML.replaceAll("data-column=", "data-sticky-column=")}</table>`;
  floating.querySelectorAll("button").forEach(button => { button.tabIndex = -1; });
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
  reviewSelection();
  reviewFocus();
}

function reviewToggleLeader() {
  if (!reviewFinishEdit() || !reviewSheet.rows.length || !reviewDays.length) return;
  const {r1, r2} = reviewBounds(), leader = !reviewSheet.rows.slice(r1, r2 + 1).every(row => row.leader);
  reviewCheckpoint();
  for (let r = r1; r <= r2; r++) reviewSheet.rows[r].leader = leader;
  reviewRender(true);
  reviewChanged();
  reviewFocus();
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
  const {r1, r2, c1, c2} = reviewBounds();
  if (c1 !== c2) { reviewNotice("标记题材或个股名称时，每行请选择一个格子；可以同时选择多行。"); return; }
  reviewCheckpoint();
  for (let r = r1; r <= r2; r++) {
    for (const cell of Object.values(reviewSheet.rows[r].cells)) if (cell.kind === kind) cell.kind = "";
    reviewSetCell(r, c1, {...reviewCell(r, c1), ...reviewKinds[kind]});
  }
  reviewRender(true); reviewChanged(); reviewFocus();
}

function reviewEdit(text, key, r, c) {
  if (text.length > 2000) {
    reviewNotice("每格最多填写 2000 个字符，请分到其他格子中。");
    return false;
  }
  if (reviewEditing !== key) { reviewCheckpoint(); reviewEditing = key; }
  reviewSetCell(r, c, {...reviewCell(r, c), text});
  reviewChanged();
  return true;
}

function reviewFocus() {
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
  if (!cancel && text !== original) reviewEdit(text, `${r}:${c}`, r, c);
  reviewPaintCell(r, c);
  $("review-text").value = reviewCell(r, c).text || "";
  reviewSelection();
  if (reviewDirty && !reviewConflict) { clearTimeout(reviewTimer); reviewTimer = setTimeout(reviewSave, 700); }
  else reviewStatus(reviewConflict ? "版本冲突 · 编辑已保留" : "已保存", reviewConflict ? "error" : "saved");
  return true;
}

function reviewMoveRows(direction) {
  if (!reviewFinishEdit()) return;
  const {r1, r2} = reviewBounds();
  if (r1 + direction < 0 || r2 + direction >= reviewSheet.rows.length) return;
  reviewCheckpoint();
  const rows = reviewSheet.rows.splice(r1, r2 - r1 + 1);
  reviewSheet.rows.splice(r1 + direction, 0, ...rows);
  reviewAnchor.r += direction; reviewEnd.r += direction;
  reviewRender(true); reviewChanged(); reviewFocus();
}

function reviewDeleteRows() {
  if (!reviewFinishEdit() || !reviewSheet.rows.length) return;
  const {r1, r2} = reviewBounds(), rows = reviewSheet.rows.slice(r1, r2 + 1);
  if (rows.some(row => Object.keys(row.cells).length) && !confirm(`删除第 ${r1 + 1} 至 ${r2 + 1} 行及其所有日期的内容？删除后可撤销。`)) return;
  reviewCheckpoint(); reviewSheet.rows.splice(r1, r2 - r1 + 1);
  reviewChanged(); reviewRender(); reviewFocus();
}

function reviewMenuClose(focus = false) {
  $("review-cell-menu").hidden = true;
  if (focus) reviewFocus();
}

function reviewMenuOpen(cell, x, y) {
  if (!reviewFinishEdit()) return;
  const r = +cell.dataset.r, c = +cell.dataset.c, {r1, r2, c1, c2} = reviewBounds();
  if (r < r1 || r > r2 || c < c1 || c > c2) reviewSelect(r, c);
  const menu = $("review-cell-menu");
  menu.querySelector('[data-review-action="leader"]').textContent = $("review-leader").textContent;
  menu.querySelector('[data-review-action="yellow"]').textContent = $("review-yellow").getAttribute("aria-pressed") === "true" ? "恢复字色" : "设为黄字";
  menu.querySelector('[data-review-action="move-up"]').disabled = $("review-row-up").disabled;
  menu.querySelector('[data-review-action="move-down"]').disabled = $("review-row-down").disabled;
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
  const matrix = reviewParseTSV(text), {r1, c1} = reviewBounds();
  const width = Math.max(...matrix.map(row => row.length));
  if (!reviewDays.length || !reviewSheet.rows.length) return;
  if (r1 + matrix.length > 1000 || c1 + width > reviewDays.length || matrix.some(row => row.some(value => value.length > 2000))) {
    reviewNotice("粘贴范围超出表格或文字过长。请先扩展显示日期；最多 1000 行，每格 2000 字。此次未粘贴。");
    return;
  }
  reviewCheckpoint();
  while (reviewSheet.rows.length < r1 + matrix.length) reviewSheet.rows.push(reviewNewRow());
  matrix.forEach((row, r) => row.forEach((value, c) => reviewSetCell(r1 + r, c1 + c,
    {...(copiedCells?.[r]?.[c] || reviewCell(r1 + r, c1 + c)), text: value})));
  reviewChanged();
  reviewRender();
  reviewAnchor = {r: r1, c: c1}; reviewEnd = {r: r1 + matrix.length - 1, c: c1 + width - 1};
  reviewSelection();
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
  if (!reviewFinishEdit()) return;
  if (reviewSaving) { reviewNotice("正在保存，请稍后重新读取。"); return; }
  if (discard && reviewDirty && !confirm("重新读取会放弃本页未保存的编辑，建议先导出备份。确定继续？")) return;
  clearTimeout(reviewTimer);
  const sequence = reviewSequence;
  try {
    const saved = await api("/api/review-sheet");
    if (reviewLoaded && sequence !== reviewSequence) {
      reviewNotice("读取期间又有新的编辑，已保留当前内容。请保存后再重新读取。");
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
  const row = event.target.closest("[data-row]"), column = event.target.closest("[data-column], [data-sticky-column]");
  if (row && reviewDays.length) { reviewSelect(+row.dataset.row, reviewAnchor.c); reviewAnchor.c = 0; reviewEnd.c = reviewDays.length - 1; reviewSelection(); reviewFocus(); }
  if (column && reviewSheet.rows.length) { reviewSelect(0, +(column.dataset.column ?? column.dataset.stickyColumn)); reviewEnd.r = reviewSheet.rows.length - 1; reviewSelection(); }
}
$("review-grid").addEventListener("click", reviewGridClick);
$("review-sticky-head").addEventListener("click", reviewGridClick);
$("review-sticky-head").addEventListener("pointerdown", event => { event.preventDefault(); });
$("review-scroll").addEventListener("scroll", () => { reviewPositionHeader(); reviewMenuClose(); }, {passive: true});
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
    if (reviewFinishEdit()) reviewMove(r + (event.shiftKey ? -1 : 1), c);
  } else if (event.key === "Enter" && event.altKey) {
    if (!editing && cell) reviewStartEdit(cell);
    if (!formula) { event.preventDefault(); document.execCommand("insertText", false, "\n"); }
  } else if (event.key === "Tab") {
    event.preventDefault();
    if (!reviewFinishEdit()) return;
    const index = r * reviewDays.length + c + (event.shiftKey ? -1 : 1);
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
  const {r1, r2, c1, c2} = reviewBounds();
  if (r1 === r2 && c1 === c2 && window.getSelection().toString()) return;
  const quote = value => /[\t\n\r"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const rows = [], cells = [];
  for (let r = r1; r <= r2; r++) {
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
$("review-bold").addEventListener("click", () => reviewFormat({bold: !reviewCell(reviewAnchor.r, reviewAnchor.c).bold}));
$("review-clear-format").addEventListener("click", () => reviewFormat({}, true));
$("review-clear").addEventListener("click", () => reviewFormat({text: ""}));
$("review-undo").addEventListener("click", () => reviewHistory(reviewUndo, reviewRedo));
$("review-redo").addEventListener("click", () => reviewHistory(reviewRedo, reviewUndo));
function reviewAddRow(insert) {
  if (!reviewFinishEdit()) return;
  if (reviewSheet.rows.length >= 1000) { reviewNotice("最多支持 1000 行，请先整理已有记录。"); return; }
  reviewCheckpoint();
  const index = insert ? Math.min(reviewAnchor.r + 1, reviewSheet.rows.length) : reviewSheet.rows.length;
  reviewSheet.rows.splice(index, 0, reviewNewRow());
  reviewAnchor = {r: index, c: reviewAnchor.c};
  reviewChanged(); reviewRender(); reviewMove(index, reviewAnchor.c);
}
$("review-add-row").addEventListener("click", () => reviewAddRow(false));
$("review-insert-row").addEventListener("click", () => reviewAddRow(true));
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
  if (action === "clear") reviewFormat({text: ""});
  if (action === "insert-row") reviewAddRow(true);
  if (action === "move-up") reviewMoveRows(-1);
  if (action === "move-down") reviewMoveRows(1);
  if (action === "delete-row") reviewDeleteRows();
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
  const scroll = $("review-scroll"), latest = scroll.scrollWidth - scroll.clientWidth - scroll.scrollLeft <= 1;
  $("review-controls").parentElement.style.setProperty("--review-zoom", event.target.value);
  if (latest) scroll.scrollLeft = scroll.scrollWidth;
});
$("review-save").addEventListener("click", reviewSave);
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
  if (!reviewLoaded || event.isComposing || !(event.ctrlKey || event.metaKey)) return;
  if (event.key.toLowerCase() === "s") { event.preventDefault(); reviewSave(); }
  if (reviewEditor) return;
  if (event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? reviewHistory(reviewRedo, reviewUndo) : reviewHistory(reviewUndo, reviewRedo); }
  if (event.key.toLowerCase() === "y") { event.preventDefault(); reviewHistory(reviewRedo, reviewUndo); }
});
window.addEventListener("beforeunload", event => { reviewFinishEdit(); if (reviewDirty) { event.preventDefault(); event.returnValue = ""; } });
const reviewResize = new ResizeObserver(() => {
  reviewRefreshHeader();
  const headerHeight = $("review-grid").querySelector("thead")?.getBoundingClientRect().height || 0;
  document.documentElement.style.scrollPaddingTop = `${$("review-controls").getBoundingClientRect().height + headerHeight + 8}px`;
});
["review-controls", "review-scroll", "review-grid"].forEach(id => reviewResize.observe($(id)));
reviewLoad();
