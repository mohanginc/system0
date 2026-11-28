import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { createApp } from '../server.mjs';

const workDate = '2026-11-27', otherDate = '2026-11-28';
const paidAt = '2026-11-26T03:00:00.000Z';
const originalAddress = { name: 'Olivia Kim', tel1: '010-1234-5101', baseAddress: '서울 강남구 가상로 11',
  detailedAddress: '101호', zipCode: '01234' };
const editedShipping = { recipient: 'Olivia Park', phone: '010-1234-5102', baseAddress: '서울 서초구 가상로 12',
  detailedAddress: '202호', postalCode: '02345', memo: '경비실에 맡겨 주세요' };
const route = '/api/order-intake';
const packingRoute = route + '/packing';
const json = (method, value) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });

function naverOrder(suffix, quantity = 1, { address = originalAddress, memo = '기존 배송 메모', price = 10000 } = {}) {
  const orderId = `2026112710000${suffix}`;
  return { orderId, productOrderId: `2026112720000${suffix}`, status: 'PAYED', placeOrderStatus: 'NOT_YET',
    productName: `가상 상품 ${suffix}`, orderedAt: paidAt, paidAt, quantity, financial: { orderedQuantity: quantity, paymentAmount: price * quantity },
    sourcePayload: { content: { order: { orderId, paymentDate: paidAt }, productOrder: { shippingAddress: address,
      shippingMemo: memo, remainQuantity: quantity, remainProductAmount: price * quantity } } } };
}

function coupangFile(date) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['주문번호', '묶음배송번호', '옵션ID', '등록상품명', '구매수(수량)', '수취인이름', '수취인주소', '수취인전화번호',
      '운송장번호', '출고일(발송일)', '주문일', '결제액'],
    ['21112700001', '21112700002', '21112700003', '가상 커버', 1, 'Oliver', '서울 중구 가상길 1', '010-1234-5110',
      '', '', '2026-11-26', 20000],
  ]), '쿠팡 주문');
  const form = new FormData();
  form.set('file', new Blob([XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })]), '가상 쿠팡 주문.xlsx');
  form.set('workDate', date);
  return { method: 'POST', body: form };
}

async function setup(t, naver) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(workDate + 'T03:00:00.000Z') });
  const app = createApp({ databasePath: ':memory:', naver, client: null, apiKey: '', discordConfig: null });
  const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const db = app.locals.db;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const fetchRoute = (path, options) => fetch(base + path, options);
  const request = async (path, options, status = 200) => {
    const response = await fetchRoute(path, options);
    assert.equal(response.status, status, response.ok ? undefined : await response.clone().text());
    return response.json();
  };
  const management = (filters = {}, status) => request(route + '?' + new URLSearchParams({ view: 'management', ...filters }), undefined, status);
  const collect = (date, status) => request(route + '/collect', json('POST', date === undefined ? {} : { workDate: date }), status);
  return { db, request, fetchRoute, collect, management };
}

test('작업일로 네이버와 쿠팡 주문을 검색하며 재수집은 기존 작업일을 바꾸지 않는다', async t => {
  const original = naverOrder(1), fresh = naverOrder(2);
  let orders = [original], details = [], naverCalls = 0;
  const { db, request, collect, management } = await setup(t, {
    listNewOrders: async () => { naverCalls++; return { orders }; },
    queryProductOrders: async () => details,
  });
  const empty = await management({ workDate });
  assert.deepEqual(empty.orders, []);
  await collect('2026-11-31', 400);
  assert.equal(naverCalls, 0);

  await collect(workDate);
  await request(route + '/coupang', coupangFile(workDate));
  orders = [original, fresh];
  await collect(otherDate);
  await request(route + '/coupang', coupangFile(otherDate));

  const found = await management({ workDate, recipient: '  olIv  ' });
  assert.deepEqual(found.orders.map(order => [order.provider, order.workDate, order.recipient]).sort(),
    [['coupang', workDate, 'Oliver'], ['naver', workDate, 'Olivia Kim']]);
  assert.equal(found.orders.find(order => order.provider === 'naver').paidAt, paidAt);
  assert.equal((await management({ workDate: otherDate, recipient: 'OLIVIA' })).orders[0].productOrderId, fresh.productOrderId);
  assert.deepEqual((await management({ workDate: otherDate, recipient: 'Oliver' })).orders, []);
  await management({ workDate: '2026-11-31' }, 400);
  assert.ok((await request(route)).orders.every(order => !order.shipping));

  const defaultDated = naverOrder(3);
  orders = [original, fresh, defaultDated];
  await collect();
  assert.ok((await management({ workDate })).orders.some(order => order.productOrderId === defaultDated.productOrderId));

  db.prepare('UPDATE order_intake_items SET work_date = NULL WHERE product_order_id = ?').run(original.productOrderId);
  orders = [fresh, defaultDated];
  details = [{ ...original, status: 'CANCELED', quantity: 0 }];
  await collect(otherDate);
  const canceled = (await management({ workDate })).orders.find(order => order.productOrderId === original.productOrderId);
  assert.equal(canceled.canceled, true);
  assert.equal(canceled.dispatchHeld, false);
  assert.equal(canceled.canEditDelivery, false);
  assert.ok(!(await request(route)).orders.some(order => order.id === canceled.id));
});

