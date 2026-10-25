// PLAYWRIGHT_MODULE 可指向已有运行时；拦截全部请求，不接触真实数据。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
    const errors = [], calls = [];
    let active = 0, peak = 0, missing = true;
    page.on('pageerror', error => errors.push(error.message));
    const dates = ['2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'];
    const items = Array.from({length: 18}, (_, i) => ({code: `sz.${String(i + 1).padStart(6, '0')}`,
      name: ['百洋股份', '慈文传媒', '冰山冷热'][i % 3], board: 'main_sz', board_label: '深市主板',
      consecutive: 2, pct_chg: 10.05, amount: 7.82e8, primary_theme: '机器人概念'}));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/stock-ladder') return route.fulfill({contentType: 'text/html', body: fs.readFileSync('web/ladder.html', 'utf8')});
      if (url.pathname.startsWith('/static/')) return route.fulfill({contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
        body: fs.readFileSync('web/' + url.pathname.split('/').at(-1), 'utf8')});
      if (url.pathname.endsWith('/chart')) {
        const code = decodeURIComponent(url.pathname.split('/')[3]), end = url.searchParams.get('end');
        calls.push({code, end, limit: url.searchParams.get('limit')});
        peak = Math.max(peak, ++active);
        await new Promise(resolve => setTimeout(resolve, 20)); active--;
        if (missing && code === items[1].code) return route.fulfill({status: 404, json: {error: {code: 'stock_not_found', message: '本地没有行情，请先下载'}}});
        const bars = Array.from({length: 20}, (_, i) => ({trade_date: `2026-09-${String(i + 1).padStart(2, '0')}`,
          open: 10 + i * .2, close: 10 + i * .2 + (i % 3 ? .3 : -.2), high: 10.6 + i * .2, low: 9.5 + i * .2, ma: {60: 1000}}));
        return route.fulfill({json: {code, name: '本地名称', bars, ma_windows: [5, 10, 20, 60]}});
      }
      if (url.pathname.endsWith('/themes/status')) return route.fulfill({json: {configured: false, running: false,
        total_days: dates.length, completed_days: dates.length, pending_days: 0, calls_today: 0, daily_limit: 50,
        download_allowed: false, download_block_reason: '悟道题材仅在收盘后下载，请在15:30后重试'}});
      if (url.pathname.endsWith('/theme-candidates')) {
        const day = url.searchParams.get('date') || dates.at(-1);
        return route.fulfill({json: {trade_date: day, trading_days: dates, covered_dates: [day],
          classified_dates: [day], themes: [{name: '机器人概念', stock_count: 18}], unclassified_count: 0}});
      }
      if (url.pathname === '/api/watchlist') return route.fulfill({json: {items: []}});
      if (url.pathname === '/api/stock-ladder') return route.fulfill({json: {trade_date: url.searchParams.get('date') || dates.at(-1),
        trading_days: dates, items, data_source: 'local', is_final: true, theme_complete: true, fetched_at: new Date().toISOString()}});
      throw new Error('Unexpected request ' + url.pathname);
    });
    await page.goto('http://findstock.test/stock-ladder');
    await page.waitForFunction(() => document.querySelector('.ladder-mini-chart svg') && !ladderBusy && ladderChartActive === 0);
    assert.ok(peak <= 3);
    assert.ok(calls.every(call => call.end && call.limit === '20'));
    assert.equal(new Set(calls.map(call => call.end + call.code)).size, calls.length);
    assert.ok(calls.length < await page.locator('.ladder-card').count(), 'Only visible cards should fetch');
    assert.ok((await page.locator('.ladder-mini-chart').allTextContents()).some(text => text.includes('日K未就绪')));
    assert.equal(await page.locator('.ladder-theme-tag').first().innerText(), '机器人概念');
    assert.equal(await page.locator('.stock-sector-details').count(), 0);
    await page.locator('.ladder-theme-manager > summary').click();
    assert.equal(await page.locator('#ladder-theme-download').isDisabled(), true);
    assert.ok((await page.locator('#ladder-theme-download-status').innerText()).includes('尚未配置悟道密钥'));
    assert.ok((await page.locator('#ladder-theme-download-status').innerText()).includes('15:30'));
    assert.equal(await page.locator('#ladder-refresh').innerText(), '刷新本地数据');
    await page.screenshot({path: '.probe/ladder-wudao-manager.png', fullPage: false});
    await page.locator('.ladder-theme-manager > summary').click();
    await page.screenshot({path: '.probe/ladder-wudao-desktop.png', fullPage: false});
    const size = () => page.locator('.ladder-stock').first().evaluate(node => ({width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height}));
    const original = `.ladder-card{display:block}.ladder-mini-chart{display:none}.ladder-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:5px;line-height:1.4}.ladder-card-head strong{overflow-wrap:anywhere;white-space:normal}.ladder-card-foot{display:flex;justify-content:space-between;gap:5px;margin-top:4px;color:var(--text-muted);font-size:12px;line-height:1.5}`;
    for (const [width, height] of [[1440, 1000], [1024, 768], [375, 812], [812, 375]]) {
      await page.setViewportSize({width, height});
      await page.waitForTimeout(150);
      const current = await size();
      const baseline = await page.addStyleTag({content: original});
      const before = await size();
      await baseline.evaluate(node => node.remove());
      assert.ok(Math.abs(current.height - before.height) < .1, JSON.stringify({width, current, before}));
      assert.equal(current.width, before.width);
      assert.equal(await page.locator('.ladder-card').first().evaluate(node => node.scrollWidth <= node.clientWidth), true);
    }
    await page.setViewportSize({width: 1440, height: 1000});
    for (const zoom of ['50', '150', '100']) {
      await page.locator('#ladder-zoom').selectOption(zoom);
      await page.waitForTimeout(150);
      const current = await size();
      const baseline = await page.addStyleTag({content: original});
      const before = await size();
      await baseline.evaluate(node => node.remove());
      assert.ok(Math.abs(current.height - before.height) < .1);
      assert.equal(current.width, before.width);
    }
    await page.emulateMedia({reducedMotion: 'reduce'});
    await page.locator('.ladder-mini-chart').first().click();
    await page.waitForFunction(() => !!chartState?.payload);
    assert.equal(await page.evaluate(() => chartState.code), items[0].code);
    await page.keyboard.press('Escape');
    const before = calls.length;
    await page.locator('.ladder-stock').nth(15).scrollIntoViewIfNeeded();
    await page.waitForFunction(() => ladderChartActive === 0 && ladderChartQueue.length === 0);
    await page.waitForTimeout(100);
    assert.ok(calls.length > before, 'Scrolling down loads the next cards');
    await page.evaluate(() => window.scrollTo(0, 0));
    missing = false;
    await page.locator('#ladder-refresh').click();
    await page.waitForFunction(() => !ladderBusy && ladderChartActive === 0 &&
      document.querySelector('.ladder-card[data-code="sz.000002"] .ladder-mini-chart svg'));

    // 已缓存的屏幕外高板股不留空行；拖动当次事件就更新，不等待防抖或重建卡片。
    await page.evaluate(() => {
      ladderDays.forEach((entry, index) => {
        const stock = {code: 'sz.000001', name: '低板股', consecutive: 2, board: 'main_sz'};
        entry.snapshot = {...ladderData, trade_date: entry.trade_date, items: index === 0
          ? [{...stock, consecutive: 7}, {...stock, consecutive: 4}]
          : index === 1 ? [{...stock, consecutive: 4}, stock, stock]
          : index === ladderDays.length - 1
            ? Array.from({length: 12}, () => ({...stock, name: '高板股', consecutive: 18})) : []};
      });
      $('ladder-groups').scrollLeft = 0;
      renderLadder();
    });
    const ranks = () => page.locator('#ladder-groups tbody tr:visible .ladder-rank').allTextContents();
    assert.deepEqual(await ranks(), ['7板', '4板', '2板']);
    assert.equal(await page.locator('#ladder-groups tr[data-height="18"]').evaluate(row => row.getBoundingClientRect().height), 0);
    const lowHeight = await page.locator('#ladder-groups').evaluate(node => node.clientHeight);
    const immediate = await page.evaluate(() => {
      const card = $('ladder-groups').querySelector('tr[data-height="18"] .ladder-stock');
      const tag = card.querySelector('.ladder-theme-tag');
      const bar = $('ladder-scrollbar');
      bar.scrollLeft = bar.scrollWidth;
      bar.dispatchEvent(new Event('scroll'));
      return {sameCard: card === $('ladder-groups').querySelector('tr[data-height="18"] .ladder-stock'),
        sameTheme: tag === card.querySelector('.ladder-theme-tag'),
        ranks: [...$('ladder-groups').querySelectorAll('tbody tr:not([hidden]) .ladder-rank')].map(node => node.textContent)};
    });
    assert.deepEqual(immediate, {sameCard: true, sameTheme: true, ranks: ['18板']});
    assert.ok(await page.locator('#ladder-groups').evaluate(node => node.clientHeight) > lowHeight);
    await page.evaluate(() => {
      const bar = $('ladder-scrollbar');
      bar.scrollLeft = 0;
      bar.dispatchEvent(new Event('scroll'));
    });
    assert.deepEqual(await ranks(), ['7板', '4板', '2板']);
    assert.equal(await page.locator('#ladder-groups tr[data-height="18"] .ladder-theme-tag').first().innerText(), '题材未获取');
    await page.screenshot({path: '.probe/ladder-viewport-compact.png', fullPage: false});

    // 当前视口没有匹配股票或尚未加载时，只留一行状态提示。
    await page.locator('#ladder-search').fill('高板股');
    assert.deepEqual(await ranks(), ['—']);
    assert.ok((await page.locator('#ladder-groups tbody').innerText()).includes('没有符合筛选条件的股票'));
    await page.evaluate(() => {
      $('ladder-scrollbar').scrollLeft = $('ladder-scrollbar').scrollWidth;
      $('ladder-scrollbar').dispatchEvent(new Event('scroll'));
    });
    assert.deepEqual(await ranks(), ['18板']);
    await page.locator('#ladder-search').fill('');
    await page.locator('#ladder-compact').uncheck();
    assert.deepEqual(await ranks(), ['18板', '7板', '4板', '2板']);
    await page.locator('#ladder-compact').check();

    // 各种屏宽与缩放下，包括只露出部分的日期列，都按实际可见股票计算高度。
    for (const width of [1440, 375]) {
      await page.setViewportSize({width, height: 1000});
      for (const zoom of ['50', '100', '150']) {
        await page.locator('#ladder-zoom').selectOption(zoom);
        const result = await page.evaluate(() => {
          const root = $('ladder-groups');
          root.scrollLeft = ladderColumnWidth(root.clientWidth, ladderCount) / 2;
          syncLadderScroll();
          return {actual: [...root.querySelectorAll('tbody tr:not([hidden])')].map(row => Number(row.dataset.height)),
            expected: [...new Set(ladderViewportDays().flatMap(entry => ladderVisible.get(entry.trade_date))
              .map(item => item.consecutive))].sort((a, b) => b - a),
            aligned: Math.abs(root.scrollLeft - $('ladder-scrollbar').scrollLeft) <= 1};
        });
        assert.deepEqual(result.actual, result.expected.length ? result.expected : [0]);
        assert.equal(result.aligned, true);
      }
    }
    await page.setViewportSize({width: 1440, height: 1000});
    await page.locator('#ladder-zoom').selectOption('100');
    await page.evaluate(() => {
      $('ladder-groups').scrollLeft = 0;
      ladderViewportDays().forEach((entry, index) => {
        entry.snapshot = null;
        entry.loading = index !== 0;
        entry.error = index === 0 ? '测试加载失败' : '';
      });
      renderLadder();
    });
    assert.deepEqual(await ranks(), ['—']);
    const notes = await page.locator('#ladder-groups tbody').innerText();
    assert.ok(notes.includes('读取中') && notes.includes('测试加载失败'));
    assert.deepEqual(errors, []);
    await page.screenshot({path: '.probe/ladder-mini-desktop.png', fullPage: false});
    console.log('Ladder mini charts and dynamic viewport heights: desktop/mobile, zoom, immediate scroll, preserved cards, empty/loading/error checks passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
