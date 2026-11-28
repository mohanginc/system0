import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { importFiles } from '../lib/excel.mjs';
import { collectOrderIntake, importCoupangOrders } from '../lib/order-intake.mjs';
import { getOrderPacking, registerOrderDispatch, reviseOrderPacking } from '../lib/order-packing.mjs';
import { checkDispatchCancellations } from '../lib/dispatch-cancellations.mjs';
import { shippingDayRange } from '../lib/shipping.mjs';
import { createApp } from '../server.mjs';

const recipient = '가상 수취인', phone = '010-0000-0012';
const baseAddress = '서울 강남구 가상로 100', detailedAddress = '101호';
const address = baseAddress + ' ' + detailedAddress;
const shippingAddress = { name: recipient, tel1: phone, baseAddress, detailedAddress, zipCode: '01234' };
const orderId = '2026112712345000', legacyOrderId = '2026112712346000';
const legacyRef = '202611271230000001', legacyTracking = '45670000004', coupangTracking = '45670000003';

function file(name, rows) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), '주문');
  return { originalname: name, buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) };
}

function workbookRows(bytes) {
  const book = XLSX.read(bytes, { type: 'buffer' });
  return XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, raw: true });
}

async function responseBytes(response, status) {
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, status, response.ok ? undefined : bytes.toString('utf8'));
  return bytes;
}

const order = (suffix, productName, parent = orderId) => ({
  productOrderId: '202611271234500' + suffix, orderId: parent, status: 'PAYED', placeOrderStatus: 'NOT_YET',
  quantity: 1, productName,
  sourcePayload: { content: { order: { orderId: parent }, productOrder: { shippingAddress } } },
});

function naverWorkbook(products) {
  return file('네이버 발송대기.xlsx', [
    ['상품주문번호', '주문번호', '상품명', '수량', '수취인명', '수취인연락처1', '통합배송지', '주문상태'],
    ...products.map(item => [item.productOrderId, item.orderId, item.productName, item.quantity, recipient, phone, address, 'PAYED']),
  ]);
}

function courierWorkbook(issued) {
  return file('로젠 출력완료.xlsx', [
    ['운송장번호', '주문번호', '차수', '원송장번호', '발행횟수', '출력시간', '이름', '전화', '주소'],
    ...issued.map(([tracking, reference, name = recipient]) =>
      [tracking, reference, 1, '', 1, '16:00:00', name, phone, address]),
  ]);
}

function appendFile(form, field, { originalname, buffer }) {
  form.append(field, new Blob([buffer]), originalname);
}

async function uploadFiles(request, date, naverFile, courierFile) {
  const body = new FormData();
  appendFile(body, 'naverFiles', naverFile);
  appendFile(body, 'courierFiles', courierFile);
  body.append('sourceDate', date);
  body.append('deliveryCompanyCode', 'KGB');
  return JSON.parse(await responseBytes(await request('/api/invoices/import', { method: 'POST', body }), 201));
}

async function boot(t, naver) {
  const app = createApp({ databasePath: ':memory:', naver, apiKey: '', client: null, discordConfig: null });
  const db = app.locals.db;
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const request = (route, options) => fetch('http://127.0.0.1:' + server.address().port + route, options);
  return { db, request };
}

