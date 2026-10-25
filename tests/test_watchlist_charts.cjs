// node tests/test_watchlist_charts.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const day = '2026-10-21';
const nodes = Array.from({length: 7}, (_, index) => ({
  dataset: {code: `sz.${String(index + 1).padStart(6, '0')}`, date: index === 6 ? '' : day},
  isConnected: true, title: '', writes: 0,
  set innerHTML(markup) { this.markup = markup; this.writes++; },
}));
const requests = [], observers = [];
const root = {querySelectorAll(selector) {
  const code = selector.match(/data-code=("[^"]*")/);
  const date = selector.match(/data-date=("[^"]*")/);
  return nodes.filter(node => node.isConnected && (!code || node.dataset.code === JSON.parse(code[1])) &&
    (!date || node.dataset.date === JSON.parse(date[1])));
}};
class Observer {
  constructor(callback) { this.callback = callback; this.observes = []; this.removed = []; observers.push(this); }
  observe(node) { this.observes.push(node); }
  unobserve(node) { this.removed.push(node); }
  emit(entries) { this.callback(entries.map(([target, isIntersecting]) => ({target, isIntersecting}))); }
}
const context = vm.createContext({
  Map, Set, Date, IntersectionObserver: Observer, $: () => root,
  escapeHtml: value => String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char])),
  api: path => new Promise((resolve, reject) => requests.push({path, resolve, reject})),
});
const run = source => vm.runInContext(source, context);
run(fs.readFileSync('web/chart.js', 'utf8'));
run(fs.readFileSync('web/watchlist-charts.js', 'utf8'));
context.bars = Array.from({length: 25}, (_, index) => ({trade_date: `2026-10-${String(index + 1).padStart(2, '0')}`,
  open: 10, close: index % 2 ? 11 : 9, high: 12, low: 8, ma: {60: 1000}}));
const mini = run(`renderMiniChart(bars, '${day}')`);
assert.equal((mini.match(/<rect /g) || []).length, 20);
assert.match(mini, /2026-10-02 至 2026-10-21/);
assert.ok(!mini.includes('2026-10-22') && !mini.includes('NaN') && !mini.includes('Infinity'));
assert.match(mini, /fill="#fff"/);
assert.match(mini, /fill="#159c5b"/);
assert.equal(run(`renderMiniChart([{trade_date: '${day}', open: null}], '${day}')`), '暂无日K');
assert.equal(run(`renderMiniChart([{trade_date: '${day}', open: Infinity, high: 12, low: 8, close: 10}], '${day}')`), '暂无日K');
const tick = () => new Promise(setImmediate);
(async () => {
  run('observeWatchCharts(); observeWatchCharts()');
  const observer = observers[0];
  assert.equal(observer.observes.length, 6, 'Repeated renders register only new charts with local data');
  assert.equal(nodes[6].markup, '本地暂无日K');
  assert.equal(requests.length, 0, 'Offscreen and missing-data cards never request bars');
  observer.emit(nodes.slice(0, 6).map(node => [node, true]));
  assert.equal(requests.length, 3);
  assert.equal(run('watchChartQueue.length'), 3);
  assert.ok(requests.every(({path}) => path.endsWith(`?limit=20&end=${day}`)));
  observer.emit([[nodes[3], false]]);
  nodes[4].isConnected = false;
  requests[0].resolve({bars: context.bars});
  await tick();
  assert.equal(requests.length, 4);
  assert.ok(requests[3].path.includes(nodes[5].dataset.code), 'Queued hidden and removed cards are skipped');
  assert.equal(run('watchChartActive'), 3);
  assert.match(nodes[0].markup, /<svg/);
  assert.equal(nodes[0].writes, 2);
  assert.ok(nodes.slice(1).every(node => node.writes === 1), 'Only the requested chart repaints');
  requests[1].reject(new Error('本地行情读取失败'));
  requests[2].resolve({bars: []});
  requests[3].resolve({bars: []});
  await tick();
  assert.equal(run('watchChartActive'), 0);
  assert.equal(nodes[1].markup, '日K未就绪');
  assert.equal(nodes[1].title, '本地行情读取失败');
  assert.equal(nodes[2].markup, '暂无日K');
  run('observeWatchCharts()');
  assert.equal(requests.length, 4, 'Saved charts and errors are cached until refresh');
  assert.ok(observer.removed.includes(nodes[4]), 'Removed cards release their observers');
  observer.emit([[nodes[3], true], [nodes[3], true]]);
  assert.equal(requests.length, 5, 'A hidden queued chart restarts once on reentry');
  run('clearWatchCharts(); observeWatchCharts()');
  assert.equal(requests.length, 6);
  assert.equal(nodes[0].markup, '日K加载中');
  requests[4].resolve({bars: context.bars});
  await tick();
  assert.equal(nodes[3].markup, '日K加载中', 'An old request cannot overwrite refreshed state');
  requests[5].resolve({bars: []});
  await tick();
  observer.emit([[nodes[1], true]]);
  assert.equal(requests.length, 7, 'Refresh retries a failed chart');
  requests[6].resolve({bars: context.bars});
  await tick();
  assert.match(nodes[1].markup, /<svg/);
  assert.equal(run('watchChartActive'), 0);
  console.log('Watchlist mini chart renderer, viewport queue, cache, refresh and error checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
