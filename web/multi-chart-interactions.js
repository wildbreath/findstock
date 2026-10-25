/* 同列图按股票保存视窗与光标；复用 chart.js 的绘图，不使用弹窗的全局 chartState。 */
const MULTI_MARKER_KEY = "findstock.multi-chart.markers.v1";
const MULTI_NODE_COLORS = ["#2563eb", "#9333ea", "#0d766e", "#a86400"];

function multiCard(code) {
  return $("multi-grid").querySelector(`.multi-card[data-code="${code}"]`);
}

function multiChartView(code) {
  if (!multiState.views.has(code)) {
    const count = Math.min(Number($("multi-period").value), multiState.dates.length);
    multiState.views.set(code, {start: Math.max(0, multiState.dates.length - count), count,
      cursor: null, locked: false, marking: false, drag: null, layout: null});
  }
  return multiState.views.get(code);
}

function clampMultiView(view) {
  const total = multiState.dates.length;
  view.count = Math.min(total, Math.max(Math.min(20, total), view.count));
  view.start = Math.max(0, Math.min(view.start, total - view.count));
}

function zoomMultiView(view, total, factor, ratio = .5) {
  const count = Math.min(total, Math.max(Math.min(20, total), Math.round(view.count * factor)));
  const anchor = view.start + ratio * Math.max(0, view.count - 1);
  view.start = Math.max(0, Math.min(Math.round(anchor - ratio * Math.max(0, count - 1)), total - count));
  view.count = count;
}

function validMultiMarkerDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + "T00:00:00Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function restoreMultiMarkers() {
  try {
    const saved = JSON.parse(localStorage.getItem(MULTI_MARKER_KEY) || "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
    for (const [code, nodes] of Object.entries(saved)) {
      if (!/^(sh|sz)\.\d{6}$/.test(code) || !Array.isArray(nodes)) continue;
      const dates = new Set(), labels = new Set();
      multiState.markers[code] = nodes.filter((node) => {
        if (!node || !validMultiMarkerDate(node.date) || !/^T\d{1,4}$/.test(node.label) ||
            dates.has(node.date) || labels.has(node.label)) return false;
        dates.add(node.date); labels.add(node.label); return true;
      }).map(({date, label}) => ({date, label}));
    }
  } catch (error) {
    showAlert("warn", "节点记录读取失败，已有股票选择仍可使用。");
  }
}

function saveMultiMarkers() {
  try {
    localStorage.setItem(MULTI_MARKER_KEY, JSON.stringify(multiState.markers));
  } catch (error) {
    showAlert("warn", "浏览器未允许保存节点，本次仍可使用，刷新后可能丢失。");
  }
}

async function fetchMultiHistory(code, signal) {
  let end = multiState.end, payload = null;
  const bars = new Map();
  // 服务端单次上限 400 根，按需分页读取本地覆盖区间，避免旧日期被误画成缺失。
  while (end >= multiState.dates[0]) {
    let page;
    try {
      page = await api(`/api/stocks/${code}/chart?limit=400&end=${end}`, {signal});
    } catch (error) {
      if (payload && error.code === "stock_not_found") break;
      throw error;
    }
    if (!payload) payload = page;
    const batch = (page.bars || []).filter((bar) => bar.trade_date <= end);
    batch.forEach((bar) => bars.set(bar.trade_date, bar));
    if (batch.length < 400 || batch[0].trade_date <= multiState.dates[0]) break;
    end = shiftIsoDate(batch[0].trade_date, -1);
  }
  return {...payload, bars: [...bars.values()].sort((a, b) => a.trade_date.localeCompare(b.trade_date))};
}

function multiChartControls(item) {
  return `<div class="multi-node-tools" aria-label="${escapeHtml(item.name)}节点操作"><button type="button" class="btn btn-mini" data-view-action="mark" aria-pressed="false">标记节点</button>` +
    `<button type="button" class="btn btn-mini" data-view-action="unlock" disabled>光标未固定</button>` +
    `<button type="button" class="btn btn-mini" data-view-action="clear-nodes" disabled>清空节点</button></div>`;
}

