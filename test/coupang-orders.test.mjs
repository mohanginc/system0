import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as XLSX from 'xlsx';
import { openDatabase } from '../lib/database.mjs';
import { getOrderIntake, collectOrderIntake, importCoupangOrders } from '../lib/order-intake.mjs';
import { getOrderPacking, reviseOrderPacking, registerOrderDispatch } from '../lib/order-packing.mjs';
import { recoverCoupangDispatchMemos, recoverCoupangDispatchPhones } from '../lib/coupang-dispatch-contacts.mjs';

const headings = ['번호', '묶음배송번호', '주문번호', '운송장번호', '출고일(발송일)', '주문일', '등록상품명', '등록옵션명',
  '노출상품ID', '옵션ID', '바코드', '결제액', '배송비', '도서산간 추가배송비', '구매수(수량)', '옵션판매가(판매단가)',
  '수취인이름', '우편번호', '수취인 주소', '주문상태', '구매자전화번호', '수취인전화번호', '통관용수취인전화번호', '배송메세지'];
const pending = ['1', '000000000000123', '000000000000456', '', '', '2026-11-27 10:00:00', '모의 상품', '모의 옵션',
  '0000123', '0000456', '', '24,000', '2500', '0', '3', '8000', '모의 수취인', '01234', '가상시 가상로 10 101호', '',
  '010-0000-0001', '0500-0000-0002', '010-0000-0003', ''];
const replace = (row, field, value) => row.map((cell, index) => headings[index] === field ? value : cell);

function workbook(rows, originalname = 'DeliveryList(2026-11-27)_(0).xlsx') {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([headings, ...rows]), 'Delivery');
  return { originalname, buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) };
}

test('쿠팡 주문은 파일 행 증거를 보존하고 재업로드와 네이버 재수집에서 같은 주문을 중복 저장하지 않는다', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const first = await importCoupangOrders(db, { file: workbook([pending]) });
  assert.equal(first.collection.added, 1);
  assert.match(first.namingError, /OPENAI_API_KEY/);
  const [item] = first.orders;
  assert.match(item.productOrderId, /^cp-[0-9a-f]{64}$/);
  assert.equal(item.orderId, pending[2]);
  assert.equal(item.shippingGroupId, pending[1]);
  assert.equal(item.externalOptionId, pending[9]);
  assert.equal(item.provider, 'coupang');
  assert.equal(item.collectionMethod, 'file');
  assert.equal(item.orderedAt, '2026-11-27T01:00:00.000Z');
  assert.equal(item.financial.paymentAmount, 24000);
  assert.equal(item.financial.unitPrice, 8000);
  assert.equal(item.financial.shippingFeeAmount, 2500);
  assert.equal(item.financial.shippingExtraAmount, 0);
  assert.equal(item.financial.expectedSettlementAmount, null);
  assert.doesNotMatch(JSON.stringify(first), /가상시|모의 수취인/);
  const snapshot = JSON.parse(db.prepare('SELECT source_json FROM order_intake_snapshots').get().source_json);
  assert.equal(snapshot.location.row, 2);
  assert.equal(snapshot.shippingAddress.baseAddress, pending[18]);
  assert.equal(snapshot.shippingAddress.zipCode, '01234');
  assert.equal(snapshot.shippingAddress.tel1, pending[21]);
  assert.doesNotMatch(JSON.stringify(snapshot), /010-0000-000[13]/);
  const reopened = await importCoupangOrders(db, { file: workbook([replace(pending, '번호', '20')], '다시 받은 파일.xlsx') });
  assert.equal(reopened.collection.unchanged, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM order_intake_snapshots').get().n, 1);
  const naverResult = await collectOrderIntake(db, { naver: { listNewOrders: async () => ({ orders: [{
    productOrderId: item.productOrderId, orderId: item.orderId, originalName: '다른 채널 주문', quantity: 1,
  }] }) } });
  assert.deepEqual(naverResult.orders.map(order => order.provider).sort(), ['coupang', 'naver']);
  assert.equal(naverResult.summary.orderCount, 2);
  const after = await collectOrderIntake(db, { naver: { listNewOrders: async () => ({ orders: [] }), queryProductOrders: async () => [] } });
  assert.equal(after.orders.find(order => order.provider === 'coupang').state, 'pending');
  assert.equal(after.orders.find(order => order.provider === 'naver').state, 'unverified');
});

