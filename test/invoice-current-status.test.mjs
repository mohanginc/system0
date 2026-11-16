import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { sourceFile, naverFile, courierFile, registeredOrder } from './fixtures/weekend-invoices.mjs';

process.env.SYSTEM0_ENV_FILE = path.join(os.tmpdir(), `system0-current-absent-${randomUUID()}.env`);
process.env.OPENAI_API_KEY = '';
const { createApp } = await import('../server.mjs');
const { invoiceDetail, invoiceView, invoiceDateRunIds, importInvoiceFiles, refreshInvoiceStatus } = await import('../lib/invoices.mjs');
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const order = index => ({ productOrderId: `202611070000000${index}`, orderId: `202611070001000${index}`, internalId: `CURRENT-${index}`,
  trackingNumber: `99000700000${index}`, recipient: `가상 수취인 ${index}`, phone: '010-0000-0001', address: '서울 테스트구 테스트로 1 101호',
  productName: `가상 상품 ${index}`, quantity: 1 });

async function boot(t, originals) {
  const all = new Map(originals.map(row => [row.productOrderId, row])), state = { details: [], lookups: [], changes: new Map(), detail: null, lookup: null };
  const naver = { getProductOrderIds: async id => { state.lookups.push(id); return state.lookup ? state.lookup(id)
    : [...all.values()].filter(row => row.orderId === id).map(row => row.productOrderId); },
    queryProductOrders: async ids => { state.details.push([...ids]); return state.detail ? state.detail(ids)
      : ids.map(id => { assert.ok(all.has(id)); return registeredOrder(all.get(id), state.changes.get(id) || {}); }); } };
  const app = createApp({ databasePath: ':memory:', apiKey: '', client: null, publicOrigin: '', naver }), db = app.locals.db;
  const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); db.close(); });
  const request = (route, options) => { assert.ok(route.startsWith('/api/')); return fetch(base + route, options); };
  const read = async route => { const response = await request(route); assert.equal(response.status, 200); return response.json(); };
  const add = async (rows, date) => {
    const file = sourceFile(rows, `가상_${date}.xlsx`), body = new FormData(); body.append('files', new Blob([file.buffer]), file.name);
    const response = await request('/api/import', { method: 'POST', body }), detail = await response.json(); assert.equal(response.status, 201, detail.error);
    db.prepare('UPDATE batches SET created_at=? WHERE id=?').run(`${date}T00:00:00.000Z`, detail.batch.id);
    const reviewed = await request(`/api/batches/${detail.batch.id}/rows`, json('PATCH', { changes: detail.rows.map(row => ({
      id: row.id, cleanedName: row.originalName, reviewNote: '', status: 'confirmed' })) })); assert.equal(reviewed.status, 200);
    return detail;
  };
  const match = async (targets, parcels, date = '2026-11-09') => {
    const body = new FormData(), naver = naverFile(targets), courier = courierFile(parcels);
    body.append('naverFiles', new Blob([naver.buffer]), naver.name); body.append('courierFiles', new Blob([courier.buffer]), courier.name);
    body.append('sourceDate', date); body.append('deliveryCompanyCode', 'KGB');
    const response = await request('/api/invoices/import', { method: 'POST', body }), detail = await response.json(); assert.equal(response.status, 201, detail.error);
    return detail;
  };
  const checkDate = async date => { const response = await request('/api/invoices/check-date', json('POST', { date }));
    const result = await response.json(); assert.equal(response.status, 200, result.error); return result; };
  const check = async id => { const response = await request(`/api/invoices/${id}/check`, { method: 'POST' });
    const result = await response.json(); assert.equal(response.status, 200, result.error); return result; };
  const business = () => ({ items: db.prepare(`SELECT id,run_id,product_order_id,order_id,internal_id,tracking_number,expected_json,shipments_json,source_rows_json,decision,note FROM invoice_items ORDER BY id`).all(),
    originals: Object.fromEntries(['batches', 'sheets', 'source_files', 'rows', 'row_revisions', 'invoice_files', 'invoice_revisions'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()])) });
  const exportFile = async id => { const response = await request(`/api/invoices/${id}/export`); assert.equal(response.status, 200, await response.clone().text()); return Buffer.from(await response.arrayBuffer()); };
  return { all, state, naver, db, request, read, add, match, checkDate, check, business, exportFile };
}