function updateMultiControls(code, card, dates) {
  const view = multiChartView(code), nodes = multiState.markers[code] || [];
  const mark = card.querySelector('[data-view-action="mark"]');
  mark.setAttribute("aria-pressed", String(view.marking));
  mark.textContent = view.marking ? "标记中 · 点击 K 线" : "标记节点";
  const unlock = card.querySelector('[data-view-action="unlock"]');
  unlock.disabled = !view.locked;
  unlock.textContent = view.locked ? "解除光标固定" : "光标未固定";
  card.querySelector('[data-view-action="clear-nodes"]').disabled = !nodes.length;
  card.querySelector(".multi-chart-body").classList.toggle("is-marking", view.marking);
  card.querySelector(".multi-view-range").textContent = `${dates[0]} 至 ${dates.at(-1)} · ${dates.length} 个交易日 · 独立视窗`;
  card.querySelector(".multi-node-list").innerHTML = nodes.map((node, index) =>
    `<span class="multi-node-chip" style="--node-color:${MULTI_NODE_COLORS[index % MULTI_NODE_COLORS.length]}">` +
    `<button type="button" data-node-date="${node.date}" title="定位 ${node.date}">${node.label} <time>${node.date}</time></button>` +
    `<button type="button" data-node-remove="${node.date}" aria-label="删除 ${node.label} ${node.date} 节点">×</button></span>`
  ).join("") || '<span class="multi-node-empty">暂无节点，开启标记后点击 K 线</span>';
}

function renderMultiMarkers(code, layout) {
  return (multiState.markers[code] || []).map((node, position) => {
    const index = layout.bars.findIndex((bar) => bar.trade_date === node.date);
    if (index < 0) return "";
    const x = layout.xOf(index), y = layout.geometry.priceTop + 13 + position % 2 * 16;
    const color = MULTI_NODE_COLORS[position % MULTI_NODE_COLORS.length];
    return `<g class="multi-marker" data-marker="${node.label}" style="color:${color}">` +
      `<title>${node.label} ${node.date}</title><line x1="${x}" x2="${x}" y1="${layout.geometry.priceTop}" y2="${layout.geometry.volumeBottom}"/>` +
      `<text x="${Math.max(14, Math.min(x, layout.plotRight - 14))}" y="${y}" text-anchor="middle">${node.label}</text></g>`;
  }).join("");
}

function paintMultiFocus(code) {
  const card = multiCard(code), view = multiChartView(code), layout = view.layout;
  if (!card || !layout) return;
  const index = layout.bars.findIndex((entry) => entry.trade_date === view.cursor);
  const bar = view.cursor ? multiState.cache.get(code)?.payload?.bars.find((entry) => entry.trade_date === view.cursor) ||
    {trade_date: view.cursor, close: null, ma: {}} : layout.bars.at(-1);
  const group = card.querySelector(".multi-crosshair");
  if (group) {
    group.innerHTML = "";
    if (index >= 0) {
      const x = layout.xOf(index), y = bar.close == null ? null : layout.yOf(bar.close);
      const tagX = Math.max(0, Math.min(x - 40, layout.plotRight - 80));
      group.innerHTML = `<line class="cross-v" x1="${x}" x2="${x}" y1="${layout.geometry.priceTop}" y2="${layout.geometry.volumeBottom}"/>` +
        (y == null ? "" : `<line class="cross-h" x1="${layout.plotLeft}" x2="${layout.plotRight}" y1="${y}" y2="${y}"/><circle cx="${x}" cy="${y}" r="3"/>`) +
        `<rect x="${tagX}" y="${layout.geometry.axisY - 14}" width="80" height="20" rx="3"/>` +
        `<text x="${tagX + 40}" y="${layout.geometry.axisY}" text-anchor="middle">${bar.trade_date}</text>`;
    }
  }
  card.querySelector(".multi-readout").innerHTML = `<div><strong>${bar.trade_date}</strong><span>${view.locked ? `光标已固定${index < 0 ? " · 在当前视窗外" : ""}` : "移动查看 · 点击固定"}</span></div>` +
    (bar.close == null ? '<p>本日无本地行情（停牌、上市前或数据缺失）</p>' :
      `<p>开 ${nm(bar.open)}　高 ${nm(bar.high)}　低 ${nm(bar.low)}　收 ${nm(bar.close)}　` +
      `涨跌 ${nm(bar.pct_chg)}%　量 ${formatVolume(bar.volume)}</p>`) +
    `<p class="multi-ma-readout">${Object.entries(bar.ma || {}).map(([period, value]) => `<span style="color:${MA_COLORS[period] || '#64748b'}">MA${period} ${nm(value)}</span>`).join("")}</p>`;
}

