// node tests/test_watchlist_frontend.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const element = () => ({
  innerHTML: "", textContent: "", hidden: false, disabled: false,
  style: {setProperty(key, value) { this[key] = value; }},
  querySelector: () => null, querySelectorAll: () => [], focus() {},
});
const el = Object.fromEntries([
  "categoryChips", "watchlistTitle", "watchlistSummary", "watchlistEmpty",
  "watchlistList", "watchlistSearch", "watchlistSearchResults", "watchlistZoom",
].map((key) => [key, element()]));
const alerts = [];
const context = vm.createContext({
  el, boot() {}, observeWatchCharts() {}, clearWatchCharts() {}, formatDateTime: (value) => value,
  showAlert: (...args) => alerts.push(args),
  escapeHtml: (value) => String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]),
});
const run = (code) => vm.runInContext(code, context);
run(fs.readFileSync("web/watchlist.js", "utf8"));
const zoomStorage = new Map();
context.localStorage = {setItem: (key, value) => zoomStorage.set(key, value)};
run("setWatchlistZoom('70')");
assert.equal(el.watchlistZoom.value, '70');
assert.equal(el.watchlistList.style['--watchlist-zoom'], .7);
assert.equal(zoomStorage.get('findstock.watchlist-zoom'), '70');
run("setWatchlistZoom('999')");
assert.equal(el.watchlistZoom.value, '100');
assert.equal(el.watchlistList.style['--watchlist-zoom'], 1);
context.localStorage = {setItem() { throw new Error('Storage unavailable'); }};
run("setWatchlistZoom('50')");
assert.equal(el.watchlistList.style['--watchlist-zoom'], .5, 'Zoom works when browser storage is unavailable');
run(`state.categories = [{id: 1, name: '突破<观察>', count: 1}, {id: 2, name: '低吸', count: 0}];
  state.items = [
    {code: 'sh.600001', name: '测试股票', note: '支撑位', categories: [{id: 1, name: '突破<观察>'}]},
    {code: 'sz.000002', name: '未归类', note: null, categories: []}
  ];`);
assert.equal(run("visibleItems().length"), 2);
assert.equal(run("state.filter = 'uncategorized'; visibleItems()[0].code"), "sz.000002");
assert.equal(run("state.filter = 1; state.search = '支撑'; visibleItems().length"), 1);
assert.equal(run("state.search = '000002'; visibleItems().length"), 1); // 全市场搜索不筛掉自选卡片。
run("renderList()");
assert.equal(el.watchlistEmpty.hidden, true);
run("state.filter = 2; renderList()");
assert.equal(el.watchlistEmpty.hidden, false);
assert.match(el.watchlistEmpty.innerHTML, /这个分类里还没有股票/);
run("state.filter = null; state.search = ''; renderCategoryBar()");
assert.match(el.categoryChips.innerHTML, /突破&lt;观察&gt;/);
assert.ok(!el.categoryChips.innerHTML.includes("data-delete-category"));
run("state.managing = true; renderCategoryBar()");
assert.match(el.categoryChips.innerHTML, /data-delete-category/);
run("state.noteDrafts.set('sh.600001', {note: '<未保存>', note_highlights: []}); renderList()");
assert.match(el.watchlistList.innerHTML, /&lt;未保存&gt;/);
assert.ok(!el.watchlistList.innerHTML.includes("data-remove-category"));
assert.ok(!el.watchlistList.innerHTML.includes("筛选日"));
assert.ok(!el.watchlistList.innerHTML.includes("加入 "));
assert.match(run("highlightedNote('<观察😀突破>', [[1, 4]])"), /&lt;<mark>观察😀<\/mark>突破&gt;/);
assert.equal(run("JSON.stringify(removeHighlights([[0,8]], 2, 5))"), '[[0,2],[5,8]]');
assert.equal(run("JSON.stringify(removeHighlights([[0,2],[4,8]], 2, 5))"), '[[0,2],[5,8]]');
assert.equal(run("JSON.stringify(removeHighlights([[0,8]], 0, 8))"), '[]');
assert.equal(run("JSON.stringify(cleanNote({note:'  看😀突破  ',note_highlights:[[3,6]]}))"), '{"note":"看😀突破","note_highlights":[[1,4]]}');

const count = {};
context.checkbox = {value: "2", checked: true};
context.event = {target: {closest: (selector) => selector === ".watch-card"
  ? {querySelector: () => count} : context.checkbox}};
run("state.openPicker = 'sh.600001'; state.pickerIds = currentCategoryIds('sh.600001'); onListChange(event)");
assert.equal(run("state.pickerIds.size"), 2);
assert.equal(run("state.items[0].categories.length"), 1); // 勾选不发请求，不覆盖已保存分类。
assert.equal(count.textContent, 2);
run("closePicker()");
assert.equal(run("state.items[0].categories.length"), 1);

