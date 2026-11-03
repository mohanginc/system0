import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import officeCrypto from 'officecrypto-tool';

process.env.SYSTEM0_ENV_FILE = path.join(os.tmpdir(), `system0-invoices-absent-${randomUUID()}.env`);
process.env.OPENAI_API_KEY = '';
const { createApp } = await import('../server.mjs');

const productIds = ['202610210000000001', '202610210000000002'];
const orderId = '202610210000000099', internalId = '000001', tracking = '001234567890';
const recipient = '테스트 수취인', phone = '010-0000-0000', address = '서울 강남구 테스트로 1 101호';
function file(name, rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), '주문');
  return { name, buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) };
}
const legacy = () => file('레거시.xlsx', [['원상품명', '주문번호', '체결번호', '송화주', '전화번호', '주소', '수량', '쇼핑몰'],
  ['쿠션 + 커버', internalId, orderId, recipient, phone, address, 1, '네이버']]);
const naverFile = () => file('네이버.xlsx', [['상품주문번호', '주문번호', '수취인명', '수취인연락처1', '통합배송지', '상품명', '옵션정보', '수량', '주문상태', '택배사', '송장번호'],
  ...productIds.map((id, index) => [id, orderId, recipient, phone, address, index ? '커버' : '쿠션', '', 1, '발송대기', '', ''])]);
function courierFile(extra = false) {
  return file('택배사.xlsx', [['차수', '순번', '운송장번호', '주문번호', '원송장번호', '발행횟수', '출력시간'],
    [1, 1, tracking, internalId, '', 1, '17:00:00'], ...(extra ? [[1, 2, '009999999999', '없는출고', '', 1, '17:00:00']] : [])]);
}
const form = (files, field = 'files') => {
  const body = new FormData();
  for (const value of files) body.append(field, new Blob([value.buffer]), value.name);
  return body;
};
function invoiceForm(extra = false, batchIds = []) {
  const body = form([naverFile()], 'naverFiles');
  const courier = courierFile(extra);
  body.append('courierFiles', new Blob([courier.buffer]), courier.name);
  body.append('deliveryCompanyCode', 'KGB');
  body.append('batchIds', JSON.stringify(batchIds));
  return body;
}
const json = (method, value) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
const remote = (id, changes = {}) => ({ productOrderId: id, orderId, status: 'DELIVERING', placeOrderStatus: 'OK',
  remainQuantity: 1, trackingNumber: tracking, deliveryCompanyCode: 'KGB', deliveryMethod: 'DELIVERY',
  isWrongTrackingNumber: false, recipient, phone, address: '서울 강남구 테스트로 1', detailAddress: '101호', claimStatus: '', ...changes });

async function boot(t, naver = { queryProductOrders: async ids => ids.map(id => remote(id)) }) {
  const app = createApp({ databasePath: ':memory:', client: null, apiKey: '', naver });
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    app.locals.db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { app, base, request: (route, options) => fetch(base + route, options) };
}
async function addSource(request) {
  const response = await request('/api/import', { method: 'POST', body: form([legacy()]) });
  assert.equal(response.status, 201);
  return response.json();
}

