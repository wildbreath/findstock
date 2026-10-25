// PLAYWRIGHT_MODULE 可指向已有运行时；全部页面、行情与写入请求均拦截，不接触真实数据。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const waitUntil = async (page, check, message) => {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await check()) return;
    await page.waitForTimeout(25);
  }
  assert.fail(message);
};
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
};
const selectNoteText = (note, start, end) => note.evaluate((node, offsets) => {
  node.focus();
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), texts = [];
  while (walker.nextNode()) texts.push(walker.currentNode);
  const boundary = offset => {
    for (const text of texts) {
      if (offset <= text.length) return [text, offset];
      offset -= text.length;
    }
    return [node, node.childNodes.length];
  };
  const range = document.createRange();
  range.setStart(...boundary(offsets[0]));
  range.setEnd(...boundary(offsets[1]));
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}, [start, end]);

(async () => {
  const browser = await chromium.launch({channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
    const errors = [], unexpected = [], writes = [], chartCalls = [], searches = [];
    page.on('pageerror', error => errors.push(error.message));
    const categories = [{id: 1, name: '趋势突破'}, {id: 2, name: '低吸观察'}, {id: 3, name: '等待确认'}];
    const market = [
      {code: 'sh.600825', name: '新华传媒'},
      {code: 'sh.600519', name: '贵州茅台'},
      {code: 'sz.000333', name: '美的集团'},
    ].map(item => ({...item, board: 'main_sh', board_label: '沪深主板'}));
    let items = Array.from({length: 24}, (_, index) => ({
      code: index === 0 ? market[0].code : `sz.${String(index + 1).padStart(6, '0')}`,
      name: index === 0 ? market[0].name : `观察股票`,
      categories: index % 2 ? [categories[1]] : [categories[0]],
      note: index === 0 ? '观察量能与突破' : null,
      note_highlights: [], board: 'main_sh', board_label: '沪深主板',
      latest_close: 13.78, latest_pct_chg: 9.98, latest_date: '2026-10-21',
      added_at: '2026-10-21T08:00:00Z', source_date: '2026-10-20',
    }));
    items[2].categories.push(categories[1]);
    let activeCharts = 0, peakCharts = 0, failSearch = false, failAdd = false, failOrder = false;
    let heldSearch = null, heldPatch = null, heldGet = null, watchlistReads = 0;
    const counts = () => categories.map(category => ({...category,
      count: items.filter(item => item.categories.some(value => value.id === category.id)).length}));
    const snapshot = value => JSON.parse(JSON.stringify(value));
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
      if (path === '/watchlist') return route.fulfill({contentType: 'text/html', body: fs.readFileSync('web/watchlist.html', 'utf8')});
      if (path.startsWith('/static/')) {
        const file = path.split('/').at(-1);
        if (fs.existsSync(`web/${file}`)) return route.fulfill({
          contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(`web/${file}`, 'utf8')});
      }
      if (path === '/api/stocks/search') {
        const query = url.searchParams.get('q'); searches.push(query);
        const result = query === '旧查询' ? [market[2]] : query === '无匹配' ? [] : query === '美的' ? [market[2]] :
          query === '茅台' || query === '600519' ? [market[1]] : [market[0]];
        if (query === '旧查询' && heldSearch) await heldSearch.promise;
        if (failSearch) return route.fulfill({status: 502, json: {error: {message: '测试搜索失败'}}});
        return route.fulfill({json: result});
      }
      if (path.endsWith('/chart')) {
        const code = decodeURIComponent(path.split('/')[3]);
        chartCalls.push({code, end: url.searchParams.get('end'), limit: url.searchParams.get('limit')});
        peakCharts = Math.max(peakCharts, ++activeCharts);
        await new Promise(done => setTimeout(done, 25)); activeCharts--;
        const bars = Array.from({length: 20}, (_, index) => ({trade_date: `2026-09-${String(index + 1).padStart(2, '0')}`,
          open: 10 + index * .2, close: 10 + index * .2 + (index % 3 ? .3 : -.2), high: 10.6 + index * .2,
          low: 9.5 + index * .2, volume: 1000, amount: 10000, ma: {5: 11, 10: 11, 20: 11}}));
        return route.fulfill({json: {code, name: '本地名称', bars, ma_windows: [5, 10, 20, 60]}});
      }
      if (path === '/api/watchlist' && method === 'GET') {
        watchlistReads++;
        const result = snapshot({items, categories: counts(), codes: items.map(item => item.code)}), gate = heldGet;
        if (gate) { heldGet = null; await gate.promise; }
        return route.fulfill({json: result});
      }
      if (path === '/api/watchlist/categories' && method === 'GET') return route.fulfill({json: counts()});
      if (path === '/api/watchlist' && method === 'POST') {
        const body = request.postDataJSON(); writes.push({method, path, body});
        if (failAdd) return route.fulfill({status: 502, json: {error: {message: '测试加入失败'}}});
        let item = items.find(value => value.code === body.code);
        if (!item) {
          item = {...market.find(value => value.code === body.code), categories: categories.filter(category => body.category_ids.includes(category.id)),
            note: null, note_highlights: [], latest_close: null, latest_pct_chg: null, latest_date: null,
            added_at: '2026-10-22T08:00:00Z', source_date: null};
          items.push(item);
        }
        return route.fulfill({json: item});
      }
      if (path === '/api/watchlist/order' && method === 'PUT') {
        const body = request.postDataJSON(); writes.push({method, path, body});
        if (failOrder) return route.fulfill({status: 502, json: {error: {message: '测试排序失败'}}});
        assert.deepEqual([...body.codes].sort(), items.map(item => item.code).sort(), 'The complete watchlist must be saved');
        items = body.codes.map(code => items.find(item => item.code === code));
        return route.fulfill({json: {codes: body.codes}});
      }
      if (path.startsWith('/api/watchlist/') && method === 'PATCH') {
        const code = decodeURIComponent(path.split('/').at(-1)), body = request.postDataJSON();
        writes.push({method, path, body});
        const item = items.find(value => value.code === code);
        if ('note' in body) item.note = body.note;
        if ('note_highlights' in body) item.note_highlights = body.note_highlights;
        if ('category_ids' in body) item.categories = categories.filter(category => body.category_ids.includes(category.id));
        const result = snapshot(item);
        const gate = heldPatch;
        if (gate) { heldPatch = null; await gate.promise; }
        return route.fulfill({json: result});
      }
      unexpected.push(`${method} ${path}`);
      return route.abort();
    });

    const allCodes = () => items.map(item => item.code);
    const shownCodes = () => page.locator('.watch-card').evaluateAll(nodes => nodes.map(node => node.dataset.code));
    const card = code => page.locator(`.watch-card[data-code="${code}"]`);
    const firstCode = items[0].code;
    await page.goto('http://findstock.test/watchlist');
    await page.locator('.watch-mini-chart svg').first().waitFor();
    await page.waitForFunction(() => watchChartActive === 0 && watchChartQueue.length === 0);
    assert.ok(peakCharts <= 3, 'Only three miniature charts may load concurrently');
    assert.ok(chartCalls.length < items.length, 'Offscreen cards must not load charts eagerly');
    assert.ok(chartCalls.every(call => call.end === '2026-10-21' && call.limit === '20'));
    assert.equal(new Set(chartCalls.map(call => `${call.code}:${call.end}`)).size, chartCalls.length);
    assert.equal(await page.locator('.cat-chip-custom').count(), categories.length);
    const normalHeight = (await card(firstCode).boundingBox()).height;
    const compactLayout = await card(firstCode).evaluate(node => {
      const main = node.querySelector('.watch-main').getBoundingClientRect();
      const chart = node.querySelector('.watch-mini-chart').getBoundingClientRect();
      const note = node.querySelector('.watch-note').getBoundingClientRect();
      return {chartWidth: chart.width, chartHeight: chart.height,
        sideBySide: chart.left >= main.right && chart.top <= main.top + 1 && chart.bottom >= note.bottom};
    });
    assert.ok(normalHeight < 240, 'Information and notes use a compact card height');
    assert.ok(compactLayout.chartWidth >= 140 && compactLayout.chartHeight >= 140,
      'The chart uses the right side instead of a small fixed thumbnail');
    assert.equal(compactLayout.sideBySide, true, 'The chart spans alongside the information and note');
    const normalVisible = await page.locator('.watch-card').evaluateAll(nodes =>
      nodes.filter(node => { const rect = node.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; }).length);
    const originalCard = await card(firstCode).elementHandle();
    for (const zoom of ['50', '70', '125', '150']) {
      await page.locator('#watchlist-zoom').selectOption(zoom);
      const box = await card(firstCode).boundingBox();
      assert.ok(zoom < 100 ? box.height < normalHeight : box.height > normalHeight);
      assert.equal(await card(firstCode).evaluate((node, original) => node === original, originalCard), true,
        'Scaling keeps existing card editors and chart nodes');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (zoom === '50') {
        const visible = await page.locator('.watch-card').evaluateAll(nodes =>
          nodes.filter(node => { const rect = node.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; }).length);
        assert.ok(visible > normalVisible, 'Reducing zoom fits more complete stock cards in the viewport');
      }
    }
    await page.locator('#watchlist-zoom').selectOption('70');
    await page.reload();
    await page.locator('.watch-card').first().waitFor();
    assert.equal(await page.locator('#watchlist-zoom').inputValue(), '70', 'Zoom survives page reload');
    await page.locator('.watch-mini-chart svg').first().waitFor();
    await page.screenshot({path: '.probe/watchlist-zoom-70.png'});
    await page.locator('#watchlist-zoom').selectOption('100');
    assert.ok(!(await card(firstCode).innerText()).match(/加入 2026|筛选日/));
    await page.evaluate(() => { window.chartOpens = []; openStockChart = (code, options) => window.chartOpens.push({code, name: options.name}); });
    await card(firstCode).locator('.watch-mini-chart').click();
    assert.equal(await page.evaluate(() => window.chartOpens.at(-1).code), firstCode);
    await page.evaluate(() => { window.chartOpens = []; });
    await card(firstCode).locator('.watch-name').click();
    assert.equal(await page.evaluate(() => window.chartOpens.at(-1).code), firstCode);
    await page.evaluate(() => { window.chartOpens = []; });
    await card(firstCode).locator('[data-role="note"]').click();
    await card(firstCode).locator('.watch-meta').click();
    await card(firstCode).click({position: {x: 2, y: 2}});
    assert.equal(await page.evaluate(() => window.chartOpens.length), 0, 'Only the stock name and miniature chart may open a chart');

    // 搜索只面向全市场，分类和已有股票不能缩小搜索结果。
    await page.locator('[data-category="1"]').click();
    const beforeSearch = await shownCodes();
    await page.locator('#watchlist-search').fill('茅台');
    await page.locator('[data-add-code="sh.600519"]').waitFor();
    assert.deepEqual(await shownCodes(), beforeSearch);
    assert.ok(searches.includes('茅台'));
    await page.locator('[data-add-code="sh.600519"]').click();
    await card('sh.600519').waitFor();
    assert.deepEqual(writes.find(write => write.method === 'POST').body.category_ids, [1]);
    assert.equal(await page.locator('#watch-add-dialog').count(), 0, 'Search adds directly');
    assert.ok(items.find(item => item.code === 'sh.600519').categories.some(category => category.id === 1));
    await page.locator('#watchlist-search').fill('新华');
    await page.locator('[data-add-code="sh.600825"]').waitFor();
    assert.equal(await page.locator('[data-add-code="sh.600825"]').isDisabled(), true);
    heldSearch = deferred();
    await page.locator('#watchlist-search').fill('旧查询');
    await waitUntil(page, () => searches.includes('旧查询'), 'The stale search must reach the mock API');
    await page.locator('#watchlist-search').fill('600519');
    await page.locator('[data-add-code="sh.600519"]').waitFor();
    heldSearch.resolve();
    await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('[data-add-code="sz.000333"]').count(), 0, 'A stale search response must not replace the newest results');
    failSearch = true;
    await page.locator('#watchlist-search').fill('美的');
    await page.getByText(/测试搜索失败/).first().waitFor();
    failSearch = false;
    await page.locator('#watchlist-search').fill('美');
    await page.locator('#watchlist-search').fill('美的');
    await page.locator('[data-add-code="sz.000333"]').waitFor();
    failAdd = true;
    await page.locator('[data-add-code="sz.000333"]').click();
    await page.getByText(/测试加入失败/).first().waitFor();
    assert.equal(items.some(item => item.code === 'sz.000333'), false);
    failAdd = false;
    await page.locator('[data-add-code="sz.000333"]').click();
    await card('sz.000333').waitFor();
    await page.locator('#watchlist-search').fill('无匹配');
    await page.locator('#watchlist-search-results').getByText(/没有|未找到/).waitFor();
    assert.ok((await shownCodes()).includes(firstCode));
    await page.locator('#watchlist-search').fill('');

    // 选区高亮使用 Unicode 字符位置，并在重新载入后保留。
    const note = card(firstCode).locator('[data-role="note"]');
    await note.fill('观察😀量能突破');
    await selectNoteText(note, 4, 6);
    await card(firstCode).locator('[data-action="highlight-note"]').click();
    await waitUntil(page, () => items.find(item => item.code === firstCode).note_highlights.length === 1, 'The selected text must be saved');
    assert.deepEqual(items.find(item => item.code === firstCode).note_highlights, [[3, 5]]);
    assert.equal(await note.locator('mark').innerText(), '量能');
    await page.locator('#watchlist-search').focus();
    assert.equal(await note.locator('mark').evaluate(node => getComputedStyle(node).backgroundColor === 'rgba(0, 0, 0, 0)'), false,
      'Word-style highlight must remain visible when the editor loses focus');
    await card(firstCode).screenshot({path: '.probe/watchlist-word-highlight.png'});
    assert.equal(await page.evaluate(() => window.chartOpens.length), 0, 'Editing and note tools must never open a chart');
    await page.reload();
    await note.locator('mark').waitFor();
    assert.equal(await note.locator('mark').innerText(), '量能');
    await page.evaluate(() => { window.chartOpens = []; openStockChart = (code, options) => window.chartOpens.push({code, name: options.name}); });

    // 跨已有高亮选区添加、局部清除，并用键盘启动高亮工具。
    await selectNoteText(note, 6, 8);
    await page.keyboard.press('Tab');
    assert.equal(await card(firstCode).locator('[data-action="highlight-note"]').evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Enter');
    await waitUntil(page, () => JSON.stringify(items.find(item => item.code === firstCode).note_highlights) === '[[3,7]]', 'Adjacent ranges should merge');
    assert.equal(await note.locator('mark').innerText(), '量能突破');
    await selectNoteText(note, 5, 7);
    await card(firstCode).locator('[data-action="clear-note-highlights"]').click();
    await waitUntil(page, () => JSON.stringify(items.find(item => item.code === firstCode).note_highlights) === '[[3,4],[6,7]]', 'Clearing selected text must preserve the other highlights');
    assert.deepEqual(await note.locator('mark').allTextContents(), ['量', '破']);
    await selectNoteText(note, 2, 7);
    await card(firstCode).locator('[data-action="highlight-note"]').click();
    await waitUntil(page, () => JSON.stringify(items.find(item => item.code === firstCode).note_highlights) === '[[2,7]]', 'Overlapping ranges should merge without splitting the emoji');
    assert.equal(await note.locator('mark').innerText(), '😀量能突破');
    await selectNoteText(note, 2, 8);
    await card(firstCode).locator('[data-action="highlight-note"]').click();
    await waitUntil(page, () => items.find(item => item.code === firstCode).note_highlights.length === 0, 'Applying highlight again toggles a fully highlighted selection off');
    await selectNoteText(note, 4, 6);
    await card(firstCode).locator('[data-action="highlight-note"]').click();
    await waitUntil(page, () => items.find(item => item.code === firstCode).note_highlights.length === 1, 'Reapplying highlight must restore it');
    await selectNoteText(note, 8, 8);
    await card(firstCode).locator('[data-action="clear-note-highlights"]').click();
    await waitUntil(page, () => items.find(item => item.code === firstCode).note_highlights.length === 0, 'Clear without a selection removes all highlighting');

    // 粘贴只保留纯文本和换行，中文输入法组合过程中不能重建编辑器。
    await note.fill('');
    await note.evaluate(node => {
      const data = new DataTransfer();
      data.setData('text/plain', '第一行😀\n第二行 <观察>');
      data.setData('text/html', '<img src=x onerror="window.unsafePaste=true"><b>富文本</b>');
      node.dispatchEvent(new ClipboardEvent('paste', {bubbles: true, cancelable: true, clipboardData: data}));
    });
    assert.equal(await note.innerText(), '第一行😀\n第二行 <观察>');
    assert.equal(await note.locator('img, b').count(), 0, 'Pasted HTML must not become editable markup');
    assert.equal(await page.evaluate(() => window.unsafePaste), undefined);
    await page.locator('#watchlist-search').focus();
    await waitUntil(page, () => items.find(item => item.code === firstCode).note === '第一行😀\n第二行 <观察>', 'Pasted line breaks must survive saving');
    await note.focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Shift+Home');
    await card(firstCode).locator('[data-action="highlight-note"]').click();
    await waitUntil(page, () => JSON.stringify(items.find(item => item.code === firstCode).note_highlights) === '[[5,13]]', 'Selections on a pasted second line must use the persisted newline offset');
    assert.equal(await note.locator('mark').innerText(), '第二行 <观察>');
    await note.evaluate(node => {
      window.composingNote = node;
      node.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true}));
      node.textContent = '中文输入中';
      node.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertCompositionText', data: '中', isComposing: true}));
    });
    assert.equal(await note.evaluate(node => node === window.composingNote && node.textContent === '中文输入中'), true);
    await note.evaluate(node => {
      node.dispatchEvent(new CompositionEvent('compositionend', {bubbles: true, data: '中文输入中'}));
      node.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: '中文输入中'}));
    });
    await page.locator('#watchlist-search').focus();
    await waitUntil(page, () => items.find(item => item.code === firstCode).note === '中文输入中', 'The completed composition must be saved');
    await waitUntil(page, async () => (await card(firstCode).locator('[data-role="note-status"]').innerText()).includes('已保存'), 'Composition saving must finish');

    // 字数上限处在中间插入文字不能删除原有末尾；选中文本后仍可替换。
    const maximumNote = `首${'中'.repeat(498)}尾`;
    await note.fill(maximumNote);
    await selectNoteText(note, 250, 250);
    await page.keyboard.insertText('添');
    assert.equal(await note.innerText(), maximumNote, 'Typing into a full note must preserve the existing tail');
    await selectNoteText(note, 248, 252);
    await page.keyboard.insertText('新增');
    assert.equal(await note.innerText(), `${maximumNote.slice(0, 248)}新增${maximumNote.slice(252)}`);
    await page.locator('#watchlist-search').focus();
    await waitUntil(page, async () => (await card(firstCode).locator('[data-role="note-status"]').innerText()).includes('已保存'), 'The maximum-length replacement must finish saving');

    // 第一份保存迟到时，继续编辑和清除高亮不能被旧响应覆盖。
    const patchGate = deferred(); heldPatch = patchGate;
    const priorPatchCount = writes.filter(write => write.method === 'PATCH').length;
    await note.fill('第一次保存的观察');
    await page.locator('#watchlist-search').focus();
    await waitUntil(page, () => writes.filter(write => write.method === 'PATCH').length > priorPatchCount, 'The first note save must start');
    await note.fill('最终观察😀重点');
    await card(firstCode).locator('[data-action="clear-note-highlights"]').click();
    patchGate.resolve();
    await page.locator('#watchlist-search').focus();
    await waitUntil(page, () => items.find(item => item.code === firstCode).note === '最终观察😀重点', 'The latest draft must be saved after the in-flight request');
    await waitUntil(page, async () => (await card(firstCode).locator('[data-role="note-status"]').innerText()).includes('已保存'), 'The final save must finish');
    assert.equal(await note.textContent(), '最终观察😀重点');
    assert.deepEqual(items.find(item => item.code === firstCode).note_highlights, []);
    await page.reload();
    await note.waitFor();
    assert.equal(await note.textContent(), '最终观察😀重点');
    assert.equal(await note.locator('mark').count(), 0);
    await page.evaluate(() => { window.chartOpens = []; openStockChart = (code, options) => window.chartOpens.push({code, name: options.name}); });

    // 刷新取得的旧列表比备注保存更晚回来时，不能覆盖已保存的内容。
    const getGate = deferred(), readsBeforeRefresh = watchlistReads; heldGet = getGate;
    await page.locator('#watchlist-refresh').click();
    await waitUntil(page, () => watchlistReads > readsBeforeRefresh, 'The held watchlist refresh must start');
    await note.fill('刷新期间保留重点');
    await selectNoteText(note, 4, 6);
    await card(firstCode).locator('[data-action="highlight-note"]').click();
    await waitUntil(page, async () => (await card(firstCode).locator('[data-role="note-status"]').innerText()).includes('已保存'), 'Saving while refresh is pending must finish');
    getGate.resolve();
    await page.waitForFunction(() => !document.querySelector('#watchlist-refresh').disabled);
    assert.equal(await note.textContent(), '刷新期间保留重点');
    assert.equal(await note.locator('mark').innerText(), '保留');

    const categorySaveGate = deferred(); heldPatch = categorySaveGate;
    await note.fill('切换分类也保留草稿');
    await page.locator('[data-category="2"]').click();
    await page.locator('[data-category="1"]').click();
    assert.equal(await note.textContent(), '切换分类也保留草稿');
    categorySaveGate.resolve();
    await waitUntil(page, () => items.find(item => item.code === firstCode).note === '切换分类也保留草稿', 'Changing category must preserve the note draft');
    await waitUntil(page, async () => (await card(firstCode).locator('[data-role="note-status"]').innerText()).includes('已保存'), 'The note must finish saving after category switching');

    // 分类内排序只交换该分类所占位置；未显示的股票仍在原位。
    await page.locator('[data-category="1"]').click();
    const initialOrder = allCodes(), visibleBeforeDrag = await shownCodes();
    const hiddenSlots = initialOrder.map((code, index) => ({code, index})).filter(value => !visibleBeforeDrag.includes(value.code));
    const handleBounds = await card(visibleBeforeDrag[0]).locator('[data-action="drag"]').boundingBox();
    const targetBounds = await card(visibleBeforeDrag[2]).boundingBox();
    await page.mouse.move(handleBounds.x + handleBounds.width / 2, handleBounds.y + handleBounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetBounds.x + 30, targetBounds.y + 10, {steps: 20});
    await page.mouse.up();
    await waitUntil(page, () => writes.some(write => write.path === '/api/watchlist/order'), 'Dragging must save the order');
    await waitUntil(page, async () => !(await card(visibleBeforeDrag[0]).locator('[data-action="move-down"]').isDisabled()), 'The drag save must finish');
    assert.notDeepEqual(await shownCodes(), visibleBeforeDrag);
    hiddenSlots.forEach(({code, index}) => assert.equal(items[index].code, code, 'Hidden stock positions must be preserved'));
    assert.equal(await page.evaluate(() => window.chartOpens.length), 0, 'Dragging must not open a chart');
    const savedOrder = allCodes();
    await page.reload();
    await page.locator('.watch-card').first().waitFor();
    assert.deepEqual(await shownCodes(), savedOrder);
    await page.locator('[data-category="1"]').click();
    const visibleBeforeFailure = await shownCodes();
    failOrder = true;
    await card(visibleBeforeFailure[0]).locator('[data-action="move-down"]').click();
    await page.getByText(/测试排序失败/).first().waitFor();
    assert.deepEqual(await shownCodes(), visibleBeforeFailure, 'Failed sorting restores the displayed order');
    assert.deepEqual(allCodes(), savedOrder);
    failOrder = false;
    await card(visibleBeforeFailure[0]).locator('[data-action="move-down"]').click();
    await waitUntil(page, () => allCodes()[0] !== savedOrder[0], 'Keyboard-accessible move controls must save');

    // 宽屏按原顺序逐行排成双列；窄屏回到单列，编辑与排序控件不能互相覆盖。
    await page.locator('[data-category="all"]').click();
    await page.locator('.alert-close').evaluateAll(nodes => nodes.forEach(node => node.click()));
    const sizes = {};
    for (const [width, height] of [[1440,1000],[1024,768],[375,812],[812,375]]) {
      await page.setViewportSize({width, height});
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const bounds = await card(firstCode).boundingBox();
      const twoCategoryBounds = await card('sz.000003').boundingBox();
      const layout = await page.locator('#watchlist-list').evaluate(node => {
        const cards = [...node.children].slice(0, 3).map(card => card.getBoundingClientRect());
        return {width: node.clientWidth, gap: parseFloat(getComputedStyle(node).columnGap),
          cards: cards.map(({x, y, width}) => ({x, y, width}))};
      });
      if (width > 1180) {
        assert.ok(Math.abs(layout.cards[0].y - layout.cards[1].y) < 1, 'The first two stocks share a row');
        assert.ok(layout.cards[1].x > layout.cards[0].x && layout.cards[2].y > layout.cards[0].y,
          'Stocks keep their saved order from left to right, then top to bottom');
        assert.ok(Math.abs(bounds.width * 2 + layout.gap - layout.width) < 1);
      } else {
        assert.equal(bounds.width, layout.width);
        assert.ok(layout.cards[1].y > layout.cards[0].y, 'Narrow screens keep readable single-column cards');
      }
      sizes[width] = {...bounds, children: await card(firstCode).evaluate(node =>
        Object.fromEntries(['.watch-main', '.watch-categories', '.watch-note', '.note-editor', '.note-input', '.note-tools', '.note-status']
          .map(selector => [selector, node.querySelector(selector).getBoundingClientRect().height]))), twoCategoryBounds};
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Page overflow at ${width}`);
      assert.equal(await card(firstCode).evaluate(node => node.scrollWidth <= node.clientWidth), true, `Card overflow at ${width}`);
      for (const zoom of ['50', '70', '150']) {
        await page.locator('#watchlist-zoom').selectOption(zoom);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
          `Page overflow at ${width}, ${zoom}%`);
        assert.equal(await card(firstCode).evaluate(node => node.scrollWidth <= node.clientWidth + 1), true,
          `Card overflow at ${width}, ${zoom}%`);
        const chartLayout = await card(firstCode).evaluate(node => {
          const main = node.querySelector('.watch-main').getBoundingClientRect();
          const chart = node.querySelector('.watch-mini-chart').getBoundingClientRect();
          const note = node.querySelector('.watch-note').getBoundingClientRect();
          return {rightOfInfo: chart.left >= main.right - 1,
            chartShare: chart.width / node.getBoundingClientRect().width,
            noteClear: note.right <= chart.left + 1 || note.top >= chart.bottom - 1};
        });
        assert.ok(chartLayout.rightOfInfo && chartLayout.chartShare >= .3 && chartLayout.noteClear,
          `Chart remains large and beside the information without covering notes at ${width}, ${zoom}%`);
        const overlap = await card(firstCode).evaluate(node => {
          const order = node.querySelector('.watch-reorder').getBoundingClientRect();
          return [...node.querySelectorAll('.note-tools button, .note-status')].some(control => {
            const rect = control.getBoundingClientRect();
            return rect.width > 0 && rect.left < order.right && rect.right > order.left && rect.top < order.bottom && rect.bottom > order.top;
          });
        });
        assert.equal(overlap, false, `Note and drag controls overlap at ${width}, ${zoom}%`);
      }
      await page.locator('#watchlist-zoom').selectOption('100');
      if (width === 1440 || width === 375) {
        await card(firstCode).scrollIntoViewIfNeeded();
        await page.screenshot({path: `.probe/watchlist-${width}.png`, fullPage: false});
      }
      const noteOverlap = await card(firstCode).evaluate(node => {
        const order = node.querySelector('.watch-reorder').getBoundingClientRect();
        return [...node.querySelectorAll('.note-tools button, .note-status')].some(control => {
          const rect = control.getBoundingClientRect();
          return rect.width > 0 && rect.left < order.right && rect.right > order.left && rect.top < order.bottom && rect.bottom > order.top;
        });
      });
      assert.equal(noteOverlap, false, `Order controls overlap note tools at ${width}`);
      await card(firstCode).locator('[data-action="picker"]').click();
      assert.equal(await card(firstCode).locator('.watch-reorder').isVisible(), false, 'Sorting is hidden while choosing categories');
      const pickerOverlap = await card(firstCode).evaluate(node => {
        const order = node.querySelector('.watch-reorder').getBoundingClientRect();
        const picker = node.querySelector('.category-picker').getBoundingClientRect();
        return order.width > 0 && order.height > 0 && picker.left < order.right && picker.right > order.left && picker.top < order.bottom && picker.bottom > order.top;
      });
      if (width === 375) await page.screenshot({path: '.probe/watchlist-picker-375.png'});
      assert.equal(pickerOverlap, false, `Order controls overlap category picker at ${width}`);
      await card(firstCode).locator('[data-action="cancel-picker"]').click();
      assert.equal(await card(firstCode).locator('.watch-reorder').isVisible(), true, 'Sorting returns when the category picker closes');
    }
    fs.mkdirSync('.probe', {recursive: true});
    fs.writeFileSync('.probe/watchlist-sizes.json', JSON.stringify(sizes, null, 2));
    await note.fill('观察量能与突破后的回踩确认，等待趋势明朗再做决定。'.repeat(18));
    await selectNoteText(note, 40, 52);
    await card(firstCode).locator('[data-action="highlight-note"]').click();
    await waitUntil(page, async () => (await card(firstCode).locator('[data-role="note-status"]').innerText()).includes('已保存'), 'The long highlighted note must finish saving');
    const longNoteLayout = await card(firstCode).evaluate(node => {
      const text = node.querySelector('[data-role="note"]');
      text.scrollTop = 45;
      text.dispatchEvent(new Event('scroll'));
      return {width: text.clientWidth, height: text.clientHeight, scrollHeight: text.scrollHeight, scrollTop: text.scrollTop,
        highlightedText: text.querySelector('mark').textContent};
    });
    fs.writeFileSync('.probe/watchlist-note-layout.json', JSON.stringify(longNoteLayout, null, 2));
    assert.ok(longNoteLayout.scrollHeight > longNoteLayout.height && longNoteLayout.scrollTop > 0, 'Long notes must scroll inside the existing editor bounds');
    assert.equal(longNoteLayout.highlightedText.length, 12);
    await card(firstCode).scrollIntoViewIfNeeded();
    await page.screenshot({path: '.probe/watchlist-long-note.png'});
    await page.setViewportSize({width: 1440, height: 1000});
    await page.locator('[data-category="3"]').click();
    await page.getByText('这个分类里还没有股票', {exact: true}).waitFor();
    await page.locator('[data-action="reset-filter"]').click();
    assert.equal(await page.locator('.watch-card').count(), items.length);
    items = [];
    await page.locator('#watchlist-refresh').click();
    await page.getByText('还没有自选股', {exact: true}).waitFor();
    assert.equal(await page.locator('#watchlist-search').isEnabled(), true);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
    console.log('Watchlist browser checks passed: market search/add, Word-style inline highlights and keyboard selection, safe multiline paste, IME and length limits, concurrent/draft note saves, chart click boundaries, pointer drag/order rollback, lazy mini charts, card bounds and empty/mobile views; all requests mocked.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
