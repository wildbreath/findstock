// 真后端 + 浏览器联调；数据库、日志与截图只写入本次创建的 .probe 临时目录。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {spawn, execFileSync} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

(async () => {
  const root = path.resolve(__dirname, '..'), probe = path.join(root, '.probe');
  fs.mkdirSync(probe, {recursive: true});
  const directory = fs.mkdtempSync(path.join(probe, 'review-api-browser-'));
  const database = path.join(directory, 'data', 'test.sqlite3');
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(path.join(root, '.venv', 'Scripts', 'python.exe'), [
    '-m', 'uvicorn', '--factory', 'app.main:create_app', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning',
  ], {cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', FINDSTOCK_ACCESS_TOKEN: '',
    FINDSTOCK_DATA_DIR: path.join(directory, 'data'), FINDSTOCK_DB_PATH: database,
    FINDSTOCK_LOG_DIR: path.join(directory, 'logs'), FINDSTOCK_SYNC_WORKERS: '1',
    FINDSTOCK_WEB_DIR: path.join(root, 'web'), FINDSTOCK_ALLOWED_HOSTS: '127.0.0.1,localhost,[::1]',
  }});
  let output = '', launchError, browser;
  server.stdout.on('data', data => { output = (output + data).slice(-12000); });
  server.stderr.on('data', data => { output = (output + data).slice(-12000); });
  server.on('error', error => { launchError = error; });
  try {
    let health;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (launchError) throw launchError;
      if (server.exitCode !== null) throw new Error(`Test server exited: ${output}`);
      try {
        const response = await fetch(`${origin}/api/health`, {signal: AbortSignal.timeout(1000)});
        if (response.ok) { health = await response.json(); break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(health, `Test server did not become ready: ${output}`);
    assert.equal(path.resolve(health.database).toLowerCase(), database.toLowerCase(), 'The server must use its isolated database');
    execFileSync(path.join(root, '.venv', 'Scripts', 'python.exe'), ['-X', 'utf8', '-c', `
import sqlite3, sys
from datetime import date, timedelta
with sqlite3.connect(sys.argv[1]) as connection:
    connection.executemany(
        'INSERT INTO stock (code, exchange, symbol, name, board, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [('sh.600901', 'sh', '600901', '手工沪甲', 'main_sh', '2026-10-27T00:00:00+08:00'),
         ('sz.002901', 'sz', '002901', '手工深乙', 'main_sz', '2026-10-27T00:00:00+08:00')],
    )
    days = [date(2026, 10, 15) + timedelta(days=i) for i in range(12)]
    connection.executemany('INSERT INTO trading_day (trade_date,is_open) VALUES (?,?)',
        [(str(day), day.weekday() < 5) for day in days])
    connection.executemany('INSERT INTO daily_bar (code,trade_date,close,preclose,pct_chg) VALUES (?,?,?,?,?)',
        [(code, str(day), 10.325, 10, '3.25') for code in ('sh.600901', 'sz.002901')
         for day in (date(2026, 10, 23), date(2026, 10, 26))])
`, database], {cwd: root, windowsHide: true});
    const read = async () => {
      const response = await fetch(`${origin}/api/review-sheet`);
      assert.equal(response.status, 200);
      return response.json();
    };
    const dates = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-26'];
    const fixture = {revision: 0, dates, hidden_dates: [dates[0]], collected_dates: [dates[2]], rows: [
      {id: 'agriculture-first', theme: '农业', cells: {[dates[1]]: {text: '农业甲', kind: 'stock'}}},
      {id: 'finance', leader: true, tracking: {code: 'sh.600001', theme: '金融', entry_date: dates[2], stopped: true},
        cells: {[dates[0]]: {text: '金融', auto_text: '金融', kind: 'theme'}, [dates[1]]: {text: '金融乙', kind: 'stock'},
          [dates[2]]: {text: '人工备注', highlight: true, bold: true}}},
      {id: 'blank', cells: {}},
      {id: 'agriculture-last', theme: '农业', cells: {[dates[2]]: {text: '+5%', auto_text: '+5%'}}},
      {id: 'manual', theme: '未分类', stock_code: 'sz.300001', cells: {[dates[1]]: {text: '手工甲', kind: 'stock'}}},
    ]};
    const seeded = await fetch(`${origin}/api/review-sheet`, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(fixture)});
    assert.equal(seeded.status, 200, await seeded.text());
    const original = await read();
    assert.equal(original.rows.find(row => row.id === 'manual').stock_code, 'sz.300001');
    assert.equal(original.rows.find(row => row.id === 'manual').theme, '未分类');

    browser = await chromium.launch({channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true});
    const page = await browser.newPage({viewport: {width: 1440, height: 1050}});
    const errors = [];
    let failNextSave = false, realSaves = 0;
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    page.on('response', response => {
      if (response.url() === `${origin}/api/review-sheet` && response.request().method() === 'PUT' && response.status() === 200) realSaves++;
    });
    await page.route('**/api/review-sheet', route => {
      if (route.request().method() !== 'PUT' || !failNextSave) return route.continue();
      failNextSave = false;
      return route.fulfill({status: 422, json: {error: {code: 'validation_error', message: '请求参数不合法', details: {
        errors: [{loc: ['body', 'rows', 0, 'theme'], msg: 'String should have at most 2000 characters'}],
      }}}});
    });
    const loaded = () => page.waitForFunction(() => reviewLoaded);
    const index = id => page.evaluate(id => reviewSheet.rows.findIndex(row => row.id === id), id);
    const select = async id => page.locator(`[data-row="${await index(id)}"]`).click();
    const flush = async () => {
      await page.locator('#review-save').click();
      await page.waitForFunction(() => !reviewDirty && !reviewSaving);
    };
    const edit = async (id, day, text) => {
      const r = await index(id), c = await page.evaluate(day => reviewDays.indexOf(day), day);
      const cell = page.locator(`.review-cell[data-r="${r}"][data-c="${c}"]`);
      await cell.dblclick(); await cell.fill(text); await cell.press('Enter');
    };
    await page.goto(`${origin}/review`); await loaded();
    await select('finance');
    await page.locator('#review-theme-edit').click();
    await page.locator('#review-theme-value').fill(' 农业 ');
    await page.getByRole('button', {name: '保存并归组'}).click();
    await flush();
    let saved = await read();
    assert.deepEqual(saved.rows.map(row => row.id), ['agriculture-first', 'finance', 'agriculture-last', 'manual']);
    const finance = saved.rows.find(row => row.id === 'finance');
    assert.equal(finance.theme, '农业'); assert.equal(finance.tracking.theme, '农业');
    assert.equal(finance.cells[dates[0]].text, '农业');
    assert.equal(finance.leader, true); assert.equal(finance.tracking.stopped, true);
    assert.deepEqual(finance.cells[dates[2]], original.rows.find(row => row.id === 'finance').cells[dates[2]]);
    assert.deepEqual(saved.hidden_dates, [dates[0]]);
    await page.reload(); await loaded();
    assert.equal(await page.evaluate(() => reviewSheet.rows.find(row => row.id === 'finance').theme), '农业');

    const beforeDelete = saved.rows;
    await select('finance'); await page.locator('#review-delete-row').click(); await flush();
    saved = await read();
    assert.deepEqual(saved.rows.map(row => row.id), ['agriculture-first', 'agriculture-last', 'manual']);
    await page.locator('#review-undo').click(); await flush();
    assert.deepEqual((await read()).rows, beforeDelete, 'Undo must persist the deleted record, hidden cells and complete layout');
    await page.reload(); await loaded();

    const beforeFailure = await read();
    failNextSave = true;
    await edit('manual', dates[3], '保存失败也不能丢失的备注');
    await page.locator('#review-save').click();
    await page.waitForFunction(() => reviewDirty && !reviewSaving && document.querySelector('#review-status').dataset.state === 'error');
    const notice = await page.locator('#review-notice').innerText();
    assert.match(notice, /题材|参数|不合法|校验/); assert.doesNotMatch(notice, /^请求失败 \(HTTP 422\)$/);
    assert.deepEqual((await read()).rows, beforeFailure.rows, 'Rejected saves must leave the real database unchanged');
    const draft = await page.evaluate(() => JSON.parse(localStorage.getItem(reviewDraftKey)));
    assert.equal(draft.rows.find(row => row.id === 'manual').cells[dates[3]].text, '保存失败也不能丢失的备注');
    await page.reload(); await loaded();
    assert.equal(await page.evaluate(day => reviewSheet.rows.find(row => row.id === 'manual').cells[day].text, dates[3]), '保存失败也不能丢失的备注');
    await flush();
    assert.equal((await read()).rows.find(row => row.id === 'manual').cells[dates[3]].text, '保存失败也不能丢失的备注');

    await page.locator('#review-zoom').selectOption('0.75');
    await edit('manual', dates[4], '缩放后仍能真实保存'); await flush();
    await page.reload(); await loaded();
    assert.equal(await page.locator('#review-zoom').inputValue(), '0.75');
    saved = await read();
    assert.equal(saved.rows.find(row => row.id === 'manual').cells[dates[4]].text, '缩放后仍能真实保存');
    assert.equal(saved.rows.find(row => row.id === 'manual').stock_code, 'sz.300001');
    assert.equal(saved.rows.find(row => row.id === 'manual').tracking, null);
    await page.locator(`[data-chart-row="${await index('manual')}"]`).click();
    await page.locator('.chart-error').waitFor();
    assert.match(await page.locator('.chart-error').innerText(), /本地|不存在|未找到|日线/);
    await page.locator('#chart-close').click();

    await page.locator('#review-zoom-reset').click();
    const stocks = [{code: 'sh.600901', name: '手工沪甲'}, {code: 'sz.002901', name: '手工深乙'}];
    const pickStock = async stock => {
      if (await page.locator('[data-review-source="search"]').getAttribute('aria-pressed') !== 'true') await page.locator('[data-review-source="search"]').click();
      await page.locator('#review-add-stock-query').fill(stock.name);
      await page.locator('#review-add-stocks-search').getByRole('button', {name: '搜索', exact: true}).click();
      await page.locator(`[data-add-stock-code="${stock.code}"]`).check();
    };
    const joinStocks = async (items, day) => {
      await page.locator('#review-add-stocks').click();
      for (const stock of items) await pickStock(stock);
      await page.locator('#review-add-stock-theme').fill('手工测试题材');
      await page.locator('#review-add-stock-date').selectOption(day);
      await page.locator('#review-add-stock-submit').click();
      await page.waitForFunction(() => !reviewCollecting);
      if (await page.locator('#review-add-stocks-dialog').isVisible()) {
        await page.locator('#review-add-stocks-dialog [data-review-dialog-close]').click();
      }
      await flush();
    };
    const beforeJoining = await read();
    await joinStocks(stocks, dates[4]);
    saved = await read();
    const joined = saved.rows.filter(row => stocks.some(stock => stock.code === row.stock_code));
    assert.equal(joined.length, 2, 'Selections made in separate real stock searches are added together');
    for (const stock of stocks) {
      const row = joined.find(row => row.stock_code === stock.code);
      assert.equal(row.theme, '手工测试题材');
      assert.equal(row.cells[dates[3]].text, stock.name);
      assert.equal(row.cells[dates[3]].kind, 'stock');
      assert.equal(row.cells[dates[4]].text, '+3.25%');
      assert.equal(row.cells[dates[5]].text, '+3.25%', 'Local history after the entry date is filled automatically');
      assert.equal(row.tracking.entry_date, dates[4]);
    }
    for (const originalRow of beforeJoining.rows) {
      assert.deepEqual(saved.rows.find(row => row.id === originalRow.id), originalRow, 'Adding stocks preserves existing records');
    }
    await page.reload(); await loaded();
    assert.equal(await page.evaluate(() => reviewSheet.rows.filter(row => ['sh.600901', 'sz.002901'].includes(row.stock_code)).length), 2);
    const sameDayRows = (await read()).rows;
    await joinStocks([stocks[0]], dates[4]);
    assert.deepEqual((await read()).rows, sameDayRows, 'The same stock cannot be added twice for the same date');
    await joinStocks([stocks[0]], dates[5]);
    saved = await read();
    const repeated = saved.rows.filter(row => row.stock_code === stocks[0].code);
    assert.equal(repeated.length, 2, 'The same stock can retain a separate record on another date');
    assert.equal(repeated.filter(row => row.tracking?.entry_date === dates[5]).length, 1);

    const beforeBatch = saved.rows;
    const batchIds = ['agriculture-first', saved.rows.find(row => row.stock_code === stocks[1].code).id];
    for (const id of batchIds) await page.locator(`[data-review-row-check="${await index(id)}"]`).check();
    await page.locator('#review-theme-edit').click();
    await page.locator('#review-theme-value').fill('批量人工题材');
    await page.getByRole('button', {name: '保存并归组'}).click();
    await flush();
    saved = await read();
    for (const row of beforeBatch) {
      const actual = saved.rows.find(value => value.id === row.id);
      if (batchIds.includes(row.id)) assert.equal(actual.theme, '批量人工题材');
      else assert.deepEqual(actual, row, 'Non-adjacent bulk editing must leave unselected records unchanged');
    }
    assert.deepEqual(saved.hidden_dates, [dates[0]]);
    await page.locator('#review-undo').click(); await flush();
    assert.deepEqual((await read()).rows, beforeBatch, 'One undo persists the complete state before the bulk edit');

    await select('manual');
    const beforeNewRows = (await read()).rows;
    const inheritedTheme = beforeNewRows.find(row => row.id === 'manual').theme;
    await page.locator('#review-add-row').click();
    assert.equal(await page.locator('#review-new-row-theme').inputValue(), inheritedTheme);
    await page.locator('#review-new-row-count').fill('2');
    await page.locator('#review-new-row-position').selectOption('after');
    await page.getByRole('button', {name: '新增并编辑', exact: true}).click();
    await page.keyboard.press('Escape');
    await flush();
    saved = await read();
    const newRows = saved.rows.filter(row => !beforeNewRows.some(old => old.id === row.id));
    assert.equal(newRows.length, 2);
    assert.ok(newRows.every(row => row.theme === inheritedTheme && row.tracking === null));
    const manualPosition = saved.rows.findIndex(row => row.id === 'manual');
    assert.deepEqual(saved.rows.slice(manualPosition + 1, manualPosition + 3).map(row => row.id), newRows.map(row => row.id), 'New rows are inserted together below the selected record');
    await page.locator('#review-undo').click(); await flush();
    assert.deepEqual((await read()).rows, beforeNewRows, 'One undo removes the entire inserted batch and persists the original rows');
    await page.reload(); await loaded();
    await page.screenshot({path: path.join(directory, 'review-api-browser.png'), fullPage: true});
    assert.ok(realSaves >= 11, 'Successful saves must reach the actual HTTP server');
    assert.deepEqual(errors, []);
    console.log(`Review real-API browser checks passed: ${realSaves} real saves; theme persistence, delete/undo, new fields, rejected-save draft recovery, zoom memory, stock searches/addition, same-day deduplication, non-adjacent bulk edits, multi-row insertion and missing-chart feedback.`);
  } finally {
    try {
      if (browser) await browser.close();
    } finally {
      if (server.pid && server.exitCode === null) {
        if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
        else server.kill('SIGTERM');
      }
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
