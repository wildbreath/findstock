// node tests/test_ladder_themes_frontend.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const elements = new Map(), requests = [], alerts = [], timers = [];
const $ = id => {
  if (!elements.has(id)) elements.set(id, {value: '', textContent: '', disabled: false, focus() {}, setAttribute() {}});
  return elements.get(id);
};
const baseStatus = {configured: false, running: false, total_days: 248, completed_days: 0,
  pending_days: 248, calls_today: 0, daily_limit: 50, message: '', error: null};
let status = {...baseStatus}, failure = false;
const context = vm.createContext({$, console, Map, Set, Date, boot() {},
  escapeHtml: value => String(value).replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  showAlert: (kind, message) => alerts.push({kind, message}),
  setTimeout(callback) { timers.push(callback); return timers.length; }, clearTimeout() {},
  api: async (path, options) => {
    requests.push({path, options});
    if (failure) throw new Error('请求失败 <重试>');
    if (path.endsWith('/config')) status = {...status, configured: true};
    if (path.endsWith('/sync')) status = {...status, running: true, calls_today: 1};
    return {...status};
  },
});
const evaluate = code => vm.runInContext(code, context);
evaluate(fs.readFileSync('web/ladder.js', 'utf8'));
(async () => {
  await evaluate('loadLadderThemeStatus()');
  assert.deepEqual(requests.map(item => item.path), ['/api/stock-ladder/themes/status']);
  assert.equal($('ladder-theme-download').disabled, true);
  assert.ok($('ladder-theme-download-status').textContent.includes('尚未配置'));
  assert.ok($('ladder-theme-download-status').textContent.includes('本机今日已调用 0/50 次'));
  await evaluate('downloadLadderThemes()');
  assert.equal(requests.length, 1, 'An unconfigured page never calls the paid endpoint');

  $('ladder-theme-key').value = 'test-secret';
  context.event = {preventDefault() {}};
  await evaluate('saveLadderThemeConfig(event)');
  const saved = requests.at(-1);
  assert.equal(saved.path, '/api/stock-ladder/themes/config');
  assert.equal(saved.options.method, 'POST');
  assert.equal(JSON.parse(saved.options.body).api_key, 'test-secret');
  assert.equal($('ladder-theme-key').value, '', 'The secret is cleared after saving');
  assert.ok(!$('ladder-theme-download-status').textContent.includes('test-secret'));
  assert.equal($('ladder-theme-download').disabled, false);
  status = {...status, download_allowed: false, download_block_reason: '悟道仅在15:30后下载'};
  await evaluate('loadLadderThemeStatus()');
  assert.equal($('ladder-theme-download').disabled, true);
  assert.ok($('ladder-theme-download-status').textContent.includes('悟道仅在15:30后下载'));
  const beforeBlocked = requests.length;
  await evaluate('downloadLadderThemes()');
  assert.equal(requests.length, beforeBlocked, 'An intraday block must prevent the POST, including direct handler calls');
  assert.ok(alerts.at(-1).message.includes('15:30'));
  status = {...status, download_allowed: true, download_block_reason: null};
  await evaluate('loadLadderThemeStatus()');
  assert.equal($('ladder-theme-download').disabled, false);
  $('ladder-theme-budget').value = '0';
  const beforeInvalid = requests.length;
  await evaluate('downloadLadderThemes()');
  assert.equal(requests.length, beforeInvalid);
  assert.ok(alerts.at(-1).message.includes('1 至 50'));

  evaluate("ladderCache.set('2026-10-23', {items: []}); ladderDays = [{trade_date: '2026-10-23', snapshot: {items: []}, error: 'old'}]");
  evaluate('ladderBusy = true');
  await evaluate('reloadLadderLocalThemes()');
  assert.equal(evaluate('ladderThemeReloadPending'), true);
  assert.equal(evaluate('ladderCache.size'), 1, 'An in-flight ladder response must finish before cache invalidation');
  evaluate('ladderBusy = false');
  let localReloads = 0, candidateReloads = 0;
  context.localReload = () => { localReloads++; };
  context.candidateReload = () => { candidateReloads++; };
  evaluate('loadLadderViewport = async () => localReload(); loadLadderThemeCandidates = async () => candidateReload()');
  $('ladder-theme-budget').value = '7';
  await evaluate('downloadLadderThemes()');
  assert.equal(requests.at(-1).path, '/api/stock-ladder/themes/sync');
  assert.equal(JSON.parse(requests.at(-1).options.body).max_calls, 7);
  assert.equal($('ladder-theme-download').disabled, true);
  assert.equal($('ladder-theme-save').disabled, true);
  assert.equal(timers.length, 1);
  const pending = requests.length;
  await evaluate('downloadLadderThemes()');
  assert.equal(requests.length, pending, 'Repeated clicks cannot start another task');
  status = {...status, running: false, completed_days: 3, pending_days: 245};
  await timers[0]();
  assert.equal(localReloads, 1);
  assert.equal(candidateReloads, 1);
  assert.equal(evaluate('ladderCache.size'), 0);
  assert.equal(evaluate('ladderDays[0].snapshot'), null);
  assert.equal(evaluate('ladderDays[0].error'), '');
  assert.equal(requests.filter(item => item.path.endsWith('/sync')).length, 1);
  assert.equal($('ladder-theme-download').disabled, false);

  status = {...status, calls_today: 50, error: '今日额度已用完'};
  await evaluate('loadLadderThemeStatus()');
  assert.equal($('ladder-theme-download').disabled, true);
  assert.ok($('ladder-theme-download-status').textContent.includes('今日额度已用完'));
  failure = true;
  await evaluate('loadLadderThemeStatus()');
  assert.ok($('ladder-theme-download-status').textContent.includes('检查进度'));
  assert.equal(requests.filter(item => item.path.endsWith('/sync')).length, 1);
  console.log('Ladder local theme configuration, budget and download checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
