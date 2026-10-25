// 全部请求拦截为合成数据，验证题材日期与天梯日期独立，不访问真实数据源。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
    const errors = [], candidateCalls = [], otherCalls = [];
    const dates = ['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'];
    const stock = (code, name, primary_theme, consecutive = 1) => ({code: `sz.${code}`, name, primary_theme,
      consecutive, board: 'main_sz', board_label: '深市主板', is_st: false, pct_chg: 10, amount: 1e8});
    const records = Object.fromEntries(dates.map(day => [day, [stock('000008', '其他题材股', '芯片')]]));
    records[dates.at(-1)] = [stock('000001', '当日机器人', '机器人'), stock('000002', '当日芯片', '芯片'),
      stock('000099', '缺失题材', null)];
    records[dates.at(-2)] = [stock('000001', '换题材机器人', '芯片', 2), stock('000003', '历史新增机器人', '机器人'),
      stock('000004', '无关股票', '零售')];
    records[dates[0]] = [stock('000005', '更早机器人', '机器人', 3), stock('000006', '更早芯片', '芯片')];
    let racing = false, failDate = '';
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === '/stock-ladder') return route.fulfill({contentType: 'text/html', body: fs.readFileSync('web/ladder.html', 'utf8')});
      if (url.pathname.startsWith('/static/')) return route.fulfill({contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
        body: fs.readFileSync('web/' + url.pathname.split('/').at(-1), 'utf8')});
      assert.equal(request.method(), 'GET', 'Browsing and filtering must never start downloads');
      if (url.pathname.endsWith('/theme-candidates')) {
        const day = url.searchParams.get('date') || dates.at(-1);
        candidateCalls.push(day);
        if (racing && day === dates[5]) await new Promise(resolve => setTimeout(resolve, 300));
        if (day === failDate) return route.fulfill({status: 503, json: {error: {message: '测试本地候选失败'}}});
        const themes = day === dates[4] ? [{name: '机器人', stock_count: 2}, {name: '新日专属', stock_count: 1}]
          : day === dates[5] ? [{name: '机器人', stock_count: 1}, {name: '旧日专属', stock_count: 1}]
          : [{name: '机器人', stock_count: 1}, {name: '芯片', stock_count: 1}];
        return route.fulfill({json: {trade_date: day, trading_days: dates, covered_dates: [day],
          classified_dates: [day], themes, unclassified_count: day === dates.at(-1) ? 1 : 0}});
      }
      if (url.pathname.endsWith('/themes/status')) return route.fulfill({json: {configured: false, running: false,
        total_days: dates.length, completed_days: dates.length, pending_days: 0, calls_today: 0, daily_limit: 50,
        download_allowed: false, download_block_reason: '仅在收盘后下载'}});
      if (url.pathname === '/api/stock-ladder') {
        const day = url.searchParams.get('date') || dates.at(-1);
        return route.fulfill({json: {trade_date: day, trading_days: dates, items: records[day],
          data_source: 'local', is_final: true, theme_complete: day !== dates.at(-1), theme_is_final: true,
          fetched_at: `${day}T16:00:00+08:00`}});
      }
      if (url.pathname.endsWith('/chart')) return route.fulfill({json: {bars: []}});
      if (url.pathname === '/api/watchlist') return route.fulfill({json: {items: []}});
      otherCalls.push(url.pathname);
      throw new Error('Unexpected request ' + url.pathname);
    });
    await page.goto(`http://findstock.test/stock-ladder?date=${dates.at(-1)}&days=3`);
    const loaded = () => page.waitForFunction(() => ladderData && !ladderBusy && !ladderThemeLoading &&
      ladderViewportDays().every(entry => entry.snapshot));
    await loaded();
    assert.equal(await page.locator('#ladder-theme-date').inputValue(), dates.at(-1));
    assert.ok((await page.locator('#ladder-theme option').allTextContents()).some(text => text.includes('机器人') && text.includes('1')),
      'First-board themes are available');
    await page.locator('#ladder-theme').selectOption('机器人');
    assert.equal(await page.locator('.ladder-card[data-date="2026-10-16"][data-code="sz.000001"]').count(), 1);
    assert.equal(await page.locator('.ladder-card[data-date="2026-10-15"][data-code="sz.000003"]').count(), 1,
      'Other days include members absent from the reference day');
    assert.equal(await page.locator('.ladder-card[data-date="2026-10-15"][data-code="sz.000001"]').count(), 0,
      'A stock that changed its daily theme is hidden');
    assert.equal(await page.locator('.ladder-card[data-code="sz.000099"]').count(), 0, 'Missing themes are not guessed');
    assert.equal(await page.locator('#ladder-groups thead .ladder-day-head').count(), dates.length);
    assert.ok((await page.locator('.ladder-card').allTextContents()).every(text => !text.includes('芯片') && !text.includes('无关股票')));

    // 自然日期定位和滚动保留题材日期及选中的题材；没有匹配股票的日列仍在。
    const before = candidateCalls.length;
    await page.locator('#ladder-date').selectOption(dates[0]);
    await loaded();
    assert.equal(await page.locator('#ladder-theme-date').inputValue(), dates.at(-1));
    assert.equal(await page.locator('#ladder-theme').inputValue(), '机器人');
    assert.equal(candidateCalls.length, before);
    assert.equal(await page.locator('.ladder-card[data-date="2026-10-07"][data-code="sz.000005"]').count(), 1);
    assert.equal(await page.locator('#ladder-groups thead .ladder-day-head[data-date="2026-10-08"]').count(), 1);
    assert.equal(await page.locator('.ladder-card[data-date="2026-10-08"]').count(), 0);
    await page.locator('#ladder-scrollbar').focus();
    await page.keyboard.press('Home');
    await loaded();
    assert.equal(await page.locator('#ladder-theme-date').inputValue(), dates.at(-1));
    assert.equal(await page.locator('#ladder-groups thead .ladder-day-head').count(), dates.length);

    // 快速切换参考日期时，较慢的旧响应不能覆盖较新的选择。
    racing = true;
    await Promise.all([
      page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/theme-candidates') &&
        new URL(request.url()).searchParams.get('date') === dates[5]),
      page.locator('#ladder-theme-date').selectOption(dates[5]),
    ]);
    await page.locator('#ladder-theme-date').selectOption(dates[4]);
    await page.waitForFunction(day => !ladderThemeLoading && document.querySelector('#ladder-theme-status').textContent.includes(day), dates[4]);
    await page.waitForTimeout(350);
    assert.equal(await page.locator('#ladder-theme-date').inputValue(), dates[4]);
    assert.ok((await page.locator('#ladder-theme').innerHTML()).includes('新日专属'));
    assert.ok(!(await page.locator('#ladder-theme').innerHTML()).includes('旧日专属'));
    assert.equal(await page.locator('#ladder-groups thead .ladder-day-head').count(), dates.length);

    failDate = dates[3];
    await page.locator('#ladder-theme-date').selectOption(failDate);
    await page.waitForFunction(() => !ladderThemeLoading && !document.querySelector('#ladder-theme-retry').hidden);
    assert.ok((await page.locator('#ladder-theme-status').innerText()).includes(failDate));
    assert.ok(!(await page.locator('#ladder-theme').innerHTML()).includes('新日专属'), 'A failed new date must not reuse old choices');
    assert.equal(await page.locator('#ladder-theme').isDisabled(), true);
    assert.equal(await page.locator('#ladder-theme').inputValue(), '机器人', 'An error must not broaden the selected filter');
    assert.ok((await page.locator('.ladder-theme-tag').allTextContents()).every(text => text === '机器人'));
    assert.equal(await page.locator('#ladder-groups thead .ladder-day-head').count(), dates.length);
    assert.deepEqual(errors, []);
    assert.deepEqual(otherCalls, []);
    console.log('Ladder date-specific themes: all heights, historical membership, changed/missing themes, all dates, scroll independence, races and errors passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