function multiDateAt(code, clientX) {
  const view = multiChartView(code), svg = multiCard(code)?.querySelector("svg");
  if (!view.layout || !svg) return null;
  const rect = svg.getBoundingClientRect(), layout = view.layout;
  const x = (clientX - rect.left) * layout.width / rect.width;
  if (x < layout.plotLeft || x > layout.plotRight) return null;
  return layout.bars[Math.min(layout.bars.length - 1, Math.floor((x - layout.plotLeft) / layout.step))]?.trade_date || null;
}

function locateMultiDate(code, date) {
  if (!validMultiMarkerDate(date)) return;
  const index = multiState.dates.findIndex((day) => day >= date);
  const view = multiChartView(code), card = multiCard(code);
  if (index < 0 || date < multiState.dates[0]) {
    card.querySelector(".multi-view-range").textContent = "日期超出本地行情覆盖范围，请先补充数据。";
    return;
  }
  view.start = index - Math.floor(view.count / 2);
  clampMultiView(view);
  view.cursor = multiState.dates[index]; view.locked = true;
  paintMultiCard(code);
  if (view.cursor !== date) card.querySelector(".multi-view-range").textContent += ` · ${date} 非交易日，定位到 ${view.cursor}`;
}

function addMultiMarker(code, date) {
  if (!date) return;
  const card = multiCard(code), payload = multiState.cache.get(code)?.payload;
  if (!payload?.bars.some((bar) => bar.trade_date === date && bar.close != null)) {
    card.querySelector(".multi-view-range").textContent = "该日期没有本地行情，无法标记节点。";
    return;
  }
  const nodes = multiState.markers[code] || [];
  if (nodes.some((node) => node.date === date)) return;
  const next = Math.max(-1, ...nodes.map((node) => Number(node.label.slice(1)))) + 1;
  multiState.markers[code] = [...nodes, {date, label: `T${next}`}];
  const view = multiChartView(code);
  view.cursor = date; view.locked = true;
  saveMultiMarkers(); paintMultiCard(code);
}

function actOnMultiView(code, action) {
  const view = multiChartView(code), total = multiState.dates.length;
  if (action === "zoom-in" || action === "zoom-out") zoomMultiView(view, total, action === "zoom-in" ? 1 / CHART_ZOOM_STEP : CHART_ZOOM_STEP);
  else if (action === "pan-left" || action === "pan-right") view.start += (action === "pan-left" ? -1 : 1) * Math.max(1, Math.round(view.count / 4));
  else if (action === "reset") {
    view.count = Number($("multi-period").value); view.start = total - view.count;
    view.cursor = null; view.locked = false;
  } else if (action === "mark") view.marking = !view.marking;
  else if (action === "unlock") view.locked = false;
  else if (action === "clear-nodes") { multiState.markers[code] = []; saveMultiMarkers(); }
  clampMultiView(view); paintMultiCard(code);
}