test('송장 API는 다른 날짜의 같은 주문 근거도 연결하고 하단 미연결 송장은 검수 없이 합배송 엑셀을 내보낸다', async t => {
  const { app, request } = await boot(t);
  const a = await addSource(request), b = await addSource(request);
  app.locals.db.prepare('UPDATE batches SET created_at = ? WHERE id = ?').run('2020-01-01T00:00:00Z', a.batch.id);
  const sources = app.locals.db.prepare('SELECT count(*) AS n FROM source_files').get().n;
  const preview = await request(`/api/invoices/orders?batchIds=${encodeURIComponent(JSON.stringify([b.batch.id]))}`);
  assert.equal(preview.status, 200);
  const initial = await preview.json();
  assert.equal(initial.orders.length, 1);
  assert.equal(initial.orders[0].batchId, b.batch.id);
  assert.equal(app.locals.db.prepare('SELECT count(*) AS n FROM invoice_runs').get().n, 0, '파일 없이 주문 목록을 읽기만 합니다.');
  assert.equal((await (await request('/api/invoices/drafts')).json()).drafts.length, 0);
  const imported = await request('/api/invoices/import', { method: 'POST', body: invoiceForm(true, [b.batch.id]) });
  assert.equal(imported.status, 201);
  const result = await imported.json(), id = result.run.id;
  assert.equal(result.run.generatedAt, null);
  assert.equal(result.run.isDraft, true);
  assert.equal((await (await request('/api/invoices')).json()).runs.length, 0, '매칭만으로 파일 생성 내역에 쌓이지 않습니다.');
  assert.deepEqual((await (await request('/api/invoices/drafts')).json()).drafts.map(run => run.id), [id]);
  assert.equal(result.items.length, 2);
  assert.ok(result.items.every(item => item.sourceRows.length === 2 && item.sourceRows.some(row => row.batchId === a.batch.id) && item.sourceRows.some(row => row.batchId === b.batch.id)));
  assert.equal(result.orders.length, 2, '여러 날짜의 원본 근거를 보존하되 상품주문은 한 번만 출력합니다.');
  assert.deepEqual(result.orders[0].itemIds, result.items.map(item => item.id));
  assert.equal(result.unmatchedCouriers.length, 1);
  assert.equal(result.unmatchedCouriers[0].trackingNumber, '009999999999');
  assert.ok(result.issues.some(issue => !issue.resolved));
  assert.ok(result.issues.every(issue => issue.reviewRequired === false));
  assert.equal(result.summary.issues, 0);
  const output = await request(`/api/invoices/${id}/export`);
  assert.equal(output.status, 200);
  const workbook = XLSX.read(Buffer.from(await output.arrayBuffer()), { type: 'buffer' });
  assert.deepEqual(workbook.SheetNames, ['발송처리']);
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets['발송처리'], { header: 1, raw: true });
  assert.deepEqual(rows, [['상품주문번호', '배송방법', '택배사', '송장번호'],
    ...productIds.map(id => [id, '택배,등기,소포', '로젠택배', tracking])]);
  const generated = await (await request(`/api/invoices/${id}`)).json();
  assert.ok(generated.run.generatedAt); assert.equal(generated.run.isDraft, false);
  assert.ok(generated.issues.every(issue => !issue.resolved && issue.note === '' && !issue.reviewRequired), '조회 전용 경고를 확인한 것으로 바꾸지 않습니다.');
  assert.ok(generated.items.every(item => item.registrationState === 'unchecked'), '파일 생성으로 네이버 등록을 완료 처리하지 않습니다.');
  assert.equal((await (await request('/api/invoices/drafts')).json()).drafts.length, 0);
  const again = await (await request('/api/invoices/import', { method: 'POST', body: invoiceForm(true, [b.batch.id]) })).json();
  assert.equal(again.run.id, id);
  assert.equal(app.locals.db.prepare('SELECT count(*) AS n FROM source_files').get().n, sources);
  assert.equal((await (await request('/api/invoices')).json()).runs.length, 1);
});

test('최종①에만 있는 상품주문을 API 재개에도 표시하고 경고 확인 후에도 송장 없이 강제 포함하지 않는다', async t => {
  const { request } = await boot(t), source = await addSource(request);
  const original = naverFile(), workbook = XLSX.read(original.buffer, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets['주문'], { header: 1, raw: true });
  rows.push(['missing-product', 'missing-order', recipient, phone, address, '쿠션 원상품명', '실제 선택 옵션', 1, '발송대기', '', '']);
  const upload = () => {
    const body = invoiceForm(false, [source.batch.id]);
    const naver = file('최종 네이버.xlsx', rows);
    body.set('naverFiles', new Blob([naver.buffer]), naver.name);
    return body;
  };
  const imported = await request('/api/invoices/import', { method: 'POST', body: upload() });
  assert.equal(imported.status, 201);
  const detail = await imported.json(), missing = detail.items.find(item => item.productOrderId === 'missing-product');
  assert.equal(detail.summary.total, 3); assert.equal(detail.summary.connected, 2); assert.equal(detail.summary.missingSaved, 1);
  assert.equal(missing.decision, 'hold'); assert.equal(missing.optionName, '실제 선택 옵션');
  assert.equal(missing.trackingNumber, ''); assert.deepEqual(missing.sourceRows, []);
  const row = detail.orders.find(order => order.sourceType === 'naver_only');
  assert.equal(row.productOrderId, missing.productOrderId); assert.equal(row.source.sourceRow, 4);
  assert.equal(row.state, 'missing_saved_order'); assert.equal(row.optionName, missing.optionName);
  assert.ok(detail.issues.some(issue => issue.kind === 'missing_saved_order' && issue.reviewRequired && issue.blocking));
  const resumed = await (await request(`/api/invoices/${detail.run.id}`)).json();
  assert.deepEqual(resumed.orders, detail.orders);
  assert.equal((await request(`/api/invoices/${detail.run.id}/export`)).status, 400);
  const reviewed = await request(`/api/invoices/${detail.run.id}/items`, json('PATCH', {
    issueResolutions: detail.issues.filter(issue => issue.reviewRequired).map(issue => ({ key: issue.key })),
  }));
  assert.equal(reviewed.status, 200);
  assert.equal((await request(`/api/invoices/${detail.run.id}/items`, json('PATCH', {
    changes: [{ id: missing.id, decision: 'include', note: '동명이인과 연결 금지' }],
  }))).status, 400);
  const exported = await request(`/api/invoices/${detail.run.id}/export`);
  assert.equal(exported.status, 200);
  const output = XLSX.read(Buffer.from(await exported.arrayBuffer()), { type: 'buffer' });
  assert.deepEqual(XLSX.utils.sheet_to_json(output.Sheets['발송처리'], { header: 1 }).slice(1).map(row => row[0]), productIds);
  assert.equal((await (await request('/api/invoices/import', { method: 'POST', body: upload() })).json()).run.id, detail.run.id);
});

