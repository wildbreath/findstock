// 检查保存/读取的异步边界, 不启动浏览器或访问真实数据。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('web/review.js', 'utf8').split('$("review-grid").addEventListener("pointerdown"')[0];

function setup() {
  const nodes = new Map(), timers = [];
  const context = vm.createContext({
    $: id => {
      if (!nodes.has(id)) nodes.set(id, {textContent: '', dataset: {}, setAttribute() {}, removeAttribute() {}, querySelector: () => ({})});
      return nodes.get(id);
    },
    setTimeout: callback => { timers.push(callback); return timers.length; },
    clearTimeout() {}, confirm: () => true,
    document: {documentElement: {style: {setProperty() {}}}},
    localStorage: {getItem: () => null, setItem() {}, removeItem() {}},
  });
  vm.runInContext(source, context);
  vm.runInContext(`
    reviewLoaded = true;
    reviewSheet = {revision: 1, dates: ['2026-10-26'], hidden_dates: [], rows: [{id: 'stock', cells: {}}]};
    globalThis.finishCalls = 0;
    reviewFinishEdit = () => { finishCalls++; return true; };
  `, context);
  return {context, nodes, timers, run: code => vm.runInContext(code, context)};
}

(async () => {
  {
    const {context, run} = setup();
    run(`reviewDays = ['2026-10-23']; reviewSheet.rows = [{id: 'existing', theme: '农业', stock_code: 'sh.600001',
      tracking: {code: 'sh.600001', theme: '农业', entry_date: '2026-10-26', stopped: false},
      cells: {'2026-10-23': {text: '甲股', kind: 'stock'}}}];
      reviewAddStocks.set('sh.600001', {code: 'sh.600001', name: '甲股'});
      $("review-add-stocks-dialog").open = true;
      reviewInsertRows = () => true;`);
    context.api = async () => ({rows: [], dates: ['2026-10-23']});
    assert.equal(await run('reviewAddSelectedStocks("农业", "2026-10-23")'), true,
      'A name cell from another entry date must not block adding a separate review round');
  }
  {
    const {run} = setup();
    run(`reviewDays = ['2026-10-26']; reviewSheet.rows = [{id: 'manual', stock_code: 'sh.600001',
      tracking: {code: 'sh.600001', theme: '农业', entry_date: '2026-10-26'},
      cells: {'2026-10-26': {text: '甲股', kind: 'stock'}}}];
      reviewSetCell(0, 0, {text: '乙股', kind: 'stock'});`);
    assert.equal(run('reviewSheet.rows[0].stock_code'), undefined);
    assert.equal(run('reviewSheet.rows[0].tracking'), undefined, 'Renaming a manually added stock must stop linking and filling the previous stock');
    run(`reviewSheet.rows[0] = {id: 'automatic', tracking: {code: 'sh.600001'}, cells: {'2026-10-26': {text: '甲股', kind: 'stock'}}};
      reviewSetCell(0, 0, {text: '自动股别名', kind: 'stock'});`);
    assert.equal(run('reviewSheet.rows[0].tracking.code'), 'sh.600001', 'Automatic stock identity remains bound by code');
    run(`reviewDays = ['2026-10-23', '2026-10-26']; reviewAnchor = reviewEnd = {r: 0, c: 1};
      reviewSheet.rows[0] = {id: 'manual', stock_code: 'sh.600001', tracking: {code: 'sh.600001'}, cells: {
        '2026-10-23': {text: '甲股', kind: 'stock'}, '2026-10-26': {text: '乙股'}
      }}; reviewRender = () => {}; reviewFocus = () => {}; reviewMarkKind('stock');`);
    assert.equal(run('reviewSheet.rows[0].stock_code'), undefined);
    assert.equal(run('reviewSheet.rows[0].tracking'), undefined, 'Moving the manual stock label also invalidates the previous code');
  }
  {
    const {context, run} = setup();
    let release;
    context.api = () => new Promise(resolve => { release = resolve; });
    const reading = run('reviewLoad(true)');
    run('reviewCollecting = true');
    release({revision: 2, dates: [], rows: [], hidden_dates: []});
    await reading;
    assert.equal(run('reviewSheet.revision'), 1, 'A read started before history preparation must not replace the current sheet during preparation');
  }
  {
    const {context, run} = setup();
    run(`reviewAddSource = 'search'; reviewAddStockResults = [{code: 'sh.600001', name: '旧结果'}];
      reviewAddStocks.set('sh.600001', reviewAddStockResults[0]);
      $("review-add-stock-query").value = '新查询'; $("review-add-stocks-dialog").open = true;
      reviewPaintAddStocks = () => {};`);
    context.api = async () => { throw new Error('搜索失败'); };
    await run('reviewSearchAddStocks()');
    assert.equal(run('reviewAddStockResults.length'), 0, 'A failed new search must not leave previous query results selectable');
    assert.equal(run('reviewAddStocks.size'), 1, 'Previously confirmed selections survive a failed search');
  }
  {
    const {context, nodes, run} = setup();
    run(`reviewDays = ['2026-10-26']; reviewSheet.rows = [
      {id: 'heading', theme: '金融', cells: {'2026-10-26': {text: '金融', kind: 'theme'}}},
      {id: 'inherited', stock_code: 'sh.600001', cells: {'2026-10-26': {text: '甲股', kind: 'stock'}}},
      {id: 'gap', cells: {}},
      {id: 'unclassified', stock_code: 'sh.600001', cells: {'2026-10-26': {text: '甲股', kind: 'stock'}}},
    ];
    reviewAddStocks.set('sh.600001', {code: 'sh.600001', name: '甲股'});
    reviewNewRow = () => ({id: 'new', cells: {}});
    reviewInsertRows = rows => { globalThis.addedRows = rows; return true; };
    globalThis.before = reviewBody();`);
    run('$("review-add-stocks-dialog").open = true');
    context.api = async (_, options) => {
      const payload = JSON.parse(options.body);
      return {rows: payload.stocks.map(stock => ({id: 'new', stock_code: stock.code, theme: payload.theme, cells: {}})), dates: [], missing_cells: 0};
    };
    assert.equal(await run('reviewAddSelectedStocks("科技", "2026-10-26")'), true,
      'A stock in another theme can be added on the same date');
    assert.equal(run('addedRows[0].theme'), '科技');
    assert.equal(run('addedRows[0].stock_code'), 'sh.600001');
    assert.equal(run('reviewBody()'), run('before'), 'Adding another theme does not rewrite existing records');
    assert.equal(await run('reviewAddSelectedStocks("金融", "2026-10-26")'), false,
      'Duplicate checks include legacy rows that inherit a theme from their group');
    assert.equal(await run('reviewAddSelectedStocks("", "2026-10-26")'), false,
      'Ungrouped legacy rows count as unclassified when checking duplicates');
    assert.equal(run('reviewBody()'), run('before'), 'Rejected duplicates do not normalize or alter old rows');
    context.api = async () => { throw new Error('本地行情读取失败'); };
    assert.equal(await run('reviewAddSelectedStocks("科技", "2026-10-26")'), false);
    assert.equal(run('reviewBody()'), run('before'), 'A failed fill request must not insert partial rows');
    assert.equal(run('reviewCollecting'), false);
    assert.match(nodes.get('review-add-stock-status').textContent, /本地行情读取失败/);
  }
  {
    const {run} = setup();
    run(`reviewDays = ['2026-10-26']; reviewSheet.rows = [{id: 'source', theme: '农业', leader: true,
      tracking: {code: 'sh.600001', theme: '农业', entry_date: '2026-10-23', stopped: true}, cells: {
        '2026-10-23': {text: '隐藏日期备注', highlight: true, bold: true}, '2026-10-26': {text: '+3%'}
      }}]; reviewNewRow = () => ({id: 'copy'});
      reviewInsertRows = rows => { globalThis.copies = rows; return true; };
      globalThis.before = reviewBody(); reviewDuplicateRows();`);
    assert.equal(run('copies[0].id'), 'copy');
    assert.equal(run('copies[0].stock_code'), 'sh.600001');
    assert.equal(run('copies[0].cells["2026-10-23"].text'), '隐藏日期备注');
    assert.equal(run('copies[0].tracking.stopped && copies[0].leader'), true);
    run('copies[0].cells["2026-10-23"].text = "独立副本"; copies[0].tracking.theme = "金融"');
    assert.equal(run('reviewBody()'), run('before'), 'Copied cells and tracking must not share objects with the source row');
  }
  {
    const {run} = setup();
    run(`reviewSheet.rows = [
      {id: 'a', theme: '农业', cells: {}}, {id: 'gap', cells: {}},
      {id: 'manual', cells: {'2026-10-26': {text: '独立手工股', kind: 'stock'}}},
      {id: 'b', theme: '金融', cells: {}}
    ]; reviewArrangeRows([], true);`);
    assert.equal(run('reviewSheet.rows.find(row => row.id === "manual").theme'), '未分类', 'Compacting must not absorb an independent manual record into its new neighbor');
    assert.equal(run('reviewThemeGroups().find(group => group.theme === "金融").indices.length'), 1);
    run(`reviewDays = ['2026-10-26']; reviewSheet.rows = [
      {id: 'a', theme: '农业', cells: {}}, {id: 'b', theme: '金融', cells: {}},
      {id: 'child', cells: {'2026-10-26': {text: '金融手工股', kind: 'stock'}}}
    ]; reviewAnchor = reviewEnd = {r: 1, c: 0}; reviewRender = () => {}; reviewFocus = () => {};
    globalThis.beforeDelete = reviewBody(); reviewDeleteRows();`);
    assert.equal(run('reviewSheet.rows.find(row => row.id === "child").theme'), '金融', 'Deleting a group heading preserves inherited classifications');
    run('reviewHistory(reviewUndo, reviewRedo)');
    assert.equal(run('reviewBody()'), run('beforeDelete'));
    run(`reviewSheet.dates = ['2026-10-23', '2026-10-26']; reviewDays = [...reviewSheet.dates];
      reviewSheet.rows = [{id: 'manual', stock_code: 'sh.600001', cells: {
        '2026-10-23': {text: '甲股', kind: 'stock'}, '2026-10-26': {text: '乙股'}
      }}]; reviewAnchor = reviewEnd = {r: 0, c: 1}; reviewMarkKind('stock');`);
    assert.equal(run('reviewRowInfo(reviewSheet.rows[0]).stock'), '乙股');
    assert.equal(run('reviewSheet.rows[0].stock_code'), undefined, 'Changing the marked stock cell invalidates the previous chart binding');
  }
  {
    const {context, nodes, run} = setup();
    context.api = async () => { throw Object.assign(new Error('请求参数不合法'), {status: 422,
      details: {errors: [{loc: ['body', 'rows', 0, 'theme'], msg: 'Extra inputs are not permitted'}]}}); };
    run('reviewDirty = true; reviewSheet.rows[0].theme = "人工题材"');
    await run('reviewSave()');
    assert.match(nodes.get('review-notice').textContent, /旧版本/);
    assert.equal(run('reviewDirty'), true);
    assert.equal(run('reviewSheet.rows[0].theme'), '人工题材');
    assert.equal(run('reviewSheet.revision'), 1);
    context.api = async () => ({revision: 2});
    await run('reviewSave()');
    assert.equal(run('reviewDirty'), false, 'Retry after a server update saves the existing draft');
  }
  {
    const {run} = setup();
    run(`reviewDays = ['2026-10-26']; reviewSheet.rows = [
      {id: 'a1', theme: '农业', cells: {'2026-10-26': {text: '农业', kind: 'theme'}}},
      {id: 'b1', tracking: {code: 'sh.600001', theme: '金融'}, cells: {'2026-10-26': {text: '金融', kind: 'theme'}}},
      {id: 'a2', theme: '农业', cells: {'2026-10-26': {text: '+5%', auto_text: '+5%'}}},
    ]; reviewAnchor = reviewEnd = {r: 1, c: 0}; reviewRender = () => {}; reviewFocus = () => {};
    globalThis.beforePaste = reviewBody(); reviewPaste(' 农业 ');`);
    assert.equal(run('reviewSheet.rows.map(row => row.id).join(",")'), 'a1,b1,a2');
    assert.equal(run('reviewSheet.rows[1].theme'), '农业');
    assert.equal(run('reviewSheet.rows[1].tracking.theme'), '农业');
    assert.equal(run('reviewSheet.rows[1].cells["2026-10-26"].text'), '农业');
    run('reviewHistory(reviewUndo, reviewRedo)');
    assert.equal(run('reviewBody()'), run('beforePaste'));
    run(`reviewSheet.rows[1].stock_code = 'sh.600001'; reviewSheet.rows[1].tracking = null;
      reviewSheet.rows[1].cells['2026-10-26'] = {text: '手工甲', kind: 'stock'};
      reviewSetCell(1, 0, {text: '手工乙', kind: 'stock'});`);
    assert.equal(run('reviewSheet.rows[1].stock_code'), undefined, 'Renaming a manually bound stock invalidates the previous chart association');
  }
  {
    const {run} = setup();
    run(`reviewDays = ['2026-10-26'];
      reviewSheet.rows = [
        {id: 'a1', theme: '农业', cells: {'2026-10-26': {text: '农业', kind: 'theme'}}},
        {id: 'blank', cells: {}},
        {id: 'b1', tracking: {code: 'sh.600001', theme: '金融', stopped: true}, leader: true, cells: {'2026-10-25': {text: '隐藏备注', highlight: true}}},
        {id: 'a2', theme: '农业', cells: {'2026-10-26': {text: '+5%', auto_text: '+5%'}}},
        {id: 'styled', cells: {'2026-10-25': {background: '#ff0000'}}},
      ];
      reviewAnchor = reviewEnd = {r: 2, c: 0}; reviewRender = () => {}; reviewFocus = () => {};
      globalThis.before = reviewBody();
      reviewApplyTheme(' 农业 ');
    `);
    assert.equal(run('reviewSheet.rows.map(row => row.id).join(",")'), 'a1,b1,a2,styled');
    assert.equal(run('reviewSheet.rows[1].tracking.theme'), '农业');
    assert.equal(run('reviewAnchor.r'), 1, 'Selection follows the edited record');
    assert.equal(run('reviewSheet.rows[1].cells["2026-10-25"].text'), '隐藏备注');
    assert.equal(run('reviewSheet.rows[1].tracking.stopped && reviewSheet.rows[1].leader'), true);
    run('reviewHistory(reviewUndo, reviewRedo)');
    assert.equal(run('reviewBody()'), run('before'), 'One undo restores both classification and complete layout');
    run('reviewHistory(reviewRedo, reviewUndo); reviewDeleteRows()');
    assert.equal(run('reviewSheet.rows.map(row => row.id).join(",")'), 'a1,a2,styled');
    assert.equal(run('reviewUndo.length'), 2);
    run('reviewHistory(reviewUndo, reviewRedo)');
    assert.equal(run('reviewSheet.rows[1].id'), 'b1');
    assert.equal(run('reviewApplyTheme("   ")'), false);
    run('reviewSheet.rows = [{id: "last", theme: "农业", cells: {}}]; reviewAnchor = reviewEnd = {r: 0, c: 0}; reviewDeleteRows()');
    assert.equal(run('reviewSheet.rows.length'), 0, 'Deleting the last row does not add placeholder records');
  }
  {
    const {nodes, run} = setup();
    run(`reviewSheet.dates = ['2026-10-08', '2026-10-19']; reviewDays = [...reviewSheet.dates];
      reviewSheet.rows = [
        {id: 'first', tracking: {theme: 'AI应用'}, cells: {'2026-10-08': {text: 'AI应用', kind: 'theme'}}},
        {id: 'broken', tracking: {theme: 'AI应用'}, cells: {
          '2026-10-08': {text: 'AI应用', auto_text: 'AI应用', background: '#dbeafe', kind: ''},
          '2026-10-19': {text: '-9.99%', auto_text: '-9.99%', background: '#dbeafe', kind: 'theme'},
        }},
        {id: 'last', tracking: {theme: 'AI应用'}, cells: {'2026-10-08': {text: 'AI应用', kind: 'theme'}}},
      ];
      reviewAnchor = reviewEnd = {r: 1, c: 1};
    `);
    assert.equal(run('reviewRowInfo(reviewSheet.rows[1]).theme'), 'AI应用', 'A market cell mistakenly tagged as theme must not change grouping');
    assert.equal(run('JSON.stringify(reviewThemeBreaks())'), '[]', 'Mis-tagged percentages must not add empty separator rows');
    assert.equal(run('reviewThemeGroups().length'), 1);
    assert.equal(run('reviewIsMarketCell({text: "3D打印"})'), false, 'Theme names may contain numbers');
    assert.equal(run('reviewIsMarketCell({text: "+5.21%缩量", auto_text: "+5.21%"})'), true);
    assert.equal(run('reviewIsMarketCell({text: "2板缩量"})'), true);
    const before = run('reviewBody()');
    run('reviewMarkKind("theme"); reviewMarkKind("stock")');
    assert.equal(run('reviewBody()'), before, 'Invalid marking must leave the existing labels and market format intact');
    assert.equal(run('reviewUndo.length'), 0);
    assert.match(nodes.get('review-notice').textContent, /请选择名称格/);
    assert.doesNotMatch(run('reviewStyle(reviewCell(1, 1), false, "AI应用")'), /background-color:hsl/);
    run('reviewSheet.rows[1].cells["2026-10-08"] = {text: "传媒", kind: "theme"}');
    assert.equal(run('reviewRowInfo(reviewSheet.rows[1]).theme'), '传媒', 'Valid manual theme labels still take precedence');
  }
  {
    const {nodes, run} = setup();
    nodes.set('review-theme-list', {querySelectorAll: () => []});
    run(`reviewDays = ['2026-10-26']; reviewAnchor = {r: 2, c: 0}; reviewEnd = {r: 3, c: 0};
      reviewSheet.rows = [
        {id: 'a1', tracking: {theme: '农业'}, cells: {'2026-10-26': {text: '+3%', highlight: true}}},
        {id: 'a2', tracking: {theme: '农业'}, cells: {'2026-10-25': {text: '隐藏日期人工描述'}}},
        {id: 'b1', tracking: {theme: '金融', stopped: true}, leader: true, cells: {}},
        {id: 'b2', tracking: {theme: '金融'}, cells: {}},
        {id: 'c1', tracking: {theme: '科技'}, cells: {}},
      ];
      globalThis.originalRows = JSON.stringify(Object.fromEntries(reviewSheet.rows.map(row => [row.id, row])));
      reviewRender = () => {};
    `);
    run('reviewMoveTheme("金融", 0)');
    assert.equal(run('reviewSheet.rows.map(row => row.id).join(",")'), 'b1,b2,a1,a2,c1');
    assert.equal(run('reviewAnchor.r'), 0);
    assert.equal(run('reviewEnd.r'), 1);
    assert.equal(run('reviewUndo.length'), 1, 'Whole theme moves must be undoable');
    run('reviewMoveTheme("金融", 1)');
    assert.equal(run('reviewSheet.rows.map(row => row.id).join(",")'), 'a1,a2,b1,b2,c1');
    assert.equal(run('JSON.stringify(Object.fromEntries(reviewSheet.rows.map(row => [row.id, row]))) === originalRows'), true,
      'Moving a whole theme must preserve all cell dates, manual styles, leaders, stops and internal row order');
    run('reviewMoveTheme("农业", 0); reviewMoveTheme("农业", -1); reviewMoveTheme("金融", 1.5); reviewMoveTheme("金融", 3)');
    assert.equal(run('reviewUndo.length'), 2, 'Boundary moves must not create spurious changes');
    run('reviewMoveTheme("农业", 2)');
    assert.equal(run('reviewSheet.rows.map(row => row.id).join(",")'), 'b1,b2,c1,a1,a2', 'Move directly to the last position');
    run('reviewMoveTheme("农业", 0)');
    assert.equal(run('reviewSheet.rows.map(row => row.id).join(",")'), 'a1,a2,b1,b2,c1', 'Move directly to the first position');
    run(`reviewThemeDrag = '科技'; reviewThemeDrop({preventDefault() {}, clientY: 105,
      target: {closest: () => ({dataset: {sortTheme: '农业'}, getBoundingClientRect: () => ({top: 100, height: 40})})}})`);
    assert.equal(run('reviewSheet.rows.map(row => row.id).join(",")'), 'c1,a1,a2,b1,b2', 'Drop above a theme');
    assert.equal(run('reviewThemeDrag'), '', 'Drop cleanup must clear the dragged theme');
    run(`reviewThemeDrag = '科技'; reviewThemeDrop({preventDefault() {}, clientY: 135,
      target: {closest: () => ({dataset: {sortTheme: '农业'}, getBoundingClientRect: () => ({top: 100, height: 40})})}})`);
    assert.equal(run('reviewSheet.rows.map(row => row.id).join(",")'), 'a1,a2,c1,b1,b2', 'Drop below a theme when dragging down');
    const moved = run('reviewBody()');
    run(`reviewThemeDrag = '科技'; reviewThemeDrop({preventDefault() {}, clientY: 135,
      target: {closest: () => ({dataset: {sortTheme: '科技'}})}})`);
    assert.equal(run('reviewBody()'), moved, 'Dropping on the source must not change the order');
    run('reviewMoveTheme("科技", 2)');
    assert.equal(run('JSON.stringify(Object.fromEntries(reviewSheet.rows.map(row => [row.id, row]))) === originalRows'), true);
    run('reviewFocus = () => {}; reviewHistory(reviewUndo, reviewRedo)');
    assert.equal(run('reviewSheet.rows.map(row => row.id).join(",")'), 'a1,a2,c1,b1,b2', 'Undo the complete theme move');
    run('reviewHistory(reviewRedo, reviewUndo)');
    assert.equal(run('reviewSheet.rows.map(row => row.id).join(",")'), 'a1,a2,b1,b2,c1', 'Redo the complete theme move');
  }
  {
    const {nodes, run} = setup();
    const buttons = ['first', 'left', 'right', 'last'].map(action => ({dataset: {reviewScroll: action}}));
    nodes.set('review-scroll', {scrollWidth: 1600, clientWidth: 800, scrollLeft: 0,
      getBoundingClientRect: () => ({left: 236})});
    nodes.set('review-scroll-dock', {style: {}, querySelectorAll: () => buttons, getBoundingClientRect: () => ({height: 44})});
    nodes.set('review-scroll-range', {});
    run('reviewScrollDock()');
    assert.equal(nodes.get('review-scroll-range').max, 800);
    assert.deepEqual(buttons.map(button => button.disabled), [true, true, false, false]);
    nodes.get('review-scroll').scrollLeft = 800;
    run('reviewScrollDock()');
    assert.equal(nodes.get('review-scroll-range').value, 800);
    assert.deepEqual(buttons.map(button => button.disabled), [false, false, true, true]);
  }
  {
    const {run} = setup();
    run(`reviewSheet.rows = [
      {cells: {'2026-10-26': {text: '农业', kind: 'theme'}}},
      {cells: {'2026-10-26': {text: '农业', kind: 'theme'}}},
      {cells: {'2026-10-26': {text: '金融', kind: 'theme'}}},
      {cells: {'2026-10-26': {text: '股票', kind: 'stock'}}},
      {cells: {'2026-10-26': {text: '科技', kind: 'theme'}}},
      {cells: {}},
      {cells: {'2026-10-26': {text: '医药', kind: 'theme'}}},
    ]`);
    assert.equal(run('JSON.stringify(reviewThemeBreaks())'), '[2,4]', 'Separate different themes once, and reuse existing blank rows');
    assert.equal(run('reviewSheet.rows.length'), 7, 'Visual separators must not create stock records');
    const agriculture = run('reviewThemeColor("农业")');
    assert.equal(run('reviewThemeColor("农业")'), agriculture);
    assert.notEqual(run('reviewThemeColor("金融")'), agriculture);
    assert.match(run('reviewStyle({text: "农业", kind: "theme"})'), /background-color:hsl\(/);
    assert.match(run('reviewStyle({text: "农业", kind: "theme"}, true)'), /background-color:#7e22a8/);
    assert.match(run('reviewStyle({text: "2板", background: "#dc2626"})'), /background-color:#dc2626/);
    assert.match(run('reviewStyle({text: "2板", background: "#DC2626"})'), /color:#ffffff/);
    assert.match(run('reviewStyle({text: "+3%", background: "#fee2e2"})'), /background-color:#efb7b2/);
    assert.match(run('reviewStyle({text: "-3%", background: "#dcfce7"})'), /background-color:#b8d8c4/);
    assert.match(run('reviewStyle({text: "+3%", background: "#f6dedb"})'), /background-color:#efb7b2/);
    assert.match(run('reviewStyle({text: "-3%", background: "#dcebe3"})'), /background-color:#b8d8c4/);
    assert.match(run('reviewStyle({text: "-3%", background: "#237b3b", highlight: true})'), /background-color:#237b3b;color:#fff176/);
    assert.match(run('reviewStyle({text: "2板", background: "#7e22a8"}, false, "农业")'), /background-color:#7e22a8/,
      'Legacy purple market cells must not be mistaken for theme labels');
  }
  {
    const {context, nodes, run} = setup();
    let release;
    context.api = () => new Promise(resolve => { release = resolve; });
    const loading = run('reviewLoad(true)');
    run('reviewEditor = {node: {value: "尚未确认的新输入"}}');
    release({revision: 2, dates: [], hidden_dates: [], rows: []});
    await loading;
    assert.equal(run('reviewSheet.revision'), 1, 'A delayed read must preserve the current sheet during a new edit');
    assert.equal(run('reviewEditor.node.value'), '尚未确认的新输入');
    assert.match(nodes.get('review-notice').textContent, /保留当前内容/);
  }
  {
    const {context, timers, run} = setup();
    let release, requests = 0;
    context.api = () => {
      requests++;
      return requests === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve({revision: 3});
    };
    run('reviewDirty = true; reviewSequence = 1');
    const saving = run('reviewSave()');
    run('reviewSequence++; reviewEditor = {node: {value: "仍在编辑"}}');
    release({revision: 2});
    await saving;
    await timers.at(-1)();
    assert.equal(requests, 2, 'Changes committed during a save are saved on retry');
    assert.equal(run('finishCalls'), 0, 'Automatic save and retry must not submit a pending editor');
    assert.equal(run('reviewEditor.node.value'), '仍在编辑');
    run('reviewDirty = true');
    await run('reviewSave(true)');
    assert.equal(run('finishCalls'), 1, 'Explicit Save must submit the pending editor');
    run('reviewFinishEdit = () => false; reviewDirty = true');
    await run('reviewSave(true)');
    assert.equal(requests, 3, 'Invalid pending input must block explicit Save');
  }
  {
    const {context, nodes, run} = setup();
    let rejectSave;
    context.api = () => new Promise((resolve, reject) => { rejectSave = reject; });
    run('$("review-collect-date").value = "2026-10-26"; reviewDirty = true');
    const collecting = run('reviewCollect({preventDefault() {}})');
    assert.equal(nodes.get('review-controls').disabled, true, 'Collection must lock editing before awaiting the first save');
    assert.equal(nodes.get('review-grid').inert, true);
    assert.equal(run('reviewCollecting'), true);
    rejectSave(new Error('保存暂时失败'));
    await collecting;
    assert.equal(nodes.get('review-controls').disabled, false, 'A failed save must restore editing');
    assert.equal(nodes.get('review-grid').inert, false);
    assert.equal(run('reviewDirty'), true, 'A failed save must retain the local draft');
    assert.equal(run('reviewSheet.revision'), 1);
  }
  console.log('Review checks passed: theme positions/drag/drop/undo, market labels, scroll dock and save races.');
})().catch(error => { console.error(error); process.exitCode = 1; });