test('배송정보 변경과 보류가 포장과 로젠 출력에 반영되고 출고 등록 주문과 원본은 보존된다', async t => {
  const initialOrder = naverOrder(4, 2), sibling = naverOrder(5);
  let orders = [initialOrder, sibling];
  const { db, request, fetchRoute, collect, management } = await setup(t, { listNewOrders: async () => ({ orders }) });
  await collect(workDate);
  const readEdited = async () => (await management({ workDate })).orders.find(order => order.productOrderId === initialOrder.productOrderId);
  const beforeEdit = await readEdited();
  const { id } = beforeEdit;
  const siblingId = (await management({ workDate })).orders.find(order => order.productOrderId === sibling.productOrderId).id;
  const snapshot = db.prepare('SELECT * FROM order_intake_snapshots WHERE item_id = ? ORDER BY id');
  const [original] = snapshot.all(id);
  const save = (expected, changes, status) => request(route + '/orders/' + id + '/delivery', json('PATCH', { expected, ...changes }), status);
  const setPacking = (packing, removeBoxIds, boxes = []) => request(packingRoute, json('PATCH', {
    expectedVersion: packing.version, removeBoxIds, boxes,
  }));
  const dispatch = (packing, boxIds, orderItemIds, status) => request(route + '/dispatch', json('POST', {
    expectedVersion: packing.version, boxIds, orderItemIds,
  }), status);

  const packed = await setPacking(await request(packingRoute), [], [{ items: [
    { orderItemId: id, quantity: 1 }, { orderItemId: siblingId, quantity: 1 },
  ] }]);
  t.mock.timers.tick(1000);
  await save(beforeEdit.reviewVersion, { shipping: editedShipping });
  assert.deepEqual((await readEdited()).shipping, editedShipping);
  assert.deepEqual(snapshot.all(id)[0], original);
  assert.equal((await management({ workDate, recipient: 'Park' })).orders[0].id, id);
  await save(beforeEdit.reviewVersion, { shipping: { ...editedShipping, recipient: '다른 이름' } }, 409);
  const reviewPacking = await request(packingRoute);
  assert.notEqual(reviewPacking.version, packed.version);
  assert.equal(reviewPacking.boxes[0].needsReview, true);
  await dispatch(reviewPacking, [packed.boxes[0].id], [], 400);
  await setPacking(reviewPacking, [packed.boxes[0].id]);

  await save((await readEdited()).reviewVersion, { dispatchHeld: true });
  assert.equal((await readEdited()).dispatchHeld, true);
  await dispatch(await request(packingRoute), [], [id], 409);
  const sellerUpdate = { ...originalAddress, baseAddress: '서울 강남구 가상로 22' };
  orders = [naverOrder(4, 2, { address: sellerUpdate, memo: '판매채널 주소 메모', price: 12000 }), sibling];
  t.mock.timers.tick(1000);
  await collect(otherDate);
  const held = await readEdited();
  assert.equal(held.dispatchHeld, true);
  assert.equal(held.status, 'PAYED');
  assert.equal(held.financial.paymentAmount, 24000);
  assert.deepEqual(held.shipping, editedShipping);
  assert.ok(snapshot.all(id).some(row => JSON.parse(row.source_json).content?.productOrder?.shippingAddress?.baseAddress === sellerUpdate.baseAddress));

  await save(held.reviewVersion, { dispatchHeld: false });
  const split = await setPacking(await request(packingRoute), [], [{ items: [{ orderItemId: id, quantity: 1 }] }]);
  const partial = await dispatch(split, [split.boxes[0].id], []);
  assert.equal(partial.date, workDate);
  const partiallyRegistered = await readEdited();
  assert.deepEqual([partiallyRegistered.registeredQuantity, partiallyRegistered.quantity], [1, 1]);
  assert.equal(partiallyRegistered.canEditDelivery, false);
  await save(partiallyRegistered.reviewVersion, { shipping: editedShipping }, 409);

  const finalDispatch = await dispatch(await request(packingRoute), [], [id]);
  const registered = await readEdited();
  assert.deepEqual([registered.registeredQuantity, registered.quantity, registered.canEditDelivery], [2, 0, false]);
  assert.ok(!(await request(route)).orders.some(order => order.id === id));
  await dispatch(await request(packingRoute), [], [id], 409);

  const exportResponse = await fetchRoute('/api/shipping/logen-export?date=' + finalDispatch.date);
  assert.equal(exportResponse.status, 200);
  const book = XLSX.read(Buffer.from(await exportResponse.arrayBuffer()), { type: 'buffer' });
  const [header, ...rows] = XLSX.utils.sheet_to_json(book.Sheets.rus00, { header: 1, raw: true });
  assert.deepEqual(header.slice(0, 8), ['송화주', '핸드폰', '전화번호', '주소', '선착불', '원상품명', '비고', '우편번호']);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.deepEqual([row[0], row[2], row[3], row[6], row[7]], [editedShipping.recipient, editedShipping.phone,
      `${editedShipping.baseAddress} ${editedShipping.detailedAddress}`, editedShipping.memo, editedShipping.postalCode]);
    assert.equal(row[11], '12000');
  }
  assert.deepEqual(snapshot.all(id)[0], original);
  assert.ok(db.prepare('SELECT count(*) AS n FROM order_intake_reviews WHERE item_id = ?').get(id).n >= 1);
});

