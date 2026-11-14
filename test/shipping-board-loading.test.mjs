import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/shipping-board.js', import.meta.url), 'utf8');
const setupEnd = source.indexOf("$('previous-month').addEventListener(");
assert.ok(setupEnd > 0);
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness(apiStub) {
  const rendered = [], calendars = [], notifications = [];
  const context = vm.createContext({ console, URLSearchParams, apiStub, rendered, calendars, notifications });
  vm.runInContext(source.slice(0, setupEnd), context);
  vm.runInContext(`
    selectedDate = '2026-11-14'; calendarMonth = '2026-11';
    boardData = { date: '2026-11-13', selectedBatchId: null };
    api = apiStub;
    setBusy = value => { busy = value; };
    renderBoard = data => { boardData = data; selectedBatchId = data.selectedBatchId; rendered.push(data); };
    renderCalendar = () => calendars.push({ month: calendarMonth, data: calendarData });
    message = (text, error = false) => { messages[mode] = { text, error }; notifications.push({ mode, text, error }); };
  `, context);
  return { rendered, calendars, notifications, run: code => vm.runInContext(code, context),
    state: () => JSON.parse(JSON.stringify(vm.runInContext('({ busy, selectedDate, selectedBatchId, calendarMonth, calendarData, boardData, messages })', context))) };
}
const boardFor = route => { const query = new URL(route, 'http://test').searchParams;
  return { date: query.get('date'), selectedBatchId: query.has('batchId') ? Number(query.get('batchId')) : null }; };

test('목록 응답을 표시하기 전에는 달력 API를 시작하지 않는다', async () => {
  const board = deferred(), calendar = deferred(), requests = [];
  const h = harness(route => { requests.push(route); return route.includes('/dates?') ? calendar.promise : board.promise; });
  const loading = h.run('loadBoard({ reloadCalendar: true })');
  try {
    await settle();
    assert.equal(requests.filter(route => route.includes('/dates?')).length, 0, '목록 처리 중에 달력 계산을 시작하면 안 된다.');
    board.resolve({ date: '2026-11-14', selectedBatchId: null }); await loading;
    assert.equal(h.rendered.length, 1);
    assert.equal(h.state().busy, false);
    assert.equal(requests.filter(route => route.includes('/dates?')).length, 1);
  } finally {
    board.resolve({ date: '2026-11-14', selectedBatchId: null }); calendar.resolve({ days: [] });
    await loading; await settle();
  }
});

test('달력 응답을 기다리지 않고 목록을 표시하며 작업 선택과 같은 월 요청 공유가 가능하다', async () => {
  const calendar = deferred(), requests = [];
  const h = harness(route => { requests.push(route); return route.includes('/dates?') ? calendar.promise : Promise.resolve(boardFor(route)); });
  const first = h.run('loadBoard({ reloadCalendar: true })');
  try {
    await settle();
    assert.equal(h.rendered.length, 1, '본문 목록을 달력보다 먼저 표시해야 한다.');
    assert.equal(h.state().busy, false);
    h.run('selectBatch(7)'); await settle();
    assert.equal(h.rendered.at(-1).selectedBatchId, 7, '달력 조회 중에도 작업 선택이 가능해야 한다.');
    const refresh = h.run('loadBoard({ reloadCalendar: true })'); await settle();
    assert.equal(requests.filter(route => route.includes('/dates?')).length, 1, '같은 월의 진행 중 요청을 공유해야 한다.');
    calendar.resolve({ days: [] }); await refresh; await settle();
  } finally { calendar.resolve({ days: [] }); await first; }
});

test('달력이 늦어도 월 이동을 막지 않고 이전 월 응답으로 현재 달력을 덮어쓰지 않는다', async () => {
  const november = deferred(), december = deferred(), requested = [];
  const h = harness(route => { const month = new URL(route, 'http://test').searchParams.get('month'); requested.push(month);
    return month === '2026-12' ? december.promise : november.promise; });
  const next = h.run('changeMonth(1)');
  const back = h.run('changeMonth(-1)');
  const nextAgain = h.run('changeMonth(1)');
  try {
    assert.equal(h.state().busy, false);
    assert.equal(h.state().calendarMonth, '2026-12');
    assert.deepEqual(requested, ['2026-12', '2026-11']);
    december.resolve({ days: [], source: 'december' }); await settle();
    november.resolve({ days: [], source: 'november' }); await Promise.all([next, back, nextAgain]); await settle();
    assert.equal(h.state().calendarMonth, '2026-12');
    assert.equal(h.state().calendarData.source, 'december');
    assert.ok(h.calendars.every(calendar => calendar.data.source !== 'november'));
  } finally { november.resolve({ days: [] }); december.resolve({ days: [] }); await Promise.all([next, back, nextAgain]); }
});

test('달력 갱신 실패는 이미 표시한 본문과 선택한 날짜를 되돌리지 않는다', async () => {
  const calendar = deferred();
  const h = harness(route => route.includes('/dates?') ? calendar.promise : Promise.resolve(boardFor(route)));
  const loading = h.run('loadBoard({ reloadCalendar: true })');
  calendar.reject(new Error('calendar unavailable')); await loading; await settle();
  assert.equal(h.rendered.length, 1);
  assert.equal(h.state().boardData.date, '2026-11-14');
  assert.equal(h.state().selectedDate, '2026-11-14');
  assert.equal(h.state().busy, false);
  assert.match(h.notifications.at(-1).text, /달력.*갱신.*실패/);
});

test('신규 주문 모드로 바뀐 뒤 늦게 실패한 달력은 현재 상태 문구를 덮어쓰지 않는다', async () => {
  const calendar = deferred();
  const h = harness(route => route.includes('/dates?') ? calendar.promise : Promise.resolve(boardFor(route)));
  const loading = h.run('loadBoard({ reloadCalendar: true })'); await settle();
  h.run("mode = 'new'; message('신규 조회 완료');");
  calendar.reject(new Error('calendar unavailable')); await loading; await settle();
  assert.equal(h.notifications.at(-1).mode, 'new');
  assert.equal(h.notifications.at(-1).text, '신규 조회 완료');
  assert.equal(h.state().messages.new.text, '신규 조회 완료');
});
