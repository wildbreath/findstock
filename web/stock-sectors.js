/* 板块数据独立于卡片文案, 按股票代码共享, 供后续板块分类复用。 */
const stockSectorCache = new Map();
const stockSectorQueue = [];
let stockSectorActive = 0;
let stockSectorObserver = null;
const stockSectorObserved = new Set();
let stockSectorUpdated = () => {};

function stockDisplaySectors(code) {
  return (stockSectorCache.get(code)?.profile?.sectors || [])
    .filter((sector) => sector.kind === "industry" && [1, 2].includes(sector.level));
}

function stockSectorNames(code) {
  return stockDisplaySectors(code).map((sector) => sector.name);
}

function stockPrimarySector(code) {
  const state = stockSectorCache.get(code);
  const sectors = stockDisplaySectors(code);
  const primary = sectors.find((sector) => sector.level === 2) || sectors[0];
  const name = primary?.name || (state?.profile ? "暂无一级、二级板块" : state?.error ? "行业读取失败" : "行业读取中…");
  const label = primary ? `东方财富${primary.level}级行业 · 当前归属` : "仅展示一级、二级行业板块";
  return `<span title="${escapeHtml(label)}"${primary ? ` data-sector-id="${escapeHtml(primary.id)}"` : ""}>${escapeHtml(name)}</span>`;
}

function stockSectorDetails(code) {
  const state = stockSectorCache.get(code);
  const profile = state?.profile;
  const sectors = stockDisplaySectors(code);
  const count = profile ? `（${sectors.length}）` : "";
  let content;
  if (!profile) {
    content = state?.error ? `<p class="sector-meta">${escapeHtml(state.error)}</p><button type="button" class="sector-retry" data-sector-refresh="${escapeHtml(code)}">重试板块查询</button>`
      : '<p class="sector-meta">正在查询当前所属板块…</p>';
  } else {
    const groups = [[1, "一级板块"], [2, "二级板块"]];
    content = `<p class="sector-meta">东方财富 · 当前归属<br>获取于 ${escapeHtml(formatDateTime(profile.fetched_at))}${profile.stale || state.error ? "<br>更新失败，当前为旧缓存" : ""}${state.loading ? "<br>正在更新…" : ""}</p>`;
    if (!sectors.length) content += '<p class="sector-meta">暂无一级、二级板块信息</p>';
    content += groups.map(([level, label]) => {
      const members = sectors.filter((sector) => sector.level === level);
      if (!members.length) return "";
      return `<p class="sector-group-name">${label}</p><div class="sector-tags">${members.map((sector) => `<span class="sector-tag ${sector.id === profile.primary_sector_id ? "is-primary" : ""}" data-sector-id="${escapeHtml(sector.id)}" title="${escapeHtml(sector.reason || sector.code)}">${escapeHtml(sector.name)}</span>`).join("")}</div>`;
    }).join("");
    content += `<a class="sector-source" href="${escapeHtml(profile.source_url)}" target="_blank" rel="noopener noreferrer">查看来源与入选依据 ↗</a>`;
    content += `<button type="button" class="sector-retry" data-sector-refresh="${escapeHtml(code)}" ${state.loading ? "disabled" : ""}>刷新板块</button>`;
  }
  return `<summary>所属板块${count}<span class="sector-current-label">当前</span></summary><div class="sector-body">${content}</div>`;
}

function updateStockSectorNodes(code) {
  document.querySelectorAll(`[data-sector-code=${JSON.stringify(code)}]`).forEach((node) => {
    const restoreFocus = node.dataset.sectorPart === "details" && node.contains(document.activeElement);
    const markup = node.dataset.sectorPart === "primary"
      ? stockPrimarySector(code) : stockSectorDetails(code);
    if (node.stockSectorMarkup === markup) return;
    node.innerHTML = markup;
    node.stockSectorMarkup = markup;
    if (restoreFocus) node.querySelector("summary").focus({preventScroll: true});
  });
}

function queueStockSectors(code, refresh = false, priority = false) {
  const state = stockSectorCache.get(code);
  if (priority && state?.loading) {
    const index = stockSectorQueue.findIndex((task) => task.code === code);
    if (index > 0) stockSectorQueue.unshift(...stockSectorQueue.splice(index, 1));
  }
  if (state?.loading || (!refresh && state && (state.error || state.profile?.stale || !state.profile ||
      Date.now() - Date.parse(state.profile.fetched_at) < 86400000))) return;
  stockSectorCache.set(code, {...state, loading: true, error: ""});
  updateStockSectorNodes(code);
  if (priority) stockSectorQueue.unshift({code, refresh});
  else stockSectorQueue.push({code, refresh});
  drainStockSectors();
}

function drainStockSectors() {
  while (stockSectorActive < 3 && stockSectorQueue.length) {
    const {code, refresh} = stockSectorQueue.shift();
    stockSectorActive++;
    api(`/api/stocks/${encodeURIComponent(code)}/sectors${refresh ? "?refresh=true" : ""}`)
      .then((profile) => stockSectorCache.set(code, {profile, loading: false}))
      .catch((error) => stockSectorCache.set(code, {
        ...stockSectorCache.get(code), loading: false, error: error.message,
      }))
      .finally(() => {
        stockSectorActive--;
        try {
          updateStockSectorNodes(code);
          stockSectorUpdated(code);
        } finally {
          drainStockSectors();
        }
      });
  }
}

function observeStockSectors() {
  if (typeof IntersectionObserver === "undefined") return;
  if (!stockSectorObserver) stockSectorObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      stockSectorObserver.unobserve(entry.target);
      if (entry.target.isConnected) queueStockSectors(entry.target.dataset.sectorCode, false, true);
    });
  }, {rootMargin: "160px"});
  stockSectorObserved.forEach((node) => {
    if (node.isConnected) return;
    stockSectorObserver.unobserve(node);
    stockSectorObserved.delete(node);
  });
  document.querySelectorAll(".stock-sector-details").forEach((node) => {
    if (stockSectorObserved.has(node)) return;
    stockSectorObserved.add(node);
    stockSectorObserver.observe(node);
  });
}

function initStockSectors(onUpdate = () => {}) {
  stockSectorUpdated = onUpdate;
  const root = $("ladder-groups");
  root.addEventListener("toggle", (event) => {
    if (event.target.matches(".stock-sector-details") && event.target.open) queueStockSectors(event.target.dataset.sectorCode, false, true);
  }, true);
  root.addEventListener("click", (event) => {
    const retry = event.target.closest("[data-sector-refresh]");
    if (retry) queueStockSectors(retry.dataset.sectorRefresh, true, true);
  });
}
