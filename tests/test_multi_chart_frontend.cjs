// node tests/test_multi_chart_frontend.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const context = vm.createContext({
  boot() {}, formatVolume: String,
  escapeHtml: value => String(value).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]),
});
const run = code => vm.runInContext(code, context);
run(fs.readFileSync("web/chart.js", "utf8"));
run(fs.readFileSync("web/multi-chart-interactions.js", "utf8"));
run(fs.readFileSync("web/multi-chart.js", "utf8"));
const valid = [{code: "sh.600825", name: "传媒<测试>", date: "2026-10-15"},
  {code: "sh.600825", name: "重复"}, {code: "sz.000002", name: "万科"},
  {code: "bad\"code", name: "invalid"}, null];
context.stocks = valid;
assert.equal(run("normalizeMultiStocks(stocks).length"), 2);
assert.equal(run("normalizeMultiStocks(stocks)[0].date"), "2026-10-15");
assert.equal(run("normalizeMultiStocks({}).length"), 0);
assert.equal(run("normalizeMultiStocks(Array.from({length: 20}, (_, i) => ({code: 'sh.' + String(600000 + i)}))).length"), 12);

const dates = ["2026-10-13", "2026-10-14", "2026-10-15"];
context.dates = dates;
context.bars = [
  {trade_date: dates[0], open: 10, close: 11, low: 9, high: 12, volume: 100, ma: {5: 10}},
  {trade_date: dates[2], open: 12, close: 11, low: 10, high: 13, volume: 200, ma: {5: 11}},
];
assert.equal(run("alignMultiBars(bars, dates)[1].close"), null);
assert.equal(run("alignMultiBars(bars, dates)[2].trade_date"), dates[2]);
assert.equal(run("alignMultiBars(bars, dates).length"), 3);
run("const aligned = alignMultiBars(bars, dates); const compact = buildLayout(380, aligned, MULTI_GEOMETRY)");
const svg = run("renderChartSvg(aligned, [5], compact, '传媒<测试>')");
assert.ok(svg.includes('viewBox="0 0 380 260"'));
assert.ok(svg.includes("传媒&lt;测试&gt;"));
assert.ok(!svg.includes("NaN") && !svg.includes("Infinity"));
assert.ok(!svg.includes('id="chart-crosshair"'));
const maPath = run("renderMaLines(aligned, [5], compact)");
assert.equal((maPath.match(/M/g) || []).length, 2); // 缺失日期前后的两段均线都保留。
const defaultSvg = run("renderChartSvg(bars, [5], buildLayout(800, bars), '原图', true)");
assert.ok(defaultSvg.includes('viewBox="0 0 800 520"'));
assert.ok(defaultSvg.includes('id="chart-crosshair"'));
run("multiState.dates = Array.from({length: 100}, (_, i) => String(i)); const a = {start: 40, count: 60}; const b = {start: 40, count: 60}; zoomMultiView(a, 100, .5, 0)");
assert.equal(run("a.count"), 30);
assert.equal(run("a.start"), 40); // 鼠标左端为缩放锚点。
assert.equal(run("b.count"), 60); // 另一只股票的状态不变。
run("zoomMultiView(a, 100, 100); clampMultiView(a)");
assert.equal(run("a.count"), 100);
assert.equal(run("a.start"), 0);
assert.equal(run("validMultiMarkerDate('2026-02-30')"), false);
assert.equal(run("validMultiMarkerDate('2024-02-29')"), true);
run("multiState.markers['sh.600825'] = [{date: '2026-10-13', label:'T0'}, {date:'2026-10-15', label:'T1'}]");
const marks = run("renderMultiMarkers('sh.600825', compact)");
assert.ok(marks.includes('data-marker="T0"') && marks.includes('data-marker="T1"'));
assert.equal(run("renderMultiMarkers('sz.000002', compact)"), "");
console.log("Multi chart frontend checks passed");
