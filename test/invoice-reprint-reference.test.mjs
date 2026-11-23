import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { openDatabase } from '../lib/database.mjs';
import { importFiles } from '../lib/excel.mjs';
import * as invoices from '../lib/invoices.mjs';
import { courierFile, naverFile, sourceFile } from './fixtures/weekend-invoices.mjs';

const day = '2026-11-23';
const fixtureOrder = index => ({
  productOrderId: `2026112300000000${index + 1}`, orderId: `2026112300990000${index + 1}`, internalId: `test-shipment-${index}`,
  trackingNumber: `4568000011${index}`, originalTrackingNumber: `4568000001${index}`, issueCount: 2, round: 1, printedAt: '16:28:17',
  recipient: `테스트 수취인 ${index}`, phone: `010-0000-000${index}`, address: `테스트시 가상로 ${index + 1} 101호`,
  productName: '테스트 쿠션', quantity: 1,
});

function setup(t, orders, parcels = orders) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const source = sourceFile(orders);
  importFiles(db, [{ ...source, originalname: source.name }]);
  const options = { naverFiles: [naverFile(orders)], courierFiles: [courierFile(parcels)], carrier: invoices.CARRIERS[0], sourceDate: day };
  const detail = invoices.importInvoiceFiles(db, options);
  const view = () => invoices.invoiceView(db, detail.run.id);
  const choose = (choices, expectedVersion = view().viewVersion) => invoices.applyInvoiceTrackingReview(db, detail.run.id, { expectedVersion, choices });
  return { db, options, detail, view, choose };
}

function exportedNumbers(file) {
  const book = XLSX.read(file.buffer, { type: 'buffer' });
  return XLSX.utils.sheet_to_json(book.Sheets['발송처리'], { header: 1, raw: true }).slice(1).map(row => row[3]);
}

test('원송장이 번호로만 있는 네 건을 각각 확인하고 실제 송장 원본을 추가하지 않고 엑셀로 출력한다', t => {
  const orders = Array.from({ length: 4 }, (_, index) => fixtureOrder(index));
  const parcels = orders.map((order, index) => index === 3 ? { ...order, phone: '010-****-***3', address: '테스트시 가상로 4 (****)' } : order);
  const { db, detail, options, view, choose } = setup(t, orders, parcels);
  const before = view(), groups = before.trackingReview.groups;
  assert.equal(before.trackingReview.pendingCount, 4);
  assert.equal(before.fileActions.create, false);
  const choices = orders.map((order, index) => {
    const group = groups.find(group => group.internalId === order.internalId);
    assert.equal(group.kind, 'reprint_reference');
    assert.equal(group.originalTrackingNumber, order.originalTrackingNumber);
    assert.equal(group.reprintTrackingNumber, order.trackingNumber);
    assert.equal(group.splitEligible, false);
    assert.equal(group.replacementEligible, false);
    assert.deepEqual(group.candidates.map(candidate => [candidate.role, candidate.referenceOnly, candidate.selectable]),
      [['original', true, true], ['reprint', false, true]]);
    assert.deepEqual(group.candidates[0].sources, []);
    return { key: group.key, mode: 'replace', trackingNumber: index ? order.trackingNumber : order.originalTrackingNumber };
  });
  assert.throws(() => choose(choices), /원송장 적용을 확인/);
  assert.equal(view().viewVersion, before.viewVersion);
  assert.throws(() => choose([{ ...choices[1], mode: 'split' }]), /유효한 송장 후보/);
  assert.equal(invoices.importInvoiceFiles(db, options).run.id, detail.run.id);
  const after = choose([{ ...choices[0], acknowledgeOriginal: true }, ...choices.slice(1)]);
  assert.equal(after.trackingReview.pendingCount, 0);
  assert.equal(after.fileActions.create, true);
  for (const [index, order] of orders.entries()) {
    const item = after.items.find(item => item.internalId === order.internalId);
    assert.equal(item.trackingNumber, choices[index].trackingNumber);
    assert.equal(item.decision, 'include');
    assert.deepEqual(item.physicalShipments.map(parcel => [parcel.trackingNumber, parcel.valid]), [[order.trackingNumber, index ? true : null]]);
  }
  assert.deepEqual(exportedNumbers(invoices.exportInvoices(db, detail.run.id)), choices.map(choice => choice.trackingNumber));
  assert.throws(() => choose([{ ...choices[0], acknowledgeOriginal: true }], before.viewVersion), error => error.status === 409);
});