test('주문 관리에서 등록한 합배송·분리배송 상자와 배송지 이력을 다시 볼 수 있다', async t => {
  const combined = [naverOrder(6), naverOrder(7)], split = naverOrder(8, 4);
  let orders = [...combined, split];
  const { request, collect, management } = await setup(t, { listNewOrders: async () => ({ orders }) });
  await collect(workDate);
  const initial = await request(packingRoute);
  const byProduct = new Map(initial.orders.map(order => [order.productOrderId, order.id]));
  const member = product => ({ orderItemId: byProduct.get(product.productOrderId), quantity: 1 });
  const packed = await request(packingRoute, json('PATCH', { expectedVersion: initial.version, removeBoxIds: [], boxes: [
    { items: combined.map(member) }, ...Array.from({ length: 3 }, () => ({ items: [member(split)] })),
  ] }));
  const [shared, first, second, active] = packed.boxes;
  const delivery = (id, version, shipping, status) => request(`${packingRoute}/boxes/${id}/delivery`,
    json('PATCH', { expectedVersion: version, shipping }), status);
  const changed = await delivery(second.id, packed.version, editedShipping);
  t.mock.timers.tick(1000);
  await request(route + '/dispatch', json('POST', { expectedVersion: changed.version,
    boxIds: [second.id, shared.id, first.id], orderItemIds: [] }));

  const expectedDefault = { recipient: originalAddress.name, phone: originalAddress.tel1, baseAddress: originalAddress.baseAddress,
    detailedAddress: originalAddress.detailedAddress, postalCode: originalAddress.zipCode, memo: '기존 배송 메모' };
  const view = await management({ workDate });
  assert.deepEqual((await management({ workDate: otherDate })).dispatchBoxes, []);
  const registered = new Map(view.dispatchBoxes.map(box => [box.packingBoxId, box]));
  assert.equal(registered.size, 3);
  assert.deepEqual(registered.get(shared.id).items.sort((a, b) => a.orderItemId - b.orderItemId),
    combined.map(member).sort((a, b) => a.orderItemId - b.orderItemId));
  assert.deepEqual(registered.get(shared.id).shipping, expectedDefault);
  assert.deepEqual(registered.get(first.id).items, [member(split)]);
  assert.deepEqual(registered.get(first.id).shipping, expectedDefault);
  assert.deepEqual(registered.get(second.id).items, [member(split)]);
  assert.deepEqual(registered.get(second.id).shipping, editedShipping);
  assert.equal(registered.get(second.id).hasDeliveryOverride, true);

  const remaining = view.orders.find(order => order.productOrderId === split.productOrderId);
  assert.deepEqual([remaining.registeredQuantity, remaining.quantity], [2, 2]);
  const current = await request(packingRoute);
  assert.deepEqual(current.boxes.map(box => box.id), [active.id]);
  const remainingPacking = current.orders.find(order => order.id === remaining.id);
  assert.deepEqual([remainingPacking.allocatedQuantity, remainingPacking.availableQuantity], [1, 1]);
  await delivery(second.id, current.version, { phone: '010-0000-0009' }, 404);
  const revised = await delivery(active.id, current.version, { phone: '010-0000-0009' });
  assert.equal(revised.boxes[0].shipping.phone, '010-0000-0009');

  const refreshedAddress = { ...originalAddress, baseAddress: '서울 중구 바뀐길 9' };
  orders = [...combined, naverOrder(8, 4, { address: refreshedAddress, memo: '새 배송 메모' })];
  t.mock.timers.tick(1000);
  await collect(workDate);
  const reloaded = await management({ workDate });
  assert.deepEqual(reloaded.dispatchBoxes, view.dispatchBoxes);
  assert.equal(reloaded.orders.find(order => order.productOrderId === split.productOrderId).shipping.baseAddress, refreshedAddress.baseAddress);
});