(async () => {
  const calls = [];
  context.api = async (path, options) => {
    calls.push([path, JSON.parse(options.body)]);
    return {categories: [{id: 2, name: "低吸"}]};
  };
  await run("setCategories('sh.600001', [2])");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], {category_ids: [2]});
  assert.equal(run("state.categories[0].count"), 0);
  assert.equal(run("state.categories[1].count"), 1);
  assert.equal(run("state.openPicker"), null);
  assert.equal(el.watchlistSearch.disabled, false);
  context.api = async () => { throw new Error("测试网络故障"); };
  run("state.openPicker = 'sh.600001'; state.pickerIds = new Set([1, 2])");
  await run("setCategories('sh.600001', [1, 2])");
  assert.equal(run("state.openPicker"), "sh.600001");
  assert.equal(run("state.pickerIds.size"), 2);
  assert.equal(run("state.items[0].categories[0].id"), 2);
  assert.equal(run("state.savingCategories"), false);
  assert.equal(alerts.at(-1)[0], "error");

  // 分类内排序只交换可见位置，其他分类的股票不动；失败恢复。
  run(`state.openPicker = null; state.noteDrafts.clear(); state.filter = 2;
    state.items = [
      {code:'sh.600001',name:'甲',categories:[{id:2,name:'低吸'}]},
      {code:'sh.600003',name:'隐藏',categories:[]},
      {code:'sz.000002',name:'乙',categories:[{id:2,name:'低吸'}]}];`);
  context.api = async (path, options) => {
    calls.push([path, JSON.parse(options.body)]);
    return {};
  };
  await run("reorderStock('sz.000002', 'sh.600001')");
  assert.deepEqual(calls.at(-1), ['/api/watchlist/order', {codes:['sz.000002','sh.600003','sh.600001']}]);
  context.api = async () => { throw new Error('保存失败'); };
  await run("reorderStock('sz.000002', 'sh.600001', true)");
  assert.equal(run("state.items.map(item => item.code).join(',')"), 'sz.000002,sh.600003,sh.600001');

  // 慢的旧搜索不能覆盖最新结果。
  let resolveOld;
  context.api = async (path) => path.includes('old') ? new Promise(resolve => {resolveOld = resolve;}) :
    [{code:'sh.600519',name:'贵州茅台',board_label:'沪市主板'}];
  run("state.search = 'old'");
  const older = run("searchMarket()");
  run("state.search = 'new'");
  await run("searchMarket()");
  resolveOld([{code:'sz.000001', name:'旧结果'}]);
  await older;
  assert.equal(run("state.searchResults[0].name"), '贵州茅台');
  assert.match(el.watchlistSearchResults.innerHTML, /加入自选/);

  // 同一股票的备注保存串行执行，期间新输入最终会再次保存。
  let resolveSave;
  const noteCalls = [];
  context.api = async (path, options) => {
    const payload = JSON.parse(options.body); noteCalls.push(payload);
    if (noteCalls.length === 1) await new Promise(resolve => {resolveSave = resolve;});
    return payload;
  };
  run("state.noteDrafts.set('sh.600001', {note:'第一次', note_highlights:[]})");
  const saving = run("saveNote('sh.600001')");
  run("state.noteDrafts.set('sh.600001', {note:'最新思路', note_highlights:[]})");
  const same = run("saveNote('sh.600001')");
  resolveSave();
  await Promise.all([saving, same]);
  assert.deepEqual(noteCalls.map(item => item.note), ['第一次', '最新思路']);
  assert.equal(run("state.noteDrafts.size"), 0);
  assert.equal(run("state.noteSaves.size"), 0);

  // 列表旧响应迟于备注保存时，重新读取，不能把新思路显示回旧值。
  let resolveList;
  let listReads = 0;
  context.api = async (path, options) => {
    if (options) return JSON.parse(options.body);
    listReads++;
    if (listReads === 1) return new Promise(resolve => {resolveList = resolve;});
    return {items:[{code:'sh.600001', name:'甲', note:'保存后的思路', note_highlights:[[0,2]], categories:[]}], categories:[]};
  };
  const oldList = run("loadWatchlist()");
  run("state.noteDrafts.set('sh.600001', {note:'保存后的思路', note_highlights:[[0,2]]})");
  await run("saveNote('sh.600001')");
  resolveList({items:[{code:'sh.600001', name:'甲', note:'旧思路', categories:[]}], categories:[]});
  await oldList;
  assert.equal(listReads, 2);
  assert.equal(run("state.items[0].note"), '保存后的思路');
  assert.equal(run("JSON.stringify(state.items[0].note_highlights)"), '[[0,2]]');

  // 删除未完成前不提交可能含已删除股票的顺序。
  run("state.filter = null; state.items.push({code:'sz.000002',name:'乙',categories:[]}); state.removing.add('sh.600001')");
  let guardedSortCalls = 0;
  context.api = async () => { guardedSortCalls++; return {}; };
  await run("reorderStock('sz.000002', 'sh.600001')");
  assert.equal(guardedSortCalls, 0);
  run("state.removing.clear()");
  await run("reorderStock('sz.000002', 'sh.600001')");
  assert.equal(guardedSortCalls, 1);
  console.log("Watchlist frontend checks passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
