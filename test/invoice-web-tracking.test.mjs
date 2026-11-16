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
    document: { getElementById: getNode, createElement: tag => new Node(tag), createDocumentFragment: () => new Node('fragment'), querySelectorAll: () => [] },
    window: { location: { search: '' }, addEventListener() {}, confirm: text => { confirms.push(text); return true; } },
    Option: class extends Node { constructor(text, value) { super('option'); this.textContent = text; this.value = value; } },
    fetch: () => new Promise(() => {}), fixture: initial,
    mockApi: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return initial; },
  });
  vm.runInContext(source, context);
  vm.runInContext(`const renderItemsForTest = renderItems, renderOutsideTargetForTest = renderOutsideTarget;
    current = fixture; busy = false;
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

const assignmentGroups = () => [1, 2].map(id => reviewGroup({ key: `product-${id}`, kind: 'assignment', assignEligible: true,
  itemIds: [id], productOrderIds: [`mock-product-${id}`], replacementEligible: false, replaceEligible: false, splitEligible: false,
  candidates: [{ internalId: 'shipment-13cm', trackingNumber: '001234567001', valid: true },
    { internalId: 'shipment-15cm', trackingNumber: '001234567002', valid: true }] }));
const descendants = node => [node, ...node.children.flatMap(descendants)];

test('같은 네이버 주문의 분리 배송은 상품주문마다 다른 송장을 선택하고 함께 저장한다', async () => {
  const h = harness(detail({ trackingReview: { groups: assignmentGroups(), pendingCount: 2 } }));
  for (const [index, trackingNumber] of ['001234567001', '001234567002'].entries()) {
    const controls = h.run(`trackingChoices({recipient:'모의 수취인',trackingNumbers:[]},[current.items[${index}]])`);
    const selects = descendants(controls).filter(node => node.tagName === 'select');
    assert.equal(selects.length, 1, '개별 출고 연결에는 교체·분할 방식을 다시 묻지 않습니다.');
    selects[0].value = trackingNumber; selects[0].listeners.get('change')();
  }
  assert.equal(h.run("trackingChanges.get('product-1').trackingNumber"), '001234567001');
  assert.equal(h.run("trackingChanges.get('product-2').trackingNumber"), '001234567002');
  await h.run('saveReview()');
  assert.deepEqual(h.calls, [{ url: '/api/invoices/8/tracking', body: { expectedVersion: 'version-1', choices: [
    { key: 'product-1', trackingNumber: '001234567001', mode: 'assign' },
    { key: 'product-2', trackingNumber: '001234567002', mode: 'assign' },
  ] } }]);
});

test('안전하게 연결할 수 없는 분리 배송은 선택을 막는다', () => {
  const group = assignmentGroups()[0]; group.assignEligible = false;
  const h = harness(detail({ trackingReview: { groups: [group], pendingCount: 1 } }));
  const controls = h.run("trackingChoices({recipient:'모의 수취인',trackingNumbers:[]},[current.items[0]])");
  const selects = descendants(controls).filter(node => node.tagName === 'select');
  assert.equal(selects.length, 1); assert.equal(selects[0].disabled, true);
});

test('저장한 분리 배송 송장은 정정할 수 있고 선택을 비우면 처리 방식도 해제한다', () => {
  const group = assignmentGroups()[0]; Object.assign(group, { selectedTrackingNumber: '001234567001', mode: 'assign', needsSelection: false });
  const h = harness(detail({ trackingReview: { groups: [group], pendingCount: 0 } }));
  const controls = h.run("trackingChoices({recipient:'모의 수취인',trackingNumbers:['001234567001']},[current.items[0]])");
  const selects = descendants(controls).filter(node => node.tagName === 'select');
  assert.equal(selects.length, 1); assert.equal(selects[0].value, '001234567001');
  selects[0].value = ''; selects[0].listeners.get('change')();
  assert.equal(h.run("trackingChanges.get('product-1').mode"), '');
});

test('네이버 등록 후에도 정정 가능한 분리 배송 송장을 웹에서 다시 선택해 저장한다', async () => {
  for (const state of ['complete', 'conflict']) {
    const group = assignmentGroups()[0]; Object.assign(group, { selectedTrackingNumber: '001234567001', mode: 'assign', needsSelection: false });
    const initial = detail({ trackingReview: { groups: [group], pendingCount: 0 } });
    initial.items[0].registrationState = state; initial.items[0].sourceRegistered = state === 'complete';
    const h = harness(initial);
    const controls = h.run("trackingChoices({recipient:'모의 수취인',trackingNumbers:['001234567001']},[current.items[0]])");
    const select = descendants(controls).find(node => node.tagName === 'select');
    assert.ok(select); assert.equal(select.disabled, false);
    select.value = '001234567002'; select.listeners.get('change')();
    await h.run('saveReview()');
    assert.deepEqual(h.calls[0].body.choices, [{ key: group.key, trackingNumber: '001234567002', mode: 'assign' }]);
  }
});

test('하나의 내부 출고를 재출력한 경우는 두 상품행의 선택을 계속 연동한다', () => {
  const h = harness();
  const first = h.run("trackingChoices({recipient:'모의 수취인',trackingNumbers:[]},[current.items[0]])");
  const selects = descendants(first).filter(node => node.tagName === 'select');
  assert.equal(selects.length, 2);
  selects[0].value = '001234567002'; selects[0].listeners.get('change')();
  const second = h.run("trackingChoices({recipient:'모의 수취인',trackingNumbers:[]},[current.items[1]])");
  assert.equal(descendants(second).find(node => node.tagName === 'select').value, '001234567002');
  assert.equal(h.run('trackingChanges.size'), 1);
});

test('분리 배송 상품행은 원래 작업의 일반 주문과 함께 표시하고 송장은 독립 선택한다', () => {
  const origin = { batchId: 14, batchCreatedAt: '2026-11-14T03:43:38Z', sourceFile: '토요일 주문.xls', sourceSheet: '주문' };
  const orders = [{ key: 'saved-3', rowId: 3, batchId: 14, sourceType: 'saved', itemIds: [3],
    cleanedName: '일반 쿠션', trackingNumbers: ['001234567003'], state: 'ready', issues: [], source: { ...origin, sourceRow: 21 } },
  ...[1, 2].map(id => ({ key: `product-${id}`, rowId: null, batchId: 14, sourceType: 'saved_product', itemIds: [id],
    recipient: '모의 수취인', cleanedName: '쿠션 High(13cm)', optionName: id === 1 ? '높이 13cm' : '높이 15cm',
    trackingNumbers: [], state: 'hold', issues: [], source: { ...origin, sourceRow: 21 + id } }))];
  const initial = detail({ orders, batches: [{ id: 14, name: origin.sourceFile, createdAt: origin.batchCreatedAt }],
    trackingReview: { groups: assignmentGroups(), pendingCount: 2 } });
  initial.items.forEach((item, index) => { item.sourceRows = [{ ...origin, rowId: 22 + index, sourceRow: 22 + index }]; });
  initial.items.push({ id: 3, productOrderId: 'mock-product-3', decision: 'include', issues: [], blockingIssueKeys: [] });
  const h = harness(initial);
  h.run("renderOutsideTarget = () => {}; renderUnmatched = () => {}; $('item-filter').value = 'all'; renderItemsForTest();");
  const rendered = descendants(h.nodes.get('item-rows'));
  const headings = rendered.filter(node => node.className === 'order-group-header');
  assert.equal(headings.length, 1, '네이버 파일 별도 그룹 대신 원래 작업 그룹에 함께 표시합니다.');
  const headingText = descendants(headings[0]).map(node => node.textContent || '').join(' ');
  assert.match(headingText, /작업 11\. 14\./); assert.match(headingText, /토요일 주문\.xls/);
  assert.doesNotMatch(headingText, /네이버 주문파일/);
  const optionTexts = rendered.map(node => node.textContent || '').filter(value => value.startsWith('선택 옵션:'));
  assert.deepEqual(optionTexts, ['선택 옵션: 높이 13cm', '선택 옵션: 높이 15cm']);
  const productRows = rendered.filter(node => node.tagName === 'tr' && node.children[0]?.tagName === 'td');
  assert.equal(productRows.length, 3);
  for (const [index, row] of productRows.slice(1).entries()) {
    const select = descendants(row.children[2]).find(node => node.tagName === 'select');
    assert.ok(select); select.value = `00123456700${index + 1}`; select.listeners.get('change')();
  }
  assert.equal(h.run("trackingChanges.get('product-1').trackingNumber"), '001234567001');
  assert.equal(h.run("trackingChanges.get('product-2').trackingNumber"), '001234567002');
  h.run(`previewOrders = current.items.flatMap(item => item.sourceRows || []).map(source => ({ rowId: source.rowId, source }));
    renderOutsideTargetForTest();`);
  assert.equal(h.nodes.get('outside-target-count').textContent, '0행', '주문표에 연결한 원본행은 파일 밖 주문으로 중복 표시하지 않습니다.');
});

test('원본 작업이 없는 네이버 단독행은 기존 네이버 파일 그룹을 유지한다', () => {
  const h = harness(detail({ orders: [{ key: 'naver-only', sourceType: 'naver_only', batchId: null, itemIds: [1],
    source: { sourceFile: '네이버.xlsx' }, trackingNumbers: [], optionName: '높이 15cm' }] }));
  const groups = h.run('orderGroups(displayedOrders())');
  assert.equal(groups.length, 1); assert.equal(groups[0].sourceType, 'naver_only');
  const heading = h.run('groupHeading(orderGroups(displayedOrders())[0], 5)');
  assert.ok(descendants(heading).some(node => node.textContent === '① 네이버 주문파일'));
});

function registrationView(item, changes = {}) {
  const order = { key: 'product-1', rowId: null, batchId: 14, sourceType: 'saved_product', itemIds: [item.id],
    cleanedName: '검증 쿠션', trackingNumbers: [item.trackingNumber], state: 'ready', issues: [], source: {}, ...changes };
  const h = harness(detail({ items: [item], orders: [order], trackingReview: { groups: [], pendingCount: 0 } }));
  h.run("renderOutsideTarget = () => {}; renderUnmatched = () => {}; $('item-filter').value = 'all'; renderItemsForTest();");
  const row = descendants(h.nodes.get('item-rows')).find(node => node.tagName === 'tr' && node.children[0]?.tagName === 'td');
  return descendants(row.children[4]).map(node => node.textContent || '').filter(Boolean);
}

test('등록 상태에서 system0 적용 번호와 네이버 조회 번호를 비교하고 미조회·이전 조회를 구분한다', () => {
  const item = { id: 1, productOrderId: 'mock-product-1', trackingNumber: '45500000001', decision: 'include',
    registrationState: 'unchecked', issues: [], blockingIssueKeys: [] };
  const remote = { trackingNumber: '45500000002', carrierCode: 'KGB', status: 'DELIVERING', checkedAt: '2026-11-16T03:24:00Z', fresh: true, matches: false };
  const mismatch = registrationView({ ...item, naverRegistration: remote });
  assert.ok(mismatch.includes('system0: 45500000001')); assert.ok(mismatch.includes('네이버: 45500000002'));
  assert.ok(mismatch.includes('송장 다름'));
  const same = registrationView({ ...item, naverRegistration: { ...remote, trackingNumber: item.trackingNumber, matches: true } });
  assert.ok(same.includes('송장 일치')); assert.ok(!same.includes('송장 다름'));
  const wrongCarrier = registrationView({ ...item, naverRegistration: { ...remote, trackingNumber: item.trackingNumber, carrierCode: 'OTHER' } });
  assert.ok(wrongCarrier.includes('택배사 다름')); assert.ok(!wrongCarrier.includes('송장 다름'));
  const unchecked = registrationView({ ...item, naverRegistration: null });
  assert.deepEqual(unchecked, ['등록 미조회']);
  const stale = registrationView({ ...item, naverRegistration: { ...remote, fresh: false, matches: null } });
  assert.ok(stale.some(value => value.startsWith('이전 조회')));
  assert.ok(stale.includes('네이버: 45500000002')); assert.ok(!stale.some(value => ['송장 일치', '송장 다름'].includes(value)));
  const missing = registrationView({ ...item, naverRegistration: { ...remote, trackingNumber: '', matches: null } });
  assert.ok(missing.includes('네이버: 미등록')); assert.ok(!missing.includes('송장 다름'));
});

test('이전 날짜의 조회 전용 행에서도 최신 상품주문별 적용 송장과 네이버 번호를 비교한다', () => {
  const remote = { trackingNumber: '45500000004', carrierCode: 'KGB', status: 'DELIVERING', checkedAt: '2026-11-16T03:24:00Z', fresh: true, matches: false };
  const text = registrationView({ id: 1, productOrderId: 'old-product', trackingNumber: '45500000000',
    decision: 'include', issues: [], naverRegistration: null }, { latestStatus: { readonly: true, registrationState: 'conflict', products: [
      { productOrderId: 'latest-product-1', appliedTrackingNumber: '45500000003', naverRegistration: remote },
      { productOrderId: 'latest-product-2', appliedTrackingNumber: '45500000005', naverRegistration: { ...remote, trackingNumber: '45500000005', matches: true } },
    ] } });
  for (const value of ['latest-product-1', 'latest-product-2', 'system0: 45500000003', '네이버: 45500000004',
    'system0: 45500000005', '네이버: 45500000005', '송장 다름', '송장 일치']) assert.ok(text.includes(value), value);
  assert.ok(!text.includes('system0: 45500000000'), '과거 행에 남은 적용 번호를 최신 비교에 사용하지 않습니다.');
});
