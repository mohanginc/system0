import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/invoices.js', import.meta.url), 'utf8');
class Node {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.dataset = {}; this.files = []; this.value = '';
    this.classList = { toggle() {}, add() {}, remove() {}, contains() { return false; } };
    this.listeners = new Map();
  }
  append(...nodes) { this.children.push(...nodes); }
  add(option) { this.children.push(option); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute() {}
  addEventListener(type, callback) { this.listeners.set(type, callback); }
}
const reviewGroup = (changes = {}) => ({ key: 'shipment-1', internalId: 'mock-internal-1', orderId: 'mock-order-1', recipient: '모의 수취인',
  itemIds: [1, 2], productOrderIds: ['mock-product-1', 'mock-product-2'],
  candidates: [{ trackingNumber: '001234567001', round: '1', valid: true, currentFile: false },
    { trackingNumber: '001234567002', round: '2', valid: true, currentFile: true }],
  selectedTrackingNumber: '', mode: null, needsSelection: true, replacementTrackingNumber: '001234567002', replacementEligible: true, ...changes });
const detail = (changes = {}) => ({ run: { id: 8, matchingVersion: 'mock-version', generatedAt: null, savedFileAvailable: false }, viewVersion: 'version-1',
  items: [1, 2].map(id => ({ id, decision: 'include', note: '', registrationState: 'unchecked', blockingIssueKeys: [] })),
  orders: [], issues: [], trackingReview: { groups: [reviewGroup()], pendingCount: 1, replacementCount: 1 }, ...changes });
function harness(initial = detail()) {
  const nodes = new Map(), calls = [], confirms = [];
  const getNode = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  const context = vm.createContext({ console, URL, URLSearchParams, AbortSignal, setTimeout, clearTimeout,
    document: { getElementById: getNode, createElement: tag => new Node(tag), querySelectorAll: () => [] },
    window: { location: { search: '' }, addEventListener() {}, confirm: text => { confirms.push(text); return true; } },
    Option: class extends Node { constructor(text, value) { super('option'); this.textContent = text; this.value = value; } },
    fetch: () => new Promise(() => {}), fixture: initial,
    mockApi: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return initial; },
  });
  vm.runInContext(source, context);
  vm.runInContext(`current = fixture; busy = false;
    api = (...args) => mockApi(...args);
    renderItems = () => {}; renderIssues = () => {}; loadHistory = async () => {};
    showRun = data => { current = data; itemChanges.clear(); issueChanges.clear(); trackingChanges.clear(); };`, context);
  return { context, calls, nodes, confirms, run: code => vm.runInContext(code, context),
    plain: code => JSON.parse(JSON.stringify(vm.runInContext(code, context))) };
}

test('화면의 송장 선택은 교체·분할 모드를 구분해 새 업무 API로 저장한다', async () => {
  for (const mode of ['replace', 'split']) {
    const h = harness();
    h.run(`saveTrackingDraft(current.trackingReview.groups[0], { trackingNumber: '001234567002', mode: '${mode}' });`);
    await h.run('saveReview()');
    assert.deepEqual(h.calls, [{ url: '/api/invoices/8/tracking', body: { expectedVersion: 'version-1',
      choices: [{ key: 'shipment-1', trackingNumber: '001234567002', mode }] } }]);
  }
});

test('처리 방식을 고르지 않은 송장은 저장하지 않고 선택 초안을 유지한다', async () => {
  const h = harness();
  h.run("saveTrackingDraft(current.trackingReview.groups[0], { trackingNumber: '001234567002' });");
  await h.run('saveReview()');
  assert.equal(h.calls.length, 0); assert.equal(h.run('trackingChanges.size'), 1);
  assert.match(h.nodes.get('message').textContent, /교체·분할/);
});

test('송장 선택이 남으면 새 파일 생성을 막고 정확한 남은 건수를 표시한다', () => {
  const h = harness(); h.run('refreshControls()');
  assert.equal(h.nodes.get('export-button').disabled, true);
  assert.equal(h.nodes.get('tracking-review-count').textContent, '송장 선택 남음 1건');
  assert.match(h.nodes.get('export-note').textContent, /송장 선택 1건/);
});

test('이번 파일 교체는 확인 후 교체 가능한 미결 그룹만 함께 적용한다', async () => {
  const eligible = reviewGroup(), blocked = reviewGroup({ key: 'blocked', replacementEligible: false }), done = reviewGroup({ key: 'done', needsSelection: false });
  const h = harness(detail({ trackingReview: { groups: [eligible, blocked, done], pendingCount: 2 } }));
  await h.run('replaceCurrentTracking()');
  assert.equal(h.confirms.length, 1); assert.match(h.confirms[0], /내부 출고 1건 · 상품주문 2건/);
  assert.deepEqual(h.calls[0].body.choices, [{ key: 'shipment-1', trackingNumber: '001234567002', mode: 'replace' }]);
  const cancelled = harness(); cancelled.context.window.confirm = () => false;
  await cancelled.run('replaceCurrentTracking()'); assert.equal(cancelled.calls.length, 0);
});

test('버전이 바뀌어 저장이 거절되면 송장 선택 초안을 지우지 않는다', async () => {
  const h = harness(); h.context.mockApi = async () => { throw new Error('최신 화면을 확인해 주세요.'); };
  h.run("saveTrackingDraft(current.trackingReview.groups[0], { trackingNumber: '001234567002', mode: 'replace' });");
  await h.run('saveReview()');
  assert.equal(h.run('trackingChanges.size'), 1); assert.equal(h.run('current.viewVersion'), 'version-1');
});

