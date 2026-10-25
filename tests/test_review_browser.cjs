// 全部接口与页面均在浏览器内拦截, 不读写用户的实际复盘表。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const clone = value => JSON.parse(JSON.stringify(value));

(async () => {
  const browser = await chromium.launch({channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 1050}});
    const errors = [], unexpected = [];
    const dates = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'];
    let saved = {revision: 0, dates, hidden_dates: [], rows: Array.from({length: 12}, (_, i) => ({id: `row-${i}`, cells: {}}))};
    let failSave = false, failLoad = false, heldSave = null;
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      if (path === '/review') return route.fulfill({contentType: 'text/html', body: fs.readFileSync('web/review.html', 'utf8')});
      if (path.startsWith('/static/')) {
        const file = path.split('/').at(-1);
        if (fs.existsSync(`web/${file}`)) return route.fulfill({contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(`web/${file}`, 'utf8')});
      }
      if (path === '/api/review-sheet' && request.method() === 'GET') return route.fulfill(failLoad ? {status: 500, json: {error: {message: '读取暂时失败'}}} : {json: clone(saved)});
      if (path === '/api/review-sheet' && request.method() === 'PUT') {
        const payload = request.postDataJSON();
        if (heldSave) { const hold = heldSave; heldSave = null; await hold; }
        if (failSave) return route.fulfill({status: 500, json: {error: {message: '保存暂时失败'}}});
        if (payload.revision !== saved.revision) return route.fulfill({status: 409, json: {error: {code: 'review_conflict', message: '其他页面已更新'}}});
        saved = {...payload, revision: saved.revision + 1};
        return route.fulfill({json: clone(saved)});
      }
      if (path === '/api/review-sheet/dates') {
        const start = url.searchParams.get('start'), end = url.searchParams.get('end');
        const choices = [...dates, '2026-11-02', '2026-11-03'].filter(day => day >= start && day <= end);
        return route.fulfill({json: {dates: choices, provisional: false}});
      }
      unexpected.push(path); return route.abort();
    });
    const cell = (r, c) => page.locator(`.review-cell[data-r="${r}"][data-c="${c}"]`);
    const edit = async (r, c, text) => {
      await cell(r, c).dblclick();
      await cell(r, c).fill(text);
      await cell(r, c).press('Enter');
      await cell(r, c).click();
    };
    const flush = async () => {
      await page.locator('#review-save').click();
      await page.waitForFunction(() => !reviewDirty && !reviewSaving);
    };
    const paste = async text => page.evaluate(text => {
      const data = new DataTransfer(); data.setData('text/plain', text);
      const target = document.activeElement?.matches('.review-cell') ? document.activeElement : document.querySelector('td.is-active .review-cell');
      target.dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true}));
    }, text);

    await page.goto('http://localhost/review');
    await page.waitForFunction(() => reviewLoaded);
    assert.ok((await page.locator('.page-header').boundingBox()).height < 65, 'The title uses a compact single line');
    assert.ok((await page.locator('#review-controls').boundingBox()).height < 160, 'The editing tools use a compact desktop layout');
    assert.deepEqual(await page.evaluate(() => reviewDays), dates, 'Date columns stay in ascending order');
    assert.equal(await page.evaluate(() => reviewAnchor.c), dates.length - 1, 'The latest date is selected on opening');
    const initialScroll = await page.locator('#review-scroll').evaluate(node => ({
      left: node.scrollLeft, max: node.scrollWidth - node.clientWidth,
      lastRight: node.querySelector('.review-day:last-child').getBoundingClientRect().right,
      right: node.getBoundingClientRect().right,
    }));
    assert.ok(initialScroll.max > 0 && Math.abs(initialScroll.left - initialScroll.max) <= 1,
      'The opening viewport starts at the newest date on the right');
    assert.ok(initialScroll.lastRight <= initialScroll.right + 1, 'The newest column is fully visible');
    const pageLayout = await page.locator('#review-scroll').evaluate(node => ({
      height: node.clientHeight, contentHeight: node.scrollHeight,
      width: node.getBoundingClientRect().width,
      pageWidth: document.querySelector('.app-main').clientWidth,
    }));
    assert.ok(pageLayout.contentHeight <= pageLayout.height + 1, 'All rows expand into the page instead of a bounded vertical scroller');
    assert.equal(pageLayout.width, pageLayout.pageWidth, 'The sheet uses the full page content width');
    await page.setViewportSize({width: 1600, height: 650});
    await cell(11, 0).scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => scrollY > 0), 'Reaching lower rows scrolls the page');
    assert.equal(await page.locator('#review-scroll').evaluate(node => node.scrollTop), 0);
    assert.ok(Math.abs((await page.locator('#review-controls').boundingBox()).y) <= 1,
      'Date, formatting and editing tools stay pinned after the page scrolls');
    await page.locator('#review-sticky-head').waitFor({state: 'visible'});
    const assertHeaderAlignment = async () => {
      await page.waitForFunction(() => {
        const floating = document.querySelector('#review-sticky-head');
        const source = document.querySelector('#review-grid');
        const tools = document.querySelector('#review-controls').getBoundingClientRect();
        return !floating.hidden && Math.abs(floating.getBoundingClientRect().top - tools.bottom) < 1 &&
          [...source.querySelectorAll('.review-day')].every((head, index) => {
            const copy = floating.querySelectorAll('.review-day')[index];
            if (!copy) return false;
            const actual = head.getBoundingClientRect(), preview = copy.getBoundingClientRect();
            return Math.abs(actual.left - preview.left) < 1 && Math.abs(actual.width - preview.width) < 1;
          });
      });
    };
    await assertHeaderAlignment();
    await page.locator('#review-sticky-head [data-sticky-column="2"]').click();
    assert.equal(await page.locator('#review-grid td.is-selected').count(), 12,
      'Clicking a floating date selects its original column');
    assert.equal(await page.locator('#review-sticky-head button').first().getAttribute('tabindex'), '-1',
      'The visual date header does not create duplicate keyboard stops');
    await page.screenshot({path: '.probe/review-compact-pinned.png'});
    await page.setViewportSize({width: 1100, height: 650});
    for (const zoom of ['0.75', '1', '1.25', '1.5']) {
      await page.locator('#review-zoom').selectOption(zoom);
      await page.locator('#review-scroll').evaluate(node => { node.scrollLeft = node.scrollWidth; });
      await assertHeaderAlignment();
      await page.locator('#review-scroll').evaluate(node => { node.scrollLeft = 0; });
      await assertHeaderAlignment();
    }
    await page.locator('#review-zoom').selectOption('1');
    await page.setViewportSize({width: 1600, height: 650});
    for (const id of ['review-range', 'review-bold', 'review-text', 'review-hide-date', 'review-zoom']) {
      assert.equal(await page.locator('#' + id).evaluate(node => !!node.closest('#review-controls')), true,
        `${id} stays in the pinned tools`);
    }
    await cell(11, 0).click();
    await page.locator('#review-bold').click();
    assert.equal(await cell(11, 0).evaluate(node => getComputedStyle(node).fontWeight), '700',
      'Pinned formatting controls operate on a lower row without scrolling back');
    await page.locator('#review-undo').click();
    await page.setViewportSize({width: 1600, height: 1050});
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForFunction(() => document.querySelector('#review-sticky-head').hidden);
    assert.equal(await cell(0, 0).innerText(), '');
    await edit(0, 0, '<img src=x onerror=alert(1)>');
    await flush();
    await page.reload();
    await page.waitForFunction(() => reviewLoaded);
    assert.equal(await cell(0, 0).innerText(), '<img src=x onerror=alert(1)>');
    assert.equal(await page.locator('#review-grid img').count(), 0);
    assert.equal(await page.locator('#review-preset, input[type="color"]').count(), 0,
      'Purpose-specific buttons replace the broad style list and arbitrary color pickers');
    await edit(0, 0, '农业');
    await page.locator('[data-review-kind="theme"]').click();
    assert.equal(await page.evaluate(() => reviewCell(0, 0).kind), 'theme');
    await edit(1, 0, '农业');
    await page.locator('[data-review-kind="theme"]').click();
    await edit(1, 1, '股票A');
    await page.locator('[data-review-kind="stock"]').click();
    assert.equal(await page.evaluate(() => reviewCell(1, 1).kind), 'stock');
    await edit(1, 2, '2板缩量');
    await edit(1, 3, '3板放量');
    await cell(1, 2).click();
    await cell(1, 3).click({modifiers: ['Shift']});
    await page.locator('[data-review-fill="up"]').click();
    assert.equal(await page.locator('#review-grid td.is-selected').count(), 2);
    assert.equal(await cell(1, 2).evaluate(node => getComputedStyle(node.parentElement).backgroundColor), 'rgb(220, 38, 38)');
    const normalColor = await cell(1, 3).evaluate(node => getComputedStyle(node).color);
    const baseCells = await page.evaluate(() => JSON.stringify([reviewCell(1, 2), reviewCell(1, 3)]));
    await page.locator('#review-yellow').click();
    assert.equal(await page.evaluate(() => reviewCell(1, 2).highlight && reviewCell(1, 3).highlight), true);
    assert.equal(await cell(1, 3).evaluate(node => getComputedStyle(node).color), 'rgb(255, 241, 118)');
    await page.locator('#review-undo').click();
    assert.equal(await page.evaluate(() => JSON.stringify([reviewCell(1, 2), reviewCell(1, 3)])), baseCells);
    assert.equal(await cell(1, 3).evaluate(node => getComputedStyle(node).color), normalColor);
    await page.locator('#review-redo').click();
    assert.equal(await cell(1, 3).evaluate(node => getComputedStyle(node).color), 'rgb(255, 241, 118)');
    await cell(1, 2).click();
    await cell(1, 3).click({modifiers: ['Shift']});
    await page.locator('#review-yellow').click();
    assert.equal(await cell(1, 3).evaluate(node => getComputedStyle(node).color), normalColor,
      'Removing yellow text restores the original text color');
    assert.equal(await cell(1, 3).evaluate(node => getComputedStyle(node.parentElement).backgroundColor), 'rgb(220, 38, 38)');
    await page.locator('#review-yellow').click();
    await flush();
    await page.reload(); await page.waitForFunction(() => reviewLoaded);
    assert.equal(await cell(1, 2).innerText(), '2板缩量');
    assert.equal(await cell(1, 3).evaluate(node => getComputedStyle(node.parentElement).backgroundColor), 'rgb(220, 38, 38)');
    assert.equal(await cell(1, 3).evaluate(node => getComputedStyle(node).color), 'rgb(255, 241, 118)');

    await edit(2, 2, '2板');
    await cell(2, 2).press('F2');
    await cell(2, 2).press('End');
    await paste('缩量');
    await cell(2, 2).press('Enter');
    assert.equal(await cell(2, 2).innerText(), '2板缩量', 'Pasting a description inside an edit preserves existing text');
    await flush();
    const beforeCancel = await page.evaluate(() => reviewBody());
    await cell(2, 2).dblclick();
    await cell(2, 2).fill('不应保存的临时内容');
    await cell(2, 2).press('Escape');
    assert.equal(await cell(2, 2).innerText(), '2板缩量');
    assert.equal(await page.evaluate(() => reviewBody()), beforeCancel, 'Esc cancels the pending edit without changing saved content');
    await cell(2, 2).click();
    await cell(2, 2).press('5');
    await cell(2, 2).press('Enter');
    assert.equal(await cell(2, 2).innerText(), '5', 'Typing on a selected cell starts a replacement edit');
    await page.locator('#review-undo').click();
    assert.equal(await cell(2, 2).innerText(), '2板缩量');
    await cell(2, 2).click();
    await cell(2, 2).press('Delete');
    assert.equal(await cell(2, 2).innerText(), '', 'Delete clears a selected single cell just like a selected range');
    await page.locator('#review-undo').click();
    assert.equal(await cell(2, 2).innerText(), '2板缩量');
    await cell(2, 2).click();
    await cell(2, 2).press('ArrowRight');
    assert.equal(await cell(2, 3).evaluate(node => document.activeElement === node), true, 'Arrow keys navigate selected cells');
    await cell(2, 3).press('Shift+ArrowDown');
    assert.equal(await page.locator('#review-grid td.is-selected').count(), 2, 'Shift+arrow extends the cell range');
    await page.locator('#review-scroll').evaluate(node => { node.scrollLeft = 0; });
    const dragStart = await cell(2, 2).boundingBox(), dragEnd = await cell(3, 4).boundingBox();
    await page.mouse.move(dragStart.x + dragStart.width / 2, dragStart.y + dragStart.height / 2);
    await page.mouse.down();
    await page.mouse.move(dragEnd.x + dragEnd.width / 2, dragEnd.y + dragEnd.height / 2, {steps: 8});
    await page.mouse.up();
    assert.equal(await page.locator('#review-grid td.is-selected').count(), 6, 'Dragging selects a rectangular cell range');
    await cell(2, 2).click({button: 'right'});
    await page.locator('#review-cell-menu').waitFor({state: 'visible'});
    await page.locator('#review-cell-menu [data-review-action="edit"]').click();
    assert.equal(await cell(2, 2).getAttribute('contenteditable'), 'plaintext-only');
    await cell(2, 2).press('Escape');
    assert.equal(await page.locator('#review-cell-menu').isVisible(), false);

    await cell(3, 2).click();
    await paste('金融\t股票B\t"2板\n放量"\r\n消费\t"股票""C"\t3板\r\n');
    assert.equal(await cell(3, 4).innerText(), '2板\n放量');
    assert.equal(await cell(4, 3).innerText(), '股票"C');
    assert.equal(await page.locator('#review-grid td.is-selected').count(), 6);
    const copied = await page.evaluate(() => {
      window.getSelection().removeAllRanges();
      const data = new DataTransfer();
      document.querySelector('#review-grid').dispatchEvent(new ClipboardEvent('copy', {clipboardData: data, bubbles: true, cancelable: true}));
      return data.getData('text/plain');
    });
    assert.equal(copied, '金融\t股票B\t"2板\n放量"\r\n消费\t"股票""C"\t3板');
    await page.locator('#review-clear').click();
    assert.equal(await cell(3, 2).innerText(), '');
    await page.locator('#review-undo').click();
    assert.equal(await cell(3, 2).innerText(), '金融');

    await cell(1, 2).click();
    await page.locator('#review-text').fill('二板，等待确认');
    await page.locator('#review-text').press('Enter');
    assert.equal(await cell(1, 2).innerText(), '二板，等待确认');
    assert.equal(await cell(2, 2).evaluate(node => document.activeElement === node), true);
    await cell(2, 2).press('Tab');
    assert.equal(await cell(2, 3).evaluate(node => document.activeElement === node), true);
    await page.locator('#review-insert-row').click();
    assert.equal(await page.locator('#review-grid tbody tr').count(), 13);
    assert.equal(await page.evaluate(() => reviewAnchor.c), 3, 'Editing and inserting rows does not jump to the newest date');
    await page.locator('#review-undo').click();
    assert.equal(await page.locator('#review-grid tbody tr').count(), 12);
    await page.locator('[data-row="3"]').click();
    await page.locator('#review-delete-row').click();
    assert.equal(await page.locator('#review-grid tbody tr').count(), 11);
    await page.locator('#review-undo').click();
    assert.equal(await cell(3, 2).innerText(), '金融');

    const beforeLeader = await page.evaluate(() => JSON.stringify(reviewSheet.rows[1].cells));
    await page.locator('[data-column="2"]').click();
    await page.locator('#review-hide-date').click();
    assert.equal(await page.locator('#review-grid .review-day').count(), 9);
    await cell(1, 2).click();
    await page.locator('#review-leader').click();
    assert.equal(await page.evaluate(() => reviewSheet.rows[1].leader), true);
    assert.equal(await page.evaluate(() => JSON.stringify(reviewSheet.rows[1].cells)), beforeLeader,
      'A leader is a row marker, not a destructive repaint of individual cells');
    assert.equal(await cell(1, 2).evaluate(node => getComputedStyle(node.parentElement).backgroundColor), 'rgb(126, 34, 168)');
    await page.locator('#review-restore-dates').click();
    assert.equal(await cell(1, 2).innerText(), '二板，等待确认');
    assert.equal(await cell(1, 2).evaluate(node => getComputedStyle(node.parentElement).backgroundColor), 'rgb(126, 34, 168)',
      'Dates that were hidden when the leader was marked receive the same row color');
    await flush();
    await page.reload(); await page.waitForFunction(() => reviewLoaded);
    assert.equal(await page.evaluate(() => reviewSheet.rows[1].leader), true, 'The leader marker survives reload');
    await page.locator('#review-start').fill('2026-10-26');
    await page.locator('#review-end').fill('2026-11-03');
    await page.locator('#review-range button[type=submit]').click();
    await page.waitForFunction(() => reviewDays.at(-1) === '2026-11-03');
    assert.equal(await page.evaluate(() => reviewAnchor.c), 6, 'Changing the date range selects its latest visible date');
    await page.locator('#review-show-all').click();
    assert.equal(await page.evaluate(() => reviewAnchor.c), 11, 'All dates starts at the latest date');
    assert.equal(await page.locator('#review-scroll').evaluate(node =>
      Math.abs(node.scrollWidth - node.clientWidth - node.scrollLeft) <= 1), true);
    assert.equal(await cell(1, 2).innerText(), '二板，等待确认', 'Date changes must retain offscreen data');
    assert.equal(await cell(1, 11).evaluate(node => getComputedStyle(node.parentElement).backgroundColor), 'rgb(126, 34, 168)',
      'New date columns inherit the existing leader row marker');
    await cell(1, 11).click();
    await page.locator('#review-leader').click();
    assert.equal(await page.evaluate(() => !!reviewSheet.rows[1].leader), false);
    assert.equal(await page.evaluate(() => JSON.stringify(reviewSheet.rows[1].cells)), beforeLeader);
    assert.equal(await cell(1, 2).evaluate(node => getComputedStyle(node.parentElement).backgroundColor), 'rgb(220, 38, 38)',
      'Removing the leader restores the original fill');
    assert.equal(await cell(1, 3).evaluate(node => getComputedStyle(node).color), 'rgb(255, 241, 118)',
      'Removing the leader preserves manually highlighted text');
    const rowsBeforeMove = await page.evaluate(() => JSON.stringify(reviewSheet.rows));
    const movedRow = await page.evaluate(() => JSON.stringify(reviewSheet.rows[1]));
    await cell(1, 11).click();
    await page.locator('#review-row-down').click();
    assert.equal(await page.evaluate(() => JSON.stringify(reviewSheet.rows[2])), movedRow,
      'Moving a stock keeps its row identity, older dates, cell colors and manual markers');
    assert.equal(await page.evaluate(() => reviewAnchor.r), 2);
    await page.locator('#review-row-up').click();
    assert.equal(await page.evaluate(() => JSON.stringify(reviewSheet.rows)), rowsBeforeMove);
    const beforePaste = await page.evaluate(() => reviewBody());
    await cell(0, 11).click(); await paste('超出\t范围');
    assert.equal(await page.evaluate(() => reviewBody()), beforePaste, 'Oversized paste must not partially modify data');
    await flush();

    failSave = true;
    await edit(5, 1, '断网时的记录');
    await page.locator('#review-save').click();
    await page.waitForFunction(() => !reviewSaving && document.querySelector('#review-status').dataset.state === 'error');
    assert.equal(await cell(5, 1).innerText(), '断网时的记录');
    assert.ok(await page.evaluate(() => localStorage.getItem(reviewDraftKey)));
    failSave = false;
    await page.reload(); await page.waitForFunction(() => reviewLoaded);
    assert.equal(await cell(5, 1).innerText(), '断网时的记录', 'Unsaved draft must survive refresh');
    await flush();

    let release;
    heldSave = new Promise(resolve => { release = resolve; });
    await edit(6, 1, '保存中的第一笔');
    await page.locator('#review-save').click();
    await page.waitForFunction(() => reviewSaving);
    await edit(6, 2, '保存期间继续写');
    release();
    await page.waitForFunction(() => !reviewDirty && !reviewSaving);
    assert.equal(saved.rows[6].cells[dates[2]].text, '保存期间继续写');

    saved.revision++;
    await edit(7, 1, '另一页面更新后仍保留');
    await page.locator('#review-save').click();
    await page.waitForFunction(() => reviewConflict);
    assert.equal(saved.rows[7].cells[dates[1]], undefined, 'Stale page must not overwrite newer saved data');
    assert.equal(await cell(7, 1).innerText(), '另一页面更新后仍保留');
    const downloadEvent = page.waitForEvent('download');
    await page.locator('#review-export').click();
    assert.match((await downloadEvent).suggestedFilename(), /^复盘表-.*\.json$/);
    await page.locator('#review-reload').click();
    await page.waitForFunction(() => !reviewConflict && !reviewDirty);
    assert.equal(await cell(7, 1).innerText(), '');

    const scroll = page.locator('#review-scroll');
    await scroll.evaluate(node => { node.scrollLeft = node.scrollWidth; });
    const sticky = await cell(0, 0).evaluate(node => getComputedStyle(node.parentElement).position);
    assert.notEqual(sticky, 'sticky', 'Theme cells must scroll with their date columns');
    const rowIdentity = page.locator('#review-grid [data-row="1"]');
    assert.match(await rowIdentity.innerText(), /股票A/);
    assert.match(await rowIdentity.innerText(), /农业/);
    const fixedRow = await rowIdentity.boundingBox(), visibleGrid = await scroll.boundingBox();
    assert.ok(fixedRow.x >= visibleGrid.x - 1 && fixedRow.x + fixedRow.width <= visibleGrid.x + visibleGrid.width,
      'Stock and theme identity stay visible while editing the latest dates on the right');
    await cell(1, 11).click();
    assert.match(await page.locator('#review-address').innerText(), /股票A/,
      'The active cell address identifies the stock, not only its row number');
    await scroll.evaluate(node => { node.scrollLeft = 0; node.scrollTop = 0; });
    await page.locator('#review-zoom').selectOption('0.75');
    assert.equal(await cell(0, 0).evaluate(node => node.getBoundingClientRect().width), 87);
    await page.locator('#review-zoom').selectOption('1');
    await page.setViewportSize({width: 1600, height: 650});
    await page.locator('#review-fullscreen').click();
    await page.waitForFunction(() => !!document.fullscreenElement);
    assert.equal(await page.locator('#review-sticky-head').isVisible(), false,
      'Fullscreen uses the original sticky date header');
    assert.equal(await scroll.evaluate(node => node.scrollHeight > node.clientHeight), true,
      'Fullscreen keeps all rows reachable within its viewport');
    await page.locator('#review-fullscreen').click();
    await page.waitForFunction(() => !document.fullscreenElement);
    assert.equal(await scroll.evaluate(node => node.scrollHeight <= node.clientHeight + 1), true,
      'Exiting fullscreen returns to page scrolling');
    await page.setViewportSize({width: 1600, height: 1050});
    if (process.env.FINDSTOCK_REVIEW_SCREENSHOT) await page.screenshot({path: process.env.FINDSTOCK_REVIEW_SCREENSHOT, fullPage: true});
    await page.setViewportSize({width: 390, height: 650});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'The table must scroll inside its container on narrow screens');
    assert.equal(await scroll.evaluate(node => node.scrollHeight <= node.clientHeight + 1), true, 'Mobile rows also use page scrolling');
    await cell(11, 0).scrollIntoViewIfNeeded();
    const mobileTools = await page.locator('#review-controls').boundingBox();
    assert.ok(Math.abs(mobileTools.y) <= 1 && mobileTools.height <= 325,
      `Mobile tools stay at the top while leaving room for the sheet: ${JSON.stringify(mobileTools)}`);
    await assertHeaderAlignment();
    failLoad = true;
    await page.reload();
    await page.getByText(/无法读取复盘表/).waitFor();
    assert.equal(await page.locator('#review-save').isDisabled(), true);
    assert.equal(await page.locator('.review-cell').count(), 0, 'Read failure must not expose a writable empty replacement');
    failLoad = false;
    saved = {revision: 0, dates: [], hidden_dates: [], rows: []};
    await page.locator('#review-reload').click();
    await page.waitForFunction(() => reviewLoaded && !reviewDirty && !reviewSaving);
    assert.equal(await page.locator('#review-grid tbody tr').count(), 12, 'First use must offer blank editable rows');
    assert.ok(saved.dates.length > 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    console.log('Review browser checks passed: selection/edit modes, inline paste, cancel, keyboard/drag ranges, context menu, fixed identity, reversible leader/yellow markers, intact row movement, Excel paste/copy, undo/redo, persistence, draft recovery, conflicts, export, zoom and responsive layout.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
