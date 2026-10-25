// PLAYWRIGHT_MODULE 可指向已有运行时；全部数据与写入均拦截，使用真实鼠标操作检查拖动。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1200}});
    const errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    const categories = [{id: 1, name: '突破观察'}, {id: 2, name: '等待回踩'}];
    let items = Array.from({length: 18}, (_, index) => ({
      code: `sz.${String(index + 1).padStart(6, '0')}`, name: `观察股票${index + 1}`,
      categories: [categories[index % 2]], note: '', note_highlights: [],
      board_label: '沪深主板', latest_date: '2026-10-21', latest_close: 10, latest_pct_chg: 1,
    }));
    let failOrder = false, releaseOrder = null, orderGate = null;
    await page.route('**/*', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path === '/watchlist') return route.fulfill({contentType: 'text/html', body: fs.readFileSync('web/watchlist.html', 'utf8')});
      if (path === '/static/chart.js') return route.fulfill({contentType: 'text/javascript', body:
        'window.chartOpens = 0; function openStockChart() { window.chartOpens++; }'});
      if (path === '/static/watchlist-charts.js') return route.fulfill({contentType: 'text/javascript', body:
        'function observeWatchCharts() {} function clearWatchCharts() {}'});
      if (path.startsWith('/static/')) {
        const file = path.split('/').at(-1);
        if (fs.existsSync(`web/${file}`)) return route.fulfill({
          contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(`web/${file}`, 'utf8')});
      }
      if (path === '/api/watchlist' && request.method() === 'GET') return route.fulfill({json: {
        items, categories: categories.map(category => ({...category,
          count: items.filter(item => item.categories.some(value => value.id === category.id)).length})),
      }});
      if (path === '/api/watchlist/order' && request.method() === 'PUT') {
        const {codes} = request.postDataJSON();
        writes.push(codes);
        assert.deepEqual([...codes].sort(), items.map(item => item.code).sort());
        if (orderGate) await orderGate;
        if (failOrder) return route.fulfill({status: 502, json: {error: {message: '测试排序失败'}}});
        items = codes.map(code => items.find(item => item.code === code));
        return route.fulfill({json: {codes}});
      }
      return route.abort();
    });
    const shown = () => page.locator('.watch-card').evaluateAll(nodes => nodes.map(node => node.dataset.code));
    const saved = () => items.map(item => item.code);
    const card = code => page.locator(`.watch-card[data-code="${code}"]`);
    const waitWrites = async count => {
      for (let step = 0; step < 120 && writes.length < count; step++) await page.waitForTimeout(25);
      assert.equal(writes.length, count);
      await page.waitForFunction(() => document.querySelector('#watchlist-summary').textContent.includes('顺序已保存'));
    };
    const startDrag = async code => {
      const handle = card(code).locator('[data-action="drag"]');
      await handle.scrollIntoViewIfNeeded();
      const box = await handle.boundingBox();
      const scale = await handle.evaluate(node => Number(getComputedStyle(node.closest('.watchlist-list')).zoom) || 1);
      assert.ok(box.width >= 70 * scale && box.height >= 44 * scale - .1, 'The drag handle scales with its stock card');
      assert.equal(await handle.evaluate(node => {
        const box = node.getBoundingClientRect();
        return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      }), true, 'The sorting handle must receive pointer events rather than be covered by note controls');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      return {x: box.x + box.width / 2, y: box.y + box.height / 2};
    };
    const dropOn = async (target, after) => {
      const box = await card(target).boundingBox();
      const x = box.x + box.width / 3, y = box.y + box.height * (after ? .85 : .15);
      await page.mouse.move(x, y, {steps: 15});
      await page.waitForFunction(({code, after}) => document.querySelector(`.watch-card[data-code="${code}"]`)
        .classList.contains(after ? 'is-drop-after' : 'is-drop-before'), {code: target, after});
      const sourceColor = await page.locator('.watch-card.is-dragging').evaluate(node => getComputedStyle(node).backgroundColor);
      const targetColor = await card(target).evaluate(node => getComputedStyle(node).backgroundColor);
      assert.notEqual(sourceColor, 'rgb(255, 255, 255)', 'The moving stock changes color');
      assert.notEqual(targetColor, 'rgb(255, 255, 255)', 'The drop target changes color');
      assert.notEqual(sourceColor, targetColor, 'Moving stock and destination have distinct colors');
      assert.ok((await card(target).evaluate(node => getComputedStyle(node, '::after').content))
        .includes(after ? '后面' : '前面'), 'The preview labels the exact insertion side');
      assert.ok((await page.locator('#watchlist-summary').innerText()).includes(after ? '后面' : '前面'));
      if (!writes.length) await page.screenshot({path: '.probe/watchlist-drag-preview.png'});
      await page.mouse.up();
    };

    await page.goto('http://findstock.test/watchlist');
    await page.locator('.watch-card').first().waitFor();
    await page.locator('[data-category="1"]').click();
    const before = await shown(), original = saved();
    const hidden = original.map((code, index) => ({code, index})).filter(({code}) => !before.includes(code));

    // 普通点击和微小抖动不能触发保存。
    const start = await startDrag(before[0]);
    await page.mouse.move(start.x + 3, start.y + 2);
    await page.mouse.up();
    assert.equal(writes.length, 0);
    assert.equal(await page.locator('.is-dragging').count(), 0);

    // 从可见排序柄直接拖动到第三张卡片上方。
    await startDrag(before[0]);
    await dropOn(before[2], false);
    await waitWrites(1);
    assert.deepEqual(await shown(), [before[1], before[0], ...before.slice(2)]);
    hidden.forEach(({code, index}) => assert.equal(items[index].code, code, 'Hidden slots must stay in place'));
    assert.equal(await page.evaluate(() => window.chartOpens), 0);
    const persisted = saved();
    await page.reload();
    await page.locator('.watch-card').first().waitFor();
    assert.deepEqual(await shown(), persisted, 'Order survives reload');
    await page.locator('[data-category="1"]').click();

    // 拖动到下半部必须插入目标之后，而不是之前。
    let visible = await shown();
    await startDrag(visible[0]);
    await dropOn(visible[1], true);
    await waitWrites(2);
    assert.deepEqual(await shown(), [visible[1], visible[0], ...visible.slice(2)]);

    // Esc 取消拖动且清除视觉提示。
    visible = await shown();
    const cancelStart = await startDrag(visible[0]);
    await page.mouse.move(cancelStart.x - 30, cancelStart.y - 10, {steps: 5});
    await page.keyboard.press('Escape');
    await page.mouse.up();
    assert.equal(writes.length, 2);
    assert.deepEqual(await shown(), visible);
    assert.equal(await page.locator('.is-dragging, .is-drop-before, .is-drop-after').count(), 0);
    assert.equal(await page.locator('.is-order-dragging').count(), 0);

    // 双列卡片之间的空隙也可作为落点；离开列表后移除提示，取消不改变顺序。
    await startDrag(visible[0]);
    const gapTarget = await card(visible[2]).boundingBox();
    await page.mouse.move(gapTarget.x + gapTarget.width / 2, gapTarget.y - 4, {steps: 12});
    await page.waitForFunction(code => document.querySelector(`.watch-card[data-code="${code}"]`)
      .classList.contains('is-drop-before'), visible[2]);
    await page.mouse.move(20, 100, {steps: 5});
    assert.equal(await page.locator('.is-drop-before, .is-drop-after').count(), 0);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    assert.equal(writes.length, 2);
    assert.deepEqual(await shown(), visible);
    assert.equal(await page.locator('.is-order-dragging').count(), 0);

    // 保存中有状态提示与禁用保护；失败恢复顺序，再次点击可成功。
    const beforeFailure = saved();
    failOrder = true;
    orderGate = new Promise(resolve => { releaseOrder = resolve; });
    await card(visible[0]).locator('[data-action="move-down"]').click();
    await page.waitForFunction(() => document.querySelector('#watchlist-summary').textContent.includes('正在保存顺序'));
    assert.equal(await card(visible[0]).locator('[data-action="drag"]').isDisabled(), true);
    releaseOrder(); orderGate = null;
    await page.getByText(/测试排序失败/).first().waitFor();
    assert.deepEqual(await shown(), visible);
    assert.deepEqual(saved(), beforeFailure);
    assert.match(await page.locator('#watchlist-summary').innerText(), /排序未保存/);
    failOrder = false;
    await card(visible[0]).locator('[data-action="move-down"]').click();
    await waitWrites(4);
    assert.deepEqual(await shown(), [visible[1], visible[0], ...visible.slice(2)]);

    // 长列表拖到屏幕边缘会滚动，取消后不保存；视口滚动不会中断拖动。
    await page.locator('[data-category="all"]').click();
    const first = (await shown())[0];
    await startDrag(first);
    const scrollBefore = await page.evaluate(() => scrollY);
    await page.mouse.move(1000, 1192, {steps: 15});
    await page.waitForFunction(before => scrollY > before + 100, scrollBefore);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    assert.equal(writes.length, 4);
    assert.equal(await page.evaluate(() => window.chartOpens), 0);

    // 小屏也能直接拖动，排序控件不受页面滚动吞掉。
    await page.setViewportSize({width: 375, height: 812});
    await page.locator('[data-category="1"]').click();
    await page.evaluate(() => scrollTo(0, 0));
    visible = await shown();
    await card(visible[1]).scrollIntoViewIfNeeded();
    await startDrag(visible[0]);
    await card(visible[1]).scrollIntoViewIfNeeded();
    await dropOn(visible[1], true);
    await waitWrites(5);
    assert.deepEqual(await shown(), [visible[1], visible[0], ...visible.slice(2)]);
    await page.setViewportSize({width: 1440, height: 1200});
    for (const [index, zoom] of ['50', '70', '125', '150'].entries()) {
      await page.locator('#watchlist-zoom').selectOption(zoom);
      visible = await shown();
      await startDrag(visible[0]);
      await dropOn(visible[1], true);
      await waitWrites(6 + index);
      assert.deepEqual(await shown(), [visible[1], visible[0], ...visible.slice(2)], `Drag target stays correct at ${zoom}%`);
    }
    assert.deepEqual(errors, []);
    console.log('Watchlist sorting browser checks passed: direct mouse drag, threshold, before/after targets, hidden slots, reload persistence, cancellation, saving state, rollback/retry, auto-scroll, mobile and no chart opens; all writes mocked.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
