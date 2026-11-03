import test from 'node:test';
import assert from 'node:assert/strict';
import { createNaverClient } from '../lib/naver.mjs';

const reply = (status, body) => new Response(JSON.stringify(body), { status,
  headers: { 'Content-Type': 'application/json' } });
const detail = (id, changes = {}) => ({ order: { orderId: '000000000000000099' },
  productOrder: { productOrderId: id, productOrderStatus: 'DELIVERING', placeOrderStatus: 'OK',
    remainQuantity: 1, shippingAddress: { name: '테스트 수취인', tel1: '010-0000-0000',
      baseAddress: '테스트시 테스트구', detailedAddress: '테스트 상세' } },
  delivery: { deliveryCompany: 'KGB', trackingNumber: '001234567890', deliveryMethod: 'DELIVERY',
    deliveryStatus: 'COLLECT_REQUEST', isWrongTrackingNumber: false }, ...changes });

function fixture(read, lookup) {
  let time = Date.parse('2026-10-21T00:00:00Z'), tokens = 0, queries = 0, lookups = 0;
  const requests = [], waits = [];
  const client = createNaverClient({ clientId: 'mock-id', clientSecret: '$2b$04$abcdefghijklmnopqrstuu',
    now: () => time, wait: async ms => { waits.push(ms); time += ms; }, fetchImpl: async (url, options) => {
      const path = new URL(url).pathname;
      requests.push({ path, options });
      if (path === '/external/v1/oauth2/token') {
        tokens++;
        return reply(200, { access_token: 'mock-token-' + tokens, expires_in: 3600 });
      }
      if (path.startsWith('/external/v1/pay-order/seller/orders/')) {
        assert.equal(options.method, 'GET');
        assert.equal(options.body, undefined);
        assert.equal(typeof lookup, 'function');
        return lookup(path, ++lookups, options);
      }
      assert.equal(path, '/external/v1/pay-order/seller/product-orders/query');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['Content-Type'], 'application/json');
      const body = JSON.parse(options.body);
      assert.equal(body.quantityClaimCompatibility, true);
      return read(body.productOrderIds, ++queries, options);
    } });
  return { client, requests, waits, tokens: () => tokens, queries: () => queries, lookups: () => lookups };
}

test('주문번호로 상품주문번호를 조회하고 상세 조회와 인증 토큰을 공유한다', async () => {
  const ids = ['000000000000000001', '000000000000000002'];
  const mock = fixture(input => reply(200, { data: input.map(id => detail(id)) }),
    (path, count, options) => {
      assert.equal(path, '/external/v1/pay-order/seller/orders/000000000000000099/product-order-ids');
      assert.equal(options.headers.Authorization, 'Bearer mock-token-1');
      return reply(200, { data: ids });
    });
  const result = await mock.client.getProductOrderIds('000000000000000099');
  assert.deepEqual(result, ids);
  assert.equal((await mock.client.queryProductOrders(result)).length, 2);
  assert.equal(mock.tokens(), 1);
  assert.equal(mock.lookups(), 1);
  assert.deepEqual(mock.waits, [350, 350]);
  assert.ok(mock.requests.every(row => !/\/(dispatch|confirm|cancel)(\/|$)/.test(row.path)));
});

test('상품주문번호 목록 조회의 잘못된 주문번호는 인증 전에 거부한다', async () => {
  const mock = fixture(() => assert.fail('호출하면 안 됩니다.'));
  for (const input of [undefined, null, 123, [], '', ' a', 'a ', 'a\n', 'a/b', 'a?b', '한글', 'a'.repeat(81)]) {
    await assert.rejects(mock.client.getProductOrderIds(input), /주문번호/);
  }
  assert.equal(mock.requests.length, 0);
});

test('상품주문번호 목록은 빈 배열을 보존하고 잘못된 형식·중복 번호를 거부한다', async () => {
  const empty = fixture(undefined, () => reply(200, { data: [] }));
  assert.deepEqual(await empty.client.getProductOrderIds('order-1'), []);
  assert.equal(empty.queries(), 0);
  for (const data of [undefined, null, {}, 'id', [1], [''], [' id'], ['id '], ['id\n'], ['id/path'],
    ['id', 'id'], ['a'.repeat(81)]]) {
    const mock = fixture(undefined, () => reply(200, { data }));
    await assert.rejects(mock.client.getProductOrderIds('order-1'), /상품주문번호 목록/);
    assert.equal(mock.queries(), 0);
  }
});

