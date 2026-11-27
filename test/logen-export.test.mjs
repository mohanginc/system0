import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { collectOrderIntake } from '../lib/order-intake.mjs';
import { getOrderPacking, registerOrderDispatch, reviseOrderPacking } from '../lib/order-packing.mjs';
import { createApp } from '../server.mjs';

const headings = ['송화주', '핸드폰', '전화번호', '주소', '선착불', '원상품명', '비고', '우편번호', '수량',
  '택배비', '비고', '가격', '쇼핑몰', '주문번호', '공급처', '체결번호', '맞춤여부', '상담메모'];
const address = { name: '가상 수취인', tel1: '0500-0000-0011', tel2: '010-0000-0012',
  zipCode: '01234', baseAddress: '서울 강남구 가상로 100', detailedAddress: '101호' };
const orderId = '2026112712345000';

function order(item, productName, quantity, { shippingAddress = address, memo = '', price = 8000 } = {}) {
  return { productOrderId: '202611271234500' + item, orderId, productName, quantity,
    sourcePayload: { content: { order: { orderId },
      productOrder: { shippingAddress, shippingMemo: memo, remainQuantity: quantity, remainProductAmount: price } } } };
}

test('로젠 다운로드는 rus00 시트 형식으로 확정 상자만 출력하고 작업 상태와 주문 원본을 보존한다', async t => {
  const orders = [order(1, '쿠션', 3, { memo: '문 앞에 놓아 주세요', price: 24000 }),
    order(2, '손수건', 1, { memo: '문 앞에 놓아 주세요', price: 1000 }), order(3, '미등록 커버', 1)];
  const naver = { listNewOrders: async () => ({ orders }) };
  const app = createApp({ databasePath: ':memory:', naver, apiKey: '', client: null, discordConfig: null });
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const db = app.locals.db;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const api = 'http://127.0.0.1:' + server.address().port;

  await collectOrderIntake(db, { naver });
  const initial = getOrderPacking(db);
  const [cushion, cloth] = initial.orders.map(line => line.id);
  const planned = reviseOrderPacking(db, { expectedVersion: initial.version, removeBoxIds: [],
    boxes: [{ items: [{ orderItemId: cushion, quantity: 2 }, { orderItemId: cloth, quantity: 1 }] }] });
  const { date } = registerOrderDispatch(db, { expectedVersion: planned.version, boxIds: [planned.boxes[0].id], orderItemIds: [cushion] });

  // Re-collection after dispatch cannot change the address, delivery memo, or price on a past box.
  const original = db.prepare('SELECT * FROM order_intake_snapshots WHERE item_id = ? ORDER BY id').get(cushion);
  const registeredAt = db.prepare('SELECT MAX(registered_at) AS value FROM order_dispatch_boxes').get().value;
  const replacement = order(1, '쿠션', 3, { shippingAddress: { ...address, baseAddress: '다른시 가상로 99' }, memo: '새 배송 요청', price: 30000 });
  db.prepare('INSERT INTO order_intake_snapshots (item_id, source_method, source_json, recorded_at) VALUES (?, ?, ?, ?)')
    .run(cushion, original.source_method, JSON.stringify(replacement.sourcePayload), new Date(Date.parse(registeredAt) + 1000).toISOString());

  const before = db.prepare('SELECT * FROM order_dispatch_boxes ORDER BY id').all();
  const snapshots = db.prepare('SELECT * FROM order_intake_snapshots ORDER BY id').all();
  const url = api + '/api/shipping/logen-export?date=' + date;
  const summary = await fetch(url + '&format=summary');
  assert.equal(summary.status, 200);
  assert.deepEqual(await summary.json(), { date, boxCount: 2, filename: '로젠_업로드_' + date + '.xlsx' });
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /attachment/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const book = XLSX.read(Buffer.from(await response.arrayBuffer()), { type: 'buffer', cellNF: true });
  assert.deepEqual(book.SheetNames, ['rus00']);
  const sheet = book.Sheets.rus00;
  const [header, combined, single] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });
  assert.deepEqual(header, headings);
  assert.equal(sheet['!ref'], 'A1:R3');
  assert.ok(Object.entries(sheet).filter(([key]) => !key.startsWith('!')).every(([, cell]) => cell.t === 's' && !cell.f));
  assert.deepEqual(combined.slice(0, 5), [address.name, address.tel2, address.tel1, address.baseAddress + ' ' + address.detailedAddress, '신용']);
  assert.match(combined[5], /쿠션 ×2/);
  assert.match(combined[5], /손수건/);
  assert.deepEqual(combined.slice(6, 13), ['문 앞에 놓아 주세요', '01234', '1', '3800', '', '17000', '베이비스텔라']);
  assert.equal(single[5], '쿠션');
  assert.equal(single[11], '8000');
  for (const row of [combined, single]) {
    assert.match(row[13], /^[0-9]{18}$/);
    assert.deepEqual(row.slice(14), ['rus00', orderId, '0', '']);
  }
  assert.notEqual(combined[13], single[13]);
  assert.deepEqual(db.prepare('SELECT * FROM order_dispatch_boxes ORDER BY id').all(), before);
  assert.deepEqual(db.prepare('SELECT * FROM order_intake_snapshots ORDER BY id').all(), snapshots);

  const empty = await fetch(api + '/api/shipping/logen-export?date=2000-01-01');
  assert.equal(empty.status, 404);
  const invalid = await fetch(api + '/api/shipping/logen-export?date=2026-02-30');
  assert.equal(invalid.status, 400);
  // Clearing both saved and as-of contact under test blocks the entire download, including a valid sibling box.
  db.prepare('UPDATE order_dispatch_boxes SET contact_phone = NULL WHERE id = ?').run(before[0].id);
  db.prepare('UPDATE order_intake_snapshots SET source_json = ? WHERE id = ?')
    .run(JSON.stringify(order(1, '쿠션', 3, { shippingAddress: { ...address, tel1: '', tel2: '' } }).sourcePayload), original.id);
  const blocked = await fetch(url);
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /전화번호/);
});
