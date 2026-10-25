// node tests/test_ladder_frontend.cjs: 连续日期、可见列加载、滚动同步、局部失败与缓存自检。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const elements = new Map();
const urls = [];
function $(id) {
  if (!elements.has(id)) elements.set(id, {value: "", checked: false, textContent: "", innerHTML: "", clientWidth: 956, scrollLeft: 0,
    style: {setProperty(key, value) { this[key] = value; }}, querySelector() { return null; }, querySelectorAll() { return []; }, setAttribute() {}, addEventListener() {}});
  return elements.get(id);
}
const context = vm.createContext({
  $, console, Date, Map, Set, Intl, URLSearchParams, encodeURIComponent, setTimeout, clearTimeout,
  el: {}, boot() {}, clearAlerts() {}, showAlert() {},
  document: {hidden: false, querySelectorAll: () => []}, history: {replaceState(_state, _title, url) { urls.push(url); }},
  formatDateTime: (value) => value,
  escapeHtml: (value) => String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]),
});
const evaluate = (code) => vm.runInContext(code, context);
vm.runInContext(fs.readFileSync("web/chart.js", "utf8"), context);
vm.runInContext(fs.readFileSync("web/ladder.js", "utf8"), context);
const root = $("ladder-groups"), bar = $("ladder-scrollbar");
const floating = $("ladder-sticky-head");
root.bounds = {top: 300, bottom: 2000, left: 20, width: 956};
root.getBoundingClientRect = () => root.bounds;
root.querySelector = (selector) => selector === "thead" && root.innerHTML.includes("<thead>")
  ? {getBoundingClientRect: () => ({height: 64})} : null;
Object.defineProperty(root, "scrollWidth", {get: () => Math.max(root.clientWidth,
  (56 + evaluate("ladderDays.length") * (parseFloat(root.style["--ladder-day-width"]) || 180)) * evaluate("ladderZoom"))});
Object.defineProperty(bar, "scrollWidth", {get: () => parseFloat($("ladder-scrollbar-space").style.width) || bar.clientWidth});
for (const node of [root, bar]) {
  let left = 0;
  Object.defineProperty(node, "scrollLeft", {get: () => left,
    set: (value) => { left = Math.max(0, Math.min(value, node.scrollWidth - node.clientWidth)); }});
}
$("ladder-board").value = "all";
$("ladder-theme").value = "all";
$("ladder-sort").value = "time";
$("ladder-count").value = "5";
$("ladder-zoom").value = "100";
$("ladder-exclude-st").checked = true;
$("ladder-compact").checked = true;
context.items = [
  {code: "sh.600001", name: "<测试>", primary_theme: "人工<智能>", industry: "软件", board: "main_sh", board_label: "沪市主板", consecutive: 3, first_seal: "10:00:00", seal_funds: 3e8, amount: 3e8},
  {code: "sz.000001", name: "测试二", primary_theme: "人工<智能>", industry: "软件", board: "main_sz", consecutive: 3, first_seal: "09:30:00", seal_funds: 1e8},
  {code: "sz.300001", name: "创业", industry: "电力", board: "gem", consecutive: 1},
  {code: "sh.600002", name: "ST测试", board: "main_sh", consecutive: 8, is_st: true},
];
assert.equal(evaluate("ladderFiltered(items).length"), 3);
assert.equal(evaluate("ladderFiltered(items)[0].code"), "sz.000001");
$("ladder-sort").value = "funds";
assert.equal(evaluate("ladderFiltered(items)[0].code"), "sh.600001");
$("ladder-multi").checked = true;
assert.equal(evaluate("ladderFiltered(items).length"), 2);
$("ladder-search").value = "人工<智能>";
assert.equal(evaluate("ladderFiltered(items).length"), 2);
$("ladder-search").value = "";
$("ladder-board").value = "gem";
assert.equal(evaluate("ladderFiltered(items).length"), 0);
$("ladder-multi").checked = false;
assert.equal(evaluate("ladderFiltered(items).length"), 1);
$("ladder-board").value = "all";
$("ladder-search").value = "600001";
assert.equal(evaluate("ladderFiltered(items).length"), 1);
$("ladder-search").value = "软件";
assert.equal(evaluate("ladderFiltered(items).length"), 0); // 行业不是当日涨停题材。
const card = evaluate("ladderCard(items[0], '2026-10-15')");
assert.ok(card.includes("&lt;测试&gt;"));
assert.ok(card.includes('data-date="2026-10-15"'));
assert.ok(card.includes('class="ladder-mini-chart"'));
assert.ok(card.includes("人工&lt;智能&gt;"));
assert.ok(!card.includes("所属板块"));
assert.ok(evaluate("ladderCard(items[2], '2026-10-15')").includes("题材未获取"));
context.miniBars = Array.from({length: 25}, (_, i) => ({trade_date: `2026-09-${String(i + 1).padStart(2, '0')}`,
  open: 10, close: i % 2 ? 11 : 9, high: 12, low: 8, ma: {60: 500}}));
