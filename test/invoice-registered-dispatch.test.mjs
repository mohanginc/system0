import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import officeCrypto from 'officecrypto-tool';
import { importFiles } from '../lib/excel.mjs';
import { createDiscordHandler } from '../lib/discord-bot.mjs';
import { dispatchReference } from '../lib/dispatch-reference.mjs';
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

async function uploadFiles(request, date, naverFile, courierFile, naverPassword = '') {
  const body = new FormData();
  appendFile(body, 'naverFiles', naverFile);
  appendFile(body, 'courierFiles', courierFile);
  body.append('sourceDate', date);
  body.append('deliveryCompanyCode', 'KGB');
  if (naverPassword) body.append('naverPassword', naverPassword);
  return JSON.parse(await responseBytes(await request('/api/invoices/import', { method: 'POST', body }), 201));
}

async function boot(t, naver, { client = null, discordConfig = null } = {}) {
  const app = createApp({ databasePath: ':memory:', naver, apiKey: '', client, discordConfig, model: 'local-mock' });
  const db = app.locals.db;
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const request = (route, options) => fetch(baseUrl + route, options);
  return { db, request, baseUrl };
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

test('디스코드에서 27일 실패 작업을 다시 요청하면 보관 원본으로만 26건 엑셀을 만들고 기존 파일과 검토를 보존한다', async t => {
  const date = '2026-11-27', password = 'synthetic-naver-excel-password';
  const requestText = '27일 실패한 송장 작업 다시 매칭해서 네이버 등록용 엑셀 만들어줘';
  const scope = { guildId: '111111111111111111', channelId: '222222222222222222', userId: '333333333333333333' };
  const config = { secret: 'registered-dispatch-test-key', guildId: scope.guildId, channelIds: [scope.channelId],
    userIds: [scope.userId], plainMessageChannelIds: [scope.channelId], publicOrigin: 'https://system0.example' };
  const products = Array.from({ length: 26 }, (_, index) => {
    const suffix = String(index + 1).padStart(2, '0');
    return order(suffix, '가상 배송 상품 ' + suffix, '20261127123460' + suffix);
  });
  const labels = products.map((_, index) => [String(45670001001 + index), dispatchReference(date, index + 1)]);
  const naver = { listNewOrders: async () => ({ orders: products }), queryProductOrders: async () => [] };
  let failedId, rematchedId, modelCalls = 0;
  const client = { responses: { create: async request => {
    modelCalls++;
    const user = JSON.parse(request.input[0].content);
    assert.equal(user.text, requestText);
    assert.equal(user.attachments, undefined);
    assert.ok(!JSON.stringify(request.input).includes(password));
    const outputs = request.input.filter(entry => entry.type === 'function_call_output').map(entry => JSON.parse(entry.output));
    let name, args;
    if (!outputs.length) {
      name = 'list_invoice_runs'; args = { date };
    } else if (outputs.length === 1) {
      assert.equal(outputs[0].ok, true);
      const source = outputs[0].runs.find(run => run.sourceDate === date && run.generatedAt === null);
      assert.equal(source?.runId, failedId);
      name = 'rematch_invoice_files'; args = { runId: source.runId };
    } else if (outputs.length === 2) {
      const result = outputs[1];
      assert.equal(result.ok, true);
      assert.equal(result.sourceRunId, failedId);
      assert.equal(result.fileActions.create, true);
      assert.notEqual(result.runId, failedId);
      rematchedId = result.runId;
      name = 'get_invoice_file'; args = { runId: rematchedId, mode: 'export' };
    } else {
      assert.equal(outputs.length, 3);
      assert.equal(outputs[2].attached, true);
      return { output: [], output_text: '저장된 두 원본으로 네이버 엑셀을 만들었습니다.' };
    }
    assert.ok(request.tools.some(tool => tool.name === name), '공용 업무 도구를 모델에 제공해야 합니다.');
    return { output: [{ type: 'function_call', id: 'fc_' + modelCalls, call_id: 'call_' + modelCalls,
      name, arguments: JSON.stringify(args) }] };
  } } };
  const { db, request, baseUrl } = await boot(t, naver, { client, discordConfig: config });
  const json = (method, data) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const archiveOrder = order(98, '보존할 기존 작업 상품', legacyOrderId);
  const legacy = importFiles(db, [file('상품명 정리 주문.xlsx', [
    ['원상품명', '주문번호', '체결번호', '송화주', '전화번호', '주소', '수량', '쇼핑몰'],
    [archiveOrder.productName, legacyRef, archiveOrder.orderId, recipient, phone, address, 1, '네이버'],
  ])]);
  db.prepare('UPDATE batches SET created_at = ? WHERE id = ?').run('2026-11-26T01:00:00.000Z', legacy.batch.id);
  const archived = await uploadFiles(request, '2026-11-26', naverWorkbook([archiveOrder]), courierWorkbook([[legacyTracking, legacyRef]]));
  const archiveRoute = '/api/invoices/' + archived.run.id;
  const archive = await responseBytes(await request(archiveRoute + '/file', json('POST', { mode: 'auto', expectedVersion: archived.viewVersion })), 200);
  const beforeUpload = naverWorkbook(products);
  const encrypted = { ...beforeUpload, buffer: officeCrypto.encrypt(beforeUpload.buffer, { password }) };
  const failed = await uploadFiles(request, date, encrypted, courierWorkbook(labels), password);
  failedId = failed.run.id;
  const failureRoute = '/api/invoices/' + failedId;
  assert.equal(failed.currentSummary.connected, 0);
  assert.equal(failed.fileActions.create, false);
  const reviewed = JSON.parse(await responseBytes(await request(failureRoute + '/items', json('PATCH', {
    expectedVersion: failed.viewVersion, changes: [{ id: failed.items[0].id, decision: 'hold', note: '다시 확인할 첫 번째 상품' }],
  })), 200));
  assert.equal(reviewed.items[0].note, '다시 확인할 첫 번째 상품');
  const snapshot = id => [db.prepare('SELECT * FROM invoice_runs WHERE id = ?').get(id),
    db.prepare('SELECT * FROM invoice_items WHERE run_id = ? ORDER BY id').all(id),
    db.prepare('SELECT * FROM invoice_files WHERE run_id = ? ORDER BY id').all(id),
    db.prepare('SELECT * FROM invoice_revisions WHERE item_id IN (SELECT id FROM invoice_items WHERE run_id = ?) ORDER BY id').all(id)];
  const savedFailure = snapshot(failedId), savedArchive = snapshot(archived.run.id);

  await collectOrderIntake(db, { naver });
  const packing = getOrderPacking(db);
  const orderItemIds = products.map(product => packing.orders.find(item => item.productOrderId === product.productOrderId).id);
  assert.equal(registerOrderDispatch(db, { expectedVersion: packing.version, boxIds: [], orderItemIds }).registeredCount, 26);
  db.prepare('UPDATE order_intake_snapshots SET recorded_at = ?').run(date + 'T05:00:00.000Z');
  db.prepare('UPDATE order_dispatch_boxes SET registered_at = ?').run(date + 'T06:00:00.000Z');
  const beforeRetry = db.prepare('SELECT count(*) AS n FROM invoice_runs').get().n;
  const missingPassword = await request(failureRoute + '/rematch', json('POST', {}));
  const passwordError = JSON.parse(await responseBytes(missingPassword, 400));
  assert.equal(passwordError.code, 'invoice_source_password_required');
  assert.match(passwordError.error, /암호/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM invoice_runs').get().n, beforeRetry);

  const calls = [];
  const handle = createDiscordHandler({ config: { ...config, baseUrl, naverPassword: password }, fetcher: (url, options) => {
    assert.equal(new URL(url).origin, baseUrl);
    calls.push([options?.method || 'GET', new URL(url).pathname]);
    return fetch(url, options);
  } });
  const result = await handle({ ...scope, id: '555555555555555555', botMessageId: '666666666666666666', kind: 'message', text: requestText });
  assert.equal(modelCalls, 4, result.content);
  assert.equal(result.files?.length, 1, result.content);
  assert.ok(calls.some(call => call[0] === 'POST' && call[1] === failureRoute + '/rematch'));
  assert.ok(!calls.some(call => call[1] === '/api/invoices/import'));
  const output = result.files[0].attachment;
  const excel = workbookRows(Buffer.from(output));
  assert.deepEqual(excel[0], ['상품주문번호', '배송방법', '택배사', '송장번호']);
  assert.deepEqual(excel.slice(1).map(row => [row[0], row[3]]), products.map((item, index) => [item.productOrderId, labels[index][0]]));
  const retried = await request(failureRoute + '/rematch', json('POST', { naverPassword: password }));
  assert.ok(retried.ok, await retried.clone().text());
  assert.equal((await retried.json()).run.id, rematchedId);
  assert.equal(db.prepare('SELECT count(*) AS n FROM invoice_runs').get().n, beforeRetry + 1);
  const history = JSON.parse(await responseBytes(await request('/api/invoices/drafts?date=' + date + '&includeHistory=true'), 200));
  assert.ok(history.drafts.some(draft => draft.id === failedId));
  assert.deepEqual(await responseBytes(await request('/api/invoices/' + rematchedId + '/download'), 200), output);
  assert.deepEqual(await responseBytes(await request(archiveRoute + '/download'), 200), archive);
  assert.deepEqual(snapshot(failedId), savedFailure);
  assert.deepEqual(snapshot(archived.run.id), savedArchive);
});
