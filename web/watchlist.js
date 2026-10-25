/**
 * 页面 2「自选股」: 卡片式清单, 支持备注与自定义分类 (多对多)。
 *
 * 共用工具在 shared.js, K 线弹窗 (openStockChart) 在 chart.js。
 */

const state = {
  items: [],
  categories: [],
  //: null = 全部, "uncategorized" = 未分类, 数字 = 分类 id
  filter: null,
  //: 正在展开分类选择器的股票代码
  openPicker: null,
  pickerIds: new Set(),
  search: "",
  managing: false,
  savingCategories: false,
  noteDrafts: new Map(),
  noteSaves: new Map(),
  noteSelections: new Map(),
  searchResults: [],
  searchVersion: 0,
  searchTimer: null,
  adding: new Set(),
  savingOrder: false,
  orderDrag: null,
  orderStatus: "",
  removing: new Set(),
  loadVersion: 0,
  dataVersion: 0,
};

const ELEMENT_IDS = [
  "alert-area",
  "watchlist-summary",
  "watchlist-list",
  "watchlist-empty",
  "watchlist-refresh",
  "watchlist-zoom",
  "category-chips",
  "category-create-form",
  "category-name",
  "category-manage",
  "watchlist-title",
  "watchlist-search",
  "watchlist-search-results",
];

const REQUIRED_IDS = ELEMENT_IDS;

function setWatchlistZoom(value) {
  const selected = ["50", "60", "70", "80", "90", "100", "125", "150"].includes(value) ? value : "100";
  el.watchlistZoom.value = selected;
  el.watchlistList.style.setProperty("--watchlist-zoom", Number(selected) / 100);
  try { localStorage.setItem("findstock.watchlist-zoom", selected); } catch {}
}

function pctClass(value) {
  if (value === null || value === undefined || value === 0) return "flat";
  return value > 0 ? "up" : "down";
}

function formatPct(value) {
  if (value === null || value === undefined) return "—";
  return `${value.toFixed(2)}%`;
}

function formatPrice(value) {
  if (value === null || value === undefined) return "—";
  return Number(value).toFixed(2);
}

/* ------------------------------------------------------------------ 渲染 */

function visibleItems() {
  return state.items.filter((item) => {
    const categories = item.categories || [];
    const matchesCategory = state.filter === null ||
      (state.filter === "uncategorized" ? !categories.length :
        categories.some((category) => category.id === state.filter));
    return matchesCategory;
  });
}

function renderCategoryBar() {
  const categoryButton = (value, name, count, selected) =>
    `<button type="button" class="cat-chip${Number.isInteger(Number(value)) ? " cat-chip-custom" : ""}${selected ? " is-on" : ""}" ` +
    `data-category="${value}" aria-pressed="${selected}">` +
    `<span class="cat-name">${escapeHtml(name)}</span><span class="cat-count">${count}</span></button>`;
  const chips = [
    categoryButton("all", "全部自选", state.items.length, state.filter === null),
    categoryButton("uncategorized", "未分类", state.items.filter((item) => !(item.categories || []).length).length,
      state.filter === "uncategorized"),
    `<span class="category-section-label">自定义分类 · ${state.categories.length}</span>`,
  ];
  state.categories.forEach((category) => {
    chips.push(
      `<span class="cat-chip-wrap">` +
        categoryButton(category.id, category.name, category.count, state.filter === category.id) +
        (state.managing ? `<button type="button" class="cat-chip-del" data-delete-category="${category.id}" ` +
        `aria-label="删除分类「${escapeHtml(category.name)}」">删除</button>` : "") +
        `</span>`
    );
  });
  if (!state.categories.length) {
    chips.push(`<span class="cat-empty">创建分类，整理你的观察方向。</span>`);
  }
  el.categoryChips.innerHTML = chips.join("");
}

function renderSummary() {
  const visible = visibleItems().length;
  const filterName =
    state.filter === null
      ? "全部自选"
      : state.filter === "uncategorized" ? "未分类"
      : (state.categories.find((c) => c.id === state.filter) || {}).name;
  el.watchlistTitle.textContent = filterName || "全部自选";
  el.watchlistSummary.textContent = `当前 ${visible} 只 · 全部自选 ${state.items.length} 只` +
    (state.orderStatus ? ` · ${state.orderStatus}` : "");
}

function renderList() {
  const items = visibleItems();
  el.watchlistEmpty.hidden = items.length > 0;
  el.watchlistEmpty.innerHTML = !state.items.length
    ? `<strong>还没有自选股</strong><p>在上方搜索股票名称或代码，即可加入自选。</p>`
    : `<strong>这个分类里还没有股票</strong>` +
      `<p>在上方搜索并添加股票，或在股票卡片上点击「设置分类」。</p>` +
      `<button type="button" class="btn" data-action="reset-filter">查看全部自选</button>`;
  el.watchlistList.innerHTML = items.map(watchCard).join("");
  observeWatchCharts();
  renderSummary();
}

function noteDraft(item) {
  return state.noteDrafts.get(item.code) || {note: item.note || "", note_highlights: item.note_highlights || []};
}

function mergeHighlights(ranges, length) {
  const merged = [];
  ranges.filter(([start, end]) => start >= 0 && end > start && end <= length)
    .sort((a, b) => a[0] - b[0]).forEach(([start, end]) => {
      const previous = merged.at(-1);
      if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
      else merged.push([start, end]);
    });
  return merged;
}