test('구버전 API 매칭은 저장본 다운로드를 유지하고 수정·조회·새 파일 생성 전에 재매칭을 요구한다', async t => {
  let queries = 0;
  const { app, request } = await boot(t, { queryProductOrders: async ids => { queries++; return ids.map(id => remote(id)); } });
  const source = await addSource(request);
  const detail = await (await request('/api/invoices/import', { method: 'POST', body: invoiceForm(false, [source.batch.id]) })).json();
  const output = await request(`/api/invoices/${detail.run.id}/export`);
  assert.equal(output.status, 200); const bytes = Buffer.from(await output.arrayBuffer());
  const scope = JSON.parse(app.locals.db.prepare('SELECT scope_json FROM invoice_runs WHERE id = ?').get(detail.run.id).scope_json);
  delete scope.matchingVersion; scope.inputFingerprint = 'old-api-fixture';
  app.locals.db.prepare('UPDATE invoice_runs SET scope_json = ?, fingerprint = ? WHERE id = ?').run(JSON.stringify(scope), 'old-api-fixture', detail.run.id);
  const old = await (await request(`/api/invoices/${detail.run.id}`)).json();
  assert.equal(old.rematchRequired, true);
  for (const [route, options] of [[`/api/invoices/${detail.run.id}/items`, json('PATCH', {
    changes: [{ id: old.items[0].id, decision: 'hold', note: '차단 확인' }],
  })], [`/api/invoices/${detail.run.id}/check`, { method: 'POST' }],
    [`/api/invoices/${detail.run.id}/export`, {}], [`/api/invoices/${detail.run.id}/download?rebuild=1`, {}]]) {
    const response = await request(route, options);
    assert.equal(response.status, 400); assert.match((await response.json()).error, /다시 매칭/);
  }
  assert.equal(queries, 0);
  const copy = await request(`/api/invoices/${detail.run.id}/download`);
  assert.equal(copy.status, 200); assert.ok(Buffer.from(await copy.arrayBuffer()).equals(bytes));
  const fresh = await (await request('/api/invoices/import', { method: 'POST', body: invoiceForm(false, [source.batch.id]) })).json();
  assert.notEqual(fresh.run.id, old.run.id); assert.equal(fresh.rematchRequired, false);
});