async function rounds(t) {
  const rows = Array.from({ length: 6 }, (_, i) => order(i + 1)), h = await boot(t, rows), [a, b, c, d, e, f] = rows;
  const saturday = await h.add([a], '2026-11-07'); await h.add([d, e], '2026-11-08');
  let am = await h.match(rows, [a]);
  const reviewed = await h.request(`/api/invoices/${am.run.id}/items`, json('PATCH', { issueResolutions: am.issues.filter(row => row.reviewRequired).map(row => ({ key: row.key })) }));
  assert.equal(reviewed.status, 200); am = await reviewed.json();
  const bytes = await h.exportFile(am.run.id);
  await h.add([b, c, f], '2026-11-09');
  h.state.changes.set(c.productOrderId, { status: 'CANCELED', remainQuantity: 0, trackingNumber: '', deliveryCompanyCode: '' });
  const pm = await h.match([d, e, f], [d, e, f]);
  return { ...h, rows, a, b, c, d, e, f, am, pm, saturday, bytes };
}

test('토요일 선택으로 월요일 오전·오후를 함께 조회하고 과거 누락 대신 현재 상태를 표시한다', async t => {
  const h = await rounds(t), rawBefore = invoiceDetail(h.db, h.am.run.id), stored = h.business();
  assert.deepEqual(invoiceDateRunIds(h.db, '2026-11-07'), [h.am.run.id, h.pm.run.id]);
  assert.deepEqual(invoiceDateRunIds(h.db, '2026-11-08'), [h.am.run.id, h.pm.run.id]);
  const preview = await h.read(`/api/invoices/orders?batchIds=${encodeURIComponent(JSON.stringify([h.saturday.batch.id]))}`);
  assert.deepEqual(preview.checkRunIds, [h.am.run.id, h.pm.run.id]); assert.equal(preview.checkAvailable, true);
  h.state.details.length = 0;
  const result = await h.checkDate('2026-11-07'); assert.equal(result.summary.failed, 0);
  assert.deepEqual(h.state.details.flat().sort(), h.rows.map(row => row.productOrderId).sort(), '관련 차수의 각 상품주문은 한 번만 확인합니다.');
  const view = await h.read(`/api/invoices/${h.am.run.id}`);
  assert.deepEqual(view.currentSummary, { total: 6, connected: 6, missingSaved: 0, complete: 5, ready: 0, canceled: 1, returned: 0, unknown: 0, attention: 0, hold: 0, excluded: 0 });
  const formerlyMissing = view.currentOrders.find(row => row.productOrderId === h.f.productOrderId);
  assert.equal(formerlyMissing.state, 'complete'); assert.equal(formerlyMissing.originalOrder.state, 'missing_saved_order');
  assert.equal(formerlyMissing.latestStatus.runId, h.pm.run.id); assert.equal(formerlyMissing.latestStatus.readonly, true);
  assert.equal(formerlyMissing.latestStatus.processingDate, '2026-11-09');
  const rawAfter = invoiceDetail(h.db, h.am.run.id);
  assert.deepEqual(rawAfter.items.map(({ registrationState, checkedAt, statusFresh, registrationProblems, registrationNote, naverRegistration, ...row }) => row), rawBefore.items.map(({ registrationState, checkedAt, statusFresh, registrationProblems, registrationNote, naverRegistration, ...row }) => row));
  assert.deepEqual(rawAfter.orders.filter(row => row.productOrderId), rawBefore.orders.filter(row => row.productOrderId));
  assert.deepEqual(h.business(), stored);
  const saved = await h.request(`/api/invoices/${h.am.run.id}/download`); assert.deepEqual(Buffer.from(await saved.arrayBuffer()), h.bytes);
  assert.equal((await h.request(`/api/invoices/${h.am.run.id}/download?rebuild=1`)).status, 400, '현재 보기의 완료가 과거 raw 매칭의 강제 출력 권한이 되지 않습니다.');
});

test('오후 조회 실패는 오전 성공을 보존하고 오후 상품주문의 과거 완료로 돌아가지 않는다', async t => {
  const h = await rounds(t); await h.checkDate('2026-11-07');
  h.state.detail = async ids => {
    if (ids.includes(h.d.productOrderId)) throw new Error('가상 오후 조회 장애');
    return ids.map(id => registeredOrder(h.all.get(id), h.state.changes.get(id) || {}));
  };
  const result = await h.checkDate('2026-11-07');
  assert.equal(result.summary.failed, 1); assert.equal(result.errors[0].runId, h.pm.run.id);
  const view = await h.read(`/api/invoices/${h.am.run.id}`);
  assert.equal(view.currentSummary.complete, 2); assert.equal(view.currentSummary.unknown, 3); assert.equal(view.currentSummary.canceled, 1);
  assert.equal(view.currentOrders.find(row => row.itemIds.includes(h.am.items[0].id)).state, 'complete');
});

