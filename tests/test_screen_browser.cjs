// Run with Node and Playwright available via NODE_PATH; no live database is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {chromium} = require('playwright');

const number = (name, label, value, extra = {}) => ({name, label, type: 'number', default: value, ...extra});
const node = number('offset', '检查交易日（相对基准日 T0）', 0, {role: 'node', min: -60, max: 60});
const bounds = [number('min', '下限 (%)', 0, {min: -20, max: 20}), number('max', '上限 (%)', 7, {min: -20, max: 20}),
  {name: 'inclusive', label: '含边界值', type: 'bool', default: false}];
const catalog = [
  {kind: 'pct_chg_range', title: '涨跌幅区间', hint: '指定交易日的涨跌幅', params: [node, number('span', '覆盖天数', 3, {role: 'span', min: 1, max: 10}), ...bounds]},
  {kind: 'volume_ratio_range', title: '成交量比值区间', hint: '较上一交易日的成交量比值', params: [node, ...bounds]},
  {kind: 'not_st', title: '排除 ST', hint: '排除 ST 股票', params: [node]},
  {kind: 'cumulative_pct_chg_range', title: '累计涨跌幅区间', hint: '按每日涨跌幅复利累计', params: [node, number('span', '覆盖天数', 3, {role: 'span', min: 1, max: 10}), number('min', '下限 (%)', 0, {min: -50, max: 100}), number('max', '上限 (%)', null, {min: -50, max: 100}), {name: 'inclusive', type: 'bool', default: false}]},
  {kind: 'close_price_range', title: '收盘价区间', hint: '收盘价（元）', params: [node, number('min', '下限 (元)', null, {min: 0, max: 10000}), number('max', '上限 (元)', null, {min: 0, max: 10000}), {name: 'inclusive', type: 'bool', default: false}]},
  {kind: 'amount_range', title: '成交额区间', hint: '成交额（万元）', params: [node, number('min', '下限 (万元)', null, {min: 0, max: 1000000}), number('max', '上限 (万元)', null, {min: 0, max: 1000000}), {name: 'inclusive', type: 'bool', default: false}]},
  {kind: 'listed_min_days', title: '上市时间要求', hint: '至少上市 N 个交易日', params: [number('days', '至少上市 (交易日)', 3, {min: 1, max: 250})]},
];
const condition = kind => ({kind, params: Object.fromEntries(catalog.find(c => c.kind === kind).params.map(p => [p.name, p.default]))});
let strategies = [
  {id: 1, name: '标准策略', conditions: [condition('pct_chg_range'), condition('volume_ratio_range'), condition('not_st')]},
  {id: 2, name: '<测试>涨幅', conditions: [condition('pct_chg_range')]},
];
let writes = [], failSave = false, screenBody, scanBody, exportBody, screenGate, scanGate;
let screenRequests = 0, scanRequests = 0, previewRequests = 0, previewGate, previewFailure = false;
const root = path.resolve(__dirname, '../web');
const chartDates = [];
for (let day = new Date('2024-08-01T12:00:00Z'); day.toISOString().slice(0, 10) <= '2026-10-16'; day.setUTCDate(day.getUTCDate() + 1)) {
  if (![0, 6].includes(day.getUTCDay())) chartDates.push(day.toISOString().slice(0, 10));
}
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const filename = pathname === '/screen' || pathname === '/screen/stocks' ? 'index.html' : pathname === '/screen/strategies' ? 'strategy.html' : pathname.replace(/^\/static\//, '');
  const target = path.resolve(root, filename);
  if (!target.startsWith(root + path.sep) || !fs.existsSync(target)) { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
  response.end(fs.readFileSync(target));
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1050}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.dismiss());
    await page.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      const reply = (body, status = 200) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify(body)});
      if (url.pathname === '/api/strategy-catalog') return reply({conditions: catalog});
      if (url.pathname === '/api/strategies/preview') {
        previewRequests++;
        const conditions = request.postDataJSON().conditions;
        if (previewGate) { const gate = previewGate; previewGate = null; gate.started(); await gate.release; }
        if (previewFailure) { previewFailure = false; return reply({error: {message: '预览暂时不可用'}}, 503); }
        const first = Math.min(-4, ...conditions.map(c => c.kind === 'listed_min_days' ? 0 : (c.params.offset || 0) - (c.params.span || 1)));
        const last = Math.max(2, ...conditions.map(c => c.params.offset || 0));
        return reply({status: 'ok', signature: JSON.stringify(conditions), conflicts: [], bars: Array.from({length: last - first + 1}, (_, index) => ({offset: first + index, open: 20 + index * .3, close: 20.2 + index * .3, high: 20.5 + index * .3, low: 19.8 + index * .3, pct_chg: 1, volume: 1000000 + index * 100000, amount: 2000 + index * 200})), checks: conditions.map((c,index)=>({index, passed: true, detail: `条件 ${index + 1} 联合校验通过`}))});
      }

      if (/^\/api\/strategies(?:\/\d+)?$/.test(url.pathname)) {
        if (method === 'GET') return reply(strategies);
        writes.push({method, body: request.postDataJSON()});
        if (failSave) return reply({error: {message: '保存网络中断'}}, 500);
        const id = Number(url.pathname.split('/').pop());
        if (method === 'DELETE') { strategies = strategies.filter(s => s.id !== id); return reply({removed: true}); }
        const item = {...request.postDataJSON(), id: method === 'POST' ? 3 : id};
        strategies = strategies.filter(s => s.id !== item.id).concat(item);
        return reply(item, method === 'POST' ? 201 : 200);
      }
      if (url.pathname === '/api/data/coverage') return reply({trading_days: 30, calendar_start: '2026-09-01', calendar_end: '2026-10-30', bar_end: '2026-10-16'});
      if (url.pathname === '/api/calendar') return reply({days: [{trade_date: '2026-10-16', is_open: true}]});
      if (url.pathname === '/api/screen/window') return reply({nodes: [{offset: 0, symbol: 'T0', trade_date: '2026-10-16'}]});
      if (url.pathname === '/api/watchlist') return reply({codes: []});
      if (url.pathname.endsWith('/chart')) {
        assert.equal(method, 'GET');
        const end = url.searchParams.get('end') || chartDates.at(-1);
        return reply({code: url.pathname.split('/')[3], name: '测试股票', board_label: '主板', ma_windows: [],
          bars: chartDates.filter(day => day <= end).slice(-400).map(trade_date => ({
            trade_date, open: 10, close: 11, high: 12, low: 9, volume: 100, pct_chg: 10, ma: {},
          }))});
      }
      if (url.pathname === '/api/data/sync/status') return reply({is_running: false});
      if (url.pathname === '/api/screen') {
        screenRequests++;
        screenBody = request.postDataJSON();
        if (screenGate) { screenGate.started(); await screenGate.release; }
        return reply({selected_date: screenBody.date, hit_count: 0, hits: [], warnings: [], window: {d2: screenBody.date}});
      }
      if (url.pathname === '/api/screen/scan') {
        scanRequests++;
        scanBody = request.postDataJSON();
        if (scanGate) { scanGate.started(); await scanGate.release; }
        return reply({month: scanBody.month, scanned_days: 1, skipped_days: 0, hit_count: 0, hits: []});
      }
      if (url.pathname.endsWith('/export')) {
        exportBody = request.postDataJSON();
        return route.fulfill({status: 200, contentType: 'text/csv', body: 'code,name\n'});
      }
      throw new Error(`Unexpected API: ${method} ${url.pathname}`);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const url = base + '/screen/strategies';
    await page.goto(url);
    await page.waitForFunction(() => window.__findstockBooted && document.querySelector('#condition-list .condition-block'));
    await page.waitForFunction(() => document.querySelector('#strategy-map').dataset.previewState === 'ok');
    const blocks = page.locator('#condition-list .condition-block');
    assert.equal(await blocks.count(), 3);
    assert.equal(await page.locator('#strategy-guide-list dt').count(), catalog.length);
    assert.equal(await page.locator('#strategy-guide').evaluate(node => node.open), true);
    assert.equal(await page.locator('#strategy-map svg').count(), 1);
    assert.equal(await page.locator('#strategy-map [data-map-index]').count(), 3);
    const mapped = page.locator('#strategy-map [data-map-index="0"]');
    assert.equal(await mapped.getAttribute('data-start'), '-2');
    assert.equal(await mapped.getAttribute('data-end'), '0');
    assert.equal(await mapped.getAttribute('data-reference'), '-3');
    assert.match(await mapped.locator('.strategy-map-row-title').textContent(), /T-2 至 T0（含首尾）.*每日涨跌幅/);
    const volumeRow = page.locator('[data-map-index="1"]');
    assert.match(await volumeRow.locator('.strategy-map-row-title').textContent(), /T0 成交量 ÷ T-1 成交量/);
    assert.equal(await volumeRow.locator('.strategy-map-row-detail').textContent(), '要求：大于 0 倍，小于 7 倍');
    const completeTexts = await page.evaluate(() => [
      {kind: 'volume_ratio_range', params: {offset: -1, min: 1.7, max: 3, inclusive: false}},
      {kind: 'pct_chg_range', params: {offset: 1, span: 1, min: 0, max: 4, inclusive: true}},
      {kind: 'volume_ratio_range', params: {offset: 0, min: 2, max: null, inclusive: true}},
      {kind: 'close_price_range', params: {offset: 0, min: null, max: 30, inclusive: false}},
      {kind: 'close_price_range', params: {offset: 0, min: 15, max: 15, inclusive: true}},
      {kind: 'amount_range', params: {offset: 0, min: null, max: null}},
      {kind: 'listed_min_days', params: {days: 30}},
      {kind: 'not_st', params: {offset: -2}},
    ].map(condition => strategyMapConditionText(strategyMapRows([condition])[0])));
    assert.deepEqual(completeTexts, [
      {subject: 'T-1 成交量 ÷ T-2 成交量', requirement: '大于 1.7 倍，小于 3 倍'},
      {subject: 'T+1 的日涨跌幅', requirement: '不低于 0%，不高于 +4%'},
      {subject: 'T0 成交量 ÷ T-1 成交量', requirement: '不低于 2 倍，上限不限'},
      {subject: 'T0 收盘价（元）', requirement: '下限不限，小于 30 元'},
      {subject: 'T0 收盘价（元）', requirement: '等于 15 元'},
      {subject: 'T0 成交额（万元）', requirement: '上下限均不限'},
      {subject: '截至基准日 T0 的上市交易日数', requirement: '至少 30 个交易日'},
      {subject: 'T-2 的历史简称', requirement: '不含 ST 或 *ST'},
    ]);
    const startDate = blocks.first().locator('[data-role=range-start]');
    assert.equal(await startDate.inputValue(), '-2');
    assert.equal(await blocks.first().locator('input[data-param=span]').count(), 0);
    assert.match(await blocks.first().locator('[data-role=time-summary]').innerText(), /共 3 个交易日（含首尾）/);
    assert.doesNotMatch(await blocks.first().innerText(), /覆盖天数|前一天|后一天/);
    await startDate.selectOption('-1');
    assert.equal(await page.evaluate(() => state.conditions[0].params.span), 2);
    await blocks.first().locator('[data-role=node-offset]').selectOption('-10');
    assert.equal(await startDate.inputValue(), '-11');
    assert.equal(await page.evaluate(() => state.conditions[0].params.span), 2);
    await blocks.first().locator('[data-role=node-offset]').selectOption('0');
    await startDate.selectOption('-2');
    await page.waitForFunction(() => strategyMapPreview.data?.signature === JSON.stringify(state.conditions));
    const spans = await page.evaluate(() => strategyMapRows([
      {kind: 'pct_chg_range', params: {offset: 2, span: 3}},
      {kind: 'volume_ratio_range', params: {offset: -2}},
      {kind: 'cumulative_pct_chg_range', params: {offset: 0, span: 3}},
      {kind: 'close_price_range', params: {offset: -1, span: 8}},
      {kind: 'amount_range', params: {offset: 1}},
      {kind: 'listed_min_days', params: {days: 250}},
      {kind: 'not_st', params: {offset: 2}},
    ]).map(row => [row.start, row.end, row.reference]));
    assert.deepEqual(spans, [[0, 2, -1], [-2, -2, -3], [-2, 0, -3], [-1, -1, null], [1, 1, null], [0, 0, null], [2, 2, null]]);
    assert.equal(await page.evaluate(() => intervalText('volume_ratio_range', {min: 2, max: null, inclusive: true})), '[2 倍, +∞)');
    const combinedBars = await page.locator('.strategy-map-candle').evaluateAll(nodes => nodes.map(node => ({...node.dataset})));
    const beforeRequests = previewRequests;
    await page.locator('#strategy-map [data-map-index="1"]').click();
    assert.equal(await page.locator('#strategy-map [data-map-index="1"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-selected-condition="1"]').getAttribute('data-reference'), '-1');
    assert.match(await page.locator('foreignObject[data-map-annotation="1"]').textContent(), /成交量比值区间.*要求：.*示例：T0 成交量 ÷ T-1 成交量/s);
    assert.equal(await page.locator('[data-selected-condition="1"] .strategy-map-selected-frame').count(), 1);
    assert.deepEqual(await page.locator('.strategy-map-candle').evaluateAll(nodes => nodes.map(node => ({...node.dataset}))), combinedBars);
    assert.equal(previewRequests, beforeRequests); // Inspecting a condition never generates a different market path.
    assert.match(await page.locator('.strategy-map-focus').innerText(), /整套策略.*3 条条件同时满足/);
    assert.equal(await page.locator('#strategy-map .strategy-map-row-title').filter({hasText: '✓'}).count(), 3);
    await mapped.focus();
    await page.keyboard.press('Enter');
    assert.equal(await mapped.getAttribute('aria-pressed'), 'true');
    let releaseOldPreview, startOldPreview;
    const previewStarted = new Promise(resolve => { startOldPreview = resolve; });
    previewGate = {started: startOldPreview, release: new Promise(resolve => { releaseOldPreview = resolve; })};
    await blocks.first().locator('[data-param=min]').fill('1');
    await previewStarted;
    const oldResponse = page.waitForResponse(response => response.url().endsWith('/api/strategies/preview') && response.request().postDataJSON().conditions[0].params.min === 1);
    await blocks.first().locator('[data-param=min]').fill('2');
    await page.waitForFunction(() => strategyMapPreview.data?.signature === JSON.stringify(state.conditions));
    releaseOldPreview();
    await oldResponse;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => strategyMapPreview.data.signature === JSON.stringify(state.conditions)), true);
    previewFailure = true;
    await blocks.first().locator('[data-param=min]').fill('3');
    await page.locator('[data-preview-retry]').waitFor();
    await page.locator('[data-preview-retry]').click();
    await page.waitForFunction(() => document.querySelector('#strategy-map').dataset.previewState === 'ok');
    assert.equal(await blocks.first().locator('[data-param=min]').inputValue(), '3');
    await page.evaluate(() => resetToStrategy());
    await page.waitForFunction(() => document.querySelector('#strategy-map').dataset.previewState === 'ok');
    assert.equal(await blocks.first().locator('[data-param=min]').isVisible(), true);
    assert.equal(await page.locator('#condition-list details').count(), 0);
    assert.equal(await page.locator('#strategy-save').isDisabled(), true);
    assert.equal(await page.locator('#strategy-list button[aria-pressed=true]').count(), 1);
    assert.equal(await page.locator('#strategy-list script').count(), 0);
    assert.equal(await page.locator('#calendar-grid, #screen-button, #results-panel').count(), 0);
    await page.locator('#strategy-search').fill('成交量');
    assert.equal(await page.locator('#strategy-list button').count(), 1);
    await page.locator('#strategy-search').fill('不存在');
    assert.match(await page.locator('#strategy-list').innerText(), /没有匹配/);
    await page.locator('#strategy-search').fill('');
    await blocks.first().locator('[data-param=min]').fill('9');
    assert.match(await blocks.first().locator('.condition-error').innerText(), /下限不能大于上限/);
    assert.equal(await page.locator('#strategy-map svg').count(), 0);
    assert.equal(await page.locator('#strategy-save').isDisabled(), true);
    await blocks.first().locator('[data-param=min]').fill('1');
    await blocks.first().locator('[data-role=node-offset]').selectOption('-10');
    assert.equal(await page.evaluate(() => state.conditions[0].params.offset), -10);
    assert.equal(await mapped.getAttribute('data-start'), '-12');
    assert.equal(await mapped.getAttribute('data-reference'), '-13');
    assert.equal(await blocks.first().locator('.condition-summary').count(), 0);
    const date = blocks.first().locator('[data-role=node-offset]');
    const previous = blocks.first().getByRole('button', {name: '区间前移一个交易日', exact: true});
    const next = blocks.first().getByRole('button', {name: '区间后移一个交易日', exact: true});
    assert.equal(await previous.innerText(), '←');
    assert.equal(await next.innerText(), '→');
    await date.selectOption('-60');
    assert.equal(await previous.isDisabled(), true);
    await next.click();
    assert.equal(await date.inputValue(), '-59');
    assert.equal(await previous.isEnabled(), true);
    await date.selectOption('60');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.doesNotMatch(await page.locator('#strategy-map').innerHTML(), /NaN|Infinity/);
    assert.equal(await next.isDisabled(), true);
    await previous.click();
    assert.equal(await date.inputValue(), '59');
    assert.equal(await next.isEnabled(), true);
    await blocks.first().locator('[data-role=node-offset]').selectOption('0');
    assert.equal(await date.locator('option:checked').innerText(), '基准日 · T0');
    await date.focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await date.inputValue(), '1');
    await date.selectOption('0');
    await page.locator('[data-strategy-id="2"]').click(); // Dismiss discarding edits.
    assert.equal(await page.locator('#strategy-name').inputValue(), '标准策略');
    await blocks.first().locator('[data-step="-1"]').click();
    assert.equal(await blocks.first().locator('.node-stepper').getAttribute('data-offset'), '-1');
    assert.equal(await blocks.first().locator('[data-role=node-offset]').inputValue(), '-1');
    await blocks.first().locator('[data-action=copy]').click();
    assert.equal(await blocks.count(), 4);
    await blocks.nth(1).locator('[data-action=down]').click();
    assert.equal(await page.evaluate(() => state.conditions[2].params.min), 1);
    await blocks.nth(2).locator('[data-action=remove]').click();
    assert.equal(await blocks.count(), 3);
    await page.locator('#strategy-save-as').click();
    assert.match(await page.locator('#strategy-name').inputValue(), /副本/);
    assert.equal(await page.evaluate(() => state.conditions[0].params.min), 1);
    assert.equal(writes.length, 0);
    await page.locator('#strategy-name').fill('标准策略');
    await page.locator('#strategy-save').click();
    assert.match(await page.locator('#alert-area').innerText(), /同名策略/);
    assert.equal(writes.length, 0);
    await page.locator('#strategy-name').fill('新放量策略');
    failSave = true;
    await page.locator('#strategy-save').click();
    await page.waitForFunction(() => !document.querySelector('#strategy-fields').disabled);
    assert.equal(await page.locator('#strategy-name').inputValue(), '新放量策略');
    assert.match(await page.locator('#alert-area').innerText(), /保存网络中断/);
    failSave = false;
    await page.locator('#strategy-save').click();
    await page.waitForFunction(() => document.querySelector('#strategy-dirty').textContent === '已保存');
    assert.equal(writes.at(-1).method, 'POST');
    assert.equal(writes.at(-1).body.conditions[0].params.min, 1);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#strategy-name').value === '新放量策略');
    await page.locator('#strategy-name').fill('新放量策略改名');
    await page.locator('#strategy-save').click();
    await page.waitForFunction(() => document.querySelector('#strategy-dirty').textContent === '已保存');
    assert.equal(writes.at(-1).method, 'PUT');
    await page.locator('[data-strategy-id="1"]').click();
    await page.locator('#strategy-new').click();
    assert.equal(await blocks.count(), 0);
    assert.equal(await page.locator('#strategy-map svg').count(), 0);
    assert.match(await page.locator('#strategy-map').innerText(), /添加条件/);
    assert.equal(await page.locator('#condition-picker').getAttribute('open'), '');
    await page.locator('[data-kind=pct_chg_range]').click();
    assert.equal(await blocks.count(), 1);
    assert.equal(await page.evaluate(() => document.activeElement.matches('#condition-list input, #condition-list select')), true);
    await blocks.first().locator('[data-param=min]').fill('2');
    // The stock page uses saved conditions, never the designer's unsaved draft.
    page.removeAllListeners('dialog');
    page.on('dialog', dialog => dialog.accept());
    await page.locator('.screen-subnav a[href="/screen/stocks"]').click();
    await page.locator('#calendar-grid button').first().waitFor();
    assert.equal(await page.locator('#strategy-name, #strategy-save, #condition-palette').count(), 0);
    assert.equal(await page.locator('#strategy-map, #strategy-guide').count(), 0);
    assert.equal(await page.locator('.screen-subnav [aria-current=page]').innerText(), '股票筛选');
    await page.locator('[data-strategy-id="3"]').click();
    const savedBeforeTuning = JSON.stringify(strategies);
    const writesBeforeTuning = writes.length;
    await blocks.first().locator('[data-param=min]').fill('2');
    await page.locator('#screen-button').click();
    await page.waitForFunction(() => !document.querySelector('#results-panel').hidden);
    assert.equal(screenBody.conditions[0].params.min, 2);
    assert.equal(JSON.stringify(strategies), savedBeforeTuning);
    assert.equal(writes.length, writesBeforeTuning);
    await page.locator('#criteria-reset').click();
    assert.equal(await blocks.first().locator('[data-param=min]').inputValue(), '1');
    assert.equal(screenBody.date, '2026-10-16');
    await page.locator('#edit-strategy').click();
    await page.waitForFunction(() => document.querySelector('#strategy-name').value === '新放量策略改名');
    assert.match(page.url(), /\/screen\/strategies\?strategy=3$/);
    await blocks.first().locator('[data-param=min]').fill('3');
    await page.locator('#criteria-reset').click();
    assert.equal(await page.evaluate(() => state.conditions[0].params.min), 1);
    await page.locator('#strategy-delete').click();
    await page.waitForFunction(() => document.querySelectorAll('#strategy-list button').length === 2);
    assert.equal(writes.at(-1).method, 'DELETE');
    await page.locator('[data-strategy-id="1"]').click();
    await page.evaluate(() => clearAlerts());
    for (const [width, height] of [[1440, 1050], [1024, 768], [375, 812], [812, 375]]) {
      await page.setViewportSize({width, height});
      await page.evaluate(() => window.scrollTo(0, 0));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Overflow at ${width}`);
      await page.waitForFunction(() => document.querySelector('#strategy-map').dataset.previewState === 'ok');
      if (width === 1440 || width === 375) await page.screenshot({path: `.probe/strategy-design-${width}.png`, fullPage: true});
    }
    await page.emulateMedia({reducedMotion: 'reduce'});
    await page.locator('#strategy-search').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.matches('.strategy-option')), true);
    await page.locator('#use-strategy').click();
    await page.locator('#calendar-grid button').first().waitFor();
    assert.match(page.url(), /\/screen\/stocks\?strategy=1$/);
    assert.equal(await page.locator('#active-strategy-name').innerText(), '标准策略');
    assert.equal(await blocks.first().locator('[data-param=min]').isVisible(), true);
    const tuning = blocks.first().locator('[data-param=min]');
    await tuning.fill('9');
    assert.equal(await page.locator('#criteria-save').isDisabled(), true);
    const previousScreens = screenRequests, previousScans = scanRequests;
    await page.locator('#screen-button').click();
    await page.locator('#scan-button').click();
    assert.equal(screenRequests, previousScreens);
    assert.equal(scanRequests, previousScans);
    assert.match(await blocks.first().locator('.condition-error').innerText(), /下限不能大于上限/);
    await tuning.fill('2');
    assert.match(await page.locator('#criteria-dirty').innerText(), /临时参数/);
    // Edit again while the request is pending: the response belongs to the submitted snapshot.
    let release, started;
    const requestStarted = new Promise(resolve => { started = resolve; });
    screenGate = {started, release: new Promise(resolve => { release = resolve; })};
    await page.locator('#screen-button').click();
    await requestStarted;
    await tuning.fill('3');
    release();
    await page.waitForFunction(() => !state.busy);
    screenGate = null;
    assert.equal(screenBody.conditions[0].params.min, 2);
    assert.equal(await page.evaluate(() => state.appliedConditions[0].params.min), 2);
    assert.equal(await page.evaluate(() => state.conditions[0].params.min), 3);
    assert.equal(await page.locator('#criteria-status').isVisible(), true);
    assert.equal(await page.locator('#export-button').isDisabled(), true);
    // A normal rerun clears the stale-result marker; export uses the same parameters.
    await page.locator('#screen-button').click();
    await page.waitForFunction(() => !state.busy);
    assert.equal(await page.locator('#criteria-status').isVisible(), false);
    let download = page.waitForEvent('download');
    await page.locator('#export-button').click();
    await download;
    assert.equal(exportBody.conditions[0].params.min, 3);
    // Month scans also keep the submitted snapshot if parameters change during the request.
    const scanStarted = new Promise(resolve => { started = resolve; });
    scanGate = {started, release: new Promise(resolve => { release = resolve; })};
    await page.locator('#scan-button').click();
    await scanStarted;
    assert.equal(await page.locator('#screen-button').isDisabled(), true);
    await tuning.fill('4');
    release();
    await page.waitForFunction(() => !state.busy);
    scanGate = null;
    assert.equal(scanBody.conditions[0].params.min, 3);
    assert.equal(await page.evaluate(() => state.appliedConditions[0].params.min), 3);
    assert.equal(await page.locator('#export-button').isDisabled(), true);
    await page.locator('#scan-button').click();
    await page.waitForFunction(() => !state.busy);
    download = page.waitForEvent('download');
    await page.locator('#export-button').click();
    await download;
    assert.equal(exportBody.month, '2026-10');
    assert.equal(exportBody.conditions[0].params.min, 4);
    // Saving is explicit; failure preserves the temporary values for retry.
    failSave = true;
    await page.locator('#criteria-save').click();
    await page.waitForFunction(() => !document.querySelector('#criteria-fields').disabled);
    assert.equal(await tuning.inputValue(), '4');
    assert.match(await page.locator('#alert-area').innerText(), /保存网络中断/);
    failSave = false;
    await page.locator('#criteria-save').click();
    await page.waitForFunction(() => document.querySelector('#criteria-dirty').textContent === '已保存');
    assert.equal(strategies.find(s => s.id === 1).conditions[0].params.min, 4);
    await tuning.fill('5');
    await page.locator('#criteria-reset').click();
    assert.equal(await tuning.inputValue(), '4');
    await page.evaluate(() => clearAlerts());
    for (const width of [1440, 375]) {
      await page.setViewportSize({width, height: 1050});
      await page.evaluate(() => window.scrollTo(0, 0));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({path: `.probe/stock-screen-${width}.png`, fullPage: true});
    }
    await page.locator('#edit-strategy').click();
    await page.waitForFunction(() => document.querySelector('#strategy-map')?.dataset.previewState === 'ok');
    await page.setViewportSize({width: 1440, height: 1050});
    await page.evaluate(() => {
      state.conditions = conditionCatalogEntries().map(entry => ({kind: entry.kind, params: defaultConditionParams(entry.kind)}));
      renderConditions();
      updateCriteriaUI();
    });
    await page.waitForFunction(() => strategyMapPreview.data?.signature === JSON.stringify(state.conditions));
    const allKindsBars = await page.locator('.strategy-map-candle').evaluateAll(nodes => nodes.map(node => ({...node.dataset})));
    const allKindsRequests = previewRequests;
    for (let index = 0; index < catalog.length; index++) {
      await page.locator(`[data-map-index="${index}"]`).click();
      const annotation = page.locator(`foreignObject[data-map-annotation="${index}"]`);
      assert.equal(await annotation.getAttribute('data-kind'), catalog[index].kind);
      assert.match(await annotation.textContent(), /日期：.*要求：/s);
      assert.deepEqual(await page.locator('.strategy-map-candle').evaluateAll(nodes => nodes.map(node => ({...node.dataset}))), allKindsBars);
      assert.equal(await blocks.nth(index).locator('[data-role=range-start]').count(), ['pct_chg_range', 'cumulative_pct_chg_range'].includes(catalog[index].kind) ? 1 : 0);
    }
    assert.equal(previewRequests, allKindsRequests);
    const wrappedText = await page.evaluate(() => {
      const context = document.createElement('canvas').getContext('2d');
      context.font = `12px ${getComputedStyle(el.strategyMap).fontFamily}`;
      const text = '要求：大于 -49.12345678901234%，小于 +99.12345678901234%';
      const lines = strategyMapWrapText(text, 160, context);
      return {complete: lines.join('') === text, wraps: lines.length > 1, fits: lines.every(line => context.measureText(line).width <= 160)};
    });
    assert.deepEqual(wrappedText, {complete: true, wraps: true, fits: true});
    const wrappedRowsFit = await page.locator('.strategy-map-row').evaluateAll(nodes => nodes.every(node => {
      const background = node.querySelector('.strategy-map-row-bg').getBBox();
      return [...node.querySelectorAll('tspan')].every(span => { const bounds = span.getBBox(); return bounds.x + bounds.width <= 392 && bounds.y >= background.y && bounds.y + bounds.height <= background.y + background.height; });
    }));
    assert.equal(wrappedRowsFit, true);
    await page.setViewportSize({width: 375, height: 900});
    await page.evaluate(() => renderStrategyMap(state.conditions, state.mapIndex));
    assert.equal(await page.locator('.strategy-map-mobile-note').isVisible(), true);
    assert.equal(await page.locator('.strategy-map-annotation').isVisible(), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    // Screening markers belong to this result list, including repeated stocks on different scan days.
    await page.setViewportSize({width: 1440, height: 1050});
    await page.goto(base + '/screen/stocks');
    await page.waitForFunction(() => window.__findstockBooted && state.strategies.length);
    const storageBefore = await page.evaluate(() => JSON.stringify({...localStorage}));
    const hit = (code, date) => ({code, name: '测试股票', board_label: '主板', d2: {trade_date: date}});
    const showResult = async (date) => {
      await page.evaluate(result => {state.scan = null; state.result = result; renderResult(result);}, {
        window: {d2: date}, hit_count: 2, hits: [hit('sh.600000', date), hit('sz.000001', date)], warnings: [],
      });
      await page.locator('#results-body .cell-code').first().click();
      await page.locator('.chart-screen-marker').waitFor();
    };
    await showResult('2026-10-16');
    const marker = page.locator('.chart-screen-marker');
    assert.equal(await marker.getAttribute('data-screen-date'), '2026-10-16');
    assert.match(await marker.textContent(), /选出日 T0/);
    const aligned = await page.evaluate(() => {
      const index = chartState.visible.findIndex(bar => bar.trade_date === chartState.screenDate);
      return Number(document.querySelector('.chart-screen-marker line').getAttribute('x1')) === chartState.layout.xOf(index);
    });
    assert.equal(aligned, true);
    await page.locator('#chart-next').click();
    await page.waitForFunction(() => chartState.payload?.code === 'sz.000001');
    assert.equal(await marker.getAttribute('data-screen-date'), '2026-10-16');
    await page.locator('#chart-close').click();
    const oldDate = chartDates[20];
    await showResult(oldDate);
    assert.equal(await marker.getAttribute('data-screen-date'), oldDate);
    assert.equal(await page.evaluate(() => chartState.bars.at(-1).trade_date), '2026-10-16');
    assert.equal(await page.evaluate(() => chartState.bars[0].trade_date <= chartState.screenDate), true);
    await page.locator('#chart-limit').selectOption('60');
    assert.equal(await marker.getAttribute('data-screen-date'), oldDate);
    await page.evaluate(() => {chartState.view.start = chartState.bars.length - 60; redrawChart();});
    assert.equal(await marker.count(), 0);
    await page.locator('.chart-svg').dblclick();
    await marker.waitFor();
    await page.screenshot({path: '.probe/screen-date-marker-desktop.png', fullPage: true});
    await page.setViewportSize({width: 375, height: 812});
    await page.evaluate(() => redrawChart());
    assert.equal(await marker.isVisible(), true);
    await page.screenshot({path: '.probe/screen-date-marker-mobile.png', fullPage: true});
    await page.locator('#chart-close').click();
    await page.setViewportSize({width: 1440, height: 1050});
    await page.evaluate(() => {
      state.result = null;
      state.scan = {month: '2026-10', hit_count: 3, scanned_days: 2, skipped_days: 0, hits: [
        {code: 'sh.600000', name: '测试股票', board_label: '主板', screen_date: '2026-10-14'},
        {code: 'sh.600000', name: '测试股票', board_label: '主板', screen_date: '2026-10-15'},
        {code: 'sz.000001', name: '测试股票', board_label: '主板', screen_date: '2026-10-16'},
      ]};
      renderScanResult(state.scan);
    });
    await page.locator('#results-body .cell-code').nth(1).click();
    await marker.waitFor();
    assert.equal(await page.locator('#chart-position').textContent(), '2 / 3');
    assert.equal(await marker.getAttribute('data-screen-date'), '2026-10-15');
    await page.locator('#chart-prev').click();
    await page.waitForFunction(() => chartState.payload && chartState.index === 0);
    assert.equal(await marker.getAttribute('data-screen-date'), '2026-10-14');
    await page.locator('#chart-next').click();
    await page.waitForFunction(() => chartState.payload && chartState.index === 1);
    assert.equal(await marker.getAttribute('data-screen-date'), '2026-10-15');
    await page.locator('#chart-next').click();
    await page.waitForFunction(() => chartState.payload?.code === 'sz.000001');
    assert.equal(await marker.getAttribute('data-screen-date'), '2026-10-16');
    await page.locator('#chart-close').click();
    // A saved source date alone (watchlist/ladder/overview) must never activate the temporary marker.
    await page.evaluate(() => openStockChart('sh.600000', {sourceDate: '2026-10-14'}));
    assert.equal(await marker.count(), 0);
    await page.locator('#chart-close').click();
    assert.equal(await page.evaluate(() => chartState), null);
    assert.equal(await page.evaluate(() => JSON.stringify({...localStorage})), storageBefore);
    assert.deepEqual(errors, []);
    console.log('Both child pages passed: design CRUD/validation, direct parameter editing, cross-page strategy selection, keyboard and responsive layout.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