test('암호화 네이버 파일은 암호를 확인하고 원본을 보존하며 재개에는 암호를 요구하지 않는다', async t => {
  const { app, request } = await boot(t), source = await addSource(request);
  const password = `test-${randomUUID()}`, naver = naverFile();
  const encrypted = officeCrypto.encrypt(naver.buffer, { password });
  const upload = async entered => {
    const body = invoiceForm(false, [source.batch.id]);
    body.set('naverFiles', new Blob([encrypted]), naver.name);
    if (entered !== undefined) body.set('naverPassword', entered);
    return request('/api/invoices/import', { method: 'POST', body });
  };
  const missing = await upload();
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /① 네이버 주문파일.*네이버 파일 암호를 입력/);
  const wrong = await upload('incorrect-test-password');
  assert.equal(wrong.status, 400);
  assert.match((await wrong.json()).error, /네이버.xlsx.*입력한 파일 암호가 맞는지/);
  assert.equal(app.locals.db.prepare('SELECT count(*) AS n FROM invoice_runs').get().n, 0);
  const correct = await upload(password);
  assert.equal(correct.status, 201);
  const result = await correct.json();
  assert.equal(result.items.length, 2);
  assert.ok(result.items.every(item => item.trackingNumber === tracking));
  const original = app.locals.db.prepare("SELECT content FROM invoice_files WHERE run_id = ? AND kind = 'naver'").get(result.run.id);
  assert.deepEqual(Buffer.from(original.content), Buffer.from(encrypted), '업로드한 암호화 원본을 그대로 보존합니다.');
  const reopened = await request(`/api/invoices/${result.run.id}`);
  assert.equal(reopened.status, 200);
  assert.equal((await reopened.json()).items.length, 2);
  assert.ok(!JSON.stringify(result).includes(password), '응답에 암호를 포함하지 않습니다.');
  const ordinary = invoiceForm(false, [source.batch.id]); ordinary.set('naverPassword', 'unused-password');
  assert.equal((await request('/api/invoices/import', { method: 'POST', body: ordinary })).status, 201, '암호 없는 파일도 계속 읽습니다.');
});

test('송장 API는 선택 주문의 경고 체크만 저장하고 하단 조회 행을 확인 처리하지 않은 채 다운로드한다', async t => {
  const { request } = await boot(t);
  const sourceFile = legacy(), workbook = XLSX.read(sourceFile.buffer, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets['주문'], { header: 1, raw: true });
  rows.push(['네이버 자료 없는 주문', '000002', 'missing-naver-order', recipient, phone, address, 1, '네이버']);
  const source = await (await request('/api/import', { method: 'POST', body: form([file('확인한 주문.xlsx', rows)]) })).json();
  const imported = await request('/api/invoices/import', { method: 'POST', body: invoiceForm(true, [source.batch.id]) });
  assert.equal(imported.status, 201);
  const detail = await imported.json(), id = detail.run.id;
  const required = detail.issues.filter(warning => warning.reviewRequired);
  assert.equal(required.length, 0, '현재①에 없는 저장 행은 검토 필수 경고를 만들지 않습니다.');
  assert.ok(detail.issues.some(warning => !warning.reviewRequired));
  assert.equal((await request(`/api/invoices/${id}/export`)).status, 200);
  const foreign = detail.issues[0].key;
  const malformed = await request(`/api/invoices/${id}/items`, json('PATCH', { issueResolutions: [{ key: foreign, note: null }] }));
  assert.equal(malformed.status, 400);
  const saved = await request(`/api/invoices/${id}/items`, json('PATCH', { changes: [{id:detail.items[0].id,decision:'include',note:'연결 확인'}] }));
  assert.equal(saved.status, 200);
  const reviewed = await saved.json();
  assert.equal(reviewed.summary.issues, 0);
  assert.ok(reviewed.issues.filter(warning => warning.reviewRequired).every(warning => warning.resolved && warning.note === ''));
  assert.ok(reviewed.issues.filter(warning => !warning.reviewRequired).every(warning => !warning.resolved && warning.note === ''));
  const exported = await request(`/api/invoices/${id}/export`);
  assert.equal(exported.status, 200);
  const output = XLSX.read(Buffer.from(await exported.arrayBuffer()), { type: 'buffer' });
  assert.equal(XLSX.utils.sheet_to_json(output.Sheets['발송처리'], { header: 1 }).length, 3);
});

test('등록 조회는 부분완료·전체완료·조회실패를 구분하고 보드와 달력은 실제 전체완료만 회색 상태로 보낸다', async t => {
  let phase = 'partial';
  const { app, request } = await boot(t, { queryProductOrders: async ids => {
    if (phase === 'error') throw new Error('모의 네이버 조회 실패');
    return ids.map((id, index) => remote(id, phase === 'partial' && index ? { status: 'PAYED', trackingNumber: '' } : {}));
  } });
  const source = await addSource(request);
  app.locals.db.prepare("UPDATE rows SET cleaned_name = '정리 쿠션과 커버' WHERE batch_id = ?").run(source.batch.id);
  const imported = await (await request('/api/invoices/import', { method: 'POST', body: invoiceForm(false, [source.batch.id]) })).json();
  assert.ok(imported.run, JSON.stringify(imported));
  const date = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const board = () => request('/api/shipping/board?date=' + date).then(response => response.json());
  const check = () => request(`/api/invoices/${imported.run.id}/check`, { method: 'POST' });
  assert.notEqual((await board()).invoiceState, 'complete');
  assert.equal((await check()).status, 200);
  assert.equal((await board()).invoiceState, 'pending');
  phase = 'complete';
  assert.equal((await check()).status, 200);
  assert.equal((await board()).invoiceState, 'complete');
  assert.equal((await (await request('/api/invoices')).json()).runs.length, 0, '등록 조회만으로 파일 생성 이력에 넣지 않습니다.');
  assert.equal((await (await request('/api/invoices/drafts')).json()).drafts.length, 1);
  assert.ok((await board()).groups.every(group => group.invoiceState === 'complete'));
  const dates = await (await request('/api/shipping/dates?month=' + date.slice(0, 7))).json();
  assert.equal(dates.days.find(day => day.date === date).invoiceState, 'complete');
  assert.equal((await request(`/api/invoices/${imported.run.id}/export`)).status, 400, '완료 송장은 중복 엑셀에 포함하지 않습니다.');
  phase = 'error';
  assert.equal((await check()).status, 400);
  assert.notEqual((await board()).invoiceState, 'complete');
});