test('일괄 조회는 모든 관련 내역을 미리 잠그고 완료 뒤 잠금을 해제한다', async t => {
  const h = await rounds(t); let enter, release;
  const started = new Promise(resolve => { enter = resolve; }), waiting = new Promise(resolve => { release = resolve; });
  h.state.detail = async ids => { enter(); await waiting; return ids.map(id => registeredOrder(h.all.get(id), h.state.changes.get(id) || {})); };
  const pending = h.request('/api/invoices/check-date', json('POST', { date: '2026-11-07' })); await started;
  for (const id of [h.am.run.id, h.pm.run.id]) {
    assert.equal((await h.request(`/api/invoices/${id}/check`, { method: 'POST' })).status, 409);
    assert.equal((await h.request(`/api/invoices/${id}/items`, json('PATCH', { changes: [] }))).status, 409);
    assert.equal((await h.request(`/api/invoices/${id}/export`)).status, 409);
    assert.equal((await h.request(`/api/invoices/${id}/download`)).status, 409);
  }
  assert.equal((await h.request('/api/invoices/check-date', json('POST', { date: '2026-11-09' }))).status, 409);
  release(); assert.equal((await pending).status, 200);
  assert.equal((await h.request(`/api/invoices/${h.am.run.id}/download`)).status, 200);
  assert.equal((await h.request('/api/invoices/check-date', json('POST', { date: '2026-11-09', runIds: [h.pm.run.id] }))).status, 400);
  assert.equal((await h.request('/api/invoices/check-date', json('POST', { date: '2026-12-31' }))).status, 400);
});

test('같은 PID라도 다른 스토어의 최신 내역이 기본 보기와 날짜 조회 범위에 들어오지 않는다', async t => {
  const row = order(1), h = await boot(t, [row]), batch = await h.add([row], '2026-11-07'), first = await h.match([row], [row]); await h.check(first.run.id);
  const other = importInvoiceFiles(h.db, { naverFiles: [naverFile([row])], courierFiles: [courierFile([row])], carrier: { code: 'KGB', name: '로젠택배' }, sourceDate: '2026-11-09', store: 'other' });
  const view = invoiceView(h.db, first.run.id); assert.equal(view.currentSummary.complete, 1);
  assert.deepEqual(invoiceDateRunIds(h.db, '2026-11-07'), [first.run.id]);
  const preview = await h.read(`/api/invoices/orders?batchIds=${encodeURIComponent(JSON.stringify([batch.batch.id]))}`);
  assert.equal(preview.currentOrders[0].latestStatus.runId, first.run.id);
  assert.equal(invoiceView(h.db, other.run.id).currentSummary.complete, 0);
});

test('현재 집계는 중복 원본 행 대신 상품주문 수를 세며 미연결 주문은 계속 누락으로 센다', async t => {
  const row = order(1), orphan = order(2), h = await boot(t, [row, orphan]); await h.add([row, row], '2026-11-07');
  const detail = await h.match([row, orphan], [row]);
  assert.equal(detail.orders.length, 3); assert.equal(detail.currentSummary.total, 2);
  assert.equal(detail.currentSummary.connected, 1); assert.equal(detail.currentSummary.missingSaved, 1);
  assert.equal(detail.currentOrders.find(value => value.productOrderId === orphan.productOrderId).state, 'missing_saved_order');
});

test('합배송의 최신 A·B가 다른 차수에 있어도 전부 완료일 때만 행 전체가 완료다', async t => {
  const a = order(1), b = { ...a, productOrderId: order(2).productOrderId }, h = await boot(t, [a, b]); await h.add([a], '2026-11-07');
  const am = await h.match([a, b], [a]), pm = await h.match([b], [a]);
  await refreshInvoiceStatus(h.db, am.run.id, h.naver); await refreshInvoiceStatus(h.db, pm.run.id, h.naver);
  let view = invoiceView(h.db, am.run.id); assert.equal(view.currentOrders[0].state, 'complete'); assert.equal(view.currentSummary.complete, 2);
  h.state.changes.set(b.productOrderId, { status: 'PAYED', trackingNumber: '', deliveryCompanyCode: '' });
  await refreshInvoiceStatus(h.db, pm.run.id, h.naver);
  view = invoiceView(h.db, am.run.id); assert.equal(view.currentOrders[0].state, 'ready'); assert.equal(view.currentSummary.complete, 1);
  assert.deepEqual(new Set(view.currentOrders[0].latestStatus.productOrderIds), new Set([a.productOrderId, b.productOrderId]));
});

