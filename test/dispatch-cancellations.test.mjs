import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../lib/database.mjs';
import { checkDispatchCancellations, dispatchCancellationStates } from '../lib/dispatch-cancellations.mjs';

const from = '2026-11-26T15:00:00.000Z', to = '2026-11-27T15:00:00.000Z';

function item(db, number, { provider = 'naver', store = 'mock-store', quantity = 1, productOrderId = `상품${number}` } = {}) {
  const orderId = `주문${number}`;
  const { lastInsertRowid: id } = db.prepare(`INSERT INTO order_intake_items
    (provider,store,product_order_id,order_id,state,quantity,original_name,product_name,option_name,order_json,source_hash,
      source_method,first_seen_at,last_seen_at) VALUES (?,?,?,?,'pending',?,'가상 상품','가상 상품','','{}','','list',?,?)`)
    .run(provider, store, productOrderId, orderId, quantity, from, from);
  return { id, provider, store, productOrderId, orderId };
}

function box(db, items, registeredAt = from) {
  const { lastInsertRowid: id } = db.prepare('INSERT INTO order_dispatch_boxes (registered_at,recipient) VALUES (?,?)')
    .run(registeredAt, '가상 수취인');
  const add = db.prepare(`INSERT INTO order_dispatch_items
    (dispatch_box_id,order_item_id,quantity,name,provider,product_order_id,shipment_type) VALUES (?,?,1,'가상 상품',?,?,'sale')`);
  for (const item of items) add.run(id, item.id, item.provider, item.productOrderId);
  return id;
}

const response = ({ productOrderId, orderId, store }, fields = {}) => ({ productOrderId, orderId, store,
  status: 'PAYED', remainQuantity: 1, ...fields });

test('선택한 날짜의 네이버 상품을 조회하고 완전 취소, 합포장, 일부 수량, 누락 응답을 구분한다', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const full = item(db, 1), mixed = item(db, 2), split = item(db, 3, { quantity: 2 }), pending = item(db, 4);
  const ready = item(db, 5), missing = item(db, 6), other = item(db, 7, { provider: 'coupang' }), nextDay = item(db, 8);
  const fullBox = box(db, [full]), mixedBox = box(db, [mixed, other]), [leftBox, rightBox] = [box(db, [split]), box(db, [split])];
  const pendingBox = box(db, [pending]), readyBox = box(db, [ready]), missingBox = box(db, [missing]);
  const otherBox = box(db, [other]);
  box(db, [nextDay], to);
  const itemsBefore = db.prepare('SELECT * FROM order_dispatch_items ORDER BY dispatch_box_id,order_item_id').all();
  assert.equal(dispatchCancellationStates(db, from, to).lastCheckedAt, null);
  const result = await checkDispatchCancellations(db, from, to, { async queryProductOrders(ids, options) {
    assert.deepEqual(ids, [full, mixed, split, pending, ready, missing].map(row => row.productOrderId));
    assert.deepEqual(options, { includeIntake: true, allowMissing: true });
    return [response(full, { status: 'CANCELED', remainQuantity: 0 }), response(mixed, { status: 'CANCELED', remainQuantity: 0 }),
      response(split), response(pending, { claimStatus: 'CANCEL_REQUEST' }), response(ready)];
  } });
  assert.deepEqual({ ...result, lastCheckedAt: Boolean(result.lastCheckedAt) }, { lastCheckedAt: true, naverBoxCount: 7, queriedCount: 6,
    matchedCount: 6, readyCount: 1, holdCount: 5, canceledCount: 1, unverifiedCount: 1, missingCount: 1 });
  const { boxes } = dispatchCancellationStates(db, from, to);
  assert.deepEqual([...boxes].map(([id, result]) => [id, result.dispatchState]), [[fullBox, 'canceled'], [mixedBox, 'hold'],
    [leftBox, 'hold'], [rightBox, 'hold'], [pendingBox, 'hold'], [readyBox, 'ready'], [missingBox, 'hold']]);
  assert.match(boxes.get(mixedBox).dispatchReason, /취소된 상품/);
  assert.match(boxes.get(missingBox).dispatchReason, /확인하지 못했습니다/);
  assert.equal(boxes.has(otherBox), false);
  assert.deepEqual(db.prepare('SELECT * FROM order_dispatch_items ORDER BY dispatch_box_id,order_item_id').all(), itemsBefore);
});

test('과거 또는 누락 응답은 확인된 취소를 지우지 않으며 더 새 철회가 확인된 보류만 해제한다', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const a = item(db, 1), b = item(db, 2);
  const [first, second] = [box(db, [a]), box(db, [b])];
  const checked = rows => checkDispatchCancellations(db, from, to, { queryProductOrders: async () => rows });
  const recent = '2026-11-27T02:00:00.000Z', old = '2026-11-27T01:00:00.000Z', latest = '2026-11-27T03:00:00.000Z';
  await checked([response(a, { status: 'CANCELED', remainQuantity: 0, changedAt: recent }),
    response(b, { claimStatus: 'CANCEL_REQUEST', changedAt: recent })]);
  await checked([response(a, { changedAt: old }), response(b, { changedAt: old })]);
  let state = dispatchCancellationStates(db, from, to);
  assert.equal(state.boxes.get(first).dispatchState, 'canceled');
  assert.equal(state.boxes.get(second).dispatchState, 'hold');
  const afterMissing = await checked([response(b, { claimStatus: 'CANCEL_REJECT', changedAt: latest })]);
  assert.equal(afterMissing.missingCount, 1);
  state = dispatchCancellationStates(db, from, to);
  assert.equal(state.boxes.get(first).dispatchState, 'canceled');
  assert.equal(state.boxes.get(second).dispatchState, 'ready');
  await assert.rejects(checkDispatchCancellations(db, from, to, { async queryProductOrders() { throw new Error('모의 일시 오류'); } }), /일시 오류/);
  assert.deepEqual(dispatchCancellationStates(db, from, to), state);
});
