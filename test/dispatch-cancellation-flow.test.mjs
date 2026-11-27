import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { collectOrderIntake } from '../lib/order-intake.mjs';
import { getOrderPacking, registerOrderDispatch, reviseOrderPacking } from '../lib/order-packing.mjs';
import { createApp } from '../server.mjs';

const naverOrder = (index, name) => ({
  productOrderId: '20261127123000' + index, orderId: '20261127133000' + index, quantity: 1, productName: '가상 쿠션',
  sourcePayload: { content: { productOrder: { shippingAddress: {
    name, tel1: '0500-0000-0001', baseAddress: '서울 강남구 가상로 10', detailedAddress: '가상호', zipCode: '01234',
  } } } },
});

const evidence = (order, status = 'PAYED', claimStatus = '') => ({
  productOrderId: order.productOrderId, orderId: order.orderId, status, claimStatus, remainQuantity: status === 'CANCELED' ? 0 : 1,
});

test('날짜별 네이버 취소 확인은 기존 상자를 남겨 두고 해당 상자만 출고 수와 로젠 엑셀에서 제외한다', async t => {
  const orders = ['전량 취소', '정상 출고', '취소 요청', '합포장 수취인', '합포장 수취인', '조회 누락'].map((name, index) => naverOrder(index, name));
  const [allCanceled, ready, pending, mixedCanceled, mixedReady] = orders;
  const answers = [evidence(allCanceled, 'CANCELED', 'CANCEL_DONE'), evidence(ready), evidence(pending, 'PAYED', 'CANCEL_REQUEST'),
    evidence(mixedCanceled, 'CANCELED', 'CANCEL_DONE'), evidence(mixedReady)];
  let answer = async () => answers;
  const naver = { listNewOrders: async () => ({ orders }), queryProductOrders: (ids, params) => {
    assert.deepEqual(ids.slice().sort(), orders.map(order => order.productOrderId).sort());
    assert.deepEqual(params, { includeIntake: true, allowMissing: true });
    return answer();
  } };
  const app = createApp({ databasePath: ':memory:', naver, apiKey: '', client: null, discordConfig: null });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const db = app.locals.db;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const origin = 'http://127.0.0.1:' + server.address().port;

  await collectOrderIntake(db, { naver });
  const current = getOrderPacking(db);
  const id = order => current.orders.find(item => item.productOrderId === order.productOrderId).id;
  const planned = reviseOrderPacking(db, { expectedVersion: current.version, removeBoxIds: [],
    boxes: [{ items: [mixedCanceled, mixedReady].map(order => ({ orderItemId: id(order), quantity: 1 })) }] });
  const { date } = registerOrderDispatch(db, { expectedVersion: planned.version, boxIds: [planned.boxes[0].id],
    orderItemIds: [orders[0], orders[1], orders[2], orders[5]].map(id) });
  const url = origin + '/api/shipping/';
  const board = () => fetch(url + 'board?date=' + date).then(response => response.json());
  const download = () => fetch(url + 'logen-export?date=' + date);
  const check = () => fetch(url + 'cancellations/check', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date }),
  });

  const recordTables = ['order_dispatch_boxes', 'order_dispatch_items', 'order_intake_items', 'order_intake_snapshots'];
  const records = () => recordTables.map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY 1, 2').all());
  const before = records();
  assert.equal((await board()).registered.boxCount, 5);

  let releaseResponse;
  let lookupStarted;
  const started = new Promise(resolve => { lookupStarted = resolve; });
  answer = () => new Promise(resolve => {
    releaseResponse = () => resolve(answers);
    lookupStarted();
  });
  const checkRequest = check();
  await started;
  try {
    assert.equal((await check()).status, 409);
    assert.equal((await download()).status, 409);
  } finally { releaseResponse(); }

  const result = await checkRequest;
  assert.equal(result.status, 200);
  const { check: checked, board: after } = await result.json();
  assert.equal(checked.unverifiedCount, 1);
  assert.equal(after.registered.totalBoxCount, 5);
  assert.equal(after.registered.boxCount, 1);
  assert.equal(after.registered.canceledBoxCount, 1);
  assert.equal(after.registered.heldBoxCount, 3);
  assert.equal(after.summary.bundleCount, 1);
  assert.equal(after.registered.lastCancellationCheckedAt, checked.lastCheckedAt);
  const rows = new Map(after.registered.groups.flatMap(group => group.shipments).map(row => [row.recipient, row.dispatchState]));
  assert.deepEqual(Object.fromEntries(rows), {
    '전량 취소': 'canceled', '정상 출고': 'ready', '취소 요청': 'hold', '합포장 수취인': 'hold', '조회 누락': 'hold',
  });
  assert.equal(after.registered.groups.reduce((sum, group) => sum + group.boxCount, 0), 1);
  assert.deepEqual((await board()).registered, after.registered);
  assert.deepEqual(records(), before);

  const response = await download();
  assert.equal(response.status, 200);
  const exported = XLSX.read(Buffer.from(await response.arrayBuffer()), { type: 'buffer' });
  const [, ...workbookRows] = XLSX.utils.sheet_to_json(exported.Sheets.rus00, { header: 1, raw: true });
  assert.deepEqual(workbookRows.map(row => row[0]), ['정상 출고']);

  answer = () => { throw new Error('네이버 조회 연결 실패'); };
  assert.equal((await check()).status, 400);
  assert.deepEqual((await board()).registered, after.registered);
  assert.deepEqual(records(), before);
});
