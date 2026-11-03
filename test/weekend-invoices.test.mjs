import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { createWeekendScenario, sourceFile, naverFile, courierFile, registeredOrder } from './fixtures/weekend-invoices.mjs';

process.env.SYSTEM0_ENV_FILE = path.join(os.tmpdir(), `system0-weekend-absent-${randomUUID()}.env`);
process.env.OPENAI_API_KEY = '';
const { createApp } = await import('../server.mjs');
const json = (method, value) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
const bodyFor = (files, field = 'files') => {
  const body = new FormData();
  for (const file of files) body.append(field, new Blob([file.buffer]), file.name);
  return body;
};
function invoiceBody(scenario, { date = scenario.sourceDate, naver = scenario.naverFile, courier = scenario.courierFile } = {}) {
  const body = bodyFor([naver], 'naverFiles');
  body.append('courierFiles', new Blob([courier.buffer]), courier.name);
  body.append('deliveryCompanyCode', 'KGB'); body.append('sourceDate', date);
  return body;
}
function outputRows(bytes) {
  const book = XLSX.read(Buffer.from(bytes), { type: 'buffer' });
  assert.deepEqual(book.SheetNames, ['발송처리']);
  return XLSX.utils.sheet_to_json(book.Sheets['발송처리'], { header: 1, raw: true }).slice(1);
}
function newDownload(file, note) {
  const book = XLSX.read(file.buffer, { type: 'buffer' });
  XLSX.utils.sheet_add_aoa(book.Sheets[book.SheetNames[0]], [['다운로드 구분'], [note]], { origin: 'M1' });
  return { name: file.name, buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) };
}
async function boot(t, scenario, databasePath = ':memory:') {
  const orders = new Map(scenario.pendingOrders.map(order => [order.productOrderId, order]));
  const state = { mode: 'complete', calls: [] };
  const naver = { queryProductOrders: async ids => {
    state.calls.push([...ids]);
    if (state.mode === 'failure') throw new Error('가상 조회 장애');
    return ids.map((id, index) => {
      const order = orders.get(id); assert.ok(order, '가상 파일에 없는 주문을 조회하지 않습니다.');
      return registeredOrder(order, state.mode === 'pending' ? { status: 'PAYED', deliveryStatus: '', trackingNumber: '', deliveryCompanyCode: '' }
        : state.mode === 'conflict' && index === 0 ? { trackingNumber: '009999999999' } : {});
    });
  } };
  const running = { app: null, server: null, base: '' };
  const stop = async () => {
    if (!running.server) return;
    await new Promise(resolve => { running.server.close(resolve); running.server.closeAllConnections(); });
    running.app.locals.db.close(); running.server = null;
  };
  const start = async () => {
    running.app = createApp({ databasePath, client: null, apiKey: '', publicOrigin: '', naver });
    running.server = await new Promise(resolve => { const value = running.app.listen(0, '127.0.0.1', () => resolve(value)); });
    running.base = `http://127.0.0.1:${running.server.address().port}`;
  };
  t.after(stop); await start();
  const request = (route, options) => {
    assert.ok(route.startsWith('/api/'), '검증은 격리 서버의 업무 API만 호출합니다.');
    return fetch(running.base + route, options);
  };
  const read = async route => { const response = await request(route); assert.equal(response.status, 200); return response.json(); };
  const addSource = async (file, date) => {
    const response = await request('/api/import', { method: 'POST', body: bodyFor([file]) });
    assert.equal(response.status, 201); const detail = await response.json();
    running.app.locals.db.prepare('UPDATE batches SET created_at = ? WHERE id = ?').run(`${date}T00:00:00.000Z`, detail.batch.id);
    const confirmed = await request(`/api/batches/${detail.batch.id}/rows`, json('PATCH', { changes: detail.rows.map(row => ({ id: row.id,
      cleanedName: row.originalName, reviewNote: '', status: 'confirmed' })) }));
    assert.equal(confirmed.status, 200); return detail;
  };
  const batches = [];
  for (const day of scenario.days) batches.push(await addSource(day.file, day.date));
  const importInvoices = async options => {
    const response = await request('/api/invoices/import', { method: 'POST', body: invoiceBody(scenario, options) });
    const result = await response.json(); assert.equal(response.status, 201, result.error); return result;
  };
  const sources = () => Object.fromEntries(['batches', 'sheets', 'source_files', 'rows', 'row_revisions'].map(table =>
    [table, running.app.locals.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
  const dayOrders = async index => (await read(`/api/invoices/orders?batchIds=${encodeURIComponent(JSON.stringify([batches[index].batch.id]))}`)).orders;
  return { state, running, request, read, addSource, batches, importInvoices, sources, dayOrders,
    restart: async () => { await stop(); await start(); } };
}

test('주말 100건 중 수동등록 10건을 제외한 90건을 월요일 한 번에 연결하고 원본 날짜·파일·검토를 보존한다', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'system0-weekend-'));
  const scenario = createWeekendScenario(), h = await boot(t, scenario, path.join(directory, 'fixture.sqlite'));
  t.after(() => {
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('system0-weekend-'));
    rmSync(target, { recursive: true, force: true });
  });
  const before = h.sources();
  assert.equal((await h.read('/api/batches?date=2026-11-02')).batches.length, 1);
  assert.equal((await h.dayOrders(2)).length, 40, '업로드 전에는 선택한 월요일 원본 40행만 조회합니다.');
  let result = await h.importInvoices();
  assert.equal(result.run.sourceDate, '2026-11-02'); assert.equal(result.items.length, 90);
  assert.equal(result.orders.length, 90); assert.equal(result.summary.connected, 90); assert.equal(result.summary.missingSaved, 0);
  assert.equal(result.summary.selectedDate, 40); assert.equal(result.summary.otherDate, 50); assert.equal(result.summary.unknownDate, 0);
  assert.equal(result.summary.issues, 0, '이번 네이버 파일에 없는 수동등록 원본 10건 때문에 검토를 막지 않습니다.');
  assert.ok(result.items.every(item => item.decision === 'include' && item.registrationState === 'unchecked'));
  assert.deepEqual(result.items.map(item => item.productOrderId), scenario.pendingOrders.map(order => order.productOrderId));
  assert.ok(scenario.manualOrders.every(order => !result.items.some(item => item.productOrderId === order.productOrderId)));
  assert.deepEqual(h.sources(), before, '다른 날짜의 원본을 복제·이동하거나 수작업 완료로 변경하지 않습니다.');
  assert.equal(h.state.calls.length, 0, '파일 매칭 중 실제 또는 모의 등록 조회도 자동 호출하지 않습니다.');
  assert.equal((await h.read('/api/invoices/latest?date=2026-10-31')).invoice, null);
  assert.equal((await h.read('/api/invoices/latest?date=2026-11-01')).invoice, null);
  assert.equal((await h.read('/api/invoices/latest?date=2026-11-02')).invoice.run.id, result.run.id);
  const saturday = await h.dayOrders(0), sunday = await h.dayOrders(1);
  assert.equal(saturday.length, 20); assert.equal(saturday.filter(row => row.trackingNumbers.length).length, 10);
  assert.equal(sunday.length, 40); assert.ok(sunday.every(row => row.trackingNumbers.length === 1 && row.latestRunId === result.run.id));
  assert.ok(saturday.filter(row => !row.trackingNumbers.length).every(row => !['complete', 'ready'].includes(row.state)), '네이버 파일 부재만으로 수동등록 완료를 단정하지 않습니다.');
  assert.ok([...saturday, ...sunday].filter(row => row.trackingNumbers.length).every(row => row.processingDate === scenario.sourceDate));
  const reviewed = await h.request(`/api/invoices/${result.run.id}/items`, json('PATCH', { changes: [{ id: result.items[0].id, decision: 'include', note: '가상 담당자 검토 완료' }] }));
  assert.equal(reviewed.status, 200);
  const repeated = await h.importInvoices(); assert.equal(repeated.run.id, result.run.id); assert.equal(repeated.items[0].note, '가상 담당자 검토 완료');
  const exported = await h.request(`/api/invoices/${result.run.id}/export`); assert.equal(exported.status, 200);
  const bytes = Buffer.from(await exported.arrayBuffer()), rows = outputRows(bytes);
  assert.equal(rows.length, 90); assert.equal(new Set(rows.map(row => row[0])).size, 90);
  assert.ok(rows.every(row => scenario.pendingOrders.some(order => order.productOrderId === row[0] && order.trackingNumber === row[3])));
  const checked = await h.request(`/api/invoices/${result.run.id}/check`, { method: 'POST' }); assert.equal(checked.status, 200);
  result = await checked.json(); assert.ok(result.items.every(item => item.registrationState === 'complete' && item.statusFresh));
  assert.equal(h.state.calls.length, 1); assert.equal(h.state.calls[0].length, 90);
  const sameBytes = await h.importInvoices();
  assert.equal(sameBytes.run.id, result.run.id);
  assert.ok(sameBytes.items.every(item => item.registrationState === 'complete' && item.statusFresh));
  assert.equal((await h.request(`/api/invoices/${sameBytes.run.id}/export`)).status, 400, '같은 원본의 재업로드는 확인된 완료를 지우거나 중복 엑셀을 생성하지 않습니다.');
  assert.equal((await h.dayOrders(0)).filter(row => row.state === 'complete').length, 10);
  assert.equal((await h.dayOrders(1)).filter(row => row.state === 'complete').length, 40);
  const board = await h.read('/api/shipping/board?date=2026-10-31');
  assert.equal(board.groups.flatMap(group => group.shipments).filter(row => scenario.manualOrders.some(order => row.id === 'order:' + order.internalId)).length, 10);
  await h.restart();
  const resumed = (await h.read('/api/invoices/latest?date=2026-11-02')).invoice;
  assert.equal(resumed.run.id, result.run.id); assert.equal(resumed.items[0].note, '가상 담당자 검토 완료');
  const saved = await h.request(`/api/invoices/${result.run.id}/download`); assert.equal(saved.status, 200);
  assert.deepEqual(Buffer.from(await saved.arrayBuffer()), bytes, '재시작·등록 확인 후에도 생성한 엑셀을 같은 바이트로 내려받습니다.');
  assert.deepEqual(h.sources(), before);
});