test('기존 보관 엑셀과 명시 보류·제외는 번호 선택 후에도 보존하고 이후 보류를 명시적으로 해제할 수 있다', t => {
  const orders = [fixtureOrder(0), fixtureOrder(1), { ...fixtureOrder(2), originalTrackingNumber: '' }];
  const { db, detail, view, choose } = setup(t, orders);
  const [hold, exclude] = detail.items;
  invoices.reviseInvoiceItems(db, detail.run.id, { changes: [
    { id: hold.id, decision: 'hold', note: '직원이 별도 확인 중' }, { id: exclude.id, decision: 'exclude', note: '다음 작업에서 처리' },
  ] });
  const saved = invoices.exportInvoices(db, detail.run.id).buffer;
  const choices = view().trackingReview.groups.map(group => ({ key: group.key, mode: 'replace', trackingNumber: group.reprintTrackingNumber }));
  const after = choose(choices);
  assert.deepEqual(after.items.map(item => item.decision), ['hold', 'exclude', 'include']);
  assert.deepEqual(after.items.map(item => item.note), ['직원이 별도 확인 중', '다음 작업에서 처리', '']);
  invoices.reviseInvoiceItems(db, detail.run.id, { changes: [{ id: hold.id, decision: 'include', note: '' }] });
  const next = invoices.prepareInvoiceFile(db, detail.run.id, { mode: 'export', expectedVersion: view().viewVersion });
  assert.deepEqual(exportedNumbers(next), [orders[0].trackingNumber, orders[2].trackingNumber]);
  assert.deepEqual(invoices.downloadInvoices(db, detail.run.id).buffer, saved);
});

test('원송장 번호가 다른 출고에 있거나 수취인이 다르면 직원 선택으로 우회하지 않는다', async t => {
  for (const mismatch of ['other shipment', 'recipient', 'duplicate recipient']) await t.test(mismatch, t => {
    const original = fixtureOrder(0), second = { ...fixtureOrder(1), originalTrackingNumber: '',
      ...(mismatch === 'other shipment' ? { trackingNumber: original.originalTrackingNumber } : {}) };
    const parcels = [mismatch === 'recipient' ? { ...original, recipient: '다른 수취인' } : original, second];
    if (mismatch === 'duplicate recipient') parcels.push({ ...original, recipient: '다른 수취인' });
    const { view, choose } = setup(t, [original, second], parcels);
    const [group] = view().trackingReview.groups;
    assert.equal(group.kind, 'reprint_reference');
    assert.equal(group.replaceEligible, false);
    assert.ok(group.candidates.every(candidate => !candidate.selectable));
    assert.throws(() => choose([{ key: group.key, mode: 'replace', trackingNumber: group.originalTrackingNumber, acknowledgeOriginal: true }]), /근거가 불명확/);
  });
});

test('이미 확인한 원송장도 로젠 원본 근거가 사라지면 새 엑셀을 차단한다', t => {
  const order = fixtureOrder(0);
  const { db, detail, view, choose } = setup(t, [order]);
  const [group] = view().trackingReview.groups;
  const after = choose([{ key: group.key, mode: 'replace', trackingNumber: group.originalTrackingNumber, acknowledgeOriginal: true }]);
  assert.equal(after.fileActions.create, true);
  db.prepare("DELETE FROM invoice_files WHERE run_id = ? AND kind = 'courier'").run(detail.run.id);
  assert.equal(view().fileActions.create, false);
  assert.throws(() => invoices.exportInvoices(db, detail.run.id), /연결이 불명확한 항목/);
});

test('송장 두 건이 모두 별도 행이면 원송장 누락 흐름으로 바꾸지 않고 기존 선택을 유지한다', t => {
  const order = { ...fixtureOrder(0), originalTrackingNumber: '' };
  const original = { ...order, trackingNumber: '45680000010' }, reprint = { ...order, round: 2 };
  const { view, choose } = setup(t, [order], [original, reprint]);
  const [group] = view().trackingReview.groups;
  assert.equal(group.needsSelection, true);
  assert.equal(group.replaceEligible, true);
  assert.equal(group.splitEligible, true);
  assert.equal(group.replacementEligible, false);
  assert.equal(group.kind, undefined);
  const after = choose([{ key: group.key, mode: 'replace', trackingNumber: reprint.trackingNumber }]);
  assert.equal(after.items[0].trackingNumber, reprint.trackingNumber);
  assert.equal(after.items[0].physicalShipments.find(parcel => parcel.trackingNumber === original.trackingNumber).valid, false);
});
