// PLAYWRIGHT_MODULE 可指向已有运行时；全部行情在浏览器拦截，不修改真实数据。
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1100}, hasTouch: true});
    const errors = [], calls = [];
    page.on('pageerror', error => errors.push(error.message));
    const dates = [];
    for (let day = new Date('2024-08-22T12:00:00Z'); day.toISOString().slice(0, 10) <= '2026-10-16'; day.setUTCDate(day.getUTCDate() + 1)) {
      if (![0, 6].includes(day.getUTCDay())) dates.push(day.toISOString().slice(0, 10));
    }
    const stocks = [{code: 'sh.600000', name: '测试<甲>'}, {code: 'sz.000001', name: '测试乙'}, {code: 'sz.000002', name: '恰好400根'}];
    await page.addInitScript(stocks => localStorage.setItem('findstock.multi-chart.v1', JSON.stringify(stocks)), stocks);
    let writes = 0, active = 0, peak = 0;
    await page.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() !== 'GET') { writes++; throw new Error('Unexpected write'); }
      if (url.pathname === '/api/data/coverage') return route.fulfill({json: {bar_start: dates[0], bar_end: dates.at(-1)}});
      if (url.pathname === '/api/calendar') return route.fulfill({json: {days: dates.map(trade_date => ({trade_date, is_open: true}))}});
      if (url.pathname.endsWith('/chart')) {
        const code = url.pathname.split('/')[3], end = url.searchParams.get('end') || dates.at(-1);
        calls.push({code, end}); peak = Math.max(peak, ++active);
        await new Promise(resolve => setTimeout(resolve, 10)); active--;
        let history = code === 'sz.000002' ? dates.slice(-400) : code === 'sz.000001' ? dates.slice(0, -5).filter((day, index) => index !== dates.length - 30) : dates;
        history = history.filter(day => day <= end).slice(-400);
        if (!history.length) return route.fulfill({status: 404, json: {error: {code: 'stock_not_found', message: '本地没有更早行情'}}});
        return route.fulfill({json: {code, name: stocks.find(item => item.code === code).name, ma_windows: [5, 10, 20, 60],
          bars: history.map(trade_date => { const i = dates.indexOf(trade_date); return {trade_date, open: 10 + i * .01, close: 10.1 + i * .01, high: 10.5 + i * .01, low: 9.8 + i * .01,
            volume: 100000 + i * 10, pct_chg: 1, ma: {5: 10 + i * .01, 10: 9.9 + i * .01, 20: 9.8 + i * .01, 60: 9.7 + i * .01}}; })}});
      }
      throw new Error('Unexpected API ' + url.pathname);
    });
    await page.goto((process.env.FINDSTOCK_TEST_URL || 'http://127.0.0.1:8000') + '/multi-chart');
    await page.waitForFunction(() => document.querySelectorAll('.multi-chart-body svg').length === 3);
    assert.equal(await page.locator('.multi-chart-controls, .multi-date-form, .multi-mark-hint').count(), 0);
    assert.equal(await page.locator('.multi-card-name').first().textContent(), '测试<甲>');
    assert.ok(peak <= 3);
    assert.equal(calls.filter(call => call.code === stocks[0].code).length, 2);
    assert.equal(await page.evaluate(() => multiState.cache.get('sh.600000').payload.bars.length), dates.length);
    const a = page.locator('.multi-card[data-code="sh.600000"]'), b = page.locator('.multi-card[data-code="sz.000001"]');
    const state = code => page.evaluate(code => { const v = multiState.views.get(code); return {start: v.start, count: v.count, cursor: v.cursor, locked: v.locked}; }, code);
    async function point(card, ratio, click = false) {
      const svg = await card.locator('svg').boundingBox();
      await page.mouse.move(svg.x + (svg.width - 60) * ratio, svg.y + 70);
      if (click) await page.mouse.click(svg.x + (svg.width - 60) * ratio, svg.y + 70);
    }
    const beforeB = await state(stocks[1].code);
    await point(a, .4); await page.mouse.wheel(0, -120);
    await page.waitForFunction(() => multiState.views.get('sh.600000').count < 60);
    assert.deepEqual(await state(stocks[1].code), beforeB);
    await point(a, .3, true);
    const pinnedA = await state(stocks[0].code);
    await point(b, .6, true); await point(a, .8);
    assert.equal((await state(stocks[0].code)).cursor, pinnedA.cursor);
    assert.ok((await state(stocks[1].code)).cursor !== pinnedA.cursor);
    assert.ok((await a.locator('.multi-readout').textContent()).includes(pinnedA.cursor));
    await a.locator('[data-view-action="mark"]').click();
    for (const ratio of [.2, .5, .8]) await point(a, ratio, true);
    assert.deepEqual(await a.locator('[data-node-date]').allTextContents().then(nodes => nodes.map(node => node.split(' ')[0])), ['T0', 'T1', 'T2']);
    assert.equal(await b.locator('[data-node-date]').count(), 0);
    assert.equal(await page.locator('#stock-modal').count(), 0);
    await a.locator('.multi-chart-body').focus();
    await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Enter');
    assert.equal(await a.locator('[data-node-date]').count(), 4);
    const countBeforeDrag = await a.locator('[data-node-date]').count(), start = (await state(stocks[0].code)).start;
    const box = await a.locator('svg').boundingBox();
    await page.mouse.move(box.x + box.width * .35, box.y + 80); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .65, box.y + 80, {steps: 6}); await page.mouse.up();
    assert.ok((await state(stocks[0].code)).start < start);
    assert.equal(await a.locator('[data-node-date]').count(), countBeforeDrag);
    const bPinned = await state(stocks[1].code);
    const firstNode = a.locator('[data-node-date]').first();
    const nodeDate = await firstNode.getAttribute('data-node-date');
    await firstNode.click();
    assert.equal((await state(stocks[0].code)).cursor, nodeDate);
    assert.deepEqual(await state(stocks[1].code), bPinned);
    await b.locator('[data-view-action="mark"]').click();
    await b.locator('.multi-chart-body').focus();
    await page.keyboard.press('Home'); await page.keyboard.press('Enter');
    assert.equal(await b.locator('[data-node-date]').count(), 0);
    assert.ok((await b.locator('.multi-view-range').textContent()).includes('没有本地行情'));
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.multi-chart-body svg').length === 3);
    assert.equal(await a.locator('[data-node-date]').count(), 4);
    await a.locator('[data-node-date]').first().click();
    assert.equal(await a.locator('.multi-marker').count() > 0, true);
    await a.locator('[data-node-remove]').nth(1).click();
    assert.equal(await a.locator('[data-node-date]').count(), 3);
    assert.ok(!(await a.locator('.multi-node-list').textContent()).includes('T1 '));
    await page.locator('#multi-columns').selectOption('3');
    await page.waitForTimeout(50);
    assert.equal(await a.locator('[data-node-date]').count(), 3);
    await page.locator('#multi-period').selectOption('120');
    assert.equal((await state(stocks[0].code)).count, 120);
    assert.equal((await state(stocks[1].code)).count, 120);
    await page.locator('#multi-columns').selectOption('2');
    await page.screenshot({path: '.probe/multi-interactive-desktop.png', fullPage: true});
    for (const [width, height] of [[1024, 768], [375, 812], [812, 375]]) {
      await page.setViewportSize({width, height}); await page.waitForTimeout(50);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'overflow ' + width);
      if (width === 375) {
        await a.locator('[data-view-action="mark"]').click();
        const nodeCount = await a.locator('[data-node-date]').count();
        await a.locator('.multi-chart-body').scrollIntoViewIfNeeded();
        const touchBox = await a.locator('svg').boundingBox();
        await page.touchscreen.tap(touchBox.x + (touchBox.width - 60) * .35, touchBox.y + 60);
        assert.equal(await a.locator('[data-node-date]').count(), nodeCount + 1);
        await page.screenshot({path: '.probe/multi-interactive-mobile.png', fullPage: true});
      }
    }
    await a.locator('[data-view-action="clear-nodes"]').click();
    assert.equal(await a.locator('[data-node-date]').count(), 0);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('findstock.multi-chart.markers.v1'))['sh.600000'].length), 0);
    assert.equal(writes, 0); assert.deepEqual(errors, []);
    console.log('Interactive multi-chart browser checks passed: full history pagination, exact-400 boundary, independent zoom/cursors, T0–T3, drag vs click, missing days, date lookup, keyboard, persistence, remove/reset, responsive; no API writes.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