function bindMultiChartInteractions() {
  const grid = $("multi-grid");
  grid.addEventListener("click", (event) => {
    const card = event.target.closest(".multi-card");
    if (!card) return;
    const code = card.dataset.code, control = event.target.closest("[data-view-action]");
    if (control) actOnMultiView(code, control.dataset.viewAction);
    const remove = event.target.closest("[data-node-remove]");
    if (remove) {
      multiState.markers[code] = (multiState.markers[code] || []).filter((node) => node.date !== remove.dataset.nodeRemove);
      saveMultiMarkers(); paintMultiCard(code);
    }
    const node = event.target.closest("[data-node-date]");
    if (node) locateMultiDate(code, node.dataset.nodeDate);
  });
  grid.addEventListener("wheel", (event) => {
    const body = event.target.closest(".multi-chart-body"), code = body?.closest(".multi-card").dataset.code;
    if (!code || !multiState.cache.get(code)?.payload || !event.deltaY) return;
    event.preventDefault();
    const view = multiChartView(code), date = multiDateAt(code, event.clientX);
    const index = view.layout?.bars.findIndex((bar) => bar.trade_date === date);
    const ratio = index >= 0 ? index / Math.max(1, view.count - 1) : .5;
    zoomMultiView(view, multiState.dates.length, event.deltaY > 0 ? CHART_ZOOM_STEP : 1 / CHART_ZOOM_STEP, ratio);
    paintMultiCard(code);
  }, {passive: false});
  grid.addEventListener("pointerdown", (event) => {
    const body = event.target.closest(".multi-chart-body");
    if (!body || event.button !== 0 || !event.isPrimary) return;
    const code = body.closest(".multi-card").dataset.code, view = multiChartView(code);
    if (!view.layout) return;
    body.focus({preventScroll: true});
    view.drag = {id: event.pointerId, x: event.clientX, start: view.start,
      step: view.layout.step * body.clientWidth / view.layout.width, moved: false};
    body.setPointerCapture(event.pointerId);
  });
  grid.addEventListener("pointermove", (event) => {
    const body = event.target.closest(".multi-chart-body");
    if (!body) return;
    const code = body.closest(".multi-card").dataset.code, view = multiChartView(code);
    if (view.drag && view.drag.id === event.pointerId) {
      const delta = event.clientX - view.drag.x;
      if (Math.abs(delta) > 5) view.drag.moved = true;
      if (view.drag.moved) {
        view.start = view.drag.start - Math.round(delta / view.drag.step);
        clampMultiView(view); paintMultiCard(code);
      }
    } else if (!view.locked) {
      const date = multiDateAt(code, event.clientX);
      if (date && date !== view.cursor) { view.cursor = date; paintMultiFocus(code); }
    }
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) grid.addEventListener(type, (event) => {
    const body = event.target.closest(".multi-chart-body");
    if (!body) return;
    const code = body.closest(".multi-card").dataset.code, view = multiChartView(code), drag = view.drag;
    if (!drag || drag.id !== event.pointerId) return;
    view.drag = null;
    if (type !== "pointerup" || drag.moved) return;
    const date = multiDateAt(code, event.clientX);
    if (!date) return;
    if (view.marking) addMultiMarker(code, date);
    else { view.cursor = date; view.locked = true; paintMultiCard(code); }
  });
  grid.addEventListener("keydown", (event) => {
    if (!event.target.matches(".multi-chart-body")) return;
    const code = event.target.closest(".multi-card").dataset.code, view = multiChartView(code);
    if (!view.layout) return;
    if (["ArrowLeft", "ArrowRight"].includes(event.key) && !event.shiftKey) {
      event.preventDefault();
      const current = multiState.dates.indexOf(view.cursor || view.layout.bars.at(-1).trade_date);
      const index = Math.max(0, Math.min(multiState.dates.length - 1, current + (event.key === "ArrowLeft" ? -1 : 1)));
      view.cursor = multiState.dates[index];
      if (index < view.start) view.start = index;
      if (index >= view.start + view.count) view.start = index - view.count + 1;
      paintMultiCard(code); return;
    }
    const action = {"+": "zoom-in", "=": "zoom-in", "-": "zoom-out", ArrowLeft: "pan-left", ArrowRight: "pan-right",
      Home: "reset", Escape: "unlock", m: "mark", M: "mark"}[event.key];
    if (action) { event.preventDefault(); actOnMultiView(code, action); }
    if (event.key === "Enter") {
      event.preventDefault();
      const date = view.cursor || view.layout.bars.at(-1).trade_date;
      if (view.marking) addMultiMarker(code, date);
      else { view.cursor = date; view.locked = true; paintMultiCard(code); }
    }
  });
}
