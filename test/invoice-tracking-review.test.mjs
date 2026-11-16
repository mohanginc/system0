import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { openDatabase } from '../lib/database.mjs';
import { importFiles } from '../lib/excel.mjs';
import * as invoices from '../lib/invoices.mjs';
import { sourceFile, naverFile, courierFile, registeredOrder } from './fixtures/weekend-invoices.mjs';

const date = '2026-11-14', first = '001234567001', second = '001234567002';
const order = (changes = {}) => ({ productOrderId: '202611140000000001', orderId: '202611140000000099',
  internalId: 'mock-shipment-1', trackingNumber: first, round: 1, printedAt: '2026-11-14T10:00:00+09:00',
  recipient: '모의 수취인', phone: '010-0000-0000', address: '가상시 테스트로 1 101호',
  productName: '모의 쿠션', optionName: '', quantity: 1, ...changes });
const readRows = buffer => { const book = XLSX.read(buffer, { type: 'buffer' });
  return XLSX.utils.sheet_to_json(book.Sheets['발송처리'], { header: 1, raw: true }).slice(1); };
function setup(t, count = 2, fields = {}) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const base = order(fields), products = Array.from({ length: count }, (_, i) => order({ ...fields, productOrderId: '20261114000000000' + (i + 1) }));
  const source = sourceFile([base]);
  importFiles(db, [{ ...source, originalname: source.name }]);
  const start = (parcels, name = '송장.xlsx') => invoices.importInvoiceFiles(db, {
    naverFiles: [naverFile(products)], courierFiles: [courierFile(parcels, name)], carrier: invoices.CARRIERS[0], sourceDate: date,
  });
  return { db, base, products, start };
}

test('이전 첨부에만 있는 실물 송장도 수취정보를 복원해 재업로드의 거짓 courier_conflict를 만들지 않는다', t => {
  const { db, base, start } = setup(t);
  const previous = start([base]), original = invoices.exportInvoices(db, previous.run.id);
  const next = start([order({ trackingNumber: second, round: 2, printedAt: '2026-11-14T15:00:00+09:00' })], '오후.xlsx');
  assert.equal(next.items[0].physicalShipments.length, 2);
  assert.ok(!next.issues.some(issue => issue.kind === 'courier_conflict'), '같은 수취정보의 과거 송장을 빈 문자열로 비교하지 않습니다.');
  assert.equal(next.items[0].physicalShipments.find(parcel => parcel.trackingNumber === first).recipient, base.recipient);
  assert.deepEqual(invoices.downloadInvoices(db, previous.run.id).buffer, original.buffer);
});

test('기존 저장된 거짓 courier_conflict는 원본 재대조로 해제하고 진짜·근거누락 경고와 확인 기록은 보존한다', t => {
  const { db, base, start } = setup(t);
  const previous = start([base]), next = start([order({ trackingNumber: second, round: 2 })], '정정.xlsx');
  const warning = { key: 'persisted-false-courier', kind: 'courier_conflict', internalId: base.internalId,
    message: '같은 내부 출고번호의 택배 수취 정보가 서로 다릅니다.', blocking: true, resolved: false, note: '' };
  const persisted = [...next.issues, warning];
  db.prepare('UPDATE invoice_runs SET issues_json = ? WHERE id = ?').run(JSON.stringify(persisted), next.run.id);
  assert.ok(!invoices.invoiceDetail(db, next.run.id).issues.some(issue => issue.kind === 'courier_conflict'));
  assert.ok(!start([order({ trackingNumber: second, round: 2 })], '정정.xlsx').issues.some(issue => issue.kind === 'courier_conflict'), '동일 fingerprint 재개도 다시 계산합니다.');
  db.prepare('DELETE FROM invoice_files WHERE run_id = ?').run(previous.run.id);
  assert.ok(invoices.invoiceDetail(db, next.run.id).issues.some(issue => issue.kind === 'courier_conflict'), '과거 원본 근거가 없으면 일치로 단정하지 않습니다.');
  db.prepare("DELETE FROM invoice_files WHERE run_id = ? AND kind = 'courier'").run(next.run.id);
  assert.ok(invoices.invoiceDetail(db, next.run.id).issues.some(issue => issue.kind === 'courier_conflict'), '모든 수취정보가 비어도 일치로 단정하지 않습니다.');
  const real = setup(t), conflict = real.start([real.base, order({ trackingNumber: second, round: 2, address: '가상시 다른로 99 9호' })]);
  const saved = conflict.issues.find(issue => issue.kind === 'courier_conflict'); saved.resolved = true; saved.note = '직원이 차이를 확인했습니다.';
  real.db.prepare('UPDATE invoice_runs SET issues_json = ? WHERE id = ?').run(JSON.stringify(conflict.issues), conflict.run.id);
  const retained = invoices.invoiceDetail(real.db, conflict.run.id).issues.find(issue => issue.kind === 'courier_conflict');
  assert.equal(retained.resolved, true); assert.equal(retained.note, saved.note);
});