function highlightedNote(note, ranges) {
  const chars = Array.from(note);
  let cursor = 0;
  let markup = "";
  mergeHighlights(ranges, chars.length).forEach(([start, end]) => {
    markup += escapeHtml(chars.slice(cursor, start).join("")) +
      `<mark>${escapeHtml(chars.slice(start, end).join(""))}</mark>`;
    cursor = end;
  });
  return markup + escapeHtml(chars.slice(cursor).join(""));
}

function readNoteEditor(editor, points = []) {
  let note = "", length = 0;
  const ranges = [], positions = [];
  const append = (text, highlighted) => {
    const start = length;
    note += text;
    length += Array.from(text).length;
    if (highlighted && length > start) ranges.push([start, length]);
  };
  const locate = (node, offset) => points.forEach((point, index) => {
    if (point.node === node && point.offset === offset) positions[index] = length;
  });
  function walk(node, highlighted) {
    if (node.nodeType === Node.TEXT_NODE) {
      points.forEach((point, index) => {
        if (point.node === node) positions[index] = length + Array.from(node.textContent.slice(0, point.offset)).length;
      });
      append(node.textContent, highlighted);
      return;
    }
    if (node.nodeName === "BR") {
      if (node.nextSibling) append("\n", highlighted);
      return;
    }
    if (node !== editor && /^(DIV|P)$/.test(node.nodeName) && node.previousSibling) append("\n", highlighted);
    const marked = highlighted || node.nodeName === "MARK";
    Array.from(node.childNodes).forEach((child, index) => { locate(node, index); walk(child, marked); });
    locate(node, node.childNodes.length);
  }
  walk(editor, false);
  return {note, note_highlights: mergeHighlights(ranges, length), positions};
}

