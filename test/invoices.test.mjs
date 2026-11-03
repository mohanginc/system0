import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as XLSX from 'xlsx';
import { openDatabase, deleteBatch, deleteRows } from '../lib/database.mjs';
import { importFiles } from '../lib/excel.mjs';
import { CARRIERS, importInvoiceFiles, invoiceDetail, listInvoiceRuns, reviseInvoiceItems,
  exportInvoices, downloadInvoices, latestInvoice, refreshInvoiceStatus, shipmentInvoiceStates, invoiceOrderSources, listInvoiceDrafts, unlockNaverFiles } from '../lib/invoices.mjs';

const carrier = CARRIERS[0], pid = '202610210000000001', oid = '202610210000000099', internal = '000001', tracking = '45333933352';
const recipient = '모의 수취인', telephone = '010-1111-2222', address = '서울 강남구 테헤란로 123 (역삼동) 101호';
const naverHeaders = ['상품주문번호', '주문번호', '상품명', '수량', '수취인명', '수취인연락처1', '통합배송지', '주문상태', '주문세부상태', '택배사', '송장번호'];
const courierHeaders = ['운송장번호', '주문번호', '차수', '원송장번호', '발행횟수', '출력시간', '물품명', '이름', '전화', '주소'];
const legacyHeaders = ['원상품명', '주문번호', '체결번호', '송화주', '전화번호', '주소', '수량'];
function file(rows, headers, name = '모의.xlsx') {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, ...rows]), '주문');
  return { originalname: name, buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) };
}
const product = (overrides = {}) => ({ productOrderId: pid, orderId: oid, quantity: 2, name: '수유쿠션',
  recipient, phone: telephone, address, status: 'PAYED', detailStatus: '', carrier: '', tracking: '', ...overrides });
const naverFile = (products, name, headers = naverHeaders) => file(products.map(row => [row.productOrderId, row.orderId,
  row.name, row.quantity, row.recipient, row.phone, row.address, row.status, row.detailStatus, row.carrier, row.tracking]), headers, name);
const parcel = (overrides = {}) => ({ internalId: internal, trackingNumber: tracking, round: 1, original: '', count: 1,
  printedAt: '2026-10-21T10:00:00+09:00', ...overrides });
const courierFile = parcels => file(parcels.map(row => [row.trackingNumber, row.internalId, row.round,
  row.original, row.count, row.printedAt, '수유쿠션', recipient, telephone, address]), courierHeaders, '택배.xlsx');