test('송장 저장 뒤 다른 검토 저장이 실패하면 남은 초안으로 재시도하고 송장은 중복 저장하지 않는다', async () => {
  const h = harness(), saved = detail({ viewVersion: 'version-2', trackingReview: { groups: [reviewGroup({ mode: 'replace', needsSelection: false,
    selectedTrackingNumber: '001234567002' })], pendingCount: 0 } });
  let failed = false;
  h.context.mockApi = async (url, options) => {
    h.calls.push({ url, body: JSON.parse(options.body) });
    if (url.endsWith('/items') && !failed) { failed = true; throw new Error('검토 저장 실패'); }
    return saved;
  };
  h.run("saveTrackingDraft(current.trackingReview.groups[0], { trackingNumber: '001234567002', mode: 'replace' }); saveItemDraft(current.items[0], {note: '가상 검토'});");
  await h.run('saveReview()');
  assert.equal(h.run('trackingChanges.size'), 0); assert.equal(h.run('itemChanges.size'), 1);
  assert.equal(h.run('current.viewVersion'), 'version-2'); assert.match(h.nodes.get('message').textContent, /송장 선택은 저장/);
  await h.run('saveReview()');
  assert.equal(h.calls.filter(call => call.url.endsWith('/tracking')).length, 1);
  assert.equal(h.run('itemChanges.size'), 0);
});

test('저장이 완료된 뒤 내역 목록 조회만 실패하면 저장된 초안을 되살리지 않는다', async () => {
  const h = harness();
  h.run("loadHistory = async () => { throw new Error('목록 조회 실패'); }; saveTrackingDraft(current.trackingReview.groups[0], {trackingNumber:'001234567002',mode:'replace'}); saveItemDraft(current.items[0],{note:'가상 검토'});");
  await h.run('saveReview()');
  assert.equal(h.run('isDirty()'), false);
});

test('과거 첨부의 송장으로 바꾸면 교체 모드를 그대로 적용하지 않고 처리 방식을 다시 고르게 한다', () => {
  const h = harness();
  h.run("saveTrackingDraft(current.trackingReview.groups[0],{trackingNumber:'001234567002',mode:'replace'}); saveTrackingDraft(current.trackingReview.groups[0],{trackingNumber:'001234567001'});");
  assert.equal(h.run("trackingChanges.get('shipment-1').mode"), '');
});

test('기존 파일이 있어도 새 송장 검토를 마쳤으면 현재 매칭 파일과 보관본을 구분한다', () => {
  const h = harness(detail({ run: { id: 8, generatedAt: '2026-11-13T00:00:00Z', savedFileAvailable: true },
    trackingReview: { groups: [reviewGroup({ mode: 'replace', needsSelection: false, selectedTrackingNumber: '001234567002' })], pendingCount: 0 } }));
  assert.equal(h.run('primaryDownloadMode()'), 'rebuild'); assert.equal(h.run('storedDownloadMode()'), 'saved');
});

test('송장 선택과 메모를 함께 저장할 때 선택 전의 보류 상태로 되돌리지 않는다', async () => {
  const initial = detail(); initial.items.forEach(item => { item.decision = 'hold'; });
  const h = harness(initial), saved = detail({ viewVersion: 'version-2', trackingReview: { groups: [reviewGroup({ mode: 'replace', needsSelection: false })], pendingCount: 0 } });
  h.context.mockApi = async (url, options) => { h.calls.push({ url, body: JSON.parse(options.body) }); return saved; };
  h.run("saveItemDraft(current.items[0],{note:'가상 메모'}); saveTrackingDraft(current.trackingReview.groups[0],{trackingNumber:'001234567002',mode:'replace'});");
  await h.run('saveReview()');
  assert.deepEqual(h.calls[1].body.changes, [{ id: 1, decision: 'include', note: '가상 메모' }]);
});

test('저장한 분할 대표 송장을 같은 화면에서 정정하고 무효 송장은 선택하지 못한다', async () => {
  const group = reviewGroup({ needsSelection: false, mode: 'split', selectedTrackingNumber: '001234567001', splitEligible: true, replaceEligible: true });
  group.candidates.push({ trackingNumber: '001234567000', valid: false, currentFile: false });
  const h = harness(detail({ trackingReview: { groups: [group], pendingCount: 0 } }));
  const controls = h.run("trackingChoices({recipient:'모의 수취인',trackingNumbers:['001234567001','001234567002']},current.items)");
  const descendants = node => [node, ...node.children.flatMap(descendants)];
  const selects = descendants(controls).filter(node => node.tagName === 'select');
  assert.equal(selects.length, 2, '안전한 분할 선택은 저장 후에도 정정할 수 있습니다.');
  assert.equal(selects[0].value, '001234567001'); assert.equal(selects[1].value, 'split');
  assert.equal(selects[0].children.find(option => option.value === '001234567000').disabled, true);
  selects[0].value = '001234567002'; selects[0].listeners.get('change')();
  await h.run('saveReview()');
  assert.deepEqual(h.calls[0].body.choices, [{ key: 'shipment-1', trackingNumber: '001234567002', mode: 'split' }]);
});