test('상품주문번호 조회의 401은 토큰을 한 번 갱신하고 재실패는 멈춘다', async () => {
  const mock = fixture(undefined, (path, count, options) => {
    assert.equal(options.headers.Authorization, `Bearer mock-token-${count}`);
    return count === 1 ? reply(401, {}) : reply(200, { data: ['product-1'] });
  });
  assert.deepEqual(await mock.client.getProductOrderIds('order-1'), ['product-1']);
  assert.equal(mock.tokens(), 2);
  assert.equal(mock.lookups(), 2);
  const failed = fixture(undefined, () => reply(401, { message: '고객 비밀 mock-token-private' }));
  await assert.rejects(failed.client.getProductOrderIds('order-1'), error => /HTTP 401/.test(error.message)
    && !/고객|private/.test(error.message));
  assert.equal(failed.tokens(), 2);
  assert.equal(failed.lookups(), 2);
});

test('상품주문번호 조회는 호출 제한·서버 오류를 제한적으로 재시도한다', async () => {
  const mock = fixture(undefined, (path, count) => reply(count === 1 ? 429 : count === 2 ? 503 : 200,
    { data: ['product-1'] }));
  assert.deepEqual(await mock.client.getProductOrderIds('order-1'), ['product-1']);
  assert.equal(mock.lookups(), 3);
  assert.ok(mock.waits.includes(1000));
  assert.ok(mock.waits.includes(2000));
  const failed = fixture(undefined, () => reply(500, { message: '고객 비밀 mock-token-private' }));
  await assert.rejects(failed.client.getProductOrderIds('order-1'), error => /HTTP 500/.test(error.message)
    && !/고객|private/.test(error.message));
  assert.equal(failed.lookups(), 3);
  assert.equal(failed.tokens(), 1);
});

test('송장 조회는 300개씩 조회 전용 POST를 호출하고 문자열 번호와 배송 정보를 보존한다', async () => {
  const ids = Array.from({ length: 301 }, (_, index) => String(index + 1).padStart(18, '0'));
  const sizes = [];
  const mock = fixture(input => { sizes.push(input.length); return reply(200, { data: input.map(id => detail(id)) }); });
  const result = await mock.client.queryProductOrders(ids);
  assert.deepEqual(sizes, [300, 1]);
  assert.equal(mock.tokens(), 1);
  assert.deepEqual(result.map(row => row.productOrderId), ids);
  assert.deepEqual(result[0], { productOrderId: ids[0], orderId: '000000000000000099', status: 'DELIVERING',
    placeOrderStatus: 'OK', remainQuantity: 1, trackingNumber: '001234567890', deliveryCompanyCode: 'KGB',
    deliveryMethod: 'DELIVERY', deliveryStatus: 'COLLECT_REQUEST', isWrongTrackingNumber: false,
    recipient: '테스트 수취인', phone: '010-0000-0000', address: '테스트시 테스트구',
    detailAddress: '테스트 상세', claimStatus: '' });
  assert.ok(mock.requests.every(row => !/\/(dispatch|confirm|cancel)(\/|$)/.test(row.path)));
});

test('송장 조회의 잘못된 입력은 외부 호출 전에 거부한다', async () => {
  const mock = fixture(() => assert.fail('호출하면 안 됩니다.'));
  for (const input of [[], [123], [''], [' a'], ['a', 'a'], Array(10001).fill('a')]) {
    await assert.rejects(mock.client.queryProductOrders(input), /상품주문번호/);
  }
  assert.equal(mock.requests.length, 0);
});

test('누락·중복·다른 주문·숫자형 송장·잔여수량 누락 응답은 완료 결과로 반환하지 않는다', async () => {
  const id = '000000000000000001';
  for (const data of [[], [detail(id), detail(id)], [detail('다른 주문')],
    [detail(id, { delivery: { trackingNumber: 123 } })],
    [detail(id, { productOrder: { productOrderId: id, productOrderStatus: 'DELIVERING' } })]]) {
    const mock = fixture(() => reply(200, { data }));
    await assert.rejects(mock.client.queryProductOrders([id]));
  }
});

test('조회 401은 토큰을 한 번 갱신하며 다른 HTTP 오류에 개인정보를 노출하지 않는다', async () => {
  const mock = fixture((ids, count) => count === 1 ? reply(401, {}) : reply(200, { data: ids.map(id => detail(id)) }));
  await mock.client.queryProductOrders(['id']);
  assert.equal(mock.tokens(), 2);
  assert.equal(mock.queries(), 2);
  const failed = fixture(() => reply(403, { message: '고객 비밀 mock-token-private' }));
  await assert.rejects(failed.client.queryProductOrders(['id']), error => /HTTP 403/.test(error.message)
    && !/고객|private/.test(error.message));
});

test('두 번째 조회 묶음 실패 시 앞 묶음의 일부 결과를 성공으로 돌려주지 않는다', async () => {
  const ids = Array.from({ length: 301 }, (_, index) => String(index));
  const mock = fixture((input, count) => count === 1 ? reply(200, { data: input.map(id => detail(id)) }) : reply(500, {}));
  await assert.rejects(mock.client.queryProductOrders(ids), /HTTP 500/);
  assert.equal(mock.queries(), 4);
});