test('일요일에도 5건을 수동등록한 경우 네이버에 남은 85건만 출력하고 과거 송장 참고행을 강제 검수하지 않는다', async t => {
  const scenario = createWeekendScenario({ sundayManual: 5 }), h = await boot(t, scenario);
  const result = await h.importInvoices({ courier: courierFile(scenario.allOrders) });
  assert.equal(result.items.length, 85); assert.equal(result.summary.selectedDate, 40); assert.equal(result.summary.otherDate, 45);
  assert.equal(result.summary.issues, 0); assert.equal(result.items.filter(item => item.decision === 'include').length, 85);
  const exported = await h.request(`/api/invoices/${result.run.id}/export`); assert.equal(exported.status, 200);
  const rows = outputRows(await exported.arrayBuffer()); assert.equal(rows.length, 85);
  assert.ok(scenario.manualOrders.every(order => !rows.some(row => row[0] === order.productOrderId)));
});

test('선택한 날짜에 새 원본이 없어도 과거 대기 주문을 연결하고 처리 기준일로 재개한다', async t => {
  const scenario = createWeekendScenario(), h = await boot(t, scenario);
  assert.equal((await h.read('/api/batches?date=2026-11-03')).batches.length, 0);
  const result = await h.importInvoices({ date: '2026-11-03' });
  assert.equal(result.run.sourceDate, '2026-11-03'); assert.equal(result.items.length, 90);
  assert.equal(result.summary.selectedDate, 0); assert.equal(result.summary.otherDate, 90);
  assert.equal((await h.read('/api/invoices/latest?date=2026-11-03')).invoice.run.id, result.run.id);
});