test('밖 조회의 한 주문 복사본 완료가 같은 주문의 출고번호 충돌 행을 완료로 바꾸지 않는다', async t => {
  const a = order(1), copy = { ...a, internalId: 'COPY-A' }, b = { ...order(2), internalId: a.internalId }, c = order(3), h = await boot(t, [a, b, c]);
  await h.add([a, copy, b, c], '2026-11-09'); const detail = await h.match([c], [c]);
  const conflict = detail.currentOutsideOrders.find(row => row.orderId === a.orderId && row.internalId === a.internalId);
  const normal = detail.currentOutsideOrders.find(row => row.orderId === a.orderId && row.internalId === copy.internalId);
  assert.equal(conflict.state, 'attention'); assert.equal(normal.state, 'complete');
});

test('현재 내역은 제외 결정과 두 실물 송장 후보를 유지하고 조회된 취소·반품·충돌을 구분한다', async t => {
  const row = order(1), h = await boot(t, [row]); await h.add([row], '2026-11-09');
  const second = { ...row, trackingNumber: '990007999999', round: 2 }, detail = await h.match([row], [{ ...row, round: 1 }, second]);
  assert.deepEqual(detail.currentOrders[0].trackingNumbers, detail.orders[0].trackingNumbers);
  assert.equal(detail.currentOrders[0].latestStatus.readonly, false);
  let reviewed = await h.request(`/api/invoices/${detail.run.id}/items`, json('PATCH', { changes: [{ id: detail.items[0].id, decision: 'exclude', note: '가상 제외' }] }));
  assert.equal(reviewed.status, 200); assert.equal((await reviewed.json()).currentOrders[0].state, 'excluded');
  const view = invoiceView(h.db, detail.run.id);
  reviewed = await h.request(`/api/invoices/${detail.run.id}/tracking`, json('POST', { expectedVersion: view.viewVersion,
    choices: [{ key: view.trackingReview.groups[0].key, trackingNumber: row.trackingNumber, mode: 'split' }] })); assert.equal(reviewed.status, 200);
  for (const [remote, expected] of [[{ status: 'RETURNED', remainQuantity: 0 }, 'returned'], [{ status: 'CANCELED', remainQuantity: 0 }, 'canceled'], [{ recipient: '가상 다른 수취인' }, 'attention']]) {
    h.state.changes.set(row.productOrderId, remote); await h.check(detail.run.id);
    assert.equal(invoiceView(h.db, detail.run.id).currentOrders[0].state, expected);
  }
});

test('새 실제 조회 실패는 과거 완료로 돌아가지 않고 일괄 main 성공은 중복 outside 조회 없이 복구한다', async t => {
  const a = order(1), b = order(2), h = await boot(t, [a, b]); await h.add([a, b], '2026-11-09');
  const am = await h.match([a], [a]); await h.check(am.run.id);
  h.state.lookup = async id => { if (id === a.orderId) throw new Error('가상 주문번호 조회 실패'); return [b.productOrderId]; };
  const pm = await h.match([b], [b]);
  assert.equal(invoiceView(h.db, am.run.id).currentOrders[0].state, 'unknown', '실제로 더 최근에 실패한 밖 조회를 과거 완료로 덮지 않습니다.');
  h.state.lookups.length = 0; h.state.details.length = 0;
  let result = await h.checkDate('2026-11-09'); assert.equal(result.summary.failed, 0);
  assert.ok(result.results.every(value => value.outside === 'skipped'));
  assert.deepEqual(h.state.details.flat().sort(), [a.productOrderId, b.productOrderId].sort()); assert.deepEqual(h.state.lookups, []);
  assert.equal(invoiceView(h.db, am.run.id).currentOrders[0].state, 'complete');
  h.state.detail = async ids => { if (ids.includes(a.productOrderId)) throw new Error('가상 현재 main 조회 실패'); return ids.map(id => registeredOrder(h.all.get(id))); };
  result = await h.checkDate('2026-11-09'); assert.equal(result.summary.failed, 1);
  assert.equal(invoiceView(h.db, am.run.id).currentOrders[0].state, 'unknown');
  assert.equal(invoiceView(h.db, pm.run.id).currentOrders[0].state, 'complete');
});

test('모든 상품주문이 후속 차수로 넘어간 과거 main은 정상 생략한다', async t => {
  const a = order(1), h = await boot(t, [a]); await h.add([a], '2026-11-09');
  const am = await h.match([a], [{ ...a, round: 1 }]), pm = await h.match([a], [{ ...a, round: 2 }]);
  h.state.details.length = 0;
  const result = await h.checkDate('2026-11-09');
  assert.equal(result.results.find(value => value.runId === am.run.id).main, 'skipped');
  assert.equal(result.results.find(value => value.runId === pm.run.id).main, 'succeeded');
  assert.equal(result.summary.failed, 0); assert.deepEqual(h.state.details.flat(), [a.productOrderId]);
});
