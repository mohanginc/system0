import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { sourceFile, naverFile, courierFile, registeredOrder } from './fixtures/weekend-invoices.mjs';

process.env.SYSTEM0_ENV_FILE = path.join(os.tmpdir(), `system0-rounds-absent-${randomUUID()}.env`);
process.env.OPENAI_API_KEY = '';
const { createApp } = await import('../server.mjs');
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const counts = rows => rows.reduce((out, row) => { out[row.state] = (out[row.state] || 0) + 1; return out; }, {});
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const compact = value => String(value ?? '').normalize('NFC').replace(/\s/g, '');
const phone = value => String(value ?? '').replace(/[^0-9*]/g, '');

function order(date, index) {
  const day = date.replaceAll('-', ''), number = index + 1;
  return { date, productOrderId: day + String(10000 + number).padStart(8, '0'), orderId: day + String(20000 + number).padStart(8, '0'),
    internalId: `ROUND-${day}-${number}`, trackingNumber: '99' + day.slice(4) + String(number).padStart(6, '0'),
    recipient: `가상 ${date} 수취인 ${number}`, phone: `010-0000-${String(number).padStart(4, '0')}`,
    address: `서울 테스트구 테스트로 ${number} 101호`, productName: `가상 쿠션 ${number % 3 + 1}`,
    optionName: '선택 옵션: 가상 커버', quantity: 1 };
}

function scenario() {
  const saturday = Array.from({ length: 45 }, (_, i) => order('2026-11-07', i));
  saturday[42].canceled = true; saturday[43].canceled = true; saturday[44].internalId = '';
  const sunday = Array.from({ length: 40 }, (_, i) => order('2026-11-08', i));
  for (let i = 32; i < 40; i++) sunday[i].orderId = `20261108-${String(i + 1).padStart(7, '0')}`;
  const mondayMorning = Array.from({ length: 23 }, (_, i) => order('2026-11-09', i));
  for (let i = 15; i < 20; i++) mondayMorning[i].orderId = `20261109-${String(i + 1).padStart(7, '0')}`;
  mondayMorning[20].canceled = true;
  mondayMorning[21].productName = '가상 원문 커버 A'; mondayMorning[21].cleanedName = '가상 공통 검수명';
  mondayMorning[22].internalId = ''; mondayMorning[22].orderId = '';
  const mondayAfternoon = Array.from({ length: 11 }, (_, i) => order('2026-11-09', i + 23));
  mondayAfternoon.push({ ...mondayMorning[21], productName: '가상 원문 커버 B' });
  return { saturday, sunday, mondayMorning, mondayAfternoon,
    all: [...saturday, ...sunday, ...mondayMorning, ...mondayAfternoon],
    morningTargets: [...saturday.slice(0, 20), ...sunday.slice(0, 32), ...mondayMorning.slice(0, 15), mondayMorning[20], mondayMorning[21]],
    afternoonTargets: [...sunday.slice(0, 32), ...mondayMorning.slice(0, 15), ...mondayAfternoon.slice(0, 11)] };
}

function outputRows(buffer) {
  const workbook = XLSX.read(Buffer.from(buffer), { type: 'buffer' });
  return XLSX.utils.sheet_to_json(workbook.Sheets['발송처리'], { header: 1, raw: true }).slice(1);
}

