const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync('web/chart.js', 'utf8'), context);
const run = source => vm.runInContext(source, context);
context.bars = [
  {trade_date: '2026-10-19', open: null, high: null, low: null, close: null, ma: {}},
  {trade_date: '2026-10-20', open: 9, high: 11, low: 8, close: 10, preclose: 9, ma: {5: 9, 10: null}},
  {trade_date: '2026-10-21', open: 11, high: 13, low: 10, close: 12, preclose: 10, ma: {5: 11}},
];
const original = JSON.stringify(context.bars);
run('const relative = relativeChartBars(bars)');
assert.equal(run('relative.baseDate'), '2026-10-20');
assert.equal(run('relative.baseClose'), 10);
assert.equal(run('relative.bars[0].close'), null);
assert.equal(run('relative.bars[1].close'), 0);
assert.ok(Math.abs(run('relative.bars[2].close') - 20) < 1e-9);
assert.ok(Math.abs(run('relative.bars[1].ma[5]') + 10) < 1e-9);
assert.equal(run('relative.bars[1].ma[10]'), null);
assert.equal(JSON.stringify(context.bars), original, 'Actual prices must remain untouched');
run('const scaled = relativeChartBars(bars.map(bar => ({...bar, open: bar.open == null ? null : bar.open * 1000, high: bar.high == null ? null : bar.high * 1000, low: bar.low == null ? null : bar.low * 1000, close: bar.close == null ? null : bar.close * 1000})))');
assert.equal(run('scaled.bars[2].close'), run('relative.bars[2].close'), 'Absolute share price must not affect relative height');
assert.equal(run('relativeChartBars([{close: null}, {close: 0}, {close: Infinity}]).baseClose'), null);
assert.equal(run('relativeChartBars([{close: null}, {close: 0}, {close: Infinity}]).bars.every(bar => bar.close === null)'), true);
assert.deepEqual(JSON.parse(run('JSON.stringify(chartCompareRange([]))')), {low: -.5, high: .5});
assert.deepEqual(JSON.parse(run('JSON.stringify(chartCompareRange([{low: null, high: Infinity}]))')), {low: -.5, high: .5});
assert.deepEqual(JSON.parse(run('JSON.stringify(chartCompareRange([{low: -2, high: 3, ma: {60: 900}}]))')), {low: -2.5, high: 3.5}, 'Long moving averages must not flatten candles');
context.escapeHtml = value => String(value);
run(`chartState = {
  code: 'sh.600000', payload: {name: '主图', ma_windows: [5]}, visible: bars,
  compareScale: 'independent', comparisons: new Map([['sz.000001', {
    code: 'sz.000001', name: '对比', payload: {ma_windows: [5], bars: [
      {trade_date: '2026-10-20', open: 10, close: 10, high: 11, low: 9, ma: {}},
      {trade_date: '2026-10-21', open: 20, close: 40, high: 42, low: 18, ma: {}}
    ]}
  }]])
}; renderRelativeChart(1000, 268);`);
assert.ok(run('chartState.layout.high - chartState.layout.low < (chartState.comparisons.get("sz.000001").layout.high - chartState.comparisons.get("sz.000001").layout.low) / 4'), 'A volatile stock must not compress another stock');
assert.equal(run('chartState.layout.geometry.priceBottom - chartState.layout.geometry.priceTop'), 196);
assert.equal(run('chartState.layout.geometry.priceTop'), run('chartState.comparisons.get("sz.000001").layout.geometry.priceTop'), 'Desktop charts share a row');
assert.ok(run('chartState.comparisons.get("sz.000001").layout.plotLeft > chartState.layout.plotRight'), 'Desktop charts occupy separate columns');
run('chartState.compareScale = "shared"; renderRelativeChart(1000, 268);');
assert.equal(run('chartState.layout.high'), run('chartState.comparisons.get("sz.000001").layout.high'));
assert.equal(run('chartState.layout.low'), run('chartState.comparisons.get("sz.000001").layout.low'));
run('renderRelativeChart(600, 508);');
assert.equal(run('chartState.layout.plotLeft'), run('chartState.comparisons.get("sz.000001").layout.plotLeft'));
assert.equal(run('chartState.comparisons.get("sz.000001").layout.geometry.priceTop - chartState.layout.geometry.priceTop'), 240, 'Narrow screens stack charts without compressing them');
console.log('Relative chart checks passed: normalization, gaps, actual prices, independent/shared scales, two columns and readable mobile rows.');
