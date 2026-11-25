import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as XLSX from 'xlsx';
import { openDatabase } from '../lib/database.mjs';
import { importFiles } from '../lib/excel.mjs';
import { CARRIERS, importInvoiceFiles, exportInvoices, downloadInvoices, invoiceView, refreshInvoiceStatus,
  reviseInvoiceItems, listInvoiceDrafts, listInvoiceRuns } from '../lib/invoices.mjs';
import { createInvoiceExportFile, downloadInvoiceExportFile, listInvoiceExportFiles } from '../lib/invoice-export-files.mjs';
import { courierFile, naverFile, registeredOrder, sourceFile } from './fixtures/weekend-invoices.mjs';

function fixture(t, { saveOriginal = true } = {}) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const orders = Array.from({ length: 5 }, (_, index) => ({
    productOrderId: `202611250000000${index}`, orderId: `202611250000010${index}`,
    internalId: `2026112512000000${index}`, trackingNumber: `4991234567${index}`,
    productName: `모의 상품 ${index}`, recipient: `모의 수취인 ${index}`, quantity: 1,
    phone: `010-0000-111${index}`, address: `서울 모의구 테스트로 ${index} 101호`,
  }));
  const source = sourceFile(orders);
  const { batch, rows } = importFiles(db, [{ ...source, originalname: source.name }]);
  for (const row of rows) db.prepare("UPDATE rows SET cleaned_name = ?, status = 'confirmed' WHERE id = ?").run(row.productName, row.id);
  const { run } = importInvoiceFiles(db, { naverFiles: [naverFile(orders)], courierFiles: [courierFile(orders)],
    carrier: CARRIERS[0], batchIds: [batch.id] });
  const id = run.id;
  const original = saveOriginal ? exportInvoices(db, id).buffer : null;
  const hold = invoiceView(db, id).items.find(item => item.productOrderId === orders[4].productOrderId);
  reviseInvoiceItems(db, id, { changes: [{ id: hold.id, decision: 'hold', note: '담당자 확인 필요' }] });
  return { db, id, orders, original };
}

function workbookOrders(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  return XLSX.utils.sheet_to_json(workbook.Sheets.발송처리, { header: 1, raw: true }).slice(1).map(row => [row[0], row[3]]);
}

test('추가 엑셀은 요청한 미등록 상품만 보관하고 전체본과 기존 엑셀을 각각 다시 받는다', async t => {
  const { db, id, orders, original } = fixture(t);
  const remote = orders.map((order, index) => registeredOrder(order, index === 1 ? {} : index === 2
    ? { trackingNumber: '49999999999' } : { status: 'PAYED', trackingNumber: '', deliveryCompanyCode: '', deliveryStatus: '' }));
  await refreshInvoiceStatus(db, id, { queryProductOrders: async () => remote });
  const before = invoiceView(db, id);
  const tables = ['invoice_runs', 'invoice_items', 'invoice_files', 'invoice_revisions', 'invoice_checks'];
  const snapshot = () => tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
  const saved = snapshot();
  const missingId = '9999999999999999';
  const request = { expectedVersion: before.viewVersion, mode: 'pending', productOrderIds: [
    orders[0].productOrderId, orders[1].productOrderId, orders[2].productOrderId, missingId,
  ] };
  const preview = createInvoiceExportFile(db, id, { ...request, validateOnly: true });
  assert.equal(preview.file, null);
  assert.deepEqual(listInvoiceExportFiles(db, id), []);
  assert.deepEqual(preview.included, [{ productOrderId: orders[0].productOrderId, trackingNumber: orders[0].trackingNumber }]);
  assert.deepEqual(preview.skipped.map(row => [row.productOrderId, row.code]), [
    [orders[1].productOrderId, 'registered'], [orders[2].productOrderId, 'registration_conflict'], [missingId, 'not_found'],
  ]);

  const added = createInvoiceExportFile(db, id, request);
  const retry = createInvoiceExportFile(db, id, request);
  assert.deepEqual(retry.file, added.file);
  assert.equal(added.viewVersion, before.viewVersion);
  const additional = downloadInvoiceExportFile(db, id, added.file.id).buffer;
  assert.deepEqual(workbookOrders(additional), [[orders[0].productOrderId, orders[0].trackingNumber]]);
  assert.equal(createHash('sha256').update(additional).digest('hex'), added.file.sha256);

  const full = createInvoiceExportFile(db, id, { expectedVersion: before.viewVersion, mode: 'all', productOrderIds: null });
  assert.deepEqual(full.skipped.map(row => [row.productOrderId, row.code]), [
    [orders[2].productOrderId, 'registration_conflict'], [orders[4].productOrderId, 'hold'],
  ]);
  const fullBytes = downloadInvoiceExportFile(db, id, full.file.id).buffer;
  assert.deepEqual(workbookOrders(fullBytes), [0, 1, 3].map(i => [orders[i].productOrderId, orders[i].trackingNumber]));
  assert.deepEqual(listInvoiceExportFiles(db, id), [full.file, added.file]);
  assert.throws(() => downloadInvoiceExportFile(db, id + 1, added.file.id), { code: 'invoice_export_not_found' });
  assert.deepEqual(downloadInvoices(db, id).buffer, original);
  assert.deepEqual(snapshot(), saved);
  assert.equal(invoiceView(db, id).viewVersion, before.viewVersion);
});

test('추가 파일은 오래된 버전과 미조회 상품을 차단하고 상태 조회 뒤 다시 만들 수 있다', async t => {
  const { db, id, orders } = fixture(t);
  const request = { expectedVersion: invoiceView(db, id).viewVersion, mode: 'pending', productOrderIds: [orders[0].productOrderId] };
  const unknown = createInvoiceExportFile(db, id, request);
  assert.equal(unknown.file, null);
  assert.equal(unknown.skipped[0].code, 'registration_unchecked');
  await refreshInvoiceStatus(db, id, { queryProductOrders: async () => orders.map(order => registeredOrder(order,
    { status: 'PAYED', trackingNumber: '', deliveryCompanyCode: '', deliveryStatus: '' })) });
  assert.throws(() => createInvoiceExportFile(db, id, request), { code: 'stale_invoice_version' });
  assert.throws(() => createInvoiceExportFile(db, id, { ...request, productOrderIds: Array(2).fill(orders[0].productOrderId) }), /중복 없는/);
  assert.deepEqual(listInvoiceExportFiles(db, id), []);
  const file = createInvoiceExportFile(db, id, { ...request, expectedVersion: invoiceView(db, id).viewVersion }).file;
  assert.deepEqual(file.productOrderIds, [orders[0].productOrderId]);
});

test('독립 엑셀만 생성한 작업도 날짜 이력에서 열고 보관 원본 상태를 변경하지 않는다', t => {
  const { db, id } = fixture(t, { saveOriginal: false });
  const before = invoiceView(db, id);
  assert.deepEqual(listInvoiceRuns(db, before.run.sourceDate), []);
  assert.equal(listInvoiceDrafts(db, before.run.sourceDate)[0].id, id);
  const { file } = createInvoiceExportFile(db, id, { expectedVersion: before.viewVersion, mode: 'all', productOrderIds: null });
  const [created] = listInvoiceRuns(db, before.run.sourceDate);
  assert.equal(created.id, id);
  assert.equal(created.fileCreatedAt, file.createdAt);
  assert.equal(created.generatedAt, null);
  assert.equal(created.savedFileAvailable, false);
  assert.deepEqual(listInvoiceDrafts(db, before.run.sourceDate), []);
  assert.deepEqual(invoiceView(db, id), before);
});
