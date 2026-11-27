import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { openDatabase } from '../lib/database.mjs';
import { getOrderIntake, collectOrderIntake, importCoupangOrders } from '../lib/order-intake.mjs';
import { getOrderPacking, reviseOrderPacking, registerOrderDispatch } from '../lib/order-packing.mjs';

const headings = ['번호', '묶음배송번호', '주문번호', '운송장번호', '출고일(발송일)', '주문일', '등록상품명', '등록옵션명',
  '노출상품ID', '옵션ID', '바코드', '결제액', '배송비', '도서산간 추가배송비', '구매수(수량)', '옵션판매가(판매단가)',
  '수취인이름', '우편번호', '수취인 주소', '주문상태'];
const pending = ['1', '000000000000123', '000000000000456', '', '', '2026-11-27 10:00:00', '모의 상품', '모의 옵션',
  '0000123', '0000456', '', '24,000', '2500', '0', '3', '8000', '모의 수취인', '01234', '가상시 가상로 10 101호', ''];
const replace = (row, field, value) => row.map((cell, index) => headings[index] === field ? value : cell);

function workbook(rows, originalname = 'DeliveryList(2026-11-27)_(0).xlsx') {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([headings, ...rows]), 'Delivery');
  return { originalname, buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) };
}

test('쿠팡 주문은 파일 행 증거를 보존하고 재업로드와 네이버 재수집에서 같은 주문을 중복 저장하지 않는다', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const first = await importCoupangOrders(db, { file: workbook([pending]) });
  assert.equal(first.collection.added, 1);
  assert.match(first.namingError, /OPENAI_API_KEY/);
  const [item] = first.orders;
  assert.match(item.productOrderId, /^cp-[0-9a-f]{64}$/);
  assert.equal(item.orderId, pending[2]);
  assert.equal(item.shippingGroupId, pending[1]);
  assert.equal(item.externalOptionId, pending[9]);
  assert.equal(item.provider, 'coupang');
  assert.equal(item.collectionMethod, 'file');
  assert.equal(item.orderedAt, '2026-11-27T01:00:00.000Z');
  assert.equal(item.financial.paymentAmount, 24000);
  assert.equal(item.financial.unitPrice, 8000);
  assert.equal(item.financial.shippingFeeAmount, 2500);
  assert.equal(item.financial.shippingExtraAmount, 0);
  assert.equal(item.financial.expectedSettlementAmount, null);
  assert.doesNotMatch(JSON.stringify(first), /가상시|모의 수취인/);
  const snapshot = JSON.parse(db.prepare('SELECT source_json FROM order_intake_snapshots').get().source_json);
  assert.equal(snapshot.location.row, 2);
  assert.equal(snapshot.shippingAddress.baseAddress, pending[18]);
  assert.equal(snapshot.shippingAddress.zipCode, '01234');
  const reopened = await importCoupangOrders(db, { file: workbook([replace(pending, '번호', '20')], '다시 받은 파일.xlsx') });
  assert.equal(reopened.collection.unchanged, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM order_intake_snapshots').get().n, 1);
  const naverResult = await collectOrderIntake(db, { naver: { listNewOrders: async () => ({ orders: [{
    productOrderId: item.productOrderId, orderId: item.orderId, originalName: '다른 채널 주문', quantity: 1,
  }] }) } });
  assert.deepEqual(naverResult.orders.map(order => order.provider).sort(), ['coupang', 'naver']);
  assert.equal(naverResult.summary.orderCount, 2);
  const after = await collectOrderIntake(db, { naver: { listNewOrders: async () => ({ orders: [] }), queryProductOrders: async () => [] } });
  assert.equal(after.orders.find(order => order.provider === 'coupang').state, 'pending');
  assert.equal(after.orders.find(order => order.provider === 'naver').state, 'unverified');
});

test('쿠팡 엑셀의 중복 행은 원자적으로 거부하며 이전 파일로 배송 완료나 운송장 보류 상태를 되돌리지 않는다', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  await assert.rejects(importCoupangOrders(db, { file: workbook([pending, replace(pending, '번호', '2')]) }), /중복/);
  assert.equal(getOrderIntake(db).orders.length, 0);
  await importCoupangOrders(db, { file: workbook([pending]) });
  const heldRow = replace(pending, '운송장번호', '0000123456');
  const held = await importCoupangOrders(db, { file: workbook([heldRow]) });
  assert.equal(held.collection.held, 1);
  assert.equal(held.summary.quantity, 0);
  assert.equal(held.orders[0].state, 'hold');
  const replay = await importCoupangOrders(db, { file: workbook([pending]) });
  assert.equal(replay.orders[0].state, 'hold');
  const shipped = await importCoupangOrders(db, { file: workbook([replace(heldRow, '출고일(발송일)', '2026-11-27')]) });
  assert.equal(shipped.collection.closed, 1);
  assert.equal(shipped.orders.length, 0);
  const after = await importCoupangOrders(db, { file: workbook([replace(pending, '결제액', '25000')]) });
  assert.equal(after.orders.length, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM order_intake_snapshots').get().n, 3);
});

test('쿠팡 주문 일부 등록 후 잔여만 수집 화면에 남고 모두 등록하면 원가·판매 자료를 보존하며 사라진다', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const imported = await importCoupangOrders(db, { file: workbook([pending]) });
  const [{ id }] = imported.orders;
  const initial = getOrderPacking(db);
  assert.equal(initial.orders[0].destinationReady, true);
  const packed = reviseOrderPacking(db, { expectedVersion: initial.version, removeBoxIds: [], boxes: [{ items: [{ orderItemId: id, quantity: 1 }] }] });
  registerOrderDispatch(db, { expectedVersion: packed.version, boxIds: [packed.boxes[0].id], orderItemIds: [] });
  const [remaining] = getOrderIntake(db).orders;
  assert.equal(remaining.quantity, 2);
  assert.equal(remaining.sourceQuantity, 3);
  assert.equal(remaining.registeredQuantity, 1);
  assert.equal(remaining.financial.paymentAmount, 24000);
  const next = getOrderPacking(db);
  registerOrderDispatch(db, { expectedVersion: next.version, boxIds: [], orderItemIds: [id] });
  const after = await importCoupangOrders(db, { file: workbook([pending]) });
  assert.equal(after.orders.length, 0);
  assert.equal(db.prepare('SELECT quantity FROM order_intake_items WHERE id=?').get(id).quantity, 3);
});