async function prepare(t, { sameParent = true, priorFailure = false, checkCancellation = false } = {}) {
  const [pillow, cover, extra] = [order(1, '수유쿠션'),
    order(2, '방수커버', sameParent ? orderId : '2026112712347000'), order(3, '예비커버')];
  const naver = {
    listNewOrders: async () => ({ orders: [pillow, cover, extra] }),
    queryProductOrders: async () => [],
  };
  const { db, request } = await boot(t, naver);

  await collectOrderIntake(db, { naver });
  const coupangUpload = await importCoupangOrders(db, { file: file('쿠팡 주문.xlsx', [
    ['주문번호', '묶음배송번호', '옵션ID', '등록상품명', '구매수(수량)', '수취인이름', '수취인주소',
      '우편번호', '수취인전화번호', '운송장번호', '출고일(발송일)'],
    ['19104535100000', '100001', '100002', '쿠팡 수유쿠션', 1, '가상 쿠팡 수취인', address, '01234', phone, '', ''],
  ]) });
  const initial = getOrderPacking(db);
  const byProduct = new Map(initial.orders.map(item => [item.productOrderId, item.id]));
  const packingItems = [pillow, cover].map(item => ({ orderItemId: byProduct.get(item.productOrderId), quantity: 1 }));
  const packed = reviseOrderPacking(db, { expectedVersion: initial.version, removeBoxIds: [], boxes: [{ items: packingItems }] });
  const { date } = registerOrderDispatch(db, { expectedVersion: packed.version, boxIds: [packed.boxes[0].id],
    orderItemIds: [byProduct.get(extra.productOrderId), coupangUpload.orders.find(item => item.provider === 'coupang').id] });

  const legacy = order(4, '기존 출고 쿠션', legacyOrderId);
  const saved = importFiles(db, [file('상품명 정리 주문.xlsx', [
    ['원상품명', '주문번호', '체결번호', '송화주', '전화번호', '주소', '수량', '쇼핑몰'],
    [legacy.productName, legacyRef, legacyOrderId, recipient, phone, address, 1, '네이버'],
  ])]);
  db.prepare('UPDATE batches SET created_at = ? WHERE id = ?').run(date + 'T01:00:00.000Z', saved.batch.id);
  db.prepare("UPDATE rows SET cleaned_name = original_name, status = 'confirmed' WHERE batch_id = ?").run(saved.batch.id);

  const logen = workbookRows(await responseBytes(await request('/api/shipping/logen-export?date=' + date), 200));
  const [head, ...boxes] = logen;
  const findBox = (...names) => {
    const box = boxes.find(row => names.every(name => row[head.indexOf('원상품명')].includes(name)));
    assert.ok(box, names.join(' + '));
    return { reference: box[head.indexOf('주문번호')], parent: box[head.indexOf('체결번호')] };
  };
  const combined = findBox(pillow.productName, cover.productName);
  const split = findBox(extra.productName);
  const coupang = findBox('쿠팡 수유쿠션');
  assert.equal(combined.parent, sameParent ? orderId : '');
  assert.equal(split.parent, orderId);
  assert.equal(new Set([combined.reference, split.reference, coupang.reference, legacyRef]).size, 4);
  const combinedTracking = '45670000001', splitTracking = '45670000002';
  const products = [pillow, cover, extra, legacy];
  const issued = [[combinedTracking, combined.reference], [splitTracking, split.reference],
    [coupangTracking, coupang.reference, '가상 쿠팡 수취인'], [legacyTracking, legacyRef]];
  const naverFile = naverWorkbook(products), courierFile = courierWorkbook(issued);
  const upload = () => uploadFiles(request, date, naverFile, courierFile);
  function historicalRun(id) {
    return [db.prepare('SELECT * FROM invoice_runs WHERE id = ?').get(id),
      db.prepare('SELECT * FROM invoice_items WHERE run_id = ? ORDER BY id').all(id)];
  }
  let failed, history;
  if (priorFailure) {
    // Model the failed match before the registered box evidence is available to the importer.
    const registrations = db.prepare('SELECT * FROM order_dispatch_items').all();
    db.exec('DELETE FROM order_dispatch_items');
    failed = await upload();
    assert.equal(failed.currentSummary.connected, 1);
    history = historicalRun(failed.run.id);
    const restore = db.prepare(`INSERT INTO order_dispatch_items
      (dispatch_box_id, order_item_id, quantity, name, sku_barcode, provider, product_order_id, shipment_type)
      VALUES ($dispatch_box_id, $order_item_id, $quantity, $name, $sku_barcode, $provider, $product_order_id, $shipment_type)`);
    for (const item of registrations) restore.run(item);
  }
  const preserved = ['order_intake_snapshots', 'order_dispatch_boxes', 'order_dispatch_items', 'order_dispatch_cancellations', 'rows', 'source_files'];
  const snapshot = () => preserved.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const beforeImport = snapshot();
  const imported = await upload(), route = '/api/invoices/' + imported.run.id;
  assert.deepEqual(snapshot(), beforeImport);
  if (checkCancellation) {
    // The printed carrier file and matched draft already exist when confirmation arrives.
    const [from, to] = shippingDayRange(date);
    const result = await checkDispatchCancellations(db, from, to, { queryProductOrders: async () =>
      [pillow, cover, extra].map(item => ({ ...item, status: item === extra ? 'CANCELED' : 'PAYED', remainQuantity: item === extra ? 0 : 1 })) });
    assert.equal(result.canceledCount, 1);
  }
  const before = snapshot();
  return { request, route, imported, expected: [combinedTracking, combinedTracking, splitTracking, legacyTracking], products,
    unchanged: () => {
      assert.deepEqual(snapshot(), before);
      if (failed) {
        assert.notEqual(imported.run.id, failed.run.id);
        assert.deepEqual(historicalRun(failed.run.id), history);
      }
    } };
}

test('같은 날 출고 등록 상자와 상품명 정리 작업을 함께 매칭하고 해당 네이버 송장만 엑셀로 만든다', async t => {
  const { request, route, imported, expected, products, unchanged } = await prepare(t, { priorFailure: true });
  assert.equal(imported.currentSummary.total, 4);
  assert.equal(imported.currentSummary.connected, 4);
  assert.deepEqual(products.map(product => imported.items.find(item => item.productOrderId === product.productOrderId).trackingNumber), expected);
  assert.deepEqual(imported.unmatchedCouriers.map(parcel => [parcel.trackingNumber, parcel.state, parcel.providers]),
    [[coupangTracking, 'unsupported_mall', ['coupang']]]);
  const view = JSON.parse(await responseBytes(await request(route), 200));
  const download = await request(route + '/file', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'auto', expectedVersion: view.viewVersion }) });
  const excel = workbookRows(await responseBytes(download, 200));
  assert.deepEqual(excel[0], ['상품주문번호', '배송방법', '택배사', '송장번호']);
  assert.deepEqual(excel.slice(1).map(row => [row[0], row[3]]).sort(),
    products.map((product, index) => [product.productOrderId, expected[index]]).sort());
  unchanged();
});