test('수취인 전화번호 변경을 별도 증거로 저장하고 기존 스냅샷과 연락처 없는 원본은 유지한다', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const file = workbook([pending]);
  await importCoupangOrders(db, { file });
  const snapshot = JSON.parse(db.prepare('SELECT source_json FROM order_intake_snapshots').get().source_json);
  delete snapshot.shippingAddress.tel1;
  snapshot.evidenceHash = createHash('sha256').update(JSON.stringify(snapshot.columns)).digest('hex');
  const oldJson = JSON.stringify(snapshot);
  db.prepare('UPDATE order_intake_snapshots SET source_json = ?').run(oldJson);
  db.prepare('UPDATE order_intake_items SET source_hash = ?').run(snapshot.evidenceHash);
  const repeat = await importCoupangOrders(db, { file });
  assert.equal(repeat.collection.updated, 1);
  const unchanged = await importCoupangOrders(db, { file });
  assert.equal(unchanged.collection.unchanged, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM order_intake_snapshots').get().n, 2);
  assert.equal(db.prepare('SELECT source_json FROM order_intake_snapshots ORDER BY id LIMIT 1').get().source_json, oldJson);

  const amendment = replace(pending, '수취인전화번호', '0500-0000-0004');
  const amended = await importCoupangOrders(db, { file: workbook([amendment]) });
  assert.equal(amended.collection.updated, 1);
  const amendedSource = JSON.parse(db.prepare('SELECT source_json FROM order_intake_snapshots ORDER BY id DESC LIMIT 1').get().source_json);
  assert.equal(amendedSource.shippingAddress.tel1, '0500-0000-0004');

  const other = replace(replace(pending, '주문번호', '000000000000457'), '수취인전화번호', '');
  await importCoupangOrders(db, { file: workbook([other]) });
  const withoutRecipientPhone = JSON.parse(db.prepare('SELECT source_json FROM order_intake_snapshots ORDER BY id DESC LIMIT 1').get().source_json);
  assert.equal(withoutRecipientPhone.shippingAddress.tel1, '');
  assert.doesNotMatch(JSON.stringify(withoutRecipientPhone), /010-0000-000[13]/);
});

test('쿠팡 엑셀의 중복 행은 원자적으로 거부하며 이전 파일로 배송 완료나 운송장 보류 상태를 되돌리지 않는다', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  await assert.rejects(importCoupangOrders(db, { file: workbook([pending, replace(pending, '번호', '2')]) }), /중복/);
  assert.equal(getOrderIntake(db).orders.length, 0);
  await importCoupangOrders(db, { file: workbook([pending]) });
  const heldRow = replace(pending, '운송장번호', '0000123456');
  const held = await importCoupangOrders(db, { file: workbook([heldRow]) });
  assert.equal(held.collection.held, 1);
  assert.equal(held.summary.quantity, 0);
  assert.equal(held.orders[0].state, 'hold');
  const replay = await importCoupangOrders(db, { file: workbook([pending]) });
  assert.equal(replay.orders[0].state, 'hold');
  const shipped = await importCoupangOrders(db, { file: workbook([replace(heldRow, '출고일(발송일)', '2026-11-27')]) });
  assert.equal(shipped.collection.closed, 1);
  assert.equal(shipped.orders.length, 0);
  const after = await importCoupangOrders(db, { file: workbook([replace(pending, '결제액', '25000')]) });
  assert.equal(after.orders.length, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM order_intake_snapshots').get().n, 3);
});

test('쿠팡 주문 일부 등록 후 잔여만 수집 화면에 남고 모두 등록하면 원가·판매 자료를 보존하며 사라진다', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const imported = await importCoupangOrders(db, { file: workbook([pending]) });
  const [{ id }] = imported.orders;
  const initial = getOrderPacking(db);
  assert.equal(initial.orders[0].destinationReady, true);
  const packed = reviseOrderPacking(db, { expectedVersion: initial.version, removeBoxIds: [], boxes: [{ items: [{ orderItemId: id, quantity: 1 }] }] });
  registerOrderDispatch(db, { expectedVersion: packed.version, boxIds: [packed.boxes[0].id], orderItemIds: [] });
  const [remaining] = getOrderIntake(db).orders;
  assert.equal(remaining.quantity, 2);
  assert.equal(remaining.sourceQuantity, 3);
  assert.equal(remaining.registeredQuantity, 1);
  assert.equal(remaining.financial.paymentAmount, 24000);
  const next = getOrderPacking(db);
  registerOrderDispatch(db, { expectedVersion: next.version, boxIds: [], orderItemIds: [id] });
  const after = await importCoupangOrders(db, { file: workbook([pending]) });
  assert.equal(after.orders.length, 0);
  assert.equal(db.prepare('SELECT quantity FROM order_intake_items WHERE id=?').get(id).quantity, 3);
});