test('수동 취소와 해제가 출고보드·로젠에 반영되고 네이버의 취소·보류 이력은 유지된다', async t => {
  const single = naverOrder(21, 1, { address: { ...originalAddress, name: '가상 단독' } });
  const combined = [naverOrder(22), naverOrder(23)];
  const safe = naverOrder(24, 1, { address: { ...originalAddress, name: '가상 정상' } });
  const products = [single, ...combined, safe];
  let channelChecks = 0;
  const { db, request, fetchRoute, collect, management } = await setup(t, {
    listNewOrders: async () => ({ orders: products }),
    queryProductOrders: async ids => {
      channelChecks++;
      assert.deepEqual(ids.slice().sort(), products.map(product => product.productOrderId).sort());
      return products.map(product => ({ productOrderId: product.productOrderId, orderId: product.orderId,
        status: product === single ? 'CANCELED' : 'PAYED', remainQuantity: product === single ? 0 : 1,
        claimStatus: product === single ? 'CANCEL_DONE' : product === combined[0] ? 'CANCEL_REQUEST' : '' }));
    },
  });
  await collect(workDate);
  await request(route + '/coupang', coupangFile(workDate));
  const initial = await request(packingRoute);
  const id = product => initial.orders.find(order => order.productOrderId === product.productOrderId).id;
  const coupang = initial.orders.find(order => order.provider === 'coupang');
  const managed = async product => (await management({ workDate })).orders.find(order => order.id === (product.id ?? id(product)));
  const toggle = (order, canceled, status) => request(`${route}/orders/${order.id}/cancellation`,
    json('PATCH', { expected: order.reviewVersion, canceled }), status);
  const packed = await request(packingRoute, json('PATCH', { expectedVersion: initial.version, removeBoxIds: [],
    boxes: [{ items: combined.map(product => ({ orderItemId: id(product), quantity: 1 })) }] }));
  const { date } = await request(route + '/dispatch', json('POST', { expectedVersion: packed.version,
    boxIds: [packed.boxes[0].id], orderItemIds: [id(single), id(safe), coupang.id] }));
  const board = () => request('/api/shipping/board?date=' + date);
  const shippedNames = async () => {
    const response = await fetchRoute('/api/shipping/logen-export?date=' + date);
    assert.equal(response.status, 200);
    const book = XLSX.read(Buffer.from(await response.arrayBuffer()), { type: 'buffer' });
    const [, ...rows] = XLSX.utils.sheet_to_json(book.Sheets.rus00, { header: 1, raw: true });
    return rows.map(row => row[0]).sort();
  };
  const snapshot = () => ['order_dispatch_boxes', 'order_dispatch_items', 'order_intake_snapshots']
    .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all());
  const before = snapshot();
  assert.equal((await board()).registered.boxCount, 4);
  assert.deepEqual(await shippedNames(), ['Oliver', originalAddress.name, '가상 단독', '가상 정상']);

  const priorSingle = await managed(single);
  assert.equal(priorSingle.canManuallyCancel, true);
  const canceledSingle = (await toggle(priorSingle, true)).order;
  assert.equal(canceledSingle.manuallyCanceled, true);
  await toggle(priorSingle, false, 409);
  const canceledShared = (await toggle(await managed(combined[0]), true)).order;
  assert.equal(canceledShared.manuallyCanceled, true);
  assert.equal((await managed(combined[1])).manuallyCanceled, false);
  const states = data => Object.fromEntries(data.registered.groups.flatMap(group => group.shipments)
    .map(row => [row.recipient, row.dispatchState]));
  const after = await board();
  assert.deepEqual([after.registered.totalBoxCount, after.registered.boxCount, after.registered.canceledBoxCount, after.registered.heldBoxCount], [4, 2, 1, 1]);
  assert.deepEqual(states(after), { [originalAddress.name]: 'hold', '가상 단독': 'canceled', '가상 정상': 'ready', Oliver: 'ready' });
  assert.deepEqual(await shippedNames(), ['Oliver', '가상 정상']);

  const restored = (await toggle(canceledSingle, false)).order;
  assert.equal(restored.manuallyCanceled, false);
  assert.equal(states(await board())['가상 단독'], 'ready');
  assert.deepEqual(await shippedNames(), ['Oliver', '가상 단독', '가상 정상']);
  await toggle(restored, true);
  assert.equal(channelChecks, 0);

  await request('/api/shipping/cancellations/check', json('POST', { date }));
  assert.equal(channelChecks, 1);
  for (const product of [single, combined[0]]) {
    assert.equal((await toggle(await managed(product), false)).order.manuallyCanceled, false);
  }
  assert.deepEqual(states(await board()), states(after));
  assert.deepEqual(await shippedNames(), ['Oliver', '가상 정상']);

  const { order: canceledCoupang } = await toggle(await managed(coupang), true);
  assert.equal(states(await board()).Oliver, 'canceled');
  assert.deepEqual(await shippedNames(), ['가상 정상']);
  await toggle(canceledCoupang, false);
  assert.equal(states(await board()).Oliver, 'ready');
  assert.equal(channelChecks, 1);
  assert.deepEqual(snapshot(), before);
});

