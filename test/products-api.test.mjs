import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { createApp } from '../server.mjs';
import { openDatabase, batchDetail } from '../lib/database.mjs';
import { importFiles } from '../lib/excel.mjs';
import { reviseRows, normalizePreviewNames } from '../lib/naming.mjs';
import { shippingBoard } from '../lib/shipping.mjs';

const knownBarcode = '8809538930160', secondBarcode = '8809538930184', newBarcode = '8809538930993';
const unknown = '관리 화면 가상 쿠션', prefixed = '[coupang]' + unknown;
const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function boot(t) {
  const app = createApp({ databasePath: ':memory:', client: null, apiKey: '', discordConfig: null });
  const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); app.locals.db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db: app.locals.db, request: (route, options) => fetch(base + route, options) };
}
function source(db, names = [unknown, prefixed, '다른 미연결 구성']) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['상품명', '정리된 제품명', '주문번호', '수량'], ...names.map((name, index) => ['가상 원본 ' + index, name, 'sku-order-' + index, 1]),
  ]), '주문');
  return importFiles(db, [{ originalname: '가상 관리 주문.xlsx', buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) }]);
}
const sourceState = db => JSON.stringify(Object.fromEntries(['rows', 'sheets', 'source_files', 'row_revisions'].map(table => [table,
  db.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map(row => {
    if (table === 'rows') delete row.sku_barcode;
    return row;
  }),
])));

test('새 상품 등록과 미연결 이름 연결은 업무 화면·출고보드에 반영하고 원본·수량을 보존한다', async t => {
  const { db, request } = await boot(t), initial = source(db), before = sourceState(db);
  let response = await request('/api/products'); assert.equal(response.status, 200);
  let catalog = await response.json();
  assert.equal(catalog.products.length, 34);
  assert.ok(catalog.unmatched.some(row => row.name === unknown));
  response = await request('/api/products', json({ barcode: newBarcode, name: '새 가상 상품' }));
  assert.equal(response.status, 201); assert.equal((await response.json()).product.barcode, newBarcode);
  assert.equal(batchDetail(db, initial.batch.id).rows[0].skuBarcode, null, '상품 등록만으로 비슷한 이름을 연결하지 않는다.');
  response = await request('/api/products/aliases', json({ name: unknown, barcode: newBarcode }));
  assert.equal(response.status, 200); assert.equal((await response.json()).linkedRows, 2);
  assert.deepEqual(batchDetail(db, initial.batch.id).rows.map(row => row.skuBarcode), [newBarcode, newBarcode, null]);
  assert.equal(sourceState(db), before);
  catalog = await (await request('/api/products')).json();
  assert.equal(catalog.products.find(row => row.barcode === newBarcode).aliasCount, 1);
  assert.deepEqual(catalog.unmatched.map(row => row.name), ['다른 미연결 구성']);
  const stamp = db.prepare('SELECT created_at FROM batches WHERE id=?').get(initial.batch.id).created_at;
  const date = new Date(new Date(stamp).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const group = shippingBoard(db, date).groups.find(row => row.skuBarcode === newBarcode);
  assert.equal(group.count, 2);
  const next = source(db, [prefixed]); assert.equal(next.rows[0].skuBarcode, newBarcode, '이후 업로드도 같은 연결을 사용한다.');
  const edited = reviseRows(db, next.batch.id, [{ id: next.rows[0].id, cleanedName: '새로운 미연결 구성', status: 'confirmed', reviewNote: '' }]);
  assert.equal(edited.rows[0].skuBarcode, null);
});

test('형식 오류·중복 바코드·없는 상품과 다른 SKU 재연결을 거부하고 같은 연결 재시도는 무해하다', async t => {
  const { db, request } = await boot(t); source(db);
  const before = db.prepare('SELECT count(*) n FROM sku_products').get().n;
  for (const body of [{ barcode: newBarcode, name: '' }, { barcode: 8809538930993, name: '숫자 입력' },
    { barcode: '8809538930994', name: '체크숫자 오류' }, { barcode: knownBarcode, name: '기존 코드 중복' }]) {
    assert.equal((await request('/api/products', json(body))).status, 400);
  }
  assert.equal(db.prepare('SELECT count(*) n FROM sku_products').get().n, before);
  for (const body of [{ name: unknown, barcode: newBarcode }, { name: unknown, barcode: '8809538930108' },
    { name: '등록된 주문에 없는 임의 이름', barcode: knownBarcode }]) {
    assert.equal((await request('/api/products/aliases', json(body))).status, 400);
  }
  assert.equal((await request('/api/products/aliases', json({ name: unknown, barcode: knownBarcode }))).status, 200);
  const repeated = await request('/api/products/aliases', json({ name: prefixed, barcode: knownBarcode }));
  assert.equal(repeated.status, 200); assert.equal((await repeated.json()).linkedRows, 0);
  const snapshot = sourceState(db);
  assert.equal((await request('/api/products/aliases', json({ name: prefixed, barcode: secondBarcode }))).status, 400);
  assert.equal(sourceState(db), snapshot);
  assert.deepEqual(db.prepare('SELECT sku_barcode FROM rows ORDER BY id').all().map(row => row.sku_barcode), [knownBarcode, knownBarcode, '']);
});

test('관리한 상품과 연결은 백업 복구·재시작 후에도 남고 신규 주문 미리보기도 DB 연결을 읽는다', async t => {
  const { db, request } = await boot(t), initial = source(db, [unknown]);
  await request('/api/products', json({ barcode: newBarcode, name: '보존할 가상 상품' }));
  assert.equal((await request('/api/products/aliases', json({ name: unknown, barcode: newBarcode }))).status, 200);
  const backup = await request('/api/backup', { method: 'POST' }); assert.equal(backup.status, 200);
  const directory = mkdtempSync(path.join(os.tmpdir(), 'system0-products-')), filename = path.join(directory, 'backup.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(filename, Buffer.from(await backup.arrayBuffer()));
  const before = sourceState(db); let restored = openDatabase(filename);
  assert.equal(sourceState(restored), before); assert.equal(batchDetail(restored, initial.batch.id).rows[0].skuBarcode, newBarcode);
  assert.equal(restored.prepare('SELECT name FROM sku_products WHERE barcode=?').get(newBarcode).name, '보존할 가상 상품');
  const preview = await normalizePreviewNames(restored, [{ id: 1, originalName: '미리보기 가상 원본', productName: unknown, optionName: '' }],
    { responses: { create: async () => ({ output_text: JSON.stringify({ items: [{ id: 1, cleanedName: unknown, needsAttention: false, note: '' }] }) }) } }, 'mock');
  assert.equal(preview[0].skuBarcode, newBarcode); restored.close();
  restored = openDatabase(filename);
  assert.equal(restored.prepare('SELECT count(*) n FROM sku_products WHERE barcode=?').get(newBarcode).n, 1);
  assert.equal(batchDetail(restored, initial.batch.id).rows[0].skuBarcode, newBarcode);
  assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); restored.close();
});