test('출고 등록 상자에 서로 다른 네이버 주문번호가 섞이면 네이버 엑셀 생성에서 자동 확정하지 않는다', async t => {
  const { request, route, imported, products, unchanged } = await prepare(t, { sameParent: false });
  const targets = new Set(products.slice(0, 2).map(item => item.productOrderId));
  assert.ok(imported.issues.some(issue => issue.kind === 'center_required' && issue.blocking));
  assert.ok(imported.items.filter(item => targets.has(item.productOrderId)).every(item => item.decision !== 'include'));
  const download = await request(route + '/file', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'auto', expectedVersion: imported.viewVersion }) });
  assert.equal(download.status, 400);
  unchanged();
});

test('매칭 뒤 취소 확인된 출고 상자는 이미 연결한 송장 엑셀에도 자동 포함하지 않는다', async t => {
  const { request, route, imported, products, unchanged } = await prepare(t, { checkCancellation: true });
  assert.equal(imported.fileActions.create, true);
  const downloadFrom = view => request(route + '/file', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'auto', expectedVersion: view.viewVersion }) });
  assert.equal((await downloadFrom(imported)).status, 409);
  const view = JSON.parse(await responseBytes(await request(route), 200));
  const canceled = view.items.find(item => item.productOrderId === products[2].productOrderId);
  assert.ok(view.issues.some(issue => issue.blocking && /취소/.test(issue.message)
    && (issue.productOrderId === canceled.productOrderId || issue.internalId === canceled.internalId)));
  const download = await downloadFrom(view);
  assert.equal(download.status, 400);
  unchanged();
});

test('한 상품주문의 등록 상자 두 개는 대표 송장을 선택하고 실물 송장을 모두 보존한다', async t => {
  const product = { ...order(5, '두 개 주문한 쿠션'), quantity: 2 };
  const naver = { listNewOrders: async () => ({ orders: [product] }), queryProductOrders: async () => [] };
  const { db, request } = await boot(t, naver);
  await collectOrderIntake(db, { naver });
  const initial = getOrderPacking(db);
  const packed = reviseOrderPacking(db, { expectedVersion: initial.version, removeBoxIds: [],
    boxes: Array.from({ length: 2 }, () => ({ items: [{ orderItemId: initial.orders[0].id, quantity: 1 }] })) });
  const { date } = registerOrderDispatch(db, { expectedVersion: packed.version,
    boxIds: packed.boxes.map(box => box.id), orderItemIds: [] });
  const [headers, ...boxes] = workbookRows(await responseBytes(await request('/api/shipping/logen-export?date=' + date), 200));
  assert.equal(boxes.length, 2);
  const trackingNumbers = ['45670000101', '45670000102'];
  const issued = boxes.map((row, index) => [trackingNumbers[index], row[headers.indexOf('주문번호')]]);
  const orders = naverWorkbook([product]);
  const upload = parcels => uploadFiles(request, date, orders, courierWorkbook(parcels));
  const action = (view, endpoint, body) => request('/api/invoices/' + view.run.id + endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, expectedVersion: view.viewVersion }),
  });

  const partial = await upload(issued.slice(0, 1));
  assert.equal(partial.fileActions.create, false);
  assert.equal((await action(partial, '/file', { mode: 'auto' })).status, 400);

  const imported = await upload(issued);
  assert.equal(imported.trackingReview.pendingCount, 1);
  const [group] = imported.trackingReview.groups;
  assert.equal(group.splitEligible, true);
  assert.equal(group.replaceEligible, false);
  assert.deepEqual(group.candidates.map(parcel => parcel.trackingNumber).sort(), trackingNumbers);
  assert.equal((await action(imported, '/file', { mode: 'auto' })).status, 400);
  const selected = JSON.parse(await responseBytes(await action(imported, '/tracking', {
    choices: [{ key: group.key, trackingNumber: trackingNumbers[1], mode: 'split' }],
  }), 200));
  assert.equal(selected.trackingReview.pendingCount, 0);
  assert.deepEqual(selected.items[0].physicalShipments.map(parcel => [parcel.trackingNumber, parcel.valid]).sort(),
    trackingNumbers.map(number => [number, true]));
  const excel = workbookRows(await responseBytes(await action(selected, '/file', { mode: 'auto' }), 200));
  assert.deepEqual(excel.slice(1).map(row => [row[0], row[3]]), [[product.productOrderId, trackingNumbers[1]]]);
});
