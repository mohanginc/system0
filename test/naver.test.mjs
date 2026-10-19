import test from 'node:test';
import assert from 'node:assert/strict';
import { createNaverClient } from '../lib/naver.mjs';

const dayMs = 86400000, end = Date.parse('2026-10-17T04:05:06.789Z');
const response = (status, body) => new Response(JSON.stringify(body), { status,
  headers: { 'Content-Type': 'application/json' } });
const page = (contents = [], hasNext = false) => ({ data: { contents, pagination: { hasNext } } });
function item(productOrderId = '202610170000000001', changes = {}, orderId = '202610170000000099') {
  return { productOrderId, content: { order: { orderId }, productOrder: {
    productOrderId, productOrderStatus: 'PAYED', placeOrderStatus: 'NOT_YET',
    productName: '모의 원본 상품', productOption: '면100수 새싹', quantity: 5, remainQuantity: 2,
    shippingAddress: { name: '모의 수취인', tel1: '010-0000-0000', tel2: '02-000-0000',
      baseAddress: '모의시 모의구 도로 10', detailedAddress: '비공개 상세 101동 202호' }, ...changes,
  } } };
}
function fixture(orderReply = () => response(200, page()), tokenReply) {
  let time = end, tokenCount = 0, orderCount = 0;
  const requests = [], waits = [];
  const client = createNaverClient({ clientId: 'mock-client-id', clientSecret: '$2b$04$abcdefghijklmnopqrstuu',
    now: () => time, wait: async delay => { waits.push(delay); time += delay; },
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      requests.push({ url: parsed, options });
      assert.equal(parsed.origin, 'https://api.commerce.naver.com');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      if (parsed.pathname === '/external/v1/oauth2/token') {
        assert.equal(options.method, 'POST');
        assert.equal(options.body.get('client_id'), 'mock-client-id');
        assert.equal(options.body.get('grant_type'), 'client_credentials');
        assert.equal(options.body.get('type'), 'SELF');
        tokenCount++;
        return tokenReply ? tokenReply(tokenCount) : response(200, { access_token: `mock-token-${tokenCount}`, expires_in: 3600 });
      }
      assert.equal(parsed.pathname, '/external/v1/pay-order/seller/product-orders');
      assert.equal(options.method, 'GET', '주문 리소스는 조회만 허용합니다.');
      orderCount++;
      return orderReply(parsed, options, orderCount);
    },
  });
  return { client, requests, waits, tokenCount: () => tokenCount, orderCount: () => orderCount };
}

test('최근 7일을 24시간씩 끝 페이지까지 조회하며 주문은 GET만 호출하고 긴 ID·상품행·잔여 수량을 보존한다', async () => {
  const firstFrom = new Date(end - 7 * dayMs).toISOString();
  const a = '202610170000000001', b = '202610170000000002', c = '202610170000000003';
  const mock = fixture(url => {
    const query = url.searchParams;
    for (const [key, value] of Object.entries({ rangeType: 'PAYED_DATETIME', productOrderStatuses: 'PAYED',
      placeOrderStatusType: 'NOT_YET', quantityClaimCompatibility: 'true', pageSize: '300' })) assert.equal(query.get(key), value);
    if (query.get('from') !== firstFrom) return response(200, page());
    if (query.get('page') === '1') return response(200, page([
      item(a), item(b, { remainQuantity: 3 }), item('202610170000000004', { remainQuantity: 0 }),
      item('202610170000000005', { productOrderStatus: 'CANCELED' }),
      item('202610170000000006', { placeOrderStatus: 'OK' }),
    ], true));
    return response(200, page([item(a, { remainQuantity: 1 }), item(c)]));
  });
  const result = await mock.client.listNewOrders();
  assert.equal(result.from, firstFrom);
  assert.equal(result.to, new Date(end).toISOString());
  const reads = mock.requests.filter(request => request.options.method === 'GET');
  assert.equal(reads.length, 8);
  const ranges = new Map();
  for (const { url } of reads) {
    const from = Date.parse(url.searchParams.get('from')), to = Date.parse(url.searchParams.get('to'));
    assert.equal(to - from, dayMs);
    if (!ranges.has(from)) ranges.set(from, []);
    ranges.get(from).push(Number(url.searchParams.get('page')));
  }
  assert.deepEqual([...ranges.keys()], Array.from({ length: 7 }, (_, index) => end - (7 - index) * dayMs));
  assert.deepEqual([...ranges.values()], [[1, 2], [1], [1], [1], [1], [1], [1]]);
  assert.deepEqual(result.orders.map(row => [row.productOrderId, row.orderId, row.quantity]),
    [[a, '202610170000000099', 1], [b, '202610170000000099', 3], [c, '202610170000000099', 2]]);
  assert.ok(result.orders.every(row => typeof row.productOrderId === 'string' && typeof row.orderId === 'string'));
  assert.equal(result.orders[0].originalName, '모의 원본 상품');
  assert.equal(result.orders[0].optionName, '면100수 새싹');
  assert.equal(result.orders[0].phone, '010-0000-0000');
  assert.equal(result.orders[0].address, '모의시 모의구 도로 10');
  assert.ok(result.orders.every(row => !JSON.stringify(row).includes('비공개 상세')));
  assert.equal(mock.tokenCount(), 1);
  assert.ok(mock.waits.filter(delay => delay === 350).length >= 8);
});

