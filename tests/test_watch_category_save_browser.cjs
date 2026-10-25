// 使用独立服务和临时数据库；自选、分类与页面显示均走真实接口，只有天梯行情使用合成数据。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  fs.mkdirSync('.probe', {recursive: true});
  const directory = fs.mkdtempSync(path.resolve('.probe/category-save-'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.env.PYTHON_COMMAND || 'python', ['-X', 'utf8', '-m', 'uvicorn',
    'app.main:create_app', '--factory', '--host', '127.0.0.1', '--port', String(port)], {
    windowsHide: true, env: {...process.env, FINDSTOCK_DATA_DIR: directory,
      FINDSTOCK_DB_PATH: path.join(directory, 'test.sqlite3'), FINDSTOCK_LOG_DIR: path.join(directory, 'logs')},
  });
  let output = '', browser;
  server.stdout.on('data', chunk => { output += chunk; });
  server.stderr.on('data', chunk => { output += chunk; });
  server.on('error', error => { output += error.message; });
  const api = async (url, body) => {
    const response = await fetch(base + url, body === undefined ? {} : {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
    });
    assert.equal(response.ok, true, `${url}: HTTP ${response.status}`);
    return response.json();
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await api('/api/health'); ready = true; break; } catch {}
      if (server.exitCode !== null) break;
      await pause(100);
    }
    assert.equal(ready, true, output);
    const original = await api('/api/watchlist/categories', {name: '原分类'});
    await api('/api/watchlist', {code: 'sz.000001', name: '已有机器人', note: '保留原备注', category_ids: [original.id]});
    browser = await chromium.launch({channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true});
    const page = await browser.newPage({viewport: {width: 1440, height: 1000}}), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const day = '2026-10-23', theme = '机器人概念';
    const items = ['已有机器人', '新机器人', '不加入机器人'].map((name, index) => ({
      code: `sz.00000${index + 1}`, name, primary_theme: theme, consecutive: 1,
      board: 'main_sz', board_label: '深市主板', is_st: false,
    }));
    await page.route('**/api/stock-ladder**', route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/themes/status')) return route.fulfill({json: {
        configured: false, running: false, total_days: 1, completed_days: 1, pending_days: 0,
        calls_today: 0, daily_limit: 50, download_allowed: false,
      }});
      if (url.pathname.endsWith('/theme-candidates')) return route.fulfill({json: {
        trade_date: day, trading_days: [day], covered_dates: [day], classified_dates: [day],
        themes: [{name: theme, stock_count: 3}], unclassified_count: 0,
      }});
      return route.fulfill({json: {trade_date: day, trading_days: [day], items,
        fetched_at: `${day}T16:00:00+08:00`, is_final: true, theme_complete: true, data_source: 'local'}});
    });
    await page.goto(base + '/stock-ladder');
    await page.waitForFunction(() => ladderData && !ladderBusy && !ladderThemeLoading);
    await page.locator('#ladder-theme').selectOption(theme);
    await page.locator('#ladder-watch-add').click();
    const dialog = page.locator('#watch-add-dialog');
    await page.waitForFunction(() => document.querySelector('#watch-add-dialog fieldset')?.disabled === false);
    await dialog.locator('[data-role="stocks"] input[value="sz.000003"]').uncheck();
    await dialog.locator('[data-role="new-category"]').fill(theme);
    await dialog.locator('[type="submit"]').click();
    await dialog.waitFor({state: 'detached'});
    let saved = await api('/api/watchlist');
    const category = saved.categories.find(value => value.name === theme);
    assert.equal(category.count, 2, 'Typed category is created and assigned in the real database');
    assert.equal(saved.items.some(item => item.code === 'sz.000003'), false, 'Exclusions survive auto-creation');
    assert.equal(saved.items.find(item => item.code === 'sz.000001').note, '保留原备注');
    assert.deepEqual(saved.items.find(item => item.code === 'sz.000001').categories.map(value => value.id).sort(), [original.id, category.id].sort());
    await page.goto(base + '/watchlist');
    const chip = page.locator(`.cat-chip[data-category="${category.id}"]`);
    await chip.waitFor();
    assert.ok((await chip.textContent()).includes(theme), 'The real watchlist page displays the new category');
    await chip.click();
    assert.equal(await page.locator('.watch-card').count(), 2);

    // 选股和 K 线共用的单股收藏弹窗，也必须处理直接提交时尚未创建的分类名。
    await page.evaluate(() => { window.singleAdd = addWatchWithCategories({code: 'sz.000004', name: '单股机器人'}); });
    await page.waitForFunction(() => document.querySelector('#watch-add-dialog fieldset')?.disabled === false);
    await dialog.locator('[data-role="new-category"]').fill('单股新分类');
    await dialog.locator('[type="submit"]').click();
    await dialog.waitFor({state: 'detached'});
    await page.evaluate(() => window.singleAdd);
    await page.reload();
    await page.locator('#category-chips').getByRole('button', {name: /单股新分类/}).waitFor();
    saved = await api('/api/watchlist');
    assert.equal(saved.categories.find(value => value.name === '单股新分类').count, 1);

    await page.route('**/api/watchlist/categories', route => route.request().method() === 'POST'
      ? route.fulfill({status: 503, json: {error: {message: '模拟分类创建失败'}}}) : route.continue());
    await page.evaluate(() => { window.failedAdd = addWatchWithCategories({code: 'sz.000005', name: '不能误加入'}); });
    await page.waitForFunction(() => document.querySelector('#watch-add-dialog fieldset')?.disabled === false);
    await dialog.locator('[data-role="new-category"]').fill('失败后保留名称');
    await dialog.locator('[type="submit"]').click();
    await dialog.locator('[data-role="error"]').waitFor({state: 'visible'});
    assert.equal(await dialog.locator('[data-role="new-category"]').inputValue(), '失败后保留名称');
    assert.equal((await api('/api/watchlist')).items.some(item => item.code === 'sz.000005'), false);
    await dialog.locator('[data-action="cancel"]').click();
    assert.deepEqual(errors, []);
    console.log('Real API/browser category save checks passed: typed names, batch/single save, exclusions, preserved notes, category counts and watchlist navigation.');
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
