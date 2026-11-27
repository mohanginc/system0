import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../lib/database.mjs';
import { collectOrderIntake } from '../lib/order-intake.mjs';
import { getOrderPacking, reviseOrderPacking } from '../lib/order-packing.mjs';

const defaultAddress = { name: '가상 수취인', baseAddress: '가상시 가상로 10', detailedAddress: '101호', zipCode: '12345' };

function item(number, { shippingAddress = defaultAddress, quantity = 2, status = 'PAYED', claimStatus = '' } = {}) {
  const productOrderId = `20261129000000${number}`, orderId = `20261129000001${number}`;
  return { productOrderId, orderId, status, placeOrderStatus: 'NOT_YET', claimStatus, quantity,
    productName: `가상 상품 ${number}`, optionName: `옵션 ${number}`, financial: { paymentAmount: 10_000, unitPrice: 5000 },
    sourcePayload: { productOrderId, content: { productOrder: { shippingAddress, remainQuantity: quantity } } } };
}

async function collect(db, orders, missing = []) {
  await collectOrderIntake(db, { naver: { listNewOrders: async () => ({ orders }), queryProductOrders: async () => missing } });
}

const packed = (orderItemId, quantity) => ({ orderItemId, quantity });

test('같은 배송지의 두 주문을 합포장했다가 수량별로 나누고 원본과 이전 상자 구성을 보존한다', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const empty = getOrderPacking(db);
  assert.match(empty.version, /^[a-f0-9]{64}$/);
  assert.deepEqual(empty.orders, []);
  assert.deepEqual(empty.summary, { boxCount: 0, reviewBoxCount: 0, allocatedQuantity: 0, unallocatedQuantity: 0 });
  await collect(db, [item(1, { quantity: 3 }), item(2, { quantity: 1 })]);
  const first = getOrderPacking(db), [left, right] = first.orders;
  assert.equal(left.recipient, '가상 수취인');
  assert.equal(left.destinationReady, true);
  assert.equal(left.cleanedName, '');
  assert.equal(left.namingStatus, 'pending');
  assert.equal(left.skuBarcode, null);
  assert.doesNotMatch(JSON.stringify(first), /가상시|101호|12345|destinationHash/);
  assert.equal(first.summary.unallocatedQuantity, 4);
  const original = db.prepare('SELECT id, quantity, order_json FROM order_intake_items ORDER BY id').all();
  const merged = reviseOrderPacking(db, { expectedVersion: first.version, removeBoxIds: [],
    boxes: [{ items: [packed(left.id, 3), packed(right.id, 1)] }] });
  assert.deepEqual(merged.summary, { boxCount: 1, reviewBoxCount: 0, allocatedQuantity: 4, unallocatedQuantity: 0 });
  assert.equal(merged.boxes[0].needsReview, false);
  const combinedBox = merged.boxes[0].id;
  const split = reviseOrderPacking(db, { expectedVersion: merged.version, removeBoxIds: [combinedBox],
    boxes: [{ items: [packed(left.id, 1), packed(right.id, 1)] }, { items: [packed(left.id, 1)] }] });
  assert.notEqual(split.version, merged.version);
  assert.deepEqual(split.summary, { boxCount: 2, reviewBoxCount: 0, allocatedQuantity: 3, unallocatedQuantity: 1 });
  assert.deepEqual(split.orders.map(order => [order.allocatedQuantity, order.availableQuantity]), [[2, 1], [1, 0]]);
  assert.ok(!split.boxes.some(box => box.id === combinedBox));
  assert.deepEqual(db.prepare('SELECT order_item_id AS orderItemId, quantity FROM order_packing_items WHERE box_id=? ORDER BY order_item_id')
    .all(combinedBox).map(row => ({ ...row })), [packed(left.id, 3), packed(right.id, 1)]);
  assert.deepEqual(db.prepare('SELECT id, quantity, order_json FROM order_intake_items ORDER BY id').all(), original);
  assert.throws(() => reviseOrderPacking(db, { expectedVersion: merged.version, removeBoxIds: [combinedBox], boxes: [] }), { status: 409 });
  assert.throws(() => reviseOrderPacking(db, { expectedVersion: split.version, removeBoxIds: [],
    boxes: [{ items: [packed(left.id, 2)] }] }), /잔여 수량/);
  assert.deepEqual(getOrderPacking(db), split);
});

