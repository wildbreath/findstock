// node tests/test_watch_add_frontend.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const screen = vm.createContext({
  boot() {}, el: {}, showAlert() {}, escapeHtml: String,
  api: async () => ({}),
});
const runScreen = (code) => vm.runInContext(code, screen);
runScreen(fs.readFileSync("web/screen.js", "utf8"));
runScreen("refreshStarButtons = () => {}; state.selectedDate = '2026-10-16'");
const chart = vm.createContext({});
const runChart = (code) => vm.runInContext(code, chart);
runChart(fs.readFileSync("web/chart.js", "utf8"));
runChart("updateChartStar = () => {};");

(async () => {
  let payload;
  screen.addWatchWithCategories = async (item) => { payload = item; return null; };
  await runScreen("toggleWatch('sh.600825', '新华传媒', '2026-10-15')");
  assert.equal(runScreen("state.watched.size"), 0);
  assert.equal(payload.source_date, "2026-10-15");
  screen.addWatchWithCategories = async () => ({code: "sh.600825"});
  await runScreen("toggleWatch('sh.600825', '新华传媒')");
  assert.equal(runScreen("state.watched.has('sh.600825')"), true);
  let removed;
  screen.api = async (path, options) => { removed = {path, method: options.method}; };
  await runScreen("toggleWatch('sh.600825', '新华传媒')");
  assert.equal(removed.method, "DELETE");
  assert.equal(runScreen("state.watched.size"), 0);

  const changes = [];
  chart.onWatchChange = (...args) => changes.push(args);
  runChart(`chartState = {code: 'sh.600825', name: '新华传媒', watched: false,
    sourceDate: '2026-10-14', screenDate: '2026-10-15', onWatchChange};`);
  chart.addWatchWithCategories = async (item) => { payload = item; return null; };
  await runChart("toggleChartWatch()");
  assert.equal(runChart("chartState.watched"), false);
  assert.equal(changes.length, 0);
  assert.equal(payload.source_date, "2026-10-15");
  chart.addWatchWithCategories = async () => ({code: "sh.600825"});
  await runChart("toggleChartWatch()");
  assert.equal(runChart("chartState.watched"), true);
  assert.deepEqual(changes[0], ["sh.600825", true]);
  // 请求期间关闭图表仍可完成收藏，不访问已释放的图表状态。
  runChart("chartState.watched = false");
  chart.addWatchWithCategories = async () => {
    runChart("chartState = null");
    return {code: "sh.600825"};
  };
  await runChart("toggleChartWatch()");
  assert.equal(changes.length, 2);
  console.log("Watch add frontend checks passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