test('출고 전 수동 취소는 등록을 막고 취소 해제는 기존 보류를 유지한다', async t => {
  const product = naverOrder(25);
  const { request, collect, management } = await setup(t, { listNewOrders: async () => ({ orders: [product] }) });
  await collect(workDate);
  const [order] = (await management({ workDate })).orders;
  const orderPath = `${route}/orders/${order.id}`;
  await request(orderPath + '/delivery', json('PATCH', { expected: order.reviewVersion, dispatchHeld: true }));
  const [held] = (await management({ workDate })).orders;
  const toggle = (current, canceled) => request(orderPath + '/cancellation',
    json('PATCH', { expected: current.reviewVersion, canceled }));
  const { order: canceled } = await toggle(held, true);
  assert.equal(canceled.manuallyCanceled, true);
  const { order: restored } = await toggle(canceled, false);
  assert.equal(restored.manuallyCanceled, false);
  assert.equal(restored.dispatchHeld, true);
  const dispatch = async status => {
    const packing = await request(packingRoute);
    return request(route + '/dispatch', json('POST', { expectedVersion: packing.version, boxIds: [], orderItemIds: [order.id] }), status);
  };
  await dispatch(409);

  await request(orderPath + '/delivery', json('PATCH', { expected: restored.reviewVersion, dispatchHeld: false }));
  const [active] = (await management({ workDate })).orders;
  const { order: suspended } = await toggle(active, true);
  await dispatch(409);
  await toggle(suspended, false);
  assert.equal((await dispatch()).registeredQuantity, 1);
});
