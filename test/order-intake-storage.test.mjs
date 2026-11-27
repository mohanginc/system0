import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../lib/database.mjs';
import { addProductCost } from '../lib/products.mjs';
import { collectOrderIntake, getOrderIntake, normalizeOrderIntake, reviseOrderIntake } from '../lib/order-intake.mjs';

const barcode = '8809538930160';
const first = { productOrderId: '2026112780000001', orderId: '2026112780000300', store: 'A1', quantity: 2,
  status: 'PAYED', placeOrderStatus: 'NOT_YET', originalName: '가상 상품', productName: '가상 상품',
  optionName: '색상: 하양', paidAt: '2026-11-26T16:00:00Z', externalProductId: '321', externalOptionId: '654',
  financial: { orderedQuantity: 2, productAmount: 30_000, paymentAmount: 27_000, shippingFeeAmount: 0 },
  sourcePayload: { item: '가상 원본', shippingAddress: { name: '가상 수취인' }, quantity: 2 } };

function client(count) {
  return { responses: { async create({ input }) {
    count.calls++;
    assert.doesNotMatch(input, /가상 수취인|shippingAddress|paymentAmount|2026112780000001/);
    return { output_text: JSON.stringify({ items: JSON.parse(input).map(({ id }) => ({
      id, cleanedName: '모의 정리명', needsAttention: false, note: '',
    })) }) };
  } } };
}

test('수집은 원본 변경 이력·알 수 없는 금액·직원 검수·적용 원가를 보존하고 중복 정리를 막는다', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const count = { calls: 0 };
  const naver = { listNewOrders: async () => ({ orders: [first] }) };
  const model = '가상 모델';
  const initial = await collectOrderIntake(db, { naver });
  assert.equal(initial.collection.added, 1);
  assert.equal(initial.summary.pendingCount, 1);
  assert.match(initial.namingError, /OPENAI_API_KEY/);
  assert.equal(initial.orders[0].financial.shippingFeeAmount, 0);
  assert.equal(initial.orders[0].financial.settlementAmount, null);
  assert.equal(initial.orders[0].financial.sellerDiscountAmount, null);
  assert.doesNotMatch(JSON.stringify(initial), /가상 수취인|shippingAddress/);
  assert.equal(JSON.parse(db.prepare('SELECT source_json FROM order_intake_snapshots').get().source_json).shippingAddress.name, '가상 수취인');
  assert.equal(db.prepare('SELECT count(*) AS n FROM batches').get().n, 0);
  const normalized = await normalizeOrderIntake(db, { client: client(count), model });
  assert.equal(normalized.orders[0].cleanedName, '모의 정리명');
  assert.equal(count.calls, 1);
  const repeat = await collectOrderIntake(db, { naver, client: client(count), model });
  assert.deepEqual(repeat.collection, { added: 0, updated: 0, unchanged: 1, unverified: 0 });
  assert.equal(count.calls, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM order_intake_snapshots').get().n, 1);

  const selected = repeat.orders[0];
  addProductCost(db, barcode, { effectiveDate: '2026-11-27', unitCostKrw: 2000 });
  const reviewed = reviseOrderIntake(db, selected.id, { expected: selected.reviewVersion, cleanedName: '직원 검수명', skuBarcode: barcode });
  assert.deepEqual(reviewed.orders[0].cost, { unitCost: 2000, effectiveDate: '2026-11-27', totalCost: 4000 });
  assert.throws(() => reviseOrderIntake(db, selected.id, { expected: selected.reviewVersion, cleanedName: '오래된 검수' }), { status: 409 });
  addProductCost(db, barcode, { effectiveDate: '2026-11-26', unitCostKrw: 1000 });
  const partial = { ...first, quantity: 1, claimStatus: 'CANCEL_DONE', financial: { ...first.financial, productAmount: 15_000, paymentAmount: 13_500 },
    sourcePayload: { ...first.sourcePayload, quantity: 1 } };
  const refreshed = await collectOrderIntake(db, { naver: { listNewOrders: async () => ({ orders: [partial] }) }, client: client(count), model });
  assert.equal(refreshed.collection.updated, 1);
  assert.equal(refreshed.orders[0].namingStatus, 'confirmed');
  assert.equal(refreshed.orders[0].cleanedName, '직원 검수명');
  assert.equal(refreshed.orders[0].skuBarcode, barcode);
  assert.equal(refreshed.orders[0].cost.totalCost, 2000);
  assert.equal(refreshed.groups[0].count, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM order_intake_snapshots').get().n, 2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM order_intake_reviews').get().n, 1);
  assert.equal(count.calls, 1);
});

test('목록에서 빠진 상품주문은 상세 확인 전 미확인으로 두고 일부 확인 결과만 반영한다', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const second = { ...first, productOrderId: '2026112780000002', store: 'B2' };
  await collectOrderIntake(db, { naver: { listNewOrders: async () => ({ orders: [first, second] }) } });
  const emptyList = async options => {
    assert.deepEqual(options, { includeIntake: true, lookbackDays: 30 });
    return { orders: [] };
  };
  const disappeared = await collectOrderIntake(db, { lookbackDays: 30, naver: { listNewOrders: emptyList,
    queryProductOrders: async (ids, options) => {
      assert.deepEqual(new Set(ids), new Set([first.productOrderId, second.productOrderId]));
      assert.deepEqual(options, { includeIntake: true, allowMissing: true });
      return [{ ...first, status: 'CANCELED', quantity: 0, sourcePayload: { ...first.sourcePayload, quantity: 0 } }];
    } } });
  assert.equal(disappeared.summary.quantity, 0);
  assert.equal(disappeared.summary.unverifiedCount, 1);
  assert.deepEqual(disappeared.orders.map(({ productOrderId, status, state }) => ({ productOrderId, status, state })),
    [{ productOrderId: second.productOrderId, status: 'PAYED', state: 'unverified' }]);
  assert.equal(db.prepare('SELECT state FROM order_intake_items WHERE product_order_id=?').get(first.productOrderId).state, 'closed');
  assert.equal(db.prepare('SELECT count(*) AS n FROM order_intake_items').get().n, 2);
  await assert.rejects(collectOrderIntake(db, { naver: { listNewOrders: async () => { throw new Error('모의 조회 오류'); } } }), /모의 조회 오류/);
  assert.equal(getOrderIntake(db).summary.unverifiedCount, 1);
  await assert.rejects(collectOrderIntake(db, { lookbackDays: 181 }), { status: 400 });
});

test('스토어가 다른 같은 상품주문번호는 합치지 않고 스토어가 빠진 상세 응답으로 종결하지 않는다', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const second = { ...first, store: 'B2' };
  const both = await collectOrderIntake(db, { naver: { listNewOrders: async () => ({ orders: [first, second] }) } });
  assert.equal(both.summary.orderCount, 2);
  assert.equal(both.groups[0].count, 4);
  assert.notEqual(both.orders[0].id, both.orders[1].id);
  const rechecked = await collectOrderIntake(db, { naver: { listNewOrders: async () => ({ orders: [first] }),
    queryProductOrders: async () => [{ ...first, store: '', status: 'CANCELED', quantity: 0 }] } });
  assert.equal(rechecked.summary.quantity, 2);
  assert.deepEqual(rechecked.orders.map(order => [order.store, order.state]).sort(), [['A1', 'pending'], ['B2', 'unverified']]);
});