test('문자형 전화 대체와 0 잔여 수량 제외를 처리하며 빈 조회 결과도 7일 조회를 완료한다', async () => {
  const mock = fixture((url, options, count) => response(200, page(count === 1 ? [
    item('000000000000000001', { remainQuantity: 0 }),
    item('000000000000000002', { remainQuantity: 1, shippingAddress: { name: '모의', tel1: '', tel2: '02-000-0000' } }),
  ] : [])));
  const result = await mock.client.listNewOrders();
  assert.equal(mock.orderCount(), 7);
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].productOrderId, '000000000000000002');
  assert.equal(result.orders[0].quantity, 1);
  assert.equal(result.orders[0].phone, '02-000-0000');
  const empty = fixture();
  assert.deepEqual((await empty.client.listNewOrders()).orders, []);
  assert.equal(empty.orderCount(), 7);
});

test('중복 상품주문의 나중 응답이 0 수량·취소·확인 상태라면 앞서 수집한 항목도 제외한다', async () => {
  const counts = [];
  for (const changes of [{ remainQuantity: 0 }, { productOrderStatus: 'CANCELED' }, { placeOrderStatus: 'OK' }]) {
    const mock = fixture((url, options, count) => response(200,
      count === 1 ? page([item()], true) : count === 2 ? page([item(undefined, changes)]) : page()));
    counts.push((await mock.client.listNewOrders()).orders.length);
  }
  assert.deepEqual(counts, [0, 0, 0]);
});

test('숫자형 ID·불일치 ID·누락된 상태·잘못된 잔여 수량은 손실을 숨기지 않고 실패한다', async () => {
  const invalid = [
    item(202610170000000001),
    item('202610170000000001', {}, 12345),
    { ...item(), productOrderId: '202610170000000002' },
    item('202610170000000001', { productOrderId: 12345 }),
    item('202610170000000001', { productOrderStatus: '' }),
    item('202610170000000001', { placeOrderStatus: null }),
    item('202610170000000001', { productName: ' ' }),
    ...[-1, 1.5, '2', undefined, null, Number.MAX_SAFE_INTEGER + 1].map(remainQuantity => item(undefined, { remainQuantity })),
  ];
  for (const row of invalid) {
    const mock = fixture(() => response(200, page([row])));
    await assert.rejects(mock.client.listNewOrders(), /네이버 .*확인/);
    assert.equal(mock.orderCount(), 1);
  }
});

test('페이지 형식 오류와 계속되는 빈 페이지는 완료 결과로 오인하지 않는다', async () => {
  for (const body of [{}, { data: { contents: [], pagination: {} } },
    { data: { contents: {}, pagination: { hasNext: false } } },
    { data: { contents: [], pagination: { hasNext: 'true' } } }, page([], true)]) {
    const mock = fixture(() => response(200, body));
    await assert.rejects(mock.client.listNewOrders(), /주문 목록·페이지/);
    assert.equal(mock.orderCount(), 1);
  }
});

