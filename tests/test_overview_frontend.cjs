// node tests/test_overview_frontend.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const elements = new Map();
const $ = id => {
  if (!elements.has(id)) elements.set(id, {value: '', checked: false, innerHTML: '', textContent: '', setAttribute() {}});
  return elements.get(id);
};
const alerts = [];
const context = vm.createContext({$, console, Map, Set, Date, URLSearchParams, encodeURIComponent,
  document: {querySelectorAll: () => []}, boot() {}, clearAlerts() {},
  formatDateTime: v => v, showAlert: (...args) => alerts.push(args),
  escapeHtml: v => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c])),
});
const evaluate = code => vm.runInContext(code, context);
evaluate(fs.readFileSync('web/stock-sectors.js', 'utf8'));
evaluate(fs.readFileSync('web/overview.js', 'utf8'));
evaluate('queueStockSectors = () => {}');
$('overview-level').value = '1';
$('overview-exclude-st').checked = true;
$('overview-multi').checked = true;
context.items = [
  {code: 'sh.600001', name: '<甲>', consecutive: 4, amount: null},
  {code: 'sh.600002', name: '乙', consecutive: 2, amount: 1e8},
  {code: 'sh.600003', name: '首板', consecutive: 1},
  {code: 'sh.600004', name: 'ST', consecutive: 8, is_st: true},
  {code: 'sh.600005', name: '缺二级', consecutive: 3},
  {code: 'sh.600006', name: '查询失败', consecutive: 2},
];
evaluate(`overviewSnapshot = {items};
  const first = {id: 'em:first', name: '电子', kind: 'industry', level: 1};
  const second = {id: 'em:second', name: '半导体', kind: 'industry', level: 2};
  for (const code of ['sh.600001', 'sh.600002']) stockSectorCache.set(code, {profile: {fetched_at: '2026-10-16T08:00:00Z', sectors: [first, second, second]}});
  stockSectorCache.set('sh.600005', {profile: {fetched_at: '2026-10-16T08:00:00Z', stale: true, sectors: [first]}});
  stockSectorCache.set('sh.600006', {error: '断网'});
  renderOverview();`);
assert.equal(evaluate('overviewItems().length'), 4);
assert.equal(evaluate('overviewGroups(overviewItems(), 1).find(g => g.id === "em:first").items.length'), 3);
assert.equal(evaluate('overviewGroups(overviewItems(), 2).find(g => g.id === "em:second").multi'), 2);
assert.equal(evaluate('overviewGroups(overviewItems(), 2).find(g => g.id === "em:second").height'), 4);
assert.ok($('overview-sector-status').textContent.includes('失败 1 只'));
assert.ok($('overview-sector-status').textContent.includes('1 只使用旧缓存'));
assert.ok($('overview-stocks').innerHTML.includes('&lt;甲&gt;'));
assert.ok($('overview-stocks').innerHTML.includes('—'));
evaluate('overviewSector = overviewGroups(overviewItems(), 1).find(g => g.id === "em:first"); renderOverview()');
assert.ok($('overview-detail-title').textContent.includes('(3)'));
assert.ok($('overview-subsectors').innerHTML.includes('半导体'));
assert.ok($('overview-subsectors').innerHTML.includes('暂无2级行业'));
evaluate('overviewParent = overviewSector; overviewSector = overviewGroups(overviewParent.items, 2).find(g => g.id === "em:second"); renderOverview()');
assert.equal($('overview-detail-title').textContent, '电子 / 半导体 · 连板股 (2)');
assert.ok(!$('overview-stocks').innerHTML.includes('缺二级'));
$('overview-search').value = '不存在';
evaluate('renderOverview()');
assert.ok($('overview-sectors').innerHTML.includes('没有匹配'));
$('overview-search').value = '';
$('overview-multi').checked = false;
assert.equal(evaluate('overviewItems().length'), 5);
evaluate('overviewSnapshot = {items: [], trade_date: "2026-10-16"}; renderOverview()');
assert.ok($('overview-sectors').innerHTML.includes('暂无符合条件'));
(async () => {
  context.api = async () => { throw new Error('网络中断'); };
  $('overview-date').value = '2026-10-15';
  await evaluate('loadOverview()');
  assert.equal($('overview-date').value, '2026-10-16');
  assert.equal($('overview-refresh').disabled, false);
  assert.equal(evaluate('overviewSnapshot.trade_date'), '2026-10-16');
  assert.ok(alerts.at(-1)[1].includes('网络中断'));
  console.log('Overview aggregation, hierarchy, missing data and failure checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
