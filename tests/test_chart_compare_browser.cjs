// 页面和接口全部拦截, 使用虚构行情, 不读写实际自选与复盘。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1050}});
    const dates = [];
    for (let day = new Date('2024-02-01T12:00:00Z'); day <= new Date('2026-10-23T12:00:00Z'); day.setUTCDate(day.getUTCDate() + 1)) {
      if (![0, 6].includes(day.getUTCDay())) dates.push(day.toISOString().slice(0, 10));
    }
    const stocks = [{code: 'sh.600000', name: '主图甲'}, {code: 'sz.000001', name: '对比乙'}, {code: 'sz.000002', name: '对比<丙>'}];
    const missing = dates.at(-45), errors = [], calls = [], unexpected = [];
    const categories = [{id: 1, name: '机器人<重点>', count: 2}, {id: 2, name: '低位观察', count: 1}];
    const watchItems = [{...stocks[1], categories: [categories[0]]}, {...stocks[2], categories: [categories[1], categories[0]]},
      {code: 'sh.600003', name: '未分类丁', categories: []}];
    let failSecond = true, failOlder = false, failSearch = false, failLadder = false, heldLadder = null, heldSearch = null, heldChart = null, active = 0, peak = 0, searchCalls = 0;
    page.on('pageerror', error => { errors.push(error.message); console.error('Browser error:', error.message); });
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      if (request.method() !== 'GET') { unexpected.push(request.method() + path); return route.abort(); }
      if (path === '/compare-test') return route.fulfill({contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/static/styles.css"></head><body><button id="open">打开K线</button><script src="/static/shared.js"></script><script src="/static/chart.js"></script></body></html>'});
      if (path.startsWith('/static/')) {
        const file = path.split('/').at(-1);
        return route.fulfill({contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync('web/' + file, 'utf8')});
      }
      if (path === '/api/watchlist') return route.fulfill({json: {codes: [], items: watchItems, categories}});
      if (path === '/api/stock-ladder') {
        if (heldLadder) { const gate = heldLadder; heldLadder = null; await gate; }
        if (failLadder) return route.fulfill({status: 500, json: {error: {message: '天梯暂时读取失败'}}});
        const day = url.searchParams.get('date') || '2026-10-23';
        return route.fulfill({json: {trade_date: day, trading_days: ['2026-10-22', '2026-10-23'],
          items: [{...stocks[2], consecutive: day === '2026-10-22' ? 4 : 1}, {...stocks[1], consecutive: day === '2026-10-22' ? 2 : 3}]}});
      }
      if (path === '/api/stocks/search') {
        searchCalls++;
        const query = url.searchParams.get('q');
        if (query === '旧' && heldSearch) await heldSearch;
        if (failSearch) return route.fulfill({status: 500, json: {error: {message: '搜索暂时失败'}}});
        return route.fulfill({json: query === '旧' ? [stocks[0]] : stocks});
      }
      if (path.endsWith('/chart')) {
        const code = path.split('/')[3], end = url.searchParams.get('end') || dates.at(-1);
        calls.push({code, end}); peak = Math.max(peak, ++active);
        try {
          if (heldChart && code === stocks[2].code) { const gate = heldChart; heldChart = null; await gate; }
          if (code === stocks[2].code && failSecond) return route.fulfill({status: 404, json: {error: {code: 'stock_not_found', message: '本地没有对比丙行情'}}});
          if (code === stocks[1].code && failOlder && url.searchParams.has('end')) return route.fulfill({status: 500, json: {error: {message: '早期行情暂时读取失败'}}});
          const history = (code === stocks[0].code ? dates.filter(day => day !== missing && day <= dates.at(-4)) : dates).filter(day => day <= end).slice(-400);
          if (!history.length) return route.fulfill({status: 404, json: {error: {code: 'stock_not_found', message: '没有更早行情'}}});
          return route.fulfill({json: {code, name: stocks.find(item => item.code === code).name, board_label: '主板', ma_windows: [5, 10, 20, 60], bars: history.map(trade_date => {
            const i = dates.indexOf(trade_date), base = code === stocks[0].code ? 10 : 1000;
            const price = base * (1 + i * .001 + Math.sin(i / 11 + (code === stocks[2].code ? 1.5 : 0)) * (code === stocks[2].code ? .3 : .04));
            const close = price * (1 + Math.sin(i / 2) * .008);
            return {trade_date, open: price, close, high: Math.max(price, close) * 1.012, low: Math.min(price, close) * .988, volume: 100000, pct_chg: 1,
              ma: {5: price * .995, 10: price * .99, 20: price * .985, 60: price * .98}};
          })}});
        } finally { active--; }
      }
      unexpected.push(path); return route.abort();
    });
    await page.goto('http://localhost/compare-test');
    await page.evaluate(() => {
      const existing = document.createElement('button');
      existing.id = 'already-inert'; existing.inert = true; document.body.appendChild(existing);
    });
    await page.evaluate(stocks => { document.querySelector('#open').onclick = () => openStockChart(stocks[0].code, {name: stocks[0].name, list: stocks}); }, stocks);
    await page.locator('#open').click();
    await page.waitForFunction(() => chartState?.payload);
    assert.equal(await page.locator('#open').evaluate(node => node.inert), true, 'The chart makes background controls inactive');
    const focusEnds = await page.locator('#stock-modal').evaluate(root => {
      const controls = [...root.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]')]
        .filter(node => node.tabIndex >= 0 && node.getClientRects().length);
      return {first: controls[0].id, last: controls.at(-1).id};
    });
    await page.locator('#' + focusEnds.last).focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), focusEnds.first, 'Tab wraps inside the chart');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), focusEnds.last, 'Shift+Tab wraps inside the chart');
    await page.locator('#open').evaluate(node => node.focus());
    assert.equal(await page.locator('#stock-modal').evaluate(node => node.contains(document.activeElement)), true, 'Background controls cannot steal focus');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#stock-modal').isVisible(), false);
    assert.equal(await page.locator('#open').evaluate(node => !node.inert && document.activeElement === node), true, 'Escape restores the initiating control and its focus');
    assert.equal(await page.locator('#already-inert').evaluate(node => node.inert), true, 'Existing inert state is preserved');
    await page.locator('#open').click();
    await page.waitForFunction(() => chartState?.payload);
    await page.locator('#chart-compare-toggle').click();
    await page.locator('#chart-compare-search').focus();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#stock-modal').isVisible(), false, 'Escape also closes the chart while a search input has focus');
    assert.equal(await page.locator('#open').evaluate(node => document.activeElement === node), true);
    await page.locator('#open').click();
    await page.waitForFunction(() => chartState?.payload);
    assert.equal(await page.locator('#chart-canvas svg').getAttribute('height'), '520');
    await page.locator('#chart-compare-toggle').click();
    const search = page.locator('#chart-compare-search');
    assert.equal(await page.locator('#chart-compare-options input').count(), 2, 'The current list does not mix in watchlist stocks');
    await page.locator('[data-compare-source="watchlist"]').click();
    await page.locator('#chart-compare-category').selectOption('1');
    assert.equal(await page.locator('#chart-compare-options input').count(), 2, 'Multi-category stocks appear in each matching category');
    assert.equal(await page.locator('#chart-compare-options h4').first().innerText(), '机器人<重点>', 'Category names are rendered as text');
    await page.locator('#chart-compare-options input[value="sz.000001"]').check();
    await page.locator('#chart-compare-category').selectOption('2');
    assert.equal(await page.locator('#chart-compare-options input').count(), 1);
    await page.locator('#chart-compare-options input[value="sz.000002"]').check();
    await page.locator('#chart-compare-category').selectOption('uncategorized');
    assert.equal(await page.locator('#chart-compare-options input').inputValue(), 'sh.600003');
    assert.match(await page.locator('#chart-compare-selection').innerText(), /已选 2 只/);
    await page.locator('[data-compare-unselect="sz.000001"]').click();
    const searchesBeforeFilter = searchCalls;
    await search.fill('找不到');
    assert.equal(await page.locator('#chart-compare-options input').count(), 0);
    await page.waitForTimeout(300);
    assert.equal(searchCalls, searchesBeforeFilter, 'Filtering a category must not search the whole market');
    failLadder = true;
    await page.locator('[data-compare-source="ladder"]').click();
    await page.getByText(/读取失败：天梯暂时读取失败/).waitFor();
    failLadder = false;
    await page.locator('#chart-compare-retry').click();
    await page.locator('#chart-compare-date').selectOption('2026-10-23');
    await page.waitForFunction(() => !document.querySelector('#chart-compare-height').disabled);
    assert.deepEqual(await page.locator('#chart-compare-options h4').allTextContents(), ['3 连板', '首板']);
    await page.locator('#chart-compare-options input[value="sz.000001"]').check();
    await page.locator('#chart-compare-height').selectOption('1');
    assert.equal(await page.locator('#chart-compare-options input').inputValue(), 'sz.000002');
    assert.equal(await page.locator('#chart-compare-options input').isChecked(), true, 'Selection survives switching sources');
    await page.locator('#chart-compare-date').selectOption('2026-10-22');
    await page.waitForFunction(() => !document.querySelector('#chart-compare-height').disabled);
    assert.deepEqual(await page.locator('#chart-compare-options h4').allTextContents(), ['4 连板', '2 连板']);
    let releaseLadder;
    heldLadder = new Promise(resolve => { releaseLadder = resolve; });
    await Promise.all([page.waitForRequest('**/api/stock-ladder?date=2026-10-23'), page.locator('#chart-compare-date').selectOption('2026-10-23')]);
    await page.locator('[data-compare-source="current"]').click();
    releaseLadder(); await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('#chart-compare-options input').count(), 2);
    assert.equal(await page.locator('#chart-compare-options h4').count(), 0, 'An old ladder response cannot replace the current list');
    if (process.env.FINDSTOCK_COMPARE_SCREENSHOT) {
      await page.locator('[data-compare-source="watchlist"]').click();
      await page.waitForFunction(() => !document.querySelector('#chart-compare-category').disabled);
      await page.screenshot({path: process.env.FINDSTOCK_COMPARE_SCREENSHOT.replace('.png', '-picker.png')});
      await page.setViewportSize({width: 375, height: 844});
      assert.equal(await page.locator('#stock-modal').evaluate(node => node.scrollWidth <= innerWidth), true, 'The source picker fits a small phone');
      await page.screenshot({path: process.env.FINDSTOCK_COMPARE_SCREENSHOT.replace('.png', '-picker-mobile.png')});
      await page.setViewportSize({width: 1440, height: 1050});
      await page.locator('[data-compare-source="current"]').click();
    }
    await search.fill('对比');
    await page.locator('#chart-compare-options input[value="sz.000001"]').waitFor();
    await search.press('ArrowLeft');
    assert.equal(await page.evaluate(() => chartState.code), stocks[0].code, 'Search cursor keys must not switch the main stock');
    await page.locator('#chart-compare-options input[value="sz.000001"]').check();
    await page.locator('#chart-compare-options input[value="sz.000002"]').check();
    await page.locator('#chart-compare-add').click();
    await page.waitForFunction(() => [...chartState.comparisons.values()].every(entry => !entry.loading));
    assert.equal(await page.locator('.chart-compare-item').count(), 2);
    assert.match(await page.locator('[data-compare-code="sz.000002"]').innerText(), /本地没有对比丙行情/);
    assert.equal(Number(await page.locator('#chart-canvas svg').getAttribute('height')), 508);
    failSecond = false;
    await page.locator('[data-compare-retry="sz.000002"]').click();
    await page.waitForFunction(() => chartState.comparisons.get('sz.000002').payload?.bars.length);
    assert.equal(await page.locator('#chart-comparisons img').count(), 0);
    const aligned = () => page.evaluate(() => [...chartState.comparisons.values()].every(entry => entry.layout && JSON.stringify(entry.layout.bars.map(bar => bar.trade_date)) === JSON.stringify(chartState.visible.map(bar => bar.trade_date))));
    assert.equal(await aligned(), true);
    assert.equal(await page.evaluate(day => chartState.visible.find(bar => bar.trade_date === day)?.close, missing), null);
    assert.ok(await page.evaluate(day => chartState.comparisons.get('sz.000001').layout.bars.find(bar => bar.trade_date === day).close > 1000, missing));
    assert.equal(await page.evaluate(() => chartState.visible.at(-1).close), null, 'Unavailable main-stock dates remain empty');
    assert.equal(await page.locator('[data-compare-scale="independent"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => {
      const main = chartState.layout, volatile = chartState.comparisons.get('sz.000002').layout;
      return main.high - main.low < (volatile.high - volatile.low) / 2;
    }), true, 'Independent scaling keeps quiet stocks readable beside volatile ones');
    const requestsBeforeScale = calls.length;
    const viewBeforeScale = await page.evaluate(() => ({...chartState.view}));
    await page.locator('[data-compare-scale="shared"]').click();
    assert.equal(await page.evaluate(() => [...chartState.comparisons.values()].every(entry => entry.layout.low === chartState.layout.low && entry.layout.high === chartState.layout.high)), true, 'Shared mode retains comparable percentage scales');
    assert.equal(await page.locator('[data-compare-scale="shared"]').getAttribute('aria-pressed'), 'true');
    await page.locator('[data-compare-scale="independent"]').click();
    assert.deepEqual(await page.evaluate(() => ({...chartState.view})), viewBeforeScale);
    assert.equal(calls.length, requestsBeforeScale, 'Scale changes must reuse loaded data');
    assert.equal(await page.evaluate(() => [chartState.layout, ...[...chartState.comparisons.values()].map(entry => entry.layout)].every(layout => Math.abs(layout.relativeBars.find(bar => bar.close != null).close) < 1e-9)), true);
    assert.equal(await page.locator('#chart-stage svg').count(), 1, 'All stocks belong in one chart');
    assert.equal(await page.locator('.chart-shared-axis').count(), 1, 'Both columns share one fixed date-axis strip');
    assert.equal(await page.locator('.chart-shared-axis text').count(), 12, 'Each column has matching date ticks');
    const panels = await page.locator('.chart-lane-background').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return {top: r.top, bottom: r.bottom, left: r.left, width: r.width}; }));
    assert.equal(panels.length, 3);
    assert.equal(panels[0].top, panels[1].top);
    assert.ok(panels[1].left >= panels[0].left + panels[0].width);
    assert.ok(panels[2].top >= panels[0].bottom);
    assert.equal(panels[2].left, panels[0].left);
    assert.ok(panels.every(rect => rect.width === panels[0].width));
    assert.equal(await page.locator('#chart-crosshair').count(), 1, 'Crosshair IDs must not be duplicated');
    assert.equal(await page.locator('.chart-compare-lane .chart-crosshair').count(), 3, 'Every stock has its own synchronized cursor');
    const hoverAt = async (code, index) => {
      const point = await page.evaluate(({code, index}) => {
        const layout = chartState.comparisons.get(code)?.layout || chartState.layout;
        const rect = document.querySelector('#chart-stage svg').getBoundingClientRect(), scale = rect.width / layout.width;
        return {x: rect.left + layout.xOf(index) * scale, y: rect.top + (layout.geometry.priceTop + 40) * scale};
      }, {code, index});
      await page.mouse.move(point.x, point.y);
      await page.waitForFunction(({code, index}) => chartState.hoverCode === code && chartState.hoverIndex === index, {code, index});
      const cursors = await page.locator('.chart-compare-lane').evaluateAll(nodes => nodes.map(node => {
        const layout = chartState.comparisons.get(node.dataset.chartCode)?.layout || chartState.layout;
        const group = node.querySelector('.chart-crosshair');
        return {date: group.dataset.tradeDate, visible: group.style.display !== 'none',
          x: Number(group.querySelector('.cross-v').getAttribute('x1')), expectedX: layout.xOf(chartState.hoverIndex)};
      }));
      assert.equal(new Set(cursors.map(cursor => cursor.date)).size, 1, 'All cursors must identify the same trading date');
      assert.ok(cursors.every(cursor => cursor.visible && Math.abs(cursor.x - cursor.expectedX) < .01));
      return point;
    };
    await hoverAt(stocks[0].code, 10);
    await hoverAt(stocks[2].code, 15);
    const dateBeforeRedraw = await page.locator('#chart-crosshair').getAttribute('data-trade-date');
    await page.evaluate(() => redrawChart());
    assert.equal(await page.locator('.chart-compare-lane .chart-crosshair').evaluateAll((nodes, date) =>
      nodes.every(node => node.style.display !== 'none' && node.dataset.tradeDate === date), dateBeforeRedraw), true, 'Repainting retains every cursor at the selected date');
    const missingIndex = await page.evaluate(day => chartState.visible.findIndex(bar => bar.trade_date === day), missing);
    await hoverAt(stocks[1].code, missingIndex);
    assert.equal(await page.locator('#chart-crosshair').getAttribute('data-trade-date'), missing);
    assert.equal(await page.locator('#chart-crosshair .cross-h').evaluate(node => node.style.display), 'none', 'Missing candles keep their date cursor but hide the price cursor');
    if (process.env.FINDSTOCK_COMPARE_SCREENSHOT) {
      await page.setViewportSize({width: 1440, height: 900});
      await hoverAt(stocks[1].code, 30);
      await page.screenshot({path: process.env.FINDSTOCK_COMPARE_SCREENSHOT});
      await page.setViewportSize({width: 1440, height: 1050});
    }
    const comparison = page.locator('.chart-compare-lane[data-chart-code="sz.000001"]');
    await comparison.hover({position: {x: 300, y: 80}});
    await page.locator('#chart-tip').waitFor();
    assert.match(await page.locator('#chart-tip').innerText(), /对比乙/);
    assert.match(await page.locator('#chart-tip').innerText(), /收盘.*日涨跌.*区间涨跌/s);
    assert.doesNotMatch(await page.locator('#chart-tip').innerText(), /MA5|成交量|基准/);
    const stageBeforeHover = await page.locator('#chart-stage').boundingBox();
    await page.mouse.move(0, 0);
    await comparison.hover({position: {x: 300, y: 80}});
    assert.deepEqual(await page.locator('#chart-stage').boundingBox(), stageBeforeHover, 'Hover details never shift the plot');
    const cross = await page.locator('#chart-stage .chart-crosshair').evaluateAll(nodes => nodes.map(node => node.dataset.tradeDate));
    assert.equal(new Set(cross).size, 1, 'Both columns must show the same cursor date');
    const zoomPoint = await hoverAt(stocks[1].code, 30);
    const anchorDate = await page.evaluate(() => chartState.visible[chartState.hoverIndex].trade_date);
    const beforeZoom = await page.evaluate(() => chartState.view.count);
    await page.mouse.wheel(0, -120);
    await page.waitForFunction(before => chartState.view.count < before, beforeZoom);
    assert.equal(await aligned(), true);
    const dateAfterZoom = await page.evaluate(x => {
      const layout = chartState.comparisons.get('sz.000001').layout;
      const rect = document.querySelector('#chart-stage svg').getBoundingClientRect();
      const index = Math.floor(((x - rect.left) * layout.width / rect.width - layout.plotLeft) / layout.step);
      return layout.bars[index].trade_date;
    }, zoomPoint.x);
    assert.ok(Math.abs(dates.indexOf(dateAfterZoom) - dates.indexOf(anchorDate)) <= 1, 'Zooming the right column must preserve the date beneath the pointer');
    await comparison.hover({position: {x: 400, y: 80}});
    const beforeDrag = await page.evaluate(() => chartState.view.start);
    const dragBox = await comparison.boundingBox();
    await page.mouse.down(); await page.mouse.move(dragBox.x + 550, dragBox.y + 80, {steps: 5}); await page.mouse.up();
    assert.ok(await page.evaluate(before => chartState.view.start < before, beforeDrag));
    assert.equal(await aligned(), true);
    await comparison.dblclick({position: {x: 300, y: 80}});
    assert.equal(await page.evaluate(() => chartState.view.count), 120);

    failOlder = true;
    await page.evaluate(() => moveViewTo(0));
    await page.waitForFunction(() => [...chartState.comparisons.values()].every(entry => !entry.loading));
    await page.getByText(/早期行情暂时读取失败/).waitFor();
    assert.equal(await comparison.count(), 1, 'A history failure must preserve already loaded candles');
    const historyCalls = calls.filter(call => call.code === stocks[1].code).length;
    failOlder = false;
    await page.locator('[data-compare-retry="sz.000001"]').click();
    await page.waitForFunction(() => !chartState.comparisons.get('sz.000001').loading);
    assert.ok(calls.filter(call => call.code === stocks[1].code).length > historyCalls, 'Retry must repeat the failed historical request');
    await page.evaluate(() => moveViewTo(-1));
    await page.waitForFunction(() => !chartState.loadingMore && [...chartState.comparisons.values()].every(entry => !entry.loading));
    assert.ok(calls.some(call => call.code === stocks[1].code && call.end < dates.at(-400)));
    assert.equal(await aligned(), true, 'Loading older history must retain date alignment');
    await page.locator('#chart-limit').selectOption('60');
    assert.equal(await page.evaluate(() => chartState.view.count), 60);
    await page.locator('#chart-compare-toggle').click();
    assert.equal(await page.locator('#chart-compare-options input[value="sz.000001"]').isDisabled(), true, 'Already added stocks must not duplicate');
    await page.locator('[data-compare-source="market"]').click();
    let releaseSearch;
    heldSearch = new Promise(resolve => { releaseSearch = resolve; });
    await search.fill('旧'); await page.waitForTimeout(300);
    await search.fill('对比');
    await page.waitForTimeout(300); releaseSearch(); await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('#chart-compare-options input[value="sz.000001"]').count(), 1, 'A stale search must not replace newer results');
    failSearch = true;
    await search.fill('失败');
    await page.getByText(/搜索失败/).waitFor();
    failSearch = false;
    heldSearch = new Promise(resolve => { releaseSearch = resolve; });
    await search.fill('旧'); await page.waitForTimeout(300);
    await page.locator('[data-compare-source="current"]').click();
    releaseSearch(); await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('#chart-compare-options input[value="sz.000002"]').count(), 1, 'An old market search cannot replace a different source');
    await page.locator('#chart-compare-toggle').click();
    await page.locator('#chart-next').click();
    await page.waitForFunction(() => chartState.payload?.code === 'sz.000001');
    assert.equal(await page.locator('[data-compare-code="sz.000001"]').count(), 0, 'Switching to a comparison stock must remove its duplicate panel');
    assert.equal(await page.locator('[data-compare-code="sz.000002"]').count(), 1);
    await page.locator('[data-compare-remove="sz.000002"]').click();
    assert.equal(await page.locator('#chart-stage svg').count(), 1);
    assert.equal(await page.locator('#chart-canvas svg').getAttribute('height'), '520');
    assert.equal(await page.locator('#chart-compare-controls').isVisible(), false);

    await page.locator('#chart-compare-toggle').click();
    await page.locator('#chart-compare-options input[value="sz.000002"]').check();
    let releaseChart;
    heldChart = new Promise(resolve => { releaseChart = resolve; });
    await page.locator('#chart-compare-add').click();
    await page.waitForFunction(() => chartState.comparisons.get('sz.000002').loading);
    await page.locator('[data-compare-remove="sz.000002"]').click();
    releaseChart(); await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('.chart-compare-row').count(), 0, 'Removed requests cannot repaint stale panels');
    assert.ok(peak <= 3);
    await page.setViewportSize({width: 390, height: 844});
    assert.equal(await page.locator('#stock-modal').evaluate(node => node.scrollWidth <= innerWidth), true);
    await page.setViewportSize({width: 1440, height: 900});
    await page.evaluate(() => {
      const payload = chartState.payload;
      chartState.comparisons = new Map(Array.from({length: 11}, (_, i) => {
        const code = `sz.${String(100 + i).padStart(6, '0')}`;
        const bars = chartState.bars.map((bar, j) => {
          const factor = 1 + Math.sin(j / 8 + i) * .025;
          return {...bar, open: bar.open * factor, close: bar.close * factor, high: bar.high * factor, low: bar.low * factor,
            ma: Object.fromEntries(Object.entries(bar.ma).map(([key, value]) => [key, value == null ? null : value * factor]))};
        });
        return [code, {code, name: `对比${i + 1}`, payload: {...payload, code, name: `对比${i + 1}`, bars}, hasMore: false, loading: false, error: ''}];
      }));
      syncChartTimeline(); redrawChart();
    });
    assert.equal(await page.locator('.chart-compare-lane').count(), 12);
    assert.equal(await page.locator('#chart-stage svg').count(), 1);
    assert.equal(await page.locator('.modal-panel').evaluate(node => node.scrollHeight <= node.clientHeight + 1), true, 'The header and controls stay outside the scrolling chart');
    assert.equal(await page.locator('#chart-stage').evaluate(node => node.getBoundingClientRect().bottom <= innerHeight - 12), true);
    assert.equal(await page.locator('.chart-lane-background').evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().height >= 239)), true, 'Twelve stocks retain readable lane heights');
    assert.equal(await page.locator('#chart-stage').evaluate(node => node.scrollHeight > node.clientHeight), true);
    assert.equal(await page.locator('.chart-compare-lane .chart-crosshair').count(), 12);
    const axisVisible = () => page.locator('.chart-shared-axis').evaluate(node => {
      const axis = node.getBoundingClientRect(), stage = document.querySelector('#chart-stage').getBoundingClientRect();
      return axis.top >= stage.top && axis.bottom <= stage.bottom;
    });
    assert.equal(await axisVisible(), true, 'The date axis remains visible at the top of the scroll range');
    await page.locator('#chart-stage').evaluate(node => { node.scrollTop = node.scrollHeight; });
    const lastLane = page.locator('.chart-compare-lane').last();
    await lastLane.hover({position: {x: 300, y: 80}});
    await page.locator('#chart-tip').waitFor();
    assert.match(await page.locator('#chart-tip').innerText(), /对比11/);
    assert.equal(await page.locator('.chart-compare-lane .chart-crosshair').evaluateAll(nodes =>
      nodes.every(node => node.style.display !== 'none') && new Set(nodes.map(node => node.dataset.tradeDate)).size === 1), true, 'Hovering a scrolled row synchronizes all twelve stocks');
    assert.equal(await page.locator('#chart-tip').evaluate(node => {
      const tip = node.getBoundingClientRect(), stage = document.querySelector('#chart-stage').getBoundingClientRect();
      return tip.bottom <= stage.top && tip.top >= 0;
    }), true, 'Hover details stay above the plot after vertical scrolling');
    assert.equal(await axisVisible(), true, 'The date axis remains visible at the end of the scroll range');
    const scrollBeforeWheel = await page.locator('#chart-stage').evaluate(node => node.scrollTop);
    const countBeforeScroll = await page.evaluate(() => chartState.view.count);
    await page.keyboard.down('Shift'); await page.mouse.wheel(0, -180); await page.keyboard.up('Shift');
    await page.waitForFunction(before => document.querySelector('#chart-stage').scrollTop < before, scrollBeforeWheel);
    assert.equal(await page.evaluate(() => chartState.view.count), countBeforeScroll, 'Shift+wheel scrolls rows without zooming');
    await page.setViewportSize({width: 390, height: 844});
    assert.equal(await page.locator('#stock-modal').evaluate(node => node.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('#chart-stage').evaluate(node => node.scrollWidth <= node.clientWidth), true, 'Comparison rows fit mobile width');
    assert.equal(await page.locator('.chart-lane-background').evaluateAll(nodes =>
      new Set(nodes.map(node => node.getBoundingClientRect().left)).size), 1, 'Narrow screens use one readable column');
    await page.locator('#chart-stage').evaluate(node => { node.scrollTop = 0; });
    await page.locator('.chart-compare-lane').first().hover({position: {x: 100, y: 80}});
    assert.equal(await page.locator('#chart-tip').evaluate(node => {
      const tip = node.getBoundingClientRect(), stage = document.querySelector('#chart-stage').getBoundingClientRect();
      return tip.bottom <= stage.top && [...node.children].every(child => child.getBoundingClientRect().bottom <= tip.bottom);
    }), true, 'Mobile hover details fit in their reserved space above the chart');
    if (process.env.FINDSTOCK_COMPARE_SCREENSHOT) await page.screenshot({path: process.env.FINDSTOCK_COMPARE_SCREENSHOT.replace('.png', '-mobile.png')});
    await page.setViewportSize({width: 1440, height: 900});
    await page.locator('#chart-stage').evaluate(node => { node.scrollTop = 0; });
    if (process.env.FINDSTOCK_COMPARE_SCREENSHOT) await page.screenshot({path: process.env.FINDSTOCK_COMPARE_SCREENSHOT.replace('.png', '-12.png')});
    await page.locator('#chart-close').click();
    assert.equal(await page.evaluate(() => chartState), null);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    console.log('Chart comparison checks passed: two columns, synchronized cursor dates, gaps, right-column zoom/pan, scale modes, scrolling, history, retry, stale responses, switching and mobile layout.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
