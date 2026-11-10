import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { openDatabase } from '../lib/database.mjs';
import { importFiles } from '../lib/excel.mjs';
import { CARRIERS, importInvoiceFiles, invoiceDetail, reviseInvoiceItems, exportInvoices, downloadInvoices, refreshInvoiceStatus } from '../lib/invoices.mjs';

const identity = { product: '2026010100000001', order: '2026010100000002', internal: 'mock-internal', first: 'mock-first', second: 'mock-second' };
const recipient = '가상 수취인', contact = '010-0000-0101', oldAddress = '가상시 처음로 1 101호', newAddress = '가상시 변경로 2 202호';
function file(rows, name) {
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), '주문');
  return { originalname: name, buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) };
}
function saved(db, { address = oldAddress, order = identity.order, name = '가상 상품', phone = contact } = {}) {
  const imported = importFiles(db, [file([
    ['원상품명', '주문번호', '체결번호', '송화주', '전화번호', '주소', '수량'],
    [name, identity.internal, order, recipient, phone, address, 1],
  ], '저장 주문.xlsx')]);
  db.prepare("UPDATE rows SET cleaned_name = original_name, status = 'confirmed', name_source = 'manual' WHERE batch_id = ?").run(imported.batch.id);
  return imported;
}
function naver({ status = 'PAYED', products = 1, sourceTracking = '', sourceCarrier = '' } = {}) {
  const rows = [['상품주문번호', '주문번호', '상품명', '수량', '수취인명', '수취인연락처1', '통합배송지', '주문상태', '택배사', '송장번호'],
    [identity.product, identity.order, '가상 상품', 1, recipient, contact, oldAddress, status, sourceCarrier, sourceTracking]];
  if (products > 1) rows.push(['2026010100000003', identity.order, '가상 추가 상품', 1, recipient, contact, oldAddress, 'PAYED', '', '']);
  return file(rows, '네이버.xlsx');
}
function courier({ sameRound = false, explicitReplacement = false, secondRecipient = recipient } = {}) {
  const headers = ['운송장번호', '주문번호', '차수', '원송장번호', '발행횟수', '출력시간', '물품명',
    '수하인', '수하인', '수하인', '수하인', '수하인', '송하인', '송하인'];
  const subheaders = ['', '', '', '', '', '', '', '이름', '주소', '상세주소', '전화', '휴대폰', '이름', '주소'];
  const row = (number, round, original, time, name, address, detail) =>
    [number, identity.internal, round, original, 1, time, '가상 상품', name, address, detail, contact, '', '가상 발송인', '발송지 주소'];
  return file([['가상 로젠 출력'], headers, subheaders,
    row(identity.first, 1, '', '10:20:00', recipient, '가상시 처음로 1', '101호'),
    row(identity.second, sameRound ? 1 : 2, explicitReplacement ? identity.first : '', '15:18:00', secondRecipient, '가상시 변경로 2', '202호')], '택배.xlsx');
}
function setup(t, options = {}) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  saved(db); saved(db, { address: newAddress, name: '[주소변경] 가상 상품', ...(options.changedSource || {}) });
  const input = { naverFiles: [naver(options)], courierFiles: [courier(options)], carrier: CARRIERS[0], sourceDate: '2026-01-01' };
  return { db, input, detail: importInvoiceFiles(db, input) };
}
const acknowledged = detail => detail.issues.filter(warning => warning.kind !== 'registration_recheck' && warning.reviewRequired && !warning.resolved).map(warning => ({ key: warning.key }));
function select(db, detail, number = identity.second, decision = 'include', issueResolutions = acknowledged(detail)) {
  return reviseInvoiceItems(db, detail.run.id, { changes: [{ id: detail.items[0].id, selectedTrackingNumber: number, decision, note: '' }], issueResolutions });
}
const rows = buffer => { const book = XLSX.read(buffer); return XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, raw: true }); };
const sourceSnapshot = db => Object.fromEntries(['batches', 'rows', 'sheets', 'source_files'].map(table => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY id').all()]));

test('로젠 2단 수하인 헤더를 읽되 송하인과 하위 제목을 주문으로 섞지 않는다', t => {
  const { detail } = setup(t);
  assert.equal(detail.items[0].physicalShipments.length, 2);
  assert.deepEqual(detail.items[0].physicalShipments.map(parcel => parcel.sources[0].sourceRow), [4, 5]);
  assert.equal(detail.items[0].physicalShipments[1].recipient, recipient);
  assert.equal(detail.items[0].physicalShipments[1].phone, contact);
  assert.equal(detail.items[0].physicalShipments[1].address, newAddress);
  assert.ok(detail.issues.some(warning => warning.kind === 'courier_conflict'));
  assert.ok(!detail.issues.some(warning => warning.kind === 'invalid_courier_id'));
  assert.ok(!JSON.stringify(detail).includes(newAddress));
});

test('주소변경 송장은 확인 후 직원이 선택하고 구주소·두 원본·실물 이력을 보존한다', t => {
  const { db, detail } = setup(t), original = sourceSnapshot(db);
  assert.equal(detail.items[0].decision, 'hold'); assert.equal(detail.items[0].trackingNumber, identity.first);
  assert.throws(() => select(db, detail, identity.second, 'include', []), /보류|확인/);
  const selected = select(db, detail), item = selected.items[0];
  assert.equal(item.trackingNumber, identity.second); assert.equal(item.decision, 'include'); assert.equal(item.note, '');
  assert.equal(item.trackingSelection.trackingNumber, identity.second); assert.ok(item.trackingSelection.checkedAt);
  assert.equal(item.sourceRows.length, 2); assert.ok(item.physicalShipments.every(parcel => parcel.valid === true));
  assert.ok(selected.issues.some(warning => warning.kind === 'recipient_mismatch' && warning.resolved));
  assert.ok(selected.issues.some(warning => warning.kind === 'legacy_conflict' && warning.blocking));
  assert.deepEqual(item.blockingIssueKeys, []); assert.equal(item.reviewedIssueKeys.length, 2);
  assert.ok(selected.orders.every(order => order.state === 'ready'));
  assert.equal(rows(exportInvoices(db, detail.run.id).buffer)[1][3], identity.second);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invoice_revisions').get().n, 1);
  assert.deepEqual(sourceSnapshot(db), original);
});

test('명시 현재 매칭 다운로드는 선택 송장을 쓰고 생성 당시 보관본은 바이트 그대로 유지한다', t => {
  const { db, detail } = setup(t, { products: 2 });
  const unrelated = detail.items[1];
  reviseInvoiceItems(db, detail.run.id, { issueResolutions: acknowledged(detail), changes: [{ id: unrelated.id, decision: 'hold', note: '가상 검토' }] });
  // Make a previous, unrelated export without changing the blocked target.
  const book = file([['상품주문번호', '배송방법', '택배사', '송장번호'], ['old-mock-product', '택배,등기,소포', '로젠택배', 'old-mock-tracking']], '이전.xlsx');
  db.prepare('UPDATE invoice_runs SET generated_at = ?, generated_file = ?, generated_filename = ? WHERE id = ?')
    .run('2026-01-01T08:00:00Z', book.buffer, book.originalname, detail.run.id);
  const cached = downloadInvoices(db, detail.run.id), selected = select(db, invoiceDetail(db, detail.run.id));
  const fresh = downloadInvoices(db, detail.run.id, { rebuild: true });
  assert.equal(rows(fresh.buffer)[1][0], identity.product); assert.equal(rows(fresh.buffer)[1][3], identity.second);
  assert.ok(!rows(fresh.buffer).slice(1).some(row => row[0] === unrelated.productOrderId));
  assert.deepEqual(downloadInvoices(db, detail.run.id).buffer, cached.buffer);
  assert.equal(downloadInvoices(db, detail.run.id).filename, cached.filename);
  assert.equal(selected.run.generatedAt, '2026-01-01T08:00:00Z');
});

test('기존 trackingNumber만 바꾸거나 다른 주문의 내부번호 충돌이면 보류를 우회하지 못한다', t => {
  const { db, detail } = setup(t);
  assert.throws(() => reviseInvoiceItems(db, detail.run.id, { issueResolutions: acknowledged(detail), changes: [
    { id: detail.items[0].id, trackingNumber: identity.second, decision: 'include', note: '가상 선택' },
  ] }), /보류|확인/);
  saved(db, { order: 'other-mock-order' });
  const current = invoiceDetail(db, detail.run.id);
  assert.throws(() => select(db, current), /보류|확인/);
});

test('무효 원송장·분할 재발급 불명 후보는 체크해도 적용할 수 없다', async t => {
  for (const options of [{ explicitReplacement: true }, { sameRound: true }]) await t.test(JSON.stringify(options), t => {
    const { db, detail } = setup(t, options);
    assert.throws(() => select(db, detail, identity.first), /유효 송장/);
  });
});

test('다른 수취인·취소 상태는 송장 선택으로 강제 포함하지 않는다', async t => {
  for (const options of [{ secondRecipient: '다른 가상 수취인' }, { status: 'CANCELED' }, { changedSource: { phone: '010-0000-0202' } }]) await t.test(JSON.stringify(options), t => {
    const { db, detail } = setup(t, options);
    assert.throws(() => select(db, detail), /보류|확인/);
  });
});

test('한 상품에 저장한 선택 확인이 같은 내부번호의 다른 상품 경고를 해제하지 않는다', t => {
  const { db, detail } = setup(t, { products: 2 });
  const selected = select(db, detail);
  assert.deepEqual(selected.items[0].blockingIssueKeys, []);
  assert.ok(selected.items[1].blockingIssueKeys.length); assert.equal(selected.items[1].decision, 'hold');
});

test('선택 이후 원본 근거가 바뀌면 검토 증거를 다시 사용하지 못한다', t => {
  const { db, detail } = setup(t); select(db, detail);
  saved(db, { address: '가상시 또변경로 3 303호' });
  const current = invoiceDetail(db, detail.run.id);
  assert.equal(current.items[0].trackingSelection, null); assert.deepEqual(current.items[0].reviewedIssueKeys, []);
  assert.ok(current.items[0].blockingIssueKeys.length);
  assert.throws(() => exportInvoices(db, detail.run.id), /경고|불명확/);
});


test('같은 선택을 다시 저장해도 검토 이력과 등록 조회 시각을 불필요하게 초기화하지 않는다', t => {
  const { db, detail } = setup(t), selected = select(db, detail), item = selected.items[0];
  db.prepare("UPDATE invoice_items SET registration_state = 'pending', status_checked_at = ? WHERE id = ?")
    .run('2026-01-01T09:00:00Z', item.id);
  const repeated = select(db, invoiceDetail(db, detail.run.id));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invoice_revisions').get().n, 1);
  assert.equal(repeated.items[0].checkedAt, '2026-01-01T09:00:00Z');
  assert.equal(repeated.items[0].trackingSelection.checkedAt, item.trackingSelection.checkedAt);
});

test('같은 근거로 새 매칭을 만들면 선택을 이어가되 달라진 송장 원본에는 재확인을 요구한다', t => {
  const { db, input, detail } = setup(t), selected = select(db, detail);
  const newFile = title => { const book = XLSX.read(input.naverFiles[0].buffer); book.Props = { ...book.Props, Title: title };
    return { originalname: '새 네이버.xlsx', buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) }; };
  const next = importInvoiceFiles(db, { ...input, naverFiles: [newFile('새 네이버 원본')] });
  assert.notEqual(next.run.id, detail.run.id);
  assert.equal(next.items[0].trackingNumber, identity.second); assert.equal(next.items[0].decision, 'include');
  assert.deepEqual(next.items[0].trackingSelection, selected.items[0].trackingSelection);
  assert.deepEqual(next.items[0].blockingIssueKeys, []);
  const changedBook = XLSX.read(input.courierFiles[0].buffer); changedBook.Props = { ...changedBook.Props, Title: '새 송장 근거' };
  const changed = importInvoiceFiles(db, { ...input, naverFiles: [newFile('다음 네이버 원본')], courierFiles: [
    { originalname: '다음 택배.xlsx', buffer: XLSX.write(changedBook, { type: 'buffer', bookType: 'xlsx' }) },
  ] });
  assert.equal(changed.items[0].trackingSelection, null); assert.equal(changed.items[0].decision, 'hold');
  assert.ok(changed.items[0].blockingIssueKeys.length);
});


const remote = (item, overrides = {}) => ({ productOrderId: item.productOrderId, orderId: item.orderId,
  status: 'PAYED', remainQuantity: item.quantity, recipient, phone: contact, address: oldAddress, detailAddress: '',
  trackingNumber: '', deliveryCompanyCode: '', ...overrides });
const query = response => ({ queryProductOrders: async () => response });

test('조회로 확인된 취소·수량·수취인·주문 충돌은 송장 선택과 실패한 재조회로 지우지 않는다', async t => {
  for (const overrides of [{ status: 'CANCELED', remainQuantity: 0 }, { remainQuantity: 2 },
    { recipient: '다른 가상 수취인' }, { orderId: 'different-mock-order' }]) await t.test(JSON.stringify(overrides), async t => {
    const { db, detail } = setup(t);
    let current = await refreshInvoiceStatus(db, detail.run.id, query(detail.items.map(item => remote(item, overrides))));
    assert.equal(current.items[0].registrationState, 'conflict');
    assert.throws(() => select(db, current), /충돌/);
    current = select(db, current, identity.second, 'hold');
    assert.equal(current.items[0].registrationState, 'conflict'); assert.equal(current.items[0].checkedAt, null);
    assert.equal(current.items[0].trackingNumber, identity.second); assert.equal(current.items[0].registrationRecheck, true);
    assert.throws(() => reviseInvoiceItems(db, current.run.id, { changes: [
      { id: current.items[0].id, decision: 'include', note: '' },
    ] }), /충돌/);
    await assert.rejects(refreshInvoiceStatus(db, current.run.id, { queryProductOrders: async () => { throw Error('가상 조회 장애'); } }), /조회/);
    current = invoiceDetail(db, current.run.id);
    assert.equal(current.items[0].registrationState, 'conflict');
    assert.throws(() => select(db, current), /충돌/);
    assert.throws(() => exportInvoices(db, current.run.id), /없습니다|경고|충돌/);
  });
});

test('다른 등록 송장의 대표를 바꿔도 충돌을 유지하고 성공한 재조회 뒤에만 포함할 수 있다', async t => {
  const { db, input, detail } = setup(t);
  let current = await refreshInvoiceStatus(db, detail.run.id, query(detail.items.map(item => remote(item, {
    status: 'DELIVERING', trackingNumber: identity.second, deliveryCompanyCode: 'KGB',
  }))));
  assert.ok(current.items[0].registrationProblems.includes('tracking_conflict'));
  assert.throws(() => select(db, current), /충돌/);
  current = select(db, current, identity.second, 'hold');
  const book = XLSX.read(input.naverFiles[0].buffer); book.Props = { ...book.Props, Title: '충돌 재매칭 검증' };
  current = importInvoiceFiles(db, { ...input, naverFiles: [{ originalname: '다음 네이버.xlsx', buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) }] });
  assert.equal(current.items[0].decision, 'hold'); assert.equal(current.items[0].registrationRecheck, true);
  assert.ok(current.issues.some(warning => warning.kind === 'registration_recheck' && warning.blocking));
  current = await refreshInvoiceStatus(db, current.run.id, query(current.items.map(item => remote(item))));
  assert.equal(current.items[0].registrationState, 'pending');
  current = reviseInvoiceItems(db, current.run.id, { changes: [{ id: current.items[0].id, decision: 'include', note: '' }] });
  assert.equal(current.items[0].decision, 'include');
  assert.equal(rows(exportInvoices(db, current.run.id).buffer)[1][3], identity.second);
});