test('같은 쿠팡 원본과 수취인이 증명된 출고 상자의 누락 연락처만 한 번 복원한다', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const file = workbook([pending]);
  const imported = await importCoupangOrders(db, { file });
  const [{ id }] = imported.orders;
  const { version } = getOrderPacking(db);
  const { date } = registerOrderDispatch(db, { expectedVersion: version, boxIds: [], orderItemIds: [id] });
  const archived = JSON.parse(db.prepare('SELECT source_json FROM order_intake_snapshots').get().source_json);
  delete archived.shippingAddress.tel1;
  db.prepare('UPDATE order_intake_snapshots SET source_json = ?').run(JSON.stringify(archived));
  db.exec("UPDATE order_dispatch_boxes SET contact_phone = ''");
  const boxBefore = db.prepare('SELECT * FROM order_dispatch_boxes').get();
  const later = { ...archived, location: { ...archived.location, archiveSha256: '0'.repeat(64) },
    shippingAddress: { ...archived.shippingAddress, tel1: '0500-0000-0005' } };
  db.prepare("INSERT INTO order_intake_snapshots (item_id,source_method,source_json,recorded_at) VALUES (?,'file',?,?)")
    .run(id, JSON.stringify(later), new Date(Date.parse(boxBefore.registered_at) + 1000).toISOString());
  const orderBefore = db.prepare('SELECT * FROM order_intake_items').all();
  const evidenceBefore = db.prepare('SELECT * FROM order_intake_snapshots').all();
  const dispatchItemsBefore = db.prepare('SELECT * FROM order_dispatch_items').all();

  const differentArchive = workbook([replace(pending, '번호', '2')]);
  assert.deepEqual(recoverCoupangDispatchPhones(db, differentArchive, date), { matchedBoxes: 0, restoredBoxes: 0 });
  assert.deepEqual(recoverCoupangDispatchPhones(db, file, '2000-01-01'), { matchedBoxes: 0, restoredBoxes: 0 });
  assert.deepEqual(db.prepare('SELECT * FROM order_dispatch_boxes').get(), boxBefore);

  db.prepare('UPDATE order_dispatch_boxes SET recipient = ?').run('다른 수취인');
  assert.deepEqual(recoverCoupangDispatchPhones(db, file, date), { matchedBoxes: 0, restoredBoxes: 0 });
  db.prepare('UPDATE order_dispatch_boxes SET recipient = ?').run(boxBefore.recipient);
  assert.deepEqual(recoverCoupangDispatchPhones(db, { ...file, originalname: '이름을 바꾼 원본.xlsx' }, date),
    { matchedBoxes: 1, restoredBoxes: 1 });
  assert.deepEqual({ ...db.prepare('SELECT * FROM order_dispatch_boxes').get() }, { ...boxBefore, contact_phone: pending[21] });
  assert.equal(recoverCoupangDispatchPhones(db, file, date).restoredBoxes, 0);
  assert.deepEqual(db.prepare('SELECT * FROM order_intake_items').all(), orderBefore);
  assert.deepEqual(db.prepare('SELECT * FROM order_intake_snapshots').all(), evidenceBefore);
  assert.deepEqual(db.prepare('SELECT * FROM order_dispatch_items').all(), dispatchItemsBefore);
});

