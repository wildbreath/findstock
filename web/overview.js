/* 总览沿用涨停池快照，不另建行情下载与缓存流程。 */
let overviewSnapshot = null;
let overviewSector = null;

let overviewParent = null;

function overviewItems() {
  return (overviewSnapshot?.items || []).filter((item) =>
    (!$("overview-exclude-st").checked || !item.is_st) &&
    (!$("overview-multi").checked || item.consecutive >= 2));
}

function overviewGroups(items, level) {
  const groups = new Map();
  for (const item of items) {
    const state = stockSectorCache.get(item.code);
    let sectors = stockDisplaySectors(item.code).filter((sector) => sector.level === level);
    if (!sectors.length) {
      const status = state?.profile ? "missing" : state?.error ? "failed" : "pending";
      const name = status === "missing" ? `暂无${level}级行业` : status === "failed" ? "归属查询失败" : "归属查询中";
      sectors = [{id: `unknown:${status}:${level}`, name, level, unknown: true}];
    }
    for (const sector of sectors) {
      if (!groups.has(sector.id)) groups.set(sector.id, {...sector, items: [], multi: 0, height: 0});
      const group = groups.get(sector.id);
      if (group.items.some((member) => member.code === item.code)) continue;
      group.items.push(item);
      group.multi += item.consecutive >= 2 ? 1 : 0;
      group.height = Math.max(group.height, item.consecutive);
    }
  }
  return [...groups.values()];
}

function overviewSectorCard(group, total) {
  return `<button type="button" class="overview-sector${overviewSector?.id === group.id ? " is-active" : ""}" ` +
    `data-sector="${escapeHtml(group.id)}" data-level="${group.level}" aria-pressed="${overviewSector?.id === group.id}">` +
    `<span class="overview-sector-name">${escapeHtml(group.name)}${group.unknown ? "" : ` · ${group.level}级`}</span>` +
    `<strong>${group.items.length}<small> 只${$("overview-multi").checked ? "连板" : "涨停"}</small></strong>` +
    `<span class="overview-sector-meta">连板 ${group.multi} 只 · 最高 ${group.height} 板</span>` +
    `<span class="overview-sector-bar" aria-hidden="true"><i style="width:${Math.round(group.items.length / total * 100)}%"></i></span></button>`;
}

function renderOverview() {
  if (!overviewSnapshot) return;
  const items = overviewItems();
  items.forEach((item) => queueStockSectors(item.code));
  const level = Number($("overview-level").value);
  const groups = overviewGroups(items, level);
  const metrics = [
    [$("overview-multi").checked ? "连板股票" : "涨停股票", `${items.length} 只`],
    [`涉及${level}级行业`, `${groups.filter((group) => !group.unknown).length} 个`],
    ["三板及以上", `${items.filter((item) => item.consecutive >= 3).length} 只`],
    ["最高连板", `${items.reduce((max, item) => Math.max(max, item.consecutive), 0)} 板`],
  ];
  $("overview-metrics").innerHTML = metrics.map(([label, value]) =>
    `<div class="overview-metric"><span>${label}</span><strong>${value}</strong></div>`).join("");
  const query = $("overview-search").value.trim().toLowerCase();
  const sort = $("overview-sort").value;
  const visible = groups.filter((group) => group.name.toLowerCase().includes(query)).sort((a, b) =>
    Number(Boolean(a.unknown)) - Number(Boolean(b.unknown)) ||
    (sort === "height" ? b.height - a.height : sort === "multi" ? b.multi - a.multi : 0) ||
    b.items.length - a.items.length || b.height - a.height || a.name.localeCompare(b.name, "zh-CN"));
  $("overview-sectors").innerHTML = visible.length ? visible.map((group) => overviewSectorCard(group, items.length)).join("") :
    `<p class="condition-empty">${items.length ? "没有匹配的行业板块，请更换关键词。" : "该交易日暂无符合条件的股票，可切换日期或调整筛选。"}</p>`;
  const profiles = items.map((item) => stockSectorCache.get(item.code));
  const ready = profiles.filter((state) => state?.profile).length;
  const failed = profiles.filter((state) => state?.error && !state.profile).length;
  const stale = profiles.filter((state) => state?.profile && (state.error || state.profile.stale)).length;
  const pending = profiles.filter((state) => !state?.profile && !state?.error).length;
  const dates = profiles.filter((state) => state?.profile).map((state) => state.profile.fetched_at).sort();
  $("overview-sector-status").textContent = `东方财富当前归属 · 已取得 ${ready}/${items.length} 只` +
    (pending ? ` · 查询中 ${pending} 只，统计持续补全` : "") +
    (failed ? ` · 失败 ${failed} 只，板块统计不完整` : "") +
    (stale ? ` · ${stale} 只使用旧缓存` : "") +
    (dates.length ? ` · 归属获取时间 ${formatDateTime(dates[0])} 至 ${formatDateTime(dates.at(-1))}` : "");
  $("overview-sector-retry").hidden = !failed && !stale;
  const parentMembers = overviewParent ? overviewGroups(items, 1).find((group) => group.id === overviewParent.id)?.items || [] : items;
  const selected = overviewSector ? overviewGroups(parentMembers, overviewSector.level).find((group) => group.id === overviewSector.id) : null;
  const members = (overviewSector ? selected?.items || [] : items).slice().sort((a, b) =>
    b.consecutive - a.consecutive || (a.first_seal || "99").localeCompare(b.first_seal || "99") || a.code.localeCompare(b.code));
  const parent = overviewParent || (overviewSector?.level === 1 && !overviewSector.unknown ? overviewSector : null);
  const children = parent ? overviewGroups(overviewGroups(items, 1).find((group) => group.id === parent.id)?.items || [], 2) : [];
  $("overview-subsectors").innerHTML = children.length ?
    `<p class="overview-child-label">${escapeHtml(parent.name)}内的二级行业（按当前股池归属，点击查看个股）</p>` +
    children.map((group) => overviewSectorCard(group, items.length)).join("") : "";
  $("overview-detail").hidden = false;
  $("overview-detail-title").textContent = `${overviewParent ? `${overviewParent.name} / ` : ""}${overviewSector?.name || "全部"} · ${$("overview-multi").checked ? "连板股" : "涨停股"} (${members.length})`;
  $("overview-show-all").hidden = overviewSector === null;
  $("overview-stocks").innerHTML = members.length ? members.map((item) => {
    const sectors = stockDisplaySectors(item.code);
    const industry = sectors.length ? sectors.map((sector) => `${sector.name}（${sector.level}级）`).join(" / ") : "分级归属暂缺";
    return `<tr><td>${escapeHtml(item.code)}</td><td><button type="button" class="overview-stock" data-code="${escapeHtml(item.code)}">${escapeHtml(item.name)}</button></td>` +
      `<td>${escapeHtml(industry)}</td><td>${item.consecutive} 板</td>` +
      `<td>${escapeHtml(item.first_seal || "—")}</td><td>${item.amount == null ? "—" : `${(item.amount / 1e8).toFixed(2)} 亿`}</td></tr>`;
  }).join("") : '<tr><td colspan="6">暂无符合条件的股票。</td></tr>';
}