function database(t) { const db = openDatabase(':memory:'); t.after(() => db.close()); return db; }
function seed(db, { id = internal, orderId = oid, name = '수유쿠션', phone: contact = telephone, batchDate } = {}) {
  const result = importFiles(db, [file([[name, id, orderId, recipient, contact, address, 1]], legacyHeaders, '저장 주문.xlsx')]);
  if (batchDate) db.prepare('UPDATE batches SET created_at = ? WHERE id = ?').run(batchDate, result.batch.id);
  db.prepare("UPDATE rows SET cleaned_name = ?, status = 'confirmed', name_source = 'manual', name_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run('정리된 ' + name, result.rows[0].id);
  return result;
}
const start = (db, products = [product()], parcels = [parcel()], extra = {}) => importInvoiceFiles(db, {
  naverFiles: [naverFile(products)], courierFiles: [courierFile(parcels)], carrier, batchIds: scopeIds(db), ...extra,
});
const scopeIds = db => db.prepare('SELECT id FROM batches WHERE is_deleted = 0 ORDER BY id').all().map(batch => batch.id);
const snapshot = db => Object.fromEntries(['batches', 'sheets', 'source_files', 'rows', 'row_revisions']
  .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
const workbookRows = buffer => { const workbook = XLSX.read(buffer, { type: 'buffer' });
  assert.deepEqual(workbook.SheetNames, ['발송처리']);
  return XLSX.utils.sheet_to_json(workbook.Sheets['발송처리'], { header: 1, raw: true }); };
const change = (item, decision, note = '', trackingNumber) => ({ id: item.id, decision, note, ...(trackingNumber ? { trackingNumber } : {}) });
const acknowledge = detail => detail.issues.filter(issue => issue.reviewRequired && !issue.resolved).map(issue => ({ key: issue.key, note: '모의 담당자가 근거와 처리 대상을 확인함' }));
function remote(item, overrides = {}) {
  return { productOrderId: item.productOrderId, orderId: item.orderId, status: 'DELIVERING', placeOrderStatus: 'OK',
    remainQuantity: item.quantity, recipient: item.recipient, phone: item.phone,
    address: '서울 강남구 테헤란로 123 (역삼동)', detailAddress: '101호', trackingNumber: item.trackingNumber,
    deliveryCompanyCode: 'KGB', claimStatus: '', deliveryStatus: 'DELIVERING', deliveryMethod: 'DELIVERY',
    isWrongTrackingNumber: false, ...overrides };
}
const query = rows => ({ queryProductOrders: async ids => { assert.deepEqual(ids, rows.map(row => row.productOrderId)); return rows; } });

test('모든 날짜의 저장 출고와 여러 네이버 파일을 ID로 연결하고 합배송 상품ID·원본·기존 이력을 보존한다', t => {
  const db = database(t), saved = seed(db, { batchDate: '2000-01-01T00:00:00Z' }), before = snapshot(db);
  const products = [product(), product({ productOrderId: '202610210000000002', name: '전용 방수 커버', quantity: 1 })];
  const detail = importInvoiceFiles(db, { naverFiles: [naverFile([products[0]], '첫 주문.xlsx'), naverFile([products[1]], '둘째 주문.xlsx')],
    courierFiles: [courierFile([parcel()])], carrier, batchIds: [saved.batch.id] });
  assert.equal(detail.summary.total, 2); assert.equal(detail.summary.included, 2); assert.equal(detail.summary.issues, 0);
  assert.deepEqual(detail.items.map(item => item.productOrderId), products.map(item => item.productOrderId));
  assert.ok(detail.items.every(item => item.internalId === internal && item.trackingNumber === tracking && item.decision === 'include'));
  assert.deepEqual(detail.items[0].batchIds, [saved.batch.id]);
  assert.equal(detail.items[0].sourceRows[0].sourceRow, 2);
  assert.equal(detail.items[0].physicalShipments[0].valid, true);
  assert.equal(detail.items[0].physicalShipments[0].sources[0].sourceRow, 2);
  assert.equal(detail.orders.length, 1);
  assert.deepEqual(detail.orders[0].itemIds, detail.items.map(item => item.id));
  assert.equal(detail.orders[0].source.batchCreatedAt, '2000-01-01T00:00:00Z');
  assert.ok(detail.items.every(item => item.registrationState === 'unchecked'));
  assert.equal(detail.files.length, 3);
  const output = exportInvoices(db, detail.run.id);
  assert.deepEqual(workbookRows(output.buffer), [['상품주문번호', '배송방법', '택배사', '송장번호'],
    [pid, '택배,등기,소포', carrier.name, tracking], ['202610210000000002', '택배,등기,소포', carrier.name, tracking]]);
  assert.deepEqual(snapshot(db), before);
  assert.equal(db.prepare('SELECT count(*) n FROM source_files').get().n, 1);
  assert.deepEqual(shipmentInvoiceStates(db, [internal, '없는번호']), { [internal]: 'pending', 없는번호: 'unavailable' });
  assert.ok(!JSON.stringify(detail).includes('테헤란로'), '전체 주소는 조회 확인에만 보존합니다.');
});

test('동일 파일 재업로드는 작업을 추가하지 않고 검토를 이어가며 활성 근거 변경을 알린다', t => {
  const db = database(t), saved = seed(db), input = { naverFiles: [naverFile([product()])], courierFiles: [courierFile([parcel()])], carrier, batchIds: [saved.batch.id] };
  const first = importInvoiceFiles(db, input);
  reviseInvoiceItems(db, first.run.id, { changes: [change(first.items[0], 'hold', '담당자 보류')] });
  const repeated = importInvoiceFiles(db, input);
  assert.equal(repeated.run.id, first.run.id);
  assert.equal(repeated.items[0].note, '담당자 보류');
  assert.equal(listInvoiceRuns(db).length, 0);
  assert.equal(listInvoiceDrafts(db).length, 1);
  deleteRows(db, saved.batch.id, [saved.rows[0].id]);
  const deleted = importInvoiceFiles(db, input);
  assert.notEqual(deleted.run.id, first.run.id, '근거가 바뀌면 같은 파일로도 다시 매칭할 수 있습니다.');
  assert.equal(deleted.items.length, 1, '② 근거를 삭제해도 최종 ① 발송 대상은 경고와 함께 남습니다.');
  assert.equal(deleted.items[0].decision, 'hold');
  assert.equal(deleted.orders.length, 1);
  assert.equal(deleted.orders[0].sourceType, 'naver_only');
  assert.ok(invoiceDetail(db, first.run.id).issues.some(issue => issue.kind === 'source_changed'));
  assert.equal(db.prepare('SELECT count(*) n FROM invoice_files').get().n, 4);
});

test('한국 등록일 범위·실제 날짜·명시적 택배사와 스토어 구분을 검증한다', t => {
  const db = database(t); seed(db);
  assert.throws(() => start(db, undefined, undefined, { carrier: undefined }), /택배사/);
  assert.throws(() => start(db, undefined, undefined, { carrier: { code: 'KGB', name: '추측한 택배사' } }), /택배사/);
  assert.throws(() => start(db, undefined, undefined, { mall: 'unknown' }), /몰/);
  const first = start(db, undefined, undefined, { sourceDate: '2026-10-20' }), second = start(db, undefined, undefined, { store: '다른 스토어', sourceDate: '2026-10-21' });
  assert.notEqual(first.run.id, second.run.id);
  exportInvoices(db, first.run.id); exportInvoices(db, second.run.id);
  db.prepare('UPDATE invoice_runs SET generated_at = ? WHERE id = ?').run('2026-10-20T14:59:59.999Z', first.run.id);
  db.prepare('UPDATE invoice_runs SET generated_at = ? WHERE id = ?').run('2026-10-20T15:00:00.000Z', second.run.id);
  assert.deepEqual(listInvoiceRuns(db, '2026-10-20').map(run => run.id), [first.run.id]);
  assert.deepEqual(listInvoiceRuns(db, '2026-10-21').map(run => run.id), [second.run.id]);
  for (const date of ['2026-02-30', '0000-01-01', ['2026-10-21'], 'bad']) assert.throws(() => listInvoiceRuns(db, date), /날짜/);
  const add = db.prepare(`INSERT INTO invoice_runs (mall, store, carrier_name, carrier_code, fingerprint, legacy_signature, generated_at)
    VALUES ('naver', 'default', ?, ?, ?, '', '2026-10-21T01:00:00.000Z')`);
  for (let index = 0; index < 51; index++) add.run(carrier.name, carrier.code, 'list-fixture-' + index);
  assert.equal(listInvoiceRuns(db).length, 50);
  assert.equal(listInvoiceRuns(db, '2026-10-21').length, 52);
});

test('빈·unsafe 번호는 연결하지 않고 미매칭을 취소로 단정하지 않으며 경고 확인 후 정상 항목만 내보낸다', t => {
  const db = database(t); seed(db);
  const detail = start(db, [product(), product({ productOrderId: Number.MAX_SAFE_INTEGER + 1 })],
    [parcel(), parcel({ internalId: '', trackingNumber: '45333933363' }), parcel({ internalId: 'unknown', trackingNumber: '45333933374' })]);
  assert.ok(detail.issues.some(issue => issue.kind === 'invalid_naver_id'));
  assert.ok(detail.issues.some(issue => issue.kind === 'invalid_courier_id'));
  assert.ok(detail.issues.some(issue => issue.kind === 'unmatched_courier'));
  assert.throws(() => exportInvoices(db, detail.run.id), /경고/);
  reviseInvoiceItems(db, detail.run.id, { issueResolutions: acknowledge(detail) });
  assert.equal(workbookRows(exportInvoices(db, detail.run.id).buffer).length, 2);
});

test('네이버 동일 상품ID 충돌·동일 내부번호 충돌은 보류하고 정확한 재업로드 주문만 중복 연결한다', t => {
  const db = database(t); seed(db); seed(db);
  const first = start(db);
  assert.equal(first.summary.total, 1); assert.equal(first.items[0].sourceRows.length, 2);
  seed(db, { name: '동일 번호의 다른 상품' });
  const conflict = start(db, [product()], [parcel({ printedAt: '2026-10-21T11:00:00+09:00' })]);
  assert.equal(conflict.items[0].decision, 'hold');
  assert.ok(conflict.issues.some(issue => issue.kind === 'legacy_conflict' && issue.blocking));
  const badNaver = importInvoiceFiles(db, { naverFiles: [naverFile([product()]), naverFile([product({ quantity: 9 })])],
    courierFiles: [courierFile([parcel()])], carrier, batchIds: scopeIds(db) });
  assert.ok(badNaver.issues.some(issue => issue.kind === 'naver_conflict'));
});

test('명확한 차수의 분할 상자는 먼저인 송장을 대표로 하고 모든 실물 송장과 변경 사유를 보존한다', t => {
  const db = database(t); seed(db);
  const detail = start(db, undefined, [parcel({ round: 2, trackingNumber: '45333933363' }), parcel({ round: 1 })]);
  assert.equal(detail.items[0].trackingNumber, tracking);
  assert.equal(detail.items[0].physicalShipments.length, 2);
  assert.ok(detail.items[0].physicalShipments.every(item => item.valid === true));
  assert.throws(() => reviseInvoiceItems(db, detail.run.id, { changes: [change(detail.items[0], 'include', '', '45333933363')] }), /사유/);
  const changed = reviseInvoiceItems(db, detail.run.id, { changes: [change(detail.items[0], 'include', '담당자 대표 송장 선택', '45333933363')] });
  assert.equal(changed.items[0].trackingNumber, '45333933363');
  assert.equal(db.prepare('SELECT count(*) n FROM invoice_revisions').get().n, 1);
  assert.equal(workbookRows(exportInvoices(db, detail.run.id).buffer)[1][3], '45333933363');
});

test('단일 상품주문의 두 내부 출고가 수취 정보·서로 다른 차수로 확정되면 한 대표 송장과 두 상자의 등록 상태를 연결한다', async t => {
  const db = database(t); seed(db); seed(db, { id: '000002' });
  const parcels = [parcel({ internalId: '000002', round: 2, trackingNumber: '45333933363' }), parcel({ round: 1 })];
  let detail = start(db, undefined, parcels);
  assert.equal(detail.items.length, 1);
  assert.equal(detail.items[0].decision, 'include');
  assert.equal(detail.items[0].trackingNumber, tracking);
  assert.equal(detail.items[0].sourceRows.length, 2);
  assert.deepEqual(new Set(detail.items[0].physicalShipments.map(item => item.internalId)), new Set([internal, '000002']));
  assert.deepEqual(workbookRows(exportInvoices(db, detail.run.id).buffer), [
    ['상품주문번호', '배송방법', '택배사', '송장번호'], [pid, '택배,등기,소포', carrier.name, tracking],
  ]);
  detail = await refreshInvoiceStatus(db, detail.run.id, query(detail.items.map(item => remote(item))));
  assert.equal(detail.items[0].registrationState, 'complete');
  assert.deepEqual(shipmentInvoiceStates(db, [internal, '000002']), { [internal]: 'complete', '000002': 'complete' });
  const ambiguous = start(db, [product(), product({ productOrderId: '202610210000000002' })], parcels);
  assert.ok(ambiguous.items.every(item => item.decision === 'hold'));
  assert.ok(ambiguous.issues.some(issue => issue.kind === 'split_mapping'));
  assert.deepEqual(shipmentInvoiceStates(db, [internal, '000002']), { [internal]: 'pending', '000002': 'pending' });
});

test('같은 최종 파일의 시간문자열·발행횟수 증가로 재출력을 식별하고 구주소를 충돌로 남기지 않는다', t => {
  const db = database(t); seed(db);
  const rows = [
    [tracking, internal, 1, '', 1, '12:06:04', '수유쿠션', recipient, telephone, '이전 주소'],
    ['45333933363', internal, 1, '', 2, '12:10:00', '수유쿠션', recipient, telephone, address],
  ];
  const detail = start(db, undefined, undefined, { courierFiles: [file(rows, courierHeaders, '시간형 송장.xlsx')] });
  assert.equal(detail.items[0].trackingNumber, '45333933363');
  assert.equal(detail.items[0].decision, 'include');
  assert.equal(detail.items[0].physicalShipments.find(item => item.trackingNumber === tracking).valid, false);
  assert.ok(!detail.issues.some(issue => issue.kind === 'courier_conflict'));
});

test('시간만 있는 서로 다른 파일은 날짜 순서를 추측하지 않고 같은 파일의 명시 원송장 관계는 허용한다', t => {
  const db = database(t); seed(db);
  start(db, undefined, [parcel({ printedAt: '12:06:04' })]);
  const uncertain = start(db, undefined, [parcel({ trackingNumber: '45333933363', printedAt: '12:10:00', count: 2 })]);
  assert.equal(uncertain.items[0].decision, 'hold');
  assert.ok(uncertain.issues.some(issue => issue.kind === 'parcel_uncertain'));
  const db2 = database(t); seed(db2);
  const explicit = start(db2, undefined, [parcel({ printedAt: '12:06:04' }),
    parcel({ trackingNumber: '45333933363', original: tracking, printedAt: '12:10:00', count: 2 })]);
  assert.equal(explicit.items[0].decision, 'include');
  assert.equal(explicit.items[0].trackingNumber, '45333933363');
});

test('재발급은 원송장·출력 순서로 판단하고 과거 완료보다 새 유효 송장을 우선한다', async t => {
  const db = database(t); seed(db);
  const old = start(db);
  await refreshInvoiceStatus(db, old.run.id, query(old.items.map(item => remote(item))));
  assert.equal(shipmentInvoiceStates(db, [internal])[internal], 'complete');
  const next = start(db, undefined, [parcel({ trackingNumber: '45333933363', original: tracking, count: 2,
    printedAt: '2026-10-21T11:00:00+09:00' })]);
  assert.equal(next.items[0].trackingNumber, '45333933363');
  assert.equal(next.items[0].physicalShipments.find(item => item.trackingNumber === tracking).valid, false);
  assert.equal(next.items[0].physicalShipments.find(item => item.trackingNumber === tracking).replacedBy, '45333933363');
  assert.equal(next.items[0].registrationState, 'unchecked');
  assert.equal(invoiceDetail(db, old.run.id).items[0].superseded, true);
  assert.throws(() => exportInvoices(db, old.run.id), /경고/);
  assert.equal(shipmentInvoiceStates(db, [internal])[internal], 'pending');
  assert.throws(() => exportInvoices(db, next.run.id), /포함|경고/);
  await refreshInvoiceStatus(db, next.run.id, query(next.items.map(item => remote(item, { status: 'PAYED', trackingNumber: '', deliveryCompanyCode: '' }))));
  assert.equal(workbookRows(exportInvoices(db, next.run.id).buffer)[1][3], '45333933363');
});

test('분할·재발급이 모호한 송장은 메모로 강제 포함하지 않고 보류 확인 후 정상 항목만 내보낸다', t => {
  const db = database(t); seed(db); seed(db, { id: '000002', orderId: '202610210000000088' });
  let detail = start(db, [product(), product({ productOrderId: '202610210000000002', orderId: '202610210000000088' })],
    [parcel(), parcel({ trackingNumber: '45333933363' }), parcel({ internalId: '000002', trackingNumber: '45333933374' })]);
  const ambiguous = detail.items.find(item => item.internalId === internal);
  assert.equal(ambiguous.decision, 'hold'); assert.equal(ambiguous.trackingNumber, '');
  assert.equal(ambiguous.physicalShipments.length, 2);
  assert.throws(() => reviseInvoiceItems(db, detail.run.id, { changes: [change(ambiguous, 'include', '강제 확정')], issueResolutions: acknowledge(detail) }), /보류|확인/);
  detail = reviseInvoiceItems(db, detail.run.id, { changes: [change(ambiguous, 'hold', '이 출고는 별도 확인하고 정상건 진행')] });
  assert.ok(detail.issues.every(issue => issue.resolved));
  const output = workbookRows(exportInvoices(db, detail.run.id).buffer);
  assert.equal(output.length, 2); assert.equal(output[1][0], '202610210000000002');
});

test('다른 주문번호 합포장은 센터 처리이고 상품별 배분 불명확한 분할·취소는 자동 출고하지 않는다', t => {
  const db = database(t); seed(db); seed(db, { id: '000002', orderId: '202610210000000088' });
  const products = [product(), product({ productOrderId: '202610210000000002', orderId: '202610210000000088' })];
  const center = start(db, products, [parcel(), parcel({ internalId: '000002' })]);
  assert.ok(center.items.every(item => item.decision === 'hold'));
  assert.equal(center.issues.filter(issue => issue.kind === 'center_required').length, 2);
  const db2 = database(t); seed(db2); seed(db2, { id: '000002' });
  const split = start(db2, undefined, [parcel(), parcel({ internalId: '000002', trackingNumber: '45333933363' })]);
  assert.ok(split.issues.some(issue => issue.kind === 'split_mapping'));
  assert.equal(split.items[0].physicalShipments.length, 2);
  assert.equal(split.items[0].decision, 'hold');
  const db3 = database(t); seed(db3);
  const canceled = start(db3, [product({ status: 'CANCELED' })]);
  assert.equal(canceled.items[0].decision, 'hold');
  assert.ok(canceled.issues.some(issue => issue.kind === 'source_canceled'));
});

test('원본에 이미 같은 송장이 등록된 건은 중복 엑셀에서 제외하되 실제 조회 전 보드는 완료가 아니다', t => {
  const db = database(t); seed(db);
  const detail = start(db, [product({ status: 'DELIVERING', tracking, carrier: carrier.name })]);
  assert.equal(detail.items[0].sourceRegistered, true);
  assert.equal(detail.items[0].registrationState, 'unchecked');
  assert.equal(detail.summary.complete, 0);
  assert.throws(() => exportInvoices(db, detail.run.id), /이미 등록/);
  assert.equal(shipmentInvoiceStates(db, [internal])[internal], 'pending');
});

test('등록 상태는 전 상품의 ID·수량·수취정보·택배사·송장이 일치할 때만 완료하고 시각을 보존한다', async t => {
  const db = database(t); seed(db);
  let detail = start(db, [product(), product({ productOrderId: '202610210000000002', quantity: 1 })]);
  const before = snapshot(db);
  detail = await refreshInvoiceStatus(db, detail.run.id, query(detail.items.map((item, i) => remote(item,
    i ? { status: 'PAYED', trackingNumber: '', deliveryCompanyCode: '' } : {}))));
  assert.deepEqual(detail.items.map(item => item.registrationState), ['complete', 'pending']);
  assert.equal(shipmentInvoiceStates(db, [internal])[internal], 'pending');
  detail = await refreshInvoiceStatus(db, detail.run.id, query(detail.items.map(item => remote(item))));
  assert.ok(detail.items.every(item => item.registrationState === 'complete' && item.statusFresh));
  assert.ok(detail.run.statusCheckedAt);
  db.prepare('UPDATE invoice_items SET status_checked_at = ?').run('2000-01-01T00:00:00Z');
  assert.equal(shipmentInvoiceStates(db, [internal])[internal], 'complete', '과거 날짜의 확인 결과를 임의 TTL로 무효화하지 않습니다.');
  assert.throws(() => exportInvoices(db, detail.run.id), /이미 등록/);
  assert.deepEqual(snapshot(db), before);
});

test('wrong invoice·부분취소·주소변경·다른송장·다른주문은 conflict이고 불완전 응답/장애는 과거 완료를 무효화한다', async t => {
  const db = database(t); seed(db); let detail = start(db);
  for (const overrides of [{ isWrongTrackingNumber: true }, { deliveryStatus: 'WRONG_INVOICE' },
    { claimStatus: 'CANCEL_REQUEST' }, { remainQuantity: 1 }, { recipient: '다른 수취인' },
    { address: '다른 주소' }, { orderId: 'changed-order' }, { trackingNumber: '45333933363' }, { deliveryCompanyCode: 'CJGLS' }]) {
    detail = await refreshInvoiceStatus(db, detail.run.id, query(detail.items.map(item => remote(item, overrides))));
    assert.equal(detail.items[0].registrationState, 'conflict');
    assert.ok(detail.items[0].registrationNote);
    assert.throws(() => exportInvoices(db, detail.run.id), /충돌/);
    assert.equal(shipmentInvoiceStates(db, [internal])[internal], 'pending');
  }
  detail = await refreshInvoiceStatus(db, detail.run.id, query(detail.items.map(item => remote(item))));
  for (const responses of [[], [remote(detail.items[0]), remote(detail.items[0])],
    [remote(detail.items[0], { address: undefined })], [remote(detail.items[0], { deliveryCompanyCode: undefined })]]) {
    await assert.rejects(refreshInvoiceStatus(db, detail.run.id, { queryProductOrders: async () => responses }), /응답/);
    assert.equal(invoiceDetail(db, detail.run.id).items[0].registrationState, 'unchecked');
  }
  await assert.rejects(refreshInvoiceStatus(db, detail.run.id, { queryProductOrders: async () => { throw new Error('비공개 응답 모의 수취인 010-1111-2222'); } }), error => {
    assert.ok(!error.message.includes('010-1111')); assert.ok(!error.message.includes('모의 수취인')); return true;
  });
  assert.equal(shipmentInvoiceStates(db, [internal])[internal], 'pending');
});

test('이미 등록된 동일 송장의 050 연락처 차이는 주의 문구로 남기고 일반 전화·주소 변경·미등록은 완료하지 않는다', async t => {
  for (const [sourcePhone, checkedPhone] of [['050-1111-2222', telephone], [telephone, '050-1111-2222']]) {
    const db = database(t); seed(db, { phone: sourcePhone });
    const detail = start(db, [product({ phone: sourcePhone })]);
    const result = await refreshInvoiceStatus(db, detail.run.id, query(detail.items.map(item => remote(item, { phone: checkedPhone }))));
    assert.equal(result.items[0].registrationState, 'complete');
    assert.equal(result.items[0].registrationNote, '송장 등록 일치. 원본/조회 연락처는 안심번호 등으로 직접 대조할 수 없습니다.');
    assert.equal(shipmentInvoiceStates(db, [internal])[internal], 'complete');
  }
  for (const overrides of [{ phone: '010-9999-8888' },
    { phone: '050-1111-2222', recipient: '다른 수취인' }, { phone: '050-1111-2222', address: '변경된 주소' },
    { phone: '050-1111-2222', status: 'PAYED', trackingNumber: '', deliveryCompanyCode: '' }]) {
    const db = database(t); seed(db); const detail = start(db);
    const result = await refreshInvoiceStatus(db, detail.run.id, query(detail.items.map(item => remote(item, overrides))));
    assert.equal(result.items[0].registrationState, 'conflict');
    assert.ok(!result.items[0].registrationNote.includes('송장 등록 일치'));
    assert.equal(shipmentInvoiceStates(db, [internal])[internal], 'pending');
  }
});

test('배송 근거·송장이 동일한 새 파일은 실제 완료 확인을 이어가고 선택·삭제·새 송장은 무효화한다', async t => {
  const db = database(t), saved = seed(db); let old = start(db);
  old = await refreshInvoiceStatus(db, old.run.id, query(old.items.map(item => remote(item))));
  const extraHeaders = [...naverHeaders, '추가 메모'];
  const next = start(db, undefined, undefined, { naverFiles: [naverFile([product()], '다른 형태.xlsx', extraHeaders)] });
  assert.notEqual(next.run.id, old.run.id);
  assert.equal(next.items[0].registrationState, 'unchecked', '새 발송대기 원본이 이전 완료 조회와 모순되므로 재조회합니다.');
  assert.equal(next.items[0].decision, 'hold');
  assert.throws(() => exportInvoices(db, next.run.id), /포함|경고/);
  await refreshInvoiceStatus(db, next.run.id, query(next.items.map(item => remote(item))));
  assert.equal(shipmentInvoiceStates(db, [internal])[internal], 'complete');
  assert.throws(() => exportInvoices(db, next.run.id), /이미 등록/);
  deleteBatch(db, saved.batch.id);
  assert.equal(invoiceDetail(db, next.run.id).items[0].registrationState, 'unchecked');
  assert.equal(shipmentInvoiceStates(db, [internal])[internal], 'pending');
  assert.throws(() => exportInvoices(db, next.run.id), /경고/);
});

test('실제 조회가 완료여도 보류·제외 또는 미해결 수취 정보 경고가 있으면 보드를 회색 처리하지 않는다', async t => {
  const db = database(t); seed(db); let detail = start(db);
  detail = await refreshInvoiceStatus(db, detail.run.id, query(detail.items.map(item => remote(item))));
  for (const decision of ['hold', 'exclude']) {
    reviseInvoiceItems(db, detail.run.id, { changes: [change(detail.items[0], decision, '담당자 보류')] });
    assert.equal(shipmentInvoiceStates(db, [internal])[internal], 'pending');
  }
  const db2 = database(t); seed(db2);
  const mismatched = start(db2, [product({ recipient: '다른 수취인' })]);
  await refreshInvoiceStatus(db2, mismatched.run.id, query(mismatched.items.map(item => remote(item))));
  assert.equal(shipmentInvoiceStates(db2, [internal])[internal], 'pending');
});

test('검토 저장은 잘못된 ID·중복을 전체 취소하고 조회 중 근거 변경도 완료로 쓰지 않는다', async t => {
  const db = database(t), saved = seed(db), detail = start(db);
  const before = db.prepare('SELECT * FROM invoice_items').all();
  for (const changes of [[change(detail.items[0], 'hold', '메모'), { id: 999, decision: 'exclude', note: '' }],
    [change(detail.items[0], 'hold'), change(detail.items[0], 'exclude')]]) {
    assert.throws(() => reviseInvoiceItems(db, detail.run.id, { changes }), /확인/);
    assert.deepEqual(db.prepare('SELECT * FROM invoice_items').all(), before);
  }
  let finish;
  const pending = refreshInvoiceStatus(db, detail.run.id, { queryProductOrders: () => new Promise(resolve => { finish = resolve; }) });
  deleteRows(db, saved.batch.id, [saved.rows[0].id]);
  finish(detail.items.map(item => remote(item)));
  await assert.rejects(pending, /바뀌었습니다/);
  assert.equal(db.prepare('SELECT registration_state FROM invoice_items').get().registration_state, 'unchecked');
});

const reference = new URL('../reference-data/orders/', import.meta.url);
test('실제 세 단계 예제는 합배송 상품ID를 유지하고 번호 없는 행은 경고로 남기며 기존 원본을 바꾸지 않는다', {
  skip: !existsSync(new URL('(1)-네이버다운로드.xls', reference)),
}, t => {
  const db = database(t), source = name => ({ originalname: name, buffer: readFileSync(new URL(name, reference)) });
  const saved = importFiles(db, [source('(2)-우리시스템다운로드.xls')]);
  const before = snapshot(db);
  const detail = importInvoiceFiles(db, { naverFiles: [source('(1)-네이버다운로드.xls')], courierFiles: [source('(3)-택배사다운로드.xlsx')], carrier, batchIds: [saved.batch.id] });
  assert.equal(detail.summary.total, 28);
  assert.equal(new Set(detail.items.map(item => item.productOrderId)).size, 28);
  assert.equal(new Set(detail.items.map(item => item.internalId)).size, 27);
  assert.equal(new Set(detail.items.map(item => item.trackingNumber)).size, 27);
  assert.ok(detail.issues.some(issue => issue.kind === 'invalid_courier_id'));
  assert.equal(detail.orders.length, 27, '①에 해당하는 저장 원본만 이번 표에 표시합니다.');
  assert.equal(detail.orders.filter(order => order.state === 'ready').length, 27);
  assert.equal(detail.unmatchedCouriers.length, 1);
  const noNumber = detail.unmatchedCouriers.find(order => order.sourceRow === 31);
  assert.equal(noNumber.state, 'invalid_id');
  assert.equal(noNumber.reason, '택배사 파일의 주문번호가 비어 있어 확인한 주문에 연결하지 못했습니다.');
  assert.ok(detail.orders.filter(order => order.state === 'ready').every(order => !order.issues.length), '무관한 파일 경고로 정상 출고를 보류하지 않습니다.');
  const reviewed = reviseInvoiceItems(db, detail.run.id, { issueResolutions: acknowledge(detail),
    changes: detail.items.map(item => change(item, 'include', '모의 검토')) });
  assert.equal(reviewed.summary.included, 28);
  assert.equal(workbookRows(exportInvoices(db, detail.run.id).buffer).length, 29);
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  assert.ok(digest(snapshot(db)) === digest(before), '실제 원본과 작업·직원 이력이 변경되지 않았습니다.');
});

test('송장 전용 테이블은 DB 재시작 후 원본 첨부·검토·상태 이력을 유지한다', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'system0-invoices-')), filename = path.join(directory, 'fixture.sqlite');
  let db;
  try {
    db = openDatabase(filename); seed(db); const detail = start(db);
    reviseInvoiceItems(db, detail.run.id, { changes: [change(detail.items[0], 'hold', '다음날 확인')] });
    await refreshInvoiceStatus(db, detail.run.id, query(detail.items.map(item => remote(item))));
    const bytes = Buffer.from(db.prepare('SELECT content FROM invoice_files WHERE kind = ?').get('naver').content);
    db.close(); db = openDatabase(filename);
    assert.equal(invoiceDetail(db, detail.run.id).items[0].note, '다음날 확인');
    assert.equal(invoiceDetail(db, detail.run.id).items[0].registrationState, 'complete');
    assert.equal(db.prepare('SELECT count(*) n FROM invoice_checks').get().n, 1);
    assert.ok(Buffer.from(db.prepare('SELECT content FROM invoice_files WHERE kind = ?').get('naver').content).equals(bytes));
  } finally { db?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('날짜별 조회는 당일 원본을 유지하고 파일 매칭은 다른 날짜의 같은 주문번호 근거도 함께 사용한다', t => {
  const db = database(t), old = seed(db, { batchDate: '2026-10-01T01:00:00Z' });
  const today = seed(db, { batchDate: '2026-10-21T01:00:00Z' }), before = snapshot(db);
  const preview = invoiceOrderSources(db, [today.batch.id]);
  assert.equal(preview.orders.length, 1); assert.equal(preview.orders[0].rowId, today.rows[0].id);
  assert.equal(preview.orders[0].state, 'not_matched');
  const detail = start(db, undefined, undefined, { batchIds: [today.batch.id] });
  assert.deepEqual(detail.batchIds, [old.batch.id, today.batch.id]);
  assert.equal(detail.run.sourceDate, '2026-10-21'); assert.equal(detail.orders.length, 2);
  assert.deepEqual(detail.items[0].sourceRows.map(row => row.rowId), [old.rows[0].id, today.rows[0].id]);
  assert.ok(detail.orders.every(order => order.state === 'ready' && order.trackingNumbers[0] === tracking));
  assert.equal(start(db, undefined, undefined, { batchIds: [today.batch.id] }).run.id, detail.run.id);
  const oldDay = invoiceOrderSources(db, [old.batch.id]);
  assert.equal(oldDay.orders.length, 1); assert.equal(oldDay.orders[0].latestRunId, detail.run.id);
  assert.equal(oldDay.orders[0].processingDate, '2026-10-21');
  assert.equal(latestInvoice(db, '2026-10-01'), null, '원본 날짜를 열어 전체 통합 작업을 자동 펼치지 않습니다.');
  assert.deepEqual(snapshot(db), before);
});

test('조회 날짜 fallback 작업 번호는 검증하며 sourceDate만으로도 과거 주문을 매칭한다', t => {
  const db = database(t), saved = seed(db);
  assert.deepEqual(invoiceOrderSources(db, []), { batches: [], orders: [] });
  for (const batchIds of [undefined, [], [saved.batch.id, saved.batch.id], [String(saved.batch.id)], [0], [-1], [999], [Number.MAX_SAFE_INTEGER + 1]]) {
    assert.throws(() => start(db, undefined, undefined, { batchIds }), /작업/);
    if (batchIds?.length) assert.throws(() => invoiceOrderSources(db, batchIds), /작업/);
  }
  assert.equal(db.prepare('SELECT count(*) n FROM invoice_runs').get().n, 0);
  deleteBatch(db, saved.batch.id);
  assert.throws(() => start(db, undefined, undefined, { batchIds: [saved.batch.id] }), /삭제/);
  assert.throws(() => invoiceOrderSources(db, [saved.batch.id]), /삭제/);
});

test('선택 범위 밖·저장 주문 없는·번호 오류인 택배 행을 출처와 정확한 사유로 별도 보존한다', t => {
  const db = database(t), selected = seed(db), outside = seed(db, { id: '000002', orderId: 'other-order' });
  const detail = start(db, undefined, [parcel(), parcel({ internalId: '000002', trackingNumber: '000222' }),
    parcel({ internalId: 'not-saved', trackingNumber: '000333' }), parcel({ internalId: '', trackingNumber: '000444' }),
    parcel({ internalId: Number.MAX_SAFE_INTEGER + 1, trackingNumber: '000555' })], { batchIds: [selected.batch.id] });
  assert.equal(detail.orders.length, 1);
  assert.deepEqual(detail.items[0].batchIds, [selected.batch.id]);
  assert.equal(detail.unmatchedCouriers.length, 4);
  assert.deepEqual(detail.unmatchedCouriers.map(row => row.state), ['outside_scope', 'missing_saved_order', 'invalid_id', 'invalid_id']);
  assert.deepEqual(detail.unmatchedCouriers.map(row => row.sourceRow), [3, 4, 5, 6]);
  assert.ok(detail.unmatchedCouriers.every(row => row.sourceFile === '택배.xlsx' && row.sourceSheet === '주문' && row.issueKey && row.reason));
  assert.equal(detail.unmatchedCouriers[0].trackingNumber, '000222');
  assert.equal(detail.unmatchedCouriers[0].recipient, recipient);
  assert.ok(!JSON.stringify(detail).includes(address));
  assert.ok(!detail.batchIds.includes(outside.batch.id));
});

test('네이버 자료 없음·송장 없음·내부번호 오류와 미지원 몰 출고도 기본②목록에서 사라지지 않는다', t => {
  const db = database(t), supported = seed(db);
  const missingNaver = seed(db, { id: '000002', orderId: 'missing-product' });
  const missingCourier = seed(db, { id: '000003', orderId: 'other-order' });
  const invalid = importFiles(db, [file([['번호 없는 상품', '', '', recipient, telephone, address, 1]], legacyHeaders)]);
  const unsupported = importFiles(db, [file([['쿠팡 상품', '000004', oid, recipient, telephone, address, 1, '쿠팡']], [...legacyHeaders, '판매채널'])]);
  const preview = invoiceOrderSources(db, scopeIds(db));
  assert.equal(preview.orders.length, 5);
  assert.equal(preview.orders.find(order => order.batchId === invalid.batch.id).state, 'invalid_id');
  assert.equal(preview.orders.find(order => order.batchId === unsupported.batch.id).state, 'unsupported_mall');
  const detail = start(db, [product(), product({ productOrderId: 'other-product', orderId: 'other-order' })],
    [parcel(), parcel({ internalId: '000002', trackingNumber: '000222' }), parcel({ internalId: '000004', trackingNumber: '000444' })]);
  assert.equal(detail.orders.length, 3);
  assert.equal(detail.orders.find(order => order.batchId === supported.batch.id).state, 'ready');
  assert.ok(!detail.orders.some(order => order.batchId === missingNaver.batch.id));
  assert.ok(!detail.orders.some(order => order.batchId === invalid.batch.id));
  assert.equal(detail.orders.find(order => order.batchId === missingCourier.batch.id).state, 'missing_courier');
  assert.equal(detail.orders.find(order => order.batchId === unsupported.batch.id).state, 'unsupported_mall');
  assert.deepEqual(detail.items.find(item => item.productOrderId === pid).batchIds, [supported.batch.id]);
  assert.equal(detail.unmatchedCouriers.length, 1, '현재① 대상이 아닌 출고의③은 참고 목록에 표시합니다.');
});

test('번호 오류만 있는 ①·③파일도 출고 목록과 원본 행 경고를 보여주고 명백한 스토어명을 플랫폼으로 오판하지 않는다', t => {
  const db = database(t), saved = importFiles(db, [file([['미정리 원본', internal, oid, recipient, telephone, address, 1, '모의 브랜드']], [...legacyHeaders, '쇼핑몰'])]);
  let detail = start(db, [product({ productOrderId: '' })], [parcel({ trackingNumber: '' })]);
  assert.equal(detail.items.length, 0);
  assert.equal(detail.orders.length, 0, '유효한① 상품주문을 만들 수 없으면 임의로 저장 주문을 대상으로 삼지 않습니다.');
  assert.equal(invoiceOrderSources(db, [saved.batch.id]).orders[0].cleanedName, '미정리 원본');
  assert.equal(detail.unmatchedCouriers.length, 1);
  assert.ok(detail.issues.some(issue => issue.kind === 'invalid_naver_id'));
  assert.ok(detail.issues.some(issue => issue.kind === 'invalid_courier_id'));
  assert.throws(() => exportInvoices(db, detail.run.id), /포함 항목/);
  detail = start(db);
  assert.equal(detail.orders[0].state, 'ready');
  assert.equal(detail.items[0].batchIds[0], saved.batch.id);
  const noHeaders = importFiles(db, [file([['상품명만 있는 원본']], ['원상품명'])]);
  assert.equal(invoiceOrderSources(db, [noHeaders.batch.id]).orders[0].state, 'invalid_id');
});

test('선택②에 없는①상품도 보류 대상으로 남고 삭제된 선택 근거는 과거 화면에 보존한다', t => {
  const db = database(t), saved = seed(db);
  const detail = start(db, [product(), product({ productOrderId: 'other-product', orderId: 'not-selected-order' })]);
  assert.equal(detail.items.length, 2);
  const missing = detail.items.find(item => item.productOrderId === 'other-product');
  assert.equal(missing.decision, 'hold');
  assert.equal(missing.internalId, ''); assert.equal(missing.trackingNumber, '');
  assert.equal(detail.orders.find(order => order.productOrderId === 'other-product').sourceType, 'naver_only');
  assert.throws(() => exportInvoices(db, detail.run.id), /경고/);
  reviseInvoiceItems(db, detail.run.id, { issueResolutions: acknowledge(detail) });
  assert.throws(() => reviseInvoiceItems(db, detail.run.id, { changes: [change(missing, 'include', '이름이 같아도 연결 금지')] }), /불명확/);
  assert.equal(workbookRows(exportInvoices(db, detail.run.id).buffer).length, 2);
  deleteRows(db, saved.batch.id, [saved.rows[0].id]);
  const changed = invoiceDetail(db, detail.run.id);
  assert.equal(changed.orders.length, 2);
  assert.equal(changed.orders[0].state, 'source_deleted');
  assert.equal(changed.orders[0].rowId, saved.rows[0].id);
  assert.ok(changed.issues.some(issue => issue.kind === 'source_changed'));
  assert.throws(() => exportInvoices(db, detail.run.id), /경고/);
});

test('다른 날짜의 정확한 주문번호는 연결하고 같은 이름뿐인 원본은 추정 연결하지 않는다', t => {
  const db = database(t), selected = seed(db, { batchDate: '2026-10-28T01:00:00Z' });
  const outside = seed(db, { id: 'yesterday', orderId: 'outside-order', batchDate: '2026-10-27T01:00:00Z' });
  const products = [product(), product({ productOrderId: 'older-product', orderId: 'outside-order' }), product({ productOrderId: 'missing-same-name', orderId: 'absent-order' })];
  const detail = start(db, products, [parcel(), parcel({ internalId: 'yesterday', trackingNumber: '123456789' })], { batchIds: [selected.batch.id] });
  assert.equal(detail.summary.total, 3); assert.equal(detail.summary.connected, 2); assert.equal(detail.summary.missingSaved, 1);
  const older = detail.items.find(item => item.productOrderId === 'older-product');
  assert.equal(older.trackingNumber, '123456789'); assert.deepEqual(older.batchIds, [outside.batch.id]);
  const missing = detail.items.find(item => item.productOrderId === 'missing-same-name');
  assert.deepEqual(missing.sourceRows, []); assert.equal(missing.decision, 'hold'); assert.equal(missing.trackingNumber, '');
  assert.ok(detail.issues.some(issue => issue.kind === 'missing_saved_order' && issue.productOrderId === missing.productOrderId && issue.blocking));
  assert.equal(detail.unmatchedCouriers.length, 0);
});

test('구버전 매칭은 재매칭을 요구하고 같은 파일의 새 전체 대상 초안과 기존 검토·등록·생성 파일을 보존한다', async t => {
  for (const generated of [false, true]) await t.test(generated ? '기존 생성 내역' : '기존 작성 중', async t => {
    const db = database(t), saved = seed(db), products = [product(), product({ productOrderId: 'missing-product', orderId: 'missing-order' })];
    const detail = start(db, products), missing = detail.items[1];
    // 과거 v1은 같은 ① 파일을 보관했지만 ②가 없는 상품을 저장하지 않았습니다.
    db.prepare('DELETE FROM invoice_items WHERE id = ?').run(missing.id);
    db.prepare('UPDATE invoice_runs SET issues_json = ? WHERE id = ?').run(JSON.stringify(detail.issues.filter(issue => issue.productOrderId !== missing.productOrderId)), detail.run.id);
    reviseInvoiceItems(db, detail.run.id, { changes: [change(detail.items[0], 'include', '이미 확인한 정상 주문')] });
    const bytes = generated ? exportInvoices(db, detail.run.id).buffer : null;
    await refreshInvoiceStatus(db, detail.run.id, query([remote(detail.items[0])]));
    const record = db.prepare('SELECT scope_json FROM invoice_runs WHERE id = ?').get(detail.run.id);
    const scope = JSON.parse(record.scope_json); delete scope.matchingVersion; scope.inputFingerprint = 'scoped-v1-fixture';
    db.prepare('UPDATE invoice_runs SET fingerprint = ?, scope_json = ? WHERE id = ?').run('scoped-v1-fixture', JSON.stringify(scope), detail.run.id);
    const oldRecords = db.prepare('SELECT * FROM invoice_items WHERE run_id = ?').all(detail.run.id);
    const oldChecks = db.prepare('SELECT * FROM invoice_checks').all();
    const oldRevisions = db.prepare('SELECT * FROM invoice_revisions').all();
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    const old = invoiceDetail(db, detail.run.id);
    assert.equal(old.rematchRequired, true); assert.equal(old.items.length, 1);
    assert.throws(() => exportInvoices(db, detail.run.id), /다시 매칭/);
    assert.throws(() => reviseInvoiceItems(db, detail.run.id, { changes: [change(old.items[0], 'hold', '차단')] }), /다시 매칭/);
    await assert.rejects(refreshInvoiceStatus(db, detail.run.id, { queryProductOrders: () => { throw new Error('호출되면 안 됩니다.'); } }), /다시 매칭/);
    if (generated) {
      assert.ok(downloadInvoices(db, detail.run.id).buffer.equals(bytes));
      assert.throws(() => downloadInvoices(db, detail.run.id, { rebuild: true }), /다시 매칭/);
    }
    const fresh = start(db, products);
    assert.notEqual(fresh.run.id, detail.run.id); assert.equal(fresh.rematchRequired, false);
    assert.equal(fresh.run.matchingVersion, 'final-naver-all-dates-v3');
    assert.equal(fresh.summary.total, 2); assert.equal(fresh.summary.missingSaved, 1);
    assert.equal(fresh.items[0].note, '이미 확인한 정상 주문');
    assert.equal(fresh.items[0].registrationState, 'unchecked'); assert.equal(fresh.items[0].statusFresh, false);
    assert.equal(fresh.items[0].decision, 'hold');
    assert.ok(fresh.items[0].registrationRecheck);
    assert.equal(fresh.items[1].decision, 'hold');
    assert.equal(start(db, products).run.id, fresh.run.id, '새 최신 매칭을 반복 업로드하면 다시 늘리지 않습니다.');
    assert.deepEqual(db.prepare('SELECT * FROM invoice_items WHERE run_id = ?').all(detail.run.id), oldRecords);
    assert.deepEqual(db.prepare('SELECT * FROM invoice_checks').all(), oldChecks);
    assert.deepEqual(db.prepare('SELECT * FROM invoice_revisions WHERE item_id = ?').all(detail.items[0].id), oldRevisions);
    assert.deepEqual(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all(), schema, 'DDL 변경이 없습니다.');
    if (generated) assert.ok(downloadInvoices(db, detail.run.id).buffer.equals(bytes));
    assert.deepEqual(fresh.batchIds, [saved.batch.id]);
  });
});

const octoberNaver = '스마트스토어_전체주문발주발송관리_20261027_1512.xlsx';
const octoberCourier = '주문등록_출력(복수건)_출력완료(49)건 (2026-10-27 15시12분55초).xlsx';
test('10월27일 실제 파일의 누락 네 명을 보류 경고로 표시하고 정상43건·합배송·원본을 보존한다', {
  skip: ![octoberNaver, octoberCourier, 'rus00 (50).xls', 'rus00 (51).xls'].every(name => existsSync(new URL(name, reference))),
}, async t => {
  const db = database(t), source = name => ({ originalname: name, buffer: readFileSync(new URL(name, reference)) });
  const batches = ['rus00 (50).xls', 'rus00 (51).xls'].map(name => importFiles(db, [source(name)]));
  const original = snapshot(db), naver = source(octoberNaver), courier = source(octoberCourier);
  const input = { naverFiles: await unlockNaverFiles([naver], '1111'), courierFiles: [courier], carrier, batchIds: batches.map(batch => batch.batch.id) };
  const readRows = buffer => { const book = XLSX.read(buffer, { type: 'buffer' });
    return XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, raw: true, defval: null, blankrows: true }); };
  const naverRows = readRows(input.naverFiles[0].readBuffer || naver.buffer), courierRows = readRows(courier.buffer);
  const naverHeader = naverRows.find(row => row.includes('상품주문번호') && row.includes('주문번호'));
  const courierHeader = courierRows.find(row => row.includes('운송장번호') && row.includes('주문번호'));
  const naverAt = sourceRow => { const row = naverRows[sourceRow - 1];
    return [String(row[naverHeader.indexOf('수취인명')]), String(row[naverHeader.indexOf('상품주문번호')]),
      String(row[naverHeader.indexOf('주문번호')]), sourceRow]; };
  const courierTrackingAt = sourceRow => String(courierRows[sourceRow - 1][courierHeader.indexOf('운송장번호')]);
  const detail = importInvoiceFiles(db, input);
  assert.equal(detail.summary.total, 47); assert.equal(detail.summary.connected, 43); assert.equal(detail.summary.missingSaved, 4);
  assert.equal(detail.summary.included, 43); assert.equal(detail.summary.held, 4);
  const missing = detail.orders.filter(order => order.sourceType === 'naver_only');
  assert.deepEqual(missing.map(order => [order.recipient, order.productOrderId, order.orderId, order.source.sourceRow]),
    [17, 18, 19, 20].map(naverAt));  assert.ok(missing.every(order => order.state === 'missing_saved_order' && !order.trackingNumbers.length && order.issues.length));
  assert.match(missing.find(order => order.recipient === naverAt(19)[0]).optionName, /면100수/);
  assert.equal(detail.items.find(item => item.productOrderId === naverAt(22)[1]).trackingNumber,
    courierTrackingAt(35), '동명이인인 가상 수취인 A/B도 서로 다른 주문번호로 구분합니다.');
  assert.ok(detail.items.filter(item => missing.some(order => order.productOrderId === item.productOrderId)).every(item => item.decision === 'hold' && !item.internalId && !item.trackingNumber));
  const combined = detail.items.filter(item => item.orderId === naverAt(27)[2]);
  assert.equal(combined.length, 3); assert.equal(combined.reduce((quantity, item) => quantity + item.quantity, 0), 4);
  assert.deepEqual([...new Set(combined.map(item => item.trackingNumber))], [courierTrackingAt(30)]);
  assert.equal(detail.orders.filter(order => order.sourceType !== 'naver_only').length, 41, '최종①에 없는 원본8행은 이번 검토 대상에 섞지 않습니다.');
  assert.throws(() => exportInvoices(db, detail.run.id), /경고/);
  const reviewed = reviseInvoiceItems(db, detail.run.id, { issueResolutions: acknowledge(detail) });
  assert.equal(reviewed.summary.held, 4);
  const output = workbookRows(exportInvoices(db, detail.run.id).buffer);
  assert.equal(output.length, 44);
  assert.ok(!output.slice(1).some(row => missing.some(order => order.productOrderId === row[0])));
  assert.equal(importInvoiceFiles(db, input).run.id, detail.run.id);
  assert.deepEqual(snapshot(db), original);
  assert.ok(Buffer.from(db.prepare("SELECT content FROM invoice_files WHERE run_id = ? AND kind = 'naver'").get(detail.run.id).content).equals(naver.buffer));
});