test('송장 API는 외부 요청·잘못된 입력·동시 조회 충돌을 거부하고 검토 오류를 원자적으로 처리한다', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { request } = await boot(t, { queryProductOrders: async ids => { await gate; return ids.map(id => remote(id)); } });
  const source = await addSource(request);
  assert.equal((await request('/api/invoices/import', { method: 'POST', body: invoiceForm(), headers: { Origin: 'https://external.invalid' } })).status, 403);
  const invalidCarrier = invoiceForm(); invalidCarrier.set('deliveryCompanyCode', 'INVALID');
  assert.equal((await request('/api/invoices/import', { method: 'POST', body: invalidCarrier })).status, 400);
  const tooManyFields = invoiceForm(false, [source.batch.id]);
  tooManyFields.set('naverPassword', ''); tooManyFields.set('extra', 'unexpected');
  const fieldError = await request('/api/invoices/import', { method: 'POST', body: tooManyFields });
  assert.equal(fieldError.status, 400);
  const fieldMessage = (await fieldError.json()).error;
  assert.match(fieldMessage, /서버를 재시작/);
  assert.doesNotMatch(fieldMessage, /엑셀 100개/);
  assert.equal((await request('/api/invoices?date=2026-02-30')).status, 400);
  assert.equal((await request('/api/invoices/drafts?date=2026-02-30')).status, 400);
  assert.equal((await request('/api/invoices/999999')).status, 404);
  for (const batchIds of [[], [999999], [source.batch.id, source.batch.id], ['1']]) {
    assert.equal((await request('/api/invoices/import', { method: 'POST', body: invoiceForm(false, batchIds) })).status, 400);
  }
  const missingScope = invoiceForm(); missingScope.delete('batchIds');
  assert.equal((await request('/api/invoices/import', { method: 'POST', body: missingScope })).status, 400);
  assert.equal((await request('/api/invoices/orders?batchIds=bad')).status, 400);
  const imported = await (await request('/api/invoices/import', { method: 'POST', body: invoiceForm(false, [source.batch.id]) })).json();
  const id = imported.run.id;
  const invalid = await request(`/api/invoices/${id}/items`, json('PATCH', { changes: [
    { id: imported.items[0].id, decision: 'hold', note: '검토 보류' }, { id: 999999, decision: 'exclude', note: '잘못된 항목' }], issueResolutions: [] }));
  assert.equal(invalid.status, 400);
  assert.equal((await (await request(`/api/invoices/${id}`)).json()).items[0].decision, 'include');
  const checking = request(`/api/invoices/${id}/check`, { method: 'POST' });
  await new Promise(resolve => setTimeout(resolve, 30));
  for (const [route, options] of [[`/api/invoices/${id}/check`, { method: 'POST' }],
    [`/api/invoices/${id}/items`, json('PATCH', { changes: [], issueResolutions: [] })],
    [`/api/invoices/${id}/export`, {}], [`/api/invoices/${id}/download`, {}], [`/api/invoices/${id}/download?rebuild=1`, {}],
    ['/api/invoices/import', { method: 'POST', body: invoiceForm(false, [source.batch.id]) }]]) {
    assert.equal((await request(route, options)).status, 409);
  }
  release(); assert.equal((await checking).status, 200);
});

