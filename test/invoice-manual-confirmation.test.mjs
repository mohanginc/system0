import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../lib/database.mjs';
import { importFiles } from '../lib/excel.mjs';
import { CARRIERS, confirmInvoiceTracking, downloadInvoices, exportInvoices, importInvoiceFiles, invoiceView,
  refreshInvoiceStatus, reviseInvoiceItems } from '../lib/invoices.mjs';
import { sourceFile, naverFile, courierFile, registeredOrder } from './fixtures/weekend-invoices.mjs';

const date = '2026-11-25';
const base = { recipient: '가상 고객', phone: '010-0000-0000', address: '서울 검증로 1 101호', quantity: 1, orderId: '2026112400000099',
  round: 1, issueCount: 1, printedAt: '10:23:45' };
const high = { ...base, productOrderId: '2026112400000001', productName: '가상 13cm', optionName: '높이: 13cm',
  internalId: 'SHIP-20', trackingNumber: '45660001431' };
const superHigh = { ...base, productOrderId: '2026112400000002', productName: '가상 15cm', optionName: '높이: 15cm',
  internalId: 'SHIP-21', trackingNumber: '45660001420' };
const unclear = { ...high, trackingNumber: '45660001442' };
const ordinary = { ...base, productOrderId: '2026112400000003', orderId: '2026112400000100',
  internalId: 'SHIP-22', trackingNumber: '45660001453', productName: '가상 정상 상품' };

function setup(t, { products = [high, superHigh, ordinary], parcels = [superHigh, high, unclear, ordinary] } = {}) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const source = sourceFile(products);
  const batch = importFiles(db, [{ ...source, originalname: source.name }]);
  const imported = importInvoiceFiles(db, { naverFiles: [naverFile(products)], courierFiles: [courierFile(parcels)],
    carrier: CARRIERS[0], sourceDate: date, batchIds: [batch.batch.id] });
  const id = imported.run.id;
  const view = () => invoiceView(db, id);
  const request = (before, resolutions, validateOnly = false) => confirmInvoiceTracking(db, id, {
    expectedVersion: before.viewVersion, resolutions, validateOnly, actor: '가상 직원',
  });
  const rows = () => db.prepare('SELECT * FROM invoice_items WHERE run_id = ? ORDER BY id').all(id);
  const attach = () => db.prepare('SELECT * FROM invoice_files WHERE run_id = ? ORDER BY id').all(id);
  const lookup = (detail, product) => detail.items.find(item => item.productOrderId === product.productOrderId);
  return { db, id, view, request, rows, attach, lookup };
}

const resolution = (order, mode, trackingNumber = order.trackingNumber) => ({ productOrderId: order.productOrderId, trackingNumber, mode });

test('출고번호 2개·송장 3개의 상품별 확정은 원본·보관 엑셀을 보존하고 미확인 후보를 유지한다', async t => {
  const { db, id, view, request, rows, attach, lookup } = setup(t);
  let before = view();
  assert.ok(before.trackingReview.groups.every(group => !group.assignEligible));
  assert.deepEqual(before.manualTracking.groups.map(group => group.productOrderId), [high.productOrderId, superHigh.productOrderId]);
  assert.equal(before.manualTracking.groups[0].candidates.find(parcel => parcel.trackingNumber === high.trackingNumber).valid, null);
  reviseInvoiceItems(db, id, { expectedVersion: before.viewVersion, changes: before.items.filter(item => item.decision === 'hold')
    .map(item => ({ id: item.id, decision: 'hold', note: '가상 정상 항목부터 파일 생성' })),
  issueResolutions: before.issues.filter(issue => issue.blocking).map(issue => ({ key: issue.key, note: '실물 확인 대기' })) });
  const archive = exportInvoices(db, id).buffer, files = attach(), snapshot = rows();
  const revisions = db.prepare('SELECT * FROM invoice_revisions ORDER BY id').all();
  before = view();
  const choices = [resolution(high, 'separate'), resolution(superHigh, 'separate')];
  const preview = request(before, choices, true);
  assert.deepEqual(preview.confirmations.map(item => item.trackingNumber), [high.trackingNumber, superHigh.trackingNumber]);
  assert.equal(preview.changed, 2);
  assert.deepEqual(rows(), snapshot);
  assert.throws(() => request(before, [choices[0], { ...choices[1], trackingNumber: 'not-a-candidate' }]), /송장/);
  assert.deepEqual(rows(), snapshot);
  const result = request(before, choices);
  assert.deepEqual(result.confirmations, preview.confirmations);
  assert.equal(lookup(result, high).internalId, high.internalId);
  assert.equal(lookup(result, superHigh).internalId, superHigh.internalId);
  assert.equal(lookup(result, high).physicalShipments.find(parcel => parcel.trackingNumber === unclear.trackingNumber).valid, null);
  assert.deepEqual(rows().at(-1), snapshot.at(-1));
  assert.deepEqual(attach(), files);
  assert.deepEqual(downloadInvoices(db, id).buffer, archive);
  assert.deepEqual(db.prepare('SELECT * FROM invoice_revisions ORDER BY id').all().slice(0, revisions.length), revisions);
  assert.throws(() => request(before, choices), { code: 'stale_invoice_version' });
  await refreshInvoiceStatus(db, id, { queryProductOrders: async ids => ids.map(productId => {
    const order = [high, superHigh, ordinary].find(item => item.productOrderId === productId);
    return order === ordinary ? registeredOrder(order) : registeredOrder(order, { status: 'PAYED', trackingNumber: '', deliveryCompanyCode: '' });
  }) });
  const checked = view();
  assert.deepEqual(checked.items.map(item => item.registrationState), ['pending', 'pending', 'complete']);
  assert.ok(checked.items.every(item => !item.blockingIssueKeys.length && item.decision === 'include'));
  assert.equal(checked.currentSummary.ready, 2);
  assert.equal(checked.currentSummary.complete, 1);
  assert.equal(request(checked, choices).changed, 0);
  assert.deepEqual(downloadInvoices(db, id).buffer, archive);
});

