// 页面、行情和写入请求全部拦截，不访问真实数据或行情源。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
    const errors = [], writes = [], reads = [];
    page.on('pageerror', error => errors.push(error.message));
    const dates = ['2026-10-22', '2026-10-23'];
    const stock = (code, name, primary_theme, consecutive = 1, board = 'main_sz') => ({
      code, name, primary_theme, consecutive, board, board_label: '测试板块', is_st: false,
    });
    const records = {
      [dates[0]]: [stock('sz.000022', '旧日机器人', '机器人'), stock('sz.000001', '昨日其他题材', '芯片')],
      [dates[1]]: [stock('sz.000001', '已自选机器人', '机器人', 2), stock('sz.000002', '首板机器人', '机器人'),
        stock('sz.300003', '<创业板机器人>', '机器人', 1, 'gem'), stock('sh.600519', '芯片股票', '芯片')],
    };
    const categories = [{id: 1, name: '原分类'}, {id: 2, name: '已有目标分类'}];
    const watched = [{code: 'sz.000001', name: '已自选机器人', categories: [categories[0]]}];
    let failLoad = false, failCreate = false, failBatch = false, oldServer = false, empty = false;
    let saveGate = null, loadGate = null;
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      if (path === '/stock-ladder') return route.fulfill({contentType: 'text/html', body: fs.readFileSync('web/ladder.html', 'utf8')});
      if (path.startsWith('/static/')) return route.fulfill({contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript',
        body: fs.readFileSync('web/' + path.split('/').at(-1), 'utf8')});
      if (path.endsWith('/theme-candidates')) {
        const day = url.searchParams.get('date');
        return route.fulfill({json: {trade_date: day, trading_days: dates, covered_dates: [day], classified_dates: [],
          themes: [{name: '机器人', stock_count: day === dates[1] ? 3 : 1}, {name: '芯片', stock_count: 1}], unclassified_count: 1}});
      }
      if (path.endsWith('/themes/status')) return route.fulfill({json: {configured: false, running: false,
        total_days: 2, completed_days: 0, pending_days: 2, calls_today: 0, daily_limit: 50, download_allowed: false}});
      if (path === '/api/stock-ladder') {
        const day = url.searchParams.get('date') || dates[1];
        reads.push(day);
        return route.fulfill({json: {trade_date: day, trading_days: dates, items: empty ? [] : records[day],
          data_source: 'local', is_final: true, theme_complete: false, fetched_at: `${day}T16:00:00+08:00`}});
      }
      if (path.endsWith('/chart')) return route.fulfill({json: {bars: []}});
      if (path === '/api/watchlist') {
        if (loadGate) await loadGate;
        return failLoad ? route.fulfill({status: 503, json: {error: {message: '模拟读取失败'}}})
          : route.fulfill({json: {items: watched, codes: watched.map(item => item.code), categories}});
      }
      if (path === '/api/watchlist/categories' && request.method() === 'POST') {
        if (failCreate) return route.fulfill({status: 503, json: {error: {message: '模拟分类创建失败'}}});
        const category = {id: categories.length + 1, name: request.postDataJSON().name};
        categories.push(category);
        return route.fulfill({status: 201, json: category});
      }
      if (path === '/api/watchlist/batch' && request.method() === 'POST') {
        const payload = request.postDataJSON();
        if (oldServer) return route.fulfill({status: 405, json: {detail: 'Method Not Allowed'}});
        writes.push(payload);
        if (saveGate) await saveGate;
        if (failBatch) return route.fulfill({status: 503, json: {error: {message: '模拟保存失败'}}});
        for (const item of payload.items) {
          let current = watched.find(value => value.code === item.code);
          if (!current) { current = {...item, categories: []}; watched.push(current); }
          const ids = payload.replace_categories ? new Set(payload.category_ids)
            : new Set([...current.categories.map(category => category.id), ...payload.category_ids]);
          current.categories = categories.filter(category => ids.has(category.id));
        }
        return route.fulfill({json: {items: watched, codes: watched.map(item => item.code), categories}});
      }
      throw new Error('Unexpected request: ' + request.method() + ' ' + path);
    });
    await page.goto('http://findstock.test/stock-ladder');
    await page.waitForFunction(() => ladderData && !ladderBusy && !ladderThemeLoading);
    const entry = page.locator('#ladder-watch-add'), dialog = page.locator('#watch-add-dialog');
    const stocks = dialog.locator('[data-role="stocks"] input');
    const options = dialog.locator('[data-role="options"] input');
    const submit = dialog.locator('[type="submit"]');
    const open = async () => {
      await entry.click();
      await page.waitForFunction(() => document.querySelector('#watch-add-dialog fieldset')?.disabled === false);
    };
    await entry.click();
    assert.equal(await dialog.count(), 0, 'A specific theme is required');
    assert.equal(writes.length, 0);
    await page.locator('#ladder-theme').selectOption('机器人');
    await page.locator('#ladder-theme-date').selectOption(dates[0]);
    await page.waitForFunction(() => !ladderThemeLoading);
    await open();
    assert.equal(await stocks.count(), 1);
    assert.equal(await stocks.first().inputValue(), 'sz.000022', 'Use the theme date rather than the viewport date');
    assert.ok((await dialog.textContent()).includes(dates[0]));
    await dialog.locator('[data-action="cancel"]').click();
    assert.equal(writes.length, 0, 'Cancel cannot save stocks');

    await page.locator('#ladder-theme-date').selectOption(dates[1]);
    await page.waitForFunction(() => !ladderThemeLoading);
    await page.locator('#ladder-board').selectOption('main');
    await page.locator('#ladder-multi').check();
    await page.locator('#ladder-search').fill('no-match');
    failLoad = true;
    await entry.click();
    await dialog.locator('[data-role="error"]').waitFor({state: 'visible'});
    assert.equal(await submit.isDisabled(), true);
    failLoad = false;
    await dialog.locator('[data-action="retry"]').click();
    await page.waitForFunction(() => document.querySelector('#watch-add-dialog fieldset').disabled === false);
    assert.equal(await stocks.count(), 3, 'Batch includes first-board and other boards despite display filters');
    assert.equal(await dialog.locator('[data-role="stocks"] input:checked').count(), 3);
    assert.ok((await dialog.textContent()).includes('已自选 · 原分类'));
    assert.ok((await dialog.locator('[data-role="coverage"]').textContent()).includes('存档未齐'));
    assert.ok((await dialog.textContent()).includes('<创业板机器人>'), 'Names are rendered as text');
    assert.equal(await dialog.locator('[data-role="stocks"] script').count(), 0);
    await dialog.locator('[data-action="none"]').click();
    assert.equal(await submit.isDisabled(), true);
    await dialog.locator('[data-action="all"]').click();
    await stocks.nth(1).uncheck();
    const newCategory = dialog.locator('[data-role="new-category"]');
    await newCategory.fill('10月23日机器人');
    failCreate = true;
    await submit.click();
    await dialog.locator('[data-role="error"]').waitFor({state: 'visible'});
    assert.equal(writes.length, 0, 'Category creation failure prevents saving stocks');
    assert.equal(await newCategory.inputValue(), '10月23日机器人');
    assert.equal(await stocks.nth(1).isChecked(), false);
    failCreate = false;
    await newCategory.press('Enter');
    await page.waitForFunction(() => document.querySelector('#watch-add-dialog [data-role="options"] input[value="3"]')?.checked);
    await page.setViewportSize({width: 375, height: 812});
    assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth), true, 'Dialog fits a narrow viewport');
    fs.mkdirSync('.probe/ladder-watchlist', {recursive: true});
    await page.screenshot({path: '.probe/ladder-watchlist/mobile.png'});
    await page.setViewportSize({width: 1440, height: 1000});
    await page.screenshot({path: '.probe/ladder-watchlist/desktop.png'});
    oldServer = true;
    await submit.click();
    await page.waitForFunction(() => document.querySelector('#watch-add-dialog [data-role="error"]').textContent.includes('重新启动系统'));
    assert.equal(await stocks.nth(1).isChecked(), false, 'An outdated server keeps exclusions');
    assert.equal(await options.last().isChecked(), true, 'An outdated server keeps categories');
    assert.equal(writes.length, 0, 'A missing batch endpoint cannot write stocks');
    oldServer = false;
    failBatch = true;
    await submit.click();
    await page.waitForFunction(() => document.querySelector('#watch-add-dialog [data-role="error"]').textContent.includes('保存失败'));
    assert.equal(await stocks.nth(1).isChecked(), false, 'Save failure keeps exclusions');
    assert.equal(await options.last().isChecked(), true, 'Save failure keeps categories');
    assert.deepEqual(writes[0], {items: [
      {code: 'sz.000001', name: '已自选机器人'}, {code: 'sz.300003', name: '<创业板机器人>'},
    ], source_date: dates[1], category_ids: [3], replace_categories: false});
    failBatch = false;
    let releaseSave;
    saveGate = new Promise(resolve => { releaseSave = resolve; });
    await submit.click();
    await page.waitForFunction(() => document.querySelector('#watch-add-dialog [data-action="cancel"]').disabled);
    assert.equal(await dialog.locator('[data-action="retry"]').isDisabled(), true);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 1, 'An in-flight write cannot be cancelled');
    await submit.evaluate(node => node.form.dispatchEvent(new Event('submit', {cancelable: true})));
    await page.waitForTimeout(50);
    assert.equal(writes.length, 2, 'Repeated submit cannot start another batch');
    releaseSave(); saveGate = null;
    await dialog.waitFor({state: 'detached'});
    assert.deepEqual(watched[0].categories.map(category => category.id), [1, 3]);
    assert.equal(watched.some(item => item.code === 'sz.000002'), false, 'Excluded stocks are not added');
    assert.ok((await page.locator('#alert-area').textContent()).includes('已保存 2 只'));

    await open();
    await dialog.locator('[data-action="none"]').click();
    await stocks.first().check();
    await options.nth(1).check();
    await dialog.locator('[data-role="mode"]').selectOption('replace');
    assert.ok((await dialog.locator('[data-role="mode-hint"]').textContent()).includes('替换'));
    await submit.click();
    await dialog.waitFor({state: 'detached'});
    assert.deepEqual(watched[0].categories.map(category => category.id), [2], 'Existing stocks can be reclassified');

    await open();
    await dialog.locator('[data-action="none"]').click();
    await stocks.first().check();
    await newCategory.fill('直接加入时新建');
    await submit.click();
    await dialog.waitFor({state: 'detached'});
    const automatic = categories.find(category => category.name === '直接加入时新建');
    assert.ok(automatic, 'Submitting creates a typed category without a separate create click');
    assert.deepEqual(watched[0].categories.map(category => category.id), [2, automatic.id]);
    assert.deepEqual(writes.at(-1).category_ids, [automatic.id]);

    empty = true;
    await open();
    assert.equal(await submit.isDisabled(), true, 'An empty snapshot cannot be saved');
    await page.keyboard.press('Escape');
    await dialog.waitFor({state: 'detached'});
    assert.equal(await entry.evaluate(node => node === document.activeElement), true, 'Closing restores focus');
    empty = false;
    let releaseLoad;
    loadGate = new Promise(resolve => { releaseLoad = resolve; });
    await entry.click();
    await dialog.locator('[data-action="cancel"]').click();
    releaseLoad(); loadGate = null;
    await page.waitForTimeout(80);
    assert.equal(await dialog.count(), 0, 'Late loading results cannot reopen a cancelled dialog');
    assert.ok(reads.includes(dates[0]) && reads.includes(dates[1]));
    assert.deepEqual(errors, []);
    console.log('Ladder batch watchlist date, theme, exclusions, categories, retry and dialog checks passed');
  } finally {
    await browser.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