function captureNoteSelection(editor) {
  const selection = window.getSelection();
  if (!selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return;
  const draft = readNoteEditor(editor, [
    {node: range.startContainer, offset: range.startOffset}, {node: range.endContainer, offset: range.endOffset},
  ]);
  state.noteSelections.set(editor.closest(".watch-card").dataset.code, draft.positions);
}

function restoreNoteSelection(editor, offsets) {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  const points = [];
  let node, length = 0;
  while ((node = walker.nextNode())) {
    const chars = Array.from(node.textContent);
    offsets.forEach((offset, index) => {
      if (!points[index] && offset <= length + chars.length) points[index] =
        {node, offset: chars.slice(0, Math.max(0, offset - length)).join("").length};
    });
    length += chars.length;
  }
  const range = document.createRange();
  range.setStart(points[0]?.node || editor, points[0]?.offset || 0);
  range.setEnd(points[1]?.node || editor, points[1]?.offset || 0);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function rememberNoteEdit(editor) {
  captureNoteSelection(editor);
  const code = editor.closest(".watch-card").dataset.code;
  editor.noteBeforeEdit = {draft: readNoteEditor(editor), selection: state.noteSelections.get(code) || [0, 0]};
}

function removeHighlights(ranges, start, end) {
  return ranges.flatMap(([a, b]) => b <= start || a >= end ? [[a, b]] :
    [[a, Math.min(b, start)], [Math.max(a, end), b]].filter(([from, to]) => from < to));
}

function cleanNote(draft) {
  const note = draft.note.trim();
  const leading = Array.from(draft.note).length - Array.from(draft.note.trimStart()).length;
  const length = Array.from(note).length;
  return {note, note_highlights: mergeHighlights(draft.note_highlights.map(([start, end]) =>
    [Math.max(0, start - leading), Math.min(length, end - leading)]), length)};
}

async function highlightNote(card, clear) {
  const code = card.dataset.code;
  const editor = card.querySelector("[data-role='note']");
  captureNoteSelection(editor);
  const draft = readNoteEditor(editor);
  const [start, end] = state.noteSelections.get(code) || [0, 0];
  if (!clear && start === end) {
    const status = noteStatus(code);
    if (status) status.textContent = "请先选中文字";
    editor.focus();
    return;
  }
  const covered = draft.note_highlights.some(([a, b]) => a <= start && b >= end);
  const ranges = clear && start === end ? [] : clear || covered ?
    removeHighlights(draft.note_highlights, start, end) :
    mergeHighlights([...draft.note_highlights, [start, end]], Array.from(draft.note).length);
  state.noteDrafts.set(code, {note: draft.note, note_highlights: ranges});
  editor.innerHTML = highlightedNote(draft.note, ranges);
  editor.focus();
  restoreNoteSelection(editor, [start, end]);
  await saveNote(code);
}

function watchCard(item) {
  const assigned = item.categories || [];
  const picker = state.openPicker === item.code ? categoryPicker(item) : "";
  const draft = noteDraft(item);
  const visible = visibleItems();
  const index = visible.findIndex((entry) => entry.code === item.code);
  return (
    `<article class="watch-card" data-code="${escapeHtml(item.code)}" ` +
    `data-name="${escapeHtml(item.name)}">` +
    `<div class="watch-main">` +
    `<div class="watch-line">` +
    `<button type="button" class="star-btn is-on" data-action="remove" ` +
    `title="移出自选股" aria-label="移出自选股">★</button>` +
    `<button type="button" class="watch-name" data-action="chart" title="查看${escapeHtml(item.name)}的K线">${escapeHtml(item.name)}</button>` +
    `<span class="watch-price">${formatPrice(item.latest_close)}</span>` +
    `<span class="${pctClass(item.latest_pct_chg)}">${formatPct(item.latest_pct_chg)}</span>` +
    `</div>` +
    `<div class="watch-meta"><span>${escapeHtml(item.code)} · ${escapeHtml(item.board_label || "")}</span>` +
    `<span>最新 ${escapeHtml(item.latest_date || "本地暂无")}</span></div></div>` +
    `<button type="button" class="watch-mini-chart" data-code="${escapeHtml(item.code)}" ` +
    `data-date="${escapeHtml(item.latest_date || "")}" data-action="chart" aria-label="查看${escapeHtml(item.name)}的K线">日K加载中</button>` +
    // 分类标签用于筛选，修改归属统一在选择器里完成。
    `<div class="watch-categories">` +
    `<span class="watch-label">分类</span>` +
    (assigned.length
      ? assigned
          .map(
            (category) =>
              `<button type="button" class="chip is-on" data-filter-category="${category.id}" ` +
              `title="查看「${escapeHtml(category.name)}」">${escapeHtml(category.name)}</button>`
          )
          .join("")
      : `<span class="chip-empty">未分类</span>`) +
    `<button type="button" class="btn btn-mini" data-action="picker" aria-expanded="${state.openPicker === item.code}">` +
    `设置分类</button></div>` +
    `<div class="watch-note">` +
    `<div class="note-editor"><div class="note-input" data-role="note" contenteditable="true" role="textbox" aria-multiline="true" spellcheck="false" ` +
    `aria-label="${escapeHtml(item.name)}的观察思路" data-placeholder="写下观察思路…">` +
    `${highlightedNote(draft.note, draft.note_highlights)}</div></div></div>` +
    `<div class="watch-card-footer">` +
    `<div class="note-tools" role="group" aria-label="观察思路格式"><button type="button" data-action="highlight-note" title="选中文字，标记或取消黄色高亮（Ctrl+Shift+H）">高亮</button>` +
    `<button type="button" data-action="clear-note-highlights" title="清除选中文字的高亮；没有选区时清除全部">清除高亮</button>` +
    `<span class="note-status" data-role="note-status" role="status">${state.noteDrafts.has(item.code) ? "未保存" : ""}</span></div>` +
    `<span class="watch-reorder" aria-label="调整${escapeHtml(item.name)}的顺序">` +
    `<button type="button" class="watch-move" data-action="move-up" aria-label="上移${escapeHtml(item.name)}" title="上移" ${index === 0 || state.savingOrder ? "disabled" : ""}>↑</button>` +
    `<button type="button" class="watch-drag" data-action="drag" draggable="false" aria-label="拖动${escapeHtml(item.name)}排序" title="拖动排序，松开自动保存" ${state.savingOrder ? "disabled" : ""}>⠿ 拖动</button>` +
    `<button type="button" class="watch-move" data-action="move-down" aria-label="下移${escapeHtml(item.name)}" title="下移" ${index === visible.length - 1 || state.savingOrder ? "disabled" : ""}>↓</button></span>` +
    `</div>` +
    picker +
    `</article>`
  );
}

function categoryPicker(item) {
  const options = state.categories
    .map(
      (category) =>
        `<label class="pick-item"><input type="checkbox" value="${category.id}" ` +
        `${state.pickerIds.has(category.id) ? "checked" : ""}><span>${escapeHtml(category.name)}</span></label>`
    )
    .join("");
  return (
    `<fieldset class="category-picker" data-role="picker" ${state.savingCategories ? "disabled" : ""}>` +
    `<legend>设置${escapeHtml(item.name)}的分类</legend><p class="picker-hint">可多选，保存后生效；取消全部勾选即为未分类。</p>` +
    `<div class="pick-options">${options || `<span class="chip-empty">还没有分类，在下方创建一个。</span>`}</div>` +
    `<div class="pick-create">` +
    `<input type="text" data-role="new-category" maxlength="20" aria-label="新分类名称" placeholder="新分类名称">` +
    `<button type="button" class="btn btn-mini" data-action="create-category">创建并勾选</button>` +
    `</div>` +
    `<p class="picker-error" data-role="picker-error" role="alert" hidden></p>` +
    `<div class="pick-actions"><span>已选 <b data-role="picked-count">${state.pickerIds.size}</b> 个分类</span>` +
    `<button type="button" class="btn" data-action="cancel-picker">取消</button>` +
    `<button type="button" class="btn btn-primary" data-action="save-categories">${state.savingCategories ? "保存中…" : "保存分类"}</button></div>` +
    `</fieldset>`
  );
}

/* ------------------------------------------------------------------ 数据 */

function renderSearchResults(message = "") {
  el.watchlistSearchResults.hidden = !state.search.trim();
  if (el.watchlistSearchResults.hidden) return;
  const watched = new Set(state.items.map((item) => item.code));
  el.watchlistSearchResults.innerHTML = message ||
    (state.searchResults.length ? `<p class="watch-search-status" role="status">找到 ${state.searchResults.length} 只股票，最多显示 20 条</p>` +
      state.searchResults.map((item) => {
        const added = watched.has(item.code), busy = state.adding.has(item.code);
        return `<div class="watch-search-row"><span><strong>${escapeHtml(item.name)}</strong>` +
          `<small>${escapeHtml(item.code)} · ${escapeHtml(item.board_label || "")}</small></span>` +
          `<button type="button" class="btn btn-mini${added ? "" : " btn-primary"}" data-add-code="${escapeHtml(item.code)}" ` +
          `${added || busy || state.savingOrder ? "disabled" : ""}>${added ? "已在自选" : busy ? "加入中…" : "加入自选"}</button></div>`;
      }).join("") : `<p class="watch-search-status" role="status">未找到股票，请核对名称或代码；可到数据页面更新全市场股票名录。</p>`);
}

async function searchMarket() {
  const query = state.search.trim(), version = ++state.searchVersion;
  state.searchResults = [];
  renderSearchResults(`<p class="watch-search-status" role="status">正在搜索全市场…</p>`);
  if (!query) return;
  try {
    const results = await api(`/api/stocks/search?q=${encodeURIComponent(query)}&limit=20`);
    if (version !== state.searchVersion) return;
    state.searchResults = results;
    renderSearchResults();
  } catch (error) {
    if (version !== state.searchVersion) return;
    renderSearchResults(`<p class="watch-search-status" role="alert">搜索失败：${escapeHtml(error.message)}</p>` +
      `<button type="button" class="btn btn-mini" data-action="retry-search">重试搜索</button>`);
  }
}

async function addSearchStock(code) {
  if (state.adding.has(code) || state.savingOrder || state.savingCategories || state.items.some((item) => item.code === code)) return;
  const stock = state.searchResults.find((item) => item.code === code);
  if (!stock) return;
  state.adding.add(code);
  renderSearchResults();
  try {
    await api("/api/watchlist", {method: "POST", body: JSON.stringify({code, name: stock.name,
      category_ids: typeof state.filter === "number" ? [state.filter] : []})});
    await loadWatchlist();
    showAlert("ok", `${escapeHtml(stock.name)} 已加入自选股。`);
  } catch (error) {
    showAlert("error", `加入失败：${escapeHtml(error.message)}`);
  } finally {
    state.adding.delete(code);
    renderSearchResults();
  }
}

function startOrderDrag(event) {
  const handle = event.target.closest("[data-action='drag']");
  if (!handle || event.button !== 0 || state.orderDrag || state.savingOrder ||
      state.savingCategories || state.openPicker || state.adding.size || state.removing.size) return;
  event.preventDefault();
  handle.focus({preventScroll: true});
  handle.setPointerCapture(event.pointerId);
  state.orderDrag = {handle, card: handle.closest(".watch-card"), id: event.pointerId,
    startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, moved: false};
}

function updateOrderDrop() {
  const drag = state.orderDrag;
  const previous = drag.target, previousAfter = drag.after;
  el.watchlistList.querySelectorAll(".is-drop-before, .is-drop-after").forEach((card) =>
    card.classList.remove("is-drop-before", "is-drop-after"));
  drag.target = null;
  const hit = document.elementFromPoint(drag.x, drag.y);
  let card = hit?.closest(".watch-card");
  if (!card && hit === el.watchlistList) {
    let nearest = 16;
    el.watchlistList.querySelectorAll(".watch-card").forEach((candidate) => {
      if (candidate === drag.card) return;
      const bounds = candidate.getBoundingClientRect();
      const distance = Math.hypot(Math.max(bounds.left - drag.x, 0, drag.x - bounds.right),
        Math.max(bounds.top - drag.y, 0, drag.y - bounds.bottom));
      if (distance < nearest) { card = candidate; nearest = distance; }
    });
  }
  if (card && el.watchlistList.contains(card) && card !== drag.card) {
    const bounds = card.getBoundingClientRect();
    drag.target = card.dataset.code;
    drag.after = drag.y > bounds.top + bounds.height / 2;
    card.classList.add(drag.after ? "is-drop-after" : "is-drop-before");
  }
  if (drag.target !== previous || drag.after !== previousAfter) {
    state.orderStatus = drag.target
      ? `移到「${card.dataset.name}」${drag.after ? "后面" : "前面"}，松开保存 · Esc 取消`
      : "拖到目标卡片或旁边的空隙，绿色标记处松开 · Esc 取消";
    renderSummary();
  }
}

function scrollOrderDrag() {
  const drag = state.orderDrag;
  if (!drag?.moved) return;
  const edge = 48;
  const delta = drag.y < edge ? -14 : drag.y > innerHeight - edge ? 14 : 0;
  if (delta) window.scrollBy(0, delta);
  updateOrderDrop();
  drag.frame = requestAnimationFrame(scrollOrderDrag);
}

function moveOrderDrag(event) {
  const drag = state.orderDrag;
  if (!drag || drag.id !== event.pointerId) return;
  drag.x = event.clientX;
  drag.y = event.clientY;
  if (!drag.moved && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= 6) {
    drag.moved = true;
    drag.card.classList.add("is-dragging");
    el.watchlistList.classList.add("is-order-dragging");
    state.orderStatus = "拖到目标卡片或旁边的空隙，绿色标记处松开 · Esc 取消";
    renderSummary();
    scrollOrderDrag();
  }
  if (drag.moved) {
    event.preventDefault();
    updateOrderDrop();
  }
}

function finishOrderDrag(event, cancel = false) {
  const drag = state.orderDrag;
  if (!drag || (event?.pointerId !== undefined && event.pointerId !== drag.id)) return;
  if (drag.moved && !cancel) updateOrderDrop();
  state.orderDrag = null;
  el.watchlistList.classList.remove("is-order-dragging");
  cancelAnimationFrame(drag.frame);
  if (drag.handle.hasPointerCapture(drag.id)) drag.handle.releasePointerCapture(drag.id);
  el.watchlistList.querySelectorAll(".is-dragging, .is-drop-before, .is-drop-after").forEach((card) =>
    card.classList.remove("is-dragging", "is-drop-before", "is-drop-after"));
  if (drag.moved) {
    state.orderStatus = "";
    renderSummary();
    if (!cancel && drag.target) reorderStock(drag.card.dataset.code, drag.target, drag.after);
  }
}

async function reorderStock(code, targetCode, after = false) {
  if (state.savingOrder || state.savingCategories || state.adding.size || state.removing.size || code === targetCode) return;
  const visible = visibleItems().map((item) => item.code);
  if (!visible.includes(code) || !visible.includes(targetCode)) return;
  const ordered = visible.filter((value) => value !== code);
  ordered.splice(ordered.indexOf(targetCode) + Number(after), 0, code);
  if (ordered.every((value, index) => value === visible[index])) return;
  const included = new Set(visible), byCode = new Map(state.items.map((item) => [item.code, item]));
  const previous = state.items;
  let position = 0;
  state.items = previous.map((item) => included.has(item.code) ? byCode.get(ordered[position++]) : item);
  state.savingOrder = true;
  state.orderStatus = "正在保存顺序…";
  state.openPicker = null;
  renderList();
  renderSearchResults();
  try {
    await api("/api/watchlist/order", {method: "PUT", body: JSON.stringify({codes: state.items.map((item) => item.code)})});
    state.dataVersion++;
    state.orderStatus = "顺序已保存";
  } catch (error) {
    state.items = previous;
    state.orderStatus = "排序未保存，已恢复原顺序";
    showAlert("error", `排序保存失败，已恢复原顺序：${escapeHtml(error.message)}`);
  } finally {
    state.savingOrder = false;
    renderList();
    renderSearchResults();
    el.watchlistList.querySelector(`.watch-card[data-code="${code}"] [data-action='drag']`)?.focus();
  }
}

async function loadWatchlist() {
  const version = ++state.loadVersion, dataVersion = state.dataVersion;
  try {
    const payload = await api("/api/watchlist");
    if (version !== state.loadVersion || state.savingOrder) return;
    if (dataVersion !== state.dataVersion) return loadWatchlist();
    state.items = payload.items || [];
    state.categories = payload.categories || [];
    if (typeof state.filter === "number" && !state.categories.some((c) => c.id === state.filter)) state.filter = null;
    renderCategoryBar();
    renderList();
    renderSearchResults();
  } catch (error) {
    showAlert("error", `读取自选股失败: ${escapeHtml(error.message)}`);
  }
}

async function removeFromWatchlist(code, name) {
  if (state.removing.has(code) || state.savingOrder) return;
  state.removing.add(code);
  try {
    await api(`/api/watchlist/${encodeURIComponent(code)}`, { method: "DELETE" });
    state.dataVersion++;
    state.noteDrafts.delete(code);
    showAlert("ok", `${escapeHtml(name || code)} 已移出自选股。`);
    await loadWatchlist();
  } catch (error) {
    showAlert("error", `移除失败: ${escapeHtml(error.message)}`);
  } finally {
    state.removing.delete(code);
  }
}

async function saveNote(code) {
  if (state.noteSaves.has(code)) return state.noteSaves.get(code);
  if (!state.noteDrafts.has(code)) return;
  const pending = (async () => {
    try {
      // 同一只股票顺序保存，避免较慢的旧请求覆盖刚写下的思路。
      while (state.noteDrafts.has(code)) {
        const draft = state.noteDrafts.get(code);
        const snapshot = JSON.stringify(draft);
        const status = noteStatus(code);
        if (status) status.textContent = "保存中…";
        const item = await api(`/api/watchlist/${encodeURIComponent(code)}`, {
          method: "PATCH", body: JSON.stringify(cleanNote(draft)),
        });
        state.dataVersion++;
        const local = state.items.find((entry) => entry.code === code);
        if (!local) break;
        local.note = item.note;
        local.note_highlights = item.note_highlights || [];
        if (JSON.stringify(state.noteDrafts.get(code)) === snapshot) {
          state.noteDrafts.delete(code);
        }
      }
      const status = noteStatus(code);
      if (status) status.textContent = "已保存";
    } catch (error) {
      const status = noteStatus(code);
      if (status) status.textContent = "保存失败，移开焦点可重试";
      showAlert("error", `备注保存失败: ${escapeHtml(error.message)}`);
    } finally {
      state.noteSaves.delete(code);
    }
  })();
  state.noteSaves.set(code, pending);
  return pending;
}

function noteStatus(code) {
  const card = el.watchlistList.querySelector(`.watch-card[data-code="${code}"]`);
  return card ? card.querySelector("[data-role='note-status']") : null;
}

/** 覆盖式更新某只股票的分类。 */
async function setCategories(code, categoryIds) {
  if (state.savingCategories) return;
  state.savingCategories = true;
  el.watchlistSearch.disabled = true;
  const picker = el.watchlistList.querySelector("[data-role='picker']");
  if (picker) {
    picker.disabled = true;
    picker.querySelector("[data-role='picker-error']").hidden = true;
    picker.querySelector("[data-action='save-categories']").textContent = "保存中…";
  }
  try {
    const updated = await api(`/api/watchlist/${encodeURIComponent(code)}`, {
      method: "PATCH",
      body: JSON.stringify({ category_ids: categoryIds }),
    });
    state.dataVersion++;
    const item = state.items.find((entry) => entry.code === code);
    if (item) item.categories = updated.categories;
    state.categories.forEach((category) => {
      category.count = state.items.filter((entry) => (entry.categories || []).some((c) => c.id === category.id)).length;
    });
    state.openPicker = null;
    renderCategoryBar();
    renderList();
    focusPickerButton(code);
    el.watchlistSummary.textContent += " · 分类已保存";
  } catch (error) {
    if (picker && picker.isConnected) {
      const feedback = picker.querySelector("[data-role='picker-error']");
      feedback.textContent = `保存失败：${error.message}。勾选已保留，请重试。`;
      feedback.hidden = false;
    } else showAlert("error", `分类更新失败: ${escapeHtml(error.message)}`);
  } finally {
    state.savingCategories = false;
    el.watchlistSearch.disabled = false;
    if (picker && picker.isConnected) {
      picker.disabled = false;
      picker.querySelector("[data-action='save-categories']").textContent = "保存分类";
    }
  }
}

async function createCategory(name) {
  const cleaned = String(name || "").trim();
  if (!cleaned) {
    showAlert("warn", "分类名称不能为空。");
    return null;
  }
  try {
    const category = await api("/api/watchlist/categories", {
      method: "POST",
      body: JSON.stringify({ name: cleaned }),
    });
    state.dataVersion++;
    return category;
  } catch (error) {
    showAlert("error", `新建分类失败: ${escapeHtml(error.message)}`);
    return null;
  }
}

async function deleteCategory(categoryId) {
  if (state.savingCategories || state.savingOrder) return;
  const category = state.categories.find((item) => item.id === categoryId);
  const label = category ? category.name : String(categoryId);
  if (!window.confirm(`删除分类「${label}」? 股票本身不会被删除。`)) return;
  state.savingCategories = true;
  el.watchlistSearch.disabled = true;
  try {
    await api(`/api/watchlist/categories/${categoryId}`, { method: "DELETE" });
    state.dataVersion++;
    state.openPicker = null;
    if (state.filter === categoryId) state.filter = null;
    showAlert("ok", `分类「${escapeHtml(label)}」已删除。`);
    await loadWatchlist();
  } catch (error) {
    showAlert("error", `删除分类失败: ${escapeHtml(error.message)}`);
  } finally {
    state.savingCategories = false;
    el.watchlistSearch.disabled = false;
  }
}

/* ------------------------------------------------------------------ 事件 */

function focusPickerButton(code) {
  const card = el.watchlistList.querySelector(`.watch-card[data-code="${code}"]`);
  if (card) card.querySelector("[data-action='picker']").focus();
  else el.watchlistTitle.focus();
}

function closePicker() {
  const code = state.openPicker;
  state.openPicker = null;
  renderList();
  if (code) focusPickerButton(code);
}

function currentCategoryIds(code) {
  const item = state.items.find((entry) => entry.code === code);
  return new Set((item && item.categories ? item.categories : []).map((c) => c.id));
}

async function onListClick(event) {
  if (state.savingCategories || state.savingOrder) return;
  const card = event.target.closest(".watch-card");
  if (!card) return;
  const code = card.dataset.code;

  const action = event.target.closest("[data-action]");
  if (action && ["highlight-note", "clear-note-highlights"].includes(action.dataset.action)) {
    await highlightNote(card, action.dataset.action === "clear-note-highlights");
    return;
  }
  if (action && ["move-up", "move-down", "drag"].includes(action.dataset.action)) {
    const items = visibleItems(), index = items.findIndex((item) => item.code === code);
    const down = action.dataset.action === "move-down";
    if (action.dataset.action !== "drag" && items[index + (down ? 1 : -1)]) {
      await reorderStock(code, items[index + (down ? 1 : -1)].code, down);
    }
    return;
  }
  if (action && action.dataset.action === "remove") {
    event.stopPropagation();
    await removeFromWatchlist(code, card.dataset.name);
    return;
  }
  if (action && action.dataset.action === "chart") {
    openChartFor(code, card.dataset.name);
    return;
  }
  if (action && action.dataset.action === "picker") {
    state.openPicker = state.openPicker === code ? null : code;
    state.pickerIds = currentCategoryIds(code);
    renderList();
    if (state.openPicker) {
      const picker = el.watchlistList.querySelector("[data-role='picker']");
      picker.querySelector("input").focus();
    } else focusPickerButton(code);
    return;
  }
  if (action && action.dataset.action === "cancel-picker") {
    closePicker();
    return;
  }
  if (action && action.dataset.action === "save-categories") {
    await setCategories(code, [...state.pickerIds]);
    return;
  }
  if (action && action.dataset.action === "create-category") {
    const input = card.querySelector("[data-role='new-category']");
    const picker = card.querySelector("[data-role='picker']");
    state.savingCategories = true;
    el.watchlistSearch.disabled = true;
    picker.disabled = true;
    const created = await createCategory(input ? input.value : "");
    state.savingCategories = false;
    el.watchlistSearch.disabled = false;
    picker.disabled = false;
    if (!created) return;
    if (!state.categories.some((c) => c.id === created.id)) state.categories.push(created);
    state.pickerIds.add(created.id);
    renderCategoryBar();
    renderList();
    const newInput = el.watchlistList.querySelector("[data-role='new-category']");
    if (newInput) newInput.focus();
    return;
  }
  const categoryChip = event.target.closest("[data-filter-category]");
  if (categoryChip) {
    state.filter = Number(categoryChip.dataset.filterCategory);
    state.openPicker = null;
    renderCategoryBar();
    renderList();
    el.watchlistTitle.focus();
    return;
  }
}

function openChartFor(code, name) {
  openStockChart(code, {
    name,
    // 自选股里记录着"加入时的来源筛选日", 就作为选出日显示
    sourceDate: (state.items.find((item) => item.code === code) || {}).source_date || null,
    // ← / → 在当前(筛选后的)清单里切换
    list: visibleItems().map((item) => ({
      code: item.code,
      name: item.name,
      date: item.source_date || null,
    })),
    onWatchChange: () => loadWatchlist(),
  });
}

function onListChange(event) {
  const card = event.target.closest(".watch-card");
  if (!card) return;
  const checkbox = event.target.closest(".category-picker input[type='checkbox']");
  if (!checkbox) return;
  const value = Number(checkbox.value);
  if (checkbox.checked) state.pickerIds.add(value);
  else state.pickerIds.delete(value);
  card.querySelector("[data-role='picked-count']").textContent = state.pickerIds.size;
}

function onListInput(event) {
  const editor = event.target.closest("[data-role='note']");
  if (!editor || event.isComposing) return;
  const card = editor.closest(".watch-card");
  const draft = readNoteEditor(editor);
  if (Array.from(draft.note).length > 500) {
    const previous = editor.noteBeforeEdit || {draft: noteDraft(state.items.find((item) => item.code === card.dataset.code)), selection: [0, 0]};
    editor.innerHTML = highlightedNote(previous.draft.note, previous.draft.note_highlights);
    restoreNoteSelection(editor, previous.selection);
    const status = card.querySelector("[data-role='note-status']");
    if (status) status.textContent = "最多500字，本次输入未加入";
    return;
  }
  editor.noteBeforeEdit = null;
  state.noteDrafts.set(card.dataset.code, {note: draft.note, note_highlights: draft.note_highlights});
  captureNoteSelection(editor);
  const status = card.querySelector("[data-role='note-status']");
  if (status) status.textContent = "未保存";
}

function onListFocusOut(event) {
  const editor = event.target.closest("[data-role='note']");
  if (!editor) return;
  captureNoteSelection(editor);
  const card = editor.closest(".watch-card");
  const code = card.dataset.code;
  saveNote(code);
}

function onListKeydown(event) {
  if (event.key === "Escape" && state.openPicker && !state.savingCategories) {
    event.preventDefault();
    closePicker();
    return;
  }
  if (event.key === "Enter" && !event.isComposing && event.target.matches("[data-role='new-category']")) {
    event.preventDefault();
    event.target.closest(".pick-create").querySelector("button").click();
    return;
  }
  const editor = event.target.closest("[data-role='note']");
  if (!editor || event.isComposing) return;
  if (event.key.toLowerCase() === "h" && (event.ctrlKey || event.metaKey) && event.shiftKey) {
    event.preventDefault();
    highlightNote(editor.closest(".watch-card"), false);
  }
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    editor.blur(); // 失焦即保存
  }
}

function onCategoryBarClick(event) {
  if (state.savingCategories) return;
  const del = event.target.closest("[data-delete-category]");
  if (del) {
    deleteCategory(Number(del.dataset.deleteCategory));
    return;
  }
  const chip = event.target.closest("[data-category]");
  if (!chip) return;
  const value = chip.dataset.category;
  state.filter = value === "all" ? null : value === "uncategorized" ? value : Number(value);
  state.openPicker = null;
  renderCategoryBar();
  renderList();
  el.categoryChips.querySelector(`[data-category="${value}"]`).focus();
}

function bindEvents() {
  el.watchlistZoom.addEventListener("change", () => {
    finishOrderDrag(null, true);
    setWatchlistZoom(el.watchlistZoom.value);
  });
  el.watchlistRefresh.addEventListener("click", async () => {
    if (state.savingCategories || state.savingOrder) return;
    el.watchlistRefresh.disabled = true;
    el.watchlistRefresh.textContent = "刷新中…";
    state.openPicker = null;
    clearWatchCharts();
    await loadWatchlist();
    el.watchlistRefresh.disabled = false;
    el.watchlistRefresh.textContent = "刷新";
  });
  el.categoryManage.addEventListener("click", () => {
    state.managing = !state.managing;
    el.categoryManage.setAttribute("aria-pressed", String(state.managing));
    el.categoryManage.textContent = state.managing ? "完成" : "管理";
    renderCategoryBar();
  });
  el.watchlistSearch.addEventListener("input", () => {
    if (state.savingCategories) return;
    state.search = el.watchlistSearch.value;
    state.searchVersion++;
    clearTimeout(state.searchTimer);
    state.searchResults = [];
    renderSearchResults(`<p class="watch-search-status" role="status">正在搜索全市场…</p>`);
    state.searchTimer = setTimeout(searchMarket, 200);
  });
  el.watchlistSearch.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      state.search = el.watchlistSearch.value = "";
      state.searchVersion++;
      clearTimeout(state.searchTimer);
      renderSearchResults();
    }
  });
  el.watchlistSearchResults.addEventListener("click", (event) => {
    const add = event.target.closest("[data-add-code]");
    if (add) addSearchStock(add.dataset.addCode);
    if (event.target.closest("[data-action='retry-search']")) searchMarket();
  });
  el.watchlistEmpty.addEventListener("click", (event) => {
    if (!event.target.closest("[data-action='reset-filter']")) return;
    state.filter = null;
    renderCategoryBar();
    renderList();
    el.watchlistSearch.focus();
  });
  el.categoryChips.addEventListener("click", onCategoryBarClick);
  el.categoryCreateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.savingCategories) return;
    state.savingCategories = true;
    el.watchlistSearch.disabled = true;
    const button = el.categoryCreateForm.querySelector("button");
    button.disabled = true;
    const created = await createCategory(el.categoryName.value);
    state.savingCategories = false;
    el.watchlistSearch.disabled = false;
    button.disabled = false;
    if (!created) return;
    el.categoryName.value = "";
    showAlert("ok", `分类「${escapeHtml(created.name)}」已创建。`);
    if (!state.categories.some((c) => c.id === created.id)) state.categories.push(created);
    renderCategoryBar();
    renderSummary();
    if (state.openPicker) renderList();
    el.categoryName.focus();
  });

  el.watchlistList.addEventListener("click", onListClick);
  el.watchlistList.addEventListener("change", onListChange);
  el.watchlistList.addEventListener("input", onListInput);
  el.watchlistList.addEventListener("compositionstart", (event) => {
    const editor = event.target.closest("[data-role='note']");
    if (editor) rememberNoteEdit(editor);
  });
  el.watchlistList.addEventListener("compositionend", onListInput);
  el.watchlistList.addEventListener("beforeinput", (event) => {
    const editor = event.target.closest("[data-role='note']");
    if (!editor || event.isComposing) return;
    rememberNoteEdit(editor);
    const selected = editor.noteBeforeEdit.selection;
    const inserted = ["insertParagraph", "insertLineBreak"].includes(event.inputType) ? "\n" : event.data || "";
    if (event.inputType.startsWith("insert") && Array.from(editor.noteBeforeEdit.draft.note).length +
      Array.from(inserted).length - selected[1] + selected[0] > 500) {
      event.preventDefault();
      const status = noteStatus(editor.closest(".watch-card").dataset.code);
      if (status) status.textContent = "最多500字，请先删减内容";
      return;
    }
    if (["insertParagraph", "insertLineBreak"].includes(event.inputType)) {
      event.preventDefault();
      document.execCommand("insertLineBreak");
    }
    if (["formatBold", "formatItalic", "formatUnderline"].includes(event.inputType)) event.preventDefault();
  });
  el.watchlistList.addEventListener("paste", (event) => {
    const editor = event.target.closest("[data-role='note']");
    if (!editor) return;
    event.preventDefault();
    captureNoteSelection(editor);
    const selection = state.noteSelections.get(editor.closest(".watch-card").dataset.code) || [0, 0];
    const available = 500 - Array.from(readNoteEditor(editor).note).length + selection[1] - selection[0];
    const pasted = Array.from(event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n"));
    document.execCommand("insertText", false, pasted.slice(0, Math.max(0, available)).join(""));
  });
  el.watchlistList.addEventListener("drop", (event) => {
    const editor = event.target.closest("[data-role='note']");
    if (!editor) return;
    event.preventDefault();
    event.stopPropagation();
    const status = noteStatus(editor.closest(".watch-card").dataset.code);
    if (status) status.textContent = "请粘贴纯文字内容";
  });
  el.watchlistList.addEventListener("focusout", onListFocusOut);
  el.watchlistList.addEventListener("keydown", onListKeydown);
  el.watchlistList.addEventListener("pointerdown", (event) => {
    if (event.target.closest("[data-action='highlight-note'], [data-action='clear-note-highlights']")) event.preventDefault();
  });
  document.addEventListener("selectionchange", () => {
    const editor = document.activeElement?.closest("[data-role='note']");
    if (editor) captureNoteSelection(editor);
  });
  el.watchlistList.addEventListener("pointerdown", startOrderDrag);
  document.addEventListener("pointermove", moveOrderDrag, {passive: false});
  document.addEventListener("pointerup", finishOrderDrag);
  document.addEventListener("pointercancel", (event) => finishOrderDrag(event, true));
  el.watchlistList.addEventListener("lostpointercapture", (event) => finishOrderDrag(event, true));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.orderDrag) {
      event.preventDefault();
      finishOrderDrag(null, true);
    }
  });
  window.addEventListener("blur", () => finishOrderDrag(null, true));
}

async function initWatchlist() {
  const missing = bindElements(ELEMENT_IDS, REQUIRED_IDS);
  if (missing.length) {
    reportFatal(
      `页面与脚本版本不一致 (缺少 ${missing.join(", ")})。` +
        "请强刷新页面 (Ctrl+F5, 或 Ctrl+Shift+R) 重新加载。"
    );
    return;
  }
  bindEvents();
  let zoom = "100";
  try { zoom = localStorage.getItem("findstock.watchlist-zoom") || zoom; } catch {}
  setWatchlistZoom(zoom);
  await loadWatchlist();
}

boot(initWatchlist);