const mini = evaluate("ladderMiniChart(miniBars, '2026-09-24')");
assert.equal((mini.match(/<rect /g) || []).length, 20);
assert.ok(mini.includes('2026-09-05 至 2026-09-24'));
assert.ok(!mini.includes('2026-09-25'));
assert.ok(mini.includes('fill="#fff"') && mini.includes('fill="#159c5b"'));
assert.ok(!mini.includes('NaN') && !mini.includes('Infinity'));
assert.equal(evaluate("ladderMiniChart([], '2026-09-24')"), '暂无日K');
assert.equal(evaluate("ladderMiniChart([{trade_date: '2026-09-24', open: null}], '2026-09-24')"), '暂无日K');
const flatMini = evaluate("ladderMiniChart([{trade_date: '2026-09-24', open: 10, high: 10, low: 10, close: 10}], '2026-09-24')");
assert.ok(flatMini.includes('<rect ') && !flatMini.includes('NaN'));
assert.ok(!card.includes("首次封板") && !card.includes("最新价") && !card.includes("换手率"));
assert.equal(evaluate("ladderMoney(null)"), "—");
assert.equal(evaluate("ladderMoney(300000000)"), "3.00亿");
assert.ok(evaluate("ladderDayNote({snapshot: {items: []}})").includes('href="/data"'));
assert.equal(evaluate("ladderStorageLabel({items: items, data_source: 'local', is_final: true})"), "本地存档");
assert.equal(evaluate("ladderStorageLabel({items: items, data_source: 'local', origin: 'ths', is_final: true})"), "本地存档 · 同花顺");
assert.equal(evaluate("ladderStorageLabel({items: items, data_source: 'eastmoney', is_final: false})"), "已存本地 · 盘中快照");
assert.equal(evaluate("ladderStorageLabel({items: items, data_source: 'local', is_final: false, stale: true})"), "本地存档 · 盘中快照 · 更新未成功");
const dates = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"];
context.dates = dates;
assert.equal(evaluate("ladderColumnWidth(956, 5)"), 180);
assert.equal(evaluate("ladderColumnWidth(1256, 3)"), 400);
assert.equal(evaluate("ladderColumnWidth(390, 10)"), 180);
assert.equal(JSON.stringify(evaluate("ladderViewportRange(0, 956, 5, 9)")), '{"first":0,"end":5}');
assert.equal(JSON.stringify(evaluate("ladderViewportRange(720, 956, 5, 9)")), '{"first":4,"end":9}');
assert.equal(JSON.stringify(evaluate("ladderViewportRange(250, 390, 5, 9)")), '{"first":1,"end":4}');
assert.equal(JSON.stringify(evaluate("ladderViewportRange(899.999, 956, 5, 28)")), '{"first":5,"end":10}');
evaluate("ladderZoom = 0.5");
assert.equal(evaluate("ladderColumnWidth(956, 5)"), 90);
assert.equal(JSON.stringify(evaluate("ladderViewportRange(0, 956, 5, 28)")), '{"first":0,"end":11}');
assert.equal(JSON.stringify(evaluate("ladderViewportRange(180, 390, 5, 28)")), '{"first":2,"end":7}');
evaluate("ladderZoom = 1.5");
assert.equal(evaluate("ladderColumnWidth(956, 5)"), 270);
assert.equal(JSON.stringify(evaluate("ladderViewportRange(0, 956, 5, 28)")), '{"first":0,"end":4}');
evaluate("ladderZoom = 1");
let requests = [], active = 0, peak = 0, failedDate = "";
const requestPaths = [];
const sectorRequests = [];
let candidateThemes = [{name: "人工<智能>", stock_count: 1}, {name: "新题材", stock_count: 1}], candidateFailure = false, candidateRequests = 0;
const candidateDates = [], candidateByDay = new Map(), candidateWaits = new Map();
function snapshot(day) {
  return {trade_date: day, trading_days: dates, fetched_at: day + "T14:00:00+08:00", data_source: "eastmoney", is_final: true, theme_complete: false,
    items: [...context.items.map((item) => ({...item, primary_theme: day === "2026-10-14" && item.code === "sh.600001" ? "新题材" : item.primary_theme,
      consecutive: day === "2026-10-12" && item.code === "sh.600001" ? 10 : item.consecutive})),
      ...(day === dates[0] ? [{code: "sz.000009", name: "新股票", primary_theme: "新题材", consecutive: 1, board: "main_sz"}] : [])]};
}
context.api = async (path) => {
  if (path.startsWith("/api/stock-ladder/theme-candidates?")) {
    candidateRequests++;
    const day = new URL('http://test' + path).searchParams.get('date');
    candidateDates.push(day);
    const themes = candidateByDay.get(day) || candidateThemes;
    if (candidateWaits.has(day)) await candidateWaits.get(day);
    if (candidateFailure) throw new Error("候选统计失败");
    return {trade_date: day, trading_days: dates, covered_dates: [day], classified_dates: [], themes, unclassified_count: 1};
  }
  if (path.startsWith("/api/stocks/")) {
    const code = decodeURIComponent(path.split("/")[3]);
    sectorRequests.push(code);
    await new Promise(setImmediate);
    throw new Error("天梯不应请求当前所属板块");
  }
  requestPaths.push(path);
  const day = new URL("http://test" + path).searchParams.get("date") || dates.at(-1);
  requests.push(day);
  peak = Math.max(peak, ++active);
  await new Promise(setImmediate);
  active--;
  if (day === failedDate) throw new Error("temporary failure <upstream>");
  return snapshot(day);
};
$("ladder-search").value = "";
(async () => {
  await evaluate("loadLadder()");
  await new Promise((resolve) => setTimeout(resolve, 230));
  assert.equal(requests.length, 5);
  assert.ok(peak <= 3);
  assert.equal(evaluate("ladderDays.length"), dates.length);
  assert.equal(evaluate("ladderDays.filter(x => x.snapshot).length"), 5);
  assert.equal($("ladder-groups").innerHTML.match(/class="ladder-day-head"/g).length, dates.length);
  assert.ok($("ladder-groups").innerHTML.includes("横向拖动到该日期后加载"));
  assert.equal($("ladder-scroll-dock").hidden, false);
  assert.equal(bar.scrollWidth - bar.clientWidth, root.scrollWidth - root.clientWidth);
  assert.equal(floating.hidden, true); // 表头尚未滚出屏幕, 不重复遮挡原表头。
  assert.ok(floating.innerHTML.includes("10-15"));
  assert.ok($("ladder-groups").innerHTML.includes("10板"));
  assert.ok($("ladder-groups").innerHTML.includes("首板"));
  assert.ok(!$("ladder-status").textContent.includes("读取中"));
  assert.equal(evaluate("ladderVisible.get('2026-10-15').length"), 3);
  assert.equal(evaluate("ladderVisible.get('2026-10-12')[0].consecutive"), 10);
  // 屏幕外的高板股票不能撑高当前空行，缓存日期切换也要重新收紧。
  const loadedDays = evaluate("ladderDays");
  const savedSnapshots = loadedDays.map((entry) => entry.snapshot);
  loadedDays.forEach((entry, index) => {
    entry.snapshot = {...snapshot(entry.trade_date), items: index === 0 ? [context.items[2]]
      : index === loadedDays.length - 1 ? Array.from({length: 12}, () => ({...context.items[0], consecutive: 6})) : []};
  });
  evaluate("renderLadder()");
  const sixBoardRow = () => root.innerHTML.match(/<tr[^>]*><th scope="row"[^]*?6板[^]*?<\/tr>/)[0];
  assert.ok(root.innerHTML.includes('class="ladder-table is-compact"'));
  assert.ok(sixBoardRow().includes('class="is-empty-rank"'));
  assert.equal((sixBoardRow().match(/class="ladder-stock"/g) || []).length, 0); // 远处日期只缓存数据，不保留卡片 DOM。
  await evaluate("seekLadderDay('2026-09-28')");
  assert.ok(!sixBoardRow().includes('class="is-empty-rank"'));
  assert.equal(sixBoardRow().match(/class="ladder-stock"/g).length, 12);
  $("ladder-compact").checked = false;
  evaluate("renderLadder()");
  assert.ok(!root.innerHTML.includes('class="is-outside-viewport"'));
  assert.ok(!root.innerHTML.includes('class="ladder-table is-compact"'));
  $("ladder-compact").checked = true;
  loadedDays.forEach((entry, index) => { entry.snapshot = savedSnapshots[index]; });
  evaluate("renderLadder()");
  await evaluate("seekLadderDay('2026-10-15')");
  // 候选、卡片和筛选均来自本地悟道当日记录，不再逐股请求所属板块。
  assert.equal(sectorRequests.length, 0);
  assert.ok(candidateRequests > 0);
  assert.ok($("ladder-theme").innerHTML.includes("人工&lt;智能&gt;（1只）"));
  assert.ok($("ladder-theme").innerHTML.includes("新题材（1只）"));
  assert.equal($("ladder-theme-date").value, "2026-10-15");
  assert.equal($("ladder-theme-date").disabled, false);
  assert.equal($("ladder-theme-date").innerHTML.match(/<option/g).length, dates.length);
  assert.deepEqual(candidateDates, ["2026-10-15"]);
  assert.ok($("ladder-theme-status").textContent.includes("题材取自 2026-10-15"));
  assert.ok($("ladder-theme-status").textContent.includes("所有日期的同题材股票"));
  assert.ok($("ladder-theme-status").textContent.includes("筛选可能不全"));
  assert.equal($("ladder-theme-retry").hidden, true);
  $("ladder-theme").value = "人工<智能>";
  evaluate("renderLadder()");
  assert.equal(evaluate("ladderVisible.get('2026-10-15').length"), 2);
  assert.equal(evaluate("ladderVisible.get('2026-10-14').length"), 1); // 同股前一天主类不同。
  assert.ok(root.innerHTML.includes("2 家 · 题材未齐"));
  assert.ok($("ladder-theme").innerHTML.includes("新题材（1只）")); // 选项不随结果缩小。
  $("ladder-board").value = "gem";
  assert.equal(evaluate("ladderFiltered(items).length"), 0); // 与上市板块叠加。
  $("ladder-board").value = "all";
  assert.equal(evaluate("ladderFiltered(items).length"), 2); // 题材下也显示尚未达四板的涨停股。
  candidateFailure = true;
  await evaluate("loadLadderThemeCandidates()");
  assert.equal($("ladder-theme").value, "人工<智能>");
  assert.ok($("ladder-theme-status").textContent.includes("沿用该日上次候选"));
  assert.equal($("ladder-theme-retry").hidden, false);
  candidateFailure = false;
  await evaluate("loadLadderThemeCandidates()");
  $("ladder-theme").value = "all";
  evaluate("renderLadder()");
  let chart;
  context.openStockChart = (code, options) => { chart = {code, ...options}; };
  evaluate("openLadderChart('sh.600001', '2026-10-12')");
  assert.equal(chart.sourceDate, "2026-10-12");
  assert.ok(chart.list.every((item) => item.date === "2026-10-12"));
  requests = [];
  await evaluate("loadLadder('2026-10-14')");
  assert.equal(requests.length, 1); // 只加载新进入可视区域的日期。
  assert.ok(!requests.includes("2026-10-12"));
  assert.equal(root.scrollLeft, 180);
  assert.equal(bar.scrollLeft, root.scrollLeft);
  assert.equal($("ladder-date").value, "2026-10-14");
  assert.equal($("ladder-theme-date").value, "2026-10-15"); // 定位和横向滚动不改变题材来源日期。
  // 先横向移动, 再向下进入表格, 浮动表头必须恢复到同一日期列。
  root.bounds.top = -300;
  evaluate("positionLadderHeader()");
  assert.equal(floating.hidden, false);
  assert.equal(floating.scrollLeft, root.scrollLeft);
  assert.equal(floating.style.left, "20px");
  assert.equal(floating.style.width, "956px");
  assert.equal(floating.style.top, "0px");
  floating.scrollLeft = 360;
  evaluate("syncLadderScroll($('ladder-sticky-head'))");
  assert.equal(root.scrollLeft, 360);
  assert.equal(bar.scrollLeft, 360);
  // 表格离开屏幕时表头随最后一行退出, 上下两端均不遮挡其他内容。
  root.bounds.bottom = 30;
  evaluate("positionLadderHeader()");
  assert.equal(floating.style.top, "-34px");
  root.bounds.bottom = 0;
  evaluate("positionLadderHeader()");
  assert.equal(floating.hidden, true);
  floating.scrollLeft = 0;
  evaluate("syncLadderScroll($('ladder-sticky-head'))");
  assert.equal(root.scrollLeft, 360); // 隐藏表头的归零不能带动股票列。
  root.bounds = {top: 300, bottom: 2000, left: 20, width: 956};
  // 底部拖动与表格滚动双向同步, 到达最早日期后不能继续向右。
  bar.scrollLeft = bar.scrollWidth;
  evaluate("syncLadderScroll($('ladder-scrollbar'))");
  await evaluate("loadLadderViewport()");
  assert.equal(root.scrollLeft, bar.scrollLeft);
  assert.equal($("ladder-prev").disabled, true);
  assert.equal(evaluate("ladderDays.filter(x => x.snapshot).length"), dates.length);
  await new Promise((resolve) => setTimeout(resolve, 230));
  assert.equal(sectorRequests.length, 0);
  assert.ok($("ladder-theme").innerHTML.includes("新题材（1只）"));
  $("ladder-theme").value = "新题材";
  evaluate("renderLadder()");
  assert.equal(evaluate("ladderVisible.get('2026-09-28').length"), 1);
  assert.equal(evaluate("ladderVisible.get('2026-10-15').length"), 0);
  assert.ok(root.innerHTML.includes("当日题材未获取"));
  assert.equal($("ladder-theme").value, "新题材");
  $("ladder-theme").value = "all";
  evaluate("renderLadder()");
  assert.ok($("ladder-scroll-hint").textContent.includes(dates[0]));
  const fetched = requests.length;
  await evaluate("loadLadder('2026-10-14')");
  assert.equal(requests.length, fetched); // 回看已加载列不重复请求。
  failedDate = "2026-10-13";
  await evaluate("loadLadder('2026-10-15', true)");
  assert.equal(evaluate("ladderDays.filter(x => x.snapshot).length"), dates.length); // 刷新失败保留旧行情。
  assert.equal(evaluate("ladderDays.filter(x => x.error).length"), 1);
  assert.ok($("ladder-status").textContent.includes("1 日更新失败"));
  assert.ok(!$("ladder-groups").innerHTML.includes("<upstream>"));
  // 刷新不会请求可视范围以外的日期。
  requests = [];
  await evaluate("loadLadderViewport(true)");
  assert.equal(requests.length, 5);
  assert.ok(requestPaths.slice(-5).every(path => new URL('http://test' + path).searchParams.get('refresh') === 'true'));
  assert.ok(!requests.includes("2026-10-15"));
  // 首次加载失败只标记该列, 手动刷新可恢复, 不会无限重试。
  evaluate("ladderDays.find(x => x.trade_date === '2026-10-13').snapshot = null");
  await evaluate("loadLadderViewport(true)");
  assert.ok($("ladder-groups").innerHTML.includes("temporary failure &lt;upstream&gt;"));
  failedDate = "";
  await evaluate("loadLadderViewport(true)");
  assert.equal(evaluate("ladderDays.filter(x => x.error).length"), 0);
  // 请求期间快速拖到另一端, 完成后衔接当前可见日期。
  evaluate("ladderDays.slice(-3).forEach(x => { x.snapshot = null; ladderCache.delete(x.trade_date); })");
  await evaluate("seekLadderDay('2026-10-15')");
  const moving = evaluate("loadLadderViewport(true)");
  bar.scrollLeft = bar.scrollWidth;
  evaluate("syncLadderScroll($('ladder-scrollbar'))");
  await moving;
  assert.equal(evaluate("ladderViewportDays().every(x => x.snapshot)"), true);
  assert.ok(peak <= 3);
  // 键盘在滚动条两端定位, 股票卡片上的按键不被截获。
  context.keyEvent = {key: "Home", target: bar, currentTarget: bar, preventDefault() { this.prevented = true; }};
  evaluate("ladderScrollKey(keyEvent)");
  assert.equal(root.scrollLeft, 0);
  assert.equal(context.keyEvent.prevented, true);
  context.keyEvent = {key: "End", target: {}, currentTarget: bar, preventDefault() { throw new Error("card key intercepted"); }};
  evaluate("ladderScrollKey(keyEvent)");
  assert.equal(root.scrollLeft, 0);
  // 调整列数保留当前位置, 窄屏下仍可查看全部日期。
  evaluate("ladderCount = 3; layoutLadderScroll()");
  assert.equal(root.style["--ladder-day-width"], "300px");
  assert.equal(floating.style["--ladder-day-width"], "300px");
  await evaluate("seekLadderDay('2026-10-13')");
  assert.equal(root.scrollLeft, 600);
  root.clientWidth = 390;
  evaluate("layoutLadderScroll()");
  assert.equal(root.style["--ladder-day-width"], "180px");
  await evaluate("seekLadderDay('2026-09-28')");
  assert.equal($("ladder-prev").disabled, true);
  assert.ok(evaluate("ladderViewportDays().at(-1).trade_date") === dates[0]);
  root.clientWidth = 956;
  evaluate("ladderCount = 5; layoutLadderScroll()");
  // 缩放后保留定位日期，视口范围、滚动条和键盘统一使用缩放后的尺寸。
  await evaluate("seekLadderDay('2026-10-13')");
  evaluate("ladderZoom = 0.75; layoutLadderScroll()");
  await evaluate("seekLadderDay('2026-10-13')");
  assert.equal(root.scrollLeft, 270);
  assert.equal(bar.scrollLeft, 270);
  assert.equal(root.style["--ladder-zoom"], 0.75);
  assert.equal(floating.style["--ladder-zoom"], 0.75);
  assert.equal(root.style["--ladder-day-width"], "180px");
  assert.ok(urls.at(-1).includes("zoom=75"));
  await evaluate("seekLadderDay('2026-10-15')");
  context.keyEvent = {key: "ArrowRight", target: bar, currentTarget: bar, preventDefault() {}};
  evaluate("ladderScrollKey(keyEvent)");
  assert.equal(root.scrollLeft, 135);
  evaluate("ladderZoom = 0.5; $('ladder-groups').scrollLeft = $('ladder-groups').scrollLeft; layoutLadderScroll()");
  await evaluate("loadLadderViewport()");
  assert.equal(evaluate("ladderViewportDays().length"), dates.length);
  assert.equal(root.scrollLeft, 0); // 日期全部放入视口时无需横向滚动。
  assert.equal(bar.scrollWidth - bar.clientWidth, 0);
  evaluate("ladderZoom = 1.5; layoutLadderScroll()");
  await evaluate("seekLadderDay('2026-10-13')");
  assert.equal(root.scrollLeft, 540);
  assert.equal(floating.scrollLeft, 540);
  evaluate("ladderZoom = 1; layoutLadderScroll()");
  await evaluate("seekLadderDay('2026-10-15')");
  failedDate = "2026-10-15";
  await evaluate("loadLadder('2026-10-15', true)");
  assert.equal($("ladder-date").value, "2026-10-15");
  assert.equal(evaluate("ladderDays.length"), dates.length);
  assert.ok($("ladder-status").textContent.includes("更新失败"));
  assert.equal($("ladder-refresh").disabled, false);
  evaluate("ladderData = null; ladderCache.clear()");
  await evaluate("loadLadder() ");
  assert.ok($("ladder-groups").innerHTML.includes("暂时无法读取涨停池"));
  failedDate = "";
  $("ladder-count").value = "10";
  await evaluate("loadLadder() ");
  assert.equal(evaluate("ladderDays.length"), dates.length);
  $("ladder-search").value = "不存在的股票";
  evaluate("renderLadder()");
  assert.ok($("ladder-groups").innerHTML.includes("没有符合筛选条件的股票"));
  assert.equal($("ladder-groups").innerHTML.match(/scope="col"/g).length, dates.length + 1);
  $("ladder-theme").value = "人工<智能>";
  candidateThemes = [];
  await evaluate("loadLadderThemeCandidates()");
  assert.equal($("ladder-theme").value, "all");
  assert.equal($("ladder-theme").disabled, true);
  assert.ok(!$("ladder-theme").innerHTML.includes("人工&lt;智能&gt;"));
  assert.ok($("ladder-theme-status").textContent.includes("已切换为全部题材"));
  // 切换来源日失败时不使用上一日的候选，也不把已选筛选悄悄放宽。
  $("ladder-search").value = "";
  $("ladder-theme").value = "人工<智能>";
  $("ladder-theme-date").value = "2026-10-14";
  candidateFailure = true;
  await evaluate("loadLadderThemeCandidates()");
  assert.equal($("ladder-theme").value, "人工<智能>");
  assert.equal($("ladder-theme").disabled, true);
  assert.ok($("ladder-theme").innerHTML.includes("待核对该日题材"));
  assert.ok(!$("ladder-theme").innerHTML.includes("新题材"));
  assert.equal(evaluate("ladderVisible.get('2026-10-15').length"), 2);
  assert.equal(evaluate("ladderVisible.get('2026-10-14').length"), 1);
  assert.equal(evaluate("ladderDays.length"), dates.length);
  assert.ok($("ladder-theme-status").textContent.includes("已选题材筛选保留"));
  // 快速改日期时只接收最后一次选择，旧请求不能覆盖新日期候选。
  candidateFailure = false;
  candidateByDay.set('2026-10-14', [{name: '过时响应', stock_count: 1}]);
  candidateByDay.set('2026-10-13', [{name: '人工<智能>', stock_count: 2}, {name: '该日独有', stock_count: 1}]);
  let releaseOlder;
  candidateWaits.set('2026-10-14', new Promise(resolve => { releaseOlder = resolve; }));
  const older = evaluate("loadLadderThemeCandidates()");
  $("ladder-theme-date").value = '2026-10-13';
  await evaluate("loadLadderThemeCandidates()");
  releaseOlder();
  await older;
  assert.equal($("ladder-theme").value, "人工<智能>");
  assert.ok($("ladder-theme").innerHTML.includes('该日独有'));
  assert.ok(!$("ladder-theme").innerHTML.includes('过时响应'));
  assert.ok($("ladder-theme-status").textContent.includes('题材取自 2026-10-13'));
  candidateWaits.clear();
  $("ladder-theme-date").value = '2026-10-14';
  await evaluate("loadLadderThemeCandidates()");
  assert.equal($("ladder-theme").value, 'all');
  assert.ok($("ladder-theme-status").textContent.includes('所选日期没有「人工<智能>」'));
  assert.equal(evaluate("ladderDays.length"), dates.length);
  console.log("Ladder multi-day frontend checks passed");
  evaluate("clearTimeout(ladderScrollTimer)");
})().catch((error) => { console.error(error); process.exitCode = 1; });
