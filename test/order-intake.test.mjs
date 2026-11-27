import test from 'node:test';
import assert from 'node:assert/strict';
import { createNaverClient } from '../lib/naver.mjs';
import { createApp } from '../server.mjs';

const id = '202611270000000001', orderId = '202611270000000099';
const paymentDate = '2026-11-27T09:10:00+09:00';
const body = (method, data) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

async function start(t, options) {
  const app = createApp({ databasePath: ':memory:', discordConfig: null, ...options });
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    app.locals.db.close();
  });
  const request = async (route, options, status = 200) => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + route, options);
    assert.equal(response.status, status, await response.clone().text());
    return response;
  };
  return { db: app.locals.db, request, json: async (...args) => (await request(...args)).json() };
}

const nameResult = request => ({ output_text: JSON.stringify({ items: JSON.parse(request.input).map(({ id }) => ({
  id, cleanedName: '가상 정리 상품', needsAttention: false, note: '',
})) }) });

test('수집은 원본과 상품 금액을 기록하고 재수집·부분취소·발주확인 후 수량과 검수·원가 이력을 보존한다', async t => {
  const requests = [];
  let phase = 'paid', time = Date.parse('2026-11-27T02:00:00Z'), namingCalls = 0;
  const naver = createNaverClient({ clientId: 'mock-id', clientSecret: '$2b$04$abcdefghijklmnopqrstuu',
    now: () => time, wait: async () => {}, fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      const route = parsed.pathname;
      requests.push([route, options.method]);
      if (route.endsWith('/token')) return Response.json({ access_token: 'mock-token', expires_in: 3600 });
      const change = phase === 'paid' ? 0 : phase === 'partial' ? 1 : 2;
      const content = {
        order: { orderId, orderDate: paymentDate, paymentDate, generalPaymentAmount: 90000 },
        productOrder: { productOrderId: id, productOrderStatus: 'PAYED', placeOrderStatus: change === 2 ? 'OK' : 'NOT_YET',
          productName: '가상 원본 상품', productOption: '가상 13cm', merchantChannelId: 'store-1',
          productId: 'product-1', itemNo: 'option-1', packageNumber: 'delivery-1',
          unitPrice: 20000, optionPrice: 1000, initialQuantity: 2, remainQuantity: change ? 1 : 2,
          initialProductAmount: 42000, remainProductAmount: change ? 21000 : 42000,
          initialPaymentAmount: 40000, remainPaymentAmount: change ? 20000 : 40000,
          remainSellerBurdenDiscountAmount: 0, deliveryFeeAmount: 3000, sectionDeliveryFee: 2000, deliveryDiscountAmount: 500,
          shippingAddress: { name: '가상 비공개 수령인', detailedAddress: '가상 비공개 상세 주소' },
        },
      };
      if (route.endsWith('/query')) {
        assert.equal(options.method, 'POST');
        assert.deepEqual(JSON.parse(options.body).productOrderIds, [id]);
        return Response.json({ data: [content] });
      }
      assert.ok(route.endsWith('/product-orders') && options.method === 'GET');
      assert.equal(parsed.searchParams.get('placeOrderStatusType'), 'NOT_YET');
      return Response.json({ data: { pagination: { hasNext: false },
        contents: change !== 2 && parsed.searchParams.get('to') === new Date(time).toISOString()
          ? [{ productOrderId: id, content }] : [] } });
    } });
  const { db, request, json } = await start(t, { naver, client: { responses: { async create(request) {
    namingCalls++;
    assert.ok(!/비공개|90000|store-1|delivery-1|2026112700/.test(JSON.stringify(request.input)));
    return nameResult(request);
  } } } });
  assert.match(await (await request('/')).text(), /주문 수집/);
  assert.match(await (await request('/?batch=7')).text(), /주문 파일 불러오기/);
  assert.match(await (await request('/product-names')).text(), /주문 파일 불러오기/);
  assert.equal((await json('/api/order-intake')).summary.quantity, 0);
  assert.deepEqual(requests, []);

  const barcode = '1234567890128', costs = '/api/products/' + barcode + '/costs';
  await json('/api/products', body('POST', { barcode, name: '가상 정리 상품' }), 201);
  await json(costs, body('POST', { effectiveDate: '2026-11-01', unitCostKrw: 9000 }), 201);
  const collect = () => json('/api/order-intake/collect', body('POST', { lookbackDays: 2 }));
  const result = await collect(), [order] = result.orders;
  assert.equal(requests.filter(([, method]) => method === 'GET').length, 2);
  assert.equal(result.collection.added, 1);
  assert.equal(result.summary.quantity, 2);
  assert.equal(order.store, 'store-1');
  assert.equal(order.collectionMethod, 'api');
  assert.equal(order.productOrderId, id);
  assert.equal(order.externalOptionId, 'option-1');
  assert.equal(order.shippingGroupId, 'delivery-1');
  assert.equal(order.financial.initialPaymentAmount, 40000);
  assert.equal(order.financial.sellerDiscountAmount, 0);
  assert.equal(order.financial.settlementAmount, null);
  assert.equal(order.financial.shippingExtraAmount, 2000);
  assert.ok(!JSON.stringify(result).includes('비공개'));
  assert.equal(db.prepare('SELECT count(*) AS count FROM order_intake_snapshots').get().count, 1);
  assert.match(db.prepare('SELECT source_json FROM order_intake_snapshots').get().source_json, /가상 비공개 상세 주소/);
  assert.equal(db.prepare('SELECT count(*) AS count FROM batches').get().count, 0);

  const reviewPath = '/api/order-intake/orders/' + order.id;
  const review = await json(reviewPath, body('PATCH', { cleanedName: '직원 검수 상품', skuBarcode: barcode, expected: order.reviewVersion }));
  assert.equal(review.groups[0].skuBarcode, barcode);
  assert.equal(review.orders[0].cost.totalCost, 18000);
  await json(reviewPath, body('PATCH', { cleanedName: '오래된 이름', expected: order.reviewVersion }), 409);
  await json(costs, body('POST', { effectiveDate: '2026-11-15', unitCostKrw: 10000 }), 201);
  const again = await collect();
  assert.equal(again.collection.unchanged, 1);
  assert.equal(again.orders[0].cleanedName, '직원 검수 상품');
  assert.equal(again.orders[0].cost.unitCost, 9000);
  phase = 'partial';
  time += 1000;
  const changed = await collect();
  assert.equal(changed.orders[0].id, order.id);
  assert.equal(changed.orders[0].financial.paymentAmount, 20000);
  assert.equal(changed.orders[0].financial.initialPaymentAmount, 40000);
  assert.equal(changed.orders[0].cost.totalCost, 9000);
  assert.equal(namingCalls, 1);

  phase = 'confirmed';
  time += 1000;
  assert.equal((await collect()).summary.quantity, 0);
  assert.equal(db.prepare('SELECT state FROM order_intake_items').get().state, 'closed');
  assert.equal(db.prepare('SELECT count(*) AS count FROM order_intake_snapshots').get().count, 3);
  assert.equal(db.prepare('SELECT count(*) AS count FROM order_intake_reviews').get().count, 1);
});

