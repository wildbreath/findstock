// node tests/test_stock_sectors_frontend.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const profile = {
  primary_sector_id: "eastmoney:BK1509", fetched_at: "2026-10-15T12:00:00Z",
  source_url: "https://emweb.securities.eastmoney.com/", sectors: [
    {id: "eastmoney:BK1509", code: "BK1509", name: "水产饲料", kind: "industry", level: 3},
    {id: "eastmoney:level1", code: "level1", name: "农林牧渔", kind: "industry", level: 1},
    {id: "eastmoney:level2", code: "level2", name: "饲料<制造>", kind: "industry", level: 2, reason: "<script>"},
    {id: "eastmoney:BK0967", code: "BK0967", name: "水产<概念>", kind: "theme", reason: "<script>"},
    {id: "eastmoney:other", code: "other", name: "其他隐藏", kind: "other", level: 1},
    {id: "eastmoney:unknown", code: "unknown", name: "未知层级", kind: "industry", level: null},
  ],
};
const context = vm.createContext({
  Map, console, profile, document: {querySelectorAll: () => []},
  formatDateTime: (value) => value,
  escapeHtml: (value) => String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]),
});
const evaluate = (code) => vm.runInContext(code, context);
evaluate(fs.readFileSync("web/stock-sectors.js", "utf8"));
assert.ok(evaluate("stockPrimarySector('sz.002696')").includes("行业读取中"));
evaluate("stockSectorCache.set('sz.002696', {profile})");
assert.ok(evaluate("stockPrimarySector('sz.002696')").includes("饲料&lt;制造&gt;"));
assert.ok(!evaluate("stockPrimarySector('sz.002696')").includes("水产饲料"));
const details = evaluate("stockSectorDetails('sz.002696')");
assert.ok(details.includes("当前归属") && details.includes("一级板块") && details.includes("二级板块"));
assert.ok(details.includes("所属板块（2）"));
for (const hidden of ["水产饲料", "水产&lt;概念&gt;", "其他隐藏", "未知层级", "题材"]) assert.ok(!details.includes(hidden));
assert.ok(details.includes("&lt;script&gt;") && !details.includes("<script>"));
assert.equal(JSON.stringify(evaluate("stockSectorNames('sz.002696')")), JSON.stringify(["农林牧渔", "饲料<制造>"]));
evaluate("stockSectorCache.set('sz.only-first', {profile: {...profile, sectors: profile.sectors.filter(s => s.level !== 2)}})");
assert.ok(evaluate("stockPrimarySector('sz.only-first')").includes("农林牧渔"));
evaluate("stockSectorCache.set('sz.only-third', {profile: {...profile, sectors: [profile.sectors[0]]}})");
assert.ok(evaluate("stockPrimarySector('sz.only-third')").includes("暂无一级、二级板块"));
assert.ok(evaluate("stockSectorDetails('sz.only-third')").includes("所属板块（0）"));
profile.stale = true;
assert.ok(evaluate("stockSectorDetails('sz.002696')").includes("旧缓存"));
let active = 0, peak = 0, calls = [], fail = true;
context.api = async (path) => {
  calls.push(path);
  peak = Math.max(peak, ++active);
  await new Promise(setImmediate);
  active--;
  if (fail && path.includes("000001")) throw new Error("upstream <error>");
  return profile;
};
(async () => {
  evaluate("queueStockSectors('sz.000001'); queueStockSectors('sz.000001'); queueStockSectors('sz.000002'); queueStockSectors('sz.000003'); queueStockSectors('sz.000004')");
  for (let i = 0; i < 8; i++) await new Promise(setImmediate);
  assert.equal(calls.length, 4);
  assert.ok(peak <= 3);
  assert.ok(evaluate("stockSectorDetails('sz.000001')").includes("upstream &lt;error&gt;"));
  assert.ok(evaluate("stockPrimarySector('sz.000001')").includes("行业读取失败"));
  fail = false;
  evaluate("queueStockSectors('sz.000001', true)");
  for (let i = 0; i < 4; i++) await new Promise(setImmediate);
  assert.ok(evaluate("stockSectorCache.get('sz.000001').profile"));
  assert.ok(calls.at(-1).endsWith("?refresh=true"));
  const completed = calls.length;
  evaluate("queueStockSectors('sz.000001')");
  assert.equal(calls.length, completed); // 回退旧缓存不会被表格重绘反复请求。
  const queries = [], nodes = ['primary', 'details'].map(part => ({
    dataset: {sectorCode: 'sz.000001', sectorPart: part}, isConnected: true, open: true, writes: 0, focused: 0,
    contains() { return true; },
    set innerHTML(markup) { this.markup = markup; this.writes++; },
    querySelector() { return {focus: () => this.focused++}; },
  }));
  context.document.querySelectorAll = selector => {
    queries.push(selector);
    return selector === '.stock-sector-details' ? nodes.slice(1).filter(node => node.isConnected)
      : selector === '[data-sector-code="sz.000001"]' ? nodes : [];
  };
  evaluate("updateStockSectorNodes('sz.000001'); updateStockSectorNodes('sz.000001')");
  assert.deepEqual(queries, Array(2).fill('[data-sector-code="sz.000001"]'), 'Sector results only select matching stock nodes');
  assert.ok(nodes.every(node => node.writes === 1), 'Unchanged sector markup is retained');
  assert.equal(nodes[1].focused, 1);
  assert.equal(nodes[1].open, true);
  const observed = [], removed = [];
  context.IntersectionObserver = class {
    observe(node) { observed.push(node); }
    unobserve(node) { removed.push(node); }
    disconnect() { assert.fail('Existing sector observers must stay registered'); }
  };
  evaluate('observeStockSectors(); observeStockSectors()');
  assert.equal(observed.length, 1);
  nodes[1].isConnected = false;
  evaluate('observeStockSectors()');
  assert.ok(removed.includes(nodes[1]));
  const pending = [];
  context.api = path => new Promise(resolve => pending.push({path, resolve}));
  evaluate("stockSectorCache.clear(); ['7', '8', '9', '10', '11', '12'].forEach(code => queueStockSectors('sz.' + code)); queueStockSectors('sz.12', false, true)");
  assert.equal(pending.length, 3);
  pending[0].resolve(profile);
  await new Promise(setImmediate);
  assert.ok(pending[3].path.includes('sz.12'), 'Visible stocks move ahead of background candidate queries');
  for (let index = 1; index < 6; index++) {
    pending[index].resolve(profile);
    await new Promise(setImmediate);
  }
  assert.equal(evaluate('stockSectorActive'), 0);
  assert.equal(evaluate('stockSectorQueue.length'), 0);
  console.log("Stock sector frontend checks passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