test('동명이인 원본 누락 두 건과 송장 누락 한 건은 보류하고 경고 확인만으로 포함시키지 않는다', async t => {
  const base = createWeekendScenario();
  const scenario = createWeekendScenario({ orphanCount: 2, missingCourierIds: [base.pendingOrders[0].internalId] });
  const h = await boot(t, scenario), result = await h.importInvoices();
  assert.equal(result.items.length, 92); assert.equal(result.summary.missingSaved, 2);
  const orphan = result.items.filter(item => scenario.orphanOrders.some(order => order.productOrderId === item.productOrderId));
  assert.equal(orphan.length, 2); assert.ok(orphan.every(item => item.decision === 'hold' && !item.trackingNumber && !item.sourceRows.length));
  assert.equal(result.orders.filter(row => row.sourceType === 'naver_only').length, 2);
  assert.equal(result.items.filter(item => item.decision === 'hold').length, 3);
  assert.equal((await h.request(`/api/invoices/${result.run.id}/export`)).status, 400);
  const acknowledged = await h.request(`/api/invoices/${result.run.id}/items`, json('PATCH', {
    issueResolutions: result.issues.filter(issue => issue.reviewRequired).map(issue => ({ key: issue.key, note: '가상 누락 주문 확인' })) }));
  assert.equal(acknowledged.status, 200);
  const forced = await h.request(`/api/invoices/${result.run.id}/items`, json('PATCH', { changes: [{ id: orphan[0].id, decision: 'include', note: '강제 포함 시도' }] }));
  assert.equal(forced.status, 400);
  const output = await h.request(`/api/invoices/${result.run.id}/export`); assert.equal(output.status, 200);
  assert.equal(outputRows(await output.arrayBuffer()).length, 89);
});

test('같은 출고를 다른 날짜에 재업로드해도 상품주문은 한 번만 출력하고 무관한 원본 추가는 재매칭을 요구하지 않는다', async t => {
  const scenario = createWeekendScenario(), h = await boot(t, scenario);
  const duplicate = scenario.pendingOrders[0];
  await h.addSource(sourceFile([duplicate], '가상_동일출고_재업로드.xlsx'), '2026-11-02');
  const result = await h.importInvoices();
  assert.equal(result.items.length, 90); assert.equal(result.summary.selectedDate, 40); assert.equal(result.summary.otherDate, 50);
  const item = result.items.find(item => item.productOrderId === duplicate.productOrderId);
  assert.equal(item.sourceRows.length, 2); assert.equal(item.sourceDate, '2026-10-31');
  const output = await h.request(`/api/invoices/${result.run.id}/export`); assert.equal(output.status, 200);
  assert.equal(outputRows(await output.arrayBuffer()).filter(row => row[0] === duplicate.productOrderId).length, 1);
  await h.addSource(sourceFile(scenario.manualOrders.slice(0, 1), '가상_이번대상아닌_원본.xlsx'), '2026-11-02');
  const repeated = await h.importInvoices(); assert.equal(repeated.run.id, result.run.id); assert.equal(repeated.summary.issues, 0);
});