test('지정한 원본 상자 수와 모두 미복원 또는 모두 일치 조건을 만족할 때만 복원을 확정한다', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const second = replace(pending, '주문번호', '000000000000457');
  const file = workbook([pending, second]);
  const imported = await importCoupangOrders(db, { file });
  const { version } = getOrderPacking(db);
  const { date } = registerOrderDispatch(db, { expectedVersion: version, boxIds: [], orderItemIds: imported.orders.map(order => order.id) });
  const list = db.prepare('SELECT contact_phone FROM order_dispatch_boxes ORDER BY id');
  const set = db.prepare('UPDATE order_dispatch_boxes SET contact_phone = ? WHERE id = ?');
  const phones = () => list.all().map(row => row.contact_phone);
  db.exec('UPDATE order_dispatch_boxes SET contact_phone = NULL');
  assert.throws(() => recoverCoupangDispatchPhones(db, file, date, { expectedBoxes: 1 }), /상자 수/);
  assert.throws(() => recoverCoupangDispatchPhones(db, file, date, { expectedBoxes: 2, verifyOnly: true }), /복원 상태/);
  assert.deepEqual(phones(), [null, null]);

  set.run('0500-0000-0004', 2);
  assert.throws(() => recoverCoupangDispatchPhones(db, file, date, { expectedBoxes: 2 }), /원본과 일치하지/);
  assert.deepEqual(phones(), [null, '0500-0000-0004']);
  set.run(pending[21], 2);
  assert.throws(() => recoverCoupangDispatchPhones(db, file, date, { expectedBoxes: 2 }), /복원 상태/);
  assert.deepEqual(phones(), [null, pending[21]]);

  set.run(null, 2);
  assert.deepEqual(recoverCoupangDispatchPhones(db, file, date, { expectedBoxes: 2 }), { matchedBoxes: 2, restoredBoxes: 2 });
  assert.deepEqual(phones(), [pending[21], pending[21]]);
  assert.deepEqual(recoverCoupangDispatchPhones(db, file, date, { expectedBoxes: 2 }), { matchedBoxes: 2, restoredBoxes: 0 });
  assert.deepEqual(recoverCoupangDispatchPhones(db, file, date, { expectedBoxes: 2, verifyOnly: true }), { matchedBoxes: 2, restoredBoxes: 0 });
});

test('배송메모는 원본대로 캡처하고 과거 상자에 같은 원본으로 한 번만 복원한다', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const notes = ['메모 1\n가상 배송 요청', ' 가상 배송 요청 2 '];
  const first = replace(pending, '배송메세지', notes[0]);
  const second = replace(replace(pending, '주문번호', '000000000000457'), '배송메세지', notes[1]);
  const file = workbook([first, second]);
  const imported = await importCoupangOrders(db, { file });
  assert.doesNotMatch(JSON.stringify(imported), /가상 배송 요청/);
  const snapshots = db.prepare('SELECT source_json FROM order_intake_snapshots ORDER BY id');
  assert.deepEqual(snapshots.all().map(row => JSON.parse(row.source_json).shippingMemo), notes);
  assert.equal((await importCoupangOrders(db, { file })).collection.unchanged, 2);
  assert.equal(snapshots.all().length, 2);
  const { version } = getOrderPacking(db);
  const { date } = registerOrderDispatch(db, { expectedVersion: version, boxIds: [], orderItemIds: imported.orders.map(order => order.id) });
  db.exec("UPDATE order_intake_snapshots SET source_json = json_remove(source_json, '$.shippingMemo')");
  const evidenceBefore = snapshots.all();
  const before = db.prepare('SELECT * FROM order_dispatch_boxes ORDER BY id').all().map(row => ({ ...row }));
  assert.throws(() => recoverCoupangDispatchMemos(db, workbook([replace(first, '번호', '2'), second]), date, 2), /상자 수/);
  assert.throws(() => recoverCoupangDispatchMemos(db, file, date, 2, { verifyOnly: true }), /복원 상태/);
  assert.deepEqual(recoverCoupangDispatchMemos(db, file, date, 2), { matchedBoxes: 2, restoredBoxes: 2 });
  const after = db.prepare('SELECT * FROM order_dispatch_boxes ORDER BY id').all().map(row => ({ ...row }));
  assert.deepEqual(after.map(row => row.shipping_memo).sort(), [...notes].sort());
  assert.deepEqual(after.map(row => ({ ...row, shipping_memo: null })), before);
  assert.deepEqual(snapshots.all(), evidenceBefore);
  assert.deepEqual(recoverCoupangDispatchMemos(db, file, date, 2), { matchedBoxes: 2, restoredBoxes: 0 });
  assert.deepEqual(recoverCoupangDispatchMemos(db, file, date, 2, { verifyOnly: true }), { matchedBoxes: 2, restoredBoxes: 0 });

  const memoOnlyAmendment = await importCoupangOrders(db, { file: workbook([replace(first, '배송메세지', '모의 새 배송 요청')]) });
  assert.equal(memoOnlyAmendment.collection.updated, 1);
  assert.equal(snapshots.all().length, 3);
});