test('차수가 다르더라도 여러 유효 송장은 명시 검토 전 첫 송장으로 자동 출력하지 않는다', t => {
  const { db, base, start } = setup(t);
  const detail = start([base, order({ trackingNumber: second, round: 2 })]);
  assert.ok(detail.items.every(item => item.decision === 'hold'));
  assert.throws(() => invoices.exportInvoices(db, detail.run.id), /확인|검토|보류|포함/);
  const view = invoices.invoiceView(db, detail.run.id);
  assert.equal(view.trackingReview.pendingCount, 1);
  assert.deepEqual(view.trackingReview.groups[0].itemIds, detail.items.map(item => item.id));
});

test('직원 교체 선택은 연결된 모든 상품주문에 반영하고 옛 송장과 생성 파일을 보존한다', t => {
  const { db, base, start } = setup(t);
  const old = start([base]), bytes = invoices.exportInvoices(db, old.run.id).buffer;
  const next = start([order({ trackingNumber: second, round: 2, printedAt: '2026-11-14T15:00:00+09:00' })], '나중 송장.xlsx');
  const view = invoices.invoiceView(db, next.run.id), group = view.trackingReview.groups[0];
  assert.equal(group.replacementTrackingNumber, second); assert.equal(group.replacementEligible, true);
  const updated = invoices.applyInvoiceTrackingReview(db, next.run.id, { expectedVersion: view.viewVersion,
    choices: [{ key: group.key, mode: 'replace', trackingNumber: second }], actor: '직원 테스트' });
  assert.ok(updated.items.every(item => item.trackingNumber === second && item.decision === 'include'));
  assert.ok(updated.items.every(item => item.physicalShipments.find(parcel => parcel.trackingNumber === first).valid === false));
  assert.ok(updated.items.every(item => item.physicalShipments.find(parcel => parcel.trackingNumber === first).replacedBy === second));
  assert.equal(updated.trackingReview.pendingCount, 0);
  assert.deepEqual(readRows(invoices.exportInvoices(db, next.run.id).buffer).map(row => row[3]), [second, second]);
  assert.deepEqual(invoices.downloadInvoices(db, old.run.id).buffer, bytes);
});

