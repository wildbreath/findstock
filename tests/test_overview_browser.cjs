// 使用隔离测试服务；策略增删改只写入测试数据库。
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.FINDSTOCK_TEST_URL || 'http://127.0.0.1:8765';
(async () => {
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1050}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const items = [
      {code: 'sh.600001', name: '测试<甲>', consecutive: 4, first_seal: '09:30:00', amount: 1.2e8},
      {code: 'sh.600002', name: '测试乙', consecutive: 2, amount: null},
      {code: 'sz.000001', name: '测试丙', consecutive: 3},
      {code: 'sz.000002', name: '首板', consecutive: 1},
    ];
    let failPool = false, failSector = true, failSave = false, submitted;
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (path.startsWith('/api/strategies/') && route.request().method() === 'PUT' && failSave)
        return route.fulfill({status: 502, json: {error: {message: '测试保存失败'}}});
      if (path === '/api/stock-ladder') return route.fulfill(failPool ?
        {status: 502, json: {error: {message: '测试断网'}}} :
        {json: {trade_date: url.searchParams.get('date') || '2026-10-16', trading_days: ['2026-10-15', '2026-10-16'],
          items, fetched_at: '2026-10-16T08:00:00Z', origin: 'ths', data_source: 'local', is_final: true}});
      if (path.endsWith('/sectors')) {
        const code = path.split('/')[3];
        if (code === 'sz.000001' && failSector) return route.fulfill({status: 502, json: {error: {message: '归属测试失败'}}});
        return route.fulfill({json: {code, fetched_at: '2026-10-17T01:00:00Z', sectors: [
          {id: 'em:electronics', name: '电子', kind: 'industry', level: 1},
          {id: code === 'sh.600001' ? 'em:chip' : 'em:parts', name: code === 'sh.600001' ? '半导体' : '电子元件', kind: 'industry', level: 2},
        ]}});
      }
      if (path === '/api/data/coverage') return route.fulfill({json: {trading_days: 5, calendar_start: '2026-10-01', calendar_end: '2026-10-31', bar_end: '2026-10-16'}});
      if (path === '/api/calendar') return route.fulfill({json: {days: ['2026-10-15', '2026-10-16'].map(trade_date => ({trade_date, is_open: true}))}});
      if (path === '/api/screen/window') return route.fulfill({json: {nodes: [{offset: 0, symbol: 'T0', trade_date: '2026-10-16'}]}});
      if (path === '/api/data/sync/status') return route.fulfill({json: {is_running: false}});
      if (path === '/api/watchlist') return route.fulfill({json: {codes: []}});
      if (path === '/api/screen') {
        submitted = route.request().postDataJSON();
        return route.fulfill({json: {selected_date: submitted.date, hit_count: 0, hits: [], rejection_counts: {}, warnings: [], window: {d2: submitted.date}}});
      }
      if (path === '/api/strategies' || path.startsWith('/api/strategies/') || path === '/api/strategy-catalog') return route.continue();
      throw new Error('Unexpected API ' + path);
    });
    await page.goto(base + '/');
    await page.waitForFunction(() => document.querySelector('#overview-sector-status').textContent.includes('失败 1 只'));
    assert.equal(await page.locator('.overview-metric strong').first().textContent(), '3 只');
    assert.equal(await page.locator('#overview-stocks tr').count(), 3);
    assert.ok((await page.locator('#overview-status').textContent()).includes('同花顺'));
    await page.locator('#overview-sectors [data-sector="em:electronics"]').click();
    assert.ok((await page.locator('#overview-detail-title').textContent()).includes('(2)'));
    await page.locator('#overview-subsectors [data-sector="em:chip"]').click();
    assert.equal(await page.locator('#overview-stocks tr').count(), 1);
    assert.ok((await page.locator('#overview-detail-title').textContent()).includes('电子 / 半导体'));
    await page.locator('#overview-show-all').click();
    failSector = false;
    await page.locator('#overview-sector-retry').click();
    await page.waitForFunction(() => document.querySelector('#overview-sector-status').textContent.includes('已取得 3/3'));
    await page.locator('#overview-level').selectOption('2');
    assert.equal(await page.locator('#overview-sectors .overview-sector').count(), 2);
    await page.locator('#overview-search').fill('不存在');
    assert.ok((await page.locator('#overview-sectors').textContent()).includes('没有匹配'));
    await page.locator('#overview-search').fill('');
    failPool = true;
    await page.locator('#overview-date').selectOption('2026-10-15');
    await page.waitForFunction(() => !document.querySelector('#overview-refresh').disabled);
    assert.equal(await page.locator('#overview-date').inputValue(), '2026-10-16');
    assert.equal(await page.locator('#overview-stocks tr').count(), 3);
    await page.screenshot({path: '.probe/overview-desktop.png', fullPage: true});
    await page.setViewportSize({width: 375, height: 812});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({path: '.probe/overview-mobile.png', fullPage: true});
    await page.setViewportSize({width: 1440, height: 1050});
    await page.goto(base + '/strategy');
    await page.waitForFunction(() => window.__findstockBooted && document.querySelector('#strategy-list button'));
    assert.ok(page.url().endsWith('/screen/strategies'));
    await page.locator('#strategy-new').click();
    const name = `浏览器测试${Date.now()}`;
    await page.locator('#strategy-name').fill(name);
    await page.locator('[data-kind="close_price_range"]').click();
    await page.locator('[data-kind="not_st"]').click();
    assert.equal(await page.locator('.condition-block').count(), 2);
    await page.locator('.condition-block').last().locator('[data-action="up"]').click();
    assert.ok((await page.locator('.condition-block .condition-title').first().textContent()).includes('ST'));
    await page.locator('#strategy-save').click();
    await page.waitForFunction(name => document.querySelector('#strategy-list [aria-pressed="true"]')?.textContent.includes(name), name);
    assert.equal(await page.locator('#strategy-dirty').textContent(), '已保存');
    await page.locator('#use-strategy').click();
    await page.locator('#calendar-grid button').first().waitFor();
    await page.locator('#screen-button').click();
    await page.waitForFunction(() => !document.querySelector('#results-panel').hidden);
    assert.equal(submitted.conditions.length, 2);
    assert.equal(submitted.conditions[0].kind, 'not_st');
    await page.locator('#edit-strategy').click();
    await page.waitForFunction(name => document.querySelector('#strategy-name')?.value === name && document.querySelector('#strategy-dirty').textContent === '已保存', name);
    // 保存失败时保留编辑，切换取消后保留选择。
    const unsavedName = `未保存${Date.now()}`;
    await page.locator('#strategy-name').fill(unsavedName);
    failSave = true;
    await page.locator('#strategy-save').click();
    await page.waitForFunction(() => document.querySelector('#alert-area').textContent.includes('测试保存失败'));
    assert.equal(await page.locator('#strategy-name').inputValue(), unsavedName);
    assert.ok((await page.locator('#strategy-dirty').textContent()).includes('未保存'));
    assert.equal(await page.locator('#strategy-fields').isDisabled(), false);
    failSave = false;
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator('#strategy-list button[aria-pressed="false"]').first().click();
    assert.equal(await page.locator('#strategy-name').inputValue(), unsavedName);
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#criteria-reset').click();
    assert.equal(await page.locator('#strategy-name').inputValue(), name);
    await page.locator('.condition-block').last().locator('[data-action="remove"]').click();
    assert.equal(await page.locator('.condition-block').count(), 1);
    await page.locator('#strategy-save').click();
    await page.waitForFunction(() => document.querySelector('#strategy-dirty').textContent === '已保存');
    await page.screenshot({path: '.probe/condition-screen-desktop.png', fullPage: true});
    await page.setViewportSize({width: 375, height: 812});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({path: '.probe/condition-screen-mobile.png', fullPage: true});
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#strategy-delete').click();
    await page.waitForFunction(name => ![...document.querySelectorAll('#strategy-list button')].some(option => option.textContent.includes(name)), name);
    assert.deepEqual(errors, []);
    console.log('Overview drilldown, retry, failure, strategy CRUD, screening and responsive browser checks passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
