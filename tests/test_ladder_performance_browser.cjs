// PLAYWRIGHT_MODULE 可指向已有运行时；全部请求使用合成数据，不接触真实数据源。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
    const errors = [], requestedDays = [];
    page.on('pageerror', error => errors.push(error.message));
    const dates = [];
    for (let day = new Date('2025-11-01T00:00:00Z'); dates.length < 245; day.setUTCDate(day.getUTCDate() + 1)) {
      if (![0, 6].includes(day.getUTCDay())) dates.push(day.toISOString().slice(0, 10));
    }
    const descending = [...dates].reverse();
    const items = Array.from({length: 60}, (_, i) => ({code: `sz.${String(i + 1).padStart(6, '0')}`,
      name: `性能测试${i + 1}`, board: 'main_sz', consecutive: i % 6 + 1, amount: 1e8, pct_chg: 10, primary_theme: '机器人概念'}));
    const snapshot = day => ({trade_date: day, trading_days: dates, items,
      data_source: 'local', is_final: true, fetched_at: `${day}T16:00:00+08:00`});
    let candidateCalls = 0, releaseCandidates;
    const candidateGate = new Promise(resolve => { releaseCandidates = resolve; });
    let dayGate = null, releaseDays, heldDays = 0;
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/stock-ladder') return route.fulfill({contentType: 'text/html', body: fs.readFileSync('web/ladder.html', 'utf8')});
      if (url.pathname.startsWith('/static/')) return route.fulfill({contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
        body: fs.readFileSync('web/' + url.pathname.split('/').at(-1), 'utf8')});
      if (url.pathname.endsWith('/themes/status')) return route.fulfill({json: {configured: false, running: false,
        total_days: dates.length, completed_days: 0, pending_days: dates.length, calls_today: 0, daily_limit: 50,
        download_allowed: true, download_block_reason: null}});
      if (url.pathname.endsWith('/theme-candidates')) {
        candidateCalls++;
        await candidateGate;
        const day = url.searchParams.get('date') || dates.at(-1);
        return route.fulfill({json: {trade_date: day, trading_days: dates, covered_dates: [day], classified_dates: [], themes: [], unclassified_count: 0}});
      }
      if (url.pathname === '/api/stock-ladder') {
        const day = url.searchParams.get('date') || dates.at(-1);
        requestedDays.push(day);
        if (dayGate) { heldDays++; await dayGate; }
        return route.fulfill({json: snapshot(day)});
      }
      if (url.pathname.endsWith('/chart')) {
        const end = url.searchParams.get('end');
        const bars = Array.from({length: 20}, (_, i) => ({trade_date: end, open: 10 + i * .1,
          close: 10.2 + i * .1, high: 10.4 + i * .1, low: 9.8 + i * .1}));
        return route.fulfill({json: {bars}});
      }
      if (url.pathname.endsWith('/sectors')) return route.fulfill({json: {sectors: [], fetched_at: new Date().toISOString()}});
      if (url.pathname === '/api/watchlist') return route.fulfill({json: {items: []}});
      throw new Error('Unexpected request ' + url.pathname);
    });
    await page.goto('http://findstock.test/stock-ladder');
    const loaded = () => page.waitForFunction(() => ladderData && !ladderBusy && ladderViewportDays().every(entry => entry.snapshot));
    const seek = index => page.evaluate(index => {
      const bar = $('ladder-scrollbar');
      bar.scrollLeft = index * ladderColumnWidth($('ladder-groups').clientWidth, ladderCount);
      bar.dispatchEvent(new Event('scroll'));
    }, index);
    await loaded();
    await page.waitForFunction(() => ladderThemeLoading);
    assert.equal(candidateCalls, 1);

    // 慢板块统计不能阻塞日期；请求途中继续拖动时，下一批只加载最新位置。
    dayGate = new Promise(resolve => { releaseDays = resolve; });
    await Promise.all([
      page.waitForRequest(request => new URL(request.url()).searchParams.get('date') === descending[30]),
      seek(30),
    ]);
    await seek(160);
    assert.ok(heldDays > 0);
    dayGate = null;
    releaseDays();
    await loaded();
    assert.ok(requestedDays.includes(descending[160]), 'Current viewport loads while sector candidates remain pending');
    assert.ok(!requestedDays.includes(descending[33]), 'Discard queued days from an abandoned viewport');
    assert.equal(candidateCalls, 1, 'Candidate statistics are shared across date loads');
    releaseCandidates();
    await page.waitForFunction(() => !ladderThemeLoading);

    // 手动刷新会重新读取指定日期的本地题材，浏览位置保持独立。
    await page.evaluate(() => loadLadderViewport(true));
    await page.waitForFunction(() => !ladderThemeLoading);
    assert.equal(candidateCalls, 2);
    await seek(0);
    await loaded();
    await page.evaluate(() => loadLadderViewport(true));
    await page.waitForFunction(() => !ladderThemeLoading);
    assert.equal(candidateCalls, 3);

    // 将全年数据放入内存：DOM 仍只包含视口及两侧各两列。
    const metrics = await page.evaluate(({dates, items}) => {
      const root = $('ladder-groups');
      root.scrollLeft = 0;
      const measure = () => ({cards: root.querySelectorAll('.ladder-stock').length,
        elements: root.querySelectorAll('*').length,
        bodyDays: new Set([...root.querySelectorAll('tbody td[data-date]')].map(node => node.dataset.date)).size,
        visibleDays: ladderViewportDays().length});
      const start = performance.now();
      ladderDays.forEach((entry, index) => {
        entry.snapshot = {trade_date: entry.trade_date, trading_days: dates, items: index >= 200
          ? items.map(item => ({...item, consecutive: 18})) : items,
          data_source: 'local', is_final: true, fetched_at: `${entry.trade_date}T16:00:00+08:00`};
        ladderCache.set(entry.trade_date, entry.snapshot);
      });
      renderLadder();
      return {...measure(), renderMs: performance.now() - start,
        headerDays: root.querySelectorAll('thead .ladder-day-head').length};
    }, {dates, items});
    assert.equal(metrics.headerDays, 245, 'The complete date timeline remains available');
    assert.ok(metrics.bodyDays <= metrics.visibleDays + 4, JSON.stringify(metrics));
    assert.ok(metrics.cards <= (metrics.visibleDays + 4) * 60, JSON.stringify(metrics));
    assert.ok(metrics.elements < 40000, JSON.stringify(metrics));

    await page.waitForFunction(() => ladderChartActive === 0 && !ladderThemeLoading);
    await page.waitForTimeout(180);
    const idle = await page.evaluate(async () => {
      const root = $('ladder-groups'), card = root.querySelector('.ladder-stock');
      const start = performance.now();
      await loadLadderViewport();
      return {same: card === root.querySelector('.ladder-stock'), ms: performance.now() - start};
    });
    assert.equal(idle.same, true, 'A cached viewport must not reconstruct existing cards');

    // 有前后占位列时，部分露出的日期列仍和表头严格对齐。
    for (const [width, zoom] of [[1440, '100'], [375, '50'], [375, '150']]) {
      await page.setViewportSize({width, height: 1000});
      await page.locator('#ladder-zoom').selectOption(zoom);
      const aligned = await page.evaluate(() => {
        const root = $('ladder-groups');
        root.scrollLeft = 90.5 * ladderColumnWidth(root.clientWidth, ladderCount);
        syncLadderScroll();
        return ladderViewportDays().every(entry => {
          const header = root.querySelector(`thead [data-date="${entry.trade_date}"]`).getBoundingClientRect();
          const cell = root.querySelector(`tbody tr:not([hidden]) td[data-date="${entry.trade_date}"]`).getBoundingClientRect();
          return Math.abs(header.left - cell.left) < 1 && Math.abs(header.width - cell.width) < 1;
        });
      });
      assert.equal(aligned, true, `Date columns align at ${width}px / ${zoom}%`);
    }
    await page.setViewportSize({width: 1440, height: 1000});
    await page.locator('#ladder-zoom').selectOption('100');
    await seek(0);

    // 一张迷你图返回后，不替换已完成的其他图。
    const unaffected = await page.evaluate(async () => {
      const nodes = [...$('ladder-groups').querySelectorAll('.ladder-mini-chart')].filter(node => node.querySelector('svg'));
      const first = nodes[0], svg = first.querySelector('svg'), next = nodes.find(node => node.dataset.code !== first.dataset.code);
      if (!next) throw new Error('Expected two completed mini charts');
      ladderChartCache.delete(`${next.dataset.date}:${next.dataset.code}`);
      queueLadderChart(next.dataset.code, next.dataset.date);
      while (ladderChartActive || ladderChartQueue.length) await new Promise(resolve => setTimeout(resolve, 10));
      return svg === first.querySelector('svg');
    });
    assert.equal(unaffected, true, 'One chart completion must not repaint all SVGs');

    // 视口窗口移动时，重叠列复用卡片和题材标签，并保留键盘焦点。
    const overlap = await page.evaluate(() => {
      const day = ladderDays[4].trade_date;
      const card = $('ladder-groups').querySelector(`td[data-date="${day}"] .ladder-card`);
      const tag = card.querySelector('.ladder-theme-tag');
      card.focus({preventScroll: true});
      const bar = $('ladder-scrollbar');
      bar.scrollLeft = 3 * ladderColumnWidth($('ladder-groups').clientWidth, ladderCount);
      bar.dispatchEvent(new Event('scroll'));
      return {same: card === $('ladder-groups').querySelector(`td[data-date="${day}"] .ladder-card`),
        sameTheme: tag === card.querySelector('.ladder-theme-tag'), focused: document.activeElement === card};
    });
    assert.deepEqual(overlap, {same: true, sameTheme: true, focused: true});
    const ranks = () => page.locator('#ladder-groups tbody tr:visible .ladder-rank').allTextContents();
    assert.deepEqual(await ranks(), ['6板', '5板', '4板', '3板', '2板', '首板']);
    await seek(220);
    assert.deepEqual(await ranks(), ['18板'], 'Ranks respond in the scroll event without waiting for loading');
    await seek(0);
    assert.equal(await page.locator(`#ladder-groups td[data-date="${descending[4]}"] .ladder-theme-tag`).first().innerText(), '机器人概念');
    const finalMetrics = await page.locator('#ladder-groups').evaluate(root => ({cards: root.querySelectorAll('.ladder-stock').length,
      elements: root.querySelectorAll('*').length}));
    assert.ok(finalMetrics.cards <= (metrics.visibleDays + 4) * 60);
    assert.ok(finalMetrics.elements < 40000);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({fixture: '245 dates × 60 stocks', metrics, cachedViewportMs: idle.ms,
      afterRoundTrip: finalMetrics, candidateCalls, result: 'passed'}, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