test('다른 SHA 파일의 시각만 있는 새 송장은 시간 순서를 추정하지 않고 직원 교체 확인으로 적용한다', t => {
  const { db, start } = setup(t);
  start([order({ printedAt: '15:00:00' })]);
  const next = start([order({ trackingNumber: second, round: 2, printedAt: '10:00:00' })], '정정한 최종.xlsx');
  const view = invoices.invoiceView(db, next.run.id), group = view.trackingReview.groups[0];
  assert.equal(group.replacementEligible, true);
  assert.equal(group.candidates.find(parcel => parcel.trackingNumber === first).currentFile, false);
  assert.equal(group.candidates.find(parcel => parcel.trackingNumber === second).currentFile, true);
  const before = db.prepare('SELECT count(*) AS n FROM invoice_revisions').get().n;
  assert.throws(() => invoices.applyInvoiceTrackingReview(db, next.run.id, { expectedVersion: view.viewVersion,
    choices: [{ key: group.key, trackingNumber: first, mode: 'replace' }] }), /유효|근거/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM invoice_revisions').get().n, before);
  const result = invoices.applyInvoiceTrackingReview(db, next.run.id, { expectedVersion: view.viewVersion,
    choices: [{ key: group.key, trackingNumber: second, mode: 'replace' }], actor: 'discord:123456789' });
  assert.ok(result.items.every(item => item.trackingNumber === second));
  assert.equal(result.items[0].physicalShipments.find(parcel => parcel.trackingNumber === first).retiredByEmployee.basis, 'employee_replacement');
  assert.equal(result.trackingReview.groups[0].mode, 'replace');
  // 정정 전 송장이 현재 첨부에 다시 등장하면 새 확인 대상으로 보류합니다.
  const again = start([order({ printedAt: '15:00:00' }), order({ trackingNumber: second, round: 2, printedAt: '10:00:00' })], '후속.xlsx');
  assert.ok(again.items.every(item => item.decision === 'hold'));
  assert.equal(invoices.invoiceView(db, again.run.id).trackingReview.pendingCount, 1);
  assert.equal(again.items[0].physicalShipments.find(parcel => parcel.trackingNumber === first).previousRetirement.replacedBy, second);
});

test('직원 교체 후 네이버 파일만 바뀌면 B-only 송장의 과거 무효화와 선택 근거를 이어간다', t => {
  const { db, base, products, start } = setup(t);
  start([base]);
  const corrected = order({ trackingNumber: second, round: 2, printedAt: '10:00:00' });
  const next = start([corrected]), view = invoices.invoiceView(db, next.run.id), group = view.trackingReview.groups[0];
  const selected = invoices.applyInvoiceTrackingReview(db, next.run.id, { expectedVersion: view.viewVersion,
    choices: [{ key: group.key, trackingNumber: second, mode: 'replace' }], actor: 'web' });
  const nextImport = invoices.importInvoiceFiles(db, { naverFiles: [naverFile(products.map(product => ({ ...product, productName: '다른 네이버 내보내기 명칭' })))],
    courierFiles: [courierFile([corrected], '송장.xlsx')], carrier: invoices.CARRIERS[0], sourceDate: date });
  assert.notEqual(nextImport.run.id, selected.run.id);
  const continued = invoices.invoiceView(db, nextImport.run.id);
  assert.equal(continued.trackingReview.pendingCount, 0);
  assert.ok(continued.items.every(item => item.trackingNumber === second && item.decision === 'include'));
  for (const item of continued.items) {
    const retired = item.physicalShipments.find(parcel => parcel.trackingNumber === first);
    assert.equal(retired.valid, false); assert.equal(retired.replacedBy, second);
    assert.deepEqual(retired.retiredByEmployee, selected.items[0].physicalShipments.find(parcel => parcel.trackingNumber === first).retiredByEmployee);
    assert.deepEqual(item.trackingSelection, selected.items.find(previous => previous.productOrderId === item.productOrderId).trackingSelection);
  }
});

test('택배 두 원본의 동일한 마스킹 수취정보는 확정된 주문ID 근거와 함께 사용하며 네이버 원문과 같다고 단정하지 않는다', t => {
  const { db, start } = setup(t), masked = { phone: '010-****-0000', address: '가상시 테스트로 ** (축약건물, ***)' };
  start([order({ ...masked, printedAt: '15:00:00' })]);
  const next = start([order({ ...masked, trackingNumber: second, round: 2, printedAt: '10:00:00' })], '마스킹 정정.xlsx');
  const view = invoices.invoiceView(db, next.run.id), group = view.trackingReview.groups[0];
  assert.ok(!view.issues.some(issue => ['recipient_mismatch', 'courier_conflict', 'source_changed'].includes(issue.kind)));
  assert.equal(group.replacementEligible, true);
  const result = invoices.applyInvoiceTrackingReview(db, next.run.id, { expectedVersion: view.viewVersion,
    choices: [{ key: group.key, trackingNumber: second, mode: 'replace' }], actor: 'web' });
  assert.ok(result.items.every(item => item.trackingNumber === second && item.decision === 'include'));
  assert.ok(readRows(invoices.exportInvoices(db, next.run.id).buffer).every(row => row[3] === second));
  assert.equal(result.items[0].phone, order().phone);
  assert.equal(result.items[0].physicalShipments[0].phone, masked.phone);
  assert.equal(result.items[0].trackingSelection.recipientCheck, 'unchanged_masked_courier');
});

test('두 택배 원본끼리 같아도 마스킹되지 않은 잘못된 연락처·주소나 공개된 주소 모순은 교체로 우회하지 않는다', async t => {
  for (const changes of [{ phone: '010-9999-0000' }, { address: '가상시 다른로 99 9호' },
    { phone: '010-****-0000', address: '가상시 다른로 **' }, { phone: '099-****-0000', address: '가상시 테스트로 **' }]) {
    await t.test(Object.keys(changes).join('+'), t => {
      const { db, start } = setup(t);
      start([order(changes)]);
      const next = start([order({ ...changes, trackingNumber: second, round: 2 })], '모순.xlsx');
      const view = invoices.invoiceView(db, next.run.id), group = view.trackingReview.groups[0];
      assert.equal(group.replacementEligible, false);
      assert.throws(() => invoices.applyInvoiceTrackingReview(db, next.run.id, { expectedVersion: view.viewVersion,
        choices: [{ key: group.key, trackingNumber: second, mode: 'replace' }] }), /근거|충돌|유효/);
    });
  }
});

test('안심번호 마스킹과 도 축약 기본주소는 공개부분을 대조하고 건물 상세는 직원 확인으로 남긴다', t => {
  const fields = { phone: '0507-1234-0000', address: '경상남도 가상시 테스트로 1 101호 (정식 건물명)' };
  const { db, base, start } = setup(t, 1, fields), carrier = { ...base, phone: '0507-****-0000', address: '경남 가상시 테스트로 ** (축약, ***)' };
  start([carrier]);
  const next = start([{ ...carrier, trackingNumber: second, round: 2, printedAt: '10:00:00' }], '최종.xlsx');
  const view = invoices.invoiceView(db, next.run.id), group = view.trackingReview.groups[0];
  assert.equal(group.replacementEligible, true);
  const result = invoices.applyInvoiceTrackingReview(db, next.run.id, { expectedVersion: view.viewVersion,
    choices: [{ key: group.key, trackingNumber: second, mode: 'replace' }] });
  assert.equal(result.items[0].trackingSelection.recipientCheck, 'unchanged_masked_courier');
});

test('분할 확인은 모든 상자를 유지하고 대표 선택을 전체 상품에 적용하며 기존 생성본을 덮어쓰지 않는다', t => {
  const { db, base, start } = setup(t);
  const next = start([base, order({ trackingNumber: second, round: 2 })]);
  let view = invoices.invoiceView(db, next.run.id), group = view.trackingReview.groups[0];
  assert.equal(group.replacementEligible, false, '두 현재 송장 중 하나를 최신이라고 임의 추정하지 않습니다.');
  view = invoices.applyInvoiceTrackingReview(db, next.run.id, { expectedVersion: view.viewVersion,
    choices: [{ key: group.key, trackingNumber: first, mode: 'split' }], actor: 'web' });
  assert.equal(view.trackingReview.pendingCount, 0);
  assert.ok(view.items.every(item => item.physicalShipments.every(parcel => parcel.valid === true)));
  const bytes = invoices.exportInvoices(db, next.run.id).buffer;
  group = view.trackingReview.groups[0]; view = invoices.invoiceView(db, next.run.id);
  const updated = invoices.applyInvoiceTrackingReview(db, next.run.id, { expectedVersion: view.viewVersion,
    choices: [{ key: group.key, trackingNumber: second, mode: 'replace' }] });
  assert.deepEqual(invoices.downloadInvoices(db, next.run.id).buffer, bytes);
  const rebuild = invoices.downloadInvoices(db, next.run.id, { rebuild: true });
  assert.ok(readRows(rebuild.buffer).every(row => row[3] === second));
  assert.deepEqual(invoices.downloadInvoices(db, next.run.id).buffer, bytes);
  assert.equal(updated.trackingReview.groups[0].selectedTrackingNumber, second);
});

test('중복·잘못된 묶음·이전 버전의 일괄 요청은 전체 취소되고 원본과 이력이 바뀌지 않는다', t => {
  const { db, base, start } = setup(t);
  const next = start([base, order({ trackingNumber: second, round: 2 })]);
  const view = invoices.invoiceView(db, next.run.id), group = view.trackingReview.groups[0];
  const snapshot = () => JSON.stringify({ rows: db.prepare('SELECT * FROM invoice_items').all(), files: db.prepare('SELECT * FROM invoice_files').all(),
    revisions: db.prepare('SELECT * FROM invoice_revisions').all(), source: db.prepare('SELECT * FROM source_files').all() });
  const before = snapshot(), valid = { key: group.key, trackingNumber: second, mode: 'replace' };
  for (const choices of [[valid, valid], [valid, { ...valid, key: '없는 묶음' }], [{ ...valid, trackingNumber: '99' }]]) {
    assert.throws(() => invoices.applyInvoiceTrackingReview(db, next.run.id, { expectedVersion: view.viewVersion, choices }), /유효|선택/);
    assert.equal(snapshot(), before);
  }
  assert.throws(() => invoices.applyInvoiceTrackingReview(db, next.run.id, { expectedVersion: '0'.repeat(64), choices: [valid] }), error => error.status === 409);
  assert.equal(snapshot(), before);
});

test('실제 수취·저장 근거·네이버 주문 내용 충돌은 직원 교체 선택으로 우회하지 않는다', async t => {
  for (const kind of ['recipient', 'source', 'registration']) await t.test(kind, async t => {
    const { db, base, start, products } = setup(t);
    const next = start([base, order({ trackingNumber: second, round: 2,
      ...(kind === 'recipient' ? { address: '가상시 다른로 2 202호' } : {}) })]);
    if (kind === 'source') db.prepare("UPDATE rows SET is_deleted = 1 WHERE id = 1").run();
    if (kind === 'registration') await invoices.refreshInvoiceStatus(db, next.run.id,
      { queryProductOrders: async () => products.map(product => registeredOrder(product, { remainQuantity: 2 })) });
    const view = invoices.invoiceView(db, next.run.id), group = view.trackingReview.groups[0];
    assert.equal(group.replacementEligible, false);
    assert.throws(() => invoices.applyInvoiceTrackingReview(db, next.run.id, { expectedVersion: view.viewVersion,
      choices: [{ key: group.key, trackingNumber: second, mode: 'replace' }] }), /근거|충돌|유효/);
    assert.ok(invoices.invoiceDetail(db, next.run.id).items.every(item => item.physicalShipments.find(parcel => parcel.trackingNumber === first).valid !== false));
  });
});

test('같은 출고의 등록 완료 후 대표 송장을 정정하면 여러 상품을 함께 바꾸고 네이버 관측·상자·보관 엑셀을 유지한다', async t => {
  const { db, base, products, start } = setup(t), next = start([base, order({ trackingNumber: second, round: 2 })]);
  const choose = (view, trackingNumber) => invoices.applyInvoiceTrackingReview(db, view.run.id, { expectedVersion: view.viewVersion,
    choices: [{ key: view.trackingReview.groups[0].key, trackingNumber, mode: 'split' }], actor: 'web' });
  const selected = choose(invoices.invoiceView(db, next.run.id), first), file = invoices.exportInvoices(db, selected.run.id).buffer;
  await invoices.refreshInvoiceStatus(db, next.run.id, { queryProductOrders: async () => products.map(product => registeredOrder(product)) });
  const before = invoices.invoiceView(db, next.run.id);
  assert.ok(before.items.every(item => item.registrationState === 'complete'));
  const corrected = choose(before, second);
  assert.ok(corrected.items.every(item => item.trackingNumber === second && item.registrationRecheck && !item.statusFresh));
  assert.ok(corrected.items.every(item => item.naverRegistration.trackingNumber === first && !item.naverRegistration.fresh));
  assert.ok(corrected.items.every(item => item.physicalShipments.every(parcel => parcel.valid === true)));
  assert.equal(corrected.fileActions.create, false); assert.equal(corrected.fileActions.rebuild, false);
  assert.deepEqual(invoices.downloadInvoices(db, next.run.id).buffer, file);
  assert.equal(choose(corrected, second).viewVersion, corrected.viewVersion, '동일 선택을 재전송하면 조회나 이력을 초기화하지 않습니다.');
  await invoices.refreshInvoiceStatus(db, next.run.id, { queryProductOrders: async () => products.map(product => registeredOrder(product, { trackingNumber: second })) });
  const checked = invoices.invoiceView(db, next.run.id);
  assert.ok(checked.items.every(item => item.registrationState === 'complete' && item.naverRegistration.matches));
  assert.deepEqual(invoices.downloadInvoices(db, next.run.id).buffer, file);
});

test('여러 안전한 출고 묶음의 일괄 교체는 각 주문의 상품과 번호만 함께 변경한다', t => {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const originals = [order(), order({ internalId: 'mock-shipment-2', orderId: '202611140000000199',
    productOrderId: '202611140000000101', trackingNumber: '001234567101' })];
  const source = sourceFile(originals); importFiles(db, [{ ...source, originalname: source.name }]);
  const start = parcels => invoices.importInvoiceFiles(db, { naverFiles: [naverFile(originals)],
    courierFiles: [courierFile(parcels)], carrier: invoices.CARRIERS[0], sourceDate: date });
  start(originals);
  const corrected = originals.map((row, index) => ({ ...row, trackingNumber: index ? '001234567102' : second, round: 2, printedAt: '09:00:00' }));
  const view = invoices.invoiceView(db, start(corrected).run.id);
  assert.equal(view.trackingReview.replacementCount, 2);
  const result = invoices.applyInvoiceTrackingReview(db, view.run.id, { expectedVersion: view.viewVersion,
    choices: view.trackingReview.groups.map(group => ({ key: group.key, trackingNumber: group.replacementTrackingNumber, mode: 'replace' })), actor: 'web' });
  assert.equal(result.trackingReview.pendingCount, 0);
  assert.deepEqual(readRows(invoices.exportInvoices(db, view.run.id).buffer).map(row => [row[0], row[3]]),
    corrected.map(row => [row.productOrderId, row.trackingNumber]));
  assert.equal(db.prepare('SELECT count(*) AS n FROM invoice_revisions WHERE item_id IN (?, ?)').get(...result.items.map(item => item.id)).n, 2);
});