async function loadOverview(refresh = false) {
  const day = $("overview-date").value;
  $("overview-refresh").disabled = true;
  $("overview-date").disabled = true;
  $("overview-refresh").textContent = "读取中…";
  $("overview-sectors").setAttribute("aria-busy", "true");
  clearAlerts();
  try {
    const query = new URLSearchParams();
    if (day) query.set("date", day);
    if (refresh) query.set("refresh", "true");
    const snapshot = await api(`/api/stock-ladder?${query}`);
    overviewSnapshot = snapshot;
    overviewSector = null;
    overviewParent = null;
    $("overview-date").innerHTML = [...snapshot.trading_days].reverse().map((date) =>
      `<option value="${escapeHtml(date)}" ${date === snapshot.trade_date ? "selected" : ""}>${escapeHtml(date)}</option>`).join("");
    const source = snapshot.origin === "ths" ? "同花顺" : "东方财富";
    $("overview-status").textContent = `${snapshot.trade_date} · ${source} · ` +
      `${snapshot.data_source === "local" ? "本地存档" : "在线获取"} · ${snapshot.is_final ? "收盘快照" : "盘中/未定稿快照"} · 获取于 ${formatDateTime(snapshot.fetched_at)}` +
      (snapshot.stale ? " · 更新失败，沿用旧快照" : "");
    if (snapshot.stale) showAlert("warn", "联网更新失败，当前展示本地旧快照。可稍后刷新重试。");
    renderOverview();
  } catch (error) {
    showAlert("error", `总览读取失败: ${escapeHtml(error.message)}。请点击「刷新数据」重试。`);
    if (overviewSnapshot) $("overview-date").value = overviewSnapshot.trade_date;
    else {
      $("overview-status").textContent = "尚未取得数据";
      $("overview-sectors").innerHTML = '<p class="condition-empty">板块数据暂不可用，请刷新重试。</p>';
    }
  } finally {
    $("overview-refresh").disabled = false;
    $("overview-date").disabled = !overviewSnapshot;
    $("overview-refresh").textContent = "刷新数据";
    $("overview-sectors").setAttribute("aria-busy", "false");
  }
}

async function initOverview() {
  bindElements(["alert-area"], ["alert-area"]);
  stockSectorUpdated = () => renderOverview();
  $("overview-refresh").addEventListener("click", () => loadOverview(true));
  $("overview-date").addEventListener("change", () => loadOverview());
  $("overview-search").addEventListener("input", renderOverview);
  $("overview-sort").addEventListener("change", renderOverview);
  $("overview-exclude-st").addEventListener("change", renderOverview);
  $("overview-multi").addEventListener("change", renderOverview);
  $("overview-level").addEventListener("change", () => { overviewSector = overviewParent = null; renderOverview(); });
  $("overview-sector-retry").addEventListener("click", () => {
    overviewItems().forEach((item) => {
      const state = stockSectorCache.get(item.code);
      if (state?.error || state?.profile?.stale) queueStockSectors(item.code, true);
    });
    renderOverview();
  });
  $("overview-show-all").addEventListener("click", () => { overviewSector = overviewParent = null; renderOverview(); });
  function selectSector(event) {
    const button = event.target.closest("[data-sector]");
    if (!button) return;
    const nested = event.currentTarget.id === "overview-subsectors";
    if (nested) overviewParent = overviewParent || overviewSector;
    else overviewParent = null;
    const base = overviewParent ? overviewGroups(overviewItems(), 1).find((group) => group.id === overviewParent.id)?.items || [] : overviewItems();
    overviewSector = overviewGroups(base, Number(button.dataset.level)).find((group) => group.id === button.dataset.sector) || null;
    renderOverview();
    $("overview-detail-title").focus({preventScroll: true});
    $("overview-detail").scrollIntoView({block: "start"});
  }
  $("overview-sectors").addEventListener("click", selectSector);
  $("overview-subsectors").addEventListener("click", selectSector);
  $("overview-stocks").addEventListener("click", (event) => {
    const button = event.target.closest("[data-code]");
    if (!button) return;
    openStockChart(button.dataset.code, {name: button.textContent, sourceDate: overviewSnapshot.trade_date});
  });
  await loadOverview();
}

boot(initOverview);