test('페이지가 끝나지 않으면 1000페이지 제한에서 실패하여 불완전 결과를 돌려주지 않는다', async () => {
  const mock = fixture(() => response(200, page([item()], true)));
  await assert.rejects(mock.client.listNewOrders(), /페이지가 너무 많아/);
  assert.equal(mock.orderCount(), 1000);
});

test('조회 429·500은 최대 2번 제한 재시도하고 성공한 이후 나머지 기간을 조회한다', async () => {
  const mock = fixture((url, options, count) => response(count === 1 ? 429 : count === 2 ? 500 : 200,
    count <= 2 ? { message: '노출 금지 원문' } : page()));
  assert.deepEqual((await mock.client.listNewOrders()).orders, []);
  assert.equal(mock.orderCount(), 9);
  assert.deepEqual(mock.waits.filter(delay => delay >= 1000), [1000, 2000]);
  assert.equal(mock.tokenCount(), 1);
  assert.equal(mock.requests[1].url.href, mock.requests[2].url.href);
  assert.equal(mock.requests[2].url.href, mock.requests[3].url.href);
  for (const status of [429, 500]) {
    const failed = fixture(() => response(status, { message: '노출 금지 원문' }));
    await assert.rejects(failed.client.listNewOrders(), new RegExp(`HTTP ${status}`));
    assert.equal(failed.orderCount(), 3);
    assert.deepEqual(failed.waits.filter(delay => delay >= 1000), [1000, 2000]);
  }
});

test('401이면 토큰을 한 번 새로 받고 재시도하되 두 번째 401은 종료한다', async () => {
  const mock = fixture((url, options, count) => response(count === 1 ? 401 : 200,
    count === 1 ? { message: '토큰 노출 금지' } : page()));
  await mock.client.listNewOrders();
  assert.equal(mock.tokenCount(), 2);
  const reads = mock.requests.filter(request => request.options.method === 'GET');
  assert.equal(reads[0].options.headers.Authorization, 'Bearer mock-token-1');
  assert.ok(reads.slice(1).every(request => request.options.headers.Authorization === 'Bearer mock-token-2'));
  assert.equal(reads[0].url.href, reads[1].url.href);
  const failed = fixture(() => response(401, { message: '토큰 노출 금지' }));
  await assert.rejects(failed.client.listNewOrders(), /HTTP 401/);
  assert.equal(failed.tokenCount(), 2);
  assert.equal(failed.orderCount(), 2);
});

test('HTTP·네트워크·응답 오류에 원문 개인정보나 토큰을 넣지 않는다', async () => {
  const secret = 'MOCK_PRIVATE_RECIPIENT_PHONE_ADDRESS_TOKEN';
  const cases = [
    fixture(() => response(403, { message: secret, customer: secret })),
    fixture(() => { throw new Error(secret); }),
    fixture(() => new Response(secret, { status: 200 })),
    fixture(() => response(200, { data: { contents: secret, pagination: { hasNext: false } } })),
    fixture(undefined, () => response(400, { access_token: secret, message: secret })),
    fixture(undefined, () => response(200, { access_token: '', detail: secret })),
  ];
  for (const mock of cases) {
    await assert.rejects(mock.client.listNewOrders(), error => {
      assert.ok(error.message.startsWith('네이버') || error.message.startsWith('신규 주문'));
      for (const value of [secret, 'mock-token-1', 'Bearer', '모의 수취인', '010-0000-0000', '101동']) assert.ok(!error.message.includes(value));
      return true;
    });
  }
});

test('설정을 명시적으로 비우거나 잘못된 시크릿을 주면 외부 호출 없이 안내한다', async () => {
  for (const settings of [{ clientId: '', clientSecret: '' }, { clientId: 'mock', clientSecret: 'invalid' }]) {
    let count = 0;
    const client = createNaverClient({ ...settings, now: () => end, wait: async () => {},
      fetchImpl: async () => { count++; throw new Error('호출되면 안 됩니다.'); } });
    await assert.rejects(client.listNewOrders(), /네이버 API/);
    assert.equal(count, 0);
  }
});