test('합포장은 전체 배송지와 수취인이 일치해야 하고 원본 변경이나 취소가 발생하면 이전 계획을 검토 대상으로 둔다', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const sameNameOtherAddress = { ...defaultAddress, detailedAddress: '202호' };
  const maskedAddress = { ...defaultAddress, name: '가* 수취인' };
  const sameAddressOtherName = { ...defaultAddress, name: '다른 수취인' };
  const one = item(1), two = item(2, { shippingAddress: sameNameOtherAddress });
  const three = item(3, { shippingAddress: maskedAddress }), four = item(4, { shippingAddress: sameAddressOtherName });
  await collect(db, [one, two, three, four, item(5, { claimStatus: 'CANCEL_REQUEST' })]);
  const initial = getOrderPacking(db), [left, right, masked, differentName] = initial.orders;
  assert.equal(initial.orders.length, 4);
  assert.equal(masked.destinationReady, false);
  for (const candidate of [right, masked, differentName]) {
    assert.throws(() => reviseOrderPacking(db, { expectedVersion: initial.version, removeBoxIds: [], boxes: [
      { items: [packed(masked.id, 1)] }, { items: [packed(left.id, 1), packed(candidate.id, 1)] },
    ] }), /전체 배송지/);
  }
  assert.deepEqual(getOrderPacking(db), initial);
  const planned = reviseOrderPacking(db, { expectedVersion: initial.version, removeBoxIds: [],
    boxes: [{ items: [packed(left.id, 2)] }, { items: [packed(masked.id, 1)] }] });
  assert.deepEqual(planned.boxes.map(box => box.needsReview), [false, true]);
  await collect(db, [item(1, { shippingAddress: sameNameOtherAddress }), two, three, four]);
  const moved = getOrderPacking(db);
  assert.equal(moved.boxes[0].needsReview, true);
  assert.equal(moved.summary.reviewBoxCount, 2);
  assert.deepEqual(moved.boxes[0].items, planned.boxes[0].items);
  assert.notEqual(moved.version, planned.version);
  await collect(db, [two, three, four], [item(1, { status: 'CANCELED', quantity: 0 })]);
  const canceled = getOrderPacking(db);
  assert.equal(canceled.orders.find(order => order.id === left.id).state, 'closed');
  assert.equal(canceled.orders.find(order => order.id === left.id).availableQuantity, 0);
  assert.equal(canceled.boxes[0].needsReview, true);
  assert.throws(() => reviseOrderPacking(db, { expectedVersion: canceled.version, removeBoxIds: [canceled.boxes[0].id],
    boxes: [{ items: [packed(left.id, 1)] }] }), /포장 가능한 주문/);
  assert.equal(getOrderPacking(db).boxes.length, 2);
});

test('상세 조회의 부분 취소는 배송지 연결과 기존 상자를 보존하고 수량을 초과한 상자만 검토 대상으로 표시한다', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const one = item(1, { quantity: 3 }), two = item(2, { quantity: 1 });
  await collect(db, [one, two]);
  const initial = getOrderPacking(db), [left, right] = initial.orders;
  const planned = reviseOrderPacking(db, { expectedVersion: initial.version, removeBoxIds: [], boxes: [
    { items: [packed(left.id, 2)] }, { items: [packed(right.id, 1)] },
  ] });
  const detail = { ...one, quantity: 1, claimStatus: 'CANCEL_DONE',
    sourcePayload: { productOrder: { shippingAddress: defaultAddress, remainQuantity: 1 } } };
  await collect(db, [two], [detail]);
  const after = getOrderPacking(db), changed = after.orders.find(o => o.id === left.id);
  assert.equal(changed.destinationReady, true);
  assert.equal(changed.state, 'pending');
  assert.equal(changed.quantity, 1);
  assert.equal(changed.allocatedQuantity, 2);
  assert.equal(changed.availableQuantity, 0);
  assert.equal(after.summary.reviewBoxCount, 1);
  assert.deepEqual(after.boxes, [{ ...planned.boxes[0], needsReview: true }, planned.boxes[1]]);
});