test('스코프 없는 기존 DB는 자동 마이그레이션하되 과거 이력을 보존하고 새 매칭 전 엑셀·등록 조회를 막는다', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'system0-invoices-')), filename = path.join(directory, 'fixture.sqlite');
  let db;
  try {
    db = openDatabase(filename); seed(db); const created = start(db);
    reviseInvoiceItems(db, created.run.id, { changes: [change(created.items[0], 'hold', '기존 검토 기록')] });
    await refreshInvoiceStatus(db, created.run.id, query(created.items.map(item => remote(item))));
    const original = snapshot(db), checks = db.prepare('SELECT * FROM invoice_checks').all(), revisions = db.prepare('SELECT * FROM invoice_revisions').all();
    db.prepare("UPDATE invoice_runs SET fingerprint = 'pre-scope-fixture' WHERE id = ?").run(created.run.id);
    db.exec('ALTER TABLE invoice_runs DROP COLUMN scope_json');
    db.close(); db = openDatabase(filename);
    const old = invoiceDetail(db, created.run.id);
    assert.equal(old.scopeRequired, true); assert.deepEqual(old.orders, []); assert.deepEqual(old.batchIds, []);
    assert.equal(old.items[0].note, '기존 검토 기록');
    assert.equal(old.items[0].statusFresh, false);
    assert.equal(old.items[0].registrationState, 'unchecked');
    assert.throws(() => exportInvoices(db, old.run.id), /새로 매칭/);
    let queried = false;
    await assert.rejects(refreshInvoiceStatus(db, old.run.id, { queryProductOrders: async () => { queried = true; return []; } }), /새로 매칭/);
    assert.equal(queried, false);
    assert.deepEqual(snapshot(db), original);
    assert.deepEqual(db.prepare('SELECT * FROM invoice_checks').all(), checks);
    assert.deepEqual(db.prepare('SELECT * FROM invoice_revisions').all(), revisions);
    const fresh = start(db);
    assert.notEqual(fresh.run.id, old.run.id);
    assert.equal(fresh.scopeRequired, false);
    assert.equal(fresh.items[0].registrationState, 'unchecked', '범위 미지정 과거 완료를 새 작업의 실조회로 오인하지 않습니다.');
  } finally { db?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('매칭·검토·조회는 작성 중이고 실제 엑셀 성공 생성 후에만 생성 내역으로 옮긴다', async t => {
  const db = database(t); seed(db);
  const detail = start(db, [product(), product({ productOrderId: 'second-product' })]);
  assert.equal(detail.run.isDraft, true); assert.equal(detail.run.generatedAt, null);
  assert.deepEqual(listInvoiceRuns(db), []);
  assert.equal(listInvoiceDrafts(db)[0].id, detail.run.id);
  assert.equal(listInvoiceDrafts(db)[0].registrationState, 'unchecked');
  reviseInvoiceItems(db, detail.run.id, { changes: [change(detail.items[0], 'hold', '부분 보류')] });
  await refreshInvoiceStatus(db, detail.run.id, query(detail.items.map(item => remote(item))));
  assert.deepEqual(listInvoiceRuns(db), []);
  assert.equal(invoiceDetail(db, detail.run.id).run.generatedAt, null);
  const current = listInvoiceDrafts(db)[0];
  assert.equal(current.registrationState, 'partial');
  assert.deepEqual(current.registrationSummary, { total: 2, complete: 1, conflict: 0 });
  assert.throws(() => exportInvoices(db, detail.run.id), /이미 등록/);
  assert.equal(invoiceDetail(db, detail.run.id).run.generatedAt, null, '실패한 생성은 생성 시각을 기록하지 않습니다.');
  await refreshInvoiceStatus(db, detail.run.id, query(detail.items.map(item => remote(item, { status: 'PAYED', trackingNumber: '', deliveryCompanyCode: '' }))));
  const output = exportInvoices(db, detail.run.id);
  assert.equal(workbookRows(output.buffer).length, 2);
  const generatedAt = invoiceDetail(db, detail.run.id).run.generatedAt;
  assert.ok(generatedAt);
  assert.deepEqual(listInvoiceDrafts(db), []);
  assert.equal(listInvoiceRuns(db)[0].id, detail.run.id);
  assert.equal(listInvoiceRuns(db)[0].generatedAt, generatedAt);
  assert.equal(listInvoiceRuns(db)[0].registrationState, 'pending');
  assert.equal(invoiceDetail(db, detail.run.id).run.isDraft, false);
  exportInvoices(db, detail.run.id);
  assert.equal(invoiceDetail(db, detail.run.id).run.generatedAt, generatedAt, '재다운로드로 최초 생성 시각을 바꾸지 않습니다.');
  assert.equal(start(db, [product(), product({ productOrderId: 'second-product' })]).run.id, detail.run.id);
});

test('같은 한국 작업 날짜의 추가 업로드·재매칭은 최신 초안 하나로 보이고 변경 없는 직원 검토를 이력과 함께 보존한다', t => {
  const db = database(t), firstSource = seed(db, { batchDate: '2026-10-20T15:00:00.000Z' });
  const first = start(db);
  reviseInvoiceItems(db, first.run.id, { changes: [change(first.items[0], 'hold', '직원이 확인 중인 항목')] });
  const oldFiles = db.prepare('SELECT * FROM invoice_files WHERE run_id = ?').all(first.run.id);
  const newSource = seed(db, { id: '000002', orderId: 'second-order', name: '커버', batchDate: '2026-10-21T12:00:00.000Z' });
  const sourceBefore = snapshot(db);
  const next = start(db, [product(), product({ productOrderId: 'second-product', orderId: 'second-order', name: '커버' })],
    [parcel(), parcel({ internalId: '000002', trackingNumber: '000222' })]);
  assert.equal(next.run.draftKey, first.run.draftKey);
  assert.deepEqual(next.batchIds, [firstSource.batch.id, newSource.batch.id]);
  assert.deepEqual(listInvoiceDrafts(db).map(run => run.id), [next.run.id]);
  assert.deepEqual(listInvoiceDrafts(db, '2026-10-21').map(run => run.id), [next.run.id]);
  assert.deepEqual(listInvoiceDrafts(db, '2026-10-20'), []);
  const inherited = next.items.find(item => item.productOrderId === pid);
  assert.equal(inherited.decision, 'hold');
  assert.equal(inherited.note, '직원이 확인 중인 항목');
  const copied = db.prepare('SELECT after_json FROM invoice_revisions WHERE item_id = ?').get(inherited.id);
  assert.equal(JSON.parse(copied.after_json).copiedFromItemId, first.items[0].id);
  assert.equal(invoiceDetail(db, first.run.id).items[0].note, '직원이 확인 중인 항목');
  assert.deepEqual(db.prepare('SELECT * FROM invoice_files WHERE run_id = ?').all(first.run.id), oldFiles);
  assert.deepEqual(snapshot(db), sourceBefore);
  const changed = start(db, [product({ quantity: 5 })], [parcel()], { batchIds: [firstSource.batch.id] });
  assert.equal(changed.items[0].note, '', '수량 등 검토 근거가 바뀌면 과거 검토를 현재 검토로 복제하지 않습니다.');
  assert.equal(invoiceDetail(db, next.run.id).items.find(item => item.productOrderId === pid).note, '직원이 확인 중인 항목');
});

test('미생성 A→B→A 재매칭은 새 현재 초안으로 갱신하며 동일 최신 입력과 생성된 입력은 그대로 재개한다', t => {
  const db = database(t); seed(db);
  const a = start(db);
  reviseInvoiceItems(db, a.run.id, { changes: [change(a.items[0], 'hold', '검수 메모')] });
  const b = start(db, undefined, undefined, { naverFiles: [naverFile([product()], '다른 파일.xlsx', [...naverHeaders, '참고'])] });
  assert.notEqual(b.run.id, a.run.id);
  const again = start(db);
  assert.notEqual(again.run.id, a.run.id); assert.notEqual(again.run.id, b.run.id);
  assert.equal(again.items[0].note, '검수 메모');
  assert.equal(again.items[0].superseded, false);
  assert.deepEqual(listInvoiceDrafts(db).map(run => run.id), [again.run.id]);
  assert.equal(start(db).run.id, again.run.id);
  assert.equal(db.prepare('SELECT count(*) n FROM invoice_runs').get().n, 3);
  reviseInvoiceItems(db, again.run.id, { changes: [change(again.items[0], 'include', '검토 완료')] });
  exportInvoices(db, again.run.id);
  const generatedAt = invoiceDetail(db, again.run.id).run.generatedAt;
  assert.deepEqual(listInvoiceDrafts(db), []);
  assert.deepEqual(listInvoiceRuns(db).map(run => run.id), [again.run.id]);
  assert.equal(start(db).run.id, again.run.id);
  assert.equal(invoiceDetail(db, again.run.id).run.generatedAt, generatedAt);
  assert.equal(db.prepare('SELECT count(*) n FROM invoice_runs').get().n, 3);
});

test('생성 내역의 실제 등록 상태는 새 송장·보류·조회 충돌과 분리하며 초안 날짜는 출고 작업의 한국 날짜로 찾는다', async t => {
  const db = database(t); seed(db, { batchDate: '2026-10-19T14:59:59.999Z' });
  const first = start(db); exportInvoices(db, first.run.id);
  assert.equal(listInvoiceRuns(db)[0].registrationState, 'unchecked');
  await refreshInvoiceStatus(db, first.run.id, query(first.items.map(item => remote(item))));
  assert.equal(listInvoiceRuns(db)[0].registrationState, 'complete');
  const next = start(db, undefined, [parcel({ round: 2, original: tracking, count: 2, trackingNumber: '000222', printedAt: '2026-10-21T11:00:00+09:00' })]);
  assert.deepEqual(listInvoiceDrafts(db, '2026-10-19').map(run => run.id), [next.run.id]);
  assert.deepEqual(listInvoiceDrafts(db, '2026-10-20'), []);
  assert.equal(listInvoiceRuns(db)[0].registrationState, 'unchecked');
  assert.equal(listInvoiceRuns(db)[0].registrationSummary.complete, 0);
  await refreshInvoiceStatus(db, next.run.id, query(next.items.map(item => remote(item, { isWrongTrackingNumber: true }))));
  assert.equal(listInvoiceDrafts(db)[0].registrationState, 'conflict');
  assert.deepEqual(listInvoiceDrafts(db)[0].registrationSummary, { total: 1, complete: 0, conflict: 1 });
  for (const date of ['2026-02-30', '0000-01-01', ['2026-10-21'], 'bad']) assert.throws(() => listInvoiceDrafts(db, date), /날짜/);
});

test('기존 범위 지정 이력은 생성 사실을 추정하지 않고 날짜별 최신 초안 하나로 마이그레이션한다', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'system0-invoices-')), filename = path.join(directory, 'fixture.sqlite');
  let db;
  try {
    db = openDatabase(filename); seed(db, { batchDate: '2026-10-21T00:00:00Z' });
    const first = start(db);
    reviseInvoiceItems(db, first.run.id, { changes: [change(first.items[0], 'hold', '이전 검토')] });
    const next = start(db, undefined, undefined, { naverFiles: [naverFile([product()], '변경 원본.xlsx', [...naverHeaders, '메모'])] });
    await refreshInvoiceStatus(db, next.run.id, query(next.items.map(item => remote(item))));
    const sourceBefore = snapshot(db), oldFiles = db.prepare('SELECT * FROM invoice_files').all(), revisions = db.prepare('SELECT * FROM invoice_revisions').all();
    db.exec(`DROP INDEX invoice_runs_draft;
      ALTER TABLE invoice_runs DROP COLUMN draft_key;
      ALTER TABLE invoice_runs DROP COLUMN generated_at;`);
    db.close(); db = openDatabase(filename);
    const drafts = listInvoiceDrafts(db, '2026-10-21');
    assert.deepEqual(drafts.map(run => run.id), [next.run.id]);
    assert.equal(drafts[0].generatedAt, null);
    assert.equal(invoiceDetail(db, first.run.id).run.generatedAt, null);
    assert.equal(invoiceDetail(db, first.run.id).run.draftKey, drafts[0].draftKey);
    assert.deepEqual(listInvoiceRuns(db), []);
    assert.deepEqual(snapshot(db), sourceBefore);
    assert.deepEqual(db.prepare('SELECT * FROM invoice_files').all(), oldFiles);
    assert.deepEqual(db.prepare('SELECT * FROM invoice_revisions').all(), revisions);
    assert.equal(invoiceDetail(db, next.run.id).items[0].note, '이전 검토');
  } finally { db?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('하단 송장 행의 번호·재발급·상자·수취정보 경고는 조회만 하고 미확인 상태 그대로 정상 주문을 내보낸다', t => {
  const db = database(t), saved = seed(db);
  const row = (number, id, round = 1, original = '', issued = 1, recipientName = recipient) =>
    [number, id, round, original, issued, '12:00:00', '쿠션', recipientName, telephone, address];
  const detail = start(db, undefined, undefined, { batchIds: [saved.batch.id], courierFiles: [file([
    row(tracking, internal), row('outside-1', 'outside-split'), row('outside-2', 'outside-split'),
    row('outside-3', 'outside-recipient'), row('outside-4', 'outside-recipient', 2, '', 1, '다른 모의 수취인'),
    row('outside-5', 'outside-reprint', 1, 'old-1'), row('outside-5', 'outside-reprint', 1, 'old-2', 2),
    row('outside-6', ''), row('', 'outside-missing-tracking'),
  ], courierHeaders, '미연결 송장 포함.xlsx')] });
  for (const kind of ['invalid_courier_id', 'reprint_conflict', 'reprint_uncertain', 'parcel_uncertain', 'courier_conflict', 'unmatched_courier']) {
    assert.ok(detail.issues.some(warning => warning.kind === kind), kind);
  }
  assert.equal(detail.unmatchedCouriers.length, 8);
  assert.ok(detail.issues.every(warning => warning.reviewRequired === false && !warning.resolved && warning.note === ''));
  assert.equal(detail.summary.issues, 0);
  assert.equal(detail.orders[0].state, 'ready');
  const originalWarnings = db.prepare('SELECT issues_json FROM invoice_runs WHERE id = ?').get(detail.run.id).issues_json;
  assert.equal(workbookRows(exportInvoices(db, detail.run.id).buffer).length, 2);
  const reopened = invoiceDetail(db, detail.run.id);
  assert.ok(reopened.issues.every(warning => !warning.reviewRequired && !warning.resolved && warning.note === ''));
  assert.equal(db.prepare('SELECT issues_json FROM invoice_runs WHERE id = ?').get(detail.run.id).issues_json, originalWarnings,
    '기존 경고의 확인 여부와 기록을 자동으로 변경하지 않습니다.');
});

test('선택 주문의 미매칭은 메모 없이 체크만 저장하며 생략한 기존 메모를 보존하고 잘못된 확인 요청은 취소한다', t => {
  const db = database(t); seed(db); seed(db, { id: '000002', orderId: 'missing-naver-order' });
  const detail = start(db, [product({ recipient: '확인이 필요한 모의 수취인' })]);
  assert.ok(detail.issues.length && detail.issues.every(warning => warning.reviewRequired));
  assert.ok(detail.orders.find(order => order.internalId === internal).issues.length);
  assert.throws(() => exportInvoices(db, detail.run.id), /경고|포함/);
  const key = detail.issues[0].key;
  const rawBefore = db.prepare('SELECT issues_json FROM invoice_runs WHERE id = ?').get(detail.run.id).issues_json;
  for (const resolutions of [[{ key, note: null }], [{ key, note: 1 }], [{ key, note: {} }], [{ key, note: [] }],
    [{ key, note: 'a'.repeat(1001) }], [{ key }, { key }], [{ key }, { key: '없는 경고' }]]) {
    assert.throws(() => reviseInvoiceItems(db, detail.run.id, { issueResolutions: resolutions }), /형식|중복/);
    assert.equal(db.prepare('SELECT issues_json FROM invoice_runs WHERE id = ?').get(detail.run.id).issues_json, rawBefore);
  }
  let reviewed = reviseInvoiceItems(db, detail.run.id, { issueResolutions: detail.issues.map(warning => ({ key: warning.key })) });
  assert.equal(reviewed.summary.issues, 0);
  assert.ok(reviewed.issues.every(warning => warning.resolved && warning.note === ''));
  reviseInvoiceItems(db, detail.run.id, { changes: [change(reviewed.items[0], 'include')] });
  assert.equal(workbookRows(exportInvoices(db, detail.run.id).buffer).length, 2);
  reviseInvoiceItems(db, detail.run.id, { issueResolutions: [{ key, note: '기존 선택 메모' }] });
  reviewed = reviseInvoiceItems(db, detail.run.id, { issueResolutions: [{ key }] });
  assert.equal(reviewed.issues.find(warning => warning.key === key).note, '기존 선택 메모');
  reviewed = reviseInvoiceItems(db, detail.run.id, { issueResolutions: [{ key, note: '' }] });
  assert.equal(reviewed.issues.find(warning => warning.key === key).note, '');
});

test('선택 주문의 실제 송장 충돌은 체크만 해도 강제 포함하지 않고 보류한 채 정상 주문만 내보낸다', t => {
  const db = database(t); seed(db); seed(db, { id: '000002', orderId: 'second-order' });
  const detail = start(db, [product(), product({ productOrderId: 'second-product', orderId: 'second-order' })],
    [parcel(), parcel({ trackingNumber: '000333' }), parcel({ internalId: '000002', trackingNumber: '000222' })]);
  const ambiguous = detail.items.find(item => item.productOrderId === pid), warning = detail.issues.find(issue => issue.kind === 'parcel_uncertain');
  assert.equal(warning.reviewRequired, true);
  assert.throws(() => reviseInvoiceItems(db, detail.run.id, { issueResolutions: [{ key: warning.key }],
    changes: [change(ambiguous, 'include')] }), /보류|확인/);
  assert.equal(invoiceDetail(db, detail.run.id).issues.find(issue => issue.key === warning.key).resolved, false);
  const reviewed = reviseInvoiceItems(db, detail.run.id, { issueResolutions: [{ key: warning.key, note: '' }] });
  assert.equal(reviewed.items.find(item => item.id === ambiguous.id).decision, 'hold');
  assert.equal(reviewed.issues.find(issue => issue.key === warning.key).resolved, true);
  assert.throws(() => reviseInvoiceItems(db, detail.run.id, { changes: [change(ambiguous, 'include')] }), /보류|확인/);
  const rows = workbookRows(exportInvoices(db, detail.run.id).buffer);
  assert.equal(rows.length, 2); assert.equal(rows[1][0], 'second-product');
});

test('날짜 재개는 생성일 대신 ②작업의 한국 날짜로 생성 전후 최신 scoped 결과를 읽는다', t => {
  const db = database(t), older = seed(db, { batchDate: '2026-10-20T14:59:59.999Z' });
  assert.equal(latestInvoice(db, '2026-10-20'), null);
  const first = start(db, undefined, undefined, { batchIds: [older.batch.id] });
  exportInvoices(db, first.run.id);
  db.prepare('UPDATE invoice_runs SET created_at = ?, generated_at = ? WHERE id = ?')
    .run('2026-10-25T00:00:00Z', '2026-10-26T00:00:00Z', first.run.id);
  assert.equal(latestInvoice(db, '2026-10-20').run.id, first.run.id);
  assert.equal(latestInvoice(db, '2026-10-20').run.savedFileAvailable, true);
  assert.equal(latestInvoice(db, '2026-10-21'), null);
  const today = seed(db, { id: '000002', orderId: 'second-order', batchDate: '2026-10-20T15:00:00.000Z' });
  const next = start(db, [product(), product({ productOrderId: 'second-product', orderId: 'second-order' })],
    [parcel(), parcel({ internalId: '000002', trackingNumber: '000222' })], { batchIds: [older.batch.id, today.batch.id] });
  assert.equal(latestInvoice(db, '2026-10-20').run.id, first.run.id);
  assert.equal(latestInvoice(db, '2026-10-21').run.id, next.run.id);
  assert.equal(latestInvoice(db, '2026-10-21').run.generatedAt, null);
  exportInvoices(db, next.run.id);
  assert.equal(latestInvoice(db, '2026-10-21').run.id, next.run.id);
  assert.deepEqual(listInvoiceDrafts(db), []);
  const outside = start(db, undefined, undefined, { batchIds: [older.batch.id], store: '범위 없는 구내역' });
  db.prepare('UPDATE invoice_runs SET scope_json = NULL WHERE id = ?').run(outside.run.id);
  assert.equal(latestInvoice(db, '2026-10-20').run.id, first.run.id);
  for (const date of [undefined, '', 'bad', '0000-01-01', '2026-02-30', ['2026-10-20']]) assert.throws(() => latestInvoice(db, date), /날짜/);
});

test('실제 생성 파일은 등록 완료·근거 변경 뒤에도 동일 바이트로 복사하고 신규 생성의 중복 제외는 유지한다', async t => {
  const db = database(t), saved = seed(db), detail = start(db);
  assert.throws(() => downloadInvoices(db, detail.run.id), /처음 생성/);
  assert.throws(() => downloadInvoices(db, detail.run.id, { rebuild: true }), /처음 생성/);
  const output = exportInvoices(db, detail.run.id), generatedAt = invoiceDetail(db, detail.run.id).run.generatedAt;
  assert.equal(invoiceDetail(db, detail.run.id).run.savedFileAvailable, true);
  assert.ok(Buffer.from(db.prepare('SELECT generated_file FROM invoice_runs WHERE id = ?').get(detail.run.id).generated_file).equals(output.buffer));
  await refreshInvoiceStatus(db, detail.run.id, query(detail.items.map(item => remote(item))));
  assert.throws(() => exportInvoices(db, detail.run.id), /이미 등록/);
  deleteRows(db, saved.batch.id, [saved.rows[0].id]);
  const tables = ['invoice_runs', 'invoice_files', 'invoice_items', 'invoice_revisions', 'invoice_checks', 'rows', 'row_revisions'];
  const snapshot = () => tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
  const before = snapshot(), copied = downloadInvoices(db, detail.run.id);
  assert.ok(copied.buffer.equals(output.buffer));
  assert.equal(copied.filename, output.filename);
  assert.deepEqual(snapshot(), before, '저장본 다운로드는 등록 상태·원본·검수·파일 이력을 변경하지 않습니다.');
  assert.equal(invoiceDetail(db, detail.run.id).run.generatedAt, generatedAt);
  assert.ok(!Object.hasOwn(invoiceDetail(db, detail.run.id).run, 'generated_file'), '파일 바이트는 JSON 응답에 노출하지 않습니다.');
});

test('같은 내역에서 다시 성공 생성한 파일을 마지막 저장본으로 받고 최초 생성 시각은 유지한다', t => {
  const db = database(t); seed(db);
  const detail = start(db, [product(), product({ productOrderId: 'second-product' })]);
  reviseInvoiceItems(db, detail.run.id, { changes: [change(detail.items[1], 'hold', '두 번째 상품 보류')] });
  const first = exportInvoices(db, detail.run.id), generatedAt = invoiceDetail(db, detail.run.id).run.generatedAt;
  assert.equal(workbookRows(first.buffer).length, 2);
  reviseInvoiceItems(db, detail.run.id, { changes: [change(detail.items[1], 'include', '두 번째 상품 확인')] });
  const last = exportInvoices(db, detail.run.id);
  assert.equal(workbookRows(last.buffer).length, 3);
  assert.ok(!last.buffer.equals(first.buffer));
  assert.ok(downloadInvoices(db, detail.run.id).buffer.equals(last.buffer));
  assert.equal(invoiceDetail(db, detail.run.id).run.generatedAt, generatedAt);
});

test('보관본 없는 생성 내역은 명시적 현재 매칭 재생성만 허용하고 등록 완료도 포함한 새 파일임을 구분한다', async t => {
  const db = database(t); seed(db); const detail = start(db);
  exportInvoices(db, detail.run.id);
  const generatedAt = invoiceDetail(db, detail.run.id).run.generatedAt;
  db.prepare('UPDATE invoice_runs SET generated_file = NULL, generated_filename = NULL WHERE id = ?').run(detail.run.id);
  await refreshInvoiceStatus(db, detail.run.id, query(detail.items.map(item => remote(item))));
  const beforeItems = db.prepare('SELECT * FROM invoice_items').all(), beforeChecks = db.prepare('SELECT * FROM invoice_checks').all();
  assert.equal(invoiceDetail(db, detail.run.id).run.savedFileAvailable, false);
  assert.throws(() => downloadInvoices(db, detail.run.id), error => error.code === 'saved_file_missing');
  assert.throws(() => exportInvoices(db, detail.run.id), /이미 등록/);
  const rebuilt = downloadInvoices(db, detail.run.id, { rebuild: true });
  assert.match(rebuilt.filename, /_현재매칭재생성\.xlsx$/);
  assert.equal(workbookRows(rebuilt.buffer).length, 2);
  assert.equal(workbookRows(rebuilt.buffer)[1][0], pid);
  assert.equal(invoiceDetail(db, detail.run.id).run.savedFileAvailable, true);
  const copy = downloadInvoices(db, detail.run.id);
  assert.ok(copy.buffer.equals(rebuilt.buffer)); assert.equal(copy.filename, rebuilt.filename);
  assert.equal(invoiceDetail(db, detail.run.id).run.generatedAt, generatedAt);
  assert.deepEqual(db.prepare('SELECT * FROM invoice_items').all(), beforeItems);
  assert.deepEqual(db.prepare('SELECT * FROM invoice_checks').all(), beforeChecks);
});

test('현재 매칭 재생성도 충돌·미해결 경고·삭제된 근거를 통과시키지 않는다', async t => {
  for (const failure of ['conflict', 'deleted', 'unresolved']) {
    const db = database(t), saved = seed(db);
    const detail = start(db, [product({ recipient: failure === 'unresolved' ? '다른 모의 수취인' : recipient })]);
    if (failure === 'unresolved') reviseInvoiceItems(db, detail.run.id, { issueResolutions: acknowledge(detail), changes: [change(detail.items[0], 'include')] });
    exportInvoices(db, detail.run.id);
    db.prepare('UPDATE invoice_runs SET generated_file = NULL, generated_filename = NULL WHERE id = ?').run(detail.run.id);
    if (failure === 'conflict') await refreshInvoiceStatus(db, detail.run.id, query(detail.items.map(item => remote(item, { isWrongTrackingNumber: true }))));
    else if (failure === 'deleted') deleteRows(db, saved.batch.id, [saved.rows[0].id]);
    else {
      const warnings = JSON.parse(db.prepare('SELECT issues_json FROM invoice_runs WHERE id = ?').get(detail.run.id).issues_json);
      warnings.forEach(warning => { warning.resolved = false; });
      db.prepare('UPDATE invoice_runs SET issues_json = ? WHERE id = ?').run(JSON.stringify(warnings), detail.run.id);
    }
    assert.throws(() => downloadInvoices(db, detail.run.id, { rebuild: true }), /충돌|경고/);
    assert.equal(invoiceDetail(db, detail.run.id).run.savedFileAvailable, false);
  }
});

test('생성 파일 저장 컬럼이 없던 DB는 원본·완료 이력을 보존하며 파일을 추측하지 않고 명시 재생성한다', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'system0-invoices-')), filename = path.join(directory, 'fixture.sqlite');
  let db;
  try {
    db = openDatabase(filename); seed(db, { batchDate: '2026-10-21T00:00:00Z' }); const detail = start(db);
    exportInvoices(db, detail.run.id);
    await refreshInvoiceStatus(db, detail.run.id, query(detail.items.map(item => remote(item))));
    const original = snapshot(db), generatedAt = invoiceDetail(db, detail.run.id).run.generatedAt;
    const beforeItems = db.prepare('SELECT * FROM invoice_items').all(), beforeChecks = db.prepare('SELECT * FROM invoice_checks').all();
    db.exec('ALTER TABLE invoice_runs DROP COLUMN generated_file; ALTER TABLE invoice_runs DROP COLUMN generated_filename;');
    db.close(); db = openDatabase(filename);
    assert.equal(invoiceDetail(db, detail.run.id).run.savedFileAvailable, false);
    assert.equal(latestInvoice(db, '2026-10-21').run.id, detail.run.id);
    assert.equal(invoiceDetail(db, detail.run.id).run.generatedAt, generatedAt);
    assert.throws(() => downloadInvoices(db, detail.run.id), error => error.code === 'saved_file_missing');
    assert.deepEqual(snapshot(db), original);
    assert.deepEqual(db.prepare('SELECT * FROM invoice_items').all(), beforeItems);
    assert.deepEqual(db.prepare('SELECT * FROM invoice_checks').all(), beforeChecks);
    const rebuilt = downloadInvoices(db, detail.run.id, { rebuild: true });
    db.close(); db = openDatabase(filename);
    assert.ok(downloadInvoices(db, detail.run.id).buffer.equals(rebuilt.buffer));
    assert.match(downloadInvoices(db, detail.run.id).filename, /현재매칭재생성/);
  } finally { db?.close(); rmSync(directory, { recursive: true, force: true }); }
});


