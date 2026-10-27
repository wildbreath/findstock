// 手工录入与批量操作回归：页面、搜索、保存全部隔离，不读写实际复盘数据。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const clone = value => JSON.parse(JSON.stringify(value));
const priorDays = day => {
  const cursor = new Date(`${day}T12:00:00Z`), result = [];
  while (result.length < 2) { cursor.setUTCDate(cursor.getUTCDate() - 1); if (![0, 6].includes(cursor.getUTCDay())) result.unshift(cursor.toISOString().slice(0, 10)); }
  return result;
};

(async () => {
  const browser = await chromium.launch({channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
    const dates = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22'];
    const tracked = (id, code, theme, name) => ({id, theme, leader: false,
      tracking: {code, theme, entry_date: dates[1], stopped: false}, cells: {
        [dates[0]]: {text: `${name}隐藏备注`, highlight: true},
        [dates[1]]: {text: name, kind: 'stock'}, [dates[2]]: {text: '+5%', auto_text: '+5%'},
      }});
    const original = [tracked('a1', 'sh.600001', '农业', '甲股'), tracked('b1', 'sh.600002', '金融', '乙股'),
      tracked('a2', 'sh.600003', '农业', '丙股'), tracked('b2', 'sh.600004', '金融', '丁股'),
      {id: 'manual', theme: '农业', stock_code: 'sz.300001', cells: {[dates[1]]: {text: '手工旧股', kind: 'stock'}}}];
    const stockA = {code: 'sh.600010', name: '手工甲'}, stockB = {code: 'sz.000010', name: '手工乙'};
    const trackedStock = {code: 'sh.600001', name: '甲股'};
    let saved = {revision: 1, dates, hidden_dates: [dates[0]], collected_dates: [dates[1]], rows: clone(original)};
    const errors = [], unexpected = [], puts = [];
    let failPrepare = false;
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      if (path === '/review') return route.fulfill({contentType: 'text/html', body: fs.readFileSync('web/review.html', 'utf8')});
      if (path.startsWith('/static/')) {
        const file = path.split('/').at(-1);
        if (fs.existsSync(`web/${file}`)) return route.fulfill({contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(`web/${file}`, 'utf8')});
      }
      if (path === '/api/review-sheet' && request.method() === 'GET') return route.fulfill({json: clone(saved)});
      if (path === '/api/review-sheet' && request.method() === 'PUT') {
        const payload = request.postDataJSON();
        if (payload.revision !== saved.revision) return route.fulfill({status: 409, json: {error: {code: 'review_conflict', message: '其他页面已更新'}}});
        puts.push(clone(payload)); saved = {...payload, revision: saved.revision + 1};
        return route.fulfill({json: clone(saved)});
      }
      if (path === '/api/review-sheet/collect-dates') return route.fulfill({json: {dates}});
      if (path === '/api/review-sheet/stock-rows') {
        if (failPrepare) return route.fulfill({status: 500, json: {error: {message: '补齐暂时失败'}}});
        const {stocks, theme, trade_date: day} = request.postDataJSON();
        const [themeDay, nameDay] = priorDays(day), marketDays = [...new Set([day, ...dates.filter(value => value >= day)])].sort();
        return route.fulfill({json: {dates: [themeDay, nameDay, ...marketDays], missing_cells: 0,
          rows: stocks.map(stock => ({id: `joined-${stock.code}-${theme}-${day}`, stock_code: stock.code, theme,
            tracking: {code: stock.code, theme, entry_date: day, stopped: false}, cells: {
              [themeDay]: {text: theme, kind: 'theme'}, [nameDay]: {text: stock.name, kind: 'stock'},
              ...Object.fromEntries(marketDays.map(value => [value, {text: '+3.25%', auto_text: '+3.25%', background: '#efb7b2'}])),
            }}))}});
      }
      if (path === '/api/stocks/search') {
        const query = url.searchParams.get('q');
        return route.fulfill({json: query.includes('600001') ? [trackedStock] : query.includes('乙') ? [stockB] : [stockA]});
      }
      if (path === '/api/watchlist') return route.fulfill({json: {items: [{...stockA, categories: [{id: 1, name: '核心'}]}, {...trackedStock, categories: []}],
        categories: [{id: 1, name: '核心', count: 1}], codes: [stockA.code, trackedStock.code]}});
      if (path === '/api/stock-ladder') return route.fulfill({json: {items: [{...stockB, consecutive: 3, primary_theme: '金融'}],
        trading_days: dates, trade_date: url.searchParams.get('date') || dates[3], is_final: true}});
      if (path.endsWith('/chart')) return route.fulfill({status: 404, json: {error: {message: '测试股票没有本地日线'}}});
      unexpected.push(path); return route.abort();
    });
    const loaded = () => page.waitForFunction(() => reviewLoaded);
    const rows = () => page.evaluate(() => reviewSheet.rows);
    const index = id => page.evaluate(id => reviewSheet.rows.findIndex(row => row.id === id), id);
    const checkbox = async id => page.locator(`[data-review-row-check="${await index(id)}"]`);
    const select = async id => page.locator(`[data-row="${await index(id)}"]`).click();
    const check = async (...ids) => { for (const id of ids) await (await checkbox(id)).check(); };
    const checked = () => page.locator('#review-grid [data-review-row-check]:checked').evaluateAll(nodes =>
      nodes.map(node => reviewSheet.rows[Number(node.dataset.reviewRowCheck)].id).sort());
    const flush = async () => {
      await page.locator('#review-save').click();
      await page.waitForFunction(() => !reviewDirty && !reviewSaving);
    };
    const reset = async () => {
      await flush(); saved = {...saved, revision: saved.revision + 1, rows: clone(original)};
      await page.reload(); await loaded();
    };
    const close = async id => { if (await page.locator(id).isVisible()) await page.locator(`${id} [data-review-dialog-close]`).first().click(); };
    const stockSearch = async query => {
      if (await page.locator('[data-review-source="search"]').getAttribute('aria-pressed') !== 'true') await page.locator('[data-review-source="search"]').click();
      await page.locator('#review-add-stock-query').fill(query);
      await page.locator('#review-add-stock-query').press('Enter');
    };
    const addStock = async (query, stock, day, theme = '农业') => {
      await page.locator('#review-add-stocks').click();
      await stockSearch(query);
      await page.locator(`input[data-add-stock-code="${stock.code}"]`).check();
      await page.locator('#review-add-stock-theme').fill(theme);
      await page.locator('#review-add-stock-date').selectOption(day);
      await page.locator('#review-add-stock-submit').click();
      await page.waitForFunction(() => !reviewCollecting);
    };

    await page.goto('http://localhost/review'); await loaded();
    await check('a1', 'a2');
    await (await checkbox('a2')).uncheck();
    assert.deepEqual(await checked(), ['a1']);
    assert.equal(await page.evaluate(() => reviewSheet.rows[reviewAnchor.r].id), 'a1', 'Unchecking the active row moves the anchor to a remaining checked record');
    assert.match(await page.locator('#review-address').innerText(), /甲股/);
    assert.doesNotMatch(await page.locator('#review-address').innerText(), /丙股/);
    const rightClicked = page.locator(`.review-cell[data-r="${await index('a1')}"][data-c="1"]`);
    await rightClicked.click({button: 'right'});
    await page.locator('#review-cell-menu [data-review-action="edit"]').click();
    assert.equal(await rightClicked.evaluate(node => node === document.activeElement && node.isContentEditable), true, 'Context-menu editing targets the right-clicked cell inside a checked row');
    await rightClicked.fill('+6%右键备注'); await rightClicked.press('Enter');
    assert.equal((await rows()).find(row => row.id === 'a1').cells[dates[2]].text, '+6%右键备注');
    assert.deepEqual((await rows()).find(row => row.id === 'a2'), original.find(row => row.id === 'a2'));
    await page.locator('#review-undo').click(); assert.deepEqual(await rows(), original);
    await check('a1', 'a2');
    assert.deepEqual(await checked(), ['a1', 'a2']);
    assert.match(await page.locator('#review-row-selection').innerText(), /2/);
    await page.locator('#review-theme-edit').click();
    await page.locator('#review-theme-value').fill('科技');
    await page.getByRole('button', {name: '保存并归组'}).click();
    const themed = await rows(), touched = themed.filter(row => ['a1', 'a2'].includes(row.id));
    assert.ok(touched.every(row => row.theme === '科技' && row.tracking.theme === '科技'));
    for (const id of ['b1', 'b2', 'manual']) assert.deepEqual(themed.find(row => row.id === id), original.find(row => row.id === id), 'Unselected records must remain intact');
    assert.ok(touched.every(row => row.cells[dates[0]].text.endsWith('隐藏备注')));
    assert.equal(Math.abs(themed.findIndex(row => row.id === 'a1') - themed.findIndex(row => row.id === 'a2')), 1);
    await page.locator('#review-undo').click(); assert.deepEqual(await rows(), original);
    await page.locator('#review-redo').click(); await flush();
    await page.reload(); await loaded();
    assert.ok((await rows()).filter(row => ['a1', 'a2'].includes(row.id)).every(row => row.theme === '科技'));

    await reset(); await check('a1', 'a2');
    await page.locator('#review-leader').click();
    assert.deepEqual((await rows()).filter(row => row.leader).map(row => row.id).sort(), ['a1', 'a2']);
    await page.locator('#review-tracking').click();
    assert.deepEqual((await rows()).filter(row => row.tracking?.stopped).map(row => row.id).sort(), ['a1', 'a2']);
    const copied = await page.evaluate(() => {
      const data = new DataTransfer();
      document.querySelector('#review-grid').dispatchEvent(new ClipboardEvent('copy', {bubbles: true, cancelable: true, clipboardData: data}));
      return data.getData('text/plain');
    });
    assert.match(copied, /甲股/); assert.match(copied, /丙股/); assert.doesNotMatch(copied, /乙股|丁股|手工旧股/);
    const beforePaste = await rows();
    await page.evaluate(() => {
      const data = new DataTransfer(); data.setData('text/plain', '不能覆盖未选行');
      document.querySelector('#review-grid').dispatchEvent(new ClipboardEvent('paste', {bubbles: true, cancelable: true, clipboardData: data}));
    });
    assert.deepEqual(await rows(), beforePaste, 'Pasting into a non-contiguous row selection must not modify any record');
    assert.match(await page.locator('#review-notice').innerText(), /单元格|多选|连续|勾选/);
    await page.locator('#review-bold').click();
    const formatted = await rows();
    assert.ok(formatted.filter(row => ['a1', 'a2'].includes(row.id)).every(row => row.cells[dates[1]].bold));
    assert.deepEqual(formatted.find(row => row.id === 'b1'), original.find(row => row.id === 'b1'));
    const beforeDelete = await rows();
    await page.locator('#review-delete-row').click();
    assert.deepEqual((await rows()).map(row => row.id), ['b1', 'b2', 'manual']);
    await page.locator('#review-undo').click(); assert.deepEqual(await rows(), beforeDelete);
    await flush();

    await reset(); await check('b1', 'b2');
    await page.locator('#review-row-up').click();
    assert.deepEqual((await rows()).map(row => row.id), ['b1', 'a1', 'b2', 'a2', 'manual']);
    assert.deepEqual(await checked(), ['b1', 'b2'], 'Selection follows row IDs through movement');
    await page.locator('#review-row-down').click();
    assert.deepEqual(await rows(), original);
    await page.locator('#review-grid [data-review-select-all]').check();
    assert.equal((await checked()).length, original.length);
    await page.locator('#review-clear-row-selection').click(); assert.deepEqual(await checked(), []);
    await select('a1'); await page.locator('#review-select-theme').click();
    assert.deepEqual(await checked(), ['a1', 'a2', 'manual']);
    await page.locator('.review-cell[data-r="1"][data-c="0"]').click();
    assert.deepEqual(await checked(), [], 'Clicking a normal cell exits row-checkbox selection');
    await select('a1');
    await page.locator(`[data-row="${await index('a2')}"]`).click({modifiers: ['Shift']});
    assert.deepEqual(await page.locator('#review-grid td.is-selected').evaluateAll(cells => [...new Set(cells.map(cell => Number(cell.firstElementChild.dataset.r)))]), [0, 1, 2]);

    await reset(); await select('a1');
    await page.locator('#review-add-row').click();
    assert.equal(await page.locator('#review-new-row-theme').inputValue(), '农业');
    await page.locator('#review-new-row-count').fill('3');
    await page.locator('#review-new-row-position').selectOption('after');
    await page.getByRole('button', {name: '新增并编辑'}).click();
    let added = (await rows()).filter(row => !original.some(old => old.id === row.id));
    assert.equal(added.length, 3); assert.ok(added.every(row => row.theme === '农业' && !row.tracking));
    assert.equal((await rows())[1].id, added[0].id);
    assert.equal(await page.evaluate(() => reviewSheet.rows[reviewAnchor.r].id), added[0].id);
    await page.keyboard.press('Escape'); await flush();
    await page.locator('#review-undo').click(); assert.deepEqual(await rows(), original, 'A whole multi-row insert is undone in one step');
    await select('a1'); await page.locator('#review-insert-above').click();
    assert.equal((await rows())[1].id, 'a1');
    await page.keyboard.press('Escape'); await page.locator('#review-undo').click();
    await select('a1'); await page.locator('#review-insert-row').click();
    const insertedRows = await rows();
    assert.equal(insertedRows[0].id, 'a1'); assert.ok(!original.some(row => row.id === insertedRows[1].id));
    await page.keyboard.press('Escape'); await page.locator('#review-undo').click();
    await page.locator('#review-add-row').click();
    await page.locator('#review-new-row-count').fill('1001');
    await page.getByRole('button', {name: '新增并编辑'}).click();
    assert.deepEqual(await rows(), original, 'Invalid quantity must not partially insert records');
    assert.equal(await page.locator('#review-new-rows-dialog').isVisible(), true);
    await page.locator('#review-new-row-count').fill('2');
    await page.locator('#review-new-row-position').selectOption('end');
    await page.locator('#review-new-row-theme').fill('新题材');
    await page.getByRole('button', {name: '新增并编辑'}).click();
    assert.ok((await rows()).slice(-2).every(row => row.theme === '新题材'));
    await page.keyboard.press('Escape'); await page.locator('#review-undo').click();

    await reset(); await select('a1');
    await page.locator('#review-add-stocks').click();
    await stockSearch('甲'); await page.locator(`input[data-add-stock-code="${stockA.code}"]`).check();
    await stockSearch('乙'); await page.locator(`input[data-add-stock-code="${stockB.code}"]`).check();
    const basket = await page.locator('#review-add-stock-selected').innerText();
    assert.match(basket, /手工甲/); assert.match(basket, /手工乙/);
    await page.locator('#review-add-stock-theme').fill('农业');
    await page.locator('#review-add-stock-date').selectOption(dates[2]);
    await page.locator('#review-add-stock-submit').click();
    await page.waitForFunction(() => !reviewCollecting);
    added = (await rows()).filter(row => [stockA.code, stockB.code].includes(row.stock_code));
    assert.equal(added.length, 2);
    for (const stock of [stockA, stockB]) {
      const row = added.find(row => row.stock_code === stock.code);
      assert.equal(row.theme, '农业'); assert.equal(row.cells[dates[1]].text, stock.name);
      assert.equal(row.cells[dates[1]].kind, 'stock'); assert.equal(row.tracking.entry_date, dates[2]);
      assert.equal(row.cells[dates[2]].text, '+3.25%', 'The entry date starts filled market data');
    }
    await flush(); await page.reload(); await loaded();
    assert.equal((await rows()).filter(row => [stockA.code, stockB.code].includes(row.stock_code)).length, 2);
    const countBeforeDuplicate = (await rows()).length;
    await addStock('甲', stockA, dates[2]);
    assert.equal((await rows()).length, countBeforeDuplicate, 'Same stock, theme and date cannot accidentally be added twice');
    await close('#review-add-stocks-dialog');
    await addStock('甲', stockA, dates[3]);
    assert.equal((await rows()).length, countBeforeDuplicate + 1, 'Different dates may retain multiple review rounds');
    await addStock('甲', stockA, dates[1]);
    assert.equal((await rows()).length, countBeforeDuplicate + 2, 'Another round may start on a date occupied by a different round name cell');
    await flush();
    assert.ok(puts.length >= 5);
    assert.ok(saved.rows.filter(row => [stockA.code, stockB.code].includes(row.stock_code)).every(row => row.tracking));

    const beforeMultiTheme = await rows();
    await addStock('甲', stockA, dates[2], '金融');
    const multiTheme = await rows();
    assert.equal(multiTheme.length, beforeMultiTheme.length + 1, 'The same stock and date can coexist in another theme');
    for (const row of beforeMultiTheme) assert.deepEqual(multiTheme.find(item => item.id === row.id), row,
      'Adding another theme preserves every existing record, note and marker');
    const secondary = multiTheme.find(row => row.stock_code === stockA.code && row.theme === '金融');
    assert.ok(secondary && secondary.tracking.entry_date === dates[2]);
    assert.equal(secondary.cells[dates[1]].text, stockA.name);
    await page.locator('#review-undo').click();
    assert.deepEqual(await rows(), beforeMultiTheme, 'Undo removes only the new theme record');
    await page.locator('#review-redo').click();
    assert.deepEqual(await rows(), multiTheme);
    await flush(); await page.reload(); await loaded();
    assert.deepEqual((await rows()).filter(row => row.stock_code === stockA.code && row.tracking?.entry_date === dates[2]).map(row => row.theme).sort(), ['农业', '金融']);
    await addStock('甲', stockA, dates[2], '金融');
    assert.equal((await rows()).length, multiTheme.length);
    assert.match(await page.locator('#review-add-stock-status').innerText(), /该题材、该日期已有记录/);
    await close('#review-add-stocks-dialog');
    await select(secondary.id); await page.locator('#review-delete-row').click();
    for (const row of beforeMultiTheme) assert.deepEqual((await rows()).find(item => item.id === row.id), row,
      'Deleting one theme record preserves the same stock in its other theme');
    await page.locator('#review-undo').click();
    assert.deepEqual(await rows(), multiTheme);
    const beforeTracked = (await rows()).find(row => row.id === 'a1');
    await addStock('600001', trackedStock, dates[1], '科技');
    const afterTracked = await rows();
    assert.deepEqual(afterTracked.find(row => row.id === 'a1'), beforeTracked, 'A manual secondary theme must not alter the automatic primary record');
    const trackedSecondary = afterTracked.find(row => row.stock_code === trackedStock.code && row.theme === '科技');
    assert.ok(trackedSecondary && trackedSecondary.tracking.entry_date === dates[1]);
    await addStock('600001', trackedStock, dates[1], '农业');
    assert.deepEqual(await rows(), afterTracked, 'An existing automatic row also prevents duplicates inside its own theme');
    await close('#review-add-stocks-dialog');
    await flush(); await page.reload(); await loaded();
    assert.deepEqual((await rows()).find(row => row.id === trackedSecondary.id), trackedSecondary);

    const beforeSources = await rows(), sourceDates = await page.evaluate(() => [...reviewSheet.dates]);
    await page.locator('#review-add-stocks').click();
    await page.locator('#review-add-category').selectOption('1');
    assert.equal(await page.locator('#review-add-stock-results input').count(), 1);
    await page.locator(`[data-add-stock-code="${stockA.code}"]`).check();
    await page.locator('[data-review-source="ladder"]').click();
    await page.locator(`[data-add-stock-code="${stockB.code}"]`).check();
    await page.locator('#review-add-ladder-date').selectOption(dates[2]);
    await page.locator(`[data-add-stock-code="${stockB.code}"]:checked`).waitFor();
    assert.match(await page.locator('#review-add-stock-selected').innerText(), /手工甲/);
    assert.match(await page.locator('#review-add-stock-results').innerText(), /3板/);
    await page.locator('#review-add-stock-theme').fill('来源测试');
    await page.locator('#review-add-stock-date').selectOption(dates[2]);
    failPrepare = true;
    await page.screenshot({path: '.probe/review-add-sources-desktop.png'});
    await page.locator('#review-add-stock-submit').click();
    await page.waitForFunction(() => !reviewCollecting);
    assert.deepEqual(await rows(), beforeSources, 'Failed preparation does not change rows or date columns');
    assert.deepEqual(await page.evaluate(() => reviewSheet.dates), sourceDates);
    assert.match(await page.locator('#review-add-stock-status').innerText(), /补齐暂时失败/);
    failPrepare = false;
    await page.locator('#review-add-stock-submit').click();
    await page.locator('#review-add-stocks-dialog').waitFor({state: 'hidden'});
    assert.equal((await rows()).filter(row => row.theme === '来源测试').length, 2, 'Watchlist and ladder selections are added together');
    await page.locator('#review-undo').click();
    assert.deepEqual(await rows(), beforeSources, 'One undo removes the whole prepared batch');
    await addStock('乙', stockB, sourceDates[0], '扩展日期测试');
    const extendedDates = await page.evaluate(() => reviewSheet.dates);
    assert.ok(priorDays(sourceDates[0]).every(day => extendedDates.includes(day)), 'Entry labels automatically add earlier date columns');
    await page.locator('#review-undo').click();
    assert.deepEqual(await rows(), beforeSources);
    assert.deepEqual(await page.evaluate(() => reviewSheet.dates), sourceDates, 'Undo also restores the date columns before backfilling');

    await select('a1');
    const beforeCopy = await rows(), source = beforeCopy.find(row => row.id === 'a1');
    await page.locator('#review-duplicate-row').click();
    const wholeCopy = (await rows()).find(row => !beforeCopy.some(old => old.id === row.id));
    assert.deepEqual({...wholeCopy, id: source.id}, {...source, stock_code: source.tracking.code}, 'Whole-row copy preserves hidden dates, tracking, notes and markers');
    await page.locator('#review-theme-edit').click(); await page.locator('#review-theme-value').fill('复制题材');
    await page.getByRole('button', {name: '保存并归组'}).click();
    assert.deepEqual((await rows()).find(row => row.id === 'a1'), source, 'Editing the copy does not alter its source');
    const copyName = page.locator(`.review-cell[data-r="${await index(wholeCopy.id)}"][data-c="${await page.evaluate(day => reviewDays.indexOf(day), dates[1])}"]`);
    await copyName.dblclick(); await copyName.fill('另一个股票'); await copyName.press('Enter');
    const renamed = (await rows()).find(row => row.id === wholeCopy.id);
    assert.equal(renamed.stock_code, undefined);
    assert.equal(renamed.tracking, undefined, 'Renaming a manual copy must not keep tracking the original stock');
    assert.deepEqual((await rows()).find(row => row.id === 'a1'), source);
    await select('a1');
    await page.locator(`.review-cell[data-r="${await index('a1')}"]`).first().click({button: 'right'});
    await page.getByRole('menuitem', {name: '复制整行', exact: true}).click();
    assert.equal((await rows()).length, beforeCopy.length + 2, 'Context menu also duplicates the selected whole row');
    await page.locator('#review-undo').click(); await flush(); await page.reload(); await loaded();
    assert.equal((await rows()).find(row => row.id === wholeCopy.id).theme, '复制题材');

    fs.mkdirSync('.probe', {recursive: true});
    await page.screenshot({path: '.probe/review-manual.png', fullPage: true});
    await page.setViewportSize({width: 390, height: 650});
    await page.locator('#review-add-stocks').click();
    const stockDialog = await page.locator('#review-add-stocks-dialog').boundingBox();
    assert.ok(stockDialog.x >= 0 && stockDialog.x + stockDialog.width <= 391 && stockDialog.height <= 650);
    await page.screenshot({path: '.probe/review-add-sources-mobile.png'});
    await close('#review-add-stocks-dialog');
    await page.locator('#review-add-row').click();
    const rowDialog = await page.locator('#review-new-rows-dialog').boundingBox();
    assert.ok(rowDialog.x >= 0 && rowDialog.x + rowDialog.width <= 391 && rowDialog.height <= 650);
    await page.screenshot({path: '.probe/review-manual-mobile.png'});
    await close('#review-new-rows-dialog');
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    console.log('Manual review browser checks passed: bulk actions, insertion/undo, multi-search additions, multiple themes per stock, theme-scoped duplicate checks, preservation of primary records, persistence and narrow dialogs.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