test('원본에 이미 등록된 첫 송장을 다른 송장으로 선택하면 재조회 전까지 엑셀에 포함하지 않는다', async t => {
  const { db, detail } = setup(t, { status: 'DELIVERING', sourceTracking: identity.first, sourceCarrier: '로젠택배' });
  assert.equal(detail.items[0].sourceRegistered, true);
  assert.ok(!detail.issues.some(warning => warning.kind === 'source_tracking_conflict'));
  assert.throws(() => select(db, detail), /등록 상태 조회/);
  let current = select(db, detail, identity.second, 'hold');
  assert.equal(current.items[0].sourceRegistered, false); assert.equal(current.items[0].registrationRecheck, true);
  assert.ok(current.issues.some(warning => warning.kind === 'registration_recheck' && warning.blocking));
  assert.throws(() => reviseInvoiceItems(db, current.run.id, { changes: [{ id: current.items[0].id, decision: 'include', note: '' }] }), /보류|확인/);
  await assert.rejects(refreshInvoiceStatus(db, current.run.id, { queryProductOrders: async () => { throw Error('가상 조회 장애'); } }), /조회/);
  current = invoiceDetail(db, current.run.id);
  assert.throws(() => select(db, current), /등록 상태 조회/);
  current = await refreshInvoiceStatus(db, current.run.id, query(current.items.map(item => remote(item))));
  current = reviseInvoiceItems(db, current.run.id, { changes: [{ id: current.items[0].id, decision: 'include', note: '' }] });
  assert.equal(rows(exportInvoices(db, current.run.id).buffer)[1][3], identity.second);
});

test('한국어 발송대기 원본은 별도 API 없이 선택하되 배송중 원본의 송장누락은 확인을 요구한다', t => {
  const pending = setup(t, { status: '발송대기' });
  assert.equal(select(pending.db, pending.detail).items[0].trackingNumber, identity.second);
  const registered = setup(t, { status: 'DELIVERING' });
  assert.throws(() => select(registered.db, registered.detail), /등록 상태 조회/);
});
