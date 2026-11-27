import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';

const barcode = '8809538930160';

async function boot(t, naver) {
  const app = createApp({ databasePath: ':memory:', client: null, apiKey: '', discordConfig: null, naver });
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    app.locals.db.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return (path, method, data) => fetch(origin + path, {
    method, ...(data && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
  });
}

test('바코드별 단위 원가를 적용일 기준으로 조회하고 이전 등록을 보존한다', async t => {
  const request = await boot(t);
  const route = `/api/products/${barcode}/costs`;
  const register = (effectiveDate, unitCostKrw) => request(route, 'POST', { effectiveDate, unitCostKrw });
  const catalogProduct = async () => {
    const data = await (await request('/api/products')).json();
    return data.products.find(item => item.barcode === barcode);
  };

  assert.equal((await catalogProduct()).unitCostKrw, null);
  assert.equal((await register('2026-02-29', 100)).status, 400);
  assert.equal((await register('2025-01-01', -1)).status, 400);
  assert.equal((await register('2025-01-01', 1.5)).status, 400);
  assert.equal((await register('2025-01-01', '1')).status, 400);
  assert.equal((await register('2025-01-01', null)).status, 400);
  const original = await register('2025-01-01', 1700);
  assert.equal(original.status, 201);
  const originalCost = (await original.json()).cost;
  assert.deepEqual((await (await register('2025-01-01', 1700)).json()).cost, originalCost);
  assert.equal((await register('2025-01-01', 1900)).status, 400);
  assert.equal((await register('2025-02-01', 0)).status, 201);
  assert.equal((await register('2999-01-01', 2100)).status, 201);

  const product = await catalogProduct();
  assert.equal(product.costEffectiveDate, '2025-02-01');
  assert.equal(product.unitCostKrw, 0);
  const response = await request(route);
  assert.equal(response.status, 200);
  const { costs, product: historyProduct, today } = await response.json();
  assert.equal(historyProduct.barcode, barcode);
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(costs.map(cost => [cost.effectiveDate, cost.unitCostKrw]), [
    ['2999-01-01', 2100], ['2025-02-01', 0], ['2025-01-01', 1700],
  ]);
});

test('수집 주문을 상품 관리에서 연결하면 결제일 원가를 보존하고 새 주문에는 새 원가를 적용한다', async t => {
  const name = '원가 테스트 가상 상품';
  const sample = { productOrderId: 'item-1', orderId: 'order-1', productName: name, quantity: 2,
    paidAt: '2026-06-30T15:10:00Z', financial: { paymentAmount: 50000 } };
  const orders = [sample];
  const request = await boot(t, { listNewOrders: async () => ({ orders }) });
  const intakeApi = '/api/order-intake';
  const get = async path => (await request(path)).json();
  const collect = async () => {
    const response = await request(intakeApi + '/collect', 'POST', {});
    assert.equal(response.status, 200);
    return response.json();
  };
  const addCost = (effectiveDate, unitCostKrw) => request(`/api/products/${barcode}/costs`, 'POST', { effectiveDate, unitCostKrw });
  const saveName = order => request(`${intakeApi}/orders/${order.id}`, 'PATCH', { cleanedName: name, expected: order.reviewVersion });

  assert.equal((await addCost('2026-06-30', 1700)).status, 201);
  const initial = (await collect()).orders[0];
  assert.equal((await saveName(initial)).status, 200);
  assert.ok((await get('/api/products')).unmatched.some(item => item.name === name));
  const linked = await request('/api/products/aliases', 'POST', { name, barcode });
  assert.equal(linked.status, 200);
  assert.equal((await linked.json()).linkedRows, 1);
  const [first] = (await get(intakeApi)).orders;
  assert.equal(first.skuBarcode, barcode);
  assert.deepEqual(first.cost, { unitCost: 1700, effectiveDate: '2026-06-30', totalCost: 3400 });

  assert.equal((await addCost('2026-07-01', 1800)).status, 201);
  orders.push({ ...sample, productOrderId: 'item-2', orderId: 'order-2' });
  const second = (await collect()).orders.find(item => item.productOrderId === 'item-2');
  assert.equal((await saveName(second)).status, 200);
  const stored = (await get(intakeApi)).orders;
  assert.deepEqual(stored.find(item => item.id === first.id).cost, first.cost);
  assert.deepEqual(stored.find(item => item.id === second.id).cost, { unitCost: 1800, effectiveDate: '2026-07-01', totalCost: 3600 });
  assert.ok(stored.every(item => item.financial.paymentAmount === 50000));
});