test('과거 조회 완료와 새 발송대기 파일이 모순되면 완료를 캐리해 자동 누락하지 않고 다시 조회한다', async t => {
  const scenario = createWeekendScenario(), h = await boot(t, scenario);
  const first = await h.importInvoices();
  assert.equal((await h.request(`/api/invoices/${first.run.id}/check`, { method: 'POST' })).status, 200);
  const second = await h.importInvoices({ naver: newDownload(scenario.naverFile, '새 발송대기 다운로드') });
  assert.notEqual(second.run.id, first.run.id);
  assert.ok(second.items.every(item => item.registrationState !== 'complete' && !item.sourceRegistered));
  assert.ok(second.items.every(item => item.decision === 'hold'));
  assert.equal((await h.request(`/api/invoices/${second.run.id}/export`)).status, 400, '새 파일과 과거 완료 기록이 모순되면 재조회 전 출력하지 않습니다.');
  const recheckWarnings = second.issues.filter(issue => issue.kind === 'registration_recheck');
  assert.ok(recheckWarnings.length);
  const acknowledged = await h.request(`/api/invoices/${second.run.id}/items`, json('PATCH', {
    issueResolutions: recheckWarnings.map(issue => ({ key: issue.key, note: '체크만으로 확인 시도' })) }));
  assert.equal(acknowledged.status, 400, '등록 재확인이 필요한 경고는 확인 체크로 해제하지 않습니다.');
  h.state.mode = 'pending';
  const pending = await h.request(`/api/invoices/${second.run.id}/check`, { method: 'POST' }); assert.equal(pending.status, 200);
  assert.ok((await pending.json()).items.every(item => item.registrationState === 'pending' && item.decision === 'include'));
  const output = await h.request(`/api/invoices/${second.run.id}/export`); assert.equal(output.status, 200);
  assert.equal(outputRows(await output.arrayBuffer()).length, 90);
  h.state.mode = 'conflict';
  const conflict = await h.request(`/api/invoices/${second.run.id}/check`, { method: 'POST' }); assert.equal(conflict.status, 200);
  assert.equal((await conflict.json()).items.filter(item => item.registrationState === 'conflict').length, 1);
  assert.equal((await h.request(`/api/invoices/${second.run.id}/export`)).status, 400);
  h.state.mode = 'failure';
  assert.equal((await h.request(`/api/invoices/${second.run.id}/check`, { method: 'POST' })).status, 400);
  const failed = await h.read(`/api/invoices/${second.run.id}`);
  assert.ok(failed.items.every(item => !item.statusFresh && item.registrationState === 'unchecked'));
});

test('등록 재조회가 성공해도 직원이 별도로 보류·제외한 결정과 검토 메모를 유지한다', async t => {
  const scenario = createWeekendScenario(), h = await boot(t, scenario);
  const first = await h.importInvoices();
  assert.equal((await h.request(`/api/invoices/${first.run.id}/check`, { method: 'POST' })).status, 200);
  const second = await h.importInvoices({ naver: newDownload(scenario.naverFile, '직원 보류 유지용 새 파일') });
  const changed = await h.request(`/api/invoices/${second.run.id}/items`, json('PATCH', { changes: [
    { id: second.items[0].id, decision: 'hold', note: '가상 담당자 별도 확인 중' },
    { id: second.items[1].id, decision: 'exclude', note: '가상 담당자 이번 처리 제외' },
  ] }));
  assert.equal(changed.status, 200);
  h.state.mode = 'pending';
  const response = await h.request(`/api/invoices/${second.run.id}/check`, { method: 'POST' }); assert.equal(response.status, 200);
  const checked = await response.json();
  assert.equal(checked.items[0].decision, 'hold'); assert.equal(checked.items[0].note, '가상 담당자 별도 확인 중');
  assert.equal(checked.items[1].decision, 'exclude'); assert.equal(checked.items[1].note, '가상 담당자 이번 처리 제외');
  assert.ok(checked.items.slice(2).every(item => item.decision === 'include'));
  const output = await h.request(`/api/invoices/${second.run.id}/export`); assert.equal(output.status, 200);
  assert.equal(outputRows(await output.arrayBuffer()).length, 88);
});
