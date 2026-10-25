// node tests/test_ladder_local_frontend.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const controls = new Map();
const context = vm.createContext({Date, Map, Set, console, boot() {},
  document: {hidden: false},
  $(id) { if (!controls.has(id)) controls.set(id, {checked: true}); return controls.get(id); },
});
const evaluate = source => vm.runInContext(source, context);
evaluate(fs.readFileSync('web/ladder.js', 'utf8'));
for (const [stamp, allowed] of [
  ['2026-10-23T01:14:59Z', false], ['2026-10-23T01:15:00Z', true],
  ['2026-10-23T03:29:59Z', true], ['2026-10-23T03:30:00Z', false],
  ['2026-10-23T04:59:59Z', false], ['2026-10-23T05:00:00Z', true],
  ['2026-10-23T06:59:59Z', true], ['2026-10-23T07:00:00Z', false],
  ['2026-10-24T01:30:00Z', false],
]) assert.equal(evaluate(`ladderRealtimeAllowed(new Date('${stamp}'))`), allowed, stamp);
assert.equal(evaluate("ladderMissingTheme('2026-10-23', new Date('2026-10-23T07:29:59Z'))"), '题材待收盘下载');
assert.equal(evaluate("ladderMissingTheme('2026-10-23', new Date('2026-10-23T07:30:00Z'))"), '题材未获取');
assert.equal(evaluate("ladderMissingTheme('2026-10-22', new Date('2026-10-23T01:30:00Z'))"), '题材未获取');
let allowed = false, currentDays = [{trade_date: '2026-10-23'}], fetched = [], candidates = 0;
context.allowed = () => allowed;
context.currentDays = () => currentDays;
context.fetchDay = async (day, refresh) => { fetched.push({day, refresh}); return {items: []}; };
context.candidates = () => { candidates++; };
evaluate("ladderMarketDate = () => '2026-10-23'; ladderRealtimeAllowed = () => allowed(); ladderViewportDays = () => currentDays(); " +
  'fetchLadderDay = fetchDay; loadLadderThemeCandidates = async () => candidates(); ladderDateButtons = () => {}; renderLadder = () => {}');
(async () => {
  await evaluate('refreshLadderCurrent()');
  assert.equal(fetched.length, 0, 'After close or during lunch there is no automatic refresh');
  allowed = true;
  currentDays = [{trade_date: '2026-10-22'}];
  await evaluate('refreshLadderCurrent()');
  assert.equal(fetched.length, 0, 'History stays local even during the current trading session');
  currentDays = [{trade_date: '2026-10-23', error: 'old'}];
  await evaluate('refreshLadderCurrent()');
  assert.deepEqual(fetched, [{day: '2026-10-23', refresh: true}]);
  assert.equal(candidates, 1);
  assert.equal(currentDays[0].error, '');
  context.document.hidden = true;
  await evaluate('refreshLadderCurrent()');
  assert.equal(fetched.length, 1);
  context.document.hidden = false;
  controls.get('ladder-auto').checked = false;
  await evaluate('refreshLadderCurrent()');
  assert.equal(fetched.length, 1);
  const html = fs.readFileSync('web/ladder.html', 'utf8');
  assert.ok(html.includes('刷新本地数据'));
  assert.ok(html.includes('15:30'));
  assert.ok(!html.includes('会联网更新当前可见日期'));
  assert.ok(!html.includes('盘中悟道快照'));
  console.log('Ladder local browsing and intraday refresh boundaries passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
