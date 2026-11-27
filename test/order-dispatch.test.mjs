import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../lib/database.mjs';
import { collectOrderIntake, getOrderIntake } from '../lib/order-intake.mjs';
import { getOrderPacking, registerOrderDispatch, registeredOrderQuantities, reviseOrderPacking } from '../lib/order-packing.mjs';
import { shippingBoard, shippingDates } from '../lib/shipping.mjs';
import { reportHandlers } from '../lib/discord-report-tools.mjs';

const address = { name: '가상 수취인', tel2: '0500-0000-0001', baseAddress: '가상시 가상로 17', detailedAddress: '101호', zipCode: '01234' };
const line = (id, productName, quantity, shippingAddress = address) => ({
  productOrderId: `20261127100000${id}`, orderId: `20261127200000${id}`, status: 'PAYED', placeOrderStatus: 'NOT_YET',
  productName, optionName: '', quantity, financial: { unitPrice: 1000, paymentAmount: 1000 * quantity },
  sourcePayload: { content: { productOrder: { shippingAddress } } },
});
const item = (orderItemId, quantity = 1) => ({ orderItemId, quantity });
const collect = (db, orders) => collectOrderIntake(db, { naver: { listNewOrders: async () => ({ orders }) } });

test('출고 등록은 합포장과 미배정 잔여량을 별도 상자로 이동하고 중복 없이 보드에 보존한다', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  await collect(db, [line(1, '정상 쿠션', 3), line(2, '별칭 쿠션', 1), line(3, '가상 커버', 1), line(4, '주소 미확인', 1, null)]);
  const original = getOrderPacking(db), [first, alias, cover, missing] = original.orders.map(order => order.id);
  const name = db.prepare('UPDATE order_intake_items SET cleaned_name = ?, sku_barcode = ? WHERE id = ?');
  name.run('정상 쿠션', '8809538930146', first);
  name.run('별칭 쿠션', '8809538930146', alias);
  name.run('가상 커버', '8809538930375', cover);
  db.prepare('UPDATE order_intake_items SET provider = ? WHERE id = ?').run('kakao', alias);
  db.prepare('UPDATE order_intake_items SET provider = ? WHERE id = ?').run('새 판매채널', cover);
  const raw = db.prepare('SELECT id, quantity, order_json FROM order_intake_items ORDER BY id').all();
  const planned = reviseOrderPacking(db, { expectedVersion: getOrderPacking(db).version, removeBoxIds: [], boxes: [
    { items: [item(first), item(alias), item(cover)] }, { items: [item(first)] },
  ] });
  const [combined, split] = planned.boxes.map(box => box.id);
  const selected = { expectedVersion: planned.version, boxIds: [combined], orderItemIds: [first] };
  assert.throws(() => registerOrderDispatch(db, { ...selected, orderItemIds: [first, missing] }), /배송지를 확인/);
  assert.equal(registeredOrderQuantities(db).size, 0); assert.deepEqual(getOrderPacking(db), planned);

  const registered = registerOrderDispatch(db, selected);
  assert.deepEqual(registered, { date: shippingBoard(db).date, registeredCount: 2, registeredQuantity: 4 });
  assert.deepEqual(registeredOrderQuantities(db), new Map([[first, 2], [alias, 1], [cover, 1]]));
  const remaining = getOrderPacking(db);
  assert.deepEqual(remaining.boxes.map(box => box.id), [split]);
  assert.equal(remaining.orders.find(order => order.id === first).quantity, 1);
  assert.ok(!remaining.orders.some(order => [alias, cover].includes(order.id)));
  const intakeRow = getOrderIntake(db).orders.find(order => order.id === first);
  assert.deepEqual([intakeRow.quantity, intakeRow.sourceQuantity, intakeRow.financial.paymentAmount], [1, 3, 3000]);
  assert.throws(() => registerOrderDispatch(db, selected), { status: 409 });
  assert.throws(() => registerOrderDispatch(db, { ...selected, expectedVersion: remaining.version }), { status: 409 });
  registerOrderDispatch(db, { expectedVersion: remaining.version, boxIds: [split], orderItemIds: [] });
  assert.deepEqual(getOrderPacking(db).orders.map(order => order.id), [missing]);
  assert.deepEqual(getOrderIntake(db).orders.map(order => order.id), [missing]);
  assert.deepEqual(db.prepare('SELECT id, quantity, order_json FROM order_intake_items ORDER BY id').all(), raw);

  const board = shippingBoard(db, registered.date);
  assert.equal(board.summary.bundleCount, 3);
  assert.equal(board.summary.conflictCount, 0);
  assert.equal(board.registered.boxes[0].items.length, 3);
  const [single, mixed] = board.registered.groups;
  assert.deepEqual([single.name, single.quantity, single.boxCount], ['정상 쿠션', 2, 2]);
  assert.deepEqual([mixed.quantity, mixed.boxCount], [3, 1]);
  assert.deepEqual(mixed.components.map(({ skuBarcode, quantity }) => [skuBarcode, quantity]).sort(),
    [['8809538930146', 2], ['8809538930375', 1]]);
  assert.match(mixed.name, /정상 쿠션 ×2/);
  assert.equal(mixed.shipments[0].boxId, board.registered.boxes[0].id);
  assert.equal(mixed.shipments[0].quantity, 3);
  assert.deepEqual(mixed.shipments[0].channels, ['네이버', '카카오', '새 판매채널']);
  assert.deepEqual([mixed.shipments[0].recipient, mixed.shipments[0].phone, mixed.shipments[0].neighborhood],
    [address.name, address.tel2, '가상시']);
  assert.doesNotMatch(JSON.stringify(board.registered), /가상로|101호|01234/);
  assert.doesNotMatch(JSON.stringify(getOrderPacking(db)), /0500-0000-0001|가상로/);
  name.run('나중에 수정한 쿠션', null, first);
  assert.deepEqual(shippingBoard(db, registered.date).registered, board.registered);
  const registeredBox = board.registered.boxes[0];
  const laterSource = JSON.stringify({ productOrder: { shippingAddress: { ...address, tel1: '0500-0000-0002', baseAddress: '다른시 다른로 1' } } });
  db.prepare(`INSERT INTO order_intake_snapshots (item_id, recorded_at, source_method, source_json)
    VALUES (?, ?, 'api', ?)`).run(first, new Date(Date.parse(registeredBox.registeredAt) + 1000).toISOString(), laterSource);
  assert.deepEqual(shippingBoard(db, registered.date).registered, board.registered);
  db.prepare('UPDATE order_dispatch_boxes SET contact_phone = NULL, contact_neighborhood = NULL WHERE id = ?').run(registeredBox.id);
  assert.deepEqual(shippingBoard(db, registered.date).registered, board.registered);
  assert.deepEqual(shippingDates(db, registered.date.slice(0, 7)).days, [
    { date: registered.date, batchCount: 0, registeredCount: 3, invoiceState: 'unavailable' },
  ]);
});

