// node tests/test_ladder_chart_queue.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const day = '2026-10-16';
const nodes = Array.from({length: 6}, (_, index) => ({
  dataset: {code: `sz.${String(index + 1).padStart(6, '0')}`, date: day},
  isConnected: true, title: '', writes: 0,
  set innerHTML(markup) { this.markup = markup; this.writes++; },
  get innerHTML() { return this.markup; },
}));
const queries = [], requests = [], observers = [];
const root = {querySelectorAll(selector) {
  queries.push(selector);
  const code = selector.match(/data-code=("[^"]*")/);
  const date = selector.match(/data-date=("[^"]*")/);
  return nodes.filter(node => node.isConnected && (!code || node.dataset.code === JSON.parse(code[1])) &&
    (!date || node.dataset.date === JSON.parse(date[1])));
}};
class Observer {
  constructor(callback) { this.callback = callback; this.observes = []; this.removed = []; observers.push(this); }
  observe(node) { this.observes.push(node); }
  unobserve(node) { this.removed.push(node); }
  disconnect() { assert.fail('Existing chart observers must stay registered'); }
  emit(entries) { this.callback(entries.map(([target, isIntersecting]) => ({target, isIntersecting}))); }
}
const context = vm.createContext({
  console, Map, Set, Date, IntersectionObserver: Observer, $: () => root, boot() {},
  escapeHtml: value => String(value).replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char])),
  api: path => new Promise((resolve, reject) => requests.push({path, resolve, reject})),
});
const evaluate = source => vm.runInContext(source, context);
evaluate(fs.readFileSync('web/chart.js', 'utf8'));
evaluate(fs.readFileSync('web/ladder.js', 'utf8'));
const tick = () => new Promise(setImmediate);
(async () => {
  evaluate('observeLadderCharts(); observeLadderCharts()');
  const observer = observers[0];
  assert.equal(observer.observes.length, nodes.length, 'Repeated render only registers new nodes');
  assert.ok(nodes.every(node => node.writes === 1), 'Unchanged placeholders are not rebuilt');
  observer.emit(nodes.map(node => [node, true]));
  assert.equal(requests.length, 3);
  assert.equal(evaluate('ladderChartQueue.length'), 3);
  observer.emit([[nodes[3], false], [nodes[4], false]]);
  queries.length = 0;
  requests[0].resolve({bars: [{trade_date: day, open: 10, close: 11, high: 12, low: 9}]});
  await tick();
  assert.equal(requests.length, 4);
  assert.ok(requests.at(-1).path.includes(nodes[5].dataset.code), 'Queued offscreen charts are skipped');
  assert.equal(evaluate(`ladderChartCache.has('${day}:sz.000004')`), false);
  assert.equal(evaluate(`ladderChartCache.has('${day}:sz.000005')`), false);
  assert.equal(queries.length, 1);
  assert.ok(queries[0].includes('data-code="sz.000001"') && queries[0].includes(`data-date="${day}"`));
  assert.equal(nodes[0].writes, 2);
  assert.ok(nodes[0].markup.includes('<svg'), 'The completed node contains its candle chart');
  assert.ok(nodes.slice(1).every(node => node.writes === 1), 'One response cannot redraw neighboring charts');
  evaluate('paintLadderCharts()');
  assert.equal(nodes[0].writes, 2, 'Completed chart markup is retained');
  requests[1].reject(new Error('本地没有行情'));
  requests[2].resolve({bars: []});
  requests[3].resolve({bars: []});
  await tick();
  assert.equal(evaluate('ladderChartActive'), 0);
  assert.equal(nodes[1].markup, '日K未就绪');
  observer.emit([[nodes[3], true], [nodes[3], true]]);
  assert.equal(requests.length, 5, 'Reentering restarts a canceled chart exactly once');
  const stale = requests[4];
  evaluate('ladderChartCache.clear(); observeLadderCharts()');
  assert.equal(requests.length, 6, 'Refreshing an active visible chart starts a fresh request');
  stale.resolve({bars: []});
  await tick();
  assert.equal(nodes[3].markup, '日K加载中', 'Old in-flight responses cannot overwrite refreshed state');
  requests[5].resolve({bars: []});
  await tick();
  assert.equal(nodes[3].markup, '暂无日K');
  nodes[4].isConnected = false;
  evaluate('observeLadderCharts()');
  assert.ok(observer.removed.includes(nodes[4]), 'Removed cards release their observers');
  assert.equal(evaluate('ladderChartActive'), 0);
  console.log('Ladder chart targeting, viewport queue, refresh and observer checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