async function boot(t, orders, { persistent = false } = {}) {
  const directory = persistent ? mkdtempSync(path.join(os.tmpdir(), 'system0-rounds-')) : null;
  const databasePath = directory ? path.join(directory, 'fixture.sqlite') : ':memory:';
  const all = new Map(orders.map(value => [value.productOrderId, value]));
  const state = { lookupCalls: [], detailCalls: [], lookup: null, detail: null };
  const naver = {
    getProductOrderIds: async orderId => { state.lookupCalls.push(orderId); return state.lookup ? state.lookup(orderId)
      : [...all.values()].filter(value => value.orderId === orderId).map(value => value.productOrderId); },
    queryProductOrders: async ids => { state.detailCalls.push([...ids]); return state.detail ? state.detail(ids) : ids.map(id => {
      assert.ok(all.has(id), '가상 주문만 조회합니다.'); const value = all.get(id);
      return registeredOrder(value, value.canceled ? { status: 'CANCELED', remainQuantity: 0, trackingNumber: '', deliveryCompanyCode: '' } : {});
    }); },
  };
  const running = { app: null, server: null, base: '' };
  const start = async () => {
    running.app = createApp({ databasePath, apiKey: '', client: null, publicOrigin: '', naver });
    running.server = await new Promise(resolve => { const server = running.app.listen(0, '127.0.0.1', () => resolve(server)); });
    running.base = `http://127.0.0.1:${running.server.address().port}`;
  };
  const stop = async () => {
    if (!running.server) return;
    await new Promise(resolve => { running.server.close(resolve); running.server.closeAllConnections(); });
    running.app.locals.db.close(); running.server = null;
  };
  t.after(async () => {
    await stop();
    if (directory) {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('system0-rounds-'));
      rmSync(directory, { recursive: true, force: true });
    }
  });
  await start();
  const request = (route, options) => { assert.ok(route.startsWith('/api/')); return fetch(running.base + route, options); };
  const read = async route => { const response = await request(route); assert.equal(response.status, 200); return response.json(); };
  const addSource = async (values, name, createdAt) => {
    const file = sourceFile(values, name), body = new FormData(); body.append('files', new Blob([file.buffer]), file.name);
    const response = await request('/api/import', { method: 'POST', body }); const result = await response.json(); assert.equal(response.status, 201, result.error);
    running.app.locals.db.prepare('UPDATE batches SET created_at=? WHERE id=?').run(createdAt, result.batch.id);
    const reviewed = await request(`/api/batches/${result.batch.id}/rows`, json('PATCH', { changes: result.rows.map((row, i) => ({
      id: row.id, cleanedName: values[i].cleanedName || values[i].productName, reviewNote: '', status: 'confirmed' })) }));
    assert.equal(reviewed.status, 200); return result;
  };
  const importInvoice = async (targets, parcels, label, createdAt) => {
    const body = new FormData(), naver = naverFile(targets, `가상_${label}_네이버.xlsx`), courier = courierFile(parcels, `가상_${label}_로젠.xlsx`);
    body.append('naverFiles', new Blob([naver.buffer]), naver.name); body.append('courierFiles', new Blob([courier.buffer]), courier.name);
    body.append('sourceDate', '2026-11-09'); body.append('deliveryCompanyCode', 'KGB');
    const response = await request('/api/invoices/import', { method: 'POST', body }); const result = await response.json(); assert.equal(response.status, 201, result.error);
    if (createdAt) running.app.locals.db.prepare('UPDATE invoice_runs SET created_at=? WHERE id=?').run(createdAt, result.run.id);
    return read(`/api/invoices/${result.run.id}`);
  };
  const acknowledge = async detail => {
    const issues = detail.issues.filter(value => value.reviewRequired !== false && !value.resolved && value.kind !== 'registration_recheck');
    if (!issues.length) return detail;
    const response = await request(`/api/invoices/${detail.run.id}/items`, json('PATCH', { issueResolutions: issues.map(value => ({ key: value.key, note: '가상 담당자 확인' })) }));
    const result = await response.json(); assert.equal(response.status, 200, result.error); return result;
  };
  const exportFile = async id => { const response = await request(`/api/invoices/${id}/export`); assert.equal(response.status, 200, await response.clone().text()); return Buffer.from(await response.arrayBuffer()); };
  const day = async batchId => (await read(`/api/invoices/orders?batchIds=${encodeURIComponent(JSON.stringify([batchId]))}`)).orders;
  const sourceSnapshot = () => Object.fromEntries(['batches', 'sheets', 'source_files', 'rows', 'row_revisions'].map(table => [table,
    running.app.locals.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
  return { running, state, all, naver, request, read, addSource, importInvoice, acknowledge, exportFile, day, sourceSnapshot,
    restart: async () => { await stop(); await start(); } };
}

// Persist the c057214 contract, independently of any new per-order snapshot fields.
function useLegacyContract(db, runId) {
  const run = db.prepare('SELECT * FROM invoice_runs WHERE id=?').get(runId), savedScope = JSON.parse(run.scope_json);
  const keep = (value, names) => Object.fromEntries(names.filter(name => name in value).map(name => [name, value[name]]));
  const scope = keep(savedScope, ['sourceDate', 'orderIds', 'evidenceInternalIds', 'batchIds', 'outsideBatchIds', 'sourceRowIds', 'inputFingerprint', 'matchingVersion', 'outsideCheckId', 'outsideCheckedAt']);
  const originals = db.prepare(`SELECT r.*, b.created_at, s.raw_json,s.header_index FROM rows r JOIN batches b ON b.id=r.batch_id
    JOIN sheets s ON s.id=r.sheet_id WHERE r.is_deleted=0 AND b.is_deleted=0 ORDER BY r.id`).all().map(row => {
      const raw = JSON.parse(row.raw_json), headers = raw[row.header_index], cells = raw[row.source_row - 1], get = name => cells[headers.indexOf(name)] ?? '';
      return { rowId: row.id, internal: String(get('주문번호')), order: String(get('체결번호')), supported: true,
        recipient: String(get('송화주')), phone: String(get('전화번호')), address: String(get('주소')), original: row.original_name,
        quantity: Number(get('수량')), createdAt: row.created_at };
    });
  const signature = rows => hash(rows.map(row => JSON.stringify([row.rowId, row.internal, row.order, row.supported,
    compact(row.recipient), phone(row.phone), compact(row.address), row.original])).sort());
  const basis = row => hash([signature([row]), row.quantity, row.createdAt,
    signature(originals.filter(other => other.order === row.order || row.internal && other.internal === row.internal))]);
  const evidence = originals.filter(row => scope.orderIds.includes(row.order) || scope.evidenceInternalIds.includes(row.internal));
  scope.matchingVersion = 'final-naver-all-dates-v3';
  scope.outsideOrders = (savedScope.outsideOrders || []).map(proof => ({ ...keep(proof,
    ['rowId', 'orderId', 'state', 'reason', 'productOrderIds', 'trackingNumbers', 'evidence', 'checkedAt']), binding: basis(originals.find(row => row.rowId === proof.rowId)) }));
  db.prepare('UPDATE invoice_runs SET scope_json=?,legacy_signature=? WHERE id=?').run(JSON.stringify(scope), signature(evidence), runId);
  for (const item of db.prepare('SELECT id,expected_json,source_rows_json FROM invoice_items WHERE run_id=?').all(runId)) {
    const expected = keep(JSON.parse(item.expected_json), ['productOrderId', 'orderId', 'quantity', 'productName', 'optionName', 'recipient', 'phone', 'address',
      'status', 'detailStatus', 'sourceTrackingNumber', 'sourceCarrier', 'sources', 'registrationRecheck', 'sourceComplete', 'cleanedName']);
    const sources = JSON.parse(item.source_rows_json).map(value => keep(value, ['rowId', 'batchId', 'sheetId', 'fileId', 'sourceFile', 'sourceSheet', 'sourceRow', 'batchCreatedAt']));
    db.prepare('UPDATE invoice_items SET expected_json=?,source_rows_json=? WHERE id=?').run(JSON.stringify(expected), JSON.stringify(sources), item.id);
  }
}

test('오전20건 생성 후 주문 추가·오후58건을 처리해도 기존 주말 결과와 두 엑셀을 보존한다', async t => {
  const fixture = scenario(), h = await boot(t, fixture.all, { persistent: true });
  const saturday = await h.addSource(fixture.saturday, '가상_토요일.xlsx', '2026-11-07T05:12:38.000Z');
  const sunday = await h.addSource(fixture.sunday, '가상_일요일.xlsx', '2026-11-08T11:32:45.000Z');
  let morning = await h.importInvoice(fixture.morningTargets, fixture.saturday, '오전', '2026-11-09T01:13:15.000Z');
  assert.equal(morning.items.length, 69); assert.equal(morning.summary.included, 20); assert.equal(morning.summary.held, 49);
  morning = await h.acknowledge(morning);
  const note = await h.request(`/api/invoices/${morning.run.id}/items`, json('PATCH', { changes: [{ id: morning.items[0].id, decision: 'include', note: '가상 오전 담당자 메모' }] }));
  assert.equal(note.status, 200);
  const morningBytes = await h.exportFile(morning.run.id); assert.equal(outputRows(morningBytes).length, 20);
  useLegacyContract(h.running.app.locals.db, morning.run.id);
  const mondayMorning = await h.addSource(fixture.mondayMorning, '가상_월요일_오전.xlsx', '2026-11-09T01:20:15.000Z');
  const mondayAfternoon = await h.addSource(fixture.mondayAfternoon, '가상_월요일_오후.xlsx', '2026-11-09T06:06:54.000Z');
  const originals = h.sourceSnapshot();
  let afternoon = await h.importInvoice(fixture.afternoonTargets, [...fixture.sunday, ...fixture.mondayMorning, ...fixture.mondayAfternoon], '오후', '2026-11-09T07:06:48.000Z');
  assert.equal(afternoon.items.length, 58); assert.equal(afternoon.summary.included, 58); assert.equal(afternoon.summary.held, 0);
  afternoon = await h.acknowledge(afternoon);
  const afternoonBytes = await h.exportFile(afternoon.run.id), afternoonRows = outputRows(afternoonBytes), morningRows = outputRows(morningBytes);
  assert.equal(afternoonRows.length, 58);
  assert.equal(morningRows.filter(row => afternoonRows.some(other => other[0] === row[0])).length, 0, '서로 다른 차수는 같은 상품주문을 다시 출력하지 않습니다.');
  const sat = await h.day(saturday.batch.id), sun = await h.day(sunday.batch.id);
  assert.equal(sat.length, 45); assert.equal(sat.filter(row => row.state === 'ready').length, 20);
  assert.equal(sat.filter(row => row.state === 'external_registered').length, 22);
  assert.equal(sat.filter(row => row.state === 'canceled').length, 2);
  assert.equal(sat.filter(row => row.state === 'attention').length, 1);
  assert.ok(sat.every(row => !['hold', 'unknown'].includes(row.state)), '다른 차수 때문에 무관한 토요일 근거가 무효화되지 않습니다.');
  assert.equal(sun.filter(row => row.state === 'ready').length, 32);
  assert.equal(sun.filter(row => row.state === 'naver_not_applicable').length, 8);
  const monday = [...await h.day(mondayMorning.batch.id), ...await h.day(mondayAfternoon.batch.id)];
  assert.equal(monday.filter(row => row.state === 'naver_not_applicable').length, 5);
  assert.ok(!h.state.lookupCalls.some(value => /^\d{8}-\d{7}$/.test(value)), '확인된 다른 번호 형식은 네이버 API에 보내지 않습니다.');
  const former = await h.read(`/api/invoices/${morning.run.id}`);
  assert.equal(former.items[0].note, '가상 오전 담당자 메모');
  assert.ok(former.items.filter(item => fixture.saturday.slice(0, 20).some(value => value.productOrderId === item.productOrderId)).every(item => !item.issues.some(key => former.issues.find(issue => issue.key === key)?.kind === 'source_changed')));
  await h.restart();
  for (const [id, bytes] of [[morning.run.id, morningBytes], [afternoon.run.id, afternoonBytes]]) {
    const saved = await h.request(`/api/invoices/${id}/download`); assert.equal(saved.status, 200); assert.deepEqual(Buffer.from(await saved.arrayBuffer()), bytes);
  }
  assert.deepEqual(h.sourceSnapshot(), originals);
  assert.equal((await h.day(saturday.batch.id)).filter(row => row.state === 'external_registered').length, 22);
});

test('같은 출고의 원문 상품명만 다르고 검수명이 같으면 충돌하지 않으며 실제 정리명 차이는 보류한다', async t => {
  for (const conflicting of [false, true]) await t.test(conflicting ? '다른 검수명' : '같은 검수명', async t => {
    const first = { ...order('2026-11-07', 0), productName: '가상 원문 A', cleanedName: '가상 검수명' };
    const second = { ...first, productName: '가상 원문 B', cleanedName: conflicting ? '가상 다른 검수명' : first.cleanedName };
    const h = await boot(t, [first]);
    await h.addSource([first], '가상_원문A.xlsx', '2026-11-07T00:00:00Z');
    await h.addSource([second], '가상_원문B.xlsx', '2026-11-09T00:00:00Z');
    const detail = await h.importInvoice([first], [first], '중복원문');
    assert.equal(detail.items.length, 1);
    assert.equal(detail.items[0].decision, conflicting ? 'hold' : 'include');
    assert.equal(detail.issues.some(issue => issue.kind === 'legacy_conflict'), conflicting);
    if (!conflicting) {
      const bytes = await h.exportFile(detail.run.id); assert.equal(outputRows(bytes).length, 1);
      assert.equal(detail.items[0].sourceRows.length, 2, '원문 두 행은 하나의 상품주문 연결 근거로 보존합니다.');
    }
  });
});

test('다른 번호 형식이 최종 네이버 파일에 들어오면 조용히 제외하거나 정상 출력하지 않는다', async t => {
  const value = { ...order('2026-11-09', 0), orderId: '20261109-0000001' }, h = await boot(t, [value]);
  await h.addSource([value], '가상_다른번호.xlsx', '2026-11-09T00:00:00Z');
  const detail = await h.importInvoice([value], [value], '다른번호_네이버원본');
  assert.equal(detail.items.length, 1, '최종 네이버 원본의 행은 숨기지 않습니다.');
  assert.equal(detail.items[0].decision, 'hold');
  const response = await h.request(`/api/invoices/${detail.run.id}/export`); assert.equal(response.status, 400);
  assert.equal(h.state.lookupCalls.length, 0);
  const reviewed = await h.acknowledge(detail);
  const forced = await h.request(`/api/invoices/${reviewed.run.id}/items`, json('PATCH', { changes: [{ id: reviewed.items[0].id, decision: 'include', note: '가상 강제 포함 시도' }] }));
  assert.equal(forced.status, 400, '네이버 조회 불가 번호는 경고 확인만으로 강제 출력하지 않습니다.');
});

test('오전 주문만 재조회 실패하면 그 완료만 지우고 다른 차수 완료는 보존한다', async t => {
  const first = order('2026-11-07', 0), second = order('2026-11-08', 0), h = await boot(t, [first, second]);
  const saturday = await h.addSource([first], '가상_오전출고.xlsx', '2026-11-07T00:00:00Z');
  const morning = await h.importInvoice([first], [first], '오전_등록');
  assert.equal((await h.request(`/api/invoices/${morning.run.id}/check`, { method: 'POST' })).status, 200);
  const sunday = await h.addSource([second], '가상_오후출고.xlsx', '2026-11-08T00:00:00Z');
  const afternoon = await h.importInvoice([second], [second], '오후_등록');
  assert.equal((await h.request(`/api/invoices/${afternoon.run.id}/check`, { method: 'POST' })).status, 200);
  assert.equal((await h.day(saturday.batch.id))[0].state, 'complete');
  h.state.detail = async ids => { if (ids.includes(first.productOrderId)) throw Error('가상 오전 조회 장애'); return ids.map(id => registeredOrder(h.all.get(id))); };
  assert.equal((await h.request(`/api/invoices/${morning.run.id}/check`, { method: 'POST' })).status, 400);
  assert.notEqual((await h.day(saturday.batch.id))[0].state, 'complete');
  assert.equal((await h.day(sunday.batch.id))[0].state, 'complete');
});

test('진짜 동일 출고 수취 정보 변경·원본 삭제는 이전 완료를 유지하지 않는다', async t => {
  for (const change of ['recipient', 'address', 'order', 'quantity', 'delete']) await t.test(change, async t => {
    const value = order('2026-11-07', 0), h = await boot(t, [value]);
    const batch = await h.addSource([value], '가상_원본.xlsx', '2026-11-07T00:00:00Z');
    const run = await h.importInvoice([value], [value], '기존');
    assert.equal((await h.request(`/api/invoices/${run.run.id}/check`, { method: 'POST' })).status, 200);
    if (change === 'delete') {
      const response = await h.request(`/api/batches/${batch.batch.id}/rows`, json('DELETE', { rowIds: [batch.rows[0].id] })); assert.equal(response.status, 200);
    } else {
      const changed = { ...value, ...(change === 'recipient' ? { recipient: '가상 다른 수취인' } : change === 'address' ? { address: '서울 테스트구 다른로 99 101호' }
        : change === 'order' ? { orderId: '2026110799999999' } : { quantity: 2 }) };
      await h.addSource([changed], '가상_변경원본.xlsx', '2026-11-09T00:00:00Z');
    }
    const detail = await h.read(`/api/invoices/${run.run.id}`);
    assert.ok(detail.items.every(item => !item.statusFresh || item.registrationState !== 'complete'));
    const rows = await h.day(batch.batch.id); assert.ok(rows.every(row => row.state !== 'complete'));
  });
});

test('구버전에서 검토 저장한 전체 근거 변경 경고도 현재 주문별로 다시 판단한다', async t => {
  const saturday = [order('2026-11-07', 0), order('2026-11-07', 1)], monday = order('2026-11-09', 0);
  const h = await boot(t, [...saturday, monday]);
  const source = await h.addSource(saturday, '가상_토요일_저장본.xlsx', '2026-11-07T00:00:00Z');
  const run = await h.importInvoice([...saturday, monday], [...saturday, monday], '구버전', '2026-11-09T01:00:00Z');
  useLegacyContract(h.running.app.locals.db, run.run.id);
  await h.addSource([monday], '가상_나중에추가.xlsx', '2026-11-09T02:00:00Z');
  const db = h.running.app.locals.db, stored = JSON.parse(db.prepare('SELECT issues_json FROM invoice_runs WHERE id=?').get(run.run.id).issues_json);
  stored.push({ key: hash(['source_changed', '', '', '']).slice(0, 24), kind: 'source_changed',
    message: '연결 근거인 저장 주문이 바뀌었습니다. 현재 유효 주문으로 매칭을 다시 확인해 주세요.', blocking: true, resolved: true, note: '구버전 담당자 확인' });
  db.prepare('UPDATE invoice_runs SET issues_json=? WHERE id=?').run(JSON.stringify(stored), run.run.id);
  const detail = await h.read(`/api/invoices/${run.run.id}`);
  assert.ok(!detail.issues.some(warning => warning.kind === 'source_changed' && !warning.productOrderId));
  assert.equal(detail.issues.filter(warning => warning.kind === 'source_changed').length, 1);
  assert.equal(detail.issues.find(warning => warning.kind === 'source_changed').productOrderId, monday.productOrderId);
  assert.ok((await h.day(source.batch.id)).every(row => row.state === 'ready'));
  const reviewed = await h.acknowledge(detail);
  assert.ok(reviewed.issues.find(warning => warning.kind === 'source_changed').resolved, '현재 실제 충돌을 보류한 확인은 재조회에도 유지합니다.');
  assert.equal(outputRows(await h.exportFile(run.run.id)).length, 2, '실제 충돌을 보류한 뒤 정상 주문만 출력할 수 있습니다.');
});
