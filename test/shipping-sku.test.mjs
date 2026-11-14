import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { openDatabase } from '../lib/database.mjs';
import { importFiles } from '../lib/excel.mjs';
import { shippingBoard } from '../lib/shipping.mjs';
import { previewShippingBoard } from '../lib/shipping-preview.mjs';

const date = '2026-11-14', stamp = '2026-11-14T01:00:00.000Z';
const normal = '완전밀착 새싹(면100수) D타입 High(13cm)', alias = '[coupang] ' + normal;
const refurbished = normal + ' 리퍼', barcode = '8809538930160', refurbishedBarcode = '8809538930207';
function setup(t) {
  const db = openDatabase(':memory:'); t.after(() => db.close()); return db;
}
function seed(db, rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['원상품명', '주문번호', '체결번호', '송화주', '전화번호', '주소', '수량'],
    ...rows.map(row => [row.originalName || row.name, row.id, 'mock-order-' + row.id,
      '모의 수취인', '010-0000-0000', row.address || '가상시 테스트로 1', row.quantity || 1]),
  ]), '가상 출고');
  const detail = importFiles(db, [{ originalname: '가상 출고.xlsx', buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) }]);
  db.prepare('UPDATE batches SET created_at=? WHERE id=?').run(stamp, detail.batch.id);
  for (const [index, row] of rows.entries()) db.prepare("UPDATE rows SET cleaned_name=?,status='confirmed' WHERE id=?").run(row.name, detail.rows[index].id);
  return detail;
}
const sourceSnapshot = db => JSON.stringify(Object.fromEntries(['rows', 'sheets', 'source_files', 'row_revisions'].map(table =>
  [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()])));
const newOrder = (id, name, quantity = 1, originalName = name) => ({ productOrderId: 'mock-product-' + id, orderId: 'mock-order-' + id,
  originalName, productName: name, optionName: '', quantity, recipient: '모의 수취인', phone: '010-0000-0000', address: '가상시 테스트로 1' });
const client = { responses: { async create(request) {
  return { output_text: JSON.stringify({ items: JSON.parse(request.input).map(row => ({ id: row.id,
    cleanedName: row.productName, needsAttention: false, note: '' })) }), usage: { total_tokens: 1 } };
} } };
const preview = (db, orders) => previewShippingBoard(db, { async listNewOrders() { return { from: stamp, to: stamp, orders }; } }, client, 'mock-model');

test('바코드가 같은 일반6·쿠팡1을 7묶음으로 합치고 재업로드는 대표 이름을 과대 가중하지 않는다', t => {
  const db = setup(t);
  seed(db, [...Array.from({ length: 6 }, (_, i) => ({ id: 'normal-' + i, name: normal })), { id: 'alias', name: alias, quantity: 5 }]);
  seed(db, Array.from({ length: 10 }, () => ({ id: 'alias', name: alias, quantity: 5 })));
  const before = sourceSnapshot(db), board = shippingBoard(db, date);
  assert.equal(board.groups.length, 1); assert.equal(board.groups[0].count, 7);
  assert.equal(board.groups[0].skuBarcode, barcode); assert.equal(board.groups[0].name, normal);
  assert.equal(board.summary.bundleCount, 7); assert.equal(board.summary.duplicateCount, 10);
  assert.equal(board.summary.conflictCount, 0); assert.equal(sourceSnapshot(db), before);
});

test('같은 출고의 동일SKU 별칭은 충돌이 아니며 실제 수취 차이와 서로 다른 미매칭 상품은 유지한다', t => {
  const db = setup(t);
  seed(db, [{ id: 'same', name: normal }, { id: 'same', name: alias }, { id: 'receipt', name: normal },
    { id: 'receipt', name: alias, address: '가상시 다른로 2' }, { id: 'unknown-a', name: '미등록 상품 A' }, { id: 'unknown-b', name: '미등록 상품 B' }]);
  const board = shippingBoard(db, date);
  assert.equal(board.summary.bundleCount, 4); assert.equal(board.summary.conflictCount, 1);
  assert.equal(board.groups.find(group => group.skuBarcode === barcode).count, 1);
  assert.equal(board.groups.find(group => group.needsAttention).shipments[0].recipient, '확인 필요');
  assert.equal(board.groups.filter(group => group.name.startsWith('미등록 상품')).length, 2);
});

test('리퍼 바코드와 맞교환 출고 목적을 나누며 같은 내부번호의 판매·맞교환을 합치지 않는다', t => {
  const db = setup(t);
  seed(db, [{ id: 'shared', name: normal }, { id: 'refurbished', name: refurbished },
    { id: 'shared', name: normal, originalName: '[맞교환] ' + normal }]);
  const board = shippingBoard(db, date);
  assert.equal(board.summary.bundleCount, 3); assert.equal(board.summary.conflictCount, 0); assert.equal(board.groups.length, 3);
  assert.equal(board.groups.filter(group => group.skuBarcode === barcode).length, 2);
  assert.equal(board.groups.find(group => group.shipmentType === 'exchange').count, 1);
  assert.equal(board.groups.find(group => group.shipmentType === 'exchange').invoiceState, 'unavailable');
  assert.equal(board.groups.find(group => group.skuBarcode === refurbishedBarcode).count, 1);
});

test('최빈 명칭 동률은 원본 업로드 순서가 바뀌어도 같은 제목을 고른다', t => {
  const db = setup(t), first = seed(db, [{ id: 'one', name: normal }, { id: 'two', name: alias }]);
  const second = seed(db, [{ id: 'three', name: alias }, { id: 'four', name: normal }]);
  const a = shippingBoard(db, date, first.batch.id), b = shippingBoard(db, date, second.batch.id);
  assert.equal(a.groups.length, 1); assert.equal(b.groups.length, 1); assert.equal(a.groups[0].name, b.groups[0].name);
  assert.ok([normal, alias].includes(a.groups[0].name));
});

test('신규 주문도 같은 바코드로 합치고 수량 합계와 개별 상품주문을 보존한다', async t => {
  const db = setup(t), orders = [newOrder('one', normal, 10), newOrder('two', alias), newOrder('three', alias)];
  const before = sourceSnapshot(db), board = await preview(db, orders);
  assert.equal(board.groups.length, 1); assert.equal(board.groups[0].count, 12); assert.equal(board.summary.quantity, 12);
  assert.equal(board.groups[0].name, alias); assert.equal(board.groups[0].skuBarcode, barcode);
  assert.deepEqual(board.groups[0].shipments.map(row => row.id), orders.map(row => row.productOrderId));
  assert.equal(sourceSnapshot(db), before);
});

test('신규 주문의 리퍼·맞교환·바코드 없는 두 상품도 각각 분리한다', async t => {
  const db = setup(t), board = await preview(db, [newOrder('sale', normal), newOrder('refurbished', refurbished),
    newOrder('exchange', normal, 2, '[맞교환] ' + normal), newOrder('unknown-a', '미등록 상품 A'), newOrder('unknown-b', '미등록 상품 B')]);
  assert.equal(board.groups.length, 5); assert.equal(board.summary.quantity, 6);
  assert.equal(board.groups.find(group => group.shipmentType === 'exchange').count, 2);
  assert.equal(board.groups.find(group => group.skuBarcode === refurbishedBarcode).count, 1);
  assert.equal(board.groups.filter(group => group.name.startsWith('미등록 상품')).length, 2);
});