test('쿠션 단품 8상자와 손수건 합포장 1상자를 표시하며 각 상자는 목록에 한 번만 나온다', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const cushion = '완전밀착 새싹(면100수) D타입 Super High(15cm)';
  const gauze = '가제손수건(대나무100%) 10장', embossed = '엠보손수건(대나무100%) 10장';
  const orders = [line(1, cushion, 1), line(2, gauze, 1), line(3, embossed, 1),
    ...Array.from({ length: 8 }, (_, index) => line(index + 10, cushion, 1))];
  await collect(db, orders);
  const initial = getOrderPacking(db);
  const setSku = db.prepare('UPDATE order_intake_items SET cleaned_name = product_name, sku_barcode = ? WHERE product_name = ?');
  setSku.run('8809538930184', cushion);
  const [mixedCushion, mixedGauze, mixedEmbossed, ...singles] = initial.orders.map(order => order.id);
  const planned = reviseOrderPacking(db, { expectedVersion: getOrderPacking(db).version, removeBoxIds: [], boxes: [
    { items: [item(mixedCushion), item(mixedGauze), item(mixedEmbossed)] },
  ] });
  const { date } = registerOrderDispatch(db, { expectedVersion: planned.version, boxIds: [planned.boxes[0].id], orderItemIds: singles });
  const board = shippingBoard(db, date);
  assert.deepEqual(board.registered.groups.map(group => [group.name, group.boxCount]), [
    [cushion, 8], [`${cushion} + ${gauze} + ${embossed}`, 1],
  ]);
  assert.equal(board.summary.bundleCount, 9);
  const ids = board.registered.groups.flatMap(group => group.shipments.map(shipment => shipment.boxId));
  assert.equal(ids.length, 9);
  assert.equal(new Set(ids).size, 9);

  const reports = reportHandlers({ api: async () => board });
  const filtered = await reports.get_shipping_board({ date, batchId: null, search: '8809538930184' });
  assert.equal(filtered.registered.quantity, 9);
  assert.deepEqual(filtered.registered.groups.map(group => group.boxCount), [8, 1]);
  assert.doesNotMatch(JSON.stringify(filtered), /0500-0000-0001|가상 수취인|가상시/);

  const additional = [line(30, embossed, 1), line(31, gauze, 1), line(32, cushion, 1)];
  await collect(db, [...orders, ...additional]);
  setSku.run('8809538930184', cushion);
  const remainder = getOrderPacking(db);
  const repeated = reviseOrderPacking(db, { expectedVersion: remainder.version, removeBoxIds: [], boxes: [
    { items: remainder.orders.map(order => item(order.id)) },
  ] });
  registerOrderDispatch(db, { expectedVersion: repeated.version, boxIds: [repeated.boxes[0].id], orderItemIds: [] });
  assert.deepEqual(shippingBoard(db, date).registered.groups.map(group => group.boxCount), [8, 2]);
});

test('부분 취소로 상자 수량이 맞지 않으면 전체 등록을 거절하고 포장 편집 상태를 유지한다', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  await collect(db, [line(1, '가상 쿠션', 2), line(2, '가상 커버', 1)]);
  const seed = getOrderPacking(db), [cushion, cover] = seed.orders.map(order => order.id);
  const planned = reviseOrderPacking(db, { expectedVersion: seed.version, removeBoxIds: [], boxes: [{ items: [item(cushion, 2)] }] });
  await collect(db, [line(1, '가상 쿠션', 1), line(2, '가상 커버', 1)]);
  const current = getOrderPacking(db);
  assert.equal(current.boxes[0].needsReview, true);
  const selection = { boxIds: [planned.boxes[0].id], orderItemIds: [cover] };
  assert.throws(() => registerOrderDispatch(db, { ...selection, expectedVersion: planned.version }), { status: 409 });
  assert.throws(() => registerOrderDispatch(db, { ...selection, expectedVersion: current.version }), /수량이 바뀐 상자/);
  assert.equal(registeredOrderQuantities(db).size, 0);
  assert.deepEqual(getOrderPacking(db), current);
});