test('현재① 밖 주문이 같은 내부 출고번호를 사용하면 숨기지 않고 보류하며 이후 충돌도 내보내기 전에 탐지한다', t => {
  for (const collisionBefore of [true, false]) {
    const db = database(t); seed(db);
    if (collisionBefore) seed(db, { orderId: 'different-order' });
    const initial = start(db);
    if (!collisionBefore) seed(db, { orderId: 'different-order' });
    const detail = invoiceDetail(db, initial.run.id);
    assert.equal(detail.items.length, 1, '현재① 밖 상품주문을 출력 대상에 추가하지 않습니다.');
    assert.equal(detail.orders.length, 1);
    assert.ok(detail.issues.some(issue => issue.kind === 'legacy_conflict' && issue.blocking));
    if (collisionBefore) assert.equal(detail.items[0].decision, 'hold');
    assert.throws(() => exportInvoices(db, detail.run.id), /포함|경고/);
    assert.throws(() => reviseInvoiceItems(db, detail.run.id, { changes: [change(detail.items[0], 'include')], issueResolutions: acknowledge(detail) }), /불명확|확인/);
  }
});


test('등록 재확인 보류는 파일을 연달아 바꿔도 유지하고 실제 최신 조회로만 해제한다', async t => {
  const db = database(t); seed(db);
  const first = start(db);
  await refreshInvoiceStatus(db, first.run.id, query(first.items.map(item => remote(item))));
  const second = start(db, undefined, undefined, { naverFiles: [naverFile([product()], '두 번째 파일.xlsx', [...naverHeaders, '두 번째 메모'])] });
  const third = start(db, undefined, undefined, { naverFiles: [naverFile([product()], '세 번째 파일.xlsx', [...naverHeaders, '세 번째 메모'])] });
  assert.notEqual(second.run.id, third.run.id);
  assert.equal(third.items[0].decision, 'hold'); assert.ok(third.items[0].registrationRecheck);
  assert.ok(third.issues.some(issue => issue.kind === 'registration_recheck' && issue.blocking));
  assert.throws(() => exportInvoices(db, third.run.id), /포함|경고/);
  assert.throws(() => reviseInvoiceItems(db, third.run.id, { issueResolutions: acknowledge(third) }), /조회/);
  const checked = await refreshInvoiceStatus(db, third.run.id, query(third.items.map(item => remote(item, { status: 'PAYED', trackingNumber: '', deliveryCompanyCode: '' }))));
  assert.equal(checked.items[0].decision, 'include'); assert.equal(checked.items[0].registrationState, 'pending');
  assert.equal(workbookRows(exportInvoices(db, third.run.id).buffer).length, 2);
});

test('내부번호 충돌 원본을 제거한 뒤 재매칭하면 새 근거로 보류를 해제하고 과거 결과는 보존한다', t => {
  const db = database(t); seed(db);
  const collision = seed(db, { orderId: 'different-order' });
  const first = start(db); assert.equal(first.items[0].decision, 'hold');
  deleteBatch(db, collision.batch.id);
  const second = start(db);
  assert.notEqual(first.run.id, second.run.id); assert.equal(second.items[0].decision, 'include');
  assert.equal(workbookRows(exportInvoices(db, second.run.id).buffer).length, 2);
  assert.equal(invoiceDetail(db, first.run.id).items.length, 1);
});
