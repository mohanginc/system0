import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { createWeekendScenario, sourceFile, naverFile, courierFile, registeredOrder, workbookFile, sourceHeaders } from './fixtures/weekend-invoices.mjs';

process.env.SYSTEM0_ENV_FILE = path.join(os.tmpdir(), `system0-outside-absent-${randomUUID()}.env`);
process.env.OPENAI_API_KEY = '';
const { createApp } = await import('../server.mjs');
const { refreshOutsideInvoiceStatus, importInvoiceFiles } = await import('../lib/invoices.mjs');
const json = (method, value) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
const filesBody = (files, field = 'files') => {
  const body = new FormData();
  for (const file of files) body.append(field, new Blob([file.buffer]), file.name);
  return body;
};
function invoiceBody(scenario, overrides = {}) {
  const body = filesBody([overrides.naver || scenario.naverFile], 'naverFiles');
  const courier = overrides.courier || scenario.courierFile;
  body.append('courierFiles', new Blob([courier.buffer]), courier.name);
  body.append('deliveryCompanyCode', 'KGB'); body.append('sourceDate', overrides.date || scenario.sourceDate);
  return body;
}
function smallScenario() {
  const base = createWeekendScenario(), outside = base.manualOrders[0], pending = base.days[0].orders[10];
  return { ...base, days: [{ date: outside.date, orders: [outside, pending], file: sourceFile([outside, pending]) }],
  allOrders: [outside, pending], pendingOrders: [pending], manualOrders: [outside],
  naverFile: naverFile([pending]), courierFile: courierFile([pending]) };
}
function outputIds(bytes) {
  const book = XLSX.read(Buffer.from(bytes), { type: 'buffer' });
  return XLSX.utils.sheet_to_json(book.Sheets['발송처리'], { header: 1, raw: true }).slice(1).map(row => row[0]);
}
async function boot(t, scenario, { persistent = false, outside = true } = {}) {
  const directory = persistent ? mkdtempSync(path.join(os.tmpdir(), 'system0-outside-')) : null;
  const databasePath = directory ? path.join(directory, 'fixture.sqlite') : ':memory:';
  const all = new Map(scenario.allOrders.map(order => [order.productOrderId, order]));
  const state = { lookupCalls: [], detailCalls: [], lookup: null, detail: null };
  const naver = { queryProductOrders: async ids => {
    state.detailCalls.push([...ids]);
    if (state.detail) return state.detail(ids);
    return ids.map(id => { assert.ok(all.has(id), '가상 주문 외에는 조회하지 않습니다.'); return registeredOrder(all.get(id)); });
  } };
  if (outside) naver.getProductOrderIds = async orderId => {
    state.lookupCalls.push(orderId);
    if (state.lookup) return state.lookup(orderId);
    return [...all.values()].filter(order => order.orderId === orderId).map(order => order.productOrderId);
  };
  const running = { app: null, server: null, base: '' };
  const stop = async () => {
    if (!running.server) return;
    await new Promise(resolve => { running.server.close(resolve); running.server.closeAllConnections(); });
    running.app.locals.db.close(); running.server = null;
  };
  const start = async () => {
    running.app = createApp({ databasePath, client: null, apiKey: '', publicOrigin: '', naver });
    running.server = await new Promise(resolve => { const server = running.app.listen(0, '127.0.0.1', () => resolve(server)); });
    running.base = `http://127.0.0.1:${running.server.address().port}`;
  };
  t.after(async () => {
    await stop();
    if (directory) {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('system0-outside-'));
      rmSync(directory, { recursive: true, force: true });
    }
  });
  await start();
  const request = (route, options) => {
    assert.ok(route.startsWith('/api/'));
    return fetch(running.base + route, options);
  };
  const read = async route => { const response = await request(route); assert.equal(response.status, 200); return response.json(); };
  const addSource = async (file, date) => {
    const response = await request('/api/import', { method: 'POST', body: filesBody([file]) });
    assert.equal(response.status, 201); const detail = await response.json();
    running.app.locals.db.prepare('UPDATE batches SET created_at = ? WHERE id = ?').run(`${date}T00:00:00.000Z`, detail.batch.id);
    const updated = await request(`/api/batches/${detail.batch.id}/rows`, json('PATCH', { changes: detail.rows.map(row => ({ id: row.id,
      cleanedName: row.originalName, reviewNote: '', status: 'confirmed' })) }));
    assert.equal(updated.status, 200); return detail;
  };
  const batches = [];
  for (const day of scenario.days) batches.push(await addSource(day.file, day.date));
  const importInvoices = async overrides => {
    const response = await request('/api/invoices/import', { method: 'POST', body: invoiceBody(scenario, overrides) });
    const detail = await response.json(); assert.equal(response.status, 201, detail.error); return detail;
  };
  const dayOrders = async index => (await read(`/api/invoices/orders?batchIds=${encodeURIComponent(JSON.stringify([batches[index].batch.id]))}`)).orders;
  const sources = () => Object.fromEntries(['batches', 'sheets', 'source_files', 'rows', 'row_revisions'].map(table =>
    [table, running.app.locals.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
  return { state, running, request, read, naver, all, addSource, batches, importInvoices, dayOrders, sources,
    restart: async () => { await stop(); await start(); } };
}

test('최종 파일 밖 수동등록 15건은 API 증거로 확인하고 대상 85건과 토요일 원본 화면·저장 엑셀을 보존한다', async t => {
  const scenario = createWeekendScenario({ sundayManual: 5 }), h = await boot(t, scenario, { persistent: true });
  const before = h.sources();
  let detail = await h.importInvoices();
  assert.equal(detail.items.length, 85); assert.equal(detail.outsideOrders.length, 15);
  assert.equal(detail.outsideSummary.registered, 15);
  assert.ok(detail.outsideOrders.every(row => row.state === 'external_registered' && row.externalRegistration && row.checkedAt));
  assert.deepEqual(new Set(detail.outsideOrders.map(row => row.orderId)), new Set(scenario.manualOrders.map(order => order.orderId)));
  assert.equal(h.state.lookupCalls.length, 15); assert.equal(new Set(h.state.lookupCalls).size, 15);
  assert.deepEqual(new Set(h.state.lookupCalls), new Set(scenario.manualOrders.map(order => order.orderId)));
  assert.ok(detail.outsideOrders.every(row => row.trackingNumbers.length === 1 && row.productOrderIds.length === 1));
  assert.ok(detail.outsideOrders.every(row => row.evidence.every(proof => !['recipient', 'phone', 'address', 'detailAddress'].some(key => key in proof))));
  const saturday = await h.dayOrders(0);
  assert.equal(saturday.length, 20);
  assert.equal(saturday.filter(row => row.state === 'external_registered').length, 10);
  assert.equal(saturday.filter(row => row.itemIds.length).length, 10);
  const download = await h.request(`/api/invoices/${detail.run.id}/export`); assert.equal(download.status, 200);
  const bytes = Buffer.from(await download.arrayBuffer()), ids = outputIds(bytes);
  assert.equal(ids.length, 85); assert.ok(scenario.manualOrders.every(order => !ids.includes(order.productOrderId)));
  assert.deepEqual(new Set(ids), new Set(scenario.pendingOrders.map(order => order.productOrderId)));
  const first = detail.items[0], held = detail.items[1];
  const changed = await h.request(`/api/invoices/${detail.run.id}/items`, json('PATCH', { changes: [
    { id: first.id, decision: 'exclude', note: '직원 제외 판단 유지' }, { id: held.id, decision: 'hold', note: '직원 보류 판단 유지' },
  ] }));
  assert.equal(changed.status, 200);
  const rechecked = await h.request(`/api/invoices/${detail.run.id}/check`, { method: 'POST' }); assert.equal(rechecked.status, 200);
  detail = await rechecked.json(); assert.equal(detail.outsideSummary.registered, 15);
  assert.equal(detail.items.find(row => row.id === first.id).decision, 'exclude');
  assert.equal(detail.items.find(row => row.id === held.id).note, '직원 보류 판단 유지');
  assert.ok(detail.checks?.length || h.running.app.locals.db.prepare('SELECT COUNT(*) AS count FROM invoice_checks WHERE run_id = ?').get(detail.run.id).count >= 1);
  await h.restart();
  detail = await h.read(`/api/invoices/${detail.run.id}`);
  assert.equal(detail.outsideSummary.registered, 15);
  assert.ok(detail.outsideOrders.every(row => row.checkedAt && row.externalRegistration));
  assert.equal(detail.items.find(row => row.id === first.id).note, '직원 제외 판단 유지');
  const resumed = await h.request(`/api/invoices/${detail.run.id}/download`); assert.equal(resumed.status, 200);
  assert.deepEqual(Buffer.from(await resumed.arrayBuffer()), bytes);
  assert.deepEqual(h.sources(), before, '조회·재시작으로 저장 원본과 직원 상품명 검수 내역을 변경하지 않습니다.');
});

test('과거 조회 완료라도 최신 조회 실패 시 현재 완료를 표시하지 않고 마지막 증거를 보관한다', async t => {
  const scenario = smallScenario(), h = await boot(t, scenario), detail = await h.importInvoices();
  assert.equal(detail.outsideOrders[0].state, 'external_registered');
  const boardState = async () => (await h.read('/api/shipping/board?date=2026-10-31')).groups
    .find(group => group.shipments.some(row => row.id === 'order:' + scenario.manualOrders[0].internalId)).invoiceState;
  assert.equal(await boardState(), 'complete', '외부 API 증거는 출고보드의 몰 송장 등록 상태에만 반영합니다.');
  const audits = () => h.running.app.locals.db.prepare('SELECT status, results_json AS results FROM invoice_checks WHERE run_id = ? ORDER BY id').all(detail.run.id);
  assert.ok(audits().some(row => row.results?.includes('external_registered')));
  h.state.lookup = async () => { throw new Error('가상 조회 장애'); };
  const response = await h.request(`/api/invoices/${detail.run.id}/check`, { method: 'POST' });
  assert.ok([200, 400].includes(response.status));
  const after = await h.read(`/api/invoices/${detail.run.id}`);
  assert.equal(after.outsideOrders[0].state, 'unknown'); assert.equal(after.outsideOrders[0].externalRegistration, false);
  assert.deepEqual(after.outsideOrders[0].evidence, []); assert.deepEqual(after.outsideOrders[0].trackingNumbers, []);
  assert.ok(audits().some(row => row.results?.includes('external_registered')), '이전 성공은 현재 완료 표시 대신 감사 기록으로 보존합니다.');
  assert.ok(audits().length >= 2);
  assert.equal(after.items.length, 1);
  assert.notEqual(await boardState(), 'complete');
});

test('최종 네이버 파일 밖 주문의 상태별 등록 근거를 보수적으로 판정한다', async t => {
  const cases = [
    ['배송완료', 'external_registered', order => [registeredOrder(order, { status: 'DELIVERED', deliveryStatus: 'DELIVERED' })]],
    ['구매확정', 'external_registered', order => [registeredOrder(order, { status: 'PURCHASE_DECIDED', deliveryStatus: 'DELIVERED' })]],
    ['미등록', 'pending', order => [registeredOrder(order, { status: 'PAYED', deliveryStatus: '', trackingNumber: '', deliveryCompanyCode: '' })]],
    ['취소완료', 'canceled', order => [registeredOrder(order, { status: 'CANCELED', remainQuantity: 0, trackingNumber: '', deliveryCompanyCode: '' })]],
    ['반품완료', 'returned', order => [registeredOrder(order, { status: 'RETURNED', remainQuantity: 0, claimStatus: 'RETURN_DONE' })]],
    ['잘못된송장', 'attention', order => [registeredOrder(order, { isWrongTrackingNumber: true, deliveryStatus: 'WRONG_INVOICE' })]],
    ['송장없음', 'attention', order => [registeredOrder(order, { trackingNumber: '' })]],
    ['주문번호불일치', 'unknown', order => [registeredOrder(order, { orderId: '9999999999999999' })]],
    ['일부상품누락', 'unknown', () => []],
    ['응답상품번호불일치', 'unknown', order => [registeredOrder(order, { productOrderId: '9999999999999999' })]],
    ['필수응답필드누락', 'unknown', order => [registeredOrder(order, { remainQuantity: undefined })]],
    ['상세조회실패', 'unknown', () => { throw new Error('가상 상세조회 장애'); }],
  ];
  for (const [name, expected, details] of cases) await t.test(name, async t => {
    const scenario = smallScenario(), h = await boot(t, scenario), order = scenario.manualOrders[0];
    h.state.detail = async ids => ids.includes(order.productOrderId) ? details(order) : ids.map(id => registeredOrder(h.all.get(id)));
    const detail = await h.importInvoices();
    assert.equal(detail.outsideOrders[0].state, expected);
    assert.equal(detail.outsideOrders[0].externalRegistration, expected === 'external_registered');
    assert.equal(detail.items.length, 1); assert.equal(detail.items[0].productOrderId, scenario.pendingOrders[0].productOrderId);
    const output = await h.request(`/api/invoices/${detail.run.id}/export`); assert.equal(output.status, 200);
    assert.deepEqual(outputIds(await output.arrayBuffer()), [scenario.pendingOrders[0].productOrderId]);
  });
});

test('상품주문 일부만 등록된 주문과 빈 조회는 전체 등록 완료가 아니다', async t => {
  for (const mode of ['mixed', 'different_tracking', 'empty']) await t.test(mode, async t => {
    const scenario = smallScenario(), h = await boot(t, scenario), order = scenario.manualOrders[0];
    const extra = { ...order, productOrderId: '2026103199999999' };
    h.all.set(extra.productOrderId, extra);
    h.state.lookup = async () => mode === 'empty' ? [] : [order.productOrderId, extra.productOrderId];
    h.state.detail = async ids => ids.map(id => registeredOrder(h.all.get(id), id === extra.productOrderId
      ? mode === 'mixed' ? { status: 'PAYED', deliveryStatus: '', trackingNumber: '', deliveryCompanyCode: '' }
        : { trackingNumber: '990000000001' } : {}));
    const detail = await h.importInvoices();
    assert.equal(detail.outsideOrders[0].state, mode === 'empty' ? 'unknown' : 'attention');
    assert.equal(detail.outsideOrders[0].externalRegistration, false);
  });
});

test('같은 내부 출고번호에 다른 주문번호가 있으면 외부 조회만으로 출고 전체를 완료시키지 않는다', async t => {
  const scenario = smallScenario(), h = await boot(t, scenario), order = scenario.manualOrders[0];
  const other = { ...order, orderId: '2026103199999998', productOrderId: '2026103199999999' };
  h.all.set(other.productOrderId, other);
  await h.addSource(sourceFile([other], '가상_내부출고충돌.xlsx'), order.date);
  const detail = await h.importInvoices();
  assert.equal(detail.outsideOrders.length, 2);
  assert.ok(detail.outsideOrders.every(row => row.state !== 'external_registered' && !row.externalRegistration));
  const board = await h.read('/api/shipping/board?date=2026-10-31');
  assert.notEqual(board.groups.find(group => group.shipments.some(row => row.id === 'order:' + order.internalId)).invoiceState, 'complete');
});

test('같은 주문번호는 한 번 조회하고 다른 날짜·타몰·삭제 주문은 조회하지 않는다', async t => {
  const scenario = smallScenario(), h = await boot(t, scenario), outside = scenario.manualOrders[0];
  await h.addSource(sourceFile([outside], '가상_중복저장.xlsx'), outside.date);
  const past = { ...outside, orderId: '2026090100000001', internalId: 'PAST-001' };
  await h.addSource(sourceFile([past]), '2026-09-01');
  const otherMall = { ...outside, orderId: '2026103100999998', internalId: 'OTHER-MALL-001' };
  await h.addSource(workbookFile('가상_타몰.xlsx', sourceHeaders, [[otherMall.productName, otherMall.internalId, otherMall.orderId,
    otherMall.recipient, otherMall.phone, otherMall.address, 1, '쿠팡']]), outside.date);
  const deleted = { ...outside, orderId: '2026103100999999', internalId: 'DELETED-001' };
  const deletedBatch = await h.addSource(sourceFile([deleted]), outside.date);
  const removal = await h.request(`/api/batches/${deletedBatch.batch.id}`, { method: 'DELETE' }); assert.equal(removal.status, 200);
  const deletedRow = await h.addSource(sourceFile([{ ...deleted, orderId: '2026103100999997', internalId: 'DELETED-ROW-001' }]), outside.date);
  const rowRemoval = await h.request(`/api/batches/${deletedRow.batch.id}/rows`, json('DELETE', { rowIds: [deletedRow.rows[0].id] }));
  assert.equal(rowRemoval.status, 200);
  const detail = await h.importInvoices();
  assert.deepEqual(h.state.lookupCalls, [outside.orderId]); assert.equal(detail.outsideOrders.length, 2);
  assert.ok(detail.outsideOrders.every(row => row.state === 'external_registered'));
});

test('조회 기능이 없는 기존 클라이언트는 실제 호출 없이 미확인으로 남긴다', async t => {
  const h = await boot(t, smallScenario(), { outside: false }), detail = await h.importInvoices();
  assert.equal(detail.outsideOrders[0].state, 'unknown'); assert.equal(detail.outsideOrders[0].externalRegistration, false);
  assert.equal(h.state.detailCalls.length, 0);
});

test('조회 중 원본 삭제 또는 새 매칭이 생기면 늦게 도착한 응답으로 완료시키지 않는다', async t => {
  for (const change of ['source_deleted', 'new_run']) await t.test(change, async t => {
    const scenario = smallScenario(), h = await boot(t, scenario), initial = await h.importInvoices();
    let begin, release;
    const began = new Promise(resolve => { begin = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    h.state.lookup = async () => { begin(); await blocked; return [scenario.manualOrders[0].productOrderId]; };
    const checking = refreshOutsideInvoiceStatus(h.running.app.locals.db, initial.run.id, h.naver);
    await began;
    if (change === 'source_deleted') {
      const deleted = await h.request(`/api/batches/${h.batches[0].batch.id}/rows`, json('DELETE', { rowIds: [h.batches[0].rows[0].id] }));
      assert.equal(deleted.status, 200);
    } else {
      const workbook = XLSX.read(scenario.naverFile.buffer, { type: 'buffer' });
      XLSX.utils.sheet_add_aoa(workbook.Sheets[workbook.SheetNames[0]], [['다운로드 구분'], ['조회중 다시 받은 파일']], { origin: 'M1' });
      const replacement = { ...scenario.naverFile, buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) };
      const newer = importInvoiceFiles(h.running.app.locals.db, { naverFiles: [replacement], courierFiles: [scenario.courierFile],
        carrier: { code: 'KGB', name: '로젠택배' }, sourceDate: scenario.sourceDate });
      assert.notEqual(newer.run.id, initial.run.id);
    }
    release();
    await checking.catch(() => {});
    const current = await h.read(`/api/invoices/${initial.run.id}`);
    assert.ok(current.outsideOrders.every(row => row.state !== 'external_registered' && !row.externalRegistration));
    const sourceRows = await h.dayOrders(0);
    assert.ok(sourceRows.every(row => row.state !== 'external_registered'), '원래 날짜 화면에도 오래된 완료가 남지 않습니다.');
  });
});

test('현재 파일 조회가 실패해도 파일 밖 주문의 독립적인 등록 확인은 수행한다', async t => {
  const scenario = smallScenario(), h = await boot(t, scenario), initial = await h.importInvoices();
  h.state.detail = async ids => {
    if (ids.includes(scenario.pendingOrders[0].productOrderId)) throw new Error('가상 현재 파일 조회 실패');
    return ids.map(id => registeredOrder(h.all.get(id)));
  };
  const beforeCalls = h.state.lookupCalls.length;
  const response = await h.request(`/api/invoices/${initial.run.id}/check`, { method: 'POST' });
  assert.equal(response.status, 400);
  const after = await h.read(`/api/invoices/${initial.run.id}`);
  assert.equal(h.state.lookupCalls.length, beforeCalls + 1);
  assert.equal(after.outsideOrders[0].state, 'external_registered');
  assert.equal(after.items[0].registrationState, 'unchecked');
});

test('같은 작업의 늦은 이전 조회는 더 최근 조회 결과를 성공·실패 어느 쪽으로도 덮어쓰지 않는다', async t => {
  for (const outcome of ['older_failure', 'older_success']) await t.test(outcome, async t => {
    const scenario = smallScenario(), h = await boot(t, scenario), initial = await h.importInvoices(), order = scenario.manualOrders[0];
    let begin, release;
    const began = new Promise(resolve => { begin = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    const oldClient = {
      getProductOrderIds: async () => { begin(); await blocked; if (outcome === 'older_failure') throw new Error('가상 이전 조회 장애'); return [order.productOrderId]; },
      queryProductOrders: async () => [registeredOrder(order)],
    };
    const older = refreshOutsideInvoiceStatus(h.running.app.locals.db, initial.run.id, oldClient);
    await began;
    const expected = outcome === 'older_failure' ? 'external_registered' : 'pending';
    h.state.detail = async ids => ids.map(id => registeredOrder(h.all.get(id), expected === 'pending'
      ? { status: 'PAYED', deliveryStatus: '', trackingNumber: '', deliveryCompanyCode: '' } : {}));
    const newer = await refreshOutsideInvoiceStatus(h.running.app.locals.db, initial.run.id, h.naver);
    assert.equal(newer.outsideOrders[0].state, expected);
    const current = newer.outsideOrders[0];
    release(); await older.catch(() => {});
    const after = await h.read(`/api/invoices/${initial.run.id}`);
    assert.equal(after.outsideOrders[0].state, expected);
    assert.equal(after.outsideOrders[0].checkedAt, current.checkedAt);
    assert.deepEqual(after.outsideOrders[0].evidence, current.evidence);
  });
});