test('날짜 재개 API는 생성된 결과도 찾고 완료 후 정확한 저장본과 구내역의 명시적 재생성 파일을 구분한다', async t => {
  let queryCalls = 0;
  const { app, request } = await boot(t, { queryProductOrders: async ids => { queryCalls++; return ids.map(id => remote(id)); } });
  const source = await addSource(request);
  app.locals.db.prepare('UPDATE batches SET created_at = ? WHERE id = ?').run('2026-10-21T00:00:00Z', source.batch.id);
  assert.deepEqual(await (await request('/api/invoices/latest?date=2026-10-21')).json(), { invoice: null });
  for (const route of ['/api/invoices/latest', '/api/invoices/latest?date=2026-02-30', '/api/invoices/latest?date=2026-10-21&date=2026-10-22']) {
    const response = await request(route);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /날짜/);
  }
  const imported = await (await request('/api/invoices/import', { method: 'POST', body: invoiceForm(false, [source.batch.id]) })).json();
  const id = imported.run.id;
  assert.equal((await (await request('/api/invoices/latest?date=2026-10-21')).json()).invoice.run.id, id);
  assert.equal((await request(`/api/invoices/${id}/download?rebuild=1`)).status, 400, '최초 생성의 등록완료 제외 정책을 우회하지 않습니다.');
  const generated = await request(`/api/invoices/${id}/export`);
  assert.equal(generated.status, 200);
  const originalBytes = Buffer.from(await generated.arrayBuffer());
  app.locals.db.prepare('UPDATE invoice_runs SET generated_at = ? WHERE id = ?').run('2026-10-22T00:00:00Z', id);
  assert.equal((await request(`/api/invoices/${id}/check`, { method: 'POST' })).status, 200);
  assert.equal(queryCalls, 1);
  const resumed = (await (await request('/api/invoices/latest?date=2026-10-21')).json()).invoice;
  assert.equal(resumed.run.id, id);
  assert.equal(resumed.run.savedFileAvailable, true);
  assert.ok(resumed.items.every(item => item.registrationState === 'complete'));
  assert.equal((await (await request('/api/invoices/drafts?date=2026-10-21')).json()).drafts.length, 0);
  assert.equal((await (await request('/api/invoices?date=2026-10-21')).json()).runs[0].id, id);
  assert.equal((await (await request('/api/invoices?date=2026-10-22')).json()).runs.length, 0);
  assert.equal((await request(`/api/invoices/${id}/export`)).status, 400);
  const before = app.locals.db.prepare('SELECT * FROM invoice_items').all();
  const copied = await request(`/api/invoices/${id}/download`);
  assert.equal(copied.status, 200);
  assert.ok(Buffer.from(await copied.arrayBuffer()).equals(originalBytes));
  assert.deepEqual(app.locals.db.prepare('SELECT * FROM invoice_items').all(), before);
  app.locals.db.prepare('UPDATE invoice_runs SET generated_file = NULL, generated_filename = NULL WHERE id = ?').run(id);
  const missing = await request(`/api/invoices/${id}/download`);
  assert.equal(missing.status, 409);
  assert.equal((await missing.json()).code, 'saved_file_missing');
  assert.equal((await (await request('/api/invoices/latest?date=2026-10-21')).json()).invoice.run.savedFileAvailable, false);
  assert.equal((await request(`/api/invoices/${id}/download?rebuild=true`)).status, 400);
  const rebuilt = await request(`/api/invoices/${id}/download?rebuild=1`);
  assert.equal(rebuilt.status, 200);
  assert.match(decodeURIComponent(rebuilt.headers.get('content-disposition')), /현재매칭재생성/);
  const rebuiltBytes = Buffer.from(await rebuilt.arrayBuffer()), workbook = XLSX.read(rebuiltBytes, { type: 'buffer' });
  assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets['발송처리'], { header: 1 }).length, 3, '현재 포함된 등록완료 두 상품을 명시적으로 재생성합니다.');
  const nextCopy = await request(`/api/invoices/${id}/download`);
  assert.ok(Buffer.from(await nextCopy.arrayBuffer()).equals(rebuiltBytes));
  assert.match(decodeURIComponent(nextCopy.headers.get('content-disposition')), /현재매칭재생성/);
  assert.equal(queryCalls, 1, '재개·복사·재생성은 외부 주문 조회나 상태변경 API를 호출하지 않습니다.');
  assert.deepEqual(app.locals.db.prepare('SELECT * FROM invoice_items').all(), before);
  assert.equal((await (await request(`/api/invoices/${id}`)).json()).run.generatedAt, '2026-10-22T00:00:00Z');
});