test('같은 주문 합포장은 명시된 두 상품에만 같은 실제 송장을 저장하고 다른 출고의 송장은 폐기하지 않는다', t => {
  const { view, request, lookup } = setup(t);
  const before = view();
  assert.throws(() => request(before, [resolution(high, 'combined')]), /합포장/);
  assert.throws(() => request(before, [resolution(high, 'separate'), resolution(superHigh, 'separate', high.trackingNumber)]), /합포장/);
  const after = request(before, [resolution(high, 'combined', superHigh.trackingNumber), resolution(superHigh, 'combined')]);
  assert.deepEqual(after.items.map(item => item.trackingNumber), [superHigh.trackingNumber, superHigh.trackingNumber, ordinary.trackingNumber]);
  assert.ok(after.manualTracking.groups.find(group => group.productOrderId === high.productOrderId).candidates
    .some(parcel => parcel.trackingNumber === high.trackingNumber && parcel.valid === null));
  assert.equal(lookup(after, high).trackingSelection.mode, 'combined');
});

test('분할은 확인한 두 송장을 유효하게 유지하고 교체는 명시적으로 미사용 확인한 송장만 폐기한다', t => {
  const split = setup(t, { products: [high], parcels: [high, unclear] });
  const before = split.view();
  assert.throws(() => split.request(before, [resolution(high, 'split')]), /실제 상자/);
  const result = split.request(before, [{ ...resolution(high, 'split'), usedTrackingNumbers: [unclear.trackingNumber] }]);
  assert.deepEqual(result.items[0].physicalShipments.map(parcel => parcel.valid), [true, true]);
  const replace = setup(t, { products: [high], parcels: [high, unclear, { ...high, trackingNumber: '45660001454' }] });
  const replacement = replace.request(replace.view(), [{ ...resolution(high, 'replace'), unusedTrackingNumbers: [unclear.trackingNumber] }]);
  assert.deepEqual(replacement.items[0].physicalShipments.map(parcel => parcel.valid), [true, false, null]);
  assert.equal(replacement.items[0].physicalShipments[1].replacedBy, high.trackingNumber);
  const replay = replace.request(replacement, [{ ...resolution(high, 'replace'), unusedTrackingNumbers: [unclear.trackingNumber] }]);
  assert.equal(replay.changed, 0);
  assert.equal(replay.viewVersion, replacement.viewVersion);
  assert.throws(() => replace.request(replay, [resolution(unclear, 'replace')]), /확인할 수 있는 송장/);
});

test('수취정보 불일치와 동시에 다른 상품에 쓰는 송장 폐기는 수동 확정할 수 없다', t => {
  const mismatch = setup(t, { products: [high], parcels: [high, { ...unclear, address: '서울 다른 주소 2 101호' }] });
  assert.equal(mismatch.view().manualTracking.groups.length, 0);
  assert.throws(() => mismatch.request(mismatch.view(), [resolution(high, 'replace')]), /확인할 수 있는 송장/);
  const scenario = setup(t);
  assert.throws(() => scenario.request(scenario.view(), [
    { ...resolution(high, 'replace'), unusedTrackingNumbers: [unclear.trackingNumber] },
    resolution(superHigh, 'separate', unclear.trackingNumber),
  ]), /다른 상품에 적용된 송장/);
  const overlap = setup(t, { products: [high, { ...superHigh, internalId: high.internalId }], parcels: [high, unclear] });
  const before = overlap.rows();
  assert.throws(() => overlap.request(overlap.view(), [
    { ...resolution(high, 'split'), usedTrackingNumbers: [unclear.trackingNumber] },
    resolution(superHigh, 'separate', unclear.trackingNumber),
  ]), /실제 상자/);
  assert.deepEqual(overlap.rows(), before);
});

test('이미 확인된 대표 송장을 그대로 확정하면 기존 네이버 조회 증거와 조회 시각을 유지한다', async t => {
  const { db, id, view, request } = setup(t, { products: [high], parcels: [high, { ...unclear, round: 2 }] });
  await refreshInvoiceStatus(db, id, { queryProductOrders: async () => [registeredOrder(high)] });
  const before = view();
  assert.equal(before.items[0].registrationState, 'complete');
  const after = request(before, [resolution(high, 'split')]);
  assert.equal(after.items[0].decision, 'include');
  assert.equal(after.items[0].registrationState, 'complete');
  assert.deepEqual(after.items[0].naverRegistration, before.items[0].naverRegistration);
});