test('상품명 정리 실패 후 같은 주문을 다시 읽지 않고 정리하며 조회 실패가 이전 저장을 덮지 않는다', async t => {
  let reads = 0, fails = true;
  const { json } = await start(t, { naver: { async listNewOrders() {
    if (++reads > 1) throw new Error('네이버 연결 오류');
    return { from: paymentDate, to: paymentDate, orders: [
      { productOrderId: id, orderId, quantity: 1, originalName: '재시도 원본 상품' },
    ] };
  } }, client: { responses: { async create(request) {
    if (fails) throw new Error('임시 오류');
    return nameResult(request);
  } } } });
  const failed = await json('/api/order-intake/collect', { method: 'POST' });
  assert.ok(failed.namingError);
  assert.equal(failed.collection.added, 1);
  assert.equal(failed.summary.pendingCount, 1);
  fails = false;
  const resumed = await json('/api/order-intake/normalize', { method: 'POST' });
  assert.equal(resumed.summary.pendingCount, 0);
  assert.equal(resumed.orders[0].id, failed.orders[0].id);
  assert.equal(reads, 1);
  await json('/api/order-intake/collect', { method: 'POST' }, 400);
  const previous = await json('/api/order-intake');
  assert.equal(previous.updatedAt, failed.updatedAt);
  assert.equal(previous.orders[0].cleanedName, '가상 정리 상품');
});
